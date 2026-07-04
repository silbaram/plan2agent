import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type {
  ExecutionCommandResult,
  OperationalAction,
  OperationalActionRequest,
} from "../shared/ipc";

const OUTPUT_LIMIT = 1024 * 128;
const VALID_OPERATIONAL_ACTIONS = new Set<OperationalAction>([
  "update_preview",
  "update_apply",
  "eval_generate",
  "eval_analyze",
  "eval_digest",
  "memory_digest",
  "memory_history",
]);

type OperationalCommand = {
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

function assertInsideProject(projectRoot: string, targetPath: string, label: string): string {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const normalized = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const relativePath = path.relative(projectRoot, normalized);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must stay inside project root`);
  }
  return normalized;
}

function projectRelativeCommandPath(projectRoot: string, targetPath: string): string {
  const relativePath = path.relative(projectRoot, targetPath);
  return relativePath.length ? relativePath.split(path.sep).join("/") : ".";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizeOperationalAction(action: OperationalAction): OperationalAction {
  if (!VALID_OPERATIONAL_ACTIONS.has(action)) {
    throw new Error(`unsupported operational action: ${String(action)}`);
  }
  return action;
}

function evalArgsForAction(
  action: Extract<OperationalAction, "eval_generate" | "eval_analyze" | "eval_digest">,
  artifactRef: string,
): string[] {
  if (action === "eval_generate") {
    return ["eval", "generate", "--artifacts", artifactRef];
  }
  if (action === "eval_analyze") {
    return [
      "eval",
      "analyze",
      "--artifacts",
      artifactRef,
      "--output",
      `${artifactRef}/eval/analysis.json`,
    ];
  }
  return [
    "eval",
    "digest",
    "--eval",
    `${artifactRef}/eval`,
    "--output",
    `${artifactRef}/eval/eval-digest.json`,
  ];
}

function memoryArgsForAction(
  action: Extract<OperationalAction, "memory_digest" | "memory_history">,
  artifactRef: string,
): string[] {
  if (action === "memory_digest") {
    return [
      "memory",
      "digest",
      "--artifacts",
      artifactRef,
      "--output",
      `${artifactRef}/memory-digest.json`,
    ];
  }
  return [
    "memory",
    "history",
    "--artifacts",
    artifactRef,
    "--output",
    `${artifactRef}/memory-history.json`,
  ];
}

export function buildOperationalActionCommand(
  request: OperationalActionRequest,
): OperationalCommand {
  const projectRoot = assertDirectory(request.projectRoot, "project root");
  const action = normalizeOperationalAction(request.action);
  const scriptPath = assertFile(
    path.join(projectRoot, ".plan2agent", "scripts", "p2a.mjs"),
    "p2a",
  );

  let args: string[];
  if (action === "update_preview") {
    args = ["update", "--dry-run"];
  } else if (action === "update_apply") {
    args = ["update", "--apply"];
  } else {
    const artifactRoot = assertDirectory(
      assertInsideProject(
        projectRoot,
        request.artifactRoot ?? "",
        "artifact root",
      ),
      "artifact root",
    );
    const artifactRef = projectRelativeCommandPath(projectRoot, artifactRoot);
    args = action === "memory_digest" || action === "memory_history"
      ? memoryArgsForAction(action, artifactRef)
      : evalArgsForAction(action, artifactRef);
  }

  return {
    cwd: projectRoot,
    scriptPath,
    displayCommand: ["node", ".plan2agent/scripts/p2a.mjs", ...args]
      .map(shellQuote)
      .join(" "),
    args,
  };
}

function appendChunk(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

export function runOperationalAction(
  request: OperationalActionRequest,
): Promise<ExecutionCommandResult> {
  const command = buildOperationalActionCommand(request);
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
        followUpCommands: [],
        startedAt,
        finishedAt: finishedAtDate.toISOString(),
        durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
      });
    });
  });
}
