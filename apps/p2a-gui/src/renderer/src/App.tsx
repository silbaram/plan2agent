import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FileJson,
  FolderOpen,
  GitBranch,
  History,
  Layers,
  Monitor,
  RefreshCw,
  Settings,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AGENT_TOOLS } from "../../shared/ipc";
import {
  summarizeFinishRunFailure,
  summarizeStartRunFailure,
} from "../../shared/executionFailure";
import { TerminalSurface } from "./TerminalSurface";
import type {
  AgentTool,
  ArtifactSummary,
  DiagnosticSeverity,
  ExecutionCommandResult,
  ExecutionFinishStatus,
  FailureClass,
  GuiConfigSnapshot,
  OnboardingAction,
  ProjectSnapshot,
  ProjectWatchEvent,
  RuntimeInfo,
  VerificationType,
  WorkbenchRun,
  WorkbenchTask,
} from "../../shared/ipc";

type OpenState = "idle" | "loading" | "canceled" | "error";
type WatchState = "idle" | "watching" | "refreshing" | "error";
type ConfigState = "loading" | "ready" | "error";
type ExecutionActionState = "idle" | "running" | "error";

const failureClassOptions: FailureClass[] = [
  "verification_failed",
  "test_flake",
  "scope_violation",
  "missing_dependency",
  "environment_failure",
  "implementation_incomplete",
  "other",
];

const verificationTypeOptions: VerificationType[] = ["custom", "test", "lint", "typecheck"];

const steps = [
  ["2B-0", "Electron skeleton", "done"],
  ["2B-1", "Read-only loader", "done"],
  ["2B-2", "Workbench data views", "done"],
  ["2B-3", "Onboarding guidance", "done"],
  ["2C-0", "Terminal surface", "done"],
  ["2C-1", "Real PTY session", "done"],
  ["2C-2", "Supervisor controls", "done"],
  ["2D", "Finish verification", "done"],
  ["2E", "Start run", "done"],
  ["smoke", "End-to-end smoke", "done"],
] as const;

const navItems = [
  ["overview", "Overview", Activity],
  ["tasks", "Tasks", Layers],
  ["runs", "Runs", History],
  ["terminal", "Terminal", TerminalSquare],
  ["settings", "Settings", Settings],
] as const;

type ActiveTab = (typeof navItems)[number][0];

