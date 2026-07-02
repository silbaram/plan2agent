import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFinishRunCommand,
  buildMarkRoleCommand,
  buildStartRunCommand,
  finishRun,
  startRun,
} from "./executionActions";
import { loadProjectSnapshot } from "./projectLoader";
import type { ExecutionFinishRunRequest, ExecutionStartRunRequest } from "../shared/ipc";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function createProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-execution-"));
  const artifactRoot = path.join(projectRoot, ".plan2agent", "artifacts", "demo");
  await mkdir(path.join(projectRoot, ".plan2agent", "scripts"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(projectRoot, ".plan2agent", "scripts", "p2a_execute.mjs"), "");
  await writeFile(path.join(projectRoot, ".plan2agent", "scripts", "p2a_orchestrate.mjs"), "");
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

async function createSmokeProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-execution-smoke-"));
  const taskGraphPath = path.join(projectRoot, "gate-c-task-graph", "task-graph.json");

  await mkdir(path.join(projectRoot, ".plan2agent"), { recursive: true });
  await cp(path.join(repoRoot, "scripts"), path.join(projectRoot, ".plan2agent", "scripts"), {
    recursive: true,
  });
  await cp(path.join(repoRoot, "schemas"), path.join(projectRoot, ".plan2agent", "schemas"), {
    recursive: true,
  });
  await mkdir(path.join(projectRoot, "gate-b-spec"), { recursive: true });
  await mkdir(path.dirname(taskGraphPath), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".plan2agent", "manifest.json"),
    formatJson({ schema_version: "p2a.manifest.v1" }),
  );
  await writeFile(
    path.join(projectRoot, "gate-b-spec", "spec.json"),
    formatJson({
      schema_version: "p2a.spec.v1",
      project_id: "gui-smoke-project",
      source_intake: "USER-001",
      product: {
        problem: "Exercise the GUI execution lifecycle.",
        target_users: ["P2A operator"],
        goals: ["Start and finish one task from the GUI lifecycle."],
        non_goals: ["Full agent orchestration"],
        core_flows: ["Open project, start run, finish run."],
        screens_or_interfaces: ["Task execution workbench"],
        data_model_draft: ["Run record"],
        external_integrations: ["None"],
        success_criteria: ["The task and run files reach a finished state."],
        constraints: ["Use the existing file-based lifecycle."],
      },
      implementation: {
        architecture: ["Electron main process calls the existing CLI scripts."],
        interfaces: ["Typed IPC execution actions"],
        data_flow: ["Task graph to run record to project snapshot"],
        dependencies: ["None"],
        edge_cases: ["CLI command failures"],
        verification: ["Run a custom verification command."],
      },
      clarifying_question_disposition: [],
      open_decisions: [],
      approval: "approved",
      evidence: [
        {
          source_id: "USER-001",
          title: "GUI smoke test scope",
          url: "",
          used_for: "Regression coverage",
        },
      ],
    }),
  );
  await writeFile(
    taskGraphPath,
    formatJson({
      schema_version: "p2a.task_graph.v1",
      projectId: "gui-smoke-project",
      version: "1",
      sourceSpec: "gate-b-spec/spec.json",
      tasks: [
        {
          id: "task-001",
          title: "Implement GUI smoke task",
          description: "A minimal task used to verify the GUI execution lifecycle.",
          status: "todo",
          dependencies: [],
          acceptanceCriteria: ["The task can be started and finished."],
          targetArea: "execution-lifecycle",
          suggestedAgentPrompt: "Implement the GUI smoke task.",
          sourceSpecRefs: ["product.problem"],
        },
      ],
    }),
  );

  return { projectRoot, artifactRoot: projectRoot, taskGraphPath };
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

  it("allows manual implementation starts and rejects read-only/non-implementer tools", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      const manualCommand = buildStartRunCommand({
        ...startRequestFor(projectRoot, artifactRoot),
        agentTool: "manual",
      });
      expect(manualCommand.args).toContain("manual");

      expect(() =>
        buildStartRunCommand({
          ...startRequestFor(projectRoot, artifactRoot),
          agentTool: "gemini" as never,
        }),
      ).toThrow("unsupported agent tool");
      expect(() =>
        buildStartRunCommand({
          ...startRequestFor(projectRoot, artifactRoot),
          agentTool: "aider" as never,
        }),
      ).toThrow("unsupported agent tool");
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

  it("builds a supervised orchestration mark-role command", async () => {
    const { projectRoot } = await createProject();
    const runtimePath = path.join(projectRoot, "runs", "run-2026-task-001.orchestration-runtime.json");
    try {
      await mkdir(path.dirname(runtimePath), { recursive: true });
      await writeFile(runtimePath, "{}");

      const command = buildMarkRoleCommand({
        projectRoot,
        runtimePath: path.relative(projectRoot, runtimePath),
        roleId: "monitor",
        roleStatus: "complete",
        detail: "implementation checked",
        verdict: "confirm_done",
      });

      expect(command.cwd).toBe(projectRoot);
      expect(command.displayCommand).toContain("p2a_orchestrate.mjs mark-role");
      expect(command.args).toEqual([
        "mark-role",
        "--runtime",
        "runs/run-2026-task-001.orchestration-runtime.json",
        "--role",
        "monitor",
        "--role-status",
        "complete",
        "--detail",
        "implementation checked",
        "--verdict",
        "confirm_done",
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps orchestration runtime paths inside the project", async () => {
    const { projectRoot } = await createProject();
    try {
      expect(() =>
        buildMarkRoleCommand({
          projectRoot,
          runtimePath: "/tmp/outside-runtime.json",
          roleId: "implementer",
          roleStatus: "complete",
        }),
      ).toThrow("runtime path must stay inside project root");
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

  it("rejects start command construction when the P2A execution script is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-execution-missing-script-"));
    try {
      await mkdir(projectRoot, { recursive: true });

      expect(() => buildStartRunCommand(startRequestFor(projectRoot, projectRoot))).toThrow(
        "p2a_execute does not exist",
      );
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

  it("rejects scaffold greenfield artifacts before building execution commands", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    const taskGraphPath = path.join(artifactRoot, "gate-c-task-graph", "task-graph.json");
    try {
      await writeFile(
        path.join(projectRoot, ".plan2agent", "manifest.json"),
        formatJson({
          schema_version: "p2a.handoff.v1",
          provenance: { mode: "scaffold" },
        }),
      );
      await mkdir(path.join(artifactRoot, "gate-a-intake"), { recursive: true });
      await mkdir(path.join(artifactRoot, "gate-b-spec"), { recursive: true });
      await mkdir(path.dirname(taskGraphPath), { recursive: true });
      await mkdir(path.join(artifactRoot, "gate-d-review"), { recursive: true });
      await writeFile(path.join(artifactRoot, "status.md"), "Progress: [A] -> [B] -> [C] -> [D]\n");
      await writeFile(path.join(artifactRoot, "gate-a-intake", "intake.json"), "{}");
      await writeFile(path.join(artifactRoot, "gate-b-spec", "spec.json"), "{}");
      await writeFile(taskGraphPath, "{}");
      await writeFile(path.join(artifactRoot, "gate-d-review", "review.json"), "{}");

      expect(() =>
        buildStartRunCommand({
          ...startRequestFor(projectRoot, artifactRoot),
          taskGraphPath,
        }),
      ).toThrow("p2a_iteration.mjs init");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects scaffold artifacts with incomplete iteration metadata", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    const taskGraphPath = path.join(artifactRoot, "gate-c-task-graph", "task-graph.json");
    try {
      await writeFile(
        path.join(projectRoot, ".plan2agent", "manifest.json"),
        formatJson({
          schema_version: "p2a.handoff.v1",
          provenance: { mode: "scaffold" },
        }),
      );
      await mkdir(path.join(artifactRoot, "gate-a-intake"), { recursive: true });
      await mkdir(path.join(artifactRoot, "gate-b-spec"), { recursive: true });
      await mkdir(path.dirname(taskGraphPath), { recursive: true });
      await mkdir(path.join(artifactRoot, "gate-d-review"), { recursive: true });
      await mkdir(path.join(artifactRoot, "iterations"), { recursive: true });
      await writeFile(path.join(artifactRoot, "status.md"), "Progress: [A] -> [B] -> [C] -> [D]\n");
      await writeFile(path.join(artifactRoot, "gate-a-intake", "intake.json"), "{}");
      await writeFile(path.join(artifactRoot, "gate-b-spec", "spec.json"), "{}");
      await writeFile(taskGraphPath, "{}");
      await writeFile(path.join(artifactRoot, "gate-d-review", "review.json"), "{}");

      expect(() =>
        buildStartRunCommand({
          ...startRequestFor(projectRoot, artifactRoot),
          taskGraphPath,
        }),
      ).toThrow("Iteration layout is incomplete");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects task graph paths outside the project root", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "p2a-outside-graph-"));
    const outsideGraphPath = path.join(outsideRoot, "task-graph.json");
    try {
      await writeFile(outsideGraphPath, "{}");

      expect(() =>
        buildFinishRunCommand({
          ...requestFor(projectRoot, artifactRoot),
          taskGraphPath: outsideGraphPath,
        }),
      ).toThrow("task graph path must stay inside project root");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("returns CLI stderr when starting a task that is not ready", async () => {
    const { projectRoot, artifactRoot, taskGraphPath } = await createSmokeProject();
    const graph = await readJson<{
      tasks: Array<{
        id: string;
        title: string;
        description: string;
        status: string;
        dependencies: string[];
        acceptanceCriteria: string[];
        targetArea: string;
        suggestedAgentPrompt: string;
        sourceSpecRefs: string[];
      }>;
    }>(taskGraphPath);
    graph.tasks[0].dependencies = ["task-002"];
    graph.tasks.push({
      id: "task-002",
      title: "Finish dependency",
      description: "A dependency that must finish before task-001 can start.",
      status: "todo",
      dependencies: [],
      acceptanceCriteria: ["The dependency is complete."],
      targetArea: "execution-lifecycle",
      suggestedAgentPrompt: "Finish the dependency.",
      sourceSpecRefs: ["product.problem"],
    });
    await writeFile(taskGraphPath, formatJson(graph));

    try {
      const result = await startRun({
        projectRoot,
        artifactRoot,
        taskGraphPath,
        taskId: "task-001",
        agentTool: "codex",
        runId: "run-gui-smoke-not-ready",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("task-001 is not ready");
      expect(result.stderr).toContain("incomplete dependencies: task-002");
      expect(existsSync(path.join(projectRoot, "runs", "run-gui-smoke-not-ready.json"))).toBe(
        false,
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("records failed verification output and blocks the task", async () => {
    const { projectRoot, artifactRoot, taskGraphPath } = await createSmokeProject();
    const runId = "run-gui-smoke-failed-verification";
    const verificationCommand =
      "node -e \"console.error('gui smoke verification failed'); process.exit(7)\"";

    try {
      const startResult = await startRun({
        projectRoot,
        artifactRoot,
        taskGraphPath,
        taskId: "task-001",
        agentTool: "codex",
        runId,
      });
      expect(startResult.exitCode).toBe(0);

      const finishResult = await finishRun({
        projectRoot,
        artifactRoot,
        taskGraphPath,
        runId,
        status: "auto",
        failureClass: null,
        collectGit: false,
        verifyTest: false,
        verifyLint: false,
        verifyTypecheck: false,
        customVerificationCommands: [{ type: "custom", command: verificationCommand }],
        changedFiles: ["src/broken.ts"],
        notes: ["verification failed"],
      });

      expect(finishResult.exitCode).toBe(1);
      expect(finishResult.stdout).toContain("Running verification...");
      expect(finishResult.stdout).toContain(`Plan2Agent run finished: ${runId}`);
      expect(finishResult.stdout).toContain("- status: failed");
      expect(finishResult.stdout).toContain("task-001 status is now blocked");

      const graphAfterFinish = await readJson<{
        tasks: Array<{ id: string; status: string; blockReason?: string }>;
      }>(taskGraphPath);
      expect(graphAfterFinish.tasks.find((task) => task.id === "task-001")).toMatchObject({
        status: "blocked",
        blockReason: "verification_failed",
      });

      const run = await readJson<{
        status: string;
        changedFiles: string[];
        failure: { class: string };
        verification: Array<{
          status: string;
          exitCode: number | null;
          stderrTail: string | null;
        }>;
      }>(path.join(projectRoot, "runs", `${runId}.json`));
      expect(run).toMatchObject({
        status: "failed",
        changedFiles: ["src/broken.ts"],
        failure: { class: "verification_failed" },
      });
      expect(run.verification).toMatchObject([{ status: "failed", exitCode: 7 }]);
      expect(run.verification[0]?.stderrTail).toContain("gui smoke verification failed");

      const snapshot = await loadProjectSnapshot(projectRoot);
      expect(snapshot.artifacts[0]?.tasks[0]).toMatchObject({
        id: "task-001",
        status: "blocked",
        blockReason: "verification_failed",
      });
      expect(snapshot.artifacts[0]?.runs[0]).toMatchObject({
        runId,
        status: "failed",
        failure: { class: "verification_failed" },
        verification: [{ status: "failed", exitCode: 7 }],
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("smokes the GUI start and finish lifecycle against real P2A files", async () => {
    const { projectRoot, artifactRoot, taskGraphPath } = await createSmokeProject();
    const runId = "run-gui-smoke-task-001";
    const verificationCommand = "node -e \"console.log('gui smoke verification')\"";

    try {
      const startResult = await startRun({
        projectRoot,
        artifactRoot,
        taskGraphPath,
        taskId: "task-001",
        agentTool: "codex",
        runId,
      });

      expect(startResult.exitCode).toBe(0);
      expect(startResult.stdout).toContain(`Plan2Agent run started: ${runId}`);
      expect(startResult.followUpCommands.map((command) => command.id)).toEqual([
        "resume",
        "status",
        "finish",
        "review",
      ]);
      expect(startResult.followUpCommands.find((command) => command.id === "resume")?.command).toContain(
        `p2a.mjs execute resume`,
      );

      const graphAfterStart = await readJson<{ tasks: Array<{ id: string; status: string }> }>(
        taskGraphPath,
      );
      expect(graphAfterStart.tasks.find((task) => task.id === "task-001")?.status).toBe(
        "in_progress",
      );

      const finishResult = await finishRun({
        projectRoot,
        artifactRoot,
        taskGraphPath,
        runId,
        status: "finished",
        failureClass: null,
        collectGit: false,
        verifyTest: false,
        verifyLint: false,
        verifyTypecheck: false,
        customVerificationCommands: [{ type: "custom", command: verificationCommand }],
        changedFiles: ["src/service.ts"],
        notes: ["gui smoke done"],
      });

      expect(finishResult.exitCode).toBe(0);
      expect(finishResult.stdout).toContain("Running verification...");
      expect(finishResult.stdout).toContain(`Plan2Agent run finished: ${runId}`);
      expect(finishResult.stdout).toContain("task-001 status is now done");
      expect(finishResult.followUpCommands.map((command) => command.id)).toEqual([
        "status",
        "review",
      ]);

      const graphAfterFinish = await readJson<{ tasks: Array<{ id: string; status: string }> }>(
        taskGraphPath,
      );
      expect(graphAfterFinish.tasks.find((task) => task.id === "task-001")?.status).toBe("done");

      const run = await readJson<{
        status: string;
        changedFiles: string[];
        verification: Array<{
          type: string;
          command: string;
          status: string;
          exitCode: number | null;
          stdoutTail: string | null;
          source: string;
        }>;
        notes: string[];
      }>(path.join(projectRoot, "runs", `${runId}.json`));
      expect(run).toMatchObject({
        status: "finished",
        changedFiles: ["src/service.ts"],
        notes: ["gui smoke done"],
      });
      expect(run.verification).toMatchObject([
        {
          type: "custom",
          command: verificationCommand,
          status: "passed",
          exitCode: 0,
          source: "command",
        },
      ]);
      expect(run.verification[0]?.stdoutTail).toContain("gui smoke verification");

      const snapshot = await loadProjectSnapshot(projectRoot);
      expect(snapshot.state).toBe("execution_ready");
      expect(snapshot.artifacts[0]?.tasks[0]).toMatchObject({
        id: "task-001",
        status: "done",
        latestRunId: runId,
      });
      expect(snapshot.artifacts[0]?.runs[0]).toMatchObject({
        runId,
        taskId: "task-001",
        status: "finished",
        changedFiles: ["src/service.ts"],
        verification: [{ type: "custom", status: "passed", exitCode: 0 }],
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 30000);
});
