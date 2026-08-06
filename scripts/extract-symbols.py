"""
Поиск условных знаков на чертежах и привязка листа к местности.

Часть объектов проекта подписана пикетажем — их ставит `extract-features.py`,
и стоят они точно. Но мосты, скотопрогоны, проезды сельхозтехники, АЗС, ДЭУ
и ДЭП пикетажа в тексте не имеют: они на чертеже только нарисованы. Взять их
можно единственным способом — найти значок на листе и пересчитать положение
листа в координаты.

Как ищется значок. Знаки залиты чистыми цветами, которых на топографической
основе не бывает: ярко-зелёный, ярко-жёлтый, охристый. Берём растр листа,
собираем пятна нужного цвета, отбрасываем всё, что не похоже на знак
по размеру и форме, а потом сверяем каждое пятно с образцами из блока
«Условные обозначения» того же листа. Скотопрогон и проезд сельхозтехники
одного цвета и различаются только рисунком внутри — их разводит именно
сверка с образцом.

Как привязывается лист. Контрольные точки — подписи «КМ n+mmm»: их положение
на листе известно отсюда, а на местности — из оси, построенной по ведомости.
Само преобразование считает `build-features.mjs`, здесь только собираются пары.

Требуется: pip install pymupdf pillow numpy scipy
Запуск:    python scripts/extract-symbols.py
Результат: scripts/symbols-sheet.json (читается build-features.mjs)
"""

import json
import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import pymupdf
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SHEETS = sorted(ROOT.glob("Сокр.план КС-2 с ВУ лист*.pdf"))
OUT = Path(__file__).resolve().parent / "symbols-sheet.json"

ZOOM = 2.0  # растр листа: 1 пиксель ≈ 35 м, знак ≈ 56 пикселей
MAX_STATION = 462_600

# Образцы из блока «Условные обозначения» на листе 1, в координатах страницы.
TEMPLATES = {
    "crossing": (126, 1428, 160, 1460),
    "rest": (126, 1466, 160, 1500),
    "service": (139, 1548, 178, 1583),
}

# Классы пятен: цветовой фильтр и какие образцы могут им соответствовать.
CLASSES = {
    "green": (lambda r, g, b: (r < 110) & (g > 200) & (b < 110), ["rest"]),
    "yellow": (lambda r, g, b: (r > 210) & (g > 210) & (b < 110), ["service"]),
    # Скотопрогон и проезд сельхозтехники — один и тот же кружок, отличаются
    # только рисунком внутри. Сверка с образцом их не разводит: корреляции
    # перекрываются (0.46 против 0.41). Считаем одним типом, чтобы не выдумывать,
    # где корова, а где трактор.
    "brown": (
        lambda r, g, b: (150 < r) & (r < 240) & (100 < g) & (g < 200) & (80 < b) & (b < 190),
        ["crossing"],
    ),
}

# Габарит и пропорции знака в пикселях растра — все три знака почти круглые.
#
# Мостов здесь нет намеренно: на самом плане их значок вырождается в синий
# квадрат 36x36, неотличимый от других синих меток вдоль трассы. Отличить
# по образцу из легенды не выходит — она нарисована втрое крупнее и в других
# пропорциях. Ставить мост наугад хуже, чем не ставить.
SHAPE = {"default": {"w": (24, 95), "h": (24, 95), "aspect": (0.7, 1.4)}}
FILL_MIN = 0.35  # доля закрашенного в габарите: отсекает обрывки линий

CHAINAGE = re.compile(r"^\d{1,4}\+\d{2,3}$")


def raster(page: pymupdf.Page, zoom: float) -> np.ndarray:
    pm = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB)
    return np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, 3).astype(np.int16)


def load_templates(page: pymupdf.Page) -> dict[str, np.ndarray]:
    """Образцы берём крупно и приводим к серому: сравнивается рисунок, не оттенок."""
    out = {}
    for name, box in TEMPLATES.items():
        pm = page.get_pixmap(matrix=pymupdf.Matrix(8, 8), clip=pymupdf.Rect(*box), colorspace=pymupdf.csRGB)
        img = np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, 3).astype(np.float32)
        out[name] = img.mean(axis=2)
    return out


