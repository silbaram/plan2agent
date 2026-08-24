import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { FIXTURE_ROOT, makeTempDir, runP2a } from './helpers/fixtures.mjs';
import { validateSchema } from '../scripts/p2a_schema.mjs';
import { NEXT_DECISION_RULES } from '../scripts/p2a.mjs';
import { buildNext } from '../scripts/p2a_next_service.mjs';
import {
  iterationCompositionRequirement,
  validateCurrentSpecCompositionData,
} from '../scripts/p2a_iteration_state.mjs';
import {
  createValidationSession,
  validateIntake,
  validateRunIndexData,
  validateSpec,
  validateTaskGraph,
} from '../scripts/validate_artifacts.mjs';
import {
  CONTINUATION_DEFINITIONS,
  continuationDescriptor,
} from '../scripts/p2a_continuations.mjs';

const NEXT_V1_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/next.schema.json', import.meta.url), 'utf8'));
const NEXT_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/next-v2.schema.json', import.meta.url), 'utf8'));

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function project(options = {}) {
  const root = makeTempDir('p2a-next-');
  const manifest = {
    provenance: { mode: options.mode ?? 'scaffold' },
    enhancements: options.proposals ? { proposals: { enabled: true } } : {},
  };
  writeJson(join(root, '.plan2agent', 'manifest.json'), manifest);
  return root;
}

function artifact(root, projectId = 'sample') {
  const artifactRoot = join(root, '.plan2agent', 'artifacts', projectId);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(join(artifactRoot, 'status.md'), '# fixture\n', 'utf8');
  return artifactRoot;
}

function writeConstitution(root, projectId = 'sample', approved = true) {
  writeJson(join(root, '.plan2agent', 'constitution.json'), {
    schema_version: 'p2a.constitution.v1',
    projectId,
    architecture: [],
    stack: [],
    prohibitions: [],
    style: {},
    ...(approved ? {
      approval_audit: {
        approved_by: 'user',
        approved_at: '2026-08-04',
        approved_artifacts: ['.plan2agent/constitution.json'],
        approval_note: 'User quote: "approve this shape"',
      },
    } : {}),
  });
}

function gateRoot(artifactRoot, iterationId = null) {
  return iterationId ? join(artifactRoot, 'iterations', iterationId) : artifactRoot;
}

function currentProjectId(artifactRoot) {
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  if (!existsSync(currentSpecPath)) return null;
  try {
    return JSON.parse(readFileSync(currentSpecPath, 'utf8')).project_id ?? null;
  } catch {
    return null;
  }
}

function writeGateA(artifactRoot, status = 'blocked_on_user', iterationId = null) {
  const fixtureName = status === 'ready_for_spec'
    ? 'intake.answered.json'
    : 'intake.blocked.json';
  const intake = JSON.parse(readFileSync(
    join(FIXTURE_ROOT, 'cache-library', fixtureName),
    'utf8',
  ));
  writeJson(
    join(gateRoot(artifactRoot, iterationId), 'gate-a-intake', 'intake.json'),
    intake,
  );
}

function writeGateB(
  artifactRoot,
  approval = 'approved',
  iterationId = null,
  options = {},
) {
  const spec = JSON.parse(readFileSync(
    join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'),
    'utf8',
  ));
  spec.source_intake = '../gate-a-intake/intake.json';
  spec.project_id = currentProjectId(artifactRoot) ?? spec.project_id;
  spec.approval = approval;
  if (approval !== 'approved') delete spec.approval_audit;
  const specPath = join(gateRoot(artifactRoot, iterationId), 'gate-b-spec', 'spec.json');
  writeJson(specPath, spec);

  if (!iterationId || !existsSync(join(artifactRoot, 'current-spec.json'))) return;
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  if (approval === 'approved' && options.promoted !== false) {
    const promotedAt = '2026-07-31T00:00:00.000Z';
    const specRef = `iterations/${iterationId}/gate-b-spec/spec.json`;
    currentSpec.gate_b_promoted_at = promotedAt;
    currentSpec.gate_b_approval_audits = {
      ...(currentSpec.gate_b_approval_audits ?? {}),
      [iterationId]: {
        ...spec.approval_audit,
        approved_artifacts: [specRef],
      },
    };
    currentSpec.gate_b_promotion_bindings = {
      ...(currentSpec.gate_b_promotion_bindings ?? {}),
      [iterationId]: {
        source_spec_ref: specRef,
        source_spec_sha256: createHash('sha256')
          .update(readFileSync(specPath))
          .digest('hex'),
        promoted_at: promotedAt,
      },
    };
    if (currentSpec.pending_iteration?.iteration_id === iterationId) {
      currentSpec.pending_iteration.status = 'gate_b_approved';
      currentSpec.pending_iteration.promoted_at = promotedAt;
      currentSpec.pending_iteration.artifacts = {
        ...(currentSpec.pending_iteration.artifacts ?? {}),
        spec_ref: specRef,
      };
    }
  } else {
    delete currentSpec.gate_b_approval_audits?.[iterationId];
    delete currentSpec.gate_b_promotion_bindings?.[iterationId];
    delete currentSpec.gate_b_promoted_at;
  }
  writeJson(currentSpecPath, currentSpec);
}

function writeGateC(artifactRoot, tasks, iterationId = null) {
  writeJson(
    join(gateRoot(artifactRoot, iterationId), 'gate-c-task-graph', 'task-graph.json'),
    {
      schema_version: 'p2a.task_graph.v1',
      projectId: currentProjectId(artifactRoot) ?? 'cache-library',
      version: iterationId ?? 'v1',
      sourceSpec: '../gate-b-spec/spec.json',
      tasks,
    },
  );
}

function writeGateD(artifactRoot, blockingIssues = [], iterationId = null) {
  const review = JSON.parse(readFileSync(
    join(FIXTURE_ROOT, 'cache-library', 'review.json'),
    'utf8',
  ));
  review.sourceSpec = '../gate-b-spec/spec.json';
  review.sourceTaskGraph = '../gate-c-task-graph/task-graph.json';
  review.projectId = currentProjectId(artifactRoot) ?? review.projectId;
  review.blocking_issues = blockingIssues.map((issue) => (
    typeof issue === 'string' ? issue : issue.id ?? JSON.stringify(issue)
  ));
  writeJson(
    join(gateRoot(artifactRoot, iterationId), 'gate-d-review', 'review.json'),
    review,
  );
}

function writeIteration(artifactRoot, projectId = 'sample', options = {}) {
  const iterationId = options.iterationId ?? 'v1';
  mkdirSync(join(artifactRoot, 'iterations', iterationId), { recursive: true });
  const currentSpec = {
    schema_version: 'p2a.current_spec.v1',
    project_id: projectId,
    active_iteration: iterationId,
    effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    ...(options.closed ? {
      last_closed_iteration: { iteration_id: iterationId, status: 'archived' },
      closed_iterations: [{ iteration_id: iterationId, status: 'archived' }],
    } : {}),
  };
  writeJson(join(artifactRoot, 'current-spec.json'), currentSpec);
  if (options.closed) {
    writeJson(join(artifactRoot, 'iterations', iterationId, 'iteration.json'), {
      schema_version: 'p2a.iteration.v1',
      project_id: projectId,
      iteration_id: iterationId,
      status: 'archived',
      opened_at: options.openedAt ?? '2026-01-01T00:00:00.000Z',
    });
  }
  return iterationId;
}

