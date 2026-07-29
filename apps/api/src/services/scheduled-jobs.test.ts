import { afterEach, describe, expect, test } from 'bun:test';
import { prisma, type WorkspaceRole } from '@taskara/db';
import {
  dailyReportJobs,
  jobShouldFire,
  notifyDigestReady,
  runJobOnce,
  sendDailyReportReminders,
  type ScheduledJob
} from './scheduled-jobs';
import { shiftDateKey, workspaceDateKey } from './workspace-time';

const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupJobKeys: string[] = [];

afterEach(async () => {
  while (cleanupWorkspaceIds.length) {
    const workspaceId = cleanupWorkspaceIds.pop();
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }
  while (cleanupUserIds.length) {
    const userId = cleanupUserIds.pop();
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  }
  while (cleanupJobKeys.length) {
    const jobKey = cleanupJobKeys.pop();
    if (jobKey) await prisma.scheduledJobRun.deleteMany({ where: { jobKey } });
  }
});

describe('scheduled job windows', () => {
  const reminder = dailyReportJobs().find((job) => job.key === 'daily_report_reminder')!;

  test('fires inside the workspace-local evening window on a workday', () => {
    // 2026-07-28 is a Tuesday; 14:00 UTC is 17:30 Tehran.
    expect(jobShouldFire(reminder, new Date('2026-07-28T14:00:00.000Z'))).toBe(true);
  });

  test('does not fire before or after the window', () => {
    expect(jobShouldFire(reminder, new Date('2026-07-28T13:25:00.000Z'))).toBe(false); // 16:55 Tehran
    expect(jobShouldFire(reminder, new Date('2026-07-28T14:10:00.000Z'))).toBe(false); // 17:40 Tehran
  });

  test('stays silent on the weekend', () => {
    // 2026-07-30 is a Thursday and 2026-07-31 a Friday — the Iranian weekend.
    expect(jobShouldFire(reminder, new Date('2026-07-30T14:00:00.000Z'))).toBe(false);
    expect(jobShouldFire(reminder, new Date('2026-07-31T14:00:00.000Z'))).toBe(false);
  });
});

describe('scheduled job locking', () => {
  test('a second run of the same day is skipped, so nothing double-sends', async () => {
    let runs = 0;
    const job: ScheduledJob = {
      key: `test_job_${Math.random().toString(36).slice(2)}`,
      hour: 0,
      minuteUntil: 5,
      workdaysOnly: false,
      run: async () => {
        runs += 1;
        return { ran: runs };
      }
    };
    cleanupJobKeys.push(job.key);

    const first = await runJobOnce(job, '2026-07-28');
    const second = await runJobOnce(job, '2026-07-28');
    const nextDay = await runJobOnce(job, '2026-07-29');

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(nextDay).toBe(true);
    expect(runs).toBe(2);
  });

  test('a failing job records the error and still holds the day', async () => {
    const job: ScheduledJob = {
      key: `test_fail_${Math.random().toString(36).slice(2)}`,
      hour: 0,
      minuteUntil: 5,
      workdaysOnly: false,
      run: async () => {
        throw new Error('boom');
      }
    };
    cleanupJobKeys.push(job.key);

    expect(await runJobOnce(job, '2026-07-28')).toBe(true);

    const row = await prisma.scheduledJobRun.findUniqueOrThrow({
      where: { jobKey_dateKey: { jobKey: job.key, dateKey: '2026-07-28' } }
    });
    expect(row.error).toBe('boom');
    expect(row.completedAt).not.toBeNull();
    expect(await runJobOnce(job, '2026-07-28')).toBe(false);
  });
});

describe('daily report reminders', () => {
  test('nudges only the people who have not filed yet', async () => {
    const fixture = await createWorkspace();
    const today = workspaceDateKey();

    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspaceId,
        userId: fixture.filed,
        authorId: fixture.filed,
        dateKey: today,
        completedText: 'ثبت شده'
      }
    });

    const stats = await sendDailyReportReminders(today);
    expect(stats.reminded).toBeGreaterThanOrEqual(2);

    const reminded = await prisma.notification.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'daily_report_reminder' },
      select: { userId: true }
    });
    const remindedIds = reminded.map((row) => row.userId);

    expect(remindedIds).toContain(fixture.pending);
    expect(remindedIds).toContain(fixture.owner);
    expect(remindedIds).not.toContain(fixture.filed);
    // Guests are never asked for a daily report.
    expect(remindedIds).not.toContain(fixture.guest);
  });
});

describe('digest ready notification', () => {
  test('tells admins how many reports and blockers yesterday held', async () => {
    const fixture = await createWorkspace();
    const today = workspaceDateKey();
    const yesterday = shiftDateKey(today, -1);

    await prisma.checkInResponse.createMany({
      data: [
        {
          workspaceId: fixture.workspaceId,
          userId: fixture.filed,
          dateKey: yesterday,
          completedText: 'کار انجام شد'
        },
        {
          workspaceId: fixture.workspaceId,
          userId: fixture.pending,
          dateKey: yesterday,
          completedText: 'بررسی',
          blockersText: 'منتظر دسترسی'
        }
      ]
    });

    await notifyDigestReady(today);

    const notifications = await prisma.notification.findMany({
      where: { workspaceId: fixture.workspaceId, type: 'daily_report_digest_ready' },
      select: { userId: true, body: true }
    });

    expect(notifications.map((row) => row.userId).sort()).toEqual([fixture.owner, fixture.admin].sort());
    expect(notifications[0].body).toContain('۲');
    expect(notifications[0].body).toContain('۱');
  });
});

async function createWorkspace() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: { name: `Jobs ${suffix}`, slug: `jobs-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60) },
    select: { id: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const make = async (key: string, role: WorkspaceRole) => {
    const user = await prisma.user.create({
      data: { email: `${key}-${suffix}@jobs.test`.toLowerCase(), name: key },
      select: { id: true }
    });
    cleanupUserIds.push(user.id);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
    return user.id;
  };

  return {
    workspaceId: workspace.id,
    owner: await make('owner', 'OWNER'),
    admin: await make('admin', 'ADMIN'),
    filed: await make('filed', 'MEMBER'),
    pending: await make('pending', 'MEMBER'),
    guest: await make('guest', 'GUEST')
  };
}
