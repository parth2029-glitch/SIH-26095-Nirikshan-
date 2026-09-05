/**
 * Client-side replay for the public verification page (§5, PRD F1).
 *
 * Two independent checks, both computed here:
 *
 *   1. The commitment. SHA-256(seed || cycleId) must equal the hash that was
 *      published before the draw — proof the seed was fixed in advance and not
 *      chosen afterwards to produce a convenient roster.
 *   2. The draw. Re-running assign() over the published inputs must reproduce
 *      the published assignments exactly — proof nobody edited the result.
 *
 * The engine is imported, never reimplemented: a second copy of the algorithm
 * would verify itself rather than the server.
 */
import { assign } from '/core/assign.js';

const out = document.getElementById('out');
const form = document.getElementById('form');
const input = document.getElementById('cycleId');

const el = (html) => Object.assign(document.createElement('div'), { innerHTML: html }).firstChild;
const esc = (text) =>
  String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function sha256Hex(text) {
  // Available on https and on localhost. A page served over plain http from
  // anywhere else has no crypto.subtle, and cannot honestly verify anything.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One line per pairing, sorted. Order-independent by construction: Mongo is
 * free to hand back rows in any order, and calling that tampering would report
 * MISMATCH on an honest cycle.
 */
const canonical = (rows, keys) =>
  rows
    .map((row) => keys.map((key) => row[key]).join(' '))
    .sort()
    .join('\n');

const PAIRING = ['instituteId', 'inspectorId', 'allocationType'];
const DEFERRAL = ['instituteId', 'reason'];

/** What actually differs, so a MISMATCH names the rows rather than asserting one. */
function diff(published, replayed) {
  const mine = new Map(replayed.map((r) => [r.instituteId, r]));
  const lines = [];
  for (const row of published) {
    const match = mine.get(row.instituteId);
    if (!match) {
      lines.push(`+ published  ${row.instituteId} -> ${row.inspectorId} (not in the replay)`);
    } else if (
      match.inspectorId !== row.inspectorId ||
      match.allocationType !== row.allocationType
    ) {
      lines.push(
        `~ ${row.instituteId}\n    published ${row.inspectorId} ${row.allocationType}\n    replayed  ${match.inspectorId} ${match.allocationType}`,
      );
    }
    mine.delete(row.instituteId);
  }
  for (const row of mine.values()) {
    lines.push(`- replayed   ${row.instituteId} -> ${row.inspectorId} (not published)`);
  }
  return lines.slice(0, 20).join('\n');
}

const check = (state, title, body, detail) =>
  el(
    `<div class="check ${state}"><span class="state">${state === 'pass' ? 'PASS' : state === 'fail' ? 'FAIL' : 'N/A'}</span>` +
      `<h3>${esc(title)}</h3><p>${body}</p>${detail ? `<pre>${esc(detail)}</pre>` : ''}</div>`,
  );

function verdict(state, headline, note) {
  out.prepend(
    el(`<div class="verdict ${state}"><h2>${esc(headline)}</h2><p>${esc(note)}</p></div>`),
  );
}

async function run(cycleId) {
  out.replaceChildren(el('<p>Fetching the published record…</p>'));

  const res = await fetch(`/api/cycles/${encodeURIComponent(cycleId)}/verify`);
  if (!res.ok) {
    out.replaceChildren();
    verdict('mismatch', 'NOT FOUND', `The server has no cycle ${cycleId}.`);
    return;
  }
  const record = await res.json();
  const { cycle, inputs, assignments, deferred } = record;
  out.replaceChildren();

  out.append(
    check(
      'pass',
      'Commitment published',
      `Published <code>${esc(cycle.commitmentPublishedAt ?? 'unknown')}</code>, before the draw.`,
      cycle.commitmentHash,
    ),
  );

  if (!cycle.seedRevealed) {
    out.append(
      check(
        'skip',
        'Seed still sealed',
        'The cycle has not closed. The commitment above is fixed and public; come back after the ' +
          'reveal and it must match the seed released then.',
      ),
    );
    verdict('', 'SEALED', 'Nothing to replay yet — the seed is revealed when the cycle closes.');
    return;
  }

  // ── 1. The commitment binds this seed to this cycle ────────────────────────
  const recomputed = await sha256Hex(`${cycle.seed}${cycle.id}`);
  const commitmentOk = recomputed === cycle.commitmentHash;
  out.append(
    check(
      commitmentOk ? 'pass' : 'fail',
      'SHA-256(seed || cycleId) equals the published commitment',
      commitmentOk
        ? 'The seed released today is the one committed to before the draw.'
        : 'The released seed does not hash to the published commitment — it was swapped.',
      `published  ${cycle.commitmentHash}\nrecomputed ${recomputed}\nseed       ${cycle.seed}`,
    ),
  );

  // ── 2. The draw replays to the same roster ─────────────────────────────────
  if (!inputs) {
    verdict('mismatch', 'INCOMPLETE', 'The cycle published no engine inputs — nothing to replay.');
    return;
  }

  const replay = assign(inputs.institutes, inputs.inspectors, inputs.history, cycle.seed, {
    ...cycle.config,
  });
  const drawOk = canonical(replay.assignments, PAIRING) === canonical(assignments, PAIRING);
  out.append(
    check(
      drawOk ? 'pass' : 'fail',
      `Replayed draw over ${inputs.institutes.length} institutes and ${inputs.inspectors.length} inspectors`,
      drawOk
        ? `All ${assignments.length} pairings reproduced from the seed alone.`
        : 'The stored roster is not what this seed produces.',
      drawOk ? null : diff(assignments, replay.assignments),
    ),
  );

  const deferredOk = canonical(replay.deferred, DEFERRAL) === canonical(deferred ?? [], DEFERRAL);
  out.append(
    check(
      deferredOk ? 'pass' : 'fail',
      `Deferred institutes: ${replay.deferred.length}`,
      deferredOk
        ? 'The institutes no inspector could take match the replay.'
        : 'The published deferral list is not what the engine produces.',
      replay.deferred.map((d) => `${d.instituteId} — ${d.reason}`).join('\n') || null,
    ),
  );

  const ok = commitmentOk && drawOk && deferredOk;
  verdict(
    ok ? 'match' : 'mismatch',
    ok ? 'MATCH' : 'MISMATCH',
    ok
      ? 'This cycle was drawn from the committed seed and has not been altered since.'
      : 'The published record does not follow from the committed seed. Treat this cycle as tampered.',
  );
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = input.value.trim();
  if (!id) return;
  history.replaceState(null, '', `?cycle=${encodeURIComponent(id)}`);
  run(id).catch((err) => {
    out.replaceChildren();
    verdict('mismatch', 'ERROR', err.message);
  });
});

const fromUrl = new URLSearchParams(location.search).get('cycle');
if (fromUrl) {
  input.value = fromUrl;
  form.requestSubmit();
}