function addArchivedArtifactAudits(artifactRoot) {
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  const auditedRecords = currentSpec.closed_iterations.map((closed) => {
    const iterationId = closed.iteration_id;
    const refs = [
      `iterations/${iterationId}/baseline/current-spec.json`,
      `iterations/${iterationId}/gate-a-intake/intake.json`,
      `iterations/${iterationId}/gate-a-intake/intake.md`,
      `iterations/${iterationId}/gate-b-spec/product-spec.md`,
      `iterations/${iterationId}/gate-b-spec/implementation-plan.md`,
      `iterations/${iterationId}/gate-b-spec/experience-spec.json`,
      `iterations/${iterationId}/gate-b-spec/spec.json`,
      `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
    ];
    return {
      ...closed,
      artifact_hashes: Object.fromEntries(refs.map((ref) => {
        const filePath = join(artifactRoot, ref);
        return [
          ref,
          existsSync(filePath)
            ? {
                present: true,
                sha256: createHash('sha256')
                  .update(readFileSync(filePath))
                  .digest('hex'),
              }
            : { present: false, sha256: null },
        ];
      })),
    };
  });
  currentSpec.closed_iterations = auditedRecords;
  const activeRecord = auditedRecords.find(
    (record) => record.iteration_id === currentSpec.active_iteration,
  );
  currentSpec.last_closed_iteration = { ...activeRecord };
  writeJson(currentSpecPath, currentSpec);
}

function writeClosedIterationWithCompositionGap(artifactRoot, projectId = 'sample') {
  const sourceIteration = 'v1';
  const activeIteration = 'v2';
  writeIteration(artifactRoot, projectId, {
    closed: true,
    iterationId: activeIteration,
    openedAt: '2026-01-02T00:00:00.000Z',
  });
  for (const iterationId of [sourceIteration, activeIteration]) {
    mkdirSync(join(artifactRoot, 'iterations', iterationId), { recursive: true });
    writeGateA(artifactRoot, 'ready_for_spec', iterationId);
    writeGateB(artifactRoot, 'approved', iterationId);
    writeGateC(artifactRoot, [task('task-001', 'done')], iterationId);
    writeGateD(artifactRoot, [], iterationId);
  }
  writeJson(join(artifactRoot, 'iterations', sourceIteration, 'iteration.json'), {
    schema_version: 'p2a.iteration.v1',
    project_id: projectId,
    iteration_id: sourceIteration,
    status: 'archived',
    opened_at: '2026-01-01T00:00:00.000Z',
  });

  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  const sourceSpec = JSON.parse(readFileSync(
    join(artifactRoot, 'iterations', sourceIteration, 'gate-b-spec', 'spec.json'),
    'utf8',
  ));
  currentSpec.effective_spec_ref = 'current-spec.json';
  currentSpec.composed_from = [sourceIteration];
  currentSpec.source_specs = [{
    iteration_id: sourceIteration,
    spec_ref: `iterations/${sourceIteration}/gate-b-spec/spec.json`,
    status: 'archived',
    approval: 'approved',
  }];
  currentSpec.effective_product = sourceSpec.product;
  currentSpec.effective_implementation = sourceSpec.implementation;
  currentSpec.superseded_refs = [];
  currentSpec.composition_conflicts = [];
  currentSpec.open_decisions = [];
  currentSpec.last_closed_iteration = {
    iteration_id: activeIteration,
    status: 'archived',
  };
  currentSpec.closed_iterations = [sourceIteration, activeIteration].map(
    (iterationId) => ({ iteration_id: iterationId, status: 'archived' }),
  );
  writeJson(currentSpecPath, currentSpec);
  return activeIteration;
}

function writeBuildLoreShapedClosedHistory(artifactRoot, projectId = 'sample') {
  const iterationIds = Array.from({ length: 11 }, (_, index) => `v${index + 1}`);
  const activeIteration = iterationIds.at(-1);
  writeIteration(artifactRoot, projectId, {
    closed: true,
    iterationId: activeIteration,
    openedAt: '2026-01-11T00:00:00.000Z',
  });
  for (const [index, iterationId] of iterationIds.entries()) {
    mkdirSync(join(artifactRoot, 'iterations', iterationId), { recursive: true });
    writeGateA(artifactRoot, 'ready_for_spec', iterationId);
    writeGateB(artifactRoot, 'approved', iterationId);
    writeGateC(artifactRoot, [task('task-001', 'done')], iterationId);
    writeGateD(artifactRoot, [], iterationId);
    writeJson(join(artifactRoot, 'iterations', iterationId, 'iteration.json'), {
      schema_version: 'p2a.iteration.v1',
      project_id: projectId,
      iteration_id: iterationId,
      status: 'archived',
      opened_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }

  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  const effectiveSpec = JSON.parse(readFileSync(
    join(artifactRoot, 'iterations', activeIteration, 'gate-b-spec', 'spec.json'),
    'utf8',
  ));
  currentSpec.effective_spec_ref = 'current-spec.json';
  currentSpec.composed_from = iterationIds;
  currentSpec.source_specs = iterationIds.map((iterationId) => ({
    iteration_id: iterationId,
    spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    status: 'archived',
    approval: 'approved',
  }));
  currentSpec.effective_product = effectiveSpec.product;
  currentSpec.effective_implementation = effectiveSpec.implementation;
  currentSpec.superseded_refs = [];
  currentSpec.composition_conflicts = [];
  currentSpec.open_decisions = [];
  currentSpec.closed_iterations = iterationIds.map((iterationId) => ({
    iteration_id: iterationId,
    status: 'archived',
  }));
  currentSpec.last_closed_iteration = {
    iteration_id: activeIteration,
    status: 'archived',
  };
  writeJson(currentSpecPath, currentSpec);
  addArchivedArtifactAudits(artifactRoot);
  return { activeIteration, iterationIds };
}

function addComposedBaselineHistory(artifactRoot, iterationIds) {
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  for (let index = 1; index < iterationIds.length; index += 1) {
    const iterationId = iterationIds[index];
    const baselineIds = iterationIds.slice(0, index);
    const activeBaselineIteration = baselineIds.at(-1);
    const effectiveSpec = JSON.parse(readFileSync(
      join(
        artifactRoot,
        'iterations',
        activeBaselineIteration,
        'gate-b-spec',
        'spec.json',
      ),
      'utf8',
    ));
    const baselineRef = `iterations/${iterationId}/baseline/current-spec.json`;
    const baselinePath = join(artifactRoot, baselineRef);
    writeJson(baselinePath, {
      schema_version: 'p2a.current_spec.v1',
      project_id: currentSpec.project_id,
      active_iteration: activeBaselineIteration,
      effective_spec_ref: 'current-spec.json',
      composed_from: baselineIds,
      source_specs: baselineIds.map((sourceIterationId) => ({
        iteration_id: sourceIterationId,
        spec_ref: `iterations/${sourceIterationId}/gate-b-spec/spec.json`,
        status: 'archived',
        approval: 'approved',
      })),
      effective_product: effectiveSpec.product,
      effective_implementation: effectiveSpec.implementation,
      superseded_refs: [],
      open_decisions: [],
      composition_conflicts: [],
      closed_iterations: baselineIds.map((sourceIterationId) => ({
        iteration_id: sourceIterationId,
        status: 'archived',
      })),
      last_closed_iteration: {
        iteration_id: activeBaselineIteration,
        status: 'archived',
      },
    });
    const baselineSha256 = createHash('sha256')
      .update(readFileSync(baselinePath))
      .digest('hex');
    const intakePath = join(
      artifactRoot,
      'iterations',
      iterationId,
      'gate-a-intake',
      'intake.json',
    );
    const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
    intake.baseline_context = {
      spec_ref: baselineRef,
      spec_sha256: baselineSha256,
      reused_answers: [],
      reused_question_dispositions: [],
    };
    writeJson(intakePath, intake);

    const metadataPath = join(
      artifactRoot,
      'iterations',
      iterationId,
      'iteration.json',
    );
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.baseline = {
      iteration_id: activeBaselineIteration,
      current_spec_ref: 'current-spec.json',
      effective_spec_ref: baselineRef,
      effective_spec_sha256: baselineSha256,
    };
    writeJson(metadataPath, metadata);
  }
  addArchivedArtifactAudits(artifactRoot);
}

function writeBaselineBackedPlanningIteration(artifactRoot) {
  const baselineIteration = 'v1-mvp';
  const activeIteration = 'v2-baseline-backed';
  const baselineSpecRef = `iterations/${baselineIteration}/gate-b-spec/spec.json`;
  const baselineSpecPath = join(artifactRoot, baselineSpecRef);
  const openedAt = '2026-08-19T00:00:00.000Z';
  const idea = 'Build the next baseline-backed project capability.';
  const baselineSpec = JSON.parse(readFileSync(
    join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'),
    'utf8',
  ));
  baselineSpec.project_id = 'sample';
  writeJson(baselineSpecPath, baselineSpec);
  const baselineSpecSha256 = createHash('sha256')
    .update(readFileSync(baselineSpecPath))
    .digest('hex');
  const activeIterationRoot = join(artifactRoot, 'iterations', activeIteration);
  mkdirSync(activeIterationRoot, { recursive: true });
  writeJson(join(activeIterationRoot, 'iteration.json'), {
    schema_version: 'p2a.iteration_metadata.v1',
    project_id: 'sample',
    iteration_id: activeIteration,
    status: 'active_planning',
    opened_at: openedAt,
    idea,
    baseline: {
      iteration_id: baselineIteration,
      current_spec_ref: 'current-spec.json',
      effective_spec_ref: baselineSpecRef,
      effective_spec_sha256: baselineSpecSha256,
    },
  });
  writeJson(join(artifactRoot, 'current-spec.json'), {
    schema_version: 'p2a.current_spec.v1',
    project_id: 'sample',
    active_iteration: activeIteration,
    effective_spec_ref: baselineSpecRef,
    pending_iteration: {
      iteration_id: activeIteration,
      status: 'active_planning',
      opened_at: openedAt,
      idea,
      baseline_iteration: baselineIteration,
      baseline_effective_spec_ref: baselineSpecRef,
      baseline_effective_spec_sha256: baselineSpecSha256,
    },
  });
  return activeIteration;
}

function task(id, status, dependencies = []) {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}.`,
    status,
    dependencies,
    acceptanceCriteria: [`${id} meets its acceptance criteria.`],
    targetArea: 'src',
    suggestedAgentPrompt: `Implement ${id} from the approved specification.`,
    sourceSpecRefs: ['product.goals'],
  };
}

function writeRuns(artifactRoot, runs) {
  const projectId = currentProjectId(artifactRoot) ?? 'cache-library';
  const runRecords = runs.map((run, index) => {
    const taskId = run.taskId ?? 'task-001';
    const startedAt = run.startedAt ?? `2026-07-31T00:00:0${index}.000Z`;
    const finishedAt = run.status === 'started'
      ? null
      : run.finishedAt ?? `2026-07-31T00:01:0${index}.000Z`;
    const taskGraphRef = run.taskGraphRef ?? (
      run.iterationId
        ? `iterations/${run.iterationId}/gate-c-task-graph/task-graph.json`
        : 'gate-c-task-graph/task-graph.json'
    );
    const sourceSpecRef = run.sourceSpecRef ?? (
      run.iterationId
        ? `iterations/${run.iterationId}/gate-b-spec/spec.json`
        : 'gate-b-spec/spec.json'
    );
    return {
      schema_version: 'p2a.run.v1',
      runId: run.runId,
      projectId,
      taskId,
      taskTitle: `Task ${taskId}`,
      iterationId: run.iterationId ?? null,
      sourceLayout: run.sourceLayout ?? (run.iterationId ? 'iteration' : 'handoff'),
      taskGraphRef,
      sourceSpecRef,
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
      status: run.status,
      startedAt,
      updatedAt: finishedAt ?? startedAt,
      finishedAt,
      changedFiles: [],
      verification: run.verification ?? [],
      notes: [],
      ...(run.runKind ? { runKind: run.runKind } : {}),
      ...(['failed', 'blocked'].includes(run.status) ? {
        failure: {
          class: 'implementation_incomplete',
          retryable: 'after_fix',
          needsUserDecision: false,
          source: 'owner',
        },
        reproduction: {
          steps: ['Reproduce the fixture failure.'],
          commands: [],
          notes: [],
        },
        localization: {
          findings: ['The fixture run records a localized failure.'],
          files: [],
        },
        guard: {
          checks: ['Validate the repaired run evidence.'],
          notes: [],
        },
      } : {}),
    };
  });
  for (const run of runRecords) {
    writeJson(join(artifactRoot, 'runs', `${run.runId}.json`), run);
  }
  const indexedRuns = runRecords.map((run) => ({
    runId: run.runId,
    taskId: run.taskId,
    iterationId: run.iterationId,
    status: run.status,
    agentTool: run.agentTool,
    workspaceRef: run.workspaceRef,
    taskGraphRef: run.taskGraphRef,
    runRef: `${run.runId}.json`,
    runKind: run.runKind ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }));
  const taskIds = [...new Set(indexedRuns.map((run) => run.taskId))];
  writeJson(join(artifactRoot, 'runs', 'run-index.json'), {
    schema_version: 'p2a.run_index.v1',
    projectId,
    runs: indexedRuns,
    tasks: taskIds.map((taskId) => {
      const runIds = indexedRuns
        .filter((run) => run.taskId === taskId)
        .map((run) => run.runId);
      return {
        taskId,
        runIds,
        latestRunId: runIds.at(-1) ?? null,
      };
    }),
  });
}

function next(root, args = []) {
  const result = runP2a(['next', '--target', root, '--json', '--contract', 'v2', ...args]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function assertAction(payload, state, kind, argv = null, requiresApproval = null) {
  assert.doesNotThrow(() => validateSchema(payload, NEXT_SCHEMA));
  assert.equal(payload.schema_version, 'p2a.next.v2');
  assert.equal(payload.state, state);
  assert.equal(payload.reasonCode, state);
  assert.equal(payload.command.kind, kind);
  assert.equal(typeof payload.command.display, 'string');
  assert.ok(payload.command.display.length > 0);
  assert.ok('continuation' in payload);
  if (kind === 'cli') {
    assert.ok(Array.isArray(payload.command.argv) && payload.command.argv.length > 0);
    assert.equal(typeof payload.command.requiresApproval, 'boolean');
    if (argv) {
      const expectedArgv = payload.continuation?.activation === 'after_command_success'
        ? [...argv, '--json']
        : argv;
      assert.deepEqual(payload.command.argv, expectedArgv);
    }
    if (requiresApproval !== null) assert.equal(payload.command.requiresApproval, requiresApproval);
  } else {
    assert.equal('argv' in payload.command, false);
    if (kind === 'skill') {
      assert.match(payload.command.skill, /^p2a-/);
      assert.ok(Array.isArray(payload.command.args));
    }
  }
}

function assertReviewOrCloseDecision(payload, artifactRoot) {
  assertAction(payload, 'iteration_review_or_close_required', 'approval');
  assert.match(payload.reason, /explicitly choose review and remediation or close/i);
  assert.deepEqual(payload.command.options.map((option) => option.id), ['review', 'close']);
  const [review, close] = payload.command.options;
  assert.equal(review.action.kind, 'review');
  assert.deepEqual(review.action.remediation.argv, [
    'tasks', 'todo', '--artifacts', artifactRoot, '<task-id>',
    '--reopen', '--note', '<review finding>',
  ]);
  assert.equal(review.action.remediation.requiresApproval, false);
  assert.equal(close.action.kind, 'cli');
  assert.deepEqual(close.action.argv, ['iteration', 'close', '--artifacts', artifactRoot]);
  assert.equal(close.action.requiresApproval, true);
  return { review, close };
}

function artifactPath(root, projectId = 'sample') {
  return join(root, '.plan2agent', 'artifacts', projectId);
}

function copyFixtureFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

function installFixtureArtifact(root, fixtureRoot, projectId, layout) {
  const artifactRoot = artifact(root, projectId);
  const files = layout === 'flat'
    ? [
      ['status.md', 'status.md'],
      ['intake.answered.json', 'gate-a-intake/intake.json'],
      ['spec.approved.json', 'gate-b-spec/spec.json'],
      ['task-graph.json', 'gate-c-task-graph/task-graph.json'],
      ['review.json', 'gate-d-review/review.json'],
    ]
    : [
      ['status.md', 'status.md'],
      ['gate-a-intake/intake.json', 'gate-a-intake/intake.json'],
      ['gate-b-spec/spec.json', 'gate-b-spec/spec.json'],
      ['gate-c-task-graph/task-graph.json', 'gate-c-task-graph/task-graph.json'],
      ['gate-d-review/review.json', 'gate-d-review/review.json'],
    ];
  for (const [source, destination] of files) {
    copyFixtureFile(join(fixtureRoot, source), join(artifactRoot, destination));
  }
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.source_intake = '../gate-a-intake/intake.json';
  writeJson(specPath, spec);

  const taskGraphPath = join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  const taskGraph = JSON.parse(readFileSync(taskGraphPath, 'utf8'));
  taskGraph.sourceSpec = '../gate-b-spec/spec.json';
  writeJson(taskGraphPath, taskGraph);

  const reviewPath = join(artifactRoot, 'gate-d-review', 'review.json');
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  review.sourceSpec = '../gate-b-spec/spec.json';
  review.sourceTaskGraph = '../gate-c-task-graph/task-graph.json';
  writeJson(reviewPath, review);
  return artifactRoot;
}

function snapshotDirectory(root, relative = '') {
  const directory = join(root, relative);
  const snapshot = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, snapshotDirectory(root, entryRelative));
    else if (entry.isFile()) snapshot[entryRelative] = readFileSync(join(root, entryRelative), 'utf8');
  }
  return snapshot;
}

function snapshotHarness(root) {
  const harness = join(root, '.plan2agent');
  return existsSync(harness) ? snapshotDirectory(root, '.plan2agent') : null;
}

function remove(root) {
  rmSync(root, { recursive: true, force: true });
}

test('next chooses one read-only action for every primary state', () => {
  const cases = [
    {
      id: 'uninitialized',
      setup: () => makeTempDir('p2a-next-uninitialized-'),
      expected: (root) => ['uninitialized', 'cli', ['init', '--target', root]],
    },
    {
      id: 'initialized without artifacts',
      setup: () => project(),
      expected: () => ['entry_missing', 'approval'],
    },
    {
      id: 'incomplete iteration',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeJson(join(rootArtifact, 'current-spec.json'), { project_id: 'sample', active_iteration: 'v1' });
        return root;
      },
      expected: (root) => ['incomplete_iteration_layout', 'cli', ['iteration', 'validate', '--artifacts', artifactPath(root)]],
    },
    {
      id: 'gate A approval',
      setup: () => {
        const root = project();
        writeGateA(artifact(root));
        return root;
      },
      expected: () => ['gate_a_needs_approval', 'approval'],
    },
    {
      id: 'gate A ready for spec',
      setup: () => {
        const root = project();
        writeGateA(artifact(root), 'ready_for_spec');
        return root;
      },
      expected: () => ['shape', 'skill'],
    },
    {
      id: 'gate B approval',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact, 'draft');
        return root;
      },
      expected: () => ['gate_b_needs_approval', 'approval'],
    },
    {
      id: 'gate B approved needs tasks',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        return root;
      },
      expected: () => ['gate_b_approved_needs_tasks', 'skill'],
    },
    {
      id: 'validated Gate C needs iteration init',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        writeGateC(rootArtifact, [task('task-001', 'todo')]);
        return root;
      },
      expected: (root) => ['gate_c_validated_needs_iteration_init', 'cli', ['iteration', 'init', '--artifacts', artifactPath(root)]],
    },
    {
      id: 'started run precedes ready task',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        writeRuns(rootArtifact, [{ runId: 'run-001', iterationId, status: 'started' }]);
        return root;
      },
      expected: (root) => ['run_started', 'cli', ['execute', 'resume', '--artifacts', artifactPath(root), '--run-id', 'run-001']],
    },
    {
      id: 'ready task',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        return root;
      },
      expected: (root) => ['ready_task_available', 'cli', ['execute', 'start', '--artifacts', artifactPath(root), '--task', 'task-001']],
    },
    {
      id: 'blocked task',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'blocked'), task('task-002', 'todo', ['task-001'])], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        return root;
      },
      expected: (root) => ['tasks_blocked', 'cli', ['tasks', 'show', '--artifacts', artifactPath(root), 'task-001']],
    },
    {
      id: 'all tasks done require explicit close or review choice',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        return root;
      },
      expected: () => ['iteration_review_or_close_required', 'approval'],
    },
    {
      id: 'all non-UI tasks done require functional acceptance',
      setup: () => {
        const root = project();
        writeJson(join(root, '.plan2agent', 'project.config.json'), {
          devExecution: { reviewPasses: { acceptance: 'on' } },
        });
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        return root;
      },
      expected: (root) => ['final_acceptance_review_required', 'cli', ['execute', 'accept', '--artifacts', artifactPath(root)]],
    },
    {
      id: 'closed iteration mines proposals before opening',
      setup: () => {
        const root = project({ proposals: true });
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        writeRuns(rootArtifact, [{ runId: 'run-001', iterationId, status: 'failed' }]);
        return root;
      },
      expected: (root) => ['run_evidence_needs_proposal_mining', 'cli', [
        'proposals', 'mine', '--artifacts', artifactPath(root), '--run-id', 'run-001',
        '--proposals', join(root, '.plan2agent', 'proposals'),
      ]],
    },
    {
      id: 'failed run mines proposals without requiring a closed iteration',
      setup: () => {
        const root = project({ proposals: true });
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact);
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'in_progress')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        writeRuns(rootArtifact, [{ runId: 'run-001', iterationId, status: 'failed' }]);
        return root;
      },
      expected: (root) => ['run_evidence_needs_proposal_mining', 'cli', [
        'proposals', 'mine', '--artifacts', artifactPath(root), '--run-id', 'run-001',
        '--proposals', join(root, '.plan2agent', 'proposals'),
      ]],
    },
    {
      id: 'closed iteration composes a missing latest baseline source',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeClosedIterationWithCompositionGap(rootArtifact);
        return root;
      },
      expected: (root) => ['iteration_composition_required', 'cli', [
        'iteration', 'compose', '--artifacts', artifactPath(root),
      ]],
    },
    {
      id: 'closed iteration opens the next iteration',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
        writeGateA(rootArtifact, 'ready_for_spec', iterationId);
        writeGateB(rootArtifact, 'approved', iterationId);
        writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
        writeGateD(rootArtifact, [], iterationId);
        return root;
      },
      expected: (root) => ['iteration_complete', 'cli', ['iteration', 'open', '--artifacts', artifactPath(root), '--iteration-id', '<id>', '--idea', '<change idea>']],
    },
  ];

  for (const caseData of cases) {
    const root = caseData.setup();
    try {
      const before = snapshotHarness(root);
      const payload = next(root);
      assertAction(payload, ...caseData.expected(root));
      const after = snapshotHarness(root);
      assert.deepEqual(after, before, `${caseData.id} changed the project state`);
    } finally {
      remove(root);
    }
  }
});

