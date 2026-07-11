import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TaskaraClientError, taskaraApiBaseUrl, taskaraRequest, taskaraRequestHeaders } from '@/lib/taskara-client';
import { fa } from '@/lib/fa-copy';
import { dispatchWorkspaceRefresh } from '@/lib/live-refresh';
import { authChangedEvent, authStorageKey, clearAuthSession, getAuthSession } from '@/store/auth-store';
import type {
   TaskaraMilestone,
   TaskaraMilestoneAttention,
   TaskaraMilestoneCreateInput,
   TaskaraMilestoneLifecycleAction,
   TaskaraMilestoneLifecycleInput,
   TaskaraMilestoneReorderInput,
   TaskaraMilestoneUpdatePatch,
   TaskaraProject,
   TaskaraTask,
   TaskaraTeam,
   TaskaraUser,
   TaskaraView,
} from '@/lib/taskara-types';
import {
   applyMilestoneSyncEvents,
   applyWorkspaceSyncEvents,
   type WorkspaceDataSyncEvent,
} from '@/lib/workspace-data/sync-events';
import {
   createWorkspaceDataState,
   emptyWorkspaceDataEntities,
   type WorkspaceDataEntities,
} from '@/lib/workspace-data/store';

export type TaskUpdatePatch = {
   title?: string;
   description?: string | null;
   projectId?: string | null;
   status?: string;
   priority?: string;
   weight?: number | null;
   assigneeId?: string | null;
   milestoneId?: string | null;
   dueAt?: string | null;
   labels?: string[];
};

type TaskCreateInput = {
   projectId: string;
   title: string;
   description?: string;
   status: string;
   priority: string;
   weight?: number | null;
   assigneeId?: string;
   milestoneId?: string;
   dueAt?: string;
   labels: string[];
   source: 'WEB';
};

type BootstrapResponse = {
   cursor: string;
   serverTime?: string;
   completedWindowDays?: number;
   omittedCompletedBefore?: string;
   totalHotTasks?: number;
   tasks: TaskaraTask[];
   milestones?: TaskaraMilestone[];
   projects: TaskaraProject[];
   teams: TaskaraTeam[];
   users: TaskaraUser[];
   views: TaskaraView[];
};

type PullResponse = {
   cursor: string;
   resetRequired?: boolean;
   hasMore?: boolean;
   events: SyncTaskEvent[];
};

type SyncTaskEvent = {
   cursor: string;
   entityType?: string;
   entityId?: string;
   clientId?: string | null;
   mutationId?: string | null;
   type?: 'upsert' | 'delete' | 'removeFromScope';
   entity?: unknown;
   payload?: unknown;
   task?: TaskaraTask;
   taskId?: string;
   taskKey?: string;
};

type PushResponse = {
   cursor: string;
   results: Array<{
      mutationId: string;
      status: 'applied' | 'duplicate' | 'rejected' | 'conflict';
      workspaceSeq?: string;
      entity?: unknown;
      error?: { code: string; message: string; retryable: boolean };
   }>;
};

type PushMutationResult = PushResponse['results'][number];

export type TaskSyncScope = {
   teamId: string;
   mine?: boolean;
   workspaceSlug?: string;
};

type TaskSyncResources = {
   milestones: TaskaraMilestone[];
   projects: TaskaraProject[];
   teams: TaskaraTeam[];
   users: TaskaraUser[];
   views: TaskaraView[];
};

const clientIdStorageKey = 'taskara.sync.clientId.v1';
const pendingMutationsStorageKey = 'taskara.sync.pendingMutations.v1';
const scopeSnapshotStoragePrefix = 'taskara.sync.scopeSnapshot.v1:';
const taskSyncDbName = 'taskara-task-sync';
const pendingMutationsStore = 'pendingMutations';
const scopeSnapshotsStore = 'scopeSnapshots';
const broadcastName = 'taskara.task-sync.v1';
export const taskSyncMutationFailuresEvent = 'taskara:task-sync-mutation-failures';
const windowSyncMessageEvent = 'taskara:task-sync-message';
const progressTaskStatuses = new Set(['IN_PROGRESS', 'IN_REVIEW']);
let lastMutationCreatedAtMs = 0;
const taskSyncMutationActionLabels: Record<string, string> = {
   'attention.dismiss': 'رد کردن مورد توجه',
   'attention.resolve': 'حل کردن مورد توجه',
   'attention.snooze': 'تعویق مورد توجه',
   'check_in.create': 'ثبت چک‌این',
   'meeting_action_item.cancel': 'لغو کار خروجی جلسه',
   'meeting_action_item.carry_forward': 'انتقال کار خروجی به دستور جلسه',
   'meeting_action_item.complete': 'بستن کار خروجی جلسه',
   'meeting_action_item.create': 'ساخت کار خروجی جلسه',
   'meeting_action_item.create_task': 'ساخت کار از خروجی جلسه',
   'meeting_action_item.update': 'به‌روزرسانی کار خروجی جلسه',
   'milestone.activate': 'فعال‌سازی مایلستون',
   'milestone.archive': 'بایگانی مایلستون',
   'milestone.cancel': 'لغو مایلستون',
   'milestone.complete': 'تکمیل مایلستون',
   'milestone.create': 'ایجاد مایلستون',
   'milestone.reopen': 'بازگشایی مایلستون',
   'milestone.reorder': 'تغییر ترتیب مایلستون',
   'milestone.restore': 'بازگردانی مایلستون',
   'milestone.update': 'به‌روزرسانی مایلستون',
   'one_on_one.create': 'ساخت ۱:۱',
   'one_on_one_agenda_item.create': 'افزودن دستور جلسه ۱:۱',
   'project_health_update.create': 'ثبت آپدیت سلامت پروژه',
   'task.comment.create': 'ثبت دیدگاه کار',
   'task.create': 'ایجاد کار',
   'task.delete': 'حذف کار',
   'task.update': 'به‌روزرسانی کار',
};

export type PersistedTaskMutation = {
   clientId: string;
   mutationId: string;
   authIdentityKey?: string;
   name: string;
   args: unknown;
   createdAt: string;
   dependsOnMutationIds?: string[];
   scopeKey?: string;
   baseVersion?: number;
   optimisticTask?: TaskaraTask;
   optimisticMilestone?: TaskaraMilestone;
   deletedTaskId?: string;
   deletedTaskKey?: string;
};

export type TaskSyncMutationFailure = {
   mutationId: string;
   name: string;
   status: 'rejected' | 'conflict';
   code: string;
   retryable: boolean;
   userMessage: string;
   serverMessage?: string;
};

export type TaskSyncMutationFailureEventDetail = {
   failures: TaskSyncMutationFailure[];
};

export type TaskSyncMutationFlushResult = {
   failures: TaskSyncMutationFailure[];
   hadAppliedMutations: boolean;
   hadFinalFailures: boolean;
};

type CachedScopeSnapshot = BootstrapResponse & {
   scopeKey: string;
   savedAt: string;
};

type PendingMutationOptions = {
   mutationId?: string;
   keepPendingOnRetryable?: boolean;
   scopeKey?: string;
   baseVersion?: number;
   dependsOnMutationIds?: string[];
   optimisticTask?: TaskaraTask;
   optimisticMilestone?: TaskaraMilestone;
   deletedTaskId?: string;
   deletedTaskKey?: string;
};

type TaskSyncBroadcastMessage =
   | { type: 'events'; scopeKey: string; cursor: string; events: SyncTaskEvent[] }
   | { type: 'localTask'; scopeKey: string; task: TaskaraTask; mutationId?: string }
   | { type: 'localTaskDeleted'; scopeKey: string; taskId?: string; taskKey?: string; mutationId?: string }
   | { type: 'localMilestone'; scopeKey: string; milestone: TaskaraMilestone; mutationId?: string }
   | { type: 'localMilestoneDeleted'; scopeKey: string; milestoneId: string; mutationId?: string };

type TaskSyncAuthIdentity = {
   token: string | null;
   userId: string | null;
   workspaceSlug: string | null;
};

export class TaskSyncMutationError extends Error {
   failure?: TaskSyncMutationFailure;
   retryable: boolean;

   constructor(message: string, retryable: boolean, failure?: TaskSyncMutationFailure) {
      super(message);
      this.name = 'TaskSyncMutationError';
      this.retryable = retryable;
      this.failure = failure;
   }
}

export type TaskSyncController = ReturnType<typeof useTaskSync>;
export type TaskSyncStatus = 'loading' | 'ready' | 'syncing' | 'offline' | 'recovering' | 'error';

type TaskSyncRefreshOptions = {
   preserveVisibleState?: boolean;
};

