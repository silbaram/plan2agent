#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SCHEMA_PATHS = {
  intake: path.join(ROOT, 'schemas', 'intake.schema.json'),
  spec: path.join(ROOT, 'schemas', 'spec.schema.json'),
  task_graph: path.join(ROOT, 'schemas', 'task-graph.schema.json'),
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
    const unknownDependencies = task.dependencies.filter((dependency) => !taskIdSet.has(dependency));
    if (unknownDependencies.length) {
      throw new ValidationError(`${task.id} has unknown dependencies: ${JSON.stringify(unknownDependencies)}`);
    }
    graph.set(task.id, [...task.dependencies]);
  }

  detectCycles(graph);
  return data;
}

export function validateTaskGraph(filePath, requireApprovedSpec = null) {
  return validateTaskGraphData(loadJson(filePath), requireApprovedSpec);
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
    ['intake.blocked.json', (artifactPath) => validateIntake(artifactPath)],
    ['intake.answered.json', (artifactPath) => validateIntake(artifactPath)],
    ['spec.approved.json', (artifactPath) => validateSpec(artifactPath, path.join(fixturePath, 'intake.answered.json'))],
    ['task-graph.json', (artifactPath) => validateTaskGraph(artifactPath, path.join(fixturePath, 'spec.approved.json'))],
    ['review-report.md', () => null],
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
    else if (arg === '--spec') args.spec = argv[++index];
    else if (arg === '--task-graph') args.taskGraph = argv[++index];
    else if (arg === '--require-approved-spec') args.requireApprovedSpec = argv[++index];
    else if (arg === '--fixture-dir') args.fixtureDir.push(argv[++index]);
    else throw new ValidationError(`unrecognized argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.intake) validateIntake(args.intake);
    if (args.spec) validateSpec(args.spec, args.intake ?? null);
    if (args.taskGraph) validateTaskGraph(args.taskGraph, args.requireApprovedSpec ?? null);
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
