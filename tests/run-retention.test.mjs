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

import { pruneIndexedRunEvidence } from '../scripts/p2a_runs.mjs';

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
