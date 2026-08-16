import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCanonicalPortableRun,
  closeReadyAcceptanceReviewRunIds,
  completedImplementationRunIds,
  closeReadyVisualReviewRunIds,
  completedEvidenceRunIds,
  selectHandoffRunEntries,
  validatePortableHandoffTarget,
} from '../scripts/p2a_handoff_portability.mjs';
import { E2E_FIXTURE_ROOT, runHandoff } from './helpers/fixtures.mjs';

const entry = (runId, status = 'finished') => ({ runId, status });

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function missingRunIndex(projectId) {
  return {
    schema_version: 'p2a.run_index.v1',
    projectId,
    runs: [{
      runId: 'run-missing',
      taskId: 'task-001',
      iterationId: 'v1-mvp',
      status: 'finished',
      agentTool: 'codex',
      workspaceRef: 'fixture',
      taskGraphRef: 'gate-c-task-graph/task-graph.json',
      runRef: 'run-missing.json',
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:01:00.000Z',
    }],
    tasks: [{ taskId: 'task-001', runIds: ['run-missing'], latestRunId: 'run-missing' }],
  };
}

test('completed handoff preserves explicitly required legacy milestone evidence', () => {
  const required = completedEvidenceRunIds([{
    source: {
      completed_task_evidence: [
        { run_snapshot: { runId: 'run-finished-a' } },
        { run_snapshot: { runId: 'run-finished-b' } },
      ],
    },
  }]);
  const selected = selectHandoffRunEntries({
    runs: [
      entry('run-historical-failed', 'failed'),
      entry('run-finished-a'),
      entry('run-active', 'started'),
      entry('run-finished-b'),
    ],
  }, required, 'completed');
  assert.deepEqual(selected.map(({ runId }) => runId), ['run-finished-a', 'run-finished-b']);
});

test('completed handoff rejects missing or non-finished milestone evidence', () => {
  assert.throws(
    () => selectHandoffRunEntries(
      { runs: [entry('run-active', 'started')] },
      new Set(['run-active']),
      'completed',
    ),
    /requires run run-active to be finished/,
  );
  assert.throws(
    () => selectHandoffRunEntries({ runs: [] }, new Set(['run-missing']), 'completed'),
    /missing required finished run evidence run-missing/,
  );
});

test('completed handoff selects the latest finished implementation run per task without milestone reviews', () => {
  const taskGraphRef = 'iterations/iter-002/gate-c-task-graph/task-graph.json';
  const runs = [
    { ...entry('run-task-1-old'), taskId: 'task-001', iterationId: 'iter-002', sourceLayout: 'iteration', taskGraphRef, finishedAt: '2026-08-03T00:01:00.000Z' },
    { ...entry('run-task-1-new'), taskId: 'task-001', iterationId: 'iter-002', sourceLayout: 'iteration', taskGraphRef, finishedAt: '2026-08-03T00:02:00.000Z' },
    { ...entry('run-task-2'), taskId: 'task-002', iterationId: 'iter-002', sourceLayout: 'iteration', taskGraphRef, finishedAt: '2026-08-03T00:03:00.000Z' },
    { ...entry('run-final-review'), taskId: 'task-001', iterationId: 'iter-002', sourceLayout: 'iteration', taskGraphRef, runKind: 'final_acceptance_review', finishedAt: '2026-08-03T00:04:00.000Z' },
    { ...entry('run-other-iteration'), taskId: 'task-003', iterationId: 'iter-001', sourceLayout: 'iteration', taskGraphRef, finishedAt: '2026-08-03T00:05:00.000Z' },
  ];
  assert.deepEqual(
    [...completedImplementationRunIds(runs, { iterationId: 'iter-002', taskGraphRef })],
    ['run-task-1-new', 'run-task-2'],
  );
});

