import type { IncomingMessage, ServerResponse } from 'node:http';
import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient } from 'redis';
import segmentsJson from '../src/data/road-segments.json';
import defaultsJson from '../src/data/road-progress.json';

/**
 * Ход строительства — общее состояние для всех, кто открыл карту.
 *
 * Рантайм Node, а не Edge. Изначально была Edge-функция с REST-клиентом
 * Upstash, но хранилище Redis на Vercel отдаёт только `REDIS_URL` — обычный
 * TCP-адрес `rediss://`. По TCP Edge ходить не умеет в принципе, поэтому
 * функция переехала на Node, где работают оба способа:
 *
 *   • есть REST-переменные (`UPSTASH_REDIS_REST_*`, `KV_REST_API_*`) —
 *     идём по HTTP, соединение держать не нужно;
 *   • есть только TCP-адрес — поднимаем соединение на время запроса.
 *
 * Запись по умолчанию открыта: так карта работает сразу после деплоя, без
 * дополнительной настройки. Поставьте `PROGRESS_WRITE_TOKEN` в переменных
 * окружения проекта — и менять цифры сможет только тот, кто открыл карту
 * ссылкой `?token=<значение>`. Для карты надзорного органа это стоит сделать:
 * иначе правки доступны любому посетителю.
 */

const KEY = 'road-progress';

/**
 * Участки, паспортная длина и значения по умолчанию берутся из тех же файлов,
 * что и на клиенте.
 *
 * Раньше оба справочника были продублированы здесь числами, и это оказалось
 * ловушкой: при подмене данных на моковые (`scripts/mock-data.mjs`) JSON
 * менялся, а копия в функции оставалась с настоящими цифрами — и продолжала
 * ими же обрезать присланные километры. Один источник на клиент и на функцию
 * такого расхождения не допускает.
 */
const SEGMENTS: Record<string, number> = Object.fromEntries(
  (segmentsJson as Array<{ id: string; lengthKm: number }>).map((s) => [s.id, s.lengthKm]),
);

const DEFAULTS: Record<string, number> = defaultsJson as Record<string, number>;

/*
 * Имена переменных зависят от того, каким способом подключено хранилище:
 * Upstash из Marketplace даёт `UPSTASH_REDIS_REST_*`, интеграция Vercel KV —
 * `KV_REST_API_*`, а Redis-хранилище Vercel — только `REDIS_URL` / `KV_URL`.
 */
const REST_URL_VARS = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL'] as const;
const REST_TOKEN_VARS = [
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_TOKEN',
  'REDIS_REST_TOKEN',
] as const;
const TCP_URL_VARS = ['REDIS_URL', 'KV_URL', 'UPSTASH_REDIS_URL'] as const;

const firstSet = (names: readonly string[]): string | undefined =>
  names.map((n) => process.env[n]).find((v) => typeof v === 'string' && v.length > 0);

type Progress = Record<string, number>;

/** Единый интерфейс поверх двух разных клиентов. */
interface Store {
  get(): Promise<Progress | null>;
  set(value: Progress): Promise<void>;
}

function restStore(): Store | null {
  const url = firstSet(REST_URL_VARS);
  const token = firstSet(REST_TOKEN_VARS);
  if (!url || !token) return null;

  const db = new UpstashRedis({ url, token });
  return {
    get: () => db.get<Progress>(KEY),
    set: async (value) => {
      await db.set(KEY, value);
    },
  };
}

function tcpStore(): Store | null {
  const url = firstSet(TCP_URL_VARS);
  if (!url) return null;

  // Соединение живёт ровно один запрос: держать пул в serverless незачем,
  // а незакрытые сокеты быстро упираются в лимит подключений хранилища.
  const open = async () => {
    const client = createClient({ url });
    client.on('error', () => {
      /* Ошибку вернёт сам вызов ниже; без обработчика node-redis роняет процесс. */
    });
    await client.connect();
    return client;
  };

  const close = async (client: Awaited<ReturnType<typeof open>>) => {
    await client.quit().catch(() => client.destroy());
  };

  return {
    async get() {
      const client = await open();
      try {
        const raw = await client.get(KEY);
        return raw ? (JSON.parse(raw) as Progress) : null;
      } finally {
        await close(client);
      }
    },
    async set(value) {
      const client = await open();
      try {
        await client.set(KEY, JSON.stringify(value));
      } finally {
        await close(client);
      }
    },
  };
}

/** REST предпочтительнее: не тратит время на рукопожатие TCP. */
const store = (): Store | null => restStore() ?? tcpStore();

/**
 * Почему хранилище не поднялось. Возвращает только имена переменных, никогда
 * значения: подсказка должна помогать настроить, а не утекать токеном.
 */
function storageProblem(): string {
  const present = [...REST_URL_VARS, ...REST_TOKEN_VARS, ...TCP_URL_VARS].filter((n) =>
    Boolean(process.env[n]),
  );
  if (!present.length) {
    return 'Переменные хранилища не заданы. Подключите Redis к проекту (Storage → Connect Project) и передеплойте: переменные применяются только к новым деплоям.';
  }
  return `Переменные найдены (${present.join(', ')}), но подключиться не удалось.`;
}

/** Приводит любой вход к целым километрам в границах участка. */
function sanitize(raw: unknown): Progress {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Progress = {};
  for (const [id, max] of Object.entries(SEGMENTS)) {
    const value = Number(input[id]);
    out[id] = Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : DEFAULTS[id];
  }
  return out;
}

function tokenOk(req: IncomingMessage): boolean {
  const expected = process.env.PROGRESS_WRITE_TOKEN;
  if (!expected) return true;
  return req.headers['x-progress-token'] === expected;
}

/** Тело запроса: Vercel может разобрать его сам, иначе читаем поток. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null && parsed !== '') {
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // Состояние общее и меняется в любой момент — кешировать нечего.
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  const db = store();

  if (req.method === 'GET') {
    // Без хранилища чтение всё равно осмысленно: отдаём значения по умолчанию
    // и честно помечаем, что общего состояния нет. Ошибкой это не считаем —
    // иначе каждый посетитель видел бы красную плашку, пока идёт настройка.
    if (!db) {
      send({ progress: sanitize(DEFAULTS), editable: false, storage: false, problem: storageProblem() });
      return;
    }
    try {
      const stored = await db.get();
      send({ progress: sanitize(stored ?? DEFAULTS), editable: tokenOk(req), storage: true });
    } catch (e) {
      send({
        progress: sanitize(DEFAULTS),
        editable: false,
        storage: false,
        problem: `Хранилище не отвечает: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return;
  }

  if (req.method === 'PUT') {
    // А вот записать без хранилища нельзя, и молчать об этом нельзя тоже.
    if (!db) return send({ error: storageProblem() }, 503);
    if (!tokenOk(req)) return send({ error: 'Нет прав на изменение' }, 403);

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return send({ error: 'Ожидался JSON' }, 400);
    }

    const progress = sanitize((body as { progress?: unknown })?.progress ?? body);
    try {
      await db.set(progress);
    } catch (e) {
      return send({ error: e instanceof Error ? e.message : String(e) }, 503);
    }
    send({ progress, editable: true, storage: true });
    return;
  }

  send({ error: 'Метод не поддерживается' }, 405);
}
