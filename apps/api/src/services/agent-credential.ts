import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  prisma,
  type AgentCredential,
  type AgentCredentialScope,
  type User,
  type WorkspaceRole
} from '@taskara/db';
import { hashToken } from './auth';
import { HttpError } from './http';

/**
 * The long-lived credential a headless agent authenticates with.
 *
 * It exists because the only other non-expiring way into this API is a plaintext identifier, and
 * the expiring one -- a bearer `AuthSession` -- hard-expires after `TASKARA_SESSION_TTL_DAYS` with
 * no refresh endpoint, so an agent running for more than a month silently 401s.
 *
 * Token shape: `tka_<lookupId>_<secret>`.
 *   - `tka_`     a fixed prefix, so a leaked token is greppable by secret scanners and so this
 *                path is distinguishable from a session bearer token without a database read.
 *   - `lookupId` 12 CSPRNG bytes as hex. Public. Hex specifically, so the two underscores that
 *                delimit the token are unambiguous even though base64url itself contains `_`.
 *   - `secret`   32 CSPRNG bytes (256 bits) as base64url. Never stored, never logged, returned
 *                exactly once at creation or rotation.
 *
 * Only `sha256(token)` is persisted. sha256 rather than scrypt because the secret is 256 bits of
 * CSPRNG output, not a human-chosen password: there is no dictionary to attack and no work factor
 * worth paying on every single API request. `AuthSession` hashes its tokens the same way.
 */
const TOKEN_PREFIX = 'tka';
const TOKEN_PATTERN = /^tka_([0-9a-f]{24})_([A-Za-z0-9_-]{43})$/;

export interface MintedToken {
  token: string;
  lookupId: string;
  tokenHash: string;
}

export function isAgentCredentialToken(token: string): boolean {
  return token.startsWith(`${TOKEN_PREFIX}_`);
}

export function mintAgentCredentialToken(): MintedToken {
  const lookupId = randomBytes(12).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}_${lookupId}_${secret}`;
  return { token, lookupId, tokenHash: hashToken(token) };
}

export interface AuthenticatedAgentCredential {
  credential: Pick<AgentCredential, 'id' | 'scope'>;
  user: User;
  role: WorkspaceRole;
}

/**
 * Resolve a plaintext token to the agent User it authenticates, or throw.
 *
 * Every rejection reason is re-derived from the row on every request -- nothing is cached -- so a
 * revocation takes effect on the caller's very next call rather than at the end of some TTL.
 */
export async function authenticateAgentCredential(
  token: string,
  workspaceId: string,
  method: string
): Promise<AuthenticatedAgentCredential> {
  const parsed = TOKEN_PATTERN.exec(token);
  if (!parsed) throw new HttpError(401, 'Invalid agent credential');

  const record = await prisma.agentCredential.findUnique({
    where: { lookupId: parsed[1] },
    include: { agent: true }
  });

  // Compared in constant time, and compared even when no row was found, so that neither the
  // validity of a lookup id nor the correctness of a secret is readable from response timing.
  const presented = hashToken(token);
  const matches = constantTimeEquals(record?.tokenHash ?? '', presented);
  if (!record || !matches) throw new HttpError(401, 'Invalid agent credential');

  if (record.revokedAt) throw new HttpError(401, 'Agent credential has been revoked');
  if (record.expiresAt && record.expiresAt <= new Date()) {
    throw new HttpError(401, 'Agent credential has expired');
  }
  if (record.workspaceId !== workspaceId) {
    throw new HttpError(403, 'Agent credential is not valid for this workspace');
  }

  // The credential grants nothing on its own: it authenticates a User, and that User's membership
  // is what carries permission. A credential outliving the membership authenticates nobody.
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: record.userId } },
    select: { role: true }
  });
  if (!membership) throw new HttpError(401, 'Agent credential is no longer valid');

  if (record.scope === 'READ_ONLY' && !isReadMethod(method)) {
    throw new HttpError(403, 'This agent credential is read-only');
  }

  await prisma.agentCredential
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    credential: { id: record.id, scope: record.scope },
    user: record.agent,
    role: membership.role
  };
}

export function agentCredentialScopeAllowsWrite(scope: AgentCredentialScope): boolean {
  return scope === 'READ_WRITE';
}

function isReadMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Burn an equivalent comparison so a length mismatch is not the measurably fast path.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}
