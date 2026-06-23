import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import intakeSchema from "../../../../schemas/intake.schema.json";
import reviewSchema from "../../../../schemas/review.schema.json";
import runIndexSchema from "../../../../schemas/run-index.schema.json";
import specSchema from "../../../../schemas/spec.schema.json";
import taskGraphSchema from "../../../../schemas/task-graph.schema.json";
import { DEFAULT_AGENT_TOOL } from "../shared/ipc";
import type {
  AgentTool,
  ArtifactSummary,
  CommandGuidance,
  FailureClass,
  FailureRetryability,
  FailureSource,
  GateSummary,
  OnboardingAction,
  OnboardingCheck,
  ProjectDetectionState,
  ProjectDiagnostic,
  ProjectFileCheck,
  ProjectOnboarding,
  ProjectSnapshot,
  RunStatus,
  SchemaValidationSummary,
  TaskCounts,
  TaskStatus,
  VerificationStatus,
  VerificationType,
  WorkbenchRunFailure,
  WorkbenchRunVerification,
  WorkbenchRun,
  WorkbenchTask,
} from "../shared/ipc";

type JsonRecord = Record<string, unknown>;
type TaskRunSummary = {
  runIds: string[];
  latestRunId: string | null;
};

const EMPTY_TASK_COUNTS: TaskCounts = {
  total: 0,
  ready: 0,
  todo: 0,
  inProgress: 0,
  blocked: 0,
  done: 0,
};

const GATE_FILES = [
  ["A", "Intake", "gate-a-intake/intake.json"],
  ["B", "Spec", "gate-b-spec/spec.json"],
  ["C", "Task graph", "gate-c-task-graph/task-graph.json"],
  ["D", "Review", "gate-d-review/review.json"],
] as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaValidators = {
  intake: ajv.compile(intakeSchema),
  spec: ajv.compile(specSchema),
  "task-graph": ajv.compile(taskGraphSchema),
  review: ajv.compile(reviewSchema),
  "run-index": ajv.compile(runIndexSchema),
} satisfies Record<SchemaValidationSummary["id"], ValidateFunction>;

function normalizeRelative(rootPath: string, targetPath: string): string {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath.length ? relativePath.split(path.sep).join("/") : ".";
}

async function pathKind(targetPath: string): Promise<"file" | "directory" | null> {
  try {
    const targetStat = await stat(targetPath);
    if (targetStat.isFile()) return "file";
    if (targetStat.isDirectory()) return "directory";
    return null;
  } catch {
    return null;
  }
}

async function existsAs(targetPath: string, kind: "file" | "directory"): Promise<boolean> {
  return (await pathKind(targetPath)) === kind;
}

