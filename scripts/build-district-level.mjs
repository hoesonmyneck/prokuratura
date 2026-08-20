/**
 * Непересекающийся слой единиц районного уровня по всему Казахстану.
 *
 * Исходный `egkn:districts` для карты не годится по двум причинам.
 *
 * 1. В нём смешаны уровни. Кроме районов и городов областного значения там
 *    лежат города РАЙОННОГО значения (Щучинск, Акколь, Аксай — 44 записи),
 *    сёла и посёлки (Шантобе, Чапаев — 5 записей). Районного уровня они
 *    не образуют и просто дублируют территорию своего района.
 *
 * 2. Единицы перекрываются. Причин две: город областного значения лежит внутри
 *    контура окружающего района (Петропавловск в Кызылжарском, Косшы
 *    в Целиноградском), и реформа 2022 года — в слое остались и старый район,
 *    и выделенные из него новые (Урджарский вместе с Ақсуат и Мақаншы).
 *
 * ОТБОР УРОВНЯ идёт по КАТО, пятый разряд:
 *   0 — район                                     → берём
 *   1 — город областного значения либо район
 *       города республиканского значения          → берём
 *   2 — город районного значения                  → отбрасываем
 *   3, 4, 5 — село, посёлок                       → отбрасываем
 * Правило проверено на всех записях: разряд 0 — это ровно 171 «р-н»,
 * разряд 2 — ровно 44 «г.», смешения нет.
 *
 * СНЯТИЕ НАЛОЖЕНИЙ — вычитанием, от меньшего к большему. Единицы сортируются
 * по площади, и из каждой вычитаются все меньшие, которые её задевают. Одна
 * операция закрывает оба случая: город остаётся целым, а район вокруг него
 * сокращается; новый район реформы остаётся целым, а старый теряет то, что
 * из него выделили. Ничего не додумывается — просто более мелкая единица
 * считается более поздней и точной.
 *
 * Координаты не упрощаются. Вершины остаются исходными; новые появляются
 * только на линиях реза, где контуры пересекались.
 *
 * Запуск: node --max-old-space-size=6144 scripts/build-district-level.mjs
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

/** Разряды КАТО, которые считаем районным уровнем. */
const LEVEL_DIGITS = new Set(['0', '1']);

/**
 * Обрезки мельче этого выбрасываются, кв. км. Там, где контуры соседей
 * расходятся на десятки метров, вычитание оставляет ленточки в сотые доли
 * километра — это мусор от несогласованности исходных данных, а не территория.
 * Порог намеренно низкий: настоящие единицы такого размера бывают (районы
 * в городах), и терять их нельзя.
 */
const SLIVER_KM2 = 0.05;

const source = JSON.parse(readFileSync(resolve(DIR, 'kz-districts.geojson'), 'utf8'));

const asPolygons = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** Площадь по формуле шнурков с поправкой на широту, кв. км. */
function areaKm2(polygons) {
  let total = 0;
  for (const poly of polygons) {
    for (let k = 0; k < poly.length; k++) {
      const ring = poly[k];
      if (ring.length < 4) continue;
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const kx = Math.cos((lat * Math.PI) / 180);
      let sum = 0;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        sum += ring[b][0] * kx * ring[a][1] - ring[a][0] * kx * ring[b][1];
      }
      // Первое кольцо — контур, остальные дырки.
      total += (k === 0 ? 1 : -1) * Math.abs(sum / 2);
    }
  }
  return total * 111.32 * 111.13;
}

function bboxOf(polygons) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygons) {
    for (const [x, y] of poly[0]) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b;
}

const overlapsBbox = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

function countPoints(coords) {
  let n = 0;
  const walk = (a) => {
    if (typeof a[0] === 'number') n += 1;
    else a.forEach(walk);
  };
  walk(coords);
  return n;
}

// ── Отбор районного уровня ──────────────────────────────────────────────────

const dropped = { sub: 0, noKato: 0 };
const units = [];

for (const f of source.features) {
  const kato = String(f.properties.kato ?? '');
  if (kato.length !== 9) {
    dropped.noKato += 1;
    continue;
  }
  if (!LEVEL_DIGITS.has(kato[4])) {
    dropped.sub += 1;
    continue;
  }
  const polygons = asPolygons(f.geometry);
  units.push({
    props: f.properties,
    kato,
    polygons,
    area: areaKm2(polygons),
    bbox: bboxOf(polygons),
  });
}

