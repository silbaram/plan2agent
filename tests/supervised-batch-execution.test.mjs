import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  EXECUTE_CLI,
  ROOT,
  RUNS_CLI,
  TASKS_CLI,
} from './helpers/fixtures.mjs';
import { runFilePath } from '../scripts/p2a_run_paths.mjs';

const TASK_GRAPH_FIXTURE = path.join(ROOT, 'fixtures', 'webhook-api-service', 'task-graph.json');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function executeResult(args) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function execute(args) {
  const result = executeResult(args);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function runs(args) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function tasks(args) {
  return spawnSync(process.execPath, [TASKS_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function gitResult(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function fileContentVerification(file, expectedContent) {
  const script = [
    "const { readFileSync } = require('node:fs');",
    `const actual = readFileSync(${JSON.stringify(file)}, 'utf8');`,
    `if (actual !== ${JSON.stringify(expectedContent)}) {`,
    "  console.error('unexpected integrated file content');",
    '  process.exit(1);',
    '}',
  ].join(' ');
  return `custom:${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function waitForPath(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for path: ${filePath}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function simulatedImplementer(cwd, readyPath, releasePath, outputFile) {
  const script = [
    "const { existsSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n');`,
    'const waitBuffer = new Int32Array(new SharedArrayBuffer(4));',
    `while (!existsSync(${JSON.stringify(releasePath)})) Atomics.wait(waitBuffer, 0, 0, 20);`,
    `writeFileSync(${JSON.stringify(outputFile)}, ${JSON.stringify(`${path.basename(outputFile)}\n`)});`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd, encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) resolve({ status, stdout, stderr });
      else reject(new Error(`simulated implementer failed (${status}): ${stderr}`));
    });
  });
}

function batchTaskGraph() {
  const fixture = JSON.parse(readFileSync(TASK_GRAPH_FIXTURE, 'utf8'));
  const template = fixture.tasks[0];
  return {
    ...fixture,
    projectId: 'supervised-batch-fixture',
    version: 'batch-1',
    tasks: [
      {
        ...template,
        id: 'task-001',
        title: 'Implement alpha independently',
        description: 'Create the alpha batch output.',
        status: 'todo',
        dependencies: [],
        acceptanceCriteria: ['alpha.txt exists on the canonical integration branch'],
        targetArea: 'alpha',
        suggestedAgentPrompt: 'Create alpha.txt in the assigned worktree.',
      },
      {
        ...template,
        id: 'task-002',
        title: 'Implement beta independently',
        description: 'Create the beta batch output.',
        status: 'todo',
        dependencies: [],
        acceptanceCriteria: ['beta.txt exists on the canonical integration branch'],
        targetArea: 'beta',
        suggestedAgentPrompt: 'Create beta.txt in the assigned worktree.',
      },
      {
        ...template,
        id: 'task-003',
        title: 'Consume integrated alpha and beta',
        description: 'Start only after both independent outputs are integrated.',
        status: 'todo',
        dependencies: ['task-001', 'task-002'],
        acceptanceCriteria: ['The task worktree contains alpha.txt and beta.txt'],
        targetArea: 'consumer',
        suggestedAgentPrompt: 'Consume the integrated alpha and beta outputs.',
      },
    ],
  };
}

function conflictingBatchTaskGraph() {
  const graph = batchTaskGraph();
  return {
    ...graph,
    version: 'batch-conflict-1',
    tasks: graph.tasks.slice(0, 2).map((task, index) => ({
      ...task,
      title: `Implement conflicting shared value ${index + 1}`,
      description: 'Update a shared file from the original batch base.',
      acceptanceCriteria: [`shared.txt contains task-${index + 1}`],
      targetArea: 'shared',
      suggestedAgentPrompt: `Change shared.txt to task-${index + 1}.`,
    })),
  };
}

