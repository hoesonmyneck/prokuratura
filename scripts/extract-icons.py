"""
Вырезание условных знаков из легенды чертежа в иконки карты.

Значки на карте должны быть теми же, что на чертеже, — иначе читающий план
и читающий карту видят разное. Рисовать их заново нельзя: это будут похожие,
но другие знаки. Поэтому режем прямо из PDF, из блока «Условные обозначения»
на листе 1.

Белый фон блока делается прозрачным, картинка обрезается по знаку и кладётся
в квадрат — MapLibre ставит иконки по центру, и лишние поля сместили бы знак
относительно точки на трассе.

Знаки есть не для всех наших объектов: в легенде нет ни перехода земляного
полотна, ни границы очереди. Для них на карте остаются нейтральные кружки —
придумывать условный знак, которого нет в проекте, хуже, чем показать точку.

Требуется: pip install pymupdf pillow
Запуск:    python scripts/extract-icons.py
Результат: src/assets/icon-*.png
"""

from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "Сокр.план КС-2 с ВУ лист1.pdf"
OUT_DIR = ROOT / "src" / "assets"

# Границы знаков в блоке легенды, в координатах отрисованной страницы.
CROPS = {
    "interchange": (124, 1313, 165, 1353),
    "crossing": (126, 1428, 160, 1460),
    "rest": (126, 1466, 160, 1500),
    "service": (139, 1548, 178, 1583),
}

ZOOM = 14  # с запасом: дальше уменьшаем с сглаживанием
SIZE = 96  # сторона готовой иконки, px
WHITE = 232  # всё светлее — фон


def to_icon(pixmap: pymupdf.Pixmap) -> Image.Image:
    img = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples).convert("RGBA")

    # Фон в прозрачность. Знаки цветные и контрастные, поэтому порога по
    # светлоте достаточно: попасть под него может только белое поле легенды.
    px = img.load()
    assert px is not None
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, _ = px[x, y]
            if r > WHITE and g > WHITE and b > WHITE:
                px[x, y] = (r, g, b, 0)

    img = img.crop(img.getbbox() or img.getbbox())

    # В квадрат, знак по центру.
    side = max(img.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return square.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    if not SHEET.exists():
        raise SystemExit(f"Не найден {SHEET.name} в корне проекта")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    page = pymupdf.open(SHEET)[0]

    for name, box in CROPS.items():
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(ZOOM, ZOOM),
            clip=pymupdf.Rect(*box),
            colorspace=pymupdf.csRGB,
        )
        icon = to_icon(pixmap)
        path = OUT_DIR / f"icon-{name}.png"
        icon.save(path, optimize=True)
        print(f"{path.relative_to(ROOT)}  {icon.width}x{icon.height}  {path.stat().st_size / 1024:.1f} КБ")


if __name__ == "__main__":
    main()
