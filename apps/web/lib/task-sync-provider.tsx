import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { fa } from '@/lib/fa-copy';
import {
   taskSyncMutationFailuresEvent,
   useTaskSync,
   type TaskSyncController,
   type TaskSyncMutationFailureEventDetail,
} from '@/lib/task-sync';

const TaskSyncContext = createContext<TaskSyncController | null>(null);

export function WorkspaceTaskSyncProvider({
   children,
   workspaceSlug,
}: {
   children: ReactNode;
   workspaceSlug: string;
}) {
   const scope = useMemo(
      () => ({ workspaceSlug, teamId: 'all', mine: false }),
      [workspaceSlug]
   );
   useTaskSyncMutationFailureToasts();
   const taskSync = useTaskSync(scope);

   return <TaskSyncContext.Provider value={taskSync}>{children}</TaskSyncContext.Provider>;
}

export function useWorkspaceTaskSync(): TaskSyncController {
   const taskSync = useContext(TaskSyncContext);
   if (!taskSync) throw new Error('useWorkspaceTaskSync must be used inside WorkspaceTaskSyncProvider.');
   return taskSync;
}

function useTaskSyncMutationFailureToasts() {
   useEffect(() => {
      const handleFailures = (event: Event) => {
         const failures = (event as CustomEvent<TaskSyncMutationFailureEventDetail>).detail?.failures || [];
         if (failures.length === 0) return;

         if (failures.length === 1) {
            const failure = failures[0];
            toast.error(failure.userMessage);
            return;
         }

         toast.error(fa.sync.mutationFailureSummary(failures.length), {
            description: failures[0]?.userMessage,
         });
      };

      window.addEventListener(taskSyncMutationFailuresEvent, handleFailures);
      return () => window.removeEventListener(taskSyncMutationFailuresEvent, handleFailures);
   }, []);
}