export function useTaskSync(scope: TaskSyncScope) {
   const [authRevision, setAuthRevision] = useState(0);
   const scopeKey = useMemo(() => taskScopeKey(scope), [authRevision, scope]);
   const scopeRef = useRef(scope);
   const cursorRef = useRef('0');
   const pullingRef = useRef(false);
   const bootstrappedRef = useRef(false);
   const bootstrapRunRef = useRef(0);
   const lastBootstrappedScopeRef = useRef<string | null>(null);
   const authIdentityRef = useRef<TaskSyncAuthIdentity>(readTaskSyncAuthIdentity());
   const clientId = useMemo(getOrCreateTaskSyncClientId, []);
   const [tasks, setTasks] = useState<TaskaraTask[]>([]);
   const [resources, setResources] = useState<TaskSyncResources>({
      milestones: [],
      projects: [],
      teams: [],
      users: [],
      views: [],
   });
   const [workspaceEntities, setWorkspaceEntities] = useState<WorkspaceDataEntities>(() => emptyWorkspaceDataEntities());
   const [cursor, setCursor] = useState('0');
   const [omittedCompletedBefore, setOmittedCompletedBefore] = useState<string | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');
   const [, setSyncStatus] = useState<TaskSyncStatus>('loading');
   const [hasBootstrapped, setHasBootstrapped] = useState(false);

   useEffect(() => {
      scopeRef.current = scope;
   }, [scope]);

   const applyTask = useCallback((task: TaskaraTask) => {
      setTasks((current) => upsertTask(current, task));
   }, []);

   const applyBootstrap = useCallback(
      async (
         result: BootstrapResponse,
         requestedScopeKey: string,
         runId: number,
         options: TaskSyncRefreshOptions = {}
      ): Promise<boolean> => {
         if (bootstrapRunRef.current !== runId || taskScopeKey(scopeRef.current) !== requestedScopeKey) return false;
         if (options.preserveVisibleState && compareCursor(result.cursor, cursorRef.current) < 0) return false;
         const hotTasks = pruneColdCompletedTasks(result.tasks, result.omittedCompletedBefore);
         const tasksWithPending = await applyPendingMutationsToTasks(hotTasks, clientId, requestedScopeKey);
         const milestonesWithPending = await applyPendingMutationsToMilestones(
            normalizeMilestoneResources(result.milestones),
            clientId,
            requestedScopeKey
         );
         if (bootstrapRunRef.current !== runId || taskScopeKey(scopeRef.current) !== requestedScopeKey) return false;
         if (options.preserveVisibleState && compareCursor(result.cursor, cursorRef.current) < 0) return false;
         cursorRef.current = result.cursor;
         setCursor(result.cursor);
         setOmittedCompletedBefore(result.omittedCompletedBefore || defaultOmittedCompletedBefore());
         setTasks((current) =>
            options.preserveVisibleState ? mergeBootstrappedTasks(current, tasksWithPending) : tasksWithPending
         );
         setResources({
            milestones: milestonesWithPending,
            projects: result.projects,
            teams: result.teams,
            users: result.users,
            views: result.views,
         });
         bootstrappedRef.current = true;
         setHasBootstrapped(true);
         lastBootstrappedScopeRef.current = requestedScopeKey;
         return true;
      },
      [clientId]
   );

   const applyEvents = useCallback(
      (events: SyncTaskEvent[], nextCursor: string, broadcast = true) => {
         if (scopeKey !== taskScopeKey(scopeRef.current)) return;
         if (compareCursor(nextCursor, cursorRef.current) < 0) return;
         const taskEvents = events.filter((event) => event.entityType === 'task' && (event.type === 'upsert' || event.type === 'delete' || event.type === 'removeFromScope'));
         const milestoneEvents = events.filter(
            (event): event is SyncTaskEvent & WorkspaceDataSyncEvent =>
               event.entityType === 'milestone' &&
               (event.type === 'upsert' || event.type === 'delete' || event.type === 'removeFromScope')
         );
         const workspaceEvents = events.filter(
            (event): event is SyncTaskEvent & WorkspaceDataSyncEvent =>
               event.entityType !== 'task' && event.entityType !== 'milestone'
         );
         const cursorAdvanced = compareCursor(nextCursor, cursorRef.current) > 0;

         if (!taskEvents.length && !milestoneEvents.length && !workspaceEvents.length && !cursorAdvanced) return;

         if (taskEvents.length) {
            setTasks((current) => {
               let next = current;
               for (const event of taskEvents) {
                  if (event.type === 'upsert' && event.task) {
                     if (event.clientId === clientId && event.mutationId) {
                        next = next.filter((task) => task.syncMutationId !== event.mutationId);
                     }
                     next = upsertTask(next, event.task, { preservePending: event.clientId !== clientId || !event.mutationId });
                  } else if (event.type === 'delete' || event.type === 'removeFromScope') {
                     next = next.filter((task) => task.id !== event.taskId && task.key !== event.taskKey);
                  }
               }
               return next;
            });
         }

         if (workspaceEvents.length) {
            setWorkspaceEntities((current) => applyWorkspaceSyncEvents(current, workspaceEvents));
         }

         if (milestoneEvents.length) {
            setResources((current) => ({
               ...current,
               milestones: applyMilestoneEventsWithPending(current.milestones, milestoneEvents, clientId),
            }));
         }

         advanceCursor(nextCursor, cursorRef, setCursor);

         if (broadcast) {
            broadcastSyncMessage({
               type: 'events',
               scopeKey,
               cursor: nextCursor,
               events,
            });
         }
      },
      [clientId, scopeKey]
   );

   const refresh = useCallback(async (options: TaskSyncRefreshOptions = {}) => {
      const runId = bootstrapRunRef.current + 1;
      bootstrapRunRef.current = runId;
      const requestedScope = scopeRef.current;
      const requestedScopeKey = taskScopeKey(requestedScope);
      const preserveVisibleState =
         options.preserveVisibleState ??
         (bootstrappedRef.current && lastBootstrappedScopeRef.current === requestedScopeKey);
      let restoredFromCache = false;
      if (!preserveVisibleState) setLoading(true);
      setSyncStatus(preserveVisibleState ? 'recovering' : 'loading');
      if (!preserveVisibleState) setError('');
      if (!preserveVisibleState) {
         bootstrappedRef.current = false;
         setHasBootstrapped(false);
      }
      if (!preserveVisibleState && lastBootstrappedScopeRef.current !== requestedScopeKey) {
         setTasks([]);
         setResources({ milestones: [], projects: [], teams: [], users: [], views: [] });
         setWorkspaceEntities(emptyWorkspaceDataEntities());
      }
      try {
         if (!preserveVisibleState) {
            const cached = await loadCachedBootstrap(requestedScopeKey);
            if (cached) {
               restoredFromCache = await applyBootstrap(cached, requestedScopeKey, runId, { preserveVisibleState });
               if (restoredFromCache && bootstrapRunRef.current === runId) setLoading(false);
            }
         }

         const result = await taskaraRequest<BootstrapResponse>(`/sync/bootstrap?${scopeSearch(requestedScope)}`);
         const applied = await applyBootstrap(result, requestedScopeKey, runId, { preserveVisibleState });
         if (applied) void saveCachedBootstrap(requestedScopeKey, result);
         if (bootstrapRunRef.current === runId) setSyncStatus('ready');
      } catch (err) {
         if (bootstrapRunRef.current !== runId) return;
         if (!restoredFromCache && !preserveVisibleState) {
            setError(err instanceof Error ? err.message : 'Task sync failed.');
         }
         if (restoredFromCache) {
            setSyncStatus('ready');
         } else {
            setSyncStatus(isRetryableMutationTransportError(err) ? 'offline' : 'error');
         }
      } finally {
         if (bootstrapRunRef.current === runId && !preserveVisibleState) setLoading(false);
      }
   }, [applyBootstrap]);

   const pull = useCallback(async () => {
      if (!bootstrappedRef.current || pullingRef.current) return;
      pullingRef.current = true;
      setSyncStatus('syncing');
      try {
         let hasMore = true;
         while (hasMore) {
            const query = new URLSearchParams(scopeSearchParams(scopeRef.current));
            query.set('cursor', cursorRef.current);
            const result = await taskaraRequest<PullResponse>(`/sync/pull?${query.toString()}`);
            if (compareCursor(result.cursor, cursorRef.current) < 0) return;
            if (result.resetRequired) {
               await refresh({ preserveVisibleState: true });
               return;
            }
            applyEvents(result.events, result.cursor);
            hasMore = Boolean(result.hasMore);
         }
         setSyncStatus('ready');
      } catch (err) {
         if (!bootstrappedRef.current) setError(err instanceof Error ? err.message : 'Task sync pull failed.');
         setSyncStatus(isRetryableMutationTransportError(err) ? 'offline' : 'error');
         if (isUnrecoverableSyncError(err)) void refresh({ preserveVisibleState: true });
      } finally {
         pullingRef.current = false;
      }
   }, [applyEvents, refresh]);

   useEffect(() => {
      void refresh();
   }, [refresh, scopeKey]);

   useEffect(() => {
      if (!bootstrappedRef.current || loading) return;
      void saveCachedBootstrap(scopeKey, {
         cursor,
         omittedCompletedBefore: omittedCompletedBefore || defaultOmittedCompletedBefore(),
         tasks,
         milestones: resources.milestones,
         projects: resources.projects,
         teams: resources.teams,
         users: resources.users,
         views: resources.views,
      });
   }, [cursor, loading, omittedCompletedBefore, resources.milestones, resources.projects, resources.teams, resources.users, resources.views, scopeKey, tasks]);

   useEffect(() => {
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) void refresh();
      };
      const handleAuthChanged = (event: Event) => {
         if (event instanceof StorageEvent && event.key !== authStorageKey) return;
         const previousAuthIdentity = authIdentityRef.current;
         const nextAuthIdentity = readTaskSyncAuthIdentity();
         authIdentityRef.current = nextAuthIdentity;

         if (!taskSyncAuthIdentityChanged(previousAuthIdentity, nextAuthIdentity)) {
            if (bootstrappedRef.current) void refresh({ preserveVisibleState: true });
            return;
         }

         bootstrappedRef.current = false;
         bootstrapRunRef.current += 1;
         cursorRef.current = '0';
         setCursor('0');
         setOmittedCompletedBefore(null);
         setSyncStatus('loading');
         setHasBootstrapped(false);
         setLoading(true);
         setError('');
         setTasks([]);
         setResources({ milestones: [], projects: [], teams: [], users: [], views: [] });
         setWorkspaceEntities(emptyWorkspaceDataEntities());
         setAuthRevision((revision) => revision + 1);
         void refresh();
      };
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener(authChangedEvent, handleAuthChanged);
      window.addEventListener('storage', handleAuthChanged);
      return () => {
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener(authChangedEvent, handleAuthChanged);
         window.removeEventListener('storage', handleAuthChanged);
      };
   }, [refresh]);

   useEffect(() => {
      const channel = createBroadcastChannel();
      const handleMessage = (message: Partial<TaskSyncBroadcastMessage>) => {
         if (message.scopeKey !== scopeKey || scopeKey !== taskScopeKey(scopeRef.current)) return;
         if (message.type === 'events' && message.cursor && message.events) {
            applyEvents(message.events, message.cursor, false);
            return;
         }
         if (message.type === 'localTask' && message.task) {
            setTasks((current) => {
               const withoutPending = message.mutationId
                  ? current.filter((task) => task.syncMutationId !== message.mutationId)
                  : current;
               return upsertTask(withoutPending, message.task as TaskaraTask);
            });
            return;
         }
         if (message.type === 'localTaskDeleted') {
            setTasks((current) =>
               current.filter(
                  (task) =>
                     task.id !== message.taskId &&
                     task.key !== message.taskKey &&
                     (!message.mutationId || task.syncMutationId !== message.mutationId)
               )
            );
            return;
         }
         if (message.type === 'localMilestone' && message.milestone) {
            setResources((current) => ({
               ...current,
               milestones: upsertMilestone(current.milestones, message.milestone as TaskaraMilestone),
            }));
            return;
         }
         if (message.type === 'localMilestoneDeleted' && message.milestoneId) {
            setResources((current) => ({
               ...current,
               milestones: current.milestones.filter((milestone) => milestone.id !== message.milestoneId),
            }));
         }
      };

      const handleWindowMessage = (event: Event) => {
         handleMessage((event as CustomEvent<Partial<TaskSyncBroadcastMessage>>).detail || {});
      };

      if (channel) {
         channel.onmessage = (event) => handleMessage(event.data as Partial<TaskSyncBroadcastMessage>);
      }
      window.addEventListener(windowSyncMessageEvent, handleWindowMessage);

      return () => {
         channel?.close();
         window.removeEventListener(windowSyncMessageEvent, handleWindowMessage);
      };
   }, [applyEvents, scopeKey]);

   useEffect(() => {
      if (!bootstrappedRef.current || loading) return;
      const controller = new AbortController();

      void runWithOptionalStreamLock(scopeKey, async () => {
         await consumeSyncStream(clientId, controller.signal, () => {
            void pull();
         });
      });

      return () => controller.abort();
   }, [clientId, loading, pull, scopeKey]);

   useEffect(() => {
      if (loading) return;
      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
	         void flushPendingTaskSyncMutations(clientId).then((flushResult) => {
	            if (flushResult.hadFinalFailures) void refresh({ preserveVisibleState: true });
	            else void pull();
	         });
      };
      const interval = window.setInterval(handleWake, 60000);
      window.addEventListener('online', handleWake);
      handleWake();
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('online', handleWake);
      };
   }, [clientId, loading, pull, refresh]);

   const pushMutation = useCallback(
      async (name: string, args: unknown, options: PendingMutationOptions = {}): Promise<TaskaraTask> => {
         const mutationId = options.mutationId || options.optimisticTask?.syncMutationId || crypto.randomUUID();
         const { entity, response } = await sendTaskSyncMutation<TaskaraTask>(name, args, clientId, mutationId, {
            ...options,
            keepPendingOnRetryable: true,
            scopeKey,
         });
         advanceCursor(response.cursor, cursorRef, setCursor);
         if (!entity) {
            await pull();
            throw new Error('Task mutation was acknowledged without an entity.');
         }
         dispatchWorkspaceRefresh({ source: 'task-sync-mutation' });
         return entity;
      },
      [clientId, pull, scopeKey]
   );

   const createTask = useCallback(
      async (input: TaskCreateInput): Promise<TaskaraTask> => {
         const mutationId = crypto.randomUUID();
         const tempId = `local-${mutationId}`;
         const optimistic = buildOptimisticTask(tempId, input, resources, mutationId);
         setTasks((current) => upsertTask(current, optimistic));
         broadcastLocalTask(scopeKey, optimistic);

         try {
            const milestoneDependency = input.milestoneId
               ? resources.milestones.find((milestone) => milestone.id === input.milestoneId)?.syncMutationId
               : undefined;
            const created = await pushMutation('task.create', input, {
               mutationId,
               optimisticTask: optimistic,
               dependsOnMutationIds: milestoneDependency ? [milestoneDependency] : [],
            });
            setTasks((current) => current.map((task) => (task.id === tempId ? created : task)));
            return created;
         } catch (err) {
            if (isRetryableTaskSyncError(err)) return optimistic;
            setTasks((current) => current.filter((task) => task.id !== tempId));
            broadcastLocalTaskDeleted(scopeKey, optimistic);
            throw err;
         }
      },
      [pushMutation, resources, scopeKey]
   );

   const updateTask = useCallback(
      async (task: TaskaraTask, patch: TaskUpdatePatch): Promise<TaskaraTask> => {
         const previous = task;
         if (isLocalOptimisticTask(task) && task.syncMutationId) {
            const optimistic = { ...applyOptimisticTaskPatch(task, patch, resources), syncState: 'pending' as const, syncMutationId: task.syncMutationId };
            setTasks((current) => current.map((item) => (item.id === task.id ? optimistic : item)));
            try {
               const milestoneDependency = patch.milestoneId
                  ? resources.milestones.find((milestone) => milestone.id === patch.milestoneId)?.syncMutationId
                  : undefined;
               await updatePendingCreateTaskMutation(
                  task.syncMutationId,
                  patch,
                  optimistic,
                  milestoneDependency ? [milestoneDependency] : []
               );
               broadcastLocalTask(scopeKey, optimistic);
               return optimistic;
            } catch (err) {
               setTasks((current) => current.map((item) => (item.id === task.id ? previous : item)));
               throw err;
            }
         }

         const mutationId = crypto.randomUUID();
         const optimistic = { ...applyOptimisticTaskPatch(task, patch, resources), syncState: 'pending' as const, syncMutationId: mutationId };
         setTasks((current) => current.map((item) => (item.id === task.id ? optimistic : item)));

         try {
            const milestoneDependency = patch.milestoneId
               ? resources.milestones.find((milestone) => milestone.id === patch.milestoneId)?.syncMutationId
               : undefined;
            const updated = await pushMutation(
               'task.update',
               { idOrKey: task.key || task.id, baseVersion: task.version, patch },
               {
                  mutationId,
                  optimisticTask: optimistic,
                  dependsOnMutationIds: milestoneDependency ? [milestoneDependency] : [],
               }
            );
            setTasks((current) => current.map((item) => (item.id === task.id || item.id === updated.id ? updated : item)));
            return updated;
         } catch (err) {
            if (isRetryableTaskSyncError(err)) return optimistic;
            setTasks((current) => current.map((item) => (item.id === task.id ? previous : item)));
            throw err;
         }
      },
      [pushMutation, resources, scopeKey]
   );

   const deleteTask = useCallback(
      async (task: TaskaraTask): Promise<void> => {
         setTasks((current) => current.filter((item) => item.id !== task.id));
         if (isLocalOptimisticTask(task) && task.syncMutationId) {
            try {
               await removePendingMutation(task.syncMutationId);
               broadcastLocalTaskDeleted(scopeKey, task);
               return;
            } catch (err) {
               setTasks((current) => upsertTask(current, task));
               throw err;
            }
         }

         try {
            await pushMutation('task.delete', { idOrKey: task.key || task.id }, { deletedTaskId: task.id, deletedTaskKey: task.key });
         } catch (err) {
            if (isRetryableTaskSyncError(err)) return;
            setTasks((current) => upsertTask(current, task));
            throw err;
         }
      },
      [pushMutation, scopeKey]
   );

   const pushMilestoneMutation = useCallback(
      async (
         name: string,
         args: unknown,
         optimistic: TaskaraMilestone,
         previous: TaskaraMilestone | null,
         dependencyMutationIds: string[] = []
      ): Promise<TaskaraMilestone> => {
         const mutationId = optimistic.syncMutationId || crypto.randomUUID();
         setResources((current) => ({
            ...current,
            milestones: upsertMilestone(current.milestones, optimistic),
         }));
         broadcastLocalMilestone(scopeKey, optimistic);

         try {
            const { entity, response } = await sendTaskSyncMutation<unknown>(
               name,
               args,
               clientId,
               mutationId,
               {
                  baseVersion: previous?.version,
                  dependsOnMutationIds: [
                     ...(previous?.syncMutationId ? [previous.syncMutationId] : []),
                     ...dependencyMutationIds,
                  ],
                  keepPendingOnRetryable: true,
                  optimisticMilestone: milestoneForPersistence(optimistic),
                  scopeKey,
               }
            );
            advanceCursor(response.cursor, cursorRef, setCursor);
            const confirmed = milestoneFromMutationEntity(entity) || clearMilestoneSyncState(optimistic);
            setResources((current) => ({
               ...current,
               milestones: upsertMilestone(current.milestones, confirmed),
            }));
            broadcastLocalMilestone(scopeKey, confirmed);
            dispatchWorkspaceRefresh({ source: 'milestone-sync-mutation' });
            if (!entity) void pull();
            return confirmed;
         } catch (err) {
            if (isRetryableTaskSyncError(err)) return optimistic;
            if (previous) {
               setResources((current) => ({
                  ...current,
                  milestones: upsertMilestone(current.milestones, previous),
               }));
               broadcastLocalMilestone(scopeKey, previous);
            } else {
               setResources((current) => ({
                  ...current,
                  milestones: current.milestones.filter((milestone) => milestone.id !== optimistic.id),
               }));
               broadcastLocalMilestoneDeleted(scopeKey, optimistic);
            }
            throw err;
         }
      },
      [clientId, pull, scopeKey]
   );

   const createMilestone = useCallback(
      async (input: TaskaraMilestoneCreateInput): Promise<TaskaraMilestone> => {
         const mutationId = crypto.randomUUID();
         const id = input.id || crypto.randomUUID();
         const optimistic = buildOptimisticMilestone(id, { ...input, id }, resources, mutationId);
         return pushMilestoneMutation('milestone.create', { ...input, id }, optimistic, null);
      },
      [pushMilestoneMutation, resources]
   );

   const updateMilestone = useCallback(
      async (
         milestone: TaskaraMilestone,
         patch: TaskaraMilestoneUpdatePatch
      ): Promise<TaskaraMilestone> => {
         const mutationId = crypto.randomUUID();
         const optimistic = applyOptimisticMilestonePatch(milestone, patch, resources, mutationId);
         return pushMilestoneMutation(
            'milestone.update',
            { id: milestone.id, patch: { version: milestone.version, ...patch } },
            optimistic,
            milestone
         );
      },
      [pushMilestoneMutation, resources]
   );

   const reorderMilestone = useCallback(
      async (
         milestone: TaskaraMilestone,
         reorder: TaskaraMilestoneReorderInput
      ): Promise<TaskaraMilestone> => {
         const mutationId = crypto.randomUUID();
         const optimistic = applyOptimisticMilestoneReorder(
            resources.milestones,
            milestone,
            reorder,
            mutationId
         );
         return pushMilestoneMutation(
            'milestone.reorder',
            { id: milestone.id, reorder: { version: milestone.version, ...reorder } },
            optimistic,
            milestone,
            [reorder.beforeId, reorder.afterId]
               .flatMap((id) => id ? [resources.milestones.find((item) => item.id === id)?.syncMutationId] : [])
               .filter((id): id is string => Boolean(id))
         );
      },
      [pushMilestoneMutation, resources.milestones]
   );

   const transitionMilestone = useCallback(
      async (
         milestone: TaskaraMilestone,
         action: TaskaraMilestoneLifecycleAction,
         input: TaskaraMilestoneLifecycleInput = {}
      ): Promise<TaskaraMilestone> => {
         const mutationId = crypto.randomUUID();
         const optimistic = applyOptimisticMilestoneLifecycle(milestone, action, mutationId);
         const transition = { version: milestone.version, ...input };
         const args = action === 'complete' || action === 'cancel'
            ? { id: milestone.id, completion: transition }
            : { id: milestone.id, transition };
         const targetDependency = input.targetMilestoneId
            ? resources.milestones.find((item) => item.id === input.targetMilestoneId)?.syncMutationId
            : undefined;
         return pushMilestoneMutation(
            `milestone.${action}`,
            args,
            optimistic,
            milestone,
            targetDependency ? [targetDependency] : []
         );
      },
      [pushMilestoneMutation, resources.milestones]
   );

   const workspaceData = useMemo(
      () =>
         createWorkspaceDataState(
            {
               tasks,
               milestones: resources.milestones,
               projects: resources.projects,
               teams: resources.teams,
               users: resources.users,
               views: resources.views,
            },
            workspaceEntities
         ),
      [resources.milestones, resources.projects, resources.teams, resources.users, resources.views, tasks, workspaceEntities]
   );

   return useMemo(
      () => ({
         tasks,
         milestones: resources.milestones,
         projects: resources.projects,
         teams: resources.teams,
         users: resources.users,
         views: resources.views,
         omittedCompletedBefore,
         hasBootstrapped,
         loading,
         error,
         refresh,
         applyTask,
         createTask,
         updateTask,
         deleteTask,
         createMilestone,
         updateMilestone,
         reorderMilestone,
         transitionMilestone,
         workspaceData,
      }),
      [
         applyTask,
         createTask,
         createMilestone,
         deleteTask,
         error,
         hasBootstrapped,
         loading,
         omittedCompletedBefore,
         refresh,
         reorderMilestone,
         resources.projects,
         resources.milestones,
         resources.teams,
         resources.users,
         resources.views,
         tasks,
         transitionMilestone,
         updateTask,
         updateMilestone,
         workspaceData,
      ]
   );
}

