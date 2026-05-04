const DB_NAME = 'taskara-notification-sw';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const SEEN_STORE = 'seen';
const DELIVERED_QUEUE_STORE = 'deliveredQueue';
const STATE_KEY = 'notificationState';
const SYNC_TAG = 'taskara-notifications-sync';
const MAX_SEEN_ITEMS = 2000;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'TASKARA_SW_CONFIG') {
    event.waitUntil(saveConfig(data.payload));
    return;
  }

  if (data.type === 'TASKARA_SW_SET_ENABLED') {
    event.waitUntil(patchState({ notificationsEnabled: data.payload?.enabled !== false }));
    return;
  }

  if (data.type === 'TASKARA_SW_SYNC') {
    event.waitUntil(syncNotifications('message'));
  }
});

self.addEventListener('push', (event) => {
  event.waitUntil(syncNotifications('push'));
});

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(syncNotifications('background-sync'));
});

self.addEventListener('notificationclick', (event) => {
  const targetUrl = event.notification?.data?.url;
  event.notification.close();

  event.waitUntil(
    (async () => {
      if (!targetUrl) return;

      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          await client.focus();
          return;
        }
      }

      await self.clients.openWindow(targetUrl);
    })()
  );
});

async function syncNotifications(source) {
  const state = await getState();
  if (!state?.token || !state?.workspaceSlug || !state?.apiBaseUrl) return;
  if (state.notificationsEnabled === false) return;

  await flushDeliveredQueue(state);

  const url = new URL('/notifications/sync', state.apiBaseUrl);
  url.searchParams.set('limit', '50');
  if (state.cursor) {
    url.searchParams.set('after', state.cursor);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-workspace-slug': state.workspaceSlug,
      accept: 'application/json',
    },
    cache: 'no-store',
  }).catch(() => null);

  if (!response || !response.ok) return;

  const payload = await response.json().catch(() => null);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const deliveredIds = [];
  let displayed = 0;

  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;

    if (await hasSeenNotification(item.id)) continue;

    await rememberSeenNotification(item.id);
    await showTaskaraNotification(item, state.workspaceSlug);
    deliveredIds.push(item.id);
    displayed += 1;
  }

  if (typeof payload?.nextCursor === 'string' && payload.nextCursor) {
    await patchState({ cursor: payload.nextCursor });
  }

  if (deliveredIds.length) {
    await enqueueDeliveredIds(deliveredIds);
    await flushDeliveredQueue(state);
  }

  if (displayed > 0) {
    await broadcastToClients({
      type: 'TASKARA_NOTIFICATIONS_UPDATED',
      source,
      count: displayed,
    });
  }
}

async function showTaskaraNotification(item, workspaceSlug) {
  const title = typeof item.title === 'string' && item.title ? item.title : 'Taskara';
  const body = typeof item.body === 'string' && item.body ? item.body : 'اعلان جدید';
  const icon = '/brand/taskara-logo-192.png';
  const notificationUrl = `/${workspaceSlug}/inbox`;

  await self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag: `taskara-notification-${item.id}`,
    data: {
      notificationId: item.id,
      url: notificationUrl,
    },
  });
}

async function saveConfig(config) {
  if (!config || typeof config !== 'object') return;
  if (
    typeof config.token !== 'string' ||
    !config.token ||
    typeof config.workspaceSlug !== 'string' ||
    !config.workspaceSlug ||
    typeof config.apiBaseUrl !== 'string' ||
    !config.apiBaseUrl
  ) {
    return;
  }

  const current = (await getState()) || {};
  await setState({
    ...current,
    token: config.token,
    workspaceSlug: config.workspaceSlug,
    apiBaseUrl: config.apiBaseUrl.replace(/\/$/, ''),
    notificationsEnabled: config.notificationsEnabled !== false,
  });
}

async function flushDeliveredQueue(state) {
  const ids = await listQueuedDeliveredIds();
  if (!ids.length) return;

  const url = new URL('/notifications/delivered', state.apiBaseUrl);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      'x-workspace-slug': state.workspaceSlug,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ ids }),
  }).catch(() => null);

  if (!response || !response.ok) return;
  await clearDeliveredQueue(ids);
}

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(SEEN_STORE)) {
        const store = db.createObjectStore(SEEN_STORE, { keyPath: 'id' });
        store.createIndex('byCreatedAt', 'createdAt');
      }

      if (!db.objectStoreNames.contains(DELIVERED_QUEUE_STORE)) {
        db.createObjectStore(DELIVERED_QUEUE_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open indexedDB'));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);

    let callbackResult;
    try {
      callbackResult = callback(store, tx);
    } catch (error) {
      reject(error);
      return;
    }

    tx.oncomplete = () => resolve(callbackResult);
    tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
  }).finally(() => {
    db.close();
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

async function getState() {
  return withStore(STATE_STORE, 'readonly', async (store) => {
    const record = await requestResult(store.get(STATE_KEY));
    return record?.value || null;
  });
}

async function setState(value) {
  await withStore(STATE_STORE, 'readwrite', (store) => {
    store.put({ key: STATE_KEY, value });
  });
}

async function patchState(partial) {
  const current = (await getState()) || {};
  await setState({ ...current, ...partial });
}

async function hasSeenNotification(id) {
  const record = await withStore(SEEN_STORE, 'readonly', async (store) => {
    return requestResult(store.get(id));
  });

  return Boolean(record);
}

async function rememberSeenNotification(id) {
  await withStore(SEEN_STORE, 'readwrite', (store) => {
    store.put({ id, createdAt: Date.now() });
  });

  await pruneSeenStore();
}

async function pruneSeenStore() {
  await withStore(SEEN_STORE, 'readwrite', async (store) => {
    const total = await requestResult(store.count());
    if (typeof total !== 'number' || total <= MAX_SEEN_ITEMS) return;

    const overflow = total - MAX_SEEN_ITEMS;
    let removed = 0;
    const cursorRequest = store.index('byCreatedAt').openCursor();

    await new Promise((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= overflow) {
          resolve();
          return;
        }

        store.delete(cursor.primaryKey);
        removed += 1;
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Failed to prune seen notifications'));
    });
  });
}

async function enqueueDeliveredIds(ids) {
  await withStore(DELIVERED_QUEUE_STORE, 'readwrite', (store) => {
    for (const id of ids) {
      store.put({ id });
    }
  });
}

async function listQueuedDeliveredIds() {
  return withStore(DELIVERED_QUEUE_STORE, 'readonly', async (store) => {
    const all = await requestResult(store.getAll());
    return all
      .map((item) => item?.id)
      .filter((id) => typeof id === 'string' && id);
  });
}

async function clearDeliveredQueue(ids) {
  if (!ids.length) return;

  await withStore(DELIVERED_QUEUE_STORE, 'readwrite', (store) => {
    for (const id of ids) {
      store.delete(id);
    }
  });
}
