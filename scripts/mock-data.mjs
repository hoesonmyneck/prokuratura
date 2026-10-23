/**
 * Подмена закрытых данных на моковые — для публичного показа.
 *
 * Карта собрана из источников разной степени открытости, и в публичную сборку
 * можно не всё. Этот скрипт разводит одно с другим: подменяет закрытое,
 * не трогает открытое и умеет вернуть всё обратно одной командой.
 *
 * ПОДМЕНЯЕТСЯ
 *   • ось плеча «Кызылорда — Саксаульск» и обозначения на ней — проектная
 *     документация: ось собрана по ведомости углов поворота и сходится с ней
 *     до метра, объекты стоят по пикетажу с чертежей;
 *   • карьеры и контрактные месторождения — ведомости недропользования:
 *     недропользователи, БИН, номера и сроки контрактов, запасы, протоколы МКЗ
 *     и контуры участков.
 *
 * НЕ ПОДМЕНЯЕТСЯ
 *   • кадастровые участки, границы областей и районов, населённые пункты —
 *     открытые данные ЕГКН;
 *   • два схематичных плеча трассы — они и так нарисованы на глаз.
 *
 * Настоящие данные никуда не копируются и не удаляются: они пересобираются
 * из исходных ведомостей теми же скриптами, что и в первый раз, и получаются
 * байт в байт теми же. Отсюда и восстановление одной командой.
 *
 * Запуск:
 *   node scripts/mock-data.mjs             # подменить на моковые
 *   node scripts/mock-data.mjs --dry       # посчитать и показать, не записывая
 *   node scripts/mock-data.mjs --restore   # вернуть настоящие
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SEGMENTS_FILE = resolve(ROOT, 'src/data/road-segments.json');
const FEATURES_FILE = resolve(ROOT, 'src/data/road-features.json');
const CONTRACTS_FILE = resolve(ROOT, 'src/data/contracts.json');
const QUARRIES_FILE = resolve(ROOT, 'src/data/quarries.json');
const PROGRESS_FILE = resolve(ROOT, 'src/data/road-progress.json');
const STATE_FILE = resolve(ROOT, 'src/data/data-state.json');

/**
 * Куда прячутся настоящие паспортные данные на время показа.
 *
 * Ось и месторождения пересобираются из ведомостей, а названия плеч,
 * протяжённость, техническая категория и ход строительства не берутся ниоткуда:
 * они правятся руками прямо в JSON. Восстанавливать их не из чего, поэтому
 * перед подменой они складываются сюда. Папка `private/` в `.gitignore`:
 * класть настоящие цифры обратно в репозиторий, который от них и прячут,
 * смысла нет.
 */
const PASSPORT_FILE = resolve(ROOT, 'private/passport.json');

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

/**
 * На сколько уезжает контур месторождения, км.
 *
 * Привязки к границам районов тут нет: в `districts.json` лежат только двенадцать
 * районов вдоль трассы, а контракты раскиданы по всей области, и проверить
 * попадание в свой район не по чему. Поэтому сдвиг держим заметно меньше
 * размеров района — десятки километров, — чтобы «Район» в попапе не разошёлся
 * с тем, где точка нарисована.
 */
const DEPOSIT_SHIFT_KM = [5, 15];

/** Во сколько раз меняется размер контура: площадь уезжает как квадрат этого. */
const DEPOSIT_SCALE = [0.9, 1.1];

/** Во сколько раз меняются запасы в ведомости карьеров. */
const RESERVE_SCALE = [0.85, 1.15];

/** Насколько уезжает паспортная протяжённость плеча. Округляем до десятков км. */
const LENGTH_SCALE = [0.88, 1.14];

/** Какую долю плеча показываем построенной. */
const DONE_SHARE = [0.05, 0.16];

const KM_PER_DEG_LAT = 111.13;
const KM_PER_DEG_LNG_EQ = 111.32;

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** «30+058» — так пикетаж подписан на чертеже. */
const km = (m) => `${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, '0')}`;
const kmPerDegLng = (lat) => KM_PER_DEG_LNG_EQ * Math.cos(rad(lat));
const round1 = (v) => Math.round(v * 10) / 10;
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

