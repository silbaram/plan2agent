#!/usr/bin/env node
/** Supervise one Plan2Agent task lifecycle with the existing task/run CLIs. */

import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FAILURE_CLASSES, FAILURE_RETRYABLE, ISOLATION_MODES } from './p2a_constants.mjs';
import {
  approvedVisualReviewContract,
  loadJson,
  resolveSpecSourceIntake,
  validateProposalDraftApprovalData,
  validateRunData,
  validateRunIndexData,
  validateRunTaskContract,
  validateSchema,
  validateSpec,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  assertRunMonitorGateBinding,
  monitorGateSidecarPath,
  normalizeMonitorVerdictData,
  readMonitorGateSidecar,
} from './p2a_monitor_gate.mjs';
import {
  currentDevelopmentContractPath,
  materializeCurrentDevelopmentContract,
  resolveCurrentDevelopmentState,
  resolveIterationState,
  validateActiveGateBPromotionBinding,
  validateMaintenanceTaskGraphProject,
} from './p2a_iteration_state.mjs';
import {
  assertUnmanagedGraphMutation,
  assertSafeRunId,
  assertStartableRunId,
  canonicalWorkspacePathForArtifactRoot,
  canonicalTaskGraphRef,
  compareRunEvidence,
  compareRunIndexEvidence,
  resolveRunsDir,
  runFilePath,
  runMatchesSourceContext,
  taskGraphRefMatchesGraph,
} from './p2a_run_paths.mjs';
import { pruneIndexedRunEvidence } from './p2a_runs.mjs';
import { minedProposalRunIds } from './p2a_proposal_mining.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';
import { atomicWriteJson, runWriteTransactionPath, withRunStoreLocks } from './p2a_run_store.mjs';
import { commandLine as sharedCommandLine, printRunCommandFooter } from './p2a_run_commands.mjs';
import {
  allocateRunId,
  previewRunId,
  releaseRunIdReservation,
  resolveRunPersistence,
} from './p2a_project_config.mjs';
import {
  artifactRelativePath,
  assertDirectory,
  assertFile,
  displayPath,
  hasInterruptionOptions,
  hasStructuredDetailOptions,
  parseGateReturn,
  parseNonNegativeInteger,
  requiredNonBlankText,
  requiredValue,
  uniqueStrings,
} from './p2a_cli_helpers.mjs';
import { parseVerifyCommand } from './p2a_verification.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const COMMANDS = new Set(['prepare', 'plan', 'start', 'verify-final', 'review', 'accept', 'resume', 'status', 'finish']);
const PREPARE_MODES = new Set(['direct', 'planned']);
const FINISH_STATUSES = new Set(['finished', 'failed', 'blocked']);
const FAILURE_SOURCES = new Set(['owner', 'monitor', 'implementer']);
const USAGE_SOURCES = new Set(['provider', 'manual']);
const IMPLEMENTER_AGENT_TOOLS = new Set(['codex', 'claude', 'manual']);
const REVIEWER_AGENT_TOOLS = new Set(['codex', 'claude', 'gemini', 'manual']);
const DEFAULT_PROJECT_CONFIG = path.join('.plan2agent', 'project.config.json');
const EXECUTION_RESULT_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/execution-result.schema.json', import.meta.url),
  'utf8',
));
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
    '  p2a execute prepare --artifacts <dir> --mode direct|planned --selection-rationale <text> [options]',
    '  p2a execute plan (--artifacts <dir>|--graph <path>) [--task <task-id>] [options]',
    '  p2a execute start (--artifacts <dir>|--graph <path>) [--task <task-id>] [options]',
    '  p2a execute review (--artifacts <dir>|--graph <path>) [--task <task-id>] [options]',
    '  p2a execute accept --artifacts <dir> [--task <task-id>] [options]',
    '  p2a execute resume (--artifacts <dir>|--graph <path>) --run-id <run-id>',
    '  p2a execute status (--artifacts <dir>|--graph <path>) [--task <task-id>] [--run-id <run-id>]',
    '  p2a execute finish (--artifacts <dir>|--graph <path>) --run-id <run-id> [options]',
    '',
    'Commands:',
    '  prepare              Create one synthetic Gate C work item for opt-in direct or planned execution.',
    '  plan                 Resolve one ready task and print the supervised execution plan. No files are changed.',
    '  start                Create a run, mark the task in_progress, and print the manual launcher prompt.',
    '  review               Start the single no-change pre-close visual review run for the iteration.',
    '  accept               Start the single no-change functional acceptance review run for a non-UI iteration.',
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
    'Prepare options:',
    '  --mode direct|planned',
    '  --selection-rationale <text>',
    '  --milestone <id|outcome|command>  Planned only; repeat 2-5 times in execution order.',
    '',
    'Start/plan/verify-final/review/accept options:',
    '  --task <task-id>     Task to execute; for review/accept, optional remediation owner. Start/plan require one ready task when omitted.',
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
    '  --related             Run project-owned relatedVerification commands against changed files.',
    '  --test-command <cmd>, --lint-command <cmd>, --typecheck-command <cmd>',
    '  --verify-command <type:cmd>',
    '                          type is required: test, lint, typecheck, or custom.',
    '  --save-config',
    '  --status finished|failed|blocked',
    '  --failure-class <class>',
    '  --retryable yes|no|after_fix',
    '  --needs-user-decision true|false',
    '  --failure-source owner|monitor|implementer',
    '  --collect-git',
    '  --changed-file <path>   Repeatable.',
    '  --note <text>           Repeatable.',
    '  --usage-model <profile>',
    '  --usage-input-tokens <n>, --usage-output-tokens <n>',
    '  --usage-source provider|manual',
    '  --implementation-interruption <text>  Repeatable.',
    '  --user-correction <text> Repeatable.',
    '  --gate-return valid|invalid:<text>  Repeatable.',
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
    '  --json                  start/resume/review/accept: emit one machine-readable result document.',
    '',
    '  --help, -h          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  const providedOptions = new Set();

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
    usageModel: null,
    usageInputTokens: null,
    usageOutputTokens: null,
    usageSource: null,
    implementationInterruptions: [],
    userCorrections: [],
    gateReturns: [],
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
    mode: null,
    selectionRationale: null,
    milestones: [],
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--') && arg !== '--help') providedOptions.add(arg);
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--spec') args.spec = requiredValue(argv, ++index, '--spec');
    else if (arg === '--maintenance') args.maintenance = true;
    else if (arg === '--mode') args.mode = requiredValue(argv, ++index, '--mode');
    else if (arg === '--selection-rationale') args.selectionRationale = requiredNonBlankText(argv, ++index, '--selection-rationale');
    else if (arg === '--milestone') args.milestones.push(parseExecutionMilestone(requiredValue(argv, ++index, '--milestone', { allowLeadingDash: true })));
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
    else if (arg === '--usage-model') args.usageModel = requiredNonBlankText(argv, ++index, '--usage-model');
    else if (arg === '--usage-input-tokens') args.usageInputTokens = parseNonNegativeInteger(requiredValue(argv, ++index, '--usage-input-tokens'), '--usage-input-tokens');
    else if (arg === '--usage-output-tokens') args.usageOutputTokens = parseNonNegativeInteger(requiredValue(argv, ++index, '--usage-output-tokens'), '--usage-output-tokens');
    else if (arg === '--usage-source') {
      args.usageSource = requiredValue(argv, ++index, '--usage-source');
      if (!USAGE_SOURCES.has(args.usageSource)) throw new Error('--usage-source must be provider or manual');
    }
    else if (arg === '--implementation-interruption') args.implementationInterruptions.push(requiredNonBlankText(argv, ++index, '--implementation-interruption'));
    else if (arg === '--user-correction') args.userCorrections.push(requiredNonBlankText(argv, ++index, '--user-correction'));
    else if (arg === '--gate-return') args.gateReturns.push(parseGateReturn(requiredValue(argv, ++index, '--gate-return', { allowLeadingDash: true })));
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
    else if (arg === '--related') args.verifyOptions.push('--related');
    else if (arg === '--test-command') args.verifyOptions.push('--test-command', requiredValue(argv, ++index, '--test-command', { allowLeadingDash: true }));
    else if (arg === '--lint-command') args.verifyOptions.push('--lint-command', requiredValue(argv, ++index, '--lint-command', { allowLeadingDash: true }));
    else if (arg === '--typecheck-command') args.verifyOptions.push('--typecheck-command', requiredValue(argv, ++index, '--typecheck-command', { allowLeadingDash: true }));
    else if (arg === '--verify-command') {
      const value = requiredValue(argv, ++index, '--verify-command', { allowLeadingDash: true });
      parseVerifyCommand(value);
      args.verifyOptions.push('--verify-command', value);
    }
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
  if (args.json && !['start', 'resume', 'verify-final', 'review', 'accept'].includes(args.command)) {
    throw new Error('--json is only supported with start, resume, verify-final, review, or accept');
  }
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
  if (args.command === 'prepare') {
    if (!args.artifacts || args.graph) throw new Error('prepare requires --artifacts');
    if (args.maintenance || args.taskId || args.approval) throw new Error('prepare does not support --maintenance, --task, or --approval');
    if (!PREPARE_MODES.has(args.mode)) throw new Error('prepare --mode must be direct or planned');
    if (!args.selectionRationale) throw new Error('--selection-rationale is required for prepare');
    if (args.mode === 'direct' && args.milestones.length) throw new Error('direct execution does not accept --milestone');
    if (args.mode === 'planned' && (args.milestones.length < 2 || args.milestones.length > 5)) {
      throw new Error('planned execution requires 2-5 --milestone values');
    }
    const allowedPrepareOptions = new Set(['--artifacts', '--mode', '--selection-rationale', '--milestone']);
    const unsupportedPrepareOptions = [...providedOptions]
      .filter((option) => !allowedPrepareOptions.has(option))
      .sort();
    if (unsupportedPrepareOptions.length) {
      throw new Error(`prepare does not support option(s): ${unsupportedPrepareOptions.join(', ')}`);
    }
  } else if (args.mode || args.selectionRationale || args.milestones.length) {
    throw new Error('--mode, --selection-rationale, and --milestone are only supported with prepare');
  }
  if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
  if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  if (args.graph && ['start', 'review', 'accept', 'finish'].includes(args.command)) {
    assertUnmanagedGraphMutation(args.graph, `p2a execute ${args.command}`);
  }
  if (['finish', 'resume'].includes(args.command) && !args.runId) throw new Error(`--run-id is required for ${args.command}`);
  if (args.runReservationToken && (!['start', 'verify-final', 'review', 'accept'].includes(args.command) || !args.runId)) {
    throw new Error('--run-reservation-token requires start, verify-final, review, or accept with --run-id');
  }
  if (args.command === 'status' && !args.taskId && !args.runId && !args.approval) throw new Error('--task, --approval, or --run-id is required for status');
  if (['plan', 'start'].includes(args.command) && !IMPLEMENTER_AGENT_TOOLS.has(args.agentTool)) {
    throw new Error('--agent-tool for implementation must be one of codex, claude, or manual; Gemini is read-only and may only be used as a reviewer/monitor');
  }
  if (['verify-final', 'review', 'accept'].includes(args.command) && !REVIEWER_AGENT_TOOLS.has(args.agentTool)) {
    throw new Error('--agent-tool for final verification/review must be one of codex, claude, gemini, or manual');
  }
  if (args.command !== 'finish' && args.verifyOptions.length) {
    throw new Error('verification options are only supported with finish');
  }
  if (args.requireMonitor && args.command !== 'start') {
    throw new Error('--require-monitor is only supported with start');
  }
  const hasUsage = [args.usageModel, args.usageInputTokens, args.usageOutputTokens, args.usageSource]
    .some((value) => value !== null);
  if (hasUsage && (args.usageModel === null || args.usageInputTokens === null || args.usageOutputTokens === null)) {
    throw new Error('--usage-model, --usage-input-tokens, and --usage-output-tokens are required together');
  }
  if (hasUsage && !Number.isSafeInteger(args.usageInputTokens + args.usageOutputTokens)) {
    throw new Error('usage input and output token total exceeds the safe integer range');
  }
  if (hasUsage) args.usageSource ??= 'manual';
  if (args.command !== 'finish' && (args.status || args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource || args.collectGit || args.saveConfig || hasStructuredDetailOptions(args) || hasUsage || hasInterruptionOptions(args))) {
    throw new Error('finish options are only supported with finish');
  }
  return args;
}

