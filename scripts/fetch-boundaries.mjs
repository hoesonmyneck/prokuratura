/**
 * Выгрузка административных границ вдоль трассы — областей и районов.
 *
 * Источник тот же, что и у кадастра, — GeoServer публичной кадастровой карты
 * https://map.gov4c.kz/egkn/, слои `egkn:regions` и `egkn:districts`. В отличие
 * от `egkn:u_view` это обычные слои: отдаются без `viewparams`, фильтруются
 * через CQL и приходят сразу в EPSG:3857 (проверка координат — в `toWgs`).
 *
 * Результат мал (десятки КБ), поэтому кладётся в src/, а не в public/:
 * границы нужны карте сразу при старте, отдельная сетевая загрузка ради них
 * не оправдана.
 *
 * Запуск:
 *   node scripts/fetch-boundaries.mjs
 *   node scripts/fetch-boundaries.mjs --tolerance 300   # огрубить контур, метров
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHAIN = resolve(HERE, 'gov4c-chain.pem');

// Та же история, что и в fetch-cadastre.mjs: сервер не отдаёт промежуточный
// сертификат. Перезапускаемся с недостающими звеньями, проверку не отключаем.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CHAIN },
  });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** Допуск упрощения контура, метров. */
const TOLERANCE_M = Number(argValue('--tolerance', '150'));
const OUT_REGIONS = resolve(ROOT, argValue('--out-regions', 'src/data/regions.json'));
const OUT_DISTRICTS = resolve(ROOT, argValue('--out-districts', 'src/data/districts.json'));

const WFS = 'https://map.gov4c.kz/geoserver/egkn/wfs';
const KM_PER_DEG_LAT = 110.574;

/**
 * Области трассы. Код — тот же двузначный префикс, что и в кодах районов
 * (`districts.json`: «13-196» → Мангистауская). Цвет — заливка на карте и
 * образец в списке слева.
 *
 * Подбирались под спутниковую подложку: она песчано-бурая, поэтому земляные
 * оттенки на ней пропадают (Актюбинская была коричневой — сливалась целиком).
 * Взяты только те тона, которых в снимке не встретить, и при этом не занятые
 * трассой (#d93025, #1a73e8) и категориями земель (#f9ab00, #188038, #9334e6).
 */
const REGIONS = [
  { code: '13', color: '#00897b', labelPrefer: 'south' },
  { code: '02', color: '#e91e63' },
  { code: '10', color: '#3949ab', labelPrefer: 'south' },
];

/**
 * Доля лучшего запаса, ниже которой опускаться нельзя даже ради `labelPrefer`.
 * Самое пустое место не всегда самое удачное на глаз: у Мангистауской и
 * Кызылординской областей оно приходится на верх контура, где подпись липнет
 * к трассе и к соседям. Сдвигаем такие ниже, но не любой ценой.
 */
const BIAS_KEEP = 0.6;

const segments = JSON.parse(readFileSync(resolve(ROOT, 'src/data/road-segments.json'), 'utf8'));
const roadPoints = segments.flatMap((s) => s.path);
const roadLines = segments.map((s) => s.path);
const cityPoints = JSON.parse(readFileSync(resolve(ROOT, 'src/data/cities.json'), 'utf8')).map(
  (c) => c.lngLat,
);

/**
 * Рамка, в которой подпись имеет смысл, — habitat трассы и городов с запасом.
 * Считается по данным, а не копируется из `ROAD_BOUNDS`: константу пришлось бы
 * держать в синхронизации вручную, а тут запас в 0,5° даёт почти то же окно.
 */
const FRAME = (() => {
  const all = [...roadPoints, ...cityPoints];
  const pad = 0.5;
  return {
    minLon: Math.min(...all.map((p) => p[0])) - pad,
    maxLon: Math.max(...all.map((p) => p[0])) + pad,
    minLat: Math.min(...all.map((p) => p[1])) - pad,
    maxLat: Math.max(...all.map((p) => p[1])) + pad,
  };
})();

const round5 = (v) => Math.round(v * 1e5) / 1e5;

function toWgs([x, y]) {
  const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [x, y]);
  return [round5(lon), round5(lat)];
}

/** Расстояние от точки до прямой AB в градусах, с поправкой на сжатие долготы. */
function perpDistance(p, a, b) {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  const px = p[0] * kx, ax = a[0] * kx, bx = b[0] * kx;
  const dx = bx - ax, dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, p[1] - a[1]);
  return Math.abs(dy * px - dx * p[1] + bx * a[1] - b[1] * ax) / len;
}

