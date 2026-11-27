import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncCliAssets } from '../scripts/sync_cli_assets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'p2a-confine-workspace.mjs');

function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`);
  return JSON.parse(res.stdout).hookSpecificOutput;
}

test('CLI provider mirrors are in sync and parity passes', () => {
  const sync = syncCliAssets({ check: true });
  assert.equal(sync.ok, true, `out of sync mirrors: ${sync.drifted.join(', ')}`);

  const parity = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'check_cli_parity.mjs')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(parity.status, 0, parity.stderr || parity.stdout);

  const geminiImpl = readFileSync(path.join(REPO_ROOT, '.gemini', 'agents', 'p2a-implementer.md'), 'utf8');
  assert.match(geminiImpl, /- write_file/);
  assert.match(geminiImpl, /- replace/);
  assert.match(geminiImpl, /- run_shell_command/);
});

test('package.json has zero runtime dependencies and npm pack ships only runtime files', (t) => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const depCount = Object.keys(pkg.dependencies ?? {}).length;
  assert.equal(depCount, 0, 'v1.0 minimal harness must have zero external npm dependencies');
  assert.equal(pkg.bin?.p2a, 'scripts/p2a.mjs');

  const npmCache = mkdtempSync(path.join(os.tmpdir(), 'p2a-npm-cache-'));
  t.after(() => rmSync(npmCache, { recursive: true, force: true }));

  const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const parsed = JSON.parse(pack.stdout);
  const packInfo = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const entries = packInfo.files.map((f) => f.path);

  assert.equal(entries.includes('scripts/p2a.mjs'), true);
  assert.equal(entries.includes('schemas/config.schema.json'), true);
  assert.equal(entries.includes('schemas/work.schema.json'), true);
  assert.equal(entries.includes('.agents/skills/p2a-next/SKILL.md'), true);
  assert.equal(entries.includes('.agents/skills/p2a-work/SKILL.md'), true);
  assert.equal(entries.some((f) => f.startsWith('tests/') || f.startsWith('docs/') || f.startsWith('fixtures/')), false);
});

test('Claude PreToolUse hook confines Write/Edit to workspace and blocks destructive root/home rm', (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-hook-ws-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'p2a-hook-out-'));
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  writeFileSync(path.join(outside, 'secret.txt'), 'nope', 'utf8');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'escape-link.txt'));
  symlinkSync(path.join(outside, 'nonexistent-new.txt'), path.join(workspace, 'dangling-escape.txt'));

  assert.equal(
    runHook({ tool_name: 'Write', cwd: workspace, tool_input: { file_path: path.join(workspace, 'src', 'new.mjs') } }).permissionDecision,
    'allow',
  );
  assert.equal(
    runHook({ tool_name: 'Edit', cwd: workspace, tool_input: { file_path: path.join(outside, 'secret.txt') } }).permissionDecision,
    'deny',
  );
  assert.equal(
    runHook({ tool_name: 'Write', cwd: workspace, tool_input: { file_path: path.join(workspace, 'escape-link.txt') } }).permissionDecision,
    'deny',
  );
  assert.equal(
    runHook({ tool_name: 'Write', cwd: workspace, tool_input: { file_path: path.join(workspace, 'dangling-escape.txt') } }).permissionDecision,
    'deny',
  );
  assert.equal(
    runHook({ tool_name: 'Bash', cwd: workspace, tool_input: { command: 'npm test' } }).permissionDecision,
    'allow',
  );
  assert.equal(
    runHook({ tool_name: 'Bash', cwd: workspace, tool_input: { command: 'rm -rf /' } }).permissionDecision,
    'deny',
  );
  assert.equal(
    runHook({ tool_name: 'Bash', cwd: workspace, tool_input: { command: 'rm -rf ~' } }).permissionDecision,
    'deny',
  );
});