export function useTaskSyncPulse(onPulse: () => void, enabled = true) {
   const clientId = useMemo(getOrCreateTaskSyncClientId, []);
   const onPulseRef = useRef(onPulse);

   useEffect(() => {
      onPulseRef.current = onPulse;
   }, [onPulse]);

   useEffect(() => {
      if (!enabled) return;
      const controller = new AbortController();

      void runWithOptionalStreamLock('pulse', async () => {
         await consumeSyncStream(clientId, controller.signal, () => onPulseRef.current());
      });

      const handleWake = () => {
         if (document.visibilityState === 'hidden') return;
         void flushPendingTaskSyncMutations(clientId).then(() => onPulseRef.current());
      };
      window.addEventListener('online', handleWake);

      return () => {
         controller.abort();
         window.removeEventListener('online', handleWake);
      };
   }, [clientId, enabled]);
}

function upsertTask(
   tasks: TaskaraTask[],
   task: TaskaraTask,
   options: { preservePending?: boolean } = {}
): TaskaraTask[] {
   const existingIndex = tasks.findIndex(
      (item) =>
         item.id === task.id ||
         (task.syncMutationId && item.syncMutationId === task.syncMutationId) ||
         (canMatchTaskByKey(item, task) && item.key === task.key)
   );
   if (existingIndex === -1) return [task, ...tasks];
   const next = [...tasks];
   if (
      options.preservePending &&
      next[existingIndex].syncState === 'pending' &&
      next[existingIndex].syncMutationId &&
      next[existingIndex].syncMutationId !== task.syncMutationId
   ) {
      return next;
   }
   const merged = { ...next[existingIndex], ...task };
   if (!task.syncState) {
      delete merged.syncState;
      delete merged.syncMutationId;
   }
   next[existingIndex] = merged;
   return next;
}

