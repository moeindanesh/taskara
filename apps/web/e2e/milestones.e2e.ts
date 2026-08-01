import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:4199';
const workspaceSlug = 'dastak';
const now = '2026-07-11T09:00:00.000Z';

const workspace = { id: 'workspace-1', name: 'دستک', slug: workspaceSlug };
const admin = {
  id: 'user-admin',
  membershipId: 'membership-admin',
  name: 'نگار راهبر محصول',
  email: 'admin@example.com',
  phone: null,
  avatarUrl: null,
  role: 'ADMIN',
  joinedAt: now,
};
const teammate = {
  id: 'user-member',
  membershipId: 'membership-member',
  name: 'سارا توسعه‌دهنده',
  email: 'sara@example.com',
  phone: null,
  avatarUrl: null,
  role: 'MEMBER',
  joinedAt: now,
};
const team = { id: 'team-1', name: 'محصول', slug: 'product', description: null };
const project = {
  id: 'project-1',
  name: 'تجربه ممتاز تسکارا',
  keyPrefix: 'PREM',
  description: null,
  status: 'ACTIVE',
  team,
  lead: admin,
  _count: { tasks: 3, subprojects: 0, milestones: 2 },
};

test.describe('milestones premium workflow', () => {
  test('keeps the primary hub, RTL deep links, keyboard controls, and responsive layout usable', async ({ page, isMobile }) => {
    const fixture = await setupMilestonesPage(page);
    await page.goto(`/${workspaceSlug}/milestones`, { waitUntil: 'domcontentloaded' });

    const screen = page.getByTestId('milestones-screen');
    await expect(screen).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'گام‌ها' })).toBeVisible();
    await expect(page.getByRole('button', { name: /آماده‌سازی نسخه ممتاز/ })).toBeVisible();
    expect(await screen.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl');
    await expect(screen.getByRole('button', { name: /^$/ })).toHaveCount(0);

    if (!isMobile) {
      await expect(page.getByRole('link', { name: /گام‌ها/ })).toHaveAttribute('href', `/${workspaceSlug}/milestones`);
    }

    await page.getByRole('button', { name: /آماده‌سازی نسخه ممتاز/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/${workspaceSlug}/milestones/${fixture.milestones[0].id}`));
    await expect(page.getByText('نمای کلی')).toBeVisible();
    await expect(page.getByText('کارها').first()).toBeVisible();
    await expect(page.locator('main').getByText('فعال').first()).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: /^$/ })).toHaveCount(0);
    await expectNoPageOverflow(page);

    if (!isMobile) {
      await page.getByRole('button', { name: 'اقدام‌های گام' }).click();
      await page.getByRole('menuitem', { name: /انتقال یک جایگاه پایین‌تر/ }).click();
      await expect.poll(() => fixture.mutationNames()).toContain('milestone.reorder');
    }
  });

  test('keeps the hub and detail legible in light theme', async ({ page }) => {
    const fixture = await setupMilestonesPage(page);
    await page.addInitScript(() => window.localStorage.setItem('theme', 'light'));
    await page.goto(`/${workspaceSlug}/milestones`, { waitUntil: 'domcontentloaded' });

    const screen = page.getByTestId('milestones-screen');
    await expect(screen).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/light/);
    expect(await screen.evaluate((element) => {
      const [red = 0, green = 0, blue = 0] = getComputedStyle(element).backgroundColor.match(/\d+/g)?.map(Number) || [];
      return red + green + blue;
    })).toBeGreaterThan(300);
    await page.getByRole('button', { name: /آماده‌سازی نسخه ممتاز/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${workspaceSlug}/milestones/${fixture.milestones[0].id}`));
    await expect(page.locator('main').getByText('آماده‌سازی نسخه ممتاز').first()).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('creates a phase through the persisted sync path and preserves a stable deep link', async ({ page }) => {
    const fixture = await setupMilestonesPage(page);
    await page.goto(`/${workspaceSlug}/milestones`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'گام جدید' }).click();
    const dialog = page.getByRole('dialog', { name: 'گام جدید' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'تاریخ هدف', exact: true }).click();
    const calendar = page.locator('[role="dialog"].taskara-jalali-calendar');
    await expect(calendar).toBeVisible();
    expect(await calendar.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    })).toBe(true);
    await dialog.getByRole('button', { name: 'تاریخ هدف', exact: true }).click();
    await dialog.getByPlaceholder('مثلاً آماده‌سازی نسخه عمومی').fill('فاز استقرار تدریجی');
    await dialog.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: /فاز اجرا/ }).click();
    await dialog.getByRole('button', { name: 'فعال' }).click();
    await dialog.getByRole('button', { name: 'ایجاد گام' }).click();

    await expect(page).toHaveURL(new RegExp(`/${workspaceSlug}/milestones/[0-9a-f-]{36}$`));
    await expect(page.locator('main').getByText('فاز استقرار تدریجی').first()).toBeVisible();
    await expect(page.locator('main').getByText('فاز اجرا').first()).toBeVisible();
    const createMutation = fixture.mutations().find((mutation) => mutation.name === 'milestone.create');
    expect(createMutation).toBeTruthy();
    expect(createMutation?.args).toMatchObject({
      projectId: project.id,
      kind: 'PHASE',
      status: 'ACTIVE',
      name: 'فاز استقرار تدریجی',
    });
    expect((createMutation?.args as { id?: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    await expectNoPageOverflow(page);
  });

  test('requires an explicit unfinished-work decision and supports complete, archive, and restore', async ({ page }) => {
    const fixture = await setupMilestonesPage(page);
    const milestone = fixture.milestones[0];
    await page.goto(`/${workspaceSlug}/milestones/${milestone.id}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('button', { name: 'تکمیل', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'اقدام‌های گام' }).click();
    await page.getByRole('menuitem', { name: 'تکمیل', exact: true }).click();
    const completion = page.getByRole('dialog', { name: 'تکمیل گام' });
    await expect(completion.getByRole('button', { name: 'تکمیل' })).toBeDisabled();
    await completion.getByLabel(/نگه‌داشتن در این گام/).check();
    await completion.getByPlaceholder(/نتیجه، آموخته‌ها/).fill('خروجی فاز با موفقیت تحویل شد.');
    await completion.getByRole('button', { name: 'تکمیل' }).click();

    await expect(page.locator('main').getByText('تکمیل‌شده').first()).toBeVisible();
    await expect.poll(() => fixture.mutationNames()).toContain('milestone.complete');
    const completeMutation = fixture.mutations().find((mutation) => mutation.name === 'milestone.complete');
    expect(completeMutation?.args).toMatchObject({
      id: milestone.id,
      completion: {
        unfinishedTaskPolicy: 'KEEP',
        note: 'خروجی فاز با موفقیت تحویل شد.',
      },
    });

    await page.getByRole('button', { name: 'اقدام‌های گام' }).click();
    await page.getByRole('menuitem', { name: 'آرشیو' }).click();
    const archive = page.getByRole('dialog', { name: 'آرشیو' });
    await archive.getByRole('button', { name: 'آرشیو' }).click();
    await expect(page.getByText(/این گام آرشیوشده/)).toBeVisible();

    await page.getByRole('button', { name: 'اقدام‌های گام' }).click();
    await page.getByRole('menuitem', { name: 'بازگردانی' }).click();
    const restore = page.getByRole('dialog', { name: 'بازگردانی' });
    await restore.getByRole('button', { name: 'بازگردانی' }).click();
    await expect(page.getByText(/این گام آرشیوشده/)).toBeHidden();
    await expect.poll(() => fixture.mutationNames()).toEqual(expect.arrayContaining([
      'milestone.complete',
      'milestone.archive',
      'milestone.restore',
    ]));
  });

  test('keeps an offline create visible, durable, and automatically reconciled after reconnect', async ({ page }) => {
    const fixture = await setupMilestonesPage(page);
    await page.goto(`/${workspaceSlug}/milestones`, { waitUntil: 'domcontentloaded' });
    const pushesBeforeOffline = fixture.mutationNames().length;
    await page.context().setOffline(true);

    await page.getByRole('button', { name: 'گام جدید' }).click();
    const dialog = page.getByRole('dialog', { name: 'گام جدید' });
    await dialog.getByPlaceholder('مثلاً آماده‌سازی نسخه عمومی').fill('ویژگی ساخته‌شده آفلاین');
    await dialog.getByRole('button', { name: 'ایجاد گام' }).click();

    await expect(page.locator('main').getByText('ویژگی ساخته‌شده آفلاین').first()).toBeVisible();
    await expect(page.getByText(/یک تغییر همگام‌نشده دارد/)).toBeVisible();
    expect(fixture.mutationNames()).toHaveLength(pushesBeforeOffline);
    await expect.poll(() => pendingMutationCount(page)).toBe(1);

    await page.context().setOffline(false);
    await expect.poll(() => fixture.mutationNames(), { timeout: 10_000 }).toContain('milestone.create');
    await expect(page.getByText(/یک تغییر همگام‌نشده دارد/)).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => pendingMutationCount(page), { timeout: 10_000 }).toBe(0);
    await expect(page.locator('main').getByText('ویژگی ساخته‌شده آفلاین').first()).toBeVisible();
  });

  test('retains a metadata draft across a version conflict and retries against the latest version', async ({ page }) => {
    const fixture = await setupMilestonesPage(page);
    const milestone = fixture.milestones[0];
    await page.goto(`/${workspaceSlug}/milestones/${milestone.id}`, { waitUntil: 'domcontentloaded' });

    fixture.conflictNextMetadataUpdate();
    const name = page.getByRole('textbox', { name: 'نام' });
    const save = page.getByRole('button', { name: 'ذخیره تغییرات' });
    await expect(save).toHaveCount(0);
    await name.fill('پیش‌نویس حفظ‌شده');
    const properties = page.getByRole('complementary', { name: 'ویژگی‌های گام' });
    await properties.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'فاز اجرا' }).click();
    await expect(save).toHaveCount(1);
    await save.click();

    await expect(page.getByText(/پیش‌نویس شما حفظ شده است/)).toBeVisible();
    await expect(name).toHaveValue('پیش‌نویس حفظ‌شده');
    await expect(properties.getByRole('combobox').first()).toContainText('فاز اجرا');
    await page.getByRole('button', { name: 'تلاش دوباره' }).click();
    await expect.poll(() => fixture.mutationNames().filter((item) => item === 'milestone.update').length).toBe(2);
    await expect(name).toHaveValue('پیش‌نویس حفظ‌شده');
    const updates = fixture.mutations().filter((mutation) => mutation.name === 'milestone.update');
    expect(updates[1]?.args).toMatchObject({
      id: milestone.id,
      patch: { version: 2, name: 'پیش‌نویس حفظ‌شده', kind: 'PHASE' },
    });
  });
});

type MockMutation = { mutationId: string; name: string; args: Record<string, unknown> };

async function setupMilestonesPage(page: Page) {
  const milestones = [
    makeMilestone({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'آماده‌سازی نسخه ممتاز',
      kind: 'FEATURE',
      status: 'ACTIVE',
      health: 'AT_RISK',
      targetOn: '2026-07-01',
      position: 1024,
    }),
    makeMilestone({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'فاز مهاجرت داده',
      kind: 'PHASE',
      status: 'PLANNED',
      health: 'ON_TRACK',
      targetOn: '2026-08-15',
      position: 2048,
      progress: emptyProgress(),
    }),
  ];
  const tasks = [
    makeTask({ id: 'task-1', key: 'PREM-1', title: 'طراحی مسیر اصلی', status: 'DONE', milestone: milestones[0] }),
    makeTask({ id: 'task-2', key: 'PREM-2', title: 'پیاده‌سازی تجربه', status: 'TODO', milestone: milestones[0] }),
    makeTask({ id: 'task-3', key: 'PREM-3', title: 'رفع مانع انتشار', status: 'BLOCKED', milestone: milestones[0] }),
  ];
  const mutationLog: MockMutation[] = [];
  const pendingEvents: Array<Record<string, unknown>> = [];
  let cursor = 10;
  let conflictNextMetadataUpdate = false;

  await page.addInitScript(
    ({ session }) => window.localStorage.setItem('taskara.auth.session.v1', JSON.stringify(session)),
    {
      session: {
        token: 'e2e-token',
        expiresAt: '2027-01-01T00:00:00.000Z',
        role: 'ADMIN',
        workspace,
        user: admin,
      },
    }
  );

  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const query = url.searchParams;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (path === '/sync/stream') return route.fulfill({ status: 204 });
    if (path === '/sync/bootstrap') {
      return json(route, {
        cursor: String(cursor),
        serverTime: now,
        completedWindowDays: 5,
        omittedCompletedBefore: '2026-07-06T00:00:00.000Z',
        tasks,
        milestones: milestones.filter((milestone) => !milestone.archivedAt),
        totalHotTasks: tasks.length,
        projects: [project],
        teams: [team],
        users: [admin, teammate],
        views: [],
      });
    }
    if (path === '/sync/pull') {
      const events = pendingEvents.splice(0);
      return json(route, { cursor: String(cursor), events, hasMore: false });
    }
    if (request.method() === 'POST' && path === '/sync/push') {
      const body = request.postDataJSON() as { clientId: string; mutations: MockMutation[] };
      const results = body.mutations.map((mutation) => {
        mutationLog.push(structuredClone(mutation));
        if (conflictNextMetadataUpdate && mutation.name === 'milestone.update') {
          conflictNextMetadataUpdate = false;
          const remote = milestones.find((item) => item.id === mutation.args.id);
          if (remote) {
            remote.version += 1;
            remote.updatedAt = now;
          }
          cursor += 1;
          return {
            mutationId: mutation.mutationId,
            status: 'conflict',
            workspaceSeq: String(cursor),
            error: { code: 'CONFLICT', message: 'Milestone changed on another client', retryable: false },
          };
        }
        const entity = applyMutation(mutation, milestones, tasks);
        cursor += 1;
        const milestone = mutationMilestone(entity);
        if (milestone) {
          pendingEvents.push({
            cursor: String(cursor),
            entityType: 'milestone',
            entityId: milestone.id,
            clientId: body.clientId,
            mutationId: mutation.mutationId,
            type: mutation.name === 'milestone.archive' ? 'removeFromScope' : 'upsert',
            entity: milestone,
          });
        }
        return { mutationId: mutation.mutationId, status: 'applied', workspaceSeq: String(cursor), entity };
      });
      return json(route, { cursor: String(cursor), results });
    }

    if (path === '/me') return json(route, { workspace, user: admin, role: 'ADMIN', unreadNotifications: 0 });
    if (path === '/workspaces') return json(route, { items: [{ membershipId: admin.membershipId, role: 'ADMIN', joinedAt: now, workspace }], total: 1 });
    if (path === '/teams') return json(route, [team]);
    if (path === '/users') return json(route, pageResult([admin, teammate], query));
    if (path === '/projects') return json(route, [project]);
    if (path === '/notifications') return json(route, { ...pageResult([], query), unreadCount: 0 });
    if (path === '/notifications/sync') return json(route, { items: [], unreadCount: 0, nextCursor: null });
    if (path === '/knowledge/spaces' || path === '/knowledge/references') return json(route, []);
    if (path === '/knowledge/pages') return json(route, pageResult([], query));

    if (path === '/milestones/owner-candidates') {
      return json(route, { items: [admin, teammate], total: 2, limit: 200 });
    }
    if (request.method() === 'GET' && path === '/milestones') {
      let items = [...milestones];
      if (query.get('includeArchived') !== 'true') items = items.filter((milestone) => !milestone.archivedAt);
      if (query.get('archivedOnly') === 'true') items = items.filter((milestone) => Boolean(milestone.archivedAt));
      const statuses = query.get('status')?.split(',').filter(Boolean);
      if (statuses?.length) items = items.filter((milestone) => statuses.includes(milestone.status));
      if (query.get('projectId')) items = items.filter((milestone) => milestone.projectId === query.get('projectId'));
      const search = query.get('q')?.toLocaleLowerCase('fa');
      if (search) items = items.filter((milestone) => milestone.name.toLocaleLowerCase('fa').includes(search));
      items.sort((left, right) => left.position - right.position);
      return json(route, pageResult(items, query));
    }
    const activityMatch = path.match(/^\/milestones\/([^/]+)\/activity$/);
    if (activityMatch) return json(route, []);
    const milestoneMatch = path.match(/^\/milestones\/([^/]+)$/);
    if (request.method() === 'GET' && milestoneMatch) {
      const milestone = milestones.find((item) => item.id === milestoneMatch[1]);
      return milestone ? json(route, milestone) : json(route, { message: 'Not found' }, 404);
    }
    if (request.method() === 'GET' && path === '/tasks') {
      let items = [...tasks];
      if (query.get('milestoneId')) items = items.filter((task) => task.milestoneId === query.get('milestoneId'));
      if (query.get('projectId')) items = items.filter((task) => task.project?.id === query.get('projectId'));
      return json(route, pageResult(items, query));
    }

    return json(route, {});
  });

  return {
    milestones,
    conflictNextMetadataUpdate: () => {
      conflictNextMetadataUpdate = true;
    },
    mutations: () => [...mutationLog],
    mutationNames: () => mutationLog.map((mutation) => mutation.name),
  };
}

function applyMutation(
  mutation: MockMutation,
  milestones: ReturnType<typeof makeMilestone>[],
  tasks: ReturnType<typeof makeTask>[]
) {
  if (mutation.name === 'milestone.create') {
    const input = mutation.args as Record<string, unknown>;
    const created = makeMilestone({
      id: String(input.id),
      name: String(input.name),
      kind: input.kind as 'FEATURE' | 'PHASE' | 'OTHER',
      status: input.status as 'PLANNED' | 'ACTIVE',
      ownerId: input.ownerId ? String(input.ownerId) : null,
      owner: input.ownerId === teammate.id ? teammate : input.ownerId ? admin : null,
      description: input.description ? String(input.description) : null,
      health: (input.health || null) as 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | null,
      startsOn: input.startsOn ? String(input.startsOn) : null,
      targetOn: input.targetOn ? String(input.targetOn) : null,
      position: Math.max(0, ...milestones.map((milestone) => milestone.position)) + 1024,
      progress: emptyProgress(),
    });
    milestones.push(created);
    return created;
  }

  const id = String(mutation.args.id || '');
  const milestone = milestones.find((item) => item.id === id);
  if (mutation.name === 'task.update') {
    const args = mutation.args as { idOrKey?: string; patch?: { milestoneId?: string | null } };
    const task = tasks.find((item) => item.id === args.idOrKey || item.key === args.idOrKey)!;
    if (args.patch && Object.prototype.hasOwnProperty.call(args.patch, 'milestoneId')) {
      task.milestoneId = args.patch.milestoneId || null;
      const next = milestones.find((item) => item.id === args.patch?.milestoneId);
      task.milestone = next ? milestoneRelation(next) : null;
    }
    task.version += 1;
    task.updatedAt = now;
    return task;
  }
  if (!milestone) return null;

  milestone.version += 1;
  milestone.updatedAt = now;
  if (mutation.name === 'milestone.update') {
    const patch = (mutation.args.patch || {}) as Record<string, unknown>;
    Object.assign(milestone, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'version')));
  } else if (mutation.name === 'milestone.reorder') {
    const reorder = mutation.args.reorder as { beforeId?: string | null; afterId?: string | null };
    const before = milestones.find((item) => item.id === reorder.beforeId);
    const after = milestones.find((item) => item.id === reorder.afterId);
    if (before && after) milestone.position = (before.position + after.position) / 2;
    else if (before) milestone.position = before.position + 1024;
    else if (after) milestone.position = after.position - 1024;
  } else if (mutation.name === 'milestone.activate' || mutation.name === 'milestone.reopen') {
    milestone.status = 'ACTIVE';
    milestone.completedAt = null;
    milestone.canceledAt = null;
  } else if (mutation.name === 'milestone.complete') {
    milestone.status = 'COMPLETED';
    milestone.completedAt = now;
    milestone.canceledAt = null;
  } else if (mutation.name === 'milestone.cancel') {
    milestone.status = 'CANCELED';
    milestone.completedAt = null;
    milestone.canceledAt = now;
  } else if (mutation.name === 'milestone.archive') {
    milestone.archivedAt = now;
  } else if (mutation.name === 'milestone.restore') {
    milestone.archivedAt = null;
  }

  if (mutation.name === 'milestone.complete' || mutation.name === 'milestone.cancel') {
    const completion = mutation.args.completion as { unfinishedTaskPolicy?: string; targetMilestoneId?: string };
    return {
      milestone: structuredClone(milestone),
      disposition: {
        policy: completion.unfinishedTaskPolicy || null,
        affectedTasks: milestone.progress.eligibleTasks - milestone.progress.completedTasks,
        targetMilestoneId: completion.targetMilestoneId || null,
      },
    };
  }
  return structuredClone(milestone);
}

function mutationMilestone(entity: unknown) {
  if (!entity || typeof entity !== 'object') return null;
  const record = entity as { id?: string; projectId?: string; milestone?: unknown };
  if (record.id && record.projectId) return entity as ReturnType<typeof makeMilestone>;
  return mutationMilestone(record.milestone);
}

function makeMilestone(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: admin.id as string | null,
    name: 'آماده‌سازی نسخه ممتاز',
    description: 'نتیجه قابل اندازه‌گیری برای انتشار عمومی.',
    kind: 'FEATURE' as 'FEATURE' | 'PHASE' | 'OTHER',
    status: 'ACTIVE' as 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED',
    health: 'AT_RISK' as 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | null,
    startsOn: '2026-06-15' as string | null,
    targetOn: '2026-07-01' as string | null,
    position: 1024,
    version: 1,
    completedAt: null as string | null,
    canceledAt: null as string | null,
    archivedAt: null as string | null,
    createdAt: '2026-06-10T09:00:00.000Z',
    updatedAt: now,
    project: {
      id: project.id,
      name: project.name,
      keyPrefix: project.keyPrefix,
      teamId: team.id,
      leadId: admin.id,
      team,
      lead: admin,
    },
    owner: admin as typeof admin | null,
    progress: {
      totalTasks: 3,
      eligibleTasks: 3,
      completedTasks: 1,
      canceledTasks: 0,
      blockedTasks: 1,
      overdueTasks: 1,
      totalWeight: 5,
      completedWeight: 2,
      percentage: 33,
    },
    attentionReasons: ['OVERDUE', 'BLOCKED_TASKS'],
    readyToComplete: false,
    canManage: true,
    ...overrides,
  };
}

function makeTask({
  id,
  key,
  title,
  status,
  milestone,
}: {
  id: string;
  key: string;
  title: string;
  status: 'TODO' | 'BLOCKED' | 'DONE';
  milestone: ReturnType<typeof makeMilestone>;
}) {
  return {
    id,
    key,
    title,
    description: null,
    status,
    priority: 'MEDIUM',
    weight: status === 'DONE' ? 2 : 1,
    dueAt: status === 'BLOCKED' ? '2026-07-01T09:00:00.000Z' : null,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: now,
    completedAt: status === 'DONE' ? now : null,
    progressStartedAt: null,
    version: 1,
    project,
    milestoneId: milestone.id as string | null,
    milestone: milestoneRelation(milestone) as ReturnType<typeof milestoneRelation> | null,
    assignee: teammate,
    labels: [],
    _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
  };
}

function milestoneRelation(milestone: ReturnType<typeof makeMilestone>) {
  return {
    id: milestone.id,
    name: milestone.name,
    kind: milestone.kind,
    status: milestone.status,
    archivedAt: milestone.archivedAt,
    projectId: milestone.projectId,
  };
}

function emptyProgress() {
  return {
    totalTasks: 0,
    eligibleTasks: 0,
    completedTasks: 0,
    canceledTasks: 0,
    blockedTasks: 0,
    overdueTasks: 0,
    totalWeight: 0,
    completedWeight: 0,
    percentage: null,
  };
}

function pageResult<T>(items: T[], query: URLSearchParams) {
  const limit = Number(query.get('limit') || items.length || 50);
  const offset = Number(query.get('offset') || 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  expect(overflow).toBeLessThanOrEqual(1);
}

async function pendingMutationCount(page: Page) {
  return page.evaluate(async () => new Promise<number>((resolve) => {
    const request = indexedDB.open('taskara-task-sync', 2);
    request.onerror = () => resolve(-1);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pendingMutations')) {
        db.close();
        resolve(0);
        return;
      }
      const count = db.transaction('pendingMutations', 'readonly').objectStore('pendingMutations').count();
      count.onerror = () => {
        db.close();
        resolve(-1);
      };
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
    };
  }));
}
