import type { FeatureCollection, MultiPolygon, Point } from 'geojson';
import contractsJson from './contracts.json';
import { plotPoints } from './plot-points';

/**
 * Контрактные месторождения — действующие недропользователи Кызылординской
 * области.
 *
 * Разобраны из `kontrakt_mestorohdeniya.xls` скриптом
 * `scripts/extract-contracts.py`. Формат ведомости отличается от карьеров:
 * старый .xls, сначала широта, потом долгота, и в шапке прямо указано WGS84.
 * Геометрия при этом та же — контуры участков по угловым точкам.
 *
 * В публичной сборке названия, недропользователи, БИН, номера контрактов
 * и контуры моковые: ведомость недропользования в открытый доступ не идёт.
 * Подменой и возвратом занимается `scripts/mock-data.mjs`, текущее
 * состояние — в `data-state.json`.
 */

export interface ContractProps {
  num: string;
  name: string | null;
  /** Недропользователь: кто держит контракт. */
  user: string | null;
  district: string | null;
  /** Район в именительном падеже: в ведомости он записан вразнобой. */
  districtNorm: string | null;
  kind: string | null;
  kindNorm: string | null;
  /** Номер и срок контракта или лицензии. */
  licence: string | null;
  /** Разведка, добыча или и то и другое. */
  operation: string | null;
  bin: string | null;
  contacts: string | null;
  areaHa: number;
  plots: number;
}

export const contracts = contractsJson as FeatureCollection<MultiPolygon, ContractProps>;

export const contractPoints: FeatureCollection<Point, ContractProps> = plotPoints(contracts);

export interface ContractKind {
  kind: string;
  count: number;
  areaHa: number;
}

/**
 * Сводка по виду ОПИ для панели. Мелкие виды сведены в «прочие»: в ведомости
 * попадаются единичные записи, где в графе стоит не сырьё, а формулировка
 * из контракта, и растягивать на них список незачем.
 */
export const CONTRACT_KINDS: ContractKind[] = (() => {
  const byKind = new Map<string, ContractKind>();
  for (const f of contracts.features) {
    const kind = f.properties.kindNorm ?? 'вид не указан';
    const found = byKind.get(kind);
    if (found) {
      found.count += 1;
      found.areaHa += f.properties.areaHa;
    } else {
      byKind.set(kind, { kind, count: 1, areaHa: f.properties.areaHa });
    }
  }
  const all = [...byKind.values()].sort((a, b) => b.count - a.count);
  const main = all.filter((k) => k.count > 1);
  const rest = all.filter((k) => k.count === 1);
  if (rest.length > 1) {
    main.push({
      kind: 'прочие',
      count: rest.reduce((s, k) => s + k.count, 0),
      areaHa: rest.reduce((s, k) => s + k.areaHa, 0),
    });
  } else main.push(...rest);
  return main.map((k) => ({ ...k, areaHa: Math.round(k.areaHa) }));
})();

export const CONTRACT_TOTAL_HA = Math.round(
  contracts.features.reduce((sum, f) => sum + f.properties.areaHa, 0),
);
