import { prisma } from '@taskara/db';

/**
 * Runtime interception for the measured-work predicate. TEST SUPPORT ONLY — nothing in the running
 * API imports this module, and `watchTaskQueries()` mutates the shared Prisma singleton for the
 * duration of a test.
 *
 * WHY IT IS SHAPED LIKE THIS. The people-side twin of this predicate was first guarded by scanning
 * source text for the predicate's name. Three rounds of widening that scan produced a new evasion
 * each time, and the last version classified `NOT: { ...measuredMemberWhere }` — a query selecting
 * exactly the rows the predicate exists to exclude — as verified. Text cannot tell a predicate from
 * a mention of one, and it certainly cannot tell one from its inverse.
 *
 * WHAT THIS DOES INSTEAD. It installs a Prisma client extension over the task delegate and reads
 * `args.where` as a REAL OBJECT, after every spread, alias, helper and default has been resolved by
 * the language. Spelling stops mattering.
 *
 * WHAT IT CANNOT SEE, and this matters more here than it did on the people side:
 *   - `$queryRaw`, and anything issued through a client other than the shared singleton.
 *   - FILTERED RELATION COUNTS. `_count: { select: { tasks: { where: workTaskWhere } } }` is issued
 *     against `project` or `user`, and its filter lives in `args.select`, not `args.where`. Six of
 *     this ticket's sites are of exactly that shape and are invisible here. They are provable only
 *     behaviourally, by asserting the numbers — which is why those assertions are not optional
 *     decoration in measured-work-exclusion.test.ts.
 *   - Anything the drive did not actually run. A surface moved behind a cache issues no query and
 *     therefore triggers no failure, which is why the test also asserts, positively, that the
 *     measured surfaces DID compose the predicate.
 */

/**
 * The task calls a work list or a measurement is written with.
 *
 * `findFirst` / `findUnique` are deliberately absent. They are the single-row read path an effort
 * has to survive — its own detail route, its lookup before a patch, its review lifecycle — and
 * demanding a reviewed entry for every task lookup in the API is how a guard becomes noise nobody
 * reads. The property being guarded is about LISTS and NUMBERS.
 */
export const watchedTaskOperations: Readonly<Record<string, readonly string[]>> = {
  task: ['findMany', 'count', 'groupBy', 'aggregate']
};

/** How a where-clause relates to the measured-work predicate. */
export type WorkPredicateVerdict =
  /** `kind: 'WORK'` constrains the rows: it sits in a conjunctive position. */
  | 'composed'
  /**
   * The query asks for efforts on purpose — `kind: 'EFFORT'`, or a `kind: { in: [...] }` admitting
   * one — conjunctively.
   *
   * This verdict is why the reader has four and not three. `GET /tasks?kind=EFFORT` is the
   * DELIBERATE read path, the thing that keeps "excluded" from meaning "deleted". A reader that
   * called it `absent` would make the reachability branch of the behavioural test fail the guard
   * forever, and the cheapest way out of that would be deleting the branch.
   */
  | 'effort-scoped'
  /**
   * `kind: 'WORK'` under `NOT` / `none` / `isNot`, which selects precisely the efforts. Never
   * excusable by a reviewed entry: a review says "this query measures nothing", an inverted
   * predicate says the opposite.
   */
  | 'negated'
  /** Not there at all, or only inside an `OR` branch, which constrains nothing. */
  | 'absent';

export interface TaskQueryObservation {
  model: string;
  operation: string;
  /** `<path under apps/api/src>#<enclosing function>`, from the call stack. Never a line number. */
  site: string;
  /** `<site> <model>.<operation>` — the key a reviewed exception is written against. */
  identity: string;
  verdict: WorkPredicateVerdict;
  /** How the query reached the database, for reading a failure report. */
  via: 'client' | 'transaction';
  where: unknown;
}

export interface TaskQueryWatch {
  /** Every intercepted task query, in the order the database saw them. */
  observations(): TaskQueryObservation[];
  /**
   * Identities that ran without the predicate and are not in `reviewed`, formatted for a failing
   * assertion. `reviewed` maps an identity to the reason that query legitimately sees efforts too.
   *
   * `composed` and `effort-scoped` both pass: one is a work list, the other is the read path. A
   * `negated` verdict is reported whatever `reviewed` says.
   */
  unreviewed(reviewed: Readonly<Record<string, string>>): string[];
  /** Restores the singleton. Always call this, or every later test file inherits the patch. */
  stop(): void;
}

type Delegate = Record<string, (args: unknown) => unknown>;
type ClientWithDelegates = Record<string, Delegate>;

/**
 * Patches the shared client so task list/count queries are observed until `stop()`.
 *
 * Nesting is not supported and does not need to be: one watch per test file, started before the
 * surfaces under test run and stopped in `afterAll`.
 */
