import type { Feature, FeatureCollection, MultiPolygon, Point, Position } from 'geojson';

/**
 * Одна точка на площадку — для значка и подписи на карте.
 *
 * Слой `circle` в MapLibre рисует кружок НА КАЖДОЙ вершине полигона, поэтому
 * значку нужен собственный точечный источник: иначе вместо одной метки
 * получается горсть кружков по углам контура.
 *
 * Точка на площадку, а не на запись: у месторождений бывает по несколько
 * участков, разнесённых на десятки километров, и один значок на всех стоял бы
 * в чистом поле между ними.
 */
export function plotPoints<P>(
  source: FeatureCollection<MultiPolygon, P>,
): FeatureCollection<Point, P> {
  return {
    type: 'FeatureCollection',
    features: source.features.flatMap((f): Array<Feature<Point, P>> =>
      f.geometry.coordinates.map((polygon) => ({
        type: 'Feature',
        properties: f.properties,
        geometry: { type: 'Point', coordinates: centroid(polygon[0]) },
      })),
    ),
  };
}

/**
 * Центр тяжести кольца. Среднее по вершинам сместилось бы туда, где их гуще;
 * у вытянутых притрассовых полос это заметно.
 */
export function centroid(ring: Position[]): Position {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    twiceArea += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (Math.abs(twiceArea) < 1e-12) {
    // Вырожденное кольцо — среднее по вершинам всё же лучше, чем ничего.
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}
