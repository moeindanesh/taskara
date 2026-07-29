import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:4199';
const workspaceSlug = 'dastak';

// Due dates are relative to the run, so the Today Load window means the same thing whatever day and
// timezone the suite runs in: "now" always falls inside the current workspace day.
const runAt = Date.now();
const day = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(runAt + offsetDays * day).toISOString();

const workspace = {
   id: 'workspace-1',
   name: 'دستک عملیات محصول',
   slug: workspaceSlug,
   description: 'فضای کاری تست نمای تیم',
};

const people = {
   admin: { id: 'user-admin', name: 'مدیر عملیات', email: 'manager@example.com', phone: null, mattermostUsername: 'manager', avatarUrl: null },
   member: { id: 'user-member', name: 'سارا توسعه‌دهنده', email: 'sara@example.com', phone: null, mattermostUsername: 'sara', avatarUrl: null },
   guest: { id: 'user-guest', name: 'مهمان بی‌کار', email: 'guest@example.com', phone: null, mattermostUsername: 'guest', avatarUrl: null },
   agent: { id: 'user-agent', name: 'ایجنت بی‌کار', email: 'agent@example.com', phone: null, mattermostUsername: 'agent', avatarUrl: null },
};

const teams = [{ id: 'team-core', name: 'تیم هسته', slug: 'core', description: null, _count: { members: 4, projects: 1 } }];

const projects = [
   {
      id: 'project-core',
      name: 'پروژه هسته',
      keyPrefix: 'CORE',
      description: null,
      status: 'ACTIVE',
      parentId: null,
      team: teams[0],
      lead: people.admin,
      _count: { tasks: 8, subprojects: 0 },
      healthUpdates: [],
   },
];

const membership = (role: string, user: (typeof people)[keyof typeof people]) => ({
   membershipId: `membership-${user.id}`,
   role,
   joinedAt: iso(-30),
   _count: { assignedTasks: 0, reportedTasks: 0, comments: 0 },
   ...user,
});

const taskaraUsers = [
   membership('ADMIN', people.admin),
   membership('MEMBER', people.member),
   membership('GUEST', people.guest),
   membership('AGENT', people.agent),
];

const taskBase = {
   description: null,
   project: { id: 'project-core', name: projects[0].name, keyPrefix: 'CORE', team: teams[0] },
   reporter: people.admin,
   version: 1,
   labels: [],
   _count: { comments: 0, subtasks: 0, blockingDependencies: 0, attachments: 0 },
};

// Three of these belong to the Today Load; the rest are the exclusions the rules call for.
const tasks = [
   { ...taskBase, id: 'task-overdue', key: 'CORE-101', title: 'کار عقب‌افتاده', status: 'TODO', priority: 'HIGH', weight: 8, dueAt: iso(-3), createdAt: iso(-6), updatedAt: iso(-3), completedAt: null, progressStartedAt: null, assignee: people.member },
   { ...taskBase, id: 'task-today', key: 'CORE-102', title: 'کار امروز', status: 'IN_PROGRESS', priority: 'MEDIUM', weight: 1, dueAt: iso(0), createdAt: iso(-2), updatedAt: iso(0), completedAt: null, progressStartedAt: iso(0), assignee: people.member },
   { ...taskBase, id: 'task-done-today', key: 'CORE-103', title: 'کار انجام‌شده امروز', status: 'DONE', priority: 'LOW', weight: 2, dueAt: iso(-1), createdAt: iso(-4), updatedAt: iso(0), completedAt: iso(0), progressStartedAt: iso(-1), assignee: people.member },
   { ...taskBase, id: 'task-future', key: 'CORE-104', title: 'کار آینده', status: 'TODO', priority: 'LOW', weight: 3, dueAt: iso(5), createdAt: iso(-1), updatedAt: iso(-1), completedAt: null, progressStartedAt: null, assignee: people.member },
   { ...taskBase, id: 'task-undated', key: 'CORE-105', title: 'کار بدون سررسید', status: 'TODO', priority: 'LOW', weight: 1, dueAt: null, createdAt: iso(-1), updatedAt: iso(-1), completedAt: null, progressStartedAt: null, assignee: people.member },
   { ...taskBase, id: 'task-canceled', key: 'CORE-106', title: 'کار لغوشده', status: 'CANCELED', priority: 'LOW', weight: 1, dueAt: iso(0), createdAt: iso(-3), updatedAt: iso(0), completedAt: null, progressStartedAt: null, assignee: people.member },
   { ...taskBase, id: 'task-done-old', key: 'CORE-107', title: 'کار انجام‌شده قدیمی', status: 'DONE', priority: 'LOW', weight: 4, dueAt: iso(-4), createdAt: iso(-8), updatedAt: iso(-3), completedAt: iso(-3), progressStartedAt: iso(-5), assignee: people.member },
   { ...taskBase, id: 'task-unassigned', key: 'CORE-108', title: 'کار بدون مسئول', status: 'TODO', priority: 'LOW', weight: 2, dueAt: iso(0), createdAt: iso(-1), updatedAt: iso(-1), completedAt: null, progressStartedAt: null, assignee: null },
   { ...taskBase, id: 'task-guest', key: 'CORE-109', title: 'کار مهمان', status: 'TODO', priority: 'LOW', weight: 1, dueAt: iso(5), createdAt: iso(-1), updatedAt: iso(-1), completedAt: null, progressStartedAt: null, assignee: people.guest },
];

