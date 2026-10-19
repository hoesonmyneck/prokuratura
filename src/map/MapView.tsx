import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { BASEMAPS, MAX_ZOOM, MIN_ZOOM, PROJECT_BOUNDS, ROAD_BOUNDS, basemapStyle, type BasemapId } from '../config/map';
import MapControls from './MapControls';
import { readPeek, useIsMobile } from '../components/PanelShell';
import { cities } from '../data/road';
import { roadWithProgress, type RoadPartProps, type RoadProgress } from '../data/progress';
import {
  CADASTRE_CATEGORIES,
  OTHER_CATEGORY_COLOR,
  categoryTitle,
  emptyCadastre,
  type CadastreCollection,
  type CadastreProps,
} from '../data/cadastre';
import { districtBounds, regionBounds } from '../data/boundaries';
import { roadFeatures, type RoadFeatureProps } from '../data/features';
import { quarries, quarryPoints, type QuarryProps } from '../data/quarries';
import { contracts, contractPoints, type ContractProps } from '../data/contracts';
import iconRest from '../assets/icon-rest.png';
import iconInterchange from '../assets/icon-interchange.png';
import iconService from '../assets/icon-service.png';
import iconCrossing from '../assets/icon-crossing.png';

export interface MapViewProps {
  basemap: BasemapId;
  onBasemapChange: (id: BasemapId) => void;
  showRoad: boolean;
  showCadastre: boolean;
  showCities: boolean;
  showRegions: boolean;
  showDistricts: boolean;
  showFeatures: boolean;
  showQuarries: boolean;
  showContracts: boolean;
  onToggle: (
    key:
      | 'showRoad'
      | 'showCadastre'
      | 'showCities'
      | 'showRegions'
      | 'showDistricts'
      | 'showFeatures'
      | 'showQuarries'
      | 'showContracts',
  ) => void;
  /** Участки ЕГКН; null — пока грузятся. */
  cadastre: CadastreCollection | null;
  /** Ход строительства: построенные километры по каждому участку. */
  progress: RoadProgress;
}

const SOURCE_ROAD = 'road';
const SOURCE_CADASTRE = 'cadastre';
const SOURCE_REGIONS = 'regions';
const SOURCE_REGION_LABELS = 'region-labels';
const SOURCE_DISTRICTS = 'districts';
const SOURCE_DISTRICT_LABELS = 'district-labels';
const SOURCE_FEATURES = 'road-features';
const SOURCE_QUARRIES = 'quarries';
const SOURCE_QUARRY_POINTS = 'quarry-points';
const SOURCE_CONTRACTS = 'contracts';
const SOURCE_CONTRACT_POINTS = 'contract-points';

/**
 * Источники проекта — по ним слой отличается от слоя подложки.
 *
 * Пока все подложки были растровыми, в стиле лежал ровно один чужой слой —
 * `basemap`. Светлая подложка теперь векторная и приносит с собой полсотни
 * своих слоёв, а гасятся слои по префиксу идентификатора (см. ниже). Совпадения
 * сейчас нет — у OpenFreeMap слои названы через подчёркивание, `road_pier`,
 * а у нас через дефис, `road-line`, — но держаться за это различие нельзя:
 * переименование на той стороне выключало бы дороги подложки вместе с трассой.
 */
const PROJECT_SOURCES = new Set<string>([
  SOURCE_ROAD,
  SOURCE_CADASTRE,
  SOURCE_REGIONS,
  SOURCE_REGION_LABELS,
  SOURCE_DISTRICTS,
  SOURCE_DISTRICT_LABELS,
  SOURCE_FEATURES,
  SOURCE_QUARRIES,
  SOURCE_QUARRY_POINTS,
  SOURCE_CONTRACTS,
  SOURCE_CONTRACT_POINTS,
]);

/** Цвет подписи района — нейтральный тёмный: уровень ниже областного. */
const DISTRICT_INK = '#3c4043';

/**
 * Условные знаки вырезаны из легенды самого чертежа (`scripts/extract-icons.py`).
 * Рисовать свои нельзя: читающий план и читающий карту увидели бы разные знаки.
 * В легенде есть развязки, площадки отдыха, АЗС и скотопрогоны; перехода
 * земляного полотна и границы очереди там нет — для них остаётся кружок.
 */
