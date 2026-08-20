"""
Разбор списка действующих недропользователей в GeoJSON.

Исходник — `kontrakt_mestorohdeniya.xls`, «Список действующих
недропользователей», лист «действующие». Как и у карьеров, одна строка —
одна угловая точка контура, координаты в градусах, минутах и секундах.

Отличия от `carrier.xlsx`, из-за которых разборщик отдельный:
  • формат старый (.xls, OLE2), нужен xlrd, openpyxl его не читает;
  • сначала идёт ШИРОТА, потом долгота — у карьеров наоборот;
  • в шапке прямо указано «система координат WGS84», гадать не надо;
  • секунды записаны с запятой в качестве разделителя.

Общая геометрия — разрез на площадки и правка опечаток в разрядах — живёт
в `lib/deposits.py`, чтобы не разъехаться с разбором карьеров.

Требуется: pip install xlrd
Запуск:    python scripts/extract-contracts.py
Результат: src/data/contracts.json
"""

import json
import re
import sys
from pathlib import Path

import xlrd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.deposits import build_rings, dms, ring_area_ha  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "kontrakt_mestorohdeniya.xls"
OUT = ROOT / "src" / "data" / "contracts.json"

FIRST_ROW = 4  # нумерация с нуля: строки 1-4 — заголовок
COL = {
    "num": 0, "district": 1, "user": 2, "name": 3, "kind": 4, "licence": 5,
    "operation": 6, "unit": 7, "point": 8,
    "lat": (9, 10, 11), "lon": (12, 13, 14),
    "contacts": 15, "bin": 16, "volumeOre": 17, "volumeCubic": 18,
}

# Вид ОПИ записан вразнобой — регистр, единственное и множественное число,
# сокращение и расшифровка. Сводим к одному написанию для группировки,
# исходное значение остаётся в свойствах объекта.
KIND_ALIASES = {
    "суглинки": "суглинок",
    "суглинок": "суглинок",
    "супеси": "супесь",
    "супесь": "супесь",
    "пгс": "ПГС",
    "песчано-гравийная смесь": "ПГС",
    "песчано-гравийные смеси": "ПГС",
    "строительные пески": "строительный песок",
    "строительный песок": "строительный песок",
    "кварцевые пески": "кварцевый песок",
    "поваренная соль": "поваренная соль",
    "известняк": "известняк",
    "известняки": "известняк",
    "глины": "глина",
    "глина": "глина",
}


def normal_kind(value):
    if not value:
        return None
    key = value.strip().lower().replace("ё", "е")
    return KIND_ALIASES.get(key, key)


# Вид операций в ведомости кодируется буквой.
OPERATIONS = {"Р": "разведка", "Д": "добыча", "РД": "разведка и добыча"}


def number(value):
    if value in ("", None):
        return None
    try:
        return float(str(value).strip().replace(",", "."))
    except ValueError:
        return None


def clean(value):
    if value in ("", None):
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def district_name(value):
    """
    Район записан вразнобой: «Аральский район», «в Аральском районе»,
    «в Кармакшинском райное». Приводим к именительному падежу для группировки,
    исходное не трогаем.
    """
    if not value:
        return None
    text = value.strip().lower().replace("ё", "е")
    text = re.sub(r"^в\s+", "", text)
    text = re.sub(r"\s*(район[а-я]*|райно[а-я]*|райое|р-н)\s*$", "", text).strip()
    text = re.sub(r"^г\.?\s+|^город\s+", "", text)
    if not text:
        return None
    # «аральском» → «аральский», «жанакоргоанском» → «жанакорганский»
    text = re.sub(r"(ом|ем)$", "ий", text)
    text = text.replace("жанакоргоанский", "жанакорганский")
    text = text.replace("шелииский", "шиелийский").replace("шиелииский", "шиелийский")
    name = text[0].upper() + text[1:]
    return name if "кызылорда" in text else f"{name} район"


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Не найден {SRC.name} в корне проекта")

    sheet = xlrd.open_workbook(SRC).sheet_by_index(0)
    groups = []
    current = None

    for index in range(FIRST_ROW, sheet.nrows):
        row = [sheet.cell_value(index, j) for j in range(sheet.ncols)]
        cell = lambda key: clean(row[COL[key]])  # noqa: E731
        parts = [number(row[j]) for j in (*COL["lat"], *COL["lon"])]
        has_point = all(p is not None for p in parts)

        if cell("num"):
            current = {
                "row": index + 1,
                "num": cell("num").removesuffix(".0"),
                "district": cell("district"),
                "districtNorm": district_name(cell("district")),
                "user": cell("user"),
                "name": cell("name"),
                "kind": cell("kind"),
                "licence": cell("licence"),
                "operation": cell("operation"),
                "unit": cell("unit"),
                "contacts": cell("contacts"),
                "bin": (cell("bin") or "").removesuffix(".0") or None,
                "volumeOre": cell("volume_ore") if "volume_ore" in COL else clean(row[COL["volumeOre"]]),
                "volumeCubic": clean(row[COL["volumeCubic"]]),
                "points": [],
            }
            groups.append(current)

        if has_point and current is not None:
            current["points"].append({
                "row": index + 1,
                "order": len(current["points"]),
                "seq": number(row[COL["point"]]),
                "raw": parts,
                # В этой ведомости широта идёт первой, а GeoJSON ждёт [долгота, широта].
                "build": lambda raw: (dms(*raw[3:]), dms(*raw[:3])),
                "xy": (dms(*parts[3:]), dms(*parts[:3])),
            })

    features = []
    repaired, discarded, review = [], [], []
    empty = []
    log = print

    for g in groups:
        if not g["points"]:
            empty.append(f"№{g['num']} «{(g['name'] or '')[:44]}»")
            continue
        rings = build_rings(
            g["points"], f"№{g['num']}", ("широты", "долготы"), review, repaired, discarded, log
        )
        if not rings:
            continue
        area = round(sum(ring_area_ha(r[0][:-1]) for r in rings), 1)
        features.append({
            "type": "Feature",
            "id": g["num"],
            "properties": {
                "num": g["num"],
                "name": g["name"],
                "user": g["user"],
                "district": g["district"],
                "districtNorm": g["districtNorm"],
                "kind": g["kind"],
                "kindNorm": normal_kind(g["kind"]),
                "licence": g["licence"],
                "operation": OPERATIONS.get((g["operation"] or "").upper(), g["operation"]),
                "bin": g["bin"],
                "contacts": g["contacts"],
                "areaHa": area,
                "plots": len(rings),
            },
            "geometry": {"type": "MultiPolygon", "coordinates": rings},
        })

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"\nУчастков: {len(features)}, площадок: {sum(f['properties']['plots'] for f in features)}")
    print(f"Исправлено опечаток: {len(repaired)}; отброшено вершин: {len(discarded)}")
    if empty:
        print(f"Без координат, пропущены ({len(empty)}): {', '.join(empty)}")
    if review:
        print("Шаги вблизи порога разреза — стоит проверить глазами:")
        for line in review:
            print(line)
    total = sum(f["properties"]["areaHa"] for f in features)
    print(f"Суммарная площадь: {total:,.0f} га".replace(",", " "))
    kinds = {}
    for f in features:
        k = f["properties"]["kindNorm"] or "не указан"
        kinds[k] = kinds.get(k, 0) + 1
    print("По виду ОПИ:")
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"  {k:<26} {n}")


if __name__ == "__main__":
    main()
