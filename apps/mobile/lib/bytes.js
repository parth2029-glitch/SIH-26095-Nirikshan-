/**
 * Byte plumbing the hashing paths need (§8). Three functions, because a phone
 * has no `Buffer` and expo-crypto works on `Uint8Array`, not strings.
 *
 * `atob` and `TextEncoder` are both present in the Expo runtime; neither is a
 * polyfill this app installs.
 */

/** base64 → bytes. Everything image-shaped arrives from Expo as base64. */
export function fromBase64(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const utf8 = (text) => new TextEncoder().encode(text);

export const toHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
