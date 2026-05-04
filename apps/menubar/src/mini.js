const statusLabels = {
  BACKLOG: 'بک‌لاگ',
  TODO: 'برای انجام',
  IN_PROGRESS: 'در حال انجام',
  IN_REVIEW: 'در بازبینی',
  BLOCKED: 'مسدود'
};

const state = {
  loading: false,
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
  refreshBtn: document.getElementById('refresh-btn')
};

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

function renderHeader() {
  if (state.loading) {
    nodes.lastSync.textContent = 'در حال بروزرسانی...';
    return;
  }
  if (!state.snapshot.lastSyncAt) {
    nodes.lastSync.textContent = 'همگام‌سازی نشده';
    return;
  }
  nodes.lastSync.textContent = `تعداد تسک: ${state.snapshot.total} • ${formatDateTime(state.snapshot.lastSyncAt)}`;
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

function renderTasks() {
  if (state.snapshot.items.length === 0) {
    nodes.list.innerHTML = '<div class="empty">تسک بازی برای نمایش نیست</div>';
    return;
  }

  nodes.list.innerHTML = state.snapshot.items
    .map(
      (task) => `
      <article class="task" data-task-key="${task.key}">
        <p class="task-key">${task.key}</p>
        <h3 class="task-title">${escapeHtml(task.title || '')}</h3>
        <div class="task-meta">
          <span class="task-meta-badge ${statusClass(task.status)}">${statusLabels[task.status] || task.status}</span>
          <span>${formatDateTime(task.dueAt)}</span>
        </div>
      </article>
    `
    )
    .join('');
}

function renderAll() {
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

async function loadTasks(force = false) {
  state.loading = true;
  renderHeader();
  try {
    state.snapshot = force ? await window.taskara.refresh() : await window.taskara.list();
  } finally {
    state.loading = false;
    renderAll();
  }
}

nodes.refreshBtn.addEventListener('click', () => {
  void loadTasks(true);
});

nodes.list.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const taskNode = target.closest('[data-task-key]');
  if (!taskNode) return;
  const taskKey = taskNode.getAttribute('data-task-key');
  if (!taskKey) return;
  void window.taskara.openTask(taskKey);
});

const unsubscribe = window.taskara.onRefreshRequested(() => {
  void loadTasks(true);
});

window.addEventListener('beforeunload', () => {
  unsubscribe?.();
});

void loadTasks(true);

