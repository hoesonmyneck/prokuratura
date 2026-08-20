"""
Общая часть разбора ведомостей месторождений.

Ведомости приходят в разных форматах: у карьеров сначала долгота, у контрактных
месторождений сначала широта, столбцы и заголовки свои. Но геометрия у них
одинаковая — вершины контуров в градусах, минутах и секундах, несколько
площадок в одной записи и опечатки в отдельных разрядах. Эта часть и живёт
здесь: держать её в двух разборщиках нельзя, разъедется незаметно.
"""

import math

# Шаг, после которого стоит заподозрить границу между площадками, км.
#
# Одного порога по расстоянию мало, и это выяснилось дорогой ценой. Сначала он
# был подобран по ведомости карьеров (там внутри площадки шаг не превышал
# 3.7 км) — и на контрактных месторождениях разрезал участок «Нижний»
# Жанакорганского: это законная полоса 30 км в длину и 600 м в ширину,
# у неё нормальные шаги по 7-27 км.
#
# Поэтому порог только НАМЕКАЕТ на разрез, а решает проверка: разрез
# принимается, лишь если каждый кусок сам по себе полигон, то есть не меньше
# трёх вершин. Узкая полоса при разрезе распалась бы на два огрызка по две
# точки — значит, резать нечего, это одна фигура.
PLOT_GAP_KM = 4.5
REVIEW_BAND = (2.0, 8.0)

# Одинокая вершина: во сколько раз дальше она от ближайшей соседки, чем это
# обычно бывает в этой же записи, и насколько далеко в километрах.
SPIKE_RATIO = 5.0
SPIKE_KM = 5.0

# Куда должна встать вершина после правки, чтобы правку принять, км.
REPAIR_KM = 1.0


def dms(deg, minute, sec):
    return round(deg + minute / 60 + sec / 3600, 6)


def distance_km(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111.32 * math.cos(lat), (a[1] - b[1]) * 111.13)


def split_plots(points, label, review):
    """
    Попытка разбить вершины на несколько площадок по ходу перечисления.

    Режем последовательность, а не расстояния вообще: площадки в ведомости
    выписаны одна за другой. Признак разрыва — крупный шаг либо сброс номера
    вершины (у карьера №20 нумерация идёт «1 2 3 4 1 2 3 4»).

    Возвращает None, если разрез не проходит проверку: каждый кусок должен быть
    полигоном сам по себе. Так узкая длинная полоса остаётся целой, а запись
    с несколькими компактными площадками — делится.
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

    if len(plots) < 2 or any(len(p) < 3 for p in plots):
        return None
    return plots


def find_spike(ring):
    """
    Одинокая вершина — кандидат в опечатку.

    Считаем для каждой вершины расстояние до ближайшей соседки по кольцу.
    Опечатка выдаёт себя тем, что её ближайшая соседка неправдоподобно далеко:
    и в километрах, и по сравнению с тем, как расставлены остальные вершины
    этой же записи. Порог по отношению обязателен — без него длинная полоса,
    у которой все вершины разнесены, попала бы под подозрение целиком.
    """
    if len(ring) < 4:
        return None
    nearest = []
    for i, point in enumerate(ring):
        nearest.append(
            min(distance_km(point["xy"], other["xy"]) for j, other in enumerate(ring) if j != i)
        )
    ordered = sorted(nearest)
    median = ordered[len(ordered) // 2]
    worst = max(range(len(ring)), key=lambda i: nearest[i])
    if nearest[worst] > SPIKE_KM and nearest[worst] > SPIKE_RATIO * max(median, 0.01):
        return worst
    return None


def repair(point, host, order):
    """
    Попытка исправить одну опечатку подстановкой разряда из соседних вершин.

    Разряды — градусы, минуты и секунды обеих координат. Меняем ровно один
    на значение, которое встречается у вершин той же площадки, и проверяем,
    встала ли точка на место. Правка принимается, только если результат
    однозначен; иначе вершина отбрасывается.

    `order` — как разложены разряды в исходной ведомости, для сообщения
    в лог: у карьеров сначала долгота, у контрактных месторождений широта.
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
            xy = point["build"](raw)
            gap = distance_km(xy, centre)
            if gap <= REPAIR_KM and (best is None or gap < best[0]):
                best = (gap, slot, candidate, raw, xy)
    if best is None:
        return None
    gap, slot, candidate, raw, xy = best
    field = order[slot // 3]
    unit = ("градусы", "минуты", "секунды")[slot % 3]
    return {"gap": gap, "slot": slot, "value": candidate, "raw": raw, "xy": xy,
            "what": f"{unit} {field}"}


def build_rings(points, label, order, review, repaired, discarded, log):
    """
    Вершины записи → список колец (площадок).

    Одинокие вершины — кандидаты в опечатки: пробуем починить об основную
    площадку, не вышло — выбрасываем, «полигон» из одной точки не построить.
    """
    plots = split_plots(points, label, review)
    if plots is None:
        # Одна фигура. Ищем в ней одинокие вершины — это опечатки в разрядах.
        ring = list(points)
        while True:
            spike = find_spike(ring)
            if spike is None:
                break
            point = ring.pop(spike)
            fix = repair(point, ring, order)
            if fix:
                log(
                    f"  правка {label} строка {point['row']}: {fix['what']} "
                    f"{point['raw'][fix['slot']]:g} → {fix['value']:g}, "
                    f"вершина встала в {fix['gap'] * 1000:.0f} м от остальных"
                )
                point["raw"] = fix["raw"]
                point["xy"] = fix["xy"]
                ring.append(point)
                repaired.append(point["row"])
                break
            log(
                f"  ! {label} строка {point['row']}: вершина в стороне от остальных, "
                f"исправить однозначно нельзя — отброшена"
            )
            discarded.append(point["row"])
        ring.sort(key=lambda q: q["order"])
        plots = [ring]

    rings = []
    for plot in plots:
        if len(plot) < 3:
            log(f"  ! {label}: кольцо из {len(plot)} точек, пропущено")
            continue
        ring = [list(q["xy"]) for q in plot]
        rings.append([ring + [ring[0]] if ring[0] != ring[-1] else ring])
    return rings


def ring_area_ha(ring):
    """Площадь кольца, га. Плоское приближение — участки маленькие."""
    lat = sum(p[1] for p in ring) / len(ring)
    kx = math.cos(math.radians(lat))
    total = 0.0
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        total += a[0] * kx * b[1] - b[0] * kx * a[1]
    return abs(total / 2) * 111.32 * 111.13 * 100
