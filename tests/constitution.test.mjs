import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  validateConstitutionData,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import { FIXTURE_ROOT, makeTempDir, runHandoff, runP2a } from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function constitution(overrides = {}) {
  return {
    schema_version: 'p2a.constitution.v1',
    projectId: 'cache-library',
    architecture: [
      {
        id: 'ARCH-1',
        rule: 'Keep the package dependency-free.',
        rationale: 'The library must remain portable.',
        scope: 'runtime',
      },
    ],
    stack: [
      {
        id: 'STACK-1',
        choice: 'Node.js 20+',
        rationale: 'The package uses the Node.js standard library.',
        evidence: ['LOCAL-1'],
      },
    ],
    prohibitions: [],
    style: { naming: ['Use descriptive camelCase names.'] },
    ...overrides,
  };
}

function approvalAudit(note = 'User quote: "승인합니다"') {
  return {
    approved_by: 'user',
    approved_at: '2026-08-04',
    approved_artifacts: ['.plan2agent/constitution.json'],
    approval_note: note,
  };
}

test('constitution defaults omitted prohibition enforcement to advisory behavior', () => {
  const data = constitution({
    prohibitions: [
      {
        id: 'NO-1',
        rule: 'Avoid speculative dependencies.',
        rationale: 'Keep the project small.',
      },
    ],
  });
  assert.equal(validateConstitutionData(data), data);
});

test('constitution approval audit requires a verbatim quoted user utterance', () => {
  assert.throws(
    () => validateConstitutionData(constitution({ approval_audit: approvalAudit('User approved.') })),
    (error) => error instanceof ValidationError && /quotation marks/.test(error.message),
  );
  assert.doesNotThrow(() => validateConstitutionData(
    constitution({ approval_audit: approvalAudit() }),
    { requireApproved: true },
  ));
});

test('validator-enforced constitution prohibitions reject matching specification values', (t) => {
  const root = makeTempDir('p2a-constitution-validator-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intakePath = join(root, '.plan2agent', 'artifacts', 'cache-library', 'gate-a-intake', 'intake.json');
  const specPath = join(root, '.plan2agent', 'artifacts', 'cache-library', 'gate-b-spec', 'spec.json');
  const constitutionPath = join(root, '.plan2agent', 'constitution.json');
  const intake = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'), 'utf8'));
  spec.source_intake = '../gate-a-intake/intake.json';
  spec.implementation.dependencies.push('forbidden-orm');
  writeJson(intakePath, intake);
  writeJson(specPath, spec);
  writeJson(constitutionPath, constitution({
    approval_audit: approvalAudit(),
    prohibitions: [
      {
        id: 'NO-1',
        rule: 'Do not introduce the forbidden ORM.',
        rationale: 'The library remains dependency-free.',
        enforcement: 'validator',
        targets: ['spec'],
        forbidden_terms: ['forbidden-orm'],
      },
    ],
  }));

  assert.throws(
    () => validateSpec(specPath, intakePath),
    (error) => error instanceof ValidationError
      && /constitution prohibition NO-1/.test(error.message)
      && /forbidden-orm/.test(error.message),
  );

  spec.implementation.dependencies = spec.implementation.dependencies.filter(
    (dependency) => dependency !== 'forbidden-orm',
  );
  spec.product.constraints.push('No forbidden-orm dependency');
  spec.approval_audit.approval_note = 'User quote: "Proceed without forbidden-orm"';
  writeJson(specPath, spec);
  assert.doesNotThrow(() => validateSpec(specPath, intakePath));
});

test('validator-enforced task graph prohibitions allow removal work but reject introduction work', (t) => {
  const root = makeTempDir('p2a-constitution-task-validator-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'cache-library');
  const intakePath = join(artifactRoot, 'gate-a-intake', 'intake.json');
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  const graphPath = join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  const constitutionPath = join(root, '.plan2agent', 'constitution.json');
  const intake = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'), 'utf8'));
  const graph = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'task-graph.json'), 'utf8'));
  spec.source_intake = '../gate-a-intake/intake.json';
  graph.sourceSpec = '../gate-b-spec/spec.json';
  graph.tasks[0].description = 'Remove forbidden-orm from the package.';
  writeJson(intakePath, intake);
  writeJson(specPath, spec);
  writeJson(graphPath, graph);
  writeJson(constitutionPath, constitution({
    approval_audit: approvalAudit(),
    prohibitions: [
      {
        id: 'NO-1',
        rule: 'Do not introduce the forbidden ORM.',
        rationale: 'The library remains dependency-free.',
        enforcement: 'validator',
        targets: ['task_graph'],
        forbidden_terms: ['forbidden-orm'],
      },
    ],
  }));

  assert.doesNotThrow(() => validateTaskGraph(graphPath, specPath));
  graph.tasks[0].description = 'forbidden-orm 사용 금지.';
  writeJson(graphPath, graph);
  assert.doesNotThrow(() => validateTaskGraph(graphPath, specPath));
  graph.tasks[0].description = 'forbidden-orm must not be used.';
  writeJson(graphPath, graph);
  assert.doesNotThrow(() => validateTaskGraph(graphPath, specPath));
  graph.tasks[0].description = 'Introduce forbidden-orm into the package.';
  writeJson(graphPath, graph);
  assert.throws(
    () => validateTaskGraph(graphPath, specPath),
    (error) => error instanceof ValidationError
      && /constitution prohibition NO-1/.test(error.message),
  );
});