test('completed iterations expose structured review and close options without mutating state', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    const before = snapshotHarness(root);
    assertReviewOrCloseDecision(next(root), artifactPath(root));
    assertReviewOrCloseDecision(next(root), artifactPath(root));
    assert.deepEqual(snapshotHarness(root), before);
    const currentSpec = JSON.parse(readFileSync(join(rootArtifact, 'current-spec.json'), 'utf8'));
    assert.equal(currentSpec.active_iteration, iterationId);
    assert.equal(currentSpec.closed_iterations, undefined);
  } finally {
    remove(root);
  }
});

test('human next output defaults to actionable v2 options while unqualified JSON stays v1', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);

    const human = runP2a(['next', '--target', root]);
    assert.equal(human.status, 0, `${human.stdout}${human.stderr}`);
    assert.match(human.stdout, /state: iteration_review_or_close_required/);
    assert.match(human.stdout, /Options:/);
    assert.match(human.stdout, /Review and remediate \(review\)/);
    assert.match(human.stdout, /Remediation: .*tasks todo .*--reopen.*--note/);
    assert.match(human.stdout, /Remediation approval required: no/);
    assert.match(human.stdout, /Close iteration \(close\)/);
    assert.match(human.stdout, /Action: .*iteration close/);
    assert.match(human.stdout, /Approval required: yes/);

    const legacyResult = runP2a(['next', '--target', root, '--json']);
    assert.equal(legacyResult.status, 0, `${legacyResult.stdout}${legacyResult.stderr}`);
    const legacy = JSON.parse(legacyResult.stdout);
    assert.equal(legacy.schema_version, 'p2a.next.v1');
    assert.equal(legacy.command.kind, 'approval');
    assert.equal('options' in legacy.command, false);
  } finally {
    remove(root);
  }
});

test('the explicit close option archives a completed iteration without an optional review', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    writeRuns(rootArtifact, [{
      runId: 'run-no-review-close',
      iterationId,
      status: 'finished',
      verification: [{
        type: 'test',
        command: 'node --test',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        startedAt: '2026-07-31T00:00:30.000Z',
        finishedAt: '2026-07-31T00:00:31.000Z',
        stdoutTail: null,
        stderrTail: null,
        source: 'command',
      }],
    }]);

    const { close } = assertReviewOrCloseDecision(next(root), artifactPath(root));
    const result = runP2a(close.action.argv);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const metadata = JSON.parse(readFileSync(
      join(rootArtifact, 'iterations', iterationId, 'iteration.json'),
      'utf8',
    ));
    assert.equal(metadata.status, 'archived');
  } finally {
    remove(root);
  }
});

test('audited closed history uses bounded routing without deep provenance or run hydration', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    writeRuns(rootArtifact, Array.from({ length: 42 }, (_, index) => ({
      runId: `run-history-${String(index + 1).padStart(3, '0')}`,
      iterationId,
      status: 'finished',
    })));
    addArchivedArtifactAudits(rootArtifact);

    const result = runP2a([
      'next',
      '--target', root,
      '--json',
      '--contract', 'v2',
      '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'iteration_complete',
      'cli',
      [
        'iteration', 'open',
        '--artifacts', artifactPath(root),
        '--iteration-id', '<id>',
        '--idea', '<change idea>',
      ],
    );
    assert.match(result.stderr, /closed-route:archive-audit/);
    assert.match(result.stderr, /closed-route:ready: iteration complete/);
    assert.doesNotMatch(result.stderr, /artifact:deep-validation/);
    assert.doesNotMatch(result.stderr, /runs:hydrate/);
  } finally {
    remove(root);
  }
});

