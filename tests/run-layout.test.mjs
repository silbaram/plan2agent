import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  assertStartableRunId,
  canonicalRunRef,
  canonicalTaskGraphRef,
  defaultRunsDirForGraph,
  executionEnvelopeStoreRef,
  indexedRunRef,
  runFilePath,
  runSidecarPath,
  runSidecarRef,
  taskContractSha256,
  taskGraphRefMatchesGraph,
} from '../scripts/p2a_run_paths.mjs';
import {
  atomicWriteJson,
  RUN_STORE_LOCK_FILE,
  RUN_STORE_REAPER_LOCK_FILE,
  RUN_STORE_REDIRECT_FILE,
  withRunStoreLocks,
} from '../scripts/p2a_run_store.mjs';
import {
  MONITOR_CONCERN_FIELDS,
  MONITOR_GATE_POLICY,
  monitorGateContractSha256,
  normalizeMonitorGateSidecar,
} from '../scripts/p2a_monitor_gate.mjs';
import { validateRunIndexData, validateRunsDir } from '../scripts/validate_artifacts.mjs';
import { RUNS_CLI, runExecute, runRuns, runTasks } from './helpers/fixtures.mjs';

const ITERATION_ID = 'iter-002';

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function runRunsAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNS_CLI, ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function startedRun(runId = 'run-task-001-001') {
  const now = '2026-07-18T00:00:00.000Z';
  return {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'run-layout-fixture',
    taskId: 'task-001',
    taskTitle: 'Partition one run',
    iterationId: ITERATION_ID,
    sourceLayout: 'iteration',
    taskGraphRef: `iterations/${ITERATION_ID}/gate-c-task-graph/task-graph.json`,
    sourceSpecRef: '../gate-b-spec/spec.json',
    taskContractSha256: taskContractSha256(taskGraph().tasks[0]),
    agentTool: 'codex',
    workspaceRef: 'fixture-workspace',
    workspacePath: '.',
    isolation: {
      mode: 'none',
      branch: null,
      worktree: null,
      baseRef: null,
      created: false,
      createCommand: null,
      createExitCode: null,
      createOutputTail: null,
    },
    status: 'started',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    changedFiles: [],
    verification: [],
    notes: [],
  };
}

function runIndex(run, runRef = `${run.runId}.json`) {
  return {
    schema_version: 'p2a.run_index.v1',
    projectId: run.projectId,
    runs: [{
      runId: run.runId,
      taskId: run.taskId,
      iterationId: run.iterationId,
      status: run.status,
      agentTool: run.agentTool,
      workspaceRef: run.workspaceRef,
      taskGraphRef: run.taskGraphRef,
      runRef,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }],
    tasks: [{ taskId: run.taskId, runIds: [run.runId], latestRunId: run.runId }],
  };
}

function taskGraph() {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId: 'run-layout-fixture',
    version: ITERATION_ID,
    sourceSpec: '../gate-b-spec/spec.json',
    tasks: [{
      id: 'task-001',
      title: 'Partition one run',
      description: 'Create a run in the iteration directory.',
      status: 'todo',
      dependencies: [],
      acceptanceCriteria: ['The run is stored below the iteration directory.'],
      targetArea: 'run-layout',
      suggestedAgentPrompt: 'Create the run.',
      sourceSpecRefs: ['implementation.architecture'],
    }],
  };
}

function executionEnvelopeFixture() {
  return {
    objective: 'Preserve a content-addressed execution contract.',
    sourceGateRefs: [{ path: 'gate-b-spec/spec.json', sha256: 'a'.repeat(64) }],
    scope: ['run layout'],
    mustPreserve: ['hash verification'],
    nonGoals: [],
    acceptance: ['The envelope remains resolvable.'],
    verification: ['validateRunsDir'],
    executionAuthority: {
      mayChoose: ['file movement details'],
      mustReturnToGate: ['product meaning changes'],
    },
  };
}

