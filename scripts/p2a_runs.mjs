#!/usr/bin/env node
/** Track Plan2Agent agent execution runs without mutating the task graph schema. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadJson,
  validateRunData,
  validateRunIndexData,
  validateRunsDir,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import { DEFAULT_RUNS_DIR, resolveRunsDir } from './p2a_run_paths.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const COMMANDS = new Set(['start', 'record', 'verify', 'finish', 'list', 'show', 'validate']);
const ISOLATION_MODES = new Set(['none', 'branch', 'worktree']);
const RUN_STATUSES = new Set(['started', 'finished', 'failed', 'blocked']);
const FAILURE_CLASSES = new Set(['verification_failed', 'test_flake', 'scope_violation', 'missing_dependency', 'environment_failure', 'implementation_incomplete', 'other']);
const FAILURE_RETRYABLE = new Set(['yes', 'no', 'after_fix']);
const FAILURE_SOURCES = new Set(['owner', 'monitor', 'implementer']);
const FAILURE_DEFAULTS = {
  verification_failed: { retryable: 'after_fix', needsUserDecision: false, source: 'owner' },
  test_flake: { retryable: 'yes', needsUserDecision: false, source: 'owner' },
  scope_violation: { retryable: 'no', needsUserDecision: true, source: 'owner' },
  missing_dependency: { retryable: 'after_fix', needsUserDecision: true, source: 'owner' },
  environment_failure: { retryable: 'yes', needsUserDecision: false, source: 'owner' },
  implementation_incomplete: { retryable: 'after_fix', needsUserDecision: false, source: 'owner' },
  other: { retryable: 'no', needsUserDecision: true, source: 'owner' },
};
const VERIFICATION_TYPES = new Set(['test', 'lint', 'typecheck', 'custom']);
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'skipped', 'not_run']);
const OUTPUT_TAIL_LIMIT = 4000;

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_runs.mjs start --artifacts <iterative-project-dir> --task <task-id> --agent-tool <tool> [options]',
    '  node .plan2agent/scripts/p2a_runs.mjs start --graph <task-graph.json> --task <task-id> --agent-tool <tool> [--runs <dir>] [options]',
    '  node .plan2agent/scripts/p2a_runs.mjs record --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--changed-file <path> ...] [--verification <type:status:command>] [--note <text>]',
    '  node .plan2agent/scripts/p2a_runs.mjs verify --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--test] [--lint] [--typecheck] [--test-command <cmd>] [--lint-command <cmd>] [--typecheck-command <cmd>] [--verify-command <type:cmd>]',
    '  node .plan2agent/scripts/p2a_runs.mjs finish --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--status finished|failed|blocked] [--failure-class <class>] [--retryable yes|no|after_fix] [--needs-user-decision true|false] [--failure-source owner|monitor|implementer] [--changed-file <path> ...] [--collect-git] [--note <text>]',
    '  node .plan2agent/scripts/p2a_runs.mjs list (--artifacts <dir>|--runs <dir>|--graph <path>) [--json]',
    '  node .plan2agent/scripts/p2a_runs.mjs show --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>)',
    '  node .plan2agent/scripts/p2a_runs.mjs validate (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>]',
    '',
    'Options:',
    '  --artifacts <dir>       Iterative artifact root; writes runs/ under that root.',
    '  --graph <path>          Task graph JSON path. Defaults runs to ../runs beside the graph parent.',
    '  --runs <dir>            Explicit runs directory containing run-index.json and run files.',
    '  --maintenance           With --artifacts, use the maintenance task graph as source context.',
    '  --task <task-id>        Task id for start.',
    '  --run-id <run-id>       Stable run id. Must start with run-. Generated for start when omitted.',
    '  --agent-tool <tool>     Agent/CLI tool that performed the run, such as codex, claude, gemini.',
    '  --workspace <dir>       Workspace path for verification commands. Defaults to cwd or --worktree.',
    '  --workspace-ref <ref>   Human-readable workspace reference. Defaults to --workspace display path.',
    '  --isolation <mode>      none, branch, or worktree. Default: none.',
    '  --branch <name>         Branch name to record or create for branch/worktree isolation.',
    '  --worktree <path>       Worktree path to record or create for worktree isolation.',
    '  --base-ref <ref>        Git base ref for --create-isolation. Default: HEAD.',
    '  --create-isolation      Create the branch/worktree with git before writing the run record.',
    '  --changed-file <path>   Changed file to attach to the run. Repeatable.',
    '  --collect-git           Add changed files from git status in the workspace.',
    '  --note <text>           Append a run note. Repeatable.',
    '  --failure-class <class> Failure class for failed/blocked finish. One of: verification_failed, test_flake, scope_violation, missing_dependency, environment_failure, implementation_incomplete, other.',
    '  --retryable <value>     Override failure retryability: yes, no, after_fix.',
    '  --needs-user-decision <true|false>',
    '                          Override whether the failure needs a user decision.',
    '  --failure-source <src>  Override failure source: owner, monitor, implementer.',
    '  --verification <type:status:command>',
    '                          Manually record a verification result. type: test/lint/typecheck/custom.',
    '  --test, --lint, --typecheck',
    '                          Run configured command from .plan2agent/project.config.json.',
    '  --test-command <cmd>, --lint-command <cmd>, --typecheck-command <cmd>',
    '                          Run an explicit verification command.',
    '  --verify-command <type:cmd>',
    '                          Run a custom command; type is optional and defaults to custom.',
    '  --json                  Machine-readable output for list.',
    '  --help, -h              Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  const args = {
    command,
    artifacts: null,
    graph: null,
    runs: null,
    maintenance: false,
    taskId: null,
    runId: null,
    agentTool: null,
    workspace: null,
    workspaceRef: null,
    isolation: 'none',
    branch: null,
    worktree: null,
    baseRef: 'HEAD',
    createIsolation: false,
    changedFiles: [],
    notes: [],
    manualVerification: [],
    verifyRequests: [],
    status: null,
    failureClass: null,
    retryable: null,
    needsUserDecision: null,
    failureSource: null,
    collectGit: false,
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--runs') args.runs = requiredValue(argv, ++index, '--runs');
    else if (arg === '--maintenance') args.maintenance = true;
    else if (arg === '--task') args.taskId = requiredValue(argv, ++index, '--task');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--agent-tool') args.agentTool = requiredValue(argv, ++index, '--agent-tool');
    else if (arg === '--workspace') args.workspace = requiredValue(argv, ++index, '--workspace');
    else if (arg === '--workspace-ref') args.workspaceRef = requiredValue(argv, ++index, '--workspace-ref');
    else if (arg === '--isolation') {
      args.isolation = requiredValue(argv, ++index, '--isolation');
      if (!ISOLATION_MODES.has(args.isolation)) throw new Error('--isolation must be one of none, branch, worktree');
    } else if (arg === '--branch') args.branch = requiredValue(argv, ++index, '--branch');
    else if (arg === '--worktree') args.worktree = requiredValue(argv, ++index, '--worktree');
    else if (arg === '--base-ref') args.baseRef = requiredValue(argv, ++index, '--base-ref');
    else if (arg === '--create-isolation') args.createIsolation = true;
    else if (arg === '--changed-file') args.changedFiles.push(requiredValue(argv, ++index, '--changed-file'));
    else if (arg === '--collect-git') args.collectGit = true;
    else if (arg === '--note') args.notes.push(requiredValue(argv, ++index, '--note'));
    else if (arg === '--verification') args.manualVerification.push(parseManualVerification(requiredValue(argv, ++index, '--verification')));
    else if (arg === '--test') args.verifyRequests.push({ type: 'test', command: null, source: 'config' });
    else if (arg === '--lint') args.verifyRequests.push({ type: 'lint', command: null, source: 'config' });
    else if (arg === '--typecheck') args.verifyRequests.push({ type: 'typecheck', command: null, source: 'config' });
    else if (arg === '--test-command') args.verifyRequests.push({ type: 'test', command: requiredValue(argv, ++index, '--test-command'), source: 'command' });
    else if (arg === '--lint-command') args.verifyRequests.push({ type: 'lint', command: requiredValue(argv, ++index, '--lint-command'), source: 'command' });
    else if (arg === '--typecheck-command') args.verifyRequests.push({ type: 'typecheck', command: requiredValue(argv, ++index, '--typecheck-command'), source: 'command' });
    else if (arg === '--verify-command') args.verifyRequests.push(parseVerifyCommand(requiredValue(argv, ++index, '--verify-command')));
    else if (arg === '--failure-class') {
      args.failureClass = requiredValue(argv, ++index, '--failure-class');
      if (!FAILURE_CLASSES.has(args.failureClass)) throw new Error(`--failure-class must be one of ${[...FAILURE_CLASSES].join(', ')}`);
    } else if (arg === '--retryable') {
      args.retryable = requiredValue(argv, ++index, '--retryable');
      if (!FAILURE_RETRYABLE.has(args.retryable)) throw new Error(`--retryable must be one of ${[...FAILURE_RETRYABLE].join(', ')}`);
    } else if (arg === '--needs-user-decision') {
      const value = requiredValue(argv, ++index, '--needs-user-decision');
      if (!['true', 'false'].includes(value)) throw new Error('--needs-user-decision must be true or false');
      args.needsUserDecision = value === 'true';
    } else if (arg === '--failure-source') {
      args.failureSource = requiredValue(argv, ++index, '--failure-source');
      if (!FAILURE_SOURCES.has(args.failureSource)) throw new Error(`--failure-source must be one of ${[...FAILURE_SOURCES].join(', ')}`);
    } else if (arg === '--status') {
      args.status = requiredValue(argv, ++index, '--status');
      if (!RUN_STATUSES.has(args.status) || args.status === 'started') throw new Error('--status must be finished, failed, or blocked');
    } else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  const sourceCount = [args.artifacts, args.graph, args.runs].filter(Boolean).length;
  if (sourceCount === 0) {
    const defaultArtifacts = singleArtifactProjectRoot();
    const configuredGraph = configuredTaskGraphPath();
    if (defaultArtifacts) args.artifacts = defaultArtifacts;
    else if (configuredGraph) args.graph = configuredGraph;
    else if (args.command === 'start') assertNoUninitializedScaffoldArtifactRoots();
    else if (existsSync(DEFAULT_RUNS_DIR)) args.runs = DEFAULT_RUNS_DIR;
    else assertNoUninitializedScaffoldArtifactRoots();
    if (!args.artifacts && !args.graph && !args.runs) {
      throw new Error('--artifacts, --graph, or --runs is required');
    }
  }
  if (args.artifacts && args.graph) throw new Error('--artifacts and --graph cannot be used together');
  if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
  if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  if (args.command === 'start') {
    if (!args.taskId) throw new Error('--task is required for start');
    if (!args.agentTool) throw new Error('--agent-tool is required for start');
    if (args.runs && !args.graph && !args.artifacts) throw new Error('start requires --artifacts or --graph so the task can be resolved');
  }
  if (args.command !== 'finish' && (args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource)) {
    throw new Error('failure options are only supported with finish');
  }
  if (args.command === 'finish') {
    const status = args.status ?? null;
    if (status === 'finished') assertFailureOptionsAllowed(args, status);
    if ((status === 'failed' || status === 'blocked') && !args.failureClass) {
      throw new Error(`--failure-class is required when --status is failed or blocked. Choose one of: ${[...FAILURE_CLASSES].join(', ')}`);
    }
    if (args.failureClass === 'other' && args.notes.length === 0) {
      throw new Error('--failure-class other requires at least one --note explaining why the failure could not be classified');
    }
  }
  if (['record', 'verify', 'finish', 'show'].includes(args.command) && !args.runId) {
    throw new Error(`--run-id is required for ${args.command}`);
  }
  return args;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function parseManualVerification(value) {
  const [type, status, ...commandParts] = value.split(':');
  const command = commandParts.join(':');
  if (!VERIFICATION_TYPES.has(type)) throw new Error(`manual verification type must be one of ${[...VERIFICATION_TYPES].join(', ')}`);
  if (!VERIFICATION_STATUSES.has(status)) throw new Error(`manual verification status must be one of ${[...VERIFICATION_STATUSES].join(', ')}`);
  if (!command) throw new Error('--verification must use type:status:command');
  return {
    type,
    command,
    status,
    exitCode: null,
    durationMs: null,
    startedAt: null,
    finishedAt: null,
    stdoutTail: null,
    stderrTail: null,
    source: 'manual',
  };
}

function parseVerifyCommand(value) {
  const separator = value.indexOf(':');
  if (separator === -1) return { type: 'custom', command: value, source: 'command' };
  const maybeType = value.slice(0, separator);
  if (!VERIFICATION_TYPES.has(maybeType)) return { type: 'custom', command: value, source: 'command' };
  const command = value.slice(separator + 1);
  if (!command) throw new Error('--verify-command command must not be blank');
  return { type: maybeType, command, source: 'command' };
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} must be a file: ${filePath}`);
}

function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new Error(`${label} is missing: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new Error(`${label} must be a directory: ${dirPath}`);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath, root = process.cwd()) {
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return normalizePath(filePath);
}

function artifactRelativePath(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

function loadTaskGraph(graphPath) {
  assertFile(graphPath, 'task graph');
  const graph = loadJson(graphPath);
  validateTaskGraphData(graph);
  return graph;
}

function taskMap(graph) {
  return new Map(graph.tasks.map((task) => [task.id, task]));
}

function requireTask(graph, taskId) {
  const task = taskMap(graph).get(taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  return task;
}

function resolveTaskSource(args) {
  if (args.artifacts) {
    const artifactRoot = path.resolve(args.artifacts);
    const state = resolveIterationState(artifactRoot, { requireReady: !args.maintenance });
    if (args.maintenance) {
      const graphPath = path.join(state.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      const graph = loadTaskGraph(graphPath);
      return {
        projectId: state.projectId,
        sourceLayout: 'maintenance',
        iterationId: 'maintenance',
        artifactRoot: state.artifactRoot,
        graphPath,
        graph,
        taskGraphRef: artifactRelativePath(state.artifactRoot, graphPath),
        sourceSpecRef: graph.sourceSpec,
        runsDir: resolveRunsDir(args),
      };
    }
    const graph = loadTaskGraph(state.taskGraphPath);
    return {
      projectId: state.projectId,
      sourceLayout: 'iteration',
      iterationId: state.activeIteration,
      artifactRoot: state.artifactRoot,
      graphPath: state.taskGraphPath,
      graph,
      taskGraphRef: artifactRelativePath(state.artifactRoot, state.taskGraphPath),
      sourceSpecRef: graph.sourceSpec,
      runsDir: resolveRunsDir(args),
    };
  }

  const graphPath = path.resolve(args.graph);
  const graph = loadTaskGraph(graphPath);
  return {
    projectId: graph.projectId,
    sourceLayout: 'graph',
    iterationId: graph.version ?? null,
    artifactRoot: null,
    graphPath,
    graph,
    taskGraphRef: displayPath(graphPath),
    sourceSpecRef: graph.sourceSpec,
    runsDir: resolveRunsDir(args),
  };
}

function assertSafeRunId(runId) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runId ?? '')) {
    throw new Error(`run id must match run-[A-Za-z0-9._-]+, got ${JSON.stringify(runId)}`);
  }
}

function generatedRunId(taskId, now = new Date()) {
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
  return `run-${timestamp}-${taskId}`;
}

function runPath(runsDir, runId) {
  assertSafeRunId(runId);
  return path.join(runsDir, `${runId}.json`);
}

function indexPath(runsDir) {
  return path.join(runsDir, 'run-index.json');
}

function emptyIndex(projectId) {
  return {
    schema_version: 'p2a.run_index.v1',
    projectId,
    runs: [],
    tasks: [],
  };
}

function loadIndex(runsDir, projectId = 'unknown') {
  const filePath = indexPath(runsDir);
  if (!existsSync(filePath)) return emptyIndex(projectId);
  const index = loadJson(filePath);
  validateRunIndexData(index);
  return index;
}

function runIndexEntry(run) {
  return {
    runId: run.runId,
    taskId: run.taskId,
    iterationId: run.iterationId,
    status: run.status,
    agentTool: run.agentTool,
    workspaceRef: run.workspaceRef,
    taskGraphRef: run.taskGraphRef,
    runRef: `${run.runId}.json`,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function rebuildTaskRunIndex(runs) {
  const tasks = [];
  const taskMapById = new Map();
  for (const run of runs) {
    if (!taskMapById.has(run.taskId)) {
      const entry = { taskId: run.taskId, runIds: [], latestRunId: null };
      taskMapById.set(run.taskId, entry);
      tasks.push(entry);
    }
    const taskEntry = taskMapById.get(run.taskId);
    taskEntry.runIds.push(run.runId);
    taskEntry.latestRunId = run.runId;
  }
  return tasks;
}

function writeIndex(runsDir, index) {
  index.tasks = rebuildTaskRunIndex(index.runs);
  validateRunIndexData(index);
  writeJson(indexPath(runsDir), index);
}

function upsertIndexRun(runsDir, run) {
  const index = loadIndex(runsDir, run.projectId);
  if (index.projectId === 'unknown') index.projectId = run.projectId;
  if (index.projectId !== run.projectId) {
    throw new Error(`run projectId ${run.projectId} does not match run-index projectId ${index.projectId}`);
  }
  const nextEntry = runIndexEntry(run);
  const existingIndex = index.runs.findIndex((entry) => entry.runId === run.runId);
  if (existingIndex === -1) index.runs.push(nextEntry);
  else index.runs[existingIndex] = nextEntry;
  writeIndex(runsDir, index);
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readRun(runsDir, runId) {
  const filePath = runPath(runsDir, runId);
  assertFile(filePath, runId);
  const run = loadJson(filePath);
  validateRunData(run);
  return run;
}

function writeRun(runsDir, run) {
  validateRunData(run);
  writeJson(runPath(runsDir, run.runId), run);
  upsertIndexRun(runsDir, run);
}

export function loadRunsForArtifactRoot(artifactRoot) {
  const runsDir = path.join(path.resolve(artifactRoot), 'runs');
  if (!existsSync(runsDir) || !lstatSync(runsDir).isDirectory()) return [];
  const indexFile = indexPath(runsDir);
  if (!existsSync(indexFile)) return [];
  const index = loadIndex(runsDir);
  return index.runs
    .map((run) => {
      try {
        return readRun(runsDir, run.runId);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function resolveWorkspacePath(args) {
  if (args.isolation === 'worktree' && args.worktree) return path.resolve(args.worktree);
  if (args.workspace) return path.resolve(args.workspace);
  return process.cwd();
}

function tail(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > OUTPUT_TAIL_LIMIT ? text.slice(-OUTPUT_TAIL_LIMIT) : text;
}

function gitResultToTail(result) {
  return tail([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'));
}

function gitCommandResult(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 });
}

function prepareIsolation(args, workspacePath, runId, taskId) {
  const mode = args.isolation;
  const branch = mode === 'none' ? args.branch : args.branch ?? `p2a/${taskId}-${runId}`;
  const worktree = args.worktree ? path.resolve(args.worktree) : null;
  const baseRef = mode === 'none' ? args.baseRef ?? null : args.baseRef;
  const isolation = {
    mode,
    branch: branch ?? null,
    worktree: worktree ? displayPath(worktree) : null,
    baseRef: baseRef ?? null,
    created: false,
    createCommand: null,
    createExitCode: null,
    createOutputTail: null,
  };

  if (!args.createIsolation) return isolation;
  if (mode === 'none') throw new Error('--create-isolation requires --isolation branch or worktree');
  if (mode === 'worktree' && !worktree) throw new Error('--isolation worktree requires --worktree');

  const gitArgs = mode === 'branch'
    ? ['switch', '-c', branch, baseRef]
    : ['worktree', 'add', '-b', branch, worktree, baseRef];
  const result = gitCommandResult(gitArgs, workspacePath);
  isolation.created = result.status === 0;
  isolation.createCommand = `git ${gitArgs.join(' ')}`;
  isolation.createExitCode = typeof result.status === 'number' ? result.status : 1;
  isolation.createOutputTail = gitResultToTail(result);
  if (result.status !== 0) {
    throw new Error(`git isolation creation failed (${isolation.createCommand}): ${isolation.createOutputTail}`);
  }
  return isolation;
}

function projectConfigCandidates(runsDir, run, workspacePath) {
  return uniqueStrings([
    path.join(path.dirname(runsDir), 'project.config.json'),
    path.join(workspacePath, '.plan2agent', 'project.config.json'),
    path.join(process.cwd(), '.plan2agent', 'project.config.json'),
    path.join(path.dirname(run.taskGraphRef), '..', 'project.config.json'),
  ]);
}

function loadProjectConfig(runsDir, run, workspacePath) {
  for (const candidate of projectConfigCandidates(runsDir, run, workspacePath)) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) return loadJson(candidate);
    } catch {
      // Ignore malformed optional config here; explicit verification commands still work.
    }
  }
  return {};
}

function configuredCommand(config, type) {
  if (type === 'test') return config.testCommand ?? null;
  if (type === 'lint') return config.lintCommand ?? null;
  if (type === 'typecheck') return config.typecheckCommand ?? null;
  return null;
}

function verificationSpecs(args, config) {
  const requests = [...args.verifyRequests];
  if (!requests.length) {
    for (const type of ['test', 'lint', 'typecheck']) {
      const command = configuredCommand(config, type);
      if (command) requests.push({ type, command, source: 'config' });
    }
  }
  if (!requests.length) throw new Error('no verification command requested and no configured test/lint/typecheck command found');

  return requests.map((request) => {
    const command = request.command ?? configuredCommand(config, request.type);
    if (!command) {
      return {
        type: request.type,
        command: `<missing ${request.type} command>`,
        status: 'skipped',
        exitCode: null,
        durationMs: null,
        startedAt: null,
        finishedAt: null,
        stdoutTail: null,
        stderrTail: `${request.type} command is not configured`,
        source: 'config',
      };
    }
    return { ...request, command };
  });
}

function runVerificationCommand(spec, workspacePath) {
  if (spec.status === 'skipped') return spec;
  const startedAt = new Date();
  const result = spawnSync(spec.command, {
    cwd: workspacePath,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });
  const finishedAt = new Date();
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return {
    type: spec.type,
    command: spec.command,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stdoutTail: tail(result.stdout),
    stderrTail: tail([result.stderr, result.error?.message].filter(Boolean).join('\n')),
    source: spec.source,
  };
}

function collectGitChangedFiles(workspacePath) {
  const result = gitCommandResult(['status', '--porcelain=v1'], workspacePath);
  if (result.status !== 0) {
    throw new Error(`git status failed while collecting changed files: ${gitResultToTail(result)}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const pathField = line.slice(3);
      const renamed = pathField.match(/^(.+?) -> (.+)$/);
      if (renamed) return renamed[2];
      return pathField.trim();
    })
    .filter(Boolean);
}

function hasFailureOptions(args) {
  return Boolean(args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource);
}

function assertFailureOptionsAllowed(args, status) {
  if (hasFailureOptions(args) && status !== 'failed' && status !== 'blocked') {
    throw new Error(`failure options are only valid when the run finishes as failed or blocked (got ${status})`);
  }
}

function buildFailure(args, status) {
  assertFailureOptionsAllowed(args, status);
  if (status !== 'failed' && status !== 'blocked') return null;
  if (!args.failureClass) {
    throw new Error(`--failure-class is required when finishing with status ${status}. Choose one of: ${[...FAILURE_CLASSES].join(', ')}`);
  }
  const defaults = FAILURE_DEFAULTS[args.failureClass];
  return {
    class: args.failureClass,
    retryable: args.retryable ?? defaults.retryable,
    needsUserDecision: args.needsUserDecision ?? defaults.needsUserDecision,
    source: args.failureSource ?? defaults.source,
  };
}

function deriveFinishStatus(run, requestedStatus) {
  if (requestedStatus) return requestedStatus;
  return run.verification.some((item) => item.status === 'failed') ? 'failed' : 'finished';
}

function startRun(args) {
  const source = resolveTaskSource(args);
  const task = requireTask(source.graph, args.taskId);
  const runsDir = source.runsDir;
  const now = new Date();
  const runId = args.runId ?? generatedRunId(task.id, now);
  assertSafeRunId(runId);
  if (existsSync(runPath(runsDir, runId))) throw new Error(`run already exists: ${runId}`);
  const workspacePath = resolveWorkspacePath(args);
  assertDirectory(workspacePath, '--workspace');
  const workspaceRef = args.workspaceRef ?? displayPath(workspacePath);
  const isolation = prepareIsolation(args, workspacePath, runId, task.id);
  const run = {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: source.projectId,
    taskId: task.id,
    taskTitle: task.title,
    iterationId: source.iterationId,
    sourceLayout: source.sourceLayout,
    taskGraphRef: source.taskGraphRef,
    sourceSpecRef: source.sourceSpecRef,
    agentTool: args.agentTool,
    workspaceRef,
    workspacePath: displayPath(workspacePath),
    isolation,
    status: 'started',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    changedFiles: uniqueStrings(args.changedFiles),
    verification: args.manualVerification,
    notes: uniqueStrings(args.notes),
  };
  writeRun(runsDir, run);
  console.log(`Plan2Agent run started: ${run.runId}`);
  console.log(`- task: ${run.taskId}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  console.log(`- runs: ${displayPath(runsDir)}`);
  return 0;
}

function recordRun(args) {
  const runsDir = resolveRunsDir(args);
  const run = readRun(runsDir, args.runId);
  run.changedFiles = uniqueStrings([...run.changedFiles, ...args.changedFiles]);
  run.verification.push(...args.manualVerification);
  run.notes = uniqueStrings([...run.notes, ...args.notes]);
  run.updatedAt = new Date().toISOString();
  writeRun(runsDir, run);
  console.log(`Plan2Agent run recorded: ${run.runId}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  return 0;
}

function verifyRun(args) {
  const runsDir = resolveRunsDir(args);
  const run = readRun(runsDir, args.runId);
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  assertDirectory(workspacePath, 'run workspace');
  const config = loadProjectConfig(runsDir, run, workspacePath);
  const specs = verificationSpecs(args, config);
  const results = specs.map((spec) => runVerificationCommand(spec, workspacePath));
  run.verification.push(...results);
  run.updatedAt = new Date().toISOString();
  writeRun(runsDir, run);
  console.log(`Plan2Agent run verification recorded: ${run.runId}`);
  for (const result of results) {
    console.log(`- ${result.type}: ${result.status} (${result.command})`);
  }
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}

function finishRun(args) {
  const runsDir = resolveRunsDir(args);
  const run = readRun(runsDir, args.runId);
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  const changedFiles = [...args.changedFiles];
  if (args.collectGit) changedFiles.push(...collectGitChangedFiles(workspacePath));
  run.changedFiles = uniqueStrings([...run.changedFiles, ...changedFiles]);
  run.notes = uniqueStrings([...run.notes, ...args.notes]);
  run.status = deriveFinishStatus(run, args.status);
  const failure = buildFailure(args, run.status);
  if (failure) run.failure = failure;
  else delete run.failure;
  const now = new Date().toISOString();
  run.updatedAt = now;
  run.finishedAt = now;
  writeRun(runsDir, run);
  console.log(`Plan2Agent run finished: ${run.runId}`);
  console.log(`- status: ${run.status}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  return run.status === 'failed' ? 1 : 0;
}

function verificationSummary(run) {
  if (!run.verification.length) return '-';
  const counts = { passed: 0, failed: 0, skipped: 0, not_run: 0 };
  for (const item of run.verification) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}:${count}`)
    .join(',');
}

function listRuns(args) {
  const runsDir = resolveRunsDir(args);
  const index = loadIndex(runsDir, path.basename(path.dirname(runsDir)));
  if (args.json) {
    console.log(JSON.stringify(index, null, 2));
    return 0;
  }
  console.log('runId\ttaskId\tstatus\tagentTool\tworkspaceRef\tverification\tfinishedAt');
  for (const entry of index.runs) {
    const run = existsSync(runPath(runsDir, entry.runId)) ? readRun(runsDir, entry.runId) : null;
    console.log(`${entry.runId}\t${entry.taskId}\t${entry.status}\t${entry.agentTool}\t${entry.workspaceRef}\t${run ? verificationSummary(run) : '-'}\t${entry.finishedAt ?? '-'}`);
  }
  return 0;
}

function showRun(args) {
  const run = readRun(resolveRunsDir(args), args.runId);
  console.log(JSON.stringify(run, null, 2));
  return 0;
}

function validateRuns(args) {
  const runsDir = resolveRunsDir(args);
  if (args.runId) {
    validateRunData(readRun(runsDir, args.runId));
    console.log(`Plan2Agent run validation passed: ${args.runId}`);
  } else {
    validateRunsDir(runsDir);
    console.log(`Plan2Agent runs validation passed: ${displayPath(runsDir)}`);
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'start') return startRun(args);
    if (args.command === 'record') return recordRun(args);
    if (args.command === 'verify') return verifyRun(args);
    if (args.command === 'finish') return finishRun(args);
    if (args.command === 'list') return listRuns(args);
    if (args.command === 'show') return showRun(args);
    if (args.command === 'validate') return validateRuns(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'p2a run validation failed' : 'p2a run command failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
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
