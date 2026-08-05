# راه‌اندازی Taskara در Claude Code و Codex

تسکارا دو سطح دارد که هر دو روی یک هستهٔ مشترک نوشته شده‌اند و هیچ‌کدام زیرمجموعهٔ دیگری نیست:

- **CLI** با گرامر `taskara <noun> <verb>` — تنها سطحی که یک *skill* می‌تواند به آن برسد، چون دستورهای skill رشته‌هایی هستند که داخل Bash اجرا می‌شوند. خروجی استاندارد همیشه JSON است و کد خروج، چیزی است که اسکریپت روی آن شرط می‌گذارد.
- **MCP** (سرور `src/mcp-server.ts`) — برای گفت‌وگو، جایی که فراخوانی ابزار طبیعی است و کد خروج نه.

این راهنما هر دو را برای هر دو رانتایم (Claude Code و Codex) راه می‌اندازد.

---

## ۰. پیش‌نیازها

| مورد | توضیح |
|---|---|
| **Bun** | اجباری است. کل بسته با ماژول‌های Bun ساخته شده و با رانتایم Bun اجرا می‌شود، نه Node. |
| **آدرس API** | برای پروداکشن: `https://taskaracore.avantech.website` |
| **اسلاگ ورک‌اسپیس** | مثلاً `avantech`. هر خواندن و نوشتنی با همین اسکوپ می‌شود. |
| **یک حساب کاربری انسانی** | فقط همین. برای `taskara login` نیازی به ادمین یا توکن دستی نیست. |

بررسی نصب Bun:

```bash
bun --version
```

---

## ۱. نصب CLI

### الف) از npm (مسیر همکاران — نیازی به مخزن نیست)

بسته با نام `taskara` روی رجیستری عمومی npm منتشر شده است (`0.1.0`، منتشرشده در ۱۴ مرداد ۱۴۰۵):

```bash
bun install -g taskara
```

دو باینری نصب می‌شود، `taskara` و `taskara-mcp`، با **صفر وابستگی** — همه‌چیز باندل شده، پس نه چیزی resolve می‌شود و نه lockfile کسی به‌هم می‌ریزد. برای راهنمای کوتاه و مرحله‌به‌مرحلهٔ همکاران، [taskara-quickstart-fa.md](taskara-quickstart-fa.md) را بفرستید.

هر دو یک فایل اجرایی واقعی روی `$PATH` هستند (معمولاً `~/.bun/bin/`)، نه alias شل — و این تمایز مهم است: skillها دستورها را در یک شل **غیرتعاملی** اجرا می‌کنند، جایی که alias تعریف‌شده در پروفایل تعاملی وجود ندارد.

بررسی:

```bash
which taskara
```

### ب) ساخت بستهٔ محلی (برای انتشار نسخهٔ بعدی)

```bash
bun run agent:build
```

خروجی در `plugins/taskara-agent/dist/` ساخته می‌شود: دو فایل باندل‌شده (`cli.js` و `mcp-server.js`) با صفر وابستگی، به‌همراه یک `package.json` تولیدشده که نام بسته را `taskara` و دو باینری را تعریف می‌کند. برای بازرسی تارball: `cd dist && npm pack`، و برای انتشار: `cd dist && npm publish`.

> انتشار روی این حساب 2FA با security key می‌خواهد؛ TOTP دیگر پذیرفته نمی‌شود و توکن‌های کلاسیک و bypass-2FA هم در حال محدود شدن‌اند. برای انتشار تکرارشونده، trusted publishing با GitHub Actions و OIDC کل این مسیر را دور می‌زند.

---

## ۲. ورود: یک دستور، بدون دخالت ادمین

```bash
taskara login
```

آنچه اتفاق می‌افتد:

