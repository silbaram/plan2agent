import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readScaffoldArtifactLayoutSync } from "./artifactLayout";
import type {
  ExecutionCommandResult,
  ExecutionCustomVerificationCommand,
  ExecutionAgentTool,
  ExecutionFollowUpCommand,
  ExecutionFinishRunRequest,
  ExecutionStartRunRequest,
  FailureClass,
  OrchestrationMarkRoleRequest,
  OrchestrationRoleStatus,
  VerificationType,
} from "../shared/ipc";
import { EXECUTION_AGENT_TOOLS } from "../shared/ipc";

const OUTPUT_LIMIT = 1024 * 128;
const VALID_EXECUTION_AGENT_TOOLS = new Set<ExecutionAgentTool>(EXECUTION_AGENT_TOOLS);
const VALID_FAILURE_CLASSES = new Set<FailureClass>([
  "verification_failed",
  "test_flake",
  "scope_violation",
  "missing_dependency",
  "environment_failure",
  "implementation_incomplete",
  "other",
]);
const VALID_VERIFICATION_TYPES = new Set<VerificationType>([
  "test",
  "lint",
  "typecheck",
  "custom",
]);
const VALID_ORCHESTRATION_ROLE_STATUSES = new Set<OrchestrationRoleStatus>([
  "pending",
  "active",
  "blocked",
  "complete",
  "skipped",
]);
const FOLLOW_UP_COMMAND_IDS = new Set<ExecutionFollowUpCommand["id"]>([
  "resume",
  "status",
  "finish",
  "review",
]);

type ExecutionCommand = {
  cwd: string;
  scriptPath: string;
  displayCommand: string;
  args: string[];
};

