import type { Feature, FeatureCollection, LineString, Position } from 'geojson';
import { roadSegments, type RoadSegmentProps } from './road';
import progressJson from './road-progress.json';

/**
 * Ход строительства: сколько километров каждого участка уже построено.
 *
 * Значения в километрах и отсчитываются от паспортной длины участка
 * (800 / 312 / 462 км), а не от нарисованной оси. Это важно: схематичная ось
 * короче паспорта (528 / 251 / 447 км), поэтому «30 км построено» нельзя
 * откладывать по геометрии напрямую — получилось бы 5,7 % вместо 3,75 %.
 * Отсюда правило: доля считается от паспорта, а на карте эта же доля
 * откладывается вдоль нарисованной линии (см. `splitPath`).
 *
 * Состояние общее для всех: его держит `api/progress.ts` в Redis. Файл
 * `road-progress.json` остаётся значением по умолчанию — им карта живёт, пока
 * ответ не пришёл, и на него откатывается, если хранилище не настроено.
 */

export type RoadProgress = Record<string, number>;

export const defaultProgress = progressJson as RoadProgress;

const API = '/api/progress';

/**
 * Ключ на запись. Оператор открывает карту один раз ссылкой `?token=…`,
 * дальше ключ лежит в этом браузере. Остальные посетители читают без него.
 * Если `PROGRESS_WRITE_TOKEN` на сервере не задан, ключ не нужен вовсе.
 */
const TOKEN_KEY = 'progress-token';

function readToken(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      // Убираем ключ из адресной строки, чтобы он не разошёлся по скриншотам.
      const url = new URL(location.href);
      url.searchParams.delete('token');
      history.replaceState(null, '', url);
      return fromUrl;
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { 'x-progress-token': token } : {};
}

export interface ProgressState {
  progress: RoadProgress;
  /** Разрешено ли этому браузеру менять цифры. */
  editable: boolean;
}

export async function fetchProgress(signal?: AbortSignal): Promise<ProgressState> {
  const res = await fetch(API, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ProgressState;
  return { progress: sanitize(data.progress), editable: Boolean(data.editable) };
}

export async function pushProgress(progress: RoadProgress): Promise<RoadProgress> {
  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ progress }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { progress: RoadProgress };
  return sanitize(data.progress);
}

const KM_PER_DEG_LAT = 110.574;

function distanceKm(a: Position, b: Position): number {
  const midLat = (a[1] + b[1]) / 2;
  return Math.hypot(
    (b[0] - a[0]) * KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180),
    (b[1] - a[1]) * KM_PER_DEG_LAT,
  );
}

/** Паспортная длина участка по его id. */
const LENGTH_KM = new Map(
  roadSegments.features.map((f) => [f.properties.id, f.properties.lengthKm]),
);

/** Приводит произвольный ввод к целым километрам в границах участка. */
export function clampKm(id: string, value: number): number {
  const max = LENGTH_KM.get(id) ?? 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), max);
}

export function sanitize(raw: unknown): RoadProgress {
  const out: RoadProgress = {};
  for (const f of roadSegments.features) {
    const id = f.properties.id;
    const value = (raw as RoadProgress | null)?.[id];
    out[id] = clampKm(id, typeof value === 'number' ? value : (defaultProgress[id] ?? 0));
  }
  return out;
}

/** Значения из файла — ими карта живёт, пока не пришёл ответ сервера. */
export const fallbackProgress = sanitize(defaultProgress);

/**
 * Делит ломаную на построенную и оставшуюся части по доле длины.
 * Точка раздела ставится внутри звена, а не по ближайшей вершине, иначе
 * на пятнадцати вершинах прогресс двигался бы рывками по 30-50 км.
 */
export function splitPath(path: Position[], fraction: number): [Position[], Position[]] {
  if (fraction <= 0) return [[], path];
  if (fraction >= 1) return [path, []];

  const spans = path.slice(1).map((p, i) => distanceKm(path[i], p));
  const total = spans.reduce((sum, d) => sum + d, 0);
  if (total === 0) return [[], path];

  let target = total * fraction;
  for (let i = 0; i < spans.length; i++) {
    if (target > spans[i]) {
      target -= spans[i];
      continue;
    }
    const t = spans[i] === 0 ? 0 : target / spans[i];
    const a = path[i];
    const b = path[i + 1];
    const cut: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return [
      [...path.slice(0, i + 1), cut],
      [cut, ...path.slice(i + 1)],
    ];
  }
  return [path, []];
}

export interface RoadPartProps extends RoadSegmentProps {
  /** `done` — построено, `pending` — ещё нет. Рисуются разными слоями. */
  part: 'done' | 'pending';
  doneKm: number;
}

/**
 * Та же трасса, но каждый участок разрезан на построенную и оставшуюся часть.
 * Свойства участка сохраняются на обеих половинах — попап работает везде.
 */
export function roadWithProgress(
  progress: RoadProgress,
): FeatureCollection<LineString, RoadPartProps> {
  const features: Array<Feature<LineString, RoadPartProps>> = [];

  for (const f of roadSegments.features) {
    const { id, lengthKm } = f.properties;
    const doneKm = clampKm(id, progress[id] ?? 0);
    const [done, pending] = splitPath(f.geometry.coordinates, lengthKm ? doneKm / lengthKm : 0);

    for (const [part, coords] of [
      ['done', done],
      ['pending', pending],
    ] as const) {
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { ...f.properties, part, doneKm },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

export interface SegmentProgress {
  id: string;
  name: string;
  color: string;
  lengthKm: number;
  doneKm: number;
  /** Доля построенного, 0-1. */
  ratio: number;
}

export interface ProgressSummary {
  segments: SegmentProgress[];
  totalKm: number;
  doneKm: number;
  ratio: number;
}

export function summarize(progress: RoadProgress): ProgressSummary {
  const segments = roadSegments.features.map((f) => {
    const { id, name, color, lengthKm } = f.properties;
    const doneKm = clampKm(id, progress[id] ?? 0);
    return { id, name, color, lengthKm, doneKm, ratio: lengthKm ? doneKm / lengthKm : 0 };
  });

  const totalKm = segments.reduce((sum, s) => sum + s.lengthKm, 0);
  const doneKm = segments.reduce((sum, s) => sum + s.doneKm, 0);
  return { segments, totalKm, doneKm, ratio: totalKm ? doneKm / totalKm : 0 };
}