1. آدرس API، اسلاگ ورک‌اسپیس، ایمیل و رمز را می‌پرسد (رمز با echo خاموش خوانده می‌شود تا نه در scrollback بماند و نه در history شل).
2. با هویت خودتان وارد می‌شود و از تسکارا یک credential برای **ایجنت خودتان** می‌گیرد — و اگر ایجنتی نداشته باشید، آن را می‌سازد و عضویت‌های تیمی شما را روی آن آینه می‌کند.
3. نتیجه را در `~/.taskara/credentials.json` با مود `600` می‌نویسد.
4. سشن را دور می‌اندازد. **رمز عبور هرگز ذخیره نمی‌شود**: رمز یک سشن می‌خرد، سشن یک credential می‌خرد، و سشن پیش از بازگشت دستور حذف می‌شود.

می‌توانید بخشی از ورودی‌ها را با فلگ بدهید تا پرسیده نشوند:

```bash
taskara login --api-url https://taskaracore.avantech.website --workspace avantech --email you@example.com
```

شکل فایل ذخیره‌شده:

```json
{
  "apiUrl": "https://taskaracore.avantech.website",
  "workspaceSlug": "avantech",
  "token": "tka_…"
}
```

> اگر پیام دیدید که «وارد شدید ولی ایجنت شما هیچ پروژه‌ای نمی‌بیند»، این **مشکل عضویت تیمی است، نه مشکل توکن**. پروژه‌ها اسکوپ‌شده به تیم‌اند؛ عضوی که در هیچ تیمی نیست یک ورک‌اسپیس خالی می‌خواند. در یک تیم عضو شوید و دوباره اجرا کنید.

---

## ۳. راه‌اندازی در Claude Code

### ۳.۱ سطح MCP

سادهٔ‌ترین راه، ثبت سرور stdio با اسکوپ کاربر است تا از هر پروژه‌ای در دسترس باشد:

```bash
claude mcp add taskara --scope user -e TASKARA_API_URL=https://taskaracore.avantech.website -e TASKARA_AGENT_RUNTIME=CLAUDE_CODE -- taskara-mcp
```

معادل دستی همین ثبت در `~/.claude.json` (بخش سراسری `mcpServers`):

```json
{
  "mcpServers": {
    "taskara": {
      "type": "stdio",
      "command": "taskara-mcp",
      "args": [],
      "env": {
        "TASKARA_API_URL": "https://taskaracore.avantech.website",
        "TASKARA_AGENT_RUNTIME": "CLAUDE_CODE"
      }
    }
  }
}
```

`taskara-mcp` باینری دومی است که `bun install -g taskara` نصب می‌کند، پس هیچ مسیری اینجا نوشته نمی‌شود. اگر Claude Code پیدایش نکرد، `which taskara-mcp` را بزنید و خروجی‌اش را در `command` بگذارید — این وقتی پیش می‌آید که برنامه با یک `PATH` محدود بالا آمده باشد.

**چرا فقط `TASKARA_API_URL` اینجا هست و نه توکن؟** چون `readConfig` هرچه در env نباشد را از `~/.taskara/credentials.json` برمی‌دارد. پس اسلاگ و توکن از فایل لاگین می‌آیند و تنها چیزی که باید پین شود آدرس API است — به دلیلی که در بخش «تله‌ها» می‌آید.

اگر ترجیح می‌دهید همه‌چیز صریح باشد (مثلاً روی CI):

```json
"env": {
  "TASKARA_API_URL": "https://taskaracore.avantech.website",
  "TASKARA_WORKSPACE_SLUG": "avantech",
  "TASKARA_AGENT_TOKEN": "tka_…",
  "TASKARA_AGENT_RUNTIME": "CLAUDE_CODE"
}
```

### ۳.۲ سطح CLI داخل Claude Code

اگر می‌خواهید هر فراخوانی Bash در Claude Code از پیش credential داشته باشد، متغیرها را در `~/.claude/settings.json` بگذارید:

```json
{
  "env": {
    "TASKARA_API_URL": "https://taskaracore.avantech.website",
    "TASKARA_WORKSPACE_SLUG": "avantech",
    "TASKARA_AGENT_TOKEN": "tka_…",
    "TASKARA_AGENT_RUNTIME": "CLAUDE_CODE"
  }
}
```

