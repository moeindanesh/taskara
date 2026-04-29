import { prisma, type TaskStatus } from '@taskara/db';
import { config } from '../config';
import { sendTemplateSms } from './sms';

const tehranTimeZone = 'Asia/Tehran';
const activeTaskStatuses: TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'];

let reminderTimer: ReturnType<typeof setInterval> | null = null;
let reminderInFlight = false;
let lastReminderDateKey: string | null = null;

type DailySmsReminderResult = {
  noPlanSent: number;
  todayReminderSent: number;
  failed: number;
  skipped: number;
  alreadySent: boolean;
};

export function startDailySmsReminderScheduler(): void {
  if (reminderTimer || !config.TASKARA_SMS_DAILY_REMINDERS_ENABLED) return;

  const tick = () => {
    const tehranNow = tehranDateParts(new Date());
    if (tehranNow.hour !== 10 || tehranNow.minute > 5) return;
    if (reminderInFlight || lastReminderDateKey === tehranNow.dateKey) return;

    reminderInFlight = true;
    sendDailyTaskSmsReminders()
      .then((result) => {
        lastReminderDateKey = tehranNow.dateKey;
        console.log('Daily SMS reminders completed:', result);
      })
      .catch((error) => {
        console.error('Daily SMS reminders failed:', error);
      })
      .finally(() => {
        reminderInFlight = false;
      });
  };

  reminderTimer = setInterval(tick, 60 * 1000);
  tick();
}

export async function sendDailyTaskSmsReminders(dateKey = tehranDateParts(new Date()).dateKey): Promise<DailySmsReminderResult> {
  const run = await reserveDailyReminderRun(dateKey);
  if (!run) {
    return { noPlanSent: 0, todayReminderSent: 0, failed: 0, skipped: 0, alreadySent: true };
  }

  try {
    const result = await sendDailyTaskSmsReminderBatch();
    await prisma.smsDailyReminderRun.update({
      where: { id: run.id },
      data: {
        ...result,
        completedAt: new Date()
      }
    });
    return { ...result, alreadySent: false };
  } catch (error) {
    await prisma.smsDailyReminderRun.update({
      where: { id: run.id },
      data: { error: error instanceof Error ? error.message : String(error) }
    }).catch(() => undefined);
    throw error;
  }
}

async function sendDailyTaskSmsReminderBatch(): Promise<Omit<DailySmsReminderResult, 'alreadySent'>> {
  const users = await prisma.user.findMany({
    where: {
      phone: { not: null },
      workspaces: { some: {} }
    },
    select: {
      id: true,
      name: true,
      phone: true
    },
    orderBy: { createdAt: 'asc' }
  });

  if (users.length === 0) {
    return { noPlanSent: 0, todayReminderSent: 0, failed: 0, skipped: 0 };
  }

  const taskCounts = await prisma.task.groupBy({
    by: ['assigneeId'],
    where: {
      assigneeId: { in: users.map((user) => user.id) },
      status: { in: activeTaskStatuses }
    },
    _count: { _all: true }
  });
  const taskCountByUserId = new Map(
    taskCounts
      .filter((item): item is typeof item & { assigneeId: string } => Boolean(item.assigneeId))
      .map((item) => [item.assigneeId, item._count._all])
  );

  let noPlanSent = 0;
  let todayReminderSent = 0;
  let failed = 0;
  let skipped = 0;

  for (const user of users) {
    if (!user.phone) {
      skipped += 1;
      continue;
    }

    const count = taskCountByUserId.get(user.id) ?? 0;
    try {
      if (count > 0) {
        await sendTemplateSms({
          receptor: user.phone,
          template: 'today-reminder',
          token: count
        });
        todayReminderSent += 1;
      } else {
        await sendTemplateSms({
          receptor: user.phone,
          template: 'no-plan',
          token: user.name,
          token10: user.name
        });
        noPlanSent += 1;
      }
    } catch (error) {
      failed += 1;
      console.error('Daily SMS reminder failed for user:', { userId: user.id, error });
    }
  }

  return { noPlanSent, todayReminderSent, failed, skipped };
}

async function reserveDailyReminderRun(dateKey: string): Promise<{ id: string } | null> {
  try {
    return await prisma.smsDailyReminderRun.create({
      data: { dateKey },
      select: { id: true }
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return null;
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function tehranDateParts(date: Date): { dateKey: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tehranTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour === '24' ? '0' : values.hour);

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    hour,
    minute: Number(values.minute)
  };
}
