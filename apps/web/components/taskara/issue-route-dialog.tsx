import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { IssuePage } from './issue-page';
import { TasksView } from './tasks-view';

/** Deep links keep the same dialog presentation as task lists and the team graph. */
export function IssueRouteDialog() {
   const { orgId, taskKey } = useParams();
   const navigate = useNavigate();
   const location = useLocation();
   const close = () => {
      if (location.key !== 'default') navigate(-1);
      else navigate(`/${orgId || 'taskara'}/tasks`, { replace: true });
   };
   return (
      <>
         <TasksView defaultSystemView="all" personalOnly={false} />
         <Dialog open onOpenChange={(open) => !open && close()}>
            <DialogContent className="h-[calc(100svh-2rem)] max-h-[920px] max-w-[1280px] gap-0 overflow-hidden rounded-2xl border-white/10 bg-[#101011] p-0 text-zinc-100 [direction:rtl]" showCloseButton={false}>
               <DialogTitle className="sr-only">جزئیات کار {taskKey}</DialogTitle>
               <DialogDescription className="sr-only">مشاهده و ویرایش جزئیات کار</DialogDescription>
               <IssuePage taskKey={taskKey} onClose={close} />
            </DialogContent>
         </Dialog>
      </>
   );
}
