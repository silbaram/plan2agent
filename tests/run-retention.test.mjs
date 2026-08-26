import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { captureGitState, pruneIndexedRunEvidence } from '../scripts/p2a_runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ITERATION_CLI = path.join(ROOT, 'scripts', 'p2a_iteration.mjs');
const EXECUTE_CLI = path.join(ROOT, 'scripts', 'p2a_execute.mjs');
const RUNS_CLI = path.join(ROOT, 'scripts', 'p2a_runs.mjs');
const E2E_FIXTURE = path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service');

function runEntry(runId, taskId, iterationId, status, runRef) {
  return {
    runId,
    taskId,
    iterationId,
    status,
    agentTool: 'manual',
    workspaceRef: '.',
    taskGraphRef: `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
    runRef,
    runKind: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    finishedAt: status === 'started' ? null : '2026-08-23T00:01:00.000Z',
  };
}

function writeIndex(runsDir, entries, projectId = 'sample', retrospective = null) {
  const taskEntries = new Map();
  for (const entry of entries) {
    const task = taskEntries.get(entry.taskId) ?? {
      taskId: entry.taskId,
      runIds: [],
      latestRunId: null,
    };
    task.runIds.push(entry.runId);
    task.latestRunId = entry.runId;
    taskEntries.set(entry.taskId, task);
  }
  const index = {
    schema_version: 'p2a.run_index.v1',
    projectId,
    runs: entries,
    tasks: [...taskEntries.values()],
  };
  if (retrospective) index.retrospective = retrospective;
  writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

function retrospective(iterationId, runCount = 1) {
  return {
    iterations: [{
      iterationId,
      runCount,
      reasonCounts: { superseded: runCount, completed_maintenance: 0 },
      statusCounts: { finished: runCount, failed: 0, blocked: 0 },
      verificationCount: 0,
      verificationDuration: { sampleCount: 0, totalMs: 0, maxMs: 0 },
      verificationStatusCounts: { passed: 0, failed: 0, skipped: 0, not_run: 0, unavailable: 0 },
      interruptionCounts: {
        implementation_decision: 0,
        user_correction: 0,
        gate_return_valid: 0,
        gate_return_invalid: 0,
      },
    }],
  };
}

function writeEvidence(runsDir, entry, sidecars = []) {
  const runPath = path.join(runsDir, entry.runRef);
  mkdirSync(path.dirname(runPath), { recursive: true });
  writeFileSync(runPath, '{}\n', 'utf8');
  for (const suffix of sidecars) {
    writeFileSync(runPath.replace(/\.json$/, suffix), '{}\n', 'utf8');
  }
}

function runCli(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function initializedIterationProject(persistence) {
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-project-'));
  cpSync(E2E_FIXTURE, artifactRoot, { recursive: true });
  mkdirSync(path.join(artifactRoot, '.plan2agent'), { recursive: true });
  writeFileSync(path.join(artifactRoot, '.plan2agent', 'project.config.json'), `${JSON.stringify({
    runTracking: { persistence },
    devExecution: { reviewPasses: { acceptance: 'off' } },
  }, null, 2)}\n`, 'utf8');
  const initialized = runCli(ITERATION_CLI, [
    'init',
    '--artifacts', artifactRoot,
    '--iteration-id', 'v1-mvp',
  ]);
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  return artifactRoot;
}

function initializedCanonicalIterationProject(persistence) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-canonical-'));
  const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(E2E_FIXTURE, artifactRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, '.plan2agent', 'project.config.json'), `${JSON.stringify({
    runTracking: { persistence },
    devExecution: { reviewPasses: { acceptance: 'off' } },
  }, null, 2)}\n`, 'utf8');
  const initialized = runCli(ITERATION_CLI, [
    'init',
    '--artifacts', artifactRoot,
    '--iteration-id', 'v1-mvp',
  ]);
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  return { projectRoot, artifactRoot };
}

test('Git metadata capture treats a spawn error as unavailable even when status is zero', () => {
  const spawnError = Object.assign(new Error('spawnSync git EPERM'), { code: 'EPERM' });
  assert.equal(captureGitState('.', () => ({
    status: 0,
    stdout: null,
    stderr: null,
    error: spawnError,
  })), null);
});

function closeCurrentIteration(artifactRoot) {
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'v1-mvp',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  for (const task of graph.tasks) task.status = 'done';
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  const runId = 'run-retention-final-verification';
  const started = runCli(EXECUTE_CLI, [
    'verify-final',
    '--artifacts', artifactRoot,
    '--task', graph.tasks[0].id,
    '--run-id', runId,
    '--agent-tool', 'manual',
  ]);
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  const verified = runCli(RUNS_CLI, [
    'verify',
    '--artifacts', artifactRoot,
    '--run-id', runId,
    '--test-command', 'node -e "console.log(\'full verification passed\')"',
  ]);
  assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  const finished = runCli(EXECUTE_CLI, [
    'finish',
    '--artifacts', artifactRoot,
    '--run-id', runId,
  ]);
  assert.equal(finished.status, 0, `${finished.stdout}${finished.stderr}`);
  const closed = runCli(ITERATION_CLI, ['close', '--artifacts', artifactRoot]);
  assert.equal(closed.status, 0, `${closed.stdout}${closed.stderr}`);
  return graph;
}

test('active-only pruning removes selected run records and sidecars while rebuilding the index', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-'));
  const runsDir = path.join(root, 'runs');
  mkdirSync(runsDir);
  try {
    const oldRun = runEntry('run-old', 'task-001', 'v1', 'finished', 'v1/run-old.json');
    const retainedRun = runEntry('run-current', 'task-002', 'v2', 'finished', 'v2/run-current.json');
    writeIndex(runsDir, [oldRun, retainedRun]);
    writeEvidence(runsDir, oldRun, ['.acceptance-review.json', '.monitor-verdict.json']);
    writeEvidence(runsDir, retainedRun);

    const result = pruneIndexedRunEvidence(runsDir, { iterationIds: ['v1'] });

    assert.deepEqual(result.prunedRunIds, ['run-old']);
    assert.equal(existsSync(path.join(runsDir, oldRun.runRef)), false);
    assert.equal(existsSync(path.join(runsDir, 'v1/run-old.acceptance-review.json')), false);
    assert.equal(existsSync(path.join(runsDir, 'v1/run-old.monitor-verdict.json')), false);
    assert.equal(existsSync(path.join(runsDir, retainedRun.runRef)), true);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(index.runs.map((entry) => entry.runId), ['run-current']);
    assert.deepEqual(index.tasks, [{
      taskId: 'task-002',
      runIds: ['run-current'],
      latestRunId: 'run-current',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active-only pruning refuses a scope with a started run without deleting closed evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-'));
  const runsDir = path.join(root, 'runs');
  mkdirSync(runsDir);
  try {
    const finished = runEntry('run-finished', 'task-001', 'v1', 'finished', 'v1/run-finished.json');
    const started = runEntry('run-started', 'task-002', 'v1', 'started', 'v1/run-started.json');
    writeIndex(runsDir, [finished, started]);
    writeEvidence(runsDir, finished);
    writeEvidence(runsDir, started);

    assert.throws(
      () => pruneIndexedRunEvidence(runsDir, { iterationIds: ['v1'] }),
      /cannot prune active run evidence.*run-started/,
    );
    assert.equal(existsSync(path.join(runsDir, finished.runRef)), true);
    assert.equal(existsSync(path.join(runsDir, started.runRef)), true);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(index.runs.map((entry) => entry.runId), ['run-finished', 'run-started']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iteration cleanup drops a bounded retrospective even when no run files remain', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-'));
  const runsDir = path.join(root, 'runs');
  mkdirSync(runsDir);
  try {
    writeIndex(runsDir, [], 'sample', retrospective('v1'));

    const result = pruneIndexedRunEvidence(runsDir, {
      iterationIds: ['v1'],
      dropRetrospective: true,
    });

    assert.deepEqual(result.prunedRunIds, []);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.equal(Object.hasOwn(index, 'retrospective'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review retry pruning retains the implementation run required by handoff', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-'));
  const runsDir = path.join(root, 'runs');
  mkdirSync(runsDir);
  try {
    const implementation = runEntry('run-implementation', 'task-001', 'v1', 'finished', 'v1/run-implementation.json');
    const oldReview = runEntry('run-review-old', 'task-001', 'v1', 'finished', 'v1/run-review-old.json');
    const currentReview = runEntry('run-review-current', 'task-001', 'v1', 'finished', 'v1/run-review-current.json');
    oldReview.runKind = 'final_acceptance_review';
    currentReview.runKind = 'final_acceptance_review';
    writeIndex(runsDir, [implementation, oldReview, currentReview]);
    for (const entry of [implementation, oldReview, currentReview]) writeEvidence(runsDir, entry);

    const result = pruneIndexedRunEvidence(runsDir, {
      iterationIds: ['v1'],
      taskIds: ['task-001'],
      runKinds: ['final_acceptance_review'],
      keepRunIds: ['run-review-current'],
      requireNoStarted: false,
    });

    assert.deepEqual(result.prunedRunIds, ['run-review-old']);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(index.runs.map((entry) => entry.runId), [
      'run-implementation',
      'run-review-current',
    ]);
    assert.equal(existsSync(path.join(runsDir, implementation.runRef)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [persistence, shouldPrune] of [['active_only', true], ['persistent', false]]) {
  test(`iteration open ${shouldPrune ? 'removes' : 'retains'} archived run evidence in ${persistence} mode`, () => {
    const artifactRoot = initializedIterationProject(persistence);
    try {
      const graph = closeCurrentIteration(artifactRoot);

      const runsDir = path.join(artifactRoot, 'runs');
      mkdirSync(runsDir, { recursive: true });
      const archivedRun = runEntry(
        'run-archived',
        graph.tasks[0].id,
        'v1-mvp',
        'finished',
        'v1-mvp/run-archived.json',
      );
      writeIndex(runsDir, [archivedRun], 'sample', retrospective('v1-mvp'));
      writeEvidence(runsDir, archivedRun, ['.acceptance-review.json']);

      const opened = runCli(ITERATION_CLI, [
        'open',
        '--artifacts', artifactRoot,
        '--iteration-id', 'v2',
        '--idea', 'next change',
      ]);
      assert.equal(opened.status, 0, `${opened.stdout}${opened.stderr}`);
      assert.equal(existsSync(path.join(runsDir, archivedRun.runRef)), !shouldPrune);
      const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
      assert.equal(index.runs.length, shouldPrune ? 0 : 1);
      assert.equal(index.retrospective?.iterations.length ?? 0, shouldPrune ? 0 : 1);
      if (shouldPrune) assert.match(opened.stdout, /transient run cleanup: removed 1 archived run/);
      else assert.doesNotMatch(opened.stdout, /transient run cleanup/);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
}

test('active-only iteration open rolls back instead of abandoning a started archived run', () => {
  const artifactRoot = initializedIterationProject('active_only');
  try {
    const graph = closeCurrentIteration(artifactRoot);
    const runsDir = path.join(artifactRoot, 'runs');
    const startedRun = runEntry(
      'run-still-active',
      graph.tasks[0].id,
      'v1-mvp',
      'started',
      'v1-mvp/run-still-active.json',
    );
    writeIndex(runsDir, [startedRun], graph.projectId);
    writeEvidence(runsDir, startedRun);

    const opened = runCli(ITERATION_CLI, [
      'open',
      '--artifacts', artifactRoot,
      '--iteration-id', 'v2',
      '--idea', 'must not open yet',
    ]);
    assert.equal(opened.status, 1, `${opened.stdout}${opened.stderr}`);
    assert.match(`${opened.stdout}${opened.stderr}`, /cannot prune active run evidence.*run-still-active/);
    assert.doesNotMatch(opened.stdout, /iteration opened/);
    assert.equal(existsSync(path.join(artifactRoot, 'iterations', 'v2')), false);
    assert.equal(existsSync(path.join(runsDir, startedRun.runRef)), true);
    const currentSpec = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
    assert.equal(currentSpec.active_iteration, 'v1-mvp');
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('runs gc dry-run lists indexed and orphan evidence before removing it while keeping final runs', () => {
  const artifactRoot = initializedIterationProject('active_only');
  try {
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.join(runsDir, 'v1-mvp'), { recursive: true });
    const oldRun = runEntry('run-gc-old', 'task-001', 'v1-mvp', 'failed', 'v1-mvp/run-gc-old.json');
    const finalRun = runEntry('run-gc-final', 'task-001', 'v1-mvp', 'finished', 'v1-mvp/run-gc-final.json');
    writeIndex(runsDir, [oldRun, finalRun]);
    writeEvidence(runsDir, oldRun);
    writeEvidence(runsDir, finalRun);
    const indexedEnvelopeSha = '1'.repeat(64);
    const indexedEnvelopeRef = `v1-mvp/envelopes/${indexedEnvelopeSha}.json`;
    writeFileSync(path.join(runsDir, oldRun.runRef), `${JSON.stringify({
      runId: oldRun.runId,
      iterationId: oldRun.iterationId,
      executionEnvelopeRef: { sha256: indexedEnvelopeSha },
    }, null, 2)}\n`, 'utf8');
    mkdirSync(path.dirname(path.join(runsDir, indexedEnvelopeRef)), { recursive: true });
    writeFileSync(path.join(runsDir, indexedEnvelopeRef), '{}\n', 'utf8');
    const orphanRef = 'v1-mvp/run-gc-orphan.acceptance-review.json';
    writeFileSync(path.join(runsDir, orphanRef), '{}\n', 'utf8');
    const orphanEnvelopeRef = `v1-mvp/envelopes/${'0'.repeat(64)}.json`;
    mkdirSync(path.dirname(path.join(runsDir, orphanEnvelopeRef)), { recursive: true });
    writeFileSync(path.join(runsDir, orphanEnvelopeRef), '{}\n', 'utf8');

    const preview = runCli(RUNS_CLI, [
      'gc',
      '--artifacts', artifactRoot,
      '--iteration', 'v1-mvp',
      '--keep-final',
      '--dry-run',
    ]);
    assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
    assert.match(preview.stdout, /Run evidence gc preview/);
    assert.match(preview.stdout, /run-gc-old/);
    assert.match(preview.stdout, /run-gc-orphan\.acceptance-review\.json/);
    assert.match(preview.stdout, /envelopes\/0{64}\.json/);
    assert.match(preview.stdout, /envelopes\/1{64}\.json/);
    assert.match(preview.stdout, /final runs kept: 1/);
    assert.equal(existsSync(path.join(runsDir, oldRun.runRef)), true);
    assert.equal(existsSync(path.join(runsDir, finalRun.runRef)), true);
    assert.equal(existsSync(path.join(runsDir, orphanRef)), true);
    assert.equal(existsSync(path.join(runsDir, orphanEnvelopeRef)), true);
    assert.equal(existsSync(path.join(runsDir, indexedEnvelopeRef)), true);

    const collected = runCli(RUNS_CLI, [
      'gc',
      '--artifacts', artifactRoot,
      '--iteration', 'v1-mvp',
      '--keep-final',
    ]);
    assert.equal(collected.status, 0, `${collected.stdout}${collected.stderr}`);
    assert.equal(existsSync(path.join(runsDir, oldRun.runRef)), false);
    assert.equal(existsSync(path.join(runsDir, finalRun.runRef)), true);
    assert.equal(existsSync(path.join(runsDir, orphanRef)), false);
    assert.equal(existsSync(path.join(runsDir, orphanEnvelopeRef)), false);
    assert.equal(existsSync(path.join(runsDir, indexedEnvelopeRef)), false);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(index.runs.map((entry) => entry.runId), ['run-gc-final']);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('runs gc requires force in persistent mode and never removes started evidence', () => {
  const artifactRoot = initializedIterationProject('persistent');
  try {
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const finished = runEntry('run-persistent', 'task-001', 'v1-mvp', 'finished', 'v1-mvp/run-persistent.json');
    writeIndex(runsDir, [finished]);
    writeEvidence(runsDir, finished);

    const refused = runCli(RUNS_CLI, ['gc', '--artifacts', artifactRoot]);
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    assert.match(`${refused.stdout}${refused.stderr}`, /persistence is persistent.*--force/);
    assert.equal(existsSync(path.join(runsDir, finished.runRef)), true);

    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    const started = runEntry('run-started-gc', 'task-002', 'v1-mvp', 'started', 'v1-mvp/run-started-gc.json');
    writeIndex(runsDir, [...index.runs, started]);
    writeEvidence(runsDir, started);
    const activeRefused = runCli(RUNS_CLI, ['gc', '--artifacts', artifactRoot, '--force']);
    assert.equal(activeRefused.status, 1, `${activeRefused.stdout}${activeRefused.stderr}`);
    assert.match(`${activeRefused.stdout}${activeRefused.stderr}`, /cannot gc active run evidence.*run-started-gc/);
    assert.equal(existsSync(path.join(runsDir, finished.runRef)), true);
    assert.equal(existsSync(path.join(runsDir, started.runRef)), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('runs gc resolves active-only persistence from the canonical project config', () => {
  const { projectRoot, artifactRoot } = initializedCanonicalIterationProject('active_only');
  try {
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const finished = runEntry(
      'run-canonical-config',
      'task-001',
      'v1-mvp',
      'finished',
      'v1-mvp/run-canonical-config.json',
    );
    writeIndex(runsDir, [finished], 'webhook-api-service');
    writeEvidence(runsDir, finished);

    const collected = runCli(RUNS_CLI, ['gc', '--artifacts', artifactRoot]);
    assert.equal(collected.status, 0, `${collected.stdout}${collected.stderr}`);
    assert.match(collected.stdout, /persistence: active_only/);
    assert.equal(existsSync(path.join(runsDir, finished.runRef)), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('runs gc refuses an unindexed started run left by an interrupted index commit', () => {
  const artifactRoot = initializedIterationProject('active_only');
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-run-gc-unindexed-started-'));
  try {
    const started = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);

    const runsDir = path.join(artifactRoot, 'runs');
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    const startedEntry = index.runs.at(-1);
    const runPath = path.join(runsDir, startedEntry.runRef);
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    const envelopePath = path.join(
      runsDir,
      run.iterationId,
      'envelopes',
      `${run.executionEnvelopeRef.sha256}.json`,
    );
    writeIndex(runsDir, [], index.projectId);

    const refused = runCli(RUNS_CLI, ['gc', '--artifacts', artifactRoot]);
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    assert.match(
      `${refused.stdout}${refused.stderr}`,
      /cannot gc active run evidence.*restore the index.*started run\(s\)/,
    );
    assert.equal(existsSync(runPath), true);
    assert.equal(existsSync(envelopePath), true);
    const unchangedIndex = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.deepEqual(unchangedIndex.runs, []);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('starting the next maintenance task removes completed maintenance run history in active-only mode', () => {
  const artifactRoot = initializedIterationProject('active_only');
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-workspace-'));
  try {
    mkdirSync(path.join(workspace, '.plan2agent'), { recursive: true });
    writeFileSync(path.join(workspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      runTracking: { persistence: 'active_only' },
    }, null, 2)}\n`, 'utf8');
    for (const title of ['first fix', 'second fix']) {
      const added = runCli(ITERATION_CLI, [
        'maintenance', 'add',
        '--artifacts', artifactRoot,
        '--title', title,
        '--accept', `${title} works`,
      ]);
      assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
    }
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks[0].status = 'done';
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const completedRun = runEntry(
      'run-maintenance-old',
      graph.tasks[0].id,
      'maintenance',
      'finished',
      'maintenance/run-maintenance-old.json',
    );
    completedRun.taskGraphRef = 'iterations/maintenance/gate-c-task-graph/task-graph.json';
    writeIndex(runsDir, [completedRun], graph.projectId);
    writeEvidence(runsDir, completedRun);

    const failedStart = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--maintenance',
      '--task', graph.tasks[1].id,
      '--agent-tool', 'manual',
      '--workspace', workspace,
      '--isolation', 'branch',
      '--branch', 'p2a/retention-start-failure',
      '--create-isolation',
    ]);
    assert.notEqual(failedStart.status, 0, `${failedStart.stdout}${failedStart.stderr}`);
    assert.equal(existsSync(path.join(runsDir, completedRun.runRef)), true);

    const started = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--maintenance',
      '--task', graph.tasks[1].id,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
    assert.match(started.stdout, /Transient run cleanup: removed 1 completed maintenance run/);
    assert.equal(existsSync(path.join(runsDir, completedRun.runRef)), false);
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.equal(index.runs.some((entry) => entry.runId === completedRun.runId), false);
    assert.equal(index.runs.some((entry) => entry.taskId === graph.tasks[1].id && entry.status === 'started'), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('successful task finish keeps the latest run and removes superseded same-kind retries', () => {
  const artifactRoot = initializedIterationProject('active_only');
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-workspace-'));
  try {
    mkdirSync(path.join(workspace, '.plan2agent'), { recursive: true });
    writeFileSync(path.join(workspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      runTracking: { persistence: 'active_only' },
    }, null, 2)}\n`, 'utf8');
    const started = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);

    const runsDir = path.join(artifactRoot, 'runs');
    const indexPath = path.join(runsDir, 'run-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const currentEntry = index.runs.at(-1);
    const currentRunPath = path.join(runsDir, currentEntry.runRef);
    const oldRun = JSON.parse(readFileSync(currentRunPath, 'utf8'));
    oldRun.runId = 'run-superseded';
    oldRun.status = 'finished';
    oldRun.startedAt = '2026-08-22T00:00:00.000Z';
    oldRun.updatedAt = '2026-08-22T00:01:00.000Z';
    oldRun.finishedAt = '2026-08-22T00:01:00.000Z';
    oldRun.verification.push({
      type: 'custom',
      command: 'node -e "console.log(\'behavior ok\')"',
      status: 'passed',
      exitCode: 0,
      durationMs: 42,
      startedAt: '2026-08-22T00:00:00.000Z',
      finishedAt: '2026-08-22T00:00:00.042Z',
      stdoutTail: 'behavior ok',
      stderrTail: '',
      source: 'command',
    });
    oldRun.interruptions.push(
      {
        recordedAt: '2026-08-22T00:00:10.000Z',
        type: 'user_correction',
        summary: 'Adjusted the requested behavior.',
        assessment: 'not_applicable',
      },
      {
        recordedAt: '2026-08-22T00:00:20.000Z',
        type: 'gate_return',
        summary: 'Gate caught an omitted behavior.',
        assessment: 'valid',
      },
    );
    const oldEntry = {
      ...currentEntry,
      runId: oldRun.runId,
      runRef: `${oldRun.iterationId}/${oldRun.runId}.json`,
      status: oldRun.status,
      startedAt: oldRun.startedAt,
      finishedAt: oldRun.finishedAt,
    };
    mkdirSync(path.dirname(path.join(runsDir, oldEntry.runRef)), { recursive: true });
    writeFileSync(path.join(runsDir, oldEntry.runRef), `${JSON.stringify(oldRun, null, 2)}\n`, 'utf8');
    writeIndex(runsDir, [oldEntry, currentEntry], index.projectId);

    const finished = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', currentEntry.runId,
      '--verify-command', 'custom:true',
      '--no-task-transition',
    ]);
    assert.equal(finished.status, 0, `${finished.stdout}${finished.stderr}`);
    assert.doesNotMatch(finished.stdout, /Transient run cleanup/);
    assert.equal(existsSync(path.join(runsDir, oldEntry.runRef)), true);

    const recovered = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', currentEntry.runId,
    ]);
    assert.equal(recovered.status, 0, `${recovered.stdout}${recovered.stderr}`);
    assert.match(recovered.stdout, /Transient run cleanup: removed 1 superseded run/);
    assert.equal(existsSync(path.join(runsDir, oldEntry.runRef)), false);
    const finalIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.deepEqual(
      finalIndex.runs.filter((entry) => entry.taskId === currentEntry.taskId).map((entry) => entry.runId),
      [currentEntry.runId],
    );
    assert.deepEqual(finalIndex.retrospective, {
      iterations: [{
        iterationId: currentEntry.iterationId,
        runCount: 1,
        reasonCounts: { superseded: 1, completed_maintenance: 0 },
        statusCounts: { finished: 1, failed: 0, blocked: 0 },
        verificationCount: 1,
        verificationDuration: { sampleCount: 1, totalMs: 42, maxMs: 42 },
        verificationStatusCounts: { passed: 1, failed: 0, skipped: 0, not_run: 0, unavailable: 0 },
        interruptionCounts: {
          implementation_decision: 0,
          user_correction: 1,
          gate_return_valid: 1,
          gate_return_invalid: 0,
        },
      }],
    });
    assert.doesNotMatch(JSON.stringify(finalIndex.retrospective), /behavior ok|Adjusted|Gate caught|run-superseded/);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('successful direct retry retains an unmined failed run until proposal mining records it', () => {
  const artifactRoot = initializedIterationProject('active_only');
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-run-retention-workspace-'));
  try {
    mkdirSync(path.join(workspace, '.plan2agent'), { recursive: true });
    writeFileSync(path.join(workspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      runTracking: { persistence: 'active_only' },
      proposals: { enabled: true, queueDir: '.plan2agent/proposals' },
    }, null, 2)}\n`, 'utf8');
    const started = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);

    const runsDir = path.join(artifactRoot, 'runs');
    const indexPath = path.join(runsDir, 'run-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const currentEntry = index.runs.at(-1);
    const currentRunPath = path.join(runsDir, currentEntry.runRef);
    const failedRun = JSON.parse(readFileSync(currentRunPath, 'utf8'));
    failedRun.runId = 'run-unmined-failure';
    failedRun.status = 'failed';
    failedRun.startedAt = '2026-08-22T00:00:00.000Z';
    failedRun.updatedAt = '2026-08-22T00:01:00.000Z';
    failedRun.finishedAt = '2026-08-22T00:01:00.000Z';
    failedRun.failure = {
      class: 'verification_failed',
      retryable: 'after_fix',
      needsUserDecision: false,
      source: 'owner',
    };
    failedRun.reproduction = { steps: ['retry directly'], commands: [], notes: [] };
    failedRun.localization = { findings: ['previous attempt failed'], files: [] };
    failedRun.guard = { checks: ['retain until mined'], notes: [] };
    const failedEntry = {
      ...currentEntry,
      runId: failedRun.runId,
      runRef: `${failedRun.iterationId}/${failedRun.runId}.json`,
      status: failedRun.status,
      startedAt: failedRun.startedAt,
      finishedAt: failedRun.finishedAt,
    };
    writeFileSync(path.join(runsDir, failedEntry.runRef), `${JSON.stringify(failedRun, null, 2)}\n`, 'utf8');
    writeIndex(runsDir, [failedEntry, currentEntry], index.projectId);

    const finished = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', currentEntry.runId,
      '--verify-command', 'custom:true',
      '--no-task-transition',
    ]);
    assert.equal(finished.status, 0, `${finished.stdout}${finished.stderr}`);
    const recovered = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', currentEntry.runId,
    ]);
    assert.equal(recovered.status, 0, `${recovered.stdout}${recovered.stderr}`);
    assert.match(recovered.stdout, /retained 1 unmined failed\/blocked run/);
    assert.equal(existsSync(path.join(runsDir, failedEntry.runRef)), true);

    const proposalsDir = path.join(workspace, '.plan2agent', 'proposals');
    mkdirSync(proposalsDir, { recursive: true });
    writeFileSync(path.join(proposalsDir, 'mined.json'), `${JSON.stringify({
      sourceRunId: failedRun.runId,
    }, null, 2)}\n`, 'utf8');
    const minedRecovery = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', currentEntry.runId,
    ]);
    assert.equal(minedRecovery.status, 0, `${minedRecovery.stdout}${minedRecovery.stderr}`);
    assert.match(minedRecovery.stdout, /removed 1 superseded run/);
    assert.equal(existsSync(path.join(runsDir, failedEntry.runRef)), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('run start and finish bind the current Git head, branch, and dirty state', () => {
  const artifactRoot = initializedIterationProject('persistent');
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-run-git-workspace-'));
  try {
    git(workspace, ['init', '-b', 'main']);
    git(workspace, ['config', 'user.name', 'Plan2Agent Test']);
    git(workspace, ['config', 'user.email', 'p2a-test@example.invalid']);
    writeFileSync(path.join(workspace, 'tracked.txt'), 'initial\n', 'utf8');
    git(workspace, ['add', 'tracked.txt']);
    git(workspace, ['commit', '-m', 'initial']);
    const initialHead = git(workspace, ['rev-parse', 'HEAD']);

    const started = runCli(EXECUTE_CLI, [
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
    const runsDir = path.join(artifactRoot, 'runs');
    const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    const entry = index.runs.at(-1);
    const startedRun = JSON.parse(readFileSync(path.join(runsDir, entry.runRef), 'utf8'));
    assert.deepEqual(startedRun.git, { headSha: initialHead, branch: 'main', dirty: false });

    writeFileSync(path.join(workspace, 'tracked.txt'), 'updated\n', 'utf8');
    git(workspace, ['add', 'tracked.txt']);
    git(workspace, ['commit', '-m', 'update']);
    const finalHead = git(workspace, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(workspace, 'untracked.txt'), 'dirty\n', 'utf8');

    const finished = runCli(EXECUTE_CLI, [
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', entry.runId,
      '--verify-command', 'custom:true',
      '--no-task-transition',
    ]);
    assert.equal(finished.status, 0, `${finished.stdout}${finished.stderr}`);
    const finishedRun = JSON.parse(readFileSync(path.join(runsDir, entry.runRef), 'utf8'));
    assert.deepEqual(finishedRun.git, { headSha: finalHead, branch: 'main', dirty: true });
    assert.notEqual(finishedRun.git.headSha, initialHead);

    const shown = runCli(RUNS_CLI, ['show', '--artifacts', artifactRoot, '--run-id', entry.runId]);
    assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
    assert.deepEqual(JSON.parse(shown.stdout).git, finishedRun.git);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
