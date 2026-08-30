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
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ROOT,
  runExecute,
  runIteration,
  runP2a,
  runRuns,
  runTasks,
} from './helpers/fixtures.mjs';
import {
  createValidationSession,
  executionEnvelopeSha256,
  resolveRunExecutionEnvelope,
  validateCurrentDevelopmentContractData,
  validateRunTaskContract,
} from '../scripts/validate_artifacts.mjs';
import {
  resolveCurrentDevelopmentState,
} from '../scripts/p2a_iteration_state.mjs';
import {
  executionEnvelopeStoreRef,
  runFilePath,
} from '../scripts/p2a_run_paths.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function currentDevelopmentFixture(options = {}) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-current-development-'));
  const artifactRoot = path.join(
    workspaceRoot,
    '.plan2agent',
    'artifacts',
    'webhook-api-service',
  );
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(
    path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service'),
    artifactRoot,
    { recursive: true },
  );
  if (options.constitution) {
    writeJson(path.join(workspaceRoot, '.plan2agent', 'constitution.json'), {
      schema_version: 'p2a.constitution.v1',
      projectId: 'webhook-api-service',
      architecture: [{
        id: 'ARCH-1',
        rule: 'Keep webhook verification at the transport boundary.',
        rationale: 'Untrusted payloads must not enter internal processing first.',
        scope: 'webhook ingestion',
      }],
      stack: options.technologyConstitution ? [{
        id: 'STACK-1',
        choice: 'Use the Node.js runtime for the reference implementation.',
        rationale: 'Keep the fixture aligned with the approved runtime contract.',
        evidence: ['https://nodejs.org/en/about/previous-releases'],
      }] : [],
      prohibitions: [],
      style: { modules: 'small and explicit' },
      approval_audit: {
        approved_by: 'user',
        approved_at: '2026-08-27T00:00:00.000Z',
        approved_artifacts: ['.plan2agent/constitution.json'],
        approval_note: 'User quote: "Approve the current architecture."',
      },
    });
  }
  if (options.planned) {
    rmSync(path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'));
    const prepared = runExecute([
      'prepare',
      '--artifacts', artifactRoot,
      '--mode', 'planned',
      '--selection-rationale', 'Two current-only milestones cover implementation and regression.',
      '--milestone', 'milestone-current-implementation|Current implementation is complete|node -e "process.exit(0)"',
      '--milestone', 'milestone-current-regression|Current regression checks pass|node -e "process.exit(0)"',
    ]);
    assert.equal(prepared.status, 0, `${prepared.stdout}\n${prepared.stderr}`);
  }
  const initialized = runIteration([
    'init',
    '--artifacts', artifactRoot,
    '--iteration-id', 'v20',
  ]);
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
  return { workspaceRoot, artifactRoot };
}

function addMalformedHistory(artifactRoot, count) {
  const created = [];
  for (let index = 1; index <= count; index += 1) {
    const iterationRoot = path.join(artifactRoot, 'iterations', `archived-${index}`);
    const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const graphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
    for (const filePath of [specPath, intakePath, graphPath]) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '{ deliberately invalid historical JSON', 'utf8');
    }
    created.push(iterationRoot);
  }
  return created;
}

