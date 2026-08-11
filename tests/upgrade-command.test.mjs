import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { globalPackageRoot, runUpgrade } from '../scripts/p2a_upgrade.mjs';
import { makeTempDir } from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createGlobalLayout(version = '1.0.0') {
  const tempRoot = makeTempDir('p2a-upgrade-command-');
  const prefix = path.join(tempRoot, 'prefix');
  const runtimeRoot = globalPackageRoot(prefix, 'plan2agent');
  const targetRoot = path.join(tempRoot, 'target');
  writeJson(path.join(runtimeRoot, 'package.json'), { name: 'plan2agent', version });
  mkdirSync(path.join(runtimeRoot, 'scripts'), { recursive: true });
  writeFileSync(path.join(runtimeRoot, 'scripts', 'p2a.mjs'), '// test entrypoint\n', 'utf8');
  writeFileSync(path.join(runtimeRoot, 'scripts', 'p2a_handoff.mjs'), '// test handoff\n', 'utf8');
  writeJson(path.join(targetRoot, '.plan2agent', 'manifest.json'), {
    provenance: { packageName: 'plan2agent', packageVersion: version },
    runtime: { mode: 'package', command: 'p2a' },
  });
  return { prefix, runtimeRoot, targetRoot, tempRoot };
}

function createIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      log(value) { stdout.push(String(value)); },
      error(value) { stderr.push(String(value)); },
    },
    stderr,
    stdout,
  };
}

function pathsFor(runtimeRoot, overrides = {}) {
  return {
    embedded: false,
    runtimeRoot,
    toolkitCheckout: false,
    ...overrides,
  };
}

function stagePackage(callOptions, version = '2.0.0') {
  const runtimeRoot = path.join(callOptions.cwd, 'node_modules', 'plan2agent');
  writeJson(path.join(runtimeRoot, 'package.json'), { name: 'plan2agent', version });
  mkdirSync(path.join(runtimeRoot, 'scripts'), { recursive: true });
  writeFileSync(path.join(runtimeRoot, 'scripts', 'p2a.mjs'), '// staged test entrypoint\n', 'utf8');
  writeFileSync(path.join(runtimeRoot, 'scripts', 'p2a_handoff.mjs'), '// staged test handoff\n', 'utf8');
  return runtimeRoot;
}

function isGlobalInstall(args) {
  return args[0] === 'install' && args.includes('--global');
}

function isStagingInstall(args) {
  return args[0] === 'install' && !args.includes('--global');
}

function pathEndsWith(filePath, suffix) {
  if (typeof filePath !== 'string') return false;
  return filePath.replaceAll('\\', '/').endsWith(suffix.replaceAll('\\', '/'));
}

