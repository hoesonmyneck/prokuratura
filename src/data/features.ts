import type { FeatureCollection, Point } from 'geojson';
import featuresJson from './road-features.json';

/**
 * Обозначения проекта с чертежей «Сокр.план КС-2 с ВУ».
 *
 * Собираются двумя путями. Что подписано пикетажем — площадки отдыха,
 * развязки, переходы земляного полотна, границы очередей — откладывается
 * по оси и стоит настолько же точно, насколько точна ось.
 * Что нарисовано только значком — АЗС и скотопрогоны — берётся с самого
 * листа: лист привязывается к местности по подписям «КМ n+mmm», знак
 * сажается на ось. Такие объекты могут быть смещены вдоль трассы.
 *
 * Пока только по плечу «Кызылорда — Саксаульск»: по двум другим чертежей нет.
 *
 * В публичной сборке и положения, и подписи пикетажа моковые: настоящие —
 * проектная документация. Сдвигом и возвратом занимается
 * `scripts/mock-data.mjs`, текущее состояние — в `data-state.json`.
 */

export interface RoadFeatureProps {
  kind: 'rest' | 'interchange' | 'roadbed' | 'stage' | 'service' | 'crossing';
  title: string;
  /** Короткая подпись для карты. */
  short: string;
  /** Крупный объект — подписывается раньше и рисуется заметнее. */
  major: boolean;
  /** «КМ 28+898 - 30+777» — как подписано на чертеже. Есть не у всех типов. */
  station?: string;
  /** Длина между крайними отметками, м. 0 — объект отмечен одной точкой. */
  lengthM?: number;
}

export const roadFeatures = featuresJson as FeatureCollection<Point, RoadFeatureProps>;

export interface FeatureKind {
  kind: RoadFeatureProps['kind'];
  title: string;
  count: number;
}

/** Сводка по типам — для списка в панели. */
export const FEATURE_KINDS: FeatureKind[] = (() => {
  const order: Array<RoadFeatureProps['kind']> = [
    'interchange',
    'rest',
    'service',
    'crossing',
    'roadbed',
    'stage',
  ];
  const byKind = new Map<string, FeatureKind>();
  for (const f of roadFeatures.features) {
    const found = byKind.get(f.properties.kind);
    if (found) found.count += 1;
    else byKind.set(f.properties.kind, { kind: f.properties.kind, title: f.properties.title, count: 1 });
  }
  return order.map((k) => byKind.get(k)).filter((v): v is FeatureKind => Boolean(v));
})();
