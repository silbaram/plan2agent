import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ROOT, formatCommandResult, makeTempDir, runP2aFrom } from './helpers/fixtures.mjs';

function spawnPortable(command, args, options) {
  if (process.platform !== 'win32') return spawnSync(command, args, options);
  return spawnSync(command, args, { ...options, shell: true });
}

test('package metadata exposes the p2a global CLI and required runtime assets', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.p2a, 'scripts/p2a.mjs');
  assert.equal(packageJson.engines.node, '>=20');
  assert.ok(packageJson.keywords.includes('spec-driven-development'));
  assert.equal(packageJson.repository.url, 'git+https://github.com/silbaram/plan2agent.git');
  assert.equal(packageJson.homepage, 'https://github.com/silbaram/plan2agent#readme');
  assert.equal(packageJson.bugs.url, 'https://github.com/silbaram/plan2agent/issues');
  for (const requiredPath of ['scripts', 'schemas', '.agents', '.claude', '.codex', '.gemini']) {
    assert.ok(packageJson.files.includes(requiredPath), `${requiredPath} must be packaged`);
  }
  assert.equal(packageJson.files.includes('docs'), false);
  assert.equal(packageJson.files.includes('readme.md'), false);
});

test('checkout init preserves the legacy co-located runtime', () => {
  const targetRoot = makeTempDir('p2a-global-init-');
  try {
    const init = runP2aFrom(targetRoot, ['init', '--tools', 'codex']);
    assert.equal(init.status, 0, formatCommandResult(init));
    assert.match(init.stdout, /init complete/);

    const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.provenance.mode, 'init');
    assert.equal(manifest.provenance.packageName, 'plan2agent');
    assert.equal(manifest.provenance.packageVersion, '0.1.0');
    assert.equal(realpathSync(manifest.provenance.toolkitRoot), realpathSync(ROOT));
    assert.equal('runtime' in manifest, false);
    assert.ok(manifest.scriptFiles.includes('.plan2agent/scripts/p2a.mjs'));
    assert.ok(manifest.schemaFiles.includes('.plan2agent/schemas/next.schema.json'));
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs')), true);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'next.schema.json')), true);
    assert.match(
      readFileSync(path.join(targetRoot, 'PLAN2AGENT.md'), 'utf8'),
      /`node \.plan2agent\/scripts\/p2a\.mjs next`/,
    );
    const legacySkill = readFileSync(
      path.join(targetRoot, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
      'utf8',
    );
    assert.match(legacySkill, /node \.plan2agent\/scripts\/p2a\.mjs tasks ready/);
    assert.doesNotMatch(legacySkill, /(^|[\s`])p2a tasks ready/m);

    const embeddedCli = path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs');
    const runEmbedded = (cwd, args) => spawnSync(
      process.execPath,
      [embeddedCli, ...args],
      { cwd, encoding: 'utf8' },
    );

    const next = runEmbedded(targetRoot, ['next', '--json']);
    assert.equal(next.status, 0, formatCommandResult(next));
    assert.equal(JSON.parse(next.stdout).state, 'initialized_without_artifacts');

    const doctor = runEmbedded(targetRoot, ['doctor', '--json']);
    assert.equal(doctor.status, 0, formatCommandResult(doctor));
    const runtimeChecks = JSON.parse(doctor.stdout).checks
      .filter((item) => ['runtime_scripts', 'runtime_schemas'].includes(item.id));
    assert.deepEqual(runtimeChecks.map((item) => item.status), ['pass', 'pass']);

    rmSync(path.join(targetRoot, '.plan2agent', 'style.md'));
    const updatePreview = runEmbedded(targetRoot, ['update', '--dry-run']);
    assert.equal(updatePreview.status, 0, formatCommandResult(updatePreview));
    assert.match(updatePreview.stdout, /missing: generate \(generated\) -> \.plan2agent\/style\.md/);
    assert.match(
      updatePreview.stdout,
      /Apply safe updates with: node \.plan2agent\/scripts\/p2a\.mjs update --target .+ --apply/,
    );

    const update = runEmbedded(targetRoot, ['update', '--apply']);
    assert.equal(update.status, 0, formatCommandResult(update));
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'style.md')), true);
    const updatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updatedManifest.provenance.mode, 'init');
    assert.equal(realpathSync(updatedManifest.provenance.toolkitRoot), realpathSync(ROOT));
    assert.equal('runtime' in updatedManifest, false);
    assert.ok(updatedManifest.scriptFiles.includes('.plan2agent/scripts/p2a.mjs'));
    assert.ok(updatedManifest.schemaFiles.includes('.plan2agent/schemas/next.schema.json'));

    const standaloneGraph = path.join(targetRoot, 'task-graph.json');
    copyFileSync(
      path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service', 'gate-c-task-graph', 'task-graph.json'),
      standaloneGraph,
    );
    const executePlan = runEmbedded(targetRoot, [
      'execute', 'plan',
      '--graph', standaloneGraph,
      '--task', 'task-001',
      '--run-id', 'run-legacy-command-review',
    ]);
    assert.equal(executePlan.status, 0, formatCommandResult(executePlan));
    assert.match(
      executePlan.stdout,
      /node \.plan2agent\/scripts\/p2a\.mjs execute start/,
    );
    assert.doesNotMatch(executePlan.stdout, /- p2a execute start/);

    const nestedRoot = path.join(targetRoot, 'src', 'nested');
    mkdirSync(nestedRoot, { recursive: true });
    const nestedInfo = runEmbedded(nestedRoot, ['info', '--json']);
    assert.equal(nestedInfo.status, 0, formatCommandResult(nestedInfo));
    const nestedInfoPayload = JSON.parse(nestedInfo.stdout);
    assert.equal(nestedInfoPayload.surface, 'project_runtime');
    assert.equal(realpathSync(nestedInfoPayload.target), realpathSync(targetRoot));
    assert.equal(nestedInfoPayload.mode, 'init');

    const nestedNext = runEmbedded(nestedRoot, ['next', '--json']);
    assert.equal(nestedNext.status, 0, formatCommandResult(nestedNext));
    assert.equal(JSON.parse(nestedNext.stdout).state, 'initialized_without_artifacts');

    const embeddedArtifactRoot = path.join(
      targetRoot,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
    );
    cpSync(
      path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service'),
      embeddedArtifactRoot,
      { recursive: true },
    );
    const embeddedNext = runEmbedded(targetRoot, ['next', '--json']);
    assert.equal(embeddedNext.status, 0, formatCommandResult(embeddedNext));
    const embeddedNextPayload = JSON.parse(embeddedNext.stdout);
    assert.equal(embeddedNextPayload.state, 'gate_d_passed_needs_iteration_init');
    assert.match(
      embeddedNextPayload.command.display,
      /^node \.plan2agent\/scripts\/p2a\.mjs iteration init /,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('checkout scaffold preserves the legacy co-located runtime', () => {
  const targetRoot = makeTempDir('p2a-checkout-scaffold-');
  try {
    const scaffold = runP2aFrom(targetRoot, ['scaffold', '--tools', 'none']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));

    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.equal(manifest.provenance.mode, 'scaffold');
    assert.equal(manifest.provenance.packageName, 'plan2agent');
    assert.equal(manifest.provenance.packageVersion, '0.1.0');
    assert.equal(realpathSync(manifest.provenance.toolkitRoot), realpathSync(ROOT));
    assert.equal('runtime' in manifest, false);
    assert.ok(manifest.scriptFiles.includes('.plan2agent/scripts/p2a.mjs'));
    assert.ok(manifest.schemaFiles.includes('.plan2agent/schemas/next.schema.json'));
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs')), true);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'next.schema.json')), true);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('checkout handoff preserves the legacy co-located runtime and commands', () => {
  const targetRoot = makeTempDir('p2a-checkout-handoff-');
  try {
    const handoff = runP2aFrom(ROOT, [
      'handoff',
      '--project-id', 'webhook-api-service',
      '--artifacts', path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service'),
      '--target', targetRoot,
      '--tools', 'codex',
    ]);
    assert.equal(handoff.status, 0, formatCommandResult(handoff));

    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.equal(manifest.provenance.mode, 'handoff');
    assert.equal(realpathSync(manifest.provenance.toolkitRoot), realpathSync(ROOT));
    assert.equal('runtime' in manifest, false);
    assert.ok(manifest.scriptFiles.includes('.plan2agent/scripts/p2a.mjs'));
    assert.ok(manifest.schemaFiles.includes('.plan2agent/schemas/next.schema.json'));

    const legacySkill = readFileSync(
      path.join(targetRoot, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
      'utf8',
    );
    assert.match(legacySkill, /node \.plan2agent\/scripts\/p2a\.mjs execute start/);
    assert.doesNotMatch(legacySkill, /(^|[\s`])p2a execute start/m);

    const nestedRoot = path.join(targetRoot, 'src', 'nested');
    mkdirSync(nestedRoot, { recursive: true });
    const embeddedCli = path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs');
    const ready = spawnSync(process.execPath, [embeddedCli, 'tasks', 'ready'], {
      cwd: nestedRoot,
      encoding: 'utf8',
    });
    assert.equal(ready.status, 0, formatCommandResult(ready));
    assert.match(ready.stdout, /task-001/);

    const executePlan = spawnSync(process.execPath, [
      embeddedCli,
      'execute', 'plan',
      '--task', 'task-001',
      '--run-id', 'run-checkout-handoff-review',
    ], {
      cwd: nestedRoot,
      encoding: 'utf8',
    });
    assert.equal(executePlan.status, 0, formatCommandResult(executePlan));
    assert.match(executePlan.stdout, /node \.plan2agent\/scripts\/p2a\.mjs execute start/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('package CLI help keeps scaffold hidden and uses installed command names', () => {
  const initHelp = runP2aFrom(ROOT, ['init', '--help']);
  assert.equal(initHelp.status, 0, formatCommandResult(initHelp));
  assert.doesNotMatch(initHelp.stdout, /\bscaffold\b/);

  const doctorHelp = runP2aFrom(ROOT, ['doctor', '--help']);
  assert.equal(doctorHelp.status, 0, formatCommandResult(doctorHelp));
  assert.match(doctorHelp.stdout, /p2a doctor/);
  assert.doesNotMatch(doctorHelp.stdout, /node scripts\/p2a_doctor\.mjs/);
});

test('npm pack dry run includes the global CLI runtime', () => {
  const cacheRoot = makeTempDir('p2a-npm-cache-');
  try {
    const packed = spawnPortable('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cacheRoot },
    });
    assert.equal(packed.status, 0, formatCommandResult(packed));
    const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
    for (const requiredPath of ['package.json', 'scripts/p2a.mjs', 'scripts/p2a_handoff.mjs', 'schemas/next.schema.json', '.agents/skills/p2a-next/SKILL.md']) {
      assert.ok(files.has(requiredPath), `${requiredPath} must be present in npm pack output`);
    }
    assert.ok(files.has('readme.md'), 'npm must include the project readme automatically');
    assert.equal([...files].some((file) => file.startsWith('docs/')), false);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('the packed p2a binary supports core commands without a local runtime copy', () => {
  const tempRoot = makeTempDir('p2a-packed-bin-');
  const cacheRoot = path.join(tempRoot, 'npm-cache');
  const packRoot = path.join(tempRoot, 'pack');
  const installRoot = path.join(tempRoot, 'install');
  const targetRoot = path.join(tempRoot, 'target');
  try {
    mkdirSync(packRoot, { recursive: true });
    mkdirSync(targetRoot, { recursive: true });
    const npmEnv = { ...process.env, npm_config_cache: cacheRoot };
    const packed = spawnPortable('npm', ['pack', '--json', '--pack-destination', packRoot], {
      cwd: ROOT,
      encoding: 'utf8',
      env: npmEnv,
    });
    assert.equal(packed.status, 0, formatCommandResult(packed));
    const tarballPath = path.join(packRoot, JSON.parse(packed.stdout)[0].filename);

    const installed = spawnPortable('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, tarballPath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: npmEnv,
    });
    assert.equal(installed.status, 0, formatCommandResult(installed));

    const binary = path.join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'p2a.cmd' : 'p2a');
    const runPacked = (cwd, args) => {
      const options = {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, P2A_MEMORY_URL: '', P2A_MEMORY_TOKEN: '' },
      };
      return spawnPortable(binary, args, options);
    };
    const initialized = runPacked(targetRoot, ['init', '--tools', 'codex']);
    assert.equal(initialized.status, 0, formatCommandResult(initialized));
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'scripts')), false);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'schemas')), false);
    assert.match(readFileSync(path.join(targetRoot, 'PLAN2AGENT.md'), 'utf8'), /`p2a next`/);
    const packageSkill = readFileSync(
      path.join(targetRoot, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
      'utf8',
    );
    assert.match(packageSkill, /(^|[\s`])p2a tasks ready/m);
    assert.doesNotMatch(packageSkill, /node \.plan2agent\/scripts\/p2a\.mjs tasks ready/);
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.equal(manifest.provenance.packageName, 'plan2agent');
    assert.equal(manifest.provenance.packageVersion, '0.1.0');

    const nestedRoot = path.join(targetRoot, 'src', 'nested');
    mkdirSync(nestedRoot, { recursive: true });
    const nestedInfo = runPacked(nestedRoot, ['info', '--json']);
    assert.equal(nestedInfo.status, 0, formatCommandResult(nestedInfo));
    const nestedInfoPayload = JSON.parse(nestedInfo.stdout);
    assert.equal(realpathSync(nestedInfoPayload.target), realpathSync(targetRoot));
    assert.equal(nestedInfoPayload.surface, 'package_runtime');
    assert.equal(nestedInfoPayload.mode, 'init');

    mkdirSync(path.join(targetRoot, '.plan2agent', 'runs'), { recursive: true });
    const nestedMemoryDigest = runPacked(nestedRoot, ['memory', 'digest', '--json']);
    assert.equal(nestedMemoryDigest.status, 0, formatCommandResult(nestedMemoryDigest));
    assert.equal(JSON.parse(nestedMemoryDigest.stdout).schema_version, 'p2a.memory_digest.v1');

    const nestedRunList = runPacked(nestedRoot, ['runs', 'list', '--json']);
    assert.equal(nestedRunList.status, 0, formatCommandResult(nestedRunList));
    assert.equal(JSON.parse(nestedRunList.stdout).schema_version, 'p2a.run_index.v1');

    const nestedEvalAnalyze = runPacked(nestedRoot, ['eval', 'analyze', '--json']);
    assert.equal(nestedEvalAnalyze.status, 0, formatCommandResult(nestedEvalAnalyze));
    assert.equal(JSON.parse(nestedEvalAnalyze.stdout).schema_version, 'p2a.eval_analysis.v1');

    const nestedProposalMine = runPacked(nestedRoot, ['proposals', 'mine', '--dry-run', '--json']);
    assert.equal(nestedProposalMine.status, 0, formatCommandResult(nestedProposalMine));
    assert.equal(
      realpathSync(JSON.parse(nestedProposalMine.stdout).runsDir),
      realpathSync(path.join(targetRoot, '.plan2agent', 'runs')),
    );

    const aliasTargetRoot = path.join(tempRoot, 'scaffold-alias-target');
    mkdirSync(aliasTargetRoot, { recursive: true });
    const scaffoldAlias = runPacked(aliasTargetRoot, ['scaffold', '--tools', 'none']);
    assert.equal(scaffoldAlias.status, 0, formatCommandResult(scaffoldAlias));
    assert.equal(existsSync(path.join(aliasTargetRoot, '.plan2agent', 'scripts')), false);
    assert.equal(existsSync(path.join(aliasTargetRoot, '.plan2agent', 'schemas')), false);
    const aliasManifest = JSON.parse(readFileSync(path.join(aliasTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.deepEqual(aliasManifest.runtime, { mode: 'package', command: 'p2a' });

    const handoffTargetRoot = path.join(tempRoot, 'handoff-target');
    const handoff = runPacked(ROOT, [
      'handoff',
      '--project-id', 'webhook-api-service',
      '--artifacts', path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service'),
      '--target', handoffTargetRoot,
      '--include-intake',
    ]);
    assert.equal(handoff.status, 0, formatCommandResult(handoff));
    assert.equal(existsSync(path.join(handoffTargetRoot, '.plan2agent', 'scripts')), false);
    assert.equal(existsSync(path.join(handoffTargetRoot, '.plan2agent', 'schemas')), false);
    const handoffManifest = JSON.parse(
      readFileSync(path.join(handoffTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'),
    );
    assert.deepEqual(handoffManifest.runtime, { mode: 'package', command: 'p2a' });

    const handoffConfigPath = path.join(handoffTargetRoot, '.plan2agent', 'project.config.json');
    const handoffConfig = JSON.parse(readFileSync(handoffConfigPath, 'utf8'));
    handoffConfig.runTracking.defaultIsolation = 'branch';
    handoffConfig.runTracking.branchPattern = 'review/<taskId>-<runId>';
    writeFileSync(handoffConfigPath, `${JSON.stringify(handoffConfig, null, 2)}\n`, 'utf8');

    const handoffNestedRoot = path.join(handoffTargetRoot, 'src', 'nested');
    mkdirSync(handoffNestedRoot, { recursive: true });

    const readyTasks = runPacked(handoffNestedRoot, ['tasks', 'ready']);
    assert.equal(readyTasks.status, 0, formatCommandResult(readyTasks));
    assert.match(readyTasks.stdout, /task-001/);

    const executePlan = runPacked(handoffNestedRoot, [
      'execute', 'plan',
      '--task', 'task-001',
      '--run-id', 'run-packed-command-review',
    ]);
    assert.equal(executePlan.status, 0, formatCommandResult(executePlan));
    assert.match(executePlan.stdout, /p2a execute start/);
    assert.doesNotMatch(executePlan.stdout, /node \.plan2agent\/scripts\/p2a\.mjs/);
    assert.match(executePlan.stdout, /- isolation: branch/);
    assert.match(executePlan.stdout, /- branch: review\/task-001-run-packed-command-review/);

    const memoryDigest = runPacked(handoffNestedRoot, ['memory', 'digest', '--json']);
    assert.equal(memoryDigest.status, 0, formatCommandResult(memoryDigest));
    assert.equal(JSON.parse(memoryDigest.stdout).schema_version, 'p2a.memory_digest.v1');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
