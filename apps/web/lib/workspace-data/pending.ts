import type {
   TaskaraAttentionItem,
   TaskaraAttentionResponse,
   TaskaraMeetingActionItem,
   TaskaraProject,
   TaskaraProjectHealthUpdate,
   TaskaraProjectUpdateHealth,
   TaskaraOneOnOneAgendaItem,
   TaskaraOneOnOneAgendaResponse,
   TaskaraOneOnOneSeries,
   TaskaraTask,
} from '@/lib/taskara-types';

export type PendingSyncMutationLike = {
   name: string;
   args: unknown;
   createdAt?: string;
};

export type PendingAttentionAction =
   | { type: 'resolve' }
   | { type: 'dismiss'; reason: string }
   | { type: 'snooze'; snoozedUntil: string };

export function pendingTaskIds(tasks: TaskaraTask[]): Set<string> {
   return new Set(
      tasks
         .filter((task) => task.syncState === 'pending')
         .flatMap((task) => [task.id, task.key, task.syncMutationId].filter((value): value is string => Boolean(value)))
   );
}

export function hasPendingWorkspaceTasks(tasks: TaskaraTask[]): boolean {
   return tasks.some((task) => task.syncState === 'pending');
}

export function applyPendingAttentionAction(
   current: TaskaraAttentionResponse,
   item: TaskaraAttentionItem,
   action: PendingAttentionAction,
   now = new Date()
): TaskaraAttentionResponse {
   const wasVisible = current.items.some((currentItem) => currentItem.id === item.id);
   const hiddenFromActiveQueue =
      action.type === 'resolve' ||
      action.type === 'dismiss' ||
      (action.type === 'snooze' && Date.parse(action.snoozedUntil) > now.getTime());

   const updatedItem: TaskaraAttentionItem = {
      ...item,
      status: action.type === 'snooze' ? 'SNOOZED' : action.type === 'dismiss' ? 'DISMISSED' : 'RESOLVED',
      snoozedUntil: action.type === 'snooze' ? action.snoozedUntil : null,
      resolvedAt: action.type === 'resolve' ? now.toISOString() : item.resolvedAt,
      dismissedAt: action.type === 'dismiss' ? now.toISOString() : item.dismissedAt,
      dismissalReason: action.type === 'dismiss' ? action.reason : item.dismissalReason,
   };

   return {
      ...current,
      total: wasVisible && hiddenFromActiveQueue ? Math.max(0, current.total - 1) : current.total,
      items: hiddenFromActiveQueue
         ? current.items.filter((currentItem) => currentItem.id !== item.id)
         : current.items.map((currentItem) => (currentItem.id === item.id ? updatedItem : currentItem)),
   };
}

export function applyPendingAttentionMutations(
   current: TaskaraAttentionResponse,
   mutations: PendingSyncMutationLike[],
   now = new Date()
): TaskaraAttentionResponse {
   return orderedPendingMutations(mutations).reduce((next, mutation) => {
      const action = pendingAttentionAction(mutation);
      if (!action) return next;
      const item = next.items.find((candidate) => candidate.id === action.id);
      if (!item) return next;
      return applyPendingAttentionAction(next, item, action.action, now);
   }, current);
}

export function applyPendingMeetingActionItemMutations(
   items: TaskaraMeetingActionItem[],
   mutations: PendingSyncMutationLike[]
): TaskaraMeetingActionItem[] {
   return orderedPendingMutations(mutations).reduce((next, mutation) => {
      const pendingCreated = pendingMeetingActionItem(mutation);
      if (pendingCreated) {
         const exists = next.some((item) => item.id === pendingCreated.id || meetingActionItemCreateKey(item) === meetingActionItemCreateKey(pendingCreated));
         return exists ? next : [...next, pendingCreated];
      }

      const action = pendingMeetingActionItemAction(mutation);
      if (!action) return next;

      if (action.type === 'close') return next.filter((item) => item.id !== action.id);

      return next
         .map((item) => item.id === action.id ? { ...item, ...action.patch } : item)
         .filter((item) => item.status === 'OPEN');
   }, items);
}

