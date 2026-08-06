"""
Извлечение обозначений с пикетажем из чертежей «Сокр.план КС-2 с ВУ».

Ведомость углов поворота в этих PDF лежит картинкой, а вот сам чертёж —
векторный, с живым текстовым слоем. В нём подписаны площадки отдыха,
транспортные развязки, переходы ЛЭП и границы очередей, и у каждой подписи
есть пикетаж вида «КМ 30+058». Этого достаточно, чтобы поставить обозначение
на карту точно: пикетаж откладывается вдоль оси, построенной по ведомости,
и привязка чертежа к местности не нужна вовсе.

Якорь разбора — слово «КМ». Оно стоит только у подписей объектов; точки
кривых (НКК, ККК, НПК, КПК) подписаны пикетами без него, и в выборку
не попадают. Тип определяется по словам рядом.

Листы перекрываются, поэтому одно и то же обозначение встречается дважды —
дедупликация по паре (тип, пикетаж).

Требуется: pip install pymupdf
Запуск:    python scripts/extract-features.py
Результат: scripts/features-chainage.json (читается build-features.mjs)
"""

import json
import math
import re
from collections import defaultdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
SHEETS = sorted(ROOT.glob("Сокр.план КС-2 с ВУ лист*.pdf"))
OUT = Path(__file__).resolve().parent / "features-chainage.json"

# Длина плеча, м. Всё, что больше, — это пикетаж существующей дороги
# (на чертеже встречаются отметки вроде «км 1646»), а не километраж проекта.
MAX_STATION = 462_600

CHAINAGE = re.compile(r"\d{1,4}\+\d{2,3}")
CYRILLIC = re.compile(r"[А-Яа-я]")


# Ключевое слово → тип объекта. Порядок роли не играет: побеждает то слово,
# что ближе к подписи с пикетажем (см. `classify`).
KEYWORDS = {
    "площадки": "rest",
    "развязки": "interchange",
    "полотно": "roadbed",
    "Очередь": "stage",
    "листу": None,  # стык листов, не объект
    "Лист": None,
}


def classify(near: list[tuple[float, str]]) -> str | None:
    """
    Тип объекта по ближайшему ключевому слову.

    Сначала здесь стоял разбор по набору слов вокруг, и это давало неверный
    ответ: подписи на чертеже наложены плотно, и слово от соседнего объекта
    попадало в набор. Так «переход земляного полотна» разъезжался с «ВЛ»,
    а границы транспортной развязки записывались в переходы ЛЭП.

    ВЛ в списке нет намеренно. Названия линий («АО КЕГОК ВЛ 220 кВ») на чертеже
    подписаны, но собственного пикетажа у пересечения нет — рядом всегда стоит
    отметка другого объекта. Ставить их «по соседской» отметке значило бы
    показывать выдуманное положение.
    """
    for _, word in near:
        for key, kind in KEYWORDS.items():
            if word == key or word.startswith(key):
                return kind
    return None


def centre(word) -> tuple[float, float]:
    return (word[0] + word[2]) / 2, (word[1] + word[3]) / 2


def main() -> None:
    if not SHEETS:
        raise SystemExit("Не найдены файлы «Сокр.план КС-2 с ВУ лист*.pdf» в корне проекта")

    found: dict[tuple[str, int], set[str]] = defaultdict(set)

    for sheet in SHEETS:
        page = pymupdf.open(sheet)[0]
        words = page.get_text("words")

        for word in words:
            if word[4] != "КМ":
                continue
            cx, cy = centre(word)
            near = sorted(
                (math.hypot(*(a - b for a, b in zip(centre(other), (cx, cy)))), other[4])
                for other in words
                if other is not word
            )

            # Пикетаж — вплотную к «КМ»; дальше уже чужие подписи.
            chainage = next((s for d, s in near if d < 2.0 and CHAINAGE.fullmatch(s)), None)
            if chainage is None:
                continue

            km, metres = chainage.split("+")
            station = int(km) * 1000 + int(metres)
            if station > MAX_STATION:
                continue

            kind = classify([(d, s) for d, s in near if d < 3 and CYRILLIC.search(s)])
            if kind:
                found[(kind, station)].add(sheet.name)

        print(f"{sheet.name}: обработан")

    records = sorted(
        ({"kind": kind, "station": station, "sheets": sorted(src)} for (kind, station), src in found.items()),
        key=lambda r: (r["kind"], r["station"]),
    )

    OUT.write_text(
        json.dumps(
            {
                "source": "Сокр.план КС-2 с ВУ, листы 1-3, текстовый слой чертежа",
                "segment": "kyzylorda-saksaulsk",
                "note": "station — расстояние от начала трассы, м (из подписи «КМ км+м»)",
                "features": records,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    by_kind: dict[str, int] = defaultdict(int)
    for r in records:
        by_kind[r["kind"]] += 1
    print(f"\nЗаписано: {OUT} — {len(records)} обозначений")
    for kind, n in sorted(by_kind.items()):
        print(f"  {kind:12s} {n}")


if __name__ == "__main__":
    main()
