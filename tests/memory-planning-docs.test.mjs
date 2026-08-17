import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  E2E_FIXTURE_ROOT,
  formatCommandResult,
  makeTempDir,
  runMemory,
} from './helpers/fixtures.mjs';
import {
  buildMemoryPlan,
  main as runMemoryMain,
  pushPlan,
} from '../scripts/p2a_memory.mjs';

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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function updateJson(filePath, update) {
  const value = readJson(filePath);
  update(value);
  writeJson(filePath, value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
  writeIteration(artifactRoot, 'iter-unrecorded');
  writeIteration(artifactRoot, 'iter-pending');
  writeText(path.join(artifactRoot, 'iterations', 'iter-invalid', 'gate-b-spec', 'spec.json'), '{invalid json\n');
  writeJson(path.join(artifactRoot, 'current-spec.json'), {
    schema_version: 'p2a.current_spec.v1',
    project_id: 'planning-profile',
    active_iteration: 'iter-002',
    effective_spec_ref: 'iterations/iter-002/gate-b-spec/spec.json',
    closed_iterations: [
      { iteration_id: 'iter-001', status: 'archived' },
      { iteration_id: 'iter-draft', status: 'archived' },
      { iteration_id: 'iter-invalid', status: 'archived' },
    ],
    pending_iteration: { iteration_id: 'iter-pending', status: 'active_planning' },
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
  writeText(path.join(artifactRoot, 'baseline', 'iterations', 'iter-001', 'gate-b-spec', 'product-spec.md'), '# Product iter-001\n');
  writeText(path.join(artifactRoot, 'misc', 'operator-notes.txt'), 'not a planning source artifact\n');
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
    assert.equal(payload.local.chunks, 0);
    assert.equal(payload.local.graphNodes, 0);
    assert.deepEqual(payload.serverChunking, {
      strategy: 'paragraph-2000',
      targetSnapshots: 5,
    });
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
    assert.equal(excluded.get('iterations/iter-unrecorded/gate-b-spec/product-spec.md'), 'unrecorded_iteration');
    assert.equal(excluded.get('iterations/iter-pending/gate-b-spec/product-spec.md'), 'pending_iteration');
    assert.equal(excluded.get('runs/run-001.json'), 'run_record');
    assert.equal(excluded.get('status.md'), 'generated_index');
    assert.equal(excluded.get('chunks/product-spec.chunk.md'), 'generated_chunk');
    assert.equal(
      excluded.get('handoff/iterations/iter-001/gate-b-spec/product-spec.md'),
      'duplicate_copy',
    );
    assert.equal(
      excluded.get('baseline/iterations/iter-001/gate-b-spec/product-spec.md'),
      'duplicate_copy',
    );
    assert.equal(excluded.get('misc/operator-notes.txt'), 'unsupported_artifact');
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
    assert.equal(firstProduct.sourcePath, 'iterations/iter-001/gate-b-spec/product-spec.md');
    assert.equal(firstProduct.request.sourcePath, 'iterations/iter-001/gate-b-spec/product-spec.md');
    assert.equal(firstProduct.request.sourceReference.path, 'iterations/iter-001/gate-b-spec/product-spec.md');
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
    assert.deepEqual(firstProduct.request.chunking, { strategy: 'paragraph-2000' });
    assert.equal('chunks' in firstProduct, false);
    assert.equal(
      firstProduct.request.metadata.contentHash,
      `sha256:${sha256(readFileSync(path.join(artifactRoot, firstProduct.sourcePath)))}`,
    );

    const unchanged = buildMemoryPlan(planningArgs(artifactRoot));
    const unchangedProduct = unchanged.documents.find((document) => (
      document.request.metadata.sourceIterationId === 'iter-001'
      && document.request.metadata.documentType === 'product_spec'
    ));
    assert.equal(unchangedProduct.id, firstProduct.id);
    assert.equal(unchangedProduct.contentHash, firstProduct.contentHash);
    assert.deepEqual(
      unchanged.chunks.map((chunk) => chunk.id),
      first.chunks.map((chunk) => chunk.id),
    );

    const canonicalPath = path.join(artifactRoot, 'iterations', 'iter-001', 'gate-b-spec', 'spec.json');
    writeText(canonicalPath, `${readFileSync(canonicalPath, 'utf8').trimEnd()}\n\n`);
    const canonicalOnly = buildMemoryPlan(planningArgs(artifactRoot));
    const canonicalOnlyProduct = canonicalOnly.documents.find((document) => (
      document.request.metadata.sourceIterationId === 'iter-001'
      && document.request.metadata.documentType === 'product_spec'
    ));
    assert.equal(canonicalOnlyProduct.id, firstProduct.id);
    assert.notEqual(
      canonicalOnlyProduct.request.metadata.canonicalJsonHash,
      firstProduct.request.metadata.canonicalJsonHash,
    );

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
      canonicalOnlyProduct.request.metadata.canonicalJsonHash,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs canonical validators fail closed across approval, provenance, project, and root boundaries', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const cases = [
      ['iter-no-approval', (iterationRoot) => updateJson(
        path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
        (spec) => { delete spec.approval_audit; },
      )],
      ['iter-open-decision', (iterationRoot) => updateJson(
        path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
        (spec) => { spec.open_decisions = ['ND-1']; },
      )],
      ['iter-source-hash', (iterationRoot) => updateJson(
        path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
        (spec) => { spec.source_intake_sha256 = '0'.repeat(64); },
      )],
      ['iter-project-mismatch', (iterationRoot) => updateJson(
        path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
        (spec) => { spec.project_id = 'another-project'; },
      )],
      ['iter-outside-root', (iterationRoot) => {
        const outsideIntake = path.join(tempRoot, 'outside-intake.json');
        writeText(outsideIntake, readFileSync(path.join(iterationRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
        updateJson(path.join(iterationRoot, 'gate-b-spec', 'spec.json'), (spec) => {
          spec.source_intake = outsideIntake;
        });
      }],
      ['iter-stale-intake', (iterationRoot) => writeText(
        path.join(iterationRoot, 'gate-a-intake', 'intake.md'),
        '# Intake\n\n## ND-1\n\n- Status: open\n',
      )],
    ];

    for (const [iterationId, mutate] of cases) {
      const iterationRoot = writeIteration(artifactRoot, iterationId);
      mutate(iterationRoot);
    }
    updateJson(path.join(artifactRoot, 'current-spec.json'), (currentSpec) => {
      currentSpec.closed_iterations.push(...cases.map(([iterationId]) => ({
        iteration_id: iterationId,
        status: 'archived',
      })));
    });

    const result = runMemory([
      'push', '--artifacts', artifactRoot, '--profile', 'planning-docs', '--dry-run', '--json',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));
    const payload = JSON.parse(result.stdout);
    const excluded = new Map(payload.selection.excluded.map((item) => [item.sourcePath, item.reason]));
    for (const iterationId of ['iter-no-approval', 'iter-open-decision', 'iter-source-hash', 'iter-outside-root']) {
      assert.equal(
        excluded.get(`iterations/${iterationId}/gate-b-spec/product-spec.md`),
        'canonical_validation_failed',
      );
    }
    assert.equal(
      excluded.get('iterations/iter-project-mismatch/gate-b-spec/product-spec.md'),
      'project_mismatch',
    );
    assert.equal(
      excluded.get('iterations/iter-stale-intake/gate-a-intake/intake.md'),
      'canonical_validation_failed',
    );
    assert.equal(
      payload.selection.excluded.some((item) => item.detail?.includes(tempRoot)),
      false,
      'validation details must not expose the local artifact root',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs does not follow iteration, Markdown, or canonical JSON symlinks', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const outsideRoot = path.join(tempRoot, 'outside');
    const linkedIterationRoot = writeIteration(outsideRoot, 'linked-iteration');
    symlinkSync(linkedIterationRoot, path.join(artifactRoot, 'iterations', 'iter-linked-dir'), 'dir');

    const markdownRoot = writeIteration(artifactRoot, 'iter-linked-markdown');
    const outsideMarkdown = path.join(outsideRoot, 'outside-product-spec.md');
    writeText(outsideMarkdown, '# Outside product spec\n');
    const linkedMarkdown = path.join(markdownRoot, 'gate-b-spec', 'product-spec.md');
    unlinkSync(linkedMarkdown);
    symlinkSync(outsideMarkdown, linkedMarkdown);

    const canonicalRoot = writeIteration(artifactRoot, 'iter-linked-canonical');
    const outsideSpec = path.join(outsideRoot, 'outside-spec.json');
    writeText(outsideSpec, readFileSync(path.join(canonicalRoot, 'gate-b-spec', 'spec.json'), 'utf8'));
    const linkedCanonical = path.join(canonicalRoot, 'gate-b-spec', 'spec.json');
    unlinkSync(linkedCanonical);
    symlinkSync(outsideSpec, linkedCanonical);

    updateJson(path.join(artifactRoot, 'current-spec.json'), (currentSpec) => {
      currentSpec.closed_iterations.push(
        { iteration_id: 'iter-linked-dir', status: 'archived' },
        { iteration_id: 'iter-linked-markdown', status: 'archived' },
        { iteration_id: 'iter-linked-canonical', status: 'archived' },
      );
    });

    const result = runMemory([
      'push', '--artifacts', artifactRoot, '--profile', 'planning-docs', '--dry-run', '--json',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));
    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.selection.included.some((item) => item.sourcePath.includes('iter-linked-dir')),
      false,
    );
    assert.equal(
      payload.selection.included.some((item) => item.sourcePath.endsWith('iter-linked-markdown/gate-b-spec/product-spec.md')),
      false,
    );
    assert.equal(
      payload.selection.included.some((item) => item.sourcePath.includes('iter-linked-canonical/gate-b-spec')),
      false,
    );
    const excluded = new Map(payload.selection.excluded.map((item) => [item.sourcePath, item.reason]));
    assert.equal(excluded.get('iterations/iter-linked-dir'), 'symlink_not_allowed');
    assert.equal(
      excluded.get('iterations/iter-linked-markdown/gate-b-spec/product-spec.md'),
      'symlink_not_allowed',
    );
    assert.equal(
      excluded.get('iterations/iter-linked-canonical/gate-b-spec/spec.json'),
      'symlink_not_allowed',
    );
    assert.equal(
      excluded.get('iterations/iter-linked-canonical/gate-b-spec/implementation-plan.md'),
      'canonical_validation_failed',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs preview is deterministic, network-free, and delegates chunks to the server', () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const args = [
      'push', '--artifacts', artifactRoot, '--profile', 'planning-docs',
      '--server', 'http://127.0.0.1:9', '--dry-run', '--json',
    ];
    const firstResult = runMemory(args);
    const secondResult = runMemory(args);
    assert.equal(firstResult.status, 0, formatCommandResult(firstResult));
    assert.equal(secondResult.status, 0, formatCommandResult(secondResult));
    const first = JSON.parse(firstResult.stdout);
    const second = JSON.parse(secondResult.stdout);
    assert.deepEqual(first.selection, second.selection);
    assert.deepEqual(first.writeOrder, second.writeOrder);
    assert.deepEqual(first.local, second.local);
    assert.deepEqual(first.serverChunking, second.serverChunking);

    const withoutApproval = runMemory([
      'push', '--artifacts', artifactRoot, '--profile', 'planning-docs',
      '--server', 'http://127.0.0.1:9', '--json',
    ]);
    assert.equal(withoutApproval.status, 1, formatCommandResult(withoutApproval));
    const approvalPreview = JSON.parse(withoutApproval.stdout);
    assert.equal(approvalPreview.dryRun, true);
    assert.equal(approvalPreview.approvalRequired, true);

    const plan = buildMemoryPlan(planningArgs(artifactRoot));
    assert.deepEqual(plan.chunks, []);
    assert.ok(plan.documents.every((document) => !('chunks' in document)));
    assert.ok(plan.documents.every((document) => (
      Object.keys(document.request.chunking).length === 1
      && document.request.chunking.strategy === 'paragraph-2000'
    )));
    assert.equal(plan.syncItems.some((item) => item.artifactType === 'DOCUMENT_CHUNK'), false);
    assert.equal(
      plan.selection.excluded.find((item) => item.sourcePath === 'chunks/product-spec.chunk.md')?.reason,
      'generated_chunk',
    );
    const writeCounts = new Map(first.writeOrder.map((item) => [item.artifactType, item.count]));
    for (const artifactType of ['PROPOSAL', 'TASK_GRAPH', 'TASK', 'RUN_RECORD', 'GRAPH_NODE', 'GRAPH_EDGE']) {
      assert.equal(writeCounts.get(artifactType), 0);
    }
    assert.equal(writeCounts.get('DOCUMENT_CHUNK'), 0);
    assert.deepEqual(first.serverChunking, {
      strategy: 'paragraph-2000',
      targetSnapshots: 5,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs push plan validates server acknowledgments and omits client chunk writes', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const plan = buildMemoryPlan(planningArgs(artifactRoot));
    const calls = [];
    const post = async (_connection, endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === '/projects') return { projectId: body.projectId };
      if (endpoint.includes('/iterations')) return { iterationId: body.iterationId };
      if (endpoint === '/documents/snapshots') {
        assert.deepEqual(body.chunking, { strategy: 'paragraph-2000' });
        assert.equal('chunks' in body, false);
        return {
          documentId: body.documentId,
          chunking: { strategy: 'paragraph-2000', chunkCount: 2 },
        };
      }
      throw new Error(`unexpected planning-docs endpoint: ${endpoint}`);
    };
    const result = await pushPlan({}, plan, post);
    assert.equal(result.documents, 5);
    assert.equal(result.iterations, 2);
    assert.equal(result.taskGraphs, 0);
    assert.equal(result.tasks, 0);
    assert.equal(result.runs, 0);
    assert.equal(result.chunks, 0);
    assert.equal(result.serverGeneratedChunks, 10);
    assert.equal(result.graphSnapshots, 0);
    assert.equal(calls.some((endpoint) => endpoint === '/document-chunks/bulk'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/task-graphs'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/tasks/bulk'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/runs'), false);
    assert.equal(calls.some((endpoint) => endpoint === '/graph/snapshots'), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs CLI --yes writes only project, iterations, and server-chunked documents', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  const calls = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
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
      else if (pathName === '/documents/snapshots') result = {
        documentId: body.documentId,
        chunking: { strategy: 'paragraph-2000', chunkCount: 3 },
      };
      else throw new Error(`unexpected planning-docs endpoint: ${pathName}`);

      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    })().catch((error) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    });
  });

  const output = [];
  const originalLog = console.log;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    console.log = (...args) => output.push(args.join(' '));
    const status = await runMemoryMain([
      'push',
      '--artifacts', artifactRoot,
      '--profile', 'planning-docs',
      '--server', `http://127.0.0.1:${address.port}`,
      '--yes',
      '--json',
    ]);
    assert.equal(status, 0);
    const payload = JSON.parse(output.join('\n'));
    assert.equal(payload.result.chunks, 0);
    assert.equal(payload.result.serverGeneratedChunks, 15);
    assert.deepEqual(payload.serverChunking, {
      strategy: 'paragraph-2000',
      targetSnapshots: 5,
    });

    const paths = calls.map((call) => call.pathName);
    assert.equal(paths[0], '/projects');
    assert.equal(paths.filter((item) => item.endsWith('/iterations')).length, 2);
    assert.equal(paths.filter((item) => item === '/documents/snapshots').length, 5);
    assert.equal(paths.filter((item) => item === '/document-chunks/bulk').length, 0);
    assert.equal(paths.some((item) => [
      '/task-graphs',
      '/tasks/bulk',
      '/runs',
      '/graph/snapshots',
    ].includes(item)), false);
    assert.ok(calls
      .filter((call) => call.pathName === '/documents/snapshots')
      .every((call) => (
        !('chunks' in call.body)
        && JSON.stringify(call.body.chunking) === JSON.stringify({ strategy: 'paragraph-2000' })
      )));
  } finally {
    console.log = originalLog;
    server.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('planning-docs fails closed on missing or invalid server chunking acknowledgment', async () => {
  const { tempRoot, artifactRoot } = makeArtifactRoot();
  try {
    const cases = [
      ['missing acknowledgment', { documentId: 'snapshot-1' }, /did not acknowledge server chunking/],
      [
        'wrong strategy',
        { documentId: 'snapshot-1', chunking: { strategy: 'different', chunkCount: 1 } },
        /unexpected chunking strategy/,
      ],
      [
        'missing nested strategy',
        { documentId: 'snapshot-1', chunking: { chunkCount: 1 } },
        /unexpected chunking strategy/,
      ],
      [
        'missing chunkCount',
        { documentId: 'snapshot-1', chunking: { strategy: 'paragraph-2000' } },
        /invalid chunkCount/,
      ],
      [
        'zero chunkCount',
        { documentId: 'snapshot-1', chunking: { strategy: 'paragraph-2000', chunkCount: 0 } },
        /invalid chunkCount/,
      ],
      [
        'negative chunkCount',
        { documentId: 'snapshot-1', chunking: { strategy: 'paragraph-2000', chunkCount: -1 } },
        /invalid chunkCount/,
      ],
      [
        'non-integer chunkCount',
        { documentId: 'snapshot-1', chunking: { strategy: 'paragraph-2000', chunkCount: 1.5 } },
        /invalid chunkCount/,
      ],
    ];

    for (const [name, acknowledgment, errorPattern] of cases) {
      const plan = buildMemoryPlan(planningArgs(artifactRoot));
      const calls = [];
      const post = async (_connection, endpoint, body) => {
        calls.push(endpoint);
        if (endpoint === '/projects') return { projectId: body.projectId };
        if (endpoint.includes('/iterations')) return { iterationId: body.iterationId };
        if (endpoint === '/documents/snapshots') return acknowledgment;
        throw new Error(`unexpected endpoint after invalid acknowledgment: ${endpoint}`);
      };

      await assert.rejects(pushPlan({}, plan, post), errorPattern, name);
      assert.equal(
        calls.filter((endpoint) => endpoint === '/documents/snapshots').length,
        1,
        `${name} must stop before the next snapshot`,
      );
      assert.equal(
        calls.some((endpoint) => endpoint === '/document-chunks/bulk'),
        false,
        `${name} must not fall back to client chunks`,
      );
    }
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
  assert.match(graphSource.stderr, /planning-docs profile requires an explicit --artifacts source/);

  const implicitSource = runMemory(['push', '--profile', 'planning-docs', '--dry-run']);
  assert.notEqual(implicitSource.status, 0);
  assert.match(implicitSource.stderr, /planning-docs profile requires an explicit --artifacts source/);

  const proposals = runMemory([
    'push', '--artifacts', 'missing', '--profile', 'planning-docs', '--proposals', 'missing-proposals', '--dry-run',
  ]);
  assert.notEqual(proposals.status, 0);
  assert.match(proposals.stderr, /planning-docs profile does not support --proposals/);
});
