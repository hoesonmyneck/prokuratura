import type { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
import segmentsJson from './road-segments.json';

/**
 * МОКОВАЯ геометрия трассы.
 *
 * Ось нарисована «на глаз» по схеме из «Бейнеу.pdf» и по реальному положению
 * населённых пунктов. Когда заказчик пришлёт точные координаты — правится
 * только `road-segments.json`, код не меняется.
 *
 * JSON вынесен отдельно намеренно: его читает ещё и `scripts/fetch-cadastre.mjs`,
 * который выгружает кадастровые участки в полосе вдоль этой оси. Один источник
 * геометрии на сайт и на выгрузку.
 */

export type TechCategory = 'I-б' | 'II';

export interface RoadSegmentProps {
  id: string;
  name: string;
  /** Протяжённость по проектной документации, км. */
  lengthKm: number;
  category: TechCategory;
  color: string;
}

interface SegmentSource {
  id: string;
  name: string;
  lengthKm: number;
  category: TechCategory;
  path: Position[];
}

/** Цвета участков — по технической категории. */
export const CATEGORY_COLOR: Record<TechCategory, string> = {
  'I-б': '#d93025',
  II: '#1a73e8',
};

const SEGMENTS = segmentsJson as SegmentSource[];

export const roadSegments: FeatureCollection<LineString, RoadSegmentProps> = {
  type: 'FeatureCollection',
  features: SEGMENTS.map(({ path, ...props }): Feature<LineString, RoadSegmentProps> => ({
    type: 'Feature',
    properties: { ...props, color: CATEGORY_COLOR[props.category] },
    geometry: { type: 'LineString', coordinates: path },
  })),
};

export interface CityProps {
  name: string;
  /** true — узловой пункт на трассе (кружок как на схеме), false — справочный ориентир. */
  onRoad: boolean;
  major?: boolean;
  labelPos: LabelPos;
}

/** С какой стороны от кружка ставится подпись — чтобы плашки не легли на трассу. */
export type LabelPos = 'left' | 'right' | 'top' | 'bottom';

const CITIES: Array<{ name: string; lngLat: Position } & Omit<CityProps, 'name'>> = [
  { name: 'Бейнеу', lngLat: [55.2, 45.317], onRoad: true, labelPos: 'top' },
  { name: 'Бозой', lngLat: [59.05, 45.93], onRoad: true, labelPos: 'top' },
  { name: 'Улгайсын', lngLat: [60.65, 49.35], onRoad: true, labelPos: 'left' },
  { name: 'Саксаульский', lngLat: [61.183, 47.183], onRoad: true, major: true, labelPos: 'left' },
  { name: 'Камыстыбас', lngLat: [61.9, 46.35], onRoad: true, labelPos: 'left' },
  { name: 'Аксуат', lngLat: [62.6, 45.75], onRoad: true, labelPos: 'top' },
  { name: 'Жосалы', lngLat: [64.08, 45.49], onRoad: true, labelPos: 'bottom' },
  { name: 'Кызылорда', lngLat: [65.51, 44.85], onRoad: true, major: true, labelPos: 'right' },
  { name: 'Актобе', lngLat: [57.167, 50.283], onRoad: true, major: true, labelPos: 'bottom' },
  { name: 'Аральск', lngLat: [61.66, 46.79], onRoad: false, labelPos: 'right' },
];

export const cities: FeatureCollection<Point, CityProps> = {
  type: 'FeatureCollection',
  features: CITIES.map(({ lngLat, ...props }): Feature<Point, CityProps> => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Point', coordinates: lngLat },
  })),
};
