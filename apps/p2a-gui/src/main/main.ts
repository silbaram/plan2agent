import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import path from "node:path";
import {
  IPC_CHANNELS,
  type AgentTool,
  type ExecutionFinishRunRequest,
  type ExecutionStartRunRequest,
  type ProjectOpenResult,
  type ProjectLoadOptions,
  type ProjectWatchEvent,
  type TerminalSessionInputRequest,
  type TerminalSessionKillRequest,
  type TerminalSessionResizeRequest,
  type TerminalSessionStartRequest,
  type TerminalSessionStopRequest,
  type RuntimeInfo,
} from "../shared/ipc";
import {
  configPathForUserData,
  forgetRecentProject,
  loadGuiConfig,
  readDefaultAgentTool,
  rememberRecentProject,
  setDefaultAgentTool,
} from "./localConfig";
import { PtySessionManager } from "./ptySessionManager";
import { finishRun, startRun } from "./executionActions";
import { loadProjectSnapshot } from "./projectLoader";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const DEV_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*;";

const PRODUCTION_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';";

let activeProjectWatcher: FSWatcher | null = null;
let activeProjectRoot: string | null = null;
let activeProjectDebounce: ReturnType<typeof setTimeout> | null = null;
const ptySessions = new PtySessionManager();

const IGNORED_WATCH_SEGMENTS = new Set([
  ".git",
  ".vite",
  "dist",
  "node_modules",
  "out",
]);

function applyEnvironmentOverrides(): void {
  const userDataPath = process.env.P2A_GUI_USER_DATA_DIR;
  if (userDataPath && userDataPath.trim().length > 0) {
    const resolvedUserDataPath = path.resolve(userDataPath);
    mkdirSync(resolvedUserDataPath, { recursive: true });
    app.setPath("userData", resolvedUserDataPath);
  }

  const remoteDebuggingPort = process.env.P2A_GUI_REMOTE_DEBUGGING_PORT;
  if (remoteDebuggingPort && /^[0-9]+$/.test(remoteDebuggingPort)) {
    app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  }
}

function runtimeInfo(): RuntimeInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
  };
}

function guiConfigPath(): string {
  return configPathForUserData(app.getPath("userData"));
}

async function loadProjectSnapshotWithConfig(rootPath: string) {
  const configPath = guiConfigPath();
  return loadProjectSnapshot(rootPath, {
    defaultAgentTool: await readDefaultAgentTool(configPath, rootPath),
  });
}

async function rememberSnapshotProject(snapshot: Awaited<ReturnType<typeof loadProjectSnapshot>>) {
  return rememberRecentProject(guiConfigPath(), {
    rootPath: snapshot.rootPath,
    name: snapshot.name,
  });
}

function closeProjectWatcher(): void {
  if (activeProjectDebounce) {
    clearTimeout(activeProjectDebounce);
    activeProjectDebounce = null;
  }
  activeProjectWatcher?.close();
  activeProjectWatcher = null;
  activeProjectRoot = null;
}

function normalizeWatchFilename(filename: string | Buffer | null): string | null {
  if (!filename) return null;
  return String(filename).split(path.sep).join("/");
}

function shouldIgnoreWatchPath(relativePath: string | null): boolean {
  if (!relativePath) return false;
  return relativePath.split(/[\\/]/).some((segment) => IGNORED_WATCH_SEGMENTS.has(segment));
}

