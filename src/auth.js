import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { deleteAppSession, getAppSession, putAppSession } from './store.js';

const scrypt = promisify(scryptCallback);
const COOKIE = 'saw_session';

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored = '') {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(key, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

const digest = (token) => createHash('sha256').update(token).digest('hex');
export function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((x) => x.length === 2));
}

export async function createSession(res, subject) {
  const token = randomBytes(32).toString('base64url');
  await putAppSession(digest(token), { ...subject, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

export async function readSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const key = digest(token);
  const session = await getAppSession(key);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    if (session) await deleteAppSession(key);
    return null;
  }
  return session;
}

export async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await deleteAppSession(digest(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
