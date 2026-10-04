import type { Book, Me, Prefs, ShelfResponse, SyncStatus } from '../types';

/**
 * The only fetch layer in the client, and a direct mirror of docs/API.md.
 * Keeping it in one file is what makes the API contract reviewable -- and what
 * a future SwiftUI client would be written against.
 *
 * The session cookie carries auth in the browser (so an XSS cannot read the
 * token); the same endpoints accept Authorization: Bearer for native clients.
 */

const BASE = '/api/v1';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `request failed (${res.status})`);
  return data as T;
}

export const api = {
  config: () => call<{ invitesEnabled: boolean }>('/auth/config'),
  me: () => call<Me>('/auth/me'),

  login: (email: string, password: string) =>
    call<{ token: string; user: Me }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (body: {
    inviteCode: string; email: string; password: string;
    goodreadsUserId: string; goodreadsRssKey?: string;
  }) =>
    call<{ token: string; user: Me }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

  savePrefs: (prefs: Partial<Prefs>) =>
    call<Prefs>('/auth/prefs', { method: 'PATCH', body: JSON.stringify(prefs) }),

  books: () => call<ShelfResponse>('/books'),
  book: (id: string) => call<Book>(`/books/${id}`),

  syncStatus: () => call<SyncStatus>('/sync/status'),
  runSync: () => call<{ queued: boolean }>('/sync/run', { method: 'POST' }),
};
