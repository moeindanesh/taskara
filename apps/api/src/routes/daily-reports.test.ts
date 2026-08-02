import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type UserKind, type WorkspaceRole } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { createUserSession } from '../services/auth';
import { isWorkdayKey, shiftDateKey, workspaceDateKey } from '../services/workspace-time';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];

const EMAIL_DOMAIN = 'daily-report.test';

type Persona = 'owner' | 'admin' | 'member' | 'teammate' | 'guest' | 'agent';

interface Fixture {
  workspace: { id: string; slug: string };
  users: Record<Persona, { id: string; email: string; name: string }>;
  sessions: Record<Persona, string>;
}

describe('daily reports', () => {
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerApp(app);
    await app.ready();
  });

  afterEach(async () => {
    while (cleanupWorkspaceIds.length) {
      const workspaceId = cleanupWorkspaceIds.pop();
      if (!workspaceId) continue;
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    // Tracking ids only cleans up runs that reach this hook. Sweeping by a domain
    // unique to this file also reclaims rows stranded by an interrupted earlier run.
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  });

  afterAll(async () => {
    await app.close();
  });

  test('resubmitting the same day edits one report instead of stacking duplicates', async () => {
    const fixture = await createFixture();

    const first = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'اولین نسخه', planText: 'فردا API' }
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; dateKey: string };
    expect(firstBody.dateKey).toBe(workspaceDateKey());

    const second = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'نسخه‌ی ویرایش‌شده', unplannedText: 'یک باگ فوری' }
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { id: string; completedText: string; unplannedText: string; planText: string | null };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.completedText).toBe('نسخه‌ی ویرایش‌شده');
    expect(secondBody.unplannedText).toBe('یک باگ فوری');
    // The submitted payload is the whole report, so an omitted section is cleared.
    expect(secondBody.planText).toBeNull();

    const rows = await prisma.checkInResponse.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.users.member.id }
    });
    expect(rows).toBe(1);
  });

  test('members can only file their own report for the current day', async () => {
    const fixture = await createFixture();

    const backdated = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'گزارش دیروز', dateKey: shiftDateKey(workspaceDateKey(), -1) }
    });
    expect(backdated.statusCode).toBe(400);

    const future = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'گزارش فردا', dateKey: shiftDateKey(workspaceDateKey(), 1) }
    });
    expect(future.statusCode).toBe(400);
  });

  test('admins may backfill yesterday for another member and are recorded as the author', async () => {
    const fixture = await createFixture();
    const yesterday = shiftDateKey(workspaceDateKey(), -1);

    const response = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/check-ins',
      payload: { userId: fixture.users.member.id, completedText: 'ثبت‌شده توسط مدیر', dateKey: yesterday }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { userId: string; authorId: string; dateKey: string };
    expect(body.userId).toBe(fixture.users.member.id);
    expect(body.authorId).toBe(fixture.users.admin.id);
    expect(body.dateKey).toBe(yesterday);
  });

  test('members cannot file a report on behalf of someone else', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { userId: fixture.users.teammate.id, completedText: 'به جای دیگری' }
    });

    expect(response.statusCode).toBe(403);
  });

  test('a report needs at least one answered section', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: '   ', planText: '' }
    });

    expect(response.statusCode).toBe(400);
  });

  test('reports are peer-visible to members but hidden from guests', async () => {
    const fixture = await createFixture();
    await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'گزارش عضو' }
    });

    const teammateView = await injectAs(fixture, 'teammate', { method: 'GET', url: '/check-ins' });
    expect(teammateView.statusCode).toBe(200);
    expect((teammateView.json() as { items: unknown[] }).items).toHaveLength(1);

    const guestView = await injectAs(fixture, 'guest', { method: 'GET', url: '/check-ins' });
    expect(guestView.statusCode).toBe(200);
    expect((guestView.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  test('digest puts blockers first, counts unplanned work, and lists who is missing', async () => {
    const fixture = await createFixture();
    // Pinned to a workday, like the trends tests: the digest only has a denominator on the days the
    // ritual actually asks for a report, so anything asserting a rate has to name one rather than
    // inherit whichever weekday the suite happens to run on.
    const [workday] = recentWorkdays(1);

    await prisma.checkInResponse.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.users.member.id,
          authorId: fixture.users.member.id,
          dateKey: workday,
          completedText: 'کار تمام شد',
          unplannedText: 'وقفه‌ی پشتیبانی'
        },
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.users.teammate.id,
          authorId: fixture.users.teammate.id,
          dateKey: workday,
          completedText: 'بررسی کد',
          blockersText: 'منتظر دسترسی هستم'
        }
      ]
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${workday}` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      dateKey: string;
      reports: unknown[];
      blockersFirst: Array<{ userId: string }>;
      unplanned: Array<{ userId: string }>;
      missing: Array<{ id: string }>;
      stats: { expected: number; submitted: number; missing: number; blockerCount: number; unplannedShare: number };
    };

    expect(body.dateKey).toBe(workday);
    expect(body.reports).toHaveLength(2);
    expect(body.blockersFirst.map((item) => item.userId)).toEqual([fixture.users.teammate.id]);
    expect(body.unplanned.map((item) => item.userId)).toEqual([fixture.users.member.id]);
    // owner + admin + member + teammate are expected; the guest never is.
    expect(body.stats.expected).toBe(4);
    expect(body.stats.submitted).toBe(2);
    expect(body.stats.missing).toBe(2);
    expect(body.stats.blockerCount).toBe(1);
    expect(body.stats.unplannedShare).toBe(50);
    expect(body.missing.map((user) => user.id).sort()).toEqual(
      [fixture.users.owner.id, fixture.users.admin.id].sort()
    );
  });

  test('digest compares yesterday plan against today completed', async () => {
    const fixture = await createFixture();
    const today = workspaceDateKey();

    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.member.id,
        authorId: fixture.users.member.id,
        dateKey: shiftDateKey(today, -1),
        planText: 'فردا صفحه‌ی ورود را تمام می‌کنم'
      }
    });
    await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'صفحه‌ی ورود تمام شد' }
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${today}` });
    const body = response.json() as {
      planVsDone: Array<{ userId: string; plannedYesterday: string; completedToday: string }>;
    };

    expect(body.planVsDone).toHaveLength(1);
    expect(body.planVsDone[0].plannedYesterday).toBe('فردا صفحه‌ی ورود را تمام می‌کنم');
    expect(body.planVsDone[0].completedToday).toBe('صفحه‌ی ورود تمام شد');
  });

  test('a task touched several ways today yields one chip, at its strongest reason', async () => {
    const fixture = await createFixture();

    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'پروژه‌ی آزمون',
        keyPrefix: `T${Math.floor(Math.random() * 9000 + 1000)}`
      },
      select: { id: true }
    });

    const created = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/tasks',
      payload: { projectId: project.id, title: 'کار چندباره', assigneeId: fixture.users.member.id }
    });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; key: string };

    // Same task: created earlier, then moved to DONE. Both actions qualify as candidates.
    const done = await injectAs(fixture, 'member', {
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      payload: { status: 'DONE' }
    });
    expect(done.statusCode).toBe(200);

    const draft = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/draft' });
    expect(draft.statusCode).toBe(200);

    const body = draft.json() as {
      completedCandidates: Array<{ key: string; reason: string }>;
    };
    const forTask = body.completedCandidates.filter((candidate) => candidate.key === task.key);

    // One chip, not one per reason — two chips would insert the same line twice.
    expect(forTask).toHaveLength(1);
    expect(forTask[0].reason).toBe('completed');
  });

  test('trends report participation and unplanned-work share over a window', async () => {
    const fixture = await createFixture();
    const today = workspaceDateKey();
    // Reports are placed on workdays on purpose: those are the only days the window has a slot for,
    // so this is the case where numerator and denominator are actually comparable.
    const [latestWorkday, previousWorkday] = recentWorkdays(2);

    await prisma.checkInResponse.createMany({
      data: [
        { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: latestWorkday, completedText: 'الف', unplannedText: 'وقفه' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.teammate.id, dateKey: latestWorkday, completedText: 'ب' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: previousWorkday, completedText: 'پ', blockersText: 'گیر' }
      ]
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: '/check-ins/trends?days=7' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      days: number;
      workdays: number;
      byDay: Array<{ dateKey: string; workday: boolean; submitted: number; expected: number; unplannedShare: number }>;
      byPerson: Array<{ user: { id: string }; submitted: number; possible: number; unplannedDays: number }>;
      totals: { submitted: number; possible: number; unplannedShare: number; blockerShare: number };
    };

    expect(body.days).toBe(7);
    expect(body.byDay).toHaveLength(7);
    expect(body.byDay.at(-1)?.dateKey).toBe(today);

    const latest = body.byDay.find((day) => day.dateKey === latestWorkday);
    expect(latest?.submitted).toBe(2);
    // One of that day's two reports carried unexpected work.
    expect(latest?.unplannedShare).toBe(50);

    expect(body.totals.submitted).toBe(3);
    // 4 reporting members over the workdays in the window — weekends are not counted, because
    // nobody is asked for a report on them.
    expect(body.workdays).toBeGreaterThan(0);
    expect(body.workdays).toBeLessThan(7);
    expect(body.totals.possible).toBe(4 * body.workdays);
    expect(body.totals.unplannedShare).toBe(33);
    expect(body.totals.blockerShare).toBe(33);

    // A weekend day expects nothing, so an empty Thursday is not a participation failure.
    const weekend = body.byDay.filter((day) => !day.workday);
    expect(weekend.length).toBeGreaterThan(0);
    for (const day of weekend) expect(day.expected).toBe(0);

    const member = body.byPerson.find((entry) => entry.user.id === fixture.users.member.id);
    expect(member?.submitted).toBe(2);
    expect(member?.unplannedDays).toBe(1);
  });

  // The other axis of the same 100% bug: the populations can agree about WHO is measured and still
  // disagree about WHICH DAYS. Nobody is asked for a report on a weekend, so `expected` there is 0 —
  // and a report filed anyway used to be counted against it.
  test('a report filed on a non-workday enters no rate on either axis', async () => {
    const fixture = await createFixture();
    const [workday] = recentWorkdays(1);
    const [offDay] = recentNonWorkdays(1);

    await prisma.checkInResponse.createMany({
      data: [
        { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: workday, completedText: 'روز کاری' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: offDay, completedText: 'آخر هفته', unplannedText: 'وقفه' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.teammate.id, dateKey: offDay, completedText: 'آخر هفته' }
      ]
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: '/check-ins/trends?days=7' });
    const body = response.json() as {
      byDay: Array<{
        dateKey: string;
        workday: boolean;
        submitted: number;
        counted: number;
        expected: number;
        unplanned: number;
      }>;
      byPerson: Array<{ user: { id: string }; submitted: number; possible: number; unplannedDays: number }>;
      totals: { submitted: number; possible: number; unplannedShare: number };
    };

    const off = body.byDay.find((day) => day.dateKey === offDay);
    expect(off?.workday).toBe(false);
    expect(off?.expected).toBe(0);
    // Both halves of the split, on the day that separates them. The two people who worked the
    // weekend are still on the chart — dropping them was how a member who filed on a Thursday
    // disappeared from their own trends — and neither of them enters a rate.
    expect(off?.submitted).toBe(2);
    expect(off?.unplanned).toBe(1);
    expect(off?.counted).toBe(0);

    expect(body.totals.submitted).toBe(1);
    // The weekend row carried the only unexpected-work text; counting it would have divided it by a
    // workday-only denominator.
    expect(body.totals.unplannedShare).toBe(0);

    // The invariant, stated over every day and over the window as a whole — over `counted`, which is
    // the value `expected` is a denominator for. `submitted` is a display count and is deliberately
    // free to exceed it.
    for (const day of body.byDay) expect(day.counted).toBeLessThanOrEqual(day.expected);
    for (const person of body.byPerson) expect(person.submitted).toBeLessThanOrEqual(person.possible);
    expect(body.totals.submitted).toBeLessThanOrEqual(body.totals.possible);
  });

  // The digest used to have no opinion about which day it was asked about while trends did, so on a
  // Thursday the two endpoints described the same workspace differently: trends said the day asks
  // for nothing, the digest said 0 of 4 and named every human as missing.
  test('the digest treats a non-workday the way trends does', async () => {
    const fixture = await createFixture();
    const [offDay] = recentNonWorkdays(1);

    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.member.id,
        authorId: fixture.users.member.id,
        dateKey: offDay,
        completedText: 'آخر هفته کار کردم',
        blockersText: 'منتظر پاسخ'
      }
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${offDay}` });
    const body = response.json() as {
      workday: boolean;
      reports: Array<{ userId: string }>;
      blockersFirst: Array<{ userId: string }>;
      missing: Array<{ id: string }>;
      stats: { expected: number; submitted: number; missing: number; participationRate: number; blockerCount: number };
    };

    // VISIBILITY is untouched: the report was filed, and the manager reads it and its blocker.
    expect(body.workday).toBe(false);
    expect(body.reports.map((report) => report.userId)).toEqual([fixture.users.member.id]);
    expect(body.blockersFirst.map((item) => item.userId)).toEqual([fixture.users.member.id]);

    // MEASUREMENT has no denominator on a day nobody was asked, so nobody owes anything and there
    // is no rate to report — the same answer trends gives for the same day.
    expect(body.stats.expected).toBe(0);
    expect(body.stats.submitted).toBe(0);
    expect(body.stats.participationRate).toBe(0);
    expect(body.stats.blockerCount).toBe(0);
    expect(body.stats.missing).toBe(0);
    expect(body.missing).toEqual([]);
  });

  test('trends are admin-only', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/trends' });

    expect(response.statusCode).toBe(403);
  });

  test('digest is admin-only', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/digest' });

    expect(response.statusCode).toBe(403);
  });

  test('draft prefills yesterday plan and today work without writing anything', async () => {
    const fixture = await createFixture();
    const today = workspaceDateKey();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: 'Draft Project',
        keyPrefix: `DR${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
      },
      select: { id: true, keyPrefix: true }
    });
    await prisma.task.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        sequence: 1,
        key: `${project.keyPrefix}-1`,
        title: 'کار باز برای برنامه‌ی امروز',
        status: 'TODO',
        priority: 'HIGH',
        weight: 2,
        assigneeId: fixture.users.member.id
      }
    });
    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.member.id,
        authorId: fixture.users.member.id,
        dateKey: shiftDateKey(today, -1),
        planText: 'برنامه‌ی دیروز'
      }
    });

    const response = await injectAs(fixture, 'member', { method: 'GET', url: '/check-ins/draft' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      dateKey: string;
      existing: unknown | null;
      yesterday: { planText: string } | null;
      planCandidates: Array<{ key: string; title: string }>;
      unplannedCandidates: Array<{ key: string }>;
    };

    expect(body.dateKey).toBe(today);
    expect(body.existing).toBeNull();
    expect(body.yesterday?.planText).toBe('برنامه‌ی دیروز');
    expect(body.planCandidates.map((item) => item.key)).toContain(`${project.keyPrefix}-1`);
    // A draft must never create a report as a side effect.
    expect(await prisma.checkInResponse.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: today }
    })).toBe(0);
  });

  test('missing list can be scoped to a specific day', async () => {
    const fixture = await createFixture();
    await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'ثبت شد' }
    });

    const today = await injectAs(fixture, 'owner', {
      method: 'GET',
      url: `/check-ins/missing?dateKey=${workspaceDateKey()}`
    });
    const yesterday = await injectAs(fixture, 'owner', {
      method: 'GET',
      url: `/check-ins/missing?dateKey=${shiftDateKey(workspaceDateKey(), -1)}`
    });

    expect((today.json() as { total: number }).total).toBe(3);
    expect((yesterday.json() as { total: number }).total).toBe(4);
  });

  test('admins can request a report and the member receives a notification', async () => {
    const fixture = await createFixture();

    const response = await injectAs(fixture, 'owner', {
      method: 'POST',
      url: '/check-ins/request',
      payload: { userId: fixture.users.member.id, message: 'لطفاً امروز ثبت کن' }
    });
    expect(response.statusCode).toBe(201);

    const notifications = await prisma.notification.findMany({
      where: { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, type: 'daily_report_requested' }
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe('لطفاً امروز ثبت کن');

    const denied = await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins/request',
      payload: { userId: fixture.users.teammate.id }
    });
    expect(denied.statusCode).toBe(403);
  });

  test('an agent cannot file a report, and no admin can file one for it', async () => {
    const fixture = await createFixture();

    const self = await injectAs(fixture, 'agent', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'سه تسک بستم' }
    });
    expect(self.statusCode).toBe(403);

    const backfill = await injectAs(fixture, 'admin', {
      method: 'POST',
      url: '/check-ins',
      payload: { userId: fixture.users.agent.id, completedText: 'به جای ایجنت' }
    });
    expect(backfill.statusCode).toBe(403);

    expect(await prisma.checkInResponse.count({
      where: { workspaceId: fixture.workspace.id, userId: fixture.users.agent.id }
    })).toBe(0);
  });

  test('a legacy agent report is counted in neither the numerator nor the denominator', async () => {
    const fixture = await createFixture();
    const [workday] = recentWorkdays(1);

    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.member.id,
        authorId: fixture.users.member.id,
        dateKey: workday,
        completedText: 'کار تمام شد',
        blockersText: 'منتظر دسترسی'
      }
    });
    // Written straight to the table: the gate stops new agent reports, but rows filed before it
    // existed are exactly the case that pushed participation over 100%.
    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.agent.id,
        authorId: fixture.users.agent.id,
        dateKey: workday,
        completedText: 'گزارش ایجنت',
        unplannedText: 'کار پیش‌بینی‌نشده'
      }
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${workday}` });
    const body = response.json() as {
      reports: Array<{ userId: string }>;
      blockersFirst: Array<{ userId: string }>;
      unplanned: Array<{ userId: string }>;
      missing: Array<{ id: string }>;
      stats: { expected: number; submitted: number; missing: number; participationRate: number; unplannedShare: number };
    };

    // owner + admin + member + teammate. The guest is not asked, and neither is the agent.
    expect(body.stats.expected).toBe(4);
    expect(body.stats.submitted).toBe(1);
    expect(body.stats.submitted).toBeLessThanOrEqual(body.stats.expected);
    expect(body.stats.participationRate).toBe(25);
    expect(body.stats.missing).toBe(3);
    // Visible, because a manager cannot act on a report they cannot see; never owed, because the
    // agent is not asked for one.
    expect(body.reports.map((report) => report.userId).sort()).toEqual(
      [fixture.users.member.id, fixture.users.agent.id].sort()
    );
    expect(body.missing.map((user) => user.id)).not.toContain(fixture.users.agent.id);
    expect(body.unplanned.map((item) => item.userId)).toEqual([fixture.users.agent.id]);
    // …and counted nowhere. Both sides of the share come from the measured subset, so the agent's
    // unexpected-work row cannot be divided by the human's submission count.
    expect(body.stats.unplannedShare).toBe(0);
    // The human's own numbers are untouched by the agent row sitting next to them.
    expect(body.blockersFirst.map((item) => item.userId)).toEqual([fixture.users.member.id]);
  });

  // The mirror image of the agent case, and the one that is easy to get wrong by over-correcting:
  // a guest is a human who files a report nobody asked for. They are not scored, but they must not
  // disappear from what a manager reads either.
  test('a guest human is visible in the digest and absent from every rate', async () => {
    const fixture = await createFixture();
    const [workday] = recentWorkdays(1);

    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.member.id,
        authorId: fixture.users.member.id,
        dateKey: workday,
        completedText: 'کار عضو'
      }
    });
    await prisma.checkInResponse.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.users.guest.id,
        authorId: fixture.users.guest.id,
        dateKey: workday,
        completedText: 'کار پیمانکار',
        blockersText: 'دسترسی ندارم',
        unplannedText: 'درخواست فوری'
      }
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${workday}` });
    const body = response.json() as {
      reports: Array<{ userId: string }>;
      blockersFirst: Array<{ userId: string }>;
      unplanned: Array<{ userId: string }>;
      missing: Array<{ id: string }>;
      stats: { expected: number; submitted: number; participationRate: number; blockerCount: number; unplannedShare: number };
    };

    // VISIBILITY: the guest's report, and the blocker in it, reach the manager.
    expect(body.reports.map((report) => report.userId)).toContain(fixture.users.guest.id);
    expect(body.blockersFirst.map((item) => item.userId)).toContain(fixture.users.guest.id);
    expect(body.unplanned.map((item) => item.userId)).toContain(fixture.users.guest.id);

    // MEASUREMENT: none of it moves a number. Only the member counts, out of the four asked.
    expect(body.stats.expected).toBe(4);
    expect(body.stats.submitted).toBe(1);
    expect(body.stats.participationRate).toBe(25);
    expect(body.stats.blockerCount).toBe(0);
    expect(body.stats.unplannedShare).toBe(0);
    // A guest is never in the missing list, because a guest was never asked.
    expect(body.missing.map((user) => user.id)).not.toContain(fixture.users.guest.id);
  });

  test('trends never report more submissions than the window could possibly hold', async () => {
    const fixture = await createFixture();
    const [workday] = recentWorkdays(1);

    await prisma.checkInResponse.createMany({
      data: [
        { workspaceId: fixture.workspace.id, userId: fixture.users.member.id, dateKey: workday, completedText: 'الف' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.agent.id, dateKey: workday, completedText: 'ب' },
        { workspaceId: fixture.workspace.id, userId: fixture.users.guest.id, dateKey: workday, completedText: 'پ' }
      ]
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: '/check-ins/trends?days=7' });
    const body = response.json() as {
      byDay: Array<{ dateKey: string; workday: boolean; submitted: number; counted: number; expected: number }>;
      byPerson: Array<{ user: { id: string } }>;
      totals: { submitted: number; possible: number };
    };

    expect(body.totals.submitted).toBe(1);
    expect(body.totals.possible).toBe(4 * body.byDay.filter((day) => day.workday).length);
    expect(body.totals.submitted).toBeLessThanOrEqual(body.totals.possible);
    // All three reports are on the chart for that day — the agent's and the guest's rows happened,
    // and hiding them is not what keeps them out of the rate. `counted` is what keeps them out.
    const filedDay = body.byDay.find((day) => day.dateKey === workday);
    expect(filedDay?.submitted).toBe(3);
    expect(filedDay?.counted).toBe(1);
    // The invariant is stated over `counted`, the value `expected` is the denominator for.
    for (const day of body.byDay) {
      expect(day.counted).toBeLessThanOrEqual(day.expected);
    }
    // A GUEST human is excluded too. This is the assertion that fails if the predicate is ever
    // "simplified" down to the kind clause alone.
    const counted = body.byPerson.map((entry) => entry.user.id);
    expect(counted).not.toContain(fixture.users.guest.id);
    expect(counted).not.toContain(fixture.users.agent.id);
    expect(counted).toContain(fixture.users.member.id);
  });

  test('offline sync mutation upserts the same day report', async () => {
    const fixture = await createFixture();

    const push = async (mutationId: string, completedText: string) => app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: {
        authorization: `Bearer ${fixture.sessions.member}`,
        'x-workspace-slug': fixture.workspace.slug
      },
      payload: {
        clientId: 'test-client',
        mutations: [{ mutationId, name: 'check_in.upsert', args: { completedText } }]
      }
    });

    const first = await push(crypto.randomUUID(), 'نسخه‌ی آفلاین');
    expect(first.statusCode).toBe(200);
    const second = await push(crypto.randomUUID(), 'نسخه‌ی دوم');
    expect(second.statusCode).toBe(200);

    const rows = await prisma.checkInResponse.findMany({
      where: { workspaceId: fixture.workspace.id, userId: fixture.users.member.id }
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].completedText).toBe('نسخه‌ی دوم');
  });
});

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Daily Report ${suffix}`,
      slug: `daily-report-${suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 60)
    },
    select: { id: true, slug: true }
  });
  cleanupWorkspaceIds.push(workspace.id);

  const users = {
    owner: await createUser(`dr-owner-${suffix}`, 'Owner'),
    admin: await createUser(`dr-admin-${suffix}`, 'Admin'),
    member: await createUser(`dr-member-${suffix}`, 'Member'),
    teammate: await createUser(`dr-teammate-${suffix}`, 'Teammate'),
    guest: await createUser(`dr-guest-${suffix}`, 'Guest'),
    agent: await createUser(`dr-agent-${suffix}`, 'Agent', 'AGENT')
  };

  await prisma.workspaceMember.createMany({
    data: [
      workspaceMember(workspace.id, users.owner.id, 'OWNER'),
      workspaceMember(workspace.id, users.admin.id, 'ADMIN'),
      workspaceMember(workspace.id, users.member.id, 'MEMBER'),
      workspaceMember(workspace.id, users.teammate.id, 'MEMBER'),
      workspaceMember(workspace.id, users.guest.id, 'GUEST'),
      // Role MEMBER deliberately: agent-ness lives on the user, so a role-based discriminator
      // would count this one and every assertion below would still pass for the wrong reason.
      workspaceMember(workspace.id, users.agent.id, 'MEMBER')
    ]
  });

  const sessions = Object.fromEntries(
    await Promise.all(
      (Object.entries(users) as Array<[Persona, { id: string }]>).map(async ([key, user]) => {
        const session = await createUserSession(user.id);
        return [key, session.token] as const;
      })
    )
  ) as Record<Persona, string>;

  return { workspace, users, sessions };
}

