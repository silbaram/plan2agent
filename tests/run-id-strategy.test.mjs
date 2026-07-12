import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { allocateRunId, previewRunId } from '../scripts/p2a_project_config.mjs';
import { EXECUTE_CLI, ROOT, RUNS_CLI } from './helpers/fixtures.mjs';

const TASK_GRAPH_FIXTURE = path.join(ROOT, 'fixtures', 'webhook-api-service', 'task-graph.json');
const RUN_ID_MODULE_URL = pathToFileURL(path.join(ROOT, 'scripts', 'p2a_project_config.mjs')).href;

function tempRoot(label) {
  return mkdtempSync(path.join(tmpdir(), `p2a-${label}-`));
}

function runCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], { cwd, encoding: 'utf8' });
}

function executeCli(args, cwd = ROOT) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], { cwd, encoding: 'utf8' });
}

function initGitWorkspace(workspace) {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'baseline.txt'), 'baseline\n', 'utf8');
  for (const args of [
    ['init'],
    ['add', 'baseline.txt'],
    ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Test', 'commit', '-m', 'initial'],
  ]) {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
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
  assert.ok(existsSync(path.join(root, 'runs', 'run-task-001-001.json')));
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
  assert.ok(existsSync(path.join(root, 'runs', 'run-explicit-override.json')));
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
  assert.match(result.stderr, /p2a\.mjs execute start .*--run-id run-task-001-001/);
  const reservationToken = retryReservationToken(result.stderr);

  result = executeCli([
    ...baseArgs, '--base-ref', 'HEAD', '--run-id', 'run-task-001-001',
    '--run-reservation-token', reservationToken,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const run = JSON.parse(readFileSync(path.join(root, 'runs', 'run-task-001-001.json'), 'utf8'));
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  assert.equal(run.runId, 'run-task-001-001');
  assert.equal(run.isolation.created, true);
  assert.equal(graph.tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
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
