"""
Разбор ведомости резервных месторождений в GeoJSON.

Исходник — `carrier.xlsx`, «Сведения по резервным месторождениям
Кызылординской области». Каждое месторождение занимает несколько строк:
одна строка — одна угловая точка контура, координаты в градусах, минутах
и секундах, разложенные по отдельным столбцам.

Столбцы 11-15 (запасы, протокол, единица измерения) объединены по вертикали
на всю группу, поэтому значение стоит только в первой строке — переносим его
на всё месторождение.

Одна запись может содержать НЕСКОЛЬКО площадок. Иногда это видно по нумерации
(у №20 вершины идут «1 2 3 4 1 2 3 4»), но не всегда: у №21 номера сквозные,
с 1 по 14, а площадок три — они разнесены на 6 и 14 км. Поэтому вершины
разбиваются по расстоянию, а не по номерам.

В ведомости есть опечатки в координатах: у №14 у одной вершины широта 42°
вместо 45° (полигон уходил на 333 км в Узбекистан), у №8 минуты 54' вместо 34'.
Исправляются они только там, где это доказуемо: если подстановка ОДНОГО
разряда из соседних вершин той же площадки ставит точку на место, правка
применяется, иначе вершина отбрасывается. Каждая правка печатается.

Требуется: pip install openpyxl
Запуск:    python scripts/extract-quarries.py
Результат: src/data/quarries.json
"""

import json
import math
import re
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "carrier.xlsx"
OUT = ROOT / "src" / "data" / "quarries.json"

FIRST_ROW = 11
# Столбцы (нумерация с единицы): № | наименование | вид ПИ | № точки |
# долгота г/м/с | широта г/м/с | запасы А+В | А+В+С1 | С2 | протокол | единица
COL = {
    "num": 1, "name": 2, "kind": 3, "point": 4,
    "lon": (5, 6, 7), "lat": (8, 9, 10),
    "ab": 11, "abc1": 12, "c2": 13, "protocol": 14, "unit": 15,
}


# Вид полезного ископаемого записан вразнобой: «супеси» и «супесь», «пгс»
# и «ПГС». Сводим к одному написанию для группировки, исходное оставляем как есть.
KIND_ALIASES = {
    "супеси": "супесь",
    "супесь": "супесь",
    "суглинки": "суглинок",
    "суглинок": "суглинок",
    "пгс": "ПГС",
    "песчано-гравийная смесь": "ПГС",
}


def normal_kind(value):
    if not value:
        return None
    key = value.strip().lower()
    return KIND_ALIASES.get(key, value.strip().lower())


def number(value):
    if value is None:
        return None
    try:
        return float(str(value).strip().replace(",", "."))
    except ValueError:
        return None


def clean(value):
    """Пробелы и переносы внутри ячеек — обычное дело, схлопываем."""
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def dms(deg, minute, sec):
    return round(deg + minute / 60 + sec / 3600, 6)


# Дальше этого шага вершины считаются разными площадками, км.
#
# Порог не выдуман: в данных между этими величинами чистый разрыв. Внутри
# площадки самый большой шаг — 3.7 км (притрассовые карьеры вытянуты вдоль
# дороги узкой полосой: два угла на одном конце, два на другом). Между
# площадками самый маленький разрыв — 5.6 км. Всё, что попадёт в промежуток,
# печатается отдельно, чтобы решение можно было пересмотреть глазами.
PLOT_GAP_KM = 4.5
REVIEW_BAND = (2.0, 8.0)
# Насколько далеко вершина должна отстоять, чтобы считаться подозрительной, км.
OUTLIER_KM = 3.0
# Куда должна встать вершина после правки, чтобы правку принять, км.
REPAIR_KM = 1.0


def distance_km(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111.32 * math.cos(lat), (a[1] - b[1]) * 111.13)


def cluster(points, label, review):
    """
    Разбиение вершин на площадки по ходу перечисления.

    Режем именно последовательность, а не расстояния вообще: площадки в ведомости
    выписаны одна за другой, и длинная узкая полоса остаётся целой, хотя её концы
    далеко друг от друга. Дополнительный признак разрыва — сброс номера вершины
    (у №20 нумерация идёт «1 2 3 4 1 2 3 4»).
    """
    plots = []
    current = []
    for point in points:
        if current:
            step = distance_km(current[-1]["xy"], point["xy"])
            reset = (
                point["seq"] is not None
                and current[-1]["seq"] is not None
                and point["seq"] <= current[-1]["seq"]
            )
            if REVIEW_BAND[0] <= step <= REVIEW_BAND[1]:
                review.append(f"  ? {label}: шаг {step:.2f} км между вершинами — на грани порога")
            if step > PLOT_GAP_KM or reset:
                plots.append(current)
                current = []
        current.append(point)
    if current:
        plots.append(current)
    return plots


def repair(point, host):
    """
    Попытка исправить одну опечатку подстановкой разряда из соседних вершин.

    Разряды — градусы, минуты и секунды долготы и широты. Меняем ровно один
    на значение, которое встречается у вершин той же площадки, и проверяем,
    встала ли точка на место. Правка принимается, только если результат
    однозначен.
    """
    centre = (
        sum(q["xy"][0] for q in host) / len(host),
        sum(q["xy"][1] for q in host) / len(host),
    )
    best = None
    for slot in range(6):
        for candidate in {q["raw"][slot] for q in host}:
            if candidate == point["raw"][slot]:
                continue
            raw = list(point["raw"])
            raw[slot] = candidate
            xy = (dms(*raw[:3]), dms(*raw[3:]))
            gap = distance_km(xy, centre)
            if gap <= REPAIR_KM and (best is None or gap < best[0]):
                best = (gap, slot, candidate, raw, xy)
    return best


