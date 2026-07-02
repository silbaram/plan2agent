import { cp, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
    expect(snapshot.doctor).toBeNull();
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

  it("marks an active iteration close-ready when every task is done", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-close-ready-"));
    try {
      const iterationRoot = path.join(tempRoot, "iterations", "v1-mvp");
      await mkdir(path.join(iterationRoot, "gate-c-task-graph"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "current-spec.json"),
        JSON.stringify({
          project_id: "close-ready-project",
          active_iteration: "v1-mvp",
        }),
      );
      await writeFile(
        path.join(iterationRoot, "gate-c-task-graph", "task-graph.json"),
        JSON.stringify({
          schema_version: "p2a.task_graph.v1",
          projectId: "close-ready-project",
          version: "v1-mvp",
          sourceSpec: "gate-b-spec/spec.json",
          tasks: [
            {
              id: "task-001",
              title: "Finish the cycle",
              description: "Close-ready fixture task.",
              status: "done",
              dependencies: [],
              acceptanceCriteria: ["The task is done"],
              targetArea: "cycle",
              suggestedAgentPrompt: "Finish the cycle.",
              sourceSpecRefs: ["implementation"],
            },
          ],
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("cycle_close_ready");
      expect(snapshot.artifacts[0]).toMatchObject({
        activeIteration: "v1-mvp",
        taskCounts: {
          total: 1,
          ready: 0,
          todo: 0,
          done: 1,
        },
      });
      expect(snapshot.onboarding).toMatchObject({
        stage: "cycle_close_ready",
        primaryAction: {
          id: "close_iteration",
          impact: "writes_project",
        },
      });
      expect(snapshot.onboarding.primaryAction.command).toContain("p2a_iteration.mjs close");
      expect(snapshot.onboarding.secondaryActions.map((action) => action.id)).toEqual([
        "inspect_tasks",
        "validate_artifacts",
        "open_iteration",
        "add_maintenance",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns setup guidance for a folder without P2A markers", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-no-markers-"));
    try {
      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("no_p2a");
      expect(snapshot.doctor).toBeNull();
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
      expect(snapshot.onboarding.primaryAction.command).toContain("scripts/p2a_handoff.mjs");
      expect(snapshot.onboarding.primaryAction.command).not.toContain("/path/to/plan2agent");
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
      expect(snapshot.onboarding.primaryAction.command).toContain("scripts/p2a_handoff.mjs");
      expect(snapshot.onboarding.primaryAction.command).not.toContain("/path/to/plan2agent");
      expect(snapshot.doctor).toMatchObject({
        status: "fail",
        projectState: "installed_empty",
      });
      expect(snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("p2a_doctor fail"))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes proposal feedback files from the harness proposal queue", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-proposals-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent", "proposals"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({ schema_version: "p2a.manifest.v1" }),
      );
      await writeFile(
        path.join(tempRoot, ".plan2agent/proposals/p2a-runs-create-isolation-workspace-check.json"),
        JSON.stringify({
          schema_version: "p2a.skill_proposal.v1",
          proposalId: "p2a-runs-create-isolation-workspace-check",
          sourceRunId: "run-20260629-task-14-search-tests",
          problem: "p2a_runs start validates a fresh worktree before creating it.",
          evidence: ["The run failed before git worktree creation."],
          recommendedChange: "Create the worktree before checking workspace existence.",
          targetFiles: [".plan2agent/scripts/p2a_runs.mjs", ".agents/skills/p2a-dev-execution/SKILL.md"],
          risk: "low",
          status: "proposed",
          note: "Repeated workflow issue.",
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.proposals).toHaveLength(1);
      expect(snapshot.proposals[0]).toMatchObject({
        proposalId: "p2a-runs-create-isolation-workspace-check",
        sourceRunId: "run-20260629-task-14-search-tests",
        status: "proposed",
        risk: "low",
        evidenceCount: 1,
        relativePath: ".plan2agent/proposals/p2a-runs-create-isolation-workspace-check.json",
      });
      expect(snapshot.diagnostics.some((diagnostic) => diagnostic.message.includes("proposal feedback"))).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes update preview and apply reports", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-update-reports-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent", "update-reports"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({ schema_version: "p2a.manifest.v1" }),
      );
      await writeFile(
        path.join(tempRoot, ".plan2agent/update-reports/update-preview.json"),
        JSON.stringify({
          schema_version: "p2a.upgrade_dry_run.v1",
          generatedAt: "2026-06-23T01:00:00.000Z",
          command: "update",
          status: "changes",
          summary: {
            unchanged: 10,
            missing: 1,
            wouldUpdate: 2,
            manualReview: 1,
            conflicts: 0,
            errors: 0,
          },
          failures: [],
        }),
      );
      await writeFile(
        path.join(tempRoot, ".plan2agent/update-reports/update-apply.json"),
        JSON.stringify({
          schema_version: "p2a.upgrade_apply.v1",
          appliedAt: "2026-06-23T01:10:00.000Z",
          command: "update",
          status: "applied",
          preview: {
            summary: {
              unchanged: 10,
              missing: 0,
              wouldUpdate: 1,
              manualReview: 0,
              conflicts: 0,
              errors: 0,
            },
          },
          blockers: [],
          applied: {
            files: [".plan2agent/scripts/p2a_eval.mjs"],
          },
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.updateReports).toMatchObject([
        {
          command: "update",
          kind: "apply",
          status: "applied",
          appliedFiles: 1,
          changedItems: 1,
        },
        {
          command: "update",
          kind: "preview",
          status: "changes",
          appliedFiles: 0,
          changedItems: 4,
        },
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires iteration init for scaffold projects with greenfield Gate artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-scaffold-greenfield-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent", "artifacts"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({
          schema_version: "p2a.handoff.v1",
          provenance: { mode: "scaffold" },
        }),
      );
      await cp(
        path.join(repoRoot, "fixtures/_e2e/webhook-api-service"),
        path.join(tempRoot, ".plan2agent/artifacts/webhook-api-service"),
        { recursive: true },
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("iteration_init_required");
      expect(snapshot.artifacts[0]).toMatchObject({
        requiresIterationInit: true,
        taskCounts: { ready: 1 },
      });
      expect(snapshot.onboarding).toMatchObject({
        stage: "iteration_init_required",
        primaryAction: {
          id: "init_iteration",
          impact: "writes_project",
        },
      });
      expect(snapshot.onboarding.primaryAction.command).toContain("p2a_iteration.mjs init");
      expect(snapshot.onboarding.primaryAction.command).toContain(
        ".plan2agent/artifacts/webhook-api-service",
      );
      expect(snapshot.commands.some((command) => command.id === "init_iteration")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("marks scaffold artifacts broken when iteration metadata is incomplete", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-scaffold-partial-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent", "artifacts"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({
          schema_version: "p2a.handoff.v1",
          provenance: { mode: "scaffold" },
        }),
      );
      const artifactRoot = path.join(tempRoot, ".plan2agent/artifacts/webhook-api-service");
      await cp(path.join(repoRoot, "fixtures/_e2e/webhook-api-service"), artifactRoot, {
        recursive: true,
      });
      await mkdir(path.join(artifactRoot, "iterations"), { recursive: true });

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("broken_install");
      expect(snapshot.artifacts[0]).toMatchObject({
        requiresIterationInit: false,
      });
      expect(
        snapshot.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("Iteration layout is incomplete"),
        ),
      ).toBe(true);
      expect(snapshot.commands.some((command) => command.id === "init_iteration")).toBe(false);
      expect(snapshot.onboarding.stage).toBe("repair_validate");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects incomplete scaffold artifacts after greenfield gates have been moved", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-scaffold-moved-partial-"));
    try {
      await mkdir(path.join(tempRoot, ".plan2agent", "artifacts"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".plan2agent/manifest.json"),
        JSON.stringify({
          schema_version: "p2a.handoff.v1",
          provenance: { mode: "scaffold" },
        }),
      );
      const artifactRoot = path.join(tempRoot, ".plan2agent/artifacts/webhook-api-service");
      const iterationRoot = path.join(artifactRoot, "iterations", "v1-mvp");
      await cp(path.join(repoRoot, "fixtures/_e2e/webhook-api-service"), artifactRoot, {
        recursive: true,
      });
      await mkdir(iterationRoot, { recursive: true });
      await Promise.all(
        ["gate-a-intake", "gate-b-spec", "gate-c-task-graph", "gate-d-review"].map((gate) =>
          rename(path.join(artifactRoot, gate), path.join(iterationRoot, gate)),
        ),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.state).toBe("broken_install");
      expect(snapshot.artifacts[0]).toMatchObject({
        requiresIterationInit: false,
      });
      expect(
        snapshot.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("Iteration layout is incomplete"),
        ),
      ).toBe(true);
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
              runRef: "run-task-001-a.json",
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
        runRef: "runs/run-task-001-a.json",
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

  it("does not attach a root memory digest to an unrelated artifact", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-memory-digest-"));
    try {
      await mkdir(path.join(tempRoot, "gate-c-task-graph"), { recursive: true });
      await mkdir(path.join(tempRoot, "runs"), { recursive: true });
      await mkdir(path.join(tempRoot, ".plan2agent"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "gate-c-task-graph/task-graph.json"),
        JSON.stringify({
          schema_version: "p2a.task_graph.v1",
          projectId: "memory-digest-project",
          version: "1",
          sourceSpec: "gate-b-spec/spec.json",
          tasks: [
            {
              id: "task-001",
              title: "Track digest scope",
              description: "Keep memory digest scope artifact-specific.",
              status: "done",
              dependencies: [],
              acceptanceCriteria: ["Digest scope is artifact-specific"],
              targetArea: "gui",
              suggestedAgentPrompt: "Track digest scope.",
              sourceSpecRefs: ["implementation.gui"],
            },
          ],
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-index.json"),
        JSON.stringify({
          schema_version: "p2a.run_index.v1",
          projectId: "memory-digest-project",
          runs: [
            {
              runId: "run-memory-digest-local",
              taskId: "task-001",
              iterationId: "iteration-1",
              status: "finished",
              agentTool: "codex",
              workspaceRef: tempRoot,
              taskGraphRef: "gate-c-task-graph/task-graph.json",
              runRef: "run-memory-digest-local.json",
              startedAt: "2026-06-23T01:00:00.000Z",
              finishedAt: "2026-06-23T01:10:00.000Z",
            },
          ],
          tasks: [
            {
              taskId: "task-001",
              runIds: ["run-memory-digest-local"],
              latestRunId: "run-memory-digest-local",
            },
          ],
        }),
      );
      await writeFile(
        path.join(tempRoot, "runs/run-memory-digest-local.json"),
        JSON.stringify({
          changedFiles: [],
          verification: [],
          notes: [],
        }),
      );
      await writeFile(
        path.join(tempRoot, ".plan2agent/memory-digest.json"),
        JSON.stringify({
          schema_version: "p2a.memory_digest.v1",
          context: {
            sourceKind: "artifacts",
            sourcePath: ".plan2agent/artifacts/other-project",
            runsDir: ".plan2agent/artifacts/other-project/runs",
          },
          runs: {
            total: 99,
            failedOrBlocked: 99,
            verificationFailures: 99,
            verificationGaps: 99,
          },
          proposals: {
            total: 99,
            uncoveredCandidateRuns: ["run-other"],
          },
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.artifacts[0]?.memoryDigest).toMatchObject({
        source: "local",
        sourcePath: null,
        totalRuns: 1,
        failedOrBlocked: 0,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes memory history and search reports for an artifact", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-loader-memory-reports-"));
    try {
      await mkdir(path.join(tempRoot, "gate-c-task-graph"), { recursive: true });
      await mkdir(path.join(tempRoot, ".plan2agent"), { recursive: true });
      await writeFile(
        path.join(tempRoot, "gate-c-task-graph/task-graph.json"),
        JSON.stringify({
          schema_version: "p2a.task_graph.v1",
          projectId: "memory-report-project",
          version: "1",
          sourceSpec: "gate-b-spec/spec.json",
          tasks: [],
        }),
      );
      await writeFile(
        path.join(tempRoot, "memory-history.json"),
        JSON.stringify({
          schema_version: "p2a.memory_history.v1",
          generatedAt: "2026-07-02T01:00:00.000Z",
          context: {
            sourceKind: "artifacts",
            sourcePath: ".",
            runsDir: "runs",
          },
          summary: {
            totalEvents: 3,
            visibleEvents: 3,
            localEvents: 2,
            remoteEvents: 1,
            failedOrBlockedRuns: 1,
          },
          timeline: [
            {
              occurredAt: "2026-07-02T01:01:00.000Z",
            },
          ],
        }),
      );
      await writeFile(
        path.join(tempRoot, "memory-search.json"),
        JSON.stringify({
          schema_version: "p2a.memory_search.v1",
          generatedAt: "2026-07-02T01:02:00.000Z",
          query: {
            text: "webhook",
          },
          context: {
            sourceKind: "artifacts",
            sourcePath: ".",
            runsDir: "runs",
          },
          summary: {
            total: 4,
            byType: {
              DOCUMENT_SNAPSHOT: 1,
              DOCUMENT_CHUNK: 2,
              RUN_RECORD: 1,
            },
          },
          results: [],
        }),
      );

      const snapshot = await loadProjectSnapshot(tempRoot);

      expect(snapshot.artifacts[0]?.memoryHistory).toMatchObject({
        sourcePath: "memory-history.json",
        totalEvents: 3,
        visibleEvents: 3,
        remoteEvents: 1,
        failedOrBlockedRuns: 1,
        latestEventAt: "2026-07-02T01:01:00.000Z",
      });
      expect(snapshot.artifacts[0]?.memorySearch).toMatchObject({
        sourcePath: "memory-search.json",
        query: "webhook",
        totalResults: 4,
        documentResults: 3,
        runResults: 1,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
