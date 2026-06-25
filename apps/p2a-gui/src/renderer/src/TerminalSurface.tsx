import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_UI_LOCALE } from "../../shared/ipc";
import { uiCopy, type UiCopy } from "./i18n";
import type { AgentTool, TerminalSessionInfo, UiLocale } from "../../shared/ipc";

type TerminalSurfaceProps = {
  cwd: string | null | undefined;
  command: string | null | undefined;
  agentTool: AgentTool | null;
  taskId: string | null | undefined;
  taskPrompt: string | null | undefined;
  locale?: UiLocale;
};

type TerminalStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "killing"
  | "exited"
  | "error";

type TerminalInputMode = "message" | "passthrough";

type TerminalSize = {
  cols: number;
  rows: number;
};

function normalizeCommand(value: string | null | undefined, copy: UiCopy): string {
  return value?.trim() || copy.terminal.noCommandGuidance;
}

function normalizeCwd(value: string | null | undefined): string {
  return value?.trim() || "<project>";
}

function createIdleTranscript({
  cwd,
  command,
  agentTool,
  taskId,
  taskPrompt,
  copy,
}: Required<Omit<TerminalSurfaceProps, "locale">> & { copy: UiCopy }): string[] {
  const promptPreview = taskPrompt
    ? taskPrompt.split(/\s+/).slice(0, 18).join(" ")
    : copy.terminal.noSelectedTaskPrompt;

  return [
    `\x1b[38;5;244m${copy.terminal.idleTitle}\x1b[0m\r\n`,
    `\x1b[38;5;244m# cwd\x1b[0m ${cwd}\r\n`,
    `\x1b[38;5;244m# agent\x1b[0m ${agentTool ?? "manual"}\r\n`,
    taskId
      ? `\x1b[38;5;244m# task\x1b[0m ${taskId}\r\n`
      : `\x1b[38;5;244m# task\x1b[0m ${copy.common.none}\r\n`,
    "\r\n",
    `\x1b[38;5;244m# preview\x1b[0m ${command}\r\n`,
    "\r\n",
    `\x1b[38;5;109m[renderer]\x1b[0m ${copy.terminal.stdinBoundary}\r\n`,
    agentTool
      ? `\x1b[38;5;109m[pty]\x1b[0m ${copy.terminal.startLaunches}\r\n`
      : `\x1b[38;5;109m[pty]\x1b[0m ${copy.terminal.manualMode}\r\n`,
    `\x1b[38;5;109m[links]\x1b[0m ${copy.terminal.linksActive}\r\n`,
    `\x1b[38;5;109m[${copy.terminal.promptPreview}]\x1b[0m ${promptPreview}\r\n`,
  ];
}

