#!/usr/bin/env node
/** Thin Plan2Agent adapter for the local BuildLore CLI. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findP2aProjectRoot } from './p2a_paths.mjs';

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const BUILDLORE_READ_TIMEOUT_MS = 15_000;
export const BUILDLORE_READ_MAX_BYTES = 256 * 1024;
export const BUILDLORE_HANDOFF_READ_MAX_BYTES = 2 * 1024 * 1024;
const READ_COMMANDS = new Set(['status', 'search', 'context', 'memory', 'lookup', 'handoff-read', 'handoff-verify', 'handoff-list']);
const WRAPPER_OPTIONS = new Set(['--target', '--project', '--timeout-ms', '--help', '-h']);
const VALUE_OPTIONS = new Set([
  '--query', '--mode', '--prompt', '--question', '--task', '--kind', '--id', '--ids',
  '--max-bytes', '--cursor', '--expect-generation', '--intent', '--file', '--work-id', '--limit',
]);
const MEMORY_OPTIONS = new Set(['--task', '--progressive', '--max-bytes', '--cursor', '--expect-generation', '--json']);
const LOOKUP_OPTIONS = new Set(['--kind', '--id', '--ids', '--expect-generation', '--max-bytes', '--json']);
const HANDOFF_OPTIONS = new Map([
  ['handoff-import', new Set(['--file', '--commit', '--json'])],
  ['handoff-read', new Set(['--id', '--json'])],
  ['handoff-verify', new Set(['--id', '--json'])],
  ['handoff-list', new Set(['--work-id', '--limit', '--json'])],
]);
const COMMANDS = new Map([
  ['status', { buildLoreArgs: ['knowledge', 'status'], projectRequired: false }],
  ['sync', { buildLoreArgs: ['sync'], projectRequired: true }],
  ['check', { buildLoreArgs: ['check'], projectRequired: true }],
  ['search', { buildLoreArgs: ['search'], projectRequired: true }],
  ['context', { buildLoreArgs: ['context'], projectRequired: true }],
  ['memory', { buildLoreArgs: ['wiki', 'memory'], projectRequired: true }],
  ['lookup', { buildLoreArgs: ['wiki', 'lookup'], projectRequired: true }],
  ['handoff-import', { buildLoreArgs: ['handoff', 'import'], projectRequired: true }],
  ['handoff-read', { buildLoreArgs: ['handoff', 'read'], projectRequired: true }],
  ['handoff-verify', { buildLoreArgs: ['handoff', 'verify'], projectRequired: true }],
  ['handoff-list', { buildLoreArgs: ['handoff', 'list'], projectRequired: true }],
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
    '  p2a buildlore memory --task <text> [--progressive] [--max-bytes <bytes>] [--cursor <cursor>] [--expect-generation <digest>] [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore lookup --kind evidence|fact (--id <id> | --ids <id,id>) --expect-generation <digest> [--max-bytes <bytes>] [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore handoff import --file <completion-bundle.json> [--commit] [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore handoff read|verify --id <handoff-digest> [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore handoff list [--work-id <id>] [--limit <1..100>] [--target <project-dir>] [--project <project-id>] [--json]',
    '  p2a buildlore compile [--target <project-dir>] [--project <project-id>] [--review] [--json]',
    '  p2a buildlore query --question <text> [--target <project-dir>] [--project <project-id>] [--json]',
    '',
    'Plan2Agent resolves the project id from --project, project.config.json, manifest.json, or a connected source.',
    'Connected status uses connection status; memory/lookup use the project-scoped Wiki read API.',
    'Read commands have a 15-second timeout (override: --timeout-ms 1..60000) and a 256 KiB output limit.',
    'Handoff read has a 2 MiB output limit. Import writes a preserved source; --commit explicitly commits only that object.',
    'Preservation does not activate Wiki facts, replace the execution baseline, or authorize cleanup.',
    'Unavailable knowledge does not change Plan2Agent task or run state. No read command performs a sync.',
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
  if (argv[0] === 'handoff') {
    if (!argv[1] || ['--help', '-h'].includes(argv[1])) return { help: true };
    argv = [`handoff-${argv[1]}`, ...argv.slice(2)];
  }
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    return { help: true, command: null, target: defaultTarget, projectId: null, forwarded: [] };
  }
  if (!COMMANDS.has(command)) throw new Error(`unknown BuildLore command: ${command}`);

  let target = defaultTarget;
  let projectId = null;
  let help = false;
  let timeoutMs = BUILDLORE_READ_TIMEOUT_MS;
  const forwarded = [];
  const supplied = new Map();
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
    } else if (arg === '--timeout-ms') {
      const value = argv[++index];
      if (!READ_COMMANDS.has(command) || !/^\d+$/u.test(value ?? '') || Number(value) < 1 || Number(value) > 60_000) {
        throw new Error('--timeout-ms requires 1..60000 milliseconds on a read command');
      }
      timeoutMs = Number(value);
    } else {
      const allowed = command === 'memory' ? MEMORY_OPTIONS
        : command === 'lookup' ? LOOKUP_OPTIONS : HANDOFF_OPTIONS.get(command) ?? null;
      if (allowed && !allowed.has(arg)) throw new Error(`unsupported ${command} option: ${arg}`);
      if (allowed && supplied.has(arg)) throw new Error(`duplicate ${command} option: ${arg}`);
      forwarded.push(arg);
      if (VALUE_OPTIONS.has(arg)) {
        const value = argv[++index];
        if (!value || (allowed && (!value.trim() || allowed.has(value) || WRAPPER_OPTIONS.has(value)))) {
          throw new Error(`${arg} requires a value`);
        }
        forwarded.push(value);
        supplied.set(arg, value);
      } else {
        supplied.set(arg, true);
      }
    }
  }
  if (!help && command === 'memory') {
    const task = supplied.get('--task');
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task, 'utf8') > 2048) {
      throw new Error('memory requires --task with 1..2048 UTF-8 bytes');
    }
    if (supplied.has('--cursor') && !supplied.has('--progressive')) {
      throw new Error('memory --cursor requires --progressive');
    }
  }
  if (!help && command === 'lookup') {
    if (!['evidence', 'fact'].includes(supplied.get('--kind')) || !supplied.has('--expect-generation')) {
      throw new Error('lookup requires --kind evidence|fact and --expect-generation');
    }
    if (supplied.has('--id') === supplied.has('--ids')) throw new Error('lookup requires exactly one of --id or --ids');
    if (supplied.has('--max-bytes') && !supplied.has('--ids')) throw new Error('lookup --max-bytes requires --ids');
    const ids = (supplied.get('--ids') ?? supplied.get('--id')).split(',');
    if (ids.length > 16 || ids.some((id) => !DIGEST_PATTERN.test(id)) || (supplied.has('--id') && ids.length !== 1)) {
      throw new Error('lookup requires 1..16 canonical sha256 IDs, not memory aliases');
    }
  }
  if (!help && ['memory', 'lookup'].includes(command) && supplied.has('--expect-generation')) {
    if (!DIGEST_PATTERN.test(supplied.get('--expect-generation'))) throw new Error('--expect-generation requires a canonical sha256 digest');
  }
  if (!help && ['memory', 'lookup'].includes(command) && supplied.has('--max-bytes')) {
    const budget = supplied.get('--max-bytes');
    if (!/^\d+$/u.test(budget) || Number(budget) < 2048 || Number(budget) > 65536) {
      throw new Error('--max-bytes requires 2048..65536 bytes');
    }
  }
  if (!help && command === 'handoff-import' && !supplied.has('--file')) {
    throw new Error('handoff import requires --file');
  }
  if (!help && ['handoff-read', 'handoff-verify'].includes(command) && !DIGEST_PATTERN.test(supplied.get('--id') ?? '')) {
    throw new Error('handoff read/verify requires --id with a canonical sha256 digest');
  }
  if (!help && command === 'handoff-list') {
    const limit = supplied.get('--limit');
    if (limit !== undefined && (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      throw new Error('handoff list --limit requires 1..100');
    }
    const workId = supplied.get('--work-id');
    if (workId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId)) {
      throw new Error('handoff list requires a safe work id');
    }
  }
  return { help, command, target, projectId, forwarded, timeoutMs };
}

function projectConfiguration(targetRoot) {
  const p2aRoot = path.join(targetRoot, '.plan2agent');
  const config = readJsonObject(path.join(p2aRoot, 'project.config.json')) ?? {};
  const manifest = readJsonObject(path.join(p2aRoot, 'manifest.json')) ?? {};
  return { config, manifest };
}

function configuredProjectId(explicitProjectId, config, manifest, connection) {
  const candidates = [explicitProjectId, config?.projectId, manifest?.projectId, connection?.projectId];
  const projectId = candidates.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  if (projectId !== null && !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`invalid BuildLore project id: ${JSON.stringify(projectId)}`);
  }
  if (connection && projectId !== connection.projectId) {
    throw new Error('BuildLore project id does not match the connected source project');
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
  const connectionPath = path.join(targetRoot, '.buildlore', 'connection.json');
  let connection = null;
  if (lstatSync(connectionPath, { throwIfNoEntry: false })) {
    connection = readJsonObject(connectionPath);
    if (!connection || typeof connection.projectId !== 'string' || !PROJECT_ID_PATTERN.test(connection.projectId)) {
      throw new Error('invalid BuildLore connection metadata; repair the connection before reading knowledge');
    }
  }
  const workspacePath = path.join(targetRoot, '.buildlore', 'workspace.json');
  let knowledgeWorkspace = false;
  if (!connection && lstatSync(workspacePath, { throwIfNoEntry: false })) {
    const workspace = readJsonObject(workspacePath);
    if (workspace?.schemaVersion !== 'buildlore.workspace.v1' || workspace?.mode !== 'knowledge') {
      throw new Error('invalid BuildLore knowledge workspace metadata; repair the workspace before reading knowledge');
    }
    knowledgeWorkspace = true;
  }
  const projectId = configuredProjectId(parsed.projectId, config, manifest, connection);
  const commandSpec = COMMANDS.get(parsed.command);
  if (commandSpec.projectRequired && projectId === null) {
    throw new Error('BuildLore project id is required; pass --project or configure .plan2agent/project.config.json projectId');
  }
  const { executable, commandArgs } = configuredExecutable(
    targetRoot,
    config,
    options.environment ?? process.env,
  );
  let buildLoreArgs = commandSpec.buildLoreArgs;
  let forwarded = parsed.forwarded;
  if (connection && parsed.command === 'status') buildLoreArgs = ['connection', 'status'];
  if ((connection || knowledgeWorkspace) && parsed.command === 'context') {
    buildLoreArgs = ['wiki', 'memory'];
    forwarded = forwarded.map((arg, index) => (
      arg === '--prompt' && (index === 0 || !VALUE_OPTIONS.has(forwarded[index - 1])) ? '--task' : arg
    ));
  }
  return {
    help: false,
    targetRoot,
    executable,
    boundedRead: READ_COMMANDS.has(parsed.command),
    maxOutputBytes: parsed.command === 'handoff-read' ? BUILDLORE_HANDOFF_READ_MAX_BYTES : BUILDLORE_READ_MAX_BYTES,
    timeoutMs: parsed.timeoutMs,
    args: [
      ...commandArgs,
      ...buildLoreArgs,
      ...(projectId === null ? [] : ['--project', projectId]),
      ...forwarded,
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
  let result;
  try {
    result = runner(invocation.executable, invocation.args, {
      cwd: invocation.targetRoot,
      env: options.environment ?? process.env,
      stdio: invocation.boundedRead ? ['ignore', 'pipe', 'pipe'] : options.stdio ?? 'inherit',
      ...(invocation.boundedRead ? {
        encoding: 'utf8', timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes, killSignal: 'SIGKILL',
      } : {}),
    });
  } catch (error) {
    (options.stderr ?? console.error)(`p2a buildlore error: ${error.message}`);
    return 1;
  }
  if (result?.error) {
    const detail = result.error.code === 'ENOENT'
      ? `BuildLore executable was not found: ${invocation.executable}. Install or link BuildLore, set BUILDLORE_BIN, or configure buildlore.command.`
      : result.error.code === 'ETIMEDOUT' ? 'Knowledge read exceeded its time budget; continue with current code and the current request.'
        : result.error.code === 'ENOBUFS' ? 'Knowledge read exceeded its output budget; request a smaller result.'
          : result.error.message;
    (options.stderr ?? console.error)(`p2a buildlore error: ${detail}`);
    return 1;
  }
  if (result?.signal) {
    (options.stderr ?? console.error)(`p2a buildlore error: BuildLore terminated by signal ${result.signal}`);
    return 1;
  }
  if (invocation.boundedRead) {
    if (result?.status === 0 && result.stdout) (options.stdout ?? ((value) => process.stdout.write(value)))(result.stdout);
    if (result?.stderr) (options.stderr ?? ((value) => process.stderr.write(value)))(result.stderr);
    else if (result?.status !== 0) (options.stderr ?? console.error)('p2a buildlore error: knowledge read failed; no result was returned.');
  }
  return Number.isInteger(result?.status) ? result.status : 1;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runBuildLore(process.argv.slice(2));
}
