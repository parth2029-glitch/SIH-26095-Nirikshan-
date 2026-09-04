import express from 'express';
import { authGate, fail, login, requireInstituteScope, requireRole } from './auth.js';
import { Institute } from './models.js';

/** Built as a factory so tests can listen on an ephemeral port (§2, §15). */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Mounted before every route: auth is opt-out (see PUBLIC_PATHS), not opt-in.
  app.use(authGate);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', login);

  // §6 owns the handler. Mounted now so the role guard is real and testable —
  // an INSPECTOR token must get 403 here, not 404.
  app.post('/api/overrides', requireRole('DISTRICT', 'DIVISION'), (req, res) =>
    fail(res, 501, 'INTERNAL', 'The override ledger lands in §6.'),
  );

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