function mergeBootstrappedTasks(current: TaskaraTask[], bootstrapped: TaskaraTask[]): TaskaraTask[] {
   if (current.length === 0) return bootstrapped;

   const bootstrappedById = new Map(bootstrapped.map((task) => [task.id, task]));
   const bootstrappedByKey = new Map(
      bootstrapped
         .filter((task) => task.key && !isLocalTaskKey(task.key))
         .map((task) => [task.key, task])
   );
   const usedIds = new Set<string>();
   const next: TaskaraTask[] = [];

   for (const task of current) {
      const replacement = bootstrappedById.get(task.id) || (task.key ? bootstrappedByKey.get(task.key) : undefined);
      if (!replacement) {
         if (task.syncState === 'pending') next.push(task);
         continue;
      }
      next.push(replacement);
      usedIds.add(replacement.id);
   }

   for (const task of bootstrapped) {
      if (!usedIds.has(task.id)) next.push(task);
   }

   return next;
}

export function replayPendingTaskMutationsForBootstrap(
   tasks: TaskaraTask[],
   pending: PersistedTaskMutation[]
): TaskaraTask[] {
   let next = tasks;
   for (const mutation of orderPersistedTaskMutations(pending)) {
      if (mutation.deletedTaskId || mutation.deletedTaskKey) {
         next = next.filter((task) => task.id !== mutation.deletedTaskId && task.key !== mutation.deletedTaskKey);
         continue;
      }

      if (mutation.optimisticTask) {
         next = upsertTask(next, mutation.optimisticTask);
      }
   }
   return next;
}

export function reconcileBootstrappedTasksAfterSyncGap(
   current: TaskaraTask[],
   bootstrapped: TaskaraTask[],
   pending: PersistedTaskMutation[]
): TaskaraTask[] {
   return mergeBootstrappedTasks(current, replayPendingTaskMutationsForBootstrap(bootstrapped, pending));
}

export function orderPersistedTaskMutations(
   mutations: PersistedTaskMutation[]
): PersistedTaskMutation[] {
   const chronological = [...mutations].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId)
   );
   const byId = new Map(chronological.map((mutation) => [mutation.mutationId, mutation]));
   const visiting = new Set<string>();
   const visited = new Set<string>();
   const ordered: PersistedTaskMutation[] = [];

   const visit = (mutation: PersistedTaskMutation) => {
      if (visited.has(mutation.mutationId)) return;
      if (visiting.has(mutation.mutationId)) return;
      visiting.add(mutation.mutationId);
      for (const dependencyId of mutation.dependsOnMutationIds || []) {
         const dependency = byId.get(dependencyId);
         if (dependency) visit(dependency);
      }
      visiting.delete(mutation.mutationId);
      visited.add(mutation.mutationId);
      ordered.push(mutation);
   };

   for (const mutation of chronological) visit(mutation);
   return ordered;
}

export function replayPendingMilestoneMutationsForBootstrap(
   milestones: TaskaraMilestone[],
   pending: PersistedTaskMutation[]
): TaskaraMilestone[] {
   let next = milestones;
   for (const mutation of orderPersistedTaskMutations(pending)) {
      if (mutation.optimisticMilestone) {
         next = upsertMilestone(next, mutation.optimisticMilestone);
      }
   }
   return next;
}

export function reconcileBootstrappedMilestonesAfterSyncGap(
   current: TaskaraMilestone[],
   bootstrapped: TaskaraMilestone[],
   pending: PersistedTaskMutation[]
): TaskaraMilestone[] {
   const replayed = replayPendingMilestoneMutationsForBootstrap(bootstrapped, pending);
   if (current.length === 0) return replayed;
   const pendingIds = new Set(
      pending.flatMap((mutation) => mutation.optimisticMilestone ? [mutation.optimisticMilestone.id] : [])
   );
   const replayedIds = new Set(replayed.map((milestone) => milestone.id));
   return [
      ...current.filter((milestone) => pendingIds.has(milestone.id) && !replayedIds.has(milestone.id)),
      ...replayed,
   ];
}

function canMatchTaskByKey(left: TaskaraTask, right: TaskaraTask): boolean {
   return Boolean(left.key && right.key && !isLocalTaskKey(left.key) && !isLocalTaskKey(right.key));
}

function isLocalTaskKey(key: string): boolean {
   return key === 'NEW' || key.startsWith('NEW-');
}

function isLocalOptimisticTask(task: TaskaraTask): boolean {
   return task.syncState === 'pending' && Boolean(task.syncMutationId) && (task.id.startsWith('local-') || isLocalTaskKey(task.key));
}

async function applyPendingMutationsToTasks(
   tasks: TaskaraTask[],
   clientId: string,
   scopeKey: string
): Promise<TaskaraTask[]> {
   const pending = (await loadPendingMutations())
      .filter((mutation) =>
         mutation.clientId === clientId &&
         mutation.scopeKey === scopeKey &&
         mutationBelongsToCurrentAuth(mutation)
      );
   return replayPendingTaskMutationsForBootstrap(tasks, pending);
}

async function applyPendingMutationsToMilestones(
   milestones: TaskaraMilestone[],
   clientId: string,
   scopeKey: string
): Promise<TaskaraMilestone[]> {
   const pending = (await loadPendingMutations())
      .filter((mutation) =>
         mutation.clientId === clientId &&
         mutation.scopeKey === scopeKey &&
         mutationBelongsToCurrentAuth(mutation)
      );
   return replayPendingMilestoneMutationsForBootstrap(milestones, pending);
}

