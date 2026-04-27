import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TaskaraClientError, taskaraApiBaseUrl, taskaraRequest, taskaraRequestHeaders } from '@/lib/taskara-client';
import { clearAuthSession } from '@/store/auth-store';
import type { TaskaraProject, TaskaraTask, TaskaraTeam, TaskaraUser, TaskaraView } from '@/lib/taskara-types';

export type TaskUpdatePatch = {
   title?: string;
   description?: string | null;
   projectId?: string;
   status?: string;
   priority?: string;
   assigneeId?: string | null;
   dueAt?: string | null;
   labels?: string[];
};

type TaskCreateInput = {
   projectId: string;
   title: string;
   description?: string;
   status: string;
   priority: string;
   assigneeId?: string;
   dueAt?: string;
   labels: string[];
   source: 'WEB';
};

type BootstrapResponse = {
   cursor: string;
   tasks: TaskaraTask[];
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
   clientId?: string | null;
   mutationId?: string | null;
   type?: 'upsert' | 'delete' | 'removeFromScope';
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

export type TaskSyncScope = {
   teamId: string;
   mine?: boolean;
   workspaceSlug?: string;
};

type TaskSyncResources = {
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
const windowSyncMessageEvent = 'taskara:task-sync-message';

type PersistedTaskMutation = {
   clientId: string;
   mutationId: string;
   name: string;
   args: unknown;
   createdAt: string;
   scopeKey?: string;
   optimisticTask?: TaskaraTask;
   deletedTaskId?: string;
   deletedTaskKey?: string;
};

type CachedScopeSnapshot = BootstrapResponse & {
   scopeKey: string;
   savedAt: string;
};

type PendingMutationOptions = {
   mutationId?: string;
   keepPendingOnRetryable?: boolean;
   scopeKey?: string;
   optimisticTask?: TaskaraTask;
   deletedTaskId?: string;
   deletedTaskKey?: string;
};

type TaskSyncBroadcastMessage =
   | { type: 'events'; scopeKey: string; cursor: string; events: SyncTaskEvent[] }
   | { type: 'localTask'; scopeKey: string; task: TaskaraTask; mutationId?: string }
   | { type: 'localTaskDeleted'; scopeKey: string; taskId?: string; taskKey?: string; mutationId?: string };

export class TaskSyncMutationError extends Error {
   retryable: boolean;

   constructor(message: string, retryable: boolean) {
      super(message);
      this.name = 'TaskSyncMutationError';
      this.retryable = retryable;
   }
}

export type TaskSyncController = ReturnType<typeof useTaskSync>;

export function useTaskSync(scope: TaskSyncScope) {
   const scopeKey = taskScopeKey(scope);
   const scopeRef = useRef(scope);
   const cursorRef = useRef('0');
   const pullingRef = useRef(false);
   const bootstrappedRef = useRef(false);
   const bootstrapRunRef = useRef(0);
   const lastBootstrappedScopeRef = useRef<string | null>(null);
   const clientId = useMemo(getOrCreateTaskSyncClientId, []);
   const [tasks, setTasks] = useState<TaskaraTask[]>([]);
   const [resources, setResources] = useState<TaskSyncResources>({
      projects: [],
      teams: [],
      users: [],
      views: [],
   });
   const [cursor, setCursor] = useState('0');
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState('');

   useEffect(() => {
      scopeRef.current = scope;
   }, [scope]);

   const applyTask = useCallback((task: TaskaraTask) => {
      setTasks((current) => upsertTask(current, task));
   }, []);

   const applyBootstrap = useCallback(
      async (result: BootstrapResponse, requestedScopeKey: string, runId: number): Promise<boolean> => {
         if (bootstrapRunRef.current !== runId || taskScopeKey(scopeRef.current) !== requestedScopeKey) return false;
         const tasksWithPending = await applyPendingMutationsToTasks(result.tasks, clientId, requestedScopeKey);
         if (bootstrapRunRef.current !== runId || taskScopeKey(scopeRef.current) !== requestedScopeKey) return false;
         cursorRef.current = result.cursor;
         setCursor(result.cursor);
         setTasks(tasksWithPending);
         setResources({
            projects: result.projects,
            teams: result.teams,
            users: result.users,
            views: result.views,
         });
         bootstrappedRef.current = true;
         lastBootstrappedScopeRef.current = requestedScopeKey;
         return true;
      },
      [clientId]
   );

   const applyEvents = useCallback(
      (events: SyncTaskEvent[], nextCursor: string, broadcast = true) => {
         if (compareCursor(nextCursor, cursorRef.current) < 0) return;

         if (events.length) {
            setTasks((current) => {
               let next = current;
               for (const event of events) {
                  if (event.type === 'upsert' && event.task) {
                     if (event.clientId === clientId && event.mutationId) {
                        next = next.filter((task) => task.syncMutationId !== event.mutationId);
                     }
                     next = upsertTask(next, event.task);
                  } else if (event.type === 'delete' || event.type === 'removeFromScope') {
                     next = next.filter((task) => task.id !== event.taskId && task.key !== event.taskKey);
                  }
               }
               return next;
            });
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

   const refresh = useCallback(async () => {
      const runId = bootstrapRunRef.current + 1;
      bootstrapRunRef.current = runId;
      const requestedScope = scopeRef.current;
      const requestedScopeKey = taskScopeKey(requestedScope);
      let restoredFromCache = false;
      setLoading(true);
      setError('');
      bootstrappedRef.current = false;
      if (lastBootstrappedScopeRef.current !== requestedScopeKey) {
         setTasks([]);
         setResources({ projects: [], teams: [], users: [], views: [] });
      }
      try {
         const cached = await loadCachedBootstrap(requestedScopeKey);
         if (cached) {
            restoredFromCache = await applyBootstrap(cached, requestedScopeKey, runId);
            if (restoredFromCache && bootstrapRunRef.current === runId) setLoading(false);
         }

         const result = await taskaraRequest<BootstrapResponse>(`/sync/bootstrap?${scopeSearch(requestedScope)}`);
         void saveCachedBootstrap(requestedScopeKey, result);
         await applyBootstrap(result, requestedScopeKey, runId);
      } catch (err) {
         if (bootstrapRunRef.current !== runId) return;
         if (!restoredFromCache) {
            setError(err instanceof Error ? err.message : 'Task sync failed.');
         }
      } finally {
         if (bootstrapRunRef.current === runId) setLoading(false);
      }
   }, [applyBootstrap]);

   const pull = useCallback(async () => {
      if (!bootstrappedRef.current || pullingRef.current) return;
      pullingRef.current = true;
      try {
         let hasMore = true;
         while (hasMore) {
            const query = new URLSearchParams(scopeSearchParams(scopeRef.current));
            query.set('cursor', cursorRef.current);
            const result = await taskaraRequest<PullResponse>(`/sync/pull?${query.toString()}`);
            if (compareCursor(result.cursor, cursorRef.current) < 0) return;
            if (result.resetRequired) {
               await refresh();
               return;
            }
            if (result.events.some((event) => event.entityType && event.entityType !== 'task')) {
               await refresh();
               return;
            }
            applyEvents(result.events, result.cursor);
            hasMore = Boolean(result.hasMore);
         }
      } catch (err) {
         setError(err instanceof Error ? err.message : 'Task sync pull failed.');
         if (isUnrecoverableSyncError(err)) void refresh();
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
         tasks,
         projects: resources.projects,
         teams: resources.teams,
         users: resources.users,
         views: resources.views,
      });
   }, [cursor, loading, resources.projects, resources.teams, resources.users, resources.views, scopeKey, tasks]);

   useEffect(() => {
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) void refresh();
      };
      const handleAuthChanged = (event: Event) => {
         if (event instanceof StorageEvent && event.key !== 'taskara.auth.session.v1') return;
         bootstrappedRef.current = false;
         cursorRef.current = '0';
         setCursor('0');
         setTasks([]);
         setResources({ projects: [], teams: [], users: [], views: [] });
         void refresh();
      };
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener('taskara:auth-changed', handleAuthChanged);
      window.addEventListener('storage', handleAuthChanged);
      return () => {
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener('taskara:auth-changed', handleAuthChanged);
         window.removeEventListener('storage', handleAuthChanged);
      };
   }, [refresh]);

   useEffect(() => {
      const channel = createBroadcastChannel();
      const handleMessage = (message: Partial<TaskSyncBroadcastMessage>) => {
         if (message.scopeKey !== scopeKey) return;
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
         void flushPendingTaskSyncMutations(clientId).then((hadFinalFailures) => {
            if (hadFinalFailures) void refresh();
            else void pull();
         });
      };
      const interval = window.setInterval(handleWake, 60000);
      window.addEventListener('focus', handleWake);
      window.addEventListener('online', handleWake);
      document.addEventListener('visibilitychange', handleWake);
      handleWake();
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('focus', handleWake);
         window.removeEventListener('online', handleWake);
         document.removeEventListener('visibilitychange', handleWake);
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
            const created = await pushMutation('task.create', input, { mutationId, optimisticTask: optimistic });
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
            const optimistic = { ...applyPatch(task, patch, resources), syncState: 'pending' as const, syncMutationId: task.syncMutationId };
            setTasks((current) => current.map((item) => (item.id === task.id ? optimistic : item)));
            try {
               await updatePendingCreateTaskMutation(task.syncMutationId, patch, optimistic);
               broadcastLocalTask(scopeKey, optimistic);
               return optimistic;
            } catch (err) {
               setTasks((current) => current.map((item) => (item.id === task.id ? previous : item)));
               throw err;
            }
         }

         const mutationId = crypto.randomUUID();
         const optimistic = { ...applyPatch(task, patch, resources), syncState: 'pending' as const, syncMutationId: mutationId };
         setTasks((current) => current.map((item) => (item.id === task.id ? optimistic : item)));

         try {
            const updated = await pushMutation(
               'task.update',
               { idOrKey: task.key || task.id, baseVersion: task.version, patch },
               { mutationId, optimisticTask: optimistic }
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

   return {
      tasks,
      projects: resources.projects,
      teams: resources.teams,
      users: resources.users,
      views: resources.views,
      cursor,
      loading,
      error,
      refresh,
      applyTask,
      createTask,
      updateTask,
      deleteTask,
   };
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
      const interval = window.setInterval(handleWake, 60000);
      window.addEventListener('focus', handleWake);
      window.addEventListener('online', handleWake);
      document.addEventListener('visibilitychange', handleWake);

      return () => {
         controller.abort();
         window.clearInterval(interval);
         window.removeEventListener('focus', handleWake);
         window.removeEventListener('online', handleWake);
         document.removeEventListener('visibilitychange', handleWake);
      };
   }, [clientId, enabled]);
}

function upsertTask(tasks: TaskaraTask[], task: TaskaraTask): TaskaraTask[] {
   const existingIndex = tasks.findIndex(
      (item) =>
         item.id === task.id ||
         (task.syncMutationId && item.syncMutationId === task.syncMutationId) ||
         (canMatchTaskByKey(item, task) && item.key === task.key)
   );
   if (existingIndex === -1) return [task, ...tasks];
   const next = [...tasks];
   const merged = { ...next[existingIndex], ...task };
   if (!task.syncState) {
      delete merged.syncState;
      delete merged.syncMutationId;
   }
   next[existingIndex] = merged;
   return next;
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
      .filter((mutation) => mutation.clientId === clientId && mutation.scopeKey === scopeKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

   let next = tasks;
   for (const mutation of pending) {
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

function buildOptimisticTask(
   id: string,
   input: TaskCreateInput,
   resources: TaskSyncResources,
   syncMutationId: string
): TaskaraTask {
   const now = new Date().toISOString();
   const project = resources.projects.find((item) => item.id === input.projectId) || null;
   const assignee = input.assigneeId ? resources.users.find((item) => item.id === input.assigneeId) || null : null;

   return {
      id,
      key: optimisticTaskKey(syncMutationId),
      title: input.title,
      description: input.description || null,
      status: input.status,
      priority: input.priority,
      dueAt: input.dueAt || null,
      createdAt: now,
      updatedAt: now,
      completedAt: input.status === 'DONE' ? now : null,
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
      assignee: assignee
         ? {
              id: assignee.id,
              name: assignee.name,
              email: assignee.email,
              avatarUrl: assignee.avatarUrl,
           }
         : null,
      labels: input.labels.map((name) => ({ label: { id: `local-${name}`, name } })),
      _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
   };
}

function optimisticTaskKey(syncMutationId: string): string {
   return `NEW-${syncMutationId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function applyPatch(task: TaskaraTask, patch: TaskUpdatePatch, resources: TaskSyncResources): TaskaraTask {
   const { assigneeId: _assigneeId, projectId: _projectId, labels: _labels, ...scalarPatch } = patch;
   const next: TaskaraTask = { ...task, ...scalarPatch, updatedAt: new Date().toISOString() };

   if ('assigneeId' in patch) {
      const assignee = patch.assigneeId ? resources.users.find((user) => user.id === patch.assigneeId) || null : null;
      next.assignee = assignee
         ? {
              id: assignee.id,
              name: assignee.name,
              email: assignee.email,
              avatarUrl: assignee.avatarUrl,
           }
         : null;
      delete (next as TaskaraTask & { assigneeId?: string | null }).assigneeId;
   }

   if (patch.projectId) {
      const project = resources.projects.find((item) => item.id === patch.projectId);
      if (project) {
         next.project = {
            id: project.id,
            name: project.name,
            keyPrefix: project.keyPrefix,
            team: project.team || null,
         };
      }
      delete (next as TaskaraTask & { projectId?: string }).projectId;
   }

   if (patch.labels) {
      next.labels = patch.labels.map((name) => ({ label: { id: `local-${name}`, name } }));
   }

   if (patch.status) {
      next.completedAt = patch.status === 'DONE' ? new Date().toISOString() : null;
   }

   return next;
}

async function updatePendingCreateTaskMutation(
   mutationId: string,
   patch: TaskUpdatePatch,
   optimisticTask: TaskaraTask
): Promise<void> {
   const mutation = (await loadPendingMutations()).find((item) => item.mutationId === mutationId);
   if (!mutation || mutation.name !== 'task.create' || !isTaskCreateInput(mutation.args)) {
      throw new TaskSyncMutationError('Pending issue create could not be updated.', false);
   }

   await persistPendingMutation({
      ...mutation,
      args: mergeTaskCreateInput(mutation.args, patch),
      optimisticTask,
   });
}

function mergeTaskCreateInput(input: TaskCreateInput, patch: TaskUpdatePatch): TaskCreateInput {
   const next: TaskCreateInput = { ...input };
   if (patch.title !== undefined) next.title = patch.title;
   if (patch.status !== undefined) next.status = patch.status;
   if (patch.priority !== undefined) next.priority = patch.priority;
   if (patch.projectId !== undefined) next.projectId = patch.projectId;
   if (patch.labels !== undefined) next.labels = patch.labels;

   if (patch.description !== undefined) {
      if (patch.description === null) delete next.description;
      else next.description = patch.description;
   }

   if (patch.assigneeId !== undefined) {
      if (patch.assigneeId) next.assigneeId = patch.assigneeId;
      else delete next.assigneeId;
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
   return `${scope.workspaceSlug || currentWorkspaceSlug()}:${scope.teamId}:${scope.mine ? 'mine' : 'all'}`;
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

function isRetryableMutationTransportError(error: unknown): boolean {
   if (error instanceof TaskSyncMutationError) return error.retryable;
   if (error instanceof TaskaraClientError) return !error.status || error.status >= 500;
   return true;
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
      name,
      args,
      createdAt: new Date().toISOString(),
      scopeKey: options.scopeKey,
      optimisticTask: options.optimisticTask,
      deletedTaskId: options.deletedTaskId,
      deletedTaskKey: options.deletedTaskKey,
   };
   await persistPendingMutation(mutation);

   try {
      if (options.keepPendingOnRetryable && typeof navigator !== 'undefined' && navigator.onLine === false) {
         throw new TaskSyncMutationError('Task mutation queued until connection is restored.', true);
      }
      const response = await sendPersistedMutation(mutation);
      const result = response.results[0];
      if (!result || result.status === 'rejected' || result.status === 'conflict') {
         if (!result?.error?.retryable) await removePendingMutation(mutationId);
         throw new TaskSyncMutationError(result?.error?.message || 'Task mutation failed.', Boolean(result?.error?.retryable));
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
      if (err instanceof Error) throw new TaskSyncMutationError(err.message, retryable);
      throw err;
   }
}

export async function flushPendingTaskSyncMutations(clientId = getOrCreateTaskSyncClientId()): Promise<boolean> {
   let hadFinalFailures = false;
   await runWithOptionalMutationLock(async () => {
      const pending = (await loadPendingMutations()).filter((mutation) => mutation.clientId === clientId);
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
               continue;
            }
            if (result.error?.retryable) return;
            await removePendingMutation(mutation.mutationId);
            hadFinalFailures = true;
         } catch (err) {
            if (!isRetryableMutationTransportError(err)) {
               await removePendingMutation(mutation.mutationId);
               hadFinalFailures = true;
               continue;
            }
            return;
         }
      }
   });
   return hadFinalFailures;
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
   return {
      cursor: snapshot.cursor,
      tasks: snapshot.tasks,
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
      typeof mutation.createdAt === 'string'
   );
}

function isCachedScopeSnapshot(value: unknown): value is CachedScopeSnapshot {
   if (!value || typeof value !== 'object') return false;
   const snapshot = value as Partial<CachedScopeSnapshot>;
   return (
      typeof snapshot.scopeKey === 'string' &&
      typeof snapshot.savedAt === 'string' &&
      typeof snapshot.cursor === 'string' &&
      Array.isArray(snapshot.tasks) &&
      Array.isArray(snapshot.projects) &&
      Array.isArray(snapshot.teams) &&
      Array.isArray(snapshot.users) &&
      Array.isArray(snapshot.views)
   );
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
