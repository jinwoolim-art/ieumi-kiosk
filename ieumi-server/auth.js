// Authentication and tenant scoping (PROJECT.md §3-1, §3-3).
//
// Three roles:
//   master        — us. No center_id; may act on any center.
//   center_admin  — one center: its services, settings, staff accounts.
//   staff         — one center: the roster and incoming requests only.
//
// Every tenant-scoped handler resolves its center through `resolveCenter()`.
// That function is the single place tenant isolation is enforced, so it must
// stay the only way a center_id reaches a query.
const crypto = require('crypto');
const db = require('./db');
const env = require('./env');

const COOKIE = 'ieumi_sid';
const SESSION_HOURS = Number(env.SESSION_HOURS || 12);

// ---------------------------------------------------------------- passwords
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const key = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(keyHex, 'hex');
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sessions
// The cookie holds a random token; the table holds only its sha256. A database
// leak therefore does not hand over live sessions.
const tokenId = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createSession(userId, userAgent = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db.query(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)',
    [tokenId(token), userId, expires, String(userAgent).slice(0, 300)],
  );
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { token, expires };
}

async function destroySession(token) {
  if (token) await db.query('DELETE FROM sessions WHERE id = $1', [tokenId(token)]);
}

/** Resolve the signed-in user from the request cookie, or null. */
async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = await db.one(
    `SELECT u.id, u.center_id, u.role, u.username, u.name, u.active,
            c.slug AS center_slug, c.name AS center_name
       FROM sessions s
       JOIN users u   ON u.id = s.user_id
       LEFT JOIN centers c ON c.id = u.center_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [tokenId(token)],
  );
  if (!row || !row.active) return null;
  row.token = token;
  return row;
}

/** Best-effort cleanup of expired rows; called opportunistically on login. */
async function purgeExpiredSessions() {
  await db.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
}

// ---------------------------------------------------------------- cookies
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function sessionCookie(req, token, expires) {
  const https = env.COOKIE_SECURE === 'on' || (req.headers['x-forwarded-proto'] || '') === 'https';
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  if (https) bits.push('Secure');
  return bits.join('; ');
}

const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ---------------------------------------------------------------- kiosk devices
// A kiosk has no human to log in, so it identifies its center with a token in
// the URL. That token grants exactly: read the center's public settings and
// enabled services, look a caller up in the roster, and file a request.
async function centerFromKioskToken(token) {
  if (!token) return null;
  return db.one(
    'SELECT id, slug, name, region FROM centers WHERE kiosk_token = $1 AND active = true',
    [String(token)],
  );
}

// ---------------------------------------------------------------- guards
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const requireUser = (user) => {
  if (!user) throw new HttpError(401, '로그인이 필요합니다.');       // login required
  return user;
};

function requireRole(user, ...roles) {
  requireUser(user);
  if (!roles.includes(user.role)) throw new HttpError(403, '권한이 없습니다.');  // no permission
  return user;
}

/**
 * The tenant boundary. Returns the center_id this request may operate on.
 *
 * master        — may target any center by passing ?center=<id>; without one,
 *                 returns null so the handler can work across all centers.
 * center_admin  — always their own center; asking for another is a 403.
 * staff         — same.
 */
function resolveCenter(user, requested) {
  requireUser(user);
  if (user.role === 'master') return requested || null;
  if (requested && requested !== user.center_id) {
    throw new HttpError(403, '다른 복지관의 자료에는 접근할 수 없습니다.'); // no cross-center access
  }
  return user.center_id;
}

/** As above, but a center is mandatory (most handlers). */
function requireCenter(user, requested) {
  const id = resolveCenter(user, requested);
  if (!id) throw new HttpError(400, '복지관을 선택해 주세요.');        // pick a center
  return id;
}

module.exports = {
  COOKIE,
  HttpError,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  currentUser,
  purgeExpiredSessions,
  readCookie,
  sessionCookie,
  clearCookie,
  centerFromKioskToken,
  requireUser,
  requireRole,
  resolveCenter,
  requireCenter,
};
