#!/usr/bin/env node
/** Track Plan2Agent agent execution runs without mutating the task graph schema. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FAILURE_CLASSES, FAILURE_RETRYABLE, ISOLATION_MODES } from './p2a_constants.mjs';
import {
  loadJson,
  validateRunData,
  validateRunIndexData,
  validateRunsDir,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import { normalizeMonitorGateSidecar, normalizeMonitorVerdictData, readMonitorGateSidecar } from './p2a_monitor_gate.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import {
  assertUnmanagedGraphMutation,
  assertRunIndexCanInitialize,
  assertSafeRunId,
  assertStartableRunId,
  canonicalTaskGraphRef,
  canonicalRunRef,
  DEFAULT_RUNS_DIR,
  indexedRunRef,
  legacyRunRef,
  legacyRunsDirForGraph,
  resolveRunsDir,
  RUN_SIDECAR_SUFFIXES,
  runFilePath,
  runSidecarPath,
  runSidecarRef,
  taskGraphRefMatchesGraph,
  unindexedRunRecordRefs,
} from './p2a_run_paths.mjs';
import {
  assertNoPendingRunMigration,
  atomicWriteJson,
  atomicWriteText,
  migrationJournalPath,
  RUN_STORE_LOCK_FILE,
  RUN_STORE_REAPER_LOCK_FILE,
  RUN_STORE_REDIRECT_FILE,
  runWriteTransactionPath,
  writeRunStoreRedirect,
  withRunStoreLocks,
} from './p2a_run_store.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  P2A_PROJECT_CONFIG,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  RUN_ID_RESERVATION_DIR,
  allocateRunId,
  assertRunIdReservationOwnership,
  detectProjectCommands,
  mergeDetectedProjectConfig,
  mergeExplicitVerificationCommands,
  releaseRunIdReservation,
  runIdReservationIsActive,
  writeProjectConfig,
} from './p2a_project_config.mjs';
import { commandLine as sharedCommandLine, printRunCommandFooter } from './p2a_run_commands.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const COMMANDS = new Set(['start', 'record', 'verify', 'finish', 'list', 'show', 'validate', 'migrate-layout']);
const RUN_STATUSES = new Set(['started', 'finished', 'failed', 'blocked']);
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
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'skipped', 'not_run', 'unavailable']);
const OUTPUT_TAIL_LIMIT = 4000;
function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_runs.mjs start --artifacts <iterative-project-dir> --task <task-id> --agent-tool <tool> [options]',
    '  node .plan2agent/scripts/p2a_runs.mjs start --graph <task-graph.json> --task <task-id> --agent-tool <tool> [--runs <dir>] [options]',
    '  node .plan2agent/scripts/p2a_runs.mjs record --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--changed-file <path> ...] [--verification <type:status:command>] [--note <text>] [structured detail options]',
    '  node .plan2agent/scripts/p2a_runs.mjs verify --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--test] [--lint] [--typecheck] [--test-command <cmd>] [--lint-command <cmd>] [--typecheck-command <cmd>] [--verify-command <type:cmd>]',
    '  node .plan2agent/scripts/p2a_runs.mjs finish --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--status finished|failed|blocked] [--failure-class <class>] [--retryable yes|no|after_fix] [--needs-user-decision true|false] [--failure-source owner|monitor|implementer] [--changed-file <path> ...] [--verification <type:status:command>] [--collect-git] [--note <text>] [structured detail options]',
    '  node .plan2agent/scripts/p2a_runs.mjs list (--artifacts <dir>|--runs <dir>|--graph <path>) [--json]',
    '  node .plan2agent/scripts/p2a_runs.mjs show --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>)',
    '  node .plan2agent/scripts/p2a_runs.mjs validate (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>]',
    '  node .plan2agent/scripts/p2a_runs.mjs migrate-layout (--artifacts <dir>|--runs <dir>|--graph <path>) [--dry-run] --yes',
    '',
    'Options:',
    '  --artifacts <dir>       Iterative artifact root; writes runs/ under that root.',
    '  --graph <path>          Legacy task graph path. Managed iteration graph mutations require --artifacts.',
    '  --runs <dir>            Explicit runs directory containing run-index.json and run files.',
    '  --maintenance           With --artifacts, use the maintenance task graph as source context.',
    '  --task <task-id>        Task id for start.',
    '  --run-id <run-id>       Stable run id. Must start with run-. Generated for start when omitted.',
    '  --run-reservation-token <token>  Reservation owner token emitted by a failed sequential start retry.',
    '  --agent-tool <tool>     Agent/CLI tool that performed the run, such as codex, claude, gemini.',
    '  --workspace <dir>       Workspace path for verification commands. Defaults to cwd or --worktree.',
    '  --workspace-ref <ref>   Human-readable workspace reference. Defaults to --workspace display path.',
    '  --isolation <mode>      none, branch, or worktree. Default: none.',
    '  --branch <name>         Branch name to record or create for branch/worktree isolation.',
    '  --worktree <path>       Worktree path to record or create for worktree isolation.',
    '  --base-ref <ref>        Git base ref for --create-isolation. Default: HEAD.',
    '  --create-isolation      Create the branch/worktree with git before writing the run record.',
    '  --require-monitor       Require the run\'s co-located .monitor-verdict.json before a finished run can close.',
    '  --changed-file <path>   Changed file to attach to the run. Repeatable.',
    '  --collect-git           Add changed files from git status in the workspace.',
    '  --note <text>           Append a run note. Repeatable.',
    '  --repro-step <text>     Append a structured reproduction step. Repeatable.',
    '  --repro-command <cmd>   Append a command that reproduces the observed issue. Repeatable.',
    '  --repro-note <text>     Append reproduction context. Repeatable.',
    '  --localization <text>   Append a problem localization finding. Repeatable.',
    '  --localized-file <path> Append a file implicated by localization. Repeatable.',
    '  --fix-summary <text>    Append a concise summary of the fix. Repeatable.',
    '  --fix-file <path>       Append a file intentionally changed by the fix. Repeatable.',
    '  --guard <text>          Append a recurrence guard or verification check. Repeatable.',
    '  --guard-note <text>     Append guard context. Repeatable.',
    '  --failure-class <class> Failure class for failed/blocked finish. One of: verification_failed, test_flake, scope_violation, missing_dependency, environment_failure, implementation_incomplete, other.',
    '  --retryable <value>     Override failure retryability: yes, no, after_fix.',
    '  --needs-user-decision <true|false>',
    '                          Override whether the failure needs a user decision.',
    '  --failure-source <src>  Override failure source: owner, monitor, implementer.',
    '  --verification <type:status:command>',
    '                          Manually record supplemental verification. Manual passed records do not satisfy finished/done guards.',
    '  --test, --lint, --typecheck',
    '                          Run configured command from .plan2agent/project.config.json.',
    '  --test-command <cmd>, --lint-command <cmd>, --typecheck-command <cmd>',
    '                          Run an explicit verification command.',
    '  --verify-command <type:cmd>',
    '                          Run a custom command; type is optional and defaults to custom.',
    '  --save-config           Persist detected or explicit test/lint/typecheck commands to project.config.json.',
    '  --json                  Machine-readable output for list.',
    '  --dry-run               Preview run partitioning and legacy per-iteration index consolidation.',
    '  --yes                   Confirm migrate-layout file moves, index merge, and legacy index removal.',
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
    runReservationToken: null,
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
    reproductionSteps: [],
    reproductionCommands: [],
    reproductionNotes: [],
    localizationFindings: [],
    localizedFiles: [],
    fixSummaries: [],
    fixFiles: [],
    guardChecks: [],
    guardNotes: [],
    manualVerification: [],
    verifyRequests: [],
    status: null,
    failureClass: null,
    retryable: null,
    needsUserDecision: null,
    failureSource: null,
    collectGit: false,
    saveConfig: false,
    requireMonitor: false,
    json: false,
    dryRun: false,
    yes: false,
    help: false,
    originalArgv: [...argv],
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
    else if (arg === '--run-reservation-token') args.runReservationToken = requiredValue(argv, ++index, '--run-reservation-token');
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
    else if (arg === '--require-monitor') args.requireMonitor = true;
    else if (arg === '--changed-file') args.changedFiles.push(requiredValue(argv, ++index, '--changed-file'));
    else if (arg === '--collect-git') args.collectGit = true;
    else if (arg === '--note') args.notes.push(requiredValue(argv, ++index, '--note', { allowLeadingDash: true }));
    else if (arg === '--repro-step') args.reproductionSteps.push(requiredValue(argv, ++index, '--repro-step', { allowLeadingDash: true }));
    else if (arg === '--repro-command') args.reproductionCommands.push(requiredValue(argv, ++index, '--repro-command', { allowLeadingDash: true }));
    else if (arg === '--repro-note') args.reproductionNotes.push(requiredValue(argv, ++index, '--repro-note', { allowLeadingDash: true }));
    else if (arg === '--localization') args.localizationFindings.push(requiredValue(argv, ++index, '--localization', { allowLeadingDash: true }));
    else if (arg === '--localized-file') args.localizedFiles.push(requiredValue(argv, ++index, '--localized-file'));
    else if (arg === '--fix-summary') args.fixSummaries.push(requiredValue(argv, ++index, '--fix-summary', { allowLeadingDash: true }));
    else if (arg === '--fix-file') args.fixFiles.push(requiredValue(argv, ++index, '--fix-file'));
    else if (arg === '--guard') args.guardChecks.push(requiredValue(argv, ++index, '--guard', { allowLeadingDash: true }));
    else if (arg === '--guard-note') args.guardNotes.push(requiredValue(argv, ++index, '--guard-note', { allowLeadingDash: true }));
    else if (arg === '--verification') args.manualVerification.push(parseManualVerification(requiredValue(argv, ++index, '--verification')));
    else if (arg === '--test') args.verifyRequests.push({ type: 'test', command: null, source: 'config' });
    else if (arg === '--lint') args.verifyRequests.push({ type: 'lint', command: null, source: 'config' });
    else if (arg === '--typecheck') args.verifyRequests.push({ type: 'typecheck', command: null, source: 'config' });
    else if (arg === '--test-command') args.verifyRequests.push({ type: 'test', command: requiredValue(argv, ++index, '--test-command', { allowLeadingDash: true }), source: 'command' });
    else if (arg === '--lint-command') args.verifyRequests.push({ type: 'lint', command: requiredValue(argv, ++index, '--lint-command', { allowLeadingDash: true }), source: 'command' });
    else if (arg === '--typecheck-command') args.verifyRequests.push({ type: 'typecheck', command: requiredValue(argv, ++index, '--typecheck-command', { allowLeadingDash: true }), source: 'command' });
    else if (arg === '--verify-command') args.verifyRequests.push(parseVerifyCommand(requiredValue(argv, ++index, '--verify-command', { allowLeadingDash: true })));
    else if (arg === '--save-config') args.saveConfig = true;
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
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes') args.yes = true;
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
  if (args.graph && ['start', 'record', 'verify', 'finish'].includes(args.command)) {
    assertUnmanagedGraphMutation(args.graph, `p2a_runs ${args.command}`);
  }
  if (args.command === 'start') {
    if (!args.taskId) throw new Error('--task is required for start');
    if (!args.agentTool) throw new Error('--agent-tool is required for start');
    if (args.runs && !args.graph && !args.artifacts) throw new Error('start requires --artifacts or --graph so the task can be resolved');
  }
  if (args.command !== 'finish' && (args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource)) {
    throw new Error('failure options are only supported with finish');
  }
  if (!['record', 'finish'].includes(args.command) && hasStructuredDetailOptions(args)) {
    throw new Error('structured detail options are only supported with record or finish');
  }
  if (args.saveConfig && args.command !== 'verify') {
    throw new Error('--save-config is only supported with verify');
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
  if (args.runReservationToken && (args.command !== 'start' || !args.runId)) {
    throw new Error('--run-reservation-token requires start with --run-id');
  }
  if ((args.dryRun || args.yes) && args.command !== 'migrate-layout') {
    throw new Error('--dry-run and --yes are only supported with migrate-layout');
  }
  if (args.command === 'migrate-layout' && !args.dryRun && !args.yes) {
    throw new Error('migrate-layout requires --yes, or use --dry-run to preview');
  }
  return args;
}

function hasStructuredDetailOptions(args) {
  return [
    args.reproductionSteps,
    args.reproductionCommands,
    args.reproductionNotes,
    args.localizationFindings,
    args.localizedFiles,
    args.fixSummaries,
    args.fixFiles,
    args.guardChecks,
    args.guardNotes,
  ].some((values) => values.length > 0);
}

function requiredValue(argv, index, optionName, options = {}) {
  const value = argv[index];
  if (!value || (!options.allowLeadingDash && value.startsWith('--'))) throw new Error(`missing value for ${optionName}`);
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

function taskGraphFingerprint(graph) {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}

function assertStartTaskGraphUnchanged(source, expectedFingerprint, runId) {
  let currentGraph;
  try {
    currentGraph = loadTaskGraph(source.graphPath);
  } catch (error) {
    throw new Error(
      `task graph changed or became unavailable while run ${runId} was preparing isolation; no run was written: ${error.message}`,
    );
  }
  if (taskGraphFingerprint(currentGraph) !== expectedFingerprint) {
    throw new Error(
      `task graph changed while run ${runId} was preparing isolation; no run was written. Re-read the task graph and start the task again.`,
    );
  }
}

function readOrchestrationSidecar(runsDir, runId) {
  return readMonitorGateSidecar(runsDir, runId);
}

function readMonitorVerdict(runsDir, sidecar) {
  if (!sidecar?.required) return null;
  const verdictPath = path.resolve(runsDir, sidecar.verdictPath);
  assertFile(verdictPath, 'monitor verdict');
  try {
    return normalizeMonitorVerdictData(loadJson(verdictPath));
  } catch (error) {
    throw new Error(`${error.message}: ${displayPath(verdictPath)}`);
  }
}

function monitorConcernSummary(verdict) {
  const parts = [];
  for (const field of verdict.concernFields ?? []) {
    const values = verdict.concerns?.[field] ?? [];
    if (values.length) parts.push(`${field}=${values.join(' | ')}`);
  }
  if (verdict.note) parts.push(`note=${verdict.note}`);
  return parts.join('; ') || 'no concern details provided';
}

function applyMonitorGate(args, runsDir, run) {
  const sidecar = readOrchestrationSidecar(runsDir, run.runId);
  if (!sidecar?.required) return null;
  const verdict = readMonitorVerdict(runsDir, sidecar);
  if (sidecar.acceptedVerdicts.includes(verdict.verdict) && !verdict.hasConcerns) {
    return { accepted: true, verdict: verdict.verdict, concerns: monitorConcernSummary(verdict) };
  }
  const mappedFailureClass = sidecar.failureClassMap[verdict.failureSignal]
    ?? sidecar.failureClassMap[verdict.verdict]
    ?? 'other';
  args.status = 'blocked';
  if (!args.failureClass) args.failureClass = mappedFailureClass;
  if (!args.failureSource) args.failureSource = 'monitor';
  if (args.needsUserDecision === null && verdict.needsUserDecision) args.needsUserDecision = true;
  return {
    accepted: false,
    verdict: verdict.failureSignal,
    rawVerdict: verdict.verdict,
    failureClass: args.failureClass,
    concerns: monitorConcernSummary(verdict),
  };
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
    taskGraphRef: canonicalTaskGraphRef(graphPath),
    sourceSpecRef: graph.sourceSpec,
    runsDir: resolveRunsDir(args),
  };
}

function runMatchesSourceContext(run, source) {
  return run.projectId === source.projectId
    && run.iterationId === source.iterationId
    && run.sourceLayout === source.sourceLayout
    && taskGraphRefMatchesGraph(run.taskGraphRef, source.graphPath, source.artifactRoot);
}

function assertRunMatchesSourceContext(run, source) {
  if (runMatchesSourceContext(run, source)) return;
  throw new Error(
    `run ${run.runId} is outside the current run context: expected ${source.sourceLayout} `
    + `iteration ${source.iterationId ?? 'null'} for ${source.taskGraphRef}`,
  );
}

function mutationSource(args) {
  return args.artifacts || args.graph ? resolveTaskSource(args) : null;
}

function sourceRunArgs(args) {
  if (args.artifacts) return ['--artifacts', args.artifacts, ...(args.maintenance ? ['--maintenance'] : [])];
  if (args.graph) return ['--graph', args.graph];
  return null;
}

function runLifecycleSourceArgs(args) {
  return sourceRunArgs(args) ?? (args.runs ? ['--runs', args.runs] : null);
}

function orchestrationSidecarPath(runsDir, runId) {
  assertSafeRunId(runId);
  return runSidecarPath(runsDir, runId, '.orchestration.json');
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

function runIndexEntry(run, runRef = canonicalRunRef(run)) {
  return {
    runId: run.runId,
    taskId: run.taskId,
    iterationId: run.iterationId,
    status: run.status,
    agentTool: run.agentTool,
    workspaceRef: run.workspaceRef,
    taskGraphRef: run.taskGraphRef,
    runRef,
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
  atomicWriteJson(indexPath(runsDir), index);
}

function upsertIndexRun(runsDir, index, run, preferredRunRef = null) {
  if (index.projectId === 'unknown') index.projectId = run.projectId;
  if (index.projectId !== run.projectId) {
    throw new Error(`run projectId ${run.projectId} does not match run-index projectId ${index.projectId}`);
  }
  const existingIndex = index.runs.findIndex((entry) => entry.runId === run.runId);
  const runRef = existingIndex === -1
    ? (preferredRunRef ?? canonicalRunRef(run))
    : indexedRunRef(runsDir, run.runId, index);
  const nextEntry = runIndexEntry(run, runRef);
  if (existingIndex === -1) index.runs.push(nextEntry);
  else index.runs[existingIndex] = nextEntry;
}

function writeJson(filePath, data) {
  atomicWriteJson(filePath, data);
}

export function readRun(runsDir, runId) {
  const filePath = runFilePath(runsDir, runId);
  assertFile(filePath, runId);
  const run = loadJson(filePath);
  validateRunData(run);
  return run;
}

function runWriteJournalPath(runsDir) {
  return runWriteTransactionPath(runsDir);
}

function completeRunWriteTransaction(runsDir, transaction) {
  if (transaction?.schema_version !== 'p2a.run_write_transaction.v1') {
    throw new Error(`invalid pending run write transaction in ${runWriteJournalPath(runsDir)}`);
  }
  validateRunData(transaction.run);
  validateRunIndexData(transaction.index);
  const entry = transaction.index.runs.find((candidate) => candidate.runId === transaction.run.runId);
  if (!entry || entry.runRef !== transaction.runRef || transaction.index.projectId !== transaction.run.projectId) {
    throw new Error(`pending run write transaction does not match run ${transaction.run.runId}`);
  }
  for (const field of ['runId', 'taskId', 'iterationId', 'status', 'agentTool', 'workspaceRef', 'taskGraphRef', 'startedAt', 'finishedAt']) {
    if (JSON.stringify(entry[field]) !== JSON.stringify(transaction.run[field])) {
      throw new Error(`pending run write transaction index ${field} does not match run ${transaction.run.runId}`);
    }
  }
  const expectedRef = entry.runRef;
  if (![legacyRunRef(transaction.run.runId), canonicalRunRef(transaction.run)].includes(expectedRef)) {
    throw new Error(`pending run write transaction has unsupported runRef ${JSON.stringify(expectedRef)}`);
  }
  if (transaction.monitorGate !== undefined) {
    assertNoIndexedRunSidecarCollision(runsDir, transaction.index, transaction.run.runId, transaction.runRef, '.monitor-gate.json');
  }
  atomicWriteJson(path.join(runsDir, expectedRef), transaction.run);
  atomicWriteJson(indexPath(runsDir), transaction.index);
  if (transaction.monitorGate !== undefined) {
    const monitorGate = normalizeMonitorGateSidecar(transaction.monitorGate, transaction.run.runId, transaction.runRef);
    const expectedVerdictRef = runSidecarRef(transaction.runRef, '.monitor-verdict.json');
    if (monitorGate.runId !== transaction.run.runId
      || monitorGate.required !== true
      || monitorGate.verdictPath !== expectedVerdictRef) {
      throw new Error(`pending run write transaction has an invalid monitor gate for ${transaction.run.runId}`);
    }
    atomicWriteJson(path.join(runsDir, runSidecarRef(transaction.runRef, '.monitor-gate.json')), monitorGate);
  }
  if (transaction.reservation !== undefined) {
    if (transaction.reservation?.runId !== transaction.run.runId
      || typeof transaction.reservation?.token !== 'string'
      || !transaction.reservation.token) {
      throw new Error(`pending run write transaction has an invalid reservation for ${transaction.run.runId}`);
    }
    releaseRunIdReservation(runsDir, transaction.run.runId, transaction.reservation.token);
  }
  unlinkSync(runWriteJournalPath(runsDir));
}

function recoverPendingRunWrite(runsDir) {
  const journalPath = runWriteJournalPath(runsDir);
  if (!existsSync(journalPath)) return false;
  completeRunWriteTransaction(runsDir, JSON.parse(readFileSync(journalPath, 'utf8')));
  return true;
}

function assertNoIndexedRunSidecarCollision(runsDir, index, runId, runRef, suffix) {
  const sidecarRef = runSidecarRef(runRef, suffix);
  const conflictingRun = index.runs.find((entry) => (
    entry.runId !== runId
    && indexedRunRef(runsDir, entry.runId, index) === sidecarRef
  ));
  if (conflictingRun) {
    throw new Error(
      `sidecar path ${sidecarRef} for ${runId} collides with indexed run ${conflictingRun.runId}; `
      + 'rename or migrate the conflicting legacy run before creating this sidecar',
    );
  }
  return sidecarRef;
}

function commitRunWrite(runsDir, runRef, run, index, options = {}) {
  index.tasks = rebuildTaskRunIndex(index.runs);
  validateRunIndexData(index);
  if (options.monitorGateRequired) {
    const sidecarRef = assertNoIndexedRunSidecarCollision(runsDir, index, run.runId, runRef, '.monitor-gate.json');
    if (existsSync(path.join(runsDir, sidecarRef))) {
      throw new Error(`monitor gate sidecar path already exists and cannot be overwritten: ${sidecarRef}`);
    }
  }
  const transaction = {
    schema_version: 'p2a.run_write_transaction.v1',
    runRef,
    run,
    index,
  };
  if (options.monitorGateRequired) {
    transaction.monitorGate = normalizeMonitorGateSidecar({ required: true }, run.runId, runRef);
  }
  if (options.reservationToken) {
    transaction.reservation = { runId: run.runId, token: options.reservationToken };
  }
  atomicWriteJson(runWriteJournalPath(runsDir), transaction);
  completeRunWriteTransaction(runsDir, transaction);
}

function readRunForUpdate(runsDir, runId) {
  return withRunStoreLocks([runsDir], () => {
    assertNoPendingRunMigration(runsDir);
    recoverPendingRunWrite(runsDir);
    const run = readRun(runsDir, runId);
    return { run, expectedRun: JSON.stringify(run) };
  });
}

function writeRun(runsDir, run, options = {}) {
  validateRunData(run);
  return withRunStoreLocks([runsDir], () => {
    assertNoPendingRunMigration(runsDir);
    recoverPendingRunWrite(runsDir);
    const index = loadIndex(runsDir, run.projectId);
    const existing = index.runs.find((entry) => entry.runId === run.runId);
    const legacyRef = legacyRunRef(run.runId);
    const canonicalRef = canonicalRunRef(run);
    const existingUnindexedRef = existsSync(path.join(runsDir, legacyRef))
      ? legacyRef
      : (existsSync(path.join(runsDir, canonicalRef)) ? canonicalRef : null);
    if (options.createOnly) assertRunIndexCanInitialize(runsDir);
    if (!existsSync(indexPath(runsDir))) {
      const unindexedRefs = unindexedRunRecordRefs(runsDir);
      const hasOtherRunRecords = unindexedRefs.some((ref) => ref !== existingUnindexedRef);
      if (!existingUnindexedRef || hasOtherRunRecords) {
        assertRunIndexCanInitialize(runsDir);
      }
    }
    if (options.createOnly && (
      existing
      || existingUnindexedRef
    )) {
      throw new Error(`run already exists: ${run.runId}`);
    }
    if (options.expectedRun !== undefined) {
      const currentRef = existing ? indexedRunRef(runsDir, run.runId, index) : existingUnindexedRef;
      if (!currentRef) throw new Error(`run ${run.runId} changed concurrently; retry the command`);
      const current = loadJson(path.join(runsDir, currentRef));
      if (JSON.stringify(current) !== options.expectedRun) {
        throw new Error(`run ${run.runId} changed concurrently; retry the command`);
      }
    }
    const runRef = existing
      ? indexedRunRef(runsDir, run.runId, index)
      : (existingUnindexedRef ?? canonicalRef);
    upsertIndexRun(runsDir, index, run, runRef);
    commitRunWrite(runsDir, runRef, run, index, options);
  });
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

function mergeDetailArray(existing, additions) {
  return uniqueStrings([...(Array.isArray(existing) ? existing : []), ...additions]);
}

function maybeDeleteEmptyRunDetail(run, key, fields) {
  const detail = run[key];
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  const hasValue = fields.some((field) => Array.isArray(detail[field]) && detail[field].length > 0);
  if (!hasValue) delete run[key];
}

function mergeStructuredRunDetails(run, args) {
  if (!hasStructuredDetailOptions(args)) return;
  if (args.reproductionSteps.length || args.reproductionCommands.length || args.reproductionNotes.length || run.reproduction) {
    const existing = run.reproduction && typeof run.reproduction === 'object' && !Array.isArray(run.reproduction)
      ? run.reproduction
      : {};
    run.reproduction = {
      steps: mergeDetailArray(existing.steps, args.reproductionSteps),
      commands: mergeDetailArray(existing.commands, args.reproductionCommands),
      notes: mergeDetailArray(existing.notes, args.reproductionNotes),
    };
    maybeDeleteEmptyRunDetail(run, 'reproduction', ['steps', 'commands', 'notes']);
  }
  if (args.localizationFindings.length || args.localizedFiles.length || run.localization) {
    const existing = run.localization && typeof run.localization === 'object' && !Array.isArray(run.localization)
      ? run.localization
      : {};
    run.localization = {
      findings: mergeDetailArray(existing.findings, args.localizationFindings),
      files: mergeDetailArray(existing.files, args.localizedFiles),
    };
    maybeDeleteEmptyRunDetail(run, 'localization', ['findings', 'files']);
  }
  if (args.fixSummaries.length || args.fixFiles.length || run.fixSummary) {
    const existing = run.fixSummary && typeof run.fixSummary === 'object' && !Array.isArray(run.fixSummary)
      ? run.fixSummary
      : {};
    run.fixSummary = {
      summaries: mergeDetailArray(existing.summaries, args.fixSummaries),
      files: mergeDetailArray(existing.files, args.fixFiles),
    };
    maybeDeleteEmptyRunDetail(run, 'fixSummary', ['summaries', 'files']);
  }
  if (args.guardChecks.length || args.guardNotes.length || run.guard) {
    const existing = run.guard && typeof run.guard === 'object' && !Array.isArray(run.guard)
      ? run.guard
      : {};
    run.guard = {
      checks: mergeDetailArray(existing.checks, args.guardChecks),
      notes: mergeDetailArray(existing.notes, args.guardNotes),
    };
    maybeDeleteEmptyRunDetail(run, 'guard', ['checks', 'notes']);
  }
}

function resolveWorkspacePath(args) {
  if (args.isolation === 'worktree' && args.worktree) return path.resolve(args.worktree);
  if (args.workspace) return path.resolve(args.workspace);
  return process.cwd();
}

function resolveIsolationBasePath(args, workspacePath) {
  if (!(args.createIsolation && args.isolation === 'worktree')) return workspacePath;
  const workspaceArg = args.workspace ? path.resolve(args.workspace) : null;
  const worktree = args.worktree ? path.resolve(args.worktree) : null;
  if (workspaceArg && workspaceArg !== worktree) return workspaceArg;
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

function gitBranchName(cwd) {
  const result = gitCommandResult(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitLocalBranchExists(cwd, branch) {
  return gitCommandResult(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd).status === 0;
}

function reusedIsolation(isolation, command, detail) {
  isolation.created = true;
  isolation.createCommand = command;
  isolation.createExitCode = 0;
  isolation.createOutputTail = detail;
  return isolation;
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

  let gitArgs;
  if (mode === 'branch') {
    if (gitBranchName(workspacePath) === branch) {
      return reusedIsolation(isolation, `git switch ${branch}`, `reused existing branch ${branch}`);
    }
    gitArgs = gitLocalBranchExists(workspacePath, branch)
      ? ['switch', branch]
      : ['switch', '-c', branch, baseRef];
  } else {
    if (existsSync(worktree)) {
      if (lstatSync(worktree).isDirectory() && gitBranchName(worktree) === branch) {
        return reusedIsolation(isolation, `git worktree reuse ${worktree} ${branch}`, `reused existing worktree ${worktree} on ${branch}`);
      }
      throw new Error(`worktree path already exists but is not the reserved branch ${branch}: ${worktree}`);
    }
    gitArgs = gitLocalBranchExists(workspacePath, branch)
      ? ['worktree', 'add', worktree, branch]
      : ['worktree', 'add', '-b', branch, worktree, baseRef];
  }
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
  return loadProjectConfigWithPath(runsDir, run, workspacePath).config;
}

function loadProjectConfigWithPath(runsDir, run, workspacePath) {
  const candidates = projectConfigCandidates(runsDir, run, workspacePath);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      if (!lstatSync(candidate).isFile()) continue;
      return { config: loadJson(candidate), path: candidate };
    } catch (error) {
      throw new Error(`project config is malformed: ${displayPath(candidate)} (${error.message}). Fix or remove it before automatic command detection.`);
    }
  }
  const workspaceConfig = path.join(workspacePath, P2A_PROJECT_CONFIG);
  const fallbackPath = existsSync(path.dirname(workspaceConfig)) ? workspaceConfig : null;
  return { config: {}, path: fallbackPath };
}

function loadStartProjectConfig(runsDir, source, workspacePath) {
  return loadProjectConfigWithPath(runsDir, { taskGraphRef: source.taskGraphRef }, workspacePath).config;
}

function setOptionValue(argv, option, value) {
  const optionIndex = argv.indexOf(option);
  if (optionIndex === -1) argv.push(option, value);
  else argv[optionIndex + 1] = value;
}

function startRetryCommand(args, runId, reservationToken = null) {
  const retryArgs = [...args.originalArgv];
  setOptionValue(retryArgs, '--run-id', runId);
  if (reservationToken) setOptionValue(retryArgs, '--run-reservation-token', reservationToken);
  return sharedCommandLine(P2A_PATHS, 'p2a_runs.mjs', retryArgs);
}

function configuredCommand(config, type) {
  if (type === 'test') return config.testCommand ?? null;
  if (type === 'lint') return config.lintCommand ?? null;
  if (type === 'typecheck') return config.typecheckCommand ?? null;
  return null;
}

function hasShellMetacharactersAfterFirstToken(command, tokenEnd) {
  const rest = command.slice(tokenEnd);
  return /[&|;<>()`$*?{}\[\]]/.test(rest) || /\n|\r/.test(rest);
}

export function splitFirstCommandToken(command) {
  if (typeof command !== 'string') return null;
  let index = 0;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  if (index >= command.length) return null;
  const quote = command[index] === '"' || command[index] === "'" ? command[index] : null;
  const tokenStart = index;
  let token = '';
  if (quote) {
    index += 1;
    while (index < command.length) {
      const ch = command[index];
      if (ch === quote) return { token, start: tokenStart, end: index + 1, quoted: quote };
      token += ch;
      index += 1;
    }
    return null;
  }
  while (index < command.length && !/\s/.test(command[index])) {
    token += command[index];
    index += 1;
  }
  return { token, start: tokenStart, end: index, quoted: null };
}

function existingFile(candidate) {
  try {
    return existsSync(candidate) && lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function launcherCandidates(token, workspacePath, platform) {
  const roots = path.isAbsolute(token) ? [''] : [workspacePath, ROOT];
  const candidates = [];
  for (const root of roots) {
    const base = path.resolve(root || path.parse(token).root, root ? token : token);
    if (platform === 'win32') {
      candidates.push(`${base}.bat`, `${base}.cmd`);
    }
    candidates.push(base);
  }
  return candidates;
}

export function normalizeProjectLocalLauncherCommand(command, workspacePath, options = {}) {
  const platform = options.platform ?? process.env.P2A_VERIFY_PLATFORM ?? process.platform;
  const first = splitFirstCommandToken(command);
  if (!first || !first.token || hasShellMetacharactersAfterFirstToken(command, first.end)) {
    return { command, normalized: false, reason: 'complex_command' };
  }
  const isLocalLike = first.token.startsWith('.') || first.token.includes('/') || first.token.includes('\\') || path.isAbsolute(first.token);
  if (!isLocalLike) return { command, normalized: false, reason: 'not_project_local' };
  for (const candidate of launcherCandidates(first.token, workspacePath, platform)) {
    if (!existingFile(candidate)) continue;
    const absolute = path.resolve(candidate);
    const replacement = first.quoted ? `${first.quoted}${absolute}${first.quoted}` : `"${absolute}"`;
    return {
      command: `${command.slice(0, first.start)}${replacement}${command.slice(first.end)}`,
      normalized: true,
      originalToken: first.token,
      normalizedToken: absolute,
    };
  }
  return { command, normalized: false, reason: 'not_found' };
}

const WINDOWS_CMD_BUILTINS = new Set([
  'assoc', 'break', 'call', 'cd', 'chcp', 'chdir', 'cls', 'color', 'copy', 'date',
  'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto', 'if',
  'md', 'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd',
  'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift', 'start', 'time',
  'title', 'type', 'ver', 'verify', 'vol',
]);

function hasWindowsPathSeparator(token) {
  return token.includes('/') || token.includes('\\');
}

function pathextCandidates(token, env) {
  const rawPathext = env?.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const extensions = rawPathext.split(';').map((ext) => ext.trim()).filter(Boolean);
  const lowerToken = token.toLowerCase();
  const hasKnownExtension = extensions.some((ext) => lowerToken.endsWith(ext.toLowerCase()));
  return hasKnownExtension ? [token] : [token, ...extensions.map((ext) => `${token}${ext}`)];
}

function windowsPathEntries(env) {
  const value = env?.PATH ?? env?.Path ?? env?.path ?? '';
  return String(value).split(';').filter(Boolean);
}

function isWindowsCommandResolvable(command, workspacePath, env) {
  const first = splitFirstCommandToken(command);
  if (!first?.token) return { resolvable: null, reason: 'missing_command_token' };
  const token = first.token;
  if (WINDOWS_CMD_BUILTINS.has(token.toLowerCase())) {
    return { resolvable: null, reason: 'windows_cmd_builtin' };
  }
  if (hasWindowsPathSeparator(token) || token.startsWith('.')) {
    return { resolvable: existsSync(path.resolve(workspacePath, token)), token };
  }
  for (const entry of windowsPathEntries(env)) {
    for (const candidateName of pathextCandidates(token, env)) {
      if (existsSync(path.resolve(entry, candidateName))) return { resolvable: true, token };
    }
  }
  return { resolvable: false, token };
}

export function decodeVerificationOutput(value, options = {}) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  const utf8 = buffer.toString('utf8');
  const platform = options.platform ?? process.env.P2A_VERIFY_PLATFORM ?? process.platform;
  if (platform !== 'win32' || !utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('euc-kr').decode(buffer);
  } catch {
    return utf8;
  }
}

export function classifyVerificationSpawnResult(result, options = {}) {
  if (result?.error?.code === 'ENOENT') {
    return { status: 'unavailable', reason: 'spawn_enoent', hint: 'verification command could not be started (ENOENT)' };
  }
  const stderr = typeof result?.stderr === 'string' ? result.stderr : decodeVerificationOutput(result?.stderr, options);
  const stdout = typeof result?.stdout === 'string' ? result.stdout : decodeVerificationOutput(result?.stdout, options);
  const windowsNotFound = /is not recognized as an internal or external command/i.test(stderr)
    || /내부 또는 외부 명령.*(?:이\(가\)|가|이) 아닙니다/.test(stderr);
  const posixShellNotFound = /(?:^|\n)(?:\/(?:usr\/)?bin\/)?(?:ba|da|z|k)?sh(?:: (?:line )?\d+)?: (?:command not found: .+|.+(?:: not found|: command not found|: No such file or directory))(?:\n|$)/i.test(stderr);
  if (posixShellNotFound) {
    return { status: 'unavailable', reason: 'shell_command_not_found', hint: 'shell could not resolve an executable in the verification command' };
  }
  if (result?.status === 9009 || windowsNotFound) {
    return { status: 'unavailable', reason: 'windows_command_not_found', hint: 'Windows shell could not resolve the verification command' };
  }
  const platform = options.platform ?? process.env.P2A_VERIFY_PLATFORM ?? process.platform;
  if (platform === 'win32'
    && typeof result?.status === 'number'
    && result.status !== 0
    && stdout.length === 0
    && options.command
    && options.workspacePath) {
    const resolved = isWindowsCommandResolvable(options.command, options.workspacePath, options.env ?? process.env);
    if (resolved.resolvable === false) {
      return { status: 'unavailable', reason: 'command_not_resolvable', hint: 'Windows PATH/filesystem lookup could not resolve the verification command' };
    }
  }
  return { status: null, reason: null, hint: null };
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

function verificationTimeoutMs(config) {
  const value = Number(config?.verificationTimeoutMs);
  if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  return DEFAULT_VERIFICATION_TIMEOUT_MS;
}

function configRequestsNeedDetection(args, config) {
  if (!args.verifyRequests.length) {
    return !configuredCommand(config, 'test') || !configuredCommand(config, 'lint') || !configuredCommand(config, 'typecheck');
  }
  return args.verifyRequests.some((request) => request.source === 'config' && !configuredCommand(config, request.type));
}

function prepareProjectConfigForVerification(args, runsDir, run, workspacePath) {
  const loaded = loadProjectConfigWithPath(runsDir, run, workspacePath);
  let config = loaded.config;
  const saved = [];

  if (configRequestsNeedDetection(args, config)) {
    const detected = detectProjectCommands(workspacePath);
    const merged = mergeDetectedProjectConfig(config, detected);
    config = merged.config;
    if (merged.updatedKeys.length && loaded.path) {
      writeProjectConfig(loaded.path, config);
      saved.push({ source: 'detected', path: loaded.path, keys: merged.updatedKeys });
    }
  }

  if (args.saveConfig) {
    const merged = mergeExplicitVerificationCommands(config, args.verifyRequests);
    config = merged.config;
    if (merged.updatedKeys.length && loaded.path) {
      writeProjectConfig(loaded.path, config);
      saved.push({ source: 'explicit', path: loaded.path, keys: merged.updatedKeys });
    }
  }

  return { config, saved };
}

export function runVerificationCommand(spec, workspacePath, timeoutMs) {
  if (spec.status === 'skipped') return spec;
  const normalized = normalizeProjectLocalLauncherCommand(spec.command, workspacePath);
  const command = normalized.command;
  const startedAt = new Date();
  const result = spawnSync(command, {
    cwd: workspacePath,
    shell: true,
    maxBuffer: 1024 * 1024 * 10,
    timeout: timeoutMs,
  });
  const finishedAt = new Date();
  result.stdout = decodeVerificationOutput(result.stdout);
  result.stderr = decodeVerificationOutput(result.stderr);
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const unavailable = classifyVerificationSpawnResult(result, { command, workspacePath });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  const stderrTail = timedOut
    ? tail([result.stderr, result.error?.message, `verification command timed out after ${timeoutMs}ms`].filter(Boolean).join('\n'))
    : tail([result.stderr, result.error?.message].filter(Boolean).join('\n'));
  return {
    type: spec.type,
    command,
    status: unavailable.status ?? (timedOut ? 'failed' : (exitCode === 0 ? 'passed' : 'failed')),
    exitCode,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stdoutTail: tail(result.stdout),
    stderrTail,
    source: spec.source,
    ...(unavailable.status ? { failureReason: unavailable.reason, failureHint: unavailable.hint } : {}),
    ...(normalized.normalized ? { originalCommand: spec.command, normalizedCommand: command } : {}),
  };
}

function collectGitChangedFiles(workspacePath) {
  const result = gitCommandResult(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspacePath);
  if (result.status !== 0) {
    throw new Error(`git status failed while collecting changed files: ${gitResultToTail(result)}`);
  }
  const records = result.stdout.split('\0').filter(Boolean);
  const changedFiles = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath) changedFiles.push(filePath);
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return changedFiles;
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

function failedVerificationItems(run) {
  return run.verification.filter((item) => item.status === 'failed');
}

function incompleteVerificationItems(run) {
  return run.verification.filter((item) => item.status === 'skipped' || item.status === 'not_run' || item.status === 'unavailable');
}

function executedPassedVerificationItems(run) {
  return run.verification.filter((item) => item.status === 'passed'
    && (item.source === 'config' || item.source === 'command')
    && item.exitCode === 0);
}

function structuredDetailHasValue(detail, fields) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
  return fields.some((field) => Array.isArray(detail[field]) && detail[field].some((value) => typeof value === 'string' && value.trim()));
}

function missingRequiredFailureDetails(run) {
  const missing = [];
  if (!structuredDetailHasValue(run.reproduction, ['steps', 'commands', 'notes'])) missing.push('reproduction');
  if (!structuredDetailHasValue(run.localization, ['findings', 'files'])) missing.push('localization');
  if (!structuredDetailHasValue(run.guard, ['checks', 'notes'])) missing.push('guard');
  return missing;
}

function assertFailedRunStructuredDetails(run, monitorResult = null) {
  if (run.status !== 'failed' && run.status !== 'blocked') return;
  const missing = missingRequiredFailureDetails(run);
  if (!missing.length) return;
  const monitorContext = monitorResult && !monitorResult.accepted
    ? `Monitor gate blocked finish (${monitorResult.rawVerdict ?? monitorResult.verdict} -> ${monitorResult.failureClass}; concerns: ${monitorResult.concerns}). `
    : '';
  throw new Error([
    `${monitorContext}failed/blocked run requires structured debug detail: ${missing.join(', ')}`,
    'Add --repro-step/--repro-command/--repro-note, --localization/--localized-file, and --guard/--guard-note before finishing.',
  ].join('. '));
}

function assertFinishedRunGuard(run) {
  if (run.status !== 'finished') return;
  if (run.verification.length === 0) {
    throw new Error('finished run requires verification evidence. Record a passed verification or finish as failed/blocked with --failure-class.');
  }
  const failed = failedVerificationItems(run);
  if (failed.length) {
    const summary = failed.map((item) => `${item.type}:${item.command}`).join(', ');
    throw new Error(`finished run cannot include failed verification: ${summary}. Finish this run as failed/blocked with --failure-class, or start a new run with passed verification evidence.`);
  }
  const incomplete = incompleteVerificationItems(run);
  if (incomplete.length) {
    const summary = incomplete.map((item) => `${item.type}:${item.status}`).join(', ');
    throw new Error(`finished run cannot include incomplete verification: ${summary}. Finish this run as failed/blocked with --failure-class, or start a new run with passed verification evidence.`);
  }
  if (executedPassedVerificationItems(run).length === 0) {
    throw new Error('finished run requires at least one executed passed verification with source config|command and exitCode 0. Manual verification records are not sufficient.');
  }
}

function startRun(args) {
  const source = resolveTaskSource(args);
  const task = requireTask(source.graph, args.taskId);
  const initialTaskGraphFingerprint = taskGraphFingerprint(source.graph);
  const runsDir = source.runsDir;
  const now = new Date();
  const configWorkspacePath = path.resolve(args.workspace ?? process.cwd());
  const workspacePath = resolveWorkspacePath(args);
  const isolationBasePath = resolveIsolationBasePath(args, workspacePath);
  const createsWorktree = args.createIsolation && args.isolation === 'worktree';
  assertDirectory(createsWorktree ? isolationBasePath : workspacePath, '--workspace');
  if (args.createIsolation && args.isolation === 'none') throw new Error('--create-isolation requires --isolation branch or worktree');
  if (createsWorktree && !args.worktree) throw new Error('--isolation worktree requires --worktree');
  const allocation = withRunStoreLocks([runsDir], () => {
    assertNoPendingRunMigration(runsDir);
    recoverPendingRunWrite(runsDir);
    return args.runId
      ? { runId: args.runId, reserved: false, reservationToken: args.runReservationToken }
      : allocateRunId(runsDir, task.id, loadStartProjectConfig(runsDir, source, configWorkspacePath).runTracking, now);
  });
  const runId = allocation.runId;
  assertStartableRunId(runId);
  const initialReservationOwned = assertRunIdReservationOwnership(runsDir, runId, allocation.reservationToken);
  if (allocation.reservationToken && !initialReservationOwned) {
    throw new Error(`run id reservation disappeared before start could prepare isolation: ${runId}`);
  }
  const workspaceRef = args.workspaceRef ?? displayPath(workspacePath);
  let isolation;
  try {
    isolation = prepareIsolation(args, isolationBasePath, runId, task.id);
    if (createsWorktree) assertDirectory(workspacePath, '--workspace');
  } catch (error) {
    throw new Error(`${error.message}\nRetry with the same run id after correcting the isolation failure: ${startRetryCommand(args, runId, allocation.reservationToken)}`);
  }
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
    workspacePath,
    isolation,
    status: 'started',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    changedFiles: uniqueStrings(args.changedFiles),
    verification: args.manualVerification,
    notes: uniqueStrings(args.notes),
  };
  withRunStoreLocks([runsDir], () => {
    assertNoPendingRunMigration(runsDir);
    if (allocation.reservationToken
      && !assertRunIdReservationOwnership(runsDir, run.runId, allocation.reservationToken)) {
      throw new Error(`run id reservation disappeared before start could commit the run: ${run.runId}`);
    }
    try {
      // Task-graph replacement also holds the run-store lock. Rechecking the
      // graph here makes replacement and run commit mutually exclusive without
      // taking the graph lock, which may be owned by the supervising parent.
      assertStartTaskGraphUnchanged(source, initialTaskGraphFingerprint, run.runId);
    } catch (error) {
      if (allocation.reservationToken) {
        releaseRunIdReservation(runsDir, run.runId, allocation.reservationToken);
      }
      throw error;
    }
    writeRun(runsDir, run, {
      createOnly: true,
      monitorGateRequired: args.requireMonitor,
      reservationToken: allocation.reservationToken,
    });
  });
  console.log(`Plan2Agent run started: ${run.runId}`);
  console.log(`- task: ${run.taskId}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  console.log(`- runFile: ${displayPath(runFilePath(runsDir, run.runId))}`);
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: sourceRunArgs(args),
    runSourceArgs: runLifecycleSourceArgs(args),
    runId: run.runId,
  });
  return 0;
}

function recordRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  run.changedFiles = uniqueStrings([...run.changedFiles, ...args.changedFiles]);
  run.verification.push(...args.manualVerification);
  run.notes = uniqueStrings([...run.notes, ...args.notes]);
  mergeStructuredRunDetails(run, args);
  run.updatedAt = new Date().toISOString();
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent run recorded: ${run.runId}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  return 0;
}

function verifyRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  assertDirectory(workspacePath, 'run workspace');
  const configUpdate = prepareProjectConfigForVerification(args, runsDir, run, workspacePath);
  const config = configUpdate.config;
  const specs = verificationSpecs(args, config);
  const timeoutMs = verificationTimeoutMs(config);
  const results = specs.map((spec) => runVerificationCommand(spec, workspacePath, timeoutMs));
  run.verification.push(...results);
  run.updatedAt = new Date().toISOString();
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent run verification recorded: ${run.runId}`);
  for (const saved of configUpdate.saved) {
    console.log(`- projectConfig: saved ${saved.source} ${saved.keys.join(',')} to ${displayPath(saved.path)}`);
  }
  for (const result of results) {
    console.log(`- ${result.type}: ${result.status} (${result.command})`);
    if (result.normalizedCommand) console.log(`  normalized: ${result.originalCommand} -> ${result.normalizedCommand}`);
    if (result.status === 'skipped' && result.source === 'config') {
      console.log(`  hint: pass --${result.type}-command <cmd> --save-config to store a project-specific command`);
    }
    if (result.status === 'unavailable') {
      console.log(`  hint: verification command was not started; check the command, launcher path, current directory, and environment. ${result.failureHint ?? ''}`.trim());
    }
  }
  return results.some((result) => result.status === 'failed' || result.status === 'unavailable') ? 1 : 0;
}

function finishRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  if (run.status !== 'started') {
    throw new Error(`run ${run.runId} is already ${run.status}; use record to append evidence instead of finishing it again`);
  }
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  const changedFiles = [...args.changedFiles];
  if (args.collectGit) changedFiles.push(...collectGitChangedFiles(workspacePath));
  run.changedFiles = uniqueStrings([...run.changedFiles, ...changedFiles]);
  run.verification.push(...args.manualVerification);
  run.notes = uniqueStrings([...run.notes, ...args.notes]);
  mergeStructuredRunDetails(run, args);
  const targetStatus = deriveFinishStatus(run, args.status);
  const monitorResult = targetStatus === 'finished' ? applyMonitorGate(args, runsDir, run) : null;
  if (monitorResult && !monitorResult.accepted) {
    console.error(`monitor gate blocked finish: verdict=${monitorResult.rawVerdict ?? monitorResult.verdict}; signal=${monitorResult.verdict}; failureClass=${monitorResult.failureClass}; concerns=${monitorResult.concerns}`);
    console.error('blocked monitor finish requires structured detail: add --repro-*/--localization*/--guard* before finishing.');
  }
  run.status = deriveFinishStatus(run, args.status);
  assertFinishedRunGuard(run);
  const failure = buildFailure(args, run.status);
  assertFailedRunStructuredDetails(run, monitorResult);
  if (failure) run.failure = failure;
  else delete run.failure;
  const now = new Date().toISOString();
  run.updatedAt = now;
  run.finishedAt = now;
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent run finished: ${run.runId}`);
  console.log(`- status: ${run.status}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: sourceRunArgs(args),
    runSourceArgs: runLifecycleSourceArgs(args),
    runId: run.runId,
    includeResume: false,
    includeFinish: false,
  });
  return run.status === 'failed' ? 1 : 0;
}