async function readJson(targetPath: string): Promise<JsonRecord | null> {
  const raw = await readFile(targetPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "blocked" || value === "in_progress" || value === "done";
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === "started" || value === "finished" || value === "failed" || value === "blocked";
}

function isVerificationType(value: unknown): value is VerificationType {
  return value === "test" || value === "lint" || value === "typecheck" || value === "custom";
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return value === "passed" || value === "failed" || value === "skipped" || value === "not_run";
}

function isFailureClass(value: unknown): value is FailureClass {
  return (
    value === "verification_failed" ||
    value === "test_flake" ||
    value === "scope_violation" ||
    value === "missing_dependency" ||
    value === "environment_failure" ||
    value === "implementation_incomplete" ||
    value === "other"
  );
}

function isFailureRetryability(value: unknown): value is FailureRetryability {
  return value === "yes" || value === "no" || value === "after_fix";
}

function isFailureSource(value: unknown): value is FailureSource {
  return value === "owner" || value === "monitor" || value === "implementer";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatAjvErrors(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).slice(0, 5).map((error) => {
    const location = error.instancePath || "/";
    return `${location} ${error.message ?? "is invalid"}`;
  });
}

function missingValidation(id: SchemaValidationSummary["id"], label: string): SchemaValidationSummary {
  return {
    id,
    label,
    relativePath: null,
    status: "missing",
    errors: [],
  };
}

async function validateJsonFile({
  id,
  label,
  rootPath,
  filePath,
}: {
  id: SchemaValidationSummary["id"];
  label: string;
  rootPath: string;
  filePath: string | null;
}): Promise<{ data: JsonRecord | null; validation: SchemaValidationSummary }> {
  if (!filePath) {
    return { data: null, validation: missingValidation(id, label) };
  }

  try {
    const data = await readJson(filePath);
    const validator = schemaValidators[id];
    const isValid = data ? validator(data) : false;
    return {
      data,
      validation: {
        id,
        label,
        relativePath: normalizeRelative(rootPath, filePath),
        status: isValid ? "valid" : "invalid",
        errors: isValid ? [] : formatAjvErrors(validator),
      },
    };
  } catch (error) {
    return {
      data: null,
      validation: {
        id,
        label,
        relativePath: normalizeRelative(rootPath, filePath),
        status: "invalid",
        errors: [(error as Error).message],
      },
    };
  }
}

function diagnosticsFromValidation(validation: SchemaValidationSummary): ProjectDiagnostic[] {
  if (validation.status !== "invalid") return [];
  const errorText = validation.errors[0] ? `: ${validation.errors[0]}` : "";
  return [
    {
      severity: "error",
      message: `${validation.label} schema invalid${errorText}`,
    },
  ];
}

function stateLabel(state: ProjectDetectionState): string {
  if (state === "execution_ready") return "Execution ready";
  if (state === "planning_in_progress") return "Planning in progress";
  if (state === "installed_empty") return "Installed empty";
  if (state === "broken_install") return "Broken install";
  return "No P2A";
}

function countTasks(tasks: WorkbenchTask[]): TaskCounts {
  const doneTaskIds = new Set(
    tasks
      .filter((task) => task.status === "done")
      .map((task) => task.id),
  );

  return tasks.reduce<TaskCounts>((counts, task) => {
    const isReady =
      task.status === "todo" && task.dependencies.every((dependency) => doneTaskIds.has(dependency));

    return {
      total: counts.total + 1,
      ready: counts.ready + (isReady ? 1 : 0),
      todo: counts.todo + (task.status === "todo" ? 1 : 0),
      inProgress: counts.inProgress + (task.status === "in_progress" ? 1 : 0),
      blocked: counts.blocked + (task.status === "blocked" ? 1 : 0),
      done: counts.done + (task.status === "done" ? 1 : 0),
    };
  }, EMPTY_TASK_COUNTS);
}

function normalizeTask(
  task: JsonRecord,
  doneTaskIds: Set<string>,
  runSummary: TaskRunSummary | undefined,
): WorkbenchTask | null {
  const id = stringValue(task.id);
  const title = stringValue(task.title);
  const description = stringValue(task.description);
  const status = isTaskStatus(task.status) ? task.status : null;
  const targetArea = stringValue(task.targetArea);
  const suggestedAgentPrompt = stringValue(task.suggestedAgentPrompt);

  if (!id || !title || !description || !status || !targetArea || !suggestedAgentPrompt) {
    return null;
  }

  const dependencies = stringArrayValue(task.dependencies);
  const ready =
    status === "todo" && dependencies.every((dependency) => doneTaskIds.has(dependency));

  return {
    id,
    title,
    description,
    status,
    dependencies,
    acceptanceCriteria: stringArrayValue(task.acceptanceCriteria),
    targetArea,
    suggestedAgentPrompt,
    sourceSpecRefs: stringArrayValue(task.sourceSpecRefs),
    blockReason: stringValue(task.blockReason),
    ready,
    runIds: runSummary?.runIds ?? [],
    latestRunId: runSummary?.latestRunId ?? null,
  };
}

function normalizeTasks(taskGraph: JsonRecord | null, taskRuns: Record<string, TaskRunSummary>): WorkbenchTask[] {
  const rawTasks = Array.isArray(taskGraph?.tasks)
    ? taskGraph.tasks.filter((task): task is JsonRecord => {
        return Boolean(task && typeof task === "object" && !Array.isArray(task));
      })
    : [];
  const doneTaskIds = new Set(
    rawTasks
      .filter((task) => task.status === "done")
      .map((task) => stringValue(task.id))
      .filter((taskId): taskId is string => taskId !== null),
  );

  return rawTasks
    .map((task) => normalizeTask(task, doneTaskIds, taskRuns[stringValue(task.id) ?? ""]))
    .filter((task): task is WorkbenchTask => task !== null);
}

function normalizeVerification(runDetail: JsonRecord | null): WorkbenchRunVerification[] {
  const rawVerification = Array.isArray(runDetail?.verification)
    ? runDetail.verification.filter((item): item is JsonRecord => {
        return Boolean(item && typeof item === "object" && !Array.isArray(item));
      })
    : [];

  return rawVerification
    .map((item): WorkbenchRunVerification | null => {
      const type = isVerificationType(item.type) ? item.type : null;
      const status = isVerificationStatus(item.status) ? item.status : null;
      const command = stringValue(item.command);
      const source =
        item.source === "config" || item.source === "command" || item.source === "manual"
          ? item.source
          : null;
      if (!type || !status || !command || !source) return null;

      return {
        type,
        command,
        status,
        exitCode: numberValue(item.exitCode),
        durationMs: numberValue(item.durationMs),
        startedAt: stringValue(item.startedAt),
        finishedAt: stringValue(item.finishedAt),
        stdoutTail: stringValue(item.stdoutTail),
        stderrTail: stringValue(item.stderrTail),
        source,
      };
    })
    .filter((item): item is WorkbenchRunVerification => item !== null);
}

function normalizeFailure(runDetail: JsonRecord | null): WorkbenchRunFailure | null {
  const failure = runDetail?.failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const record = failure as JsonRecord;
  const failureClass = isFailureClass(record.class) ? record.class : null;
  const retryable = isFailureRetryability(record.retryable) ? record.retryable : null;
  const source = isFailureSource(record.source) ? record.source : null;
  const needsUserDecision =
    typeof record.needsUserDecision === "boolean" ? record.needsUserDecision : null;
  if (!failureClass || !retryable || !source || needsUserDecision === null) return null;

  return {
    class: failureClass,
    retryable,
    needsUserDecision,
    source,
  };
}

async function readRunDetail(runsDir: string, runId: string): Promise<JsonRecord | null> {
  const runPath = path.join(runsDir, `${runId}.json`);
  if (!(await existsAs(runPath, "file"))) return null;
  try {
    return await readJson(runPath);
  } catch {
    return null;
  }
}

async function normalizeRuns(runIndex: JsonRecord | null, runsDir: string): Promise<WorkbenchRun[]> {
  const rawRuns = Array.isArray(runIndex?.runs)
    ? runIndex.runs.filter((run): run is JsonRecord => {
        return Boolean(run && typeof run === "object" && !Array.isArray(run));
      })
    : [];

  const runs = await Promise.all(
    rawRuns.map(async (run): Promise<WorkbenchRun | null> => {
      const runId = stringValue(run.runId);
      const taskId = stringValue(run.taskId);
      const status = isRunStatus(run.status) ? run.status : null;
      const agentTool = stringValue(run.agentTool);
      const workspaceRef = stringValue(run.workspaceRef);
      const taskGraphRef = stringValue(run.taskGraphRef);
      const runRef = stringValue(run.runRef);
      const startedAt = stringValue(run.startedAt);

      if (
        !runId ||
        !taskId ||
        !status ||
        !agentTool ||
        !workspaceRef ||
        !taskGraphRef ||
        !runRef ||
        !startedAt
      ) {
        return null;
      }
      const runDetail = await readRunDetail(runsDir, runId);

      return {
        runId,
        taskId,
        iterationId: stringValue(run.iterationId),
        status,
        agentTool,
        workspaceRef,
        taskGraphRef,
        runRef,
        startedAt,
        finishedAt: stringValue(run.finishedAt),
        changedFiles: stringArrayValue(runDetail?.changedFiles),
        verification: normalizeVerification(runDetail),
        notes: stringArrayValue(runDetail?.notes),
        failure: normalizeFailure(runDetail),
      };
    }),
  );

  return runs.filter((run): run is WorkbenchRun => run !== null);
}

function normalizeTaskRuns(runIndex: JsonRecord | null): Record<string, TaskRunSummary> {
  const rawTaskRuns = Array.isArray(runIndex?.tasks)
    ? runIndex.tasks.filter((taskRun): taskRun is JsonRecord => {
        return Boolean(taskRun && typeof taskRun === "object" && !Array.isArray(taskRun));
      })
    : [];
  const taskRuns: Record<string, TaskRunSummary> = {};

  for (const taskRun of rawTaskRuns) {
    const taskId = stringValue(taskRun.taskId);
    if (!taskId) continue;
    taskRuns[taskId] = {
      runIds: stringArrayValue(taskRun.runIds),
      latestRunId: stringValue(taskRun.latestRunId),
    };
  }

  return taskRuns;
}

async function listDirectoryNames(targetPath: string): Promise<string[]> {
  try {
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await existsAs(candidate, "file")) return candidate;
  }
  return null;
}