export function watchTaskQueries(): TaskQueryWatch {
  const observations: TaskQueryObservation[] = [];
  const restore: Array<() => void> = [];
  const client = prisma as unknown as ClientWithDelegates;
  // `$extends` is typed against the generated model map, and the extension below is built from
  // computed model/operation names. The cast is only about that: the callback signature it hands
  // back is the documented `query` component shape.
  const extend = prisma.$extends.bind(prisma) as unknown as (extension: unknown) => ClientWithDelegates;

  for (const [model, operations] of Object.entries(watchedTaskOperations)) {
    const delegate = client[model];
    for (const operation of operations) {
      const original = delegate[operation];
      restore.push(() => {
        delegate[operation] = original;
      });
      delegate[operation] = (args: unknown) => {
        const site = callSite();
        // Per call, so the observation the extension records can name where it came from. Prisma
        // clones `args` before an extension sees them, so neither object identity nor a hidden
        // symbol survives the trip — the closure is the only way to attribute an observation.
        const extended = extend({
          query: {
            [model]: {
              [operation]({ args: seenArgs, query }: { args: unknown; query: (args: unknown) => unknown }) {
                observations.push(observe({ model, operation, site, via: 'client', args: seenArgs }));
                return query(seenArgs);
              }
            }
          }
        });
        return extended[model][operation](args);
      };
    }
  }

  // Interactive transactions: `tx` is an ITX client with no `$extends`, so the same structural
  // reading happens one layer out, on the arguments the caller hands the delegate. Task writes run
  // in transactions all over this API and several of them read a list first (project merge, the
  // milestone completion sweep), so leaving this hole open would exempt exactly the paths that
  // touch the most rows at once.
  //
  // The ORIGINAL function, kept so `stop()` can put that exact value back. Assigning a bound copy
  // instead looks like a restore and is not one: the shared singleton would spend the rest of the
  // process holding a wrapper for every test file that follows.
  const originalTransaction = prisma.$transaction;
  const callOriginalTransaction = originalTransaction.bind(prisma) as (...args: unknown[]) => unknown;
  restore.push(() => {
    // Deleting first, because the client is a proxy: it reports an own descriptor for
    // `$transaction` whose `value` is undefined, so handing that descriptor back would install
    // `undefined` over the real method. Removing our own-property patch makes the proxy serve the
    // original again. The identity check then covers a plain client, where the delete leaves a hole
    // that has to be filled with the original value rather than a copy of it.
    delete (prisma as unknown as Record<string, unknown>).$transaction;
    if (prisma.$transaction !== originalTransaction) {
      (prisma as unknown as Record<string, unknown>).$transaction = originalTransaction;
    }
  });
  (prisma as unknown as Record<string, unknown>).$transaction = (first: unknown, options?: unknown) => {
    if (typeof first !== 'function') return callOriginalTransaction(first, options);
    const site = callSite();
    const run = first as (tx: unknown) => unknown;
    return callOriginalTransaction((tx: unknown) => run(watchTransaction(tx, site, observations)), options);
  };

  return {
    observations: () => [...observations],
    unreviewed: (reviewed) => {
      const reported = new Map<string, TaskQueryObservation>();
      for (const observation of observations) {
        if (observation.verdict === 'composed' || observation.verdict === 'effort-scoped') continue;
        // `negated` is never excusable: a reviewed entry claims the query measures nothing, and an
        // inverted predicate claims the opposite — an active selection of exactly the efforts the
        // predicate exists to keep out. Letting the map cover it would hand the reviewer a one-line
        // way to turn the guard inside out.
        if (observation.verdict !== 'negated' && reviewed[observation.identity]) continue;
        if (!reported.has(observation.identity)) reported.set(observation.identity, observation);
      }
      return [...reported.values()].map(
        (observation) =>
          `${observation.identity} — predicate ${observation.verdict} — where ${JSON.stringify(observation.where)}`
      );
    },
    stop: () => {
      while (restore.length) restore.pop()?.();
    }
  };
}

function watchTransaction(tx: unknown, site: string, observations: TaskQueryObservation[]): unknown {
  const source = tx as ClientWithDelegates;
  const patched: Record<string, unknown> = Object.create(source as object);

  for (const [model, operations] of Object.entries(watchedTaskOperations)) {
    const delegate = source[model];
    if (!delegate) continue;
    const wrapped: Delegate = Object.create(delegate as object);
    for (const operation of operations) {
      const original = delegate[operation];
      if (typeof original !== 'function') continue;
      wrapped[operation] = (args: unknown) => {
        observations.push(observe({ model, operation, site, via: 'transaction', args }));
        return original.call(delegate, args);
      };
    }
    patched[model] = wrapped;
  }

  return patched;
}

function observe(input: {
  model: string;
  operation: string;
  site: string;
  via: 'client' | 'transaction';
  args: unknown;
}): TaskQueryObservation {
  const where = isRecord(input.args) ? input.args.where : undefined;
  return {
    model: input.model,
    operation: input.operation,
    site: input.site,
    identity: `${input.site} ${input.model}.${input.operation}`,
    verdict: readWorkPredicate(where),
    via: input.via,
    where: where ?? null
  };
}

