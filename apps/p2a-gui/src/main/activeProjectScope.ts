import path from "node:path";
import type {
  ArtifactFileReadRequest,
  ExecutionFinishRunRequest,
  ExecutionStartRunRequest,
  OperationalActionRequest,
  OrchestrationMarkRoleRequest,
  TerminalSessionStartRequest,
} from "../shared/ipc";

function normalizeActiveProjectRoot(activeProjectRoot: string | null | undefined): string {
  if (typeof activeProjectRoot !== "string" || activeProjectRoot.trim().length === 0) {
    throw new Error("No active project is loaded");
  }
  return path.resolve(activeProjectRoot);
}

function resolveInsideActiveProject(
  activeProjectRoot: string,
  targetPath: string | null | undefined,
  label: string,
): string {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error(`${label} is required`);
  }

  const activeRoot = normalizeActiveProjectRoot(activeProjectRoot);
  const normalizedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(activeRoot, targetPath);
  const activeRootBoundary = `${activeRoot}${path.sep}`;

  if (normalizedPath !== activeRoot && !normalizedPath.startsWith(activeRootBoundary)) {
    throw new Error(`${label} must stay inside the active project root`);
  }

  return normalizedPath;
}

export function requireActiveProjectRootMatch(
  activeProjectRoot: string | null | undefined,
  projectRoot: string | null | undefined,
): string {
  const activeRoot = normalizeActiveProjectRoot(activeProjectRoot);
  const requestedRoot = resolveInsideActiveProject(activeRoot, projectRoot, "project root");

  if (requestedRoot !== activeRoot) {
    throw new Error("project root must match the active project root");
  }

  return activeRoot;
}

export function scopeArtifactReadRequest(
  activeProjectRoot: string | null | undefined,
  request: ArtifactFileReadRequest | null | undefined,
): ArtifactFileReadRequest {
  if (!request) throw new Error("artifact:readFile requires a request");
  const projectRoot = requireActiveProjectRootMatch(activeProjectRoot, request.projectRoot);
  return {
    ...request,
    projectRoot,
  };
}

export function scopeTerminalStartRequest(
  activeProjectRoot: string | null | undefined,
  request: TerminalSessionStartRequest | null | undefined,
): TerminalSessionStartRequest {
  if (!request) throw new Error("terminal:start requires a request");
  const activeRoot = normalizeActiveProjectRoot(activeProjectRoot);
  return {
    ...request,
    cwd: resolveInsideActiveProject(activeRoot, request?.cwd, "terminal cwd"),
  };
}

export function scopeExecutionStartRunRequest(
  activeProjectRoot: string | null | undefined,
  request: ExecutionStartRunRequest | null | undefined,
): ExecutionStartRunRequest {
  if (!request) throw new Error("execution:startRun requires a request");
  const projectRoot = requireActiveProjectRootMatch(activeProjectRoot, request.projectRoot);
  return {
    ...request,
    projectRoot,
    artifactRoot: resolveInsideActiveProject(projectRoot, request?.artifactRoot, "artifact root"),
    taskGraphPath: request?.taskGraphPath
      ? resolveInsideActiveProject(projectRoot, request.taskGraphPath, "task graph path")
      : null,
  };
}

export function scopeExecutionFinishRunRequest(
  activeProjectRoot: string | null | undefined,
  request: ExecutionFinishRunRequest | null | undefined,
): ExecutionFinishRunRequest {
  if (!request) throw new Error("execution:finishRun requires a request");
  const projectRoot = requireActiveProjectRootMatch(activeProjectRoot, request.projectRoot);
  return {
    ...request,
    projectRoot,
    artifactRoot: resolveInsideActiveProject(projectRoot, request?.artifactRoot, "artifact root"),
    taskGraphPath: request?.taskGraphPath
      ? resolveInsideActiveProject(projectRoot, request.taskGraphPath, "task graph path")
    : null,
  };
}

export function scopeOperationalActionRequest(
  activeProjectRoot: string | null | undefined,
  request: OperationalActionRequest | null | undefined,
): OperationalActionRequest {
  if (!request) throw new Error("operational:runAction requires a request");
  const projectRoot = requireActiveProjectRootMatch(activeProjectRoot, request.projectRoot);
  return {
    ...request,
    projectRoot,
    artifactRoot: request.artifactRoot
      ? resolveInsideActiveProject(projectRoot, request.artifactRoot, "artifact root")
      : null,
  };
}

export function scopeOrchestrationMarkRoleRequest(
  activeProjectRoot: string | null | undefined,
  request: OrchestrationMarkRoleRequest | null | undefined,
): OrchestrationMarkRoleRequest {
  if (!request) throw new Error("orchestration:markRole requires a request");
  const projectRoot = requireActiveProjectRootMatch(activeProjectRoot, request.projectRoot);
  return {
    ...request,
    projectRoot,
    runtimePath: resolveInsideActiveProject(projectRoot, request.runtimePath, "runtime path"),
  };
}
