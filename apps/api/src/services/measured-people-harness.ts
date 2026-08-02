import { prisma } from '@taskara/db';

/**
 * Runtime interception for the measured-people predicate. TEST SUPPORT ONLY — nothing in the
 * running API imports this module, and `watchPeopleQueries()` mutates the shared Prisma singleton
 * for the duration of a test.
 *
 * WHY THIS EXISTS. The predicate used to be guarded by scanning source text for the words
 * `measuredMemberWhere` / `measuredSubjectWhere`. Three rounds of widening that scan produced a new
 * evasion each time, and the last version classified `NOT: { ...measuredMemberWhere }` as safe —
 * a query selecting exactly the people the predicate exists to exclude. Text cannot tell a
 * predicate from a mention of one.
 *
 * WHAT THIS DOES INSTEAD. It installs a Prisma client extension (`$extends` with a `query`
 * component) over the people tables and reads `args.where` as a REAL OBJECT, after every spread,
 * alias, helper and formatter has already been resolved by the language. Spelling stops mattering:
 * a where-clause either composes the predicate or it does not, and a comment cannot make it look
 * like it does.
 *
 * The extension is created per call so each observation carries the call site that produced it.
 * That costs about 0.15ms per intercepted query, which is invisible next to the query itself, and
 * it is the only way to attribute an observation: Prisma clones `args` before the extension sees
 * them, so neither object identity nor a hidden symbol survives the trip.
 *
 * WHAT IT CANNOT SEE. `$queryRaw`, and any people query issued by something other than the shared
 * singleton. Interactive transactions are covered separately below, at the delegate boundary,
 * because a transaction client cannot carry an extension.
 */

/**
 * The tables and calls a per-person number is actually written with — deliberately the same set the
 * static scan looks for, so the two guards describe one population.
 *
 * `task.groupBy` / `task.aggregate` are here because `by: ['assigneeId']` is a per-person rollup
 * however task-shaped its rows are; a plain `task.findMany` is not, or the workspace's own work list
 * would need reviewing too.
 */
export const watchedPeopleOperations: Readonly<Record<string, readonly string[]>> = {
  workspaceMember: ['findMany', 'count', 'groupBy', 'aggregate'],
  checkInResponse: ['findMany', 'count', 'groupBy', 'aggregate'],
  user: ['findMany', 'count', 'groupBy', 'aggregate'],
  task: ['groupBy', 'aggregate']
};

/** How a where-clause relates to the measured-people predicate. */
export type PredicateVerdict =
  /** The predicate constrains the rows: it sits in a conjunctive position. */
  | 'composed'
  /** The predicate is present but under `NOT` / `none` / `isNot`, so it selects the EXCLUDED people. */
  | 'negated'
  /** The predicate is not there at all, or only inside an `OR` branch that cannot constrain anything. */
  | 'absent';

export interface PeopleQueryObservation {
  model: string;
  operation: string;
  /** `<path under apps/api/src>#<enclosing function>`, from the call stack. Never a line number. */
  site: string;
  /** `<site> <model>.<operation>` — the key a reviewed exception is written against. */
  identity: string;
  verdict: PredicateVerdict;
  /** How the query reached the database, for reading a failure report. */
  via: 'client' | 'transaction';
  where: unknown;
}

export interface PeopleQueryWatch {
  /** Every intercepted people query, in the order the database saw them. */
  observations(): PeopleQueryObservation[];
  /**
   * Identities that ran without the predicate and are not in `reviewed`, formatted for a failing
   * assertion. `reviewed` maps an identity to the reason that query is allowed to see everyone.
   *
   * A `negated` verdict is reported whatever `reviewed` says. A reviewed exception is a claim that
   * the query does not measure anybody; an inverted predicate is the opposite claim — an active
   * selection of exactly the guests and agents the predicate exists to keep out — so no entry in
   * this map may excuse one.
   */
  unreviewed(reviewed: Readonly<Record<string, string>>): string[];
  /** Restores the singleton. Always call this, or every later test file inherits the patch. */
  stop(): void;
}

type Delegate = Record<string, (args: unknown) => unknown>;
type ClientWithDelegates = Record<string, Delegate>;

/**
 * Patches the shared client so people queries are observed until `stop()`.
 *
 * Nesting is not supported and does not need to be: one watch per test file, started before the
 * surfaces under test run and stopped in `afterAll`.
 */
