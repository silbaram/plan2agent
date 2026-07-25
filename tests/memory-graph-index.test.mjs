import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommandResult, makeTempDir, runMemory } from './helpers/fixtures.mjs';
import {
  buildMemoryPlan,
  compareSync,
  incomingEdgeLabel,
  normalizeMemoryTrace,
  precedentTraceScope,
  pushPlan,
} from '../scripts/p2a_memory.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertGraphWireContract(graph) {
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  const edgeTriples = new Set();
  for (const node of graph.nodes) {
    assert.ok(Object.values(node.metadata).every((value) => typeof value === 'string'));
  }
  for (const edge of graph.edges) {
    assert.ok(edge.sourceReference === null || typeof edge.sourceReference === 'string');
    assert.ok(Object.values(edge.metadata).every((value) => typeof value === 'string'));
    assert.ok(nodeIds.has(edge.fromNodeId));
    assert.ok(nodeIds.has(edge.toNodeId));
    const triple = JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.edgeType]);
    assert.equal(edgeTriples.has(triple), false, `duplicate graph edge: ${triple}`);
    edgeTriples.add(triple);
  }
}

function makeArtifactRoot(runIterationId = 'iter-1') {
  const tempRoot = makeTempDir('p2a-memory-graph-');
  const artifactRoot = path.join(tempRoot, 'graph-fixture');
  writeJson(path.join(artifactRoot, 'current-spec.json'), { schema_version: 'p2a.current_spec.v1', project_id: 'graph-fixture', active_iteration: 'iter-1', effective_spec_ref: 'iterations/iter-1/gate-b-spec/spec.json' });
  writeFileSync(path.join(artifactRoot, 'status.md'), '# Status\n', 'utf8');
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-a-intake', 'intake.json'), {
    schema_version: 'p2a.intake.v1',
    status: 'ready_for_spec',
    evidence: [{ source_id: 'LOCAL-1', title: 'Evidence One', url: '', used_for: 'Important proof.' }],
    needs_user_decision: [{ id: 'ND-1', question: 'Choose mode?', answer: 'A', status: 'answered' }],
    assumptions: [{ id: 'A-1', statement: 'Assume cache exists' }],
    clarifying_questions: [
      { id: 'CQ-1', question: 'Need detail?', status: 'answered', blocks: ['product.scope'] },
      { id: 'CQ-2', question: 'Choose retry policy?', status: 'answered', blocks: ['implementation.plan'] },
    ],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-a-intake', 'memory-recall.json'), {
    schema_version: 'p2a.memory_search.v1',
    query: {
      text: 'prior retry failure',
      mode: 'hybrid',
      effectiveMode: 'hybrid',
      scope: 'project',
    },
    results: [],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-b-spec', 'spec.json'), {
    schema_version: 'p2a.spec.v1',
    source_intake: '../gate-a-intake/intake.json',
    evidence: [{ source_id: 'LOCAL-1', title: 'Evidence One duplicate', url: '../gate-a-intake/intake.json', used_for: 'Same proof.' }],
    clarifying_question_disposition: [
      { id: 'CQ-1', status: 'answered', rationale: 'Resolved directly.', affects: ['product.scope'] },
      {
        id: 'CQ-2',
        status: 'promoted_to_decision',
        rationale: 'Required an explicit Gate B decision.',
        affects: ['implementation.plan'],
        promoted_decision_id: 'ND-3',
        resolution: 'Use bounded retries.',
      },
    ],
    open_decisions: ['ND-2'],
    reference_reconnaissance: {
      candidates: [{ candidate_id: 'REF-1', source_id: 'LOCAL-1', decision: 'context' }],
    },
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-c-task-graph', 'task-graph.json'), {
    schema_version: 'p2a.task_graph.v1', projectId: 'graph-fixture', version: 'iter-1', sourceSpec: '../gate-b-spec/spec.json',
    tasks: [
      { id: 'task-001', title: 'First', description: 'd', status: 'todo', dependencies: [], acceptanceCriteria: ['a'], targetArea: 'x', suggestedAgentPrompt: 'p', sourceSpecRefs: ['product.scope'] },
      {
        id: 'task-002',
        title: 'Second',
        description: 'd',
        status: 'todo',
        dependencies: ['task-001'],
        acceptanceCriteria: ['a'],
        targetArea: 'x',
        suggestedAgentPrompt: 'p',
        sourceSpecRefs: [
          'implementation.plan',
          'decision:ND-1',
          'decision:ND-2',
          'decision:ND-3',
          'decision:ND-99',
          'memory:iterations/iter-1/gate-a-intake/memory-recall.json',
        ],
      },
    ],
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'gate-d-review', 'review.json'), { schema_version: 'fixture' });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'milestone-reviews', 'midpoint.json'), {
    schema_version: 'p2a.milestone_review.v1',
    checkpoint: 'midpoint',
    note: 'Stable milestone fixture for Memory document persistence.',
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-1', 'milestone-reviews', 'pre_close.draft.json'), {
    schema_version: 'p2a.milestone_review.v1',
    checkpoint: 'pre_close',
    note: 'Drafts must not be persisted to Memory.',
  });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-closed', 'milestone-reviews', 'pre_close.json'), {
    schema_version: 'p2a.milestone_review.v1',
    checkpoint: 'pre_close',
    note: 'Closed iteration milestones must remain discoverable for a later Memory push.',
  });
  const run = { schema_version: 'p2a.run.v1', runId: 'run-1', projectId: 'graph-fixture', taskId: 'task-002', taskTitle: 'Second', iterationId: runIterationId, sourceLayout: 'iteration', taskGraphRef: 'iterations/iter-1/gate-c-task-graph/task-graph.json', sourceSpecRef: 'iterations/iter-1/gate-b-spec/spec.json', agentTool: 'codex', workspaceRef: 'w', workspacePath: '.', isolation: { mode: 'none', branch: null, worktree: null, baseRef: null, created: false, createCommand: null, createExitCode: null, createOutputTail: null }, status: 'finished', startedAt: '2026-07-10T00:00:00.000Z', updatedAt: '2026-07-10T00:00:00.000Z', finishedAt: '2026-07-10T00:00:00.000Z', changedFiles: [], verification: [], notes: [] };
  writeJson(path.join(artifactRoot, 'runs', 'run-index.json'), { schema_version: 'p2a.run_index.v1', projectId: 'graph-fixture', runs: [{ runId: 'run-1', taskId: 'task-002', iterationId: runIterationId, status: 'finished', agentTool: 'codex', workspaceRef: 'w', taskGraphRef: 'iterations/iter-1/gate-c-task-graph/task-graph.json', runRef: 'run-1.json', startedAt: run.startedAt, finishedAt: run.finishedAt }], tasks: [{ taskId: 'task-002', runIds: ['run-1'], latestRunId: 'run-1' }] });
  writeJson(path.join(artifactRoot, 'runs', 'run-1.json'), run);
  writeJson(path.join(artifactRoot, 'runs', 'run-1.memory-recall.json'), {
    schema_version: 'p2a.memory_search.v1',
    query: {
      text: 'Second network timeout retry',
      mode: 'hybrid',
      effectiveMode: 'hybrid',
      fallback: null,
      scope: 'project',
    },
    context: { projectId: 'graph-fixture' },
    server: { status: 'up' },
    summary: { total: 0 },
    results: [],
  });
  return { tempRoot, artifactRoot };
}

