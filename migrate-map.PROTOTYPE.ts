// #31 — move the map and its tickets from GitHub into Taskara, through the CLI.
//
// Driven entirely by `taskara …` rather than by Prisma or fetch, because the acceptance test is the
// surface, not the data. Anything this script cannot express is something an agent cannot do.
import { spawnSync } from 'node:child_process';

const CLI = '/Users/hypermadar/Workspace/taskara/plugins/taskara-agent/src/cli.ts';
const PROJECT = 'TKR';
const REPO = 'moeindanesh/taskara';

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
}

function gh(args: string[]): string {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`gh ${args.join(' ')}\n${run.stderr}`);
  return run.stdout;
}

/** Every call goes through the CLI. stdin carries bodies; nothing long rides on argv. */
function taskara(args: string[], stdin?: string): { code: number; out: string; err: string } {
  const run = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 64 * 1024 * 1024
  });
  return { code: run.status ?? -1, out: run.stdout, err: run.stderr };
}

function must(args: string[], stdin?: string): Record<string, unknown> {
  const result = taskara(args, stdin);
  if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.err}\n  taskara ${args.join(' ')}`);
  return JSON.parse(result.out) as Record<string, unknown>;
}

const issues = JSON.parse(
  gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '100', '--json', 'number,title,body,state,labels'])
) as GhIssue[];

const map = issues.find((issue) => issue.labels.some((label) => label.name === 'wayfinder:map'));
if (!map) throw new Error('no wayfinder:map issue');
const tickets = issues
  .filter((issue) => issue.number !== map.number)
  .filter((issue) => issue.labels.some((label) => label.name.startsWith('wayfinder:')))
  .sort((a, b) => a.number - b.number);

console.log(`map #${map.number}, ${tickets.length} tickets`);

// 1. The Effort. Body is a placeholder: the real one names tickets that do not exist yet, and the
//    whole point of migrating is that those names become Taskara keys.
const effort = must(
  ['task', 'create', '--project', PROJECT, '--title', map.title, '--kind', 'EFFORT', '--status', 'IN_PROGRESS', '--body', 'Migrating…'],
);
const effortKey = String(effort.key);
console.log(`effort ${effortKey}`);

// 2. Children, in GitHub order so creation order matches map order — wayfinder's frontier tie-break
//    is "first in map order", and Taskara has no explicit child order, so createdAt carries it.
const keyByNumber = new Map<number, string>();
for (const ticket of tickets) {
  const label = ticket.labels.map((item) => item.name).find((name) => name.startsWith('wayfinder:'));
  const created = must(
    [
      'task', 'create',
      '--project', PROJECT,
      '--title', ticket.title,
      '--parent', effortKey,
      ...(label ? ['--label', label] : []),
      '--body-file', '-'
    ],
    ticket.body || '(no body)'
  );
  keyByNumber.set(ticket.number, String(created.key));
  console.log(`  #${ticket.number} -> ${created.key}  ${ticket.state}`);
}

/** GitHub issue links become Taskara keys, so the migrated map points at itself. */
function rewrite(text: string): string {
  let out = text;
  for (const [number, key] of keyByNumber) {
    out = out.replaceAll(`https://github.com/${REPO}/issues/${number}`, key);
  }
  return out.replaceAll(`https://github.com/${REPO}/issues/${map.number}`, effortKey);
}

// 3. Resolution comments, then close. Comments first: closing is the last write, the way a session
//    does it, so a half-migrated ticket reads as open rather than as silently answered.
for (const ticket of tickets) {
  const key = keyByNumber.get(ticket.number);
  if (!key) continue;
  const comments = JSON.parse(
    gh(['issue', 'view', String(ticket.number), '--repo', REPO, '--json', 'comments'])
  ) as { comments: Array<{ body: string }> };
  for (const comment of comments.comments) {
    must(['task', 'comment', key, '--body-file', '-'], rewrite(comment.body));
  }
  if (ticket.state === 'CLOSED') must(['task', 'close', key, '--reason', 'completed']);
  if (comments.comments.length || ticket.state === 'CLOSED') {
    console.log(`  ${key}: ${comments.comments.length} comment(s)${ticket.state === 'CLOSED' ? ', closed' : ''}`);
  }
}

// 4. Blocking edges, second pass — issues need keys before they can reference each other.
let edges = 0;
for (const ticket of tickets) {
  const key = keyByNumber.get(ticket.number);
  if (!key) continue;
  const view = gh(['issue', 'view', String(ticket.number), '--repo', REPO]);
  const line = view.split('\n').find((row) => row.startsWith('blocked-by:'));
  if (!line) continue;
  for (const match of line.matchAll(/#(\d+)/g)) {
    const blocker = keyByNumber.get(Number(match[1]));
    if (!blocker) continue;
    const result = taskara(['task', 'edit', key, '--add-blocker', blocker]);
    if (result.code !== 0) {
      console.log(`  ! ${key} blocked-by ${blocker}: exit ${result.code} ${result.err.trim()}`);
      continue;
    }
    edges += 1;
  }
}
console.log(`${edges} blocking edges`);

// 5. The map body, with every link now pointing inside Taskara.
const current = must(['task', 'view', effortKey]);
must(
  ['task', 'edit', effortKey, '--body-file', '-', '--base-version', String(current.version)],
  rewrite(map.body)
);
console.log(`map body written (${rewrite(map.body).length} chars)`);
console.log(JSON.stringify({ effortKey, tickets: keyByNumber.size, edges }));
