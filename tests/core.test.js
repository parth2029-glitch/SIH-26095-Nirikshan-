/**
 * §3 acceptance: the shared core is pure, deterministic and platform-neutral.
 * Nothing here touches Mongo, the filesystem or the network — if it ever needs
 * to, the code under test has stopped being shared core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { bands, dhash, fromHex, greyFromRgba, toHex } from '@nirikshan/core/dhash';
import { hmacSha256 } from '@nirikshan/core/hmac';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { distance } from '@nirikshan/core/hamming';
import { score } from '@nirikshan/core/trust';
import { REASON_CODES, ROLES, TRUST_FACTORS } from '@nirikshan/core/constants';

/** 9×8 grayscale, deterministic, all values < 200 so +10 cannot clip. */
const image = (fn) => Array.from({ length: 72 }, (_, i) => fn(Math.floor(i / 9), i % 9));
const noisy = image((row, col) => ((row * 9 + col) * 37) % 180);
const ascendingRows = image((_row, col) => col * 20);
const descendingRows = image((_row, col) => 180 - col * 20);

test('hamming: counts differing bits, refuses negatives', () => {
  assert.equal(distance(0n, 0n), 0);
  assert.equal(distance(0b1011n, 0b1001n), 1);
  assert.equal(distance(0n, 0xffffffffffffffffn), 64);
  // A negative BigInt is two's complement over infinite bits — the popcount
  // loop would never terminate, so it must throw rather than hang.
  assert.throws(() => distance(-1n, 0n), RangeError);
});

test('dhash: 64 bits derived from left-to-right pixel comparisons', () => {
  assert.equal(dhash(ascendingRows), 0n); // never greater than the next pixel
  assert.equal(dhash(descendingRows), 0xffffffffffffffffn); // always greater
  assert.equal(distance(dhash(ascendingRows), dhash(descendingRows)), 64);
  assert.throws(() => dhash(noisy.slice(1)), RangeError);
  assert.throws(() => dhash(undefined), RangeError);
});

test('dhash: unchanged by a uniform brightness shift', () => {
  // The property L1 relies on. A re-encoded or re-exposed copy of the same
  // photograph must land at distance 0, not merely "close".
  const brighter = noisy.map((v) => v + 10);
  assert.equal(distance(dhash(noisy), dhash(brighter)), 0);
});

test('dhash: hex round-trips and bands are position-tagged', () => {
  const hash = dhash(noisy);
  assert.match(toHex(hash), /^[0-9a-f]{16}$/);
  assert.equal(fromHex(toHex(hash)), hash);
  assert.equal(toHex(0n), '0000000000000000'); // must not collapse to "0"

  const parts = bands(hash);
  // Eight bands, not four: k bands only guarantee an exact-match band while the
  // distance is under k, and PRD F3 calls duplicates at d ≤ 6.
  assert.equal(parts.length, 8);
  assert.deepEqual(
    parts,
    toHex(hash)
      .match(/.{2}/g)
      .map((byte, i) => `${i}:${byte}`),
  );
});

test('trust: a clean report scores 100 with nothing itemised', () => {
  assert.deepEqual(score(), { score: 100, factors: [] });
  assert.deepEqual(score({ device: {}, impliedSpeedKmh: 40, captureDistanceM: 20 }), {
    score: 100,
    factors: [],
  });
});

test('trust: each deduction is itemised with a human-readable reason', () => {
  const { score: value, factors } = score({
    reusedEvidence: [{ reportId: 'rep-2024-Q1', distance: 3 }],
    mockedLocation: true,
  });

  assert.equal(value, 100 - 25 - 40); // L1 HIGH + L3 CRITICAL
  assert.deepEqual(
    factors.map((f) => f.id),
    ['L1', 'L3'],
  );
  for (const f of factors) {
    assert.equal(f.title, TRUST_FACTORS[f.id].title);
    assert.ok(f.reason.length > 20, `${f.id} reason must read as a sentence`);
  }
  // L1 has to name the earlier report, not just say "duplicate" (PRD F3).
  assert.match(factors[0].reason, /rep-2024-Q1/);
  assert.deepEqual(factors[0].cites, ['rep-2024-Q1']);
});

test('trust: floors at 0 and never rejects', () => {
  const { score: value, factors } = score({
    reusedEvidence: [{ reportId: 'a', distance: 0 }],
    duplicateEvidence: [{ reportId: 'a' }],
    mockedLocation: true,
    device: { rooted: true, emulator: true, devModeEnabled: true },
    impliedSpeedKmh: 900,
    captureDistanceM: 4000,
    submittedHourLocal: 3,
    captureToSubmitHours: 200,
  });
  assert.equal(value, 0); // deductions exceed 100; a negative score is meaningless
  assert.equal(factors.length, 8); // L1–L8; L9 is off until §11 measures it
});

test('trust: L9 stays off until §11 sets its threshold', () => {
  // A guessed threshold would invent tamper findings out of ordinary JPEG
  // re-encoding noise, so an unmeasured L9 must fire on nothing at all.
  assert.deepEqual(score({ deviceHashDistance: 64 }), { score: 100, factors: [] });
});

test('constants: the shared vocabulary is intact', () => {
  assert.equal(ROLES.length, 6); // PRD §6
  assert.equal(Object.keys(TRUST_FACTORS).length, 9); // PRD F3 L1–L9
  assert.ok(REASON_CODES.INSPECTOR_UNAVAILABLE); // the code docs/API.md uses
});

test('dhash: RGBA collapses to Rec. 601 luma, one sample per pixel', () => {
  // Pure red, green, blue, white — the coefficients are the whole point, so a
  // transposed pair would show up here and nowhere else.
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual(Array.from(greyFromRgba(rgba)), [76, 150, 29, 255]);
  // Alpha is ignored, not multiplied in: a transparent pixel is still a pixel.
  assert.deepEqual(Array.from(greyFromRgba(Uint8Array.from([255, 255, 255, 0]))), [255]);
  assert.throws(() => greyFromRgba(Uint8Array.from([1, 2, 3])), RangeError);
});

test('hmac: the handset construction agrees with node createHmac', async () => {
  const sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
  const utf8 = (text) => new TextEncoder().encode(text);
  const hex = (bytes) => Buffer.from(bytes).toString('hex');

  // The device signs with a 64-hex-character key, so that length is the one
  // that matters — but a key longer than the block takes a different branch.
  for (const key of ['a'.repeat(64), 'k', 'x'.repeat(200)]) {
    for (const message of ['', '{"a":1}', 'शौचालय']) {
      assert.equal(
        hex(await hmacSha256(sha256, utf8(key), utf8(message))),
        createHmac('sha256', key).update(message, 'utf8').digest('hex'),
        `key ${key.length}, message ${JSON.stringify(message)}`,
      );
    }
  }
});

test('canonical: a report signs over its contents, never its signature', () => {
  const report = { clientId: 'c1', answers: [{ questionId: 'q', value: 41 }], signature: 'old' };
  // Signing has to be stable across a re-sign, or a client that stamps its
  // signature before serialising would produce a value it cannot reproduce.
  assert.equal(
    canonicalJSON(reportSignaturePayload(report)),
    canonicalJSON(reportSignaturePayload({ ...report, signature: 'different' })),
  );
  assert.equal(
    canonicalJSON(reportSignaturePayload(report)),
    '{"answers":[{"questionId":"q","value":41}],"clientId":"c1"}',
  );
});
