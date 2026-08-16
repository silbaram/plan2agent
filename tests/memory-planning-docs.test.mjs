import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  E2E_FIXTURE_ROOT,
  formatCommandResult,
  makeTempDir,
  runMemory,
} from './helpers/fixtures.mjs';
import { buildMemoryPlan, pushPlan } from '../scripts/p2a_memory.mjs';

const BASE_FIXTURE = path.join(E2E_FIXTURE_ROOT, 'webhook-api-service');
const BASE_INTAKE = JSON.parse(readFileSync(path.join(BASE_FIXTURE, 'gate-a-intake', 'intake.json'), 'utf8'));
const BASE_SPEC = JSON.parse(readFileSync(path.join(BASE_FIXTURE, 'gate-b-spec', 'spec.json'), 'utf8'));

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function writeIteration(artifactRoot, iterationId, options = {}) {
  const iterationRoot = path.join(artifactRoot, 'iterations', iterationId);
  const intake = structuredClone(BASE_INTAKE);
  const spec = structuredClone(BASE_SPEC);
  spec.project_id = 'planning-profile';
  spec.source_intake = '../gate-a-intake/intake.json';
  if (options.approved === false) {
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
    spec.approval = 'draft';
    delete spec.approval_audit;
  }
  writeJson(path.join(iterationRoot, 'gate-a-intake', 'intake.json'), intake);
  writeJson(path.join(iterationRoot, 'gate-b-spec', 'spec.json'), spec);
  if (options.intakeMarkdown !== false) {
    writeText(path.join(iterationRoot, 'gate-a-intake', 'intake.md'), `# Intake ${iterationId}\n`);
  }
  writeText(path.join(iterationRoot, 'gate-b-spec', 'product-spec.md'), `# Product ${iterationId}\n`);
  writeText(path.join(iterationRoot, 'gate-b-spec', 'implementation-plan.md'), `# Implementation ${iterationId}\n`);
  writeJson(path.join(iterationRoot, 'iteration.json'), {
    schema_version: 'p2a.iteration.v1',
    project_id: 'planning-profile',
    iteration_id: iterationId,
    status: iterationId === 'iter-002' ? 'active' : 'archived',
  });
  return iterationRoot;
}

function makeArtifactRoot() {
  const tempRoot = makeTempDir('p2a-planning-docs-');
  const artifactRoot = path.join(tempRoot, 'planning-profile');
  writeIteration(artifactRoot, 'iter-001');
  writeIteration(artifactRoot, 'iter-002', { intakeMarkdown: false });
  writeIteration(artifactRoot, 'iter-draft', { approved: false });
  writeIteration(artifactRoot, 'iter-invalid', { intakeMarkdown: false });
  writeText(path.join(artifactRoot, 'iterations', 'iter-invalid', 'gate-b-spec', 'spec.json'), '{invalid json\n');
  writeJson(path.join(artifactRoot, 'current-spec.json'), {
    schema_version: 'p2a.current_spec.v1',
    project_id: 'planning-profile',
    active_iteration: 'iter-002',
    effective_spec_ref: 'iterations/iter-002/gate-b-spec/spec.json',
    closed_iterations: [{ iteration_id: 'iter-001' }],
  });
  writeText(path.join(artifactRoot, 'status.md'), '# Generated status\n');
  writeText(path.join(artifactRoot, 'iterations', 'maintenance', 'README.md'), '# Maintenance\n');
  writeJson(path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json'), { tasks: [] });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-002', 'gate-c-task-graph', 'task-graph.json'), { tasks: [] });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-002', 'gate-d-review', 'review.json'), { status: 'accepted' });
  writeJson(path.join(artifactRoot, 'iterations', 'iter-002', 'gate-a-intake', 'memory-recall.json'), { results: [] });
  writeJson(path.join(artifactRoot, 'runs', 'run-001.json'), { status: 'finished' });
  writeText(path.join(artifactRoot, 'chunks', 'product-spec.chunk.md'), '# Generated chunk\n');
  writeText(path.join(artifactRoot, 'handoff', 'iterations', 'iter-001', 'gate-b-spec', 'product-spec.md'), '# Product iter-001\n');
  return { tempRoot, artifactRoot };
}

function planningArgs(artifactRoot) {
  return {
    artifacts: artifactRoot,
    graph: null,
    runs: null,
    proposals: null,
    profile: 'planning-docs',
  };
}

