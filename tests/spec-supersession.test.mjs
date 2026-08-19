import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildDeltaSpec } from '../scripts/p2a_iteration.mjs';
import {
  applyBaselineSupersessions,
  baselineSupersessionViolations,
  findSpecCapabilityContradictions,
} from '../scripts/p2a_spec_model.mjs';
import {
  validateSpec,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import { E2E_FIXTURE_ROOT, makeTempDir } from './helpers/fixtures.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function webhookFixture(name) {
  return JSON.parse(readFileSync(
    path.join(E2E_FIXTURE_ROOT, 'webhook-api-service', name),
    'utf8',
  ));
}

function supersessionIntake() {
  return {
    schema_version: 'p2a.intake.v1',
    idea: 'Expand the compiler adapter capability surface.',
    summary: 'Replace the status-only compiler boundary with the approved current scope.',
    known_facts: [],
    assumptions: [],
    clarifying_questions: [
      {
        id: 'CQ-1',
        question: 'Which compiler capabilities are current scope?',
        why_it_matters: 'The answer defines the active capability boundary.',
        blocks: [
          'spec.product.goals',
          'spec.product.success_criteria',
          'spec.implementation.verification',
        ],
        status: 'answered',
        answer: 'Implement compile, status, lint, eval, search, query, and context now.',
      },
    ],
    needs_user_decision: [
      {
        id: 'ND-5',
        question: 'Does the old status-only compiler boundary still apply?',
        options: [
          { id: 'retain', label: 'Retain', description: 'Keep status-only scope.' },
          { id: 'supersede', label: 'Supersede', description: 'Use the current expanded scope.' },
        ],
        impact: 'Controls compiler adapter capability scope.',
        default: 'retain',
        status: 'answered',
        answer: 'Use the current expanded scope.',
        disposition: 'superseded_by_v3_scope',
        current_resolution: 'The compiler adapter now includes compile and retrieval capabilities.',
        affected_fields: [
          'spec.product.goals',
          'spec.product.non_goals',
          'spec.product.constraints',
          'spec.implementation.interfaces',
        ],
        supersedes: [
          {
            field_ref: 'spec.product.non_goals',
            baseline_value: 'Full compile and retrieval/search/query/context capabilities are out of scope.',
          },
          {
            field_ref: 'spec.product.constraints',
            baseline_value: 'The compiler scope is limited to status/change detection only.',
          },
          {
            field_ref: 'spec.implementation.interfaces',
            baseline_value: 'The compiler adapter exposes a status-only interface.',
          },
        ],
      },
    ],
    status: 'ready_for_spec',
    evidence: [],
  };
}

function compilerBaseline() {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.product.non_goals.push(
    'Full compile and retrieval/search/query/context capabilities are out of scope.',
  );
  baseline.product.constraints.push(
    'The compiler scope is limited to status/change detection only.',
  );
  baseline.implementation.interfaces.push(
    'The compiler adapter exposes a status-only interface.',
  );
  return baseline;
}

test('baseline supersession removes matched restrictive items and preserves unrelated baseline scope', () => {
  const baseline = compilerBaseline();
  const intake = supersessionIntake();
  const merge = applyBaselineSupersessions(baseline, intake);

  assert.equal(merge.unresolved.length, 0);
  assert.equal(merge.plans[0].candidates.length, 3);
  assert.deepEqual(
    merge.product.non_goals,
    baseline.product.non_goals.slice(0, -1),
  );
  assert.doesNotMatch(merge.product.constraints.join('\n'), /status\/change detection only/);
  assert.doesNotMatch(merge.implementation.interfaces.join('\n'), /status-only interface/);
  assert.ok(merge.product.goals.includes(baseline.product.goals[0]));
});

test('delta draft applies supersession before routing current Gate A scope', () => {
  const baseline = compilerBaseline();
  const intake = supersessionIntake();
  const spec = buildDeltaSpec({
    projectId: 'compiler-project',
    iterationId: 'iter-003',
    idea: intake.idea,
    baselineSpec: baseline,
    baselineSpecRef: 'iterations/iter-003/baseline/current-spec.json',
    intake,
  });

  assert.doesNotMatch(spec.product.non_goals.join('\n'), /compile and retrieval/);
  assert.doesNotMatch(spec.product.constraints.join('\n'), /status\/change detection only/);
  assert.doesNotMatch(spec.implementation.interfaces.join('\n'), /status-only interface/);
  assert.match(spec.product.goals.join('\n'), /compile, status, lint, eval, search, query, and context/);
  assert.match(spec.implementation.interfaces.join('\n'), /superseded_by_v3_scope/);
  assert.deepEqual(findSpecCapabilityContradictions(spec), []);
});

test('delta draft blocks supersession without exact baseline targets', () => {
  const baseline = compilerBaseline();
  const intake = supersessionIntake();
  delete intake.needs_user_decision[0].supersedes;

  assert.throws(
    () => buildDeltaSpec({
      projectId: 'compiler-project',
      iterationId: 'iter-003',
      idea: intake.idea,
      baselineSpec: baseline,
      baselineSpecRef: 'iterations/iter-003/baseline/current-spec.json',
      intake,
    }),
    (error) => error instanceof ValidationError
      && /baseline supersession merge is unresolved/.test(error.message)
      && /ND-5 superseded_by_v3_scope/.test(error.message)
      && /supersedes\[\]\.field_ref\/baseline_value/.test(error.message),
  );
});

test('supersession invariant reports a retained baseline restriction', () => {
  const baseline = compilerBaseline();
  const intake = supersessionIntake();
  const merge = applyBaselineSupersessions(baseline, intake);
  assert.equal(baselineSupersessionViolations(baseline, intake, baseline).length, 3);
  assert.deepEqual(
    baselineSupersessionViolations(baseline, intake, merge),
    [],
  );
});

