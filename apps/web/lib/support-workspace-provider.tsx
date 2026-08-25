import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { caseFromDetail, caseFromMutation, supportClient } from '@/lib/support-client';
import { supportOperationsClient } from '@/lib/support-operations-client';
import type {
   CreateSupportCallInput,
   CreateSupportCaseInput,
   SupportCase,
   SupportCaseEvent,
   SupportCaseListQuery,
   SupportAccessSummary,
   SupportDepartment,
   SupportDepartmentMember,
   SupportInteraction,
   SupportPage,
   SupportPermissionGrant,
   SupportQueueKind,
   SupportSearchResult,
   SupportBootstrap,
   SupportSyncEvent,
} from '@/lib/support-types';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { TaskaraClientError, taskaraApiBaseUrl, taskaraRequestHeaders } from '@/lib/taskara-client';
import { clearAuthSession } from '@/store/auth-store';

export const supportWorkspacePersistence = 'memory' as const;

export type SupportWorkspaceState = {
   partitionKey: string;
   casesById: Readonly<Record<string, SupportCase>>;
   caseIdByKey: Readonly<Record<string, string>>;
   queueCaseIds: Readonly<Partial<Record<SupportQueueKind, readonly string[]>>>;
   queueCounts: Readonly<Partial<Record<SupportQueueKind, number>>>;
   departmentsById: Readonly<Record<string, SupportDepartment>>;
   membersByDepartmentId: Readonly<Record<string, readonly SupportDepartmentMember[]>>;
   grantsByUserId: Readonly<Record<string, SupportPermissionGrant>>;
   interactionsByCaseId: Readonly<Record<string, readonly SupportInteraction[]>>;
   eventsByCaseId: Readonly<Record<string, readonly SupportCaseEvent[]>>;
   access?: SupportAccessSummary;
   interactionContentAvailable?: boolean;
   manualCallAvailable?: boolean;
   syncRevision: number;
};

type StoreAction =
   | { type: 'replace-bootstrap'; bootstrap: SupportBootstrap; preserveQueues?: readonly SupportQueueKind[] }
   | { type: 'clear-sensitive' }
   | { type: 'apply-sync-events'; events: SupportSyncEvent[] }
   | { type: 'upsert-cases'; cases: SupportCase[] }
   | { type: 'set-queue'; queue: SupportQueueKind; cases: SupportCase[]; total?: number }
   | { type: 'append-queue'; queue: SupportQueueKind; cases: SupportCase[]; total?: number }
   | { type: 'invalidate-queues' }
   | { type: 'remove-case'; caseId: string }
   | { type: 'set-departments'; departments: SupportDepartment[] }
   | { type: 'upsert-department'; department: SupportDepartment }
   | { type: 'set-members'; departmentId: string; members: SupportDepartmentMember[] }
   | { type: 'set-grants'; grants: SupportPermissionGrant[] }
   | { type: 'upsert-grant'; grant: SupportPermissionGrant }
   | { type: 'remove-grant'; userId: string; role?: 'TRIAGER' | 'SUPERVISOR' }
   | { type: 'set-interactions'; caseId: string; interactions: SupportInteraction[] }
   | { type: 'upsert-interaction'; caseId: string; interaction: SupportInteraction }
   | { type: 'set-events'; caseId: string; events: SupportCaseEvent[] }
   | { type: 'set-access'; access: SupportAccessSummary }
   | { type: 'set-interaction-content-available'; available: boolean }
   | { type: 'set-manual-call-available'; available: boolean }
   | { type: 'set-counts'; counts: Partial<Record<SupportQueueKind, number>> };

export function createSupportWorkspaceState(
   partitionKey: string,
   counts: Partial<Record<SupportQueueKind, number>> = {}
): SupportWorkspaceState {
   return {
      partitionKey,
      casesById: {},
      caseIdByKey: {},
      queueCaseIds: {},
      queueCounts: counts,
      departmentsById: {},
      membersByDepartmentId: {},
      grantsByUserId: {},
      interactionsByCaseId: {},
      eventsByCaseId: {},
      syncRevision: 0,
   };
}