/**
 * Reads a where-clause and says how it relates to `kind`.
 *
 * Objects, not text. Four rules do the work:
 *   - `kind: 'WORK'` under `NOT` / `none` / `isNot` is `negated`, never `composed`. That inverted
 *     form selects precisely the efforts, and it is the false-safe a text scan cannot see;
 *   - a match inside an `OR` branch does not count, because a disjunct constrains nothing on its
 *     own — the other branch is free to re-admit everything;
 *   - only a clause constraining THE ROW BEING SELECTED can be `composed`, so a positive match
 *     counts through `AND` and nowhere else. `{ parent: { is: { kind: 'WORK' } } }` says the row's
 *     PARENT is work and says nothing about the row; accepting it would report a query returning
 *     every effort in the workspace as verified — the same class of false-safe as the text scan,
 *     reached from a different direction. Found by planting it, not by reading. Negation is still
 *     hunted everywhere, relation keys included, because `negated` is the one verdict a reviewed
 *     entry cannot excuse and over-reporting it is harmless.
 *
 *     The people-side reader deliberately does the opposite and is right to: `measuredSubjectWhere`
 *     is legitimately reached through `assignee: { is: … }`, because there the question really is
 *     about a related row. `kind` is a column on the Task being selected;
 *   - a conjunctive `kind` that ADMITS `EFFORT` is `effort-scoped` rather than `absent`, because
 *     asking for efforts on purpose is a supported read, not a leak.
 */
export function readWorkPredicate(where: unknown): WorkPredicateVerdict {
  let negatedMatch = false;
  let effortScoped = false;

  // `constrains` stays true only while the walk is still describing THE ROW BEING SELECTED: the
  // root object and whatever `AND` chains off it. It goes false the moment the walk steps through a
  // relation key, because from there the clause is about a different row.
  const walk = (node: unknown, negated: boolean, constrains: boolean): boolean => {
    if (Array.isArray(node)) return node.some((item) => walk(item, negated, constrains));
    if (!isRecord(node)) return false;

    if ('kind' in node) {
      if (admitsOnlyWork(node.kind)) {
        if (!negated && constrains) return true;
        if (negated) negatedMatch = true;
      } else if (!negated && constrains && admitsEffort(node.kind)) {
        effortScoped = true;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      // A disjunct cannot constrain the result set, so a predicate inside one is not composed.
      if (key === 'OR') continue;
      if (walk(value, negated || negatingKeys.has(key), constrains && key === 'AND')) return true;
    }
    return false;
  };

  if (walk(where, false, true)) return 'composed';
  if (negatedMatch) return 'negated';
  return effortScoped ? 'effort-scoped' : 'absent';
}

/** Keys whose contents describe rows to EXCLUDE, so a predicate under one selects its complement. */
const negatingKeys = new Set(['NOT', 'none', 'isNot']);

/** `kind: 'WORK'`, and the long forms Prisma also accepts for an enum filter. */
function admitsOnlyWork(value: unknown): boolean {
  if (value === 'WORK') return true;
  if (!isRecord(value)) return false;
  if (value.equals === 'WORK') return true;
  if (Array.isArray(value.in)) return value.in.length > 0 && value.in.every((item) => item === 'WORK');
  // `not: 'EFFORT'` over a two-value enum is `kind: 'WORK'` spelled the long way round. It really
  // does constrain the rows, so it counts — unlike `NOT: { kind: 'WORK' }`, which does the reverse.
  return value.not === 'EFFORT';
}

/** A conjunctive `kind` filter that lets an EFFORT through: the deliberate read path. */
function admitsEffort(value: unknown): boolean {
  if (value === 'EFFORT') return true;
  if (!isRecord(value)) return false;
  if (value.equals === 'EFFORT') return true;
  if (Array.isArray(value.in)) return value.in.includes('EFFORT');
  return value.not === 'WORK';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const namedFrame = /^\s*at\s+(?:async\s+)?([^\s(]+)\s+\((.+?):\d+:\d+\)\s*$/;
const bareFrame = /^\s*at\s+(?:async\s+)?(.+?):\d+:\d+\s*$/;
const sourceRoot = '/apps/api/src/';

/**
 * `<path under apps/api/src>#<enclosing function>` for the first application frame above the patch.
 *
 * Deliberately NOT a line number: an exception keyed on one rots the moment anything is inserted
 * above the query, and a guard that fails for unrelated reasons gets deleted. Renaming the function
 * or moving the query to another module does invalidate the exception, which is the point — both
 * are edits that deserve a fresh look. And no comment can produce one, because this is read off the
 * call stack rather than off the source.
 */
function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    const named = namedFrame.exec(frame);
    const file = named ? named[2] : bareFrame.exec(frame)?.[1];
    if (!file || !file.includes(sourceRoot)) continue;
    const relative = file.slice(file.indexOf(sourceRoot) + sourceRoot.length);
    if (relative.startsWith('services/measured-work-harness')) continue;
    const name = named?.[1]?.replace(/^Object\./, '') ?? '';
    return `${relative}#${name && name !== '<anonymous>' ? name : 'anonymous'}`;
  }
  return 'unknown#anonymous';
}
