import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildOperationalActionCommand,
  runOperationalAction,
} from "./operationalActions";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-operational-"));
  const scriptsDir = path.join(projectRoot, ".plan2agent", "scripts");
  const artifactRoot = path.join(projectRoot, ".plan2agent", "artifacts", "demo");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    path.join(scriptsDir, "p2a.mjs"),
    "console.log(JSON.stringify(process.argv.slice(2)))\n",
  );
  return { projectRoot, artifactRoot };
}

async function createEvalSmokeProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-operational-eval-"));
  const artifactRoot = path.join(projectRoot, ".plan2agent", "artifacts", "demo");
  const iterationRoot = path.join(artifactRoot, "iterations", "v1");
  const taskGraphRef = "iterations/v1/gate-c-task-graph/task-graph.json";
  const sourceSpecRef = "iterations/v1/gate-b-spec/spec.json";
  const runId = "run-gui-eval-task-001";
  const startedAt = "2026-07-02T00:00:00.000Z";
  const finishedAt = "2026-07-02T00:01:00.000Z";

  await mkdir(path.join(projectRoot, ".plan2agent"), { recursive: true });
  await cp(path.join(repoRoot, "scripts"), path.join(projectRoot, ".plan2agent", "scripts"), {
    recursive: true,
  });
  await cp(path.join(repoRoot, "schemas"), path.join(projectRoot, ".plan2agent", "schemas"), {
    recursive: true,
  });
  await mkdir(path.join(iterationRoot, "gate-c-task-graph"), { recursive: true });
  await mkdir(path.join(artifactRoot, "runs"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".plan2agent", "manifest.json"),
    formatJson({ schema_version: "p2a.manifest.v1" }),
  );
  await writeFile(
    path.join(artifactRoot, "current-spec.json"),
    formatJson({
      schema_version: "p2a.current_spec.v1",
      project_id: "gui-eval-project",
      active_iteration: "v1",
      effective_spec_ref: null,
      gate_b: { approved: true },
      gate_c: { approved: true },
      open_decisions: [],
    }),
  );
  await writeFile(
    path.join(iterationRoot, "gate-c-task-graph", "task-graph.json"),
    formatJson({
      schema_version: "p2a.task_graph.v1",
      projectId: "gui-eval-project",
      version: "v1",
      sourceSpec: sourceSpecRef,
      tasks: [
        {
          id: "task-001",
          title: "Verify eval operational action",
          description: "Exercise eval generation from the GUI operational action.",
          status: "done",
          dependencies: [],
          acceptanceCriteria: ["The eval operational action records verification evidence."],
          targetArea: "gui-operational-actions",
          suggestedAgentPrompt: "Record verification evidence for the eval operational action.",
          sourceSpecRefs: ["product.success_criteria"],
        },
      ],
    }),
  );
  await writeFile(
    path.join(artifactRoot, "runs", "run-index.json"),
    formatJson({
      schema_version: "p2a.run_index.v1",
      projectId: "gui-eval-project",
      runs: [
        {
          runId,
          taskId: "task-001",
          iterationId: "v1",
          status: "finished",
          agentTool: "codex",
          workspaceRef: ".",
          taskGraphRef,
          runRef: `runs/${runId}.json`,
          startedAt,
          finishedAt,
        },
      ],
      tasks: [
        {
          taskId: "task-001",
          runIds: [runId],
          latestRunId: runId,
        },
      ],
    }),
  );
  await writeFile(
    path.join(artifactRoot, "runs", `${runId}.json`),
    formatJson({
      schema_version: "p2a.run.v1",
      runId,
      projectId: "gui-eval-project",
      taskId: "task-001",
      taskTitle: "Verify eval operational action",
      iterationId: "v1",
      sourceLayout: "iteration",
      taskGraphRef,
      sourceSpecRef,
      agentTool: "codex",
      workspaceRef: ".",
      workspacePath: projectRoot,
      isolation: {
        mode: "none",
        branch: null,
        worktree: null,
        baseRef: null,
        created: false,
        createCommand: null,
        createExitCode: null,
        createOutputTail: null,
      },
      status: "finished",
      startedAt,
      updatedAt: finishedAt,
      finishedAt,
      changedFiles: ["apps/p2a-gui/src/main/operationalActions.ts"],
      verification: [
        {
          type: "test",
          command: "npm test",
          status: "passed",
          exitCode: 0,
          durationMs: 1000,
          startedAt,
          finishedAt,
          stdoutTail: "eval operational action verification evidence",
          stderrTail: null,
          source: "command",
        },
      ],
      notes: ["eval operational action records verification evidence"],
    }),
  );

  return { projectRoot, artifactRoot, runId };
}

