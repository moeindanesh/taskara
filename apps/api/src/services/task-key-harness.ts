import { prisma } from '@taskara/db';

/**
 * Runtime interception for the key-immutability property. TEST SUPPORT ONLY — nothing in the
 * running API imports this module, and `watchTaskKeyWrites()` mutates the shared Prisma singleton
 * for the duration of a test.
 *
 * THE PROPERTY. A task key is issued once, at creation, and no later write may change it. That is
 * unusually clean to check: it is not "did this query filter correctly", it is "does the `data` of
 * any task update carry `key` at all". One assertion covers every path, including paths written
 * after this file.
 *
 * WHY NOT A SCENARIO TEST ALONE. A scenario test proves the two paths somebody thought of. This map
 * has twice found that the leak is in the path nobody thought of — a filtered relation count that a
 * model extension cannot see, and a source-text scan that graded an inverted predicate as safe. A
 * key re-issue added next year to a bulk operation, a triage transition or a migration script would
 * pass every scenario test in the suite and fail here.
 *
 * WHY NOT SCAN THE SOURCE. Same reason `measured-work-harness.ts` does not: text cannot tell a
 * write from a mention of one. `key` appears hundreds of times across this API as a select, a
 * response field and a variable name.
 *
 * WHAT IT CANNOT SEE:
 *   - `$queryRaw`, and anything issued through a client other than the shared singleton.
 *   - `createMany` / `create`. Deliberate: creation is where a key is supposed to be written.
 *   - A path the drive did not run. Absence of a violation is only as strong as the drive, which is
 *     why the test that uses this also asserts, positively, that the moves it performed were seen.
 */

interface Delegate extends Record<string, (args: unknown) => unknown> {}
interface ClientWithDelegates extends Record<string, Delegate> {}

/** The task writes that could change an existing row's key. */
export const watchedKeyOperations = ['update', 'updateMany', 'upsert'] as const;

export interface TaskKeyWrite {
  operation: string;
  /** True when the write's `data` mentions `key` at all — the whole property. */
  carriesKey: boolean;
  /** What it tried to set, for a failure message that names the offender rather than the rule. */
  attempted: unknown;
}

export interface TaskKeyWatch {
  writes: () => TaskKeyWrite[];
  /** Writes that would change a key. Empty is the passing state. */
  violations: () => string[];
  stop: () => void;
}

/**
 * `upsert` splits into `create` and `update` halves; only the update half can change an existing
 * row, so a `key` in `create` is not a violation.
 */
function readWrite(operation: string, args: unknown): TaskKeyWrite {
  const record = (args ?? {}) as Record<string, unknown>;
  const data = operation === 'upsert' ? record.update : record.data;
  const fields = (data ?? {}) as Record<string, unknown>;
  const carriesKey = Object.prototype.hasOwnProperty.call(fields, 'key');
  return { operation, carriesKey, attempted: carriesKey ? fields.key : undefined };
}

export function watchTaskKeyWrites(): TaskKeyWatch {
  const writes: TaskKeyWrite[] = [];
  const restore: Array<() => void> = [];
  const client = prisma as unknown as ClientWithDelegates;

  for (const operation of watchedKeyOperations) {
    const delegate = client.task;
    const original = delegate[operation];
    restore.push(() => {
      delegate[operation] = original;
    });
    delegate[operation] = (args: unknown) => {
      writes.push(readWrite(operation, args));
      return original.call(delegate, args);
    };
  }

  // Task writes in this API run inside interactive transactions almost without exception —
  // updateTask and mergeProjects both do — so a watcher that only saw the singleton's delegate
  // would observe nothing at all and report a clean pass. `tx` is an ITX client with no
  // `$extends`, so the reading happens one layer out, on the arguments handed to the delegate.
  const originalTransaction = prisma.$transaction;
  const callOriginalTransaction = originalTransaction.bind(prisma) as (...args: unknown[]) => unknown;
  restore.push(() => {
    // Delete before reassigning: the client is a proxy that reports an own descriptor for
    // `$transaction` whose value is undefined, so writing that back installs undefined over the
    // real method. See the same dance in measured-work-harness.ts.
    delete (prisma as unknown as Record<string, unknown>).$transaction;
    if (prisma.$transaction !== originalTransaction) {
      (prisma as unknown as Record<string, unknown>).$transaction = originalTransaction;
    }
  });
  (prisma as unknown as Record<string, unknown>).$transaction = (first: unknown, options?: unknown) => {
    if (typeof first !== 'function') return callOriginalTransaction(first, options);
    const run = first as (tx: unknown) => unknown;
    return callOriginalTransaction((tx: unknown) => run(watchTransaction(tx, writes)), options);
  };

  return {
    writes: () => [...writes],
    violations: () =>
      writes
        .filter((write) => write.carriesKey)
        .map((write) => `task.${write.operation} set key to ${JSON.stringify(write.attempted)}`),
    stop: () => {
      while (restore.length) restore.pop()?.();
    }
  };
}

function watchTransaction(tx: unknown, writes: TaskKeyWrite[]): unknown {
  const source = tx as ClientWithDelegates;
  const patched: Record<string, unknown> = Object.create(source as object);
  const delegate = source.task;
  if (!delegate) return tx;

  const wrapped: Delegate = Object.create(delegate as object);
  for (const operation of watchedKeyOperations) {
    const original = delegate[operation];
    if (typeof original !== 'function') continue;
    wrapped[operation] = (args: unknown) => {
      writes.push(readWrite(operation, args));
      return original.call(delegate, args);
    };
  }
  patched.task = wrapped;
  return patched;
}
