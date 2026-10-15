'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useWorkspaceTaskSync } from '@/lib/task-sync-provider';
import { taskaraRequest } from '@/lib/taskara-client';
import type { TaskaraTask } from '@/lib/taskara-types';
import type { GoalPeriod, TaskaraMilestone, TaskaraMilestoneKind } from '@/lib/taskara-types';
import { useAuthSession } from '@/store/auth-store';
import { isWorkspaceAdminRole } from '@/lib/workspace-mode';
import { useWorkspaceRuntime } from '@/lib/workspace-runtime';
import { MilestoneCreateDialog } from './milestone-create-dialog';

export const createMilestoneEvent = 'taskara:create-milestone';

export type CreateMilestoneEventDetail = {
   assignTaskId?: string;
   assignTaskKey?: string;
   kind?: TaskaraMilestoneKind;
   period?: GoalPeriod;
   startsOn?: string;
   targetOn?: string;
   navigateOnCreate?: boolean;
   projectId?: string;
};

export function openMilestoneCreate(detail: CreateMilestoneEventDetail = {}) {
   window.dispatchEvent(
      new CustomEvent<CreateMilestoneEventDetail>(createMilestoneEvent, { detail })
   );
}

export function MilestoneDialogHost() {
   const navigate = useNavigate();
   const { session } = useAuthSession();
   const { role } = useWorkspaceRuntime();
   const canCreate = isWorkspaceAdminRole(role);
   const taskSync = useWorkspaceTaskSync();
   const [open, setOpen] = useState(false);
   const [request, setRequest] = useState<CreateMilestoneEventDetail>({});

   useEffect(() => {
      if (!canCreate) {
         setOpen(false);
         return;
      }
      const handleOpen = (event: Event) => {
         const detail =
            event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
               ? (event.detail as CreateMilestoneEventDetail)
               : {};
         const params = new URLSearchParams(window.location.search);
         const hubPeriod = window.location.pathname.includes('/milestones')
            ? params.get('period')
            : null;
         const period = detail.period || hubPeriod;
         const startsOn = detail.startsOn || (hubPeriod ? params.get('from') : null);
         const targetOn = detail.targetOn || (hubPeriod ? params.get('to') : null);
         setRequest({
            period: period === 'MONTHLY' || period === 'CUSTOM' ? period : 'WEEKLY',
            startsOn: startsOn && /^\d{4}-\d{2}-\d{2}$/.test(startsOn) ? startsOn : undefined,
            targetOn: targetOn && /^\d{4}-\d{2}-\d{2}$/.test(targetOn) ? targetOn : undefined,
            assignTaskId: typeof detail.assignTaskId === 'string' ? detail.assignTaskId : undefined,
            assignTaskKey:
               typeof detail.assignTaskKey === 'string' ? detail.assignTaskKey : undefined,
            kind: detail.kind === 'PHASE' || detail.kind === 'OTHER' ? detail.kind : 'FEATURE',
            navigateOnCreate: detail.navigateOnCreate === true,
            projectId: typeof detail.projectId === 'string' ? detail.projectId : undefined,
         });
         setOpen(true);
      };

      window.addEventListener(createMilestoneEvent, handleOpen);
      return () => window.removeEventListener(createMilestoneEvent, handleOpen);
   }, [canCreate]);

   const handleCreated = useCallback(
      async (milestone: TaskaraMilestone) => {
         const task = taskSync.tasks.find(
            (item) => item.id === request.assignTaskId || item.key === request.assignTaskKey
         );

         if (task) {
            try {
               await taskSync.updateTask(task, { milestoneId: milestone.id });
               toast.success('هدف ساخته و به کار متصل شد.');
            } catch (error) {
               toast.error(
                  error instanceof Error ? error.message : 'هدف ساخته شد، اما اتصال کار ناموفق بود.'
               );
            }
         } else if (request.assignTaskKey || request.assignTaskId) {
            try {
               await taskaraRequest<TaskaraTask>(
                  `/tasks/${encodeURIComponent(request.assignTaskKey || request.assignTaskId || '')}`,
                  { method: 'PATCH', body: JSON.stringify({ milestoneId: milestone.id }) }
               );
               toast.success('هدف ساخته و به کار متصل شد.');
            } catch (error) {
               toast.error(
                  error instanceof Error ? error.message : 'هدف ساخته شد، اما اتصال کار ناموفق بود.'
               );
            }
         }

         await taskSync.refresh({ preserveVisibleState: true });
         window.dispatchEvent(
            new CustomEvent('taskara:milestone-created', { detail: { milestone } })
         );
         if (request.navigateOnCreate) {
            const workspaceSlug =
               session?.workspace?.slug ||
               window.location.pathname.split('/').filter(Boolean)[0] ||
               'taskara';
            navigate(`/${workspaceSlug}/milestones/${encodeURIComponent(milestone.id)}`);
         }
      },
      [
         navigate,
         request.assignTaskId,
         request.assignTaskKey,
         request.navigateOnCreate,
         session?.workspace?.slug,
         taskSync,
      ]
   );

   if (!canCreate) return null;

   return (
      <MilestoneCreateDialog
         currentUserId={session?.user.id}
         initialKind={request.kind || 'FEATURE'}
         initialPeriod={request.period}
         initialStartsOn={request.startsOn}
         initialTargetOn={request.targetOn}
         initialProjectId={request.projectId}
         milestones={taskSync.milestones}
         open={open}
         projects={taskSync.projects}
         onCreated={(milestone) => void handleCreated(milestone)}
         onOpenChange={setOpen}
      />
   );
}
