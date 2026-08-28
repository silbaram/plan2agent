/** Enforce one revision-bound full verification pass before iteration close. */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalWorkspacePathForArtifactRoot,
  compareRunEvidence,
  taskGraphRefMatchesGraph,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from './p2a_run_paths.mjs';

export const FINAL_VERIFICATION_RUN_KINDS = new Set([
  'final_verification',
  'final_visual_review',
  'final_acceptance_review',
]);

function canonicalFinalRun(run, canonicalWorkspacePath) {
  if (
    !run
    || !FINAL_VERIFICATION_RUN_KINDS.has(run.runKind)
    || !Array.isArray(run.changedFiles)
    || run.changedFiles.length !== 0
    || run.isolation?.mode !== 'none'
    || !run.workspacePath
    || !existsSync(run.workspacePath)
    || !lstatSync(run.workspacePath).isDirectory()
  ) return false;
  try {
    return realpathSync(run.workspacePath) === realpathSync(canonicalWorkspacePath);
  } catch {
    return false;
  }
}

function verificationTime(item, run) {
  for (const value of [item?.finishedAt, item?.startedAt, run?.finishedAt, run?.updatedAt, run?.startedAt]) {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function latestFullVerificationAttempt(runEntries) {
  const attempts = [];
  runEntries.forEach(({ run, runOrder, currentWorkspaceRevision }) => {
    (run.verification ?? []).forEach((item, itemOrder) => {
      if (
        item.type === 'custom'
        || item.scope !== 'full'
        || (item.source !== 'config' && item.source !== 'command')
        || item.workspaceRevisionSha256 !== currentWorkspaceRevision
      ) return;
      attempts.push({
        run,
        item,
        runOrder,
        itemOrder,
        currentWorkspaceRevision,
        timestamp: verificationTime(item, run),
      });
    });
  });
  return attempts.sort((left, right) => (
    right.timestamp - left.timestamp
    || right.runOrder - left.runOrder
    || right.itemOrder - left.itemOrder
  ))[0] ?? null;
}

export function passedFullVerificationItems(run, workspaceRevision) {
  return (run?.verification ?? []).filter((item) => (
    item.type !== 'custom'
    && item.scope === 'full'
    && item.status === 'passed'
    && item.exitCode === 0
    && (item.source === 'config' || item.source === 'command')
    && item.workspaceRevisionSha256 === workspaceRevision
  ));
}

export function assertFinalFullVerificationReady({
  runsDir,
  runs,
  artifactRoot,
  graphPath,
  activeIteration,
  workspaceRevisionProvider = workspaceRevisionSha256,
}) {
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(resolvedArtifactRoot);
  if (!existsSync(canonicalWorkspacePath) || !lstatSync(canonicalWorkspacePath).isDirectory()) {
    throw new Error(`canonical integration workspace is missing: ${canonicalWorkspacePath}`);
  }
  const currentRuns = (runs ?? []).filter((run) => (
    run.iterationId === activeIteration
    && run.sourceLayout === 'iteration'
    && taskGraphRefMatchesGraph(run.taskGraphRef, graphPath, resolvedArtifactRoot)
  ));
  const workspaceRevisionCache = new Map();
  const currentWorkspaceRevisionForRun = (run) => {
    const excludedPaths = workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot: resolvedArtifactRoot,
      graphPath,
      workspacePath: canonicalWorkspacePath,
    });
    const cacheKey = JSON.stringify(
      [...new Set(excludedPaths.filter(Boolean).map((filePath) => path.resolve(filePath)))].sort(),
    );
    if (!workspaceRevisionCache.has(cacheKey)) {
      workspaceRevisionCache.set(
        cacheKey,
        workspaceRevisionProvider(canonicalWorkspacePath, excludedPaths),
      );
    }
    return workspaceRevisionCache.get(cacheKey);
  };
  const canonicalRuns = currentRuns
    .map((run, runOrder) => ({ run, runOrder }))
    .filter(({ run }) => canonicalFinalRun(run, canonicalWorkspacePath))
    .map((entry) => ({
      ...entry,
      currentWorkspaceRevision: currentWorkspaceRevisionForRun(entry.run),
    }));
  const latestAttempt = latestFullVerificationAttempt(canonicalRuns);
  const matched = latestAttempt
    && latestAttempt.run.status === 'finished'
    && latestAttempt.run.workspaceRevisionSha256 === latestAttempt.currentWorkspaceRevision
    && latestAttempt.item.status === 'passed'
    && latestAttempt.item.exitCode === 0
    ? latestAttempt
    : null;
  if (!matched) {
    const latest = [...canonicalRuns]
      .filter(({ run }) => run.status === 'finished')
      .sort(compareRunEvidence)[0];
    if (latest && latest.run.workspaceRevisionSha256 !== latest.currentWorkspaceRevision) {
      throw new Error(
        `latest final verification evidence ${latest.run.runId} is stale for the current canonical workspace revision`,
      );
    }
    throw new Error(
      'no finished canonical final run contains passed full test/lint/typecheck evidence for the current workspace revision',
    );
  }
  return {
    run: matched.run,
    workspaceRevisionSha256: matched.currentWorkspaceRevision,
    verification: passedFullVerificationItems(matched.run, matched.currentWorkspaceRevision),
  };
}

export function iterationFullVerificationNeeded(options) {
  try {
    assertFinalFullVerificationReady(options);
    return false;
  } catch {
    return true;
  }
}