async function firstExistingDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await existsAs(candidate, "directory")) return candidate;
  }
  return null;
}

async function looksLikeArtifactRoot(candidateRoot: string): Promise<boolean> {
  const markers = [
    "status.md",
    "current-spec.json",
    "gate-a-intake/intake.json",
    "gate-b-spec/spec.json",
    "gate-c-task-graph/task-graph.json",
    "task-graph.json",
    "gate-d-review/review.json",
  ];

  for (const marker of markers) {
    if (await existsAs(path.join(candidateRoot, marker), "file")) return true;
  }
  return false;
}

async function discoverArtifactRoots(rootPath: string): Promise<string[]> {
  const artifactRoots = new Set<string>();
  if (await looksLikeArtifactRoot(rootPath)) {
    artifactRoots.add(rootPath);
  }

  const artifactParents = [
    path.join(rootPath, "artifacts"),
    path.join(rootPath, ".plan2agent", "artifacts"),
  ];

  for (const parentPath of artifactParents) {
    const projectNames = await listDirectoryNames(parentPath);
    for (const projectName of projectNames) {
      const candidateRoot = path.join(parentPath, projectName);
      if (await looksLikeArtifactRoot(candidateRoot)) {
        artifactRoots.add(candidateRoot);
      }
    }
  }

  return [...artifactRoots].sort((left, right) => left.localeCompare(right));
}

