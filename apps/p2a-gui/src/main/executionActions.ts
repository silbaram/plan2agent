import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type {
  ExecutionCommandResult,
  ExecutionCustomVerificationCommand,
  ExecutionFinishRunRequest,
  FailureClass,
  VerificationType,
} from "../shared/ipc";

const OUTPUT_LIMIT = 1024 * 128;
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

function optionalFile(targetPath: string | null, basePath: string): string | null {
  if (!targetPath) return null;
  const normalized = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(basePath, targetPath);
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

export function buildFinishRunCommand(request: ExecutionFinishRunRequest): {
  cwd: string;
  scriptPath: string;
  displayCommand: string;
  args: string[];
} {
  const projectRoot = assertDirectory(request.projectRoot, "project root");
  const artifactRoot = assertDirectory(request.artifactRoot, "artifact root");
  const scriptPath = assertFile(path.join(projectRoot, "scripts", "p2a_execute.mjs"), "p2a_execute");
  const taskGraphPath = optionalFile(request.taskGraphPath, projectRoot);
  if (!/^run-[A-Za-z0-9._-]+$/.test(request.runId)) {
    throw new Error(`run id must match run-[A-Za-z0-9._-]+: ${request.runId}`);
  }
  if (request.status === "blocked" && !request.failureClass) {
    throw new Error("blocked finish requires a failure class");
  }
  if (request.failureClass && !VALID_FAILURE_CLASSES.has(request.failureClass)) {
    throw new Error(`unsupported failure class: ${String(request.failureClass)}`);
  }

  const sourceArgs =
    existsSync(path.join(artifactRoot, "current-spec.json")) || !taskGraphPath
      ? ["--artifacts", artifactRoot]
      : ["--graph", taskGraphPath];
  const args = ["finish", ...sourceArgs, "--run-id", request.runId];
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
    cwd: projectRoot,
    scriptPath,
    displayCommand: ["node", "scripts/p2a_execute.mjs", ...args].map(shellQuote).join(" "),
    args,
  };
}

function appendChunk(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

export function finishRun(request: ExecutionFinishRunRequest): Promise<ExecutionCommandResult> {
  const command = buildFinishRunCommand(request);
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
        startedAt,
        finishedAt: finishedAtDate.toISOString(),
        durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
      });
    });
  });
}