test('audited closed routing rejects archive tampering before deep provenance replay', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    addArchivedArtifactAudits(rootArtifact);
    const specPath = join(
      rootArtifact,
      'iterations',
      iterationId,
      'gate-b-spec',
      'spec.json',
    );
    writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}\n`);

    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'invalid_iteration_state',
      'cli',
      ['iteration', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(payload.reason, /artifact changed after close/);
    assert.match(result.stderr, /closed-route:invalid/);
    assert.doesNotMatch(result.stderr, /artifact:deep-validation/);
  } finally {
    remove(root);
  }
});

test('audited closed routing rejects incomplete artifact hash coverage', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    addArchivedArtifactAudits(rootArtifact);
    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.closed_iterations[0].artifact_hashes = {};
    currentSpec.last_closed_iteration.artifact_hashes = {};
    writeJson(currentSpecPath, currentSpec);

    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'invalid_iteration_state',
      'cli',
      ['iteration', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(payload.reason, /artifact_hashes is missing required reference/);
    assert.match(result.stderr, /closed-route:invalid/);
  } finally {
    remove(root);
  }
});

test('audited closed routing preserves acceptance review evidence validation', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeRuns(rootArtifact, [{
      runId: 'run-acceptance-review',
      iterationId,
      status: 'finished',
      runKind: 'final_acceptance_review',
    }]);
    addArchivedArtifactAudits(rootArtifact);

    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'invalid_run_evidence',
      'cli',
      ['runs', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(result.stderr, /closed-route:fallback: active review run/);
    assert.match(result.stderr, /artifact:deep-validation/);
    assert.match(result.stderr, /runs:hydrate/);
  } finally {
    remove(root);
  }
});

test('audited closed routing rejects declared runKind drift for an active review run', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeRuns(rootArtifact, [{
      runId: 'run-acceptance-review',
      iterationId,
      status: 'finished',
      runKind: 'final_acceptance_review',
    }]);
    addArchivedArtifactAudits(rootArtifact);

    const runIndexPath = join(rootArtifact, 'runs', 'run-index.json');
    const runIndex = JSON.parse(readFileSync(runIndexPath, 'utf8'));
    runIndex.runs[0].runKind = null;
    writeJson(runIndexPath, runIndex);

    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'invalid_iteration_state',
      'cli',
      ['validate', '--runs-dir', join(rootArtifact, 'runs')],
    );
    assert.match(payload.reason, /runKind does not match its run file/);
    assert.match(result.stderr, /closed-route:invalid/);
    assert.doesNotMatch(result.stderr, /artifact:deep-validation/);

    writeRuns(rootArtifact, [{
      runId: 'run-regular',
      iterationId,
      status: 'finished',
    }]);
    const validatorIndex = JSON.parse(readFileSync(runIndexPath, 'utf8'));
    validatorIndex.runs[0].runKind = 'final_acceptance_review';
    writeJson(runIndexPath, validatorIndex);
    const validation = runP2a([
      'validate', '--runs-dir', join(rootArtifact, 'runs'),
    ]);
    assert.notEqual(validation.status, 0);
    assert.match(`${validation.stdout}${validation.stderr}`, /runKind does not match run file/);
  } finally {
    remove(root);
  }
});

test('BuildLore-shaped 11-iteration history stays within a generous routing bound', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const { activeIteration } = writeBuildLoreShapedClosedHistory(rootArtifact);
    writeRuns(rootArtifact, Array.from({ length: 42 }, (_, index) => ({
      runId: `run-history-${String(index + 1).padStart(3, '0')}`,
      iterationId: 'v1',
      status: 'finished',
    })));

    const startedAt = performance.now();
    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    const durationMs = performance.now() - startedAt;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assertAction(
      JSON.parse(result.stdout),
      'iteration_complete',
      'cli',
      [
        'iteration', 'open', '--artifacts', artifactPath(root),
        '--iteration-id', '<id>', '--idea', '<change idea>',
      ],
    );
    assert.ok(durationMs < 5_000, `closed routing took ${durationMs.toFixed(1)}ms`);
    assert.match(result.stderr, /closed-route:archive-audit: 11 iteration\(s\)/);
    assert.doesNotMatch(result.stderr, /artifact:deep-validation/);
    assert.doesNotMatch(result.stderr, /runs:hydrate/);
    assert.equal(activeIteration, 'v11');
  } finally {
    remove(root);
  }
});

test('audited closed routing rejects semantic composition drift and extra sources', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    writeBuildLoreShapedClosedHistory(rootArtifact);
    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.effective_product.problem = 'Drifted effective product problem.';
    writeJson(currentSpecPath, currentSpec);

    const semanticResult = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(semanticResult.status, 0, `${semanticResult.stdout}${semanticResult.stderr}`);
    const semanticPayload = JSON.parse(semanticResult.stdout);
    assertAction(
      semanticPayload,
      'invalid_iteration_state',
      'cli',
      ['iteration', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(semanticPayload.reason, /effective sections must exactly match/);
    assert.match(semanticResult.stderr, /closed-route:composition/);
    assert.match(semanticResult.stderr, /closed-route:invalid/);
    assert.doesNotMatch(semanticResult.stderr, /artifact:deep-validation/);

    const extraSourceSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    extraSourceSpec.effective_product = JSON.parse(readFileSync(
      join(rootArtifact, 'iterations', 'v11', 'gate-b-spec', 'spec.json'),
      'utf8',
    )).product;
    extraSourceSpec.source_specs.push({
      iteration_id: 'v12-extra',
      spec_ref: 'iterations/v12-extra/gate-b-spec/spec.json',
      status: 'archived',
      approval: 'approved',
    });
    extraSourceSpec.composed_from.push('v12-extra');
    writeJson(currentSpecPath, extraSourceSpec);

    const extraResult = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(extraResult.status, 0, `${extraResult.stdout}${extraResult.stderr}`);
    const extraPayload = JSON.parse(extraResult.stdout);
    assertAction(
      extraPayload,
      'invalid_iteration_state',
      'cli',
      ['iteration', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(extraPayload.reason, /not closed: v12-extra/);
  } finally {
    remove(root);
  }
});

test('BuildLore-shaped composed fallback reuses validation within a bounded request', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const { activeIteration, iterationIds } = writeBuildLoreShapedClosedHistory(rootArtifact);
    addComposedBaselineHistory(rootArtifact, iterationIds);
    writeRuns(rootArtifact, [{
      runId: 'run-active-failed',
      iterationId: activeIteration,
      status: 'failed',
    }]);

    const startedAt = performance.now();
    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    const durationMs = performance.now() - startedAt;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(durationMs < 5_000, `composed fallback took ${durationMs.toFixed(1)}ms`);
    assert.match(result.stderr, /closed-route:fallback: active run/);
    assert.match(result.stderr, /artifact:deep-validation/);

    const activeIntakePath = join(
      rootArtifact,
      'iterations',
      activeIteration,
      'gate-a-intake',
      'intake.json',
    );
    const deepSession = createValidationSession();
    validateIntake(activeIntakePath, {
      artifactRoot: rootArtifact,
      requireBaselineContextArtifactRoot: true,
      validationSession: deepSession,
    });
    assert.equal(deepSession.stats.validatorRuns.intake, 11);
    assert.equal(deepSession.stats.validatorRuns.spec, 10);
    assert.equal(deepSession.stats.validatorRuns['task-graph'], 10);
  } finally {
    remove(root);
  }
});

test('run-index relation validation does not rescan every run for each task', () => {
  const recordCount = 4_000;
  const runs = Array.from({ length: recordCount }, (_, index) => {
    const taskId = `task-${index + 1}`;
    const runId = `run-linear-${index + 1}`;
    return {
      runId,
      taskId,
      iterationId: 'v1',
      status: 'finished',
      agentTool: 'codex',
      workspaceRef: 'fixture-workspace',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      runRef: `v1/${runId}.json`,
      startedAt: '2026-07-31T00:00:00.000Z',
      finishedAt: '2026-07-31T00:01:00.000Z',
    };
  });
  let runFilterCalls = 0;
  const observedRuns = new Proxy(runs, {
    get(target, property, receiver) {
      if (property === 'filter') {
        return (...args) => {
          runFilterCalls += 1;
          return Array.prototype.filter.apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const startedAt = performance.now();
  validateRunIndexData({
    schema_version: 'p2a.run_index.v1',
    projectId: 'sample',
    runs: observedRuns,
    tasks: runs.map((run) => ({
      taskId: run.taskId,
      runIds: [run.runId],
      latestRunId: run.runId,
    })),
  });
  const durationMs = performance.now() - startedAt;
  assert.equal(runFilterCalls, 0);
  assert.ok(durationMs < 2_000, `run-index validation took ${durationMs.toFixed(1)}ms`);
});

test('ValidationSession caches each unique validator and JSON read by content SHA', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    const intakePath = join(
      rootArtifact,
      'iterations',
      iterationId,
      'gate-a-intake',
      'intake.json',
    );
    const specPath = join(
      rootArtifact,
      'iterations',
      iterationId,
      'gate-b-spec',
      'spec.json',
    );
    const taskGraphPath = join(
      rootArtifact,
      'iterations',
      iterationId,
      'gate-c-task-graph',
      'task-graph.json',
    );
    const validationSession = createValidationSession();
    const options = { artifactRoot: rootArtifact, validationSession };

    validateTaskGraph(taskGraphPath, specPath, options);
    validateTaskGraph(taskGraphPath, specPath, options);
    validateSpec(specPath, intakePath, options);
    validateIntake(intakePath, options);

    assert.equal(validationSession.stats.validatorRuns['task-graph'], 1);
    assert.equal(validationSession.stats.validatorRuns.spec, 1);
    assert.equal(validationSession.stats.validatorRuns.intake, 1);
    assert.equal(validationSession.stats.fileReads, 3);
    assert.equal(validationSession.stats.jsonParses, 3);
    for (const key of validationSession.artifactValidations.keys()) {
      assert.match(key.split('\n')[2], /^[a-f0-9]{64}$/);
    }

    writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}\n`, 'utf8');
    validateSpec(specPath, intakePath, options);
    assert.equal(validationSession.stats.validatorRuns.spec, 2);
    assert.equal(validationSession.stats.fileReads, 4);
    assert.equal(validationSession.stats.jsonParses, 4);
  } finally {
    remove(root);
  }
});

test('iteration open rechecks audited archive hashes before mutation', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    addArchivedArtifactAudits(rootArtifact);
    writeFileSync(
      join(rootArtifact, 'iterations', iterationId, 'gate-b-spec', 'product-spec.md'),
      '# appeared after close\n',
      'utf8',
    );

    const result = runP2a([
      'iteration', 'open', '--artifacts', rootArtifact,
      '--iteration-id', 'v2', '--idea', 'Open only from an immutable archive',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact appeared after close/);
    assert.equal(existsSync(join(rootArtifact, 'iterations', 'v2')), false);
  } finally {
    remove(root);
  }
});

test('audited closed routing falls back when an active failed run needs proposal evidence', () => {
  const root = project({ proposals: true });
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeRuns(rootArtifact, [{
      runId: 'run-audited-failure',
      iterationId,
      status: 'failed',
    }]);
    addArchivedArtifactAudits(rootArtifact);

    const result = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assertAction(
      payload,
      'run_evidence_needs_proposal_mining',
      'cli',
      [
        'proposals', 'mine',
        '--artifacts', artifactPath(root),
        '--run-id', 'run-audited-failure',
        '--proposals', join(root, '.plan2agent', 'proposals'),
      ],
    );
    assert.match(result.stderr, /closed-route:fallback: active run/);
    assert.match(result.stderr, /artifact:deep-validation/);
    assert.match(result.stderr, /runs:hydrate/);
  } finally {
    remove(root);
  }
});

test('audited closed routing detects composition gaps and rejects malformed composition metadata', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    writeClosedIterationWithCompositionGap(rootArtifact);
    addArchivedArtifactAudits(rootArtifact);

    const gapResult = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(gapResult.status, 0, `${gapResult.stdout}${gapResult.stderr}`);
    assertAction(
      JSON.parse(gapResult.stdout),
      'iteration_composition_required',
      'cli',
      ['iteration', 'compose', '--artifacts', artifactPath(root)],
    );
    assert.match(gapResult.stderr, /closed-route:ready: composition required/);
    assert.doesNotMatch(gapResult.stderr, /artifact:deep-validation/);

    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.source_specs[0].spec_ref = 'iterations/wrong/gate-b-spec/spec.json';
    writeJson(currentSpecPath, currentSpec);

    const invalidResult = runP2a([
      'next', '--target', root, '--json', '--contract', 'v2', '--trace',
    ]);
    assert.equal(
      invalidResult.status,
      0,
      `${invalidResult.stdout}${invalidResult.stderr}`,
    );
    const invalidPayload = JSON.parse(invalidResult.stdout);
    assertAction(
      invalidPayload,
      'invalid_iteration_state',
      'cli',
      ['iteration', 'validate', '--artifacts', artifactPath(root)],
    );
    assert.match(invalidPayload.reason, /spec_ref must be/);
  } finally {
    remove(root);
  }
});

test('next, compose, and open agree when archived iteration metadata is reopened', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);

    const metadataPath = join(rootArtifact, 'iterations', iterationId, 'iteration.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.status = 'gate_b_approved';
    writeJson(metadataPath, metadata);
    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const statusPath = join(rootArtifact, 'status.md');
    const before = {
      currentSpec: readFileSync(currentSpecPath),
      metadata: readFileSync(metadataPath),
      status: readFileSync(statusPath),
    };

    const payload = next(root);
    assertAction(payload, 'invalid_iteration_state', 'cli', [
      'iteration', 'validate', '--artifacts', artifactPath(root),
    ]);
    assert.match(payload.reason, /archive consistency requires .* status archived/);

    for (const command of [
      payload.command.argv,
      ['iteration', 'compose', '--artifacts', artifactPath(root)],
      [
        'iteration', 'open', '--artifacts', artifactPath(root),
        '--iteration-id', 'v2', '--idea', 'Continue after the archived baseline',
      ],
    ]) {
      const result = runP2a(command);
      assert.notEqual(result.status, 0, command.join(' '));
      assert.match(`${result.stdout}${result.stderr}`, /archive consistency requires .* status archived/);
    }

    assert.deepEqual(readFileSync(currentSpecPath), before.currentSpec);
    assert.deepEqual(readFileSync(metadataPath), before.metadata);
    assert.deepEqual(readFileSync(statusPath), before.status);
  } finally {
    remove(root);
  }
});

test('next, compose, and open reject pending planning state on an archived active iteration', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);

    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.pending_iteration = {
      iteration_id: iterationId,
      status: 'gate_b_approved',
    };
    writeJson(currentSpecPath, currentSpec);
    const metadataPath = join(rootArtifact, 'iterations', iterationId, 'iteration.json');
    const statusPath = join(rootArtifact, 'status.md');
    const before = {
      currentSpec: readFileSync(currentSpecPath),
      metadata: readFileSync(metadataPath),
      status: readFileSync(statusPath),
    };

    const payload = next(root);
    assertAction(payload, 'invalid_iteration_state', 'cli', [
      'iteration', 'validate', '--artifacts', artifactPath(root), '--allow-planning',
    ]);
    assert.match(payload.reason, /pending_iteration to be absent for archived active iteration/);

    for (const command of [
      payload.command.argv,
      ['iteration', 'compose', '--artifacts', artifactPath(root)],
      [
        'iteration', 'open', '--artifacts', artifactPath(root),
        '--iteration-id', 'v2', '--idea', 'Continue after the archived baseline',
      ],
    ]) {
      const result = runP2a(command);
      assert.notEqual(result.status, 0, command.join(' '));
      assert.match(
        `${result.stdout}${result.stderr}`,
        /pending_iteration to be absent for archived active iteration/,
      );
    }

    assert.deepEqual(readFileSync(currentSpecPath), before.currentSpec);
    assert.deepEqual(readFileSync(metadataPath), before.metadata);
    assert.deepEqual(readFileSync(statusPath), before.status);
  } finally {
    remove(root);
  }
});

test('next enters Gate A for baseline-backed Gate A entry states', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const activeIteration = writeBaselineBackedPlanningIteration(rootArtifact);
    const entryPath = join(root, 'idea.md');
    writeFileSync(entryPath, 'Build the next baseline-backed project capability.\n', 'utf8');

    const withEntry = buildNext(root, null, 'idea.md', 'v2');
    assertAction(withEntry, 'gate_what', 'skill');
    assert.equal(withEntry.command.skill, 'p2a-harness');
    assert.deepEqual(withEntry.command.args, ['--entry', entryPath]);

    const withoutEntry = buildNext(root, null, null, 'v2');
    assertAction(withoutEntry, 'entry_missing', 'approval');
    assert.match(withoutEntry.reason, new RegExp(activeIteration));
    assert.match(withoutEntry.command.display, /p2a next --entry <path>/);

    const invalidEntry = buildNext(root, null, 'missing.md', 'v2');
    assertAction(invalidEntry, 'entry_invalid', 'approval');
    assert.match(invalidEntry.command.display, /validate --entry .*missing\.md/);

    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.pending_iteration.status = 'gate_a_interview';
    writeJson(currentSpecPath, currentSpec);
    const metadataPath = join(
      rootArtifact,
      'iterations',
      activeIteration,
      'iteration.json',
    );
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.status = 'gate_a_interview';
    writeJson(metadataPath, metadata);

    const resumedInterview = buildNext(root, null, 'idea.md', 'v2');
    assertAction(resumedInterview, 'gate_what', 'skill');
    assert.equal(resumedInterview.command.skill, 'p2a-harness');

    const interviewWithoutEntry = buildNext(root, null, null, 'v2');
    assertAction(interviewWithoutEntry, 'entry_missing', 'approval');

    writeJson(
      join(rootArtifact, 'iterations', activeIteration, 'gate-b-spec', 'spec.json'),
      { schema_version: 'p2a.spec.v1' },
    );
    const downstreamState = buildNext(root, null, 'idea.md', 'v2');
    assertAction(downstreamState, 'invalid_gate_a', 'cli');
  } finally {
    remove(root);
  }
});

