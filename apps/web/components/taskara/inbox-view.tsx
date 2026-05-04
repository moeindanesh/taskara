'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
   AtSign,
   Bell,
   Check,
   CheckCircle2,
   Circle,
   ExternalLink,
   Inbox,
   Loader2,
   MessageSquare,
   PencilLine,
   UserPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
   LinearAvatar,
   NoAssigneeIcon,
   PriorityIcon,
   ProjectGlyph,
   StatusIcon,
   linearPriorityMeta,
   linearStatusMeta,
} from '@/components/taskara/linear-ui';
import { taskaraRequest } from '@/lib/taskara-client';
import { formatJalaliDateTime } from '@/lib/jalali';
import { dispatchWorkspaceRefresh, useLiveRefresh } from '@/lib/live-refresh';
import { getNotificationBody, getNotificationTypeLabel } from '@/lib/notification-presenters';
import { getPriorityLabel, getStatusLabel } from '@/lib/taskara-presenters';
import type {
   NotificationsResponse,
   TaskaraActivity,
   TaskaraNotification,
   TaskaraTask,
   TaskaraTaskComment,
} from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';
import { cn } from '@/lib/utils';

type TimelineItem =
   | { id: string; createdAt: string; type: 'activity'; activity: TaskaraActivity }
   | { id: string; createdAt: string; type: 'comment'; comment: TaskaraTaskComment };

