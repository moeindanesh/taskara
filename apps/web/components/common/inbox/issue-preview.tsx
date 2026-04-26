'use client';

import { InboxItem } from '@/mock-data/inbox';
import { useNotificationsStore } from '@/store/notifications-store';
import { renderStatusIcon } from '@/lib/status-utils';
import { Button } from '@/components/ui/button';
import { NotificationBox } from './icons/motification-box';
import { Check, Paperclip, Send } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

interface IssuePreviewProps {
   notification?: InboxItem;
   onMarkAsRead?: (id: string) => void;
}

export default function IssuePreview({ notification, onMarkAsRead }: IssuePreviewProps) {
   const { getUnreadCount } = useNotificationsStore();

   if (!notification) {
      const unreadCount = getUnreadCount();

      return (
         <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <NotificationBox className="w-16 h-16 mb-4 text-muted-foreground/50" />
            <h3 className="text-lg font-semibold text-muted-foreground mb-2">
               {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
               Select a notification from the list to view its details and take action.
            </p>
         </div>
      );
   }

   return (
      <div className="flex flex-col h-full">
         <div className="flex items-center justify-between px-4 h-10 border-b border-border">
            <div className="flex items-center gap-3">
               <span className="text-sm font-medium">{notification.identifier}</span>
            </div>

            <div className="flex items-center gap-2">
               {!notification.read && onMarkAsRead && (
                  <Button
                     variant="outline"
                     size="xs"
                     onClick={() => onMarkAsRead(notification.id)}
                     className="gap-1"
                  >
                     <Check className="size-4" />
                     Mark as read
                  </Button>
               )}
            </div>
         </div>

         <div className="pt-10 pb-6 px-4 space-y-4 w-full max-w-4xl mx-auto">
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
               <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">
                     {notification.identifier}
                  </span>

                  <div className="shrink-0">{renderStatusIcon(notification.status.id)}</div>
               </div>
            </div>

            <div>
               <h3 className="text-xl font-semibold text-foreground mb-2">{notification.title}</h3>
            </div>

            <div className="prose prose-sm max-w-none">
               <p className="text-foreground leading-relaxed">{notification.content}</p>
            </div>

            <div className="relative w-full flex flex-col mt-8">
               <Textarea
                  className="w-full rounded-lg border px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent pb-14 resize-none"
                  placeholder="Leave a comment..."
                  rows={3}
               />
               <div className="absolute right-3 bottom-3 flex items-center gap-3">
                  <Button size="icon" variant="ghost">
                     <Paperclip className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="secondary">
                     <Send className="w-4 h-4" />
                  </Button>
               </div>
            </div>
         </div>
      </div>
   );
}
