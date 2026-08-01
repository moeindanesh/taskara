import type { TaskPriorityValue } from '@taskara/shared';
import type { JsonRecord, Milestone, Project, Task, TaskAttachment } from '../core/types';

/**
 * Presentation for a conversation: shapes and rankings a person reading a chat wants, which is not
 * what a shell pipe wants. This is the MCP shell's half of the seam — the core deliberately owns
 * none of it, or the CLI would end up printing MCP envelopes.
 */

export function projectSummary(project: Project): JsonRecord {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    status: project.status,
    parentId: project.parentId ?? null,
    description: project.description ?? null,
    taskCount: project._count?.tasks ?? project.tasks?.length ?? 0,
    subprojectCount: project._count?.subprojects ?? project.subprojects?.length ?? 0,
    milestoneCount: project._count?.milestones ?? 0
  };
}

export function taskSummary(task: Task): JsonRecord {
  return {
    id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    kind: task.kind ?? 'WORK',
    dueAt: task.dueAt ?? null,
    project: task.project ? { id: task.project.id, name: task.project.name, keyPrefix: task.project.keyPrefix } : null,
    milestone: task.milestone
      ? {
          id: task.milestone.id,
          name: task.milestone.name,
          kind: task.milestone.kind,
          status: task.milestone.status
        }
      : null,
    assignee: task.assignee ? { id: task.assignee.id, name: task.assignee.name, email: task.assignee.email } : null,
    labels: task.labels?.map(({ label }) => label.name) ?? [],
    comments: task._count?.comments ?? task.comments?.length ?? 0,
    attachments: task._count?.attachments ?? task.attachments?.length ?? 0,
    blockingDependencies: task._count?.blockingDependencies ?? task.blockingDependencies?.length ?? 0
  };
}

export function taskDetails(task: Task): JsonRecord {
  return {
    ...taskSummary(task),
    description: task.description ?? null,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    comments:
      task.comments?.map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        author: comment.author?.name ?? null
      })) ?? [],
    attachments: task.attachments?.map(attachmentSummary) ?? [],
    blockingDependencies: task.blockingDependencies?.map((dependency) => taskSummary(dependency.blockedByTask)) ?? []
  };
}

export function attachmentSummary(attachment: TaskAttachment): JsonRecord {
  return {
    id: attachment.id,
    name: attachment.name,
    object: attachment.object,
    url: attachment.url,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    createdAt: attachment.createdAt
  };
}

export function milestoneSummary(milestone: Milestone): JsonRecord {
  return {
    id: milestone.id,
    name: milestone.name,
    kind: milestone.kind,
    status: milestone.status,
    health: milestone.health ?? null,
    project: milestone.project
      ? {
          id: milestone.project.id,
          name: milestone.project.name,
          keyPrefix: milestone.project.keyPrefix,
          team: milestone.project.team ?? null
        }
      : { id: milestone.projectId },
    owner: milestone.owner ?? null,
    startsOn: milestone.startsOn ?? null,
    targetOn: milestone.targetOn ?? null,
    progress: milestone.progress,
    readyToComplete: milestone.readyToComplete ?? false,
    attentionReasons: milestone.attentionReasons ?? [],
    archivedAt: milestone.archivedAt ?? null,
    version: milestone.version,
    canManage: milestone.canManage ?? false
  };
}

export function milestoneDetails(milestone: Milestone): JsonRecord {
  return {
    ...milestoneSummary(milestone),
    description: milestone.description ?? null,
    completedAt: milestone.completedAt ?? null,
    canceledAt: milestone.canceledAt ?? null,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt
  };
}

export function isUnfinished(task: Task): boolean {
  return task.status !== 'DONE' && task.status !== 'CANCELED';
}

export function rankTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const blockedDelta = blockerPenalty(a) - blockerPenalty(b);
    if (blockedDelta !== 0) return blockedDelta;
    const priorityDelta = priorityScore(b.priority) - priorityScore(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return dueScore(a) - dueScore(b);
  });
}

function blockerPenalty(task: Task): number {
  return task.status === 'BLOCKED' || (task._count?.blockingDependencies ?? 0) > 0 ? 1 : 0;
}

function priorityScore(priority: TaskPriorityValue): number {
  return { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NO_PRIORITY: 0 }[priority] ?? 0;
}

function dueScore(task: Task): number {
  if (!task.dueAt) return Number.MAX_SAFE_INTEGER;
  return new Date(task.dueAt).getTime();
}

export function isOverdue(task: Task): boolean {
  return Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
}

export function countBy<T extends string>(items: Task[], getKey: (task: Task) => T): Record<T, number> {
  return items.reduce(
    (counts, item) => {
      const key = getKey(item);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    },
    {} as Record<T, number>
  );
}

export function inferPriority(text: string): TaskPriorityValue {
  if (/urgent|critical|asap|incident|فوری|بحرانی/i.test(text)) return 'URGENT';
  if (/block|blocked|security|payment|production|مسدود|امنیت|پرداخت/i.test(text)) return 'HIGH';
  if (/cleanup|polish|nice to have|بهبود/i.test(text)) return 'LOW';
  return 'MEDIUM';
}

export function inferLabels(text: string): string[] {
  const labels = new Set<string>();
  const checks: Array<[RegExp, string]> = [
    [/api|backend|server|database|postgres|prisma/i, 'backend'],
    [/ui|react|frontend|rtl|jalali/i, 'frontend'],
    [/mattermost|slash|bot|channel/i, 'mattermost'],
    [/codex|mcp|plugin|agent/i, 'codex'],
    [/bug|fix|error|crash|issue/i, 'bug'],
    [/security|auth|permission|role/i, 'security']
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) labels.add(label);
  }
  return [...labels];
}

export function inferNextAction(task: Task): string {
  if (!task.description) return 'Add acceptance criteria and enough context for an assignee.';
  if (task.priority === 'NO_PRIORITY') return 'Assign an explicit priority.';
  if (!task.assignee) return 'Assign an owner.';
  return 'Move to TODO or IN_PROGRESS when ready to execute.';
}

export function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