def resize(img: np.ndarray, side: int) -> np.ndarray:
    """Ближайший сосед: сравниваем грубую форму, интерполяция тут ничего не даст."""
    ys = (np.arange(side) * img.shape[0] / side).astype(int)
    xs = (np.arange(side) * img.shape[1] / side).astype(int)
    return img[np.ix_(ys, xs)]


def correlation(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    denom = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / denom) if denom else 0.0


def find_blobs(grey: np.ndarray, mask: np.ndarray, kinds: list[str], templates: dict[str, np.ndarray]):
    # Кружки скотопрогонов и проездов — кольца со светлой серединой: без
    # заливки дырок они не проходят по доле закрашенного.
    labels, count = ndimage.label(ndimage.binary_fill_holes(mask))
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        h = box[0].stop - box[0].start
        w = box[1].stop - box[1].start
        area = int((labels[box] == index).sum())
        if area < FILL_MIN * w * h:
            continue

        patch = grey[box]
        side = 48
        sample = resize(patch, side)
        best, score = None, -1.0
        for kind in kinds:
            shape = SHAPE.get(kind, SHAPE["default"])
            if not (shape["w"][0] <= w <= shape["w"][1] and shape["h"][0] <= h <= shape["h"][1]):
                continue
            if not (shape["aspect"][0] <= w / h <= shape["aspect"][1]):
                continue
            value = correlation(sample, resize(templates[kind], side))
            if value > score:
                best, score = kind, value
        if best is None or score < 0.25:
            continue
        yield best, box[1].start + w / 2, box[0].start + h / 2, round(score, 3)
    del count


def control_points(page: pymupdf.Page) -> list[dict]:
    """Подписи «КМ n+mmm» — общие точки листа и оси."""
    words = page.get_text("words")
    centre = lambda w: ((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)
    out = []
    for word in words:
        if word[4] != "КМ":
            continue
        cx, cy = centre(word)
        near = sorted(
            (math.hypot(*(a - b for a, b in zip(centre(other), (cx, cy)))), other[4])
            for other in words
            if other is not word
        )
        token = next((s for d, s in near if d < 2.0 and CHAINAGE.match(s)), None)
        if not token:
            continue
        km, metres = token.split("+")
        station = int(km) * 1000 + int(metres)
        if station <= MAX_STATION:
            out.append({"x": round(cx, 2), "y": round(cy, 2), "station": station})
    return out


def main() -> None:
    if not SHEETS:
        raise SystemExit("Не найдены файлы «Сокр.план КС-2 с ВУ лист*.pdf» в корне проекта")

    templates = load_templates(pymupdf.open(SHEETS[0])[0])
    sheets = []
    totals: dict[str, int] = defaultdict(int)

    for path in SHEETS:
        page = pymupdf.open(path)[0]
        img = raster(page, ZOOM)
        grey = img.mean(axis=2).astype(np.float32)
        r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]

        # Растр рисуется в повёрнутой системе страницы, а текстовый слой отдаёт
        # координаты в неповёрнутой. У листов 1 и 2 поворот 270°, и без приведения
        # к одной системе значки уезжали от контрольных точек на десятки километров.
        derotate = page.derotation_matrix

        symbols = []
        for test, kinds in CLASSES.values():
            for kind, px, py, score in find_blobs(grey, test(r, g, b), kinds, templates):
                pt = pymupdf.Point(px / ZOOM, py / ZOOM) * derotate
                symbols.append({"kind": kind, "x": round(pt.x, 2), "y": round(pt.y, 2), "score": score})
                totals[kind] += 1

        sheets.append({"sheet": path.name, "control": control_points(page), "symbols": symbols})
        print(f"{path.name}: знаков {len(symbols)}, контрольных точек {len(sheets[-1]['control'])}")

    OUT.write_text(
        json.dumps(
            {
                "source": "Сокр.план КС-2 с ВУ, растр листов + блок «Условные обозначения»",
                "segment": "kyzylorda-saksaulsk",
                "note": "x, y — координаты страницы PDF; привязка к местности в build-features.mjs",
                "sheets": sheets,
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nЗаписано: {OUT}")
    for kind, n in sorted(totals.items()):
        print(f"  {kind:10s} {n}")


if __name__ == "__main__":
    main()
