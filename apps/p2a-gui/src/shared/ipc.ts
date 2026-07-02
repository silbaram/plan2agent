export const IPC_CHANNELS = {
  appGetRuntimeInfo: "app:getRuntimeInfo",
  appOpenExternal: "app:openExternal",
  configGet: "config:get",
  configSetLocale: "config:setLocale",
  projectOpenFolder: "project:openFolder",
  projectLoad: "project:load",
  projectChanged: "project:changed",
  projectForgetRecent: "project:forgetRecent",
  projectSetDefaultAgentTool: "project:setDefaultAgentTool",
  artifactReadFile: "artifact:readFile",
  terminalStart: "terminal:start",
  terminalInput: "terminal:input",
  terminalResize: "terminal:resize",
  terminalStop: "terminal:stop",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  executionStartRun: "execution:startRun",
  executionFinishRun: "execution:finishRun",
  operationalRunAction: "operational:runAction",
  orchestrationMarkRole: "orchestration:markRole",
} as const;

export const AGENT_TOOLS = ["codex", "claude", "gemini", "aider", "cursor"] as const;
export const EXECUTION_AGENT_TOOLS = ["codex", "claude", "manual"] as const;
export const DEFAULT_AGENT_TOOL: AgentTool = "codex";
export const DEFAULT_EXECUTION_AGENT_TOOL: ExecutionAgentTool = "codex";
export const UI_LOCALES = ["ko", "en"] as const;
export const DEFAULT_UI_LOCALE: UiLocale = "ko";

export type AgentTool = (typeof AGENT_TOOLS)[number];
export type ExecutionAgentTool = (typeof EXECUTION_AGENT_TOOLS)[number];
export type UiLocale = (typeof UI_LOCALES)[number];

export type RuntimeInfo = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
};

export type ProjectOpenResult = {
  canceled: boolean;
  path: string | null;
  snapshot: ProjectSnapshot | null;
};

export type ProjectLoadOptions = {
  remember?: boolean;
};

export type ProjectDetectionState =
  | "no_p2a"
  | "installed_empty"
  | "planning_in_progress"
  | "iteration_init_required"
  | "execution_ready"
  | "cycle_close_ready"
  | "broken_install";

export type DiagnosticSeverity = "ok" | "warn" | "error";

export type ProjectDiagnostic = {
  severity: DiagnosticSeverity;
  message: string;
};

export type SchemaValidationStatus = "missing" | "valid" | "invalid";

export type SchemaValidationSummary = {
  id: "intake" | "spec" | "task-graph" | "review" | "run-index";
  label: string;
  relativePath: string | null;
  status: SchemaValidationStatus;
  errors: string[];
};

export type ProjectFileCheck = {
  id: string;
  label: string;
  relativePath: string;
  kind: "file" | "directory";
  exists: boolean;
};

export type GateState = "missing" | "present";

export type GateSummary = {
  id: "A" | "B" | "C" | "D";
  label: string;
  state: GateState;
  relativePath: string;
};

export type TaskCounts = {
  total: number;
  ready: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
};

export type TaskStatus = "todo" | "blocked" | "in_progress" | "done";

export type RunStatus = "started" | "finished" | "failed" | "blocked";

export type VerificationType = "test" | "lint" | "typecheck" | "custom";

export type VerificationStatus = "passed" | "failed" | "skipped" | "not_run";

export type ProposalStatus = "proposed" | "approved" | "rejected" | "deferred";

export type ProposalRisk = "low" | "medium" | "high";

export type ProposalSummary = {
  proposalId: string;
  sourceRunId: string | null;
  status: ProposalStatus;
  risk: ProposalRisk;
  problem: string;
  recommendedChange: string;
  targetFiles: string[];
  evidenceCount: number;
  relativePath: string;
  note: string | null;
};

export type FailureClass =
  | "verification_failed"
  | "test_flake"
  | "scope_violation"
  | "missing_dependency"
  | "environment_failure"
  | "implementation_incomplete"
  | "other";

export type FailureRetryability = "yes" | "no" | "after_fix";

export type FailureSource = "owner" | "monitor" | "implementer";

export type WorkbenchRunVerification = {
  type: VerificationType;
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  source: "config" | "command" | "manual";
};

export type WorkbenchRunFailure = {
  class: FailureClass;
  retryable: FailureRetryability;
  needsUserDecision: boolean;
  source: FailureSource;
};

