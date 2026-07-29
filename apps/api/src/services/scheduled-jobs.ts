import { prisma } from '@taskara/db';
import { config } from '../config';
import { sendMessageSimple } from './sms';
import {
  DAILY_REPORT_DIGEST_NOTIFICATION_TYPE,
  DAILY_REPORT_REMINDER_NOTIFICATION_TYPE
} from './notifications';
import { isHoliday, isWorkday, shiftDateKey, workspaceClockParts, workspaceDateKey } from './workspace-time';

export interface ScheduledJob {
  key: string;
  // Fire window in workspace-local time. The tick runs every minute, so a few minutes of width is
  // enough to survive a restart without needing a catch-up pass.
  hour: number;
  minuteUntil: number;
  workdaysOnly: boolean;
  run: (dateKey: string) => Promise<Record<string, number>>;
}

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function dailyReportJobs(): ScheduledJob[] {
  return [
    {
      key: 'daily_report_reminder',
      hour: 17,
      minuteUntil: 35,
      workdaysOnly: true,
      run: sendDailyReportReminders
    },
    {
      key: 'daily_report_digest_ready',
      hour: 9,
      minuteUntil: 10,
      workdaysOnly: true,
      // The digest covers the previous workspace day, which is what a manager reads in the morning.
      run: (dateKey) => notifyDigestReady(dateKey)
    }
  ];
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export function jobShouldFire(job: ScheduledJob, now: Date): boolean {
  const parts = workspaceClockParts(now);
  if (job.workdaysOnly && (!isWorkday(now) || isHoliday(parts.dateKey))) return false;
  return parts.hour === job.hour && parts.minute <= job.minuteUntil;
}

export function startScheduledJobs(jobs: ScheduledJob[] = dailyReportJobs()): void {
  if (!config.TASKARA_SCHEDULED_JOBS_ENABLED || timer) return;
  timer = setInterval(() => {
    void runDueJobs(jobs).catch(() => undefined);
  }, TICK_MS);
  timer.unref?.();
}

export function stopScheduledJobs(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function runDueJobs(jobs: ScheduledJob[], now = new Date()): Promise<void> {
  for (const job of jobs) {
    if (!jobShouldFire(job, now)) continue;
    await runJobOnce(job, workspaceDateKey(now));
  }
}

// Claims the day by inserting the ledger row first; a unique-constraint violation means another
// instance already owns this run, so we do nothing rather than send twice.
export async function runJobOnce(job: ScheduledJob, dateKey: string): Promise<boolean> {
  try {
    await prisma.scheduledJobRun.create({ data: { jobKey: job.key, dateKey } });
  } catch (error) {
    // Only a lost race means "someone else has this day"; anything else is a real failure.
    if (isUniqueConstraintError(error)) return false;
    throw error;
  }

  try {
    const stats = await job.run(dateKey);
    await prisma.scheduledJobRun.update({
      where: { jobKey_dateKey: { jobKey: job.key, dateKey } },
      data: { completedAt: new Date(), stats }
    });
  } catch (error) {
    await prisma.scheduledJobRun.update({
      where: { jobKey_dateKey: { jobKey: job.key, dateKey } },
      data: { completedAt: new Date(), error: error instanceof Error ? error.message : String(error) }
    }).catch(() => undefined);
  }
  return true;
}

// Nudges only people who still owe today's report — never anyone who already filed.
export async function sendDailyReportReminders(dateKey: string): Promise<Record<string, number>> {
  const [members, submitted] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { role: { notIn: ['AGENT', 'GUEST'] } },
      select: { workspaceId: true, userId: true }
    }),
    prisma.checkInResponse.findMany({ where: { dateKey }, select: { workspaceId: true, userId: true } })
  ]);

  const filed = new Set(submitted.map((row) => `${row.workspaceId}:${row.userId}`));
  const pending = members.filter((member) => !filed.has(`${member.workspaceId}:${member.userId}`));
  if (!pending.length) return { reminded: 0, skipped: members.length };

  await prisma.notification.createMany({
    data: pending.map((member) => ({
      workspaceId: member.workspaceId,
      userId: member.userId,
      type: DAILY_REPORT_REMINDER_NOTIFICATION_TYPE,
      title: 'گزارش روزانه‌ات را ثبت کن',
      body: 'سه خط کافی است: چه کردی، چه چیز غیرمنتظره‌ای پیش آمد و بعد چه می‌کنی.'
    }))
  });

  const sms = config.TASKARA_DAILY_REPORT_SMS_ENABLED ? await escalateBySms(pending) : 0;
  return { reminded: pending.length, skipped: members.length - pending.length, sms };
}

