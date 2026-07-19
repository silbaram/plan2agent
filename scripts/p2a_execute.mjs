#!/usr/bin/env node
/** Supervise one Plan2Agent task lifecycle with the existing task/run CLIs. */

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FAILURE_CLASSES, FAILURE_RETRYABLE, ISOLATION_MODES } from './p2a_constants.mjs';
import { loadJson, validateProposalDraftApprovalData, validateRunData, validateRunIndexData, validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';
import { monitorGateSidecarPath, normalizeMonitorVerdictData, readMonitorGateSidecar } from './p2a_monitor_gate.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import {
  assertUnmanagedGraphMutation,
  assertSafeRunId,
  assertStartableRunId,
  canonicalTaskGraphRef,
  compareRunEvidence,
  compareRunIndexEvidence,
  resolveRunsDir,
  runFilePath,
  taskGraphRefMatchesGraph,
} from './p2a_run_paths.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';
import { atomicWriteJson, runWriteTransactionPath, withRunStoreLocks } from './p2a_run_store.mjs';
import { commandLine as sharedCommandLine, printRunCommandFooter } from './p2a_run_commands.mjs';
import { allocateRunId, previewRunId, releaseRunIdReservation } from './p2a_project_config.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const COMMANDS = new Set(['plan', 'start', 'resume', 'status', 'finish']);
const FINISH_STATUSES = new Set(['finished', 'failed', 'blocked']);
const FAILURE_SOURCES = new Set(['owner', 'monitor', 'implementer']);
const IMPLEMENTER_AGENT_TOOLS = new Set(['codex', 'claude', 'manual']);
const DEFAULT_PROJECT_CONFIG = path.join('.plan2agent', 'project.config.json');
const RUN_INDEX_EVIDENCE_FIELDS = [
  'runId',
  'taskId',
  'iterationId',
  'status',
  'agentTool',
  'workspaceRef',
  'taskGraphRef',
  'startedAt',
  'finishedAt',
];

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_execute.mjs plan (--artifacts <dir>|--graph <path>) [--task <task-id>] [options]',
    '  node .plan2agent/scripts/p2a_execute.mjs start (--artifacts <dir>|--graph <path>) [--task <task-id>] [options]',
    '  node .plan2agent/scripts/p2a_execute.mjs resume (--artifacts <dir>|--graph <path>) --run-id <run-id>',
    '  node .plan2agent/scripts/p2a_execute.mjs status (--artifacts <dir>|--graph <path>) [--task <task-id>] [--run-id <run-id>]',
    '  node .plan2agent/scripts/p2a_execute.mjs finish (--artifacts <dir>|--graph <path>) --run-id <run-id> [options]',
    '',
    'Commands:',
    '  plan                 Resolve one ready task and print the supervised execution plan. No files are changed.',
    '  start                Create a run, mark the task in_progress, and print the manual launcher prompt.',
    '  resume               Reprint the selected run context and manual launcher prompt without changing files.',
    '  status               Show task status and the latest or requested run log summary.',
    '  finish               Optionally verify, finish the run, then mark the task done or blocked.',
    '',
    'Source options:',
    '  --artifacts <dir>    Iterative artifact root; uses the active iteration task graph.',
    '  --graph <path>       Legacy task graph path. Managed iteration start/finish require --artifacts.',
    '  --spec <path>        Spec JSON path for prompt context. Only supported with --graph.',
    '  --maintenance        With --artifacts, use the maintenance task graph.',
    '',
    'Start/plan options:',
    '  --task <task-id>     Task to execute. If omitted, there must be exactly one ready task.',
    '  --approval <path>    Proposal draft approval JSON; selects its maintenance task and implies --maintenance.',
    '  --agent-tool <tool>  Write implementer label: codex, claude, or manual. Default: codex.',
    '  --run-id <run-id>    Stable run id for start; generated when omitted.',
    '  --run-reservation-token <token>  Reservation owner token emitted by a failed sequential start retry.',
    '  --workspace <dir>    Workspace path for implementation/verification. Default: cwd.',
    '  --workspace-ref <r>  Human-readable workspace reference.',
    '  --isolation <mode>   none, branch, or worktree. Defaults to project config runTracking.defaultIsolation or none.',
    '  --branch <name>      Branch to record/create.',
    '  --worktree <path>    Worktree to record/create.',
    '  --base-ref <ref>     Git base ref for --create-isolation. Default: HEAD.',
    '  --create-isolation   Ask p2a_runs.mjs to create the branch/worktree before run start.',
    '  --require-monitor       Require the run\'s co-located .monitor-verdict.json before a finished run can close.',
    '',
    'Finish/verification options:',
    '  --test, --lint, --typecheck',
    '  --test-command <cmd>, --lint-command <cmd>, --typecheck-command <cmd>',
    '  --verify-command <type:cmd>',
    '  --save-config',
    '  --status finished|failed|blocked',
    '  --failure-class <class>',
    '  --retryable yes|no|after_fix',
    '  --needs-user-decision true|false',
    '  --failure-source owner|monitor|implementer',
    '  --collect-git',
    '  --changed-file <path>   Repeatable.',
    '  --note <text>           Repeatable.',
    '  --repro-step <text>     Required with localization and guard when finishing failed/blocked. Repeatable.',
    '  --repro-command <cmd>   Append a command that reproduces the observed issue. Repeatable.',
    '  --repro-note <text>     Append reproduction context. Repeatable.',
    '  --localization <text>   Required with reproduction and guard when finishing failed/blocked. Repeatable.',
    '  --localized-file <path> Append a file implicated by localization. Repeatable.',
    '  --fix-summary <text>    Append a concise summary of the fix. Repeatable.',
    '  --fix-file <path>       Append a file intentionally changed by the fix. Repeatable.',
    '  --guard <text>          Required with reproduction and localization when finishing failed/blocked. Repeatable.',
    '  --guard-note <text>     Append guard context. Repeatable.',
    '  --no-task-transition    Finish the run without marking the task done/blocked.',
    '',
    '  --help, -h          Show this help.',
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
    spec: null,
    maintenance: false,
    taskId: null,
    approval: null,
    agentTool: 'codex',
    runId: null,
    runReservationToken: null,
    workspace: null,
    workspaceRef: null,
    isolation: null,
    branch: null,
    worktree: null,
    baseRef: 'HEAD',
    createIsolation: false,
    requireMonitor: false,
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
    verifyOptions: [],
    status: null,
    failureClass: null,
    retryable: null,
    needsUserDecision: null,
    failureSource: null,
    collectGit: false,
    saveConfig: false,
    noTaskTransition: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--spec') args.spec = requiredValue(argv, ++index, '--spec');
    else if (arg === '--maintenance') args.maintenance = true;
    else if (arg === '--task') args.taskId = requiredValue(argv, ++index, '--task');
    else if (arg === '--approval') args.approval = requiredValue(argv, ++index, '--approval');
    else if (arg === '--agent-tool') args.agentTool = requiredValue(argv, ++index, '--agent-tool');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--run-reservation-token') args.runReservationToken = requiredValue(argv, ++index, '--run-reservation-token');
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
    else if (arg === '--test') args.verifyOptions.push('--test');
    else if (arg === '--lint') args.verifyOptions.push('--lint');
    else if (arg === '--typecheck') args.verifyOptions.push('--typecheck');
    else if (arg === '--test-command') args.verifyOptions.push('--test-command', requiredValue(argv, ++index, '--test-command', { allowLeadingDash: true }));
    else if (arg === '--lint-command') args.verifyOptions.push('--lint-command', requiredValue(argv, ++index, '--lint-command', { allowLeadingDash: true }));
    else if (arg === '--typecheck-command') args.verifyOptions.push('--typecheck-command', requiredValue(argv, ++index, '--typecheck-command', { allowLeadingDash: true }));
    else if (arg === '--verify-command') args.verifyOptions.push('--verify-command', requiredValue(argv, ++index, '--verify-command', { allowLeadingDash: true }));
    else if (arg === '--save-config') args.saveConfig = true;
    else if (arg === '--status') {
      args.status = requiredValue(argv, ++index, '--status');
      if (!FINISH_STATUSES.has(args.status)) throw new Error('--status must be finished, failed, or blocked');
    } else if (arg === '--failure-class') {
      args.failureClass = requiredValue(argv, ++index, '--failure-class');
      if (!FAILURE_CLASSES.has(args.failureClass)) throw new Error(`--failure-class must be one of ${[...FAILURE_CLASSES].join(', ')}`);
    } else if (arg === '--retryable') {
      args.retryable = requiredValue(argv, ++index, '--retryable');
      if (!FAILURE_RETRYABLE.has(args.retryable)) throw new Error(`--retryable must be one of ${[...FAILURE_RETRYABLE].join(', ')}`);
    } else if (arg === '--needs-user-decision') {
      const value = requiredValue(argv, ++index, '--needs-user-decision');
      if (!['true', 'false'].includes(value)) throw new Error('--needs-user-decision must be true or false');
      args.needsUserDecision = value;
    } else if (arg === '--failure-source') {
      args.failureSource = requiredValue(argv, ++index, '--failure-source');
      if (!FAILURE_SOURCES.has(args.failureSource)) throw new Error(`--failure-source must be one of ${[...FAILURE_SOURCES].join(', ')}`);
    } else if (arg === '--collect-git') args.collectGit = true;
    else if (arg === '--no-task-transition') args.noTaskTransition = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  const sourceCount = [args.artifacts, args.graph].filter(Boolean).length;
  if (sourceCount > 1) throw new Error('--artifacts and --graph cannot be used together');
  if (sourceCount === 0) {
    const defaultArtifacts = singleArtifactProjectRoot();
    const configuredGraph = configuredTaskGraphPath();
    if (defaultArtifacts) args.artifacts = defaultArtifacts;
    else if (configuredGraph) args.graph = configuredGraph;
    else assertNoUninitializedScaffoldArtifactRoots();
    if (!args.artifacts && !args.graph) {
      throw new Error('--artifacts or --graph is required');
    }
  }
  if (args.approval) {
    if (!args.artifacts) throw new Error('--approval requires --artifacts');
    if (args.graph) throw new Error('--approval is only supported with --artifacts');
    if (args.taskId) throw new Error('--approval and --task cannot be combined');
    args.maintenance = true;
  }
  if (args.spec && args.artifacts) throw new Error('--spec is only supported with --graph; --artifacts uses the active iteration spec');
  if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
  if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  if (args.graph && ['start', 'finish'].includes(args.command)) {
    assertUnmanagedGraphMutation(args.graph, `p2a_execute ${args.command}`);
  }
  if (['finish', 'resume'].includes(args.command) && !args.runId) throw new Error(`--run-id is required for ${args.command}`);
  if (args.runReservationToken && (args.command !== 'start' || !args.runId)) {
    throw new Error('--run-reservation-token requires start with --run-id');
  }
  if (args.command === 'status' && !args.taskId && !args.runId && !args.approval) throw new Error('--task, --approval, or --run-id is required for status');
  if (['plan', 'start'].includes(args.command) && !IMPLEMENTER_AGENT_TOOLS.has(args.agentTool)) {
    throw new Error('--agent-tool for implementation must be one of codex, claude, or manual; Gemini is read-only and may only be used as a reviewer/monitor');
  }
  if (['plan', 'resume', 'status'].includes(args.command) && args.verifyOptions.length) {
    throw new Error('verification options are only supported with finish');
  }
  if (args.requireMonitor && args.command !== 'start') {
    throw new Error('--require-monitor is only supported with start');
  }
  if (args.command !== 'finish' && (args.status || args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource || args.collectGit || args.saveConfig || hasStructuredDetailOptions(args))) {
    throw new Error('finish options are only supported with finish');
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

function warnGraphMode() {
  console.error('warning: --graph mode does not check Gate B/D prerequisites; use --artifacts for approved iterative execution.');
}

function artifactRelativePath(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

function loadProjectConfig(source, workspacePath) {
  const candidates = [
    path.join(workspacePath, DEFAULT_PROJECT_CONFIG),
    path.join(process.cwd(), DEFAULT_PROJECT_CONFIG),
  ];
  if (source.artifactRoot) candidates.push(path.join(source.artifactRoot, 'project.config.json'));
  if (source.graphPath) candidates.push(path.join(path.dirname(source.graphPath), '..', 'project.config.json'));
  for (const candidate of uniqueStrings(candidates)) {
    try {
      if (existsSync(candidate) && lstatSync(candidate).isFile()) return loadJson(candidate);
    } catch {
      // Optional project config should not block explicit CLI options.
    }
  }
  return {};
}

function resolveSource(args) {
  if (args.artifacts) {
    const state = resolveIterationState(args.artifacts, { requireReady: !args.maintenance });
    if (args.maintenance) {
      const graphPath = path.join(state.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      assertFile(graphPath, 'maintenance task graph');
      const graph = loadJson(graphPath);
      validateTaskGraphData(graph);
      return {
        projectId: state.projectId,
        sourceArgs: ['--artifacts', args.artifacts, '--maintenance'],
        sourceLayout: 'maintenance',
        iterationId: 'maintenance',
        artifactRoot: state.artifactRoot,
        graphPath,
        specPath: state.currentSpecPath,
        graph,
        runsDir: resolveRunsDir({ artifacts: args.artifacts }),
        taskGraphRef: artifactRelativePath(state.artifactRoot, graphPath),
      };
    }
    const graph = loadJson(state.taskGraphPath);
    validateTaskGraphData(graph);
    return {
      projectId: state.projectId,
      sourceArgs: ['--artifacts', args.artifacts],
      sourceLayout: 'iteration',
      iterationId: state.activeIteration,
      artifactRoot: state.artifactRoot,
      graphPath: state.taskGraphPath,
      specPath: state.specPath,
      graph,
      runsDir: resolveRunsDir({ artifacts: args.artifacts }),
      taskGraphRef: artifactRelativePath(state.artifactRoot, state.taskGraphPath),
    };
  }

  const graphPath = path.resolve(args.graph);
  warnGraphMode();
  assertFile(graphPath, 'task graph');
  const graph = loadJson(graphPath);
  validateTaskGraphData(graph);
  return {
    projectId: graph.projectId,
    sourceArgs: ['--graph', args.graph],
    sourceLayout: 'graph',
    iterationId: graph.version ?? null,
    artifactRoot: null,
    graphPath,
    specPath: args.spec ? path.resolve(args.spec) : null,
    graph,
    runsDir: resolveRunsDir({ graph: args.graph }),
    taskGraphRef: canonicalTaskGraphRef(graphPath),
  };
}

function taskMap(graph) {
  return new Map(graph.tasks.map((task) => [task.id, task]));
}

function isReady(task, tasksById) {
  return task.status === 'todo' && task.dependencies.every((dependency) => tasksById.get(dependency)?.status === 'done');
}

function readyTasks(graph) {
  const tasksById = taskMap(graph);
  return graph.tasks.filter((task) => isReady(task, tasksById));
}

function selectReadyTask(source, taskId = null) {
  const tasksById = taskMap(source.graph);
  if (taskId) {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`unknown task id: ${taskId}`);
    if (!isReady(task, tasksById)) {
      const incomplete = task.dependencies.filter((dependency) => tasksById.get(dependency)?.status !== 'done');
      const suffix = incomplete.length ? `; incomplete dependencies: ${incomplete.join(', ')}` : '';
      throw new Error(`${task.id} is not ready; status is ${task.status}${suffix}`);
    }
    return task;
  }
  const ready = readyTasks(source.graph);
  if (ready.length === 0) throw new Error('no ready task found');
  if (ready.length > 1) {
    const summary = ready.map((task) => `${task.id} (${task.title})`).join(', ');
    throw new Error(`multiple ready tasks found; pass --task. Ready tasks: ${summary}`);
  }
  return ready[0];
}

function currentSourceGraph(source) {
  const graph = loadJson(source.graphPath);
  validateTaskGraphData(graph);
  return { ...source, graph };
}

function claimTaskForRunStart(source, task) {
  task.status = 'in_progress';
  delete task.blockReason;
  delete task.blockNote;
  atomicWriteJson(source.graphPath, source.graph);
}

function pendingRunWriteMatchesTask(source, taskId) {
  const transactionPath = runWriteTransactionPath(source.runsDir);
  if (!existsSync(transactionPath)) return false;
  let transaction;
  try {
    transaction = loadJson(transactionPath);
    if (transaction?.schema_version !== 'p2a.run_write_transaction.v1') return null;
    validateRunData(transaction.run);
    validateRunIndexData(transaction.index);
    const entry = transaction.index.runs.find((candidate) => candidate.runId === transaction.run.runId);
    if (!entry || entry.runRef !== transaction.runRef || transaction.index.projectId !== transaction.run.projectId) {
      return null;
    }
    for (const field of RUN_INDEX_EVIDENCE_FIELDS) {
      if (JSON.stringify(entry[field]) !== JSON.stringify(transaction.run[field])) return null;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return null;
  }
  if (transaction.run.taskId === taskId && runMatchesSourceContext(transaction.run, source)) return true;
  return transaction.index.runs.some((entry) => (
    entry.taskId === taskId
    && entry.status === 'started'
    && entry.iterationId === source.iterationId
    && taskGraphRefMatchesGraph(entry.taskGraphRef, source.graphPath, source.artifactRoot)
  ));
}

function hasStartedRunForTask(source, taskId) {
  // A child may have durably journaled a started run before its index entry was
  // published. Fail closed so a later forward recovery cannot create a started
  // run for a task that this parent already rolled back to todo.
  const pendingRunMatch = pendingRunWriteMatchesTask(source, taskId);
  if (pendingRunMatch === null || pendingRunMatch) return true;
  const indexFile = runsIndexPath(source.runsDir);
  if (!existsSync(indexFile)) return false;
  try {
    const index = validateRunIndexData(loadJson(indexFile));
    return index.runs.some((entry) => (
      entry.taskId === taskId
      && entry.status === 'started'
      && entry.iterationId === source.iterationId
      && taskGraphRefMatchesGraph(entry.taskGraphRef, source.graphPath, source.artifactRoot)
    ));
  } catch {
    // Preserve an in-progress task if run evidence cannot be inspected safely.
    return true;
  }
}

function rollbackTaskRunStartClaim(source, taskId) {
  const current = currentSourceGraph(source);
  const task = requireTask(current, taskId);
  if (task.status !== 'in_progress' || hasStartedRunForTask(current, taskId)) return false;
  task.status = 'todo';
  delete task.blockReason;
  delete task.blockNote;
  atomicWriteJson(current.graphPath, current.graph);
  return true;
}

function requireTask(source, taskId) {
  const task = taskMap(source.graph).get(taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  return task;
}

function readProposalDraftApproval(filePath) {
  assertFile(filePath, 'proposal draft approval');
  return validateProposalDraftApprovalData(loadJson(filePath));
}

function validateApprovalTaskLink(source, approval) {
  if (source.sourceLayout !== 'maintenance') {
    throw new Error('--approval must resolve against the maintenance task graph');
  }
  const task = requireTask(source, approval.maintenanceTask.taskId);
  const refs = task.sourceSpecRefs ?? [];
  const requiredRefs = [
    `proposal-draft-approval:${approval.approvalId}`,
    `proposal-patch-draft:${approval.draftId}`,
    `proposal-candidate:${approval.candidateId}`,
    ...(approval.maintenanceTask.sourceSpecRefs ?? [])
      .filter((ref) => (
        ref.startsWith('proposal-target:')
        || ref.startsWith('proposal-target-repo:')
        || ref.startsWith('proposal-target-area:')
      )),
  ];
  const missingRefs = [...new Set(requiredRefs)].filter((ref) => !refs.includes(ref));
  if (missingRefs.length) {
    throw new Error(`approval maintenance task ${task.id} is missing sourceSpecRefs: ${missingRefs.join(', ')}`);
  }
  return task;
}

function resolveApprovalSelection(args, source) {
  if (!args.approval) return { approval: null, approvalPath: null, taskId: args.taskId };
  const approvalPath = path.resolve(args.approval);
  const approval = readProposalDraftApproval(approvalPath);
  const task = validateApprovalTaskLink(source, approval);
  return { approval, approvalPath, taskId: task.id };
}

function approvalRunNotes(approval) {
  if (!approval) return [];
  return [
    `proposalApproval=${approval.approvalId}`,
    `proposalPatchDraft=${approval.draftId}`,
    `proposalCandidate=${approval.candidateId}`,
  ];
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

function fillPattern(pattern, values) {
  return pattern
    .replaceAll('<taskId>', values.taskId)
    .replaceAll('<runId>', values.runId)
    .replaceAll('{taskId}', values.taskId)
    .replaceAll('{runId}', values.runId);
}

function resolveStartDefaults(args, source, task, runId, options = {}) {
  const workspacePath = options.workspacePath ?? path.resolve(args.workspace ?? process.cwd());
  assertDirectory(workspacePath, '--workspace');
  const config = options.config ?? loadProjectConfig(source, workspacePath);
  const runTracking = config.runTracking ?? {};
  const isolation = args.isolation ?? runTracking.defaultIsolation ?? 'none';
  if (!ISOLATION_MODES.has(isolation)) throw new Error(`project config runTracking.defaultIsolation must be one of none, branch, worktree, got ${JSON.stringify(isolation)}`);
  const values = { taskId: task.id, runId };
  const branch = args.branch ?? (isolation === 'none' ? null : fillPattern(runTracking.branchPattern ?? 'p2a/<taskId>-<runId>', values));
  let worktree = args.worktree ?? null;
  if (isolation === 'worktree' && !worktree && runTracking.worktreePattern) {
    worktree = path.resolve(workspacePath, fillPattern(runTracking.worktreePattern, values));
  }
  return { workspacePath, config, isolation, branch, worktree };
}

function resolveStartIdentity(args, source, task, options = {}) {
  const workspacePath = path.resolve(args.workspace ?? process.cwd());
  assertDirectory(workspacePath, '--workspace');
  const config = loadProjectConfig(source, workspacePath);
  const previewId = args.runId ?? previewRunId(source.runsDir, task.id, config.runTracking);
  assertStartableRunId(previewId);
  const previewDefaults = resolveStartDefaults(args, source, task, previewId, { config, workspacePath });
  if (args.runId || !options.reserve) {
    return {
      runId: previewId,
      reserved: false,
      reservationToken: args.runReservationToken,
      defaults: previewDefaults,
    };
  }
  const allocation = allocateRunId(source.runsDir, task.id, config.runTracking);
  assertStartableRunId(allocation.runId);
  try {
    return {
      ...allocation,
      defaults: resolveStartDefaults(args, source, task, allocation.runId, { config, workspacePath }),
    };
  } catch (error) {
    if (allocation.reserved) releaseRunIdReservation(source.runsDir, allocation.runId, allocation.reservationToken);
    throw error;
  }
}

function childEnv() {
  return { ...process.env, NO_COLOR: process.env.NO_COLOR ?? '1' };
}

function runScript(scriptName, scriptArgs, options = {}) {
  return spawnSync(process.execPath, [path.join(P2A_PATHS.scriptsDir, scriptName), ...scriptArgs], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: childEnv(),
    maxBuffer: 1024 * 1024 * 20,
  });
}

function printChildResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function commandLine(scriptName, args) {
  return sharedCommandLine(P2A_PATHS, scriptName, args);
}

function promptArgs(source, taskId) {
  const args = ['prompt', ...source.sourceArgs];
  if (!source.artifactRoot && source.specPath) args.push('--spec', source.specPath);
  args.push(taskId);
  return args;
}

function finishTaskArgs(source, taskId, status) {
  const transition = status === 'finished' ? 'done' : 'block';
  return [transition, ...source.sourceArgs, taskId];
}

function sourceRunArgs(args) {
  if (args.artifacts) return ['--artifacts', args.artifacts, ...(args.maintenance ? ['--maintenance'] : [])];
  return ['--graph', args.graph];
}

function sourceSelectionArgs(args, taskId) {
  return args.approval ? ['--approval', args.approval] : ['--task', taskId];
}

function executeStartArgs(args, task, runId, defaults) {
  const startArgs = [
    'start',
    ...sourceRunArgs(args),
    ...sourceSelectionArgs(args, task.id),
    '--agent-tool',
    args.agentTool,
    '--run-id',
    runId,
    '--workspace',
    defaults.workspacePath,
    '--isolation',
    defaults.isolation,
  ];
  if (args.workspaceRef) startArgs.push('--workspace-ref', args.workspaceRef);
  if (args.runReservationToken) startArgs.push('--run-reservation-token', args.runReservationToken);
  if (defaults.branch) startArgs.push('--branch', defaults.branch);
  if (defaults.worktree) startArgs.push('--worktree', defaults.worktree);
  if (args.baseRef) startArgs.push('--base-ref', args.baseRef);
  if (args.createIsolation) startArgs.push('--create-isolation');
  if (args.requireMonitor) startArgs.push('--require-monitor');
  for (const changedFile of args.changedFiles) startArgs.push('--changed-file', changedFile);
  for (const note of args.notes) startArgs.push('--note', note);
  return startArgs;
}

function startRunArgs(args, task, runId, defaults, approval = null) {
  const runArgs = [
    'start',
    ...sourceRunArgs(args),
    '--task',
    task.id,
    '--run-id',
    runId,
    '--agent-tool',
    args.agentTool,
    '--workspace',
    defaults.workspacePath,
    '--isolation',
    defaults.isolation,
  ];
  if (args.workspaceRef) runArgs.push('--workspace-ref', args.workspaceRef);
  if (args.runReservationToken) runArgs.push('--run-reservation-token', args.runReservationToken);
  if (defaults.branch) runArgs.push('--branch', defaults.branch);
  if (defaults.worktree) runArgs.push('--worktree', defaults.worktree);
  if (args.baseRef) runArgs.push('--base-ref', args.baseRef);
  if (args.createIsolation) runArgs.push('--create-isolation');
  if (args.requireMonitor) runArgs.push('--require-monitor');
  for (const changedFile of args.changedFiles) runArgs.push('--changed-file', changedFile);
  for (const note of uniqueStrings([...approvalRunNotes(approval), ...args.notes])) runArgs.push('--note', note);
  return runArgs;
}

function finishRunArgs(args, finalStatus, approval = null) {
  const runArgs = ['finish', ...sourceRunArgs(args), '--run-id', args.runId];
  if (finalStatus) runArgs.push('--status', finalStatus);
  if (args.failureClass) runArgs.push('--failure-class', args.failureClass);
  if (args.retryable) runArgs.push('--retryable', args.retryable);
  if (args.needsUserDecision !== null) runArgs.push('--needs-user-decision', args.needsUserDecision);
  if (args.failureSource) runArgs.push('--failure-source', args.failureSource);
  if (args.collectGit) runArgs.push('--collect-git');
  if (args.workspace) runArgs.push('--workspace', args.workspace);
  for (const changedFile of args.changedFiles) runArgs.push('--changed-file', changedFile);
  for (const note of uniqueStrings([...approvalRunNotes(approval), ...args.notes])) runArgs.push('--note', note);
  for (const step of args.reproductionSteps) runArgs.push('--repro-step', step);
  for (const command of args.reproductionCommands) runArgs.push('--repro-command', command);
  for (const note of args.reproductionNotes) runArgs.push('--repro-note', note);
  for (const finding of args.localizationFindings) runArgs.push('--localization', finding);
  for (const file of args.localizedFiles) runArgs.push('--localized-file', file);
  for (const summary of args.fixSummaries) runArgs.push('--fix-summary', summary);
  for (const file of args.fixFiles) runArgs.push('--fix-file', file);
  for (const check of args.guardChecks) runArgs.push('--guard', check);
  for (const note of args.guardNotes) runArgs.push('--guard-note', note);
  return runArgs;
}

function verifyRunArgs(args) {
  const runArgs = ['verify', ...sourceRunArgs(args), '--run-id', args.runId, ...args.verifyOptions];
  if (args.saveConfig) runArgs.push('--save-config');
  return runArgs;
}

function runsIndexPath(runsDir) {
  return path.join(runsDir, 'run-index.json');
}

function runPath(runsDir, runId) {
  assertSafeRunId(runId);
  return runFilePath(runsDir, runId);
}

function readOrchestrationSidecar(runsDir, runId) {
  return readMonitorGateSidecar(runsDir, runId);
}

function readMonitorVerdict(source, sidecar) {
  if (!sidecar?.required) return null;
  const verdictPath = path.resolve(source.runsDir, sidecar.verdictPath);
  assertFile(verdictPath, 'monitor verdict');
  const data = loadJson(verdictPath);
  try {
    return normalizeMonitorVerdictData(data);
  } catch (error) {
    throw new Error(`${error.message}: ${displayPath(verdictPath)}`);
  }
}

function applyMonitorGate(args, source) {
  const sidecar = readOrchestrationSidecar(source.runsDir, args.runId);
  if (!sidecar?.required) return null;
  const verdict = readMonitorVerdict(source, sidecar);
  if (sidecar.acceptedVerdicts.includes(verdict.verdict) && !verdict.hasConcerns) {
    return { sidecar, verdict: verdict.verdict, accepted: true };
  }
  const mappedFailureClass = sidecar.failureClassMap[verdict.failureSignal]
    ?? sidecar.failureClassMap[verdict.verdict]
    ?? 'other';
  if (!args.status || args.status === 'finished') args.status = 'blocked';
  if (!args.failureClass) args.failureClass = mappedFailureClass;
  if (!args.failureSource) args.failureSource = 'monitor';
  if (args.needsUserDecision === null && verdict.needsUserDecision) args.needsUserDecision = 'true';
  return { sidecar, verdict: verdict.failureSignal, accepted: false, failureClass: args.failureClass };
}

function updateOrchestrationRuntimeAfterFinish() {
  return null;
}

function closedOrchestrationRuntimeForRun() {
  return null;
}

function expectedTaskStatusForRun(run) {
  return finishStatusFromRun(run) === 'finished' ? 'done' : 'blocked';
}

function readRun(runsDir, runId) {
  const filePath = runPath(runsDir, runId);
  assertFile(filePath, runId);
  const run = loadJson(filePath);
  validateRunData(run);
  return run;
}

function assertRunMatchesIndexEntry(run, indexEntry, indexProjectId) {
  const mismatches = [];
  for (const field of RUN_INDEX_EVIDENCE_FIELDS) {
    if (JSON.stringify(run[field]) !== JSON.stringify(indexEntry[field])) {
      mismatches.push(`${field}:index=${indexEntry[field] ?? 'null'} file=${run[field] ?? 'null'}`);
    }
  }
  if (run.projectId !== indexProjectId) {
    mismatches.push(`projectId:index=${indexProjectId} file=${run.projectId}`);
  }
  if (mismatches.length) {
    throw new Error(`run-index evidence mismatch for ${indexEntry.runId}: ${mismatches.join(', ')}`);
  }
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
    `run ${run.runId} is outside the current execution context: expected ${source.sourceLayout} `
    + `iteration ${source.iterationId ?? 'null'} for ${source.taskGraphRef}`,
  );
}

function latestRunIdForTask(runsDir, taskId, source) {
  const indexFile = runsIndexPath(runsDir);
  if (!existsSync(indexFile)) return null;
  const index = validateRunIndexData(loadJson(indexFile));
  if (index.projectId !== source.projectId) {
    throw new Error(`run-index projectId ${index.projectId} does not match execution project ${source.projectId}`);
  }
  const candidates = index.runs
    .map((indexEntry, runOrder) => ({ indexEntry, runOrder }))
    .filter(({ indexEntry: entry }) => (
      entry.taskId === taskId
      && entry.iterationId === source.iterationId
      && taskGraphRefMatchesGraph(entry.taskGraphRef, source.graphPath, source.artifactRoot)
    ))
    .sort(compareRunIndexEvidence);
  const resolved = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    let run;
    try {
      run = readRun(runsDir, candidate.indexEntry.runId);
      assertRunMatchesIndexEntry(run, candidate.indexEntry, index.projectId);
    } catch (error) {
      if (candidateIndex === 0) throw error;
      console.error(`warning: skipped invalid older run ${candidate.indexEntry.runId}: ${error.message}`);
      continue;
    }
    if (run.taskId !== taskId || !runMatchesSourceContext(run, source)) {
      continue;
    }
    resolved.push({ ...candidate, run });
  }
  resolved.sort(compareRunEvidence);
  return resolved[0]?.run.runId ?? null;
}

function printExecutionPlan(args, source, task, runId = null, defaults = null, approvalLink = null) {
  console.log('Plan2Agent supervised task execution');
  console.log(`- project: ${source.projectId}`);
  console.log(`- source: ${source.sourceLayout}`);
  console.log(`- task: ${task.id} - ${task.title}`);
  console.log(`- graph: ${displayPath(source.graphPath)}`);
  if (approvalLink?.approval) {
    console.log(`- proposalApproval: ${approvalLink.approval.approvalId}`);
    console.log(`- patchDraft: ${approvalLink.approval.draftId}`);
    console.log(`- approvalFile: ${displayPath(approvalLink.approvalPath)}`);
  }
  if (runId) console.log(`- runId: ${runId}`);
  if (defaults) {
    console.log(`- agentTool: ${args.agentTool}`);
    console.log(`- workspace: ${displayPath(defaults.workspacePath)}`);
    console.log(`- isolation: ${defaults.isolation}`);
    if (defaults.branch) console.log(`- branch: ${defaults.branch}`);
    if (defaults.worktree) console.log(`- worktree: ${displayPath(defaults.worktree)}`);
  }
  if (args.requireMonitor) console.log('- monitorGate: required');
  console.log('');
  console.log('Lifecycle:');
  console.log('1. start: create run and mark the task in_progress');
  console.log('2. implement: paste the launcher prompt into the supervised agent session');
  console.log('3. finish: run verification, finish the run, then mark the task done or blocked');
  console.log('');
  console.log('Useful commands:');
  const startArgs = executeStartArgs(args, task, runId, defaults);
  console.log(`- ${commandLine('p2a_execute.mjs', startArgs)}`);
  if (runId) {
    console.log(`- ${commandLine('p2a_execute.mjs', ['finish', ...sourceRunArgs(args), ...(args.approval ? ['--approval', args.approval] : []), '--run-id', runId, '--test', '--lint', '--typecheck'])}`);
  }
}

function printLauncherPrompt(source, task, runId, approvalLink = null) {
  console.log('');
  console.log('Manual launcher prompt');
  console.log('---');
  console.log(`Implement Plan2Agent task ${task.id} for run ${runId}.`);
  if (approvalLink?.approval) {
    console.log(`Approved proposal: ${approvalLink.approval.approvalId}`);
    console.log(`Patch draft: ${approvalLink.approval.draftId}`);
  }
  console.log('');
  console.log('Boundaries:');
  console.log('- Make only code/test/doc changes required by this task and its acceptance criteria.');
  console.log('- Do not edit Plan2Agent task graph, run logs, or planning artifacts directly.');
  console.log('- The owner will run p2a_execute finish or p2a_runs verify/finish after implementation.');
  console.log('- Report changed files, verification commands, results, and blockers.');
  console.log('');
  const promptResult = runScript('p2a_tasks.mjs', promptArgs(source, task.id));
  printChildResult(promptResult);
  console.log('---');
}

function verifyRequested(args) {
  return args.verifyOptions.length > 0;
}

function finishStatusFromRun(run) {
  return run.status;
}

function transitionTaskAfterFinishedRun(args, source, run, successStatus = 0) {
  const task = requireTask(source, run.taskId);
  const expectedTaskStatus = expectedTaskStatusForRun(run);
  if (args.noTaskTransition) {
    console.log('Task transition skipped by --no-task-transition');
    return successStatus;
  }
  if (task.status === expectedTaskStatus) {
    console.log(`Task transition already applied: ${task.id} status is ${task.status}`);
    return successStatus;
  }
  if (task.status !== 'in_progress') {
    console.error(`task transition skipped: ${task.id} must be in_progress before done/block; current status is ${task.status}`);
    return 1;
  }
  console.log(`Marking task ${run.status === 'finished' ? 'done' : 'blocked'}...`);
  const taskResult = runScript('p2a_tasks.mjs', finishTaskArgs(source, task.id, run.status));
  printChildResult(taskResult);
  if (taskResult.status !== 0) return taskResult.status ?? 1;
  return successStatus;
}

function printClosedRunFooter(source, run) {
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: source.sourceArgs,
    runId: run.runId,
    includeResume: false,
    includeFinish: false,
    heading: 'Run commands:',
  });
}

