#!/usr/bin/env node
/**
 * Plan2Agent Claude Code PreToolUse workspace confinement hook.
 *
 * Enforces deterministic realpath workspace boundaries for Write/Edit tools
 * and blocks obvious destructive root/home Bash removals. Subprocess filesystem
 * isolation is enforced by the provider's OS sandbox.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function emitDecision(permissionDecision, permissionDecisionReason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  })}\n`);
}

function deny(reason) {
  emitDecision('deny', reason);
  process.exit(0);
}

function allow(reason) {
  emitDecision('allow', reason);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function canonicalizePath(filePath, depth = 0) {
  if (depth > 32) {
    throw new Error(`too many symlink levels resolving ${filePath}`);
  }
  const absolute = path.resolve(filePath);
  const tail = [];
  let current = absolute;
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(current);
        const resolvedTarget = path.resolve(path.dirname(current), linkTarget);
        const targetCanonical = canonicalizePath(resolvedTarget, depth + 1);
        return tail.length ? path.join(targetCanonical, ...tail) : targetCanonical;
      }
      const realBase = realpathSync.native(current);
      return tail.length ? path.join(realBase, ...tail) : realBase;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return tail.length ? path.join(current, ...tail) : current;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function isInsideWorkspace(candidatePath, workspaceRoot) {
  const rel = path.relative(path.normalize(workspaceRoot), path.normalize(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkDestructiveBash(command) {
  if (typeof command !== 'string' || !command.trim()) return 'missing Bash command';
  const compact = command.replace(/\s+/g, ' ').trim();
  if (/(^|[;&|]\s*)(rm|rmdir)\s+(-[^\s]*[rf][^\s]*\s+)*(\/(\s|$)|~(\/|\s|$)|\$HOME(\/|\s|$))/i.test(compact)) {
    return 'Bash command attempts destructive removal of root or home directory';
  }
  return null;
}

const rawInput = await readStdin();
let event;
try {
  event = JSON.parse(rawInput || '{}');
} catch (error) {
  deny(`Plan2Agent hook could not parse stdin JSON: ${error.message}`);
}

const toolName = event.tool_name;
const toolInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
let workspaceRoot;
try {
  workspaceRoot = canonicalizePath(
    typeof event.cwd === 'string' && event.cwd.trim() ? event.cwd : process.cwd(),
  );
} catch (error) {
  deny(`Plan2Agent hook could not resolve workspace root: ${error.message}`);
}

if (toolName === 'Write' || toolName === 'Edit') {
  const rawPath = toolInput.file_path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    deny(`${toolName} is missing tool_input.file_path`);
  }
  const expanded = rawPath.startsWith('~/')
    ? path.join(process.env.HOME || '', rawPath.slice(2))
    : rawPath;
  let resolved;
  try {
    resolved = canonicalizePath(path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded));
  } catch (error) {
    deny(`${toolName} blocked: cannot resolve ${rawPath} (${error.message})`);
  }
  if (!isInsideWorkspace(resolved, workspaceRoot)) {
    deny(`${toolName} blocked: ${rawPath} resolves outside workspace ${workspaceRoot}`);
  }
  allow(`${toolName} target stays inside workspace`);
}

if (toolName === 'Bash') {
  const reason = checkDestructiveBash(toolInput.command);
  if (reason) deny(reason);
  allow('Bash command passed Plan2Agent safety check');
}

process.exit(0);