test('next validates a planning baseline before entering Gate A', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    writeBaselineBackedPlanningIteration(rootArtifact);
    const entryPath = join(root, 'idea.md');
    writeFileSync(entryPath, 'Build the next baseline-backed project capability.\n', 'utf8');
    writeJson(
      join(rootArtifact, 'iterations', 'v1-mvp', 'gate-b-spec', 'spec.json'),
      { schema_version: 'p2a.spec.v1', tampered: true },
    );

    const payload = buildNext(root, null, 'idea.md', 'v2');
    assertAction(payload, 'invalid_iteration_state', 'cli', [
      'iteration',
      'validate',
      '--artifacts',
      rootArtifact,
      '--allow-planning',
    ]);
    assert.match(payload.reason, /pending baseline hash does not match/);

    const validation = runP2a(payload.command.argv);
    assert.notEqual(validation.status, 0);
    assert.match(
      `${validation.stdout}${validation.stderr}`,
      /pending baseline hash does not match/,
    );
  } finally {
    remove(root);
  }
});

test('next rejects invalid pending iteration identity before entering Gate A', () => {
  const cases = [
    {
      mutate: (pending) => { pending.status = 'unexpected'; },
      error: /pending_iteration\.status is not a planning status/,
    },
    {
      mutate: (pending) => { pending.iteration_id = 'v9-other'; },
      error: /pending_iteration\.iteration_id must match active_iteration/,
    },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      writeBaselineBackedPlanningIteration(rootArtifact);
      writeFileSync(
        join(root, 'idea.md'),
        'Build the next baseline-backed project capability.\n',
        'utf8',
      );
      const currentSpecPath = join(rootArtifact, 'current-spec.json');
      const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
      caseData.mutate(currentSpec.pending_iteration);
      writeJson(currentSpecPath, currentSpec);

      const payload = buildNext(root, null, 'idea.md', 'v2');
      assertAction(payload, 'invalid_iteration_state', 'cli', [
        'iteration',
        'validate',
        '--artifacts',
        rootArtifact,
        '--allow-planning',
      ]);
      assert.match(payload.reason, caseData.error);
    } finally {
      remove(root);
    }
  }
});

test('next preserves decision and run safety states before entering iteration Gate A', () => {
  const invalidDecisionRoot = project();
  const startedRunRoot = project();
  try {
    const invalidDecisionArtifact = artifact(invalidDecisionRoot);
    writeBaselineBackedPlanningIteration(invalidDecisionArtifact);
    writeFileSync(
      join(invalidDecisionRoot, 'idea.md'),
      'Build the next baseline-backed project capability.\n',
      'utf8',
    );
    writeFileSync(
      join(invalidDecisionArtifact, 'decisions.jsonl'),
      '{ invalid decision ledger\n',
      'utf8',
    );
    const invalidDecision = buildNext(
      invalidDecisionRoot,
      null,
      'idea.md',
      'v2',
    );
    assertAction(invalidDecision, 'invalid_decisions', 'cli', [
      'validate',
      '--decisions',
      '--artifacts',
      invalidDecisionArtifact,
    ]);

    const startedRunArtifact = artifact(startedRunRoot);
    const activeIteration = writeBaselineBackedPlanningIteration(startedRunArtifact);
    writeFileSync(
      join(startedRunRoot, 'idea.md'),
      'Build the next baseline-backed project capability.\n',
      'utf8',
    );
    writeRuns(startedRunArtifact, [{
      runId: 'run-before-gate-a',
      iterationId: activeIteration,
      status: 'started',
    }]);
    const startedRun = buildNext(startedRunRoot, null, 'idea.md', 'v2');
    assertAction(startedRun, 'started_run_contract_drift', 'approval');
  } finally {
    remove(invalidDecisionRoot);
    remove(startedRunRoot);
  }
});

test('next preserves canonical root gate fallback before entering iteration Gate A', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    writeBaselineBackedPlanningIteration(rootArtifact);
    writeFileSync(
      join(root, 'idea.md'),
      'Build the next baseline-backed project capability.\n',
      'utf8',
    );
    writeJson(join(rootArtifact, 'gate-a-intake', 'intake.json'), {
      schema_version: 'p2a.intake.v1',
    });

    const payload = buildNext(root, null, 'idea.md', 'v2');
    assertAction(payload, 'invalid_gate_a', 'cli', [
      'iteration',
      'validate',
      '--artifacts',
      rootArtifact,
      '--allow-planning',
      '--stage',
      'gate-a',
    ]);
  } finally {
    remove(root);
  }
});

test('next carries the original entry into a new Gate A approval command', () => {
  const root = project();
  try {
    writeGateA(artifact(root));
    const entryPath = join(root, 'idea.md');
    writeFileSync(entryPath, 'Build the approved sample workflow from this entry document.\n', 'utf8');

    const withoutEntry = next(root);
    assertAction(withoutEntry, 'gate_a_needs_approval', 'approval');
    assert.match(withoutEntry.command.display, /p2a next --entry <original-entry-path>/);

    const withEntry = next(root, ['--entry', 'idea.md']);
    assertAction(withEntry, 'gate_a_needs_approval', 'approval');
    assert.ok(withEntry.command.display.includes(`--entry ${JSON.stringify(entryPath)}`));
  } finally {
    remove(root);
  }
});

test('next routes Gate A approval through Gate ② and reuses approved or legacy style contracts', () => {
  const missingRoot = project();
  const draftRoot = project();
  const approvedRoot = project();
  const legacyRoot = project();
  const invalidRoot = project();
  const mismatchedRoot = project();
  try {
    writeGateA(artifact(missingRoot), 'ready_for_spec');
    assertAction(next(missingRoot), 'shape', 'skill');

    writeGateA(artifact(draftRoot), 'ready_for_spec');
    writeConstitution(draftRoot, 'sample', false);
    assertAction(next(draftRoot), 'shape', 'approval');

    writeGateA(artifact(approvedRoot), 'ready_for_spec');
    writeConstitution(approvedRoot);
    assertAction(next(approvedRoot), 'gate_a_ready_for_spec', 'skill');

    writeGateA(artifact(legacyRoot), 'ready_for_spec');
    writeFileSync(join(legacyRoot, '.plan2agent', 'style.md'), '# Legacy style\n', 'utf8');
    assertAction(next(legacyRoot), 'gate_a_ready_for_spec', 'skill');

    writeGateA(artifact(invalidRoot), 'ready_for_spec');
    writeJson(join(invalidRoot, '.plan2agent', 'constitution.json'), { schema_version: 'wrong' });
    const invalid = next(invalidRoot);
    assertAction(invalid, 'invalid_constitution', 'cli', [
      'validate',
      '--constitution',
      join(invalidRoot, '.plan2agent', 'constitution.json'),
    ]);

    writeGateA(artifact(mismatchedRoot), 'ready_for_spec');
    writeConstitution(mismatchedRoot, 'different-project');
    const mismatched = next(mismatchedRoot);
    assert.equal(mismatched.state, 'invalid_constitution');
    assert.match(mismatched.reason, /does not match selected project/);
  } finally {
    for (const root of [
      missingRoot,
      draftRoot,
      approvedRoot,
      legacyRoot,
      invalidRoot,
      mismatchedRoot,
    ]) remove(root);
  }
});

test('next blocks downstream work when Gate A is missing, unreadable, or invalid', () => {
  for (const variant of ['missing', 'unreadable', 'invalid']) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      if (variant === 'unreadable') {
        const intakePath = join(rootArtifact, 'gate-a-intake', 'intake.json');
        mkdirSync(dirname(intakePath), { recursive: true });
        writeFileSync(intakePath, '{ invalid json\n', 'utf8');
      } else if (variant === 'invalid') {
        writeGateA(rootArtifact, 'ready_for_spec');
        const intakePath = join(rootArtifact, 'gate-a-intake', 'intake.json');
        const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
        delete intake.summary;
        writeJson(intakePath, intake);
      }
      writeGateB(rootArtifact);
      writeGateC(rootArtifact, [task('task-001', 'todo')]);
      writeGateD(rootArtifact);

      assertAction(
        next(root),
        'invalid_gate_a',
        'cli',
        ['validate', '--artifact-root', rootArtifact],
      );
    } finally {
      remove(root);
    }
  }
});

test('next routes an unreadable or invalid Gate A to recovery without downstream artifacts', () => {
  for (const variant of ['unreadable', 'invalid']) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      const intakePath = join(rootArtifact, 'gate-a-intake', 'intake.json');
      if (variant === 'unreadable') {
        mkdirSync(dirname(intakePath), { recursive: true });
        writeFileSync(intakePath, '{ invalid json\n', 'utf8');
      } else {
        writeGateA(rootArtifact, 'ready_for_spec');
        const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
        delete intake.summary;
        writeJson(intakePath, intake);
      }

      assertAction(
        next(root),
        'invalid_gate_a',
        'cli',
        ['validate', '--artifact-root', rootArtifact],
      );
    } finally {
      remove(root);
    }
  }
});

test('next recommends and runs the iterative Gate A validator for an invalid active intake', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = 'iter-002';
    writeJson(join(rootArtifact, 'current-spec.json'), {
      schema_version: 'p2a.current_spec.v1',
      project_id: 'sample',
      active_iteration: iterationId,
      pending_iteration: {
        iteration_id: iterationId,
        status: 'active_planning',
      },
    });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    const intakePath = join(
      rootArtifact,
      'iterations',
      iterationId,
      'gate-a-intake',
      'intake.json',
    );
    const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
    delete intake.summary;
    writeJson(intakePath, intake);

    const payload = next(root);
    const expectedCommand = [
      'iteration',
      'validate',
      '--artifacts',
      rootArtifact,
      '--allow-planning',
      '--stage',
      'gate-a',
    ];
    assertAction(payload, 'invalid_gate_a', 'cli', expectedCommand);

    const validation = runP2a(payload.command.argv);
    assert.notEqual(validation.status, 0);
    assert.match(
      `${validation.stdout}${validation.stderr}`,
      /\$ missing required keys: summary/,
    );
  } finally {
    remove(root);
  }
});

test('next routes an unreadable or structurally invalid current spec to iteration recovery', () => {
  for (const variant of ['unreadable', 'missing-active-iteration']) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      mkdirSync(join(rootArtifact, 'iterations', 'iter-002'), { recursive: true });
      const currentSpecPath = join(rootArtifact, 'current-spec.json');
      if (variant === 'unreadable') {
        writeFileSync(currentSpecPath, '{ invalid json\n', 'utf8');
      } else {
        writeJson(currentSpecPath, {
          schema_version: 'p2a.current_spec.v1',
          project_id: 'sample',
        });
      }

      const payload = next(root);
      const expectedCommand = [
        'iteration',
        'validate',
        '--artifacts',
        rootArtifact,
      ];
      assertAction(payload, 'invalid_iteration_state', 'cli', expectedCommand);

      const validation = runP2a(payload.command.argv);
      assert.notEqual(validation.status, 0);
      assert.match(
        `${validation.stdout}${validation.stderr}`,
        variant === 'unreadable'
          ? /JSON at position/
          : /active_iteration must be a non-empty string/,
      );
    } finally {
      remove(root);
    }
  }
});

