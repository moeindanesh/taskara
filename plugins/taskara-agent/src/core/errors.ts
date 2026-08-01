/**
 * The exit-code contract.
 *
 * These numbers are the public interface of the CLI, not an implementation detail: a skill pastes
 * `taskara task claim "$KEY"` into Bash and branches on `$?`, so changing one of these silently
 * changes the behaviour of every skill that reads it. They are documented in `docs/agents/` and
 * asserted end to end in `apps/api/src/routes/agent-cli.test.ts`.
 *
 * The split is by *what the caller should do next*, which is the only distinction a branching script
 * can act on:
 *
 *   - 1 and 2 mean the invocation is wrong; nothing was sent and retrying is pointless.
 *   - 3 means the credential is wrong; a human must fix it.
 *   - 4, 5 and 6 mean the request reached the server and was understood and refused. 5 in particular
 *     is the one an orchestrator is expected to handle rather than abort on: someone else got there
 *     first, move to the next ticket.
 *   - 7 and 8 mean nothing is known about whether the work happened; retrying is reasonable.
 *
 * All are below 9 deliberately. The shell reserves 126, 127 and 128+N, and a code that collides with
 * "command not found" is a code that lies about which layer failed.
 */
export const exitCodes = {
  /** The operation succeeded. */
  ok: 0,
  /** The command line was wrong: unknown noun or verb, missing or malformed flag. Nothing was sent. */
  usage: 1,
  /** Required configuration is missing or unusable. Nothing was sent. */
  config: 2,
  /** HTTP 401 or 403. The credential is absent, wrong, revoked, or not permitted to do this. */
  auth: 3,
  /** HTTP 404. No such task, project or workspace. */
  notFound: 4,
  /** HTTP 409. Someone else holds it, or the row moved underneath the request. `task claim` uses this. */
  conflict: 5,
  /** HTTP 400, 422 or any other 4xx. The server understood the request and refused it. */
  rejected: 6,
  /** HTTP 5xx. The server broke. Whether the work happened is unknown. */
  server: 7,
  /** No HTTP response at all: DNS, connection refused, TLS, timeout. */
  unreachable: 8
} as const;

export type ExitCode = (typeof exitCodes)[keyof typeof exitCodes];

/** Map an HTTP status onto the contract. Anything unrecognised is treated as a refusal, not a success. */
export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return exitCodes.auth;
  if (status === 404) return exitCodes.notFound;
  if (status === 409) return exitCodes.conflict;
  if (status >= 500) return exitCodes.server;
  return exitCodes.rejected;
}

export interface TaskaraErrorOptions {
  exitCode: ExitCode;
  status?: number;
  /** The parsed response body, when there was one. Carries the holder on a lost `task claim`. */
  body?: unknown;
  cause?: unknown;
}

/**
 * Every failure the core raises, carrying the exit code the shells map onto their own conventions:
 * the CLI exits with it, MCP turns it into an `isError` result and throws the number away.
 */
export class TaskaraError extends Error {
  readonly exitCode: ExitCode;
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, options: TaskaraErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TaskaraError';
    this.exitCode = options.exitCode;
    this.status = options.status;
    this.body = options.body;
  }
}

export function usageError(message: string): TaskaraError {
  return new TaskaraError(message, { exitCode: exitCodes.usage });
}

export function configError(message: string): TaskaraError {
  return new TaskaraError(message, { exitCode: exitCodes.config });
}
