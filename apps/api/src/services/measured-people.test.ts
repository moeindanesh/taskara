import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isMeasuredMember, measuredMemberWhere, measuredSubjectWhere } from './measured-people';

const apiSrc = resolve(import.meta.dir, '..');

describe('the measured-people predicate', () => {
  test('is both clauses, and neither one implies the other', () => {
    // Freezing the shape on purpose. The two ways this predicate gets "simplified" are the two
    // regressions issue #20 was written to prevent, and both look like tidying:
    //   - dropping `role` re-admits GUEST humans to every metric, as permanent non-participants;
    //   - dropping `user.kind` misses every agent whose membership role is not literally AGENT,
    //     which is any agent holding MEMBER or ADMIN — WorkspaceRole.AGENT is a permission, not a
    //     species.
    expect(measuredMemberWhere).toEqual({ role: { not: 'GUEST' }, user: { kind: 'HUMAN' } });
  });

  test('describes the same population from the row side', () => {
    expect(measuredSubjectWhere('ws-1')).toEqual({
      kind: 'HUMAN',
      workspaces: { some: { workspaceId: 'ws-1', role: { not: 'GUEST' } } }
    });
  });

  test('excludes guests and agents in memory the same way the query does', () => {
    expect(isMeasuredMember({ role: 'MEMBER', userKind: 'HUMAN' })).toBe(true);
    expect(isMeasuredMember({ role: 'OWNER', userKind: 'HUMAN' })).toBe(true);
    expect(isMeasuredMember({ role: 'GUEST', userKind: 'HUMAN' })).toBe(false);
    // The case a role-only check gets wrong: an agent wearing an ordinary membership role.
    expect(isMeasuredMember({ role: 'MEMBER', userKind: 'AGENT' })).toBe(false);
    expect(isMeasuredMember({ role: 'ADMIN', userKind: 'AGENT' })).toBe(false);
  });

  test('has replaced every hand-written copy of the old role idiom', () => {
    // Five separately maintained copies of `role: { notIn: ['AGENT', 'GUEST'] }` is how the
    // populations drifted apart in the first place.
    const strays = sourceFiles()
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ line, at: `${relative(apiSrc, file)}:${index + 1}` }))
          .filter(({ line }) => /notIn:\s*\[\s*'AGENT'/.test(line))
      )
      .map(({ at }) => at);

    expect(strays).toEqual([]);
  });

  test('is never traversed through operatorId, so no metric reaches an agent to its human', () => {
    // Issue #20 §2: an agent's output is not its operator's output. Rolling one up into the other
    // would be the subtlest possible way to put agent work back into a human's numbers.
    const offenders = sourceFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/\.(groupBy|aggregate)\s*\(/g)].flatMap((match) => {
        const start = match.index ?? 0;
        const args = balanced(source, start + match[0].length - 1);
        return args.includes('operatorId') ? [`${relative(apiSrc, file)}:${lineOf(source, start)}`] : [];
      });
    });

    expect(offenders).toEqual([]);
  });
});

/**
 * A CHEAP DISCOVERY AID. It is not the enforcement, and it cannot be.
 *
 * WHAT IT DOES. It reads the source tree looking for multi-row queries on the people tables, and
 * asks whether each one was consciously classified: either it composes the shared predicate, or it
 * carries a `// measured-people:allow — <reason>` marker on the line above. A query that is neither
 * fails, which is how a NEW people query anywhere in the API — including in files no test drives —
 * gets noticed at all. That reach is the only thing text scanning is genuinely good for.
 *
 * WHAT IT CANNOT DO, stated plainly because an earlier version of this file implied otherwise:
 *   - It cannot tell whether a query is actually measured. It sees a name in the argument text, not
 *     a where-clause. A predicate reached through a local alias, composed in a helper, or assembled
 *     into a `where` object above the call is invisible to it.
 *   - It cannot see `$queryRaw`, or any query built outside the shapes its regex knows.
 *   - Its marker is a comment, so anyone can silence it by typing one. That is a deliberate trade:
 *     the marker's job is to record a decision, not to verify one.
 *   - Even the "this query composes the predicate" branch is a heuristic. It now refuses a mention
 *     inside a comment or a string and refuses one nested under `NOT` / `none` / `isNot` / `OR` —
 *     the false-safe it used to have, where `NOT: { ...measuredMemberWhere }` (a query selecting
 *     exactly the excluded people) was classified as verified — but it is still reading text.
 *
 * WHERE THE ENFORCEMENT LIVES. measured-people-exclusion.test.ts seeds a workspace and asserts the
 * property against the real endpoints, and measured-people-harness.ts intercepts people queries at
 * runtime and inspects `args.where` as an object. Those two are sound; this one is a net.
 *
 * The exemptions live in the source rather than in a list of file:line pairs here. A line-keyed
 * allowlist rots on every unrelated edit above the query, and a guard test that fails for reasons
 * unrelated to what it guards gets skipped or deleted. A marker moves with the code it exempts,
 * and its reason is readable by whoever is editing that query rather than in another file.
 */
