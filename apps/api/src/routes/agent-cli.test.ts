import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';
import {
  lineBreakNotice,
  readFileBody,
  readInlineBody
} from '../../../../plugins/taskara-agent/src/core/line-breaks';
import { findMentionAttempts, mentionNotice } from '../../../../plugins/taskara-agent/src/core/mentions';

/**
 * The `taskara` CLI, driven as a process against a live API.
 *
 * This lives in the API suite rather than beside the plugin for two reasons. It needs a real server
 * — the contract under test is what the CLI does with an HTTP outcome, and mocking that would assert
 * the mock. And `test:api` is a CI gate while nothing runs the plugin's own directory, so a test
 * placed there would guard nothing.
 *
 * **The exit codes are the contract.** A skill pastes these commands into Bash and branches on `$?`.
 * Every code in the table is exercised here, because an undocumented and untested exit code is a
 * promise nobody has to keep.
 */

const cliPath = new URL('../../../../plugins/taskara-agent/src/cli.ts', import.meta.url).pathname;
const neutralCwd = tmpdir();

let app: FastifyInstance;
let baseUrl: string;
let fixture: Fixture;

interface Fixture {
  workspaceSlug: string;
  workspaceId: string;
  ownerId: string;
  ownerEmail: string;
  otherEmail: string;
  otherName: string;
  /** A human member who has never held a Task. The population #49 exists to reach. */
  idleEmail: string;
  idleName: string;
  idlePhone: string;
  /**
   * Two addresses the idle one is a substring of, one at each end, plus a mixed-case row.
   *
   * The pair is not decoration: a prepended lookalike catches a resolver that takes `items[0]` or
   * matches with `endsWith`, and an appended one catches `startsWith`. Their memberships are dated
   * so the wanted row sorts **last**, so no relaxation of the comparison can be accidentally right.
   */
  prefixedEmail: string;
  suffixedEmail: string;
  /** Written straight through Prisma in mixed case, the way a row predating the schema would be. */
  shoutedEmail: string;
  /** A real User row with no membership here. Resolution is workspace-scoped and must say so. */
  outsiderEmail: string;
  /** An agent User, in the roster and marked, operated by the owner. */
  agentEmail: string;
  agentToken: string;
  projectId: string;
  projectKeyPrefix: string;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

describe('taskara CLI', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    fixture = await createFixture();
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: fixture.workspaceId } });
    await prisma.user.deleteMany({
      where: {
        email: {
          in: [
            fixture.ownerEmail,
            fixture.otherEmail,
            fixture.idleEmail,
            fixture.prefixedEmail,
            fixture.suffixedEmail,
            fixture.shoutedEmail,
            fixture.outsiderEmail,
            fixture.agentEmail
          ]
        }
      }
    });
    await app.close();
  });

  describe('exit codes', () => {
    test('0 — the command succeeded, and the result is JSON on stdout', async () => {
      const created = await run(['task', 'create', '--project', fixture.projectId, '--title', 'Exit code zero']);

      expect(created.code).toBe(0);
      expect(created.json.key).toMatch(/-\d+$/);
      // The note goes to stderr so stdout stays a clean JSON document for `$( )` and `jq`.
      expect(created.stderr).toContain('Created');
      expect(() => JSON.parse(created.stdout)).not.toThrow();
    });

    test('1 — usage: an unknown verb, a missing required flag, and a mistyped flag', async () => {
      expect((await run(['task', 'frobnicate'])).code).toBe(1);
      expect((await run(['nonsense', 'view'])).code).toBe(1);
      expect((await run(['task', 'view'])).code).toBe(1);
      expect((await run(['task', 'create', '--title', 'No project'])).code).toBe(1);

      // A mistyped flag must not be ignored. Silently succeeding while dropping the caller's intent
      // is the worst outcome available: the script reports success and the label was never added.
      const typo = await run(['task', 'create', '--project', fixture.projectId, '--title', 'x', '--lable', 'oops']);
      expect(typo.code).toBe(1);
      expect(typo.stderr).toContain('--lable');
    });

    test('a stored credential stands in for the environment, and the environment still wins', async () => {
      const home = mkdtempSync(join(tmpdir(), 'taskara-home-'));
      mkdirSync(join(home, '.taskara'), { recursive: true });
      writeFileSync(
        join(home, '.taskara', 'credentials.json'),
        JSON.stringify({ apiUrl: baseUrl, workspaceSlug: fixture.workspaceSlug, token: 'stored-and-wrong' })
      );

      // Nothing in the environment: the file alone has to carry url and workspace. The token is
      // deliberately bad, so a 3 proves the file was read and sent rather than ignored.
      const fromFile = await run(['task', 'list'], {
        HOME: home,
        TASKARA_API_URL: undefined,
        TASKARA_WORKSPACE_SLUG: undefined,
        TASKARA_USER_EMAIL: undefined
      });
      expect(fromFile.code).toBe(3);

      // And the environment overrides it field by field, which is what keeps CI honest on a machine
      // that has also logged in.
      const envWins = await run(['task', 'list'], { HOME: home });
      expect(envWins.code).toBe(0);
    });

    test('2 — configuration: nothing is sent when the environment is unusable', async () => {
      const noUrl = await run(['task', 'list'], { TASKARA_API_URL: undefined });
      expect(noUrl.code).toBe(2);
      expect(noUrl.stderr).toContain('TASKARA_API_URL');

      const noAuth = await run(['task', 'list'], { TASKARA_USER_EMAIL: undefined, TASKARA_AGENT_TOKEN: undefined });
      expect(noAuth.code).toBe(2);

      // A misspelled runtime is a config error, not a shrug. The surface this replaces claimed
      // `CODEX` under all four runtimes, and silently sending nothing would repeat that in reverse.
      const badRuntime = await run(['task', 'list'], { TASKARA_AGENT_RUNTIME: 'CLAWED' });
      expect(badRuntime.code).toBe(2);
    });

    test('3 — auth: an identity the server will not accept', async () => {
      const unknown = await run(['task', 'list'], { TASKARA_USER_EMAIL: 'nobody@example.invalid' });
      expect(unknown.code).toBe(3);
    });

    test('4 — not found: a task key that does not exist', async () => {
      const missing = await run(['task', 'view', 'NOSUCH-999']);
      expect(missing.code).toBe(4);
      expect(missing.json.error).toBeDefined();
    });

    test('5 — conflict: the claim was lost, and stdout names the holder', async () => {
      const task = await createTaskViaApi('contested from the shell');
      expect((await run(['task', 'claim', task.key], { TASKARA_USER_EMAIL: fixture.otherEmail })).code).toBe(0);

      const lost = await run(['task', 'claim', task.key]);

      expect(lost.code).toBe(5);
      expect(lost.stderr).toContain(fixture.otherName);
      // Machine-readable too: a loser deciding what to do next should not have to scrape stderr.
      const error = lost.json.error as { task: { assignee: { name: string } } };
      expect(error.task.assignee.name).toBe(fixture.otherName);
    });

    test('6 — rejected: the server understood the request and refused it', async () => {
      const badStatus = await run([
        'task', 'list', '--status', 'unfinished,DONE'
      ]);
      expect(badStatus.code).toBe(6);
    });

    test('8 — unreachable: no HTTP response at all', async () => {
      // Port 1 on loopback refuses immediately, so this is a connection failure rather than a
      // timeout. The distinction from 7 matters: nothing reached the server, so nothing happened.
      const down = await run(['task', 'list'], { TASKARA_API_URL: 'http://127.0.0.1:1' });
      expect(down.code).toBe(8);
      expect(down.stderr).toContain('Cannot reach');
    });
  });

  describe('the tracker contract', () => {
    test('task create accepts --kind, and rejects a kind that is not one', async () => {
      // The grammar #25 specifies. Since #46 it produces a real effort end to end, which is the
      // command #31 has to run to put the map in Taskara at all.
      const effort = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'A map of the work',
        '--kind', 'EFFORT', '--status', 'IN_PROGRESS'
      ]);
      expect(effort.code).toBe(0);
      expect(effort.json.kind).toBe('EFFORT');

      // `--status` is not optional decoration here, and the shell does not supply it: `status`
      // defaults to TODO server-side and an effort may not be TODO, so omitting it is a refusal —
      // one that has to name the fix, because it is the first thing anyone minting a map will hit.
      const noStatus = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'A map with no status', '--kind', 'EFFORT'
      ]);
      expect(noStatus.code).toBe(6);
      expect(noStatus.stderr).toContain('IN_PROGRESS');

      // What the shell does own is refusing a kind that is not one, before anything is sent.
      const nonsense = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'x', '--kind', 'MAP'
      ]);
      expect(nonsense.code).toBe(1);
      expect(nonsense.stderr).toContain('WORK, EFFORT');
    });

    test('--parent takes a task key and resolves it to the uuid the API wants', async () => {
      const parent = await createTaskViaApi('a parent task');

      // #21 accepted that `parentId` is a uuid, not a key, and expected callers to resolve it once
      // per session. An agent holds keys — it reads TKR-12 in its own prompt — so the shell resolves.
      const child = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'A child', '--parent', parent.key
      ]);

      expect(child.code).toBe(0);
      expect(child.json.parentId).toBe(parent.id);
    });

    test('task list composes the frontier: unfinished, unassigned, unblocked children of one effort', async () => {
      // A plain parent task: #46 has not landed, so POST /tasks cannot mint an effort yet. What is
      // under test here is the composition, and `parentId` filters children regardless of the
      // parent's kind — #21 asserts separately that an effort's children stay listable.
      const effort = await createTaskViaApi('frontier parent');
      const takeable = await createTaskViaApi('takeable', { parentId: effort.id });
      const blocker = await createTaskViaApi('an open blocker');
      const blocked = await createTaskViaApi('blocked', { parentId: effort.id });
      const finished = await createTaskViaApi('finished', { parentId: effort.id, status: 'DONE' });
      await addBlocker(blocked.key, blocker.key);
      await claimViaApi(await createTaskViaApi('taken', { parentId: effort.id }));

      const frontier = await run([
        'task', 'list',
        '--parent', effort.key,
        '--status', 'unfinished',
        '--assignee', 'none',
        '--blockers', 'none',
        '--sort', 'createdAt:asc'
      ]);

      expect(frontier.code).toBe(0);
      const keys = (frontier.json.tasks as Array<{ key: string }>).map((task) => task.key);
      expect(keys).toEqual([takeable.key]);
      expect(keys).not.toContain(blocked.key);
      expect(keys).not.toContain(finished.key);
    });

    test('task edit adds and removes labels server-side, and repeats of the flag all survive', async () => {
      const task = await createTaskViaApi('relabelled from the shell', { labels: ['needs-triage'] });

      const edited = await run([
        'task', 'edit', task.key,
        '--add-label', 'wayfinder:task',
        '--add-label', 'backend',
        '--remove-label', 'needs-triage'
      ]);

      expect(edited.code).toBe(0);
      expect((edited.json.labels as string[]).sort()).toEqual(['backend', 'wayfinder:task']);
    });

    test('task edit adds and removes blockers by key', async () => {
      const task = await createTaskViaApi('has blockers');
      const first = await createTaskViaApi('first blocker');
      const second = await createTaskViaApi('second blocker');

      const added = await run(['task', 'edit', task.key, '--add-blocker', first.key, '--add-blocker', second.key]);
      expect(added.code).toBe(0);
      expect((added.json.blockers as string[]).sort()).toEqual([first.key, second.key].sort());

      const removed = await run(['task', 'edit', task.key, '--remove-blocker', first.key]);
      expect(removed.code).toBe(0);
      expect(removed.json.blockers).toEqual([second.key]);
    });

    test('--body-file - reads the body from stdin, which is how a map body arrives at all', async () => {
      // Tens of kilobytes of markdown with the characters a shell would eat inline. This is the
      // case the flag exists for: quoting this on a command line is where an agent's paste breaks.
      const body = `# Destination\n\n${'A line with "quotes", $dollars and `backticks`.\n'.repeat(290)}`;
      expect(body.length).toBeGreaterThan(13000);

      const created = await run(
        ['task', 'create', '--project', fixture.projectId, '--title', 'Body from stdin', '--body-file', '-'],
        {},
        body
      );

      expect(created.code).toBe(0);
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: String(created.json.id) } });
      expect(stored.description).toBe(body);
    });

    test('the description ceiling is the server’s, and the shell reports its refusal rather than pre-empting it', async () => {
      // A real map body — the one this effort is charted on measured over 22,000 characters. It
      // exceeds the 15,000 WORK ceiling and is refused, which is correct today: #46 has not landed,
      // so every row POST /tasks creates is WORK and the 60,000 effort ceiling is unreachable.
      // The shell deliberately does not carry a cap of its own. A client-side limit stricter than
      // the server's refuses valid input before sending it, which is what the plugin's hardcoded
      // 15000 used to do to an effort body.
      const mapBody = 'x'.repeat(23000);

      const refused = await run(
        ['task', 'create', '--project', fixture.projectId, '--title', 'A whole map', '--body-file', '-'],
        {},
        mapBody
      );

      expect(refused.code).toBe(6);
    });

    test('task close maps completed and canceled onto Taskara statuses', async () => {
      const done = await createTaskViaApi('to be completed');
      expect((await run(['task', 'close', done.key])).json.status).toBe('DONE');

      const canceled = await createTaskViaApi('to be canceled');
      const result = await run(['task', 'close', canceled.key, '--reason', 'canceled']);
      expect(result.json.status).toBe('CANCELED');

      expect((await run(['task', 'close', done.key, '--reason', 'not-planned'])).code).toBe(1);
    });

    test('task comment posts a comment, and task view --comments reads it back', async () => {
      const task = await createTaskViaApi('discussed');

      expect((await run(['task', 'comment', task.key, '--body', 'Picked this up.'])).code).toBe(0);

      const viewed = await run(['task', 'view', task.key, '--comments']);
      expect(viewed.code).toBe(0);
      const thread = viewed.json.commentThread as Array<{ body: string }>;
      expect(thread.map((comment) => comment.body)).toContain('Picked this up.');
    });

    /**
     * `task view` is the one command whose whole job is "show me this task", and for a while the
     * body only came back with `--comments` — a flag about the comment thread, which is what it
     * says it is. Reading a task therefore meant asking for something you did not want and hoping
     * the thing you did want rode along. It cost a real session a step during the map migration.
     */
    test('task view returns the body without being asked for the comment thread', async () => {
      const task = await createTaskViaApi('has a body');
      expect((await run(['task', 'edit', task.key, '--body', 'The body.'])).code).toBe(0);

      const plain = await run(['task', 'view', task.key]);
      expect(plain.code).toBe(0);
      expect(plain.json.description).toBe('The body.');
      // And the flag still means what it says: no thread unless asked.
      expect(plain.json.commentThread).toBeUndefined();

      const withThread = await run(['task', 'view', task.key, '--comments']);
      expect(withThread.json.description).toBe('The body.');
      expect(withThread.json.commentThread).toBeDefined();
    });
  });

  /**
   * Rewriting an Effort body is the one operation on this surface where two sessions collide by
   * design: every resolving session appends a line to the same index. The shell's whole job here is
   * to carry the version the caller read and to turn the server's refusal into exit 5 with enough in
   * it to retry.
   */
  describe('body concurrency', () => {
    test('task view reports the version, which is the thing a body rewrite has to quote', async () => {
      const task = await createTaskViaApi('has a version');

      const viewed = await run(['task', 'view', task.key]);

      expect(viewed.code).toBe(0);
      expect(viewed.json.version).toBe(1);
    });

    test('rewriting an Effort body without --base-version is refused by the server, exit 6', async () => {
      const effort = await createEffortViaApi('an effort rewritten blind');

      const blind = await run(['task', 'edit', effort.key, '--body', 'a whole new map'], {}, undefined);

      expect(blind.code).toBe(6);
      expect(blind.stderr).toContain('baseVersion');
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: effort.id } });
      expect(stored.description).toBe(effortBody);
    });

    test('two sessions appending to one Effort: the second exits 5 and its line is not in the body', async () => {
      const effort = await createEffortViaApi('an effort two sessions resolve against');

      // Both sessions read before either writes — the interleave that loses a line. `task view`
      // is the read an agent actually performs, so the version comes out of the same place the
      // body does rather than being fetched behind the caller's back at write time, which would
      // quote a version fresher than the body the caller edited.
      const sessionA = await run(['task', 'view', effort.key, '--comments']);
      const sessionB = await run(['task', 'view', effort.key, '--comments']);
      expect(sessionA.json.version).toBe(sessionB.json.version);

      const wrote = await run(
        ['task', 'edit', effort.key, '--body-file', '-', '--base-version', String(sessionA.json.version)],
        {},
        appended(String(sessionA.json.description), 'session A')
      );
      const lost = await run(
        ['task', 'edit', effort.key, '--body-file', '-', '--base-version', String(sessionB.json.version)],
        {},
        appended(String(sessionB.json.description), 'session B')
      );

      expect(wrote.code).toBe(0);
      expect(lost.code).toBe(5);

      const stored = await prisma.task.findUniqueOrThrow({ where: { id: effort.id } });
      expect(stored.description).toContain('session A');
      expect(stored.description).not.toContain('session B');
    });

    test('the losing session gets the current body and version on stdout, and one retry lands it', async () => {
      const effort = await createEffortViaApi('an effort whose loser retries');
      const read = await run(['task', 'view', effort.key, '--comments']);

      await run(
        ['task', 'edit', effort.key, '--body-file', '-', '--base-version', String(read.json.version)],
        {},
        appended(String(read.json.description), 'the winner')
      );
      const lost = await run(
        ['task', 'edit', effort.key, '--body-file', '-', '--base-version', String(read.json.version)],
        {},
        appended(String(read.json.description), 'the loser')
      );

      expect(lost.code).toBe(5);
      // Machine-readable, like a lost claim: a caller deciding what to do next should not have to
      // scrape stderr, and here it should not have to issue a second read either.
      const error = lost.json.error as { task: { version: number; description: string } };
      expect(error.task.description).toContain('the winner');

      const retried = await run(
        ['task', 'edit', effort.key, '--body-file', '-', '--base-version', String(error.task.version)],
        {},
        appended(error.task.description, 'the loser')
      );

      expect(retried.code).toBe(0);
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: effort.id } });
      expect(stored.description).toContain('the winner');
      expect(stored.description).toContain('the loser');
    });

    test('--base-version on its own is a usage error, not a no-op write that reports success', async () => {
      const task = await createTaskViaApi('nothing to change');

      const empty = await run(['task', 'edit', task.key, '--base-version', '1']);

      expect(empty.code).toBe(1);
      expect(empty.stderr).toContain('at least one change');
    });

    test('--base-version must be a number, and nothing is sent when it is not', async () => {
      const task = await createTaskViaApi('given a bad version');

      const bad = await run(['task', 'edit', task.key, '--title', 'Renamed', '--base-version', 'latest']);

      expect(bad.code).toBe(1);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe('given a bad version');
    });
  });

  describe('the project noun', () => {
    test('project list answers in a workspace holding no tasks at all', async () => {
      // The bootstrap. `task create --project` needs a project, and until this verb existed the only
      // shell-side source of one was an existing Task's `project.id` — so an empty workspace could
      // not be started from a shell at all. This is the read that breaks the circle.
      const listed = await run(['project', 'list']);

      expect(listed.code).toBe(0);
      const projects = listed.json.projects as Array<{ id: string; keyPrefix: string }>;
      expect(projects.map((project) => project.keyPrefix)).toContain(fixture.projectKeyPrefix);
      expect(projects.find((project) => project.keyPrefix === fixture.projectKeyPrefix)?.id)
        .toBe(fixture.projectId);
    });

    test('project create mints one, and the task that could not exist before now lands in it', async () => {
      const keyPrefix = `NEW${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const created = await run(['project', 'create', '--name', 'Freshly bootstrapped', '--key-prefix', keyPrefix]);

      expect(created.code).toBe(0);
      expect(created.json.keyPrefix).toBe(keyPrefix);
      expect(created.stderr).toContain(keyPrefix);

      // The whole point of the verb: the id it prints is the one `task create` was demanding.
      const task = await run(['task', 'create', '--project', String(created.json.id), '--title', 'The first one']);
      expect(task.code).toBe(0);
      expect(task.json.key).toStartWith(`${keyPrefix}-`);
    });

    test('a key prefix already in use is a conflict, not a rejection', async () => {
      // 5 rather than 6 because the caller's move differs: the request was well-formed and someone
      // else holds the name, which is the same shape of answer a lost `task claim` gives.
      const clash = await run(['project', 'create', '--name', 'Second claimant', '--key-prefix', fixture.projectKeyPrefix]);
      expect(clash.code).toBe(5);
    });
  });

  describe('--project takes the key prefix an agent already holds', () => {
    test('task create and task list both accept it, and it means the same project as the uuid', async () => {
      // `CORE` is the front half of every key in the project, so an agent reading CORE-123 in its own
      // prompt is already holding the handle. #45 settled the same argument for `--parent`.
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix, '--title', 'Addressed by prefix'
      ]);
      expect(created.code).toBe(0);
      expect((created.json.project as { id: string }).id).toBe(fixture.projectId);

      const listed = await run(['task', 'list', '--project', fixture.projectKeyPrefix, '--query', 'Addressed by prefix']);
      expect(listed.code).toBe(0);
      expect((listed.json.tasks as Array<{ key: string }>).map((task) => task.key)).toContain(String(created.json.key));
    });

    test('it is case-insensitive, because the server uppercases the prefix it stores', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix.toLowerCase(), '--title', 'Lower-cased prefix'
      ]);
      expect(created.code).toBe(0);
      expect((created.json.project as { id: string }).id).toBe(fixture.projectId);
    });

    test('an unknown prefix is 4, and the message names the prefixes that do exist', async () => {
      const missing = await run(['task', 'create', '--project', 'NOSUCH', '--title', 'Nowhere to put it']);

      expect(missing.code).toBe(4);
      expect(missing.stderr).toContain('NOSUCH');
      // The recovery is one line away and the shell already fetched it, so it says so rather than
      // making the caller run `project list` to find out what it should have typed.
      expect(missing.stderr).toContain(fixture.projectKeyPrefix);
    });

    test('project create --parent nests a subproject under a prefix', async () => {
      const keyPrefix = `SUB${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
      const child = await run([
        'project', 'create', '--name', 'A subproject', '--key-prefix', keyPrefix,
        '--parent', fixture.projectKeyPrefix
      ]);

      expect(child.code).toBe(0);
      expect(child.json.parentId).toBe(fixture.projectId);
    });
  });

  describe('the user noun', () => {
    test('user list names a person who holds no Task, which is the case that had no handle', async () => {
      // The hole #49 exists for. A user uuid appears in no key, no URL and no prose, and the only
      // place the shell surfaced one was beside an assignee on a Task that person already holds —
      // so handing work to somebody with none was the one case with no handle at all.
      const listed = await run(['user', 'list']);

      expect(listed.code).toBe(0);
      const users = listed.json.users as Array<{ id: string; email: string; name: string }>;
      const idle = users.find((user) => user.email === fixture.idleEmail);
      expect(idle).toBeDefined();
      expect(idle?.name).toBe(fixture.idleName);

      // The id it prints is the one `--add-assignee` was demanding, and the person it addresses has
      // never held a Task, so nothing else on the surface could have produced it.
      const task = await createTaskViaApi('work for somebody who holds none');
      const assigned = await run(['task', 'edit', task.key, '--add-assignee', String(idle?.id)]);
      expect(assigned.code).toBe(0);
      expect((assigned.json.assignee as { email: string }).email).toBe(fixture.idleEmail);
    });

    test('agents are in the roster and marked, because they are teammates and not colleagues', async () => {
      // #37 separated visibility from measurement: `measuredMemberWhere` keeps agents out of metrics
      // and out of nothing else. A roster that filtered them out would undo that; one that showed
      // them unmarked would make an agent indistinguishable from the person next to it.
      const listed = await run(['user', 'list']);
      const users = listed.json.users as Array<{
        email: string; kind: string; operatorId: string | null;
      }>;

      const agent = users.find((user) => user.email === fixture.agentEmail);
      expect(agent?.kind).toBe('AGENT');
      // The operator is the human it acts for, so the mark says whose machine this is, not just that
      // it is one.
      expect(agent?.operatorId).toBe(fixture.ownerId);

      const person = users.find((user) => user.email === fixture.idleEmail);
      expect(person?.kind).toBe('HUMAN');
      expect(person?.operatorId).toBeNull();
    });

    test('--kind filters server-side, so the total agrees with the rows', async () => {
      const humans = await run(['user', 'list', '--kind', 'HUMAN']);
      expect(humans.code).toBe(0);
      const humanRows = humans.json.users as Array<{ email: string; kind: string }>;
      expect(humanRows.every((user) => user.kind === 'HUMAN')).toBe(true);
      expect(humanRows.map((user) => user.email)).not.toContain(fixture.agentEmail);
      // Client-side filtering would leave `total` describing a different population than `users`,
      // and a caller paging through it would silently skip rows.
      expect(humans.json.total).toBe(humanRows.length);

      const agents = await run(['user', 'list', '--kind', 'AGENT']);
      expect(agents.code).toBe(0);
      const agentRows = agents.json.users as Array<{ email: string }>;
      expect(agentRows.map((user) => user.email)).toEqual([fixture.agentEmail]);
    });

    test('the roster prints what addressing a person needs and no more', async () => {
      // `GET /users` also returns a phone number, a Mattermost handle, an avatar and lifetime task
      // counts. None of that helps address anybody, and a roster is the one command whose whole
      // output is other people's details, so the shell renders a deliberately narrow projection.
      const listed = await run(['user', 'list']);
      const [first] = listed.json.users as Array<Record<string, unknown>>;

      expect(Object.keys(first ?? {}).sort())
        .toEqual(['email', 'id', 'kind', 'name', 'operatorId', 'role']);
      expect(listed.stdout).not.toContain(fixture.idlePhone);
    });

    test('--query finds a person by name, and the answer stays a list', async () => {
      const listed = await run(['user', 'list', '--query', fixture.idleName]);

      expect(listed.code).toBe(0);
      expect((listed.json.users as Array<{ email: string }>).map((user) => user.email))
        .toContain(fixture.idleEmail);
      // A name carries no unique constraint, so the search that accepts one must never collapse to a
      // single answer. It is a list, with a total, however many rows come back.
      expect(Array.isArray(listed.json.users)).toBe(true);
      expect(typeof listed.json.total).toBe('number');
    });

    test('an agent credential may read the roster, and still may not administer', async () => {
      // The scope decision, made rather than inherited. Handing work to a person is a thing this map
      // says agents do, the CLI is the only surface a skill can reach, and reading who exists is the
      // one prerequisite. It grants nothing new either: every Task already carries
      // `assignee: { id, name, email }`, so a credential could already enumerate everyone who holds
      // work. What the roster adds is the people who hold none — this ticket's whole population.
      const asCredential = { TASKARA_AGENT_TOKEN: fixture.agentToken, TASKARA_USER_EMAIL: undefined };
      const listed = await run(['user', 'list'], asCredential);

      expect(listed.code).toBe(0);
      expect((listed.json.users as Array<{ email: string }>).map((user) => user.email))
        .toContain(fixture.idleEmail);

      // Reading who is on the team and writing who is on the team stay separated at the seam #29
      // built for it: no verb here reaches `requireWorkspaceAdmin`, because a credential can never
      // satisfy it, and a documented string that can never work is worse than no string.
      const created = await run(['user', 'create', '--email', 'nobody@example.test'], asCredential);
      expect(created.code).toBe(1);
      expect(created.stderr).toContain('list');
    });
  });

  describe('addressing a person', () => {
    test('--add-assignee takes an email, which is the one unique handle a person has in prose', async () => {
      const task = await createTaskViaApi('handed over by email');

      const assigned = await run(['task', 'edit', task.key, '--add-assignee', fixture.idleEmail]);

      expect(assigned.code).toBe(0);
      expect((assigned.json.assignee as { id: string; email: string }).email).toBe(fixture.idleEmail);
    });

    test('a name is refused before anything is sent, because a name is not an identifier', async () => {
      // The trap this ticket names. `User.name` has no unique constraint, so resolving one would be
      // a heuristic that is right until two people share a first name. Exit 1 rather than a lookup:
      // nothing was sent, and retrying is pointless.
      const task = await createTaskViaApi('never handed to a name');

      const byName = await run(['task', 'edit', task.key, '--add-assignee', fixture.idleName]);

      expect(byName.code).toBe(1);
      expect(byName.stderr).toContain('user list');
      const untouched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(untouched.assigneeId).toBeNull();
    });

    test('me on a write says which verb to use instead', async () => {
      // A credential never learns its own user id — `task list --assignee me` works only because the
      // server answers "mine" without one. `task claim` is the tracker contract's take-it-yourself
      // verb and it is atomic, so pointing at it is better than teaching this flag a second way.
      const task = await createTaskViaApi('not mine to take this way');

      const mine = await run(['task', 'edit', task.key, '--add-assignee', 'me']);

      expect(mine.code).toBe(1);
      expect(mine.stderr).toContain('task claim');
    });

    test('an email nobody in this workspace holds is 4, and says where to look', async () => {
      const task = await createTaskViaApi('addressed to nobody');

      const missing = await run(['task', 'edit', task.key, '--add-assignee', 'ghost@example.invalid']);

      expect(missing.code).toBe(4);
      expect(missing.stderr).toContain('ghost@example.invalid');
      expect(missing.stderr).toContain('user list');
    });

    test('resolution is exact, so a lookalike address never gets the work by accident', async () => {
      // `GET /users?q=` matches with `contains`, so searching for `dana@…` also returns the two
      // addresses that extend it. Every relaxation of `===` has a wrong answer waiting here:
      // `items[0]` and `endsWith` reach the prefixed row, `startsWith` the suffixed one.
      //
      // **The precondition is asserted, not assumed.** An earlier version of this test passed with
      // the resolver taking `items[0]`, because the memberships were written by one `createMany`
      // and the `createdAt` tie happened to order the wanted row first — the fixture was deciding
      // the answer. If that ordering ever changes, this line fails instead of the test going quiet.
      const search = await run(['user', 'list', '--query', fixture.idleEmail]);
      const found = (search.json.users as Array<{ email: string }>).map((user) => user.email);
      expect(found).toEqual([fixture.suffixedEmail, fixture.prefixedEmail, fixture.idleEmail]);

      for (const email of [fixture.idleEmail, fixture.prefixedEmail, fixture.suffixedEmail]) {
        const task = await createTaskViaApi(`addressed to ${email}`);
        const assigned = await run(['task', 'edit', task.key, '--add-assignee', email]);

        expect(assigned.code).toBe(0);
        expect((assigned.json.assignee as { email: string }).email).toBe(email);
      }
    });

    test('case is folded on both sides, so a mixed-case row is still reachable', async () => {
      // The input half is obvious. The stored half is not: `createUserSchema` lowercases on write,
      // but a row written any other way — a migration, a direct Prisma call, this fixture — keeps
      // whatever case it was given, and without folding the stored side it can never be addressed.
      const shouted = await createTaskViaApi('handed to a mixed-case row');
      const byLower = await run([
        'task', 'edit', shouted.key, '--add-assignee', fixture.shoutedEmail.toLowerCase()
      ]);
      expect(byLower.code).toBe(0);
      expect((byLower.json.assignee as { email: string }).email).toBe(fixture.shoutedEmail);

      const plain = await createTaskViaApi('shouted at in capitals');
      const byUpper = await run([
        'task', 'edit', plain.key, '--add-assignee', fixture.idleEmail.toUpperCase()
      ]);
      expect(byUpper.code).toBe(0);
      expect((byUpper.json.assignee as { email: string }).email).toBe(fixture.idleEmail);
    });

    test('a real user who is not a member of this workspace does not resolve', async () => {
      // `GET /users` is workspace-scoped, and resolution inherits that rather than working around
      // it. An address that exists in the database but not in this workspace is a 4, not a silent
      // assignment across a boundary.
      const task = await createTaskViaApi('addressed outside the workspace');

      const outside = await run(['task', 'edit', task.key, '--add-assignee', fixture.outsiderEmail]);

      expect(outside.code).toBe(4);
      const untouched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(untouched.assigneeId).toBeNull();
    });

    test('task create and task list take the same email, so one flag means one thing', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix,
        '--title', 'Filed straight onto a person', '--assignee', fixture.idleEmail
      ]);
      expect(created.code).toBe(0);
      expect((created.json.assignee as { email: string }).email).toBe(fixture.idleEmail);

      const listed = await run(['task', 'list', '--assignee', fixture.idleEmail]);
      expect(listed.code).toBe(0);
      expect((listed.json.tasks as Array<{ key: string }>).map((task) => task.key))
        .toContain(String(created.json.key));
    });

    test('the sentinels survive: none and me still mean what they meant', async () => {
      // Both are values the resolver must let past untouched. `none` is #21's absence sentinel and
      // `me` is the only way a credential can ask about itself.
      const unassigned = await run(['task', 'list', '--assignee', 'none', '--limit', '5']);
      expect(unassigned.code).toBe(0);

      const mine = await run(['task', 'list', '--assignee', 'me', '--limit', '5']);
      expect(mine.code).toBe(0);
    });
  });

  /**
   * #54 — the verb an agent needs in order to tidy up after itself, and a person needs in order to
   * stop hearing about a task they were once mentioned in.
   */
  describe('watching a task', () => {
    test('unsubscribe stops it, and the next assignment does not undo that', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'Watched then dropped',
        '--assignee', fixture.otherEmail
      ]);
      expect(created.code).toBe(0);
      const key = String(created.json.key);

      // The owner is the reporter, so the owner is watching it. Unsubscribe as the owner, which is
      // the identity every other command in this file runs as.
      const dropped = await run(['task', 'unsubscribe', key]);
      expect(dropped.code).toBe(0);
      expect(dropped.json.state).toBe('muted');
      expect(listedKeys(await run(['task', 'list', '--subscription', 'watching']))).not.toContain(key);

      // Re-assigned to the person who unsubscribed — the exact sequence that used to re-add them.
      expect((await run(['task', 'edit', key, '--add-assignee', fixture.ownerEmail])).code).toBe(0);
      expect(listedKeys(await run(['task', 'list', '--subscription', 'watching']))).not.toContain(key);
      expect(listedKeys(await run(['task', 'list', '--subscription', 'muted']))).toContain(key);
    });

    test('subscribe is the way back, and the two verbs are exact opposites', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectId, '--title', 'Dropped then picked up'
      ]);
      const key = String(created.json.key);
      expect((await run(['task', 'unsubscribe', key])).code).toBe(0);

      const back = await run(['task', 'subscribe', key]);

      expect(back.code).toBe(0);
      expect(back.json.state).toBe('watching');
      expect(listedKeys(await run(['task', 'list', '--subscription', 'watching']))).toContain(key);
      expect(listedKeys(await run(['task', 'list', '--subscription', 'muted']))).not.toContain(key);
    });

    test('an agent credential may unsubscribe, so tidying up is not a human-only verb', async () => {
      const created = await run(['task', 'create', '--project', fixture.projectId, '--title', 'Agent tidying up']);
      const key = String(created.json.key);

      const asAgent = { TASKARA_AGENT_TOKEN: fixture.agentToken, TASKARA_USER_EMAIL: undefined };
      const tidied = await run(['task', 'unsubscribe', key], asAgent);

      expect(tidied.code).toBe(0);
      // `none`, not `muted`. The server records no decision for an agent — there is nothing to keep
      // quiet — and the shell relays that rather than printing the state a person would have got.
      expect(tidied.json.state).toBe('none');

      // The claim the answer makes is checkable, and checked: nothing turned up in the muted list.
      expect(listedKeys(await run(['task', 'list', '--subscription', 'muted']))).not.toContain(key);

      // The other half of the same rule, and the exit code the skill documents. #39: an agent has no
      // inbox, so watching is the one of the two verbs that cannot mean anything for it — refused
      // with a reason rather than reported as done.
      const refused = await run(['task', 'subscribe', key], asAgent);
      expect(refused.code).toBe(6);
      expect(refused.stderr).toContain('no notifications');
    });

    test('a subscription value that is not one of the two is a usage error, not a silent full list', async () => {
      const wrong = await run(['task', 'list', '--subscription', 'ignored']);

      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain('watching');
    });
  });

  /**
   * Issue #53 — a mention is a web-editor affordance, and a markdown body carries none.
   *
   * The extractor on the server reads mention **nodes**, so a body written here notifies nobody
   * however it spells a person. The decision is that this stays so; what changes is that the
   * surface says it out loud instead of accepting the body and dropping the intent.
   */
  describe('an @-mention in a body', () => {
    test('a handle written in prose is found, name or address alike', () => {
      expect(findMentionAttempts('@Robin please look at this')).toEqual(['@Robin']);
      expect(findMentionAttempts('ping @robin@example.test when the build is green'))
        .toEqual(['@robin@example.test']);
      expect(findMentionAttempts('cc **@robin** and (@sara), then @robin again'))
        .toEqual(['@robin', '@sara']);
      // A sentence ends in a full stop and a handle does not — but a name may well contain one, so
      // the trailing dot comes off and an interior one stays.
      expect(findMentionAttempts('please ask @robin. @robin.example knows the rest.'))
        .toEqual(['@robin', '@robin.example']);
    });

    test('the shapes that merely contain an @ are left alone', () => {
      // The whole value of this warning is that it is rare. One that fires on `@types/node` is one
      // an agent learns to ignore, and then the real one goes past unread too. Every string here is
      // something a session genuinely writes into a task body.
      const quiet = [
        'bun add @types/node @modelcontextprotocol/sdk',
        'mail robin@example.test about it',
        'the reflog entry is HEAD@{1}',
        'reach us at <ops@example.test>',
        'see https://example.test/@robin for the thread',
        'an @ on its own, and @ robin with a space',
        'inline `@media (min-width: 40rem)` and `@param` in a doc comment',
        ['```css', '@media (min-width: 40rem) { .a { color: red } }', '```'].join('\n'),
        ['~~~python', '@pytest.mark.parametrize("x", [1])', 'def t(x): ...', '~~~'].join('\n')
      ];

      for (const body of quiet) {
        expect({ body, found: findMentionAttempts(body) }).toEqual({ body, found: [] });
      }
    });

    test('a body that came back from `task view` is not second-guessed', () => {
      // A session that appends to an existing body reads it first, and a body the web editor wrote
      // is Lexical JSON whose mention nodes carry their own `@Sara` text. Those mentions **work**;
      // warning about them would be false and would teach a caller to strip a live mention out.
      const fromTheEditor = JSON.stringify({
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'mention', text: '@Sara', mentionName: 'Sara', mentionUserId: 'user-sara' },
                { type: 'text', text: ' please look at this' }
              ]
            }
          ]
        }
      });

      expect(findMentionAttempts(fromTheEditor)).toEqual([]);
    });

    test('the notice names the handles, and stops naming them before it becomes the body', () => {
      // Naming them is the point — a true warning is actionable and a false one is visibly false.
      // But a map body can carry dozens, and a stderr line that reprints half of one is a line
      // nobody finishes reading.
      const reach = 'Use --add-assignee.';
      const into = 'description' as const;
      expect(mentionNotice('@Robin please look', reach, into)).toContain('@Robin looks like a mention');
      expect(mentionNotice('@a @b @c @d @e', reach, into))
        .toContain('@a, @b, @c and 2 more look like mentions');
      expect(mentionNotice('bun add @types/node', reach, into)).toBeUndefined();

      // The pointer is the caller's: the CLI takes an email on a flag and MCP takes a uuid, so the
      // core states the rule and each shell names verbs its own caller can type.
      expect(mentionNotice('@Robin please look', reach, into)).toEndWith(reach);
    });

    test('the notice names a writer for a description and none for a comment', () => {
      // #56. The rule clause was written for a description and printed on all three verbs, so
      // `task comment` told a caller that a mention is «a node the web editor writes» — and sent
      // them at a client that cannot write one either. The web comment box is a plain textarea and
      // the mention-capable editor is mounted on descriptions only, so a comment mention is a rule
      // with no writer. The surface has to say that, not name a writer that does not exist.
      const reach = 'Use --add-assignee.';

      const onDescription = mentionNotice('@Robin please look', reach, 'description');
      expect(onDescription).toContain('a node the web editor writes');

      const onComment = mentionNotice('@Robin please look', reach, 'comment');
      expect(onComment).not.toContain('the web editor writes');
      expect(onComment).toContain('no comment box writes one');
      // Told once, and then told what does work — the pointer is unchanged by which body it was.
      expect(onComment).toEndWith(reach);
      expect(onComment).toContain('@Robin looks like a mention and notified nobody');
    });

    test('task create keeps the body and says who it did not reach', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix,
        '--title', 'Mention written in markdown',
        '--body', `@Robin and ${fixture.idleEmail} — please look before Friday`
      ]);

      // **Exit 0, not 1.** A mistyped flag is unambiguously wrong and exits 1; this is a guess about
      // prose, and refusing to store text on a guess leaves the caller with no way to write the
      // sentence at all. The body is still worth keeping — a human reads it — so the write lands and
      // the surface says what the write did not do.
      expect(created.code).toBe(0);
      expect(created.stderr).toContain('Created');
      expect(created.stderr).toContain('@Robin');
      expect(created.stderr).toContain('--add-assignee');

      // Said, never silently repaired: the body is stored exactly as it was written.
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: String(created.json.id) } });
      expect(stored.description).toBe(`@Robin and ${fixture.idleEmail} — please look before Friday`);

      // And the warning is true. Nobody was notified, least of all the person whose address is in
      // the body: a markdown body carries no mention nodes, so the extractor finds nothing.
      const notified = await prisma.notification.findMany({ where: { taskId: stored.id } });
      expect(notified).toEqual([]);
    });

    test('a body with nothing to warn about gets nothing said about it', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix,
        '--title', 'An ordinary body',
        '--body', 'Install with `bun add @types/node`, then mail robin@example.test.'
      ]);

      expect(created.code).toBe(0);
      expect(created.stderr.trim()).toBe(`Created ${String(created.json.key)}`);
    });

    test('task edit and task comment say it too, because the body reads the same in all three', async () => {
      const task = await createTaskViaApi('Mention on the other two verbs');

      const edited = await run(['task', 'edit', task.key, '--body', '@Robin one more look?']);
      expect(edited.code).toBe(0);
      expect(edited.stderr).toContain('@Robin');

      const commented = await run(['task', 'comment', task.key, '--body', 'thanks @Robin']);
      expect(commented.code).toBe(0);
      expect(commented.stderr).toContain('@Robin');

      // And the notice is true on all three verbs for the same reason: no mention nodes, nobody
      // told. When #53 shipped, the comment verb was true by accident — `addTaskComment` scanned
      // nothing, so the web would not have notified either and the notice's *reason* was only half
      // right. #55 closed that, and the sentence the CLI prints is now the whole explanation.
      const mentions = await prisma.notification.findMany({
        where: { taskId: task.id, type: 'task_mentioned' }
      });
      expect(mentions).toEqual([]);

      // But the two verbs do **not** say the same thing about who could have written one, and #56
      // is the reason. `task edit` writes a description, and a description's mention has a real
      // writer — a human in the web editor's autocomplete — so the notice names it and a session
      // can hand the request over. A comment's has none: `TaskComment.body` is plain text and the
      // web comment box is a plain textarea, so the same sentence there would send the session to
      // ask a human for something no human can do. Asserted through the spawned binary rather than
      // on the core, because the wiring is what regresses: the shell passes which body it wrote.
      expect(edited.stderr).toContain('a node the web editor writes');
      expect(commented.stderr).not.toContain('the web editor writes');
      expect(commented.stderr).toContain('no comment box writes one');
      expect(commented.stderr).toContain('a human cannot make one for you');
    });

    test('a comment that carries a mention node does reach the person, and is not warned about', async () => {
      // #55, from the shell, because the rule is about the nodes and not about the client. A
      // markdown comment mentions nobody (above); a comment that IS an editor state mentions
      // whoever its nodes name — the same body a session gets back from `task view` and appends to.
      const task = await createTaskViaApi('a question asked in a comment');
      const idle = await prisma.user.findUniqueOrThrow({ where: { email: fixture.idleEmail } });
      const body = JSON.stringify({
        root: {
          type: 'root',
          children: [{
            type: 'paragraph',
            children: [
              { type: 'mention', version: 1, text: `@${fixture.idleName}`, mentionUserId: idle.id },
              { type: 'text', text: ' does this look right to you?' }
            ]
          }]
        }
      });

      const commented = await run(['task', 'comment', task.key, '--body-file', '-'], {}, body);

      expect(commented.code).toBe(0);
      // The outcome line and nothing else. Warning about a live mention would be false, and would
      // teach a caller to strip one out of a body it was only appending to.
      expect(commented.stderr.trim()).toBe(`Commented on ${task.key}`);

      const mentions = await prisma.notification.findMany({
        where: { taskId: task.id, type: 'task_mentioned' }
      });
      expect(mentions.map((mention) => mention.userId)).toEqual([idle.id]);
      // Named, and therefore watching — so the answer to the question reaches them too.
      expect(await prisma.taskSubscription.count({ where: { taskId: task.id, userId: idle.id } })).toBe(1);
    });
  });

  describe('a line break written as \\n', () => {
    test('an inline body gets its breaks back, and a file body is never touched', () => {
      // The shape that prompted this, copied from a Task an agent filed: Persian prose whose bold
      // leads rendered as bold while the paragraph breaks between them reached the screen as a
      // backslash and an n. The body is one line as far as argv is concerned, and it is not.
      const filed = 'کاربر نباید انبارگردانیِ شعبه‌های دیگر را ببیند.\\n\\n**اهمیت:** فوری\\nددلاین: امروز';
      const read = readInlineBody(filed);
      expect(read.restored).toBe(3);
      expect(read.text).toBe('کاربر نباید انبارگردانیِ شعبه‌های دیگر را ببیند.\n\n**اهمیت:** فوری\nددلاین: امروز');

      expect(readInlineBody('line1\\nline2')).toEqual({ text: 'line1\nline2', restored: 1 });
      // Written for a shell that would have eaten the CR too. Both halves go, or a stray `\r` is
      // left visible on every line.
      expect(readInlineBody('a\\r\\nb')).toEqual({ text: 'a\nb', restored: 1 });

      // The same characters chosen deliberately, byte for byte. `--body-file` and stdin come here.
      expect(readFileBody('line1\\nline2')).toEqual({ text: 'line1\\nline2', restored: 0 });
    });

    test('a body that is about an escape is not read as one', () => {
      // The false positive worth the whole shape of the rule, and one this repo would write: a task
      // filed *about* escape handling. Under backticks and under quotes, because a body reaches for
      // whichever the writer had to hand.
      expect(readInlineBody('fix `split(\'\\n\')` in parser.ts').restored).toBe(0);
      expect(readInlineBody('Fix split(\'\\n\') and join("\\n") in parser.ts').restored).toBe(0);

      // A backslash that begins anything else means the body speaks a language with more words than
      // this one knows. Giving back half of them is worse than giving back none.
      expect(readInlineBody('a\\nb\\tc').restored).toBe(0);
      expect(readInlineBody('the pattern is \\d+\\.\\s and then\\nthe rest').restored).toBe(0);
      // `C:\node` is the one path shape that collides head-on. A drive letter is exactly one letter,
      // which is what keeps a Persian label and a colon out of the exclusion.
      expect(readInlineBody('Copy C:\\node and C:\\newbuild to the host').restored).toBe(0);
      expect(readInlineBody('اهمیت:\\nفوری').restored).toBe(1);

      // A body that already has a line of its own was never flattened by argv, so what is left in
      // it is its subject.
      expect(readInlineBody('real\nbreak, and a \\n that is text').restored).toBe(0);

      // The in-band way to insist. The doubled backslash is part of no break, so the whole body
      // comes back exactly as written rather than half-read.
      expect(readInlineBody('send \\\\n as the two characters').restored).toBe(0);
    });

    test('the editor’s own document is left alone, because a \\n in it is JSON’s', () => {
      // The body class this rule could actually destroy. One column holds two formats
      // (`CONTEXT.md`, «Body»), and the web's half is a JSON document on one line — a code block
      // keeps its lines inside a single text node, so the break between them is spelled `\n` in the
      // source. Decoding that leaves a string literal with a raw newline in it, and the document
      // stops parsing: `syncEditorValue` falls through its catch to a plain-text load and every
      // mention node in the body is gone.
      const document = JSON.stringify({
        root: {
          type: 'root',
          children: [{
            type: 'code',
            language: 'ts',
            children: [{ type: 'text', version: 1, text: 'const a = 1;\nconst b = 2;' }]
          }]
        }
      });
      // The premise: one line as far as any of the cheap tests can see, and an escape in it.
      expect(document).not.toContain('\n');
      expect(document).toContain('\\n');

      const read = readInlineBody(document);
      expect(read.restored).toBe(0);
      expect(read.text).toBe(document);
      // The assertion that matters, and not string identity alone: the failure is silent in every
      // reader, so what has to be true is that the document still loads.
      expect(() => JSON.parse(read.text)).not.toThrow();
    });

    test('the notice counts what it did and names the way out', () => {
      const reach = 'A body sent with --body-file - arrives exactly as written.';
      expect(lineBreakNotice(readInlineBody('a\\nb'), reach)).toContain('One \\n was read as a line break');
      expect(lineBreakNotice(readInlineBody('a\\nb\\nc'), reach)).toContain('2 \\n were read as line breaks');
      expect(lineBreakNotice(readInlineBody('a\\nb'), reach)).toEndWith(reach);
      // Silent when it changed nothing, so the line means what it says on the writes it appears on.
      expect(lineBreakNotice(readInlineBody('ordinary prose'), reach)).toBeUndefined();
      expect(lineBreakNotice(readFileBody('a\\nb'), reach)).toBeUndefined();
      expect(lineBreakNotice(undefined, reach)).toBeUndefined();
    });

    test('task create stores the break and says it read one', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix,
        '--title', 'A body written through argv',
        '--body', 'The first paragraph.\\n\\nThe second one.'
      ]);

      expect(created.code).toBe(0);
      expect(created.stderr).toContain('2 \\n were read as line breaks');
      expect(created.stderr).toContain('--body-file -');

      // The column is what the change is for: every reader downstream — the web editor, the inbox
      // card, `task view` — sees a break because there is one, not because it guessed.
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: String(created.json.id) } });
      expect(stored.description).toBe('The first paragraph.\n\nThe second one.');
    });

    test('a body with no escapes to read gets nothing said about it', async () => {
      const created = await run([
        'task', 'create', '--project', fixture.projectKeyPrefix,
        '--title', 'An ordinary inline body',
        '--body', 'One paragraph, said in one line.'
      ]);

      expect(created.code).toBe(0);
      expect(created.stderr.trim()).toBe(`Created ${String(created.json.key)}`);
    });

    test('--body-file - is still the bytes it was given, escapes and all', async () => {
      // The guarantee `--body-file` exists for, restated against the new rule: a map body quoting a
      // `\n` in a code sample must arrive as those characters, because somebody chose them.
      const body = '# Sample\n\n```ts\nconst lines = raw.split(\'\\n\');\n```\n';

      const created = await run(
        ['task', 'create', '--project', fixture.projectKeyPrefix, '--title', 'A body chosen byte by byte', '--body-file', '-'],
        {},
        body
      );

      expect(created.code).toBe(0);
      expect(created.stderr.trim()).toBe(`Created ${String(created.json.key)}`);
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: String(created.json.id) } });
      expect(stored.description).toBe(body);
    });

    test('task edit and task comment read a body the same way, because it is one rule', async () => {
      const task = await createTaskViaApi('the other two writing verbs');

      const edited = await run(['task', 'edit', task.key, '--body', 'Rewritten.\\nOn two lines.']);
      expect(edited.code).toBe(0);
      expect(edited.stderr).toContain('One \\n was read as a line break');

      const commented = await run(['task', 'comment', task.key, '--body', 'First.\\nSecond.']);
      expect(commented.code).toBe(0);
      expect(commented.stderr).toContain('One \\n was read as a line break');

      // A comment matters most of the three. `TaskComment.body` is plain text in every client
      // (`docs/adr/0003`), so there is no renderer downstream to be generous about it: a backslash
      // stored here is a backslash on every screen forever.
      const stored = await prisma.taskComment.findFirstOrThrow({
        where: { taskId: task.id }, orderBy: { createdAt: 'desc' }
      });
      expect(stored.body).toBe('First.\nSecond.');
    });
  });

  describe('identity', () => {
    test('the runtime is sent as itself, and the surface no longer claims to be CODEX', async () => {
      const created = await run(
        ['task', 'create', '--project', fixture.projectId, '--title', 'Runtime recorded'],
        { TASKARA_AGENT_RUNTIME: 'CLAUDE_CODE' }
      );
      expect(created.code).toBe(0);

      // The configured identity here is a human, and the API records a runtime only for agents — so
      // the assertion that bites is the negative one. The old surface hardcoded source CODEX and
      // `x-actor-type: CODEX` on every call under every runtime; nothing here says CODEX any more.
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: String(created.json.id) } });
      expect(stored.source).not.toBe('CODEX');

      const activity = await prisma.activityLog.findFirst({
        where: { entityId: stored.id, action: 'created' }
      });
      expect(activity?.actorType).toBe('USER');
      expect(activity?.actorRuntime).toBeNull();
    });
  });
});

