import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:4199';
const workspaceSlug = 'dastak';
const now = '2026-07-06T09:00:00.000Z';

test.describe('@manager-os manager surfaces', () => {
  test.describe.configure({ mode: 'serial' });

  test('decision queues render actionable manager queues without horizontal overflow', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/queues`);

    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expect(page.getByRole('link', { name: 'صندوق ورودی' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'صف بازبینی' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'تریاژ ورودی' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'واگذاری و مالکیت' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'پیگیری افراد' })).toBeVisible();
    await expect(page.getByText(longPersianTitle)).toBeVisible();
    const screen = page.getByTestId('decision-queues-screen');
    await expect(screen.getByRole('link', { name: /بازبینی/ }).first()).toHaveAttribute('href', /\/issue\/CORE-101/);
    await expect(screen.getByRole('button', { name: /پذیرش/ }).first()).toBeVisible();
    await expect(screen.getByRole('link', { name: /جزئیات/ }).first()).toHaveAttribute('href', /\/issue\/CORE-102/);
    await expectDecisionRowBadgesBelowTitle(page, 'کار نزدیک به موعد که هنوز مسئول ندارد');
    await expectIssueTitleTooltip(page, longPersianTitle);

    await expectNoPageOverflow(page);
  });

  test('decision queues applies inline backlog triage accept decision', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/queues`);

    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await page.getByRole('button', { name: /پذیرش/ }).first().click();
    await expect(page.getByRole('heading', { name: 'پذیرش ورودی' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'پذیرش ورودی' }).getByText('CORE-102')).toBeVisible();

    await page.getByLabel('یادداشت تصمیم').fill('ورودی معتبر است اما مسئول نهایی بعد از برنامه‌ریزی صبح مشخص می‌شود.');
    await page.getByRole('button', { name: /ثبت پذیرش/ }).click();

    await expect(page.getByText('کار از بک‌لاگ پذیرفته شد.')).toBeVisible();
    await expect(page.getByText('درخواست ورودی از مترموست که هنوز اولویت و مالک ندارد')).toBeHidden();
    await expectNoPageOverflow(page);
  });

  test('decision queues applies durable triage snooze decision', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/queues`);

    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await page.getByRole('button', { name: /تعویق/ }).first().click();
    await expect(page.getByRole('heading', { name: 'تعویق ورودی' })).toBeVisible();

    await page.getByLabel('یادداشت تصمیم').fill('تا بعد از جلسه برنامه‌ریزی صبح منتظر می‌ماند.');
    await page.getByRole('button', { name: /ثبت تعویق/ }).click();

    await expect(page.getByText('ورودی تریاژ تعویق شد.')).toBeVisible();
    await expect(page.getByText('درخواست ورودی از مترموست که هنوز اولویت و مالک ندارد')).toBeHidden();
    await expectNoPageOverflow(page);
  });

  test('decision queues splits a large backlog item into smaller durable tasks', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/queues`);

    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await page.getByRole('button', { name: /تقسیم/ }).first().click();
    await expect(page.getByRole('heading', { name: 'تقسیم ورودی' })).toBeVisible();

    await page.getByPlaceholder('عنوان کار ۱').fill('شفاف‌سازی نیازمندی ورود از مترموست');
    await page.getByPlaceholder('عنوان کار ۲').fill('ساخت مسیر ثبت خودکار ورودی');
    await page.getByPlaceholder('چرا این ورودی به چند کار تقسیم می‌شود؟').fill('ورودی اولیه چند خروجی مستقل دارد و باید جداگانه مالک‌گذاری شود.');
    await page.getByRole('button', { name: /ثبت تقسیم/ }).click();

    await expect(page.getByText('ورودی به کارهای کوچک‌تر تقسیم شد.')).toBeVisible();
    await expect(page.getByText('درخواست ورودی از مترموست که هنوز اولویت و مالک ندارد')).toBeHidden();
    await expectNoPageOverflow(page);
  });

  test('my reviews renders reviewer decisions and applies approval', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/reviews`);

    await expect(page.getByTestId('reviews-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'بازبینی‌های باز' })).toBeVisible();
    await expect(page.getByText(longPersianTitle)).toBeVisible();
    await expect(page.getByText('درخواست‌دهنده: مدیر عملیات با نام بسیار طولانی برای تست چینش')).toBeVisible();
    await expect(page.getByRole('link', { name: /باز کردن کار/ })).toHaveAttribute('href', /\/issue\/CORE-101/);
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: /تایید/ }).click();
    await expect(page.getByText(longPersianTitle)).toBeHidden();
    await expect(page.getByText('بازبینی بازی برای شما نیست.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('people workload drills into capacity and opens assigned task creation', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/people?person=${users.overloaded.id}`);

    await expect(page.getByTestId('people-workload-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'بار افراد' })).toBeVisible();
    await expect(page.getByRole('link', { name: /ظرفیت و توافق‌ها/ })).toHaveAttribute('href', /\/capacity$/);
    await expect(page.getByText('امیر توسعه‌دهنده با ظرفیت پر').first()).toBeVisible();
    await expect(page.getByText('رفع مانع پرداخت که مسیر انتشار را نگه داشته است')).toBeVisible();
    await expect(page.getByText('چک‌این عقب‌افتاده').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /برنامه sync/ }).first()).toHaveAttribute('href', /\/meetings$/);
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: /واگذاری کار/ }).first().click();
    await expect(page.getByPlaceholder('عنوان کار')).toBeVisible();
    await expect(page.getByRole('button', { name: 'مسئول' })).toContainText('امیر توسعه‌دهنده با ظرفیت پر');
    await expectNoPageOverflow(page);
  });

  test('capacity settings edits user capacity and working agreements', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/capacity`);

    await expect(page.getByTestId('capacity-settings-screen')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ظرفیت افراد' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'توافق کاری' })).toBeVisible();
    await expect(page.getByText('سارا بازبین ارشد با نام طولانی')).toBeVisible();
    await expect(page.getByText('پیش‌فرض')).toBeVisible();

    const overloadedRow = page
      .getByTestId('capacity-user-row')
      .filter({ hasText: 'امیر توسعه‌دهنده با ظرفیت پر' });
    await overloadedRow.getByLabel('ظرفیت روزانه').fill('7');
    await overloadedRow.getByRole('button', { name: /ذخیره ظرفیت/ }).click();
    await expect(page.getByText('ظرفیت ذخیره شد.')).toBeVisible();

    await page.getByLabel('SLA بازبینی (ساعت)').fill('36');
    await page.getByRole('button', { name: /ذخیره توافق/ }).click();
    await expect(page.getByText('توافق کاری ذخیره شد.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('manager decision, people, and capacity screens own vertical scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await setupManagerPage(page);

    await gotoApp(page, `/${workspaceSlug}/queues`);
    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expectScreenCanVerticallyScroll(page, 'decision-queues-screen');

    await gotoApp(page, `/${workspaceSlug}/people?person=${users.overloaded.id}`);
    await expect(page.getByTestId('people-workload-screen')).toBeVisible();
    await expectScreenCanVerticallyScroll(page, 'people-workload-screen');

    await gotoApp(page, `/${workspaceSlug}/capacity`);
    await expect(page.getByTestId('capacity-settings-screen')).toBeVisible();
    await expectScreenCanVerticallyScroll(page, 'capacity-settings-screen');
  });

  test('cockpit renders one manager queue while supporting diagnostics remain available', async ({ page }) => {
    const requestedPaths: string[] = [];
    await setupManagerPage(page, { requestedPaths });
    await gotoApp(page, `/${workspaceSlug}/cockpit`);
    await expect(page.getByTestId('manager-cockpit-screen')).toBeVisible();
    await expect(page.getByText('اقدام بعدی')).toBeVisible();
    await expect(page.getByText('۲ مورد باز')).toBeVisible();
    await expect(page.getByText('مانع فوری پرداخت')).toBeVisible();
    await expect(page.getByRole('link', { name: 'تصمیم تریاژ' })).toHaveAttribute('href', `/${workspaceSlug}/queues`);
    await expect(page.getByRole('link', { name: 'تصمیم‌های امروز' })).toHaveCount(0);
    await expect(page.getByText('ظرفیت افراد')).toHaveCount(0);
    expect(requestedPaths).toContain('/attention');
    expect(requestedPaths).not.toContain('/work-health/summary');
    expect(requestedPaths).not.toContain('/check-ins/missing');
    expect(requestedPaths).not.toContain('/one-on-ones');
    await expectNoPageOverflow(page);

    await page.getByRole('region', { name: 'اقدام بعدی' }).getByRole('button', { name: 'حل شد' }).click();
    await expect(page.getByText('عقب‌افتاده')).toBeVisible();
    await expect(page.getByText('مسدود')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-menu')).toBeVisible();
    await expect(page.getByText('رفتن به میز مدیر')).toBeVisible();
    await expect(page.getByText('تصمیم‌های امروز')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await gotoApp(page, `/${workspaceSlug}/team-health`);
    await expect(page.getByTestId('team-health-screen')).toBeVisible();
    await expect(page.getByText('جریان و WIP')).toBeVisible();
    await expect(page.getByText('گلوگاه‌های قابل اقدام')).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/projects`);
    await expect(page.getByTestId('projects-screen')).toBeVisible();
    await expect(page.getByText('بازطراحی تجربه مدیریت تیم با عنوان بسیار طولانی')).toBeVisible();
    await expect(page.getByText('در ریسک').first()).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('cockpit never reports a clear queue when attention loading fails', async ({ page }) => {
    await setupManagerPage(page, { attentionFailure: true });
    await gotoApp(page, `/${workspaceSlug}/cockpit`);

    await expect(page.getByTestId('manager-cockpit-screen')).toBeVisible();
    await expect(page.getByText('Attention unavailable')).toBeVisible();
    await expect(page.getByText('صف توجه خالی است')).toHaveCount(0);
  });

  test('issue detail, inbox, and meetings routes render without horizontal overflow', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/issue/CORE-101`);
    await expect(page.getByTestId('issue-page')).toBeVisible();
    await expect(page.getByText('CORE-101').first()).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/inbox`);
    await expect(page.getByRole('heading', { name: 'اعلان‌ها' })).toBeVisible();
    await expect(page.getByText('اعلانی برای کارهای دنبال‌شده، واگذاری‌ها یا منشن‌های شما وجود ندارد.')).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/meetings`);
    await expect(page.getByRole('heading', { name: 'جلسه‌ها' })).toBeVisible();
    await expect(page.getByText('جلسه‌ای برای نمایش وجود ندارد.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('issue detail review request starts without a default reviewer', async ({ page }) => {
    await setupManagerPage(page);
    await gotoApp(page, `/${workspaceSlug}/issue/CORE-102`);

    await expect(page.getByTestId('issue-page')).toBeVisible();
    const reviewSection = page.locator('aside section').filter({ hasText: 'بازبینی' });
    await expect(reviewSection.getByRole('combobox', { name: 'بازبین' })).toContainText('بازبین');
    await expect(reviewSection.getByText(users.reviewer.name)).toHaveCount(0);
    await expect(reviewSection.getByRole('button', { name: 'درخواست بازبینی' })).toBeDisabled();
    await expectNoPageOverflow(page);
  });

  test('projects keep saved health update when Mattermost publish has no channel binding', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The publish action is hidden below the xl breakpoint.');
    await setupManagerPage(page);

    await gotoApp(page, `/${workspaceSlug}/projects`);
    await expect(page.getByTestId('projects-screen')).toBeVisible();
    await page.getByRole('button', { name: /انتشار در متراست/ }).click();

    await expect(page.getByText('برای این پروژه کانال متراست وصل نشده است؛ آپدیت ذخیره شد.')).toBeVisible();
    await expect(page.getByText('ریسک وابستگی خارجی هنوز بسته نشده و تصمیم مدیر لازم است.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('projects show Persian conflict copy when a queued health update is rejected', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The health update action is hidden below the sm breakpoint.');
    await setupManagerPage(page);

    await gotoApp(page, `/${workspaceSlug}/projects`);
    await expect(page.getByTestId('projects-screen')).toBeVisible();
    await page.getByRole('button', { name: /^آپدیت سلامت$/ }).click();
    await expect(page.getByRole('heading', { name: /آپدیت سلامت بازطراحی تجربه مدیریت تیم/ })).toBeVisible();

    await page.getByPlaceholder('خلاصه وضعیت فعلی پروژه...').fill('این آپدیت باید رد شود چون وضعیت پروژه روی سرور تغییر کرده است.');
    await page.getByRole('button', { name: 'ثبت آپدیت' }).click();

    await expect(page.getByText('ثبت آپدیت سلامت پروژه اعمال نشد، چون داده روی سرور تغییر کرده است. صفحه را به‌روزرسانی کنید و دوباره تصمیم بگیرید.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /آپدیت سلامت بازطراحی تجربه مدیریت تیم/ })).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('empty workspace renders operational empty states without overflow', async ({ page }) => {
    await setupManagerPage(page, { scenario: 'empty' });

    await gotoApp(page, `/${workspaceSlug}/queues`);
    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expect(page.getByText('بازبینی قابل پیگیری وجود ندارد.')).toBeVisible();
    await expect(page.getByText('ورودی تازه‌ای برای تریاژ نیست.')).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/people`);
    await expect(page.getByTestId('people-workload-screen')).toBeVisible();
    await expect(page.getByText('فردی برای نمایش وجود ندارد.')).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/projects`);
    await expect(page.getByTestId('projects-screen')).toBeVisible();
    await expect(page.getByText('هنوز پروژه‌ای ثبت نشده است.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('limited members only see scoped manager surfaces', async ({ page }) => {
    await setupManagerPage(page, { scenario: 'limited-member' });

    await gotoApp(page, `/${workspaceSlug}/queues`);
    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expect(page.getByText(longPersianTitle)).toBeVisible();
    await expect(page.getByText('رفع مانع پرداخت که مسیر انتشار را نگه داشته است')).toBeHidden();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/reviews`);
    await expect(page.getByTestId('reviews-screen')).toBeVisible();
    await expect(page.getByText(longPersianTitle)).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('member navigation keeps personal work as the default entry', async ({ page }, testInfo) => {
    await setupManagerPage(page, { scenario: 'limited-member' });
    await gotoApp(page, `/${workspaceSlug}/team/all/all`);

    if (!testInfo.project.name.includes('mobile')) {
      await expect(page.getByRole('link', { name: 'کارهای من' })).toHaveCount(1);
      await expect(page.getByRole('link', { name: 'میز مدیر' })).toHaveCount(0);
    }
    await page.keyboard.press('Control+k');
    await expect(page.getByText('رفتن به کارها')).toBeVisible();
    await expect(page.getByText('رفتن به میز مدیر')).toHaveCount(0);
  });

  test('workspace admins with no team membership still see manager queues', async ({ page }) => {
    await setupManagerPage(page, { scenario: 'admin-no-teams' });

    await gotoApp(page, `/${workspaceSlug}/queues`);
    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expect(page.getByText(longPersianTitle)).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/capacity`);
    await expect(page.getByTestId('capacity-settings-screen')).toBeVisible();
    await expect(page.getByText('کل فضای کاری')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('project lead outside the team remains visible in project health', async ({ page }) => {
    await setupManagerPage(page, { scenario: 'project-lead-outside-team' });

    await gotoApp(page, `/${workspaceSlug}/team-health`);
    await expect(page.getByTestId('team-health-screen')).toBeVisible();
    await expect(page.getByText('لید: نگار راهبر پروژه خارج از تیم')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('large workspaces show capped-result copy and stay within the viewport', async ({ page }) => {
    await setupManagerPage(page, { scenario: 'large' });

    await gotoApp(page, `/${workspaceSlug}/queues`);
    await expect(page.getByTestId('decision-queues-screen')).toBeVisible();
    await expect(page.getByText('داده‌ها محدود شده‌اند؛ صف‌ها بر اساس اولویت کوتاه شده‌اند.')).toBeVisible();
    await expect(page.getByText('کار حجیم شماره ۵۰۰')).toBeVisible();
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${workspaceSlug}/people`);
    await expect(page.getByTestId('people-workload-screen')).toBeVisible();
    await expect(page.getByText('فضای کاری بزرگ است؛ داده‌های افراد و کارها محدود شده‌اند.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('projects keep saved health update when Mattermost config is missing', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The publish action is hidden below the xl breakpoint.');
    await setupManagerPage(page, { scenario: 'mattermost-missing-config' });

    await gotoApp(page, `/${workspaceSlug}/projects`);
    await expect(page.getByTestId('projects-screen')).toBeVisible();
    await page.getByRole('button', { name: /انتشار در متراست/ }).click();

    await expect(page.getByText('تنظیمات بات متراست کامل نیست؛ آپدیت ذخیره شد.')).toBeVisible();
    await expect(page.getByText('ریسک وابستگی خارجی هنوز بسته نشده و تصمیم مدیر لازم است.')).toBeVisible();
    await expectNoPageOverflow(page);
  });
});

