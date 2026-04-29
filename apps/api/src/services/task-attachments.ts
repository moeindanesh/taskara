import { prisma, type Prisma, type SyncEvent, type TaskAttachment } from '@taskara/db';
import type { RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { buildMediaUrl, uploadMediaToCdn, type MediaUploadInput } from './media';
import { appendSyncEvent, publishSyncEvent } from './sync';

export type TaskAttachmentResponse = TaskAttachment & { url: string };

const taskAttachmentSyncInclude = {
  project: {
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      parentId: true,
      team: { select: { id: true, name: true, slug: true } }
    }
  },
  assignee: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  reporter: { select: { id: true, name: true, email: true, phone: true, mattermostUsername: true, avatarUrl: true } },
  attachments: { where: { commentId: null }, orderBy: { createdAt: 'asc' } },
  labels: { include: { label: true } },
  _count: { select: { comments: true, subtasks: true, blockingDependencies: true, attachments: true } }
} satisfies Prisma.TaskInclude;

export function serializeTaskAttachment(attachment: TaskAttachment): TaskAttachmentResponse {
  return {
    ...attachment,
    url: buildMediaUrl(attachment.object)
  };
}

export async function listTaskAttachments(actor: RequestActor, taskId: string): Promise<TaskAttachmentResponse[]> {
  await ensureTaskInWorkspace(actor.workspace.id, taskId);
  const attachments = await prisma.taskAttachment.findMany({
    where: { taskId, commentId: null },
    orderBy: { createdAt: 'asc' }
  });
  return attachments.map(serializeTaskAttachment);
}

export async function createTaskAttachment(
  actor: RequestActor,
  taskId: string,
  upload: MediaUploadInput,
  commentId?: string
): Promise<TaskAttachmentResponse> {
  const task = await ensureTaskInWorkspace(actor.workspace.id, taskId);
  if (commentId) await ensureCommentForTask(taskId, commentId);

  const media = await uploadMediaToCdn(upload);
  let syncEvent: SyncEvent | null = null;
  const attachment = await prisma.$transaction(async (tx) => {
    const attachment = await tx.taskAttachment.create({
      data: {
        taskId,
        commentId,
        name: media.name,
        documentId: media.documentId,
        object: media.object,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes
      }
    });
    const updatedTask = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: taskAttachmentSyncInclude });
    const response = serializeTaskAttachment(attachment);
    syncEvent = await appendSyncEvent(tx, {
      workspaceId: actor.workspace.id,
      entityType: 'task',
      entityId: taskId,
      operation: commentId ? 'comment_attachment_added' : 'attachment_added',
      entityVersion: updatedTask.version,
      actorId: actor.user.id,
      payload: {
        attachment: response,
        after: serializeTaskSnapshot(updatedTask),
        changedFields: commentId ? ['comments', 'attachments'] : ['attachments']
      }
    });
    return attachment;
  });
  const response = serializeTaskAttachment(attachment);
  if (syncEvent) publishSyncEvent(syncEvent);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: commentId ? 'comment_attachment_added' : 'attachment_added',
    after: response,
    source: actor.source
  }).catch(() => undefined);

  return response;
}

async function ensureTaskInWorkspace(workspaceId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { id: true }
  });
  if (!task) throw new HttpError(404, 'Task not found in this workspace');
  return task;
}

async function ensureCommentForTask(taskId: string, commentId: string) {
  const comment = await prisma.taskComment.findFirst({
    where: { id: commentId, taskId },
    select: { id: true }
  });
  if (!comment) throw new HttpError(404, 'Comment not found for this task');
  return comment;
}

function serializeTaskSnapshot<T extends Record<string, unknown>>(task: T): T {
  const taskRecord = task as Record<string, unknown>;
  if (!Array.isArray(taskRecord.attachments)) return task;
  return {
    ...taskRecord,
    attachments: taskRecord.attachments.map((attachment) =>
      serializeTaskAttachment(attachment as Parameters<typeof serializeTaskAttachment>[0])
    )
  } as unknown as T;
}