function verificationSummary(run) {
  if (!run.verification.length) return '-';
  const counts = { passed: 0, failed: 0, skipped: 0, not_run: 0, unavailable: 0 };
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
    const run = existsSync(runFilePath(runsDir, entry.runId, index)) ? readRun(runsDir, entry.runId) : null;
    console.log(`${entry.runId}\t${entry.taskId}\t${entry.status}\t${entry.agentTool}\t${entry.workspaceRef}\t${run ? verificationSummary(run) : '-'}\t${entry.finishedAt ?? '-'}`);
  }
  return 0;
}

function showRun(args) {
  const run = readRun(resolveRunsDir(args), args.runId);
  console.log(JSON.stringify(run, null, 2));
  return 0;
}

function migrationSidecarReplacement(filePath, suffix, targetRunRef) {
  if (!['.monitor-gate.json', '.orchestration.json'].includes(suffix)) return null;
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const verdictRef = runSidecarRef(targetRunRef, '.monitor-verdict.json');
  let changed = false;
  if (suffix === '.monitor-gate.json' && data?.verdictPath !== verdictRef) {
    data.verdictPath = verdictRef;
    changed = true;
  }
  if (suffix === '.orchestration.json' && data?.monitorGate?.verdictPath && data.monitorGate.verdictPath !== verdictRef) {
    data.monitorGate.verdictPath = verdictRef;
    changed = true;
  }
  if (!changed) return null;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function hasRunIndex(runsDir) {
  return existsSync(indexPath(runsDir)) && lstatSync(indexPath(runsDir)).isFile();
}

function legacyMigrationCandidateRunsDirs(args, targetRunsDir) {
  if (args.runs) return [];
  const candidates = [];
  if (args.graph) {
    const legacyRunsDir = legacyRunsDirForGraph(path.resolve(args.graph));
    if (legacyRunsDir) candidates.push(legacyRunsDir);
  } else if (args.artifacts) {
    const iterationsDir = path.join(path.resolve(args.artifacts), 'iterations');
    if (existsSync(iterationsDir) && lstatSync(iterationsDir).isDirectory()) {
      for (const entry of readdirSync(iterationsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(iterationsDir, entry.name, 'runs'));
      }
    }
  }
  const normalizedTarget = path.resolve(targetRunsDir);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
    .filter((candidate) => candidate !== normalizedTarget)
    .sort();
}

function legacyMigrationRunsDirs(args, targetRunsDir) {
  return legacyMigrationCandidateRunsDirs(args, targetRunsDir).filter((candidate) => hasRunIndex(candidate));
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function migrationFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function migrationSourceFileIsEphemeral(ref) {
  return ref === RUN_STORE_LOCK_FILE
    || ref === RUN_STORE_REAPER_LOCK_FILE
    || ref === RUN_STORE_REDIRECT_FILE
    || ref.startsWith(`${RUN_STORE_REAPER_LOCK_FILE}.claim-`);
}

function migrationSourcePrecondition(runsDir) {
  const resolvedRunsDir = path.resolve(runsDir);
  const files = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const ref = normalizePath(path.join(prefix, entry.name));
      const filePath = path.join(directory, entry.name);
      if (!prefix && migrationSourceFileIsEphemeral(ref)) continue;
      if (entry.isDirectory()) visit(filePath, ref);
      else if (entry.isFile()) files.push({ ref, sha256: migrationFileSha256(filePath) });
    }
  }
  visit(resolvedRunsDir);
  return { runsDir: resolvedRunsDir, files };
}

