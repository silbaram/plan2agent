import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { type WebContents } from "electron";
import * as pty from "node-pty";
import { IPC_CHANNELS, type TerminalSessionInfo, type TerminalSessionStartRequest } from "../shared/ipc";
import {
  isAgentTool,
  normalizePtyDimension,
  resolveAgentCommand,
  resolveTerminalStopSignal,
} from "./terminalCommands";

type PtySession = {
  id: string;
  ownerWebContentsId: number;
  process: pty.IPty;
  info: TerminalSessionInfo;
};

export class PtySessionManager {
  private readonly sessions = new Map<string, PtySession>();

  start(sender: WebContents, request: TerminalSessionStartRequest): TerminalSessionInfo {
    const cwd = this.normalizeCwd(request.cwd);
    const agentTool = request.agentTool;
    if (!isAgentTool(agentTool)) {
      throw new Error(`Unsupported agent tool: ${String(agentTool)}`);
    }

    this.stopAllForSender(sender.id);

    const resolved = resolveAgentCommand(agentTool);
    const cols = normalizePtyDimension(request.cols, 100);
    const rows = normalizePtyDimension(request.rows, 28);
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      P2A_GUI_SESSION: sessionId,
    };

    const child = pty.spawn(resolved.command, resolved.args, {
      cols,
      rows,
      cwd,
      env,
      name: "xterm-256color",
    });
    const info: TerminalSessionInfo = {
      sessionId,
      pid: child.pid,
      command: resolved.command,
      args: resolved.args,
      cwd,
      agentTool,
      taskId: request.taskId ?? null,
      startedAt,
    };
    const session: PtySession = {
      id: sessionId,
      ownerWebContentsId: sender.id,
      process: child,
      info,
    };

    this.sessions.set(sessionId, session);
    child.onData((data) => {
      if (!sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.terminalData, { sessionId, data });
      }
    });
    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      if (!sender.isDestroyed()) {
        sender.send(IPC_CHANNELS.terminalExit, {
          sessionId,
          exitCode,
          signal: signal ?? null,
          exitedAt: new Date().toISOString(),
        });
      }
    });

    return info;
  }

  write(sender: WebContents, sessionId: string, data: string): void {
    const session = this.requireOwnedSession(sender.id, sessionId);
    session.process.write(data);
  }

  resize(sender: WebContents, sessionId: string, cols: number, rows: number): void {
    const session = this.requireOwnedSession(sender.id, sessionId);
    session.process.resize(
      normalizePtyDimension(cols, session.process.cols),
      normalizePtyDimension(rows, session.process.rows),
    );
  }

  stop(sender: WebContents, sessionId: string): void {
    const session = this.requireOwnedSession(sender.id, sessionId);
    this.terminateSession(session, "stop");
  }

  kill(sender: WebContents, sessionId: string): void {
    const session = this.requireOwnedSession(sender.id, sessionId);
    this.terminateSession(session, "kill");
  }

  stopAllForSender(ownerWebContentsId: number): void {
    for (const session of this.sessions.values()) {
      if (session.ownerWebContentsId === ownerWebContentsId) {
        this.killSession(session);
      }
    }
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      this.killSession(session);
    }
  }

  private normalizeCwd(cwd: string): string {
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      throw new Error("terminal:start requires cwd");
    }
    const normalized = path.resolve(cwd);
    try {
      if (!statSync(normalized).isDirectory()) {
        throw new Error(`cwd is not a directory: ${normalized}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("cwd is not a directory")) {
        throw error;
      }
      throw new Error(`cwd does not exist: ${normalized}`);
    }
    return normalized;
  }

  private requireOwnedSession(ownerWebContentsId: number, sessionId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`terminal session not found: ${sessionId}`);
    }
    if (session.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error(`terminal session ownership mismatch: ${sessionId}`);
    }
    return session;
  }

  private killSession(session: PtySession): void {
    this.terminateSession(session, "stop");
  }

  private terminateSession(session: PtySession, intent: "stop" | "kill"): void {
    this.sessions.delete(session.id);
    try {
      const signal = resolveTerminalStopSignal(intent);
      session.process.kill(signal);
    } catch {
      // The process may have already exited between user action and cleanup.
    }
  }
}
