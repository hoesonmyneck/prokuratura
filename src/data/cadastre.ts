import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

/**
 * РЕАЛЬНЫЕ кадастровые участки из ЕГКН (map.gov4c.kz).
 *
 * Файл `public/cadastre.geojson` готовится скриптом `scripts/fetch-cadastre.mjs`:
 * он выгружает участки по районам вдоль трассы, пересчитывает координаты из
 * UTM в WGS-84 и оставляет только полосу ±1 км от оси дороги. Данные лежат в
 * public/, а не в src/, чтобы не попадать в бандл — грузятся по сети при старте.
 *
 * Полосу можно изменить: `node scripts/fetch-cadastre.mjs --km 3`.
 */

export interface CadastreProps {
  gid: number;
  cadNumber: string | null;
  address: string | null;
  /** Площадь, кв. м. */
  areaM2: number | null;
  /** Целевое назначение. */
  purpose: string | null;
  /** Код категории земель по Земельному кодексу РК. */
  categoryId: string | null;
  rightTypeId: string | null;
  region: string;
  district: string;
  districtCode: string;
}

export type CadastreCollection = FeatureCollection<Polygon | MultiPolygon, CadastreProps>;

export interface CadastreCategory {
  id: string;
  title: string;
  color: string;
}

/**
 * Подписи даны только для кодов, которые подтверждаются самими данными:
 * 01 — крестьянские хозяйства, 02 — жилые дома в сёлах и городах,
 * 03 — газопровод и объекты железной дороги. Остальные коды (04–07) в полосе
 * встречаются единицами, поэтому сведены в «прочие», чтобы не приписывать им
 * названия наугад.
 */
export const CADASTRE_CATEGORIES: CadastreCategory[] = [
  { id: '02', title: 'Земли населённых пунктов', color: '#f9ab00' },
  { id: '01', title: 'Земли сельхозназначения', color: '#188038' },
  { id: '03', title: 'Промышленности и транспорта', color: '#9334e6' },
  { id: 'other', title: 'Прочие категории', color: '#80868b' },
];

export const OTHER_CATEGORY_COLOR = '#80868b';

export function categoryTitle(id: string | null): string {
  return CADASTRE_CATEGORIES.find((c) => c.id === id)?.title ?? 'Прочие категории';
}

export interface DistrictStat {
  district: string;
  count: number;
}

export interface RegionStat {
  region: string;
  count: number;
  districts: DistrictStat[];
}

export interface CadastreStats {
  total: number;
  areaHa: number;
  byCategory: Record<string, number>;
  /** Области с вложенными районами, всё отсортировано по числу участков. */
  byRegion: RegionStat[];
  /** Всего районов с участками в полосе — по всем областям. */
  districtCount: number;
}

export function computeStats(fc: CadastreCollection): CadastreStats {
  const byCategory: Record<string, number> = {};
  // Область → район → число участков. Состав считаем по самим данным: часть
  // районов из справочника в полосу не попадает, их в списке быть не должно.
  const regions = new Map<string, Map<string, number>>();
  let areaM2 = 0;

  for (const f of fc.features) {
    const key = CADASTRE_CATEGORIES.some((c) => c.id === f.properties.categoryId)
      ? (f.properties.categoryId as string)
      : 'other';
    byCategory[key] = (byCategory[key] ?? 0) + 1;

    const { region, district } = f.properties;
    let districts = regions.get(region);
    if (!districts) regions.set(region, (districts = new Map()));
    districts.set(district, (districts.get(district) ?? 0) + 1);

    areaM2 += f.properties.areaM2 ?? 0;
  }

  const byRegion = [...regions.entries()]
    .map(([region, districts]) => ({
      region,
      count: [...districts.values()].reduce((sum, n) => sum + n, 0),
      districts: [...districts.entries()]
        .map(([district, count]) => ({ district, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total: fc.features.length,
    areaHa: Math.round(areaM2 / 10000),
    byCategory,
    byRegion,
    districtCount: byRegion.reduce((sum, r) => sum + r.districts.length, 0),
  };
}

const EMPTY: CadastreCollection = { type: 'FeatureCollection', features: [] };

export const emptyCadastre = EMPTY;

export async function loadCadastre(): Promise<CadastreCollection> {
  const res = await fetch(`${import.meta.env.BASE_URL}cadastre.geojson`);
  if (!res.ok) throw new Error(`Не удалось загрузить кадастр: HTTP ${res.status}`);
  return (await res.json()) as CadastreCollection;
}