مخزن یک اسکریپت دارد که همین را با پشتیبان‌گیری انجام می‌دهد و در پایان اتصال را اثبات می‌کند (نه اینکه فقط اعلام موفقیت کند):

```bash
bun run agent:setup
```

این اسکریپت سه کار می‌کند: `bun link` می‌زند، متغیرها را در `~/.claude/settings.json` ادغام می‌کند (با گرفتن نسخهٔ `.bak`)، و بعد یک `project list` واقعی می‌زند تا مطمئن شود جواب می‌دهد. پس از اجرا، Claude Code را ری‌استارت کنید تا env تازه را بردارد.

> اگر با `taskara login` جلو رفته‌اید، این مرحله اختیاری است — CLI خودش از `~/.taskara/credentials.json` می‌خواند.

### ۳.۳ اسکیل

فایل `plugins/taskara-agent/skills/taskara-agent/SKILL.md` قرارداد کامل ایجنت را توصیف می‌کند: گرامر CLI، جدول کدهای خروج، الگوی «مرز کار» (frontier)، قواعد claim کردن و رفتار subscribe/unsubscribe. اگر اسکیل را در Claude Code فعال می‌کنید، همان مسیر را به‌عنوان منبع skill معرفی کنید.

---

## ۴. راه‌اندازی در Codex

### ۴.۱ سرور MCP در `~/.codex/config.toml`

```toml
[mcp_servers.taskara]
command = "taskara-mcp"
env_vars = ["PATH"]

[mcp_servers.taskara.env]
TASKARA_API_URL = "https://taskaracore.avantech.website"
TASKARA_WORKSPACE_SLUG = "avantech"
TASKARA_AGENT_RUNTIME = "CODEX"
```

نکته‌ها:

- `env_vars = ["PATH"]` باعث می‌شود `PATH` از محیط والد عبور کند تا `taskara-mcp` پیدا شود. اگر Codex پیدایش نکرد، خروجی `which taskara-mcp` را در `command` بگذارید.
- بلوک `[mcp_servers.taskara.env]` متغیرهای صریح است. اگر `TASKARA_AGENT_TOKEN` را اینجا نگذارید، توکن از `~/.taskara/credentials.json` خوانده می‌شود — به شرطی که `TASKARA_WORKSPACE_SLUG` نوشته‌شده با اسلاگ داخل آن فایل **یکی باشد** (بخش ۵ را ببینید).
- به‌جای توکن می‌توانید `TASKARA_USER_EMAIL` بگذارید؛ این مسیر «انسان در گفت‌وگو» است و ابزارهای ادمینی مثل `user_create` را هم باز می‌گذارد. اما برای یک ایجنت کار نمی‌کند: کاربری که `kind = AGENT` است روی مسیر ایمیل رد می‌شود.

### ۴.۲ پلاگین محلی

مخزن یک مارکت‌پلیس محلی هم دارد:

```txt
.agents/plugins/marketplace.json      → ورودی مارکت‌پلیس «taskara-local»
plugins/taskara-agent/.codex-plugin/plugin.json → مانیفست پلاگین
plugins/taskara-agent/.mcp.json       → کانفیگ MCP پلاگین
plugins/taskara-agent/.app.json       → متغیرهایی که پلاگین اعلام می‌کند
```

پس از ری‌استارت Codex، پلاگین `Taskara Agent` را از مارکت‌پلیس محلی نصب/فعال کنید. فعال‌بودنش در `config.toml` این‌طور دیده می‌شود:

```toml
[plugins."taskara-agent@taskara-local"]
enabled = true
```

---

## ۵. متغیرهای محیطی و قواعد اولویت

