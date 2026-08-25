import { formatJalaliDateTime } from '@/lib/jalali';
import type {
   SupportAttentionReason,
   SupportCasePriority,
   SupportCaseSource,
   SupportCaseStatus,
   SupportQueueKind,
   SupportResolutionCode,
} from '@/lib/support-types';

export const supportStatusLabels: Record<SupportCaseStatus, string> = {
   NEW: 'جدید',
   OPEN: 'باز',
   WAITING_ON_CUSTOMER: 'منتظر مشتری',
   WAITING_ON_INTERNAL: 'منتظر پیگیری داخلی',
   RESOLVED: 'حل‌شده',
   CLOSED: 'بسته',
};

export const supportPriorityLabels: Record<SupportCasePriority, string> = {
   LOW: 'کم',
   NORMAL: 'عادی',
   HIGH: 'زیاد',
   URGENT: 'فوری',
};

export const supportSourceLabels: Record<SupportCaseSource, string> = {
   API: 'API',
   CALL: 'تماس',
   MANUAL: 'ثبت دستی',
   EMAIL: 'ایمیل',
   MESSAGING: 'پیام‌رسان',
};

export const supportQueueLabels: Record<SupportQueueKind, string> = {
   TRIAGE: 'تریاژ',
   DEPARTMENT_INBOX: 'صف دپارتمان',
   MY_CASES: 'پرونده‌های من',
   NEEDS_ATTENTION: 'نیازمند پیگیری',
};

export const supportResolutionLabels: Record<SupportResolutionCode, string> = {
   FIXED: 'رفع شد',
   ANSWERED: 'پاسخ داده شد',
   WORKAROUND: 'راه‌حل موقت',
   DUPLICATE: 'تکراری',
   NO_RESPONSE: 'بدون پاسخ مشتری',
   NOT_REPRODUCIBLE: 'قابل بازتولید نبود',
   REJECTED: 'رد شد',
   WITHDRAWN: 'پس گرفته شد',
   SPAM: 'هرزنامه',
};

export const supportAttentionLabels: Record<SupportAttentionReason, string> = {
   UNTRIAGED_TOO_LONG: 'تریاژ با تأخیر',
   NO_NEXT_ACTION: 'اقدام بعدی ندارد',
   NEXT_ACTION_DUE: 'موعد اقدام گذشته',
   SLA_AT_RISK: 'در معرض نقض SLA',
   SLA_BREACHED: 'SLA نقض شده',
   STALE_OWNERSHIP: 'بدون فعالیت اخیر',
   DEPARTMENT_UNASSIGNED_TOO_LONG: 'دیرکرد در تخصیص عضو',
   WAITING_ON_CUSTOMER_TOO_LONG: 'انتظار طولانی برای مشتری',
   WAITING_ON_INTERNAL_TOO_LONG: 'انتظار طولانی داخلی',
   CALLBACK_DUE: 'تماس برگشتی سررسید شده',
   EXCESSIVE_TRANSFERS: 'ارجاع‌های بیش از حد',
   HANDOFF_REJECTED_OR_EXPIRED: 'تحویل رد یا منقضی شده',
   REOPENED: 'دوباره باز شده',
   RESOLUTION_UNCONFIRMED: 'حل مسئله تأیید نشده',
   NON_FIXED_RESOLUTION: 'بدون رفع قطعی',
   LINKED_TASK_BLOCKED_OR_OVERDUE: 'کار مرتبط مسدود یا دیرکرده',
};

export function supportDueLabel(value?: string | null, now = Date.now()): string {
   if (!value) return 'بدون موعد';
   const due = new Date(value).getTime();
   if (Number.isNaN(due)) return 'موعد نامعتبر';
   const minutes = Math.round((due - now) / 60_000);
   if (minutes < -1440) return `${Math.abs(Math.round(minutes / 1440)).toLocaleString('fa-IR')} روز دیرکرد`;
   if (minutes < -60) return `${Math.abs(Math.round(minutes / 60)).toLocaleString('fa-IR')} ساعت دیرکرد`;
   if (minutes < 0) return `${Math.abs(minutes).toLocaleString('fa-IR')} دقیقه دیرکرد`;
   if (minutes < 60) return `${minutes.toLocaleString('fa-IR')} دقیقه مانده`;
   if (minutes < 1440) return `${Math.round(minutes / 60).toLocaleString('fa-IR')} ساعت مانده`;
   return formatJalaliDateTime(value);
}

export function supportStatusTone(status: SupportCaseStatus): string {
   if (status === 'NEW') return 'border-sky-400/20 bg-sky-400/10 text-sky-300';
   if (status === 'OPEN') return 'border-indigo-400/20 bg-indigo-400/10 text-indigo-300';
   if (status.startsWith('WAITING_')) return 'border-amber-400/20 bg-amber-400/10 text-amber-300';
   if (status === 'RESOLVED') return 'border-lime-400/20 bg-lime-400/10 text-lime-300';
   return 'border-white/10 bg-white/5 text-zinc-400';
}

export function supportPriorityTone(priority: SupportCasePriority): string {
   if (priority === 'URGENT') return 'text-red-300';
   if (priority === 'HIGH') return 'text-orange-300';
   if (priority === 'LOW') return 'text-zinc-500';
   return 'text-zinc-400';
}