export function supportWorkspaceReducer(state: SupportWorkspaceState, action: StoreAction): SupportWorkspaceState {
   if (action.type === 'replace-bootstrap') {
      return supportStateFromBootstrap(state.partitionKey, action.bootstrap, state, action.preserveQueues);
   }
   if (action.type === 'clear-sensitive') {
      return { ...createSupportWorkspaceState(state.partitionKey), syncRevision: state.syncRevision + 1 };
   }
   if (action.type === 'apply-sync-events') {
      let next = state;
      for (const event of action.events) {
         if (event.entityType === 'support_case') {
            if (event.type === 'removeFromScope') {
               next = removeCaseFromState(next, event.entityId);
            } else {
               next = withoutCaseInQueues(next, event.entityId);
               next = withCases(next, [event.entity]);
            }
         } else if (event.type === 'upsert') {
            next = {
               ...next,
               departmentsById: { ...next.departmentsById, [event.entity.id]: event.entity },
            };
         }
      }
      return action.events.length ? { ...next, syncRevision: state.syncRevision + 1 } : state;
   }
   if (action.type === 'upsert-cases') return withCases(state, action.cases);
   if (action.type === 'set-queue') {
      const next = withCases(state, action.cases);
      return {
         ...next,
         queueCaseIds: { ...next.queueCaseIds, [action.queue]: action.cases.map((item) => item.id) },
         queueCounts: { ...next.queueCounts, [action.queue]: action.total ?? action.cases.length },
      };
   }
   if (action.type === 'append-queue') {
      const next = withCases(state, action.cases);
      const ids = [...new Set([...(next.queueCaseIds[action.queue] || []), ...action.cases.map((item) => item.id)])];
      return {
         ...next,
         queueCaseIds: { ...next.queueCaseIds, [action.queue]: ids },
         queueCounts: { ...next.queueCounts, [action.queue]: action.total ?? ids.length },
      };
   }
   if (action.type === 'invalidate-queues') return { ...state, queueCaseIds: {} };
   if (action.type === 'remove-case') return removeCaseFromState(state, action.caseId);
   if (action.type === 'set-departments') {
      return {
         ...state,
         departmentsById: Object.fromEntries(action.departments.map((department) => [department.id, department])),
      };
   }
   if (action.type === 'upsert-department') {
      return { ...state, departmentsById: { ...state.departmentsById, [action.department.id]: action.department } };
   }
   if (action.type === 'set-members') {
      return { ...state, membersByDepartmentId: { ...state.membersByDepartmentId, [action.departmentId]: action.members } };
   }
   if (action.type === 'set-grants') {
      return { ...state, grantsByUserId: Object.fromEntries(action.grants.map((grant) => [grantKey(grant), grant])) };
   }
   if (action.type === 'upsert-grant') {
      return { ...state, grantsByUserId: { ...state.grantsByUserId, [grantKey(action.grant)]: action.grant } };
   }
   if (action.type === 'remove-grant') {
      const grantsByUserId = { ...state.grantsByUserId };
      for (const [key, grant] of Object.entries(grantsByUserId)) {
         if (grant.userId === action.userId && (!action.role || grant.role === action.role)) delete grantsByUserId[key];
      }
      return { ...state, grantsByUserId };
   }
   if (action.type === 'set-interactions') {
      return { ...state, interactionsByCaseId: { ...state.interactionsByCaseId, [action.caseId]: action.interactions } };
   }
   if (action.type === 'upsert-interaction') {
      const current = state.interactionsByCaseId[action.caseId] || [];
      const withoutExisting = current.filter((item) => item.id !== action.interaction.id);
      return {
         ...state,
         interactionsByCaseId: {
            ...state.interactionsByCaseId,
            [action.caseId]: [...withoutExisting, action.interaction].sort((left, right) =>
               left.occurredAt.localeCompare(right.occurredAt)
            ),
         },
      };
   }
   if (action.type === 'set-events') {
      return { ...state, eventsByCaseId: { ...state.eventsByCaseId, [action.caseId]: action.events } };
   }
   if (action.type === 'set-access') return { ...state, access: action.access };
   if (action.type === 'set-interaction-content-available') return { ...state, interactionContentAvailable: action.available };
   if (action.type === 'set-manual-call-available') return { ...state, manualCallAvailable: action.available };
   return { ...state, queueCounts: { ...state.queueCounts, ...action.counts } };
}

export function supportStateFromBootstrap(
   partitionKey: string,
   bootstrap: SupportBootstrap,
   previous?: SupportWorkspaceState,
   preserveQueues: readonly SupportQueueKind[] = []
): SupportWorkspaceState {
   let next = createSupportWorkspaceState(partitionKey, normalizeQueueCounts(bootstrap.counts || {}));
   next = withCases(next, bootstrap.cases || []);
   const queueCaseIds = queueIndexesFromBootstrap(bootstrap);
   next = {
      ...next,
      queueCaseIds,
      departmentsById: Object.fromEntries((bootstrap.departments || []).map((department) => [department.id, department])),
      grantsByUserId: bootstrap.grants
         ? Object.fromEntries(bootstrap.grants.map((grant) => [grantKey(grant), grant]))
         : previous?.grantsByUserId || {},
      membersByDepartmentId: bootstrap.departmentMemberships ? {} : previous?.membersByDepartmentId || {},
      access: bootstrap.access,
      interactionContentAvailable: bootstrap.support?.interactionContentAvailable,
      manualCallAvailable: bootstrap.support?.manualCallAvailable,
      syncRevision: previous?.syncRevision ?? 0,
   };
   for (const member of bootstrap.departmentMemberships || []) {
      const current = next.membersByDepartmentId[member.departmentId] || [];
      next = {
         ...next,
         membersByDepartmentId: {
            ...next.membersByDepartmentId,
            [member.departmentId]: [...current, member],
         },
      };
   }
   if (previous && preserveQueues.length) {
      const queueCaseIds = { ...next.queueCaseIds };
      const queueCounts = { ...next.queueCounts };
      const preservedCases: SupportCase[] = [];
      for (const queue of preserveQueues) {
         const ids = previous.queueCaseIds[queue];
         if (!ids) continue;
         queueCaseIds[queue] = ids;
         if (previous.queueCounts[queue] !== undefined) queueCounts[queue] = previous.queueCounts[queue];
         for (const id of ids) {
            const item = previous.casesById[id];
            if (item && !next.casesById[id]) preservedCases.push(item);
         }
      }
      next = { ...withCases(next, preservedCases), queueCaseIds, queueCounts };
   }
   return next;
}

export function queueIndexesFromBootstrap(
   bootstrap: Pick<SupportBootstrap, 'access' | 'cases'>
): Partial<Record<SupportQueueKind, readonly string[]>> {
   const access = bootstrap.access;
   const cases = bootstrap.cases || [];
   if (!access) return {};
   const managedDepartments = new Set(access.managedDepartmentIds);
   const ownMemberships = new Set(access.memberMembershipIds);
   const indexes: Partial<Record<SupportQueueKind, readonly string[]>> = {};
   if (access.workspaceWide || access.triager) {
      indexes.TRIAGE = cases.filter((item) => item.departmentId === null).map((item) => item.id);
   }
   if (access.workspaceWide || managedDepartments.size) {
      indexes.DEPARTMENT_INBOX = cases.filter((item) =>
         item.departmentId !== null
         && item.assigneeMembershipId === null
         && (access.workspaceWide || managedDepartments.has(item.departmentId))
      ).map((item) => item.id);
   }
   if (ownMemberships.size) {
      indexes.MY_CASES = cases.filter((item) =>
         item.assigneeMembershipId !== null && ownMemberships.has(item.assigneeMembershipId)
      ).map((item) => item.id);
   }
   const attention = cases.filter((item) => item.attentionReasons?.length).map((item) => item.id);
   if (attention.length || access.workspaceWide || access.supervisor || managedDepartments.size) {
      indexes.NEEDS_ATTENTION = attention;
   }
   return indexes;
}