| متغیر | معنی |
|---|---|
| `TASKARA_API_URL` | آدرس پایهٔ API. |
| `TASKARA_WORKSPACE_SLUG` | ورک‌اسپیسی که تیم در آن است؛ هر خواندن و نوشتنی با آن اسکوپ می‌شود. |
| `TASKARA_AGENT_TOKEN` | credential ایجنت، به‌صورت bearer token. تنها راه احراز هویت یک کاربر از نوع AGENT. |
| `TASKARA_USER_EMAIL` | مسیر قدیمی هدر، برای یک **انسان** که MCP را در گفت‌وگو می‌راند. وقتی توکن ست باشد نادیده گرفته می‌شود. |
| `TASKARA_AGENT_RUNTIME` | یکی از `CLAUDE_CODE`، `CODEX`، `OPENCLAW`، `HERMES`. یک باینری هر چهار را سرویس می‌دهد؛ کانفیگ هر رانتایم اعلام می‌کند کدام است. |

سه قاعده که رفتار را تعیین می‌کنند و اگر ندانید، خطاها گمراه‌کننده به نظر می‌رسند:

۱. **محیط، فیلد به فیلد، بر فایل ذخیره‌شده می‌چربد.** CI متغیر ست می‌کند و خانه‌ای برای نوشتن ندارد؛ لپ‌تاپ یک‌بار `login` می‌زند و چیزی ست نمی‌کند.

۲. **احراز هویت به‌صورت یکپارچه انتخاب می‌شود، نه فیلد به فیلد.** اگر محیط *یا* توکن *یا* ایمیل را نام ببرد، فایل ذخیره‌شده کلاً کنار می‌رود. در غیر این صورت یک توکن قدیمی می‌توانست بی‌صدا بر `TASKARA_USER_EMAIL`ی که امروز عمداً ست کرده‌اید بچربد.

۳. **توکن ذخیره‌شده فقط وقتی پذیرفته می‌شود که اسلاگ ورک‌اسپیسِ داخلش با اسلاگ نهایی یکی باشد** — وگرنه بی‌صدا دور انداخته می‌شود. یک credential برای یک ورک‌اسپیس صادر می‌شود؛ جفت‌کردنش با اسلاگ دیگر یعنی فرستادن کلیدی به دری که باز نمی‌کند، و خطای ۴۰۳ طوری گزارش می‌شود که انگار اسلاگ غلط بوده.

مقدار نامعتبر برای `TASKARA_AGENT_RUNTIME` یک خطای پیکربندی (کد خروج ۲) است، نه حذف بی‌صدا.

---

## ۶. آزمون سلامت

### CLI

```bash
taskara project list
```

باید JSON با آرایهٔ `projects` بدهد و کد خروج `0`.

```bash
taskara task list --assignee me
```

### MCP، بدون نیاز به Claude یا Codex

```bash
bun -e 'import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"; const t = new StdioClientTransport({ command: "taskara-mcp", args: [], env: { ...process.env, TASKARA_API_URL: "https://taskaracore.avantech.website" } }); const c = new Client({ name: "smoke", version: "0.1.0" }, { capabilities: {} }); await c.connect(t); console.log((await c.listTools()).tools.map((tool) => tool.name)); await c.close();'
```

فهرست نام ابزارها باید چاپ شود. داخل خود گفت‌وگو هم ابزار `workspace_check` همین کار را می‌کند.

این را در یک پوشهٔ **خالی** اجرا کنید. خود اسکریپت برای بازی کردن نقش کلاینت به `@modelcontextprotocol/sdk` نیاز دارد و Bun آن را در پوشهٔ خالی خودکار نصب می‌کند؛ ولی در پوشه‌ای که `node_modules` دیگری دارد این کار را نمی‌کند و خطای `Cannot find module` می‌دهد — که خطای همین تست است، نه سرور.

---

## ۷. تله‌های شناخته‌شده

### الف) فایل `.env` مخزن، آدرس API را می‌دزدد

این تله فقط کسی را می‌گیرد که خودِ مخزن تسکارا را چک‌اوت کرده — با نصب از npm پیش نمی‌آید. فایل `.env` در ریشهٔ مخزن این را دارد:

```txt
TASKARA_API_URL="http://localhost:4002"
```

و Bun آن را از روی cwd به‌صورت خودکار بار می‌کند. یعنی **داخل این مخزن**، CLI اسلاگ ورک‌اسپیس *پروداکشن* را به API *لوکال* می‌فرستد و جواب می‌گیرد `Workspace not found` با کد خروج `4` — که شبیه مشکل احراز هویت یا دیتا به نظر می‌رسد، ولی هیچ‌کدام نیست.