type ManagerFixtureScenario =
  | 'default'
  | 'empty'
  | 'limited-member'
  | 'admin-no-teams'
  | 'project-lead-outside-team'
  | 'large'
  | 'mattermost-missing-config';

type MockTaskaraOptions = {
  attentionFailure?: boolean;
  scenario?: ManagerFixtureScenario;
  requestedPaths?: string[];
};

async function gotoApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

async function setupManagerPage(page: Page, options: MockTaskaraOptions = {}) {
  await seedAuth(page, options);
  await mockTaskaraApi(page, options);
}

async function seedAuth(page: Page, options: MockTaskaraOptions = {}) {
  const sessionUser = options.scenario === 'limited-member' ? users.reviewer : users.admin;
  const sessionRole = options.scenario === 'limited-member' ? 'MEMBER' : 'ADMIN';

  await page.addInitScript(
    ({ session }) => {
      window.localStorage.setItem('taskara.auth.session.v1', JSON.stringify(session));
    },
    {
      session: {
        token: 'e2e-token',
        expiresAt: '2027-01-01T00:00:00.000Z',
        role: sessionRole,
        workspace,
        user: sessionUser,
      },
    }
  );
}

async function mockTaskaraApi(page: Page, options: MockTaskaraOptions = {}) {
  const fixture = fixtureForScenario(options.scenario || 'default');
  const triagedBacklogTaskIds = new Set<string>();
  const resolvedAttentionIds = new Set<string>();

  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const query = url.searchParams;
    options.requestedPaths?.push(path);

    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (path === '/sync/stream') return route.fulfill({ status: 204 });
    if (path === '/sync/bootstrap') {
      return json(route, {
        cursor: '15',
        serverTime: now,
        completedWindowDays: 5,
        omittedCompletedBefore: '2026-07-01T00:00:00.000Z',
        tasks: fixture.tasks,
        totalHotTasks: fixture.tasks.length,
        projects: fixture.projects,
        teams: fixture.teams,
        users: fixture.users,
        views: [],
      });
    }
    if (path === '/sync/pull') return json(route, { cursor: query.get('cursor') || '15', events: [], hasMore: false });
    if (request.method() === 'POST' && path === '/sync/push') {
      const body = request.postDataJSON() as {
        mutations?: Array<{
          args?: { id?: string; projectId?: string; update?: Partial<(typeof projects)[number]['healthUpdates'][number]> };
          mutationId: string;
          name: string;
        }>;
      };
      return json(route, {
        cursor: '16',
        results: (body.mutations || []).map((mutation) => {
          if (mutation.name === 'attention.resolve' && mutation.args?.id) {
            resolvedAttentionIds.add(mutation.args.id);
          }
          const summary = mutation.args?.update?.summary || '';
          if (mutation.name === 'project_health_update.create' && summary.includes('رد شود')) {
            return {
              mutationId: mutation.mutationId,
              status: 'conflict',
              error: {
                code: 'mutation_conflict',
                message: 'Project health update conflicted with a newer server value.',
                retryable: false,
              },
            };
          }

          return {
            mutationId: mutation.mutationId,
            status: 'applied',
            workspaceSeq: '16',
            entity:
              mutation.name === 'project_health_update.create'
                ? {
                    id: `health-${mutation.mutationId}`,
                    workspaceId: workspace.id,
                    projectId: mutation.args?.projectId || fixture.projects[0]?.id,
                    authorId: fixture.sessionUser.id,
                    health: mutation.args?.update?.health || 'ON_TRACK',
                    summary,
                    progress: mutation.args?.update?.progress || null,
                    risks: mutation.args?.update?.risks || null,
                    decisionsNeeded: mutation.args?.update?.decisionsNeeded || null,
                    nextUpdateDueAt: mutation.args?.update?.nextUpdateDueAt || null,
                    publishedAt: null,
                    createdAt: now,
                    updatedAt: now,
                    author: fixture.sessionUser,
                  }
                : null,
          };
        }),
      });
    }
    if (path === '/me') return json(route, { workspace, user: fixture.sessionUser, role: fixture.sessionRole, unreadNotifications: 3 });
    if (path === '/workspaces') {
      return json(route, {
        items: [{ membershipId: `membership-${fixture.sessionUser.id}`, role: fixture.sessionRole, joinedAt: now, workspace }],
        total: 1,
      });
    }
    if (path === '/teams') return json(route, fixture.teams);
    if (path === '/users') return json(route, { items: fixture.users, total: fixture.users.length, limit: 200, offset: 0 });
    if (path === '/projects') return json(route, fixture.projects);
    if (path === '/knowledge/spaces') return json(route, []);
    if (path === '/knowledge/references') return json(route, []);
    if (path === '/knowledge/pages') return json(route, pageResult([]));
    if (path === '/notifications') {
      const limit = Number(query.get('limit') || 100);
      return json(route, { ...pageResult([], limit), unreadCount: 3 });
    }
    if (path === '/notifications/sync') return json(route, { cursor: query.get('cursor') || '0', notifications: [], unreadCount: 3 });
    if (path === '/announcements') return json(route, { ...pageResult([], Number(query.get('limit') || 1)), unreadCount: 0 });
    if (path === '/meetings') return json(route, pageResult([], Number(query.get('limit') || 1)));
    if (path === '/tasks') {
      const mine = query.get('mine') === 'true';
      const filtered = mine ? fixture.tasks.filter((task) => task.assignee?.id === fixture.sessionUser.id) : fixture.tasks;
      return json(route, pageResult(filtered, Number(query.get('limit') || filtered.length)));
    }
    if (request.method() === 'GET' && path.match(/^\/tasks\/[^/]+$/)) {
      const key = decodeURIComponent(path.split('/').at(-1) || '');
      return json(route, fixture.tasks.find((task) => task.key === key || task.id === key) || fixture.tasks[0] || null);
    }
    if (request.method() === 'GET' && path.match(/^\/tasks\/[^/]+\/activity$/)) return json(route, []);
    if (request.method() === 'GET' && path.match(/^\/tasks\/[^/]+\/reviews$/)) {
      const key = decodeURIComponent(path.split('/').at(-2) || '');
      const task = fixture.tasks.find((item) => item.key === key || item.id === key);
      return json(route, fixture.reviews.filter((review) => !task || review.taskId === task.id));
    }
    if (path === '/reviews/mine') {
      const requestedOnly = query.get('status') === 'REQUESTED';
      const filtered = requestedOnly ? fixture.reviews.filter((review) => review.status === 'REQUESTED') : fixture.reviews;
      return json(route, pageResult(filtered, Number(query.get('limit') || filtered.length)));
    }
    if (request.method() === 'POST' && path.match(/^\/reviews\/[^/]+\/(approve|request-changes|cancel)$/)) {
      const action = path.split('/').at(-1);
      return json(route, {
        ...fixture.reviews[0],
        status: action === 'approve' ? 'APPROVED' : action === 'request-changes' ? 'CHANGES_REQUESTED' : 'CANCELED',
        respondedAt: now,
        updatedAt: now,
      });
    }
    if (request.method() === 'POST' && path.match(/^\/triage\/tasks\/[^/]+\/(accept|request-info|decline|duplicate|split|snooze)$/)) {
      const action = path.split('/').at(-1);
      const key = decodeURIComponent(path.split('/').at(-2) || '');
      const task = fixture.tasks.find((item) => item.key === key || item.id === key) || fixture.tasks[1] || tasks[1];
      const body = request.postDataJSON() as Partial<typeof task> & {
        assigneeId?: string | null;
        canonicalTaskIdOrKey?: string;
        items?: Array<{ title?: string; description?: string | null }>;
        priority?: string;
        reason?: string;
        snoozedUntil?: string;
      };
      if (action !== 'request-info') {
        triagedBacklogTaskIds.add(task.id);
      }
      if (action === 'split') {
        return json(route, {
          task: {
            ...task,
            status: 'CANCELED',
            updatedAt: now,
          },
          items: (body.items || []).map((item, index) => ({
            ...taskBase,
            id: `task-backlog-split-${index + 1}`,
            key: `CORE-${201 + index}`,
            parentId: task.id,
            title: item.title || `کار تقسیم‌شده ${index + 1}`,
            description: item.description || null,
            status: 'BACKLOG',
            priority: 'NO_PRIORITY',
            weight: null,
            dueAt: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            progressStartedAt: null,
            assignee: null,
            triageState: null,
          })),
        });
      }
      return json(route, {
        ...task,
        status: action === 'accept' ? 'TODO' : action === 'request-info' || action === 'snooze' ? task.status : 'CANCELED',
        priority: body.priority || task.priority,
        assignee: body.assigneeId ? fixture.users.find((item) => item.id === body.assigneeId) || task.assignee : task.assignee,
        triageState:
          action === 'request-info'
            ? {
                id: 'triage-waiting',
                status: 'WAITING_FOR_INFO',
                requestedInfo: 'اطلاعات بیشتر لازم است.',
                snoozedUntil: null,
                reason: null,
                decidedById: fixture.sessionUser.id,
                createdAt: now,
                updatedAt: now,
              }
            : action === 'snooze'
              ? {
                  id: 'triage-snoozed',
                  status: 'SNOOZED',
                  requestedInfo: null,
                  snoozedUntil: body.snoozedUntil || '2026-07-07T09:00:00.000Z',
                  reason: body.reason || null,
                  decidedById: fixture.sessionUser.id,
                  createdAt: now,
                  updatedAt: now,
                }
              : null,
        updatedAt: now,
      });
    }
    if (path === '/work-health/summary') {
      const backlog = fixture.workHealthSummary.queues.backlog.filter((task) => !triagedBacklogTaskIds.has(task.id));
      return json(route, {
        ...fixture.workHealthSummary,
        overview: {
          ...fixture.workHealthSummary.overview,
          backlogTasks: backlog.length,
          statusCounts: {
            ...fixture.workHealthSummary.overview.statusCounts,
            BACKLOG: backlog.length,
          },
        },
        queues: {
          ...fixture.workHealthSummary.queues,
          backlog,
        },
      });
    }
    if (path === '/attention') {
      if (options.attentionFailure) {
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Attention unavailable' }),
        });
      }
      const items = fixture.attentionResponse.items.filter((item) => !resolvedAttentionIds.has(item.id));
      return json(route, { ...fixture.attentionResponse, items, total: items.length });
    }
    if (path === '/check-ins/missing') return json(route, fixture.missingCheckIns);
    if (path === '/one-on-ones') return json(route, { items: fixture.oneOnOnes, total: fixture.oneOnOnes.length, limit: 50, offset: 0 });
    if (path === '/capacity/users') return json(route, { items: fixture.capacityUsers, total: fixture.capacityUsers.length });
    if (request.method() === 'PUT' && path.match(/^\/capacity\/users\/[^/]+$/)) {
      const userId = decodeURIComponent(path.split('/').at(-1) || '');
      const body = request.postDataJSON() as Partial<(typeof capacityUsers)[number]['capacity']>;
      return json(route, {
        id: `capacity-${userId}`,
        workspaceId: workspace.id,
        userId,
        dailyWeightLimit: body.dailyWeightLimit ?? 8,
        weeklyWeightLimit: body.weeklyWeightLimit ?? null,
        active: body.active ?? true,
        note: body.note ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (request.method() === 'GET' && path === '/capacity/agreements') return json(route, { items: fixture.workingAgreements, total: fixture.workingAgreements.length });
    if (request.method() === 'POST' && path === '/capacity/agreements') {
      const body = request.postDataJSON() as Partial<(typeof workingAgreements)[number]>;
      const team = body.teamId ? fixture.teams.find((item) => item.id === body.teamId) || null : null;
      return json(route, {
        id: body.teamId ? `agreement-${body.teamId}` : 'agreement-workspace',
        workspaceId: workspace.id,
        teamId: body.teamId ?? null,
        scopeKey: body.teamId ? `team:${body.teamId}` : 'workspace',
        activeWipLimit: body.activeWipLimit ?? null,
        reviewWipLimit: body.reviewWipLimit ?? null,
        reviewSlaHours: body.reviewSlaHours ?? 24,
        blockedSlaHours: body.blockedSlaHours ?? 24,
        staleAfterHours: body.staleAfterHours ?? 72,
        createdAt: now,
        updatedAt: now,
        team,
      });
    }
    if (path.match(/^\/projects\/[^/]+\/updates\/[^/]+\/publish-mattermost$/)) {
      return json(route, { update: fixture.projects[0]?.healthUpdates?.[0], published: false, reason: fixture.mattermostReason });
    }

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

function fixtureForScenario(scenario: ManagerFixtureScenario) {
  const base = {
    sessionUser: scenario === 'limited-member' ? users.reviewer : users.admin,
    sessionRole: scenario === 'limited-member' ? 'MEMBER' : 'ADMIN',
    tasks: clone(tasks),
    projects: clone(projects),
    teams: clone(teams),
    users: clone(taskaraUsers),
    reviews: clone(reviews),
    workHealthSummary: clone(workHealthSummary),
    attentionResponse: clone(attentionResponse),
    missingCheckIns: clone(missingCheckIns),
    oneOnOnes: clone(oneOnOnes),
    capacityUsers: clone(capacityUsers),
    workingAgreements: clone(workingAgreements),
    mattermostReason: scenario === 'mattermost-missing-config' ? 'missing_config' : 'missing_binding',
  };

  if (scenario === 'empty') {
    return {
      ...base,
      tasks: [],
      projects: [],
      teams: [],
      users: [clone(taskaraUsers[0])],
      reviews: [],
      workHealthSummary: emptyWorkHealthSummary(),
      attentionResponse: { ...clone(attentionResponse), items: [], total: 0 },
      missingCheckIns: { ...clone(missingCheckIns), items: [], total: 0 },
      oneOnOnes: [],
      capacityUsers: [],
      workingAgreements: [clone(workingAgreements[0])],
    };
  }

  if (scenario === 'limited-member') {
    const reviewTask = { ...clone(tasks[0]), assignee: users.reviewer };
    const staleTask = clone(tasks[4]);
    const reviewerPerson = {
      ...clone(people[1]),
      activeCount: 2,
      activeWeight: 6,
      reviewCount: 1,
      blockedCount: 0,
      overdueCount: 0,
      staleCount: 1,
      tasks: [reviewTask, staleTask],
    };

    return {
      ...base,
      tasks: [reviewTask, staleTask],
      users: [clone(taskaraUsers[1])],
      reviews: [reviewFor(users.reviewer, reviewTask)],
      workHealthSummary: {
        ...emptyWorkHealthSummary(),
        overview: {
          ...emptyWorkHealthSummary().overview,
          activeTasks: 2,
          loadedActiveTasks: 2,
          reviewTasks: 1,
          staleTasks: 1,
          statusCounts: { BACKLOG: 0, TODO: 0, IN_PROGRESS: 1, IN_REVIEW: 1, BLOCKED: 0, DONE: 0, CANCELED: 0 },
        },
        people: [reviewerPerson],
        queues: {
          overdue: [],
          blocked: [],
          review: [reviewTask],
          stale: [staleTask],
          unassigned: [],
          backlog: [],
        },
        projects: [
          {
            ...clone(workHealthSummary.projects[0]),
            activeCount: 2,
            activeWeight: 6,
            blockedCount: 0,
            overdueCount: 0,
            reviewCount: 1,
            staleCount: 1,
            unassignedCount: 0,
          },
        ],
      },
      attentionResponse: { ...clone(attentionResponse), items: [], total: 0 },
      missingCheckIns: { ...clone(missingCheckIns), items: [], total: 0 },
      oneOnOnes: [],
      capacityUsers: [clone(capacityUsers[1])],
    };
  }

  if (scenario === 'admin-no-teams') {
    return {
      ...base,
      teams: [],
      workingAgreements: [clone(workingAgreements[0])],
    };
  }

  if (scenario === 'project-lead-outside-team') {
    const leadProject = { ...clone(projects[0]), lead: users.outsideLead };
    return {
      ...base,
      projects: [leadProject],
      users: [...clone(taskaraUsers), outsideLeadMembership],
      workHealthSummary: {
        ...base.workHealthSummary,
        projects: [{ ...base.workHealthSummary.projects[0], project: leadProject }],
      },
    };
  }

  if (scenario === 'large') {
    const largeTasks = Array.from({ length: 500 }, (_, index) => largeTask(index + 1));
    const largePeople = Array.from({ length: 30 }, (_, index) => largePerson(index + 1, largeTasks));
    return {
      ...base,
      tasks: largeTasks,
      workHealthSummary: {
        ...base.workHealthSummary,
        generatedAt: now,
        overview: {
          activeTasks: 500,
          loadedActiveTasks: 500,
          truncated: true,
          overdueTasks: 84,
          blockedTasks: 44,
          reviewTasks: 120,
          staleTasks: 95,
          unassignedActiveTasks: 52,
          backlogTasks: 100,
          statusCounts: { BACKLOG: 100, TODO: 150, IN_PROGRESS: 130, IN_REVIEW: 80, BLOCKED: 40, DONE: 0, CANCELED: 0 },
          overloadedPeople: 18,
          peopleWithoutActiveWork: 7,
        },
        people: largePeople,
        queues: {
          overdue: largeTasks.slice(0, 24),
          blocked: largeTasks.slice(24, 48),
          review: [largeTasks[499], ...largeTasks.slice(48, 71)],
          stale: largeTasks.slice(72, 96),
          unassigned: largeTasks.slice(96, 120).map((task) => ({ ...task, assignee: null })),
          backlog: largeTasks.slice(120, 144).map((task) => ({ ...task, status: 'BACKLOG', priority: 'NO_PRIORITY', assignee: null })),
        },
        projects: [
          {
            ...base.workHealthSummary.projects[0],
            activeCount: 500,
            activeWeight: 1200,
            blockedCount: 44,
            overdueCount: 84,
            reviewCount: 120,
            staleCount: 95,
            unassignedCount: 52,
            health: 'at_risk',
          },
        ],
      },
      attentionResponse: {
        ...base.attentionResponse,
        items: base.attentionResponse.items,
        total: 100,
      },
    };
  }

  return base;
}

function emptyWorkHealthSummary() {
  return {
    ...clone(workHealthSummary),
    overview: {
      activeTasks: 0,
      loadedActiveTasks: 0,
      truncated: false,
      overdueTasks: 0,
      blockedTasks: 0,
      reviewTasks: 0,
      staleTasks: 0,
      unassignedActiveTasks: 0,
      backlogTasks: 0,
      statusCounts: { BACKLOG: 0, TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, BLOCKED: 0, DONE: 0, CANCELED: 0 },
      overloadedPeople: 0,
      peopleWithoutActiveWork: 0,
    },
    attention: [],
    people: [],
    queues: {
      overdue: [],
      blocked: [],
      review: [],
      stale: [],
      unassigned: [],
      backlog: [],
    },
    projects: [],
  };
}

function reviewFor(reviewer: typeof users.admin, task: (typeof tasks)[number]) {
  return {
    ...clone(reviews[0]),
    reviewerId: reviewer.id,
    reviewer,
    taskId: task.id,
    task,
  };
}

function largeTask(index: number) {
  const assignedUser = index % 5 === 0 ? users.overloaded : index % 3 === 0 ? users.reviewer : users.admin;
  return {
    ...taskBase,
    id: `task-large-${index}`,
    key: `CORE-${1000 + index}`,
    title: `کار حجیم شماره ${index.toLocaleString('fa-IR')}`,
    status: index % 11 === 0 ? 'BLOCKED' : index % 7 === 0 ? 'IN_REVIEW' : index % 5 === 0 ? 'IN_PROGRESS' : 'TODO',
    priority: index % 13 === 0 ? 'URGENT' : index % 4 === 0 ? 'HIGH' : 'MEDIUM',
    weight: index % 5 === 0 ? 8 : index % 3 === 0 ? 4 : 2,
    dueAt: index % 6 === 0 ? '2026-07-05T10:00:00.000Z' : '2026-07-08T10:00:00.000Z',
    createdAt: '2026-07-01T09:00:00.000Z',
    updatedAt: '2026-07-06T07:00:00.000Z',
    completedAt: null,
    progressStartedAt: index % 5 === 0 ? '2026-07-02T09:00:00.000Z' : null,
    assignee: assignedUser,
  };
}

function largePerson(index: number, largeTasks: Array<ReturnType<typeof largeTask>>) {
  const source = index % 3 === 0 ? users.reviewer : index % 2 === 0 ? users.overloaded : users.admin;
  const user = {
    ...source,
    id: `large-user-${index}`,
    name: `عضو فضای کاری بزرگ شماره ${index}`,
    email: `large-user-${index}@example.com`,
  };
  const activeWeight = index % 2 === 0 ? 16 : 6;
  return {
    user,
    activeCount: index % 2 === 0 ? 8 : 3,
    activeWeight,
    todayWeight: index % 2 === 0 ? 10 : 2,
    reviewCount: index % 4,
    blockedCount: index % 5 === 0 ? 2 : 0,
    overdueCount: index % 6 === 0 ? 2 : 0,
    staleCount: index % 7 === 0 ? 1 : 0,
    capacity: 8,
    capacityActive: true,
    loadRatio: activeWeight / 8,
    status: activeWeight > 8 ? 'overloaded' : 'balanced',
    tasks: largeTasks.slice(index, index + 3),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
        })),
      { message: 'page should not create horizontal overflow' }
    )
    .toMatchObject({
      scrollWidth: await page.evaluate(() => document.documentElement.clientWidth),
    });

  const overflowing = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        if (element.closest('[data-sonner-toaster], .toaster')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -2 || rect.right > viewport + 2);
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className.toString().slice(0, 160),
        text: element.textContent?.trim().slice(0, 80),
      }));
  });
  expect(overflowing).toEqual([]);
}