test('upgrade dry-run accepts singleton-array npm latest and delegates the project plan to that exact version', () => {
  const layout = createGlobalLayout();
  const calls = [];
  const output = createIo();
  try {
    const runner = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
      if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '["2.0.0"]\n', stderr: '' };
      if (command === 'npm' && isStagingInstall(args)) {
        stagePackage(options);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--dry-run'],
      { io: output.io, paths: pathsFor(layout.runtimeRoot), runner },
    );
    assert.equal(status, 0);
    assert.ok(output.stdout.includes('runningVersion: 1.0.0'));
    assert.ok(output.stdout.includes('projectVersion: 1.0.0'));
    assert.ok(output.stdout.includes('latestVersion: 2.0.0'));
    assert.equal(calls.some((call) => call.command === 'npm' && isGlobalInstall(call.args)), false);
    assert.ok(calls.some((call) => call.command === 'npm' && isStagingInstall(call.args) && call.args.includes('plan2agent@2.0.0')));
    const projectPlan = calls.find((call) => call.args[0]?.endsWith('p2a_handoff.mjs'));
    assert.ok(projectPlan);
    assert.ok(projectPlan.args[0].includes('p2a-upgrade-stage-'));
    assert.ok(projectPlan.args.includes('--dry-run'));
    assert.equal(projectPlan.args.includes('--apply'), false);
    const stageRoot = path.resolve(projectPlan.args[0], '..', '..', '..', '..');
    assert.equal(existsSync(stageRoot), false);
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade apply refuses checkout and non-global package runtimes before mutation', () => {
  const layout = createGlobalLayout();
  const output = createIo();
  const calls = [];
  try {
    const runner = (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const checkoutStatus = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply'],
      { io: output.io, paths: pathsFor(layout.runtimeRoot, { toolkitCheckout: true }), runner },
    );
    assert.equal(checkoutStatus, 1);
    assert.match(output.stderr.join('\n'), /requires an npm-global p2a/);
    assert.equal(calls.length, 0);

    output.stderr.length = 0;
    const localRoot = path.join(layout.tempRoot, 'local', 'node_modules', 'plan2agent');
    writeJson(path.join(localRoot, 'package.json'), { name: 'plan2agent', version: '1.0.0' });
    const localStatus = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply'],
      {
        io: output.io,
        paths: pathsFor(localRoot),
        runner(command, args) {
          calls.push({ command, args });
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
          throw new Error('unexpected mutation command');
        },
      },
    );
    assert.equal(localStatus, 1);
    assert.match(output.stderr.join('\n'), /package_non_global/);
    assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'install'), false);
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade apply preflights and installs the exact reviewed version before reexecuting it', () => {
  const layout = createGlobalLayout();
  const output = createIo();
  const calls = [];
  try {
    const runner = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
      if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"2.0.0"\n', stderr: '' };
      if (command === 'npm' && isStagingInstall(args)) {
        stagePackage(options);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm' && isGlobalInstall(args)) {
        const metadataPath = path.join(layout.runtimeRoot, 'package.json');
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
        writeJson(metadataPath, { ...metadata, version: '2.0.0' });
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply', '--prune'],
      { io: output.io, paths: pathsFor(layout.runtimeRoot), runner },
    );
    assert.equal(status, 0, output.stderr.join('\n'));
    assert.ok(calls.some((call) => (
      call.command === 'npm'
      && call.args.join(' ') === 'install --global plan2agent@2.0.0 --no-audit --no-fund'
    )));
    const preflight = calls.find((call) => (
      call.args[0]?.includes('p2a-upgrade-stage-')
      && call.args[0]?.endsWith('p2a_handoff.mjs')
    ));
    assert.ok(preflight);
    assert.ok(preflight.args.includes('--dry-run'));
    assert.equal(preflight.args.includes('--apply'), false);
    assert.equal(preflight.options.env.P2A_UPGRADE_APPLY_PREFLIGHT, '1');
    const reentry = calls.find((call) => pathEndsWith(call.args[0], 'scripts/p2a.mjs'));
    assert.ok(reentry);
    assert.ok(reentry.args.includes('--prune'));
    assert.equal(reentry.options.env.P2A_UPGRADE_REENTRY, '1');
    assert.equal(reentry.options.env.P2A_UPGRADE_EXPECTED_VERSION, '2.0.0');
    assert.ok(output.stdout.includes('upgrade complete'));
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade apply skips npm install when the global package is already latest', () => {
  const layout = createGlobalLayout();
  const output = createIo();
  const calls = [];
  try {
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply'],
      {
        io: output.io,
        paths: pathsFor(layout.runtimeRoot),
        runner(command, args, options) {
          calls.push({ command, args, options });
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
          if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"1.0.0"\n', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(status, 0);
    assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'install'), false);
    const projectCalls = calls.filter((call) => call.args[0]?.endsWith('p2a_handoff.mjs'));
    assert.equal(projectCalls.length, 2);
    assert.ok(projectCalls[0].args.includes('--dry-run'));
    assert.equal(projectCalls[0].options.env.P2A_UPGRADE_APPLY_PREFLIGHT, '1');
    assert.ok(projectCalls[1].args.includes('--apply'));
    assert.ok(output.stdout.includes('package: up_to_date'));
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade apply distinguishes install failure from post-install project failure', () => {
  const installLayout = createGlobalLayout();
  const installOutput = createIo();
  try {
    const installStatus = runUpgrade(
      ['upgrade', '--target', installLayout.targetRoot, '--apply'],
      {
        io: installOutput.io,
        paths: pathsFor(installLayout.runtimeRoot),
        runner(command, args, options) {
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${installLayout.prefix}\n`, stderr: '' };
          if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"2.0.0"\n', stderr: '' };
          if (command === 'npm' && isStagingInstall(args)) {
            stagePackage(options);
            return { status: 0, stdout: '', stderr: '' };
          }
          if (command === 'npm' && isGlobalInstall(args)) {
            return { status: 7, stdout: '', stderr: 'permission denied' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(installStatus, 1);
    assert.match(installOutput.stderr.join('\n'), /permission denied/);
    assert.doesNotMatch(installOutput.stderr.join('\n'), /installation succeeded/);
  } finally {
    rmSync(installLayout.tempRoot, { recursive: true, force: true });
  }

  const reentryLayout = createGlobalLayout();
  const reentryOutput = createIo();
  try {
    const reentryStatus = runUpgrade(
      ['upgrade', '--target', reentryLayout.targetRoot, '--apply'],
      {
        io: reentryOutput.io,
        paths: pathsFor(reentryLayout.runtimeRoot),
        runner(command, args, options) {
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${reentryLayout.prefix}\n`, stderr: '' };
          if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"2.0.0"\n', stderr: '' };
          if (command === 'npm' && isStagingInstall(args)) {
            stagePackage(options);
            return { status: 0, stdout: '', stderr: '' };
          }
          if (command === 'npm' && isGlobalInstall(args)) {
            writeJson(path.join(reentryLayout.runtimeRoot, 'package.json'), { name: 'plan2agent', version: '2.0.0' });
            return { status: 0, stdout: '', stderr: '' };
          }
          if (options?.env?.P2A_UPGRADE_APPLY_PREFLIGHT === '1') {
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 9, stdout: '', stderr: 'project apply failed' };
        },
      },
    );
    assert.equal(reentryStatus, 1);
    assert.match(reentryOutput.stderr.join('\n'), /installation succeeded but project application did not/);
  } finally {
    rmSync(reentryLayout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade reentry validates the installed global version and skips npm registry and install calls', () => {
  const layout = createGlobalLayout('2.0.0');
  const calls = [];
  const output = createIo();
  try {
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply'],
      {
        env: { P2A_UPGRADE_REENTRY: '1', P2A_UPGRADE_EXPECTED_VERSION: '2.0.0' },
        io: output.io,
        paths: pathsFor(layout.runtimeRoot),
        runner(command, args) {
          calls.push({ command, args });
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(status, 0);
    assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'view'), false);
    assert.equal(calls.some((call) => call.command === 'npm' && call.args[0] === 'install'), false);
    assert.ok(calls.some((call) => call.args[0]?.endsWith('p2a_handoff.mjs')));
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('Windows npm commands use a shell while the new p2a runs through Node directly', () => {
  assert.equal(
    globalPackageRoot('C:\\Users\\tester\\AppData\\Roaming\\npm', 'plan2agent', 'win32'),
    'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\plan2agent',
  );
  assert.equal(
    pathEndsWith('C:\\npm\\node_modules\\plan2agent\\scripts\\p2a.mjs', 'scripts/p2a.mjs'),
    true,
  );
  const layout = createGlobalLayout();
  const calls = [];
  const output = createIo();
  try {
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--dry-run'],
      {
        io: output.io,
        paths: pathsFor(layout.runtimeRoot),
        platform: 'win32',
        runner(command, args, options) {
          calls.push({ command, args, options });
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: 'C:\\npm\n', stderr: '' };
          if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"1.0.0"\n', stderr: '' };
          if (command === 'npm' && isStagingInstall(args)) {
            stagePackage(options, '1.0.0');
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(status, 0);
    assert.ok(calls.filter((call) => call.command === 'npm').every((call) => call.options.shell === true));
    assert.ok(calls.filter((call) => call.command !== 'npm').every((call) => call.options.shell !== true));
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});

test('upgrade apply stops after latest-version preflight failure without changing the global package', () => {
  const layout = createGlobalLayout();
  const calls = [];
  const output = createIo();
  try {
    const status = runUpgrade(
      ['upgrade', '--target', layout.targetRoot, '--apply'],
      {
        io: output.io,
        paths: pathsFor(layout.runtimeRoot),
        runner(command, args, options) {
          calls.push({ command, args, options });
          if (command === 'npm' && args[0] === 'prefix') return { status: 0, stdout: `${layout.prefix}\n`, stderr: '' };
          if (command === 'npm' && args[0] === 'view') return { status: 0, stdout: '"2.0.0"\n', stderr: '' };
          if (command === 'npm' && isStagingInstall(args)) {
            stagePackage(options);
            return { status: 0, stdout: '', stderr: '' };
          }
          if (options?.env?.P2A_UPGRADE_APPLY_PREFLIGHT === '1') {
            return { status: 4, stdout: '', stderr: 'target manifest is invalid' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    assert.equal(status, 4);
    assert.match(output.stderr.join('\n'), /project apply preflight failed/);
    assert.equal(calls.some((call) => call.command === 'npm' && isGlobalInstall(call.args)), false);
    assert.equal(JSON.parse(readFileSync(path.join(layout.runtimeRoot, 'package.json'), 'utf8')).version, '1.0.0');
  } finally {
    rmSync(layout.tempRoot, { recursive: true, force: true });
  }
});
