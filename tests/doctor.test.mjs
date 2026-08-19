import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatCommandResult,
  makeTempDir,
  ROOT,
  runDoctor,
  runHandoff,
} from './helpers/fixtures.mjs';

const PACKAGE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

function firstManagedAiTool(targetRoot) {
  const manifest = readManifest(targetRoot);
  const record = manifest.managedFiles.find((candidate) => (
    typeof candidate?.owner === 'string'
    && candidate.owner.startsWith('ai-tool:')
  ));
  assert.ok(record, 'fixture manifest must contain one managed AI tool file');
  return {
    manifest,
    record,
    filePath: path.join(targetRoot, record.path),
  };
}

function managedIntegrityCheck(result) {
  const report = JSON.parse(result.stdout);
  return {
    report,
    integrity: report.checks.find((candidate) => (
      candidate.id === 'dev_manifest_managed_files_integrity'
    )),
  };
}

test('doctor --dev verifies every manifest managed file digest', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-integrity-');
  try {
    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    assert.equal(integrity.status, 'pass');
    assert.equal(integrity.checked, integrity.total);
    assert.ok(integrity.checked > 0);
    assert.deepEqual(integrity.issues, []);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor --dev fails with expected and actual digests after managed content drift', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-drift-');
  try {
    const { record, filePath } = firstManagedAiTool(targetRoot);
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\nlocal drift\n`, 'utf8');

    let result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { report, integrity } = managedIntegrityCheck(result);
    assert.equal(report.status, 'fail');
    assert.equal(integrity.status, 'fail');
    const issue = integrity.issues.find((candidate) => candidate.path === record.path);
    assert.equal(issue.kind, 'hash_mismatch');
    assert.equal(issue.expectedSha256, record.sha256);
    assert.match(issue.actualSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(issue.actualSha256, issue.expectedSha256);
    assert.ok(report.nextActions.some((action) => action.includes('Regenerate or upgrade AI tool assets')));

    result = runDoctor(['--target', targetRoot, '--dev']);
    assert.equal(result.status, 1, formatCommandResult(result));
    assert.match(result.stdout, new RegExp(`hash_mismatch: ${record.path.replaceAll('.', '\\.')}`));
    assert.match(result.stdout, new RegExp(`expected: ${record.sha256}`));
    assert.match(result.stdout, new RegExp(`actual: ${issue.actualSha256}`));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor --dev rejects managed file symlink substitution', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-symlink-');
  try {
    const { record, filePath } = firstManagedAiTool(targetRoot);
    const replacementPath = path.join(targetRoot, 'managed-file-replacement.txt');
    writeFileSync(replacementPath, readFileSync(filePath));
    rmSync(filePath);
    symlinkSync(replacementPath, filePath);

    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    const issue = integrity.issues.find((candidate) => candidate.path === record.path);
    assert.equal(issue.kind, 'symbolic_link');
    assert.equal(issue.expectedSha256, record.sha256);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor --dev rejects an intermediate directory symlink in a managed path', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-parent-symlink-');
  try {
    const { manifest, record, filePath } = firstManagedAiTool(targetRoot);
    const aliasPath = path.join(targetRoot, 'managed-parent-alias');
    symlinkSync(path.dirname(filePath), aliasPath, 'dir');
    record.path = path.posix.join('managed-parent-alias', path.basename(filePath));
    writeManifest(targetRoot, manifest);

    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    const issue = integrity.issues.find((candidate) => candidate.path === record.path);
    assert.equal(issue.kind, 'symbolic_link');
    assert.match(issue.detail, /must not traverse a symbolic link/);
    assert.equal(issue.expectedSha256, record.sha256);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor --dev rejects managed path traversal before reading outside the target', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-traversal-');
  const outsidePath = path.join(
    path.dirname(targetRoot),
    `${path.basename(targetRoot)}-outside-managed.txt`,
  );
  try {
    const { manifest, record, filePath } = firstManagedAiTool(targetRoot);
    writeFileSync(outsidePath, readFileSync(filePath));
    record.path = path.relative(targetRoot, outsidePath);
    writeManifest(targetRoot, manifest);

    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    const issue = integrity.issues.find((candidate) => candidate.kind === 'unsafe_path');
    assert.equal(issue.path, record.path.replaceAll('\\', '/'));
    assert.match(issue.detail, /inside the target root/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test('doctor --dev rejects POSIX and Windows absolute managed paths', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-absolute-');
  const outsidePath = path.join(
    path.dirname(targetRoot),
    `${path.basename(targetRoot)}-absolute-managed.txt`,
  );
  try {
    const { manifest, record, filePath } = firstManagedAiTool(targetRoot);
    writeFileSync(outsidePath, readFileSync(filePath));

    for (const absolutePath of [outsidePath, 'C:\\outside\\managed-file.txt']) {
      record.path = absolutePath;
      writeManifest(targetRoot, manifest);

      const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
      assert.equal(result.status, 1, formatCommandResult(result));
      const { integrity } = managedIntegrityCheck(result);
      const issue = integrity.issues.find((candidate) => candidate.kind === 'unsafe_path');
      assert.equal(issue.path, absolutePath.replaceAll('\\', '/'));
      assert.match(issue.detail, /absolute paths are not allowed/);
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test('doctor --dev reports a missing managed file independently', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-missing-');
  try {
    const { record, filePath } = firstManagedAiTool(targetRoot);
    rmSync(filePath);

    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    const issue = integrity.issues.find((candidate) => candidate.path === record.path);
    assert.equal(issue.kind, 'missing');
    assert.equal(issue.expectedSha256, record.sha256);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor --dev rejects a non-regular managed path', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-managed-file-type-');
  try {
    const { record, filePath } = firstManagedAiTool(targetRoot);
    rmSync(filePath);
    mkdirSync(filePath);

    const result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(result.status, 1, formatCommandResult(result));
    const { integrity } = managedIntegrityCheck(result);
    const issue = integrity.issues.find((candidate) => candidate.path === record.path);
    assert.equal(issue.kind, 'file_type');
    assert.equal(issue.expectedSha256, record.sha256);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

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

test('doctor reports co-located package version drift with update guidance', () => {
  const targetRoot = scaffoldDoctorTarget('p2a-doctor-package-version-');
  try {
    let result = runDoctor(['--target', targetRoot, '--json', '--strict']);
    assert.equal(result.status, 0, formatCommandResult(result));
    let report = JSON.parse(result.stdout);
    let versionCheck = report.checks.find((check) => check.id === 'runtime_package_version');
    assert.equal(versionCheck.status, 'pass');
    assert.equal(versionCheck.runtimeMode, 'co-located');
    assert.equal(versionCheck.manifestPackageName, PACKAGE_JSON.name);
    assert.equal(versionCheck.manifestPackageVersion, PACKAGE_JSON.version);
    assert.equal(versionCheck.runningPackageName, PACKAGE_JSON.name);
    assert.equal(versionCheck.runningPackageVersion, PACKAGE_JSON.version);

    const manifest = readManifest(targetRoot);
    manifest.provenance.packageVersion = '0.0.0-test';
    writeManifest(targetRoot, manifest);

    result = runDoctor(['--target', targetRoot, '--json', '--strict']);
    assert.equal(result.status, 1, formatCommandResult(result));
    report = JSON.parse(result.stdout);
    versionCheck = report.checks.find((check) => check.id === 'runtime_package_version');
    assert.equal(versionCheck.status, 'warn');
    assert.equal(versionCheck.runtimeMode, 'co-located');
    assert.equal(versionCheck.manifestPackageVersion, '0.0.0-test');
    assert.equal(versionCheck.runningPackageVersion, PACKAGE_JSON.version);
    assert.ok(report.nextActions.some((action) => action.includes('p2a update --dry-run')));
    assert.equal(report.nextActions.some((action) => action.includes('p2a upgrade --dry-run')), false);

    result = runDoctor(['--target', targetRoot]);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /manifest: plan2agent@0\.0\.0-test/);
    assert.match(result.stdout, new RegExp(`running: ${PACKAGE_JSON.name}@${PACKAGE_JSON.version.replaceAll('.', '\\.')}`));
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
