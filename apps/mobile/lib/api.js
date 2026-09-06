import * as session from './session.js';
import { loadInbox, saveInbox } from './db.js';

const BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://10.0.2.2:4000';

/** Thrown with the server's own `error.code` so screens can branch on it. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, auth = true, headers } = {}) {
  const bearer = auth ? await session.token() : null;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(bearer && { authorization: `Bearer ${bearer}` }),
      ...headers,
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

/**
 * The outbox drain (§9). The idempotency key is the caller's, not a fresh one
 * per attempt: a retry of the same batch has to look like the same batch.
 */
export const submitReports = (reports, idempotencyKey) =>
  request('/api/reports', {
    method: 'POST',
    body: { reports },
    headers: { 'idempotency-key': idempotencyKey },
  });

// ── Inbox cache ──────────────────────────────────────────────────────────────
// A module variable in front of SQLite, not instead of it (§9). The read path
// stays synchronous because `assignment/[id]` and `inspect/[id]` render from it
// directly; the write goes through to disk so a process killed in a valley
// comes back with the same inbox.
let cache = { assignments: [], checklists: {}, serverTime: null };

export function cacheInbox(payload) {
  cache = payload;
  saveInbox(payload).catch(() => {});
  return payload;
}

/** Fills the module cache from disk. Returns null when nothing was stored. */
export async function hydrateInbox() {
  const stored = await loadInbox();
  if (stored) cache = stored;
  return stored;
}

export const cachedInbox = () => cache;
export const cachedAssignment = (id) => cache.assignments.find((a) => a.id === id) ?? null;
export const cachedChecklist = (id) => cache.checklists[id] ?? null;
