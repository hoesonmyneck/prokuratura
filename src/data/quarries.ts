import type { FeatureCollection, MultiPolygon, Point, Position } from 'geojson';
import quarriesJson from './quarries.json';

/**
 * Резервные месторождения (карьеры) Кызылординской области.
 *
 * Разобраны из `carrier.xlsx` скриптом `scripts/extract-quarries.py`:
 * в ведомости у каждого месторождения по строке на угловую точку контура,
 * координаты в градусах, минутах и секундах. Это настоящие контуры участков,
 * а не точки, поэтому на карте они полигоны.
 *
 * Одна запись может содержать несколько площадок — у №20 их две.
 */

export interface QuarryProps {
  num: string;
  name: string | null;
  /** Вид полезного ископаемого как записан в ведомости. */
  kind: string | null;
  /** Он же в едином написании: «супеси» и «супесь» — одно и то же. */
  kindNorm: string | null;
  reservesAB: string | null;
  reservesABC1: string | null;
  reservesC2: string | null;
  unit: string | null;
  protocol: string | null;
  areaHa: number;
  /** Сколько отдельных площадок в записи. */
  plots: number;
}

export const quarries = quarriesJson as FeatureCollection<MultiPolygon, QuarryProps>;

/**
 * По одной точке на площадку — для значка и подписи.
 *
 * Слой `circle` в MapLibre рисует кружок НА КАЖДОЙ вершине полигона, поэтому
 * на карте вместо одного значка получалась горсть кружков по углам контура.
 * Значку нужен собственный точечный источник.
 *
 * Точка на площадку, а не на месторождение: у №21 три площадки, разнесённые
 * на 20 км, и один значок на всех стоял бы в чистом поле между ними.
 */
export const quarryPoints: FeatureCollection<Point, QuarryProps> = {
  type: 'FeatureCollection',
  features: quarries.features.flatMap((f) =>
    f.geometry.coordinates.map((polygon) => ({
      type: 'Feature' as const,
      properties: f.properties,
      geometry: { type: 'Point' as const, coordinates: centroid(polygon[0]) },
    })),
  ),
};

/**
 * Центр тяжести кольца. Среднее по вершинам сместилось бы туда, где их гуще;
 * у вытянутых притрассовых полос это заметно.
 */
function centroid(ring: Position[]): Position {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    twiceArea += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    // Вырожденное кольцо — среднее по вершинам всё же лучше, чем ничего.
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

export interface QuarryKind {
  kind: string;
  count: number;
  areaHa: number;
}

/** Сводка по виду полезного ископаемого — для списка в панели. */
export const QUARRY_KINDS: QuarryKind[] = (() => {
  const byKind = new Map<string, QuarryKind>();
  for (const f of quarries.features) {
    const kind = f.properties.kindNorm ?? 'вид не указан';
    const found = byKind.get(kind);
    if (found) {
      found.count += 1;
      found.areaHa += f.properties.areaHa;
    } else {
      byKind.set(kind, { kind, count: 1, areaHa: f.properties.areaHa });
    }
  }
  return [...byKind.values()]
    .map((k) => ({ ...k, areaHa: Math.round(k.areaHa) }))
    .sort((a, b) => b.count - a.count);
})();

export const QUARRY_TOTAL_HA = Math.round(
  quarries.features.reduce((sum, f) => sum + f.properties.areaHa, 0),
);
