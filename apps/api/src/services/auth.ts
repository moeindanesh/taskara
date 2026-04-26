import type { FastifyRequest } from 'fastify';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { prisma, type AuthSession, type User } from '@taskara/db';
import { config } from '../config';
import { HttpError } from './http';

const scrypt = promisify(scryptCallback);
const passwordPrefix = 'scrypt';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function displayNameFromEmail(email: string): string {
  return email.split('@')[0]?.replace(/[._-]+/g, ' ') || email;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${passwordPrefix}$${salt}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash?: string | null): Promise<boolean> {
  if (!storedHash) return false;

  const [prefix, salt, hash] = storedHash.split('$');
  if (prefix !== passwordPrefix || !salt || !hash) return false;

  const expected = Buffer.from(hash, 'base64url');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createRawToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const value = Array.isArray(header) ? header[0] : header;
  const [scheme, token] = value.split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export async function createUserSession(userId: string): Promise<{ token: string; session: AuthSession }> {
  const token = createRawToken();
  const expiresAt = new Date(Date.now() + config.TASKARA_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt
    }
  });

  return { token, session };
}

export async function getSessionUser(request: FastifyRequest): Promise<User | null> {
  const token = getBearerToken(request);
  if (!token) return null;

  const now = new Date();
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });

  if (!session || session.expiresAt <= now) {
    if (session) await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  await prisma.authSession.update({
    where: { id: session.id },
    data: { lastUsedAt: now }
  });

  return session.user;
}

export async function requireSessionUser(request: FastifyRequest): Promise<User> {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Authentication required');
  return user;
}

export function buildInviteUrl(token: string): string {
  return new URL(`/accept-invite/${encodeURIComponent(token)}`, config.WEB_ORIGIN).toString();
}