test('planning-docs dry-run selects approved current and archived Markdown only', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const result = runMemory([
      'push',
      '--artifacts', artifactRoot,
      '--profile', 'planning-docs',
      '--dry-run',
      '--json',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.context.profile, 'planning-docs');
    assert.equal(payload.local.documents, 5);
    assert.equal(payload.local.iterations, 2);
    assert.equal(payload.local.taskGraphs, 0);
    assert.equal(payload.local.tasks, 0);
    assert.equal(payload.local.runs, 0);
    assert.equal(payload.local.proposals, 0);
    assert.equal(payload.local.graphNodes, 0);
    assert.equal(payload.selection.summary.estimatedSnapshots, 5);
    assert.equal(
      payload.selection.summary.scannedFiles,
      payload.selection.summary.includedFiles + payload.selection.summary.excludedFiles,
    );
    assert.deepEqual(
      payload.selection.included.map((item) => item.sourcePath),
      [
        'iterations/iter-001/gate-a-intake/intake.md',
        'iterations/iter-001/gate-b-spec/implementation-plan.md',
        'iterations/iter-001/gate-b-spec/product-spec.md',
        'iterations/iter-002/gate-b-spec/implementation-plan.md',
        'iterations/iter-002/gate-b-spec/product-spec.md',
      ],
    );
    const excluded = new Map(payload.selection.excluded.map((item) => [item.sourcePath, item.reason]));
    assert.equal(excluded.get('iterations/maintenance/README.md'), 'maintenance');
    assert.equal(excluded.get('iterations/maintenance/gate-c-task-graph/task-graph.json'), 'maintenance');
    assert.equal(excluded.get('iterations/iter-002/gate-c-task-graph/task-graph.json'), 'task_graph');
    assert.equal(excluded.get('iterations/iter-002/gate-d-review/review.json'), 'evidence_or_review');
    assert.equal(excluded.get('iterations/iter-002/gate-a-intake/memory-recall.json'), 'memory_recall');
    assert.equal(excluded.get('iterations/iter-draft/gate-b-spec/product-spec.md'), 'gate_b_not_approved');
    assert.equal(excluded.get('iterations/iter-draft/gate-a-intake/intake.md'), 'gate_a_not_complete');
    assert.equal(excluded.get('iterations/iter-invalid/gate-b-spec/product-spec.md'), 'canonical_validation_failed');
    assert.equal(excluded.get('runs/run-001.json'), 'run_record');
    assert.equal(excluded.get('status.md'), 'generated_index');
    assert.equal(excluded.get('chunks/product-spec.chunk.md'), 'generated_chunk');
    assert.equal(
      excluded.get('handoff/iterations/iter-001/gate-b-spec/product-spec.md'),
      'duplicate_copy',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs metadata uses stable identity and canonical JSON hashes', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const first = buildMemoryPlan(planningArgs(artifactRoot));
    const firstProduct = first.documents.find((document) => (
      document.request.metadata.sourceIterationId === 'iter-001'
      && document.request.metadata.documentType === 'product_spec'
    ));
    assert.ok(firstProduct);
    assert.equal(firstProduct.sourceKey, 'planning-profile:iter-001:product_spec');
    assert.equal(firstProduct.request.metadata.projectId, 'planning-profile');
    assert.equal(firstProduct.request.metadata.iterationId, 'iter-001');
    assert.equal(firstProduct.request.metadata.gate, 'gate-b');
    assert.equal(firstProduct.request.metadata.approval, 'approved');
    assert.equal(
      firstProduct.request.metadata.sourcePath,
      'iterations/iter-001/gate-b-spec/product-spec.md',
    );
    assert.equal(
      firstProduct.request.metadata.canonicalJsonPath,
      'iterations/iter-001/gate-b-spec/spec.json',
    );
    assert.match(firstProduct.request.metadata.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(firstProduct.request.metadata.canonicalJsonHash, /^sha256:[a-f0-9]{64}$/);

    const unchanged = buildMemoryPlan(planningArgs(artifactRoot));
    const unchangedProduct = unchanged.documents.find((document) => (
      document.request.metadata.sourceIterationId === 'iter-001'
      && document.request.metadata.documentType === 'product_spec'
    ));
    assert.equal(unchangedProduct.id, firstProduct.id);
    assert.equal(unchangedProduct.contentHash, firstProduct.contentHash);

    writeText(
      path.join(artifactRoot, 'iterations', 'iter-001', 'gate-b-spec', 'product-spec.md'),
      '# Product iter-001 changed\n',
    );
    const second = buildMemoryPlan(planningArgs(artifactRoot));
    const secondProduct = second.documents.find((document) => (
      document.request.metadata.sourceIterationId === 'iter-001'
      && document.request.metadata.documentType === 'product_spec'
    ));
    assert.equal(secondProduct.sourceKey, firstProduct.sourceKey);
    assert.notEqual(secondProduct.contentHash, firstProduct.contentHash);
    assert.notEqual(secondProduct.id, firstProduct.id);
    assert.equal(
      secondProduct.request.metadata.canonicalJsonHash,
      firstProduct.request.metadata.canonicalJsonHash,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs push plan omits task, run, proposal, and graph writes', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan(planningArgs(artifactRoot));
    const calls = [];
    const post = async (_connection, endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === '/projects') return { projectId: body.projectId };
      if (endpoint.includes('/iterations')) return { iterationId: body.iterationId };
      if (endpoint === '/documents/snapshots') return { documentId: body.documentId };
      if (endpoint === '/document-chunks/bulk') return body.chunks.map((item) => item.chunk);
      throw new Error(`unexpected planning-docs endpoint: ${endpoint}`);
    };
    const result = await pushPlan({}, plan, post);
    assert.equal(result.documents, 5);
    assert.equal(result.iterations, 2);
    assert.equal(result.taskGraphs, 0);
    assert.equal(result.tasks, 0);
    assert.equal(result.runs, 0);
    assert.equal(result.graphSnapshots, 0);
    assert.equal(calls.some((endpoint) => endpoint === '/task-graphs'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/tasks/bulk'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/runs'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/graph/snapshots'), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs profile rejects unsupported commands, names, and graph sources', () => {
  const unsupported = runMemory(['push', '--artifacts', 'missing', '--profile', 'everything', '--dry-run']);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported Memory push profile/);

  const wrongCommand = runMemory(['status', '--artifacts', 'missing', '--profile', 'planning-docs']);
  assert.notEqual(wrongCommand.status, 0);
  assert.match(wrongCommand.stderr, /--profile is only supported by push/);

  const graphSource = runMemory(['push', '--graph', 'missing.json', '--profile', 'planning-docs', '--dry-run']);
  assert.notEqual(graphSource.status, 0);
  assert.match(graphSource.stderr, /planning-docs profile requires --artifacts/);
});