async function expectScreenCanVerticallyScroll(page: Page, testId: string) {
  const state = await page.getByTestId(testId).evaluate((element) => {
    const screen = element as HTMLElement;
    screen.scrollTop = 0;
    screen.scrollTop = screen.scrollHeight;

    return {
      clientHeight: screen.clientHeight,
      overflowY: getComputedStyle(screen).overflowY,
      scrollHeight: screen.scrollHeight,
      scrollTop: screen.scrollTop,
    };
  });

  expect(state.overflowY).toMatch(/auto|scroll/);
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight + 8);
  expect(state.scrollTop).toBeGreaterThan(0);
}

async function expectDecisionRowBadgesBelowTitle(page: Page, title: string) {
  const row = page.getByTestId('decision-task-row').filter({ hasText: title }).first();
  const titleBox = await row.getByRole('link', { name: new RegExp(title) }).boundingBox();
  const badgeBox = await row.getByText('بی‌مسئول').boundingBox();

  expect(titleBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(badgeBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 2);
}

async function expectIssueTitleTooltip(page: Page, title: string) {
  await page.getByRole('link', { name: new RegExp(escapeRegExp(title)) }).first().hover();
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: title })).toBeVisible();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const workspace = {
  id: 'workspace-1',
  name: 'دستک عملیات محصول',
  slug: workspaceSlug,
  description: 'فضای کاری تست مدیریت تیم',
};

