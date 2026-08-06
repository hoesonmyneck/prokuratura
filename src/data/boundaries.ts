import type { FeatureCollection, MultiPolygon, Position } from 'geojson';
import regionsJson from './regions.json';
import districtsJson from './districts.json';

/**
 * Административные границы вдоль трассы — области и районы.
 *
 * Настоящие контуры из ЕГКН (слои `egkn:regions` и `egkn:districts`), выгружены
 * `scripts/fetch-boundaries.mjs` и упрощены до 150 м. Вместе ~100 КБ — можно
 * держать в бандле, отдельная сетевая загрузка ради них не нужна.
 *
 * Районы — те же 12, из которых тянется кадастр (`scripts/districts.json`),
 * а не всё деление трёх областей: к коридору оно отношения не имеет.
 */

interface BoundaryProps {
  /** Область — «10», район — «10-151». Тот же код, что в справочнике районов. */
  code: string;
  name: string;
  /** Точка подписи — середина трассы внутри контура, а не центр самого контура. */
  labelAt: Position;
}

export interface RegionProps extends BoundaryProps {
  color: string;
}

export interface DistrictProps extends BoundaryProps {
  regionCode: string;
}

export const regionBounds = regionsJson as FeatureCollection<MultiPolygon, RegionProps>;
export const districtBounds = districtsJson as FeatureCollection<MultiPolygon, DistrictProps>;

export const REGIONS: RegionProps[] = regionBounds.features.map((f) => f.properties);

const BY_NAME = new Map(REGIONS.map((r) => [r.name, r]));

/** Цвет области по названию — им красится образец в списке слева. */
export function regionColor(name: string): string | null {
  return BY_NAME.get(name)?.color ?? null;
}
