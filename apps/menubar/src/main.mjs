import { app, BrowserWindow, Tray, ipcMain, nativeImage, nativeTheme, shell, screen } from 'electron';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '../../..');
const appDataPath = (() => {
  try {
    return app.getPath('appData');
  } catch {
    return null;
  }
})();

const userDataEnvPath = (() => {
  try {
    return path.join(app.getPath('userData'), '.env');
  } catch {
    return null;
  }
})();

const legacyProductEnvPath = appDataPath ? path.join(appDataPath, 'Taskara Menubar', '.env') : null;
const scopedPackageEnvPath = appDataPath ? path.join(appDataPath, '@taskara', 'menubar', '.env') : null;

const envPaths = [
  process.env.TASKARA_ENV_PATH,
  userDataEnvPath,
  legacyProductEnvPath,
  scopedPackageEnvPath,
  path.join(workspaceRoot, '.env'),
  path.join(process.cwd(), '.env'),
  process.resourcesPath ? path.join(process.resourcesPath, '.env') : null
].filter((value) => typeof value === 'string' && value.length > 0);

for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  dotenv.config({ path: envPath, override: false });
  break;
}

const apiUrl = (process.env.TASKARA_API_URL || 'http://localhost:4000').replace(/\/$/, '');
const authToken = process.env.TASKARA_AUTH_TOKEN?.trim();
let workspaceSlug = process.env.TASKARA_WORKSPACE_SLUG?.trim();
const webUrl = (process.env.TASKARA_WEB_URL || process.env.WEB_ORIGIN || 'http://localhost:3005').replace(/\/$/, '');
const refreshMs = Number(process.env.TASKARA_MENUBAR_REFRESH_MS || '60000');

const iconPaths = [
  path.join(__dirname, 'icon.png'),
  path.resolve(workspaceRoot, 'apps/web/public/images/icon.png')
];
const fallbackTrayIconDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACTSURBVHgBpZKBCYAgEEV/TeAIjuIIbdQIuUGt0CS1gW1iZ2jIVaTnhw+Cvs8/OYDJA4Y8kR3ZR2/kmazxJbpUEfQ/Dm/UG7wVwHkjlQdMFfDdJMFaACebnjJGyDWgcnZu1/lrCrl6NCoEHJBrDwEr5NrT6ko/UV8xdLAC2N49mlc5CylpYh8wCwqrvbBGLoKGvz8Bfq0QPWEUo/EAAAAASUVORK5CYII=';

const statusOrder = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'];

let tray = null;
let panelWindow = null;
let refreshTimer = null;
let lastSnapshot = {
  items: [],
  total: 0,
  lastSyncAt: null,
  lastError: null
};
let isRefreshing = false;
let actorBootstrapPromise = null;

function authHeaders() {
  return {
    'content-type': 'application/json',
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    ...(workspaceSlug ? { 'x-workspace-slug': workspaceSlug } : {}),
    'x-actor-type': 'CODEX'
  };
}

async function bootstrapActorContext() {
  if (!authToken) return;
  if (workspaceSlug) return;
  if (actorBootstrapPromise) {
    await actorBootstrapPromise;
    return;
  }

  actorBootstrapPromise = (async () => {
    const response = await fetch(`${apiUrl}/workspaces`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json'
      }
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.message || `${response.status} ${response.statusText}`);
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    const first = items.find((item) => typeof item?.workspace?.slug === 'string');
    if (first?.workspace?.slug) workspaceSlug = first.workspace.slug;
  })();

  try {
    await actorBootstrapPromise;
  } finally {
    actorBootstrapPromise = null;
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: authHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text || 'Invalid API response' };
  }
  if (!response.ok) throw new Error(data?.message || `${response.status} ${response.statusText}`);
  return data;
}

function normalizeTasks(items) {
  return items
    .map((item) => ({
      key: item.key,
      title: item.title,
      status: item.status,
      priority: item.priority,
      projectId: item.project?.id || null,
      projectName: item.project?.name || null,
      dueAt: item.dueAt
    }))
    .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
}

async function patchTask(taskKey, patch) {
  if (!taskKey) throw new Error('Task key is required');
  return request(`/tasks/${encodeURIComponent(taskKey)}`, {
    method: 'PATCH',
    body: patch
  });
}

