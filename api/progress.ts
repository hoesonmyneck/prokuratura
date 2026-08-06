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

/*
 * Имена переменных зависят от того, каким способом подключено хранилище:
 * Upstash из Marketplace даёт `UPSTASH_REDIS_REST_*`, интеграция Vercel KV —
 * `KV_REST_API_*`, а первый вариант Redis-хранилища Vercel — только
 * `REDIS_URL` / `KV_URL`, и это TCP-адрес, а не REST.
 */
const REST_URL_VARS = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL'] as const;
const REST_TOKEN_VARS = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'REDIS_REST_TOKEN'] as const;
const TCP_URL_VARS = ['REDIS_URL', 'KV_URL'] as const;

const firstSet = (names: readonly string[]): string | undefined =>
  names.map((n) => process.env[n]).find((v) => typeof v === 'string' && v.length > 0);

function redis(): Redis | null {
  const url = firstSet(REST_URL_VARS);
  const token = firstSet(REST_TOKEN_VARS);
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Почему хранилище не поднялось. Возвращает только имена переменных, никогда
 * значения: подсказка должна помогать настроить, а не утекать токеном.
 */
function storageProblem(): string {
  const present = [...REST_URL_VARS, ...REST_TOKEN_VARS, ...TCP_URL_VARS].filter((n) =>
    Boolean(process.env[n]),
  );

  if (!present.length) {
    return 'Переменные хранилища не заданы. Подключите Redis к проекту (Storage → Connect) и передеплойте: переменные применяются только к новым деплоям.';
  }
  if (!firstSet(REST_URL_VARS) || !firstSet(REST_TOKEN_VARS)) {
    return `Есть только ${present.join(', ')}. Нужен REST-доступ (URL + токен): клиент работает по HTTP, TCP-адрес redis:// на Edge не подходит. В Upstash это «REST API» в настройках базы.`;
  }
  return `Переменные найдены (${present.join(', ')}), но подключиться не удалось.`;
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

  if (req.method === 'GET') {
    // Без хранилища чтение всё равно осмысленно: отдаём значения по умолчанию
    // и честно помечаем, что общего состояния нет. Ошибкой это не считаем —
    // иначе каждый посетитель видел бы красную плашку, пока идёт настройка.
    if (!db) {
      return json({
        progress: sanitize(DEFAULTS),
        editable: false,
        storage: false,
        problem: storageProblem(),
      });
    }

    const stored = await db.get<Record<string, number>>(KEY);
    return json({ progress: sanitize(stored ?? DEFAULTS), editable: tokenOk(req), storage: true });
  }

  if (req.method === 'PUT') {
    // А вот записать без хранилища нельзя, и молчать об этом нельзя тоже.
    if (!db) return json({ error: storageProblem() }, 503);
    if (!tokenOk(req)) return json({ error: 'Нет прав на изменение' }, 403);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Ожидался JSON' }, 400);
    }

    const progress = sanitize((body as { progress?: unknown })?.progress ?? body);
    await db.set(KEY, progress);
    return json({ progress, editable: true, storage: true });
  }

  return json({ error: 'Метод не поддерживается' }, 405);
}
