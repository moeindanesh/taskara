const [command, channelId, dateKeyArg] = process.argv.slice(2);

if (command === 'daily-digest') {
  await dailyDigest(channelId);
} else if (command === 'daily-report-digest') {
  await dailyReportDigest(channelId, dateKeyArg);
} else {
  console.log('Usage: bun run daily-digest <mattermost-channel-id>');
  console.log('       bun run daily-report-digest <mattermost-channel-id> [YYYY-MM-DD]');
}

async function dailyDigest(targetChannelId?: string): Promise<void> {
  if (!targetChannelId) throw new Error('Mattermost channel id is required');
  const mattermostBaseUrl = requiredEnv('MATTERMOST_BASE_URL').replace(/\/$/, '');
  const mattermostToken = requiredEnv('MATTERMOST_BOT_TOKEN');
  const taskaraApiUrl = requiredEnv('TASKARA_API_URL').replace(/\/$/, '');
  const userEmail = requiredEnv('TASKARA_USER_EMAIL');
  const workspaceSlug = requiredEnv('TASKARA_WORKSPACE_SLUG');
  if (!mattermostToken) throw new Error('MATTERMOST_BOT_TOKEN is required');

  const plan = await fetchJson<{
    focus: Array<{ key: string; title: string; priority: string }>;
    blocked: Array<{ key: string; title: string }>;
  }>(`${taskaraApiUrl}/agent/daily-plan`, {
    method: 'POST',
    headers: { 'x-user-email': userEmail, 'x-workspace-slug': workspaceSlug, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });

  const message = [
    '### Taskara daily plan',
    '',
    '**Focus**',
    ...(plan.focus.length ? plan.focus.map((task) => `- ${task.key} [${task.priority}] ${task.title}`) : ['- No focus tasks.']),
    '',
    '**Blocked**',
    ...(plan.blocked.length ? plan.blocked.map((task) => `- ${task.key} ${task.title}`) : ['- No blocked tasks.'])
  ].join('\n');

  await fetchJson(`${mattermostBaseUrl}/api/v4/posts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mattermostToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ channel_id: targetChannelId, message })
  });

  console.log(`Posted daily digest to ${targetChannelId}`);
}

interface DailyReportDigest {
  dateKey: string;
  reports: Array<{
    user?: { name: string } | null;
    completedText?: string | null;
    unplannedText?: string | null;
    planText?: string | null;
    blockersText?: string | null;
    helpText?: string | null;
  }>;
  blockersFirst: Array<{ user?: { name: string } | null; blockersText?: string | null; helpText?: string | null }>;
  missing: Array<{ name: string }>;
  stats: { submitted: number; expected: number; blockerCount: number; unplannedShare: number };
}

// Posts the compiled team digest into a channel. Blockers lead, because an unanswered ask is the
// fastest way for a daily report habit to die.
async function dailyReportDigest(targetChannelId?: string, dateKey?: string): Promise<void> {
  if (!targetChannelId) throw new Error('Mattermost channel id is required');
  const mattermostBaseUrl = requiredEnv('MATTERMOST_BASE_URL').replace(/\/$/, '');
  const mattermostToken = requiredEnv('MATTERMOST_BOT_TOKEN');
  const taskaraApiUrl = requiredEnv('TASKARA_API_URL').replace(/\/$/, '');
  const userEmail = requiredEnv('TASKARA_USER_EMAIL');
  const workspaceSlug = requiredEnv('TASKARA_WORKSPACE_SLUG');

  const query = dateKey ? `?dateKey=${encodeURIComponent(dateKey)}` : '';
  const digest = await fetchJson<DailyReportDigest>(`${taskaraApiUrl}/check-ins/digest${query}`, {
    method: 'GET',
    headers: { 'x-user-email': userEmail, 'x-workspace-slug': workspaceSlug }
  });

  const lines = [
    `### Taskara daily reports — ${digest.dateKey}`,
    '',
    `${digest.stats.submitted}/${digest.stats.expected} submitted · ${digest.stats.blockerCount} blocked · ${digest.stats.unplannedShare}% had unexpected work`,
    ''
  ];

  if (digest.blockersFirst.length) {
    lines.push('**Blocked / needs help**');
    for (const report of digest.blockersFirst) {
      lines.push(`- **${report.user?.name || 'Unknown'}**: ${[report.blockersText, report.helpText].filter(Boolean).join(' — ')}`);
    }
    lines.push('');
  }

  if (digest.reports.length) {
    lines.push('**Reports**');
    for (const report of digest.reports) {
      const parts = [
        report.completedText ? `done: ${report.completedText}` : null,
        report.unplannedText ? `unexpected: ${report.unplannedText}` : null,
        report.planText ? `next: ${report.planText}` : null
      ].filter(Boolean);
      lines.push(`- **${report.user?.name || 'Unknown'}** — ${parts.join(' · ') || 'no detail'}`);
    }
    lines.push('');
  } else {
    lines.push('_No reports for this day._', '');
  }

  if (digest.missing.length) {
    lines.push(`**Not yet reported**: ${digest.missing.map((user) => user.name).join('، ')}`);
  }

  await fetchJson(`${mattermostBaseUrl}/api/v4/posts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${mattermostToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ channel_id: targetChannelId, message: lines.join('\n') })
  });

  console.log(`Posted daily report digest for ${digest.dateKey} to ${targetChannelId}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`${name} is required`);
}

async function fetchJson<T>(url: string, options: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export {};
