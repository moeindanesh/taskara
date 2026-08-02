#!/usr/bin/env bun
/**
 * Two commands, split along the line #29 drew: minting a credential is an admin act, and using one
 * is not.
 *
 *   bun run agent:provision <workspace-slug> <operator-email>   # an admin runs this, once per person
 *   bun run agent:setup                                          # each person runs this, on their machine
 *
 * `setup` deliberately does not touch the database. A teammate should not need Postgres credentials,
 * a checkout of the API, or anything but the token they were handed and this repository.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_DIR = join(import.meta.dir, '..');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const VARS = ['TASKARA_API_URL', 'TASKARA_WORKSPACE_SLUG', 'TASKARA_AGENT_TOKEN', 'TASKARA_AGENT_RUNTIME'] as const;

const [command, ...rest] = process.argv.slice(2);
if (command === 'provision') await provision(rest);
else if (command === 'setup') await setup();
else {
  console.error('usage: setup.ts provision <workspace-slug> <operator-email>\n       setup.ts setup');
  process.exit(1);
}

/** Admin half: create the agent User, put it on its operator's teams, mint one credential. */
async function provision(args: string[]): Promise<void> {
  const [slug, operatorEmail] = args;
  if (!slug || !operatorEmail) {
    console.error('usage: bun run agent:provision <workspace-slug> <operator-email>');
    process.exit(1);
  }

  // Imported lazily so `setup` never needs a database, a schema or a generated client.
  const { prisma } = await import('@taskara/db');
  const { mintAgentCredentialToken } = await import('../../../apps/api/src/services/agent-credential');

  const workspace = await prisma.workspace.findUnique({ where: { slug } });
  if (!workspace) fail(`No workspace "${slug}".`);
  const operator = await prisma.user.findUnique({ where: { email: operatorEmail.toLowerCase() } });
  if (!operator) fail(`No user "${operatorEmail}".`);
  if (operator.kind !== 'HUMAN') fail(`${operatorEmail} is not a human; an agent cannot operate an agent.`);

  // One agent per operator, shared across every runtime (#20). Re-running provisions no second one.
  const agentEmail = `agent+${operator.id.slice(0, 8)}@${slug}.agent`;
  const agent = await prisma.user.upsert({
    where: { email: agentEmail },
    update: {},
    create: { email: agentEmail, name: `${operator.name} (agent)`, kind: 'AGENT', operatorId: operator.id }
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: agent.id } },
    update: {},
    create: { workspaceId: workspace.id, userId: agent.id, role: 'MEMBER' }
  });

  // The step that is easy to miss and looks like a broken token: projects are team-scoped, so an
  // agent on no team reads an empty workspace. Mirror whatever its operator can see.
  const operatorTeams = await prisma.teamMember.findMany({
    where: { userId: operator.id, team: { workspaceId: workspace.id } },
    select: { teamId: true }
  });
  for (const { teamId } of operatorTeams) {
    const existing = await prisma.teamMember.findFirst({ where: { teamId, userId: agent.id } });
    if (!existing) await prisma.teamMember.create({ data: { teamId, userId: agent.id } });
  }

  const minted = mintAgentCredentialToken();
  await prisma.agentCredential.create({
    data: {
      workspaceId: workspace.id,
      userId: agent.id,
      name: `${operator.name} — ${new Date().toISOString().slice(0, 10)}`,
      lookupId: minted.lookupId,
      tokenHash: minted.tokenHash,
      scope: 'READ_WRITE'
    }
  });
  await prisma.$disconnect();

  console.log(`
Agent ready for ${operator.name}: ${agent.email}
  teams mirrored: ${operatorTeams.length || 'none — it will see only teamless projects'}

Send these to them privately. The token is shown once and cannot be recovered:

  TASKARA_API_URL=${process.env.TASKARA_API_URL || 'http://localhost:4002'}
  TASKARA_WORKSPACE_SLUG=${slug}
  TASKARA_AGENT_TOKEN=${minted.token}

They run:  bun run agent:setup
`);
}

/** Everyone's half: put the CLI on PATH, teach Claude Code the env, prove it works. */
async function setup(): Promise<void> {
  const values = {
    TASKARA_API_URL: (await ask('API URL', process.env.TASKARA_API_URL || 'http://localhost:4002')).trim(),
    TASKARA_WORKSPACE_SLUG: (await ask('Workspace slug', process.env.TASKARA_WORKSPACE_SLUG)).trim(),
    TASKARA_AGENT_TOKEN: (await ask('Agent token', process.env.TASKARA_AGENT_TOKEN)).trim(),
    TASKARA_AGENT_RUNTIME: 'CLAUDE_CODE'
  };
  for (const key of VARS) if (!values[key]) fail(`${key} is required.`);

  // 1. `taskara` on PATH. A real file, not a shell alias: skills paste commands into a
  //    non-interactive shell, where an alias from an interactive profile does not exist.
  const linked = spawnSync('bun', ['link'], { cwd: PLUGIN_DIR, encoding: 'utf8' });
  if (linked.status !== 0) fail(`bun link failed:\n${linked.stderr}`);
  console.log('✓ taskara linked onto $PATH');

  // 2. Claude Code's env, so every Bash call a skill makes already has the credential. Merged into
  //    whatever is there, with a backup, because this file is the user's and mostly not ours.
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, `${SETTINGS}.bak`);
  settings.env = { ...(settings.env ?? {}), ...values };
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`✓ credentials written to ${SETTINGS}${existsSync(`${SETTINGS}.bak`) ? ' (backup: .bak)' : ''}`);

  // 3. Prove it, rather than declaring success. An empty project list is the failure that looks
  //    like a bad token and is not one.
  const probe = spawnSync('bun', [join(PLUGIN_DIR, 'src', 'cli.ts'), 'project', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, ...values }
  });
  if (probe.status !== 0) fail(`taskara could not reach Taskara (exit ${probe.status}):\n${probe.stderr.trim()}`);

  const projects = (JSON.parse(probe.stdout).projects ?? []) as Array<{ keyPrefix: string }>;
  if (!projects.length) {
    console.log(`
⚠  Connected, but this agent sees no projects.

   That is almost never a bad token — projects are team-scoped, and an agent that is a workspace
   member but on no team reads an empty workspace. Ask whoever provisioned it to add the agent to
   your team, then run this again.
`);
    return;
  }

  console.log(`✓ ${projects.length} project(s) visible: ${projects.map((p) => p.keyPrefix).join(', ')}

Done. Restart Claude Code so it picks up the env, then try:

  taskara task list --assignee me
`);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function ask(label: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  process.stdout.write(`${label}: `);
  for await (const line of console) return line;
  return '';
}