export type WorkbenchRunReproduction = {
  steps: string[];
  commands: string[];
  notes: string[];
};

export type WorkbenchRunLocalization = {
  findings: string[];
  files: string[];
};

export type WorkbenchRunFixSummary = {
  summaries: string[];
  files: string[];
};

export type WorkbenchRunGuard = {
  checks: string[];
  notes: string[];
};

export type OrchestrationMode = "solo" | "solo_monitor" | "team";

export type OrchestrationRuntimePhase =
  | "initialized"
  | "running"
  | "blocked"
  | "ready_for_monitor"
  | "ready_to_finish"
  | "closed";

export type OrchestrationRoleStatus =
  | "pending"
  | "active"
  | "blocked"
  | "complete"
  | "skipped";

export type WorkbenchOrchestrationExecutionGuide = {
  surface: string;
  recommendedFeature: string;
  fallbackMode: string;
  supervisionRequired: boolean;
  startsProcess: boolean;
  constraints: string[];
};

export type WorkbenchOrchestrationRole = {
  roleId: string;
  role: string;
  profile: string;
  profileSource: string;
  profileReason: string;
  agentTool: string;
  executionGuide: WorkbenchOrchestrationExecutionGuide;
  scope: string;
  status: OrchestrationRoleStatus;
  command: string | null;
  prompt: string | null;
};

export type WorkbenchOrchestrationEvent = {
  eventId: string;
  createdAt: string;
  roleId: string;
  type: string;
  summary: string;
  requiresOwnerAction: boolean;
};

export type WorkbenchOrchestrationNextRole = {
  roleId: string;
  role: string;
  profile: string;
  profileSource: string;
  profileReason: string;
  agentTool: string;
  executionGuide: WorkbenchOrchestrationExecutionGuide;
  status: OrchestrationRoleStatus;
  command: string | null;
};

export type WorkbenchOrchestrationSchedulerHint = {
  supervisedOnly: boolean;
  startsProcess: boolean;
  nextRole: WorkbenchOrchestrationNextRole | null;
  reason: string;
  instruction: string;
  resolutionHints: string[];
  safetyBoundary: string;
};

export type WorkbenchRunOrchestration = {
  planId: string | null;
  runtimeId: string | null;
  mode: OrchestrationMode | null;
  phase: OrchestrationRuntimePhase | null;
  blocked: boolean;
  needsUserDecision: boolean;
  planPath: string | null;
  runtimePath: string | null;
  sourcePlanRef: string | null;
  monitorRequired: boolean;
  monitorVerdictPath: string | null;
  roles: WorkbenchOrchestrationRole[];
  eventCount: number;
  lastEvent: WorkbenchOrchestrationEvent | null;
  next: WorkbenchOrchestrationSchedulerHint | null;
  updatedAt: string | null;
};

export type WorkbenchTask = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  acceptanceCriteria: string[];
  targetArea: string;
  suggestedAgentPrompt: string;
  sourceSpecRefs: string[];
  blockReason: string | null;
  ready: boolean;
  runIds: string[];
  latestRunId: string | null;
};

export type WorkbenchRun = {
  runId: string;
  taskId: string;
  iterationId: string | null;
  status: RunStatus;
  agentTool: string;
  workspaceRef: string;
  taskGraphRef: string;
  runRef: string;
  startedAt: string;
  finishedAt: string | null;
  changedFiles: string[];
  verification: WorkbenchRunVerification[];
  notes: string[];
  reproduction: WorkbenchRunReproduction | null;
  localization: WorkbenchRunLocalization | null;
  fixSummary: WorkbenchRunFixSummary | null;
  guard: WorkbenchRunGuard | null;
  failure: WorkbenchRunFailure | null;
  orchestration: WorkbenchRunOrchestration | null;
};

export type UpdateReportSummary = {
  command: string;
  kind: "preview" | "apply";
  status: string;
  appliedAt: string | null;
  createdAt: string | null;
  relativePath: string;
  appliedFiles: number;
  changedItems: number;
  blockers: number;
  error: string | null;
};

export type EvalArtifactSummary = {
  evalDir: string | null;
  indexPath: string | null;
  digestPath: string | null;
  analysisPath: string | null;
  gradeCount: number;
  nonPassGrades: number;
  clusters: number;
  maintenanceDraftTasks: number;
  latestGeneratedAt: string | null;
};

