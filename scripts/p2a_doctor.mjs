#!/usr/bin/env node
/** Diagnose a scaffolded Plan2Agent project from the toolkit checkout. */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_RUNTIME_SCHEMA_FILES,
  PROJECT_RUNTIME_SCRIPT_FILES,
  REPO_ONLY_SCRIPT_FILES,
} from './p2a_tool_manifest.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_doctor.mjs [--target <project-dir>] [--json] [--strict]',
    '',
    'Options:',
    '  --target <dir>  Project directory to inspect. Default: current working directory.',
    '  --json          Print machine-readable JSON.',
    '  --strict        Exit non-zero when warnings are present.',
    '  --help, -h      Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    target: process.cwd(),
    json: false,
    strict: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonObject(filePath) {
  try {
    if (!isFile(filePath)) return { ok: false, data: null, error: 'file is missing' };
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, data: null, error: 'JSON root must be an object' };
    }
    return { ok: true, data, error: null };
  } catch (error) {
    return { ok: false, data: null, error: error.message };
  }
}

function check(id, label, status, detail, fields = {}) {
  return { id, label, status, detail, ...fields };
}

function listedInManifest(manifest, relativePath, keys) {
  if (!manifest) return null;
  const normalized = normalizePath(relativePath);
  const availableKeys = keys.filter((key) => Array.isArray(manifest[key]));
  if (!availableKeys.length) return null;
  return availableKeys.some((key) => manifest[key]
    .filter((value) => typeof value === 'string')
    .map(normalizePath)
    .includes(normalized));
}

function manifestListingCheck(id, label, manifest, relativePaths, keys) {
  if (!manifest) {
    return check(id, label, 'warn', 'manifest is unavailable; listing consistency was not checked');
  }
  const availableKeys = keys.filter((key) => Array.isArray(manifest[key]));
  if (!availableKeys.length) {
    return check(id, label, 'warn', `manifest does not expose ${keys.join(' or ')}`);
  }
  const missing = relativePaths.filter((relativePath) => !listedInManifest(manifest, relativePath, availableKeys));
  if (missing.length) {
    return check(id, label, 'warn', `manifest listing is missing ${missing.length} expected file(s)`, { missing });
  }
  return check(id, label, 'pass', `manifest lists ${relativePaths.length} expected file(s)`);
}

