import { expect, test, type Page, type Route } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:4199';
const now = '2026-08-23T10:00:00.000Z';
const primarySlug = 'rahkar-support';

const users = {
  admin: person('user-admin', 'مدیر پشتیبانی', 'admin@example.com'),
  manager: person('user-manager', 'مدیر دپارتمان با نام بسیار طولانی برای آزمون چیدمان', 'manager@example.com'),
  member: person('user-member', 'کارشناس پاسخ‌گویی', 'member@example.com'),
  peer: person('user-peer', 'کارشناس همکار که نباید پرونده‌اش دیده شود', 'peer@example.com'),
};

const department = {
  id: 'department-care',
  workspaceId: 'workspace-support',
  name: 'پاسخ‌گویی و مراقبت از مشتریان سازمانی',
  slug: 'customer-care',
  description: 'رسیدگی به درخواست‌های مشتریان و پیگیری تا تأیید نتیجه',
  active: true,
  createdAt: now,
  updatedAt: now,
};

const departmentMembers = [
  membership('membership-admin', users.admin, 'MANAGER'),
  membership('membership-manager', users.manager, 'MANAGER'),
  membership('membership-member', users.member, 'MEMBER'),
  membership('membership-peer', users.peer, 'MEMBER'),
];

test.describe('@support Support workspace', () => {
  test('sidebar separates daily work, insights, management, and common workspace destinations', async ({ page, isMobile }) => {
    await setupSupportPage(page, { actor: 'ADMIN' });
    await gotoApp(page, `/${primarySlug}/support/triage`);

    if (isMobile) {
      await page.getByRole('button', { name: 'باز و بسته کردن منوی کناری' }).click();
    }

    const work = page.getByTestId('support-sidebar-group-work');
    await expect(work).toBeVisible();
    await expect(work.getByText('کار', { exact: true })).toBeVisible();
    await expect(work.getByRole('link', { name: 'تریاژ' })).toBeVisible();
    await expect(work.getByRole('link', { name: 'پرونده‌های من' })).toBeVisible();
    await expect(work.getByRole('link', { name: 'صف دپارتمان' })).toBeVisible();
    await expect(work.getByRole('link', { name: 'نیازمند پیگیری' })).toBeVisible();
    await expect(work.getByRole('link', { name: 'صف‌های ذخیره‌شده' })).toBeVisible();

    const insights = page.getByTestId('support-sidebar-group-insights');
    await expect(insights.getByRole('link', { name: 'گزارش پشتیبانی' })).toBeVisible();

    const manage = page.getByTestId('support-sidebar-group-manage');
    const manageToggle = manage.getByRole('button', { name: 'مدیریت پشتیبانی' });
    await expect(manageToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(manage.getByRole('link', { name: 'دپارتمان‌ها' })).toBeHidden();
    await manageToggle.click();
    await expect(manageToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(manage.getByRole('link', { name: 'دپارتمان‌ها' })).toBeVisible();
    await expect(manage.getByRole('link', { name: 'مسیریابی و ظرفیت' })).toBeVisible();
    await expect(manage.getByRole('link', { name: 'توانمندسازی و کیفیت' })).toBeVisible();
    await expect(manage.getByRole('link', { name: 'عملیات و SLA' })).toBeVisible();
    await expect(manage.getByRole('link', { name: 'سلامت ورودی‌ها' })).toBeVisible();

    const workspace = page.getByTestId('support-sidebar-group-workspace');
    await expect(workspace.getByRole('link', { name: 'صندوق ورودی' })).toBeVisible();
    await expect(workspace.getByRole('link', { name: 'دانش' })).toBeVisible();
    await expect(workspace.getByRole('link', { name: 'اعضا' })).toBeVisible();
    await expect(workspace.getByRole('link', { name: 'تنظیمات' })).toBeVisible();
  });

  test('manual call travels through triage, Department dispatch, ownership, interaction, resolution, and close', async ({ page }) => {
    const callRequests: Array<Record<string, unknown>> = [];
    await setupSupportPage(page, { actor: 'ADMIN', callRequests });
    await gotoApp(page, `/${primarySlug}/support/triage`);

    await expect(page.getByTestId('support-queue-triage')).toBeVisible();
    await expect(page.getByText('پرونده‌ی بدون دپارتمان ندارید')).toBeVisible();
    await page.keyboard.press('c');

    const intake = page.getByRole('dialog', { name: 'ثبت ورودی پشتیبانی' });
    await expect(intake).toBeVisible();
    await intake.getByRole('button', { name: 'تماس تلفنی' }).click();
    await intake.getByLabel('عنوان پرونده').fill('قطع سرویس مشتری سازمانی پس از تمدید قرارداد');
    await intake.getByLabel('شرح درخواست').fill('مشتری اعلام کرد سرویس بعد از تمدید همچنان در دسترس نیست و پیگیری فوری می‌خواهد.');
    await intake.getByLabel('نام مشتری').fill('شرکت نمونه راهکار ایرانیان');
    await intake.getByLabel('شماره تماس').fill('+982188887777');
    await intake.getByLabel('خلاصه تماس').fill('تماس ورودی پاسخ داده شد و بررسی فنی تعهد شد.');
    await intake.getByLabel('مدت تماس (دقیقه)').fill('4.5');
    await intake.getByRole('button', { name: 'ثبت تماس و پرونده' }).click();

    await expect(page).toHaveURL(new RegExp(`/${primarySlug}/support/cases/SUP-1$`));
    await expect(page.getByTestId('support-case-detail')).toContainText('قطع سرویس مشتری سازمانی');
    await expect(page.getByText('تماس ورودی پاسخ داده شد و بررسی فنی تعهد شد.')).toBeVisible();
    expect(asRecord(callRequests[0]?.call).direction).toBe('INBOUND');
    expect(callRequests[0]).not.toHaveProperty('baseVersion');
    await expectNoPageOverflow(page);

    await gotoApp(page, `/${primarySlug}/support/triage`);
    await expect(page.getByText('قطع سرویس مشتری سازمانی پس از تمدید قرارداد')).toBeVisible();
    await page.getByLabel('دپارتمان مقصد SUP-1').selectOption(department.id);
    await page.getByRole('button', { name: 'ارجاع SUP-1' }).click();
    await expect(page.getByText('پرونده‌ی بدون دپارتمان ندارید')).toBeVisible();

    await gotoApp(page, `/${primarySlug}/support/department-inbox`);
    await expect(page.getByText('قطع سرویس مشتری سازمانی پس از تمدید قرارداد')).toBeVisible();
    await page.getByLabel('مسئول پرونده SUP-1').selectOption('membership-admin');
    await page.getByRole('button', { name: 'واگذاری SUP-1' }).click();
    await expect(page.getByText('صف دپارتمان خالی است')).toBeVisible();

    await gotoApp(page, `/${primarySlug}/support/my-cases`);
    await page.getByRole('link', { name: /قطع سرویس مشتری سازمانی/ }).click();
    await expect(page.getByTestId('support-case-detail')).toBeVisible();

    await page.getByRole('button', { name: 'تماس', exact: true }).click();
    await page.getByLabel('متن تعامل').fill('بررسی انجام شد؛ دسترسی مشتری بازیابی و نتیجه تلفنی اعلام شد.');
    await page.getByRole('button', { name: 'ثبت تعامل' }).click();
    await expect(page.getByText('بررسی انجام شد؛ دسترسی مشتری بازیابی و نتیجه تلفنی اعلام شد.')).toBeVisible();
    expect(callRequests[1]).toMatchObject({ caseId: 'case-1', baseVersion: expect.any(Number) });
    expect(asRecord(callRequests[1]?.call).direction).toBe('OUTBOUND');

    await page.getByLabel('خلاصه نتیجه').fill('تنظیم تمدید اصلاح شد و مشتری بازیابی سرویس را تأیید کرد.');
    await page.getByRole('button', { name: 'ثبت حل پرونده' }).click();
    await expect(page.getByText('تنظیم تمدید اصلاح شد و مشتری بازیابی سرویس را تأیید کرد.')).toBeVisible();
    await page.getByRole('button', { name: 'تأیید مشتری و بستن' }).click();
    await expect(page.getByText('این پرونده بسته است. بازگشایی استثنایی باید دلیل روشن داشته باشد.')).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('Case handoff previews only explicit text, uses the scoped Task picker, and preserves unlink tombstones', async ({ page }) => {
    const privateCaseTitle = 'قطع سرویس مشتری ویژه — عنوان خصوصی پرونده';
    const privateDescription = 'شرح خصوصی شامل قرارداد و جزئیات داخلی مشتری';
    const privatePhone = '+982188887777';
    const privateInteraction = 'متن محرمانه تماس که هرگز نباید به تیم تحویل شود';
    const item = makeCase({
      id: 'case-handoff',
      key: 'SUP-91',
      title: privateCaseTitle,
      description: privateDescription,
      departmentId: department.id,
      assigneeMembershipId: 'membership-admin',
      contactName: 'مشتری محرمانه تحویل',
      contactPhone: privatePhone,
    });
    item.interactions.push(makeInteraction(item, 'CALL', privateInteraction, { durationSeconds: 180 }));
    const handoff = makeHandoffFixture();
    await setupSupportPage(page, { actor: 'ADMIN', cases: [item], handoff });
    await gotoApp(page, `/${primarySlug}/support/cases/${item.key}`);

    const card = page.getByTestId('support-case-handoff-card');
    await expect(card).toContainText('کار تیمی حذف شده');
    await expect(card.locator('bdi[dir="ltr"]', { hasText: 'CORE-12' })).toBeVisible();

    await card.getByRole('button', { name: 'پیوند کار موجود' }).click();
    let dialog = page.getByRole('dialog', { name: 'پیوند کار تیمی موجود' });
    await dialog.getByLabel('مقصد مجاز').selectOption(handoff.targets[0].workTargetId);
    await dialog.getByLabel('عنوان تأییدشده تحویل').fill('بررسی خطای ورود بدون داده مشتری');
    await dialog.getByLabel('شرح مسئله و نتیجه مورد انتظار برای تیم').fill('علت خطای ورود را بررسی و نتیجه فنی را ثبت کنید.');
    await dialog.getByPlaceholder('جست‌وجو با کلید یا عنوان کار').fill('CORE-77');
    await dialog.getByRole('button', { name: 'جست‌وجوی کار تیمی' }).click();
    await dialog.getByLabel('کار موجود').selectOption(handoff.taskOptions[0].id);
    await dialog.getByRole('button', { name: /بررسی پیش‌نمایش/ }).click();
    await expect(dialog.getByTestId('support-handoff-preview')).toContainText('تیم محصول');
    await expect(dialog.getByTestId('support-handoff-preview')).toContainText('هسته محصول');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'تأیید و ثبت تحویل' }).click();
    await expect(card).toContainText('CORE-77');
    await expect(card.locator('bdi[dir="ltr"]', { hasText: 'CORE-77' })).toBeVisible();

    expect(handoff.linkRequests).toHaveLength(1);
    expect(handoff.linkRequests[0]).toMatchObject({
      workTargetId: handoff.targets[0].workTargetId,
      taskId: handoff.taskOptions[0].id,
      handoffTitle: 'بررسی خطای ورود بدون داده مشتری',
      relationType: 'FIX_WORK',
      baseVersion: 1,
    });
    expectCrossWorkspaceBodyIsRedacted(handoff.linkRequests[0], [
      privateCaseTitle,
      privateDescription,
      privatePhone,
      privateInteraction,
      'مشتری محرمانه تحویل',
    ]);

    await card.getByRole('button', { name: 'ساخت کار تیمی' }).click();
    dialog = page.getByRole('dialog', { name: 'ساخت کار تیمی از پرونده' });
    const safeHandoffTitle = 'رفع خطای تمدید نشست';
    const safeHandoffSummary = 'نشست منقضی را بازتولید و مسیر تمدید را اصلاح کنید.';
    const safeTaskTitle = 'اصلاح تمدید نشست در وب';
    await dialog.getByLabel('مقصد مجاز').selectOption(handoff.targets[0].workTargetId);
    await dialog.getByLabel('عنوان تأییدشده تحویل').fill(safeHandoffTitle);
    await dialog.getByLabel('شرح مسئله و نتیجه مورد انتظار برای تیم').fill(safeHandoffSummary);
    await dialog.getByLabel('عنوان کار تیمی').fill(safeTaskTitle);
    await dialog.getByLabel('جزئیات تکمیلی غیرحساس (اختیاری)').fill('پس از اصلاح، آزمون بازگشت نشست اضافه شود.');
    await dialog.getByLabel('اولویت').selectOption('HIGH');
    await dialog.getByRole('button', { name: /بررسی پیش‌نمایش/ }).click();

    const preview = dialog.getByTestId('support-handoff-preview');
    await expect(preview).toContainText('تیم محصول');
    await expect(preview).toContainText('هسته محصول');
    await expect(preview).toContainText(safeHandoffTitle);
    await expect(preview).toContainText(safeHandoffSummary);
    await expect(preview).not.toContainText(privateDescription);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'تأیید و ثبت تحویل' }).click();
    await expect(card).toContainText(safeTaskTitle);

    expect(handoff.createRequests).toHaveLength(1);
    expect(handoff.createRequests[0]).toMatchObject({
      workTargetId: handoff.targets[0].workTargetId,
      handoffTitle: safeHandoffTitle,
      handoffSummary: safeHandoffSummary,
      taskTitle: safeTaskTitle,
      taskPriority: 'HIGH',
      relationType: 'FIX_WORK',
      baseVersion: 2,
    });
    expect(handoff.createRequests[0]).not.toHaveProperty('projectId');
    expect(handoff.createRequests[0]).not.toHaveProperty('caseId');
    expectCrossWorkspaceBodyIsRedacted(handoff.createRequests[0], [
      privateCaseTitle,
      privateDescription,
      privatePhone,
      privateInteraction,
      'مشتری محرمانه تحویل',
    ]);

    const createdLink = handoff.links.find((link) => link.title === safeTaskTitle);
    expect(createdLink).toBeTruthy();
    await card.getByRole('button', { name: `برداشتن پیوند ${createdLink!.taskKey}` }).click();
    dialog = page.getByRole('dialog', { name: 'برداشتن پیوند کار تیمی' });
    const unlinkReason = 'کار جایگزین شد و این پیوند دیگر مبنای پیگیری نیست.';
    await dialog.getByLabel('دلیل برداشتن پیوند').fill(unlinkReason);
    await dialog.getByRole('button', { name: 'برداشتن پیوند' }).click();
    await expect(card).toContainText('پیوند برداشته شده');
    expect(handoff.unlinkRequests).toEqual([{ reason: unlinkReason, baseVersion: 3 }]);
  });

  test('RTL queues handle long Persian content, pagination, and mobile width without overflow', async ({ page }) => {
    const cases = Array.from({ length: 75 }, (_, index) => makeCase({
      id: `large-case-${index + 1}`,
      key: `SUP-${index + 1}`,
      title: index === 0
        ? 'درخواست بسیار طولانی مشتری سازمانی برای بررسی هم‌زمان صورتحساب، تمدید قرارداد و بازگردانی دسترسی چند شعبه در سراسر کشور'
        : `درخواست صف بزرگ شماره ${index + 1}`,
      contactName: index === 0 ? 'نام بسیار طولانی نماینده مشتری برای اطمینان از شکست‌نخوردن چیدمان راست‌به‌چپ' : `مشتری ${index + 1}`,
    }));
    await setupSupportPage(page, { actor: 'ADMIN', cases });
    await gotoApp(page, `/${primarySlug}/support/triage`);

    const screen = page.getByTestId('support-queue-triage');
    await expect(screen).toHaveAttribute('dir', 'rtl');
    await expect(page.getByText(/درخواست بسیار طولانی مشتری سازمانی/)).toBeVisible();
    await expect(page.locator('article[data-testid^="support-case-"]')).toHaveCount(50);
    await expectNoPageOverflow(page);

    await page.getByRole('button', { name: 'نمایش پرونده‌های بیشتر' }).click();
    await expect(page.locator('article[data-testid^="support-case-"]')).toHaveCount(75);
    await expectNoPageOverflow(page);
  });

  test('keyboard focus, reduced motion, mixed-direction facts, and SLA risk remain explicit without color', async ({ page, isMobile }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const item = makeCase({
      id: 'case-accessibility', key: 'SUP-RTL-88', title: 'پیگیری اختلال API برای مشتری فارسی',
      departmentId: department.id, assigneeMembershipId: 'membership-admin',
      contactName: 'شرکت راهکار نمونه', contactPhone: '+98 21 8877 6655',
      contactEmail: 'support+vip@example.com',
    });
    item.typeKey = 'billing_api';
    item.nextSlaDueAt = '2026-08-20T08:00:00.000Z';
    item.attentionReasons = ['SLA_BREACHED'];
    await setupSupportPage(page, { actor: 'ADMIN', cases: [item] });
    await gotoApp(page, `/${primarySlug}/support/attention`);

    const row = page.getByTestId(`support-case-${item.key}`);
    await expect(row.getByText('SLA نقض شده')).toBeVisible();
    await expect(row.getByText(/دیرکرد/).filter({ visible: true })).toBeVisible();
    await expect(row.locator('bdi[dir="ltr"]', { hasText: item.key })).toBeVisible();
    await row.getByRole('link', { name: /پیگیری اختلال API/ }).click();

    await expect(page.getByTestId('support-case-detail')).toBeVisible();
    await expect(page.locator('bdi[dir="ltr"]', { hasText: 'billing_api' })).toBeVisible();
    await expect(page.getByText(item.contact!.phone!, { exact: true }).filter({ visible: true })).toHaveAttribute('dir', 'ltr');
    await expect(page.getByText(item.contact!.email!, { exact: true }).filter({ visible: true })).toHaveAttribute('dir', 'ltr');
    await expect(page.getByText('SLA نقض شده')).toBeVisible();

    if (isMobile) {
      await page.getByRole('button', { name: 'باز و بسته کردن منوی کناری' }).click();
    }
    const createButton = page.getByRole('button', { name: 'ایجاد پرونده پشتیبانی' });
    await createButton.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(createButton).toBeFocused();
    const focusStyle = await createButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);

    await createButton.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'ثبت ورودی پشتیبانی' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const motion = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
    });
    expect(durationMilliseconds(motion.animationDuration)).toBeLessThanOrEqual(0.01);
    expect(durationMilliseconds(motion.transitionDuration)).toBeLessThanOrEqual(0.01);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(createButton).toBeFocused();
  });

  test('ordinary member sees only their own Case and leaves no Case/contact content in browser persistence', async ({ page, isMobile }) => {
    const own = makeCase({
      id: 'case-own',
      key: 'SUP-201',
      title: 'پرونده اختصاصی کارشناس فعلی',
      departmentId: department.id,
      assigneeMembershipId: 'membership-member',
      contactName: 'مشتری محرمانه خود کارشناس',
      contactPhone: '+989121234567',
    });
    const peer = makeCase({
      id: 'case-peer',
      key: 'SUP-202',
      title: 'پرونده محرمانه همکار که نباید افشا شود',
      departmentId: department.id,
      assigneeMembershipId: 'membership-peer',
      contactName: 'مشتری همکار',
    });
    await setupSupportPage(page, { actor: 'MEMBER', cases: [own, peer] });
    await gotoApp(page, `/${primarySlug}/support/my-cases`);

    await expect(page.getByText(own.title)).toBeVisible();
    await expect(page.getByText(peer.title)).toHaveCount(0);
    if (!isMobile) {
      await expect(page.getByRole('link', { name: 'تریاژ' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'صف دپارتمان' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'عملیات و SLA' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'سلامت ورودی‌ها' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'گزارش پشتیبانی' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'پرونده‌های من' }).locator('..')).toContainText('۱');
    }

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const command = page.getByRole('dialog', { name: 'منوی فرمان' });
    await command.getByRole('combobox').fill('محرمانه همکار');
    await expect(command.getByText(peer.title)).toHaveCount(0);
    await expect(command.getByText('پرونده‌ای در محدوده دسترسی شما پیدا نشد.')).toBeVisible();
    await page.keyboard.press('Escape');

    const persisted = await browserPersistenceSnapshot(page);
    expect(persisted).not.toContain(own.title);
    expect(persisted).not.toContain(own.contact?.phone || '');
    expect(persisted).not.toContain(peer.title);
  });

  test('Department managers get a read-only roster without membership mutation controls', async ({ page }) => {
    const requestedPaths: string[] = [];
    await setupSupportPage(page, { actor: 'MANAGER', requestedPaths });
    await gotoApp(page, `/${primarySlug}/support/departments`);

    await expect(page.getByTestId('support-departments-screen')).toBeVisible();
    await expect(page.getByText(users.member.name)).toBeVisible();
    await expect(page.getByText('افزودن، حذف و تغییر نقش اعضا فقط در اختیار مدیر فضای کاری است.')).toBeVisible();
    await expect(page.getByLabel('عضو فضای کاری')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ویرایش' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /حذف/ })).toHaveCount(0);
    expect(requestedPaths).not.toContain('POST /support/departments/department-care/members');
  });

  test('workspace admins can rename, describe, deactivate, and reactivate a Department', async ({ page }) => {
    await setupSupportPage(page, { actor: 'ADMIN' });
    await gotoApp(page, `/${primarySlug}/support/departments`);

    await page.getByRole('button', { name: 'ویرایش' }).click();
    let dialog = page.getByRole('dialog', { name: 'ویرایش دپارتمان' });
    await dialog.getByLabel('نام').fill('مرکز مراقبت مشتریان کلیدی');
    await dialog.getByLabel('توضیح').fill('مالک پاسخ و پیگیری مشتریان کلیدی تا بسته‌شدن پرونده');
    await dialog.getByLabel('وضعیت').selectOption('INACTIVE');
    await dialog.getByRole('button', { name: 'ذخیره تغییرات' }).click();
    await expect(page.getByText('مرکز مراقبت مشتریان کلیدی').first()).toBeVisible();
    await expect(page.getByText('غیرفعال').first()).toBeVisible();

    await page.getByRole('button', { name: 'ویرایش' }).click();
    dialog = page.getByRole('dialog', { name: 'ویرایش دپارتمان' });
    await dialog.getByLabel('وضعیت').selectOption('ACTIVE');
    await dialog.getByRole('button', { name: 'ذخیره تغییرات' }).click();
    await expect(page.getByText('فعال').first()).toBeVisible();
  });

  test('workspace admins manage business calendars and create immutable SLA versions', async ({ page }) => {
    const calendarRequests: Array<Record<string, unknown>> = [];
    const slaRequests: Array<Record<string, unknown>> = [];
    await setupSupportPage(page, { actor: 'ADMIN', calendarRequests, slaRequests });
    await gotoApp(page, `/${primarySlug}/support/operations`);

    const screen = page.getByTestId('support-operations-screen');
    await expect(screen).toContainText('تقویم‌های کاری');
    await expect(screen).toContainText('نسخه‌های تغییرناپذیر');
    await expect(screen.getByText('این نسخه ویرایش نمی‌شود')).toBeVisible();
    await expect(screen.getByText('ویرایش سیاست')).toHaveCount(0);

    await screen.getByRole('button', { name: 'تقویم', exact: true }).click();
    const calendarDialog = page.getByRole('dialog', { name: 'ساخت تقویم کاری' });
    await calendarDialog.getByLabel('نام تقویم').fill('ساعات پاسخ‌گویی ویژه');
    await calendarDialog.getByRole('button', { name: 'ساخت تقویم' }).click();
    await expect(screen).toContainText('ساعات پاسخ‌گویی ویژه');
    expect(calendarRequests[0]).toMatchObject({ timezone: 'Asia/Tehran', departmentId: null });
    expect(Array.isArray(calendarRequests[0]?.periods)).toBe(true);
    expect((calendarRequests[0]?.periods as unknown[]).length).toBeGreaterThan(0);

    await screen.getByRole('button', { name: 'سیاست', exact: true }).click();
    const policyDialog = page.getByRole('dialog', { name: 'ساخت سیاست SLA' });
    await policyDialog.getByLabel('کلید سیاست').fill('priority-support');
    await policyDialog.getByLabel('نام نسخه').fill('پشتیبانی اولویت‌دار');
    await policyDialog.getByRole('button', { name: 'ساخت سیاست' }).click();
    await expect(screen).toContainText('پشتیبانی اولویت‌دار');
    expect(slaRequests[0]).toMatchObject({
      policyKey: 'priority-support',
      calendarId: 'calendar-created-2',
      conditions: {},
    });
    expect(asRecord(slaRequests[0]?.targets).FIRST_RESPONSE).toEqual({ businessSeconds: 3600 });
    await expectNoPageOverflow(page);
  });

  test('intake admin shows only sanitized dead letters and confirms retry', async ({ page }) => {
    const retryRequests: string[] = [];
    await setupSupportPage(page, { actor: 'ADMIN', retryRequests });
    await gotoApp(page, `/${primarySlug}/support/intake-admin`);

    const screen = page.getByTestId('support-intake-admin-screen');
    await expect(screen).toContainText('ورودی‌های ناموفق نهایی');
    await expect(screen).toContainText('اتصال CRM');
    await screen.getByRole('button', { name: /اتصال CRM/ }).click();
    const detail = page.getByRole('dialog', { name: 'جزئیات ورودی ناموفق' });
    await expect(detail).toContainText('ورودی با قرارداد اتصال سازگار نیست');
    await expect(detail).toContainText('receipt-dead-letter');
    for (const forbidden of ['customer-private-payload', 'event-secret', 'idempotency-secret', 'connector-secret', 'raw-error-stack', 'ciphertext-secret']) {
      await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
    }

    await detail.getByRole('button', { name: 'تلاش مجدد' }).click();
    const confirmation = page.getByRole('dialog', { name: 'زمان‌بندی تلاش مجدد؟' });
    await confirmation.getByRole('button', { name: 'تأیید تلاش مجدد' }).click();
    await expect(detail).toHaveCount(0);
    expect(retryRequests).toEqual(['receipt-dead-letter']);
    await expectNoPageOverflow(page);
  });

  test('managed Department report explains its cohort and never renders peer performance', async ({ page }) => {
    await setupSupportPage(page, { actor: 'MANAGER' });
    await gotoApp(page, `/${primarySlug}/support/reports`);

    const screen = page.getByTestId('support-reports-screen');
    await expect(screen.getByTestId('support-report-cohort')).toContainText('پایان بازه، غیرشامل');
    await expect(screen.getByTestId('support-report-privacy')).toContainText('هیچ رتبه‌بندی، عملکرد فردی یا مقایسه همکاران ندارد');
    await expect(screen).toContainText('دپارتمان‌های تحت مدیریت');
    await expect(screen).not.toContainText(users.peer.name);
    await expectNoPageOverflow(page);
  });

  test('attention snooze refreshes a version conflict and resume carries the current baseVersion', async ({ page }) => {
    const item = makeCase({
      id: 'case-attention', key: 'SUP-701', title: 'پرونده نیازمند تعویق هشدار',
      departmentId: department.id, assigneeMembershipId: 'membership-admin',
    });
    item.attentionReasons = ['NEXT_ACTION_DUE'];
    const attentionRequests: Array<{ action: string; body: Record<string, unknown> }> = [];
    await setupSupportPage(page, { actor: 'ADMIN', cases: [item], attentionRequests, snoozeConflictOnce: true });
    await gotoApp(page, `/${primarySlug}/support/cases/${item.key}`);

    const card = page.getByTestId('support-attention-snooze-card');
    await card.getByRole('button', { name: 'یک ساعت' }).click();
    await card.getByLabel('دلیل تعویق توجه').fill('انتظار برای پنجره نگه‌داری سرویس');
    await card.getByRole('button', { name: 'تعویق توجه', exact: true }).click();
    await expect(card).toContainText('نسخه تازه بارگذاری شد');

    await card.getByRole('button', { name: 'یک ساعت' }).click();
    await card.getByLabel('دلیل تعویق توجه').fill('انتظار برای پنجره نگه‌داری سرویس');
    await card.getByRole('button', { name: 'تعویق توجه', exact: true }).click();
    await expect(card).toContainText('توجه به پرونده تعویق شده');

    await card.getByLabel('دلیل ازسرگیری توجه').fill('پنجره نگه‌داری زودتر آغاز شد');
    await card.getByRole('button', { name: 'ازسرگیری توجه' }).click();
    await expect(card.getByLabel('دلیل تعویق توجه')).toBeVisible();

    expect(attentionRequests.map((request) => [request.action, request.body.baseVersion])).toEqual([
      ['snooze', 1],
      ['snooze', 2],
      ['resume', 3],
    ]);
    expect(attentionRequests[1]?.body.reason).toBe('انتظار برای پنجره نگه‌داری سرویس');
    expect(attentionRequests[1]?.body.snoozedUntil).toEqual(expect.any(String));
    expect(attentionRequests[2]?.body.reason).toBe('پنجره نگه‌داری زودتر آغاز شد');
  });

  test('routing policies, member capacity, Case simulation, human priority decision, and presence work together', async ({ page }) => {
    const item = makeCase({
      id: 'case-routing', key: 'SUP-801', title: 'قطعی سرویس مشتری سازمانی برای مسیریابی',
    });
    item.impact = 'HIGH';
    item.urgency = 'MEDIUM';
    const routingPolicyRequests: Array<Record<string, unknown>> = [];
    const routingMemberRequests: Array<Record<string, unknown>> = [];
    const priorityRequests: Array<Record<string, unknown>> = [];
    await setupSupportPage(page, {
      actor: 'ADMIN', cases: [item], routingPolicyRequests, routingMemberRequests, priorityRequests,
      presenceCollision: true,
    });

    await gotoApp(page, `/${primarySlug}/support/routing`);
    const routing = page.getByTestId('support-routing-screen');
    await expect(routing).toContainText('سیاست مسیریابی');
    await expect(routing).toContainText('ظرفیت اعضا');

    await routing.getByRole('spinbutton', { name: `ظرفیت ${users.admin.name}`, exact: true }).fill('6');
    await routing.getByLabel(`مهارت‌های ${users.admin.name}`).fill('enterprise, api:enterprise');
    await routing.getByRole('button', { name: `ذخیره ظرفیت ${users.admin.name}`, exact: true }).click();
    expect(routingMemberRequests.at(-1)).toMatchObject({
      routingAvailability: 'AVAILABLE', routingCapacity: 6,
      routingSkills: ['api:enterprise', 'enterprise'],
    });

    await routing.getByRole('button', { name: 'نسخه جدید از این' }).click();
    const policyDialog = page.getByRole('dialog', { name: 'نسخه جدید سیاست مسیریابی' });
    await policyDialog.getByLabel('نام نسخه').fill('مسیریابی سازمانی نسخه دوم');
    await policyDialog.getByRole('button', { name: 'ساخت نسخه' }).click();
    expect(routingPolicyRequests[0]).toMatchObject({ label: 'مسیریابی سازمانی نسخه دوم', activate: false });
    await routing.getByTestId('support-routing-policy-2').getByRole('button', { name: 'فعال‌سازی' }).click();
    await expect(routing.getByTestId('support-routing-policy-2')).toContainText('فعال');

    await gotoApp(page, `/${primarySlug}/support/cases/${item.key}`);
    await expect(page.getByTestId('support-case-presence-warning')).toContainText(users.manager.name);
    const assistance = page.getByTestId('support-case-routing-assistance');
    await assistance.getByRole('button', { name: 'شبیه‌سازی' }).click();
    await expect(assistance.getByTestId('support-routing-explanation')).toContainText(department.name);
    await expect(assistance.getByTestId('support-routing-explanation')).toContainText('کمترین نسبت بار');
    await assistance.getByRole('button', { name: 'اعمال مسیر پیشنهادی' }).click();
    await expect(assistance.getByRole('button', { name: 'اعمال مسیر پیشنهادی' })).toHaveCount(0);

    await assistance.getByRole('button', { name: `پذیرش پیشنهاد فوری` }).click();
    expect(priorityRequests).toEqual([{ decision: 'ACCEPT_SUGGESTION', baseVersion: 2 }]);
    await expect(page.getByText('فوری').first()).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test('a scoped member creates and runs a private saved queue without persisting Case content', async ({ page }) => {
    const own = makeCase({
      id: 'case-saved-queue', key: 'SUP-811', title: 'پرونده خصوصی در صف ذخیره‌شده',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
      contactPhone: '+989120001122',
    });
    const savedQueueRequests: Array<Record<string, unknown>> = [];
    await setupSupportPage(page, { actor: 'MEMBER', cases: [own], savedQueueRequests });
    await gotoApp(page, `/${primarySlug}/support/saved-queues`);

    const screen = page.getByTestId('support-saved-queues-screen');
    await expect(screen).toContainText('هنوز صفی ذخیره نکرده‌اید');
    await screen.getByLabel('ساخت صف ذخیره‌شده').click();
    const dialog = page.getByRole('dialog', { name: 'ساخت صف ذخیره‌شده' });
    await dialog.getByLabel('نام صف').fill('پیگیری‌های شخصی من');
    await dialog.getByLabel('صف مبنا').selectOption('MY_CASES');
    await dialog.getByRole('button', { name: 'ذخیره صف' }).click();
    expect(savedQueueRequests[0]).toMatchObject({
      name: 'پیگیری‌های شخصی من', visibility: 'PRIVATE',
      filters: { schemaVersion: 1, queue: 'MY_CASES' },
    });

    await screen.getByTestId('support-saved-queue-saved-view-1').getByRole('button').first().click();
    await expect(screen.getByTestId('support-saved-queue-results')).toContainText(own.title);
    const persisted = await browserPersistenceSnapshot(page);
    expect(persisted).not.toContain(own.title);
    expect(persisted).not.toContain(own.contact?.phone || '');
    await expectNoPageOverflow(page);
  });

  test('workspace and access-epoch changes purge the old in-memory projection before rendering the new scope', async ({ page }) => {
    const secondSlug = 'rahkar-private';
    const alphaCase = makeCase({
      id: 'case-alpha', key: 'SUP-301', title: 'محتوای محرمانه فضای پشتیبانی اول',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
    });
    const betaCase = makeCase({
      id: 'case-beta', key: 'SUP-401', title: 'محتوای مستقل فضای پشتیبانی دوم',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
    });
    const fixture = await setupSupportPage(page, {
      actor: 'MEMBER',
      workspaces: {
        [primarySlug]: fixtureWorkspace(primarySlug, [alphaCase]),
        [secondSlug]: fixtureWorkspace(secondSlug, [betaCase]),
      },
    });

    await gotoApp(page, `/${primarySlug}/support/my-cases`);
    await expect(page.getByText(alphaCase.title)).toBeVisible();
    await gotoApp(page, `/${secondSlug}/support/my-cases`);
    await expect(page.getByText(betaCase.title)).toBeVisible();
    await expect(page.getByText(alphaCase.title)).toHaveCount(0);

    fixture.workspaces[secondSlug].epoch = '2';
    fixture.workspaces[secondSlug].revoked = true;
    await page.getByRole('button', { name: 'تازه‌سازی صف' }).click();
    await expect(page).toHaveURL(new RegExp(`/${secondSlug}/support/no-access$`));
    await expect(page.getByText(betaCase.title)).toHaveCount(0);
    expect(await browserPersistenceSnapshot(page)).not.toContain(betaCase.title);
  });

  test('an SSE wakeup and reconnect pull opaque-cursor deltas while a 409 forces a privacy-safe rebootstrap', async ({ page }) => {
    const transferred = makeCase({
      id: 'case-reconnect-transfer', key: 'SUP-451', title: 'پرونده منتقل‌شده هنگام قطع شبکه',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
    });
    const revoked = makeCase({
      id: 'case-reconnect-revoked', key: 'SUP-452', title: 'پرونده محرمانه پیش از لغو دسترسی',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
    });
    const syncPullRequests: string[] = [];
    const syncStreamWakeups: Array<{ type: 'sync' | 'scopeReset'; accessEpoch: string }> = [];
    const fixture = await setupSupportPage(page, {
      actor: 'MEMBER', cases: [transferred, revoked], syncPullRequests, syncStreamWakeups,
    });
    const scope = fixture.workspaces[primarySlug];

    await gotoApp(page, `/${primarySlug}/support/my-cases`);
    await expect(page.getByText(transferred.title)).toBeVisible();
    await expect(page.getByText(revoked.title)).toBeVisible();

    const transferredRecord = scope.cases.find((item) => item.id === transferred.id)!;
    transferredRecord.assigneeMembershipId = 'membership-peer';
    transferredRecord.version += 1;
    scope.syncCursor += 1;
    scope.syncEvents.push({
      type: 'removeFromScope', entityType: 'support_case', entityId: transferred.id,
    });
    syncPullRequests.length = 0;
    syncStreamWakeups.push({ type: 'sync', accessEpoch: '1' });

    await expect.poll(() => syncPullRequests.length).toBeGreaterThan(0);
    syncStreamWakeups.shift();
    await expect(page.getByText(transferred.title)).toHaveCount(0);
    await expect(page.getByText(revoked.title)).toBeVisible();
    const successfulPull = new URL(syncPullRequests.at(-1)!);
    expect(successfulPull.searchParams.get('accessEpoch')).toBe('1');
    expect(successfulPull.searchParams.get('cursor')).toMatch(/^ssc1\./);

    scope.epoch = '2';
    scope.revoked = true;
    scope.meDelayMs = 250;
    syncPullRequests.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.getByTestId('support-scope-guard')).toBeVisible();
    await expect(page.getByText(revoked.title)).toHaveCount(0);
    await expect.poll(() => syncPullRequests.length).toBeGreaterThan(0);
    await expect(page).toHaveURL(new RegExp(`/${primarySlug}/support/no-access$`));
    expect(await browserPersistenceSnapshot(page)).not.toContain(revoked.title);
  });

  test('Case maturity keeps assistance human-led, enablement reversible, KCS evidence-scoped, and CSAT tokens ephemeral', async ({ page }) => {
    const privateTitle = 'پرونده محرمانه بلوغ پشتیبانی برای مشتری کلیدی';
    const privateDescription = 'شرح خصوصی مشتری و جزئیات قراردادی که نباید در ذخیره‌سازی مرورگر بماند.';
    const privatePhone = '+982188881919';
    const item = makeCase({
      id: 'case-maturity', key: 'SUP-920', title: privateTitle, description: privateDescription,
      departmentId: department.id, assigneeMembershipId: 'membership-admin',
      contactName: 'مشتری خصوصی بلوغ', contactPhone: privatePhone,
    });
    item.status = 'OPEN';
    const phase8 = makePhase8Fixture(item);
    await setupSupportPage(page, { actor: 'ADMIN', cases: [item], phase8 });
    await gotoApp(page, `/${primarySlug}/support/cases/${item.key}`);

    const assistance = page.getByTestId('support-case-assistance');
    await expect(assistance).toContainText('rules / case-type / v4');
    await expect(assistance).toContainText('تصمیم یا اجرا همیشه انسانی است');
    await assistance.getByLabel('دلیل تصمیم درباره پیشنهاد').fill('نوع پرونده با بررسی انسانی تأیید شد.');
    await assistance.getByRole('button', { name: 'پذیرش انسانی' }).click();
    await expect(assistance).toContainText('پذیرفته‌شده');
    expect(phase8.assistanceDecisionRequests).toEqual([{
      decision: 'ACCEPTED', reason: 'نوع پرونده با بررسی انسانی تأیید شد.', baseVersion: 1,
    }]);
    expect(phase8.suggestions[0].decision).toBe('ACCEPTED');

    const enablement = page.getByTestId('support-case-enablement');
    await enablement.getByRole('button', { name: 'پیش‌نمایش', exact: true }).click();
    const preview = enablement.getByRole('region', { name: 'پیش‌نمایش دقیق تغییرات' });
    await expect(preview).toContainText('اولویت');
    await expect(preview).toContainText('عادی');
    await expect(preview).toContainText('زیاد');
    await expect(preview).toContainText('فقط با تأیید انسان اعمال می‌شود');
    await preview.getByRole('button', { name: 'اعمال تغییرات پیش‌نمایش‌شده' }).click();
    await expect(enablement).toContainText('اعمال روی نسخه');
    expect(phase8.enablementRequests.at(-1)).toMatchObject({
      action: 'apply', body: { baseVersion: 2, previewHash: phase8.previewHash },
    });
    expect(phase8.casePrioritySnapshots.at(-1)).toBe('HIGH');

    await enablement.getByRole('button', { name: 'بازگردانی امن' }).click();
    await expect(enablement.getByRole('button', { name: 'بازگردانی امن' })).toHaveCount(0);
    expect(phase8.enablementRequests.at(-1)).toMatchObject({ action: 'undo', body: { baseVersion: 3 } });
    expect(phase8.casePrioritySnapshots.at(-1)).toBe('NORMAL');

    const kcs = page.getByTestId('support-case-kcs');
    await kcs.getByLabel('جست‌وجوی دانش برای پرونده').fill('تمدید نشست');
    await kcs.getByRole('button', { name: 'جست‌وجوی دانش', exact: true }).click();
    await expect(kcs).toContainText(phase8.knowledgePages[0].title);
    await expect(kcs).not.toContainText(phase8.privateKnowledgeContent);
    await kcs.getByRole('button', { name: new RegExp(phase8.knowledgePages[0].title) }).click();
    await kcs.getByLabel('مفیدبودن').selectOption('HELPFUL');
    await kcs.getByLabel('نتیجه').selectOption('ADVANCED');
    await kcs.getByRole('button', { name: 'ثبت استفاده' }).click();
    await expect(kcs.getByRole('status')).toContainText('استفاده و نتیجه مقاله ثبت شد.');
    expect(phase8.knowledgeUseRequests[0]).toMatchObject({
      pageId: phase8.knowledgePages[0].id, usefulness: 'HELPFUL', outcome: 'ADVANCED',
    });

    await kcs.getByLabel('بازخورد شکاف دانش').fill('گام آخر این راهنما دیگر با نسخه جاری سامانه سازگار نیست.');
    await kcs.getByRole('button', { name: 'ثبت برای بازبینی' }).click();
    await expect(kcs.getByRole('status')).toContainText('اشکال مقاله ثبت شد.');
    expect(phase8.knowledgeGapRequests[0]).toMatchObject({
      kind: 'WRONG', pageId: phase8.knowledgePages[0].id,
    });

    await page.getByLabel('خلاصه نتیجه').fill('مشکل با راهنمای تأییدشده حل و نتیجه با مشتری بررسی شد.');
    await page.getByRole('button', { name: 'ثبت حل پرونده' }).click();
    const csat = page.getByTestId('support-case-csat');
    await expect(csat).toContainText('امتیاز ۵');
    await expect(csat).toContainText('پاسخ روشن و پیگیری مناسب بود.');
    await csat.getByRole('button', { name: 'ساخت دعوت ۱ تا ۵' }).click();
    await expect(csat).toContainText(phase8.csatToken);
    expect(phase8.csatInvitationRequests).toEqual([{ expiresInDays: 30, scaleMin: 1, scaleMax: 5 }]);

    const persisted = await browserPersistenceSnapshot(page);
    expect(persisted).not.toContain(privateTitle);
    expect(persisted).not.toContain(privateDescription);
    expect(persisted).not.toContain(privatePhone);
    expect(persisted).not.toContain(phase8.csatToken);
    expect(persisted).not.toContain(phase8.privateKnowledgeContent);
    await expectNoPageOverflow(page);
  });

  test('maturity workspace manages definition versions and renders only scoped cluster, Knowledge, and quality evidence', async ({ page }) => {
    const visible = makeCase({
      id: 'case-quality-visible', key: 'SUP-930', title: 'پرونده مجاز برای بازبینی کیفیت',
      departmentId: department.id, assigneeMembershipId: 'membership-member',
    });
    visible.status = 'RESOLVED';
    visible.resolvedAt = now;
    const phase8 = makePhase8Fixture(visible);
    await setupSupportPage(page, { actor: 'ADMIN', cases: [visible], phase8 });
    await gotoApp(page, `/${primarySlug}/support/maturity`);

    const screen = page.getByTestId('support-maturity-screen');
    await expect(screen).toBeVisible();
    await expect(screen).toContainText(phase8.definitions[0].name);
    const originalDefinition = screen.locator('article').filter({ hasText: phase8.definitions[0].name });
    await originalDefinition.getByRole('button', { name: 'نسخه جدید از این' }).click();
    const definitionDialog = page.getByRole('dialog', { name: 'نسخه جدید تعریف' });
    const nextDefinitionName = 'اولویت‌دهی استاندارد — نسخه دوم';
    await definitionDialog.getByLabel('نام نسخه').fill(nextDefinitionName);
    await definitionDialog.getByRole('button', { name: 'ساخت پیش‌نویس' }).click();

    let nextDefinition = screen.locator('article').filter({ hasText: nextDefinitionName });
    await expect(nextDefinition).toContainText('پیش‌نویس');
    await nextDefinition.getByRole('button', { name: 'تأیید نسخه' }).click();
    nextDefinition = screen.locator('article').filter({ hasText: nextDefinitionName });
    await expect(nextDefinition).toContainText('تأییدشده');
    await expect(screen.locator('article').filter({ hasText: 'standard-priority / v1' })).toContainText('بازنشسته');
    await nextDefinition.getByRole('button', { name: 'بازنشسته‌کردن' }).click();
    await expect(screen.locator('article').filter({ hasText: nextDefinitionName })).toContainText('بازنشسته');
    expect(phase8.definitionLifecycleRequests.map((entry) => entry.action)).toEqual(['create', 'approve', 'retire']);

    await screen.getByRole('button', { name: 'مسئله‌های پرتکرار' }).click();
    await expect(screen).toContainText('۱ قابل مشاهده');
    await screen.getByRole('button', { name: new RegExp(phase8.clusters[0].title) }).click();
    const cluster = screen.getByTestId(`support-cluster-${phase8.clusters[0].id}`);
    await expect(cluster).toContainText('۱ پرونده قابل مشاهده');
    await expect(cluster).toContainText(visible.key);
    await expect(cluster).toContainText(visible.title);
    await expect(screen).not.toContainText(phase8.peerPrivateValue);

    await screen.getByRole('button', { name: 'شکاف‌های دانش' }).click();
    const gap = screen.getByTestId(`support-knowledge-gap-${phase8.knowledgeGaps[0].id}`);
    await expect(gap).toContainText('مقاله نادرست');
    await expect(gap).toContainText(phase8.knowledgeGaps[0].feedback);
    await gap.getByLabel(`مالک شکاف ${phase8.knowledgeGaps[0].id}`).selectOption(users.admin.id);
    await expect.poll(() => phase8.knowledgeGaps[0].reviewOwnerId).toBe(users.admin.id);
    await gap.getByLabel(`وضعیت شکاف ${phase8.knowledgeGaps[0].id}`).selectOption('IN_REVIEW');
    await expect.poll(() => phase8.knowledgeGaps[0].status).toBe('IN_REVIEW');

    await screen.getByRole('button', { name: 'کیفیت و بازبینی' }).click();
    await expect(screen).toContainText(phase8.rubrics[0].name);
    const review = screen.getByTestId(`support-quality-review-${phase8.reviews[0].id}`);
    await expect(review).toContainText(visible.title);
    await expect(review).toContainText('۸۴ از ۱۰۰');
    await expect(review).toContainText(users.member.name);
    await expect(screen).not.toContainText(phase8.peerPrivateValue);
    await expectNoPageOverflow(page);
  });
});

