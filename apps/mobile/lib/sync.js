/**
 * The outbox drain (§9, PRD F2).
 *
 * There is no connectivity listener here on purpose. `@react-native-community/
 * netinfo` would add a native module to answer a question a failed `fetch`
 * already answers, and "the radio says connected" is not the same as "the
 * server is reachable from this valley" — the retry has to exist either way.
 * So: a ticker, an exponential backoff, and the failure itself as the signal.
 */
import { ApiError, submitReports } from './api.js';
import { dueOutbox, markOutbox, outboxCounts } from './db.js';

const BATCH = 20;
const TICK_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** 5 s, 10 s, 20 s … capped at 15 min. Full jitter would need a shared clock. */
const backoffMs = (attempts) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);

let running = false;
let ticker = null;
const listeners = new Set();

const notify = async () => {
  const counts = await outboxCounts();
  listeners.forEach((listener) => listener(counts));
};

/** Subscribe the status indicator. Returns its own unsubscribe. */
export function onChange(listener) {
  listeners.add(listener);
  notify();
  return () => listeners.delete(listener);
}

async function fail(row, message) {
  const attempts = row.attempts + 1;
  await markOutbox(row.clientId, {
    status: 'FAILED',
    attempts,
    lastError: message.slice(0, 500),
    nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
  });
}

/**
 * One pass. Safe to call concurrently — the second caller returns immediately
 * rather than sending the same rows twice.
 */
export async function drain() {
  if (running) return;
  running = true;
  try {
    const rows = await dueOutbox(BATCH);
    if (rows.length === 0) return;

    await Promise.all(rows.map((row) => markOutbox(row.clientId, { status: 'SENDING' })));
    await notify();

    let response;
    try {
      // The batch's own clientIds are the idempotency key: the same set of
      // reports retries as the same batch, and a re-cut batch is a new one.
      const key = rows.map((row) => row.clientId).join(',');
      response = await submitReports(
        rows.map((row) => row.payload),
        key,
      );
    } catch (err) {
      // A 4xx that is not 401 means this batch will never be accepted as it
      // stands, but the row still backs off rather than being dropped — an
      // inspector's work is not thrown away because the server disliked it.
      const reason = err instanceof ApiError ? `${err.code}: ${err.message}` : String(err.message);
      await Promise.all(rows.map((row) => fail(row, reason)));
      return;
    }

    const byClientId = new Map(response.results.map((result) => [result.clientId, result]));
    for (const row of rows) {
      const result = byClientId.get(row.clientId);
      if (result?.status === 'ACCEPTED') {
        await markOutbox(row.clientId, { status: 'DONE', serverId: result.reportId, lastError: null });
      } else {
        await fail(row, result?.error?.message ?? 'No result returned for this report.');
      }
    }
  } finally {
    running = false;
    await notify();
  }
}

/** Started once, by the inbox screen. Idempotent. */
export function start() {
  if (ticker) return;
  ticker = setInterval(() => {
    drain().catch(() => {});
  }, TICK_MS);
  drain().catch(() => {});
}

export function stop() {
  clearInterval(ticker);
  ticker = null;
}
