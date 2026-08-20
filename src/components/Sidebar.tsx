import { roadSegments } from '../data/road';
import { CADASTRE_CATEGORIES, type CadastreStats } from '../data/cadastre';
import { regionColor } from '../data/boundaries';
import { summarize, type RoadProgress } from '../data/progress';
import { FEATURE_KINDS } from '../data/features';
import { QUARRY_KINDS, QUARRY_TOTAL_HA, quarries } from '../data/quarries';

interface SidebarProps {
  stats: CadastreStats | null;
  cadastreError: string | null;
  progress: RoadProgress;
  /** Есть ли у этого браузера право менять цифры (см. PROGRESS_WRITE_TOKEN). */
  progressEditable: boolean;
  /** Пояснение, если общего хранилища нет: что именно не настроено. */
  progressNote: string | null;
  progressError: string | null;
  onProgressChange: (id: string, km: number) => void;
}

/** Русское склонение при числительном: 1 район, 2 района, 5 районов. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Доля от общего числа. Без ложной точности: у категорий разброс от 98 % до
 * долей процента, поэтому мелкие значения не растягиваем до сотых.
 */
function share(part: number, total: number): string {
  if (!total) return '0 %';
  const pct = (part / total) * 100;
  if (pct >= 10) return `${Math.round(pct)} %`;
  if (pct >= 1) return `${pct.toFixed(1)} %`;
  return '<1 %';
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

export default function Sidebar({
  stats,
  cadastreError,
  progress,
  progressEditable,
  progressNote,
  progressError,
  onProgressChange,
}: SidebarProps) {
  const segments = roadSegments.features;
  const totalKm = segments.reduce((sum, f) => sum + f.properties.lengthKm, 0);
  const build = summarize(progress);
  // Областей и районов столько, сколько их фактически в полосе: из справочника
  // часть даёт ноль участков. Пока кадастр не загрузился — они неизвестны, и
  // на их месте стоит прочерк: убирать ячейки нельзя, шапка бы прыгала.
  const regionCount = stats?.byRegion.length ?? null;
  const districtCount = stats?.districtCount ?? null;

  return (
    <>
      <header className="sidebar__header">
        <div className="identity">
          <span className="identity__icon">
            <IconRoute />
          </span>
          {/* Название системы — главное, объект мониторинга под ним. */}
          <span className="identity__text">
            <span className="identity__title">Инновационная система мониторинга</span>
            <span className="identity__sub">Реконструкция а/д «Западный регион»</span>
          </span>
        </div>
        {/* Сетка вместо строки через точки-разделители: четыре независимые
            величины, а не перечисление. Колонки держат ширину, пока грузится
            кадастр, поэтому шапка не дёргается при появлении чисел. */}
        <dl className="facts">
          <div className="fact">
            <dd className="fact__value">{totalKm.toLocaleString('ru-RU')}</dd>
            <dt className="fact__label">км трассы</dt>
          </div>
          <div className="fact">
            <dd className="fact__value">{segments.length}</dd>
            <dt className="fact__label">
              {plural(segments.length, 'отрезок', 'отрезка', 'отрезков')}
            </dt>
          </div>
          <div className="fact">
            <dd className="fact__value">{regionCount ?? '…'}</dd>
            <dt className="fact__label">
              {plural(regionCount ?? 0, 'область', 'области', 'областей')}
            </dt>
          </div>
          <div className="fact">
            <dd className="fact__value">{districtCount ?? '…'}</dd>
            <dt className="fact__label">
              {plural(districtCount ?? 0, 'район', 'района', 'районов')}
            </dt>
          </div>
        </dl>
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
                  <span className="segment__km">{f.properties.lengthKm.toLocaleString('ru-RU')}</span>{' '}
                  км · категория {f.properties.category}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="section__title">Ход строительства</h2>

        <div className="stat">
          <span className="stat__value">{build.doneKm.toLocaleString('ru-RU')}</span>
          <span className="stat__unit">км построено</span>
        </div>
        <div className="stat__sub">
          {share(build.doneKm, build.totalKm)} от {build.totalKm.toLocaleString('ru-RU')} км по проекту
        </div>

        <div className="build">
          {build.segments.map((s) => (
            <div key={s.id} className="build__item">
              <label className="build__name" htmlFor={`done-${s.id}`}>
                {s.name}
              </label>
              <div
                className="build__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={s.lengthKm}
                aria-valuenow={s.doneKm}
                aria-label={`Построено на участке ${s.name}`}
              >
                <span
                  className="build__fill"
                  style={{ width: `${s.ratio * 100}%`, background: s.color }}
                />
              </div>
              <input
                id={`done-${s.id}`}
                className="build__input"
                type="number"
                inputMode="numeric"
                min={0}
                max={s.lengthKm}
                step={1}
                value={s.doneKm}
                readOnly={!progressEditable}
                aria-readonly={!progressEditable}
                onChange={(e) => onProgressChange(s.id, e.target.valueAsNumber)}
              />
              <span className="build__of">из {s.lengthKm.toLocaleString('ru-RU')} км</span>
            </div>
          ))}
        </div>

        {/* Ненастроенное хранилище — не ошибка посетителя: цифры на экране верные,
            просто общие правки пока некуда складывать. Тон соответственный. */}
        {progressNote && !progressError && <p className="hint">{progressNote}</p>}

        {progressError && <div className="notice">Ход строительства: {progressError}</div>}
      </section>

      <section className="section">
        <h2 className="section__title">Обозначения проекта</h2>

        <ul className="rows">
          {FEATURE_KINDS.map((k) => (
            <li key={k.kind} className="row row--plain">
              <span className="row__label">{k.title}</span>
              <span className="row__value">{k.count}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="section__title">Карьеры</h2>

        <div className="stat">
          <span className="stat__value">{quarries.features.length}</span>
          <span className="stat__unit">месторождений</span>
        </div>
        <div className="stat__sub">
          {QUARRY_TOTAL_HA.toLocaleString('ru-RU')} га суммарной площади
        </div>

        <ul className="rows">
          {QUARRY_KINDS.map((k) => (
            <li key={k.kind} className="row row--plain row--wide">
              <span className="row__label">{k.kind}</span>
              <span className="row__value">{k.count}</span>
              <span className="row__share">{k.areaHa.toLocaleString('ru-RU')} га</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2 className="section__title">Кадастровые участки</h2>

        {cadastreError && <div className="notice">Не удалось загрузить: {cadastreError}</div>}

        {/* Кадастр — 11,8 МБ, ждать приходится ощутимо. Скелет повторяет форму
            будущего содержимого, чтобы панель не перестраивалась при загрузке. */}
        {!stats && !cadastreError && (
          <div className="skeleton" role="status" aria-label="Загружаем кадастровые участки">
            <span className="skeleton__bar skeleton__bar--stat" />
            <span className="skeleton__bar skeleton__bar--sub" />
            {CADASTRE_CATEGORIES.map((c) => (
              <span key={c.id} className="skeleton__bar skeleton__bar--row" />
            ))}
          </div>
        )}

        {stats?.total === 0 && (
          <p className="empty">
            В полосе вдоль трассы нет ни одного участка. Проверьте ширину полосы в
            <code> scripts/fetch-cadastre.mjs</code>.
          </p>
        )}

        {stats && stats.total > 0 && (
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
                  <span className="row__label">{c.title}</span>
                  <span className="row__value">
                    {(stats.byCategory[c.id] ?? 0).toLocaleString('ru-RU')}
                  </span>
                  {/* Доля — главное, что говорят эти числа: 98 % полосы занимают
                      земли населённых пунктов. По абсолютным значениям это
                      приходилось считать в уме. */}
                  <span className="row__share">{share(stats.byCategory[c.id] ?? 0, stats.total)}</span>
                </li>
              ))}
            </ul>

            <div className="regions">
              {stats.byRegion.map((r) => (
                <section key={r.region} className="region">
                  <h3 className="region__head">
                    {/* Тот же цвет, что у заливки и границы на карте, — связывает список с картой. */}
                    <span className="region__swatch" style={{ background: regionColor(r.region) ?? 'transparent' }} />
                    <span className="region__name">{r.region}</span>
                    <span className="row__value">{r.count.toLocaleString('ru-RU')}</span>
                    <span className="row__share">{share(r.count, stats.total)}</span>
                  </h3>
                  <ul className="rows">
                    {r.districts.map((d) => (
                      <li key={d.district} className="row row--plain row--nested">
                        <span className="row__label">{d.district}</span>
                        <span className="row__value">{d.count.toLocaleString('ru-RU')}</span>
                        {/* У районов доли нет намеренно: двенадцать процентов
                            подряд — стена чисел, а не иерархия. */}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