type ActorKind = 'ADMIN' | 'MANAGER' | 'MEMBER';

type FixtureCase = ReturnType<typeof makeCase>;

type FixtureHandoffLink = ReturnType<typeof makeHandoffLink>;

type FixtureHandoff = {
  targets: Array<{
    workTargetId: string;
    teamWorkspaceName: string;
    project: { name: string; keyPrefix: string; status: string };
    allowCreateTasks: boolean;
    allowLinkTasks: boolean;
  }>;
  taskOptions: Array<{ id: string; key: string; title: string; status: string; parentId: string | null }>;
  links: FixtureHandoffLink[];
  linkRequests: Array<Record<string, unknown>>;
  createRequests: Array<Record<string, unknown>>;
  unlinkRequests: Array<Record<string, unknown>>;
  nextTaskSequence: number;
};

type WorkspaceFixture = {
  workspace: { id: string; name: string; slug: string; mode: 'SUPPORT' };
  cases: FixtureCase[];
  epoch: string;
  revoked?: boolean;
  syncCursor: number;
  syncEvents: FixtureSyncEvent[];
  meDelayMs?: number;
};

type FixtureSyncEvent =
  | { type: 'upsert'; entityType: 'support_case'; entityId: string; entity: FixtureCase }
  | { type: 'removeFromScope'; entityType: 'support_case'; entityId: string }
  | { type: 'upsert'; entityType: 'support_department'; entityId: string; entity: typeof department };