export function TerminalSurface({
  cwd,
  command,
  agentTool,
  taskId,
  taskPrompt,
  locale = DEFAULT_UI_LOCALE,
}: TerminalSurfaceProps) {
  const copy = uiCopy[locale];
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeSessionRef = useRef<TerminalSessionInfo | null>(null);
  const statusRef = useRef<TerminalStatus>("idle");
  const inputModeRef = useRef<TerminalInputMode>("message");
  const [size, setSize] = useState<TerminalSize>({ cols: 0, rows: 0 });
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [inputMode, setInputMode] = useState<TerminalInputMode>("message");
  const [activeSession, setActiveSession] = useState<TerminalSessionInfo | null>(null);
  const [lastExitText, setLastExitText] = useState<string | null>(null);

  function updateStatus(nextStatus: TerminalStatus) {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }

  function updateInputMode(nextMode: TerminalInputMode) {
    inputModeRef.current = nextMode;
    setInputMode(nextMode);
    if (nextMode === "passthrough") {
      window.requestAnimationFrame(() => terminalRef.current?.focus());
    }
  }

  const idleTranscript = useMemo(() => {
    return createIdleTranscript({
      cwd: normalizeCwd(cwd),
      command: normalizeCommand(command, copy),
      agentTool,
      taskId: taskId ?? null,
      taskPrompt: taskPrompt ?? null,
      copy,
    });
  }, [agentTool, command, copy, cwd, taskId, taskPrompt]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    inputModeRef.current = inputMode;
  }, [inputMode]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const passthroughActive = status === "running" && inputMode === "passthrough";
    terminal.options.disableStdin = !passthroughActive;
    if (passthroughActive) {
      window.requestAnimationFrame(() => terminal.focus());
    }
  }, [inputMode, status]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 2000,
      theme: {
        background: "#0F0F0D",
        foreground: "#C4BFAE",
        cursor: "#FF5B2E",
        selectionBackground: "#2D2A1F",
        black: "#0A0A09",
        brightBlack: "#5C5A52",
        red: "#E5654B",
        brightRed: "#E5654B",
        green: "#8FB66B",
        brightGreen: "#8FB66B",
        yellow: "#E0A647",
        brightYellow: "#E0A647",
        blue: "#6B9BB8",
        brightBlue: "#6B9BB8",
        magenta: "#C4BFAE",
        brightMagenta: "#C4BFAE",
        cyan: "#6B9BB8",
        brightCyan: "#6B9BB8",
        white: "#EFEAD8",
        brightWhite: "#EFEAD8",
      },
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      terminal.write(`\r\n\x1b[38;5;172m[link]\x1b[0m ${uri}\r\n`);
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    const dataDisposable = terminal.onData((data) => {
      const session = activeSessionRef.current;
      if (!session || statusRef.current !== "running" || inputModeRef.current !== "passthrough") {
        return;
      }
      void window.p2a.terminal.input({
        sessionId: session.sessionId,
        data,
      });
    });
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      fitAddon.fit();
      const proposed = fitAddon.proposeDimensions();
      if (proposed) {
        setSize({ cols: proposed.cols, rows: proposed.rows });
        const session = activeSessionRef.current;
        if (session) {
          void window.p2a.terminal.resize({
            sessionId: session.sessionId,
            cols: proposed.cols,
            rows: proposed.rows,
          });
        }
      }
    };

    fit();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    return () => {
      const session = activeSessionRef.current;
      if (session) {
        void window.p2a.terminal.stop({ sessionId: session.sessionId });
      }
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      activeSessionRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || activeSessionRef.current) return undefined;

    terminal.reset();
    terminal.write(idleTranscript.join(""));

    return undefined;
  }, [idleTranscript]);

  useEffect(() => {
    const offData = window.p2a.terminal.onData((event) => {
      const session = activeSessionRef.current;
      if (!session || event.sessionId !== session.sessionId) return;
      terminalRef.current?.write(event.data);
    });
    const offExit = window.p2a.terminal.onExit((event) => {
      const session = activeSessionRef.current;
      if (!session || event.sessionId !== session.sessionId) return;

      const exitText = `exit ${event.exitCode}${event.signal ? ` signal ${event.signal}` : ""}`;
      terminalRef.current?.write(`\r\n\x1b[38;5;172m[session]\x1b[0m ${exitText}\r\n`);
      activeSessionRef.current = null;
      setActiveSession(null);
      updateStatus("exited");
      setLastExitText(exitText);
    });

    return () => {
      offData();
      offExit();
    };
  }, []);

  async function startSession() {
    const terminal = terminalRef.current;
    const normalizedCwd = cwd?.trim();
    if (!terminal) return undefined;
    if (
      !normalizedCwd ||
      !agentTool ||
      status === "starting" ||
      status === "running" ||
      status === "stopping" ||
      status === "killing"
    ) {
      return undefined;
    }

    terminal.reset();
    terminal.write(
      `\x1b[38;5;172m[session]\x1b[0m ${copy.terminal.startingSession}: ${agentTool} · ${normalizedCwd}\r\n`,
    );
    updateInputMode("passthrough");
    updateStatus("starting");
    setLastExitText(null);

    try {
      const session = await window.p2a.terminal.start({
        cwd: normalizedCwd,
        agentTool,
        cols: size.cols || 100,
        rows: size.rows || 28,
        taskId: taskId ?? null,
      });
      activeSessionRef.current = session;
      setActiveSession(session);
      updateStatus("running");
      terminal.write(
        `\x1b[38;5;109m[session]\x1b[0m ${copy.terminal.sessionStarted}: pid ${session.pid} · ${session.command} ${session.args.join(" ")}\r\n`,
      );
      terminal.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStatus("error");
      terminal.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }

    return undefined;
  }

  async function stopSession() {
    const session = activeSessionRef.current;
    if (!session || status === "stopping" || status === "killing") return;

    updateStatus("stopping");
    terminalRef.current?.write(
      `\r\n\x1b[38;5;172m[session]\x1b[0m ${copy.terminal.stoppingSession}\r\n`,
    );
    try {
      await window.p2a.terminal.stop({ sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStatus("error");
      terminalRef.current?.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }
  }

  async function killSession() {
    const session = activeSessionRef.current;
    if (!session || status === "stopping" || status === "killing") return;

    updateStatus("killing");
    terminalRef.current?.write(
      `\r\n\x1b[38;5;167m[session]\x1b[0m ${copy.terminal.killingSession}\r\n`,
    );
    try {
      await window.p2a.terminal.kill({ sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateStatus("error");
      terminalRef.current?.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }
  }

  const isSessionChanging = status === "starting" || status === "stopping" || status === "killing";
  const canStartSession = Boolean(cwd) && Boolean(agentTool) && !activeSession && !isSessionChanging;
  const terminalHint =
    inputMode === "passthrough" ? copy.terminal.passthroughHint : copy.terminal.messageHint;

  return (
    <section className="xterm-panel" aria-label={copy.terminal.ptyTerminalSurface}>
      <div className="xterm-panel__bar">
        <span className={`dot dot--${status === "running" ? "active" : "idle"}`} aria-hidden="true" />
        <strong className="mono">node-pty</strong>
        <span className="mono">{status}</span>
        <span className="mono">{inputMode}</span>
        <span className="mono">{copy.terminal.lastExit} {lastExitText ?? copy.common.none}</span>
        <span className="xterm-panel__spacer" />
        <button
          className="terminal-control"
          type="button"
          onClick={startSession}
          disabled={!canStartSession}
        >
          {copy.terminal.startSession}
        </button>
        <button
          className="terminal-control"
          type="button"
          onClick={stopSession}
          disabled={!activeSession || isSessionChanging}
        >
          {copy.terminal.stop}
        </button>
        <button
          className="terminal-control terminal-control--danger"
          type="button"
          onClick={killSession}
          disabled={!activeSession || isSessionChanging}
        >
          {copy.terminal.kill}
        </button>
        <span className="mono">
          {size.cols && size.rows ? `${size.cols}x${size.rows}` : copy.terminal.fitting}
        </span>
      </div>
      <div className="xterm-host" ref={hostRef} />
      <div className="terminal-footer">
        <div className="terminal-footer__mode">
          <span className="label">{copy.terminal.inputMode}</span>
          <div className="terminal-mode-toggle" role="group" aria-label={copy.terminal.inputMode}>
            <button
              className={
                inputMode === "message"
                  ? "terminal-mode-toggle__item terminal-mode-toggle__item--active"
                  : "terminal-mode-toggle__item"
              }
              type="button"
              onClick={() => updateInputMode("message")}
            >
              {copy.terminal.message}
            </button>
            <button
              className={
                inputMode === "passthrough"
                  ? "terminal-mode-toggle__item terminal-mode-toggle__item--active"
                  : "terminal-mode-toggle__item"
              }
              type="button"
              onClick={() => updateInputMode("passthrough")}
            >
              {copy.terminal.passthrough}
            </button>
          </div>
        </div>
        <span>{terminalHint}</span>
      </div>
    </section>
  );
}
