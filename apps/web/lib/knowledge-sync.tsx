import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { taskaraRequest } from '@/lib/taskara-client';
import { workspaceRefreshEvent, workspaceRefreshSourceMatches, type WorkspaceRefreshDetail } from '@/lib/live-refresh';
import type {
   PaginatedResponse,
   TaskaraKnowledgeComment,
   TaskaraKnowledgePage,
   TaskaraKnowledgeSpace,
   TaskaraProject,
   TaskaraTeam,
   TaskaraUser,
} from '@/lib/taskara-types';
import { workspaceUserCacheKey, type WorkspaceCachePersistence } from '@/lib/workspace-cache';
import type { WorkspaceMode } from '@/lib/workspace-mode';

type KnowledgeSnapshot = {
   commentsByPageId: Record<string, TaskaraKnowledgeComment[]>;
   pagesBySpaceId: Record<string, TaskaraKnowledgePage[]>;
   pageDetailsById: Record<string, TaskaraKnowledgePage>;
   projects: TaskaraProject[];
   savedAt: string;
   spaces: TaskaraKnowledgeSpace[];
   teams: TaskaraTeam[];
   users: TaskaraUser[];
};

type KnowledgeSyncState = Omit<KnowledgeSnapshot, 'savedAt'> & {
   detailsLoadingByPageId: Record<string, boolean>;
   error: string;
   loading: boolean;
   pagesLoadingBySpaceId: Record<string, boolean>;
};

export type WorkspaceKnowledgeSyncController = {
   commentsByPageId: Record<string, TaskaraKnowledgeComment[]>;
   detailsLoadingByPageId: Record<string, boolean>;
   error: string;
   loadPageDetails: (pageId: string) => Promise<TaskaraKnowledgePage | null>;
   loadPages: (space: TaskaraKnowledgeSpace, options?: { force?: boolean }) => Promise<TaskaraKnowledgePage[]>;
   loading: boolean;
   pagesBySpaceId: Record<string, TaskaraKnowledgePage[]>;
   pageDetailsById: Record<string, TaskaraKnowledgePage>;
   pagesLoadingBySpaceId: Record<string, boolean>;
   projects: TaskaraProject[];
   refresh: () => Promise<void>;
   setCommentsForPage: (pageId: string, comments: TaskaraKnowledgeComment[]) => void;
   setPage: (page: TaskaraKnowledgePage) => void;
   setPagesForSpace: (spaceId: string, pages: TaskaraKnowledgePage[]) => void;
   setSpaces: (spaces: TaskaraKnowledgeSpace[]) => void;
   spaces: TaskaraKnowledgeSpace[];
   teams: TaskaraTeam[];
   users: TaskaraUser[];
};

const KnowledgeSyncContext = createContext<WorkspaceKnowledgeSyncController | null>(null);
const knowledgeCachePrefix = 'taskara.knowledge.v1:';
const knowledgeWarmRefreshIntervalMs = 120000;
const knowledgeRefreshOrigin = 'knowledge-view';

export function WorkspaceKnowledgeSyncProvider({
   children,
   mode,
   persistence = 'local',
   userId,
   workspaceSlug,
}: {
   children: ReactNode;
   mode: WorkspaceMode;
   persistence?: WorkspaceCachePersistence;
   userId: string;
   workspaceSlug: string;
}) {
   const controller = useKnowledgeSync(workspaceSlug, userId, mode, persistence);
   return <KnowledgeSyncContext.Provider value={controller}>{children}</KnowledgeSyncContext.Provider>;
}

export function useWorkspaceKnowledgeSync(): WorkspaceKnowledgeSyncController {
   const sync = useContext(KnowledgeSyncContext);
   if (!sync) throw new Error('useWorkspaceKnowledgeSync must be used inside WorkspaceKnowledgeSyncProvider.');
   return sync;
}

