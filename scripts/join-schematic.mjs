/**
 * Сведение схематичных плеч к настоящей оси.
 *
 * Плечо «Кызылорда — Саксаульск» построено по ведомости и кончается там, где
 * кончается проект, — на КМ 462, в 35 км не доходя до посёлка Саксаульский.
 * Два других плеча нарисованы на глаз и упирались прямо в посёлок, из-за чего
 * на карте между ними и настоящей трассой зиял разрыв.
 *
 * Настоящую ось не трогаем: она геодезическая. Двигаем хвосты схематичных —
 * им всё равно предстоит замена, когда придут их ведомости.
 *
 * Смещение не приклеивается к последней точке рывком, а разносится по хвосту:
 * чем ближе точка к концу, тем сильнее она сдвигается. Иначе на стыке появился
 * бы излом, который читался бы как поворот трассы.
 *
 * Скрипт идемпотентен: если конец уже на месте, он ничего не делает.
 *
 * Запуск: node scripts/join-schematic.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, 'src/data/road-segments.json');

/** Плечо с настоящей геодезией — к его концу сводим остальные. */
const REAL = 'kyzylorda-saksaulsk';
/** На каком протяжении хвоста разносится смещение, км. */
const TAPER_KM = 150;
/** Ближе этого считаем, что стыковать уже нечего. */
const JOINED_KM = 0.1;

const KM_PER_DEG_LAT = 111.13;
const KM_PER_DEG_LNG_EQ = 111.32;

function distanceKm(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  return Math.hypot(
    (b[0] - a[0]) * KM_PER_DEG_LNG_EQ * Math.cos((midLat * Math.PI) / 180),
    (b[1] - a[1]) * KM_PER_DEG_LAT,
  );
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

const segments = JSON.parse(readFileSync(FILE, 'utf8'));
const real = segments.find((s) => s.id === REAL);
if (!real) throw new Error(`Не найдено плечо ${REAL}`);
const target = real.path[real.path.length - 1];

let changed = false;
for (const seg of segments) {
  if (seg.id === REAL) continue;

  const path = seg.path;
  const end = path[path.length - 1];
  const gap = distanceKm(end, target);
  if (gap < JOINED_KM) {
    console.log(`${seg.id.padEnd(22)} уже состыковано`);
    continue;
  }

  // Расстояние каждой точки от конца — по нему считается вес смещения.
  const fromEnd = new Array(path.length).fill(0);
  for (let i = path.length - 2; i >= 0; i--) {
    fromEnd[i] = fromEnd[i + 1] + distanceKm(path[i], path[i + 1]);
  }

  const dLon = target[0] - end[0];
  const dLat = target[1] - end[1];
  let moved = 0;
  for (let i = 0; i < path.length; i++) {
    const w = Math.max(0, 1 - fromEnd[i] / TAPER_KM);
    if (w === 0) continue;
    path[i] = [round6(path[i][0] + dLon * w), round6(path[i][1] + dLat * w)];
    moved += 1;
  }

  console.log(
    `${seg.id.padEnd(22)} разрыв ${gap.toFixed(1)} км закрыт, сдвинуто точек: ${moved} из ${path.length}`,
  );
  changed = true;
}

if (!changed) {
  console.log('\nИзменений нет.');
  process.exit(0);
}

writeFileSync(FILE, `${JSON.stringify(segments, null, 2)}\n`);
console.log(`\nЗаписано: ${FILE}`);
