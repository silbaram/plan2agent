import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { FIXTURE_ROOT, makeTempDir, runP2a } from './helpers/fixtures.mjs';
import { validateSchema } from '../scripts/validate_artifacts.mjs';
import { NEXT_DECISION_RULES } from '../scripts/p2a.mjs';

const NEXT_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/next.schema.json', import.meta.url), 'utf8'));

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

function writeGateB(artifactRoot, approval = 'approved', iterationId = null) {
  const spec = JSON.parse(readFileSync(
    join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'),
    'utf8',
  ));
  spec.source_intake = '../gate-a-intake/intake.json';
  spec.project_id = currentProjectId(artifactRoot) ?? spec.project_id;
  spec.approval = approval;
  if (approval !== 'approved') delete spec.approval_audit;
  writeJson(
    join(gateRoot(artifactRoot, iterationId), 'gate-b-spec', 'spec.json'),
    spec,
  );
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
  const approvalAudit = {
    approved_by: 'user',
    approved_at: '2026-07-31',
    approved_artifacts: [
      `iterations/${iterationId}/gate-b-spec/spec.json`,
    ],
    approval_note: 'Fixture approval for next-action readiness.',
  };
  const currentSpec = {
    schema_version: 'p2a.current_spec.v1',
    project_id: projectId,
    active_iteration: iterationId,
    effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    gate_b_approval_audits: {
      [iterationId]: approvalAudit,
    },
    ...(options.closed ? {
      last_closed_iteration: { iteration_id: iterationId, status: 'archived' },
      closed_iterations: [{ iteration_id: iterationId, status: 'archived' }],
    } : {}),
  };
  writeJson(join(artifactRoot, 'current-spec.json'), currentSpec);
  return iterationId;
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
      verification: [],
      notes: [],
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
  const result = runP2a(['next', '--target', root, '--json', ...args]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function assertAction(payload, state, kind, argv = null) {
  assert.doesNotThrow(() => validateSchema(payload, NEXT_SCHEMA));
  assert.equal(payload.schema_version, 'p2a.next.v1');
  assert.equal(payload.state, state);
  assert.equal(payload.command.kind, kind);
  assert.equal(typeof payload.command.display, 'string');
  assert.ok(payload.command.display.length > 0);
  if (kind === 'cli') {
    assert.ok(Array.isArray(payload.command.argv) && payload.command.argv.length > 0);
    assert.equal(typeof payload.command.requiresApproval, 'boolean');
    if (argv) assert.deepEqual(payload.command.argv, argv);
  } else {
    assert.equal('argv' in payload.command, false);
  }
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
      id: 'all non-UI tasks done require functional acceptance',
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
    ]);

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
    ]);

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
  assert.equal(NEXT_DECISION_RULES.length, 27);
  for (const rule of NEXT_DECISION_RULES) {
    assert.equal(typeof rule.when, 'function');
    assert.equal(typeof rule.reason, 'function');
    assert.equal(typeof rule.command, 'function');
  }
});

test('next routes approved Gate B to adaptive execution preparation without approval', () => {
  const rule = NEXT_DECISION_RULES.find((candidate) => candidate.state === 'gate_b_approved_needs_execution_prepare');
  const context = {
    gateBValid: true,
    gateBApproved: true,
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
  assert.equal(NEXT_SCHEMA.properties.schema_version.const, 'p2a.next.v1');
  assert.deepEqual(NEXT_SCHEMA.properties.command.oneOf.map((variant) => variant.properties.kind.const ?? variant.properties.kind.enum), [
    'cli',
    ['skill', 'approval'],
  ]);
  assert.throws(() => validateSchema({
    schema_version: 'p2a.next.v1',
    generatedAt: '2026-07-27T00:00:00.000Z',
    target: '.',
    projectId: null,
    state: 'invalid_cli',
    reason: 'CLI actions require argv.',
    command: { kind: 'cli', display: 'p2a info' },
  }, NEXT_SCHEMA), /oneOf/);
});

test('p2a-next skill delegates to the CLI without duplicating decision rules', () => {
  const skill = readFileSync(new URL('../.agents/skills/p2a-next/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /p2a next --json/);
  assert.match(skill, /kind: cli/);
  assert.match(skill, /kind: skill/);
  assert.match(skill, /kind: approval/);
  assert.doesNotMatch(skill, /gate-a|ready task|iteration init/i);
});
