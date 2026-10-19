import type { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
import segmentsJson from './road-segments.json';
import citiesJson from './cities.json';

/**
 * СХЕМАТИЧНАЯ геометрия трассы — все три плеча.
 *
 * «Бейнеу — Саксаульск» и «Улгайсын — Саксаульск» нарисованы «на глаз» по схеме
 * из «Бейнеу.pdf» и по реальному положению населённых пунктов: ведомостей по ним
 * нет. Когда заказчик пришлёт точные координаты — правится только
 * `road-segments.json`, код не меняется.
 *
 * «Кызылорда — Саксаульск» собрано по ведомости углов поворота, но здесь лежит
 * моковая версия: ось и пикетаж — проектная документация, в публичной сборке
 * их быть не должно. Подменой и возвратом занимается `scripts/mock-data.mjs`,
 * текущее состояние — в `data-state.json`. Настоящая ось пересобирается
 * из ведомости, в этом файле её не хранят.
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

/**
 * Вынесены в JSON по той же причине, что и участки трассы: их читает
 * `scripts/fetch-boundaries.mjs`, который расставляет подписи областей так,
 * чтобы те не легли на населённые пункты.
 */
const CITIES = citiesJson as Array<{ name: string; lngLat: Position } & Omit<CityProps, 'name'>>;

export const cities: FeatureCollection<Point, CityProps> = {
  type: 'FeatureCollection',
  features: CITIES.map(({ lngLat, ...props }): Feature<Point, CityProps> => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Point', coordinates: lngLat },
  })),
};
