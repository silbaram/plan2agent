import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Copy,
  FileJson,
  FolderOpen,
  History,
  Layers,
  RefreshCw,
  Settings,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { DEFAULT_UI_LOCALE, EXECUTION_AGENT_TOOLS, UI_LOCALES } from "../../shared/ipc";
import {
  summarizeFinishRunFailure,
  summarizeStartRunFailure,
  type ExecutionFailureSummary,
} from "../../shared/executionFailure";
import { TerminalSurface } from "./TerminalSurface";
import { localeNames, uiCopy, type UiCopy } from "./i18n";
import { JsonPreview } from "./JsonPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import type {
  AgentTool,
  ArtifactFileReadResult,
  ArtifactSummary,
  DiagnosticSeverity,
  ExecutionAgentTool,
  ExecutionCommandResult,
  ExecutionFinishStatus,
  FailureClass,
  GuiConfigSnapshot,
  OrchestrationRoleStatus,
  ProjectSnapshot,
  ProjectWatchEvent,
  RuntimeInfo,
  UiLocale,
  VerificationType,
  WorkbenchRun,
  WorkbenchTask,
} from "../../shared/ipc";

type OpenState = "idle" | "loading" | "canceled" | "error";
type WatchState = "idle" | "watching" | "refreshing" | "error";
type ConfigState = "loading" | "ready" | "error";
type ExecutionActionState = "idle" | "running" | "error";
type PromptCopyState = "idle" | "copied" | "error";
type ArtifactFileState =
  | { status: "idle" }
  | { status: "loading"; document: ArtifactDocument }
  | { status: "ready"; document: ArtifactDocument; file: ArtifactFileReadResult }
  | { status: "error"; document: ArtifactDocument; message: string };

type ArtifactDocument = {
  id: string;
  label: string;
  group: "status" | "gate" | "task" | "run";
  relativePath: string;
  meta: string;
  state: string;
};

const failureClassOptions: FailureClass[] = [
  "verification_failed",
  "test_flake",
  "scope_violation",
  "missing_dependency",
  "environment_failure",
  "implementation_incomplete",
  "other",
];

function terminalAgentForExecution(agentTool: ExecutionAgentTool | null | undefined): AgentTool | null {
  if (!agentTool || agentTool === "manual") return null;
  return agentTool;
}

const verificationTypeOptions: VerificationType[] = ["custom", "test", "lint", "typecheck"];
const finishStatusOptions: ExecutionFinishStatus[] = ["auto", "finished", "failed", "blocked"];
const orchestrationRoleStatusOptions: OrchestrationRoleStatus[] = [
  "complete",
  "blocked",
  "skipped",
];

const navItems = [
  ["overview", Activity],
  ["tasks", Layers],
  ["runs", History],
  ["artifacts", FileJson],
  ["terminal", TerminalSquare],
  ["settings", Settings],
] as const;

type ActiveTab = (typeof navItems)[number][0];

type FlowState = "done" | "active" | "next";

type ProjectFlowItem = {
  id: string;
  title: string;
  state: FlowState;
  status: string;
};

const settingsCommands = [
  ["typecheck", "npm run typecheck"],
  ["test", "npm test"],
  ["package", "npm run package"],
  ["packaged smoke", "npm run smoke:packaged"],
] as const;
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;

const localeTags: Record<UiLocale, string> = {
  ko: "ko-KR",
  en: "en-US",
};

function formatPath(value: string | null | undefined, copy: UiCopy): string {
  return value ?? copy.common.none;
}