function useKnowledgeSync(
   workspaceSlug: string,
   userId: string,
   mode: WorkspaceMode,
   persistence: WorkspaceCachePersistence
): WorkspaceKnowledgeSyncController {
   const cacheKey = useMemo(
      () => workspaceUserCacheKey(knowledgeCachePrefix, workspaceSlug, userId, persistence),
      [persistence, userId, workspaceSlug]
   );
   const [state, setState] = useState<KnowledgeSyncState>({
      commentsByPageId: {},
      detailsLoadingByPageId: {},
      error: '',
      loading: true,
      pagesBySpaceId: {},
      pagesLoadingBySpaceId: {},
      pageDetailsById: {},
      projects: [],
      spaces: [],
      teams: [],
      users: [],
   });

   const saveSnapshot = useCallback(
      (snapshot: Omit<KnowledgeSnapshot, 'savedAt'>) => {
         if (typeof window === 'undefined' || !cacheKey) return;
         try {
            window.localStorage.setItem(
               cacheKey,
               JSON.stringify({
                  ...snapshot,
                  savedAt: new Date().toISOString(),
               } satisfies KnowledgeSnapshot)
            );
         } catch {
            // Cache writes are best effort. The API remains authoritative.
         }
      },
      [cacheKey]
   );

   const persistFromState = useCallback(
      (next: Omit<KnowledgeSyncState, 'detailsLoadingByPageId' | 'error' | 'loading' | 'pagesLoadingBySpaceId'>) => {
         saveSnapshot({
            commentsByPageId: next.commentsByPageId,
            pagesBySpaceId: next.pagesBySpaceId,
            pageDetailsById: next.pageDetailsById,
            projects: next.projects,
            spaces: next.spaces,
            teams: next.teams,
            users: next.users,
         });
      },
      [saveSnapshot]
   );

   const refresh = useCallback(async () => {
      setState((current) => ({ ...current, error: '', loading: current.spaces.length === 0 }));
      try {
         const [spaceResult, userResult, teamResult, projectResult] = await Promise.all([
            taskaraRequest<TaskaraKnowledgeSpace[]>('/knowledge/spaces'),
            taskaraRequest<PaginatedResponse<TaskaraUser>>('/users?limit=200').catch(() => ({
               items: [],
               total: 0,
               limit: 0,
               offset: 0,
            })),
            mode === 'TEAM' ? taskaraRequest<TaskaraTeam[]>('/teams').catch(() => []) : Promise.resolve([]),
            mode === 'TEAM' ? taskaraRequest<TaskaraProject[]>('/projects').catch(() => []) : Promise.resolve([]),
         ]);

         setState((current) => {
            const next = {
               ...current,
               error: '',
               loading: false,
               projects: projectResult,
               spaces: spaceResult,
               teams: teamResult,
               users: userResult.items,
            };
            persistFromState(next);
            return next;
         });

         await Promise.all(spaceResult.map((space) => loadPagesForSpace(space, { persistFromState, setState })));
      } catch (err) {
         setState((current) => ({
            ...current,
            error: err instanceof Error ? err.message : 'Knowledge sync failed.',
            loading: false,
         }));
      }
   }, [mode, persistFromState]);

   const loadPages = useCallback(
      async (space: TaskaraKnowledgeSpace, options: { force?: boolean } = {}) => {
         if (!options.force && state.pagesBySpaceId[space.id]?.length) return state.pagesBySpaceId[space.id];
         return loadPagesForSpace(space, { persistFromState, setState });
      },
      [persistFromState, state.pagesBySpaceId]
   );

   const loadPageDetails = useCallback(
      async (pageId: string) => {
         setState((current) => ({
            ...current,
            detailsLoadingByPageId: { ...current.detailsLoadingByPageId, [pageId]: true },
            error: '',
         }));
         try {
            const [pageResult, commentsResult] = await Promise.all([
               taskaraRequest<TaskaraKnowledgePage>(`/knowledge/pages/${encodeURIComponent(pageId)}`),
               taskaraRequest<TaskaraKnowledgeComment[]>(`/knowledge/pages/${encodeURIComponent(pageId)}/comments`).catch(() => []),
            ]);
            setState((current) => {
               const pagesForSpace = current.pagesBySpaceId[pageResult.spaceId] || [];
               const next = {
                  ...current,
                  commentsByPageId: { ...current.commentsByPageId, [pageId]: commentsResult },
                  detailsLoadingByPageId: { ...current.detailsLoadingByPageId, [pageId]: false },
                  error: '',
                  pagesBySpaceId: {
                     ...current.pagesBySpaceId,
                     [pageResult.spaceId]: upsertKnowledgePage(pagesForSpace, pageResult),
                  },
                  pageDetailsById: { ...current.pageDetailsById, [pageId]: pageResult },
               };
               persistFromState(next);
               return next;
            });
            return pageResult;
         } catch (err) {
            setState((current) => ({
               ...current,
               detailsLoadingByPageId: { ...current.detailsLoadingByPageId, [pageId]: false },
               error: err instanceof Error ? err.message : 'Knowledge sync failed.',
            }));
            return null;
         }
      },
      [persistFromState]
   );

   const setSpaces = useCallback(
      (spaces: TaskaraKnowledgeSpace[]) => {
         setState((current) => {
            const next = { ...current, spaces };
            persistFromState(next);
            return next;
         });
      },
      [persistFromState]
   );

   const setPagesForSpace = useCallback(
      (spaceId: string, pages: TaskaraKnowledgePage[]) => {
         setState((current) => {
            const pageDetailsById = { ...current.pageDetailsById };
            for (const page of pages) pageDetailsById[page.id] = page;
            const next = {
               ...current,
               pagesBySpaceId: { ...current.pagesBySpaceId, [spaceId]: pages },
               pageDetailsById,
            };
            persistFromState(next);
            return next;
         });
      },
      [persistFromState]
   );

   const setPage = useCallback(
      (page: TaskaraKnowledgePage) => {
         setState((current) => {
            const pagesForSpace = current.pagesBySpaceId[page.spaceId] || [];
            const next = {
               ...current,
               pagesBySpaceId: {
                  ...current.pagesBySpaceId,
                  [page.spaceId]: upsertKnowledgePage(pagesForSpace, page),
               },
               pageDetailsById: { ...current.pageDetailsById, [page.id]: page },
            };
            persistFromState(next);
            return next;
         });
      },
      [persistFromState]
   );

   const setCommentsForPage = useCallback(
      (pageId: string, comments: TaskaraKnowledgeComment[]) => {
         setState((current) => {
            const next = {
               ...current,
               commentsByPageId: { ...current.commentsByPageId, [pageId]: comments },
            };
            persistFromState(next);
            return next;
         });
      },
      [persistFromState]
   );

   useEffect(() => {
      let restored = false;
      try {
         const raw = typeof window === 'undefined' || !cacheKey ? null : window.localStorage.getItem(cacheKey);
         const snapshot = raw ? JSON.parse(raw) : null;
         if (isKnowledgeSnapshot(snapshot)) {
            restored = true;
            setState((current) => ({
               ...current,
               commentsByPageId: snapshot.commentsByPageId,
               error: '',
               loading: false,
               pagesBySpaceId: snapshot.pagesBySpaceId,
               pageDetailsById: snapshot.pageDetailsById,
               projects: snapshot.projects,
               spaces: snapshot.spaces,
               teams: snapshot.teams,
               users: snapshot.users,
            }));
         }
      } catch {
         // Ignore corrupted cache and rehydrate from the API.
      }

      if (!restored) {
         setState({
            commentsByPageId: {},
            detailsLoadingByPageId: {},
            error: '',
            loading: true,
            pagesBySpaceId: {},
            pagesLoadingBySpaceId: {},
            pageDetailsById: {},
            projects: [],
            spaces: [],
            teams: [],
            users: [],
         });
      }
      void refresh();
   }, [cacheKey, refresh]);

   useEffect(() => {
      const refreshWarmData = () => {
         if (document.visibilityState === 'hidden') return;
         void refresh();
      };
      const handlePageShow = (event: PageTransitionEvent) => {
         if (event.persisted) void refresh();
      };
      const handleWorkspaceRefresh = (event: Event) => {
         const detail = workspaceRefreshDetailFromEvent(event);
         if (detail.origin === knowledgeRefreshOrigin) return;
         if (workspaceRefreshSourceMatches(detail, 'knowledge')) void refresh();
      };
      const interval = window.setInterval(refreshWarmData, knowledgeWarmRefreshIntervalMs);

      window.addEventListener('online', refreshWarmData);
      window.addEventListener('pageshow', handlePageShow);
      window.addEventListener('taskara:auth-changed', refreshWarmData);
      window.addEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
      return () => {
         window.clearInterval(interval);
         window.removeEventListener('online', refreshWarmData);
         window.removeEventListener('pageshow', handlePageShow);
         window.removeEventListener('taskara:auth-changed', refreshWarmData);
         window.removeEventListener(workspaceRefreshEvent, handleWorkspaceRefresh);
      };
   }, [refresh]);

   return {
      commentsByPageId: state.commentsByPageId,
      detailsLoadingByPageId: state.detailsLoadingByPageId,
      error: state.error,
      loadPageDetails,
      loadPages,
      loading: state.loading,
      pagesBySpaceId: state.pagesBySpaceId,
      pageDetailsById: state.pageDetailsById,
      pagesLoadingBySpaceId: state.pagesLoadingBySpaceId,
      projects: state.projects,
      refresh,
      setCommentsForPage,
      setPage,
      setPagesForSpace,
      setSpaces,
      spaces: state.spaces,
      teams: state.teams,
      users: state.users,
   };
}

