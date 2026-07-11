'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTask } from '@/lib/taskara-types';
import type { TaskaraMilestone, TaskaraMilestoneKind } from '@/lib/taskara-types';
import { useAuthSession } from '@/store/auth-store';
import { MilestoneCreateDialog } from './milestone-create-dialog';

export const createMilestoneEvent = 'taskara:create-milestone';

export type CreateMilestoneEventDetail = {
   assignTaskId?: string;
   assignTaskKey?: string;
   kind?: TaskaraMilestoneKind;
   navigateOnCreate?: boolean;
   projectId?: string;
};

export function openMilestoneCreate(detail: CreateMilestoneEventDetail = {}) {
   window.dispatchEvent(new CustomEvent<CreateMilestoneEventDetail>(createMilestoneEvent, { detail }));
}

export function MilestoneDialogHost() {
   const navigate = useNavigate();
   const { session } = useAuthSession();
   const taskSync = useWorkspaceTaskSync();
   const [open, setOpen] = useState(false);
   const [request, setRequest] = useState<CreateMilestoneEventDetail>({});

   useEffect(() => {
      const handleOpen = (event: Event) => {
         const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
            ? event.detail as CreateMilestoneEventDetail
            : {};
         setRequest({
            assignTaskId: typeof detail.assignTaskId === 'string' ? detail.assignTaskId : undefined,
            assignTaskKey: typeof detail.assignTaskKey === 'string' ? detail.assignTaskKey : undefined,
            kind: detail.kind === 'PHASE' || detail.kind === 'OTHER' ? detail.kind : 'FEATURE',
            navigateOnCreate: detail.navigateOnCreate === true,
            projectId: typeof detail.projectId === 'string' ? detail.projectId : undefined,
         });
         setOpen(true);
      };

      window.addEventListener(createMilestoneEvent, handleOpen);
      return () => window.removeEventListener(createMilestoneEvent, handleOpen);
   }, []);

   const handleCreated = useCallback(async (milestone: TaskaraMilestone) => {
      const task = taskSync.tasks.find(
         (item) => item.id === request.assignTaskId || item.key === request.assignTaskKey
      );

      if (task) {
         try {
            await taskSync.updateTask(task, { milestoneId: milestone.id });
            toast.success('مایلستون ساخته و به کار متصل شد.');
         } catch (error) {
            toast.error(error instanceof Error ? error.message : 'مایلستون ساخته شد، اما اتصال کار ناموفق بود.');
         }
      } else if (request.assignTaskKey || request.assignTaskId) {
         try {
            await taskaraRequest<TaskaraTask>(
               `/tasks/${encodeURIComponent(request.assignTaskKey || request.assignTaskId || '')}`,
               { method: 'PATCH', body: JSON.stringify({ milestoneId: milestone.id }) }
            );
            toast.success('مایلستون ساخته و به کار متصل شد.');
         } catch (error) {
            toast.error(error instanceof Error ? error.message : 'مایلستون ساخته شد، اما اتصال کار ناموفق بود.');
         }
      }

      await taskSync.refresh({ preserveVisibleState: true });
      window.dispatchEvent(new CustomEvent('taskara:milestone-created', { detail: { milestone } }));
      if (request.navigateOnCreate) {
         const workspaceSlug = session?.workspace?.slug || window.location.pathname.split('/').filter(Boolean)[0] || 'taskara';
         navigate(`/${workspaceSlug}/milestones/${encodeURIComponent(milestone.id)}`);
      }
   }, [navigate, request.assignTaskId, request.assignTaskKey, request.navigateOnCreate, session?.workspace?.slug, taskSync]);

   return (
      <MilestoneCreateDialog
         currentUserId={session?.user.id}
         initialKind={request.kind || 'FEATURE'}
         initialProjectId={request.projectId}
         milestones={taskSync.milestones}
         open={open}
         projects={taskSync.projects}
         onCreated={(milestone) => void handleCreated(milestone)}
         onOpenChange={setOpen}
      />
   );
}