const users = {
  admin: {
    id: 'user-admin',
    name: 'مدیر عملیات با نام بسیار طولانی برای تست چینش',
    email: 'manager.very.long.email.address@example.com',
    phone: '+989121111111',
    mattermostUsername: 'manager',
    avatarUrl: null,
  },
  reviewer: {
    id: 'user-reviewer',
    name: 'سارا بازبین ارشد با نام طولانی',
    email: 'sara.reviewer@example.com',
    phone: '+989122222222',
    mattermostUsername: 'sara',
    avatarUrl: null,
  },
  overloaded: {
    id: 'user-overloaded',
    name: 'امیر توسعه‌دهنده با ظرفیت پر',
    email: 'amir.capacity@example.com',
    phone: '+989123333333',
    mattermostUsername: 'amir',
    avatarUrl: null,
  },
  outsideLead: {
    id: 'user-outside-lead',
    name: 'نگار راهبر پروژه خارج از تیم',
    email: 'negar.lead@example.com',
    phone: '+989124444444',
    mattermostUsername: 'negar',
    avatarUrl: null,
  },
};

const teams = [
  { id: 'team-core', name: 'تیم هسته محصول', slug: 'core', description: null, _count: { members: 4, projects: 2 } },
];

const taskaraUsers = [
  { membershipId: 'membership-admin', role: 'ADMIN', joinedAt: now, _count: { assignedTasks: 1, reportedTasks: 2, comments: 0 }, ...users.admin },
  { membershipId: 'membership-reviewer', role: 'MEMBER', joinedAt: now, _count: { assignedTasks: 2, reportedTasks: 0, comments: 0 }, ...users.reviewer },
  { membershipId: 'membership-overloaded', role: 'MEMBER', joinedAt: now, _count: { assignedTasks: 5, reportedTasks: 0, comments: 0 }, ...users.overloaded },
];

