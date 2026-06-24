import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
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
const CONFIG_FILENAME = 'p2a-gui-config.json';
const CONFIG_SCHEMA_VERSION = 'p2a.gui_config.v1';
const MAX_RECENT_PROJECTS = 8;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const ARTIFACT_DEFINITIONS = [
  { id: 'status', label: 'status.md', group: 'overview', pathKey: 'statusPath', format: 'markdown' },
  { id: 'intake', label: 'intake.json', group: 'gate-a', pathKey: 'intakePath', format: 'json' },
  { id: 'current-spec', label: 'current-spec.json', group: 'iteration', pathKey: 'currentSpecPath', format: 'json' },
  { id: 'spec', label: 'spec.json', group: 'gate-b', pathKey: 'specPath', format: 'json' },
  { id: 'task-graph', label: 'task-graph.json', group: 'gate-c', pathKey: 'taskGraphPath', format: 'json' },
  { id: 'review', label: 'review.json', group: 'gate-d', pathKey: 'reviewPath', format: 'json' },
];

let mainWindow = null;
let currentProjectPath = null;
let currentInspection = null;
let currentWatcher = null;
let reloadTimer = null;
let appConfig = defaultConfig();
let configError = null;

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

function defaultConfig() {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    lastProjectPath: null,
    recentProjects: [],
  };
}

function configFilePath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

function normalizeConfig(value) {
  const config = defaultConfig();
  if (!value || typeof value !== 'object') return config;
  if (typeof value.lastProjectPath === 'string' && value.lastProjectPath.length) {
    config.lastProjectPath = path.resolve(value.lastProjectPath);
  }
  if (Array.isArray(value.recentProjects)) {
    const seen = new Set();
    config.recentProjects = value.recentProjects
      .filter((entry) => entry && typeof entry.path === 'string' && entry.path.length)
      .map((entry) => ({
        path: path.resolve(entry.path),
        projectId: typeof entry.projectId === 'string' && entry.projectId.length ? entry.projectId : path.basename(entry.path),
        state: typeof entry.state === 'string' && entry.state.length ? entry.state : 'unknown',
        sourceLayout: typeof entry.sourceLayout === 'string' && entry.sourceLayout.length ? entry.sourceLayout : null,
        lastOpenedAt: typeof entry.lastOpenedAt === 'string' && entry.lastOpenedAt.length ? entry.lastOpenedAt : null,
      }))
      .filter((entry) => {
        if (seen.has(entry.path)) return false;
        seen.add(entry.path);
        return true;
      })
      .slice(0, MAX_RECENT_PROJECTS);
  }
  return config;
}

function readAppConfig() {
  try {
    const filePath = configFilePath();
    if (!existsSync(filePath)) {
      appConfig = defaultConfig();
      configError = null;
      return;
    }
    appConfig = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')));
    configError = null;
  } catch (error) {
    appConfig = defaultConfig();
    configError = `Could not read local config: ${error.message}`;
  }
}

