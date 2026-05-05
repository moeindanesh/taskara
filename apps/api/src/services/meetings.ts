import { prisma, type Prisma } from '@taskara/db';
import type { z } from 'zod';
import type { createMeetingSchema, createMeetingTasksSchema, updateMeetingSchema } from '@taskara/shared';
import { config } from '../config';
import type { RequestActor } from './actor';
import { isWorkspaceAdminRole } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { MEETING_ASSIGNED_NOTIFICATION_TYPE, meetingAssignedNotificationBody } from './notifications';
import { sendMessageSimple } from './sms';
import { createTask, serializeTaskForResponse, taskInclude } from './tasks';

type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
type CreateMeetingTasksInput = z.infer<typeof createMeetingTasksSchema>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export const meetingInclude = {
  team: { select: { id: true, name: true, slug: true } },
  project: { select: { id: true, name: true, keyPrefix: true, teamId: true } },
  owner: { select: userSelect },
  createdBy: { select: userSelect },
  participants: {
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: { user: { select: userSelect } }
  },
  tasks: {
    orderBy: { createdAt: 'desc' },
    include: { task: { include: taskInclude } }
  },
  _count: { select: { participants: true, tasks: true } }
} satisfies Prisma.MeetingInclude;

type MeetingWithAccess = {
  ownerId?: string | null;
  createdById?: string | null;
  participants?: Array<{ userId: string }>;
};

export function canAccessMeeting(actor: RequestActor, meeting: MeetingWithAccess): boolean {
  return (
    isWorkspaceAdminRole(actor.role) ||
    meeting.ownerId === actor.user.id ||
    meeting.createdById === actor.user.id ||
    Boolean(meeting.participants?.some((participant) => participant.userId === actor.user.id))
  );
}

export async function createMeeting(actor: RequestActor, input: CreateMeetingInput) {
  let notificationRecipientIds: string[] = [];
  const meeting = await prisma.$transaction(async (tx) => {
    await assertMeetingRelations(tx, actor, input);
    const ownerId = input.ownerId || actor.user.id;
    const participantUsers = await assertWorkspaceUsers(tx, actor.workspace.id, [
      actor.user.id,
      ownerId,
      ...(input.participantIds || [])
    ]);
    const participantIds = participantUsers.map((user) => user.id);

    const created = await tx.meeting.create({
      data: {
        workspaceId: actor.workspace.id,
        teamId: input.teamId,
        projectId: input.projectId,
        ownerId,
        createdById: actor.user.id,
        title: input.title,
        description: input.description,
        status: input.status,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
        heldAt: input.heldAt ? new Date(input.heldAt) : input.status === 'HELD' ? new Date() : undefined
      }
    });

    await syncMeetingParticipants(tx, actor.workspace.id, created.id, participantIds, ownerId);
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id: created.id }, include: meetingInclude });
    notificationRecipientIds = await createMeetingNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      meetingId: meeting.id,
      title: meeting.title,
      userIds: participantIds
    });

    return meeting;
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'meeting',
    entityId: meeting.id,
    action: 'created',
    after: { meeting, notificationRecipientIds },
    source: actor.source
  }).catch(() => undefined);

  return meeting;
}

export async function updateMeeting(actor: RequestActor, meetingId: string, input: UpdateMeetingInput) {
  let notificationRecipientIds: string[] = [];
  const existing = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: actor.workspace.id },
    include: meetingInclude
  });
  if (!existing) throw new HttpError(404, 'Meeting not found');
  if (!canAccessMeeting(actor, existing)) throw new HttpError(403, 'Meeting access denied');

  const meeting = await prisma.$transaction(async (tx) => {
    await assertMeetingRelations(tx, actor, input);
    const ownerId = input.ownerId === undefined ? existing.ownerId : input.ownerId;
    const currentParticipantIds = existing.participants.map((participant) => participant.userId);
    const requestedParticipantIds = input.participantIds
      ? [actor.user.id, ...(ownerId ? [ownerId] : []), ...input.participantIds]
      : [...currentParticipantIds, ...(ownerId ? [ownerId] : [])];
    const participantUsers = await assertWorkspaceUsers(tx, actor.workspace.id, requestedParticipantIds);
    const participantIds = participantUsers.map((user) => user.id);

    const updated = await tx.meeting.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        teamId: input.teamId === undefined ? undefined : input.teamId,
        projectId: input.projectId === undefined ? undefined : input.projectId,
        ownerId: input.ownerId === undefined ? undefined : input.ownerId,
        status: input.status,
        scheduledAt: input.scheduledAt === undefined ? undefined : input.scheduledAt ? new Date(input.scheduledAt) : null,
        heldAt:
          input.heldAt === undefined
            ? input.status === 'HELD' && !existing.heldAt
              ? new Date()
              : undefined
            : input.heldAt
              ? new Date(input.heldAt)
              : null
      }
    });

    await syncMeetingParticipants(tx, actor.workspace.id, updated.id, participantIds, ownerId);
    const meeting = await tx.meeting.findUniqueOrThrow({ where: { id: updated.id }, include: meetingInclude });
    notificationRecipientIds = await createMeetingNotifications(tx, {
      workspaceId: actor.workspace.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      meetingId: meeting.id,
      title: meeting.title,
      userIds: participantIds
    });

    return meeting;
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'meeting',
    entityId: meeting.id,
    action: 'updated',
    before: existing,
    after: { meeting, notificationRecipientIds },
    source: actor.source
  }).catch(() => undefined);

  return meeting;
}