test('completed handoff retains the latest finished iteration visual review after pre-close', () => {
  const taskGraphRef = 'iterations/iter-002/gate-c-task-graph/task-graph.json';
  const runs = [
    {
      ...entry('run-task-final'),
      schema_version: 'p2a.run.v2',
      iterationId: 'iter-002',
      sourceLayout: 'iteration',
      taskGraphRef,
      finishedAt: '2026-08-03T00:01:00.000Z',
    },
    {
      ...entry('run-iteration-final-review'),
      schema_version: 'p2a.run.v2',
      iterationId: 'iter-002',
      sourceLayout: 'iteration',
      taskGraphRef,
      runKind: 'final_visual_review',
      visualReview: { required: true },
      finishedAt: '2026-08-03T00:03:00.000Z',
    },
  ];
  const closeReadyRunIds = closeReadyVisualReviewRunIds(runs, {
    iterationId: 'iter-002',
    taskGraphRef,
  });
  assert.deepEqual([...closeReadyRunIds], ['run-iteration-final-review']);
  assert.deepEqual(
    selectHandoffRunEntries(
      { runs },
      new Set(['run-task-final']),
      'completed',
      { additionalRunIds: closeReadyRunIds },
    ).map(({ runId }) => runId),
    ['run-task-final', 'run-iteration-final-review'],
  );

  runs[1].status = 'blocked';
  assert.deepEqual(
    [...closeReadyVisualReviewRunIds(runs, { iterationId: 'iter-002', taskGraphRef })],
    [],
  );
});

test('completed handoff retains the latest finished acceptance review after pre-close', () => {
  const taskGraphRef = 'iterations/iter-002/gate-c-task-graph/task-graph.json';
  const runs = [{
    ...entry('run-iteration-acceptance'),
    schema_version: 'p2a.run.v2',
    iterationId: 'iter-002',
    sourceLayout: 'iteration',
    taskGraphRef,
    runKind: 'final_acceptance_review',
    acceptanceReview: { required: true },
    finishedAt: '2026-08-03T00:03:00.000Z',
  }];
  assert.deepEqual(
    [...closeReadyAcceptanceReviewRunIds(runs, { iterationId: 'iter-002', taskGraphRef })],
    ['run-iteration-acceptance'],
  );
  runs[0].status = 'blocked';
  assert.deepEqual(
    [...closeReadyAcceptanceReviewRunIds(runs, { iterationId: 'iter-002', taskGraphRef })],
    [],
  );
});

test('resumable handoff retains run history while portable handoff rejects legacy runs', () => {
  const runs = [entry('run-finished'), entry('run-active', 'started')];
  assert.deepEqual(
    selectHandoffRunEntries({ runs }, new Set(), 'resumable'),
    runs,
  );
  assert.throws(
    () => assertCanonicalPortableRun({
      runId: 'run-legacy',
      status: 'finished',
      schema_version: 'p2a.run.v1',
    }),
    /p2a runs migrate-schema/,
  );
});