راه‌حل، پیشوند زدن به دستور است:

```bash
TASKARA_API_URL=https://taskaracore.avantech.website taskara project list
```

بیرون از این مخزن، CLI بدون پیشوند کار می‌کند. همین موضوع دلیل آن است که ورودی MCP در `~/.claude.json` آدرس API را صریحاً پین می‌کند: متغیری که پیش از اجرا ست شده باشد، توسط بارگذاری خودکار `.env` بازنویسی نمی‌شود.

### ب) ورودی MCP با ترنسپورت http که سایه می‌اندازد

اگر در `~/.claude.json` یک ورودی **پروژه‌ای** برای تسکارا ثبت شده باشد، آن ورودی بر ورودی سراسری سایه می‌اندازد، هر وقت که cwd دقیقاً همان پوشه باشد. مورد رایجش ورودی‌ای است که با ترنسپورت http به `https://taskaracore.avantech.website/mcp` وصل می‌شود — و **آن آدرس اصلاً وجود ندارد**: API هیچ روت `/mcp` سرو نمی‌کند و سرور MCP فقط stdio است. اگر ابزارهای تسکارا در یک پوشهٔ خاص کار نکردند ولی در بقیهٔ جاها کار کردند، اول دنبال چنین ورودی‌ای بگردید.

### ج) فهرست پروژهٔ خالی

تقریباً هیچ‌وقت به‌معنی توکن خراب نیست. پروژه‌ها اسکوپ‌شده به تیم‌اند؛ ایجنتی که عضو ورک‌اسپیس هست اما در هیچ تیمی نیست، ورک‌اسپیس را خالی می‌خواند. باید به تیم اضافه شود.

### د) ایجنت روی مسیر ایمیل رد می‌شود

یک کاربر با `kind = AGENT` نمی‌تواند با `TASKARA_USER_EMAIL` احراز هویت شود. برای ایجنت `TASKARA_AGENT_TOKEN` بگذارید. در جهت عکس هم، ابزارهای ادمینی (`user_create`، `user_set_role`) با credential ایجنت رد می‌شوند — به همین دلیل CLI اصلاً فعل `user create` ندارد، ولی MCP دارد، چون انسانِ در گفت‌وگو ممکن است ادمین باشد.

### ه) منشن با `@` در متن به هیچ‌کس نمی‌رسد

منشن یک نود rich-text است و هر بدنه‌ای که از این سطح‌ها فرستاده می‌شود markdown است. `@Robin لطفاً نگاه کن` هیچ اعلانی نمی‌فرستد. آدرس‌دهی با فلگ انجام می‌شود: `--add-assignee <email>`.

---

## ۸. کدهای خروج CLI

خروجی استاندارد همیشه JSON است، خطای استاندارد همیشه خط انسانی، و شرط‌گذاری روی کد خروج انجام می‌شود.

| کد | معنی | واکنش |
|---|---|---|
| `0` | موفق | ادامه بده. |
| `1` | خطای کاربرد — noun/verb/flag غلط. هیچ چیزی فرستاده نشد. | دستور را درست کن. |
| `2` | پیکربندی — متغیر لازم نیست یا غیرقابل‌استفاده است. هیچ چیزی فرستاده نشد. | یک انسان کانفیگ را درست کند. |
| `3` | احراز هویت — credential غایب، غلط، باطل‌شده یا بدون مجوز. | یک انسان credential را درست کند. |
| `4` | پیدا نشد | کلید را بررسی کن. |
| `5` | تعارض — کس دیگری آن را گرفته، یا رکورد جلو رفته. | سراغ تسک دیگر برو، یا دوباره اعمال و تلاش کن. |
| `6` | رد شد — سرور فهمید و نپذیرفت. | درخواست را اصلاح کن. |
| `7` | خطای سرور — معلوم نیست کار انجام شده یا نه. | دوباره تلاش، بعد ارجاع بده. |
| `8` | غیرقابل‌دسترس — اصلاً پاسخ HTTP نیامد. | دوباره تلاش؛ بالا بودن API را چک کن. |

