import { formatJalaliDateTime } from '@/lib/jalali';
import type {
   SupportCaseTaskLinkProjection,
   SupportTaskRelationType,
   SupportWorkspaceConnectionStatus,
} from '@/lib/support-handoff-types';

export const supportConnectionStatusLabels: Record<SupportWorkspaceConnectionStatus, string> = {
   PENDING: 'در انتظار تأیید دوطرفه',
   ACTIVE: 'فعال',
   REVOKED: 'لغوشده',
};

export const supportTaskRelationLabels: Record<SupportTaskRelationType, string> = {
   FIX_WORK: 'رفع مشکل',
   INVESTIGATION: 'بررسی',
   FOLLOW_UP: 'پیگیری',
   RELATED: 'مرتبط',
};

export const teamTaskPriorityLabels = {
   NO_PRIORITY: 'بدون اولویت',
   LOW: 'کم',
   MEDIUM: 'متوسط',
   HIGH: 'زیاد',
   URGENT: 'فوری',
} as const;

export type SupportTaskLinkState = 'ACTIVE' | 'CONNECTION_REVOKED' | 'TASK_DELETED' | 'UNLINKED';

export function supportTaskLinkState(link: SupportCaseTaskLinkProjection): SupportTaskLinkState {
   if (link.tombstone.unlinkedAt) return 'UNLINKED';
   if (link.tombstone.taskDeletedAt) return 'TASK_DELETED';
   if (link.tombstone.connectionRevokedAt) return 'CONNECTION_REVOKED';
   return 'ACTIVE';
}

export function supportTaskLinkStateLabel(link: SupportCaseTaskLinkProjection): string {
   const state = supportTaskLinkState(link);
   if (state === 'UNLINKED') return 'پیوند برداشته شده';
   if (state === 'TASK_DELETED') return 'کار تیمی حذف شده';
   if (state === 'CONNECTION_REVOKED') return 'نمای منجمد پس از لغو اتصال';
   return 'فعال';
}

export function supportTaskLinkSignalLabel(link: SupportCaseTaskLinkProjection): string {
   return `آخرین سیگنال: ${formatJalaliDateTime(link.lastSignalAt)}`;
}

export function supportHandoffVisibilityWarning(teamWorkspaceName: string, projectName: string): string {
   return `این متن در فضای تیمی «${teamWorkspaceName}» و پروژه «${projectName}» برای افراد دارای دسترسی آن پروژه قابل مشاهده می‌شود. اطلاعات تماس، یادداشت خصوصی، متن مکالمه، فایل و داده حساس مشتری را وارد نکنید.`;
}

export const supportHandoffIrreversibilityWarning =
   'لغو اتصال یا برداشتن پیوند، متنی را که پیش‌تر در کار تیمی کپی شده است پس نمی‌گیرد و هیچ‌یک از پرونده یا کار را حذف نمی‌کند.';

export function supportHandoffConflictMessage(): string {
   return 'پرونده یا تنظیم اتصال در جای دیگری تغییر کرده است. نسخه تازه بارگذاری شد؛ پیش‌نمایش را دوباره بررسی و تأیید کنید.';
}
