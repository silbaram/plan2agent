import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mergeDevSkillConfig,
  projectConfigCandidatePaths,
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
  classifyVerificationProfile,
  isDocsMetadataPath,
  productRevisionExcludedPaths,
} from '../scripts/p2a_verification_profile.mjs';
import { relatedFilesSha256 } from '../scripts/p2a_related_files.mjs';
import {
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
  runFilePath,
} from '../scripts/p2a_run_paths.mjs';
import { validateRunData } from '../scripts/validate_artifacts.mjs';
import { runExecute, runIteration, runRuns } from './helpers/fixtures.mjs';

function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function prepareNoDocsFallbackConfigDrift({
  workspace,
  artifactRoot,
  iterationId,
  runPrefix,
}) {
  let result = runIteration([
    'init',
    '--artifacts', artifactRoot,
    '--iteration-id', iterationId,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    iterationId,
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  for (const task of graph.tasks) task.status = 'done';
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  const taskId = graph.tasks.at(-1).id;
  const configPath = path.join(artifactRoot, 'project.config.json');
  const passCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('process.exit(0)')}`;
  writeFileSync(configPath, `${JSON.stringify({ testCommand: passCommand }, null, 2)}\n`, 'utf8');

  const fullRunId = `run-${runPrefix}-full`;
  result = runExecute([
    'verify-final',
    '--artifacts', artifactRoot,
    '--task', taskId,
    '--run-id', fullRunId,
    '--agent-tool', 'manual',
    '--workspace', workspace,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runRuns([
    'verify',
    '--artifacts', artifactRoot,
    '--run-id', fullRunId,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runExecute([
    'finish',
    '--artifacts', artifactRoot,
    '--run-id', fullRunId,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const runsDir = path.join(artifactRoot, 'runs');
  const fullRun = JSON.parse(readFileSync(runFilePath(runsDir, fullRunId), 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({
    testCommand: passCommand,
    relatedVerification: [{
      type: 'custom',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      appendChangedFiles: true,
    }],
  }, null, 2)}\n`, 'utf8');
  return { configPath, fullRun, graphPath, runsDir, taskId };
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

test('project config candidates use one deterministic workspace-to-fallback priority', () => {
  const root = path.join(tmpdir(), 'p2a-config-priority');
  const projectRoot = path.join(root, 'project');
  const workspace = path.join(projectRoot, 'src', 'nested');
  const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'sample');
  const graphPath = path.join(artifactRoot, 'iterations', 'v2', 'gate-c-task-graph', 'task-graph.json');
  const cwd = path.join(root, 'caller');
  assert.deepEqual(projectConfigCandidatePaths({
    workspacePath: workspace,
    projectRoot,
    artifactRoot,
    graphPath,
    cwd,
  }), [
    path.join(workspace, '.plan2agent', 'project.config.json'),
    path.join(projectRoot, '.plan2agent', 'project.config.json'),
    path.join(artifactRoot, 'project.config.json'),
    path.join(artifactRoot, 'iterations', 'v2', 'project.config.json'),
    path.join(cwd, '.plan2agent', 'project.config.json'),
  ]);
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

test('related verification checks readable files and accepts an explicitly selected deletion', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-default-'));
  try {
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    mkdirSync(path.join(workspace, '.plan2agent'), { recursive: true });
    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    writeFileSync(path.join(workspace, '.plan2agent', 'metadata.json'), '{"valid":true}\n', 'utf8');
    const selected = normalizeRelatedChangedFiles(workspace, [
      'docs/guide.md',
      '.plan2agent/metadata.json',
    ]);
    const [spec] = verificationSpecs(
      { related: true, verifyRequests: [] },
      { relatedVerification: [] },
      selected,
    );
    assert.equal(spec.source, 'command');
    assert.equal(spec.scope, 'related');
    assert.equal(spec.selectedFileCount, selected.length);
    assert.deepEqual(spec.argv.slice(-selected.length), selected);

    let result = runVerificationCommand(spec, workspace, 5000);
    assert.equal(result.status, 'passed', result.stderrTail);
    assert.match(result.stdoutTail, /Related file integrity passed/);

    writeFileSync(path.join(workspace, '.plan2agent', 'metadata.json'), '{invalid}\n', 'utf8');
    result = runVerificationCommand(spec, workspace, 5000);
    assert.equal(result.status, 'failed');
    assert.match(result.stderrTail, /related JSON file is invalid/);

    rmSync(path.join(workspace, '.plan2agent', 'metadata.json'));
    result = runVerificationCommand(spec, workspace, 5000);
    assert.equal(result.status, 'passed', result.stderrTail);
    assert.match(result.stdoutTail, /1 absent/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('related verification for excluded Plan2Agent metadata is bound to current file contents', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-control-binding-'));
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
    const metadataPath = path.join(workspace, '.plan2agent', 'metadata.json');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(metadataPath, '{"valid":true}\n', 'utf8');

    const run = {
      runId: 'run-related-control-binding',
      taskId: 'task-docs',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: ['.plan2agent/metadata.json'],
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
      verification: [],
    };
    const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    run.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, exclusions);
    run.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...exclusions, ...productRevisionExcludedPaths(workspace)],
    );
    run.verification = [{
      type: 'custom',
      command: 'p2a related file integrity',
      status: 'passed',
      exitCode: 0,
      source: 'command',
      scope: 'related',
      argv: ['p2a-related-check', ...run.changedFiles],
      selectedFileCount: run.changedFiles.length,
      relatedFilesSha256: relatedFilesSha256(run.changedFiles, { workspacePath: workspace }),
      workspaceRevisionSha256: run.workspaceRevisionSha256,
      productRevisionSha256: run.productRevisionSha256,
    }];
    assert.match(run.verification[0].relatedFilesSha256, /^[a-f0-9]{64}$/u);
    assert.doesNotThrow(() => assertFinalFullVerificationReady({
      runsDir,
      runs: [run],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    }));

    writeFileSync(metadataPath, '{invalid}\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /stale because selected Plan2Agent metadata changed/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('stable Plan2Agent config metadata requires current related evidence after a full pass', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-config-after-full-'));
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
    const manifestPath = path.join(workspace, '.plan2agent', 'manifest.json');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(path.join(workspace, 'src', 'auth'), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'src', 'auth', 'routes.js'), 'export const auth = true;\n', 'utf8');
    writeFileSync(manifestPath, '{"version":1}\n', 'utf8');

    const baseRun = {
      taskId: 'task-auth',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
    };
    const implementationRun = {
      ...baseRun,
      runId: 'run-config-after-full-implementation',
      changedFiles: ['src/auth/routes.js'],
      verification: [],
    };
    const fullRun = {
      ...baseRun,
      runId: 'run-config-after-full-product',
      runKind: 'final_verification',
      verificationScope: 'full',
      changedFiles: [],
      docsMetadataBaseline: ['.plan2agent/manifest.json'],
      verification: [],
    };
    const fullExclusions = workspaceRevisionExcludedPathsForRun(runsDir, fullRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    fullRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, fullExclusions);
    fullRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...fullExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    fullRun.verification.push({
      type: 'test',
      command: 'npm test',
      status: 'passed',
      exitCode: 0,
      source: 'command',
      scope: 'full',
      workspaceRevisionSha256: fullRun.workspaceRevisionSha256,
      productRevisionSha256: fullRun.productRevisionSha256,
      startedAt: '2026-08-30T00:00:10.000Z',
      finishedAt: '2026-08-30T00:00:20.000Z',
    });
    assert.equal(assertFinalFullVerificationReady({
      runsDir,
      runs: [implementationRun, fullRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    }).profile.id, 'high_risk_integration');

    mkdirSync(path.join(workspace, '.plan2agent', 'update-reports'), { recursive: true });
    writeFileSync(
      path.join(workspace, '.plan2agent', 'update-reports', 'latest.json'),
      '{"status":"complete"}\n',
      'utf8',
    );
    assert.equal(
      workspaceRevisionSha256(workspace, fullExclusions),
      fullRun.workspaceRevisionSha256,
      'runtime and update-report state must stay outside the verification revision',
    );

    writeFileSync(manifestPath, '{"version":2}\n', 'utf8');
    const currentWorkspaceRevision = workspaceRevisionSha256(workspace, fullExclusions);
    const currentProductRevision = workspaceRevisionSha256(
      workspace,
      [...fullExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    assert.notEqual(currentWorkspaceRevision, fullRun.workspaceRevisionSha256);
    assert.equal(currentProductRevision, fullRun.productRevisionSha256);
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun, fullRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
    );

    const relevantRun = {
      ...baseRun,
      runId: 'run-config-after-full-relevant',
      runKind: 'final_verification',
      verificationScope: 'relevant',
      changedFiles: [],
      startedAt: '2026-08-30T00:02:00.000Z',
      updatedAt: '2026-08-30T00:03:00.000Z',
      finishedAt: '2026-08-30T00:03:00.000Z',
      workspaceRevisionSha256: currentWorkspaceRevision,
      productRevisionSha256: currentProductRevision,
      verification: [{
        type: 'custom',
        command: 'p2a related file integrity',
        status: 'passed',
        exitCode: 0,
        source: 'command',
        scope: 'related',
        argv: ['p2a-related-check', '.plan2agent/manifest.json'],
        selectedFileCount: 1,
        relatedFilesSha256: relatedFilesSha256(
          ['.plan2agent/manifest.json'],
          { workspacePath: workspace },
        ),
        workspaceRevisionSha256: currentWorkspaceRevision,
        productRevisionSha256: currentProductRevision,
        startedAt: '2026-08-30T00:02:10.000Z',
        finishedAt: '2026-08-30T00:02:20.000Z',
      }],
    };
    const ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [implementationRun, fullRun, relevantRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, fullRun.runId);
    assert.equal(ready.relevantRun.runId, relevantRun.runId);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('active fallback project configs require relevant evidence after a full pass', () => {
  for (const fallback of ['artifact', 'iteration']) {
    const workspace = mkdtempSync(path.join(tmpdir(), `p2a-${fallback}-config-after-full-`));
    try {
      const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
      const iterationRoot = path.join(artifactRoot, 'iterations', 'v1');
      const graphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
      const runsDir = path.join(artifactRoot, 'runs');
      const fallbackConfigPath = fallback === 'artifact'
        ? path.join(artifactRoot, 'project.config.json')
        : path.join(iterationRoot, 'project.config.json');
      const historicalConfigPath = path.join(
        artifactRoot,
        'iterations',
        'v0',
        'project.config.json',
      );
      mkdirSync(path.dirname(graphPath), { recursive: true });
      mkdirSync(path.dirname(historicalConfigPath), { recursive: true });
      mkdirSync(path.join(workspace, 'src', 'auth'), { recursive: true });
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(graphPath, '{}\n', 'utf8');
      writeFileSync(path.join(workspace, 'src', 'auth', 'routes.js'), 'export const auth = true;\n', 'utf8');
      writeFileSync(fallbackConfigPath, '{"relatedVerification":[]}\n', 'utf8');
      writeFileSync(historicalConfigPath, '{"history":1}\n', 'utf8');

      const baseRun = {
        taskId: 'task-auth',
        iterationId: 'v1',
        sourceLayout: 'iteration',
        taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
        status: 'finished',
        workspacePath: workspace,
        isolation: { mode: 'none' },
        startedAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:01:00.000Z',
        finishedAt: '2026-08-30T00:01:00.000Z',
      };
      const implementationRun = {
        ...baseRun,
        runId: `run-${fallback}-config-implementation`,
        changedFiles: ['src/auth/routes.js'],
        verification: [],
      };
      const fullRun = {
        ...baseRun,
        runId: `run-${fallback}-config-full`,
        runKind: 'final_verification',
        verificationScope: 'full',
        changedFiles: [],
        verification: [],
      };
      const fullExclusions = workspaceRevisionExcludedPathsForRun(runsDir, fullRun, {
        artifactRoot,
        graphPath,
        workspacePath: workspace,
      });
      fullRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, fullExclusions);
      fullRun.productRevisionSha256 = workspaceRevisionSha256(
        workspace,
        [...fullExclusions, ...productRevisionExcludedPaths(workspace)],
      );
      fullRun.verification.push({
        type: 'test',
        command: 'npm test',
        status: 'passed',
        exitCode: 0,
        source: 'command',
        scope: 'full',
        workspaceRevisionSha256: fullRun.workspaceRevisionSha256,
        productRevisionSha256: fullRun.productRevisionSha256,
        startedAt: '2026-08-30T00:00:10.000Z',
        finishedAt: '2026-08-30T00:00:20.000Z',
      });
      assert.equal(assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun, fullRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }).profile.id, 'high_risk_integration');

      if (fallback === 'artifact') {
        writeFileSync(
          path.join(iterationRoot, 'project.config.json'),
          '{"relatedVerification":[{"type":"custom","argv":["shadowed"],"appendChangedFiles":true}]}\n',
          'utf8',
        );
      }
      writeFileSync(path.join(runsDir, 'transient.json'), '{"status":"started"}\n', 'utf8');
      writeFileSync(historicalConfigPath, '{"history":2}\n', 'utf8');
      assert.equal(
        workspaceRevisionSha256(workspace, fullExclusions),
        fullRun.workspaceRevisionSha256,
        `${fallback} fallback binding must exclude runs, historical iterations, and shadowed config`,
      );

      writeFileSync(fallbackConfigPath, `${JSON.stringify({
        relatedVerification: [{
          type: 'custom',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          appendChangedFiles: true,
        }],
      }, null, 2)}\n`, 'utf8');
      assert.notEqual(
        workspaceRevisionSha256(workspace, fullExclusions),
        fullRun.workspaceRevisionSha256,
        `${fallback} fallback config must be bound to the workspace revision`,
      );
      assert.equal(
        workspaceRevisionSha256(
          workspace,
          [...fullExclusions, ...productRevisionExcludedPaths(workspace)],
        ),
        fullRun.productRevisionSha256,
        `${fallback} fallback config must not invalidate product verification`,
      );
      assert.throws(
        () => assertFinalFullVerificationReady({
          runsDir,
          runs: [implementationRun, fullRun],
          artifactRoot,
          graphPath,
          activeIteration: 'v1',
        }),
        (error) => error.verificationScope === 'relevant',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('external fallback project configs are revision-bound by stable role instead of location', () => {
  for (const fallback of ['artifact', 'iteration']) {
    const root = mkdtempSync(path.join(tmpdir(), `p2a-external-${fallback}-config-`));
    try {
      const workspace = path.join(root, 'workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(path.join(workspace, 'app.js'), 'export const app = true;\n', 'utf8');

      const createExternalSource = (stateName) => {
        const artifactRoot = path.join(root, stateName, 'artifacts', 'sample');
        const iterationRoot = path.join(artifactRoot, 'iterations', 'v1');
        const graphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
        const runsDir = path.join(artifactRoot, 'runs');
        const configPath = fallback === 'artifact'
          ? path.join(artifactRoot, 'project.config.json')
          : path.join(iterationRoot, 'project.config.json');
        mkdirSync(path.dirname(graphPath), { recursive: true });
        mkdirSync(runsDir, { recursive: true });
        writeFileSync(graphPath, '{}\n', 'utf8');
        writeFileSync(configPath, '{"relatedVerification":[]}\n', 'utf8');
        const run = {
          sourceLayout: 'iteration',
          iterationId: 'v1',
          workspacePath: workspace,
        };
        const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, run, {
          artifactRoot,
          graphPath,
          workspacePath: workspace,
        });
        return { artifactRoot, configPath, exclusions };
      };

      const first = createExternalSource('state-a');
      const relocated = createExternalSource('state-b');
      const initialRevision = workspaceRevisionSha256(workspace, first.exclusions);
      assert.equal(
        workspaceRevisionSha256(workspace, relocated.exclusions),
        initialRevision,
        `${fallback} fallback binding must not depend on its external storage path`,
      );
      const initialProductRevision = workspaceRevisionSha256(
        workspace,
        [...first.exclusions, ...productRevisionExcludedPaths(workspace)],
      );

      writeFileSync(first.configPath, `${JSON.stringify({
        relatedVerification: [{
          type: 'custom',
          argv: [process.execPath, '-e', 'process.exit(0)'],
          appendChangedFiles: true,
        }],
      }, null, 2)}\n`, 'utf8');
      assert.notEqual(
        workspaceRevisionSha256(workspace, first.exclusions),
        initialRevision,
        `${fallback} fallback outside the workspace must be bound to current evidence`,
      );
      assert.equal(
        workspaceRevisionSha256(
          workspace,
          [...first.exclusions, ...productRevisionExcludedPaths(workspace)],
        ),
        initialProductRevision,
        `${fallback} fallback outside the workspace must not invalidate product evidence`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('internal fallback config drift recovers with file-bound relevant verification', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-internal-config-recovery-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    const iterationId = 'iter-internal-config-recovery';
    const prepared = prepareNoDocsFallbackConfigDrift({
      workspace,
      artifactRoot,
      iterationId,
      runPrefix: 'internal-config-recovery',
    });

    const relevantRunId = 'run-internal-config-recovery-relevant';
    let result = runExecute([
      'verify-final',
      '--artifacts', artifactRoot,
      '--scope', 'relevant',
      '--task', prepared.taskId,
      '--run-id', relevantRunId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', relevantRunId,
      '--related',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', relevantRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const relevantRun = JSON.parse(readFileSync(
      runFilePath(prepared.runsDir, relevantRunId),
      'utf8',
    ));
    const selectedConfig = '.plan2agent/artifacts/webhook-api-service/project.config.json';
    assert.equal(relevantRun.status, 'finished');
    assert.equal(relevantRun.verificationScope, 'relevant');
    assert.equal(relevantRun.verification.length, 1);
    assert.equal(relevantRun.verification[0].scope, 'related');
    assert.equal(relevantRun.verification[0].selectedFileCount, 1);
    assert.equal(relevantRun.verification[0].argv.at(-1), selectedConfig);
    const ready = assertFinalFullVerificationReady({
      runsDir: prepared.runsDir,
      runs: [prepared.fullRun, relevantRun],
      artifactRoot,
      graphPath: prepared.graphPath,
      activeIteration: iterationId,
    });
    assert.equal(ready.run.runId, prepared.fullRun.runId);
    assert.equal(ready.relevantRun.runId, relevantRunId);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('external fallback config drift promotes empty related verification to close-ready full evidence', (context) => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-external-config-recovery-'));
  try {
    const workspace = path.join(root, 'workspace');
    const externalP2aRoot = path.join(root, 'shared-state', '.plan2agent');
    const externalArtifactRoot = path.join(
      externalP2aRoot,
      'artifacts',
      'webhook-api-service',
    );
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.dirname(externalArtifactRoot), { recursive: true });
    cpSync(
      path.resolve('fixtures/_e2e/webhook-api-service'),
      externalArtifactRoot,
      { recursive: true },
    );
    try {
      symlinkSync(
        externalP2aRoot,
        path.join(workspace, '.plan2agent'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        context.skip(`symbolic links are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const artifactRoot = path.join(
      workspace,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
    );
    const iterationId = 'iter-external-config-recovery';
    const prepared = prepareNoDocsFallbackConfigDrift({
      workspace,
      artifactRoot,
      iterationId,
      runPrefix: 'external-config-recovery',
    });

    const promotedRunId = 'run-external-config-recovery-promoted';
    let result = runExecute([
      'verify-final',
      '--artifacts', artifactRoot,
      '--scope', 'relevant',
      '--task', prepared.taskId,
      '--run-id', promotedRunId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', promotedRunId,
      '--related',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stdout,
      /verification scope promoted to full because the active project config is outside the workspace/u,
    );
    let promotedRun = JSON.parse(readFileSync(
      runFilePath(prepared.runsDir, promotedRunId),
      'utf8',
    ));
    assert.equal(promotedRun.verificationScope, 'full');
    assert.equal(promotedRun.verification.some((item) => item.scope === 'related'), false);
    assert.equal(promotedRun.verification.some((item) => (
      item.type === 'test' && item.scope === 'full' && item.status === 'passed'
    )), true);

    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', promotedRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    promotedRun = JSON.parse(readFileSync(
      runFilePath(prepared.runsDir, promotedRunId),
      'utf8',
    ));
    assert.equal(promotedRun.status, 'finished');
    assert.equal(promotedRun.verificationScope, 'full');
    const ready = assertFinalFullVerificationReady({
      runsDir: prepared.runsDir,
      runs: [prepared.fullRun, promotedRun],
      artifactRoot,
      graphPath: prepared.graphPath,
      activeIteration: iterationId,
    });
    assert.equal(ready.run.runId, promotedRunId);
    assert.equal(ready.relevantRun, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every configured related verification is bound to current Plan2Agent metadata contents', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-related-multi-binding-'));
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
    const metadataPath = path.join(workspace, '.plan2agent', 'metadata.json');
    const selectedFiles = ['.plan2agent/metadata.json'];
    const relatedCommands = [
      { type: 'test', argv: ['check-a'], appendChangedFiles: true },
      { type: 'custom', argv: ['check-b'], appendChangedFiles: true },
    ];
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(
      path.join(workspace, '.plan2agent', 'project.config.json'),
      `${JSON.stringify({ relatedVerification: relatedCommands }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(metadataPath, '{"version":1}\n', 'utf8');

    const run = {
      runId: 'run-related-multi-binding',
      taskId: 'task-docs',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: selectedFiles,
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
      verification: [],
    };
    const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    run.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, exclusions);
    run.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...exclusions, ...productRevisionExcludedPaths(workspace)],
    );
    const staleContentBinding = relatedFilesSha256(selectedFiles, { workspacePath: workspace });
    run.verification = relatedCommands.map((request) => ({
      type: request.type,
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: [...request.argv, ...selectedFiles],
      selectedFileCount: selectedFiles.length,
      relatedFilesSha256: staleContentBinding,
      workspaceRevisionSha256: run.workspaceRevisionSha256,
      productRevisionSha256: run.productRevisionSha256,
    }));

    writeFileSync(metadataPath, '{"version":2}\n', 'utf8');
    run.verification[1].relatedFilesSha256 = relatedFilesSha256(
      selectedFiles,
      { workspacePath: workspace },
    );
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /stale because selected Plan2Agent metadata changed/u,
    );

    run.verification[0].relatedFilesSha256 = run.verification[1].relatedFilesSha256;
    assert.doesNotThrow(() => assertFinalFullVerificationReady({
      runsDir,
      runs: [run],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    }));
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

test('an unreported non-Git product deletion promotes requested related verification to full', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-unreported-product-change-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', 'iter-unreported-product-change',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'feature.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(workspace, 'README.md'), '# Before\n', 'utf8');
    const runId = 'run-unreported-product-change';
    result = runExecute([
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const runsDir = path.join(artifactRoot, 'runs');
    const started = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    assert.match(started.startProductRevisionSha256, /^[a-f0-9]{64}$/u);

    rmSync(path.join(workspace, 'src', 'feature.js'));
    writeFileSync(path.join(workspace, 'README.md'), '# After\n', 'utf8');
    writeFileSync(path.join(artifactRoot, 'project.config.json'), `${JSON.stringify({
      testCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    }, null, 2)}\n`, 'utf8');
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--related',
      '--changed-file', 'README.md',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /verification scope promoted to full because the product revision changed or its start baseline is unavailable/u);

    const verified = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    assert.equal(verified.productChangeDetected, true);
    assert.equal(verified.verification.at(-1)?.scope, 'full');
    assert.notEqual(
      verified.startProductRevisionSha256,
      verified.verification.at(-1)?.productRevisionSha256,
    );

    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--changed-file', 'README.md',
      '--no-task-transition',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const finished = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    assert.equal(finished.status, 'finished');
    assert.equal(classifyVerificationProfile([finished]).id, 'high_risk_integration');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a reported single-task code change reuses its implementation full verification', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-reported-isolated-code-'));
  try {
    const iterationId = 'iter-reported-isolated-code';
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', iterationId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'feature.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(artifactRoot, 'project.config.json'), `${JSON.stringify({
      testCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    }, null, 2)}\n`, 'utf8');
    const runId = 'run-reported-isolated-code';
    result = runExecute([
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    writeFileSync(path.join(workspace, 'src', 'feature.js'), 'export const value = 2;\n', 'utf8');
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--changed-file', 'src/feature.js',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--changed-file', 'src/feature.js',
      '--no-task-transition',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const runsDir = path.join(artifactRoot, 'runs');
    const finished = JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8'));
    assert.equal(finished.productChangeDetected, true);
    assert.equal(classifyVerificationProfile([finished]).id, 'isolated_code');
    const ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [finished],
      artifactRoot,
      graphPath: path.join(
        artifactRoot,
        'iterations',
        iterationId,
        'gate-c-task-graph',
        'task-graph.json',
      ),
      activeIteration: iterationId,
    });
    assert.equal(ready.profile.id, 'isolated_code');
    assert.equal(ready.run.runId, runId);
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
    assert.match(run.verification[0].gitHeadSha, /^[a-f0-9]{40,64}$/);
    assert.deepEqual(run.verification[0].argv.slice(-selectedFiles.length), selectedFiles);

    const legacyFinished = structuredClone(run);
    delete legacyFinished.verification[0].argv;
    delete legacyFinished.verification[0].selectedFileCount;
    assert.doesNotThrow(
      () => validateRunData(legacyFinished),
      'an archived finished run remains readable after the binding rule is introduced',
    );
    const newStarted = structuredClone(legacyFinished);
    newStarted.status = 'started';
    newStarted.finishedAt = null;
    assert.throws(
      () => validateRunData(newStarted),
      /argv|selectedFileCount/u,
      'new related evidence cannot be persisted without a selected-file binding',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('docs final verification reuses implementation paths for related evidence without attributing changes to the final run', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-docs-final-related-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', 'iter-docs-final-related',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const captureScript = path.join(workspace, 'capture-docs-final.mjs');
    const captureOutput = path.join(workspace, '.plan2agent', 'capture-docs-final.json');
    writeFileSync(
      captureScript,
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n",
      'utf8',
    );
    writeFileSync(path.join(artifactRoot, 'project.config.json'), `${JSON.stringify({
      relatedVerification: [{
        type: 'test',
        argv: [process.execPath, captureScript, captureOutput],
        appendChangedFiles: true,
      }],
    }, null, 2)}\n`, 'utf8');
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# First revision\n', 'utf8');
    writeFileSync(path.join(workspace, '.gitignore'), '.plan2agent/\n', 'utf8');
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'fixture@example.com']);
    git(workspace, ['config', 'user.name', 'Plan2Agent Fixture']);
    git(workspace, ['add', '.gitignore', 'docs/guide.md']);
    git(workspace, ['commit', '-qm', 'documentation baseline']);

    for (const taskId of ['task-001', 'task-002', 'task-003', 'task-004']) {
      const implementationRunId = `run-docs-${taskId}`;
      result = runExecute([
        'start',
        '--artifacts', artifactRoot,
        '--task', taskId,
        '--run-id', implementationRunId,
        '--agent-tool', 'codex',
        '--workspace', workspace,
      ]);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      result = runExecute([
        'finish',
        '--artifacts', artifactRoot,
        '--run-id', implementationRunId,
        '--changed-file', 'docs/guide.md',
      ]);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    }

    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Current revision\n', 'utf8');
    git(workspace, ['add', 'docs/guide.md']);
    git(workspace, ['commit', '-qm', 'committed guide update']);
    writeFileSync(path.join(workspace, 'README.md'), '# Pending readme update\n', 'utf8');
    const finalRunId = 'run-docs-final-recovery';
    result = runExecute([
      'verify-final',
      '--artifacts', artifactRoot,
      '--scope', 'relevant',
      '--task', 'task-004',
      '--run-id', finalRunId,
      '--agent-tool', 'codex',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /--related/);
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', finalRunId,
      '--verify-command', `custom:${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', finalRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const finalRun = JSON.parse(readFileSync(
      runFilePath(path.join(artifactRoot, 'runs'), finalRunId),
      'utf8',
    ));
    assert.deepEqual(finalRun.changedFiles, []);
    assert.equal(finalRun.status, 'finished');
    assert.equal(finalRun.verificationScope, 'relevant');
    assert.equal(finalRun.verification.some((item) => item.scope === 'full'), true);
    assert.equal(finalRun.verification.at(-1)?.scope, 'related');
    assert.deepEqual(
      JSON.parse(readFileSync(captureOutput, 'utf8')),
      [
        'docs/guide.md',
        'README.md',
        '.plan2agent/artifacts/webhook-api-service/project.config.json',
      ],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a real final verification failure closes evidence and reopens the owning task', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-final-product-failure-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    const iterationId = 'iter-final-product-failure';
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', iterationId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      iterationId,
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    for (const task of graph.tasks) task.status = 'done';
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    const ownerTask = graph.tasks.at(-1);
    const runId = 'run-final-product-failure';
    result = runExecute([
      'verify-final',
      '--artifacts', artifactRoot,
      '--task', ownerTask.id,
      '--run-id', runId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--verify-command', `custom:${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const failedRun = JSON.parse(readFileSync(
      runFilePath(path.join(artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(failedRun.status, 'failed');
    assert.equal(failedRun.failure?.class, 'verification_failed');
    assert.equal(failedRun.reproduction?.commands.length > 0, true);
    assert.equal(failedRun.localization?.findings.length > 0, true);
    assert.equal(failedRun.guard?.checks.length > 0, true);
    const reopenedGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(reopenedGraph.tasks.find((task) => task.id === ownerTask.id)?.status, 'todo');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a successful final retry supersedes an unavailable attempt for the same command', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-final-environment-retry-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    const iterationId = 'iter-final-environment-retry';
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', iterationId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      iterationId,
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    for (const task of graph.tasks) task.status = 'done';
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    const ownerTask = graph.tasks.at(-1);
    const runId = 'run-final-environment-retry';
    result = runExecute([
      'verify-final',
      '--artifacts', artifactRoot,
      '--task', ownerTask.id,
      '--run-id', runId,
      '--agent-tool', 'manual',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
      "if (!process.env.P2A_TEST_COMMAND_READY) {",
      "  console.error('/bin/sh: 1: p2a-test-command: not found');",
      '  process.exit(127);',
      '}',
    ].join(' '))}`;
    const unavailableEnv = { ...process.env };
    delete unavailableEnv.P2A_TEST_COMMAND_READY;
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--test-command', command,
    ], { env: unavailableEnv });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--test-command', command,
    ], { env: { ...process.env, P2A_TEST_COMMAND_READY: '1' } });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const finishedRun = JSON.parse(readFileSync(
      runFilePath(path.join(artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.deepEqual(finishedRun.verification.map((item) => item.status), ['unavailable', 'passed']);
    assert.equal(finishedRun.status, 'finished');
    const finishedGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    assert.equal(finishedGraph.tasks.find((task) => task.id === ownerTask.id)?.status, 'done');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('reusable implementation full evidence selects a deleted document when Git history is unavailable', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-high-risk-docs-after-verify-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
    let result = runIteration([
      'init',
      '--artifacts', artifactRoot,
      '--iteration-id', 'iter-high-risk-docs-after-verify',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'core.js'), 'export const value = true;\n', 'utf8');
    writeFileSync(path.join(workspace, 'README.md'), '# Baseline documentation\n', 'utf8');
    writeFileSync(path.join(workspace, '.gitignore'), '.plan2agent/\n', 'utf8');
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'fixture@example.com']);
    git(workspace, ['config', 'user.name', 'Plan2Agent Fixture']);
    git(workspace, ['add', '.gitignore', 'README.md', 'src/core.js']);
    git(workspace, ['commit', '-qm', 'product baseline']);

    const implementationRunId = 'run-high-risk-implementation';
    result = runExecute([
      'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', implementationRunId,
      '--agent-tool', 'codex',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'docs', 'created-after-run-start.md'),
      '# Documentation created before verification\n',
      'utf8',
    );
    git(workspace, ['add', 'docs/created-after-run-start.md']);
    git(workspace, ['commit', '-qm', 'add documentation before verification']);
    result = runRuns([
      'verify',
      '--artifacts', artifactRoot,
      '--run-id', implementationRunId,
      '--test-command', `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const verificationHead = git(workspace, ['rev-parse', 'HEAD']);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', implementationRunId,
      '--changed-file', 'src/core.js',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'iter-high-risk-docs-after-verify',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    for (const task of graph.tasks) task.status = 'done';
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    rmSync(path.join(workspace, 'README.md'));
    rmSync(path.join(workspace, 'docs', 'created-after-run-start.md'));
    git(workspace, ['add', '-A', 'README.md', 'docs/created-after-run-start.md']);
    git(workspace, ['commit', '-qm', 'remove obsolete documentation']);
    const implementationRun = JSON.parse(readFileSync(
      runFilePath(path.join(artifactRoot, 'runs'), implementationRunId),
      'utf8',
    ));
    assert.ok(implementationRun.docsMetadataBaseline.includes('README.md'));
    assert.ok(implementationRun.docsMetadataBaseline.includes('docs/created-after-run-start.md'));
    assert.equal(implementationRun.verification[0].gitHeadSha, verificationHead);
    rmSync(path.join(workspace, '.git'), { recursive: true, force: true });

    const relevantRunId = 'run-high-risk-final-relevant';
    result = runExecute([
      'verify-final',
      '--scope', 'relevant',
      '--artifacts', artifactRoot,
      '--task', graph.tasks.at(-1).id,
      '--run-id', relevantRunId,
      '--agent-tool', 'codex',
      '--workspace', workspace,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runRuns([
      'verify',
      '--related',
      '--artifacts', artifactRoot,
      '--run-id', relevantRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runExecute([
      'finish',
      '--artifacts', artifactRoot,
      '--run-id', relevantRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const relevantRun = JSON.parse(readFileSync(
      runFilePath(path.join(artifactRoot, 'runs'), relevantRunId),
      'utf8',
    ));
    const related = relevantRun.verification.find((item) => item.scope === 'related');
    assert.ok(related);
    assert.deepEqual(
      related.argv.slice(-related.selectedFileCount),
      ['docs/created-after-run-start.md', 'README.md'],
    );
    assert.doesNotThrow(() => assertFinalFullVerificationReady({
      runsDir: path.join(artifactRoot, 'runs'),
      runs: [
        implementationRun,
        relevantRun,
      ],
      artifactRoot,
      graphPath,
      activeIteration: 'iter-high-risk-docs-after-verify',
    }));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('close-ready full evidence is canonical and revision bound', () => {
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

    let revisionRuns = 0;
    const retainedRuns = Array.from({ length: 20 }, (_, index) => ({
      ...structuredClone(run),
      runId: `run-final-verification-retained-${index + 1}`,
    }));
    const retainedReady = assertFinalFullVerificationReady({
      runsDir,
      runs: retainedRuns,
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
      workspaceRevisionProvider: (...revisionArgs) => {
        revisionRuns += 1;
        return workspaceRevisionSha256(...revisionArgs);
      },
    });
    assert.equal(retainedReady.verification.length, 1);
    assert.equal(revisionRuns, 2);

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
      /latest full verification-affecting run .* is failed/,
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

    const customOnly = structuredClone(run);
    customOnly.verification[0].type = 'custom';
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [customOnly],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /no finished canonical final run contains passed full/,
    );

    const clockSkewedRetry = structuredClone(run);
    clockSkewedRetry.verification.push({
      ...clockSkewedRetry.verification[0],
      status: 'failed',
      exitCode: 1,
      startedAt: '2026-08-25T23:00:00.000Z',
      finishedAt: '2026-08-25T23:00:01.000Z',
    });
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [clockSkewedRetry],
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

test('verification profiles reuse canonical implementation evidence without weakening integration boundaries', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-risk-profile-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'src', 'feature.js'), 'export const feature = true;\n', 'utf8');

    const implementationRun = {
      runId: 'run-implementation-full',
      taskId: 'task-001',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: ['src/feature.js'],
      startedAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      finishedAt: '2026-08-26T00:01:00.000Z',
      verification: [],
    };
    const baseExclusions = workspaceRevisionExcludedPathsForRun(runsDir, implementationRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    const workspaceRevision = workspaceRevisionSha256(workspace, baseExclusions);
    const productRevision = workspaceRevisionSha256(
      workspace,
      [...baseExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    implementationRun.workspaceRevisionSha256 = workspaceRevision;
    implementationRun.productRevisionSha256 = productRevision;
    implementationRun.verification.push({
      type: 'test',
      command: 'npm test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'full',
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
    });

    let ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [implementationRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, implementationRun.runId);
    assert.equal(ready.profile.id, 'isolated_code');

    writeFileSync(path.join(workspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
    }, null, 2)}\n`, 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /lint:npm run lint/,
      'every configured code verification must be current before close',
    );
    implementationRun.verification.push({
      type: 'lint',
      command: 'npm run lint',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'full',
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
    });
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
      'changing verification config after full evidence requires current related evidence',
    );

    writeFileSync(path.join(workspace, 'README.md'), '# Updated docs only\n', 'utf8');
    const currentDocsWorkspaceRevision = workspaceRevisionSha256(workspace, baseExclusions);
    const mixedWorkspaceRun = structuredClone(implementationRun);
    mixedWorkspaceRun.runId = 'run-mixed-full-workspace-evidence';
    mixedWorkspaceRun.workspaceRevisionSha256 = currentDocsWorkspaceRevision;
    mixedWorkspaceRun.verification[1] = {
      ...mixedWorkspaceRun.verification[1],
      workspaceRevisionSha256: currentDocsWorkspaceRevision,
    };
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [mixedWorkspaceRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
      'every configured full obligation must cover the current workspace before related verification is skipped',
    );
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
    );
    const isolatedRelevantRun = structuredClone(implementationRun);
    isolatedRelevantRun.runId = 'run-isolated-docs-relevant';
    isolatedRelevantRun.runKind = 'final_verification';
    isolatedRelevantRun.verificationScope = 'relevant';
    isolatedRelevantRun.changedFiles = [];
    const isolatedRelevantExclusions = workspaceRevisionExcludedPathsForRun(
      runsDir,
      isolatedRelevantRun,
      { artifactRoot, graphPath, workspacePath: workspace },
    );
    isolatedRelevantRun.workspaceRevisionSha256 = workspaceRevisionSha256(
      workspace,
      isolatedRelevantExclusions,
    );
    isolatedRelevantRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...isolatedRelevantExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    isolatedRelevantRun.verification = [{
      type: 'test',
      command: 'npm run docs:check',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: ['docs-check', 'README.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: isolatedRelevantRun.workspaceRevisionSha256,
      productRevisionSha256: isolatedRelevantRun.productRevisionSha256,
    }];
    const unboundRelevantRun = structuredClone(isolatedRelevantRun);
    unboundRelevantRun.runId = 'run-isolated-docs-unbound';
    delete unboundRelevantRun.verification[0].argv;
    delete unboundRelevantRun.verification[0].selectedFileCount;
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun, unboundRelevantRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /selected-file argv binding/u,
      'legacy unbound evidence may remain readable but cannot satisfy current related verification',
    );
    ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [implementationRun, isolatedRelevantRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, implementationRun.runId);
    assert.equal(ready.relevantRun.runId, isolatedRelevantRun.runId);
    assert.notEqual(ready.workspaceRevisionSha256, workspaceRevision);
    assert.equal(ready.productRevisionSha256, productRevision);

    const integrationRun = structuredClone(implementationRun);
    integrationRun.runId = 'run-api-integration';
    integrationRun.changedFiles = ['src/api/routes.js'];
    assert.equal(classifyVerificationProfile([integrationRun]).id, 'high_risk_integration');
    assert.equal(isDocsMetadataPath('docs/guide.md'), true);
    assert.equal(isDocsMetadataPath('packages/widget/README.md'), true);
    assert.equal(isDocsMetadataPath('README.ko-KR.md'), true);
    assert.equal(isDocsMetadataPath('.plan2agent/metadata.json'), true);
    assert.equal(isDocsMetadataPath('docs/src/Nav.tsx'), false);
    assert.equal(isDocsMetadataPath('src/license.ts'), false);
    assert.equal(isDocsMetadataPath('src/README.js'), false);
    assert.equal(isDocsMetadataPath('src/templates/product-prompt.md'), false);
    assert.equal(isDocsMetadataPath('docs/../src/README.md'), false);
    assert.equal(classifyVerificationProfile([{ ...implementationRun, changedFiles: ['docs/../src/README.md'] }]).id, 'high_risk_integration');
    assert.equal(
      classifyVerificationProfile([{
        ...implementationRun,
        changedFiles: ['docs/guide.md', '../src/app.js'],
      }]).id,
      'high_risk_integration',
      'an unsafe legacy path must not be discarded into a docs-only profile',
    );
    for (const unsafePath of ['C:\\outside\\feature.js', '.', 'docs/guide.md\0src/app.js']) {
      assert.equal(
        classifyVerificationProfile([{ ...implementationRun, changedFiles: [unsafePath] }]).id,
        'high_risk_integration',
        `${JSON.stringify(unsafePath)} must fail closed to the high-risk profile`,
      );
    }

    const finalRun = structuredClone(integrationRun);
    finalRun.runId = 'run-api-final-verification';
    finalRun.runKind = 'final_verification';
    finalRun.changedFiles = [];
    const finalExclusions = workspaceRevisionExcludedPathsForRun(runsDir, finalRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    finalRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, finalExclusions);
    finalRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...finalExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    finalRun.verification = implementationRun.verification.map((item) => ({
      ...item,
      workspaceRevisionSha256: finalRun.workspaceRevisionSha256,
      productRevisionSha256: finalRun.productRevisionSha256,
    }));
    ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [integrationRun, finalRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, finalRun.runId);
    assert.equal(ready.profile.id, 'high_risk_integration');

    writeFileSync(path.join(workspace, 'README.md'), '# Docs changed after integration verification\n', 'utf8');
    finalRun.workspaceRevisionSha256 = workspaceRevisionSha256(
      workspace,
      finalExclusions,
    );
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [integrationRun, finalRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
      'the full evidence item revision, not the later run finish snapshot, controls docs coverage',
    );

    const integrationRelevantRun = structuredClone(finalRun);
    integrationRelevantRun.runId = 'run-api-docs-relevant';
    integrationRelevantRun.verificationScope = 'relevant';
    const integrationRelevantExclusions = workspaceRevisionExcludedPathsForRun(
      runsDir,
      integrationRelevantRun,
      { artifactRoot, graphPath, workspacePath: workspace },
    );
    integrationRelevantRun.workspaceRevisionSha256 = workspaceRevisionSha256(
      workspace,
      integrationRelevantExclusions,
    );
    integrationRelevantRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...integrationRelevantExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    integrationRelevantRun.verification = [{
      type: 'test',
      command: 'npm run docs:check',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: ['docs-check', 'README.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: integrationRelevantRun.workspaceRevisionSha256,
      productRevisionSha256: integrationRelevantRun.productRevisionSha256,
    }];
    ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [integrationRun, finalRun, integrationRelevantRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.run.runId, finalRun.runId);
    assert.equal(ready.relevantRun.runId, integrationRelevantRun.runId);

    const failedRelevantRetry = structuredClone(integrationRelevantRun);
    failedRelevantRetry.runId = 'run-api-docs-relevant-failed';
    failedRelevantRetry.status = 'failed';
    failedRelevantRetry.verification[0].status = 'failed';
    failedRelevantRetry.verification[0].exitCode = 1;
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [integrationRun, finalRun, integrationRelevantRun, failedRelevantRetry],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
      'a newer failed related attempt must invalidate the older related pass',
    );

    mkdirSync(path.join(workspace, 'packages', 'widget'), { recursive: true });
    writeFileSync(path.join(workspace, 'packages', 'widget', 'README.md'), '# Widget docs\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => error.verificationScope === 'relevant',
    );

    mkdirSync(path.join(workspace, 'docs', 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'docs', 'src', 'Nav.tsx'), 'export const Nav = () => null;\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /stale/,
      'executable files under docs must remain part of the product revision',
    );

    const docsRun = structuredClone(implementationRun);
    docsRun.runId = 'run-docs-follow-up';
    docsRun.taskId = 'task-docs';
    docsRun.changedFiles = ['README.md'];
    assert.equal(
      classifyVerificationProfile([implementationRun, docsRun]).id,
      'isolated_code',
      'a documentation-only task must not turn one product-code task into multi-task integration risk',
    );
    assert.equal(
      classifyVerificationProfile([
        { ...docsRun, changedFiles: [] },
        docsRun,
      ]).id,
      'high_risk_integration',
      'an implementation run with unknown changed-file scope must not disappear into docs-only evidence',
    );

    const supersededFailure = structuredClone(implementationRun);
    supersededFailure.runId = 'run-failed-api-attempt';
    supersededFailure.status = 'failed';
    supersededFailure.changedFiles = ['src/api/routes.js'];
    assert.equal(
      classifyVerificationProfile([supersededFailure, implementationRun]).id,
      'high_risk_integration',
      'a failed high-risk attempt remains a verification obligation until canonical full evidence resolves it',
    );
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [integrationRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /canonical final run/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a failed product attempt cannot be closed by a later documentation-only pass', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-failed-product-obligation-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(path.join(workspace, 'src', 'auth'), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'src', 'auth', 'routes.js'), 'export const changed = true;\n', 'utf8');
    writeFileSync(path.join(workspace, 'README.md'), '# Current docs\n', 'utf8');

    const baseRun = {
      taskId: 'task-001',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
    };
    const failedRun = {
      ...baseRun,
      runId: 'run-product-failed',
      status: 'failed',
      changedFiles: ['src/auth/routes.js'],
      verification: [],
    };
    const failedExclusions = workspaceRevisionExcludedPathsForRun(runsDir, failedRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    const workspaceRevision = workspaceRevisionSha256(workspace, failedExclusions);
    const productRevision = workspaceRevisionSha256(
      workspace,
      [...failedExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    failedRun.verification.push({
      type: 'test',
      command: 'npm test',
      status: 'failed',
      exitCode: 1,
      source: 'config',
      scope: 'full',
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
    });

    const docsRun = {
      ...baseRun,
      runId: 'run-docs-finished',
      taskId: 'task-docs',
      status: 'finished',
      changedFiles: ['README.md'],
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
      startedAt: '2026-08-30T00:02:00.000Z',
      updatedAt: '2026-08-30T00:03:00.000Z',
      finishedAt: '2026-08-30T00:03:00.000Z',
      verification: [{
        type: 'custom',
        command: 'p2a related file integrity',
        status: 'passed',
        exitCode: 0,
        source: 'command',
        scope: 'related',
        argv: ['p2a-related-check', 'README.md'],
        selectedFileCount: 1,
        workspaceRevisionSha256: workspaceRevision,
        productRevisionSha256: productRevision,
      }],
    };

    assert.equal(
      classifyVerificationProfile([failedRun, docsRun]).id,
      'high_risk_integration',
    );
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [failedRun, docsRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /latest full verification-affecting run .* is failed/u,
    );

  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a newer empty environment failure invalidates an older final verification pass', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-empty-final-failure-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(workspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
    }, null, 2)}\n`, 'utf8');

    const passedRun = {
      runId: 'run-final-pass',
      runKind: 'final_verification',
      verificationScope: 'full',
      taskId: 'task-001',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: [],
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:01:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
      verification: [],
    };
    const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, passedRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    passedRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, exclusions);
    passedRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...exclusions, ...productRevisionExcludedPaths(workspace)],
    );
    passedRun.verification.push({
      type: 'test',
      command: 'npm test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'full',
      workspaceRevisionSha256: passedRun.workspaceRevisionSha256,
      productRevisionSha256: passedRun.productRevisionSha256,
    });
    const failedRun = {
      ...structuredClone(passedRun),
      runId: 'run-final-environment-failure',
      status: 'failed',
      startedAt: '2026-08-30T00:02:00.000Z',
      updatedAt: '2026-08-30T00:03:00.000Z',
      finishedAt: '2026-08-30T00:03:00.000Z',
      verification: [],
      failure: {
        class: 'environment_failure',
        retryable: 'yes',
        needsUserDecision: false,
        source: 'owner',
      },
    };

    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [passedRun, failedRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /latest full verification-affecting run .* is failed/u,
    );

    const failedWithEvidence = structuredClone(failedRun);
    failedWithEvidence.runId = 'run-final-environment-failure-with-evidence';
    failedWithEvidence.verification = [{
      ...passedRun.verification[0],
      status: 'failed',
      exitCode: 1,
    }];
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [passedRun, failedWithEvidence],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /latest full verification-affecting run .* is failed/u,
      'run failure precedence does not depend on an empty verification array',
    );

    passedRun.verification.push({
      ...passedRun.verification[0],
      type: 'lint',
      command: 'npm run lint',
    });
    const testRecovery = structuredClone(passedRun);
    testRecovery.runId = 'run-final-test-recovery';
    testRecovery.startedAt = '2026-08-30T00:04:00.000Z';
    testRecovery.updatedAt = '2026-08-30T00:05:00.000Z';
    testRecovery.finishedAt = '2026-08-30T00:05:00.000Z';
    testRecovery.verification = [structuredClone(passedRun.verification[0])];
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [passedRun, failedRun, testRecovery],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /lint:npm run lint/u,
      'one later success must not revive a different obligation from before the failed run',
    );

    const lintRecovery = structuredClone(testRecovery);
    lintRecovery.runId = 'run-final-lint-recovery';
    lintRecovery.startedAt = '2026-08-30T00:06:00.000Z';
    lintRecovery.updatedAt = '2026-08-30T00:07:00.000Z';
    lintRecovery.finishedAt = '2026-08-30T00:07:00.000Z';
    lintRecovery.verification = [structuredClone(passedRun.verification[1])];
    assert.doesNotThrow(() => assertFinalFullVerificationReady({
      runsDir,
      runs: [passedRun, failedRun, testRecovery, lintRecovery],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    }));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('parallel final verification runs are ordered by completion rather than start/index order', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-parallel-final-order-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');

    const baseRun = {
      runKind: 'final_verification',
      verificationScope: 'full',
      taskId: 'task-001',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: [],
    };
    const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, baseRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    const workspaceRevision = workspaceRevisionSha256(workspace, exclusions);
    const productRevision = workspaceRevisionSha256(
      workspace,
      [...exclusions, ...productRevisionExcludedPaths(workspace)],
    );
    const verification = (status, startedAt, finishedAt) => ({
      type: 'test',
      command: 'npm test',
      status,
      exitCode: status === 'passed' ? 0 : 1,
      source: 'config',
      scope: 'full',
      startedAt,
      finishedAt,
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
    });
    const lateFailure = {
      ...baseRun,
      runId: 'run-parallel-started-first-failed-last',
      status: 'failed',
      startedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:04:00.000Z',
      finishedAt: '2026-08-30T00:04:00.000Z',
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
      verification: [verification(
        'failed',
        '2026-08-30T00:03:00.000Z',
        '2026-08-30T00:04:00.000Z',
      )],
    };
    const earlySuccess = {
      ...baseRun,
      runId: 'run-parallel-started-second-passed-first',
      status: 'finished',
      startedAt: '2026-08-30T00:01:00.000Z',
      updatedAt: '2026-08-30T00:03:00.000Z',
      finishedAt: '2026-08-30T00:03:00.000Z',
      workspaceRevisionSha256: workspaceRevision,
      productRevisionSha256: productRevision,
      verification: [verification(
        'passed',
        '2026-08-30T00:02:00.000Z',
        '2026-08-30T00:03:00.000Z',
      )],
    };

    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [lateFailure, earlySuccess],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /latest full verification-affecting run .* is failed/u,
      'a later terminal failure must not be hidden by a run that started later but passed earlier',
    );

    const slowSuccess = {
      ...earlySuccess,
      runId: 'run-parallel-started-first-passed-last',
      startedAt: '2026-08-29T23:59:00.000Z',
      updatedAt: '2026-08-30T00:05:00.000Z',
      finishedAt: '2026-08-30T00:05:00.000Z',
      verification: [verification(
        'passed',
        '2026-08-30T00:04:01.000Z',
        '2026-08-30T00:05:00.000Z',
      )],
    };
    const ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [slowSuccess, lateFailure],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(
      ready.run.runId,
      slowSuccess.runId,
      'a success that started first but completed last must recover a quicker later-started failure',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('an empty documentation directory does not change the product revision', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-empty-docs-product-revision-'));
  try {
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    const before = workspaceRevisionSha256(
      workspace,
      productRevisionExcludedPaths(workspace),
    );
    rmSync(path.join(workspace, 'docs', 'guide.md'));
    const after = workspaceRevisionSha256(
      workspace,
      productRevisionExcludedPaths(workspace),
    );
    assert.equal(after, before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('docs-only related verification covers documents committed after the implementation run', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-docs-committed-after-run-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');
    writeFileSync(path.join(workspace, 'docs', 'known.md'), '# Known\n', 'utf8');
    git(workspace, ['init', '-q']);
    git(workspace, ['config', 'user.email', 'fixture@example.com']);
    git(workspace, ['config', 'user.name', 'Plan2Agent Fixture']);
    git(workspace, ['add', '-A']);
    git(workspace, ['commit', '-qm', 'initial docs']);
    const baselineHead = git(workspace, ['rev-parse', 'HEAD']);

    const implementationRun = {
      runId: 'run-docs-implementation',
      taskId: 'task-001',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: ['docs/known.md'],
      git: { headSha: baselineHead, branch: 'main', dirty: false },
      startedAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
      finishedAt: '2026-08-29T00:01:00.000Z',
      verification: [],
    };
    const implementationExclusions = workspaceRevisionExcludedPathsForRun(
      runsDir,
      implementationRun,
      { artifactRoot, graphPath, workspacePath: workspace },
    );
    implementationRun.workspaceRevisionSha256 = workspaceRevisionSha256(
      workspace,
      implementationExclusions,
    );
    implementationRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...implementationExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    implementationRun.verification.push({
      type: 'test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: ['docs-check', 'docs/known.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: implementationRun.workspaceRevisionSha256,
      productRevisionSha256: implementationRun.productRevisionSha256,
    });

    writeFileSync(path.join(workspace, 'docs', 'committed-later.md'), '# Later\n', 'utf8');
    git(workspace, ['add', 'docs/committed-later.md']);
    git(workspace, ['commit', '-qm', 'later docs']);

    const recoveryRun = structuredClone(implementationRun);
    recoveryRun.runId = 'run-docs-recovery';
    recoveryRun.runKind = 'final_verification';
    recoveryRun.verificationScope = 'relevant';
    recoveryRun.changedFiles = [];
    recoveryRun.startedAt = '2026-08-29T00:02:00.000Z';
    recoveryRun.updatedAt = '2026-08-29T00:03:00.000Z';
    recoveryRun.finishedAt = '2026-08-29T00:03:00.000Z';
    const recoveryExclusions = workspaceRevisionExcludedPathsForRun(
      runsDir,
      recoveryRun,
      { artifactRoot, graphPath, workspacePath: workspace },
    );
    recoveryRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, recoveryExclusions);
    recoveryRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...recoveryExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    recoveryRun.verification = [{
      ...implementationRun.verification[0],
      argv: ['docs-check', 'docs/known.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: recoveryRun.workspaceRevisionSha256,
      productRevisionSha256: recoveryRun.productRevisionSha256,
    }];

    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun, recoveryRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /committed-later\.md/,
    );
    recoveryRun.verification[0].argv.push('docs/committed-later.md');
    recoveryRun.verification[0].selectedFileCount = 2;
    assert.equal(
      assertFinalFullVerificationReady({
        runsDir,
        runs: [implementationRun, recoveryRun],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }).relevantRun.runId,
      recoveryRun.runId,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('docs-only changes accept current relevant evidence from implementation or recovery runs', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-docs-profile-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const graphPath = path.join(artifactRoot, 'iterations', 'v1', 'gate-c-task-graph', 'task-graph.json');
    const runsDir = path.join(artifactRoot, 'runs');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(graphPath, '{}\n', 'utf8');
    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    const projectConfigPath = path.join(workspace, '.plan2agent', 'project.config.json');
    const oldRelatedArgv = [process.execPath, 'docs-check-old.mjs'];
    const newRelatedArgv = [process.execPath, 'docs-check-new.mjs'];
    writeFileSync(projectConfigPath, `${JSON.stringify({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      relatedVerification: [{
        type: 'test',
        argv: oldRelatedArgv,
        appendChangedFiles: true,
      }],
    }, null, 2)}\n`, 'utf8');
    const run = {
      runId: 'run-docs-check',
      taskId: 'task-docs',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      taskGraphRef: 'iterations/v1/gate-c-task-graph/task-graph.json',
      status: 'finished',
      workspacePath: workspace,
      isolation: { mode: 'none' },
      changedFiles: ['docs/guide.md'],
      startedAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
      finishedAt: '2026-08-26T00:01:00.000Z',
      verification: [],
    };
    const exclusions = workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    const revision = workspaceRevisionSha256(workspace, exclusions);
    run.workspaceRevisionSha256 = revision;
    run.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...exclusions, ...productRevisionExcludedPaths(workspace)],
    );
    run.verification.push({
      type: 'test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: [...oldRelatedArgv, 'docs/guide.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: revision,
      productRevisionSha256: run.productRevisionSha256,
    });
    const ready = assertFinalFullVerificationReady({
      runsDir,
      runs: [run],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(ready.profile.id, 'docs_metadata');
    assert.equal(ready.verification.length, 1);

    writeFileSync(path.join(workspace, 'product.js'), 'export const changed = true;\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      (error) => (
        error.verificationScope === 'full'
        && error.verificationProfile?.id === 'high_risk_integration'
      ),
      'an unrecorded product change must immediately leave the docs-only verification path',
    );
    rmSync(path.join(workspace, 'product.js'));

    writeFileSync(projectConfigPath, `${JSON.stringify({
      testCommand: 'npm test',
      lintCommand: 'npm run lint',
      typecheckCommand: 'npm run typecheck',
      relatedVerification: [{
        type: 'test',
        argv: newRelatedArgv,
        appendChangedFiles: true,
      }],
    }, null, 2)}\n`, 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /stale|missing configured related verification/,
      'changing P2A verification config must require current evidence',
    );

    writeFileSync(path.join(workspace, 'docs', 'guide.md'), '# Updated guide\n', 'utf8');
    assert.throws(
      () => assertFinalFullVerificationReady({
        runsDir,
        runs: [run],
        artifactRoot,
        graphPath,
        activeIteration: 'v1',
      }),
      /relevant evidence|stale/,
    );

    const recoveryRun = structuredClone(run);
    recoveryRun.runId = 'run-docs-current-recovery';
    recoveryRun.runKind = 'final_verification';
    recoveryRun.changedFiles = [];
    recoveryRun.startedAt = '2026-08-26T00:02:00.000Z';
    recoveryRun.updatedAt = '2026-08-26T00:03:00.000Z';
    recoveryRun.finishedAt = '2026-08-26T00:03:00.000Z';
    const recoveryExclusions = workspaceRevisionExcludedPathsForRun(runsDir, recoveryRun, {
      artifactRoot,
      graphPath,
      workspacePath: workspace,
    });
    recoveryRun.workspaceRevisionSha256 = workspaceRevisionSha256(workspace, recoveryExclusions);
    recoveryRun.productRevisionSha256 = workspaceRevisionSha256(
      workspace,
      [...recoveryExclusions, ...productRevisionExcludedPaths(workspace)],
    );
    recoveryRun.verification = [{
      type: 'test',
      status: 'passed',
      exitCode: 0,
      source: 'config',
      scope: 'related',
      argv: [...newRelatedArgv, 'docs/guide.md'],
      selectedFileCount: 1,
      workspaceRevisionSha256: recoveryRun.workspaceRevisionSha256,
      productRevisionSha256: recoveryRun.productRevisionSha256,
    }];
    const recovered = assertFinalFullVerificationReady({
      runsDir,
      runs: [run, recoveryRun],
      artifactRoot,
      graphPath,
      activeIteration: 'v1',
    });
    assert.equal(recovered.run.runId, recoveryRun.runId);
    assert.equal(recovered.profile.id, 'docs_metadata');
    assert.equal(recovered.verification.length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('retrospective report exclusions stay stable before and after a final run finishes', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-retrospective-revision-'));
  try {
    const artifactRoot = path.join(workspace, '.plan2agent', 'artifacts', 'sample');
    const runsDir = path.join(artifactRoot, 'runs');
    const reportDir = path.join(workspace, 'docs', 'retrospective');
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(workspace, 'product.js'), 'export const value = 1;\n', 'utf8');

    const existingReportPath = path.join(reportDir, 'sample-v1.md');
    writeFileSync(existingReportPath, '# Existing retrospective\n', 'utf8');
    const existingBoundary = Date.now() + 1000;
    const existingRun = {
      projectId: 'sample',
      iterationId: 'v1',
      sourceLayout: 'iteration',
      workspacePath: workspace,
      startedAt: new Date(existingBoundary).toISOString(),
    };
    const revisionFor = (run) => workspaceRevisionSha256(
      workspace,
      workspaceRevisionExcludedPathsForRun(runsDir, run, {
        artifactRoot,
        workspacePath: workspace,
      }),
    );
    const beforeFinish = revisionFor(existingRun);
    existingRun.finishedAt = new Date(existingBoundary + 1000).toISOString();
    assert.equal(revisionFor(existingRun), beforeFinish);
    writeFileSync(existingReportPath, '# Updated retrospective\n', 'utf8');
    const updatedReportTime = new Date(existingBoundary + 500);
    utimesSync(existingReportPath, updatedReportTime, updatedReportTime);
    assert.equal(revisionFor(existingRun), beforeFinish);

    rmSync(existingReportPath);
    const emptyDirectoryBoundary = Date.now() + 2000;
    const newReportRun = {
      projectId: 'sample',
      iterationId: 'v2',
      sourceLayout: 'iteration',
      workspacePath: workspace,
      startedAt: new Date(emptyDirectoryBoundary).toISOString(),
      finishedAt: new Date(emptyDirectoryBoundary + 2000).toISOString(),
    };
    const beforeReport = revisionFor(newReportRun);
    const newReportPath = path.join(reportDir, 'sample-v2.md');
    writeFileSync(newReportPath, '# New retrospective\n', 'utf8');
    const reportTime = new Date(emptyDirectoryBoundary + 1000);
    utimesSync(newReportPath, reportTime, reportTime);
    assert.equal(revisionFor(newReportRun), beforeReport);
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
