'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { taskaraRequest } from '@/lib/taskara-client';
import { formatJalaliDateTime } from '@/lib/jalali';
import { PriorityBadge, StatusBadge } from '@/lib/taskara-presenters';
import type { NotificationsResponse, TaskaraActivity, TaskaraNotification } from '@/lib/taskara-types';
import { fa } from '@/lib/fa-copy';

export function InboxView() {
   const [notifications, setNotifications] = useState<TaskaraNotification[]>([]);
   const [activity, setActivity] = useState<TaskaraActivity[]>([]);
   const [selected, setSelected] = useState<TaskaraNotification | null>(null);
   const [error, setError] = useState('');
   const [loading, setLoading] = useState(true);
   const [unreadCount, setUnreadCount] = useState(0);
   const [isPending, startTransition] = useTransition();

   async function load() {
      setError('');
      try {
         const [notificationsResult, activityResult] = await Promise.all([
            taskaraRequest<NotificationsResponse>('/notifications?limit=100'),
            taskaraRequest<TaskaraActivity[]>('/activity'),
         ]);
         setNotifications(notificationsResult.items);
         setUnreadCount(notificationsResult.unreadCount);
         setSelected((current) => current || notificationsResult.items[0] || null);
         setActivity(activityResult);
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.inbox.loadFailed);
      } finally {
         setLoading(false);
      }
   }

   useEffect(() => {
      void load();
   }, []);

   async function markRead(notification: TaskaraNotification) {
      await taskaraRequest(`/notifications/${notification.id}/read`, { method: 'PATCH' });
      startTransition(() => {
         void load();
      });
   }

   async function markAllRead() {
      try {
         await taskaraRequest('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
         startTransition(() => {
            void load();
         });
      } catch (err) {
         setError(err instanceof Error ? err.message : fa.inbox.markAllFailed);
      }
   }

   return (
      <div className="h-full">
         {error ? <p className="mx-6 mt-6 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p> : null}
         <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={42} minSize={28}>
               <div className="flex h-10 items-center justify-between border-b px-4">
                  <div className="text-sm font-semibold">
                     {fa.inbox.notifications}
                     <span className="ms-2 text-xs text-muted-foreground">
                        {unreadCount.toLocaleString('fa-IR')} {fa.inbox.unread}
                     </span>
                  </div>
                  <Button size="xs" variant="secondary" onClick={() => void markAllRead()} disabled={isPending || unreadCount === 0}>
                     {fa.inbox.markAllRead}
                  </Button>
               </div>
               <div className="h-[calc(100%-40px)] overflow-y-auto p-3">
                  {loading ? (
                     <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{fa.app.loading}</div>
                  ) : notifications.length === 0 ? (
                     <div className="space-y-3">
                        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                           {fa.inbox.noNotifications}
                        </div>
                        <Card>
                           <CardHeader>
                              <CardTitle className="text-base">آخرین فعالیت‌ها</CardTitle>
                           </CardHeader>
                           <CardContent className="space-y-3">
                              {activity.slice(0, 8).map((item) => (
                                 <div key={item.id} className="rounded-lg border px-3 py-3 text-sm">
                                    <div className="font-medium">{item.actor?.name || fa.app.unknown} / {item.action}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                       {item.entityType} · {formatJalaliDateTime(item.createdAt)}
                                    </div>
                                 </div>
                              ))}
                           </CardContent>
                        </Card>
                     </div>
                  ) : (
                     <div className="space-y-2">
                        {notifications.map((notification) => (
                           <button
                              key={notification.id}
                              className={`w-full rounded-xl border p-4 text-right transition-colors ${selected?.id === notification.id ? 'bg-accent/60' : 'hover:bg-accent/30'}`}
                              onClick={() => setSelected(notification)}
                              type="button"
                           >
                              <div className="mb-2 flex items-start justify-between gap-3">
                                 <div className="space-y-1">
                                    <div className="font-medium">{notification.title}</div>
                                    <div className="text-xs text-muted-foreground">
                                       {formatJalaliDateTime(notification.createdAt)}
                                    </div>
                                 </div>
                                 {!notification.readAt ? <span className="mt-1 size-2 rounded-full bg-blue-500" /> : null}
                              </div>
                              <div className="line-clamp-2 text-sm text-muted-foreground">
                                 {notification.body || fa.inbox.noDescription}
                              </div>
                           </button>
                        ))}
                     </div>
                  )}
               </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={58} minSize={32}>
               <div className="h-full overflow-y-auto p-6">
                  {selected ? (
                     <Card className="max-w-4xl">
                        <CardHeader>
                           <div className="flex items-center justify-between gap-3">
                              <CardTitle>{selected.title}</CardTitle>
                              {!selected.readAt ? (
                                 <Button size="xs" variant="outline" onClick={() => void markRead(selected)}>
                                    {fa.inbox.markRead}
                                 </Button>
                              ) : null}
                           </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                           <p className="text-sm leading-7 text-muted-foreground">
                              {selected.body || fa.inbox.noDescription}
                           </p>
                           <div className="grid gap-3 md:grid-cols-2">
                              <div className="rounded-lg border px-4 py-3">
                                 <div className="text-xs text-muted-foreground">{fa.inbox.registeredAt}</div>
                                 <div className="mt-1 text-sm font-medium">
                                    {formatJalaliDateTime(selected.createdAt)}
                                 </div>
                              </div>
                              <div className="rounded-lg border px-4 py-3">
                                 <div className="text-xs text-muted-foreground">{fa.inbox.type}</div>
                                 <div className="mt-1 text-sm font-medium">{selected.type}</div>
                              </div>
                           </div>
                           {selected.task ? (
                              <div className="rounded-xl border bg-background/70 p-4">
                                 <div className="mb-2 flex items-center justify-between gap-3">
                                    <div>
                                       <div className="ltr text-xs text-muted-foreground">{selected.task.key}</div>
                                       <div className="font-medium">{selected.task.title}</div>
                                    </div>
                                    <PriorityBadge priority={selected.task.priority} />
                                 </div>
                                 <StatusBadge status={selected.task.status} />
                              </div>
                           ) : null}
                        </CardContent>
                     </Card>
                  ) : (
                     <div className="flex h-full items-center justify-center rounded-xl border border-dashed text-center text-muted-foreground">
                        {fa.inbox.selectNotification}
                     </div>
                  )}
               </div>
            </ResizablePanel>
         </ResizablePanelGroup>
      </div>
   );
}