export type MemoryDigestSummary = {
  sourcePath: string | null;
  source: "file" | "local";
  totalRuns: number;
  failedOrBlocked: number;
  verificationFailures: number;
  verificationGaps: number;
  proposals: number;
  uncoveredCandidateRuns: number;
};

export type MemoryHistorySummary = {
  sourcePath: string | null;
  source: "file";
  totalEvents: number;
  visibleEvents: number;
  localEvents: number;
  remoteEvents: number;
  failedOrBlockedRuns: number;
  latestEventAt: string | null;
};

export type MemorySearchSummary = {
  sourcePath: string | null;
  source: "file";
  query: string;
  totalResults: number;
  documentResults: number;
  runResults: number;
  taskResults: number;
  latestGeneratedAt: string | null;
};

export type ArtifactSummary = {
  projectId: string;
  rootPath: string;
  relativePath: string;
  activeIteration: string | null;
  requiresIterationInit: boolean;
  taskGraphVersion: string | null;
  sourceSpec: string | null;
  statusPath: string | null;
  taskGraphPath: string | null;
  reviewPath: string | null;
  runIndexPath: string | null;
  gates: GateSummary[];
  validations: SchemaValidationSummary[];
  taskCounts: TaskCounts;
  tasks: WorkbenchTask[];
  runCount: number;
  runs: WorkbenchRun[];
  evalSummary: EvalArtifactSummary | null;
  memoryDigest: MemoryDigestSummary | null;
  memoryHistory: MemoryHistorySummary | null;
  memorySearch: MemorySearchSummary | null;
  diagnostics: ProjectDiagnostic[];
};

export type CommandGuidance = {
  id: "setup" | "import" | "init_iteration" | "validate";
  label: string;
  command: string;
  description: string;
};

export type DoctorCommandSummary = {
  command: string;
  status: "pass" | "warn" | "fail" | "unavailable";
  exitCode: number | null;
  summary: {
    passed: number;
    warnings: number;
    failures: number;
  } | null;
  projectState: string | null;
  error: string | null;
};

export type OnboardingStage =
  | "install_p2a"
  | "import_plan"
  | "continue_planning"
  | "iteration_init_required"
  | "repair_validate"
  | "execution_ready"
  | "cycle_close_ready";

export type OnboardingAction = {
  id:
    | "install_p2a"
    | "import_plan"
    | "init_iteration"
    | "close_iteration"
    | "open_iteration"
    | "add_maintenance"
    | "validate_artifacts"
    | "inspect_tasks"
    | "open_terminal";
  label: string;
  description: string;
  command: string | null;
  cwd: string;
  targetPath: string;
  impact: "writes_project" | "reads_project" | "guidance_only";
};

export type OnboardingCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

export type ProjectOnboarding = {
  stage: OnboardingStage;
  title: string;
  summary: string;
  primaryAction: OnboardingAction;
  secondaryActions: OnboardingAction[];
  checks: OnboardingCheck[];
};

export type RecentProject = {
  rootPath: string;
  name: string;
  lastOpenedAt: string;
  defaultAgentTool: ExecutionAgentTool;
};

export type GuiConfigSnapshot = {
  schemaVersion: "p2a.gui_config.v1";
  configPath: string;
  locale: UiLocale;
  recentProjects: RecentProject[];
};

export type ProjectSnapshot = {
  rootPath: string;
  name: string;
  state: ProjectDetectionState;
  stateLabel: string;
  mode: "read-only";
  projectId: string | null;
  activeIteration: string | null;
  defaultAgentTool: ExecutionAgentTool;
  artifactRoot: string | null;
  checks: ProjectFileCheck[];
  artifacts: ArtifactSummary[];
  onboarding: ProjectOnboarding;
  commands: CommandGuidance[];
  doctor: DoctorCommandSummary | null;
  proposals: ProposalSummary[];
  updateReports: UpdateReportSummary[];
  diagnostics: ProjectDiagnostic[];
  generatedAt: string;
};

export type ProjectWatchEvent = {
  rootPath: string;
  relativePath: string | null;
  eventType: "rename" | "change" | "unknown";
  changedAt: string;
};

export type ArtifactFileKind = "json" | "markdown" | "text";

export type ArtifactFileReadRequest = {
  projectRoot: string;
  relativePath: string;
};

