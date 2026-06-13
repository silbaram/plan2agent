#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCHEMA_PATHS = {
  intake: path.join(ROOT, 'schemas', 'intake.schema.json'),
  spec: path.join(ROOT, 'schemas', 'spec.schema.json'),
  task_graph: path.join(ROOT, 'schemas', 'task-graph.schema.json'),
  review: path.join(ROOT, 'schemas', 'review.schema.json'),
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

function schemaTypeMatches(instance, expectedType) {
  if (expectedType === 'object') return instance !== null && typeof instance === 'object' && !Array.isArray(instance);
  if (expectedType === 'array') return Array.isArray(instance);
  if (expectedType === 'string') return typeof instance === 'string';
  if (expectedType === 'boolean') return typeof instance === 'boolean';
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
    const supported = new Set(['object', 'array', 'string', 'boolean']);
    if (!supported.has(expectedType)) {
      throw new ValidationError(`unsupported schema type ${JSON.stringify(expectedType)} at ${instancePath}`);
    }
    if (!schemaTypeMatches(instance, expectedType)) {
      throw new ValidationError(`${instancePath} must be ${expectedType}`);
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

export function validateIntake(filePath) {
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
  return data;
}

export function validateSpec(filePath, intakePath = null) {
  const data = validateAgainstSchema(filePath, 'spec');
  validateEvidence(data.evidence, 'spec');
  if (data.approval === 'approved' && data.open_decisions.length) {
    throw new ValidationError('approved specs must not contain open_decisions');
  }

  if (intakePath) {
    const intake = validateIntake(intakePath);
    const intakeDecisions = new Map(intake.needs_user_decision.map((decision) => [decision.id, decision.status]));
    const unknownDecisions = data.open_decisions.filter((decisionId) => !intakeDecisions.has(decisionId));
    if (unknownDecisions.length) {
      throw new ValidationError(`spec.open_decisions references unknown intake decisions: ${JSON.stringify(unknownDecisions)}`);
    }
    const unresolvedDecisions = new Set(
      [...intakeDecisions.entries()]
        .filter(([, status]) => status === 'open' || status === 'deferred')
        .map(([decisionId]) => decisionId),
    );
    const specOpenDecisions = new Set(data.open_decisions);
    const expected = [...unresolvedDecisions].sort();
    const got = [...specOpenDecisions].sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      throw new ValidationError(
        `spec.open_decisions must exactly match unresolved intake decisions: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
    }
  }
  return data;
}

export function validateTaskGraphData(data, requireApprovedSpec = null) {
  const schema = loadJson(SCHEMA_PATHS.task_graph);
  validateSchema(data, schema);
  if (requireApprovedSpec) {
    const spec = validateSpec(requireApprovedSpec);
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
  const intake = validateIntake(paths.intakeJson);
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

export function validateFixtureDir(fixturePath) {
  const required = [
    ['status.md', (artifactPath) => validateStatusDoc(artifactPath)],
    ['intake.blocked.json', (artifactPath) => validateIntake(artifactPath)],
    ['intake.answered.json', (artifactPath) => validateIntake(artifactPath)],
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
}

function parseArgs(argv) {
  const args = { fixtureDir: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--intake') args.intake = argv[++index];
    else if (arg === '--status') args.status = argv[++index];
    else if (arg === '--artifact-root') args.artifactRoot = argv[++index];
    else if (arg === '--project-id') args.projectId = argv[++index];
    else if (arg === '--spec') args.spec = argv[++index];
    else if (arg === '--task-graph') args.taskGraph = argv[++index];
    else if (arg === '--review') args.review = argv[++index];
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
    if (args.intake) validateIntake(args.intake);
    if (args.spec) validateSpec(args.spec, args.intake ?? null);
    if (args.taskGraph) validateTaskGraph(args.taskGraph, args.requireApprovedSpec ?? null);
    if (args.requireReviewPass && !args.review && !args.fixtureDir.length && !args.artifactRoot) {
      throw new ValidationError('--require-review-pass requires --review');
    }
    if (args.review) validateReview(args.review, null, { requirePass: args.requireReviewPass });
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
