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

/**
 * Сервер глифов для подписей.
 *
 * Раньше тут стоял `fonts.openmaptiles.org`, и он перестал отдавать Noto Sans:
 * на запрос несуществующего шрифта этот сервер возвращает не 404, а HTML своей
 * главной страницы с кодом 200. MapLibre получал «успешный» ответ, разобрать
 * его не мог и молча не рисовал ни одной подписи. У OpenFreeMap тот же
 * Noto Sans с кириллицей — название шрифта в слоях менять не пришлось.
 */
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

interface CommonBasemap {
  id: BasemapId;
  title: string;
}

/** Готовый векторный стиль: подключается по ссылке, свои шрифты и спрайты внутри. */
interface VectorBasemap extends CommonBasemap {
  kind: 'vector';
  style: string;
}

/** Набор растровых тайлов: стиль вокруг них собирается здесь. */
interface RasterBasemap extends CommonBasemap {
  kind: 'raster';
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

type Basemap = VectorBasemap | RasterBasemap;

export const BASEMAPS: Basemap[] = [
  {
    id: 'light',
    title: 'Светлая',
    kind: 'vector',
    /*
     * Был CARTO Positron растром, но CARTO закрыл бесплатную отдачу: вместо
     * карты сервер стал присылать плашку «API KEY REQUIRED». Здесь тот же
     * Positron, только векторный и без ключа. Подписи идут как «латиница +
     * местное название», то есть казахские и русские имена на карте остаются, —
     * серые подложки Esri, например, дают только латиницу.
     */
    style: 'https://tiles.openfreemap.org/styles/positron',
  },
  {
    id: 'scheme',
    title: 'Схема',
    kind: 'raster',
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
    kind: 'raster',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: 'Esri, Maxar, Earthstar Geographics',
    maxzoom: 18,
  },
];

/**
 * Стиль подложки для `new Map({ style })` и `map.setStyle()`.
 *
 * MapLibre принимает и ссылку на готовый стиль, и собранный объект, поэтому
 * векторная и растровые подложки переключаются одинаково. Слои проекта в обоих
 * случаях добавляются поверх по событию `styledata` — см. `MapView`.
 */
export function basemapStyle(id: BasemapId): StyleSpecification | string {
  const bm = BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
  if (bm.kind === 'vector') return bm.style;

  return {
    version: 8,
    glyphs: GLYPHS,
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