function linkLegacyCompositionHistory(artifactRoot, iterationRoots, options = {}) {
  if (iterationRoots.length === 0) return;
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  const activeSpec = JSON.parse(readFileSync(path.join(
    artifactRoot,
    'iterations',
    currentSpec.active_iteration,
    'gate-b-spec',
    'spec.json',
  ), 'utf8'));
  const sources = iterationRoots.map((iterationRoot) => {
    const iterationId = path.basename(iterationRoot);
    return {
      iteration_id: iterationId,
      status: 'archived',
      approval: 'approved',
      spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
      intake_ref: `iterations/${iterationId}/gate-a-intake/intake.json`,
      task_graph_ref: `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
    };
  });
  currentSpec.effective_spec_ref = options.effectiveSpecRef ?? 'current-spec.json';
  currentSpec.composed_from = sources.map((source) => source.iteration_id);
  currentSpec.source_specs = sources;
  currentSpec.effective_product = activeSpec.product;
  currentSpec.effective_implementation = activeSpec.implementation;
  writeJson(currentSpecPath, currentSpec);
}

function removeFixture(fixture) {
  rmSync(fixture.workspaceRoot, { recursive: true, force: true });
}

function archiveCurrentFixture(fixture, iterationId = 'v20') {
  const graphPath = path.join(
    fixture.artifactRoot,
    'iterations',
    iterationId,
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  for (const task of graph.tasks) task.status = 'done';
  writeJson(graphPath, graph);

  const closedAt = '2026-08-27T00:00:00.000Z';
  const currentSpecPath = path.join(fixture.artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  const record = {
    iteration_id: iterationId,
    status: 'archived',
    closed_at: closedAt,
    effective_spec_ref: currentSpec.effective_spec_ref,
    spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    task_graph_ref: `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
    task_count: graph.tasks.length,
    task_status_counts: {
      todo: 0,
      in_progress: 0,
      done: graph.tasks.length,
      blocked: 0,
    },
    artifact_hashes: {},
  };
  currentSpec.closed_iterations = [record];
  currentSpec.last_closed_iteration = record;
  delete currentSpec.pending_iteration;
  writeJson(currentSpecPath, currentSpec);

  const metadataPath = path.join(
    fixture.artifactRoot,
    'iterations',
    iterationId,
    'iteration.json',
  );
  const metadata = existsSync(metadataPath)
    ? JSON.parse(readFileSync(metadataPath, 'utf8'))
    : {
        schema_version: 'p2a.iteration_metadata.v1',
        project_id: 'webhook-api-service',
        iteration_id: iterationId,
      };
  writeJson(metadataPath, {
    ...metadata,
    status: 'archived',
    closed_at: closedAt,
    close: record,
  });
}

function tracedCommand(runner, args, fixture, historicalRoots) {
  const tracePath = path.join(
    tmpdir(),
    `p2a-fs-read-trace-${path.basename(fixture.workspaceRoot)}.log`,
  );
  writeFileSync(tracePath, '', 'utf8');
  const preload = path.join(ROOT, 'tests', 'helpers', 'trace-fs-reads.cjs');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
    .filter(Boolean)
    .join(' ');
  const result = runner(args, {
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      P2A_FS_READ_TRACE: tracePath,
    },
  });
  assert.equal(
    result.error,
    undefined,
    `command did not start: ${result.error?.message ?? 'unknown spawn error'}`,
  );
  const reads = readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((filePath) => path.resolve(filePath));
  const historicalReads = reads.filter((filePath) => historicalRoots.some((root) => (
    filePath === root || filePath.startsWith(`${root}${path.sep}`)
  )));
  rmSync(tracePath, { force: true });
  assert.deepEqual(
    historicalReads,
    [],
    `historical artifact read(s): ${historicalReads.join(', ')}`,
  );
  return { result, reads };
}

test('current development contract carries approved iteration constraints without a constitution', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const state = resolveCurrentDevelopmentState(fixture.artifactRoot);
    const spec = JSON.parse(readFileSync(state.specPath, 'utf8'));
    const expected = {
      architecture: spec.implementation.architecture,
      interfaces: spec.implementation.interfaces,
      dependencies: spec.implementation.dependencies,
    };
    assert.deepEqual(state.currentDevelopmentContract.iterationConstraints, expected);
    assert.deepEqual(state.executionEnvelope.iterationConstraints, expected);
    assert.equal(state.currentDevelopmentContract.bindings.constitution.ref, null);

    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    const legacy = structuredClone(state.currentDevelopmentContract);
    delete legacy.iterationConstraints;
    assert.doesNotThrow(() => validateCurrentDevelopmentContractData(legacy));
    writeJson(contractPath, legacy);
    const legacyState = resolveCurrentDevelopmentState(fixture.artifactRoot);
    assert.equal(legacyState.currentDevelopmentContract.iterationConstraints, undefined);
    assert.deepEqual(legacyState.executionEnvelope.iterationConstraints, expected);

    const routed = runP2a([
      'next',
      '--target', fixture.workspaceRoot,
      '--project-id', 'webhook-api-service',
      '--json',
      '--contract', 'v2',
    ]);
    assert.equal(routed.status, 0, `${routed.stdout}\n${routed.stderr}`);
    const action = JSON.parse(routed.stdout);
    assert.equal(action.state, 'ready_task_available');

    const migrated = runIteration([
      'migrate-current-contract', '--artifacts', fixture.artifactRoot,
    ]);
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    assert.deepEqual(
      JSON.parse(readFileSync(contractPath, 'utf8')).iterationConstraints,
      expected,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('current development contract rejects iteration constraints that differ from the bound spec', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    contract.iterationConstraints.interfaces = ['ATTACKER-CONTRACT-ONLY'];
    writeJson(contractPath, contract);

    assert.throws(
      () => resolveCurrentDevelopmentState(fixture.artifactRoot),
      /iterationConstraints do not match the bound active spec/,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('only legacy completed evidence may omit iteration constraints from its execution envelope', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const runId = 'run-legacy-constraint-envelope';
    const started = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const run = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    const legacyEnvelope = structuredClone(resolveRunExecutionEnvelope(run, runsDir));
    delete legacyEnvelope.iterationConstraints;
    const legacySha256 = executionEnvelopeSha256(legacyEnvelope);
    run.executionEnvelopeRef = { sha256: legacySha256 };
    run.executionEnvelopeSha256 = legacySha256;
    writeJson(
      path.join(runsDir, executionEnvelopeStoreRef(run, legacySha256)),
      legacyEnvelope,
    );

    assert.throws(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
      /executionEnvelope does not match its current development contract/,
    );

    run.status = 'finished';
    run.updatedAt = '2026-08-28T00:00:00.000Z';
    run.finishedAt = '2026-08-28T00:00:00.000Z';
    assert.doesNotThrow(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
    );

    run.productRevisionSha256 = '0'.repeat(64);
    assert.throws(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
      /executionEnvelope does not match its current development contract/,
    );

    delete run.productRevisionSha256;
    const current = resolveCurrentDevelopmentState(fixture.artifactRoot);
    const trustedLegacyEnvelope = structuredClone(current.executionEnvelope);
    trustedLegacyEnvelope.sourceGateRefs = [{
      path: current.currentDevelopmentContract.bindings.activeSpec.ref,
      sha256: current.currentDevelopmentContract.bindings.activeSpec.sha256,
    }];
    delete trustedLegacyEnvelope.iterationConstraints;
    for (const field of ['architecture', 'stack', 'prohibitions', 'style']) {
      delete trustedLegacyEnvelope[field];
    }
    const trustedLegacySha256 = executionEnvelopeSha256(trustedLegacyEnvelope);
    run.executionEnvelopeRef = { sha256: trustedLegacySha256 };
    run.executionEnvelopeSha256 = trustedLegacySha256;
    writeJson(
      path.join(runsDir, executionEnvelopeStoreRef(run, trustedLegacySha256)),
      trustedLegacyEnvelope,
    );
    assert.doesNotThrow(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
    );
  } finally {
    removeFixture(fixture);
  }
});

test('current contract compatibility never trusts run-authored envelope provenance', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const runId = 'run-untrusted-envelope-provenance';
    const started = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const run = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    const envelope = structuredClone(resolveRunExecutionEnvelope(run, runsDir));
    envelope.sourceGateRefs = [{
      path: 'attacker-controlled.json',
      sha256: '0'.repeat(64),
    }];
    const envelopeSha256 = executionEnvelopeSha256(envelope);
    run.executionEnvelopeRef = { sha256: envelopeSha256 };
    run.executionEnvelopeSha256 = envelopeSha256;
    writeJson(
      path.join(runsDir, executionEnvelopeStoreRef(run, envelopeSha256)),
      envelope,
    );

    assert.throws(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
      /executionEnvelope does not match its current development contract/,
    );

    run.status = 'finished';
    run.updatedAt = '2026-08-28T00:00:00.000Z';
    run.finishedAt = '2026-08-28T00:00:00.000Z';
    assert.throws(
      () => validateRunTaskContract(run, fixture.artifactRoot, { runsDir }),
      /executionEnvelope does not match its current development contract/,
    );
  } finally {
    removeFixture(fixture);
  }
});

test('opening from a legacy contract preserves iteration constraints recovered from its bound spec', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    const before = resolveCurrentDevelopmentState(fixture.artifactRoot);
    const expected = structuredClone(before.executionEnvelope.iterationConstraints);
    const legacy = JSON.parse(readFileSync(contractPath, 'utf8'));
    delete legacy.iterationConstraints;
    writeJson(contractPath, legacy);
    archiveCurrentFixture(fixture);

    const opened = runIteration([
      'open',
      '--artifacts', fixture.artifactRoot,
      '--iteration-id', 'v21-legacy-contract',
      '--idea', 'Continue from the approved legacy baseline.',
    ]);
    assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);

    const currentSpec = JSON.parse(readFileSync(
      path.join(fixture.artifactRoot, 'current-spec.json'),
      'utf8',
    ));
    const baselineSpec = JSON.parse(readFileSync(
      path.join(fixture.artifactRoot, currentSpec.effective_spec_ref),
      'utf8',
    ));
    assert.deepEqual(baselineSpec.implementation.architecture, expected.architecture);
    assert.deepEqual(baselineSpec.implementation.interfaces, expected.interfaces);
    assert.deepEqual(baselineSpec.implementation.dependencies, expected.dependencies);
  } finally {
    removeFixture(fixture);
  }
});

