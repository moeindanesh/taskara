import { prisma, type TaskAttachment } from '@taskara/db';
import type { RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { buildMediaUrl, uploadMediaToCdn, type MediaUploadInput } from './media';

export type TaskAttachmentResponse = TaskAttachment & { url: string };

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
  const attachment = await prisma.taskAttachment.create({
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
  const response = serializeTaskAttachment(attachment);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: commentId ? 'comment_attachment_added' : 'attachment_added',
    after: response,
    source: actor.source
  });

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
