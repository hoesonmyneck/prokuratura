/**
 * Выгрузка кадастровых участков в полосе вдоль трассы из ЕГКН.
 *
 * Источник: GeoServer публичной кадастровой карты https://map.gov4c.kz/egkn/
 * Слой `egkn:u_view` — параметризованное SQL-представление: без `viewparams`
 * с идентификатором района оно возвращает ноль объектов. Именно поэтому на
 * сайте нельзя посмотреть область или всю страну разом — только район за раз.
 *
 * Особенности источника, из-за которых нужен этот скрипт:
 *   • координаты приходят в родной UTM-зоне района (EPSG:32640 / 32641),
 *     перепроецирование на стороне сервера не работает — у слоя не объявлен
 *     SRID, поэтому `srsName` игнорируется. Пересчёт делаем здесь, через proj4;
 *   • CORS у сервера не настроен, из браузера дёргать нельзя — выгружаем
 *     заранее и кладём готовый GeoJSON в public/;
 *   • сервер не отдаёт промежуточный сертификат, поэтому node не может собрать
 *     цепочку. Недостающие звенья лежат в scripts/gov4c-chain.pem и
 *     подключаются автоматически (см. NODE_EXTRA_CA_CERTS ниже).
 *
 * Запуск:
 *   node scripts/fetch-cadastre.mjs            # полоса ±3 км от оси дороги
 *   node scripts/fetch-cadastre.mjs --km 5     # другая ширина полосы
 *   node scripts/fetch-cadastre.mjs --out public/cadastre.geojson
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHAIN = resolve(HERE, 'gov4c-chain.pem');

// Сервер присылает только свой сертификат, без промежуточного. Node из-за
// этого падает с UNABLE_TO_VERIFY_LEAF_SIGNATURE. Перезапускаем себя один раз
// с указанием недостающих звеньев — проверку сертификата при этом НЕ отключаем.
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

const CORRIDOR_KM = Number(argValue('--km', '1'));
const OUT = resolve(ROOT, argValue('--out', 'public/cadastre.geojson'));

const WFS = 'https://map.gov4c.kz/geoserver/egkn/wfs';
const PAGE = 2000;
/** Длина куска трассы, для которого строится отдельный bbox-запрос, км. */
const CHUNK_KM = 100;
/**
 * Длина градуса, км. 110.574 — это экватор, и на широте трассы (44-50°)
 * она занижает расстояния почти на процент: полоса «±1 км» выходила уже
 * заявленной. Здесь значения для этих широт: меридиан 111.13, параллель
 * 111.32·cos(φ). Точности до 0.05 % для отбора участков более чем достаточно.
 */
const KM_PER_DEG_LAT = 111.13;
const KM_PER_DEG_LNG_EQ = 111.32;

const districts = JSON.parse(readFileSync(resolve(HERE, 'districts.json'), 'utf8'));
const segments = JSON.parse(readFileSync(resolve(ROOT, 'src/data/road-segments.json'), 'utf8'));

const utm = (srs) => `+proj=utm +zone=${srs - 32600} +datum=WGS84 +units=m +no_defs`;
const kmPerDegLng = (lat) => KM_PER_DEG_LNG_EQ * Math.cos((lat * Math.PI) / 180);

function distanceKm(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  return Math.hypot((b[0] - a[0]) * kmPerDegLng(midLat), (b[1] - a[1]) * KM_PER_DEG_LAT);
}

/** Расстояние от точки до отрезка, км (плоское приближение — на таких дистанциях достаточно). */
function pointToSegmentKm(p, a, b) {
  const lat0 = p[1];
  const kx = kmPerDegLng(lat0);
  const px = p[0] * kx, py = p[1] * KM_PER_DEG_LAT;
  const ax = a[0] * kx, ay = a[1] * KM_PER_DEG_LAT;
  const bx = b[0] * kx, by = b[1] * KM_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToRoadKm(p, lines) {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const d = pointToSegmentKm(p, line[i], line[i + 1]);
      if (d < best) best = d;
      if (best < 0.05) return best;
    }
  }
  return best;
}

