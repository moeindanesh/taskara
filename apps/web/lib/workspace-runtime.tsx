import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraMe } from '@/lib/taskara-types';
import {
   normalizeWorkspaceMode,
   resolveWorkspaceCapabilities,
   type WorkspaceCapability,
   type WorkspaceMode,
} from '@/lib/workspace-mode';
import { getAuthSession, setAuthSession } from '@/store/auth-store';

export type WorkspaceRuntime = {
   workspaceSlug: string;
   identityKey: string;
   mode: WorkspaceMode;
   role: string | null;
   capabilities: ReadonlySet<WorkspaceCapability>;
   permissions: ReadonlySet<string>;
   me: TaskaraMe;
   refresh: () => Promise<void>;
};

type RuntimeState =
   | { status: 'loading' }
   | { status: 'error'; message: string }
   | { status: 'ready'; runtime: WorkspaceRuntime };

const WorkspaceRuntimeContext = createContext<WorkspaceRuntime | null>(null);

export function WorkspaceRuntimeBoundary({
   children,
   workspaceSlug,
}: {
   children: ReactNode;
   workspaceSlug: string;
}) {
   const mountedRef = useRef(true);
   const requestRef = useRef(0);
   const [state, setState] = useState<RuntimeState>({ status: 'loading' });

   const load = useCallback(async () => {
      const requestId = ++requestRef.current;
      setState((current) => current.status === 'ready' ? current : { status: 'loading' });

      try {
         const response = await taskaraRequest<TaskaraMe>('/me');
         if (!mountedRef.current || requestId !== requestRef.current) return;
         if (response.workspace.slug !== workspaceSlug) {
            setState({ status: 'error', message: 'پاسخ فضای کاری با نشانی درخواستی هم‌خوان نیست.' });
            return;
         }

         const mode = normalizeWorkspaceMode((response.workspace as { mode?: unknown }).mode);
         if (!mode) {
            setState({ status: 'error', message: 'نوع این فضای کاری در این نسخه پشتیبانی نمی‌شود.' });
            return;
         }

         const capabilities = resolveWorkspaceCapabilities(mode, response.capabilities);
         const permissions = new Set(
            Array.isArray(response.permissions)
               ? response.permissions.filter((value): value is string => typeof value === 'string')
               : []
         );
         const me: TaskaraMe = {
            ...response,
            workspace: { ...response.workspace, mode },
            capabilities: [...capabilities],
            permissions: [...permissions],
         };

         const runtime: WorkspaceRuntime = {
            workspaceSlug,
            identityKey: `${workspaceSlug}:${me.user.id}`,
            mode,
            role: me.role || null,
            capabilities,
            permissions,
            me,
            refresh: load,
         };

         const session = getAuthSession();
         if (session) {
            setAuthSession({
               ...session,
               user: me.user,
               workspace: me.workspace,
               role: me.role,
               capabilities: me.capabilities,
               permissions: me.permissions,
               supportAccessEpoch: me.supportAccessEpoch,
               support: me.support,
            });
         }
         setState({ status: 'ready', runtime });
      } catch (error) {
         if (!mountedRef.current || requestId !== requestRef.current) return;
         setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'بارگذاری فضای کاری ناموفق بود.',
         });
      }
   }, [workspaceSlug]);

   useEffect(() => {
      mountedRef.current = true;
      void load();
      return () => {
         mountedRef.current = false;
         requestRef.current += 1;
      };
   }, [load]);

   if (state.status === 'loading') return <WorkspaceRuntimeLoading />;
   if (state.status === 'error') return <WorkspaceRuntimeError message={state.message} />;

   return (
      <WorkspaceRuntimeContext.Provider value={state.runtime}>
         {children}
      </WorkspaceRuntimeContext.Provider>
   );
}

export function useWorkspaceRuntime(): WorkspaceRuntime {
   const runtime = useContext(WorkspaceRuntimeContext);
   if (!runtime) throw new Error('useWorkspaceRuntime must be used inside WorkspaceRuntimeBoundary.');
   return runtime;
}

export function useWorkspaceNavigationRuntime() {
   const runtime = useWorkspaceRuntime();
   return useMemo(
      () => ({
         mode: runtime.mode,
         role: runtime.role,
         capabilities: runtime.capabilities,
         permissions: runtime.permissions,
         support: runtime.me.support,
      }),
      [runtime.capabilities, runtime.me.support, runtime.mode, runtime.permissions, runtime.role]
   );
}

function WorkspaceRuntimeLoading() {
   return (
      <div dir="rtl" className="flex h-dvh items-center justify-center bg-[#050506] text-zinc-500">
         <Loader2 className="me-2 size-4 animate-spin" />
         در حال آماده‌سازی فضای کاری…
      </div>
   );
}

function WorkspaceRuntimeError({ message }: { message: string }) {
   return (
      <div dir="rtl" className="flex h-dvh items-center justify-center bg-[#050506] p-6 text-zinc-200">
         <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#101011] p-6 text-center">
            <ShieldAlert className="mx-auto mb-3 size-8 text-amber-400" />
            <h1 className="text-base font-semibold">فضای کاری باز نشد</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500">{message}</p>
            <Link className="mt-5 inline-flex rounded-lg bg-white/8 px-3 py-2 text-sm hover:bg-white/12" to="/onboarding">
               انتخاب فضای کاری دیگر
            </Link>
         </div>
      </div>
   );
}
