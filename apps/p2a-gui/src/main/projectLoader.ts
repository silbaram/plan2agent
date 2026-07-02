import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import intakeSchema from "../../../../schemas/intake.schema.json";
import reviewSchema from "../../../../schemas/review.schema.json";
import runIndexSchema from "../../../../schemas/run-index.schema.json";
import specSchema from "../../../../schemas/spec.schema.json";
import taskGraphSchema from "../../../../schemas/task-graph.schema.json";
import { readScaffoldArtifactLayout } from "./artifactLayout";
import { DEFAULT_EXECUTION_AGENT_TOOL } from "../shared/ipc";
import type {
  ArtifactSummary,
  CommandGuidance,
  ExecutionAgentTool,
  FailureClass,
  FailureRetryability,
  FailureSource,
  GateSummary,
  OnboardingAction,
  OnboardingCheck,
  OrchestrationMode,
  OrchestrationRoleStatus,
  OrchestrationRuntimePhase,
  ProposalRisk,
  ProposalStatus,
  ProposalSummary,
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
  WorkbenchOrchestrationExecutionGuide,
  WorkbenchOrchestrationEvent,
  WorkbenchOrchestrationNextRole,
  WorkbenchOrchestrationRole,
  WorkbenchOrchestrationSchedulerHint,
  WorkbenchRunFailure,
  WorkbenchRunOrchestration,
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
let cachedToolkitHandoffScript: string | null = null;

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

function isProposalStatus(value: unknown): value is ProposalStatus {
  return value === "proposed" || value === "approved" || value === "rejected" || value === "deferred";
}

function isProposalRisk(value: unknown): value is ProposalRisk {
  return value === "low" || value === "medium" || value === "high";
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

function isOrchestrationMode(value: unknown): value is OrchestrationMode {
  return value === "solo" || value === "solo_monitor" || value === "team";
}

function isOrchestrationRuntimePhase(value: unknown): value is OrchestrationRuntimePhase {
  return (
    value === "initialized" ||
    value === "running" ||
    value === "blocked" ||
    value === "ready_for_monitor" ||
    value === "ready_to_finish" ||
    value === "closed"
  );
}

function isOrchestrationRoleStatus(value: unknown): value is OrchestrationRoleStatus {
  return (
    value === "pending" ||
    value === "active" ||
    value === "blocked" ||
    value === "complete" ||
    value === "skipped"
  );
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function recordArrayValue(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => {
        return Boolean(item && typeof item === "object" && !Array.isArray(item));
      })
    : [];
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findToolkitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  if (!existsSync(current)) current = path.dirname(current);
  while (true) {
    const handoffScript = path.join(current, "scripts", "p2a_handoff.mjs");
    const manifestScript = path.join(current, "scripts", "p2a_tool_manifest.mjs");
    if (existsSync(handoffScript) && existsSync(manifestScript)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function currentModuleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function toolkitHandoffScript(): string {
  if (cachedToolkitHandoffScript) return cachedToolkitHandoffScript;
  const candidates = [
    process.env.P2A_TOOLKIT_ROOT,
    process.cwd(),
    currentModuleDir(),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of candidates) {
    const root = findToolkitRoot(candidate);
    if (root) {
      cachedToolkitHandoffScript = path.join(root, "scripts", "p2a_handoff.mjs");
      return cachedToolkitHandoffScript;
    }
  }

  cachedToolkitHandoffScript = path.join(process.cwd(), "scripts", "p2a_handoff.mjs");
  return cachedToolkitHandoffScript;
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
  if (state === "cycle_close_ready") return "Cycle close-ready";
  if (state === "execution_ready") return "Execution ready";
  if (state === "iteration_init_required") return "Iteration init required";
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

function artifactIsCycleCloseReady(artifact: ArtifactSummary): boolean {
  return Boolean(
    artifact.activeIteration &&
      artifact.taskCounts.total > 0 &&
      artifact.taskCounts.done === artifact.taskCounts.total &&
      artifact.taskCounts.todo === 0 &&
      artifact.taskCounts.inProgress === 0 &&
      artifact.taskCounts.blocked === 0,
  );
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

async function readOptionalJson(targetPath: string): Promise<JsonRecord | null> {
  if (!(await existsAs(targetPath, "file"))) return null;
  try {
    return await readJson(targetPath);
  } catch {
    return null;
  }
}

function normalizeOrchestrationEvent(event: JsonRecord): WorkbenchOrchestrationEvent | null {
  const eventId = stringValue(event.eventId);
  const createdAt = stringValue(event.createdAt);
  const roleId = stringValue(event.roleId);
  const type = stringValue(event.type);
  const summary = stringValue(event.summary);
  if (!eventId || !createdAt || !roleId || !type || !summary) return null;

  return {
    eventId,
    createdAt,
    roleId,
    type,
    summary,
    requiresOwnerAction: booleanValue(event.requiresOwnerAction) ?? false,
  };
}

function normalizeOrchestrationEvents(runtime: JsonRecord | null): WorkbenchOrchestrationEvent[] {
  return recordArrayValue(runtime?.communicationLog)
    .map(normalizeOrchestrationEvent)
    .filter((event): event is WorkbenchOrchestrationEvent => event !== null);
}

function defaultRoleStatus(roleId: string): OrchestrationRoleStatus {
  return roleId === "owner" || roleId === "implementer" ? "active" : "pending";
}

function handoffPromptForRole(
  roleId: string,
  plan: JsonRecord | null,
  runtime: JsonRecord | null,
): string | null {
  const runtimeHandoff = recordArrayValue(runtime?.communicationLog)
    .reverse()
    .find((event) => event.type === "handoff" && event.roleId === roleId);
  const runtimePrompt = stringValue(runtimeHandoff?.detail);
  if (runtimePrompt) return runtimePrompt;

  const planHandoff = recordArrayValue(plan?.handoffPrompts).find(
    (prompt) => prompt.roleId === roleId,
  );
  return stringValue(planHandoff?.prompt);
}

function buildSupervisedRolePrompt(
  runtime: JsonRecord | null,
  role: WorkbenchOrchestrationRole,
  basePrompt: string | null,
  events: WorkbenchOrchestrationEvent[],
): string | null {
  if (!basePrompt && !role.scope) return null;
  if (!runtime) {
    return [
      "Plan2Agent supervised role prompt",
      "",
      `Role: ${role.roleId} (${role.role}, ${role.agentTool})`,
      `Profile: ${role.profile}`,
      `Profile source: ${role.profileSource}`,
      `Profile reason: ${role.profileReason}`,
      `Status: ${role.status}`,
      `Provider surface: ${role.executionGuide.surface}`,
      `Recommended feature: ${role.executionGuide.recommendedFeature}`,
      `Fallback mode: ${role.executionGuide.fallbackMode}`,
      "",
      "Supervision boundary:",
      "- A human must open the official CLI/app and paste this prompt manually.",
      "- Do not run background loops, browser automation, unofficial APIs, token reuse, or quota/rate-limit bypass.",
      "- Report results back to the owner, then record them with p2a_orchestrate mark-role or record.",
      "",
      "Role scope:",
      role.scope,
      "",
      "Role handoff prompt:",
      basePrompt ?? role.scope,
    ].join("\n");
  }

  const sharedMentalModel = recordValue(runtime.sharedMentalModel);
  const acceptanceCriteria = stringArrayValue(sharedMentalModel?.acceptanceCriteria);
  const constraints = stringArrayValue(sharedMentalModel?.constraints);
  const recentEvents = events.slice(-5);

  return [
    "Plan2Agent supervised role prompt",
    "",
    `Run: ${stringValue(runtime.runId) ?? "unknown"}`,
    `Task: ${stringValue(runtime.taskId) ?? "unknown"} - ${stringValue(runtime.taskTitle) ?? ""}`.trim(),
    `Role: ${role.roleId} (${role.role}, ${role.agentTool})`,
    `Profile: ${role.profile}`,
    `Profile source: ${role.profileSource}`,
    `Profile reason: ${role.profileReason}`,
    `Status: ${role.status}`,
    `Provider surface: ${role.executionGuide.surface}`,
    `Recommended feature: ${role.executionGuide.recommendedFeature}`,
    `Fallback mode: ${role.executionGuide.fallbackMode}`,
    "",
    "Supervision boundary:",
    "- A human must open the official CLI/app and paste this prompt manually.",
    "- Do not run background loops, browser automation, unofficial APIs, token reuse, or quota/rate-limit bypass.",
    "- Report results back to the owner, then record them with p2a_orchestrate mark-role or record.",
    "",
    `Objective: ${stringValue(sharedMentalModel?.objective) ?? stringValue(runtime.taskTitle) ?? role.roleId}`,
    `Current state: ${stringValue(sharedMentalModel?.currentState) ?? "No runtime state recorded."}`,
    "",
    "Role scope:",
    role.scope,
    "",
    "Acceptance criteria:",
    ...(acceptanceCriteria.length
      ? acceptanceCriteria.map((criterion) => `- ${criterion}`)
      : ["- none recorded"]),
    "",
    "Constraints:",
    ...(constraints.length ? constraints.map((constraint) => `- ${constraint}`) : ["- none recorded"]),
    "",
    "Recent runtime events:",
    ...(
      recentEvents.length
        ? recentEvents.map(
            (event) => `- ${event.createdAt} ${event.roleId}/${event.type}: ${event.summary}`,
          )
        : ["- none recorded"]
    ),
    "",
    "Role handoff prompt:",
    basePrompt ?? role.scope,
    "",
    "Completion report:",
    "- Summarize what was done or reviewed.",
    "- List changed files, verification commands/results, blockers, and user decisions needed.",
    "- Do not directly edit Plan2Agent run logs or task graph files.",
  ].join("\n");
}

function defaultRoleProfile(roleId: string, role: string): string {
  if (roleId === "owner" || role === "lead") return "owner_supervisor";
  if (roleId === "monitor" || role === "monitor") return "manual_monitor";
  if (role === "reviewer") return "qa_reviewer";
  return "fullstack_implementer";
}

function defaultRoleProfileReason(roleId: string, role: string): string {
  const profile = defaultRoleProfile(roleId, role);
  return `legacy orchestration artifact inferred ${profile}`;
}

function defaultExecutionGuide(
  agentTool: string,
  role: string,
  profile: string,
): WorkbenchOrchestrationExecutionGuide {
  if (agentTool === "codex") {
    return {
      surface: "Codex CLI/app foreground session",
      recommendedFeature:
        role === "contributor"
          ? "skills_custom_agents_explicit_subagent_prompt"
          : "read_only_review_skill_or_custom_agent_prompt",
      fallbackMode: "single supervised role prompt",
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        "Open Codex manually in the foreground workspace.",
        "Use skills or custom agents when they are available for this profile.",
        "Record observed state in P2A.",
      ],
    };
  }
  if (agentTool === "claude") {
    return {
      surface: "Claude Code foreground session",
      recommendedFeature: role === "contributor" ? "agent_teams_or_subagents" : "read_only_review_subagent",
      fallbackMode: "supervised foreground role prompt",
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        "Open Claude Code manually in the foreground workspace.",
        "Use agent teams or subagents when enabled.",
        "Record observed state in P2A.",
      ],
    };
  }
  if (agentTool === "gemini") {
    return {
      surface: "Gemini CLI foreground session",
      recommendedFeature: "extensions_custom_commands_gemini_context",
      fallbackMode: "read-only supervised role prompt",
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        "Use Gemini only for read-only planning, review, or monitor support.",
        "Do not edit files in this role.",
        "Record findings in P2A.",
      ],
    };
  }
  return {
    surface: "Human owner foreground action",
    recommendedFeature:
      role === "lead" ? "manual_approval_and_run_lifecycle" : "manual_prompt_copy_and_status_recording",
    fallbackMode: "manual status update",
    supervisionRequired: true,
    startsProcess: false,
    constraints: [
      "Perform the role directly in the foreground workspace.",
      "Record observed state in P2A.",
      profile === "manual_monitor" ? "Record an explicit monitor verdict before finish." : "Keep changes inside the approved task scope.",
    ],
  };
}

function normalizeExecutionGuide(
  roleRecord: JsonRecord,
  agentTool: string,
  role: string,
  profile: string,
): WorkbenchOrchestrationExecutionGuide {
  const guide = recordValue(roleRecord.executionGuide);
  if (!guide) return defaultExecutionGuide(agentTool, role, profile);
  return {
    surface: stringValue(guide.surface) ?? defaultExecutionGuide(agentTool, role, profile).surface,
    recommendedFeature:
      stringValue(guide.recommendedFeature) ??
      defaultExecutionGuide(agentTool, role, profile).recommendedFeature,
    fallbackMode: stringValue(guide.fallbackMode) ?? defaultExecutionGuide(agentTool, role, profile).fallbackMode,
    supervisionRequired: booleanValue(guide.supervisionRequired) ?? true,
    startsProcess: booleanValue(guide.startsProcess) ?? false,
    constraints: stringArrayValue(guide.constraints).length
      ? stringArrayValue(guide.constraints)
      : defaultExecutionGuide(agentTool, role, profile).constraints,
  };
}

function normalizeOrchestrationRoles(
  plan: JsonRecord | null,
  runtime: JsonRecord | null,
  events: WorkbenchOrchestrationEvent[],
): WorkbenchOrchestrationRole[] {
  const sharedMentalModel = recordValue(runtime?.sharedMentalModel);
  const runtimeRoles = recordArrayValue(sharedMentalModel?.roleAssignments);
  const planRoles = recordArrayValue(plan?.roles);
  const rawRoles = runtimeRoles.length > 0 ? runtimeRoles : planRoles;

  return rawRoles
    .map((roleRecord): WorkbenchOrchestrationRole | null => {
      const roleId = stringValue(roleRecord.roleId);
      const role = stringValue(roleRecord.role);
      const profile = stringValue(roleRecord.profile) ?? defaultRoleProfile(roleId ?? "", role ?? "");
      const profileSource = stringValue(roleRecord.profileSource) ?? "auto";
      const profileReason =
        stringValue(roleRecord.profileReason) ?? defaultRoleProfileReason(roleId ?? "", role ?? "");
      const agentTool = stringValue(roleRecord.agentTool);
      const scope = stringValue(roleRecord.scope);
      if (!roleId || !role || !agentTool || !scope) return null;
      const executionGuide = normalizeExecutionGuide(roleRecord, agentTool, role, profile);

      const status = isOrchestrationRoleStatus(roleRecord.status)
        ? roleRecord.status
        : defaultRoleStatus(roleId);
      const basePrompt = handoffPromptForRole(roleId, plan, runtime);
      const normalizedRole: WorkbenchOrchestrationRole = {
        roleId,
        role,
        profile,
        profileSource,
        profileReason,
        agentTool,
        executionGuide,
        scope,
        status,
        command: agentTool === "manual" ? null : agentTool,
        prompt: null,
      };
      return {
        ...normalizedRole,
        prompt: buildSupervisedRolePrompt(runtime, normalizedRole, basePrompt, events),
      };
    })
    .filter((role): role is WorkbenchOrchestrationRole => role !== null);
}

function roleIsIncomplete(role: WorkbenchOrchestrationRole): boolean {
  return role.status !== "complete" && role.status !== "skipped";
}

function preferredRole(
  roles: WorkbenchOrchestrationRole[],
  roleIds: string[],
): WorkbenchOrchestrationRole | null {
  for (const roleId of roleIds) {
    const role = roles.find((item) => item.roleId === roleId);
    if (role && roleIsIncomplete(role)) return role;
  }
  return null;
}

function nextRolePayload(role: WorkbenchOrchestrationRole | null): WorkbenchOrchestrationNextRole | null {
  if (!role) return null;
  return {
    roleId: role.roleId,
    role: role.role,
    profile: role.profile,
    profileSource: role.profileSource,
    profileReason: role.profileReason,
    agentTool: role.agentTool,
    executionGuide: role.executionGuide,
    status: role.status,
    command: role.command,
  };
}

function schedulerResolutionHints(
  phase: OrchestrationRuntimePhase,
  blocked: boolean,
  needsUserDecision: boolean,
  roles: WorkbenchOrchestrationRole[],
  events: WorkbenchOrchestrationEvent[],
  nextRole: WorkbenchOrchestrationRole | null,
): string[] {
  if (phase === "closed") return ["No scheduler action remains for this runtime."];
  const blockedRole = roles.find((role) => role.status === "blocked") ?? null;
  const latestBlocker = [...events].reverse().find((event) => event.type === "blocker");
  if (blocked || phase === "blocked" || blockedRole) {
    return [
      latestBlocker
        ? `Inspect blocker ${latestBlocker.eventId}: ${latestBlocker.summary}.`
        : "Inspect the latest blocked role and run output.",
      "Record an owner decision before skipping or finishing blocked.",
      blockedRole
        ? `Do not mark ${blockedRole.roleId} active as a retry; this runtime remains blocked until it is closed.`
        : "Do not retry inside this blocked runtime.",
      "If continuing is approved, finish this run blocked and open a follow-up supervised run or maintenance task.",
      "If acceptance cannot be met, finish blocked with the appropriate failure class.",
    ];
  }
  if (needsUserDecision) return ["Record the owner decision, then recompute next-role before continuing."];
  if (phase === "ready_for_monitor") {
    return ["Open the monitor or reviewer role prompt manually and record the verdict/result."];
  }
  if (phase === "ready_to_finish") {
    return ["Review verification evidence and close the run lifecycle with p2a_execute finish."];
  }
  if (nextRole) {
    const surface =
      nextRole.agentTool === "manual"
        ? "the manual workflow"
        : `${nextRole.agentTool} in the official foreground CLI/app`;
    return [
      `Open ${surface} for ${nextRole.roleId}.`,
      "Paste the role prompt and keep the owner supervising the session.",
      "Record complete, blocked, or skipped when the observed role result is clear.",
    ];
  }
  return ["Recompute next-role after recording any missing runtime event."];
}

function schedulerHint(
  runtime: JsonRecord | null,
  roles: WorkbenchOrchestrationRole[],
  events: WorkbenchOrchestrationEvent[],
): WorkbenchOrchestrationSchedulerHint | null {
  if (!runtime) return null;

  const runtimeStatus = recordValue(runtime.status);
  const sharedMentalModel = recordValue(runtime.sharedMentalModel);
  const phaseValue = runtimeStatus?.phase;
  const phase = isOrchestrationRuntimePhase(phaseValue) ? phaseValue : "running";
  const blocked = booleanValue(runtimeStatus?.blocked) ?? false;
  const needsUserDecision = booleanValue(runtimeStatus?.needsUserDecision) ?? false;
  const owner = roles.find((role) => role.roleId === "owner") ?? roles[0] ?? null;
  const blockedRole = roles.find((role) => role.status === "blocked") ?? null;

  let role: WorkbenchOrchestrationRole | null = null;
  let reason = "roles_complete";
  let instruction = "Owner should finish the run lifecycle. No agent process is started by this scheduler.";

  if (phase === "closed") {
    reason = "runtime_closed";
    instruction = "No next role. The run runtime is closed.";
  } else if (blocked || phase === "blocked" || blockedRole) {
    role = owner;
    reason = blockedRole ? `role_blocked:${blockedRole.roleId}` : "runtime_blocked";
    instruction = "Owner should inspect the blocker and decide whether to unblock, ask the user, or finish blocked.";
  } else {
    const openQuestion = recordArrayValue(sharedMentalModel?.openQuestions).find(
      (question) => question.status === "open",
    );
    if (openQuestion) {
      const targetRoleId = stringValue(openQuestion.targetRoleId);
      role = targetRoleId
        ? roles.find((item) => item.roleId === targetRoleId) ?? owner
        : owner;
      reason = `open_question:${stringValue(openQuestion.questionId) ?? "unknown"}`;
      instruction = targetRoleId
        ? `Answer the open question from ${stringValue(openQuestion.askedByRoleId) ?? "another role"}.`
        : "Owner should route or answer the open question.";
    } else if (needsUserDecision) {
      role = owner;
      reason = "owner_decision_required";
      instruction = "Owner should make or record the required decision before continuing.";
    } else if (phase === "ready_to_finish") {
      role = owner;
      reason = "ready_to_finish";
      instruction = "Owner should review the runtime, run verification/finish commands, and close the task lifecycle.";
    } else if (phase === "ready_for_monitor") {
      role = preferredRole(roles, ["monitor"]) ?? preferredRole(roles, ["reviewer"]) ?? owner;
      reason =
        role?.roleId === "monitor"
          ? "monitor_required"
          : role?.roleId === "reviewer"
            ? "reviewer_required"
            : "monitor_not_configured";
      instruction =
        role?.roleId === "monitor"
          ? "Human should open the monitor role prompt in the official CLI/app and record the verdict."
          : role?.roleId === "reviewer"
            ? "Human should open the reviewer role prompt in the official CLI/app and record the result."
            : "Owner should decide whether the run is ready to finish.";
    } else {
      role =
        preferredRole(roles, ["implementer"]) ??
        preferredRole(roles, ["reviewer"]) ??
        preferredRole(roles, ["monitor"]) ??
        owner;
      reason =
        role?.roleId === "implementer"
          ? "implementation_required"
          : role?.roleId === "reviewer"
            ? "review_required"
            : role?.roleId === "monitor"
              ? "monitor_required"
              : "roles_complete";
      instruction =
        role?.roleId === "implementer"
          ? "Human should open the implementer role prompt in the official CLI/app and record the result."
          : role?.roleId === "reviewer"
            ? "Human should open the reviewer role prompt in the official CLI/app and record the result."
            : role?.roleId === "monitor"
              ? "Human should open the monitor role prompt in the official CLI/app and record the verdict."
              : instruction;
    }
  }

  return {
    supervisedOnly: true,
    startsProcess: false,
    nextRole: nextRolePayload(role),
    reason,
    instruction,
    resolutionHints: schedulerResolutionHints(phase, blocked, needsUserDecision, roles, events, role),
    safetyBoundary:
      "Open the official CLI/app manually, paste the role prompt, then record the observed result. Do not use this scheduler to bypass subscription limits or run background automation.",
  };
}

async function normalizeRunOrchestration(
  rootPath: string,
  runsDir: string,
  runId: string,
): Promise<WorkbenchRunOrchestration | null> {
  const planPath = path.join(runsDir, `${runId}.orchestration.json`);
  const runtimePath = path.join(runsDir, `${runId}.orchestration-runtime.json`);
  const [plan, runtime] = await Promise.all([
    readOptionalJson(planPath),
    readOptionalJson(runtimePath),
  ]);
  if (!plan && !runtime) return null;

  const runtimeStatus = recordValue(runtime?.status);
  const monitorGate = recordValue(plan?.monitorGate);
  const events = normalizeOrchestrationEvents(runtime);
  const roles = normalizeOrchestrationRoles(plan, runtime, events);
  const runtimeMode = runtime?.mode;
  const planMode = plan?.mode;
  const runtimePhase = runtimeStatus?.phase;

  return {
    planId: stringValue(runtime?.planId) ?? stringValue(plan?.planId),
    runtimeId: stringValue(runtime?.runtimeId),
    mode: isOrchestrationMode(runtimeMode)
      ? runtimeMode
      : isOrchestrationMode(planMode)
        ? planMode
        : null,
    phase: isOrchestrationRuntimePhase(runtimePhase) ? runtimePhase : null,
    blocked: booleanValue(runtimeStatus?.blocked) ?? false,
    needsUserDecision: booleanValue(runtimeStatus?.needsUserDecision) ?? false,
    planPath: plan ? normalizeRelative(rootPath, planPath) : null,
    runtimePath: runtime ? normalizeRelative(rootPath, runtimePath) : null,
    sourcePlanRef: stringValue(runtime?.sourcePlanRef),
    monitorRequired: booleanValue(monitorGate?.required) ?? false,
    monitorVerdictPath: stringValue(monitorGate?.verdictPath),
    roles,
    eventCount: events.length,
    lastEvent: events.at(-1) ?? null,
    next: schedulerHint(runtime, roles, events),
    updatedAt: stringValue(runtime?.updatedAt) ?? stringValue(plan?.createdAt),
  };
}

async function normalizeRuns(
  runIndex: JsonRecord | null,
  runsDir: string,
  rootPath: string,
): Promise<WorkbenchRun[]> {
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
      const orchestration = await normalizeRunOrchestration(rootPath, runsDir, runId);
      const resolvedRunRef = normalizeRelative(rootPath, path.join(runsDir, `${runId}.json`));

      return {
        runId,
        taskId,
        iterationId: stringValue(run.iterationId),
        status,
        agentTool,
        workspaceRef,
        taskGraphRef,
        runRef: resolvedRunRef,
        startedAt,
        finishedAt: stringValue(run.finishedAt),
        changedFiles: stringArrayValue(runDetail?.changedFiles),
        verification: normalizeVerification(runDetail),
        notes: stringArrayValue(runDetail?.notes),
        failure: normalizeFailure(runDetail),
        orchestration,
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
  const fileMarkers = [
    "status.md",
    "current-spec.json",
    "gate-a-intake/intake.json",
    "gate-b-spec/spec.json",
    "gate-c-task-graph/task-graph.json",
    "task-graph.json",
    "gate-d-review/review.json",
  ];

  for (const marker of fileMarkers) {
    if (await existsAs(path.join(candidateRoot, marker), "file")) return true;
  }
  if (await existsAs(path.join(candidateRoot, "iterations"), "directory")) return true;
  return false;
}

function proposalStatusRank(status: ProposalStatus): number {
  if (status === "proposed") return 0;
  if (status === "approved") return 1;
  if (status === "deferred") return 2;
  return 3;
}

function proposalRiskRank(risk: ProposalRisk): number {
  if (risk === "high") return 0;
  if (risk === "medium") return 1;
  return 2;
}

function normalizeProposal(rootPath: string, proposalPath: string, proposal: JsonRecord | null): ProposalSummary | null {
  if (proposal?.schema_version !== "p2a.skill_proposal.v1") return null;
  const proposalId = stringValue(proposal.proposalId);
  const problem = stringValue(proposal.problem);
  const recommendedChange = stringValue(proposal.recommendedChange);
  const status = isProposalStatus(proposal.status) ? proposal.status : null;
  const risk = isProposalRisk(proposal.risk) ? proposal.risk : null;
  if (!proposalId || !problem || !recommendedChange || !status || !risk) return null;

  return {
    proposalId,
    sourceRunId: stringValue(proposal.sourceRunId),
    status,
    risk,
    problem,
    recommendedChange,
    targetFiles: stringArrayValue(proposal.targetFiles),
    evidenceCount: Array.isArray(proposal.evidence) ? proposal.evidence.length : 0,
    relativePath: normalizeRelative(rootPath, proposalPath),
    note: stringValue(proposal.note),
  };
}

async function summarizeProposals(rootPath: string): Promise<ProposalSummary[]> {
  const proposalsDir = path.join(rootPath, ".plan2agent", "proposals");
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(proposalsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const proposals = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry): Promise<ProposalSummary | null> => {
        const proposalPath = path.join(proposalsDir, entry.name);
        try {
          return normalizeProposal(rootPath, proposalPath, await readJson(proposalPath));
        } catch {
          return null;
        }
      }),
  );

  return proposals
    .filter((proposal): proposal is ProposalSummary => proposal !== null)
    .sort((left, right) => {
      const statusDiff = proposalStatusRank(left.status) - proposalStatusRank(right.status);
      if (statusDiff !== 0) return statusDiff;
      const riskDiff = proposalRiskRank(left.risk) - proposalRiskRank(right.risk);
      if (riskDiff !== 0) return riskDiff;
      return left.proposalId.localeCompare(right.proposalId);
    });
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

async function summarizeRuns(rootPath: string, artifactRoot: string): Promise<{
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
  const runs = await normalizeRuns(runIndex, runsDir, rootPath);
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
  const scaffoldLayout = await readScaffoldArtifactLayout(rootPath, artifactRoot);
  const requiresIterationInit = scaffoldLayout.requiresIterationInit;
  if (requiresIterationInit) {
    diagnostics.push({
      severity: "warn",
      message: `Gate artifacts are still in the greenfield layout. Run: node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${normalizeRelative(rootPath, artifactRoot)} --iteration-id v1-mvp`,
    });
  }
  if (scaffoldLayout.hasIncompleteIterationLayout) {
    diagnostics.push({
      severity: "error",
      message: "Iteration layout is incomplete: current-spec.json and iterations/ must exist together. Repair the iteration metadata before starting tasks.",
    });
  }
  const gates = await summarizeGates(artifactRoot, iterationRoot);
  const runSummary = await summarizeRuns(rootPath, artifactRoot);
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
    requiresIterationInit,
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
    ["scripts", "scripts", ".plan2agent/scripts", "directory"],
    ["schemas", "schemas", ".plan2agent/schemas", "directory"],
    ["artifacts", "artifacts", ".plan2agent/artifacts", "directory"],
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
  if (artifacts.some((artifact) => artifact.requiresIterationInit)) {
    return "iteration_init_required";
  }
  if (artifacts.some(artifactIsCycleCloseReady)) {
    return "cycle_close_ready";
  }
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
  proposals: ProposalSummary[],
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
  if (state === "cycle_close_ready") {
    diagnostics.push({
      severity: "ok",
      message: "All active iteration tasks are done; the iteration is ready to close.",
    });
  }
  if (state === "iteration_init_required") {
    diagnostics.push({
      severity: "warn",
      message: "A greenfield Gate A-D bundle was found; convert it with p2a_iteration init before starting tasks.",
    });
  }
  if (state === "installed_empty") {
    diagnostics.push({
      severity: "ok",
      message: "P2A markers exist, but no planning artifacts were found yet.",
    });
  }
  if (proposals.length > 0) {
    diagnostics.push({
      severity: "ok",
      message: `${proposals.length} proposal feedback item(s) found in .plan2agent/proposals.`,
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
      command: setupCommand(rootPath),
      description: "Install P2A harness files from a Plan2Agent toolkit checkout.",
    });
  }

  if (state === "installed_empty" || state === "planning_in_progress") {
    commands.push({
      id: "import",
      label: "Import guidance",
      command: importCommand(rootPath),
      description: "Import an existing planning artifact bundle from a Plan2Agent toolkit checkout.",
    });
  }
  if (primaryArtifact?.requiresIterationInit) {
    commands.push({
      id: "init_iteration",
      label: "Initialize iteration layout",
      command: iterationInitCommand(primaryArtifact),
      description: "Convert the approved Gate A-D bundle into iterations/<id>/gate-* before execution.",
    });
  }

  if (primaryArtifact || state === "broken_install") {
    commands.push({
      id: "validate",
      label: "Validate guidance",
      command: `node .plan2agent/scripts/validate_artifacts.mjs --artifact-root ${shellQuote(primaryArtifact?.rootPath ?? rootPath)}`,
      description: "Validate existing planning artifacts without modifying project files.",
    });
  }

  return commands;
}

function setupCommand(rootPath: string): string {
  return `node ${shellQuote(toolkitHandoffScript())} scaffold --target ${shellQuote(rootPath)} --tools all`;
}

function importCommand(rootPath: string): string {
  return `node ${shellQuote(toolkitHandoffScript())} --project-id <project-id> --artifacts <artifact-root> --target ${shellQuote(rootPath)} --tools all`;
}

function validateCommand(rootPath: string, artifacts: ArtifactSummary[]): string {
  const primaryArtifact = artifacts[0];
  if (primaryArtifact?.activeIteration) {
    return `node .plan2agent/scripts/p2a_iteration.mjs validate --artifacts ${shellQuote(primaryArtifact.rootPath)}`;
  }
  return `node .plan2agent/scripts/validate_artifacts.mjs --artifact-root ${shellQuote(primaryArtifact?.rootPath ?? rootPath)}`;
}

function iterationInitCommand(artifact: ArtifactSummary): string {
  return `node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${shellQuote(artifact.rootPath)} --iteration-id v1-mvp`;
}

function iterationCloseCommand(artifact: ArtifactSummary): string {
  return `node .plan2agent/scripts/p2a_iteration.mjs close --artifacts ${shellQuote(artifact.rootPath)}`;
}

function iterationOpenCommand(artifact: ArtifactSummary): string {
  return `node .plan2agent/scripts/p2a_iteration.mjs open --artifacts ${shellQuote(artifact.rootPath)} --iteration-id '<next>' --idea '<text>'`;
}

function maintenanceAddCommand(artifact: ArtifactSummary): string {
  return `node .plan2agent/scripts/p2a_iteration.mjs maintenance add --artifacts ${shellQuote(artifact.rootPath)} --title '<title>' --accept '<criterion>'`;
}

function installAction(rootPath: string): OnboardingAction {
  return {
    id: "install_p2a",
    label: "Install P2A",
    description: "Install harness files from a Plan2Agent toolkit checkout.",
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
    description: "Import an approved planning artifact bundle from a Plan2Agent toolkit checkout.",
    command: importCommand(rootPath),
    cwd: rootPath,
    targetPath: rootPath,
    impact: "writes_project",
  };
}

function iterationInitAction(rootPath: string, artifact: ArtifactSummary): OnboardingAction {
  return {
    id: "init_iteration",
    label: "Initialize iteration",
    description: "Convert greenfield Gate artifacts into the iteration layout.",
    command: iterationInitCommand(artifact),
    cwd: rootPath,
    targetPath: artifact.rootPath,
    impact: "writes_project",
  };
}

function iterationCloseAction(rootPath: string, artifact: ArtifactSummary): OnboardingAction {
  return {
    id: "close_iteration",
    label: "Close iteration",
    description: "Archive the completed active iteration so the next cycle can start.",
    command: iterationCloseCommand(artifact),
    cwd: rootPath,
    targetPath: artifact.rootPath,
    impact: "writes_project",
  };
}

function iterationOpenAction(rootPath: string, artifact: ArtifactSummary): OnboardingAction {
  return {
    id: "open_iteration",
    label: "Open next iteration",
    description: "Start the next feature cycle after the current iteration is closed.",
    command: iterationOpenCommand(artifact),
    cwd: rootPath,
    targetPath: artifact.rootPath,
    impact: "writes_project",
  };
}

function maintenanceAddAction(rootPath: string, artifact: ArtifactSummary): OnboardingAction {
  return {
    id: "add_maintenance",
    label: "Add maintenance task",
    description: "Capture a small fix without opening a full feature iteration.",
    command: maintenanceAddCommand(artifact),
    cwd: rootPath,
    targetPath: artifact.rootPath,
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
  const hasCloseReadyCycle = artifacts.some(artifactIsCycleCloseReady);

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
      status: state === "iteration_init_required"
        ? "warn"
        : hasCloseReadyCycle || hasReadyTask || hasRunHistory
          ? "ok"
          : state === "execution_ready"
            ? "ok"
            : "warn",
      detail: state === "iteration_init_required"
        ? "iteration init required before task execution"
        : hasCloseReadyCycle
          ? "all active iteration tasks are done"
        : hasReadyTask
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

  if (state === "iteration_init_required") {
    const primaryArtifact = artifacts.find((artifact) => artifact.requiresIterationInit) ?? artifacts[0];
    return {
      stage: "iteration_init_required",
      title: "Initialize iteration",
      summary: "Approved Gate artifacts exist, but they still need to be moved into the iteration layout before execution.",
      primaryAction: primaryArtifact ? iterationInitAction(rootPath, primaryArtifact) : validateAction(rootPath, artifacts),
      secondaryActions: [validateAction(rootPath, artifacts)],
      checks: checksForUi,
    };
  }

  if (state === "cycle_close_ready") {
    const primaryArtifact = artifacts.find(artifactIsCycleCloseReady) ?? artifacts[0];
    return {
      stage: "cycle_close_ready",
      title: "Cycle close-ready",
      summary: "All active iteration tasks are done. Close the iteration before opening the next cycle.",
      primaryAction: primaryArtifact ? iterationCloseAction(rootPath, primaryArtifact) : validateAction(rootPath, artifacts),
      secondaryActions: primaryArtifact
        ? [
            inspectTasksAction(rootPath, artifacts),
            validateAction(rootPath, artifacts),
            iterationOpenAction(rootPath, primaryArtifact),
            maintenanceAddAction(rootPath, primaryArtifact),
          ]
        : [validateAction(rootPath, artifacts)],
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
  options: { defaultAgentTool?: ExecutionAgentTool } = {},
): Promise<ProjectSnapshot> {
  const normalizedRootPath = path.resolve(rootPath);
  const checks = await buildFileChecks(normalizedRootPath);
  const artifactRoots = await discoverArtifactRoots(normalizedRootPath);
  const artifacts = await Promise.all(
    artifactRoots.map((artifactRoot) => summarizeArtifact(normalizedRootPath, artifactRoot)),
  );
  const proposals = await summarizeProposals(normalizedRootPath);
  const state = determineState(checks, artifacts);
  const primaryArtifact = artifacts[0] ?? null;
  const diagnostics = buildDiagnostics(state, checks, artifacts, proposals);

  return {
    rootPath: normalizedRootPath,
    name: path.basename(normalizedRootPath),
    state,
    stateLabel: stateLabel(state),
    mode: "read-only",
    projectId: primaryArtifact?.projectId ?? null,
    activeIteration: primaryArtifact?.activeIteration ?? null,
    defaultAgentTool: options.defaultAgentTool ?? DEFAULT_EXECUTION_AGENT_TOOL,
    artifactRoot: primaryArtifact?.rootPath ?? null,
    checks,
    artifacts,
    onboarding: buildOnboarding(normalizedRootPath, state, checks, artifacts),
    commands: buildCommands(normalizedRootPath, state, artifacts),
    proposals,
    diagnostics,
    generatedAt: new Date().toISOString(),
  };
}