```bash
taskara task claim CORE-12 || handle_it
```

---

## ۹. دستورهای پرکاربرد CLI

```bash
taskara task list --assignee me
taskara task view CORE-12 --comments
taskara task claim CORE-12
taskara task create --project CORE --title "پیاده‌سازی audit trail" --assignee you@example.com
taskara task edit CORE-12 --status IN_PROGRESS --add-label backend
taskara task comment CORE-12 --body "نسخهٔ اول آماده شد."
taskara task close CORE-12 --reason completed
taskara project list
taskara user list --kind AGENT
```

مرز کار — فرزندان تمام‌نشده، بدون صاحب و بدون بلاکر یک Effort، یعنی آنچه همین حالا قابل برداشتن است:

```bash
taskara task list --parent CORE-1 --status unfinished --assignee none --blockers none --sort createdAt:asc
```

نکته‌ها:

- `--project` یا پیشوند کلید می‌گیرد (`CORE`) یا UUID. پیشوند خط تیره ندارد و UUID همیشه دارد، پس تداخلی پیش نمی‌آید.
- `--assignee` و `--add-assignee` فقط UUID یا **ایمیل** می‌گیرند، هرگز نام — چون `User.name` قید یکتایی ندارد. `taskara user list` راه پیدا کردن هر دو است.
- `taskara task claim` سمت سرور شرطی است و عمداً idempotent نیست: claim دوبارهٔ تسکی که خودتان دارید هم `5` می‌دهد.
- `taskara task sms <key> --about new-task|follow-up` به **صاحب تسک** پیامک می‌زند و به هیچ‌کس دیگر. متن را سرور به فارسی می‌نویسد؛ فلگی برای نوشتن متن وجود ندارد. subscription را هم نمی‌خواند: کسی که تسک را mute کرده باز هم پیامک می‌گیرد.

برای دیدن کل گرامر، `taskara` را بدون آرگومان اجرا کنید.

---

## ۱۰. ابزارهای MCP

نام ابزارها همان گرامر `noun_verb` را دنبال می‌کنند تا دو سطح یک واژگان باشند، نه دو تا:

| گروه | ابزارها |
|---|---|
| ورک‌اسپیس | `workspace_check` |
| پروژه | `project_list`، `project_create`، `project_summarize` |
| مایل‌استون | `milestone_list`، `milestone_create`، `milestone_update`، `milestone_summarize` |
| تسک | `task_search`، `task_list_mine`، `task_view`، `task_create`، `task_edit`، `task_claim`، `task_comment`، `task_sms`، `task_attach`، `task_set_milestone`، `task_subscribe`، `task_unsubscribe` |
| ایجنت | `task_propose`، `agent_action_apply` |
| برنامه‌ریزی | `plan_daily`، `plan_work`، `backlog_triage`، `blocker_detect` |
| گزارش | `report_daily_draft`، `report_daily_submit`، `report_weekly` |
| کاربر | `user_list`، `user_create`، `user_set_role` |

سه ابزار آخر فقط برای انسانِ ادمین کار می‌کنند و با credential ایجنت رد می‌شوند.

---

## چک‌لیست نهایی

- [ ] `bun --version` جواب می‌دهد
- [ ] `which taskara` مسیری برمی‌گرداند
- [ ] `taskara login` اجرا شده و `~/.taskara/credentials.json` با مود `600` وجود دارد
- [ ] `taskara project list` بیرون از مخزن، پروژه‌ها را برمی‌گرداند
- [ ] ورودی MCP در `~/.claude.json` (یا با `claude mcp add`) ثبت شده و Claude Code ری‌استارت شده
- [ ] بلوک `[mcp_servers.taskara]` در `~/.codex/config.toml` هست و Codex ری‌استارت شده
- [ ] `workspace_check` در گفت‌وگو جواب می‌دهد
