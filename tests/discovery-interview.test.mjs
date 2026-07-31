import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  FIXTURE_ROOT,
  makeTempDir,
  runHandoff,
  runIteration,
  runP2a,
  runValidator,
} from './helpers/fixtures.mjs';
import {
  validateHandoffReadyArtifactRoot,
  validateIntake,
  validateSchema,
  validateSpec,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import {
  buildInitialCanonicalSections,
  composeCanonicalSpecSources,
  compositionSourceContractError,
} from '../scripts/p2a_spec_model.mjs';
import { validateCurrentSpecCompositionData } from '../scripts/p2a_iteration.mjs';

const DIMENSIONS = [
  'target_users',
  'core_problem',
  'expected_outcome',
  'mvp_scope',
  'non_goals',
  'success_criteria',
  'constraints_and_risks',
  'integrations_and_compatibility',
];

const DIMENSION_FIELDS = {
  target_users: ['spec.product.target_users'],
  core_problem: ['spec.product.problem'],
  expected_outcome: ['spec.product.success_criteria', 'spec.implementation.verification'],
  mvp_scope: ['spec.product.goals', 'spec.product.core_flows'],
  non_goals: ['spec.product.non_goals'],
  success_criteria: ['spec.product.success_criteria', 'spec.implementation.verification'],
  constraints_and_risks: ['spec.product.constraints', 'spec.implementation.edge_cases'],
  integrations_and_compatibility: [
    'spec.product.external_integrations',
    'spec.implementation.interfaces',
  ],
};

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jsonSha256(value) {
  return createHash('sha256')
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest('hex');
}

function discoveryDimensions(status = 'confirmed') {
  return DIMENSIONS.map((dimension) => ({
    dimension,
    status,
    summary: `${dimension} disposition`,
    source_ids: ['USER-1'],
    affected_fields: status === 'open' ? [] : [...DIMENSION_FIELDS[dimension]],
  }));
}

function structuredSpecUpdates(intake, options = {}) {
  const replaceValues = options.replaceValues ?? {};
  const updates = new Map();
  function addSource(field, value, sourceType, sourceId) {
    const hasReplacement = Object.hasOwn(replaceValues, field);
    const existing = updates.get(field) ?? {
      field,
      operation: hasReplacement || !intake.baseline_context ? 'replace' : 'append',
      values: [],
      source_question_ids: [],
      source_dimension_ids: [],
    };
    if (hasReplacement) {
      existing.operation = 'replace';
      existing.values = [...replaceValues[field]];
    } else {
      existing.values = [...new Set([...existing.values, value])];
    }
    const sourceField = sourceType === 'dimension'
      ? 'source_dimension_ids'
      : 'source_question_ids';
    existing[sourceField] = [...new Set([...existing[sourceField], sourceId])];
    updates.set(field, existing);
  }
  for (const dimension of intake.interview?.discovery_dimensions ?? []) {
    if (dimension.status === 'open') continue;
    for (const field of dimension.affected_fields ?? []) {
      addSource(field, dimension.summary, 'dimension', dimension.dimension);
    }
  }
  const questions = [
    ...(intake.clarifying_questions ?? []).filter((item) => (
      ['answered', 'assumed', 'not_applicable'].includes(item.status)
    )),
    ...(intake.needs_user_decision ?? []).filter((item) => item.status === 'answered'),
  ];
  for (const source of questions) {
    for (const field of source.affected_fields ?? source.blocks ?? []) {
      addSource(field, source.answer, 'question', source.id);
    }
  }
  return [...updates.values()];
}

function intakeForInterview(state, options = {}) {
  const ready = ['ready_for_gate_a_summary', 'awaiting_gate_a_confirmation', 'gate_a_confirmed']
    .includes(state);
  const questionStatus = ready ? 'answered' : 'open';
  const intake = {
    schema_version: 'p2a.intake.v1',
    idea: 'Add a delivery dashboard',
    summary: 'Add a delivery dashboard to the existing service.',
    known_facts: ['The change is user-visible.'],
    assumptions: [],
    clarifying_questions: [
      {
        id: 'CQ-1',
        question: 'Who uses the dashboard?',
        why_it_matters: 'The answer determines the primary flow.',
        blocks: ['spec.product.target_users'],
        affected_fields: ready ? ['spec.product.target_users'] : [],
        ...(ready ? { canonical_effect: 'change' } : {}),
        status: questionStatus,
        ...(ready ? { answer: 'Operations users' } : {}),
      },
    ],
    needs_user_decision: [],
    interview: {
      state,
      round: options.round ?? (ready ? 2 : 1),
      no_progress_rounds: options.noProgressRounds ?? 0,
      soft_limit_acknowledged: options.softLimitAcknowledged ?? false,
      discovery_dimensions: options.dimensions ?? discoveryDimensions(ready ? 'confirmed' : 'open'),
      spec_updates: [],
      asked_question_ids: ['CQ-1'],
      current_question_ids: state === 'interview_active' ? ['CQ-1'] : [],
      has_unasked_high_impact_questions: options.hasUnasked ?? !ready,
      new_blocker: options.newBlocker ?? false,
      stop_reason: options.stopReason ?? (state === 'interview_active' ? null : 'readiness'),
    },
    status: state === 'gate_a_confirmed' ? 'ready_for_spec' : 'blocked_on_user',
    evidence: [
      {
        source_id: 'USER-1',
        title: 'User interview answers',
        url: '',
        used_for: 'Disposed discovery dimensions.',
      },
    ],
  };
  if (ready) {
    intake.interview.spec_updates = structuredSpecUpdates(intake, {
      replaceValues: {
        'spec.product.target_users': ['Operations users'],
      },
    });
  }
  if (state === 'gate_a_confirmed' && options.includeAudit !== false) {
    intake.approval_audit = {
      approved_by: 'user',
      approved_at: '2026-07-29',
      approved_artifacts: ['gate-a-intake/intake.json'],
      approval_note: 'User confirmed the Gate A understanding summary.',
    };
  }
  if (options.baselineContext) intake.baseline_context = options.baselineContext;
  return intake;
}

function specForInterview(
  intake,
  iterationId = intake.interview?.seed_iteration_id ?? 'v1-mvp',
) {
  const sections = buildInitialCanonicalSections({
    iterationId,
    idea: intake.idea,
    intake,
  });
  for (const update of intake.interview.spec_updates) {
    const match = /^spec\.(product|implementation)\.([a-z_]+)$/.exec(update.field);
    assert.ok(match, `unexpected test spec update field: ${update.field}`);
    const [, section, field] = match;
    if (section === 'product' && field === 'problem') {
      sections.product.problem = update.values.join('\n\n');
    } else {
      sections[section][field] = [...update.values];
    }
  }
  return {
    schema_version: 'p2a.spec.v1',
    project_id: 'sample',
    source_intake: '../gate-a-intake/intake.json',
    product: sections.product,
    implementation: sections.implementation,
    clarifying_question_disposition: intake.clarifying_questions.map((question) => ({
      id: question.id,
      status: 'answered',
      rationale: `Gate A recorded ${question.id}.`,
      affects: [...question.blocks],
      resolved_by: question.answer,
    })),
    open_decisions: [],
    approval: 'draft',
    evidence: [
      {
        source_id: 'USER-1',
        title: 'User interview answers',
        url: '',
        used_for: 'Generated the Gate B fixture.',
      },
    ],
  };
}

function validateTempIntake(intake) {
  const root = makeTempDir('p2a-discovery-intake-');
  const intakePath = join(root, 'intake.json');
  try {
    writeJson(intakePath, intake);
    return validateIntake(intakePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nextForIntake(intake) {
  const root = makeTempDir('p2a-discovery-next-');
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'sample');
  try {
    writeJson(join(root, '.plan2agent', 'manifest.json'), {
      provenance: { mode: 'scaffold' },
      enhancements: {},
    });
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(join(artifactRoot, 'status.md'), '# fixture\n', 'utf8');
    writeJson(join(artifactRoot, 'gate-a-intake', 'intake.json'), intake);
    const result = runP2a(['next', '--target', root, '--json']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function nextForIterativeIntake(intake) {
  const root = makeTempDir('p2a-discovery-iterative-next-');
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'sample');
  const iterationId = 'iter-002';
  const intakePath = join(
    artifactRoot,
    'iterations',
    iterationId,
    'gate-a-intake',
    'intake.json',
  );
  try {
    writeJson(join(root, '.plan2agent', 'manifest.json'), {
      provenance: { mode: 'scaffold' },
      enhancements: {},
    });
    writeJson(join(artifactRoot, 'current-spec.json'), {
      schema_version: 'p2a.current_spec.v1',
      project_id: 'sample',
      active_iteration: iterationId,
      effective_spec_ref: 'current-spec.json',
    });
    writeJson(intakePath, intake);
    const result = runP2a(['next', '--target', root, '--json']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return { payload: JSON.parse(result.stdout), intakePath };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function confirmGeneratedIntake(intakePath, approvedArtifactRef) {
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  intake.clarifying_questions = intake.clarifying_questions.map((question) => ({
    ...question,
    status: 'answered',
    answer: `Confirmed answer for ${question.id}`,
    affected_fields: [...question.blocks],
    canonical_effect: 'change',
  }));
  intake.needs_user_decision = intake.needs_user_decision.map((decision) => ({
    ...decision,
    status: 'answered',
    answer: decision.answer ?? decision.default,
    affected_fields: [...(decision.blocks ?? [])],
    canonical_effect: 'change',
  }));
  intake.interview = {
    ...intake.interview,
    state: 'gate_a_confirmed',
    round: Math.max(2, intake.interview.round),
    no_progress_rounds: 0,
    discovery_dimensions: intake.interview.discovery_dimensions.map((dimension) => ({
      ...dimension,
      status: 'confirmed',
      summary: `Confirmed ${dimension.dimension} for the force-reset fixture.`,
    })),
    asked_question_ids: [
      ...new Set([
        ...intake.interview.asked_question_ids,
        ...intake.clarifying_questions.map((question) => question.id),
        ...intake.needs_user_decision.map((decision) => decision.id),
      ]),
    ],
    current_question_ids: [],
    has_unasked_high_impact_questions: false,
    new_blocker: false,
    stop_reason: 'readiness',
  };
  intake.interview.spec_updates = structuredSpecUpdates(intake, {
    replaceValues: {
      'spec.product.target_users': ['Delivery dashboard operators'],
    },
  });
  intake.approval_audit = {
    approved_by: 'user',
    approved_at: '2026-07-29',
    approved_artifacts: [approvedArtifactRef],
    approval_note: 'Fixture user confirmed the Gate A summary.',
  };
  intake.status = 'ready_for_spec';
  writeJson(intakePath, intake);
  return intake;
}

test('custom schema validation enforces array cardinality', () => {
  assert.doesNotThrow(() => validateSchema(
    ['CQ-1', 'CQ-2', 'CQ-3'],
    { type: 'array', maxItems: 3 },
  ));
  assert.throws(
    () => validateSchema(
      ['CQ-1', 'CQ-2', 'CQ-3', 'CQ-4'],
      { type: 'array', maxItems: 3 },
    ),
    /must contain at most 3 item/,
  );
});

test('discovery interview accepts active, summary, confirmation, and confirmed Gate A states', () => {
  for (const state of [
    'interview_active',
    'ready_for_gate_a_summary',
    'awaiting_gate_a_confirmation',
    'gate_a_confirmed',
  ]) {
    const intake = validateTempIntake(intakeForInterview(state));
    assert.equal(intake.interview.state, state);
  }
});

test('Gate A confirmation requires explicit approval audit and complete readiness', () => {
  assert.throws(
    () => validateTempIntake(intakeForInterview('gate_a_confirmed', { includeAudit: false })),
    (error) => error instanceof ValidationError && /approval_audit is required/.test(error.message),
  );
  assert.throws(
    () => validateTempIntake(intakeForInterview('awaiting_gate_a_confirmation', {
      dimensions: discoveryDimensions('open'),
    })),
    (error) => error instanceof ValidationError && /requires readiness/.test(error.message),
  );

  const unaskedOpenQuestion = intakeForInterview('gate_a_confirmed');
  unaskedOpenQuestion.clarifying_questions.push({
    id: 'CQ-2',
    question: 'How long should dashboard history be retained?',
    why_it_matters: 'The answer affects storage constraints.',
    blocks: ['spec.product.constraints'],
    status: 'open',
  });
  assert.throws(
    () => validateTempIntake(unaskedOpenQuestion),
    (error) => (
      error instanceof ValidationError
      && /unresolved questions=.*CQ-2/.test(error.message)
    ),
  );

  const blankDimensionSummary = intakeForInterview('gate_a_confirmed');
  blankDimensionSummary.interview.discovery_dimensions[0].summary = '   ';
  assert.throws(
    () => validateTempIntake(blankDimensionSummary),
    (error) => (
      error instanceof ValidationError
      && /target_users must have a non-blank summary/.test(error.message)
    ),
  );

  const openDimensionWithEffects = intakeForInterview('interview_active');
  openDimensionWithEffects.interview.discovery_dimensions[0].affected_fields = [
    'spec.product.target_users',
  ];
  assert.throws(
    () => validateTempIntake(openDimensionWithEffects),
    (error) => (
      error instanceof ValidationError
      && /open dimension target_users must keep affected_fields empty/.test(error.message)
    ),
  );
});

test('interview guardrails reject oversized batches and invalid no-progress continuation', () => {
  const oversized = intakeForInterview('interview_active');
  oversized.clarifying_questions.push(
    ...[2, 3, 4].map((number) => ({
      id: `CQ-${number}`,
      question: `Question ${number}?`,
      why_it_matters: 'It affects scope.',
      blocks: ['spec.product.goals'],
      status: 'open',
    })),
  );
  oversized.interview.asked_question_ids = ['CQ-1', 'CQ-2', 'CQ-3', 'CQ-4'];
  oversized.interview.current_question_ids = ['CQ-1', 'CQ-2', 'CQ-3', 'CQ-4'];
  assert.throws(
    () => validateTempIntake(oversized),
    (error) => (
      error instanceof ValidationError
      && /current_question_ids must contain at most 3 item/.test(error.message)
    ),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('interview_active', { noProgressRounds: 2 })),
    (error) => error instanceof ValidationError && /cannot continue after 2 no-progress rounds/.test(error.message),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('interview_active', { round: 3 })),
    (error) => (
      error instanceof ValidationError
      && /remaining blockers at or beyond round 3 must pause for the soft-limit summary/.test(error.message)
    ),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('interview_active', { round: 4 })),
    (error) => (
      error instanceof ValidationError
      && /remaining blockers at or beyond round 3 must pause for the soft-limit summary/.test(error.message)
    ),
  );
  const continuedAfterSoftLimit = validateTempIntake(intakeForInterview('interview_active', {
    round: 4,
    softLimitAcknowledged: true,
  }));
  assert.equal(continuedAfterSoftLimit.interview.soft_limit_acknowledged, true);

  const resolvedCurrent = intakeForInterview('interview_active');
  resolvedCurrent.clarifying_questions[0].status = 'answered';
  resolvedCurrent.clarifying_questions[0].answer = 'Operations users';
  resolvedCurrent.clarifying_questions[0].affected_fields = [
    'spec.product.target_users',
  ];
  resolvedCurrent.clarifying_questions[0].canonical_effect = 'change';
  resolvedCurrent.interview.spec_updates = structuredSpecUpdates(resolvedCurrent, {
    replaceValues: {
      'spec.product.target_users': ['Operations users'],
    },
  });
  assert.throws(
    () => validateTempIntake(resolvedCurrent),
    (error) => error instanceof ValidationError && /current_question_ids must reference unresolved questions/.test(error.message),
  );

  const missingAskedHistory = intakeForInterview('gate_a_confirmed');
  missingAskedHistory.interview.asked_question_ids = [];
  assert.throws(
    () => validateTempIntake(missingAskedHistory),
    (error) => error instanceof ValidationError && /answered questions must appear in asked_question_ids/.test(error.message),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('paused', {
      round: 1,
      stopReason: 'soft_limit',
    })),
    (error) => error instanceof ValidationError && /soft_limit requires interview.round to be 3 or 4/.test(error.message),
  );
  assert.throws(
    () => validateTempIntake(intakeForInterview('paused', {
      round: 5,
      stopReason: 'soft_limit',
    })),
    (error) => error instanceof ValidationError && /soft_limit requires interview.round to be 3 or 4/.test(error.message),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('paused', {
      round: 5,
      stopReason: 'user_requested',
    })),
    (error) => (
      error instanceof ValidationError
      && /remaining blockers at round 5 must stop as blocked_on_user with hard_limit/.test(error.message)
    ),
  );

  assert.throws(
    () => validateTempIntake(intakeForInterview('blocked_on_user', {
      round: 4,
      noProgressRounds: 2,
      stopReason: 'user_requested',
    })),
    (error) => (
      error instanceof ValidationError
      && /after 2 no-progress rounds must stop as blocked_on_user with no_progress/.test(error.message)
    ),
  );
});

test('interview questions and decisions require canonical blocked fields for Gate B synthesis', () => {
  const blankQuestionAnswer = intakeForInterview('gate_a_confirmed');
  blankQuestionAnswer.clarifying_questions[0].answer = '   ';
  assert.throws(
    () => validateTempIntake(blankQuestionAnswer),
    (error) => error instanceof ValidationError && /has no non-blank answer/.test(error.message),
  );

  const emptyQuestionBlocks = intakeForInterview('gate_a_confirmed');
  emptyQuestionBlocks.clarifying_questions[0].blocks = [];
  assert.throws(
    () => validateTempIntake(emptyQuestionBlocks),
    (error) => error instanceof ValidationError && /clarifying_questions\[0\]\.blocks/.test(error.message),
  );

  const unknownQuestionBlock = intakeForInterview('gate_a_confirmed');
  unknownQuestionBlock.clarifying_questions[0].blocks = ['spec.product.typo'];
  assert.throws(
    () => validateTempIntake(unknownQuestionBlock),
    (error) => error instanceof ValidationError && /clarifying_questions\[0\]\.blocks\[0\]/.test(error.message),
  );

  const withDecision = intakeForInterview('gate_a_confirmed');
  withDecision.needs_user_decision.push({
    id: 'ND-1',
    question: 'Which user group receives the dashboard?',
    options: [
      {
        id: 'operations',
        label: 'Operations',
        description: 'Expose the dashboard to operations users.',
      },
      {
        id: 'all-users',
        label: 'All users',
        description: 'Expose the dashboard to every authenticated user.',
      },
    ],
    impact: 'Changes the target user and success criteria.',
    blocks: ['spec.product.target_users', 'spec.product.success_criteria'],
    default: 'operations',
    status: 'answered',
    answer: 'Operations users',
    affected_fields: ['spec.product.target_users', 'spec.product.success_criteria'],
    canonical_effect: 'change',
  });
  withDecision.interview.asked_question_ids.push('ND-1');
  withDecision.interview.spec_updates = structuredSpecUpdates(withDecision, {
    replaceValues: {
      'spec.product.target_users': ['Operations users'],
    },
  });
  const validated = validateTempIntake(withDecision);
  assert.deepEqual(
    validated.needs_user_decision[0].blocks,
    ['spec.product.target_users', 'spec.product.success_criteria'],
  );

  const blankDecisionAnswer = structuredClone(withDecision);
  blankDecisionAnswer.needs_user_decision[0].answer = '   ';
  assert.throws(
    () => validateTempIntake(blankDecisionAnswer),
    (error) => error instanceof ValidationError && /has no non-blank answer/.test(error.message),
  );

  delete withDecision.needs_user_decision[0].blocks;
  assert.throws(
    () => validateTempIntake(withDecision),
    (error) => error instanceof ValidationError && /decisions must declare non-empty blocks/.test(error.message),
  );

  const missingSpecUpdate = intakeForInterview('gate_a_confirmed');
  missingSpecUpdate.interview.spec_updates = [];
  assert.throws(
    () => validateTempIntake(missingSpecUpdate),
    (error) => (
      error instanceof ValidationError
      && /spec_updates must cover every resolved question block/.test(error.message)
    ),
  );

  const unchangedQuestion = intakeForInterview('gate_a_confirmed', {
    baselineContext: {
      spec_ref: 'iterations/v1/gate-b-spec/spec.json',
      reused_answers: [],
      reused_question_dispositions: [],
    },
  });
  unchangedQuestion.clarifying_questions[0].answer = 'The approved baseline remains unchanged.';
  unchangedQuestion.clarifying_questions[0].affected_fields = [];
  unchangedQuestion.clarifying_questions[0].canonical_effect = 'preserve_baseline';
  unchangedQuestion.interview.spec_updates = structuredSpecUpdates(unchangedQuestion);
  const unchangedValidated = validateTempIntake(unchangedQuestion);
  assert.deepEqual(unchangedValidated.clarifying_questions[0].affected_fields, []);
  assert.equal(
    unchangedValidated.interview.spec_updates.some((update) => (
      update.source_question_ids.includes('CQ-1')
    )),
    false,
  );

  const hiddenChange = structuredClone(unchangedQuestion);
  hiddenChange.clarifying_questions[0].answer = 'Replace the baseline users with administrators.';
  hiddenChange.clarifying_questions[0].canonical_effect = 'change';
  assert.throws(
    () => validateTempIntake(hiddenChange),
    (error) => (
      error instanceof ValidationError
      && /canonical_effect change requires non-empty affected_fields/.test(error.message)
    ),
  );

  const implicitPreservation = structuredClone(unchangedQuestion);
  delete implicitPreservation.clarifying_questions[0].canonical_effect;
  assert.throws(
    () => validateTempIntake(implicitPreservation),
    (error) => (
      error instanceof ValidationError
      && /canonical_effect is required after the question is resolved/.test(error.message)
    ),
  );
});

test('questionless Gate A confirmation requires dimension-sourced canonical updates', () => {
  const intake = intakeForInterview('gate_a_confirmed', {
    baselineContext: {
      spec_ref: 'iterations/v1/gate-b-spec/spec.json',
      reused_answers: [],
      reused_question_dispositions: [],
    },
  });
  intake.clarifying_questions = [];
  intake.needs_user_decision = [];
  intake.interview.asked_question_ids = [];
  intake.interview.current_question_ids = [];
  intake.interview.discovery_dimensions = intake.interview.discovery_dimensions.map((dimension) => ({
    ...dimension,
    affected_fields: dimension.dimension === 'target_users'
      ? ['spec.product.target_users']
      : [],
  }));
  intake.interview.spec_updates = [
    {
      field: 'spec.product.target_users',
      operation: 'replace',
      values: ['Administrators'],
      source_question_ids: [],
      source_dimension_ids: ['target_users'],
    },
  ];

  const validated = validateTempIntake(intake);
  assert.deepEqual(validated.interview.spec_updates[0].values, ['Administrators']);

  const missingDimensionUpdate = structuredClone(intake);
  missingDimensionUpdate.interview.spec_updates = [];
  assert.throws(
    () => validateTempIntake(missingDimensionUpdate),
    (error) => (
      error instanceof ValidationError
      && /affected discovery dimension field/.test(error.message)
    ),
  );

  const wrongDimensionRoute = structuredClone(intake);
  wrongDimensionRoute.interview.spec_updates[0].field = 'spec.product.goals';
  assert.throws(
    () => validateTempIntake(wrongDimensionRoute),
    (error) => (
      error instanceof ValidationError
      && /not declared in discovery dimension target_users\.affected_fields/.test(error.message)
    ),
  );

  const duplicateUpdateValues = structuredClone(intake);
  duplicateUpdateValues.interview.spec_updates[0].values = [
    'Administrators',
    'Administrators',
  ];
  assert.throws(
    () => validateTempIntake(duplicateUpdateValues),
    (error) => (
      error instanceof ValidationError
      && /spec_updates\[0\]\.values must contain unique items/.test(error.message)
    ),
  );

  const blankUpdateValue = structuredClone(intake);
  blankUpdateValue.interview.spec_updates[0].values = ['   '];
  assert.throws(
    () => validateTempIntake(blankUpdateValue),
    (error) => (
      error instanceof ValidationError
      && /spec_updates\[0\]\.values\[0\] must match pattern/.test(error.message)
    ),
  );

  const greenfieldRemove = structuredClone(intake);
  delete greenfieldRemove.baseline_context;
  greenfieldRemove.interview.discovery_dimensions = greenfieldRemove.interview.discovery_dimensions
    .map((dimension) => ({
      ...dimension,
      status: dimension.dimension === 'target_users' ? 'confirmed' : 'not_applicable',
      affected_fields: dimension.dimension === 'target_users'
        ? ['spec.product.target_users']
        : [],
    }));
  greenfieldRemove.interview.spec_updates = [{
    field: 'spec.product.target_users',
    operation: 'remove',
    values: ['A user absent from any greenfield baseline'],
    source_question_ids: [],
    source_dimension_ids: ['target_users'],
  }];
  assert.throws(
    () => validateTempIntake(greenfieldRemove),
    (error) => (
      error instanceof ValidationError
      && /must use replace without a baseline canonical field/.test(error.message)
    ),
  );

  const greenfieldAppend = structuredClone(greenfieldRemove);
  greenfieldAppend.interview.spec_updates[0].operation = 'append';
  assert.throws(
    () => validateTempIntake(greenfieldAppend),
    (error) => (
      error instanceof ValidationError
      && /must use replace without a baseline canonical field/.test(error.message)
    ),
  );

  const greenfieldReplaceNoOp = structuredClone(greenfieldRemove);
  greenfieldReplaceNoOp.interview.spec_updates[0] = {
    ...greenfieldReplaceNoOp.interview.spec_updates[0],
    operation: 'replace',
    values: ['Primary users and stakeholders described by the Gate A intake.'],
  };
  assert.throws(
    () => validateTempIntake(greenfieldReplaceNoOp),
    (error) => (
      error instanceof ValidationError
      && /did not change the canonical Gate B field/.test(error.message)
    ),
  );

  const greenfieldEmptyRequiredField = structuredClone(greenfieldRemove);
  greenfieldEmptyRequiredField.interview.spec_updates[0] = {
    ...greenfieldEmptyRequiredField.interview.spec_updates[0],
    operation: 'replace',
    values: [],
  };
  assert.throws(
    () => validateTempIntake(greenfieldEmptyRequiredField),
    (error) => (
      error instanceof ValidationError
      && /spec\.product\.target_users must not leave the canonical Gate B field empty/.test(error.message)
    ),
  );

  const incompleteGreenfield = structuredClone(intake);
  delete incompleteGreenfield.baseline_context;
  assert.throws(
    () => validateTempIntake(incompleteGreenfield),
    (error) => (
      error instanceof ValidationError
      && /greenfield core_problem must declare at least one affected_fields entry/.test(error.message)
    ),
  );
});

test('legacy intake v1 keeps pre-interview clarifying question block compatibility', () => {
  const legacy = intakeForInterview('gate_a_confirmed');
  delete legacy.interview;
  delete legacy.approval_audit;
  legacy.status = 'ready_for_spec';
  legacy.clarifying_questions = [
    {
      id: 'CQ-1',
      question: 'Which legacy scope label applies?',
      why_it_matters: 'Legacy producers used free-form block labels.',
      blocks: ['product.scope'],
    },
    {
      id: 'CQ-2',
      question: 'Is another legacy block needed?',
      why_it_matters: 'The previous v1 schema allowed an empty block list.',
      blocks: [],
    },
  ];

  const validated = validateTempIntake(legacy);
  assert.deepEqual(validated.clarifying_questions[0].blocks, ['product.scope']);
  assert.deepEqual(validated.clarifying_questions[1].blocks, []);
});

test('interview-aware clarifying questions require status while legacy intake remains compatible', () => {
  const interviewAware = intakeForInterview('interview_active');
  delete interviewAware.clarifying_questions[0].status;
  assert.throws(
    () => validateTempIntake(interviewAware),
    (error) => (
      error instanceof ValidationError
      && /clarifying_questions\[0\]\.status is required when intake\.interview is present/.test(error.message)
    ),
  );

  const legacy = structuredClone(interviewAware);
  delete legacy.interview;
  legacy.status = 'ready_for_spec';
  assert.doesNotThrow(() => validateTempIntake(legacy));
});

test('Gate B requires confirmed Gate A and preserves every unclaimed greenfield field', () => {
  const root = makeTempDir('p2a-discovery-gate-b-confirmation-');
  const intakePath = join(root, 'gate-a-intake', 'intake.json');
  const specPath = join(root, 'gate-b-spec', 'spec.json');
  try {
    const confirmedIntake = intakeForInterview('gate_a_confirmed');
    const confirmedSpec = specForInterview(confirmedIntake);
    confirmedSpec.source_intake_sha256 = jsonSha256(confirmedIntake);
    writeJson(intakePath, confirmedIntake);
    writeJson(specPath, confirmedSpec);
    assert.doesNotThrow(() => validateSpec(specPath, intakePath));

    const unclaimedDrift = structuredClone(confirmedSpec);
    unclaimedDrift.implementation.architecture = [
      'Arbitrary architecture that Gate A did not authorize.',
    ];
    writeJson(specPath, unclaimedDrift);
    assert.throws(
      () => validateSpec(specPath, intakePath),
      (error) => (
        error instanceof ValidationError
        && /spec spec\.implementation\.architecture must equal the baseline value after applying Gate A spec_updates/.test(error.message)
      ),
    );

    const unconfirmedCases = [
      intakeForInterview('ready_for_gate_a_summary'),
      intakeForInterview('awaiting_gate_a_confirmation'),
      intakeForInterview('paused', {
        round: 3,
        stopReason: 'soft_limit',
      }),
    ];
    for (const intake of unconfirmedCases) {
      const spec = specForInterview(confirmedIntake);
      spec.source_intake_sha256 = jsonSha256(intake);
      writeJson(intakePath, intake);
      writeJson(specPath, spec);
      assert.throws(
        () => validateSpec(specPath, intakePath),
        (error) => (
          error instanceof ValidationError
          && /interview-aware specs require a gate_a_confirmed intake with status ready_for_spec/.test(error.message)
        ),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flattened greenfield Gate B preserves its custom seed iteration identity', () => {
  const root = makeTempDir('p2a-discovery-flat-custom-seed-');
  const intakePath = join(root, 'gate-a-intake', 'intake.json');
  const specPath = join(root, 'gate-b-spec', 'spec.json');
  const iterationId = 'custom-launch';
  try {
    const intake = intakeForInterview('gate_a_confirmed');
    intake.interview.seed_iteration_id = iterationId;
    intake.interview.discovery_dimensions = intake.interview.discovery_dimensions
      .map((dimension) => (
        dimension.dimension === 'mvp_scope'
          ? {
              ...dimension,
              status: 'not_applicable',
              summary: 'The default first-iteration scope remains the canonical seed.',
              affected_fields: [],
            }
          : dimension
      ));
    intake.interview.spec_updates = structuredSpecUpdates(intake, {
      replaceValues: {
        'spec.product.target_users': ['Operations users'],
      },
    });

    const spec = specForInterview(intake, iterationId);
    spec.source_intake_sha256 = jsonSha256(intake);
    writeJson(intakePath, intake);
    writeJson(specPath, spec);

    assert.match(spec.product.goals.join('\n'), new RegExp(iterationId));
    assert.doesNotThrow(() => validateSpec(specPath, intakePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spec validation requires the referenced Gate A source intake to exist', () => {
  const root = makeTempDir('p2a-discovery-required-source-intake-');
  const specPath = join(root, 'gate-b-spec', 'spec.json');
  try {
    cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), root, {
      recursive: true,
    });
    assert.doesNotThrow(() => validateSpec(specPath));

    rmSync(join(root, 'gate-a-intake'), { recursive: true, force: true });
    assert.throws(
      () => validateSpec(specPath),
      (error) => (
        error instanceof ValidationError
        && /spec\.source_intake cannot be resolved to a file/.test(error.message)
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('active iteration validation rejects a source intake outside the artifact root', () => {
  const root = makeTempDir('p2a-discovery-active-source-intake-root-');
  const artifactRoot = join(root, 'artifacts');
  try {
    cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, {
      recursive: true,
    });
    let result = runIteration([
      'init',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'v1-mvp',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const intakePath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-a-intake',
      'intake.json',
    );
    const outsideIntakePath = join(root, 'outside-intake.json');
    writeFileSync(outsideIntakePath, readFileSync(intakePath));
    rmSync(intakePath);
    const specPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-b-spec',
      'spec.json',
    );
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.source_intake = outsideIntakePath;
    writeJson(specPath, spec);

    result = runIteration(['validate', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /spec\.source_intake resolves outside the artifact root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate B clarifying dispositions preserve interview status, answer, and impacts', () => {
  const root = makeTempDir('p2a-discovery-disposition-contract-');
  const intakePath = join(root, 'gate-a-intake', 'intake.json');
  const specPath = join(root, 'gate-b-spec', 'spec.json');
  try {
    const intake = intakeForInterview('gate_a_confirmed');
    writeJson(intakePath, intake);
    const spec = specForInterview(intake);
    spec.source_intake_sha256 = jsonSha256(intake);
    writeJson(specPath, spec);
    assert.doesNotThrow(() => validateSpec(specPath, intakePath));

    const statusDrift = structuredClone(spec);
    statusDrift.clarifying_question_disposition[0].status = 'assumed';
    statusDrift.clarifying_question_disposition[0].assumption = 'A different user group';
    delete statusDrift.clarifying_question_disposition[0].resolved_by;
    writeJson(specPath, statusDrift);
    assert.throws(
      () => validateSpec(specPath, intakePath),
      (error) => (
        error instanceof ValidationError
        && /must preserve its Gate A answered status, answer, and blocks/.test(error.message)
      ),
    );

    const answerDrift = structuredClone(spec);
    answerDrift.clarifying_question_disposition[0].resolved_by = 'A different answer';
    writeJson(specPath, answerDrift);
    assert.throws(
      () => validateSpec(specPath, intakePath),
      (error) => (
        error instanceof ValidationError
        && /must preserve its Gate A answered status, answer, and blocks/.test(error.message)
      ),
    );

    const affectsDrift = structuredClone(spec);
    affectsDrift.clarifying_question_disposition[0].affects = [
      'spec.product.success_criteria',
    ];
    writeJson(specPath, affectsDrift);
    assert.throws(
      () => validateSpec(specPath, intakePath),
      (error) => (
        error instanceof ValidationError
        && /must preserve its Gate A answered status, answer, and blocks/.test(error.message)
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline answer and disposition provenance remains schema-compatible', () => {
  const intake = intakeForInterview('gate_a_confirmed', {
    baselineContext: {
      spec_ref: 'iterations/v1/gate-b-spec/spec.json',
      reused_answers: [
        {
          id: 'ND-1',
          question: 'Which runtime?',
          answer: 'Node.js',
          source_intake: 'iterations/v1/gate-a-intake/intake.json',
        },
      ],
      reused_question_dispositions: [
        {
          id: 'CQ-1',
          status: 'answered',
          resolution: 'Use the existing Node.js runtime.',
          affects: ['spec.implementation.dependencies'],
          source_spec: 'iterations/v1/gate-b-spec/spec.json',
        },
      ],
    },
  });
  const validated = validateTempIntake(intake);
  assert.equal(validated.baseline_context.reused_answers[0].answer, 'Node.js');
});

test('composition accepts only canonical baseline provenance and detects stale intake lineage', () => {
  const v1Ref = 'iterations/v1/gate-b-spec/spec.json';
  const v2Ref = 'iterations/v2/gate-b-spec/spec.json';
  const v3Ref = 'iterations/v3/gate-b-spec/spec.json';
  const v4Ref = 'iterations/v4/gate-b-spec/spec.json';
  const baseIntake = intakeForInterview('gate_a_confirmed');
  const v1Spec = specForInterview(baseIntake);
  const v2Spec = structuredClone(v1Spec);
  v2Spec.product.target_users = ['Second-iteration operators'];
  const v3Spec = structuredClone(v1Spec);
  v3Spec.product.goals = ['A third-iteration goal based on the stale v1 baseline'];

  const forgedEnvelopeOrder = [
    {
      iteration_id: 'v2',
      spec_ref: v2Ref,
      spec: v2Spec,
    },
    {
      iteration_id: 'v1',
      spec_ref: v1Ref,
      baseline_ref: v2Ref,
      spec: v1Spec,
    },
  ];
  assert.match(
    compositionSourceContractError(forgedEnvelopeOrder),
    /requires preceding baseline lineage or opened_at ordering evidence/,
  );

  const conflictingProvenance = [
    {
      iteration_id: 'v1',
      spec_ref: v1Ref,
      spec: v1Spec,
    },
    {
      iteration_id: 'v2',
      spec_ref: v2Ref,
      metadata: {
        baseline: {
          effective_spec_ref: v1Ref,
        },
      },
      source_intake: {
        baseline_context: {
          spec_ref: 'iterations/unrelated/gate-b-spec/spec.json',
        },
      },
      spec: v2Spec,
    },
  ];
  assert.match(
    compositionSourceContractError(conflictingProvenance),
    /baseline provenance disagrees between iteration metadata and source intake/,
  );

  const omittedAncestor = [
    {
      iteration_id: 'v2',
      spec_ref: v2Ref,
      metadata: {
        baseline: {
          effective_spec_ref: v1Ref,
        },
      },
      source_intake: {
        baseline_context: {
          spec_ref: v1Ref,
        },
      },
      spec: v2Spec,
    },
  ];
  assert.match(
    compositionSourceContractError(omittedAncestor),
    /baseline .* must be included in the composition source closure/,
  );
  const omittedComposedAncestors = [
    {
      iteration_id: 'v2',
      spec_ref: v2Ref,
      metadata: {
        baseline: {
          effective_spec_ref: 'current-spec.json',
        },
      },
      spec: v2Spec,
    },
  ];
  assert.match(
    compositionSourceContractError(omittedComposedAncestors),
    /composed baseline current-spec\.json requires its preceding composition source closure/,
  );
  const v1Source = {
    iteration_id: 'v1',
    spec_ref: v1Ref,
    spec: v1Spec,
  };
  const v2Source = {
    iteration_id: 'v2',
    spec_ref: v2Ref,
    metadata: {
      baseline: {
        effective_spec_ref: v1Ref,
      },
    },
    spec: v2Spec,
  };
  const v3CurrentSpecSource = {
    iteration_id: 'v3',
    spec_ref: v3Ref,
    metadata: {
      baseline: {
        iteration_id: 'v2',
        effective_spec_ref: 'current-spec.json',
      },
    },
    spec: v3Spec,
  };
  const missingCurrentSpecBaselineIdentity = {
    iteration_id: 'v3',
    spec_ref: v3Ref,
    source_intake: {
      baseline_context: {
        spec_ref: 'current-spec.json',
      },
    },
    spec: v3Spec,
  };
  assert.match(
    compositionSourceContractError([v1Source, v2Source, missingCurrentSpecBaselineIdentity]),
    /baseline iteration_id must be a non-empty string when a composed baseline is used/,
  );
  const nullCurrentSpecBaselineIdentity = structuredClone(v3CurrentSpecSource);
  nullCurrentSpecBaselineIdentity.metadata.baseline.iteration_id = null;
  assert.match(
    compositionSourceContractError([v1Source, v2Source, nullCurrentSpecBaselineIdentity]),
    /baseline iteration_id must be a non-empty string when a composed baseline is used/,
  );
  assert.match(
    compositionSourceContractError([v1Source, v3CurrentSpecSource]),
    /baseline iteration v2 must be included in the preceding composition source closure/,
  );
  const skippedCurrentSpecBaseline = structuredClone(v3CurrentSpecSource);
  skippedCurrentSpecBaseline.metadata.baseline.iteration_id = 'v1';
  assert.match(
    compositionSourceContractError([
      v1Source,
      v2Source,
      skippedCurrentSpecBaseline,
    ]),
    /baseline iteration v1 must immediately precede it in composition order/,
  );
  assert.equal(
    compositionSourceContractError([v1Source, v2Source, v3CurrentSpecSource]),
    null,
  );
  const v3SnapshotSource = structuredClone(v3CurrentSpecSource);
  v3SnapshotSource.metadata.baseline.effective_spec_ref =
    'iterations/v3/baseline/current-spec.json';
  v3SnapshotSource.source_intake = {
    baseline_context: {
      spec_ref: 'iterations/v3/baseline/current-spec.json',
    },
  };
  assert.equal(
    compositionSourceContractError([v1Source, v2Source, v3SnapshotSource]),
    null,
  );
  const wrongSnapshotOwner = structuredClone(v3SnapshotSource);
  wrongSnapshotOwner.metadata.baseline.effective_spec_ref =
    'iterations/v2/baseline/current-spec.json';
  wrongSnapshotOwner.source_intake.baseline_context.spec_ref =
    'iterations/v2/baseline/current-spec.json';
  assert.match(
    compositionSourceContractError([v1Source, v2Source, wrongSnapshotOwner]),
    /composed baseline snapshot must be iterations\/v3\/baseline\/current-spec\.json/,
  );

  const staleIntakeBaseline = [
    {
      iteration_id: 'v1',
      spec_ref: v1Ref,
      spec: v1Spec,
    },
    {
      iteration_id: 'v2',
      spec_ref: v2Ref,
      metadata: {
        baseline: {
          effective_spec_ref: v1Ref,
        },
      },
      spec: v2Spec,
    },
    {
      iteration_id: 'v3',
      spec_ref: v3Ref,
      source_intake: {
        baseline_context: {
          spec_ref: v1Ref,
        },
      },
      spec: v3Spec,
    },
  ];
  assert.equal(compositionSourceContractError(staleIntakeBaseline), null);
  const composition = composeCanonicalSpecSources(staleIntakeBaseline);
  assert.deepEqual(
    composition.effectiveProduct.target_users,
    v2Spec.product.target_users,
  );
  assert.equal(
    composition.compositionConflicts.some((conflict) => (
      conflict.field === 'product.target_users'
      && conflict.baseline_ref === v1Ref
    )),
    true,
  );
  assert.equal(
    composition.compositionConflicts.some((conflict) => (
      conflict.field === 'product.goals'
      && conflict.baseline_ref === v1Ref
    )),
    true,
  );

  const v4Spec = structuredClone(v3Spec);
  v4Spec.product.target_users = ['Fourth-iteration branch operators'];
  const staleDescendantComposition = composeCanonicalSpecSources([
    ...staleIntakeBaseline,
    {
      iteration_id: 'v4',
      spec_ref: v4Ref,
      source_intake: {
        baseline_context: {
          spec_ref: v3Ref,
        },
      },
      spec: v4Spec,
    },
  ]);
  assert.deepEqual(
    staleDescendantComposition.effectiveProduct.target_users,
    v2Spec.product.target_users,
  );
  assert.equal(
    staleDescendantComposition.compositionConflicts.some((conflict) => (
      conflict.field === 'product.target_users'
      && conflict.baseline_ref === v3Ref
      && conflict.sources.includes(`${v4Ref}#product.target_users`)
    )),
    true,
  );
  const staleCurrentSpecDescendantComposition = composeCanonicalSpecSources([
    ...staleIntakeBaseline,
    {
      iteration_id: 'v4',
      spec_ref: v4Ref,
      metadata: {
        baseline: {
          iteration_id: 'v3',
          effective_spec_ref: 'current-spec.json',
        },
      },
      spec: v4Spec,
    },
  ]);
  assert.deepEqual(
    staleCurrentSpecDescendantComposition.effectiveProduct.target_users,
    v2Spec.product.target_users,
  );
  assert.equal(
    staleCurrentSpecDescendantComposition.compositionConflicts.some((conflict) => (
      conflict.field === 'product.target_users'
      && conflict.baseline_ref === 'current-spec.json'
      && conflict.sources.includes(`${v4Ref}#product.target_users`)
    )),
    true,
  );
});

test('baseline provenance resolves to matching source artifacts and content', () => {
  const root = makeTempDir('p2a-discovery-baseline-provenance-');
  const artifactRoot = join(root, 'artifacts');
  const sourceIntakeRef = 'iterations/v1/gate-a-intake/intake.json';
  const sourceSpecRef = 'iterations/v1/gate-b-spec/spec.json';
  const sourceIntakePath = join(artifactRoot, sourceIntakeRef);
  const sourceSpecPath = join(artifactRoot, sourceSpecRef);
  const currentIntakePath = join(
    artifactRoot,
    'iterations',
    'v2',
    'gate-a-intake',
    'intake.json',
  );
  try {
    writeJson(
      sourceIntakePath,
      JSON.parse(readFileSync(
        join(FIXTURE_ROOT, 'webhook-api-service', 'intake.answered.json'),
        'utf8',
      )),
    );
    const sourceSpecFixture = JSON.parse(readFileSync(
      join(FIXTURE_ROOT, 'webhook-api-service', 'spec.approved.json'),
      'utf8',
    ));
    sourceSpecFixture.source_intake = '../gate-a-intake/intake.json';
    writeJson(sourceSpecPath, sourceSpecFixture);
    const sourceTaskGraphPath = join(
      artifactRoot,
      'iterations',
      'v1',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const sourceReviewPath = join(
      artifactRoot,
      'iterations',
      'v1',
      'gate-d-review',
      'review.json',
    );
    const sourceTaskGraph = JSON.parse(readFileSync(
      join(FIXTURE_ROOT, 'webhook-api-service', 'task-graph.json'),
      'utf8',
    ));
    sourceTaskGraph.sourceSpec = '../gate-b-spec/spec.json';
    sourceTaskGraph.tasks = sourceTaskGraph.tasks.map((task) => ({
      ...task,
      status: 'done',
    }));
    writeJson(sourceTaskGraphPath, sourceTaskGraph);
    const sourceReview = JSON.parse(readFileSync(
      join(FIXTURE_ROOT, 'webhook-api-service', 'review.json'),
      'utf8',
    ));
    sourceReview.sourceSpec = '../gate-b-spec/spec.json';
    sourceReview.sourceTaskGraph = '../gate-c-task-graph/task-graph.json';
    writeJson(sourceReviewPath, sourceReview);
    const sourceIntake = JSON.parse(readFileSync(sourceIntakePath, 'utf8'));
    const sourceSpec = JSON.parse(readFileSync(sourceSpecPath, 'utf8'));
    const decision = sourceIntake.needs_user_decision[0];
    const disposition = sourceSpec.clarifying_question_disposition[0];
    const resolution = disposition.resolved_by
      ?? disposition.assumption
      ?? disposition.non_goal
      ?? disposition.resolution
      ?? disposition.rationale;
    const intake = intakeForInterview('gate_a_confirmed', {
      baselineContext: {
        spec_ref: sourceSpecRef,
        reused_answers: [
          {
            id: decision.id,
            question: decision.question,
            answer: decision.answer,
            source_intake: sourceIntakeRef,
          },
        ],
        reused_question_dispositions: [
          {
            id: disposition.id,
            status: disposition.status,
            resolution,
            affects: disposition.affects,
            source_spec: sourceSpecRef,
          },
        ],
      },
    });
    writeJson(currentIntakePath, intake);
    assert.doesNotThrow(() => validateIntake(currentIntakePath, { artifactRoot }));

    const draftBaselineSpec = structuredClone(sourceSpec);
    draftBaselineSpec.approval = 'draft';
    delete draftBaselineSpec.approval_audit;
    writeJson(sourceSpecPath, draftBaselineSpec);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /must reference an approved spec with no open_decisions/.test(error.message)
      ),
    );
    writeJson(sourceSpecPath, sourceSpec);

    const handoffProjectRoot = join(root, 'handoff-project');
    const flattenedArtifactRoot = join(
      handoffProjectRoot,
      '.plan2agent',
      'artifacts',
      'sample',
    );
    cpSync(artifactRoot, flattenedArtifactRoot, { recursive: true });
    const flattenedIntakePath = join(
      flattenedArtifactRoot,
      'gate-a-intake',
      'intake.json',
    );
    writeJson(flattenedIntakePath, intake);
    writeJson(join(handoffProjectRoot, '.plan2agent', 'current-spec.json'), {
      schema_version: 'p2a.current_spec.v1',
      project_id: 'sample',
      effective_spec_ref: 'current-spec.json',
    });
    const flattenedValidation = runValidator(['--intake', flattenedIntakePath]);
    assert.equal(
      flattenedValidation.status,
      0,
      `${flattenedValidation.stdout}${flattenedValidation.stderr}`,
    );

    const unrelatedIntakeRef = 'iterations/unrelated/gate-a-intake/intake.json';
    const unrelatedSpecRef = 'iterations/unrelated/gate-b-spec/spec.json';
    writeJson(join(artifactRoot, unrelatedIntakeRef), sourceIntake);
    const unrelatedSpec = structuredClone(sourceSpec);
    unrelatedSpec.source_intake = '../gate-a-intake/intake.json';
    writeJson(join(artifactRoot, unrelatedSpecRef), unrelatedSpec);

    const unrelatedAnswerSource = structuredClone(intake);
    unrelatedAnswerSource.baseline_context.reused_answers[0].source_intake = unrelatedIntakeRef;
    writeJson(currentIntakePath, unrelatedAnswerSource);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /reused_answers\[0\]\.source_intake does not belong to the baseline spec source closure/.test(error.message)
      ),
    );

    const unrelatedDispositionSource = structuredClone(intake);
    unrelatedDispositionSource.baseline_context.reused_question_dispositions[0].source_spec = unrelatedSpecRef;
    writeJson(currentIntakePath, unrelatedDispositionSource);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /reused_question_dispositions\[0\]\.source_spec does not belong to the baseline spec source closure/.test(error.message)
      ),
    );

    const wrongSpecKind = structuredClone(intake);
    wrongSpecKind.baseline_context.spec_ref = sourceIntakeRef;
    writeJson(currentIntakePath, wrongSpecKind);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /spec_ref must reference a p2a\.spec\.v1 artifact/.test(error.message)
      ),
    );

    const driftedAnswer = structuredClone(intake);
    driftedAnswer.baseline_context.reused_answers[0].answer = 'A different runtime';
    writeJson(currentIntakePath, driftedAnswer);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /does not contain matching answered decision ND-1/.test(error.message)
      ),
    );

    const driftedDisposition = structuredClone(intake);
    driftedDisposition.baseline_context.reused_question_dispositions[0].resolution = 'Different handling';
    writeJson(currentIntakePath, driftedDisposition);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /does not contain matching disposition CQ-1/.test(error.message)
      ),
    );

    const composedSpecRef = 'composed-current-spec.json';
    const composedSpecPath = join(artifactRoot, composedSpecRef);
    const composedBaseline = {
      schema_version: 'p2a.current_spec.v1',
      project_id: sourceSpec.project_id,
      active_iteration: 'v1',
      composed_from: ['v1'],
      effective_spec_ref: 'current-spec.json',
      source_specs: [
        {
          iteration_id: 'v1',
          spec_ref: sourceSpecRef,
          status: 'close-ready',
          approval: 'approved',
        },
      ],
      effective_product: structuredClone(sourceSpec.product),
      effective_implementation: structuredClone(sourceSpec.implementation),
      open_decisions: [],
    };
    writeJson(composedSpecPath, composedBaseline);
    const composedIntake = structuredClone(intake);
    composedIntake.baseline_context.spec_ref = composedSpecRef;
    writeJson(currentIntakePath, composedIntake);
    assert.doesNotThrow(() => validateIntake(currentIntakePath, { artifactRoot }));

    const immutableSnapshotRef = 'iterations/v2/baseline/current-spec.json';
    const immutableSnapshotPath = join(artifactRoot, immutableSnapshotRef);
    writeJson(immutableSnapshotPath, composedBaseline);
    const immutableSnapshotIntake = structuredClone(intake);
    immutableSnapshotIntake.baseline_context.spec_ref = immutableSnapshotRef;
    writeJson(currentIntakePath, immutableSnapshotIntake);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /spec_sha256 is required for an immutable composed baseline snapshot/.test(
          error.message,
        )
      ),
    );
    immutableSnapshotIntake.baseline_context.spec_sha256 =
      jsonSha256(composedBaseline);
    writeJson(currentIntakePath, immutableSnapshotIntake);
    assert.doesNotThrow(() => validateIntake(currentIntakePath, { artifactRoot }));
    writeJson(immutableSnapshotPath, {
      ...composedBaseline,
      note: 'Tampered after the baseline hash was recorded.',
    });
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /spec_sha256 does not match/.test(error.message)
      ),
    );
    writeJson(immutableSnapshotPath, composedBaseline);
    writeJson(currentIntakePath, composedIntake);

    const missingActiveIteration = structuredClone(composedBaseline);
    delete missingActiveIteration.active_iteration;
    writeJson(composedSpecPath, missingActiveIteration);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /must have a non-empty active_iteration/.test(error.message)
      ),
    );

    const unanchoredComposedBaseline = structuredClone(composedBaseline);
    unanchoredComposedBaseline.composed_from = [];
    unanchoredComposedBaseline.source_specs = [];
    writeJson(composedSpecPath, unanchoredComposedBaseline);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /composed current spec must have a non-empty source_specs array/.test(error.message)
      ),
    );

    const mismatchedComposition = structuredClone(composedBaseline);
    mismatchedComposition.composed_from = ['unrelated-iteration'];
    writeJson(composedSpecPath, mismatchedComposition);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /composed_from must exactly match unique source_specs iteration_id values in order/.test(error.message)
      ),
    );

    const untraceableComposedBaseline = structuredClone(composedBaseline);
    untraceableComposedBaseline.effective_product.target_users = ['Unrelated fabricated users'];
    writeJson(composedSpecPath, untraceableComposedBaseline);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /effective sections must exactly match ordered source composition/.test(error.message)
      ),
    );

    const secondSourceIntakeRef = 'iterations/v-next/gate-a-intake/intake.json';
    const secondSourceSpecRef = 'iterations/v-next/gate-b-spec/spec.json';
    writeJson(join(artifactRoot, secondSourceIntakeRef), sourceIntake);
    const secondSourceSpec = structuredClone(sourceSpec);
    secondSourceSpec.product.target_users = ['Second-iteration operators'];
    secondSourceSpec.approval_audit.approved_artifacts = [secondSourceSpecRef];
    writeJson(join(artifactRoot, secondSourceSpecRef), secondSourceSpec);
    const secondSourceTaskGraphPath = join(
      artifactRoot,
      'iterations',
      'v-next',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const secondSourceReviewPath = join(
      artifactRoot,
      'iterations',
      'v-next',
      'gate-d-review',
      'review.json',
    );
    writeJson(secondSourceTaskGraphPath, sourceTaskGraph);
    writeJson(secondSourceReviewPath, sourceReview);

    const unprovenReversedComposition = structuredClone(composedBaseline);
    unprovenReversedComposition.composed_from = ['v-next', 'v1'];
    unprovenReversedComposition.source_specs = [
      {
        iteration_id: 'v-next',
        spec_ref: secondSourceSpecRef,
        status: 'archived',
        approval: 'approved',
      },
      ...unprovenReversedComposition.source_specs,
    ];
    writeJson(composedSpecPath, unprovenReversedComposition);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /requires preceding baseline lineage or opened_at ordering evidence/.test(error.message)
      ),
    );

    writeJson(join(artifactRoot, 'iterations/v-next/iteration.json'), {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: sourceSpec.project_id,
      iteration_id: 'v-next',
      opened_at: '2026-07-30T00:00:00.000Z',
      baseline: {
        effective_spec_ref: sourceSpecRef,
      },
    });
    const duplicateSourceComposedBaseline = structuredClone(composedBaseline);
    duplicateSourceComposedBaseline.composed_from = ['v1', 'v-next'];
    duplicateSourceComposedBaseline.source_specs.push({
      iteration_id: 'v-next',
      spec_ref: sourceSpecRef,
      status: 'archived',
      approval: 'approved',
    });
    writeJson(composedSpecPath, duplicateSourceComposedBaseline);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /source v-next spec_ref must be iterations\/v-next\/gate-b-spec\/spec\.json/.test(
          error.message,
        )
      ),
    );

    const mismatchedSourceIdentity = structuredClone(composedBaseline);
    mismatchedSourceIdentity.composed_from = ['v1', 'v-next'];
    mismatchedSourceIdentity.source_specs.push({
      iteration_id: 'v-next',
      spec_ref: unrelatedSpecRef,
      status: 'archived',
      approval: 'approved',
    });
    writeJson(composedSpecPath, mismatchedSourceIdentity);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /source v-next spec_ref must be iterations\/v-next\/gate-b-spec\/spec\.json/.test(error.message)
      ),
    );

    const reversedComposedBaseline = structuredClone(composedBaseline);
    reversedComposedBaseline.active_iteration = 'v-next';
    reversedComposedBaseline.composed_from = ['v-next', 'v1'];
    reversedComposedBaseline.source_specs = [
      {
        iteration_id: 'v-next',
        spec_ref: secondSourceSpecRef,
        status: 'close-ready',
        approval: 'approved',
      },
      {
        ...reversedComposedBaseline.source_specs[0],
        status: 'archived',
      },
    ];
    writeJson(composedSpecPath, reversedComposedBaseline);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /baseline .* must precede it in composition order/.test(error.message)
      ),
    );

    const staleComposedBaseline = structuredClone(composedBaseline);
    staleComposedBaseline.active_iteration = 'v-next';
    staleComposedBaseline.composed_from = ['v1', 'v-next'];
    staleComposedBaseline.source_specs[0].status = 'archived';
    staleComposedBaseline.source_specs.push({
      iteration_id: 'v-next',
      spec_ref: secondSourceSpecRef,
      status: 'close-ready',
      approval: 'approved',
    });
    writeJson(composedSpecPath, staleComposedBaseline);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /effective sections must exactly match ordered source composition/.test(error.message)
      ),
    );

    const selfCycleSpecRef = 'iterations/v2/gate-b-spec/spec.json';
    const selfCycleSpec = structuredClone(sourceSpec);
    selfCycleSpec.source_intake = '../gate-a-intake/intake.json';
    selfCycleSpec.approval_audit.approved_artifacts = [selfCycleSpecRef];
    writeJson(join(artifactRoot, selfCycleSpecRef), selfCycleSpec);
    const selfCycleIntake = structuredClone(intake);
    selfCycleIntake.baseline_context = {
      spec_ref: selfCycleSpecRef,
      reused_answers: [],
      reused_question_dispositions: [],
    };
    writeJson(currentIntakePath, selfCycleIntake);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /baseline_context provenance contains a cycle/.test(error.message)
      ),
    );

    const cycleAIntakeRef = 'iterations/cycle-a/gate-a-intake/intake.json';
    const cycleASpecRef = 'iterations/cycle-a/gate-b-spec/spec.json';
    const cycleBIntakeRef = 'iterations/cycle-b/gate-a-intake/intake.json';
    const cycleBSpecRef = 'iterations/cycle-b/gate-b-spec/spec.json';
    const cycleAIntake = structuredClone(intake);
    cycleAIntake.baseline_context = {
      spec_ref: cycleBSpecRef,
      reused_answers: [],
      reused_question_dispositions: [],
    };
    const cycleBIntake = structuredClone(intake);
    cycleBIntake.baseline_context = {
      spec_ref: cycleASpecRef,
      reused_answers: [],
      reused_question_dispositions: [],
    };
    const cycleASpec = structuredClone(sourceSpec);
    cycleASpec.source_intake = '../gate-a-intake/intake.json';
    cycleASpec.approval_audit.approved_artifacts = [cycleASpecRef];
    const cycleBSpec = structuredClone(sourceSpec);
    cycleBSpec.source_intake = '../gate-a-intake/intake.json';
    cycleBSpec.approval_audit.approved_artifacts = [cycleBSpecRef];
    writeJson(join(artifactRoot, cycleAIntakeRef), cycleAIntake);
    writeJson(join(artifactRoot, cycleASpecRef), cycleASpec);
    writeJson(join(artifactRoot, cycleBIntakeRef), cycleBIntake);
    writeJson(join(artifactRoot, cycleBSpecRef), cycleBSpec);
    assert.throws(
      () => validateIntake(join(artifactRoot, cycleAIntakeRef), { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /baseline_context provenance contains a cycle/.test(error.message)
      ),
    );

    const nestedInvalidSourceIntake = structuredClone(sourceIntake);
    nestedInvalidSourceIntake.baseline_context = {
      spec_ref: 'missing/spec.json',
      reused_answers: [],
      reused_question_dispositions: [],
    };
    writeJson(sourceIntakePath, nestedInvalidSourceIntake);
    writeJson(currentIntakePath, intake);
    assert.throws(
      () => validateIntake(currentIntakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /baseline_context\.spec_ref is missing/.test(error.message)
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('iteration validation replays composed effective sections from canonical sources', () => {
  const root = makeTempDir('p2a-discovery-iteration-composition-');
  const artifactRoot = join(root, 'artifacts');
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  try {
    cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, {
      recursive: true,
    });
    let result = runIteration(['init', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const v1SpecRef = 'iterations/v1-mvp/gate-b-spec/spec.json';
    const v1IntakePath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-a-intake',
      'intake.json',
    );
    const v1Spec = JSON.parse(readFileSync(join(artifactRoot, v1SpecRef), 'utf8'));
    const v2SpecRef = 'iterations/v2/gate-b-spec/spec.json';
    const v2IntakePath = join(
      artifactRoot,
      'iterations',
      'v2',
      'gate-a-intake',
      'intake.json',
    );
    const v2Spec = structuredClone(v1Spec);
    v2Spec.source_intake = '../gate-a-intake/intake.json';
    v2Spec.product.target_users = ['Second-iteration operators'];
    v2Spec.approval_audit.approved_artifacts = [v2SpecRef];
    mkdirSync(dirname(v2IntakePath), { recursive: true });
    writeFileSync(v2IntakePath, readFileSync(v1IntakePath));
    writeJson(join(artifactRoot, v2SpecRef), v2Spec);
    const v1TaskGraphPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const v1ReviewPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-d-review',
      'review.json',
    );
    const v2TaskGraphPath = join(
      artifactRoot,
      'iterations',
      'v2',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const v2ReviewPath = join(
      artifactRoot,
      'iterations',
      'v2',
      'gate-d-review',
      'review.json',
    );
    mkdirSync(dirname(v2TaskGraphPath), { recursive: true });
    mkdirSync(dirname(v2ReviewPath), { recursive: true });
    writeFileSync(v2TaskGraphPath, readFileSync(v1TaskGraphPath));
    writeFileSync(v2ReviewPath, readFileSync(v1ReviewPath));
    writeJson(join(artifactRoot, 'iterations', 'v2', 'iteration.json'), {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: v1Spec.project_id,
      iteration_id: 'v2',
      status: 'archived',
      opened_at: '2026-07-30T00:00:00.000Z',
      baseline: {
        effective_spec_ref: v1SpecRef,
      },
    });

    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.composed_from = ['v1-mvp', 'v2'];
    currentSpec.effective_spec_ref = 'current-spec.json';
    currentSpec.source_specs = [
      {
        iteration_id: 'v1-mvp',
        spec_ref: v1SpecRef,
        status: 'close-ready',
        approval: 'approved',
      },
      {
        iteration_id: 'v2',
        spec_ref: v2SpecRef,
        status: 'archived',
        approval: 'approved',
      },
    ];
    currentSpec.effective_product = structuredClone(v1Spec.product);
    currentSpec.effective_implementation = structuredClone(v1Spec.implementation);
    currentSpec.open_decisions = [];
    writeJson(currentSpecPath, currentSpec);

    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json source_specs v1-mvp must be close-ready; incomplete tasks:/,
    );
    for (const taskGraphPath of [v1TaskGraphPath, v2TaskGraphPath]) {
      const taskGraph = JSON.parse(readFileSync(taskGraphPath, 'utf8'));
      taskGraph.sourceSpec = '../gate-b-spec/spec.json';
      taskGraph.tasks = taskGraph.tasks.map((task) => ({
        ...task,
        status: 'done',
      }));
      writeJson(taskGraphPath, taskGraph);
    }

    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--allow-planning',
      '--stage',
      'gate-a',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /current-spec\.json effective sections must exactly match ordered source composition/,
    );

    const replayedComposition = composeCanonicalSpecSources([
      {
        iteration_id: 'v1-mvp',
        spec_ref: v1SpecRef,
        spec: v1Spec,
        metadata: null,
        source_intake: JSON.parse(readFileSync(v1IntakePath, 'utf8')),
      },
      {
        iteration_id: 'v2',
        spec_ref: v2SpecRef,
        spec: v2Spec,
        metadata: JSON.parse(readFileSync(
          join(artifactRoot, 'iterations', 'v2', 'iteration.json'),
          'utf8',
        )),
        source_intake: JSON.parse(readFileSync(v2IntakePath, 'utf8')),
      },
    ]);
    currentSpec.effective_product = replayedComposition.effectiveProduct;
    currentSpec.effective_implementation = replayedComposition.effectiveImplementation;
    currentSpec.superseded_refs = [];
    currentSpec.composition_conflicts = replayedComposition.compositionConflicts;
    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json superseded_refs must exactly match ordered source composition/,
    );

    currentSpec.superseded_refs = replayedComposition.supersededRefs;
    currentSpec.composition_conflicts = [{
      field: 'product.target_users',
      reason: 'forged',
      sources: [],
    }];
    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json composition_conflicts must exactly match ordered source composition/,
    );

    currentSpec.composition_conflicts = replayedComposition.compositionConflicts;
    currentSpec.open_decisions = [{
      id: 'CD-forged',
      type: 'composition_conflict',
      question: 'Forged composition decision',
      affects: ['product.target_users'],
      status: 'open',
      sources: [],
    }];
    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json open_decisions must exactly match replayed composition conflicts/,
    );

    currentSpec.open_decisions = [];
    assert.doesNotThrow(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
    );

    currentSpec.effective_spec_ref = v1SpecRef;
    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json effective_spec_ref must be "current-spec\.json" for composition/,
    );
    currentSpec.effective_spec_ref = 'current-spec.json';

    currentSpec.source_specs[0].approval = '';
    assert.throws(
      () => validateCurrentSpecCompositionData(currentSpec, artifactRoot),
      /current-spec\.json source_specs v1-mvp approval does not match source spec/,
    );
    currentSpec.source_specs[0].approval = 'approved';

    const unsafeIterationCurrentSpec = structuredClone(currentSpec);
    unsafeIterationCurrentSpec.composed_from[0] = '../../outside';
    unsafeIterationCurrentSpec.source_specs[0] = {
      ...unsafeIterationCurrentSpec.source_specs[0],
      iteration_id: '../../outside',
      spec_ref: 'iterations/../../outside/gate-b-spec/spec.json',
    };
    assert.throws(
      () => validateCurrentSpecCompositionData(unsafeIterationCurrentSpec, artifactRoot),
      /source_specs\[\]\.iteration_id must be a safe single path segment/,
    );

    const outsideSpecPath = join(root, 'outside', 'gate-b-spec', 'spec.json');
    const outsideIntakePath = join(root, 'outside', 'gate-a-intake', 'intake.json');
    const outsideSpec = structuredClone(v1Spec);
    outsideSpec.source_intake = '../gate-a-intake/intake.json';
    mkdirSync(dirname(outsideIntakePath), { recursive: true });
    writeFileSync(outsideIntakePath, readFileSync(v1IntakePath));
    writeJson(outsideSpecPath, outsideSpec);
    const escapingSourceCurrentSpec = structuredClone(currentSpec);
    escapingSourceCurrentSpec.composed_from = ['outside'];
    escapingSourceCurrentSpec.source_specs = [{
      iteration_id: 'outside',
      spec_ref: '../outside/gate-b-spec/spec.json',
      status: 'archived',
      approval: 'approved',
    }];
    escapingSourceCurrentSpec.effective_product = structuredClone(outsideSpec.product);
    escapingSourceCurrentSpec.effective_implementation = structuredClone(
      outsideSpec.implementation,
    );
    escapingSourceCurrentSpec.superseded_refs = [];
    escapingSourceCurrentSpec.composition_conflicts = [];
    assert.throws(
      () => validateCurrentSpecCompositionData(escapingSourceCurrentSpec, artifactRoot),
      /source_specs outside\.spec_ref must resolve inside the artifact root/,
    );

    const outsideSourceIntakePath = join(root, 'outside-source-intake.json');
    writeFileSync(outsideSourceIntakePath, readFileSync(v1IntakePath));
    const internalSpecWithExternalIntake = structuredClone(v1Spec);
    internalSpecWithExternalIntake.source_intake = outsideSourceIntakePath;
    writeJson(join(artifactRoot, v1SpecRef), internalSpecWithExternalIntake);
    const escapingIntakeCurrentSpec = structuredClone(currentSpec);
    escapingIntakeCurrentSpec.active_iteration = 'v1-mvp';
    escapingIntakeCurrentSpec.composed_from = ['v1-mvp'];
    escapingIntakeCurrentSpec.source_specs = [{
      iteration_id: 'v1-mvp',
      spec_ref: v1SpecRef,
      status: 'archived',
      approval: 'approved',
    }];
    escapingIntakeCurrentSpec.effective_product =
      structuredClone(internalSpecWithExternalIntake.product);
    escapingIntakeCurrentSpec.effective_implementation =
      structuredClone(internalSpecWithExternalIntake.implementation);
    escapingIntakeCurrentSpec.superseded_refs = [];
    escapingIntakeCurrentSpec.composition_conflicts = [];
    escapingIntakeCurrentSpec.open_decisions = [];
    assert.throws(
      () => validateCurrentSpecCompositionData(
        escapingIntakeCurrentSpec,
        artifactRoot,
      ),
      /spec\.source_intake resolves outside the artifact root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone baseline provenance validation requires an artifact root', () => {
  const root = makeTempDir('p2a-discovery-standalone-provenance-');
  const intakePath = join(root, 'intake.json');
  try {
    writeJson(
      intakePath,
      intakeForInterview('gate_a_confirmed', {
        baselineContext: {
          spec_ref: 'missing/spec.json',
          reused_answers: [],
          reused_question_dispositions: [],
        },
      }),
    );
    const result = runValidator(['--intake', intakePath]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context provenance requires --artifact-root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff readiness requires Gate A approval', () => {
  const root = makeTempDir('p2a-discovery-handoff-gate-a-');
  try {
    writeJson(
      join(root, 'gate-a-intake', 'intake.json'),
      intakeForInterview('ready_for_gate_a_summary'),
    );
    assert.throws(
      () => validateHandoffReadyArtifactRoot(root),
      (error) => (
        error instanceof ValidationError
        && /Gate A intake is not approved/.test(error.message)
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('p2a next exposes one interview-aware action for every Gate A transition', () => {
  const cases = [
    ['interview_active', {}, 'gate_a_interview_active', 'skill', 'resume_from: interview'],
    ['ready_for_gate_a_summary', {}, 'gate_a_summary_ready', 'skill', 'resume_from: gate-a-summary'],
    ['awaiting_gate_a_confirmation', {}, 'gate_a_needs_confirmation', 'approval', 'record the Gate A approval_audit'],
    ['paused', { round: 3, stopReason: 'soft_limit' }, 'gate_a_interview_paused', 'approval', 'Choose whether to continue'],
    ['blocked_on_user', { round: 5, stopReason: 'hard_limit' }, 'gate_a_blocked_on_user', 'approval', 'remaining blockers'],
    ['gate_a_confirmed', {}, 'gate_a_confirmed_ready_for_spec', 'skill', 'resume_from: spec'],
  ];
  for (const [interviewState, options, expectedState, kind, displayFragment] of cases) {
    const intake = intakeForInterview(interviewState, options);
    validateTempIntake(intake);
    const payload = nextForIntake(intake);
    assert.equal(payload.state, expectedState);
    assert.equal(payload.command.kind, kind);
    assert.match(payload.command.display, new RegExp(displayFragment));
  }
});

test('p2a next prioritizes changed Gate A over an existing stale Gate B', () => {
  const root = makeTempDir('p2a-discovery-stale-gate-b-next-');
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'sample');
  const intakePath = join(artifactRoot, 'gate-a-intake', 'intake.json');
  const specPath = join(artifactRoot, 'gate-b-spec', 'spec.json');
  try {
    writeJson(join(root, '.plan2agent', 'manifest.json'), {
      provenance: { mode: 'scaffold' },
      enhancements: {},
    });

    const activeIntake = intakeForInterview('interview_active');
    writeJson(intakePath, activeIntake);
    writeFileSync(join(artifactRoot, 'status.md'), '# fixture\n', 'utf8');
    writeJson(specPath, {
      approval: 'approved',
      source_intake_sha256: jsonSha256(activeIntake),
    });
    let result = runP2a(['next', '--target', root, '--json']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    let payload = JSON.parse(result.stdout);
    assert.equal(payload.state, 'gate_a_interview_active');
    assert.equal(payload.command.display, '/p2a-harness resume_from: interview');

    const confirmedIntake = intakeForInterview('gate_a_confirmed');
    writeJson(intakePath, confirmedIntake);
    writeJson(specPath, {
      approval: 'approved',
      source_intake_sha256: '0'.repeat(64),
    });
    result = runP2a(['next', '--target', root, '--json']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    payload = JSON.parse(result.stdout);
    assert.equal(payload.state, 'gate_a_confirmed_ready_for_spec');
    assert.equal(payload.command.display, '/p2a-harness resume_from: spec');

    const validSpec = specForInterview(confirmedIntake);
    validSpec.source_intake_sha256 = jsonSha256(confirmedIntake);
    validSpec.approval = 'approved';
    validSpec.approval_audit = {
      approved_by: 'user',
      approved_at: '2026-07-31',
      approved_artifacts: ['gate-b-spec/spec.json'],
      approval_note: 'Fixture user approved the Gate B spec.',
    };
    validSpec.evidence.push({
      source_id: 'WEB-1',
      title: 'Target runtime conventions',
      url: 'https://nodejs.org/docs/latest/api/',
      used_for: 'Confirmed the target runtime and dependency conventions.',
    });
    writeJson(specPath, validSpec);
    result = runP2a(['next', '--target', root, '--json']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    payload = JSON.parse(result.stdout);
    assert.equal(
      payload.state,
      'gate_b_approved_needs_tasks',
      JSON.stringify(payload),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('p2a next points iterative Gate A approval actions at the active intake', () => {
  const intake = intakeForInterview('paused', {
    round: 3,
    stopReason: 'soft_limit',
  });
  const { payload, intakePath } = nextForIterativeIntake(intake);
  assert.equal(payload.state, 'gate_a_interview_paused');
  assert.equal(payload.command.kind, 'approval');
  assert.match(payload.command.display, new RegExp(intakePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('draft --force protects execution history and invalidates every downstream gate before restarting Gate A', () => {
  const root = makeTempDir('p2a-discovery-force-reset-');
  const artifactRoot = join(
    root,
    '.plan2agent',
    'artifacts',
    'webhook-api-service',
  );
  const iterationId = 'iter-002';
  const iterationRoot = join(artifactRoot, 'iterations', iterationId);
  const intakePath = join(iterationRoot, 'gate-a-intake', 'intake.json');
  const specPath = join(iterationRoot, 'gate-b-spec', 'spec.json');
  const taskGraphPath = join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
  const promotedDraftPath = join(iterationRoot, 'gate-c-task-graph', 'task-graph.draft.json.promoted');
  const draftMetaPath = join(iterationRoot, 'gate-c-task-graph', 'task-graph.draft.meta.json');
  const reviewPath = join(iterationRoot, 'gate-d-review', 'review.json');
  const reviewReportPath = join(iterationRoot, 'gate-d-review', 'review-report.md');
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const metadataPath = join(iterationRoot, 'iteration.json');
  const statusPath = join(artifactRoot, 'status.md');
  const intakeViewPath = join(iterationRoot, 'gate-a-intake', 'intake.md');
  const productSpecPath = join(iterationRoot, 'gate-b-spec', 'product-spec.md');
  const implementationPlanPath = join(iterationRoot, 'gate-b-spec', 'implementation-plan.md');

  try {
    cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, { recursive: true });

    let result = runIteration(['init', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const baselineTaskGraphPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const baselineSpecPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-b-spec',
      'spec.json',
    );
    const baselineSpec = JSON.parse(readFileSync(baselineSpecPath, 'utf8'));
    baselineSpec.source_intake = '.plan2agent/artifacts/webhook-api-service/iterations/v1-mvp/gate-a-intake/intake.json';
    writeJson(baselineSpecPath, baselineSpec);
    const baselineTaskGraph = JSON.parse(readFileSync(baselineTaskGraphPath, 'utf8'));
    baselineTaskGraph.tasks = baselineTaskGraph.tasks.map((task) => ({ ...task, status: 'done' }));
    writeJson(baselineTaskGraphPath, baselineTaskGraph);

    result = runIteration(['close', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runIteration([
      'open',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      iterationId,
      '--idea',
      'Add a delivery dashboard',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const generatedIntake = JSON.parse(readFileSync(intakePath, 'utf8'));
    const generatedMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const generatedCurrentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    const externalBaselinePath = join(root, 'external-baseline-spec.json');
    writeFileSync(
      externalBaselinePath,
      readFileSync(
        join(artifactRoot, 'iterations', 'v1-mvp', 'gate-b-spec', 'spec.json'),
      ),
    );
    const externalBaselineIntake = structuredClone(generatedIntake);
    externalBaselineIntake.baseline_context.spec_ref = externalBaselinePath;
    const externalBaselineMetadata = structuredClone(generatedMetadata);
    externalBaselineMetadata.baseline.effective_spec_ref = externalBaselinePath;
    const externalBaselineCurrentSpec = structuredClone(generatedCurrentSpec);
    externalBaselineCurrentSpec.pending_iteration.baseline_effective_spec_ref =
      externalBaselinePath;
    writeJson(intakePath, externalBaselineIntake);
    writeJson(metadataPath, externalBaselineMetadata);
    writeJson(currentSpecPath, externalBaselineCurrentSpec);
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--allow-planning',
      '--stage',
      'gate-a',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /pending_iteration\.baseline_effective_spec_ref must resolve inside the artifact root/,
    );
    writeJson(intakePath, generatedIntake);
    writeJson(metadataPath, generatedMetadata);
    writeJson(currentSpecPath, generatedCurrentSpec);

    const alternateBaselineRef = 'iterations/alternate/gate-b-spec/spec.json';
    writeJson(
      join(artifactRoot, alternateBaselineRef),
      JSON.parse(readFileSync(
        join(artifactRoot, 'iterations', 'v1-mvp', 'gate-b-spec', 'spec.json'),
        'utf8',
      )),
    );
    const mismatchedBaselineIntake = structuredClone(generatedIntake);
    mismatchedBaselineIntake.baseline_context.spec_ref = alternateBaselineRef;
    writeJson(intakePath, mismatchedBaselineIntake);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context\.spec_ref .* must match pending baseline/,
    );
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--allow-planning',
      '--stage',
      'gate-a',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context\.spec_ref .* must match pending baseline/,
    );
    writeJson(intakePath, generatedIntake);
    const mismatchedBaselineMetadata = structuredClone(generatedMetadata);
    mismatchedBaselineMetadata.baseline.effective_spec_sha256 = '0'.repeat(64);
    writeJson(metadataPath, mismatchedBaselineMetadata);
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--allow-planning',
      '--stage',
      'gate-a',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /pending and iteration metadata baseline effective spec hashes must match/,
    );
    writeJson(metadataPath, generatedMetadata);

    const confirmedIntake = confirmGeneratedIntake(
      intakePath,
      `iterations/${iterationId}/gate-a-intake/intake.json`,
    );
    confirmedIntake.clarifying_questions = [];
    confirmedIntake.needs_user_decision = [];
    confirmedIntake.interview.asked_question_ids = [];
    confirmedIntake.interview.discovery_dimensions = confirmedIntake.interview.discovery_dimensions
      .map((dimension) => ({
        ...dimension,
        affected_fields: dimension.dimension === 'target_users'
          ? ['spec.product.target_users']
          : [],
      }));
    confirmedIntake.interview.spec_updates = [
      {
        field: 'spec.product.target_users',
        operation: 'replace',
        values: ['Delivery dashboard operators'],
        source_question_ids: [],
        source_dimension_ids: ['target_users'],
      },
    ];
    confirmedIntake.baseline_context.reused_answers = [];
    confirmedIntake.baseline_context.reused_question_dispositions = [];

    const noOpIntake = structuredClone(confirmedIntake);
    noOpIntake.interview.spec_updates[0].operation = 'append';
    noOpIntake.interview.spec_updates[0].values = [baselineSpec.product.target_users[0]];
    writeJson(intakePath, noOpIntake);
    assert.throws(
      () => validateIntake(intakePath, { artifactRoot }),
      (error) => (
        error instanceof ValidationError
        && /did not change the canonical Gate B field/.test(error.message)
      ),
    );
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /did not change the canonical Gate B field/,
    );

    const removeNoOpIntake = structuredClone(confirmedIntake);
    removeNoOpIntake.interview.spec_updates[0].operation = 'remove';
    removeNoOpIntake.interview.spec_updates[0].values = ['A target user absent from the baseline'];
    writeJson(intakePath, removeNoOpIntake);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /did not change the canonical Gate B field/,
    );

    const removeAllTargetUsersIntake = structuredClone(confirmedIntake);
    removeAllTargetUsersIntake.interview.spec_updates[0].operation = 'remove';
    removeAllTargetUsersIntake.interview.spec_updates[0].values = [
      ...baselineSpec.product.target_users,
    ];
    writeJson(intakePath, removeAllTargetUsersIntake);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /spec\.product\.target_users must not leave the canonical Gate B field empty/,
    );

    writeJson(intakePath, confirmedIntake);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    assert.match(spec.source_intake_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      spec.product.target_users,
      ['Delivery dashboard operators'],
      'structured Gate A replace must remove baseline target users',
    );
    for (const [field, baselineValue] of Object.entries(baselineSpec.product)) {
      if (field === 'target_users') continue;
      assert.deepEqual(
        spec.product[field],
        baselineValue,
        `delta synthesis changed unclaimed product field ${field}`,
      );
    }
    for (const [field, baselineValue] of Object.entries(baselineSpec.implementation)) {
      assert.deepEqual(
        spec.implementation[field],
        baselineValue,
        `delta synthesis changed unclaimed implementation field ${field}`,
      );
    }

    const staleGateBIntake = structuredClone(confirmedIntake);
    staleGateBIntake.baseline_context.spec_ref = alternateBaselineRef;
    writeJson(intakePath, staleGateBIntake);
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--allow-planning',
      '--stage',
      'gate-b-draft',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context\.spec_ref .* must match pending baseline/,
    );
    result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /baseline_context\.spec_ref .* must match pending baseline/,
    );
    writeJson(intakePath, confirmedIntake);

    const droppedGateAUpdateSpec = structuredClone(spec);
    droppedGateAUpdateSpec.product.target_users = [...baselineSpec.product.target_users];
    writeJson(specPath, droppedGateAUpdateSpec);
    result = runValidator(['--spec', specPath, '--intake', intakePath]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /spec spec\.product\.target_users must equal the baseline value after applying Gate A spec_updates/,
    );
    writeJson(specPath, spec);

    const alternateIntakePath = join(dirname(intakePath), 'alternate-intake.json');
    writeFileSync(alternateIntakePath, readFileSync(intakePath));
    const mismatchedSourceSpec = structuredClone(spec);
    mismatchedSourceSpec.source_intake = '../gate-a-intake/alternate-intake.json';
    writeJson(specPath, mismatchedSourceSpec);
    result = runValidator(['--spec', specPath, '--intake', intakePath]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /provided intake does not match spec\.source_intake/,
    );
    writeJson(specPath, spec);

    const specWithoutIntakeHash = structuredClone(spec);
    delete specWithoutIntakeHash.source_intake_sha256;
    writeJson(specPath, specWithoutIntakeHash);
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--stage',
      'gate-b-draft',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /interview-aware specs must include source_intake_sha256/,
    );
    writeJson(specPath, spec);

    const changedIntake = structuredClone(confirmedIntake);
    changedIntake.interview.spec_updates[0].values[0] += ' changed after Gate B';
    writeJson(intakePath, changedIntake);
    result = runIteration([
      'validate',
      '--artifacts',
      artifactRoot,
      '--stage',
      'gate-b-draft',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /source_intake_sha256 does not match/);
    writeJson(intakePath, confirmedIntake);

    spec.approval = 'approved';
    spec.approval_audit = {
      approved_by: 'user',
      approved_at: '2026-07-29',
      approved_artifacts: [`iterations/${iterationId}/gate-b-spec/spec.json`],
      approval_note: 'Fixture user approved the regenerated Gate B spec.',
    };
    writeJson(specPath, spec);
    result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runIteration(['diff-tasks', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runIteration([
      'promote-tasks',
      '--artifacts',
      artifactRoot,
      '--approved-by',
      'user',
      '--approval-note',
      'Fixture user approved the Gate C graph.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const baselineReviewPath = join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-d-review',
      'review.json',
    );
    const review = JSON.parse(readFileSync(baselineReviewPath, 'utf8'));
    review.sourceSpec = '../gate-b-spec/spec.json';
    review.sourceTaskGraph = '../gate-c-task-graph/task-graph.json';
    writeJson(reviewPath, review);
    writeFileSync(reviewReportPath, '# Stale Gate D review\n', 'utf8');

    const currentSpecBeforeHandoff = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpecBeforeHandoff.gate_c_approval_audits[iterationId].approved_source =
      `iterations/${iterationId}/gate-c-task-graph/task-graph.draft.json`;
    writeJson(currentSpecPath, currentSpecBeforeHandoff);

    const historicalHandoffTarget = join(root, 'historical-handoff-target');
    result = runHandoff([
      '--project-id',
      spec.project_id,
      '--artifacts',
      artifactRoot,
      '--target',
      historicalHandoffTarget,
      '--iteration-id',
      'v1-mvp',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /handoff --iteration-id must select the active iteration "iter-002"/,
    );
    assert.equal(existsSync(historicalHandoffTarget), false);

    const activeTaskGraphPath = join(
      artifactRoot,
      'iterations',
      iterationId,
      'gate-c-task-graph',
      'task-graph.json',
    );
    const activeTaskGraph = JSON.parse(readFileSync(activeTaskGraphPath, 'utf8'));
    const activeTaskGraphBeforeComposition = structuredClone(activeTaskGraph);
    activeTaskGraph.tasks = activeTaskGraph.tasks.map((task) => ({
      ...task,
      status: 'done',
    }));
    writeJson(activeTaskGraphPath, activeTaskGraph);

    const tamperedComposedCurrentSpec = {
      ...currentSpecBeforeHandoff,
      composed_from: ['v1-mvp', iterationId],
      effective_spec_ref: 'current-spec.json',
      source_specs: [
        {
          iteration_id: 'v1-mvp',
          spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
          status: 'archived',
          approval: 'approved',
        },
        {
          iteration_id: iterationId,
          spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
          status: 'close-ready',
          approval: 'approved',
        },
      ],
      effective_product: structuredClone(baselineSpec.product),
      effective_implementation: structuredClone(baselineSpec.implementation),
      open_decisions: [],
    };
    writeJson(currentSpecPath, tamperedComposedCurrentSpec);
    result = runHandoff([
      '--project-id',
      spec.project_id,
      '--artifacts',
      artifactRoot,
      '--target',
      join(root, 'tampered-composition-handoff-target'),
      '--iteration-id',
      iterationId,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /effective sections must exactly match ordered source composition/,
    );
    const baselineIntake = JSON.parse(readFileSync(
      join(
        artifactRoot,
        'iterations',
        'v1-mvp',
        'gate-a-intake',
        'intake.json',
      ),
      'utf8',
    ));
    const iterationMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const replayedComposition = composeCanonicalSpecSources([
      {
        iteration_id: 'v1-mvp',
        spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
        spec: baselineSpec,
        metadata: null,
        source_intake: baselineIntake,
      },
      {
        iteration_id: iterationId,
        spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
        spec,
        metadata: iterationMetadata,
        source_intake: confirmedIntake,
      },
    ]);
    assert.deepEqual(replayedComposition.compositionConflicts, []);
    const portableComposedCurrentSpec = {
      ...currentSpecBeforeHandoff,
      composed_from: ['v1-mvp', iterationId],
      effective_spec_ref: 'current-spec.json',
      source_specs: [
        {
          iteration_id: 'v1-mvp',
          spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
          status: 'archived',
          approval: 'approved',
        },
        {
          iteration_id: iterationId,
          spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
          status: 'close-ready',
          approval: 'approved',
        },
      ],
      effective_product: replayedComposition.effectiveProduct,
      effective_implementation: replayedComposition.effectiveImplementation,
      superseded_refs: replayedComposition.supersededRefs,
      composition_conflicts: replayedComposition.compositionConflicts,
      open_decisions: [],
    };
    writeJson(currentSpecPath, portableComposedCurrentSpec);

    const handoffTarget = join(root, 'handoff-target');
    result = runHandoff([
      '--project-id',
      spec.project_id,
      '--artifacts',
      artifactRoot,
      '--target',
      handoffTarget,
      '--iteration-id',
      iterationId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const targetArtifactRoot = join(
      handoffTarget,
      '.plan2agent',
      'artifacts',
      spec.project_id,
    );
    const targetIntake = JSON.parse(readFileSync(
      join(targetArtifactRoot, 'gate-a-intake', 'intake.json'),
      'utf8',
    ));
    assert.equal(targetIntake.interview.seed_iteration_id, iterationId);
    const targetCurrentSpec = JSON.parse(readFileSync(
      join(handoffTarget, '.plan2agent', 'current-spec.json'),
      'utf8',
    ));
    assert.doesNotThrow(() => validateCurrentSpecCompositionData(
      targetCurrentSpec,
      targetArtifactRoot,
      { requireNoOpenDecisions: true },
    ));
    for (const source of targetCurrentSpec.source_specs) {
      assert.equal(
        existsSync(join(targetArtifactRoot, source.spec_ref)),
        true,
        `handoff omitted composed source spec: ${source.spec_ref}`,
      );
    }
    assert.equal(
      existsSync(join(
        targetArtifactRoot,
        'iterations',
        iterationId,
        'iteration.json',
      )),
      true,
      'handoff omitted composed source iteration metadata',
    );
    const targetSpecRef = `.plan2agent/artifacts/${spec.project_id}/gate-b-spec/spec.json`;
    const targetTaskGraphRef = `.plan2agent/artifacts/${spec.project_id}/gate-c-task-graph/task-graph.json`;
    const targetGateCApprovalRef =
      `.plan2agent/artifacts/${spec.project_id}/gate-c-task-graph/task-graph.draft.json.promoted`;
    assert.deepEqual(
      targetCurrentSpec.gate_b_approval_audits[iterationId].approved_artifacts,
      [targetSpecRef],
    );
    assert.deepEqual(
      targetCurrentSpec.gate_c_approval_audits[iterationId].approved_artifacts,
      [targetGateCApprovalRef],
    );
    assert.equal(
      targetCurrentSpec.gate_c_approval_audits[iterationId].approved_source,
      targetGateCApprovalRef,
    );
    assert.equal(existsSync(join(handoffTarget, targetSpecRef)), true);
    assert.equal(existsSync(join(handoffTarget, targetTaskGraphRef)), true);
    assert.equal(existsSync(join(handoffTarget, targetGateCApprovalRef)), true);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(handoffTarget, targetGateCApprovalRef)))
        .digest('hex'),
      targetCurrentSpec.gate_c_approval_audits[iterationId].draft_sha256,
    );
    assert.deepEqual(
      targetCurrentSpec.gate_c_approval_audits['v1-mvp'].approved_artifacts,
      [
        `.plan2agent/artifacts/${spec.project_id}/iterations/v1-mvp/gate-c-task-graph/task-graph.json`,
      ],
    );
    for (const field of ['gate_b_approval_audits', 'gate_c_approval_audits']) {
      for (const audit of Object.values(targetCurrentSpec[field])) {
        for (const approvedArtifact of audit.approved_artifacts) {
          assert.equal(
            existsSync(join(handoffTarget, approvedArtifact)),
            true,
            `${field} points at a missing handoff artifact: ${approvedArtifact}`,
          );
        }
        if (audit.approved_source) {
          assert.equal(
            existsSync(join(handoffTarget, audit.approved_source)),
            true,
            `${field} approved_source is not portable: ${audit.approved_source}`,
          );
        }
      }
    }
    const targetBaselineSpecPath = join(
      targetArtifactRoot,
      confirmedIntake.baseline_context.spec_ref,
    );
    const targetBaselineSpec = JSON.parse(readFileSync(targetBaselineSpecPath, 'utf8'));
    const targetBaselineIntakePath = targetBaselineSpec.source_intake.startsWith('.plan2agent/')
      ? join(handoffTarget, targetBaselineSpec.source_intake)
      : join(dirname(targetBaselineSpecPath), targetBaselineSpec.source_intake);
    assert.equal(
      existsSync(targetBaselineIntakePath),
      true,
      'handoff omitted the baseline spec source_intake dependency',
    );

    writeJson(currentSpecPath, currentSpecBeforeHandoff);
    writeJson(taskGraphPath, activeTaskGraphBeforeComposition);
    const canonicalTaskGraph = JSON.parse(readFileSync(taskGraphPath, 'utf8'));
    const startedTaskGraph = structuredClone(canonicalTaskGraph);
    startedTaskGraph.tasks[0].status = 'in_progress';
    writeJson(taskGraphPath, startedTaskGraph);
    const intakeBeforeRejectedReset = readFileSync(intakePath, 'utf8');

    result = runIteration(['draft', '--artifacts', artifactRoot, '--force']);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /draft --force cannot restart Gate A after task execution has started/,
    );
    assert.equal(readFileSync(intakePath, 'utf8'), intakeBeforeRejectedReset);
    assert.equal(existsSync(specPath), true);
    assert.equal(existsSync(reviewPath), true);

    writeJson(taskGraphPath, canonicalTaskGraph);
    const rollbackPaths = [
      intakePath,
      intakeViewPath,
      productSpecPath,
      implementationPlanPath,
      specPath,
      taskGraphPath,
      reviewPath,
      reviewReportPath,
      currentSpecPath,
      metadataPath,
    ];
    const beforeFailedReset = new Map(
      rollbackPaths.map((filePath) => [filePath, readFileSync(filePath)]),
    );
    const originalStatus = readFileSync(statusPath);
    rmSync(statusPath);
    mkdirSync(statusPath);

    result = runIteration(['draft', '--artifacts', artifactRoot, '--force']);
    assert.notEqual(result.status, 0);
    for (const [filePath, expected] of beforeFailedReset) {
      assert.deepEqual(
        readFileSync(filePath),
        expected,
        `failed force reset did not restore ${filePath}`,
      );
    }

    rmSync(statusPath, { recursive: true, force: true });
    writeFileSync(statusPath, originalStatus);
    const replacementIdea = 'Replace the delivery dashboard with an incident timeline';
    result = runIteration([
      'draft',
      '--artifacts',
      artifactRoot,
      '--force',
      '--idea',
      replacementIdea,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const resetIntake = JSON.parse(readFileSync(intakePath, 'utf8'));
    const resetCurrentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    const resetMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    assert.equal(resetIntake.interview.state, 'interview_active');
    assert.equal(resetIntake.idea, replacementIdea);
    assert.equal(resetCurrentSpec.pending_iteration.status, 'gate_a_interview');
    assert.equal(resetCurrentSpec.pending_iteration.idea, replacementIdea);
    assert.equal(resetCurrentSpec.pending_iteration.promoted_at, undefined);
    assert.equal(resetCurrentSpec.gate_b_approval_audits?.[iterationId], undefined);
    assert.equal(resetCurrentSpec.gate_c_approval_audits?.[iterationId], undefined);
    assert.equal(resetMetadata.status, 'gate_a_interview');
    assert.equal(resetMetadata.idea, replacementIdea);
    assert.equal(resetMetadata.planning_memory.layers.project.query, replacementIdea);
    assert.equal(resetMetadata.planning_memory.layers.cross_project.query, replacementIdea);
    assert.equal(resetMetadata.promoted_at, undefined);
    assert.equal(resetMetadata.approved_spec_artifacts, undefined);
    for (const stalePath of [
      specPath,
      taskGraphPath,
      promotedDraftPath,
      draftMetaPath,
      reviewPath,
      reviewReportPath,
    ]) {
      assert.equal(existsSync(stalePath), false, `stale downstream artifact remained: ${stalePath}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('draft --force invalidates downstream gates for an initial iteration without a baseline', () => {
  const root = makeTempDir('p2a-discovery-initial-force-reset-');
  const artifactRoot = join(root, 'artifacts');
  const iterationId = 'v1-mvp';
  const iterationRoot = join(artifactRoot, 'iterations', iterationId);
  const intakePath = join(iterationRoot, 'gate-a-intake', 'intake.json');
  const specPath = join(iterationRoot, 'gate-b-spec', 'spec.json');
  const taskGraphPath = join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
  const reviewPath = join(iterationRoot, 'gate-d-review', 'review.json');
  const currentSpecPath = join(artifactRoot, 'current-spec.json');
  const metadataPath = join(iterationRoot, 'iteration.json');

  try {
    cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, { recursive: true });
    let result = runIteration(['init', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
    const currentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    currentSpec.effective_spec_ref = specPath;
    currentSpec.pending_iteration = {
      iteration_id: iterationId,
      status: 'gate_a_ready',
      idea: intake.idea,
      baseline_effective_spec_ref: null,
      promoted_at: '2026-07-29T00:00:00.000Z',
      artifacts: {
        intake_ref: `iterations/${iterationId}/gate-a-intake/intake.json`,
        spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
      },
    };
    writeJson(currentSpecPath, currentSpec);

    writeJson(metadataPath, {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: currentSpec.project_id,
      iteration_id: iterationId,
      status: 'gate_b_approved',
      opened_at: '2026-07-29T00:00:00.000Z',
      idea: intake.idea,
      baseline: {
        iteration_id: null,
        current_spec_ref: 'current-spec.json',
        effective_spec_ref: null,
      },
      planning_memory: null,
      promoted_at: '2026-07-29T00:00:00.000Z',
      approved_spec_artifacts: {
        spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
      },
    });

    const intakeWithUnexpectedBaseline = structuredClone(intake);
    intakeWithUnexpectedBaseline.baseline_context = {
      spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
      reused_answers: [],
      reused_question_dispositions: [],
    };
    writeJson(intakePath, intakeWithUnexpectedBaseline);
    result = runIteration(['draft', '--artifacts', artifactRoot]);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /greenfield Gate A intake must not define baseline_context/,
    );
    writeJson(intakePath, intake);

    const canonicalTaskGraph = JSON.parse(readFileSync(taskGraphPath, 'utf8'));
    const startedTaskGraph = structuredClone(canonicalTaskGraph);
    startedTaskGraph.tasks[0].status = 'in_progress';
    writeJson(taskGraphPath, startedTaskGraph);

    result = runIteration(['draft', '--artifacts', artifactRoot, '--force']);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /draft --force cannot restart Gate A after task execution has started/,
    );
    assert.equal(existsSync(taskGraphPath), true);
    assert.equal(existsSync(reviewPath), true);

    writeJson(taskGraphPath, canonicalTaskGraph);
    const replacementIdea = 'Build a desktop photo editor';
    result = runIteration([
      'draft',
      '--artifacts',
      artifactRoot,
      '--force',
      '--idea',
      replacementIdea,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const resetCurrentSpec = JSON.parse(readFileSync(currentSpecPath, 'utf8'));
    const resetMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const resetIntake = JSON.parse(readFileSync(intakePath, 'utf8'));
    assert.equal(existsSync(specPath), false);
    assert.equal(existsSync(taskGraphPath), false);
    assert.equal(existsSync(reviewPath), false);
    assert.equal(resetCurrentSpec.effective_spec_ref, null);
    assert.deepEqual(resetCurrentSpec.composed_from, []);
    assert.equal(resetCurrentSpec.pending_iteration.status, 'gate_a_interview');
    assert.equal(resetCurrentSpec.pending_iteration.promoted_at, undefined);
    assert.equal(resetCurrentSpec.gate_b_promoted_at, undefined);
    assert.equal(resetCurrentSpec.gate_b_approval_audits?.[iterationId], undefined);
    assert.equal(resetCurrentSpec.gate_c_approval_audits?.[iterationId], undefined);
    assert.equal(resetMetadata.status, 'gate_a_interview');
    assert.equal(resetMetadata.promoted_at, undefined);
    assert.equal(resetMetadata.approved_spec_artifacts, undefined);
    assert.equal(resetIntake.status, 'blocked_on_user');
    assert.equal(resetIntake.interview.state, 'interview_active');
    assert.equal(resetIntake.idea, replacementIdea);
    assert.match(resetIntake.summary, /desktop photo editor/);
    assert.doesNotMatch(
      JSON.stringify({
        summary: resetIntake.summary,
        known_facts: resetIntake.known_facts,
        assumptions: resetIntake.assumptions,
        evidence: resetIntake.evidence,
      }),
      /webhook|internal queue|Node\.js/i,
    );
    assert.equal(resetIntake.baseline_context, undefined);
    assert.equal(resetCurrentSpec.pending_iteration.idea, replacementIdea);
    assert.equal(resetMetadata.idea, replacementIdea);
    assert.equal(resetMetadata.planning_memory.layers.project.query, replacementIdea);
    assert.equal(resetMetadata.planning_memory.layers.cross_project.query, replacementIdea);
    assert.deepEqual(
      resetIntake.interview.current_question_ids,
      ['CQ-1', 'CQ-2', 'CQ-3'],
    );

    const invalidRestartIntake = structuredClone(resetIntake);
    invalidRestartIntake.status = 'ready_for_spec';
    writeJson(intakePath, invalidRestartIntake);
    result = runIteration(['draft', '--artifacts', artifactRoot, '--force']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(specPath), false);
    assert.equal(
      JSON.parse(readFileSync(currentSpecPath, 'utf8')).pending_iteration.status,
      'gate_a_interview',
    );
    assert.equal(
      JSON.parse(readFileSync(intakePath, 'utf8')).status,
      'blocked_on_user',
    );

    rmSync(intakePath);
    result = runIteration(['draft', '--artifacts', artifactRoot, '--force']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(
      JSON.parse(readFileSync(intakePath, 'utf8')).interview.state,
      'interview_active',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
