#!/usr/bin/env node
/** Thin optional Plan2Agent v1 adapter for the local BuildLore CLI. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, readConfig } from './p2a_config.mjs';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const BUILDLORE_READ_TIMEOUT_MS = 15_000;
export const BUILDLORE_READ_MAX_BYTES = 256 * 1024;
export const BUILDLORE_HANDOFF_READ_MAX_BYTES = 2 * 1024 * 1024;

const READ_COMMANDS = new Set([
  'status', 'search', 'memory', 'lookup',
  'handoff-read', 'handoff-verify', 'handoff-list',
]);
const COMMANDS = new Map([
  ['status', { buildLoreArgs: ['knowledge', 'status'], projectRequired: false }],
  ['sync', { buildLoreArgs: ['sync'], projectRequired: true }],
  ['search', { buildLoreArgs: ['search'], projectRequired: true }],
  ['memory', { buildLoreArgs: ['wiki', 'memory'], projectRequired: true }],
  ['lookup', { buildLoreArgs: ['wiki', 'lookup'], projectRequired: true }],
  ['handoff-import', { buildLoreArgs: ['handoff', 'import'], projectRequired: true }],
  ['handoff-read', { buildLoreArgs: ['handoff', 'read'], projectRequired: true }],
  ['handoff-verify', { buildLoreArgs: ['handoff', 'verify'], projectRequired: true }],
  ['handoff-list', { buildLoreArgs: ['handoff', 'list'], projectRequired: true }],
]);

function usage() {
  return [
    'Usage:',
    '  p2a buildlore status [--target <dir>] [--project <id>] [--json]',
    '  p2a buildlore memory --task <text> [--progressive] [--target <dir>] [--project <id>] [--json]',
    '  p2a buildlore lookup --kind evidence|fact --id <sha256> --expect-generation <sha256> [--target <dir>] [--json]',
    '  p2a buildlore search --query <text> [--mode lexical|semantic|hybrid] [--target <dir>] [--json]',
    '  p2a buildlore sync [--dry-run] [--target <dir>] [--json]',
    '  p2a buildlore handoff import --file <bundle.json> [--commit] [--target <dir>] [--json]',
    '  p2a buildlore handoff list|read|verify [options]',
    '',
    'BuildLore is optional. Read failures never block Plan2Agent development.',
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

function parseBuildLoreArgs(argv, defaultTarget) {
  let args = [...argv];
  if (args[0] === 'handoff') {
    if (!args[1] || args[1] === '--help' || args[1] === '-h') return { help: true };
    args = [`handoff-${args[1]}`, ...args.slice(2)];
  }
  const command = args[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown BuildLore command: ${command}`);

  let target = defaultTarget;
  let projectId = null;
  let timeoutMs = BUILDLORE_READ_TIMEOUT_MS;
  const forwarded = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--target' || arg.startsWith('--target=')) {
      target = arg.includes('=') ? arg.slice('--target='.length) : args[++i];
      if (!target) throw new Error('--target requires a directory');
    } else if (arg === '--project' || arg.startsWith('--project=')) {
      projectId = arg.includes('=') ? arg.slice('--project='.length) : args[++i];
      if (!projectId) throw new Error('--project requires a project id');
    } else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      const value = arg.includes('=') ? arg.slice('--timeout-ms='.length) : args[++i];
      if (!READ_COMMANDS.has(command) || !/^\d+$/u.test(value ?? '') || Number(value) < 1 || Number(value) > 60_000) {
        throw new Error('--timeout-ms requires 1..60000 on read commands');
      }
      timeoutMs = Number(value);
    } else {
      forwarded.push(arg);
    }
  }
  if (['handoff-read', 'handoff-verify'].includes(command)) {
    let idVal = '';
    for (let i = 0; i < forwarded.length; i += 1) {
      if (forwarded[i] === '--id') {
        idVal = forwarded[i + 1] ?? '';
        break;
      }
      if (forwarded[i].startsWith('--id=')) {
        idVal = forwarded[i].slice('--id='.length);
        break;
      }
    }
    if (!DIGEST_PATTERN.test(idVal)) {
      throw new Error('handoff read/verify requires --id with a canonical sha256 digest');
    }
  }
  return { help: false, command, target, projectId, forwarded, timeoutMs };
}

export function resolveBuildLoreInvocation(argv, options = {}) {
  const parsed = parseBuildLoreArgs(argv, options.defaultTarget ?? findProjectRoot());
  if (parsed.help) return { help: true, usage: usage() };

  const targetRoot = path.resolve(parsed.target);
  if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
    throw new Error(`--target must point to an existing directory: ${targetRoot}`);
  }

  let config = null;
  try {
    config = readConfig(targetRoot);
  } catch {
    config = null;
  }
  const connection = readJsonObject(path.join(targetRoot, '.buildlore', 'connection.json'));
  const projectId = [parsed.projectId, config?.project_id, connection?.projectId]
    .find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;
  if (projectId !== null && !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`invalid BuildLore project id: ${JSON.stringify(projectId)}`);
  }

  const commandSpec = COMMANDS.get(parsed.command);
  if (commandSpec.projectRequired && !projectId) {
    throw new Error('BuildLore project id is required; pass --project or configure .plan2agent/config.json');
  }

  const env = options.environment ?? process.env;
  const executable = env.BUILDLORE_BIN?.trim() || config?.buildlore?.command?.trim() || 'buildlore';
  const commandArgs = Array.isArray(config?.buildlore?.command_args) ? config.buildlore.command_args : [];
  const buildLoreArgs = connection && parsed.command === 'status'
    ? ['connection', 'status']
    : commandSpec.buildLoreArgs;

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
      ...(projectId ? ['--project', projectId] : []),
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
    stdio: invocation.boundedRead ? ['ignore', 'pipe', 'pipe'] : options.stdio ?? 'inherit',
    ...(invocation.boundedRead ? {
      encoding: 'utf8',
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
      killSignal: 'SIGKILL',
    } : {}),
  });
  if (result?.error) {
    const detail = result.error.code === 'ENOENT'
      ? `BuildLore executable not found: ${invocation.executable}`
      : result.error.message;
    (options.stderr ?? console.error)(`p2a buildlore error: ${detail}`);
    return 1;
  }
  if (invocation.boundedRead) {
    if (result?.stdout) (options.stdout ?? ((v) => process.stdout.write(v)))(result.stdout);
    if (result?.stderr) (options.stderr ?? ((v) => process.stderr.write(v)))(result.stderr);
  }
  return Number.isInteger(result?.status) ? result.status : 1;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runBuildLore(process.argv.slice(2));
}
