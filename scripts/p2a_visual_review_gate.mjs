/** Enforce the iteration-level visual-review sidecar required before close. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateVisualReview } from './validate_artifacts.mjs';
import {
  canonicalWorkspacePathForArtifactRoot,
  runSidecarPath,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from './p2a_run_paths.mjs';

export const VISUAL_REVIEW_SIDECAR_SUFFIX = '.visual-review.json';

export function expectedVisualReviewContract(run, options = {}) {
  if (!run.visualReview?.required) return null;
  const finishedAt = options.finishedAt ?? run.finishedAt;
  return {
    run_id: run.runId,
    iteration_id: run.iterationId,
    workspace_ref: run.workspaceRef,
    workspace_revision_sha256: run.workspaceRevisionSha256,
    started_at: run.startedAt,
    ...(finishedAt ? { finished_at: finishedAt } : {}),
    ...(options.notBefore ? { evidence_not_before: options.notBefore } : {}),
    project_id: run.projectId,
    source_spec_ref: run.sourceSpecRef,
    task_graph_ref: run.taskGraphRef,
    source_experience_ref: run.visualReview.experienceSpecRef,
    experience_spec_sha256: run.visualReview.experienceSpecSha256,
    source_prototype_ref: run.visualReview.prototypeManifestRef,
    prototype_manifest_sha256: run.visualReview.prototypeManifestSha256,
    screen_states: run.visualReview.screenStates.map((screen) => ({
      screen_id: screen.screenId,
      states: screen.states,
    })),
    viewports: run.visualReview.viewports,
    accessibility_standard: run.visualReview.accessibilityStandard,
  };
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function readRequiredVisualReviewEvidence(runsDir, run, options = {}) {
  const expected = expectedVisualReviewContract(run, options);
  if (!expected) return null;
  const reviewPath = runSidecarPath(runsDir, run.runId, VISUAL_REVIEW_SIDECAR_SUFFIX, options.index);
  if (!existsSync(reviewPath) || !lstatSync(reviewPath).isFile()) {
    throw new Error(
      `visual review is required before run ${run.runId} can finish: ${reviewPath}`,
    );
  }
  const reviewSha256 = fileSha256(reviewPath);
  let review;
  try {
    review = validateVisualReview(reviewPath, expected, {
      artifactRoot: options.artifactRoot ?? path.dirname(path.resolve(runsDir)),
      ...(options.sourceArtifactRoot
        ? { sourceArtifactRoot: options.sourceArtifactRoot }
        : {}),
    });
  } catch (error) {
    throw new Error(`visual review is invalid for run ${run.runId}: ${error.message}`);
  }
  if (
    run.runKind === 'final_visual_review'
    && review.schema_version !== 'p2a.visual_review.v2'
  ) {
    throw new Error(
      `final visual review run ${run.runId} requires iteration-owned p2a.visual_review.v2 evidence`,
    );
  }
  if (review.verdict !== 'confirm_ui') {
    const concerns = review.concerns.length ? review.concerns.join(' | ') : (review.note || 'no details provided');
    throw new Error(`visual review blocked run ${run.runId}: ${concerns}`);
  }
  if (fileSha256(reviewPath) !== reviewSha256) {
    throw new Error(`visual review changed while it was being validated for run ${run.runId}`);
  }
  if (run.status === 'finished' && !run.visualReviewEvidenceSha256) {
    throw new Error(`finished run ${run.runId} is missing visualReviewEvidenceSha256`);
  }
  if (
    run.visualReviewEvidenceSha256
    && run.visualReviewEvidenceSha256 !== reviewSha256
  ) {
    throw new Error(`visual review evidence digest does not match finished run ${run.runId}`);
  }
  return { review, reviewSha256 };
}

export function readRequiredVisualReview(runsDir, run, options = {}) {
  return readRequiredVisualReviewEvidence(runsDir, run, options)?.review ?? null;
}

export function assertFinalVisualReviewRunReady({
  runsDir,
  run,
  taskId = run?.taskId,
  artifactRoot,
  graphPath,
}) {
  if (!run || run.status !== 'finished') {
    throw new Error(`final visual review requires the latest run for ${taskId} to be finished`);
  }
  if (!Array.isArray(run.changedFiles) || run.changedFiles.length > 0) {
    throw new Error(`final visual review requires the latest run for ${taskId} to be review-only with no changedFiles`);
  }
  if (run.isolation?.mode !== 'none') {
    throw new Error(
      `final visual review requires the latest run for ${taskId} to use the canonical integration workspace without branch/worktree isolation`,
    );
  }
  if (run.runKind !== 'final_visual_review') {
    throw new Error(
      `final visual review requires the latest run for ${taskId} to declare runKind final_visual_review`,
    );
  }
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(resolvedArtifactRoot);
  if (
    !run.workspacePath
    || !existsSync(run.workspacePath)
    || !lstatSync(run.workspacePath).isDirectory()
    || realpathSync(run.workspacePath) !== realpathSync(canonicalWorkspacePath)
  ) {
    throw new Error(
      `final visual review requires the latest run for ${taskId} to review the canonical integration workspace ${canonicalWorkspacePath}`,
    );
  }
  const currentWorkspaceRevision = workspaceRevisionSha256(
    canonicalWorkspacePath,
    workspaceRevisionExcludedPathsForRun(
      runsDir,
      run,
      {
        artifactRoot: resolvedArtifactRoot,
        graphPath,
        workspacePath: canonicalWorkspacePath,
      },
    ),
  );
  if (run.workspaceRevisionSha256 !== currentWorkspaceRevision) {
    throw new Error(
      `final visual review requires the latest run for ${taskId} to match the current canonical workspace revision`,
    );
  }
  try {
    readRequiredVisualReview(runsDir, run, {
      artifactRoot: resolvedArtifactRoot,
      finishedAt: run.finishedAt,
    });
  } catch (error) {
    throw new Error(
      `final visual review evidence for ${taskId} is stale or invalid: ${error.message}`,
      { cause: error },
    );
  }
  return {
    canonicalWorkspacePath,
    workspaceRevisionSha256: currentWorkspaceRevision,
  };
}