const FEATURE_ICONS: Array<[kind: string, image: string, src: string]> = [
  ['rest', 'feature-rest', iconRest],
  ['interchange', 'feature-interchange', iconInterchange],
  ['service', 'feature-service', iconService],
  ['crossing', 'feature-crossing', iconCrossing],
];

const WITH_ICON = FEATURE_ICONS.map(([kind]) => kind);

/** Цвет кружка для того, чему условного знака в проекте не нашлось. */
const FEATURE_INK = '#1f1f1f';

/**
 * Карьеры. Глубокий оранжевый — единственный крупный незанятый участок
 * спектра: красный и синий держит трасса, жёлтый, зелёный, фиолетовый
 * и серый — категории земель, бирюза, пурпур и индиго — области.
 */
const QUARRY_COLOR = '#e65100';

/**
 * Контрактные месторождения. Тёмная бирюза — из оставшегося спектра она дальше
 * всего от оранжевого у карьеров: эти два слоя стоят рядом и читаются вместе.
 * Значки различаются и буквой: «К» — карьер, «М» — месторождение.
 */
const CONTRACT_COLOR = '#00695c';

/**
 * Иконки живут в стиле карты, а смена подложки стиль пересоздаёт — значит,
 * добавлять их надо каждый раз заново, как и слои. Загрузка асинхронная:
 * MapLibre сам перерисует символы, когда картинка доедет.
 */
function ensureIcons(map: MapLibreMap): void {
  for (const [, id, src] of FEATURE_ICONS) {
    if (map.hasImage(id)) continue;
    const img = new Image();
    img.onload = () => {
      // Карту могли успеть закрыть или сменить подложку ещё раз.
      try {
        if (!map.hasImage(id)) map.addImage(id, img);
      } catch {
        /* стиль уже не тот — следующий styledata добавит заново */
      }
    };
    img.src = src;
  }
}

const emptyRoad: GeoJSON.FeatureCollection<GeoJSON.LineString, RoadPartProps> = {
  type: 'FeatureCollection',
  features: [],
};

/** Подписи — отдельный точечный источник: якорь лежит на трассе, а не в центре контура. */
function labelPoints<P extends { name: string; labelAt: GeoJSON.Position }>(
  fc: GeoJSON.FeatureCollection<GeoJSON.MultiPolygon, P>,
  color: (props: P) => string,
): GeoJSON.FeatureCollection<GeoJSON.Point, { name: string; color: string }> {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => ({
      type: 'Feature',
      properties: { name: f.properties.name, color: color(f.properties) },
      geometry: { type: 'Point', coordinates: f.properties.labelAt },
    })),
  };
}

const regionLabels = labelPoints(regionBounds, (p) => p.color);
const districtLabels = labelPoints(districtBounds, () => DISTRICT_INK);

