#!/usr/bin/env node
/**
 * Plan2Agent Claude Code PreToolUse workspace confinement hook.
 *
 * Emits permissionDecision="deny" when Write/Edit escapes the workspace
 * (including via symlinks or dangling symlinks) or when Bash attempts obvious
 * destructive removal of root or home directories. Otherwise exits 0 with no
 * stdout so Claude Code's normal interactive permission rules stay in effect.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
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
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function expandHome(rawPath) {
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function checkDestructiveBash(command) {
  if (typeof command !== 'string' || !command.trim()) return 'missing Bash command';
  const compact = command.replace(/\s+/g, ' ').trim();
  if (/(^|[;&|]\s*)(rm|rmdir)\s+(-[^\s]*[rf][^\s]*\s+)*['"]?(\/(\*|['"]|\s|$)|~(\/|\\|\*|['"]|\s|$)|\$HOME(\/|\\|\*|['"]|\s|$)|\$\{HOME\}(\/|\\|\*|['"]|\s|$))/i.test(compact)) {
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
  const expanded = expandHome(rawPath);
  let resolved;
  try {
    resolved = canonicalizePath(path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded));
  } catch (error) {
    deny(`${toolName} blocked: cannot resolve ${rawPath} (${error.message})`);
  }
  if (!isInsideWorkspace(resolved, workspaceRoot)) {
    deny(`${toolName} blocked: ${rawPath} resolves outside workspace ${workspaceRoot}`);
  }
  process.exit(0);
}

if (toolName === 'Bash') {
  const reason = checkDestructiveBash(toolInput.command);
  if (reason) deny(reason);
  process.exit(0);
}

process.exit(0);