function formatCount(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(localeTags[locale]).format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string | null | undefined, locale: UiLocale, copy: UiCopy): string {
  if (!value) return copy.common.none;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return copy.common.invalid;
  return new Intl.DateTimeFormat(localeTags[locale], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTime(value: string | null | undefined, locale: UiLocale, copy: UiCopy): string {
  if (!value) return copy.common.none;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return copy.common.invalid;
  return new Intl.DateTimeFormat(localeTags[locale], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  copy: UiCopy,
): string {
  if (!startedAt || !finishedAt) return copy.common.openState;
  const started = new Date(startedAt).getTime();
  const finished = new Date(finishedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return copy.common.none;
  }
  const totalSeconds = Math.round((finished - started) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatMilliseconds(value: number | null | undefined, copy: UiCopy): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return copy.common.none;
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function clampSidebarWidth(value: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function statusLabel(value: string, copy: UiCopy): string {
  return (
    copy.status[value as keyof UiCopy["status"]] ??
    value.replace(/_/g, " ")
  );
}

function finishStatusLabel(value: ExecutionFinishStatus, copy: UiCopy): string {
  if (value === "auto") return copy.terminal.finishStatusAuto;
  return statusLabel(value, copy);
}

function finishStatusDetail(value: ExecutionFinishStatus, copy: UiCopy): string {
  if (value === "auto") return copy.terminal.finishStatusAutoDetail;
  if (value === "finished") return copy.terminal.finishStatusFinishedDetail;
  if (value === "failed") return copy.terminal.finishStatusFailedDetail;
  return copy.terminal.finishStatusBlockedDetail;
}

function flowStateLabel(state: FlowState, copy: UiCopy): string {
  if (state === "done") return copy.status.done;
  if (state === "active") return copy.status.active;
  return copy.status.pending;
}

function projectFlowItems(
  snapshot: ProjectSnapshot | null,
  artifact: ArtifactSummary | null,
  copy: UiCopy,
): ProjectFlowItem[] {
  const projectOpen = Boolean(snapshot);
  const harnessReady = Boolean(
    snapshot && snapshot.state !== "no_p2a" && snapshot.state !== "broken_install",
  );
  const planningReady = Boolean(artifact);
  const taskReady = Boolean(
    artifact?.taskGraphPath || (artifact?.taskCounts.total ?? 0) > 0,
  );
  const executionStarted = Boolean((artifact?.runCount ?? 0) > 0);
  const executionReady = Boolean(executionStarted || (artifact?.taskCounts.ready ?? 0) > 0);

  const items: Array<Omit<ProjectFlowItem, "status">> = [
    {
      id: "01",
      title: copy.tasks.flow.project,
      state: projectOpen ? "done" : "active",
    },
    {
      id: "02",
      title: copy.tasks.flow.harness,
      state: !projectOpen ? "next" : harnessReady ? "done" : "active",
    },
    {
      id: "03",
      title: copy.tasks.flow.planning,
      state: !harnessReady ? "next" : planningReady ? "done" : "active",
    },
    {
      id: "04",
      title: copy.tasks.flow.tasks,
      state: !planningReady ? "next" : taskReady ? "done" : "active",
    },
    {
      id: "05",
      title: copy.tasks.flow.execution,
      state: !taskReady ? "next" : executionStarted || executionReady ? "active" : "next",
    },
  ];

  return items.map((item) => ({
    ...item,
    status: flowStateLabel(item.state, copy),
  }));
}

function schedulerReasonLabel(reason: string | null | undefined, copy: UiCopy): string {
  if (!reason) return copy.runs.schedulerReasons.unknown;
  if (reason === "implementation_required") return copy.runs.schedulerReasons.implementationRequired;
  if (reason === "review_required") return copy.runs.schedulerReasons.reviewRequired;
  if (reason === "monitor_required") return copy.runs.schedulerReasons.monitorRequired;
  if (reason === "reviewer_required") return copy.runs.schedulerReasons.reviewerRequired;
  if (reason === "owner_decision_required") return copy.runs.schedulerReasons.ownerDecisionRequired;
  if (reason.startsWith("open_question:")) return copy.runs.schedulerReasons.openQuestion;
  if (reason.startsWith("role_blocked:")) return copy.runs.schedulerReasons.roleBlocked;
  if (reason === "runtime_blocked") return copy.runs.schedulerReasons.runtimeBlocked;
  if (reason === "ready_to_finish") return copy.runs.schedulerReasons.readyToFinish;
  if (reason === "runtime_closed") return copy.runs.schedulerReasons.runtimeClosed;
  if (reason === "roles_complete") return copy.runs.schedulerReasons.rolesComplete;
  if (reason === "monitor_not_configured") return copy.runs.schedulerReasons.monitorNotConfigured;
  return copy.runs.schedulerReasons.unknown;
}

function schedulerActionLabel(
  reason: string | null | undefined,
  nextRoleId: string | null | undefined,
  copy: UiCopy,
): string {
  if (reason === "ready_to_finish") return copy.runs.schedulerActions.finishRun;
  if (reason === "runtime_closed" || reason === "roles_complete") {
    return copy.runs.schedulerActions.closed;
  }
  if (reason === "runtime_blocked" || reason?.startsWith("role_blocked:")) {
    return copy.runs.schedulerActions.blocked;
  }
  if (reason === "owner_decision_required" || reason?.startsWith("open_question:")) {
    return copy.runs.schedulerActions.ownerDecision;
  }
  if (!nextRoleId || reason === "monitor_not_configured") {
    return copy.runs.schedulerActions.noNextRole;
  }
  return copy.runs.schedulerActions.openRole;
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

function verificationSummary(run: WorkbenchRun | null, copy: UiCopy): string {
  if (!run || run.verification.length === 0) return copy.common.none;
  const counts = run.verification.reduce<Record<string, number>>((summary, item) => {
    summary[item.status] = (summary[item.status] ?? 0) + 1;
    return summary;
  }, {});
  return Object.entries(counts)
    .map(([status, count]) => `${statusLabel(status, copy)}:${count}`)
    .join(", ");
}

function outputPreview(value: string | null | undefined, copy: UiCopy): string {
  if (!value) return copy.common.none;
  return value.trim() || copy.common.none;
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function joinDisplayPath(rootPath: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  return `${rootPath.replace(/\/$/, "")}/${relativePath}`;
}

function projectRelativeArtifactPath(artifact: ArtifactSummary, relativePath: string): string {
  if (relativePath.startsWith("/") || artifact.relativePath === ".") return relativePath;
  if (relativePath === artifact.relativePath || relativePath.startsWith(`${artifact.relativePath}/`)) {
    return relativePath;
  }
  return `${artifact.relativePath}/${relativePath}`;
}

function artifactDocumentId(artifact: ArtifactSummary, relativePath: string): string {
  return `${artifact.rootPath}:${relativePath}`;
}

function buildArtifactDocuments(artifact: ArtifactSummary | null, copy: UiCopy): ArtifactDocument[] {
  if (!artifact) return [];

  const documents: ArtifactDocument[] = [];
  const seenPaths = new Set<string>();
  const addDocument = (
    label: string,
    group: ArtifactDocument["group"],
    relativePath: string | null,
    meta: string,
    state: string,
  ) => {
    if (!relativePath || seenPaths.has(relativePath)) return;
    seenPaths.add(relativePath);
    documents.push({
      id: artifactDocumentId(artifact, relativePath),
      label,
      group,
      relativePath,
      meta,
      state,
    });
  };

  addDocument(
    copy.artifacts.groups.status,
    "status",
    artifact.statusPath,
    "markdown",
    artifact.statusPath ? "present" : "missing",
  );

  for (const validation of artifact.validations) {
    addDocument(
      validation.label,
      validation.id === "task-graph" ? "task" : "gate",
      validation.relativePath,
      validation.id,
      validation.status,
    );
  }

  for (const run of artifact.runs) {
    addDocument(
      run.runId,
      "run",
      projectRelativeArtifactPath(artifact, run.runRef),
      run.taskId,
      run.status,
    );
  }

  return documents;
}

function formatArtifactPreview(file: ArtifactFileReadResult): string {
  if (file.kind !== "json") return file.content;

  try {
    return JSON.stringify(JSON.parse(file.content), null, 2);
  } catch {
    return file.content;
  }
}

function statusTextFor(
  snapshot: ProjectSnapshot | null,
  openState: OpenState,
  copy: UiCopy,
): string {
  if (openState === "loading") return copy.app.loadingProject;
  if (openState === "canceled") return copy.app.folderCanceled;
  if (openState === "error") return copy.app.loadFailed;
  return snapshot ? projectStateLabel(snapshot, copy) : copy.app.readOnlyShellReady;
}

function projectStateLabel(snapshot: ProjectSnapshot | null, copy: UiCopy): string {
  if (!snapshot) return copy.common.none;
  return copy.projectState[snapshot.state];
}

function diagnosticIcon(severity: DiagnosticSeverity) {
  if (severity === "ok") return CheckCircle2;
  if (severity === "error") return AlertTriangle;
  return CircleDot;
}

function primaryArtifact(snapshot: ProjectSnapshot | null): ArtifactSummary | null {
  return snapshot?.artifacts[0] ?? null;
}

function dependencyText(task: WorkbenchTask, copy: UiCopy): string {
  return task.dependencies.length ? task.dependencies.join(", ") : copy.common.none;
}

function runForTaskText(task: WorkbenchTask, locale: UiLocale, copy: UiCopy): string {
  return task.latestRunId ?? `${formatCount(task.runIds.length, locale)} ${copy.runs.runs}`;
}

function artifactGroupLabel(group: ArtifactDocument["group"], copy: UiCopy): string {
  return copy.artifacts.groups[group];
}

function localizedExecutionFailure(
  failure: ExecutionFailureSummary,
  phase: "start" | "finish",
  copy: UiCopy,
): ExecutionFailureSummary {
  if (failure.kind === "unknown") {
    return {
      ...failure,
      title:
        phase === "start"
          ? copy.executionFailure.unknownStartTitle
          : copy.executionFailure.unknownFinishTitle,
      detail: failure.detail || copy.executionFailure.unknownDetail,
      nextAction: copy.executionFailure.unknownNextAction,
    };
  }

  const localized = copy.executionFailure[failure.kind];
  return localized ? { ...failure, ...localized } : failure;
}

function overviewProgressSummary(
  onboarding: ProjectSnapshot["onboarding"],
  artifact: ArtifactSummary | null,
  locale: UiLocale,
  copy: UiCopy,
) {
  const readyTasks = artifact?.taskCounts.ready ?? 0;
  const runCount = artifact?.runCount ?? 0;

  if (onboarding.stage === "execution_ready") {
    if (readyTasks > 0) {
      return {
        title: copy.onboarding.progress.execution_ready.readyTitle.replace(
          "{count}",
          formatCount(readyTasks, locale),
        ),
        detail: copy.onboarding.progress.execution_ready.readyDetail,
        nextStep: copy.onboarding.progress.execution_ready.nextStepReady,
      };
    }

    return {
      title: copy.onboarding.progress.execution_ready.runTitle.replace(
        "{count}",
        formatCount(runCount, locale),
      ),
      detail: copy.onboarding.progress.execution_ready.runDetail,
      nextStep: copy.onboarding.progress.execution_ready.nextStepRuns,
    };
  }

  return copy.onboarding.progress[onboarding.stage];
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
  const [selectedArtifactRootPath, setSelectedArtifactRootPath] = useState<string | null>(null);
  const [selectedArtifactDocumentId, setSelectedArtifactDocumentId] = useState<string | null>(null);
  const [artifactFileState, setArtifactFileState] = useState<ArtifactFileState>({
    status: "idle",
  });
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
  const [selectedOrchestrationRoleId, setSelectedOrchestrationRoleId] = useState<string | null>(null);
  const [orchestrationState, setOrchestrationState] =
    useState<ExecutionActionState>("idle");
  const [orchestrationResult, setOrchestrationResult] =
    useState<ExecutionCommandResult | null>(null);
  const [orchestrationDetailInput, setOrchestrationDetailInput] = useState("");
  const [orchestrationVerdictInput, setOrchestrationVerdictInput] = useState("");
  const [promptCopyState, setPromptCopyState] = useState<PromptCopyState>("idle");
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const artifactViewerRef = useRef<HTMLElement | null>(null);
  const artifactViewerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const artifactViewerReturnFocusRef = useRef<HTMLElement | null>(null);
  const sidebarResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

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
  const locale = guiConfig?.locale ?? DEFAULT_UI_LOCALE;
  const copy = uiCopy[locale];
  const selectedArtifact =
    projectSnapshot?.artifacts.find((item) => item.rootPath === selectedArtifactRootPath) ??
    artifact;
  const artifactDocuments = useMemo(
    () => buildArtifactDocuments(selectedArtifact ?? null, copy),
    [copy, selectedArtifact],
  );
  const selectedArtifactDocument =
    artifactDocuments.find((document) => document.id === selectedArtifactDocumentId) ??
    artifactDocuments[0] ??
    null;
  const onboarding = projectSnapshot?.onboarding ?? null;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;
  const selectedTaskRuns = selectedTask
    ? runs.filter((run) => selectedTask.runIds.includes(run.runId))
    : [];
  const selectedOrchestration = selectedRun?.orchestration ?? null;
  const selectedOrchestrationRole =
    selectedOrchestration?.roles.find((role) => role.roleId === selectedOrchestrationRoleId) ??
    selectedOrchestration?.roles.find(
      (role) => role.roleId === selectedOrchestration.next?.nextRole?.roleId,
    ) ??
    selectedOrchestration?.roles[0] ??
    null;
  const projectFlow = useMemo(
    () => projectFlowItems(projectSnapshot, artifact, copy),
    [artifact, copy, projectSnapshot],
  );
  const tab = copy.tabs[activeTab];
  const statusText = useMemo(() => {
    return statusTextFor(projectSnapshot, openState, copy);
  }, [copy, openState, projectSnapshot]);
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
    const nextArtifacts = projectSnapshot?.artifacts ?? [];
    const nextArtifact =
      nextArtifacts.find((item) => item.rootPath === selectedArtifactRootPath) ??
      nextArtifacts[0] ??
      null;
    setSelectedArtifactRootPath(nextArtifact?.rootPath ?? null);
  }, [projectSnapshot?.generatedAt, projectSnapshot?.rootPath, selectedArtifactRootPath]);

  useEffect(() => {
    setSelectedArtifactDocumentId((current) =>
      artifactDocuments.some((document) => document.id === current)
        ? current
        : artifactDocuments[0]?.id ?? null,
    );
  }, [artifactDocuments]);

  useEffect(() => {
    setStartResult(null);
  }, [projectSnapshot?.rootPath, selectedTaskId]);

  useEffect(() => {
    const roles = selectedRun?.orchestration?.roles ?? [];
    const nextRoleId =
      selectedRun?.orchestration?.next?.nextRole?.roleId ?? roles[0]?.roleId ?? null;

    setSelectedOrchestrationRoleId((current) =>
      roles.some((role) => role.roleId === current) ? current : nextRoleId,
    );
    setOrchestrationResult(null);
    setOrchestrationState("idle");
    setOrchestrationDetailInput("");
    setOrchestrationVerdictInput("");
    setPromptCopyState("idle");
  }, [selectedRun?.runId, selectedRun?.orchestration?.updatedAt]);

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

  async function changeDefaultAgentTool(agentTool: ExecutionAgentTool) {
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

  async function changeUiLocale(locale: UiLocale) {
    try {
      const config = await window.p2a.config.setLocale(locale);
      setGuiConfig(config);
      setConfigState("ready");
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

  async function openArtifactDocument(artifactDocument: ArtifactDocument | null) {
    if (!projectSnapshot || !artifactDocument) return;

    if (window.document.activeElement instanceof HTMLElement) {
      artifactViewerReturnFocusRef.current = window.document.activeElement;
    }
    setSelectedArtifactDocumentId(artifactDocument.id);
    setArtifactFileState({ status: "loading", document: artifactDocument });
    try {
      const file = await window.p2a.artifact.readFile({
        projectRoot: projectSnapshot.rootPath,
        relativePath: artifactDocument.relativePath,
      });
      setArtifactFileState({ status: "ready", document: artifactDocument, file });
    } catch (error) {
      setArtifactFileState({
        status: "error",
        document: artifactDocument,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function closeArtifactViewer() {
    setArtifactFileState({ status: "idle" });
  }

  const artifactViewerOpen = artifactFileState.status !== "idle";

  useEffect(() => {
    if (!artifactViewerOpen) return undefined;

    window.requestAnimationFrame(() => {
      artifactViewerCloseButtonRef.current?.focus();
    });

    return () => {
      artifactViewerReturnFocusRef.current?.focus();
      artifactViewerReturnFocusRef.current = null;
    };
  }, [artifactViewerOpen]);

  function handleArtifactViewerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeArtifactViewer();
      return;
    }
    if (event.key !== "Tab") return;

    const focusableElements = Array.from(
      artifactViewerRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    if (focusableElements.length === 0) {
      event.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = window.document.activeElement;
    if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  function executionSourcePreviewArgs(): string[] {
    if (!artifact) return [];
    if (artifact.activeIteration || !artifact.taskGraphPath) {
      return ["--artifacts", artifact.rootPath];
    }
    return ["--graph", joinDisplayPath(projectSnapshot?.rootPath ?? "", artifact.taskGraphPath)];
  }

  function startPreviewCommand(): string {
    if (!artifact || !selectedTask || !projectSnapshot) return copy.tasks.selectReadyTask;
    const args = [
      "node",
      ".plan2agent/scripts/p2a_execute.mjs",
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
    if (!artifact || !selectedRun) return copy.runs.selectRun;
    const args = [
      "node",
      ".plan2agent/scripts/p2a_execute.mjs",
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
    const confirmed = window.confirm(
      [
        copy.terminal.finishConfirm,
        `run ${selectedRun.runId}`,
        `status ${finishStatus}`,
        finishPreviewCommand(),
        copy.terminal.confirmContinue,
      ].join("\n"),
    );
    if (!confirmed) return;
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

  function orchestrationMarkPreviewCommand(roleStatus: OrchestrationRoleStatus): string {
    if (!selectedOrchestration?.runtimePath || !selectedOrchestrationRole) {
      return copy.runs.noOrchestration;
    }
    const args = [
      "node",
      ".plan2agent/scripts/p2a_orchestrate.mjs",
      "mark-role",
      "--runtime",
      selectedOrchestration.runtimePath,
      "--role",
      selectedOrchestrationRole.roleId,
      "--role-status",
      roleStatus,
    ];
    if (orchestrationDetailInput.trim()) {
      args.push("--detail", orchestrationDetailInput.trim());
    }
    if (
      selectedOrchestrationRole.roleId === "monitor" &&
      roleStatus === "complete" &&
      orchestrationVerdictInput.trim()
    ) {
      args.push("--verdict", orchestrationVerdictInput.trim());
    }
    return args.map(quoteCommandPart).join(" ");
  }

  async function copySelectedRolePrompt() {
    if (!selectedOrchestrationRole?.prompt) return;

    try {
      await window.navigator.clipboard.writeText(selectedOrchestrationRole.prompt);
      setPromptCopyState("copied");
    } catch {
      setPromptCopyState("error");
    }
  }

  async function markSelectedOrchestrationRole(roleStatus: OrchestrationRoleStatus) {
    if (
      !projectSnapshot ||
      !selectedOrchestration?.runtimePath ||
      !selectedOrchestrationRole
    ) {
      return;
    }

    setOrchestrationState("running");
    setOrchestrationResult(null);

    try {
      const result = await window.p2a.orchestration.markRole({
        projectRoot: projectSnapshot.rootPath,
        runtimePath: selectedOrchestration.runtimePath,
        roleId: selectedOrchestrationRole.roleId,
        roleStatus,
        detail: orchestrationDetailInput.trim() || null,
        verdict:
          selectedOrchestrationRole.roleId === "monitor" && roleStatus === "complete"
            ? orchestrationVerdictInput.trim() || null
            : null,
      });
      setOrchestrationResult(result);
      setOrchestrationState(result.exitCode === 0 ? "idle" : "error");
      await loadProjectPath(projectSnapshot.rootPath, { quiet: true });
    } catch (error) {
      setOrchestrationState("error");
      setOrchestrationResult({
        command: orchestrationMarkPreviewCommand(roleStatus),
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

  function renderOverviewStatePanel() {
    const activeFlowItem =
      projectFlow.find((item) => item.state === "active") ??
      [...projectFlow].reverse().find((item) => item.state === "done") ??
      projectFlow[0];
    const progress = onboarding ? overviewProgressSummary(onboarding, artifact, locale, copy) : null;

    return (
      <section className="overview-state-panel" aria-label={copy.common.milestones}>
        <div className="overview-state-panel__head">
          <div>
            <div className="label">{copy.common.milestones}</div>
            <h3>{activeFlowItem?.title ?? projectStateLabel(projectSnapshot, copy)}</h3>
          </div>
          <span className={`state-pill state-pill--${statusClass}`}>{statusText}</span>
        </div>

        <div className="overview-flow-diagram">
          {projectFlow.map((item) => (
            <div
              className={`overview-flow-step overview-flow-step--${item.state}`}
              key={item.id}
              aria-current={item.state === "active" ? "step" : undefined}
            >
              <span className="mono overview-flow-step__id">{item.id}</span>
              <strong>{item.title}</strong>
              <em>{item.status}</em>
            </div>
          ))}
        </div>

        {progress && (
          <div className="overview-current-progress">
            <div>
              <span>{copy.overview.currentProgress}</span>
              <strong>{progress.title}</strong>
              <small>{progress.detail}</small>
            </div>
            <div>
              <span>{copy.overview.nextStep}</span>
              <strong>{progress.nextStep}</strong>
            </div>
          </div>
        )}

        <div className="overview-state-metrics" aria-label={copy.common.projectSummary}>
          <div>
            <span>{copy.overview.readyTasks}</span>
            <strong>
              {artifact
                ? `${formatCount(artifact.taskCounts.ready, locale)} / ${formatCount(
                    artifact.taskCounts.total,
                    locale,
                  )}`
                : "0 / 0"}
            </strong>
          </div>
          <div>
            <span>{copy.overview.runs}</span>
            <strong>{artifact ? formatCount(artifact.runCount, locale) : "0"}</strong>
          </div>
        </div>
      </section>
    );
  }

  function renderOverviewTab() {
    return renderOverviewStatePanel();
  }

  function renderArtifactViewer() {
    if (artifactFileState.status === "idle") return null;

    const document = artifactFileState.document;
    const file = artifactFileState.status === "ready" ? artifactFileState.file : null;

    return (
      <div className="artifact-viewer-backdrop" role="presentation" onClick={closeArtifactViewer}>
        <section
          className="artifact-viewer"
          ref={artifactViewerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="artifact-viewer-title"
          onKeyDown={handleArtifactViewerKeyDown}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="artifact-viewer__head">
            <div>
              <div className="label">{artifactGroupLabel(document.group, copy)}</div>
              <h3 id="artifact-viewer-title">{document.label}</h3>
              <span className="mono">{document.relativePath}</span>
            </div>
            <button
              className="icon-button"
              ref={artifactViewerCloseButtonRef}
              type="button"
              onClick={closeArtifactViewer}
              aria-label={copy.common.closeArtifactViewer}
            >
              <X size={15} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>

          {artifactFileState.status === "loading" && (
            <div className="empty-panel artifact-viewer__empty">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.artifacts.loadingDocument}</span>
            </div>
          )}

          {artifactFileState.status === "error" && (
            <div className="diagnostic diagnostic--error">
              <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
              <span>{artifactFileState.message}</span>
            </div>
          )}

          {file && (
            <>
              <div className="artifact-viewer__meta">
                <span className="mono">{file.kind}</span>
                <span className="mono">{formatBytes(file.sizeBytes)}</span>
                <span className="mono">{formatDateTime(file.modifiedAt, locale, copy)}</span>
              </div>
              {file.kind === "markdown" ? (
                <MarkdownPreview content={file.content} />
              ) : file.kind === "json" ? (
                <JsonPreview content={file.content} labels={copy.artifacts.jsonViewer} />
              ) : (
                <pre className={`artifact-viewer__content artifact-viewer__content--${file.kind}`}>
                  {formatArtifactPreview(file)}
                </pre>
              )}
            </>
          )}
        </section>
      </div>
    );
  }

  function renderArtifactsTab() {
    return (
      <>
        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.overview.artifacts}</div>
              <h3>{copy.artifacts.roots}</h3>
            </div>
            <span className="section-meta mono">
              {projectSnapshot
                ? `${formatCount(projectSnapshot.artifacts.length, locale)} ${copy.artifacts.roots}`
                : copy.common.noProject}
            </span>
          </div>
          {projectSnapshot && projectSnapshot.artifacts.length > 0 ? (
            <div className="artifact-root-list">
              {projectSnapshot.artifacts.map((item) => (
                <button
                  className={`artifact-root-card${
                    selectedArtifact?.rootPath === item.rootPath ? " artifact-root-card--selected" : ""
                  }`}
                  key={item.rootPath}
                  type="button"
                  onClick={() => setSelectedArtifactRootPath(item.rootPath)}
                >
                  <span>
                    <strong>{item.projectId}</strong>
                    <em className="mono">{item.relativePath}</em>
                  </span>
                  <span className="artifact-root-card__meta">
                    <em>{item.activeIteration ?? copy.common.none}</em>
                    <em>{formatCount(item.taskCounts.total, locale)} {copy.nav.tasks}</em>
                    <em>{formatCount(item.runCount, locale)} {copy.nav.runs}</em>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.common.noArtifactRoot}</span>
            </div>
          )}
        </section>

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.artifacts.documents}</div>
              <h3>{copy.artifacts.artifactDocuments}</h3>
            </div>
            <span className="section-meta mono">
              {artifactDocuments.length} {copy.artifacts.files}
            </span>
          </div>
          {artifactDocuments.length > 0 ? (
            <div className="artifact-document-list">
              {artifactDocuments.map((document) => (
                <div
                  className={`artifact-document-row${
                    selectedArtifactDocument?.id === document.id
                      ? " artifact-document-row--selected"
                      : ""
                  }`}
                  key={document.id}
                  onDoubleClick={() => void openArtifactDocument(document)}
                >
                  <button
                    className="artifact-document-row__main"
                    type="button"
                    onClick={() => setSelectedArtifactDocumentId(document.id)}
                    aria-current={
                      selectedArtifactDocument?.id === document.id ? "true" : undefined
                    }
                  >
                    <span className="mono">{artifactGroupLabel(document.group, copy)}</span>
                    <strong>{document.label}</strong>
                    <small className="mono">{document.relativePath}</small>
                  </button>
                  <span className={`validation-chip validation-chip--${document.state}`}>
                    {statusLabel(document.state, copy)}
                  </span>
                  <span className="mono artifact-document-row__meta">{document.meta}</span>
                  <button
                    className="artifact-document-row__open"
                    type="button"
                    onClick={() => void openArtifactDocument(document)}
                  >
                    {copy.common.open}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.artifacts.noReadableDocument}</span>
            </div>
          )}
        </section>

        {selectedArtifact && (
          <section className="workbench-panel">
            <div className="section-head">
              <div>
                <div className="label">{copy.artifacts.validation}</div>
                <h3>{copy.artifacts.schemaState}</h3>
              </div>
            </div>
            <div className="validation-strip" aria-label={copy.common.artifactSchemaValidation}>
              {selectedArtifact.validations.map((validation) => (
                <span
                  className={`validation-chip validation-chip--${validation.status}`}
                  key={validation.id}
                  title={validation.errors.join("\n") || validation.relativePath || validation.label}
                >
                  {validation.label}
                  <span className="mono">{statusLabel(validation.status, copy)}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {renderArtifactViewer()}
      </>
    );
  }

  function renderTasksTab() {
    return (
      <>
        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.tasks.tasks}</div>
              <h3>{copy.tasks.taskGraph}</h3>
            </div>
            <span className="section-meta mono">
              {artifact?.taskGraphPath ?? copy.tasks.noTaskGraph}
            </span>
          </div>
          {tasks.length > 0 ? (
            <div className="task-table" role="list" aria-label={copy.common.taskGraphRows}>
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
                    {task.ready ? copy.status.ready : statusLabel(task.status, copy)}
                  </span>
                  <span className="task-row__main">
                    <strong>{task.title}</strong>
                    <small>{task.description}</small>
                  </span>
                  <span className="task-row__meta mono">{dependencyText(task, copy)}</span>
                  <span className="task-row__meta mono">{runForTaskText(task, locale, copy)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.tasks.noTasks}</span>
            </div>
          )}
        </section>

        {tasks.length > 0 && (
          <section className="workbench-panel">
            <div className="section-head">
              <div>
                <div className="label">{copy.tasks.dependencies}</div>
                <h3>{copy.tasks.executionOrder}</h3>
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
                    <strong>{statusLabel(task.status, copy)}</strong>
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
      <>
        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.runs.runs}</div>
              <h3>{copy.runs.runHistory}</h3>
            </div>
            <span className="section-meta mono">{artifact?.runIndexPath ?? copy.runs.noRunIndex}</span>
          </div>
          {runs.length > 0 ? (
            <div className="run-table" role="list" aria-label={copy.common.runHistoryRows}>
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
                    {statusLabel(run.status, copy)}
                  </span>
                  <span className="mono">{run.taskId}</span>
                  <span className="mono">{run.agentTool}</span>
                  <span className="mono">{formatDateTime(run.startedAt, locale, copy)}</span>
                  <span className="mono">{formatDuration(run.startedAt, run.finishedAt, copy)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-panel">
              <History size={18} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.runs.noRuns}</span>
            </div>
          )}
        </section>
        {renderRunOrchestrationPanel()}
        {selectedRun?.status === "started" && renderFinishPanel()}
      </>
    );
  }

  function renderRunOrchestrationPanel() {
    if (!selectedRun) return null;

    return (
      <section className="workbench-panel orchestration-panel">
        <div className="section-head">
          <div>
            <div className="label">{copy.runs.orchestration}</div>
            <h3>{selectedRun.runId}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedOrchestration?.phase ?? "todo"}`}>
            {selectedOrchestration?.phase ?? copy.common.none}
          </span>
        </div>

        {!selectedOrchestration ? (
          <div className="empty-panel">
            <Layers size={18} strokeWidth={1.7} aria-hidden="true" />
            <span>{copy.runs.noOrchestration}</span>
          </div>
        ) : (
          <>
            <div className="detail-list detail-list--embedded orchestration-summary">
              <div>
                <span>{copy.common.mode}</span>
                <strong className="mono">{selectedOrchestration.mode ?? copy.common.none}</strong>
              </div>
              <div>
                <span>{copy.runs.nextRole}</span>
                <strong className="mono">
                  {selectedOrchestration.next?.nextRole?.roleId ?? copy.common.none}
                </strong>
              </div>
              <div>
                <span>{copy.runs.events}</span>
                <strong className="mono">{formatCount(selectedOrchestration.eventCount, locale)}</strong>
              </div>
              <div>
                <span>{copy.runs.monitorGate}</span>
                <strong>{selectedOrchestration.monitorRequired ? copy.runs.needed : copy.runs.notNeeded}</strong>
              </div>
              <div>
                <span>{copy.runs.supervision}</span>
                <strong>{selectedOrchestration.next?.startsProcess ? copy.runs.startsProcess : copy.runs.noProcess}</strong>
              </div>
              <div>
                <span>{copy.runs.lastEvent}</span>
                <strong className="mono">
                  {selectedOrchestration.lastEvent
                    ? `${selectedOrchestration.lastEvent.roleId}/${selectedOrchestration.lastEvent.type}`
                    : copy.common.none}
                </strong>
              </div>
            </div>

            <div className="orchestration-layout">
              <div className="orchestration-role-list" role="list" aria-label={copy.common.orchestrationRoles}>
                {selectedOrchestration.roles.map((role) => (
                  <button
                    className={`orchestration-role${
                      selectedOrchestrationRole?.roleId === role.roleId
                        ? " orchestration-role--selected"
                        : ""
                    } orchestration-role--${role.status}`}
                    key={role.roleId}
                    type="button"
                    onClick={() => {
                      setSelectedOrchestrationRoleId(role.roleId);
                      setPromptCopyState("idle");
                    }}
                    role="listitem"
                  >
                    <span className="mono">{role.roleId}</span>
                    <strong>
                      {role.role} · {role.agentTool}
                    </strong>
                    <em className="mono">
                      {role.profile} · {role.profileSource}
                    </em>
                    <span className="orchestration-role__reason" title={role.profileReason}>
                      {role.profileReason}
                    </span>
                    <small className={`status-badge status-badge--${role.status}`}>
                      {statusLabel(role.status, copy)}
                    </small>
                  </button>
                ))}
              </div>

              <div className="orchestration-prompt">
                <div className="orchestration-prompt__head">
                  <div>
                    <div className="label">{copy.runs.rolePrompt}</div>
                    <h3>{selectedOrchestrationRole?.roleId ?? copy.common.none}</h3>
                  </div>
                  <button
                    className="terminal-control"
                    type="button"
                    onClick={copySelectedRolePrompt}
                    disabled={!selectedOrchestrationRole?.prompt}
                  >
                    <Copy size={13} strokeWidth={1.7} aria-hidden="true" />
                    {promptCopyState === "copied"
                      ? copy.runs.copied
                      : promptCopyState === "error"
                        ? copy.common.invalid
                        : copy.runs.copyPrompt}
                  </button>
                </div>
                {selectedOrchestrationRole && (
                  <div className="detail-list detail-list--embedded orchestration-guide">
                    <div>
                      <span>{copy.runs.providerSurface}</span>
                      <strong>{selectedOrchestrationRole.executionGuide.surface}</strong>
                    </div>
                    <div>
                      <span>{copy.runs.recommendedFeature}</span>
                      <strong className="mono">
                        {selectedOrchestrationRole.executionGuide.recommendedFeature}
                      </strong>
                    </div>
                    <div>
                      <span>{copy.runs.fallbackMode}</span>
                      <strong>{selectedOrchestrationRole.executionGuide.fallbackMode}</strong>
                    </div>
                  </div>
                )}
                <pre className="prompt-preview orchestration-prompt__body">
                  {selectedOrchestrationRole?.prompt ?? copy.runs.noRolePrompt}
                </pre>

                <div className="orchestration-record">
                  <label className="field-label">
                    <span>{copy.runs.actionNote}</span>
                    <textarea
                      className="supervisor-textarea"
                      value={orchestrationDetailInput}
                      onChange={(event) => setOrchestrationDetailInput(event.target.value)}
                      placeholder={copy.runs.actionNotePlaceholder}
                    />
                  </label>
                  {selectedOrchestrationRole?.roleId === "monitor" && (
                    <label className="field-label">
                      <span>{copy.terminal.monitorVerdict}</span>
                      <input
                        className="text-input mono"
                        value={orchestrationVerdictInput}
                        onChange={(event) => setOrchestrationVerdictInput(event.target.value)}
                        placeholder={copy.terminal.monitorVerdictPlaceholder}
                      />
                    </label>
                  )}
                  <div className="orchestration-actions" aria-label={copy.runs.recordState}>
                    {orchestrationRoleStatusOptions.map((roleStatus) => (
                      <button
                        className="terminal-control"
                        key={roleStatus}
                        type="button"
                        onClick={() => void markSelectedOrchestrationRole(roleStatus)}
                        disabled={
                          orchestrationState === "running" ||
                          !selectedOrchestration.runtimePath ||
                          !selectedOrchestrationRole ||
                          (roleStatus === "complete" &&
                            selectedOrchestrationRole.roleId === "monitor" &&
                            !orchestrationVerdictInput.trim())
                        }
                      >
                        {roleStatus === "complete" && (
                          <CheckCircle2 size={13} strokeWidth={1.7} aria-hidden="true" />
                        )}
                        {roleStatus === "blocked" && (
                          <AlertTriangle size={13} strokeWidth={1.7} aria-hidden="true" />
                        )}
                        {roleStatus === "skipped" && (
                          <X size={13} strokeWidth={1.7} aria-hidden="true" />
                        )}
                        {statusLabel(roleStatus, copy)}
                      </button>
                    ))}
                    <span className="mono">
                      {orchestrationResult
                        ? `exit ${orchestrationResult.exitCode} · ${formatMilliseconds(
                            orchestrationResult.durationMs,
                            copy,
                          )}`
                        : orchestrationState === "running"
                          ? copy.common.running
                          : copy.runs.recordState}
                    </span>
                  </div>
                  {selectedOrchestrationRole?.roleId === "monitor" &&
                    !orchestrationVerdictInput.trim() && (
                      <div className="diagnostic diagnostic--warn">
                        <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
                        <span>{copy.terminal.monitorVerdictRequired}</span>
                      </div>
                    )}
                </div>

                {selectedOrchestration.next && (
                  <div className="diagnostic diagnostic--ok orchestration-hint">
                    <ShieldCheck size={14} strokeWidth={1.7} aria-hidden="true" />
                    <span className="execution-failure__body">
                      <strong>{schedulerReasonLabel(selectedOrchestration.next.reason, copy)}</strong>
                      <small>
                        {schedulerActionLabel(
                          selectedOrchestration.next.reason,
                          selectedOrchestration.next.nextRole?.roleId,
                          copy,
                        )}
                      </small>
                      <em>{copy.runs.supervisedNoProcess}</em>
                    </span>
                  </div>
                )}

                {orchestrationResult && (
                  <div className="command-output command-output--compact">
                    <pre>{outputPreview(orchestrationResult.stdout, copy)}</pre>
                    <pre>{outputPreview(orchestrationResult.stderr, copy)}</pre>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
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
            <h3>{copy.common.startTask}</h3>
          </div>
        </div>
        <div className="command-preview command-preview--compact">
          <span className="mono">cwd {formatPath(projectSnapshot?.rootPath, copy)}</span>
          <code>{startResult?.command ?? startPreviewCommand()}</code>
        </div>
        <div className="finish-actions finish-actions--stacked">
          <button
            className="terminal-control terminal-control--primary"
            type="button"
            onClick={startSelectedTask}
            disabled={!canStart}
          >
            {startState === "running" ? copy.common.loading : copy.common.startRun}
          </button>
          <span className="mono">
            {startResult
              ? `exit ${startResult.exitCode} · ${formatMilliseconds(startResult.durationMs, copy)}`
              : selectedTask?.ready
                ? copy.status.ready
                : copy.common.notRunnable}
          </span>
        </div>
        {renderStartFailureDiagnostic(true)}
        {startResult && (
          <div className="command-output command-output--compact">
            <pre>{outputPreview(startResult.stdout, copy)}</pre>
            <pre>{outputPreview(startResult.stderr, copy)}</pre>
          </div>
        )}
      </>
    );
  }

  function renderStartFailureDiagnostic(compact = false) {
    const parsedFailure = summarizeStartRunFailure(startResult);
    if (!parsedFailure) return null;
    const failure = localizedExecutionFailure(parsedFailure, "start", copy);

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
    const requiresFailureClass = finishStatus === "blocked" || finishStatus === "failed";
    const noteRequired =
      requiresFailureClass && finishFailureClass === "other";
    const hasRequiredNote = !noteRequired || parseListInput(finishNoteInput).length > 0;
    const enabledVerification = [
      verifyTest ? "test" : null,
      verifyLint ? "lint" : null,
      verifyTypecheck ? "typecheck" : null,
      customVerifyCommand.trim() ? customVerifyType : null,
    ].filter((value): value is string => Boolean(value));
    const verificationSummaryLabel =
      enabledVerification.length > 0 ? enabledVerification.join(", ") : copy.common.none;
    const finishActionStatus = finishResult
      ? `exit ${finishResult.exitCode} · ${formatMilliseconds(finishResult.durationMs, copy)}`
      : selectedRun?.status === "started"
        ? copy.status.ready
        : copy.common.notRunnable;

    return (
      <section className="workbench-panel finish-panel">
        <div className="section-head">
          <div>
            <div className="label">{copy.terminal.finishRun}</div>
            <h3>{selectedRun?.runId ?? copy.runs.noRunSelected}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedRun?.status ?? "todo"}`}>
            {selectedRun ? statusLabel(selectedRun.status, copy) : copy.common.none}
          </span>
        </div>

        <div className="finish-panel__body">
          <div className="finish-panel__controls finish-flow">
            <div className="finish-step">
              <div className="finish-step__head">
                <span className="finish-step__index mono">1</span>
                <span>
                  <strong>{copy.terminal.finishDecision}</strong>
                  <small>{copy.terminal.finishDecisionDetail}</small>
                </span>
              </div>

              <div
                className="finish-choice-grid"
                role="radiogroup"
                aria-label={copy.terminal.finalStatus}
              >
                {finishStatusOptions.map((status) => (
                  <button
                    className={`finish-choice${
                      finishStatus === status ? " finish-choice--selected" : ""
                    }`}
                    key={status}
                    type="button"
                    role="radio"
                    aria-checked={finishStatus === status}
                    onClick={() => setFinishStatus(status)}
                  >
                    <strong>{finishStatusLabel(status, copy)}</strong>
                    <span>{finishStatusDetail(status, copy)}</span>
                  </button>
                ))}
              </div>

              {requiresFailureClass && (
                <label className="field-label finish-failure-class">
                  <span>{copy.terminal.failureClass}</span>
                  <select
                    className="agent-select mono"
                    value={finishFailureClass}
                    onChange={(event) => setFinishFailureClass(event.target.value as FailureClass)}
                  >
                    {failureClassOptions.map((failureClass) => (
                      <option key={failureClass} value={failureClass}>
                        {failureClass}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="finish-step">
              <div className="finish-step__head">
                <span className="finish-step__index mono">2</span>
                <span>
                  <strong>{copy.terminal.verificationChecks}</strong>
                  <small>{copy.terminal.verificationChecksDetail}</small>
                </span>
              </div>

              <div className="check-options finish-checks" aria-label={copy.terminal.verificationOptions}>
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
              </div>

              <details className="finish-disclosure">
                <summary>{copy.terminal.customVerification}</summary>
                <div className="custom-command-row">
                  <select
                    className="agent-select mono"
                    value={customVerifyType}
                    onChange={(event) => setCustomVerifyType(event.target.value as VerificationType)}
                    aria-label={copy.terminal.customVerificationType}
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
                    aria-label={copy.terminal.customVerificationCommand}
                  />
                </div>
              </details>
            </div>

            <div className="finish-step">
              <div className="finish-step__head">
                <span className="finish-step__index mono">3</span>
                <span>
                  <strong>{copy.terminal.finishRecord}</strong>
                  <small>{copy.terminal.finishRecordDetail}</small>
                </span>
              </div>

              <label className="finish-collect">
                <input
                  type="checkbox"
                  checked={collectGit}
                  onChange={(event) => setCollectGit(event.target.checked)}
                />
                <span>{copy.terminal.collectGit}</span>
              </label>

              <div className="form-grid form-grid--two">
                <label className="field-label">
                  <span>{copy.runs.changedFiles}</span>
                  <textarea
                    className="supervisor-textarea"
                    value={changedFilesInput}
                    onChange={(event) => setChangedFilesInput(event.target.value)}
                    placeholder="src/file.ts"
                  />
                </label>
                <label className="field-label">
                  <span>{copy.common.note}</span>
                  <textarea
                    className="supervisor-textarea"
                    value={finishNoteInput}
                    onChange={(event) => setFinishNoteInput(event.target.value)}
                    placeholder={copy.terminal.verificationNotePlaceholder}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="finish-panel__result finish-submit">
            <div className="finish-submit__head">
              <div>
                <div className="label">{copy.terminal.finishAction}</div>
                <h3>{copy.terminal.finishActionDetail}</h3>
              </div>
              <span className="mono">{finishActionStatus}</span>
            </div>

            <div className="finish-summary-grid">
              <div>
                <span>{copy.terminal.finalStatus}</span>
                <strong>{finishStatusLabel(finishStatus, copy)}</strong>
              </div>
              <div>
                <span>{copy.terminal.verificationOptions}</span>
                <strong className="mono">{verificationSummaryLabel}</strong>
              </div>
              <div>
                <span>{copy.terminal.collectGit}</span>
                <strong>{collectGit ? copy.runs.needed : copy.runs.notNeeded}</strong>
              </div>
            </div>

            <div className="finish-actions">
              <button
                className="terminal-control terminal-control--primary"
                type="button"
                onClick={finishSelectedRun}
                disabled={!canFinish || !hasRequiredNote}
              >
                {finishState === "running" ? copy.common.running : copy.terminal.finishRun}
              </button>
            </div>

            <details className="finish-disclosure finish-disclosure--command">
              <summary>{copy.terminal.commandPreview}</summary>
              <div className="command-preview command-preview--compact">
                <span className="mono">cwd {formatPath(projectSnapshot?.rootPath, copy)}</span>
                <code>{finishResult?.command ?? finishPreviewCommand()}</code>
              </div>
            </details>

            {noteRequired && !hasRequiredNote && (
              <div className="diagnostic diagnostic--warn">
                <AlertTriangle size={14} strokeWidth={1.7} aria-hidden="true" />
                <span>{copy.terminal.failureClassOtherNote}</span>
              </div>
            )}
            {renderFinishFailureDiagnostic()}
            {finishResult && (
              <div className="command-output">
                <pre>{outputPreview(finishResult.stdout, copy)}</pre>
                <pre>{outputPreview(finishResult.stderr, copy)}</pre>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  function renderTerminalTab() {
    return (
      <TerminalSurface
        cwd={projectSnapshot?.rootPath}
        command={null}
        agentTool={terminalAgentForExecution(projectSnapshot?.defaultAgentTool)}
        taskId={null}
        taskPrompt={null}
        locale={locale}
      />
    );
  }

  function renderFinishFailureDiagnostic() {
    const parsedFailure = summarizeFinishRunFailure(finishResult);
    if (!parsedFailure) return null;
    const failure = localizedExecutionFailure(parsedFailure, "finish", copy);

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

  function renderSettingsTab() {
    return (
      <>
        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.settings.settings}</div>
              <h3>{copy.settings.projectDefaults}</h3>
            </div>
            <span className={`config-chip config-chip--${configState}`}>{configState}</span>
          </div>
          <div className="settings-grid">
            <div className="detail-list">
              <div>
                <span>{copy.overview.project}</span>
                <strong>{projectSnapshot?.name ?? copy.common.none}</strong>
              </div>
              <div>
                <span>{copy.common.root}</span>
                <strong className="mono">{formatPath(projectSnapshot?.rootPath, copy)}</strong>
              </div>
              <div>
                <span>{copy.common.artifactRoot}</span>
                <strong className="mono">{formatPath(artifact?.relativePath, copy)}</strong>
              </div>
              <div>
                <span>{copy.overview.state}</span>
                <strong>{projectStateLabel(projectSnapshot, copy)}</strong>
              </div>
            </div>

            <label className="settings-control">
              <span>{copy.settings.defaultAgent}</span>
              <select
                className="agent-select mono"
                value={projectSnapshot?.defaultAgentTool ?? "codex"}
                onChange={(event) => changeDefaultAgentTool(event.target.value as ExecutionAgentTool)}
                disabled={!projectSnapshot}
                aria-label={copy.common.defaultAgentTool}
              >
                {EXECUTION_AGENT_TOOLS.map((agentTool) => (
                  <option key={agentTool} value={agentTool}>
                    {agentTool}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-control">
              <span>{copy.settings.language}</span>
              <select
                className="agent-select"
                value={locale}
                onChange={(event) => void changeUiLocale(event.target.value as UiLocale)}
                aria-label={copy.settings.interfaceLanguage}
              >
                {UI_LOCALES.map((item) => (
                  <option key={item} value={item}>
                    {localeNames[item]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.settings.localConfig}</div>
              <h3>{copy.settings.guiState}</h3>
            </div>
            <span className="section-meta mono">
              {guiConfig
                ? `${formatCount(guiConfig.recentProjects.length, locale)} ${copy.settings.recent}`
                : copy.common.none}
            </span>
          </div>
          <div className="detail-list">
            <div>
              <span>{copy.settings.configFile}</span>
              <strong className="mono">{formatPath(guiConfig?.configPath, copy)}</strong>
            </div>
            <div>
              <span>{copy.settings.schema}</span>
              <strong className="mono">{guiConfig?.schemaVersion ?? copy.common.none}</strong>
            </div>
            <div>
              <span>{copy.settings.watch}</span>
              <strong>{watchState}</strong>
            </div>
            <div>
              <span>{copy.settings.lastChange}</span>
              <strong className="mono">{formatTime(lastWatchEvent?.changedAt, locale, copy)}</strong>
            </div>
          </div>
        </section>

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.settings.recent}</div>
              <h3>{copy.settings.projects}</h3>
            </div>
          </div>
          <div className="settings-recent-list">
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
                  <span className="settings-agent mono">{project.defaultAgentTool}</span>
                  <button
                    className="recent-row__forget"
                    type="button"
                    onClick={() => forgetRecentProject(project.rootPath)}
                    aria-label={`${copy.common.forgetProject}: ${project.name}`}
                  >
                    <X size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-panel">
                <FolderOpen size={18} strokeWidth={1.7} aria-hidden="true" />
                <span>{copy.settings.noRecentProjects}</span>
              </div>
            )}
          </div>
        </section>

        <section className="workbench-panel">
          <div className="section-head">
            <div>
              <div className="label">{copy.settings.verification}</div>
              <h3>{copy.settings.developerCommands}</h3>
            </div>
          </div>
          <div className="settings-command-list">
            {settingsCommands.map(([label, command]) => (
              <div className="command-card" key={label}>
                <strong>{label}</strong>
                <code>{command}</code>
              </div>
            ))}
          </div>
        </section>
      </>
    );
  }

  function renderActiveTab() {
    if (activeTab === "tasks") return renderTasksTab();
    if (activeTab === "runs") return renderRunsTab();
    if (activeTab === "artifacts") return renderArtifactsTab();
    if (activeTab === "terminal") return renderTerminalTab();
    if (activeTab === "settings") return renderSettingsTab();
    return renderOverviewTab();
  }

  function renderOverviewInspector() {
    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">{copy.settings.diagnostics}</div>
            <h3>{copy.common.loadResult}</h3>
          </div>
        </div>

        <div className="diagnostic-list">
          {projectSnapshot && (
            <div className={`diagnostic diagnostic--${watchState === "error" ? "error" : "ok"}`}>
              <RefreshCw size={14} strokeWidth={1.7} aria-hidden="true" />
              <span>
                {copy.settings.watch} {watchState}
                {lastWatchEvent?.relativePath ? ` · ${lastWatchEvent.relativePath}` : ""}
              </span>
            </div>
          )}
          <div className={`diagnostic diagnostic--${configState === "error" ? "error" : "ok"}`}>
            <Settings size={14} strokeWidth={1.7} aria-hidden="true" />
            <span>
              {copy.settings.localConfig} {configState}
              {guiConfig
                ? ` · ${formatCount(guiConfig.recentProjects.length, locale)} ${copy.settings.recent}`
                : ""}
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
              <span>{copy.common.openFolderToDetect}</span>
            </div>
          )}
        </div>
      </>
    );
  }

  function renderArtifactInspector() {
    if (!selectedArtifact) {
      return (
        <div className="inspector-empty">
          <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
          <span>{copy.artifacts.noArtifactSelected}</span>
        </div>
      );
    }

    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">{copy.artifacts.selectedArtifact}</div>
            <h3>{selectedArtifact.projectId}</h3>
          </div>
          <span className="section-meta mono">
            {selectedArtifact.activeIteration ?? copy.common.none}
          </span>
        </div>

        <div className="detail-list">
          <div>
            <span>{copy.common.root}</span>
            <strong className="mono">{selectedArtifact.relativePath}</strong>
          </div>
          <div>
            <span>{copy.tasks.taskGraph}</span>
            <strong className="mono">{formatPath(selectedArtifact.taskGraphPath, copy)}</strong>
          </div>
          <div>
            <span>{copy.common.sourceSpec}</span>
            <strong className="mono">{formatPath(selectedArtifact.sourceSpec, copy)}</strong>
          </div>
          <div>
            <span>{copy.artifacts.documents}</span>
            <strong className="mono">{formatCount(artifactDocuments.length, locale)}</strong>
          </div>
        </div>

        {selectedArtifactDocument && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.artifacts.document}</div>
                <h3>{selectedArtifactDocument.label}</h3>
              </div>
              <button
                className="secondary-action secondary-action--compact"
                type="button"
                onClick={() => void openArtifactDocument(selectedArtifactDocument)}
              >
                {copy.common.open}
              </button>
            </div>
            <div className="detail-list">
              <div>
                <span>{copy.common.group}</span>
                <strong className="mono">{artifactGroupLabel(selectedArtifactDocument.group, copy)}</strong>
              </div>
              <div>
                <span>{copy.overview.state}</span>
                <strong className="mono">{statusLabel(selectedArtifactDocument.state, copy)}</strong>
              </div>
              <div>
                <span>{copy.common.path}</span>
                <strong className="mono">{selectedArtifactDocument.relativePath}</strong>
              </div>
            </div>
          </>
        )}

        {selectedArtifact.diagnostics.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.artifacts.diagnostics}</div>
                <h3>{copy.artifacts.artifactChecks}</h3>
              </div>
            </div>
            <div className="diagnostic-list">
              {selectedArtifact.diagnostics.map((diagnostic, index) => {
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
            </div>
          </>
        )}
      </>
    );
  }

  function renderTaskInspector() {
    if (!selectedTask) {
      return (
        <div className="inspector-empty">
          <FileJson size={18} strokeWidth={1.7} aria-hidden="true" />
          <span>{copy.tasks.noTaskSelected}</span>
        </div>
      );
    }

    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">{copy.tasks.selectedTask}</div>
            <h3>{selectedTask.id}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedTask.status}`}>
            {selectedTask.ready ? copy.status.ready : statusLabel(selectedTask.status, copy)}
          </span>
        </div>

        <div className="detail-list">
          <div>
            <span>{copy.tasks.title}</span>
            <strong>{selectedTask.title}</strong>
          </div>
          <div>
            <span>{copy.tasks.target}</span>
            <strong className="mono">{selectedTask.targetArea}</strong>
          </div>
          <div>
            <span>{copy.tasks.dependencies}</span>
            <strong className="mono">{dependencyText(selectedTask, copy)}</strong>
          </div>
          <div>
            <span>{copy.tasks.latestRun}</span>
            <strong className="mono">{selectedTask.latestRunId ?? copy.common.none}</strong>
          </div>
        </div>

        <details className="inspector-disclosure">
          <summary>
            <span className="inspector-disclosure__title">
              <span className="label">{copy.tasks.acceptance}</span>
              <strong>{copy.tasks.criteria}</strong>
            </span>
          </summary>
          <ul className="criteria-list">
            {selectedTask.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </details>

        {selectedTaskRuns.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.runs.runs}</div>
                <h3>{copy.tasks.taskHistory}</h3>
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
                  <strong>{statusLabel(run.status, copy)}</strong>
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
          <span>{copy.runs.noRunSelected}</span>
        </div>
      );
    }

    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">{copy.runs.selectedRun}</div>
            <h3>{selectedRun.runId}</h3>
          </div>
          <span className={`status-badge status-badge--${selectedRun.status}`}>
            {statusLabel(selectedRun.status, copy)}
          </span>
        </div>
        {renderRunFailureSummary(selectedRun)}
        <div className="detail-list">
          <div>
            <span>{copy.runs.task}</span>
            <strong className="mono">{selectedRun.taskId}</strong>
          </div>
          <div>
            <span>{copy.runs.agent}</span>
            <strong className="mono">{selectedRun.agentTool}</strong>
          </div>
          <div>
            <span>{copy.runs.started}</span>
            <strong className="mono">{formatDateTime(selectedRun.startedAt, locale, copy)}</strong>
          </div>
          <div>
            <span>{copy.runs.duration}</span>
            <strong className="mono">
              {formatDuration(selectedRun.startedAt, selectedRun.finishedAt, copy)}
            </strong>
          </div>
          <div>
            <span>{copy.runs.verification}</span>
            <strong className="mono">{verificationSummary(selectedRun, copy)}</strong>
          </div>
          <div>
            <span>{copy.runs.changedFiles}</span>
            <strong className="mono">{selectedRun.changedFiles.length}</strong>
          </div>
        </div>
        {selectedOrchestration && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.runs.orchestration}</div>
                <h3>{selectedOrchestration.phase ?? copy.common.none}</h3>
              </div>
            </div>
            <div className="detail-list">
              <div>
                <span>{copy.common.mode}</span>
                <strong className="mono">{selectedOrchestration.mode ?? copy.common.none}</strong>
              </div>
              <div>
                <span>{copy.runs.nextRole}</span>
                <strong className="mono">
                  {selectedOrchestration.next?.nextRole?.roleId ?? copy.common.none}
                </strong>
              </div>
              <div>
                <span>{copy.runs.monitorGate}</span>
                <strong>{selectedOrchestration.monitorRequired ? copy.runs.needed : copy.runs.notNeeded}</strong>
              </div>
            </div>
            <div className="ref-list">
              {selectedOrchestration.runtimePath && <code>{selectedOrchestration.runtimePath}</code>}
              {selectedOrchestration.planPath && <code>{selectedOrchestration.planPath}</code>}
            </div>
          </>
        )}
        {selectedRun.verification.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.runs.verification}</div>
                <h3>{copy.runs.results}</h3>
              </div>
            </div>
            <div className="verification-list">
              {selectedRun.verification.map((verification, index) => (
                <div
                  className={`verification-item verification-item--${verification.status}`}
                  key={`${verification.type}-${verification.command}-${index}`}
                >
                  <span className="mono">{verification.type}</span>
                  <strong>{statusLabel(verification.status, copy)}</strong>
                  <em className="mono">{formatMilliseconds(verification.durationMs, copy)}</em>
                  <code>{verification.command}</code>
                  {(verification.stdoutTail || verification.stderrTail) && (
                    <pre>
                      {outputPreview(verification.stdoutTail, copy)}
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
                <div className="label">{copy.runs.failure}</div>
                <h3>{copy.runs.classification}</h3>
              </div>
            </div>
            <div className="detail-list">
              <div>
                <span>{copy.runs.classification}</span>
                <strong className="mono">{selectedRun.failure.class}</strong>
              </div>
              <div>
                <span>{copy.runs.retryable}</span>
                <strong className="mono">{selectedRun.failure.retryable}</strong>
              </div>
              <div>
                <span>{copy.runs.decision}</span>
                <strong>
                  {selectedRun.failure.needsUserDecision ? copy.runs.needed : copy.runs.notNeeded}
                </strong>
              </div>
            </div>
          </>
        )}
        {selectedRun.changedFiles.length > 0 && (
          <>
            <div className="section-head section-head--tight">
              <div>
                <div className="label">{copy.runs.changes}</div>
                <h3>{copy.runs.files}</h3>
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
            <div className="label">{copy.runs.refs}</div>
            <h3>{copy.runs.runFiles}</h3>
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
            {run.failure
              ? `${copy.runs.failure} ${run.failure.class}`
              : copy.executionFailure.verification_failed.title}
          </strong>
          <small>
            {failedVerification
              ? `${failedVerification.type}: ${failedVerification.command}`
              : `${copy.runs.retryable} ${run.failure?.retryable ?? copy.common.unknown}`}
          </small>
          <em>{outputPreview(failedVerification?.stderrTail, copy)}</em>
        </span>
      </div>
    );
  }

  function renderSettingsInspector() {
    return (
      <>
        <div className="section-head">
          <div>
            <div className="label">{copy.settings.settings}</div>
            <h3>{copy.settings.runtime}</h3>
          </div>
        </div>
        <div className="detail-list">
          <div>
            <span>app</span>
            <strong className="mono">{runtimeInfo?.appVersion ?? copy.common.unknown}</strong>
          </div>
          <div>
            <span>electron</span>
            <strong className="mono">
              {runtimeInfo?.electronVersion ?? copy.common.unknown}
            </strong>
          </div>
          <div>
            <span>node</span>
            <strong className="mono">{runtimeInfo?.nodeVersion ?? copy.common.unknown}</strong>
          </div>
          <div>
            <span>platform</span>
            <strong className="mono">{runtimeInfo?.platform ?? copy.common.unknown}</strong>
          </div>
        </div>

        <div className="section-head section-head--tight">
          <div>
            <div className="label">config</div>
            <h3>{copy.settings.localFile}</h3>
          </div>
        </div>
        <div className="ref-list">
          <code>{formatPath(guiConfig?.configPath, copy)}</code>
        </div>

        <div className="section-head section-head--tight">
          <div>
            <div className="label">status</div>
            <h3>{copy.settings.diagnostics}</h3>
          </div>
        </div>
        <div className="diagnostic-list">
          <div className={`diagnostic diagnostic--${configState === "error" ? "error" : "ok"}`}>
            <Settings size={14} strokeWidth={1.7} aria-hidden="true" />
            <span>{copy.settings.localConfig} {configState}</span>
          </div>
          <div className={`diagnostic diagnostic--${projectSnapshot ? "ok" : "warn"}`}>
            <FolderOpen size={14} strokeWidth={1.7} aria-hidden="true" />
            <span>{projectSnapshot ? copy.common.projectLoaded : copy.common.noProject}</span>
          </div>
          <div className="diagnostic diagnostic--ok">
            <CheckCircle2 size={14} strokeWidth={1.7} aria-hidden="true" />
            <span className="mono">npm run smoke:packaged</span>
          </div>
        </div>
      </>
    );
  }

  function renderInspector() {
    if (activeTab === "tasks") return renderTaskInspector();
    if (activeTab === "runs") return renderRunInspector();
    if (activeTab === "artifacts") return renderArtifactInspector();
    if (activeTab === "settings") return renderSettingsInspector();
    return renderOverviewInspector();
  }

  const inspectorVisible = activeTab !== "overview" && activeTab !== "terminal";
  const workspaceStyle = {
    "--sidebar-w": `${sidebarWidth}px`,
  } as CSSProperties;

  function beginSidebarResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateSidebarResize(event: PointerEvent<HTMLDivElement>) {
    const resize = sidebarResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX));
  }

  function endSidebarResize(event: PointerEvent<HTMLDivElement>) {
    const resize = sidebarResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    sidebarResizeRef.current = null;
  }

  function handleSidebarResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width - 12));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width + 12));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(MAX_SIDEBAR_WIDTH);
    }
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
          <strong>{projectSnapshot?.name ?? copy.app.titleFallback}</strong>
          <span>{projectSnapshot ? projectStateLabel(projectSnapshot, copy) : copy.app.readOnlyShellReady}</span>
        </div>
      </header>

      <section
        className={`workspace${inspectorVisible ? "" : " workspace--wide"}`}
        style={workspaceStyle}
      >
        <nav className="rail" aria-label={copy.common.primaryNavigation}>
          {navItems.map(([id, Icon]) => (
            <button
              className={`rail__item${activeTab === id ? " rail__item--active" : ""}`}
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? "page" : undefined}
            >
              <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.nav[id]}</span>
            </button>
          ))}
        </nav>

        <aside className="sidebar">
          <div className="panel-head">
            <div>
              <div className="label">{copy.overview.project}</div>
              <h1>{projectSnapshot ? projectSnapshot.name : copy.app.openProject}</h1>
            </div>
          </div>

          <div className="action-stack">
            <button className="primary-action" type="button" onClick={openProjectFolder}>
              <FolderOpen size={16} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.app.openProject}</span>
            </button>
            <button
              className="secondary-action"
              type="button"
              onClick={reloadProjectFolder}
              disabled={!projectSnapshot || openState === "loading"}
            >
              <RefreshCw size={15} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.app.reload}</span>
            </button>
          </div>

          <section className="recent-panel">
            <div className="panel-head panel-head--compact">
              <div>
                <div className="label">{copy.settings.recent}</div>
                <h3>{copy.settings.projects}</h3>
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
                      aria-label={`${copy.common.forgetProject}: ${project.name}`}
                    >
                      <X size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-inline empty-inline--compact">
                  {configState === "loading"
                    ? copy.common.loading
                    : copy.settings.noRecentProjects}
                </div>
              )}
            </div>
          </section>

          <dl className="compact-dl">
            <dt>{copy.overview.project}</dt>
            <dd className="mono">
              {projectSnapshot?.projectId ?? artifact?.projectId ?? copy.common.none}
            </dd>
            <dt>{copy.overview.state}</dt>
            <dd>{projectStateLabel(projectSnapshot, copy)}</dd>
            <dt>{copy.common.artifactRoot}</dt>
            <dd className="mono">{formatPath(artifact?.relativePath, copy)}</dd>
            <dt>{copy.common.mode}</dt>
            <dd>{copy.common.readOnly}</dd>
            <dt>{copy.runs.agent}</dt>
            <dd className="compact-dl__control">
              <select
                className="agent-select mono"
                value={projectSnapshot?.defaultAgentTool ?? "codex"}
                onChange={(event) => changeDefaultAgentTool(event.target.value as ExecutionAgentTool)}
                disabled={!projectSnapshot}
                aria-label={copy.common.defaultAgentTool}
              >
                {EXECUTION_AGENT_TOOLS.map((agentTool) => (
                  <option key={agentTool} value={agentTool}>
                    {agentTool}
                  </option>
                ))}
              </select>
            </dd>
            <dt>{copy.settings.watch}</dt>
            <dd>{watchState}</dd>
            <dt>{copy.settings.lastChange}</dt>
            <dd className="mono">{formatTime(lastWatchEvent?.changedAt, locale, copy)}</dd>
          </dl>

          <section className="mini-panel">
            <div className="label">{copy.common.milestones}</div>
            <div className="mini-step-list">
              {projectFlow.map((item) => (
                <div className={`mini-step mini-step--${item.state}`} key={item.id}>
                  <span className="mono">{item.id}</span>
                  <strong>{item.title}</strong>
                  <em>{item.status}</em>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <div
          className="sidebar-resizer"
          role="separator"
          aria-label={copy.common.resizeSidebar}
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={beginSidebarResize}
          onPointerMove={updateSidebarResize}
          onPointerUp={endSidebarResize}
          onPointerCancel={endSidebarResize}
          onKeyDown={handleSidebarResizeKeyDown}
        />

        <section className="content">
          <div className="content-head">
            <div>
              <div className="label">{tab.label}</div>
              <h2>{projectSnapshot ? tab.title : copy.app.openProject}</h2>
            </div>
          </div>

          {renderActiveTab()}
        </section>

        {inspectorVisible && <aside className="inspector">{renderInspector()}</aside>}
      </section>

      <footer className="statusbar">
        <span className="mono">{formatPath(artifact?.relativePath, copy)}</span>
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
