import type { FastifyInstance } from 'fastify';
import { prisma } from '@taskara/db';
import { normalizeTaskStatus } from '@taskara/shared';
import { config } from '../config';
import { ensureWorkspaceMember, getMattermostActor, upsertUserByEmail } from '../services/actor';
import { parseHumanDueDate } from '../services/dates';
import { createTask, ensureDefaultProject, findTaskByIdOrKey, updateTask } from '../services/tasks';

type MattermostResponseType = 'ephemeral' | 'in_channel';

interface MattermostCommandBody {
  token?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  team_domain?: string;
  team_id?: string;
  workspace_slug?: string;
  channel_id?: string;
  channel_name?: string;
}

function mm(text: string, responseType: MattermostResponseType = 'ephemeral') {
  return { response_type: responseType, text };
}

export async function registerMattermostRoutes(app: FastifyInstance): Promise<void> {
  app.post('/integrations/mattermost/command', async (request, reply) => {
    const body = request.body as MattermostCommandBody;
    if (config.MATTERMOST_SLASH_TOKEN && body.token !== config.MATTERMOST_SLASH_TOKEN) {
      return reply.code(401).send(mm('Invalid Mattermost token.'));
    }

    const actor = await getMattermostActor(body);
    const text = (body.text || '').trim();
    const [command = 'help', ...restParts] = text.split(/\s+/);
    const rest = restParts.join(' ').trim();

    if (!text || command === 'help') {
      return mm([
        '**Taskara commands**',
        '`/task create Fix checkout bug`',
        '`/task list mine`',
        '`/task status CORE-123 in-review`',
        '`/task assign CORE-123 @sara`',
        '`/task due CORE-123 فردا`',
        '`/task bind CORE`'
      ].join('\n'));
    }

    if (command === 'bind') {
      const projectToken = restParts[0]?.toUpperCase();
      if (!projectToken || !body.channel_id) return mm('Usage: `/task bind PROJECTKEY` inside a channel.');
      const project = await prisma.project.findFirst({
        where: {
          workspaceId: actor.workspace.id,
          OR: [{ keyPrefix: projectToken }, { id: restParts[0] }]
        }
      });
      if (!project) return mm(`Project ${projectToken} was not found.`);

      await prisma.mattermostBinding.upsert({
        where: { workspaceId_channelId: { workspaceId: actor.workspace.id, channelId: body.channel_id } },
        update: { projectId: project.id, channelName: body.channel_name },
        create: {
          workspaceId: actor.workspace.id,
          channelId: body.channel_id,
          channelName: body.channel_name,
          projectId: project.id
        }
      });
      return mm(`This channel now creates tasks in **${project.name}** (${project.keyPrefix}).`, 'in_channel');
    }

    if (command === 'create') {
      if (!rest) return mm('Usage: `/task create Task title`');
      const project = await getProjectForChannel(actor.workspace.id, body.channel_id);
      const task = await createTask(actor, {
        projectId: project.id,
        title: rest,
        labels: [],
        status: 'TODO',
        priority: 'NO_PRIORITY',
        weight: null,
        source: 'MATTERMOST'
      });
      return mm(`Created **${task.key}**: ${task.title}`, 'in_channel');
    }

    if (command === 'list') {
      const scope = restParts[0] || 'mine';
      if (scope !== 'mine') return mm('Only `/task list mine` is implemented in this MVP.');
      const tasks = await prisma.task.findMany({
        where: {
          workspaceId: actor.workspace.id,
          assigneeId: actor.user.id,
          status: { notIn: ['DONE', 'CANCELED'] }
        },
        orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
        take: 10
      });
      if (tasks.length === 0) return mm('No open tasks assigned to you.');
      return mm(tasks.map((task) => `- **${task.key}** [${task.status}] ${task.title}`).join('\n'));
    }

    if (command === 'status') {
      const [key, statusInput] = restParts;
      const status = statusInput ? normalizeTaskStatus(statusInput) : null;
      if (!key || !status) return mm('Usage: `/task status CORE-123 in-review`');
      const task = await findTaskByIdOrKey(actor.workspace.id, key);
      if (!task) return mm(`Task ${key} was not found.`);
      const updated = await updateTask(actor, task.id, { status });
      return mm(`Updated **${updated.key}** to **${updated.status}**.`, 'in_channel');
    }

    if (command === 'assign') {
      const [key, handle] = restParts;
      if (!key || !handle) return mm('Usage: `/task assign CORE-123 @sara`');
      const task = await findTaskByIdOrKey(actor.workspace.id, key);
      if (!task) return mm(`Task ${key} was not found.`);
      const assignee = await ensureMattermostUser(actor.workspace.id, handle);
      const updated = await updateTask(actor, task.id, { assigneeId: assignee.id });
      return mm(`Assigned **${updated.key}** to @${assignee.mattermostUsername || assignee.name}.`, 'in_channel');
    }

    if (command === 'due') {
      const [key, ...dateParts] = restParts;
      const dueInput = dateParts.join(' ');
      if (!key || !dueInput) return mm('Usage: `/task due CORE-123 فردا`');
      const dueAt = parseHumanDueDate(dueInput);
      if (!dueAt) return mm('Could not parse due date. Try `today`, `tomorrow`, `فردا`, or an ISO date.');
      const task = await findTaskByIdOrKey(actor.workspace.id, key);
      if (!task) return mm(`Task ${key} was not found.`);
      const updated = await updateTask(actor, task.id, { dueAt: dueAt.toISOString() });
      return mm(`Set due date for **${updated.key}**.`, 'in_channel');
    }

    return mm(`Unknown command: ${command}. Try \`/task help\`.`);
  });
}

async function getProjectForChannel(workspaceId: string, channelId?: string) {
  if (channelId) {
    const binding = await prisma.mattermostBinding.findUnique({
      where: { workspaceId_channelId: { workspaceId, channelId } },
      include: { project: true }
    });
    if (binding) return binding.project;
  }
  return ensureDefaultProject(workspaceId);
}

async function ensureMattermostUser(workspaceId: string, rawHandle: string) {
  const username = rawHandle.replace(/^@/, '').trim();
  const email = `${username}@${config.MATTERMOST_SYNTHETIC_EMAIL_DOMAIN}`;
  const existing = await prisma.user.findFirst({
    where: { OR: [{ mattermostUsername: username }, { email }] }
  });

  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { mattermostUsername: username, name: username } })
    : await upsertUserByEmail(email, username);

  if (!user.mattermostUsername) {
    await prisma.user.update({ where: { id: user.id }, data: { mattermostUsername: username } });
  }
  await ensureWorkspaceMember(workspaceId, user.id);
  return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
}
