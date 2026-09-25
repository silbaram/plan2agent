import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureKnowledge, MAX_KNOWLEDGE_HANDOFF_BYTES } from '../scripts/p2a_knowledge_handoff.mjs';
import { MONITOR_GATE_POLICY, monitorGateContractSha256, monitorVerdictEvidenceSha256, normalizeMonitorGateSidecar } from '../scripts/p2a_monitor_gate.mjs';
import {
  ROOT,
  runExecute as executeFixture,
  runIteration as iterationFixture,
  runRuns as runsFixture,
} from './helpers/fixtures.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sha = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
function ok(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }

function inFixture(runner, args) {
  const index = args.indexOf('--artifacts');
  assert.notEqual(index, -1, 'capture tests must explicitly bind every lifecycle command to temporary artifacts');
  const artifactRoot = args[index + 1];
  const projectRoot = path.resolve(artifactRoot, '..', '..', '..');
  assert.equal(path.dirname(projectRoot), tmpdir());
  assert.match(path.basename(projectRoot), /^p2a-knowledge-capture-/);
  // CLI cwd influences config fallback and default workspaces in addition to
  // --artifacts. Keep every aspect of test execution out of the toolkit checkout.
  return runner(args, { cwd: projectRoot });
}
const runExecute = (args) => inFixture(executeFixture, args);
const runIteration = (args) => inFixture(iterationFixture, args);
const runRuns = (args) => inFixture(runsFixture, args);

function addReferenceBundle(artifactRoot) {
  const intakePath = path.join(artifactRoot, 'gate-a-intake', 'intake.json');
  const specPath = path.join(artifactRoot, 'gate-b-spec', 'spec.json');
  const snapshotPath = path.join(artifactRoot, 'gate-a-intake', 'reference-bundle-snapshot.json');
  const usagePath = path.join(artifactRoot, 'gate-b-spec', 'reference-bundle-usage.json');
  const files = path.join(artifactRoot, 'gate-a-intake', 'reference-sources', 'files');
  mkdirSync(files, { recursive: true });
  const entry = path.join(files, 'idea.md');
  const reference = path.join(files, 'prototype.html');
  const bundle = path.join(files, 'p2a-reference-bundle.json');
  writeFileSync(entry, 'Build the approved webhook service.\n');
  writeFileSync(reference, '<!doctype html><title>Webhook prototype</title>\n');
  writeJson(bundle, { schema_version: 'p2a.reference_bundle.v1', entry: 'idea.md', references: [{
    id: 'REF-1', path: 'prototype.html', kind: 'html', sha256: sha(readFileSync(reference)).slice(7),
    load_when: 'Gate B needs the approved prototype.', description: 'Approved prototype metadata.',
  }] });
  const snapshot = {
    schema_version: 'p2a.reference_bundle_snapshot.v1',
    source_bundle_ref: 'reference-sources/files/p2a-reference-bundle.json',
    source_bundle_sha256: sha(readFileSync(bundle)).slice(7),
    entry_ref: 'reference-sources/files/idea.md', entry_sha256: sha(readFileSync(entry)).slice(7),
    references: [{ id: 'REF-1', path: 'reference-sources/files/prototype.html', kind: 'html',
      sha256: sha(readFileSync(reference)).slice(7),
      load_when: 'Gate B needs the approved prototype.', description: 'Approved prototype metadata.' }],
  };
  writeJson(snapshotPath, snapshot);
  const intake = readJson(intakePath);
  intake.approval_audit.approved_artifacts.push('gate-a-intake/reference-bundle-snapshot.json');
  intake.approval_audit.approval_note += `\nSidecar SHA-256: gate-a-intake/reference-bundle-snapshot.json ${sha(readFileSync(snapshotPath)).slice(7)}`;
  writeJson(intakePath, intake);
  writeJson(usagePath, { schema_version: 'p2a.reference_bundle_usage.v1',
    source_snapshot_ref: '../gate-a-intake/reference-bundle-snapshot.json',
    source_snapshot_sha256: sha(readFileSync(snapshotPath)).slice(7),
    source_bundle_ref: snapshot.source_bundle_ref,
    source_bundle_sha256: snapshot.source_bundle_sha256, inspected_references: [] });
  const spec = readJson(specPath);
  spec.approval_audit.approved_artifacts.push('gate-b-spec/reference-bundle-usage.json');
  spec.approval_audit.approval_note += `\nSidecar SHA-256: gate-b-spec/reference-bundle-usage.json ${sha(readFileSync(usagePath)).slice(7)}`;
  writeJson(specPath, spec);
}