test('next routes full iteration readiness failures before recommending task execution', () => {
  const cases = [
    {
      id: 'invalid composition',
      mutate: (currentSpec) => {
        currentSpec.effective_spec_ref = 'current-spec.json';
      },
      error: /current-spec\.json source_specs must be a non-empty array for composition/,
    },
    {
      id: 'project mismatch',
      mutate: (currentSpec) => {
        currentSpec.project_id = 'other-project';
      },
      error: /spec\.project_id .* to match current-spec\.json project_id/,
    },
    {
      id: 'missing project identity',
      mutate: (currentSpec) => {
        delete currentSpec.project_id;
      },
      error: /current-spec\.json project_id must be a non-empty string/,
    },
    {
      id: 'stale pending baseline',
      allowPlanning: true,
      mutate: (currentSpec, iterationId) => {
        currentSpec.pending_iteration = {
          iteration_id: iterationId,
          status: 'gate_d_passed',
          baseline_iteration: 'v0',
          baseline_effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
        };
      },
      error: /iteration metadata baseline iteration null must match pending baseline iteration "v0"/,
    },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      const iterationId = writeIteration(rootArtifact);
      writeGateA(rootArtifact, 'ready_for_spec', iterationId);
      writeGateB(rootArtifact, 'approved', iterationId);
      writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
      writeGateD(rootArtifact, [], iterationId);

      const currentSpecPath = join(rootArtifact, 'current-spec.json');
      const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
      caseData.mutate(currentSpec, iterationId);
      writeJson(currentSpecPath, currentSpec);

      const payload = next(root);
      assertAction(payload, 'invalid_iteration_state', 'cli', [
        'iteration',
        'validate',
        '--artifacts',
        rootArtifact,
        ...(caseData.allowPlanning ? ['--allow-planning'] : []),
      ]);
      assert.match(payload.reason, caseData.error);

      const validation = runP2a(payload.command.argv);
      assert.notEqual(validation.status, 0, caseData.id);
      assert.match(
        `${validation.stdout}${validation.stderr}`,
        caseData.error,
      );
    } finally {
      remove(root);
    }
  }
});

test('next rejects invalid Gate B and Gate C artifacts before downstream work', () => {
  const cases = [
    {
      state: 'invalid_gate_b',
      setup: (rootArtifact) => {
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        const specPath = join(rootArtifact, 'gate-b-spec', 'spec.json');
        const spec = JSON.parse(readFileSync(specPath, 'utf8'));
        delete spec.product.problem;
        writeJson(specPath, spec);
      },
      error: /\$\.product missing required keys: problem/,
    },
    {
      state: 'invalid_gate_c',
      setup: (rootArtifact) => {
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        writeGateC(rootArtifact, [task('task-001', 'todo')]);
        const graphPath = join(
          rootArtifact,
          'gate-c-task-graph',
          'task-graph.json',
        );
        const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
        delete graph.tasks[0].title;
        writeJson(graphPath, graph);
      },
      error: /\$\.tasks\[0\] missing required keys: title/,
    },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      caseData.setup(rootArtifact);
      const payload = next(root);
      assertAction(payload, caseData.state, 'cli');

      const validation = runP2a(payload.command.argv);
      assert.notEqual(validation.status, 0);
      assert.match(
        `${validation.stdout}${validation.stderr}`,
        caseData.error,
      );
    } finally {
      remove(root);
    }
  }
});

test('next requires a project id only when multiple artifact roots are ambiguous', () => {
  const root = project();
  try {
    const first = artifact(root, 'first');
    const second = artifact(root, 'second');
    writeGateA(first, 'ready_for_spec');
    writeGateA(second, 'ready_for_spec');

    const ambiguous = next(root);
    assertAction(ambiguous, 'project_selection_required', 'cli', ['next', '--project-id', '<project-id>']);

    const selected = next(root, ['--project-id', 'second']);
    assertAction(selected, 'shape', 'skill');
    assert.equal(selected.projectId, 'second');
  } finally {
    remove(root);
  }
});

test('next ignores open runs outside the active iteration task-graph context', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { iterationId: 'v2' });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    writeRuns(rootArtifact, [
      { runId: 'run-v1', iterationId: 'v1', status: 'started' },
      {
        runId: 'run-v2-unrelated-graph',
        iterationId,
        sourceLayout: 'graph',
        taskGraphRef: '/tmp/unrelated-task-graph.json',
        status: 'started',
      },
    ]);

    const payload = next(root);
    assertAction(payload, 'ready_task_available', 'cli', ['execute', 'start', '--artifacts', artifactPath(root), '--task', 'task-001']);
  } finally {
    remove(root);
  }
});

test('next points Gate B approval at the active iteration and ignores legacy Gate D blockers', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { iterationId: 'v2' });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'draft', iterationId);

    let payload = next(root);
    assertAction(payload, 'gate_b_needs_approval', 'approval');
    assert.ok(payload.command.display.includes(
      join(rootArtifact, 'iterations', iterationId, 'gate-b-spec', 'spec.json'),
    ));

    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
    writeGateD(rootArtifact, [{ id: 'BLOCK-1' }], iterationId);

    payload = next(root);
    assertAction(payload, 'ready_task_available', 'cli');
  } finally {
    remove(root);
  }
});

test('next mines a failed run only once before opening a closed iteration', () => {
  const root = project({ proposals: true });
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { closed: true });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'done')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    writeRuns(rootArtifact, [{ runId: 'run-001', iterationId, status: 'failed' }]);

    assertAction(next(root), 'run_evidence_needs_proposal_mining', 'cli', [
      'proposals', 'mine', '--artifacts', artifactPath(root), '--run-id', 'run-001',
      '--proposals', join(root, '.plan2agent', 'proposals'),
    ], true);

    writeJson(join(root, '.plan2agent', 'proposals', 'proposal-run-001.json'), {
      sourceRunId: 'run-001',
    });

    assertAction(next(root), 'iteration_complete', 'cli', [
      'iteration', 'open', '--artifacts', artifactPath(root), '--iteration-id', '<id>', '--idea', '<change idea>',
    ]);
  } finally {
    remove(root);
  }
});

test('next mines flat handoff run evidence before reporting execution complete', () => {
  const root = project({ mode: 'handoff', proposals: true });
  try {
    const rootArtifact = artifact(root);
    writeGateA(rootArtifact, 'ready_for_spec');
    writeGateB(rootArtifact, 'approved');
    writeGateC(rootArtifact, [task('task-001', 'done')]);
    writeGateD(rootArtifact);
    writeRuns(rootArtifact, [{ runId: 'run-001', status: 'failed' }]);

    assertAction(next(root), 'run_evidence_needs_proposal_mining', 'cli', [
      'proposals', 'mine', '--artifacts', artifactPath(root), '--run-id', 'run-001',
      '--proposals', join(root, '.plan2agent', 'proposals'),
    ], true);

    writeJson(join(root, '.plan2agent', 'proposals', 'proposal-run-001.json'), {
      sourceRunId: 'run-001',
    });

    assertAction(next(root), 'flat_execution_complete', 'approval');
  } finally {
    remove(root);
  }
});

test('next reports flat execution complete when proposal mining is disabled', () => {
  const root = project({ mode: 'handoff' });
  try {
    const rootArtifact = artifact(root);
    writeGateA(rootArtifact, 'ready_for_spec');
    writeGateB(rootArtifact, 'approved');
    writeGateC(rootArtifact, [task('task-001', 'done')]);
    writeGateD(rootArtifact);
    writeRuns(rootArtifact, [{ runId: 'run-001', status: 'failed' }]);

    const payload = next(root);
    assertAction(payload, 'flat_execution_complete', 'approval');
    assert.equal(JSON.stringify(payload).includes('"--proposals",null'), false);
  } finally {
    remove(root);
  }
});

test('next routes missing run evidence to an executable validation command', () => {
  const root = project({ mode: 'handoff', proposals: true });
  try {
    const rootArtifact = artifact(root);
    writeGateA(rootArtifact, 'ready_for_spec');
    writeGateB(rootArtifact, 'approved');
    writeGateC(rootArtifact, [task('task-001', 'done')]);
    writeGateD(rootArtifact);
    writeRuns(rootArtifact, [{ runId: 'run-001', status: 'failed' }]);
    rmSync(join(rootArtifact, 'runs', 'run-001.json'));

    const payload = next(root);
    assertAction(payload, 'invalid_run_evidence', 'cli', [
      'runs', 'validate', '--artifacts', artifactPath(root),
    ]);

    const validation = runP2a(payload.command.argv);
    assert.notEqual(validation.status, 0);
    assert.match(
      `${validation.stdout}${validation.stderr}`,
      /run-001\.json.*missing|missing.*run-001\.json/,
    );
    assertAction(next(root), 'invalid_run_evidence', 'cli', payload.command.argv);
  } finally {
    remove(root);
  }
});

test('info keeps its JSON contract and points human output to next', () => {
  const root = project();
  try {
    const infoJson = runP2a(['info', '--target', root, '--json']);
    assert.equal(infoJson.status, 0, `${infoJson.stdout}${infoJson.stderr}`);
    const payload = JSON.parse(infoJson.stdout);
    assert.equal(payload.schema_version, 'p2a.info.v1');
    assert.ok(Array.isArray(payload.nextActions));
    assert.deepEqual(Object.keys(payload).sort(), [
      'artifactCount', 'artifacts', 'config', 'enhancements', 'generatedAt',
      'mode', 'nextActions', 'schema_version', 'surface', 'target', 'toolkitRoot',
    ]);

    next(root);
    const infoAfterNext = runP2a(['info', '--target', root, '--json']);
    assert.equal(infoAfterNext.status, 0, `${infoAfterNext.stdout}${infoAfterNext.stderr}`);
    const afterPayload = JSON.parse(infoAfterNext.stdout);
    assert.deepEqual(
      { ...afterPayload, generatedAt: null },
      { ...payload, generatedAt: null },
    );

    const infoHuman = runP2a(['info', '--target', root]);
    assert.equal(infoHuman.status, 0, `${infoHuman.stdout}${infoHuman.stderr}`);
    assert.match(infoHuman.stdout, /^Next: p2a next$/m);
    assert.doesNotMatch(infoHuman.stdout, /^Next actions:/m);
  } finally {
    remove(root);
  }
});

test('next keeps the ordered decision rules required by the contract', () => {
  assert.equal(NEXT_DECISION_RULES.length, 29);
  for (const rule of NEXT_DECISION_RULES) {
    assert.equal(typeof rule.when, 'function');
    assert.equal(typeof rule.reason, 'function');
    assert.equal(typeof rule.command, 'function');
  }
});

test('next and iteration open share the closed composition requirement', () => {
  assert.deepEqual(
    iterationCompositionRequirement({
      effective_spec_ref: 'current-spec.json',
      composed_from: ['v1'],
      closed_iterations: [
        { iteration_id: 'v1' },
        { iteration_id: 'v2' },
      ],
    }),
    {
      required: true,
      requiresComposedEffectiveSpec: false,
      missingClosedIterations: ['v2'],
    },
  );
  assert.equal(
    iterationCompositionRequirement({
      effective_spec_ref: 'current-spec.json',
      composed_from: ['v1', 'v2'],
      closed_iterations: [
        { iteration_id: 'v1' },
        { iteration_id: 'v2' },
      ],
    }).required,
    false,
  );
  assert.equal(
    iterationCompositionRequirement({
      effective_spec_ref: 'iterations/v1/gate-b-spec/spec.json',
      closed_iterations: [{ iteration_id: 'v1' }],
    }).required,
    false,
  );
});