function validateMigrationSourcePreconditions(journal, allowedRunsDirs, journalFile) {
  if (!Array.isArray(journal.sourcePreconditions)) {
    throw new Error(`run layout migration journal is missing source preconditions: ${displayPath(journalFile)}`);
  }
  const retired = new Set(journal.retiredRunsDirs.map((runsDir) => path.resolve(runsDir)));
  const allowed = new Set(allowedRunsDirs.map((runsDir) => path.resolve(runsDir)));
  const seen = new Set();
  for (const precondition of journal.sourcePreconditions) {
    const runsDir = path.resolve(precondition?.runsDir ?? '');
    if (!retired.has(runsDir) || !allowed.has(runsDir) || seen.has(runsDir) || !Array.isArray(precondition?.files)) {
      throw new Error(`run layout migration source precondition is invalid: ${displayPath(journalFile)}`);
    }
    seen.add(runsDir);
    const refs = new Set();
    for (const file of precondition.files) {
      const resolvedFile = path.resolve(runsDir, file?.ref ?? '');
      const normalizedRef = normalizePath(path.relative(runsDir, resolvedFile));
      if (typeof file?.ref !== 'string'
        || file.ref !== normalizedRef
        || !isPathInside(runsDir, resolvedFile)
        || resolvedFile === runsDir
        || refs.has(file.ref)
        || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
        throw new Error(`run layout migration source precondition file is invalid: ${displayPath(journalFile)}`);
      }
      refs.add(file.ref);
    }
  }
  if (seen.size !== retired.size) {
    throw new Error(`run layout migration journal does not cover every retired source: ${displayPath(journalFile)}`);
  }
}

