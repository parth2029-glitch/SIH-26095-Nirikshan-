/**
 * §5 walkthrough on one command, no database to install.
 *
 *   npm run demo:cycle
 *
 * Spins up an ephemeral Mongo in-process, starts the API, seeds enough
 * institutes and inspectors for a real draw, then runs three cycles into the
 * three states the public verification page can be in — sealed, honest, and
 * tampered — and prints a URL for each.
 *
 * Dev only. Nothing here persists: every run starts empty and the database dies
 * with the process. §12 owns the real seed data; this exists so that §5 can be
 * seen working before §12 or §13 land.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import { Assignment, Inspector, Institute, User } from '../apps/api/models.js';

const PORT = Number(process.env.PORT) || 4000;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'division@example.test';
const PASSWORD = 'nirikshan-dev';
const DISTRICTS = ['Pune', 'Nagpur', 'Nashik', 'Thane', 'Amravati'];

// The API refuses to boot without these. Throwaway values for a throwaway database.
process.env.JWT_SECRET ??= 'dev-demo-secret-not-for-any-real-deployment';
process.env.DEVICE_HMAC_SECRET ??= 'dev-demo-device-secret';
process.env.BCRYPT_ROUNDS ??= '4';

const memoryServer = await MongoMemoryServer.create();
await mongoose.connect(memoryServer.getUri('nirikshan-demo'));

// 40 institutes over 5 districts and 10 inspectors: enough that C1–C4 actually
// bind, so the draw is a draw rather than the only possible pairing.
await Institute.create(
  Array.from({ length: 40 }, (_, i) => ({
    name: `Institute ${i}`,
    schemeType: 'HOSTEL',
    district: DISTRICTS[i % DISTRICTS.length],
    state: 'Maharashtra',
    location: { type: 'Point', coordinates: [73 + (i % 5) * 0.4, 18 + (i % 7) * 0.2] },
    riskScore: (i * 37) % 100,
  })),
);
await Inspector.create(
  Array.from({ length: 10 }, (_, i) => ({
    name: `Inspector ${i}`,
    homeDistrict: DISTRICTS[i % DISTRICTS.length],
  })),
);
await User.create({
  email: EMAIL,
  name: 'V. Rao',
  role: 'DIVISION',
  passwordHash: await hashPassword(PASSWORD),
});

const server = createApp().listen(PORT);
await new Promise((resolve) => server.once('listening', resolve));

const post = (path, token, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body ?? {}),
  }).then((res) => res.json());

const { token } = await post('/api/auth/login', null, { email: EMAIL, password: PASSWORD });

/** Reveal refuses until the period is over, so a revealable cycle needs a past one. */
async function cycle({ reveal }) {
  const period = reveal
    ? { periodStart: '2026-01-01', periodEnd: '2026-02-01' }
    : { periodStart: '2099-01-01', periodEnd: '2099-02-01' };
  const { id } = await post('/api/cycles', token, period);
  await post(`/api/cycles/${id}/assign`, token);
  if (reveal) await post(`/api/cycles/${id}/reveal`, token, { confirm: true });
  return id;
}

const sealed = await cycle({ reveal: false });
const honest = await cycle({ reveal: true });
const tampered = await cycle({ reveal: true });

// A retroactive edit straight at the collection, past every application guard —
// the thing §6's ledger is built to catch, done here so the page can catch it too.
const row = await Assignment.findOne({ cycleId: tampered });
const other = await Inspector.findOne({ _id: { $ne: row.inspectorId } });
await mongoose.connection
  .collection('assignments')
  .updateOne({ _id: row._id }, { $set: { inspectorId: other._id } });

const page = (id) => `${BASE}/verify.html?cycle=${id}`;
console.log(`
API      ${BASE}          (ephemeral in-memory Mongo — nothing persists)
Login    ${EMAIL} / ${PASSWORD}

Open these three. No login required — that is the point of F1.

  SEALED    ${page(sealed)}
      Drawn but not revealed. Commitment published, pairings withheld.
  MATCH     ${page(honest)}
      Replays from the seed in your browser.
  MISMATCH  ${page(tampered)}
      Same, after one stored assignment was edited behind the API's back.

Ctrl+C to stop.`);