function upsertMilestone(milestones: TaskaraMilestone[], milestone: TaskaraMilestone): TaskaraMilestone[] {
   const index = milestones.findIndex((item) => item.id === milestone.id);
   if (index === -1) return [milestone, ...milestones];
   const next = [...milestones];
   next[index] = milestone;
   return next;
}

function clearMilestoneSyncState(milestone: TaskaraMilestone): TaskaraMilestone {
   const confirmed = { ...milestone };
   delete confirmed.syncState;
   delete confirmed.syncMutationId;
   return confirmed;
}

function milestoneForPersistence(milestone: TaskaraMilestone): TaskaraMilestone {
   const persisted = { ...milestone };
   delete persisted.activity;
   delete persisted.tasks;
   return persisted;
}

export function applyMilestoneEventsWithPending(
   milestones: TaskaraMilestone[],
   events: Array<WorkspaceDataSyncEvent & Pick<SyncTaskEvent, 'clientId' | 'mutationId'>>,
   clientId: string
): TaskaraMilestone[] {
   let next = milestones;
   for (const event of events) {
      const incoming = milestoneFromSyncEvent(event);
      const id = event.entityId || incoming?.id;
      const existing = id ? next.find((milestone) => milestone.id === id) : undefined;
      if (existing?.syncState === 'pending') {
         const acknowledgesLatest = Boolean(
            event.clientId === clientId &&
            event.mutationId &&
            event.mutationId === existing.syncMutationId
         );
         if (!acknowledgesLatest) continue;
      }
      next = applyMilestoneSyncEvents(next, [event]);
      if (id && event.clientId === clientId && event.mutationId) {
         next = next.map((milestone) =>
            milestone.id === id && milestone.syncMutationId === event.mutationId
               ? clearMilestoneSyncState(milestone)
               : milestone
         );
      }
   }
   return next;
}

function milestoneFromSyncEvent(event: WorkspaceDataSyncEvent): TaskaraMilestone | null {
   const direct = milestoneFromMutationEntity(event.entity);
   if (direct) return direct;
   if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
   return milestoneFromMutationEntity((event.payload as { after?: unknown }).after);
}

export function buildOptimisticTask(
   id: string,
   input: TaskCreateInput,
   resources: TaskSyncResources,
   syncMutationId: string
): TaskaraTask {
   const now = new Date().toISOString();
   const project = resources.projects.find((item) => item.id === input.projectId) || null;
   const assignee = input.assigneeId ? resources.users.find((item) => item.id === input.assigneeId) || null : null;
   const milestone = input.milestoneId
      ? resources.milestones.find((item) => item.id === input.milestoneId && item.projectId === input.projectId) || null
      : null;

   return {
      id,
      key: optimisticTaskKey(syncMutationId),
      title: input.title,
      description: input.description || null,
      status: input.status,
      priority: input.priority,
      weight: input.weight ?? null,
      dueAt: input.dueAt || null,
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === 'DONE' ? now : null,
      progressStartedAt: progressTaskStatuses.has(input.status) ? now : null,
      version: 0,
      syncState: 'pending',
      syncMutationId,
      project: project
         ? {
              id: project.id,
              name: project.name,
              keyPrefix: project.keyPrefix,
              team: project.team || null,
           }
         : null,
      milestoneId: milestone?.id || null,
      milestone: milestone
         ? {
              id: milestone.id,
              name: milestone.name,
              kind: milestone.kind,
              status: milestone.status,
              archivedAt: milestone.archivedAt,
              projectId: milestone.projectId,
           }
         : null,
      assignee: assignee
         ? {
              id: assignee.id,
              name: assignee.name,
              email: assignee.email,
              phone: assignee.phone,
              avatarUrl: assignee.avatarUrl,
           }
         : null,
      labels: input.labels.map((name) => ({ label: { id: `local-${name}`, name } })),
      _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
   };
}

export function buildOptimisticMilestone(
   id: string,
   input: TaskaraMilestoneCreateInput,
   resources: TaskSyncResources,
   syncMutationId: string
): TaskaraMilestone {
   const now = new Date().toISOString();
   const project = resources.projects.find((item) => item.id === input.projectId);
   if (!project) throw new TaskSyncMutationError('Project is not available in the local workspace cache.', false);
   const owner = input.ownerId ? resources.users.find((item) => item.id === input.ownerId) || null : null;
   const projectMilestones = resources.milestones.filter((milestone) => milestone.projectId === input.projectId);
   const position = projectMilestones.reduce((maximum, milestone) => Math.max(maximum, milestone.position), 0) + 1024;

   const milestone: TaskaraMilestone = {
      id,
      workspaceId: resources.milestones[0]?.workspaceId || 'local',
      projectId: input.projectId,
      ownerId: input.ownerId || null,
      name: input.name,
      description: input.description || null,
      kind: input.kind,
      status: input.status,
      health: input.health || null,
      startsOn: input.startsOn || null,
      targetOn: input.targetOn || null,
      position,
      version: 1,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      project: {
         id: project.id,
         name: project.name,
         keyPrefix: project.keyPrefix,
         teamId: project.team?.id || null,
         leadId: project.lead?.id || null,
         team: project.team || null,
         lead: project.lead || null,
      },
      owner: owner
         ? {
              id: owner.id,
              name: owner.name,
              email: owner.email,
              avatarUrl: owner.avatarUrl,
           }
         : null,
      progress: emptyMilestoneProgress(),
      attentionReasons: [],
      readyToComplete: false,
      canManage: true,
      syncState: 'pending',
      syncMutationId,
   };
   milestone.attentionReasons = deriveOptimisticMilestoneAttention(milestone);
   return milestone;
}

export function applyOptimisticMilestonePatch(
   milestone: TaskaraMilestone,
   patch: TaskaraMilestoneUpdatePatch,
   resources: TaskSyncResources,
   syncMutationId: string
): TaskaraMilestone {
   const next: TaskaraMilestone = {
      ...milestone,
      ...patch,
      version: milestone.version + 1,
      updatedAt: new Date().toISOString(),
      syncState: 'pending',
      syncMutationId,
   };
   if (Object.prototype.hasOwnProperty.call(patch, 'ownerId')) {
      const owner = patch.ownerId ? resources.users.find((item) => item.id === patch.ownerId) || null : null;
      next.owner = owner
         ? { id: owner.id, name: owner.name, email: owner.email, avatarUrl: owner.avatarUrl }
         : null;
   }
   next.attentionReasons = deriveOptimisticMilestoneAttention(next);
   return next;
}

export function applyOptimisticMilestoneReorder(
   milestones: TaskaraMilestone[],
   milestone: TaskaraMilestone,
   reorder: TaskaraMilestoneReorderInput,
   syncMutationId: string
): TaskaraMilestone {
   const before = reorder.beforeId ? milestones.find((item) => item.id === reorder.beforeId) : null;
   const after = reorder.afterId ? milestones.find((item) => item.id === reorder.afterId) : null;
   let position = milestone.position;
   if (before && after) position = (before.position + after.position) / 2;
   else if (before) position = before.position + 1024;
   else if (after) position = after.position - 1024;
   return {
      ...milestone,
      position,
      version: milestone.version + 1,
      updatedAt: new Date().toISOString(),
      syncState: 'pending',
      syncMutationId,
   };
}

export function applyOptimisticMilestoneLifecycle(
   milestone: TaskaraMilestone,
   action: TaskaraMilestoneLifecycleAction,
   syncMutationId: string
): TaskaraMilestone {
   const now = new Date().toISOString();
   const next: TaskaraMilestone = {
      ...milestone,
      version: milestone.version + 1,
      updatedAt: now,
      syncState: 'pending',
      syncMutationId,
   };
   if (action === 'activate' || action === 'reopen') {
      next.status = 'ACTIVE';
      next.completedAt = null;
      next.canceledAt = null;
   } else if (action === 'complete') {
      next.status = 'COMPLETED';
      next.completedAt = now;
      next.canceledAt = null;
   } else if (action === 'cancel') {
      next.status = 'CANCELED';
      next.completedAt = null;
      next.canceledAt = now;
   } else if (action === 'archive') {
      next.archivedAt = now;
   } else if (action === 'restore') {
      next.archivedAt = null;
   }
   next.attentionReasons = deriveOptimisticMilestoneAttention(next);
   return next;
}

function deriveOptimisticMilestoneAttention(
   milestone: TaskaraMilestone
): TaskaraMilestoneAttention[] {
   const reasons = (milestone.attentionReasons || []).map((reason) =>
      typeof reason === 'string' ? { reason } : reason
   ).filter(
      (reason) => !['target_overdue', 'owner_missing', 'target_missing'].includes(reason.reason)
   );
   const today = new Date().toISOString().slice(0, 10);
   if (
      milestone.status !== 'COMPLETED'
      && milestone.status !== 'CANCELED'
      && milestone.targetOn
      && milestone.targetOn < today
   ) {
      reasons.push({ reason: 'target_overdue' });
   }
   if (!milestone.ownerId) reasons.push({ reason: 'owner_missing' });
   if (!milestone.targetOn) reasons.push({ reason: 'target_missing' });
   return reasons;
}

function emptyMilestoneProgress(): TaskaraMilestone['progress'] {
   return {
      totalTasks: 0,
      eligibleTasks: 0,
      completedTasks: 0,
      canceledTasks: 0,
      blockedTasks: 0,
      overdueTasks: 0,
      totalWeight: 0,
      completedWeight: 0,
      percentage: null,
   };
}

