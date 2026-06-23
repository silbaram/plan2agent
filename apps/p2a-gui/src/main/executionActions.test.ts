import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinishRunCommand, buildStartRunCommand } from "./executionActions";
import type { ExecutionFinishRunRequest, ExecutionStartRunRequest } from "../shared/ipc";

async function createProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-execution-"));
  const artifactRoot = path.join(projectRoot, "artifacts", "demo");
  await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "scripts", "p2a_execute.mjs"), "");
  return { projectRoot, artifactRoot };
}

function requestFor(projectRoot: string, artifactRoot: string): ExecutionFinishRunRequest {
  return {
    projectRoot,
    artifactRoot,
    taskGraphPath: null,
    runId: "run-2026-task-001",
    status: "failed",
    failureClass: "verification_failed",
    collectGit: true,
    verifyTest: true,
    verifyLint: false,
    verifyTypecheck: true,
    customVerificationCommands: [{ type: "custom", command: "npm run smoke" }],
    changedFiles: ["src/app.ts", "src/app.ts", ""],
    notes: ["verification failed", ""],
  };
}

function startRequestFor(projectRoot: string, artifactRoot: string): ExecutionStartRunRequest {
  return {
    projectRoot,
    artifactRoot,
    taskGraphPath: null,
    taskId: "task-001",
    agentTool: "codex",
  };
}

describe("execution action helpers", () => {
  it("builds a p2a_execute start command from a selected ready task", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      const command = buildStartRunCommand(startRequestFor(projectRoot, artifactRoot));

      expect(command.cwd).toBe(projectRoot);
      expect(command.displayCommand).toContain("p2a_execute.mjs start");
      expect(command.args).toEqual([
        "start",
        "--artifacts",
        artifactRoot,
        "--task",
        "task-001",
        "--agent-tool",
        "codex",
        "--workspace",
        projectRoot,
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("can pass a stable run id when starting a task", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      const command = buildStartRunCommand({
        ...startRequestFor(projectRoot, artifactRoot),
        runId: "run-gui-task-001",
      });

      expect(command.args.slice(-2)).toEqual(["--run-id", "run-gui-task-001"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("builds a p2a_execute finish command from typed GUI input", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      const command = buildFinishRunCommand(requestFor(projectRoot, artifactRoot));

      expect(command.cwd).toBe(projectRoot);
      expect(command.displayCommand).toContain("p2a_execute.mjs finish");
      expect(command.args).toEqual([
        "finish",
        "--artifacts",
        artifactRoot,
        "--run-id",
        "run-2026-task-001",
        "--test",
        "--typecheck",
        "--verify-command",
        "custom:npm run smoke",
        "--status",
        "failed",
        "--failure-class",
        "verification_failed",
        "--collect-git",
        "--changed-file",
        "src/app.ts",
        "--note",
        "verification failed",
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("requires a failure class when blocking a run", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      expect(() =>
        buildFinishRunCommand({
          ...requestFor(projectRoot, artifactRoot),
          status: "blocked",
          failureClass: null,
        }),
      ).toThrow("blocked finish requires a failure class");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses --graph for non-iterative artifact roots with a task graph path", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    const taskGraphPath = path.join(artifactRoot, "gate-c-task-graph", "task-graph.json");
    try {
      await mkdir(path.dirname(taskGraphPath), { recursive: true });
      await writeFile(taskGraphPath, "{}");

      const command = buildFinishRunCommand({
        ...requestFor(projectRoot, artifactRoot),
        taskGraphPath,
      });

      expect(command.args.slice(0, 3)).toEqual(["finish", "--graph", taskGraphPath]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
