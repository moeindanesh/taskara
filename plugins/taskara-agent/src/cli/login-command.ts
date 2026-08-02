/**
 * The terminal half of `taskara login`: read what is needed, then hand off.
 *
 * Separate from `login.ts` so the flow itself takes plain arguments and can be tested without a
 * TTY. Everything interactive lives here.
 */
import { exitCodes, type ExitCode } from '../core/errors';
import { login, readStoredCredentials } from './login';

const ETX = '';
const BACKSPACE = new Set(['', '\b']);

export const loginUsage = `taskara login [--api-url <url>] [--workspace <slug>] [--email <address>] [--name <label>]

Signs you in and stores a credential for your own agent in ~/.taskara/credentials.json.
Anything not passed is asked for. The password is never stored -- it buys one session, the
session buys the credential, and the session is then thrown away.`;

export async function runLoginCommand(args: string[]): Promise<ExitCode> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${loginUsage}\n`);
    return exitCodes.ok;
  }

  const flags = parse(args);
  const stored = readStoredCredentials();

  const apiUrl = flags['api-url'] ?? process.env.TASKARA_API_URL ?? stored?.apiUrl
    ?? await ask('Taskara URL');
  const workspaceSlug = flags.workspace ?? process.env.TASKARA_WORKSPACE_SLUG ?? stored?.workspaceSlug
    ?? await ask('Workspace slug');
  const email = flags.email ?? await ask('Email');
  const password = flags.password ?? await askSecret('Password');

  if (!apiUrl || !workspaceSlug || !email || !password) {
    process.stderr.write('All of URL, workspace, email and password are needed.\n');
    return exitCodes.usage;
  }

  const result = await login({ apiUrl, workspaceSlug, email, password, name: flags.name });

  process.stdout.write(`${JSON.stringify({
    credentials: result.path,
    workspace: result.workspaceSlug,
    agent: result.agentEmail,
    projectsVisible: result.teams
  }, null, 2)}\n`);

  if (result.teams === 0) {
    process.stderr.write(
      '\nSigned in, but your agent sees no projects.\n'
      + 'That is a team-membership problem rather than a credential one: projects are team-scoped,\n'
      + 'and you are on no team in this workspace. Join one and run this again.\n'
    );
    return exitCodes.ok;
  }

  process.stderr.write(`\nReady. ${result.teams} project(s) visible. Try: taskara task list --assignee me\n`);
  return exitCodes.ok;
}

function parse(args: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    out[key] = inline ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : undefined);
  }
  return out;
}

/** Prompts go to stderr so stdout stays the JSON channel every other command keeps it as. */
async function ask(label: string): Promise<string> {
  process.stderr.write(`${label}: `);
  for await (const line of console) return line.trim();
  return '';
}

/**
 * Read with the terminal's echo off, so a password never reaches the scrollback — and never reaches
 * shell history either, which is why there is a prompt at all rather than only a `--password` flag.
 *
 * Falls back to a plain read when stdin is not a TTY, so a script can still pipe one in; that is a
 * deliberate escape hatch rather than an oversight, and it is why `--password` exists too.
 */
async function askSecret(label: string): Promise<string> {
  process.stderr.write(`${label}: `);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    for await (const line of console) return line.trim();
    return '';
  }

  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin) {
      const text = chunk.toString();
      if (text === '\r' || text === '\n') break;
      if (text === ETX) throw new Error('Cancelled');
      if (BACKSPACE.has(text)) {
        value = value.slice(0, -1);
        continue;
      }
      value += text;
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write('\n');
  }
  return value.trim();
}
