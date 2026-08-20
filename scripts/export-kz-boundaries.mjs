/**
 * Выгрузка границ всех областей и районов Казахстана — без упрощения.
 *
 * Источник тот же, что у кадастра: GeoServer публичной кадастровой карты
 * https://map.gov4c.kz/egkn/, слои `egkn:regions` и `egkn:districts`.
 * Отдаются целиком, без `viewparams`, в EPSG:3857.
 *
 * В отличие от `fetch-boundaries.mjs`, который режет контуры до 150 м ради веса
 * бандла, здесь не выбрасывается ни одна вершина: файл предназначен для карты,
 * где нужны настоящие границы.
 *
 * ДУБЛИКАТЫ. Слой районов отдаёт 426 записей на 277 кодов: у одного района
 * бывает до пяти версий геометрии, различающихся на километры. Отличить их
 * по `is_del` нельзя — он почти везде false, отметок времени нет.
 *
 * Правило отбора выведено из самих данных. Внешний край района обязан лежать
 * на границе его области, поэтому для каждой группы можно посчитать, насколько
 * версия согласуется с областным контуром. Там, где сравнение даёт однозначный
 * ответ (11 групп), в 11 случаях из 11 побеждает запись с МЕНЬШИМ `change_id`.
 * По нему и отбираем. У остальных групп версии геометрически почти совпадают,
 * и выбор ни на что не влияет.
 *
 * Запуск:
 *   node scripts/export-kz-boundaries.mjs
 *   node scripts/export-kz-boundaries.mjs --native   # оставить EPSG:3857 как есть
 *   node scripts/export-kz-boundaries.mjs --out dir
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHAIN = resolve(HERE, 'gov4c-chain.pem');

// Сервер не отдаёт промежуточный сертификат — та же история, что у кадастра.
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

const NATIVE = args.includes('--native');
const OUT_DIR = resolve(ROOT, argValue('--out', 'export'));
const WFS = 'https://map.gov4c.kz/geoserver/egkn/wfs';

/**
 * Знаков после запятой в широте и долготе. Семь — это около 1 см, то есть
 * на два порядка мельче, чем 0.1 мм исходных метровых координат в проекции.
 * Кому важна побитовая неизменность — `--native` оставляет числа сервера.
 */
const DECIMALS = 7;
const factor = 10 ** DECIMALS;
const round = (v) => Math.round(v * factor) / factor;

async function fetchLayer(typeName, count) {
  const url =
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${typeName}` +
    `&outputFormat=application/json&count=${count}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${typeName}: HTTP ${res.status}`);
  const json = await res.json();

  // Слои не объявляют CRS в ответе; проверяем догадку про EPSG:3857 сами.
  const probe = json.features[0]?.geometry?.coordinates?.flat(Infinity).slice(0, 2) ?? [];
  if (!(Math.abs(probe[0]) > 1e6 && Math.abs(probe[1]) > 1e6)) {
    throw new Error(`${typeName}: координаты не похожи на EPSG:3857: ${JSON.stringify(probe)}`);
  }
  return json.features;
}

/** Перепроецирование без потери вершин: меняются только числа. */
function convert(geometry) {
  if (NATIVE) return geometry;
  const point = ([x, y]) => {
    const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [x, y]);
    return [round(lon), round(lat)];
  };
  const ring = (r) => r.map(point);
  const poly = (p) => p.map(ring);
  return geometry.type === 'Polygon'
    ? { type: 'Polygon', coordinates: poly(geometry.coordinates) }
    : { type: 'MultiPolygon', coordinates: geometry.coordinates.map(poly) };
}

function countPoints(geometry) {
  let n = 0;
  const walk = (a) => {
    if (typeof a[0] === 'number') n += 1;
    else a.forEach(walk);
  };
  walk(geometry.coordinates);
  return n;
}

function write(name, features) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, name);
  const text = JSON.stringify({
    type: 'FeatureCollection',
    crs: NATIVE
      ? { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } }
      : undefined,
    features,
  });
  writeFileSync(path, `${text}\n`);
  const points = features.reduce((sum, f) => sum + countPoints(f.geometry), 0);
  console.log(
    `${name.padEnd(24)} объектов ${String(features.length).padStart(4)}, ` +
      `точек ${points.toLocaleString('ru-RU').padStart(11)}, ` +
      `${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} МБ`,
  );
  return points;
}

// ── Области ─────────────────────────────────────────────────────────────────

const regionsRaw = await fetchLayer('egkn:regions', 100);
const regions = regionsRaw
  .map((f) => ({
    type: 'Feature',
    id: f.properties.code,
    properties: {
      code: f.properties.code,
      name: f.properties.name_ru,
      nameKz: f.properties.name_kz,
      kato: f.properties.kato,
    },
    geometry: convert(f.geometry),
  }))
  .sort((a, b) => a.properties.code.localeCompare(b.properties.code));

write('kz-regions.geojson', regions);

// ── Районы ──────────────────────────────────────────────────────────────────

const districtsRaw = await fetchLayer('egkn:districts', 2000);
const regionName = new Map(regionsRaw.map((f) => [f.properties.code, f.properties.name_ru]));

const groups = new Map();
for (const f of districtsRaw) {
  const code = `${f.properties.regionname}-${f.properties.districtna}`;
  groups.set(code, [...(groups.get(code) ?? []), f]);
}

let dropped = 0;
const districts = [];
for (const [code, variants] of groups) {
  if (variants.length > 1) dropped += variants.length - 1;
  // Меньший change_id — см. обоснование в шапке файла.
  const f = variants.reduce((a, b) => ((a.properties.change_id ?? Infinity) <= (b.properties.change_id ?? Infinity) ? a : b));
  const p = f.properties;
  districts.push({
    type: 'Feature',
    id: code,
    properties: {
      code,
      regionCode: p.regionname,
      region: regionName.get(p.regionname) ?? null,
      name: p.rn_name_ru ?? p.district_1,
      nameKz: p.district_2 ?? null,
      kato: p.kato,
      type: p.typedistri,
    },
    geometry: convert(f.geometry),
  });
}
districts.sort((a, b) => a.properties.code.localeCompare(b.properties.code));

write('kz-districts.geojson', districts);

console.log(
  `\nЗаписей районов получено ${districtsRaw.length}, уникальных кодов ${groups.size}, ` +
    `отброшено дубликатов ${dropped}.`,
);
console.log(`Система координат: ${NATIVE ? 'EPSG:3857, числа сервера без изменений' : `WGS-84, ${DECIMALS} знаков (~1 см)`}`);
console.log(`Каталог: ${OUT_DIR}`);
