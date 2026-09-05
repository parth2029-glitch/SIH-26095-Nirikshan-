/**
 * Difference hash — a 64-bit perceptual fingerprint of an image (§3, PRD F3 L1).
 *
 * Pure by design: decoding a JPEG needs `sharp` on the server and a native
 * module on the phone, and neither can live in this package. Callers do their
 * own decode to a 9×8 grayscale buffer and hand the pixels in. That split is
 * what lets the device (F2.5) and the server compute comparable hashes.
 */

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
const PIXELS = DHASH_WIDTH * DHASH_HEIGHT;

/**
 * @param {ArrayLike<number>} gray9x8 72 grayscale samples, row-major, 9 per row.
 * @returns {bigint} 64-bit hash; bit 63 is the leftmost comparison of row 0.
 */
export function dhash(gray9x8) {
  if (gray9x8?.length !== PIXELS) {
    throw new RangeError(
      `dhash() expects ${PIXELS} grayscale samples (9×8), got ${gray9x8?.length}`,
    );
  }

  let hash = 0n;
  for (let row = 0; row < DHASH_HEIGHT; row++) {
    for (let col = 0; col < DHASH_WIDTH - 1; col++) {
      const i = row * DHASH_WIDTH + col;
      // Strictly greater: a flat run of identical pixels yields zeros on every
      // implementation, so device and server agree on featureless images.
      hash = (hash << 1n) | (gray9x8[i] > gray9x8[i + 1] ? 1n : 0n);
    }
  }
  return hash;
}

/** 16 lowercase hex chars — the storage form in `EvidenceItem.dHash`. */
export const toHex = (hash) => hash.toString(16).padStart(16, '0');

/** Inverse of {@link toHex}, for rebuilding §11's in-memory corpus from Mongo. */
export const fromHex = (hex) => BigInt(`0x${hex}`);

/**
 * Eight position-tagged byte bands for `EvidenceItem.dHashBands`.
 *
 * The count is not a free choice. k bands guarantee one exact-match band only
 * while the distance is under k, so the d ≤ 6 rule of PRD F3 needs at least 7 —
 * fewer bands silently miss real duplicates. Eight covers d ≤ 7. The `i:` tag
 * stops band 0's value from matching band 3's in a multikey `$in`.
 *
 * ponytail: Phase 1 never queries this — §11 does a linear Hamming scan, which
 * is microseconds at demo scale. The field is written now because adding an
 * indexed field to a populated collection later is the expensive version.
 */
export function bands(hash) {
  const hex = toHex(hash);
  return Array.from({ length: 8 }, (_, i) => `${i}:${hex.slice(i * 2, i * 2 + 2)}`);
}