test('0, 20, and 100 archived iteration directories produce identical current validator work', () => {
  const observations = [];
  const fileReadCounts = [];
  const contextReadCounts = [];
  const taskTransitionReadCounts = [];
  for (const historyCount of [0, 20, 100]) {
    const fixture = currentDevelopmentFixture();
    try {
      const archived = addMalformedHistory(fixture.artifactRoot, historyCount);
      linkLegacyCompositionHistory(fixture.artifactRoot, archived);
      const validationSession = createValidationSession();
      const state = resolveCurrentDevelopmentState(fixture.artifactRoot, {
        validationSession,
      });
      assert.equal(state.activeIteration, 'v20');
      observations.push(structuredClone(validationSession.stats));

      const traced = tracedCommand(runP2a, [
        'next',
        '--target', fixture.workspaceRoot,
        '--project-id', 'webhook-api-service',
        '--json',
        '--trace',
      ], fixture, archived.map((iterationRoot) => path.resolve(iterationRoot)));
      const { result: next, reads } = traced;
      assert.equal(next.status, 0, `${next.stdout}\n${next.stderr}`);
      assert.equal(JSON.parse(next.stdout).state, 'ready_task_available');
      assert.match(next.stderr, /historical:reads: 0/);
      assert.doesNotMatch(next.stderr, /archived-[0-9]+/);
      fileReadCounts.push(reads.filter((filePath) => filePath.startsWith(`${fixture.artifactRoot}${path.sep}`)).length);

      const tracedContext = tracedCommand(runIteration, [
        'context',
        '--artifacts', fixture.artifactRoot,
        '--code-root', fixture.workspaceRoot,
      ], fixture, archived.map((iterationRoot) => path.resolve(iterationRoot)));
      assert.equal(
        tracedContext.result.status,
        0,
        `${tracedContext.result.stdout}\n${tracedContext.result.stderr}`,
      );
      const context = JSON.parse(tracedContext.result.stdout);
      assert.equal(context.active_iteration, 'v20');
      assert.doesNotMatch(JSON.stringify(context), /archived-[0-9]+/);
      contextReadCounts.push(tracedContext.reads.filter(
        (filePath) => filePath.startsWith(`${fixture.artifactRoot}${path.sep}`),
      ).length);

      const tracedTask = tracedCommand(runTasks, [
        'start', '--artifacts', fixture.artifactRoot, 'task-001',
      ], fixture, archived.map((iterationRoot) => path.resolve(iterationRoot)));
      assert.equal(
        tracedTask.result.status,
        0,
        `${tracedTask.result.stdout}\n${tracedTask.result.stderr}`,
      );
      taskTransitionReadCounts.push(tracedTask.reads.filter(
        (filePath) => filePath.startsWith(`${fixture.artifactRoot}${path.sep}`),
      ).length);
    } finally {
      removeFixture(fixture);
    }
  }
  assert.deepEqual(observations[1], observations[0]);
  assert.deepEqual(observations[2], observations[0]);
  assert.deepEqual(fileReadCounts, [fileReadCounts[0], fileReadCounts[0], fileReadCounts[0]]);
  assert.deepEqual(contextReadCounts, [contextReadCounts[0], contextReadCounts[0], contextReadCounts[0]]);
  assert.deepEqual(taskTransitionReadCounts, [
    taskTransitionReadCounts[0],
    taskTransitionReadCounts[0],
    taskTransitionReadCounts[0],
  ]);
  assert.deepEqual(observations[0].validatorRuns, {
    'current-development-contract': 1,
  });
});

