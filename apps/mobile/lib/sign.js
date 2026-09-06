/**
 * Signing on a handset (§8).
 *
 * expo-crypto hashes but does not sign, and React Native has no WebCrypto, so
 * the HMAC construction comes from `@nirikshan/core/hmac` — where a node test
 * exercises it against `createHmac` — and this file supplies only the digest.
 *
 * The key is the hex string `POST /api/auth/login` returned, used as key
 * material rather than decoded to bytes: `createHmac('sha256', hexString)` on
 * the server does exactly the same thing, and `apps/api/reports.js` says so.
 */
import * as Crypto from 'expo-crypto';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { hmacSha256 } from '@nirikshan/core/hmac';
import { toHex, utf8 } from './bytes.js';

const sha256 = async (bytes) =>
  new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));

/** The `signature` field of `POST /api/reports`. */
export const signReport = async (report, hmacKeyHex) =>
  toHex(
    await hmacSha256(sha256, utf8(hmacKeyHex), utf8(canonicalJSON(reportSignaturePayload(report)))),
  );

export const sha256Hex = async (bytes) => toHex(await sha256(bytes));
