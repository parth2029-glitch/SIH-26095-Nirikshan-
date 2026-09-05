/**
 * §2 verification: one login per role, so the manual 403 checks are runnable.
 *
 *   npm run seed:users                 # spins up an ephemeral Mongo
 *   MONGODB_URI=... npm run seed:users # or point at a real one
 *
 * Idempotent — re-running upserts the same six accounts. §12's seed script
 * replaces the Inspector and Institute rows this creates; the users survive.
 */
import { connect, disconnect } from '../apps/api/db.js';
import { Institute, Inspector, User } from '../apps/api/models.js';
import { hashPassword } from '../apps/api/auth.js';

/**
 * A real database demands an explicit password. The in-memory fallback in uri()
 * is throwaway, so a default is fine there — but these six accounts cover every
 * role including DIVISION, and this file is public.
 */
const PASSWORD = (() => {
  if (process.env.SEED_USER_PASSWORD) return process.env.SEED_USER_PASSWORD;
  if (process.env.MONGODB_URI) {
    throw new Error(
      'SEED_USER_PASSWORD is required when MONGODB_URI is set — copy .env.example to .env',
    );
  }
  return 'nirikshan-dev';
})();

let memoryServer;

async function uri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create();
  console.log('No MONGODB_URI — using an ephemeral in-memory Mongo.\n');
  return memoryServer.getUri('nirikshan');
}

const upsert = (Model, where, doc) =>
  Model.findOneAndUpdate(
    where,
    { $set: doc },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

async function main() {
  await connect(await uri());

  // The INSPECTOR and INSTITUTE accounts need something real to point at —
  // the scope check compares a token claim against an actual institute id.
  const inspector = await upsert(
    Inspector,
    { name: 'Seed Inspector' },
    { name: 'Seed Inspector', homeDistrict: 'Nagpur' },
  );
  const institute = await upsert(
    Institute,
    { name: 'Seed Hostel' },
    {
      name: 'Seed Hostel',
      schemeType: 'HOSTEL',
      district: 'Pune',
      state: 'Maharashtra',
      location: { type: 'Point', coordinates: [73.8567, 18.5204] },
    },
  );

  const passwordHash = await hashPassword(PASSWORD);
  const accounts = [
    { role: 'INSPECTOR', name: 'A. Sharma', inspectorId: inspector._id, homeDistrict: 'Nagpur' },
    { role: 'DISTRICT', name: 'D. Patil', homeDistrict: 'Pune' },
    { role: 'DIVISION', name: 'V. Rao' },
    { role: 'INSTITUTE', name: 'Seed Hostel Admin', instituteId: institute._id },
    { role: 'BENEFICIARY', name: 'R. Kumar' },
    { role: 'AUDITOR', name: 'CAG Observer' },
  ];

  for (const account of accounts) {
    const email = `${account.role.toLowerCase()}@example.test`;
    const user = await upsert(User, { email }, { ...account, email, passwordHash });
    console.log(`ok  ${account.role.padEnd(12)} ${email}  instituteId=${user.instituteId ?? '—'}`);
  }

  console.log(`\nPassword for all six: ${PASSWORD}`);
  console.log(`Institute id for the scope check: ${institute._id}`);
}

let code = 1;
try {
  await main();
  code = 0;
} catch (err) {
  console.error(err);
} finally {
  await disconnect();
  await memoryServer?.stop();
}
process.exit(code);
