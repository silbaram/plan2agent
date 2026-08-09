#!/usr/bin/env node
/** Coordinate npm-global Plan2Agent upgrades before applying project migrations. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizePath, resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const PACKAGE_REENTRY_ENV = 'P2A_UPGRADE_REENTRY';
const EXPECTED_VERSION_ENV = 'P2A_UPGRADE_EXPECTED_VERSION';
const APPLY_PREFLIGHT_ENV = 'P2A_UPGRADE_APPLY_PREFLIGHT';

function usage() {
  return [
    'Usage:',
    '  p2a upgrade [--target <project-dir>] (--dry-run|--apply) [--tools <list>] [--codex-profile quality|inherit] [--prune]',
    '',
    'Behavior:',
    '  --dry-run  Temporarily stage npm latest and show its project update plan without changing the project or global package.',
    '  --apply    For an npm-global p2a only, preflight and install the exact reviewed version, then update the project.',
    '  --prune    Remove unchanged retired managed files during the project apply phase. Disabled by default.',
  ].join('\n');
}

function parseArgs(argv) {
  const values = argv[0] === 'upgrade' ? argv.slice(1) : [...argv];
  const parsed = {
    apply: false,
    dryRun: false,
    help: false,
    target: null,
    forwarded: ['upgrade'],
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    parsed.forwarded.push(value);
    if (value === '--help' || value === '-h') {
      parsed.help = true;
    } else if (value === '--apply') {
      parsed.apply = true;
    } else if (value === '--dry-run') {
      parsed.dryRun = true;
    } else if (value === '--target') {
      const target = values[++index];
      if (!target) throw new Error('--target requires a path');
      parsed.target = path.resolve(target);
      parsed.forwarded.push(target);
    } else if (value === '--tools' || value === '--codex-profile') {
      const optionValue = values[++index];
      if (!optionValue) throw new Error(`${value} requires a value`);
      parsed.forwarded.push(optionValue);
    } else if (value === '--prune') {
      // Forwarded to the project apply phase.
    } else if (value.startsWith('--')) {
      throw new Error(`unknown option: ${value}`);
    } else {
      throw new Error(`unexpected argument: ${value}`);
    }
  }
  if (parsed.help) return parsed;
  if (!parsed.target) throw new Error('--target is required');
  if (parsed.apply === parsed.dryRun) throw new Error('upgrade requires exactly one of --dry-run or --apply');
  return parsed;
}

function packageMetadata(runtimeRoot) {
  const packagePath = path.join(runtimeRoot, 'package.json');
  try {
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (typeof metadata.name !== 'string' || !metadata.name.trim()) throw new Error('name is missing');
    if (typeof metadata.version !== 'string' || !metadata.version.trim()) throw new Error('version is missing');
    return { name: metadata.name.trim(), version: metadata.version.trim() };
  } catch (error) {
    throw new Error(`could not read package metadata at ${normalizePath(packagePath)}: ${error.message}`);
  }
}

function spawnPortable(runner, command, args, options, platform) {
  return runner(command, args, {
    ...options,
    ...(platform === 'win32' && command === 'npm' ? { shell: true } : {}),
  });
}

function commandFailure(result, label) {
  if (result?.error) return `${label} could not start: ${result.error.message}`;
  if (result?.signal) return `${label} terminated by signal ${result.signal}`;
  const detail = `${result?.stderr ?? ''}`.trim();
  return `${label} failed with exit code ${result?.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`;
}

function runNpmCapture(args, options) {
  const result = spawnPortable(
    options.runner,
    'npm',
    args,
    { cwd: options.cwd, encoding: 'utf8', env: options.env },
    options.platform,
  );
  if (result?.status !== 0) throw new Error(commandFailure(result, `npm ${args.join(' ')}`));
  return `${result.stdout ?? ''}`.trim();
}

function parseNpmScalar(output, label) {
  if (!output) throw new Error(`${label} returned no value`);
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  } catch {
    if (output.trim()) return output.trim();
  }
  throw new Error(`${label} returned an invalid value: ${output}`);
}

function latestPackageVersion(packageName, options) {
  return parseNpmScalar(
    runNpmCapture(['view', `${packageName}@latest`, 'version', '--json'], options),
    `npm latest lookup for ${packageName}`,
  );
}

function globalPrefix(options) {
  const prefix = runNpmCapture(['prefix', '--global'], options);
  if (!prefix) throw new Error('npm prefix --global returned no path');
  return path.resolve(prefix);
}

export function globalPackageRoot(prefix, packageName, platform = process.platform) {
  return platform === 'win32'
    ? path.win32.join(prefix, 'node_modules', packageName)
    : path.posix.join(prefix, 'lib', 'node_modules', packageName);
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function classifyRuntime(paths, prefix, packageName, platform) {
  if (paths.toolkitCheckout) return 'toolkit_checkout';
  if (paths.embedded) return 'project_runtime';
  const installedRoot = globalPackageRoot(prefix, packageName, platform);
  return sameRealPath(paths.runtimeRoot, installedRoot) ? 'npm_global' : 'package_non_global';
}

function printVersionPlan(io, metadata, latestVersion, runtime, projectVersion, mode) {
  io.log(mode === 'dry-run' ? 'Plan2Agent package upgrade dry run' : 'Plan2Agent package upgrade apply');
  io.log(`runtime: ${runtime}`);
  io.log(`runningVersion: ${metadata.version}`);
  io.log(`projectVersion: ${projectVersion ?? 'unknown'}`);
  io.log(`latestVersion: ${latestVersion}`);
  io.log(`package: ${metadata.version === latestVersion ? 'up_to_date' : `would_install ${metadata.name}@${latestVersion}`}`);
}

function projectManifestVersion(targetRoot) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const version = manifest?.provenance?.packageVersion;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function projectPhaseArgs(parsed, mode) {
  return [
    ...parsed.forwarded.filter((value) => value !== '--dry-run' && value !== '--apply'),
    mode === 'dry-run' ? '--dry-run' : '--apply',
  ];
}

function runProjectPhase(runtimeRoot, parsed, options, { applyPreflight = false, mode = parsed.dryRun ? 'dry-run' : 'apply' } = {}) {
  const handoffScript = path.join(runtimeRoot, 'scripts', 'p2a_handoff.mjs');
  if (!existsSync(handoffScript)) {
    options.io.error(`p2a upgrade error: project update runtime is missing: ${normalizePath(handoffScript)}`);
    return 1;
  }
  options.io.log(applyPreflight ? 'projectApplyPreflight:' : mode === 'dry-run' ? 'projectPlan:' : 'projectApply:');
  const childEnv = { ...options.env };
  delete childEnv[APPLY_PREFLIGHT_ENV];
  if (applyPreflight) childEnv[APPLY_PREFLIGHT_ENV] = '1';
  const result = options.runner(
    options.nodeExecutable,
    [handoffScript, ...projectPhaseArgs(parsed, mode)],
    {
      cwd: options.cwd,
      stdio: 'inherit',
      env: childEnv,
    },
  );
  if (result?.status !== 0) {
    const label = applyPreflight ? 'project apply preflight' : `project ${mode} phase`;
    options.io.error(`p2a upgrade error: ${commandFailure(result, label)}`);
    return result?.status ?? 1;
  }
  return 0;
}

function exactPackageSpec(metadata, version) {
  return `${metadata.name}@${version}`;
}

function installExactGlobal(metadata, version, options) {
  const packageSpec = exactPackageSpec(metadata, version);
  const result = spawnPortable(
    options.runner,
    'npm',
    ['install', '--global', packageSpec, '--no-audit', '--no-fund'],
    { cwd: options.cwd, stdio: 'inherit', env: options.env },
    options.platform,
  );
  if (result?.status !== 0) throw new Error(commandFailure(result, `npm install --global ${packageSpec}`));
  options.io.log(`packageInstalled: ${packageSpec}`);
}

function stageExactPackage(metadata, version, options) {
  const stageRoot = mkdtempSync(path.join(tmpdir(), 'p2a-upgrade-stage-'));
  const packageSpec = exactPackageSpec(metadata, version);
  try {
    const result = spawnPortable(
      options.runner,
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', packageSpec],
      { cwd: stageRoot, stdio: 'inherit', env: options.env },
      options.platform,
    );
    if (result?.status !== 0) throw new Error(commandFailure(result, `temporary staging of ${packageSpec}`));
    const runtimeRoot = path.join(stageRoot, 'node_modules', metadata.name);
    const stagedMetadata = packageMetadata(runtimeRoot);
    if (stagedMetadata.name !== metadata.name || stagedMetadata.version !== version) {
      throw new Error(`temporary staging contains ${stagedMetadata.name}@${stagedMetadata.version}, expected ${packageSpec}`);
    }
    if (!existsSync(path.join(runtimeRoot, 'scripts', 'p2a_handoff.mjs'))) {
      throw new Error(`temporary staging is missing the project update runtime for ${packageSpec}`);
    }
    return { runtimeRoot, stageRoot };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupStage(stageRoot, options) {
  if (!stageRoot) return;
  try {
    rmSync(stageRoot, { recursive: true, force: true });
  } catch (error) {
    options.io.error(`p2a upgrade warning: could not remove temporary staging directory ${normalizePath(stageRoot)}: ${error.message}`);
  }
}

function rerunInstalledP2a(parsed, prefix, metadata, latestVersion, options) {
  const installedRoot = globalPackageRoot(prefix, metadata.name, options.platform);
  const installedMetadata = packageMetadata(installedRoot);
  if (installedMetadata.name !== metadata.name || installedMetadata.version !== latestVersion) {
    throw new Error(`npm install completed but ${normalizePath(installedRoot)} contains ${installedMetadata.name}@${installedMetadata.version}, expected ${metadata.name}@${latestVersion}`);
  }
  const installedEntrypoint = path.join(installedRoot, 'scripts', 'p2a.mjs');
  if (!existsSync(installedEntrypoint)) {
    throw new Error(`npm install completed but the new p2a entrypoint is missing: ${normalizePath(installedEntrypoint)}`);
  }
  const result = options.runner(
    options.nodeExecutable,
    [installedEntrypoint, ...parsed.forwarded],
    {
      cwd: options.cwd,
      stdio: 'inherit',
      env: {
        ...options.env,
        [PACKAGE_REENTRY_ENV]: '1',
        [EXPECTED_VERSION_ENV]: latestVersion,
      },
    },
  );
  if (result?.status !== 0) {
    throw new Error(`${commandFailure(result, 'newly installed p2a project update')}; npm package installation succeeded but project application did not`);
  }
}

export function runUpgrade(argv = process.argv.slice(2), overrides = {}) {
  const options = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    io: overrides.io ?? { log: console.log, error: console.error },
    nodeExecutable: overrides.nodeExecutable ?? process.execPath,
    paths: overrides.paths ?? P2A_PATHS,
    platform: overrides.platform ?? process.platform,
    runner: overrides.runner ?? spawnSync,
  };
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      options.io.log(usage());
      return 0;
    }
    const metadata = packageMetadata(options.paths.runtimeRoot);
    const reentry = options.env[PACKAGE_REENTRY_ENV] === '1';
    if (reentry) {
      const expectedVersion = options.env[EXPECTED_VERSION_ENV];
      if (!expectedVersion || metadata.version !== expectedVersion) {
        throw new Error(`new p2a reentry version mismatch: running ${metadata.version}, expected ${expectedVersion ?? 'unknown'}`);
      }
      const prefix = globalPrefix(options);
      const runtime = classifyRuntime(options.paths, prefix, metadata.name, options.platform);
      if (runtime !== 'npm_global') {
        throw new Error(`new p2a reentry requires the npm-global package, got ${runtime}`);
      }
      options.io.log(`Plan2Agent package upgrade reentry: ${metadata.name}@${metadata.version}`);
      return runProjectPhase(options.paths.runtimeRoot, parsed, options);
    }

    let prefix = null;
    let runtime = options.paths.toolkitCheckout
      ? 'toolkit_checkout'
      : options.paths.embedded ? 'project_runtime' : 'package_non_global';
    if (!options.paths.toolkitCheckout && !options.paths.embedded) {
      prefix = globalPrefix(options);
      runtime = classifyRuntime(options.paths, prefix, metadata.name, options.platform);
    }
    if (parsed.apply && runtime !== 'npm_global') {
      options.io.error(`p2a upgrade error: automatic --apply requires an npm-global p2a; current runtime is ${runtime}`);
      options.io.error(`Install explicitly with: npm install --global ${metadata.name}@latest`);
      if (runtime === 'toolkit_checkout' || runtime === 'project_runtime') {
        options.io.error('For a clone or co-located development runtime, use p2a update to refresh project-managed files.');
      }
      return 1;
    }

    const latestVersion = latestPackageVersion(metadata.name, options);
    const projectVersion = projectManifestVersion(parsed.target);
    printVersionPlan(options.io, metadata, latestVersion, runtime, projectVersion, parsed.dryRun ? 'dry-run' : 'apply');
    let stage = null;
    try {
      const previewRuntimeRoot = metadata.version === latestVersion && runtime === 'npm_global'
        ? options.paths.runtimeRoot
        : (stage = stageExactPackage(metadata, latestVersion, options)).runtimeRoot;
      if (parsed.dryRun) return runProjectPhase(previewRuntimeRoot, parsed, options, { mode: 'dry-run' });

      const preflightStatus = runProjectPhase(
        previewRuntimeRoot,
        parsed,
        options,
        { applyPreflight: true, mode: 'dry-run' },
      );
      if (preflightStatus !== 0) return preflightStatus;
    } finally {
      cleanupStage(stage?.stageRoot, options);
    }

    if (metadata.version === latestVersion) {
      return runProjectPhase(options.paths.runtimeRoot, parsed, options, { mode: 'apply' });
    }
    installExactGlobal(metadata, latestVersion, options);
    rerunInstalledP2a(parsed, prefix, metadata, latestVersion, options);
    options.io.log('upgrade complete');
    return 0;
  } catch (error) {
    options.io.error(`p2a upgrade error: ${error.message}`);
    return 1;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) process.exitCode = runUpgrade();
