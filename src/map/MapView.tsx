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

export interface MapViewProps {
  basemap: BasemapId;
  onBasemapChange: (id: BasemapId) => void;
  showRoad: boolean;
  showCadastre: boolean;
  showCities: boolean;
  showRegions: boolean;
  showDistricts: boolean;
  onToggle: (
    key: 'showRoad' | 'showCadastre' | 'showCities' | 'showRegions' | 'showDistricts',
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

/** Цвет подписи района — нейтральный тёмный: уровень ниже областного. */
const DISTRICT_INK = '#3c4043';

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

    // Атрибуция подложек обязательна по лицензиям OSM / CARTO / Esri, но по
    // умолчанию MapLibre разворачивает её в строку текста. Схлопываем в «i»:
    // текст остаётся доступен по нажатию, лицензия соблюдена.
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
      const hits = map.queryRenderedFeatures(e.point, { layers: ['road-hit', 'cadastre-fill'] });
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
      set('road-casing', showRoad);
      set('road-pending', showRoad);
      set('road-done', showRoad);
      set('road-hit', showRoad);
      set('cadastre-fill', showCadastre);
      set('cadastre-outline', showCadastre);
      set('region-fill', showRegions);
      set('region-line', showRegions);
      set('region-label', showRegions);
      set('district-casing', showDistricts);
      set('district-line', showDistricts);
      set('district-label', showDistricts);
      markersRef.current.forEach((m) => {
        m.getElement().style.display = showCities ? '' : 'none';
      });
    };
    if (map.isStyleLoaded()) apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [showRoad, showCadastre, showCities, showRegions, showDistricts]);

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