describe("operational actions", () => {
  it("builds update preview and apply commands through p2a.mjs", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "update_preview",
        }),
      ).toMatchObject({
        cwd: projectRoot,
        args: ["update", "--dry-run"],
        displayCommand: "node .plan2agent/scripts/p2a.mjs update --dry-run",
      });

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "update_apply",
        }).displayCommand,
      ).toBe("node .plan2agent/scripts/p2a.mjs update --apply");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("builds eval generate, analyze, and digest commands for the active artifact", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_generate",
        }),
      ).toMatchObject({
        args: [
          "eval",
          "generate",
          "--artifacts",
          ".plan2agent/artifacts/demo",
        ],
        displayCommand:
          "node .plan2agent/scripts/p2a.mjs eval generate --artifacts .plan2agent/artifacts/demo",
      });

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_analyze",
        }).args,
      ).toEqual([
        "eval",
        "analyze",
        "--artifacts",
        ".plan2agent/artifacts/demo",
        "--output",
        ".plan2agent/artifacts/demo/eval/analysis.json",
      ]);

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_digest",
        }).args,
      ).toEqual([
        "eval",
        "digest",
        "--eval",
        ".plan2agent/artifacts/demo/eval",
        "--output",
        ".plan2agent/artifacts/demo/eval/eval-digest.json",
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects eval actions without an artifact root inside the project", async () => {
    const { projectRoot } = await createProject();
    try {
      expect(() =>
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot: null,
          action: "eval_generate",
        }),
      ).toThrow("artifact root is required");

      expect(() =>
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot: "/tmp/outside-artifact",
          action: "eval_digest",
        }),
      ).toThrow("artifact root must stay inside project root");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("runs an operational action and captures command output", async () => {
    const { projectRoot } = await createProject();
    try {
      const result = await runOperationalAction({
        projectRoot,
        action: "update_preview",
      });

      expect(result.exitCode).toBe(0);
      expect(result.command).toBe("node .plan2agent/scripts/p2a.mjs update --dry-run");
      expect(result.stdout).toContain("[\"update\",\"--dry-run\"]");
      expect(result.followUpCommands).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("smokes eval generate and digest through the real p2a dispatcher", async () => {
    const { projectRoot, artifactRoot, runId } = await createEvalSmokeProject();
    try {
      const generateResult = await runOperationalAction({
        projectRoot,
        artifactRoot,
        action: "eval_generate",
      });

      expect(generateResult.exitCode).toBe(0);
      expect(generateResult.stdout).toContain("Plan2Agent eval generate");
      expect(
        JSON.parse(
          await readFile(path.join(artifactRoot, "eval", "eval-index.json"), "utf8"),
        ),
      ).toMatchObject({
        schema_version: "p2a.eval_index.v1",
        summary: { grades: 1 },
      });
      expect(
        JSON.parse(
          await readFile(path.join(artifactRoot, "eval", "grades", `${runId}.json`), "utf8"),
        ),
      ).toMatchObject({
        schema_version: "p2a.eval_grade.v1",
        run: { runId },
      });

      const digestResult = await runOperationalAction({
        projectRoot,
        artifactRoot,
        action: "eval_digest",
      });

      expect(digestResult.exitCode).toBe(0);
      expect(digestResult.stdout).toContain("Plan2Agent eval digest");
      expect(
        JSON.parse(
          await readFile(path.join(artifactRoot, "eval", "eval-digest.json"), "utf8"),
        ),
      ).toMatchObject({
        schema_version: "p2a.eval_digest.v1",
        grades: { total: 1 },
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