function formatPath(value: string | null | undefined): string {
  return value ?? "none";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "none";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "none";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  if (!startedAt || !finishedAt) return "open";
  const started = new Date(startedAt).getTime();
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return "none";
  const totalSeconds = Math.round((finished - started) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatMilliseconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "none";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function parseListInput(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function verificationSummary(run: WorkbenchRun | null): string {
  if (!run || run.verification.length === 0) return "none";
  const counts = run.verification.reduce<Record<string, number>>((summary, item) => {
    summary[item.status] = (summary[item.status] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
}

function outputPreview(value: string | null | undefined): string {
  if (!value) return "none";
  return value.trim() || "none";
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function joinDisplayPath(rootPath: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  return `${rootPath.replace(/\/$/, "")}/${relativePath}`;
}

function statusTextFor(snapshot: ProjectSnapshot | null, openState: OpenState): string {
  if (openState === "loading") return "loading project";
  if (openState === "canceled") return "folder selection canceled";
  if (openState === "error") return "project load failed";
  return snapshot ? snapshot.stateLabel : "read-only shell ready";
}

function diagnosticIcon(severity: DiagnosticSeverity) {
  if (severity === "ok") return CheckCircle2;
  if (severity === "error") return AlertTriangle;
  return CircleDot;
}

function primaryArtifact(snapshot: ProjectSnapshot | null): ArtifactSummary | null {
  return snapshot?.artifacts[0] ?? null;
}

function dependencyText(task: WorkbenchTask): string {
  return task.dependencies.length ? task.dependencies.join(", ") : "none";
}

function runForTaskText(task: WorkbenchTask): string {
  return task.latestRunId ?? `${task.runIds.length} runs`;
}

function impactText(action: OnboardingAction): string {
  if (action.impact === "writes_project") return "writes project";
  if (action.impact === "reads_project") return "reads project";
  return "guidance only";
}

function tabCopy(tab: ActiveTab): { label: string; title: string } {
  if (tab === "tasks") return { label: "task graph", title: "Tasks" };
  if (tab === "runs") return { label: "run history", title: "Runs" };
  if (tab === "terminal") return { label: "terminal guidance", title: "Terminal" };
  if (tab === "settings") return { label: "settings", title: "Settings" };
  return { label: "project loader", title: "Overview" };
}

export default function App() {
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot | null>(null);
  const [guiConfig, setGuiConfig] = useState<GuiConfigSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [openState, setOpenState] = useState<OpenState>("idle");
  const [watchState, setWatchState] = useState<WatchState>("idle");
  const [configState, setConfigState] = useState<ConfigState>("loading");
  const [lastWatchEvent, setLastWatchEvent] = useState<ProjectWatchEvent | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [startState, setStartState] = useState<ExecutionActionState>("idle");
  const [finishState, setFinishState] = useState<ExecutionActionState>("idle");
  const [finishStatus, setFinishStatus] = useState<ExecutionFinishStatus>("auto");
  const [finishFailureClass, setFinishFailureClass] =
    useState<FailureClass>("verification_failed");
  const [verifyTest, setVerifyTest] = useState(true);
  const [verifyLint, setVerifyLint] = useState(false);
  const [verifyTypecheck, setVerifyTypecheck] = useState(true);
  const [customVerifyType, setCustomVerifyType] = useState<VerificationType>("custom");
  const [customVerifyCommand, setCustomVerifyCommand] = useState("");
  const [collectGit, setCollectGit] = useState(true);
  const [changedFilesInput, setChangedFilesInput] = useState("");
  const [finishNoteInput, setFinishNoteInput] = useState("");
  const [startResult, setStartResult] = useState<ExecutionCommandResult | null>(null);
  const [finishResult, setFinishResult] = useState<ExecutionCommandResult | null>(null);

  useEffect(() => {
    window.p2a.app
      .getRuntimeInfo()
      .then((info) => setRuntimeInfo(info))
      .catch(() => setRuntimeInfo(null));
  }, []);

  async function refreshConfig(): Promise<GuiConfigSnapshot | null> {
    try {
      const config = await window.p2a.config.get();
      setGuiConfig(config);
      setConfigState("ready");
      return config;
    } catch {
      setConfigState("error");
      return null;
    }
  }

  useEffect(() => {
    void refreshConfig();
  }, []);

  async function loadProjectPath(
    rootPath: string,
    options: { quiet?: boolean; remember?: boolean } = {},
  ): Promise<ProjectSnapshot | null> {
    if (options.quiet) {
      setWatchState("refreshing");
    } else {
      setOpenState("loading");
    }

    try {
      const snapshot = await window.p2a.project.load(rootPath, {
        remember: options.remember,
      });
      setProjectSnapshot(snapshot);
      setWatchState("watching");
      if (!options.quiet) setOpenState("idle");
      if (options.remember) void refreshConfig();
      return snapshot;
    } catch {
      if (options.quiet) {
        setWatchState("error");
      } else {
        setOpenState("error");
      }
      return null;
    }
  }

  useEffect(() => {
    if (!projectSnapshot) {
      setWatchState("idle");
      return undefined;
    }

    setWatchState("watching");
    return window.p2a.project.onChanged((event) => {
      if (event.rootPath !== projectSnapshot.rootPath) return;
      setLastWatchEvent(event);
      void loadProjectPath(event.rootPath, { quiet: true });
    });
  }, [projectSnapshot?.rootPath]);

  const artifact = primaryArtifact(projectSnapshot);
  const tasks = artifact?.tasks ?? [];
  const runs = artifact?.runs ?? [];
  const onboarding = projectSnapshot?.onboarding ?? null;
  const onboardingActions = onboarding
    ? [onboarding.primaryAction, ...onboarding.secondaryActions]
    : [];
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;
  const selectedTaskRuns = selectedTask
    ? runs.filter((run) => selectedTask.runIds.includes(run.runId))
    : [];
  const tab = tabCopy(activeTab);
  const statusText = useMemo(() => {
    return statusTextFor(projectSnapshot, openState);
  }, [openState, projectSnapshot]);
  const statusClass = openState === "idle" && projectSnapshot ? projectSnapshot.state : openState;

  useEffect(() => {
    const nextArtifact = primaryArtifact(projectSnapshot);
    const nextTasks = nextArtifact?.tasks ?? [];
    const nextRuns = nextArtifact?.runs ?? [];
    const nextSelectedTaskId =
      nextTasks.find((task) => task.ready)?.id ?? nextTasks[0]?.id ?? null;
    const nextSelectedRunId = nextRuns[0]?.runId ?? null;

    setSelectedTaskId((current) =>
      nextTasks.some((task) => task.id === current) ? current : nextSelectedTaskId,
    );
    setSelectedRunId((current) =>
      nextRuns.some((run) => run.runId === current) ? current : nextSelectedRunId,
    );
  }, [projectSnapshot?.generatedAt, projectSnapshot?.rootPath]);

  useEffect(() => {
    setStartResult(null);
  }, [projectSnapshot?.rootPath, selectedTaskId]);

  async function openProjectFolder() {
    setOpenState("loading");
    try {
      const result = await window.p2a.project.openFolder();
      if (result.canceled) {
        setOpenState("canceled");
        return;
      }
      setProjectSnapshot(result.snapshot);
      setWatchState(result.snapshot ? "watching" : "idle");
      setLastWatchEvent(null);
      setOpenState("idle");
      void refreshConfig();
    } catch {
      setOpenState("error");
    }
  }

  async function reloadProjectFolder() {
    if (!projectSnapshot) return;
    await loadProjectPath(projectSnapshot.rootPath);
  }

  async function openRecentProject(rootPath: string) {
    setLastWatchEvent(null);
    await loadProjectPath(rootPath, { remember: true });
  }

  async function forgetRecentProject(rootPath: string) {
    try {
      const config = await window.p2a.project.forgetRecent(rootPath);
      setGuiConfig(config);
      setConfigState("ready");
    } catch {
      setConfigState("error");
    }
  }

  async function changeDefaultAgentTool(agentTool: AgentTool) {
    if (!projectSnapshot) return;

    try {
      const config = await window.p2a.project.setDefaultAgentTool(
        projectSnapshot.rootPath,
        agentTool,
      );
      setGuiConfig(config);
      setConfigState("ready");
      setProjectSnapshot({
        ...projectSnapshot,
        defaultAgentTool: agentTool,
      });
    } catch {
      setConfigState("error");
    }
  }

  function selectTask(task: WorkbenchTask) {
    setSelectedTaskId(task.id);
    if (task.latestRunId) {
      setSelectedRunId(task.latestRunId);
    }
  }

  function selectRun(run: WorkbenchRun) {
    setSelectedRunId(run.runId);
    setSelectedTaskId(run.taskId);
  }

  function executionSourcePreviewArgs(): string[] {
    if (!artifact) return [];
    if (artifact.activeIteration || !artifact.taskGraphPath) {
      return ["--artifacts", artifact.rootPath];
    }
    return ["--graph", joinDisplayPath(projectSnapshot?.rootPath ?? "", artifact.taskGraphPath)];
  }

  function startPreviewCommand(): string {
    if (!artifact || !selectedTask || !projectSnapshot) return "select a ready task";
    const args = [
      "node",
      "scripts/p2a_execute.mjs",
      "start",
      ...executionSourcePreviewArgs(),
      "--task",
      selectedTask.id,
      "--agent-tool",
      projectSnapshot.defaultAgentTool,
      "--workspace",
      projectSnapshot.rootPath,
    ];
    return args.map(quoteCommandPart).join(" ");
  }

  function finishPreviewCommand(): string {
    if (!artifact || !selectedRun) return "select a run";
    const args = [
      "node",
      "scripts/p2a_execute.mjs",
      "finish",
      ...executionSourcePreviewArgs(),
      "--run-id",
      selectedRun.runId,
    ];
    if (verifyTest) args.push("--test");
    if (verifyLint) args.push("--lint");
    if (verifyTypecheck) args.push("--typecheck");
    if (customVerifyCommand.trim()) {
      args.push("--verify-command", `${customVerifyType}:${customVerifyCommand.trim()}`);
    }
    if (finishStatus !== "auto") args.push("--status", finishStatus);
    if (finishStatus === "failed" || finishStatus === "blocked") {
      args.push("--failure-class", finishFailureClass);
    }
    if (collectGit) args.push("--collect-git");
    return args.map(quoteCommandPart).join(" ");
  }

  async function startSelectedTask() {
    if (!projectSnapshot || !artifact || !selectedTask || !selectedTask.ready) return;
    setStartState("running");
    setStartResult(null);

    try {
      const result = await window.p2a.execution.startRun({
        projectRoot: projectSnapshot.rootPath,
        artifactRoot: artifact.rootPath,
        taskGraphPath: artifact.taskGraphPath,
        taskId: selectedTask.id,
        agentTool: projectSnapshot.defaultAgentTool,
      });
      setStartResult(result);
      setStartState(result.exitCode === 0 ? "idle" : "error");

      const refreshed = await loadProjectPath(projectSnapshot.rootPath, { quiet: true });
      const refreshedTask = primaryArtifact(refreshed)?.tasks.find(
        (task) => task.id === selectedTask.id,
      );
      setSelectedTaskId(selectedTask.id);
      if (result.exitCode === 0 && refreshedTask?.latestRunId) {
        setSelectedRunId(refreshedTask.latestRunId);
        setActiveTab("terminal");
      }
    } catch (error) {
      setStartState("error");
      setStartResult({
        command: startPreviewCommand(),
        args: [],
        cwd: projectSnapshot.rootPath,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      });
    }
  }

  async function finishSelectedRun() {
    if (!projectSnapshot || !artifact || !selectedRun || selectedRun.status !== "started") return;
    setFinishState("running");
    setFinishResult(null);

    try {
      const result = await window.p2a.execution.finishRun({
        projectRoot: projectSnapshot.rootPath,
        artifactRoot: artifact.rootPath,
        taskGraphPath: artifact.taskGraphPath,
        runId: selectedRun.runId,
        status: finishStatus,
        failureClass:
          finishStatus === "failed" || finishStatus === "blocked" ? finishFailureClass : null,
        collectGit,
        verifyTest,
        verifyLint,
        verifyTypecheck,
        customVerificationCommands: customVerifyCommand.trim()
          ? [{ type: customVerifyType, command: customVerifyCommand.trim() }]
          : [],
        changedFiles: parseListInput(changedFilesInput),
        notes: parseListInput(finishNoteInput),
      });
      setFinishResult(result);
      setFinishState("idle");
      await loadProjectPath(projectSnapshot.rootPath, { quiet: true });
    } catch (error) {
      setFinishState("error");
      setFinishResult({
        command: finishPreviewCommand(),
        args: [],
        cwd: projectSnapshot.rootPath,
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      });
    }
  }

  function renderOnboardingAction(action: OnboardingAction, variant: "primary" | "secondary") {
    return (
      <article className={`onboarding-action onboarding-action--${variant}`} key={action.id}>
        <div className="onboarding-action__head">
          <div>
            <strong>{action.label}</strong>
            <span>{action.description}</span>
          </div>
          <em className={`impact-badge impact-badge--${action.impact}`}>{impactText(action)}</em>
        </div>
        <dl className="onboarding-action__meta">
          <dt>cwd</dt>
          <dd className="mono">{action.cwd}</dd>
          <dt>target</dt>
          <dd className="mono">{action.targetPath}</dd>
        </dl>
        {action.command ? <code>{action.command}</code> : <span className="onboarding-action__empty">No external command.</span>}
      </article>
    );
  }

  function renderOnboardingPanel() {
    if (!onboarding) return null;

    return (
      <section className="workbench-panel onboarding-panel">
        <div className="section-head">
          <div>
            <div className="label">onboarding</div>
            <h3>{onboarding.title}</h3>
          </div>
          <span className={`state-pill state-pill--${projectSnapshot?.state ?? "idle"}`}>
            {projectSnapshot?.stateLabel ?? "not loaded"}
          </span>
        </div>
        <div className="onboarding-body">
          <p>{onboarding.summary}</p>
          <div className="onboarding-actions">
            {renderOnboardingAction(onboarding.primaryAction, "primary")}
            {onboarding.secondaryActions.map((action) => renderOnboardingAction(action, "secondary"))}
          </div>
          <div className="onboarding-checks" aria-label="Onboarding checks">
            {onboarding.checks.map((check) => (
              <div className={`onboarding-check onboarding-check--${check.status}`} key={check.id}>
                <span>{check.label}</span>
                <strong>{check.detail}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  function renderOverviewTab() {
    return (
      <>
        <div className="summary-grid" aria-label="Project summary">
          <div>
            <span>project</span>
            <strong>{projectSnapshot?.projectId ?? projectSnapshot?.name ?? "none"}</strong>
          </div>
          <div>
            <span>state</span>
            <strong>{projectSnapshot?.stateLabel ?? "not loaded"}</strong>
          </div>
          <div>
            <span>ready tasks</span>
            <strong>
              {artifact
                ? `${formatCount(artifact.taskCounts.ready)} / ${formatCount(artifact.taskCounts.total)}`
                : "0 / 0"}
            </strong>
          </div>
          <div>
            <span>runs</span>
            <strong>{artifact ? formatCount(artifact.runCount) : "0"}</strong>
          </div>
        </div>

        {renderOnboardingPanel()}

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">artifacts</div>
              <h3>Detected planning roots</h3>
            </div>
          </div>
          {projectSnapshot && projectSnapshot.artifacts.length > 0 ? (
            <div className="artifact-list">
              {projectSnapshot.artifacts.map((item) => (
                <article className="artifact-row" key={item.rootPath}>
                  <div className="artifact-row__head">
                    <div>
                      <strong>{item.projectId}</strong>
                      <span className="mono">{item.relativePath}</span>
                    </div>
                    <span className="mono">{item.activeIteration ?? "no iteration"}</span>
                  </div>
                  <div className="task-counts" aria-label="Task counts">
                    <span>ready {formatCount(item.taskCounts.ready)}</span>
                    <span>todo {formatCount(item.taskCounts.todo)}</span>
                    <span>in progress {formatCount(item.taskCounts.inProgress)}</span>
                    <span>blocked {formatCount(item.taskCounts.blocked)}</span>
                    <span>done {formatCount(item.taskCounts.done)}</span>
                  </div>
                  <div className="gate-strip" aria-label="Gate status">
                    {item.gates.map((gate) => (
                      <span className={`gate-chip gate-chip--${gate.state}`} key={gate.id}>
                        <span className="mono">{gate.id}</span>
                        {gate.label}
                      </span>
                    ))}
                  </div>
                  <div className="validation-strip" aria-label="Schema validation">
                    {item.validations.map((validation) => (
                      <span
                        className={`validation-chip validation-chip--${validation.status}`}
                        key={validation.id}
                        title={validation.errors.join("\n") || validation.relativePath || validation.label}
                      >
                        {validation.label}
                        <span className="mono">{validation.status}</span>
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>No artifact root detected.</span>
            </div>
          )}
        </section>

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">filesystem</div>
              <h3>Read-only checks</h3>
            </div>
          </div>
          <div className="check-grid">
            {(projectSnapshot?.checks ?? []).map((check) => (
              <div className={`check-row check-row--${check.exists ? "present" : "missing"}`} key={check.id}>
                <ShieldCheck size={14} strokeWidth={1.7} aria-hidden="true" />
                <span>{check.label}</span>
                <em className="mono">{check.exists ? "present" : "missing"}</em>
                <small className="mono">{check.relativePath}</small>
              </div>
            ))}
            {!projectSnapshot && (
              <div className="empty-panel empty-panel--inline">
                <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
                <span>No folder selected.</span>
              </div>
            )}
          </div>
        </section>
      </>
    );
  }

  function renderTasksTab() {
    return (
      <>
        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">tasks</div>
              <h3>Task graph</h3>
            </div>
            <span className="section-meta mono">{artifact?.taskGraphPath ?? "no task graph"}</span>
          </div>
          {tasks.length > 0 ? (
            <div className="task-table" role="list" aria-label="Task graph rows">
              {tasks.map((task) => (
                <button
                  className={`task-row${selectedTaskId === task.id ? " task-row--selected" : ""}${
                    task.ready ? " task-row--ready" : ""
                  }`}
                  key={task.id}
                  type="button"
                  onClick={() => selectTask(task)}
                  role="listitem"
                >
                  <span className="task-row__id mono">{task.id}</span>
                  <span className={`status-badge status-badge--${task.status}`}>
                    {task.ready ? "ready" : statusLabel(task.status)}
                  </span>
                  <span className="task-row__main">
                    <strong>{task.title}</strong>
                    <small>{task.description}</small>
                  </span>
                  <span className="task-row__meta mono">{dependencyText(task)}</span>
                  <span className="task-row__meta mono">{runForTaskText(task)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>No task graph loaded.</span>
            </div>
          )}
        </section>

        {tasks.length > 0 && (
          <section className="workbench-panel">
            <div className="section-head">
              <div>
                <div className="label">dependencies</div>
                <h3>Execution order</h3>
              </div>
            </div>
            <div className="dependency-flow">
              {tasks.map((task, index) => (
                <div className="dependency-flow__item" key={task.id}>
                  <button
                    className={`dependency-node${selectedTaskId === task.id ? " dependency-node--selected" : ""}${
                      task.ready ? " dependency-node--ready" : ""
                    }`}
                    type="button"
                    onClick={() => selectTask(task)}
                  >
                    <span className="mono">{task.id}</span>
                    <strong>{statusLabel(task.status)}</strong>
                  </button>
                  {index < tasks.length - 1 && <span className="dependency-edge mono">→</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </>
    );
  }

  function renderRunsTab() {
    return (
      <section className="workbench-panel">
        <div className="section-head">
          <div>
            <div className="label">runs</div>
            <h3>Run history</h3>
          </div>
          <span className="section-meta mono">{artifact?.runIndexPath ?? "no run index"}</span>
        </div>
        {runs.length > 0 ? (
          <div className="run-table" role="list" aria-label="Run history rows">
            {runs.map((run) => (
              <button
                className={`run-row${selectedRunId === run.runId ? " run-row--selected" : ""}`}
                key={run.runId}
                type="button"
                onClick={() => selectRun(run)}
                role="listitem"
              >
                <span className="run-row__id mono">{run.runId}</span>
                <span className={`status-badge status-badge--${run.status}`}>
                  {statusLabel(run.status)}
                </span>
                <span className="mono">{run.taskId}</span>
                <span className="mono">{run.agentTool}</span>
                <span className="mono">{formatDateTime(run.startedAt)}</span>
                <span className="mono">{formatDuration(run.startedAt, run.finishedAt)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-panel">
            <History size={18} strokeWidth={1.7} aria-hidden="true" />
            <span>No run history loaded.</span>
          </div>
        )}
      </section>
    );
  }

  function renderStartRunPanel() {
    const canStart =
      Boolean(projectSnapshot && artifact && selectedTask) &&
      Boolean(selectedTask?.ready) &&
      startState !== "running";

    return (
      <section className="workbench-panel start-run-panel">
        <div className="section-head">
          <div>
            <div className="label">start / run</div>
            <h3>{selectedTask?.id ?? "No task selected"}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedTask?.status ?? "todo"}`}>
            {selectedTask ? (selectedTask.ready ? "ready" : statusLabel(selectedTask.status)) : "none"}
          </span>
        </div>

        <div className="finish-panel__body start-run-panel__body">
          <div className="finish-panel__controls">
            <div className="detail-list detail-list--embedded">
              <div>
                <span>task</span>
                <strong className="mono">{selectedTask?.id ?? "none"}</strong>
              </div>
              <div>
                <span>agent</span>
                <strong className="mono">{projectSnapshot?.defaultAgentTool ?? "codex"}</strong>
              </div>
              <div>
                <span>workspace</span>
                <strong className="mono">{formatPath(projectSnapshot?.rootPath)}</strong>
              </div>
              <div>
                <span>target</span>
                <strong>{selectedTask?.targetArea ?? "none"}</strong>
              </div>
            </div>
          </div>

          <div className="finish-panel__result">
            <div className="command-preview">
              <span className="mono">cwd {formatPath(projectSnapshot?.rootPath)}</span>
              <code>{startResult?.command ?? startPreviewCommand()}</code>
            </div>
            <div className="finish-actions">
              <button
                className="terminal-control terminal-control--primary"
                type="button"
                onClick={startSelectedTask}
                disabled={!canStart}
              >
                {startState === "running" ? "Starting" : "Start run"}
              </button>
              <span className="mono">
                {startResult
                  ? `exit ${startResult.exitCode} · ${formatMilliseconds(startResult.durationMs)}`
                  : selectedTask?.ready
                    ? "ready"
                    : "not runnable"}
              </span>
            </div>
            {renderStartFailureDiagnostic()}
            {startResult && (
              <div className="command-output">
                <pre>{outputPreview(startResult.stdout)}</pre>
                <pre>{outputPreview(startResult.stderr)}</pre>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderStartRunInspectorAction() {
    const canStart =
      Boolean(projectSnapshot && artifact && selectedTask) &&
      Boolean(selectedTask?.ready) &&
      startState !== "running";

    return (
      <>
        <div className="section-head section-head--tight">
          <div>
            <div className="label">run</div>
            <h3>Start task</h3>
          </div>
        </div>
        <div className="command-preview command-preview--compact">
          <span className="mono">cwd {formatPath(projectSnapshot?.rootPath)}</span>
          <code>{startResult?.command ?? startPreviewCommand()}</code>
        </div>
        <div className="finish-actions finish-actions--stacked">
          <button
            className="terminal-control terminal-control--primary"
            type="button"
            onClick={startSelectedTask}
            disabled={!canStart}
          >
            {startState === "running" ? "Starting" : "Start run"}
          </button>
          <span className="mono">
            {startResult
              ? `exit ${startResult.exitCode} · ${formatMilliseconds(startResult.durationMs)}`
              : selectedTask?.ready
                ? "ready"
                : "not runnable"}
          </span>
        </div>
        {renderStartFailureDiagnostic(true)}
        {startResult && (
          <div className="command-output command-output--compact">
            <pre>{outputPreview(startResult.stdout)}</pre>
            <pre>{outputPreview(startResult.stderr)}</pre>
          </div>
        )}
      </>
    );
  }

  function renderStartFailureDiagnostic(compact = false) {
    const failure = summarizeStartRunFailure(startResult);
    if (!failure) return null;

    return (
      <div
        className={`diagnostic diagnostic--error execution-failure${
          compact ? " execution-failure--compact" : ""
        }`}
      >
        <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
        <span className="execution-failure__body">
          <strong>{failure.title}</strong>
          <small>{failure.detail}</small>
          <em>{failure.nextAction}</em>
        </span>
      </div>
    );
  }

  function renderFinishPanel() {
    const canFinish =
      Boolean(projectSnapshot && artifact && selectedRun) &&
      selectedRun?.status === "started" &&
      finishState !== "running";
    const noteRequired =
      (finishStatus === "blocked" || finishStatus === "failed") &&
      finishFailureClass === "other";
    const hasRequiredNote = !noteRequired || parseListInput(finishNoteInput).length > 0;

    return (
      <section className="workbench-panel finish-panel">
        <div className="section-head">
          <div>
            <div className="label">finish / verification</div>
            <h3>{selectedRun?.runId ?? "No run selected"}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedRun?.status ?? "todo"}`}>
            {selectedRun ? statusLabel(selectedRun.status) : "none"}
          </span>
        </div>

        <div className="finish-panel__body">
          <div className="finish-panel__controls">
            <div className="form-grid form-grid--two">
              <label className="field-label">
                <span>final status</span>
                <select
                  className="agent-select mono"
                  value={finishStatus}
                  onChange={(event) => setFinishStatus(event.target.value as ExecutionFinishStatus)}
                >
                  <option value="auto">auto</option>
                  <option value="finished">finished</option>
                  <option value="failed">failed</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>

              <label className="field-label">
                <span>failure class</span>
                <select
                  className="agent-select mono"
                  value={finishFailureClass}
                  onChange={(event) => setFinishFailureClass(event.target.value as FailureClass)}
                  disabled={finishStatus !== "failed" && finishStatus !== "blocked"}
                >
                  {failureClassOptions.map((failureClass) => (
                    <option key={failureClass} value={failureClass}>
                      {failureClass}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="check-options" aria-label="Verification options">
              <label>
                <input
                  type="checkbox"
                  checked={verifyTest}
                  onChange={(event) => setVerifyTest(event.target.checked)}
                />
                test
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={verifyLint}
                  onChange={(event) => setVerifyLint(event.target.checked)}
                />
                lint
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={verifyTypecheck}
                  onChange={(event) => setVerifyTypecheck(event.target.checked)}
                />
                typecheck
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={collectGit}
                  onChange={(event) => setCollectGit(event.target.checked)}
                />
                collect git
              </label>
            </div>

            <div className="custom-command-row">
              <select
                className="agent-select mono"
                value={customVerifyType}
                onChange={(event) => setCustomVerifyType(event.target.value as VerificationType)}
                aria-label="Custom verification type"
              >
                {verificationTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <input
                className="text-input mono"
                value={customVerifyCommand}
                onChange={(event) => setCustomVerifyCommand(event.target.value)}
                placeholder="npm run smoke"
                aria-label="Custom verification command"
              />
            </div>

            <div className="form-grid form-grid--two">
              <label className="field-label">
                <span>changed files</span>
                <textarea
                  className="supervisor-textarea"
                  value={changedFilesInput}
                  onChange={(event) => setChangedFilesInput(event.target.value)}
                  placeholder="src/file.ts"
                />
              </label>
              <label className="field-label">
                <span>note</span>
                <textarea
                  className="supervisor-textarea"
                  value={finishNoteInput}
                  onChange={(event) => setFinishNoteInput(event.target.value)}
                  placeholder="verification note"
                />
              </label>
            </div>
          </div>

          <div className="finish-panel__result">
            <div className="command-preview">
              <span className="mono">cwd {formatPath(projectSnapshot?.rootPath)}</span>
              <code>{finishResult?.command ?? finishPreviewCommand()}</code>
            </div>
            <div className="finish-actions">
              <button
                className="terminal-control terminal-control--primary"
                type="button"
                onClick={finishSelectedRun}
                disabled={!canFinish || !hasRequiredNote}
              >
                {finishState === "running" ? "Running" : "Finish run"}
              </button>
              <span className="mono">
                {finishResult
                  ? `exit ${finishResult.exitCode} · ${formatMilliseconds(finishResult.durationMs)}`
                  : selectedRun?.status === "started"
                    ? "ready"
                    : "not runnable"}
              </span>
            </div>
            {noteRequired && !hasRequiredNote && (
              <div className="diagnostic diagnostic--warn">
                <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
                <span>failure class other requires a note.</span>
              </div>
            )}
            {renderFinishFailureDiagnostic()}
            {finishResult && (
              <div className="command-output">
                <pre>{outputPreview(finishResult.stdout)}</pre>
                <pre>{outputPreview(finishResult.stderr)}</pre>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderTerminalTab() {
    return (
      <>
        {renderStartRunPanel()}

        <TerminalSurface
          cwd={projectSnapshot?.rootPath}
          command={onboarding?.primaryAction.command ?? projectSnapshot?.commands[0]?.command}
          agentTool={projectSnapshot?.defaultAgentTool ?? "codex"}
          taskId={selectedTask?.id}
          taskPrompt={selectedTask?.suggestedAgentPrompt}
        />

        {renderFinishPanel()}

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">agent prompt</div>
              <h3>{selectedTask?.id ?? "No task selected"}</h3>
            </div>
          </div>
          {selectedTask ? (
            <pre className="prompt-preview">{selectedTask.suggestedAgentPrompt}</pre>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>Select a task to preview its agent prompt.</span>
            </div>
          )}
        </section>
      </>
    );
  }

  function renderFinishFailureDiagnostic() {
    const failure = summarizeFinishRunFailure(finishResult);
    if (!failure) return null;

    return (
      <div className="diagnostic diagnostic--error execution-failure">
        <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
        <span className="execution-failure__body">
          <strong>{failure.title}</strong>
          <small>{failure.detail}</small>
          <em>{failure.nextAction}</em>
        </span>
      </div>
    );
  }

  function renderActiveTab() {
    if (activeTab === "tasks") return renderTasksTab();
    if (activeTab === "runs") return renderRunsTab();
    if (activeTab === "terminal") return renderTerminalTab();
    return renderOverviewTab();
  }

  function renderOverviewInspector() {
    return (
      <>
        {onboarding && (
          <>
            <div className="section-head">
              <div>
                <div className="label">next action</div>
                <h3>{onboarding.primaryAction.label}</h3>
              </div>
            </div>
            <div className="detail-list">
              <div>
                <span>stage</span>
                <strong className="mono">{onboarding.stage}</strong>
              </div>
              <div>
                <span>impact</span>
                <strong>{impactText(onboarding.primaryAction)}</strong>
              </div>
              <div>
                <span>target</span>
                <strong className="mono">{onboarding.primaryAction.targetPath}</strong>
              </div>
              <div>
                <span>cwd</span>
                <strong className="mono">{onboarding.primaryAction.cwd}</strong>
              </div>
            </div>
            {onboarding.primaryAction.command && (
              <>
                <div className="section-head section-head--tight">
                  <div>
                    <div className="label">command</div>
                    <h3>External terminal</h3>
                  </div>
                </div>
                <pre className="inspector-code">{onboarding.primaryAction.command}</pre>
              </>
            )}
          </>
        )}

        <div className="section-head">
          <div>
            <div className="label">diagnostics</div>
            <h3>Load result</h3>
          </div>
        </div>

        <div className="diagnostic-list">
          {projectSnapshot && (
            <div className={`diagnostic diagnostic--${watchState === "error" ? "error" : "ok"}`}>
              <RefreshCw size={14} strokeWidth={1.7} aria-hidden="true" />
              <span>
                watch {watchState}
                {lastWatchEvent?.relativePath ? ` · ${lastWatchEvent.relativePath}` : ""}
              </span>
            </div>
          )}
          <div className={`diagnostic diagnostic--${configState === "error" ? "error" : "ok"}`}>
            <Settings size={14} strokeWidth={1.7} aria-hidden="true" />
            <span>
              local config {configState}
              {guiConfig ? ` · ${guiConfig.recentProjects.length} recent` : ""}
            </span>
          </div>
          {(projectSnapshot?.diagnostics ?? []).map((diagnostic, index) => {
            const Icon = diagnosticIcon(diagnostic.severity);
            return (
              <div
                className={`diagnostic diagnostic--${diagnostic.severity}`}
                key={`${diagnostic.message}-${index}`}
              >
                <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
                <span>{diagnostic.message}</span>
              </div>
            );
          })}
          {!projectSnapshot && (
            <div className="diagnostic diagnostic--warn">
              <CircleDot size={14} strokeWidth={1.7} aria-hidden="true" />
              <span>Open a folder to run detection.</span>
            </div>
          )}
        </div>
      </>
    );
  }

  function renderTaskInspector() {
    if (!selectedTask) {
      return (
        <div className="inspector-empty">
          <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
          <span>No task selected.</span>
        </div>
      );
    }

    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">selected task</div>
            <h3>{selectedTask.id}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedTask.status}`}>
            {selectedTask.ready ? "ready" : statusLabel(selectedTask.status)}
          </span>
        </div>

        <div className="detail-list">
          <div>
            <span>title</span>
            <strong>{selectedTask.title}</strong>
          </div>
          <div>
            <span>target</span>
            <strong className="mono">{selectedTask.targetArea}</strong>
          </div>
          <div>
            <span>dependencies</span>
            <strong className="mono">{dependencyText(selectedTask)}</strong>
          </div>
          <div>
            <span>latest run</span>
            <strong className="mono">{selectedTask.latestRunId ?? "none"}</strong>
          </div>
        </div>

        {renderStartRunInspectorAction()}

        <div className="section-head section-head--tight">
          <div>
            <div className="label">acceptance</div>
            <h3>Criteria</h3>
          </div>
        </div>
        <ul className="criteria-list">
          {selectedTask.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>

        <div className="section-head section-head--tight">
          <div>
            <div className="label">prompt</div>
            <h3>Agent handoff</h3>
          </div>
        </div>
        <pre className="inspector-code">{selectedTask.suggestedAgentPrompt}</pre>

        {selectedTaskRuns.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">runs</div>
                <h3>Task history</h3>
              </div>
            </div>
            <div className="linked-run-list">
              {selectedTaskRuns.map((run) => (
                <button
                  className={`linked-run${selectedRunId === run.runId ? " linked-run--selected" : ""}`}
                  key={run.runId}
                  type="button"
                  onClick={() => selectRun(run)}
                >
                  <span className="mono">{run.runId}</span>
                  <strong>{statusLabel(run.status)}</strong>
                </button>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  function renderRunInspector() {
    if (!selectedRun) {
      return (
        <div className="inspector-empty">
          <History size={18} strokeWidth={1.7} aria-hidden="true" />
          <span>No run selected.</span>
        </div>
      );
    }

    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">selected run</div>
            <h3>{selectedRun.runId}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedRun.status}`}>
            {statusLabel(selectedRun.status)}
          </span>
        </div>
        {renderRunFailureSummary(selectedRun)}
        <div className="detail-list">
          <div>
            <span>task</span>
            <strong className="mono">{selectedRun.taskId}</strong>
          </div>
          <div>
            <span>agent</span>
            <strong className="mono">{selectedRun.agentTool}</strong>
          </div>
          <div>
            <span>started</span>
            <strong className="mono">{formatDateTime(selectedRun.startedAt)}</strong>
          </div>
          <div>
            <span>duration</span>
            <strong className="mono">
              {formatDuration(selectedRun.startedAt, selectedRun.finishedAt)}
            </strong>
          </div>
          <div>
            <span>verification</span>
            <strong className="mono">{verificationSummary(selectedRun)}</strong>
          </div>
          <div>
            <span>changed files</span>
            <strong className="mono">{selectedRun.changedFiles.length}</strong>
          </div>
        </div>
        {selectedRun.verification.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">verification</div>
                <h3>Results</h3>
              </div>
            </div>
            <div className="verification-list">
              {selectedRun.verification.map((verification, index) => (
                <div
                  className={`verification-item verification-item--${verification.status}`}
                  key={`${verification.type}-${verification.command}-${index}`}
                >
                  <span className="mono">{verification.type}</span>
                  <strong>{verification.status}</strong>
                  <em className="mono">{formatMilliseconds(verification.durationMs)}</em>
                  <code>{verification.command}</code>
                  {(verification.stdoutTail || verification.stderrTail) && (
                    <pre>
                      {outputPreview(verification.stdoutTail)}
                      {verification.stderrTail ? `\n${verification.stderrTail}` : ""}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {selectedRun.failure && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">failure</div>
                <h3>Classification</h3>
              </div>
            </div>
            <div className="detail-list">
              <div>
                <span>class</span>
                <strong className="mono">{selectedRun.failure.class}</strong>
              </div>
              <div>
                <span>retryable</span>
                <strong className="mono">{selectedRun.failure.retryable}</strong>
              </div>
              <div>
                <span>decision</span>
                <strong>{selectedRun.failure.needsUserDecision ? "needed" : "not needed"}</strong>
              </div>
            </div>
          </>
        )}
        {selectedRun.changedFiles.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">changes</div>
                <h3>Files</h3>
              </div>
            </div>
            <div className="ref-list">
              {selectedRun.changedFiles.map((filePath) => (
                <code key={filePath}>{filePath}</code>
              ))}
            </div>
          </>
        )}
        <div className="section-head section-head--tight">
          <div>
            <div className="label">refs</div>
            <h3>Run files</h3>
          </div>
        </div>
        <div className="ref-list">
          <code>{selectedRun.workspaceRef}</code>
          <code>{selectedRun.taskGraphRef}</code>
          <code>{selectedRun.runRef}</code>
        </div>
      </>
    );
  }

  function renderRunFailureSummary(run: WorkbenchRun) {
    const failedVerification = run.verification.find(
      (verification) => verification.status === "failed",
    );
    if (!run.failure && !failedVerification) return null;

    return (
      <div className="diagnostic diagnostic--error execution-failure">
        <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
        <span className="execution-failure__body">
          <strong>
            {run.failure ? `failure ${run.failure.class}` : "verification failed"}
          </strong>
          <small>
            {failedVerification
              ? `${failedVerification.type}: ${failedVerification.command}`
              : `retryable ${run.failure?.retryable ?? "unknown"}`}
          </small>
          <em>{outputPreview(failedVerification?.stderrTail)}</em>
        </span>
      </div>
    );
  }

  function renderTerminalInspector() {
    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">session</div>
            <h3>Execution boundary</h3>
          </div>
        </div>
        <div className="detail-list">
          <div>
            <span>cwd</span>
            <strong className="mono">{formatPath(projectSnapshot?.rootPath)}</strong>
          </div>
          <div>
            <span>agent</span>
            <strong className="mono">{projectSnapshot?.defaultAgentTool ?? "codex"}</strong>
          </div>
          <div>
            <span>task</span>
            <strong className="mono">{selectedTask?.id ?? "none"}</strong>
          </div>
          <div>
            <span>mode</span>
            <strong>supervised node-pty</strong>
          </div>
        </div>
        <div className="section-head section-head--tight">
          <div>
            <div className="label">boundary</div>
            <h3>Terminal APIs</h3>
          </div>
        </div>
        <div className="api-list">
          <div>
            <TerminalSquare size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">terminal:start</span>
          </div>
          <div>
            <Monitor size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">terminal:input</span>
          </div>
          <div>
            <GitBranch size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">terminal:resize</span>
          </div>
          <div>
            <CircleDot size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">terminal:stop</span>
          </div>
          <div>
            <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">terminal:kill</span>
          </div>
          <div>
            <CheckCircle2 size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">execution:finishRun</span>
          </div>
        </div>
      </>
    );
  }

  function renderInspector() {
    if (activeTab === "tasks") return renderTaskInspector();
    if (activeTab === "runs") return renderRunInspector();
    if (activeTab === "terminal") return renderTerminalInspector();
    return renderOverviewInspector();
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="traffic" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="titlebar__project">
          <span className="dot dot--active" />
          <strong>{projectSnapshot?.name ?? "P2A GUI"}</strong>
          <span>{projectSnapshot?.stateLabel ?? "Read-only project loader"}</span>
        </div>
        <div className="titlebar__meta mono">
          <span>{runtimeInfo ? `electron ${runtimeInfo.electronVersion}` : "electron"}</span>
          <span className="sep" />
          <span>{runtimeInfo ? `node ${runtimeInfo.nodeVersion}` : "node"}</span>
        </div>
      </header>

      <section className="workspace">
        <nav className="rail" aria-label="Primary navigation">
          {navItems.map(([id, label, Icon]) => (
            <button
              className={`rail__item${activeTab === id ? " rail__item--active" : ""}`}
              key={id}
              type="button"
              disabled={id === "settings"}
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? "page" : undefined}
            >
              <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <aside className="sidebar">
          <div className="panel-head">
            <div>
              <div className="label">project</div>
              <h1>{projectSnapshot ? projectSnapshot.name : "Open P2A project"}</h1>
            </div>
          </div>

          <div className="action-stack">
            <button className="primary-action" type="button" onClick={openProjectFolder}>
              <FolderOpen size={16} strokeWidth={1.7} aria-hidden="true" />
              <span>Open folder</span>
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={reloadProjectFolder}
              disabled={!projectSnapshot || openState === "loading"}
            >
              <RefreshCw size={15} strokeWidth={1.7} aria-hidden="true" />
              <span>Reload</span>
            </button>
          </div>

          <section className="recent-panel">
            <div className="panel-head panel-head--compact">
              <div>
                <div className="label">recent</div>
                <h3>Projects</h3>
              </div>
              <span className={`config-chip config-chip--${configState}`}>{configState}</span>
            </div>
            <div className="recent-list">
              {guiConfig && guiConfig.recentProjects.length > 0 ? (
                guiConfig.recentProjects.map((project) => (
                  <div
                    className={`recent-row${
                      project.rootPath === projectSnapshot?.rootPath ? " recent-row--active" : ""
                    }`}
                    key={project.rootPath}
                  >
                    <button
                      className="recent-row__main"
                      type="button"
                      onClick={() => openRecentProject(project.rootPath)}
                    >
                      <strong>{project.name}</strong>
                      <span className="mono">{project.rootPath}</span>
                    </button>
                    <button
                      className="recent-row__forget"
                      type="button"
                      onClick={() => forgetRecentProject(project.rootPath)}
                      aria-label={`Forget ${project.name}`}
                    >
                      <X size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-inline empty-inline--compact">
                  {configState === "loading" ? "Loading recent projects." : "No recent projects."}
                </div>
              )}
            </div>
          </section>

          <dl className="compact-dl">
            <dt>selected path</dt>
            <dd className="mono">{formatPath(projectSnapshot?.rootPath)}</dd>
            <dt>state</dt>
            <dd>{projectSnapshot?.stateLabel ?? "not loaded"}</dd>
            <dt>artifact root</dt>
            <dd className="mono">{formatPath(artifact?.relativePath)}</dd>
            <dt>mode</dt>
            <dd>read-only</dd>
            <dt>agent</dt>
            <dd className="compact-dl__control">
              <select
                className="agent-select mono"
                value={projectSnapshot?.defaultAgentTool ?? "codex"}
                onChange={(event) => changeDefaultAgentTool(event.target.value as AgentTool)}
                disabled={!projectSnapshot}
                aria-label="Default agent tool"
              >
                {AGENT_TOOLS.map((agentTool) => (
                  <option key={agentTool} value={agentTool}>
                    {agentTool}
                  </option>
                ))}
              </select>
            </dd>
            <dt>watch</dt>
            <dd>{watchState}</dd>
            <dt>last change</dt>
            <dd className="mono">{formatTime(lastWatchEvent?.changedAt)}</dd>
          </dl>

          <section className="mini-panel">
            <div className="label">milestones</div>
            <div className="mini-step-list">
              {steps.map(([id, title, state]) => (
                <div className={`mini-step mini-step--${state}`} key={id}>
                  <span className="mono">{id}</span>
                  <strong>{title}</strong>
                  <em>{state}</em>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <section className="content">
          <div className="content-head">
            <div>
              <div className="label">{tab.label}</div>
              <h2>{projectSnapshot ? tab.title : "Select a project folder"}</h2>
            </div>
            <span className={`state-pill state-pill--${statusClass}`}>{statusText}</span>
          </div>

          {renderActiveTab()}
        </section>

        <aside className="inspector">{renderInspector()}</aside>
      </section>

      <footer className="statusbar">
        <span className="mono">branch p2a-gui-mvp</span>
        <span className="sep" />
        <span>{statusText}</span>
        <span className="statusbar__spacer" />
        <span className="mono">
          {runtimeInfo ? `${runtimeInfo.platform} · electron ${runtimeInfo.electronVersion}` : "runtime loading"}
        </span>
      </footer>
    </main>
  );
}
