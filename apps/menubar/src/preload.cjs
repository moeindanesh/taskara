const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskara', {
  list: () => ipcRenderer.invoke('taskara:list'),
  refresh: () => ipcRenderer.invoke('taskara:refresh'),
  syncNow: () => ipcRenderer.invoke('taskara:sync'),
  updateTask: (taskKey, patch) => ipcRenderer.invoke('taskara:update-task', taskKey, patch),
  openTask: (taskKey) => ipcRenderer.invoke('taskara:open-task', taskKey),
  openWebsite: () => ipcRenderer.invoke('taskara:open-web'),
  onRefreshRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('taskara:refresh', listener);
    return () => ipcRenderer.removeListener('taskara:refresh', listener);
  }
});
