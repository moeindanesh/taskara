#!/usr/bin/env bun
import { TaskaraClient } from './core/client';
import { readConfig } from './core/config';
import { TaskaraError, exitCodes, type ExitCode } from './core/errors';
import { ClaimLostError, runCommand, usage } from './cli/commands';

/**
 * `taskara <noun> <verb>` — the tracker surface a skill can actually reach.
 *
 * A skill's instructions are strings pasted verbatim into Bash. There is no markdown syntax for
 * "call MCP tool create_task" — no argument spec, no exit code, no stderr — so shell is the only
 * substrate the toolkit can speak, and this shell therefore has to cover the whole contract rather
 * than the read half of it.
 *
 * The output convention is uniform in both directions: **stdout is always JSON**, the result on
 * success and `{ "error": ... }` on failure, and **stderr is always the human line**. The exit code
 * is the branch. That means `taskara task claim X || handle_it` works, `$(taskara task view X)` is
 * always parseable, and a caller never has to guess which stream to read.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Help comes before configuration on purpose. Someone running `taskara` for the first time has
  // nothing set up yet, and answering "TASKARA_API_URL is required" to a request for the command
  // list is the least useful true thing the program could say.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage}\n`);
    return exitCodes.ok;
  }
  if (argv.length === 0) {
    process.stderr.write(`${usage}\n`);
    return exitCodes.usage;
  }

  let config;
  try {
    config = readConfig();
  } catch (error) {
    return fail(error);
  }

  try {
    const result = await runCommand(new TaskaraClient(config), argv);
    process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
    if (result.note) process.stderr.write(`${result.note}\n`);
    return exitCodes.ok;
  } catch (error) {
    return fail(error);
  }
}

function fail(error: unknown): ExitCode {
  const { code, message, payload } = describe(error);
  process.stdout.write(`${JSON.stringify({ error: { code, message, ...payload } }, null, 2)}\n`);
  process.stderr.write(`${message}\n`);
  return code;
}

function describe(error: unknown): { code: ExitCode; message: string; payload: Record<string, unknown> } {
  if (error instanceof ClaimLostError) {
    return { code: exitCodes.conflict, message: error.message, payload: { task: error.task } };
  }
  if (error instanceof TaskaraError) {
    return {
      code: error.exitCode,
      message: error.message,
      payload: error.status === undefined ? {} : { status: error.status }
    };
  }
  // An unclassified throw is not a refusal by the server, and calling it one would tell a script to
  // stop retrying something that might well succeed. It is reported as a server-side unknown.
  return {
    code: exitCodes.server,
    message: error instanceof Error ? error.message : String(error),
    payload: {}
  };
}

process.exit(await main());