console.log(
  `Записей ${source.features.length} → районного уровня ${units.length}. ` +
    `Отброшено: ниже районного ${dropped.sub}, без КАТО ${dropped.noKato}.`,
);

// ── Дубли геометрии ─────────────────────────────────────────────────────────

/*
 * Новым единицам реформы 2022 года в ЕГКН записали контур родителя, а свой
 * не нарисовали: у «г. Семей» и «р-на Жаңасемей» геометрия совпадает
 * до квадратного километра, то же у «Урджарского» с «Мақаншы» и у столичных
 * «Алматы» с «Сарайшық». Настоящих послереформенных границ в источнике
 * не существует — вычислить их неоткуда.
 *
 * Оставляем одну запись на контур, иначе слой не будет непересекающимся.
 * Кого оставить, решаем по объективным признакам, а не по названию:
 *   1. КАТО должен соответствовать области, к которой единица приписана;
 *      у «Урджарского» префикс 63 — это дореформенная ВКО, а он числится
 *      в Абае. Такая запись проигрывает.
 *   2. Город областного значения выигрывает у района с тем же контуром:
 *      район, повторяющий город, — это район внутри города, уровнем ниже.
 *   3. При прочих равных — меньший КАТО, чтобы результат был воспроизводим.
 */
/*
 * Признаки «одна и та же территория под двумя записями»: площади отличаются
 * не больше чем на десятую часть И меньшая почти целиком лежит в большей.
 *
 * Сравнения одних площадей мало. У «р-на Арыс» и «г. Арыс» контуры совпадают
 * по существу, но площади расходятся на 0.8 % — при пороге по площади они
 * проходили как разные, и вычитание оставляло от города огрызок в 61 кв. км
 * вместо 7 571.
 */
const SAME_AREA_RATIO = 0.9;
const SAME_INSIDE = 0.9;

/** Точки внутри контура — по сетке в габарите. Вершины не годятся: они лежат
 *  на общей границе и проверка попадания на них срывается. */
