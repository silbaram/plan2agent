import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  requireActiveProjectRootMatch,
  scopeArtifactReadRequest,
  scopeExecutionFinishRunRequest,
  scopeExecutionStartRunRequest,
  scopeOrchestrationMarkRoleRequest,
  scopeTerminalStartRequest,
} from "./activeProjectScope";

describe("active project scope", () => {
  it("accepts requests for the active project root", () => {
    const activeRoot = path.resolve("/tmp/p2a-active");

    expect(requireActiveProjectRootMatch(activeRoot, activeRoot)).toBe(activeRoot);
    expect(
      scopeArtifactReadRequest(activeRoot, {
        projectRoot: activeRoot,
        relativePath: "gate-b-spec/spec.json",
      }),
    ).toEqual({
      projectRoot: activeRoot,
      relativePath: "gate-b-spec/spec.json",
    });
  });

  it("rejects requests for another project root", () => {
    const activeRoot = path.resolve("/tmp/p2a-active");

    expect(() => {
      scopeArtifactReadRequest(activeRoot, {
        projectRoot: path.join(activeRoot, "nested-project"),
        relativePath: "gate-b-spec/spec.json",
      });
    }).toThrow("project root must match the active project root");

    expect(() => {
      scopeArtifactReadRequest(activeRoot, {
        projectRoot: "/tmp/other-project",
        relativePath: "gate-b-spec/spec.json",
      });
    }).toThrow("project root must stay inside the active project root");
  });

  it("keeps terminal cwd inside the active project", () => {
    const activeRoot = path.resolve("/tmp/p2a-active");

    expect(
      scopeTerminalStartRequest(activeRoot, {
        cwd: "packages/app",
        agentTool: "codex",
        cols: 100,
        rows: 28,
        taskId: null,
      }).cwd,
    ).toBe(path.join(activeRoot, "packages/app"));

    expect(() => {
      scopeTerminalStartRequest(activeRoot, {
        cwd: "../outside",
        agentTool: "codex",
        cols: 100,
        rows: 28,
        taskId: null,
      });
    }).toThrow("terminal cwd must stay inside the active project root");
  });

  it("scopes execution paths to the active project", () => {
    const activeRoot = path.resolve("/tmp/p2a-active");
    const startRequest = scopeExecutionStartRunRequest(activeRoot, {
      projectRoot: activeRoot,
      artifactRoot: "artifacts/demo",
      taskGraphPath: "gate-c-task-graph/task-graph.json",
      taskId: "task-001",
      agentTool: "codex",
    });

    expect(startRequest.artifactRoot).toBe(path.join(activeRoot, "artifacts/demo"));
    expect(startRequest.taskGraphPath).toBe(
      path.join(activeRoot, "gate-c-task-graph/task-graph.json"),
    );

    expect(() => {
      scopeExecutionFinishRunRequest(activeRoot, {
        projectRoot: activeRoot,
        artifactRoot: "/tmp/other-artifacts",
        taskGraphPath: null,
        runId: "run-task-001",
        status: "auto",
        failureClass: null,
        collectGit: false,
        verifyTest: false,
        verifyLint: false,
        verifyTypecheck: false,
        customVerificationCommands: [],
        changedFiles: [],
        notes: [],
      });
    }).toThrow("artifact root must stay inside the active project root");
  });

  it("scopes orchestration role updates to the active project", () => {
    const activeRoot = path.resolve("/tmp/p2a-active");
    const request = scopeOrchestrationMarkRoleRequest(activeRoot, {
      projectRoot: activeRoot,
      runtimePath: ".plan2agent/runs/run-task-001.orchestration-runtime.json",
      roleId: "implementer",
      roleStatus: "complete",
    });

    expect(request.runtimePath).toBe(
      path.join(activeRoot, ".plan2agent/runs/run-task-001.orchestration-runtime.json"),
    );

    expect(() => {
      scopeOrchestrationMarkRoleRequest(activeRoot, {
        projectRoot: activeRoot,
        runtimePath: "../run-task-001.orchestration-runtime.json",
        roleId: "implementer",
        roleStatus: "complete",
      });
    }).toThrow("runtime path must stay inside the active project root");
  });
});
