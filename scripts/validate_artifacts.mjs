#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizePath, P2A_DIR, resolveP2aPaths } from './p2a_paths.mjs';
import {
  artifactRunRef,
  canonicalRunRef,
  isRunRecordFile,
  isSupportedRunRef,
  legacyRunRef,
  normalizeIndexedRunRef,
  RUN_SIDECAR_SUFFIXES,
  taskGraphRefMatchesGraph,
} from './p2a_run_paths.mjs';
import {
  buildInitialCanonicalSections,
  compositionReplayContractError,
  compositionSourceContractError,
  composeCanonicalSpecSources,
  isComposedBaselineReference,
} from './p2a_spec_model.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const SCHEMA_PATHS = {
  intake: path.join(P2A_PATHS.schemasDir, 'intake.schema.json'),
  spec: path.join(P2A_PATHS.schemasDir, 'spec.schema.json'),
  task_graph: path.join(P2A_PATHS.schemasDir, 'task-graph.schema.json'),
  task_context: path.join(P2A_PATHS.schemasDir, 'task-context.schema.json'),
  review: path.join(P2A_PATHS.schemasDir, 'review.schema.json'),
  run: path.join(P2A_PATHS.schemasDir, 'run.schema.json'),
  run_index: path.join(P2A_PATHS.schemasDir, 'run-index.schema.json'),
  milestone_review: path.join(P2A_PATHS.schemasDir, 'milestone-review.schema.json'),
  skill_proposal: path.join(P2A_PATHS.schemasDir, 'skill-proposal.schema.json'),
  proposal_review: path.join(P2A_PATHS.schemasDir, 'proposal-review.schema.json'),
  proposal_curation: path.join(P2A_PATHS.schemasDir, 'proposal-curation.schema.json'),
  proposal_patch_draft: path.join(P2A_PATHS.schemasDir, 'proposal-patch-draft.schema.json'),
  proposal_draft_approval: path.join(P2A_PATHS.schemasDir, 'proposal-draft-approval.schema.json'),
  eval_index: path.join(P2A_PATHS.schemasDir, 'eval-index.schema.json'),
  eval_digest: path.join(P2A_PATHS.schemasDir, 'eval-digest.schema.json'),
  eval_maintenance_draft: path.join(P2A_PATHS.schemasDir, 'eval-maintenance-draft.schema.json'),
  eval_maintenance_apply_report: path.join(P2A_PATHS.schemasDir, 'eval-maintenance-apply-report.schema.json'),
};
const GATE_PATHS = {
  statusDoc: 'status.md',
  intakeJson: path.join('gate-a-intake', 'intake.json'),
  intakeMd: path.join('gate-a-intake', 'intake.md'),
  productSpec: path.join('gate-b-spec', 'product-spec.md'),
  implementationPlan: path.join('gate-b-spec', 'implementation-plan.md'),
  specJson: path.join('gate-b-spec', 'spec.json'),
  taskGraph: path.join('gate-c-task-graph', 'task-graph.json'),
  reviewReport: path.join('gate-d-review', 'review-report.md'),
  reviewJson: path.join('gate-d-review', 'review.json'),
};

function expectedExecutionGuide(agentTool, role, profile) {
  if (agentTool === 'codex') {
    return {
      surface: 'Codex CLI/app foreground session',
      recommendedFeature: role === 'contributor'
        ? 'skills_custom_agents_explicit_subagent_prompt'
        : 'read_only_review_skill_or_custom_agent_prompt',
      fallbackMode: 'single supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Open Codex manually in the foreground workspace.'],
    };
  }
  if (agentTool === 'claude') {
    return {
      surface: 'Claude Code foreground session',
      recommendedFeature: role === 'contributor'
        ? 'agent_teams_or_subagents'
        : 'read_only_review_subagent',
      fallbackMode: 'supervised foreground role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Open Claude Code manually in the foreground workspace.'],
    };
  }
  if (agentTool === 'gemini') {
    return {
      surface: 'Gemini CLI foreground session',
      recommendedFeature: 'extensions_custom_commands_gemini_context',
      fallbackMode: 'read-only supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Use Gemini only for read-only planning, review, or monitor support.'],
    };
  }
  return {
    surface: 'Human owner foreground action',
    recommendedFeature: role === 'lead'
      ? 'manual_approval_and_run_lifecycle'
      : 'manual_prompt_copy_and_status_recording',
    fallbackMode: 'manual status update',
    supervisionRequired: true,
    startsProcess: false,
    constraints: [
      profile === 'manual_monitor'
        ? 'Record an explicit monitor verdict before finish.'
        : 'Perform the role directly in the foreground workspace.',
    ],
  };
}

function roleWithExecutionGuide(role) {
  if (role.executionGuide) return role;
  return {
    ...role,
    executionGuide: expectedExecutionGuide(role.agentTool, role.role, role.profile),
  };
}

/**
 * @deprecated Kept as a compatibility export for scaffolded runtime consumers.
 */
export function normalizeOrchestrationPlanData(data) {
  const normalized = JSON.parse(JSON.stringify(data));
  if (Array.isArray(normalized?.roles)) {
    normalized.roles = normalized.roles.map(roleWithExecutionGuide);
  }
  return normalized;
}

/**
 * @deprecated Kept as a compatibility export for scaffolded runtime consumers.
 */
export function normalizeOrchestrationRuntimeData(data) {
  const normalized = JSON.parse(JSON.stringify(data));
  const roleAssignments = normalized?.sharedMentalModel?.roleAssignments;
  if (Array.isArray(roleAssignments)) {
    normalized.sharedMentalModel.roleAssignments = roleAssignments.map(roleWithExecutionGuide);
  }
  return normalized;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new ValidationError(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new ValidationError(`${label} must be a file: ${filePath}`);
}

function assertFileInsideArtifactRoot(filePath, artifactRoot, label) {
  const realArtifactRoot = realpathSync(artifactRoot);
  const realFilePath = realpathSync(filePath);
  const relative = path.relative(realArtifactRoot, realFilePath);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new ValidationError(`${label} resolves outside the artifact root`);
  }
}