// Off by default. When a workspace opts in, people who ignored the in-app nudge get exactly one
// SMS, audited per recipient with a masked number like every other SMS path.
async function escalateBySms(pending: Array<{ workspaceId: string; userId: string }>): Promise<number> {
  const users = await prisma.user.findMany({
    where: { id: { in: pending.map((member) => member.userId) }, phone: { not: null } },
    select: { id: true, phone: true }
  });
  const workspaceByUser = new Map(pending.map((member) => [member.userId, member.workspaceId]));

  let sent = 0;
  for (const user of users) {
    if (!user.phone) continue;
    const workspaceId = workspaceByUser.get(user.id);
    if (!workspaceId) continue;
    try {
      await sendMessageSimple(user.phone, 'گزارش روزانه‌ات در تسکارا ثبت نشده است.', config.SMS_KAVEH_SENDER);
      sent += 1;
      await logReminderSms(workspaceId, user.id, 'SENT', user.phone);
    } catch (error) {
      await logReminderSms(workspaceId, user.id, 'FAILED', user.phone, error instanceof Error ? error.message : 'SMS failed');
    }
  }
  return sent;
}

async function logReminderSms(
  workspaceId: string,
  userId: string,
  status: 'SENT' | 'FAILED',
  phone: string,
  error?: string
): Promise<void> {
  await prisma.smsDelivery.create({
    data: {
      workspaceId,
      entityType: 'check_in',
      entityId: userId,
      userId,
      kind: 'daily_report_reminder',
      status,
      receptor: maskPhone(phone),
      error,
      providerEndpoint: 'sms/send.json'
    }
  }).catch(() => undefined);
}

// Tells managers yesterday's reports are ready to read, with the two numbers that decide whether
// they need to act right now.
export async function notifyDigestReady(dateKey: string): Promise<Record<string, number>> {
  const previousDateKey = shiftDateKey(dateKey, -1);
  const [admins, reports] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { role: { in: ['OWNER', 'ADMIN'] } },
      select: { workspaceId: true, userId: true }
    }),
    prisma.checkInResponse.findMany({
      where: { dateKey: previousDateKey },
      select: { workspaceId: true, blockersText: true, helpText: true }
    })
  ]);

  const byWorkspace = new Map<string, { submitted: number; blockers: number }>();
  for (const report of reports) {
    const current = byWorkspace.get(report.workspaceId) || { submitted: 0, blockers: 0 };
    current.submitted += 1;
    if (report.blockersText || report.helpText) current.blockers += 1;
    byWorkspace.set(report.workspaceId, current);
  }

  const notifications = admins
    .filter((admin) => byWorkspace.has(admin.workspaceId))
    .map((admin) => {
      const summary = byWorkspace.get(admin.workspaceId)!;
      return {
        workspaceId: admin.workspaceId,
        userId: admin.userId,
        type: DAILY_REPORT_DIGEST_NOTIFICATION_TYPE,
        title: 'گزارش‌های دیروز آماده است',
        body: `${summary.submitted.toLocaleString('fa-IR')} گزارش، ${summary.blockers.toLocaleString('fa-IR')} گیر.`
      };
    });

  if (notifications.length) await prisma.notification.createMany({ data: notifications });
  return { notified: notifications.length, workspaces: byWorkspace.size };
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
}
