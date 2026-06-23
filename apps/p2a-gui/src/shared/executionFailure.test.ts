import { describe, expect, it } from "vitest";
import type { ExecutionCommandResult } from "./ipc";
import { summarizeFinishRunFailure, summarizeStartRunFailure } from "./executionFailure";

function failedResult(overrides: Partial<ExecutionCommandResult>): ExecutionCommandResult {
  return {
    command: "node scripts/p2a_execute.mjs start --task task-001",
    args: [],
    cwd: "/project",
    exitCode: 1,
    stdout: "",
    stderr: "",
    startedAt: "2026-06-23T00:00:00.000Z",
    finishedAt: "2026-06-23T00:00:01.000Z",
    durationMs: 1000,
    ...overrides,
  };
}

describe("summarizeStartRunFailure", () => {
  it("does not summarize successful or missing command results", () => {
    expect(summarizeStartRunFailure(null)).toBeNull();
    expect(summarizeStartRunFailure(failedResult({ exitCode: 0 }))).toBeNull();
  });

  it("classifies a missing p2a_execute script", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr: "p2a_execute does not exist: /project/scripts/p2a_execute.mjs",
        }),
      ),
    ).toMatchObject({
      kind: "script_missing",
      title: "P2A execution script missing",
    });
  });

  it("classifies a not-ready task with incomplete dependencies", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr:
            "p2a execute command failed: task-001 is not ready; status is todo; incomplete dependencies: task-002",
        }),
      ),
    ).toMatchObject({
      kind: "task_not_ready",
      title: "Task is not ready",
    });
  });

  it("classifies an existing run id collision", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr: "p2a run command failed: run already exists: run-gui-task-001",
        }),
      ),
    ).toMatchObject({
      kind: "run_already_exists",
      title: "Run already exists",
    });
  });

  it("classifies artifact validation failures", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr:
            'p2a execute validation failed: task-001 has unknown dependencies: ["task-002"]',
        }),
      ),
    ).toMatchObject({
      kind: "artifact_validation",
      title: "Artifact validation failed",
    });
  });

  it("classifies missing files and folders after validation-specific errors", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr: "project root does not exist: /missing/project",
        }),
      ),
    ).toMatchObject({
      kind: "missing_file",
      title: "Required file or folder missing",
    });
  });

  it("classifies unsupported agent tools", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr: "unsupported agent tool: unknown",
        }),
      ),
    ).toMatchObject({
      kind: "unsupported_agent",
      title: "Unsupported agent tool",
    });
  });

  it("falls back to the first command output line", () => {
    expect(
      summarizeStartRunFailure(
        failedResult({
          stderr: "custom execution failure\nwith more detail",
        }),
      ),
    ).toMatchObject({
      kind: "unknown",
      title: "Start run failed",
      detail: "custom execution failure",
    });
  });
});

describe("summarizeFinishRunFailure", () => {
  it("does not summarize successful or missing command results", () => {
    expect(summarizeFinishRunFailure(null)).toBeNull();
    expect(summarizeFinishRunFailure(failedResult({ exitCode: 0 }))).toBeNull();
  });

  it("classifies failed verification output", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stdout: [
            "Running verification...",
            "Plan2Agent run verification recorded: run-task-001",
            "- custom: failed (npm test)",
            "Finishing run...",
            "- status: failed",
            "- failure: verification_failed retryable=after_fix",
          ].join("\n"),
        }),
      ),
    ).toMatchObject({
      kind: "verification_failed",
      title: "Verification failed",
    });
  });

  it("classifies a missing failure class", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stderr:
            "p2a run command failed: --failure-class is required when --status is failed or blocked.",
        }),
      ),
    ).toMatchObject({
      kind: "failure_class_required",
      title: "Failure class required",
    });
  });

  it("classifies a missing run record", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stderr: "p2a run command failed: run-unknown does not exist: /project/runs/run-unknown.json",
        }),
      ),
    ).toMatchObject({
      kind: "run_not_found",
      title: "Run not found",
    });
  });

  it("classifies skipped task transitions", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stderr:
            "task transition skipped: task-001 must be in_progress before done/block; current status is todo",
        }),
      ),
    ).toMatchObject({
      kind: "task_transition_skipped",
      title: "Task transition skipped",
    });
  });

  it("classifies missing verification commands", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stderr:
            "p2a run command failed: no verification command requested and no configured test/lint/typecheck command found",
        }),
      ),
    ).toMatchObject({
      kind: "verification_command_missing",
      title: "Verification command missing",
    });
  });

  it("falls back to the first command output line", () => {
    expect(
      summarizeFinishRunFailure(
        failedResult({
          stderr: "custom finish failure\nwith more detail",
        }),
      ),
    ).toMatchObject({
      kind: "unknown",
      title: "Finish run failed",
      detail: "custom finish failure",
    });
  });
});
