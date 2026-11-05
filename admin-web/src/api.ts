// Calls the GoMax API (/v1/admin/*). Access token (15 min) in memory; refresh
// token (1 day for staff) in localStorage so a reload keeps you signed in.
// A 401 refreshes once and retries; if that fails you are signed out.

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const RT_KEY = 'gomax-admin-rt';

export type Role = 'owner' | 'accounts' | 'factory' | 'helpline' | 'ops';
export type Staff = { id: string; name: string; role: Role; loginId?: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn);

const store = {
  get: () => {
    try {
      return localStorage.getItem(RT_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(RT_KEY, v);
      else localStorage.removeItem(RT_KEY);
    } catch {
      /* private mode: stay signed in for this tab only */
    }
  },
};

async function raw(method: string, path: string, body?: unknown, token = accessToken) {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the GoMax server. Check the internet and try again.');
  }
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string; issues?: unknown; until?: string } })?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? 'Something went wrong. Try again.', e);
  }
  return data;
}

// Refresh tokens rotate (each works once). Several admin tabs share the saved token, so
// refreshes are serialised across tabs (Web Locks) and each reads the latest token inside
// the lock; a 401 only signs out if no other tab has rotated the token meanwhile.
async function rotate(): Promise<boolean> {
  const rt = store.get();
  if (!rt) return false;
  try {
    const r: { accessToken: string; refreshToken: string } = await raw('POST', '/v1/admin/auth/refresh', { refreshToken: rt }, null);
    accessToken = r.accessToken;
    store.set(r.refreshToken);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && store.get() === rt) {
      accessToken = null;
      store.set(null);
      return false;
    }
    // Another tab rotated it at the same moment: try once more with the new one.
    if (store.get() && store.get() !== rt) return rotate();
    return false;
  }
}

let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const run: Promise<boolean> = locks ? locks.request('gomax-admin-refresh', rotate).then((ok) => ok) : rotate();
  refreshing ??= run.finally(() => (refreshing = null));
  return refreshing;
}

export async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `/v1/admin${path}`;
  if (!accessToken && !(await refresh())) {
    onSignedOut();
    throw new ApiError(401, 'signed_out', 'Please log in again.');
  }
  try {
    return await raw(method, url, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refresh())) return raw(method, url, body);
    if (e instanceof ApiError && e.status === 401) onSignedOut();
    throw e;
  }
}

export const api = {
  get: <T = any>(path: string) => call<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T = any>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T = any>(path: string, body: unknown) => call<T>('PATCH', path, body),
};

export async function login(loginId: string, password: string): Promise<Staff> {
  const r = await raw('POST', '/v1/admin/auth/login', { loginId, password }, null);
  accessToken = r.accessToken;
  store.set(r.refreshToken);
  return r.staff;
}

export async function restore(): Promise<Staff | null> {
  if (!store.get() || !(await refresh())) return null;
  try {
    return await raw('GET', '/v1/admin/auth/me');
  } catch {
    return null;
  }
}

export async function logout() {
  const rt = store.get();
  if (rt) await raw('POST', '/v1/admin/auth/logout', { refreshToken: rt }).catch(() => {});
  accessToken = null;
  store.set(null);
}

async function authedFetch(path: string) {
  if (!accessToken) await refresh();
  let res = await fetch(`${BASE}/v1/admin${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 && (await refresh())) res = await fetch(`${BASE}/v1/admin${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new ApiError(res.status, 'download_failed', res.status === 403 ? 'Your login cannot download this.' : 'Download failed. Try again.');
  return res;
}

/** Text of a file the API serves (the print CSV). */
export const csvText = async (path: string) => (await authedFetch(path)).text();

/** Downloads a file the API serves (CSV export) with the auth header. */
export async function download(path: string, filename: string) {
  const res = await authedFetch(path);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Upload: ask the API for a signed URL, PUT the file to Cloud Storage, return the
 * object name. In local dev the API's storage is in memory (memory:// URL) and the
 * object counts as uploaded already.
 */
export async function upload(purpose: 'payment_proof' | 'delivery_photo' | 'tds', file: File): Promise<string> {
  const s = await api.post<{ object: string; url: string; headers: Record<string, string> }>('/uploads', { purpose, contentType: file.type });
  if (!s.url.startsWith('memory://')) {
    const res = await fetch(s.url, { method: 'PUT', headers: s.headers, body: file });
    if (!res.ok) throw new ApiError(res.status, 'upload_failed', 'Upload failed. Try again.');
  }
  return s.object;
}

/** Image URLs from the API; memory:// (local dev) can't be shown. */
export const viewable = (url?: string | null) => (url && /^https?:/.test(url) ? url : null);
