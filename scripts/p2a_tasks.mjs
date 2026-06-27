#!/usr/bin/env node
/** Manage Plan2Agent task graph status and dependency workflow. */

import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import { resolveRunsDir } from './p2a_run_paths.mjs';
import { P2A_ARTIFACTS_DIR, configuredTaskGraphPath, resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const VALID_TRANSITIONS = new Set(['start', 'done', 'block', 'todo']);
const DEFAULT_ARTIFACT_CANDIDATES = ['.'];
const INTERACTIVE_COMMANDS = [
  { command: 'list', description: '전체 task와 진행 상태표' },
  { command: 'ready', description: '지금 시작 가능한 task' },
  { command: 'show', description: 'task 상세 JSON' },
  { command: 'prompt', description: '실행 프롬프트 뽑기' },
  { command: 'start', description: 'task 시작(in_progress)' },
  { command: 'done', description: '완료 처리' },
  { command: 'block', description: '차단' },
  { command: 'todo', description: 'todo로 되돌리기' },
];
const TASK_ID_COMMANDS = new Set(['show', 'prompt', 'start', 'done', 'block', 'todo']);

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_tasks.mjs <command> --graph <path> [--spec <path>] [task-id]',
    '  node .plan2agent/scripts/p2a_tasks.mjs <command> --artifacts <iterative-project-dir> [task-id]',
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
    '',
    'Options:',
    '  --graph <path>       Task graph JSON path. Defaults to .plan2agent/project.config.json taskGraph when available.',
    '  --artifacts <dir>    Iterative artifact root; uses the active iteration task graph.',
    '  --spec <path>        Spec JSON path for prompt context. Only supported with --graph.',
    '  --maintenance        With --artifacts, operate on the maintenance task graph.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  let graphPath = null;
  let artifactsPath = null;
  let specPath = null;
  let maintenance = false;
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--graph') {
      graphPath = rest[++index];
      if (!graphPath) throw new Error('--graph requires a path');
    } else if (arg === '--artifacts') {
      artifactsPath = rest[++index];
      if (!artifactsPath) throw new Error('--artifacts requires a directory');
    } else if (arg === '--spec') {
      specPath = rest[++index];
      if (!specPath) throw new Error('--spec requires a path');
    } else if (arg === '--maintenance') {
      maintenance = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!graphPath && !artifactsPath) {
    graphPath = configuredTaskGraphPath();
  }
  if (graphPath && artifactsPath) throw new Error('--graph and --artifacts cannot be used together');
  if (graphPath && maintenance) throw new Error('--maintenance is only supported with --artifacts');
  if (!graphPath && !artifactsPath) throw new Error('--graph or --artifacts is required');
  if (artifactsPath && specPath) throw new Error('--spec is only supported with --graph; --artifacts uses the active iteration spec');
  return { command, graphPath, artifactsPath, specPath, maintenance, taskId: positional[0], extra: positional.slice(1), iterationState: null };
}

function resolveTaskInputs(args) {
  if (!args.artifactsPath) return args;
  const requireReady = !args.maintenance;
  const iterationState = resolveIterationState(args.artifactsPath, { requireReady });
  if (args.maintenance) {
    const graphPath = path.join(iterationState.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
    if (!existsSync(graphPath)) {
      throw new Error('no maintenance task graph yet; create one with: node .plan2agent/scripts/p2a_iteration.mjs maintenance add --artifacts <dir> --title ... --accept ...');
    }
    return {
      ...args,
      graphPath,
      specPath: iterationState.currentSpecPath,
      iterationState,
    };
  }
  return {
    ...args,
    graphPath: iterationState.taskGraphPath,
    specPath: iterationState.specPath,
    iterationState,
  };
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

function runsDirForTaskArgs(args) {
  if (args.artifactsPath) return resolveRunsDir({ artifacts: args.artifactsPath });
  if (args.graphPath) return resolveRunsDir({ graph: args.graphPath });
  return null;
}

function latestRunFailureClass(args, taskId) {
  const runsDir = runsDirForTaskArgs(args);
  if (!runsDir) return null;
  const indexPath = path.join(runsDir, 'run-index.json');
  if (!existsSync(indexPath) || !lstatSync(indexPath).isFile()) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const taskEntry = index.tasks?.find((entry) => entry.taskId === taskId);
    const runId = taskEntry?.latestRunId;
    if (!runId) return null;
    const runPath = path.join(runsDir, `${runId}.json`);
    if (!existsSync(runPath) || !lstatSync(runPath).isFile()) return null;
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    return run.failure?.class ?? null;
  } catch (error) {
    console.error(`warning: could not read latest run failure for ${taskId}: ${error.message}`);
    return null;
  }
}

function transitionTask(graph, task, command, args = {}) {
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
    const failureClass = latestRunFailureClass(args, task.id);
    if (failureClass) task.blockReason = failureClass;
  } else if (command === 'todo') {
    task.status = 'todo';
  }
}

function clearBlockReasonIfUnblocked(task, command) {
  if (command === 'done' || command === 'todo' || command === 'start') delete task.blockReason;
}