export function watchPeopleQueries(): PeopleQueryWatch {
  const observations: PeopleQueryObservation[] = [];
  const restore: Array<() => void> = [];
  const client = prisma as unknown as ClientWithDelegates;
  // `$extends` is typed against the generated model map, and the extension below is built from
  // computed model/operation names. The cast is only about that: the callback signature it hands
  // back is the documented `query` component shape.
  const extend = prisma.$extends.bind(prisma) as unknown as (extension: unknown) => ClientWithDelegates;

  for (const [model, operations] of Object.entries(watchedPeopleOperations)) {
    const delegate = client[model];
    for (const operation of operations) {
      const original = delegate[operation];
      restore.push(() => {
        delegate[operation] = original;
      });
      delegate[operation] = (args: unknown) => {
        const site = callSite();
        // Per call, so the observation the extension records can name where it came from.
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

  // Interactive transactions: `tx` is an ITX client and has no `$extends`, so the same structural
  // reading happens one layer out, on the arguments the caller hands the delegate. Nothing in the
  // measurement surfaces reaches the people tables through a transaction today — the delivery paths
  // that do (notifications, announcements, knowledge, meetings) are visibility reads — but leaving
  // the hole open is how the last guard was evaded.
  //
  // The ORIGINAL function, kept so `stop()` can put that exact value back. Assigning a bound copy
  // instead — which is what this used to do — leaves the shared singleton holding a wrapper for the
  // rest of the process: `prisma.$transaction` is no longer the function Prisma installed, and every
  // later test file inherits the substitution.
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
      const reported = new Map<string, PeopleQueryObservation>();
      for (const observation of observations) {
        if (observation.verdict === 'composed') continue;
        // `negated` is never excusable: a reviewed exception says "this query measures nobody", and
        // an inverted predicate says "this query selects precisely the excluded people". Letting the
        // map cover it would hand the reviewer a one-line way to turn the guard inside out.
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

function watchTransaction(tx: unknown, site: string, observations: PeopleQueryObservation[]): unknown {
  const source = tx as ClientWithDelegates;
  const patched: Record<string, unknown> = Object.create(source as object);

  for (const [model, operations] of Object.entries(watchedPeopleOperations)) {
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
}): PeopleQueryObservation {
  const where = isRecord(input.args) ? input.args.where : undefined;
  return {
    model: input.model,
    operation: input.operation,
    site: input.site,
    identity: `${input.site} ${input.model}.${input.operation}`,
    verdict: readPredicate(where),
    via: input.via,
    where: where ?? null
  };
}

/**
 * Reads a where-clause and says whether the measured-people predicate actually constrains it.
 *
 * The whole point is that this looks at objects, not at text. Three rules do the work:
 *   - a match under `NOT` / `none` / `isNot` is `negated`, never `composed`. That is the false-safe
 *     this replaces: `NOT: { ...measuredMemberWhere }` selects precisely the guests and agents;
 *   - a match inside an `OR` branch does not count, because a disjunct constrains nothing on its
 *     own — the other branch is free to re-admit everyone;
 *   - anywhere else, a match counts however deeply it is nested. The leaderboard writes the subject
 *     form as `assignee: { is: … }`, and that is a real constraint on which rows come back.
 */
export function readPredicate(where: unknown): PredicateVerdict {
  let negatedMatch = false;

  const walk = (node: unknown, negated: boolean): boolean => {
    if (Array.isArray(node)) return node.some((item) => walk(item, negated));
    if (!isRecord(node)) return false;

    if (matchesMemberShape(node) || matchesSubjectShape(node)) {
      if (!negated) return true;
      negatedMatch = true;
    }

    for (const [key, value] of Object.entries(node)) {
      // A disjunct cannot constrain the result set, so a predicate inside one is not composed.
      if (key === 'OR') continue;
      if (walk(value, negated || negatingKeys.has(key))) return true;
    }
    return false;
  };

  if (walk(where, false)) return 'composed';
  return negatedMatch ? 'negated' : 'absent';
}

/** Keys whose contents describe rows to EXCLUDE, so a predicate under one selects its complement. */
const negatingKeys = new Set(['NOT', 'none', 'isNot']);

/** `measuredMemberWhere`: both clauses, conjunctively, on the membership row. */
function matchesMemberShape(node: Record<string, unknown>): boolean {
  return isRoleNotGuest(node.role) && isHumanKind(node.user);
}

/** `measuredSubjectWhere(workspaceId)`: the same population reached from the User side. */
function matchesSubjectShape(node: Record<string, unknown>): boolean {
  if (node.kind !== 'HUMAN') return false;
  const workspaces = node.workspaces;
  if (!isRecord(workspaces) || !isRecord(workspaces.some)) return false;
  return isRoleNotGuest(workspaces.some.role);
}

function isRoleNotGuest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'not' && value.not === 'GUEST';
}

/** `user: { kind: 'HUMAN' }` and the explicit to-one form `user: { is: { kind: 'HUMAN' } }`. */
function isHumanKind(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'HUMAN') return true;
  return isRecord(value.is) && value.is.kind === 'HUMAN';
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
    if (relative.startsWith('services/measured-people-harness')) continue;
    const name = named?.[1]?.replace(/^Object\./, '') ?? '';
    return `${relative}#${name && name !== '<anonymous>' ? name : 'anonymous'}`;
  }
  return 'unknown#anonymous';
}
