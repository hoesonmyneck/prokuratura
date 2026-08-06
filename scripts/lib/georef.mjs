/**
 * Привязка листа чертежа к местности.
 *
 * Контрольные точки — подписи «КМ n+mmm»: их положение на листе известно
 * из PDF, а на местности — из оси, построенной по ведомости. Преобразование
 * подобия (поворот, масштаб, сдвиг) переводит одно в другое.
 *
 * Простой МНК по всем точкам не работает: на листах есть врезки с увеличенными
 * фрагментами и подписи стыков листов, стоящие у края, а не на своём месте.
 * Такие точки уводят решение на километры. Поэтому RANSAC: подобие однозначно
 * задаётся парой точек, поэтому перебираются все пары, побеждает та, с которой
 * согласуется больше остальных, и уже по согласным считается окончательный МНК.
 */

/** Допуск согласия при отборе, м. */
const INLIER_M = 400;
/** Слишком короткая база даёт неустойчивое решение. */
const MIN_BASE = 50;

/**
 * @param {Array<{u:number,v:number,x:number,y:number}>} pts лист (u,v) → местность (x,y)
 */
function leastSquares(pts) {
  const n = pts.length;
  const mu = pts.reduce((a, p) => a + p.u, 0) / n;
  const mv = pts.reduce((a, p) => a + p.v, 0) / n;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;

  // Подобие в комплексной форме: (x+iy) = (a+ib)(u+iv) + t. Решается в лоб.
  let re = 0;
  let im = 0;
  let den = 0;
  for (const p of pts) {
    const u = p.u - mu;
    const v = p.v - mv;
    re += u * (p.x - mx) + v * (p.y - my);
    im += u * (p.y - my) - v * (p.x - mx);
    den += u * u + v * v;
  }
  const a = re / den;
  const b = im / den;
  return {
    scale: Math.hypot(a, b),
    at: (u, v) => ({ x: a * (u - mu) - b * (v - mv) + mx, y: b * (u - mu) + a * (v - mv) + my }),
  };
}

const errorOf = (T, p) => {
  const q = T.at(p.u, p.v);
  return Math.hypot(q.x - p.x, q.y - p.y);
};

export function georeference(pts) {
  if (pts.length < 4) throw new Error(`Мало контрольных точек: ${pts.length}`);

  let best = { inliers: [] };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].u - pts[j].u, pts[i].v - pts[j].v) < MIN_BASE) continue;
      const T = leastSquares([pts[i], pts[j]]);
      const inliers = pts.filter((p) => errorOf(T, p) < INLIER_M);
      if (inliers.length > best.inliers.length) best = { inliers };
    }
  }
  if (best.inliers.length < 4) throw new Error('Не нашлось согласованного набора точек');

  // Уточнение: пересчитать по согласным, пересобрать согласных, повторить.
  let T = leastSquares(best.inliers);
  for (let k = 0; k < 4; k++) {
    const inliers = pts.filter((p) => errorOf(T, p) < INLIER_M);
    if (inliers.length < 4) break;
    best.inliers = inliers;
    T = leastSquares(inliers);
  }

  const res = best.inliers.map((p) => errorOf(T, p)).sort((a, b) => a - b);
  return {
    at: T.at,
    scale: T.scale,
    used: best.inliers.length,
    total: pts.length,
    median: res[res.length >> 1],
    p90: res[Math.floor(res.length * 0.9)],
    max: res[res.length - 1],
  };
}