function saveValidatedGraph(graphPath, graph) {
  validateTaskGraphData(graph);
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

function isCancel(input) {
  const trimmed = input.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'q';
}

async function askRequired(rl, label, description, defaultValue = null) {
  const defaultLabel = defaultValue ? ` [${defaultValue}]` : '';
  const input = await rl.question(`${label}${defaultLabel} - ${description}: `);
  if (input.trim().toLowerCase() === 'q') return null;
  if (input.trim() === '') return defaultValue;
  return input.trim();
}

async function askMenu(rl, title, items, formatItem) {
  console.log(title);
  items.forEach((item, index) => console.log(formatItem(item, index + 1)));
  while (true) {
    const input = await rl.question('번호 선택 (빈 입력/q=취소): ');
    if (isCancel(input)) return null;
    const selected = Number.parseInt(input.trim(), 10);
    if (Number.isInteger(selected) && selected >= 1 && selected <= items.length) return items[selected - 1];
    console.log(`1-${items.length} 사이의 번호를 입력하세요.`);
  }
}

function interactiveGraphDefault() {
  return configuredTaskGraphPath();
}

function isIterativeArtifactRoot(candidate) {
  return existsSync(path.join(candidate, 'current-spec.json')) && existsSync(path.join(candidate, 'iterations'));
}

function interactiveArtifactsDefault() {
  for (const candidate of DEFAULT_ARTIFACT_CANDIDATES) {
    if (isIterativeArtifactRoot(candidate)) return candidate;
  }

  const projectDefaults = listArtifactProjectDefaults();
  return projectDefaults.length === 1 ? projectDefaults[0] : null;
}

function listArtifactProjectDefaults() {
  const artifactsRoot = path.join(process.cwd(), P2A_ARTIFACTS_DIR);
  if (!existsSync(artifactsRoot)) return [];
  try {
    return readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(P2A_ARTIFACTS_DIR, entry.name))
      .filter((candidate) => isIterativeArtifactRoot(candidate))
      .sort();
  } catch {
    return [];
  }
}

async function buildInteractiveArgv(rl) {
  const selected = await askMenu(
    rl,
    'Plan2Agent task 명령을 선택하세요.',
    INTERACTIVE_COMMANDS,
    (item, number) => `${number}) ${item.command.padEnd(6)} ${item.description}`,
  );
  if (!selected) return null;

  const source = await askMenu(
    rl,
    'task 기준을 선택하세요.',
    [
      { mode: 'artifacts', label: 'active artifacts', description: '반복 artifact 루트에서 active iteration을 자동 인식' },
      { mode: 'maintenance', label: 'maintenance', description: '반복 artifact 루트의 maintenance 레인' },
      { mode: 'graph', label: 'graph file', description: 'task graph JSON 경로 직접 입력' },
    ],
    (item, number) => `${number}) ${item.label.padEnd(16)} ${item.description}`,
  );
  if (!source) return null;

  let argv;
  let graphPath;
  if (source.mode === 'artifacts' || source.mode === 'maintenance') {
    const artifactsPath = await askRequired(
      rl,
      'artifacts',
      '반복 artifact 루트',
      interactiveArtifactsDefault(),
    );
    if (!artifactsPath) return null;
    const requireReady = source.mode !== 'maintenance';
    const iterationState = resolveIterationState(artifactsPath, { requireReady });
    if (source.mode === 'maintenance') {
      graphPath = path.join(iterationState.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      if (!existsSync(graphPath)) {
        throw new Error('no maintenance task graph yet; create one with: node .plan2agent/scripts/p2a_iteration.mjs maintenance add --artifacts <dir> --title ... --accept ...');
      }
      argv = [selected.command, '--artifacts', artifactsPath, '--maintenance'];
    } else {
      graphPath = iterationState.taskGraphPath;
      argv = [selected.command, '--artifacts', artifactsPath];
    }
  } else {
    graphPath = await askRequired(
      rl,
      'graph',
      'task graph JSON 경로',
      interactiveGraphDefault(),
    );
    if (!graphPath) return null;
    argv = [selected.command, '--graph', graphPath];
  }

  if (TASK_ID_COMMANDS.has(selected.command)) {
    const graph = loadGraph(graphPath);
    validateTaskGraphData(graph);
    const task = await askMenu(
      rl,
      'task를 선택하세요.',
      graph.tasks,
      (item, number) => `${number}) ${item.id}  [${item.status}]  ${item.title}`,
    );
    if (!task) return null;

    if (selected.command === 'prompt' && source.mode === 'graph') {
      const specPath = await rl.question('spec [자동 해석] - source spec JSON 경로(Enter=--spec 생략): ');
      if (specPath.trim().toLowerCase() === 'q') return null;
      if (specPath.trim() !== '') argv.push('--spec', specPath.trim());
    }
    argv.push(task.id);
  }
  return argv;
}

function createQuestioner() {
  if (process.stdin.isTTY) return createInterface({ input: process.stdin, output: process.stdout });

  const answers = readFileSync(0, 'utf8').split(/\r?\n/);
  return {
    async question(prompt) {
      const answer = answers.length ? answers.shift() : '';
      const rl = createInterface({ input: Readable.from([`${answer}\n`]), output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    close() {},
  };
}

export async function interactiveMain() {
  const rl = createQuestioner();
  try {
    const argv = await buildInteractiveArgv(rl);
    if (!argv) return 0;
    return main(argv);
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'task graph validation failed' : 'p2a task interactive failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  } finally {
    rl.close();
  }
}

function shouldRunInteractive(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return false;
  if (argv.includes('--interactive') || argv.includes('-i')) return true;
  return argv.length === 0 && process.stdin.isTTY;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return P2A_PATHS.filename === path.resolve(process.argv[1]);
  }
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
    args = resolveTaskInputs(args);

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
      transitionTask(graph, task, args.command, args);
      clearBlockReasonIfUnblocked(task, args.command);
      saveValidatedGraph(args.graphPath, graph);
      console.log(`${task.id} status is now ${task.status}`);
      if (args.command === 'block' && task.blockReason) console.log(`- blockReason: ${task.blockReason}`);
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

if (isDirectEntry()) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 && !process.stdin.isTTY) {
    console.log(usage());
    process.exitCode = 0;
  } else if (shouldRunInteractive(argv)) {
    process.exitCode = await interactiveMain();
  } else {
    process.exitCode = main(argv);
  }
}