function assertMigrationSourcesUnchanged(targetRunsDir, journal) {
  const movesBySource = new Map(journal.moves.map((move) => [path.resolve(move.source), path.resolve(move.target)]));
  for (const precondition of journal.sourcePreconditions) {
    const current = migrationSourcePrecondition(precondition.runsDir);
    const expectedFiles = new Map(precondition.files.map((file) => [file.ref, file.sha256]));
    const currentFiles = new Map(current.files.map((file) => [file.ref, file.sha256]));
    for (const [ref, sha256] of currentFiles) {
      if (!expectedFiles.has(ref)) {
        throw new Error(`legacy run store changed after migration journal creation; unexpected file: ${displayPath(path.join(precondition.runsDir, ref))}`);
      }
      if (expectedFiles.get(ref) !== sha256) {
        throw new Error(`legacy run store changed after migration journal creation: ${displayPath(path.join(precondition.runsDir, ref))}`);
      }
    }
    for (const ref of expectedFiles.keys()) {
      if (currentFiles.has(ref)) continue;
      const source = path.resolve(precondition.runsDir, ref);
      const moveTarget = movesBySource.get(source);
      if (moveTarget && existsSync(moveTarget)) continue;
      const sourceMoves = journal.moves.filter((move) => isPathInside(precondition.runsDir, move.source));
      const completedSource = sourceMoves.every((move) => !existsSync(move.source) && existsSync(move.target));
      if (ref === 'run-index.json' && completedSource && existsSync(indexPath(targetRunsDir))) continue;
      throw new Error(`legacy run store changed after migration journal creation; missing file: ${displayPath(source)}`);
    }
  }
}