const outsideLeadMembership = {
  membershipId: 'membership-outside-lead',
  role: 'MEMBER',
  joinedAt: now,
  _count: { assignedTasks: 0, reportedTasks: 0, comments: 0 },
  ...users.outsideLead,
};

const longPersianTitle =
  'بازبینی نهایی جریان واگذاری کارهای پیچیده با عنوان بسیار طولانی برای اطمینان از عدم شکست چینش در موبایل و دسکتاپ';

const projects = [
  {
    id: 'project-core',
    name: 'بازطراحی تجربه مدیریت تیم با عنوان بسیار طولانی',
    keyPrefix: 'CORE',
    description: 'پروژه‌ای برای تست ریسک و آپدیت سلامت',
    status: 'ACTIVE',
    parentId: null,
    team: teams[0],
    lead: users.admin,
    _count: { tasks: 8, subprojects: 0 },
    healthUpdates: [
      {
        id: 'health-1',
        workspaceId: workspace.id,
        projectId: 'project-core',
        authorId: users.admin.id,
        health: 'AT_RISK',
        summary: 'ریسک وابستگی خارجی هنوز بسته نشده و تصمیم مدیر لازم است.',
        progress: 'صف‌های تصمیم و سلامت تیم متصل شده‌اند.',
        risks: 'وابستگی Mattermost و چند کار مسدود.',
        decisionsNeeded: 'اولویت‌دهی ظرفیت تیم هسته.',
        nextUpdateDueAt: '2026-07-08T08:00:00.000Z',
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
        author: users.admin,
      },
    ],
  },
];

