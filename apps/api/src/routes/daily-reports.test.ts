import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { prisma, type WorkspaceRole } from '@taskara/db';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { registerApp } from '../app';
import { createUserSession } from '../services/auth';
import { shiftDateKey, workspaceDateKey } from '../services/workspace-time';

let app: FastifyInstance;
const cleanupWorkspaceIds: string[] = [];
const cleanupUserIds: string[] = [];

type Persona = 'owner' | 'admin' | 'member' | 'teammate' | 'guest';

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
    while (cleanupUserIds.length) {
      const userId = cleanupUserIds.pop();
      if (!userId) continue;
      await prisma.user.deleteMany({ where: { id: userId } });
    }
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
    const today = workspaceDateKey();

    await injectAs(fixture, 'member', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'کار تمام شد', unplannedText: 'وقفه‌ی پشتیبانی' }
    });
    await injectAs(fixture, 'teammate', {
      method: 'POST',
      url: '/check-ins',
      payload: { completedText: 'بررسی کد', blockersText: 'منتظر دسترسی هستم' }
    });

    const response = await injectAs(fixture, 'owner', { method: 'GET', url: `/check-ins/digest?dateKey=${today}` });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      dateKey: string;
      reports: unknown[];
      blockersFirst: Array<{ userId: string }>;
      unplanned: Array<{ userId: string }>;
      missing: Array<{ id: string }>;
      stats: { expected: number; submitted: number; missing: number; blockerCount: number; unplannedShare: number };
    };

    expect(body.dateKey).toBe(today);
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
    guest: await createUser(`dr-guest-${suffix}`, 'Guest')
  };

  await prisma.workspaceMember.createMany({
    data: [
      workspaceMember(workspace.id, users.owner.id, 'OWNER'),
      workspaceMember(workspace.id, users.admin.id, 'ADMIN'),
      workspaceMember(workspace.id, users.member.id, 'MEMBER'),
      workspaceMember(workspace.id, users.teammate.id, 'MEMBER'),
      workspaceMember(workspace.id, users.guest.id, 'GUEST')
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

async function createUser(key: string, name: string) {
  const user = await prisma.user.create({
    data: { email: `${key}@daily-report.test`.toLowerCase(), name },
    select: { id: true, email: true, name: true }
  });
  cleanupUserIds.push(user.id);
  return user;
}

function workspaceMember(workspaceId: string, userId: string, role: WorkspaceRole) {
  return { workspaceId, userId, role };
}
