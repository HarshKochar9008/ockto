import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Me } from '../shared/schemas.ts';
import { one, pool } from './db.ts';

const scryptAsync = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384, R = 8, P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 64, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, expected);
}

// Login runs scrypt even for unknown emails, so response time doesn't reveal which accounts exist.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export async function checkLogin(email: string, password: string): Promise<Me | undefined> {
  const user = await one<Me & { password_hash: string }>(pool, 'SELECT id, email, name, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  return ok && user ? { id: user.id, email: user.email, name: user.name } : undefined;
}

export const SESSION_COOKIE = 'pt_session';
const SESSION_DAYS = 14;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const secureCookies = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]);
  return token;
}

export const sessionCookie = (token: string, maxAgeSeconds = SESSION_DAYS * 86_400) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookies ? '; Secure' : ''}`;

export const readCookie = (header: string | undefined, name: string) =>
  header?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

export async function userForSession(token: string | undefined): Promise<Me | undefined> {
  if (!token) return undefined;
  return one<Me>(pool,
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]);
}

export async function endSession(token: string | undefined): Promise<void> {
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

// ponytail: per-process fixed windows; move to Redis/Postgres once the API runs on more than one instance.
const windows = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.reset <= now) {
    if (windows.size > 50_000) for (const [k, v] of windows) if (v.reset <= now) windows.delete(k);
    windows.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  return ++w.n > limit;
}