async function injectAs(fixture: Fixture, persona: Persona, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${fixture.sessions[persona]}`,
      'x-workspace-slug': fixture.workspace.slug,
      ...(options.headers || {})
    }
  });
}

async function createUser(key: string, name: string, kind: UserKind = 'HUMAN') {
  const user = await prisma.user.create({
    data: { email: `${key}@${EMAIL_DOMAIN}`.toLowerCase(), name, kind },
    select: { id: true, email: true, name: true }
  });
  return user;
}

function workspaceMember(workspaceId: string, userId: string, role: WorkspaceRole) {
  return { workspaceId, userId, role };
}

/**
 * Day keys inside the default 7-day trends window, newest first.
 *
 * The suite runs on whatever day it runs, and a 7-day window over a 5-day work week always holds
 * 5 workdays and 2 days off — so both helpers below can always fill a small request. Pinning
 * reports to the right kind of day is what keeps these tests about the rate under test rather than
 * about which weekday CI happened to start on.
 */
function windowDayKeys(days = 7): string[] {
  const today = workspaceDateKey();
  const keys: string[] = [];
  for (let offset = 0; offset < days; offset += 1) keys.push(shiftDateKey(today, -offset));
  return keys;
}

function recentWorkdays(count: number): string[] {
  const keys = windowDayKeys().filter(isWorkdayKey).slice(0, count);
  if (keys.length < count) throw new Error(`Expected ${count} workdays in the trends window`);
  return keys;
}

function recentNonWorkdays(count: number): string[] {
  const keys = windowDayKeys().filter((key) => !isWorkdayKey(key)).slice(0, count);
  if (keys.length < count) throw new Error(`Expected ${count} non-workdays in the trends window`);
  return keys;
}