/** Случайное в диапазоне, заданном парой. */
const between = (random, [lo, hi]) => lo + random() * (hi - lo);

/** Нарастающая длина по вершинам — по ней ищется точка на доле пути. */
function runningKm(path) {
  const at = [0];
  for (let i = 1; i < path.length; i++) at.push(at[i - 1] + distanceKm(path[i - 1], path[i]));
  return { at, total: at[at.length - 1] };
}

function pathLengthKm(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += distanceKm(path[i - 1], path[i]);
  return sum;
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

// ── Ось трассы и обозначения на ней ─────────────────────────────────────────

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

/** «КМ 28+898 - 30+777» → метры от начала трассы. */
function parseStation(text) {
  const found = [...text.matchAll(/(\d+)\+(\d+(?:\.\d+)?)/g)].map(
    (m) => Number(m[1]) * 1000 + Number(m[2]),
  );
  if (!found.length) throw new Error(`Не разобран пикетаж: ${text}`);
  return { from: Math.round(found[0]), to: Math.round(found[found.length - 1]) };
}

function mockRoad(passport) {
  const segments = JSON.parse(readFileSync(SEGMENTS_FILE, 'utf8'));
  const segment = segments.find((s) => s.id === REAL);
  if (!segment) throw new Error(`Не найдено плечо ${REAL}`);

  const realPath = segment.path;
  const mockPath = wobble(resample(realPath, TARGET_VERTICES));

  console.log(`Ось ${segment.name}`);
  console.log(`  вершин: ${realPath.length} → ${mockPath.length}`);
  console.log(
    `  длина: ${pathLengthKm(realPath).toFixed(1)} → ${pathLengthKm(mockPath).toFixed(1)} км`,
  );
  const spread = deviationKm(realPath, mockPath);
  console.log(
    `  отход от настоящей: медиана ${spread.median.toFixed(2)} км, максимум ${spread.max.toFixed(2)} км`,
  );

  const featureCollection = JSON.parse(readFileSync(FEATURES_FILE, 'utf8'));

  /** Паспортная длина плеча, м: от неё отсчитывается пикетаж в подписях. */
  const TOTAL_M = segment.lengthKm * 1000;

  /**
   * Подписи пикетажа пересчитываются под моковую протяжённость плеча: иначе
   * на участке «420 км» висели бы объекты на «КМ 455». Положение на линии
   * от этого не зависит — оно по-прежнему считается от настоящей длины.
   */
  const stationScale = passport.mocked.find((s) => s.id === REAL).lengthKm / segment.lengthKm;

  const realRun = runningKm(realPath);
  const mockRun = runningKm(mockPath);
  const random = rng(20260419);

  /** Где на настоящей оси стоит точка, в долях её длины. */
  const alongFraction = (point) => {
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
  };

  /** Точка на моковой оси по доле её длины. */
  const pointAt = (fraction) => {
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
  };

  const mockFeatures = featureCollection.features.map((f) => {
    const props = { ...f.properties };
    const shiftM = (random() * 2 - 1) * SHIFT_KM * 1000;

    let fraction;
    if (typeof props.station === 'string') {
      // Объект с пикетажем: подпись и есть положение, её и сдвигаем.
      const span = parseStation(props.station);
      const half = (span.to - span.from) / 2;
      const mid = clamp((span.from + span.to) / 2 + shiftM, half, TOTAL_M - half);
      const from = Math.round(((mid - half) * stationScale) / STATION_STEP) * STATION_STEP;
      const to = Math.round(((mid + half) * stationScale) / STATION_STEP) * STATION_STEP;
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

  segment.path = mockPath;
  featureCollection.features = mockFeatures;

  for (const s of segments) {
    const m = passport.mocked.find((x) => x.id === s.id);
    Object.assign(s, { name: m.name, lengthKm: m.lengthKm, category: m.category });
  }

  return [
    [SEGMENTS_FILE, `${JSON.stringify(segments, null, 2)}\n`],
    [FEATURES_FILE, `${JSON.stringify(featureCollection, null, 1)}\n`],
  ];
}

// ── Паспорт трассы и ход строительства ──────────────────────────────────────

/*
 * Названия плеч не выдумываются похожими на настоящие: «Бейнеу — Саксаульск»
 * заменить на другую пару городов нельзя, потому что сами города на карте
 * остаются настоящими — подпись разошлась бы с тем, что видно. Поэтому плечи
 * просто нумеруются, как и месторождения.
 */
function mockPassport(segments, progress, random) {
  const real = {
    segments: segments.map(({ id, name, lengthKm, category }) => ({
      id,
      name,
      lengthKm,
      category,
    })),
    progress: { ...progress },
  };

  // Категорий всего две, поэтому перестановка по кругу оставила бы одно из двух
  // плеч с II при своей. Переворачиваем у каждого: ни одно не сохраняет настоящую.
  const mocked = segments.map((s, i) => ({
    ...s,
    name: `«Участок №${i + 1}»`,
    lengthKm: Math.round((s.lengthKm * between(random, LENGTH_SCALE)) / 10) * 10,
    category: s.category === 'I-б' ? 'II' : 'I-б',
  }));

  const mockedProgress = {};
  for (const s of mocked) {
    mockedProgress[s.id] = Math.round((s.lengthKm * between(random, DONE_SHARE)) / 5) * 5;
  }

  console.log('\nПаспорт трассы:');
  for (let i = 0; i < mocked.length; i++) {
    console.log(
      `  ${real.segments[i].name} ${real.segments[i].lengthKm} км, ${real.segments[i].category}` +
        `  →  ${mocked[i].name} ${mocked[i].lengthKm} км, ${mocked[i].category}`,
    );
  }
  console.log('Ход строительства:');
  for (const s of mocked) {
    console.log(`  ${s.id.padEnd(22)} ${real.progress[s.id]} → ${mockedProgress[s.id]} км`);
  }

  return { real, mocked, mockedProgress };
}

// ── Карьеры и контрактные месторождения ─────────────────────────────────────

/*
 * Названия, недропользователи, БИН и номера контрактов не выдумываются
 * «похоже на настоящие», а делаются откровенно служебными: «ТОО
 * «Недропользователь-07»», «Месторождение №12». Правдоподобное название — это
 * приписывание выдуманного контракта компании, которая вполне может
 * существовать под таким именем, и на карте органа надзора так делать нельзя.
 * Служебная нумерация ни на кого не показывает, а интерфейс демонстрирует
 * ровно то же: попап, сводку по видам сырья, площади.
 */

/**
 * Организационная форма переносится из записи как есть: она никого не опознаёт,
 * а соотношение форм в ведомости неровное — 62 ТОО против одного КХ. Выбери
 * форму кубиком, и на карте окажется поровну ТОО, ИП и ЧП, чего в природе нет.
 *
 * Границу слова `` тут ставить нельзя: в JS она опирается на латиницу, и после
 * кириллической «О» в «ТОО» границы не возникает — выражение не совпадало ни
 * разу, а запасное «ТОО» делало все восемьдесят записей товариществами.
 */
const LEGAL_FORM = /^\s*([А-ЯЁA-Z]{2,4})(?=[\s«"])/;

/**
 * Месяц в БИН делаем 99.
 *
 * Разряды 3-4 настоящего БИН — месяц регистрации, и во всех 79 записях
 * ведомости они лежат в 01-12. Значит 99 не может принадлежать никому:
 * номер выглядит как БИН, но не приводит к живой организации.
 */
function mockBin(random) {
  const yy = String(Math.floor(between(random, [4, 24]))).padStart(2, '0');
  const tail = String(Math.floor(random() * 1e8)).padStart(8, '0');
  return `${yy}99${tail}`;
}

/** Дата в формате ведомости. */
const asDate = (d) =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

/**
 * Срок контракта: начало в пределах 2004-2020, длительность 20-30 лет.
 * Формат строки повторяет ведомость, чтобы попап выглядел как прежде.
 */
function mockLicence(random, original) {
  const kind = typeof original === 'string' && /лиценз/i.test(original) ? 'Лицензия' : 'Контракт';
  const from = new Date(
    Date.UTC(
      Math.floor(between(random, [2004, 2021])),
      Math.floor(random() * 12),
      1 + Math.floor(random() * 28),
    ),
  );
  const to = new Date(from);
  to.setUTCFullYear(from.getUTCFullYear() + Math.floor(between(random, [20, 31])));
  const num = 1 + Math.floor(random() * 400);
  return `${kind} №${num} от ${asDate(from)} г до ${asDate(to)} г`;
}

/** Протокол МКЗ: номер и дата из того же диапазона, что в ведомости. */
function mockProtocol(random) {
  const d = new Date(
    Date.UTC(
      Math.floor(between(random, [2005, 2021])),
      Math.floor(random() * 12),
      1 + Math.floor(random() * 28),
    ),
  );
  return `МКЗ №${1000 + Math.floor(random() * 900)} ${asDate(d)}`;
}

/**
 * Сдвигает и слегка меняет размер контура.
 *
 * Сдвиг общий для всех площадок одной записи: если двигать их порознь,
 * месторождение из двух участков расползётся на десятки километров и перестанет
 * читаться как одно. Площадь пересчитываем из множителя, а не заново по кольцам:
 * формула площади живёт в `lib/deposits.py`, дублировать её на JS — заводить
 * второй источник правды ради цифры, которая и так приблизительная.
 */
function moveDeposit(geometry, random) {
  const points = geometry.coordinates.flat(2);
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;

  const bearing = random() * 2 * Math.PI;
  const away = between(random, DEPOSIT_SHIFT_KM);
  const dLat = (away * Math.cos(bearing)) / KM_PER_DEG_LAT;
  const dLon = (away * Math.sin(bearing)) / kmPerDegLng(cy);
  const scale = between(random, DEPOSIT_SCALE);

  const coordinates = geometry.coordinates.map((polygon) =>
    polygon.map((ring) =>
      ring.map((p) => [
        round6(cx + (p[0] - cx) * scale + dLon),
        round6(cy + (p[1] - cy) * scale + dLat),
      ]),
    ),
  );
  return { geometry: { ...geometry, coordinates }, scale, away };
}

/** Запасы в ведомости — строки; множим и возвращаем строкой же. */
function scaleReserve(value, factor) {
  if (value === null || value === undefined || value === '') return value;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return value;
  return String(Math.max(1, Math.round(n * factor)));
}

/**
 * Переставляет значения полей между записями.
 *
 * Вид сырья не выдумывается, а перемешивается: так сводка в панели — сколько
 * записей суглинка, сколько песка — остаётся прежней, а связка «какое сырьё
 * в каком районе» рвётся. `kind` и `kindNorm` едут парой: в ведомости это одно
 * значение, записанное двумя способами, и разорвать их — получить «песок»
 * в попапе и «соль» в сводке у одной и той же точки.
 */
function permute(features, keys, random) {
  const values = features.map((f) => keys.map((k) => f.properties[k]));
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  features.forEach((f, i) => keys.forEach((k, n) => (f.properties[k] = values[i][n])));
}

function mockDeposits() {
  const random = rng(20261019);
  const out = [];
  const moved = [];

  // ── Контрактные месторождения ──
  const contracts = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8'));
  contracts.features = contracts.features.map((f, i) => {
    const p = { ...f.properties };
    const { geometry, scale, away } = moveDeposit(f.geometry, random);
    moved.push(away);

    const form = LEGAL_FORM.exec(p.user ?? '')?.[1] ?? 'ТОО';
    p.num = String(i + 1);
    p.name = `Месторождение №${i + 1}`;
    p.user = `${form} «Недропользователь-${String(i + 1).padStart(2, '0')}»`;
    p.licence = mockLicence(random, p.licence);
    p.bin = p.bin === null ? null : mockBin(random);
    // Поле не показывается в попапе, но ездило в бандл вместе со всем JSON:
    // адреса, телефоны и фамилии директоров. Публичной сборке оно не нужно.
    p.contacts = null;
    p.areaHa = round1(p.areaHa * scale * scale);
    return { ...f, properties: p, geometry };
  });

  // ── Резервные месторождения (карьеры) ──
  const quarries = JSON.parse(readFileSync(QUARRIES_FILE, 'utf8'));
  quarries.features = quarries.features.map((f, i) => {
    const p = { ...f.properties };
    const { geometry, scale, away } = moveDeposit(f.geometry, random);
    moved.push(away);

    const factor = between(random, RESERVE_SCALE);
    p.num = String(i + 1);
    p.name = `Резервное месторождение №${i + 1}`;
    p.reservesAB = scaleReserve(p.reservesAB, factor);
    p.reservesABC1 = scaleReserve(p.reservesABC1, factor);
    p.reservesC2 = scaleReserve(p.reservesC2, factor);
    p.protocol = p.protocol === null ? null : mockProtocol(random);
    p.areaHa = round1(p.areaHa * scale * scale);
    return { ...f, properties: p, geometry };
  });

  const shuffle = rng(20261024);
  permute(contracts.features, ['kind', 'kindNorm'], shuffle);
  permute(contracts.features, ['operation'], shuffle);
  permute(quarries.features, ['kind', 'kindNorm'], shuffle);

  moved.sort((a, b) => a - b);
  console.log(`\nКонтрактные месторождения: ${contracts.features.length}`);
  console.log('  подменены: название, недропользователь, БИН, контракт, контур');
  console.log('  поле contacts (адреса, телефоны, ФИО директоров) очищено');
  console.log(`Резервные месторождения: ${quarries.features.length}`);
  console.log('  подменены: название, запасы, протокол МКЗ, контур');
  console.log(
    `  контуры сдвинуты на ${moved[0].toFixed(1)}-${moved[moved.length - 1].toFixed(1)} км` +
      `, медиана ${moved[moved.length >> 1].toFixed(1)} км`,
  );
  console.log('  вид сырья и операции перемешаны между записями, номера записей по порядку');

  out.push([CONTRACTS_FILE, `${JSON.stringify(contracts, null, 1)}\n`]);
  out.push([QUARRIES_FILE, `${JSON.stringify(quarries, null, 1)}\n`]);
  return out;
}

// ── Восстановление ──────────────────────────────────────────────────────────

/** Чем запускать разборщики ведомостей: на Windows это обычно `python`. */
function pythonCommand() {
  for (const cmd of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return null;
}

function restore() {
  const python = pythonCommand();
  if (!python) {
    console.error(
      'Не найден интерпретатор Python — карьеры и месторождения из ведомостей не пересобрать.\n' +
        'Поставьте Python (нужны пакеты xlrd и openpyxl) или задайте путь в переменной PYTHON.',
    );
    process.exit(1);
  }

  // Ось и обозначения пересобираются из ведомости и пикетажа. Стыковку хвостов
  // гонять не нужно: моковая ось кончается там же, где настоящая.
  const steps = [
    [process.execPath, resolve(HERE, 'build-axis.mjs'), 'node scripts/build-axis.mjs'],
    [process.execPath, resolve(HERE, 'build-features.mjs'), 'node scripts/build-features.mjs'],
    [python, resolve(HERE, 'extract-contracts.py'), `${python} scripts/extract-contracts.py`],
    [python, resolve(HERE, 'extract-quarries.py'), `${python} scripts/extract-quarries.py`],
  ];

  for (const [cmd, script, label] of steps) {
    console.log(`\n── ${label}`);
    const res = spawnSync(cmd, [script], {
      stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (res.status !== 0) {
      console.error(`\n${label} завершился с ошибкой. Часть данных осталась моковой.`);
      process.exit(1);
    }
  }

  // Паспорт — последним: `build-axis.mjs` переписывает файл плеч целиком,
  // сохраняя в нём то, что застал, то есть моковые названия и длины.
  if (!restorePassport()) {
    console.error(
      `\nНе найден ${PASSPORT_FILE}.\n` +
        'Ось, обозначения и месторождения восстановлены, а названия плеч, протяжённость,\n' +
        'категории и ход строительства остались моковыми: их настоящие значения\n' +
        'хранятся только в этом файле, в репозиторий он не попадает. Верните его\n' +
        'из резервной копии и запустите восстановление ещё раз.',
    );
    process.exit(1);
  }

  writeState('real');
  console.log('\nНастоящие данные восстановлены.');
}

function restorePassport() {
  if (!existsSync(PASSPORT_FILE)) return false;
  const saved = JSON.parse(readFileSync(PASSPORT_FILE, 'utf8'));
  const segments = JSON.parse(readFileSync(SEGMENTS_FILE, 'utf8'));
  for (const s of segments) {
    const r = saved.segments.find((x) => x.id === s.id);
    if (r) Object.assign(s, { name: r.name, lengthKm: r.lengthKm, category: r.category });
  }
  writeFileSync(SEGMENTS_FILE, `${JSON.stringify(segments, null, 2)}\n`);
  // Файл прогресса правится руками, поэтому хранится как есть, до байта.
  writeFileSync(PROGRESS_FILE, saved.progressText);
  console.log(`\n── паспорт трассы и ход строительства из ${PASSPORT_FILE}`);
  return true;
}

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
  const today = new Date().toISOString().slice(0, 10);
  const body =
    value === 'mock'
      ? {
          state: 'mock',
          generated: today,
          why: 'Публичный показ: проектная документация по трассе и ведомости недропользования.',
          mocked: [
            `src/data/road-segments.json — ось плеча ${REAL}; названия, протяжённость и категории всех плеч`,
            'src/data/road-progress.json — ход строительства',
            'src/data/road-features.json — все обозначения',
            'src/data/contracts.json — недропользователи, БИН, контракты, контуры; вид сырья и операции перемешаны',
            'src/data/quarries.json — названия, запасы, протоколы, контуры; вид сырья перемешан',
          ],
          intact: [
            'public/cadastre.geojson, src/data/{regions,districts,cities}.json — открытые данные ЕГКН',
            'src/data/road-segments.json — геометрия двух схематичных плеч, она и так нарисована на глаз',
          ],
          restore: 'node scripts/mock-data.mjs --restore (нужен private/passport.json)',
        }
      : {
          state: 'real',
          generated: today,
          why: 'Данные собраны из исходных ведомостей и чертежей проекта.',
          mock: 'node scripts/mock-data.mjs',
        };
  writeFileSync(STATE_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

// ── Точка входа ─────────────────────────────────────────────────────────────

if (process.argv.includes('--restore')) {
  restore();
  process.exit(0);
}

if (readState() === 'mock') {
  console.log(
    'Данные уже моковые — повторная подмена накрутила бы искажение второй раз.\n' +
      'Сначала верните настоящие: node scripts/mock-data.mjs --restore',
  );
  process.exit(0);
}

const progressText = readFileSync(PROGRESS_FILE, 'utf8');
const passport = mockPassport(
  JSON.parse(readFileSync(SEGMENTS_FILE, 'utf8')),
  JSON.parse(progressText),
  rng(20261023),
);

const written = [
  ...mockRoad(passport),
  [PROGRESS_FILE, `${JSON.stringify(passport.mockedProgress, null, 2)}\n`],
  ...mockDeposits(),
];

if (process.argv.includes('--dry')) {
  console.log('\n--dry: ничего не записано.');
  process.exit(0);
}

// Настоящий паспорт — до того, как что-либо перезаписано: упади запись
// дальше, восстановить будет из чего.
mkdirSync(dirname(PASSPORT_FILE), { recursive: true });
writeFileSync(
  PASSPORT_FILE,
  `${JSON.stringify(
    {
      note: 'Настоящие паспортные данные трассы. Не коммитить. Читает node scripts/mock-data.mjs --restore',
      saved: new Date().toISOString().slice(0, 10),
      segments: passport.real.segments,
      progressText,
    },
    null,
    2,
  )}\n`,
);

for (const [file, body] of written) writeFileSync(file, body);
writeState('mock');

console.log(`\nЗаписано:`);
for (const [file] of written) console.log(`  ${file}`);
console.log(`  ${STATE_FILE}`);
console.log(`  ${PASSPORT_FILE}  ← настоящие паспортные данные, вне git`);
console.log('\nВернуть настоящие: node scripts/mock-data.mjs --restore');
