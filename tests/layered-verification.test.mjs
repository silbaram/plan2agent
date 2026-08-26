import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mergeDevSkillConfig,
  relatedVerificationCommands,
} from '../scripts/p2a_project_config.mjs';
import {
  normalizeRelatedChangedFiles,
  runVerificationCommand,
  verificationSpecs,
} from '../scripts/p2a_runs.mjs';
import {
  assertFinalFullVerificationReady,
} from '../scripts/p2a_final_verification_gate.mjs';
import {
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
  runFilePath,
} from '../scripts/p2a_run_paths.mjs';
import { runExecute, runIteration } from './helpers/fixtures.mjs';

function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test('related verification config is migrated additively and validated as structured argv', () => {
  const migrated = mergeDevSkillConfig({ devExecution: {} });
  assert.deepEqual(migrated.config.relatedVerification, []);
  assert.ok(migrated.updatedKeys.includes('relatedVerification'));

  const commands = relatedVerificationCommands({
    relatedVerification: [{
      type: 'test',
      argv: ['npx', 'vitest', 'related'],
      appendChangedFiles: true,
    }],
  });
  assert.deepEqual(commands, [{
    type: 'test',
    argv: ['npx', 'vitest', 'related'],
    appendChangedFiles: true,
  }]);
  assert.throws(
    () => relatedVerificationCommands({
      relatedVerification: [{ type: 'test', argv: ['npx'], appendChangedFiles: false }],
    }),
    /appendChangedFiles must be true/,
  );
});