test('next returns executable compose and open commands across a composition gap', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    writeClosedIterationWithCompositionGap(rootArtifact);

    const legacyResult = runP2a(['next', '--target', root, '--json']);
    assert.equal(legacyResult.status, 0, `${legacyResult.stdout}${legacyResult.stderr}`);
    const legacyBeforeCompose = JSON.parse(legacyResult.stdout);
    assert.doesNotThrow(() => validateSchema(legacyBeforeCompose, NEXT_V1_SCHEMA));
    assert.equal(legacyBeforeCompose.state, 'iteration_composition_required');
    assert.deepEqual(legacyBeforeCompose.command.argv, [
      'iteration', 'compose', '--artifacts', artifactPath(root),
    ]);

    const beforeCompose = next(root);
    assertAction(beforeCompose, 'iteration_composition_required', 'cli', [
      'iteration', 'compose', '--artifacts', artifactPath(root),
    ]);
    const composeResult = runP2a(beforeCompose.command.argv);
    assert.equal(composeResult.status, 0, `${composeResult.stdout}${composeResult.stderr}`);
    const composedSpec = JSON.parse(readFileSync(
      join(rootArtifact, 'current-spec.json'),
      'utf8',
    ));
    assert.deepEqual(composedSpec.composed_from, ['v1', 'v2']);
    assert.deepEqual(
      composedSpec.source_specs?.map((source) => source.iteration_id),
      ['v1', 'v2'],
    );

    const afterCompose = next(root);
    assertAction(afterCompose, 'iteration_complete', 'cli', [
      'iteration', 'open', '--artifacts', artifactPath(root), '--iteration-id', '<id>', '--idea', '<change idea>',
    ]);
    const openResult = runP2a(afterCompose.command.argv.map((argument) => {
      if (argument === '<id>') return 'v3';
      if (argument === '<change idea>') return 'Verify the next composed baseline';
      return argument;
    }));
    assert.equal(openResult.status, 0, `${openResult.stdout}${openResult.stderr}`);

    const currentSpec = JSON.parse(readFileSync(
      join(rootArtifact, 'current-spec.json'),
      'utf8',
    ));
    assert.equal(currentSpec.active_iteration, 'v3');
    assert.equal(currentSpec.pending_iteration?.baseline_iteration, 'v2');
    assert.match(
      currentSpec.pending_iteration?.baseline_effective_spec_ref ?? '',
      /^iterations\/v3\/baseline\/current-spec\.json$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('next routes approved Gate B to adaptive execution preparation without approval', () => {
  const rule = NEXT_DECISION_RULES.find((candidate) => candidate.state === 'gate_b_approved_needs_execution_prepare');
  const context = {
    gateBValid: true,
    gateBApproved: true,
    gateBPromoted: true,
    gateCExists: false,
    executionModePolicy: 'adaptive',
    artifactArg: '.plan2agent/artifacts/sample',
  };
  assert.equal(rule.when(context), true);
  assert.equal(rule.kind, 'skill');
  assert.equal(
    rule.command(context),
    '/p2a-dev-execution --artifacts ".plan2agent/artifacts/sample" --prepare-mode adaptive',
  );
  assert.equal(rule.when({ ...context, executionModePolicy: 'orchestrated' }), false);
});

test('next routes iterative approved Gate B through canonical promotion before every execution mode', () => {
  const cases = [
    { mode: 'direct', baselineBacked: false, downstream: 'gate_b_approved_needs_execution_prepare' },
    { mode: 'planned', baselineBacked: true, downstream: 'gate_b_approved_needs_execution_prepare' },
    { mode: 'orchestrated', baselineBacked: true, downstream: 'gate_b_approved_needs_tasks' },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      const iterationId = writeIteration(rootArtifact, 'sample', {
        iterationId: caseData.baselineBacked ? 'v2' : 'v1',
      });
      writeGateA(rootArtifact, 'ready_for_spec', iterationId);
      writeGateB(rootArtifact, 'approved', iterationId, { promoted: false });
      if (caseData.baselineBacked) {
        const activeRoot = gateRoot(rootArtifact, iterationId);
        const baselineRoot = gateRoot(rootArtifact, 'v1');
        const activeIntakePath = join(activeRoot, 'gate-a-intake', 'intake.json');
        const activeSpecPath = join(activeRoot, 'gate-b-spec', 'spec.json');
        const baselineIntakePath = join(baselineRoot, 'gate-a-intake', 'intake.json');
        const baselineSpecPath = join(baselineRoot, 'gate-b-spec', 'spec.json');
        writeJson(
          baselineIntakePath,
          JSON.parse(readFileSync(activeIntakePath, 'utf8')),
        );
        writeJson(
          baselineSpecPath,
          JSON.parse(readFileSync(activeSpecPath, 'utf8')),
        );
        const baselineSpecSha256 = createHash('sha256')
          .update(readFileSync(baselineSpecPath))
          .digest('hex');
        const activeIntake = JSON.parse(readFileSync(activeIntakePath, 'utf8'));
        activeIntake.baseline_context = {
          spec_ref: 'iterations/v1/gate-b-spec/spec.json',
          spec_sha256: baselineSpecSha256,
          reused_answers: [],
          reused_question_dispositions: [],
        };
        writeJson(activeIntakePath, activeIntake);
        const activeSpec = JSON.parse(readFileSync(activeSpecPath, 'utf8'));
        activeSpec.source_intake_sha256 = createHash('sha256')
          .update(readFileSync(activeIntakePath))
          .digest('hex');
        writeJson(activeSpecPath, activeSpec);
        const currentSpecPath = join(rootArtifact, 'current-spec.json');
        const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
        currentSpec.composed_from = ['v1'];
        currentSpec.effective_spec_ref = 'iterations/v1/gate-b-spec/spec.json';
        currentSpec.pending_iteration = {
          iteration_id: iterationId,
          status: 'gate_b_draft',
          opened_at: '2026-07-31T00:00:00.000Z',
          idea: 'Extend the approved baseline',
          baseline_iteration: 'v1',
          baseline_effective_spec_ref: 'iterations/v1/gate-b-spec/spec.json',
          baseline_effective_spec_sha256: baselineSpecSha256,
          artifacts: {
            intake_ref: `iterations/${iterationId}/gate-a-intake/intake.json`,
            spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
          },
        };
        writeJson(currentSpecPath, currentSpec);
        writeJson(join(rootArtifact, 'iterations', iterationId, 'iteration.json'), {
          schema_version: 'p2a.iteration_metadata.v1',
          project_id: 'sample',
          iteration_id: iterationId,
          status: 'gate_b_draft',
          opened_at: '2026-07-31T00:00:00.000Z',
          idea: 'Extend the approved baseline',
          baseline: {
            iteration_id: 'v1',
            current_spec_ref: 'current-spec.json',
            effective_spec_ref: 'iterations/v1/gate-b-spec/spec.json',
            effective_spec_sha256: baselineSpecSha256,
          },
        });
      } else {
        const currentSpecPath = join(rootArtifact, 'current-spec.json');
        const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
        currentSpec.composed_from = [];
        currentSpec.effective_spec_ref = null;
        currentSpec.pending_iteration = {
          iteration_id: iterationId,
          status: 'gate_b_draft',
          opened_at: '2026-07-31T00:00:00.000Z',
          idea: 'Deliver the first greenfield iteration',
          baseline_iteration: null,
          baseline_effective_spec_ref: null,
          artifacts: {
            intake_ref: `iterations/${iterationId}/gate-a-intake/intake.json`,
            spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
          },
        };
        writeJson(currentSpecPath, currentSpec);
        writeJson(join(rootArtifact, 'iterations', iterationId, 'iteration.json'), {
          schema_version: 'p2a.iteration_metadata.v1',
          project_id: 'sample',
          iteration_id: iterationId,
          status: 'gate_b_draft',
          opened_at: '2026-07-31T00:00:00.000Z',
          idea: 'Deliver the first greenfield iteration',
          baseline: {
            iteration_id: null,
            current_spec_ref: 'current-spec.json',
            effective_spec_ref: null,
          },
        });
      }
      writeJson(join(root, '.plan2agent', 'project.config.json'), {
        devExecution: { executionMode: caseData.mode },
      });

      const beforePromotion = next(root);
      assertAction(beforePromotion, 'gate_b_approved_needs_spec_promotion', 'cli', [
        'iteration', 'promote-spec', '--artifacts', rootArtifact,
      ], false);
      assert.match(beforePromotion.reason, /artifact is intact.*promotion is still pending/i);

      const promotion = runP2a(beforePromotion.command.argv);
      assert.equal(promotion.status, 0, `${promotion.stdout}${promotion.stderr}`);
      const promotedCurrentSpec = JSON.parse(readFileSync(
        join(rootArtifact, 'current-spec.json'),
        'utf8',
      ));
      assert.equal(
        promotedCurrentSpec.effective_spec_ref,
        caseData.baselineBacked
          ? 'iterations/v1/gate-b-spec/spec.json'
          : `iterations/${iterationId}/gate-b-spec/spec.json`,
      );
      assert.deepEqual(
        promotedCurrentSpec.composed_from,
        caseData.baselineBacked ? ['v1'] : [iterationId],
      );
      assert.equal(promotedCurrentSpec.pending_iteration?.status, 'gate_b_approved');
      assertAction(next(root), caseData.downstream, 'skill');
    } finally {
      remove(root);
    }
  }
});

test('next fail-closes mismatched Gate B promotion audit, source binding, and timestamp', () => {
  const cases = [
    {
      id: 'approval audit',
      mutate: (currentSpec, iterationId) => {
        currentSpec.gate_b_approval_audits[iterationId].approval_note = 'stale approval copy';
      },
      error: /approval_note must match/,
    },
    {
      id: 'approval artifact set',
      mutate: (currentSpec, iterationId) => {
        currentSpec.gate_b_approval_audits[iterationId].approved_artifacts.push(
          'iterations/stale/gate-b-spec/spec.json',
        );
      },
      error: /approved_artifacts must equal/,
    },
    {
      id: 'approval timestamp canonical form',
      mutate: (currentSpec, iterationId) => {
        currentSpec.gate_b_approval_audits[iterationId].approved_at += 'T23:59:59.000Z';
      },
      error: /approved_at must match/,
    },
    {
      id: 'source ref',
      mutate: (currentSpec, iterationId) => {
        currentSpec.gate_b_promotion_bindings[iterationId].source_spec_ref = 'iterations/stale/gate-b-spec/spec.json';
      },
      error: /source_spec_ref must be/,
    },
    {
      id: 'source hash',
      mutate: (currentSpec, iterationId) => {
        currentSpec.gate_b_promotion_bindings[iterationId].source_spec_sha256 = '0'.repeat(64);
      },
      error: /source_spec_sha256 does not match/,
    },
    {
      id: 'promotion timestamp',
      mutate: (currentSpec) => {
        currentSpec.gate_b_promoted_at = '2000-01-01T00:00:00.000Z';
      },
      error: /gate_b_promoted_at must match/,
    },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const rootArtifact = artifact(root);
      const iterationId = writeIteration(rootArtifact);
      writeGateA(rootArtifact, 'ready_for_spec', iterationId);
      writeGateB(rootArtifact, 'approved', iterationId);
      const currentSpecPath = join(rootArtifact, 'current-spec.json');
      const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
      caseData.mutate(currentSpec, iterationId);
      writeJson(currentSpecPath, currentSpec);

      const payload = next(root);
      assertAction(payload, 'gate_b_approved_needs_spec_promotion', 'cli', [
        'iteration', 'promote-spec', '--artifacts', rootArtifact,
      ], false);
      assert.match(payload.reason, caseData.error, caseData.id);
    } finally {
      remove(root);
    }
  }
});

test('next rejects a current-spec active iteration that does not resolve to its canonical artifacts', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    const currentSpecPath = join(rootArtifact, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.active_iteration = 'missing-iteration';
    writeJson(currentSpecPath, currentSpec);

    const payload = next(root);
    assertAction(payload, 'invalid_iteration_state', 'cli', [
      'iteration', 'validate', '--artifacts', rootArtifact,
    ]);
    assert.match(payload.reason, /missing-iteration/);
  } finally {
    remove(root);
  }
});

test('next routes partial iteration promotion metadata back through deterministic promotion repair', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact);
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    const currentSpec = JSON.parse(readFileSync(join(rootArtifact, 'current-spec.json'), 'utf8'));
    const binding = currentSpec.gate_b_promotion_bindings[iterationId];
    const metadataPath = join(rootArtifact, 'iterations', iterationId, 'iteration.json');
    writeJson(metadataPath, {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: 'sample',
      iteration_id: iterationId,
      status: 'gate_b_approved',
      promoted_at: '2000-01-01T00:00:00.000Z',
      approved_spec_artifacts: {
        spec_ref: binding.source_spec_ref,
      },
    });

    const beforeRepair = next(root);
    assertAction(beforeRepair, 'gate_b_approved_needs_spec_promotion', 'cli', [
      'iteration', 'promote-spec', '--artifacts', rootArtifact,
    ], false);
    assert.match(beforeRepair.reason, /iteration\.json promoted_at must match/);

    const repair = runP2a(beforeRepair.command.argv);
    assert.equal(repair.status, 0, `${repair.stdout}${repair.stderr}`);
    const repairedMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(repairedMetadata.promoted_at, binding.promoted_at);
    assertAction(next(root), 'gate_b_approved_needs_tasks', 'skill');
  } finally {
    remove(root);
  }
});

