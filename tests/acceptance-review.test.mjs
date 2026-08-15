import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateAcceptanceReviewData,
  validateRunsDir,
} from '../scripts/validate_artifacts.mjs';
import { validateCloseReadyAcceptanceEvidence } from '../scripts/p2a_iteration.mjs';
import { runFilePath, runSidecarPath } from '../scripts/p2a_run_paths.mjs';
import { runExecute, runIteration, runRuns } from './helpers/fixtures.mjs';

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function acceptanceSidecar(run, verification, options = {}) {
  return {
    schema_version: 'p2a.acceptance_review.v1',
    iteration_id: run.iterationId,
    source_spec_ref: run.sourceSpecRef,
    cases: run.acceptanceReview.criteria.map((criterion, index) => ({
      criterion_ref: criterion.ref,
      command: verification.command,
      source: verification.source,
      exitCode: verification.exitCode,
      stdoutTail: verification.stdoutTail ?? '',
      verdict: options.block && index === 0 ? 'fail' : 'pass',
    })),
    verdict: options.block ? 'block' : 'confirm_behavior',
    unmet: options.block ? ['The command reported 0 commits, so useful digest behavior was not demonstrated.'] : [],
  };
}

function managedNonUiIteration() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-acceptance-review-'));
  const artifactRoot = path.join(
    workspaceRoot,
    '.plan2agent',
    'artifacts',
    'webhook-api-service',
  );
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
  const init = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'iter-001']);
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'iter-001',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  for (const task of graph.tasks) {
    task.status = 'done';
    delete task.visualImpact;
  }
  writeJson(graphPath, graph);
  return { workspaceRoot, artifactRoot, graphPath, graph };
}

test('acceptance review schema rejects manual or unexecuted evidence', () => {
  const base = {
    schema_version: 'p2a.acceptance_review.v1',
    iteration_id: 'v1-mvp',
    source_spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
    cases: [{
      criterion_ref: 'product.success_criteria[0]',
      command: 'node bin/weekly-digest.js --days 7',
      source: 'command',
      exitCode: 0,
      stdoutTail: '1 commit',
      verdict: 'pass',
    }],
    verdict: 'confirm_behavior',
    unmet: [],
  };
  assert.throws(
    () => validateAcceptanceReviewData({
      ...base,
      cases: [{ ...base.cases[0], source: 'manual' }],
    }),
    /source must be one of/,
  );
  assert.throws(
    () => validateAcceptanceReviewData({
      ...base,
      cases: [{ ...base.cases[0], exitCode: null }],
    }),
    /exitCode must be integer/,
  );
});

test('execute accept seals real command evidence and gates close-ready validation', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-final-acceptance-review';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'gemini',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /final functional acceptance review/);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const runPath = runFilePath(runsDir, runId);
    let run = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(run.runKind, 'final_acceptance_review');
    assert.equal(run.isolation.mode, 'none');
    assert.deepEqual(run.changedFiles, []);
    assert.ok(run.acceptanceReview.criteria.length > 0);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', "custom:node -e \"console.log('0 commits')\"",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    const verification = run.verification.at(-1);
    assert.equal(verification.exitCode, 0);
    assert.equal(verification.source, 'command');

    const sidecarPath = runSidecarPath(runsDir, runId, '.acceptance-review.json');
    writeJson(sidecarPath, acceptanceSidecar(run, verification, { block: true }));
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /acceptance review blocked/);
    assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).status, 'started');

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', "custom:node -e \"console.log('behavior confirmed for configured identity')\"",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    writeJson(sidecarPath, acceptanceSidecar(run, run.verification.at(-1)));

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(run.status, 'finished');
    assert.match(run.acceptanceReviewEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(validateRunsDir(runsDir).projectId, 'webhook-api-service');

    result = runIteration([
      'validate',
      '--artifacts', fixture.artifactRoot,
      '--require-close-ready',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const stalePath = path.join(fixture.workspaceRoot, 'src', 'changed-after-acceptance.js');
    mkdirSync(path.dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, 'export const stale = true;\n', 'utf8');
    result = runIteration([
      'validate',
      '--artifacts', fixture.artifactRoot,
      '--require-close-ready',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /canonical workspace revision/);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('blocked acceptance review reopens its remediation owner', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-blocked-acceptance-review';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'gemini',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /--no-task-transition/);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--status', 'blocked',
      '--failure-class', 'implementation_incomplete',
      '--repro-step', 'Run the Gate B behavior command and observe that the expected behavior is absent.',
      '--localization', 'The integrated behavior does not satisfy the acceptance review criterion.',
      '--guard', 'Correct the behavior before starting another final acceptance review.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Reopening task task-001 after blocked final acceptance review/);

    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks.find((task) => task.id === 'task-001').status, 'todo');
    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.status, 'blocked');
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance policy off preserves the previous non-UI close behavior', () => {
  const fixture = managedNonUiIteration();
  try {
    assert.equal(validateCloseReadyAcceptanceEvidence({
      artifactRoot: fixture.artifactRoot,
      activeIteration: 'iter-001',
      taskGraphPath: fixture.graphPath,
      taskGraph: fixture.graph,
      reviewPasses: { acceptance: 'off' },
    }), 0);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance opt-in does not add a review until one is explicitly started', () => {
  const fixture = managedNonUiIteration();
  try {
    for (const reviewPasses of [{ acceptance: 'opt_in' }, {}]) {
      assert.equal(validateCloseReadyAcceptanceEvidence({
        artifactRoot: fixture.artifactRoot,
        activeIteration: 'iter-001',
        taskGraphPath: fixture.graphPath,
        taskGraph: fixture.graph,
        reviewPasses,
      }), 0);
    }
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});