function readMigrationJournal(targetRunsDir, allowedRunsDirs) {
  const journalFile = migrationJournalPath(targetRunsDir);
  if (!existsSync(journalFile)) return null;
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
  if (journal?.schema_version !== 'p2a.run_layout_migration.v1') {
    throw new Error(`invalid run layout migration journal: ${displayPath(journalFile)}`);
  }
  if (path.resolve(journal.targetRunsDir) !== path.resolve(targetRunsDir)) {
    throw new Error(`run layout migration journal target does not match ${displayPath(targetRunsDir)}`);
  }
  if (!Array.isArray(journal.sourceRunsDirs)
    || !Array.isArray(journal.legacyIndexFiles)
    || !Array.isArray(journal.moves)
    || (Object.hasOwn(journal, 'retiredRunsDirs') && !Array.isArray(journal.retiredRunsDirs))) {
    throw new Error(`run layout migration journal is incomplete: ${displayPath(journalFile)}`);
  }
  journal.retiredRunsDirs ??= journal.legacyIndexFiles.map((filePath) => path.dirname(filePath));
  journal.sourcePreconditions ??= journal.retiredRunsDirs.length ? null : [];
  const allowed = new Set(allowedRunsDirs.map((runsDir) => path.resolve(runsDir)));
  for (const sourceRunsDir of journal.sourceRunsDirs) {
    if (!allowed.has(path.resolve(sourceRunsDir))) {
      throw new Error(`run layout migration journal source is outside this command scope: ${displayPath(sourceRunsDir)}`);
    }
  }
  validateRunIndexData(journal.mergedIndex);
  for (const move of journal.moves) {
    if (!journal.sourceRunsDirs.some((runsDir) => isPathInside(runsDir, move.source))) {
      throw new Error(`run layout migration source escapes its runs directory: ${displayPath(move.source)}`);
    }
    if (!isPathInside(targetRunsDir, move.target)) {
      throw new Error(`run layout migration target escapes target runs: ${displayPath(move.target)}`);
    }
    if (move.replacement !== null && typeof move.replacement !== 'string') {
      throw new Error(`run layout migration replacement must be text or null: ${displayPath(move.target)}`);
    }
  }
  for (const legacyIndexFile of journal.legacyIndexFiles) {
    if (!journal.sourceRunsDirs.some((runsDir) => path.resolve(legacyIndexFile) === path.resolve(indexPath(runsDir)))) {
      throw new Error(`run layout migration legacy index is outside its runs directory: ${displayPath(legacyIndexFile)}`);
    }
  }
  for (const retiredRunsDir of journal.retiredRunsDirs) {
    const resolvedRetiredRunsDir = path.resolve(retiredRunsDir);
    if (!allowed.has(resolvedRetiredRunsDir)
      || !journal.sourceRunsDirs.some((runsDir) => path.resolve(runsDir) === resolvedRetiredRunsDir)
      || resolvedRetiredRunsDir === path.resolve(targetRunsDir)) {
      throw new Error(`run layout migration retired store is outside this command scope: ${displayPath(retiredRunsDir)}`);
    }
  }
  validateMigrationSourcePreconditions(journal, allowedRunsDirs, journalFile);
  return journal;
}