function diagnose(targetRootInput) {
  const targetRoot = path.resolve(targetRootInput);
  const checks = [];

  checks.push(
    isDirectory(targetRoot)
      ? check('target_directory', 'Target directory', 'pass', 'target directory exists', { path: targetRoot })
      : check('target_directory', 'Target directory', 'fail', 'target directory is missing or is not a directory', { path: targetRoot }),
  );

  const p2aDir = path.join(targetRoot, '.plan2agent');
  checks.push(
    isDirectory(p2aDir)
      ? check('p2a_directory', 'P2A directory', 'pass', '.plan2agent directory exists', { path: '.plan2agent' })
      : check('p2a_directory', 'P2A directory', 'fail', '.plan2agent directory is missing', { path: '.plan2agent' }),
  );

  const manifestPath = path.join(p2aDir, 'manifest.json');
  const manifestResult = readJsonObject(manifestPath);
  const manifest = manifestResult.ok ? manifestResult.data : null;
  checks.push(
    manifestResult.ok
      ? check('manifest', 'Install manifest', 'pass', 'manifest.json is readable JSON', { path: '.plan2agent/manifest.json' })
      : check('manifest', 'Install manifest', 'fail', `manifest.json is not readable: ${manifestResult.error}`, { path: '.plan2agent/manifest.json' }),
  );

  const configPath = path.join(p2aDir, 'project.config.json');
  const configResult = readJsonObject(configPath);
  checks.push(
    configResult.ok
      ? check('project_config', 'Project config', 'pass', 'project.config.json is readable JSON', { path: '.plan2agent/project.config.json' })
      : check('project_config', 'Project config', 'fail', `project.config.json is not readable: ${configResult.error}`, { path: '.plan2agent/project.config.json' }),
  );

  const runtimeScriptPaths = PROJECT_RUNTIME_SCRIPT_FILES.map((file) => `.plan2agent/scripts/${file}`);
  const missingRuntimeScripts = runtimeScriptPaths.filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingRuntimeScripts.length
      ? check('runtime_scripts', 'Runtime scripts', 'fail', `${missingRuntimeScripts.length} runtime script(s) are missing`, { missing: missingRuntimeScripts })
      : check('runtime_scripts', 'Runtime scripts', 'pass', `${runtimeScriptPaths.length} runtime scripts are present`),
  );

  const runtimeSchemaPaths = PROJECT_RUNTIME_SCHEMA_FILES.map((file) => `.plan2agent/schemas/${file}`);
  const missingRuntimeSchemas = runtimeSchemaPaths.filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingRuntimeSchemas.length
      ? check('runtime_schemas', 'Runtime schemas', 'fail', `${missingRuntimeSchemas.length} runtime schema file(s) are missing`, { missing: missingRuntimeSchemas })
      : check('runtime_schemas', 'Runtime schemas', 'pass', `${runtimeSchemaPaths.length} runtime schemas are present`),
  );

  const misplacedRepoOnlyScripts = REPO_ONLY_SCRIPT_FILES
    .map((file) => `.plan2agent/scripts/${file}`)
    .filter((relativePath) => isFile(path.join(targetRoot, relativePath)));
  checks.push(
    misplacedRepoOnlyScripts.length
      ? check('repo_only_scripts_absent', 'Repo-only scripts', 'warn', `${misplacedRepoOnlyScripts.length} repo-only script(s) are installed in .plan2agent/scripts`, { unexpected: misplacedRepoOnlyScripts })
      : check('repo_only_scripts_absent', 'Repo-only scripts', 'pass', 'repo-only scripts are not installed in .plan2agent/scripts'),
  );

  checks.push(manifestListingCheck('manifest_runtime_scripts', 'Manifest runtime scripts', manifest, runtimeScriptPaths, ['scriptFiles', 'toolFiles']));
  checks.push(manifestListingCheck('manifest_runtime_schemas', 'Manifest runtime schemas', manifest, runtimeSchemaPaths, ['schemaFiles']));

  const config = configResult.ok ? configResult.data : null;
  const verificationKeys = ['testCommand', 'lintCommand', 'typecheckCommand'];
  const configuredVerification = verificationKeys.filter((key) => typeof config?.[key] === 'string' && config[key].trim().length > 0);
  checks.push(
    configuredVerification.length
      ? check('verification_commands', 'Verification commands', 'pass', `configured: ${configuredVerification.join(', ')}`)
      : check('verification_commands', 'Verification commands', 'warn', 'no test/lint/typecheck command is configured'),
  );

  const failures = checks.filter((item) => item.status === 'fail').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  const passed = checks.filter((item) => item.status === 'pass').length;
  const status = failures ? 'fail' : warnings ? 'warn' : 'pass';
  return {
    schema_version: 'p2a.doctor.v1',
    target: targetRoot,
    status,
    summary: { passed, warnings, failures },
    checks,
    nextActions: nextActions(status, checks),
  };
}

function nextActions(status, checks) {
  if (status === 'pass') return [];
  const actions = [];
  if (checks.some((item) => item.id === 'runtime_scripts' && item.status === 'fail')
    || checks.some((item) => item.id === 'runtime_schemas' && item.status === 'fail')) {
    actions.push('Run scaffold or upgrade from the Plan2Agent toolkit checkout to restore missing runtime files.');
  }
  if (checks.some((item) => item.id === 'repo_only_scripts_absent' && item.status === 'warn')) {
    actions.push('Remove repo-only scripts from .plan2agent/scripts or regenerate the project harness.');
  }
  if (checks.some((item) => item.id === 'verification_commands' && item.status === 'warn')) {
    actions.push('Review .plan2agent/project.config.json and add test/lint/typecheck commands when available.');
  }
  if (!actions.length) actions.push('Review failed or warning checks above.');
  return actions;
}

function printHuman(report) {
  console.log(`Plan2Agent doctor: ${report.status}`);
  console.log(`target: ${report.target}`);
  console.log(`summary: ${report.summary.passed} passed, ${report.summary.warnings} warning(s), ${report.summary.failures} failure(s)`);
  for (const item of report.checks) {
    const prefix = item.status === 'pass' ? 'PASS' : item.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`- ${prefix} ${item.label}: ${item.detail}`);
    if (Array.isArray(item.missing) && item.missing.length) {
      for (const missing of item.missing) console.log(`  missing: ${missing}`);
    }
    if (Array.isArray(item.unexpected) && item.unexpected.length) {
      for (const unexpected of item.unexpected) console.log(`  unexpected: ${unexpected}`);
    }
  }
  if (report.nextActions.length) {
    console.log('next actions:');
    for (const action of report.nextActions) console.log(`- ${action}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const report = diagnose(args.target);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
    if (report.summary.failures > 0) return 1;
    if (args.strict && report.summary.warnings > 0) return 1;
    return 0;
  } catch (error) {
    console.error(`p2a_doctor failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
