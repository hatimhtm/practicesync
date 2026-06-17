'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  setAI: (cfg) => ipcRenderer.invoke('ai:set', cfg),
  parseRoster: (text) => ipcRenderer.invoke('roster:parse', { text }),
  saveRoster: (data) => ipcRenderer.invoke('roster:save', data),
  loadDemo: () => ipcRenderer.invoke('demo:load'),
  runSync: (opts) => ipcRenderer.invoke('run:sync', opts),
  runNow: () => ipcRenderer.invoke('run:now'),
  teach: (target, url) => ipcRenderer.invoke('teach:run', { target, url }),
  onRunStatus: (cb) => ipcRenderer.on('run-status', (_e, s) => cb(s)),
  onRunFinished: (cb) => ipcRenderer.on('run-finished', (_e, r) => cb(r)),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
});
