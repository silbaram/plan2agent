import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseVerifyCommand } from '../scripts/p2a_verification.mjs';
import {
  EXECUTE_CLI,
  FIXTURE_ROOT,
  RUNS_CLI,
  TASKS_CLI,
} from './helpers/fixtures.mjs';

const ALLOWED_TYPE_GUIDANCE = /Allowed types: test, lint, typecheck, custom\./;
const CUSTOM_TYPE_GUIDANCE = /Use: --verify-command 'custom:npm run build'/;
const UNCHANGED_STATE_GUIDANCE = /No run state or verification evidence was changed\./;

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function runCli(cli, args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function markerVerification(markerPath) {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`;
  return `custom:${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function directRunFixture(label) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), `p2a-verification-preflight-${label}-`));
  const runsDir = path.join(workspace, 'runs');
  mkdirSync(runsDir);
  const runId = `run-${label}`;
  const runPath = path.join(runsDir, `${runId}.json`);
  const configPath = path.join(workspace, 'project.config.json');
  writeFileSync(configPath, `${JSON.stringify({
    canary: 'preserve-exact-bytes',
    verificationTimeoutMs: 600000,
  }, null, 2)}\n`, 'utf8');
  const now = '2026-08-21T00:00:00.000Z';
  writeFileSync(runPath, `${JSON.stringify({
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'verification-preflight-fixture',
    taskId: 'task-001',
    taskTitle: 'Validate supplemental verification input',
    iterationId: 'v1',
    sourceLayout: 'graph',
    taskGraphRef: 'task-graph.json',
    sourceSpecRef: 'spec.json',
    agentTool: 'codex',
    workspaceRef: workspace,
    workspacePath: workspace,
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
  }, null, 2)}\n`, 'utf8');
  return { workspace, runsDir, runId, runPath, configPath };
}

function executeRunFixture() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-execute-verification-preflight-'));
  const projectRoot = path.join(workspace, 'webhook-api-service');
  cpSync(path.join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), projectRoot, { recursive: true });
  const graphPath = path.join(projectRoot, 'gate-c-task-graph', 'task-graph.json');
  const specPath = path.join(projectRoot, 'gate-b-spec', 'spec.json');
  const runId = 'run-execute-verification-preflight';
  const start = runCli(EXECUTE_CLI, [
    'start',
    '--graph', graphPath,
    '--spec', specPath,
    '--task', 'task-001',
    '--run-id', runId,
    '--agent-tool', 'codex',
    '--workspace', projectRoot,
  ], projectRoot);
  assert.equal(start.status, 0, commandOutput(start));

  const runsDir = path.join(projectRoot, 'runs');
  const indexPath = path.join(runsDir, 'run-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const entry = index.runs.find((candidate) => candidate.runId === runId);
  assert.ok(entry, `missing run index entry for ${runId}`);
  return {
    workspace,
    projectRoot,
    graphPath,
    specPath,
    runId,
    runPath: path.join(runsDir, entry.runRef),
    indexPath,
  };
}

test('strict supplemental verification parser accepts only explicit supported types', () => {
  for (const type of ['test', 'lint', 'typecheck', 'custom']) {
    assert.deepEqual(parseVerifyCommand(`${type}:node --version`), {
      type,
      command: 'node --version',
      source: 'command',
    });
  }
});

test('strict supplemental verification parser distinguishes malformed specs with corrective guidance', () => {
  const cases = [
    ['node --version', /--verify-command must use type:command\./],
    [':node --version', /--verify-command type must not be blank\./],
    ['custom:   ', /--verify-command command must not be blank\./],
    ['build:npm run build', /Unsupported verification type "build"\./],
  ];
  for (const [value, expected] of cases) {
    assert.throws(
      () => parseVerifyCommand(value),
      (error) => expected.test(error.message)
        && ALLOWED_TYPE_GUIDANCE.test(error.message)
        && CUSTOM_TYPE_GUIDANCE.test(error.message)
        && UNCHANGED_STATE_GUIDANCE.test(error.message),
      value,
    );
  }
});