function fixture(t, { closed = true, maintenance = false, referenceBundle = false } = {}) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'p2a-knowledge-capture-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service'), artifactRoot, { recursive: true });
  if (referenceBundle) addReferenceBundle(artifactRoot);
  writeJson(path.join(projectRoot, '.plan2agent', 'project.config.json'), {
    runTracking: { persistence: 'persistent' }, devExecution: { reviewPasses: { acceptance: 'off' } },
  });
  ok(runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'v1-mvp']));
  const graphPath = path.join(artifactRoot, 'iterations', 'v1-mvp', 'gate-c-task-graph', 'task-graph.json');
  const graph = readJson(graphPath);
  if (closed && !maintenance) {
    for (const task of graph.tasks) task.status = 'done';
    writeJson(graphPath, graph);
    ok(runExecute(['verify-final', '--artifacts', artifactRoot, '--task', graph.tasks[0].id, '--run-id', 'run-capture-final', '--agent-tool', 'manual']));
    ok(runRuns(['verify', '--artifacts', artifactRoot, '--run-id', 'run-capture-final', '--test-command', 'node -e "console.log(123)"']));
    ok(runExecute(['finish', '--artifacts', artifactRoot, '--run-id', 'run-capture-final']));
    ok(runIteration(['close', '--artifacts', artifactRoot]));
  }
  let maintenanceGraphPath;
  if (maintenance) {
    for (const title of ['selected fix', 'unrelated work']) {
      ok(runIteration(['maintenance', 'add', '--artifacts', artifactRoot, '--title', title, '--accept', `${title} is complete`]));
    }
    maintenanceGraphPath = path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
    const tasks = readJson(maintenanceGraphPath).tasks;
    ok(runExecute(['start', '--artifacts', artifactRoot, '--maintenance', '--task', tasks[0].id, '--run-id', 'run-capture-maintenance', '--agent-tool', 'manual', '--workspace', projectRoot]));
    ok(runRuns(['verify', '--artifacts', artifactRoot, '--maintenance', '--run-id', 'run-capture-maintenance', '--test-command', 'node -e "console.log(123)"']));
    ok(runExecute(['finish', '--artifacts', artifactRoot, '--maintenance', '--run-id', 'run-capture-maintenance']));
  }
  return { projectRoot, artifactRoot, graphPath, maintenanceGraphPath,
    options: { artifacts: artifactRoot, target: projectRoot, ...(maintenance ? { task: 'task-001' } : { iteration: 'v1-mvp' }) } };
}

