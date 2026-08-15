import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  appendDecisionEvents,
  decisionLedgerPath,
  fileSha256,
  scopeApprovalState,
} from '../scripts/p2a_decision_ledger.mjs';
import {
  validateArtifactRoot,
  validateDecisionData,
  validateDecisionLedger,
  validateHandoffReadyArtifactRoot,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import {
  FIXTURE_ROOT,
  makeTempDir,
  P2A_CLI,
  runHandoff,
  runP2a,
} from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureJson(relativePath) {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', relativePath), 'utf8'));
}

function createFlatProject(options = {}) {
  const root = makeTempDir('p2a-decisions-');
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'cache-library');
  const entryPath = join(root, 'idea.md');
  writeFileSync(entryPath, 'Build and validate the requested cache-library scope.\n', 'utf8');
  const intake = fixtureJson('intake.answered.json');
  intake.approval_audit.approved_artifacts = ['gate-a-intake/intake.json'];
  if (options.intakeDraft) {
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
  }
  const spec = fixtureJson('spec.approved.json');
  spec.source_intake = '../gate-a-intake/intake.json';
  spec.approval_audit.approved_artifacts = ['gate-b-spec/spec.json'];
  if (options.specDraft !== false) {
    spec.approval = 'draft';
    delete spec.approval_audit;
  }
  const graph = fixtureJson('task-graph.json');
  graph.sourceSpec = '../gate-b-spec/spec.json';
  writeJson(join(artifactRoot, 'gate-a-intake', 'intake.json'), intake);
  writeJson(join(artifactRoot, 'gate-b-spec', 'spec.json'), spec);
  if (options.graph) writeJson(join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), graph);
  return { root, artifactRoot, entryPath };
}