test('p2a runs verify rejects malformed specs before changing run evidence', async (t) => {
  const cases = [
    ['missing-colon', 'node --version', /must use type:command/],
    ['blank-type', ':node --version', /type must not be blank/],
    ['blank-command', 'custom:   ', /command must not be blank/],
    ['unknown-type', 'build:npm run build', /Unsupported verification type "build"/],
  ];

  for (const [label, value, expected] of cases) {
    await t.test(label, () => {
      const fixture = directRunFixture(label);
      try {
        const before = readFileSync(fixture.runPath, 'utf8');
        const configBefore = readFileSync(fixture.configPath, 'utf8');
        const result = runCli(RUNS_CLI, [
          'verify',
          '--runs', fixture.runsDir,
          '--run-id', fixture.runId,
          '--verify-command', value,
        ], fixture.workspace);

        assert.notEqual(result.status, 0);
        assert.match(commandOutput(result), expected);
        assert.match(commandOutput(result), ALLOWED_TYPE_GUIDANCE);
        assert.match(commandOutput(result), UNCHANGED_STATE_GUIDANCE);
        assert.equal(readFileSync(fixture.runPath, 'utf8'), before);
        assert.equal(readFileSync(fixture.configPath, 'utf8'), configBefore);
      } finally {
        rmSync(fixture.workspace, { recursive: true, force: true });
      }
    });
  }
});

