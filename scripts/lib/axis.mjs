/**
 * Построение оси трассы из ведомости углов поворота.
 *
 * Общий модуль: им пользуются и `build-axis.mjs` (пишет ось в road-segments),
 * и `build-features.mjs` (ставит обозначения по пикетажу). Держать эту
 * математику в двух местах нельзя — разъедется незаметно.
 *
 * Каждая точка получает станцию `s` — расстояние от начала трассы вдоль оси.
 * По ней обозначения с подписью «КМ 30+058» ложатся туда, где им положено,
 * без всякой привязки чертежа к местности.
 */

import proj4 from 'proj4';

/**
 * Система координат ведомости. Осевой меридиан 63° определён перебором
 * (см. README), датум взят СК-42 — подтвердить его нечем, остаточная
 * неопределённость порядка 100-250 м.
 */
export const SURVEY =
  '+proj=tmerc +lat_0=0 +lon_0=63 +k=1 +x_0=500000 +y_0=0 ' +
  '+ellps=krass +towgs84=28,-130,-95,0,0,0,0 +units=m +no_defs';

/** Шаг численного интегрирования кривой, м. */
const STEP = 1;

const dms = ([d, m, s]) => d + m / 60 + s / 3600;
const rad = (d) => (d * Math.PI) / 180;
const bearing = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const step = (p, brg, d) => ({ x: p.x + d * Math.cos(brg), y: p.y + d * Math.sin(brg) });

/** Тангенс и длины частей кривой. */
export function elements(v) {
  const theta = rad(dms(v.ang));
  if (!v.ls) return { theta, t: v.r * Math.tan(theta / 2), ls: 0, arc: v.r * theta };
  const p = (v.ls * v.ls) / (24 * v.r);
  return {
    theta,
    t: (v.r + p) * Math.tan(theta / 2) + v.ls / 2,
    ls: v.ls,
    // Круговая часть: полный угол минус то, что «съели» две клотоиды.
    arc: v.r * theta - v.ls,
  };
}

/**
 * @param {object} axis разобранная ведомость
 * @param {number} sample шаг выдачи точек на кривой, м
 * @returns {{points: Array<{x:number,y:number,s:number}>, worstClose:{m:number,n:number}}}
 */
export function buildAxis(axis, sample = 40) {
  const pts = [axis.start, ...axis.vertices, axis.end];
  const out = [];
  let s = 0;
  let worstClose = { m: 0, n: 0 };

  const push = (p) => out.push({ x: p.x, y: p.y, s });

  push(axis.start);

  for (let i = 1; i < pts.length - 1; i++) {
    const v = pts[i];
    const inB = bearing(pts[i - 1], v);
    const outB = bearing(v, pts[i + 1]);
    let turn = outB - inB;
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    const sign = Math.sign(turn);

    const { t, ls, arc } = elements(v);

    // Прямая до начала кривой.
    const ts = step(v, inB, -t);
    s += dist(out.length ? { x: out[out.length - 1].x, y: out[out.length - 1].y } : ts, ts);
    push(ts);

    let p = ts;
    let brg = inB;
    let sinceSample = 0;

    const advance = (len, curvatureAt) => {
      for (let d = 0; d < len; d += STEP) {
        const ds = Math.min(STEP, len - d);
        const k = curvatureAt(d + ds / 2);
        // Середина шага: поворот на половину, движение, поворот на вторую.
        brg += (sign * k * ds) / 2;
        p = step(p, brg, ds);
        brg += (sign * k * ds) / 2;
        s += ds;
        sinceSample += ds;
        if (sinceSample >= sample) {
          push(p);
          sinceSample = 0;
        }
      }
    };

    if (ls) advance(ls, (d) => d / (v.r * ls)); // клотоида: кривизна растёт линейно
    advance(arc, () => 1 / v.r);
    if (ls) advance(ls, (d) => (ls - d) / (v.r * ls));

    // Конец кривой обязан лечь на исходящий тангенс вершины.
    const expected = step(v, outB, t);
    const err = dist(p, expected);
    if (err > worstClose.m) worstClose = { m: err, n: v.n };
    // Станцию не поправляем на невязку: она миллиметровая, а подгонка
    // спрятала бы ошибку, если геометрия однажды поедет всерьёз.
    push(expected);
  }

  const last = out[out.length - 1];
  s += dist(last, axis.end);
  push(axis.end);

  return { points: out, worstClose };
}

/** Точка на оси по станции (расстоянию от начала трассы), м. */
export function pointAt(points, station) {
  if (station <= points[0].s) return points[0];
  const last = points[points.length - 1];
  if (station >= last.s) return last;

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].s <= station) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.s - a.s;
  const t = span === 0 ? 0 : (station - a.s) / span;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: station };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** В WGS-84. В ведомости X — север, Y — восток; proj4 ждёт [восток, север]. */
export const toWgs = (p) => proj4(SURVEY, 'EPSG:4326', [p.y, p.x]).map(round6);

const A_WGS = 6378137;
const E2 = 0.00669437999014;

/**
 * Длина отрезка по эллипсоиду через местные радиусы кривизны. Плоская формула
 * с константой 110.574 км/° (это экватор) занижает на 0.7 %, гаверсинус со
 * средним радиусом — ещё на 0.17 %: трасса идёт почти по параллели, где
 * работает радиус нормального сечения 6389 км.
 */
export function ellipsoidKm(a, b) {
  const lat = rad((a[1] + b[1]) / 2);
  const w = 1 - E2 * Math.sin(lat) ** 2;
  const N = A_WGS / Math.sqrt(w);
  const M = (A_WGS * (1 - E2)) / w ** 1.5;
  return Math.hypot(rad(b[0] - a[0]) * N * Math.cos(lat), rad(b[1] - a[1]) * M) / 1000;
}
