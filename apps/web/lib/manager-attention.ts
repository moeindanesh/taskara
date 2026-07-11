import type { TaskaraAttentionItem } from '@/lib/taskara-types';

export function managerAttentionGroupKey(item: TaskaraAttentionItem) {
   const payload = item.payload || {};
   const subject = payload.task
      ? `task:${payload.task.id}`
      : payload.project
        ? `project:${payload.project.id}`
        : payload.oneOnOne
          ? `one-on-one:${payload.oneOnOne.id}`
          : payload.actionItem
            ? `meeting-action:${payload.actionItem.id}`
            : payload.user
              ? `user:${payload.user.id}`
              : `${item.entityType}:${item.entityId}`;

   return `${subject}:${managerActionFamily(item.reason)}`;
}

function managerActionFamily(reason: TaskaraAttentionItem['reason']) {
   switch (reason) {
      case 'blocked_task':
      case 'overdue_task':
      case 'stale_task':
         return 'restore-flow';
      case 'review_waiting':
         return 'review';
      case 'backlog_triage':
         return 'triage';
      case 'unassigned_due_soon':
         return 'assign';
      case 'overloaded_person':
      case 'missing_check_in':
         return 'coordinate-person';
      case 'person_without_active_work':
         return 'plan-person';
      case 'project_at_risk':
      case 'project_update_due':
         return 'update-project';
      case 'one_on_one_due':
         return 'prepare-one-on-one';
      case 'stale_meeting_action_item':
         return 'close-meeting-action';
      default:
         return reason;
   }
}
