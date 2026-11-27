import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initProject } from '../scripts/p2a_init.mjs';
import {
  BUILDLORE_HANDOFF_READ_MAX_BYTES,
  BUILDLORE_READ_MAX_BYTES,
  BUILDLORE_READ_TIMEOUT_MS,
  resolveBuildLoreInvocation,
  runBuildLore,
} from '../scripts/p2a_buildlore.mjs';

test('resolveBuildLoreInvocation resolves project_id from config.json and enforces bounds', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2a-buildlore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  initProject(dir, { tools: [], projectId: 'demo-service' });

  const mem = resolveBuildLoreInvocation(['memory', '--task', 'auth flow', '--target', dir]);
  assert.equal(mem.executable, 'buildlore');
  assert.equal(mem.boundedRead, true);
  assert.equal(mem.timeoutMs, BUILDLORE_READ_TIMEOUT_MS);
  assert.equal(mem.maxOutputBytes, BUILDLORE_READ_MAX_BYTES);
  assert.deepEqual(mem.args, ['wiki', 'memory', '--project', 'demo-service', '--task', 'auth flow']);

  const digest = `sha256:${'a'.repeat(64)}`;
  const handoffRead = resolveBuildLoreInvocation(['handoff', 'read', '--id', digest, '--target', dir]);
  assert.equal(handoffRead.boundedRead, true);
  assert.equal(handoffRead.maxOutputBytes, BUILDLORE_HANDOFF_READ_MAX_BYTES);
  assert.deepEqual(handoffRead.args, ['handoff', 'read', '--project', 'demo-service', '--id', digest]);

  // Invalid handoff digest rejected
  assert.throws(
    () => resolveBuildLoreInvocation(['handoff', 'read', '--id', 'not-a-digest', '--target', dir]),
    /canonical sha256 digest/,
  );

  // Explicit --project override and --flag=value syntax work
  const overridden = resolveBuildLoreInvocation(['status', '--project=custom-id', `--target=${dir}`]);
  assert.deepEqual(overridden.args, ['knowledge', 'status', '--project', 'custom-id']);
  const handoffEq = resolveBuildLoreInvocation(['handoff', 'verify', `--id=${digest}`, `--target=${dir}`]);
  assert.deepEqual(handoffEq.args, ['handoff', 'verify', '--project', 'demo-service', `--id=${digest}`]);

  // Symlinked --target directory is accepted
  const linkDir = path.join(os.tmpdir(), `p2a-bl-link-${Date.now()}`);
  try {
    symlinkSync(dir, linkDir, 'dir');
    t.after(() => rmSync(linkDir, { recursive: true, force: true }));
    const viaLink = resolveBuildLoreInvocation(['status', '--target', linkDir]);
    assert.deepEqual(viaLink.args, ['knowledge', 'status', '--project', 'demo-service']);
  } catch (error) {
    if (!(process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;
  }
});

test('resolveBuildLoreInvocation falls back to .buildlore/connection.json for status', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2a-buildlore-conn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(path.join(dir, '.buildlore'), { recursive: true });
  writeFileSync(
    path.join(dir, '.buildlore', 'connection.json'),
    JSON.stringify({ projectId: 'connected-proj' }),
    'utf8',
  );

  const inv = resolveBuildLoreInvocation(['status', '--target', dir], {
    environment: { BUILDLORE_BIN: '/custom/buildlore' },
  });
  assert.equal(inv.executable, '/custom/buildlore');
  assert.deepEqual(inv.args, ['connection', 'status', '--project', 'connected-proj']);
});

test('runBuildLore handles help, mocked success, and missing binary gracefully', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2a-buildlore-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initProject(dir, { tools: [], projectId: 'demo-proj' });

  let out = '';
  let err = '';
  assert.equal(runBuildLore(['--help'], { stdout: (s) => { out += s; } }), 0);
  assert.match(out, /p2a buildlore memory/);

  out = '';
  const okCode = runBuildLore(['memory', '--task', 'resume', '--target', dir], {
    runner: () => ({ status: 0, stdout: '{"hits":[]}\n', stderr: '' }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  assert.equal(okCode, 0);
  assert.equal(out, '{"hits":[]}\n');
  assert.equal(err, '');

  // Non-zero bounded read still surfaces stdout error payload
  out = '';
  const failedJsonCode = runBuildLore(['memory', '--task', 'resume', '--target', dir], {
    runner: () => ({ status: 2, stdout: '{"error":"index missing"}\n', stderr: '' }),
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  assert.equal(failedJsonCode, 2);
  assert.equal(out, '{"error":"index missing"}\n');

  err = '';
  const missingCode = runBuildLore(['status', '--target', dir], {
    runner: () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
    stderr: (s) => { err += s; },
  });
  assert.equal(missingCode, 1);
  assert.match(err, /BuildLore executable not found/);
});
