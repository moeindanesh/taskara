import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('taskara', {
  list: () => ipcRenderer.invoke('taskara:list'),
  refresh: () => ipcRenderer.invoke('taskara:refresh'),
  openTask: (taskKey) => ipcRenderer.invoke('taskara:open-task', taskKey),
  onRefreshRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('taskara:refresh', listener);
    return () => ipcRenderer.removeListener('taskara:refresh', listener);
  }
});
