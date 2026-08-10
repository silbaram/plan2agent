import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatCommandResult,
  makeTempDir,
  runDoctor,
  runHandoff,
} from './helpers/fixtures.mjs';

function scaffoldDoctorTarget(prefix, tools = 'codex') {
  const targetRoot = makeTempDir(prefix);
  writeFileSync(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node -p 1' } }, null, 2)}\n`,
    'utf8',
  );
  const result = runHandoff(['scaffold', '--target', targetRoot, '--tools', tools]);
  assert.equal(result.status, 0, formatCommandResult(result));
  return targetRoot;
}

function readManifest(targetRoot) {
  return JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
}

function writeManifest(targetRoot, manifest) {
  writeFileSync(
    path.join(targetRoot, '.plan2agent', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

test('doctor reports extra managed scripts and schemas across JSON, human, and strict output', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-extra-managed-');
  const retiredScript = '.plan2agent/scripts/p2a_retired_doctor_example.mjs';
  const retiredSchema = '.plan2agent/schemas/retired-doctor-example.schema.json';
  try {
    const manifest = readManifest(targetRoot);
    manifest.scriptFiles.push(retiredScript);
    manifest.toolFiles.push(retiredScript);
    manifest.schemaFiles.push(retiredSchema);
    writeManifest(targetRoot, manifest);

    let result = runDoctor(['--target', targetRoot, '--json']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const report = JSON.parse(result.stdout);
    const scriptCheck = report.checks.find((check) => check.id === 'manifest_runtime_scripts');
    const schemaCheck = report.checks.find((check) => check.id === 'manifest_runtime_schemas');
    assert.equal(report.status, 'warn');
    assert.deepEqual(scriptCheck.extra, [retiredScript]);
    assert.deepEqual(schemaCheck.extra, [retiredSchema]);
    assert.equal(
      [...scriptCheck.extra, ...schemaCheck.extra]
        .some((file) => manifest.aiToolFiles.includes(file)),
      false,
    );
    assert.ok(report.nextActions.some((action) => action.includes('p2a update --dry-run')));

    result = runDoctor(['--target', targetRoot, '--json', '--strict']);
    assert.equal(result.status, 1, formatCommandResult(result));
    assert.equal(JSON.parse(result.stdout).status, 'warn');

    result = runDoctor(['--target', targetRoot]);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /extra: \.plan2agent\/scripts\/p2a_retired_doctor_example\.mjs/);
    assert.match(result.stdout, /extra: \.plan2agent\/schemas\/retired-doctor-example\.schema\.json/);
    assert.match(result.stdout, /p2a update --dry-run/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor excludes external harness files from managed runtime drift', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-external-harness-', 'none');
  const externalScript = '.plan2agent/scripts/external-harness-adapter.mjs';
  const externalSchema = '.plan2agent/schemas/external-harness.schema.json';
  try {
    const manifest = readManifest(targetRoot);
    manifest.toolFiles.push(externalScript);
    manifest.schemaFiles.push(externalSchema);
    manifest.externalHarnessFiles = [externalSchema, externalScript];
    writeManifest(targetRoot, manifest);

    const result = runDoctor(['--target', targetRoot, '--json', '--strict']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const report = JSON.parse(result.stdout);
    for (const checkId of ['manifest_runtime_scripts', 'manifest_runtime_schemas']) {
      const manifestCheck = report.checks.find((check) => check.id === checkId);
      assert.equal(manifestCheck.status, 'pass');
      assert.equal('extra' in manifestCheck, false);
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
