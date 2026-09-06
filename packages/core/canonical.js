/**
 * Canonical JSON: keys sorted, no whitespace, one representation per value.
 *
 * `JSON.stringify` is not enough — it preserves insertion order, so two servers
 * building the same entry could hash it differently. `toJSON` is honoured first
 * so an ObjectId and its hex string, or a Date and its ISO string, canonicalise
 * identically; without that, an entry would hash differently on write than on
 * read-back from Mongo.
 *
 * Lives in core rather than in the API because two independent parties hash the
 * same bytes: §6's ledger on the server, and §8's HMAC report signature on a
 * handset. A second implementation is a second set of rules to disagree about.
 */
export function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return canonicalJSON(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(',')}}`;
}

/**
 * The bytes an inspector's device signs and the server verifies (§8, §9).
 *
 * `signature` is excluded because it is the output. Everything else the client
 * sent is inside, deliberately: no allowlist to fall out of step with the app,
 * and a field added to a later app version is covered the day it ships.
 */
export const reportSignaturePayload = (report) => ({ ...report, signature: undefined });
