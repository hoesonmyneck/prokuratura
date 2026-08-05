import type { LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';

/**
 * Предел панорамирования — не даёт уехать с региона проекта.
 *
 * Заметно шире самой трассы, и это намеренно. На узком высоком экране карта по
 * высоте почти равна разрешённой области, а MaplLibre запрещает движение, если
 * видимая часть не помещается в границы целиком, — с тесными границами телефон
 * просто переставал прокручиваться. Запас по краям возвращает свободу движения,
 * при этом уехать в соседние страны по-прежнему нельзя.
 */
export const PROJECT_BOUNDS: LngLatBoundsLike = [
  [47.0, 36.0], // ЮЗ угол [lng, lat]
  [75.0, 58.0], // СВ угол [lng, lat]
];

/**
 * Границы обзора — под них карта подгоняется при старте и по кнопке «Показать всю трассу».
 * Севернее самой трассы: чтобы в кадр целиком попадал Актобе.
 */
export const ROAD_BOUNDS: LngLatBoundsLike = [
  [54.6, 44.3],
  [66.4, 50.7],
];

export const MIN_ZOOM = 4.5;
export const MAX_ZOOM = 16;

export type BasemapId = 'light' | 'scheme' | 'satellite';

interface Basemap {
  id: BasemapId;
  title: string;
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'light',
    title: 'Светлая',
    tiles: [
      'https://a.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxzoom: 19,
  },
  {
    id: 'scheme',
    title: 'Схема',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
  },
  {
    id: 'satellite',
    title: 'Спутник',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Esri, Maxar, Earthstar Geographics',
    maxzoom: 18,
  },
];

export function basemapStyle(id: BasemapId): StyleSpecification {
  const bm = BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
  return {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: bm.tiles,
        tileSize: 256,
        maxzoom: bm.maxzoom,
        attribution: bm.attribution,
      },
    },
    layers: [
      {
        id: 'basemap',
        type: 'raster',
        source: 'basemap',
        paint: {
          // Спутник оставляем как есть, растровые схемы слегка приглушаем,
          // чтобы трасса и кадастры читались поверх.
          'raster-saturation': id === 'satellite' ? 0 : -0.25,
          'raster-opacity': 1,
        },
      },
    ],
  };
}
