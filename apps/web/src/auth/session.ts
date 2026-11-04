import type { ErrorBody } from '@ts-rtc/protocol';

/**
 * The access token lives in memory and sessionStorage: it survives a reload, not a closed tab.
 * sessionStorage is readable by any script on the page, so an XSS bug would leak it,
 * an HttpOnly cookie is the v2 answer.
 */
const KEY = 'ts-rtc.accessToken';
let current: string | null = null;

export const accessToken = {
  get(): string | null {
    try {
      current ??= sessionStorage.getItem(KEY);
    } catch {
      // storage blocked: memory only
    }
    return current;
  },
  set(token: string | null): void {
    current = token;
    try {
      if (token) sessionStorage.setItem(KEY, token);
      else sessionStorage.removeItem(KEY);
    } catch {
      // storage blocked: memory only
    }
  },
};

/** Forgets the token; the app shows the login page (also on 401 and on close code 4401). */
export function signOut(): void {
  accessToken.set(null);
  window.dispatchEvent(new Event('ts-rtc:signed-out'));
}

/** Calls the HTTP API with the token; throws the server's error message. 401 signs out. */
export async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const token = accessToken.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: ErrorBody };
  if (res.ok) return json;
  if (res.status === 401 && token) signOut();
  throw new Error(json.error?.message ?? `${String(res.status)} ${res.statusText}`);
}