function spawnP2a(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [P2A_CLI, ...args], {
      cwd: join(P2A_CLI, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('decision ledger validates monotonic sequence and chained hashes', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.what.approved',
    quote: '이 범위로 가자',
    scope_ref: 'gate-b-spec/spec.json',
    sha256: fileSha256(specPath),
  }]);
  const ledgerPath = decisionLedgerPath(artifactRoot);
  const originalPrefix = readFileSync(ledgerPath, 'utf8');
  appendDecisionEvents(artifactRoot, [
    {
      type: 'scope.added',
      quote: '재시도도 넣자',
      scope_ref: 'gate-b-spec/spec.json',
      sha256: fileSha256(specPath),
      scope_change: 'retry support',
      prev_seq: 1,
    },
  ]);
  assert.equal(readFileSync(ledgerPath, 'utf8').startsWith(originalPrefix), true);
  const records = validateDecisionLedger(ledgerPath);
  assert.deepEqual(records.map((record) => record.seq), [1, 2]);
  const cliValidation = runP2a(['validate', '--decisions', '--artifacts', artifactRoot]);
  assert.equal(cliValidation.status, 0, `${cliValidation.stdout}${cliValidation.stderr}`);
  assert.throws(
    () => validateDecisionData({
      seq: 3,
      at: new Date().toISOString(),
      type: 'run.finished',
      quote: 'not a decision',
      prev_sha256: records[1].prev_sha256,
    }),
    (error) => error instanceof ValidationError && /type/.test(error.message),
  );
  assert.throws(
    () => validateDecisionData({
      seq: 3,
      at: new Date().toISOString(),
      type: 'gate.what.approved',
      quote: 'outside scope',
      scope_ref: '../gate-b-spec/spec.json',
      sha256: 'a'.repeat(64),
      prev_sha256: records[1].prev_sha256,
    }),
    (error) => error instanceof ValidationError && /safe artifact-relative path/.test(error.message),
  );
  const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  first.quote = 'tampered';
  lines[0] = JSON.stringify(first);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`, 'utf8');
  assert.throws(
    () => validateDecisionLedger(ledgerPath),
    (error) => error instanceof ValidationError && /chain mismatch/.test(error.message),
  );
});

test('a stale prev_seq is rejected and the failed append restores the exact ledger prefix', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.what.approved',
    quote: '이 범위로 가자',
    scope_ref: 'gate-b-spec/spec.json',
    sha256: fileSha256(specPath),
  }]);
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.what.revoked',
    quote: '승인을 철회해',
    scope_ref: 'gate-b-spec/spec.json',
    sha256: fileSha256(specPath),
    prev_seq: 1,
  }]);
  const ledgerPath = decisionLedgerPath(artifactRoot);
  const before = readFileSync(ledgerPath, 'utf8');

  assert.throws(
    () => appendDecisionEvents(artifactRoot, [{
      type: 'scope.added',
      quote: '철회된 범위에 다시 추가해',
      scope_ref: 'gate-b-spec/spec.json',
      sha256: fileSha256(specPath),
      scope_change: 'stale scope resurrection',
      prev_seq: 1,
    }]),
    (error) => error instanceof ValidationError && /latest active decision/.test(error.message),
  );
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  assert.deepEqual(validateDecisionLedger(ledgerPath).map((record) => record.seq), [1, 2]);
});

test('p2a decide records Gate ① approvals, revocation, and reapproval without deleting history', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missingQuote = runP2a(['decide', '--artifacts', artifactRoot]);
  assert.notEqual(missingQuote.status, 0);
  assert.match(missingQuote.stderr, /^p2a decide error:/);
  assert.match(missingQuote.stderr, /requires --quote/);
  const ignoredOption = runP2a([
    'decide', '--artifacts', artifactRoot, '--quote', '승인해', '--why', 'src/cache.ts',
  ]);
  assert.notEqual(ignoredOption.status, 0);
  assert.match(ignoredOption.stderr, /--why is only supported by p2a decisions/);

  const missingEntry = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 범위로 가자']);
  assert.notEqual(missingEntry.status, 0);
  assert.match(missingEntry.stderr, /requires --entry/);

  let result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath, '--quote', '이 범위로 가자',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  let intake = JSON.parse(readFileSync(join(artifactRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  assert.equal(intake.status, 'ready_for_spec');
  assert.match(intake.approval_audit.approval_note, /"이 범위로 가자"/);

  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 명세로 구현해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  let spec = JSON.parse(readFileSync(join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8'));
  assert.equal(spec.approval, 'approved');

  result = runP2a(['decide', 'revoke', '--artifacts', artifactRoot, '--quote', '명세 승인을 철회해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const next = runP2a(['next', '--target', root, '--json']);
  assert.equal(next.status, 0, `${next.stdout}${next.stderr}`);
  assert.equal(JSON.parse(next.stdout).state, 'gate_b_needs_approval');

  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '수정된 명세를 다시 승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'decide', 'add', '--artifacts', artifactRoot,
    '--quote', '재시도 범위도 승인해', '--scope', 'retry support',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'decide', 'remove', '--artifacts', artifactRoot,
    '--quote', '불필요한 캐시 범위는 빼자', '--scope', 'legacy cache support',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const records = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.deepEqual(records.map((record) => record.type), [
    'gate.what.approved',
    'gate.what.approved',
    'gate.what.revoked',
    'gate.what.approved',
    'scope.added',
    'scope.removed',
  ]);
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(records[5].prev_seq, records[4].seq);
  spec = JSON.parse(readFileSync(join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8'));
  assert.match(spec.approval_audit.approval_note, /"수정된 명세를 다시 승인해"/);
  result = runP2a(['decisions', '--artifacts', artifactRoot, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), records);
  const afterScopeChange = runP2a(['next', '--target', root, '--json']);
  assert.equal(afterScopeChange.status, 0, `${afterScopeChange.stdout}${afterScopeChange.stderr}`);
  assert.equal(JSON.parse(afterScopeChange.stdout).state, 'gate_b_approved_needs_tasks');
});

test('decision records and approval audit copies preserve the exact quoted utterance', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const quote = '  이 공백까지 그대로 기록해  ';

  const result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath, '--quote', quote,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const [record] = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.equal(record.quote, quote);
  const intake = JSON.parse(readFileSync(join(artifactRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  assert.equal(intake.approval_audit.approval_note, `User quote: ${JSON.stringify(quote)}`);
});

test('Gate A approval rejects an entry reference bundle until its snapshot is captured', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prototypePath = join(root, 'prototype.html');
  writeFileSync(prototypePath, '<!doctype html><title>Unsnapshotted evidence</title>\n', 'utf8');
  writeJson(join(root, 'p2a-reference-bundle.json'), {
    schema_version: 'p2a.reference_bundle.v1',
    entry: 'idea.md',
    references: [{
      id: 'REF-1',
      path: 'prototype.html',
      kind: 'html',
      sha256: fileSha256(prototypePath),
      load_when: 'Gate B needs the approved screen evidence.',
      description: 'Screen evidence that must be captured before approval.',
    }],
  });

  const result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath,
    '--quote', '참조 자료도 포함해서 승인해',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reference-bundle-snapshot\.json is required/);
  const intake = JSON.parse(readFileSync(join(artifactRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  assert.equal(intake.status, 'blocked_on_user');
  assert.equal(existsSync(decisionLedgerPath(artifactRoot)), false);
});

test('Gate A approval rejects a sibling reference bundle represented by a symbolic link', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prototypePath = join(root, 'prototype.html');
  writeFileSync(prototypePath, '<!doctype html><title>Linked bundle evidence</title>\n', 'utf8');
  writeJson(join(root, 'bundle-source.json'), {
    schema_version: 'p2a.reference_bundle.v1',
    entry: 'idea.md',
    references: [{
      id: 'REF-1',
      path: 'prototype.html',
      kind: 'html',
      sha256: fileSha256(prototypePath),
      load_when: 'Gate B needs linked screen evidence.',
      description: 'Evidence whose bundle path must not bypass snapshot binding.',
    }],
  });
  try {
    symlinkSync('bundle-source.json', join(root, 'p2a-reference-bundle.json'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const validation = runP2a(['validate', '--entry', entryPath]);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr, /reference bundle must be a regular file/);

  const result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath,
    '--quote', 'symlink bundle을 포함해서 승인해',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reference bundle must be a regular file/);
  const intake = JSON.parse(readFileSync(join(artifactRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  assert.equal(intake.status, 'blocked_on_user');
  assert.equal(existsSync(decisionLedgerPath(artifactRoot)), false);
});

test('Gate approvals bind reference provenance sidecars by artifact path and SHA-256', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true, graph: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshotPath = join(
    artifactRoot,
    'gate-a-intake',
    'reference-bundle-snapshot.json',
  );
  const entry = 'Build a service from conditionally loaded reference evidence.\n';
  const prototype = '<!doctype html><title>Decision reference</title>\n';
  writeFileSync(join(root, 'idea.md'), entry, 'utf8');
  writeFileSync(join(root, 'prototype.html'), prototype, 'utf8');
  writeJson(join(root, 'p2a-reference-bundle.json'), {
    schema_version: 'p2a.reference_bundle.v1',
    entry: 'idea.md',
    references: [{
      id: 'REF-1',
      path: 'prototype.html',
      kind: 'html',
      sha256: fileSha256(join(root, 'prototype.html')),
      load_when: 'Gate B needs the screen composition.',
      description: 'Approved screen prototype.',
    }],
  });
  let result = runP2a([
    'reference', 'snapshot',
    '--target', root,
    '--entry', 'idea.md',
    '--artifacts', artifactRoot,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

  result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath,
    '--quote', '참고 자료를 포함한 범위를 승인해',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const intake = JSON.parse(readFileSync(join(artifactRoot, 'gate-a-intake', 'intake.json'), 'utf8'));
  assert.ok(intake.approval_audit.approved_artifacts.includes(
    'gate-a-intake/reference-bundle-snapshot.json',
  ));
  assert.match(
    intake.approval_audit.approval_note,
    new RegExp(`Sidecar SHA-256: gate-a-intake/reference-bundle-snapshot\\.json ${fileSha256(snapshotPath)}`),
  );

  const usagePath = join(artifactRoot, 'gate-b-spec', 'reference-bundle-usage.json');
  writeJson(usagePath, {
    schema_version: 'p2a.reference_bundle_usage.v1',
    source_snapshot_ref: '../gate-a-intake/reference-bundle-snapshot.json',
    source_snapshot_sha256: fileSha256(snapshotPath),
    source_bundle_ref: snapshot.source_bundle_ref,
    source_bundle_sha256: snapshot.source_bundle_sha256,
    inspected_references: [],
  });
  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '참고 자료 사용 내역을 포함한 명세를 승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const spec = JSON.parse(readFileSync(join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8'));
  assert.ok(spec.approval_audit.approved_artifacts.includes(
    'gate-b-spec/reference-bundle-usage.json',
  ));
  assert.match(
    spec.approval_audit.approval_note,
    new RegExp(`Sidecar SHA-256: gate-b-spec/reference-bundle-usage\\.json ${fileSha256(usagePath)}`),
  );

  result = runP2a([
    'iteration', 'init', '--artifacts', artifactRoot, '--iteration-id', 'iter-reference-sidecars',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const movedIntake = JSON.parse(readFileSync(join(
    artifactRoot,
    'iterations',
    'iter-reference-sidecars',
    'gate-a-intake',
    'intake.json',
  ), 'utf8'));
  const movedSpec = JSON.parse(readFileSync(join(
    artifactRoot,
    'iterations',
    'iter-reference-sidecars',
    'gate-b-spec',
    'spec.json',
  ), 'utf8'));
  assert.ok(movedIntake.approval_audit.approved_artifacts.includes(
    'iterations/iter-reference-sidecars/gate-a-intake/reference-bundle-snapshot.json',
  ));
  assert.ok(movedSpec.approval_audit.approved_artifacts.includes(
    'iterations/iter-reference-sidecars/gate-b-spec/reference-bundle-usage.json',
  ));
  assert.equal(existsSync(join(
    artifactRoot,
    'iterations',
    'iter-reference-sidecars',
    'gate-a-intake',
    snapshot.references[0].path,
  )), true);
});

test('handoff readiness rejects provenance stripped from decision-bound Gate artifacts', (t) => {
  const { root, artifactRoot, entryPath } = createFlatProject({ intakeDraft: true, graph: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intakePath = join(artifactRoot, 'gate-a-intake', 'intake.json');
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  const snapshotPath = join(artifactRoot, 'gate-a-intake', 'reference-bundle-snapshot.json');
  const usagePath = join(artifactRoot, 'gate-b-spec', 'reference-bundle-usage.json');
  writeFileSync(join(root, 'idea.md'), 'Build a service from approved evidence.\n', 'utf8');
  writeFileSync(join(root, 'prototype.html'), '<!doctype html><title>Bound evidence</title>\n', 'utf8');
  writeJson(join(root, 'p2a-reference-bundle.json'), {
    schema_version: 'p2a.reference_bundle.v1',
    entry: 'idea.md',
    references: [{
      id: 'REF-1',
      path: 'prototype.html',
      kind: 'html',
      sha256: fileSha256(join(root, 'prototype.html')),
      load_when: 'Gate B needs the approved prototype.',
      description: 'Decision-bound prototype.',
    }],
  });
  let result = runP2a([
    'reference', 'snapshot',
    '--target', root,
    '--entry', 'idea.md',
    '--artifacts', artifactRoot,
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'decide', '--artifacts', artifactRoot, '--entry', entryPath,
    '--quote', '참조 범위를 승인해',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  writeJson(usagePath, {
    schema_version: 'p2a.reference_bundle_usage.v1',
    source_snapshot_ref: '../gate-a-intake/reference-bundle-snapshot.json',
    source_snapshot_sha256: fileSha256(snapshotPath),
    source_bundle_ref: snapshot.source_bundle_ref,
    source_bundle_sha256: snapshot.source_bundle_sha256,
    inspected_references: [],
  });
  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '참조 사용 내역을 포함한 명세를 승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotThrow(() => validateHandoffReadyArtifactRoot(artifactRoot));

  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  intake.approval_audit.approved_artifacts = intake.approval_audit.approved_artifacts
    .filter((reference) => !reference.endsWith('reference-bundle-snapshot.json'));
  intake.approval_audit.approval_note = intake.approval_audit.approval_note
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('Sidecar SHA-256:'))
    .join('\n');
  writeJson(intakePath, intake);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.approval_audit.approved_artifacts = spec.approval_audit.approved_artifacts
    .filter((reference) => !reference.endsWith('reference-bundle-usage.json'));
  spec.approval_audit.approval_note = spec.approval_audit.approval_note
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('Sidecar SHA-256:'))
    .join('\n');
  if (Object.hasOwn(spec, 'source_intake_sha256')) {
    spec.source_intake_sha256 = fileSha256(intakePath);
  }
  writeJson(specPath, spec);
  rmSync(snapshotPath);
  rmSync(usagePath);
  rmSync(join(artifactRoot, 'gate-a-intake', 'reference-sources'), { recursive: true });

  const validation = validateArtifactRoot(artifactRoot);
  assert.equal(validation.gates.a.passed, false);
  assert.equal(validation.gates.b.passed, false);
  assert.throws(
    () => validateHandoffReadyArtifactRoot(artifactRoot),
    /Gate A approval decision binding failed: approved_hash_mismatch/,
  );
});

test('p2a next rejects a malformed decision chain before using artifact approval copies', (t) => {
  const { root, artifactRoot } = createFlatProject({ specDraft: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  appendDecisionEvents(artifactRoot, [
    {
      type: 'gate.what.approved',
      quote: '이 명세로 진행해',
      scope_ref: 'gate-b-spec/spec.json',
      sha256: fileSha256(specPath),
    },
    {
      type: 'scope.added',
      quote: '재시도도 넣자',
      scope_ref: 'gate-b-spec/spec.json',
      sha256: fileSha256(specPath),
      scope_change: 'retry support',
      prev_seq: 1,
    },
  ]);
  const ledgerPath = decisionLedgerPath(artifactRoot);
  const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  first.quote = 'tampered';
  lines[0] = JSON.stringify(first);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`, 'utf8');

  const result = runP2a(['next', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const next = JSON.parse(result.stdout);
  assert.equal(next.state, 'invalid_decisions');
  assert.match(next.command.display, /validate --decisions/);
  assert.deepEqual(next.command.argv, [
    'validate', '--decisions', '--artifacts', artifactRoot,
  ]);
  const validation = runP2a(next.command.argv);
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr, /chain mismatch/);
});

