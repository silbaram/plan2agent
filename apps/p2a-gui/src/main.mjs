import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { inspectProject } from './project-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = path.resolve(path.dirname(__filename), '..');
const RENDERER_ENTRY = path.join(APP_ROOT, 'renderer', 'index.html');
const PRELOAD_ENTRY = path.join(APP_ROOT, 'src', 'preload.cjs');
const WATCH_DEBOUNCE_MS = 300;

let mainWindow = null;
let currentProjectPath = parseProjectArg(process.argv);
let currentInspection = null;
let currentWatcher = null;
let reloadTimer = null;

function parseProjectArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      const value = argv[index + 1];
      return value && value !== '--' ? path.resolve(value) : null;
    }
    if (arg?.startsWith('--project=')) {
      return path.resolve(arg.slice('--project='.length));
    }
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Plan2Agent',
    backgroundColor: '#0F0F0D',
    webPreferences: {
      preload: PRELOAD_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(RENDERER_ENTRY);
  mainWindow.on('closed', () => {
    closeProjectWatcher();
    mainWindow = null;
  });
}

function closeProjectWatcher() {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
}

function scheduleProjectReload() {
  if (!currentProjectPath || !mainWindow || mainWindow.isDestroyed()) return;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    currentInspection = inspectProject(currentProjectPath);
    mainWindow.webContents.send('p2a:project-updated', {
      projectPath: currentProjectPath,
      inspection: currentInspection,
      refreshedAt: new Date().toISOString(),
      trigger: 'watcher',
    });
  }, WATCH_DEBOUNCE_MS);
}

function watchProject(projectPath) {
  closeProjectWatcher();
  if (!projectPath || !existsSync(projectPath)) return;
  try {
    currentWatcher = watch(projectPath, { recursive: true }, scheduleProjectReload);
  } catch (error) {
    if (currentInspection) {
      currentInspection.diagnostics.push({
        severity: 'warning',
        code: 'watcher_unavailable',
        message: `File watcher could not start: ${error.message}`,
        path: projectPath,
      });
    }
  }
}

function loadProject(projectPath) {
  currentProjectPath = path.resolve(projectPath);
  currentInspection = inspectProject(currentProjectPath);
  watchProject(currentProjectPath);
  return currentInspection;
}

function currentPayload(trigger = 'manual') {
  if (!currentProjectPath) {
    return {
      projectPath: null,
      inspection: null,
      refreshedAt: new Date().toISOString(),
      trigger,
    };
  }
  currentInspection = inspectProject(currentProjectPath);
  watchProject(currentProjectPath);
  return {
    projectPath: currentProjectPath,
    inspection: currentInspection,
    refreshedAt: new Date().toISOString(),
    trigger,
  };
}

ipcMain.handle('p2a:get-initial-state', async () => currentPayload('initial'));

ipcMain.handle('p2a:select-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open P2A project',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return currentPayload('dialog-cancelled');
  const inspection = loadProject(result.filePaths[0]);
  return {
    projectPath: currentProjectPath,
    inspection,
    refreshedAt: new Date().toISOString(),
    trigger: 'folder-picker',
  };
});

ipcMain.handle('p2a:reload-project', async () => currentPayload('reload'));

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeProjectWatcher();
  if (process.platform !== 'darwin') app.quit();
});
