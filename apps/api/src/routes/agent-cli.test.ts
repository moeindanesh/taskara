import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { prisma } from '@taskara/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app';

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
  ownerEmail: string;
  otherEmail: string;
  otherName: string;
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
    await prisma.user.deleteMany({ where: { email: { in: [fixture.ownerEmail, fixture.otherEmail] } } });
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

async function run(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  stdin?: string
): Promise<CliRun> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
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
  const owner = await prisma.user.create({ data: { email: ownerEmail, name: 'CLI owner' } });
  const other = await prisma.user.create({ data: { email: otherEmail, name: otherName } });
  const workspace = await prisma.workspace.create({
    data: { name: 'CLI workspace', slug: `cli-${suffix}` }
  });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
      { workspaceId: workspace.id, userId: other.id, role: 'MEMBER' }
    ]
  });
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'CLI', keyPrefix: `CL${suffix.slice(0, 3).toUpperCase()}` }
  });

  return {
    workspaceSlug: workspace.slug,
    workspaceId: workspace.id,
    ownerEmail,
    otherEmail,
    otherName,
    projectId: project.id,
    projectKeyPrefix: project.keyPrefix
  };
}