/** The keys `task list` printed, for the filters whose whole claim is which rows come back. */
function listedKeys(result: CliRun): string[] {
  expect(result.code).toBe(0);
  return ((result.json.tasks as Array<{ key: string }>) ?? []).map((task) => task.key);
}

async function run(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  stdin?: string
): Promise<CliRun> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    // A HOME of its own, for the same reason the cwd is neutral. `readConfig` falls back to
    // ~/.taskara/credentials.json, so a developer who has ever run `taskara login` would otherwise
    // have the configuration tests below quietly pass their real credentials to the CLI -- the
    // "unusable environment" case would resolve and exit 4 instead of 2. It passed in CI, where no
    // such file exists, and failed on the machine that wrote one, which is the worst way round.
    HOME: neutralCwd,
    TASKARA_API_URL: baseUrl,
    TASKARA_WORKSPACE_SLUG: fixture.workspaceSlug,
    TASKARA_USER_EMAIL: fixture.ownerEmail
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const proc = Bun.spawn(['bun', cliPath, ...args], {
    // A directory with no `.env`. Bun auto-loads one from the process cwd, so a CLI spawned from
    // the repo root silently gets the repo's own TASKARA_* values back — which would make the
    // configuration tests below assert nothing.
    cwd: neutralCwd,
    env,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe'
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { code, stdout, stderr, json };
}

async function createTaskViaApi(
  title: string,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; key: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { projectId: fixture.projectId, title, ...extra }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { id: string; key: string };
  return { id: body.id, key: body.key };
}

/** A map body shaped like a real one: the index is section two of three, not the tail. */
const effortBody = [
  '## Notes',
  '',
  'This map carries execution.',
  '',
  '## Decisions so far',
  '',
  '- [An earlier ticket](https://example.test/1) — settled.',
  '',
  '## Out of scope',
  '',
  '- Not this.',
  ''
].join('\n');

/** Append a line to Decisions-so-far, which is where a resolving session puts one. */
function appended(body: string, line: string): string {
  const marker = '## Out of scope';
  const entry = `- [${line}](https://example.test/x) — done.\n\n`;
  const at = body.indexOf(marker);
  return at === -1 ? `${body}${entry}` : `${body.slice(0, at)}${entry}${body.slice(at)}`;
}

function createEffortViaApi(title: string): Promise<{ id: string; key: string }> {
  return createTaskViaApi(title, { kind: 'EFFORT', status: 'IN_PROGRESS', description: effortBody });
}

async function addBlocker(key: string, blockedBy: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${key}/dependencies`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.ownerEmail },
    payload: { blockedBy }
  });
  expect(response.statusCode).toBe(201);
}

async function claimViaApi(task: { key: string }): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${task.key}/claim`,
    headers: { 'x-workspace-slug': fixture.workspaceSlug, 'x-user-email': fixture.otherEmail },
    payload: {}
  });
  expect(response.statusCode).toBe(200);
}