function completeMigrationJournal(targetRunsDir, journal) {
  assertMigrationSourcesUnchanged(targetRunsDir, journal);
  const moveStates = journal.moves.map((move) => ({
    move,
    sourceExists: existsSync(move.source),
    targetExists: existsSync(move.target),
  }));
  for (const { move, sourceExists, targetExists } of moveStates) {
    if (sourceExists && targetExists) {
      throw new Error(`run layout migration has both source and target files: ${displayPath(move.source)} -> ${displayPath(move.target)}`);
    }
    if (!sourceExists && !targetExists) {
      throw new Error(`run layout migration lost both source and target files: ${displayPath(move.source)} -> ${displayPath(move.target)}`);
    }
  }
  for (const retiredRunsDir of journal.retiredRunsDirs ?? []) {
    writeRunStoreRedirect(retiredRunsDir, targetRunsDir);
  }
  for (const { move, sourceExists } of moveStates) {
    if (sourceExists) {
      mkdirSync(path.dirname(move.target), { recursive: true });
      renameSync(move.source, move.target);
    }
    if (move.replacement !== null) atomicWriteText(move.target, move.replacement);
  }
  writeIndex(targetRunsDir, structuredClone(journal.mergedIndex));
  validateRunsDir(targetRunsDir);
  for (const legacyIndexFile of journal.legacyIndexFiles) {
    if (existsSync(legacyIndexFile)) unlinkSync(legacyIndexFile);
  }
  unlinkSync(migrationJournalPath(targetRunsDir));
}