/** Режем ось трассы на куски примерно по CHUNK_KM, чтобы bbox-ы были узкими. */
function chunkRoad(lines) {
  const chunks = [];
  for (const line of lines) {
    let current = [line[0]];
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      acc += distanceKm(line[i - 1], line[i]);
      current.push(line[i]);
      if (acc >= CHUNK_KM) {
        chunks.push(current);
        current = [line[i]];
        acc = 0;
      }
    }
    if (current.length > 1) chunks.push(current);
  }
  return chunks;
}

function bboxInUtm(chunk, srs, padKm) {
  const to = utm(srs);
  const pts = chunk.map(([lon, lat]) => proj4('EPSG:4326', to, [lon, lat]));
  const pad = padKm * 1000;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function reproject(geometry, from) {
  const conv = ([x, y]) => {
    const [lon, lat] = proj4(from, 'EPSG:4326', [x, y]);
    return [round6(lon), round6(lat)];
  };
  if (geometry.type === 'Polygon') return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => r.map(conv)) };
  if (geometry.type === 'MultiPolygon')
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(conv))) };
  return null;
}

function centroid(geometry) {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : null;
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}\nURL: ${url}\n${body.slice(0, 400)}`);
      }
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
}

const roadLines = segments.map((s) => s.path);
const chunks = chunkRoad(roadLines);
console.log(`Полоса ±${CORRIDOR_KM} км, ось разбита на ${chunks.length} участков по ~${CHUNK_KM} км\n`);

const out = [];
const seen = new Set();
let requests = 0;

for (const d of districts) {
  const from = utm(d.srs);
  let kept = 0;
  let fetched = 0;

  for (const chunk of chunks) {
    const [minX, minY, maxX, maxY] = bboxInUtm(chunk, d.srs, CORRIDOR_KM + 1);
    // UTM-координаты за пределами разумного — кусок трассы вне зоны этого района.
    if (maxX < -1e6 || minX > 2e6) continue;

    let start = 0;
    for (;;) {
      const url =
        `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=egkn:u_view` +
        `&outputFormat=application/json&viewparams=district_id:${d.districtId}` +
        // sortBy обязателен: у SQL-представления нет первичного ключа, и без
        // явной сортировки GeoServer отвечает 400 на любой startIndex.
        `&count=${PAGE}&startIndex=${start}&sortBy=gid` +
        `&bbox=${minX.toFixed(1)},${minY.toFixed(1)},${maxX.toFixed(1)},${maxY.toFixed(1)}`;

      const json = await getJson(url);
      requests++;
      const feats = json.features ?? [];
      fetched += feats.length;

      for (const f of feats) {
        const gid = f.properties?.gid;
        if (gid == null || seen.has(gid)) continue;
        const geom = reproject(f.geometry, from);
        if (!geom) continue;
        const c = centroid(geom);
        if (!c || distanceToRoadKm(c, roadLines) > CORRIDOR_KM) continue;

        seen.add(gid);
        kept++;
        const p = f.properties;
        out.push({
          type: 'Feature',
          id: gid,
          properties: {
            gid,
            cadNumber: p.kad_nomer ?? null,
            address: p.address_ru || null,
            areaM2: p.squ ?? null,
            purpose: p.tsn_ru || null,
            categoryId: p.category_id ?? null,
            rightTypeId: p.right_type_id ?? null,
            region: d.region,
            district: d.name,
            districtCode: d.code,
          },
          geometry: geom,
        });
      }

      if (feats.length < PAGE) break;
      start += PAGE;
      await new Promise((res) => setTimeout(res, 150));
    }
    await new Promise((res) => setTimeout(res, 150));
  }

  console.log(`${d.code}  ${d.name.padEnd(22)} получено ${String(fetched).padStart(6)} → в полосе ${String(kept).padStart(6)}`);
}

const fc = { type: 'FeatureCollection', features: out };
writeFileSync(OUT, JSON.stringify(fc));
const mb = (Buffer.byteLength(JSON.stringify(fc)) / 1024 / 1024).toFixed(1);
console.log(`\nЗапросов к серверу: ${requests}`);
console.log(`Участков в полосе:  ${out.length}`);
console.log(`Записано: ${OUT} (${mb} МБ)`);