function writeApprovedRunSource(root, projectId = 'run-layout-fixture') {
  const fixtureRoot = path.resolve('fixtures/_e2e/webhook-api-service');
  const intake = JSON.parse(readFileSync(path.join(fixtureRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(path.join(fixtureRoot, 'gate-b-spec', 'spec.json'), 'utf8'));
  spec.project_id = projectId;
  writeJson(path.join(root, 'gate-a-intake', 'intake.json'), intake);
  writeJson(path.join(root, 'gate-b-spec', 'spec.json'), spec);
}

function writeApprovedRunSourceForGraph(graphPath, projectId = 'run-layout-fixture') {
  writeApprovedRunSource(path.dirname(path.dirname(graphPath)), projectId);
}

describe('iteration-partitioned run layout', () => {
  test('atomic JSON replacement preserves an existing file mode', { skip: process.platform === 'win32' }, () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-mode-'));
    try {
      const filePath = path.join(tempRoot, 'state.json');
      writeJson(filePath, { before: true });
      chmodSync(filePath, 0o644);

      atomicWriteJson(filePath, { after: true });

      assert.equal(statSync(filePath).mode & 0o777, 0o644);
      assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { after: true });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('multi-store release attempts every lock and preserves the primary operation error', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-release-all-'));
    try {
      const firstRunsDir = path.join(tempRoot, 'a-runs');
      const secondRunsDir = path.join(tempRoot, 'b-runs');
      assert.throws(
        () => withRunStoreLocks([firstRunsDir, secondRunsDir], () => {
          writeFileSync(path.join(secondRunsDir, RUN_STORE_LOCK_FILE), '{corrupt lock', 'utf8');
          throw new Error('primary operation failure');
        }),
        /primary operation failure/,
      );
      assert.equal(existsSync(path.join(firstRunsDir, RUN_STORE_LOCK_FILE)), false);
      assert.equal(existsSync(path.join(secondRunsDir, RUN_STORE_LOCK_FILE)), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('new starts store the run below its iteration while keeping a global index', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-start-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001-001',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const second = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001-002',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, 'run-task-001-001.json')), true);
      assert.equal(existsSync(path.join(runsDir, 'run-task-001-001.json')), false);
      const index = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
      assert.equal(index.runs[0].runRef, `${ITERATION_ID}/run-task-001-001.json`);
      assert.equal(index.runs.length, 2);
      assert.equal(runFilePath(runsDir, 'run-task-001-001'), path.join(runsDir, ITERATION_ID, 'run-task-001-001.json'));
      const firstRun = JSON.parse(readFileSync(runFilePath(runsDir, 'run-task-001-001'), 'utf8'));
      assert.equal(Object.hasOwn(firstRun, 'executionEnvelope'), false);
      assert.deepEqual(firstRun.executionEnvelopeRef, { sha256: firstRun.executionEnvelopeSha256 });
      const envelopesDir = path.join(runsDir, ITERATION_ID, 'envelopes');
      assert.deepEqual(readdirSync(envelopesDir), [`${firstRun.executionEnvelopeSha256}.json`]);
      validateRunsDir(runsDir);
      const envelopePath = path.join(
        runsDir,
        executionEnvelopeStoreRef(firstRun, firstRun.executionEnvelopeRef.sha256),
      );
      const tamperedEnvelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
      tamperedEnvelope.objective = `${tamperedEnvelope.objective} tampered`;
      writeJson(envelopePath, tamperedEnvelope);
      assert.throws(
        () => validateRunsDir(runsDir),
        /execution envelope content hash does not match executionEnvelopeRef/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('start rejects run ids that collide with known sidecar filenames', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-sidecar-id-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001.monitor-gate',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /reserved sidecar suffix \.monitor-gate/);
      assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, 'run-task-001.monitor-gate.json')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('monitor-gated start preserves an indexed legacy run at a colliding sidecar path', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-legacy-sidecar-id-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const legacyRun = startedRun('run-task-001.monitor-gate');
      const legacyRef = canonicalRunRef(legacyRun);
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, legacyRef), legacyRun);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(legacyRun, legacyRef));

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
        '--require-monitor',
      ]);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /collides with indexed run run-task-001\.monitor-gate/);
      assert.deepEqual(JSON.parse(readFileSync(path.join(runsDir, legacyRef), 'utf8')), legacyRun);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, 'run-task-001.json')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('managed graph paths resolve reads to global runs but reject --graph mutations', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-graph-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const maintenanceGraphPath = path.join(tempRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      const runsDir = path.join(tempRoot, 'runs');
      writeJson(graphPath, taskGraph());

      assert.equal(defaultRunsDirForGraph(graphPath), runsDir);
      assert.equal(defaultRunsDirForGraph(maintenanceGraphPath), runsDir);

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', 'run-task-001-001',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot mutate a managed iteration task graph through --graph/);
      assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
      assert.equal(existsSync(path.join(tempRoot, 'iterations', ITERATION_ID, 'runs')), false);

      const taskMutation = runTasks(['start', '--graph', graphPath, 'task-001']);
      assert.equal(taskMutation.status, 1);
      assert.match(taskMutation.stderr, /cannot mutate a managed iteration task graph through --graph/);

      const executeMutation = runExecute(['start', '--graph', graphPath, '--task', 'task-001']);
      assert.equal(executeMutation.status, 1);
      assert.match(executeMutation.stderr, /cannot mutate a managed iteration task graph through --graph/);

      const graphAlias = path.join(tempRoot, 'managed-graph-alias.json');
      let aliasCreated = true;
      try {
        symlinkSync(graphPath, graphAlias);
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) aliasCreated = false;
        else throw error;
      }
      if (aliasCreated) {
        const aliasedMutation = runRuns([
          'start',
          '--graph', graphAlias,
          '--task', 'task-001',
          '--run-id', 'run-task-001-aliased',
          '--agent-tool', 'codex',
          '--workspace', tempRoot,
        ]);
        assert.equal(aliasedMutation.status, 1);
        assert.match(aliasedMutation.stderr, /cannot mutate a managed iteration task graph through --graph/);
      }

      assert.equal(taskGraphRefMatchesGraph(graphPath, graphPath, tempRoot), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('task done rejects otherwise matching run evidence from another source layout', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-source-layout-'));
    try {
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const runsDir = path.join(tempRoot, 'runs');
      const graph = taskGraph();
      graph.tasks[0].status = 'in_progress';
      writeJson(graphPath, graph);
      const run = {
        ...startedRun('run-source-layout-mismatch'),
        sourceLayout: 'iteration',
        taskGraphRef: canonicalTaskGraphRef(graphPath),
        status: 'finished',
        updatedAt: '2026-07-18T00:01:00.000Z',
        finishedAt: '2026-07-18T00:01:00.000Z',
        changedFiles: ['src/run-layout.js'],
        verification: [{
          type: 'test',
          command: 'node --test',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: '2026-07-18T00:00:30.000Z',
          finishedAt: '2026-07-18T00:00:31.000Z',
          stdoutTail: null,
          stderrTail: null,
          source: 'command',
        }],
      };
      const runRef = canonicalRunRef(run);
      writeJson(path.join(runsDir, runRef), run);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run, runRef));

      const result = runTasks(['done', '--graph', graphPath, 'task-001']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside current task graph context/);
      assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status, 'in_progress');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('execute status filters the latest run by source layout within the current iteration graph', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-status-context-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const currentGraphRun = {
        ...startedRun('run-current-graph'),
        sourceLayout: 'graph',
      };
      const priorRun = {
        ...startedRun('run-prior-iteration'),
        iterationId: 'iter-001',
        taskGraphRef: 'iterations/iter-001/gate-c-task-graph/task-graph.json',
      };
      const currentIterationRun = startedRun('run-current-iteration');
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, canonicalRunRef(currentGraphRun)), currentGraphRun);
      writeJson(path.join(runsDir, canonicalRunRef(priorRun)), priorRun);
      writeJson(path.join(runsDir, canonicalRunRef(currentIterationRun)), currentIterationRun);
      writeJson(path.join(runsDir, 'run-index.json'), {
        schema_version: 'p2a.run_index.v1',
        projectId: currentGraphRun.projectId,
        runs: [
          runIndex(currentGraphRun, canonicalRunRef(currentGraphRun)).runs[0],
          runIndex(priorRun, canonicalRunRef(priorRun)).runs[0],
          runIndex(currentIterationRun, canonicalRunRef(currentIterationRun)).runs[0],
        ],
        tasks: [{
          taskId: currentGraphRun.taskId,
          runIds: [currentGraphRun.runId, priorRun.runId, currentIterationRun.runId],
          latestRunId: currentIterationRun.runId,
        }],
      });

      const result = runExecute(['status', '--graph', graphPath, '--task', currentGraphRun.taskId]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /runId: run-current-graph/);
      assert.doesNotMatch(result.stdout, /runId: run-current-iteration/);
      assert.doesNotMatch(result.stdout, /runId: run-prior-iteration/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('task completion and execute status use the same timestamp ordering for the latest run', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-latest-order-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'task-graph.json');
      const graph = taskGraph();
      graph.tasks[0].status = 'in_progress';
      writeJson(graphPath, graph);
      const taskGraphRef = canonicalTaskGraphRef(graphPath);
      const successfulRun = {
        ...startedRun('run-successful-older-entry'),
        sourceLayout: 'graph',
        taskGraphRef,
        status: 'finished',
        startedAt: '2026-07-18T00:09:00.000Z',
        updatedAt: '2026-07-18T00:10:00.000Z',
        finishedAt: '2026-07-18T00:10:00.000Z',
        changedFiles: ['src/success.js'],
        verification: [{
          type: 'test',
          command: 'node --test',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: '2026-07-18T00:09:30.000Z',
          finishedAt: '2026-07-18T00:09:31.000Z',
          stdoutTail: null,
          stderrTail: null,
          source: 'command',
        }],
      };
      const failedLatestRun = {
        ...startedRun('run-failed-latest-entry'),
        sourceLayout: 'graph',
        taskGraphRef,
        status: 'failed',
        startedAt: '2026-07-18T00:04:00.000Z',
        updatedAt: '2026-07-18T00:05:00.000Z',
        finishedAt: '2026-07-18T00:05:00.000Z',
        reproduction: { steps: ['Reproduce the failure.'], commands: [], notes: [] },
        localization: { findings: ['The latest run failed.'], files: [] },
        guard: { checks: ['Keep the task in progress.'], notes: [] },
        failure: {
          class: 'verification_failed',
          retryable: 'after_fix',
          needsUserDecision: false,
          source: 'owner',
        },
      };
      const successfulRef = canonicalRunRef(successfulRun);
      const failedRef = canonicalRunRef(failedLatestRun);
      writeJson(path.join(runsDir, successfulRef), successfulRun);
      writeJson(path.join(runsDir, failedRef), failedLatestRun);
      const index = {
        schema_version: 'p2a.run_index.v1',
        projectId: graph.projectId,
        runs: [
          runIndex(successfulRun, successfulRef).runs[0],
          runIndex(failedLatestRun, failedRef).runs[0],
        ],
        tasks: [{
          taskId: 'task-001',
          runIds: [successfulRun.runId, failedLatestRun.runId],
          latestRunId: failedLatestRun.runId,
        }],
      };
      writeJson(path.join(runsDir, 'run-index.json'), index);

      const status = runExecute(['status', '--graph', graphPath, '--task', 'task-001']);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, new RegExp(`runId: ${successfulRun.runId}`));

      writeJson(path.join(runsDir, successfulRef), { ...successfulRun, agentTool: 'other-agent' });
      const inconsistentStatus = runExecute(['status', '--graph', graphPath, '--task', 'task-001']);
      assert.equal(inconsistentStatus.status, 1);
      assert.match(inconsistentStatus.stderr, /run-index evidence mismatch.*agentTool/);
      writeJson(path.join(runsDir, successfulRef), successfulRun);

      const done = runTasks(['done', '--graph', graphPath, 'task-001']);
      assert.equal(done.status, 0, done.stderr);
      assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status, 'done');

      const invalidIndex = structuredClone(index);
      invalidIndex.tasks[0].latestRunId = successfulRun.runId;
      assert.throws(
        () => validateRunIndexData(invalidIndex),
        /latestRunId must be the last runIds entry/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('finish --runs resolves the source graph before sealing the task contract', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-finish-runs-contract-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const graph = taskGraph();
      writeApprovedRunSource(tempRoot);
      writeJson(graphPath, graph);
      const runId = 'run-finish-runs-contract';
      const started = runRuns([
        'start',
        '--graph', graphPath,
        '--task', 'task-001',
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(started.status, 0, started.stderr);

      const runPath = runFilePath(runsDir, runId);
      const run = JSON.parse(readFileSync(runPath, 'utf8'));
      run.verification = [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: run.startedAt,
        finishedAt: run.startedAt,
        stdoutTail: 'passed',
        stderrTail: '',
        source: 'command',
      }];
      writeJson(runPath, run);

      const changedGraph = structuredClone(graph);
      changedGraph.tasks[0].title = 'Changed after run start';
      writeJson(graphPath, changedGraph);
      const rejected = runRuns([
        'finish', '--runs', runsDir, '--run-id', runId, '--status', 'finished',
      ]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /task contract changed after start/);
      assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).status, 'started');

      writeJson(graphPath, graph);
      const legacyRun = JSON.parse(readFileSync(runPath, 'utf8'));
      legacyRun.schema_version = 'p2a.run.v1';
      delete legacyRun.taskContractSha256;
      writeJson(runPath, legacyRun);
      const finished = runRuns([
        'finish', '--runs', runsDir, '--run-id', runId, '--status', 'finished',
      ]);
      assert.equal(finished.status, 0, finished.stderr);
      const upgradedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      assert.equal(upgradedRun.schema_version, 'p2a.run.v2');
      assert.equal(upgradedRun.taskContractSha256, taskContractSha256(graph.tasks[0]));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('custom run stores validate graph provenance from the external source root', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-external-store-'));
    try {
      const sourceRoot = path.join(tempRoot, 'source');
      const runsDir = path.join(tempRoot, 'store', 'runs');
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), sourceRoot, { recursive: true });
      const graphPath = path.join(sourceRoot, 'gate-c-task-graph', 'task-graph.json');
      const runId = 'run-external-store-provenance';

      let result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', sourceRoot,
      ]);
      assert.equal(result.status, 0, result.stderr);

      result = runRuns([
        'verify', '--runs', runsDir, '--run-id', runId,
        '--workspace', sourceRoot, '--test-command', 'true',
      ]);
      assert.equal(result.status, 0, result.stderr);

      result = runRuns([
        'finish', '--graph', graphPath, '--runs', runsDir,
        '--run-id', runId, '--status', 'finished',
      ]);
      assert.equal(result.status, 0, result.stderr);

      result = runRuns(['validate', '--runs', runsDir]);
      assert.equal(result.status, 0, result.stderr);
      result = runRuns(['validate', '--runs', runsDir, '--run-id', runId]);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('finish and targeted validation reject v2 runs whose source spec is missing', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-missing-source-spec-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const graph = taskGraph();
      const runId = 'run-missing-source-spec';
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, graph);

      let result = runRuns([
        'start', '--graph', graphPath, '--task', 'task-001',
        '--run-id', runId, '--agent-tool', 'codex', '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 0, result.stderr);
      result = runRuns([
        'verify', '--runs', runsDir, '--run-id', runId,
        '--workspace', tempRoot, '--test-command', 'true',
      ]);
      assert.equal(result.status, 0, result.stderr);

      rmSync(path.join(tempRoot, 'gate-b-spec', 'spec.json'));

      const rejected = runRuns([
        'finish', '--runs', runsDir, '--run-id', runId, '--status', 'finished',
      ]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /source_spec_ref cannot be resolved/);
      const runPath = runFilePath(runsDir, runId);
      assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).status, 'started');

      const invalidFinishedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      invalidFinishedRun.status = 'finished';
      invalidFinishedRun.finishedAt = new Date().toISOString();
      invalidFinishedRun.updatedAt = invalidFinishedRun.finishedAt;
      writeJson(runPath, invalidFinishedRun);
      const indexPath = path.join(runsDir, 'run-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      index.runs[0].status = 'finished';
      index.runs[0].finishedAt = invalidFinishedRun.finishedAt;
      writeJson(indexPath, index);

      const targeted = runRuns(['validate', '--runs', runsDir, '--run-id', runId]);
      assert.equal(targeted.status, 1);
      assert.match(targeted.stderr, /source_spec_ref cannot be resolved/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('todo --reopen is rejected unless the task is done', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-reopen-contract-'));
    try {
      const graphPath = path.join(tempRoot, 'task-graph.json');
      const graph = taskGraph();
      graph.tasks[0].status = 'blocked';
      graph.tasks[0].blockReason = 'other';
      graph.tasks[0].blockNote = 'original blocker';
      writeJson(graphPath, graph);

      const result = runTasks([
        'todo', '--graph', graphPath, 'task-001', '--reopen', '--note', 'replacement note',
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--reopen is only valid when the current status is done/);
      assert.deepEqual(JSON.parse(readFileSync(graphPath, 'utf8')), graph);

      graph.tasks[0].status = 'done';
      delete graph.tasks[0].blockReason;
      delete graph.tasks[0].blockNote;
      writeJson(graphPath, graph);
      const reopened = runTasks([
        'todo', '--graph', graphPath, 'task-001', '--reopen', '--note', 'replacement note',
      ]);
      assert.equal(reopened.status, 0, reopened.stderr);
      const reopenedTask = JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0];
      assert.equal(reopenedTask.status, 'todo');
      assert.equal(reopenedTask.blockNote, 'replacement note');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('raw lifecycle mutations reject a run outside the selected graph context', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-mutation-context-'));
    try {
      const currentGraphPath = path.join(tempRoot, 'current', 'task-graph.json');
      const priorGraphPath = path.join(tempRoot, 'prior', 'task-graph.json');
      const runsDir = path.join(path.dirname(currentGraphPath), 'runs');
      const run = {
        ...startedRun('run-prior-context'),
        sourceLayout: 'graph',
        taskGraphRef: canonicalTaskGraphRef(priorGraphPath),
      };
      const runRef = canonicalRunRef(run);
      writeJson(currentGraphPath, taskGraph());
      writeJson(priorGraphPath, taskGraph());
      writeJson(path.join(runsDir, runRef), run);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run, runRef));

      const rejected = runRuns([
        'record',
        '--graph', currentGraphPath,
        '--run-id', run.runId,
        '--note', 'must not update a prior graph run',
      ]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /outside the current run context/);
      assert.deepEqual(JSON.parse(readFileSync(path.join(runsDir, runRef), 'utf8')).notes, []);

      const explicitStore = runRuns([
        'record',
        '--runs', runsDir,
        '--run-id', run.runId,
        '--note', 'explicit run-store maintenance',
      ]);
      assert.equal(explicitStore.status, 0, explicitStore.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path.join(runsDir, runRef), 'utf8')).notes, ['explicit run-store maintenance']);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout moves legacy runs and co-located sidecars, then rewrites the index', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-migrate-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun();
      const sourceGate = normalizeMonitorGateSidecar({
        required: true,
        requiredConcernFields: MONITOR_CONCERN_FIELDS,
        ruleContract: { source: 'none', ref: null, sha256: null, ruleIds: [] },
      }, run.runId, `${run.runId}.json`);
      run.schema_version = 'p2a.run.v2';
      run.monitorGate = {
        required: true,
        policy: MONITOR_GATE_POLICY,
        contractSha256: monitorGateContractSha256(sourceGate),
      };
      writeJson(path.join(runsDir, `${run.runId}.json`), run);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run));
      writeJson(path.join(runsDir, `${run.runId}.monitor-gate.json`), sourceGate);
      writeJson(path.join(runsDir, `${run.runId}.style-verdict.json`), { violationCount: 0 });
      validateRunsDir(runsDir);

      const dryRun = runRuns(['migrate-layout', '--runs', runsDir, '--dry-run']);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.equal(existsSync(path.join(runsDir, `${run.runId}.json`)), true);
      assert.equal(existsSync(path.join(runsDir, '.run-store.lock')), false);
      assert.equal(existsSync(path.join(runsDir, '.run-layout-migration')), false);

      const migration = runRuns(['migrate-layout', '--runs', runsDir, '--yes']);
      assert.equal(migration.status, 0, migration.stderr);
      const expectedRef = canonicalRunRef(run);
      assert.equal(indexedRunRef(runsDir, run.runId), expectedRef);
      assert.equal(existsSync(path.join(runsDir, expectedRef)), true);
      assert.equal(existsSync(path.join(runsDir, `${run.runId}.json`)), false);
      assert.equal(existsSync(runSidecarPath(runsDir, run.runId, '.style-verdict.json')), true);
      const gate = JSON.parse(readFileSync(runSidecarPath(runsDir, run.runId, '.monitor-gate.json'), 'utf8'));
      assert.equal(gate.verdictPath, `${ITERATION_ID}/${run.runId}.monitor-verdict.json`);
      const migratedRun = JSON.parse(readFileSync(path.join(runsDir, expectedRef), 'utf8'));
      assert.equal(migratedRun.monitorGate.contractSha256, monitorGateContractSha256(
        normalizeMonitorGateSidecar(gate, run.runId, expectedRef),
      ));
      validateRunsDir(runsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-schema upgrades finished v1 evidence after validating canonical provenance', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-schema-migrate-'));
    try {
      const sourceRoot = path.join(tempRoot, 'source');
      const runsDir = path.join(tempRoot, 'runs');
      cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), sourceRoot, { recursive: true });
      const graphPath = path.join(sourceRoot, 'gate-c-task-graph', 'task-graph.json');
      const runId = 'run-schema-migration';

      let result = runRuns([
        'start', '--graph', graphPath, '--runs', runsDir,
        '--task', 'task-001', '--run-id', runId,
        '--agent-tool', 'codex', '--workspace', sourceRoot,
      ]);
      assert.equal(result.status, 0, result.stderr);
      result = runRuns([
        'verify', '--runs', runsDir, '--run-id', runId,
        '--workspace', sourceRoot, '--test-command', 'true',
      ]);
      assert.equal(result.status, 0, result.stderr);
      result = runRuns([
        'finish', '--graph', graphPath, '--runs', runsDir,
        '--run-id', runId, '--status', 'finished',
      ]);
      assert.equal(result.status, 0, result.stderr);

      const runPath = runFilePath(runsDir, runId);
      const legacyRun = JSON.parse(readFileSync(runPath, 'utf8'));
      const envelopeRef = executionEnvelopeStoreRef(
        legacyRun,
        legacyRun.executionEnvelopeRef.sha256,
      );
      legacyRun.executionEnvelope = JSON.parse(
        readFileSync(path.join(runsDir, envelopeRef), 'utf8'),
      );
      delete legacyRun.executionEnvelopeRef;
      rmSync(path.join(runsDir, envelopeRef));
      legacyRun.schema_version = 'p2a.run.v1';
      delete legacyRun.taskContractSha256;
      writeJson(runPath, legacyRun);
      validateRunsDir(runsDir);

      const dryRun = runRuns([
        'migrate-schema', '--runs', runsDir, '--run-id', runId, '--dry-run',
      ]);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /p2a\.run\.v1 -> p2a\.run\.v2/);
      assert.match(dryRun.stdout, /inline envelope -> content-addressed reference/);
      assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).schema_version, 'p2a.run.v1');
      assert.equal(existsSync(path.join(runsDir, envelopeRef)), false);

      const migration = runRuns([
        'migrate-schema', '--runs', runsDir, '--run-id', runId, '--yes',
      ]);
      assert.equal(migration.status, 0, migration.stderr);
      const upgradedRun = JSON.parse(readFileSync(runPath, 'utf8'));
      const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
      assert.equal(upgradedRun.schema_version, 'p2a.run.v2');
      assert.equal(upgradedRun.taskContractSha256, taskContractSha256(graph.tasks[0]));
      assert.equal(Object.hasOwn(upgradedRun, 'executionEnvelope'), false);
      assert.deepEqual(upgradedRun.executionEnvelopeRef, {
        sha256: upgradedRun.executionEnvelopeSha256,
      });
      assert.equal(existsSync(path.join(
        runsDir,
        executionEnvelopeStoreRef(upgradedRun, upgradedRun.executionEnvelopeRef.sha256),
      )), true);
      validateRunsDir(runsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout consolidates the previous per-iteration graph runs directory into the global index', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-consolidate-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const runsDir = path.join(tempRoot, 'runs');
      const legacyRun = {
        ...startedRun('run-legacy-graph'),
        sourceLayout: 'graph',
        taskGraphRef: graphPath,
      };
      const legacyEnvelope = executionEnvelopeFixture();
      legacyRun.executionEnvelopeSha256 = createHash('sha256')
        .update(JSON.stringify(legacyEnvelope))
        .digest('hex');
      legacyRun.executionEnvelopeRef = { sha256: legacyRun.executionEnvelopeSha256 };
      const globalRun = {
        ...startedRun('run-global-history'),
        taskId: 'task-002',
        taskTitle: 'Existing global history',
        iterationId: 'iter-001',
        taskGraphRef: 'iterations/iter-001/gate-c-task-graph/task-graph.json',
      };
      writeJson(graphPath, taskGraph());
      writeJson(path.join(legacyRunsDir, `${legacyRun.runId}.json`), legacyRun);
      writeJson(path.join(
        legacyRunsDir,
        executionEnvelopeStoreRef(legacyRun, legacyRun.executionEnvelopeRef.sha256),
      ), legacyEnvelope);
      const legacyIndex = runIndex(legacyRun);
      legacyIndex.retrospective = {
        iterations: [{
          iterationId: 'iter-archived',
          runCount: 2,
          reasonCounts: { superseded: 0, completed_maintenance: 2 },
          statusCounts: { finished: 0, failed: 2, blocked: 0 },
          verificationCount: 2,
          verificationDuration: { sampleCount: 1, totalMs: 34, maxMs: 34 },
          verificationStatusCounts: { passed: 0, failed: 1, skipped: 0, not_run: 0, unavailable: 1 },
          interruptionCounts: {
            implementation_decision: 0,
            user_correction: 1,
            gate_return_valid: 0,
            gate_return_invalid: 0,
          },
        }],
      };
      writeJson(path.join(legacyRunsDir, 'run-index.json'), legacyIndex);
      writeJson(path.join(legacyRunsDir, `${legacyRun.runId}.style-verdict.json`), { violationCount: 0 });
      writeJson(path.join(legacyRunsDir, '.run-id-reservations', 'run-reserved.json'), {
        reservationToken: 'fixture-token',
        ownerPid: 2147483647,
      });
      writeJson(path.join(runsDir, canonicalRunRef(globalRun)), globalRun);
      const globalIndex = runIndex(globalRun, canonicalRunRef(globalRun));
      globalIndex.retrospective = {
        iterations: [{
          iterationId: 'iter-archived',
          runCount: 1,
          reasonCounts: { superseded: 1, completed_maintenance: 0 },
          statusCounts: { finished: 1, failed: 0, blocked: 0 },
          verificationCount: 1,
          verificationDuration: { sampleCount: 1, totalMs: 21, maxMs: 21 },
          verificationStatusCounts: { passed: 1, failed: 0, skipped: 0, not_run: 0, unavailable: 0 },
          interruptionCounts: {
            implementation_decision: 0,
            user_correction: 0,
            gate_return_valid: 0,
            gate_return_invalid: 0,
          },
        }],
      };
      writeJson(path.join(runsDir, 'run-index.json'), globalIndex);

      const dryRun = runRuns(['migrate-layout', '--graph', graphPath, '--dry-run']);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /merge legacy runs/);
      assert.equal(existsSync(path.join(legacyRunsDir, 'run-index.json')), true);

      const migration = runRuns(['migrate-layout', '--graph', graphPath, '--yes']);
      assert.equal(migration.status, 0, migration.stderr);
      assert.equal(existsSync(path.join(legacyRunsDir, 'run-index.json')), false);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, `${legacyRun.runId}.json`)), true);
      assert.equal(existsSync(path.join(
        runsDir,
        executionEnvelopeStoreRef(legacyRun, legacyRun.executionEnvelopeRef.sha256),
      )), true);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, `${legacyRun.runId}.style-verdict.json`)), true);
      assert.equal(existsSync(path.join(runsDir, '.run-id-reservations', 'run-reserved.json')), true);
      const redirect = JSON.parse(readFileSync(path.join(legacyRunsDir, RUN_STORE_REDIRECT_FILE), 'utf8'));
      assert.equal(redirect.targetRunsDir, runsDir);
      const index = validateRunsDir(runsDir);
      assert.deepEqual(index.runs.map((entry) => entry.runId), [globalRun.runId, legacyRun.runId]);
      assert.deepEqual(index.retrospective, {
        iterations: [{
          iterationId: 'iter-archived',
          runCount: 3,
          reasonCounts: { superseded: 1, completed_maintenance: 2 },
          statusCounts: { finished: 1, failed: 2, blocked: 0 },
          verificationCount: 3,
          verificationDuration: { sampleCount: 2, totalMs: 55, maxMs: 34 },
          verificationStatusCounts: { passed: 1, failed: 1, skipped: 0, not_run: 0, unavailable: 1 },
          interruptionCounts: {
            implementation_decision: 0,
            user_correction: 1,
            gate_return_valid: 0,
            gate_return_invalid: 0,
          },
        }],
      });
      assert.equal(indexedRunRef(runsDir, legacyRun.runId), `${ITERATION_ID}/${legacyRun.runId}.json`);
      const migratedRun = JSON.parse(readFileSync(runFilePath(runsDir, legacyRun.runId), 'utf8'));
      assert.equal(migratedRun.sourceLayout, 'graph');
      assert.equal(migratedRun.taskGraphRef, graphPath);

      const status = runExecute(['status', '--graph', graphPath, '--task', legacyRun.taskId]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, new RegExp(`runId: ${legacyRun.runId}`));

      const legacyGraphPath = path.join(tempRoot, 'legacy-cli', 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(legacyGraphPath);
      writeJson(legacyGraphPath, taskGraph());
      const staleStart = runRuns([
        'start',
        '--graph', legacyGraphPath,
        '--runs', legacyRunsDir,
        '--task', 'task-001',
        '--run-id', 'run-after-retirement',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(staleStart.status, 1);
      assert.match(staleStart.stderr, /run store is retired after layout migration/);
      assert.equal(existsSync(path.join(legacyRunsDir, 'run-index.json')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout rejects unindexed target runs before moving legacy history', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-target-preflight-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const runsDir = path.join(tempRoot, 'runs');
      const legacyRun = {
        ...startedRun('run-legacy-preflight'),
        sourceLayout: 'graph',
        taskGraphRef: graphPath,
      };
      const unindexedRun = startedRun('run-unindexed-target');
      writeJson(graphPath, taskGraph());
      writeJson(path.join(legacyRunsDir, `${legacyRun.runId}.json`), legacyRun);
      writeJson(path.join(legacyRunsDir, 'run-index.json'), runIndex(legacyRun));
      writeJson(path.join(runsDir, `${unindexedRun.runId}.json`), unindexedRun);

      const migration = runRuns(['migrate-layout', '--graph', graphPath, '--yes']);

      assert.equal(migration.status, 1);
      assert.match(migration.stderr, /run-index\.json is missing while run records still exist/);
      assert.equal(existsSync(path.join(legacyRunsDir, `${legacyRun.runId}.json`)), true);
      assert.equal(existsSync(path.join(legacyRunsDir, 'run-index.json')), true);
      assert.equal(existsSync(path.join(runsDir, `${unindexedRun.runId}.json`)), true);
      assert.equal(existsSync(path.join(runsDir, '.run-layout-migration')), false);
      assert.equal(existsSync(path.join(legacyRunsDir, RUN_STORE_REDIRECT_FILE)), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout refuses a reservation owned by a live start process', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-active-reservation-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const run = startedRun('run-existing-history');
      writeJson(graphPath, taskGraph());
      writeJson(path.join(legacyRunsDir, `${run.runId}.json`), run);
      writeJson(path.join(legacyRunsDir, 'run-index.json'), runIndex(run));
      writeJson(path.join(legacyRunsDir, '.run-id-reservations', 'run-active-reservation.json'), {
        runId: 'run-active-reservation',
        reservationToken: 'active-token',
        ownerPid: process.pid,
      });

      const migration = runRuns(['migrate-layout', '--graph', graphPath, '--yes']);
      assert.equal(migration.status, 1);
      assert.match(migration.stderr, /start still owns reservation run-active-reservation/);
      assert.equal(existsSync(path.join(legacyRunsDir, RUN_STORE_REDIRECT_FILE)), false);
      validateRunsDir(legacyRunsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout refuses a legacy reservation whose owner cannot be identified', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-legacy-reservation-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const run = startedRun('run-legacy-reservation-history');
      writeJson(graphPath, taskGraph());
      writeJson(path.join(legacyRunsDir, `${run.runId}.json`), run);
      writeJson(path.join(legacyRunsDir, 'run-index.json'), runIndex(run));
      writeJson(path.join(legacyRunsDir, '.run-id-reservations', 'run-legacy-reservation.json'), {
        runId: 'run-legacy-reservation',
        reservationToken: 'legacy-token',
      });

      const migration = runRuns(['migrate-layout', '--graph', graphPath, '--yes']);
      assert.equal(migration.status, 1);
      assert.match(migration.stderr, /cannot safely migrate legacy reservation run-legacy-reservation without ownerPid/);
      assert.equal(existsSync(path.join(legacyRunsDir, RUN_STORE_REDIRECT_FILE)), false);
      validateRunsDir(legacyRunsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout rejects duplicate run ids across global and legacy graph indexes before moving files', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-duplicate-'));
    try {
      const graphPath = path.join(tempRoot, 'iterations', ITERATION_ID, 'gate-c-task-graph', 'task-graph.json');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const runsDir = path.join(tempRoot, 'runs');
      const duplicateRun = startedRun('run-duplicate-history');
      writeJson(graphPath, taskGraph());
      writeJson(path.join(legacyRunsDir, `${duplicateRun.runId}.json`), duplicateRun);
      writeJson(path.join(legacyRunsDir, 'run-index.json'), runIndex(duplicateRun));
      writeJson(path.join(runsDir, canonicalRunRef(duplicateRun)), duplicateRun);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(duplicateRun, canonicalRunRef(duplicateRun)));

      const migration = runRuns(['migrate-layout', '--graph', graphPath, '--yes']);
      assert.notEqual(migration.status, 0);
      assert.match(migration.stderr, /cannot merge duplicate run id run-duplicate-history/);
      assert.equal(existsSync(path.join(legacyRunsDir, `${duplicateRun.runId}.json`)), true);
      assert.equal(existsSync(path.join(legacyRunsDir, 'run-index.json')), true);
      assert.equal(existsSync(path.join(runsDir, canonicalRunRef(duplicateRun))), true);
      validateRunsDir(legacyRunsDir);
      validateRunsDir(runsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout rejects a canonical index whose run file is missing', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-invalid-canonical-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun();
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run, canonicalRunRef(run)));

      const result = runRuns(['migrate-layout', '--runs', runsDir, '--yes']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('start rejects a run id retained by the index even when its run file is missing', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-stale-index-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const priorRun = {
        ...startedRun(),
        iterationId: 'iter-001',
        taskGraphRef: 'iterations/iter-001/gate-c-task-graph/task-graph.json',
      };
      const priorRef = canonicalRunRef(priorRun);
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(priorRun, priorRef));

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', priorRun.runId,
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /run already exists/);
      assert.equal(existsSync(path.join(runsDir, priorRef)), false);
      assert.equal(existsSync(path.join(runsDir, canonicalRunRef({ ...priorRun, iterationId: ITERATION_ID }))), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('start refuses to initialize a new index over unindexed partitioned run records', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-missing-index-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const priorRun = {
        ...startedRun('run-task-001-001'),
        iterationId: 'iter-001',
        taskGraphRef: 'iterations/iter-001/gate-c-task-graph/task-graph.json',
      };
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, canonicalRunRef(priorRun)), priorRun);

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001-001',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /run-index\.json is missing while run records still exist/);
      assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
      assert.equal(existsSync(path.join(runsDir, canonicalRunRef(priorRun))), true);
      assert.equal(existsSync(path.join(runsDir, ITERATION_ID, 'run-task-001-001.json')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('start refuses to initialize a new index over a legacy sidecar-named run record', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-sidecar-named-record-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      const priorRun = startedRun('run-task-001-001.monitor-gate');
      const priorRef = canonicalRunRef(priorRun);
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, priorRef), priorRun);

      const result = runRuns([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', 'run-task-001-002',
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /run-index\.json is missing while run records still exist/);
      assert.match(result.stderr, new RegExp(priorRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
      assert.equal(existsSync(path.join(runsDir, priorRef)), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('validateRunsDir rejects an unindexed legacy sidecar-named run record', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-unindexed-sidecar-named-record-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const indexedRun = startedRun('run-task-001-001');
      const legacyRun = startedRun('run-task-001-002.monitor-gate');
      const indexedRef = canonicalRunRef(indexedRun);
      const legacyRef = canonicalRunRef(legacyRun);
      writeJson(path.join(runsDir, indexedRef), indexedRun);
      writeJson(path.join(runsDir, legacyRef), legacyRun);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(indexedRun, indexedRef));

      assert.throws(
        () => validateRunsDir(runsDir),
        new RegExp(`unindexed run file\\(s\\): .*${legacyRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('validateRunsDir rejects nested directories inside a run partition', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-nested-entry-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun('run-task-001-001');
      const runRef = canonicalRunRef(run);
      writeJson(path.join(runsDir, runRef), run);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run, runRef));
      writeJson(path.join(runsDir, ITERATION_ID, 'nested', 'run-hidden.json'), run);

      assert.throws(
        () => validateRunsDir(runsDir),
        /unsupported nested entry\(s\): iter-002\/nested/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('concurrent starts preserve every run in the global index', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-concurrent-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      const starts = Array.from({ length: 8 }, (_, index) => runRunsAsync([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', `run-concurrent-${String(index + 1).padStart(3, '0')}`,
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]));
      const results = await Promise.all(starts);
      for (const result of results) assert.equal(result.status, 0, result.stderr);
      const index = validateRunsDir(runsDir);
      assert.equal(index.runs.length, starts.length);
      assert.equal(new Set(index.runs.map((entry) => entry.runId)).size, starts.length);
      assert.equal(existsSync(path.join(runsDir, '.run-store.lock')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('concurrent starts safely reclaim one stale run-store lock', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-stale-lock-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, RUN_STORE_LOCK_FILE), {
        pid: 2147483647,
        token: 'dead-owner',
        acquiredAt: '2026-07-18T00:00:00.000Z',
      });
      const starts = Array.from({ length: 12 }, (_, index) => runRunsAsync([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', `run-stale-lock-${String(index + 1).padStart(3, '0')}`,
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]));
      const results = await Promise.all(starts);
      for (const result of results) assert.equal(result.status, 0, result.stderr);
      const index = validateRunsDir(runsDir);
      assert.equal(index.runs.length, starts.length);
      assert.equal(new Set(index.runs.map((entry) => entry.runId)).size, starts.length);
      assert.equal(existsSync(path.join(runsDir, RUN_STORE_LOCK_FILE)), false);
      assert.equal(existsSync(path.join(runsDir, RUN_STORE_REAPER_LOCK_FILE)), false);
      assert.equal(readdirSync(runsDir).some((name) => name.startsWith(`${RUN_STORE_REAPER_LOCK_FILE}.claim-`)), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('concurrent starts recover a stale reaper without deleting a live replacement', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-stale-reaper-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const graphPath = path.join(tempRoot, 'gate-c-task-graph', 'task-graph.json');
      writeApprovedRunSourceForGraph(graphPath);
      writeJson(graphPath, taskGraph());
      writeJson(path.join(runsDir, RUN_STORE_LOCK_FILE), {
        pid: 2147483647,
        token: 'dead-lock-owner',
        acquiredAt: '2026-07-18T00:00:00.000Z',
      });
      writeJson(path.join(runsDir, RUN_STORE_REAPER_LOCK_FILE), {
        pid: 2147483647,
        token: 'dead-reaper-owner',
        acquiredAt: '2026-07-18T00:00:00.000Z',
      });
      const starts = Array.from({ length: 12 }, (_, index) => runRunsAsync([
        'start',
        '--graph', graphPath,
        '--runs', runsDir,
        '--task', 'task-001',
        '--run-id', `run-stale-reaper-${String(index + 1).padStart(3, '0')}`,
        '--agent-tool', 'codex',
        '--workspace', tempRoot,
      ]));
      const results = await Promise.all(starts);
      for (const result of results) assert.equal(result.status, 0, result.stderr);
      const index = validateRunsDir(runsDir);
      assert.equal(index.runs.length, starts.length);
      assert.equal(new Set(index.runs.map((entry) => entry.runId)).size, starts.length);
      assert.equal(existsSync(path.join(runsDir, RUN_STORE_LOCK_FILE)), false);
      assert.equal(existsSync(path.join(runsDir, RUN_STORE_REAPER_LOCK_FILE)), false);
      assert.equal(readdirSync(runsDir).some((name) => name.startsWith(`${RUN_STORE_REAPER_LOCK_FILE}.claim-`)), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout resumes a journal after files moved but before the index commit', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-resume-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun('run-migration-resume');
      const source = path.join(runsDir, `${run.runId}.json`);
      const targetRef = canonicalRunRef(run);
      const target = path.join(runsDir, targetRef);
      const mergedIndex = runIndex(run, targetRef);
      writeJson(source, run);
      writeJson(path.join(runsDir, 'run-index.json'), runIndex(run));
      writeJson(path.join(runsDir, '.run-layout-migration'), {
        schema_version: 'p2a.run_layout_migration.v1',
        targetRunsDir: runsDir,
        sourceRunsDirs: [runsDir],
        mergedIndex,
        legacyIndexFiles: [],
        moves: [{ source, target, replacement: null }],
      });
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(source, target);

      const result = runRuns(['migrate-layout', '--runs', runsDir, '--yes']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /resumed migration/);
      assert.equal(existsSync(path.join(runsDir, '.run-layout-migration')), false);
      assert.equal(validateRunsDir(runsDir).runs[0].runRef, targetRef);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('migrate-layout refuses to resume when an unretired legacy store changed after journaling', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-layout-source-drift-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const legacyRunsDir = path.join(tempRoot, 'iterations', ITERATION_ID, 'runs');
      const legacyRun = startedRun('run-before-journal');
      const legacyRunPath = path.join(legacyRunsDir, `${legacyRun.runId}.json`);
      const legacyIndexPath = path.join(legacyRunsDir, 'run-index.json');
      const targetRef = canonicalRunRef(legacyRun);
      const targetPath = path.join(runsDir, targetRef);
      writeJson(legacyRunPath, legacyRun);
      writeJson(legacyIndexPath, runIndex(legacyRun));
      const sourcePrecondition = {
        runsDir: legacyRunsDir,
        files: [
          { ref: 'run-index.json', sha256: fileSha256(legacyIndexPath) },
          { ref: `${legacyRun.runId}.json`, sha256: fileSha256(legacyRunPath) },
        ],
      };
      writeJson(path.join(runsDir, '.run-layout-migration'), {
        schema_version: 'p2a.run_layout_migration.v1',
        targetRunsDir: runsDir,
        sourceRunsDirs: [runsDir, legacyRunsDir],
        retiredRunsDirs: [legacyRunsDir],
        sourcePreconditions: [sourcePrecondition],
        mergedIndex: runIndex(legacyRun, targetRef),
        legacyIndexFiles: [legacyIndexPath],
        moves: [{ source: legacyRunPath, target: targetPath, replacement: null }],
      });

      const addedRun = { ...startedRun('run-after-journal'), updatedAt: '2026-07-18T00:02:00.000Z' };
      const addedEntry = runIndex(addedRun).runs[0];
      writeJson(path.join(legacyRunsDir, `${addedRun.runId}.json`), addedRun);
      writeJson(legacyIndexPath, {
        schema_version: 'p2a.run_index.v1',
        projectId: legacyRun.projectId,
        runs: [...runIndex(legacyRun).runs, addedEntry],
        tasks: [{ taskId: legacyRun.taskId, runIds: [legacyRun.runId, addedRun.runId], latestRunId: addedRun.runId }],
      });

      const migration = runRuns(['migrate-layout', '--artifacts', tempRoot, '--yes']);

      assert.equal(migration.status, 1);
      assert.match(migration.stderr, /legacy run store changed after migration journal creation/);
      assert.equal(existsSync(legacyRunPath), true);
      assert.equal(existsSync(path.join(legacyRunsDir, `${addedRun.runId}.json`)), true);
      assert.equal(existsSync(legacyIndexPath), true);
      assert.equal(existsSync(targetPath), false);
      assert.equal(existsSync(path.join(legacyRunsDir, RUN_STORE_REDIRECT_FILE)), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('the next run mutation completes an interrupted run-file and index transaction', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-write-resume-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun('run-write-resume');
      const runRef = canonicalRunRef(run);
      const priorIndex = runIndex(run, runRef);
      writeJson(path.join(tempRoot, run.taskGraphRef), taskGraph());
      writeJson(path.join(runsDir, runRef), run);
      writeJson(path.join(runsDir, 'run-index.json'), priorIndex);

      const interruptedRun = { ...run, status: 'finished', updatedAt: '2026-07-18T00:01:00.000Z', finishedAt: '2026-07-18T00:01:00.000Z' };
      const interruptedIndex = runIndex(interruptedRun, runRef);
      writeJson(path.join(runsDir, '.run-write-transaction'), {
        schema_version: 'p2a.run_write_transaction.v1',
        runRef,
        run: interruptedRun,
        index: interruptedIndex,
      });
      writeJson(path.join(runsDir, runRef), interruptedRun);

      const result = runRuns(['record', '--runs', runsDir, '--run-id', run.runId, '--note', 'recovered']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(path.join(runsDir, '.run-write-transaction')), false);
      const index = validateRunsDir(runsDir);
      assert.equal(index.runs[0].status, 'finished');
      assert.equal(JSON.parse(readFileSync(path.join(runsDir, runRef), 'utf8')).notes.includes('recovered'), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('a malformed monitor transaction is rejected before writing its run or index', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-monitor-invalid-transaction-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun('run-monitor-invalid-transaction');
      const runRef = canonicalRunRef(run);
      writeJson(path.join(runsDir, '.run-write-transaction'), {
        schema_version: 'p2a.run_write_transaction.v1',
        runRef,
        run,
        index: runIndex(run, runRef),
        monitorGate: {
          schema_version: 'p2a.monitor_gate.v1',
          runId: run.runId,
          required: true,
          verdictPath: 'wrong.monitor-verdict.json',
          acceptedVerdicts: ['confirm_done'],
          failureClassMap: {},
        },
      });

      const recovered = runRuns(['record', '--runs', runsDir, '--run-id', run.runId, '--note', 'must not write']);
      assert.equal(recovered.status, 1);
      assert.match(recovered.stderr, /monitor gate verdictPath must be/);
      assert.equal(existsSync(path.join(runsDir, runRef)), false);
      assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
      assert.equal(existsSync(runSidecarPath(runsDir, run.runId, '.monitor-gate.json')), false);
      assert.equal(existsSync(path.join(runsDir, '.run-write-transaction')), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('the next run mutation recovers monitor intent and reservation from an interrupted start', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-run-monitor-start-resume-'));
    try {
      const runsDir = path.join(tempRoot, 'runs');
      const run = startedRun('run-monitor-start-resume');
      const runRef = canonicalRunRef(run);
      const index = runIndex(run, runRef);
      const reservationToken = 'monitor-start-reservation';
      writeJson(path.join(tempRoot, run.taskGraphRef), taskGraph());
      writeJson(path.join(runsDir, '.run-write-transaction'), {
        schema_version: 'p2a.run_write_transaction.v1',
        runRef,
        run,
        index,
        monitorGate: {
          schema_version: 'p2a.monitor_gate.v1',
          runId: run.runId,
          required: true,
          verdictPath: runSidecarRef(runRef, '.monitor-verdict.json'),
          acceptedVerdicts: ['confirm_done'],
          failureClassMap: {},
        },
        reservation: { runId: run.runId, token: reservationToken },
      });
      writeJson(path.join(runsDir, runRef), run);
      writeJson(path.join(runsDir, 'run-index.json'), index);
      writeJson(path.join(runsDir, '.run-id-reservations', `${run.runId}.json`), {
        runId: run.runId,
        reservationToken,
      });

      const recovered = runRuns(['record', '--runs', runsDir, '--run-id', run.runId, '--note', 'recovered']);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(existsSync(path.join(runsDir, '.run-write-transaction')), false);
      assert.equal(existsSync(path.join(runsDir, '.run-id-reservations', `${run.runId}.json`)), false);
      const gate = JSON.parse(readFileSync(runSidecarPath(runsDir, run.runId, '.monitor-gate.json'), 'utf8'));
      assert.equal(gate.required, true);
      assert.equal(gate.verdictPath, runSidecarRef(runRef, '.monitor-verdict.json'));

      const finish = runRuns(['finish', '--runs', runsDir, '--run-id', run.runId, '--status', 'finished']);
      assert.equal(finish.status, 1);
      assert.match(finish.stderr, /monitor verdict is missing/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