function resolveProjectRelativeReference(reference, baseDir) {
  if (!reference.startsWith(`${P2A_DIR}/`) && !reference.startsWith(`${P2A_DIR}${path.sep}`)) return null;
  let current = path.resolve(baseDir);
  while (true) {
    const p2aDir = path.join(current, P2A_DIR);
    if (existsSync(p2aDir) && lstatSync(p2aDir).isDirectory()) {
      return path.resolve(current, reference);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveExistingFileReference(reference, baseDir) {
  if (!reference || typeof reference !== 'string') return null;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(process.cwd(), reference),
        path.resolve(baseDir, reference),
        resolveProjectRelativeReference(reference, baseDir),
      ];
  return candidates.filter(Boolean).find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
}

export function resolveSpecSourceIntake(specPath, specReference = loadJson(specPath)) {
  return resolveExistingFileReference(specReference.source_intake, path.dirname(specPath));
}

function requireSpecSourceIntake(specPath, specReference = loadJson(specPath)) {
  if (!specReference.source_intake) return null;
  const sourceIntakePath = resolveSpecSourceIntake(specPath, specReference);
  if (!sourceIntakePath) {
    throw new ValidationError(`spec.source_intake cannot be resolved to a file: ${JSON.stringify(specReference.source_intake)}`);
  }
  return sourceIntakePath;
}

function inferArtifactRootFromIntakePath(intakePath) {
  const resolvedIntakePath = path.resolve(intakePath);
  const gateADir = path.dirname(resolvedIntakePath);
  if (path.basename(gateADir) === 'gate-a-intake') {
    const gateContainer = path.dirname(gateADir);
    const gateContainerParent = path.dirname(gateContainer);
    if (path.basename(gateContainerParent) === 'iterations') {
      return path.dirname(gateContainerParent);
    }
    return gateContainer;
  }

  let current = path.dirname(resolvedIntakePath);
  while (true) {
    const currentSpecPath = path.join(current, 'current-spec.json');
    if (existsSync(currentSpecPath) && lstatSync(currentSpecPath).isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function schemaTypeMatches(instance, expectedType) {
  if (expectedType === 'object') return instance !== null && typeof instance === 'object' && !Array.isArray(instance);
  if (expectedType === 'array') return Array.isArray(instance);
  if (expectedType === 'string') return typeof instance === 'string';
  if (expectedType === 'boolean') return typeof instance === 'boolean';
  if (expectedType === 'null') return instance === null;
  if (expectedType === 'number') return typeof instance === 'number' && Number.isFinite(instance);
  if (expectedType === 'integer') return Number.isInteger(instance);
  throw new ValidationError(`unsupported schema type ${JSON.stringify(expectedType)} at $`);
}

export function validateSchema(instance, schema, instancePath = '$') {
  if (schema.allOf) {
    for (const [index, subschema] of schema.allOf.entries()) {
      validateSchemaComposition(instance, subschema, `${instancePath}.allOf[${index}]`, instancePath);
    }
  }
  if (schema.oneOf) {
    const matchCount = schema.oneOf.filter((subschema) => schemaMatches(instance, subschema)).length;
    if (matchCount !== 1) {
      throw new ValidationError(`${instancePath} must match exactly one oneOf schema (matched ${matchCount})`);
    }
  }

  if (Object.hasOwn(schema, 'const') && instance !== schema.const) {
    throw new ValidationError(`${instancePath} must equal ${JSON.stringify(schema.const)}`);
  }

  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(instance)) {
    throw new ValidationError(`${instancePath} must be one of ${JSON.stringify(schema.enum)}`);
  }

  const expectedType = schema.type;
  if (expectedType) {
    const supported = new Set(['object', 'array', 'string', 'boolean', 'null', 'number', 'integer']);
    const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
    const unsupported = expectedTypes.filter((type) => !supported.has(type));
    if (unsupported.length) {
      throw new ValidationError(`unsupported schema type ${JSON.stringify(expectedType)} at ${instancePath}`);
    }
    if (!expectedTypes.some((type) => schemaTypeMatches(instance, type))) {
      throw new ValidationError(`${instancePath} must be ${expectedTypes.join(' or ')}`);
    }
  }

  if (typeof instance === 'string') {
    if (Object.hasOwn(schema, 'minLength') && instance.length < schema.minLength) {
      throw new ValidationError(`${instancePath} must have length >= ${schema.minLength}`);
    }
    if (Object.hasOwn(schema, 'pattern') && !new RegExp(schema.pattern).test(instance)) {
      throw new ValidationError(`${instancePath} must match pattern ${JSON.stringify(schema.pattern)}`);
    }
  }

  if (typeof instance === 'number') {
    if (Object.hasOwn(schema, 'minimum') && instance < schema.minimum) {
      throw new ValidationError(`${instancePath} must be >= ${schema.minimum}`);
    }
    if (Object.hasOwn(schema, 'maximum') && instance > schema.maximum) {
      throw new ValidationError(`${instancePath} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(instance)) {
    if (Object.hasOwn(schema, 'minItems') && instance.length < schema.minItems) {
      throw new ValidationError(`${instancePath} must contain at least ${schema.minItems} item(s)`);
    }
    if (Object.hasOwn(schema, 'maxItems') && instance.length > schema.maxItems) {
      throw new ValidationError(`${instancePath} must contain at most ${schema.maxItems} item(s)`);
    }
    if (
      schema.uniqueItems === true
      && instance.some((item, index) => (
        instance.slice(0, index).some((previous) => sameSchemaValue(previous, item))
      ))
    ) {
      throw new ValidationError(`${instancePath} must contain unique items`);
    }
    if (schema.items) {
      instance.forEach((item, index) => validateSchema(item, schema.items, `${instancePath}[${index}]`));
    }
  }

  if (schema.not && schemaMatches(instance, schema.not)) {
    throw new ValidationError(`${instancePath} must not match forbidden schema`);
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const required = schema.required ?? [];
    const missing = required.filter((key) => !Object.hasOwn(instance, key));
    if (missing.length) {
      throw new ValidationError(`${instancePath} missing required keys: ${missing.join(', ')}`);
    }

    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extras = Object.keys(instance).filter((key) => !Object.hasOwn(properties, key));
      if (extras.length) {
        throw new ValidationError(`${instancePath} contains unsupported keys: ${extras.join(', ')}`);
      }
    }

    for (const [key, value] of Object.entries(instance)) {
      if (Object.hasOwn(properties, key)) {
        validateSchema(value, properties[key], `${instancePath}.${key}`);
      }
    }
  }
}

function schemaMatches(instance, schema) {
  try {
    validateSchema(instance, schema);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

function sameSchemaValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameSchemaValue(item, right[index]))
    );
  }
  if (
    left !== null
    && right !== null
    && typeof left === 'object'
    && typeof right === 'object'
  ) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index]
        && sameSchemaValue(left[key], right[key])
      ))
    );
  }
  return false;
}

function validateSchemaComposition(instance, schema, schemaPath, instancePath) {
  if (schema.if) {
    const matched = schemaMatches(instance, schema.if);
    if (matched && schema.then) validateSchema(instance, schema.then, instancePath);
    if (!matched && schema.else) validateSchema(instance, schema.else, instancePath);
    return;
  }
  validateSchema(instance, schema, schemaPath);
}

export function validateAgainstSchema(filePath, schemaName) {
  const data = loadJson(filePath);
  const schema = loadJson(SCHEMA_PATHS[schemaName]);
  validateSchema(data, schema);
  return data;
}

export function validateEvidence(evidence, label) {
  const sourceIds = evidence.map((item) => item.source_id);
  if (sourceIds.length !== new Set(sourceIds).size) {
    throw new ValidationError(`${label}.evidence source_id values must be unique`);
  }
  for (const item of evidence) {
    if (item.source_id.startsWith('WEB-') && !(item.url ?? '').startsWith('http://') && !(item.url ?? '').startsWith('https://')) {
      throw new ValidationError(`${label}.evidence ${item.source_id} must include an http(s) url`);
    }
  }
}

const TECHNOLOGY_RECON_PATTERN = /\b(?:cloud|cloud service|database|db|external api|external service|framework|library|npm|package|protocol|runtime|sdk|typescript|node\.?js|python|react|redis|postgres|postgresql|mysql|sqlite|queue|kafka|rabbitmq|aws|gcp|azure)\b/gi;
const TECHNOLOGY_RECON_NEGATION_PATTERN = /\b(?:no|without|avoid(?:s|ed|ing)?|prohibit(?:s|ed|ing)?|forbid(?:s|den|ding)?|exclude(?:s|d|ing)?|not|do not|don't)\b/i;

function hasMaterialTechnologyReconTrigger(item) {
  const text = item.trim();
  if (/^(?:none|n\/a|not applicable)$/i.test(text)) return false;

  for (const match of text.matchAll(TECHNOLOGY_RECON_PATTERN)) {
    const precedingPhrase = text.slice(0, match.index).split(/[.;:,(\[\]{}]/).pop() ?? '';
    if (!TECHNOLOGY_RECON_NEGATION_PATTERN.test(precedingPhrase)) {
      return true;
    }
  }
  return false;
}

function specTechnologyReconTriggers(spec) {
  const candidateFields = [
    ...(spec.product?.external_integrations ?? []),
    ...(spec.implementation?.architecture ?? []),
    ...(spec.implementation?.interfaces ?? []),
    ...(spec.implementation?.dependencies ?? []),
  ];
  return candidateFields
    .filter((item) => typeof item === 'string')
    .filter((item) => hasMaterialTechnologyReconTrigger(item));
}

function validateTechnologyReconnaissanceEvidence(spec) {
  if (spec.approval !== 'approved') return;
  const triggers = specTechnologyReconTriggers(spec);
  if (!triggers.length) return;
  const hasWebEvidence = (spec.evidence ?? []).some((item) => item.source_id.startsWith('WEB-'));
  if (!hasWebEvidence) {
    throw new ValidationError(
      `approved spec with material technology choices requires WEB-n evidence from Gate B Technology Reconnaissance: ${JSON.stringify(triggers.slice(0, 3))}`,
    );
  }
}

function validateReferenceReconnaissance(spec) {
  const reconnaissance = spec.reference_reconnaissance;
  if (!reconnaissance) return;

  if (spec.approval === 'approved' && reconnaissance.open_questions.length) {
    throw new ValidationError('approved spec must not contain reference_reconnaissance.open_questions');
  }

  const evidenceById = new Map((spec.evidence ?? []).map((item) => [item.source_id, item]));
  const evidenceIds = new Set(evidenceById.keys());
  const candidateIds = reconnaissance.candidates.map((candidate) => candidate.candidate_id);
  if (candidateIds.length !== new Set(candidateIds).size) {
    throw new ValidationError('spec.reference_reconnaissance candidate_id values must be unique');
  }

  for (const candidate of reconnaissance.candidates) {
    if (!evidenceIds.has(candidate.source_id)) {
      throw new ValidationError(`spec.reference_reconnaissance ${candidate.candidate_id} references unknown evidence source_id ${candidate.source_id}`);
    }
    const evidence = evidenceById.get(candidate.source_id);
    const isFeatureRadarCandidate = candidate.origin === 'feature_radar_preflight'
      || (typeof candidate.title === 'string' && candidate.title.startsWith('Feature Radar:'))
      || (typeof evidence?.title === 'string' && evidence.title.startsWith('Feature Radar '))
      || (typeof evidence?.used_for === 'string' && evidence.used_for.includes('Feature Radar'));
    if (
      spec.approval === 'approved'
      && isFeatureRadarCandidate
      && (candidate.decision === 'context' || candidate.decision === 'open')
    ) {
      throw new ValidationError(`approved spec must resolve Feature Radar candidate ${candidate.candidate_id} as selected, rejected, or deferred before Gate B approval`);
    }
  }

  const knownCandidateIds = new Set(candidateIds);
  for (const pattern of [...reconnaissance.selected_patterns, ...reconnaissance.rejected_patterns]) {
    if (!knownCandidateIds.has(pattern.candidate_id)) {
      throw new ValidationError(`spec.reference_reconnaissance pattern references unknown candidate_id ${pattern.candidate_id}`);
    }
  }
}

const DISCOVERY_DIMENSIONS = [
  'target_users',
  'core_problem',
  'expected_outcome',
  'mvp_scope',
  'non_goals',
  'success_criteria',
  'constraints_and_risks',
  'integrations_and_compatibility',
];

const DISCOVERY_SPEC_FIELD_REFS = {
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

const CANONICAL_SPEC_FIELD_REFS = new Set([
  'spec.product.problem',
  'spec.product.target_users',
  'spec.product.goals',
  'spec.product.non_goals',
  'spec.product.core_flows',
  'spec.product.screens_or_interfaces',
  'spec.product.data_model_draft',
  'spec.product.external_integrations',
  'spec.product.success_criteria',
  'spec.product.constraints',
  'spec.implementation.architecture',
  'spec.implementation.interfaces',
  'spec.implementation.data_flow',
  'spec.implementation.dependencies',
  'spec.implementation.edge_cases',
  'spec.implementation.verification',
]);

const NON_EMPTY_CANONICAL_ARRAY_FIELD_REFS = new Set([
  'spec.product.target_users',
  'spec.product.goals',
  'spec.product.core_flows',
  'spec.product.success_criteria',
  'spec.implementation.verification',
]);

function validateIntakeQuestion(question) {
  const hasAnswer = Object.hasOwn(question, 'answer');
  const hasNonBlankAnswer = (
    typeof question.answer === 'string'
    && question.answer.trim().length > 0
  );
  if (question.status === 'open' && hasAnswer) {
    throw new ValidationError(`${question.id} is open but has an answer`);
  }
  if (
    ['answered', 'assumed', 'not_applicable'].includes(question.status)
    && !hasNonBlankAnswer
  ) {
    throw new ValidationError(`${question.id} is ${question.status} but has no non-blank answer`);
  }
}

function baselineDispositionResolution(disposition) {
  return disposition.resolved_by
    ?? disposition.assumption
    ?? disposition.non_goal
    ?? disposition.resolution
    ?? disposition.rationale;
}

function questionAffectedFields(question) {
  return question.affected_fields ?? question.blocks ?? [];
}

function validateInterviewSpecUpdates(intake, questionsById) {
  const updates = intake.interview.spec_updates ?? [];
  const updateFields = updates.map((update) => update.field);
  if (updateFields.length !== new Set(updateFields).size) {
    throw new ValidationError('intake.interview.spec_updates must contain at most one update per canonical field');
  }

  const updatesBySourceAndField = new Set();
  const dimensionsById = new Map(
    intake.interview.discovery_dimensions.map((dimension) => [dimension.dimension, dimension]),
  );
  for (const update of updates) {
    const sourceQuestionIds = update.source_question_ids ?? [];
    const sourceDimensionIds = update.source_dimension_ids ?? [];
    if (sourceQuestionIds.length + sourceDimensionIds.length === 0) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} must cite at least one source question or discovery dimension`,
      );
    }
    if (sourceQuestionIds.length !== new Set(sourceQuestionIds).size) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} source_question_ids must be unique`,
      );
    }
    if (sourceDimensionIds.length !== new Set(sourceDimensionIds).size) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} source_dimension_ids must be unique`,
      );
    }
    if (
      (update.operation === 'append' || update.operation === 'remove')
      && update.values.length === 0
    ) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} ${update.operation} requires at least one value`,
      );
    }
    if (!intake.baseline_context && update.operation !== 'replace') {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} must use replace without a baseline canonical field`,
      );
    }
    if (
      update.field === 'spec.product.problem'
      && (
        update.operation === 'remove'
        || (update.operation === 'replace' && update.values.length === 0)
      )
    ) {
      throw new ValidationError(
        'intake.interview.spec_updates cannot remove or empty spec.product.problem',
      );
    }
    for (const sourceId of sourceQuestionIds) {
      const source = questionsById.get(sourceId);
      if (!source) {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} references unknown question ${sourceId}`,
        );
      }
      const resolved = sourceId.startsWith('CQ-')
        ? ['answered', 'assumed', 'not_applicable'].includes(source.status)
        : source.status === 'answered';
      if (!resolved) {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} references unresolved question ${sourceId}`,
        );
      }
      if (!questionAffectedFields(source).includes(update.field)) {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} is not declared in ${sourceId}.affected_fields`,
        );
      }
      if (source.status === 'not_applicable' && update.operation === 'append') {
        throw new ValidationError(
          `intake.interview.spec_updates for not_applicable ${sourceId} must replace or remove ${update.field}`,
        );
      }
      updatesBySourceAndField.add(`${sourceId}\n${update.field}`);
    }
    for (const dimensionId of sourceDimensionIds) {
      const dimension = dimensionsById.get(dimensionId);
      if (!dimension) {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} references unknown discovery dimension ${dimensionId}`,
        );
      }
      if (dimension.status === 'open') {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} references open discovery dimension ${dimensionId}`,
        );
      }
      if (!dimension.affected_fields.includes(update.field)) {
        throw new ValidationError(
          `intake.interview.spec_updates ${update.field} is not declared in discovery dimension ${dimensionId}.affected_fields`,
        );
      }
      updatesBySourceAndField.add(`DIM:${dimensionId}\n${update.field}`);
    }
  }

  const missingUpdates = [];
  for (const [sourceId, source] of questionsById) {
    const resolved = sourceId.startsWith('CQ-')
      ? ['answered', 'assumed', 'not_applicable'].includes(source.status)
      : source.status === 'answered';
    if (!resolved) continue;
    for (const field of questionAffectedFields(source)) {
      if (!updatesBySourceAndField.has(`${sourceId}\n${field}`)) {
        missingUpdates.push(`${sourceId}:${field}`);
      }
    }
  }
  for (const dimension of intake.interview.discovery_dimensions) {
    if (dimension.status === 'open') continue;
    for (const field of dimension.affected_fields) {
      if (!updatesBySourceAndField.has(`DIM:${dimension.dimension}\n${field}`)) {
        missingUpdates.push(`DIM:${dimension.dimension}:${field}`);
      }
    }
  }
  if (missingUpdates.length) {
    throw new ValidationError(
      `intake.interview.spec_updates must cover every resolved question block and affected discovery dimension field: ${JSON.stringify(missingUpdates)}`,
    );
  }
  if (
    ['ready_for_gate_a_summary', 'awaiting_gate_a_confirmation', 'gate_a_confirmed'].includes(
      intake.interview.state,
    )
    && updates.length === 0
  ) {
    throw new ValidationError(
      `intake.interview state ${intake.interview.state} must record at least one canonical spec_update`,
    );
  }
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalSpecFieldParts(fieldRef) {
  const match = /^spec\.(product|implementation)\.([a-z_]+)$/.exec(fieldRef);
  if (!match) {
    throw new ValidationError(`unsupported canonical spec field reference: ${JSON.stringify(fieldRef)}`);
  }
  return { section: match[1], field: match[2] };
}

function applyCanonicalSpecUpdate(specSections, update) {
  const { section, field } = canonicalSpecFieldParts(update.field);
  const current = specSections[section]?.[field];
  if (Array.isArray(current)) {
    if (update.operation === 'append') {
      const next = [...current];
      for (const value of update.values) {
        if (!next.includes(value)) next.push(value);
      }
      specSections[section][field] = next;
    } else if (update.operation === 'replace') {
      specSections[section][field] = [...update.values];
    } else {
      const removed = new Set(update.values);
      specSections[section][field] = current.filter((value) => !removed.has(value));
    }
    return;
  }
  if (section === 'product' && field === 'problem' && typeof current === 'string') {
    if (update.operation === 'replace') {
      specSections.product.problem = update.values.join('\n\n');
    } else if (update.operation === 'append') {
      const next = [current];
      for (const value of update.values) {
        if (!next.includes(value)) next.push(value);
      }
      specSections.product.problem = next.join('\n\n');
    }
    return;
  }
  throw new ValidationError(
    `intake.interview.spec_updates ${update.field} cannot be applied to the baseline canonical field`,
  );
}

function applyMateriallyChangingSpecUpdates(specSections, updates) {
  for (const update of updates) {
    const { section, field } = canonicalSpecFieldParts(update.field);
    const before = cloneJsonValue(specSections[section]?.[field]);
    applyCanonicalSpecUpdate(specSections, update);
    const after = specSections[section]?.[field];
    if (sameJson(before, after)) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} did not change the canonical Gate B field`,
      );
    }
    if (
      NON_EMPTY_CANONICAL_ARRAY_FIELD_REFS.has(update.field)
      && Array.isArray(after)
      && after.length === 0
    ) {
      throw new ValidationError(
        `intake.interview.spec_updates ${update.field} must not leave the canonical Gate B field empty`,
      );
    }
  }
  return specSections;
}

function loadInterviewBaselineSections(intake, artifactRoot) {
  const baselineRef = intake.baseline_context?.spec_ref;
  if (!baselineRef) return null;
  if (!artifactRoot) {
    throw new ValidationError(
      'validating Gate B application of intake.interview.spec_updates requires an artifact root',
    );
  }
  const baselinePath = path.resolve(artifactRoot, baselineRef);
  const baseline = loadJson(baselinePath);
  if (baseline.schema_version === 'p2a.spec.v1') {
    return {
      product: cloneJsonValue(baseline.product),
      implementation: cloneJsonValue(baseline.implementation),
    };
  }
  return {
    product: cloneJsonValue(baseline.effective_product),
    implementation: cloneJsonValue(baseline.effective_implementation),
  };
}

function validateInterviewSpecApplication(spec, intake, artifactRoot, intakePath) {
  if (!intake.interview) return;
  if (
    intake.interview.state !== 'gate_a_confirmed'
    || intake.status !== 'ready_for_spec'
  ) {
    throw new ValidationError(
      'interview-aware specs require a gate_a_confirmed intake with status ready_for_spec',
    );
  }
  const updates = intake.interview.spec_updates ?? [];
  const expectedSections = loadInterviewBaselineSections(intake, artifactRoot)
    ?? buildInitialCanonicalSections({
      iterationId: seedIterationIdForIntake(intake, intakePath),
      idea: intake.idea,
      intake,
    });

  applyMateriallyChangingSpecUpdates(expectedSections, updates);
  for (const fieldRef of CANONICAL_SPEC_FIELD_REFS) {
    const { section, field } = canonicalSpecFieldParts(fieldRef);
    if (!sameJson(spec[section]?.[field], expectedSections[section]?.[field])) {
      throw new ValidationError(
        `spec ${fieldRef} must equal the baseline value after applying Gate A spec_updates`,
      );
    }
  }
}

function seedIterationIdForIntake(intake, intakePath) {
  const normalized = normalizePath(path.resolve(intakePath));
  const match = /(?:^|\/)iterations\/([^/]+)\/gate-a-intake\/intake\.json$/.exec(normalized);
  const pathIterationId = match?.[1] ?? null;
  const recordedIterationId = intake.interview?.seed_iteration_id ?? null;
  if (
    recordedIterationId
    && pathIterationId
    && recordedIterationId !== pathIterationId
  ) {
    throw new ValidationError(
      `intake.interview.seed_iteration_id must match its iteration path ${JSON.stringify(pathIterationId)}, got ${JSON.stringify(recordedIterationId)}`,
    );
  }
  return recordedIterationId ?? pathIterationId ?? 'v1-mvp';
}

function validateInterviewSpecUpdateMateriality(intake, artifactRoot, intakePath) {
  if (!intake.interview) return;
  if (intake.baseline_context && !artifactRoot) return;
  const baselineSections = intake.baseline_context
    ? loadInterviewBaselineSections(intake, artifactRoot)
    : buildInitialCanonicalSections({
        iterationId: seedIterationIdForIntake(intake, intakePath),
        idea: intake.idea,
        intake,
      });
  applyMateriallyChangingSpecUpdates(
    baselineSections,
    intake.interview.spec_updates ?? [],
  );
}

function validateSafeCurrentSpecIterationId(iterationId, label) {
  if (typeof iterationId !== 'string' || !iterationId.trim()) {
    throw new ValidationError(`${label} must have a non-empty active_iteration`);
  }
  if (
    iterationId.includes('/')
    || iterationId.includes('\\')
    || iterationId === '.'
    || iterationId === '..'
    || !/^[A-Za-z0-9._-]+$/.test(iterationId)
  ) {
    throw new ValidationError(
      `${label}.active_iteration must be a safe single path segment, got ${JSON.stringify(iterationId)}`,
    );
  }
}

function validateComposedBaselineSourceReadiness(
  baselineSpec,
  source,
  sourceSpecPath,
  metadata,
  artifactRoot,
  label,
) {
  const iterationRoot = path.join(
    artifactRoot,
    'iterations',
    source.iteration_id,
  );
  const taskGraphPath = path.join(
    iterationRoot,
    'gate-c-task-graph',
    'task-graph.json',
  );
  const reviewPath = path.join(
    iterationRoot,
    'gate-d-review',
    'review.json',
  );
  for (const [filePath, fileLabel] of [
    [taskGraphPath, `${label} task graph`],
    [reviewPath, `${label} review`],
  ]) {
    assertFile(filePath, fileLabel);
    assertFileInsideArtifactRoot(filePath, artifactRoot, fileLabel);
  }

  const taskGraph = validateTaskGraph(taskGraphPath, sourceSpecPath);
  if (taskGraph.projectId !== baselineSpec.project_id) {
    throw new ValidationError(`${label} task graph project must match the composed current spec`);
  }
  const taskGraphSpecPath = resolveExistingFileReference(
    taskGraph.sourceSpec,
    path.dirname(taskGraphPath),
  );
  if (!taskGraphSpecPath) {
    throw new ValidationError(`${label} task graph sourceSpec cannot be resolved`);
  }
  assertFileInsideArtifactRoot(
    taskGraphSpecPath,
    artifactRoot,
    `${label} task graph sourceSpec`,
  );
  if (realpathSync(taskGraphSpecPath) !== realpathSync(sourceSpecPath)) {
    throw new ValidationError(`${label} task graph must reference its source spec`);
  }
  const incompleteTasks = taskGraph.tasks.filter((task) => task.status !== 'done');
  if (incompleteTasks.length) {
    throw new ValidationError(
      `${label} must be close-ready; incomplete tasks: ${incompleteTasks.map((task) => `${task.id}:${task.status}`).join(', ')}`,
    );
  }

  const review = validateReviewPass(reviewPath);
  if (review.projectId !== baselineSpec.project_id) {
    throw new ValidationError(`${label} review project must match the composed current spec`);
  }
  const expectedReferences = [
    ['sourceSpec', sourceSpecPath],
    ['sourceTaskGraph', taskGraphPath],
  ];
  for (const [field, expectedPath] of expectedReferences) {
    const normalizedReference = normalizeReference(review[field]);
    const artifactRelative = normalizePath(path.relative(artifactRoot, expectedPath));
    const acceptedReferences = new Set([
      normalizePath(path.relative(iterationRoot, expectedPath)),
      normalizePath(path.relative(path.dirname(reviewPath), expectedPath)),
      artifactRelative,
      `${path.basename(artifactRoot)}/${artifactRelative}`,
      `.plan2agent/artifacts/${path.basename(artifactRoot)}/${artifactRelative}`,
    ]);
    const matches = path.isAbsolute(review[field])
      ? (
          existsSync(review[field])
          && lstatSync(review[field]).isFile()
          && realpathSync(review[field]) === realpathSync(expectedPath)
        )
      : acceptedReferences.has(normalizedReference);
    if (!matches) {
      throw new ValidationError(`${label} review.${field} must reference its canonical source`);
    }
  }

  const expectedStatus = (
    metadata?.status === 'archived'
    || source.iteration_id !== baselineSpec.active_iteration
  )
    ? 'archived'
    : 'close-ready';
  if (source.status !== expectedStatus) {
    throw new ValidationError(
      `${label}.status must be ${expectedStatus}, got ${JSON.stringify(source.status)}`,
    );
  }
}

