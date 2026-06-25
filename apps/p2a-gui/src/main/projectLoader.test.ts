import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProjectSnapshot } from "./projectLoader";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

describe("loadProjectSnapshot", () => {
  it("detects a ready artifact root from the e2e fixture", async () => {
    const snapshot = await loadProjectSnapshot(
      path.join(repoRoot, "fixtures/_e2e/webhook-api-service"),
    );

    expect(snapshot.state).toBe("execution_ready");
    expect(snapshot.projectId).toBe("webhook-api-service");
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]?.taskCounts).toMatchObject({
      total: 4,
      ready: 1,
      todo: 4,
    });
    expect(snapshot.artifacts[0]?.tasks).toHaveLength(4);
    expect(snapshot.artifacts[0]?.tasks[0]).toMatchObject({
      id: "task-001",
      ready: true,
      targetArea: "service-scaffold",
    });
    expect(snapshot.artifacts[0]?.tasks[1]).toMatchObject({
      id: "task-002",
      ready: false,
      dependencies: ["task-001"],
    });
    expect(snapshot.artifacts[0]?.gates.every((gate) => gate.state === "present")).toBe(true);
    expect(snapshot.commands.some((command) => command.id === "validate")).toBe(true);
    expect(snapshot.onboarding).toMatchObject({
      stage: "execution_ready",
      primaryAction: {
        id: "inspect_tasks",
        command: null,
        impact: "guidance_only",
      },
    });
    expect(snapshot.onboarding.secondaryActions.map((action) => action.id)).toEqual([
      "open_terminal",
      "validate_artifacts",
    ]);
  });

  it("returns setup guidance for a folder without P2A markers", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-no-markers-"));
    try {
      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("no_p2a");
      expect(snapshot.artifacts).toHaveLength(0);
      expect(snapshot.commands).toMatchObject([
        {
          id: "setup",
        },
      ]);
      expect(snapshot.onboarding).toMatchObject({
        stage: "install_p2a",
        primaryAction: {
          id: "install_p2a",
          impact: "writes_project",
        },
      });
      expect(snapshot.onboarding.primaryAction.command).toContain("scaffold");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns import guidance for an installed empty project", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-empty-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({ schema_version: "p2a.manifest.v1" }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("installed_empty");
      expect(snapshot.onboarding).toMatchObject({
        stage: "import_plan",
        primaryAction: {
          id: "import_plan",
          impact: "writes_project",
        },
      });
      expect(snapshot.onboarding.primaryAction.command).toContain("--artifacts <artifact-root>");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("marks an artifact root broken when an existing schema artifact is invalid", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-"));
    try {
      await mkdir(path.join(tempRoot, "gate-c-task-graph"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "gate-c-task-graph/task-graph.json"),
        JSON.stringify({
          schema_version: "p2a.task_graph.v1",
          projectId: "invalid-artifact",
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);
      const taskGraphValidation = snapshot.artifacts[0]?.validations.find(
        (validation) => validation.id === "task-graph",
      );

      expect(snapshot.state).toBe("broken_install");
      expect(taskGraphValidation?.status).toBe("invalid");
      expect(snapshot.onboarding).toMatchObject({
        stage: "repair_validate",
        primaryAction: {
          id: "validate_artifacts",
          impact: "reads_project",
        },
      });
      expect(snapshot.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("links run index rows to workbench tasks", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-runs-"));
    try {
      await mkdir(path.join(tempRoot, "gate-c-task-graph"), { recursive: true });
      await mkdir(path.join(tempRoot, "runs"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "gate-c-task-graph/task-graph.json"),
        JSON.stringify({
          schema_version: "p2a.task_graph.v1",
          projectId: "run-linked-project",
          version: "1",
          sourceSpec: "gate-b-spec/spec.json",
          tasks: [
            {
              id: "task-001",
              title: "Implement cache API",
              description: "Add cache get and set operations.",
              status: "done",
              dependencies: [],
              acceptanceCriteria: ["Cache get and set operations are covered"],
              targetArea: "cache-api",
              suggestedAgentPrompt: "Implement cache get and set operations.",
              sourceSpecRefs: ["implementation.interfaces"],
            },
          ],
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-index.json"),
        JSON.stringify({
          schema_version: "p2a.run_index.v1",
          projectId: "run-linked-project",
          runs: [
            {
              runId: "run-task-001-a",
              taskId: "task-001",
              iterationId: "iteration-1",
              status: "finished",
              agentTool: "codex",
              workspaceRef: tempRoot,
              taskGraphRef: "gate-c-task-graph/task-graph.json",
              runRef: "runs/run-task-001-a.json",
              startedAt: "2026-06-23T01:00:00.000Z",
              finishedAt: "2026-06-23T01:10:00.000Z",
            },
          ],
          tasks: [
            {
              taskId: "task-001",
              runIds: ["run-task-001-a"],
              latestRunId: "run-task-001-a",
            },
          ],
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-task-001-a.json"),
        JSON.stringify({
          schema_version: "p2a.run.v1",
          runId: "run-task-001-a",
          projectId: "run-linked-project",
          taskId: "task-001",
          taskTitle: "Implement cache API",
          iterationId: "iteration-1",
          sourceLayout: "iteration",
          taskGraphRef: "gate-c-task-graph/task-graph.json",
          sourceSpecRef: "gate-b-spec/spec.json",
          agentTool: "codex",
          workspaceRef: tempRoot,
          workspacePath: tempRoot,
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
          startedAt: "2026-06-23T01:00:00.000Z",
          updatedAt: "2026-06-23T01:10:00.000Z",
          finishedAt: "2026-06-23T01:10:00.000Z",
          changedFiles: ["src/cache.ts"],
          verification: [
            {
              type: "test",
              command: "npm test",
              status: "passed",
              exitCode: 0,
              durationMs: 1200,
              startedAt: "2026-06-23T01:08:00.000Z",
              finishedAt: "2026-06-23T01:08:01.200Z",
              stdoutTail: "passed",
              stderrTail: null,
              source: "command",
            },
          ],
          notes: ["done"],
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-task-001-a.orchestration.json"),
        JSON.stringify({
          schema_version: "p2a.orchestration_plan.v1",
          planId: "orch-test-task-001",
          projectId: "run-linked-project",
          taskId: "task-001",
          taskTitle: "Implement cache API",
          mode: "solo_monitor",
          createdAt: "2026-06-23T01:00:00.000Z",
          roles: [
            {
              roleId: "owner",
              role: "lead",
              agentTool: "manual",
              scope: "Own the run lifecycle.",
            },
            {
              roleId: "implementer",
              role: "contributor",
              agentTool: "codex",
              scope: "Implement the cache API.",
            },
            {
              roleId: "monitor",
              role: "monitor",
              agentTool: "manual",
              scope: "Check the monitor gate.",
            },
          ],
          handoffPrompts: [
            {
              roleId: "implementer",
              command: "codex",
              prompt: "Implement cache get and set operations.",
            },
          ],
          monitorGate: {
            required: true,
            verdictPath: "run-task-001-a.monitor-verdict.json",
          },
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-task-001-a.orchestration-runtime.json"),
        JSON.stringify({
          schema_version: "p2a.orchestration_runtime.v1",
          runtimeId: "runtime-run-task-001-a",
          projectId: "run-linked-project",
          taskId: "task-001",
          taskTitle: "Implement cache API",
          runId: "run-task-001-a",
          planId: "orch-test-task-001",
          mode: "solo_monitor",
          sourcePlanRef: "run-task-001-a.orchestration.json",
          createdAt: "2026-06-23T01:00:00.000Z",
          updatedAt: "2026-06-23T01:02:00.000Z",
          sharedMentalModel: {
            objective: "Complete task-001: Implement cache API",
            currentState: "Run is started.",
            constraints: ["Use official CLI sessions only."],
            acceptanceCriteria: ["Cache get and set operations are covered"],
            roleAssignments: [
              {
                roleId: "owner",
                role: "lead",
                agentTool: "manual",
                scope: "Own the run lifecycle.",
                status: "active",
              },
              {
                roleId: "implementer",
                role: "contributor",
                agentTool: "codex",
                scope: "Implement the cache API.",
                status: "active",
              },
              {
                roleId: "monitor",
                role: "monitor",
                agentTool: "manual",
                scope: "Check the monitor gate.",
                status: "pending",
              },
            ],
            decisions: [],
            openQuestions: [],
            risks: ["monitor_required"],
          },
          communicationLog: [
            {
              eventId: "event-1-handoff-implementer",
              createdAt: "2026-06-23T01:00:00.000Z",
              roleId: "implementer",
              role: "contributor",
              agentTool: "codex",
              type: "handoff",
              summary: "Handoff prepared for implementer",
              detail: "Implement cache get and set operations.",
              linkedRoleId: null,
              requiresOwnerAction: false,
            },
          ],
          status: {
            phase: "running",
            blocked: false,
            needsUserDecision: false,
            lastEventId: "event-1-handoff-implementer",
          },
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.artifacts[0]?.runCount).toBe(1);
      expect(snapshot.artifacts[0]?.runs[0]).toMatchObject({
        runId: "run-task-001-a",
        taskId: "task-001",
        status: "finished",
      });
      expect(snapshot.artifacts[0]?.tasks[0]).toMatchObject({
        id: "task-001",
        latestRunId: "run-task-001-a",
        runIds: ["run-task-001-a"],
      });
      expect(snapshot.artifacts[0]?.runs[0]).toMatchObject({
        changedFiles: ["src/cache.ts"],
        verification: [
          {
            type: "test",
            status: "passed",
            exitCode: 0,
          },
        ],
        notes: ["done"],
        orchestration: {
          planId: "orch-test-task-001",
          runtimeId: "runtime-run-task-001-a",
          mode: "solo_monitor",
          phase: "running",
          monitorRequired: true,
          runtimePath: "runs/run-task-001-a.orchestration-runtime.json",
          eventCount: 1,
          next: {
            supervisedOnly: true,
            startsProcess: false,
            nextRole: {
              roleId: "implementer",
              command: "codex",
            },
          },
        },
      });
      expect(snapshot.artifacts[0]?.runs[0]?.orchestration?.roles).toMatchObject([
        { roleId: "owner", status: "active", command: null },
        { roleId: "implementer", status: "active", command: "codex" },
        { roleId: "monitor", status: "pending", command: null },
      ]);
      expect(
        snapshot.artifacts[0]?.runs[0]?.orchestration?.roles.find(
          (role) => role.roleId === "implementer",
        )?.prompt,
      ).toContain("Supervision boundary");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
