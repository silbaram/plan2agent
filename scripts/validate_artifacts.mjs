#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCHEMA_PATHS = {
  intake: path.join(ROOT, 'schemas', 'intake.schema.json'),
  spec: path.join(ROOT, 'schemas', 'spec.schema.json'),
  task_graph: path.join(ROOT, 'schemas', 'task-graph.schema.json'),
  task_context: path.join(ROOT, 'schemas', 'task-context.schema.json'),
  review: path.join(ROOT, 'schemas', 'review.schema.json'),
  run: path.join(ROOT, 'schemas', 'run.schema.json'),
  run_index: path.join(ROOT, 'schemas', 'run-index.schema.json'),
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

function resolveExistingFileReference(reference, baseDir) {
  if (!reference || typeof reference !== 'string') return null;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(process.cwd(), reference),
        path.resolve(baseDir, reference),
      ];
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
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
  validateSchema(data, loadJson(SCHEMA_PATHS.run));
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
  }
  const indexedRunFiles = new Set(index.runs.map((run) => `${run.runId}.json`));
  const extraRunFiles = readdirSync(runsDir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'run-index.json' && !indexedRunFiles.has(entry));
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
  const projectRelative = `${path.basename(artifactRoot)}/${expectedRelative}`;
  const artifactsRelative = `artifacts/${projectRelative}`;
  return normalized === expectedRelative
    || normalized === projectRelative
    || normalized === artifactsRelative;
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
