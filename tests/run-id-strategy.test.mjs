import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { withIterationCloseRollback } from '../scripts/p2a_iteration.mjs';
import { allocateRunId, previewRunId } from '../scripts/p2a_project_config.mjs';
import { canonicalRunRef, canonicalTaskGraphRef, runFilePath } from '../scripts/p2a_run_paths.mjs';
import { runWriteTransactionPath, withRunStoreLocks } from '../scripts/p2a_run_store.mjs';
import { assertStartTaskSourceUnchanged } from '../scripts/p2a_runs.mjs';
import {
  E2E_FIXTURE_ROOT,
  EXECUTE_CLI,
  HANDOFF_CLI,
  ITERATION_CLI,
  PROPOSALS_CLI,
  ROOT,
  RUNS_CLI,
  TASKS_CLI,
} from './helpers/fixtures.mjs';

const TASK_GRAPH_FIXTURE = path.join(ROOT, 'fixtures', 'webhook-api-service', 'task-graph.json');
const RUN_ID_MODULE_URL = pathToFileURL(path.join(ROOT, 'scripts', 'p2a_project_config.mjs')).href;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function tempRoot(label) {
  return mkdtempSync(path.join(tmpdir(), `p2a-${label}-`));
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], { cwd, encoding: 'utf8' });
}

function runCliAsync(args, cwd = ROOT, options = {}) {
  return cliAsync(RUNS_CLI, args, cwd, options);
}

function executeCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], { cwd, encoding: 'utf8' });
}

