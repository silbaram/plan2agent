import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateRunsDir, validateSchema, validateTaskGraph } from '../scripts/validate_artifacts.mjs';
import { runFilePath } from '../scripts/p2a_run_paths.mjs';
import { withRunStoreLocks } from '../scripts/p2a_run_store.mjs';
import {
  EXECUTE_CLI,
  ROOT,
  runExecute,
  runHandoff,
  runIteration,
  runP2a,
  runRuns,
  runTasks,
} from './helpers/fixtures.mjs';

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const EXECUTION_RESULT_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/execution-result.schema.json', import.meta.url),
  'utf8',
));

function runExecuteAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXECUTE_CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function adaptiveArtifact(options = {}) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-adaptive-execution-'));
  const artifactRoot = path.join(workspaceRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
  if (options.removeGraph !== false) {
    rmSync(path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'));
  }
  const graphPath = path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  return { workspaceRoot, artifactRoot, graphPath };
}

function initialize(fixture) {
  const init = runIteration(['init', '--artifacts', fixture.artifactRoot, '--iteration-id', 'iter-001']);
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
  fixture.graphPath = path.join(
    fixture.artifactRoot,
    'iterations',
    'iter-001',
    'gate-c-task-graph',
    'task-graph.json',
  );
}

test('execution JSON returns one validated result document for start and resume', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One bounded change exercises the machine-readable continuation contract.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const runId = 'run-json-execution-result';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
      '--json',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const started = JSON.parse(result.stdout);
    validateSchema(started, EXECUTION_RESULT_SCHEMA);
    assert.deepEqual(started, {
      schema_version: 'p2a.execution_result.v1',
      command: 'start',
      outcome: 'succeeded',
      taskId: 'task-001',
      runId,
      runStatus: 'started',
      mode: 'direct',
      runKind: null,
    });

    result = runExecute([
      'resume',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--json',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const resumed = JSON.parse(result.stdout);
    validateSchema(resumed, EXECUTION_RESULT_SCHEMA);
    assert.equal(resumed.command, 'resume');
    assert.equal(resumed.runStatus, 'started');

    result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'Prepare intentionally has no continuation result.',
      '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--json is only supported/);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('direct execution prepares one synthetic work item and records its strategy', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One localized service objective has one bounded verification cycle.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const graph = validateTaskGraph(
      fixture.graphPath,
      path.join(fixture.artifactRoot, 'gate-b-spec', 'spec.json'),
      { artifactRoot: fixture.artifactRoot },
    );
    assert.equal(graph.execution.mode, 'direct');
    assert.equal(graph.execution.syntheticWorkItem, true);
    assert.equal(graph.tasks.length, 1);
    assert.equal(
      graph.tasks[0].intent,
      'Users can rely on this approved outcome: Expose one HTTP endpoint for partner webhook ingestion.',
    );

    const prompt = runTasks(['prompt', '--graph', fixture.graphPath, 'task-001']);
    assert.equal(prompt.status, 0, `${prompt.stdout}\n${prompt.stderr}`);
    assert.match(prompt.stdout, /Approved execution envelope:/);
    assert.match(prompt.stdout, /Intent: Users can rely on this approved outcome: Expose one HTTP endpoint/u);
    assert.doesNotMatch(prompt.stdout, /Acceptance criteria:/);
    assert.doesNotMatch(prompt.stdout, /Task description:/);
    assert.doesNotMatch(prompt.stdout, /Referenced spec context:/);
    initialize(fixture);

    const runId = 'run-direct-execution';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /executionMode: direct/);
    assert.match(result.stdout, /\[한눈에\]/u);
    assert.match(result.stdout, /이번 작업이 끝나면: Users can rely on this approved outcome: Expose one HTTP endpoint/u);
    assert.ok(result.stdout.indexOf('[한눈에]') < result.stdout.indexOf('- project:'));
    assert.ok(result.stdout.indexOf('[실행 명령]') < result.stdout.indexOf('[세부 계약]'));

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /already finished.*only run while a run is started/);

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.mode, 'direct');
    assert.equal(run.status, 'finished');
    assert.equal(validateRunsDir(path.join(fixture.artifactRoot, 'runs')).projectId, 'webhook-api-service');

    result = runExecute(['resume', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /run is already closed/);
    assert.doesNotMatch(result.stdout, /Manual launcher prompt/);

    const handoffTarget = path.join(fixture.workspaceRoot, 'handoff-target');
    result = runHandoff([
      '--project-id', 'webhook-api-service',
      '--artifacts', fixture.artifactRoot,
      '--target', handoffTarget,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const handedOffGraph = JSON.parse(readFileSync(path.join(
      handoffTarget,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
      'gate-c-task-graph',
      'task-graph.json',
    ), 'utf8'));
    assert.equal(handedOffGraph.execution.mode, 'direct');
    assert.equal(handedOffGraph.execution.syntheticWorkItem, true);
    const handedOffRunsDir = path.join(
      handoffTarget,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
      'runs',
    );
    const handedOffRunIndex = JSON.parse(readFileSync(path.join(handedOffRunsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(handedOffRunIndex.runs.map((entry) => entry.runId), [runId]);
    validateRunsDir(handedOffRunsDir);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('planned execution verifies ordered checkpoints before finish', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'planned',
      '--selection-rationale', 'Two ordered outcomes make interruption recovery explicit.',
      '--milestone', 'milestone-contract|Contract behavior is implemented|node -e "process.exit(0)"',
      '--milestone', 'milestone-regression|Regression coverage is complete|node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const runId = 'run-planned-execution';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /cannot finish before checkpoint milestone-contract/);

    result = runRuns([
      'checkpoint', '--artifacts', fixture.artifactRoot, '--run-id', runId, '--milestone', 'milestone-regression',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /verify milestone-contract first/);

    result = runRuns([
      'checkpoint', '--artifacts', fixture.artifactRoot, '--run-id', runId, '--milestone', 'milestone-contract',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['resume', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /nextMilestone: milestone-regression/);

    result = runRuns([
      'checkpoint', '--artifacts', fixture.artifactRoot, '--run-id', runId, '--milestone', 'milestone-regression',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.mode, 'planned');
    assert.deepEqual(run.milestones.map(({ id, status }) => ({ id, status })), [
      { id: 'milestone-contract', status: 'verified' },
      { id: 'milestone-regression', status: 'verified' },
    ]);
    assert.deepEqual(run.verification.map((item) => item.milestoneId), [
      'milestone-contract',
      'milestone-regression',
    ]);
    validateRunsDir(path.join(fixture.artifactRoot, 'runs'));
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('planned checkpoint failure is immutable and cannot masquerade as a successful retry', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'planned',
      '--selection-rationale', 'Two ordered outcomes exercise failed checkpoint recovery.',
      '--milestone', 'milestone-contract|Contract behavior is implemented|node -e "process.exit(require(\'node:fs\').existsSync(\'checkpoint-ready\') ? 0 : 1)"',
      '--milestone', 'milestone-regression|Regression coverage is complete|node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const runId = 'run-planned-checkpoint-failure';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runRuns([
      'checkpoint', '--artifacts', fixture.artifactRoot, '--run-id', runId, '--milestone', 'milestone-contract',
    ]);
    assert.notEqual(result.status, 0);
    writeFileSync(path.join(fixture.workspaceRoot, 'checkpoint-ready'), 'ready\n');

    result = runRuns([
      'checkpoint', '--artifacts', fixture.artifactRoot, '--run-id', runId, '--milestone', 'milestone-contract',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /immutable failed evidence/);
    assert.match(`${result.stdout}\n${result.stderr}`, /start a new retry run/);

    result = runExecute(['resume', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /checkpointFailure: milestone-contract:failed/);
    assert.doesNotMatch(result.stdout, /nextMilestone:/);
    assert.doesNotMatch(result.stdout, /Manual launcher prompt/);

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.milestones[0].status, 'pending');
    assert.deepEqual(run.verification.map(({ milestoneId, status }) => ({ milestoneId, status })), [
      { milestoneId: 'milestone-contract', status: 'failed' },
    ]);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('prepare rejects lifecycle options instead of silently ignoring them', () => {
  const fixture = adaptiveArtifact();
  try {
    const result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One bounded outcome.',
      '--run-id', 'ignored-run-id',
      '--workspace', fixture.workspaceRoot,
      '--isolation', 'branch',
      '--branch', 'ignored-branch',
      '--create-isolation',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /prepare does not support option\(s\)/);
    assert.equal(existsSync(fixture.graphPath), false);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('iterative prepare shares the artifact-state lock with Gate C promotion', async () => {
  const fixture = adaptiveArtifact({ removeGraph: false });
  try {
    initialize(fixture);
    rmSync(fixture.graphPath);
    let preparePromise;
    withRunStoreLocks([path.join(fixture.artifactRoot, 'iterations')], () => {
      preparePromise = runExecuteAsync([
        'prepare',
        '--artifacts', fixture.artifactRoot,
        '--mode', 'direct',
        '--selection-rationale', 'One bounded outcome.',
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        existsSync(fixture.graphPath),
        false,
        'prepare wrote the canonical graph before acquiring the artifact-state lock',
      );
    });

    const result = await preparePromise;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(fixture.graphPath), true);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('resume and verification reject Gate B source drift before producing new execution evidence', () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-execution-envelope-drift-'));
  try {
    const graphPath = path.join(workspaceRoot, 'task-graph.json');
    const specPath = path.join(workspaceRoot, 'spec.json');
    const graph = JSON.parse(readFileSync(
      path.resolve('fixtures/webhook-api-service/task-graph.json'),
      'utf8',
    ));
    graph.sourceSpec = specPath;
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    writeFileSync(
      specPath,
      readFileSync(path.resolve('fixtures/webhook-api-service/spec.approved.json'), 'utf8'),
    );

    const runId = 'run-execution-envelope-drift';
    let result = runExecute([
      'start',
      '--graph', graphPath,
      '--spec', specPath,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const changedSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    changedSpec.product.problem = `${changedSpec.product.problem} Changed after run start.`;
    writeFileSync(specPath, `${JSON.stringify(changedSpec, null, 2)}\n`);

    result = runExecute(['resume', '--graph', graphPath, '--spec', specPath, '--run-id', runId]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /resume blocked.*recorded execution contract/);

    const markerPath = path.join(workspaceRoot, 'verification-ran');
    result = runRuns([
      'verify',
      '--graph', graphPath,
      '--run-id', runId,
      '--verify-command', `custom:node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')"`,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(markerPath), false);

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(workspaceRoot, 'runs'), runId),
      'utf8',
    ));
    assert.deepEqual(run.verification, []);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('prepare refuses to recreate a missing canonical graph after execution history exists', () => {
  const fixture = adaptiveArtifact({ removeGraph: false });
  try {
    initialize(fixture);
    const runId = 'run-before-canonical-graph-loss';
    let result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    rmSync(fixture.graphPath);

    const next = runP2a([
      'next',
      '--target', fixture.workspaceRoot,
      '--project-id', 'webhook-api-service',
      '--json',
    ]);
    assert.equal(next.status, 0, `${next.stdout}\n${next.stderr}`);
    const nextAction = JSON.parse(next.stdout);
    assert.equal(nextAction.state, 'started_run_contract_drift');
    assert.equal(nextAction.command.kind, 'approval');
    assert.match(nextAction.reason, new RegExp(runId));

    result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One bounded outcome.',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /cannot recreate a missing Gate C graph after execution history exists/);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(runId));
    assert.equal(existsSync(fixture.graphPath), false);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});