function withCases(state: SupportWorkspaceState, cases: SupportCase[]): SupportWorkspaceState {
   if (!cases.length) return state;
   const casesById = { ...state.casesById };
   const caseIdByKey = { ...state.caseIdByKey };
   for (const item of cases) {
      casesById[item.id] = normalizeCase(item);
      caseIdByKey[item.key] = item.id;
   }
   return { ...state, casesById, caseIdByKey };
}

function withoutCaseInQueues(state: SupportWorkspaceState, caseId: string): SupportWorkspaceState {
   const queueCaseIds = Object.fromEntries(
      Object.entries(state.queueCaseIds).map(([queue, ids]) => [
         queue,
         ids?.filter((id) => id !== caseId) || [],
      ])
   ) as SupportWorkspaceState['queueCaseIds'];
   return { ...state, queueCaseIds };
}

function removeCaseFromState(state: SupportWorkspaceState, caseId: string): SupportWorkspaceState {
   const existing = state.casesById[caseId];
   const hasPrivateTimeline = Boolean(state.interactionsByCaseId[caseId] || state.eventsByCaseId[caseId]);
   if (!existing && !hasPrivateTimeline) return state;
   const casesById = { ...state.casesById };
   const caseIdByKey = { ...state.caseIdByKey };
   const interactionsByCaseId = { ...state.interactionsByCaseId };
   const eventsByCaseId = { ...state.eventsByCaseId };
   delete casesById[caseId];
   if (existing) delete caseIdByKey[existing.key];
   delete interactionsByCaseId[caseId];
   delete eventsByCaseId[caseId];
   return {
      ...withoutCaseInQueues(state, caseId),
      casesById,
      caseIdByKey,
      interactionsByCaseId,
      eventsByCaseId,
   };
}