type SupportFixture = {
  workspaces: Record<string, WorkspaceFixture>;
  handoff?: FixtureHandoff;
  operations: {
    calendars: FixtureCalendar[];
    policies: FixturePolicy[];
    deadLetters: FixtureDeadLetter[];
  };
  phase7: {
    policies: FixtureRoutingPolicy[];
    routingMembers: FixtureRoutingMember[];
    savedQueues: FixtureSavedQueue[];
  };
  phase8: FixturePhase8;
};

type FixtureCalendar = ReturnType<typeof makeCalendarFixture>;
type FixturePolicy = ReturnType<typeof makePolicyFixture>;
type FixtureDeadLetter = ReturnType<typeof makeDeadLetterFixture>;
type FixtureRoutingRule = {
  id: string;
  order: number;
  name: string;
  enabled: boolean;
  conditions: {
    caseTypeKeys: string[];
    priorities: string[];
    sourceChannels: string[];
    impacts: string[];
    urgencies: string[];
  };
  action: {
    targetDepartmentId: string;
    assignmentMode: 'DEPARTMENT_INBOX' | 'CAPACITY_AWARE';
    requiredSkills: string[];
  };
  targetDepartment: typeof department;
  createdAt: string;
};
type FixtureRoutingPolicy = {
  id: string;
  workspaceId: string;
  version: number;
  label: string | null;
  active: boolean;
  createdById: string | null;
  activatedById: string | null;
  activatedAt: string | null;
  createdAt: string;
  rules: FixtureRoutingRule[];
};
type FixtureRoutingMember = {
  membershipId: string;
  workspaceId: string;
  departmentId: string;
  userId: string;
  role: 'MEMBER' | 'MANAGER';
  active: boolean;
  routingAvailability: 'UNAVAILABLE' | 'AVAILABLE';
  routingCapacity: number;
  routingSkills: string[];
  activeCaseLoad: number;
  availableSlots: number;
  updatedAt: string;
  user: ReturnType<typeof person>;
};
type FixtureSavedQueue = {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  visibility: 'PRIVATE' | 'DEPARTMENT' | 'WORKSPACE';
  departmentId: string | null;
  filters: {
    schemaVersion: 1;
    queue?: string;
    statuses: string[];
    priorities: string[];
    sourceChannels: string[];
    departmentId?: string;
    typeKey?: string;
    attentionReason?: string;
    receivedWithinHours?: number;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
};

type FixtureAssistanceSuggestion = ReturnType<typeof makeAssistanceSuggestionFixture>;
type FixtureEnablementDefinition = ReturnType<typeof makeEnablementDefinitionFixture>;
type FixtureKnowledgePage = ReturnType<typeof makeKnowledgePageFixture>;
type FixtureKnowledgeUse = ReturnType<typeof makeKnowledgeUseFixture>;
type FixtureKnowledgeGap = ReturnType<typeof makeKnowledgeGapFixture>;
type FixtureProblemCluster = ReturnType<typeof makeProblemClusterFixture>;
type FixtureQualityRubric = ReturnType<typeof makeQualityRubricFixture>;
type FixtureQualityReview = ReturnType<typeof makeQualityReviewFixture>;
type FixtureCsatInvitation = ReturnType<typeof makeCsatInvitationFixture>;
type FixtureEnablementApplication = {
  id: string;
  definitionId: string;
  caseId: string;
  caseVersionBefore: number;
  caseVersionAfter: number;
  previewHash: string;
  appliedAt: string;
  undoneAt: string | null;
  undoCaseVersion: number | null;
  previousPriority: FixtureCase['priority'];
};
type FixturePhase8 = {
  suggestions: FixtureAssistanceSuggestion[];
  definitions: FixtureEnablementDefinition[];
  applications: FixtureEnablementApplication[];
  knowledgePages: FixtureKnowledgePage[];
  knowledgeUses: FixtureKnowledgeUse[];
  knowledgeGaps: FixtureKnowledgeGap[];
  clusters: FixtureProblemCluster[];
  rubrics: FixtureQualityRubric[];
  reviews: FixtureQualityReview[];
  csatInvitations: FixtureCsatInvitation[];
  assistanceDecisionRequests: Array<Record<string, unknown>>;
  definitionLifecycleRequests: Array<{ action: 'create' | 'approve' | 'retire'; id?: string; body?: Record<string, unknown> }>;
  enablementRequests: Array<{ action: 'preview' | 'apply' | 'undo' | 'evaluate'; body: Record<string, unknown> }>;
  casePrioritySnapshots: FixtureCase['priority'][];
  knowledgeUseRequests: Array<Record<string, unknown>>;
  knowledgeGapRequests: Array<Record<string, unknown>>;
  knowledgeGapUpdateRequests: Array<Record<string, unknown>>;
  csatInvitationRequests: Array<Record<string, unknown>>;
  previewHash: string;
  csatToken: string;
  privateKnowledgeContent: string;
  peerPrivateValue: string;
  initialDefinitionName: string;
};

async function setupSupportPage(page: Page, options: {
  actor?: ActorKind;
  cases?: FixtureCase[];
  requestedPaths?: string[];
  syncPullRequests?: string[];
  syncStreamWakeups?: Array<{ type: 'sync' | 'scopeReset'; accessEpoch: string }>;
  callRequests?: Array<Record<string, unknown>>;
  calendarRequests?: Array<Record<string, unknown>>;
  slaRequests?: Array<Record<string, unknown>>;
  retryRequests?: string[];
  attentionRequests?: Array<{ action: string; body: Record<string, unknown> }>;
  routingPolicyRequests?: Array<Record<string, unknown>>;
  routingMemberRequests?: Array<Record<string, unknown>>;
  priorityRequests?: Array<Record<string, unknown>>;
  savedQueueRequests?: Array<Record<string, unknown>>;
  presenceCollision?: boolean;
  snoozeConflictOnce?: boolean;
  workspaces?: Record<string, WorkspaceFixture>;
  handoff?: FixtureHandoff;
  phase8?: FixturePhase8;
} = {}): Promise<SupportFixture> {
  const actorKind = options.actor || 'ADMIN';
  const actor = actorKind === 'ADMIN' ? users.admin : actorKind === 'MANAGER' ? users.manager : users.member;
  const initialCases = options.cases || [];
  const fixture: SupportFixture = {
    workspaces: options.workspaces || { [primarySlug]: fixtureWorkspace(primarySlug, initialCases) },
    handoff: options.handoff,
    operations: {
      calendars: [makeCalendarFixture()],
      policies: [makePolicyFixture()],
      deadLetters: [makeDeadLetterFixture()],
    },
    phase7: {
      policies: [makeRoutingPolicyFixture()],
      routingMembers: departmentMembers.map(makeRoutingMemberFixture),
      savedQueues: [],
    },
    phase8: options.phase8 || makeEmptyPhase8Fixture(),
  };

  await page.addInitScript(
    ({ session }) => window.localStorage.setItem('taskara.auth.session.v1', JSON.stringify(session)),
    {
      session: {
        token: 'support-e2e-token',
        expiresAt: '2027-01-01T00:00:00.000Z',
        role: actorKind === 'ADMIN' ? 'ADMIN' : 'MEMBER',
        workspace: fixture.workspaces[primarySlug]?.workspace || Object.values(fixture.workspaces)[0].workspace,
        user: actor,
      },
    }
  );

  await page.route(`${apiOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const slug = request.headers()['x-workspace-slug'] || primarySlug;
    const scope = fixture.workspaces[slug] || Object.values(fixture.workspaces)[0];
    options.requestedPaths?.push(`${method} ${path}`);

    if (method === 'OPTIONS') return route.fulfill({ status: 204 });
    if (path === '/me') {
      if (scope.meDelayMs) await new Promise((resolve) => setTimeout(resolve, scope.meDelayMs));
      return json(route, meResponse(scope, actorKind, actor));
    }
    if (path === '/workspaces') {
      return json(route, {
        items: Object.values(fixture.workspaces).map((item, index) => ({
          membershipId: `workspace-membership-${index}`,
          role: actorKind === 'ADMIN' ? 'ADMIN' : 'MEMBER',
          joinedAt: now,
          workspace: item.workspace,
        })),
        total: Object.keys(fixture.workspaces).length,
      });
    }
    if (path === '/notifications') return json(route, { items: [], total: 0, unreadCount: 0 });
    if (path === '/notifications/sync') return json(route, { items: [], unreadCount: 0, nextCursor: null });
    if (path === '/knowledge/spaces') return json(route, []);
    if (path === '/knowledge/references') return json(route, []);
    if (path === '/knowledge/pages') return json(route, { items: [], total: 0 });

    if (path === '/support/sync/bootstrap') {
      if (scope.revoked) return json(route, supportBootstrap(scope, actorKind, []));
      return json(route, supportBootstrap(scope, actorKind, visibleCases(scope.cases, actorKind)));
    }
    if (path === '/support/sync/stream') {
      if (!options.syncStreamWakeups) return route.fulfill({ status: 204 });
      const deadline = Date.now() + 2_500;
      while (!options.syncStreamWakeups.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const wakeup = options.syncStreamWakeups[0];
      if (!wakeup) return route.fulfill({ status: 204 });
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: `event: ${wakeup.type}\ndata: ${JSON.stringify(wakeup)}\n\n`,
      });
    }
    if (path === '/support/sync/pull') {
      options.syncPullRequests?.push(url.toString());
      if (url.searchParams.get('accessEpoch') !== scope.epoch) {
        return json(route, {
          message: 'Support access scope changed',
          code: 'SUPPORT_SCOPE_CHANGED',
          accessEpoch: scope.epoch,
        }, 409);
      }
      const events = scope.syncEvents.splice(0);
      return json(route, {
        accessEpoch: scope.epoch,
        cursor: supportCursor(scope),
        hasMore: false,
        events,
      });
    }
    if (path === '/support/cases/counts') {
      return json(route, {
        counts: queueCounts(visibleCases(scope.cases, actorKind), actorKind),
        accessEpoch: scope.epoch,
      });
    }
    if (path === '/support/departments' && method === 'GET') {
      return json(route, { items: [department], total: 1, accessEpoch: scope.epoch });
    }
    if (path === '/support/departments' && method === 'POST') {
      const input = postData(request);
      return json(route, { ...department, id: 'department-created', ...input, active: true, createdAt: now, updatedAt: now });
    }
    if (path === `/support/departments/${department.id}` && method === 'PATCH') {
      Object.assign(department, postData(request), { updatedAt: now });
      return json(route, department);
    }
    if (path === `/support/departments/${department.id}/members` && method === 'GET') {
      return json(route, { items: departmentMembers, total: departmentMembers.length, departmentId: department.id, accessEpoch: scope.epoch });
    }
    if (path.startsWith(`/support/departments/${department.id}/members/`) && method === 'PATCH') {
      const userId = decodeURIComponent(path.split('/').at(-1) || '');
      const current = departmentMembers.find((item) => item.userId === userId) || departmentMembers[0];
      return json(route, { ...current, ...postData(request), updatedAt: now });
    }
    if (path.startsWith(`/support/departments/${department.id}/members/`) && method === 'DELETE') {
      return route.fulfill({ status: 204 });
    }
    if (path === '/support/permission-grants') {
      if (method === 'GET') return json(route, { items: [], total: 0, accessEpoch: scope.epoch });
      if (method === 'PUT') return json(route, { ...postData(request), id: 'grant-created', workspaceId: scope.workspace.id });
      if (method === 'DELETE') return route.fulfill({ status: 204 });
    }
    if (path === '/users') {
      return json(route, { items: Object.values(users), total: Object.keys(users).length, limit: 100, offset: 0 });
    }
    if (path === '/support/enablement/definitions') {
      if (method === 'GET') {
        const kind = url.searchParams.get('kind');
        const status = url.searchParams.get('status');
        const items = fixture.phase8.definitions.filter((item) =>
          (!kind || item.kind === kind) && (!status || item.status === status)
        );
        return json(route, {
          items, total: items.length,
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
        });
      }
      if (method === 'POST') {
        const input = postData(request);
        const definitionKey = String(input.definitionKey || 'definition');
        const version = Math.max(
          0,
          ...fixture.phase8.definitions
            .filter((item) => item.definitionKey === definitionKey)
            .map((item) => item.version)
        ) + 1;
        const created = makeEnablementDefinitionFixture({
          id: `definition-${fixture.phase8.definitions.length + 1}`,
          kind: input.kind === 'TEMPLATE' || input.kind === 'AUTOMATION' ? input.kind : 'MACRO',
          definitionKey,
          version,
          name: String(input.name || 'تعریف تازه'),
          description: typeof input.description === 'string' ? input.description : null,
          status: 'DRAFT',
          actions: Array.isArray(input.actions) ? input.actions.map(asRecord) : [],
          conditions: Array.isArray(input.conditions) ? input.conditions.map(asRecord) : null,
        });
        fixture.phase8.definitions.unshift(created);
        fixture.phase8.definitionLifecycleRequests.push({ action: 'create', body: input });
        return json(route, created, 201);
      }
    }
    const definitionLifecycleMatch = path.match(/^\/support\/enablement\/definitions\/([^/]+)\/(approve|retire)$/);
    if (definitionLifecycleMatch && method === 'POST') {
      const definitionId = decodeURIComponent(definitionLifecycleMatch[1]);
      const action = definitionLifecycleMatch[2] as 'approve' | 'retire';
      const definition = fixture.phase8.definitions.find((item) => item.id === definitionId);
      if (!definition) return json(route, { message: 'Support enablement definition not found' }, 404);
      if (action === 'approve') {
        for (const current of fixture.phase8.definitions) {
          if (current.id !== definition.id && current.definitionKey === definition.definitionKey && current.status === 'APPROVED') {
            current.status = 'RETIRED';
            current.retiredById = users.admin.id;
            current.retiredAt = now;
          }
        }
        definition.status = 'APPROVED';
        definition.approvedById = users.admin.id;
        definition.approvedAt = now;
      } else {
        definition.status = 'RETIRED';
        definition.retiredById = users.admin.id;
        definition.retiredAt = now;
      }
      fixture.phase8.definitionLifecycleRequests.push({ action, id: definition.id });
      return json(route, definition);
    }
    const applicationUndoMatch = path.match(/^\/support\/enablement\/applications\/([^/]+)\/undo$/);
    if (applicationUndoMatch && method === 'POST') {
      const applicationId = decodeURIComponent(applicationUndoMatch[1]);
      const application = fixture.phase8.applications.find((item) => item.id === applicationId);
      const input = postData(request);
      if (!application) return json(route, { message: 'Support enablement application not found' }, 404);
      const item = scope.cases.find((entry) => entry.id === application.caseId);
      if (!item) return json(route, { message: 'Support Case not found' }, 404);
      if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
      item.priority = application.previousPriority;
      mutateCase(item, 'case.enablement_undone');
      application.undoneAt = now;
      application.undoCaseVersion = item.version;
      fixture.phase8.enablementRequests.push({ action: 'undo', body: input });
      fixture.phase8.casePrioritySnapshots.push(item.priority);
      return json(route, { application: enablementApplicationResponse(application), case: item });
    }
    if (path === '/support/problem-clusters') {
      if (method === 'GET') {
        const q = url.searchParams.get('q')?.toLocaleLowerCase('fa') || '';
        const status = url.searchParams.get('status');
        const items = fixture.phase8.clusters.filter((item) =>
          (!q || `${item.title} ${item.summary || ''}`.toLocaleLowerCase('fa').includes(q))
          && (!status || item.status === status)
        );
        return json(route, {
          items: items.map(clusterListProjection), total: items.length,
          limit: Number(url.searchParams.get('limit') || 50),
          offset: Number(url.searchParams.get('offset') || 0),
        });
      }
      if (method === 'POST') {
        const input = postData(request);
        const created = makeProblemClusterFixture({
          id: `cluster-${fixture.phase8.clusters.length + 1}`,
          title: String(input.title || 'مسئله تازه'),
          summary: typeof input.summary === 'string' ? input.summary : null,
          cases: [],
        });
        fixture.phase8.clusters.unshift(created);
        return json(route, created, 201);
      }
    }
    const clusterCaseMatch = path.match(/^\/support\/problem-clusters\/([^/]+)\/cases\/([^/]+)$/);
    if (clusterCaseMatch) {
      const cluster = fixture.phase8.clusters.find((item) => item.id === decodeURIComponent(clusterCaseMatch[1]));
      const item = scope.cases.find((entry) => entry.id === decodeURIComponent(clusterCaseMatch[2]) || entry.key === decodeURIComponent(clusterCaseMatch[2]));
      if (!cluster || !item) return json(route, { message: 'Support problem cluster or Case not found' }, 404);
      if (method === 'POST') {
        if (!cluster.cases.some((entry) => entry.id === item.id)) cluster.cases.push(clusterCaseProjection(item));
        cluster.version += 1;
        cluster.visibleMemberCount = cluster.cases.length;
        cluster.updatedAt = now;
        return json(route, cluster);
      }
      if (method === 'DELETE') {
        cluster.cases = cluster.cases.filter((entry) => entry.id !== item.id);
        cluster.version += 1;
        cluster.visibleMemberCount = cluster.cases.length;
        cluster.updatedAt = now;
        return route.fulfill({ status: 204 });
      }
    }
    const clusterMatch = path.match(/^\/support\/problem-clusters\/([^/]+)$/);
    if (clusterMatch) {
      const cluster = fixture.phase8.clusters.find((item) => item.id === decodeURIComponent(clusterMatch[1]));
      if (!cluster) return json(route, { message: 'Support problem cluster not found' }, 404);
      if (method === 'GET') return json(route, cluster);
      if (method === 'PATCH') {
        const input = postData(request);
        if (input.baseVersion !== cluster.version) return json(route, { message: 'Support problem cluster changed' }, 409);
        if (typeof input.title === 'string') cluster.title = input.title;
        if (typeof input.summary === 'string' || input.summary === null) cluster.summary = input.summary as string | null;
        if (input.status === 'OPEN' || input.status === 'RESOLVED' || input.status === 'ARCHIVED') cluster.status = input.status;
        cluster.version += 1;
        cluster.updatedAt = now;
        return json(route, cluster);
      }
    }
    if (path === '/support/knowledge/gaps' && method === 'GET') {
      const status = url.searchParams.get('status');
      const items = fixture.phase8.knowledgeGaps.filter((item) => !status || item.status === status);
      return json(route, {
        items, visibleCount: items.length,
        limit: Number(url.searchParams.get('limit') || 50),
        offset: Number(url.searchParams.get('offset') || 0),
      });
    }
    const knowledgeGapMatch = path.match(/^\/support\/knowledge\/gaps\/([^/]+)$/);
    if (knowledgeGapMatch && method === 'PATCH') {
      const gap = fixture.phase8.knowledgeGaps.find((item) => item.id === decodeURIComponent(knowledgeGapMatch[1]));
      const input = postData(request);
      if (!gap) return json(route, { message: 'Support knowledge gap not found' }, 404);
      if (input.baseVersion !== gap.version) return json(route, { message: 'Support knowledge gap changed' }, 409);
      if (input.status === 'OPEN' || input.status === 'IN_REVIEW' || input.status === 'RESOLVED') {
        gap.status = input.status;
        gap.resolvedAt = input.status === 'RESOLVED' ? now : null;
      }
      if (typeof input.reviewOwnerId === 'string' || input.reviewOwnerId === null) gap.reviewOwnerId = input.reviewOwnerId as string | null;
      gap.version += 1;
      gap.updatedAt = now;
      fixture.phase8.knowledgeGapUpdateRequests.push(input);
      return json(route, gap);
    }
    if (path === '/support/quality/rubrics') {
      if (method === 'GET') return json(route, { items: fixture.phase8.rubrics });
      if (method === 'POST') {
        const input = postData(request);
        const rubricKey = String(input.rubricKey || 'quality');
        const created = makeQualityRubricFixture({
          id: `rubric-${fixture.phase8.rubrics.length + 1}`,
          rubricKey,
          name: String(input.name || 'معیار کیفیت'),
          version: Math.max(0, ...fixture.phase8.rubrics.filter((item) => item.rubricKey === rubricKey).map((item) => item.version)) + 1,
          criteria: Array.isArray(input.criteria) ? input.criteria.map(asRecord) : [],
        });
        fixture.phase8.rubrics.unshift(created);
        return json(route, created, 201);
      }
    }
    if (path === '/support/quality/reviews') {
      if (method === 'GET') return json(route, { items: fixture.phase8.reviews });
      if (method === 'POST') {
        const input = postData(request);
        const item = scope.cases.find((entry) => entry.id === input.caseId);
        const rubric = fixture.phase8.rubrics.find((entry) => entry.id === input.rubricId);
        if (!item || !rubric) return json(route, { message: 'Support Case or rubric not found' }, 404);
        const created = makeQualityReviewFixture(item, rubric, {
          id: `review-${fixture.phase8.reviews.length + 1}`,
          sampleReason: String(input.sampleReason || ''),
          findings: Array.isArray(input.findings) ? input.findings.map(asRecord) : [],
        });
        fixture.phase8.reviews.unshift(created);
        return json(route, created, 201);
      }
    }
    const assistanceDecisionMatch = path.match(/^\/support\/assistance\/([^/]+)\/decide$/);
    if (assistanceDecisionMatch && method === 'POST') {
      const suggestion = fixture.phase8.suggestions.find((item) => item.id === decodeURIComponent(assistanceDecisionMatch[1]));
      const input = postData(request);
      if (!suggestion) return json(route, { message: 'Support suggestion not found' }, 404);
      const item = scope.cases.find((entry) => entry.id === suggestion.caseId);
      if (!item) return json(route, { message: 'Support Case not found' }, 404);
      if (input.decision === 'ACCEPTED' && input.baseVersion !== item.version) {
        return json(route, { message: 'Support Case changed on another client' }, 409);
      }
      fixture.phase8.assistanceDecisionRequests.push(input);
      suggestion.decision = input.decision === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED';
      suggestion.decisionReason = String(input.reason || '');
      suggestion.decidedAt = now;
      if (suggestion.decision === 'ACCEPTED') {
        item.typeKey = suggestion.payload.typeKey;
        mutateCase(item, 'case.assistance_suggestion_accepted');
        suggestion.decisionCaseVersion = item.version;
      }
      return json(route, suggestion);
    }
    if (path === '/support/routing/policies') {
      if (method === 'GET') return json(route, { items: fixture.phase7.policies });
      if (method === 'POST') {
        const input = postData(request);
        options.routingPolicyRequests?.push(input);
        const created = makeRoutingPolicyFixture({
          id: `routing-policy-${fixture.phase7.policies.length + 1}`,
          version: Math.max(0, ...fixture.phase7.policies.map((policy) => policy.version)) + 1,
          label: typeof input.label === 'string' ? input.label : null,
          active: input.activate === true,
          rules: Array.isArray(input.rules) ? input.rules.map((value, index) => routingRuleFromInput(asRecord(value), index)) : [],
        });
        if (created.active) fixture.phase7.policies.forEach((policy) => { policy.active = false; });
        fixture.phase7.policies.unshift(created);
        return json(route, created, 201);
      }
    }
    const routingPolicyActivate = path.match(/^\/support\/routing\/policies\/([^/]+)\/activate$/);
    if (routingPolicyActivate && method === 'POST') {
      const id = decodeURIComponent(routingPolicyActivate[1]);
      const policy = fixture.phase7.policies.find((item) => item.id === id);
      if (!policy) return json(route, { message: 'Support routing policy not found' }, 404);
      fixture.phase7.policies.forEach((item) => { item.active = item.id === id; });
      policy.activatedAt = now;
      return json(route, policy);
    }
    const routingMembersMatch = path.match(/^\/support\/routing\/departments\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (routingMembersMatch) {
      const requestedDepartmentId = decodeURIComponent(routingMembersMatch[1]);
      if (method === 'GET' && !routingMembersMatch[2]) {
        return json(route, {
          departmentId: requestedDepartmentId,
          items: fixture.phase7.routingMembers.filter((member) => member.departmentId === requestedDepartmentId),
        });
      }
      if (method === 'PATCH' && routingMembersMatch[2]) {
        const userId = decodeURIComponent(routingMembersMatch[2]);
        const member = fixture.phase7.routingMembers.find((item) => item.departmentId === requestedDepartmentId && item.userId === userId);
        if (!member) return json(route, { message: 'Department member not found' }, 404);
        const input = postData(request);
        options.routingMemberRequests?.push(input);
        Object.assign(member, input, {
          availableSlots: Math.max(0, Number(input.routingCapacity ?? member.routingCapacity) - member.activeCaseLoad),
          updatedAt: now,
        });
        return json(route, member);
      }
    }
    if (path === '/support/saved-views') {
      if (method === 'GET') return json(route, { items: fixture.phase7.savedQueues, accessEpoch: scope.epoch });
      if (method === 'POST') {
        const input = postData(request);
        options.savedQueueRequests?.push(input);
        const created = makeSavedQueueFixture({
          id: `saved-view-${fixture.phase7.savedQueues.length + 1}`,
          ownerId: actor.id,
          input,
        });
        fixture.phase7.savedQueues.unshift(created);
        return json(route, created, 201);
      }
    }
    const savedViewMatch = path.match(/^\/support\/saved-views\/([^/]+)(?:\/(cases))?$/);
    if (savedViewMatch) {
      const id = decodeURIComponent(savedViewMatch[1]);
      const savedView = fixture.phase7.savedQueues.find((item) => item.id === id);
      if (!savedView) return json(route, { message: 'Support saved view not found' }, 404);
      if (savedViewMatch[2] === 'cases' && method === 'GET') {
        let items = visibleCases(scope.cases, actorKind);
        if (savedView.filters.queue) items = items.filter((item) => inQueue(item, savedView.filters.queue || '', actorKind));
        return json(route, { savedView, items, total: items.length, nextCursor: null, accessEpoch: scope.epoch });
      }
      if (!savedViewMatch[2] && method === 'PATCH') {
        const input = postData(request);
        Object.assign(savedView, input, { version: savedView.version + 1, updatedAt: now });
        return json(route, savedView);
      }
      if (!savedViewMatch[2] && method === 'DELETE') {
        fixture.phase7.savedQueues = fixture.phase7.savedQueues.filter((item) => item.id !== id);
        return route.fulfill({ status: 204 });
      }
    }
    if (path === '/support/config/calendars') {
      if (method === 'GET') return json(route, { items: fixture.operations.calendars });
      if (method === 'POST') {
        const input = postData(request);
        options.calendarRequests?.push(input);
        const created = makeCalendarFixture({
          id: `calendar-created-${fixture.operations.calendars.length + 1}`,
          name: String(input.name),
          timezone: String(input.timezone),
          departmentId: typeof input.departmentId === 'string' ? input.departmentId : null,
          periods: Array.isArray(input.periods) ? input.periods as FixtureCalendar['periods'] : [],
        });
        fixture.operations.calendars.unshift(created);
        return json(route, created, 201);
      }
    }
    const calendarMatch = path.match(/^\/support\/config\/calendars\/([^/]+)$/);
    if (calendarMatch && method === 'PATCH') {
      const id = decodeURIComponent(calendarMatch[1]);
      const calendar = fixture.operations.calendars.find((item) => item.id === id);
      if (!calendar) return json(route, { message: 'Calendar not found' }, 404);
      const input = postData(request);
      Object.assign(calendar, input, {
        department: typeof input.departmentId === 'string' ? { id: department.id, name: department.name, slug: department.slug } : calendar.department,
        updatedAt: now,
      });
      return json(route, calendar);
    }
    if (path === '/support/config/sla-policies') {
      if (method === 'GET') return json(route, { items: fixture.operations.policies });
      if (method === 'POST') {
        const input = postData(request);
        options.slaRequests?.push(input);
        const created = makePolicyFixture({
          id: `policy-created-${fixture.operations.policies.length + 1}`,
          policyKey: String(input.policyKey),
          name: String(input.name),
          version: Math.max(0, ...fixture.operations.policies.filter((item) => item.policyKey === input.policyKey).map((item) => item.version)) + 1,
          calendarId: String(input.calendarId),
          input,
        });
        fixture.operations.policies.unshift(created);
        return json(route, created, 201);
      }
    }
    const policyDeactivateMatch = path.match(/^\/support\/config\/sla-policies\/([^/]+)\/deactivate$/);
    if (policyDeactivateMatch && method === 'POST') {
      const id = decodeURIComponent(policyDeactivateMatch[1]);
      const policy = fixture.operations.policies.find((item) => item.id === id);
      if (!policy) return json(route, { message: 'SLA policy not found' }, 404);
      policy.active = false;
      policy.effectiveUntil = now;
      return json(route, policy);
    }
    if (path === '/support/intake-admin/health' && method === 'GET') {
      return json(route, makeIntakeHealthFixture(fixture.operations.deadLetters.length));
    }
    if (path === '/support/intake-admin/dead-letters' && method === 'GET') {
      const connectorId = url.searchParams.get('connectorId');
      return json(route, {
        items: fixture.operations.deadLetters.filter((item) => !connectorId || item.connector.id === connectorId),
        nextCursor: null,
      });
    }
    const deadLetterMatch = path.match(/^\/support\/intake-admin\/dead-letters\/([^/]+)(?:\/(retry))?$/);
    if (deadLetterMatch) {
      const receiptId = decodeURIComponent(deadLetterMatch[1]);
      const item = fixture.operations.deadLetters.find((entry) => entry.receiptId === receiptId);
      if (!item) return json(route, { message: 'Dead letter not found' }, 404);
      if (!deadLetterMatch[2] && method === 'GET') return json(route, item);
      if (deadLetterMatch[2] === 'retry' && method === 'POST') {
        options.retryRequests?.push(receiptId);
        fixture.operations.deadLetters = fixture.operations.deadLetters.filter((entry) => entry.receiptId !== receiptId);
        return json(route, { receiptId, status: 'RETRY_PENDING', scheduledAt: now }, 202);
      }
    }
    if (path === '/support/reports/overview' && method === 'GET') {
      return json(route, makeReportFixture(actorKind));
    }
    if (path === '/support/search') {
      const q = url.searchParams.get('q')?.toLocaleLowerCase('fa') || '';
      return json(route, {
        cases: visibleCases(scope.cases, actorKind).filter((item) => `${item.key} ${item.title} ${item.contact?.name || ''}`.toLocaleLowerCase('fa').includes(q)),
        contacts: [],
        accessEpoch: scope.epoch,
      });
    }
    if (path === '/support/cases' && method === 'GET') {
      if (scope.revoked) return json(route, { items: [], total: 0, counts: {}, accessEpoch: scope.epoch });
      const queue = url.searchParams.get('queue') || '';
      const q = url.searchParams.get('q')?.toLocaleLowerCase('fa') || '';
      let items = visibleCases(scope.cases, actorKind).filter((item) => inQueue(item, queue, actorKind));
      if (q) items = items.filter((item) => `${item.key} ${item.title} ${item.contact?.name || ''}`.toLocaleLowerCase('fa').includes(q));
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const limit = Number(url.searchParams.get('limit') || 50);
      return json(route, {
        items: items.slice(cursor, cursor + limit),
        total: items.length,
        nextCursor: cursor + limit < items.length ? String(cursor + limit) : null,
        counts: queueCounts(visibleCases(scope.cases, actorKind), actorKind),
        accessEpoch: scope.epoch,
      });
    }
    if (path === '/support/cases' && method === 'POST') {
      const input = postData(request);
      const item = makeCase({
        id: `case-${scope.cases.length + 1}`,
        key: `SUP-${scope.cases.length + 1}`,
        title: String(input.title),
        description: typeof input.description === 'string' ? input.description : null,
        departmentId: typeof input.departmentId === 'string' ? input.departmentId : null,
        contactName: contactField(input, 'name'),
        contactPhone: contactField(input, 'phone'),
      });
      scope.cases.push(item);
      return json(route, { case: item, accessEpoch: scope.epoch });
    }
    if (path === '/support/calls' && method === 'POST') {
      const input = postData(request);
      options.callRequests?.push(input);
      let item = scope.cases.find((entry) => entry.id === input.caseId);
      if (item && input.baseVersion !== item.version) {
        return json(route, { message: 'Support Case changed; refresh and retry' }, 409);
      }
      if (!item) {
        const newCase = asRecord(input.newCase);
        item = makeCase({
          id: `case-${scope.cases.length + 1}`,
          key: `SUP-${scope.cases.length + 1}`,
          title: String(newCase.title),
          description: typeof newCase.description === 'string' ? newCase.description : null,
          sourceChannel: 'CALL',
          departmentId: typeof newCase.departmentId === 'string' ? newCase.departmentId : null,
          contactName: contactField(newCase, 'name'),
          contactPhone: contactField(newCase, 'phone'),
        });
        scope.cases.push(item);
      }
      item.version += 1;
      item.updatedAt = now;
      const interaction = makeInteraction(item, 'CALL', String(input.summary || ''), input.call);
      item.interactions.push(interaction);
      return json(route, { case: item, interaction, accessEpoch: scope.epoch, createdNewCase: Boolean(input.newCase) });
    }

    const targetTasksMatch = path.match(/^\/support\/department-work-targets\/([^/]+)\/tasks$/);
    if (targetTasksMatch && method === 'GET') {
      const targetId = decodeURIComponent(targetTasksMatch[1]);
      if (!fixture.handoff?.targets.some((target) => target.workTargetId === targetId)) {
        return json(route, { message: 'Active Department work target not found' }, 404);
      }
      const query = url.searchParams.get('q')?.toLocaleLowerCase('fa') || '';
      const items = fixture.handoff.taskOptions.filter((task) =>
        `${task.key} ${task.title}`.toLocaleLowerCase('fa').includes(query)
      );
      return json(route, { items });
    }

    const caseMatch = path.match(/^\/support\/cases\/([^/]+)(?:\/(.*))?$/);
    if (caseMatch) {
      const idOrKey = decodeURIComponent(caseMatch[1]);
      const command = caseMatch[2];
      const item = scope.cases.find((entry) => entry.id === idOrKey || entry.key === idOrKey);
      if (!item || !visibleCases(scope.cases, actorKind).some((entry) => entry.id === item.id)) {
        return json(route, { message: 'Support Case not found' }, 404);
      }
      if (command === 'assistance' && method === 'GET') {
        return json(route, {
          items: fixture.phase8.suggestions.filter((suggestion) => suggestion.caseId === item.id),
          accessEpoch: scope.epoch,
        });
      }
      if (command === 'csat' && method === 'GET') {
        return json(route, {
          items: fixture.phase8.csatInvitations.filter((invitation) => invitation.caseId === item.id),
        });
      }
      if (command === 'csat/invitations' && method === 'POST') {
        const input = postData(request);
        fixture.phase8.csatInvitationRequests.push(input);
        const invitation = makeCsatInvitationFixture({
          id: `csat-${fixture.phase8.csatInvitations.length + 1}`,
          caseId: item.id,
          scaleMin: Number(input.scaleMin || 1),
          scaleMax: Number(input.scaleMax || 5),
          response: null,
        });
        fixture.phase8.csatInvitations.unshift(invitation);
        return json(route, {
          id: invitation.id,
          scaleMin: invitation.scaleMin,
          scaleMax: invitation.scaleMax,
          expiresAt: invitation.expiresAt,
          createdAt: invitation.createdAt,
          token: fixture.phase8.csatToken,
        }, 201);
      }
      const enablementMatch = command?.match(/^enablement\/([^/]+)\/(preview|apply)$/);
      if (enablementMatch && method === 'POST') {
        const definition = fixture.phase8.definitions.find((entry) => entry.id === decodeURIComponent(enablementMatch[1]));
        const action = enablementMatch[2] as 'preview' | 'apply';
        const input = postData(request);
        if (!definition || definition.status !== 'APPROVED') {
          return json(route, { message: 'Approved Support enablement definition not found' }, 404);
        }
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        const preview = enablementPreviewFixture(item, definition, fixture.phase8.previewHash);
        fixture.phase8.enablementRequests.push({ action, body: input });
        if (action === 'preview') return json(route, preview);
        if (input.previewHash !== fixture.phase8.previewHash) return json(route, { message: 'Support enablement preview changed' }, 409);
        const beforeVersion = item.version;
        const previousPriority = item.priority;
        item.priority = enablementPriority(definition) || item.priority;
        mutateCase(item, 'case.enablement_applied');
        const application: FixtureEnablementApplication = {
          id: `application-${fixture.phase8.applications.length + 1}`,
          definitionId: definition.id,
          caseId: item.id,
          caseVersionBefore: beforeVersion,
          caseVersionAfter: item.version,
          previewHash: fixture.phase8.previewHash,
          appliedAt: now,
          undoneAt: null,
          undoCaseVersion: null,
          previousPriority,
        };
        fixture.phase8.applications.push(application);
        fixture.phase8.casePrioritySnapshots.push(item.priority);
        return json(route, { application: enablementApplicationResponse(application), case: item });
      }
      if (command === 'automation-evaluations' && method === 'POST') {
        const input = postData(request);
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        const definitions = fixture.phase8.definitions.filter((entry) => entry.kind === 'AUTOMATION' && entry.status === 'APPROVED');
        fixture.phase8.enablementRequests.push({ action: 'evaluate', body: input });
        return json(route, {
          items: definitions.map((definition) => enablementPreviewFixture(item, definition, fixture.phase8.previewHash)),
          matchedCount: definitions.length,
          requiresHumanApply: true,
          caseVersion: item.version,
        });
      }
      if (command === 'knowledge/search' && method === 'GET') {
        const q = url.searchParams.get('q')?.toLocaleLowerCase('fa') || '';
        const results = fixture.phase8.knowledgePages.filter((entry) =>
          `${entry.title} ${entry.summary || ''}`.toLocaleLowerCase('fa').includes(q)
        );
        return json(route, {
          items: results,
          total: results.length,
          limit: Number(url.searchParams.get('limit') || 20),
          offset: Number(url.searchParams.get('offset') || 0),
          case: { id: item.id, key: item.key, version: item.version, title: fixture.phase8.peerPrivateValue },
          accessDoesNotTransfer: true,
        });
      }
      if (command === 'knowledge/uses' && method === 'GET') {
        const items = fixture.phase8.knowledgeUses.filter((entry) => entry.caseId === item.id);
        return json(route, { items, visibleCount: items.length });
      }
      if (command === 'knowledge/uses' && method === 'POST') {
        const input = postData(request);
        const pageItem = fixture.phase8.knowledgePages.find((entry) => entry.id === input.pageId);
        if (!pageItem) return json(route, { message: 'Knowledge page not found' }, 404);
        if (input.caseBaseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        fixture.phase8.knowledgeUseRequests.push(input);
        const use = makeKnowledgeUseFixture(item, pageItem, {
          id: `knowledge-use-${fixture.phase8.knowledgeUses.length + 1}`,
          usefulness: input.usefulness === 'PARTIAL' || input.usefulness === 'NOT_HELPFUL' ? input.usefulness : 'HELPFUL',
          outcome: input.outcome === 'RESOLVED' || input.outcome === 'NO_EFFECT' ? input.outcome : 'ADVANCED',
        });
        fixture.phase8.knowledgeUses.unshift(use);
        return json(route, use, 201);
      }
      if (command === 'knowledge/gaps' && method === 'POST') {
        const input = postData(request);
        if (input.caseBaseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        const pageItem = typeof input.pageId === 'string'
          ? fixture.phase8.knowledgePages.find((entry) => entry.id === input.pageId) || null
          : null;
        fixture.phase8.knowledgeGapRequests.push(input);
        const gap = makeKnowledgeGapFixture(item, pageItem, {
          id: `knowledge-gap-${fixture.phase8.knowledgeGaps.length + 1}`,
          kind: input.kind === 'WRONG' ? 'WRONG' : 'MISSING',
          feedback: String(input.feedback || ''),
          status: 'OPEN',
          reviewOwnerId: null,
        });
        fixture.phase8.knowledgeGaps.unshift(gap);
        return json(route, gap, 201);
      }
      if (command === 'presence') {
        if (method === 'DELETE') return route.fulfill({ status: 204 });
        const input = method === 'POST' ? postData(request) : {};
        const collision = {
          hasConcurrentEditor: Boolean(options.presenceCollision),
          hasVersionSkew: false,
          readers: options.presenceCollision ? [{
            user: { id: users.manager.id, name: users.manager.name, avatarUrl: users.manager.avatarUrl },
            clientId: 'other-tab-client', intent: 'EDITING', caseVersion: item.version,
            staleVersion: false, expiresAt: '2026-08-23T10:00:45.000Z',
          }] : [],
        };
        return json(route, {
          caseId: item.id, caseVersion: item.version,
          ...(method === 'POST' ? { expiresAt: '2026-08-23T10:00:45.000Z' } : {}),
          collision,
          receivedIntent: input.intent,
        });
      }
      if (command === 'routing/simulate' && method === 'POST') {
        const activePolicy = fixture.phase7.policies.find((policy) => policy.active) || null;
        const rule = activePolicy?.rules.find((candidate) => candidate.enabled) || null;
        const routingMember = fixture.phase7.routingMembers.find((member) =>
          member.departmentId === rule?.action.targetDepartmentId
          && member.active
          && member.routingAvailability === 'AVAILABLE'
          && member.activeCaseLoad < member.routingCapacity
        );
        return json(route, routingDecisionFixture(item, activePolicy, rule, routingMember));
      }
      if (command === 'routing/apply' && method === 'POST') {
        const input = postData(request);
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        const activePolicy = fixture.phase7.policies.find((policy) => policy.active) || null;
        const rule = activePolicy?.rules.find((candidate) => candidate.enabled) || null;
        if (!activePolicy || !rule) return json(route, { ...routingDecisionFixture(item, activePolicy, rule), applied: true, caseVersion: item.version });
        const routingMember = fixture.phase7.routingMembers.find((member) =>
          member.departmentId === rule.action.targetDepartmentId
          && member.active
          && member.routingAvailability === 'AVAILABLE'
          && member.activeCaseLoad < member.routingCapacity
        );
        item.departmentId = department.id;
        item.department = department;
        item.assigneeMembershipId = routingMember?.membershipId || null;
        item.assignee = departmentMembers.find((member) => member.id === item.assigneeMembershipId) || null;
        item.assigneeMembership = item.assignee;
        item.status = 'OPEN';
        mutateCase(item, 'case.routing_confirmed');
        return json(route, {
          outcome: 'ROUTED', applied: true,
          case: { id: item.id, key: item.key, version: item.version, status: item.status, departmentId: item.departmentId, assigneeMembershipId: item.assigneeMembershipId },
          policy: { id: activePolicy.id, version: activePolicy.version },
          matchedRule: { id: rule.id, order: rule.order, name: rule.name },
          assignment: routingAssignmentFixture(routingMember),
          decisionFingerprint: 'fixture-decision-fingerprint',
          prioritySuggestion: prioritySuggestionFixture(item), accessEpoch: scope.epoch,
        });
      }
      if (command === 'routing/priority' && method === 'POST') {
        const input = postData(request);
        options.priorityRequests?.push(input);
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        const suggestion = suggestedPriorityFixture(item.impact, item.urgency);
        item.priority = input.decision === 'ACCEPT_SUGGESTION'
          ? suggestion || item.priority
          : String(input.priority) as FixtureCase['priority'];
        mutateCase(item, input.decision === 'ACCEPT_SUGGESTION' ? 'case.priority_suggestion_accepted' : 'case.priority_suggestion_overridden');
        return json(route, {
          case: item,
          priorityDecision: { decision: input.decision, suggestion, appliedPriority: item.priority },
        });
      }
      if (!command && method === 'GET') return json(route, item);
      if (command === 'interactions' && method === 'GET') return json(route, { items: item.interactions, total: item.interactions.length, accessEpoch: scope.epoch });
      if (command === 'events' && method === 'GET') return json(route, { items: item.events, total: item.events.length, accessEpoch: scope.epoch });
      if (command === 'handoff-options' && method === 'GET') {
        return json(route, {
          items: fixture.handoff?.targets || [],
          caseVersion: item.version,
          accessEpoch: scope.epoch,
        });
      }
      if (command === 'task-links' && method === 'GET') {
        return json(route, {
          items: fixture.handoff?.links || [],
          caseVersion: item.version,
          accessEpoch: scope.epoch,
        });
      }
      if (command === 'task-links' && method === 'POST' && fixture.handoff) {
        const input = postData(request);
        fixture.handoff.linkRequests.push(input);
        const task = fixture.handoff.taskOptions.find((candidate) => candidate.id === input.taskId);
        if (!task) return json(route, { message: 'Task not found' }, 404);
        const link = makeHandoffLink({
          linkId: `link-existing-${fixture.handoff.links.length + 1}`,
          taskKey: task.key,
          title: task.title,
          status: task.status,
        });
        fixture.handoff.links.unshift(link);
        mutateCase(item, 'case.task_linked');
        return json(route, { link, replayed: false, caseVersion: item.version, accessEpoch: scope.epoch }, 201);
      }
      if (command === 'team-tasks' && method === 'POST' && fixture.handoff) {
        const input = postData(request);
        fixture.handoff.createRequests.push(input);
        const link = makeHandoffLink({
          linkId: `link-created-${fixture.handoff.links.length + 1}`,
          taskKey: `CORE-${fixture.handoff.nextTaskSequence++}`,
          title: String(input.taskTitle),
          status: 'TODO',
        });
        fixture.handoff.links.unshift(link);
        mutateCase(item, 'case.task_created');
        return json(route, { link, replayed: false, caseVersion: item.version, accessEpoch: scope.epoch }, 201);
      }
      const unlinkMatch = command?.match(/^task-links\/(.+)$/);
      if (unlinkMatch && method === 'DELETE' && fixture.handoff) {
        const linkId = decodeURIComponent(unlinkMatch[1]);
        const link = fixture.handoff.links.find((candidate) => candidate.linkId === linkId);
        if (!link) return json(route, { message: 'Case–Task link not found' }, 404);
        fixture.handoff.unlinkRequests.push(postData(request));
        link.tombstone.unlinkedAt = now;
        mutateCase(item, 'case.task_unlinked');
        return json(route, { link, replayed: false, caseVersion: item.version, accessEpoch: scope.epoch });
      }
      if (command === 'route' && method === 'POST') {
        const input = postData(request);
        item.departmentId = String(input.targetDepartmentId);
        item.department = department;
        item.assigneeMembershipId = typeof input.targetAssigneeMembershipId === 'string' ? input.targetAssigneeMembershipId : null;
        item.assignee = departmentMembers.find((entry) => entry.id === item.assigneeMembershipId) || null;
        item.assigneeMembership = item.assignee;
        item.status = 'OPEN';
        mutateCase(item, item.assigneeMembershipId ? 'case.assigned' : 'case.routed');
        return json(route, { case: item, accessEpoch: scope.epoch });
      }
      if (command === 'interactions' && method === 'POST') {
        const input = postData(request);
        const content = asRecord(input.content);
        const interaction = makeInteraction(item, String(input.kind || 'NOTE'), String(content.body || ''), null);
        item.interactions.push(interaction);
        mutateCase(item, 'case.interaction_recorded');
        return json(route, { case: item, interaction, accessEpoch: scope.epoch });
      }
      if (command === 'wait' && method === 'POST') {
        const input = postData(request);
        item.status = String(input.status) as FixtureCase['status'];
        item.nextActionAt = String(input.nextActionAt);
        mutateCase(item, 'case.waiting');
        return json(route, { case: item, accessEpoch: scope.epoch });
      }
      if (command === 'snooze' && method === 'POST') {
        const input = postData(request);
        options.attentionRequests?.push({ action: 'snooze', body: input });
        if (options.snoozeConflictOnce) {
          options.snoozeConflictOnce = false;
          mutateCase(item, 'case.concurrent_change');
          return json(route, { message: 'Support Case changed on another client', code: 'SUPPORT_VERSION_CONFLICT', current: item }, 409);
        }
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        item.snoozedUntil = String(input.snoozedUntil);
        mutateCase(item, 'case.attention_snoozed');
        return json(route, item);
      }
      if (command === 'resume' && method === 'POST') {
        const input = postData(request);
        options.attentionRequests?.push({ action: 'resume', body: input });
        if (input.baseVersion !== item.version) return json(route, { message: 'Support Case changed on another client' }, 409);
        item.snoozedUntil = null;
        mutateCase(item, 'case.attention_resumed');
        return json(route, item);
      }
      if (command === 'resolve' && method === 'POST') {
        const input = postData(request);
        item.status = 'RESOLVED';
        item.resolutionCode = String(input.resolutionCode) as FixtureCase['resolutionCode'];
        item.resolutionSummary = String(input.resolutionSummary);
        item.resolvedAt = now;
        mutateCase(item, 'case.resolved');
        return json(route, { case: item, accessEpoch: scope.epoch });
      }
      if (command === 'close' && method === 'POST') {
        item.status = 'CLOSED';
        item.closedAt = now;
        mutateCase(item, 'case.closed');
        return json(route, { case: item, accessEpoch: scope.epoch });
      }
      if (command === 'reopen' && method === 'POST') {
        item.status = 'OPEN';
        item.closedAt = null;
        item.resolvedAt = null;
        mutateCase(item, 'case.reopened');
        return json(route, { case: item, accessEpoch: scope.epoch });
      }
    }

    return json(route, {});
  });

  return fixture;
}

function fixtureWorkspace(slug: string, cases: FixtureCase[]): WorkspaceFixture {
  return {
    workspace: { id: `workspace-${slug}`, name: `فضای ${slug}`, slug, mode: 'SUPPORT' },
    cases: cases.map(cloneCase),
    epoch: '1',
    syncCursor: 1,
    syncEvents: [],
  };
}

function supportCursor(scope: WorkspaceFixture): string {
  return `ssc1.${scope.workspace.id}.${scope.epoch}.${scope.syncCursor}`;
}

function meResponse(scope: WorkspaceFixture, actorKind: ActorKind, actor: ReturnType<typeof person>) {
  const revoked = Boolean(scope.revoked);
  const access = supportAccess(actorKind, revoked);
  const permissions = revoked ? [] : actorKind === 'ADMIN'
    ? ['support.setup', 'support.cases.create', 'support.triage.read', 'support.department-inbox.read', 'support.cases.mine.read', 'support.recovery.read', 'support.departments.manage', 'support.reports.read']
    : actorKind === 'MANAGER'
      ? ['support.cases.create', 'support.department-inbox.read', 'support.cases.mine.read', 'support.recovery.read', 'support.reports.read']
      : ['support.cases.mine.read', 'support.recovery.read'];
  const visible = visibleCases(scope.cases, actorKind);
  const counts = queueCounts(visible, actorKind);
  return {
    workspace: scope.workspace,
    user: actor,
    role: actorKind === 'ADMIN' ? 'ADMIN' : 'MEMBER',
    unreadNotifications: 0,
    capabilities: ['common.members', 'common.settings', 'common.inbox', 'common.knowledge', 'support.cases', 'support.departments', 'support.triage', 'support.recovery', 'support.reports'],
    permissions,
    supportAccessEpoch: scope.epoch,
    support: {
      needsSetup: false,
      interactionContentAvailable: true,
      manualCallAvailable: true,
      unassignedCount: counts.triage,
      departmentInboxCount: counts.departmentInbox,
      myCaseCount: counts.myCases,
      needsAttentionCount: counts.needsAttention,
    },
    supportAccess: access,
  };
}

function supportBootstrap(scope: WorkspaceFixture, actorKind: ActorKind, cases: FixtureCase[]) {
  const access = supportAccess(actorKind, Boolean(scope.revoked));
  return {
    cases,
    departments: scope.revoked ? [] : [department],
    departmentMemberships: scope.revoked ? [] : departmentMembers,
    grants: [],
    counts: queueCounts(cases, actorKind),
    access,
    accessEpoch: scope.epoch,
    cursor: supportCursor(scope),
    support: { interactionContentAvailable: true, manualCallAvailable: true },
  };
}

function supportAccess(actorKind: ActorKind, revoked = false) {
  if (revoked) return { workspaceWide: false, triager: false, supervisor: false, managedDepartmentIds: [], memberMembershipIds: [] };
  if (actorKind === 'ADMIN') return { workspaceWide: true, triager: true, supervisor: false, managedDepartmentIds: [department.id], memberMembershipIds: ['membership-admin'] };
  if (actorKind === 'MANAGER') return { workspaceWide: false, triager: false, supervisor: false, managedDepartmentIds: [department.id], memberMembershipIds: ['membership-manager'] };
  return { workspaceWide: false, triager: false, supervisor: false, managedDepartmentIds: [], memberMembershipIds: ['membership-member'] };
}

function visibleCases(cases: FixtureCase[], actorKind: ActorKind) {
  if (actorKind === 'ADMIN') return cases;
  if (actorKind === 'MANAGER') return cases.filter((item) => item.departmentId === department.id);
  return cases.filter((item) => item.assigneeMembershipId === 'membership-member');
}

function inQueue(item: FixtureCase, queue: string, actorKind: ActorKind) {
  if (queue === 'TRIAGE') return actorKind === 'ADMIN' && !item.departmentId && item.status !== 'CLOSED';
  if (queue === 'DEPARTMENT_INBOX') return actorKind !== 'MEMBER' && item.departmentId === department.id && !item.assigneeMembershipId && item.status !== 'CLOSED';
  if (queue === 'MY_CASES') {
    const membershipId = actorKind === 'ADMIN' ? 'membership-admin' : actorKind === 'MANAGER' ? 'membership-manager' : 'membership-member';
    return item.assigneeMembershipId === membershipId && item.status !== 'CLOSED';
  }
  if (queue === 'NEEDS_ATTENTION') return item.status !== 'CLOSED' && Boolean(item.attentionReasons.length);
  return true;
}

function queueCounts(cases: FixtureCase[], actorKind: ActorKind) {
  return {
    triage: cases.filter((item) => inQueue(item, 'TRIAGE', actorKind)).length,
    departmentInbox: cases.filter((item) => inQueue(item, 'DEPARTMENT_INBOX', actorKind)).length,
    myCases: cases.filter((item) => inQueue(item, 'MY_CASES', actorKind)).length,
    needsAttention: cases.filter((item) => inQueue(item, 'NEEDS_ATTENTION', actorKind)).length,
  };
}

function makeCase(options: {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  sourceChannel?: 'MANUAL' | 'CALL';
  departmentId?: string | null;
  assigneeMembershipId?: string | null;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}) {
  const assignee = departmentMembers.find((item) => item.id === options.assigneeMembershipId) || null;
  return {
    id: options.id,
    key: options.key,
    workspaceId: 'workspace-support',
    sequence: Number(options.key.split('-').at(-1)) || 1,
    title: options.title,
    description: options.description ?? 'شرح نمونه برای پرونده پشتیبانی',
    sourceChannel: options.sourceChannel || 'MANUAL' as const,
    typeKey: 'general',
    priority: 'NORMAL' as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT',
    impact: null as null | 'LOW' | 'MEDIUM' | 'HIGH',
    urgency: null as null | 'LOW' | 'MEDIUM' | 'HIGH',
    status: 'NEW' as 'NEW' | 'OPEN' | 'WAITING_ON_CUSTOMER' | 'WAITING_ON_INTERNAL' | 'RESOLVED' | 'CLOSED',
    waitingReason: null,
    departmentId: options.departmentId ?? null,
    assigneeMembershipId: options.assigneeMembershipId ?? null,
    contactId: options.contactName || options.contactPhone || options.contactEmail ? `contact-${options.id}` : null,
    nextActionAt: null as string | null,
    snoozedUntil: null as string | null,
    nextSlaDueAt: null as string | null,
    resolutionCode: null as null | 'FIXED' | 'ANSWERED' | 'WORKAROUND' | 'DUPLICATE' | 'NO_RESPONSE' | 'NOT_REPRODUCIBLE' | 'REJECTED' | 'WITHDRAWN' | 'SPAM',
    resolutionSummary: null as string | null,
    receivedAt: now,
    lastMeaningfulActivityAt: now,
    resolvedAt: null as string | null,
    closedAt: null as string | null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    department: options.departmentId ? department : null,
    assignee,
    assigneeMembership: assignee,
    contact: options.contactName || options.contactPhone || options.contactEmail
      ? { id: `contact-${options.id}`, workspaceId: 'workspace-support', name: options.contactName || null, phone: options.contactPhone || null, email: options.contactEmail || null }
      : null,
    attentionReasons: [] as string[],
    interactions: [] as Array<Record<string, unknown>>,
    events: [makeEvent(options.id, 'case.created')] as Array<Record<string, unknown>>,
  };
}

function makeHandoffFixture(): FixtureHandoff {
  return {
    targets: [{
      workTargetId: 'work-target-product-core',
      teamWorkspaceName: 'تیم محصول',
      project: { name: 'هسته محصول', keyPrefix: 'CORE', status: 'ACTIVE' },
      allowCreateTasks: true,
      allowLinkTasks: true,
    }],
    taskOptions: [{
      id: 'task-action-existing-77',
      key: 'CORE-77',
      title: 'بررسی موجود تمدید نشست',
      status: 'IN_PROGRESS',
      parentId: null,
    }],
    links: [makeHandoffLink({
      linkId: 'link-deleted-history',
      taskKey: 'CORE-12',
      title: 'کار تاریخی حذف‌شده',
      status: 'CANCELED',
      taskDeletedAt: now,
    })],
    linkRequests: [],
    createRequests: [],
    unlinkRequests: [],
    nextTaskSequence: 91,
  };
}

function makeCalendarFixture(options: {
  id?: string;
  name?: string;
  timezone?: string;
  departmentId?: string | null;
  periods?: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
} = {}) {
  return {
    id: options.id || 'calendar-tehran',
    name: options.name || 'ساعات کاری تهران',
    timezone: options.timezone || 'Asia/Tehran',
    department: options.departmentId ? { id: department.id, name: department.name, slug: department.slug } : null,
    active: true,
    periods: options.periods || [6, 7, 1, 2, 3].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
    holidays: [] as Array<{ date: string; name: string; working: boolean }>,
    createdAt: now,
    updatedAt: now,
  };
}

function makePolicyFixture(options: {
  id?: string;
  policyKey?: string;
  name?: string;
  version?: number;
  calendarId?: string;
  input?: Record<string, unknown>;
} = {}) {
  const input = options.input || {};
  const calendar = makeCalendarFixture({ id: options.calendarId || 'calendar-tehran' });
  return {
    id: options.id || 'policy-standard-v1',
    policyKey: options.policyKey || 'standard-support',
    name: options.name || 'استاندارد پشتیبانی',
    version: options.version || 1,
    priority: typeof input.priority === 'number' ? input.priority : 100,
    active: true,
    calendar: { id: calendar.id, name: calendar.name, timezone: calendar.timezone, active: true },
    conditions: asRecord(input.conditions),
    targets: Object.keys(asRecord(input.targets)).length ? asRecord(input.targets) : { FIRST_RESPONSE: { businessSeconds: 3600, atRiskSeconds: 2700 } },
    pauseRules: Object.keys(asRecord(input.pauseRules)).length ? asRecord(input.pauseRules) : { waitingOnCustomer: [], waitingOnInternal: [], snoozed: [], automatedPublicResponseMeets: [] },
    effectiveFrom: typeof input.effectiveFrom === 'string' ? input.effectiveFrom : now,
    effectiveUntil: typeof input.effectiveUntil === 'string' ? input.effectiveUntil : null as string | null,
    createdAt: now,
  };
}

function makeRoutingPolicyFixture(options: {
  id?: string;
  version?: number;
  label?: string | null;
  active?: boolean;
  rules?: FixtureRoutingRule[];
} = {}): FixtureRoutingPolicy {
  return {
    id: options.id || 'routing-policy-1',
    workspaceId: 'workspace-support',
    version: options.version || 1,
    label: options.label === undefined ? 'مسیریابی پیش‌فرض' : options.label,
    active: options.active ?? true,
    createdById: users.admin.id,
    activatedById: options.active === false ? null : users.admin.id,
    activatedAt: options.active === false ? null : now,
    createdAt: now,
    rules: options.rules || [routingRuleFromInput({
      name: 'قاعده مشتری سازمانی', enabled: true,
      conditions: { caseTypeKeys: [], priorities: [], sourceChannels: [], impacts: [], urgencies: [] },
      action: { targetDepartmentId: department.id, assignmentMode: 'CAPACITY_AWARE', requiredSkills: [] },
    }, 0)],
  };
}

function routingRuleFromInput(input: Record<string, unknown>, index: number): FixtureRoutingRule {
  const conditions = asRecord(input.conditions);
  const action = asRecord(input.action);
  return {
    id: `routing-rule-${Date.now()}-${index + 1}`,
    order: typeof input.order === 'number' ? input.order : index + 1,
    name: typeof input.name === 'string' ? input.name : `قاعده ${index + 1}`,
    enabled: input.enabled !== false,
    conditions: {
      caseTypeKeys: stringArray(conditions.caseTypeKeys),
      priorities: stringArray(conditions.priorities),
      sourceChannels: stringArray(conditions.sourceChannels),
      impacts: stringArray(conditions.impacts),
      urgencies: stringArray(conditions.urgencies),
    },
    action: {
      targetDepartmentId: typeof action.targetDepartmentId === 'string' ? action.targetDepartmentId : department.id,
      assignmentMode: action.assignmentMode === 'CAPACITY_AWARE' ? 'CAPACITY_AWARE' : 'DEPARTMENT_INBOX',
      requiredSkills: stringArray(action.requiredSkills),
    },
    targetDepartment: { ...department },
    createdAt: now,
  };
}

function makeRoutingMemberFixture(member: (typeof departmentMembers)[number], index = 0): FixtureRoutingMember {
  const activeCaseLoad = index % 3;
  return {
    membershipId: member.id,
    workspaceId: member.workspaceId,
    departmentId: member.departmentId,
    userId: member.userId,
    role: member.role,
    active: member.active,
    routingAvailability: 'AVAILABLE',
    routingCapacity: 4,
    routingSkills: index === 0 ? ['enterprise'] : [],
    activeCaseLoad,
    availableSlots: 4 - activeCaseLoad,
    updatedAt: now,
    user: member.user,
  };
}

function makeSavedQueueFixture(options: {
  id: string;
  ownerId: string;
  input: Record<string, unknown>;
}): FixtureSavedQueue {
  const filters = asRecord(options.input.filters);
  const visibility = options.input.visibility === 'DEPARTMENT' || options.input.visibility === 'WORKSPACE'
    ? options.input.visibility
    : 'PRIVATE';
  return {
    id: options.id,
    workspaceId: 'workspace-support',
    ownerId: options.ownerId,
    name: typeof options.input.name === 'string' ? options.input.name : 'صف ذخیره‌شده',
    visibility,
    departmentId: visibility === 'DEPARTMENT' && typeof options.input.departmentId === 'string'
      ? options.input.departmentId
      : null,
    filters: {
      schemaVersion: 1,
      ...(typeof filters.queue === 'string' ? { queue: filters.queue } : {}),
      statuses: stringArray(filters.statuses),
      priorities: stringArray(filters.priorities),
      sourceChannels: stringArray(filters.sourceChannels),
      ...(typeof filters.departmentId === 'string' ? { departmentId: filters.departmentId } : {}),
      ...(typeof filters.typeKey === 'string' ? { typeKey: filters.typeKey } : {}),
      ...(typeof filters.attentionReason === 'string' ? { attentionReason: filters.attentionReason } : {}),
      ...(typeof filters.receivedWithinHours === 'number' ? { receivedWithinHours: filters.receivedWithinHours } : {}),
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function makeEmptyPhase8Fixture(): FixturePhase8 {
  return {
    suggestions: [],
    definitions: [],
    applications: [],
    knowledgePages: [],
    knowledgeUses: [],
    knowledgeGaps: [],
    clusters: [],
    rubrics: [],
    reviews: [],
    csatInvitations: [],
    assistanceDecisionRequests: [],
    definitionLifecycleRequests: [],
    enablementRequests: [],
    casePrioritySnapshots: [],
    knowledgeUseRequests: [],
    knowledgeGapRequests: [],
    knowledgeGapUpdateRequests: [],
    csatInvitationRequests: [],
    previewHash: 'f'.repeat(64),
    csatToken: 'tcsat_phase8_one_time_token',
    privateKnowledgeContent: 'knowledge-private-content',
    peerPrivateValue: 'peer-phase8-private-value',
    initialDefinitionName: 'قاعده استاندارد اولویت پرونده',
  };
}

function makePhase8Fixture(item: FixtureCase): FixturePhase8 {
  const fixture = makeEmptyPhase8Fixture();
  fixture.privateKnowledgeContent = 'متن کامل و خصوصی مقاله که فقط API دانش می‌شناسد';
  fixture.peerPrivateValue = 'peer-phase8-secret-that-must-not-render';
  fixture.csatToken = 'tcsat_phase8_single_view_token_7d1f';
  const definition = makeEnablementDefinitionFixture({
    id: 'definition-priority-v1',
    definitionKey: 'standard-priority',
    version: 1,
    name: fixture.initialDefinitionName,
    description: 'اولویت پرونده را پس از پیش‌نمایش و تأیید انسان افزایش می‌دهد.',
    status: 'APPROVED',
    actions: [{ type: 'SET_PRIORITY', value: 'HIGH' }],
  });
  const knowledgePage = makeKnowledgePageFixture({
    id: 'knowledge-page-session-renewal',
    title: 'راهنمای تمدید نشست سازمانی',
    summary: 'مراحل بررسی و تمدید نشست مشتری سازمانی',
    privateContent: fixture.privateKnowledgeContent,
  });
  const rubric = makeQualityRubricFixture();
  fixture.suggestions = [makeAssistanceSuggestionFixture(item)];
  fixture.definitions = [definition];
  fixture.knowledgePages = [knowledgePage];
  fixture.knowledgeGaps = [makeKnowledgeGapFixture(item, knowledgePage, {
    id: 'knowledge-gap-existing',
    kind: 'WRONG',
    status: 'OPEN',
    feedback: 'مرحله پایانی راهنما با نسخه جاری محصول هم‌خوان نیست.',
    reviewOwnerId: users.manager.id,
  })];
  fixture.clusters = [makeProblemClusterFixture({
    cases: [clusterCaseProjection(item)],
    privateAggregate: fixture.peerPrivateValue,
  })];
  fixture.rubrics = [rubric];
  fixture.reviews = [makeQualityReviewFixture(item, rubric, {
    assignee: users.member,
    privateAggregate: fixture.peerPrivateValue,
  })];
  fixture.csatInvitations = [makeCsatInvitationFixture({ caseId: item.id })];
  return fixture;
}

function makeAssistanceSuggestionFixture(item: FixtureCase, options: {
  id?: string;
  decision?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  typeKey?: string;
} = {}) {
  const decision = options.decision || 'PENDING';
  return {
    id: options.id || 'suggestion-case-type',
    caseId: item.id,
    kind: 'TYPE' as const,
    payload: { typeKey: options.typeKey || 'incident' },
    provenance: {
      provider: 'rules', modelOrRule: 'case-type', version: '4', confidence: 0.93,
      contextDigest: 'a'.repeat(64), privateContext: 'must-not-render',
    },
    decision,
    decisionReason: null as string | null,
    decisionCaseVersion: null as number | null,
    decidedAt: null as string | null,
    expiresAt: null as string | null,
    createdAt: now,
    privateContext: 'must-not-render',
  };
}

function makeEnablementDefinitionFixture(options: {
  id?: string;
  kind?: 'MACRO' | 'TEMPLATE' | 'AUTOMATION';
  definitionKey?: string;
  version?: number;
  name?: string;
  description?: string | null;
  status?: 'DRAFT' | 'APPROVED' | 'RETIRED';
  actions?: Array<Record<string, unknown>>;
  conditions?: Array<Record<string, unknown>> | null;
} = {}) {
  const status = options.status || 'APPROVED';
  return {
    id: options.id || 'definition-priority-v1',
    kind: options.kind || 'MACRO',
    definitionKey: options.definitionKey || 'standard-priority',
    version: options.version || 1,
    name: options.name || 'اولویت‌دهی استاندارد',
    description: options.description === undefined ? null : options.description,
    status,
    conditions: options.conditions === undefined ? null : options.conditions,
    actions: options.actions || [{ type: 'SET_PRIORITY', value: 'HIGH' }],
    createdById: users.admin.id,
    approvedById: status === 'APPROVED' ? users.admin.id : null as string | null,
    approvedAt: status === 'APPROVED' ? now : null as string | null,
    retiredById: status === 'RETIRED' ? users.admin.id : null as string | null,
    retiredAt: status === 'RETIRED' ? now : null as string | null,
    createdAt: now,
  };
}

function makeKnowledgePageFixture(options: {
  id?: string;
  title?: string;
  summary?: string | null;
  privateContent?: string;
} = {}) {
  const privateContent = options.privateContent || 'private-knowledge-body';
  return {
    id: options.id || 'knowledge-page-session-renewal',
    title: options.title || 'راهنمای تمدید نشست سازمانی',
    path: 'support/session-renewal',
    summary: options.summary === undefined ? 'مراحل بررسی و تمدید نشست' : options.summary,
    status: 'PUBLISHED' as const,
    version: 7,
    updatedAt: now,
    content: { children: [privateContent] },
    contentText: privateContent,
    owner: { email: 'knowledge-owner-private@example.com' },
  };
}

function makeKnowledgeUseFixture(item: FixtureCase, page: FixtureKnowledgePage, options: {
  id?: string;
  usefulness?: 'HELPFUL' | 'PARTIAL' | 'NOT_HELPFUL';
  outcome?: 'RESOLVED' | 'ADVANCED' | 'NO_EFFECT';
} = {}) {
  return {
    id: options.id || 'knowledge-use-existing',
    caseId: item.id,
    knowledgePageId: page.id,
    caseVersion: item.version,
    knowledgePageVersion: page.version,
    usefulness: options.usefulness || 'HELPFUL',
    outcome: options.outcome || 'ADVANCED',
    createdById: users.admin.id,
    createdAt: now,
    page: { id: page.id, title: page.title, version: page.version, status: page.status },
  };
}

function makeKnowledgeGapFixture(item: FixtureCase, page: FixtureKnowledgePage | null, options: {
  id?: string;
  kind?: 'MISSING' | 'WRONG';
  status?: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
  feedback?: string;
  reviewOwnerId?: string | null;
} = {}) {
  const kind = options.kind || (page ? 'WRONG' : 'MISSING');
  const status = options.status || 'OPEN';
  return {
    id: options.id || 'knowledge-gap-existing',
    caseId: item.id,
    knowledgePageId: page?.id || null,
    kind,
    status,
    feedback: options.feedback || 'راهنمای مناسب برای این مسئله پیدا نشد.',
    reviewOwnerId: options.reviewOwnerId === undefined ? users.manager.id : options.reviewOwnerId,
    createdById: users.member.id,
    resolvedAt: status === 'RESOLVED' ? now : null as string | null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    case: { id: item.id, key: item.key, title: item.title, version: item.version, description: 'private-case-copy' },
    page: page ? { id: page.id, title: page.title, version: page.version, status: page.status, content: 'private-page-copy' } : null,
  };
}

function clusterCaseProjection(item: FixtureCase) {
  return {
    id: item.id,
    key: item.key,
    title: item.title,
    status: item.status,
    priority: item.priority,
    departmentId: item.departmentId,
    assigneeMembershipId: item.assigneeMembershipId,
    version: item.version,
    updatedAt: item.updatedAt,
    linkedAt: now,
    contact: item.contact,
    description: item.description,
  };
}

function makeProblemClusterFixture(options: {
  id?: string;
  title?: string;
  summary?: string | null;
  status?: 'OPEN' | 'RESOLVED' | 'ARCHIVED';
  cases?: Array<ReturnType<typeof clusterCaseProjection>>;
  privateAggregate?: string;
} = {}) {
  const cases = options.cases || [];
  return {
    id: options.id || 'cluster-enterprise-login',
    title: options.title || 'اختلال پرتکرار ورود سازمانی',
    summary: options.summary === undefined ? 'الگوی پاک‌سازی‌شده خطای ورود پس از تمدید نشست' : options.summary,
    status: options.status || 'OPEN',
    version: 1,
    createdById: users.manager.id,
    createdAt: now,
    updatedAt: now,
    visibleMemberCount: cases.length,
    accessEpoch: '1',
    cases,
    unrestrictedMemberCount: 99,
    privateAggregate: options.privateAggregate || 'peer-private-cluster-aggregate',
  };
}

function clusterListProjection(cluster: FixtureProblemCluster) {
  const { cases: _cases, ...projection } = cluster;
  return projection;
}

function makeQualityRubricFixture(options: {
  id?: string;
  rubricKey?: string;
  name?: string;
  version?: number;
  criteria?: Array<Record<string, unknown>>;
} = {}) {
  return {
    id: options.id || 'rubric-standard-v1',
    rubricKey: options.rubricKey || 'standard',
    name: options.name || 'استاندارد کیفیت پاسخ‌گویی',
    version: options.version || 1,
    criteria: options.criteria || [
      { key: 'accuracy', label: 'دقت پاسخ', maxScore: 5, weight: 60 },
      { key: 'follow_up', label: 'کیفیت پیگیری', maxScore: 5, weight: 40 },
    ],
    createdById: users.admin.id,
    createdAt: now,
  };
}

function makeQualityReviewFixture(item: FixtureCase, rubric: FixtureQualityRubric, options: {
  id?: string;
  sampleReason?: string;
  score?: number;
  findings?: Array<Record<string, unknown>>;
  assignee?: ReturnType<typeof person>;
  privateAggregate?: string;
} = {}) {
  const assignee = options.assignee || item.assignee?.user || users.member;
  const findings = options.findings?.length ? options.findings : [
    { criterionKey: 'accuracy', score: 5, finding: 'پاسخ دقیق و قابل پیگیری بود.' },
    { criterionKey: 'follow_up', score: 3, finding: 'پیگیری در موعد انجام شد.' },
  ];
  return {
    id: options.id || 'quality-review-visible',
    caseId: item.id,
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    departmentId: item.departmentId || department.id,
    assigneeUserId: assignee.id,
    reviewerId: users.manager.id,
    reviewerKind: 'HUMAN' as const,
    sampleReason: options.sampleReason || 'نمونه هفتگی پرونده حل‌شده',
    score: options.score ?? qualityReviewScore(rubric, findings),
    findings,
    completedAt: now,
    createdAt: now,
    case: { id: item.id, key: item.key, title: item.title, description: 'case-private-review-copy' },
    rubric: { id: rubric.id, rubricKey: rubric.rubricKey, name: rubric.name, version: rubric.version, privateNotes: 'rubric-private-copy' },
    reviewer: { id: users.manager.id, name: users.manager.name, email: users.manager.email },
    assignee: { id: assignee.id, name: assignee.name, email: assignee.email },
    aggregate: [{ name: options.privateAggregate || 'peer-private-review-aggregate' }],
  };
}

function qualityReviewScore(rubric: FixtureQualityRubric, findings: Array<Record<string, unknown>>): number {
  const findingByKey = new Map(findings.map((finding) => [String(finding.criterionKey), finding]));
  let weightedScore = 0;
  let totalWeight = 0;
  for (const rawCriterion of rubric.criteria) {
    const criterion = asRecord(rawCriterion);
    const maxScore = Number(criterion.maxScore);
    const weight = Number(criterion.weight);
    const finding = findingByKey.get(String(criterion.key));
    const score = Number(finding?.score);
    if (!Number.isFinite(maxScore) || maxScore <= 0 || !Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;
    weightedScore += Math.min(maxScore, Math.max(0, Number.isFinite(score) ? score : 0)) / maxScore * weight;
  }
  return totalWeight ? Math.round(weightedScore / totalWeight * 100) : 0;
}

function makeCsatInvitationFixture(options: {
  id?: string;
  caseId: string;
  scaleMin?: number;
  scaleMax?: number;
  response?: { score: number; comment: string | null; submittedAt: string } | null;
}) {
  return {
    id: options.id || 'csat-existing-response',
    caseId: options.caseId,
    scaleMin: options.scaleMin || 1,
    scaleMax: options.scaleMax || 5,
    expiresAt: '2026-09-22T10:00:00.000Z',
    consumedAt: options.response === null ? null : now,
    invalidatedAt: null as string | null,
    createdAt: now,
    response: options.response === undefined
      ? { score: 5, comment: 'پاسخ روشن و پیگیری مناسب بود.', submittedAt: now }
      : options.response,
  };
}

function enablementPriority(definition: FixtureEnablementDefinition): FixtureCase['priority'] | null {
  const action = definition.actions.find((entry) => entry.type === 'SET_PRIORITY');
  return action?.value === 'LOW' || action?.value === 'NORMAL' || action?.value === 'HIGH' || action?.value === 'URGENT'
    ? action.value
    : null;
}

function enablementPreviewFixture(item: FixtureCase, definition: FixtureEnablementDefinition, previewHash: string) {
  const priority = enablementPriority(definition);
  return {
    definition,
    case: { id: item.id, key: item.key, version: item.version },
    conditionMatched: true,
    conditionResults: [],
    changes: priority && priority !== item.priority
      ? [{ field: 'priority', before: item.priority, after: priority }]
      : [],
    previewHash,
    canApply: Boolean(priority && priority !== item.priority),
    requiresHumanApply: true,
  };
}

function enablementApplicationResponse(application: FixtureEnablementApplication) {
  const { previousPriority: _previousPriority, ...response } = application;
  return response;
}

function routingDecisionFixture(
  item: FixtureCase,
  policy: FixtureRoutingPolicy | null,
  rule: FixtureRoutingRule | null,
  member?: FixtureRoutingMember
) {
  const routeAvailable = Boolean(policy && rule);
  return {
    explanationVersion: 1,
    outcome: routeAvailable ? 'ROUTE' : 'TRIAGE',
    case: {
      id: item.id, key: item.key, version: item.version, typeKey: item.typeKey,
      priority: item.priority, sourceChannel: item.sourceChannel, impact: item.impact, urgency: item.urgency,
    },
    policy: policy ? { id: policy.id, version: policy.version, label: policy.label } : null,
    evaluatedRules: rule ? [{ ruleId: rule.id, order: rule.order, name: rule.name, result: 'MATCH', mismatches: [] }] : [],
    matchedRule: rule ? { id: rule.id, order: rule.order, name: rule.name } : null,
    fallbackReason: routeAvailable ? null : 'NO_ACTIVE_POLICY',
    route: routeAvailable ? {
      departmentId: rule!.action.targetDepartmentId,
      departmentName: department.name,
      assignment: rule!.action.assignmentMode === 'CAPACITY_AWARE'
        ? routingAssignmentFixture(member)
        : {
          mode: 'DEPARTMENT_INBOX', result: 'DEPARTMENT_INBOX', selectionAlgorithm: null,
          capacityDetailsRedacted: false,
        },
    } : null,
    prioritySuggestion: prioritySuggestionFixture(item),
    decisionFingerprint: 'fixture-decision-fingerprint',
  };
}

function routingAssignmentFixture(member?: FixtureRoutingMember) {
  return {
    mode: 'CAPACITY_AWARE',
    result: member ? 'MEMBER_SELECTED' : 'NO_ELIGIBLE_MEMBER_DEPARTMENT_INBOX',
    selectionAlgorithm: 'LOWEST_UTILIZATION_THEN_LOAD_THEN_MEMBERSHIP_ID',
    capacityDetailsRedacted: false,
    consideredMemberCount: 4,
    eligibleMemberCount: member ? 1 : 0,
    selectedMember: member ? {
      membershipId: member.membershipId, userId: member.userId,
      activeCaseLoad: member.activeCaseLoad, capacity: member.routingCapacity,
      availableSlots: member.availableSlots, skills: member.routingSkills,
    } : null,
  };
}

function prioritySuggestionFixture(item: FixtureCase) {
  const suggestedPriority = suggestedPriorityFixture(item.impact, item.urgency);
  return {
    method: 'IMPACT_BY_URGENCY', suggestedPriority,
    available: suggestedPriority !== null, requiresHumanDecision: true,
  };
}

function suggestedPriorityFixture(
  impact: FixtureCase['impact'],
  urgency: FixtureCase['urgency']
): FixtureCase['priority'] | null {
  if (!impact || !urgency) return null;
  const matrix = {
    LOW: { LOW: 'LOW', MEDIUM: 'NORMAL', HIGH: 'HIGH' },
    MEDIUM: { LOW: 'NORMAL', MEDIUM: 'HIGH', HIGH: 'URGENT' },
    HIGH: { LOW: 'HIGH', MEDIUM: 'URGENT', HIGH: 'URGENT' },
  } as const;
  return matrix[impact][urgency];
}

function makeDeadLetterFixture() {
  return {
    receiptId: 'receipt-dead-letter',
    connector: {
      id: 'connector-crm', name: 'اتصال CRM', sourceChannel: 'API' as const, status: 'ACTIVE',
      secret: 'connector-secret', config: { token: 'hidden-token' },
    },
    case: null,
    status: 'DEAD_LETTER' as const,
    attempts: 4,
    error: { code: 'INTAKE_PAYLOAD_INVALID', message: 'ورودی با قرارداد اتصال سازگار نیست', raw: 'raw-error-stack' },
    receivedAt: '2026-08-22T08:00:00.000Z',
    processedAt: null,
    deadLetteredAt: '2026-08-22T08:05:00.000Z',
    updatedAt: '2026-08-22T08:05:00.000Z',
    payload: 'customer-private-payload',
    eventKey: 'event-secret',
    idempotencyKey: 'idempotency-secret',
    payloadHash: 'hash-secret',
    payloadRef: 'ref-secret',
    payloadCiphertext: 'ciphertext-secret',
  };
}

function makeIntakeHealthFixture(deadLetterCount: number) {
  const receiptCounts = { RECEIVED: 1, PROCESSING: 0, RETRY_PENDING: 1, PROCESSED: 12, REJECTED: 0, DEAD_LETTER: deadLetterCount };
  return {
    generatedAt: now,
    summary: {
      connectorCount: 1, activeConnectorCount: 1, receiptCounts,
      pendingCount: 2, deadLetterCount, oldestPendingAt: '2026-08-23T09:30:00.000Z',
    },
    items: [{
      connector: { id: 'connector-crm', name: 'اتصال CRM', sourceChannel: 'API', status: 'ACTIVE', createdAt: now, rotatedAt: null, revokedAt: null, secret: 'connector-secret' },
      receiptCounts, pendingCount: 2, deadLetterCount,
      oldestPendingAt: '2026-08-23T09:30:00.000Z', lastReceivedAt: now,
      lastProcessedAt: '2026-08-23T09:55:00.000Z', lastDeadLetteredAt: deadLetterCount ? '2026-08-22T08:05:00.000Z' : null,
    }],
  };
}

function makeReportFixture(actorKind: ActorKind) {
  return {
    generatedAt: now,
    timezone: 'Asia/Tehran',
    scope: { kind: actorKind === 'ADMIN' ? 'WORKSPACE' : 'MANAGED_DEPARTMENTS', departmentId: null },
    cohort: {
      from: '2026-07-23T10:00:00.000Z', to: now,
      definition: 'Cases currently visible to the caller and received at or after from and before to.',
    },
    summary: {
      received: 10, resolved: 7, closed: 5, reopened: 1, firstResponseRate: 0.8,
      firstResponseSeconds: { count: 8, p50: 600, p90: 1800 },
      resolutionSeconds: { count: 7, p50: 7200, p90: 18_000 },
    },
    backlog: { open: 5, ageSeconds: { count: 5, p50: 3600, p90: 14_400 } },
    queues: { DEPARTMENT_INBOX: 2, NEEDS_ATTENTION: 1 },
    breakdowns: {
      status: { OPEN: 5, RESOLVED: 5 }, priority: { NORMAL: 8, HIGH: 2 },
      sourceChannel: { API: 7, CALL: 3 }, type: { general: 10 }, resolutionCode: { FIXED: 7 },
      department: [{ departmentId: department.id, name: department.name, count: 10 }],
    },
    sla: [{ metric: 'FIRST_RESPONSE', met: 8, breached: 2, active: 0, canceled: 0, decided: 10, attainmentRate: 0.8 }],
    privacy: { perMemberBreakdownIncluded: true, note: 'same Case access predicate' },
    perMember: [{ name: users.peer.name, count: 99 }],
  };
}

function makeHandoffLink(options: {
  linkId: string;
  taskKey: string;
  title: string;
  status: string;
  taskDeletedAt?: string | null;
  connectionRevokedAt?: string | null;
  unlinkedAt?: string | null;
}) {
  return {
    projectionVersion: 1 as const,
    linkId: options.linkId,
    teamWorkspaceName: 'تیم محصول',
    taskKey: options.taskKey,
    title: options.title,
    status: options.status,
    lastSignalAt: now,
    tombstone: {
      taskDeletedAt: options.taskDeletedAt || null,
      connectionRevokedAt: options.connectionRevokedAt || null,
      unlinkedAt: options.unlinkedAt || null,
    },
  };
}

function expectCrossWorkspaceBodyIsRedacted(body: Record<string, unknown>, privateValues: string[]) {
  const serialized = JSON.stringify(body);
  for (const value of privateValues) expect(serialized).not.toContain(value);
}

function cloneCase(item: FixtureCase): FixtureCase {
  return structuredClone(item);
}

function membership(id: string, user: ReturnType<typeof person>, role: 'MEMBER' | 'MANAGER') {
  return {
    id,
    workspaceId: 'workspace-support',
    departmentId: department.id,
    userId: user.id,
    role,
    active: true,
    deactivatedAt: null,
    createdAt: now,
    updatedAt: now,
    user,
  };
}

function person(id: string, name: string, email: string) {
  return { id, name, email, avatarUrl: null, kind: 'HUMAN' };
}

function makeInteraction(item: FixtureCase, kind: string, body: string, call: unknown) {
  const callDetail = asRecord(call);
  return {
    id: `interaction-${item.id}-${item.interactions.length + 1}`,
    workspaceId: item.workspaceId,
    caseId: item.id,
    kind,
    visibility: kind === 'NOTE' ? 'INTERNAL' : 'PUBLIC',
    channel: kind === 'CALL' ? 'CALL' : 'MANUAL',
    direction: kind === 'NOTE' ? 'INTERNAL' : kind === 'CALL' ? String(callDetail.direction || 'OUTBOUND') : 'OUTBOUND',
    contactId: item.contactId,
    occurredAt: now,
    createdAt: now,
    content: { body, format: 'text/plain', encrypted: true },
    author: users.admin,
    call: call ? { id: `call-${item.id}`, ...callDetail } : null,
  };
}

function makeEvent(caseId: string, action: string) {
  return {
    id: `event-${caseId}-${action}-${Date.now()}`,
    caseId,
    sequence: 1,
    action,
    source: 'WEB',
    occurredAt: now,
    createdAt: now,
    actor: users.admin,
  };
}

function mutateCase(item: FixtureCase, action: string) {
  item.version += 1;
  item.updatedAt = now;
  item.lastMeaningfulActivityAt = now;
  item.events.push(makeEvent(item.id, action));
}

function postData(request: { postDataJSON(): unknown }): Record<string, unknown> {
  return asRecord(request.postDataJSON());
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function contactField(input: Record<string, unknown>, key: 'name' | 'phone'): string | undefined {
  const contact = asRecord(input.contact);
  return typeof contact[key] === 'string' ? contact[key] : undefined;
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function gotoApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  expect(overflow).toBeLessThanOrEqual(1);
}

function durationMilliseconds(value: string): number {
  return Math.max(...value.split(',').map((part) => {
    const duration = part.trim();
    if (duration.endsWith('ms')) return Number.parseFloat(duration);
    if (duration.endsWith('s')) return Number.parseFloat(duration) * 1000;
    return Number.parseFloat(duration) || 0;
  }));
}

async function browserPersistenceSnapshot(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const entries: unknown[] = [];
    for (let index = 0; index < localStorage.length; index += 1) entries.push(localStorage.getItem(localStorage.key(index) || ''));
    for (let index = 0; index < sessionStorage.length; index += 1) entries.push(sessionStorage.getItem(sessionStorage.key(index) || ''));
    if ('databases' in indexedDB) {
      const databases = await indexedDB.databases();
      entries.push(databases.map((database) => ({ name: database.name, version: database.version })));
      for (const database of databases) {
        if (!database.name) continue;
        const values = await new Promise<unknown[]>((resolve) => {
          const request = indexedDB.open(database.name!);
          request.onerror = () => resolve([]);
          request.onsuccess = () => {
            const db = request.result;
            const stores = Array.from(db.objectStoreNames);
            if (!stores.length) { db.close(); resolve([]); return; }
            const transaction = db.transaction(stores, 'readonly');
            const results: unknown[] = [];
            for (const storeName of stores) {
              const getAll = transaction.objectStore(storeName).getAll();
              getAll.onsuccess = () => results.push(...getAll.result);
            }
            transaction.oncomplete = () => { db.close(); resolve(results); };
            transaction.onerror = () => { db.close(); resolve(results); };
          };
        });
        entries.push(values);
      }
    }
    return JSON.stringify(entries);
  });
}
