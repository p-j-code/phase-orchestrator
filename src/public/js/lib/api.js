// HTTP client. Bearer auth from localStorage; 401 triggers the registered handler.

const TOKEN_KEY = 'ashmero_token';

let _onUnauthorized = null;

export class ApiError extends Error {
  constructor(message, { status = 0, data = null, method = '', path = '', cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.method = method;
    this.path = path;
    this.code = data && typeof data === 'object' ? (data.code || null) : null;
    this.details = data && typeof data === 'object' ? (data.details ?? null) : null;
    this.log = data && typeof data === 'object' ? (data.log ?? null) : null;
  }
}

// Extract diagnostics without forcing every modal to know the response shape.
// Server routes may return log/details/stdout/stderr depending on the operation.
export function apiErrorLines(error) {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const lines = [];
  const add = (value) => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') lines.push(JSON.stringify(value, null, 2));
    else if (value !== undefined && value !== null && String(value).trim()) lines.push(String(value));
  };
  add(data.log);
  add(data.details);
  add(data.stderr);
  add(data.stdout);
  if (!lines.length && data.raw && data.raw !== error?.message) add(data.raw);
  return [...new Set(lines)];
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function onUnauthorized(fn) {
  _onUnauthorized = fn;
}

export async function api(method, path, body, { signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch('/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ApiError('Request cancelled', { method, path, cause: e });
    }
    throw new ApiError('Cannot reach server', { method, path, cause: e });
  }

  if (resp.status === 401) {
    if (_onUnauthorized) _onUnauthorized();
    throw new ApiError('Unauthorized', { status: 401, method, path });
  }

  let data = null;
  const text = await resp.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!resp.ok) {
    const message = (data && (data.error || data.message)) || `Request failed (${resp.status})`;
    throw new ApiError(message, { status: resp.status, data, method, path });
  }
  return data;
}

/** Fetch an authenticated binary response without bypassing logout handling. */
export async function apiDownload(path, { signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  let resp;
  try {
    resp = await fetch('/api' + path, { method: 'GET', headers, signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ApiError('Request cancelled', { method: 'GET', path, cause: e });
    throw new ApiError('Cannot reach server', { method: 'GET', path, cause: e });
  }
  if (resp.status === 401) {
    if (_onUnauthorized) _onUnauthorized();
    throw new ApiError('Unauthorized', { status: 401, method: 'GET', path });
  }
  if (!resp.ok) {
    const raw = await resp.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw ? { raw } : null; }
    throw new ApiError(data?.error || data?.message || `Request failed (${resp.status})`, {
      status: resp.status, data, method: 'GET', path,
    });
  }
  const disposition = resp.headers.get('content-disposition') || '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const basic = disposition.match(/filename="([^"]+)"/i);
  let filename = '';
  try { filename = decodeURIComponent(utf8?.[1] || basic?.[1] || ''); }
  catch { filename = basic?.[1] || ''; }
  return { blob: await resp.blob(), filename };
}
