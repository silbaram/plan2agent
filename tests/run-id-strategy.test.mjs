import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { allocateRunId, previewRunId } from '../scripts/p2a_project_config.mjs';
import { runFilePath } from '../scripts/p2a_run_paths.mjs';
import { runWriteTransactionPath, withRunStoreLocks } from '../scripts/p2a_run_store.mjs';
import {
  E2E_FIXTURE_ROOT,
  EXECUTE_CLI,
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

function executeCliAsync(args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXECUTE_CLI, ...args], { cwd, encoding: 'utf8' });
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
  assert.match(result.stderr, /p2a\.mjs execute start .*--run-id run-task-001-001/);
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

test('task graph replacement participates in graph and run-store locking', async () => {
  const artifactRoot = initializedArtifactRoot('promote-tasks-graph-lock');
  const graphPath = path.join(artifactRoot, 'iterations', 'v1-mvp', 'gate-c-task-graph', 'task-graph.json');
  const draftPath = path.join(path.dirname(graphPath), 'task-graph.draft.json');
  const canonicalBefore = readFileSync(graphPath, 'utf8');
  const draft = JSON.parse(canonicalBefore);
  draft.version = `${draft.version}-draft`;
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  let promotionPromise;
  withRunStoreLocks([path.dirname(graphPath)], () => {
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
