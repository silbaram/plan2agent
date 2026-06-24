import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AgentTool,
  type ArtifactFileReadRequest,
  type ArtifactFileReadResult,
  type ExecutionCommandResult,
  type ExecutionFinishRunRequest,
  type ExecutionStartRunRequest,
  type GuiConfigSnapshot,
  type OrchestrationMarkRoleRequest,
  type P2AApi,
  type ProjectLoadOptions,
  type ProjectOpenResult,
  type ProjectSnapshot,
  type ProjectWatchEvent,
  type RuntimeInfo,
  type TerminalSessionDataEvent,
  type TerminalSessionExitEvent,
  type TerminalSessionInfo,
  type TerminalSessionInputRequest,
  type TerminalSessionKillRequest,
  type TerminalSessionResizeRequest,
  type TerminalSessionStartRequest,
  type TerminalSessionStopRequest,
  type UiLocale,
} from "../shared/ipc";

const p2aApi: P2AApi = {
  app: {
    getRuntimeInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.appGetRuntimeInfo) as Promise<RuntimeInfo>,
  },
  config: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.configGet) as Promise<GuiConfigSnapshot>,
    setLocale: (locale: UiLocale) =>
      ipcRenderer.invoke(IPC_CHANNELS.configSetLocale, locale) as Promise<GuiConfigSnapshot>,
  },
  project: {
    openFolder: () =>
      ipcRenderer.invoke(IPC_CHANNELS.projectOpenFolder) as Promise<ProjectOpenResult>,
    load: (rootPath, options?: ProjectLoadOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.projectLoad, rootPath, options) as Promise<ProjectSnapshot>,
    forgetRecent: (rootPath) =>
      ipcRenderer.invoke(IPC_CHANNELS.projectForgetRecent, rootPath) as Promise<GuiConfigSnapshot>,
    setDefaultAgentTool: (rootPath, agentTool: AgentTool) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.projectSetDefaultAgentTool,
        rootPath,
        agentTool,
      ) as Promise<GuiConfigSnapshot>,
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, watchEvent: ProjectWatchEvent) => {
        callback(watchEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.projectChanged, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.projectChanged, listener);
      };
    },
  },
  artifact: {
    readFile: (request: ArtifactFileReadRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactReadFile, request) as Promise<ArtifactFileReadResult>,
  },
  terminal: {
    start: (request: TerminalSessionStartRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalStart, request) as Promise<TerminalSessionInfo>,
    input: (request: TerminalSessionInputRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalInput, request) as Promise<void>,
    resize: (request: TerminalSessionResizeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request) as Promise<void>,
    stop: (request: TerminalSessionStopRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalStop, request) as Promise<void>,
    kill: (request: TerminalSessionKillRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalKill, request) as Promise<void>,
    onData: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, dataEvent: TerminalSessionDataEvent) => {
        callback(dataEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.terminalData, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalData, listener);
      };
    },
    onExit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, exitEvent: TerminalSessionExitEvent) => {
        callback(exitEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.terminalExit, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalExit, listener);
      };
    },
  },
  execution: {
    startRun: (request: ExecutionStartRunRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.executionStartRun, request) as Promise<ExecutionCommandResult>,
    finishRun: (request: ExecutionFinishRunRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.executionFinishRun, request) as Promise<ExecutionCommandResult>,
  },
  orchestration: {
    markRole: (request: OrchestrationMarkRoleRequest) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.orchestrationMarkRole,
        request,
      ) as Promise<ExecutionCommandResult>,
  },
};

contextBridge.exposeInMainWorld("p2a", p2aApi);
export type { P2AApi };