async function summarizeGates(artifactRoot: string, iterationRoot: string | null): Promise<GateSummary[]> {
  const searchRoots = iterationRoot ? [iterationRoot, artifactRoot] : [artifactRoot];
  const gates: GateSummary[] = [];

  for (const [id, label, relativePath] of GATE_FILES) {
    const gatePath = await firstExistingFile(
      searchRoots.map((searchRoot) => path.join(searchRoot, relativePath)),
    );
    gates.push({
      id,
      label,
      state: gatePath ? "present" : "missing",
      relativePath,
    });
  }

  return gates;
}

async function summarizeRuns(artifactRoot: string): Promise<{
  runIndexPath: string | null;
  runCount: number;
  runs: WorkbenchRun[];
  taskRuns: Record<string, TaskRunSummary>;
  validation: SchemaValidationSummary;
  diagnostics: ProjectDiagnostic[];
}> {
  const diagnostics: ProjectDiagnostic[] = [];
  const runsDir = await firstExistingDirectory([
    path.join(artifactRoot, "runs"),
    path.join(path.dirname(artifactRoot), "runs"),
  ]);
  if (!runsDir) {
    return {
      runIndexPath: null,
      runCount: 0,
      runs: [],
      taskRuns: {},
      validation: missingValidation("run-index", "Run index"),
      diagnostics,
    };
  }

  const runIndexPath = path.join(runsDir, "run-index.json");
  if (!(await existsAs(runIndexPath, "file"))) {
    return {
      runIndexPath: null,
      runCount: 0,
      runs: [],
      taskRuns: {},
      validation: missingValidation("run-index", "Run index"),
      diagnostics,
    };
  }

  const { data: runIndex, validation } = await validateJsonFile({
    id: "run-index",
    label: "Run index",
    rootPath: artifactRoot,
    filePath: runIndexPath,
  });
  const runs = await normalizeRuns(runIndex, runsDir);
  return {
    runIndexPath,
    runCount: runs.length,
    runs,
    taskRuns: normalizeTaskRuns(runIndex),
    validation,
    diagnostics,
  };
}