function migrationReservationFiles(sourceRunsDir, targetRunsDir) {
  const sourceReservationDir = path.join(sourceRunsDir, RUN_ID_RESERVATION_DIR);
  if (!existsSync(sourceReservationDir)) return [];
  if (!lstatSync(sourceReservationDir).isDirectory()) {
    throw new Error(`run id reservations path must be a directory: ${displayPath(sourceReservationDir)}`);
  }
  return readdirSync(sourceReservationDir, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile()) {
      throw new Error(`run id reservation must be a regular file: ${displayPath(path.join(sourceReservationDir, entry.name))}`);
    }
    if (!entry.name.endsWith('.json')) {
      throw new Error(`run id reservation filename must end with .json: ${displayPath(path.join(sourceReservationDir, entry.name))}`);
    }
    const runId = entry.name.slice(0, -'.json'.length);
    assertSafeRunId(runId);
    const source = path.join(sourceReservationDir, entry.name);
    let reservation;
    try {
      reservation = JSON.parse(readFileSync(source, 'utf8'));
    } catch (error) {
      throw new Error(`run id reservation is malformed for ${runId}: ${error.message}`);
    }
    if (!Number.isInteger(reservation?.ownerPid) || reservation.ownerPid <= 0) {
      throw new Error(`cannot safely migrate legacy reservation ${runId} without ownerPid; wait for or explicitly clear the legacy start first`);
    }
    if (runIdReservationIsActive(reservation)) {
      throw new Error(`cannot migrate legacy runs while start still owns reservation ${runId} (pid ${reservation.ownerPid})`);
    }
    return {
      runId,
      source,
      target: path.join(targetRunsDir, RUN_ID_RESERVATION_DIR, entry.name),
    };
  });
}

