import type { TaskaraNotification } from '@/lib/taskara-types';

const notificationTypeLabels: Record<string, string> = {
   task_assigned: 'واگذاری کار',
   task_mentioned: 'منشن در کار',
   task_created: 'ایجاد کار',
   task_updated: 'به‌روزرسانی کار',
   task_status_changed: 'تغییر وضعیت کار',
   task_description_changed: 'تغییر توضیحات کار',
   task_deleted: 'حذف کار',
   task_commented: 'دیدگاه کار',
   task_comment_mentioned: 'منشن در دیدگاه',
   task_attachment_added: 'پیوست کار',
   task_due: 'سررسید کار',
   task_overdue: 'دیرکرد کار',
   task_blocked: 'مسدود شدن کار',
   project_mentioned: 'منشن در پروژه',
};

export function getNotificationTypeLabel(type: string): string {
   return notificationTypeLabels[type] || 'اعلان کاری';
}

export function getNotificationBody(notification: Pick<TaskaraNotification, 'type' | 'body'>): string {
   const body = notification.body?.trim();
   if (body) {
      const mentionedActor = body.match(/^(.+?) mentioned you in this task\.$/i);
      if (mentionedActor) return `${mentionedActor[1]} شما را در این کار منشن کرد.`;

      const assignedActor = body.match(/^(.+?) assigned this task to you\.$/i);
      if (assignedActor) return `${assignedActor[1]} این کار را به شما واگذار کرد.`;

      return body;
   }

   if (notification.type === 'task_mentioned') return 'شما در این کار منشن شدید.';
   if (notification.type === 'task_assigned') return 'این کار به شما واگذار شد.';
   if (notification.type === 'task_status_changed') return 'وضعیت این کار تغییر کرد.';
   if (notification.type === 'task_description_changed') return 'توضیحات این کار به‌روزرسانی شد.';
   if (notification.type === 'task_commented') return 'دیدگاه تازه‌ای روی این کار ثبت شد.';
   return '';
}