async function summarizeArtifact(rootPath: string, artifactRoot: string): Promise<ArtifactSummary> {
  const diagnostics: ProjectDiagnostic[] = [];
  let projectId = path.basename(artifactRoot);
  let activeIteration: string | null = null;

  const statusPath = (await existsAs(path.join(artifactRoot, "status.md"), "file"))
    ? path.join(artifactRoot, "status.md")
    : null;
  const currentSpecPath = (await existsAs(path.join(artifactRoot, "current-spec.json"), "file"))
    ? path.join(artifactRoot, "current-spec.json")
    : null;

  if (currentSpecPath) {
    try {
      const currentSpec = await readJson(currentSpecPath);
      projectId = stringValue(currentSpec?.project_id) ?? projectId;
      activeIteration = stringValue(currentSpec?.active_iteration);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        message: `current-spec.json read failed: ${(error as Error).message}`,
      });
    }
  }

  const iterationRoot = activeIteration
    ? path.join(artifactRoot, "iterations", activeIteration)
    : null;
  const searchRoots = iterationRoot ? [iterationRoot, artifactRoot] : [artifactRoot];
  const intakePath = await firstExistingFile(
    searchRoots.map((searchRoot) => path.join(searchRoot, "gate-a-intake", "intake.json")),
  );
  const specPath = await firstExistingFile(
    searchRoots.map((searchRoot) => path.join(searchRoot, "gate-b-spec", "spec.json")),
  );
  const taskGraphPath = await firstExistingFile(
    searchRoots.flatMap((searchRoot) => [
      path.join(searchRoot, "gate-c-task-graph", "task-graph.json"),
      path.join(searchRoot, "task-graph.json"),
    ]),
  );
  const reviewPath = await firstExistingFile(
    searchRoots.map((searchRoot) => path.join(searchRoot, "gate-d-review", "review.json")),
  );
  const gates = await summarizeGates(artifactRoot, iterationRoot);
  const runSummary = await summarizeRuns(artifactRoot);
  const validations: SchemaValidationSummary[] = [];

  const intakeValidation = await validateJsonFile({
    id: "intake",
    label: "Intake",
    rootPath,
    filePath: intakePath,
  });
  const specValidation = await validateJsonFile({
    id: "spec",
    label: "Spec",
    rootPath,
    filePath: specPath,
  });
  const taskGraphValidation = await validateJsonFile({
    id: "task-graph",
    label: "Task graph",
    rootPath,
    filePath: taskGraphPath,
  });
  const reviewValidation = await validateJsonFile({
    id: "review",
    label: "Review",
    rootPath,
    filePath: reviewPath,
  });
  validations.push(
    intakeValidation.validation,
    specValidation.validation,
    taskGraphValidation.validation,
    reviewValidation.validation,
    {
      ...runSummary.validation,
      relativePath: runSummary.validation.relativePath
        ? normalizeRelative(rootPath, path.join(artifactRoot, runSummary.validation.relativePath))
        : null,
    },
  );
  diagnostics.push(
    ...validations.flatMap((validation) => diagnosticsFromValidation(validation)),
  );

  let taskCounts = EMPTY_TASK_COUNTS;
  let tasks: WorkbenchTask[] = [];
  const taskGraph = taskGraphValidation.data;
  if (taskGraph) {
    projectId = stringValue(taskGraph.projectId) ?? projectId;
    tasks = normalizeTasks(taskGraph, runSummary.taskRuns);
    taskCounts = countTasks(tasks);
  }

  diagnostics.push(...runSummary.diagnostics);

  return {
    projectId,
    rootPath: artifactRoot,
    relativePath: normalizeRelative(rootPath, artifactRoot),
    activeIteration,
    taskGraphVersion: stringValue(taskGraph?.version),
    sourceSpec: stringValue(taskGraph?.sourceSpec),
    statusPath: statusPath ? normalizeRelative(rootPath, statusPath) : null,
    taskGraphPath: taskGraphPath ? normalizeRelative(rootPath, taskGraphPath) : null,
    reviewPath: reviewPath ? normalizeRelative(rootPath, reviewPath) : null,
    runIndexPath: runSummary.runIndexPath ? normalizeRelative(rootPath, runSummary.runIndexPath) : null,
    gates,
    validations,
    taskCounts,
    tasks,
    runCount: runSummary.runCount,
    runs: runSummary.runs,
    diagnostics,
  };
}