test('related verification passes changed files as literal argv without shell interpolation', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-argv-'));
  try {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const selected = normalizeRelatedChangedFiles(workspace, [
      'src/file with spaces.js',
      'src/$(literal).js',
      'src/file"quote.js',
      "src/file'quote.js",
      'src/ leading-space.js',
      'src/trailing-space.js ',
    ]);
    const [spec] = verificationSpecs({ related: true, verifyRequests: [] }, {
      relatedVerification: [{
        type: 'test',
        argv: ['npx', 'vitest', 'related'],
        appendChangedFiles: true,
      }],
    }, selected);
    let invocation = null;
    const result = runVerificationCommand(spec, workspace, 1000, {
      spawnSync: (file, args, options) => {
        invocation = { file, args, options };
        return { status: 0, stdout: 'related ok', stderr: '' };
      },
    });

    assert.equal(invocation.file, 'npx');
    assert.deepEqual(invocation.args, [
      'vitest',
      'related',
      'src/file with spaces.js',
      'src/$(literal).js',
      'src/file"quote.js',
      "src/file'quote.js",
      'src/ leading-space.js',
      'src/trailing-space.js ',
    ]);
    assert.equal(invocation.options.shell, false);
    assert.equal(result.scope, 'related');
    assert.equal(result.selectedFileCount, 6);
    assert.deepEqual(result.argv, ['npx', ...invocation.args]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('related changed file normalization rejects empty and escaping selections', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-paths-'));
  try {
    assert.throws(() => normalizeRelatedChangedFiles(workspace, []), /requires at least one changed file/);
    assert.throws(() => normalizeRelatedChangedFiles(workspace, ['../outside.js']), /escapes the workspace/);
    assert.throws(() => normalizeRelatedChangedFiles(workspace, [path.resolve(workspace, 'absolute.js')]), /workspace-relative/);
    assert.throws(() => normalizeRelatedChangedFiles(workspace, ['C:\\outside.js']), /workspace-relative/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('execute finish collects Git changes before related argv execution and seals scoped evidence', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-cli-'));
  try {
    const artifactRoot = path.join(
      workspace,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
    );
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    const initialized = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', 'iter-related-cli',
    ]);
    assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);

    const captureScript = path.join(workspace, 'capture-related-argv.mjs');
    const captureOutput = path.join(workspace, '.plan2agent', 'capture-related-argv.json');
    writeFileSync(
      captureScript,
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n",
      'utf8',
    );
    writeFileSync(path.join(workspace, '.gitignore'), '.plan2agent/\n', 'utf8');
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'changed file.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(workspace, 'src', 'explicit $(literal).js'), 'export const explicit = 1;\n', 'utf8');
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'fixture@example.com']);
    git(workspace, ['config', 'user.name', 'Plan2Agent Fixture']);
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-qm', 'fixture baseline']);

    writeFileSync(path.join(workspace, 'src', 'changed file.js'), 'export const value = 2;\n', 'utf8');
    writeFileSync(path.join(workspace, 'src', 'explicit $(literal).js'), 'export const explicit = 2;\n', 'utf8');
    writeFileSync(path.join(artifactRoot, 'project.config.json'), `${JSON.stringify({
      relatedVerification: [{
        type: 'test',
        argv: [process.execPath, captureScript, captureOutput],
        appendChangedFiles: true,
      }],
    }, null, 2)}\n`, 'utf8');

    const runId = 'run-related-cli';
    let result = runExecute([
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--related',
      '--changed-file', 'src/explicit $(literal).js',
      '--collect-git',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const selectedFiles = JSON.parse(readFileSync(captureOutput, 'utf8'));
    assert.deepEqual(selectedFiles, [
      'src/explicit $(literal).js',
      'src/changed file.js',
    ]);
    const run = JSON.parse(readFileSync(runFilePath(path.join(artifactRoot, 'runs'), runId), 'utf8'));
    assert.deepEqual(run.changedFiles, selectedFiles);
    assert.equal(run.verification.length, 1);
    assert.equal(run.verification[0].scope, 'related');
    assert.equal(run.verification[0].selectedFileCount, selectedFiles.length);
    assert.match(run.verification[0].workspaceRevisionSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(run.verification[0].argv.slice(-selectedFiles.length), selectedFiles);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('close-ready full evidence is canonical, final-run-only, and revision bound', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-final-verification-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');
    const run = {
      runId: 'run-final-verification',
      runKind: 'final_verification',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: [],
      startedAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      finishedAt: '2026-08-26T00:01:00.000Z',
      verification: [],
    };
    const revision = workspaceRevisionSha256(
      workspace,
      workspaceRevisionExcludedPathsForRun(runsDir, run, {
        artifactRoot,
        graphPath,
        workspacePath: workspace,
      }),
    );
    run.workspaceRevisionSha256 = revision;
    run.verification.push({
      type: 'test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'full',
      workspaceRevisionSha256: revision,
    });

    const ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [run],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, run.runId);
    assert.equal(ready.verification.length, 1);

    const newerFailedFull = structuredClone(run);
    newerFailedFull.runId = 'run-final-verification-newer-failed';
    newerFailedFull.status = 'failed';
    newerFailedFull.updatedAt = '2026-08-26T00:02:00.000Z';
    newerFailedFull.finishedAt = '2026-08-26T00:02:00.000Z';
    delete newerFailedFull.workspaceRevisionSha256;
    newerFailedFull.verification[0].status = 'failed';
    newerFailedFull.verification[0].exitCode = 1;
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run, newerFailedFull],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /no finished canonical final run contains passed full/,
    );

    const relatedOnly = structuredClone(run);
    relatedOnly.verification[0].scope = 'related';
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [relatedOnly],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /no finished canonical final run contains passed full/,
    );

    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 2;\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /stale/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('BuildLore-shaped task checks run related six times and reuse one final full command', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-buildlore-layered-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'buildlore');
    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v15',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');

    const commandCount = { related: 0, full: 0 };
    for (let index = 1; index <= 6; index += 1) {
      const relativeFile = `src/task-${index}.js`;
      mkdirSync(path.join(workspace, 'src'), { recursive: true });
      writeFileSync(path.join(workspace, relativeFile), `export const task${index} = true;\n`, 'utf8');
      const result = runVerificationCommand({
        type: 'test',
        source: 'config',
        scope: 'related',
        argv: ['project-related-test', relativeFile],
        selectedFileCount: 1,
      }, workspace, 1000, {
        spawnSync: () => {
          commandCount.related += 1;
          return { status: 0, stdout: 'related passed', stderr: '' };
        },
      });
      assert.equal(result.status, 'passed');
    }

    const finalRun = {
      runId: 'run-buildlore-final-acceptance',
      runKind: 'final_acceptance_review',
      iterationId: 'v15',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v15/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: [],
      startedAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      finishedAt: '2026-08-26T00:01:00.000Z',
      verification: [],
    };
    const revision = workspaceRevisionSha256(
      workspace,
      workspaceRevisionExcludedPathsForRun(runsDir, finalRun, {
        artifactRoot,
        graphPath,
        workspacePath: workspace,
      }),
    );
    const fullResult = runVerificationCommand({
      type: 'test',
      command: 'npm test',
      source: 'config',
      scope: 'full',
    }, workspace, 1000, {
      spawnSync: () => {
        commandCount.full += 1;
        return { status: 0, stdout: 'full suite passed', stderr: '' };
      },
    });
    finalRun.workspaceRevisionSha256 = revision;
    finalRun.verification.push({
      ...fullResult,
      workspaceRevisionSha256: revision,
    });

    for (let gateCheck = 0; gateCheck < 2; gateCheck += 1) {
      const ready = assertFinalFullVerificationReady({
        runsDir,
        runs: [finalRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v15',
      });
      assert.equal(ready.run.runId, finalRun.runId);
    }
    assert.deepEqual(commandCount, { related: 6, full: 1 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
