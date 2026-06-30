import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ScaffoldArtifactLayout = {
  isScaffoldProject: boolean;
  hasCurrentSpec: boolean;
  hasIterations: boolean;
  hasGreenfieldGateBundle: boolean;
  requiresIterationInit: boolean;
  hasIncompleteIterationLayout: boolean;
};

const GREENFIELD_REQUIRED_FILES = [
  path.join("gate-a-intake", "intake.json"),
  path.join("gate-b-spec", "spec.json"),
  path.join("gate-c-task-graph", "task-graph.json"),
  path.join("gate-d-review", "review.json"),
];

function deriveScaffoldArtifactLayout(input: {
  isScaffoldProject: boolean;
  hasCurrentSpec: boolean;
  hasIterations: boolean;
  hasGreenfieldGateBundle: boolean;
}): ScaffoldArtifactLayout {
  const hasAnyIterationMarker = input.hasCurrentSpec || input.hasIterations;
  return {
    ...input,
    requiresIterationInit:
      input.isScaffoldProject &&
      input.hasGreenfieldGateBundle &&
      !hasAnyIterationMarker,
    hasIncompleteIterationLayout:
      input.isScaffoldProject &&
      input.hasCurrentSpec !== input.hasIterations,
  };
}

function isFileSyncSafe(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isDirectorySyncSafe(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isScaffoldProjectSync(projectRoot: string): boolean {
  try {
    const manifestPath = path.join(projectRoot, ".plan2agent", "manifest.json");
    if (!isFileSyncSafe(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      provenance?: { mode?: unknown };
    };
    return manifest.provenance?.mode === "scaffold";
  } catch {
    return false;
  }
}

function hasGreenfieldGateBundleSync(artifactRoot: string): boolean {
  return GREENFIELD_REQUIRED_FILES.every((relativePath) =>
    isFileSyncSafe(path.join(artifactRoot, relativePath)),
  );
}

async function isFileAsyncSafe(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryAsyncSafe(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isScaffoldProject(projectRoot: string): Promise<boolean> {
  try {
    const manifestPath = path.join(projectRoot, ".plan2agent", "manifest.json");
    if (!(await isFileAsyncSafe(manifestPath))) return false;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      provenance?: { mode?: unknown };
    };
    return manifest.provenance?.mode === "scaffold";
  } catch {
    return false;
  }
}

async function hasGreenfieldGateBundle(artifactRoot: string): Promise<boolean> {
  const checks = await Promise.all(
    GREENFIELD_REQUIRED_FILES.map((relativePath) =>
      isFileAsyncSafe(path.join(artifactRoot, relativePath)),
    ),
  );
  return checks.every(Boolean);
}

export function readScaffoldArtifactLayoutSync(
  projectRoot: string,
  artifactRoot: string,
): ScaffoldArtifactLayout {
  return deriveScaffoldArtifactLayout({
    isScaffoldProject: isScaffoldProjectSync(projectRoot),
    hasCurrentSpec: isFileSyncSafe(path.join(artifactRoot, "current-spec.json")),
    hasIterations: isDirectorySyncSafe(path.join(artifactRoot, "iterations")),
    hasGreenfieldGateBundle: hasGreenfieldGateBundleSync(artifactRoot),
  });
}

export async function readScaffoldArtifactLayout(
  projectRoot: string,
  artifactRoot: string,
): Promise<ScaffoldArtifactLayout> {
  const [
    isScaffoldProjectValue,
    hasCurrentSpec,
    hasIterations,
    hasGreenfieldGateBundleValue,
  ] = await Promise.all([
    isScaffoldProject(projectRoot),
    isFileAsyncSafe(path.join(artifactRoot, "current-spec.json")),
    isDirectoryAsyncSafe(path.join(artifactRoot, "iterations")),
    hasGreenfieldGateBundle(artifactRoot),
  ]);
  return deriveScaffoldArtifactLayout({
    isScaffoldProject: isScaffoldProjectValue,
    hasCurrentSpec,
    hasIterations,
    hasGreenfieldGateBundle: hasGreenfieldGateBundleValue,
  });
}
