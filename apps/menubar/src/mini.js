const statusLabels = {
  BACKLOG: 'بک‌لاگ',
  TODO: 'برای انجام',
  IN_PROGRESS: 'در حال انجام',
  IN_REVIEW: 'در بازبینی',
  BLOCKED: 'مسدود',
  DONE: 'انجام شد',
  CANCELED: 'لغو شده'
};

const priorityLabels = {
  NO_PRIORITY: 'بدون اولویت',
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  URGENT: 'فوری'
};

const statusOptions = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED'];
const priorityOptions = ['NO_PRIORITY', 'LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const state = {
  loading: false,
  pendingTaskKeys: new Set(),
  filters: {
    projectId: 'all',
    status: 'all',
    priority: 'all'
  },
  snapshot: {
    items: [],
    total: 0,
    lastSyncAt: null,
    lastError: null
  }
};

const nodes = {
  lastSync: document.getElementById('last-sync'),
  list: document.getElementById('tasks-list'),
  error: document.getElementById('error-box'),
  refreshBtn: document.getElementById('refresh-btn'),
  websiteBtn: document.getElementById('website-btn'),
  projectFilter: document.getElementById('project-filter'),
  statusFilter: document.getElementById('status-filter'),
  priorityFilter: document.getElementById('priority-filter')
};

function hasBridge() {
  return (
    typeof window.taskara?.list === 'function' &&
    typeof window.taskara?.refresh === 'function' &&
    typeof window.taskara?.syncNow === 'function' &&
    typeof window.taskara?.updateTask === 'function' &&
    typeof window.taskara?.openWebsite === 'function'
  );
}

