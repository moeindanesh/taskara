**راه‌اندازی تسکارا — ۶ مرحله**

تسکارا رو می‌تونی هم از ترمینال (دستور `taskara`) و هم از داخل Claude Code و Codex (به‌صورت ابزار) استفاده کنی. این‌ها رو یکی‌یکی بزن، کل کار ۵ دقیقه‌ست.

---

**۱) نصب Bun**

اگه نداری:

```
curl -fsSL https://bun.sh/install | bash
```

بعد ترمینال رو ببند و باز کن، و چک کن:

```
bun --version
```

⚠️ تسکارا حتماً Bun می‌خواد، با Node اجرا نمی‌شه.

---

**۲) نصب تسکارا**

```
bun install -g taskara
```

چک کن نصب شده:

```
taskara
```

باید راهنمای کامل دستورها رو ببینی.

---

**۳) ورود**

```
taskara login --api-url https://taskaracore.avantech.website --workspace avantech
```

فقط ایمیل و رمز خودت رو می‌پرسه — همون ایمیل و رمزی که با اون وارد تسکارا می‌شی.

رمزت هیچ‌جا ذخیره نمی‌شه. یه کلید مخصوص خودت ساخته می‌شه و توی `~/.taskara/credentials.json` ذخیره می‌شه. همین یه بار کافیه.

---

**۴) تست**

```
taskara task list --assignee me
```

اگه لیست تسک‌هات (یا یه لیست خالی) اومد، تمومه ✅

---

**۵) وصل کردن به Claude Code**

```
claude mcp add taskara --scope user -e TASKARA_API_URL=https://taskaracore.avantech.website -e TASKARA_AGENT_RUNTIME=CLAUDE_CODE -- taskara-mcp
```

بعد Claude Code رو ببند و باز کن. حالا می‌تونی بگی «تسک‌های امروزم رو نشون بده» یا «برای این کار یه تسک بساز».

---

**۶) وصل کردن به Codex**

فایل `~/.codex/config.toml` رو باز کن و این رو آخرش اضافه کن:

```
[mcp_servers.taskara]
command = "taskara-mcp"
env_vars = ["PATH"]

[mcp_servers.taskara.env]
TASKARA_API_URL = "https://taskaracore.avantech.website"
TASKARA_AGENT_RUNTIME = "CODEX"
```

بعد Codex رو ببند و باز کن.

اگه Codex گفت `taskara-mcp` رو پیدا نمی‌کنه، این رو بزن:

```
which taskara-mcp
```

و مسیر کاملی که داد رو به‌جای `"taskara-mcp"` توی خط `command` بذار.

---

**دستورهای پرکاربرد**

```
taskara task list --assignee me
taskara task view CORE-12
taskara task claim CORE-12
taskara task comment CORE-12 --body "انجام شد"
taskara task close CORE-12 --reason completed
taskara project list
```

برای دیدن همهٔ دستورها کافیه `taskara` رو خالی بزنی.

نکته: آدم‌ها رو با **ایمیل** صدا بزن نه اسم — مثلاً `--assignee ali@example.com`. با `taskara user list` می‌تونی ایمیل بقیه رو پیدا کنی.

نکته: نوشتن `@علی` داخل متن تسک به هیچ‌کس اطلاع نمی‌ده. برای واگذاری کار از `--add-assignee` استفاده کن.

---

**اگه به مشکل خوردی**

🔸 `TASKARA_API_URL is required — or run taskara login`
یعنی هنوز مرحلهٔ ۳ رو نزدی.

🔸 لیست پروژه‌ها خالیه
مشکل از کلید یا رمزت نیست. پروژه‌ها به تیم وصل‌ان و تو هنوز توی هیچ تیمی نیستی. به من بگو اضافه‌ت کنم، بعد دوباره `taskara login` رو بزن.

🔸 `command not found: taskara`
ترمینال رو ببند و باز کن. اگه بازم نشد، `bun install -g taskara` رو دوباره بزن.

🔸 هر خطای دیگه
خروجی کامل دستور رو برام بفرست.
