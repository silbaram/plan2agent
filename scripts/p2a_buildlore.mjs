#!/usr/bin/env node
/** Thin Plan2Agent adapter for the local BuildLore CLI. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findP2aProjectRoot } from './p2a_paths.mjs';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const COMMANDS = new Map([
  ['status', { buildLoreArgs: ['knowledge', 'status'], projectRequired: false }],
  ['sync', { buildLoreArgs: ['sync'], projectRequired: true }],
  ['check', { buildLoreArgs: ['check'], projectRequired: true }],
  ['search', { buildLoreArgs: ['search'], projectRequired: true }],
  ['context', { buildLoreArgs: ['context'], projectRequired: true }],
  ['compile', { buildLoreArgs: ['compile'], projectRequired: true }],
  ['query', { buildLoreArgs: ['query'], projectRequired: true }],
]);

function usage() {
  return [
    'Usage:',
    '  p2a buildlore status [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore sync [--target <project-dir>] [--project <project-id>] [--dry-run] [--json]',
    '  p2a buildlore check [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore search --query <text> [--target <project-dir>] [--project <project-id>] [--mode lexical|semantic|hybrid] [--json]',
    '  p2a buildlore context --prompt <text> [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore compile [--target <project-dir>] [--project <project-id>] [--review] [--json]',
    '  p2a buildlore query --question <text> [--target <project-dir>] [--project <project-id>] [--json]',
    '',
    'Plan2Agent resolves the project id from --project, project.config.json, or manifest.json.',
    'BuildLore runs locally from the project root and reads .plan2agent/artifacts/<project-id>/.',
    'Knowledge writes and publication remain explicit BuildLore operations.',
  ].join('\n');
}

function readJsonObject(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseArgs(argv, defaultTarget = findP2aProjectRoot()) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    return { help: true, command: null, target: defaultTarget, projectId: null, forwarded: [] };
  }
  if (!COMMANDS.has(command)) throw new Error(`unknown BuildLore command: ${command}`);

  let target = defaultTarget;
  let projectId = null;
  let help = false;
  const forwarded = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--target') {
      target = argv[++index];
      if (!target) throw new Error('--target requires a project directory');
    } else if (arg === '--project') {
      projectId = argv[++index];
      if (!projectId) throw new Error('--project requires a project id');
    } else {
      forwarded.push(arg);
      if (['--query', '--mode', '--prompt', '--question'].includes(arg)) {
        const value = argv[++index];
        if (!value) throw new Error(`${arg} requires a value`);
        forwarded.push(value);
      }
    }
  }
  return { help, command, target, projectId, forwarded };
}

function projectConfiguration(targetRoot) {
  const p2aRoot = path.join(targetRoot, '.plan2agent');
  const config = readJsonObject(path.join(p2aRoot, 'project.config.json')) ?? {};
  const manifest = readJsonObject(path.join(p2aRoot, 'manifest.json')) ?? {};
  return { config, manifest };
}

function configuredProjectId(explicitProjectId, config, manifest) {
  const candidates = [explicitProjectId, config?.projectId, manifest?.projectId];
  const projectId = candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  if (projectId !== null && !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`invalid BuildLore project id: ${JSON.stringify(projectId)}`);
  }
  return projectId;
}

function configuredExecutable(targetRoot, config, environment) {
  const buildLore = config?.buildlore && typeof config.buildlore === 'object' && !Array.isArray(config.buildlore)
    ? config.buildlore
    : {};
  const commandEnv = typeof buildLore.commandEnv === 'string' && buildLore.commandEnv.trim()
    ? buildLore.commandEnv.trim()
    : 'BUILDLORE_BIN';
  const environmentCommand = typeof environment[commandEnv] === 'string' && environment[commandEnv].trim()
    ? environment[commandEnv].trim()
    : null;
  const configuredCommand = typeof buildLore.command === 'string' && buildLore.command.trim()
    ? buildLore.command.trim()
    : 'buildlore';
  const command = environmentCommand ?? configuredCommand;
  const executable = command.includes('/') && !path.isAbsolute(command)
    ? path.resolve(targetRoot, command)
    : command;
  const commandArgs = Array.isArray(buildLore.commandArgs)
    ? buildLore.commandArgs.map((value) => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('buildlore.commandArgs must contain only non-empty strings');
      }
      return value;
    })
    : [];
  return { executable, commandArgs };
}

export function resolveBuildLoreInvocation(argv, options = {}) {
  const parsed = parseArgs(argv, options.defaultTarget ?? findP2aProjectRoot());
  if (parsed.help) return { help: true, usage: usage() };
  const targetRoot = path.resolve(parsed.target);
  if (!existsSync(targetRoot) || !lstatSync(targetRoot).isDirectory()) {
    throw new Error(`--target must point to an existing project directory: ${targetRoot}`);
  }
  const { config, manifest } = projectConfiguration(targetRoot);
  const projectId = configuredProjectId(parsed.projectId, config, manifest);
  const commandSpec = COMMANDS.get(parsed.command);
  if (commandSpec.projectRequired && projectId === null) {
    throw new Error('BuildLore project id is required; pass --project or configure .plan2agent/project.config.json projectId');
  }
  const { executable, commandArgs } = configuredExecutable(
    targetRoot,
    config,
    options.environment ?? process.env,
  );
  return {
    help: false,
    targetRoot,
    executable,
    args: [
      ...commandArgs,
      ...commandSpec.buildLoreArgs,
      ...(projectId === null ? [] : ['--project', projectId]),
      ...parsed.forwarded,
    ],
  };
}

export function runBuildLore(argv, options = {}) {
  let invocation;
  try {
    invocation = resolveBuildLoreInvocation(argv, options);
  } catch (error) {
    (options.stderr ?? console.error)(`p2a buildlore error: ${error.message}`);
    (options.stderr ?? console.error)('Run p2a buildlore --help for usage.');
    return 1;
  }
  if (invocation.help) {
    (options.stdout ?? console.log)(invocation.usage);
    return 0;
  }
  const runner = options.runner ?? spawnSync;
  const result = runner(invocation.executable, invocation.args, {
    cwd: invocation.targetRoot,
    env: options.environment ?? process.env,
    stdio: options.stdio ?? 'inherit',
  });
  if (result?.error) {
    const detail = result.error.code === 'ENOENT'
      ? `BuildLore executable was not found: ${invocation.executable}. Install or link BuildLore, set BUILDLORE_BIN, or configure buildlore.command.`
      : result.error.message;
    (options.stderr ?? console.error)(`p2a buildlore error: ${detail}`);
    return 1;
  }
  if (result?.signal) {
    (options.stderr ?? console.error)(`p2a buildlore error: BuildLore terminated by signal ${result.signal}`);
    return 1;
  }
  return result?.status ?? 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runBuildLore(process.argv.slice(2));
}
