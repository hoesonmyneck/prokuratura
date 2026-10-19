/**
 * Подмена настоящей оси и обозначений на моковые — для публичного показа.
 *
 * Плечо «Кызылорда — Саксаульск» построено по ведомости углов поворота и сходится
 * с ней до метра, а обозначения на нём стоят по пикетажу с чертежей. И ось,
 * и пикетаж — проектная документация, в открытый доступ ей нельзя. Скрипт
 * заменяет их на схематичные: такие же, как два других плеча, которые нарисованы
 * на глаз.
 *
 * Что именно скрывается:
 *   • геодезическая ось — 2535 точек с точностью до метра превращаются
 *     в ломаную из 55 вершин с шагом округления 100 м;
 *   • пикетаж объектов — «КМ 28+898 - 30+777» сдвигается вдоль трассы
 *     и округляется до 100 м, так что исходную отметку из него не достать.
 *
 * Что намеренно сохраняется:
 *   • начало и конец плеча — к концу сведены хвосты двух других плеч
 *     (`join-schematic.mjs`), сдвинь его, и на карте снова появится разрыв;
 *   • коридор трассы — моковая линия гуляет в пределах 1,2 км от настоящей.
 *     Иначе она разойдётся с полосой кадастровых участков: та выгружена вдоль
 *     оси и сама обводит коридор с точностью около 1-2 км. Увести линию
 *     в сторону, не перевыгрузив кадастр, — значит показать на карте участки
 *     одной трассы и линию другой;
 *   • число объектов каждого типа, паспортные длины плеч и подписи — это
 *     сводные цифры из конкурсной документации, не геодезия.
 *
 * Настоящие данные нигде не копируются и не удаляются: они пересобираются
 * из ведомости `axis-kyzylorda-saksaulsk.json` и пикетажа `features-chainage.json`
 * теми же скриптами, что и в первый раз. Отсюда и восстановление одной командой.
 *
 * Запуск:
 *   node scripts/mock-road.mjs             # подменить на моковые
 *   node scripts/mock-road.mjs --dry       # посчитать и показать, не записывая
 *   node scripts/mock-road.mjs --restore   # вернуть настоящие
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SEGMENTS_FILE = resolve(ROOT, 'src/data/road-segments.json');
const FEATURES_FILE = resolve(ROOT, 'src/data/road-features.json');
const STATE_FILE = resolve(ROOT, 'src/data/data-state.json');

/** Плечо с настоящей геодезией — единственное, что подменяем. */
const REAL = 'kyzylorda-saksaulsk';

/**
 * Сколько вершин оставить в моковой оси — звенья примерно по 8,4 км.
 *
 * Снизу предел ставит не красота, а полоса кадастра: трасса круто гнётся
 * на КМ 166 и КМ 334 (поворот на 63° и 66°), и на 26 вершинах хорда срезает
 * такой изгиб на 4,6 км — линия уходит из полосы участков. На 55 вершинах
 * срез не больше 2,2 км. Сверху предел — смысл затеи: чем больше вершин,
 * тем ближе линия к настоящей.
 */
const TARGET_VERTICES = 55;

/**
 * Насколько моковая линия отходит от настоящей, км.
 *
 * Снизу предел ставит смысл затеи: сдвиг должен быть заметно больше точности
 * ведомости, иначе подмена ничего не скрывает. Сверху — полоса кадастра
 * шириной около 1-2 км: за её краем линия повиснет рядом с участками, а не
 * среди них.
 */
const WOBBLE_KM = 1.8;

/** На сколько сдвигаются объекты вдоль трассы, км. */
const SHIFT_KM = 3;

/** До чего округляется пикетаж в подписях, м. */
const STATION_STEP = 100;

const KM_PER_DEG_LAT = 111.13;
const KM_PER_DEG_LNG_EQ = 111.32;

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** «30+058» — так пикетаж подписан на чертеже. */
const km = (m) => `${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, '0')}`;
const kmPerDegLng = (lat) => KM_PER_DEG_LNG_EQ * Math.cos(rad(lat));
const round3 = (v) => Math.round(v * 1e3) / 1e3;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function distanceKm(a, b) {
  const midLat = (a[1] + b[1]) / 2;
  return Math.hypot((b[0] - a[0]) * kmPerDegLng(midLat), (b[1] - a[1]) * KM_PER_DEG_LAT);
}

