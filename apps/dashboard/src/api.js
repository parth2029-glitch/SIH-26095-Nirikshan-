/**
 * The API seam, and the token.
 *
 * There is no mock layer. §13's plan called for one so the screens would not
 * wait on the backend — the backend landed first, so a fixture layer would only
 * be a second set of shapes to keep in step with `docs/API.md`. `npm run seed`
 * is the fixture: a real database, drawn by the real engine, in twelve seconds.
 *
 * The token lives in `localStorage` because this is a browser app talking to a
 * bearer-token API on a different origin in development. That is a real
 * trade-off — an XSS on this page reaches the token — and the answer when the
 * dashboard leaves the demo is an httpOnly cookie plus CSRF, which needs a
 * server-side session §2 does not have.
 *
 * ponytail: localStorage bearer token. Move to an httpOnly cookie when §16
 * puts the API and this build behind one origin.
 */
const KEY = 'nirikshan.session';

export const session = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? null;
    } catch {
      return null;
    }
  },
  write(value) {
    localStorage.setItem(KEY, JSON.stringify(value));
  },
  clear() {
    localStorage.removeItem(KEY);
  },
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = session.read()?.token;
  const res = await fetch(path, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // An expired token is not an error the screen should render — it is a
    // logout. Everything else is the caller's to show.
    if (res.status === 401) {
      session.clear();
      location.reload();
    }
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'UNKNOWN',
      json?.error?.message ?? res.statusText,
    );
  }
  return json;
}

/** Same token, but the response is bytes — thumbnails, and nothing else yet. */
export async function blob(path) {
  const token = session.read()?.token;
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'FETCH_FAILED', res.statusText);
  return res.blob();
}

export const login = (email, password) =>
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then(async (res) => {
    const json = await res.json().catch(() => null);
    if (!res.ok)
      throw new ApiError(res.status, json?.error?.code, json?.error?.message ?? 'Login failed.');
    return json;
  });