function writeAppConfig() {
  try {
    const filePath = configFilePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(appConfig, null, 2)}\n`);
    configError = null;
  } catch (error) {
    configError = `Could not write local config: ${error.message}`;
  }
}

function publicLocalConfig() {
  return {
    configPath: configFilePath(),
    lastProjectPath: appConfig.lastProjectPath,
    recentProjects: appConfig.recentProjects,
    error: configError,
  };
}

function rememberProject(projectPath, inspection) {
  const normalizedPath = path.resolve(projectPath);
  const entry = {
    path: normalizedPath,
    projectId: inspection?.projectId ?? path.basename(normalizedPath),
    state: inspection?.state ?? 'unknown',
    sourceLayout: inspection?.artifactSource?.sourceLayout ?? null,
    lastOpenedAt: new Date().toISOString(),
  };
  appConfig = {
    ...appConfig,
    lastProjectPath: normalizedPath,
    recentProjects: [
      entry,
      ...appConfig.recentProjects.filter((project) => project.path !== normalizedPath),
    ].slice(0, MAX_RECENT_PROJECTS),
  };
  writeAppConfig();
}

function isRecentProjectPath(projectPath) {
  if (!projectPath) return false;
  const normalizedPath = path.resolve(projectPath);
  return appConfig.recentProjects.some((project) => project.path === normalizedPath);
}

function fileStats(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function displayProjectPath(filePath) {
  if (!filePath || !currentProjectPath) return filePath;
  const relativePath = path.relative(currentProjectPath, filePath);
  if (!relativePath || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) return relativePath || '.';
  return filePath;
}

function artifactDocument(id, label, group, filePath, format, stats) {
  return {
    id,
    label,
    group,
    format,
    path: filePath,
    displayPath: displayProjectPath(filePath),
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function buildArtifactCatalog(inspection = currentInspection) {
  if (!inspection?.artifactSource) {
    return {
      artifactRoot: null,
      runsDir: inspection?.runs?.runsDir ?? null,
      documents: [],
    };
  }

  const documents = [];
  const seenPaths = new Set();
  for (const definition of ARTIFACT_DEFINITIONS) {
    const filePath = inspection.artifactSource[definition.pathKey];
    const stats = fileStats(filePath);
    if (!stats || seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    documents.push(artifactDocument(definition.id, definition.label, definition.group, filePath, definition.format, stats));
  }

  const runsDir = inspection.runs?.runsDir ?? null;
  const runIndexStats = fileStats(inspection.runs?.indexPath);
  if (runIndexStats && !seenPaths.has(inspection.runs.indexPath)) {
    seenPaths.add(inspection.runs.indexPath);
    documents.push(artifactDocument('run-index', 'run-index.json', 'runs', inspection.runs.indexPath, 'json', runIndexStats));
  }
  if (runsDir && existsSync(runsDir)) {
    try {
      const runFiles = readdirSync(runsDir)
        .filter((entry) => entry.endsWith('.json') && entry !== 'run-index.json')
        .sort();
      for (const entry of runFiles) {
        const filePath = path.join(runsDir, entry);
        const stats = fileStats(filePath);
        if (!stats || seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);
        documents.push(artifactDocument(`run:${entry}`, entry, 'runs', filePath, 'json', stats));
      }
    } catch {
      // The read model already reports run index diagnostics; keep the viewer best-effort.
    }
  }

  return {
    artifactRoot: inspection.artifactSource.artifactRoot,
    runsDir,
    documents,
  };
}

function currentArtifactCatalogPayload() {
  return buildArtifactCatalog(currentInspection);
}

function readArtifactDocument(artifactId) {
  const catalog = currentArtifactCatalogPayload();
  const document = catalog.documents.find((item) => item.id === artifactId);
  if (!document) {
    return {
      ok: false,
      code: 'artifact_not_found',
      message: 'Artifact is not available for the current project.',
      catalog,
    };
  }
  if (document.sizeBytes > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      code: 'artifact_too_large',
      message: `Artifact is larger than ${MAX_ARTIFACT_BYTES} bytes.`,
      document,
      catalog,
    };
  }

  try {
    const rawContent = readFileSync(document.path, 'utf8');
    let content = rawContent;
    let parseError = null;
    if (document.format === 'json') {
      try {
        content = JSON.stringify(JSON.parse(rawContent), null, 2);
      } catch (error) {
        parseError = error.message;
      }
    }

    return {
      ok: true,
      document,
      content,
      parseError,
      catalog,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'artifact_read_failed',
      message: error.message,
      document,
      catalog,
    };
  }
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
      artifactCatalog: currentArtifactCatalogPayload(),
      localConfig: publicLocalConfig(),
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
  rememberProject(currentProjectPath, currentInspection);
  return currentInspection;
}

function currentPayload(trigger = 'manual') {
  if (!currentProjectPath) {
    return {
      projectPath: null,
      inspection: null,
      artifactCatalog: buildArtifactCatalog(null),
      localConfig: publicLocalConfig(),
      refreshedAt: new Date().toISOString(),
      trigger,
    };
  }
  currentInspection = inspectProject(currentProjectPath);
  watchProject(currentProjectPath);
  rememberProject(currentProjectPath, currentInspection);
  return {
    projectPath: currentProjectPath,
    inspection: currentInspection,
    artifactCatalog: currentArtifactCatalogPayload(),
    localConfig: publicLocalConfig(),
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
    artifactCatalog: currentArtifactCatalogPayload(),
    localConfig: publicLocalConfig(),
    refreshedAt: new Date().toISOString(),
    trigger: 'folder-picker',
  };
});

ipcMain.handle('p2a:reload-project', async () => currentPayload('reload'));

ipcMain.handle('p2a:read-artifact', async (_event, artifactId) => readArtifactDocument(artifactId));

ipcMain.handle('p2a:open-recent-project', async (_event, projectPath) => {
  if (!isRecentProjectPath(projectPath)) return currentPayload('recent-rejected');
  const inspection = loadProject(projectPath);
  return {
    projectPath: currentProjectPath,
    inspection,
    artifactCatalog: currentArtifactCatalogPayload(),
    localConfig: publicLocalConfig(),
    refreshedAt: new Date().toISOString(),
    trigger: 'recent-project',
  };
});

app.whenReady().then(() => {
  readAppConfig();
  currentProjectPath = parseProjectArg(process.argv) ?? appConfig.lastProjectPath;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeProjectWatcher();
  if (process.platform !== 'darwin') app.quit();
});