function formatDateTime(value) {
  if (!value) return 'بدون تاریخ';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'بدون تاریخ';
  return new Intl.DateTimeFormat('fa-IR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function statusClass(status) {
  if (status === 'BLOCKED') return 'task-status-blocked';
  if (status === 'IN_PROGRESS' || status === 'IN_REVIEW') return 'task-status-progress';
  return '';
}

function isTaskPending(taskKey) {
  return state.pendingTaskKeys.has(taskKey);
}

function setTaskPending(taskKey, isPending) {
  if (!taskKey) return;
  if (isPending) state.pendingTaskKeys.add(taskKey);
  else state.pendingTaskKeys.delete(taskKey);
}

function patchSnapshotTask(taskKey, patch) {
  state.snapshot.items = state.snapshot.items.map((task) => {
    if (task.key !== taskKey) return task;
    return { ...task, ...patch };
  });
}

function projectFilterOptions() {
  const map = new Map();
  for (const task of state.snapshot.items) {
    if (!task.projectId) continue;
    if (!map.has(task.projectId)) {
      map.set(task.projectId, task.projectName || 'بدون نام');
    }
  }

  return Array.from(map.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fa'));
}

function filteredItems() {
  return state.snapshot.items.filter((task) => {
    if (state.filters.projectId !== 'all' && task.projectId !== state.filters.projectId) return false;
    if (state.filters.status !== 'all' && task.status !== state.filters.status) return false;
    if (state.filters.priority !== 'all' && task.priority !== state.filters.priority) return false;
    return true;
  });
}

function renderHeader() {
  if (state.loading) {
    nodes.lastSync.textContent = 'در حال بروزرسانی...';
    return;
  }

  const shownCount = filteredItems().length;
  if (!state.snapshot.lastSyncAt) {
    nodes.lastSync.textContent = `نمایش: ${shownCount} / ${state.snapshot.total}`;
    return;
  }

  nodes.lastSync.textContent = `نمایش: ${shownCount} / ${state.snapshot.total} • ${formatDateTime(state.snapshot.lastSyncAt)}`;
}

function renderError() {
  if (!state.snapshot.lastError) {
    nodes.error.classList.add('hidden');
    nodes.error.textContent = '';
    return;
  }
  nodes.error.classList.remove('hidden');
  nodes.error.textContent = state.snapshot.lastError;
}

function statusOptionsHtml(current) {
  return statusOptions
    .map((status) => `<option value="${status}" ${status === current ? 'selected' : ''}>${statusLabels[status] || status}</option>`)
    .join('');
}

function priorityOptionsHtml(current) {
  return priorityOptions
    .map(
      (priority) =>
        `<option value="${priority}" ${priority === current ? 'selected' : ''}>${priorityLabels[priority] || priority}</option>`
    )
    .join('');
}

function renderFilters() {
  const projectOptions = projectFilterOptions();
  const projectIds = new Set(projectOptions.map((project) => project.id));

  if (state.filters.projectId !== 'all' && !projectIds.has(state.filters.projectId)) {
    state.filters.projectId = 'all';
  }

  nodes.projectFilter.innerHTML = [
    '<option value="all">همه پروژه‌ها</option>',
    ...projectOptions.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
  ].join('');

  nodes.statusFilter.innerHTML = [
    '<option value="all">همه وضعیت‌ها</option>',
    ...statusOptions.map((status) => `<option value="${status}">${statusLabels[status] || status}</option>`)
  ].join('');

  nodes.priorityFilter.innerHTML = [
    '<option value="all">همه اولویت‌ها</option>',
    ...priorityOptions.map((priority) => `<option value="${priority}">${priorityLabels[priority] || priority}</option>`)
  ].join('');

  nodes.projectFilter.value = state.filters.projectId;
  nodes.statusFilter.value = state.filters.status;
  nodes.priorityFilter.value = state.filters.priority;
}

function renderTasks() {
  const items = filteredItems();
  if (items.length === 0) {
    nodes.list.innerHTML = '<div class="empty">تسکی مطابق فیلتر پیدا نشد</div>';
    return;
  }

  nodes.list.innerHTML = items
    .map((task) => {
      const pending = isTaskPending(task.key);
      return `
      <article class="task" data-task-key="${task.key}">
        <div class="task-head">
          <p class="task-key">${task.key}</p>
          <button class="tiny-btn" data-action="open" ${pending ? 'disabled' : ''}>باز کردن</button>
        </div>
        <h3 class="task-title">${escapeHtml(task.title || '')}</h3>
        <div class="task-meta">
          <span class="task-meta-badge ${statusClass(task.status)}">${statusLabels[task.status] || task.status}</span>
          <span>${priorityLabels[task.priority] || task.priority}</span>
          <span>${task.projectName ? escapeHtml(task.projectName) : 'بدون پروژه'}</span>
          <span>${formatDateTime(task.dueAt)}</span>
        </div>
        <div class="task-controls">
          <label class="ctrl">
            <span>وضعیت</span>
            <select data-action="status" ${pending ? 'disabled' : ''}>
              ${statusOptionsHtml(task.status)}
            </select>
          </label>
          <label class="ctrl">
            <span>اولویت</span>
            <select data-action="priority" ${pending ? 'disabled' : ''}>
              ${priorityOptionsHtml(task.priority)}
            </select>
          </label>
        </div>
      </article>
    `;
    })
    .join('');
}

function renderAll() {
  renderFilters();
  renderHeader();
  renderError();
  renderTasks();
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'خطای نامشخص';
}

async function loadTasks(force = false, useSync = false) {
  if (!hasBridge()) {
    state.snapshot.lastError = 'ارتباط داخلی اپ برقرار نشد (preload). اپ را یک‌بار ببندید و دوباره اجرا کنید.';
    renderAll();
    return;
  }

  state.loading = true;
  renderHeader();
  try {
    state.snapshot = useSync
      ? await window.taskara.syncNow()
      : force
        ? await window.taskara.refresh()
        : await window.taskara.list();
  } catch (error) {
    state.snapshot.lastError = errorMessage(error);
  } finally {
    state.loading = false;
    renderAll();
  }
}

async function updateTask(taskKey, patch) {
  if (!hasBridge() || !taskKey) return;

  const previous = state.snapshot.items.find((task) => task.key === taskKey);
  if (!previous) return;

  setTaskPending(taskKey, true);
  state.snapshot.lastError = null;
  patchSnapshotTask(taskKey, patch);
  renderAll();

  try {
    const result = await window.taskara.updateTask(taskKey, patch);
    if (result?.snapshot) {
      state.snapshot = result.snapshot;
    } else {
      await loadTasks(true);
      return;
    }
  } catch (error) {
    patchSnapshotTask(taskKey, previous);
    state.snapshot.lastError = errorMessage(error);
  } finally {
    setTaskPending(taskKey, false);
    renderAll();
  }
}

nodes.refreshBtn.addEventListener('click', () => {
  void loadTasks(true, true);
});

nodes.websiteBtn?.addEventListener('click', () => {
  if (!hasBridge()) return;
  void window.taskara.openWebsite();
});

nodes.projectFilter?.addEventListener('change', () => {
  state.filters.projectId = nodes.projectFilter.value || 'all';
  renderAll();
});

nodes.statusFilter?.addEventListener('change', () => {
  state.filters.status = nodes.statusFilter.value || 'all';
  renderAll();
});

nodes.priorityFilter?.addEventListener('change', () => {
  state.filters.priority = nodes.priorityFilter.value || 'all';
  renderAll();
});

nodes.list.addEventListener('click', (event) => {
  if (!hasBridge()) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const taskNode = target.closest('[data-task-key]');
  if (!taskNode) return;
  const taskKey = taskNode.getAttribute('data-task-key');
  if (!taskKey || isTaskPending(taskKey)) return;

  const actionEl = target.closest('[data-action]');
  const action = actionEl?.getAttribute('data-action');

  if (action === 'open') {
    void window.taskara.openTask(taskKey);
    return;
  }
});

nodes.list.addEventListener('change', (event) => {
  if (!hasBridge()) return;

  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;

  const action = target.getAttribute('data-action');
  if (action !== 'status' && action !== 'priority') return;

  const taskNode = target.closest('[data-task-key]');
  const taskKey = taskNode?.getAttribute('data-task-key');
  if (!taskKey || isTaskPending(taskKey)) return;

  const current = state.snapshot.items.find((task) => task.key === taskKey);
  if (!current) return;

  const patch = action === 'status' ? { status: target.value } : { priority: target.value };
  if (patch.status && current.status === patch.status) return;
  if (patch.priority && current.priority === patch.priority) return;

  void updateTask(taskKey, patch);
});

let unsubscribe = null;
if (!hasBridge()) {
  void loadTasks(true);
} else {
  unsubscribe = window.taskara.onRefreshRequested(() => {
    void loadTasks(true);
  });

  window.addEventListener('beforeunload', () => {
    unsubscribe?.();
  });

  void loadTasks(true);
}
