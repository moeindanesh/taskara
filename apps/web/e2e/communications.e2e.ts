import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:4199';
const workspaceSlug = 'dastak';
const now = '2026-07-07T09:00:00.000Z';

const workspace = { id: 'workspace-1', name: 'دستک', slug: workspaceSlug };
const adminUser = {
  id: 'user-admin',
  name: 'مدیر عملیات',
  email: 'admin@example.com',
  phone: '+989120000000',
  avatarUrl: null,
};
const participantUser = {
  id: 'user-participant',
  name: 'سارا محصول',
  email: 'sara@example.com',
  phone: '+989121111111',
  avatarUrl: null,
};
const team = { id: 'team-1', name: 'محصول', slug: 'product', description: null };
const project = {
  id: 'project-1',
  name: 'برنامه رشد',
  keyPrefix: 'GROW',
  description: null,
  status: 'ACTIVE',
  team,
  lead: adminUser,
  _count: { tasks: 1, subprojects: 0 },
};
const announcement = {
  id: 'ann-1',
  title: 'اعلان تغییر برنامه انتشار',
  body: 'انتشار نسخه جدید از چهارشنبه به پنجشنبه منتقل شد.',
  status: 'PUBLISHED',
  publishedAt: '2026-07-07T08:00:00.000Z',
  createdAt: '2026-07-07T07:30:00.000Z',
  updatedAt: '2026-07-07T08:00:00.000Z',
  creator: adminUser,
  recipients: [
    {
      id: 'recipient-1',
      userId: adminUser.id,
      deliveredAt: now,
      readAt: null,
      createdAt: now,
      user: adminUser,
    },
    {
      id: 'recipient-2',
      userId: participantUser.id,
      deliveredAt: now,
      readAt: '2026-07-07T08:30:00.000Z',
      createdAt: now,
      user: participantUser,
    },
  ],
  poll: {
    id: 'poll-1',
    question: 'زمان جلسه مرور انتشار؟',
    allowMultiple: false,
    createdAt: now,
    updatedAt: now,
    options: [
      { id: 'poll-option-1', label: 'پنجشنبه صبح', position: 0, createdAt: now, _count: { votes: 1 } },
      { id: 'poll-option-2', label: 'پنجشنبه عصر', position: 1, createdAt: now, _count: { votes: 0 } },
    ],
  },
  pollVoteOptionIds: [],
  _count: { recipients: 2 },
};
const draftAnnouncement = {
  ...announcement,
  id: 'ann-draft',
  title: 'پیش‌نویس اعلان داخلی',
  body: 'قبل از انتشار باید مخاطب‌ها نهایی شوند.',
  status: 'DRAFT',
  publishedAt: null,
  recipients: [],
  poll: null,
  pollVoteOptionIds: [],
  _count: { recipients: 0 },
};
const meeting = {
  id: 'meet-1',
  title: 'جلسه برنامه‌ریزی محصول',
  description: 'دستور جلسه: مرور ریسک‌ها و خروجی‌های هفته.',
  status: 'PLANNED',
  scheduledAt: '2026-07-07T10:00:00.000Z',
  heldAt: null,
  createdAt: '2026-07-06T10:00:00.000Z',
  updatedAt: '2026-07-06T11:00:00.000Z',
  team,
  project,
  owner: adminUser,
  createdBy: adminUser,
  participants: [
    { id: 'participant-1', userId: adminUser.id, role: 'OWNER', createdAt: now, user: adminUser },
    { id: 'participant-2', userId: participantUser.id, role: 'PARTICIPANT', createdAt: now, user: participantUser },
  ],
  tasks: [
    {
      meetingId: 'meet-1',
      taskId: 'task-1',
      createdAt: now,
      task: {
        id: 'task-1',
        key: 'GROW-1',
        title: 'جمع‌بندی تصمیم‌های انتشار',
        status: 'TODO',
        priority: 'MEDIUM',
        createdAt: now,
        updatedAt: now,
        project,
        assignee: adminUser,
        reporter: adminUser,
      },
    },
  ],
  _count: { participants: 2, tasks: 1 },
};
const actionItem = {
  id: 'action-1',
  workspaceId: workspace.id,
  meetingId: meeting.id,
  taskId: null,
  assigneeId: participantUser.id,
  createdById: adminUser.id,
  title: 'تهیه لیست ریسک‌های انتشار',
  notes: 'قبل از جلسه بعدی تکمیل شود.',
  status: 'OPEN',
  dueAt: '2026-07-08T09:00:00.000Z',
  createdAt: now,
  updatedAt: now,
  assignee: participantUser,
  createdBy: adminUser,
  task: null,
  meeting: {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    scheduledAt: meeting.scheduledAt,
    heldAt: null,
    projectId: project.id,
    project,
  },
};