export type SupportWorkspaceController = {
   identityKey: string;
   accessEpoch: string | number;
   partitionKey: string;
   state: SupportWorkspaceState;
   casesById: Readonly<Record<string, SupportCase>>;
   queueCounts: Readonly<Partial<Record<SupportQueueKind, number>>>;
   departments: SupportDepartment[];
   grants: SupportPermissionGrant[];
   access?: SupportAccessSummary;
   interactionContentAvailable: boolean;
   manualCallAvailable: boolean;
   busy: (operation: string) => boolean;
   error: string;
   clearError: () => void;
   caseByIdOrKey: (idOrKey: string) => SupportCase | undefined;
   casesForQueue: (queue: SupportQueueKind) => SupportCase[];
   bootstrap: () => Promise<void>;
   loadCases: (query: SupportCaseListQuery) => Promise<SupportPage<SupportCase>>;
   search: (query: string, limit?: number) => Promise<SupportSearchResult>;
   loadCase: (idOrKey: string) => Promise<SupportCase>;
   loadInteractions: (idOrKey: string) => Promise<SupportInteraction[]>;
   loadEvents: (idOrKey: string) => Promise<SupportCaseEvent[]>;
   loadDepartments: () => Promise<SupportDepartment[]>;
   createDepartment: (input: { name: string; slug: string; description?: string }) => Promise<SupportDepartment>;
   updateDepartment: (id: string, input: Partial<Pick<SupportDepartment, 'name' | 'description' | 'active'>>) => Promise<SupportDepartment>;
   loadDepartmentMembers: (departmentId: string) => Promise<SupportDepartmentMember[]>;
   addDepartmentMember: (departmentId: string, input: { userId: string; role: 'MEMBER' | 'MANAGER' }) => Promise<SupportDepartmentMember>;
   updateDepartmentMember: (departmentId: string, userId: string, input: { role?: 'MEMBER' | 'MANAGER'; active?: boolean }) => Promise<SupportDepartmentMember>;
   removeDepartmentMember: (departmentId: string, userId: string) => Promise<void>;
   loadGrants: () => Promise<SupportPermissionGrant[]>;
   setGrant: (input: { userId: string; role: 'TRIAGER' | 'SUPERVISOR' }) => Promise<SupportPermissionGrant>;
   removeGrant: (userId: string, role?: 'TRIAGER' | 'SUPERVISOR') => Promise<void>;
   createCase: (input: CreateSupportCaseInput) => Promise<SupportCase>;
   createCall: (input: CreateSupportCallInput) => Promise<SupportCase>;
   routeCase: (item: SupportCase, input: { targetDepartmentId: string; targetAssigneeMembershipId?: string | null; reason?: string }) => Promise<SupportCase>;
   waitCase: (item: SupportCase, input: { status: 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL'; waitingReason?: string; nextActionAt: string }) => Promise<SupportCase>;
   resolveCase: (item: SupportCase, input: { resolutionCode: string; resolutionSummary: string; duplicateOfCaseId?: string }) => Promise<SupportCase>;
   closeCase: (item: SupportCase, input: { confirmation: 'CUSTOMER_CONFIRMED' | 'POLICY_WINDOW_ELAPSED' | 'ADMIN_OVERRIDE'; reason?: string }) => Promise<SupportCase>;
   reopenCase: (item: SupportCase, reason: string) => Promise<SupportCase>;
   snoozeCase: (item: SupportCase, input: { snoozedUntil: string; reason: string }) => Promise<SupportCase>;
   resumeCase: (item: SupportCase, reason: string) => Promise<SupportCase>;
   addInteraction: (item: SupportCase, input: { kind: 'MESSAGE' | 'CALL' | 'NOTE'; visibility: 'PUBLIC' | 'INTERNAL'; channel: 'API' | 'CALL' | 'MANUAL' | 'EMAIL' | 'MESSAGING'; direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL'; content?: { body: string; format: 'text/plain' | 'text/markdown' } }) => Promise<SupportCase>;
};

const SupportWorkspaceContext = createContext<SupportWorkspaceController | null>(null);
type SupportScopeGuard = 'ready' | 'validating' | 'blocked';

export function SupportWorkspaceProvider({ children }: { children: ReactNode }) {
   const runtime = useWorkspaceRuntime();
   const accessEpoch = runtime.me.supportAccessEpoch || 0;
   const partitionKey = `${runtime.identityKey}:${accessEpoch}`;
   const [state, dispatch] = useReducer(
      supportWorkspaceReducer,
      undefined,
      () => createSupportWorkspaceState(partitionKey, accessScopedInitialCounts(runtime.permissions, runtime.me.support))
   );
   const casesByIdRef = useRef(state.casesById);
   const caseIdByKeyRef = useRef(state.caseIdByKey);
   casesByIdRef.current = state.casesById;
   caseIdByKeyRef.current = state.caseIdByKey;
   const [operations, setOperations] = useState<ReadonlySet<string>>(() => new Set());
   const [error, setError] = useState('');
   const [scopeGuard, setScopeGuard] = useState<SupportScopeGuard>('ready');
   const [scopeGuardError, setScopeGuardError] = useState('');
   const [streamGeneration, setStreamGeneration] = useState(0);
   const mounted = useRef(true);
   const pulling = useRef(false);
   const protectedPull = useRef(false);
   const cursorRef = useRef<string | null>(null);
   const resetPromiseRef = useRef<Promise<void> | null>(null);
   const streamClientId = useRef(crypto.randomUUID());
   const authoritativeQueuePages = useRef<Set<SupportQueueKind>>(new Set());

   useEffect(() => {
      mounted.current = true;
      return () => {
         mounted.current = false;
      };
   }, []);

   const epochIsCurrent = useCallback((value: string | number | null | undefined) =>
      supportAccessEpochMatches(accessEpoch, value), [accessEpoch]);

   const applyBootstrap = useCallback((result: SupportBootstrap, preserveQueues: boolean) => {
      if (!epochIsCurrent(result.accessEpoch)) return false;
      cursorRef.current = result.cursor || null;
      dispatch({
         type: 'replace-bootstrap',
         bootstrap: result,
         preserveQueues: preserveQueues ? [...authoritativeQueuePages.current] : [],
      });
      setScopeGuard('ready');
      setScopeGuardError('');
      setStreamGeneration((current) => current + 1);
      return true;
   }, [epochIsCurrent]);

   const clearSensitiveProjection = useCallback(() => {
      cursorRef.current = null;
      authoritativeQueuePages.current.clear();
      setScopeGuard('validating');
      setScopeGuardError('');
      dispatch({ type: 'clear-sensitive' });
   }, []);

   const forceScopeRefresh = useCallback(async () => {
      if (resetPromiseRef.current) return resetPromiseRef.current;
      clearSensitiveProjection();
      const reset = (async () => {
         try {
            await runtime.refresh();
            if (!mounted.current) return;
            const fresh = await supportClient.bootstrap();
            if (!mounted.current) return;
            // A changed epoch remounts this provider through App's privacy partition key. Until
            // that render commits, the old provider stays behind the scope guard with no data.
            if (!applyBootstrap(fresh, false) && mounted.current) setScopeGuard('validating');
         } catch (caught) {
            if (!mounted.current) return;
            setScopeGuard('blocked');
            setScopeGuardError(caught instanceof Error ? caught.message : 'اعتبارسنجی دوباره دسترسی ناموفق بود.');
         }
      })();
      resetPromiseRef.current = reset;
      try {
         await reset;
      } finally {
         if (resetPromiseRef.current === reset) resetPromiseRef.current = null;
      }
   }, [applyBootstrap, clearSensitiveProjection, runtime]);

   const run = useCallback(async <T,>(operation: string, task: () => Promise<T>): Promise<T> => {
      setOperations((current) => new Set(current).add(operation));
      setError('');
      try {
         return await task();
      } catch (caught) {
         if (mounted.current) setError(caught instanceof Error ? caught.message : 'عملیات پشتیبانی ناموفق بود.');
         throw caught;
      } finally {
         if (mounted.current) {
            setOperations((current) => {
               const next = new Set(current);
               next.delete(operation);
               return next;
            });
         }
      }
   }, []);

   const bootstrap = useCallback(() => run('bootstrap', async () => {
      const result = await supportClient.bootstrap();
      if (!mounted.current) return;
      if (!applyBootstrap(result, true)) await forceScopeRefresh();
   }), [applyBootstrap, forceScopeRefresh, run]);

   const pull = useCallback(async (protectVisibleState = false) => {
      if (protectVisibleState && mounted.current) {
         protectedPull.current = true;
         setScopeGuard('validating');
         setScopeGuardError('');
      }
      if (pulling.current) return;
      pulling.current = true;
      try {
         let cursor = cursorRef.current;
         if (!cursor) {
            const fresh = await supportClient.bootstrap();
            if (!mounted.current) return;
            if (!applyBootstrap(fresh, true)) await forceScopeRefresh();
            return;
         }
         let hasMore = true;
         let pageCount = 0;
         let changed = false;
         while (hasMore) {
            const result = await supportClient.pull(accessEpoch, cursor);
            if (!mounted.current) return;
            if (!epochIsCurrent(result.accessEpoch)) {
               await forceScopeRefresh();
               return;
            }
            if (!result.cursor) throw new TaskaraClientError('پاسخ همگام‌سازی پشتیبانی نشانگر ادامه ندارد.');
            cursor = result.cursor;
            cursorRef.current = result.cursor;
            if (result.events.length) {
               changed = true;
               authoritativeQueuePages.current.clear();
               dispatch({ type: 'apply-sync-events', events: result.events });
            }
            hasMore = Boolean(result.hasMore);
            pageCount += 1;
            if (hasMore && pageCount >= 100) {
               await forceScopeRefresh();
               return;
            }
         }
         if (changed) {
            const response = await supportClient.counts();
            if (!epochIsCurrent(response.accessEpoch)) {
               await forceScopeRefresh();
               return;
            }
            if (mounted.current && response.counts) {
               dispatch({ type: 'set-counts', counts: normalizeQueueCounts(response.counts) });
            }
         }
         if (mounted.current) {
            setScopeGuard('ready');
            setScopeGuardError('');
         }
      } catch (caught) {
         if (caught instanceof TaskaraClientError && caught.status === 409) {
            await forceScopeRefresh();
         } else if (protectedPull.current && mounted.current) {
            setScopeGuard('blocked');
            setScopeGuardError(caught instanceof Error ? caught.message : 'اتصال برای اعتبارسنجی دسترسی برقرار نشد.');
         }
      } finally {
         pulling.current = false;
         protectedPull.current = false;
      }
   }, [accessEpoch, applyBootstrap, epochIsCurrent, forceScopeRefresh]);

   useEffect(() => {
      const refreshProjection = () => void pull(true);
      const onVisibility = () => {
         if (document.visibilityState === 'visible') refreshProjection();
      };
      const interval = window.setInterval(() => {
         if (document.visibilityState === 'visible') void pull(false);
      }, 30_000);
      window.addEventListener('focus', refreshProjection);
      window.addEventListener('online', refreshProjection);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('focus', refreshProjection);
         window.removeEventListener('online', refreshProjection);
         document.removeEventListener('visibilitychange', onVisibility);
      };
   }, [pull]);

   useEffect(() => {
      void bootstrap().catch(() => undefined);
   }, [bootstrap]);

   useEffect(() => {
      if (!cursorRef.current) return;
      const controller = new AbortController();
      void consumeSupportSyncStream({
         accessEpoch,
         clientId: streamClientId.current,
         getCursor: () => cursorRef.current,
         signal: controller.signal,
         onScopeReset: () => void forceScopeRefresh(),
         onSync: () => void pull(false),
      });
      return () => controller.abort();
   }, [accessEpoch, forceScopeRefresh, partitionKey, pull, streamGeneration]);

   const loadCases = useCallback((query: SupportCaseListQuery) => run(`cases:${JSON.stringify(query)}`, async () => {
      const result = normalizePage(await supportClient.listCases(query));
      if (mounted.current) {
         if (!epochIsCurrent(result.accessEpoch)) {
            await forceScopeRefresh();
            return result;
         }
         if (query.queue) {
            authoritativeQueuePages.current.add(query.queue);
            dispatch({
               type: query.cursor ? 'append-queue' : 'set-queue',
               queue: query.queue,
               cases: result.items,
               total: result.total,
            });
         }
         else dispatch({ type: 'upsert-cases', cases: result.items });
         if (result.counts) dispatch({ type: 'set-counts', counts: normalizeQueueCounts(result.counts) });
      }
      return result;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const search = useCallback((query: string, limit = 20) => run(`search:${query}:${limit}`, async () => {
      const result = await supportClient.search(query, limit);
      if (!epochIsCurrent(result.accessEpoch)) {
         await forceScopeRefresh();
         return { ...result, cases: [], contacts: [] };
      }
      if (mounted.current) dispatch({ type: 'upsert-cases', cases: result.cases });
      return result;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const loadCase = useCallback((idOrKey: string) => run(`case:${idOrKey}`, async () => {
      try {
         const detail = await supportClient.getCase(idOrKey);
         const item = caseFromDetail(detail);
         if (mounted.current) {
            if (!epochIsCurrent(item.accessEpoch)) {
               await forceScopeRefresh();
               return item;
            }
            dispatch({ type: 'upsert-cases', cases: [item] });
            if ('case' in detail && detail.interactions) {
               dispatch({ type: 'set-interactions', caseId: item.id, interactions: detail.interactions });
            }
         }
         return item;
      } catch (caught) {
         const knownId = caseIdByKeyRef.current[idOrKey] || idOrKey;
         if (mounted.current) dispatch({ type: 'remove-case', caseId: knownId });
         throw caught;
      }
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const loadInteractions = useCallback((idOrKey: string) => run(`interactions:${idOrKey}`, async () => {
      const item = casesByIdRef.current[caseIdByKeyRef.current[idOrKey] || idOrKey];
      const result = normalizePage(await supportClient.listInteractions(idOrKey));
      if (!epochIsCurrent(result.accessEpoch)) {
         await forceScopeRefresh();
         return [];
      }
      if (mounted.current && item) dispatch({ type: 'set-interactions', caseId: item.id, interactions: result.items });
      return result.items;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const loadEvents = useCallback((idOrKey: string) => run(`events:${idOrKey}`, async () => {
      const item = casesByIdRef.current[caseIdByKeyRef.current[idOrKey] || idOrKey];
      const result = normalizePage(await supportClient.listEvents(idOrKey));
      if (!epochIsCurrent(result.accessEpoch)) {
         await forceScopeRefresh();
         return [];
      }
      if (mounted.current && item) dispatch({ type: 'set-events', caseId: item.id, events: result.items });
      return result.items;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const loadDepartments = useCallback(() => run('departments', async () => {
      const response = await supportClient.listDepartments();
      if (!epochIsCurrent(response.accessEpoch)) {
         await forceScopeRefresh();
         return [];
      }
      const departments = normalizeItems(response);
      if (mounted.current) dispatch({ type: 'set-departments', departments });
      return departments;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const createDepartment = useCallback((input: { name: string; slug: string; description?: string }) =>
      run('department:create', async () => {
         const department = await supportClient.createDepartment(input);
         if (mounted.current) dispatch({ type: 'upsert-department', department });
         await runtime.refresh();
         return department;
      }), [run, runtime]);

   const updateDepartment = useCallback((id: string, input: Partial<Pick<SupportDepartment, 'name' | 'description' | 'active'>>) =>
      run(`department:update:${id}`, async () => {
         const department = await supportClient.updateDepartment(id, input);
         if (mounted.current) dispatch({ type: 'upsert-department', department });
         return department;
      }), [run]);

   const loadDepartmentMembers = useCallback((departmentId: string) => run(`department:members:${departmentId}`, async () => {
      const response = await supportClient.listDepartmentMembers(departmentId);
      if (!epochIsCurrent(response.accessEpoch)) {
         await forceScopeRefresh();
         return [];
      }
      const members = normalizeItems(response);
      if (mounted.current) dispatch({ type: 'set-members', departmentId, members });
      return members;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const addDepartmentMember = useCallback((departmentId: string, input: { userId: string; role: 'MEMBER' | 'MANAGER' }) =>
      run(`department:member:add:${departmentId}`, async () => {
         const member = await supportClient.addDepartmentMember(departmentId, input);
         const current = state.membersByDepartmentId[departmentId] || [];
         if (mounted.current) dispatch({ type: 'set-members', departmentId, members: [...current.filter((item) => item.userId !== member.userId), member] });
         await runtime.refresh();
         return member;
      }), [run, runtime, state.membersByDepartmentId]);

   const updateDepartmentMember = useCallback((departmentId: string, userId: string, input: { role?: 'MEMBER' | 'MANAGER'; active?: boolean }) =>
      run(`department:member:update:${departmentId}:${userId}`, async () => {
         const member = await supportClient.updateDepartmentMember(departmentId, userId, input);
         const current = state.membersByDepartmentId[departmentId] || [];
         if (mounted.current) dispatch({ type: 'set-members', departmentId, members: current.map((item) => item.userId === member.userId ? member : item) });
         await runtime.refresh();
         return member;
      }), [run, runtime, state.membersByDepartmentId]);

   const removeDepartmentMember = useCallback((departmentId: string, userId: string) =>
      run(`department:member:remove:${departmentId}:${userId}`, async () => {
         await supportClient.removeDepartmentMember(departmentId, userId);
         const current = state.membersByDepartmentId[departmentId] || [];
         if (mounted.current) dispatch({ type: 'set-members', departmentId, members: current.filter((item) => item.userId !== userId) });
         await runtime.refresh();
      }), [run, runtime, state.membersByDepartmentId]);

   const loadGrants = useCallback(() => run('grants', async () => {
      const response = await supportClient.listPermissionGrants();
      if (!epochIsCurrent(response.accessEpoch)) {
         await forceScopeRefresh();
         return [];
      }
      const grants = normalizeItems(response);
      if (mounted.current) dispatch({ type: 'set-grants', grants });
      return grants;
   }), [epochIsCurrent, forceScopeRefresh, run]);

   const setGrant = useCallback((input: { userId: string; role: 'TRIAGER' | 'SUPERVISOR' }) =>
      run(`grant:set:${input.userId}`, async () => {
         const grant = await supportClient.setPermissionGrant(input);
         if (mounted.current) dispatch({ type: 'upsert-grant', grant });
         await runtime.refresh();
         return grant;
      }), [run, runtime]);

   const removeGrant = useCallback((userId: string, role?: 'TRIAGER' | 'SUPERVISOR') => run(`grant:remove:${userId}:${role || 'all'}`, async () => {
      const targets = role ? [role] : Object.values(state.grantsByUserId)
         .filter((grant) => grant.userId === userId)
         .map((grant) => grant.role);
      await Promise.all(targets.map((targetRole) => supportClient.removePermissionGrant(userId, targetRole)));
      if (mounted.current) dispatch({ type: 'remove-grant', userId, role });
      await runtime.refresh();
   }), [run, runtime, state.grantsByUserId]);

   const acceptMutation = useCallback((result: Awaited<ReturnType<typeof supportClient.routeCase>>) => {
      const item = caseFromMutation(result);
      if (mounted.current) {
         const resultEpoch = 'accessEpoch' in result ? result.accessEpoch : item.accessEpoch;
         if (!epochIsCurrent(resultEpoch)) {
            void forceScopeRefresh();
            return item;
         }
         dispatch({ type: 'upsert-cases', cases: [item] });
         authoritativeQueuePages.current.clear();
         dispatch({ type: 'invalidate-queues' });
         if ('interaction' in result && result.interaction) {
            dispatch({ type: 'upsert-interaction', caseId: item.id, interaction: result.interaction });
         }
      }
      void bootstrap().catch(() => undefined);
      return item;
   }, [bootstrap, epochIsCurrent, forceScopeRefresh]);

   const createCase = useCallback((input: CreateSupportCaseInput) => run('case:create', async () => acceptMutation(await supportClient.createCase(input))), [acceptMutation, run]);
   const createCall = useCallback((input: CreateSupportCallInput) => run('call:create', async () => acceptMutation(await supportClient.createCall(input))), [acceptMutation, run]);
   const routeCase = useCallback((item: SupportCase, input: { targetDepartmentId: string; targetAssigneeMembershipId?: string | null; reason?: string }) =>
      run(`case:route:${item.id}`, async () => acceptMutation(await supportClient.routeCase(item.key, { ...input, baseVersion: item.version }))), [acceptMutation, run]);
   const waitCase = useCallback((item: SupportCase, input: { status: 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL'; waitingReason?: string; nextActionAt: string }) =>
      run(`case:wait:${item.id}`, async () => acceptMutation(await supportClient.waitCase(item.key, input.status === 'WAITING_ON_INTERNAL'
         ? { status: input.status, waitingReason: input.waitingReason || 'نیازمند پیگیری داخلی', nextActionAt: input.nextActionAt, baseVersion: item.version }
         : { status: input.status, nextActionAt: input.nextActionAt, baseVersion: item.version }
      ))), [acceptMutation, run]);
   const resolveCase = useCallback((item: SupportCase, input: { resolutionCode: string; resolutionSummary: string; duplicateOfCaseId?: string }) =>
      run(`case:resolve:${item.id}`, async () => acceptMutation(await supportClient.resolveCase(item.key, { ...input, baseVersion: item.version }))), [acceptMutation, run]);
   const closeCase = useCallback((item: SupportCase, input: { confirmation: 'CUSTOMER_CONFIRMED' | 'POLICY_WINDOW_ELAPSED' | 'ADMIN_OVERRIDE'; reason?: string }) =>
      run(`case:close:${item.id}`, async () => acceptMutation(await supportClient.closeCase(item.key, { ...input, baseVersion: item.version }))), [acceptMutation, run]);
   const reopenCase = useCallback((item: SupportCase, reason: string) =>
      run(`case:reopen:${item.id}`, async () => acceptMutation(await supportClient.reopenCase(item.key, { reason, baseVersion: item.version }))), [acceptMutation, run]);
   const snoozeCase = useCallback((item: SupportCase, input: { snoozedUntil: string; reason: string }) =>
      run(`case:snooze:${item.id}`, async () => acceptMutation(await supportOperationsClient.snoozeCase(item.key, {
         snoozedUntil: input.snoozedUntil,
         reason: input.reason,
         baseVersion: item.version,
      }))), [acceptMutation, run]);
   const resumeCase = useCallback((item: SupportCase, reason: string) =>
      run(`case:resume:${item.id}`, async () => acceptMutation(await supportOperationsClient.resumeCase(item.key, {
         reason,
         baseVersion: item.version,
      }))), [acceptMutation, run]);
   const addInteraction = useCallback((item: SupportCase, input: { kind: 'MESSAGE' | 'CALL' | 'NOTE'; visibility: 'PUBLIC' | 'INTERNAL'; channel: 'API' | 'CALL' | 'MANUAL' | 'EMAIL' | 'MESSAGING'; direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL'; content?: { body: string; format: 'text/plain' | 'text/markdown' } }) =>
      run(`case:interaction:${item.id}`, async () => acceptMutation(await supportClient.addInteraction(item.key, { ...input, baseVersion: item.version }))), [acceptMutation, run]);

   const controller = useMemo<SupportWorkspaceController>(() => ({
      identityKey: runtime.identityKey,
      accessEpoch,
      partitionKey,
      state,
      casesById: state.casesById,
      queueCounts: state.queueCounts,
      departments: Object.values(state.departmentsById).sort((left, right) => left.name.localeCompare(right.name, 'fa')),
      grants: Object.values(state.grantsByUserId),
      access: state.access,
      interactionContentAvailable: state.interactionContentAvailable ?? runtime.me.support?.interactionContentAvailable === true,
      manualCallAvailable: state.manualCallAvailable ?? runtime.me.support?.manualCallAvailable === true,
      busy: (operation) => operations.has(operation),
      error,
      clearError: () => setError(''),
      caseByIdOrKey: (idOrKey) => state.casesById[state.caseIdByKey[idOrKey] || idOrKey],
      casesForQueue: (queue) => (state.queueCaseIds[queue] || []).flatMap((id) => state.casesById[id] ? [state.casesById[id]] : []),
      bootstrap,
      loadCases,
      search,
      loadCase,
      loadInteractions,
      loadEvents,
      loadDepartments,
      createDepartment,
      updateDepartment,
      loadDepartmentMembers,
      addDepartmentMember,
      updateDepartmentMember,
      removeDepartmentMember,
      loadGrants,
      setGrant,
      removeGrant,
      createCase,
      createCall,
      routeCase,
      waitCase,
      resolveCase,
      closeCase,
      reopenCase,
      snoozeCase,
      resumeCase,
      addInteraction,
   }), [
      accessEpoch, addDepartmentMember, addInteraction, bootstrap, closeCase, createCall, createCase,
      createDepartment, error, loadCase, loadCases, loadDepartmentMembers, loadDepartments, loadGrants,
      loadInteractions, loadEvents, operations, partitionKey, removeDepartmentMember, removeGrant, reopenCase, resumeCase, resolveCase,
      routeCase, runtime.identityKey, runtime.me.support?.interactionContentAvailable, search,
      runtime.me.support?.manualCallAvailable, setGrant, snoozeCase, state,
      updateDepartment, updateDepartmentMember, waitCase,
   ]);

   if (scopeGuard !== 'ready') {
      return (
         <SupportScopeGuardScreen
            error={scopeGuard === 'blocked' ? scopeGuardError : ''}
            onRetry={() => void forceScopeRefresh()}
         />
      );
   }
   return <SupportWorkspaceContext.Provider value={controller}>{children}</SupportWorkspaceContext.Provider>;
}

function SupportScopeGuardScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
   return (
      <main
         dir="rtl"
         className="flex h-dvh items-center justify-center bg-[#050506] p-6 text-zinc-200"
         data-testid="support-scope-guard"
      >
         <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#101011] p-6 text-center">
            <div aria-live="polite" role={error ? 'alert' : 'status'}>
               <h1 className="text-sm font-semibold">
                  {error ? 'دسترسی دوباره تأیید نشد' : 'در حال بررسی دوباره دسترسی…'}
               </h1>
               <p className="mt-2 text-sm leading-7 text-zinc-500">
                  {error || 'برای حفاظت از اطلاعات مشتری، پرونده‌ها تا دریافت محدوده دسترسی تازه پنهان می‌مانند.'}
               </p>
            </div>
            {error ? (
               <button
                  className="mt-5 rounded-lg border border-white/10 bg-white/8 px-4 py-2 text-sm text-zinc-200 hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  type="button"
                  onClick={onRetry}
               >
                  تلاش دوباره
               </button>
            ) : null}
         </div>
      </main>
   );
}

async function consumeSupportSyncStream(input: {
   accessEpoch: string | number;
   clientId: string;
   getCursor: () => string | null;
   signal: AbortSignal;
   onScopeReset: () => void;
   onSync: () => void;
}): Promise<void> {
   while (!input.signal.aborted) {
      const cursor = input.getCursor();
      if (!cursor) return;
      try {
         const query = new URLSearchParams({
            accessEpoch: String(input.accessEpoch),
            clientId: input.clientId,
            cursor,
         });
         const response = await fetch(`${taskaraApiBaseUrl()}/support/sync/stream?${query.toString()}`, {
            headers: taskaraRequestHeaders({ headers: { accept: 'text/event-stream' } }),
            cache: 'no-store',
            signal: input.signal,
         });
         if (response.status === 401) {
            clearAuthSession();
            return;
         }
         if (response.status === 409) {
            input.onScopeReset();
            return;
         }
         // Deployments may intentionally disable streaming; focus/online/interval pull remains the
         // safe fallback and avoids a hot reconnect loop for an explicit refusal.
         if (response.status === 204 || response.status === 403 || response.status === 404) return;
         if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
            throw new Error('Support sync stream failed.');
         }
         let scopeInvalidated = false;
         await readSupportSse(response, input.signal, (event) => {
            const wakeup = supportWakeupFromSse(event.data);
            if (event.event === 'scopeReset' || wakeup?.type === 'scopeReset') {
               scopeInvalidated = true;
               input.onScopeReset();
               return;
            }
            if (wakeup && String(wakeup.accessEpoch) !== String(input.accessEpoch)) {
               scopeInvalidated = true;
               input.onScopeReset();
               return;
            }
            if (event.event === 'sync' || event.event === 'ready' || wakeup?.type === 'sync') input.onSync();
         });
         if (scopeInvalidated || input.signal.aborted) return;
      } catch {
         if (input.signal.aborted) return;
      }
      await supportStreamDelay(1_500, input.signal);
   }
}

async function readSupportSse(
   response: Response,
   signal: AbortSignal,
   onEvent: (event: { event: string; data: string }) => void
): Promise<void> {
   const reader = response.body?.getReader();
   if (!reader) return;
   const decoder = new TextDecoder();
   let buffer = '';
   while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
         const event = parseSupportSseEvent(buffer.slice(0, boundary));
         buffer = buffer.slice(boundary + 2);
         if (event) onEvent(event);
         boundary = buffer.indexOf('\n\n');
      }
   }
}

function parseSupportSseEvent(raw: string): { event: string; data: string } | null {
   let event = 'message';
   const data: string[] = [];
   for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
   }
   return data.length || event !== 'message' ? { event, data: data.join('\n') } : null;
}

function supportWakeupFromSse(data: string): { type: 'sync' | 'scopeReset'; accessEpoch: string | number } | null {
   try {
      const value = JSON.parse(data) as Record<string, unknown>;
      if (
         (value.type === 'sync' || value.type === 'scopeReset')
         && (typeof value.accessEpoch === 'string' || typeof value.accessEpoch === 'number')
      ) {
         return { type: value.type, accessEpoch: value.accessEpoch };
      }
   } catch {
      // Malformed or extension events do not mutate state; the periodic pull remains authoritative.
   }
   return null;
}

function supportStreamDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
   return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
         window.clearTimeout(timer);
         resolve();
      }, { once: true });
   });
}

export function useSupportWorkspace(): SupportWorkspaceController {
   const support = useContext(SupportWorkspaceContext);
   if (!support) throw new Error('useSupportWorkspace must be used inside SupportWorkspaceProvider.');
   return support;
}

function normalizePage<T>(value: SupportPage<T> | T[]): SupportPage<T> {
   return Array.isArray(value) ? { items: value, total: value.length } : value;
}

function grantKey(grant: Pick<SupportPermissionGrant, 'userId' | 'role'>): string {
   return `${grant.userId}:${grant.role}`;
}

function normalizeCase(item: SupportCase): SupportCase {
   if (item.assignee || !item.assigneeMembership) return item;
   return { ...item, assignee: item.assigneeMembership };
}

export function normalizeQueueCounts(
   counts: Partial<Record<SupportQueueKind, number>> & {
      triage?: number;
      departmentInbox?: number;
      myCases?: number;
      needsAttention?: number;
   }
): Partial<Record<SupportQueueKind, number>> {
   return {
      ...(typeof counts.TRIAGE === 'number' ? { TRIAGE: counts.TRIAGE } : {}),
      ...(typeof counts.DEPARTMENT_INBOX === 'number' ? { DEPARTMENT_INBOX: counts.DEPARTMENT_INBOX } : {}),
      ...(typeof counts.MY_CASES === 'number' ? { MY_CASES: counts.MY_CASES } : {}),
      ...(typeof counts.NEEDS_ATTENTION === 'number' ? { NEEDS_ATTENTION: counts.NEEDS_ATTENTION } : {}),
      ...(typeof counts.triage === 'number' ? { TRIAGE: counts.triage } : {}),
      ...(typeof counts.departmentInbox === 'number' ? { DEPARTMENT_INBOX: counts.departmentInbox } : {}),
      ...(typeof counts.myCases === 'number' ? { MY_CASES: counts.myCases } : {}),
      ...(typeof counts.needsAttention === 'number' ? { NEEDS_ATTENTION: counts.needsAttention } : {}),
   };
}

export function supportAccessEpochMatches(
   current: string | number,
   incoming: string | number | null | undefined
): boolean {
   return incoming === undefined || incoming === null || String(incoming) === String(current);
}

function normalizeItems<T>(value: T[] | { items: T[] }): T[] {
   return Array.isArray(value) ? value : value.items;
}

export function accessScopedInitialCounts(
   permissions: ReadonlySet<string>,
   summary?: { unassignedCount?: number; departmentInboxCount?: number; myCaseCount?: number; needsAttentionCount?: number }
): Partial<Record<SupportQueueKind, number>> {
   const counts: Partial<Record<SupportQueueKind, number>> = {};
   if (permissions.has('support.triage.read') && typeof summary?.unassignedCount === 'number') counts.TRIAGE = summary.unassignedCount;
   if (permissions.has('support.department-inbox.read') && typeof summary?.departmentInboxCount === 'number') counts.DEPARTMENT_INBOX = summary.departmentInboxCount;
   if (permissions.has('support.cases.mine.read') && typeof summary?.myCaseCount === 'number') counts.MY_CASES = summary.myCaseCount;
   if (permissions.has('support.recovery.read') && typeof summary?.needsAttentionCount === 'number') counts.NEEDS_ATTENTION = summary.needsAttentionCount;
   return counts;
}