test.describe('@team-overview workspace graph', () => {
   test.beforeEach(async ({ page }) => {
      await seedAuth(page);
      await mockTaskaraApi(page);
   });

   test('is where every role lands, and draws the workspace, its people and their Today Load', async ({ page }) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(`/${workspaceSlug}/overview$`));

      const graph = page.locator('svg');
      await expect(graph.locator('[data-node-kind="workspace"]')).toHaveCount(1);
      await expect(graph.locator(`[data-node-label="${workspace.name}"]`)).toHaveCount(1);

      // Humans keep their seat; the idle guest and agent stay off the graph.
      const persons = graph.locator('[data-node-kind="person"]');
      await expect(persons).toHaveCount(2);
      await expect(graph.locator(`[data-node-label="${people.member.name}"]`)).toHaveCount(1);
      await expect(graph.locator(`[data-node-label="${people.guest.name}"]`)).toHaveCount(0);

      // Overdue, due-today and done-today only — future, undated, canceled, stale-done and
      // unassigned work is all excluded.
      const taskNodes = graph.locator('[data-node-kind="task"]');
      await expect(taskNodes).toHaveCount(3);
      await expect(graph.locator('[data-node-kind="task"][data-status="TODO"]')).toHaveCount(1);
      await expect(graph.locator('[data-node-kind="task"][data-status="IN_PROGRESS"]')).toHaveCount(1);
      await expect(graph.locator('[data-node-kind="task"][data-status="DONE"]')).toHaveCount(1);
      await expect(graph.locator('[data-node-kind="task"][data-overdue="true"]')).toHaveCount(1);
   });

   test('sizes task nodes by weight and marks unestimated work with a dashed outline', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      const radiusOf = (id: string) =>
         page.locator(`[data-node-id="task:${id}"] circle`).nth(1).getAttribute('r');

      // Weight 8 against weight 1: area tracks the estimate, so the radius should be ~2.8x.
      const heavy = Number(await radiusOf('task-overdue'));
      const light = Number(await radiusOf('task-today'));
      expect(heavy).toBeGreaterThan(light * 2.5);
   });

   test('opens the issue from a task node', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      await page.locator('[data-node-id="task:task-today"]').click();
      await expect(page.getByRole('dialog').getByText('CORE-102').first()).toBeVisible();
   });

   test('opens a person’s open work in a sheet, whatever it is due', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      await page.locator(`[data-node-id="user:${people.member.id}"]`).click();
      await expect(page.getByRole('dialog', { name: people.member.name })).toBeVisible();

      // The graph shows today; the sheet shows the pool, so future and undated work is here too.
      const rows = page.getByTestId('person-sheet-row');
      await expect(rows).toHaveCount(4);
      await expect(rows.filter({ hasText: 'CORE-104' })).toBeVisible();
      await expect(rows.filter({ hasText: 'CORE-105' })).toBeVisible();
      // Finished and canceled work is not something to manage.
      await expect(rows.filter({ hasText: 'CORE-106' })).toHaveCount(0);
      await expect(rows.filter({ hasText: 'CORE-107' })).toHaveCount(0);

      // Opening a row hands off to the issue page.
      await rows.filter({ hasText: 'CORE-104' }).getByRole('button').first().click();
      await expect(page.getByText('CORE-104').first()).toBeVisible();
   });

   test('pulls a dateless task into today from the person sheet', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      await page.locator(`[data-node-id="user:${people.member.id}"]`).click();
      const undated = page.getByTestId('person-sheet-row').filter({ hasText: 'CORE-105' });

      // Work already due today has nothing to pull, so it offers no button.
      await expect(page.getByTestId('person-sheet-row').filter({ hasText: 'CORE-102' }).getByTestId('pull-into-today')).toHaveCount(0);

      await undated.getByTestId('pull-into-today').click();

      // It joins the Today Load, which means it lands on the graph behind the sheet.
      await expect(page.locator('[data-node-id="task:task-undated"]')).toHaveCount(1);
      await expect(undated.getByTestId('pull-into-today')).toHaveCount(0);
   });

   test('assigns unowned work to the open person and dates it today', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      await page.locator(`[data-node-id="user:${people.member.id}"]`).click();
      await page.getByRole('button', { name: /بدون مسئول/ }).click();

      const unowned = page.getByTestId('person-sheet-row').filter({ hasText: 'CORE-108' });
      await expect(unowned).toBeVisible();
      await unowned.getByTestId('claim-for-person').click();

      // One click gives it an owner and a day, so it appears on that person's cluster.
      await expect(page.locator('[data-node-id="task:task-unassigned"]')).toHaveCount(1);
      await expect(page.getByTestId('person-sheet-row').filter({ hasText: 'CORE-108' })).toHaveCount(0);
   });

   test('pops in work that arrives while the graph is open', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);
      // Nothing already on screen should be mid-entrance once the first layout is up.
      await expect(page.locator('[data-entering="true"]')).toHaveCount(0);

      await addTaskViaSync(page, {
         ...taskBase,
         id: 'task-arrived',
         key: 'CORE-200',
         title: 'کار تازه رسیده',
         status: 'TODO',
         priority: 'HIGH',
         weight: 2,
         dueAt: iso(0),
         createdAt: iso(0),
         updatedAt: iso(0),
         completedAt: null,
         progressStartedAt: null,
         assignee: people.member,
      });

      const arrival = page.locator('[data-node-id="task:task-arrived"]');
      await expect(arrival).toHaveCount(1);
      // Caught mid-flight: the entrance marker is present while the pop plays.
      await expect(arrival).toHaveAttribute('data-entering', 'true');
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(4);

      // ...and clears once it has landed, so it animates exactly once.
      await expect(arrival).not.toHaveAttribute('data-entering', 'true', { timeout: 4000 });
   });

   test('sounds an issue creation once, without the graph chiming for it again', async ({ page }) => {
      await page.addInitScript(recordOscillators);
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(3);

      // Clicking the person is both the gesture that unlocks audio and the way to the composer.
      await page.locator(`[data-node-id="user:${people.member.id}"]`).click();
      await page.getByRole('button', { name: 'کار جدید' }).click();
      await expect(page.getByPlaceholder('عنوان کار')).toBeVisible();
      const before = await countOscillators(page);

      await page.getByPlaceholder('عنوان کار').fill('کار ساخته‌شده در تست');
      await page.getByRole('button', { name: 'ایجاد کار', exact: true }).click();

      // The new task really does reach the graph, so the arrival path runs...
      await expect(page.locator('[data-node-kind="task"]')).toHaveCount(4);
      await page.waitForTimeout(1000);

      // ...yet only the three voices of the creation sound played: the arrival chime stayed quiet.
      expect(await countOscillators(page)).toBe(before + 3);
   });

   test('keeps the sound toggle available and remembers the choice', async ({ page }) => {
      await page.goto(`/${workspaceSlug}/overview`, { waitUntil: 'domcontentloaded' });

      const mute = page.getByRole('button', { name: 'خاموش کردن صدا' });
      await expect(mute).toBeVisible();
      await mute.click();

      const unmute = page.getByRole('button', { name: 'روشن کردن صدا' });
      await expect(unmute).toBeVisible();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'روشن کردن صدا' })).toBeVisible();
   });
});