async function createFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const ownerEmail = `cli-owner-${suffix}@example.test`;
  const otherEmail = `cli-other-${suffix}@example.test`;
  const otherName = 'Other claimant';
  const idleEmail = `dana-${suffix}@example.test`;
  const idleName = 'Dana Idle';
  const idlePhone = `+1555${suffix.replace(/\D/g, '').padEnd(6, '0').slice(0, 6)}`;
  // The idle address is a proper substring of both of these — one extends it at the front, one at
  // the back — so `q=dana-…` returns three rows and every loose comparison has something to get
  // wrong: `items[0]` and `endsWith` reach for the prefixed one, `startsWith` for the suffixed one.
  const prefixedEmail = `x${idleEmail}`;
  const suffixedEmail = `${idleEmail}.example`;
  const shoutedEmail = `CLI-Shouted-${suffix}@Example.Test`;
  const agentEmail = `cli-agent-${suffix}@example.test`;
  const outsiderEmail = `cli-outsider-${suffix}@example.test`;

  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'CLI owner' } });
  const other = await prisma.user.create({ data: { email: otherEmail, name: otherName } });
  const idle = await prisma.user.create({
    data: { email: idleEmail, name: idleName, phone: idlePhone }
  });
  const prefixed = await prisma.user.create({
    data: { email: prefixedEmail, name: 'Dana Prefixed' }
  });
  const suffixed = await prisma.user.create({
    data: { email: suffixedEmail, name: 'Dana Suffixed' }
  });
  // Written straight through Prisma, so the schema's `.toLowerCase()` never sees it — the shape a
  // row predating that rule would have. Resolution folds both sides or this one is unreachable.
  const shouted = await prisma.user.create({
    data: { email: shoutedEmail, name: 'Shouted Row' }
  });
  const agent = await prisma.user.create({
    data: { email: agentEmail, name: 'Claude', kind: 'AGENT', operatorId: owner.id }
  });
  // Never given a membership below: a real row this workspace cannot reach.
  await prisma.user.create({ data: { email: outsiderEmail, name: 'Outsider' } });
  const workspace = await prisma.workspace.create({
    data: { name: 'CLI workspace', slug: `cli-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: other.id, role: 'MEMBER' },
      { workspaceId: workspace.id, userId: shouted.id, role: 'MEMBER' },
      // An ordinary MEMBER role rather than WorkspaceRole.AGENT: #20 settled that nothing may infer
      // agent-ness from the role, so the roster must mark this row from `kind` alone.
      { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
    ]
  });

  // The three lookalikes are dated by hand rather than left to a shared `createMany` timestamp.
  // `GET /users` orders by role then `createdAt: 'desc'`, so this puts the wanted row **last** of
  // the three — and an earlier version of the exactness test passed against `items[0]` precisely
  // because a tie had put it first. A fixture that decides the answer proves nothing.
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: idle.id, role: 'MEMBER', createdAt: new Date(base) }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: prefixed.id, role: 'MEMBER', createdAt: new Date(base + 60_000) }
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: suffixed.id, role: 'MEMBER', createdAt: new Date(base + 120_000) }
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'CLI', keyPrefix: `CL${suffix.slice(0, 3).toUpperCase()}` }
  });

  // A real credential, minted through the route an operator uses, so the scope test exercises the
  // authentication path rather than a hand-built row.
  const issued = await app.inject({
    method: 'POST',
    url: '/agent-credentials',
    headers: { 'x-workspace-slug': workspace.slug, 'x-user-email': ownerEmail },
    payload: { userId: agent.id, name: 'CLI roster test' }
  });
  expect(issued.statusCode).toBe(201);

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerId: owner.id,
    ownerEmail,
    otherEmail,
    otherName,
    idleEmail,
    idleName,
    idlePhone,
    prefixedEmail,
    suffixedEmail,
    shoutedEmail,
    outsiderEmail,
    agentEmail,
    agentToken: (issued.json() as { token: string }).token,
    projectId: project.id,
    projectKeyPrefix: project.keyPrefix
  };
}