export function InboxView() {
   const navigate = useNavigate();
   const location = useLocation();
   const { orgId } = useParams();
   const [notifications, setNotifications] = useState<TaskaraNotification[]>([]);
   const [selected, setSelected] = useState<TaskaraNotification | null>(null);
   const [selectedTask, setSelectedTask] = useState<TaskaraTask | null>(null);
   const [activities, setActivities] = useState<TaskaraActivity[]>([]);
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [detailsLoading, setDetailsLoading] = useState(false);
   const [unreadCount, setUnreadCount] = useState(0);
   const [isPending, startTransition] = useTransition();

   const load = useCallback(async () => {
      setError('');
      try {
         const notificationsResult = await taskaraRequest<NotificationsResponse>('/notifications?limit=100');
         setNotifications(notificationsResult.items);
         setUnreadCount(notificationsResult.unreadCount);
         setSelected(
            (current) => notificationsResult.items.find((item) => item.id === current?.id) || notificationsResult.items[0] || null
         );
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.inbox.loadFailed);
      } finally {
         setLoading(false);
      }
   }, []);

   useLiveRefresh(load);

   useEffect(() => {
      let canceled = false;

      async function loadDetails(notification: TaskaraNotification | null) {
         if (!notification?.task) {
            setSelectedTask(null);
            setActivities([]);
            setDetailsLoading(false);
            return;
         }

         setDetailsLoading(true);
         try {
            const key = encodeURIComponent(notification.task.key || notification.task.id);
            const [taskResult, activityResult] = await Promise.all([
               taskaraRequest<TaskaraTask>(`/tasks/${key}`),
               taskaraRequest<TaskaraActivity[]>(`/tasks/${key}/activity`).catch(() => []),
            ]);

            if (canceled) return;
            setSelectedTask(taskResult);
            setActivities(activityResult);
         } catch (err) {
            if (canceled) return;
            setSelectedTask(null);
            setActivities([]);
            setError(err instanceof Error ? err.message : fa.issue.loadFailed);
         } finally {
            if (!canceled) setDetailsLoading(false);
         }
      }

      void loadDetails(selected);

      return () => {
         canceled = true;
      };
   }, [selected?.id, selected?.task?.id, selected?.task?.key]);

   async function markRead(notification: TaskaraNotification) {
      if (notification.readAt) return;
      const readAt = new Date().toISOString();

      setNotifications((current) =>
         current.map((item) => (item.id === notification.id ? { ...item, readAt } : item))
      );
      setSelected((current) => (current?.id === notification.id ? { ...current, readAt } : current));
      setUnreadCount((current) => Math.max(0, current - 1));

      try {
         await taskaraRequest(`/notifications/${notification.id}/read`, { method: 'PATCH' });
         dispatchWorkspaceRefresh({ source: 'notifications:read' });
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.inbox.markAllFailed);
         startTransition(() => {
            void load();
         });
      }
   }

   function openNotification(notification: TaskaraNotification) {
      setSelected(notification);
      if (!notification.readAt) void markRead(notification);
   }

   async function markAllRead() {
      try {
         await taskaraRequest('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
         setNotifications((current) =>
            current.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() }))
         );
         setSelected((current) => (current ? { ...current, readAt: current.readAt || new Date().toISOString() } : current));
         setUnreadCount(0);
         dispatchWorkspaceRefresh({ source: 'notifications:read-all' });
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.inbox.markAllFailed);
      }
   }

   function openFullIssue() {
      const taskKey = selectedTask?.key || selected?.task?.key;
      if (!taskKey) return;

      navigate(`/${orgId || 'taskara'}/issue/${encodeURIComponent(taskKey)}`, {
         state: {
            from: {
               pathname: location.pathname,
               search: location.search,
               hash: location.hash,
            },
         },
      });
   }

   const timeline = useMemo<TimelineItem[]>(() => {
      const activityItems: TimelineItem[] = activities
         .filter((activity) => activity.action !== 'commented' && activity.action !== 'comment_attachment_added')
         .map((activity) => ({
            id: `activity-${activity.id}`,
            createdAt: activity.createdAt,
            type: 'activity',
            activity,
         }));
      const commentItems: TimelineItem[] = (selectedTask?.comments || []).map((comment) => ({
         id: `comment-${comment.id}`,
         createdAt: comment.createdAt,
         type: 'comment',
         comment,
      }));

      return [...activityItems, ...commentItems].sort(
         (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime()
      );
   }, [activities, selectedTask?.comments]);

   return (
      <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-[#101011] text-zinc-200 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[390px_minmax(0,1fr)_320px]">
         <section className="flex min-h-0 flex-col border-b border-white/8 lg:border-b-0 lg:border-e">
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/8 px-4">
               <div className="flex min-w-0 items-center gap-2">
                  <Inbox className="size-4 shrink-0 text-zinc-500" />
                  <h1 className="truncate text-sm font-semibold text-zinc-100">{fa.inbox.notifications}</h1>
                  {unreadCount > 0 ? (
                     <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-200">
                        {unreadCount.toLocaleString('fa-IR')}
                     </span>
                  ) : null}
               </div>
               <Button
                  aria-label={fa.inbox.markAllRead}
                  size="icon"
                  variant="ghost"
                  className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"
                  disabled={isPending || unreadCount === 0}
                  onClick={() => void markAllRead()}
               >
                  <Check className="size-4" />
               </Button>
            </div>

            {error ? (
               <div className="m-3 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs leading-5 text-red-200">
                  {error}
               </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
               {loading ? (
                  <LinearInboxEmpty>{fa.app.loading}</LinearInboxEmpty>
               ) : notifications.length === 0 ? (
                  <LinearInboxEmpty>{fa.inbox.noNotifications}</LinearInboxEmpty>
               ) : (
                  <div className="space-y-1">
                     {notifications.map((notification) => (
                        <NotificationListItem
                           key={notification.id}
                           notification={notification}
                           selected={selected?.id === notification.id}
                           onSelect={() => openNotification(notification)}
                        />
                     ))}
                  </div>
               )}
            </div>
         </section>

         <main className="min-h-0 overflow-y-auto">
            {selected ? (
               <IssueDetailPane
                  detailsLoading={detailsLoading}
                  notification={selected}
                  task={selectedTask}
                  timeline={timeline}
                  onOpenIssue={openFullIssue}
               />
            ) : (
               <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
                  {fa.inbox.selectNotification}
               </div>
            )}
         </main>

         <aside className="hidden min-h-0 overflow-y-auto border-s border-white/8 p-3 xl:block">
            <IssueProperties notification={selected} task={selectedTask} />
         </aside>
      </div>
   );
}

function NotificationListItem({
   notification,
   selected,
   onSelect,
}: {
   notification: TaskaraNotification;
   selected: boolean;
   onSelect: () => void;
}) {
   const Icon = notificationIcon(notification);
   const body = getNotificationBody(notification) || fa.inbox.noDescription;

   return (
      <button
         className={cn(
            'group grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-3 rounded-lg px-3 py-2.5 text-start transition',
            selected ? 'bg-white/[0.075]' : 'hover:bg-white/[0.045]'
         )}
         onClick={onSelect}
         type="button"
      >
         <span className="relative mt-0.5 inline-flex size-7 items-center justify-center rounded-full bg-white/[0.055] text-zinc-400">
            <Icon className="size-4" />
            {!notification.readAt ? (
               <span className="absolute -top-0.5 -start-0.5 size-2 rounded-full bg-indigo-400 ring-2 ring-[#101011]" />
            ) : null}
         </span>
         <span className="min-w-0">
            <span className="mb-1 flex min-w-0 items-center gap-1.5">
               {notification.task ? (
                  <span className="ltr shrink-0 text-xs text-zinc-500">{notification.task.key}</span>
               ) : null}
               <span className="truncate text-sm font-medium text-zinc-200">{notificationTitle(notification)}</span>
            </span>
            <span className="line-clamp-1 text-xs leading-5 text-zinc-500">{body}</span>
         </span>
         <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-zinc-500">
            {formatJalaliDateTime(notification.createdAt)}
         </span>
      </button>
   );
}

function IssueDetailPane({
   detailsLoading,
   notification,
   task,
   timeline,
   onOpenIssue,
}: {
   detailsLoading: boolean;
   notification: TaskaraNotification;
   task: TaskaraTask | null;
   timeline: TimelineItem[];
   onOpenIssue: () => void;
}) {
   const visibleTask = task || notification.task;
   const description = getTaskDescriptionText(task?.description);
   const status = task?.status || notification.task?.status || 'TODO';
   const priority = task?.priority || notification.task?.priority || 'NO_PRIORITY';

   return (
      <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col px-5 py-5 lg:px-8">
         <div className="mb-8 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-500">
               {visibleTask ? (
                  <>
                     <span className="ltr truncate">{visibleTask.key}</span>
                     <span className="h-1 w-1 rounded-full bg-zinc-700" />
                  </>
               ) : null}
               <span className="truncate">{getNotificationTypeLabel(notification.type)}</span>
            </div>
            <div className="flex items-center gap-1.5">
               {detailsLoading ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : null}
               {visibleTask ? (
                  <Button
                     aria-label={fa.nav.issues}
                     size="icon"
                     variant="ghost"
                     className="size-8 rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"
                     onClick={onOpenIssue}
                  >
                     <ExternalLink className="size-4" />
                  </Button>
               ) : null}
            </div>
         </div>

         <div className="mb-7 flex items-start gap-3">
            <StatusIcon status={status} className="mt-1 size-5" />
            <div className="min-w-0 flex-1">
               <h2 className="break-words text-2xl font-semibold leading-9 text-zinc-50">
                  {task?.title || notification.task?.title || notification.title}
               </h2>
               <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.035] px-2.5 py-1">
                     <StatusIcon status={status} className="size-3.5" />
                     {getStatusLabel(status)}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.035] px-2.5 py-1">
                     <PriorityIcon priority={priority} className="size-3.5" />
                     {getPriorityLabel(priority)}
                  </span>
               </div>
            </div>
         </div>

         <section className="mb-8 min-h-[72px] border-b border-white/8 pb-8">
            {description ? (
               <p className="whitespace-pre-wrap text-sm leading-7 text-zinc-300">{description}</p>
            ) : (
               <p className="text-sm text-zinc-600">{fa.issue.descriptionPlaceholder}</p>
            )}
            <p className="mt-4 text-sm leading-6 text-zinc-500">{getNotificationBody(notification) || fa.inbox.noDescription}</p>
         </section>

         <section className="min-h-0">
            <div className="mb-4 flex items-center justify-between gap-3">
               <h3 className="text-base font-semibold text-zinc-100">{fa.issue.activity}</h3>
               <div className="hidden -space-x-2 rtl:space-x-reverse sm:flex">
                  {task?.assignee ? (
                     <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-7" />
                  ) : null}
                  {task?.reporter ? (
                     <LinearAvatar name={task.reporter.name} src={task.reporter.avatarUrl} className="size-7" />
                  ) : null}
               </div>
            </div>

            {detailsLoading && !timeline.length ? (
               <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
                  <Loader2 className="size-4 animate-spin" />
                  {fa.app.loading}
               </div>
            ) : timeline.length ? (
               <div className="space-y-4">
                  {timeline.slice(-12).map((item) =>
                     item.type === 'comment' ? (
                        <CommentTimelineItem key={item.id} comment={item.comment} />
                     ) : (
                        <ActivityTimelineItem key={item.id} activity={item.activity} />
                     )
                  )}
               </div>
            ) : (
               <div className="rounded-lg border border-dashed border-white/10 px-4 py-5 text-sm text-zinc-500">
                  {fa.inbox.noDescription}
               </div>
            )}

            <button
               className="mt-6 flex w-full items-center justify-between gap-3 rounded-lg border border-white/8 bg-[#18181a] px-4 py-3 text-start text-sm text-zinc-500 transition hover:bg-white/[0.045] hover:text-zinc-300"
               type="button"
               onClick={onOpenIssue}
            >
               <span>برای ثبت نظر، کار را باز کنید.</span>
               <ExternalLink className="size-4 shrink-0" />
            </button>
         </section>
      </div>
   );
}

function IssueProperties({
   notification,
   task,
}: {
   notification: TaskaraNotification | null;
   task: TaskaraTask | null;
}) {
   const status = task?.status || notification?.task?.status || 'TODO';
   const priority = task?.priority || notification?.task?.priority || 'NO_PRIORITY';

   return (
      <div className="space-y-3">
         <PropertyPanel title={fa.issue.properties}>
            <PropertyRow
               icon={<StatusIcon status={status} />}
               label={linearStatusMeta[status]?.label || getStatusLabel(status)}
            />
            <PropertyRow
               icon={<PriorityIcon priority={priority} />}
               label={linearPriorityMeta[priority]?.label || getPriorityLabel(priority)}
            />
            <PropertyRow
               icon={
                  task?.assignee ? (
                     <LinearAvatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-5" />
                  ) : (
                     <NoAssigneeIcon className="size-4 text-zinc-500" />
                  )
               }
               label={task?.assignee?.name || 'بدون مسئول'}
            />
         </PropertyPanel>

         <PropertyPanel title={fa.issue.project}>
            <PropertyRow
               icon={<ProjectGlyph name={task?.project?.name} className="size-5 rounded" iconClassName="size-3.5" />}
               label={task?.project?.name || 'بدون پروژه'}
            />
         </PropertyPanel>

         <PropertyPanel title={fa.inbox.type}>
            <PropertyRow icon={<Bell className="size-4 text-zinc-500" />} label={notification ? getNotificationTypeLabel(notification.type) : '—'} />
         </PropertyPanel>
      </div>
   );
}

function PropertyPanel({ children, title }: { children: React.ReactNode; title: string }) {
   return (
      <section className="rounded-lg border border-white/8 bg-[#18181a]">
         <div className="border-b border-white/7 px-4 py-3 text-sm font-semibold text-zinc-400">{title}</div>
         <div className="space-y-3 px-4 py-4">{children}</div>
      </section>
   );
}

function PropertyRow({ icon, label }: { icon: React.ReactNode; label: string }) {
   return (
      <div className="flex min-w-0 items-center gap-3 text-sm text-zinc-300">
         <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
         <span className="truncate">{label}</span>
      </div>
   );
}

function ActivityTimelineItem({ activity }: { activity: TaskaraActivity }) {
   const label = activityLabel(activity);

   return (
      <div className="flex gap-3">
         <LinearAvatar name={activity.actor?.name || activity.actorType} src={activity.actor?.avatarUrl} className="size-6" />
         <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm leading-6 text-zinc-400">{label}</p>
            <p className="mt-0.5 text-xs text-zinc-600">{formatJalaliDateTime(activity.createdAt)}</p>
         </div>
      </div>
   );
}

function CommentTimelineItem({ comment }: { comment: TaskaraTaskComment }) {
   return (
      <div className="flex gap-3">
         <LinearAvatar name={comment.author?.name} src={comment.author?.avatarUrl} className="size-6" />
         <div className="min-w-0 flex-1 rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2">
            <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
               <span className="truncate text-sm font-medium text-zinc-300">{comment.author?.name || fa.app.unknown}</span>
               <span className="shrink-0 text-xs text-zinc-600">{formatJalaliDateTime(comment.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-400">{comment.body}</p>
         </div>
      </div>
   );
}

function LinearInboxEmpty({ children }: { children: React.ReactNode }) {
   return (
      <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">
         {children}
      </div>
   );
}

function notificationIcon(notification: TaskaraNotification) {
   if (notification.type === 'task_assigned') return UserPlus;
   if (notification.type === 'task_mentioned' || notification.type === 'task_comment_mentioned') return AtSign;
   if (notification.type === 'task_commented') return MessageSquare;
   if (notification.type === 'task_description_changed') return PencilLine;
   if (notification.type === 'task_status_changed') return CheckCircle2;
   if (notification.type === 'task_created') return Circle;
   return Bell;
}

function notificationTitle(notification: TaskaraNotification): string {
   if (!notification.task) return notification.title;
   return notification.task.title || notification.title.replace(`${notification.task.key}: `, '');
}

function activityLabel(activity: TaskaraActivity): string {
   const actorName = activity.actor?.name || activity.actorType || fa.app.unknown;
   const before = activity.before || {};
   const after = activity.after || {};

   if (activity.action === 'created') return `${actorName} این کار را ایجاد کرد.`;
   if (activity.action === 'deleted') return `${actorName} این کار را حذف کرد.`;
   if (activity.action === 'attachment_added') return `${actorName} پیوست اضافه کرد.`;

   if (activity.action === 'updated') {
      const beforeStatus = stringValue(before.status);
      const afterStatus = stringValue(after.status);
      if (beforeStatus && afterStatus && beforeStatus !== afterStatus) {
         return `${actorName} وضعیت را از ${getStatusLabel(beforeStatus)} به ${getStatusLabel(afterStatus)} تغییر داد.`;
      }

      const beforeAssigneeId = stringValue(before.assigneeId);
      const afterAssignee = objectValue(after.assignee);
      const afterAssigneeName = stringValue(afterAssignee?.name);
      if (afterAssigneeName && beforeAssigneeId !== stringValue(afterAssignee?.id)) {
         return `${actorName} این کار را به ${afterAssigneeName} واگذار کرد.`;
      }

      if (stringValue(before.description) !== stringValue(after.description)) {
         return `${actorName} توضیحات را به‌روزرسانی کرد.`;
      }

      return `${actorName} این کار را به‌روزرسانی کرد.`;
   }

   return `${actorName} ${activity.action}`;
}

function getTaskDescriptionText(description?: string | null): string {
   const trimmed = description?.trim();
   if (!trimmed) return '';
   if (!trimmed.startsWith('{')) return trimmed;

   try {
      const parsed = JSON.parse(trimmed) as unknown;
      const lines: string[] = [];
      collectDescriptionText(parsed, lines);
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
   } catch {
      return '';
   }
}

function collectDescriptionText(value: unknown, lines: string[]): void {
   if (!value || typeof value !== 'object') return;

   if (Array.isArray(value)) {
      for (const item of value) collectDescriptionText(item, lines);
      return;
   }

   const node = value as Record<string, unknown>;
   if (typeof node.text === 'string') {
      lines.push(node.text);
   } else if (node.type === 'mention') {
      lines.push(`@${stringValue(node.mentionName) || stringValue(objectValue(node.attrs)?.mentionName) || ''}`);
   } else if (node.type === 'inline-image') {
      lines.push('[image]');
   }

   const childContainers = [node.root, node.children, node.content];
   const beforeLength = lines.length;
   for (const childContainer of childContainers) {
      if (Array.isArray(childContainer)) {
         for (const child of childContainer) collectDescriptionText(child, lines);
      } else {
         collectDescriptionText(childContainer, lines);
      }
   }

   if (['paragraph', 'heading', 'listitem'].includes(String(node.type)) && lines.length > beforeLength) {
      lines.push('\n');
   }
}

function objectValue(value: unknown): Record<string, unknown> | null {
   return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
   return typeof value === 'string' ? value : '';
}
