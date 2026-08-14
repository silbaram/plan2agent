import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
