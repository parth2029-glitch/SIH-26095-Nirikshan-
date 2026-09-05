/**
 * §2 acceptance: role separation is proven here, not by hand.
 * Every assertion below maps to a "Verify:" line in IMPLEMENTATION_PLAN_V2 §2.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import { Institute, User } from '../apps/api/models.js';

const PASSWORD = 'test-only-password';

let memoryServer;
let server;
let base;
let ownInstitute;
let otherInstitute;

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

async function login(email, password = PASSWORD) {
  const res = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4'; // the suite tests role separation, not KDF cost

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('nirikshan-auth-test'));

  const place = (name) => ({
    name,
    schemeType: 'HOSTEL',
    district: 'Pune',
    state: 'Maharashtra',
    location: { type: 'Point', coordinates: [73.8567, 18.5204] },
  });
  [ownInstitute, otherInstitute] = await Institute.create([
    place('Own Hostel'),
    place('Other Hostel'),
  ]);

  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    { email: 'inspector@example.test', name: 'A. Sharma', role: 'INSPECTOR', passwordHash },
    { email: 'division@example.test', name: 'V. Rao', role: 'DIVISION', passwordHash },
    {
      email: 'institute@example.test',
      name: 'Hostel Admin',
      role: 'INSTITUTE',
      instituteId: ownInstitute._id,
      passwordHash,
    },
  ]);

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
});

test('login returns a JWT carrying userId and role', async () => {
  const { status, body } = await login('inspector@example.test');
  assert.equal(status, 200);
  assert.equal(body.user.role, 'INSPECTOR');

  const claims = jwt.verify(body.token, process.env.JWT_SECRET);
  assert.equal(claims.userId, body.user.id);
  assert.equal(claims.role, 'INSPECTOR');
  assert.ok(claims.exp > Date.now() / 1000);
});

test('a wrong password is indistinguishable from an unknown email', async () => {
  const wrongPassword = await login('inspector@example.test', 'not-the-password');
  const unknownEmail = await login('ghost@example.test', 'not-the-password');

  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error.code, 'BAD_CREDENTIALS');
  assert.deepEqual(unknownEmail, wrongPassword);
});

test('requireAuth is applied globally — no token, no route', async () => {
  const missing = await call(`/api/institutes/${ownInstitute._id}`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'NO_TOKEN');

  const forged = await call(`/api/institutes/${ownInstitute._id}`, {
    token: jwt.sign({ userId: 'x', role: 'DIVISION' }, 'the-wrong-secret'),
  });
  assert.equal(forged.status, 401);
  assert.equal((await forged.json()).error.code, 'INVALID_TOKEN');
});

test('the public verify path stays reachable without a token', async () => {
  const res = await call('/api/cycles/66f0a1b2c3d4e5f600000201/verify');
  // 404 until §5 lands the route — the point is that the gate let it through.
  assert.equal(res.status, 404);
});

test('an Inspector token gets 403 on /api/overrides', async () => {
  const inspector = await login('inspector@example.test');
  const res = await call('/api/overrides', {
    token: inspector.body.token,
    method: 'POST',
    body: {},
  });

  assert.equal(res.status, 403);
  const { error } = await res.json();
  assert.equal(error.code, 'FORBIDDEN_ROLE');
  assert.deepEqual(error.details.required, ['DISTRICT', 'DIVISION']);

  // Same route, an allowed role: proves the 403 came from the role guard and
  // not from the route being unreachable for everyone.
  const division = await login('division@example.test');
  const allowed = await call('/api/overrides', {
    token: division.body.token,
    method: 'POST',
    body: {},
  });
  assert.notEqual(allowed.status, 403);
});

test('an Institute token cannot read another institute', async () => {
  const { body } = await login('institute@example.test');

  const own = await call(`/api/institutes/${ownInstitute._id}`, { token: body.token });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).name, 'Own Hostel');

  const other = await call(`/api/institutes/${otherInstitute._id}`, { token: body.token });
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error.code, 'OUT_OF_SCOPE');

  // A DIVISION token reads both — the scope narrows INSTITUTE only.
  const division = await login('division@example.test');
  const wide = await call(`/api/institutes/${otherInstitute._id}`, { token: division.body.token });
  assert.equal(wide.status, 200);
});
