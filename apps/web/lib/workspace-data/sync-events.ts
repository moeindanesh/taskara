import type {
   TaskaraAttentionItem,
   TaskaraCheckInResponse,
   TaskaraMeetingActionItem,
   TaskaraMilestone,
   TaskaraOneOnOneAgendaItem,
   TaskaraOneOnOneSeries,
   TaskaraProjectHealthUpdate,
   TaskaraTaskReview,
} from '@/lib/taskara-types';
import type { WorkspaceDataEntities, WorkspaceEntityMap } from '@/lib/workspace-data/store';

type ManagerEntityType =
   | 'attention'
   | 'review'
   | 'check_in'
   | 'one_on_one'
   | 'one_on_one_agenda_item'
   | 'meeting_action_item'
   | 'project_health_update';

type ManagerEntity =
   | TaskaraAttentionItem
   | TaskaraTaskReview
   | TaskaraCheckInResponse
   | TaskaraOneOnOneSeries
   | TaskaraOneOnOneAgendaItem
   | TaskaraMeetingActionItem
   | TaskaraProjectHealthUpdate;

export interface WorkspaceDataSyncEvent {
   entityType?: string;
   entityId?: string;
   type?: 'upsert' | 'delete' | 'removeFromScope';
   entity?: unknown;
   payload?: unknown;
}

export function applyWorkspaceSyncEvents(
   entities: WorkspaceDataEntities,
   events: WorkspaceDataSyncEvent[]
): WorkspaceDataEntities {
   let next = entities;

   for (const event of events) {
      const entityType = managerEntityType(event.entityType);
      if (!entityType) continue;

      const incoming = eventEntity(event);
      const id = entityId(event, incoming);
      if (!id) continue;

      if (event.type === 'delete' || event.type === 'removeFromScope') {
         if (next === entities) next = cloneWorkspaceEntities(entities);
         deleteFromEntityMap(next, entityType, id);
      } else if (incoming) {
         if (next === entities) next = cloneWorkspaceEntities(entities);
         upsertEntityMap(next, entityType, incoming);
      }
   }

   return next;
}

/**
 * Applies project-scoped milestone resource events without mixing them into the
 * manager-entity maps. The API can carry the serialized resource directly or
 * inside payload.after; delete events only need an entity id.
 */
export function applyMilestoneSyncEvents(
   milestones: TaskaraMilestone[],
   events: WorkspaceDataSyncEvent[]
): TaskaraMilestone[] {
   let next = milestones;

   for (const event of events) {
      if (event.entityType !== 'milestone') continue;
      const incoming = milestoneEventEntity(event);
      const id = typeof event.entityId === 'string' && event.entityId ? event.entityId : incoming?.id;
      if (!id) continue;

      if (event.type === 'delete' || event.type === 'removeFromScope') {
         const index = next.findIndex((milestone) => milestone.id === id);
         if (index === -1) continue;
         next = [...next.slice(0, index), ...next.slice(index + 1)];
         continue;
      }

      if (!incoming) continue;
      const index = next.findIndex((milestone) => milestone.id === incoming.id);
      if (index === -1) {
         next = [...next, incoming];
      } else {
         const copy = [...next];
         // Progress events are workspace-global and intentionally omit the
         // viewer-specific canManage capability. Merge them into the cached
         // resource so a task update cannot accidentally revoke local UI
         // controls until the next bootstrap.
         copy[index] = { ...copy[index], ...incoming };
         next = copy;
      }
   }

   return next;
}

function cloneWorkspaceEntities(entities: WorkspaceDataEntities): WorkspaceDataEntities {
   return {
      attention: { ...entities.attention },
      reviews: { ...entities.reviews },
      checkIns: { ...entities.checkIns },
      oneOnOnes: { ...entities.oneOnOnes },
      oneOnOneAgendaItems: { ...entities.oneOnOneAgendaItems },
      meetingActionItems: { ...entities.meetingActionItems },
      projectHealthUpdates: { ...entities.projectHealthUpdates },
   };
}

function managerEntityType(value: string | undefined): ManagerEntityType | null {
   switch (value) {
      case 'attention':
      case 'review':
      case 'check_in':
      case 'one_on_one':
      case 'one_on_one_agenda_item':
      case 'meeting_action_item':
      case 'project_health_update':
         return value;
      default:
         return null;
   }
}

function eventEntity(event: WorkspaceDataSyncEvent): ManagerEntity | null {
   const direct = recordWithId(event.entity);
   if (direct) return direct as unknown as ManagerEntity;

   const payload = recordValue(event.payload);
   const after = recordWithId(payload?.after);
   if (after) return after as unknown as ManagerEntity;

   const before = recordWithId(payload?.before);
   return before ? before as unknown as ManagerEntity : null;
}

function milestoneEventEntity(event: WorkspaceDataSyncEvent): TaskaraMilestone | null {
   const direct = recordWithId(event.entity);
   if (direct) return direct as unknown as TaskaraMilestone;

   const payload = recordValue(event.payload);
   const after = recordWithId(payload?.after);
   return after ? after as unknown as TaskaraMilestone : null;
}

function entityId(event: WorkspaceDataSyncEvent, entity: ManagerEntity | null): string | null {
   if (typeof event.entityId === 'string' && event.entityId) return event.entityId;
   return entity?.id || null;
}

function recordWithId(value: unknown): ({ id: string } & Record<string, unknown>) | null {
   const record = recordValue(value);
   return typeof record?.id === 'string' ? record as { id: string } & Record<string, unknown> : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
   if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
   return value as Record<string, unknown>;
}

function upsertEntityMap(entities: WorkspaceDataEntities, type: ManagerEntityType, entity: ManagerEntity): void {
   entityMap(entities, type)[entity.id] = entity as never;
}

function deleteFromEntityMap(entities: WorkspaceDataEntities, type: ManagerEntityType, id: string): void {
   delete entityMap(entities, type)[id];
}

function entityMap(entities: WorkspaceDataEntities, type: ManagerEntityType): WorkspaceEntityMap<ManagerEntity> {
   switch (type) {
      case 'attention':
         return entities.attention;
      case 'review':
         return entities.reviews;
      case 'check_in':
         return entities.checkIns;
      case 'one_on_one':
         return entities.oneOnOnes;
      case 'one_on_one_agenda_item':
         return entities.oneOnOneAgendaItems;
      case 'meeting_action_item':
         return entities.meetingActionItems;
      case 'project_health_update':
         return entities.projectHealthUpdates;
   }
}
