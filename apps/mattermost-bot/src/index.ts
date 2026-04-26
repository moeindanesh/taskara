const [command, channelId] = process.argv.slice(2);

if (command === 'daily-digest') {
  await dailyDigest(channelId);
} else {
  console.log('Usage: bun run daily-digest <mattermost-channel-id>');
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