test('next applies the adaptive project policy to a flat approved Gate B artifact root', () => {
  const root = project();
  try {
    const artifactRoot = installFixtureArtifact(
      root,
      join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'),
      'webhook-api-service',
      'canonical',
    );
    rmSync(join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'));
    writeJson(join(root, '.plan2agent', 'project.config.json'), {
      devExecution: { executionMode: 'adaptive' },
    });
    const before = snapshotHarness(root);
    const payload = next(root);
    assertAction(payload, 'gate_b_approved_needs_execution_prepare', 'skill');
    assert.equal(
      payload.command.display,
      `/p2a-dev-execution --artifacts ${JSON.stringify(artifactRoot)} --prepare-mode adaptive`,
    );
    assert.deepEqual(snapshotHarness(root), before);
  } finally {
    remove(root);
  }
});

test('next routes a completed visual iteration through review when Gate B requires it', () => {
  const rule = NEXT_DECISION_RULES.find((candidate) => candidate.state === 'final_visual_review_required');
  const context = {
    reviewPasses: { visual: 'on' },
    hasRequiredVisualContract: true,
    allTasksDone: true,
    closedIteration: false,
    detail: { layout: { kind: 'iteration' } },
    visualReviewNeeded: true,
    artifactArg: '.plan2agent/artifacts/sample',
  };
  assert.equal(rule.when(context), true);
  assert.deepEqual(rule.command(context), [
    'execute',
    'review',
    '--artifacts',
    '.plan2agent/artifacts/sample',
  ]);
  assert.equal(rule.when({
    ...context,
    reviewPasses: { visual: 'off' },
  }), true);
  assert.equal(rule.when({
    ...context,
    reviewPasses: undefined,
  }), true);
  assert.equal(rule.when({
    ...context,
    hasRequiredVisualContract: false,
  }), false);
});

test('next routes a completed non-UI iteration through acceptance unless disabled', () => {
  const rule = NEXT_DECISION_RULES.find((candidate) => candidate.state === 'final_acceptance_review_required');
  const context = {
    reviewPasses: { acceptance: 'on' },
    allTasksDone: true,
    closedIteration: false,
    detail: { layout: { kind: 'iteration' } },
    acceptanceReviewNeeded: true,
    artifactArg: '.plan2agent/artifacts/sample',
  };
  assert.equal(rule.when(context), true);
  assert.deepEqual(rule.command(context), [
    'execute',
    'accept',
    '--artifacts',
    '.plan2agent/artifacts/sample',
  ]);
  assert.equal(rule.when({
    ...context,
    reviewPasses: { acceptance: 'opt_in' },
  }), false);
  assert.equal(rule.when({
    ...context,
    reviewPasses: { acceptance: 'opt_in' },
    acceptanceReviewActivated: true,
  }), true);
  assert.equal(rule.when({
    ...context,
    reviewPasses: { acceptance: 'off' },
  }), false);
});

test('next rejects invalid review pass configuration', () => {
  const root = project();
  try {
    writeJson(join(root, '.plan2agent', 'project.config.json'), {
      devExecution: {
        reviewPasses: {
          milestone: 'sometimes',
        },
      },
    });

    const result = runP2a(['next', '--target', root, '--json']);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /devExecution\.reviewPasses\.milestone must be one of off, opt_in, on/,
    );
  } finally {
    remove(root);
  }
});

test('next returns exact commands for cache, webhook, and e2e fixture states', () => {
  const cases = [
    { fixture: join(FIXTURE_ROOT, 'cache-library'), projectId: 'cache-library', layout: 'flat' },
    { fixture: join(FIXTURE_ROOT, 'webhook-api-service'), projectId: 'webhook-api-service', layout: 'flat' },
    { fixture: join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), projectId: 'webhook-api-service', layout: 'canonical' },
  ];

  for (const caseData of cases) {
    const root = project();
    try {
      const fixtureArtifact = installFixtureArtifact(root, caseData.fixture, caseData.projectId, caseData.layout);

      const before = snapshotHarness(root);
      const payload = next(root);
      assertAction(payload, 'gate_c_validated_needs_iteration_init', 'cli', [
        'iteration', 'init', '--artifacts', fixtureArtifact,
      ]);
      assert.deepEqual(snapshotHarness(root), before, `${caseData.projectId} fixture changed the project state`);
    } finally {
      remove(root);
    }
  }
});

test('next schema declares the CLI, skill, and approval command shapes', () => {
  assert.equal(NEXT_SCHEMA.properties.schema_version.const, 'p2a.next.v2');
  assert.deepEqual(NEXT_SCHEMA.properties.command.oneOf.map((variant) => variant.properties.kind.const), [
    'cli',
    'skill',
    'approval',
  ]);
  assert.ok(NEXT_SCHEMA.properties.command.oneOf[2].properties.options);
  const reviewOrClosePayload = {
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-22T00:00:00.000Z',
    target: '.',
    projectId: 'sample',
    state: 'iteration_review_or_close_required',
    reasonCode: 'iteration_review_or_close_required',
    reason: 'Review or close the completed iteration.',
    command: {
      kind: 'approval',
      display: 'Choose review or close.',
      options: [
        {
          id: 'review',
          label: 'Review and remediate',
          description: 'Review before close.',
          action: {
            kind: 'review',
            display: 'Review the implementation.',
            remediation: {
              kind: 'cli',
              argv: [
                'tasks', 'todo', '--artifacts', '.plan2agent/artifacts/sample', '<task-id>',
                '--reopen', '--note', '<review finding>',
              ],
              display: "p2a tasks todo --artifacts .plan2agent/artifacts/sample '<task-id>' --reopen --note '<review finding>'",
              requiresApproval: false,
            },
          },
        },
        {
          id: 'close',
          label: 'Close iteration',
          description: 'Close after an explicit choice.',
          action: {
            kind: 'cli',
            argv: ['iteration', 'close', '--artifacts', '.plan2agent/artifacts/sample'],
            display: 'p2a iteration close --artifacts .plan2agent/artifacts/sample',
            requiresApproval: true,
          },
        },
      ],
    },
    continuation: null,
  };
  assert.doesNotThrow(() => validateSchema(reviewOrClosePayload, NEXT_SCHEMA));

  const missingOptions = structuredClone(reviewOrClosePayload);
  delete missingOptions.command.options;
  assert.throws(
    () => validateSchema(missingOptions, NEXT_SCHEMA),
    /missing required keys: options/,
  );

  const malformedOptions = structuredClone(reviewOrClosePayload);
  malformedOptions.command.options = [{ bad: true }, { bad: true }];
  assert.throws(
    () => validateSchema(malformedOptions, NEXT_SCHEMA),
    /oneOf/,
  );

  const wrongRemediationCommand = structuredClone(reviewOrClosePayload);
  wrongRemediationCommand.command.options[0].action.remediation.argv[1] = 'show';
  assert.throws(
    () => validateSchema(wrongRemediationCommand, NEXT_SCHEMA),
    /oneOf/,
  );

  const optionsOnAnotherState = structuredClone(reviewOrClosePayload);
  optionsOnAnotherState.state = 'gate_a_needs_approval';
  optionsOnAnotherState.reasonCode = 'gate_a_needs_approval';
  assert.throws(
    () => validateSchema(optionsOnAnotherState, NEXT_SCHEMA),
    /must not match forbidden schema/,
  );

  assert.doesNotThrow(() => validateSchema(
    ['review', 'close'],
    { type: 'array', prefixItems: [{ const: 'review' }, { const: 'close' }], items: false },
  ));
  assert.throws(
    () => validateSchema(
      ['close', 'review'],
      { type: 'array', prefixItems: [{ const: 'review' }, { const: 'close' }], items: false },
    ),
    /must equal "review"/,
  );
  assert.throws(
    () => validateSchema(
      ['review', 'close', 'extra'],
      { type: 'array', prefixItems: [{ const: 'review' }, { const: 'close' }], items: false },
    ),
    /disallowed by the schema/,
  );
  assert.throws(() => validateSchema({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-07-27T00:00:00.000Z',
    target: '.',
    projectId: null,
    state: 'state_needs_inspection',
    reasonCode: 'state_needs_inspection',
    reason: 'CLI actions require argv.',
    command: { kind: 'cli', display: 'p2a info' },
    continuation: null,
  }, NEXT_SCHEMA), /oneOf/);
  assert.throws(() => validateSchema({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-07-27T00:00:00.000Z',
    target: '.',
    projectId: null,
    state: 'invented_state',
    reasonCode: 'invented_state',
    reason: 'Unknown states must not satisfy the typed contract.',
    command: { kind: 'approval', display: 'Inspect the state.' },
    continuation: null,
  }, NEXT_SCHEMA), /must be one of/);
  assert.throws(() => validateSchema({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-07-27T00:00:00.000Z',
    target: '.',
    projectId: null,
    state: 'ready_task_available',
    reasonCode: 'ready_task_available',
    reason: 'A run can start.',
    command: { kind: 'cli', argv: ['execute', 'start', '--json'], display: 'p2a execute start --json', requiresApproval: false },
    continuation: {
      id: 'execution.owner-start',
      activation: 'after_command_success',
      sourceState: 'ready_task_available',
      skill: 'p2a-dev-execution',
      phase: 'owner-start',
      mode: null,
    },
  }, NEXT_SCHEMA), /oneOf|binding/);
});

test('next continuation schema stays aligned with the canonical continuation registry', () => {
  for (const [id, definition] of Object.entries(CONTINUATION_DEFINITIONS)) {
    const mode = definition.activation === 'immediate' ? null : 'direct';
    const continuation = {
      ...continuationDescriptor(id, mode),
      sourceState: id === 'execution.prepare'
        ? 'gate_b_approved_needs_execution_prepare'
        : 'run_started',
    };
    const payload = {
      schema_version: 'p2a.next.v2',
      generatedAt: '2026-08-16T00:00:00.000Z',
      target: '.',
      projectId: 'sample',
      state: continuation.sourceState,
      reasonCode: continuation.sourceState,
      reason: 'Registry alignment fixture.',
      command: definition.activation === 'immediate'
        ? { kind: 'skill', skill: 'p2a-dev-execution', args: [], display: '/p2a-dev-execution' }
        : {
            kind: 'cli',
            argv: ['execute', 'resume', '--run-id', 'run-sample', '--json'],
            display: 'p2a execute resume --run-id run-sample --json',
            requiresApproval: false,
          },
      continuation,
    };
    assert.doesNotThrow(() => validateSchema(payload, NEXT_SCHEMA), id);
  }

  const orchestrated = {
    ...continuationDescriptor('execution.owner-start', 'direct'),
    mode: 'orchestrated',
    sourceState: 'run_started',
  };
  assert.throws(() => validateSchema({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-16T00:00:00.000Z',
    target: '.',
    projectId: 'sample',
    state: 'run_started',
    reasonCode: 'run_started',
    reason: 'Orchestrated packet continuations are not supported.',
    command: {
      kind: 'cli',
      argv: ['execute', 'resume', '--run-id', 'run-sample', '--json'],
      display: 'p2a execute resume --run-id run-sample --json',
      requiresApproval: false,
    },
    continuation: orchestrated,
  }, NEXT_SCHEMA), /oneOf|must be one of/);
});

test('next v2 exposes structured skill and command-bound continuation without display parsing', () => {
  const prepareRule = NEXT_DECISION_RULES.find((rule) => rule.state === 'gate_b_approved_needs_execution_prepare');
  const context = {
    executionModePolicy: 'adaptive',
    artifactArg: '.plan2agent/artifacts/sample',
  };
  assert.equal(prepareRule.skill, 'p2a-dev-execution');
  assert.deepEqual(prepareRule.args(context).slice(-2), ['--prepare-mode', 'adaptive']);
  assert.deepEqual(prepareRule.continuation, {
    id: 'execution.prepare',
    activation: 'immediate',
    skill: 'p2a-dev-execution',
    phase: 'prepare',
    mode: null,
  });

  const readyRule = NEXT_DECISION_RULES.find((rule) => rule.state === 'ready_task_available');
  const directContinuation = readyRule.continuation({
    gates: { taskGraph: { execution: { mode: 'direct' } } },
  });
  assert.equal(directContinuation.activation, 'after_command_success');
  assert.equal(directContinuation.mode, 'direct');
  assert.deepEqual(directContinuation.binding, {
    kind: 'command_result',
    schema_version: 'p2a.execution_result.v1',
    field: 'runId',
  });
  assert.equal(readyRule.continuation({
    gates: { taskGraph: { execution: { mode: 'orchestrated' } } },
  }), null);

  const startedRule = NEXT_DECISION_RULES.find((rule) => rule.state === 'run_started');
  assert.equal(startedRule.continuation({ startedRun: { mode: 'orchestrated' } }), null);
  assert.equal(startedRule.continuation({ startedRun: { mode: 'planned' } }).mode, 'planned');
});

test('next keeps the strict v1 JSON contract by default and exposes reasonCode only in v2', () => {
  const root = project();
  try {
    const legacyResult = runP2a(['next', '--target', root, '--json']);
    assert.equal(legacyResult.status, 0, `${legacyResult.stdout}${legacyResult.stderr}`);
    const legacy = JSON.parse(legacyResult.stdout);
    assert.doesNotThrow(() => validateSchema(legacy, NEXT_V1_SCHEMA));
    assert.equal(legacy.schema_version, 'p2a.next.v1');
    assert.equal('reasonCode' in legacy, false);
    assert.equal('continuation' in legacy, false);

    const typed = next(root);
    assert.doesNotThrow(() => validateSchema(typed, NEXT_SCHEMA));
    assert.equal(typed.reasonCode, typed.state);
    assert.equal(typed.continuation, null);
  } finally {
    remove(root);
  }
});

test('p2a-next skill delegates to the CLI without duplicating decision rules', () => {
  const skill = readFileSync(new URL('../.agents/skills/p2a-next/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /p2a next --json --contract v2/);
  assert.match(skill, /kind: cli/);
  assert.match(skill, /kind: skill/);
  assert.match(skill, /kind: approval/);
  assert.match(skill, /structured option/);
  assert.match(skill, /action\.remediation/);
  assert.doesNotMatch(skill, /gate-a|ready task|iteration init/i);
});