test('validator rejects an include/exclude contradiction for the same capability', (t) => {
  const root = makeTempDir('p2a-spec-contradiction-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
  const specPath = path.join(root, 'gate-b-spec', 'spec.json');
  const intake = webhookFixture('gate-a-intake/intake.json');
  const spec = webhookFixture('gate-b-spec/spec.json');
  spec.product.goals.push('Expose compile and retrieval commands.');
  spec.product.non_goals.push('Compile and retrieval commands are out of scope.');
  writeJson(intakePath, intake);
  writeJson(specPath, spec);

  assert.throws(
    () => validateSpec(specPath, intakePath),
    (error) => error instanceof ValidationError
      && /semantic contradiction for capability "compile"/.test(error.message)
      && /product\.goals/.test(error.message)
      && /product\.non_goals/.test(error.message),
  );
});

test('capability contradiction detection preserves narrower scope and mode exclusions', () => {
  const spec = webhookFixture('gate-b-spec/spec.json');
  spec.product.goals = [
    'Expose a project-scoped adapter with compile, search, query, and eval capabilities.',
    'Document compile, search, query, and eval in the public SDK capability matrix.',
  ];
  spec.product.non_goals = [
    'Cross-project compile/search/query/context remains out of scope.',
    'Query save mode and eval history record mode are unsupported; query uses save=false and eval uses record=false.',
    'CLI stdout parsing fallback and a new end-user compiler CLI are excluded.',
    'Do not fork, patch, or deep-import llm-wiki-compiler.',
    'Follow-up retrieval orchestration is deferred.',
  ];
  spec.product.constraints = [
    'Compile roots must not escape the selected project.',
    'Search and query operations are read-only.',
  ];
  spec.implementation.architecture = [];
  spec.implementation.interfaces = [
    'Lint returns bounded findings through a read-only SDK operation.',
  ];

  assert.deepEqual(findSpecCapabilityContradictions(spec), []);
});

test('capability contradiction detection still rejects the same qualified variant', () => {
  const spec = webhookFixture('gate-b-spec/spec.json');
  spec.product.goals = [
    'Expose cross-project compile and search operations.',
    'Support query save mode.',
    'Add retrieval orchestration.',
  ];
  spec.product.non_goals = [
    'Cross-project compile and search operations are out of scope.',
    'Query save mode is unsupported.',
    'Retrieval orchestration is deferred.',
  ];
  spec.product.constraints = [];
  spec.implementation.architecture = [];
  spec.implementation.interfaces = [];

  assert.deepEqual(
    [...new Set(findSpecCapabilityContradictions(spec)
      .map((contradiction) => contradiction.capability))],
    ['compile', 'search', 'query', 'retrieval'],
  );
});

test('validator binds supersession to the immutable baseline and accepts the corrected draft', (t) => {
  const root = makeTempDir('p2a-baseline-supersession-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baselineIntakePath = path.join(
    root,
    'iterations/iter-001/gate-a-intake/intake.json',
  );
  const baselineSpecPath = path.join(
    root,
    'iterations/iter-001/gate-b-spec/spec.json',
  );
  const currentIntakePath = path.join(
    root,
    'iterations/iter-002/gate-a-intake/intake.json',
  );
  const currentSpecPath = path.join(
    root,
    'iterations/iter-002/gate-b-spec/spec.json',
  );
  const baseline = compilerBaseline();
  const baselineIntake = webhookFixture('gate-a-intake/intake.json');
  const currentIntake = supersessionIntake();
  currentIntake.baseline_context = {
    spec_ref: 'iterations/iter-001/gate-b-spec/spec.json',
    reused_answers: [],
    reused_question_dispositions: [],
  };
  currentIntake.approval_audit = {
    approved_by: 'user',
    approved_at: '2026-08-19',
    approved_artifacts: [
      'iterations/iter-002/gate-a-intake/intake.json',
    ],
    approval_note: 'User quote: "Approve the compiler scope supersession."',
  };
  const retainedDraft = clone(baseline);
  retainedDraft.source_intake = '../gate-a-intake/intake.json';
  retainedDraft.approval = 'draft';
  delete retainedDraft.approval_audit;
  retainedDraft.clarifying_question_disposition = [{
    id: 'CQ-1',
    status: 'answered',
    rationale: 'The current Gate A answer defines the expanded compiler surface.',
    affects: currentIntake.clarifying_questions[0].blocks,
    resolved_by: currentIntake.clarifying_questions[0].answer,
  }];
  writeJson(baselineIntakePath, baselineIntake);
  writeJson(baselineSpecPath, baseline);
  writeJson(currentIntakePath, currentIntake);
  writeJson(currentSpecPath, retainedDraft);

  assert.throws(
    () => validateSpec(currentSpecPath, currentIntakePath, { artifactRoot: root }),
    (error) => error instanceof ValidationError
      && /baseline supersession ND-5 is not applied/.test(error.message)
      && /product\.non_goals/.test(error.message)
      && /iterations\/iter-001\/gate-b-spec\/spec\.json/.test(error.message),
  );

  const correctedDraft = buildDeltaSpec({
    projectId: baseline.project_id,
    iterationId: 'iter-002',
    idea: currentIntake.idea,
    baselineSpec: baseline,
    baselineSpecRef: currentIntake.baseline_context.spec_ref,
    intake: currentIntake,
  });
  writeJson(currentSpecPath, correctedDraft);
  assert.doesNotThrow(
    () => validateSpec(currentSpecPath, currentIntakePath, { artifactRoot: root }),
  );
});
