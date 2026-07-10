import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommandResult, makeTempDir, runMemory } from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeArtifactRoot() {
  const tempRoot = makeTempDir('p2a-memory-graph-');
  const artifactRoot = path.join(tempRoot, 'graph-fixture');
  writeJson(path.join(artifactRoot, 'current-spec.json'), { schema_version: 'p2a.current_spec.v1', project_id: 'graph-fixture', active_iteration: 'iter-1', effective_spec_ref: 'iterations/iter-1/gate-b-spec/spec.json' });
  writeFileSync(path.join(artifactRoot, 'status.md'), '# Status\n', 'utf8');
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-a-intake', 'intake.json'), {
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    evidence: [{ id: 'EV-1', title: 'Evidence One', summary: 'important proof' }],
    needs_user_decision: [{ id: 'ND-1', question: 'Choose mode?', answer: 'A', status: 'answered', evidence: ['EV-1'] }],
    assumptions: [{ id: 'A-1', statement: 'Assume cache exists', evidence: ['EV-1'] }],
    clarifying_questions: [{ id: 'CQ-1', question: 'Need detail?', status: 'answered', blocks: ['product.scope'] }],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-b-spec', 'spec.json'), {
    schema_version: 'p2a.spec.v1',
    source_intake: '../gate-a-intake/intake.json',
    evidence: [{ id: 'EV-1', title: 'Evidence One duplicate', summary: 'same proof' }],
    clarifying_question_disposition: [{ id: 'CQ-1', disposition: 'answered' }],
    open_decisions: [{ id: 'ND-2', question: 'Later?', status: 'open' }],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-c-task-graph', 'task-graph.json'), {
    schema_version: 'p2a.task_graph.v1', projectId: 'graph-fixture', version: 'iter-1', sourceSpec: '../gate-b-spec/spec.json',
    tasks: [
      { id: 'task-001', title: 'First', description: 'd', status: 'todo', dependencies: [], acceptanceCriteria: ['a'], targetArea: 'x', suggestedAgentPrompt: 'p', sourceSpecRefs: ['product.scope'] },
      { id: 'task-002', title: 'Second', description: 'd', status: 'todo', dependencies: ['task-001'], acceptanceCriteria: ['a'], targetArea: 'x', suggestedAgentPrompt: 'p', sourceSpecRefs: ['implementation.plan'] },
    ],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-d-review', 'review.json'), { schema_version: 'fixture' });
  const run = { schema_version: 'p2a.run.v1', runId: 'run-1', projectId: 'graph-fixture', taskId: 'task-002', taskTitle: 'Second', iterationId: 'iter-1', sourceLayout: 'iteration', taskGraphRef: 'iterations/iter-1/gate-c-task-graph/task-graph.json', agentTool: 'codex', workspaceRef: 'w', workspacePath: '.', isolation: {}, status: 'finished', startedAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z', finishedAt: '2026-07-10T00:00:00.000Z', changedFiles: [], verification: [], notes: [] };
  writeJson(path.join(artifactRoot, 'runs', 'run-index.json'), { schema_version: 'p2a.run_index.v1', projectId: 'graph-fixture', runs: [{ runId: 'run-1', taskId: 'task-002', iterationId: 'iter-1', status: 'finished', agentTool: 'codex', workspaceRef: 'w', taskGraphRef: 'iterations/iter-1/gate-c-task-graph/task-graph.json', runRef: 'runs/run-1.json', startedAt: run.startedAt, finishedAt: run.finishedAt }], tasks: [{ taskId: 'task-002', runIds: ['run-1'], latestRunId: 'run-1' }] });
  writeJson(path.join(artifactRoot, 'runs', 'run-1.json'), run);
  return { tempRoot, artifactRoot };
}

test('memory status includes stable graph index nodes and lineage edges', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const first = runMemory(['status', '--artifacts', artifactRoot, '--json']);
    const second = runMemory(['status', '--artifacts', artifactRoot, '--json']);
    assert.equal(first.status, 0, formatCommandResult(first));
    assert.equal(second.status, 0, formatCommandResult(second));
    const a = JSON.parse(first.stdout);
    const b = JSON.parse(second.stdout);
    assert.equal(a.local.graphNodes, b.local.graphNodes);
    assert.equal(a.local.graphEdges, b.local.graphEdges);
    assert.ok(a.local.graphNodes >= 10, JSON.stringify(a.local));
    assert.ok(a.local.graphEdges >= 4, JSON.stringify(a.local));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