function recoverAfterClosedRun(args, source, run) {
  console.log(`Run already ${run.status}; recovering orchestration runtime and task transition without re-finishing run.`);
  try {
    const runtimeUpdate = updateOrchestrationRuntimeAfterFinish(source, run);
    if (runtimeUpdate?.skipped) {
      console.log(`Orchestration runtime already closed: ${displayPath(runtimeUpdate.filePath)}`);
    } else if (runtimeUpdate) {
      console.log(`Updated orchestration runtime: ${displayPath(runtimeUpdate.filePath)} phase=${runtimeUpdate.runtime.status.phase}`);
    }
  } catch (error) {
    console.error(`warning: orchestration runtime was not updated: ${error.message}`);
  }
  const status = transitionTaskAfterFinishedRun(args, source, run, 0);
  printClosedRunFooter(source, run);
  return status;
}

function finishResultAllowsTaskTransition(result, requestedStatus, run) {
  if (run.status === 'started') return false;
  if (result.status === 0) return true;
  if (requestedStatus === 'failed' && result.status === 1 && run.status === 'failed') return true;
  return false;
}

function runPlan(args) {
  const source = resolveSource(args);
  const approvalLink = resolveApprovalSelection(args, source);
  const task = selectReadyTask(source, approvalLink.taskId);
  const identity = resolveStartIdentity(args, source, task, { reserve: false });
  const { runId, defaults } = identity;
  printExecutionPlan(args, source, task, runId, defaults, approvalLink);
  console.log('');
  console.log(`Prompt preview command: ${commandLine('p2a_tasks.mjs', promptArgs(source, task.id))}`);
  return 0;
}

