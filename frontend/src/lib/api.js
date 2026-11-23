// Thin fetch wrapper: JSON in/out, CSRF header, uniform errors.

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }

  /** The request never reached the server (offline, DNS, server down). */
  get isNetwork() {
    return this.status === 0;
  }
}

async function parseError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error body (proxy error page, etc.)
  }
  const error = payload?.error ?? {};
  return new ApiError(
    response.status,
    error.code ?? 'http_error',
    error.message ?? `Request failed (${response.status})`,
    error,
  );
}

export async function request(method, url, body, options = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin', ...options };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }
  if (response.status === 401 && !options.noAuthRedirect) {
    // Session ended: send the user to sign in and come back afterwards.
    const next = encodeURIComponent(location.pathname);
    location.assign(`/login?next=${next}`);
    throw new ApiError(401, 'unauthorized', 'Your session has ended');
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  get: (url, options) => request('GET', url, undefined, options),
  post: (url, body, options) => request('POST', url, body ?? {}, options),
  put: (url, body, options) => request('PUT', url, body ?? {}, options),
  patch: (url, body, options) => request('PATCH', url, body ?? {}, options),
  delete: (url, options) => request('DELETE', url, undefined, options),
  upload(url, file) {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('POST', url, form);
  },
};
