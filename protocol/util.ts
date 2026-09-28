// Small runtime helpers shared by the server, SDK and dashboard. No dependencies, safe in any
// runtime (browser, Bun, workers).

export type Result<T, E = unknown> = { ok: true; value: T; error?: undefined } | { ok: false; value?: undefined; error: E };

/**
 * Run `fn` and return its outcome instead of throwing. Async functions (and promises) resolve to
 * a Result too:
 *
 *   const r = tryCatch(() => JSON.parse(text));
 *   if (!r.ok) return badRequest();
 *   const res = await tryCatch(fetch(url));
 */
export function tryCatch<T, E = unknown>(promise: PromiseLike<T>): Promise<Result<T, E>>;
export function tryCatch<T, E = unknown>(fn: () => PromiseLike<T>): Promise<Result<T, E>>;
export function tryCatch<T, E = unknown>(fn: () => T): Result<T, E>;
export function tryCatch<T, E>(input: PromiseLike<T> | (() => T | PromiseLike<T>)): Result<T, E> | Promise<Result<T, E>> {
  const settle = (p: PromiseLike<T>) =>
    Promise.resolve(p).then(
      (value): Result<T, E> => ({ ok: true, value }),
      (error: E): Result<T, E> => ({ ok: false, error }),
    );
  if (typeof input !== 'function') return settle(input);
  try {
    const value = input();
    return isThenable(value) ? settle(value) : { ok: true, value };
  } catch (error) {
    return { ok: false, error: error as E };
  }
}

/** `fn()`, or `fallback` if it throws. For the common "ignore the error" case. */
export function attempt<T, F = undefined>(fn: () => T, fallback?: F): T | F {
  try {
    return fn();
  } catch {
    return fallback as F;
  }
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as PromiseLike<unknown>).then === 'function';

export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
}

/**
 * Web Storage that never throws: missing (server, worker), blocked (private mode, sandboxed
 * iframe, cleared site data) and full storage all read as empty and drop writes.
 */
export function safeStorage(kind: 'local' | 'session' = 'local'): SafeStorage {
  const store = (): Storage | undefined =>
    attempt(() => (kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage));
  const get = (key: string) => attempt(() => store()?.getItem(key) ?? null, null);
  const set = (key: string, value: string) => void attempt(() => store()?.setItem(key, value));
  return {
    get,
    set,
    remove: (key) => void attempt(() => store()?.removeItem(key)),
    getJSON: <T>(key: string) => {
      const raw = get(key);
      return raw === null ? null : attempt(() => JSON.parse(raw) as T, null);
    },
    setJSON: (key, value) => void attempt(() => store()?.setItem(key, JSON.stringify(value))),
  };
}