/**
 * Генератор с зафиксированным зерном: моковые данные должны получаться
 * одинаковыми при каждом запуске, иначе каждый пересбор будет давать новый
 * диф на пол-файла.
 */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Восстановление ──────────────────────────────────────────────────────────

if (process.argv.includes('--restore')) {
  // Ось и обозначения пересобираются из ведомости и пикетажа. Стыковку хвостов
  // гонять не нужно: моковая ось кончается там же, где настоящая.
  for (const script of ['build-axis.mjs', 'build-features.mjs']) {
    console.log(`\n── node scripts/${script}`);
    const res = spawnSync(process.execPath, [resolve(HERE, script)], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`\n${script} завершился с ошибкой. Данные могли остаться моковыми.`);
      process.exit(1);
    }
  }
  writeState('real');
  console.log('\nНастоящие данные восстановлены.');
  process.exit(0);
}

const DRY = process.argv.includes('--dry');

// ── Проверка состояния ──────────────────────────────────────────────────────

const state = readState();
if (state === 'mock') {
  console.log(
    'Данные уже моковые — повторная подмена накрутила бы искажение второй раз.\n' +
      'Сначала верните настоящие: node scripts/mock-road.mjs --restore',
  );
  process.exit(0);
}

// ── Ось ─────────────────────────────────────────────────────────────────────

const segments = JSON.parse(readFileSync(SEGMENTS_FILE, 'utf8'));
const segment = segments.find((s) => s.id === REAL);
if (!segment) throw new Error(`Не найдено плечо ${REAL}`);

const realPath = segment.path;
const mockPath = wobble(resample(realPath, TARGET_VERTICES));

console.log(`Ось ${segment.name}`);
console.log(`  вершин: ${realPath.length} → ${mockPath.length}`);
console.log(`  длина: ${pathLengthKm(realPath).toFixed(1)} → ${pathLengthKm(mockPath).toFixed(1)} км`);
const spread = deviationKm(realPath, mockPath);
console.log(
  `  отход от настоящей: медиана ${spread.median.toFixed(2)} км, максимум ${spread.max.toFixed(2)} км`,
);

/**
 * Пересборка ломаной равными шагами по длине.
 *
 * Сначала тут стоял Дугласа — Пекера, и это была ошибка: он ставит вершины
 * там, где трасса гнётся, поэтому рядом с поворотом звенья получаются по два
 * километра. Перпендикулярный сдвиг такой же величины ломает на них линию
 * на 30-70°, и на карте вместо дороги выходит зигзаг. Равный шаг держит
 * звенья длиннее сдвига, и излом остаётся в тех же пределах, что у двух
 * схематичных плеч.
 */
