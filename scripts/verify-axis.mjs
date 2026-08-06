/**
 * Проверка перенесённой ведомости углов поворота.
 *
 * Ведомость в PDF лежит картинкой, поэтому цифры перенесены вручную. Полагаться
 * на глаз нельзя, но и не нужно: таблица избыточна, и координаты обязаны
 * воспроизводить то, что в ней записано отдельными столбцами. Скрипт считает
 * всё заново из X, Y, радиуса и длины переходной кривой и сверяет:
 *
 *   1. угол поворота — из смены азимута между смежными направлениями;
 *   2. пикетаж каждой вершины — накоплением расстояний за вычетом домеров;
 *   3. непересечение соседних кривых — сумма тангенсов не длиннее прямой;
 *   4. общую длину трассы — против пикетажа конца трассы.
 *
 * Ошибка в любой цифре ломает как минимум одну из проверок: сдвиг разряда
 * в координате меняет и угол, и пикетаж на величины, которые не спрятать.
 *
 * Запуск: node scripts/verify-axis.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(ROOT, 'src/data/axis-kyzylorda-saksaulsk.json'), 'utf8'));

const dms = ([d, m, s]) => d + m / 60 + s / 3600;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fmtSec = (degrees) => `${(degrees * 3600).toFixed(1)}"`;

/** Пикетаж в метрах: ПК по 100 м плюс остаток. */
const chainage = (p) => p.pk * 100 + p.plus;

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
/** Дирекционный угол: от оси X (север) по часовой стрелке. */
const bearing = (a, b) => {
  let t = deg(Math.atan2(b.y - a.y, b.x - a.x));
  return t < 0 ? t + 360 : t;
};

/**
 * Элементы кривой. При переходной кривой длиной ls окружность сдвигается
 * внутрь на p, тангенс растёт, а полная длина кривой равна R·θ + ls.
 */
function curve(v) {
  const theta = rad(dms(v.ang));
  if (!v.ls) {
    const t = v.r * Math.tan(theta / 2);
    const k = v.r * theta;
    return { t, k, domer: 2 * t - k };
  }
  const p = (v.ls * v.ls) / (24 * v.r);
  const t = (v.r + p) * Math.tan(theta / 2) + v.ls / 2;
  const k = v.r * theta + v.ls;
  return { t, k, domer: 2 * t - k };
}

const pts = [data.start, ...data.vertices, data.end];
const problems = [];
let worstAngle = { sec: 0 };
let worstChain = { m: 0 };

// --- 1. Углы поворота -------------------------------------------------------
for (let i = 1; i < pts.length - 1; i++) {
  const v = pts[i];
  const inAz = bearing(pts[i - 1], v);
  const outAz = bearing(v, pts[i + 1]);
  let turn = outAz - inAz;
  if (turn > 180) turn -= 360;
  if (turn < -180) turn += 360;

  // Сравниваем только величину угла. Сторона поворота из координат следует
  // однозначно, читать её из ведомости незачем — и именно на ней я ошибался
  // чаще всего: два узких столбца «влево»/«вправо» на растровой картинке.
  const expected = dms(v.ang);
  const errSec = Math.abs(Math.abs(turn) - expected) * 3600;
  if (errSec > worstAngle.sec) worstAngle = { sec: errSec, n: v.n };
  v.dirFromGeometry = turn > 0 ? 'R' : 'L';
  if (errSec > 5) {
    problems.push(
      `ВУ${v.n}: угол ${v.ang[0]}°${v.ang[1]}'${v.ang[2]}" не сходится — из координат ` +
        `${Math.abs(turn).toFixed(5)}° (расхождение ${fmtSec(Math.abs(Math.abs(turn) - expected))})`,
    );
  }
}

// --- 2. Пикетаж и 3. непересечение кривых -----------------------------------
let acc = 0;
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1];
  const cur = pts[i];
  acc += dist(prev, cur);
  if (i > 1) acc -= curve(prev).domer;

  const declared = chainage(cur);
  const err = Math.abs(acc - declared);
  if (err > worstChain.m) worstChain = { m: err, n: cur.n ?? cur.id };
  if (err > 0.5) {
    problems.push(
      `${cur.id ?? 'ВУ' + cur.n}: пикетаж ПК${cur.pk}+${cur.plus.toFixed(2)} (${declared.toFixed(2)} м) ` +
        `не сходится с расчётом ${acc.toFixed(2)} м — расхождение ${err.toFixed(2)} м`,
    );
  }

  if (i < pts.length - 1 && i > 0) {
    const tPrev = i > 1 ? curve(prev).t : 0;
    const tCur = cur.r ? curve(cur).t : 0;
    const span = dist(prev, cur);
    if (tPrev + tCur > span) {
      problems.push(
        `ВУ${prev.n ?? ''}-${cur.n ?? ''}: кривые перекрываются — тангенсы ${(tPrev + tCur).toFixed(1)} м ` +
          `при длине прямой ${span.toFixed(1)} м`,
      );
    }
  }
}

// --- 4. Итог ----------------------------------------------------------------
const declaredTotal = chainage(data.end);
console.log(`Вершин: ${data.vertices.length}, точек с началом и концом: ${pts.length}`);
console.log(`Худшее расхождение угла поворота:  ${worstAngle.sec.toFixed(1)}″ (ВУ${worstAngle.n})`);
console.log(`Худшее расхождение пикетажа:       ${worstChain.m.toFixed(2)} м (${worstChain.n})`);
console.log(`Длина трассы: расчёт ${acc.toFixed(2)} м, по ведомости ${declaredTotal.toFixed(2)} м, ` +
  `расхождение ${(acc - declaredTotal).toFixed(2)} м`);

if (problems.length) {
  console.log(`\nНе сошлось (${problems.length}):`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nВсё сходится.');
