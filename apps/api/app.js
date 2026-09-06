import { fileURLToPath } from 'node:url';
import express from 'express';
import { authGate, fail, login, requireInstituteScope, requireRole } from './auth.js';
import { assignCycle, createCycle, revealCycle, verifyCycle } from './cycles.js';
import { getOfficerRates, getVerifyChain, postOverride } from './overrides.js';
import { Institute } from './models.js';

const repoFile = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Built as a factory so tests can listen on an ephemeral port (§2, §15). */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Mounted ahead of authGate on purpose: the F1 verification page has to load
  // for someone with no account at all, and it replays the draw by importing
  // the very same engine source the server ran. Publishing that source is the
  // feature. §13 moves this behind Vite; the paths stay.
  app.use(express.static(repoFile('apps/dashboard/public')));
  app.use('/core', express.static(repoFile('packages/core')));
  app.use('/vendor', express.static(repoFile('node_modules/seedrandom')));

  // Mounted before every route: auth is opt-out (see PUBLIC_PATHS), not opt-in.
  app.use(authGate);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', login);

  // ── Commit–reveal (§5, PRD F1) ─────────────────────────────────────────────
  app.post('/api/cycles', requireRole('DIVISION'), createCycle);
  app.post('/api/cycles/:id/assign', requireRole('DIVISION'), assignCycle);
  app.post('/api/cycles/:id/reveal', requireRole('DIVISION'), revealCycle);
  // Public by design — PUBLIC_PATHS in auth.js lets this one through the gate.
  app.get('/api/cycles/:id/verify', verifyCycle);

  // ── Override ledger (§6, PRD F4) ───────────────────────────────────────────
  // The only door: direct model writes are refused by the requireOverride
  // plugin in models.js, so weakening the system has to pass this role guard.
  app.post('/api/overrides', requireRole('DISTRICT', 'DIVISION'), postOverride);
  // AUDITOR reads the chain but cannot write to it — the point of an auditor.
  app.get('/api/overrides/verify-chain', requireRole('DIVISION', 'AUDITOR'), getVerifyChain);
  app.get('/api/overrides/officer-rates', requireRole('DIVISION'), getOfficerRates);

  app.get(
    '/api/institutes/:id',
    requireRole('DISTRICT', 'DIVISION', 'AUDITOR', 'INSTITUTE'),
    requireInstituteScope(),
    async (req, res) => {
      const institute = await Institute.findById(req.params.id);
      return institute
        ? res.json(institute)
        : fail(res, 404, 'NOT_FOUND', `No institute with id ${req.params.id}.`);
    },
  );

  app.use((req, res) => fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`));

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err, req, res, _next) => {
    if (err.name === 'CastError') {
      return fail(res, 400, 'VALIDATION_FAILED', `Malformed id: ${err.value}`);
    }
    console.error(err);
    return fail(res, 500, 'INTERNAL', 'Unexpected server error.');
  });

  return app;
}