test('portable target validation checks the emitted gate bundle and run store', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'p2a-portable-target-'));
  const projectId = 'webhook-api-service';
  const artifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', projectId);
  try {
    cpSync(path.join(E2E_FIXTURE_ROOT, projectId), artifactRoot, { recursive: true });
    assert.deepEqual(validatePortableHandoffTarget(targetRoot, projectId), {
      artifactRoot,
      runCount: 0,
      milestoneReviewCount: 0,
    });

    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      path.join(runsDir, 'run-index.json'),
      `${JSON.stringify(missingRunIndex(projectId), null, 2)}\n`,
      'utf8',
    );
    assert.throws(
      () => validatePortableHandoffTarget(targetRoot, projectId),
      /run-missing\.json is missing/,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('portable handoff preserves and revalidates reference provenance sidecars', () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-portable-reference-source-'));
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'p2a-portable-reference-target-'));
  const projectId = 'webhook-api-service';
  const sourceArtifacts = path.join(sourceRoot, projectId);
  try {
    cpSync(path.join(E2E_FIXTURE_ROOT, projectId), sourceArtifacts, { recursive: true });
    const intakePath = path.join(sourceArtifacts, 'gate-a-intake', 'intake.json');
    const specPath = path.join(sourceArtifacts, 'gate-b-spec', 'spec.json');
    const snapshotPath = path.join(
      sourceArtifacts,
      'gate-a-intake',
      'reference-bundle-snapshot.json',
    );
    const usagePath = path.join(
      sourceArtifacts,
      'gate-b-spec',
      'reference-bundle-usage.json',
    );
    const captureRoot = path.join(
      sourceArtifacts,
      'gate-a-intake',
      'reference-sources',
      'files',
    );
    const capturedBundlePath = path.join(captureRoot, 'p2a-reference-bundle.json');
    const capturedEntryPath = path.join(captureRoot, 'idea.md');
    const capturedReferencePath = path.join(captureRoot, 'prototype.html');
    mkdirSync(captureRoot, { recursive: true });
    writeFileSync(capturedEntryPath, 'Build a portable webhook service from approved references.\n', 'utf8');
    writeFileSync(capturedReferencePath, '<!doctype html><title>Portable reference</title>\n', 'utf8');
    writeJson(capturedBundlePath, {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [{
        id: 'REF-1',
        path: 'prototype.html',
        kind: 'html',
        sha256: fileSha256(capturedReferencePath),
        load_when: 'Gate B needs the approved prototype.',
        description: 'Approved prototype metadata.',
      }],
    });
    const snapshot = {
      schema_version: 'p2a.reference_bundle_snapshot.v1',
      source_bundle_ref: 'reference-sources/files/p2a-reference-bundle.json',
      source_bundle_sha256: fileSha256(capturedBundlePath),
      entry_ref: 'reference-sources/files/idea.md',
      entry_sha256: fileSha256(capturedEntryPath),
      references: [{
        id: 'REF-1',
        path: 'reference-sources/files/prototype.html',
        kind: 'html',
        sha256: fileSha256(capturedReferencePath),
        load_when: 'Gate B needs the approved prototype.',
        description: 'Approved prototype metadata.',
      }],
    };
    writeJson(snapshotPath, snapshot);
    const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
    intake.approval_audit.approved_artifacts.push(
      'gate-a-intake/reference-bundle-snapshot.json',
    );
    intake.approval_audit.approval_note += `\nSidecar SHA-256: gate-a-intake/reference-bundle-snapshot.json ${fileSha256(snapshotPath)}`;
    writeJson(intakePath, intake);

    writeJson(usagePath, {
      schema_version: 'p2a.reference_bundle_usage.v1',
      source_snapshot_ref: '../gate-a-intake/reference-bundle-snapshot.json',
      source_snapshot_sha256: fileSha256(snapshotPath),
      source_bundle_ref: snapshot.source_bundle_ref,
      source_bundle_sha256: snapshot.source_bundle_sha256,
      inspected_references: [],
    });
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.approval_audit.approved_artifacts.push(
      'gate-b-spec/reference-bundle-usage.json',
    );
    spec.approval_audit.approval_note += `\nSidecar SHA-256: gate-b-spec/reference-bundle-usage.json ${fileSha256(usagePath)}`;
    writeJson(specPath, spec);

    const result = runHandoff([
      '--project-id', projectId,
      '--artifacts', sourceArtifacts,
      '--target', targetRoot,
      '--overwrite',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const targetArtifacts = path.join(targetRoot, '.plan2agent', 'artifacts', projectId);
    assert.equal(existsSync(path.join(
      targetArtifacts,
      'gate-a-intake',
      'reference-bundle-snapshot.json',
    )), true);
    assert.equal(existsSync(path.join(
      targetArtifacts,
      'gate-b-spec',
      'reference-bundle-usage.json',
    )), true);
    assert.equal(existsSync(path.join(
      targetArtifacts,
      'gate-a-intake',
      snapshot.references[0].path,
    )), true);
    assert.doesNotThrow(() => validatePortableHandoffTarget(targetRoot, projectId));
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('handoff rolls back emitted files when portable target validation fails', () => {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'p2a-portable-rollback-'));
  const projectId = 'webhook-api-service';
  const artifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', projectId);
  const runsDir = path.join(artifactRoot, 'runs');
  const runIndexPath = path.join(runsDir, 'run-index.json');
  try {
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      runIndexPath,
      `${JSON.stringify(missingRunIndex(projectId), null, 2)}\n`,
      'utf8',
    );
    const result = runHandoff([
      '--project-id', projectId,
      '--artifacts', path.join(E2E_FIXTURE_ROOT, projectId),
      '--target', targetRoot,
      '--overwrite',
    ]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /run-missing\.json is missing/);
    assert.equal(
      existsSync(path.join(artifactRoot, 'gate-b-spec', 'spec.json')),
      false,
      'post-write validation failure must remove newly emitted handoff files',
    );
    assert.equal(existsSync(runIndexPath), true, 'rollback must preserve pre-existing target files');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
