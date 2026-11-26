/** Policy and validation helpers for portable versus resumable run handoff. */

import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

import {
  validateHandoffReadyArtifactRoot,
  validateRunsDir,
} from './validate_artifacts.mjs';

export function portableProvenanceMigrationHint() {
  return 'normalize non-canonical references with an explicit import/migration workflow, or use --run-transfer resumable for compatibility transfer';
}

function normalizedArtifactReference(reference) {
  if (typeof reference !== 'string' || !reference.trim()) return null;
  return path.posix.normalize(reference.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function runEvidenceTime(run) {
  for (const value of [run?.finishedAt, run?.updatedAt, run?.startedAt]) {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function closeReadyReviewRunIds(
  runRecords,
  { iterationId, taskGraphRef, runKind, reviewField },
) {
  const expectedTaskGraphRef = normalizedArtifactReference(taskGraphRef);
  const latestReview = runRecords
    .map((run, runOrder) => ({ run, runOrder }))
    .filter(({ run }) => (
      run?.runKind === runKind
      && run.iterationId === iterationId
      && run.sourceLayout === 'iteration'
      && (!expectedTaskGraphRef
        || normalizedArtifactReference(run.taskGraphRef) === expectedTaskGraphRef)
    ))
    .sort((left, right) => (
      runEvidenceTime(right.run) - runEvidenceTime(left.run)
      || right.runOrder - left.runOrder
    ))[0]?.run;
  if (
    latestReview?.status !== 'finished'
    || latestReview.schema_version !== 'p2a.run.v2'
    || !latestReview[reviewField]?.required
  ) {
    return new Set();
  }
  return new Set([latestReview.runId]);
}

export function closeReadyVisualReviewRunIds(runRecords, options = {}) {
  return closeReadyReviewRunIds(runRecords, {
    ...options,
    runKind: 'final_visual_review',
    reviewField: 'visualReview',
  });
}

export function closeReadyAcceptanceReviewRunIds(runRecords, options = {}) {
  return closeReadyReviewRunIds(runRecords, {
    ...options,
    runKind: 'final_acceptance_review',
    reviewField: 'acceptanceReview',
  });
}

export function completedImplementationRunIds(
  runRecords,
  { iterationId, taskGraphRef } = {},
) {
  const expectedTaskGraphRef = normalizedArtifactReference(taskGraphRef);
  const latestByTask = new Map();
  runRecords.forEach((run, runOrder) => {
    if (
      run?.runKind
      || run?.status !== 'finished'
      || run.iterationId !== iterationId
      || run.sourceLayout !== 'iteration'
      || (expectedTaskGraphRef
        && normalizedArtifactReference(run.taskGraphRef) !== expectedTaskGraphRef)
    ) {
      return;
    }
    const candidate = { run, runOrder };
    const current = latestByTask.get(run.taskId);
    if (
      !current
      || runEvidenceTime(candidate.run) > runEvidenceTime(current.run)
      || (
        runEvidenceTime(candidate.run) === runEvidenceTime(current.run)
        && candidate.runOrder > current.runOrder
      )
    ) {
      latestByTask.set(run.taskId, candidate);
    }
  });
  return new Set([...latestByTask.values()]
    .sort((left, right) => left.runOrder - right.runOrder)
    .map(({ run }) => run.runId));
}

export function selectHandoffRunEntries(
  runIndexData,
  requiredRunIds,
  mode,
  { additionalRunIds = new Set() } = {},
) {
  if (mode === 'resumable') return [...(runIndexData.runs ?? [])];
  if (mode !== 'completed') throw new Error(`unsupported run transfer mode: ${mode}`);
  const runsById = new Map((runIndexData.runs ?? []).map((entry) => [entry.runId, entry]));
  const selected = [];
  const selectedRunIds = new Set([...requiredRunIds, ...additionalRunIds]);
  for (const runId of selectedRunIds) {
    const entry = runsById.get(runId);
    if (!entry) {
      throw new Error(`portable handoff is missing required finished run evidence ${runId}`);
    }
    if (entry.status !== 'finished') {
      throw new Error(`portable handoff requires run ${runId} to be finished, got ${entry.status}`);
    }
    selected.push(entry);
  }
  return selected;
}

export function assertCanonicalPortableRun(runData) {
  if (runData.status !== 'finished') {
    throw new Error(`portable handoff requires run ${runData.runId} to be finished`);
  }
  if (runData.schema_version !== 'p2a.run.v2') {
    throw new Error(
      `portable handoff requires canonical p2a.run.v2 evidence for ${runData.runId}; run p2a runs migrate-schema before handoff, or use --run-transfer resumable for compatibility transfer`,
    );
  }
}

export function validatePortableHandoffTarget(targetRoot, projectId) {
  const artifactRoot = path.join(
    path.resolve(targetRoot),
    '.plan2agent',
    'artifacts',
    projectId,
  );
  validateHandoffReadyArtifactRoot(artifactRoot, { projectId });

  let runCount = 0;
  const runsDir = path.join(artifactRoot, 'runs');
  if (existsSync(runsDir)) {
    if (!lstatSync(runsDir).isDirectory()) {
      throw new Error(`portable handoff runs path must be a directory: ${runsDir}`);
    }
    const runIndexPath = path.join(runsDir, 'run-index.json');
    if (!existsSync(runIndexPath)) {
      throw new Error(`portable handoff runs directory is missing run-index.json: ${runsDir}`);
    }
    const runIndex = validateRunsDir(runsDir);
    runCount = runIndex.runs.length;
  }

  return { artifactRoot, runCount };
}
