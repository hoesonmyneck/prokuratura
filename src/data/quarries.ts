import type { FeatureCollection, MultiPolygon, Point } from 'geojson';
import quarriesJson from './quarries.json';
import { plotPoints } from './plot-points';

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

/** По одной точке на площадку — для значка и подписи, см. `plot-points`. */
export const quarryPoints: FeatureCollection<Point, QuarryProps> = plotPoints(quarries);

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