function validateBaselineContext(
  intake,
  artifactRoot = null,
  requireArtifactRoot = false,
  provenanceVisited = new Set(),
  intakePath = null,
) {
  const context = intake.baseline_context;
  if (!context) return;
  const answerKeys = context.reused_answers.map((item) => `${item.source_intake}#${item.id}`);
  if (answerKeys.length !== new Set(answerKeys).size) {
    throw new ValidationError('intake.baseline_context reused answer source/id pairs must be unique');
  }
  const dispositionKeys = context.reused_question_dispositions
    .map((item) => `${item.source_spec}#${item.id}`);
  if (dispositionKeys.length !== new Set(dispositionKeys).size) {
    throw new ValidationError('intake.baseline_context reused disposition source/id pairs must be unique');
  }
  if (!artifactRoot) {
    if (requireArtifactRoot) {
      throw new ValidationError(
        'validating intake.baseline_context provenance requires --artifact-root',
      );
    }
    return;
  }

  const root = path.resolve(artifactRoot);
  const intakeRealPath = intakePath && existsSync(intakePath)
    ? realpathSync(intakePath)
    : null;
  let activeVisitKey = null;
  let completedVisitKey = null;
  if (intakeRealPath) {
    activeVisitKey = `active:intake:${intakeRealPath}`;
    completedVisitKey = `completed:intake:${intakeRealPath}`;
    if (provenanceVisited.has(completedVisitKey)) return;
    if (provenanceVisited.has(activeVisitKey)) {
      throw new ValidationError(
        `intake.baseline_context provenance contains a cycle through ${intakeRealPath}`,
      );
    }
    provenanceVisited.add(activeVisitKey);
  }
  const references = [
    ['baseline_context.spec_ref', context.spec_ref],
    ...context.reused_answers.map((item, index) => [
      `baseline_context.reused_answers[${index}].source_intake`,
      item.source_intake,
    ]),
    ...context.reused_question_dispositions.map((item, index) => [
      `baseline_context.reused_question_dispositions[${index}].source_spec`,
      item.source_spec,
    ]),
  ];
  const resolvedReferences = new Map();
  for (const [label, reference] of references) {
    if (path.isAbsolute(reference)) {
      throw new ValidationError(`${label} must be an artifact-root-relative path`);
    }
    const resolved = path.resolve(root, reference);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ValidationError(`${label} escapes the artifact root: ${JSON.stringify(reference)}`);
    }
    if (!existsSync(resolved)) {
      throw new ValidationError(`${label} is missing: ${resolved}`);
    }
    if (!lstatSync(resolved).isFile()) {
      throw new ValidationError(`${label} is not a file: ${resolved}`);
    }
    const realRelative = path.relative(realpathSync(root), realpathSync(resolved));
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new ValidationError(`${label} resolves outside the artifact root: ${JSON.stringify(reference)}`);
    }
    resolvedReferences.set(label, resolved);
  }

  const baselineSpecPath = resolvedReferences.get('baseline_context.spec_ref');
  if (
    isComposedBaselineReference(context.spec_ref)
    && context.spec_ref !== 'current-spec.json'
    && !context.spec_sha256
  ) {
    throw new ValidationError(
      'baseline_context.spec_sha256 is required for an immutable composed baseline snapshot',
    );
  }
  if (
    context.spec_sha256
    && rawFileSha256(baselineSpecPath) !== context.spec_sha256
  ) {
    throw new ValidationError(
      `baseline_context.spec_sha256 does not match ${context.spec_ref}`,
    );
  }
  const baselineSpec = loadJson(baselineSpecPath);
  const nestedOptions = {
    artifactRoot: root,
    requireBaselineContextArtifactRoot: true,
    provenanceVisited,
  };
  const rootRealPath = realpathSync(root);
  const allowedBaselineSpecPaths = new Set();
  const allowedBaselineIntakePaths = new Set();
  function registerBaselineSpec(specPath, spec, label) {
    allowedBaselineSpecPaths.add(realpathSync(specPath));
    const sourceIntakePath = requireSpecSourceIntake(specPath, spec);
    if (!sourceIntakePath) return;
    const sourceIntakeRealPath = realpathSync(sourceIntakePath);
    const sourceIntakeRelative = path.relative(rootRealPath, sourceIntakeRealPath);
    if (
      !sourceIntakeRelative
      || sourceIntakeRelative.startsWith('..')
      || path.isAbsolute(sourceIntakeRelative)
    ) {
      throw new ValidationError(
        `${label}.source_intake resolves outside the artifact root: ${JSON.stringify(spec.source_intake)}`,
      );
    }
    allowedBaselineIntakePaths.add(sourceIntakeRealPath);
  }
  if (baselineSpec.schema_version === 'p2a.spec.v1') {
    const validatedBaselineSpec = validateSpec(baselineSpecPath, null, nestedOptions);
    if (
      validatedBaselineSpec.approval !== 'approved'
      || validatedBaselineSpec.open_decisions.length > 0
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref must reference an approved spec with no open_decisions',
      );
    }
    registerBaselineSpec(
      baselineSpecPath,
      validatedBaselineSpec,
      'baseline_context.spec_ref',
    );
  } else if (
    baselineSpec.schema_version !== 'p2a.current_spec.v1'
    || !baselineSpec.effective_product
    || typeof baselineSpec.effective_product !== 'object'
    || Array.isArray(baselineSpec.effective_product)
    || !baselineSpec.effective_implementation
    || typeof baselineSpec.effective_implementation !== 'object'
    || Array.isArray(baselineSpec.effective_implementation)
  ) {
    throw new ValidationError(
      'baseline_context.spec_ref must reference a p2a.spec.v1 artifact or a composed p2a.current_spec.v1 artifact',
    );
  } else {
    validateSafeCurrentSpecIterationId(
      baselineSpec.active_iteration,
      'baseline_context.spec_ref composed current spec',
    );
    if (!Array.isArray(baselineSpec.source_specs) || baselineSpec.source_specs.length === 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty source_specs array',
      );
    }
    if (!Array.isArray(baselineSpec.composed_from) || baselineSpec.composed_from.length === 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty composed_from array',
      );
    }
    if (baselineSpec.effective_spec_ref !== 'current-spec.json') {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must use effective_spec_ref current-spec.json',
      );
    }
    if (typeof baselineSpec.project_id !== 'string' || !baselineSpec.project_id.trim()) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty project_id',
      );
    }
    const sourceIterationIds = baselineSpec.source_specs.map((source) => source?.iteration_id);
    if (
      sourceIterationIds.some((iterationId) => (
        typeof iterationId !== 'string' || !iterationId.trim()
      ))
      || sourceIterationIds.length !== new Set(sourceIterationIds).size
      || !sameJson(sourceIterationIds, baselineSpec.composed_from)
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref composed_from must exactly match unique source_specs iteration_id values in order',
      );
    }
    const openDecisions = baselineSpec.open_decisions ?? [];
    if (!Array.isArray(openDecisions) || openDecisions.length > 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must not have unresolved open_decisions',
      );
    }
    const validatedSources = [];
    const sourceRealPaths = new Set();
    for (const [index, source] of baselineSpec.source_specs.entries()) {
      validateSafeCurrentSpecIterationId(
        source?.iteration_id,
        `baseline_context.spec_ref source_specs[${index}]`,
      );
      const sourceRef = source?.spec_ref;
      if (typeof sourceRef !== 'string' || !sourceRef.trim()) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref must be a non-empty string`,
        );
      }
      if (path.isAbsolute(sourceRef)) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref must be artifact-root-relative`,
        );
      }
      const sourcePath = path.resolve(root, sourceRef);
      const sourceRelative = path.relative(root, sourcePath);
      if (
        !sourceRelative
        || sourceRelative.startsWith('..')
        || path.isAbsolute(sourceRelative)
        || !existsSync(sourcePath)
        || !lstatSync(sourcePath).isFile()
      ) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref is missing or escapes the artifact root: ${JSON.stringify(sourceRef)}`,
        );
      }
      const sourceRealPath = realpathSync(sourcePath);
      const sourceRealRelative = path.relative(realpathSync(root), sourceRealPath);
      if (
        !sourceRealRelative
        || sourceRealRelative.startsWith('..')
        || path.isAbsolute(sourceRealRelative)
      ) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref resolves outside the artifact root: ${JSON.stringify(sourceRef)}`,
        );
      }
      const canonicalSourceRef =
        `iterations/${source.iteration_id}/gate-b-spec/spec.json`;
      if (normalizeReference(sourceRef) !== canonicalSourceRef) {
        throw new ValidationError(
          `baseline_context.spec_ref composed current spec source ${source.iteration_id} spec_ref must be ${canonicalSourceRef}`,
        );
      }
      if (sourceRealPaths.has(sourceRealPath)) {
        throw new ValidationError(
          'baseline_context.spec_ref source_specs must reference unique spec files',
        );
      }
      sourceRealPaths.add(sourceRealPath);
      const sourceSpec = validateSpec(sourcePath, null, nestedOptions);
      if (sourceSpec.project_id !== baselineSpec.project_id) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}] project_id must match the composed current spec`,
        );
      }
      if (sourceSpec.approval !== 'approved') {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}] must reference an approved spec`,
        );
      }
      if (source.approval !== undefined && source.approval !== sourceSpec.approval) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].approval must match its source spec`,
        );
      }
      registerBaselineSpec(
        sourcePath,
        sourceSpec,
        `baseline_context.spec_ref source_specs[${index}]`,
      );
      const metadataPath = path.join(
        root,
        'iterations',
        source.iteration_id,
        'iteration.json',
      );
      let metadata = null;
      if (existsSync(metadataPath)) {
        metadata = loadJson(metadataPath);
        if (
          metadata.iteration_id !== source.iteration_id
          || metadata.project_id !== baselineSpec.project_id
        ) {
          throw new ValidationError(
            `baseline_context.spec_ref source_specs[${index}] iteration metadata must match its source iteration and project`,
          );
        }
      }
      validateComposedBaselineSourceReadiness(
        baselineSpec,
        source,
        sourcePath,
        metadata,
        root,
        `baseline_context.spec_ref source_specs[${index}]`,
      );
      const sourceIntakePath = requireSpecSourceIntake(sourcePath, sourceSpec);
      const sourceIntake = sourceIntakePath ? loadJson(sourceIntakePath) : null;
      validatedSources.push({
        ...source,
        spec: sourceSpec,
        metadata,
        source_intake: sourceIntake,
      });
    }
    const sourceContractError = compositionSourceContractError(validatedSources);
    if (sourceContractError) {
      throw new ValidationError(
        `baseline_context.spec_ref composed current spec ${sourceContractError}`,
      );
    }
    const replayedComposition = composeCanonicalSpecSources(validatedSources);
    if (replayedComposition.compositionConflicts.length > 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec has unresolved stale-baseline composition conflicts',
      );
    }
    if (
      !sameJson(baselineSpec.effective_product, replayedComposition.effectiveProduct)
      || !sameJson(
        baselineSpec.effective_implementation,
        replayedComposition.effectiveImplementation,
      )
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref effective sections must exactly match ordered source composition',
      );
    }
    const replayContractError = compositionReplayContractError(
      baselineSpec,
      replayedComposition,
    );
    if (replayContractError) {
      throw new ValidationError(
        `baseline_context.spec_ref composed current spec ${replayContractError}`,
      );
    }
  }

  const sourceIntakes = new Map();
  for (const [index, item] of context.reused_answers.entries()) {
    const label = `baseline_context.reused_answers[${index}].source_intake`;
    const sourcePath = resolvedReferences.get(label);
    const sourceRealPath = realpathSync(sourcePath);
    if (!allowedBaselineIntakePaths.has(sourceRealPath)) {
      throw new ValidationError(
        `${label} does not belong to the baseline spec source closure`,
      );
    }
    let sourceIntake = sourceIntakes.get(sourceRealPath);
    if (!sourceIntake) {
      sourceIntake = validateIntake(sourcePath, nestedOptions);
      sourceIntakes.set(sourceRealPath, sourceIntake);
    }
    const sourceDecision = sourceIntake.needs_user_decision
      .find((decision) => decision.id === item.id);
    if (
      !sourceDecision
      || sourceDecision.status !== 'answered'
      || sourceDecision.question !== item.question
      || sourceDecision.answer !== item.answer
    ) {
      throw new ValidationError(
        `${label} does not contain matching answered decision ${item.id}`,
      );
    }
  }

  const sourceSpecs = new Map();
  for (const [index, item] of context.reused_question_dispositions.entries()) {
    const label = `baseline_context.reused_question_dispositions[${index}].source_spec`;
    const sourcePath = resolvedReferences.get(label);
    const sourceRealPath = realpathSync(sourcePath);
    if (!allowedBaselineSpecPaths.has(sourceRealPath)) {
      throw new ValidationError(
        `${label} does not belong to the baseline spec source closure`,
      );
    }
    let sourceSpec = sourceSpecs.get(sourceRealPath);
    if (!sourceSpec) {
      sourceSpec = validateSpec(sourcePath, null, nestedOptions);
      sourceSpecs.set(sourceRealPath, sourceSpec);
    }
    const sourceDisposition = sourceSpec.clarifying_question_disposition
      .find((disposition) => disposition.id === item.id);
    if (
      !sourceDisposition
      || sourceDisposition.status !== item.status
      || baselineDispositionResolution(sourceDisposition) !== item.resolution
      || !sameJson(sourceDisposition.affects, item.affects)
    ) {
      throw new ValidationError(
        `${label} does not contain matching disposition ${item.id}`,
      );
    }
  }
  if (activeVisitKey) provenanceVisited.delete(activeVisitKey);
  if (completedVisitKey) provenanceVisited.add(completedVisitKey);
}

function validateInterviewState(intake, unresolvedDecisions) {
  const interview = intake.interview;
  if (!interview) return null;

  const dimensions = interview.discovery_dimensions.map((item) => item.dimension);
  if (
    dimensions.length !== DISCOVERY_DIMENSIONS.length
    || dimensions.length !== new Set(dimensions).size
    || DISCOVERY_DIMENSIONS.some((dimension) => !dimensions.includes(dimension))
  ) {
    throw new ValidationError(
      `intake.interview.discovery_dimensions must contain each required dimension exactly once: ${JSON.stringify(DISCOVERY_DIMENSIONS)}`,
    );
  }

  const evidenceIds = new Set(intake.evidence.map((item) => item.source_id));
  for (const dimension of interview.discovery_dimensions) {
    if (typeof dimension.summary !== 'string' || dimension.summary.trim().length === 0) {
      throw new ValidationError(
        `intake.interview ${dimension.dimension} must have a non-blank summary`,
      );
    }
    for (const sourceId of dimension.source_ids ?? []) {
      if (!evidenceIds.has(sourceId)) {
        throw new ValidationError(`intake.interview ${dimension.dimension} references unknown evidence source_id ${sourceId}`);
      }
    }
    if (dimension.affected_fields.length !== new Set(dimension.affected_fields).size) {
      throw new ValidationError(
        `intake.interview ${dimension.dimension}.affected_fields must not contain duplicates`,
      );
    }
    if (dimension.status === 'open' && dimension.affected_fields.length) {
      throw new ValidationError(
        `intake.interview open dimension ${dimension.dimension} must keep affected_fields empty until its disposition is resolved`,
      );
    }
    const allowedFields = new Set([
      ...(DISCOVERY_SPEC_FIELD_REFS[dimension.dimension] ?? []),
      ...(dimension.status === 'not_applicable' ? ['spec.product.non_goals'] : []),
    ]);
    const invalidFields = dimension.affected_fields.filter((field) => !allowedFields.has(field));
    if (invalidFields.length) {
      throw new ValidationError(
        `intake.interview ${dimension.dimension}.affected_fields contains fields outside its canonical routing: ${JSON.stringify(invalidFields)}`,
      );
    }
    if (
      !intake.baseline_context
      && ['confirmed', 'assumed'].includes(dimension.status)
      && dimension.affected_fields.length === 0
    ) {
      throw new ValidationError(
        `intake.interview greenfield ${dimension.dimension} must declare at least one affected_fields entry or be explicitly not_applicable`,
      );
    }
  }

  const questionIds = [
    ...intake.clarifying_questions.map((item) => item.id),
    ...intake.needs_user_decision.map((item) => item.id),
  ];
  if (questionIds.length !== new Set(questionIds).size) {
    throw new ValidationError('intake question and decision ids must be unique');
  }
  for (const [index, question] of intake.clarifying_questions.entries()) {
    if (typeof question.status !== 'string') {
      throw new ValidationError(
        `intake.clarifying_questions[${index}].status is required when intake.interview is present`,
      );
    }
    if (!Array.isArray(question.blocks) || question.blocks.length === 0) {
      throw new ValidationError(
        `intake.clarifying_questions[${index}].blocks must contain at least one canonical spec field`,
      );
    }
    const invalidBlocks = question.blocks.filter((field) => !CANONICAL_SPEC_FIELD_REFS.has(field));
    if (invalidBlocks.length) {
      throw new ValidationError(
        `intake.clarifying_questions[${index}].blocks[0] must reference a canonical spec field; invalid values=${JSON.stringify(invalidBlocks)}`,
      );
    }
    const affectedFields = question.affected_fields;
    if (affectedFields !== undefined) {
      const outsideBlocks = affectedFields.filter((field) => !question.blocks.includes(field));
      if (outsideBlocks.length) {
        throw new ValidationError(
          `intake.clarifying_questions[${index}].affected_fields must be a subset of blocks; invalid values=${JSON.stringify(outsideBlocks)}`,
        );
      }
      if (question.status === 'open' && affectedFields.length) {
        throw new ValidationError(
          `intake.clarifying_questions[${index}].affected_fields must be empty while the question is open`,
        );
      }
    }
    const resolved = ['answered', 'assumed', 'not_applicable'].includes(question.status);
    if (!resolved && question.canonical_effect !== undefined) {
      throw new ValidationError(
        `intake.clarifying_questions[${index}].canonical_effect is only allowed after the question is resolved`,
      );
    }
    if (resolved) {
      if (!question.canonical_effect) {
        throw new ValidationError(
          `intake.clarifying_questions[${index}].canonical_effect is required after the question is resolved`,
        );
      }
      if (question.canonical_effect === 'change' && affectedFields?.length === 0) {
        throw new ValidationError(
          `intake.clarifying_questions[${index}].canonical_effect change requires non-empty affected_fields`,
        );
      }
      if (
        question.canonical_effect === 'preserve_baseline'
        && (
          !intake.baseline_context
          || affectedFields?.length !== 0
        )
      ) {
        throw new ValidationError(
          `intake.clarifying_questions[${index}].canonical_effect preserve_baseline requires baseline_context and empty affected_fields`,
        );
      }
    }
  }
  for (const field of ['asked_question_ids', 'current_question_ids']) {
    const ids = interview[field];
    if (ids.length !== new Set(ids).size) {
      throw new ValidationError(`intake.interview.${field} must not contain duplicate ids`);
    }
    const unknown = ids.filter((id) => !questionIds.includes(id));
    if (unknown.length) {
      throw new ValidationError(`intake.interview.${field} references unknown ids: ${JSON.stringify(unknown)}`);
    }
  }
  if (interview.current_question_ids.length > 3) {
    throw new ValidationError('intake.interview.current_question_ids must contain at most 3 questions');
  }
  const unrecordedCurrent = interview.current_question_ids
    .filter((id) => !interview.asked_question_ids.includes(id));
  if (unrecordedCurrent.length) {
    throw new ValidationError(`intake.interview.current_question_ids must also appear in asked_question_ids: ${JSON.stringify(unrecordedCurrent)}`);
  }
  const answeredQuestionIds = [
    ...intake.clarifying_questions
      .filter((item) => item.status === 'answered')
      .map((item) => item.id),
    ...intake.needs_user_decision
      .filter((item) => item.status === 'answered')
      .map((item) => item.id),
  ];
  const unrecordedAnswered = answeredQuestionIds
    .filter((id) => !interview.asked_question_ids.includes(id));
  if (unrecordedAnswered.length) {
    throw new ValidationError(
      `intake.interview answered questions must appear in asked_question_ids: ${JSON.stringify(unrecordedAnswered)}`,
    );
  }
  const decisionsWithoutBlocks = intake.needs_user_decision
    .filter((item) => !Array.isArray(item.blocks) || item.blocks.length === 0)
    .map((item) => item.id);
  if (decisionsWithoutBlocks.length) {
    throw new ValidationError(
      `intake interview decisions must declare non-empty blocks: ${JSON.stringify(decisionsWithoutBlocks)}`,
    );
  }
  for (const [index, decision] of intake.needs_user_decision.entries()) {
    const affectedFields = decision.affected_fields;
    if (affectedFields !== undefined) {
      const outsideBlocks = affectedFields.filter((field) => !decision.blocks.includes(field));
      if (outsideBlocks.length) {
        throw new ValidationError(
          `intake.needs_user_decision[${index}].affected_fields must be a subset of blocks; invalid values=${JSON.stringify(outsideBlocks)}`,
        );
      }
      if (decision.status !== 'answered' && affectedFields.length) {
        throw new ValidationError(
          `intake.needs_user_decision[${index}].affected_fields must be empty until the decision is answered`,
        );
      }
    }
    const resolved = decision.status === 'answered';
    if (!resolved && decision.canonical_effect !== undefined) {
      throw new ValidationError(
        `intake.needs_user_decision[${index}].canonical_effect is only allowed after the decision is answered`,
      );
    }
    if (resolved) {
      if (!decision.canonical_effect) {
        throw new ValidationError(
          `intake.needs_user_decision[${index}].canonical_effect is required after the decision is answered`,
        );
      }
      if (decision.canonical_effect === 'change' && affectedFields?.length === 0) {
        throw new ValidationError(
          `intake.needs_user_decision[${index}].canonical_effect change requires non-empty affected_fields`,
        );
      }
      if (
        decision.canonical_effect === 'preserve_baseline'
        && (
          !intake.baseline_context
          || affectedFields?.length !== 0
        )
      ) {
        throw new ValidationError(
          `intake.needs_user_decision[${index}].canonical_effect preserve_baseline requires baseline_context and empty affected_fields`,
        );
      }
    }
  }

  const questionsById = new Map([
    ...intake.clarifying_questions.map((item) => [item.id, item]),
    ...intake.needs_user_decision.map((item) => [item.id, item]),
  ]);
  validateInterviewSpecUpdates(intake, questionsById);
  const resolvedQuestionIds = interview.asked_question_ids.filter((id) => {
    const item = questionsById.get(id);
    return item?.status === 'answered'
      || item?.status === 'assumed'
      || item?.status === 'not_applicable';
  });
  const resolvedCurrentQuestionIds = interview.current_question_ids
    .filter((id) => resolvedQuestionIds.includes(id));
  if (resolvedCurrentQuestionIds.length) {
    throw new ValidationError(
      `intake.interview.current_question_ids must reference unresolved questions: ${JSON.stringify(resolvedCurrentQuestionIds)}`,
    );
  }
  const unresolvedAskedQuestionIds = interview.asked_question_ids
    .filter((id) => !resolvedQuestionIds.includes(id));
  const unresolvedClarifyingQuestionIds = intake.clarifying_questions
    .filter((item) => !['answered', 'assumed', 'not_applicable'].includes(item.status))
    .map((item) => item.id);
  const unresolvedQuestionIds = [
    ...new Set([
      ...unresolvedAskedQuestionIds,
      ...unresolvedClarifyingQuestionIds,
    ]),
  ];
  const openDimensions = interview.discovery_dimensions
    .filter((item) => item.status === 'open')
    .map((item) => item.dimension);
  const readiness = (
    openDimensions.length === 0
    && unresolvedDecisions.length === 0
    && unresolvedQuestionIds.length === 0
    && !interview.has_unasked_high_impact_questions
    && !interview.new_blocker
  );

  const stoppedStates = new Set([
    'ready_for_gate_a_summary',
    'awaiting_gate_a_confirmation',
    'paused',
    'blocked_on_user',
    'gate_a_confirmed',
  ]);
  if (stoppedStates.has(interview.state) && interview.current_question_ids.length) {
    throw new ValidationError(`intake.interview.current_question_ids must be empty when state is ${interview.state}`);
  }
  if (interview.state === 'interview_active') {
    if (interview.round < 1 || interview.current_question_ids.length < 1) {
      throw new ValidationError('active interview requires round >= 1 and a current batch of 1 to 3 questions');
    }
    if (
      !readiness
      && interview.round >= 3
      && interview.round < 5
      && !interview.soft_limit_acknowledged
    ) {
      throw new ValidationError(
        'an interview with remaining blockers at or beyond round 3 must pause for the soft-limit summary and a human continue, accept, or pause decision',
      );
    }
    if (interview.stop_reason !== null) {
      throw new ValidationError('active interview must have stop_reason null');
    }
    if (interview.no_progress_rounds >= 2) {
      throw new ValidationError('active interview cannot continue after 2 no-progress rounds');
    }
  }
  if (interview.soft_limit_acknowledged && interview.round < 3) {
    throw new ValidationError('soft_limit_acknowledged requires interview.round to be at least 3');
  }
  if (['ready_for_gate_a_summary', 'awaiting_gate_a_confirmation', 'gate_a_confirmed'].includes(interview.state) && !readiness) {
    throw new ValidationError(
      `intake.interview state ${interview.state} requires readiness; open dimensions=${JSON.stringify(openDimensions)}, unresolved questions=${JSON.stringify(unresolvedQuestionIds)}, unresolved decisions=${JSON.stringify(unresolvedDecisions)}`,
    );
  }
  if (['paused', 'blocked_on_user'].includes(interview.state) && readiness) {
    throw new ValidationError(`intake.interview state ${interview.state} cannot be used when readiness is already satisfied`);
  }
  if (interview.state === 'blocked_on_user' && ![
    'user_requested',
    'hard_limit',
    'no_progress',
  ].includes(interview.stop_reason)) {
    throw new ValidationError('blocked interview must record user_requested, hard_limit, or no_progress as stop_reason');
  }
  if (interview.state === 'paused' && !['user_requested', 'soft_limit'].includes(interview.stop_reason)) {
    throw new ValidationError('paused interview must record user_requested or soft_limit as stop_reason');
  }
  if (
    interview.stop_reason === 'soft_limit'
    && (interview.round < 3 || interview.round >= 5)
  ) {
    throw new ValidationError('soft_limit requires interview.round to be 3 or 4; use hard_limit at round 5');
  }
  if (
    ['ready_for_gate_a_summary', 'awaiting_gate_a_confirmation', 'gate_a_confirmed'].includes(interview.state)
    && !['readiness', 'user_requested', 'soft_limit'].includes(interview.stop_reason)
  ) {
    throw new ValidationError(`${interview.state} must record readiness, user_requested, or soft_limit as stop_reason`);
  }
  if (interview.stop_reason === 'hard_limit' && interview.round < 5) {
    throw new ValidationError('hard_limit requires interview.round to be 5');
  }
  if (interview.stop_reason === 'no_progress' && interview.no_progress_rounds < 2) {
    throw new ValidationError('no_progress stop requires no_progress_rounds to be 2');
  }
  if (
    !readiness
    && interview.round >= 5
    && (interview.state !== 'blocked_on_user' || interview.stop_reason !== 'hard_limit')
  ) {
    throw new ValidationError(
      'an interview with remaining blockers at round 5 must stop as blocked_on_user with hard_limit',
    );
  }
  if (
    !readiness
    && interview.round < 5
    && interview.no_progress_rounds >= 2
    && (interview.state !== 'blocked_on_user' || interview.stop_reason !== 'no_progress')
  ) {
    throw new ValidationError(
      'an interview with remaining blockers after 2 no-progress rounds must stop as blocked_on_user with no_progress',
    );
  }

  if (interview.state === 'gate_a_confirmed') {
    if (!intake.approval_audit) {
      throw new ValidationError('intake.approval_audit is required when interview.state is gate_a_confirmed');
    }
    validateApprovalAuditData(intake.approval_audit, 'intake.approval_audit');
    if (!intake.approval_audit.approved_artifacts.some((item) => item.endsWith('gate-a-intake/intake.json'))) {
      throw new ValidationError('intake.approval_audit.approved_artifacts must include gate-a-intake/intake.json');
    }
  } else if (intake.approval_audit) {
    throw new ValidationError('intake.approval_audit is only allowed when interview.state is gate_a_confirmed');
  }

  return interview.state === 'gate_a_confirmed' ? 'ready_for_spec' : 'blocked_on_user';
}

export function validateIntake(filePath, options = {}) {
  const data = validateAgainstSchema(filePath, 'intake');
  validateEvidence(data.evidence, 'intake');

  const clarifyingQuestionIds = data.clarifying_questions.map((question) => question.id);
  if (clarifyingQuestionIds.length !== new Set(clarifyingQuestionIds).size) {
    throw new ValidationError('intake.clarifying_questions id values must be unique');
  }
  for (const question of data.clarifying_questions) validateIntakeQuestion(question);

  const decisionIds = data.needs_user_decision.map((decision) => decision.id);
  if (decisionIds.length !== new Set(decisionIds).size) {
    throw new ValidationError('intake.needs_user_decision id values must be unique');
  }
  const unresolvedDecisions = [];
  for (const decision of data.needs_user_decision) {
    if (decision.status === 'open' || decision.status === 'deferred') {
      unresolvedDecisions.push(decision.id);
    }
    const hasAnswer = Object.hasOwn(decision, 'answer');
    const hasNonBlankAnswer = (
      typeof decision.answer === 'string'
      && decision.answer.trim().length > 0
    );
    if (
      decision.status === 'answered'
      && (data.interview ? !hasNonBlankAnswer : !decision.answer)
    ) {
      throw new ValidationError(`${decision.id} is answered but has no non-blank answer`);
    }
    if (
      (decision.status === 'open' || decision.status === 'deferred')
      && (data.interview ? hasAnswer : Boolean(decision.answer))
    ) {
      throw new ValidationError(`${decision.id} is unresolved but has an answer`);
    }
  }

  validateBaselineContext(
    data,
    options.artifactRoot,
    options.requireBaselineContextArtifactRoot === true,
    options.provenanceVisited ?? new Set(),
    filePath,
  );
  const interviewStatus = validateInterviewState(data, unresolvedDecisions);
  validateInterviewSpecUpdateMateriality(data, options.artifactRoot, filePath);
  if (!data.interview && data.approval_audit) {
    validateApprovalAuditData(data.approval_audit, 'intake.approval_audit');
  }
  const expectedStatus = interviewStatus
    ?? (unresolvedDecisions.length ? 'blocked_on_user' : 'ready_for_spec');
  if (data.status !== expectedStatus) {
    throw new ValidationError(
      `intake.status must be ${JSON.stringify(expectedStatus)} for its decision and interview state`,
    );
  }
  if (options.intakeMdPath) validateIntakeMarkdownDecisionSync(data, options.intakeMdPath);
  return data;
}

export function validateIntakeMarkdownDecisionSync(intake, intakeMdPath) {
  const text = readFileSync(intakeMdPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const decision of intake.needs_user_decision) {
    if (decision.status !== 'answered') continue;
    const idPattern = new RegExp(String.raw`(^|\n)([^\n]*\b${escapeRegExp(decision.id)}\b[^\n]*)([\s\S]*?)(?=\n[^\n]*\b(?:ND|CQ|A)-\d+\b|\n#{1,6}\s+|$)`, 'i');
    const match = text.match(idPattern);
    if (!match) continue;
    const block = `${match[2]}${match[3]}`;
    const clearlyOpen = /(?:status|상태)\s*[:：-]\s*(?:`?open`?|미해결|열림)\b/i.test(block);
    const clearlyAnswered = /(?:status|상태)\s*[:：-]\s*(?:`?answered`?|답변|완료)\b/i.test(block);
    if (clearlyOpen && !clearlyAnswered) {
      throw new ValidationError(`${decision.id} is answered in intake.json but intake.md still marks it open`);
    }
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateSpec(filePath, intakePath = null, options = {}) {
  const data = validateAgainstSchema(filePath, 'spec');
  const referencedIntakePath = requireSpecSourceIntake(filePath, data);
  const providedIntakePath = intakePath ? path.resolve(intakePath) : null;
  if (providedIntakePath) {
    assertFile(providedIntakePath, 'provided intake');
    if (!referencedIntakePath) {
      throw new ValidationError(
        `spec.source_intake cannot be resolved to the provided intake: ${JSON.stringify(data.source_intake)}`,
      );
    }
    if (realpathSync(referencedIntakePath) !== realpathSync(providedIntakePath)) {
      throw new ValidationError(
        `provided intake does not match spec.source_intake ${JSON.stringify(data.source_intake)}`,
      );
    }
  }
  const resolvedIntakePath = providedIntakePath ?? referencedIntakePath;
  const artifactRoot = options.artifactRoot
    ?? (resolvedIntakePath ? inferArtifactRootFromIntakePath(resolvedIntakePath) : null);
  if (resolvedIntakePath && artifactRoot) {
    assertFileInsideArtifactRoot(
      resolvedIntakePath,
      artifactRoot,
      'spec.source_intake',
    );
  }
  const intakeValidationOptions = artifactRoot
    ? { ...options, artifactRoot }
    : options;
  const intake = resolvedIntakePath
    ? validateIntake(resolvedIntakePath, intakeValidationOptions)
    : null;
  if (intake?.interview && !data.source_intake_sha256) {
    throw new ValidationError(
      'interview-aware specs must include source_intake_sha256',
    );
  }
  if (
    data.source_intake_sha256
    && rawFileSha256(resolvedIntakePath) !== data.source_intake_sha256
  ) {
    throw new ValidationError(
      `spec.source_intake_sha256 does not match ${resolvedIntakePath}`,
    );
  }
  if (intake) {
    validateInterviewSpecApplication(
      data,
      intake,
      artifactRoot,
      resolvedIntakePath,
    );
  }
  validateEvidence(data.evidence, 'spec');
  validateTechnologyReconnaissanceEvidence(data);
  validateReferenceReconnaissance(data);
  validateClarifyingQuestionDisposition(data, intake);
  if (data.approval === 'approved' && data.open_decisions.length) {
    throw new ValidationError('approved specs must not contain open_decisions');
  }
  validateSpecApprovalAudit(data);

  if (intake) {
    const intakeDecisions = new Map(intake.needs_user_decision.map((decision) => [decision.id, decision.status]));
    const promotedDecisions = new Set(
      data.clarifying_question_disposition
        .filter((item) => item.status === 'promoted_to_decision')
        .map((item) => item.promoted_decision_id),
    );
    const promotedDecisionIds = [...promotedDecisions];
    const collidingPromotedDecisions = promotedDecisionIds.filter((decisionId) => intakeDecisions.has(decisionId));
    if (collidingPromotedDecisions.length) {
      throw new ValidationError(`spec.clarifying_question_disposition promoted_decision_id must not reuse intake decision ids: ${JSON.stringify(collidingPromotedDecisions)}`);
    }
    const unknownDecisions = data.open_decisions.filter((decisionId) => !intakeDecisions.has(decisionId) && !promotedDecisions.has(decisionId));
    if (unknownDecisions.length) {
      throw new ValidationError(`spec.open_decisions references unknown decisions: ${JSON.stringify(unknownDecisions)}`);
    }
    const unresolvedDecisions = new Set(
      [...intakeDecisions.entries()]
        .filter(([, status]) => status === 'open' || status === 'deferred')
        .map(([decisionId]) => decisionId),
    );
    for (const item of data.clarifying_question_disposition) {
      if (item.status === 'promoted_to_decision' && !item.resolution) {
        unresolvedDecisions.add(item.promoted_decision_id);
      }
    }
    const specOpenDecisions = new Set(data.open_decisions);
    const expected = [...unresolvedDecisions].sort();
    const got = [...specOpenDecisions].sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      throw new ValidationError(
        `spec.open_decisions must exactly match unresolved decisions: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
    }
  }
  return data;
}

export function validateApprovalAuditData(audit, label = 'approval audit') {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const requiredStrings = ['approved_by', 'approved_at', 'approval_note'];
  for (const field of requiredStrings) {
    if (typeof audit[field] !== 'string' || audit[field].trim().length === 0) {
      throw new ValidationError(`${label}.${field} must be a non-empty string`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(audit.approved_at)) {
    throw new ValidationError(`${label}.approved_at must start with YYYY-MM-DD`);
  }
  if (!Array.isArray(audit.approved_artifacts) || audit.approved_artifacts.length === 0) {
    throw new ValidationError(`${label}.approved_artifacts must be a non-empty array`);
  }
  validateNonBlankStrings(audit.approved_artifacts, `${label}.approved_artifacts`);
  return audit;
}

export function validateSpecApprovalAudit(spec, label = 'spec.approval_audit') {
  if (spec.approval !== 'approved') return null;
  if (!spec.approval_audit) {
    throw new ValidationError(`${label} is required when spec.approval is approved`);
  }
  return validateApprovalAuditData(spec.approval_audit, label);
}

export function validateCurrentSpecGateBApprovalAudit(currentSpec, iterationId, spec) {
  if (spec.approval !== 'approved') return null;
  const audit = currentSpec?.gate_b_approval_audits?.[iterationId];
  if (!audit) {
    throw new ValidationError(`current-spec.json gate_b_approval_audits.${iterationId} is required for approved Gate B`);
  }
  return validateApprovalAuditData(audit, `current-spec.json gate_b_approval_audits.${iterationId}`);
}

export function validateCurrentSpecGateCApprovalAudit(currentSpec, iterationId) {
  const audit = currentSpec?.gate_c_approval_audits?.[iterationId];
  if (!audit) {
    throw new ValidationError(`current-spec.json gate_c_approval_audits.${iterationId} is required for promoted Gate C task graph`);
  }
  return validateApprovalAuditData(audit, `current-spec.json gate_c_approval_audits.${iterationId}`);
}

function validateClarifyingQuestionDisposition(spec, intake = null) {
  const dispositions = spec.clarifying_question_disposition;
  const dispositionIds = dispositions.map((item) => item.id);
  if (dispositionIds.length !== new Set(dispositionIds).size) {
    throw new ValidationError('spec.clarifying_question_disposition id values must be unique');
  }
  const openDecisions = new Set(spec.open_decisions);
  const detailFields = ['resolved_by', 'assumption', 'non_goal', 'promoted_decision_id', 'resolution'];
  const allowedDetailFields = new Map([
    ['answered', new Set(['resolved_by'])],
    ['assumed', new Set(['assumption'])],
    ['deferred_non_goal', new Set(['non_goal'])],
    ['promoted_to_decision', new Set(['promoted_decision_id', 'resolution'])],
  ]);
  const promotedDecisionIds = dispositions
    .filter((item) => item.status === 'promoted_to_decision')
    .map((item) => item.promoted_decision_id);
  if (promotedDecisionIds.length !== new Set(promotedDecisionIds).size) {
    throw new ValidationError('spec.clarifying_question_disposition promoted_decision_id values must be unique');
  }

  for (const item of dispositions) {
    validateNonBlankStrings(item.affects, `${item.id}.affects`);
    const allowedFields = allowedDetailFields.get(item.status);
    const disallowedFields = detailFields.filter((field) => Object.hasOwn(item, field) && !allowedFields.has(field));
    if (disallowedFields.length) {
      throw new ValidationError(`${item.id} disposition status ${item.status} does not allow fields: ${JSON.stringify(disallowedFields)}`);
    }
    if (item.status === 'answered' && !item.resolved_by) {
      throw new ValidationError(`${item.id} disposition status answered requires resolved_by`);
    }
    if (item.status === 'assumed' && !item.assumption) {
      throw new ValidationError(`${item.id} disposition status assumed requires assumption`);
    }
    if (item.status === 'deferred_non_goal' && !item.non_goal) {
      throw new ValidationError(`${item.id} disposition status deferred_non_goal requires non_goal`);
    }
    if (item.status === 'promoted_to_decision') {
      if (!item.promoted_decision_id) {
        throw new ValidationError(`${item.id} disposition status promoted_to_decision requires promoted_decision_id`);
      }
      const isOpen = openDecisions.has(item.promoted_decision_id);
      if (isOpen && item.resolution) {
        throw new ValidationError(`${item.id} promoted decision ${item.promoted_decision_id} has resolution but is still listed in open_decisions`);
      }
      if (!isOpen && !item.resolution) {
        throw new ValidationError(`${item.id} promoted decision ${item.promoted_decision_id} must be in open_decisions until it has a resolution`);
      }
    }
  }

  if (intake) {
    const intakeCqIds = intake.clarifying_questions.map((question) => question.id);
    const intakeCqSet = new Set(intakeCqIds);
    const unknown = dispositionIds.filter((id) => !intakeCqSet.has(id));
    if (unknown.length) {
      throw new ValidationError(`spec.clarifying_question_disposition references unknown intake clarifying questions: ${JSON.stringify(unknown)}`);
    }
    const dispositionSet = new Set(dispositionIds);
    const missing = intakeCqIds.filter((id) => !dispositionSet.has(id));
    if (missing.length) {
      throw new ValidationError(`spec.clarifying_question_disposition is missing intake clarifying questions: ${JSON.stringify(missing)}`);
    }
    if (intake.interview) {
      const dispositionsById = new Map(dispositions.map((item) => [item.id, item]));
      const expectedByQuestionStatus = new Map([
        ['answered', ['answered', 'resolved_by']],
        ['assumed', ['assumed', 'assumption']],
        ['not_applicable', ['deferred_non_goal', 'non_goal']],
      ]);
      for (const question of intake.clarifying_questions) {
        const expected = expectedByQuestionStatus.get(question.status);
        if (!expected) continue;
        const [expectedStatus, detailField] = expected;
        const disposition = dispositionsById.get(question.id);
        if (
          disposition.status !== expectedStatus
          || disposition[detailField] !== question.answer
          || !sameJson(disposition.affects, question.blocks)
        ) {
          throw new ValidationError(
            `spec.clarifying_question_disposition ${question.id} must preserve its Gate A ${question.status} status, answer, and blocks`,
          );
        }
      }
    }
  }
}

export function validateTaskContextData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.task_context));
  return data;
}

export function validateTaskGraphData(data, requireApprovedSpec = null) {
  const schema = loadJson(SCHEMA_PATHS.task_graph);
  validateSchema(data, schema);
  if (requireApprovedSpec) {
    const specReference = loadJson(requireApprovedSpec);
    const sourceIntakePath = requireSpecSourceIntake(requireApprovedSpec, specReference);
    const spec = validateSpec(requireApprovedSpec, sourceIntakePath);
    if (spec.approval !== 'approved') {
      throw new ValidationError('task graph generation is blocked until spec.approval is approved');
    }
    if (spec.open_decisions.length) {
      throw new ValidationError('task graph generation is blocked while spec.open_decisions is non-empty');
    }
  }

  const tasks = data.tasks;
  const taskIds = tasks.map((task) => task.id);
  if (taskIds.length !== new Set(taskIds).size) {
    throw new ValidationError('task ids must be unique');
  }
  const taskIdSet = new Set(taskIds);

  const graph = new Map();
  for (const task of tasks) {
    validateNonBlankStrings(task.acceptanceCriteria, `${task.id}.acceptanceCriteria`);
    validateNonBlankStrings(task.sourceSpecRefs, `${task.id}.sourceSpecRefs`);
    if (typeof task.blockNote === 'string' && task.blockNote.trim().length === 0) {
      throw new ValidationError(`${task.id}.blockNote must not be blank`);
    }
    const unknownDependencies = task.dependencies.filter((dependency) => !taskIdSet.has(dependency));
    if (unknownDependencies.length) {
      throw new ValidationError(`${task.id} has unknown dependencies: ${JSON.stringify(unknownDependencies)}`);
    }
    graph.set(task.id, [...task.dependencies]);
  }

  detectCycles(graph);
  return data;
}

function validateNonBlankStrings(values, label) {
  for (const [index, value] of values.entries()) {
    if (value.trim().length === 0) {
      throw new ValidationError(`${label}[${index}] must not be blank`);
    }
  }
}

export function validateTaskGraph(filePath, requireApprovedSpec = null) {
  return validateTaskGraphData(loadJson(filePath), requireApprovedSpec);
}

export function validateReview(filePath, expectedSources = null, options = {}) {
  const data = validateAgainstSchema(filePath, 'review');
  if (expectedSources) {
    for (const [field, expected] of Object.entries(expectedSources)) {
      if (data[field] !== expected) {
        throw new ValidationError(`review.${field} must reference ${JSON.stringify(expected)}, got ${JSON.stringify(data[field])}`);
      }
    }
  }
  if (options.requirePass) validateReviewPassData(data);
  return data;
}

export function validateReviewPass(filePath, expectedSources = null) {
  return validateReview(filePath, expectedSources, { requirePass: true });
}

function hasStructuredDetailValue(section, keys) {
  if (!section || typeof section !== 'object') return false;
  return keys.some((key) => Array.isArray(section[key])
    && section[key].some((value) => typeof value === 'string' && value.trim().length > 0));
}

function missingRequiredStructuredRunDetails(data) {
  if (!['failed', 'blocked'].includes(data.status)) return [];
  return [
    hasStructuredDetailValue(data.reproduction, ['steps', 'commands', 'notes']) ? null : 'reproduction',
    hasStructuredDetailValue(data.localization, ['findings', 'files']) ? null : 'localization',
    hasStructuredDetailValue(data.guard, ['checks', 'notes']) ? null : 'guard',
  ].filter(Boolean);
}

export function validateRunData(data) {
  try {
    validateSchema(data, loadJson(SCHEMA_PATHS.run));
  } catch (error) {
    if (error instanceof ValidationError && data?.status && ['failed', 'blocked'].includes(data.status) && !data.failure) {
      throw new ValidationError(`${data.status} run must include failure with class, retryable, needsUserDecision, and source`);
    }
    if (error instanceof ValidationError && data?.failure && ['started', 'finished'].includes(data.status)) {
      throw new ValidationError(`${data.status} run must not include failure`);
    }
    throw error;
  }
  for (const [index, item] of (data.verification ?? []).entries()) {
    if (item.status === 'unavailable' && (!item.failureReason || !item.failureHint)) {
      throw new ValidationError(`verification[${index}] unavailable status must include failureReason and failureHint`);
    }
  }
  if (data.status === 'started' && data.finishedAt !== null) {
    throw new ValidationError('started run must have finishedAt null');
  }
  if (data.status !== 'started' && data.finishedAt === null) {
    throw new ValidationError(`${data.status} run must include finishedAt`);
  }
  const missingStructured = missingRequiredStructuredRunDetails(data);
  if (missingStructured.length) {
    throw new ValidationError(`${data.status} run must include structured debug detail: ${missingStructured.join(', ')}`);
  }
  return data;
}

export function validateRun(filePath) {
  const data = validateRunData(loadJson(filePath));
  const expectedName = `${data.runId}.json`;
  if (path.basename(filePath) !== expectedName) {
    throw new ValidationError(`run filename must be ${expectedName}`);
  }
  return data;
}

export function validateRunIndexData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.run_index));
  const runIds = data.runs.map((run) => run.runId);
  if (runIds.length !== new Set(runIds).size) {
    throw new ValidationError('run-index runs[].runId values must be unique');
  }
  const indexedTaskIds = data.tasks.map((task) => task.taskId);
  if (indexedTaskIds.length !== new Set(indexedTaskIds).size) {
    throw new ValidationError('run-index tasks[].taskId values must be unique');
  }
  const runIdSet = new Set(runIds);
  for (const run of data.runs) {
    if (!isSupportedRunRef(run)) {
      throw new ValidationError(
        `run-index ${run.runId}.runRef must be ${legacyRunRef(run.runId)} or ${canonicalRunRef(run)}`,
      );
    }
  }
  for (const task of data.tasks) {
    const missing = task.runIds.filter((runId) => !runIdSet.has(runId));
    if (missing.length) throw new ValidationError(`${task.taskId} references unknown run ids: ${JSON.stringify(missing)}`);
    if (task.latestRunId !== null && !runIdSet.has(task.latestRunId)) {
      throw new ValidationError(`${task.taskId} latestRunId is unknown: ${task.latestRunId}`);
    }
    const indexedRuns = data.runs.filter((run) => run.taskId === task.taskId).map((run) => run.runId);
    if (JSON.stringify(indexedRuns) !== JSON.stringify(task.runIds)) {
      throw new ValidationError(`${task.taskId} runIds must match runs[] order`);
    }
    const expectedLatestRunId = task.runIds.at(-1) ?? null;
    if (task.latestRunId !== expectedLatestRunId) {
      throw new ValidationError(`${task.taskId} latestRunId must be the last runIds entry: ${expectedLatestRunId ?? 'null'}`);
    }
  }
  const taskIdSet = new Set(indexedTaskIds);
  const missingTasks = data.runs.map((run) => run.taskId).filter((taskId) => !taskIdSet.has(taskId));
  if (missingTasks.length) {
    throw new ValidationError(`run-index tasks[] is missing task ids: ${JSON.stringify([...new Set(missingTasks)])}`);
  }
  return data;
}

export function validateRunIndex(filePath) {
  return validateRunIndexData(loadJson(filePath));
}

function assertUniqueStrings(values, label) {
  if (values.length !== new Set(values).size) {
    throw new ValidationError(`${label} values must be unique`);
  }
}

function rawFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function deterministicSnapshotSha256(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function milestoneSnapshotSha256(taskGraph) {
  return deterministicSnapshotSha256(taskGraph);
}

export function milestoneRunSnapshotSha256(run) {
  return deterministicSnapshotSha256(run);
}

function parsedTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new ValidationError(`${label} must be a valid timestamp`);
  return timestamp;
}

export function validateMilestoneReviewData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.milestone_review));

  const graphSnapshot = validateTaskGraphData(data.source.task_graph_snapshot);
  if (graphSnapshot.projectId !== data.project_id) {
    throw new ValidationError(`milestone review task_graph_snapshot.projectId must match project_id ${JSON.stringify(data.project_id)}`);
  }
  const snapshotSha256 = milestoneSnapshotSha256(graphSnapshot);
  if (snapshotSha256 !== data.source.task_graph_snapshot_sha256) {
    throw new ValidationError(`milestone review task_graph_snapshot_sha256 mismatch: expected ${snapshotSha256}`);
  }
  parsedTimestamp(data.generated_at, 'milestone review generated_at');

  const counts = data.source.task_counts;
  const accountedTotal = counts.done + counts.todo + counts.in_progress + counts.blocked;
  if (accountedTotal !== counts.total) {
    throw new ValidationError(`milestone review task_counts must sum to total ${counts.total}, got ${accountedTotal}`);
  }

  const taskSnapshotIds = data.source.task_snapshot.map((item) => item.task_id);
  assertUniqueStrings(taskSnapshotIds, 'milestone review task snapshot ids');
  if (taskSnapshotIds.length !== counts.total) {
    throw new ValidationError(`milestone review task_snapshot must contain ${counts.total} task(s)`);
  }
  for (const status of ['done', 'todo', 'in_progress', 'blocked']) {
    const snapshotCount = data.source.task_snapshot.filter((item) => item.status === status).length;
    if (snapshotCount !== counts[status]) {
      throw new ValidationError(`milestone review task_snapshot ${status} count must be ${counts[status]}, got ${snapshotCount}`);
    }
  }
  if (graphSnapshot.tasks.length !== data.source.task_snapshot.length) {
    throw new ValidationError('milestone review task_snapshot must cover every task in task_graph_snapshot');
  }
  for (const item of data.source.task_snapshot) {
    const graphTask = graphSnapshot.tasks.find((task) => task.id === item.task_id);
    if (!graphTask || graphTask.title !== item.task_title || graphTask.status !== item.status) {
      throw new ValidationError(`${item.task_id} task_snapshot must match task_graph_snapshot id/title/status`);
    }
  }

  const completedTaskEvidence = data.source.completed_task_evidence.map((item) => ({
    item,
    runSnapshot: validateRunData(item.run_snapshot),
  }));
  const completedTaskIds = completedTaskEvidence.map(({ runSnapshot }) => runSnapshot.taskId);
  const remainingTaskIds = data.source.remaining_task_ids;
  assertUniqueStrings(completedTaskIds, 'milestone review completed task ids');
  assertUniqueStrings(remainingTaskIds, 'milestone review remaining task ids');
  if (completedTaskIds.length !== counts.done) {
    throw new ValidationError(`milestone review completed_task_evidence must contain ${counts.done} done task(s)`);
  }
  if (remainingTaskIds.length !== counts.total - counts.done) {
    throw new ValidationError(`milestone review remaining_task_ids must contain ${counts.total - counts.done} task(s)`);
  }
  const completedTaskIdSet = new Set(completedTaskIds);
  const remainingTaskIdSet = new Set(remainingTaskIds);
  const overlap = completedTaskIds.filter((taskId) => remainingTaskIdSet.has(taskId));
  if (overlap.length) {
    throw new ValidationError(`milestone review completed and remaining task ids overlap: ${JSON.stringify(overlap)}`);
  }
  const snapshotDoneIds = new Set(data.source.task_snapshot.filter((item) => item.status === 'done').map((item) => item.task_id));
  const snapshotRemainingIds = new Set(data.source.task_snapshot.filter((item) => item.status !== 'done').map((item) => item.task_id));
  const completedMismatch = completedTaskIds.filter((taskId) => !snapshotDoneIds.has(taskId));
  const remainingMismatch = remainingTaskIds.filter((taskId) => !snapshotRemainingIds.has(taskId));
  if (completedMismatch.length || completedTaskIds.some((taskId) => !taskSnapshotIds.includes(taskId))) {
    throw new ValidationError(`milestone review completed_task_evidence must match done tasks in task_snapshot: ${JSON.stringify(completedMismatch)}`);
  }
  if (remainingMismatch.length || remainingTaskIds.some((taskId) => !taskSnapshotIds.includes(taskId))) {
    throw new ValidationError(`milestone review remaining_task_ids must match non-done tasks in task_snapshot: ${JSON.stringify(remainingMismatch)}`);
  }

  for (const { item, runSnapshot } of completedTaskEvidence) {
    const taskId = runSnapshot.taskId;
    parsedTimestamp(runSnapshot.finishedAt, `${taskId}.run_snapshot.finishedAt`);
    const snapshotTask = data.source.task_snapshot.find((task) => task.task_id === taskId);
    if (snapshotTask.task_title !== runSnapshot.taskTitle) {
      throw new ValidationError(`${taskId}.run_snapshot.taskTitle must match task_snapshot`);
    }
    const runSnapshotSha256 = milestoneRunSnapshotSha256(runSnapshot);
    if (runSnapshotSha256 !== item.run_snapshot_sha256) {
      throw new ValidationError(`${taskId}.run_snapshot_sha256 mismatch: expected ${runSnapshotSha256}`);
    }
    const snapshotFields = {
      runId: item.run_id,
      taskId: item.task_id,
      taskTitle: item.task_title,
      finishedAt: item.run_finished_at,
    };
    for (const [field, expected] of Object.entries(snapshotFields)) {
      if (expected !== undefined && runSnapshot[field] !== expected) {
        throw new ValidationError(`${taskId}.run_snapshot ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(runSnapshot[field])}`);
      }
    }
    if (runSnapshot.status !== 'finished') {
      throw new ValidationError(`${taskId}.run_snapshot status must be "finished", got ${JSON.stringify(runSnapshot.status)}`);
    }
    if (item.workspace_ref !== undefined && runSnapshot.workspaceRef !== item.workspace_ref) {
      throw new ValidationError(`${taskId}.workspace_ref must exactly match run_snapshot.workspaceRef`);
    }
    if (item.changed_files !== undefined && !sameJson(runSnapshot.changedFiles, item.changed_files)) {
      throw new ValidationError(`${taskId}.changed_files must exactly match run_snapshot`);
    }
    const verification = normalizedRunVerification(runSnapshot);
    if (item.verification !== undefined && !sameJson(verification, item.verification)) {
      throw new ValidationError(`${taskId}.verification must exactly match run_snapshot`);
    }
    const hasExecutedPass = verification.some((entry) => entry.status === 'passed'
      && entry.exit_code === 0
      && ['config', 'command'].includes(entry.source));
    if (!hasExecutedPass) {
      throw new ValidationError(`${taskId}.run_snapshot verification must include an executed config/command check that passed with exit_code 0`);
    }
  }

  if (data.checkpoint === 'midpoint') {
    const threshold = Math.ceil(counts.total / 2);
    if (counts.done < threshold || counts.done >= counts.total) {
      throw new ValidationError(`midpoint milestone review requires ${threshold} <= done < ${counts.total}, got ${counts.done}`);
    }
  } else if (counts.done !== counts.total || remainingTaskIds.length !== 0) {
    throw new ValidationError('pre_close milestone review requires every iteration task to be done');
  }

  const findingIds = data.confirmed_findings.map((finding) => finding.finding_id);
  assertUniqueStrings(findingIds, 'milestone review finding ids');
  for (const finding of data.confirmed_findings) {
    assertUniqueStrings(finding.affected_completed_tasks, `${finding.finding_id}.affected_completed_tasks`);
    const nonCompleted = finding.affected_completed_tasks.filter((taskId) => !completedTaskIdSet.has(taskId));
    if (nonCompleted.length) {
      throw new ValidationError(`${finding.finding_id}.affected_completed_tasks must reference completed task evidence: ${JSON.stringify(nonCompleted)}`);
    }
  }
  for (const [index, item] of data.planned_todo_not_findings.entries()) {
    assertUniqueStrings(item.covered_by_remaining_tasks, `planned_todo_not_findings[${index}].covered_by_remaining_tasks`);
    const nonRemaining = item.covered_by_remaining_tasks.filter((taskId) => !remainingTaskIdSet.has(taskId));
    if (nonRemaining.length) {
      throw new ValidationError(`planned_todo_not_findings[${index}] must reference remaining tasks: ${JSON.stringify(nonRemaining)}`);
    }
  }
  return data;
}

function normalizedArtifactRef(reference, label) {
  if (typeof reference !== 'string' || !reference) throw new ValidationError(`${label} must be a non-empty artifact-root-relative path`);
  if (reference.includes('\\') || path.posix.isAbsolute(reference) || path.posix.normalize(reference) !== reference) {
    throw new ValidationError(`${label} must be a normalized artifact-root-relative path`);
  }
  if (reference === '..' || reference.startsWith('../') || reference.includes('/../')) {
    throw new ValidationError(`${label} must not traverse outside the artifact root`);
  }
  return reference;
}

function resolveMilestoneSourceFile(artifactRoot, reference, label) {
  const normalized = normalizedArtifactRef(reference, label);
  const resolved = path.resolve(artifactRoot, normalized);
  const relative = path.relative(artifactRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError(`${label} must resolve to a file inside the artifact root`);
  }
  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new ValidationError(`${label} does not resolve to a file: ${normalized}`);
  }
  const realArtifactRoot = realpathSync(artifactRoot);
  const realResolved = realpathSync(resolved);
  const realRelative = path.relative(realArtifactRoot, realResolved);
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ValidationError(`${label} resolves outside the artifact root through a symbolic link`);
  }
  return resolved;
}

function milestoneFilenameKind(filename, checkpoint) {
  if (filename === `${checkpoint}.json`) return 'canonical';
  if (filename === `${checkpoint}.draft.json`) return 'draft';
  const escapedCheckpoint = checkpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uniqueDraftPattern = new RegExp(`^${escapedCheckpoint}\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.draft\\.json$`);
  if (uniqueDraftPattern.test(filename)) return 'draft';
  throw new ValidationError(
    `milestone review checkpoint ${checkpoint} must use ${checkpoint}.json, ${checkpoint}.draft.json, or ${checkpoint}.<unique>.draft.json; got ${filename}`,
  );
}

function milestonePathContext(filePath, data, options) {
  const absolutePath = path.resolve(filePath);
  const milestoneDir = path.dirname(absolutePath);
  const iterationRoot = path.dirname(milestoneDir);
  const iterationsRoot = path.dirname(iterationRoot);
  const inferredArtifactRoot = path.dirname(iterationsRoot);
  const artifactRoot = path.resolve(options.artifactRoot ?? inferredArtifactRoot);
  const expectedMilestoneDir = path.join(artifactRoot, 'iterations', data.iteration_id, 'milestone-reviews');
  if (path.resolve(milestoneDir) !== path.resolve(expectedMilestoneDir)) {
    throw new ValidationError(`milestone review must be a direct file under iterations/${data.iteration_id}/milestone-reviews`);
  }
  if (options.expectedProjectId && data.project_id !== options.expectedProjectId) {
    throw new ValidationError(`milestone review project_id must be ${JSON.stringify(options.expectedProjectId)}`);
  }
  if (options.expectedIterationId && data.iteration_id !== options.expectedIterationId) {
    throw new ValidationError(`milestone review iteration_id must be ${JSON.stringify(options.expectedIterationId)}`);
  }
  return {
    artifactRoot,
    kind: milestoneFilenameKind(path.basename(absolutePath), data.checkpoint),
  };
}

function graphWithoutMutableTaskState(graph) {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const { status, blockReason, blockNote, ...stableTask } = task;
      return stableTask;
    }),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedRunVerification(run) {
  return run.verification.map((item) => ({
    type: item.type,
    command: item.command,
    status: item.status,
    exit_code: item.exitCode,
    source: item.source,
  }));
}

const MILESTONE_IMMUTABLE_RUN_FIELDS = [
  'schema_version',
  'runId',
  'projectId',
  'taskId',
  'taskTitle',
  'iterationId',
  'sourceLayout',
  'taskGraphRef',
  'sourceSpecRef',
  'agentTool',
  'workspaceRef',
  'workspacePath',
  'isolation',
  'status',
  'startedAt',
  'finishedAt',
];

function latestSuccessfulRunEntry(runIndex, taskId, data, generatedAt, graphPath, artifactRoot) {
  const candidates = runIndex.runs
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.taskId === taskId
      && entry.status === 'finished'
      && entry.iterationId === data.iteration_id
      && taskGraphRefMatchesGraph(entry.taskGraphRef, graphPath, artifactRoot)
      && parsedTimestamp(entry.finishedAt, `${entry.runId}.finishedAt`) <= generatedAt)
    .sort((left, right) => {
      const timeDifference = Date.parse(right.entry.finishedAt) - Date.parse(left.entry.finishedAt);
      return timeDifference || right.index - left.index;
    });
  for (const candidate of candidates) {
    const runPath = resolveMilestoneSourceFile(
      artifactRoot,
      artifactRunRef(candidate.entry.runRef),
      `${candidate.entry.runId}.runRef`,
    );
    const run = validateRun(runPath);
    if (run.sourceLayout === 'iteration') return { ...candidate, run, runPath };
  }
  return null;
}

function validateMilestoneRunEvidence(data, artifactRoot, kind, graphPath) {
  const runIndexPath = resolveMilestoneSourceFile(artifactRoot, 'runs/run-index.json', 'milestone review run-index');
  const runIndex = validateRunIndex(runIndexPath);
  if (runIndex.projectId !== data.project_id) {
    throw new ValidationError(`milestone review run-index projectId must match project_id ${JSON.stringify(data.project_id)}`);
  }
  const generatedAt = parsedTimestamp(data.generated_at, 'milestone review generated_at');

  for (const evidence of data.source.completed_task_evidence) {
    const runSnapshot = evidence.run_snapshot;
    const taskId = runSnapshot.taskId;
    const runId = runSnapshot.runId;
    const latest = latestSuccessfulRunEntry(runIndex, taskId, data, generatedAt, graphPath, artifactRoot);
    if (!latest) {
      throw new ValidationError(`${taskId} has no successful finished run in the milestone task-graph context at generated_at`);
    }
    if (latest.entry.runId !== runId) {
      throw new ValidationError(`${taskId}.run_snapshot.runId must reference latest successful finished run ${latest.entry.runId}`);
    }
    const expectedRunRef = artifactRunRef(latest.entry.runRef);
    const legacyEvidenceRef = `runs/${legacyRunRef(runId)}`;
    if (![expectedRunRef, legacyEvidenceRef].includes(evidence.run_ref)
      || (kind === 'draft' && evidence.run_ref !== expectedRunRef)) {
      throw new ValidationError(`${taskId}.run_ref must be ${expectedRunRef}`);
    }
    const runPath = latest.runPath;
    const run = latest.run;
    const expectedFields = {
      projectId: data.project_id,
      iterationId: data.iteration_id,
      sourceLayout: 'iteration',
      taskGraphRef: data.source.task_graph_ref,
      sourceSpecRef: data.source.task_graph_snapshot.sourceSpec,
      status: 'finished',
    };
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (runSnapshot[field] !== expected) {
        throw new ValidationError(`${taskId} run_snapshot ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(runSnapshot[field])}`);
      }
    }
    if (parsedTimestamp(runSnapshot.finishedAt, `${runSnapshot.runId}.finishedAt`) > generatedAt) {
      throw new ValidationError(`${taskId} run_snapshot.finishedAt must not be later than milestone generated_at`);
    }

    for (const field of MILESTONE_IMMUTABLE_RUN_FIELDS) {
      if (!sameJson(run[field], runSnapshot[field])) {
        throw new ValidationError(
          `${taskId} run ${field} must match run_snapshot immutable context: expected ${JSON.stringify(runSnapshot[field])}, got ${JSON.stringify(run[field])}`,
        );
      }
    }

    if (kind === 'draft') {
      if (rawFileSha256(runPath) !== evidence.run_sha256) {
        throw new ValidationError(`${taskId}.run_sha256 does not match ${evidence.run_ref}`);
      }
      if (!sameJson(run, runSnapshot)) {
        throw new ValidationError(`${taskId}.run_snapshot must exactly match ${evidence.run_ref} for draft validation`);
      }
    }
  }
}

function validateMilestoneSourceArtifacts(data, artifactRoot, kind) {
  const expectedGraphRef = `iterations/${data.iteration_id}/gate-c-task-graph/task-graph.json`;
  const expectedSpecRef = `iterations/${data.iteration_id}/gate-b-spec/spec.json`;
  if (normalizedArtifactRef(data.source.task_graph_ref, 'source.task_graph_ref') !== expectedGraphRef) {
    throw new ValidationError(`source.task_graph_ref must be ${expectedGraphRef}`);
  }
  if (normalizedArtifactRef(data.source.spec_ref, 'source.spec_ref') !== expectedSpecRef) {
    throw new ValidationError(`source.spec_ref must be ${expectedSpecRef}`);
  }
  const graphPath = resolveMilestoneSourceFile(artifactRoot, data.source.task_graph_ref, 'source.task_graph_ref');
  const specPath = resolveMilestoneSourceFile(artifactRoot, data.source.spec_ref, 'source.spec_ref');
  const graph = validateTaskGraphData(loadJson(graphPath));
  const spec = validateSpec(specPath);
  if (graph.projectId !== data.project_id || spec.project_id !== data.project_id) {
    throw new ValidationError('milestone review project_id must match task graph and spec project ids');
  }
  if (spec.approval !== 'approved' || spec.open_decisions.length) {
    throw new ValidationError('milestone review source spec must be approved with no open decisions');
  }
  const graphSpecPath = path.resolve(path.dirname(graphPath), graph.sourceSpec);
  if (graphSpecPath !== specPath) {
    throw new ValidationError('milestone review task graph sourceSpec must resolve to source.spec_ref');
  }

  const graphSnapshot = data.source.task_graph_snapshot;
  if (kind === 'draft') {
    if (rawFileSha256(graphPath) !== data.source.task_graph_sha256) {
      throw new ValidationError('source.task_graph_sha256 does not match the current task graph file');
    }
    if (!sameJson(graph, graphSnapshot)) {
      throw new ValidationError('source.task_graph_snapshot must exactly match the current task graph for draft validation');
    }
  } else if (!sameJson(graphWithoutMutableTaskState(graph), graphWithoutMutableTaskState(graphSnapshot))) {
    throw new ValidationError('canonical milestone task graph structure differs from its checkpoint snapshot beyond mutable task state');
  }

  validateMilestoneRunEvidence(data, artifactRoot, kind, graphPath);
}

export function validateMilestoneReview(filePath, options = {}) {
  const data = validateMilestoneReviewData(loadJson(filePath));
  const context = milestonePathContext(filePath, data, options);
  validateMilestoneSourceArtifacts(data, context.artifactRoot, context.kind);
  return data;
}

export function validateSkillProposalData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.skill_proposal));
  validateNonBlankStrings(data.targetFiles, `${data.proposalId}.targetFiles`);
  if (data.evidence) validateNonBlankStrings(data.evidence, `${data.proposalId}.evidence`);
  validateProposalTargetMetadata(data, data.proposalId, { requireUpstreamReason: true });
  return data;
}

function validateProposalTargetMetadata(data, label, options = {}) {
  const target = data.target ?? 'project';
  if (target === 'project') {
    for (const field of ['targetRepo', 'targetArea', 'upstreamReason']) {
      if (typeof data[field] === 'string' && data[field].trim().length > 0) {
        throw new ValidationError(`${label}.${field} requires target to be p2a_toolkit or companion_project`);
      }
    }
    return;
  }
  if (typeof data.targetRepo !== 'string' || data.targetRepo.trim().length === 0) {
    throw new ValidationError(`${label}.targetRepo is required when target is ${target}`);
  }
  if (options.requireUpstreamReason && (typeof data.upstreamReason !== 'string' || data.upstreamReason.trim().length === 0)) {
    throw new ValidationError(`${label}.upstreamReason is required when target is ${target}`);
  }
}

export function validateSkillProposal(filePath) {
  return validateSkillProposalData(loadJson(filePath));
}

export function validateProposalsDir(proposalsDir) {
  if (!existsSync(proposalsDir)) throw new ValidationError(`proposals directory is missing: ${proposalsDir}`);
  if (!lstatSync(proposalsDir).isDirectory()) throw new ValidationError(`proposals path must be a directory: ${proposalsDir}`);
  const proposalFiles = readdirSync(proposalsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  const proposals = proposalFiles.map((entry) => validateSkillProposal(path.join(proposalsDir, entry)));
  const proposalIds = proposals.map((proposal) => proposal.proposalId);
  if (proposalIds.length !== new Set(proposalIds).size) {
    throw new ValidationError('proposalId values must be unique within a proposals directory');
  }
  for (const [index, proposal] of proposals.entries()) {
    const expectedName = `${proposal.proposalId}.json`;
    if (proposalFiles[index] !== expectedName) {
      throw new ValidationError(`proposal filename must be ${expectedName}, got ${proposalFiles[index]}`);
    }
  }
  return proposals;
}

export function validateProposalReviewData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_review));
  if (data.summary.totalGroups !== data.groups.length) {
    throw new ValidationError('proposal review summary.totalGroups must match groups length');
  }
  const statusTotal = Object.values(data.summary.byStatus).reduce((sum, count) => sum + count, 0);
  if (statusTotal !== data.summary.totalProposals) {
    throw new ValidationError('proposal review summary.byStatus must sum to totalProposals');
  }
  const riskTotal = Object.values(data.summary.byRisk).reduce((sum, count) => sum + count, 0);
  if (riskTotal !== data.summary.totalProposals) {
    throw new ValidationError('proposal review summary.byRisk must sum to totalProposals');
  }
  const dispositionTotal = Object.values(data.summary.byRecommendedDisposition).reduce((sum, count) => sum + count, 0);
  if (dispositionTotal !== data.summary.totalGroups) {
    throw new ValidationError('proposal review summary.byRecommendedDisposition must sum to totalGroups');
  }
  const groupIds = data.groups.map((group) => group.groupId);
  if (groupIds.length !== new Set(groupIds).size) {
    throw new ValidationError('proposal review groupId values must be unique');
  }
  const proposalIds = [];
  for (const group of data.groups) {
    validateProposalTargetMetadata(group, group.groupId);
    validateNonBlankStrings(group.proposalIds, `${group.groupId}.proposalIds`);
    validateNonBlankStrings(group.targetFiles, `${group.groupId}.targetFiles`);
    validateNonBlankStrings(group.sourceRunIds, `${group.groupId}.sourceRunIds`);
    if (group.frequency !== group.proposalIds.length) {
      throw new ValidationError(`${group.groupId}.frequency must match proposalIds length`);
    }
    const groupStatusTotal = Object.values(group.statusSummary).reduce((sum, count) => sum + count, 0);
    if (groupStatusTotal !== group.proposalIds.length) {
      throw new ValidationError(`${group.groupId}.statusSummary must sum to proposalIds length`);
    }
    proposalIds.push(...group.proposalIds);
  }
  if (proposalIds.length !== new Set(proposalIds).size) {
    throw new ValidationError('proposal review proposalIds must appear in only one group');
  }
  return data;
}

export function validateProposalReview(filePath) {
  return validateProposalReviewData(loadJson(filePath));
}

export function validateProposalCurationData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_curation));
  if (data.summary.totalCandidates !== data.candidates.length) {
    throw new ValidationError('proposal curation summary.totalCandidates must match candidates length');
  }
  const readinessTotal = Object.values(data.summary.byReadiness).reduce((sum, count) => sum + count, 0);
  if (readinessTotal !== data.summary.totalCandidates) {
    throw new ValidationError('proposal curation summary.byReadiness must sum to totalCandidates');
  }
  const dispositionTotal = Object.values(data.summary.byRecommendedDisposition).reduce((sum, count) => sum + count, 0);
  if (dispositionTotal !== data.summary.totalCandidates) {
    throw new ValidationError('proposal curation summary.byRecommendedDisposition must sum to totalCandidates');
  }
  const candidateIds = data.candidates.map((candidate) => candidate.candidateId);
  if (candidateIds.length !== new Set(candidateIds).size) {
    throw new ValidationError('proposal curation candidateId values must be unique');
  }
  const groupIds = data.candidates.map((candidate) => candidate.groupId);
  if (groupIds.length !== new Set(groupIds).size) {
    throw new ValidationError('proposal curation groupId values must be unique');
  }
  for (const candidate of data.candidates) {
    validateProposalTargetMetadata(candidate, candidate.candidateId);
    validateNonBlankStrings(candidate.proposalIds, `${candidate.candidateId}.proposalIds`);
    validateNonBlankStrings(candidate.targetFiles, `${candidate.candidateId}.targetFiles`);
    validateNonBlankStrings(candidate.sourceRunIds, `${candidate.candidateId}.sourceRunIds`);
    if (candidate.frequency !== candidate.proposalIds.length) {
      throw new ValidationError(`${candidate.candidateId}.frequency must match proposalIds length`);
    }
    if (candidate.recommendedDisposition === 'approve' && candidate.readiness !== 'patch_candidate') {
      throw new ValidationError(`${candidate.candidateId}.readiness must be patch_candidate when recommendedDisposition is approve`);
    }
  }
  return data;
}

export function validateProposalCuration(filePath) {
  return validateProposalCurationData(loadJson(filePath));
}

export function validateProposalPatchDraftData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_patch_draft));
  validateProposalTargetMetadata(data, data.draftId);
  if (data.approvalRequired !== true) {
    throw new ValidationError('proposal patch draft approvalRequired must be true');
  }
  if (data.autoApplyAllowed !== false) {
    throw new ValidationError('proposal patch draft autoApplyAllowed must be false');
  }
  validateNonBlankStrings(data.targetFiles, `${data.draftId}.targetFiles`);
  validateNonBlankStrings(data.risks, `${data.draftId}.risks`);
  const intendedFiles = data.intendedChanges.map((change) => change.file);
  validateNonBlankStrings(intendedFiles, `${data.draftId}.intendedChanges.file`);
  const targetFileSet = new Set(data.targetFiles);
  const unknownFiles = intendedFiles.filter((file) => !targetFileSet.has(file));
  if (unknownFiles.length) {
    throw new ValidationError(`proposal patch draft intendedChanges reference files not in targetFiles: ${JSON.stringify([...new Set(unknownFiles)])}`);
  }
  for (const [index, item] of data.verificationPlan.entries()) {
    if (item.required && typeof item.command === 'string' && item.command.trim().length === 0) {
      throw new ValidationError(`${data.draftId}.verificationPlan[${index}].command must not be blank when present`);
    }
  }
  return data;
}

export function validateProposalPatchDraft(filePath) {
  return validateProposalPatchDraftData(loadJson(filePath));
}

export function validateProposalDraftApprovalData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_draft_approval));
  if (data.autoApplyPerformed !== false) {
    throw new ValidationError('proposal draft approval autoApplyPerformed must be false');
  }
  const target = data.target ?? 'project';
  validateProposalTargetMetadata(data, data.approvalId);
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-draft-approval:${data.approvalId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference approvalId');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-patch-draft:${data.draftId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference draftId');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-target:${target}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference target');
  }
  if (data.targetRepo && !data.maintenanceTask.sourceSpecRefs.includes(`proposal-target-repo:${data.targetRepo}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference targetRepo');
  }
  if (data.targetArea && !data.maintenanceTask.sourceSpecRefs.includes(`proposal-target-area:${data.targetArea}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference targetArea');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-candidate:${data.candidateId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference candidateId');
  }
  validateNonBlankStrings(data.maintenanceTask.sourceSpecRefs, `${data.approvalId}.maintenanceTask.sourceSpecRefs`);
  return data;
}

export function validateProposalDraftApproval(filePath) {
  return validateProposalDraftApprovalData(loadJson(filePath));
}

export function validateEvalIndexData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_index));
  return data;
}

export function validateEvalIndex(filePath) {
  return validateEvalIndexData(loadJson(filePath));
}

export function validateEvalDigestData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_digest));
  return data;
}

export function validateEvalDigest(filePath) {
  return validateEvalDigestData(loadJson(filePath));
}

export function validateEvalMaintenanceDraftData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_maintenance_draft));
  return data;
}

export function validateEvalMaintenanceDraft(filePath) {
  return validateEvalMaintenanceDraftData(loadJson(filePath));
}

export function validateEvalMaintenanceApplyReportData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_maintenance_apply_report));
  return data;
}

export function validateEvalMaintenanceApplyReport(filePath) {
  return validateEvalMaintenanceApplyReportData(loadJson(filePath));
}

export function validateRunsDir(runsDir) {
  if (!existsSync(runsDir)) throw new ValidationError(`runs directory is missing: ${runsDir}`);
  if (!lstatSync(runsDir).isDirectory()) throw new ValidationError(`runs path must be a directory: ${runsDir}`);
  const indexPath = path.join(runsDir, 'run-index.json');
  assertFile(indexPath, 'run-index.json');
  const index = validateRunIndex(indexPath);
  for (const run of index.runs) {
    const normalizedRunRef = normalizeIndexedRunRef(run.runRef, run.runId);
    const runPath = path.join(runsDir, normalizedRunRef);
    assertFile(runPath, run.runRef);
    const runData = validateRun(runPath);
    for (const field of ['runId', 'taskId', 'iterationId', 'status', 'agentTool', 'workspaceRef', 'taskGraphRef', 'startedAt', 'finishedAt']) {
      if (JSON.stringify(run[field]) !== JSON.stringify(runData[field])) {
        throw new ValidationError(`run-index ${run.runId}.${field} does not match run file`);
      }
    }
    if (runData.projectId !== index.projectId) {
      throw new ValidationError(`run ${run.runId} projectId does not match run-index projectId`);
    }
  }
  const indexedRunFiles = new Set(index.runs.map((run) => normalizeIndexedRunRef(run.runRef, run.runId)));
  const candidateRunFiles = [];
  const unsupportedEntries = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      candidateRunFiles.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const child of readdirSync(path.join(runsDir, entry.name), { withFileTypes: true })) {
      const childRef = `${entry.name}/${child.name}`;
      if (child.isFile()) candidateRunFiles.push(childRef);
      else unsupportedEntries.push(childRef);
    }
  }
  if (unsupportedEntries.length) {
    throw new ValidationError(`runs directory contains unsupported nested entry(s): ${unsupportedEntries.join(', ')}`);
  }
  const extraRunFiles = candidateRunFiles
    .filter((entry) => {
      if (!entry.endsWith('.json') || entry === 'run-index.json' || indexedRunFiles.has(entry)) return false;
      if (!RUN_SIDECAR_SUFFIXES.some((suffix) => entry.endsWith(suffix))) return true;
      return isRunRecordFile(path.join(runsDir, entry));
    });
  if (extraRunFiles.length) {
    throw new ValidationError(`runs directory contains unindexed run file(s): ${extraRunFiles.join(', ')}`);
  }
  return index;
}

function validateReviewPassData(data) {
  if (data.blocking_issues.length !== 0) {
    throw new ValidationError(`review cannot pass Gate D while blocking_issues is non-empty: ${JSON.stringify(data.blocking_issues)}`);
  }
}

export function validateStatusDoc(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const required = [
    ['Progress line', /Progress:/i],
    ['Gate A section', /Gate A/i],
    ['Gate B section', /Gate B/i],
    ['Gate C section', /Gate C/i],
    ['Gate D section', /Gate D/i],
    ['section 1 heading', /^##\s+1\./m],
    ['section 2 heading', /^##\s+2\./m],
    ['section 3 heading', /^##\s+3\./m],
    ['section 4 heading', /^##\s+4\./m],
    ['section 5 heading', /^##\s+5\./m],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(text)) throw new ValidationError(`status.md missing ${label}`);
  }
  return text;
}

function artifactPaths(artifactRoot) {
  const root = path.resolve(artifactRoot);
  return Object.fromEntries(
    Object.entries(GATE_PATHS).map(([key, relativePath]) => [key, path.join(root, relativePath)]),
  );
}

function filesExist(paths, keys) {
  return keys.map((key) => paths[key]).filter((filePath) => existsSync(filePath));
}

function requireGateFiles(paths, keys, gateLabel) {
  const missing = keys.filter((key) => !existsSync(paths[key]));
  if (missing.length) {
    throw new ValidationError(`${gateLabel} is incomplete; missing ${missing.map((key) => GATE_PATHS[key]).join(', ')}`);
  }
  for (const key of keys) assertFile(paths[key], GATE_PATHS[key]);
}

function normalizeReference(reference) {
  return String(reference).replace(/\\/g, '/').replace(/^\.\//, '');
}

function artifactRelativeRef(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

function artifactReferenceMatches(reference, artifactRoot, filePath) {
  if (path.isAbsolute(reference) && path.resolve(reference) === path.resolve(filePath)) return true;
  const normalized = normalizeReference(reference);
  const expectedRelative = artifactRelativeRef(artifactRoot, filePath);
  const reviewRelative = normalizePath(path.relative(path.join(artifactRoot, 'gate-d-review'), filePath));
  const projectRelative = `${path.basename(artifactRoot)}/${expectedRelative}`;
  const p2aArtifactsRelative = `.plan2agent/artifacts/${projectRelative}`;
  return normalized === expectedRelative
    || normalized === reviewRelative
    || normalized === projectRelative
    || normalized === p2aArtifactsRelative;
}

function validateReviewReferencesForRoot(review, artifactRoot, paths) {
  const checks = [
    ['sourceSpec', paths.specJson],
    ['sourceTaskGraph', paths.taskGraph],
  ];
  for (const [field, expectedPath] of checks) {
    if (!artifactReferenceMatches(review[field], artifactRoot, expectedPath)) {
      throw new ValidationError(
        `review.json ${field} must reference ${artifactRelativeRef(artifactRoot, expectedPath)}, got ${JSON.stringify(review[field])}`,
      );
    }
  }
}

function assertProjectId(label, actual, expected) {
  if (expected && actual !== expected) {
    throw new ValidationError(`${label} must match project id ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function validateArtifactRoot(artifactRoot, options = {}) {
  const root = path.resolve(artifactRoot);
  if (!existsSync(root)) throw new ValidationError(`artifact root is missing: ${root}`);
  if (!lstatSync(root).isDirectory()) throw new ValidationError(`artifact root must be a directory: ${root}`);

  const paths = artifactPaths(root);

  requireGateFiles(paths, ['intakeJson'], 'Gate A');
  const intake = validateIntake(paths.intakeJson, { artifactRoot: root });
  const result = {
    artifactRoot: root,
    paths,
    gates: {
      a: { present: true, valid: true, passed: intake.status === 'ready_for_spec' },
      b: { present: false, valid: false, passed: false },
      c: { present: false, valid: false, passed: false },
      d: { present: false, valid: false, passed: false },
    },
    intake,
    spec: null,
    taskGraph: null,
    review: null,
    readyForHandoff: false,
  };

  const gateBKeys = ['specJson'];
  const gateBExisting = filesExist(paths, gateBKeys);
  if (gateBExisting.length) {
    requireGateFiles(paths, gateBKeys, 'Gate B');
    const spec = validateSpec(paths.specJson, paths.intakeJson, { artifactRoot: root });
    assertProjectId('spec.project_id', spec.project_id, options.projectId);
    result.spec = spec;
    result.gates.b = { present: true, valid: true, passed: spec.approval === 'approved' && spec.open_decisions.length === 0 };
  }

  const gateCKeys = ['taskGraph'];
  const gateCExisting = filesExist(paths, gateCKeys);
  if (gateCExisting.length) {
    if (!result.spec) throw new ValidationError('Gate C cannot be validated before Gate B spec exists');
    requireGateFiles(paths, gateCKeys, 'Gate C');
    const taskGraph = validateTaskGraph(paths.taskGraph, paths.specJson);
    assertProjectId('taskGraph.projectId', taskGraph.projectId, options.projectId);
    result.taskGraph = taskGraph;
    result.gates.c = { present: true, valid: true, passed: true };
  }

  const gateDKeys = ['reviewJson'];
  const gateDExisting = filesExist(paths, gateDKeys);
  if (gateDExisting.length) {
    if (!result.taskGraph) throw new ValidationError('Gate D cannot be validated before Gate C task graph exists');
    requireGateFiles(paths, gateDKeys, 'Gate D');
    const review = options.requireReviewPass || options.requireHandoffReady
      ? validateReviewPass(paths.reviewJson)
      : validateReview(paths.reviewJson);
    assertProjectId('review.projectId', review.projectId, options.projectId);
    validateReviewReferencesForRoot(review, root, paths);
    result.review = review;
    result.gates.d = { present: true, valid: true, passed: review.blocking_issues.length === 0 };
  }

  result.readyForHandoff = (
    result.gates.a.passed
    && result.gates.b.passed
    && result.gates.c.passed
    && result.gates.d.passed
  );
  if (options.requireHandoffReady && !result.readyForHandoff) {
    const missing = [];
    if (!result.gates.b.present) missing.push('Gate B');
    if (!result.gates.c.present) missing.push('Gate C');
    if (!result.gates.d.present) missing.push('Gate D');
    const reasons = [];
    if (missing.length) reasons.push(`missing ${missing.join(', ')}`);
    if (!result.gates.a.passed) reasons.push('Gate A intake is not approved');
    if (result.spec && !result.gates.b.passed) reasons.push('spec is not approved or open_decisions is non-empty');
    if (result.review && !result.gates.d.passed) reasons.push('review blocking_issues is non-empty');
    throw new ValidationError(`artifact root is not handoff-ready: ${reasons.join('; ') || 'unknown gate state'}`);
  }
  return result;
}

export function validateHandoffReadyArtifactRoot(artifactRoot, options = {}) {
  return validateArtifactRoot(artifactRoot, { ...options, requireHandoffReady: true, requireReviewPass: true });
}

export function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node, stack) {
    if (visiting.has(node)) {
      const cycle = [...stack, node].join(' -> ');
      throw new ValidationError(`task graph contains a dependency cycle: ${cycle}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node)) {
      visit(dependency, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    visit(node, []);
  }
}

function optionalFixtureIntakeMd(fixturePath) {
  const candidate = path.join(fixturePath, 'intake.md');
  return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
}

export function validateFixtureDir(fixturePath) {
  const required = [
    ['intake.blocked.json', (artifactPath) => validateIntake(artifactPath)],
    ['intake.answered.json', (artifactPath) => validateIntake(artifactPath, { intakeMdPath: optionalFixtureIntakeMd(fixturePath) })],
    ['spec.approved.json', (artifactPath) => validateSpec(artifactPath, path.join(fixturePath, 'intake.answered.json'))],
    ['task-graph.json', (artifactPath) => validateTaskGraph(artifactPath, path.join(fixturePath, 'spec.approved.json'))],
    ['review.json', (artifactPath) => validateReviewPass(artifactPath, { sourceSpec: 'spec.approved.json', sourceTaskGraph: 'task-graph.json' })],
  ];
  for (const [filename, validator] of required) {
    const artifactPath = path.join(fixturePath, filename);
    try {
      readFileSync(artifactPath);
    } catch {
      throw new ValidationError(`fixture ${fixturePath} is missing ${filename}`);
    }
    validator(artifactPath);
  }
  const reportPath = path.join(fixturePath, 'review-report.md');
  if (existsSync(reportPath)) assertFile(reportPath, 'review-report.md');
}

function usage() {
  return [
    'Usage:',
    '  p2a validate [artifact options]',
    '',
    'Options:',
    '  --artifact-root <dir>               Validate a Gate A-D artifact root.',
    '  --project-id <id>                   Expected project id for --artifact-root.',
    '  --intake <path> [--intake-md <path>]',
    '  --status <path>',
    '  --spec <path>',
    '  --task-graph <path> [--require-approved-spec <path>]',
    '  --review <path> [--require-review-pass]',
    '  --run <path> | --run-index <path> | --runs-dir <dir>',
    '  --milestone-review <path>',
    '  --skill-proposal <path>',
    '  --proposal-review <path>',
    '  --proposal-curation <path>',
    '  --proposal-patch-draft <path>',
    '  --proposal-draft-approval <path>',
    '  --eval-index <path>',
    '  --eval-digest <path>',
    '  --eval-maintenance-draft <path>',
    '  --eval-maintenance-apply-report <path>',
    '  --proposals-dir <dir>',
    '  --fixture-dir <dir>                 Validate a fixture directory. Repeatable.',
    '  --require-handoff-ready',
    '  --help, -h                          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { fixtureDir: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--intake') args.intake = argv[++index];
    else if (arg === '--intake-md') args.intakeMd = argv[++index];
    else if (arg === '--status') args.status = argv[++index];
    else if (arg === '--artifact-root') args.artifactRoot = argv[++index];
    else if (arg === '--project-id') args.projectId = argv[++index];
    else if (arg === '--spec') args.spec = argv[++index];
    else if (arg === '--task-graph') args.taskGraph = argv[++index];
    else if (arg === '--review') args.review = argv[++index];
    else if (arg === '--run') args.run = argv[++index];
    else if (arg === '--run-index') args.runIndex = argv[++index];
    else if (arg === '--runs-dir') args.runsDir = argv[++index];
    else if (arg === '--milestone-review') args.milestoneReview = argv[++index];
    else if (arg === '--skill-proposal') args.skillProposal = argv[++index];
    else if (arg === '--proposal-review') args.proposalReview = argv[++index];
    else if (arg === '--proposal-curation') args.proposalCuration = argv[++index];
    else if (arg === '--proposal-patch-draft') args.proposalPatchDraft = argv[++index];
    else if (arg === '--proposal-draft-approval') args.proposalDraftApproval = argv[++index];
    else if (arg === '--eval-index') args.evalIndex = argv[++index];
    else if (arg === '--eval-digest') args.evalDigest = argv[++index];
    else if (arg === '--eval-maintenance-draft') args.evalMaintenanceDraft = argv[++index];
    else if (arg === '--eval-maintenance-apply-report') args.evalMaintenanceApplyReport = argv[++index];
    else if (arg === '--proposals-dir') args.proposalsDir = argv[++index];
    else if (arg === '--require-approved-spec') args.requireApprovedSpec = argv[++index];
    else if (arg === '--require-handoff-ready') args.requireHandoffReady = true;
    else if (arg === '--require-review-pass') args.requireReviewPass = true;
    else if (arg === '--fixture-dir') args.fixtureDir.push(argv[++index]);
    else throw new ValidationError(`unrecognized argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.status) validateStatusDoc(args.status);
    if (args.artifactRoot) {
      validateArtifactRoot(args.artifactRoot, {
        projectId: args.projectId,
        requireHandoffReady: args.requireHandoffReady,
        requireReviewPass: args.requireReviewPass,
      });
    } else if (args.requireHandoffReady) {
      throw new ValidationError('--require-handoff-ready requires --artifact-root');
    }
    const specSourceIntakePath = args.spec && !args.intake
      ? requireSpecSourceIntake(args.spec)
      : null;
    const provenanceIntakePath = args.intake ?? specSourceIntakePath;
    const provenanceRoot = args.artifactRoot
      ?? (provenanceIntakePath
        ? inferArtifactRootFromIntakePath(provenanceIntakePath)
        : null);
    if (args.intake) {
      validateIntake(args.intake, {
        intakeMdPath: args.intakeMd ?? undefined,
        artifactRoot: provenanceRoot,
        requireBaselineContextArtifactRoot: true,
      });
    }
    else if (args.intakeMd) throw new ValidationError('--intake-md requires --intake');
    if (args.spec) {
      validateSpec(
        args.spec,
        args.intake ?? specSourceIntakePath,
        {
          artifactRoot: provenanceRoot,
          requireBaselineContextArtifactRoot: true,
        },
      );
    }
    if (args.taskGraph) validateTaskGraph(args.taskGraph, args.requireApprovedSpec ?? null);
    if (args.requireReviewPass && !args.review && !args.fixtureDir.length && !args.artifactRoot) {
      throw new ValidationError('--require-review-pass requires --review');
    }
    if (args.review) validateReview(args.review, null, { requirePass: args.requireReviewPass });
    if (args.run) validateRun(args.run);
    if (args.runIndex) validateRunIndex(args.runIndex);
    if (args.runsDir) validateRunsDir(args.runsDir);
    if (args.milestoneReview) validateMilestoneReview(args.milestoneReview);
    if (args.skillProposal) validateSkillProposal(args.skillProposal);
    if (args.proposalReview) validateProposalReview(args.proposalReview);
    if (args.proposalCuration) validateProposalCuration(args.proposalCuration);
    if (args.proposalPatchDraft) validateProposalPatchDraft(args.proposalPatchDraft);
    if (args.proposalDraftApproval) validateProposalDraftApproval(args.proposalDraftApproval);
    if (args.evalIndex) validateEvalIndex(args.evalIndex);
    if (args.evalDigest) validateEvalDigest(args.evalDigest);
    if (args.evalMaintenanceDraft) validateEvalMaintenanceDraft(args.evalMaintenanceDraft);
    if (args.evalMaintenanceApplyReport) validateEvalMaintenanceApplyReport(args.evalMaintenanceApplyReport);
    if (args.proposalsDir) validateProposalsDir(args.proposalsDir);
    for (const fixtureDir of args.fixtureDir) validateFixtureDir(fixtureDir);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ValidationError || error.code) {
      console.error(`validation failed: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log('Plan2Agent artifact validation passed');
  return 0;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