test('current lifecycle commands continue after archived artifacts are deleted', () => {
  const fixture = currentDevelopmentFixture({ planned: true });
  try {
    const archived = addMalformedHistory(fixture.artifactRoot, 20);
    linkLegacyCompositionHistory(fixture.artifactRoot, archived);
    const historicalRoots = archived.map((iterationRoot) => path.resolve(iterationRoot));
    const runId = 'run-current-only-lifecycle';
    let { result } = tracedCommand(runExecute, [
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ], fixture, historicalRoots);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /BuildLore|LLM Wiki/i);

    ({ result } = tracedCommand(runExecute, [
      'status', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ], fixture, historicalRoots));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    for (const iterationRoot of archived) {
      rmSync(iterationRoot, { recursive: true, force: true });
    }
    ({ result } = tracedCommand(runExecute, [
      'resume', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ], fixture, historicalRoots));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    for (const milestone of ['milestone-current-implementation', 'milestone-current-regression']) {
      ({ result } = tracedCommand(runRuns, [
        'checkpoint',
        '--artifacts', fixture.artifactRoot,
        '--run-id', runId,
        '--milestone', milestone,
      ], fixture, historicalRoots));
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    ({ result } = tracedCommand(runExecute, [
      'finish', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ], fixture, historicalRoots));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const run = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    const envelope = resolveRunExecutionEnvelope(run, runsDir);
    assert.deepEqual(envelope.sourceGateRefs.map((source) => source.path), [
      'current-development-contract.json',
    ]);
    assert.doesNotMatch(JSON.stringify(envelope), /archived-|source_specs|gate-a-intake/);
  } finally {
    removeFixture(fixture);
  }
});