/**
 * Counts every oscillator the page starts. Sounds cannot be listened to from a test, but each
 * distinct sound has a fixed number of voices, so the count tells us exactly which ones fired.
 */
function recordOscillators() {
   const started: number[] = [];
   (window as unknown as { __oscillators: number[] }).__oscillators = started;
   const create = AudioContext.prototype.createOscillator;
   AudioContext.prototype.createOscillator = function patched(this: AudioContext) {
      const oscillator = create.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
         started.push(when ?? 0);
         start(when);
      };
      return oscillator;
   };
}

function countOscillators(page: Page): Promise<number> {
   return page.evaluate(() => (window as unknown as { __oscillators?: number[] }).__oscillators?.length ?? 0);
}

/** Injects a task the way the sync engine broadcasts one, as manager-os.spec.ts does. */
async function addTaskViaSync(page: Page, task: unknown) {
   await page.evaluate(
      ({ scopeKey, syncedTask }) => {
         window.dispatchEvent(
            new CustomEvent('taskara:task-sync-message', {
               detail: { type: 'localTask', scopeKey, task: syncedTask },
            })
         );
      },
      { scopeKey: `${workspaceSlug}:${people.admin.id}:all:all`, syncedTask: task }
   );
}

async function seedAuth(page: Page) {
   await page.addInitScript(
      ({ session }) => {
         window.localStorage.setItem('taskara.auth.session.v1', JSON.stringify(session));
      },
      {
         session: {
            token: 'e2e-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            role: 'ADMIN',
            workspace,
            user: people.admin,
         },
      }
   );
}

