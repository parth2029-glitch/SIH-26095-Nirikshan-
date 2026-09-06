/**
 * HMAC-SHA256, RFC 2104, over an injected SHA-256 (§3, §8).
 *
 * Node has `createHmac` and a browser has WebCrypto; a React Native handset has
 * neither, only `expo-crypto`'s digest. Rather than let the phone carry an
 * untested construction of its own, the construction lives here and the caller
 * supplies the hash — so the bytes an inspector's device signs are produced by
 * code a `node --test` run actually exercises.
 *
 * @param {(bytes: Uint8Array) => Promise<Uint8Array>} sha256
 */
export async function hmacSha256(sha256, keyBytes, messageBytes) {
  const BLOCK = 64; // SHA-256's block size, in bytes

  // Keys longer than the block are hashed first, shorter ones zero-padded.
  // Skipping either makes long and short keys behave differently.
  const key = new Uint8Array(BLOCK);
  key.set(keyBytes.length > BLOCK ? await sha256(keyBytes) : keyBytes);

  const concat = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  const inner = await sha256(concat(key.map((byte) => byte ^ 0x36), messageBytes));
  return sha256(concat(key.map((byte) => byte ^ 0x5c), inner));
}