test('direct task transitions and iteration close stay current-only with linked legacy composition', () => {
  const fixture = currentDevelopmentFixture({ planned: true });
  try {
    const archived = addMalformedHistory(fixture.artifactRoot, 20);
    linkLegacyCompositionHistory(fixture.artifactRoot, archived, {
      effectiveSpecRef: 'iterations/archived-1/gate-b-spec/spec.json',
    });
    const historicalRoots = archived.map((iterationRoot) => path.resolve(iterationRoot));
    const runId = 'run-current-only-task-transitions';
    for (const iterationRoot of archived) {
      rmSync(iterationRoot, { recursive: true, force: true });
    }

    let traced = tracedCommand(runExecute, [
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    for (const milestone of ['milestone-current-implementation', 'milestone-current-regression']) {
      traced = tracedCommand(runRuns, [
        'checkpoint',
        '--artifacts', fixture.artifactRoot,
        '--run-id', runId,
        '--milestone', milestone,
      ], fixture, historicalRoots);
      assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    }
    traced = tracedCommand(runExecute, [
      'finish', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);

    for (const transition of [
      ['todo', '--artifacts', fixture.artifactRoot, 'task-001', '--reopen', '--note', 'Exercise current-only reopen.'],
      ['start', '--artifacts', fixture.artifactRoot, 'task-001'],
      ['block', '--artifacts', fixture.artifactRoot, 'task-001', '--note', 'Exercise current-only block.'],
      ['todo', '--artifacts', fixture.artifactRoot, 'task-001'],
      ['start', '--artifacts', fixture.artifactRoot, 'task-001'],
      ['done', '--artifacts', fixture.artifactRoot, 'task-001'],
    ]) {
      traced = tracedCommand(runTasks, transition, fixture, historicalRoots);
      assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    }

    const finalRunId = 'run-current-only-final-verification';
    traced = tracedCommand(runExecute, [
      'verify-final',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', finalRunId,
      '--agent-tool', 'manual',
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    traced = tracedCommand(runRuns, [
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', finalRunId,
      '--test-command', `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    traced = tracedCommand(runExecute, [
      'finish', '--artifacts', fixture.artifactRoot, '--run-id', finalRunId,
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);

    traced = tracedCommand(runIteration, [
      'close', '--artifacts', fixture.artifactRoot,
    ], fixture, historicalRoots);
    assert.equal(traced.result.status, 0, `${traced.result.stdout}\n${traced.result.stderr}`);
    assert.match(traced.result.stdout, /iteration closed/);
  } finally {
    removeFixture(fixture);
  }
});

test('explicit iteration validation still audits linked historical composition', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const archived = addMalformedHistory(fixture.artifactRoot, 20);
    linkLegacyCompositionHistory(fixture.artifactRoot, archived);
    const audited = runIteration([
      'validate', '--artifacts', fixture.artifactRoot,
    ]);
    assert.equal(audited.status, 1, `${audited.stdout}\n${audited.stderr}`);
    assert.match(audited.stderr, /Expected property name|valid JSON/);
  } finally {
    removeFixture(fixture);
  }
});

test('open runs fail closed when current contract, constitution, or task binding changes', () => {
  const fixture = currentDevelopmentFixture({ constitution: true });
  try {
    const runId = 'run-current-binding-drift';
    let result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', fixture.workspaceRoot,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    const contractBefore = readFileSync(contractPath);
    const contract = JSON.parse(contractBefore.toString('utf8'));
    contract.objective = `${contract.objective} Unauthorized drift.`;
    writeJson(contractPath, contract);
    result = runExecute([
      'status', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /current development contract changed after start/);
    writeFileSync(contractPath, contractBefore);

    const constitutionPath = path.join(fixture.workspaceRoot, '.plan2agent', 'constitution.json');
    const constitutionBefore = readFileSync(constitutionPath);
    const constitution = JSON.parse(constitutionBefore.toString('utf8'));
    constitution.style.modules = 'drifted';
    writeJson(constitutionPath, constitution);
    result = runExecute([
      'resume', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /constitution binding changed/);
    writeFileSync(constitutionPath, constitutionBefore);

    const graphPath = path.join(
      fixture.artifactRoot,
      'iterations',
      'v20',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks[0].title = 'Drifted current task';
    writeJson(graphPath, graph);
    result = runExecute([
      'status', '--artifacts', fixture.artifactRoot, '--run-id', runId,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /task bindings do not match/);
  } finally {
    removeFixture(fixture);
  }
});

test('existing iterative projects migrate to a deterministic current contract', () => {
  const fixture = currentDevelopmentFixture();
  try {
    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    rmSync(contractPath);
    addMalformedHistory(fixture.artifactRoot, 20);

    const before = runP2a([
      'next',
      '--target', fixture.workspaceRoot,
      '--project-id', 'webhook-api-service',
      '--json',
      '--trace',
    ]);
    assert.equal(before.status, 0, `${before.stdout}\n${before.stderr}`);
    assert.equal(JSON.parse(before.stdout).state, 'current_development_contract_required');
    assert.match(before.stderr, /historical:reads: 0/);

    let migrated = runIteration([
      'migrate-current-contract', '--artifacts', fixture.artifactRoot,
    ]);
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    assert.equal(existsSync(contractPath), true);
    const first = readFileSync(contractPath);

    migrated = runIteration([
      'migrate-current-contract', '--artifacts', fixture.artifactRoot,
    ]);
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
    assert.deepEqual(readFileSync(contractPath), first);
  } finally {
    removeFixture(fixture);
  }
});

test('opening a new iteration snapshots only the current contract and survives deletion of the prior iteration', () => {
  const fixture = currentDevelopmentFixture({
    constitution: true,
    technologyConstitution: true,
  });
  try {
    archiveCurrentFixture(fixture);
    const archived = addMalformedHistory(fixture.artifactRoot, 19);
    linkLegacyCompositionHistory(fixture.artifactRoot, archived);
    const historicalRoots = archived.map((iterationRoot) => path.resolve(iterationRoot));
    const contractPath = path.join(fixture.artifactRoot, 'current-development-contract.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    assert.equal(contract.technologyEvidence?.[0]?.source_id, 'WEB-1');
    delete contract.technologyEvidence;
    writeJson(contractPath, contract);
    const { result: opened } = tracedCommand(runIteration, [
      'open',
      '--artifacts', fixture.artifactRoot,
      '--iteration-id', 'v21',
      '--idea', 'Add a bounded webhook replay endpoint.',
    ], fixture, historicalRoots);
    assert.equal(opened.error, undefined, opened.error?.message);
    assert.equal(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);

    const currentSpec = JSON.parse(readFileSync(
      path.join(fixture.artifactRoot, 'current-spec.json'),
      'utf8',
    ));
    assert.equal(
      currentSpec.effective_spec_ref,
      'iterations/v21/baseline/gate-b-spec/spec.json',
    );
    for (const field of [
      'source_specs',
      'effective_product',
      'effective_implementation',
      'product_sources',
      'implementation_sources',
      'superseded_refs',
      'composition_conflicts',
    ]) {
      assert.equal(currentSpec[field], undefined, `${field} must not be carried into current state`);
    }

    const baselineSpec = JSON.parse(readFileSync(
      path.join(fixture.artifactRoot, currentSpec.effective_spec_ref),
      'utf8',
    ));
    assert.equal(baselineSpec.product.problem, contract.objective);
    assert.deepEqual(baselineSpec.product.goals, contract.scope);
    assert.deepEqual(baselineSpec.product.must_preserve, contract.mustPreserve);
    assert.deepEqual(baselineSpec.product.non_goals, contract.nonGoals);
    assert.deepEqual(baselineSpec.product.success_criteria, contract.acceptance);
    assert.deepEqual(
      baselineSpec.implementation.architecture,
      contract.iterationConstraints.architecture,
    );
    assert.deepEqual(
      baselineSpec.implementation.interfaces,
      contract.iterationConstraints.interfaces,
    );
    assert.deepEqual(
      baselineSpec.implementation.dependencies,
      contract.iterationConstraints.dependencies,
    );
    assert.deepEqual(baselineSpec.implementation.verification, contract.verification);
    assert.equal(baselineSpec.evidence[0]?.source_id, 'WEB-1');
    assert.equal(
      baselineSpec.evidence[0]?.url,
      'https://nodejs.org/en/about/previous-releases',
    );
    assert.doesNotMatch(JSON.stringify(baselineSpec), /iterations\/v20\/gate-/);

    const previousIterationRoot = path.join(fixture.artifactRoot, 'iterations', 'v20');
    rmSync(previousIterationRoot, {
      recursive: true,
      force: true,
    });
    const { result: drafted } = tracedCommand(
      runIteration,
      ['draft', '--artifacts', fixture.artifactRoot],
      fixture,
      [...historicalRoots, path.resolve(previousIterationRoot)],
    );
    assert.equal(drafted.error, undefined, drafted.error?.message);
    assert.equal(drafted.status, 0, `${drafted.stdout}\n${drafted.stderr}`);
    assert.match(drafted.stdout, /Gate A/);
  } finally {
    removeFixture(fixture);
  }
});
