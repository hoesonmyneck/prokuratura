import { useEffect, useMemo, useState } from 'react';
import MapView from './map/MapView';
import Sidebar from './components/Sidebar';
import PanelShell from './components/PanelShell';
import type { BasemapId } from './config/map';
import { computeStats, loadCadastre, type CadastreCollection } from './data/cadastre';

export default function App() {
  const [basemap, setBasemap] = useState<BasemapId>('light');
  const [layers, setLayers] = useState({ showRoad: true, showCadastre: true, showCities: true });
  const [cadastre, setCadastre] = useState<CadastreCollection | null>(null);
  const [cadastreError, setCadastreError] = useState<string | null>(null);

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
        <Sidebar stats={stats} cadastreError={cadastreError} />
      </PanelShell>
      <MapView
        basemap={basemap}
        onBasemapChange={setBasemap}
        showRoad={layers.showRoad}
        showCadastre={layers.showCadastre}
        showCities={layers.showCities}
        onToggle={(key) => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
        cadastre={cadastre}
      />
    </div>
  );
}