function optimisticTaskKey(syncMutationId: string): string {
   return `NEW-${syncMutationId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function applyOptimisticTaskPatch(
   task: TaskaraTask,
   patch: TaskUpdatePatch,
   resources: TaskSyncResources
): TaskaraTask {
   const {
      assigneeId: _assigneeId,
      milestoneId: _milestoneId,
      projectId: _projectId,
      labels: _labels,
      ...scalarPatch
   } = patch;
   const now = new Date().toISOString();
   const next: TaskaraTask = { ...task, ...scalarPatch, updatedAt: now };

   if ('assigneeId' in patch) {
      const assignee = patch.assigneeId ? resources.users.find((user) => user.id === patch.assigneeId) || null : null;
      next.assignee = assignee
         ? {
              id: assignee.id,
              name: assignee.name,
              email: assignee.email,
              phone: assignee.phone,
              avatarUrl: assignee.avatarUrl,
           }
         : null;
      delete (next as TaskaraTask & { assigneeId?: string | null }).assigneeId;
   }

   if ('projectId' in patch) {
      const project = patch.projectId ? resources.projects.find((item) => item.id === patch.projectId) || null : null;
      next.project = project
         ? {
              id: project.id,
              name: project.name,
              keyPrefix: project.keyPrefix,
              team: project.team || null,
           }
         : null;
      delete (next as TaskaraTask & { projectId?: string | null }).projectId;
   }

   const nextProjectId = next.project?.id || null;
   if ('milestoneId' in patch) {
      const resourceMilestone = patch.milestoneId
         ? resources.milestones.find(
              (item) => item.id === patch.milestoneId && (!nextProjectId || item.projectId === nextProjectId)
           ) || null
         : null;
      const currentMilestone =
         patch.milestoneId && task.milestone?.id === patch.milestoneId &&
         (!nextProjectId || !task.milestone.projectId || task.milestone.projectId === nextProjectId)
            ? task.milestone
            : null;
      next.milestoneId = resourceMilestone?.id || currentMilestone?.id || null;
      next.milestone = resourceMilestone
         ? {
              id: resourceMilestone.id,
              name: resourceMilestone.name,
              kind: resourceMilestone.kind,
              status: resourceMilestone.status,
              archivedAt: resourceMilestone.archivedAt,
              projectId: resourceMilestone.projectId,
           }
         : currentMilestone;
   } else if (
      'projectId' in patch &&
      task.project?.id !== nextProjectId &&
      task.milestone &&
      task.milestone.projectId !== nextProjectId
   ) {
      next.milestoneId = null;
      next.milestone = null;
   }

   if (patch.labels) {
      next.labels = patch.labels.map((name) => ({ label: { id: `local-${name}`, name } }));
   }

   if (patch.status) {
      next.completedAt = patch.status === 'DONE' ? now : null;
      next.progressStartedAt = progressTaskStatuses.has(patch.status)
         ? progressTaskStatuses.has(task.status)
            ? task.progressStartedAt || task.updatedAt || now
            : now
         : null;
   }

   return next;
}

async function updatePendingCreateTaskMutation(
   mutationId: string,
   patch: TaskUpdatePatch,
   optimisticTask: TaskaraTask,
   dependsOnMutationIds: string[] = []
): Promise<void> {
   const mutation = (await loadPendingMutations()).find((item) => item.mutationId === mutationId);
   if (!mutation || mutation.name !== 'task.create' || !isTaskCreateInput(mutation.args)) {
      throw new TaskSyncMutationError('Pending issue create could not be updated.', false);
   }

   await persistPendingMutation({
      ...mutation,
      args: mergeTaskCreateInput(mutation.args, patch),
      dependsOnMutationIds: normalizedMutationDependencies([
         ...(mutation.dependsOnMutationIds || []),
         ...dependsOnMutationIds,
      ], mutation.mutationId),
      optimisticTask,
   });
}

function mergeTaskCreateInput(input: TaskCreateInput, patch: TaskUpdatePatch): TaskCreateInput {
   const next: TaskCreateInput = { ...input };
   if (patch.title !== undefined) next.title = patch.title;
   if (patch.status !== undefined) next.status = patch.status;
   if (patch.priority !== undefined) next.priority = patch.priority;
   if (patch.weight !== undefined) next.weight = patch.weight;
   if (patch.projectId) next.projectId = patch.projectId;
   if (patch.projectId !== undefined && patch.projectId !== input.projectId && patch.milestoneId === undefined) {
      delete next.milestoneId;
   }
   if (patch.labels !== undefined) next.labels = patch.labels;

   if (patch.description !== undefined) {
      if (patch.description === null) delete next.description;
      else next.description = patch.description;
   }

   if (patch.assigneeId !== undefined) {
      if (patch.assigneeId) next.assigneeId = patch.assigneeId;
      else delete next.assigneeId;
   }

   if (patch.milestoneId !== undefined) {
      if (patch.milestoneId) next.milestoneId = patch.milestoneId;
      else delete next.milestoneId;
   }

   if (patch.dueAt !== undefined) {
      if (patch.dueAt) next.dueAt = patch.dueAt;
      else delete next.dueAt;
   }

   return next;
}

function isTaskCreateInput(value: unknown): value is TaskCreateInput {
   if (!value || typeof value !== 'object') return false;
   const input = value as Partial<TaskCreateInput>;
   return (
      typeof input.projectId === 'string' &&
      typeof input.title === 'string' &&
      typeof input.status === 'string' &&
      typeof input.priority === 'string' &&
      (input.weight === undefined ||
         input.weight === null ||
         (typeof input.weight === 'number' &&
            Number.isInteger(input.weight) &&
            Number.isFinite(input.weight) &&
            [1, 2, 3, 4, 8].includes(input.weight))) &&
      Array.isArray(input.labels) &&
      input.source === 'WEB'
   );
}

async function consumeSyncStream(clientId: string, signal: AbortSignal, onSync: () => void): Promise<void> {
   while (!signal.aborted) {
      try {
         const query = new URLSearchParams({ clientId });
         const response = await fetch(`${taskaraApiBaseUrl()}/sync/stream?${query.toString()}`, {
            headers: taskaraRequestHeaders(),
            signal,
         });
         if (response.status === 401) clearAuthSession();
         if (!response.ok || !response.body) throw new Error('Task sync stream failed.');
         await readSse(response, signal, (event) => {
            if (event.event === 'sync') onSync();
         });
      } catch {
         if (signal.aborted) return;
         await delay(1500, signal);
      }
   }
}

async function readSse(
   response: Response,
   signal: AbortSignal,
   onEvent: (event: { event: string; data: string; id?: string }) => void
): Promise<void> {
   const reader = response.body?.getReader();
   if (!reader) return;

   const decoder = new TextDecoder();
   let buffer = '';
   while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
         const rawEvent = buffer.slice(0, boundary);
         buffer = buffer.slice(boundary + 2);
         const event = parseSseEvent(rawEvent);
         if (event) onEvent(event);
         boundary = buffer.indexOf('\n\n');
      }
   }
}

function parseSseEvent(raw: string): { event: string; data: string; id?: string } | null {
   let event = 'message';
   let data = '';
   let id: string | undefined;

   for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) data += line.slice('data:'.length).trim();
      if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
   }

   return data || event !== 'message' ? { event, data, id } : null;
}

async function runWithOptionalStreamLock(scopeKey: string, task: () => Promise<void>): Promise<void> {
   const locks = (navigator as Navigator & {
      locks?: {
         request: (
            name: string,
            options: { mode: 'exclusive'; ifAvailable: true },
            callback: (lock: unknown | null) => Promise<void>
         ) => Promise<void>;
      };
   }).locks;

   if (!locks) {
      await task();
      return;
   }

   await locks.request(`taskara-sync-stream:${scopeKey}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await task();
   });
}

function scopeSearch(scope: TaskSyncScope): string {
   return scopeSearchParams(scope).toString();
}

function taskScopeKey(scope: TaskSyncScope): string {
   const identity = readTaskSyncAuthIdentity();
   return taskSyncScopeKeyForIdentity(scope, identity);
}

export function taskSyncScopeKeyForIdentity(
   scope: TaskSyncScope,
   identity: Pick<TaskSyncAuthIdentity, 'userId' | 'workspaceSlug'>
): string {
   const workspaceSlug = scope.workspaceSlug || identity.workspaceSlug || currentWorkspaceSlug();
   return `${workspaceSlug}:${identity.userId || 'anonymous'}:${scope.teamId}:${scope.mine ? 'mine' : 'all'}`;
}

function scopeSearchParams(scope: TaskSyncScope): URLSearchParams {
   const query = new URLSearchParams({ scope: 'tasks', teamId: scope.teamId });
   if (scope.mine) query.set('mine', 'true');
   return query;
}

function currentWorkspaceSlug(): string {
   if (typeof window === 'undefined') return '';
   return window.location.pathname.split('/').filter(Boolean)[0] || '';
}

function readTaskSyncAuthIdentity(): TaskSyncAuthIdentity {
   const session = getAuthSession();
   return {
      token: session?.token || null,
      userId: session?.user.id || null,
      workspaceSlug: session?.workspace?.slug || currentWorkspaceSlug() || null,
   };
}

function taskSyncAuthIdentityChanged(
   previous: TaskSyncAuthIdentity,
   next: TaskSyncAuthIdentity
): boolean {
   return (
      previous.token !== next.token ||
      previous.userId !== next.userId ||
      previous.workspaceSlug !== next.workspaceSlug
   );
}

function currentTaskSyncAuthIdentityKey(): string | null {
   const identity = readTaskSyncAuthIdentity();
   if (!identity.workspaceSlug || !identity.userId) return null;
   return `${identity.workspaceSlug}:${identity.userId}`;
}

function mutationBelongsToCurrentAuth(mutation: PersistedTaskMutation): boolean {
   const identityKey = currentTaskSyncAuthIdentityKey();
   return Boolean(identityKey && mutationBelongsToAuthIdentity(mutation, identityKey));
}

export function mutationBelongsToAuthIdentity(
   mutation: PersistedTaskMutation,
   identityKey: string
): boolean {
   return mutation.authIdentityKey === identityKey;
}

function compareCursor(a: string, b: string): number {
   const left = BigInt(a || '0');
   const right = BigInt(b || '0');
   if (left < right) return -1;
   if (left > right) return 1;
   return 0;
}

function advanceCursor(
   nextCursor: string,
   cursorRef: { current: string },
   setCursor: (cursor: string) => void
): void {
   if (compareCursor(nextCursor, cursorRef.current) < 0) return;
   cursorRef.current = nextCursor;
   setCursor(nextCursor);
}