const taskBase = {
  description: null,
  project: { id: 'project-core', name: projects[0].name, keyPrefix: 'CORE', team: teams[0] },
  reporter: users.admin,
  version: 1,
  syncState: undefined,
  syncMutationId: undefined,
  labels: [],
  _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
};

const tasks = [
  {
    ...taskBase,
    id: 'task-review',
    key: 'CORE-101',
    title: longPersianTitle,
    status: 'IN_REVIEW',
    priority: 'URGENT',
    weight: 4,
    dueAt: '2026-07-06T18:00:00.000Z',
    createdAt: '2026-07-04T09:00:00.000Z',
    updatedAt: '2026-07-06T07:00:00.000Z',
    completedAt: null,
    progressStartedAt: '2026-07-04T10:00:00.000Z',
    assignee: users.overloaded,
    activeReviewRequest: {
      id: 'review-1',
      reviewerId: users.reviewer.id,
      requestedAt: '2026-07-05T08:00:00.000Z',
      dueAt: '2026-07-06T08:00:00.000Z',
    },
  },
  {
    ...taskBase,
    id: 'task-backlog',
    key: 'CORE-102',
    title: 'درخواست ورودی از مترموست که هنوز اولویت و مالک ندارد',
    status: 'BACKLOG',
    priority: 'NO_PRIORITY',
    weight: null,
    dueAt: null,
    createdAt: '2026-07-06T06:00:00.000Z',
    updatedAt: '2026-07-06T06:00:00.000Z',
    completedAt: null,
    progressStartedAt: null,
    assignee: null,
  },
  {
    ...taskBase,
    id: 'task-unassigned',
    key: 'CORE-103',
    title: 'کار نزدیک به موعد که هنوز مسئول ندارد',
    status: 'TODO',
    priority: 'HIGH',
    weight: 3,
    dueAt: '2026-07-07T10:00:00.000Z',
    createdAt: '2026-07-05T10:00:00.000Z',
    updatedAt: '2026-07-05T10:00:00.000Z',
    completedAt: null,
    progressStartedAt: null,
    assignee: null,
  },
  {
    ...taskBase,
    id: 'task-blocked',
    key: 'CORE-104',
    title: 'رفع مانع پرداخت که مسیر انتشار را نگه داشته است',
    status: 'BLOCKED',
    priority: 'URGENT',
    weight: 8,
    dueAt: '2026-07-05T10:00:00.000Z',
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-04T10:00:00.000Z',
    completedAt: null,
    progressStartedAt: '2026-07-03T10:00:00.000Z',
    assignee: users.overloaded,
  },
  {
    ...taskBase,
    id: 'task-stale',
    key: 'CORE-105',
    title: 'بازنگری مستندات پروژه که سه روز بدون حرکت مانده است',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    weight: 2,
    dueAt: null,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-02T10:00:00.000Z',
    completedAt: null,
    progressStartedAt: '2026-07-01T11:00:00.000Z',
    assignee: users.reviewer,
  },
];

