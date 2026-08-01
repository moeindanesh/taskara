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
 * Read the configuration from the environment.
 *
 * Two authentication paths, and the token wins. #29 gave agents a credential of their own and #38
 * closed the email header to them, so an agent that sets both is still an agent; a human running MCP
 * in conversation has only the email. Requiring neither is a config error rather than a 401 later,
 * because the fix is in a file the caller controls and saying so early costs a round trip less.
 */
export function readConfig(env: Record<string, string | undefined> = process.env): TaskaraConfig {
  const apiUrl = optional(env.TASKARA_API_URL);
  if (!apiUrl) throw configError('TASKARA_API_URL is required');

  const workspaceSlug = optional(env.TASKARA_WORKSPACE_SLUG);
  if (!workspaceSlug) throw configError('TASKARA_WORKSPACE_SLUG is required');

  const token = optional(env.TASKARA_AGENT_TOKEN);
  const userEmail = optional(env.TASKARA_USER_EMAIL);
  if (!token && !userEmail) {
    throw configError('Set TASKARA_AGENT_TOKEN (an agent credential) or TASKARA_USER_EMAIL');
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
