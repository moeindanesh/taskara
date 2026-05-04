import { prisma, type Prisma } from '@taskara/db';
import type { z } from 'zod';
import type { createAnnouncementSchema, updateAnnouncementSchema } from '@taskara/shared';
import { config } from '../config';
import type { RequestActor } from './actor';
import { isWorkspaceAdminRole } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import {
  ANNOUNCEMENT_PUBLISHED_NOTIFICATION_TYPE,
  announcementPublishedNotificationBody
} from './notifications';
import { sendMessageSimple } from './sms';

type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatarUrl: true
} satisfies Prisma.UserSelect;

export const announcementInclude = {
  creator: { select: userSelect },
  recipients: {
    orderBy: { createdAt: 'asc' },
    include: { user: { select: userSelect } }
  },
  _count: { select: { recipients: true } }
} satisfies Prisma.AnnouncementInclude;

export function canManageAnnouncement(actor: RequestActor, creatorId?: string | null): boolean {
  return isWorkspaceAdminRole(actor.role) || creatorId === actor.user.id;
}

export async function createAnnouncement(actor: RequestActor, input: CreateAnnouncementInput) {
  let notificationRecipientIds: string[] = [];
  const announcement = await prisma.$transaction(async (tx) => {
    const recipientUsers = await assertWorkspaceUsers(tx, actor.workspace.id, input.recipientIds);
    if (input.publish && recipientUsers.length === 0) {
      throw new HttpError(400, 'Published announcements require at least one recipient');
    }
    const now = new Date();
    const created = await tx.announcement.create({
      data: {
        workspaceId: actor.workspace.id,
        creatorId: actor.user.id,
        title: input.title,
        body: input.body,
        status: input.publish ? 'PUBLISHED' : 'DRAFT',
        publishedAt: input.publish ? now : undefined
      }
    });

    if (recipientUsers.length) {
      await tx.announcementRecipient.createMany({
        data: recipientUsers.map((user) => ({
          workspaceId: actor.workspace.id,
          announcementId: created.id,
          userId: user.id
        })),
        skipDuplicates: true
      });
    }

    const announcement = await tx.announcement.findUniqueOrThrow({
      where: { id: created.id },
      include: announcementInclude
    });

    if (announcement.status === 'PUBLISHED') {
      notificationRecipientIds = await createAnnouncementNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorName: actor.user.name,
        announcementId: announcement.id,
        title: announcement.title,
        userIds: recipientUsers.map((user) => user.id)
      });
    }

    return announcement;
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'announcement',
    entityId: announcement.id,
    action: announcement.status === 'PUBLISHED' ? 'published' : 'created',
    after: { announcement, notificationRecipientIds },
    source: actor.source
  }).catch(() => undefined);

  return announcement;
}

export async function updateAnnouncement(actor: RequestActor, announcementId: string, input: UpdateAnnouncementInput) {
  let notificationRecipientIds: string[] = [];
  const existing = await prisma.announcement.findFirst({
    where: { id: announcementId, workspaceId: actor.workspace.id },
    include: announcementInclude
  });
  if (!existing) throw new HttpError(404, 'Announcement not found');
  if (!canManageAnnouncement(actor, existing.creatorId)) throw new HttpError(403, 'Announcement access denied');

  const announcement = await prisma.$transaction(async (tx) => {
    const recipientUsers = input.recipientIds
      ? await assertWorkspaceUsers(tx, actor.workspace.id, input.recipientIds)
      : existing.recipients.map((recipient) => recipient.user);
    const publishingNow = input.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';
    const nextStatus = input.status || existing.status;
    if (nextStatus === 'PUBLISHED' && recipientUsers.length === 0) {
      throw new HttpError(400, 'Published announcements require at least one recipient');
    }

    const updated = await tx.announcement.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        body: input.body === undefined ? undefined : input.body,
        status: input.status,
        publishedAt: publishingNow ? new Date() : undefined
      }
    });

    if (input.recipientIds) {
      await syncAnnouncementRecipients(tx, actor.workspace.id, updated.id, recipientUsers.map((user) => user.id));
    }

    const announcement = await tx.announcement.findUniqueOrThrow({
      where: { id: updated.id },
      include: announcementInclude
    });

    if (announcement.status === 'PUBLISHED') {
      notificationRecipientIds = await createAnnouncementNotifications(tx, {
        workspaceId: actor.workspace.id,
        actorName: actor.user.name,
        announcementId: announcement.id,
        title: announcement.title,
        userIds: recipientUsers.map((user) => user.id)
      });
    }

    return announcement;
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'announcement',
    entityId: announcement.id,
    action: 'updated',
    before: existing,
    after: { announcement, notificationRecipientIds },
    source: actor.source
  }).catch(() => undefined);

  return announcement;
}

export async function publishAnnouncement(actor: RequestActor, announcementId: string) {
  return updateAnnouncement(actor, announcementId, { status: 'PUBLISHED' });
}

