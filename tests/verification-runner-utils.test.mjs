import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyVerificationSpawnResult,
  decodeVerificationOutput,
  normalizeProjectLocalLauncherCommand,
} from '../scripts/p2a_runs.mjs';

test('classifies spawn ENOENT as unavailable', () => {
  assert.deepEqual(classifyVerificationSpawnResult({ error: { code: 'ENOENT' }, status: null, stderr: '' }), {
    status: 'unavailable',
    reason: 'spawn_enoent',
    hint: 'verification command could not be started (ENOENT)',
  });
});

test('classifies Windows cmd not-found exit code and English stderr as unavailable', () => {
  assert.equal(classifyVerificationSpawnResult({ status: 9009, stderr: '' }).status, 'unavailable');
  assert.equal(classifyVerificationSpawnResult({ status: 1, stderr: "'gradlew' is not recognized as an internal or external command,\r\noperable program or batch file." }).status, 'unavailable');
});

test('classifies Windows cmd Korean not-found stderr as unavailable', () => {
  const result = classifyVerificationSpawnResult({ status: 1, stderr: "'gradlew'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다." });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'windows_command_not_found');
});

test('classifies POSIX shell not-found exit as unavailable', () => {
  const result = classifyVerificationSpawnResult({ status: 127, stderr: '/bin/sh: 1: definitely-missing-xyz: not found\n' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'shell_command_not_found');
});

test('keeps normal non-zero command exits as regular failed verification', () => {
  assert.deepEqual(classifyVerificationSpawnResult({ status: 1, stderr: 'test assertion failed' }), {
    status: null,
    reason: null,
    hint: null,
  });
});

test('normalizes an existing project-local launcher token to an absolute path', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-normalize-'));
  const binDir = path.join(workspace, 'tools');
  mkdirSync(binDir);
  const launcher = path.join(binDir, 'verify');
  writeFileSync(launcher, '#!/bin/sh\n');
  const normalized = normalizeProjectLocalLauncherCommand('./tools/verify build', workspace, { platform: 'linux' });
  assert.equal(normalized.normalized, true);
  assert.equal(normalized.command, `"${launcher}" build`);
  assert.equal(normalized.originalToken, './tools/verify');
  assert.equal(normalized.normalizedToken, launcher);
});

test('prefers a same-name .bat sibling on win32', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-normalize-bat-'));
  const sh = path.join(workspace, 'gradlew');
  const bat = path.join(workspace, 'gradlew.bat');
  writeFileSync(sh, '#!/bin/sh\n');
  writeFileSync(bat, '@echo off\r\n');
  const normalized = normalizeProjectLocalLauncherCommand('./gradlew build', workspace, { platform: 'win32' });
  assert.equal(normalized.normalized, true);
  assert.equal(normalized.normalizedToken, bat);
  assert.equal(normalized.command, `"${bat}" build`);
});

test('skips launcher normalization for complex shell commands', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-normalize-complex-'));
  writeFileSync(path.join(workspace, 'gradlew'), '#!/bin/sh\n');
  const normalized = normalizeProjectLocalLauncherCommand('./gradlew build && npm test', workspace, { platform: 'linux' });
  assert.equal(normalized.normalized, false);
  assert.equal(normalized.command, './gradlew build && npm test');
  assert.equal(normalized.reason, 'complex_command');
});


test('decodes CP949 Korean cmd stderr and classifies unresolved Windows command by filesystem lookup', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-cp949-'));
  const cp949Bytes = Buffer.from([
    39, 120, 39, 192, 186, 40, 180, 194, 41, 32, 179, 187, 186, 206, 32, 182,
    199, 180, 194, 32, 189, 199, 199, 224, 199, 210, 32, 188, 246, 32, 192,
    214, 180, 194, 32, 199, 193, 183, 206, 177, 215, 183, 165, 44, 32, 182,
    199, 180, 194, 32, 185, 232, 196, 161, 32, 198, 196, 192, 207, 192, 204,
    32, 190, 198, 180, 213, 180, 207, 180, 217, 46,
  ]);
  const decoded = decodeVerificationOutput(cp949Bytes, { platform: 'win32' });
  assert.equal(decoded, "'x'은(는) 내부 또는 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다.");
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: Buffer.alloc(0), stderr: cp949Bytes },
    { platform: 'win32', command: 'x', workspacePath: workspace, env: { PATH: '', PATHEXT: '.EXE;.CMD' } },
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'command_not_resolvable');
});

test('Windows filesystem lookup keeps existing path-like command resolvable', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-path-found-'));
  writeFileSync(path.join(workspace, 'verify.cmd'), '@echo off\r\n');
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: '', stderr: 'not a recognizable localized error' },
    { platform: 'win32', command: './verify.cmd', workspacePath: workspace, env: { PATH: '', PATHEXT: '.CMD' } },
  );
  assert.equal(result.status, null);
});

test('Windows filesystem lookup classifies missing path-like command as unavailable', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-path-missing-'));
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: '', stderr: 'localized text was unreadable' },
    { platform: 'win32', command: './missing.cmd test', workspacePath: workspace, env: { PATH: '', PATHEXT: '.CMD' } },
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'command_not_resolvable');
});

test('Windows filesystem lookup resolves bare PATH command with PATHEXT', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-bare-work-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-bare-bin-'));
  const executable = path.join(binDir, 'verify.CMD');
  writeFileSync(executable, '@echo off\r\n');
  chmodSync(executable, 0o755);
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: '', stderr: 'not a not-found message' },
    { platform: 'win32', command: 'verify --flag', workspacePath: workspace, env: { PATH: binDir, PATHEXT: '.EXE;.CMD' } },
  );
  assert.equal(result.status, null);
});

test('Windows filesystem lookup excludes cmd builtins from command_not_resolvable fallback', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-builtin-'));
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: '', stderr: 'not a not-found message' },
    { platform: 'win32', command: 'dir', workspacePath: workspace, env: { PATH: '', PATHEXT: '.EXE;.CMD' } },
  );
  assert.equal(result.status, null);
});

test('Windows filesystem lookup does not classify when stdout is non-empty', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'p2a-win-stdout-'));
  const result = classifyVerificationSpawnResult(
    { status: 1, stdout: 'work happened', stderr: 'not a not-found message' },
    { platform: 'win32', command: 'definitely-missing-xyz', workspacePath: workspace, env: { PATH: '', PATHEXT: '.EXE;.CMD' } },
  );
  assert.equal(result.status, null);
});

test('UTF-8 output without replacement characters is not re-decoded as EUC-KR', () => {
  const text = 'plain utf8 output ✓';
  assert.equal(decodeVerificationOutput(Buffer.from(text, 'utf8'), { platform: 'win32' }), text);
});
