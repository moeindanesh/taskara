import { prisma, type TaskPriority } from '@taskara/db';
import { config } from '../config';
import type { RequestActor } from './actor';
import { logActivity } from './audit';
import { HttpError } from './http';
import { sendMessageSimple } from './sms';

const taskPrioritySmsLabels: Record<TaskPriority, string> = {
  NO_PRIORITY: 'بدون اولویت',
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  URGENT: 'فوری'
};

type TaskSmsMessageTask = {
  key: string;
  title: string;
  priority: TaskPriority;
  assignee: {
    name: string;
  };
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
  const assignee = task.assignee;
  if (!assignee) throw new HttpError(400, 'Task has no assignee');
  if (!assignee.phone) throw new HttpError(400, 'Task assignee has no phone number');
  if (!config.SMS_KAVEH_SENDER) throw new HttpError(503, 'SMS_KAVEH_SENDER is required to send task-created SMS');

  await sendMessageSimple(assignee.phone, buildTaskCreatedSmsMessage(actor, { ...task, assignee }), config.SMS_KAVEH_SENDER);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'sms_task_created_sent',
    after: {
      providerEndpoint: 'sms/send.json',
      taskKey: task.key,
      assigneeId: assignee.id,
      receptor: maskPhone(assignee.phone)
    },
    source: actor.source
  }).catch(() => undefined);

  return { sent: true, receptor: maskPhone(assignee.phone) };
}

export async function sendTaskFollowUpSms(actor: RequestActor, taskId: string): Promise<{ sent: true; receptor: string }> {
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
  const assignee = task.assignee;
  if (!assignee) throw new HttpError(400, 'Task has no assignee');
  if (!assignee.phone) throw new HttpError(400, 'Task assignee has no phone number');
  if (!config.SMS_KAVEH_SENDER) throw new HttpError(503, 'SMS_KAVEH_SENDER is required to send task follow-up SMS');

  await sendMessageSimple(assignee.phone, buildTaskFollowUpSmsMessage(actor, { ...task, assignee }), config.SMS_KAVEH_SENDER);

  await logActivity({
    workspaceId: actor.workspace.id,
    actorId: actor.user.id,
    actorType: actor.actorType,
    entityType: 'task',
    entityId: task.id,
    action: 'sms_task_follow_up_sent',
    after: {
      providerEndpoint: 'sms/send.json',
      taskKey: task.key,
      assigneeId: assignee.id,
      receptor: maskPhone(assignee.phone)
    },
    source: actor.source
  }).catch(() => undefined);

  return { sent: true, receptor: maskPhone(assignee.phone) };
}

export function buildTaskCreatedSmsMessage(
  actor: Pick<RequestActor, 'workspace' | 'user'>,
  task: TaskSmsMessageTask
): string {
  const taskUrl = taskDetailUrl(actor.workspace.slug, task.key);
  const assigneeName = smsDisplayName(task.assignee.name);

  return [
    `${assigneeName}، در تسکارا وظیفه جدید داری.`,
    `عنوان: ${task.title}`,
    `اولویت: ${taskPrioritySmsLabels[task.priority]}`,
    `ثبت‌کننده: ${actor.user.name}`,
    taskUrl
  ].join('\n');
}

export function buildTaskFollowUpSmsMessage(
  actor: Pick<RequestActor, 'workspace' | 'user'>,
  task: TaskSmsMessageTask
): string {
  const taskUrl = taskDetailUrl(actor.workspace.slug, task.key);
  const assigneeName = smsDisplayName(task.assignee.name);

  return [
    `${assigneeName}، در تسکارا وضعیت این وظیفه رو آپدیت کن.`,
    `عنوان: ${task.title}`,
    `اولویت: ${taskPrioritySmsLabels[task.priority]}`,
    `درخواست‌کننده: ${actor.user.name}`,
    taskUrl
  ].join('\n');
}

function taskDetailUrl(workspaceSlug: string, taskKey: string): string {
  const baseUrl = config.WEB_ORIGIN.replace(/\/$/, '');
  return `${baseUrl}/${encodeURIComponent(workspaceSlug)}/issue/${encodeURIComponent(taskKey)}`;
}

function smsDisplayName(name: string): string {
  return name.trim() || 'همکار';
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
}
