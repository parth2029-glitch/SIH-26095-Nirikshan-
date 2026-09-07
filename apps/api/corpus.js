/**
 * The dHash corpus L1 compares against (§11, PRD F3).
 *
 * Held in memory because the question — "is this photograph within 6 bits of
 * anything we have ever been sent?" — is not one an index answers. Hamming
 * distance has no ordering, so a B-tree cannot help; the `dHashBands` multikey
 * index exists for the day the corpus stops fitting in RAM, and that day is not
 * Phase 1. At demo scale (12 cycles × a few thousand photographs) the whole
 * corpus is well under a megabyte of BigInts and a full scan is microseconds.
 *
 * ponytail: single process, whole corpus, linear scan. A second API instance
 * would each hold their own copy and both would still be correct — they only go
 * stale about uploads the other one took, which self-heals on restart. Move to
 * a banded pre-filter (`dHashBands` is already written and indexed) when either
 * the scan or the memory shows up in a profile.
 */
import { distance } from '@nirikshan/core/hamming';
import { fromHex } from '@nirikshan/core/dhash';
import { TRUST_THRESHOLDS } from '@nirikshan/core/constants';
import { EvidenceItem } from './models.js';

/** @type {Promise<{hash: bigint, evidenceId: string, reportId: string}[]> | null} */
let loading = null;

/**
 * One projection query, memoised. The promise is what is cached, not the array:
 * §11's first two scorers can land in the same tick, and a second query would
 * be pure waste.
 */
function corpus() {
  loading ??= EvidenceItem.find({}, 'dHash reportId')
    .lean()
    .then((docs) =>
      docs.map((doc) => ({
        hash: fromHex(doc.dHash),
        evidenceId: doc._id.toString(),
        reportId: doc.reportId.toString(),
      })),
    )
    .catch((err) => {
      loading = null; // a failed warm must not poison every later scan
      throw err;
    });
  return loading;
}

/** Called at boot (server.js) so the first scored report pays no warm-up. */
export const warm = () => corpus().then((rows) => rows.length);

/** Keeps the corpus current without a re-query — §10 calls this on every upload. */
export async function add(row) {
  (await corpus()).push(row);
}

/**
 * Every stored photograph within `max` bits of `hash`, nearest first.
 *
 * @param {bigint} hash
 * @param {object} [options]
 * @param {number} [options.max] Hamming distance counted as the same image.
 * @param {string} [options.excludeReportId] The report being scored — its own
 *   evidence is not a reuse of itself, and a resubmitted batch would otherwise
 *   flag against the copy it just stored.
 */
export async function nearest(hash, { max = TRUST_THRESHOLDS.dhashHamming, excludeReportId } = {}) {
  const hits = [];
  for (const row of await corpus()) {
    if (row.reportId === excludeReportId) continue;
    const d = distance(hash, row.hash);
    if (d <= max) hits.push({ ...row, distance: d });
  }
  return hits.sort((a, b) => a.distance - b.distance);
}