function innerPoints(polygons, bbox, limit) {
  const out = [];
  const steps = 16;
  const inside = (p) =>
    polygons.some(
      (poly) => pointInRing(p, poly[0]) && !poly.slice(1).some((hole) => pointInRing(p, hole)),
    );
  for (let a = 1; a < steps && out.length < limit; a++) {
    for (let b = 1; b < steps && out.length < limit; b++) {
      const p = [
        bbox[0] + ((bbox[2] - bbox[0]) * a) / steps,
        bbox[1] + ((bbox[3] - bbox[1]) * b) / steps,
      ];
      if (inside(p)) out.push(p);
    }
  }
  return out;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function containedIn(small, large) {
  const pts = innerPoints(small.polygons, small.bbox, 40);
  if (!pts.length) return 0;
  const hit = pts.filter((p) =>
    large.polygons.some(
      (poly) => pointInRing(p, poly[0]) && !poly.slice(1).some((hole) => pointInRing(p, hole)),
    ),
  ).length;
  return hit / pts.length;
}

const katoPrefix = new Map();
for (const u of units) {
  const p = u.kato.slice(0, 2);
  katoPrefix.set(u.props.regionCode, (katoPrefix.get(u.props.regionCode) ?? new Map()).set(p, ((katoPrefix.get(u.props.regionCode)?.get(p)) ?? 0) + 1));
}
/** Какой префикс КАТО у области на самом деле — берём самый частый. */
const regionPrefix = new Map(
  [...katoPrefix].map(([code, counts]) => [code, [...counts].sort((a, b) => b[1] - a[1])[0][0]]),
);

const better = (a, b) => {
  const fitA = a.kato.slice(0, 2) === regionPrefix.get(a.props.regionCode);
  const fitB = b.kato.slice(0, 2) === regionPrefix.get(b.props.regionCode);
  if (fitA !== fitB) return fitA ? a : b;
  const cityA = a.props.type === 'г.';
  const cityB = b.props.type === 'г.';
  if (cityA !== cityB) return cityA ? a : b;
  return a.kato <= b.kato ? a : b;
};

const duplicates = [];
const removed = new Set();
for (let a = 0; a < units.length; a++) {
  if (removed.has(a)) continue;
  for (let b = a + 1; b < units.length; b++) {
    if (removed.has(b)) continue;
    const u = units[a];
    const v = units[b];
    if (!overlapsBbox(u.bbox, v.bbox)) continue;
    const ratio = Math.min(u.area, v.area) / Math.max(u.area, v.area);
    if (ratio < SAME_AREA_RATIO) continue;
    const [small, large] = u.area <= v.area ? [u, v] : [v, u];
    if (containedIn(small, large) < SAME_INSIDE) continue;
    const keep = better(u, v);
    const drop = keep === u ? v : u;
    removed.add(keep === u ? b : a);
    duplicates.push({ keep: keep.props.name, drop: drop.props.name, area: drop.area });
    if (drop === u) break;
  }
}

if (duplicates.length) {
  console.log(`\nОдин контур на несколько записей — оставлена одна (${duplicates.length}):`);
  for (const d of duplicates) {
    console.log(`  ${d.keep.padEnd(24)} ← убрано «${d.drop}» (${d.area.toFixed(0)} кв. км, тот же контур)`);
  }
  console.log('  Настоящих послереформенных границ этих единиц в ЕГКН нет.\n');
}

const kept = units.filter((_, k) => !removed.has(k));
units.length = 0;
units.push(...kept);

// ── Снятие наложений ────────────────────────────────────────────────────────

// От большего к меньшему: из каждой единицы вычитаем все меньшие, что её задевают.
units.sort((a, b) => b.area - a.area);

const features = [];
let cut = 0;
let slivers = 0;
let sliverArea = 0;
let pointsBefore = 0;
let pointsAfter = 0;

for (let n = 0; n < units.length; n++) {
  const u = units[n];
  pointsBefore += countPoints(u.polygons);

  const smaller = units.slice(n + 1).filter((v) => overlapsBbox(u.bbox, v.bbox));
  let geometry = u.polygons;
  if (smaller.length) {
    const result = polygonClipping.difference(geometry, ...smaller.map((v) => v.polygons));
    // Вычитание может съесть единицу целиком, если её территория вся
    // разошлась по более мелким. Такого быть не должно — оставляем исходную
    // и сообщаем, чтобы это не прошло молча.
    if (!result.length) {
      console.warn(`  ! ${u.props.name}: вычитание съело единицу целиком, оставлена как есть`);
    } else if (Math.abs(areaKm2(result) - u.area) > 0.01) {
      geometry = result;
      cut += 1;
    }
  }

  const kept = geometry.filter((poly) => {
    const a = areaKm2([poly]);
    if (a >= SLIVER_KM2) return true;
    slivers += 1;
    sliverArea += a;
    return false;
  });
  const final = kept.length ? kept : geometry;

  pointsAfter += countPoints(final);
  features.push({
    type: 'Feature',
    id: u.props.code,
    properties: {
      code: u.props.code,
      name: u.props.name,
      nameKz: u.props.nameKz,
      region: u.props.region,
      regionCode: u.props.regionCode,
      kato: u.kato,
      // Разряд 1 у «р-н» — это район города республиканского значения.
      level: u.kato[4] === '1' && u.props.type === 'г.' ? 'city' : 'district',
      areaKm2: Math.round(areaKm2(final)),
    },
    geometry: { type: 'MultiPolygon', coordinates: final },
  });
}

features.sort((a, b) => a.properties.code.localeCompare(b.properties.code));

const out = resolve(DIR, 'kz-district-level.geojson');
const text = JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(out, `${text}\n`);

const totalArea = features.reduce((s, f) => s + f.properties.areaKm2, 0);
console.log(`Урезано наложениями: ${cut} единиц.`);
console.log(`Выброшено обрезков мельче ${SLIVER_KM2} кв. км: ${slivers} (${sliverArea.toFixed(2)} кв. км).`);
console.log(`Точек ${pointsBefore.toLocaleString('ru-RU')} → ${pointsAfter.toLocaleString('ru-RU')}.`);
console.log(`Суммарная площадь: ${(totalArea / 1000).toFixed(0)} тыс. кв. км (у Казахстана 2 725).`);
console.log(`\nЗаписано: ${out} (${(Buffer.byteLength(text) / 1024 / 1024).toFixed(1)} МБ)`);