function escapeHtml(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

function formatArea(areaM2: number | null): string {
  if (areaM2 == null) return '—';
  if (areaM2 >= 10000) return `${(areaM2 / 10000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} га`;
  return `${Math.round(areaM2).toLocaleString('ru-RU')} кв. м`;
}

function cadastrePopupHtml(p: CadastreProps): string {
  const color =
    CADASTRE_CATEGORIES.find((c) => c.id === p.categoryId)?.color ?? OTHER_CATEGORY_COLOR;
  const rows: Array<[string, string]> = [
    ['Адрес', p.address ?? '—'],
    ['Площадь', formatArea(p.areaM2)],
    ['Назначение', p.purpose ?? '—'],
    ['Район', `${p.district} (${p.districtCode})`],
    ['Область', p.region],
  ];
  return `
    <div class="popup">
      <div class="popup__badge" style="--badge-color:${color}">${escapeHtml(categoryTitle(p.categoryId))}</div>
      <div class="popup__title">${escapeHtml(p.cadNumber ?? 'Без кадастрового номера')}</div>
      <table class="popup__table">
        ${rows
          .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
          .join('')}
      </table>
    </div>`;
}

function featurePopupHtml(p: RoadFeatureProps): string {
  // Пикетаж есть только у объектов, подписанных им на чертеже. У снятых
  // с рисунка (АЗС, скотопрогоны) его нет, и выдумывать строку не надо.
  const rows: Array<[string, string]> = [];
  if (p.station) rows.push(['Пикетаж', p.station]);
  const length = Number(p.lengthM) || 0;
  if (length) rows.push(['Протяжённость', `${length.toLocaleString('ru-RU')} м`]);
  return `
    <div class="popup">
      <div class="popup__badge" style="--badge-color:${FEATURE_INK}">Обозначение проекта</div>
      <div class="popup__title">${escapeHtml(p.title)}</div>
      <table class="popup__table">
        ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
      </table>
    </div>`;
}

function quarryPopupHtml(p: QuarryProps): string {
  const unit = p.unit ?? '';
  const reserves = [
    ['A+B', p.reservesAB],
    ['A+B+C1', p.reservesABC1],
    ['C2', p.reservesC2],
  ].filter(([, v]) => v) as Array<[string, string]>;

  const rows: Array<[string, string]> = [
    ['Вид сырья', p.kind ?? '—'],
    ['Площадь', `${Number(p.areaHa).toLocaleString('ru-RU')} га`],
  ];
  if (Number(p.plots) > 1) rows.push(['Площадок', String(p.plots)]);
  for (const [label, value] of reserves) {
    rows.push([`Запасы ${label}`, `${value} ${unit}`.trim()]);
  }
  if (p.protocol) rows.push(['Протокол', p.protocol]);

  return `
    <div class="popup">
      <div class="popup__badge" style="--badge-color:${QUARRY_COLOR}">Резервное месторождение</div>
      <div class="popup__title">${escapeHtml(p.name ?? `№${p.num}`)}</div>
      <table class="popup__table">
        ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
      </table>
    </div>`;
}

function contractPopupHtml(p: ContractProps): string {
  const rows: Array<[string, string | null]> = [
    ['Недропользователь', p.user],
    ['Вид сырья', p.kind],
    ['Операции', p.operation],
    ['Площадь', Number(p.areaHa).toLocaleString('ru-RU') + ' га'],
    ['Участков', Number(p.plots) > 1 ? String(p.plots) : null],
    ['Район', p.district],
    ['Контракт', p.licence],
    ['БИН', p.bin],
  ];
  const body = rows
    .filter(([, v]) => v)
    .map(([k, v]) => '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v as string) + '</td></tr>')
    .join('');
  return (
    '<div class="popup">' +
    '<div class="popup__badge" style="--badge-color:' + CONTRACT_COLOR + '">Контрактное месторождение</div>' +
    '<div class="popup__title">' + escapeHtml(p.name ?? ('№' + p.num)) + '</div>' +
    '<table class="popup__table">' + body + '</table>' +
    '</div>'
  );
}

function roadPopupHtml(p: RoadPartProps): string {
  // doneKm приходит из свойств объекта, а они у MapLibre всегда строки-или-числа
  // в зависимости от источника — приводим явно.
  const doneKm = Number(p.doneKm) || 0;
  const pct = p.lengthKm ? Math.round((doneKm / p.lengthKm) * 100) : 0;
  return `
    <div class="popup">
      <div class="popup__badge" style="--badge-color:${p.color}">Участок трассы</div>
      <div class="popup__title">${escapeHtml(p.name)}</div>
      <table class="popup__table">
        <tr><th>Протяжённость</th><td>${p.lengthKm.toLocaleString('ru-RU')} км</td></tr>
        <tr><th>Категория</th><td>${escapeHtml(p.category)}</td></tr>
        <tr><th>Построено</th><td>${doneKm.toLocaleString('ru-RU')} км (${pct} %)</td></tr>
      </table>
    </div>`;
}

/**
 * Идемпотентно навешивает проектные слои поверх подложки.
 * Вызывается и на `load`, и на каждый `styledata` (смена подложки стирает слои),
 * поэтому обязана быть безопасной при повторном вызове.
 */
function addProjectLayers(map: MapLibreMap): boolean {
  // Защита от повторного добавления: styledata срабатывает при каждой смене
  // подложки. Источник дороги создаётся последним, поэтому его наличие
  // означает, что предыдущий проход дошёл до конца.
  //
  // ВНИМАНИЕ ПРИ РАЗРАБОТКЕ. Отсюда следует, что набор слоёв замораживается
  // в момент создания карты, а карта создаётся один раз за загрузку страницы
  // (useEffect с пустыми зависимостями ниже). Новый слой, дописанный сюда при
  // работающем dev-сервере, в уже открытой вкладке не появится и не будет
  // слушаться переключателей: Vite подменит модуль, но живой объект карты
  // останется прежним. Перезагрузите страницу, прежде чем решить, что слой
  // сломан, — на это уже был потрачен вечер.
  if (map.getSource(SOURCE_ROAD)) return false;

  // Цвет участка — по коду категории земель; всё, что не в справочнике, серым.
  const categoryColor: unknown[] = ['match', ['get', 'categoryId']];
  for (const c of CADASTRE_CATEGORIES) {
    if (c.id === 'other') continue;
    categoryColor.push(c.id, c.color);
  }
  categoryColor.push(OTHER_CATEGORY_COLOR);

  map.addSource(SOURCE_REGIONS, { type: 'geojson', data: regionBounds });
  map.addSource(SOURCE_REGION_LABELS, { type: 'geojson', data: regionLabels });
  map.addSource(SOURCE_DISTRICTS, { type: 'geojson', data: districtBounds });
  map.addSource(SOURCE_DISTRICT_LABELS, { type: 'geojson', data: districtLabels });
  map.addSource(SOURCE_FEATURES, { type: 'geojson', data: roadFeatures });
  map.addSource(SOURCE_QUARRIES, { type: 'geojson', data: quarries });
  map.addSource(SOURCE_QUARRY_POINTS, { type: 'geojson', data: quarryPoints });
  map.addSource(SOURCE_CONTRACTS, { type: 'geojson', data: contracts });
  map.addSource(SOURCE_CONTRACT_POINTS, { type: 'geojson', data: contractPoints });
  map.addSource(SOURCE_CADASTRE, { type: 'geojson', data: emptyCadastre, generateId: false });
  // Пустая коллекция на старте: настоящую подкладывает эффект по `progress`,
  // так же как кадастр. Иначе смена подложки вернула бы устаревшие данные.
  map.addSource(SOURCE_ROAD, { type: 'geojson', data: emptyRoad });

  // Заливка областей идёт первой — она одна лежит под кадастром. Нарочно почти
  // прозрачная: её задача показать, где кончается одна область и начинается
  // другая, а не перекрасить карту. Сами границы добавляются ниже по коду,
  // поверх участков, — под 17 тысячами полигонов линию было бы не видно.
  map.addLayer({
    id: 'region-fill',
    type: 'fill',
    source: SOURCE_REGIONS,
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.14, 10, 0.06],
    },
  });

  map.addLayer({
    id: 'cadastre-fill',
    type: 'fill',
    source: SOURCE_CADASTRE,
    paint: {
      'fill-color': categoryColor as never,
      'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.75, 0.45],
    },
  });

  map.addLayer({
    id: 'cadastre-outline',
    type: 'line',
    source: SOURCE_CADASTRE,
    paint: {
      'line-color': categoryColor as never,
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 0.6],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 12, 0.9],
    },
  });

  // Карьеры. Участки мелкие (медиана 17 га), поэтому кроме заливки рисуется
  // точка: на общем плане полигон вырождается в доли пикселя, и без неё
  // месторождение просто исчезало бы с карты.
  map.addLayer({
    id: 'quarry-fill',
    type: 'fill',
    source: SOURCE_QUARRIES,
    paint: { 'fill-color': QUARRY_COLOR, 'fill-opacity': 0.35 },
  });

  map.addLayer({
    id: 'quarry-outline',
    type: 'line',
    source: SOURCE_QUARRIES,
    paint: { 'line-color': QUARRY_COLOR, 'line-width': 1.4 },
  });

  // Значок карьера: кружок с буквой «К». Голая точка на общем плане ничем
  // не отличалась от прочих точек на карте — по букве месторождение видно
  // сразу, не открывая карточку. С приближением полигон говорит сам за себя,
  // и значок гаснет.
  map.addLayer({
    id: 'quarry-dot',
    type: 'circle',
    source: SOURCE_QUARRY_POINTS,
    maxzoom: 12,
    paint: {
      'circle-color': QUARRY_COLOR,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 6, 11, 9],
    },
  });

  map.addLayer({
    id: 'quarry-mark',
    type: 'symbol',
    source: SOURCE_QUARRY_POINTS,
    maxzoom: 12,
    layout: {
      'text-field': 'К',
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 11, 13],
      // Буква — часть значка, а не подпись: прятать её при тесноте нельзя,
      // иначе останется безымянный кружок.
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  });

  map.addLayer({
    id: 'quarry-label',
    type: 'symbol',
    source: SOURCE_QUARRY_POINTS,
    minzoom: 9,
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ['concat', 'Карьер №', ['get', 'num']]],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12],
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 4,
      'text-max-width': 9,
    },
    paint: {
      'text-color': '#7a2e00',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.6,
    },
  });

  // Контрактные месторождения — тот же набор слоёв, что у карьеров: заливка,
  // контур, значок с буквой и подпись.
  map.addLayer({
    id: 'contract-fill',
    type: 'fill',
    source: SOURCE_CONTRACTS,
    paint: { 'fill-color': CONTRACT_COLOR, 'fill-opacity': 0.35 },
  });

  map.addLayer({
    id: 'contract-outline',
    type: 'line',
    source: SOURCE_CONTRACTS,
    paint: { 'line-color': CONTRACT_COLOR, 'line-width': 1.4 },
  });

  map.addLayer({
    id: 'contract-dot',
    type: 'circle',
    source: SOURCE_CONTRACT_POINTS,
    maxzoom: 12,
    paint: {
      'circle-color': CONTRACT_COLOR,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 6, 11, 9],
    },
  });

  map.addLayer({
    id: 'contract-mark',
    type: 'symbol',
    source: SOURCE_CONTRACT_POINTS,
    maxzoom: 12,
    layout: {
      'text-field': 'М',
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 11, 13],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  });

  map.addLayer({
    id: 'contract-label',
    type: 'symbol',
    source: SOURCE_CONTRACT_POINTS,
    minzoom: 9,
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ['concat', 'Участок №', ['get', 'num']]],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 12],
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 4,
      'text-max-width': 9,
    },
    paint: {
      'text-color': '#00332c',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.6,
    },
  });

  // Районы — уровень ниже областного, поэтому линия тоньше, сплошная и
  // нейтрального цвета. Светлая подложка под ней нужна ровно затем же, зачем
  // «обочина» у дороги: без неё тёмная нитка тонет в спутниковом снимке.
  map.addLayer({
    id: 'district-casing',
    type: 'line',
    source: SOURCE_DISTRICTS,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.6,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.6, 12, 4.5],
    },
  });

  map.addLayer({
    id: 'district-line',
    type: 'line',
    source: SOURCE_DISTRICTS,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': DISTRICT_INK,
      'line-opacity': 0.7,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 12, 1.6],
    },
  });

  // Граница области — поверх районной: где они совпадают, должна побеждать
  // старшая. Пунктир отличает административную границу от всего остального.
  map.addLayer({
    id: 'region-line',
    type: 'line',
    source: SOURCE_REGIONS,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.4, 9, 2.4, 14, 3.2],
      'line-opacity': 0.85,
      'line-dasharray': [3, 2],
    },
  });

  // Дорога рисуется в два слоя: широкая светлая «обочина» + цветная ось,
  // так линия читается и на спутнике, и на светлой подложке.
  map.addLayer({
    id: 'road-casing',
    type: 'line',
    source: SOURCE_ROAD,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.9,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 5, 8, 10, 14, 22],
    },
  });

  // Ход строительства кодируется не цветом, а рисунком линии: цвет уже занят
  // технической категорией участка, и второй смысл на него не навесить.
  // Пунктир и полупрозрачность — «ещё не построено», сплошная линия в полную
  // силу — «построено». Это обычная картографическая условность.
  map.addLayer({
    id: 'road-pending',
    type: 'line',
    source: SOURCE_ROAD,
    filter: ['==', ['get', 'part'], 'pending'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': 0.4,
      'line-dasharray': [2, 1.6],
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 8, 6, 14, 14],
    },
  });

  map.addLayer({
    id: 'road-done',
    type: 'line',
    source: SOURCE_ROAD,
    filter: ['==', ['get', 'part'], 'done'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 8, 8, 14, 18],
    },
  });

  map.addLayer({
    id: 'road-hit',
    type: 'line',
    source: SOURCE_ROAD,
    paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 20 },
  });

  // Обозначения проекта — поверх трассы: они на ней и стоят. Кружок с белой
  // обводкой читается на любой подложке, крупные объекты заметнее переходов ЛЭП.
  // Кружок — только для того, чему знака в легенде нет.
  map.addLayer({
    id: 'feature-dot',
    type: 'circle',
    source: SOURCE_FEATURES,
    filter: ['!', ['in', ['get', 'kind'], ['literal', WITH_ICON]]],
    paint: {
      'circle-color': FEATURE_INK,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.6,
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5, ['case', ['get', 'major'], 3.4, 2.2],
        10, ['case', ['get', 'major'], 6, 4],
      ],
    },
  });

  // Знаки с чертежа. `icon-allow-overlap` намеренно: объекты стоят на трассе,
  // и пропадающий знак читался бы как «здесь ничего нет».
  map.addLayer({
    id: 'feature-icon',
    type: 'symbol',
    source: SOURCE_FEATURES,
    filter: ['in', ['get', 'kind'], ['literal', WITH_ICON]],
    layout: {
      // Собирается из справочника, поэтому тип приходится подсказать вручную —
      // так же, как цвет категорий земель выше.
      'icon-image': [
        'match',
        ['get', 'kind'],
        ...FEATURE_ICONS.flatMap(([kind, id]) => [kind, id]),
        '',
      ] as never,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.18, 9, 0.3, 14, 0.42],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // Крупные объекты подписываются с зума 8, переходы ЛЭП — с 11: их 25 штук,
  // и на общем плане они превратились бы в частокол. Два слоя, а не фильтр
  // по зуму внутри одного: `zoom` в filter-выражениях работает с оговорками.
  const featureLabel = (id: string, major: boolean, minzoom: number): maplibregl.LayerSpecification => ({
    id,
    type: 'symbol',
    source: SOURCE_FEATURES,
    minzoom,
    filter: ['==', ['get', 'major'], major],
    layout: {
      'text-field': ['get', 'short'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 12, 12],
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-allow-overlap': false,
      'text-padding': 4,
    },
    paint: {
      'text-color': FEATURE_INK,
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.6,
    },
  });

  map.addLayer(featureLabel('feature-label-major', true, 8));
  map.addLayer(featureLabel('feature-label-minor', false, 11));

  // Названия районов ниже по приоритету: мельче, и появляются только с зума 6 —
  // на общем плане двенадцать подписей рядом с областными превратились бы в кашу.
  // Ниже областных по коду, поэтому при столкновении MapLibre скроет районную.
  map.addLayer({
    id: 'district-label',
    type: 'symbol',
    source: SOURCE_DISTRICT_LABELS,
    minzoom: 6,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 13],
      'text-offset': [0, 1.4],
      'text-allow-overlap': false,
      'text-padding': 6,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.6,
    },
  });

  // Названия областей — последними, поверх всего. Сдвига нет: точка подписи уже
  // выбрана в самом пустом месте области (см. `emptySpotAnchor` в выгрузке).
  map.addLayer({
    id: 'region-label',
    type: 'symbol',
    source: SOURCE_REGION_LABELS,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 12, 9, 15],
      'text-allow-overlap': false,
      'text-padding': 8,
    },
    paint: {
      'text-color': ['get', 'color'],
      // Обводка нужна на спутнике: без неё тёмный текст тонет в снимке.
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.8,
    },
  });

  return true;
}