/** Дуглас — Пекер. Кольцо упрощаем без первой/последней точки, чтобы не разомкнуть. */
function simplifyRing(ring, tolDeg) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;

  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(ring[i], ring[first], ring[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index > 0 && maxDist > tolDeg) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = ring.filter((_, i) => keep[i]);
  // Кольцо из трёх точек — вырожденное, полигон из него не построить.
  return out.length >= 4 ? out : ring;
}

function convertPolygon(rings, tolDeg) {
  return rings
    .map((ring) => simplifyRing(ring.map(toWgs), tolDeg))
    .filter((ring) => ring.length >= 4);
}

/** Луч вправо: нечётное число пересечений — точка внутри кольца. */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Внутри внешнего кольца и снаружи всех дырок. */
function inPolygon(p, polygon) {
  if (!inRing(p, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (inRing(p, polygon[i])) return false;
  return true;
}

const inMultiPolygon = (p, polygons) => polygons.some((poly) => inPolygon(p, poly));

/** Расстояние от точки до отрезка, км (плоское приближение — на таких дистанциях достаточно). */
function pointToSegmentKm(p, a, b) {
  const kx = KM_PER_DEG_LAT * Math.cos((p[1] * Math.PI) / 180);
  const px = p[0] * kx, py = p[1] * KM_PER_DEG_LAT;
  const ax = a[0] * kx, ay = a[1] * KM_PER_DEG_LAT;
  const bx = b[0] * kx, by = b[1] * KM_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Расстояние от точки до ближайшего из колец, км. */
function distanceToRingsKm(p, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const d = pointToSegmentKm(p, ring[i - 1], ring[i]);
      if (d < best) best = d;
    }
  }
  return best;
}

const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];

/** Все кольца объекта в WGS-84, без упрощения. */
const ringsOf = (geometry) =>
  geometry.coordinates.flatMap((poly) => (geometry.type === 'Polygon' ? [poly] : poly)).map((r) => r.map(toWgs));

/** Центр самого крупного по числу точек внешнего кольца. */
function centroid(polygons) {
  const rings = polygons.map((p) => p[0]).sort((a, b) => b.length - a.length);
  const ring = rings[0];
  let sx = 0, sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return [round5(sx / ring.length), round5(sy / ring.length)];
}

/**
 * Точка подписи — середина той части трассы, что лежит внутри контура. Центроид
 * не годится как основной вариант: Мангистауская и Актюбинская области огромные,
 * их центры лежат далеко в стороне от коридора и в кадре проекта не видны.
 * Но для районов, мимо которых ось прошла стороной, центроид — запасной выход.
 */
function labelAnchor(polygons) {
  const inside = roadPoints.filter((p) => inMultiPolygon(p, polygons));
  if (!inside.length) return centroid(polygons);
  return inside[Math.floor(inside.length / 2)].map(round5);
}

/**
 * Точка подписи области — самое пустое место внутри неё.
 *
 * Названия областей длинные и висят на карте всегда, поэтому ставить их на ось,
 * как подписи районов, нельзя: плашка ложится на трассу, кружки населённых
 * пунктов и попапы. Ищем точку, максимально удалённую сразу от трёх вещей —
 * трассы, городов и собственной границы области, — оставаясь в рамке, где
 * подпись вообще будет видна.
 *
 * Обход по сетке, а не аналитически: препятствия разнородные, а точности
 * в километры для подписи более чем достаточно. Сначала грубо, потом уточнение
 * вокруг найденного максимума.
 */
