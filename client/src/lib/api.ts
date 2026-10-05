import type { Book, Decoration, Me, Prefs, ShelfResponse, SyncStatus } from '../types';

export interface AdminOverview {
  users: number; admins: number; sessions: number; books: number; shelvings: number;
  covers: number; palettes: number; realDimensions: number;
  enrichPending: number; enrichFailed: number;
  demoBooks: number; demoCoversPending: number;
  signupsEnabled: boolean;
  cooldowns: Array<{ host: string; until: string; reason: string }>;
  capability: { perPage200Works: string | null; pageParamWorks: string | null };
}

export interface AdminUser {
  id: number; username: string; email: string | null;
  goodreads_user_id: string | null; has_rss_key: number;
  is_admin: number; created_at: string; last_sync_at: string | null;
  books: number; sessions: number;
  last_status: string | null; last_error: string | null;
}

export interface AdminRun {
  id: number; username: string; started_at: string; finished_at: string | null;
  trigger: string; status: string; pages_fetched: number; items_seen: number;
  books_new: number; books_updated: number; error: string;
}

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
  config: () => call<{ signupsEnabled: boolean }>('/auth/config'),
  me: () => call<Me>('/auth/me'),

  login: (username: string, password: string) =>
    call<{ token: string; user: Me }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (body: {
    username: string; password: string;
    goodreadsUserId?: string; goodreadsRssKey?: string;
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

  /** Your own rating and notes. Separate from anything Goodreads sends. */
  saveBook: (id: string, body: { myRating?: number | null; notes?: string }) =>
    call<Book>(`/books/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  /** The public shelf shown before sign-in. No credentials required. */
  demoBooks: () => call<ShelfResponse & { demo: true }>('/demo/books'),

  updateAccount: (body: { goodreadsUserId?: string; goodreadsRssKey?: string }) =>
    call<Me>('/auth/account', { method: 'PATCH', body: JSON.stringify(body) }),

  changePassword: (currentPassword: string, newPassword: string) =>
    call<{ ok: true }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  decorations: {
    list: () => call<Decoration[]>('/decorations'),
    add: (body: { kind?: string; caption?: string; shelfIndex: number; position: number; image?: string }) =>
      call<Decoration>('/decorations', { method: 'POST', body: JSON.stringify(body) }),
    move: (id: number, body: { shelfIndex?: number; position?: number; caption?: string; heightMm?: number }) =>
      call<Decoration>(`/decorations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: number) => call<{ ok: true }>(`/decorations/${id}`, { method: 'DELETE' }),
  },

  syncStatus: () => call<SyncStatus>('/sync/status'),

  admin: {
    overview: () => call<AdminOverview>('/admin/overview'),
    users: () => call<AdminUser[]>('/admin/users'),
    runs: () => call<AdminRun[]>('/admin/runs'),
    patchUser: (id: number, body: { isAdmin?: boolean; goodreadsUserId?: string }) =>
      call<unknown>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    resetPassword: (id: number, newPassword: string) =>
      call<{ ok: true }>(`/admin/users/${id}/password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
    signOutUser: (id: number) =>
      call<{ revoked: number }>(`/admin/users/${id}/signout`, { method: 'POST' }),
    syncUser: (id: number) =>
      call<{ queued: boolean }>(`/admin/users/${id}/sync`, { method: 'POST' }),
    deleteUser: (id: number) =>
      call<{ ok: true }>(`/admin/users/${id}`, { method: 'DELETE' }),
    setSignups: (signupsEnabled: boolean) =>
      call<{ signupsEnabled: boolean }>('/admin/settings', { method: 'PATCH', body: JSON.stringify({ signupsEnabled }) }),
    reenrich: () => call<{ queued: number }>('/admin/reenrich', { method: 'POST' }),
  },
  runSync: () => call<{ queued: boolean }>('/sync/run', { method: 'POST' }),
};
