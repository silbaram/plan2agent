import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  E2E_FIXTURE_ROOT,
  ROOT,
  makeTempDir,
  runHandoff,
  runIteration,
  runValidator,
} from './helpers/fixtures.mjs';
import { validateIntake } from '../scripts/validate_artifacts.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureIntake() {
  return JSON.parse(readFileSync(
    path.join(E2E_FIXTURE_ROOT, 'webhook-api-service', 'gate-a-intake', 'intake.json'),
    'utf8',
  ));
}

test('harness keeps the complete entry confirmation contract', () => {
  const skillPath = path.join(ROOT, '.agents', 'skills', 'p2a-harness', 'SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');

  assert.match(skill, /## Entry Document Confirmation Dialogue/);
  assert.match(skill, /legacy fields/);
  assert.match(skill, /There is no fixed question count or conversation-turn limit/);
  assert.match(skill, /every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition/);
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 18 * 1024);
  assert.ok(Buffer.byteLength(
    readFileSync(path.join(ROOT, 'schemas', 'intake.schema.json')),
  ) <= 8 * 1024);
});

test('approved Gate B routes through adaptive execution readiness instead of unconditional task decomposition', () => {
  const skillPaths = [
    path.join(ROOT, '.agents', 'skills', 'p2a-harness', 'SKILL.md'),
    path.join(ROOT, '.claude', 'skills', 'p2a-harness', 'SKILL.md'),
  ];

  for (const skillPath of skillPaths) {
    const skill = readFileSync(skillPath, 'utf8');
    assert.match(skill, /Approved Gate B without Gate C is a valid preparation state/);
    assert.match(skill, /run `p2a next --json --contract v2` and follow its one action/);
    assert.match(skill, /only Orchestrated execution routes to task decomposition/);
    assert.doesNotMatch(skill, /Development execution begins only after the canonical task graph validates/);
  }

  const geminiHarness = readFileSync(
    path.join(ROOT, '.gemini', 'commands', 'p2a', 'harness.toml'),
    'utf8',
  );
  assert.match(geminiHarness, /Gemini is read-only/);
  assert.match(geminiHarness, /do not persist Gate artifacts/);
  assert.doesNotMatch(geminiHarness, /do not create a task graph unconditionally/);
  assert.doesNotMatch(geminiHarness, /Stop before task graph unless/);

  const englishReadme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const koreanReadme = readFileSync(path.join(ROOT, 'README.ko-KR.md'), 'utf8');
  const quickstart = readFileSync(path.join(ROOT, 'docs', 'quickstart.md'), 'utf8');
  assert.match(englishReadme, /Direct run, Planned checkpoints, or dependency-aware Orchestrated tasks/);
  assert.match(koreanReadme, /Direct run, Planned checkpoint.*Orchestrated task/);
  assert.match(quickstart, /Direct\/Planned.*Orchestrated/s);
});

test('legacy interview data is accepted as opaque compatibility content', (t) => {
  const root = makeTempDir('p2a-legacy-intake-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
  const intake = fixtureIntake();
  intake.interview = {
    state: 'retired-state-name',
    arbitrary_nested_payload: { values: [1, 2, 3] },
  };
  writeJson(intakePath, intake);

  const validated = validateIntake(intakePath, { artifactRoot: root });
  assert.equal(validated.status, 'ready_for_spec');
  assert.deepEqual(validated.interview, intake.interview);
});

test('iterative handoff preserves arbitrary legacy interview content unchanged', (t) => {
  const root = makeTempDir('p2a-legacy-handoff-');
  const artifacts = path.join(root, 'artifacts');
  const target = path.join(root, 'target');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifacts, { recursive: true });

  const initialized = runIteration([
    'init',
    '--artifacts',
    artifacts,
    '--iteration-id',
    'v1-mvp',
  ]);
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

  const intakePath = path.join(
    artifacts,
    'iterations',
    'v1-mvp',
    'gate-a-intake',
    'intake.json',
  );
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  intake.interview = {
    seed_iteration_id: 'retired-iteration-name',
    arbitrary_nested_payload: { values: [1, 2, 3] },
  };
  writeJson(intakePath, intake);

  const handoff = runHandoff([
    '--project-id',
    'webhook-api-service',
    '--artifacts',
    artifacts,
    '--target',
    target,
  ]);
  assert.equal(handoff.status, 0, `${handoff.stdout}\n${handoff.stderr}`);

  const targetIntake = JSON.parse(readFileSync(path.join(
    target,
    '.plan2agent',
    'artifacts',
    'webhook-api-service',
    'gate-a-intake',
    'intake.json',
  ), 'utf8'));
  assert.deepEqual(targetIntake.interview, intake.interview);
});

test('Gate C promotion help exposes validator promotion without approval flags', () => {
  const result = runIteration(['promote-tasks', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /promote-tasks --artifacts/);
  assert.doesNotMatch(result.stdout, /--approved-by|--approval-note|Gate C approval audit/);
});

test('handoff accepts a validated Gate A-C artifact root without Gate D', (t) => {
  const root = makeTempDir('p2a-gate-d-free-');
  const artifacts = path.join(root, 'artifacts');
  const target = path.join(root, 'target');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifacts, { recursive: true });
  rmSync(path.join(artifacts, 'gate-d-review'), { recursive: true, force: true });

  const validation = runValidator(['--artifact-root', artifacts, '--require-handoff-ready']);
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);

  const handoff = runHandoff([
    '--project-id',
    'webhook-api-service',
    '--artifacts',
    artifacts,
    '--target',
    target,
    '--dry-run',
  ]);
  assert.equal(handoff.status, 0, `${handoff.stdout}\n${handoff.stderr}`);
  assert.doesNotMatch(handoff.stdout, /gate-d-review|review\.json/);
});

test('artifact-root validation ignores a stale legacy Gate D file', (t) => {
  const root = makeTempDir('p2a-legacy-gate-d-');
  const artifacts = path.join(root, 'artifacts');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifacts, { recursive: true });
  writeFileSync(
    path.join(artifacts, 'gate-d-review', 'review.json'),
    '{ this is intentionally invalid legacy JSON\n',
    'utf8',
  );

  const validation = runValidator(['--artifact-root', artifacts, '--require-handoff-ready']);
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
});