export function applyPendingProjectHealthMutations(
   projects: TaskaraProject[],
   mutations: PendingSyncMutationLike[],
   now = new Date()
): TaskaraProject[] {
   const pendingUpdates = orderedPendingMutations(mutations)
      .map((mutation) => pendingProjectHealthUpdate(mutation, now))
      .filter((update): update is TaskaraProjectHealthUpdate => Boolean(update));

   if (!pendingUpdates.length) return projects;

   const updatesByProject = new Map<string, TaskaraProjectHealthUpdate[]>();
   for (const update of pendingUpdates) {
      const current = updatesByProject.get(update.projectId) || [];
      updatesByProject.set(update.projectId, [update, ...current]);
   }

   return projects.map((project) => {
      const updates = updatesByProject.get(project.id);
      if (!updates?.length) return project;
      return {
         ...project,
         healthUpdates: [...updates, ...(project.healthUpdates || [])],
      };
   });
}

export function applyPendingOneOnOneMutations(
   series: TaskaraOneOnOneSeries[],
   mutations: PendingSyncMutationLike[],
   users: Array<{ id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null }> = [],
   now = new Date()
): TaskaraOneOnOneSeries[] {
   const seenParticipantIds = new Set(series.map((item) => item.participantId));
   const pendingSeries: TaskaraOneOnOneSeries[] = [];

   for (const mutation of orderedPendingMutations(mutations)) {
      const item = pendingOneOnOneSeries(mutation, users, now);
      if (!item || seenParticipantIds.has(item.participantId)) continue;
      seenParticipantIds.add(item.participantId);
      pendingSeries.push(item);
   }

   return pendingSeries.length ? [...series, ...pendingSeries] : series;
}

export function applyPendingAgendaItemMutations(
   agenda: TaskaraOneOnOneAgendaResponse,
   mutations: PendingSyncMutationLike[],
   now = new Date()
): TaskaraOneOnOneAgendaResponse {
   const pendingItems = orderedPendingMutations(mutations)
      .map((mutation) => pendingAgendaItem(mutation, agenda.series.id, now))
      .filter((item): item is TaskaraOneOnOneAgendaItem => Boolean(item));

   if (!pendingItems.length) return agenda;

   const pendingSourceKeys = new Set(
      pendingItems
         .filter((item) => item.sourceType && item.sourceId)
         .map((item) => `${item.sourceType}:${item.sourceId}`)
   );
   const existingItemIds = new Set(agenda.items.map((item) => item.id));

   return {
      ...agenda,
      items: [
         ...agenda.items,
         ...pendingItems.filter((item) => !existingItemIds.has(item.id)),
      ],
      generated: agenda.generated.filter((item) => !pendingSourceKeys.has(`${item.sourceType}:${item.sourceId}`)),
   };
}

export function applyPendingCarryForwardAgendaMutations(
   agenda: TaskaraOneOnOneAgendaResponse,
   actionItems: TaskaraMeetingActionItem[],
   mutations: PendingSyncMutationLike[]
): TaskaraOneOnOneAgendaResponse {
   const pendingItems = orderedPendingMutations(mutations)
      .map((mutation) => pendingCarryForwardAgendaItem(mutation, agenda.series.id, actionItems))
      .filter((item): item is TaskaraOneOnOneAgendaItem => Boolean(item));

   if (!pendingItems.length) return agenda;

   const existingSourceKeys = new Set(
      agenda.items
         .filter((item) => item.sourceType && item.sourceId)
         .map((item) => `${item.sourceType}:${item.sourceId}`)
   );
   const nextPendingItems = pendingItems.filter((item) => !existingSourceKeys.has(`${item.sourceType}:${item.sourceId}`));
   if (!nextPendingItems.length) return agenda;

   const pendingSourceKeys = new Set(nextPendingItems.map((item) => `${item.sourceType}:${item.sourceId}`));

   return {
      ...agenda,
      items: [...agenda.items, ...nextPendingItems],
      generated: agenda.generated.filter((item) => !pendingSourceKeys.has(`${item.sourceType}:${item.sourceId}`)),
   };
}