function emptySpotAnchor(polygons, rings, prefer) {
  const lons = polygons.flat(2).map((p) => p[0]);
  const lats = polygons.flat(2).map((p) => p[1]);
  const box = {
    minLon: Math.max(Math.min(...lons), FRAME.minLon),
    maxLon: Math.min(Math.max(...lons), FRAME.maxLon),
    minLat: Math.max(Math.min(...lats), FRAME.minLat),
    maxLat: Math.min(Math.max(...lats), FRAME.maxLat),
  };

  // Край рамки — такое же препятствие, как трасса: без него оптимум уезжает
  // ровно в угол окна, и подпись оказывается на самой кромке экрана.
  const toFrameKm = (p) => {
    const kx = KM_PER_DEG_LAT * Math.cos((p[1] * Math.PI) / 180);
    return Math.min(
      (p[0] - FRAME.minLon) * kx,
      (FRAME.maxLon - p[0]) * kx,
      (p[1] - FRAME.minLat) * KM_PER_DEG_LAT,
      (FRAME.maxLat - p[1]) * KM_PER_DEG_LAT,
    );
  };

  const clearance = (p) =>
    Math.min(
      distanceToRingsKm(p, roadLines),
      Math.min(...cityPoints.map((c) => pointToSegmentKm(p, c, c))),
      distanceToRingsKm(p, rings),
      toFrameKm(p),
    );

  const scan = (step, center, floor) => {
    const area = center
      ? {
          minLon: Math.max(center[0] - step * 5, box.minLon),
          maxLon: Math.min(center[0] + step * 5, box.maxLon),
          minLat: Math.max(center[1] - step * 5, box.minLat),
          maxLat: Math.min(center[1] + step * 5, box.maxLat),
        }
      : box;
    const found = [];
    for (let lon = area.minLon; lon <= area.maxLon; lon += step) {
      for (let lat = area.minLat; lat <= area.maxLat; lat += step) {
        const p = [lon, lat];
        if (!inMultiPolygon(p, polygons)) continue;
        found.push({ p, score: clearance(p) });
      }
    }
    if (!found.length) return null;

    const best = found.reduce((a, b) => (b.score > a.score ? b : a));
    if (prefer !== 'south') return { pick: best, best: best.score };
    // Из всех мест, где запас не хуже порога, берём самое южное.
    const allowed = found.filter((c) => c.score >= (floor ?? best.score * BIAS_KEEP));
    return {
      pick: allowed.length ? allowed.reduce((a, b) => (b.p[1] < a.p[1] ? b : a)) : best,
      best: best.score,
    };
  };

  // Область целиком вне рамки — подпись всё равно не увидят, ставим по трассе.
  const coarse = scan(0.1, null);
  if (!coarse) return { at: labelAnchor(polygons), clearanceKm: 0 };

  // Порог берётся от грубого прохода и держится до конца: если пересчитывать его
  // на уточнении, подпись сползает дальше на каждом шаге и запас накапливает потери.
  const floor = coarse.best * BIAS_KEEP;
  const fine = scan(0.02, coarse.pick.p, floor) ?? coarse;
  return { at: fine.pick.p.map(round5), clearanceKm: Math.round(fine.pick.score) };
}

/*
 * Протяжённость трассы по каждой области здесь намеренно НЕ считается.
 * Схематичная ось короче паспортной: 1 226 км геометрии против 1 574 км по
 * документации, а на «Бейнеу — Саксаульск» — 528 против 800. Разбивка по
 * областям унаследовала бы эту ошибку и выглядела бы точным числом.
 * Появятся настоящие координаты оси — считать станет можно.
 */

const tolDeg = TOLERANCE_M / 1000 / KM_PER_DEG_LAT;