function executeCliAsync(args, cwd = ROOT, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXECUTE_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function taskCliAsync(args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TASKS_CLI, ...args], { cwd, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function iterationCliAsync(args, cwd = ROOT) {
  return cliAsync(ITERATION_CLI, args, cwd);
}

function handoffCliAsync(args, cwd = ROOT) {
  return cliAsync(HANDOFF_CLI, args, cwd);
}

function handoffCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function proposalsCliAsync(args, cwd = ROOT) {
  return cliAsync(PROPOSALS_CLI, args, cwd);
}

function cliAsync(cliPath, args, cwd = ROOT, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: 'utf8',
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitForPath(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for path: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function initializedArtifactRoot(label) {
  const artifactRoot = tempRoot(label);
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
  const result = spawnSync(process.execPath, [
    ITERATION_CLI,
    'init',
    '--artifacts',
    artifactRoot,
    '--iteration-id',
    'v1-mvp',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return artifactRoot;
}

test('p2a execute start rejects an invalid composed current spec before claiming work', () => {
  const artifactRoot = initializedArtifactRoot('execute-invalid-composition');
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'v1-mvp',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const workspace = tempRoot('execute-invalid-composition-workspace');
  try {
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.effective_spec_ref = 'current-spec.json';
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    const result = executeCli([
      'start',
      '--artifacts',
      artifactRoot,
      '--task',
      'task-001',
      '--agent-tool',
      'codex',
      '--workspace',
      workspace,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /current-spec\.json source_specs must be a non-empty array for composition/,
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(
      graph.tasks.find((task) => task.id === 'task-001')?.status,
      'todo',
    );
    assert.equal(existsSync(path.join(artifactRoot, 'runs', 'run-index.json')), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('p2a execute start rejects a current-spec project mismatch before claiming work', () => {
  const artifactRoot = initializedArtifactRoot('execute-project-mismatch');
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'v1-mvp',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const workspace = tempRoot('execute-project-mismatch-workspace');
  try {
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.project_id = 'other-project';
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    const result = executeCli([
      'start',
      '--artifacts',
      artifactRoot,
      '--task',
      'task-001',
      '--agent-tool',
      'codex',
      '--workspace',
      workspace,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /spec\.project_id .* to match current-spec\.json project_id/,
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(
      graph.tasks.find((task) => task.id === 'task-001')?.status,
      'todo',
    );
    assert.equal(existsSync(path.join(artifactRoot, 'runs', 'run-index.json')), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ready execution and explicit handoff reject a missing current-spec project identity', () => {
  const artifactRoot = initializedArtifactRoot('missing-current-project');
  const workspace = tempRoot('missing-current-project-workspace');
  const targetParent = tempRoot('missing-current-project-handoff-target');
  const target = path.join(targetParent, 'target');
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'v1-mvp',
    'gate-c-task-graph',
    'task-graph.json',
  );
  try {
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    delete currentSpec.project_id;
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    const executeResult = executeCli([
      'start',
      '--artifacts',
      artifactRoot,
      '--task',
      'task-001',
      '--agent-tool',
      'codex',
      '--workspace',
      workspace,
    ]);
    assert.equal(
      executeResult.status,
      1,
      `${executeResult.stdout}${executeResult.stderr}`,
    );
    assert.match(
      `${executeResult.stdout}${executeResult.stderr}`,
      /current-spec\.json project_id must be a non-empty string/,
    );
    assert.equal(
      JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status,
      'todo',
    );
    assert.equal(
      existsSync(path.join(artifactRoot, 'runs', 'run-index.json')),
      false,
    );

    const handoffResult = handoffCli([
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      artifactRoot,
      '--target',
      target,
      '--iteration-id',
      'v1-mvp',
    ]);
    assert.equal(
      handoffResult.status,
      1,
      `${handoffResult.stdout}${handoffResult.stderr}`,
    );
    assert.match(
      `${handoffResult.stdout}${handoffResult.stderr}`,
      /current-spec\.json project_id must be a non-empty string/,
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('iterative handoff next recommendation executes against the flattened target graph', () => {
  const artifactRoot = initializedArtifactRoot('iterative-handoff-next-command');
  const targetParent = tempRoot('iterative-handoff-next-command-target');
  const target = path.join(targetParent, 'target');
  try {
    const handoffResult = handoffCli([
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      artifactRoot,
      '--target',
      target,
      '--iteration-id',
      'v1-mvp',
    ]);
    assert.equal(
      handoffResult.status,
      0,
      `${handoffResult.stdout}${handoffResult.stderr}`,
    );

    const embeddedP2a = path.join(target, '.plan2agent', 'scripts', 'p2a.mjs');
    const nextResult = spawnSync(process.execPath, [
      embeddedP2a,
      'next',
      '--target',
      target,
      '--json',
    ], { cwd: target, encoding: 'utf8' });
    assert.equal(nextResult.status, 0, `${nextResult.stdout}${nextResult.stderr}`);
    const next = JSON.parse(nextResult.stdout);
    assert.equal(next.state, 'ready_task_available');
    assert.deepEqual(next.command.argv.slice(0, 3), [
      'execute',
      'plan',
      '--graph',
    ]);

    const recommendedResult = spawnSync(
      process.execPath,
      [embeddedP2a, ...next.command.argv],
      { cwd: target, encoding: 'utf8' },
    );
    assert.equal(
      recommendedResult.status,
      0,
      `${recommendedResult.stdout}${recommendedResult.stderr}`,
    );
    assert.match(recommendedResult.stdout, /Plan2Agent supervised task execution/);

    const targetGraphPath = path.resolve(target, next.command.argv[3]);
    const completedGraph = JSON.parse(readFileSync(targetGraphPath, 'utf8'));
    completedGraph.tasks = completedGraph.tasks.map((task) => ({
      ...task,
      status: 'done',
    }));
    writeFileSync(
      targetGraphPath,
      `${JSON.stringify(completedGraph, null, 2)}\n`,
      'utf8',
    );

    const completedNextResult = spawnSync(process.execPath, [
      embeddedP2a,
      'next',
      '--target',
      target,
      '--json',
    ], { cwd: target, encoding: 'utf8' });
    assert.equal(
      completedNextResult.status,
      0,
      `${completedNextResult.stdout}${completedNextResult.stderr}`,
    );
    const completedNext = JSON.parse(completedNextResult.stdout);
    assert.equal(completedNext.state, 'flat_execution_complete');
    assert.equal(completedNext.command.kind, 'approval');
    assert.match(completedNext.command.display, /no iteration close is required/);

    const completedInfoResult = spawnSync(process.execPath, [
      embeddedP2a,
      'info',
      '--target',
      target,
      '--json',
    ], { cwd: target, encoding: 'utf8' });
    assert.equal(
      completedInfoResult.status,
      0,
      `${completedInfoResult.stdout}${completedInfoResult.stderr}`,
    );
    const completedInfo = JSON.parse(completedInfoResult.stdout);
    assert.ok(completedInfo.nextActions.some((action) => (
      action.includes('Review completed flat handoff evidence')
      && action.includes('no iteration close is required')
    )));
    assert.ok(completedInfo.nextActions.every((action) => (
      !action.includes('iteration validate')
    )));
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('maintenance execute and run starts reject a current-spec project mismatch before mutation', () => {
  const cases = [
    { id: 'execute', run: executeCli },
    { id: 'runs', run: runCli },
  ];

  for (const caseData of cases) {
    const artifactRoot = initializedArtifactRoot(`maintenance-project-mismatch-${caseData.id}`);
    const workspace = tempRoot(`maintenance-project-mismatch-${caseData.id}-workspace`);
    try {
      const addResult = spawnSync(process.execPath, [
        ITERATION_CLI,
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Validate maintenance project identity',
        '--accept',
        'Reject a maintenance run when the canonical project identities differ.',
      ], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(addResult.status, 0, `${addResult.stdout}${addResult.stderr}`);

      const graphPath = path.join(
        artifactRoot,
        'iterations',
        'maintenance',
        'gate-c-task-graph',
        'task-graph.json',
      );
      const graphBefore = JSON.parse(readFileSync(graphPath, 'utf8'));
      const taskId = graphBefore.tasks[0].id;
      const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
      const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
      currentSpec.project_id = 'other-project';
      writeFileSync(
        currentSpecPath,
        `${JSON.stringify(currentSpec, null, 2)}\n`,
        'utf8',
      );

      const result = caseData.run([
        'start',
        '--artifacts',
        artifactRoot,
        '--maintenance',
        '--task',
        taskId,
        '--run-id',
        `run-maintenance-project-mismatch-${caseData.id}`,
        '--agent-tool',
        'codex',
        '--workspace',
        workspace,
      ]);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /maintenance taskGraph\.projectId .* must match current-spec\.json project_id/,
      );
      assert.deepEqual(
        JSON.parse(readFileSync(graphPath, 'utf8')),
        graphBefore,
      );
      assert.equal(existsSync(path.join(artifactRoot, 'runs', 'run-index.json')), false);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('maintenance run commit revalidates project identity after isolation preparation', () => {
  const artifactRoot = initializedArtifactRoot('maintenance-project-change-before-commit');
  try {
    const addResult = spawnSync(process.execPath, [
      ITERATION_CLI,
      'maintenance',
      'add',
      '--artifacts',
      artifactRoot,
      '--title',
      'Revalidate maintenance identity at commit',
      '--accept',
      'Reject a run when project identity changes while isolation is prepared.',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(addResult.status, 0, `${addResult.stdout}${addResult.stderr}`);

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(graph))
      .digest('hex');
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.project_id = 'other-project';
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    assert.throws(
      () => assertStartTaskSourceUnchanged({
        sourceLayout: 'maintenance',
        projectId: graph.projectId,
        artifactRoot,
        graphPath,
      }, fingerprint, 'run-maintenance-project-change-before-commit'),
      /maintenance project state changed while run .* was preparing isolation/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('maintenance writers and direct task transitions reject project mismatch without mutation', () => {
  const artifactRoot = initializedArtifactRoot('maintenance-writer-project-mismatch');
  try {
    let result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'maintenance',
      'add',
      '--artifacts',
      artifactRoot,
      '--title',
      'Existing maintenance task',
      '--accept',
      'The existing maintenance graph remains unchanged.',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const statusPath = path.join(artifactRoot, 'status.md');
    const graphBefore = readFileSync(graphPath);
    const statusBefore = readFileSync(statusPath);
    const taskId = JSON.parse(graphBefore.toString('utf8')).tasks[0].id;
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.project_id = 'other-project';
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    const maintenanceDraftPath = path.join(
      artifactRoot,
      'maintenance-project-mismatch-draft.json',
    );
    writeFileSync(maintenanceDraftPath, `${JSON.stringify({
      schema_version: 'p2a.eval_maintenance_draft.v1',
      draftId: 'eval-maintenance-draft-project-mismatch',
      generatedAt: '2026-07-31T00:00:00.000Z',
      summary: { clusters: 1, tasks: 1 },
      tasks: [{
        id: 'draft-project-mismatch',
        clusterId: 'cluster-project-mismatch',
        title: 'Rejected draft task',
        acceptanceCriteria: ['The mismatched graph is not changed.'],
        sourceSpecRefs: ['eval-cluster:cluster-project-mismatch'],
      }],
      nextActions: ['Repair project identity before applying.'],
    }, null, 2)}\n`, 'utf8');

    const proposalsDir = path.join(artifactRoot, 'proposals');
    const proposalDraftPath = path.join(
      proposalsDir,
      'patch-drafts',
      'project-mismatch.json',
    );
    const approvalPath = path.join(
      proposalsDir,
      'approvals',
      'project-mismatch.json',
    );
    mkdirSync(path.dirname(proposalDraftPath), { recursive: true });
    writeFileSync(
      proposalDraftPath,
      `${JSON.stringify(proposalPatchDraft(), null, 2)}\n`,
      'utf8',
    );

    const cases = [
      {
        id: 'maintenance add',
        cli: ITERATION_CLI,
        args: [
          'maintenance',
          'add',
          '--artifacts',
          artifactRoot,
          '--title',
          'Rejected maintenance task',
          '--accept',
          'The mismatched graph is not changed.',
        ],
      },
      {
        id: 'maintenance add from draft',
        cli: ITERATION_CLI,
        args: [
          'maintenance',
          'add',
          '--artifacts',
          artifactRoot,
          '--from-draft',
          maintenanceDraftPath,
          '--yes',
        ],
      },
      {
        id: 'direct maintenance task transition',
        cli: TASKS_CLI,
        args: [
          'start',
          '--artifacts',
          artifactRoot,
          '--maintenance',
          taskId,
        ],
      },
      {
        id: 'proposal approval maintenance append',
        cli: PROPOSALS_CLI,
        args: [
          'approve-draft',
          '--draft',
          proposalDraftPath,
          '--artifacts',
          artifactRoot,
          '--approved-by',
          'fixture-reviewer',
          '--proposals',
          proposalsDir,
          '--output',
          approvalPath,
        ],
      },
    ];

    for (const caseData of cases) {
      result = spawnSync(
        process.execPath,
        [caseData.cli, ...caseData.args],
        { cwd: ROOT, encoding: 'utf8' },
      );
      assert.equal(
        result.status,
        1,
        `${caseData.id}: ${result.stdout}${result.stderr}`,
      );
      assert.match(
        `${result.stdout}${result.stderr}`,
        /maintenance taskGraph\.projectId .* must match current-spec\.json project_id/,
        caseData.id,
      );
      assert.deepEqual(readFileSync(graphPath), graphBefore, caseData.id);
      assert.deepEqual(readFileSync(statusPath), statusBefore, caseData.id);
    }
    assert.equal(existsSync(approvalPath), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('handoff applies the same readiness validation to default and explicit active iteration selection', () => {
  const artifactRoot = initializedArtifactRoot('handoff-explicit-active-readiness');
  const targetParent = tempRoot('handoff-explicit-active-readiness-target');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.project_id = 'other-project';
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    for (const selectionArgs of [[], ['--iteration-id', 'v1-mvp']]) {
      const target = path.join(
        targetParent,
        selectionArgs.length ? 'explicit' : 'default',
      );
      const result = handoffCli([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        artifactRoot,
        '--target',
        target,
        ...selectionArgs,
      ]);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /spec\.project_id .* to match current-spec\.json project_id/,
      );
      assert.equal(existsSync(target), false);
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('p2a execute start rejects a stale active intake baseline before claiming work', () => {
  const artifactRoot = initializedArtifactRoot('execute-stale-intake-baseline');
  const workspace = tempRoot('execute-stale-intake-baseline-workspace');
  try {
    const { secondIterationId } = prepareCloseReadySecondIteration(artifactRoot);
    const firstIterationRoot = path.join(artifactRoot, 'iterations', 'v1-mvp');
    const alternateIterationRoot = path.join(artifactRoot, 'iterations', 'alternate');
    cpSync(firstIterationRoot, alternateIterationRoot, { recursive: true });

    const secondIterationRoot = path.join(
      artifactRoot,
      'iterations',
      secondIterationId,
    );
    const intakePath = path.join(
      secondIterationRoot,
      'gate-a-intake',
      'intake.json',
    );
    const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
    intake.baseline_context.spec_ref =
      'iterations/alternate/gate-b-spec/spec.json';
    writeFileSync(intakePath, `${JSON.stringify(intake, null, 2)}\n`, 'utf8');

    const graphPath = path.join(
      secondIterationRoot,
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks = graph.tasks.map((task) => (
      task.id === 'task-001' ? { ...task, status: 'todo' } : task
    ));
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    const result = executeCli([
      'start',
      '--artifacts',
      artifactRoot,
      '--task',
      'task-001',
      '--agent-tool',
      'codex',
      '--workspace',
      workspace,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context\.spec_ref .* must match pending baseline/,
    );
    const unchangedGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(
      unchangedGraph.tasks.find((task) => task.id === 'task-001')?.status,
      'todo',
    );
    assert.equal(existsSync(path.join(artifactRoot, 'runs', 'run-index.json')), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('failed iteration init restores the flat layout without orphan state', () => {
  const artifactRoot = tempRoot('iteration-init-rollback');
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
  const originalSpec = readFileSync(path.join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8');
  const originalGraph = readFileSync(
    path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'),
    'utf8',
  );
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  mkdirSync(currentSpecPath);
  try {
    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'init',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'v1-mvp',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.equal(lstatSync(currentSpecPath).isDirectory(), true);
    assert.equal(existsSync(path.join(artifactRoot, 'iterations')), false);
    assert.equal(
      readFileSync(path.join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8'),
      originalSpec,
    );
    assert.equal(
      readFileSync(path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), 'utf8'),
      originalGraph,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

function closeInitializedIteration(artifactRoot) {
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'v1-mvp',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  graph.tasks = graph.tasks.map((task) => ({ ...task, status: 'done' }));
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [
    ITERATION_CLI,
    'close',
    '--artifacts',
    artifactRoot,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function prepareCloseReadySecondIteration(artifactRoot) {
  closeInitializedIteration(artifactRoot);
  const firstIterationId = 'v1-mvp';
  const secondIterationId = 'v2-close-ready';
  const firstIterationRoot = path.join(artifactRoot, 'iterations', firstIterationId);
  const secondIterationRoot = path.join(artifactRoot, 'iterations', secondIterationId);
  cpSync(firstIterationRoot, secondIterationRoot, { recursive: true });

  const secondSpecPath = path.join(
    secondIterationRoot,
    'gate-b-spec',
    'spec.json',
  );
  const secondIntakePath = path.join(
    secondIterationRoot,
    'gate-a-intake',
    'intake.json',
  );
  const secondIntake = JSON.parse(readFileSync(secondIntakePath, 'utf8'));
  secondIntake.baseline_context = {
    spec_ref: `iterations/${firstIterationId}/gate-b-spec/spec.json`,
    reused_answers: [],
    reused_question_dispositions: [],
  };
  writeFileSync(
    secondIntakePath,
    `${JSON.stringify(secondIntake, null, 2)}\n`,
    'utf8',
  );
  const secondSpec = JSON.parse(readFileSync(secondSpecPath, 'utf8'));
  secondSpec.product.target_users = ['Second-iteration operators'];
  secondSpec.approval_audit.approved_artifacts = [
    `iterations/${secondIterationId}/gate-b-spec/spec.json`,
  ];
  writeFileSync(secondSpecPath, `${JSON.stringify(secondSpec, null, 2)}\n`, 'utf8');

  writeFileSync(
    path.join(secondIterationRoot, 'iteration.json'),
    `${JSON.stringify({
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: secondSpec.project_id,
      iteration_id: secondIterationId,
      status: 'gate_b_approved',
      opened_at: '2026-07-30T00:00:00.000Z',
      idea: 'Add a second close-ready iteration',
      baseline: {
        iteration_id: firstIterationId,
        current_spec_ref: 'current-spec.json',
        effective_spec_ref:
          `iterations/${firstIterationId}/gate-b-spec/spec.json`,
      },
      planning_memory: null,
    }, null, 2)}\n`,
    'utf8',
  );

  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  currentSpec.active_iteration = secondIterationId;
  currentSpec.pending_iteration = {
    iteration_id: secondIterationId,
    status: 'gate_b_approved',
    opened_at: '2026-07-30T00:00:00.000Z',
    idea: 'Add a second close-ready iteration',
    baseline_iteration: firstIterationId,
    baseline_effective_spec_ref:
      `iterations/${firstIterationId}/gate-b-spec/spec.json`,
  };
  currentSpec.gate_b_approval_audits[secondIterationId] = {
    ...currentSpec.gate_b_approval_audits[firstIterationId],
    approved_artifacts: [
      `iterations/${secondIterationId}/gate-b-spec/spec.json`,
    ],
  };
  currentSpec.gate_c_approval_audits[secondIterationId] = {
    ...currentSpec.gate_c_approval_audits[firstIterationId],
    approved_artifacts: [
      `iterations/${secondIterationId}/gate-c-task-graph/task-graph.draft.json`,
    ],
  };
  writeFileSync(currentSpecPath, `${JSON.stringify(currentSpec, null, 2)}\n`, 'utf8');
  return { currentSpecPath, secondIterationId };
}

function initialGateAForceResetArtifactRoot(label) {
  const artifactRoot = initializedArtifactRoot(label);
  const iterationId = 'v1-mvp';
  const intakePath = path.join(
    artifactRoot,
    'iterations',
    iterationId,
    'gate-a-intake',
    'intake.json',
  );
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
  currentSpec.pending_iteration = {
    iteration_id: iterationId,
    status: 'gate_a_ready',
    idea: intake.idea,
    baseline_effective_spec_ref: null,
    artifacts: {
      intake_ref: `iterations/${iterationId}/gate-a-intake/intake.json`,
      spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    },
  };
  writeFileSync(currentSpecPath, `${JSON.stringify(currentSpec, null, 2)}\n`, 'utf8');
  const metadataPath = path.join(artifactRoot, 'iterations', iterationId, 'iteration.json');
  writeFileSync(metadataPath, `${JSON.stringify({
    schema_version: 'p2a.iteration_metadata.v1',
    project_id: currentSpec.project_id,
    iteration_id: iterationId,
    status: 'gate_b_approved',
    opened_at: '2026-07-29T00:00:00.000Z',
    idea: intake.idea,
    baseline: {
      iteration_id: null,
      current_spec_ref: 'current-spec.json',
      effective_spec_ref: null,
    },
    planning_memory: null,
  }, null, 2)}\n`, 'utf8');
  return artifactRoot;
}

function proposalPatchDraft() {
  return {
    schema_version: 'p2a.proposal_patch_draft.v1',
    draftId: 'proposal-patch-draft-aaaaaaaaaaaa',
    generatedAt: '2026-07-19T00:00:00.000Z',
    sourceCuration: 'fixture-curation.json',
    candidateId: 'candidate-bbbbbbbbbbbb',
    classification: 'maintenance_fix',
    target: 'project',
    targetRepo: null,
    targetArea: null,
    title: 'Serialize maintenance graph updates',
    status: 'draft',
    approvalRequired: true,
    autoApplyAllowed: false,
    targetFiles: ['docs/fixture.md'],
    intendedChanges: [{
      file: 'docs/fixture.md',
      changeType: 'update',
      description: 'Exercise the approval graph writer.',
    }],
    verificationPlan: [{ type: 'custom', command: 'node --test', required: true }],
    risks: [],
    rationale: 'The fixture verifies that approval waits for the shared graph lock.',
  };
}

function initGitWorkspace(workspace, options = {}) {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'baseline.txt'), 'baseline\n', 'utf8');
  for (const args of [
    ['init'],
    ['add', 'baseline.txt'],
    ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Test', 'commit', '-m', 'initial'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: options.env ?? process.env,
    });
    assert.equal(result.status, 0, result.stderr);
  }
}

function gitHooksEnv(hooksPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = hooksPath;
  return env;
}

function installBlockingPostCheckoutHook(workspace, readyPath, releasePath) {
  const hookPath = path.join(workspace, '.git', 'hooks', 'post-checkout');
  writeFileSync(hookPath, [
    '#!/usr/bin/env node',
    "const { existsSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n');`,
    'const waitBuffer = new Int32Array(new SharedArrayBuffer(4));',
    `while (!existsSync(${JSON.stringify(releasePath)})) Atomics.wait(waitBuffer, 0, 0, 25);`,
  ].join('\n'), 'utf8');
  if (process.platform !== 'win32') chmodSync(hookPath, 0o755);
}

function installFailingBlockingPostCheckoutHook(workspace, readyPath, releasePath) {
  const hookPath = path.join(workspace, '.git', 'hooks', 'post-checkout');
  writeFileSync(hookPath, [
    '#!/usr/bin/env node',
    "const { existsSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n');`,
    'const waitBuffer = new Int32Array(new SharedArrayBuffer(4));',
    `while (!existsSync(${JSON.stringify(releasePath)})) Atomics.wait(waitBuffer, 0, 0, 25);`,
    'process.exitCode = 1;',
  ].join('\n'), 'utf8');
  if (process.platform !== 'win32') chmodSync(hookPath, 0o755);
}

function pendingStartedRunTransaction(graphPath, graph, taskId = 'task-002') {
  const now = '2026-07-19T00:00:00.000Z';
  const run = {
    schema_version: 'p2a.run.v1',
    runId: 'run-unrelated-pending',
    projectId: graph.projectId,
    taskId,
    taskTitle: graph.tasks.find((task) => task.id === taskId)?.title ?? 'Unrelated task',
    iterationId: graph.version,
    sourceLayout: 'graph',
    taskGraphRef: canonicalTaskGraphRef(graphPath),
    sourceSpecRef: graph.sourceSpec,
    agentTool: 'codex',
    workspaceRef: 'unrelated-workspace',
    workspacePath: path.dirname(graphPath),
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
  const runRef = canonicalRunRef(run);
  return {
    schema_version: 'p2a.run_write_transaction.v1',
    runRef,
    run,
    index: {
      schema_version: 'p2a.run_index.v1',
      projectId: graph.projectId,
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
    },
  };
}

function sequentialTracking() {
  return { runIdStrategy: 'task-sequence', runIdPattern: 'run-<taskId>-<sequence:3>' };
}

function retryReservationToken(output) {
  const match = output.match(/--run-reservation-token ([A-Za-z0-9-]+)/);
  assert.ok(match, `missing reservation token in retry output:\n${output}`);
  return match[1];
}

test('keeps timestamp ids as the backward-compatible default', () => {
  const runsDir = path.join(tempRoot('timestamp-run-id'), 'runs');
  const now = new Date('2026-07-12T08:00:00.123Z');

  assert.equal(previewRunId(runsDir, 'task-008', {}, now), 'run-2026-07-12T08-00-00-123Z-task-008');
});

test('allocates task-scoped sequential ids atomically across concurrent processes', async () => {
  const runsDir = path.join(tempRoot('concurrent-run-id'), 'runs');
  mkdirSync(runsDir, { recursive: true });
  const script = [
    `import { allocateRunId } from ${JSON.stringify(RUN_ID_MODULE_URL)};`,
    `const allocation = allocateRunId(${JSON.stringify(runsDir)}, 'task-008', ${JSON.stringify(sequentialTracking())});`,
    'process.stdout.write(allocation.runId);',
  ].join('\n');

  const ids = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `allocator exited ${code}`));
      else resolve(stdout);
    });
  })));

  assert.deepEqual([...ids].sort(), [
    'run-task-008-001',
    'run-task-008-002',
    'run-task-008-003',
    'run-task-008-004',
    'run-task-008-005',
    'run-task-008-006',
    'run-task-008-007',
    'run-task-008-008',
  ]);
});

test('creates a fresh worktree before validating the same path passed as workspace', () => {
  const root = tempRoot('fresh-worktree-workspace');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const repository = path.join(root, 'repository');
  const worktree = path.join(root, 'worktree');
  try {
    mkdirSync(path.dirname(graphPath), { recursive: true });
    writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
    initGitWorkspace(repository);

    const result = runCli([
      'start',
      '--graph', graphPath,
      '--task', 'task-001',
      '--run-id', 'run-fresh-worktree-workspace',
      '--agent-tool', 'codex',
      '--workspace', worktree,
      '--isolation', 'worktree',
      '--worktree', worktree,
      '--base-ref', 'HEAD',
      '--create-isolation',
    ], repository);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(worktree), true);
    const run = JSON.parse(
      readFileSync(runFilePath(path.join(root, 'runs'), 'run-fresh-worktree-workspace'), 'utf8'),
    );
    assert.equal(run.workspacePath, path.resolve(worktree));
    assert.equal(run.isolation.created, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves an allocated id across isolation failure and explicit retry', () => {
  const root = tempRoot('run-id-retry');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  const worktree = path.join(root, 'worktree');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  writeFileSync(path.join(root, 'project.config.json'), `${JSON.stringify({
    schema_version: 'p2a.project_config.v1',
    projectId: 'webhook-api-service',
    runTracking: sequentialTracking(),
  }, null, 2)}\n`, 'utf8');
  initGitWorkspace(workspace);

  const baseArgs = [
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex',
    '--workspace', workspace, '--isolation', 'worktree', '--worktree', worktree, '--create-isolation',
  ];
  let result = runCli([...baseArgs, '--base-ref', 'refs/heads/p2a-missing-ref']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Retry with the same run id/);
  assert.match(result.stderr, /--run-id run-task-001-001/);
  const reservationToken = retryReservationToken(result.stderr);

  result = runCli([...baseArgs, '--base-ref', 'HEAD', '--run-id', 'run-task-001-001']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reserved by another start attempt/);

  const branchResult = spawnSync('git', ['branch', 'p2a/task-001-run-task-001-001', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(branchResult.status, 0, branchResult.stderr);

  result = runCli([
    ...baseArgs, '--base-ref', 'HEAD', '--run-id', 'run-task-001-001',
    '--run-reservation-token', reservationToken,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(runFilePath(path.join(root, 'runs'), 'run-task-001-001')));
  assert.equal(existsSync(path.join(root, 'runs', '.run-id-reservations', 'run-task-001-001.json')), false);

  result = runCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', workspace,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plan2Agent run started: run-task-001-002/);

  result = runCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--run-id', 'run-explicit-override',
    '--agent-tool', 'codex', '--workspace', workspace,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(runFilePath(path.join(root, 'runs'), 'run-explicit-override')));
});

test('p2a_execute prints an exact same-id retry and completes with that identity', () => {
  const root = tempRoot('execute-run-id-retry');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  const worktree = path.join(root, 'worktree');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  writeFileSync(path.join(root, 'project.config.json'), `${JSON.stringify({
    schema_version: 'p2a.project_config.v1',
    projectId: 'webhook-api-service',
    runTracking: sequentialTracking(),
  }, null, 2)}\n`, 'utf8');
  initGitWorkspace(workspace);

  const baseArgs = [
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex',
    '--workspace', workspace, '--isolation', 'worktree', '--worktree', worktree, '--create-isolation',
  ];
  let result = executeCli([...baseArgs, '--base-ref', 'refs/heads/p2a-missing-ref']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /retry with the same reserved run id/i);
  assert.match(result.stderr, /p2a execute start .*--run-id run-task-001-001/);
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks.find((task) => task.id === 'task-001')?.status, 'todo');
  const reservationToken = retryReservationToken(result.stderr);

  result = executeCli([
    ...baseArgs, '--base-ref', 'HEAD', '--run-id', 'run-task-001-001',
    '--run-reservation-token', reservationToken,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(
    readFileSync(runFilePath(path.join(root, 'runs'), 'run-task-001-001'), 'utf8'),
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(run.runId, 'run-task-001-001');
  assert.equal(run.isolation.created, true);
  assert.equal(graph.tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
});

test('p2a_execute permits only one concurrent start for the same task', async () => {
  const root = tempRoot('execute-concurrent-task-start');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');

  const args = [
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', workspace,
  ];
  const results = await Promise.all([executeCliAsync(args), executeCliAsync(args)]);
  const successful = results.filter((result) => result.status === 0);
  const rejected = results.filter((result) => result.status !== 0);
  assert.equal(successful.length, 1, results.map((result) => result.stderr).join('\n'));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].stderr, /not ready; status is in_progress/);

  const index = JSON.parse(readFileSync(path.join(root, 'runs', 'run-index.json'), 'utf8'));
  assert.equal(index.runs.length, 1);
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
});

test('direct task transitions participate in the shared task-graph lock', async () => {
  const root = tempRoot('task-transition-graph-lock');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');

  let transitionPromise;
  withRunStoreLocks([path.dirname(graphPath)], () => {
    transitionPromise = taskCliAsync(['start', '--graph', graphPath, 'task-001']);
    Atomics.wait(WAIT_BUFFER, 0, 0, 500);
    const graphWhileLocked = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(graphWhileLocked.tasks.find((task) => task.id === 'task-001')?.status, 'todo');
  });

  const result = await transitionPromise;
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(graph.tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
});

test('iteration open rejects an effective spec pointer outside the artifact root', () => {
  const artifactRoot = initializedArtifactRoot('iteration-open-external-baseline');
  const externalRoot = tempRoot('iteration-open-external-spec');
  const externalSpecPath = path.join(externalRoot, 'spec.json');
  try {
    closeInitializedIteration(artifactRoot);
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    const canonicalSpecPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-b-spec',
      'spec.json',
    );
    writeFileSync(externalSpecPath, readFileSync(canonicalSpecPath, 'utf8'), 'utf8');
    currentSpec.effective_spec_ref = externalSpecPath;
    writeFileSync(currentSpecPath, `${JSON.stringify(currentSpec, null, 2)}\n`, 'utf8');

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'open',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'v2-external',
      '--idea',
      'Reject an external baseline',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /must resolve inside the artifact root/);
    assert.equal(existsSync(path.join(artifactRoot, 'iterations', 'v2-external')), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('iteration open serializes concurrent state changes without orphan iterations', async () => {
  const artifactRoot = initializedArtifactRoot('iteration-open-state-lock');
  try {
    closeInitializedIteration(artifactRoot);
    const ids = ['v2-concurrent-a', 'v2-concurrent-b'];
    const results = await Promise.all(ids.map((iterationId) => iterationCliAsync([
      'open',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      iterationId,
      '--idea',
      `Open ${iterationId}`,
    ])));
    const successfulIndexes = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status === 0);
    const rejectedIndexes = results
      .map((result, index) => ({ result, index }))
      .filter(({ result }) => result.status !== 0);
    assert.equal(successfulIndexes.length, 1, results.map((result) => result.stderr).join('\n'));
    assert.equal(rejectedIndexes.length, 1);
    assert.match(
      `${rejectedIndexes[0].result.stdout}${rejectedIndexes[0].result.stderr}`,
      /open requires no pending_iteration/,
    );

    const successfulId = ids[successfulIndexes[0].index];
    const rejectedId = ids[rejectedIndexes[0].index];
    const currentSpec = JSON.parse(readFileSync(
      path.join(artifactRoot, 'current-spec.json'),
      'utf8',
    ));
    assert.equal(currentSpec.active_iteration, successfulId);
    assert.equal(currentSpec.pending_iteration?.iteration_id, successfulId);
    assert.equal(existsSync(path.join(artifactRoot, 'iterations', successfulId)), true);
    assert.equal(existsSync(path.join(artifactRoot, 'iterations', rejectedId)), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('compose and close share the artifact-state lock and preserve pending until close', async () => {
  const artifactRoot = initializedArtifactRoot('iteration-compose-state-lock');
  try {
    const { currentSpecPath, secondIterationId } =
      prepareCloseReadySecondIteration(artifactRoot);
    const stateLockDir = path.join(artifactRoot, 'iterations');
    const beforeCompose = readFileSync(currentSpecPath, 'utf8');
    let composePromise;
    withRunStoreLocks([stateLockDir], () => {
      composePromise = iterationCliAsync([
        'compose',
        '--artifacts',
        artifactRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforeCompose,
        'compose changed current-spec.json before acquiring the artifact-state lock',
      );
    });

    const composeResult = await composePromise;
    assert.equal(
      composeResult.status,
      0,
      `${composeResult.stdout}${composeResult.stderr}`,
    );
    const composedCurrentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    assert.equal(
      composedCurrentSpec.pending_iteration?.iteration_id,
      secondIterationId,
      'compose must not end an iteration before close archives it',
    );

    const beforeClose = readFileSync(currentSpecPath, 'utf8');
    let closePromise;
    withRunStoreLocks([stateLockDir], () => {
      closePromise = iterationCliAsync([
        'close',
        '--artifacts',
        artifactRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforeClose,
        'close changed current-spec.json before acquiring the artifact-state lock',
      );
    });

    const closeResult = await closePromise;
    assert.equal(
      closeResult.status,
      0,
      `${closeResult.stdout}${closeResult.stderr}`,
    );
    const closedCurrentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    assert.equal(closedCurrentSpec.pending_iteration, undefined);
    assert.equal(
      closedCurrentSpec.source_specs.find(
        (source) => source.iteration_id === secondIterationId,
      )?.status,
      'archived',
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('failed compose restores current spec when status rendering fails', () => {
  const artifactRoot = initializedArtifactRoot('iteration-compose-rollback');
  try {
    const { currentSpecPath } = prepareCloseReadySecondIteration(artifactRoot);
    const statusPath = path.join(artifactRoot, 'status.md');
    const beforeCompose = readFileSync(currentSpecPath, 'utf8');
    rmSync(statusPath);
    mkdirSync(statusPath);

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'compose',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(currentSpecPath, 'utf8'), beforeCompose);
    assert.equal(lstatSync(statusPath).isDirectory(), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('iteration close participates in the active task-graph lock', async () => {
  const artifactRoot = initializedArtifactRoot('iteration-close-graph-lock');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks = graph.tasks.map((task) => ({ ...task, status: 'done' }));
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const beforeClose = readFileSync(currentSpecPath, 'utf8');
    let closePromise;
    withRunStoreLocks([path.dirname(graphPath)], () => {
      closePromise = iterationCliAsync([
        'close',
        '--artifacts',
        artifactRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforeClose,
        'close changed current-spec.json before acquiring the task-graph lock',
      );
    });

    const result = await closePromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    assert.equal(currentSpec.pending_iteration, undefined);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('Gate B promotion participates in the artifact-state lock', async () => {
  const artifactRoot = initializedArtifactRoot('promote-spec-state-lock');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const beforePromotion = readFileSync(currentSpecPath, 'utf8');
    let promotionPromise;
    withRunStoreLocks([path.join(artifactRoot, 'iterations')], () => {
      promotionPromise = iterationCliAsync([
        'promote-spec',
        '--artifacts',
        artifactRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforePromotion,
        'promote-spec changed current-spec.json before acquiring the artifact-state lock',
      );
    });

    const result = await promotionPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('failed Gate B promotion restores current spec and iteration metadata', () => {
  const artifactRoot = initializedArtifactRoot('promote-spec-rollback');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const metadataPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'iteration.json',
    );
    const currentSpecBefore = readFileSync(currentSpecPath);
    assert.equal(existsSync(metadataPath), false);
    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'promote-spec',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.deepEqual(readFileSync(currentSpecPath), currentSpecBefore);
    assert.equal(existsSync(metadataPath), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('handoff recording participates in the artifact-state lock', async () => {
  const artifactRoot = initializedArtifactRoot('handoff-state-lock');
  const targetParent = tempRoot('handoff-state-lock-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const beforeHandoff = readFileSync(currentSpecPath, 'utf8');
    let handoffPromise;
    withRunStoreLocks([path.join(artifactRoot, 'iterations')], () => {
      handoffPromise = handoffCliAsync([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        artifactRoot,
        '--target',
        targetRoot,
        '--include-intake',
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 1000);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforeHandoff,
        'handoff changed current-spec.json before acquiring the artifact-state lock',
      );
      assert.equal(
        existsSync(targetRoot),
        false,
        'handoff wrote the target before acquiring the source artifact-state lock',
      );
    });

    const result = await handoffPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    assert.equal(currentSpec.handoff_records?.length, 1);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('handoff waits for the active task-graph lock before validating or writing', async () => {
  const artifactRoot = initializedArtifactRoot('handoff-task-graph-lock');
  const targetParent = tempRoot('handoff-task-graph-lock-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const beforeHandoff = readFileSync(currentSpecPath, 'utf8');
    let handoffPromise;
    withRunStoreLocks([path.dirname(graphPath)], () => {
      handoffPromise = handoffCliAsync([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        artifactRoot,
        '--target',
        targetRoot,
        '--include-intake',
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        readFileSync(currentSpecPath, 'utf8'),
        beforeHandoff,
        'handoff recorded source state before acquiring the active task-graph lock',
      );
      assert.equal(
        existsSync(targetRoot),
        false,
        'handoff wrote the target before acquiring the active task-graph lock',
      );
    });

    const result = await handoffPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json')), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('handoff waits for the maintenance task-graph lock before snapshotting', async () => {
  const artifactRoot = initializedArtifactRoot('handoff-maintenance-graph-lock');
  const targetParent = tempRoot('handoff-maintenance-graph-lock-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    let result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'maintenance',
      'add',
      '--artifacts',
      artifactRoot,
      '--title',
      'Serialize maintenance handoff',
      '--accept',
      'The handoff snapshot includes the complete graph',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const graphDir = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
    );
    let handoffPromise;
    withRunStoreLocks([graphDir], () => {
      handoffPromise = handoffCliAsync([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        artifactRoot,
        '--target',
        targetRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        existsSync(targetRoot),
        false,
        'handoff wrote the target before acquiring the maintenance graph lock',
      );
    });

    result = await handoffPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('handoff waits for the global runs lock before snapshotting evidence', async () => {
  const artifactRoot = initializedArtifactRoot('handoff-runs-lock');
  const targetParent = tempRoot('handoff-runs-lock-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(runsDir);
    let handoffPromise;
    withRunStoreLocks([runsDir], () => {
      handoffPromise = handoffCliAsync([
        '--project-id',
        'webhook-api-service',
        '--artifacts',
        artifactRoot,
        '--target',
        targetRoot,
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        existsSync(targetRoot),
        false,
        'handoff wrote the target before acquiring the runs lock',
      );
    });

    const result = await handoffPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('failed source handoff recording removes newly written target files', () => {
  const artifactRoot = initializedArtifactRoot('handoff-target-rollback');
  const targetParent = tempRoot('handoff-target-rollback-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpecBefore = readFileSync(currentSpecPath);
    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);

    const result = spawnSync(process.execPath, [
      HANDOFF_CLI,
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      artifactRoot,
      '--target',
      targetRoot,
      '--include-intake',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.deepEqual(readFileSync(currentSpecPath), currentSpecBefore);
    assert.equal(
      existsSync(targetRoot),
      false,
      'a failed handoff must remove a target tree that did not exist before the command',
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('failed handoff restores the mode of overwritten target files', {
  skip: process.platform === 'win32',
}, () => {
  const artifactRoot = initializedArtifactRoot('handoff-target-mode-rollback');
  const targetParent = tempRoot('handoff-target-mode-rollback-target');
  const targetRoot = path.join(targetParent, 'target');
  try {
    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);
    const targetScriptPath = path.join(
      targetRoot,
      '.plan2agent',
      'scripts',
      'p2a.mjs',
    );
    mkdirSync(path.dirname(targetScriptPath), { recursive: true });
    writeFileSync(targetScriptPath, 'sentinel\n', 'utf8');
    chmodSync(targetScriptPath, 0o600);

    const result = spawnSync(process.execPath, [
      HANDOFF_CLI,
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      artifactRoot,
      '--target',
      targetRoot,
      '--overwrite',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(targetScriptPath, 'utf8'), 'sentinel\n');
    assert.equal(statSync(targetScriptPath).mode & 0o777, 0o600);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('failed move restores staged source artifacts and rolls back the target', {
  skip: process.platform === 'win32',
}, () => {
  const artifactRoot = tempRoot('handoff-move-rollback');
  const targetParent = tempRoot('handoff-move-rollback-target');
  const targetRoot = path.join(targetParent, 'target');
  const protectedDir = path.join(artifactRoot, 'gate-d-review');
  try {
    cpSync(
      path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'),
      artifactRoot,
      { recursive: true },
    );
    chmodSync(protectedDir, 0o555);

    const result = spawnSync(process.execPath, [
      HANDOFF_CLI,
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      artifactRoot,
      '--target',
      targetRoot,
      '--mode',
      'move',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /EACCES|permission denied/);
    assert.equal(
      existsSync(path.join(artifactRoot, 'gate-b-spec', 'spec.json')),
      true,
    );
    assert.equal(
      existsSync(path.join(artifactRoot, 'gate-d-review', 'review.json')),
      true,
    );
    assert.equal(existsSync(targetRoot), false);
  } finally {
    if (existsSync(protectedDir)) chmodSync(protectedDir, 0o755);
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});

test('failed close restores current spec and iteration metadata', () => {
  const artifactRoot = initializedArtifactRoot('iteration-close-rollback');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks = graph.tasks.map((task) => ({ ...task, status: 'done' }));
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const metadataPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'iteration.json',
    );
    writeFileSync(metadataPath, `${JSON.stringify({
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: 'webhook-api-service',
      iteration_id: 'v1-mvp',
      status: 'gate_b_approved',
      planning_memory: null,
    }, null, 2)}\n`, 'utf8');
    const currentSpecBefore = readFileSync(currentSpecPath);
    const metadataBefore = readFileSync(metadataPath);
    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'close',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.deepEqual(readFileSync(currentSpecPath), currentSpecBefore);
    assert.deepEqual(readFileSync(metadataPath), metadataBefore);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('close rollback restores a pre-existing Memory freshness report', () => {
  const root = tempRoot('iteration-close-memory-rollback');
  try {
    const paths = {
      metadataPath: path.join(root, 'iteration.json'),
      currentSpecPath: path.join(root, 'current-spec.json'),
      statusPath: path.join(root, 'status.md'),
      memoryStatusPath: path.join(root, 'memory-status.json'),
    };
    for (const [name, filePath] of Object.entries(paths)) {
      writeFileSync(filePath, `${name}:before\n`, 'utf8');
    }

    assert.throws(
      () => withIterationCloseRollback(paths, () => {
        for (const [name, filePath] of Object.entries(paths)) {
          writeFileSync(filePath, `${name}:after\n`, 'utf8');
        }
        throw new Error('injected final close write failure');
      }),
      /injected final close write failure/,
    );
    for (const [name, filePath] of Object.entries(paths)) {
      assert.equal(readFileSync(filePath, 'utf8'), `${name}:before\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed non-force draft restores Gate A artifacts and iteration state', () => {
  const artifactRoot = initializedArtifactRoot('iteration-draft-rollback');
  try {
    closeInitializedIteration(artifactRoot);
    let result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'open',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'v2-draft-rollback',
      '--idea',
      'Add an audit dashboard',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const iterationRoot = path.join(
      artifactRoot,
      'iterations',
      'v2-draft-rollback',
    );
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const metadataPath = path.join(iterationRoot, 'iteration.json');
    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const currentSpecBefore = readFileSync(currentSpecPath);
    const metadataBefore = readFileSync(metadataPath);
    assert.equal(existsSync(intakePath), false);

    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);
    result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'draft',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.deepEqual(readFileSync(currentSpecPath), currentSpecBefore);
    assert.deepEqual(readFileSync(metadataPath), metadataBefore);
    assert.equal(existsSync(intakePath), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('failed non-force draft does not rewrite downstream task graph files', () => {
  const artifactRoot = initialGateAForceResetArtifactRoot(
    'iteration-draft-downstream-rollback',
  );
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graphInodeBefore = statSync(graphPath).ino;

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'draft',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /draft files already exist/);
    assert.equal(statSync(graphPath).ino, graphInodeBefore);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('archived artifact audits reject references outside the artifact root', () => {
  const artifactRoot = initializedArtifactRoot('archive-audit-containment');
  const outsideRoot = tempRoot('archive-audit-outside');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks = graph.tasks.map((task) => ({ ...task, status: 'done' }));
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    let result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'close',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const outsidePath = path.join(outsideRoot, 'outside.txt');
    writeFileSync(outsidePath, 'outside\n', 'utf8');
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.closed_iterations[0].artifact_hashes[outsidePath] = {
      present: true,
      sha256: createHash('sha256')
        .update(readFileSync(outsidePath))
        .digest('hex'),
    };
    writeFileSync(
      currentSpecPath,
      `${JSON.stringify(currentSpec, null, 2)}\n`,
      'utf8',
    );

    result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'validate',
      '--artifacts',
      artifactRoot,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /artifact reference must be artifact-root-relative/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('maintenance add participates in the shared task-graph lock', async () => {
  const artifactRoot = initializedArtifactRoot('maintenance-add-graph-lock');
  const graphPath = path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');

  let addPromise;
  withRunStoreLocks([path.dirname(graphPath)], () => {
    addPromise = iterationCliAsync([
      'maintenance',
      'add',
      '--artifacts',
      artifactRoot,
      '--title',
      'Locked maintenance task',
      '--accept',
      'The task is appended after the graph lock is released.',
    ]);
    Atomics.wait(WAIT_BUFFER, 0, 0, 500);
    assert.equal(existsSync(graphPath), false);
  });

  const result = await addPromise;
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(graph.tasks.length, 1);
  assert.equal(graph.tasks[0].title, 'Locked maintenance task');
});

test('failed maintenance add restores the task graph when status rendering fails', () => {
  const artifactRoot = initializedArtifactRoot('maintenance-add-rollback');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);

    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'maintenance',
      'add',
      '--artifacts',
      artifactRoot,
      '--title',
      'Rollback maintenance task',
      '--accept',
      'No graph remains after a failed status write',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.equal(existsSync(graphPath), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('proposal approval participates in the shared maintenance graph lock', async () => {
  const artifactRoot = initializedArtifactRoot('proposal-approval-graph-lock');
  const graphPath = path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
  const proposalsDir = path.join(artifactRoot, 'proposals');
  const draftPath = path.join(proposalsDir, 'patch-drafts', 'fixture.json');
  const approvalPath = path.join(proposalsDir, 'approvals', 'fixture.json');
  mkdirSync(path.dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, `${JSON.stringify(proposalPatchDraft(), null, 2)}\n`, 'utf8');

  let approvalPromise;
  withRunStoreLocks([path.dirname(graphPath)], () => {
    approvalPromise = proposalsCliAsync([
      'approve-draft',
      '--draft',
      draftPath,
      '--artifacts',
      artifactRoot,
      '--approved-by',
      'fixture-reviewer',
      '--proposals',
      proposalsDir,
      '--output',
      approvalPath,
    ]);
    Atomics.wait(WAIT_BUFFER, 0, 0, 500);
    assert.equal(existsSync(graphPath), false);
    assert.equal(existsSync(approvalPath), false);
  });

  const result = await approvalPromise;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(approvalPath), true);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(graph.tasks.length, 1);
  assert.ok(graph.tasks[0].sourceSpecRefs.includes('proposal-patch-draft:proposal-patch-draft-aaaaaaaaaaaa'));
});

test('failed proposal approval restores its maintenance graph update', () => {
  const artifactRoot = initializedArtifactRoot('proposal-approval-rollback');
  try {
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'maintenance',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const proposalsDir = path.join(artifactRoot, 'proposals');
    const draftPath = path.join(proposalsDir, 'patch-drafts', 'fixture.json');
    const approvalPath = path.join(proposalsDir, 'approvals', 'fixture.json');
    mkdirSync(path.dirname(draftPath), { recursive: true });
    writeFileSync(
      draftPath,
      `${JSON.stringify(proposalPatchDraft(), null, 2)}\n`,
      'utf8',
    );
    mkdirSync(approvalPath, { recursive: true });

    const result = spawnSync(process.execPath, [
      PROPOSALS_CLI,
      'approve-draft',
      '--draft',
      draftPath,
      '--artifacts',
      artifactRoot,
      '--approved-by',
      'fixture-reviewer',
      '--proposals',
      proposalsDir,
      '--output',
      approvalPath,
      '--overwrite',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /fixture\.json|EISDIR|directory/);
    assert.equal(existsSync(graphPath), false);
    assert.equal(lstatSync(approvalPath).isDirectory(), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('task graph replacement participates in graph and artifact-state locking', async () => {
  const artifactRoots = [];
  try {
    for (const lockKind of ['task-graph', 'artifact-state']) {
      const artifactRoot =
        initializedArtifactRoot(`promote-tasks-${lockKind}-lock`);
      artifactRoots.push(artifactRoot);
      const graphPath = path.join(
        artifactRoot,
        'iterations',
        'v1-mvp',
        'gate-c-task-graph',
        'task-graph.json',
      );
      const draftPath = path.join(
        path.dirname(graphPath),
        'task-graph.draft.json',
      );
      const canonicalBefore = readFileSync(graphPath, 'utf8');
      const draft = JSON.parse(canonicalBefore);
      draft.version = `${draft.version}-draft`;
      writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
      const lockDir = lockKind === 'task-graph'
        ? path.dirname(graphPath)
        : path.join(artifactRoot, 'iterations');

      let promotionPromise;
      withRunStoreLocks([lockDir], () => {
        promotionPromise = iterationCliAsync([
          'promote-tasks',
          '--artifacts',
          artifactRoot,
          '--replace-existing',
          '--approved-by',
          'fixture-reviewer',
          '--approval-note',
          'The replacement graph was reviewed for the lock regression.',
        ]);
        Atomics.wait(WAIT_BUFFER, 0, 0, 500);
        assert.equal(readFileSync(graphPath, 'utf8'), canonicalBefore);
        assert.equal(existsSync(draftPath), true);
      });

      const result = await promotionPromise;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(draftPath), false);
      assert.equal(existsSync(`${draftPath}.promoted`), true);
    }
  } finally {
    for (const artifactRoot of artifactRoots) {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  }
});

test('failed Gate C promotion restores the graph, draft, audit, and provenance', () => {
  const artifactRoot = initializedArtifactRoot('promote-tasks-rollback');
  try {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const draftPath = path.join(
      path.dirname(graphPath),
      'task-graph.draft.json',
    );
    const promotedPath = `${draftPath}.promoted`;
    const metaPath = path.join(
      path.dirname(graphPath),
      'task-graph.draft.meta.json',
    );
    const currentSpecBefore = readFileSync(currentSpecPath);
    const graphBefore = readFileSync(graphPath);
    const draft = JSON.parse(graphBefore.toString('utf8'));
    draft.version = `${draft.version}-draft`;
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    const draftBefore = readFileSync(draftPath);
    assert.equal(existsSync(promotedPath), false);
    assert.equal(existsSync(metaPath), false);

    const statusPath = path.join(artifactRoot, 'status.md');
    rmSync(statusPath);
    mkdirSync(statusPath);
    const result = spawnSync(process.execPath, [
      ITERATION_CLI,
      'promote-tasks',
      '--artifacts',
      artifactRoot,
      '--replace-existing',
      '--approved-by',
      'fixture-reviewer',
      '--approval-note',
      'The rollback fixture reviewed this replacement graph.',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /status\.md|EISDIR|directory/);
    assert.deepEqual(readFileSync(currentSpecPath), currentSpecBefore);
    assert.deepEqual(readFileSync(graphPath), graphBefore);
    assert.deepEqual(readFileSync(draftPath), draftBefore);
    assert.equal(existsSync(promotedPath), false);
    assert.equal(existsSync(metaPath), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('task graph replacement waits for the run-store lock before checking history', async () => {
  const artifactRoot = initializedArtifactRoot('promote-tasks-run-store-lock');
  const graphPath = path.join(artifactRoot, 'iterations', 'v1-mvp', 'gate-c-task-graph', 'task-graph.json');
  const draftPath = path.join(path.dirname(graphPath), 'task-graph.draft.json');
  const runsDir = path.join(artifactRoot, 'runs');
  const canonicalBefore = readFileSync(graphPath, 'utf8');
  const draft = JSON.parse(canonicalBefore);
  draft.version = `${draft.version}-draft`;
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  let promotionPromise;
  withRunStoreLocks([runsDir], () => {
    promotionPromise = iterationCliAsync([
      'promote-tasks',
      '--artifacts',
      artifactRoot,
      '--replace-existing',
      '--approved-by',
      'fixture-reviewer',
      '--approval-note',
      'The replacement graph was reviewed for the run-store lock regression.',
    ]);
    Atomics.wait(WAIT_BUFFER, 0, 0, 500);
    assert.equal(readFileSync(graphPath, 'utf8'), canonicalBefore);
    assert.equal(existsSync(draftPath), true);
  });

  const result = await promotionPromise;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(draftPath), false);
  assert.equal(existsSync(`${draftPath}.promoted`), true);
});

test('diff-tasks force waits for the run-store lock before replacing its draft', async () => {
  const artifactRoot = initializedArtifactRoot('diff-tasks-run-lock');
  try {
    const runsDir = path.join(artifactRoot, 'runs');
    const draftPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.draft.json',
    );
    let diffPromise;
    withRunStoreLocks([runsDir], () => {
      diffPromise = iterationCliAsync([
        'diff-tasks',
        '--artifacts',
        artifactRoot,
        '--force',
      ]);
      Atomics.wait(WAIT_BUFFER, 0, 0, 500);
      assert.equal(
        existsSync(draftPath),
        false,
        'diff-tasks wrote its draft before acquiring the run-store lock',
      );
    });

    const result = await diffPromise;
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(draftPath), true);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('Gate A force reset waits for artifact-state, task-graph, and run-store locks', async () => {
  const artifactRoots = [];
  try {
    for (const lockKind of ['artifact-state', 'task-graph', 'run-store']) {
      const artifactRoot = initialGateAForceResetArtifactRoot(`gate-a-force-${lockKind}-lock`);
      artifactRoots.push(artifactRoot);
      const graphPath = path.join(
        artifactRoot,
        'iterations',
        'v1-mvp',
        'gate-c-task-graph',
        'task-graph.json',
      );
      const lockDir = lockKind === 'artifact-state'
        ? path.join(artifactRoot, 'iterations')
        : lockKind === 'task-graph'
          ? path.dirname(graphPath)
          : path.join(artifactRoot, 'runs');

      let resetPromise;
      withRunStoreLocks([lockDir], () => {
        resetPromise = iterationCliAsync([
          'draft',
          '--artifacts',
          artifactRoot,
          '--force',
        ]);
        Atomics.wait(WAIT_BUFFER, 0, 0, 500);
        assert.equal(
          existsSync(graphPath),
          true,
          `draft --force invalidated the graph before acquiring the ${lockKind} lock`,
        );
      });

      const result = await resetPromise;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(graphPath), false);
    }
  } finally {
    for (const artifactRoot of artifactRoots) {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  }
});

test('direct run start rejects a task graph replaced while isolation is preparing', async () => {
  const artifactRoot = initializedArtifactRoot('run-start-graph-replacement');
  const graphPath = path.join(artifactRoot, 'iterations', 'v1-mvp', 'gate-c-task-graph', 'task-graph.json');
  const draftPath = path.join(path.dirname(graphPath), 'task-graph.draft.json');
  const runsDir = path.join(artifactRoot, 'runs');
  const workspace = path.join(tempRoot('run-start-graph-replacement-workspace'), 'workspace');
  const hookControlDir = tempRoot('run-start-graph-replacement-hook');
  const readyPath = path.join(hookControlDir, 'isolation-ready');
  const releasePath = path.join(hookControlDir, 'isolation-release');
  const runId = 'run-graph-replacement-race';
  const gitEnv = gitHooksEnv(path.join(workspace, '.git', 'hooks'));
  initGitWorkspace(workspace, { env: gitEnv });
  installBlockingPostCheckoutHook(workspace, readyPath, releasePath);

  const draft = JSON.parse(readFileSync(graphPath, 'utf8'));
  draft.version = `${draft.version}-draft`;
  draft.tasks[0].title = `${draft.tasks[0].title} (replacement)`;
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  const startPromise = runCliAsync([
    'start',
    '--artifacts', artifactRoot,
    '--task', 'task-001',
    '--run-id', runId,
    '--agent-tool', 'codex',
    '--workspace', workspace,
    '--isolation', 'branch',
    '--branch', 'p2a/graph-replacement-race',
    '--create-isolation',
  ], ROOT, { env: gitEnv });

  let promotionResult;
  try {
    await waitForPath(readyPath);
    promotionResult = spawnSync(process.execPath, [
      ITERATION_CLI,
      'promote-tasks',
      '--artifacts', artifactRoot,
      '--replace-existing',
      '--approved-by', 'fixture-reviewer',
      '--approval-note', 'Replace the graph while a direct run start is preparing isolation.',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(promotionResult.status, 0, promotionResult.stderr);
  } finally {
    writeFileSync(releasePath, 'release\n', 'utf8');
  }

  const startResult = await startPromise;
  assert.equal(startResult.status, 1, startResult.stderr);
  assert.match(startResult.stderr, /task graph changed while run .* was preparing isolation/i);
  assert.equal(existsSync(runFilePath(runsDir, runId)), false);
  assert.equal(existsSync(path.join(runsDir, 'run-index.json')), false);
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].title, draft.tasks[0].title);
});

test('p2a_execute keeps a task claimed when pending run recovery blocks start', () => {
  const root = tempRoot('execute-pending-run-write');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  const runsDir = path.join(root, 'runs');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  writeFileSync(runWriteTransactionPath(runsDir), '{invalid pending transaction', 'utf8');

  const result = executeCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', workspace,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /remains in_progress because started-run evidence could not be ruled out/);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(graph.tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
  assert.equal(existsSync(runWriteTransactionPath(runsDir)), true);
});

test('p2a_execute rolls back a failed start when a pending run belongs to another task', async () => {
  const root = tempRoot('execute-unrelated-pending-run-write');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  const worktree = path.join(root, 'worktree');
  const runsDir = path.join(root, 'runs');
  const readyPath = path.join(root, 'hook-ready');
  const releasePath = path.join(root, 'hook-release');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const gitEnv = gitHooksEnv(path.join(workspace, '.git', 'hooks'));
  initGitWorkspace(workspace, { env: gitEnv });
  installFailingBlockingPostCheckoutHook(workspace, readyPath, releasePath);

  const startPromise = executeCliAsync([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex',
    '--workspace', workspace, '--isolation', 'worktree', '--worktree', worktree,
    '--base-ref', 'HEAD', '--create-isolation',
  ], ROOT, { env: gitEnv });
  try {
    await waitForPath(readyPath);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      runWriteTransactionPath(runsDir),
      `${JSON.stringify(pendingStartedRunTransaction(graphPath, graph), null, 2)}\n`,
      'utf8',
    );
  } finally {
    writeFileSync(releasePath, 'release\n', 'utf8');
  }

  const result = await startPromise;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /returned to todo because run .* did not start/);
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).tasks[0].status, 'todo');
  assert.equal(existsSync(runWriteTransactionPath(runsDir)), true);
});

test('preflight workspace failures do not consume a sequential id', () => {
  const root = tempRoot('run-id-preflight');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const missingWorkspace = path.join(root, 'missing-workspace');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  writeFileSync(path.join(root, 'project.config.json'), `${JSON.stringify({
    schema_version: 'p2a.project_config.v1',
    projectId: 'webhook-api-service',
    runTracking: sequentialTracking(),
  }, null, 2)}\n`, 'utf8');

  let result = runCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', missingWorkspace,
  ]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(path.join(root, 'runs', '.run-id-reservations')), false);

  mkdirSync(missingWorkspace, { recursive: true });
  result = runCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', missingWorkspace,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plan2Agent run started: run-task-001-001/);
});

test('p2a_execute validates isolation defaults before reserving an id', () => {
  const root = tempRoot('execute-run-id-preflight');
  const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
  const workspace = path.join(root, 'workspace');
  mkdirSync(path.dirname(graphPath), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(graphPath, readFileSync(TASK_GRAPH_FIXTURE, 'utf8'), 'utf8');
  writeFileSync(path.join(root, 'project.config.json'), `${JSON.stringify({
    schema_version: 'p2a.project_config.v1',
    projectId: 'webhook-api-service',
    runTracking: { ...sequentialTracking(), defaultIsolation: 'invalid' },
  }, null, 2)}\n`, 'utf8');

  const result = executeCli([
    'start', '--graph', graphPath, '--task', 'task-001', '--agent-tool', 'codex', '--workspace', workspace,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /defaultIsolation must be one of/);
  assert.equal(existsSync(path.join(root, 'runs', '.run-id-reservations')), false);
});

test('never reuses a reserved sequence when the run artifact is absent', () => {
  const runsDir = path.join(tempRoot('reserved-run-id'), 'runs');
  const first = allocateRunId(runsDir, 'task-008', sequentialTracking());
  const second = allocateRunId(runsDir, 'task-008', sequentialTracking());

  assert.equal(first.runId, 'run-task-008-001');
  assert.equal(second.runId, 'run-task-008-002');
});
