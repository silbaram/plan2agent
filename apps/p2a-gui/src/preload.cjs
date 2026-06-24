const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('p2aGui', {
  getInitialState: () => ipcRenderer.invoke('p2a:get-initial-state'),
  selectProject: () => ipcRenderer.invoke('p2a:select-project'),
  reloadProject: () => ipcRenderer.invoke('p2a:reload-project'),
  onProjectUpdated: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('p2a:project-updated', listener);
    return () => ipcRenderer.removeListener('p2a:project-updated', listener);
  },
});