async function fetchLayer(typeName, cql) {
  const url =
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${typeName}` +
    `&outputFormat=application/json&count=200&CQL_FILTER=${encodeURIComponent(cql)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();

  // Слои не объявляют CRS в ответе, поэтому проверяем догадку про EPSG:3857
  // сами: у координат метрового меркатора для Казахстана порядок 5–8 млн.
  const probe = json.features[0]?.geometry?.coordinates?.flat(Infinity).slice(0, 2) ?? [];
  if (!(Math.abs(probe[0]) > 1e6 && Math.abs(probe[1]) > 1e6)) {
    throw new Error(`${typeName}: координаты не похожи на EPSG:3857: ${JSON.stringify(probe)}`);
  }
  return json.features;
}

/** Упрощает геометрию объекта и возвращает кольца MultiPolygon + счётчики точек. */
function prepare(geometry) {
  const polygons =
    geometry.type === 'Polygon'
      ? [convertPolygon(geometry.coordinates, tolDeg)]
      : geometry.coordinates.map((p) => convertPolygon(p, tolDeg));
  const rings = polygons.filter((p) => p.length);
  return {
    rings,
    before: geometry.coordinates.flat(Infinity).length / 2,
    after: rings.flat(Infinity).length / 2,
  };
}

function write(path, features) {
  const text = JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(path, text);
  const kb = (Buffer.byteLength(text) / 1024).toFixed(0);
  const pts = features.reduce((s, f) => s + f.geometry.coordinates.flat(Infinity).length / 2, 0);
  console.log(`Записано: ${path} — ${features.length} шт., ${pts} точек, ${kb} КБ\n`);
}

// ── Области ───────────────────────────────────────────────────────────────────

console.log(`Допуск упрощения ${TOLERANCE_M} м\n\nОбласти:`);

const regionCodes = REGIONS.map((r) => `'${r.code}'`).join(',');
const regionFeatures = await fetchLayer('egkn:regions', `code IN (${regionCodes})`);
const regions = [];
/** Неупрощённые контуры областей — по ним ниже выбирается верная запись района. */
const regionRings = new Map();

for (const { code, color, labelPrefer } of REGIONS) {
  const f = regionFeatures.find((x) => x.properties.code === code);
  if (!f) throw new Error(`Область с кодом ${code} не найдена в ответе сервера`);
  regionRings.set(code, ringsOf(f.geometry));

  const { rings, before, after } = prepare(f.geometry);
  const { at, clearanceKm } = emptySpotAnchor(rings, rings.flat(), labelPrefer);
  console.log(
    `  ${code}  ${f.properties.name_ru.padEnd(24)} точек ${String(before).padStart(6)} → ${String(after).padStart(5)}` +
      `   подпись ${at.join(', ')}, свободно ${clearanceKm} км вокруг`,
  );

  regions.push({
    type: 'Feature',
    id: code,
    properties: { code, name: f.properties.name_ru, color, labelAt: at },
    geometry: { type: 'MultiPolygon', coordinates: rings },
  });
}

write(OUT_REGIONS, regions);

// ── Районы ────────────────────────────────────────────────────────────────────

/*
 * Берём ровно те районы, из которых выгружался кадастр (`districts.json`), —
 * один список на обе выгрузки. Полное деление всех трёх областей (51 район)
 * тянуть незачем: к коридору оно отношения не имеет и весит втрое больше.
 *
 * Код района в справочнике — «13-196» — это `regionname` + `districtna` слоя.
 * По ним и фильтруем; собрать код на стороне сервера через конкатенацию нельзя,
 * поэтому условие расписано парами.
 */

console.log('Районы:');

const districtRefs = JSON.parse(readFileSync(resolve(HERE, 'districts.json'), 'utf8'));
const districtCql = districtRefs
  .map((d) => {
    const [region, district] = d.code.split('-');
    return `(regionname='${region}' AND districtna='${district}')`;
  })
  .join(' OR ');

const districtFeatures = await fetchLayer('egkn:districts', districtCql);
const districts = [];

/**
 * Слой отдаёт дубликаты: у Бейнеуского района три записи с разной геометрией,
 * у Аральского — две. По атрибутам их не различить — `is_del` везде `false`,
 * отметок времени нет, а `change_id` вводит в заблуждение: у неверной записи
 * Аральского он как раз больше. Первая версия выбирала запись по id объекта
 * (`districts.152` = `districtId` из справочника) — и брала устаревший контур,
 * из-за чего граница с Казалинским районом на карте двоилась.
 *
 * Надёжный арбитр — граница области: внешний край района обязан лежать на ней.
 * Считаем медиану отклонения тех вершин, что идут вдоль областной границы:
 * у верной записи Аральского это 1 м, у устаревшей — 1 632 м.
 *
 * У Бейнеуского все три записи ложатся на границу области одинаково точно —
 * там спор решает детальность контура.
 */
function pickVariant(ref, variants) {
  if (variants.length === 1) return { feature: variants[0] };

  const scored = variants.map((f) => {
    const along = ringsOf(f.geometry)
      .flat()
      .map((p) => distanceToRingsKm(p, regionRings.get(ref.code.split('-')[0])))
      .filter((d) => d < 5);
    return { f, points: ringsOf(f.geometry).flat().length, score: along.length ? median(along) : Infinity };
  });
  scored.sort((a, b) => a.score - b.score || b.points - a.points);

  const [best, next] = scored;
  const note =
    Math.abs(best.score - next.score) < 0.05
      ? `записей ${variants.length}, на границе области лежат одинаково — взята подробнее (${best.points} точек)`
      : `записей ${variants.length}, взята точнее по границе области (${(best.score * 1000).toFixed(0)} м против ${(next.score * 1000).toFixed(0)} м)`;
  return { feature: best.f, note };
}

const byCode = new Map();
for (const f of districtFeatures) {
  const code = `${f.properties.regionname}-${f.properties.districtna}`;
  byCode.set(code, [...(byCode.get(code) ?? []), f]);
}

for (const d of districtRefs) {
  const variants = byCode.get(d.code);
  if (!variants?.length) throw new Error(`Район ${d.code} (${d.name}) не найден в ответе сервера`);
  const { feature, note } = pickVariant(d, variants);

  const { rings, before, after } = prepare(feature.geometry);
  console.log(
    `  ${d.code}  ${d.name.padEnd(22)} точек ${String(before).padStart(6)} → ${String(after).padStart(5)}` +
      (note ? `   ${note}` : ''),
  );

  districts.push({
    type: 'Feature',
    id: d.code,
    properties: {
      code: d.code,
      name: d.name,
      regionCode: d.code.split('-')[0],
      labelAt: labelAnchor(rings),
    },
    geometry: { type: 'MultiPolygon', coordinates: rings },
  });
}

write(OUT_DISTRICTS, districts);