function pendingAttentionAction(
   mutation: PendingSyncMutationLike
): { id: string; action: PendingAttentionAction } | null {
   const args = recordValue(mutation.args);
   const id = stringValue(args?.id);
   if (!id) return null;

   if (mutation.name === 'attention.resolve') {
      return { id, action: { type: 'resolve' } };
   }

   if (mutation.name === 'attention.dismiss') {
      const reason = stringValue(args?.reason);
      if (!reason) return null;
      return { id, action: { type: 'dismiss', reason } };
   }

   if (mutation.name === 'attention.snooze') {
      const snoozedUntil = stringValue(args?.snoozedUntil);
      if (!snoozedUntil) return null;
      return { id, action: { type: 'snooze', snoozedUntil } };
   }

   return null;
}

function pendingMeetingActionItemAction(
   mutation: PendingSyncMutationLike
): { type: 'close'; id: string } | { type: 'update'; id: string; patch: Partial<TaskaraMeetingActionItem> } | null {
   const args = recordValue(mutation.args);
   const id = stringValue(args?.id);
   if (!id) return null;

   if (
      mutation.name === 'meeting_action_item.complete' ||
      mutation.name === 'meeting_action_item.cancel' ||
      mutation.name === 'meeting_action_item.create_task'
   ) {
      return { type: 'close', id };
   }

   if (mutation.name !== 'meeting_action_item.update') return null;

   const patch = recordValue(args?.patch);
   if (!patch) return null;
   const status = patch.status === 'OPEN' || patch.status === 'DONE' || patch.status === 'CANCELED'
      ? patch.status
      : undefined;
   return {
      type: 'update',
      id,
      patch: {
         ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
         ...(typeof patch.notes === 'string' || patch.notes === null ? { notes: patch.notes } : {}),
         ...(typeof patch.dueAt === 'string' || patch.dueAt === null ? { dueAt: patch.dueAt } : {}),
         ...(status ? { status } : {}),
      },
   };
}

function pendingMeetingActionItem(mutation: PendingSyncMutationLike): TaskaraMeetingActionItem | null {
   if (mutation.name !== 'meeting_action_item.create') return null;
   const args = recordValue(mutation.args);
   const meetingId = stringValue(args?.meetingId);
   const item = recordValue(args?.item);
   const title = stringValue(item?.title);
   if (!meetingId || !title) return null;
   const createdAt = mutation.createdAt || new Date().toISOString();

   return {
      id: `pending-action-${meetingId}-${createdAt}`,
      workspaceId: 'pending',
      meetingId,
      taskId: null,
      assigneeId: optionalStringValue(item?.assigneeId),
      createdById: null,
      title,
      notes: optionalStringValue(item?.notes),
      status: 'OPEN',
      dueAt: optionalStringValue(item?.dueAt),
      createdAt,
      updatedAt: createdAt,
      assignee: null,
      createdBy: null,
      task: null,
      meeting: {
         id: meetingId,
         title: 'جلسه',
      },
   };
}

function meetingActionItemCreateKey(item: Pick<TaskaraMeetingActionItem, 'meetingId' | 'title' | 'dueAt'>): string {
   return [item.meetingId, item.title.trim(), item.dueAt || ''].join(':');
}

function pendingProjectHealthUpdate(
   mutation: PendingSyncMutationLike,
   now: Date
): TaskaraProjectHealthUpdate | null {
   if (mutation.name !== 'project_health_update.create') return null;
   const args = recordValue(mutation.args);
   const projectId = stringValue(args?.projectId);
   const update = recordValue(args?.update);
   const health = projectHealthValue(update?.health);
   const summary = stringValue(update?.summary);
   if (!projectId || !health || !summary) return null;

   const createdAt = mutation.createdAt || now.toISOString();
   return {
      id: `pending-${projectId}-${createdAt}`,
      workspaceId: 'pending',
      projectId,
      authorId: null,
      health,
      summary,
      progress: optionalStringValue(update?.progress),
      risks: optionalStringValue(update?.risks),
      decisionsNeeded: optionalStringValue(update?.decisionsNeeded),
      nextUpdateDueAt: optionalStringValue(update?.nextUpdateDueAt),
      publishedAt: null,
      createdAt,
      updatedAt: createdAt,
   };
}

