import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Локальная замена `api/progress.ts`.
 *
 * На проде ход строительства держит Edge-функция на Vercel поверх Redis, но
 * `npm run dev` про Vercel ничего не знает: запрос к `/api/progress` попадал
 * в обычную раздачу файлов, и клиент получал исходник функции вместо JSON.
 *
 * Поэтому в деве тот же контракт обслуживает это middleware, а состояние
 * лежит в `.progress-dev.json` рядом с проектом (файл в .gitignore). Правила
 * проверки чисел повторяют серверные, справочники читаются из тех же JSON —
 * расходиться нечему.
 *
 * Альтернатива — `vercel dev`, но она требует CLI, привязки проекта и живого
 * Redis; для правки трёх чисел это лишнее.
 */

const SEGMENTS: Record<string, number> = Object.fromEntries(
  (JSON.parse(readFileSync(resolve('src/data/road-segments.json'), 'utf8')) as Array<{
    id: string;
    lengthKm: number;
  }>).map((s) => [s.id, s.lengthKm]),
);

const DEFAULTS = JSON.parse(
  readFileSync(resolve('src/data/road-progress.json'), 'utf8'),
) as Record<string, number>;

const STORE = resolve('.progress-dev.json');

function sanitize(raw: unknown): Record<string, number> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [id, max] of Object.entries(SEGMENTS)) {
    const value = Number(input[id]);
    out[id] = Number.isFinite(value)
      ? Math.min(Math.max(Math.round(value), 0), max)
      : (DEFAULTS[id] ?? 0);
  }
  return out;
}

function read(): Record<string, number> {
  if (!existsSync(STORE)) return sanitize(DEFAULTS);
  try {
    return sanitize(JSON.parse(readFileSync(STORE, 'utf8')));
  } catch {
    return sanitize(DEFAULTS);
  }
}

function progressDevApi(): Plugin {
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/api/progress') return next();

    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET') {
      // В деве прав всегда достаточно: токен проверяется только на проде.
      // storage: true — в деве хранилище есть, это `.progress-dev.json`.
      send({ progress: read(), editable: true, storage: true });
      return;
    }

    if (req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw) as { progress?: unknown };
          const progress = sanitize(body?.progress ?? body);
          writeFileSync(STORE, `${JSON.stringify(progress, null, 2)}\n`);
          send({ progress, editable: true, storage: true });
        } catch {
          send({ error: 'Ожидался JSON' }, 400);
        }
      });
      return;
    }

    send({ error: 'Метод не поддерживается' }, 405);
  };

  return {
    name: 'progress-dev-api',
    // Не в возвращаемой функции, а прямо здесь: иначе middleware встанет
    // после раздачи файлов, и запрос снова уйдёт в исходник функции.
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

export default defineConfig({
  plugins: [react(), progressDevApi()],
  server: {
    port: 5173,
    open: true,
  },
});
