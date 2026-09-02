/** Enforce one revision-bound configured full verification pass before iteration close. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
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

function canonicalWorkspaceRun(run, canonicalWorkspacePath) {
  if (
    !run
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

function canonicalFinalRun(run, canonicalWorkspacePath) {
  return (
    FINAL_VERIFICATION_RUN_KINDS.has(run?.runKind)
    && Array.isArray(run.changedFiles)
    && run.changedFiles.length === 0
    && canonicalWorkspaceRun(run, canonicalWorkspacePath)
  );
}

function configuredFullVerificationProfile(artifactRoot, canonicalWorkspacePath) {
  const candidates = [
    path.join(artifactRoot, 'project.config.json'),
    path.join(canonicalWorkspacePath, '.plan2agent', 'project.config.json'),
  ];
  for (const candidate of [...new Set(candidates.map((value) => path.resolve(value)))]) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      throw new Error(`configured full verification profile is malformed: ${candidate} (${error.message})`);
    }
    return [
      ['test', config.testCommand],
      ['lint', config.lintCommand],
      ['typecheck', config.typecheckCommand],
    ]
      .filter(([, command]) => typeof command === 'string' && command.trim())
      .map(([type, command]) => ({ type, command: command.trim() }));
  }
  return [];
}

function verificationCommandIdentity(item) {
  return typeof item?.originalCommand === 'string' && item.originalCommand.trim()
    ? item.originalCommand.trim()
    : (typeof item?.command === 'string' ? item.command.trim() : '');
}

function verificationTime(item, run) {
  for (const value of [item?.finishedAt, item?.startedAt, run?.finishedAt, run?.updatedAt, run?.startedAt]) {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function compareAttemptChronology(left, right) {
  return left.timestamp - right.timestamp
    || left.runOrder - right.runOrder
    || left.itemOrder - right.itemOrder;
}

function latestAttempt(attempts) {
  return attempts.reduce((latest, attempt) => (
    !latest || compareAttemptChronology(attempt, latest) > 0 ? attempt : latest
  ), null);
}

function earliestAttempt(attempts) {
  return attempts.reduce((earliest, attempt) => (
    !earliest || compareAttemptChronology(attempt, earliest) < 0 ? attempt : earliest
  ), null);
}

function runBoundaryAttempt(runEntry) {
  const { run, runOrder, currentWorkspaceRevision } = runEntry;
  return {
    run,
    item: null,
    runOrder,
    itemOrder: (run.verification ?? []).length,
    currentWorkspaceRevision,
    timestamp: verificationTime(null, run),
  };
}

function currentFullVerificationAttempts(runEntry) {
  const { run, runOrder, currentWorkspaceRevision } = runEntry;
  return (run.verification ?? []).flatMap((item, itemOrder) => {
    if (
      item.type === 'custom'
      || item.scope !== 'full'
      || (item.source !== 'config' && item.source !== 'command')
      || item.workspaceRevisionSha256 !== currentWorkspaceRevision
    ) return [];
    return [{
      run,
      item,
      runOrder,
      itemOrder,
      currentWorkspaceRevision,
      timestamp: verificationTime(item, run),
    }];
  });
}

function configuredAttemptMatches(attempt, configured) {
  return attempt.item.type === configured.type
    && verificationCommandIdentity(attempt.item) === configured.command;
}

function attemptPassed(attempt) {
  return attempt.item.status === 'passed' && attempt.item.exitCode === 0;
}

function configuredProfileSuccessAttempt(runEntry, attempts, profile) {
  if (runEntry.run.status !== 'finished' || !profile.length) return null;
  const latestByConfiguredCommand = profile.map((configured) => latestAttempt(
    attempts.filter((attempt) => configuredAttemptMatches(attempt, configured)),
  ));
  if (
    latestByConfiguredCommand.some((attempt) => !attempt || !attemptPassed(attempt))
  ) return null;
  // The whole profile is clean only after every required command has passed
  // since the latest blocker. Using the earliest required pass prevents a
  // concurrent failure between commands from being hidden by the last pass.
  return earliestAttempt(latestByConfiguredCommand);
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
  let completedTaskIds = new Set();
  try {
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    completedTaskIds = new Set(
      (Array.isArray(graph?.tasks) ? graph.tasks : [])
        .filter((task) => task?.status === 'done')
        .map((task) => task.id),
    );
  } catch {
    // The caller's task-graph validator owns malformed graph diagnostics. A
    // missing completion binding simply makes implementation evidence ineligible.
  }
  const configuredProfile = configuredFullVerificationProfile(
    resolvedArtifactRoot,
    canonicalWorkspacePath,
  );
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
    .filter(({ run }) => (
      canonicalFinalRun(run, canonicalWorkspacePath)
      || (
        !run.runKind
        && completedTaskIds.has(run.taskId)
        && canonicalWorkspaceRun(run, canonicalWorkspacePath)
      )
    ))
    .map((entry) => ({
      ...entry,
      currentWorkspaceRevision: currentWorkspaceRevisionForRun(entry.run),
    }));
  const successCandidates = [];
  const blockingAttempts = [];
  canonicalRuns.forEach((entry) => {
    const attempts = currentFullVerificationAttempts(entry);
    if (FINAL_VERIFICATION_RUN_KINDS.has(entry.run.runKind)) {
      if (entry.run.status === 'failed' || entry.run.status === 'blocked') {
        // Final closeout is atomic at the run level. Lifecycle failures can
        // produce only custom unavailable evidence, so a failed/blocked final
        // run must supersede older success even without a configured full item.
        blockingAttempts.push(runBoundaryAttempt(entry));
        return;
      }
      if (configuredProfile.length) {
        const configuredAttempts = attempts.filter((attempt) => (
          configuredProfile.some((configured) => configuredAttemptMatches(attempt, configured))
        ));
        const success = configuredProfileSuccessAttempt(
          entry,
          configuredAttempts,
          configuredProfile,
        );
        if (
          success
          && entry.run.workspaceRevisionSha256 === entry.currentWorkspaceRevision
        ) {
          successCandidates.push(success);
        } else if (entry.run.runKind === 'final_verification' && configuredAttempts.length) {
          blockingAttempts.push(runBoundaryAttempt(entry));
        }
        blockingAttempts.push(...configuredAttempts.filter((attempt) => (
          attempt.item.status === 'failed' || attempt.item.status === 'unavailable'
        )));
        return;
      }
      const finalAttempt = latestAttempt(attempts);
      if (!finalAttempt) return;
      if (
        entry.run.status === 'finished'
        && entry.run.workspaceRevisionSha256 === entry.currentWorkspaceRevision
        && attemptPassed(finalAttempt)
      ) {
        successCandidates.push(finalAttempt);
      } else {
        // A final run is an atomic closeout attempt. Even when its last command
        // passed, an unsuccessful run must supersede older successful evidence.
        blockingAttempts.push(finalAttempt);
      }
      return;
    }

    const configuredAttempts = attempts.filter((attempt) => (
      configuredProfile.some((configured) => configuredAttemptMatches(attempt, configured))
    ));
    const success = configuredProfileSuccessAttempt(entry, configuredAttempts, configuredProfile);
    if (success) successCandidates.push(success);
    blockingAttempts.push(...configuredAttempts.filter((attempt) => (
      attempt.item.status === 'failed' || attempt.item.status === 'unavailable'
    )));
  });
  const latestSuccess = latestAttempt(successCandidates);
  const latestBlocker = latestAttempt(blockingAttempts);
  const matched = latestSuccess
    && (!latestBlocker || compareAttemptChronology(latestSuccess, latestBlocker) > 0)
    ? latestSuccess
    : null;
  if (!matched) {
    const latest = [...canonicalRuns]
      .filter(({ run }) => (
        FINAL_VERIFICATION_RUN_KINDS.has(run.runKind)
        && run.status === 'finished'
      ))
      .sort(compareRunEvidence)[0];
    if (latest && latest.run.workspaceRevisionSha256 !== latest.currentWorkspaceRevision) {
      throw new Error(
        `latest final verification evidence ${latest.run.runId} is stale for the current canonical workspace revision`,
      );
    }
    throw new Error(
      'no eligible canonical run contains passed configured full verification evidence for the current workspace revision',
    );
  }
  return {
    run: matched.run,
    evidenceSource: FINAL_VERIFICATION_RUN_KINDS.has(matched.run.runKind)
      ? 'final_run'
      : 'implementation_run_reuse',
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
