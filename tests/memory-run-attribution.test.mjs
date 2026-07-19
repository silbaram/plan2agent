import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommandResult, makeTempDir, runMemory } from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function task(id, title) {
  return {
    id,
    title,
    description: `${title} description`,
    status: 'todo',
    dependencies: [],
    acceptanceCriteria: [`${title} acceptance`],
    targetArea: title.toLowerCase().replace(/\s+/g, '-'),
    suggestedAgentPrompt: `${title} prompt`,
    sourceSpecRefs: ['fixture'],
  };
}

function graph(projectId, version, tasks) {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId,
    version,
    sourceSpec: '../gate-b-spec/spec.json',
    tasks,
  };
}

function run(runId, taskId, iterationId, sourceLayout, taskGraphRef) {
  const now = '2026-07-09T00:00:00.000Z';
  return {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'memory-attribution',
    taskId,
    taskTitle: `${taskId} run`,
    iterationId,
    sourceLayout,
    taskGraphRef,
    sourceSpecRef: 'gate-b-spec/spec.json',
    agentTool: 'codex',
    workspaceRef: 'workspace',
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
    status: 'finished',
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    changedFiles: [],
    verification: [],
    notes: [],
  };
}

function writeRunSet(artifactRoot) {
  const runsDir = path.join(artifactRoot, 'runs');
  const runs = [
    run('run-active', 'task-001', 'v2', 'iteration', 'iterations/v2/gate-c-task-graph/task-graph.json'),
    run('run-maintenance', 'task-010', 'maintenance', 'maintenance', 'iterations/maintenance/gate-c-task-graph/task-graph.json'),
    run('run-closed', 'task-001', 'v1', 'iteration', 'iterations/v1/gate-c-task-graph/task-graph.json'),
    run('run-missing-graph', 'task-999', 'v404', 'iteration', 'iterations/v404/gate-c-task-graph/task-graph.json'),
  ];
  mkdirSync(runsDir, { recursive: true });
  writeJson(path.join(runsDir, 'run-index.json'), {
    schema_version: 'p2a.run_index.v1',
    projectId: 'memory-attribution',
    runs: runs.map((item) => ({
      runId: item.runId,
      taskId: item.taskId,
      iterationId: item.iterationId,
      status: item.status,
      agentTool: item.agentTool,
      workspaceRef: item.workspaceRef,
      taskGraphRef: item.taskGraphRef,
      runRef: `${item.runId}.json`,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    })),
    tasks: [...new Map(runs.map((item) => [item.taskId, item])).values()].map((item) => ({ taskId: item.taskId, runIds: runs.filter((runItem) => runItem.taskId === item.taskId).map((runItem) => runItem.runId), latestRunId: item.runId })),
  });
  for (const item of runs) writeJson(path.join(runsDir, `${item.runId}.json`), item);
}

function makeArtifactRoot() {
  const tempRoot = makeTempDir('p2a-memory-attribution-');
  const artifactRoot = path.join(tempRoot, 'memory-attribution');
  writeJson(path.join(artifactRoot, 'current-spec.json'), {
    schema_version: 'p2a.current_spec.v1',
    project_id: 'memory-attribution',
    active_iteration: 'v2',
    effective_spec_ref: 'iterations/v2/gate-b-spec/spec.json',
  });
  writeFileSync(path.join(artifactRoot, 'status.md'), '# Status\n\nActive iteration: v2\n', 'utf8');
  writeJson(path.join(artifactRoot, 'iterations', 'v2', 'gate-b-spec', 'spec.json'), { schema_version: 'fixture' });
  writeJson(path.join(artifactRoot, 'iterations', 'v1', 'gate-b-spec', 'spec.json'), { schema_version: 'fixture' });
  writeJson(path.join(artifactRoot, 'iterations', 'maintenance', 'gate-b-spec', 'spec.json'), { schema_version: 'fixture' });
  writeJson(path.join(artifactRoot, 'iterations', 'v2', 'gate-c-task-graph', 'task-graph.json'), graph('memory-attribution', 'v2', [task('task-001', 'Active duplicate id'), task('task-002', 'Active only')]));
  writeJson(path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json'), graph('memory-attribution', 'v1', [task('task-001', 'Closed duplicate id')]));
  writeJson(path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json'), graph('memory-attribution', 'maintenance', [task('task-010', 'Maintenance task')]));
  writeJson(path.join(artifactRoot, 'iterations', 'v2', 'gate-d-review', 'review.json'), { schema_version: 'fixture' });
  writeRunSet(artifactRoot);
  return { tempRoot, artifactRoot };
}

test('memory run attribution follows run-owned iteration graph instead of active graph', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const result = runMemory(['status', '--artifacts', artifactRoot, '--json']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.local.runs, 3, JSON.stringify(payload, null, 2));
    assert.equal(payload.local.skippedRuns, 1);
    assert.equal(payload.local.iterations, 3);
    assert.equal(payload.local.taskGraphs, 3);

    const byRun = new Map(payload.sync.items.filter((item) => item.artifactType === 'RUN_RECORD').map((item) => [item.metadata.sourceRunId, item]));
    const iterations = payload.sync.items
      .filter((item) => item.artifactType === 'ITERATION')
      .map((item) => [item.metadata.sourceIterationId, item.metadata.sourceLayout]);
    const graphByIteration = new Map(payload.sync.items.filter((item) => item.artifactType === 'TASK_GRAPH').map((item) => [item.metadata.sourceIterationId, item.metadata.sourceTaskGraphId]));

    assert.deepEqual(iterations, [['v2', 'iteration'], ['maintenance', 'maintenance'], ['v1', 'iteration']]);

    assert.equal(byRun.get('run-active')?.metadata.sourceIterationId, 'v2');
    assert.equal(byRun.get('run-active')?.metadata.sourceTaskGraphId, graphByIteration.get('v2'));
    assert.equal(byRun.get('run-maintenance')?.metadata.sourceIterationId, 'maintenance');
    assert.equal(byRun.get('run-maintenance')?.metadata.sourceTaskGraphId, graphByIteration.get('maintenance'));
    assert.equal(byRun.get('run-closed')?.metadata.sourceIterationId, 'v1');
    assert.equal(byRun.get('run-closed')?.metadata.sourceTaskGraphId, graphByIteration.get('v1'));

    assert.equal(payload.skippedRuns.length, 1);
    assert.equal(payload.skippedRuns[0].runId, 'run-missing-graph');
    assert.match(payload.skippedRuns[0].reason, /iterations\/v404\/gate-c-task-graph\/task-graph\.json/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
