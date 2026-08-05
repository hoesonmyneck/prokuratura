import { roadSegments } from '../data/road';
import { CADASTRE_CATEGORIES, type CadastreStats } from '../data/cadastre';

interface SidebarProps {
  stats: CadastreStats | null;
  cadastreError: string | null;
}

function IconRoute() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="5" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="M7.2 5h4.3a3.5 3.5 0 0 1 0 7H8.5a3.5 3.5 0 0 0 0 7h4.3" />
    </svg>
  );
}

export default function Sidebar({ stats, cadastreError }: SidebarProps) {
  const segments = roadSegments.features;
  const totalKm = segments.reduce((sum, f) => sum + f.properties.lengthKm, 0);

  return (
    <>
      <header className="sidebar__header">
        <div className="identity">
          <span className="identity__icon">
            <IconRoute />
          </span>
          <span className="identity__text">
            <span className="identity__eyebrow">Реконструкция автодороги</span>
            <span className="identity__title">«Западный регион»</span>
          </span>
        </div>
        <div className="sidebar__summary">
          {totalKm.toLocaleString('ru-RU')} км · 3 участка · 8 районов
        </div>
      </header>

      <section className="section">
        <h2 className="section__title">Участки трассы</h2>

        <div className="route-bar" aria-hidden="true">
          {segments.map((f) => (
            <span
              key={f.properties.id}
              className="route-bar__part"
              style={{ flex: f.properties.lengthKm, background: f.properties.color }}
            />
          ))}
        </div>

        <ul className="segments">
          {segments.map((f) => (
            <li key={f.properties.id} className="segment">
              <span className="segment__dot" style={{ background: f.properties.color }} />
              <span>
                <span className="segment__name">{f.properties.name}</span>
                <span className="segment__meta">
                  {f.properties.lengthKm.toLocaleString('ru-RU')} км · категория{' '}
                  {f.properties.category}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="section__title">Кадастровые участки</h2>

        {cadastreError && <div className="notice">Не удалось загрузить: {cadastreError}</div>}

        {!stats && !cadastreError && (
          <div className="stat stat--muted">
            <span className="stat__value">—</span>
            <span className="stat__unit">загружаем</span>
          </div>
        )}

        {stats && (
          <>
            <div className="stat">
              <span className="stat__value">{stats.total.toLocaleString('ru-RU')}</span>
              <span className="stat__unit">участков</span>
            </div>
            <div className="stat__sub">{stats.areaHa.toLocaleString('ru-RU')} га общей площади</div>

            <ul className="rows">
              {CADASTRE_CATEGORIES.map((c) => (
                <li key={c.id} className="row">
                  <span className="row__swatch" style={{ background: c.color }} />
                  <span>{c.title}</span>
                  <span className="row__value">
                    {(stats.byCategory[c.id] ?? 0).toLocaleString('ru-RU')}
                  </span>
                </li>
              ))}
            </ul>

            <ul className="rows rows--districts">
              {stats.byDistrict.map((d) => (
                <li key={d.district} className="row row--plain">
                  <span>{d.district}</span>
                  <span className="row__value">{d.count.toLocaleString('ru-RU')}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
