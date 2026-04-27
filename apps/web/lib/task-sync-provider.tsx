import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useTaskSync, type TaskSyncController } from '@/lib/task-sync';

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
   const taskSync = useTaskSync(scope);

   return <TaskSyncContext.Provider value={taskSync}>{children}</TaskSyncContext.Provider>;
}

export function useWorkspaceTaskSync(): TaskSyncController {
   const taskSync = useContext(TaskSyncContext);
   if (!taskSync) throw new Error('useWorkspaceTaskSync must be used inside WorkspaceTaskSyncProvider.');
   return taskSync;
}