export type ArtifactFileReadResult = {
  relativePath: string;
  kind: ArtifactFileKind;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type TerminalSessionStartRequest = {
  cwd: string;
  agentTool: AgentTool;
  cols: number;
  rows: number;
  taskId?: string | null;
};

export type TerminalSessionInfo = {
  sessionId: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  agentTool: AgentTool;
  taskId: string | null;
  startedAt: string;
};

export type TerminalSessionInputRequest = {
  sessionId: string;
  data: string;
};

export type TerminalSessionResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalSessionStopRequest = {
  sessionId: string;
};

export type TerminalSessionKillRequest = {
  sessionId: string;
};

export type TerminalSessionDataEvent = {
  sessionId: string;
  data: string;
};

export type TerminalSessionExitEvent = {
  sessionId: string;
  exitCode: number;
  signal: number | null;
  exitedAt: string;
};

export type ExecutionFinishStatus = "auto" | "finished" | "failed" | "blocked";

export type ExecutionCustomVerificationCommand = {
  type: VerificationType;
  command: string;
};

export type ExecutionStartRunRequest = {
  projectRoot: string;
  artifactRoot: string;
  taskGraphPath: string | null;
  taskId: string;
  agentTool: ExecutionAgentTool;
  runId?: string | null;
};

export type ExecutionFinishRunRequest = {
  projectRoot: string;
  artifactRoot: string;
  taskGraphPath: string | null;
  runId: string;
  status: ExecutionFinishStatus;
  failureClass: FailureClass | null;
  collectGit: boolean;
  verifyTest: boolean;
  verifyLint: boolean;
  verifyTypecheck: boolean;
  customVerificationCommands: ExecutionCustomVerificationCommand[];
  changedFiles: string[];
  notes: string[];
};

export type ExecutionFollowUpCommand = {
  id: "resume" | "status" | "finish" | "review";
  label: string;
  command: string;
};

export type ExecutionCommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  followUpCommands: ExecutionFollowUpCommand[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type OperationalAction =
  | "update_preview"
  | "update_apply"
  | "eval_generate"
  | "eval_analyze"
  | "eval_digest"
  | "memory_digest"
  | "memory_history";

export type OperationalActionRequest = {
  projectRoot: string;
  artifactRoot?: string | null;
  action: OperationalAction;
};

export type OrchestrationMarkRoleRequest = {
  projectRoot: string;
  runtimePath: string;
  roleId: string;
  roleStatus: OrchestrationRoleStatus;
  summary?: string | null;
  detail?: string | null;
  verdict?: string | null;
  requiresOwnerAction?: boolean;
};

export type P2AApi = {
  app: {
    getRuntimeInfo: () => Promise<RuntimeInfo>;
    openExternal: (uri: string) => Promise<void>;
  };
  config: {
    get: () => Promise<GuiConfigSnapshot>;
    setLocale: (locale: UiLocale) => Promise<GuiConfigSnapshot>;
  };
  project: {
    openFolder: () => Promise<ProjectOpenResult>;
    load: (rootPath: string, options?: ProjectLoadOptions) => Promise<ProjectSnapshot>;
    forgetRecent: (rootPath: string) => Promise<GuiConfigSnapshot>;
    setDefaultAgentTool: (
      rootPath: string,
      agentTool: ExecutionAgentTool,
    ) => Promise<GuiConfigSnapshot>;
    onChanged: (callback: (event: ProjectWatchEvent) => void) => () => void;
  };
  artifact: {
    readFile: (request: ArtifactFileReadRequest) => Promise<ArtifactFileReadResult>;
  };
  terminal: {
    start: (request: TerminalSessionStartRequest) => Promise<TerminalSessionInfo>;
    input: (request: TerminalSessionInputRequest) => Promise<void>;
    resize: (request: TerminalSessionResizeRequest) => Promise<void>;
    stop: (request: TerminalSessionStopRequest) => Promise<void>;
    kill: (request: TerminalSessionKillRequest) => Promise<void>;
    onData: (callback: (event: TerminalSessionDataEvent) => void) => () => void;
    onExit: (callback: (event: TerminalSessionExitEvent) => void) => () => void;
  };
  execution: {
    startRun: (request: ExecutionStartRunRequest) => Promise<ExecutionCommandResult>;
    finishRun: (request: ExecutionFinishRunRequest) => Promise<ExecutionCommandResult>;
  };
  operational: {
    runAction: (request: OperationalActionRequest) => Promise<ExecutionCommandResult>;
  };
  orchestration: {
    markRole: (request: OrchestrationMarkRoleRequest) => Promise<ExecutionCommandResult>;
  };
};