test('closed feature capture is frozen, bounded, deterministic and pending, never approval or cleanup', (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.artifactRoot, 'current-spec.json'), 'utf8');
  const receipt = captureKnowledge(f.options);
  assert.equal(receipt.storage, 'pending');
  for (const key of ['sanitized', 'durable', 'wikiApproved', 'cleanupEligible']) assert.equal(receipt[key], false);
  const file = path.join(f.projectRoot, receipt.bundlePath);
  assert.equal(lstatSync(file).mode & 0o777, 0o600, 'pending raw evidence is private from publication');
  const body = readFileSync(file, 'utf8');
  const bundle = JSON.parse(body);
  assert.equal(receipt.inputDigest, sha(body));
  assert.equal(bundle.workId, 'v1-mvp');
  assert.equal(bundle.baseline.format, 'p2a.current_development_contract.v1');
  assert.equal(bundle.repository.codeRevision, null, 'an observed head must never be invented');
  assert.match(bundle.repository.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(bundle.baseline.sourceDigest, sha(bundle.baseline.body));
  for (const source of bundle.sources) {
    assert.equal(source.sourceDigest, sha(source.body));
    assert.equal(path.isAbsolute(source.ref), false);
  }
  assert.deepEqual(bundle.knowledge.decisions, []);
  const second = captureKnowledge(f.options);
  assert.equal(second.reused, true);
  assert.equal(second.inputDigest, receipt.inputDigest);
  assert.deepEqual(readdirSync(path.dirname(file)).sort(), ['.gitignore', path.basename(file)].sort());
  assert.equal(readFileSync(path.join(path.dirname(file), '.gitignore'), 'utf8'), '*\n');
  ok(spawnSync('git', ['init', '--quiet', f.projectRoot], { cwd: f.projectRoot, encoding: 'utf8' }));
  ok(spawnSync('git', ['check-ignore', '--no-index', receipt.bundlePath], { cwd: f.projectRoot, encoding: 'utf8' }));
  writeJson(f.graphPath, { altered: true });
  assert.equal(readFileSync(file, 'utf8'), body, 'source mutations cannot rewrite the frozen bundle');
  assert.equal(readFileSync(path.join(f.artifactRoot, 'current-spec.json'), 'utf8'), before);
});

test('capture refuses active feature and does not create pending bundles or close work', (t) => {
  const f = fixture(t, { closed: false });
  const before = readFileSync(path.join(f.artifactRoot, 'current-spec.json'), 'utf8');
  assert.throws(() => captureKnowledge(f.options), /closed iteration/);
  assert.equal(existsSync(path.join(f.artifactRoot, 'handoffs')), false);
  assert.equal(readFileSync(path.join(f.artifactRoot, 'current-spec.json'), 'utf8'), before);
});

test('missing selected evidence fails without changing done status and retry succeeds after restore', (t) => {
  const f = fixture(t);
  const index = readJson(path.join(f.artifactRoot, 'runs', 'run-index.json'));
  const runPath = path.join(f.artifactRoot, 'runs', index.runs[0].runRef);
  const body = readFileSync(runPath, 'utf8');
  const graphBefore = readFileSync(f.graphPath, 'utf8');
  rmSync(runPath);
  assert.throws(() => captureKnowledge(f.options), /ENOENT/);
  assert.equal(existsSync(path.join(f.artifactRoot, 'handoffs')), false);
  assert.equal(readFileSync(f.graphPath, 'utf8'), graphBefore);
  writeFileSync(runPath, body);
  assert.equal(captureKnowledge(f.options).storage, 'pending');
});

test('done maintenance captures immutable selected task and intent without importing unrelated tasks', (t) => {
  const f = fixture(t, { maintenance: true });
  const first = captureKnowledge(f.options);
  const bundle = readJson(path.join(f.projectRoot, first.bundlePath));
  assert.equal(bundle.workKind, 'maintenance');
  assert.equal(bundle.baseline.format, 'p2a.maintenance_completion.v1');
  const baseline = JSON.parse(bundle.baseline.body);
  assert.equal(baseline.taskContract.title, 'selected fix');
  assert.equal(baseline.taskContract.status, undefined);
  assert.equal(bundle.sources.some((source) => source.ref.endsWith('current-development-contract.json')), false);
  const graph = readJson(f.maintenanceGraphPath);
  graph.tasks[1].title = 'unrelated changed task';
  writeJson(f.maintenanceGraphPath, graph);
  assert.equal(captureKnowledge(f.options).inputDigest, first.inputDigest);
  assert.equal(readJson(f.maintenanceGraphPath).tasks[1].status, 'todo');
  assert.throws(() => captureKnowledge({ ...f.options, task: 'task-002' }), /done maintenance/);
});

