import { prisma, type TaskPriority } from '@taskara/db';
import type { RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { sendTemplateSms } from './sms';

const taskPrioritySmsLabels: Record<TaskPriority, string> = {
  NO_PRIORITY: 'بدون اولویت',
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  URGENT: 'فوری'
};

export async function sendTaskCreatedSms(actor: RequestActor, taskId: string): Promise<{ sent: true; receptor: string }> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: actor.workspace.id },
    select: {
      id: true,
      key: true,
      title: true,
      priority: true,
      assignee: {
        select: {
          id: true,
          name: true,
          phone: true
        }
      }
    }
  });

  if (!task) throw new HttpError(404, 'Task not found in this workspace');
  if (!task.assignee) throw new HttpError(400, 'Task has no assignee');
  if (!task.assignee.phone) throw new HttpError(400, 'Task assignee has no phone number');

  await sendTemplateSms({
    receptor: task.assignee.phone,
    template: 'task-created',
    token: task.title,
    token10: task.title,
    token2: taskPrioritySmsLabels[task.priority],
    token20: taskPrioritySmsLabels[task.priority]
  });

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'sms_task_created_sent',
    after: {
      template: 'task-created',
      taskKey: task.key,
      assigneeId: task.assignee.id,
      receptor: maskPhone(task.assignee.phone)
    },
    source: actor.source
  }).catch(() => undefined);

  return { sent: true, receptor: maskPhone(task.assignee.phone) };
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
}
