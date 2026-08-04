import { usageError } from '../core/errors';
import { readFileBody, readInlineBody, type InlineBody } from '../core/line-breaks';

export interface ParsedArgs {
  /** Positional arguments after the noun and verb, in order. */
  positionals: string[];
  /** Every flag, in order of appearance, so repeated flags such as `--add-label` all survive. */
  flags: Array<{ name: string; value: string }>;
}

/**
 * Parse `--flag value` and `--flag=value`, keeping repeats.
 *
 * Repeats are the reason this is not a plain object. `--add-label a --add-label b` is the natural
 * way to say two labels, and the old parser's `Record<string, string>` silently kept only the last
 * one — a flag that appears to work and quietly drops half its input.
 *
 * A bare `--flag` with no value is a boolean and reads as `"true"`. `--` ends flag parsing, so a
 * value that starts with a dash can still be passed.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Array<{ name: string; value: string }> = [];
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;

    if (literal || !item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    if (item === '--') {
      literal = true;
      continue;
    }

    const equals = item.indexOf('=');
    if (equals !== -1) {
      flags.push({ name: item.slice(2, equals), value: item.slice(equals + 1) });
      continue;
    }

    const name = item.slice(2);
    const next = argv[index + 1];
    // A following token that itself starts with `--` belongs to the next flag, not to this one.
    // `--body-file -` still works: a single dash is not a flag, and stdin is spelled exactly that
    // way on purpose — `--body -` could not be told apart from a literal body of "-".
    if (next === undefined || next.startsWith('--')) {
      flags.push({ name, value: 'true' });
      continue;
    }
    flags.push({ name, value: next });
    index += 1;
  }

  return { positionals, flags };
}

export class Flags {
  private readonly used = new Set<string>();

  constructor(private readonly parsed: ParsedArgs) {}

  /** All values given for a repeatable flag, in order. */
  all(name: string): string[] {
    this.used.add(name);
    return this.parsed.flags.filter((flag) => flag.name === name).map((flag) => flag.value);
  }

  /** The single value for a flag, or undefined. Repeating a single-valued flag is a usage error. */
  get(name: string): string | undefined {
    const values = this.all(name);
    if (values.length === 0) return undefined;
    if (values.length > 1) throw usageError(`--${name} was given more than once`);
    return values[0];
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw usageError(`--${name} is required`);
    return value;
  }

  bool(name: string): boolean {
    const value = this.get(name);
    if (value === undefined) return false;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw usageError(`--${name} takes no value, or true/false`);
  }

  number(name: string): number | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw usageError(`--${name} must be a number`);
    return parsed;
  }

  /** One of a fixed set, matched case-insensitively so `--kind effort` works. */
  oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    const match = allowed.find((option) => option.toLowerCase() === value.toLowerCase());
    if (!match) throw usageError(`--${name} must be one of ${allowed.join(', ')}`);
    return match;
  }

  /**
   * Every flag the command never asked about. A mistyped flag that is merely ignored is the worst
   * outcome available here: the command succeeds, reports success, and did not do what was asked.
   */
  unknown(): string[] {
    return [...new Set(this.parsed.flags.map((flag) => flag.name).filter((name) => !this.used.has(name)))];
  }

  assertNoUnknown(): void {
    const unknown = this.unknown();
    if (unknown.length > 0) {
      throw usageError(`Unknown ${unknown.length === 1 ? 'flag' : 'flags'}: ${unknown.map((name) => `--${name}`).join(', ')}`);
    }
  }
}

/**
 * Split a repeatable, comma-friendly flag into values. `--label a,b --label c` and
 * `--label a --label b --label c` mean the same thing, because an agent writing a command line will
 * reach for whichever it saw last and neither should be the one that silently fails.
 */
export function splitValues(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Read a body from `--body`, or from `--body-file <path>`, or from stdin when the path is `-`.
 *
 * The stdin path is what makes an effort body possible at all: a map body is tens of kilobytes of
 * markdown and inline shell quoting of that is exactly where an agent's paste breaks.
 *
 * Which of the two a body came through is the whole reason this returns a record rather than a
 * string. A file body is bytes somebody chose and goes out as those bytes; an inline body came
 * through argv, where a shell's quotes cannot carry a newline, so `\n` in one is a line break the
 * writer had no way to send — see `readInlineBody`. Only this function knows which, and the record
 * carries what it did as far as the caller that prints it.
 */
export async function readBody(flags: Flags, bodyFlag = 'body'): Promise<InlineBody | undefined> {
  const inline = flags.get(bodyFlag);
  const file = flags.get(`${bodyFlag}-file`);

  if (inline !== undefined && file !== undefined) {
    throw usageError(`Use --${bodyFlag} or --${bodyFlag}-file, not both`);
  }
  if (inline !== undefined) return readInlineBody(inline);
  if (file === undefined) return undefined;
  if (file === '-') return readFileBody(await Bun.stdin.text());

  const handle = Bun.file(file);
  if (!(await handle.exists())) throw usageError(`File not found: ${file}`);
  return readFileBody(await handle.text());
}