test('capture rejects symlinks, traversal, cross-project evidence and size overflow', (t) => {
  const f = fixture(t);
  assert.throws(() => captureKnowledge({ ...f.options, iteration: '../v1-mvp' }), /iteration id/);
  assert.throws(() => captureKnowledge({ ...f.options, target: path.join(f.projectRoot, 'elsewhere') }), /escapes the project/);
  const indexPath = path.join(f.artifactRoot, 'runs', 'run-index.json');
  const originalIndex = readFileSync(indexPath, 'utf8');
  const index = JSON.parse(originalIndex);
  const originalRef = index.runs[0].runRef;
  index.runs[0].runRef = '../other.json';
  writeJson(indexPath, index);
  assert.throws(() => captureKnowledge(f.options), /safe artifact-relative|runRef/);
  writeFileSync(indexPath, originalIndex);
  const runPath = path.join(f.artifactRoot, 'runs', originalRef);
  const body = readFileSync(runPath, 'utf8');
  const external = path.join(f.projectRoot, 'external.json');
  writeFileSync(external, body);
  rmSync(runPath);
  symlinkSync(external, runPath);
  assert.throws(() => captureKnowledge(f.options), /symbolic links/);
  rmSync(runPath);
  writeFileSync(runPath, body);
  rmSync(external);
  assert.throws(() => captureKnowledge({ ...f.options, summary: 'x'.repeat(MAX_KNOWLEDGE_HANDOFF_BYTES) }), /exceeds (1 MiB|65536 characters)/);
  assert.throws(() => captureKnowledge({ ...f.options, summary: 'x'.repeat(65537) }), /exceeds 65536 characters/);
  assert.equal(existsSync(path.join(f.artifactRoot, 'handoffs')), false);
});

