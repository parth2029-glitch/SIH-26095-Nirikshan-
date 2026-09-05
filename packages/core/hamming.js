/**
 * Hamming distance over BigInt (§3). Used by §11's near-duplicate scan, which
 * compares one hash against the whole evidence corpus, so this is the hot path
 * — Kernighan's loop runs once per differing bit rather than 64 times.
 */

/**
 * Number of differing bits between two non-negative hashes.
 *
 * @param {bigint} a
 * @param {bigint} b
 * @returns {number}
 */
export function distance(a, b) {
  let x = a ^ b;
  // BigInt has no width: a negative value is two's complement over infinite
  // bits, so `while (x)` would never terminate. Refuse rather than hang.
  if (x < 0n) throw new RangeError('distance() expects non-negative hashes');

  let bits = 0;
  while (x) {
    x &= x - 1n; // clears the lowest set bit
    bits++;
  }
  return bits;
}
