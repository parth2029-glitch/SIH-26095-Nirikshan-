/**
 * Where evidence bytes live (§10, PRD F3).
 *
 * Originals are stored exactly as received. That rules out Cloudinary, which
 * rewrites EXIF on the copy it keeps — evidence whose metadata was silently
 * edited is not evidence, and the server's SHA-256 has to stay equal to the one
 * the handset computed over the same bytes. Backblaze B2 stores what it is
 * given, so originals go there and Cloudinary is left for thumbnails it cannot
 * damage.
 *
 * Local disk is the default. A bucket is a deployment step, not a code path:
 * §10 has to run end to end on a laptop with no account, and B2 takes over the
 * moment credentials appear in the environment.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_ROOT = fileURLToPath(new URL('../../fixtures/uploads/', import.meta.url));

/** All three or none — a half-configured bucket must not silently swallow uploads. */
const b2Configured = () =>
  Boolean(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && process.env.B2_BUCKET_ID);

export const backend = () => (b2Configured() ? 'b2' : 'local');

// ── Local ────────────────────────────────────────────────────────────────────

/** Keys are server-minted, but `get()` is handed one out of the database. */
function localPath(key) {
  const path = resolve(LOCAL_ROOT, key);
  if (!path.startsWith(resolve(LOCAL_ROOT) + sep)) throw new Error(`Refusing key ${key}`);
  return path;
}

// ── B2 ───────────────────────────────────────────────────────────────────────
// Plain fetch against the native API rather than the S3 SDK: three requests,
// no signing ceremony, no dependency. Tokens last 24 h; this re-authorizes
// hourly so a long-lived process never carries one to its expiry.
//
// ponytail: unexercised until the bucket exists — no account, no test. The
// local backend is what §10's test covers. Run one real upload before the
// deployment of §16 depends on this.
let auth = null;

async function authorize() {
  if (auth && Date.now() < auth.expiresAt) return auth;
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APPLICATION_KEY}`).toString(
    'base64',
  );
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw new Error(`B2 authorize failed (${res.status})`);
  const { authorizationToken, apiInfo } = await res.json();
  auth = {
    token: authorizationToken,
    apiUrl: apiInfo.storageApi.apiUrl,
    downloadUrl: apiInfo.storageApi.downloadUrl,
    expiresAt: Date.now() + 3_600_000,
  };
  return auth;
}

async function b2Put(key, bytes, contentType) {
  const { token, apiUrl } = await authorize();
  const url = new URL(`${apiUrl}/b2api/v3/b2_get_upload_url`);
  url.searchParams.set('bucketId', process.env.B2_BUCKET_ID);
  const slot = await fetch(url, { headers: { authorization: token } });
  if (!slot.ok) throw new Error(`B2 get_upload_url failed (${slot.status})`);
  const { uploadUrl, authorizationToken } = await slot.json();

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: authorizationToken,
      'x-bz-file-name': encodeURIComponent(key),
      'content-type': contentType,
      'content-length': String(bytes.length),
      // B2 verifies this itself and rejects a truncated upload, which is the
      // point: a half-written original would hash to something plausible.
      'x-bz-content-sha1': createHash('sha1').update(bytes).digest('hex'),
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`B2 upload failed (${res.status})`);
}

async function b2Get(key) {
  const { token, downloadUrl } = await authorize();
  const res = await fetch(`${downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encodeURI(key)}`, {
    headers: { authorization: token },
  });
  if (!res.ok) throw new Error(`B2 download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ── The seam ─────────────────────────────────────────────────────────────────

/** @returns {Promise<void>} the key is the caller's; this only stores bytes. */
export async function put(key, bytes, contentType = 'image/jpeg') {
  if (backend() === 'b2') return b2Put(key, bytes, contentType);
  const path = localPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/** @returns {Promise<Buffer>} the bytes exactly as {@link put} received them. */
export const get = (key) => (backend() === 'b2' ? b2Get(key) : readFile(localPath(key)));
