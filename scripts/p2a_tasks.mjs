#!/usr/bin/env node
/** Manage Plan2Agent task graph status and dependency workflow. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

class LocalValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assertType(value, type, label) {
  if (type === 'array') {
    if (!Array.isArray(value)) throw new LocalValidationError(`${label} must be array`);
    return;
  }
  if (typeof value !== type || value === null || Array.isArray(value)) throw new LocalValidationError(`${label} must be ${type}`);
}

function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node, stack) {
    if (visiting.has(node)) throw new LocalValidationError(`task graph contains a dependency cycle: ${[...stack, node].join(' -> ')}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node)) visit(dependency, [...stack, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
}

function fallbackValidateTaskGraphData(data) {
  assertType(data, 'object', '$');
  for (const key of ['schema_version', 'projectId', 'version', 'sourceSpec']) assertType(data[key], 'string', `$.${key}`);
  if (data.schema_version !== 'p2a.task_graph.v1') throw new LocalValidationError('$.schema_version must equal "p2a.task_graph.v1"');
  assertType(data.tasks, 'array', '$.tasks');
  if (data.tasks.length === 0) throw new LocalValidationError('$.tasks must contain at least 1 item');

  const taskIds = data.tasks.map((task, index) => {
    assertType(task, 'object', `$.tasks[${index}]`);
    for (const key of ['id', 'title', 'description', 'status', 'targetArea', 'suggestedAgentPrompt']) assertType(task[key], 'string', `$.tasks[${index}].${key}`);
    for (const key of ['dependencies', 'acceptanceCriteria', 'sourceSpecRefs']) assertType(task[key], 'array', `$.tasks[${index}].${key}`);
    if (!/^task-[0-9]+$/.test(task.id)) throw new LocalValidationError(`$.tasks[${index}].id must match task-[0-9]+`);
    if (!['todo', 'blocked', 'in_progress', 'done'].includes(task.status)) throw new LocalValidationError(`$.tasks[${index}].status is unsupported`);
    if (task.acceptanceCriteria.length === 0) throw new LocalValidationError(`$.tasks[${index}].acceptanceCriteria must contain at least 1 item`);
    if (task.sourceSpecRefs.length === 0) throw new LocalValidationError(`$.tasks[${index}].sourceSpecRefs must contain at least 1 item`);
    return task.id;
  });

  if (taskIds.length !== new Set(taskIds).size) throw new LocalValidationError('task ids must be unique');
  const taskIdSet = new Set(taskIds);
  const graph = new Map();
  for (const task of data.tasks) {
    const unknownDependencies = task.dependencies.filter((dependency) => !taskIdSet.has(dependency));
    if (unknownDependencies.length) throw new LocalValidationError(`${task.id} has unknown dependencies: ${JSON.stringify(unknownDependencies)}`);
    graph.set(task.id, [...task.dependencies]);
  }
  detectCycles(graph);
  return data;
}

const VALIDATOR_PATH = path.join(path.dirname(__filename), 'validate_artifacts.mjs');
const validators = existsSync(VALIDATOR_PATH) ? await import(pathToFileURL(VALIDATOR_PATH).href) : null;
const validateTaskGraphData = validators?.validateTaskGraphData ?? fallbackValidateTaskGraphData;
const ValidationError = validators?.ValidationError ?? LocalValidationError;
const ROOT = path.resolve(path.dirname(__filename), '..');
const VALID_TRANSITIONS = new Set(['start', 'done', 'block', 'todo']);

function usage() {
  return [
    'Usage: node scripts/p2a_tasks.mjs <command> --graph <path> [--spec <path>] [task-id]',
    '',
    'Commands:',
    '  list                 Show all tasks with readiness.',
    '  ready                Show ready todo tasks.',
    '  show <task-id>       Show the full task JSON.',
    '  prompt <task-id>     Print suggestedAgentPrompt, acceptance criteria, task description, referenced spec context, and full spec path.',
    '  start <task-id>      Mark a ready todo task in_progress.',
    '  done <task-id>       Mark an in_progress task done.',
    '  block <task-id>      Mark a task blocked.',
    '  todo <task-id>       Mark a task todo.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  let graphPath = null;
  let specPath = null;
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--graph') {
      graphPath = rest[++index];
      if (!graphPath) throw new Error('--graph requires a path');
    } else if (arg === '--spec') {
      specPath = rest[++index];
      if (!specPath) throw new Error('--spec requires a path');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!graphPath) throw new Error('--graph is required');
  return { command, graphPath, specPath, taskId: positional[0], extra: positional.slice(1) };
}

function loadGraph(graphPath) {
  return JSON.parse(readFileSync(graphPath, 'utf8'));
}

function taskMap(graph) {
  return new Map(graph.tasks.map((task) => [task.id, task]));
}

function isReady(task, tasksById) {
  return task.status === 'todo' && task.dependencies.every((dependency) => tasksById.get(dependency)?.status === 'done');
}

function requireTask(graph, taskId) {
  if (!taskId) throw new Error('task-id is required for this command');
  const task = taskMap(graph).get(taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  return task;
}

function printTaskTable(tasks, tasksById) {
  console.log('id\ttitle\tstatus\tdependencies\tready');
  for (const task of tasks) {
    console.log(`${task.id}\t${task.title}\t${task.status}\t${task.dependencies.join(',') || '-'}\t${isReady(task, tasksById) ? 'yes' : 'no'}`);
  }
}

function resolveSourceSpecPath(graph, graphPath, specPath = null) {
  if (specPath) return path.resolve(specPath);
  if (path.isAbsolute(graph.sourceSpec)) return graph.sourceSpec;

  const graphRelativePath = path.resolve(path.dirname(graphPath), graph.sourceSpec);
  if (existsSync(graphRelativePath)) return graphRelativePath;

  const rootRelativePath = path.resolve(ROOT, graph.sourceSpec);
  if (existsSync(rootRelativePath)) return rootRelativePath;

  return graphRelativePath;
}

function formatDisplayPath(filePath) {
  const relativePath = path.relative(ROOT, filePath);
  const isRootRelative = relativePath
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
  const displayPath = isRootRelative
    ? relativePath
    : filePath;
  return displayPath.split(path.sep).join('/');
}

function getByDotPath(data, dotPath) {
  return dotPath.split('.').reduce((current, part) => {
    if (current && typeof current === 'object' && Object.hasOwn(current, part)) return current[part];
    return undefined;
  }, data);
}

function formatSpecValue(value, indent = '  ') {
  if (Array.isArray(value)) return value.map((item) => `${indent}- ${formatScalar(item)}`);
  if (value && typeof value === 'object') {
    return JSON.stringify(value, null, 2).split('\n').map((line) => `${indent}${line}`);
  }
  return [`${indent}- ${formatScalar(value)}`];
}

function formatScalar(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function printSpecContext(task, spec) {
  console.log('Referenced spec context:');
  for (const sourceSpecRef of task.sourceSpecRefs) {
    if (!spec) {
      console.log(`- ${sourceSpecRef}`);
      continue;
    }

    const value = getByDotPath(spec, sourceSpecRef);
    console.log(`- ${sourceSpecRef}:`);
    if (value === undefined) {
      console.log('  - Not found in source spec.');
    } else {
      for (const line of formatSpecValue(value)) console.log(line);
    }
  }
}

function readSpecForPrompt(specPath, displayPath = specPath) {
  try {
    return JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    console.error(`warning: could not read source spec ${displayPath}: ${error.message}`);
    return null;
  }
}

function printPrompt(task, graph, graphPath, specPath = null) {
  const sourceSpecPath = resolveSourceSpecPath(graph, graphPath, specPath);
  const displaySourceSpecPath = formatDisplayPath(sourceSpecPath);
  const spec = readSpecForPrompt(sourceSpecPath, displaySourceSpecPath);

  console.log(task.suggestedAgentPrompt.trimEnd());
  console.log('');
  console.log('Acceptance criteria:');
  for (const criterion of task.acceptanceCriteria) console.log(`- ${criterion}`);

  if (task.description) {
    console.log('');
    console.log('Task description:');
    console.log(task.description);
  }

  console.log('');
  printSpecContext(task, spec);
  console.log('');
  console.log(`Full spec: ${displaySourceSpecPath}`);
}

function transitionTask(graph, task, command) {
  const tasksById = taskMap(graph);
  if (command === 'start') {
    if (task.status !== 'todo') throw new Error(`${task.id} must be todo before start; current status is ${task.status}`);
    const incomplete = task.dependencies.filter((dependency) => tasksById.get(dependency)?.status !== 'done');
    if (incomplete.length) throw new Error(`${task.id} cannot start until dependencies are done: ${incomplete.join(', ')}`);
    task.status = 'in_progress';
  } else if (command === 'done') {
    if (task.status !== 'in_progress') throw new Error(`${task.id} must be in_progress before done; current status is ${task.status}`);
    task.status = 'done';
  } else if (command === 'block') {
    task.status = 'blocked';
  } else if (command === 'todo') {
    task.status = 'todo';
  }
}

function saveValidatedGraph(graphPath, graph) {
  validateTaskGraphData(graph);
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.extra?.length) throw new Error(`unexpected extra argument(s): ${args.extra.join(', ')}`);

    const graph = loadGraph(args.graphPath);
    validateTaskGraphData(graph);
    const tasksById = taskMap(graph);

    if (args.command === 'list') {
      printTaskTable(graph.tasks, tasksById);
    } else if (args.command === 'ready') {
      printTaskTable(graph.tasks.filter((task) => isReady(task, tasksById)), tasksById);
    } else if (args.command === 'show') {
      console.log(JSON.stringify(requireTask(graph, args.taskId), null, 2));
    } else if (args.command === 'prompt') {
      printPrompt(requireTask(graph, args.taskId), graph, args.graphPath, args.specPath);
    } else if (VALID_TRANSITIONS.has(args.command)) {
      const task = requireTask(graph, args.taskId);
      transitionTask(graph, task, args.command);
      saveValidatedGraph(args.graphPath, graph);
      console.log(`${task.id} status is now ${task.status}`);
    } else {
      throw new Error(`unknown command: ${args.command}`);
    }
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'task graph validation failed' : 'p2a task command failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