test('a legacy approval copy cannot revoke the same Gate ① decision twice', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 명세로 구현해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['decide', 'revoke', '--artifacts', artifactRoot, '--quote', '명세 승인을 철회해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['decide', 'revoke', '--artifacts', artifactRoot, '--quote', '다시 철회해']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no active Gate ① decision/);
  assert.equal(validateDecisionLedger(decisionLedgerPath(artifactRoot)).length, 2);
});

test('a present ledger never falls back to unrecorded Gate ① approval copies', (t) => {
  const { root, artifactRoot } = createFlatProject({ specDraft: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.how.approved',
    quote: '구조만 승인했어',
    constitution_sha256: 'a'.repeat(64),
  }]);

  let result = runP2a(['next', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).state, 'gate_a_needs_approval');

  result = runP2a(['decide', 'revoke', '--artifacts', artifactRoot, '--quote', '범위 승인을 철회해']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no active Gate ① decision/);

  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 범위를 원장에 승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const records = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.deepEqual(records.map((record) => record.type), [
    'gate.how.approved',
    'gate.what.approved',
  ]);
  assert.equal(records[1].scope_ref, 'gate-a-intake/intake.json');
});

test('shape approval, constitution change, revocation, and reapproval append Gate ② history', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const constitutionPath = join(root, '.plan2agent', 'constitution.json');
  const constitution = {
    schema_version: 'p2a.constitution.v1',
    projectId: 'cache-library',
    architecture: [{ id: 'ARCH-1', rule: 'Use modules.', rationale: 'Keep boundaries clear.', scope: 'runtime' }],
    stack: [],
    prohibitions: [],
    style: {},
  };
  writeJson(constitutionPath, constitution);

  let result = runP2a(['shape', 'approve', '--target', root, '--quote', '이 구조로 가자']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['shape', 'revoke', '--target', root, '--quote', '구조 승인을 철회해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['shape', 'revoke', '--target', root, '--quote', '다시 철회해']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no active Gate ② decision/);

  const changed = JSON.parse(readFileSync(constitutionPath, 'utf8'));
  changed.architecture[0].rule = 'Use strict module boundaries.';
  delete changed.approval_audit;
  writeJson(constitutionPath, changed);
  result = runP2a(['shape', 'approve', '--target', root, '--quote', '변경된 구조를 승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  const records = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.deepEqual(records.map((record) => record.type), [
    'gate.how.approved',
    'gate.how.revoked',
    'constitution.changed',
    'gate.how.approved',
  ]);
  const status = runP2a(['shape', '--target', root, '--json']);
  assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
  assert.equal(JSON.parse(status.stdout).approvalSource, 'decisions');
});

test('shape status reports an invalid decision ledger instead of trusting its approval copy', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const constitutionPath = join(root, '.plan2agent', 'constitution.json');
  writeJson(constitutionPath, {
    schema_version: 'p2a.constitution.v1',
    projectId: 'cache-library',
    architecture: [{ id: 'ARCH-1', rule: 'Use modules.', rationale: 'Keep boundaries clear.', scope: 'runtime' }],
    stack: [],
    prohibitions: [],
    style: {},
  });

  let result = runP2a(['shape', 'approve', '--target', root, '--quote', '이 구조로 가자']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['shape', 'revoke', '--target', root, '--quote', '구조 승인을 철회해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const ledgerPath = decisionLedgerPath(artifactRoot);
  const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  first.quote = 'tampered';
  lines[0] = JSON.stringify(first);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`, 'utf8');

  result = runP2a(['shape', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'invalid');
  assert.equal(status.approved, false);
  assert.match(status.error, /chain mismatch/);
  assert.match(status.next, /p2a validate --decisions --artifacts/);
});

test('a present ledger never falls back to an unrecorded Gate ② approval copy', (t) => {
  const { root, artifactRoot } = createFlatProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const constitutionPath = join(root, '.plan2agent', 'constitution.json');
  writeJson(constitutionPath, {
    schema_version: 'p2a.constitution.v1',
    projectId: 'cache-library',
    architecture: [{ id: 'ARCH-1', rule: 'Use modules.', rationale: 'Keep boundaries clear.', scope: 'runtime' }],
    stack: [],
    prohibitions: [],
    style: {},
    approval_audit: {
      approved_by: 'user',
      approved_at: '2026-08-05',
      approved_artifacts: ['.plan2agent/constitution.json'],
      approval_note: 'User quote: "이 구조로 가자"',
    },
  });
  const intakePath = join(artifactRoot, 'gate-a-intake', 'intake.json');
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.what.approved',
    quote: '이 범위로 가자',
    scope_ref: 'gate-a-intake/intake.json',
    sha256: fileSha256(intakePath),
  }]);

  let result = runP2a(['shape', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const shape = JSON.parse(result.stdout);
  assert.equal(shape.state, 'draft');
  assert.equal(shape.approved, false);
  assert.equal(shape.approvalSource, 'decisions');

  result = runP2a(['next', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).state, 'shape');

  result = runP2a(['shape', 'revoke', '--target', root, '--quote', '구조 승인을 철회해']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no active Gate ② decision/);
});

test('concurrent scope decision appends reuse the run-store lock without losing records', async (t) => {
  const { root, artifactRoot } = createFlatProject({ specDraft: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  appendDecisionEvents(artifactRoot, [{
    type: 'gate.what.approved',
    quote: '이 명세로 진행해',
    scope_ref: 'gate-b-spec/spec.json',
    sha256: fileSha256(specPath),
  }]);

  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => spawnP2a([
    'decide', 'add',
    '--artifacts', artifactRoot,
    '--quote', `추가 ${index}`,
    '--scope', `scope-${index}`,
  ])));
  for (const result of results) {
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
  const records = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.equal(records.length, 7);
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(records.filter((record) => record.type === 'scope.added').length, 6);
});

test('p2a decisions --why joins changedFiles with the governing scope decision', (t) => {
  const { root, artifactRoot } = createFlatProject({ graph: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 명세로 구현해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const graphPath = join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  result = runP2a([
    'runs', 'start', '--graph', graphPath,
    '--task', 'task-001', '--run-id', 'run-why',
    '--agent-tool', 'codex', '--workspace-ref', 'main',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'runs', 'record', '--graph', graphPath,
    '--run-id', 'run-why', '--changed-file', 'src/cache.ts',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

  result = runP2a([
    'decisions', '--artifacts', artifactRoot,
    '--why', 'src/cache.ts', '--json',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const why = JSON.parse(result.stdout);
  assert.deepEqual(why.runs.map((run) => run.runId), ['run-why']);
  assert.deepEqual(why.decisions.map((decision) => decision.type), ['gate.what.approved']);
  assert.equal(why.decisions[0].scope_ref, 'gate-b-spec/spec.json');
});

test('iteration init preserves decision-ledger authority and why lineage after moving Gate artifacts', (t) => {
  const { root, artifactRoot } = createFlatProject({ graph: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 명세로 구현해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '기존 Gate A 범위도 원장에 재승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'iteration', 'init', '--artifacts', artifactRoot, '--iteration-id', 'iter-decisions',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Decision ledger rebound: 2 moved Gate approval\(s\)/);

  const movedScopeRef = 'iterations/iter-decisions/gate-b-spec/spec.json';
  const movedSpecPath = join(artifactRoot, movedScopeRef);
  const records = validateDecisionLedger(decisionLedgerPath(artifactRoot));
  assert.deepEqual(records.map((record) => record.type), [
    'gate.what.approved',
    'gate.what.approved',
    'gate.what.approved',
    'gate.what.approved',
  ]);
  assert.equal(records[3].scope_ref, movedScopeRef);
  assert.equal(records[3].sha256, fileSha256(movedSpecPath));
  assert.equal(records[3].prev_seq, records[0].seq);
  assert.deepEqual(
    scopeApprovalState(records, movedScopeRef, fileSha256(movedSpecPath), false),
    { approved: true, source: 'decisions', event: records[3] },
  );

  result = runP2a([
    'runs', 'start', '--artifacts', artifactRoot,
    '--task', 'task-001', '--run-id', 'run-iteration-why',
    '--agent-tool', 'codex', '--workspace-ref', 'main',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'runs', 'record', '--artifacts', artifactRoot,
    '--run-id', 'run-iteration-why', '--changed-file', 'src/cache.ts',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a([
    'decisions', '--artifacts', artifactRoot,
    '--why', 'src/cache.ts', '--json',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const why = JSON.parse(result.stdout);
  assert.deepEqual(why.runs.map((run) => run.runId), ['run-iteration-why']);
  assert.deepEqual(why.decisions.map((decision) => decision.seq), [1, 4]);
  assert.equal(why.decisions.at(-1).scope_ref, movedScopeRef);

  const targetRoot = makeTempDir('p2a-decisions-handoff-target-');
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const movedSpec = JSON.parse(readFileSync(movedSpecPath, 'utf8'));
  movedSpec.approval_audit.approval_note += '\nUnapproved post-decision mutation.';
  writeJson(movedSpecPath, movedSpec);
  result = runHandoff([
    '--project-id', 'cache-library',
    '--artifacts', artifactRoot,
    '--target', targetRoot,
    '--tools', 'none',
    '--dry-run',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /active Gate B approval decision for the current spec bytes: approved_hash_mismatch/,
  );
});

test('iteration init rolls back artifact relocation when decision-ledger rebinding fails', {
  skip: process.platform === 'win32',
}, (t) => {
  const { root, artifactRoot } = createFlatProject({ graph: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '이 명세로 구현해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = runP2a(['decide', '--artifacts', artifactRoot, '--quote', '기존 Gate A 범위도 원장에 재승인해']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const ledgerPath = decisionLedgerPath(artifactRoot);
  const originalLedger = readFileSync(ledgerPath, 'utf8');
  const originalSpec = readFileSync(join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8');
  const originalGraph = readFileSync(join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), 'utf8');
  chmodSync(ledgerPath, 0o444);

  result = runP2a([
    'iteration', 'init', '--artifacts', artifactRoot, '--iteration-id', 'iter-rollback',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EACCES|permission denied/i);
  assert.equal(existsSync(join(artifactRoot, 'iterations')), false);
  assert.equal(existsSync(join(artifactRoot, 'current-spec.json')), false);
  assert.equal(readFileSync(join(artifactRoot, 'gate-b-spec', 'spec.json'), 'utf8'), originalSpec);
  assert.equal(readFileSync(join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), 'utf8'), originalGraph);
  assert.equal(readFileSync(ledgerPath, 'utf8'), originalLedger);
});
