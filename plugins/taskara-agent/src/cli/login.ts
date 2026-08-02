/**
 * `taskara login` — the whole setup, as one command a person runs alone.
 *
 * Before this, using the CLI meant an admin minting a credential and handing the plaintext over in
 * a chat message, then the recipient exporting four variables somewhere a non-interactive shell
 * would see them. Two people, a secret in a channel, and a step (team membership) whose absence
 * looks exactly like a bad token.
 *
 * Now: sign in as yourself, and the CLI asks Taskara for a credential for *your own* agent —
 * creating it, and mirroring your teams, if you have none. `POST /agent-credentials/self` is not
 * admin-gated precisely because that request grants nothing you do not already hold.
 *
 * The credential lands in `~/.taskara/credentials.json` at mode 600, and `readConfig` prefers the
 * environment over it — so CI keeps setting variables and a laptop stops having to.
 *
 * A password is read from the terminal with echo off and is **never stored**: it buys one session,
 * the session buys one credential, and the session is thrown away.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TaskaraError, exitCodeForStatus, exitCodes } from '../core/errors';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CREDENTIALS_PATH = join(homedir(), '.taskara', 'credentials.json');

export interface StoredCredentials {
  apiUrl: string;
  workspaceSlug: string;
  token: string;
}

export function readStoredCredentials(path = CREDENTIALS_PATH): StoredCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredCredentials>;
    if (!parsed.apiUrl || !parsed.workspaceSlug || !parsed.token) return null;
    return parsed as StoredCredentials;
  } catch {
    // A corrupt file is not a reason to refuse to run — the environment may well carry a working
    // config, and `login` will overwrite this one anyway.
    return null;
  }
}

export function writeStoredCredentials(value: StoredCredentials, path = CREDENTIALS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // Explicit, because writeFileSync's mode is ignored when the file already exists.
  chmodSync(path, 0o600);
}

export interface LoginResult {
  path: string;
  workspaceSlug: string;
  agentEmail: string;
  teams: number;
}

export async function login(input: {
  apiUrl: string;
  workspaceSlug: string;
  email: string;
  password: string;
  name?: string;
}): Promise<LoginResult> {
  const base = input.apiUrl.replace(/\/$/, '');

  const session = await post(`${base}/auth/login`, { email: input.email, password: input.password });
  const token = (session as { token?: string }).token;
  if (!token) {
    throw new TaskaraError('Taskara accepted the sign-in but returned no session token.', {
      exitCode: exitCodes.server
    });
  }

  const credential = await post(
    `${base}/agent-credentials/self`,
    { name: input.name ?? hostLabel() },
    { authorization: `Bearer ${token}`, 'x-workspace-slug': input.workspaceSlug }
  ) as { token: string; agent: { email: string } };

  // The session existed only to prove who you are. Leaving it alive would leave a second live
  // credential behind for a command whose whole point is that you end up holding exactly one.
  await post(`${base}/auth/logout`, {}, { authorization: `Bearer ${token}` }).catch(() => undefined);

  writeStoredCredentials({ apiUrl: base, workspaceSlug: input.workspaceSlug, token: credential.token });

  // Prove the credential before claiming success, and count what it can see: an agent on no team
  // reads an empty workspace, which is the failure that looks like a bad token.
  // `GET /projects` answers a bare array. The CLI's own `project list` wraps it in `{ projects }`,
  // and reading that shape here reported 0 for an agent that could see two — the exact false alarm
  // this check exists to avoid raising.
  const projects = await get(`${base}/projects`, {
    authorization: `Bearer ${credential.token}`,
    'x-workspace-slug': input.workspaceSlug
  });
  const visible = Array.isArray(projects)
    ? projects.length
    : (projects as { projects?: unknown[] })?.projects?.length ?? 0;

  return {
    path: CREDENTIALS_PATH,
    workspaceSlug: input.workspaceSlug,
    agentEmail: credential.agent.email,
    teams: visible
  };
}

function hostLabel(): string {
  return process.env.HOSTNAME || process.env.HOST || 'cli';
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  return send(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return send(url, { method: 'GET', headers });
}

async function send(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  } catch {
    throw new TaskaraError(`Cannot reach Taskara at ${new URL(url).origin}`, {
      exitCode: exitCodes.unreachable
    });
  }
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = (data as { message?: string } | null)?.message;
    // Same codes as every other command. A wrong password is exit 3, not "server error" — login is
    // the first thing anybody runs, so it is the worst place to report a status inaccurately.
    throw new TaskaraError(message || `${response.status} ${response.statusText}`, {
      exitCode: exitCodeForStatus(response.status),
      status: response.status
    });
  }
  return data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