test.describe('communications merged UX', () => {
  test('renders unified اعلان‌ها surface and old deep links', async ({ page }) => {
    await setupCommunicationsPage(page);
    await gotoApp(page, `/${workspaceSlug}/communications`);

    await expect(page.getByRole('heading', { name: 'اعلان‌ها' }).first()).toBeVisible();
    await expect(page.getByText('اعلان تغییر برنامه انتشار')).toBeVisible();
    await expect(page.getByText('جلسه برنامه‌ریزی محصول')).toBeVisible();
    await expect(page.getByPlaceholder('جستجو در اعلان‌ها و جلسه‌ها...')).toBeVisible();

    await page.getByText('اعلان تغییر برنامه انتشار').click();
    await expect(page).toHaveURL(/\/communications\/announcements\/ann-1$/);
    await expect(page.getByRole('main').getByText('انتشار نسخه جدید از چهارشنبه به پنجشنبه منتقل شد.')).toBeVisible();
    await expect(page.getByText('زمان جلسه مرور انتشار؟')).toBeVisible();

    await gotoApp(page, `/${workspaceSlug}/announcements/ann-1`);
    await expect(page.getByRole('heading', { name: 'اعلان تغییر برنامه انتشار' })).toBeVisible();
    await expect(page.getByRole('main').getByText('انتشار نسخه جدید از چهارشنبه به پنجشنبه منتقل شد.')).toBeVisible();

    await gotoApp(page, `/${workspaceSlug}/meetings/meet-1`);
    await expect(page.getByRole('heading', { name: 'جلسه برنامه‌ریزی محصول' })).toBeVisible();
    await expect(page.getByText('تهیه لیست ریسک‌های انتشار')).toBeVisible();
    await expect(page.getByText('جمع‌بندی تصمیم‌های انتشار')).toBeVisible();

    await expectNoPageOverflow(page);
  });

  test('command menu opens merged destination', async ({ page }) => {
    await setupCommunicationsPage(page);
    await gotoApp(page, `/${workspaceSlug}/team/all/all`);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    const command = page.getByRole('dialog', { name: 'منوی فرمان' });
    const search = command.getByRole('combobox');
    await search.fill('اعلان‌ها');
    await expect(command.getByRole('option', { name: /اعلان‌ها/ }).first()).toBeVisible();
    await search.press('Enter');
    await expect(page).toHaveURL(/\/communications$/);
  });
});

async function gotoApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

async function setupCommunicationsPage(page: Page) {
  await page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('taskara.auth.session.v1', JSON.stringify(session));
    },
    {
      session: {
        token: 'e2e-token',
        expiresAt: '2027-01-01T00:00:00.000Z',
        role: 'ADMIN',
        workspace,
        user: adminUser,
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
    if (path === '/sync/pull') return json(route, { cursor: query.get('cursor') || '1', events: [], hasMore: false });
    if (path === '/sync/bootstrap') {
      return json(route, {
        cursor: '1',
        serverTime: now,
        completedWindowDays: 5,
        omittedCompletedBefore: '2026-07-02T00:00:00.000Z',
        tasks: meeting.tasks.map((link) => link.task),
        totalHotTasks: 1,
        projects: [project],
        teams: [team],
        users: [adminUser, participantUser],
        views: [],
      });
    }
    if (path === '/me') return json(route, { workspace, user: adminUser, role: 'ADMIN', unreadNotifications: 1 });
    if (path === '/workspaces') return json(route, { items: [{ membershipId: 'membership-1', role: 'ADMIN', joinedAt: now, workspace }], total: 1 });
    if (path === '/teams') return json(route, [team]);
    if (path === '/users') return json(route, pageResult([adminUser, participantUser], Number(query.get('limit') || 200)));
    if (path === '/projects') return json(route, [project]);
    if (path === '/notifications') return json(route, { ...pageResult([], Number(query.get('limit') || 1)), unreadCount: 1 });
    if (path === '/notifications/sync') return json(route, { items: [], unreadCount: 1, nextCursor: null });
    if (path === '/knowledge/spaces') return json(route, []);
    if (path === '/knowledge/references') return json(route, []);
    if (path === '/knowledge/pages') return json(route, pageResult([]));
    if (path === '/tasks') return json(route, pageResult(meeting.tasks.map((link) => link.task), Number(query.get('limit') || 1)));

    if (path === '/announcements') {
      return json(route, { ...pageResult([announcement, draftAnnouncement], Number(query.get('limit') || 100)), unreadCount: 1 });
    }
    if (request.method() === 'GET' && path === '/announcements/ann-1') return json(route, announcement);
    if (request.method() === 'GET' && path === '/announcements/ann-draft') return json(route, draftAnnouncement);

    if (path === '/meetings') return json(route, pageResult([meeting], Number(query.get('limit') || 100)));
    if (request.method() === 'GET' && path === '/meetings/meet-1') return json(route, meeting);
    if (path === '/meeting-action-items') return json(route, pageResult([actionItem], Number(query.get('limit') || 50)));

    return json(route, {});
  });
}

async function json(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function pageResult<T>(items: T[], limit = items.length) {
  return { items: items.slice(0, limit), total: items.length, limit, offset: 0 };
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
  expect(overflow).toBeLessThanOrEqual(1);
}