test('batch execution contract is present in canonical and generated provider surfaces', () => {
  const canonical = readFileSync(path.join(ROOT, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'), 'utf8');
  const claude = readFileSync(path.join(ROOT, '.claude', 'skills', 'p2a-dev-execution', 'SKILL.md'), 'utf8');
  const gemini = readFileSync(path.join(ROOT, '.gemini', 'commands', 'p2a', 'dev-execution.toml'), 'utf8');

  assert.equal(claude, canonical);
  for (const required of [
    '## Supervised Batch Owner Procedure',
    'Freeze one ready snapshot',
    'Start every run serially',
    'Harvest and integrate one task at a time',
    'canonical integration branch',
    'Do not auto-resolve conflicts',
    'do not advance the canonical integration branch for that task and do not mark it `done`',
    'Never force-remove a dirty, unmerged, failed, or blocked task or integration-candidate worktree',
    'owner-only integration-candidate worktree',
    'fall back to the single-task procedure',
  ]) {
    assert.match(canonical, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(gemini, /Gemini is read-only/);
  assert.match(gemini, /Do not start a run, edit a worktree, create an integration candidate/);
  assert.match(gemini, /hand it off to a foreground Codex or approved Claude owner/);
  assert.match(gemini, /candidate-first batch procedure/);
});

test('two ready tasks can overlap in isolated worktrees and finish only after serial integration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-supervised-batch-'));
  try {
    const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
    const workspace = path.join(root, 'workspace');
    const integrationWorktree = path.join(root, 'integration');
    const taskOneWorktree = path.join(root, 'task-001-worktree');
    const taskTwoWorktree = path.join(root, 'task-002-worktree');
    const taskThreeWorktree = path.join(root, 'task-003-worktree');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(graphPath, `${JSON.stringify(batchTaskGraph(), null, 2)}\n`, 'utf8');
    writeFileSync(path.join(workspace, 'baseline.txt'), 'baseline\n', 'utf8');

    git(workspace, ['init']);
    git(workspace, ['add', 'baseline.txt']);
    git(workspace, ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Batch Fixture', 'commit', '-m', 'initial']);
    const batchBase = git(workspace, ['rev-parse', 'HEAD']);
    git(workspace, ['worktree', 'add', '-b', 'p2a/integration', integrationWorktree, batchBase]);

    const readySnapshot = tasks(['ready', '--graph', graphPath]);
    assert.equal(readySnapshot.status, 0, readySnapshot.stderr);
    assert.match(readySnapshot.stdout, /task-001/);
    assert.match(readySnapshot.stdout, /task-002/);
    assert.doesNotMatch(readySnapshot.stdout, /task-003/);
    const dependentStartBeforeIntegration = executeResult([
      'start',
      '--graph', graphPath,
      '--task', 'task-003',
      '--run-id', 'run-batch-003-before-ready',
      '--agent-tool', 'codex',
      '--workspace', workspace,
    ]);
    assert.notEqual(
      dependentStartBeforeIntegration.status,
      0,
      `${dependentStartBeforeIntegration.stdout}\n${dependentStartBeforeIntegration.stderr}`,
    );
    assert.match(
      `${dependentStartBeforeIntegration.stdout}\n${dependentStartBeforeIntegration.stderr}`,
      /not ready/i,
    );

    for (const [taskId, runId, worktree] of [
      ['task-001', 'run-batch-001', taskOneWorktree],
      ['task-002', 'run-batch-002', taskTwoWorktree],
    ]) {
      execute([
        'start',
        '--graph', graphPath,
        '--task', taskId,
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', workspace,
        '--isolation', 'worktree',
        '--worktree', worktree,
        '--base-ref', batchBase,
        '--create-isolation',
      ]);
    }

    const readyOne = path.join(root, 'task-001.ready');
    const readyTwo = path.join(root, 'task-002.ready');
    const releaseOne = path.join(root, 'task-001.release');
    const releaseTwo = path.join(root, 'task-002.release');
    const implementerOne = simulatedImplementer(
      taskOneWorktree,
      readyOne,
      releaseOne,
      path.join(taskOneWorktree, 'alpha.txt'),
    );
    const implementerTwo = simulatedImplementer(
      taskTwoWorktree,
      readyTwo,
      releaseTwo,
      path.join(taskTwoWorktree, 'beta.txt'),
    );
    await Promise.all([waitForPath(readyOne), waitForPath(readyTwo)]);
    writeFileSync(releaseOne, 'release\n', 'utf8');
    writeFileSync(releaseTwo, 'release\n', 'utf8');
    await Promise.all([implementerOne, implementerTwo]);

    const readyWhileBatchRuns = tasks(['ready', '--graph', graphPath]);
    assert.equal(readyWhileBatchRuns.status, 0, readyWhileBatchRuns.stderr);
    assert.doesNotMatch(readyWhileBatchRuns.stdout, /task-003/);

    const integrations = [
      {
        taskId: 'task-001',
        runId: 'run-batch-001',
        worktree: taskOneWorktree,
        file: 'alpha.txt',
      },
      {
        taskId: 'task-002',
        runId: 'run-batch-002',
        worktree: taskTwoWorktree,
        file: 'beta.txt',
      },
    ];
    for (const item of integrations) {
      git(item.worktree, ['add', item.file]);
      git(item.worktree, [
        '-c', 'user.email=p2a@example.invalid',
        '-c', 'user.name=P2A Batch Fixture',
        'commit', '-m', `implement ${item.taskId}`,
      ]);
      const taskCommit = git(item.worktree, ['rev-parse', 'HEAD']);
      const integrationBase = git(integrationWorktree, ['rev-parse', 'HEAD']);
      const candidateWorktree = path.join(root, `${item.taskId}-candidate`);
      git(workspace, [
        'worktree', 'add', '-b', `p2a/candidate-${item.taskId}`,
        candidateWorktree, integrationBase,
      ]);
      git(candidateWorktree, [
        '-c', 'user.email=p2a@example.invalid',
        '-c', 'user.name=P2A Batch Fixture',
        'cherry-pick', taskCommit,
      ]);
      const candidateHead = git(candidateWorktree, ['rev-parse', 'HEAD']);
      assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), integrationBase);
      assert.equal(
        readFileSync(path.join(candidateWorktree, item.file), 'utf8'),
        `${item.file}\n`,
      );
      const recordResult = runs([
        'record',
        '--graph', graphPath,
        '--run-id', item.runId,
        '--changed-file', item.file,
        '--note', `INTEGRATION: base=${integrationBase}; commit=${candidateHead}; workspace=${candidateWorktree}`,
      ]);
      assert.equal(recordResult.status, 0, `${recordResult.stdout}\n${recordResult.stderr}`);
      const verificationResult = runs([
        'verify',
        '--graph', graphPath,
        '--run-id', item.runId,
        '--workspace', candidateWorktree,
        '--verify-command', fileContentVerification(item.file, `${item.file}\n`),
      ]);
      assert.equal(
        verificationResult.status,
        0,
        `${verificationResult.stdout}\n${verificationResult.stderr}`,
      );
      assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), integrationBase);
      git(integrationWorktree, ['merge', '--ff-only', candidateHead]);
      assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), candidateHead);
      execute([
        'finish',
        '--graph', graphPath,
        '--run-id', item.runId,
        '--workspace', integrationWorktree,
      ]);
    }

    const graphAfterHarvest = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(graphAfterHarvest.tasks.find((task) => task.id === 'task-001')?.status, 'done');
    assert.equal(graphAfterHarvest.tasks.find((task) => task.id === 'task-002')?.status, 'done');
    assert.equal(graphAfterHarvest.tasks.find((task) => task.id === 'task-003')?.status, 'todo');

    const runsDir = path.join(root, 'runs');
    const runIndex = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.equal(runIndex.runs.length, 2);
    for (const item of integrations) {
      const run = JSON.parse(readFileSync(runFilePath(runsDir, item.runId), 'utf8'));
      assert.equal(run.status, 'finished');
      assert.deepEqual(run.changedFiles, [item.file]);
      assert.equal(run.verification.some((entry) => (
        entry.status === 'passed'
        && entry.source === 'command'
        && entry.exitCode === 0
        && entry.command.includes(item.file)
      )), true);
      assert.equal(run.notes.some((note) => note.startsWith('INTEGRATION: ')), true);
    }

    const readyAfterHarvest = tasks(['ready', '--graph', graphPath]);
    assert.equal(readyAfterHarvest.status, 0, readyAfterHarvest.stderr);
    assert.match(readyAfterHarvest.stdout, /task-003/);

    const latestIntegrationHead = git(integrationWorktree, ['rev-parse', 'HEAD']);
    execute([
      'start',
      '--graph', graphPath,
      '--task', 'task-003',
      '--run-id', 'run-batch-003',
      '--agent-tool', 'codex',
      '--workspace', workspace,
      '--isolation', 'worktree',
      '--worktree', taskThreeWorktree,
      '--base-ref', latestIntegrationHead,
      '--create-isolation',
    ]);
    assert.equal(existsSync(path.join(taskThreeWorktree, 'alpha.txt')), true);
    assert.equal(existsSync(path.join(taskThreeWorktree, 'beta.txt')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration conflict blocks only the conflicting task and preserves canonical state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-supervised-batch-conflict-'));
  try {
    const graphPath = path.join(root, 'gate-c-task-graph', 'task-graph.json');
    const workspace = path.join(root, 'workspace');
    const integrationWorktree = path.join(root, 'integration');
    const taskOneWorktree = path.join(root, 'task-001-worktree');
    const taskTwoWorktree = path.join(root, 'task-002-worktree');
    const firstCandidate = path.join(root, 'task-001-candidate');
    const conflictCandidate = path.join(root, 'task-002-conflict-candidate');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(graphPath, `${JSON.stringify(conflictingBatchTaskGraph(), null, 2)}\n`, 'utf8');
    writeFileSync(path.join(workspace, 'shared.txt'), 'base\n', 'utf8');

    git(workspace, ['init']);
    git(workspace, ['add', 'shared.txt']);
    git(workspace, [
      '-c', 'user.email=p2a@example.invalid',
      '-c', 'user.name=P2A Batch Fixture',
      'commit', '-m', 'initial shared value',
    ]);
    const batchBase = git(workspace, ['rev-parse', 'HEAD']);
    git(workspace, ['worktree', 'add', '-b', 'p2a/integration', integrationWorktree, batchBase]);

    for (const [taskId, runId, worktree] of [
      ['task-001', 'run-conflict-001', taskOneWorktree],
      ['task-002', 'run-conflict-002', taskTwoWorktree],
    ]) {
      execute([
        'start',
        '--graph', graphPath,
        '--task', taskId,
        '--run-id', runId,
        '--agent-tool', 'codex',
        '--workspace', workspace,
        '--isolation', 'worktree',
        '--worktree', worktree,
        '--base-ref', batchBase,
        '--create-isolation',
      ]);
    }

    writeFileSync(path.join(taskOneWorktree, 'shared.txt'), 'task-1\n', 'utf8');
    writeFileSync(path.join(taskTwoWorktree, 'shared.txt'), 'task-2\n', 'utf8');
    for (const [taskId, worktree] of [
      ['task-001', taskOneWorktree],
      ['task-002', taskTwoWorktree],
    ]) {
      git(worktree, ['add', 'shared.txt']);
      git(worktree, [
        '-c', 'user.email=p2a@example.invalid',
        '-c', 'user.name=P2A Batch Fixture',
        'commit', '-m', `implement ${taskId}`,
      ]);
    }

    const firstTaskCommit = git(taskOneWorktree, ['rev-parse', 'HEAD']);
    git(workspace, ['worktree', 'add', '-b', 'p2a/conflict-candidate-001', firstCandidate, batchBase]);
    git(firstCandidate, [
      '-c', 'user.email=p2a@example.invalid',
      '-c', 'user.name=P2A Batch Fixture',
      'cherry-pick', firstTaskCommit,
    ]);
    const firstCandidateHead = git(firstCandidate, ['rev-parse', 'HEAD']);
    const firstRecord = runs([
      'record',
      '--graph', graphPath,
      '--run-id', 'run-conflict-001',
      '--changed-file', 'shared.txt',
      '--note', `INTEGRATION: base=${batchBase}; commit=${firstCandidateHead}; workspace=${firstCandidate}`,
    ]);
    assert.equal(firstRecord.status, 0, `${firstRecord.stdout}\n${firstRecord.stderr}`);
    const firstVerification = runs([
      'verify',
      '--graph', graphPath,
      '--run-id', 'run-conflict-001',
      '--workspace', firstCandidate,
      '--verify-command', fileContentVerification('shared.txt', 'task-1\n'),
    ]);
    assert.equal(
      firstVerification.status,
      0,
      `${firstVerification.stdout}\n${firstVerification.stderr}`,
    );
    assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), batchBase);
    git(integrationWorktree, ['merge', '--ff-only', firstCandidateHead]);
    execute([
      'finish',
      '--graph', graphPath,
      '--run-id', 'run-conflict-001',
      '--workspace', integrationWorktree,
    ]);
    const canonicalAfterFirst = git(integrationWorktree, ['rev-parse', 'HEAD']);
    assert.equal(readFileSync(path.join(integrationWorktree, 'shared.txt'), 'utf8'), 'task-1\n');

    git(workspace, [
      'worktree', 'add', '-b', 'p2a/conflict-candidate-002',
      conflictCandidate, canonicalAfterFirst,
    ]);
    const secondTaskCommit = git(taskTwoWorktree, ['rev-parse', 'HEAD']);
    const conflictResult = gitResult(conflictCandidate, [
      '-c', 'user.email=p2a@example.invalid',
      '-c', 'user.name=P2A Batch Fixture',
      'cherry-pick', secondTaskCommit,
    ]);
    assert.notEqual(conflictResult.status, 0, `${conflictResult.stdout}\n${conflictResult.stderr}`);
    assert.match(git(conflictCandidate, ['status', '--porcelain']), /^UU shared\.txt$/m);
    assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), canonicalAfterFirst);
    assert.equal(readFileSync(path.join(integrationWorktree, 'shared.txt'), 'utf8'), 'task-1\n');

    execute([
      'finish',
      '--graph', graphPath,
      '--run-id', 'run-conflict-002',
      '--workspace', conflictCandidate,
      '--status', 'blocked',
      '--failure-class', 'implementation_incomplete',
      '--changed-file', 'shared.txt',
      '--note', `INTEGRATION_CONFLICT: base=${canonicalAfterFirst}; commit=${secondTaskCommit}; workspace=${conflictCandidate}`,
      '--repro-step', 'Cherry-pick the task-002 commit onto the latest canonical integration head.',
      '--localization', 'shared.txt conflicts with the already integrated task-001 result.',
      '--guard', 'Resolve through a new approved retry; do not auto-resolve or advance canonical.',
    ]);

    const graphAfterConflict = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(graphAfterConflict.tasks.find((task) => task.id === 'task-001')?.status, 'done');
    assert.equal(graphAfterConflict.tasks.find((task) => task.id === 'task-002')?.status, 'blocked');
    const runsDir = path.join(root, 'runs');
    const firstRun = JSON.parse(readFileSync(runFilePath(runsDir, 'run-conflict-001'), 'utf8'));
    const secondRun = JSON.parse(readFileSync(runFilePath(runsDir, 'run-conflict-002'), 'utf8'));
    const runIndex = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
    assert.equal(firstRun.status, 'finished');
    assert.equal(secondRun.status, 'blocked');
    assert.equal(secondRun.failure?.class, 'implementation_incomplete');
    assert.equal(runIndex.runs.length, 2);
    assert.equal(git(integrationWorktree, ['rev-parse', 'HEAD']), canonicalAfterFirst);
    assert.equal(existsSync(conflictCandidate), true);
    assert.match(git(conflictCandidate, ['status', '--porcelain']), /^UU shared\.txt$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
