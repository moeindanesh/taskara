import { AlertTriangle, CheckCircle2, CircleDashed, CircleDot, Clock3, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const statusMeta = {
   BACKLOG: {
      label: 'بک‌لاگ',
      className: 'bg-slate-500/10 text-slate-700 dark:text-slate-200',
      icon: CircleDashed,
   },
   TODO: {
      label: 'برای انجام',
      className: 'bg-blue-500/10 text-blue-700 dark:text-blue-200',
      icon: CircleDot,
   },
   IN_PROGRESS: {
      label: 'در حال انجام',
      className: 'bg-amber-500/10 text-amber-700 dark:text-amber-200',
      icon: Clock3,
   },
   IN_REVIEW: {
      label: 'در بازبینی',
      className: 'bg-violet-500/10 text-violet-700 dark:text-violet-200',
      icon: PauseCircle,
   },
   BLOCKED: {
      label: 'مسدود',
      className: 'bg-rose-500/10 text-rose-700 dark:text-rose-200',
      icon: AlertTriangle,
   },
   DONE: {
      label: 'انجام‌شده',
      className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
      icon: CheckCircle2,
   },
   CANCELED: {
      label: 'لغوشده',
      className: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-200',
      icon: PauseCircle,
   },
} as const;

const priorityMeta = {
   NO_PRIORITY: { label: 'بدون اولویت', className: 'bg-muted text-muted-foreground' },
   LOW: { label: 'کم', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-200' },
   MEDIUM: { label: 'متوسط', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-200' },
   HIGH: { label: 'زیاد', className: 'bg-orange-500/10 text-orange-700 dark:text-orange-200' },
   URGENT: { label: 'فوری', className: 'bg-rose-500/10 text-rose-700 dark:text-rose-200' },
} as const;

const roleMeta = {
   OWNER: { label: 'مالک', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200' },
   ADMIN: { label: 'مدیر', className: 'bg-violet-500/10 text-violet-700 dark:text-violet-200' },
   MEMBER: { label: 'عضو', className: 'bg-blue-500/10 text-blue-700 dark:text-blue-200' },
   GUEST: { label: 'مهمان', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-200' },
   AGENT: { label: 'عامل', className: 'bg-slate-500/10 text-slate-700 dark:text-slate-200' },
} as const;

export const taskStatuses = Object.keys(statusMeta) as Array<keyof typeof statusMeta>;
export const taskPriorities = Object.keys(priorityMeta) as Array<keyof typeof priorityMeta>;
export const workspaceRoles = Object.keys(roleMeta) as Array<keyof typeof roleMeta>;

export function StatusBadge({ status }: { status: string }) {
   const item = statusMeta[status as keyof typeof statusMeta] || statusMeta.TODO;
   const Icon = item.icon;
   return (
      <Badge variant="secondary" className={item.className}>
         <Icon className="size-3.5" />
         {item.label}
      </Badge>
   );
}

export function PriorityBadge({ priority }: { priority: string }) {
   const item = priorityMeta[priority as keyof typeof priorityMeta] || priorityMeta.NO_PRIORITY;
   return (
      <Badge variant="secondary" className={item.className}>
         {item.label}
      </Badge>
   );
}

export function RoleBadge({ role }: { role: string }) {
   const item = roleMeta[role as keyof typeof roleMeta] || roleMeta.MEMBER;
   return (
      <Badge variant="secondary" className={item.className}>
         {item.label}
      </Badge>
   );
}

export function getStatusLabel(status: string) {
   return (statusMeta[status as keyof typeof statusMeta] || statusMeta.TODO).label;
}

export function getPriorityLabel(priority: string) {
   return (priorityMeta[priority as keyof typeof priorityMeta] || priorityMeta.NO_PRIORITY).label;
}