function workspaceRefreshDetailFromEvent(event: Event): WorkspaceRefreshDetail {
   if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') return {};
   const detail = event.detail as WorkspaceRefreshDetail;
   return {
      origin: typeof detail.origin === 'string' ? detail.origin : undefined,
      source: typeof detail.source === 'string' ? detail.source : undefined,
   };
}

async function loadPagesForSpace(
   space: TaskaraKnowledgeSpace,
   {
      persistFromState,
      setState,
   }: {
      persistFromState: (
         next: Omit<KnowledgeSyncState, 'detailsLoadingByPageId' | 'error' | 'loading' | 'pagesLoadingBySpaceId'>
      ) => void;
      setState: Dispatch<SetStateAction<KnowledgeSyncState>>;
   }
): Promise<TaskaraKnowledgePage[]> {
   setState((current) => ({
      ...current,
      pagesLoadingBySpaceId: { ...current.pagesLoadingBySpaceId, [space.id]: !current.pagesBySpaceId[space.id]?.length },
   }));

   try {
      const params = new URLSearchParams({ spaceId: space.id, limit: '200' });
      const result = await taskaraRequest<PaginatedResponse<TaskaraKnowledgePage>>(`/knowledge/pages?${params.toString()}`);
      setState((current) => {
         const pageDetailsById = { ...current.pageDetailsById };
         for (const page of result.items) pageDetailsById[page.id] = page;
         const next = {
            ...current,
            error: '',
            pagesBySpaceId: { ...current.pagesBySpaceId, [space.id]: result.items },
            pagesLoadingBySpaceId: { ...current.pagesLoadingBySpaceId, [space.id]: false },
            pageDetailsById,
         };
         persistFromState(next);
         return next;
      });
      return result.items;
   } catch (err) {
      setState((current) => ({
         ...current,
         error: err instanceof Error ? err.message : 'Knowledge sync failed.',
         pagesLoadingBySpaceId: { ...current.pagesLoadingBySpaceId, [space.id]: false },
      }));
      return [];
   }
}

function upsertKnowledgePage(items: TaskaraKnowledgePage[], page: TaskaraKnowledgePage): TaskaraKnowledgePage[] {
   const next = items.some((item) => item.id === page.id)
      ? items.map((item) => (item.id === page.id ? page : item))
      : [...items, page];
   return next.sort(compareKnowledgePages);
}

function compareKnowledgePages(a: TaskaraKnowledgePage, b: TaskaraKnowledgePage) {
   const positionDelta = (a.position || 0) - (b.position || 0);
   if (positionDelta !== 0) return positionDelta;
   return a.path.localeCompare(b.path, 'fa');
}

function isKnowledgeSnapshot(value: unknown): value is KnowledgeSnapshot {
   if (!value || typeof value !== 'object') return false;
   const snapshot = value as Partial<KnowledgeSnapshot>;
   return (
      typeof snapshot.savedAt === 'string' &&
      Array.isArray(snapshot.spaces) &&
      Array.isArray(snapshot.users) &&
      Array.isArray(snapshot.teams) &&
      Array.isArray(snapshot.projects) &&
      isRecord(snapshot.pagesBySpaceId) &&
      isRecord(snapshot.pageDetailsById) &&
      isRecord(snapshot.commentsByPageId)
   );
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