const reviews = [
  {
    id: 'review-1',
    workspaceId: workspace.id,
    taskId: 'task-review',
    requesterId: users.admin.id,
    reviewerId: users.admin.id,
    status: 'REQUESTED',
    requestedAt: '2026-07-05T08:00:00.000Z',
    respondedAt: null,
    dueAt: '2026-07-06T08:00:00.000Z',
    comment: 'لطفا قبل از انتشار مسیر واگذاری را تایید کن.',
    createdAt: '2026-07-05T08:00:00.000Z',
    updatedAt: '2026-07-05T08:00:00.000Z',
    requester: users.admin,
    reviewer: users.admin,
    task: tasks[0],
  },
];

const people = [
  {
    user: users.admin,
    activeCount: 1,
    activeWeight: 2,
    todayWeight: 2,
    reviewCount: 0,
    blockedCount: 0,
    overdueCount: 0,
    staleCount: 0,
    capacity: 8,
    capacityActive: true,
    loadRatio: 0.25,
    status: 'balanced',
    tasks: [tasks[2]],
  },
  {
    user: users.reviewer,
    activeCount: 2,
    activeWeight: 4,
    todayWeight: 2,
    reviewCount: 1,
    blockedCount: 0,
    overdueCount: 0,
    staleCount: 1,
    capacity: 8,
    capacityActive: true,
    loadRatio: 0.5,
    status: 'busy',
    tasks: [tasks[0], tasks[4]],
  },
  {
    user: users.overloaded,
    activeCount: 4,
    activeWeight: 14,
    todayWeight: 8,
    reviewCount: 1,
    blockedCount: 1,
    overdueCount: 1,
    staleCount: 0,
    capacity: 8,
    capacityActive: true,
    loadRatio: 1.75,
    status: 'overloaded',
    tasks: [tasks[0], tasks[3]],
  },
];