export async function markAnnouncementRead(actor: RequestActor, announcementId: string) {
  const readAt = new Date();
  const result = await prisma.announcementRecipient.updateMany({
    where: {
      workspaceId: actor.workspace.id,
      announcementId,
      userId: actor.user.id,
      readAt: null
    },
    data: { readAt }
  });

  if (result.count === 0) {
    const recipient = await prisma.announcementRecipient.findFirst({
      where: { workspaceId: actor.workspace.id, announcementId, userId: actor.user.id }
    });
    if (!recipient) throw new HttpError(404, 'Announcement not found');
  }

  await prisma.notification.updateMany({
    where: {
      workspaceId: actor.workspace.id,
      userId: actor.user.id,
      announcementId,
      readAt: null
    },
    data: { readAt }
  });

  return prisma.announcement.findFirstOrThrow({
    where: { id: announcementId, workspaceId: actor.workspace.id },
    include: announcementInclude
  });
}

export async function sendAnnouncementSms(actor: RequestActor, announcementId: string) {
  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, workspaceId: actor.workspace.id },
    include: announcementInclude
  });
  if (!announcement) throw new HttpError(404, 'Announcement not found');
  if (!canManageAnnouncement(actor, announcement.creatorId)) throw new HttpError(403, 'Announcement access denied');
  if (!config.SMS_KAVEH_SENDER) throw new HttpError(503, 'SMS_KAVEH_SENDER is required to send announcement SMS');

  const summary = { sent: 0, skippedNoPhone: 0, failed: 0 };
  for (const recipient of announcement.recipients) {
    const user = recipient.user;
    if (!user.phone) {
      summary.skippedNoPhone += 1;
      await logSmsDelivery(actor, announcement.id, user.id, 'announcement', 'SKIPPED', null, 'User has no phone number');
      continue;
    }

    try {
      await sendMessageSimple(user.phone, buildAnnouncementSmsMessage(actor, announcement.id, announcement.title, user.name), config.SMS_KAVEH_SENDER);
      summary.sent += 1;
      await logSmsDelivery(actor, announcement.id, user.id, 'announcement', 'SENT', user.phone);
    } catch (error) {
      summary.failed += 1;
      await logSmsDelivery(
        actor,
        announcement.id,
        user.id,
        'announcement',
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
    entityType: 'announcement',
    entityId: announcement.id,
    action: 'sms_announcement_sent',
    after: summary,
    source: actor.source
  }).catch(() => undefined);

  return summary;
}

async function createAnnouncementNotifications(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorName: string;
    announcementId: string;
    title: string;
    userIds: string[];
  }
): Promise<string[]> {
  const userIds = [...new Set(input.userIds)];
  if (!userIds.length) return [];

  const existingNotifications = await tx.notification.findMany({
    where: {
      workspaceId: input.workspaceId,
      announcementId: input.announcementId,
      userId: { in: userIds },
      type: ANNOUNCEMENT_PUBLISHED_NOTIFICATION_TYPE
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
      announcementId: input.announcementId,
      type: ANNOUNCEMENT_PUBLISHED_NOTIFICATION_TYPE,
      title: input.title,
      body: announcementPublishedNotificationBody(input.actorName)
    }))
  });

  return missingUserIds;
}

async function syncAnnouncementRecipients(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  announcementId: string,
  userIds: string[]
): Promise<void> {
  const nextUserIds = [...new Set(userIds)];
  await tx.announcementRecipient.deleteMany({
    where: {
      workspaceId,
      announcementId,
      userId: { notIn: nextUserIds }
    }
  });
  await tx.announcementRecipient.createMany({
    data: nextUserIds.map((userId) => ({ workspaceId, announcementId, userId })),
    skipDuplicates: true
  });
}

async function assertWorkspaceUsers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userIds: string[]
): Promise<Array<{ id: string; name: string; email: string; phone: string | null; avatarUrl: string | null }>> {
  const requestedUserIds = [...new Set(userIds)];
  const members = await tx.workspaceMember.findMany({
    where: { workspaceId, userId: { in: requestedUserIds } },
    include: { user: { select: userSelect } }
  });
  if (members.length !== requestedUserIds.length) {
    throw new HttpError(400, 'All recipients must belong to this workspace');
  }
  return members.map((member) => member.user);
}

function buildAnnouncementSmsMessage(
  actor: RequestActor,
  announcementId: string,
  title: string,
  recipientName: string
): string {
  const url = `${config.WEB_ORIGIN.replace(/\/$/, '')}/${encodeURIComponent(actor.workspace.slug)}/announcements/${encodeURIComponent(announcementId)}`;
  return [
    `${smsDisplayName(recipientName)}، در تسکارا اطلاعیه جدید منتشر شد.`,
    `عنوان: ${title}`,
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
      entityType: 'announcement',
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