test('capture rejects post-close contract and archive drift without overwriting pending evidence', (t) => {
  const f = fixture(t);
  const receipt = captureKnowledge(f.options);
  const file = path.join(f.projectRoot, receipt.bundlePath);
  const frozen = readFileSync(file, 'utf8');
  const specPath = path.join(f.artifactRoot, 'iterations', 'v1-mvp', 'gate-b-spec', 'spec.json');
  writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}\n`);
  assert.throws(() => captureKnowledge(f.options), /changed after close/);
  assert.equal(readFileSync(file, 'utf8'), frozen);
});

test('approved reference files and sidecars survive capture; missing sources prevent recapture', (t) => {
  const f = fixture(t, { referenceBundle: true });
  const receipt = captureKnowledge(f.options);
  const bundle = readJson(path.join(f.projectRoot, receipt.bundlePath));
  const refs = bundle.sources.map((source) => source.ref);
  for (const suffix of [
    'gate-a-intake/reference-bundle-snapshot.json',
    'gate-b-spec/reference-bundle-usage.json',
    'gate-a-intake/reference-sources/files/p2a-reference-bundle.json',
    'gate-a-intake/reference-sources/files/idea.md',
    'gate-a-intake/reference-sources/files/prototype.html',
  ]) assert.equal(refs.some((ref) => ref.endsWith(suffix)), true, suffix);
  const frozen = readFileSync(path.join(f.projectRoot, receipt.bundlePath), 'utf8');
  rmSync(path.join(f.artifactRoot, 'iterations', 'v1-mvp', 'gate-a-intake', 'reference-bundle-snapshot.json'));
  assert.throws(() => captureKnowledge(f.options), /reference-bundle-snapshot|reference bundle snapshot/);
  assert.equal(readFileSync(path.join(f.projectRoot, receipt.bundlePath), 'utf8'), frozen);
});

test('capture never promotes observed HEAD or workspace-only hashes into verified product identity', (t) => {
  const f = fixture(t);
  const index = readJson(path.join(f.artifactRoot, 'runs', 'run-index.json'));
  const runPath = path.join(f.artifactRoot, 'runs', index.runs[0].runRef);
  const run = readJson(runPath);
  run.git = { headSha: 'a'.repeat(40), branch: 'observed', dirty: true };
  for (const item of run.verification) { delete item.gitHeadSha; delete item.productRevisionSha256; }
  writeJson(runPath, run);
  const receipt = captureKnowledge(f.options);
  const bundle = readJson(path.join(f.projectRoot, receipt.bundlePath));
  assert.equal(bundle.repository.codeRevision, null);
  assert.equal(bundle.repository.contentDigest, null);
  assert.equal(bundle.sources.some((item) => item.role === 'verification' && item.body.includes('workspaceRevisionSha256')), true);
});

test('capture requires newest final run contract binding and sealed monitor evidence', (t) => {
  const f = fixture(t);
  const index = readJson(path.join(f.artifactRoot, 'runs', 'run-index.json'));
  const runPath = path.join(f.artifactRoot, 'runs', index.runs[0].runRef);
  const body = readFileSync(runPath, 'utf8');
  const run = JSON.parse(body);
  const gate = normalizeMonitorGateSidecar({ required: true }, run.runId, index.runs[0].runRef);
  const verdict = '"confirm_done"\n';
  run.monitorGate = { required: true, policy: MONITOR_GATE_POLICY, contractSha256: monitorGateContractSha256(gate) };
  run.monitorVerdictEvidenceSha256 = monitorVerdictEvidenceSha256(verdict);
  writeJson(runPath, run);
  writeJson(runPath.replace(/\.json$/, '.monitor-gate.json'), gate);
  const verdictPath = runPath.replace(/\.json$/, '.monitor-verdict.json');
  assert.throws(() => captureKnowledge(f.options), /required monitor verdict is missing/);
  writeFileSync(verdictPath, verdict);
  run.currentDevelopmentContractSha256 = 'f'.repeat(64);
  writeJson(runPath, run);
  assert.throws(() => captureKnowledge(f.options), /current development contract changed|execution envelope|binding/);
  writeFileSync(runPath, body);
  assert.equal(captureKnowledge(f.options).storage, 'pending');
});

test('CLI capture diagnostics never echo malformed JSON body or leak it in receipts', (t) => {
  const f = fixture(t, { closed: false });
  const pointerPath = path.join(f.artifactRoot, 'current-spec.json');
  writeFileSync(pointerPath, '{"secret":"sensitive-capture-test-value" broken');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'p2a_knowledge_handoff.mjs'),
    'capture', '--artifacts', f.artifactRoot, '--iteration', 'v1-mvp', '--json'], { cwd: f.projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid JSON|contents omitted/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('sensitive-capture-test-value'), false);
});

for (const changedFile of ['src/feature.js', 'docs/guide.md']) {
  test(`closed work can capture reused implementation verification for ${changedFile}`, (t) => {
    const f = fixture(t, { closed: false });
    const graph = readJson(f.graphPath);
    graph.tasks.forEach((task, index) => { task.status = index === 0 ? 'todo' : 'done'; });
    writeJson(f.graphPath, graph);
    const file = path.join(f.projectRoot, changedFile);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'before\n');
    const configPath = path.join(f.projectRoot, '.plan2agent', 'project.config.json');
    writeJson(configPath, { ...readJson(configPath),
      testCommand: 'node -e "process.exit(0)"',
      relatedVerification: [{ type: 'test', argv: [process.execPath, '-e', 'process.exit(0)'], appendChangedFiles: true }],
    });
    const runId = 'run-capture-implementation';
    ok(runExecute(['start', '--artifacts', f.artifactRoot, '--task', graph.tasks[0].id, '--run-id', runId, '--agent-tool', 'manual', '--workspace', f.projectRoot]));
    writeFileSync(file, 'after\n');
    ok(runRuns(['verify', '--artifacts', f.artifactRoot, '--run-id', runId, '--changed-file', changedFile,
      ...(changedFile.startsWith('docs/') ? ['--related'] : ['--test-command', 'node -e "process.exit(0)"'])]));
    ok(runExecute(['finish', '--artifacts', f.artifactRoot, '--run-id', runId, '--changed-file', changedFile]));
    ok(runIteration(['close', '--artifacts', f.artifactRoot]));
    const index = readJson(path.join(f.artifactRoot, 'runs', 'run-index.json'));
    assert.equal(index.runs.every((entry) => !entry.runKind), true);
    assert.equal(captureKnowledge(f.options).storage, 'pending');
  });
}
