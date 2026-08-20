/**
 * Сборка областей объединением районов.
 *
 * Слой `egkn:regions` брать нельзя: в нём остался дореформенный контур
 * Восточно-Казахстанской области, включающий территорию области Абай. Проверка
 * однозначна — 88 % вершин районов Абая лежат внутри контура ВКО, тогда как
 * обратно только 1 %. То же с Астаной: 39 % вершин её районов попадают внутрь
 * Акмолинской области. Нарисованные как есть, эти области накладываются.
 *
 * Районы при этом уже разнесены по новым кодам, поэтому области собираются
 * из них. Так оба уровня согласованы по построению и отражают нынешнее деление.
 *
 * Топологического объединения (склейки по общим рёбрам) не выходит: соседние
 * районы совпадают вершина в вершину лишь на 35-41 % рёбер, остальное пришлось
 * бы чинить снапом. Поэтому честная булева операция над полигонами.
 *
 * Вершины при этом остаются исходными: объединение выбрасывает внутренние
 * границы, а внешний контур собирается из тех же точек районов. Новые точки
 * появляются только там, где контуры соседей пересекались.
 *
 * Запуск:
 *   node --max-old-space-size=4096 scripts/dissolve-regions.mjs
 *   node --max-old-space-size=4096 scripts/dissolve-regions.mjs --out dir
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const i = args.indexOf('--out');
const DIR = resolve(ROOT, i >= 0 && args[i + 1] ? args[i + 1] : 'export');

const districts = JSON.parse(readFileSync(resolve(DIR, 'kz-districts.geojson'), 'utf8'));

/** Геометрия в вид, который ждёт polygon-clipping: список полигонов. */
const asPolygons = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

function countPoints(coords) {
  let n = 0;
  const walk = (a) => {
    if (typeof a[0] === 'number') n += 1;
    else a.forEach(walk);
  };
  walk(coords);
  return n;
}

const groups = new Map();
for (const f of districts.features) {
  const code = f.properties.regionCode;
  if (!groups.has(code)) groups.set(code, { code, region: f.properties.region, parts: [], districts: 0 });
  const g = groups.get(code);
  g.parts.push(...asPolygons(f.geometry));
  g.districts += 1;
}

const features = [];
let before = 0;
let after = 0;

for (const { code, region, parts, districts: count } of [...groups.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const inputPoints = countPoints(parts);
  before += inputPoints;

  // Объединение всех районов области за один вызов: библиотека сама разберётся
  // с внутренними границами. По одному в цикле было бы медленнее и накапливало
  // бы погрешность от повторных пересчётов.
  const union = polygonClipping.union(parts[0], ...parts.slice(1));

  const outputPoints = countPoints(union);
  after += outputPoints;

  features.push({
    type: 'Feature',
    id: code,
    properties: { code, name: region, districts: count },
    geometry: { type: 'MultiPolygon', coordinates: union },
  });

  console.log(
    `${code}  ${String(region).padEnd(30)} районов ${String(count).padStart(3)}, ` +
      `точек ${String(inputPoints).padStart(7)} → ${String(outputPoints).padStart(7)}, ` +
      `контуров ${union.length}`,
  );
}

const out = resolve(DIR, 'kz-regions-dissolved.geojson');
const text = JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(out, `${text}\n`);

console.log(
  `\nОбластей ${features.length}, точек ${before.toLocaleString('ru-RU')} → ${after.toLocaleString('ru-RU')} ` +
    `(внутренние границы убраны), ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} МБ`,
);
console.log(`Записано: ${out}`);