async function buildFileChecks(rootPath: string): Promise<ProjectFileCheck[]> {
  const checks = [
    ["p2a-dir", ".plan2agent", ".plan2agent", "directory"],
    ["manifest", "manifest", ".plan2agent/manifest.json", "file"],
    ["project-config", "project config", ".plan2agent/project.config.json", "file"],
    ["plan-doc", "PLAN2AGENT.md", "PLAN2AGENT.md", "file"],
    ["scripts", "scripts", "scripts", "directory"],
    ["schemas", "schemas", "schemas", "directory"],
    ["artifacts", "artifacts", "artifacts", "directory"],
    ["runs", "runs", ".plan2agent/runs", "directory"],
  ] as const;

  return Promise.all(
    checks.map(async ([id, label, relativePath, kind]) => ({
      id,
      label,
      relativePath,
      kind,
      exists: await existsAs(path.join(rootPath, relativePath), kind),
    })),
  );
}

function determineState(checks: ProjectFileCheck[], artifacts: ArtifactSummary[]): ProjectDetectionState {
  const hasInstallMarker = checks.some((check) => check.exists && check.id !== "artifacts");
  const hasErrors = artifacts.some((artifact) =>
    artifact.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  );
  if (hasErrors) return "broken_install";
  if (artifacts.some((artifact) => artifact.taskCounts.ready > 0 || artifact.runCount > 0)) {
    return "execution_ready";
  }
  if (artifacts.length > 0) return "planning_in_progress";
  if (hasInstallMarker) return "installed_empty";
  return "no_p2a";
}

function buildDiagnostics(
  state: ProjectDetectionState,
  checks: ProjectFileCheck[],
  artifacts: ArtifactSummary[],
): ProjectDiagnostic[] {
  const diagnostics = artifacts.flatMap((artifact) => artifact.diagnostics);
  const hasPlan2AgentDir = checks.some((check) => check.id === "p2a-dir" && check.exists);
  const hasManifest = checks.some((check) => check.id === "manifest" && check.exists);

  if (state === "no_p2a") {
    diagnostics.push({
      severity: "warn",
      message: "No P2A harness or artifact root was found in the selected folder.",
    });
  }
  if (hasPlan2AgentDir && !hasManifest) {
    diagnostics.push({
      severity: "warn",
      message: ".plan2agent exists but manifest.json is missing.",
    });
  }
  if (state === "execution_ready") {
    diagnostics.push({
      severity: "ok",
      message: "At least one ready task or run record was found.",
    });
  }
  if (state === "installed_empty") {
    diagnostics.push({
      severity: "ok",
      message: "P2A markers exist, but no planning artifacts were found yet.",
    });
  }

  return diagnostics;
}

