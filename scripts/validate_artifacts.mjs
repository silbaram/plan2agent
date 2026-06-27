#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { P2A_DIR, resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const SCHEMA_PATHS = {
  intake: path.join(P2A_PATHS.schemasDir, 'intake.schema.json'),
  spec: path.join(P2A_PATHS.schemasDir, 'spec.schema.json'),
  task_graph: path.join(P2A_PATHS.schemasDir, 'task-graph.schema.json'),
  task_context: path.join(P2A_PATHS.schemasDir, 'task-context.schema.json'),
  review: path.join(P2A_PATHS.schemasDir, 'review.schema.json'),
  run: path.join(P2A_PATHS.schemasDir, 'run.schema.json'),
  run_index: path.join(P2A_PATHS.schemasDir, 'run-index.schema.json'),
  orchestration_plan: path.join(P2A_PATHS.schemasDir, 'orchestration-plan.schema.json'),
  orchestration_runtime: path.join(P2A_PATHS.schemasDir, 'orchestration-runtime.schema.json'),
  skill_proposal: path.join(P2A_PATHS.schemasDir, 'skill-proposal.schema.json'),
  proposal_review: path.join(P2A_PATHS.schemasDir, 'proposal-review.schema.json'),
  proposal_curation: path.join(P2A_PATHS.schemasDir, 'proposal-curation.schema.json'),
  proposal_patch_draft: path.join(P2A_PATHS.schemasDir, 'proposal-patch-draft.schema.json'),
  proposal_draft_approval: path.join(P2A_PATHS.schemasDir, 'proposal-draft-approval.schema.json'),
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
const ROLE_PROFILE_TO_ROLE = {
  owner_supervisor: 'lead',
  frontend_implementer: 'contributor',
  backend_implementer: 'contributor',
  fullstack_implementer: 'contributor',
  test_implementer: 'contributor',
  docs_implementer: 'contributor',
  qa_reviewer: 'reviewer',
  architecture_reviewer: 'reviewer',
  security_reviewer: 'reviewer',
  manual_monitor: 'monitor',
};
const ROLE_PROFILE_SOURCES = new Set(['auto', 'override']);

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
      constraints: [
        'Open Codex manually in the foreground workspace.',
      ],
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
      constraints: [
        'Open Claude Code manually in the foreground workspace.',
      ],
    };
  }
  if (agentTool === 'gemini') {
    return {
      surface: 'Gemini CLI foreground session',
      recommendedFeature: 'extensions_custom_commands_gemini_context',
      fallbackMode: 'read-only supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        'Use Gemini only for read-only planning, review, or monitor support.',
      ],
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

function cloneJsonData(data) {
  return JSON.parse(JSON.stringify(data));
}

function roleWithExecutionGuide(role) {
  if (role.executionGuide) return role;
  return {
    ...role,
    executionGuide: expectedExecutionGuide(role.agentTool, role.role, role.profile),
  };
}

export function normalizeOrchestrationPlanData(data) {
  const normalized = cloneJsonData(data);
  if (Array.isArray(normalized?.roles)) {
    normalized.roles = normalized.roles.map(roleWithExecutionGuide);
  }
  return normalized;
}

export function normalizeOrchestrationRuntimeData(data) {
  const normalized = cloneJsonData(data);
  const roleAssignments = normalized?.sharedMentalModel?.roleAssignments;
  if (Array.isArray(roleAssignments)) {
    normalized.sharedMentalModel.roleAssignments = roleAssignments.map(roleWithExecutionGuide);
  }
  return normalized;
}

function validateExecutionGuide(guide, label) {
  if (guide.supervisionRequired !== true) {
    throw new ValidationError(`${label} executionGuide.supervisionRequired must be true`);
  }
  if (guide.startsProcess !== false) {
    throw new ValidationError(`${label} executionGuide.startsProcess must be false`);
  }
  if (!Array.isArray(guide.constraints) || guide.constraints.length === 0) {
    throw new ValidationError(`${label} executionGuide.constraints must not be empty`);
  }
}

function validateExecutionGuideForRole(role, label) {
  validateExecutionGuide(role.executionGuide, label);
  const expected = expectedExecutionGuide(role.agentTool, role.role, role.profile);
  for (const field of ['surface', 'recommendedFeature', 'fallbackMode']) {
    if (role.executionGuide[field] !== expected[field]) {
      throw new ValidationError(`${label} executionGuide.${field} must match ${role.agentTool}/${role.role}`);
    }
  }
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

function resolveSpecSourceIntake(specPath, specReference = loadJson(specPath)) {
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

export function validateIntake(filePath, options = {}) {
  const data = validateAgainstSchema(filePath, 'intake');
  validateEvidence(data.evidence, 'intake');

  const unresolvedDecisions = [];
  for (const decision of data.needs_user_decision) {
    if (decision.status === 'open' || decision.status === 'deferred') {
      unresolvedDecisions.push(decision.id);
    }
    if (decision.status === 'answered' && !decision.answer) {
      throw new ValidationError(`${decision.id} is answered but has no answer`);
    }
    if ((decision.status === 'open' || decision.status === 'deferred') && decision.answer) {
      throw new ValidationError(`${decision.id} is unresolved but has an answer`);
    }
  }

  const expectedStatus = unresolvedDecisions.length ? 'blocked_on_user' : 'ready_for_spec';
  if (data.status !== expectedStatus) {
    throw new ValidationError(
      `intake.status must be ${JSON.stringify(expectedStatus)} when unresolved decisions are ${JSON.stringify(unresolvedDecisions)}`,
    );
  }
  const intakeMdPath = options.intakeMdPath ?? siblingIntakeMarkdownPath(filePath);
  if (intakeMdPath) validateIntakeMarkdownDecisionSync(data, intakeMdPath);
  return data;
}

function siblingIntakeMarkdownPath(intakePath) {
  const candidate = path.join(path.dirname(intakePath), 'intake.md');
  return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
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

export function validateSpec(filePath, intakePath = null) {
  const data = validateAgainstSchema(filePath, 'spec');
  const intake = intakePath ? validateIntake(intakePath) : null;
  validateEvidence(data.evidence, 'spec');
  validateTechnologyReconnaissanceEvidence(data);
  validateClarifyingQuestionDisposition(data, intake);
  if (data.approval === 'approved' && data.open_decisions.length) {
    throw new ValidationError('approved specs must not contain open_decisions');
  }

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
  if (data.status === 'started' && data.finishedAt !== null) {
    throw new ValidationError('started run must have finishedAt null');
  }
  if (data.status !== 'started' && data.finishedAt === null) {
    throw new ValidationError(`${data.status} run must include finishedAt`);
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

export function validateOrchestrationPlanData(data) {
  data = normalizeOrchestrationPlanData(data);
  validateSchema(data, loadJson(SCHEMA_PATHS.orchestration_plan));
  const roleIds = data.roles.map((role) => role.roleId);
  if (roleIds.length !== new Set(roleIds).size) {
    throw new ValidationError('orchestration plan roleId values must be unique');
  }
  const providerCapabilities = new Map(data.providerCapabilities.map((capability) => [capability.provider, capability]));
  if (providerCapabilities.size !== data.providerCapabilities.length) {
    throw new ValidationError('orchestration plan providerCapabilities[].provider values must be unique');
  }
  for (const provider of ['codex', 'claude', 'gemini', 'manual']) {
    if (!providerCapabilities.has(provider)) {
      throw new ValidationError(`orchestration plan providerCapabilities is missing ${provider}`);
    }
  }
  const roleIdSet = new Set(roleIds);
  const unknownPromptRoles = data.handoffPrompts
    .map((prompt) => prompt.roleId)
    .filter((roleId) => !roleIdSet.has(roleId));
  if (unknownPromptRoles.length) {
    throw new ValidationError(`orchestration plan handoffPrompts reference unknown roleId values: ${JSON.stringify([...new Set(unknownPromptRoles)])}`);
  }
  for (const role of data.roles) {
    const capability = providerCapabilities.get(role.agentTool);
    if (!capability) throw new ValidationError(`orchestration plan role ${role.roleId} uses provider without capability entry: ${role.agentTool}`);
    if (!capability.roles.includes(role.role)) {
      throw new ValidationError(`orchestration plan role ${role.roleId} assigns ${role.role} to unsupported provider ${role.agentTool}`);
    }
    if (ROLE_PROFILE_TO_ROLE[role.profile] !== role.role) {
      throw new ValidationError(`orchestration plan role ${role.roleId} profile ${role.profile} does not match role ${role.role}`);
    }
    if (!ROLE_PROFILE_SOURCES.has(role.profileSource)) {
      throw new ValidationError(`orchestration plan role ${role.roleId} uses unsupported profileSource ${role.profileSource}`);
    }
    if (role.profileSource === 'override' && !['implementer', 'reviewer'].includes(role.roleId)) {
      throw new ValidationError(`orchestration plan role ${role.roleId} cannot use override profileSource`);
    }
    validateExecutionGuideForRole(role, `orchestration plan role ${role.roleId}`);
    if (role.requiresWrite && !capability.writeAllowed) {
      throw new ValidationError(`orchestration plan role ${role.roleId} requires write but provider ${role.agentTool} is read-only`);
    }
  }
  const implementer = data.roles.find((role) => role.roleId === 'implementer');
  const reviewer = data.roles.find((role) => role.roleId === 'reviewer');
  if (implementer && data.providerStrategy.implementationProvider !== implementer.agentTool) {
    throw new ValidationError('orchestration plan providerStrategy.implementationProvider must match implementer agentTool');
  }
  if ((reviewer?.agentTool ?? null) !== data.providerStrategy.reviewProvider) {
    throw new ValidationError('orchestration plan providerStrategy.reviewProvider must match reviewer agentTool');
  }
  if (data.providerStrategy.mixedProviderImplementation !== false) {
    throw new ValidationError('orchestration plan mixedProviderImplementation must remain false');
  }
  if (data.providerStrategy.mode === 'single_provider' && data.providerStrategy.reviewProvider && ![data.providerStrategy.primaryProvider, 'manual'].includes(data.providerStrategy.reviewProvider)) {
    throw new ValidationError('orchestration plan single_provider mode cannot use a different reviewProvider');
  }
  if (data.providerStrategy.mode === 'single_provider_with_read_only_reviewer') {
    const reviewerCapability = data.providerStrategy.reviewProvider ? providerCapabilities.get(data.providerStrategy.reviewProvider) : null;
    if (!reviewerCapability || reviewerCapability.writeAllowed || data.providerStrategy.reviewProvider === data.providerStrategy.primaryProvider) {
      throw new ValidationError('orchestration plan single_provider_with_read_only_reviewer requires a different read-only reviewProvider');
    }
  }
  if (data.monitorGate.required) {
    if (!data.monitorGate.verdictPath) {
      throw new ValidationError('orchestration plan monitorGate.verdictPath is required when monitorGate.required is true');
    }
    if (!data.monitorGate.acceptedVerdicts.length) {
      throw new ValidationError('orchestration plan monitorGate.acceptedVerdicts must not be empty when monitorGate.required is true');
    }
    const hasMonitor = data.roles.some((role) => role.role === 'monitor');
    if (!hasMonitor) throw new ValidationError('orchestration plan requires a monitor role when monitorGate.required is true');
  }
  return data;
}

export function validateOrchestrationPlan(filePath) {
  return validateOrchestrationPlanData(loadJson(filePath));
}

export function validateOrchestrationRuntimeData(data) {
  data = normalizeOrchestrationRuntimeData(data);
  validateSchema(data, loadJson(SCHEMA_PATHS.orchestration_runtime));
  const roleAssignments = data.sharedMentalModel.roleAssignments;
  const roleIds = roleAssignments.map((role) => role.roleId);
  if (roleIds.length !== new Set(roleIds).size) {
    throw new ValidationError('orchestration runtime roleAssignments[].roleId values must be unique');
  }
  const roleIdSet = new Set(roleIds);
  for (const role of roleAssignments) {
    if (ROLE_PROFILE_TO_ROLE[role.profile] !== role.role) {
      throw new ValidationError(`orchestration runtime role ${role.roleId} profile ${role.profile} does not match role ${role.role}`);
    }
    if (!ROLE_PROFILE_SOURCES.has(role.profileSource)) {
      throw new ValidationError(`orchestration runtime role ${role.roleId} uses unsupported profileSource ${role.profileSource}`);
    }
    if (role.profileSource === 'override' && !['implementer', 'reviewer'].includes(role.roleId)) {
      throw new ValidationError(`orchestration runtime role ${role.roleId} cannot use override profileSource`);
    }
    validateExecutionGuideForRole(role, `orchestration runtime role ${role.roleId}`);
  }
  const eventIds = data.communicationLog.map((event) => event.eventId);
  if (eventIds.length !== new Set(eventIds).size) {
    throw new ValidationError('orchestration runtime communicationLog[].eventId values must be unique');
  }
  for (const event of data.communicationLog) {
    if (!roleIdSet.has(event.roleId)) {
      throw new ValidationError(`orchestration runtime event ${event.eventId} references unknown roleId: ${event.roleId}`);
    }
    if (event.linkedRoleId !== null && !roleIdSet.has(event.linkedRoleId)) {
      throw new ValidationError(`orchestration runtime event ${event.eventId} references unknown linkedRoleId: ${event.linkedRoleId}`);
    }
  }
  for (const decision of data.sharedMentalModel.decisions) {
    if (!roleIdSet.has(decision.roleId)) {
      throw new ValidationError(`orchestration runtime decision ${decision.decisionId} references unknown roleId: ${decision.roleId}`);
    }
  }
  for (const question of data.sharedMentalModel.openQuestions) {
    if (!roleIdSet.has(question.askedByRoleId)) {
      throw new ValidationError(`orchestration runtime question ${question.questionId} references unknown askedByRoleId: ${question.askedByRoleId}`);
    }
    if (question.targetRoleId !== null && !roleIdSet.has(question.targetRoleId)) {
      throw new ValidationError(`orchestration runtime question ${question.questionId} references unknown targetRoleId: ${question.targetRoleId}`);
    }
  }
  if (data.status.lastEventId !== null && !eventIds.includes(data.status.lastEventId)) {
    throw new ValidationError(`orchestration runtime status.lastEventId references unknown eventId: ${data.status.lastEventId}`);
  }
  const hasBlockedRole = roleAssignments.some((role) => role.status === 'blocked');
  if ((data.status.phase === 'blocked' || hasBlockedRole) && !data.status.blocked) {
    throw new ValidationError('orchestration runtime status.blocked must be true when phase or roleAssignments indicate blocked');
  }
  if (data.status.phase === 'closed' && data.status.blocked) {
    throw new ValidationError('orchestration runtime status.blocked must be false when phase is closed');
  }
  return data;
}

export function validateOrchestrationRuntime(filePath) {
  return validateOrchestrationRuntimeData(loadJson(filePath));
}

export function validateSkillProposalData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.skill_proposal));
  validateNonBlankStrings(data.targetFiles, `${data.proposalId}.targetFiles`);
  if (data.evidence) validateNonBlankStrings(data.evidence, `${data.proposalId}.evidence`);
  return data;
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
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-draft-approval:${data.approvalId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference approvalId');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-patch-draft:${data.draftId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference draftId');
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

export function validateRunsDir(runsDir) {
  if (!existsSync(runsDir)) throw new ValidationError(`runs directory is missing: ${runsDir}`);
  if (!lstatSync(runsDir).isDirectory()) throw new ValidationError(`runs path must be a directory: ${runsDir}`);
  const indexPath = path.join(runsDir, 'run-index.json');
  assertFile(indexPath, 'run-index.json');
  const index = validateRunIndex(indexPath);
  for (const run of index.runs) {
    const runPath = path.join(runsDir, `${run.runId}.json`);
    assertFile(runPath, run.runRef);
    const runData = validateRun(runPath);
    if (run.runRef !== `${run.runId}.json`) {
      throw new ValidationError(`run-index ${run.runId}.runRef must be ${run.runId}.json`);
    }
    for (const field of ['runId', 'taskId', 'iterationId', 'status', 'agentTool', 'workspaceRef', 'taskGraphRef', 'startedAt', 'finishedAt']) {
      if (JSON.stringify(run[field]) !== JSON.stringify(runData[field])) {
        throw new ValidationError(`run-index ${run.runId}.${field} does not match run file`);
      }
    }
    if (runData.projectId !== index.projectId) {
      throw new ValidationError(`run ${run.runId} projectId does not match run-index projectId`);
    }
    const runtimePath = path.join(runsDir, `${run.runId}.orchestration-runtime.json`);
    if (existsSync(runtimePath)) {
      const runtime = validateOrchestrationRuntime(runtimePath);
      if (runtime.runId !== run.runId) {
        throw new ValidationError(`orchestration runtime ${path.basename(runtimePath)} runId does not match run-index ${run.runId}`);
      }
      if (runtime.projectId !== index.projectId) {
        throw new ValidationError(`orchestration runtime ${path.basename(runtimePath)} projectId does not match run-index projectId`);
      }
      if (runtime.taskId !== run.taskId) {
        throw new ValidationError(`orchestration runtime ${path.basename(runtimePath)} taskId does not match run-index taskId`);
      }
    }
  }
  const indexedRunFiles = new Set(index.runs.map((run) => `${run.runId}.json`));
  const extraRunFiles = readdirSync(runsDir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'run-index.json' && !entry.endsWith('.orchestration.json') && !entry.endsWith('.orchestration-runtime.json') && !entry.endsWith('.monitor-verdict.json') && !indexedRunFiles.has(entry));
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

export function validateStatusApprovalAudit(filePath, spec) {
  if (spec.approval !== 'approved') return null;
  const text = readFileSync(filePath, 'utf8');
  const required = [
    ['Gate B approval audit', /^#{3,6}\s+Gate B approval audit\s*$/im],
    ['Approved by field', /Approved by:\s*\S+/i],
    ['Approved at field', /Approved at:\s*\d{4}-\d{2}-\d{2}/i],
    ['Approved artifacts field', /Approved artifacts:\s*\S+/i],
    ['Approval note field', /Approval note:\s*\S+/i],
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

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
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
  assertFile(paths.statusDoc, GATE_PATHS.statusDoc);
  validateStatusDoc(paths.statusDoc);

  requireGateFiles(paths, ['intakeJson', 'intakeMd'], 'Gate A');
  const intake = validateIntake(paths.intakeJson, { intakeMdPath: paths.intakeMd });
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

  const gateBKeys = ['productSpec', 'implementationPlan', 'specJson'];
  const gateBExisting = filesExist(paths, gateBKeys);
  if (gateBExisting.length) {
    requireGateFiles(paths, gateBKeys, 'Gate B');
    const spec = validateSpec(paths.specJson, paths.intakeJson);
    assertProjectId('spec.project_id', spec.project_id, options.projectId);
    validateStatusApprovalAudit(paths.statusDoc, spec);
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

  const gateDKeys = ['reviewReport', 'reviewJson'];
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

  result.readyForHandoff = result.gates.b.passed && result.gates.c.passed && result.gates.d.passed;
  if (options.requireHandoffReady && !result.readyForHandoff) {
    const missing = [];
    if (!result.gates.b.present) missing.push('Gate B');
    if (!result.gates.c.present) missing.push('Gate C');
    if (!result.gates.d.present) missing.push('Gate D');
    const reasons = [];
    if (missing.length) reasons.push(`missing ${missing.join(', ')}`);
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
    ['status.md', (artifactPath) => validateStatusDoc(artifactPath)],
    ['intake.blocked.json', (artifactPath) => validateIntake(artifactPath)],
    ['intake.answered.json', (artifactPath) => validateIntake(artifactPath, { intakeMdPath: optionalFixtureIntakeMd(fixturePath) })],
    ['spec.approved.json', (artifactPath) => validateSpec(artifactPath, path.join(fixturePath, 'intake.answered.json'))],
    ['task-graph.json', (artifactPath) => validateTaskGraph(artifactPath, path.join(fixturePath, 'spec.approved.json'))],
    ['review-report.md', () => null],
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
  validateStatusApprovalAudit(
    path.join(fixturePath, 'status.md'),
    loadJson(path.join(fixturePath, 'spec.approved.json')),
  );
}

function parseArgs(argv) {
  const args = { fixtureDir: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--intake') args.intake = argv[++index];
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
    else if (arg === '--orchestration-plan') args.orchestrationPlan = argv[++index];
    else if (arg === '--orchestration-runtime') args.orchestrationRuntime = argv[++index];
    else if (arg === '--skill-proposal') args.skillProposal = argv[++index];
    else if (arg === '--proposal-review') args.proposalReview = argv[++index];
    else if (arg === '--proposal-curation') args.proposalCuration = argv[++index];
    else if (arg === '--proposal-patch-draft') args.proposalPatchDraft = argv[++index];
    else if (arg === '--proposal-draft-approval') args.proposalDraftApproval = argv[++index];
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
    if (args.intake) validateIntake(args.intake, { intakeMdPath: args.intakeMd ?? undefined });
    else if (args.intakeMd) throw new ValidationError('--intake-md requires --intake');
    if (args.spec) validateSpec(args.spec, args.intake ?? requireSpecSourceIntake(args.spec));
    if (args.taskGraph) validateTaskGraph(args.taskGraph, args.requireApprovedSpec ?? null);
    if (args.requireReviewPass && !args.review && !args.fixtureDir.length && !args.artifactRoot) {
      throw new ValidationError('--require-review-pass requires --review');
    }
    if (args.review) validateReview(args.review, null, { requirePass: args.requireReviewPass });
    if (args.run) validateRun(args.run);
    if (args.runIndex) validateRunIndex(args.runIndex);
    if (args.runsDir) validateRunsDir(args.runsDir);
    if (args.orchestrationPlan) validateOrchestrationPlan(args.orchestrationPlan);
    if (args.orchestrationRuntime) validateOrchestrationRuntime(args.orchestrationRuntime);
    if (args.skillProposal) validateSkillProposal(args.skillProposal);
    if (args.proposalReview) validateProposalReview(args.proposalReview);
    if (args.proposalCuration) validateProposalCuration(args.proposalCuration);
    if (args.proposalPatchDraft) validateProposalPatchDraft(args.proposalPatchDraft);
    if (args.proposalDraftApproval) validateProposalDraftApproval(args.proposalDraftApproval);
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
