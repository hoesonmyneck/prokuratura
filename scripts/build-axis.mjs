/**
 * Построение оси трассы из ведомости углов поворота и запись её
 * в `road-segments.json` вместо схематичной линии этого плеча.
 *
 * Сама геометрия живёт в `lib/axis.mjs` — её же использует `build-features.mjs`,
 * который ставит обозначения по пикетажу.
 *
 * Запуск:
 *   node scripts/build-axis.mjs
 *   node scripts/build-axis.mjs --dry   # только посчитать и показать
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAxis, ellipsoidKm, toWgs } from './lib/axis.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const axis = JSON.parse(
  readFileSync(resolve(ROOT, 'src/data/axis-kyzylorda-saksaulsk.json'), 'utf8'),
);

const { points, worstClose } = buildAxis(axis);

let planLen = 0;
for (let i = 1; i < points.length; i++) {
  planLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
}
const declared = axis.end.pk * 100 + axis.end.plus;

const wgs = points.map(toWgs);
let geoLen = 0;
for (let i = 1; i < wgs.length; i++) geoLen += ellipsoidKm(wgs[i - 1], wgs[i]);

console.log(`Точек в оси: ${points.length}`);
console.log(`Худшая невязка замыкания кривой: ${(worstClose.m * 1000).toFixed(1)} мм (ВУ${worstClose.n})`);
console.log(
  `Длина по плану:  ${planLen.toFixed(2)} м, по ведомости ${declared.toFixed(2)} м, ` +
    `расхождение ${(planLen - declared).toFixed(2)} м`,
);
console.log(`Длина в WGS-84:  ${geoLen.toFixed(3)} км`);
console.log(`Начало: ${wgs[0].join(', ')}`);
console.log(`Конец:  ${wgs[wgs.length - 1].join(', ')}`);

if (DRY) {
  console.log('\n--dry: файл не тронут');
  process.exit(0);
}

const segPath = resolve(ROOT, 'src/data/road-segments.json');
const segments = JSON.parse(readFileSync(segPath, 'utf8'));
const target = segments.find((s) => s.id === axis.segment);
if (!target) throw new Error(`Участок ${axis.segment} не найден в road-segments.json`);
target.path = wgs;

writeFileSync(segPath, `${JSON.stringify(segments, null, 2)}\n`);
console.log(`\nЗаписано: ${segPath} (участок ${target.name})`);