test('shape approve rejects a missing quote and records a quoted approval', (t) => {
  const root = makeTempDir('p2a-shape-approve-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(join(root, '.plan2agent', 'constitution.json'), constitution());

  const missing = runP2a(['shape', 'approve', '--target', root]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires --quote/);

  const approved = runP2a([
    'shape', 'approve', '--target', root, '--quote', '이 구성으로 진행해',
  ]);
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  const result = runP2a(['shape', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'approved');
  assert.equal(status.approved, true);
  const saved = JSON.parse(readFileSync(join(root, '.plan2agent', 'constitution.json'), 'utf8'));
  assert.match(saved.approval_audit.approval_note, /"이 구성으로 진행해"/);
});

test('shape migrate-style creates an unapproved constitution draft', (t) => {
  const root = makeTempDir('p2a-shape-migrate-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.plan2agent'), { recursive: true });
  writeFileSync(join(root, '.plan2agent', 'style.md'), '# Style\n\nPrefer small functions.\n', 'utf8');
  writeJson(join(root, '.plan2agent', 'project.config.json'), { projectId: 'legacy-project' });
  writeJson(join(root, '.plan2agent', 'manifest.json'), { projectId: 'stale-manifest-id' });

  const migrated = runP2a([
    'shape', 'migrate-style', '--target', root,
  ]);
  assert.equal(migrated.status, 0, `${migrated.stdout}${migrated.stderr}`);
  const result = runP2a(['shape', '--target', root, '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'draft');
  assert.equal(status.projectId, 'legacy-project');
  const saved = JSON.parse(readFileSync(join(root, '.plan2agent', 'constitution.json'), 'utf8'));
  assert.match(saved.style.contract_markdown, /Prefer small functions/);
  assert.equal('approval_audit' in saved, false);
});

test('handoff carries an approved constitution into the implementation project', (t) => {
  const sourceRoot = makeTempDir('p2a-constitution-handoff-source-');
  const targetRoot = makeTempDir('p2a-constitution-handoff-target-');
  t.after(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  });
  const artifactRoot = join(sourceRoot, '.plan2agent', 'artifacts', 'cache-library');
  const intake = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'), 'utf8'));
  const spec = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'), 'utf8'));
  const graph = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'cache-library', 'task-graph.json'), 'utf8'));
  intake.approval_audit.approved_artifacts = ['gate-a-intake/intake.json'];
  spec.source_intake = '../gate-a-intake/intake.json';
  spec.approval_audit.approved_artifacts = ['gate-b-spec/spec.json'];
  graph.sourceSpec = '../gate-b-spec/spec.json';
  writeJson(join(artifactRoot, 'gate-a-intake', 'intake.json'), intake);
  writeJson(join(artifactRoot, 'gate-b-spec', 'spec.json'), spec);
  writeJson(join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), graph);
  writeFileSync(join(artifactRoot, 'status.md'), '# Cache Library\n', 'utf8');
  writeJson(join(sourceRoot, '.plan2agent', 'constitution.json'), constitution({
    approval_audit: approvalAudit(),
  }));

  const result = runHandoff([
    '--project-id', 'cache-library',
    '--artifacts', artifactRoot,
    '--target', targetRoot,
    '--tools', 'none',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const copied = JSON.parse(readFileSync(join(targetRoot, '.plan2agent', 'constitution.json'), 'utf8'));
  assert.equal(copied.projectId, 'cache-library');
  assert.equal(copied.approval_audit.approved_by, 'user');
  const manifest = JSON.parse(readFileSync(join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
  assert.equal(manifest.constitutionFile, '.plan2agent/constitution.json');
});