function assertDirectory(targetPath: string, label: string): string {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const normalized = path.resolve(targetPath);
  try {
    if (!statSync(normalized).isDirectory()) {
      throw new Error(`${label} is not a directory: ${normalized}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not a directory")) {
      throw error;
    }
    throw new Error(`${label} does not exist: ${normalized}`);
  }
  return normalized;
}

function assertFile(targetPath: string, label: string): string {
  const normalized = path.resolve(targetPath);
  try {
    if (!statSync(normalized).isFile()) {
      throw new Error(`${label} is not a file: ${normalized}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not a file")) {
      throw error;
    }
    throw new Error(`${label} does not exist: ${normalized}`);
  }
  return normalized;
}

function assertInsideDirectory(rootPath: string, targetPath: string, label: string): string {
  const relativePath = path.relative(rootPath, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside project root`);
  }
  return targetPath;
}

function optionalFile(targetPath: string | null, basePath: string, label: string): string | null {
  if (!targetPath) return null;
  const normalized = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(basePath, targetPath);
  assertInsideDirectory(basePath, normalized, label);
  return existsSync(normalized) && statSync(normalized).isFile() ? normalized : null;
}

function normalizeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeTaskId(taskId: string): string {
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("task id is required");
  }
  const normalized = taskId.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`task id contains unsupported characters: ${taskId}`);
  }
  return normalized;
}

function normalizeRunId(runId: string | null | undefined): string | null {
  if (!runId) return null;
  const normalized = runId.trim();
  if (!/^run-[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`run id must match run-[A-Za-z0-9._-]+: ${runId}`);
  }
  return normalized;
}

function normalizeRoleId(roleId: string): string {
  if (typeof roleId !== "string" || roleId.trim().length === 0) {
    throw new Error("role id is required");
  }
  const normalized = roleId.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`role id contains unsupported characters: ${roleId}`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function projectRelativeCommandPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length ? relativePath.split(path.sep).join("/") : ".";
}

function assertIterationInitializedForExecution(
  projectRoot: string,
  artifactRoot: string,
): void {
  const layout = readScaffoldArtifactLayoutSync(projectRoot, artifactRoot);
  if (layout.hasIncompleteIterationLayout) {
    throw new Error(
      [
        "Iteration layout is incomplete for this scaffold artifact bundle.",
        "current-spec.json and iterations/ must exist together before task execution.",
        "Repair or restore the iteration metadata before starting tasks.",
      ].join("\n"),
    );
  }
  if (!layout.requiresIterationInit) return;

  const artifactRef = projectRelativeCommandPath(projectRoot, artifactRoot);
  throw new Error(
    [
      "This artifact bundle is still in the greenfield gate layout.",
      "Convert it to the iteration layout before starting or finishing runs.",
      `Run: node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${artifactRef} --iteration-id v1-mvp`,
    ].join("\n"),
  );
}

function resolveExecutionContext(request: {
  projectRoot: string;
  artifactRoot: string;
  taskGraphPath: string | null;
}): {
  projectRoot: string;
  artifactRoot: string;
  scriptPath: string;
  sourceArgs: string[];
} {
  const projectRoot = assertDirectory(request.projectRoot, "project root");
  const artifactRoot = assertDirectory(request.artifactRoot, "artifact root");
  const scriptPath = assertFile(
    path.join(projectRoot, ".plan2agent", "scripts", "p2a_execute.mjs"),
    "p2a_execute",
  );
  const taskGraphPath = optionalFile(request.taskGraphPath, projectRoot, "task graph path");
  assertIterationInitializedForExecution(projectRoot, artifactRoot);
  const sourceArgs =
    existsSync(path.join(artifactRoot, "current-spec.json")) || !taskGraphPath
      ? ["--artifacts", artifactRoot]
      : ["--graph", taskGraphPath];

  return {
    projectRoot,
    artifactRoot,
    scriptPath,
    sourceArgs,
  };
}

function resolveOrchestrationContext(request: OrchestrationMarkRoleRequest): {
  projectRoot: string;
  runtimePath: string;
  runtimeArg: string;
  scriptPath: string;
} {
  const projectRoot = assertDirectory(request.projectRoot, "project root");
  const scriptPath = assertFile(
    path.join(projectRoot, ".plan2agent", "scripts", "p2a_orchestrate.mjs"),
    "p2a_orchestrate",
  );
  const runtimePath = assertFile(
    assertInsideDirectory(
      projectRoot,
      path.isAbsolute(request.runtimePath)
        ? path.resolve(request.runtimePath)
        : path.resolve(projectRoot, request.runtimePath),
      "runtime path",
    ),
    "orchestration runtime",
  );

  return {
    projectRoot,
    runtimePath,
    runtimeArg: projectRelativeCommandPath(projectRoot, runtimePath),
    scriptPath,
  };
}

function normalizeCustomCommands(
  commands: ExecutionCustomVerificationCommand[],
): ExecutionCustomVerificationCommand[] {
  return commands
    .map((command) => ({
      type: command.type,
      command: typeof command.command === "string" ? command.command.trim() : "",
    }))
    .filter((command) => command.command.length > 0)
    .map((command) => {
      if (!VALID_VERIFICATION_TYPES.has(command.type)) {
        throw new Error(`unsupported verification type: ${String(command.type)}`);
      }
      return command;
    });
}

function appendVerificationArgs(args: string[], request: ExecutionFinishRunRequest): void {
  if (request.verifyTest) args.push("--test");
  if (request.verifyLint) args.push("--lint");
  if (request.verifyTypecheck) args.push("--typecheck");
  for (const customCommand of normalizeCustomCommands(request.customVerificationCommands)) {
    args.push("--verify-command", `${customCommand.type}:${customCommand.command}`);
  }
}

export function buildStartRunCommand(request: ExecutionStartRunRequest): ExecutionCommand {
  const context = resolveExecutionContext(request);
  const taskId = normalizeTaskId(request.taskId);
  const runId = normalizeRunId(request.runId);
  if (!VALID_EXECUTION_AGENT_TOOLS.has(request.agentTool)) {
    throw new Error(`unsupported agent tool: ${String(request.agentTool)}`);
  }

  const args = [
    "start",
    ...context.sourceArgs,
    "--task",
    taskId,
    "--agent-tool",
    request.agentTool,
    "--workspace",
    context.projectRoot,
  ];
  if (runId) args.push("--run-id", runId);

  return {
    cwd: context.projectRoot,
    scriptPath: context.scriptPath,
    displayCommand: ["node", ".plan2agent/scripts/p2a_execute.mjs", ...args]
      .map(shellQuote)
      .join(" "),
    args,
  };
}

export function buildFinishRunCommand(request: ExecutionFinishRunRequest): ExecutionCommand {
  const context = resolveExecutionContext(request);
  const runId = normalizeRunId(request.runId);
  if (!runId) {
    throw new Error("run id is required");
  }
  if (request.status === "blocked" && !request.failureClass) {
    throw new Error("blocked finish requires a failure class");
  }
  if (request.failureClass && !VALID_FAILURE_CLASSES.has(request.failureClass)) {
    throw new Error(`unsupported failure class: ${String(request.failureClass)}`);
  }

  const args = ["finish", ...context.sourceArgs, "--run-id", runId];
  appendVerificationArgs(args, request);
  if (request.status !== "auto") args.push("--status", request.status);
  if (request.failureClass) args.push("--failure-class", request.failureClass);
  if (request.collectGit) args.push("--collect-git");
  for (const changedFile of normalizeStringList(request.changedFiles)) {
    args.push("--changed-file", changedFile);
  }
  for (const note of normalizeStringList(request.notes)) {
    args.push("--note", note);
  }

  return {
    cwd: context.projectRoot,
    scriptPath: context.scriptPath,
    displayCommand: ["node", ".plan2agent/scripts/p2a_execute.mjs", ...args]
      .map(shellQuote)
      .join(" "),
    args,
  };
}

export function buildMarkRoleCommand(request: OrchestrationMarkRoleRequest): ExecutionCommand {
  const context = resolveOrchestrationContext(request);
  const roleId = normalizeRoleId(request.roleId);
  if (!VALID_ORCHESTRATION_ROLE_STATUSES.has(request.roleStatus)) {
    throw new Error(`unsupported role status: ${String(request.roleStatus)}`);
  }

  const args = [
    "mark-role",
    "--runtime",
    context.runtimeArg,
    "--role",
    roleId,
    "--role-status",
    request.roleStatus,
  ];
  const summary = normalizeOptionalText(request.summary);
  const detail = normalizeOptionalText(request.detail);
  const verdict = normalizeOptionalText(request.verdict ?? null);
  if (summary) args.push("--summary", summary);
  if (detail) args.push("--detail", detail);
  if (verdict) args.push("--verdict", verdict);
  if (request.requiresOwnerAction) args.push("--requires-owner-action");

  return {
    cwd: context.projectRoot,
    scriptPath: context.scriptPath,
    displayCommand: ["node", ".plan2agent/scripts/p2a_orchestrate.mjs", ...args]
      .map(shellQuote)
      .join(" "),
    args,
  };
}

function appendChunk(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function extractFollowUpCommands(stdout: string): ExecutionFollowUpCommand[] {
  const commands: ExecutionFollowUpCommand[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^- (resume|status|finish|review): (.+)$/);
    if (!match) continue;
    const id = match[1] as ExecutionFollowUpCommand["id"];
    const command = match[2].trim();
    if (!FOLLOW_UP_COMMAND_IDS.has(id) || !command || seen.has(id)) continue;
    seen.add(id);
    commands.push({ id, label: id, command });
  }
  return commands;
}

export function finishRun(request: ExecutionFinishRunRequest): Promise<ExecutionCommandResult> {
  return runExecutionCommand(buildFinishRunCommand(request));
}

export function startRun(request: ExecutionStartRunRequest): Promise<ExecutionCommandResult> {
  return runExecutionCommand(buildStartRunCommand(request));
}

export function markRole(request: OrchestrationMarkRoleRequest): Promise<ExecutionCommandResult> {
  return runExecutionCommand(buildMarkRoleCommand(request));
}

function runExecutionCommand(command: ExecutionCommand): Promise<ExecutionCommandResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [command.scriptPath, ...command.args], {
      cwd: command.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NO_COLOR: process.env.NO_COLOR ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendChunk(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const finishedAtDate = new Date();
      resolve({
        command: command.displayCommand,
        args: command.args,
        cwd: command.cwd,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        followUpCommands: extractFollowUpCommands(stdout),
        startedAt,
        finishedAt: finishedAtDate.toISOString(),
        durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
      });
    });
  });
}
