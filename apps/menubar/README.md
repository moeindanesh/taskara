# Taskara Menubar

اپ سبک macOS برای نمایش و مدیریت تسک‌های شخصی Taskara داخل منوبار.

## Setup

در فایل `.env` ریشه پروژه مقدارهای زیر را ست کن:

```env
TASKARA_API_URL="http://localhost:4000"
TASKARA_USER_EMAIL="you@example.com"
TASKARA_WORKSPACE_SLUG="your-workspace"
WEB_ORIGIN="http://localhost:3005"
```

اختیاری:

```env
TASKARA_MENUBAR_REFRESH_MS="60000"
TASKARA_WEB_URL="http://localhost:3005"
```

## Run

از ریشه پروژه:

```bash
bun run dev:menubar
```

آیتم `TA <count>` در منوبار ساخته می‌شود.

- کلیک چپ: باز شدن پنل کوچک (نسخه مینی وب)
- کلیک راست: منوی سریع
- نمایش شمارنده `Active/Done/Total`
- نمایش جزئیات هر تسک: `key`, عنوان، وضعیت، اولویت، پروژه، ددلاین، زمان آخرین بروزرسانی، بخشی از توضیحات
- تغییر مستقیم وضعیت و اولویت هر تسک
- دکمه سریع `Done` برای بستن تسک
- گزینه `اجرا خودکار بعد از Login` داخل پنل (macOS)