export async function createTasksFromMeeting(actor: RequestActor, meetingId: string, input: CreateMeetingTasksInput) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: actor.workspace.id },
    include: meetingInclude
  });
  if (!meeting) throw new HttpError(404, 'Meeting not found');
  if (!canAccessMeeting(actor, meeting)) throw new HttpError(403, 'Meeting access denied');

  const tasks = [];
  for (const item of input.tasks) {
    const task = await createTask(actor, {
      projectId: input.projectId,
      title: item.title,
      description: item.description,
      assigneeId: item.assigneeId,
      status: item.status,
      priority: item.priority,
      dueAt: item.dueAt,
      labels: item.labels,
      source: 'WEB'
    });
    await prisma.meetingTask.create({
      data: {
        meetingId: meeting.id,
        taskId: task.id,
        createdById: actor.user.id
      }
    });
    tasks.push(serializeTaskForResponse(task));
  }

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'meeting',
    entityId: meeting.id,
    action: 'tasks_created',
    after: { taskIds: tasks.map((task) => task.id) },
    source: actor.source
  }).catch(() => undefined);

  return { items: tasks, total: tasks.length };
}

export async function sendMeetingSms(actor: RequestActor, meetingId: string) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: actor.workspace.id },
    include: meetingInclude
  });
  if (!meeting) throw new HttpError(404, 'Meeting not found');
  if (!canAccessMeeting(actor, meeting)) throw new HttpError(403, 'Meeting access denied');
  if (!config.SMS_KAVEH_SENDER) throw new HttpError(503, 'SMS_KAVEH_SENDER is required to send meeting SMS');

  const summary = { sent: 0, skippedNoPhone: 0, failed: 0 };
  for (const participant of meeting.participants) {
    const user = participant.user;
    if (!user.phone) {
      summary.skippedNoPhone += 1;
      await logSmsDelivery(actor, meeting.id, user.id, 'meeting', 'SKIPPED', null, 'User has no phone number');
      continue;
    }

    try {
      await sendMessageSimple(user.phone, buildMeetingSmsMessage(actor, meeting.id, meeting.title, user.name), config.SMS_KAVEH_SENDER);
      summary.sent += 1;
      await logSmsDelivery(actor, meeting.id, user.id, 'meeting', 'SENT', user.phone);
    } catch (error) {
      summary.failed += 1;
      await logSmsDelivery(
        actor,
        meeting.id,
        user.id,
        'meeting',
        'FAILED',
        user.phone,
        error instanceof Error ? error.message : 'SMS sending failed'
      );
    }
  }

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'meeting',
    entityId: meeting.id,
    action: 'sms_meeting_sent',
    after: summary,
    source: actor.source
  }).catch(() => undefined);

  return summary;
}

async function createMeetingNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    actorName: string;
    meetingId: string;
    title: string;
    userIds: string[];
  }
): Promise<string[]> {
  const userIds = [...new Set(input.userIds)].filter((userId) => userId !== input.actorUserId);
  if (!userIds.length) return [];

  const existingNotifications = await tx.notification.findMany({
    where: {
      workspaceId: input.workspaceId,
      meetingId: input.meetingId,
      userId: { in: userIds },
      type: MEETING_ASSIGNED_NOTIFICATION_TYPE
    },
    select: { userId: true }
  });
  const existingUserIds = new Set(existingNotifications.map((notification) => notification.userId));
  const missingUserIds = userIds.filter((userId) => !existingUserIds.has(userId));
  if (!missingUserIds.length) return [];

  await tx.notification.createMany({
    data: missingUserIds.map((userId) => ({
      workspaceId: input.workspaceId,
      userId,
      meetingId: input.meetingId,
      type: MEETING_ASSIGNED_NOTIFICATION_TYPE,
      title: input.title,
      body: meetingAssignedNotificationBody(input.actorName)
    }))
  });

  return missingUserIds;
}