describe('people queries are classified', () => {
  /**
   * What counts as a people query, in two parts.
   *
   * RECEIVER — anything, not the literal `prisma.`. The same tables are reached through a
   * transaction client (`tx.`, the house idiom, six live call sites), through a parameter named
   * `client`, or through any local alias. A receiver-literal guard reads as thorough and exempts
   * every one of them: a participation rate written as `tx.checkInResponse.findMany` over
   * `tx.workspaceMember.findMany` passed the old scan untouched.
   *
   * SHAPE — the tables and calls a per-person number is actually written with:
   *   - workspaceMember / checkInResponse / user, in any multi-row form. A roster is as often
   *     `user.findMany({ where: { workspaces: { some: … } } })` as a membership read, and that
   *     spelling was invisible before.
   *   - task.groupBy / task.aggregate, which is how a ranking gets written — `by: ['assigneeId']`
   *     is a per-person rollup no matter that the rows are tasks. The leaderboard is exactly this,
   *     and is safe only because it iterates a measured roster and looks the group rows up by id;
   *     inverting that loop puts every agent back on it.
   * A plain `task.findMany` is deliberately out of scope: it is the workspace's own work list, and
   * scanning it would demand a marker on every task read in the API until nobody reads the markers.
   */
  const scanned =
    /\b[A-Za-z_$][\w$]*\.(?:(?:workspaceMember|checkInResponse|user)\.(?:findMany|count|groupBy|aggregate)|task\.(?:groupBy|aggregate))\s*\(/g;
  const marker = /^\s*\/\/\s*measured-people:allow\s*—\s*\S.*$/;
  /** How far above a query its marker may sit: enough for an opening `[` or a blank line. */
  const markerReach = 3;

  test('every multi-row people query either measures or carries a marker', () => {
    // Either apply measuredMemberWhere / measuredSubjectWhere, or put a
    // `// measured-people:allow — <reason>` comment directly above the query saying why it is not
    // measuring people.
    expect(classify().unclassified).toEqual([]);
  });

  // Separate test on purpose. Both assertions used to live in the one above, so the orphan check
  // was unreachable the moment anything was unclassified — the first `expect` throws and the second
  // never runs. The two failures also mean opposite things (a query nobody classified vs. a reason
  // nobody re-read) and each has to be able to fail on its own.
  test('every marker still exempts a query', () => {
    // A marker that exempts nothing is as bad as a missing one: it is a reason nobody re-read,
    // left behind by a query that moved or was deleted.
    expect(classify().orphans).toEqual([]);
  });

  test('a marker without a reason does not classify anything', () => {
    // The reason is the whole value of the marker. A bare `// measured-people:allow` is someone
    // silencing the guard, and the regex is what stops that from working.
    expect(marker.test('  // measured-people:allow — Member directory.')).toBe(true);
    expect(marker.test('  // measured-people:allow')).toBe(false);
    expect(marker.test('  // measured-people:allow — ')).toBe(false);
  });

  test('sees a people query through any client, not just `prisma`', () => {
    // The hole this guard was blind to, stated as an example rather than left to the next reader of
    // the regex: these three spellings all reach the same tables and all have to be scanned.
    expect(matchedCalls('await tx.checkInResponse.findMany({ where })')).toEqual(['tx.checkInResponse.findMany(']);
    expect(matchedCalls('client.workspaceMember.count({ where })')).toEqual(['client.workspaceMember.count(']);
    expect(matchedCalls('prisma.user.findMany({ where })')).toEqual(['prisma.user.findMany(']);
    // A per-person rollup over the task table is a people query however it is spelled.
    expect(matchedCalls("prisma.task.groupBy({ by: ['assigneeId'] })")).toEqual(['prisma.task.groupBy(']);
    // …but the workspace's own work list is not, or every task read in the API would need a marker.
    expect(matchedCalls('prisma.task.findMany({ where })')).toEqual([]);
  });

  test('a mention of the predicate is not the predicate', () => {
    // The false-safe this replaced, as a table. The old rule was `args.includes('measuredMemberWhere')`,
    // so every one of the last three cases classified as "this query measures people" — and the
    // second of them is a query that returns exactly the guests and agents.
    expect(mentionsPredicateConjunctively('({ where: { workspaceId, ...measuredMemberWhere } })')).toBe(true);
    expect(mentionsPredicateConjunctively('({ where: { assignee: { is: measuredSubjectWhere(id) } } })')).toBe(true);
    expect(mentionsPredicateConjunctively('({ where: measuredMemberWhere })')).toBe(true);

    // A comment that names the predicate. Nothing is filtered.
    expect(mentionsPredicateConjunctively('({\n  // like measuredMemberWhere, but for pickers\n  where: { workspaceId }\n})')).toBe(false);
    // Under NOT: the predicate's complement. This is the case that mattered.
    expect(mentionsPredicateConjunctively('({ where: { NOT: { ...measuredMemberWhere } } })')).toBe(false);
    // In a string, and inside an OR branch, where the other branch re-admits everyone.
    expect(mentionsPredicateConjunctively("({ where: { note: 'measuredMemberWhere' } })")).toBe(false);
    expect(mentionsPredicateConjunctively('({ where: { OR: [{ ...measuredMemberWhere }, { role: "GUEST" }] } })')).toBe(false);
  });

  function matchedCalls(source: string): string[] {
    return [...source.matchAll(scanned)].map((match) => match[0].replace(/\s+$/, ''));
  }

  /**
   * Whether the argument text names the shared predicate somewhere it would actually constrain the
   * query — in code rather than in a comment or a string, and not nested under a key that inverts
   * or weakens it.
   *
   * Still a text heuristic, and still fooled by a predicate composed anywhere but here. It exists to
   * stop the scan from certifying queries it never understood; the runtime guard is what verifies.
   */
  function mentionsPredicateConjunctively(args: string): boolean {
    const code = stripCommentsAndStrings(args);
    const mentions = new Set([...code.matchAll(predicateName)].map((match) => match.index ?? -1));
    if (!mentions.size) return false;

    const keyBefore = /([A-Za-z_$][\w$]*)\s*:\s*$/;
    const stack: string[] = [];

    for (let cursor = 0; cursor < code.length; cursor += 1) {
      const char = code[cursor];
      if (char === '{' || char === '[' || char === '(') {
        // A `{` is introduced by the key that precedes it, which is what says whether everything
        // inside is a constraint (`where:`, `assignee:`) or its opposite (`NOT:`, `none:`).
        stack.push(char === '(' ? '' : keyBefore.exec(code.slice(0, cursor))?.[1] ?? '');
        continue;
      }
      if (char === '}' || char === ']' || char === ')') {
        stack.pop();
        continue;
      }
      if (!mentions.has(cursor)) continue;
      if (!stack.some((key) => weakeningKeys.has(key))) return true;
    }

    return false;
  }

  const predicateName = /\b(?:measuredMemberWhere|measuredSubjectWhere)\b/g;
  /** Keys whose contents do not constrain the rows the query returns — or constrain the complement. */
  const weakeningKeys = new Set(['NOT', 'none', 'isNot', 'OR']);

  /** Blanks out comments and string literals, preserving length so positions stay meaningful. */
  function stripCommentsAndStrings(source: string): string {
    const out = source.split('');
    let mode: 'code' | 'line' | 'block' | 'quote' = 'code';
    let quote = '';

    for (let cursor = 0; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      const next = source[cursor + 1];
      const blank = () => {
        if (char !== '\n') out[cursor] = ' ';
      };

      if (mode === 'code') {
        if (char === '/' && next === '/') { mode = 'line'; blank(); continue; }
        if (char === '/' && next === '*') { mode = 'block'; blank(); continue; }
        if (char === "'" || char === '"' || char === '`') { mode = 'quote'; quote = char; blank(); continue; }
        continue;
      }
      if (mode === 'line') {
        if (char === '\n') mode = 'code';
        else blank();
        continue;
      }
      if (mode === 'block') {
        blank();
        if (char === '*' && next === '/') { out[cursor + 1] = ' '; cursor += 1; mode = 'code'; }
        continue;
      }
      blank();
      if (char === '\\') { if (cursor + 1 < source.length) out[cursor + 1] = ' '; cursor += 1; continue; }
      if (char === quote) mode = 'code';
    }

    return out.join('');
  }

  /** Every scanned query in the tree, split into the ones nobody classified and the dead markers. */
  function classify(): { unclassified: string[]; orphans: string[] } {
    const unclassified: string[] = [];
    const orphans: string[] = [];
    const usedMarkers = new Set<string>();

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const name = relative(apiSrc, file);

      for (const match of source.matchAll(scanned)) {
        const start = match.index ?? 0;
        const line = lineOf(source, start);
        const at = `${name}:${line}`;
        const call = match[0].replace(/\s*\($/, '');

        const marked = markerAbove(lines, line, markerReach);
        if (marked) {
          usedMarkers.add(`${name}:${marked}`);
          continue;
        }

        const args = balanced(source, start + match[0].length - 1);
        if (mentionsPredicateConjunctively(args)) continue;
        unclassified.push(`${at} ${call}`);
      }
    }

    for (const file of sourceFiles()) {
      const name = relative(apiSrc, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          if (marker.test(text) && !usedMarkers.has(`${name}:${index + 1}`)) orphans.push(`${name}:${index + 1}`);
        });
    }

    return { unclassified, orphans };
  }

  /** Line number (1-based) of the marker governing a query at `line`, or null. */
  function markerAbove(lines: string[], line: number, reach: number): number | null {
    for (let above = line - 1; above >= Math.max(1, line - reach); above -= 1) {
      if (marker.test(lines[above - 1] ?? '')) return above;
    }
    return null;
  }
});

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir)) {
      const path = join(dir, item);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(apiSrc);
  return files.sort();
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === '\n') line += 1;
  return line;
}

/** The call's argument text, from its opening paren to the paren that closes it. */
function balanced(source: string, openParen: number): string {
  let depth = 0;
  for (let cursor = openParen; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') depth += 1;
    else if (source[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, cursor + 1);
    }
  }
  return source.slice(openParen);
}