function pendingOneOnOneSeries(
   mutation: PendingSyncMutationLike,
   users: Array<{ id: string; name: string; email: string; phone?: string | null; avatarUrl?: string | null }>,
   now: Date
): TaskaraOneOnOneSeries | null {
   if (mutation.name !== 'one_on_one.create') return null;
   const args = recordValue(mutation.args);
   const participantId = stringValue(args?.participantId);
   if (!participantId) return null;
   const createdAt = mutation.createdAt || now.toISOString();
   const participant = users.find((user) => user.id === participantId) || null;

   return {
      id: `pending-one-on-one-${participantId}-${createdAt}`,
      workspaceId: 'pending',
      managerId: stringValue(args?.managerId) || 'pending',
      participantId,
      title: optionalStringValue(args?.title),
      cadenceDays: typeof args?.cadenceDays === 'number' ? args.cadenceDays : 14,
      nextScheduledAt: optionalStringValue(args?.nextScheduledAt),
      lastMeetingId: null,
      active: true,
      createdAt,
      updatedAt: createdAt,
      participant,
      manager: null,
      lastMeeting: null,
      _count: { agendaItems: 0 },
   };
}

function pendingAgendaItem(
   mutation: PendingSyncMutationLike,
   seriesId: string,
   now: Date
): TaskaraOneOnOneAgendaItem | null {
   if (mutation.name !== 'one_on_one_agenda_item.create') return null;
   const args = recordValue(mutation.args);
   if (stringValue(args?.seriesId) !== seriesId) return null;
   const item = recordValue(args?.item);
   const title = stringValue(item?.title);
   if (!title) return null;
   const sourceType = optionalStringValue(item?.sourceType);
   const sourceId = optionalStringValue(item?.sourceId);
   const createdAt = mutation.createdAt || now.toISOString();

   return {
      id: `pending-agenda-${seriesId}-${sourceType || 'manual'}-${sourceId || createdAt}`,
      workspaceId: 'pending',
      seriesId,
      meetingId: optionalStringValue(item?.meetingId),
      createdById: null,
      sourceType,
      sourceId,
      title,
      notes: optionalStringValue(item?.notes),
      status: 'OPEN',
      position: typeof item?.position === 'number' ? item.position : 0,
      createdAt,
      updatedAt: createdAt,
      createdBy: null,
      meeting: null,
   };
}

function pendingCarryForwardAgendaItem(
   mutation: PendingSyncMutationLike,
   seriesId: string,
   actionItems: TaskaraMeetingActionItem[]
): TaskaraOneOnOneAgendaItem | null {
   if (mutation.name !== 'meeting_action_item.carry_forward') return null;
   const args = recordValue(mutation.args);
   const id = stringValue(args?.id);
   const carry = recordValue(args?.carry);
   if (!id || stringValue(carry?.seriesId) !== seriesId) return null;
   const actionItem = actionItems.find((item) => item.id === id);
   if (!actionItem) return null;

   return {
      id: `pending-carry-${seriesId}-${id}`,
      workspaceId: 'pending',
      seriesId,
      meetingId: null,
      createdById: null,
      sourceType: 'action_item',
      sourceId: id,
      title: actionItem.title,
      notes: optionalStringValue(carry?.notes) || actionItem.notes || null,
      status: 'OPEN',
      position: 0,
      createdAt: mutation.createdAt || actionItem.updatedAt || actionItem.createdAt,
      updatedAt: mutation.createdAt || actionItem.updatedAt || actionItem.createdAt,
      createdBy: null,
      meeting: actionItem.meeting
         ? {
              id: actionItem.meeting.id,
              title: actionItem.meeting.title,
              scheduledAt: actionItem.meeting.scheduledAt,
              heldAt: actionItem.meeting.heldAt,
              status: actionItem.meeting.status,
           }
         : null,
   };
}

function projectHealthValue(value: unknown): TaskaraProjectUpdateHealth | null {
   return value === 'ON_TRACK' || value === 'AT_RISK' || value === 'OFF_TRACK' ? value : null;
}

function orderedPendingMutations<T extends PendingSyncMutationLike>(mutations: T[]): T[] {
   return [...mutations].sort((left, right) => (left.createdAt || '').localeCompare(right.createdAt || ''));
}

function recordValue(value: unknown): Record<string, unknown> | null {
   if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
   return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
   return typeof value === 'string' && value ? value : null;
}

function optionalStringValue(value: unknown): string | null {
   return typeof value === 'string' && value ? value : null;
}
