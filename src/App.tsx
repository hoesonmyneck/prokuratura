import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './map/MapView';
import Sidebar from './components/Sidebar';
import PanelShell from './components/PanelShell';
import type { BasemapId } from './config/map';
import { computeStats, loadCadastre, type CadastreCollection } from './data/cadastre';
import {
  clampKm,
  fallbackProgress,
  fetchProgress,
  pushProgress,
  type RoadProgress,
} from './data/progress';

/** Как часто перечитывать общее состояние, мс. */
const POLL_MS = 20000;
/** Пауза после последнего нажатия перед отправкой, мс. */
const SAVE_DEBOUNCE_MS = 600;

export default function App() {
  const [basemap, setBasemap] = useState<BasemapId>('light');
  const [layers, setLayers] = useState({
    showRoad: true,
    showCadastre: true,
    showCities: true,
    showRegions: true,
    showDistricts: true,
  });
  const [cadastre, setCadastre] = useState<CadastreCollection | null>(null);
  const [cadastreError, setCadastreError] = useState<string | null>(null);
  /*
   * Ход строительства — общее состояние на сервере. До первого ответа
   * показываем значения из файла, потом живём тем, что отдал `/api/progress`.
   * Обновления соседей подтягиваются опросом и при возврате на вкладку;
   * веб-сокет ради трёх чисел, меняющихся раз в неделю, не нужен.
   */
  const [progress, setProgress] = useState<RoadProgress>(fallbackProgress);
  const [editable, setEditable] = useState(false);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  /** Свои правки, ещё не подтверждённые сервером: опрос не должен их затирать. */
  const pendingRef = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await fetchProgress(signal);
      setEditable(state.editable);
      setStorageNote(
        state.storage
          ? null
          : (state.problem ?? 'Общее хранилище не подключено — показаны значения из файла.'),
      );
      setProgressError(null);
      if (!pendingRef.current) setProgress(state.progress);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // Само чтение не удалось — на экране остаются значения из файла.
      setEditable(false);
      setProgressError(`не удалось получить данные (${e instanceof Error ? e.message : String(e)})`);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);

    const tick = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);

    return () => {
      ctrl.abort();
      window.clearInterval(tick);
      window.removeEventListener('focus', onFocus);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [refresh]);

  const setSegmentKm = (id: string, km: number) => {
    // Показываем сразу, отправляем после паузы: набор «300» иначе ушёл бы
    // тремя запросами, и последним мог оказаться промежуточный «30».
    const next = { ...progress, [id]: clampKm(id, km) };
    setProgress(next);
    pendingRef.current = true;

    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      pushProgress(next)
        .then((saved) => {
          setProgress(saved);
          setProgressError(null);
        })
        .catch((e: unknown) =>
          setProgressError(`не удалось сохранить (${e instanceof Error ? e.message : String(e)})`),
        )
        .finally(() => {
          pendingRef.current = false;
        });
    }, SAVE_DEBOUNCE_MS);
  };

  useEffect(() => {
    let alive = true;
    loadCadastre()
      .then((fc) => alive && setCadastre(fc))
      .catch((e: unknown) => alive && setCadastreError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const stats = useMemo(() => (cadastre ? computeStats(cadastre) : null), [cadastre]);

  return (
    <div className="app">
      <PanelShell>
        <Sidebar
          stats={stats}
          cadastreError={cadastreError}
          progress={progress}
          progressEditable={editable}
          progressNote={storageNote}
          progressError={progressError}
          onProgressChange={setSegmentKm}
        />
      </PanelShell>
      <MapView
        basemap={basemap}
        onBasemapChange={setBasemap}
        showRoad={layers.showRoad}
        showCadastre={layers.showCadastre}
        showCities={layers.showCities}
        showRegions={layers.showRegions}
        showDistricts={layers.showDistricts}
        onToggle={(key) => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
        cadastre={cadastre}
        progress={progress}
      />
    </div>
  );
}