async function syncMeetingParticipants(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  meetingId: string,
  userIds: string[],
  ownerId?: string | null
): Promise<void> {
  const nextUserIds = [...new Set(userIds)];
  await tx.meetingParticipant.deleteMany({
    where: {
      workspaceId,
      meetingId,
      userId: { notIn: nextUserIds }
    }
  });
  await tx.meetingParticipant.createMany({
    data: nextUserIds.map((userId) => ({
      workspaceId,
      meetingId,
      userId,
      role: userId === ownerId ? 'OWNER' : 'PARTICIPANT'
    })),
    skipDuplicates: true
  });
  await tx.meetingParticipant.updateMany({
    where: { workspaceId, meetingId, userId: { in: nextUserIds } },
    data: { role: 'PARTICIPANT' }
  });
  if (ownerId && nextUserIds.includes(ownerId)) {
    await tx.meetingParticipant.updateMany({
      where: { workspaceId, meetingId, userId: ownerId },
      data: { role: 'OWNER' }
    });
  }
}

async function assertMeetingRelations(
  tx: Prisma.TransactionClient,
  actor: RequestActor,
  input: {
    teamId?: string | null;
    projectId?: string | null;
    ownerId?: string | null;
    participantIds?: string[];
  }
): Promise<void> {
  const [team, project, owner] = await Promise.all([
    input.teamId
      ? tx.team.findFirst({ where: { id: input.teamId, workspaceId: actor.workspace.id }, select: { id: true } })
      : Promise.resolve(null),
    input.projectId
      ? tx.project.findFirst({
          where: { id: input.projectId, workspaceId: actor.workspace.id },
          select: { id: true, teamId: true }
        })
      : Promise.resolve(null),
    input.ownerId
      ? tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: actor.workspace.id, userId: input.ownerId } },
          select: { id: true }
        })
      : Promise.resolve(null)
  ]);

  if (input.teamId && !team) throw new HttpError(400, 'Team not found in this workspace');
  if (input.projectId && !project) throw new HttpError(400, 'Project not found in this workspace');
  if (input.ownerId && !owner) throw new HttpError(400, 'Meeting owner must belong to this workspace');

  if (!isWorkspaceAdminRole(actor.role)) {
    const teamId = input.teamId || project?.teamId;
    if (teamId) {
      const membership = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: actor.user.id } },
        select: { id: true }
      });
      if (!membership) throw new HttpError(403, 'Team access denied');
    }
  }
}

async function assertWorkspaceUsers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userIds: string[]
): Promise<Array<{ id: string; name: string; email: string; phone: string | null; avatarUrl: string | null }>> {
  const requestedUserIds = [...new Set(userIds.filter(Boolean))];
  const members = await tx.workspaceMember.findMany({
    where: { workspaceId, userId: { in: requestedUserIds } },
    include: { user: { select: userSelect } }
  });
  if (members.length !== requestedUserIds.length) {
    throw new HttpError(400, 'All meeting participants must belong to this workspace');
  }
  return members.map((member) => member.user);
}

function buildMeetingSmsMessage(actor: RequestActor, meetingId: string, title: string, participantName: string): string {
  const url = `${config.WEB_ORIGIN.replace(/\/$/, '')}/${encodeURIComponent(actor.workspace.slug)}/meetings/${encodeURIComponent(meetingId)}`;
  return [
    `${smsDisplayName(participantName)}، در تسکارا جلسه‌ای برات تنظیم شد.`,
    `موضوع: ${title}`,
    `فرستنده: ${actor.user.name}`,
    url
  ].join('\n');
}

async function logSmsDelivery(
  actor: RequestActor,
  entityId: string,
  userId: string,
  kind: string,
  status: 'SENT' | 'FAILED' | 'SKIPPED',
  phone?: string | null,
  error?: string
) {
  await prisma.smsDelivery.create({
    data: {
      workspaceId: actor.workspace.id,
      requestedById: actor.user.id,
      entityType: 'meeting',
      entityId,
      userId,
      kind,
      status,
      receptor: phone ? maskPhone(phone) : null,
      error,
      providerEndpoint: status === 'SKIPPED' ? undefined : 'sms/send.json'
    }
  }).catch(() => undefined);
}

function smsDisplayName(name: string): string {
  return name.trim() || 'همکار';
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
}
