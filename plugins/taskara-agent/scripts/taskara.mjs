#!/usr/bin/env bun
const [command, ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

const commands = {
  'list-my-tasks': listMyTasks,
  'search-tasks': searchTasks,
  'create-task': createTask,
  'update-task': updateTask,
  'comment-task': commentTask,
  'daily-plan': dailyPlan,
  'thread-to-tasks': threadToTasks
};

if (!command || !commands[command]) {
  console.error('Commands: list-my-tasks, search-tasks, create-task, update-task, comment-task, daily-plan, thread-to-tasks');
  process.exit(1);
}

const apiUrl = requiredEnv('TASKARA_API_URL').replace(/\/$/, '');
const userEmail = requiredEnv('TASKARA_USER_EMAIL');
const workspaceSlug = requiredEnv('TASKARA_WORKSPACE_SLUG');

await commands[command]();

async function listMyTasks() {
  const data = await request('/tasks?mine=true');
  print(data.items.map(taskSummary));
}

async function searchTasks() {
  const query = required('query');
  const data = await request(`/tasks?q=${encodeURIComponent(query)}`);
  print(data.items.map(taskSummary));
}

async function createTask() {
  const projectId = required('project-id');
  const title = required('title');
  const body = {
    projectId,
    title,
    description: args.description,
    priority: args.priority || 'NO_PRIORITY',
    status: args.status || 'TODO',
    dueAt: args['due-at'],
    labels: args.labels ? args.labels.split(',').map((item) => item.trim()).filter(Boolean) : [],
    source: 'CODEX'
  };
  const task = await request('/tasks', { method: 'POST', body });
  print(taskSummary(task));
}

async function updateTask() {
  const task = required('task');
  const body = {};
  for (const [argName, fieldName] of [['status', 'status'], ['priority', 'priority'], ['due-at', 'dueAt'], ['assignee-id', 'assigneeId']]) {
    if (args[argName] !== undefined) body[fieldName] = args[argName];
  }
  if (Object.keys(body).length === 0) throw new Error('Provide at least one update field.');
  const updated = await request(`/tasks/${encodeURIComponent(task)}`, { method: 'PATCH', body });
  print(taskSummary(updated));
}

async function commentTask() {
  const task = required('task');
  const body = required('body');
  const comment = await request(`/tasks/${encodeURIComponent(task)}/comments`, {
    method: 'POST',
    body: { body, source: 'CODEX' }
  });
  print(comment);
}

async function dailyPlan() {
  const plan = await request('/agent/daily-plan', { method: 'POST', body: {} });
  print(plan);
}

async function threadToTasks() {
  const projectId = args['project-id'];
  const text = args.text || await Bun.stdin.text();
  if (!text.trim()) throw new Error('Provide --text or stdin.');
  const run = await request('/agent/thread-to-tasks', {
    method: 'POST',
    body: { projectId, text }
  });
  print(run);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user-email': userEmail,
      'x-workspace-slug': workspaceSlug,
      'x-actor-type': 'CODEX'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || `${response.status} ${response.statusText}`);
  return data;
}

function taskSummary(task) {
  return {
    key: task.key,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project: task.project?.keyPrefix,
    dueAt: task.dueAt || null
  };
}

function required(name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
}

function parseArgs(items) {
  const parsed = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = items[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true';
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function requiredEnv(name) {
  const value = optionalEnv(name);
  if (value) return value;
  throw new Error(`${name} is required`);
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}
