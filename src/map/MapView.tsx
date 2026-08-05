import { useCallback, useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { BASEMAPS, MAX_ZOOM, MIN_ZOOM, PROJECT_BOUNDS, ROAD_BOUNDS, basemapStyle, type BasemapId } from '../config/map';
import MapControls from './MapControls';
import { readPeek, useIsMobile } from '../components/PanelShell';
import { cities, roadSegments, type RoadSegmentProps } from '../data/road';
import {
  CADASTRE_CATEGORIES,
  OTHER_CATEGORY_COLOR,
  categoryTitle,
  emptyCadastre,
  type CadastreCollection,
  type CadastreProps,
} from '../data/cadastre';

export interface MapViewProps {
  basemap: BasemapId;
  onBasemapChange: (id: BasemapId) => void;
  showRoad: boolean;
  showCadastre: boolean;
  showCities: boolean;
  onToggle: (key: 'showRoad' | 'showCadastre' | 'showCities') => void;
  /** Участки ЕГКН; null — пока грузятся. */
  cadastre: CadastreCollection | null;
}

const SOURCE_ROAD = 'road';
const SOURCE_CADASTRE = 'cadastre';

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

function roadPopupHtml(p: RoadSegmentProps): string {
  return `
    <div class="popup">
      <div class="popup__badge" style="--badge-color:${p.color}">Участок трассы</div>
      <div class="popup__title">${escapeHtml(p.name)}</div>
      <table class="popup__table">
        <tr><th>Протяжённость</th><td>${p.lengthKm.toLocaleString('ru-RU')} км</td></tr>
        <tr><th>Категория</th><td>${escapeHtml(p.category)}</td></tr>
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

  map.addSource(SOURCE_CADASTRE, { type: 'geojson', data: emptyCadastre, generateId: false });
  map.addSource(SOURCE_ROAD, { type: 'geojson', data: roadSegments });

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

  map.addLayer({
    id: 'road-line',
    type: 'line',
    source: SOURCE_ROAD,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 8, 6, 14, 14],
    },
  });

  map.addLayer({
    id: 'road-hit',
    type: 'line',
    source: SOURCE_ROAD,
    paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 20 },
  });

  return true;
}

export default function MapView({
  basemap,
  onBasemapChange,
  showRoad,
  showCadastre,
  showCities,
  onToggle,
  cadastre,
}: MapViewProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoveredRef = useRef<string | number | null>(null);
  /** Держим последние данные под рукой: смена подложки пересоздаёт источник. */
  const cadastreRef = useRef<CadastreCollection | null>(cadastre);
  cadastreRef.current = cadastre;
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
      const src = map.getSource(SOURCE_CADASTRE) as maplibregl.GeoJSONSource | undefined;
      if (src && cadastreRef.current) src.setData(cadastreRef.current);
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
        popup.setLngLat(e.lngLat).setHTML(roadPopupHtml(road.properties as RoadSegmentProps)).addTo(map);
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
      set('road-line', showRoad);
      set('road-hit', showRoad);
      set('cadastre-fill', showCadastre);
      set('cadastre-outline', showCadastre);
      markersRef.current.forEach((m) => {
        m.getElement().style.display = showCities ? '' : 'none';
      });
    };
    if (map.isStyleLoaded()) apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [showRoad, showCadastre, showCities]);

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
