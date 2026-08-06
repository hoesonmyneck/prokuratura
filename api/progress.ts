import { Redis } from '@upstash/redis';

/**
 * Ход строительства — общее состояние для всех, кто открыл карту.
 *
 * Edge-функция, а не Node: клиент Upstash работает поверх REST, node-API ему
 * не нужно, а Edge не тянет типы и зависимости `@vercel/node`.
 *
 * Хранилище — Redis из Vercel Marketplace (Upstash). Интеграция подставляет
 * переменные окружения сама, но под разными именами в зависимости от того,
 * как store подключён, поэтому читаем оба варианта.
 *
 * Запись по умолчанию открыта: так карта работает сразу после деплоя, без
 * дополнительной настройки. Поставьте `PROGRESS_WRITE_TOKEN` в переменных
 * окружения проекта — и менять цифры сможет только тот, кто открыл карту
 * ссылкой `?token=<значение>`. Для карты надзорного органа это стоит сделать:
 * иначе правки доступны любому посетителю.
 */

export const config = { runtime: 'edge' };

const KEY = 'road-progress';

/** Участки и паспортная длина — тот же справочник, что и на клиенте. */
const SEGMENTS: Record<string, number> = {
  'beyneu-saksaulsk': 800,
  'ulgaisyn-saksaulsk': 312,
  'kyzylorda-saksaulsk': 462,
};

const DEFAULTS: Record<string, number> = {
  'beyneu-saksaulsk': 30,
  'ulgaisyn-saksaulsk': 0,
  'kyzylorda-saksaulsk': 0,
};

function redis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Приводит любой вход к целым километрам в границах участка. */
function sanitize(raw: unknown): Record<string, number> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [id, max] of Object.entries(SEGMENTS)) {
    const value = Number(input[id]);
    out[id] = Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : DEFAULTS[id];
  }
  return out;
}

function tokenOk(req: Request): boolean {
  const expected = process.env.PROGRESS_WRITE_TOKEN;
  if (!expected) return true;
  return req.headers.get('x-progress-token') === expected;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Состояние общее и меняется в любой момент — кешировать нечего.
      'cache-control': 'no-store',
    },
  });

export default async function handler(req: Request): Promise<Response> {
  const db = redis();
  if (!db) {
    return json({ error: 'Хранилище не настроено: нет переменных Upstash Redis' }, 503);
  }

  if (req.method === 'GET') {
    const stored = await db.get<Record<string, number>>(KEY);
    return json({ progress: sanitize(stored ?? DEFAULTS), editable: tokenOk(req) });
  }

  if (req.method === 'PUT') {
    if (!tokenOk(req)) return json({ error: 'Нет прав на изменение' }, 403);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Ожидался JSON' }, 400);
    }

    const progress = sanitize((body as { progress?: unknown })?.progress ?? body);
    await db.set(KEY, progress);
    return json({ progress, editable: true });
  }

  return json({ error: 'Метод не поддерживается' }, 405);
}