function isUnrecoverableSyncError(error: unknown): boolean {
   if (error instanceof TaskaraClientError) return error.status === 400 || error.status === 409 || error.status === 410;
   return error instanceof SyntaxError;
}

export function isRetryableTaskSyncError(error: unknown): boolean {
   return error instanceof TaskSyncMutationError && error.retryable;
}

export async function loadPendingTaskSyncMutations(clientId = getOrCreateTaskSyncClientId()): Promise<PersistedTaskMutation[]> {
   return orderPersistedTaskMutations(
      (await loadPendingMutations()).filter((mutation) => mutation.clientId === clientId)
         .filter(mutationBelongsToCurrentAuth)
   );
}

export function taskSyncMutationActionLabel(name: string): string {
   return taskSyncMutationActionLabels[name] || 'این تغییر';
}

export function taskSyncMutationUserMessage(input: {
   code?: string;
   name: string;
   retryable?: boolean;
   status?: 'rejected' | 'conflict';
}): string {
   const action = taskSyncMutationActionLabel(input.name);
   if (input.retryable || input.code === 'mutation_pending') return fa.sync.mutationPending(action);
   if (input.status === 'conflict' || input.code === 'mutation_conflict') return fa.sync.mutationConflict(action);
   if (input.code === 'validation_failed' || input.code === 'invalid_payload') return fa.sync.mutationValidationFailed(action);
   return fa.sync.mutationRejected(action);
}

function isRetryableMutationTransportError(error: unknown): boolean {
   if (error instanceof TaskSyncMutationError) return error.retryable;
   if (error instanceof TaskaraClientError) return !error.status || error.status >= 500;
   return true;
}

function taskSyncMutationFailureFromResult(
   mutation: PersistedTaskMutation,
   result?: PushMutationResult
): TaskSyncMutationFailure {
   const status = result?.status === 'conflict' ? 'conflict' : 'rejected';
   const code = result?.error?.code || (status === 'conflict' ? 'mutation_conflict' : 'mutation_rejected');
   const retryable = Boolean(result?.error?.retryable);
   return {
      mutationId: mutation.mutationId,
      name: mutation.name,
      status,
      code,
      retryable,
      userMessage: taskSyncMutationUserMessage({ code, name: mutation.name, retryable, status }),
      serverMessage: result?.error?.message,
   };
}

function taskSyncMutationFailureFromError(
   mutation: PersistedTaskMutation,
   error: unknown
): TaskSyncMutationFailure {
   if (error instanceof TaskSyncMutationError && error.failure) return error.failure;
   const status = error instanceof TaskaraClientError && error.status === 409 ? 'conflict' : 'rejected';
   const code = status === 'conflict' ? 'mutation_conflict' : 'mutation_failed';
   const serverMessage = error instanceof Error ? error.message : undefined;
   return {
      mutationId: mutation.mutationId,
      name: mutation.name,
      status,
      code,
      retryable: false,
      userMessage: taskSyncMutationUserMessage({ code, name: mutation.name, retryable: false, status }),
      serverMessage,
   };
}

function publishTaskSyncMutationFailures(failures: TaskSyncMutationFailure[]): void {
   if (typeof window === 'undefined' || failures.length === 0) return;
   window.dispatchEvent(
      new CustomEvent<TaskSyncMutationFailureEventDetail>(taskSyncMutationFailuresEvent, {
         detail: { failures },
      })
   );
}

function nextMutationCreatedAt(): string {
   const now = Date.now();
   lastMutationCreatedAtMs = Math.max(now, lastMutationCreatedAtMs + 1);
   return new Date(lastMutationCreatedAtMs).toISOString();
}

function normalizedMutationDependencies(
   dependencyIds: string[] | undefined,
   mutationId: string
): string[] | undefined {
   const normalized = [...new Set((dependencyIds || []).filter((id) => id && id !== mutationId))];
   return normalized.length ? normalized : undefined;
}

export async function sendTaskSyncMutation<T>(
   name: string,
   args: unknown,
   clientId = getOrCreateTaskSyncClientId(),
   mutationId: string = crypto.randomUUID(),
   options: PendingMutationOptions = {}
) {
   const mutation: PersistedTaskMutation = {
      clientId,
      mutationId,
      authIdentityKey: currentTaskSyncAuthIdentityKey() || undefined,
      name,
      args,
      createdAt: nextMutationCreatedAt(),
      dependsOnMutationIds: normalizedMutationDependencies(options.dependsOnMutationIds, mutationId),
      scopeKey: options.scopeKey,
      baseVersion: options.baseVersion,
      optimisticTask: options.optimisticTask,
      optimisticMilestone: options.optimisticMilestone,
      deletedTaskId: options.deletedTaskId,
      deletedTaskKey: options.deletedTaskKey,
   };
   await persistPendingMutation(mutation);

   try {
      if (options.keepPendingOnRetryable && typeof navigator !== 'undefined' && navigator.onLine === false) {
         throw new TaskSyncMutationError(fa.sync.mutationQueued, true);
      }
      const response = await sendPersistedMutation(mutation);
      const result = response.results[0];
      if (!result || result.status === 'rejected' || result.status === 'conflict') {
         const failure = taskSyncMutationFailureFromResult(mutation, result);
         if (!failure.retryable) await removePendingMutation(mutationId);
         throw new TaskSyncMutationError(failure.userMessage, failure.retryable, failure);
      }

      await removePendingMutation(mutationId);
      return {
         response,
         result,
         entity: result.entity as T | undefined,
      };
   } catch (err) {
      const retryable = isRetryableMutationTransportError(err);
      if (!retryable || !options.keepPendingOnRetryable) {
         await removePendingMutation(mutationId);
      }
      if (err instanceof TaskSyncMutationError) throw err;
      if (!retryable) {
         const failure = taskSyncMutationFailureFromError(mutation, err);
         throw new TaskSyncMutationError(failure.userMessage, false, failure);
      }
      if (err instanceof Error) throw new TaskSyncMutationError(fa.sync.mutationQueued, true);
      throw err;
   }
}

export async function flushPendingTaskSyncMutations(clientId = getOrCreateTaskSyncClientId()): Promise<TaskSyncMutationFlushResult> {
   let hadAppliedMutations = false;
   const failures: TaskSyncMutationFailure[] = [];
   await runWithOptionalMutationLock(async () => {
      const pending = orderPersistedTaskMutations(
         (await loadPendingMutations()).filter((mutation) => mutation.clientId === clientId)
            .filter(mutationBelongsToCurrentAuth)
      );
      for (const mutation of pending) {
         try {
            const response = await sendPersistedMutation(mutation);
            const result = response.results[0];
            if (!result || result.status === 'applied' || result.status === 'duplicate') {
               if (
                  result?.status === 'applied' &&
                  mutation.name !== 'task.delete' &&
                  mutation.scopeKey &&
                  isTaskaraTaskEntity(result.entity)
               ) {
                  publishTaskSyncMessage({
                     type: 'localTask',
                     scopeKey: mutation.scopeKey,
                     task: result.entity,
                     mutationId: mutation.mutationId,
                  });
               }
               await removePendingMutation(mutation.mutationId);
               hadAppliedMutations = true;
               continue;
            }
            if (result.error?.retryable) return;
            failures.push(taskSyncMutationFailureFromResult(mutation, result));
            await removePendingMutation(mutation.mutationId);
         } catch (err) {
            if (!isRetryableMutationTransportError(err)) {
               failures.push(taskSyncMutationFailureFromError(mutation, err));
               await removePendingMutation(mutation.mutationId);
               continue;
            }
            return;
         }
      }
   });
   if (failures.length) publishTaskSyncMutationFailures(failures);
   if (hadAppliedMutations) dispatchWorkspaceRefresh({ source: 'task-sync-mutation:flush' });
   return {
      failures,
      hadAppliedMutations,
      hadFinalFailures: failures.length > 0,
   };
}

export function getOrCreateTaskSyncClientId(): string {
   if (typeof window === 'undefined') return crypto.randomUUID();
   const existing = window.localStorage.getItem(clientIdStorageKey);
   if (existing) return existing;
   const next = crypto.randomUUID();
   window.localStorage.setItem(clientIdStorageKey, next);
   return next;
}

function createBroadcastChannel(): BroadcastChannel | null {
   if (typeof BroadcastChannel === 'undefined') return null;
   return new BroadcastChannel(broadcastName);
}

async function sendPersistedMutation(mutation: PersistedTaskMutation): Promise<PushResponse> {
   return taskaraRequest<PushResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
         clientId: mutation.clientId,
         mutations: [
            {
               mutationId: mutation.mutationId,
               name: mutation.name,
               args: mutation.args,
               baseVersion: mutation.baseVersion,
               createdAt: mutation.createdAt,
            },
         ],
      }),
   });
}

async function loadPendingMutations(): Promise<PersistedTaskMutation[]> {
   if (typeof window === 'undefined') return [];
   const db = await openTaskSyncDb();
   if (db) {
      try {
         return (await idbGetAll<unknown>(db, pendingMutationsStore)).filter(isPersistedTaskMutation);
      } catch {
         // Fall back to localStorage below.
      } finally {
         db.close();
      }
   }
   return loadPendingMutationsFallback();
}

function loadPendingMutationsFallback(): PersistedTaskMutation[] {
   try {
      const raw = window.localStorage.getItem(pendingMutationsStorageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isPersistedTaskMutation) : [];
   } catch {
      return [];
   }
}

function savePendingMutationsFallback(mutations: PersistedTaskMutation[]): void {
   if (typeof window === 'undefined') return;
   window.localStorage.setItem(pendingMutationsStorageKey, JSON.stringify(mutations.slice(-100)));
}

async function persistPendingMutation(mutation: PersistedTaskMutation): Promise<void> {
   const db = await openTaskSyncDb();
   if (db) {
      try {
         await idbPut(db, pendingMutationsStore, mutation);
         return;
      } catch {
         // Fall back to localStorage below.
      } finally {
         db.close();
      }
   }

   const current = loadPendingMutationsFallback().filter((item) => item.mutationId !== mutation.mutationId);
   savePendingMutationsFallback([...current, mutation]);
}