function buildCommands(rootPath: string, state: ProjectDetectionState, artifacts: ArtifactSummary[]): CommandGuidance[] {
  const commands: CommandGuidance[] = [];
  const primaryArtifact = artifacts[0];

  if (state === "no_p2a") {
    commands.push({
      id: "setup",
      label: "Setup guidance",
      command: `node scripts/p2a_handoff.mjs scaffold --target ${shellQuote(rootPath)} --tools all`,
      description: "Install P2A harness files from an external terminal.",
    });
  }

  if (state === "installed_empty" || state === "planning_in_progress") {
    commands.push({
      id: "import",
      label: "Import guidance",
      command: `node scripts/p2a_handoff.mjs --project-id <project-id> --artifacts <artifact-root> --target ${shellQuote(rootPath)} --tools all`,
      description: "Import an existing planning artifact bundle from an external terminal.",
    });
  }

  if (primaryArtifact || state === "broken_install") {
    commands.push({
      id: "validate",
      label: "Validate guidance",
      command: `node scripts/validate_artifacts.mjs --artifacts ${shellQuote(primaryArtifact?.rootPath ?? rootPath)}`,
      description: "Validate existing planning artifacts without modifying project files.",
    });
  }

  return commands;
}

function setupCommand(rootPath: string): string {
  return `node scripts/p2a_handoff.mjs scaffold --target ${shellQuote(rootPath)} --tools all`;
}

function importCommand(rootPath: string): string {
  return `node scripts/p2a_handoff.mjs --project-id <project-id> --artifacts <artifact-root> --target ${shellQuote(rootPath)} --tools all`;
}

function validateCommand(rootPath: string, artifacts: ArtifactSummary[]): string {
  return `node scripts/validate_artifacts.mjs --artifacts ${shellQuote(artifacts[0]?.rootPath ?? rootPath)}`;
}

function installAction(rootPath: string): OnboardingAction {
  return {
    id: "install_p2a",
    label: "Install P2A",
    description: "Install harness files from an external terminal.",
    command: setupCommand(rootPath),
    cwd: rootPath,
    targetPath: rootPath,
    impact: "writes_project",
  };
}

function importAction(rootPath: string): OnboardingAction {
  return {
    id: "import_plan",
    label: "Import Plan",
    description: "Import an approved planning artifact bundle into this workspace.",
    command: importCommand(rootPath),
    cwd: rootPath,
    targetPath: rootPath,
    impact: "writes_project",
  };
}

function validateAction(rootPath: string, artifacts: ArtifactSummary[]): OnboardingAction {
  const primaryArtifact = artifacts[0];
  return {
    id: "validate_artifacts",
    label: "Validate artifacts",
    description: "Validate planning artifacts without changing project files.",
    command: validateCommand(rootPath, artifacts),
    cwd: rootPath,
    targetPath: primaryArtifact?.rootPath ?? rootPath,
    impact: "reads_project",
  };
}

function inspectTasksAction(rootPath: string, artifacts: ArtifactSummary[]): OnboardingAction {
  return {
    id: "inspect_tasks",
    label: "Review tasks",
    description: "Inspect ready tasks and run history in this read-only workbench.",
    command: null,
    cwd: rootPath,
    targetPath: artifacts[0]?.rootPath ?? rootPath,
    impact: "guidance_only",
  };
}

function openTerminalAction(rootPath: string, artifacts: ArtifactSummary[]): OnboardingAction {
  return {
    id: "open_terminal",
    label: "Open Terminal tab",
    description: "Use Terminal guidance when a task is ready for an agent session.",
    command: null,
    cwd: rootPath,
    targetPath: artifacts[0]?.rootPath ?? rootPath,
    impact: "guidance_only",
  };
}

function buildOnboardingChecks(
  state: ProjectDetectionState,
  checks: ProjectFileCheck[],
  artifacts: ArtifactSummary[],
): OnboardingCheck[] {
  const hasManifest = checks.some((check) => check.id === "manifest" && check.exists);
  const hasArtifactRoot = artifacts.length > 0;
  const hasInvalidSchema = artifacts.some((artifact) =>
    artifact.validations.some((validation) => validation.status === "invalid"),
  );
  const hasReadyTask = artifacts.some((artifact) => artifact.taskCounts.ready > 0);
  const hasRunHistory = artifacts.some((artifact) => artifact.runCount > 0);

  return [
    {
      id: "manifest",
      label: "Harness manifest",
      status: hasManifest ? "ok" : state === "no_p2a" ? "warn" : "error",
      detail: hasManifest ? ".plan2agent/manifest.json present" : "manifest missing",
    },
    {
      id: "artifacts",
      label: "Planning artifacts",
      status: hasArtifactRoot ? "ok" : "warn",
      detail: hasArtifactRoot ? `${artifacts.length} artifact root detected` : "no artifact root detected",
    },
    {
      id: "schema",
      label: "Schema validation",
      status: hasInvalidSchema ? "error" : hasArtifactRoot ? "ok" : "warn",
      detail: hasInvalidSchema ? "schema errors detected" : hasArtifactRoot ? "loaded schemas are valid or missing" : "no schema files loaded",
    },
    {
      id: "ready-task",
      label: "Execution readiness",
      status: hasReadyTask || hasRunHistory ? "ok" : state === "execution_ready" ? "ok" : "warn",
      detail: hasReadyTask
        ? "ready task available"
        : hasRunHistory
          ? "run history available"
          : "no ready task detected",
    },
  ];
}

