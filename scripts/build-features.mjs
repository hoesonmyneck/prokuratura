/**
 * Постановка обозначений на карту по пикетажу.
 *
 * Вход — `features-chainage.json` от `extract-features.py`: тип объекта
 * и расстояние от начала трассы. Выход — точки в WGS-84 на оси, построенной
 * по ведомости той же математикой, что и сама трасса (`lib/axis.mjs`).
 *
 * Привязка чертежа к местности не нужна: пикетаж — это и есть положение
 * на оси. Поэтому обозначения стоят настолько же точно, насколько точна ось,
 * а не настолько, насколько аккуратно нарисован лист.
 *
 * Подписи на чертеже отмечают границы: у площадки отдыха их две, у развязки
 * несколько. Близкие отметки одного типа собираются в один объект, точка
 * ставится посередине, а границы сохраняются для попапа.
 *
 * Запуск: node scripts/build-features.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAxis, pointAt, toWgs } from './lib/axis.mjs';
import { georeference } from './lib/georef.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Насколько близкие отметки считаем одним объектом, м.
 * Площадки отдыха размечены парами границ с разбегом 1.8-2.2 км, развязки —
 * несколькими отметками в пределах пары километров. Переходы земляного
 * полотна и границы очередей — самостоятельные точки, их сливать нельзя.
 */
const KINDS = {
  rest: { title: 'Площадка отдыха', short: 'Площадка отдыха', gap: 2500, major: true },
  interchange: { title: 'Транспортная развязка', short: 'Развязка', gap: 2500, major: true },
  roadbed: { title: 'Переход земляного полотна', short: 'Земполотно', gap: 300, major: false },
  stage: { title: 'Граница очереди строительства', short: 'Очередь', gap: 0, major: true },
};

const axis = JSON.parse(
  readFileSync(resolve(ROOT, 'src/data/axis-kyzylorda-saksaulsk.json'), 'utf8'),
);
const raw = JSON.parse(readFileSync(resolve(HERE, 'features-chainage.json'), 'utf8'));

const { points } = buildAxis(axis);
const totalStation = points[points.length - 1].s;

/** «30+058» — так пикетаж подписан на чертеже. */
const km = (station) => `${Math.floor(station / 1000)}+${String(station % 1000).padStart(3, '0')}`;

const clusters = [];
for (const [kind, cfg] of Object.entries(KINDS)) {
  const stations = raw.features
    .filter((f) => f.kind === kind)
    .map((f) => f.station)
    .sort((a, b) => a - b);

  let group = [];
  const flush = () => {
    if (!group.length) return;
    clusters.push({ kind, cfg, from: group[0], to: group[group.length - 1] });
    group = [];
  };
  for (const s of stations) {
    if (group.length && s - group[group.length - 1] > cfg.gap) flush();
    group.push(s);
  }
  flush();
}

clusters.sort((a, b) => a.from - b.from);

const features = [];
for (const c of clusters) {
  const mid = (c.from + c.to) / 2;
  if (mid > totalStation) {
    console.warn(`Пропущено: ${c.cfg.title} на КМ ${km(c.from)} — за концом трассы`);
    continue;
  }
  features.push({
    type: 'Feature',
    properties: {
      kind: c.kind,
      title: c.cfg.title,
      short: c.cfg.short,
      major: c.cfg.major,
      // Одна отметка — точка, несколько — участок с границами.
      station: c.from === c.to ? `КМ ${km(c.from)}` : `КМ ${km(c.from)} - ${km(c.to)}`,
      lengthM: c.to - c.from,
    },
    geometry: { type: 'Point', coordinates: toWgs(pointAt(points, mid)) },
  });
}

// ── Знаки с чертежа ─────────────────────────────────────────────────────────

/*
 * Объекты без пикетажа берутся с рисунка: лист привязывается к местности
 * по подписям «КМ n+mmm», знак пересчитывается из координат листа.
 *
 * Точность у них ниже, чем у объектов с пикетажем, — это положение по чертежу,
 * а не по геодезии. Для карты мониторинга такого смещения достаточно: значок
 * показывает, что объект здесь есть, а не где именно стоит колонка.
 */
const SYMBOL_KINDS = {
  service: { title: 'АЗС и сервисы', short: 'АЗС', major: true },
  crossing: { title: 'Скотопрогон или проезд сельхозтехники', short: 'Скотопрогон', major: false },
};

/** Один объект попадает на два листа: считаем одним, если ближе этого, м. */
const SAME_OBJECT_M = 900;