function parseExecutionMilestone(value) {
  const parts = value.split('|').map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('--milestone must use id|outcome|command');
  }
  return { id: parts[0], outcome: parts[1], verification: [parts[2]] };
}

function warnGraphMode() {
  console.error('warning: --graph mode does not check Gate B/D prerequisites; use --artifacts for approved iterative execution.');
}

function loadProjectConfig(source, workspacePath) {
  const candidates = [
    path.join(workspacePath, DEFAULT_PROJECT_CONFIG),
    path.join(ROOT, DEFAULT_PROJECT_CONFIG),
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

function warnRunCleanupFailures(cleanup) {
  if (!cleanup?.cleanupFailures?.length) return;
  console.error(`warning: ${cleanup.cleanupFailures.length} unindexed run evidence file(s) could not be removed`);
  for (const failure of cleanup.cleanupFailures) console.error(`- ${failure}`);
}

function pruneCompletedMaintenanceRunHistory(source, currentTask, config, { quiet = false } = {}) {
  if (
    source.sourceLayout !== 'maintenance'
    || resolveRunPersistence(config) !== 'active_only'
  ) return null;
  const completedTaskIds = source.graph.tasks
    .filter((task) => task.id !== currentTask.id && task.status === 'done')
    .map((task) => task.id);
  if (!completedTaskIds.length) return null;
  const cleanup = pruneIndexedRunEvidence(source.runsDir, {
    iterationIds: ['maintenance'],
    taskIds: completedTaskIds,
    summaryReason: 'completed_maintenance',
  });
  warnRunCleanupFailures(cleanup);
  if (!quiet && cleanup.prunedRunIds.length) {
    console.log(`Transient run cleanup: removed ${cleanup.prunedRunIds.length} completed maintenance run(s)`);
  }
  return cleanup;
}

function pruneSupersededRunHistory(source, run, { quiet = false } = {}) {
  if (run.status !== 'finished' || !source.artifactRoot) return null;
  try {
    const config = loadProjectConfig(source, run.workspacePath ?? process.cwd());
    if (resolveRunPersistence(config) !== 'active_only') return null;
    const keepRunIds = [run.runId];
    const proposals = config?.proposals;
    let retainedUnminedRunIds = [];
    if (proposals?.enabled === true) {
      const minedRunIds = minedProposalRunIds(run.workspacePath ?? process.cwd(), proposals);
      const runIndex = loadJson(path.join(source.runsDir, 'run-index.json'));
      validateRunIndexData(runIndex);
      retainedUnminedRunIds = runIndex.runs
        .filter((candidate) => (
          candidate.iterationId === run.iterationId
          && candidate.taskId === run.taskId
          && (candidate.runKind ?? null) === (run.runKind ?? null)
          && ['failed', 'blocked'].includes(candidate.status)
          && !minedRunIds.has(candidate.runId)
        ))
        .map((candidate) => candidate.runId);
      keepRunIds.push(...retainedUnminedRunIds);
    }
    const cleanup = pruneIndexedRunEvidence(source.runsDir, {
      iterationIds: [run.iterationId],
      taskIds: [run.taskId],
      runKinds: [run.runKind ?? null],
      keepRunIds,
      requireNoStarted: false,
      summaryReason: 'superseded',
    });
    warnRunCleanupFailures(cleanup);
    if (!quiet && retainedUnminedRunIds.length) {
      console.log(
        `Transient run cleanup: retained ${retainedUnminedRunIds.length} unmined failed/blocked run(s) for proposal mining`,
      );
    }
    if (!quiet && cleanup.prunedRunIds.length) {
      console.log(`Transient run cleanup: removed ${cleanup.prunedRunIds.length} superseded run(s)`);
    }
    return cleanup;
  } catch (error) {
    console.error(`warning: superseded run cleanup was skipped: ${error.message}`);
    return null;
  }
}

function resolveSource(args) {
  if (args.artifacts) {
    const state = args.maintenance
      ? resolveIterationState(args.artifacts, { requireReady: false })
      : resolveCurrentDevelopmentState(args.artifacts);
    if (args.maintenance) {
      const graphPath = path.join(state.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      assertFile(graphPath, 'maintenance task graph');
      const graph = loadJson(graphPath);
      validateTaskGraphData(graph);
      validateMaintenanceTaskGraphProject(state, graph);
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
    const graph = state.taskGraph;
    return {
      projectId: state.projectId,
      sourceArgs: ['--artifacts', args.artifacts],
      sourceLayout: 'iteration',
      iterationId: state.activeIteration,
      artifactRoot: state.artifactRoot,
      graphPath: state.taskGraphPath,
      specPath: state.specPath,
      currentDevelopmentContractPath: state.currentDevelopmentContractPath,
      currentDevelopmentContractRef: state.currentDevelopmentContractRef,
      currentDevelopmentContract: state.currentDevelopmentContract,
      currentDevelopmentContractSha256: state.currentDevelopmentContractSha256,
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

function humanTaskOutcome(task) {
  return typeof task.intent === 'string' && task.intent.trim()
    ? task.intent.trim()
    : task.title;
}

export function approvedSpecTaskIntent(spec, fallback) {
  const goal = Array.isArray(spec?.product?.goals)
    ? spec.product.goals.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
    : null;
  if (!goal) return fallback;
  const outcome = goal.replace(/[.!?]+$/u, '');
  return /[가-힣]/u.test(JSON.stringify(spec.product))
    ? `사용자는 이 작업이 끝나면 다음 결과를 사용할 수 있습니다: ${outcome}.`
    : `Users can rely on this approved outcome: ${outcome}.`;
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
    const summary = ready.map((task) => `${task.id} (${humanTaskOutcome(task)})`).join(', ');
    throw new Error(`multiple ready tasks found; pass --task. Ready tasks: ${summary}`);
  }
  return ready[0];
}

function selectCompletedVisualTask(source, taskId = null) {
  const candidates = source.graph.tasks.filter((task) => (
    task.status === 'done' && task.visualImpact
  ));
  if (taskId) {
    const task = requireTask(source, taskId);
    if (task.status !== 'done') {
      throw new Error(`${task.id} must be done before final visual review; current status is ${task.status}`);
    }
    if (!task.visualImpact) {
      throw new Error(`${task.id} does not affect the approved visual experience`);
    }
    return task;
  }
  if (candidates.length === 0) throw new Error('no completed visual task is available for final review');
  return candidates[0];
}

function sourceSpecPath(source) {
  if (source.specPath) return source.specPath;
  if (path.isAbsolute(source.graph.sourceSpec)) return source.graph.sourceSpec;
  return path.resolve(path.dirname(source.graphPath), source.graph.sourceSpec);
}

function sourceHasRequiredVisualContract(source) {
  if (source.sourceLayout === 'maintenance') return false;
  if (source.currentDevelopmentContract) {
    return Boolean(source.currentDevelopmentContract.visualContract);
  }
  return Boolean(approvedVisualReviewContract(
    sourceSpecPath(source),
    source.sourceLayout === 'graph' ? null : source.artifactRoot,
  ));
}

function selectCompletedAcceptanceTask(source, taskId = null) {
  if (sourceHasRequiredVisualContract(source)) {
    throw new Error('functional acceptance review is not used when Gate B requires a final visual review');
  }
  if (taskId) {
    const task = requireTask(source, taskId);
    if (task.status !== 'done') {
      throw new Error(`${task.id} must be done before final acceptance review; current status is ${task.status}`);
    }
    return task;
  }
  const task = source.graph.tasks.find((candidate) => candidate.status === 'done');
  if (!task) throw new Error('no completed task is available for final acceptance review');
  return task;
}

function selectCompletedFinalVerificationTask(source, taskId = null) {
  if (taskId) {
    const task = requireTask(source, taskId);
    if (task.status !== 'done') {
      throw new Error(`${task.id} must be done before final verification; current status is ${task.status}`);
    }
    return task;
  }
  const task = [...source.graph.tasks].reverse().find((candidate) => candidate.status === 'done');
  if (!task) throw new Error('no completed task is available to own final verification evidence');
  return task;
}

function currentSourceGraph(source) {
  const graph = loadJson(source.graphPath);
  validateTaskGraphData(graph);
  return { ...source, graph };
}

function maintenanceRetrospectiveReportPath(source, taskId) {
  const workspaceRoot = canonicalWorkspacePathForArtifactRoot(source.artifactRoot);
  return path.join(
    workspaceRoot,
    'docs',
    'retrospective',
    `${source.projectId}-maintenance-${taskId}.md`,
  );
}

function printMaintenanceCompletionChoices(source, run) {
  if (source.sourceLayout !== 'maintenance' || run.status !== 'finished') return;
  try {
    const current = currentSourceGraph(source);
    if (!current.graph.tasks.length || current.graph.tasks.some((task) => task.status !== 'done')) return;
    const reportPath = maintenanceRetrospectiveReportPath(current, run.taskId);
    console.log('');
    console.log('Maintenance development is complete. Choose one:');
    console.log('1. Review the completed maintenance changes and remediate any material finding.');
    console.log('2. Review the P2A development process; ask once about delay, errors, wrong routing, or unnecessary steps.');
    console.log(`   After explicit approval, write the minimal retrospective report to ${reportPath}`);
    console.log('3. Finish maintenance without an optional review or retrospective.');
  } catch (error) {
    console.error(`warning: maintenance completion choices were not rendered: ${error.message}`);
  }
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
  resolveRunPersistence(config);
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

function finalReviewWorkspace(args, source, reviewLabel = 'visual') {
  if (args.changedFiles.length) {
    throw new Error(`final ${reviewLabel} review is review-only and does not allow --changed-file`);
  }
  if (args.createIsolation || args.branch || args.worktree || (args.isolation && args.isolation !== 'none')) {
    throw new Error(`final ${reviewLabel} review must use --isolation none in the canonical integration workspace`);
  }
  if (!source.artifactRoot && !args.workspace) {
    throw new Error(`--workspace is required for final ${reviewLabel} review in --graph mode`);
  }
  const canonicalWorkspacePath = source.artifactRoot
    ? canonicalWorkspacePathForArtifactRoot(source.artifactRoot)
    : path.resolve(args.workspace);
  assertDirectory(canonicalWorkspacePath, 'canonical integration workspace');
  if (
    args.workspace
    && realpathSync(path.resolve(args.workspace)) !== realpathSync(canonicalWorkspacePath)
  ) {
    throw new Error(
      `final ${reviewLabel} review workspace must be the canonical integration workspace ${canonicalWorkspacePath}`,
    );
  }
  return canonicalWorkspacePath;
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

function printChildResult(result, options = {}) {
  if (result.stdout && !options.suppressStdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function recordExecutionResult(args, command, run) {
  args.executionResult = {
    schema_version: 'p2a.execution_result.v1',
    command,
    outcome: 'succeeded',
    taskId: run.taskId,
    runId: run.runId,
    runStatus: run.status,
    mode: run.mode ?? 'orchestrated',
    runKind: run.runKind ?? null,
  };
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

function reopenTaskAfterFinalReviewArgs(source, run) {
  const failureClass = run.failure?.class ?? run.status;
  const reviewLabel = run.runKind === 'final_acceptance_review'
    ? 'acceptance'
    : (run.runKind === 'final_visual_review' ? 'visual' : 'verification');
  return [
    'todo',
    ...source.sourceArgs,
    run.taskId,
    '--reopen',
    '--note',
    `Final ${reviewLabel} run ${run.runId} ended ${run.status} (${failureClass}); implementation remediation is required before another final pass.`,
  ];
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
  if (args.runKind) runArgs.push('--run-kind', args.runKind);
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
  const relatedFilesAlreadyRecorded = args.verifyOptions.includes('--related');
  if (finalStatus) runArgs.push('--status', finalStatus);
  if (args.failureClass) runArgs.push('--failure-class', args.failureClass);
  if (args.retryable) runArgs.push('--retryable', args.retryable);
  if (args.needsUserDecision !== null) runArgs.push('--needs-user-decision', args.needsUserDecision);
  if (args.failureSource) runArgs.push('--failure-source', args.failureSource);
  if (args.collectGit && !relatedFilesAlreadyRecorded) runArgs.push('--collect-git');
  if (args.workspace) runArgs.push('--workspace', args.workspace);
  if (!relatedFilesAlreadyRecorded) {
    for (const changedFile of args.changedFiles) runArgs.push('--changed-file', changedFile);
  }
  for (const note of uniqueStrings([...approvalRunNotes(approval), ...args.notes])) runArgs.push('--note', note);
  if (args.usageModel !== null) {
    runArgs.push('--usage-model', args.usageModel);
    runArgs.push('--usage-input-tokens', String(args.usageInputTokens));
    runArgs.push('--usage-output-tokens', String(args.usageOutputTokens));
    runArgs.push('--usage-source', args.usageSource);
  }
  for (const summary of args.implementationInterruptions) runArgs.push('--implementation-interruption', summary);
  for (const summary of args.userCorrections) runArgs.push('--user-correction', summary);
  for (const gateReturn of args.gateReturns) runArgs.push('--gate-return', `${gateReturn.assessment}:${gateReturn.summary}`);
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
  if (args.collectGit) runArgs.push('--collect-git');
  for (const changedFile of args.changedFiles) runArgs.push('--changed-file', changedFile);
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
    return normalizeMonitorVerdictData(data, {
      requiredConcernFields: sidecar.requiredConcernFields,
      requiredRuleIds: sidecar.ruleContract?.ruleIds,
      requireRulesReviewed: sidecar.ruleContract !== null,
    });
  } catch (error) {
    throw new Error(`${error.message}: ${displayPath(verdictPath)}`);
  }
}

function applyMonitorGate(args, source, run) {
  const sidecar = readOrchestrationSidecar(source.runsDir, args.runId);
  assertRunMonitorGateBinding(run, sidecar);
  if (!sidecar?.required) return null;
  const verdict = readMonitorVerdict(source, sidecar);
  if (sidecar.acceptedVerdicts.includes(verdict.verdict) && !verdict.hasConcerns) {
    return { sidecar, verdict: verdict.verdict, accepted: true };
  }
  const mappedFailureClass = sidecar.failureClassMap[verdict.failureSignal]
    ?? sidecar.failureClassMap[verdict.verdict]
    ?? 'other';
  return {
    sidecar,
    verdict: verdict.failureSignal,
    accepted: false,
    failureClass: mappedFailureClass,
    needsUserDecision: verdict.needsUserDecision,
  };
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

function assertRunMatchesSourceContext(run, source) {
  if (runMatchesSourceContext(run, source)) return;
  throw new Error(
    `run ${run.runId} is outside the current execution context: expected ${source.sourceLayout} `
    + `iteration ${source.iterationId ?? 'null'} for ${source.taskGraphRef}`,
  );
}

function assertRunExecutionContractCurrent(run, source, operation) {
  try {
    validateRunTaskContract(run, path.dirname(path.resolve(source.runsDir)), {
      runsDir: source.runsDir,
    });
  } catch (error) {
    throw new Error(
      `${operation} blocked because run ${run.runId} no longer matches its recorded execution contract: ${error.message}`,
      { cause: error },
    );
  }
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
  console.log('');
  console.log('[한눈에]');
  console.log(`이번 작업이 끝나면: ${humanTaskOutcome(task)}`);
  console.log('진행하면 → 구현한 결과를 확인 절차까지 거쳐 완료합니다.');
  console.log('문제가 생기면 → 완료로 처리하지 않고 원인과 필요한 도움을 보고합니다.');
  console.log('');
  console.log('[실행 명령]');
  const startArgs = executeStartArgs(args, task, runId, defaults);
  console.log(`- ${commandLine('p2a_execute.mjs', startArgs)}`);
  if (runId) {
    console.log(`- ${commandLine('p2a_execute.mjs', ['finish', ...sourceRunArgs(args), ...(args.approval ? ['--approval', args.approval] : []), '--run-id', runId, '--test', '--lint', '--typecheck'])}`);
  }
  console.log('');
  console.log('[세부 계약]');
  console.log(`- project: ${source.projectId}`);
  console.log(`- source: ${source.sourceLayout}`);
  console.log(`- task: ${task.id} - ${humanTaskOutcome(task)}`);
  console.log(`- executionMode: ${source.graph.execution?.mode ?? 'orchestrated'}`);
  if (source.graph.execution?.selectionRationale) console.log(`- selectionRationale: ${source.graph.execution.selectionRationale}`);
  if (source.graph.execution?.milestones) {
    console.log(`- milestones: ${source.graph.execution.milestones.map((milestone) => milestone.id).join(', ')}`);
  }
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
}

function printLauncherPrompt(source, task, runId, approvalLink = null, options = {}) {
  console.log('');
  console.log('Manual launcher prompt');
  console.log('');
  console.log('[한눈에]');
  console.log(`이번 작업이 끝나면: ${humanTaskOutcome(task)}`);
  console.log('문제가 생기면: 완료로 처리하지 말고 확인한 원인과 필요한 도움을 보고합니다.');
  console.log('');
  console.log('[세부 계약]');
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
  console.log('- The owner will run p2a execute finish or p2a runs verify/finish after implementation.');
  console.log('- Report changed files, verification commands, results, and blockers.');
  console.log('');
  const promptResult = runScript('p2a_tasks.mjs', promptArgs(source, task.id));
  printChildResult(promptResult, { suppressStdout: options.suppressPrompt === true });
  console.log('---');
}

function printFinalVisualReviewInstructions(args, source, task, runId, workspacePath) {
  console.log('');
  console.log('Plan2Agent final visual review');
  console.log(`- iteration: ${source.iterationId}`);
  console.log(`- remediation owner: ${task.id} - ${humanTaskOutcome(task)}`);
  console.log(`- runId: ${runId}`);
  console.log(`- workspace: ${displayPath(workspacePath)}`);
  console.log('- isolation: none');
  console.log('- changedFiles: 0');
  console.log('');
  console.log('Next:');
  console.log(`1. Snapshot the canonical workspace: ${commandLine('p2a_runs.mjs', ['revision', ...source.sourceArgs, '--run-id', runId])}`);
  console.log('2. Capture the complete approved screen/state/viewport matrix and write the accessibility report plus .visual-review.json sidecar.');
  console.log(`3. Finish without changing task state: ${commandLine('p2a_execute.mjs', ['finish', ...source.sourceArgs, '--run-id', runId])}`);
}

function printFinalVerificationInstructions(source, task, run, workspacePath) {
  console.log('');
  console.log('Plan2Agent final full verification');
  console.log(`- iteration: ${source.iterationId}`);
  console.log(`- remediation owner: ${task.id} - ${humanTaskOutcome(task)}`);
  console.log(`- runId: ${run.runId}`);
  console.log(`- workspace: ${displayPath(workspacePath)}`);
  console.log('- isolation: none');
  console.log('- changedFiles: 0');
  console.log('');
  console.log('Next:');
  console.log(`1. Run every configured full verification command once: ${commandLine('p2a_runs.mjs', ['verify', ...source.sourceArgs, '--run-id', run.runId])}`);
  console.log(`2. Finish the evidence run; failure reopens the remediation owner: ${commandLine('p2a_execute.mjs', ['finish', ...source.sourceArgs, '--run-id', run.runId])}`);
}

function acceptanceCandidateEvidenceCount(run) {
  return (run.verification ?? []).filter((item) => (
    (item.source === 'command' || item.source === 'config')
    && item.status === 'passed'
    && item.exitCode === 0
    && typeof item.stdoutTail === 'string'
    && item.stdoutTail.trim().length > 0
  )).length;
}

function printFinalAcceptanceReviewInstructions(source, task, run, workspacePath) {
  const runId = run.runId;
  const criteriaCount = run.acceptanceReview?.criteria?.length ?? 0;
  console.log('');
  console.log('Plan2Agent final functional acceptance review');
  console.log(`- iteration: ${source.iterationId}`);
  console.log(`- remediation owner: ${task.id} - ${humanTaskOutcome(task)}`);
  console.log(`- runId: ${runId}`);
  console.log(`- workspace: ${displayPath(workspacePath)}`);
  console.log('- isolation: none');
  console.log('- changedFiles: 0');
  console.log(`- criteria: ${criteriaCount}`);
  console.log(`- candidateEvidence: ${acceptanceCandidateEvidenceCount(run)}`);
  console.log('');
  console.log('Next:');
  console.log(`1. Record configured full verification for this canonical revision: ${commandLine('p2a_runs.mjs', ['verify', ...source.sourceArgs, '--run-id', runId])}`);
  console.log(`2. Run each Gate B behavior case as owner-recorded evidence: ${commandLine('p2a_runs.mjs', ['verify', ...source.sourceArgs, '--run-id', runId, '--verify-command', 'custom:<behavior-command>'])}`);
  console.log(`3. Preflight the exact ${criteriaCount}-criterion current-iteration run contract. Do not substitute the cumulative product spec or a summarized subset; map every criterion ref to relevant verbatim command evidence.`);
  console.log('4. If any criterion lacks relevant evidence, record more behavior evidence or block the run without invoking the acceptance reviewer.');
  console.log('5. Only after the preflight passes, give the exact run contract and recorded verification output to the read-only acceptance reviewer; write <runId>.acceptance-review.json beside the run.');
  console.log(`6. Finish the review; confirmation keeps the task done, while blocked/failed status reopens the remediation owner: ${commandLine('p2a_execute.mjs', ['finish', ...source.sourceArgs, '--run-id', runId])}`);
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
  if (
    run.runKind === 'final_verification'
    || run.runKind === 'final_visual_review'
    || run.runKind === 'final_acceptance_review'
  ) {
    const reviewLabel = run.runKind === 'final_acceptance_review'
      ? 'acceptance'
      : (run.runKind === 'final_visual_review' ? 'visual' : 'verification');
    if (run.status === 'finished') {
      if (task.status !== 'done') {
        console.error(`final ${reviewLabel} review transition skipped: ${task.id} must remain done after a confirming review; current status is ${task.status}`);
        return 1;
      }
      console.log(`Task transition already applied: ${task.id} remains done after final ${reviewLabel} review`);
      return successStatus;
    }
    if (task.status === 'todo' || task.status === 'in_progress') {
      console.log(`Final ${reviewLabel} review remediation already started: ${task.id} status is ${task.status}`);
      return successStatus;
    }
    if (task.status !== 'done') {
      console.error(`final ${reviewLabel} review remediation skipped: ${task.id} must be done before reopen; current status is ${task.status}`);
      return 1;
    }
    console.log(`Reopening task ${task.id} after ${run.status} final ${reviewLabel} review...`);
    const reopenResult = runScript(
      'p2a_tasks.mjs',
      reopenTaskAfterFinalReviewArgs(source, run),
    );
    printChildResult(reopenResult);
    if (reopenResult.status !== 0) return reopenResult.status ?? 1;
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
  if (status === 0 && !args.noTaskTransition) {
    pruneSupersededRunHistory(source, run, { quiet: args.json });
    printMaintenanceCompletionChoices(source, run);
  }
  printClosedRunFooter(source, run);
  return status;
}

function finishResultAllowsTaskTransition(result, requestedStatus, run) {
  if (run.status === 'started') return false;
  if (result.status === 0) return true;
  if (requestedStatus === 'failed' && result.status === 1 && run.status === 'failed') return true;
  return false;
}

function runPrepare(args) {
  const requestedArtifactRoot = path.resolve(args.artifacts);
  assertDirectory(requestedArtifactRoot, '--artifacts');
  const hasCurrentSpec = existsSync(path.join(requestedArtifactRoot, 'current-spec.json'));
  const hasIterations = existsSync(path.join(requestedArtifactRoot, 'iterations'));
  if (hasCurrentSpec !== hasIterations) {
    throw new Error('prepare requires either a complete iterative layout or a flat Gate B artifact root');
  }
  const iterative = hasCurrentSpec && hasIterations;
  const state = iterative
    ? resolveIterationState(requestedArtifactRoot, { requireReady: false })
    : {
        projectId: null,
        artifactRoot: requestedArtifactRoot,
        currentSpec: null,
        activeIteration: 'v1-mvp',
        iterationRoot: requestedArtifactRoot,
        specPath: path.join(requestedArtifactRoot, 'gate-b-spec', 'spec.json'),
        taskGraphPath: path.join(requestedArtifactRoot, 'gate-c-task-graph', 'task-graph.json'),
      };
  const runsDir = path.join(state.artifactRoot, 'runs');
  const lockDirs = iterative
    ? [path.join(state.artifactRoot, 'iterations'), path.dirname(state.taskGraphPath)]
    : [state.iterationRoot];
  if (existsSync(runsDir)) lockDirs.push(runsDir);
  return withRunStoreLocks(lockDirs, () => {
    const lockedState = iterative
      ? resolveIterationState(requestedArtifactRoot, { requireReady: false })
      : state;
    if (
      iterative
      && (
        lockedState.activeIteration !== state.activeIteration
        || path.resolve(lockedState.taskGraphPath) !== path.resolve(state.taskGraphPath)
      )
    ) {
      throw new Error('active iteration changed while prepare was waiting for state locks; retry the command');
    }
    if (existsSync(lockedState.taskGraphPath)) {
      throw new Error(`Gate C task graph already exists: ${displayPath(lockedState.taskGraphPath)}`);
    }
    assertFile(lockedState.specPath, iterative
      ? `iterations/${lockedState.activeIteration}/gate-b-spec/spec.json`
      : 'gate-b-spec/spec.json');
    const specReference = loadJson(lockedState.specPath);
    const sourceIntakePath = resolveSpecSourceIntake(lockedState.specPath, specReference);
    const spec = validateSpec(lockedState.specPath, sourceIntakePath, {
      artifactRoot: lockedState.artifactRoot,
      ...(lockedState.projectId ? { projectId: lockedState.projectId } : {}),
    });
    const projectId = lockedState.projectId ?? spec.project_id;
    if (spec.approval !== 'approved') throw new Error('prepare requires an approved Gate B spec');
    if (spec.open_decisions.length) throw new Error('prepare is blocked while spec.open_decisions is non-empty');
    if ((lockedState.currentSpec?.open_decisions ?? []).length) {
      throw new Error('prepare is blocked while current-spec.json open_decisions is non-empty');
    }
    if (spec.project_id !== projectId) {
      throw new Error(`spec.project_id ${JSON.stringify(spec.project_id)} does not match ${JSON.stringify(projectId)}`);
    }
    const runIndexPath = path.join(runsDir, 'run-index.json');
    if (existsSync(runIndexPath)) {
      const runIndex = validateRunIndexData(loadJson(runIndexPath));
      if (runIndex.projectId !== projectId) {
        throw new Error(`run-index projectId ${JSON.stringify(runIndex.projectId)} does not match ${JSON.stringify(projectId)}`);
      }
      const executionHistory = runIndex.runs.filter((entry) => (
        entry.iterationId === lockedState.activeIteration
        && taskGraphRefMatchesGraph(entry.taskGraphRef, lockedState.taskGraphPath, lockedState.artifactRoot)
      ));
      if (executionHistory.length) {
        const examples = executionHistory.slice(0, 5)
          .map((entry) => `${entry.runId}:${entry.status}`)
          .join(', ');
        throw new Error(
          `prepare cannot recreate a missing Gate C graph after execution history exists; run(s): ${examples}. `
          + 'Restore the original graph or open a new iteration to preserve run lineage.',
        );
      }
    }
    if (iterative) {
      validateActiveGateBPromotionBinding(lockedState, spec);
    }

    const visualReview = approvedVisualReviewContract(lockedState.specPath, lockedState.artifactRoot);
    const acceptanceCriteria = uniqueStrings([
      ...spec.product.core_flows,
      ...spec.product.success_criteria,
    ]);
    const taskTitle = `Deliver approved ${lockedState.activeIteration} objective`;
    const task = {
      id: 'task-001',
      title: taskTitle,
      intent: approvedSpecTaskIntent(spec, taskTitle),
      description: spec.product.problem,
      status: 'todo',
      dependencies: [],
      acceptanceCriteria,
      targetArea: 'approved iteration objective',
      workKind: visualReview ? 'mixed' : 'non_ui',
      suggestedAgentPrompt: 'Deliver the approved Gate B objective inside the bound execution envelope and verify it to close-ready.',
      sourceSpecRefs: [
        'product.goals',
        'product.must_preserve',
        'product.non_goals',
        'product.core_flows',
        'product.success_criteria',
        'implementation.verification',
      ],
      ...(visualReview ? {
        visualImpact: {
          screenStates: structuredClone(visualReview.screenStates),
        },
      } : {}),
    };
    const graph = {
      schema_version: 'p2a.task_graph.v1',
      projectId,
      version: lockedState.activeIteration,
      sourceSpec: '../gate-b-spec/spec.json',
      execution: {
        mode: args.mode,
        selectionRationale: args.selectionRationale,
        syntheticWorkItem: true,
        ...(args.mode === 'planned' ? { milestones: structuredClone(args.milestones) } : {}),
      },
      tasks: [task],
    };
    validateTaskGraphData(graph, lockedState.specPath, {
      artifactPath: lockedState.taskGraphPath,
      artifactRoot: lockedState.artifactRoot,
      projectId,
    });
    atomicWriteJson(lockedState.taskGraphPath, graph);
    if (iterative) {
      try {
        atomicWriteJson(
          currentDevelopmentContractPath(lockedState.artifactRoot),
          materializeCurrentDevelopmentContract(lockedState),
        );
      } catch (error) {
        unlinkSync(lockedState.taskGraphPath);
        throw error;
      }
    }
    console.log('Prepared adaptive execution');
    console.log(`- mode: ${args.mode}`);
    console.log(`- rationale: ${args.selectionRationale}`);
    console.log(`- graph: ${displayPath(lockedState.taskGraphPath)}`);
    if (iterative) {
      console.log(`- current contract: ${displayPath(currentDevelopmentContractPath(lockedState.artifactRoot))}`);
    }
    if (args.mode === 'planned') console.log(`- milestones: ${args.milestones.map((milestone) => milestone.id).join(', ')}`);
    const next = iterative
      ? commandLine('p2a_execute.mjs', ['start', '--artifacts', args.artifacts])
      : commandLine('p2a_iteration.mjs', ['init', '--artifacts', args.artifacts]);
    console.log(`- next: ${next}`);
    return 0;
  });
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
    printChildResult(runResult, { suppressStdout: args.json });
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

    try {
      pruneCompletedMaintenanceRunHistory(source, task, defaults.config, { quiet: args.json });
    } catch (error) {
      console.error(`warning: completed maintenance run cleanup was skipped: ${error.message}`);
    }

    const startedRun = readRun(source.runsDir, runId);
    assertRunExecutionContractCurrent(startedRun, source, 'launcher prompt');
    printLauncherPrompt(source, task, runId, approvalLink, { suppressPrompt: args.json });
    printRunCommandFooter(P2A_PATHS, {
      sourceArgs: source.sourceArgs,
      runId,
      heading: 'Run commands:',
    });
    recordExecutionResult(args, 'start', startedRun);
    return 0;
  });
}

function runVerifyFinal(args) {
  const initialSource = resolveSource(args);
  return withRunStoreLocks([path.dirname(initialSource.graphPath)], () => {
    const source = currentSourceGraph(initialSource);
    if (!args.artifacts || args.approval || args.maintenance || source.sourceLayout !== 'iteration') {
      throw new Error('final verification requires --artifacts for a feature iteration');
    }
    const unfinishedTasks = source.graph.tasks.filter((candidate) => candidate.status !== 'done');
    if (unfinishedTasks.length) {
      throw new Error(
        `final verification requires every iteration task to be done; unfinished task(s): ${unfinishedTasks.map((candidate) => `${candidate.id}:${candidate.status}`).join(', ')}`,
      );
    }
    const task = selectCompletedFinalVerificationTask(source, args.taskId);
    const activeTask = source.graph.tasks.find((candidate) => hasStartedRunForTask(source, candidate.id));
    if (activeTask) {
      throw new Error(`${activeTask.id} already has a started run; finish or block it before final verification`);
    }
    const workspacePath = finalReviewWorkspace(args, source, 'verification');
    args.workspace = workspacePath;
    args.isolation = 'none';
    args.runKind = 'final_verification';
    args.notes = uniqueStrings([
      ...args.notes,
      `FINAL_VERIFICATION: iteration=${source.iterationId}; canonical workspace=${workspacePath}`,
    ]);
    const identity = resolveStartIdentity(args, source, task, { reserve: true });
    const { runId, defaults } = identity;
    args.runReservationToken = identity.reservationToken;
    const runResult = runScript(
      'p2a_runs.mjs',
      startRunArgs(args, task, runId, defaults),
    );
    printChildResult(runResult, { suppressStdout: args.json });
    if (runResult.status !== 0) {
      console.error('Final verification run did not start. Correct the cause, then retry with the same reserved run id:');
      console.error(commandLine('p2a_execute.mjs', [
        'verify-final',
        ...source.sourceArgs,
        '--agent-tool', args.agentTool,
        '--run-id', runId,
        '--workspace', workspacePath,
        ...(identity.reservationToken ? ['--run-reservation-token', identity.reservationToken] : []),
      ]));
      return runResult.status ?? 1;
    }
    const startedRun = readRun(source.runsDir, runId);
    assertRunExecutionContractCurrent(startedRun, source, 'final verification');
    printFinalVerificationInstructions(source, task, startedRun, workspacePath);
    printRunCommandFooter(P2A_PATHS, {
      sourceArgs: source.sourceArgs,
      runId,
      heading: 'Run commands:',
    });
    recordExecutionResult(args, 'verify-final', startedRun);
    return 0;
  });
}

function runReview(args) {
  const initialSource = resolveSource(args);
  return withRunStoreLocks([path.dirname(initialSource.graphPath)], () => {
    const source = currentSourceGraph(initialSource);
    if (args.approval || args.maintenance) {
      throw new Error('final visual review is only supported for a feature iteration task');
    }
    const unfinishedTasks = source.graph.tasks.filter((candidate) => candidate.status !== 'done');
    if (unfinishedTasks.length) {
      throw new Error(
        `final visual review requires every iteration task to be done; unfinished task(s): ${unfinishedTasks.map((candidate) => `${candidate.id}:${candidate.status}`).join(', ')}`,
      );
    }
    const task = selectCompletedVisualTask(source, args.taskId);
    const activeTask = source.graph.tasks.find((candidate) => hasStartedRunForTask(source, candidate.id));
    if (activeTask) {
      throw new Error(`${activeTask.id} already has a started run; finish or block it before final visual review`);
    }
    const workspacePath = finalReviewWorkspace(args, source);
    args.workspace = workspacePath;
    args.isolation = 'none';
    args.runKind = 'final_visual_review';
    args.notes = uniqueStrings([
      ...args.notes,
      `FINAL_VISUAL_REVIEW: iteration=${source.iterationId}; canonical workspace=${workspacePath}`,
    ]);
    const identity = resolveStartIdentity(args, source, task, { reserve: true });
    const { runId, defaults } = identity;
    args.runReservationToken = identity.reservationToken;
    const runResult = runScript(
      'p2a_runs.mjs',
      startRunArgs(args, task, runId, defaults),
    );
    printChildResult(runResult, { suppressStdout: args.json });
    if (runResult.status !== 0) {
      console.error('Final visual review run did not start. Correct the cause, then retry with the same reserved run id:');
      console.error(commandLine('p2a_execute.mjs', [
        'review',
        ...source.sourceArgs,
        '--agent-tool', args.agentTool,
        '--run-id', runId,
        '--workspace', workspacePath,
        ...(identity.reservationToken ? ['--run-reservation-token', identity.reservationToken] : []),
      ]));
      return runResult.status ?? 1;
    }
    const startedRun = readRun(source.runsDir, runId);
    assertRunExecutionContractCurrent(startedRun, source, 'final visual review');
    printFinalVisualReviewInstructions(args, source, task, runId, workspacePath);
    printRunCommandFooter(P2A_PATHS, {
      sourceArgs: source.sourceArgs,
      runId,
      heading: 'Run commands:',
    });
    recordExecutionResult(args, 'review', startedRun);
    return 0;
  });
}

function runAccept(args) {
  const initialSource = resolveSource(args);
  return withRunStoreLocks([path.dirname(initialSource.graphPath)], () => {
    const source = currentSourceGraph(initialSource);
    if (!args.artifacts || args.approval || args.maintenance || source.sourceLayout !== 'iteration') {
      throw new Error('final acceptance review requires --artifacts for a feature iteration');
    }
    const unfinishedTasks = source.graph.tasks.filter((candidate) => candidate.status !== 'done');
    if (unfinishedTasks.length) {
      throw new Error(
        `final acceptance review requires every iteration task to be done; unfinished task(s): ${unfinishedTasks.map((candidate) => `${candidate.id}:${candidate.status}`).join(', ')}`,
      );
    }
    const task = selectCompletedAcceptanceTask(source, args.taskId);
    const activeTask = source.graph.tasks.find((candidate) => hasStartedRunForTask(source, candidate.id));
    if (activeTask) {
      throw new Error(`${activeTask.id} already has a started run; finish or block it before final acceptance review`);
    }
    const workspacePath = finalReviewWorkspace(args, source, 'acceptance');
    args.workspace = workspacePath;
    args.isolation = 'none';
    args.runKind = 'final_acceptance_review';
    args.notes = uniqueStrings([
      ...args.notes,
      `FINAL_ACCEPTANCE_REVIEW: iteration=${source.iterationId}; canonical workspace=${workspacePath}`,
    ]);
    const identity = resolveStartIdentity(args, source, task, { reserve: true });
    const { runId, defaults } = identity;
    args.runReservationToken = identity.reservationToken;
    const runResult = runScript(
      'p2a_runs.mjs',
      startRunArgs(args, task, runId, defaults),
    );
    printChildResult(runResult, { suppressStdout: args.json });
    if (runResult.status !== 0) {
      console.error('Final acceptance review run did not start. Correct the cause, then retry with the same reserved run id:');
      console.error(commandLine('p2a_execute.mjs', [
        'accept',
        ...source.sourceArgs,
        '--agent-tool', args.agentTool,
        '--run-id', runId,
        '--workspace', workspacePath,
        ...(identity.reservationToken ? ['--run-reservation-token', identity.reservationToken] : []),
      ]));
      return runResult.status ?? 1;
    }
    const startedRun = readRun(source.runsDir, runId);
    assertRunExecutionContractCurrent(startedRun, source, 'final acceptance review');
    printFinalAcceptanceReviewInstructions(source, task, startedRun, workspacePath);
    printRunCommandFooter(P2A_PATHS, {
      sourceArgs: source.sourceArgs,
      runId,
      heading: 'Run commands:',
    });
    recordExecutionResult(args, 'accept', startedRun);
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
  if (run.status === 'started') assertRunExecutionContractCurrent(run, source, 'resume');
  console.log('Plan2Agent execution resume');
  console.log(`- project: ${source.projectId}`);
  console.log(`- task: ${task.id} - ${humanTaskOutcome(task)}`);
  console.log(`- taskStatus: ${task.status}`);
  console.log(`- runId: ${run.runId}`);
  console.log(`- runStatus: ${run.status}`);
  console.log(`- executionMode: ${run.mode ?? 'orchestrated'}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  const failedCheckpoint = run.verification.find((item) => (
    item.milestoneId
    && (item.status === 'failed' || item.status === 'unavailable')
  ));
  const nextMilestone = failedCheckpoint
    ? null
    : run.milestones?.find((milestone) => milestone.status === 'pending');
  if (failedCheckpoint) {
    console.log(`- checkpointFailure: ${failedCheckpoint.milestoneId}:${failedCheckpoint.status}`);
    console.log('- resumeNote: checkpoint failure evidence is immutable; finish this run as failed or blocked, then start a new retry run.');
  } else if (nextMilestone) {
    console.log(`- nextMilestone: ${nextMilestone.id} - ${nextMilestone.outcome}`);
    console.log(`- checkpoint: ${commandLine('p2a_runs.mjs', ['checkpoint', ...source.sourceArgs, '--run-id', run.runId, '--milestone', nextMilestone.id])}`);
  }
  if (run.status !== 'started') {
    console.log('- resumeNote: run is already closed; use status/review commands for follow-up evidence.');
  }
  if (run.status === 'started' && !failedCheckpoint) {
    if (run.runKind === 'final_verification') {
      printFinalVerificationInstructions(source, task, run, run.workspacePath);
    } else if (run.runKind === 'final_visual_review') {
      printFinalVisualReviewInstructions(args, source, task, run.runId, run.workspacePath);
    } else if (run.runKind === 'final_acceptance_review') {
      printFinalAcceptanceReviewInstructions(source, task, run, run.workspacePath);
    } else {
      printLauncherPrompt(source, task, run.runId, approvalLink, { suppressPrompt: args.json });
    }
  }
  printRunCommandFooter(P2A_PATHS, {
    sourceArgs: source.sourceArgs,
    runId: run.runId,
    includeResume: false,
    includeFinish: run.status === 'started',
    heading: 'Run commands:',
  });
  recordExecutionResult(args, 'resume', run);
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
  if (run?.status === 'started' && run.currentDevelopmentContractRef) {
    assertRunExecutionContractCurrent(run, source, 'status');
  }
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
    console.log(`- task: ${task.id} - ${humanTaskOutcome(task)}`);
    console.log(`- taskStatus: ${task.status}`);
    if (task.blockReason) console.log(`- blockReason: ${task.blockReason}`);
  }
  if (!run) {
    console.log('- latestRun: none');
    return 0;
  }
  console.log(`- runId: ${run.runId}`);
  console.log(`- runStatus: ${run.status}`);
  console.log(`- executionMode: ${run.mode ?? 'orchestrated'}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.map((item) => `${item.type}:${item.status}`).join(', ') || '-'}`);
  if (run.milestones) {
    console.log(`- milestones: ${run.milestones.map((milestone) => `${milestone.id}:${milestone.status}`).join(', ')}`);
  }
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
  assertRunMonitorGateBinding(
    existingRun,
    readOrchestrationSidecar(source.runsDir, existingRun.runId),
  );
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
    const monitorResult = applyMonitorGate(args, source, existingRun);
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
  if (status === 0 && !args.noTaskTransition) {
    pruneSupersededRunHistory(source, run, { quiet: args.json });
    printMaintenanceCompletionChoices(source, run);
  }
  printClosedRunFooter(source, run);
  return status;
}

export function main(argv = process.argv.slice(2)) {
  let restoreConsoleLog = null;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.json) {
      const original = console.log;
      console.log = () => {};
      restoreConsoleLog = () => {
        console.log = original;
        restoreConsoleLog = null;
      };
    }
    let status;
    if (args.command === 'prepare') status = runPrepare(args);
    else if (args.command === 'plan') status = runPlan(args);
    else if (args.command === 'start') status = runStart(args);
    else if (args.command === 'verify-final') status = runVerifyFinal(args);
    else if (args.command === 'review') status = runReview(args);
    else if (args.command === 'accept') status = runAccept(args);
    else if (args.command === 'resume') status = runResume(args);
    else if (args.command === 'status') status = runStatus(args);
    else if (args.command === 'finish') status = runFinish(args);
    else throw new Error(`unknown command: ${args.command}`);
    restoreConsoleLog?.();
    if (args.json && status === 0) {
      if (!args.executionResult) throw new Error(`${args.command} did not produce a machine-readable execution result`);
      validateSchema(args.executionResult, EXECUTION_RESULT_SCHEMA);
      console.log(JSON.stringify(args.executionResult, null, 2));
    }
    return status;
  } catch (error) {
    restoreConsoleLog?.();
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
