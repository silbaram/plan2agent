import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildDeltaSpec } from '../scripts/p2a_iteration.mjs';
import {
  applyBaselineSupersessions,
  baselineSupersessionViolations,
  findSpecCapabilityContradictions,
  fullSpecTaskRefs,
} from '../scripts/p2a_spec_model.mjs';
import {
  validateIntake,
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

test('a non-visual delta preserves the existing visual contract for explicit Gate B review', () => {
  const baseline = compilerBaseline();
  baseline.product.screens_or_interfaces.push('Existing compiler review screen');
  baseline.visual_experience = {
    has_visual_interface: true,
    design_scope: 'full',
    design_timing: 'current_iteration',
    rationale: 'The approved product includes a full compiler review experience.',
  };
  const intake = supersessionIntake();

  const spec = buildDeltaSpec({
    projectId: 'compiler-project',
    iterationId: 'iter-003',
    idea: intake.idea,
    baselineSpec: baseline,
    baselineSpecRef: 'iterations/iter-003/baseline/current-spec.json',
    intake,
  });

  assert.deepEqual(spec.visual_experience, baseline.visual_experience);
  assert.ok(spec.product.screens_or_interfaces.includes('Existing compiler review screen'));
  assert.ok(fullSpecTaskRefs(spec).includes('visual_experience'));
});

test('a self-declared replacement context cannot promote an unrelated draft baseline', (t) => {
  const root = makeTempDir('p2a-fake-replacement-baseline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baselineIntakePath = path.join(
    root,
    'iterations', 'v2',
    'baseline', 'gate-a-intake', 'intake.json',
  );
  const baselineSpecPath = path.join(
    root,
    'iterations', 'v2',
    'baseline', 'gate-b-spec', 'spec.json',
  );
  const activeIntakePath = path.join(
    root,
    'iterations', 'v2',
    'gate-a-intake', 'intake.json',
  );
  const baselineIntake = webhookFixture('gate-a-intake/intake.json');
  const baselineSpec = webhookFixture('gate-b-spec/spec.json');
  writeJson(baselineIntakePath, baselineIntake);
  baselineSpec.source_intake = '../gate-a-intake/intake.json';
  baselineSpec.source_intake_sha256 = createHash('sha256')
    .update(readFileSync(baselineIntakePath))
    .digest('hex');
  baselineSpec.approval = 'draft';
  delete baselineSpec.approval_audit;
  writeJson(baselineSpecPath, baselineSpec);
  const activeIntake = clone(baselineIntake);
  activeIntake.baseline_context = {
    spec_ref: 'iterations/v2/baseline/gate-b-spec/spec.json',
    spec_sha256: createHash('sha256')
      .update(readFileSync(baselineSpecPath))
      .digest('hex'),
    reused_answers: [],
    reused_question_dispositions: [],
    replacement: {
      kind: 'blocked_scope_replan',
      replaces_iteration: 'v1',
      task_coverage: 'full_spec',
      blocked_task_ids: ['task-001'],
      current_development_contract_sha256: 'a'.repeat(64),
      reason: 'A self-declared context must not establish lifecycle authority.',
    },
  };
  writeJson(activeIntakePath, activeIntake);

  assert.throws(
    () => validateIntake(activeIntakePath, { artifactRoot: root }),
    (error) => error instanceof ValidationError
      && /replacement iteration metadata/.test(error.message),
  );
});

test('an answered material-boundary question replaces the named baseline dependency', () => {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.implementation.dependencies = [
    'Use SQLite for local storage.',
    'Keep the Node.js runtime dependency conventions.',
  ];
  const intake = {
    schema_version: 'p2a.intake.v1',
    idea: '데이터베이스 구조를 변경한다.',
    summary: '승인된 저장소 경계를 교체한다.',
    known_facts: [],
    assumptions: [],
    clarifying_questions: [{
      id: 'CQ-1',
      decision_kind: 'material_boundary',
      question: 'Which approved baseline architecture boundary changes?',
      why_it_matters: 'The dependency replacement must be explicit.',
      blocks: [
        'spec.product.constraints',
        'spec.implementation.architecture',
        'spec.implementation.interfaces',
        'spec.implementation.dependencies',
      ],
      status: 'answered',
      answer: 'Node.js runtime dependency conventions는 유지하고 SQLite를 PostgreSQL로 변경한다.',
    }],
    needs_user_decision: [],
    status: 'ready_for_spec',
    evidence: [],
  };

  const spec = buildDeltaSpec({
    projectId: 'storage-project',
    iterationId: 'iter-002',
    idea: intake.idea,
    baselineSpec: baseline,
    baselineSpecRef: 'iterations/iter-002/baseline/current-spec.json',
    intake,
  });

  assert.doesNotMatch(spec.implementation.dependencies.join('\n'), /Use SQLite for local storage/);
  assert.match(spec.implementation.dependencies.join('\n'), /Node\.js runtime dependency conventions/);
  assert.match(spec.implementation.dependencies.join('\n'), /PostgreSQL/);
  assert.deepEqual(spec.open_decisions, []);
  assert.deepEqual(baselineSupersessionViolations(baseline, intake, spec), []);
});

test('negated mutation answers preserve the explicitly retained baseline dependency', () => {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.implementation.dependencies = [
    'Use SQLite for local storage.',
    'Keep Node.js conventions.',
  ];

  for (const answer of [
    'Do not replace SQLite with PostgreSQL; keep SQLite unchanged.',
    'Do not remove SQLite; keep SQLite unchanged.',
    'Do not switch SQLite to PostgreSQL; keep SQLite unchanged.',
    'Never migrate SQLite to PostgreSQL; keep SQLite unchanged.',
    'Must not replace SQLite with PostgreSQL.',
    'Do not delete SQLite; keep SQLite unchanged.',
    'SQLite를 PostgreSQL로 교체하지 않는다.',
  ]) {
    const intake = {
      clarifying_questions: [{
        id: 'CQ-1',
        decision_kind: 'material_boundary',
        status: 'answered',
        answer,
        blocks: ['spec.implementation.dependencies'],
      }],
      needs_user_decision: [],
    };

    const merged = applyBaselineSupersessions(baseline, intake);
    assert.deepEqual(
      merged.implementation.dependencies,
      baseline.implementation.dependencies,
      answer,
    );
    assert.deepEqual(merged.plans, [], answer);
  }
});

test('a Korean-only material-boundary answer replaces the named Korean baseline constraint', () => {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.product.constraints = [
    '세션 기반 인증 방식을 유지한다.',
    '결제 인증 방식을 유지한다.',
    '로그인 세션 만료 시간을 유지한다.',
    '기존 감사 로그 보존 기간을 유지한다.',
  ];
  const intake = {
    schema_version: 'p2a.intake.v1',
    idea: '인증 방식을 변경한다.',
    summary: '승인된 인증 경계를 교체한다.',
    known_facts: [],
    assumptions: [],
    clarifying_questions: [{
      id: 'CQ-1',
      decision_kind: 'material_boundary',
      question: '어떤 인증 경계를 변경합니까?',
      why_it_matters: '교체할 기존 제약을 명확히 해야 합니다.',
      blocks: ['spec.product.constraints'],
      status: 'answered',
      answer: '세션 인증 대신 JWT 인증으로 변경한다.',
    }],
    needs_user_decision: [],
    status: 'ready_for_spec',
    evidence: [],
  };

  const spec = buildDeltaSpec({
    projectId: 'auth-project',
    iterationId: 'iter-002',
    idea: intake.idea,
    baselineSpec: baseline,
    baselineSpecRef: 'iterations/iter-002/baseline/current-spec.json',
    intake,
  });

  assert.doesNotMatch(spec.product.constraints.join('\n'), /세션 기반 인증/);
  assert.match(spec.product.constraints.join('\n'), /결제 인증 방식/);
  assert.match(spec.product.constraints.join('\n'), /로그인 세션 만료 시간/);
  assert.match(spec.product.constraints.join('\n'), /감사 로그 보존 기간/);
  assert.match(spec.product.constraints.join('\n'), /JWT 인증/);
  assert.deepEqual(spec.open_decisions, []);
});

test('a boundary answer never removes unrelated baseline constraints from generic token overlap', () => {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.product.constraints = [
    '결제 인증 방식을 유지한다.',
    '로그인 세션 만료 시간을 유지한다.',
  ];
  const intake = {
    schema_version: 'p2a.intake.v1',
    idea: '로그인 인증 방식을 변경한다.',
    summary: '로그인 인증만 변경한다.',
    known_facts: [],
    assumptions: [],
    clarifying_questions: [{
      id: 'CQ-1',
      decision_kind: 'material_boundary',
      question: '어떤 인증 경계를 변경합니까?',
      why_it_matters: '로그인 인증 범위를 정합니다.',
      blocks: ['spec.product.constraints'],
      status: 'answered',
      answer: '로그인 인증 방식을 JWT 인증 체계로 변경한다.',
    }],
    needs_user_decision: [],
    status: 'ready_for_spec',
    evidence: [],
  };

  const merge = applyBaselineSupersessions(baseline, intake);
  assert.equal(merge.unresolved.length, 1);
  assert.deepEqual(merge.product.constraints, baseline.product.constraints);
});

test('an inferred supersession never drops an unmentioned clause bundled in one baseline entry', () => {
  const baseline = webhookFixture('gate-b-spec/spec.json');
  baseline.product.constraints = [
    '세션 인증을 사용하고 비밀번호 로그인 fallback은 유지한다.',
  ];
  const intake = {
    schema_version: 'p2a.intake.v1',
    idea: '인증 방식을 변경한다.',
    summary: '세션 인증을 JWT로 변경한다.',
    known_facts: [],
    assumptions: [],
    clarifying_questions: [{
      id: 'CQ-1',
      decision_kind: 'material_boundary',
      question: '어떤 인증 경계를 변경합니까?',
      why_it_matters: '기존 제약에서 바뀌는 부분을 정합니다.',
      blocks: ['spec.product.constraints'],
      status: 'answered',
      answer: '세션 인증 대신 JWT 인증으로 변경한다.',
    }],
    needs_user_decision: [],
    status: 'ready_for_spec',
    evidence: [],
  };

  const merge = applyBaselineSupersessions(baseline, intake);
  assert.equal(merge.unresolved.length, 1);
  assert.deepEqual(merge.product.constraints, baseline.product.constraints);
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