/**
 * Дальше этого от трассы знака быть не может, м. Отсекает блок «Условные
 * обозначения»: он есть на каждом листе, и его образцы — такие же цветные
 * кружки, как на карте.
 */
const MAX_OFFSET_M = 8000;

/** Ближайшая точка оси к произвольной точке плоскости. */
function snapToAxis(p) {
  let best = points[0];
  let bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy, s: a.s + t * (b.s - a.s) };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

const sheets = JSON.parse(readFileSync(resolve(HERE, 'symbols-sheet.json'), 'utf8'));
const placed = [];
const restFromSheet = [];
let skipped = 0;

for (const sheet of sheets.sheets) {
  const control = sheet.control.map((c) => ({ u: c.x, v: c.y, ...pointAt(points, c.station) }));
  const T = georeference(control);
  console.log(
    `\n${sheet.sheet}: привязка по ${T.used} из ${T.total} точек, ` +
      `масштаб ${T.scale.toFixed(1)} м/ед., невязка: медиана ${T.median.toFixed(0)} м, ` +
      `90 % ${T.p90.toFixed(0)} м, макс ${T.max.toFixed(0)} м`,
  );

  for (const s of sheet.symbols) {
    // Знак на чертеже вынесен в сторону от дороги и соединён с ней выноской,
    // поэтому его центр стоит в километрах от трассы. Все эти объекты
    // придорожные, так что сажаем знак на ось: поперечное смещение уходит
    // целиком, остаётся только продольное.
    const raw = T.at(s.x, s.y);
    const at = snapToAxis(raw);
    if (Math.hypot(raw.x - at.x, raw.y - at.y) > MAX_OFFSET_M) {
      skipped += 1;
      continue;
    }
    // Площадки отдыха уже стоят по пикетажу — точнее. Здесь они нужны
    // только для проверки: сравним два способа между собой.
    if (s.kind === 'rest') restFromSheet.push(at);
    else if (SYMBOL_KINDS[s.kind]) placed.push({ kind: s.kind, ...at });
  }
}

const merged = [];
for (const p of placed) {
  const twin = merged.find(
    (m) => m.kind === p.kind && Math.hypot(m.x - p.x, m.y - p.y) < SAME_OBJECT_M,
  );
  if (twin) {
    // Среднее по листам: объект виден на обоих, привязки чуть разные.
    twin.x = (twin.x * twin.n + p.x) / (twin.n + 1);
    twin.y = (twin.y * twin.n + p.y) / (twin.n + 1);
    twin.n += 1;
  } else merged.push({ ...p, n: 1 });
}

for (const m of merged) {
  const cfg = SYMBOL_KINDS[m.kind];
  features.push({
    type: 'Feature',
    properties: { kind: m.kind, title: cfg.title, short: cfg.short, major: cfg.major },
    geometry: { type: 'Point', coordinates: toWgs(m) },
  });
}

if (skipped) console.log(`
Отброшено знаков вдали от трассы (легенда листов): ${skipped}`);

// Проверка привязки: площадки отдыха известны обоими способами.
if (restFromSheet.length) {
  const exact = clusters
    .filter((c) => c.kind === 'rest')
    .map((c) => pointAt(points, (c.from + c.to) / 2));
  const diffs = restFromSheet
    .map((p) => Math.min(...exact.map((e) => Math.hypot(e.x - p.x, e.y - p.y))))
    .sort((a, b) => a - b);
  console.log(
    `\nСверка: площадки отдыха известны и по пикетажу, и по рисунку. ` +
      `Расхождение между способами: медиана ${diffs[diffs.length >> 1].toFixed(0)} м, ` +
      `макс ${diffs[diffs.length - 1].toFixed(0)} м`,
  );
}

const fc = { type: 'FeatureCollection', features };
const out = resolve(ROOT, 'src/data/road-features.json');
writeFileSync(out, `${JSON.stringify(fc, null, 1)}\n`);

const counts = {};
for (const f of features) counts[f.properties.kind] = (counts[f.properties.kind] ?? 0) + 1;
console.log(`Отметок на чертеже: ${raw.features.length} → объектов: ${features.length}`);
for (const [kind, cfg] of Object.entries({ ...KINDS, ...SYMBOL_KINDS })) {
  console.log(`  ${cfg.title.padEnd(38)} ${counts[kind] ?? 0}`);
}
console.log(`\nЗаписано: ${out}`);
