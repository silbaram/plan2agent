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

type SupervisorNoteKind = "message" | "blocked" | "failed";

type SupervisorNote = {
  id: string;
  kind: SupervisorNoteKind;
  text: string;
  createdAt: string;
};

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

function formatNoteTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "now";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function encodeMessageForPty(value: string): string {
  const normalized = value.trim().replace(/\r?\n/g, "\r");
  return normalized.endsWith("\r") ? normalized : `${normalized}\r`;
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
  const [messageText, setMessageText] = useState<string>("");
  const [noteText, setNoteText] = useState<string>("");
  const [supervisorNotes, setSupervisorNotes] = useState<SupervisorNote[]>([]);

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
    terminal.options.disableStdin = status !== "running" || inputMode !== "passthrough";
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
      setStatus("exited");
      setLastExitText(exitText);
    });

    return () => {
      offData();
      offExit();
    };
  }, []);

  function addSupervisorNote(kind: SupervisorNoteKind, text: string) {
    const normalized = text.trim();
    if (!normalized) return;

    setSupervisorNotes((current) =>
      [
        {
          id: `${Date.now()}-${kind}`,
          kind,
          text: normalized,
          createdAt: new Date().toISOString(),
        },
        ...current,
      ].slice(0, 8),
    );
  }

  async function sendMessageAgent() {
    const session = activeSessionRef.current;
    const normalized = messageText.trim();
    if (!session || status !== "running" || !normalized) return;

    try {
      await window.p2a.terminal.input({
        sessionId: session.sessionId,
        data: encodeMessageForPty(normalized),
      });
      addSupervisorNote("message", normalized);
      setMessageText("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error");
      terminalRef.current?.write(`\r\n\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }
  }

  function recordSessionNote(kind: Exclude<SupervisorNoteKind, "message">) {
    const normalized = noteText.trim();
    if (!normalized) return;

    addSupervisorNote(kind, normalized);
    terminalRef.current?.write(
      `\r\n\x1b[38;5;172m[supervisor]\x1b[0m ${kind} · ${copy.common.localOnly}\r\n`,
    );
    setNoteText("");
  }

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
    setStatus("starting");
    setLastExitText(null);
    setSupervisorNotes([]);

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
      setStatus("running");
      terminal.write(
        `\x1b[38;5;109m[session]\x1b[0m ${copy.terminal.sessionStarted}: pid ${session.pid} · ${session.command} ${session.args.join(" ")}\r\n`,
      );
      terminal.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error");
      terminal.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }

    return undefined;
  }

  async function stopSession() {
    const session = activeSessionRef.current;
    if (!session || status === "stopping" || status === "killing") return;

    setStatus("stopping");
    terminalRef.current?.write(
      `\r\n\x1b[38;5;172m[session]\x1b[0m ${copy.terminal.stoppingSession}\r\n`,
    );
    try {
      await window.p2a.terminal.stop({ sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error");
      terminalRef.current?.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }
  }

  async function killSession() {
    const session = activeSessionRef.current;
    if (!session || status === "stopping" || status === "killing") return;

    setStatus("killing");
    terminalRef.current?.write(
      `\r\n\x1b[38;5;167m[session]\x1b[0m ${copy.terminal.killingSession}\r\n`,
    );
    try {
      await window.p2a.terminal.kill({ sessionId: session.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus("error");
      terminalRef.current?.write(`\x1b[38;5;167m[error]\x1b[0m ${message}\r\n`);
    }
  }

  const isSessionChanging = status === "starting" || status === "stopping" || status === "killing";
  const canStartSession = Boolean(cwd) && Boolean(agentTool) && !activeSession && !isSessionChanging;
  const canSendMessage =
    Boolean(activeSession) && status === "running" && messageText.trim().length > 0;
  const canRecordNote = status !== "idle" && noteText.trim().length > 0;

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
      <div className="supervisor-panel">
        <div className="supervisor-panel__compose">
          <div className="supervisor-panel__head">
            <div>
              <div className="label">{copy.terminal.supervisorInput}</div>
              <strong>{copy.terminal.messageAgent}</strong>
            </div>
            <div className="terminal-mode-toggle" role="group" aria-label={copy.terminal.inputMode}>
              <button
                className={
                  inputMode === "message"
                    ? "terminal-mode-toggle__item terminal-mode-toggle__item--active"
                    : "terminal-mode-toggle__item"
                }
                type="button"
                onClick={() => setInputMode("message")}
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
                onClick={() => setInputMode("passthrough")}
              >
                {copy.terminal.passthrough}
              </button>
            </div>
          </div>
          <div className="supervisor-message-row">
            <textarea
              className="supervisor-textarea"
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              disabled={!activeSession || status !== "running"}
              placeholder={
                activeSession
                  ? copy.terminal.askAgentPlaceholder
                  : copy.terminal.startSessionPlaceholder
              }
              aria-label={copy.terminal.messageAgent}
            />
            <button
              className="terminal-control terminal-control--primary"
              type="button"
              onClick={sendMessageAgent}
              disabled={!canSendMessage}
            >
              {copy.terminal.sendMessage}
            </button>
          </div>
        </div>

        <div className="supervisor-panel__notes">
          <div className="supervisor-panel__head">
            <div>
              <div className="label">{copy.terminal.sessionNote}</div>
              <strong>{copy.terminal.blockedFailed}</strong>
            </div>
            <span className="mono">{copy.common.localOnly}</span>
          </div>
          <div className="supervisor-message-row">
            <textarea
              className="supervisor-textarea"
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              disabled={status === "idle"}
              placeholder={copy.terminal.reasonPlaceholder}
              aria-label={copy.terminal.sessionNote}
            />
            <div className="supervisor-note-actions">
              <button
                className="terminal-control"
                type="button"
                onClick={() => recordSessionNote("blocked")}
                disabled={!canRecordNote}
              >
                {copy.terminal.blockedNote}
              </button>
              <button
                className="terminal-control terminal-control--danger"
                type="button"
                onClick={() => recordSessionNote("failed")}
                disabled={!canRecordNote}
              >
                {copy.terminal.failedNote}
              </button>
            </div>
          </div>
        </div>

        <div className="supervisor-event-list" aria-label={copy.terminal.supervisorNotes}>
          {supervisorNotes.length > 0 ? (
            supervisorNotes.map((note) => (
              <div className={`supervisor-event supervisor-event--${note.kind}`} key={note.id}>
                <span className="mono">{formatNoteTime(note.createdAt)}</span>
                <strong>{note.kind}</strong>
                <p>{note.text}</p>
              </div>
            ))
          ) : (
            <div className="supervisor-empty">{copy.terminal.noSupervisorNotes}</div>
          )}
        </div>
      </div>
    </section>
  );
}
