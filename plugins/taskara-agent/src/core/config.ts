import { readStoredCredentials } from '../cli/login';
import { configError } from './errors';

export const agentRuntimes = ['CLAUDE_CODE', 'CODEX', 'OPENCLAW', 'HERMES'] as const;
export type AgentRuntimeValue = (typeof agentRuntimes)[number];

export interface TaskaraConfig {
  apiUrl: string;
  workspaceSlug: string;
  /** An agent credential, presented as a bearer token. The only way an agent User can authenticate. */
  token?: string;
  /** The legacy header path, for a human driving MCP in conversation. Refused for agent Users. */
  userEmail?: string;
  /**
   * Which of the four runtimes is speaking. Client-asserted and unverifiable, which is why the API
   * only ever records it for an actor already proven to be an agent by its authenticated User.
   */
  runtime?: AgentRuntimeValue;
}

/**
 * Read the configuration from the environment, falling back to what `taskara login` stored.
 *
 * Two authentication paths, and the token wins. #29 gave agents a credential of their own and #38
 * closed the email header to them, so an agent that sets both is still an agent; a human running MCP
 * in conversation has only the email. Requiring neither is a config error rather than a 401 later,
 * because the fix is in a file the caller controls and saying so early costs a round trip less.
 *
 * **The environment wins over the stored file, field by field.** CI sets variables and has no home
 * directory worth writing to; a laptop runs `login` once and sets nothing. Preferring the file would
 * make a machine that had ever logged in ignore the variables its pipeline sets, which is the
 * failure that takes longest to see.
 */
export function readConfig(env: Record<string, string | undefined> = process.env): TaskaraConfig {
  const stored = readStoredCredentials();

  const apiUrl = optional(env.TASKARA_API_URL) ?? stored?.apiUrl;
  if (!apiUrl) throw configError('TASKARA_API_URL is required — or run `taskara login`');

  const workspaceSlug = optional(env.TASKARA_WORKSPACE_SLUG) ?? stored?.workspaceSlug;
  if (!workspaceSlug) throw configError('TASKARA_WORKSPACE_SLUG is required — or run `taskara login`');

  const envToken = optional(env.TASKARA_AGENT_TOKEN);
  const userEmail = optional(env.TASKARA_USER_EMAIL);

  // The stored token is a fallback for having *no* credentials, not a default that outranks the
  // ones you set. Authentication is picked as a whole rather than field by field: if the
  // environment names either a token or an email, the file stays out of it. Falling back per-field
  // would let a token written months ago beat a TASKARA_USER_EMAIL set deliberately today — and it
  // would do so silently, since a token outranks an email once both are present.
  //
  // Scoped to its own workspace too: a credential is issued against one, so pairing it with a
  // different slug sends a key to a door it cannot open and reports the 403 as if the slug were
  // wrong.
  const storedToken = !envToken && !userEmail && stored?.workspaceSlug === workspaceSlug
    ? stored.token
    : undefined;
  const token = envToken ?? storedToken;
  if (!token && !userEmail) {
    throw configError('Run `taskara login`, or set TASKARA_AGENT_TOKEN or TASKARA_USER_EMAIL');
  }

  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    workspaceSlug,
    token,
    userEmail: token ? undefined : userEmail,
    runtime: readRuntime(env.TASKARA_AGENT_RUNTIME)
  };
}

/**
 * An unset runtime means undeclared, and the API records none — which is honest. A *misspelled* one
 * is a mistake worth reporting: the old surface hardcoded `CODEX` under every runtime, and the whole
 * point of this field is that it stopped guessing.
 */
function readRuntime(raw: string | undefined): AgentRuntimeValue | undefined {
  const value = optional(raw);
  if (!value) return undefined;
  const match = agentRuntimes.find((runtime) => runtime === value.toUpperCase());
  if (!match) {
    throw configError(`TASKARA_AGENT_RUNTIME must be one of ${agentRuntimes.join(', ')}`);
  }
  return match;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