function buildOnboarding(
  rootPath: string,
  state: ProjectDetectionState,
  checks: ProjectFileCheck[],
  artifacts: ArtifactSummary[],
): ProjectOnboarding {
  const checksForUi = buildOnboardingChecks(state, checks, artifacts);

  if (state === "no_p2a") {
    return {
      stage: "install_p2a",
      title: "Install P2A",
      summary: "No harness markers or planning artifacts were found.",
      primaryAction: installAction(rootPath),
      secondaryActions: [],
      checks: checksForUi,
    };
  }

  if (state === "installed_empty") {
    return {
      stage: "import_plan",
      title: "Import Plan",
      summary: "Harness markers exist, but no planning artifact root was found.",
      primaryAction: importAction(rootPath),
      secondaryActions: [],
      checks: checksForUi,
    };
  }

  if (state === "broken_install") {
    return {
      stage: "repair_validate",
      title: "Repair / Validate",
      summary: "P2A files were found, but one or more artifact checks failed.",
      primaryAction: validateAction(rootPath, artifacts),
      secondaryActions: [importAction(rootPath)],
      checks: checksForUi,
    };
  }

  if (state === "planning_in_progress") {
    return {
      stage: "continue_planning",
      title: "Continue planning",
      summary: "Planning artifacts exist, but no ready task or run history is available yet.",
      primaryAction: validateAction(rootPath, artifacts),
      secondaryActions: [importAction(rootPath)],
      checks: checksForUi,
    };
  }

  return {
    stage: "execution_ready",
    title: "Execution ready",
    summary: "A ready task or run record is available in the selected artifact root.",
    primaryAction: inspectTasksAction(rootPath, artifacts),
    secondaryActions: [openTerminalAction(rootPath, artifacts), validateAction(rootPath, artifacts)],
    checks: checksForUi,
  };
}

export async function loadProjectSnapshot(
  rootPath: string,
  options: { defaultAgentTool?: AgentTool } = {},
): Promise<ProjectSnapshot> {
  const normalizedRootPath = path.resolve(rootPath);
  const checks = await buildFileChecks(normalizedRootPath);
  const artifactRoots = await discoverArtifactRoots(normalizedRootPath);
  const artifacts = await Promise.all(
    artifactRoots.map((artifactRoot) => summarizeArtifact(normalizedRootPath, artifactRoot)),
  );
  const state = determineState(checks, artifacts);
  const primaryArtifact = artifacts[0] ?? null;
  const diagnostics = buildDiagnostics(state, checks, artifacts);

  return {
    rootPath: normalizedRootPath,
    name: path.basename(normalizedRootPath),
    state,
    stateLabel: stateLabel(state),
    mode: "read-only",
    projectId: primaryArtifact?.projectId ?? null,
    activeIteration: primaryArtifact?.activeIteration ?? null,
    defaultAgentTool: options.defaultAgentTool ?? DEFAULT_AGENT_TOOL,
    artifactRoot: primaryArtifact?.rootPath ?? null,
    checks,
    artifacts,
    onboarding: buildOnboarding(normalizedRootPath, state, checks, artifacts),
    commands: buildCommands(normalizedRootPath, state, artifacts),
    diagnostics,
    generatedAt: new Date().toISOString(),
  };
}
