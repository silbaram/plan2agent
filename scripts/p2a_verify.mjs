/** Real command verification runner and git worktree fingerprinting for Plan2Agent v1. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_VERIFY_TIMEOUT_MS, P2A_DIR, readConfig } from './p2a_config.mjs';
import { assertApprovedAndCurrent, findTask, nowIso, readWork, writeWork } from './p2a_work.mjs';

const MAX_OUTPUT_TAIL_CHARS = 4000;

function runGit(targetRoot, args) {
  return spawnSync('git', args, {
    cwd: targetRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function normalizeSlashes(p) {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isPlan2AgentPath(relPath, p2aPrefix) {
  const norm = normalizeSlashes(relPath);
  return norm === p2aPrefix || norm.startsWith(`${p2aPrefix}/`);
}

function parsePorcelainZPaths(porcelainZOutput, p2aPrefix) {
  const files = [];
  const tokens = porcelainZOutput.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    // In `git status --porcelain -z`, R/C entries emit `<new>\0<orig>\0`; skip `<orig>`.
    if (xy.includes('R') || xy.includes('C')) {
      i += 1;
    }
    if (filePath && !isPlan2AgentPath(filePath, p2aPrefix)) {
      files.push(normalizeSlashes(filePath));
    }
  }
  return [...new Set(files)].sort();
}

export function inspectGitWorkspace(targetRoot) {
  const root = path.resolve(targetRoot);
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return {
      isGit: false,
      head: null,
      changedFiles: [],
      worktreeFingerprint: null,
    };
  }
  const topRes = runGit(root, ['rev-parse', '--show-toplevel']);
  const gitRoot = topRes.status === 0 && topRes.stdout.trim() ? path.resolve(topRes.stdout.trim()) : root;
  const p2aRelFromGitRoot = normalizeSlashes(path.relative(gitRoot, path.join(root, P2A_DIR)) || P2A_DIR);

  const headRes = runGit(root, ['rev-parse', 'HEAD']);
  const head = headRes.status === 0 ? headRes.stdout.trim() : null;

  const statusRes = runGit(root, [
    '-c', 'core.quotepath=false',
    'status', '--porcelain', '-z', '--untracked-files=all',
    '--', '.', `:(exclude)${P2A_DIR}`,
  ]);
  const statusText = statusRes.status === 0 ? statusRes.stdout : '';
  const changedFiles = parsePorcelainZPaths(statusText, p2aRelFromGitRoot);

  const hash = createHash('sha256');
  hash.update(`head:${head ?? 'unborn'}\n`);
  hash.update(`status:\n${statusText}\n`);
  for (const relPath of changedFiles) {
    const absPath = path.join(gitRoot, relPath);
    if (existsSync(absPath)) {
      try {
        const stat = lstatSync(absPath);
        if (stat.isFile()) {
          hash.update(`file:${relPath}:${stat.size}\n`);
          hash.update(readFileSync(absPath));
        } else if (stat.isSymbolicLink()) {
          hash.update(`symlink:${relPath}\n`);
        }
      } catch {
        hash.update(`unreadable:${relPath}\n`);
      }
    } else {
      hash.update(`deleted:${relPath}\n`);
    }
  }

  return {
    isGit: true,
    head,
    changedFiles,
    worktreeFingerprint: hash.digest('hex'),
  };
}

export function resolveVerifyCommand(config, explicitCmd = null) {
  if (typeof explicitCmd === 'string' && explicitCmd.trim()) {
    return explicitCmd.trim();
  }
  const commands = [
    config?.verify?.test,
    config?.verify?.lint,
    config?.verify?.typecheck,
  ].filter((cmd) => typeof cmd === 'string' && cmd.trim());
  if (!commands.length) {
    throw new Error('no verification command configured in .plan2agent/config.json; pass --cmd "<command>"');
  }
  return commands.join(' && ');
}

function tailText(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (combined.length <= MAX_OUTPUT_TAIL_CHARS) return combined;
  return `...[truncated]\n${combined.slice(-MAX_OUTPUT_TAIL_CHARS)}`;
}

export function runVerification(targetRoot, { taskId = null, cmd = null, timeoutMs = null } = {}) {
  const root = path.resolve(targetRoot);
  const config = readConfig(root);
  const work = readWork(root);
  if (!work) throw new Error('no .plan2agent/work.json found');
  assertApprovedAndCurrent(work);

  const resolvedTaskId = taskId ?? work.resume.active_task_id ?? work.tasks.find((t) => t.status === 'in_progress')?.id;
  if (!resolvedTaskId) {
    throw new Error('no active task specified or in_progress; pass --task <id> or start a task first');
  }
  const task = findTask(work, resolvedTaskId);
  const command = resolveVerifyCommand(config, cmd);
  const effectiveTimeout = timeoutMs ?? config?.verify?.timeout_ms ?? DEFAULT_VERIFY_TIMEOUT_MS;

  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: effectiveTimeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Math.max(0, Date.now() - startedAt);
  const git = inspectGitWorkspace(root);

  const passed = !result.error && !result.signal && result.status === 0;
  const tail = tailText(result.stdout, result.stderr);
  const output = result.error
    ? `${result.error.message}\n${tail}`.trim()
    : result.signal
      ? `Command terminated by signal ${result.signal}\n${tail}`.trim()
      : tail;

  const verification = {
    command,
    status: passed ? 'passed' : 'failed',
    exit_code: Number.isInteger(result.status) ? result.status : null,
    git_head: git.head,
    worktree_fingerprint: git.worktreeFingerprint,
    at: nowIso(),
    duration_ms: durationMs,
    output_tail: output,
  };

  task.verification = verification;
  if (git.isGit) {
    task.changed_files = git.changedFiles;
  }
  if (!passed) {
    work.resume.summary = `Verification failed for ${task.id} (exit ${verification.exit_code ?? 'error'}): ${command}`;
  }
  work.resume.updated_at = verification.at;
  writeWork(root, work);

  return {
    ok: passed,
    taskId: task.id,
    verification,
    changedFiles: task.changed_files,
  };
}