function runStart(args) {
  const initialSource = resolveSource(args);
  return withRunStoreLocks([path.dirname(initialSource.graphPath)], () => {
    const source = currentSourceGraph(initialSource);
    const approvalLink = resolveApprovalSelection(args, source);
    const task = selectReadyTask(source, approvalLink.taskId);
    const identity = resolveStartIdentity(args, source, task, { reserve: true });
    const { runId, defaults } = identity;
    args.runReservationToken = identity.reservationToken;
    try {
      claimTaskForRunStart(source, task);
    } catch (error) {
      if (identity.reserved) releaseRunIdReservation(source.runsDir, runId, identity.reservationToken);
      throw error;
    }

    printExecutionPlan(args, source, task, runId, defaults, approvalLink);
    console.log('');
    console.log('Task marked in_progress. Starting run...');
    const runResult = runScript('p2a_runs.mjs', startRunArgs(args, task, runId, defaults, approvalLink.approval));
    printChildResult(runResult);
    if (runResult.status !== 0) {
      if (rollbackTaskRunStartClaim(source, task.id)) {
        console.error(`Task transition rolled back: ${task.id} returned to todo because run ${runId} did not start.`);
      } else {
        console.error(`warning: task ${task.id} remains in_progress because started-run evidence could not be ruled out.`);
      }
      console.error('Run start failed before lifecycle setup completed. Correct the reported cause, then retry with the same reserved run id:');
      console.error(commandLine('p2a_execute.mjs', executeStartArgs(args, task, runId, defaults)));
      return runResult.status ?? 1;
    }
    if (args.requireMonitor) {
      console.log(`Attached monitor gate sidecar: ${displayPath(monitorGateSidecarPath(source.runsDir, runId))}`);
    }

    printLauncherPrompt(source, task, runId, approvalLink);
    printRunCommandFooter(P2A_PATHS, {
      sourceArgs: source.sourceArgs,
      runId,
      heading: 'Run commands:',
    });
    return 0;
  });
}