export default function MapView({
  basemap,
  onBasemapChange,
  showRoad,
  showCadastre,
  showCities,
  showRegions,
  showDistricts,
  showFeatures,
  showQuarries,
  showContracts,
  onToggle,
  cadastre,
  progress,
}: MapViewProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoveredRef = useRef<string | number | null>(null);
  /** Держим последние данные под рукой: смена подложки пересоздаёт источник. */
  const cadastreRef = useRef<CadastreCollection | null>(cadastre);
  cadastreRef.current = cadastre;
  const roadRef = useRef<RoadProgress>(progress);
  roadRef.current = progress;
  /** Подложка, с которой карта уже создана — чтобы не звать setStyle на первом рендере. */
  const basemapRef = useRef<BasemapId>(basemap);

  /**
   * Отступы кадра при подгонке под трассу. На телефоне снизу карту перекрывает
   * шторка — без запаса Кызылорда оказывается ровно под ней.
   */
  const fitPadding = useCallback(
    () =>
      isMobile
        ? { top: 28, right: 24, bottom: readPeek() + 20, left: 24 }
        : { top: 60, right: 60, bottom: 60, left: 60 },
    [isMobile],
  );

  // Инициализация карты — один раз за жизнь компонента.
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(basemap),
      bounds: ROAD_BOUNDS,
      fitBoundsOptions: { padding: fitPadding() },
      maxBounds: PROJECT_BOUNDS,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: { compact: true },
      dragRotate: false,
    });
    mapRef.current = map;

    map.touchZoomRotate.disableRotation();
    // Зум, «домой» и слои — свои кнопки в MapControls, штатный NavigationControl не нужен.
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');

    // Атрибуция подложек обязательна по лицензиям OSM / OpenFreeMap / Esri,
    // но по умолчанию MapLibre разворачивает её в строку текста. Схлопываем
    // в «i»: текст остаётся доступен по нажатию, лицензия соблюдена.
    const collapseAttribution = () => {
      map
        .getContainer()
        .querySelector('.maplibregl-ctrl-attrib')
        ?.classList.remove('maplibregl-compact-show');
    };
    map.on('load', collapseAttribution);
    map.on('styledata', collapseAttribution);

    // На телефоне высокий экран показывает по вертикали больше, чем разрешает
    // maxBounds, и карта перестаёт двигаться вовсе. Запрещаем отдаляться дальше
    // обзора всей трассы — тогда видимая часть всегда влезает в границы и
    // остаётся запас для перетаскивания.
    if (isMobile) {
      map.once('idle', () => map.setMinZoom(map.getZoom()));
    }

    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });

    const ensureLayers = () => {
      // Слои пересоздаются после каждой смены подложки — вместе с ними
      // возвращаем и уже загруженный кадастр, иначе источник останется пустым.
      ensureIcons(map);
      if (!addProjectLayers(map)) return;
      const cad = map.getSource(SOURCE_CADASTRE) as maplibregl.GeoJSONSource | undefined;
      if (cad && cadastreRef.current) cad.setData(cadastreRef.current);
      const road = map.getSource(SOURCE_ROAD) as maplibregl.GeoJSONSource | undefined;
      if (road) road.setData(roadWithProgress(roadRef.current));
    };
    map.on('load', ensureLayers);
    map.on('styledata', ensureLayers);

    // Маркеры городов живут в DOM, а не в стиле карты, — их можно создать сразу
    // и они переживают смену подложки.
    for (const feature of cities.features) {
      const { name, major, onRoad, labelPos } = feature.properties;
      const el = document.createElement('div');
      el.className = [
        'city-marker',
        `city-marker--label-${labelPos}`,
        major ? 'city-marker--major' : '',
        onRoad ? '' : 'city-marker--ref',
      ]
        .filter(Boolean)
        .join(' ');
      el.innerHTML =
        `<span class="city-marker__ring"></span>` +
        `<span class="city-marker__label">${escapeHtml(name)}</span>`;
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(feature.geometry.coordinates as [number, number])
        .addTo(map);
      markersRef.current.push(marker);
    }

    const setHover = (feature: MapGeoJSONFeature | null) => {
      if (hoveredRef.current !== null) {
        map.setFeatureState({ source: SOURCE_CADASTRE, id: hoveredRef.current }, { hover: false });
      }
      hoveredRef.current = feature?.id ?? null;
      if (hoveredRef.current !== null) {
        map.setFeatureState({ source: SOURCE_CADASTRE, id: hoveredRef.current }, { hover: true });
      }
    };

    map.on('mousemove', 'cadastre-fill', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      setHover(e.features?.[0] ?? null);
    });
    map.on('mouseleave', 'cadastre-fill', () => {
      map.getCanvas().style.cursor = '';
      setHover(null);
    });
    map.on('mouseenter', 'road-hit', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'road-hit', () => {
      map.getCanvas().style.cursor = '';
    });

    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [
          'feature-icon',
          'feature-dot',
          'quarry-dot',
          'contract-dot',
          'quarry-fill',
          'contract-fill',
          'road-hit',
          'cadastre-fill',
        ],
      });
      // Обозначение — самая мелкая цель, поэтому проверяется первым:
      // иначе клик по нему всегда перехватывала бы широкая полоса дороги.
      const marker = hits.find((f) => f.layer.id === 'feature-icon' || f.layer.id === 'feature-dot');
      if (marker) {
        popup
          .setLngLat(e.lngLat)
          .setHTML(featurePopupHtml(marker.properties as RoadFeatureProps))
          .addTo(map);
        return;
      }
      const contract = hits.find(
        (f) => f.layer.id === 'contract-dot' || f.layer.id === 'contract-fill',
      );
      if (contract) {
        popup
          .setLngLat(e.lngLat)
          .setHTML(contractPopupHtml(contract.properties as ContractProps))
          .addTo(map);
        return;
      }
      const quarry = hits.find((f) => f.layer.id === 'quarry-dot' || f.layer.id === 'quarry-fill');
      if (quarry) {
        popup
          .setLngLat(e.lngLat)
          .setHTML(quarryPopupHtml(quarry.properties as QuarryProps))
          .addTo(map);
        return;
      }
      const road = hits.find((f) => f.layer.id === 'road-hit');
      if (road) {
        popup.setLngLat(e.lngLat).setHTML(roadPopupHtml(road.properties as RoadPartProps)).addTo(map);
        return;
      }
      const parcel = hits.find((f) => f.layer.id === 'cadastre-fill');
      if (parcel) {
        popup.setLngLat(e.lngLat).setHTML(cadastrePopupHtml(parcel.properties as CadastreProps)).addTo(map);
        return;
      }
      popup.remove();
    });

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Смена подложки: стиль пересоздаётся, проектные слои возвращает `ensureLayers`
  // по событию styledata. На первом рендере ничего не делаем — карта уже создана
  // с нужным стилем, повторный setStyle здесь только гонялся бы с обработчиком load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (basemapRef.current === basemap) return;
    basemapRef.current = basemap;
    if (!BASEMAPS.some((b) => b.id === basemap)) return;
    map.setStyle(basemapStyle(basemap));
  }, [basemap]);

  // Видимость слоёв.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const set = (id: string, visible: boolean) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      };
      // Слои гасятся по префиксу идентификатора, а не по списку имён.
      // Списки приходилось держать в двух местах — рядом с созданием слоя
      // и здесь, — и любой забытый идентификатор оборачивался слоем,
      // который не выключается. Префикс же виден прямо в id при создании.
      const group = (prefix: string, visible: boolean) => {
        for (const layer of map.getStyle().layers) {
          // Слои подложки мимо: префикс разбирает только наши.
          if (!('source' in layer) || !PROJECT_SOURCES.has(String(layer.source))) continue;
          if (layer.id.startsWith(prefix)) set(layer.id, visible);
        }
      };

      group('road-', showRoad);
      group('cadastre-', showCadastre);
      group('region-', showRegions);
      group('district-', showDistricts);
      group('feature-', showFeatures);
      group('quarry-', showQuarries);
      group('contract-', showContracts);
      markersRef.current.forEach((m) => {
        m.getElement().style.display = showCities ? '' : 'none';
      });
    };
    if (map.isStyleLoaded()) apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [showRoad, showCadastre, showCities, showRegions, showDistricts, showFeatures, showQuarries, showContracts]);

  // Ход строительства меняется прямо в панели — пересобираем геометрию трассы.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(SOURCE_ROAD) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(roadWithProgress(progress));
    };
    if (map.getSource(SOURCE_ROAD)) apply();
    else map.once('styledata', apply);
  }, [progress]);

  // Кадастр приезжает по сети — подкладываем в источник, как только пришёл.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cadastre) return;
    const apply = () => {
      const src = map.getSource(SOURCE_CADASTRE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(cadastre);
    };
    if (map.getSource(SOURCE_CADASTRE)) apply();
    else map.once('styledata', apply);
  }, [cadastre]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      <MapControls
        basemap={basemap}
        onBasemapChange={onBasemapChange}
        showRoad={showRoad}
        showCadastre={showCadastre}
        showCities={showCities}
        showRegions={showRegions}
        showDistricts={showDistricts}
        showFeatures={showFeatures}
        showQuarries={showQuarries}
        showContracts={showContracts}
        onToggle={onToggle}
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        onHome={() =>
          mapRef.current?.fitBounds(ROAD_BOUNDS, { padding: fitPadding(), duration: 900 })
        }
      />
    </div>
  );
}
