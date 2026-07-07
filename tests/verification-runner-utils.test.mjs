import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyVerificationSpawnResult,
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
