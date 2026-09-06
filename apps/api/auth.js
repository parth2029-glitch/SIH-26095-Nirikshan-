import { createHmac } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from './models.js';

/**
 * Paths reachable without a token. Everything else is denied by default, so a
 * route added later is protected unless it is listed here deliberately (§2).
 */
const PUBLIC_PATHS = [
  /^\/health$/,
  /^\/api\/auth\//,
  // §5 — a third party must be able to verify a draw without an account.
  /^\/api\/cycles\/[^/]+\/verify$/,
];

const rounds = () => Number(process.env.BCRYPT_ROUNDS) || 10;

/**
 * Compared against when the email is unknown, so a missing account costs the
 * same time as a wrong password. Without this, response timing enumerates users.
 */
const ABSENT_USER_HASH = bcrypt.hashSync('nirikshan-no-such-user', rounds());

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set — copy .env.example to .env');
  return value;
}

/** The one error shape in docs/API.md. Every non-2xx response goes through it. */
export function fail(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, ...(details && { details }) } });
}

export const hashPassword = (plaintext) => bcrypt.hash(plaintext, rounds());

/**
 * Per-device HMAC key for §8's report signatures. Derived rather than stored:
 * the same (user, device) pair always yields the same key, so the server can
 * re-derive it at verification time and nothing extra needs persisting.
 *
 * Exported for §9's batch intake, which re-derives it to verify a signature.
 */
export function deviceHmacKey(userId, deviceId) {
  const value = process.env.DEVICE_HMAC_SECRET;
  if (!value) throw new Error('DEVICE_HMAC_SECRET is not set — copy .env.example to .env');
  return createHmac('sha256', value).update(`${userId}:${deviceId}`).digest('hex');
}

/** `POST /api/auth/login` — public. */
export async function login(req, res) {
  const { email, password, deviceId } = req.body ?? {};
  if (!email || !password) {
    return fail(res, 400, 'VALIDATION_FAILED', 'email and password are required.');
  }

  const user = await User.findOne({
    email: String(email).toLowerCase().trim(),
    active: true,
  }).select('+passwordHash');

  // Always run the comparison — see ABSENT_USER_HASH.
  const passwordOk = await bcrypt.compare(String(password), user?.passwordHash ?? ABSENT_USER_HASH);
  // One response for both failures: an unknown email must not be distinguishable
  // from a wrong password.
  if (!user || !passwordOk) {
    return fail(res, 401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
  }

  const claims = {
    userId: user.id,
    role: user.role,
    instituteId: user.instituteId?.toString() ?? null,
    inspectorId: user.inspectorId?.toString() ?? null,
  };
  const token = jwt.sign(claims, secret(), { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });

  return res.json({
    token,
    expiresAt: new Date(jwt.decode(token).exp * 1000).toISOString(),
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      inspectorId: claims.inspectorId,
      homeDistrict: user.homeDistrict ?? null,
      instituteId: claims.instituteId,
    },
    // Returned once, at login, never re-fetchable (docs/API.md).
    ...(deviceId && { deviceHmacKey: deviceHmacKey(user.id, deviceId) }),
  });
}

/** Verifies the bearer token and attaches `req.user`. */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return fail(res, 401, 'NO_TOKEN', 'Authorization: Bearer <jwt> is required.');

  try {
    req.user = jwt.verify(token, secret());
    return next();
  } catch (err) {
    return err.name === 'TokenExpiredError'
      ? fail(res, 401, 'TOKEN_EXPIRED', 'Token has expired — log in again.')
      : fail(res, 401, 'INVALID_TOKEN', 'Token is malformed or its signature does not verify.');
  }
}

/** Applied globally in app.js: authenticate everything but PUBLIC_PATHS. */
export function authGate(req, res, next) {
  if (PUBLIC_PATHS.some((pattern) => pattern.test(req.path))) return next();
  return requireAuth(req, res, next);
}

/** Variadic role allowlist: `requireRole('DIVISION', 'DISTRICT')`. */
export const requireRole =
  (...allowed) =>
  (req, res, next) =>
    allowed.includes(req.user?.role)
      ? next()
      : fail(
          res,
          403,
          'FORBIDDEN_ROLE',
          `Role ${req.user?.role ?? 'ANONYMOUS'} may not access this resource.`,
          { required: allowed },
        );

/**
 * Row-level scope for institute accounts. Roles with portfolio-wide visibility
 * pass through — the role allowlist upstream decides who gets that far; this
 * only narrows an INSTITUTE token to its own record.
 */
export const requireInstituteScope =
  (param = 'id') =>
  (req, res, next) => {
    if (req.user?.role !== 'INSTITUTE') return next();
    if (req.user.instituteId && req.user.instituteId === req.params[param]) return next();
    return fail(res, 403, 'OUT_OF_SCOPE', 'An institute account may only read its own record.');
  };