def ring_area_ha(ring):
    """Площадь кольца, га. Плоское приближение — участки маленькие."""
    lat = sum(p[1] for p in ring) / len(ring)
    kx = math.cos(math.radians(lat))
    total = 0.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        total += a[0] * kx * b[1] - b[0] * kx * a[1]
    return abs(total / 2) * 111.32 * 111.13 * 100


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"Не найден {SRC.name} в корне проекта")

    sheet = openpyxl.load_workbook(SRC, data_only=True).active
    groups = []
    current = None
    kind = None

    for row_index, row in enumerate(
        sheet.iter_rows(min_row=FIRST_ROW, max_row=sheet.max_row, values_only=True), start=FIRST_ROW
    ):
        cell = [row[i - 1] if i - 1 < len(row) else None for i in range(1, 16)]
        if clean(cell[COL["kind"] - 1]):
            # Вид ПИ объединён на всю группу — держим последний увиденный.
            kind = clean(cell[COL["kind"] - 1])

        parts = [number(cell[i - 1]) for i in (*COL["lon"], *COL["lat"])]
        has_point = all(p is not None for p in parts)
        label = clean(cell[COL["num"] - 1])
        name = clean(cell[COL["name"] - 1])

        if label and (name or has_point):
            current = {
                "num": label,
                "name": name,
                "kind": kind,
                "ab": clean(cell[COL["ab"] - 1]),
                "abc1": clean(cell[COL["abc1"] - 1]),
                "c2": clean(cell[COL["c2"] - 1]),
                "protocol": clean(cell[COL["protocol"] - 1]),
                "unit": clean(cell[COL["unit"] - 1]),
                "points": [],
            }
            groups.append(current)

        if has_point and current is not None:
            current["points"].append({
                "row": row_index,
                "order": len(current["points"]),
                "seq": number(cell[COL["point"] - 1]),
                "raw": parts,
                "xy": (dms(*parts[:3]), dms(*parts[3:])),
            })

    features = []
    split = 0
    repaired = []
    discarded = []
    review = []
    for index, g in enumerate(groups, start=1):
        plots = cluster(g["points"], f"№{g['num']}", review)

        # Одинокие вершины — кандидаты в опечатки. Пробуем починить об основную
        # площадку; не вышло — выбрасываем, «полигон» из одной точки не построить.
        main = max(plots, key=len)
        lonely = [pl for pl in plots if len(pl) < 3 and pl is not main]
        for pl in lonely:
            plots.remove(pl)
            for point in pl:
                fix = repair(point, main)
                if fix:
                    gap, slot, candidate, raw, xy = fix
                    field = ("долготы", "долготы", "долготы", "широты", "широты", "широты")[slot]
                    unit = ("градусы", "минуты", "секунды")[slot % 3]
                    print(
                        f"  правка R{point['row']} №{g['num']}: {unit} {field} "
                        f"{point['raw'][slot]:g} → {candidate:g}, вершина встала в {gap * 1000:.0f} м от площадки"
                    )
                    point["raw"] = raw
                    point["xy"] = xy
                    main.append(point)
                    repaired.append(point["row"])
                else:
                    print(
                        f"  ! R{point['row']} №{g['num']}: вершина в стороне от площадки, "
                        f"исправить однозначно нельзя — отброшена"
                    )
                    discarded.append(point["row"])
        main.sort(key=lambda q: q["order"])

        rings = [[list(q["xy"]) for q in pl] for pl in plots]
        if len(rings) > 1:
            split += 1

        polygons = []
        for r in rings:
            if len(r) < 3:
                print(f"  ! №{g['num']} «{g['name']}»: кольцо из {len(r)} точек, пропущено")
                continue
            closed = r + [r[0]] if r[0] != r[-1] else r
            polygons.append([closed])

        if not polygons:
            continue

        area = round(sum(ring_area_ha(p[0][:-1]) for p in polygons), 1)
        features.append({
            "type": "Feature",
            "id": index,
            "properties": {
                "num": g["num"],
                "name": g["name"],
                "kind": g["kind"],
                "kindNorm": normal_kind(g["kind"]),
                "reservesAB": g["ab"],
                "reservesABC1": g["abc1"],
                "reservesC2": g["c2"],
                "unit": g["unit"],
                "protocol": g["protocol"],
                "areaHa": area,
                "plots": len(polygons),
            },
            "geometry": {"type": "MultiPolygon", "coordinates": polygons},
        })

    OUT.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8",
    )

    kinds = {}
    for f in features:
        k = f["properties"]["kindNorm"] or "не указан"
        kinds[k] = kinds.get(k, 0) + 1
    total = sum(f["properties"]["areaHa"] for f in features)
    print(f"Месторождений: {len(features)}, площадок: {sum(f['properties']['plots'] for f in features)}")
    print(f"Записей с несколькими площадками: {split}")
    print(f"Исправлено опечаток в координатах: {len(repaired)}; отброшено вершин: {len(discarded)}")
    if review:
        print("Шаги вблизи порога разреза — стоит проверить глазами:")
        for line in review:
            print(line)
    print(f"Суммарная площадь: {total:,.0f} га".replace(",", " "))
    print("По виду полезного ископаемого:")
    for k, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"  {k:<28} {n}")
    print(f"\nЗаписано: {OUT}")


if __name__ == "__main__":
    main()
