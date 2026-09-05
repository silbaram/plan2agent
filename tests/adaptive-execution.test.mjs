import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('review remediation keeps completed work in the active iteration with immutable linked evidence', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One completed task needs a bounded in-iteration review correction.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const sourceRunId = 'run-review-remediation-source';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', sourceRunId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const sourceRunPath = runFilePath(runsDir, sourceRunId);
    const immutableSource = readFileSync(sourceRunPath);
    const remediationRunId = 'run-review-remediation-fix';
    const finding = 'The completed handler misses the reviewed malformed-signature branch.';
    result = runExecute([
      'remediate',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', remediationRunId,
      '--workspace', fixture.workspaceRoot,
      '--finding', finding,
      '--review-ref', 'https://example.test/reviews/201#finding-1',
      '--json',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const executionResult = JSON.parse(result.stdout);
    validateSchema(executionResult, EXECUTION_RESULT_SCHEMA);
    assert.equal(executionResult.command, 'remediate');
    assert.equal(executionResult.runId, remediationRunId);

    let graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'in_progress');
    let remediationRun = JSON.parse(readFileSync(runFilePath(runsDir, remediationRunId), 'utf8'));
    assert.equal(remediationRun.sourceLayout, 'iteration');
    assert.equal(remediationRun.iterationId, 'iter-001');
    assert.deepEqual(remediationRun.reviewRemediation, {
      sourceRunId,
      reviewRef: 'https://example.test/reviews/201#finding-1',
      finding,
    });
    assert.deepEqual(readFileSync(sourceRunPath), immutableSource);
    validateRunsDir(runsDir);

    result = runRuns([
      'record',
      '--artifacts', fixture.artifactRoot,
      '--run-id', remediationRunId,
      '--implementation-interruption', 'Confirmed the reviewed edge case before applying the correction.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    remediationRun = JSON.parse(readFileSync(runFilePath(runsDir, remediationRunId), 'utf8'));
    assert.deepEqual(remediationRun.interruptions.map(({ type, summary }) => ({ type, summary })), [{
      type: 'implementation_decision',
      summary: 'Confirmed the reviewed edge case before applying the correction.',
    }]);
    assert.deepEqual(readFileSync(sourceRunPath), immutableSource);

    const activeNext = runP2a([
      'next', '--target', fixture.workspaceRoot, '--json', '--contract', 'v2',
    ]);
    assert.equal(activeNext.status, 0, `${activeNext.stdout}\n${activeNext.stderr}`);
    const activePayload = JSON.parse(activeNext.stdout);
    assert.equal(activePayload.state, 'run_started');
    assert.equal(activePayload.command.argv.includes('close'), false);

    const status = runExecute([
      'status', '--artifacts', fixture.artifactRoot, '--run-id', remediationRunId,
    ]);
    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, new RegExp(`reviewRemediation: ${sourceRunId}`));

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', remediationRunId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', remediationRunId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'done');
    remediationRun = JSON.parse(readFileSync(runFilePath(runsDir, remediationRunId), 'utf8'));
    assert.equal(remediationRun.status, 'finished');
    assert.deepEqual(readFileSync(sourceRunPath), immutableSource);
    const index = validateRunsDir(runsDir);
    assert.deepEqual(
      index.tasks.find((entry) => entry.taskId === 'task-001'),
      {
        taskId: 'task-001',
        runIds: [sourceRunId, remediationRunId],
        latestRunId: remediationRunId,
      },
    );

    let closeReady = runP2a([
      'next', '--target', fixture.workspaceRoot, '--json', '--contract', 'v2',
    ]);
    assert.equal(closeReady.status, 0, `${closeReady.stdout}\n${closeReady.stderr}`);
    let closePayload = JSON.parse(closeReady.stdout);
    if (closePayload.state === 'final_verification_required') {
      const finalRunId = 'run-review-remediation-final';
      writeFileSync(
        path.join(fixture.artifactRoot, 'project.config.json'),
        `${JSON.stringify({
          testCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`,
        }, null, 2)}\n`,
        'utf8',
      );
      result = runExecute([
        'verify-final',
        '--artifacts', fixture.artifactRoot,
        '--run-id', finalRunId,
        '--workspace', fixture.workspaceRoot,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      result = runRuns([
        'verify',
        '--artifacts', fixture.artifactRoot,
        '--run-id', finalRunId,
        '--test',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', finalRunId]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      closeReady = runP2a([
        'next', '--target', fixture.workspaceRoot, '--json', '--contract', 'v2',
      ]);
      assert.equal(closeReady.status, 0, `${closeReady.stdout}\n${closeReady.stderr}`);
      closePayload = JSON.parse(closeReady.stdout);
    }
    assert.equal(closePayload.state, 'iteration_review_or_close_required');
    assert.equal(closePayload.retrospective.candidateCount, 0);

    result = runIteration(['close', '--artifacts', fixture.artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const closedGraph = readFileSync(fixture.graphPath);
    const closedIndex = readFileSync(path.join(runsDir, 'run-index.json'));
    result = runExecute([
      'remediate',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--finding', 'This finding arrived after the iteration archive.',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already archived.*maintenance or open a new iteration/i);
    assert.deepEqual(readFileSync(fixture.graphPath), closedGraph);
    assert.deepEqual(readFileSync(path.join(runsDir, 'run-index.json')), closedIndex);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('review remediation restores a completed task when linked run creation fails', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'A failed remediation start must preserve the completed task state.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const sourceRunId = 'run-review-remediation-rollback-source';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', sourceRunId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const sourceRunPath = runFilePath(runsDir, sourceRunId);
    const immutableSource = readFileSync(sourceRunPath);
    result = runExecute([
      'remediate',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', 'run-review-remediation-rollback-failure',
      '--workspace', fixture.workspaceRoot,
      '--finding', 'Exercise atomic rollback after the task claim.',
      '--changed-file', '../outside-workspace.js',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed file (?:resolves outside|escapes) the workspace/i);
    assert.match(result.stderr, /returned to done/i);

    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'done');
    assert.deepEqual(readFileSync(sourceRunPath), immutableSource);
    const index = validateRunsDir(runsDir);
    assert.deepEqual(index.tasks.find((entry) => entry.taskId === 'task-001'), {
      taskId: 'task-001',
      runIds: [sourceRunId],
      latestRunId: sourceRunId,
    });
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('review remediation retry preserves its source lineage in active-only run storage', () => {
  const fixture = adaptiveArtifact();
  try {
    writeFileSync(
      path.join(fixture.workspaceRoot, '.plan2agent', 'project.config.json'),
      `${JSON.stringify({
        runTracking: { persistence: 'active_only' },
        proposals: { enabled: false },
      }, null, 2)}\n`,
      'utf8',
    );
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'A review-remediation retry must retain its source relationship.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const sourceRunId = 'run-review-remediation-retry-source';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', sourceRunId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', sourceRunId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const sourceRunPath = runFilePath(runsDir, sourceRunId);
    const immutableSource = readFileSync(sourceRunPath);
    const finding = 'The first review correction still fails its regression check.';
    const failedRunId = 'run-review-remediation-retry-failed';
    result = runExecute([
      'remediate',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', failedRunId,
      '--workspace', fixture.workspaceRoot,
      '--finding', finding,
      '--review-ref', 'review-201-retry',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', failedRunId,
      '--verify-command', 'custom:node -e "process.exit(1)"',
    ]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', failedRunId,
      '--status', 'failed',
      '--failure-class', 'verification_failed',
      '--retryable', 'yes',
      '--needs-user-decision', 'false',
      '--failure-source', 'owner',
      '--repro-command', 'node -e "process.exit(1)"',
      '--localization', 'The review correction does not satisfy its regression check.',
      '--localized-file', 'package.json',
      '--guard', 'The review regression check must pass before completion.',
    ]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    let graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'todo');

    const retryRunId = 'run-review-remediation-retry-success';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', retryRunId,
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    let retryRun = JSON.parse(readFileSync(runFilePath(runsDir, retryRunId), 'utf8'));
    assert.deepEqual(retryRun.reviewRemediation, {
      sourceRunId,
      reviewRef: 'review-201-retry',
      finding,
    });
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', retryRunId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', retryRunId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'done');
    retryRun = JSON.parse(readFileSync(runFilePath(runsDir, retryRunId), 'utf8'));
    assert.equal(retryRun.status, 'finished');
    assert.deepEqual(readFileSync(sourceRunPath), immutableSource);
    assert.equal(existsSync(runFilePath(runsDir, failedRunId)), false);
    const index = validateRunsDir(runsDir);
    assert.deepEqual(index.tasks.find((entry) => entry.taskId === 'task-001'), {
      taskId: 'task-001',
      runIds: [sourceRunId, retryRunId],
      latestRunId: retryRunId,
    });
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
    assert.equal(graph.tasks[0].sourceSpecRefs.includes('implementation.architecture'), true);
    assert.equal(graph.tasks[0].sourceSpecRefs.includes('implementation.interfaces'), true);
    assert.equal(graph.tasks[0].sourceSpecRefs.includes('implementation.dependencies'), true);
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
    assert.doesNotMatch(result.stdout, /execute finish[^\n]*--(?:test|lint|typecheck)/);

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

test('retryable blocked run without a user decision returns the task to todo with class-specific detail', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'Exercise automatic retry routing after a transient test failure.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const runId = 'run-retryable-test-flake';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--status', 'blocked',
      '--failure-class', 'test_flake',
      '--repro-step', 'Run the transient check once.',
      '--guard', 'Retry the same deterministic check.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Returning task task-001 to todo/);

    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'todo');
    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.status, 'blocked');
    assert.deepEqual(run.verification, []);
    assert.deepEqual(run.failure, {
      class: 'test_flake',
      retryable: 'yes',
      needsUserDecision: false,
      source: 'owner',
    });
    assert.ok(run.reproduction);
    assert.ok(run.guard);
    assert.equal('localization' in run, false);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /already applied: task-001 is ready for retry/);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('a bounded recovery decision is consumed into the next run and launcher prompt', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'Exercise durable bounded recovery context.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);

    const blockedRunId = 'run-needs-scope-decision';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', blockedRunId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', blockedRunId,
      '--status', 'blocked',
      '--failure-class', 'scope_violation',
      '--retryable', 'no',
      '--needs-user-decision', 'true',
      '--repro-step', 'The implementation changed an API outside the approved scope.',
      '--localization', 'The public API change is outside the approved scope.',
      '--guard', 'Keep the retry inside the approved API scope.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const decision = 'Revert the public API change and retry only the approved internal behavior.';
    result = runTasks([
      'todo',
      '--artifacts', fixture.artifactRoot,
      'task-001',
      '--note', decision,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const retryRunId = 'run-bounded-retry';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', retryRunId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(decision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), retryRunId),
      'utf8',
    ));
    assert.ok(run.notes.includes(`TASK_RECOVERY_CONTEXT: ${decision}`));
    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks[0].status, 'in_progress');
    assert.equal(graph.tasks[0].blockNote, undefined);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('official finish runs every configured check still missing for the current revision', () => {
  const fixture = adaptiveArtifact();
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'Exercise configured-check completion without optional placeholders.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    initialize(fixture);
    const launcherDir = path.join(fixture.workspaceRoot, 'tools');
    const testLauncher = path.join(launcherDir, 'configured-test');
    mkdirSync(launcherDir, { recursive: true });
    writeFileSync(testLauncher, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(testLauncher, 0o755);
    const configPath = path.join(fixture.workspaceRoot, '.plan2agent', 'project.config.json');
    writeFileSync(configPath, `${JSON.stringify({
      testCommand: './tools/configured-test',
      lintCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    }, null, 2)}\n`, 'utf8');

    const runId = 'run-configured-completion';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--test',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    let run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.verification[0].originalCommand, './tools/configured-test');

    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Running configured verification required/);
    run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.deepEqual(
      run.verification.map((item) => item.type),
      ['test', 'lint'],
      JSON.stringify(run.verification, null, 2),
    );
    assert.equal(run.verification[0].originalCommand, './tools/configured-test');
    assert.ok(run.verification.every((item) => item.status === 'passed'));
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

test('planned checkpoint failure is preserved while a successful same-run retry advances the milestone', () => {
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
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute(['resume', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /checkpointRetry:/);
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
    assert.equal(run.status, 'finished');
    assert.deepEqual(run.milestones.map(({ id, status }) => ({ id, status })), [
      { id: 'milestone-contract', status: 'verified' },
      { id: 'milestone-regression', status: 'verified' },
    ]);
    assert.deepEqual(run.verification.map(({ milestoneId, status }) => ({ milestoneId, status })), [
      { milestoneId: 'milestone-contract', status: 'failed' },
      { milestoneId: 'milestone-contract', status: 'passed' },
      { milestoneId: 'milestone-regression', status: 'passed' },
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