async function removePendingMutation(mutationId: string): Promise<void> {
   const db = await openTaskSyncDb();
   if (db) {
      try {
         await idbDelete(db, pendingMutationsStore, mutationId);
         return;
      } catch {
         // Fall back to localStorage below.
      } finally {
         db.close();
      }
   }

   savePendingMutationsFallback(loadPendingMutationsFallback().filter((mutation) => mutation.mutationId !== mutationId));
}

async function loadCachedBootstrap(scopeKey: string): Promise<BootstrapResponse | null> {
   if (typeof window === 'undefined') return null;
   const db = await openTaskSyncDb();
   if (db) {
      try {
         const snapshot = await idbGet<CachedScopeSnapshot>(db, scopeSnapshotsStore, scopeKey);
         if (isCachedScopeSnapshot(snapshot)) return bootstrapFromSnapshot(snapshot);
      } catch {
         // Fall back to localStorage below.
      } finally {
         db.close();
      }
   }

   return loadCachedBootstrapFallback(scopeKey);
}

async function saveCachedBootstrap(scopeKey: string, response: BootstrapResponse): Promise<void> {
   if (typeof window === 'undefined') return;
   const snapshot: CachedScopeSnapshot = {
      ...response,
      scopeKey,
      savedAt: new Date().toISOString(),
   };
   const db = await openTaskSyncDb();
   if (db) {
      try {
         await idbPut(db, scopeSnapshotsStore, snapshot);
         return;
      } catch {
         // Fall back to localStorage below.
      } finally {
         db.close();
      }
   }

   saveCachedBootstrapFallback(snapshot);
}

function loadCachedBootstrapFallback(scopeKey: string): BootstrapResponse | null {
   try {
      const raw = window.localStorage.getItem(`${scopeSnapshotStoragePrefix}${scopeKey}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return isCachedScopeSnapshot(parsed) ? bootstrapFromSnapshot(parsed) : null;
   } catch {
      return null;
   }
}

function saveCachedBootstrapFallback(snapshot: CachedScopeSnapshot): void {
   try {
      window.localStorage.setItem(`${scopeSnapshotStoragePrefix}${snapshot.scopeKey}`, JSON.stringify(snapshot));
   } catch {
      // IndexedDB is the durable path; localStorage cache writes are best effort.
   }
}

function bootstrapFromSnapshot(snapshot: CachedScopeSnapshot): BootstrapResponse {
   const omittedCompletedBefore = snapshot.omittedCompletedBefore || defaultOmittedCompletedBefore();
   return {
      cursor: snapshot.cursor,
      serverTime: snapshot.serverTime,
      completedWindowDays: snapshot.completedWindowDays,
      omittedCompletedBefore,
      totalHotTasks: snapshot.totalHotTasks,
      tasks: pruneColdCompletedTasks(snapshot.tasks, omittedCompletedBefore),
      milestones: normalizeMilestoneResources(snapshot.milestones),
      projects: snapshot.projects,
      teams: snapshot.teams,
      users: snapshot.users,
      views: snapshot.views,
   };
}

function isPersistedTaskMutation(value: unknown): value is PersistedTaskMutation {
   if (!value || typeof value !== 'object') return false;
   const mutation = value as Partial<PersistedTaskMutation>;
   return (
      typeof mutation.clientId === 'string' &&
      typeof mutation.mutationId === 'string' &&
      typeof mutation.name === 'string' &&
      typeof mutation.createdAt === 'string' &&
      (
         mutation.dependsOnMutationIds === undefined ||
         (Array.isArray(mutation.dependsOnMutationIds) && mutation.dependsOnMutationIds.every((id) => typeof id === 'string'))
      )
   );
}

function isCachedScopeSnapshot(value: unknown): value is CachedScopeSnapshot {
   if (!value || typeof value !== 'object') return false;
   const snapshot = value as Partial<CachedScopeSnapshot>;
   return (
      typeof snapshot.scopeKey === 'string' &&
      typeof snapshot.savedAt === 'string' &&
      typeof snapshot.cursor === 'string' &&
      (snapshot.omittedCompletedBefore === undefined || typeof snapshot.omittedCompletedBefore === 'string') &&
      Array.isArray(snapshot.tasks) &&
      (snapshot.milestones === undefined || Array.isArray(snapshot.milestones)) &&
      Array.isArray(snapshot.projects) &&
      Array.isArray(snapshot.teams) &&
      Array.isArray(snapshot.users) &&
      Array.isArray(snapshot.views)
   );
}

function pruneColdCompletedTasks(tasks: TaskaraTask[], omittedCompletedBefore?: string | null): TaskaraTask[] {
   const cutoff = Date.parse(omittedCompletedBefore || defaultOmittedCompletedBefore());
   if (!Number.isFinite(cutoff)) return tasks;

   return tasks.filter((task) => {
      if (task.status !== 'DONE' && task.status !== 'CANCELED') return true;
      const completedAt = task.completedAt ? Date.parse(task.completedAt) : NaN;
      if (Number.isFinite(completedAt)) return completedAt >= cutoff;
      const updatedAt = task.updatedAt ? Date.parse(task.updatedAt) : NaN;
      return Number.isFinite(updatedAt) && updatedAt >= cutoff;
   });
}

function defaultOmittedCompletedBefore(): string {
   return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
}

function isTaskaraTaskEntity(value: unknown): value is TaskaraTask {
   if (!value || typeof value !== 'object') return false;
   const task = value as Partial<TaskaraTask>;
   return (
      typeof task.id === 'string' &&
      typeof task.key === 'string' &&
      typeof task.title === 'string' &&
      typeof task.status === 'string' &&
      typeof task.priority === 'string'
   );
}

function milestoneFromMutationEntity(value: unknown): TaskaraMilestone | null {
   if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
   const direct = value as Partial<TaskaraMilestone> & { milestone?: unknown };
   if (
      typeof direct.id === 'string' &&
      typeof direct.projectId === 'string' &&
      typeof direct.name === 'string' &&
      typeof direct.kind === 'string' &&
      typeof direct.status === 'string' &&
      direct.progress && typeof direct.progress === 'object'
   ) {
      return direct as TaskaraMilestone;
   }
   return milestoneFromMutationEntity(direct.milestone);
}

export function normalizeMilestoneResources(value: unknown): TaskaraMilestone[] {
   if (!Array.isArray(value)) return [];
   return value.filter((item): item is TaskaraMilestone => {
      if (!item || typeof item !== 'object') return false;
      const milestone = item as Partial<TaskaraMilestone>;
      return (
         typeof milestone.id === 'string' &&
         typeof milestone.projectId === 'string' &&
         typeof milestone.name === 'string' &&
         typeof milestone.kind === 'string' &&
         typeof milestone.status === 'string' &&
         Boolean(milestone.progress && typeof milestone.progress === 'object')
      );
   });
}

function openTaskSyncDb(): Promise<IDBDatabase | null> {
   if (typeof indexedDB === 'undefined') return Promise.resolve(null);

   return new Promise((resolve) => {
      const request = indexedDB.open(taskSyncDbName, 2);
      request.onupgradeneeded = () => {
         const db = request.result;
         if (!db.objectStoreNames.contains(pendingMutationsStore)) {
            db.createObjectStore(pendingMutationsStore, { keyPath: 'mutationId' });
         }
         if (!db.objectStoreNames.contains(scopeSnapshotsStore)) {
            db.createObjectStore(scopeSnapshotsStore, { keyPath: 'scopeKey' });
         }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
   });
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
   return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
   });
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | null> {
   return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) || null);
      request.onerror = () => reject(request.error);
   });
}

function idbPut<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
   return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(storeName).put(value);
   });
}

function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
   return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(storeName).delete(key);
   });
}

async function runWithOptionalMutationLock(task: () => Promise<void>): Promise<void> {
   const locks = (navigator as Navigator & {
      locks?: {
         request: (
            name: string,
            options: { mode: 'exclusive'; ifAvailable: true },
            callback: (lock: unknown | null) => Promise<void>
         ) => Promise<void>;
      };
   }).locks;

   if (!locks) {
      await task();
      return;
   }

   await locks.request('taskara-sync-mutation-flush', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await task();
   });
}

function broadcastSyncMessage(message: unknown): void {
   const channel = createBroadcastChannel();
   if (!channel) return;
   channel.postMessage(message);
   channel.close();
}

function publishTaskSyncMessage(message: TaskSyncBroadcastMessage): void {
   broadcastSyncMessage(message);
   if (typeof window === 'undefined') return;
   window.dispatchEvent(new CustomEvent(windowSyncMessageEvent, { detail: message }));
}

function broadcastLocalTask(scopeKey: string, task: TaskaraTask): void {
   publishTaskSyncMessage({ type: 'localTask', scopeKey, task, mutationId: task.syncMutationId } satisfies TaskSyncBroadcastMessage);
}

function broadcastLocalTaskDeleted(scopeKey: string, task: TaskaraTask): void {
   publishTaskSyncMessage({
      type: 'localTaskDeleted',
      scopeKey,
      taskId: task.id,
      taskKey: task.key,
      mutationId: task.syncMutationId,
   } satisfies TaskSyncBroadcastMessage);
}

function broadcastLocalMilestone(scopeKey: string, milestone: TaskaraMilestone): void {
   publishTaskSyncMessage({
      type: 'localMilestone',
      scopeKey,
      milestone,
      mutationId: milestone.syncMutationId,
   } satisfies TaskSyncBroadcastMessage);
}

function broadcastLocalMilestoneDeleted(scopeKey: string, milestone: TaskaraMilestone): void {
   publishTaskSyncMessage({
      type: 'localMilestoneDeleted',
      scopeKey,
      milestoneId: milestone.id,
      mutationId: milestone.syncMutationId,
   } satisfies TaskSyncBroadcastMessage);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
   return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener(
         'abort',
         () => {
            window.clearTimeout(timer);
            resolve();
         },
         { once: true }
      );
   });
}