async function refreshTasks(force = false) {
  if (!authToken) {
    lastSnapshot = {
      ...lastSnapshot,
      lastError: 'TASKARA_AUTH_TOKEN در فایل .env تنظیم نشده است'
    };
    updateTrayView();
    return lastSnapshot;
  }

  try {
    await bootstrapActorContext();
  } catch (error) {
    lastSnapshot = {
      ...lastSnapshot,
      lastError: error instanceof Error ? error.message : 'Failed to load workspace from web session'
    };
    updateTrayView();
    return lastSnapshot;
  }

  if (!workspaceSlug) {
    lastSnapshot = {
      ...lastSnapshot,
      lastError: 'هیچ workspace فعالی برای توکن فعلی پیدا نشد'
    };
    updateTrayView();
    return lastSnapshot;
  }

  if (isRefreshing && !force) return lastSnapshot;
  isRefreshing = true;
  try {
    const data = await request('/tasks?mine=true&limit=200');
    const items = normalizeTasks(Array.isArray(data?.items) ? data.items : []);
    lastSnapshot = {
      items,
      total: items.length,
      lastSyncAt: new Date().toISOString(),
      lastError: null
    };
  } catch (error) {
    lastSnapshot = {
      ...lastSnapshot,
      lastError: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    isRefreshing = false;
    updateTrayView();
  }
  return lastSnapshot;
}

function trayIcon() {
  let icon = nativeImage.createEmpty();
  for (const iconPath of iconPaths) {
    if (!icon.isEmpty()) break;
    icon = nativeImage.createFromPath(iconPath);
  }
  if (!icon.isEmpty()) icon = icon.resize({ width: 18, height: 18, quality: 'best' });
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(fallbackTrayIconDataUrl);
  if (process.platform === 'darwin' && !icon.isEmpty()) icon.setTemplateImage(true);
  return icon;
}

function updateTrayView() {
  if (!tray) return;
  tray.setTitle('');
  tray.setToolTip(`Taskara - Tasks: ${lastSnapshot.total}`);
}

function togglePanelWindow() {
  if (!panelWindow) return;
  if (panelWindow.isVisible()) {
    panelWindow.hide();
    return;
  }
  showPanelWindow();
}

function showPanelWindow() {
  if (!panelWindow || !tray) return;

  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2)
  });

  const windowBounds = panelWindow.getBounds();
  const margin = 10;
  const x = Math.min(
    Math.max(display.workArea.x + margin, Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2)),
    display.workArea.x + display.workArea.width - windowBounds.width - margin
  );
  const y = display.workArea.y + 24;

  panelWindow.setPosition(x, y, false);
  panelWindow.show();
  panelWindow.focus();
  panelWindow.webContents.send('taskara:refresh');
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    vibrancy: 'under-window',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  panelWindow.loadFile(path.join(__dirname, 'mini.html')).catch(() => undefined);
  panelWindow.on('blur', () => {
    if (panelWindow?.isVisible()) panelWindow.hide();
  });
  panelWindow.on('close', (event) => {
    event.preventDefault();
    panelWindow?.hide();
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', () => {
    togglePanelWindow();
  });
  updateTrayView();
}

ipcMain.handle('taskara:list', async () => {
  await refreshTasks();
  return lastSnapshot;
});

ipcMain.handle('taskara:refresh', async () => {
  await refreshTasks(true);
  return lastSnapshot;
});

ipcMain.handle('taskara:sync', async () => {
  await refreshTasks(true);
  return lastSnapshot;
});

ipcMain.handle('taskara:update-task', async (_event, taskKey, patch) => {
  const input = patch && typeof patch === 'object' ? patch : {};
  const payload = {};

  if (typeof input.status === 'string' && input.status) payload.status = input.status;
  if (typeof input.priority === 'string' && input.priority) payload.priority = input.priority;
  if (Object.keys(payload).length === 0) throw new Error('No valid update fields provided');

  const updated = await patchTask(taskKey, payload);
  await refreshTasks(true);
  return { updatedTask: updated, snapshot: lastSnapshot };
});

ipcMain.handle('taskara:open-task', async (_event, taskKey) => {
  if (!workspaceSlug) {
    try {
      await bootstrapActorContext();
    } catch {
      // Ignore bootstrap failures here; fallback URL below.
    }
  }
  const key = encodeURIComponent(String(taskKey || '').trim());
  if (!key) return;
  const basePath = workspaceSlug ? `/${workspaceSlug}/team/all/all` : '';
  await shell.openExternal(`${webUrl}${basePath}${basePath ? `?task=${key}` : ''}`);
});

ipcMain.handle('taskara:open-web', async () => {
  if (!workspaceSlug) {
    try {
      await bootstrapActorContext();
    } catch {
      // Ignore bootstrap failures here; fallback URL below.
    }
  }
  const basePath = workspaceSlug ? `/${workspaceSlug}/team/all/all` : '';
  await shell.openExternal(`${webUrl}${basePath}`);
});

app.whenReady().then(async () => {
  app.dock?.hide();
  createTray();
  createPanelWindow();

  await refreshTasks(true);
  refreshTimer = setInterval(() => {
    void refreshTasks();
  }, Math.max(10_000, refreshMs));
});

nativeTheme.on('updated', () => {
  panelWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff');
});

app.on('activate', () => {
  if (!panelWindow) createPanelWindow();
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  panelWindow?.destroy();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