test('graph-scoped memory plans retain retry recall run iteration lineage', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot('iter-origin');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'iter-1',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const plan = buildMemoryPlan({ artifacts: null, graph: graphPath, runs: null, proposals: null });
    const retryMemoryDocument = plan.documents.find(
      (document) => document.request.metadata.documentRole === 'memory_retry_recall',
    );
    const sourceIteration = plan.iterations.find((iteration) => iteration.sourceKey === 'iter-origin');

    assert.ok(retryMemoryDocument);
    assert.ok(sourceIteration);
    assert.equal(retryMemoryDocument.request.metadata.sourceIterationId, 'iter-origin');
    assert.equal(retryMemoryDocument.request.iterationId, sourceIteration.id);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

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

    const firstPlan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const secondPlan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const milestoneDocuments = firstPlan.documents
      .filter((document) => document.request.metadata.documentRole === 'milestone_review');
    const retryMemoryDocuments = firstPlan.documents
      .filter((document) => document.request.metadata.documentRole === 'memory_retry_recall');
    const iterationBySourceId = new Map(firstPlan.iterations.map((iteration) => [iteration.sourceKey, iteration]));
    assert.equal(firstPlan.iterations.length, 2);
    assert.equal(iterationBySourceId.get('iter-1')?.request.status, 'ACTIVE');
    assert.equal(iterationBySourceId.get('iter-closed')?.request.status, 'ARCHIVED');
    assert.equal(milestoneDocuments.length, 2);
    assert.deepEqual(
      milestoneDocuments.map((document) => path.relative(artifactRoot, document.sourcePath)),
      [
        path.join('iterations', 'iter-1', 'milestone-reviews', 'midpoint.json'),
        path.join('iterations', 'iter-closed', 'milestone-reviews', 'pre_close.json'),
      ],
    );
    assert.deepEqual(
      milestoneDocuments.map((document) => JSON.parse(document.content).checkpoint),
      ['midpoint', 'pre_close'],
    );
    assert.deepEqual(
      milestoneDocuments.map((document) => document.request.metadata.sourceIterationId),
      ['iter-1', 'iter-closed'],
    );
    assert.deepEqual(
      milestoneDocuments.map((document) => document.request.iterationId),
      [iterationBySourceId.get('iter-1').id, iterationBySourceId.get('iter-closed').id],
    );
    assert.equal(retryMemoryDocuments.length, 1);
    assert.equal(
      path.relative(artifactRoot, retryMemoryDocuments[0].sourcePath),
      path.join('runs', 'run-1.memory-recall.json'),
    );
    assert.equal(retryMemoryDocuments[0].request.metadata.sourceIterationId, 'iter-1');
    assert.equal(retryMemoryDocuments[0].request.iterationId, iterationBySourceId.get('iter-1').id);
    assert.equal(firstPlan.graphs.length, 2);
    firstPlan.graphs.forEach(assertGraphWireContract);
    const activeGraph = firstPlan.graphs.find((graph) => graph.iterationId === iterationBySourceId.get('iter-1').id);
    const closedGraph = firstPlan.graphs.find((graph) => graph.iterationId === iterationBySourceId.get('iter-closed').id);
    assert.equal(activeGraph.nodes.some((node) => node.naturalKey.includes('/iter-closed/')), false);
    assert.equal(closedGraph.nodes.some((node) => node.naturalKey.includes('/iter-closed/')), true);
    assert.equal(firstPlan.documents.some((document) => document.sourcePath.endsWith('.draft.json')), false);
    assert.deepEqual(
      firstPlan.graph.nodes.map((node) => [node.naturalKey, node.nodeId]).sort(),
      secondPlan.graph.nodes.map((node) => [node.naturalKey, node.nodeId]).sort(),
      'graph node natural keys should map to stable node ids',
    );

    const nodeById = new Map(firstPlan.graph.nodes.map((node) => [node.nodeId, node]));
    const naturalKey = (suffix) => firstPlan.graph.nodes.find((node) => node.naturalKey.endsWith(suffix))?.naturalKey ?? suffix;
    const specEvidenceKey = firstPlan.graph.nodes.find(
      (node) => node.naturalKey.startsWith('evidence:')
        && node.metadata?.sourcePath?.endsWith('gate-b-spec/spec.json'),
    )?.naturalKey;
    const edgesByType = new Map();
    for (const edge of firstPlan.graph.edges) {
      const from = nodeById.get(edge.fromNodeId)?.naturalKey;
      const to = nodeById.get(edge.toNodeId)?.naturalKey;
      const key = `${from}->${to}`;
      if (!edgesByType.has(edge.edgeType)) edgesByType.set(edge.edgeType, new Set());
      edgesByType.get(edge.edgeType).add(key);
    }
    const expectEdge = (type, from, to) => {
      assert.ok(
        edgesByType.get(type)?.has(`${from}->${to}`),
        `expected ${type} edge ${from}->${to}; actual=${JSON.stringify([...firstPlan.graph.edges].map((edge) => ({ type: edge.edgeType, from: nodeById.get(edge.fromNodeId)?.naturalKey, to: nodeById.get(edge.toNodeId)?.naturalKey })))}`,
      );
    };

    expectEdge('DEPENDS_ON', 'task:task-002', 'task:task-001');
    expectEdge('DERIVED_FROM', 'task:task-001', 'spec_section:product.scope');
    expectEdge('DERIVED_FROM', 'task:task-002', 'spec_section:implementation.plan');
    expectEdge('DERIVED_FROM', 'task:task-002', 'decision:ND-1');
    expectEdge('DERIVED_FROM', 'task:task-002', 'decision:ND-2');
    expectEdge('DERIVED_FROM', 'task:task-002', 'decision:ND-3');
    expectEdge('DERIVED_FROM', 'task:task-002', 'decision:ND-99');
    expectEdge('EVIDENCED_BY', 'task:task-002', naturalKey('/iterations/iter-1/gate-a-intake/memory-recall.json'));
    expectEdge('DERIVED_FROM', 'spec_section:product.scope', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'));
    expectEdge('DERIVED_FROM', 'spec_section:implementation.plan', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'));
    expectEdge('DERIVED_FROM', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'), naturalKey('/iterations/iter-1/gate-a-intake/intake.json'));
    expectEdge('DERIVED_FROM', naturalKey('/iterations/iter-1/gate-a-intake/intake.json'), 'decision:ND-1');
    expectEdge('DERIVED_FROM', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'), 'decision:ND-2');
    expectEdge('DERIVED_FROM', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'), 'decision:ND-3');
    expectEdge('EXECUTED_FOR', 'run:run-1', 'task:task-002');
    expectEdge('DISPOSES', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'), 'clarifying_question:CQ-1');
    expectEdge('BLOCKS', 'clarifying_question:CQ-1', 'spec_section:product.scope');
    expectEdge('EVIDENCED_BY', naturalKey('/iterations/iter-1/gate-b-spec/spec.json'), specEvidenceKey);

    const cqEdge = firstPlan.graph.edges.find((edge) => edge.edgeType === 'BLOCKS');
    assert.match(cqEdge?.sourceReference ?? '', /gate-a-intake\/intake\.json#CQ-1$/);

    const evidenceNodes = firstPlan.graph.nodes.filter((node) => node.naturalKey.startsWith('evidence:'));
    assert.equal(evidenceNodes.length, 2, 'evidence ids are scoped to their source documents');
    assert.equal(firstPlan.graph.nodes.some(
      (node) => node.naturalKey === 'spec_section:memory:iterations/iter-1/gate-a-intake/memory-recall.json',
    ), false);
    assert.equal(firstPlan.graph.nodes.some(
      (node) => node.naturalKey === 'spec_section:decision:ND-99',
    ), false);
    assert.equal(nodeById.get(firstPlan.graph.edges.find(
      (edge) => edge.edgeType === 'EVIDENCED_BY',
    )?.toNodeId)?.label, 'Evidence One duplicate');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory graph coalesces reference candidates that use the same evidence edge', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const specPath = path.join(artifactRoot, 'iterations', 'iter-1', 'gate-b-spec', 'spec.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.reference_reconnaissance.candidates.push({
      candidate_id: 'REF-2',
      source_id: 'LOCAL-1',
      decision: 'deferred',
    });
    writeJson(specPath, spec);

    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const activeGraph = plan.graphs.find((graph) => graph.iterationId === plan.iteration.id);
    const nodesById = new Map(activeGraph.nodes.map((node) => [node.nodeId, node]));
    const referenceEdges = activeGraph.edges.filter((edge) => (
      edge.edgeType === 'EVIDENCED_BY'
        && nodesById.get(edge.fromNodeId)?.naturalKey.includes('/gate-b-spec/spec.json')
        && nodesById.get(edge.toNodeId)?.naturalKey.startsWith('evidence:')
    ));

    assert.equal(referenceEdges.length, 1);
    assert.deepEqual(JSON.parse(referenceEdges[0].metadata.referenceCandidates), [
      { candidateId: 'REF-1', decision: 'context' },
      { candidateId: 'REF-2', decision: 'deferred' },
    ]);
    assert.deepEqual(
      JSON.parse(referenceEdges[0].metadata.sourceReferences).map((reference) => reference.slice(-5)).sort(),
      ['REF-1', 'REF-2'],
    );
    assertGraphWireContract(activeGraph);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory status writes a durable freshness report when --output is provided', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const outputPath = path.join(tempRoot, 'memory-status.json');
    const result = runMemory(['status', '--artifacts', artifactRoot, '--output', outputPath, '--json']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const stdoutPayload = JSON.parse(result.stdout);
    const report = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(report.schema_version, 'p2a.memory_status.v1');
    assert.equal(report.generatedAt, stdoutPayload.generatedAt);
    assert.deepEqual(report.sync.summary, stdoutPayload.sync.summary);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Memory plan excludes the status sidecar and ignores volatile iteration freshness metadata', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const iterationPath = path.join(artifactRoot, 'iterations', 'iter-1', 'iteration.json');
    const statusPath = path.join(artifactRoot, 'iterations', 'iter-1', 'memory-status.json');
    const iteration = {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: 'graph-fixture',
      iteration_id: 'iter-1',
      status: 'gate_b_approved',
    };
    iteration.memory_freshness = {
      status: 'stale',
      checked_at: '2026-07-25T00:00:00.000Z',
    };
    writeJson(iterationPath, iteration);
    writeJson(statusPath, {
      schema_version: 'p2a.memory_status.v1',
      generatedAt: '2026-07-25T00:00:00.000Z',
    });

    const firstPlan = buildMemoryPlan({
      artifacts: artifactRoot,
      graph: null,
      runs: null,
      proposals: null,
    });
    const firstIterationDocument = firstPlan.documents.find(
      (document) => document.request.metadata.documentRole === 'iteration_metadata'
        && document.request.metadata.sourceIterationId === 'iter-1',
    );
    assert.ok(firstIterationDocument);
    assert.equal(firstPlan.documents.some(
      (document) => document.request.metadata.documentRole === 'memory_status',
    ), false);
    assert.equal(firstIterationDocument.content.includes('memory_freshness'), false);

    iteration.memory_freshness = {
      status: 'fresh',
      checked_at: '2026-07-25T00:01:00.000Z',
    };
    writeJson(iterationPath, iteration);
    const secondPlan = buildMemoryPlan({
      artifacts: artifactRoot,
      graph: null,
      runs: null,
      proposals: null,
    });
    const secondIterationDocument = secondPlan.documents.find(
      (document) => document.request.metadata.documentRole === 'iteration_metadata'
        && document.request.metadata.sourceIterationId === 'iter-1',
    );
    assert.equal(secondIterationDocument.contentHash, firstIterationDocument.contentHash);
    assert.equal(secondIterationDocument.content, firstIterationDocument.content);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('configured but unavailable Memory status writes a report and exits non-zero', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const outputPath = path.join(tempRoot, 'memory-status-unavailable.json');
    const result = runMemory([
      'status',
      '--artifacts',
      artifactRoot,
      '--server',
      'http://127.0.0.1:1',
      '--timeout-ms',
      '100',
      '--output',
      outputPath,
    ]);
    assert.notEqual(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /server: unavailable/);
    assert.match(result.stderr, /WARNING: Memory server connection failed/);
    const report = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(report.server.status, 'unavailable');
    assert.equal(report.server.timeoutMs, 100);
    assert.match(String(report.server.detail), /fetch failed|abort|connect/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Memory trace normalization unwraps the server DTO and preserves traversal depth', () => {
  const trace = normalizeMemoryTrace({
    root: {
      nodeId: 'decision-node',
      projectId: 'project-a',
      iterationId: 'iteration-a',
      nodeKind: 'DECISION',
      naturalKey: 'decision:ND-1',
    },
    nodes: [
      {
        node: {
          nodeId: 'decision-node',
          projectId: 'project-a',
          iterationId: 'iteration-a',
          nodeKind: 'DECISION',
          naturalKey: 'decision:ND-1',
        },
        depth: 0,
      },
      {
        node: {
          nodeId: 'run-node',
          projectId: 'project-a',
          iterationId: 'iteration-a',
          nodeKind: 'RUN',
          naturalKey: 'run:run-1',
          metadata: { status: 'finished' },
        },
        depth: 4,
      },
    ],
    edges: [{
      edgeId: 'edge-1',
      fromNodeId: 'run-node',
      toNodeId: 'decision-node',
      edgeType: 'EXECUTED_FOR',
    }],
    truncated: false,
  });

  assert.equal(trace.root.depth, 0);
  assert.deepEqual(
    trace.nodes.map((node) => [node.nodeKind, node.naturalKey, node.depth]),
    [
      ['decision', 'decision:ND-1', 0],
      ['run', 'run:run-1', 4],
    ],
  );
  assert.equal(incomingEdgeLabel(trace, trace.nodes[1]), 'EXECUTED_FOR');
});

test('global precedent traces each decision in the owning project and iteration', () => {
  const scope = precedentTraceScope(
    {
      projectId: 'canonical-project-b',
      iterationId: 'canonical-iteration-b',
      naturalKey: 'decision:ND-7',
    },
    { global: true, project: null },
    null,
  );
  assert.deepEqual(scope, {
    projectId: 'canonical-project-b',
    iterationId: 'canonical-iteration-b',
  });
});

test('memory push registers every referenced iteration before dependent artifacts', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const calls = [];
    const post = async (_connection, pathName, body) => {
      calls.push({ pathName, body });
      if (pathName === '/projects') return { projectId: body.projectId };
      if (pathName.endsWith('/iterations')) return { iterationId: body.iterationId };
      if (pathName === '/documents/snapshots') return { documentId: body.documentId };
      if (pathName === '/document-chunks/bulk') return [];
      if (pathName === '/task-graphs') return {
        taskGraphId: body.taskGraphId,
        projectId: body.projectId,
        iterationId: body.iterationId,
        sourceTaskGraphId: body.sourceTaskGraphId,
        graphHash: body.graphHash,
      };
      if (pathName === '/tasks/bulk') return [];
      if (pathName === '/runs') return { runId: body.runId };
      if (pathName === '/graph/snapshots') {
        assertGraphWireContract(body);
        return { nodeCount: body.nodes.length, edgeCount: body.edges.length };
      }
      throw new Error(`unexpected Memory path: ${pathName}`);
    };

    const result = await pushPlan({ server: 'http://memory.invalid' }, plan, post);
    const iterationCalls = calls.filter((call) => call.pathName.endsWith('/iterations'));
    const firstDependentCall = calls.findIndex((call) => [
      '/documents/snapshots',
      '/task-graphs',
      '/runs',
      '/graph/snapshots',
    ].includes(call.pathName));

    assert.equal(result.iterations, 2);
    assert.deepEqual(
      iterationCalls.map((call) => call.body.sourceIterationId),
      ['iter-1', 'iter-closed'],
    );
    assert.equal(calls.slice(1, firstDependentCall).every((call) => call.pathName.endsWith('/iterations')), true);
    assert.equal(calls.filter((call) => call.pathName === '/graph/snapshots').length, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory push uses the canonical task graph id returned by the server', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const canonicalIds = new Map(plan.taskGraphs.map((graph, index) => [graph.id, `00000000-0000-5000-8000-${String(index + 1).padStart(12, '0')}`]));
    const calls = [];
    const post = async (_connection, pathName, body) => {
      calls.push({ pathName, body });
      if (pathName === '/projects') return { projectId: body.projectId };
      if (pathName.endsWith('/iterations')) return { iterationId: body.iterationId };
      if (pathName === '/documents/snapshots') return { documentId: body.documentId };
      if (pathName === '/document-chunks/bulk') return [];
      if (pathName === '/task-graphs') return {
        taskGraphId: canonicalIds.get(body.taskGraphId),
        projectId: body.projectId,
        iterationId: body.iterationId,
        sourceTaskGraphId: body.sourceTaskGraphId,
        graphHash: body.graphHash,
      };
      if (pathName === '/tasks/bulk') return body.tasks;
      if (pathName === '/runs') return { runId: body.runId };
      if (pathName === '/graph/snapshots') return { nodeCount: body.nodes.length, edgeCount: body.edges.length };
      throw new Error(`unexpected Memory path: ${pathName}`);
    };

    const result = await pushPlan({ server: 'http://memory.invalid' }, plan, post);
    const taskCalls = calls.filter((call) => call.pathName === '/tasks/bulk');
    assert.equal(result.tasks, plan.tasks.length);
    assert.equal(result.runs, plan.runs.length);
    assert.equal(taskCalls.length, plan.taskGraphs.length);
    for (const call of taskCalls) {
      assert.ok(call.body.tasks.length > 0);
      assert.ok(call.body.tasks.every((task) => task.taskGraphId === call.body.graphId));
      assert.ok([...canonicalIds.values()].includes(call.body.graphId));
    }
    assert.equal(calls.filter((call) => call.pathName === '/runs').length, plan.runs.length);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory push converges over authenticated HTTP after a task graph content-changing re-push', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  let server = null;
  try {
    const canonicalIds = new Map();
    const remoteGraphs = new Map();
    const remoteTasks = new Map();
    const remoteRuns = new Map();
    const calls = [];
    const token = 'memory-http-e2e-token';
    server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers['x-p2a-local-token'], token);
        const apiPath = new URL(request.url, 'http://127.0.0.1').pathname;
        assert.match(apiPath, /^\/api\//);
        const pathName = apiPath.slice('/api'.length);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        calls.push({ pathName, body });

        let result;
        if (pathName === '/projects') result = { projectId: body.projectId };
        else if (pathName.endsWith('/iterations')) result = { iterationId: body.iterationId };
        else if (pathName === '/documents/snapshots') result = { documentId: body.documentId };
        else if (pathName === '/document-chunks/bulk') result = [];
        else if (pathName === '/task-graphs') {
          const canonicalId = canonicalIds.get(body.sourceTaskGraphId)
            ?? `00000000-0000-5000-8000-${String(canonicalIds.size + 1).padStart(12, '0')}`;
          canonicalIds.set(body.sourceTaskGraphId, canonicalId);
          result = {
            taskGraphId: canonicalId,
            projectId: body.projectId,
            iterationId: body.iterationId,
            sourceTaskGraphId: body.sourceTaskGraphId,
            graphHash: body.graphHash,
          };
          remoteGraphs.set(body.sourceTaskGraphId, result);
        } else if (pathName === '/tasks/bulk') {
          const graph = [...remoteGraphs.values()].find((candidate) => candidate.taskGraphId === body.graphId);
          assert.ok(graph, `canonical task graph ${body.graphId} must exist before task upload`);
          assert.equal(body.tasks.every((task) => task.taskGraphId === body.graphId), true);
          for (const task of body.tasks) {
            remoteTasks.set(task.taskId, {
              artifactType: 'TASK',
              artifactId: task.taskId,
              taskId: task.taskId,
              sourceIds: {
                sourceTaskGraphId: graph.sourceTaskGraphId,
                sourceTaskId: task.sourceTaskId,
              },
            });
          }
          result = body.tasks;
        } else if (pathName === '/runs') {
          const task = remoteTasks.get(body.taskId);
          assert.ok(task, `task ${body.taskId} must exist before run upload`);
          result = {
            artifactType: 'RUN_RECORD',
            artifactId: body.runId,
            runId: body.runId,
            sourceIds: {
              sourceTaskId: task.sourceIds.sourceTaskId,
              sourceRunId: body.sourceRunId,
            },
          };
          remoteRuns.set(body.runId, result);
        } else if (pathName === '/graph/snapshots') {
          result = { nodeCount: body.nodes.length, edgeCount: body.edges.length };
        } else {
          throw new Error(`unexpected Memory path: ${pathName}`);
        }
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
      })().catch((error) => {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const connection = { server: `http://127.0.0.1:${address.port}`, token };

    const initialPlan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const initialResult = await pushPlan(connection, initialPlan);
    const initialGraph = initialPlan.taskGraphs[0];
    const initialCanonicalId = canonicalIds.get(initialGraph.sourceKey);
    assert.equal(initialResult.runs, initialPlan.runs.length);

    const graphPath = path.join(artifactRoot, 'iterations', 'iter-1', 'gate-c-task-graph', 'task-graph.json');
    const changedGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    changedGraph.tasks[0].description = 'changed after the initial Memory push';
    writeJson(graphPath, changedGraph);
    const changedPlan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const changedTaskGraph = changedPlan.taskGraphs.find((graph) => graph.sourceKey === initialGraph.sourceKey);
    assert.notEqual(changedTaskGraph.id, initialGraph.id);

    const retryCallStart = calls.length;
    const changedResult = await pushPlan(connection, changedPlan);
    const retryCalls = calls.slice(retryCallStart);
    assert.equal(canonicalIds.get(changedTaskGraph.sourceKey), initialCanonicalId);
    assert.equal(changedResult.tasks, changedPlan.tasks.length);
    assert.equal(changedResult.runs, changedPlan.runs.length);
    assert.equal(retryCalls.filter((call) => call.pathName === '/tasks/bulk').length, changedPlan.taskGraphs.length);
    assert.equal(retryCalls.filter((call) => call.pathName === '/runs').length, changedPlan.runs.length);

    const remoteArtifacts = [
      ...[...remoteGraphs.values()].map((graph) => ({
        artifactType: 'TASK_GRAPH',
        artifactId: graph.taskGraphId,
        contentHash: graph.graphHash,
        sourceIds: { sourceTaskGraphId: graph.sourceTaskGraphId },
      })),
      ...remoteTasks.values(),
      ...remoteRuns.values(),
    ];
    const convergedTypes = new Set(['TASK_GRAPH', 'TASK', 'RUN_RECORD']);
    const convergedSyncItems = changedPlan.syncItems.filter((item) => convergedTypes.has(item.artifactType));
    const sync = compareSync({
      syncItems: convergedSyncItems,
    }, remoteArtifacts);
    assert.deepEqual(sync.summary, {
      totalLocal: convergedSyncItems.length,
      synced: convergedSyncItems.length,
      missingRemote: 0,
      remoteDiffers: 0,
      extraRemote: 0,
    });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory push rejects a stale task graph response before dependent writes', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const calls = [];
    await assert.rejects(
      pushPlan({ server: 'http://memory.invalid' }, plan, async (_connection, pathName, body) => {
        calls.push(pathName);
        if (pathName === '/projects') return { projectId: body.projectId };
        if (pathName.endsWith('/iterations')) return { iterationId: body.iterationId };
        if (pathName === '/documents/snapshots') return { documentId: body.documentId };
        if (pathName === '/document-chunks/bulk') return [];
        if (pathName === '/task-graphs') return {
          taskGraphId: body.taskGraphId,
          projectId: body.projectId,
          iterationId: body.iterationId,
          sourceTaskGraphId: body.sourceTaskGraphId,
          graphHash: 'stale-graph-hash',
        };
        throw new Error(`unexpected dependent write: ${pathName}`);
      }),
      /stale or mismatched graphHash/,
    );
    assert.equal(calls.includes('/tasks/bulk'), false);
    assert.equal(calls.includes('/runs'), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory push rejects an invalid graph wire payload before the first remote write', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    plan.graphs[0].edges[0].sourceReference = { path: 'gate-a-intake/intake.json', fragment: 'CQ-1' };
    const calls = [];
    await assert.rejects(
      pushPlan({ server: 'http://memory.invalid' }, plan, async (_connection, pathName) => {
        calls.push(pathName);
        return {};
      }),
      /sourceReference must be a non-empty string or null/,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('memory push rejects duplicate graph semantic edges before the first remote write', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan({ artifacts: artifactRoot, graph: null, runs: null, proposals: null });
    const firstEdge = plan.graphs[0].edges[0];
    plan.graphs[0].edges.push({
      ...firstEdge,
      edgeId: `${firstEdge.edgeId}-duplicate`,
      metadata: { ...firstEdge.metadata },
    });
    const calls = [];
    await assert.rejects(
      pushPlan({ server: 'http://memory.invalid' }, plan, async (_connection, pathName) => {
        calls.push(pathName);
        return {};
      }),
      /duplicates semantic edge/,
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
