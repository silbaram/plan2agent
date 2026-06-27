import type { ExecutionCommandResult } from "./ipc";

export type ExecutionFailureKind =
  | "script_missing"
  | "task_not_ready"
  | "run_already_exists"
  | "artifact_validation"
  | "missing_file"
  | "unsupported_agent"
  | "verification_failed"
  | "failure_class_required"
  | "run_not_found"
  | "task_transition_skipped"
  | "verification_command_missing"
  | "unknown";

export type ExecutionFailureSummary = {
  kind: ExecutionFailureKind;
  title: string;
  detail: string;
  nextAction: string;
};

function combinedOutput(result: Pick<ExecutionCommandResult, "stdout" | "stderr">): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function includesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

export function summarizeStartRunFailure(
  result: ExecutionCommandResult | null,
): ExecutionFailureSummary | null {
  if (!result || result.exitCode === 0) return null;

  const output = combinedOutput(result);
  const normalizedOutput = output.toLowerCase();

  if (normalizedOutput.includes("p2a_execute does not exist")) {
    return {
      kind: "script_missing",
      title: "P2A execution script missing",
      detail: "The selected project does not expose .plan2agent/scripts/p2a_execute.mjs.",
      nextAction: "Validate or reinstall the P2A harness, then reload the project.",
    };
  }

  if (
    normalizedOutput.includes("not ready") ||
    normalizedOutput.includes("incomplete dependencies")
  ) {
    return {
      kind: "task_not_ready",
      title: "Task is not ready",
      detail: "The task cannot start until its dependencies and current status allow execution.",
      nextAction: "Check dependency status in Tasks before starting this task.",
    };
  }

  if (normalizedOutput.includes("run already exists")) {
    return {
      kind: "run_already_exists",
      title: "Run already exists",
      detail: "The requested run id already has a run record.",
      nextAction: "Reload runs or start the task with a new run id.",
    };
  }

  if (
    includesAny(normalizedOutput, [
      "p2a execute validation failed",
      "task graph validation failed",
      "schema invalid",
      "must match pattern",
      "unknown dependencies",
    ])
  ) {
    return {
      kind: "artifact_validation",
      title: "Artifact validation failed",
      detail: "The task graph or source artifact does not match the expected P2A contract.",
      nextAction: "Open Validate guidance and fix the artifact before starting a run.",
    };
  }

  if (
    includesAny(normalizedOutput, [
      "does not exist",
      " is missing",
      "is not a directory",
      "is not a file",
    ])
  ) {
    return {
      kind: "missing_file",
      title: "Required file or folder missing",
      detail: "The execution lifecycle could not find a required project path.",
      nextAction: "Check the project root, artifact root, task graph path, and harness files.",
    };
  }

  if (normalizedOutput.includes("unsupported agent tool")) {
    return {
      kind: "unsupported_agent",
      title: "Unsupported agent tool",
      detail: "The selected agent tool is not accepted by the execution lifecycle.",
      nextAction: "Choose a supported agent tool in project settings and retry.",
    };
  }

  return {
    kind: "unknown",
    title: "Start run failed",
    detail:
      output.split(/\r?\n/).find((line) => line.trim())?.trim() ??
      "No command output was captured.",
    nextAction: "Review the command output below and retry after fixing the project state.",
  };
}

export function summarizeFinishRunFailure(
  result: ExecutionCommandResult | null,
): ExecutionFailureSummary | null {
  if (!result || result.exitCode === 0) return null;

  const output = combinedOutput(result);
  const normalizedOutput = output.toLowerCase();

  if (
    normalizedOutput.includes("verification_failed") ||
    normalizedOutput.includes("status: failed") ||
    normalizedOutput.includes(": failed (")
  ) {
    return {
      kind: "verification_failed",
      title: "Verification failed",
      detail: "One or more verification commands failed and the run was not finished cleanly.",
      nextAction: "Review the verification stderr below, fix the implementation, then rerun finish.",
    };
  }

  if (
    normalizedOutput.includes("--failure-class is required") ||
    normalizedOutput.includes("blocked finish requires a failure class")
  ) {
    return {
      kind: "failure_class_required",
      title: "Failure class required",
      detail: "Failed or blocked finishes must record a failure class.",
      nextAction: "Choose the closest failure class and add a note when needed.",
    };
  }

  if (
    normalizedOutput.includes("run id is required") ||
    normalizedOutput.includes("run id must match") ||
    normalizedOutput.includes("run not found") ||
    /^.*run-[a-z0-9._-]+ does not exist:/im.test(output)
  ) {
    return {
      kind: "run_not_found",
      title: "Run not found",
      detail: "The finish command could not resolve the selected run record.",
      nextAction: "Reload runs and confirm the selected run still exists before finishing.",
    };
  }

  if (normalizedOutput.includes("task transition skipped")) {
    return {
      kind: "task_transition_skipped",
      title: "Task transition skipped",
      detail: "The run was updated, but the task graph could not move to done or blocked.",
      nextAction: "Reload the project and inspect the task status before retrying.",
    };
  }

  if (
    normalizedOutput.includes("no verification command requested") ||
    normalizedOutput.includes("command is not configured") ||
    normalizedOutput.includes("<missing")
  ) {
    return {
      kind: "verification_command_missing",
      title: "Verification command missing",
      detail: "Finish was asked to verify, but no runnable command was available.",
      nextAction: "Set an explicit custom verification command or configure project test commands.",
    };
  }

  if (
    includesAny(normalizedOutput, [
      "p2a execute validation failed",
      "p2a run validation failed",
      "task graph validation failed",
      "schema invalid",
      "must match pattern",
    ])
  ) {
    return {
      kind: "artifact_validation",
      title: "Artifact validation failed",
      detail: "The run or task artifact does not match the expected P2A contract.",
      nextAction: "Open Validate guidance and fix the artifact before finishing the run.",
    };
  }

  if (
    includesAny(normalizedOutput, [
      "does not exist",
      " is missing",
      "is not a directory",
      "is not a file",
    ])
  ) {
    return {
      kind: "missing_file",
      title: "Required file or folder missing",
      detail: "The finish lifecycle could not find a required project path.",
      nextAction: "Check the project root, artifact root, run file, task graph path, and harness files.",
    };
  }

  return {
    kind: "unknown",
    title: "Finish run failed",
    detail:
      output.split(/\r?\n/).find((line) => line.trim())?.trim() ??
      "No command output was captured.",
    nextAction: "Review the command output below and retry after fixing the run state.",
  };
}
