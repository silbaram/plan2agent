/** Enforce the iteration-level functional acceptance sidecar required before close. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateAcceptanceReview } from './validate_artifacts.mjs';
import {
  canonicalWorkspacePathForArtifactRoot,
  runSidecarPath,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from './p2a_run_paths.mjs';

export const ACCEPTANCE_REVIEW_SIDECAR_SUFFIX = '.acceptance-review.json';

export function expectedAcceptanceReviewContract(run) {
  if (!run.acceptanceReview?.required) return null;
  return {
    run_id: run.runId,
    iteration_id: run.iterationId,
    source_spec_ref: run.sourceSpecRef,
    criteria: run.acceptanceReview.criteria,
    verification: run.verification,
  };
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function readRequiredAcceptanceReviewEvidence(runsDir, run, options = {}) {
  const expected = expectedAcceptanceReviewContract(run);
  if (!expected) return null;
  const reviewPath = runSidecarPath(
    runsDir,
    run.runId,
    ACCEPTANCE_REVIEW_SIDECAR_SUFFIX,
    options.index,
  );
  if (!existsSync(reviewPath) || !lstatSync(reviewPath).isFile()) {
    throw new Error(`acceptance review is required before run ${run.runId} can finish: ${reviewPath}`);
  }
  const reviewSha256 = fileSha256(reviewPath);
  let review;
  try {
    review = validateAcceptanceReview(reviewPath, expected);
  } catch (error) {
    throw new Error(`acceptance review is invalid for run ${run.runId}: ${error.message}`);
  }
  if (review.verdict !== 'confirm_behavior') {
    const detail = review.unmet.length ? review.unmet.join(' | ') : 'behavior was not confirmed';
    throw new Error(`acceptance review blocked run ${run.runId}: ${detail}`);
  }
  if (fileSha256(reviewPath) !== reviewSha256) {
    throw new Error(`acceptance review changed while it was being validated for run ${run.runId}`);
  }
  if (run.status === 'finished' && !run.acceptanceReviewEvidenceSha256) {
    throw new Error(`finished run ${run.runId} is missing acceptanceReviewEvidenceSha256`);
  }
  if (
    run.acceptanceReviewEvidenceSha256
    && run.acceptanceReviewEvidenceSha256 !== reviewSha256
  ) {
    throw new Error(`acceptance review evidence digest does not match finished run ${run.runId}`);
  }
  return { review, reviewSha256 };
}

export function readRequiredAcceptanceReview(runsDir, run, options = {}) {
  return readRequiredAcceptanceReviewEvidence(runsDir, run, options)?.review ?? null;
}

export function assertFinalAcceptanceReviewRunReady({ runsDir, run, artifactRoot, graphPath }) {
  if (!run || run.status !== 'finished') {
    throw new Error('final acceptance review requires the latest acceptance run to be finished');
  }
  if (!Array.isArray(run.changedFiles) || run.changedFiles.length > 0) {
    throw new Error('final acceptance review must be review-only with no changedFiles');
  }
  if (run.isolation?.mode !== 'none') {
    throw new Error('final acceptance review must use the canonical integration workspace without isolation');
  }
  if (run.runKind !== 'final_acceptance_review') {
    throw new Error('final acceptance review run must declare runKind final_acceptance_review');
  }
  const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(path.resolve(artifactRoot));
  if (
    !run.workspacePath
    || !existsSync(run.workspacePath)
    || !lstatSync(run.workspacePath).isDirectory()
    || realpathSync(run.workspacePath) !== realpathSync(canonicalWorkspacePath)
  ) {
    throw new Error(`final acceptance review must inspect the canonical integration workspace ${canonicalWorkspacePath}`);
  }
  const currentWorkspaceRevision = workspaceRevisionSha256(
    canonicalWorkspacePath,
    workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot: path.resolve(artifactRoot),
      graphPath,
      workspacePath: canonicalWorkspacePath,
    }),
  );
  if (run.workspaceRevisionSha256 !== currentWorkspaceRevision) {
    throw new Error('final acceptance review does not match the current canonical workspace revision');
  }
  try {
    readRequiredAcceptanceReview(runsDir, run);
  } catch (error) {
    throw new Error(`final acceptance review evidence is stale or invalid: ${error.message}`, { cause: error });
  }
  return { canonicalWorkspacePath, workspaceRevisionSha256: currentWorkspaceRevision };
}
