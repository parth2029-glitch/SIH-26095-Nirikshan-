/**
 * The device's own store (§9, PRD F2).
 *
 * An inspection runs where there is no signal, so SQLite is the source of truth
 * on the handset and the network is a background detail. Four tables, one per
 * lifetime: an `inbox` blob that is whatever the server last said, a `reports`
 * draft that grows as the form is filled, `evidence` rows that outlive the
 * draft because the file upload is a separate request (§10), and an `outbox`
 * that owns delivery.
 */
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS reports (
  clientId      TEXT PRIMARY KEY,
  assignmentId  TEXT NOT NULL UNIQUE,
  answers       TEXT NOT NULL DEFAULT '{}',
  updatedAt     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  clientId        TEXT PRIMARY KEY,
  reportClientId  TEXT NOT NULL,
  itemId          TEXT NOT NULL,
  uri             TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  deviceDHash     TEXT NOT NULL,
  capturedAt      TEXT NOT NULL,
  location        TEXT,
  uploaded        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS evidence_report ON evidence (reportClientId);
CREATE TABLE IF NOT EXISTS inbox (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  clientId       TEXT PRIMARY KEY,
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  attempts       INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt  TEXT NOT NULL,
  lastError      TEXT,
  serverId       TEXT
);
`;

// ponytail: one connection for the whole app, opened lazily. A second one would
// need WAL reader coordination and this app has exactly one writer — the UI.
//
// The *promise* is memoised, not the handle: the inbox and the sync worker both
// call this on the first frame, and a handle published before `execAsync`
// finished would hand the second caller a database with no tables in it.
let opening = null;

export function db() {
  opening ??= (async () => {
    const conn = await SQLite.openDatabaseAsync('nirikshan.db');
    await conn.execAsync(SCHEMA);
    // A process killed mid-send leaves a row claimed by nobody. Reclaiming it
    // at startup is what makes "kill the app mid-sync" resumable rather than
    // stuck: the send is idempotent server-side, so retrying is always safe.
    await conn.runAsync(`UPDATE outbox SET status = 'PENDING' WHERE status = 'SENDING'`);
    return conn;
  })();
  return opening;
}

/**
 * The draft for one assignment, created on first touch. `clientId` is minted
 * once and never changes, which is what makes a resumed draft submit as the
 * same report rather than a second one.
 */
export async function draftFor(assignmentId) {
  const conn = await db();
  const existing = await conn.getFirstAsync('SELECT * FROM reports WHERE assignmentId = ?', [
    assignmentId,
  ]);
  if (existing) return { ...existing, answers: JSON.parse(existing.answers) };

  const row = {
    clientId: Crypto.randomUUID(),
    assignmentId,
    answers: '{}',
    updatedAt: new Date().toISOString(),
  };
  await conn.runAsync(
    'INSERT INTO reports (clientId, assignmentId, answers, updatedAt) VALUES (?, ?, ?, ?)',
    [row.clientId, row.assignmentId, row.answers, row.updatedAt],
  );
  return { ...row, answers: {} };
}

/**
 * Write-through: the whole answer map on every change (§9).
 *
 * ponytail: rewriting a two-kilobyte blob per keystroke, rather than one row
 * per answer. At forty questions that is a sub-millisecond write and it keeps
 * the read path a single `JSON.parse`. Split the table if a checklist ever
 * grows large enough to feel it.
 */
export async function saveAnswers(clientId, answers) {
  const conn = await db();
  await conn.runAsync('UPDATE reports SET answers = ?, updatedAt = ? WHERE clientId = ?', [
    JSON.stringify(answers),
    new Date().toISOString(),
    clientId,
  ]);
}

export async function saveEvidence(reportClientId, item) {
  const conn = await db();
  await conn.runAsync(
    `INSERT OR REPLACE INTO evidence
       (clientId, reportClientId, itemId, uri, sha256, deviceDHash, capturedAt, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.clientId,
      reportClientId,
      item.itemId,
      item.uri,
      item.sha256,
      item.deviceDHash,
      item.capturedAt,
      item.location ? JSON.stringify(item.location) : null,
    ],
  );
}

export async function evidenceFor(reportClientId) {
  const conn = await db();
  const rows = await conn.getAllAsync('SELECT * FROM evidence WHERE reportClientId = ?', [
    reportClientId,
  ]);
  return rows.map((row) => ({ ...row, location: row.location && JSON.parse(row.location) }));
}

/**
 * The last `GET /api/assignments/mine` response, whole (§9).
 *
 * One row, one blob, no schema: the payload is the API's shape and normalising
 * it here would buy a second definition of the same thing to keep in step. It
 * exists because an inspector who reopens the app in a valley still has to see
 * the assignment and its checklist — a module variable dies with the process,
 * and §7's cache was one.
 */
export async function saveInbox(payload) {
  const conn = await db();
  await conn.runAsync(
    'INSERT OR REPLACE INTO inbox (id, payload, fetchedAt) VALUES (1, ?, ?)',
    [JSON.stringify(payload), new Date().toISOString()],
  );
}

export async function loadInbox() {
  const conn = await db();
  const row = await conn.getFirstAsync('SELECT payload FROM inbox WHERE id = 1');
  return row ? JSON.parse(row.payload) : null;
}

/** Hands a signed report to the outbox. Delivery is `sync.js`'s problem now. */
export async function enqueue(clientId, payload) {
  const conn = await db();
  await conn.runAsync(
    `INSERT OR REPLACE INTO outbox (clientId, payload, status, attempts, nextAttemptAt)
     VALUES (?, ?, 'PENDING', 0, ?)`,
    [clientId, JSON.stringify(payload), new Date().toISOString()],
  );
}

export async function dueOutbox(limit) {
  const conn = await db();
  const rows = await conn.getAllAsync(
    `SELECT * FROM outbox WHERE status IN ('PENDING', 'FAILED') AND nextAttemptAt <= ?
     ORDER BY nextAttemptAt LIMIT ?`,
    [new Date().toISOString(), limit],
  );
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

// Column names go into the SQL text, so they come from here and nowhere else.
const OUTBOX_COLUMNS = ['status', 'attempts', 'nextAttemptAt', 'lastError', 'serverId'];

export async function markOutbox(clientId, patch) {
  const conn = await db();
  const keys = Object.keys(patch);
  if (!keys.every((key) => OUTBOX_COLUMNS.includes(key))) {
    throw new Error(`markOutbox(): unknown column in ${keys.join(', ')}`);
  }
  await conn.runAsync(
    `UPDATE outbox SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE clientId = ?`,
    [...keys.map((k) => patch[k]), clientId],
  );
}

/** What the sync indicator shows: `{ PENDING: 2, DONE: 7, ... }`. */
export async function outboxCounts() {
  const conn = await db();
  const rows = await conn.getAllAsync('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status');
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