function startProjectWatcher(rootPath: string, sender: Electron.WebContents): void {
  if (activeProjectRoot === rootPath && activeProjectWatcher) return;

  closeProjectWatcher();
  activeProjectRoot = rootPath;

  try {
    activeProjectWatcher = watch(rootPath, { recursive: true }, (eventType, filename) => {
      const relativePath = normalizeWatchFilename(filename);
      if (shouldIgnoreWatchPath(relativePath)) return;

      const watchEvent: ProjectWatchEvent = {
        rootPath,
        relativePath,
        eventType: eventType === "rename" || eventType === "change" ? eventType : "unknown",
        changedAt: new Date().toISOString(),
      };

      if (activeProjectDebounce) clearTimeout(activeProjectDebounce);
      activeProjectDebounce = setTimeout(() => {
        if (!sender.isDestroyed()) {
          sender.send(IPC_CHANNELS.projectChanged, watchEvent);
        }
      }, 300);
    });
  } catch {
    closeProjectWatcher();
  }
}

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    title: "P2A GUI",
    backgroundColor: "#0F0F0D",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    ptySessions.stopAllForSender(mainWindow.webContents.id);
    closeProjectWatcher();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.appGetRuntimeInfo, () => runtimeInfo());
  ipcMain.handle(IPC_CHANNELS.configGet, () => loadGuiConfig(guiConfigPath()));
  ipcMain.handle(IPC_CHANNELS.projectOpenFolder, async (event): Promise<ProjectOpenResult> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open P2A project",
    });
    const selectedPath = result.filePaths[0] ?? null;
    const snapshot = selectedPath ? await loadProjectSnapshotWithConfig(selectedPath) : null;
    if (snapshot) {
      await rememberSnapshotProject(snapshot);
      startProjectWatcher(snapshot.rootPath, event.sender);
    }

    return {
      canceled: result.canceled,
      path: selectedPath,
      snapshot,
    };
  });
  ipcMain.handle(
    IPC_CHANNELS.projectLoad,
    async (event, rootPath: string, options: ProjectLoadOptions = {}) => {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
        throw new Error("project:load requires a root path");
      }
      const snapshot = await loadProjectSnapshotWithConfig(rootPath);
      if (options.remember) {
        await rememberSnapshotProject(snapshot);
      }
      startProjectWatcher(snapshot.rootPath, event.sender);
      return snapshot;
    },
  );
  ipcMain.handle(IPC_CHANNELS.projectForgetRecent, async (_event, rootPath: string) => {
    if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
      throw new Error("project:forgetRecent requires a root path");
    }
    return forgetRecentProject(guiConfigPath(), rootPath);
  });
  ipcMain.handle(
    IPC_CHANNELS.projectSetDefaultAgentTool,
    async (_event, rootPath: string, agentTool: AgentTool) => {
      if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
        throw new Error("project:setDefaultAgentTool requires a root path");
      }
      return setDefaultAgentTool(guiConfigPath(), rootPath, agentTool);
    },
  );
  ipcMain.handle(IPC_CHANNELS.terminalStart, (event, request: TerminalSessionStartRequest) => {
    return ptySessions.start(event.sender, request);
  });
  ipcMain.handle(IPC_CHANNELS.terminalInput, (event, request: TerminalSessionInputRequest) => {
    if (!request || typeof request.sessionId !== "string" || typeof request.data !== "string") {
      throw new Error("terminal:input requires session id and data");
    }
    ptySessions.write(event.sender, request.sessionId, request.data);
  });
  ipcMain.handle(IPC_CHANNELS.terminalResize, (event, request: TerminalSessionResizeRequest) => {
    if (!request || typeof request.sessionId !== "string") {
      throw new Error("terminal:resize requires session id");
    }
    ptySessions.resize(event.sender, request.sessionId, request.cols, request.rows);
  });
  ipcMain.handle(IPC_CHANNELS.terminalStop, (event, request: TerminalSessionStopRequest) => {
    if (!request || typeof request.sessionId !== "string") {
      throw new Error("terminal:stop requires session id");
    }
    ptySessions.stop(event.sender, request.sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.terminalKill, (event, request: TerminalSessionKillRequest) => {
    if (!request || typeof request.sessionId !== "string") {
      throw new Error("terminal:kill requires session id");
    }
    ptySessions.kill(event.sender, request.sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.executionStartRun, (_event, request: ExecutionStartRunRequest) => {
    if (!request || typeof request.taskId !== "string") {
      throw new Error("execution:startRun requires a task id");
    }
    return startRun(request);
  });
  ipcMain.handle(IPC_CHANNELS.executionFinishRun, (_event, request: ExecutionFinishRunRequest) => {
    if (!request || typeof request.runId !== "string") {
      throw new Error("execution:finishRun requires a run id");
    }
    return finishRun(request);
  });
}

function installContentSecurityPolicy(): void {
  const contentSecurityPolicy = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? DEV_CONTENT_SECURITY_POLICY
    : PRODUCTION_CONTENT_SECURITY_POLICY;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy],
      },
    });
  });
}

applyEnvironmentOverrides();

app.whenReady().then(() => {
  installContentSecurityPolicy();
  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  ptySessions.stopAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