function runResume(args) {
  const source = resolveSource(args);
  const approvalLink = resolveApprovalSelection(args, source);
  const run = readRun(source.runsDir, args.runId);
  assertRunMatchesSourceContext(run, source);
  if (approvalLink.taskId && run.taskId !== approvalLink.taskId) {
    console.error(`resume refused: run ${run.runId} belongs to ${run.taskId}, not approval task ${approvalLink.taskId}`);
    return 1;
  }
  const task = requireTask(source, run.taskId);
  console.log('Plan2Agent execution resume');
  console.log(`- project: ${source.projectId}`);
  console.log(`- task: ${task.id} - ${task.title}`);
  console.log(`- taskStatus: ${task.status}`);
  console.log(`- runId: ${run.runId}`);
  console.log(`- runStatus: ${run.status}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  if (run.status !== 'started') {
    console.log('- resumeNote: run is already closed; use status/review commands for follow-up evidence.');
  }
  printLauncherPrompt(source, task, run.runId, approvalLink);
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: source.sourceArgs,
    runId: run.runId,
    includeResume: false,
    includeFinish: run.status === 'started',
    heading: 'Run commands:',
  });
  return 0;
}

function runStatus(args) {
  const source = resolveSource(args);
  const approvalLink = resolveApprovalSelection(args, source);
  const explicitRun = args.runId ? readRun(source.runsDir, args.runId) : null;
  const taskId = approvalLink.taskId ?? explicitRun?.taskId ?? null;
  const task = taskId ? requireTask(source, taskId) : null;
  const runId = explicitRun?.runId ?? (task ? latestRunIdForTask(source.runsDir, task.id, source) : null);
  const run = runId ? (explicitRun ?? readRun(source.runsDir, runId)) : null;
  if (run) assertRunMatchesSourceContext(run, source);
  if (approvalLink.taskId && run && run.taskId !== approvalLink.taskId) {
    console.error(`status refused: run ${run.runId} belongs to ${run.taskId}, not approval task ${approvalLink.taskId}`);
    return 1;
  }
  console.log('Plan2Agent execution status');
  console.log(`- project: ${source.projectId}`);
  if (approvalLink.approval) {
    console.log(`- proposalApproval: ${approvalLink.approval.approvalId}`);
    console.log(`- patchDraft: ${approvalLink.approval.draftId}`);
  }
  if (task) {
    console.log(`- task: ${task.id} - ${task.title}`);
    console.log(`- taskStatus: ${task.status}`);
    if (task.blockReason) console.log(`- blockReason: ${task.blockReason}`);
  }
  if (!run) {
    console.log('- latestRun: none');
    return 0;
  }
  console.log(`- runId: ${run.runId}`);
  console.log(`- runStatus: ${run.status}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.map((item) => `${item.type}:${item.status}`).join(', ') || '-'}`);
  const sidecar = readOrchestrationSidecar(source.runsDir, run.runId);
  if (sidecar) {
    console.log(`- monitorGate: ${sidecar.verdictPath}`);
  }
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: source.sourceArgs,
    runId: run.runId,
    includeResume: run.status === 'started',
    includeFinish: run.status === 'started',
    heading: 'Run commands:',
  });
  return 0;
}

function runFinish(args) {
  const source = resolveSource(args);
  const approvalLink = resolveApprovalSelection(args, source);
  const existingRun = readRun(source.runsDir, args.runId);
  assertRunMatchesSourceContext(existingRun, source);
  if (approvalLink.taskId) {
    if (existingRun.taskId !== approvalLink.taskId) {
      console.error(`finish refused: run ${existingRun.runId} belongs to ${existingRun.taskId}, not approval task ${approvalLink.taskId}`);
      return 1;
    }
  }
  if (existingRun.status !== 'started') return recoverAfterClosedRun(args, source, existingRun);
  const closedRuntime = closedOrchestrationRuntimeForRun(source, args.runId);
  if (closedRuntime) {
    console.log(`Orchestration runtime already closed: ${displayPath(closedRuntime.filePath)}`);
    const run = existingRun;
    if (run.status !== 'started') {
      const status = transitionTaskAfterFinishedRun(args, source, run, 0);
      printClosedRunFooter(source, run);
      return status;
    }
    console.log('- finishNote: runtime is closed but run is still started; continuing run closeout without appending runtime events.');
  }
  let verificationFailed = false;
  if (verifyRequested(args)) {
    console.log('Running verification...');
    const verifyResult = runScript('p2a_runs.mjs', verifyRunArgs(args));
    printChildResult(verifyResult);
    verificationFailed = verifyResult.status !== 0;
  }

  const requestedBeforeMonitor = args.status ?? (verificationFailed ? 'failed' : null);
  if (!verificationFailed && (!requestedBeforeMonitor || requestedBeforeMonitor === 'finished')) {
    const monitorResult = applyMonitorGate(args, source);
    if (monitorResult) {
      if (monitorResult.accepted) {
        console.log(`Monitor gate accepted: ${monitorResult.verdict}`);
      } else {
        console.log(`Monitor gate blocked finish: ${monitorResult.verdict} -> ${monitorResult.failureClass}`);
      }
    }
  }

  const requestedStatus = args.status ?? (verificationFailed ? 'failed' : null);
  const finalFailureClass = requestedStatus === 'failed' && !args.failureClass ? 'verification_failed' : args.failureClass;
  if (finalFailureClass && !args.failureClass) args.failureClass = finalFailureClass;

  console.log('Finishing run...');
  const finishResult = runScript('p2a_runs.mjs', finishRunArgs(args, requestedStatus, approvalLink.approval));
  printChildResult(finishResult);
  const run = readRun(source.runsDir, args.runId);
  if (!finishResultAllowsTaskTransition(finishResult, requestedStatus, run)) {
    if (run.status === 'started') {
      console.error(`run finish did not close ${run.runId}; task transition skipped to keep run/task state consistent.`);
    }
    return finishResult.status ?? 1;
  }
  try {
    const runtimeUpdate = updateOrchestrationRuntimeAfterFinish(source, run);
    if (runtimeUpdate?.skipped) {
      console.log(`Orchestration runtime already closed: ${displayPath(runtimeUpdate.filePath)}`);
    } else if (runtimeUpdate) {
      console.log(`Updated orchestration runtime: ${displayPath(runtimeUpdate.filePath)} phase=${runtimeUpdate.runtime.status.phase}`);
    }
  } catch (error) {
    console.error(`warning: orchestration runtime was not updated: ${error.message}`);
  }
  const status = transitionTaskAfterFinishedRun(args, source, run, finishResult.status ?? 0);
  printClosedRunFooter(source, run);
  return status;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'plan') return runPlan(args);
    if (args.command === 'start') return runStart(args);
    if (args.command === 'resume') return runResume(args);
    if (args.command === 'status') return runStatus(args);
    if (args.command === 'finish') return runFinish(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'p2a execute validation failed' : 'p2a execute command failed';
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
