import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveBuildLoreInvocation,
  runBuildLore,
} from '../scripts/p2a_buildlore.mjs';
import { defaultCapabilityConfig } from '../scripts/p2a_project_config.mjs';

function projectFixture(config = {}, manifest = {}) {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'p2a-buildlore-'));
  const p2aRoot = path.join(targetRoot, '.plan2agent');
  mkdirSync(p2aRoot);
  writeFileSync(
    path.join(p2aRoot, 'project.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(p2aRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return targetRoot;
}

test('BuildLore capability defaults use the local CLI and explicit Git publication', () => {
  assert.deepEqual(defaultCapabilityConfig('buildlore'), {
    enabled: true,
    mode: 'local_cli',
    command: 'buildlore',
    commandEnv: 'BUILDLORE_BIN',
    commandArgs: [],
    projectIdSource: 'project_config',
    syncPolicy: 'explicit',
    retrievalMode: 'hybrid',
    publicationPolicy: 'explicit_git',
  });
});

test('p2a buildlore resolves project identity and maps sync to the BuildLore CLI', () => {
  const targetRoot = projectFixture({
    projectId: 'demo-project',
    buildlore: { command: 'buildlore' },
  });
  const invocation = resolveBuildLoreInvocation([
    'sync', '--target', targetRoot, '--dry-run', '--json',
  ], { environment: {} });

  assert.equal(invocation.executable, 'buildlore');
  assert.equal(invocation.targetRoot, targetRoot);
  assert.deepEqual(invocation.args, [
    'sync', '--project', 'demo-project', '--dry-run', '--json',
  ]);
});

test('p2a buildlore maps status to knowledge status and accepts the manifest project id', () => {
  const targetRoot = projectFixture({}, { projectId: 'manifest-project' });
  const invocation = resolveBuildLoreInvocation([
    'status', '--target', targetRoot, '--json',
  ], { environment: {} });

  assert.deepEqual(invocation.args, [
    'knowledge', 'status', '--project', 'manifest-project', '--json',
  ]);
});

test('p2a buildlore honors a single executable environment override without a shell', () => {
  const targetRoot = projectFixture({
    projectId: 'demo-project',
    buildlore: {
      command: 'buildlore',
      commandEnv: 'TEST_BUILDLORE_BIN',
      commandArgs: ['dist/cli/bin.js'],
    },
  });
  const invocation = resolveBuildLoreInvocation([
    'search', '--target', targetRoot, '--query', 'failure reason', '--mode', 'lexical',
  ], { environment: { TEST_BUILDLORE_BIN: '/usr/bin/node' } });

  assert.equal(invocation.executable, '/usr/bin/node');
  assert.deepEqual(invocation.args, [
    'dist/cli/bin.js',
    'search', '--project', 'demo-project',
    '--query', 'failure reason', '--mode', 'lexical',
  ]);
});

test('p2a buildlore safely permits an executable path containing spaces', () => {
  const targetRoot = projectFixture({
    projectId: 'demo-project',
    buildlore: { command: './tools/build lore' },
  });
  const invocation = resolveBuildLoreInvocation([
    'check', '--target', targetRoot,
  ], { environment: {} });

  assert.equal(invocation.executable, path.join(targetRoot, 'tools', 'build lore'));
  assert.deepEqual(invocation.args, ['check', '--project', 'demo-project']);
});

test('p2a buildlore executes in the project root and preserves the child exit status', () => {
  const targetRoot = projectFixture({ projectId: 'demo-project' });
  let captured = null;
  const status = runBuildLore([
    'check', '--target', targetRoot, '--json',
  ], {
    environment: {},
    runner(executable, args, options) {
      captured = { executable, args, options };
      return { status: 5 };
    },
  });

  assert.equal(status, 5);
  assert.equal(captured.executable, 'buildlore');
  assert.deepEqual(captured.args, ['check', '--project', 'demo-project', '--json']);
  assert.equal(captured.options.cwd, targetRoot);
  assert.equal(captured.options.stdio, 'inherit');
});

test('p2a buildlore fails before execution when a project-scoped command has no id', () => {
  const targetRoot = projectFixture();
  assert.throws(
    () => resolveBuildLoreInvocation(['sync', '--target', targetRoot]),
    /BuildLore project id is required/,
  );
});