function resample(path, count) {
  const run = runningKm(path);
  const out = [path[0]];
  for (let i = 1; i < count - 1; i++) {
    out.push(pointOn(path, run, (i / (count - 1)) * run.total));
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Точка на ломаной в заданной длине от начала. */
function pointOn(path, run, target) {
  for (let i = 1; i < path.length; i++) {
    if (run.at[i] < target) continue;
    const span = run.at[i] - run.at[i - 1];
    const t = span ? (target - run.at[i - 1]) / span : 0;
    const a = path[i - 1];
    const b = path[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return path[path.length - 1].slice();
}

/**
 * Разводит вершины в стороны от настоящей оси.
 *
 * Сдвиг — сумма трёх синусоид по длине трассы, а не случайный шум на каждой
 * вершине: случайный дал бы пилу, которую на карте видно как дрожь линии.
 * По той же причине самая частая гармоника длиннее звена: уложи её в полтора
 * звена, и сдвиг успеет сменить знак между соседними вершинами — снова излом.
 * К обоим концам сдвиг сходит в ноль — концы остаются настоящими.
 */
function wobble(path) {
  const last = path.length - 1;
  const total = pathLengthKm(path);
  let run = 0;

  return path.map((p, i) => {
    if (i === 0 || i === last) return [round6(p[0]), round6(p[1])];
    run += distanceKm(path[i - 1], p);
    const t = total ? run / total : 0;

    const amount =
      WOBBLE_KM *
      Math.sin(Math.PI * t) *
      (0.6 * Math.sin(2 * Math.PI * 1.7 * t + 0.6) +
        0.3 * Math.sin(2 * Math.PI * 3.1 * t + 2.1) +
        0.1 * Math.sin(2 * Math.PI * 4.9 * t + 4.2));

    // Нормаль к направлению трассы в этой вершине, в километрах.
    const a = path[i - 1];
    const b = path[i + 1];
    const dx = (b[0] - a[0]) * kmPerDegLng(p[1]);
    const dy = (b[1] - a[1]) * KM_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [round3(p[0]), round3(p[1])];

    return [
      round3(p[0] + ((-dy / len) * amount) / kmPerDegLng(p[1])),
      round3(p[1] + ((dx / len) * amount) / KM_PER_DEG_LAT),
    ];
  });
}

function pathLengthKm(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += distanceKm(path[i - 1], path[i]);
  return sum;
}

/** Насколько моковая линия отошла от настоящей — контроль, что не вылезли из полосы. */
function deviationKm(from, to) {
  const all = from.map((p) => {
    let best = Infinity;
    for (let i = 1; i < to.length; i++) {
      const q = projectKm(p, to[i - 1], to[i]);
      if (q.d < best) best = q.d;
    }
    return best;
  });
  all.sort((a, b) => a - b);
  return { median: all[all.length >> 1], max: all[all.length - 1] };
}

/** Проекция точки на звено: расстояние в км и доля вдоль звена. */
function projectKm(p, a, b) {
  const lat = p[1];
  const ax = a[0] * kmPerDegLng(lat);
  const ay = a[1] * KM_PER_DEG_LAT;
  const bx = b[0] * kmPerDegLng(lat);
  const by = b[1] * KM_PER_DEG_LAT;
  const px = p[0] * kmPerDegLng(lat);
  const py = p[1] * KM_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

// ── Обозначения ─────────────────────────────────────────────────────────────

const featureCollection = JSON.parse(readFileSync(FEATURES_FILE, 'utf8'));

/** Паспортная длина плеча, м: от неё отсчитывается пикетаж в подписях. */
const TOTAL_M = segment.lengthKm * 1000;

const realRun = runningKm(realPath);
const mockRun = runningKm(mockPath);
const random = rng(20260419);

const mockFeatures = featureCollection.features.map((f) => {
  const props = { ...f.properties };
  const shiftM = (random() * 2 - 1) * SHIFT_KM * 1000;

  let fraction;
  if (typeof props.station === 'string') {
    // Объект с пикетажем: подпись и есть положение, её и сдвигаем.
    const span = parseStation(props.station);
    const half = (span.to - span.from) / 2;
    const mid = clamp((span.from + span.to) / 2 + shiftM, half, TOTAL_M - half);
    const from = Math.round((mid - half) / STATION_STEP) * STATION_STEP;
    const to = Math.round((mid + half) / STATION_STEP) * STATION_STEP;
    props.station = from === to ? `КМ ${km(from)}` : `КМ ${km(from)} - ${km(to)}`;
    props.lengthM = to - from;
    fraction = mid / TOTAL_M;
  } else {
    // Знак с чертежа: пикетажа у него нет, положение берём с настоящей оси.
    fraction = clamp(alongFraction(f.geometry.coordinates) + shiftM / 1000 / realRun.total, 0, 1);
  }

  return { ...f, properties: props, geometry: { type: 'Point', coordinates: pointAt(fraction) } };
});

const withStation = mockFeatures.filter((f) => typeof f.properties.station === 'string').length;
console.log(`\nОбозначений: ${mockFeatures.length}`);
console.log(`  с пикетажем (сдвинут и округлён до ${STATION_STEP} м): ${withStation}`);
console.log(`  со знака чертежа (сдвинуты вдоль трассы): ${mockFeatures.length - withStation}`);
console.log(`  сдвиг вдоль трассы: до ±${SHIFT_KM} км`);

/** «КМ 28+898 - 30+777» → метры от начала трассы. */
function parseStation(text) {
  const found = [...text.matchAll(/(\d+)\+(\d+(?:\.\d+)?)/g)].map(
    (m) => Number(m[1]) * 1000 + Number(m[2]),
  );
  if (!found.length) throw new Error(`Не разобран пикетаж: ${text}`);
  return { from: Math.round(found[0]), to: Math.round(found[found.length - 1]) };
}

/** Нарастающая длина по вершинам — по ней ищется точка на доле пути. */
function runningKm(path) {
  const at = [0];
  for (let i = 1; i < path.length; i++) at.push(at[i - 1] + distanceKm(path[i - 1], path[i]));
  return { at, total: at[at.length - 1] };
}

/** Где на настоящей оси стоит точка, в долях её длины. */
function alongFraction(point) {
  let best = Infinity;
  let run = 0;
  for (let i = 1; i < realPath.length; i++) {
    const q = projectKm(point, realPath[i - 1], realPath[i]);
    if (q.d < best) {
      best = q.d;
      run = realRun.at[i - 1] + q.t * (realRun.at[i] - realRun.at[i - 1]);
    }
  }
  return realRun.total ? run / realRun.total : 0;
}

/** Точка на моковой оси по доле её длины. */
function pointAt(fraction) {
  const target = clamp(fraction, 0, 1) * mockRun.total;
  for (let i = 1; i < mockPath.length; i++) {
    if (mockRun.at[i] < target) continue;
    const span = mockRun.at[i] - mockRun.at[i - 1];
    const t = span ? (target - mockRun.at[i - 1]) / span : 0;
    const a = mockPath[i - 1];
    const b = mockPath[i];
    return [round6(a[0] + (b[0] - a[0]) * t), round6(a[1] + (b[1] - a[1]) * t)];
  }
  return mockPath[mockPath.length - 1].slice();
}

// ── Запись ──────────────────────────────────────────────────────────────────

if (DRY) {
  console.log('\n--dry: ничего не записано.');
  process.exit(0);
}

segment.path = mockPath;
writeFileSync(SEGMENTS_FILE, `${JSON.stringify(segments, null, 2)}\n`);

featureCollection.features = mockFeatures;
writeFileSync(FEATURES_FILE, `${JSON.stringify(featureCollection, null, 1)}\n`);

writeState('mock');

console.log(`\nЗаписано:\n  ${SEGMENTS_FILE}\n  ${FEATURES_FILE}\n  ${STATE_FILE}`);
console.log('\nВернуть настоящие: node scripts/mock-road.mjs --restore');

// ── Отметка о состоянии ─────────────────────────────────────────────────────

/*
 * Файл-отметка нужен по двум причинам. Во-первых, по виду JSON не скажешь,
 * моковый он или настоящий, — а спутать их на карте мониторинга дорого.
 * Во-вторых, по ней скрипт отказывается подменять данные второй раз.
 * Приложение этот файл не импортирует, в сборку он не попадает.
 */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')).state ?? 'real';
  } catch {
    return 'real';
  }
}

function writeState(value) {
  const body =
    value === 'mock'
      ? {
          state: 'mock',
          generated: new Date().toISOString().slice(0, 10),
          why: 'Публичный показ: ось по ведомости и пикетаж объектов — проектная документация.',
          mocked: [
            `src/data/road-segments.json — плечо ${REAL}`,
            'src/data/road-features.json — все обозначения',
          ],
          intact: [
            'public/cadastre.geojson, src/data/{regions,districts,quarries,contracts}.json — открытые данные',
            `src/data/road-segments.json — два схематичных плеча, они и так нарисованы на глаз`,
          ],
          restore: 'node scripts/mock-road.mjs --restore',
        }
      : {
          state: 'real',
          generated: new Date().toISOString().slice(0, 10),
          why: 'Ось собрана по ведомости углов поворота, обозначения — по пикетажу чертежей.',
          mock: 'node scripts/mock-road.mjs',
        };
  writeFileSync(STATE_FILE, `${JSON.stringify(body, null, 2)}\n`);
}
