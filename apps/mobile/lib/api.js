import * as session from './session.js';

const BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.0.2.2:4000';

/** Thrown with the server's own `error.code` so screens can branch on it. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const bearer = auth ? await session.token() : null;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(bearer && { authorization: `Bearer ${bearer}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { code = 'UNKNOWN', message = `Request failed (${res.status}).` } = payload.error ?? {};
    throw new ApiError(res.status, code, message);
  }
  return payload;
}

export async function login(email, password) {
  const deviceId = await session.deviceId();
  const result = await request('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password, deviceId },
  });
  await session.save(result);
  return result;
}

/**
 * The whole inbox in one call — assignments, their institutes, and the checklist
 * JSON for every scheme referenced. Cached whole so an inspection runs with no
 * connectivity (docs/API.md, PRD F2).
 */
export const myAssignments = (status = 'PENDING') =>
  request(`/api/assignments/mine?status=${status}`);

// ── Inbox cache ──────────────────────────────────────────────────────────────
// ponytail: a module variable, so it dies with the process. §9 replaces this
// with the expo-sqlite `reports`/`evidence`/`outbox` schema, which is where
// durable offline state belongs. Until then the inbox screen is the only
// fetcher and the detail/form screens read what it stored.
let cache = { assignments: [], checklists: {}, serverTime: null };

export function cacheInbox(payload) {
  cache = payload;
  return payload;
}

export const cachedInbox = () => cache;
export const cachedAssignment = (id) => cache.assignments.find((a) => a.id === id) ?? null;
export const cachedChecklist = (id) => cache.checklists[id] ?? null;