function migrationEntryTime(entry) {
  const timestamp = Date.parse(entry.startedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function planAndMigrateRunLayout(args, targetRunsDir, legacyRunsDirs) {
  if (!hasRunIndex(targetRunsDir)) assertRunIndexCanInitialize(targetRunsDir);
  const sourceRunsDirs = [
    ...(hasRunIndex(targetRunsDir) ? [targetRunsDir] : []),
    ...legacyRunsDirs,
  ];
  if (!sourceRunsDirs.length) assertFile(indexPath(targetRunsDir), 'run-index.json');

  const sourceStates = sourceRunsDirs.map((runsDir) => {
    validateRunsDir(runsDir);
    return {
      runsDir,
      index: loadIndex(runsDir),
    };
  });
  const projectIds = [...new Set(sourceStates.map((state) => state.index.projectId))];
  if (projectIds.length !== 1) {
    throw new Error(`cannot merge run indexes with different projectIds: ${projectIds.join(', ')}`);
  }

  const mergedEntries = [];
  const seenRunIds = new Map();
  let mergedOrder = 0;
  for (const state of sourceStates) {
    for (const entry of state.index.runs) {
      const priorRunsDir = seenRunIds.get(entry.runId);
      if (priorRunsDir) {
        throw new Error(`cannot merge duplicate run id ${entry.runId} from ${displayPath(priorRunsDir)} and ${displayPath(state.runsDir)}`);
      }
      seenRunIds.set(entry.runId, state.runsDir);
      mergedEntries.push({
        entry: { ...entry, runRef: canonicalRunRef(entry) },
        order: mergedOrder,
      });
      mergedOrder += 1;
    }
  }
  if (sourceStates.length > 1) {
    mergedEntries.sort((left, right) => migrationEntryTime(left.entry) - migrationEntryTime(right.entry) || left.order - right.order);
  }
  const mergedIndex = {
    schema_version: 'p2a.run_index.v1',
    projectId: projectIds[0],
    runs: mergedEntries.map(({ entry }) => entry),
    tasks: rebuildTaskRunIndex(mergedEntries.map(({ entry }) => entry)),
  };
  validateRunIndexData(mergedIndex);
  const migrations = [];
  const plannedTargets = new Set();

  for (const state of sourceStates) {
    for (const entry of state.index.runs) {
      const sourceRef = indexedRunRef(state.runsDir, entry.runId, state.index);
      const targetRef = canonicalRunRef(entry);
      const sameRoot = path.resolve(state.runsDir) === path.resolve(targetRunsDir);
      if (sameRoot && sourceRef === targetRef) continue;
      const files = [{
        suffix: '.json',
        source: path.join(state.runsDir, sourceRef),
        target: path.join(targetRunsDir, targetRef),
      }];
      assertFile(files[0].source, entry.runId);
      for (const suffix of RUN_SIDECAR_SUFFIXES) {
        const source = runSidecarPath(state.runsDir, entry.runId, suffix, state.index);
        if (!existsSync(source)) continue;
        files.push({ suffix, source, target: path.join(targetRunsDir, runSidecarRef(targetRef, suffix)) });
      }
      for (const file of files) {
        const normalizedTarget = path.resolve(file.target);
        if (plannedTargets.has(normalizedTarget) || existsSync(file.target)) {
          throw new Error(`migrate-layout target already exists: ${displayPath(file.target)}`);
        }
        plannedTargets.add(normalizedTarget);
      }
      migrations.push({ entry, sourceRunsDir: state.runsDir, sourceRef, targetRef, files });
    }
  }

  const reservationMoves = legacyRunsDirs.flatMap((sourceRunsDir) => migrationReservationFiles(sourceRunsDir, targetRunsDir));
  for (const reservation of reservationMoves) {
    if (seenRunIds.has(reservation.runId)) {
      throw new Error(`cannot merge run id reservation ${reservation.runId} because that run id already exists`);
    }
    const normalizedTarget = path.resolve(reservation.target);
    if (plannedTargets.has(normalizedTarget) || existsSync(reservation.target)) {
      throw new Error(`migrate-layout reservation target already exists: ${displayPath(reservation.target)}`);
    }
    plannedTargets.add(normalizedTarget);
  }

  console.log('Plan2Agent run layout migration');
  console.log(`- target runs: ${displayPath(targetRunsDir)}`);
  for (const legacyRunsDir of legacyRunsDirs) console.log(`- merge legacy runs: ${displayPath(legacyRunsDir)}`);
  console.log(`- run records: ${migrations.length}`);
  for (const migration of migrations) {
    const sourceLabel = path.resolve(migration.sourceRunsDir) === path.resolve(targetRunsDir)
      ? migration.sourceRef
      : `${displayPath(migration.sourceRunsDir)}/${migration.sourceRef}`;
    console.log(`- ${sourceLabel} -> ${migration.targetRef}${migration.files.length > 1 ? ` (+${migration.files.length - 1} sidecar(s))` : ''}`);
  }
  if (reservationMoves.length) console.log(`- run id reservations: ${reservationMoves.length}`);
  if (args.dryRun || (migrations.length === 0 && legacyRunsDirs.length === 0)) {
    console.log(args.dryRun ? '- result: dry-run; source layouts validated; no files changed' : '- result: already iteration-partitioned and validated');
    return 0;
  }

  const journal = {
    schema_version: 'p2a.run_layout_migration.v1',
    targetRunsDir: path.resolve(targetRunsDir),
    sourceRunsDirs: [...new Set([targetRunsDir, ...sourceRunsDirs].map((runsDir) => path.resolve(runsDir)))],
    retiredRunsDirs: legacyRunsDirs.map((runsDir) => path.resolve(runsDir)),
    sourcePreconditions: legacyRunsDirs.map((runsDir) => migrationSourcePrecondition(runsDir)),
    mergedIndex,
    legacyIndexFiles: legacyRunsDirs.map((runsDir) => indexPath(runsDir)),
    moves: [
      ...migrations.flatMap((migration) => migration.files.map((file) => ({
        source: path.resolve(file.source),
        target: path.resolve(file.target),
        replacement: migrationSidecarReplacement(file.source, file.suffix, migration.targetRef),
      }))),
      ...reservationMoves.map((reservation) => ({
        source: path.resolve(reservation.source),
        target: path.resolve(reservation.target),
        replacement: null,
      })),
    ],
  };
  atomicWriteJson(migrationJournalPath(targetRunsDir), journal);
  const persistedJournal = readMigrationJournal(targetRunsDir, journal.sourceRunsDirs);
  completeMigrationJournal(targetRunsDir, persistedJournal);
  console.log(`- result: migrated into ${displayPath(targetRunsDir)} and validated`);
  return 0;
}

function migrateRunLayout(args) {
  const targetRunsDir = resolveRunsDir(args);
  const candidateLegacyRunsDirs = legacyMigrationCandidateRunsDirs(args, targetRunsDir);
  const allowedRunsDirs = [targetRunsDir, ...candidateLegacyRunsDirs];
  const pending = readMigrationJournal(targetRunsDir, allowedRunsDirs);
  const initialLegacyRunsDirs = legacyMigrationRunsDirs(args, targetRunsDir);
  if (args.dryRun) {
    if (pending) {
      console.log('Plan2Agent run layout migration');
      console.log(`- target runs: ${displayPath(targetRunsDir)}`);
      console.log(`- pending moves: ${pending.moves.length}`);
      console.log('- result: incomplete migration journal found; use --yes to resume; no files changed');
      return 0;
    }
    for (const runsDir of [targetRunsDir, ...initialLegacyRunsDirs]) {
      if (existsSync(runWriteJournalPath(runsDir))) {
        throw new Error(`run write recovery is pending; run a mutating runs command before migration dry-run: ${displayPath(runWriteJournalPath(runsDir))}`);
      }
    }
    return planAndMigrateRunLayout(args, targetRunsDir, initialLegacyRunsDirs);
  }
  const lockDirs = pending?.sourceRunsDirs ?? [targetRunsDir, ...initialLegacyRunsDirs];
  return withRunStoreLocks(lockDirs, () => {
    const currentJournal = readMigrationJournal(targetRunsDir, allowedRunsDirs);
    if (currentJournal) {
      console.log('Plan2Agent run layout migration');
      console.log(`- target runs: ${displayPath(targetRunsDir)}`);
      console.log(`- pending moves: ${currentJournal.moves.length}`);
      completeMigrationJournal(targetRunsDir, currentJournal);
      console.log(`- result: resumed migration into ${displayPath(targetRunsDir)} and validated`);
      return 0;
    }
    const legacyRunsDirs = initialLegacyRunsDirs.filter((runsDir) => hasRunIndex(runsDir));
    for (const runsDir of [targetRunsDir, ...legacyRunsDirs]) recoverPendingRunWrite(runsDir);
    return planAndMigrateRunLayout(args, targetRunsDir, legacyRunsDirs);
  });
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
    if (args.command === 'migrate-layout') return migrateRunLayout(args);
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
