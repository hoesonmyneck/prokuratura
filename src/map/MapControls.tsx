import { useEffect, useRef, useState } from 'react';
import { BASEMAPS, type BasemapId } from '../config/map';

export interface MapControlsProps {
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  onHome: () => void;
}

function IconPlus() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

function IconMinus() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10h11" />
    </svg>
  );
}

function IconHome() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.2 9.4 10 3.8l6.8 5.6" />
      <path d="M5 8.9v7.3h10V8.9" />
    </svg>
  );
}

/** Стопка слоёв — как на публичной кадастровой карте. */
function IconLayers() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.8 2.6 6.6 10 10.4l7.4-3.8L10 2.8Z" />
      <path d="m2.6 10.2 7.4 3.8 7.4-3.8" />
      <path d="m2.6 13.8 7.4 3.8 7.4-3.8" />
    </svg>
  );
}

export default function MapControls({
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
  onZoomIn,
  onZoomOut,
  onHome,
}: MapControlsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Клик мимо панели и Esc — закрывают её.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="mapctl" ref={rootRef}>
      <div className="mapctl__group">
        <button type="button" className="mapctl__btn" onClick={onZoomIn} title="Приблизить" aria-label="Приблизить">
          <IconPlus />
        </button>
        <button type="button" className="mapctl__btn" onClick={onZoomOut} title="Отдалить" aria-label="Отдалить">
          <IconMinus />
        </button>
      </div>

      <div className="mapctl__group">
        <button
          type="button"
          className="mapctl__btn"
          onClick={onHome}
          title="Показать всю трассу"
          aria-label="Показать всю трассу"
        >
          <IconHome />
        </button>
      </div>

      <div className="mapctl__group">
        <button
          type="button"
          className={`mapctl__btn${open ? ' is-active' : ''}`}
          onClick={() => setOpen((v) => !v)}
          title="Слои"
          aria-label="Слои"
          aria-expanded={open}
        >
          <IconLayers />
        </button>
      </div>

      {open && (
        <div className="mapctl__panel">
          <div className="mapctl__panel-title">Слои</div>
          <label className="switch">
            <input type="checkbox" checked={showRoad} onChange={() => onToggle('showRoad')} />
            <span>Трасса</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={showCadastre} onChange={() => onToggle('showCadastre')} />
            <span>Кадастровые участки</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={showCities} onChange={() => onToggle('showCities')} />
            <span>Населённые пункты</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={showRegions} onChange={() => onToggle('showRegions')} />
            <span>Границы областей</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={showDistricts}
              onChange={() => onToggle('showDistricts')}
            />
            <span>Границы районов</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={showFeatures}
              onChange={() => onToggle('showFeatures')}
            />
            <span>Обозначения проекта</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={showQuarries}
              onChange={() => onToggle('showQuarries')}
            />
            <span>Карьеры</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={showContracts}
              onChange={() => onToggle('showContracts')}
            />
            <span>Контрактные месторождения</span>
          </label>

          <div className="mapctl__panel-title mapctl__panel-title--spaced">Подложка</div>
          <div className="basemaps">
            {BASEMAPS.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`basemaps__btn${b.id === basemap ? ' is-active' : ''}`}
                onClick={() => onBasemapChange(b.id)}
              >
                {b.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