const workHealthSummary = {
  generatedAt: now,
  scope: { workspaceWide: true, teamIds: [], projectIds: [] },
  thresholds: { dailyWeightLimit: 8, staleAfterHours: 72, blockedSlaHours: 24, reviewSlaHours: 24, dueSoonHours: 48 },
  overview: {
    activeTasks: 4,
    loadedActiveTasks: 4,
    truncated: false,
    overdueTasks: 1,
    blockedTasks: 1,
    reviewTasks: 1,
    staleTasks: 1,
    unassignedActiveTasks: 1,
    backlogTasks: 1,
    statusCounts: { BACKLOG: 1, TODO: 1, IN_PROGRESS: 1, IN_REVIEW: 1, BLOCKED: 1, DONE: 0, CANCELED: 0 },
    overloadedPeople: 1,
    peopleWithoutActiveWork: 0,
  },
  attention: [],
  people,
  queues: {
    overdue: [tasks[3]],
    blocked: [tasks[3]],
    review: [tasks[0]],
    stale: [tasks[4]],
    unassigned: [tasks[2]],
    backlog: [tasks[1]],
  },
  projects: [
    {
      project: projects[0],
      activeCount: 5,
      activeWeight: 17,
      blockedCount: 1,
      overdueCount: 1,
      reviewCount: 1,
      staleCount: 1,
      unassignedCount: 1,
      health: 'at_risk',
    },
  ],
};

const attentionResponse = {
  items: [
    {
      id: 'attention-1',
      workspaceId: workspace.id,
      assigneeId: users.overloaded.id,
      managerId: users.admin.id,
      entityType: 'task',
      entityId: 'task-blocked',
      reason: 'blocked_task',
      severity: 'URGENT',
      status: 'OPEN',
      firstSeenAt: '2026-07-05T09:00:00.000Z',
      lastSeenAt: now,
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {
        title: 'مانع فوری پرداخت',
        description: 'کار بیش از ۲۴ ساعت در وضعیت مسدود مانده است.',
        actionLabel: 'رفع مانع',
        task: {
          id: 'task-blocked',
          key: 'CORE-104',
          title: tasks[3].title,
          status: 'BLOCKED',
          priority: 'URGENT',
          dueAt: tasks[3].dueAt,
          assigneeId: users.overloaded.id,
          projectId: 'project-core',
          projectName: projects[0].name,
        },
      },
      createdAt: '2026-07-05T09:00:00.000Z',
      updatedAt: now,
    },
    {
      id: 'attention-2',
      workspaceId: workspace.id,
      assigneeId: users.overloaded.id,
      managerId: users.admin.id,
      entityType: 'task',
      entityId: 'task-blocked',
      reason: 'overdue_task',
      severity: 'HIGH',
      status: 'OPEN',
      firstSeenAt: '2026-07-05T10:00:00.000Z',
      lastSeenAt: now,
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {
        title: 'مانع فوری پرداخت',
        description: 'موعد کار گذشته و مانع هنوز باز است.',
        actionLabel: 'رفع مانع',
        task: {
          id: 'task-blocked',
          key: 'CORE-104',
          title: tasks[3].title,
          status: 'BLOCKED',
          priority: 'URGENT',
          dueAt: tasks[3].dueAt,
          assigneeId: users.overloaded.id,
          projectId: 'project-core',
          projectName: projects[0].name,
        },
      },
      createdAt: '2026-07-05T10:00:00.000Z',
      updatedAt: now,
    },
    {
      id: 'attention-3',
      workspaceId: workspace.id,
      assigneeId: null,
      managerId: users.admin.id,
      entityType: 'task',
      entityId: 'task-backlog',
      reason: 'backlog_triage',
      severity: 'LOW',
      status: 'OPEN',
      firstSeenAt: '2026-07-05T11:00:00.000Z',
      lastSeenAt: now,
      snoozedUntil: null,
      resolvedAt: null,
      dismissedAt: null,
      dismissalReason: null,
      payload: {
        title: 'ورودی تازه برای تریاژ',
        description: 'این ورودی باید امروز تعیین تکلیف شود.',
        actionLabel: 'تصمیم تریاژ',
        task: {
          id: 'task-backlog',
          key: 'CORE-102',
          title: tasks[1].title,
          status: 'BACKLOG',
          priority: 'MEDIUM',
          dueAt: null,
          assigneeId: null,
          projectId: 'project-core',
          projectName: projects[0].name,
        },
      },
      createdAt: '2026-07-05T11:00:00.000Z',
      updatedAt: now,
    },
  ],
  total: 3,
  limit: 24,
  offset: 0,
  generatedAt: now,
};

const missingCheckIns = {
  items: [
    {
      user: users.overloaded,
      lastCheckInAt: '2026-07-04T08:00:00.000Z',
      hoursSinceLastCheckIn: 49,
    },
  ],
  total: 1,
  thresholdHours: 24,
  generatedAt: now,
};

const oneOnOnes = [
  {
    id: 'one-on-one-1',
    workspaceId: workspace.id,
    managerId: users.admin.id,
    participantId: users.overloaded.id,
    title: '۱:۱ ظرفیت و موانع',
    cadenceDays: 14,
    nextScheduledAt: '2026-07-07T09:00:00.000Z',
    lastMeetingId: null,
    active: true,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: now,
    manager: users.admin,
    participant: users.overloaded,
    lastMeeting: null,
    _count: { agendaItems: 2 },
  },
];

const capacityUsers = [
  {
    membershipId: 'membership-admin',
    role: 'ADMIN',
    joinedAt: now,
    user: users.admin,
    capacity: {
      id: 'capacity-admin',
      workspaceId: workspace.id,
      userId: users.admin.id,
      dailyWeightLimit: 6,
      weeklyWeightLimit: 30,
      active: true,
      note: 'مدیریت و بازبینی نیم‌وقت',
      createdAt: now,
      updatedAt: now,
    },
  },
  {
    membershipId: 'membership-reviewer',
    role: 'MEMBER',
    joinedAt: now,
    user: users.reviewer,
    capacity: {
      workspaceId: workspace.id,
      userId: users.reviewer.id,
      dailyWeightLimit: 8,
      weeklyWeightLimit: null,
      active: true,
      note: null,
    },
  },
  {
    membershipId: 'membership-overloaded',
    role: 'MEMBER',
    joinedAt: now,
    user: users.overloaded,
    capacity: {
      id: 'capacity-overloaded',
      workspaceId: workspace.id,
      userId: users.overloaded.id,
      dailyWeightLimit: 8,
      weeklyWeightLimit: 40,
      active: true,
      note: 'تا پایان هفته روی انتشار پرداخت متمرکز است.',
      createdAt: now,
      updatedAt: now,
    },
  },
];

const workingAgreements = [
  {
    id: 'agreement-workspace',
    workspaceId: workspace.id,
    teamId: null,
    scopeKey: 'workspace',
    activeWipLimit: 4,
    reviewWipLimit: 3,
    reviewSlaHours: 24,
    blockedSlaHours: 24,
    staleAfterHours: 72,
    createdAt: now,
    updatedAt: now,
    team: null,
  },
];
