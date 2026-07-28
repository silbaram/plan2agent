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
    provenance: { mode: 'scaffold' },
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

function gateRoot(artifactRoot, iterationId = null) {
  return iterationId ? join(artifactRoot, 'iterations', iterationId) : artifactRoot;
}

function writeGateA(artifactRoot, status = 'blocked_on_user', iterationId = null) {
  writeJson(join(gateRoot(artifactRoot, iterationId), 'gate-a-intake', 'intake.json'), { status });
}

function writeGateB(artifactRoot, approval = 'approved', iterationId = null) {
  writeJson(join(gateRoot(artifactRoot, iterationId), 'gate-b-spec', 'spec.json'), { approval });
}

function writeGateC(artifactRoot, tasks, iterationId = null) {
  writeJson(join(gateRoot(artifactRoot, iterationId), 'gate-c-task-graph', 'task-graph.json'), { tasks });
}

function writeGateD(artifactRoot, blockingIssues = [], iterationId = null) {
  writeJson(join(gateRoot(artifactRoot, iterationId), 'gate-d-review', 'review.json'), { blocking_issues: blockingIssues });
}

function writeIteration(artifactRoot, projectId = 'sample', options = {}) {
  const iterationId = options.iterationId ?? 'v1';
  mkdirSync(join(artifactRoot, 'iterations', iterationId), { recursive: true });
  const currentSpec = {
    project_id: projectId,
    active_iteration: iterationId,
    ...(options.closed ? {
      last_closed_iteration: { iteration_id: iterationId, status: 'archived' },
      closed_iterations: [{ iteration_id: iterationId, status: 'archived' }],
    } : {}),
  };
  writeJson(join(artifactRoot, 'current-spec.json'), currentSpec);
  return iterationId;
}

function task(id, status, dependencies = []) {
  return { id, status, dependencies };
}

function writeRuns(artifactRoot, runs) {
  writeJson(join(artifactRoot, 'runs', 'run-index.json'), { runs });
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
      expected: () => ['initialized_without_artifacts', 'skill'],
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
      expected: () => ['gate_a_ready_for_spec', 'skill'],
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
      id: 'gate C needs review',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        writeGateC(rootArtifact, [task('task-001', 'todo')]);
        return root;
      },
      expected: () => ['gate_c_needs_review', 'skill'],
    },
    {
      id: 'gate D needs iteration init',
      setup: () => {
        const root = project();
        const rootArtifact = artifact(root);
        writeGateA(rootArtifact, 'ready_for_spec');
        writeGateB(rootArtifact);
        writeGateC(rootArtifact, [task('task-001', 'todo')]);
        writeGateD(rootArtifact);
        return root;
      },
      expected: (root) => ['gate_d_passed_needs_iteration_init', 'cli', ['iteration', 'init', '--artifacts', artifactPath(root)]],
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
      expected: (root) => ['ready_task_available', 'cli', ['execute', 'plan', '--artifacts', artifactPath(root), '--task', 'task-001']],
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
      id: 'all tasks done closes iteration',
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
      expected: (root) => ['iteration_ready_to_close', 'cli', ['iteration', 'close', '--artifacts', artifactPath(root)]],
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
    assertAction(selected, 'gate_a_ready_for_spec', 'skill');
    assert.equal(selected.projectId, 'second');
  } finally {
    remove(root);
  }
});

test('next ignores open runs from an earlier iteration', () => {
  const root = project();
  try {
    const rootArtifact = artifact(root);
    const iterationId = writeIteration(rootArtifact, 'sample', { iterationId: 'v2' });
    writeGateA(rootArtifact, 'ready_for_spec', iterationId);
    writeGateB(rootArtifact, 'approved', iterationId);
    writeGateC(rootArtifact, [task('task-001', 'todo')], iterationId);
    writeGateD(rootArtifact, [], iterationId);
    writeRuns(rootArtifact, [{ runId: 'run-v1', iterationId: 'v1', status: 'started' }]);

    const payload = next(root);
    assertAction(payload, 'ready_task_available', 'cli', ['execute', 'plan', '--artifacts', artifactPath(root), '--task', 'task-001']);
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

test('next keeps the fourteen ordered decision rules required by the contract', () => {
  assert.equal(NEXT_DECISION_RULES.length, 14);
  for (const rule of NEXT_DECISION_RULES) {
    assert.equal(typeof rule.when, 'function');
    assert.equal(typeof rule.reason, 'function');
    assert.equal(typeof rule.command, 'function');
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
      assertAction(payload, 'gate_d_passed_needs_iteration_init', 'cli', [
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