test('an unconfigured optional verification flag records no skipped evidence', () => {
  const fixture = directRunFixture('unconfigured-optional');
  try {
    const before = readFileSync(fixture.runPath, 'utf8');
    const result = runCli(RUNS_CLI, [
      'verify',
      '--runs', fixture.runsDir,
      '--run-id', fixture.runId,
      '--lint',
    ], fixture.workspace);
    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /lint verification was requested but no lint command is configured/);
    assert.match(commandOutput(result), /no evidence was recorded/);
    assert.equal(readFileSync(fixture.runPath, 'utf8'), before);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('p2a runs verify preflights a mixed list before executing its first command', () => {
  const fixture = directRunFixture('mixed-list');
  const markerPath = path.join(fixture.workspace, 'first-command-ran');
  try {
    const before = readFileSync(fixture.runPath, 'utf8');
    const configBefore = readFileSync(fixture.configPath, 'utf8');
    writeFileSync(path.join(fixture.workspace, 'package.json'), `${JSON.stringify({
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2)}\n`, 'utf8');
    const result = runCli(RUNS_CLI, [
      'verify',
      '--runs', fixture.runsDir,
      '--run-id', fixture.runId,
      '--test',
      '--save-config',
      '--verify-command', markerVerification(markerPath),
      '--verify-command', 'build:npm run build',
    ], fixture.workspace);

    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /Unsupported verification type "build"/);
    assert.equal(existsSync(markerPath), false);
    assert.equal(readFileSync(fixture.runPath, 'utf8'), before);
    assert.equal(readFileSync(fixture.configPath, 'utf8'), configBefore);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('p2a execute finish rejects a mixed list before changing run, index, revision, or task state', () => {
  const fixture = executeRunFixture();
  const markerPath = path.join(fixture.projectRoot, 'first-finish-command-ran');
  try {
    const before = {
      run: readFileSync(fixture.runPath, 'utf8'),
      index: readFileSync(fixture.indexPath, 'utf8'),
      graph: readFileSync(fixture.graphPath, 'utf8'),
    };
    const result = runCli(EXECUTE_CLI, [
      'finish',
      '--graph', fixture.graphPath,
      '--spec', fixture.specPath,
      '--run-id', fixture.runId,
      '--verify-command', markerVerification(markerPath),
      '--verify-command', 'build:npm run build',
    ], fixture.projectRoot);

    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /Unsupported verification type "build"/);
    assert.match(commandOutput(result), ALLOWED_TYPE_GUIDANCE);
    assert.match(commandOutput(result), UNCHANGED_STATE_GUIDANCE);
    assert.equal(existsSync(markerPath), false);
    assert.equal(readFileSync(fixture.runPath, 'utf8'), before.run);
    assert.equal(readFileSync(fixture.indexPath, 'utf8'), before.index);
    assert.equal(readFileSync(fixture.graphPath, 'utf8'), before.graph);

    const run = JSON.parse(before.run);
    const graph = JSON.parse(before.graph);
    assert.equal(run.status, 'started');
    assert.deepEqual(run.verification, []);
    assert.equal(graph.tasks.find((task) => task.id === 'task-001')?.status, 'in_progress');
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('valid custom build and configured test, lint, and typecheck flags remain supported', async (t) => {
  await t.test('custom:npm run build', () => {
    const fixture = directRunFixture('valid-custom-build');
    try {
      writeFileSync(path.join(fixture.workspace, 'package.json'), `${JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      }, null, 2)}\n`, 'utf8');
      const result = runCli(RUNS_CLI, [
        'verify',
        '--runs', fixture.runsDir,
        '--run-id', fixture.runId,
        '--verify-command', 'custom:npm run build',
      ], fixture.workspace);

      assert.equal(result.status, 0, commandOutput(result));
      const run = JSON.parse(readFileSync(fixture.runPath, 'utf8'));
      assert.deepEqual(run.verification.map(({ type, command, status, exitCode }) => ({
        type,
        command,
        status,
        exitCode,
      })), [{
        type: 'custom',
        command: 'npm run build',
        status: 'passed',
        exitCode: 0,
      }]);
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });

  await t.test('--test --lint --typecheck', () => {
    const fixture = directRunFixture('valid-configured-types');
    try {
      const passingCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
      writeFileSync(fixture.configPath, `${JSON.stringify({
        testCommand: passingCommand,
        lintCommand: passingCommand,
        typecheckCommand: passingCommand,
        verificationTimeoutMs: 600000,
      }, null, 2)}\n`, 'utf8');
      const result = runCli(RUNS_CLI, [
        'verify',
        '--runs', fixture.runsDir,
        '--run-id', fixture.runId,
        '--test',
        '--lint',
        '--typecheck',
      ], fixture.workspace);

      assert.equal(result.status, 0, commandOutput(result));
      const run = JSON.parse(readFileSync(fixture.runPath, 'utf8'));
      assert.deepEqual(
        run.verification.map(({ type, status, exitCode }) => ({ type, status, exitCode })),
        [
          { type: 'test', status: 'passed', exitCode: 0 },
          { type: 'lint', status: 'passed', exitCode: 0 },
          { type: 'typecheck', status: 'passed', exitCode: 0 },
        ],
      );
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });
});

test('latest same-command attempt decides while prior failed and unavailable evidence is preserved', async (t) => {
  const cases = [
    {
      label: 'failed',
      command(fixture) {
        const marker = path.join(fixture.projectRoot, 'verification-ready');
        const script = `process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 7)`;
        return `custom:${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
      },
      recover(fixture) {
        writeFileSync(path.join(fixture.projectRoot, 'verification-ready'), 'ready\n');
      },
      expectedStatus: 'failed',
    },
    {
      label: 'unavailable',
      command(fixture) {
        return `custom:${JSON.stringify(path.join(fixture.projectRoot, 'verification-later'))}`;
      },
      recover(fixture) {
        const executable = path.join(fixture.projectRoot, 'verification-later');
        writeFileSync(executable, '#!/bin/sh\nexit 0\n');
        chmodSync(executable, 0o755);
      },
      expectedStatus: 'unavailable',
    },
  ];

  for (const caseData of cases) {
    await t.test(caseData.label, () => {
      const fixture = executeRunFixture();
      try {
        const verificationCommand = caseData.command(fixture);
        let result = runCli(RUNS_CLI, [
          'verify',
          '--graph', fixture.graphPath,
          '--run-id', fixture.runId,
          '--verify-command', verificationCommand,
        ], fixture.projectRoot);
        assert.notEqual(result.status, 0);
        const failedEvidence = JSON.parse(readFileSync(fixture.runPath, 'utf8')).verification[0];
        assert.equal(failedEvidence.status, caseData.expectedStatus);

        caseData.recover(fixture);
        result = runCli(RUNS_CLI, [
          'verify',
          '--graph', fixture.graphPath,
          '--run-id', fixture.runId,
          '--verify-command', verificationCommand,
        ], fixture.projectRoot);
        assert.equal(result.status, 0, commandOutput(result));

        result = runCli(RUNS_CLI, [
          'finish',
          '--graph', fixture.graphPath,
          '--run-id', fixture.runId,
          '--status', 'finished',
        ], fixture.projectRoot);
        assert.equal(result.status, 0, commandOutput(result));
        const run = JSON.parse(readFileSync(fixture.runPath, 'utf8'));
        assert.equal(run.status, 'finished');
        assert.deepEqual(run.verification[0], failedEvidence);
        assert.equal(run.verification[1]?.status, 'passed');
      } finally {
        rmSync(fixture.workspace, { recursive: true, force: true });
      }
    });
  }
});

test('a different successful command does not supersede an unresolved failed attempt on the current revision', () => {
  const fixture = executeRunFixture();
  try {
    let result = runCli(RUNS_CLI, [
      'verify',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--verify-command', `custom:${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
    ], fixture.projectRoot);
    assert.notEqual(result.status, 0);

    result = runCli(RUNS_CLI, [
      'verify',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--verify-command', `custom:${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));

    result = runCli(RUNS_CLI, [
      'finish',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--status', 'finished',
    ], fixture.projectRoot);
    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /unresolved latest verification failure/);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('low-level finish and task done prefer workspace config and enforce every configured current check', () => {
  const fixture = executeRunFixture();
  try {
    const configPath = path.join(fixture.projectRoot, '.plan2agent', 'project.config.json');
    mkdirSync(path.dirname(configPath), { recursive: true });
    const passingCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    writeFileSync(configPath, `${JSON.stringify({
      testCommand: passingCommand,
      lintCommand: passingCommand,
    }, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(fixture.projectRoot, 'project.config.json'), `${JSON.stringify({
      testCommand: passingCommand,
    }, null, 2)}\n`, 'utf8');

    let result = runCli(RUNS_CLI, [
      'verify',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--test',
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));
    result = runCli(RUNS_CLI, [
      'finish',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--status', 'finished',
    ], fixture.projectRoot);
    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /lint:.*missing required verification|missing required verification.*lint:/s);
    assert.equal(JSON.parse(readFileSync(fixture.runPath, 'utf8')).status, 'started');

    result = runCli(RUNS_CLI, [
      'verify',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--lint',
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));
    result = runCli(RUNS_CLI, [
      'finish',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--status', 'finished',
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));

    const finishedRun = JSON.parse(readFileSync(fixture.runPath, 'utf8'));
    finishedRun.verification = finishedRun.verification.filter((item) => item.type !== 'lint');
    writeFileSync(fixture.runPath, `${JSON.stringify(finishedRun, null, 2)}\n`, 'utf8');
    result = runCli(TASKS_CLI, [
      'done',
      '--graph', fixture.graphPath,
      'task-001',
    ], fixture.projectRoot);
    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /missing required verification.*lint:/s);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});

test('task done recomputes the current workspace revision instead of trusting the sealed run hash', () => {
  const fixture = executeRunFixture();
  try {
    const configPath = path.join(fixture.projectRoot, '.plan2agent', 'project.config.json');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({
      testCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    }, null, 2)}\n`, 'utf8');
    let result = runCli(RUNS_CLI, [
      'verify',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--test',
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));
    result = runCli(RUNS_CLI, [
      'finish',
      '--graph', fixture.graphPath,
      '--run-id', fixture.runId,
      '--status', 'finished',
    ], fixture.projectRoot);
    assert.equal(result.status, 0, commandOutput(result));

    writeFileSync(path.join(fixture.projectRoot, 'changed-after-finish.js'), 'export const stale = true;\n', 'utf8');
    result = runCli(TASKS_CLI, [
      'done',
      '--graph', fixture.graphPath,
      'task-001',
    ], fixture.projectRoot);
    assert.notEqual(result.status, 0);
    assert.match(commandOutput(result), /verification evidence is stale for the current workspace/);
  } finally {
    rmSync(fixture.workspace, { recursive: true, force: true });
  }
});