async function mockTaskaraApi(page: Page) {
   // Cloned per test so one test's edits never leak into the next.
   const state = tasks.map((task) => ({ ...task }));

   await page.route(`${apiOrigin}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const query = url.searchParams;

      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
      if (path === '/sync/stream') return route.fulfill({ status: 204 });
      if (path === '/sync/bootstrap') {
         return json(route, {
            cursor: '1',
            serverTime: new Date(runAt).toISOString(),
            completedWindowDays: 5,
            omittedCompletedBefore: iso(-5),
            tasks: state,
            totalHotTasks: state.length,
            projects,
            teams,
            users: taskaraUsers,
            views: [],
         });
      }
      if (path === '/sync/pull') return json(route, { cursor: query.get('cursor') || '1', events: [], hasMore: false });
      if (path === '/sync/push') {
         const body = request.postDataJSON() as {
            mutations?: Array<{
               args: Record<string, unknown> & { idOrKey?: string; patch?: Record<string, unknown> };
               mutationId: string;
               name: string;
            }>;
         };

         return json(route, {
            cursor: '2',
            results: (body.mutations || []).map((mutation) => {
               const applied = (entity: unknown) => ({
                  mutationId: mutation.mutationId,
                  status: 'applied',
                  workspaceSeq: '2',
                  entity,
               });

               if (mutation.name === 'task.update') {
                  const index = state.findIndex(
                     (task) => task.id === mutation.args.idOrKey || task.key === mutation.args.idOrKey
                  );
                  const current = state[index];
                  const patch = mutation.args.patch || {};
                  const updated = {
                     ...current,
                     ...patch,
                     assignee: Object.prototype.hasOwnProperty.call(patch, 'assigneeId')
                        ? taskaraUsers.find((user) => user.id === patch.assigneeId) || null
                        : current.assignee,
                     updatedAt: iso(0),
                     version: (current.version || 0) + 1,
                  };
                  state[index] = updated as (typeof state)[number];
                  return applied(updated);
               }

               return applied({
                  ...taskBase,
                  ...mutation.args,
                  id: 'task-composed',
                  key: 'CORE-300',
                  createdAt: iso(0),
                  updatedAt: iso(0),
                  completedAt: null,
                  progressStartedAt: null,
                  assignee: taskaraUsers.find((user) => user.id === mutation.args?.assigneeId) || null,
               });
            }),
         });
      }
      if (path === '/me') return json(route, { workspace, user: people.admin, role: 'ADMIN', unreadNotifications: 0 });
      if (path === '/workspaces') {
         return json(route, {
            items: [{ membershipId: 'membership-user-admin', role: 'ADMIN', joinedAt: iso(-30), workspace }],
            total: 1,
         });
      }
      if (path === '/teams') return json(route, teams);
      if (path === '/projects') return json(route, projects);
      if (path === '/users') return json(route, pageResult(taskaraUsers));
      if (request.method() === 'GET' && /^\/tasks\/[^/]+$/.test(path)) {
         const key = decodeURIComponent(path.split('/').at(-1) || '');
         return json(route, tasks.find((task) => task.key === key || task.id === key) || null);
      }
      if (request.method() === 'GET' && /^\/tasks\/[^/]+\/(activity|reviews)$/.test(path)) return json(route, []);
      if (path === '/notifications') return json(route, { ...pageResult([]), unreadCount: 0 });
      if (path === '/notifications/sync') return json(route, { cursor: '0', notifications: [], unreadCount: 0 });
      if (path === '/announcements') return json(route, { ...pageResult([]), unreadCount: 0 });

      return json(route, {});
   });
}

async function json(route: Route, body: unknown) {
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function pageResult<T>(items: T[]) {
   return { items, total: items.length, limit: Math.max(items.length, 1), offset: 0 };
}
