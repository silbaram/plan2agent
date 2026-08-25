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
import {
  FAILURE_CLASSES,
  FAILURE_RETRYABLE,
  ISOLATION_MODES,
  RUN_TELEMETRY_PROTOCOL,
} from './p2a_constants.mjs';
import {
  acceptanceReviewContract,
  approvedExecutionEnvelope,
  approvedVisualReviewContract,
  executionEnvelopeSha256,
  loadJson,
  resolveRunTaskGraphPath,
  validateConstitution,
  validateRunTaskContract,
  validateRunData,
  validateRunIndexData,
  validateRunsDir,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  MONITOR_CONCERN_FIELDS,
  MONITOR_GATE_POLICY,
  assertRunMonitorGateBinding,
  monitorGateContractSha256,
  monitorVerdictEvidenceSha256,
  normalizeMonitorGateSidecar,
  normalizeMonitorVerdictData,
  readMonitorGateSidecar,
} from './p2a_monitor_gate.mjs';
import { readRequiredVisualReviewEvidence } from './p2a_visual_review_gate.mjs';
import { readRequiredAcceptanceReviewEvidence } from './p2a_acceptance_review_gate.mjs';
import {
  resolveIterationState,
  validateMaintenanceTaskGraphProject,
} from './p2a_iteration_state.mjs';
import {
  assertUnmanagedGraphMutation,
  assertRunIndexCanInitialize,
  assertSafeRunId,
  assertStartableRunId,
  canonicalWorkspacePathForArtifactRoot,
  canonicalTaskGraphRef,
  canonicalRunRef,
  DEFAULT_RUNS_DIR,
  defaultArtifactRootForGraph,
  indexedRunRef,
  legacyRunRef,
  legacyRunsDirForGraph,
  resolveRunsDir,
  RUN_SIDECAR_SUFFIXES,
  runFilePath,
  runMatchesSourceContext,
  runSidecarPath,
  runSidecarRef,
  taskContractSha256,
  unindexedRunRecordRefs,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
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
  normalizePath,
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
import {
  isVerificationType,
  parseVerifyCommand,
  verificationTypeList,
} from './p2a_verification.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const PROJECT_RUNS_DIR = path.join(ROOT, DEFAULT_RUNS_DIR);
const COMMANDS = new Set(['start', 'record', 'verify', 'checkpoint', 'finish', 'list', 'show', 'revision', 'validate', 'migrate-layout', 'migrate-schema']);
const RUN_STATUSES = new Set(['started', 'finished', 'failed', 'blocked']);
const RUN_KINDS = new Set(['final_visual_review', 'final_acceptance_review']);
const VISUAL_FEEDBACK_VERDICTS = new Set(['note', 'concern']);
const USAGE_SOURCES = new Set(['provider', 'manual']);
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
const VERIFICATION_STATUSES = new Set(['passed', 'failed', 'skipped', 'not_run', 'unavailable']);
const OUTPUT_TAIL_LIMIT = 4000;
function usage() {
  return [
    'Usage:',
    '  p2a runs start --artifacts <iterative-project-dir> --task <task-id> --agent-tool <tool> [options]',
    '  p2a runs start --graph <task-graph.json> --task <task-id> --agent-tool <tool> [--runs <dir>] [options]',
    '  p2a runs record --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--changed-file <path> ...] [--verification <type:status:command>] [--note <text>] [--visual-feedback note|concern] [usage/interruption options] [structured detail options]',
    '  p2a runs verify --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--test] [--lint] [--typecheck] [--test-command <cmd>] [--lint-command <cmd>] [--typecheck-command <cmd>] [--verify-command <type:cmd>]',
    '  p2a runs checkpoint --run-id <run-id> --milestone <milestone-id> (--artifacts <dir>|--runs <dir>|--graph <path>)',
    '  p2a runs finish --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>) [--status finished|failed|blocked] [--failure-class <class>] [--retryable yes|no|after_fix] [--needs-user-decision true|false] [--failure-source owner|monitor|implementer] [--changed-file <path> ...] [--verification <type:status:command>] [--collect-git] [--note <text>] [usage/interruption options] [structured detail options]',
    '  p2a runs list (--artifacts <dir>|--runs <dir>|--graph <path>) [--json]',
    '  p2a runs show --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>)',
    '  p2a runs revision --run-id <run-id> (--artifacts <dir>|--runs <dir>|--graph <path>)',
    '  p2a runs validate (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>]',
    '  p2a runs migrate-layout (--artifacts <dir>|--runs <dir>|--graph <path>) [--dry-run] --yes',
    '  p2a runs migrate-schema (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>] [--dry-run] --yes',
    '',
    'Options:',
    '  --artifacts <dir>       Iterative artifact root; writes runs/ under that root.',
    '  --graph <path>          Legacy task graph path. Managed iteration graph mutations require --artifacts.',
    '  --runs <dir>            Explicit runs directory containing run-index.json and run files.',
    '  --maintenance           With --artifacts, use the maintenance task graph as source context.',
    '  --task <task-id>        Task id for start.',
    '  --run-id <run-id>       Stable run id. Must start with run-. Generated for start when omitted.',
    '  --milestone <id>         Planned execution checkpoint to verify in declared order.',
    '  --run-reservation-token <token>  Reservation owner token emitted by a failed sequential start retry.',
    '  --agent-tool <tool>     Agent/CLI tool that performed the run, such as codex, claude, gemini.',
    '  --run-kind <kind>       Structured run purpose: final_visual_review or final_acceptance_review.',
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
    '  --usage-model <profile> Model/profile label for one usage sample.',
    '  --usage-input-tokens <n>, --usage-output-tokens <n>',
    '                          Record non-negative token counts; both and --usage-model are required together.',
    '  --usage-source <source> Token source: provider or manual. Default: manual.',
    '  --implementation-interruption <text>',
    '                          Record a user interruption caused by asking for an implementation decision. Repeatable.',
    '  --user-correction <text> Record a user requirement or UI correction. Repeatable.',
    '  --gate-return <assessment:text>',
    '                          Record a contract Gate return assessed as valid or invalid. Repeatable.',
    '  --visual-feedback <verdict>  Append optional, non-gating implementation feedback: note or concern.',
    '  --visual-feedback-note <text>  Explanation for the visual feedback.',
    '  --visual-feedback-concern <text>  Concern found during early visual review. Repeatable.',
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
    '                          Run an explicit supplemental command. type is required: test, lint, typecheck, or custom.',
    '  --save-config           Persist detected or explicit test/lint/typecheck commands to project.config.json.',
    '  --json                  Machine-readable output for list.',
    '  --dry-run               Preview the selected layout or schema migration without writing files.',
    '  --yes                   Confirm the selected layout or schema migration.',
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
    milestoneId: null,
    runReservationToken: null,
    agentTool: null,
    runKind: null,
    workspace: null,
    workspaceRef: null,
    isolation: 'none',
    branch: null,
    worktree: null,
    baseRef: 'HEAD',
    createIsolation: false,
    changedFiles: [],
    notes: [],
    usageModel: null,
    usageInputTokens: null,
    usageOutputTokens: null,
    usageSource: null,
    implementationInterruptions: [],
    userCorrections: [],
    gateReturns: [],
    visualFeedbackVerdict: null,
    visualFeedbackNote: null,
    visualFeedbackConcerns: [],
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
    else if (arg === '--milestone') args.milestoneId = requiredValue(argv, ++index, '--milestone');
    else if (arg === '--run-reservation-token') args.runReservationToken = requiredValue(argv, ++index, '--run-reservation-token');
    else if (arg === '--agent-tool') args.agentTool = requiredValue(argv, ++index, '--agent-tool');
    else if (arg === '--run-kind') {
      args.runKind = requiredValue(argv, ++index, '--run-kind');
      if (!RUN_KINDS.has(args.runKind)) throw new Error('--run-kind must be final_visual_review or final_acceptance_review');
    }
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
    else if (arg === '--visual-feedback') {
      args.visualFeedbackVerdict = requiredValue(argv, ++index, '--visual-feedback');
      if (!VISUAL_FEEDBACK_VERDICTS.has(args.visualFeedbackVerdict)) {
        throw new Error('--visual-feedback must be note or concern');
      }
    }
    else if (arg === '--visual-feedback-note') args.visualFeedbackNote = requiredValue(argv, ++index, '--visual-feedback-note', { allowLeadingDash: true });
    else if (arg === '--visual-feedback-concern') args.visualFeedbackConcerns.push(requiredValue(argv, ++index, '--visual-feedback-concern', { allowLeadingDash: true }));
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
    else if (existsSync(PROJECT_RUNS_DIR)) args.runs = PROJECT_RUNS_DIR;
    else assertNoUninitializedScaffoldArtifactRoots();
    if (!args.artifacts && !args.graph && !args.runs) {
      throw new Error('--artifacts, --graph, or --runs is required');
    }
  }
  if (args.artifacts && args.graph) throw new Error('--artifacts and --graph cannot be used together');
  if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
  if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  if (args.graph && ['start', 'record', 'verify', 'checkpoint', 'finish'].includes(args.command)) {
    assertUnmanagedGraphMutation(args.graph, `p2a runs ${args.command}`);
  }
  if (args.command === 'start') {
    if (!args.taskId) throw new Error('--task is required for start');
    if (!args.agentTool) throw new Error('--agent-tool is required for start');
    if (args.runs && !args.graph && !args.artifacts) throw new Error('start requires --artifacts or --graph so the task can be resolved');
  }
  if (args.command === 'checkpoint' && !args.milestoneId) {
    throw new Error('--milestone is required for checkpoint');
  }
  if (args.command !== 'checkpoint' && args.milestoneId) {
    throw new Error('--milestone is only supported with checkpoint');
  }
  if (args.command === 'checkpoint' && (args.verifyRequests.length || args.manualVerification.length || args.saveConfig)) {
    throw new Error('checkpoint runs the milestone verification commands declared in Gate C');
  }
  if (args.runKind && args.command !== 'start') {
    throw new Error('--run-kind is only supported with start');
  }
  const hasVisualFeedbackDetails = args.visualFeedbackNote !== null || args.visualFeedbackConcerns.length > 0;
  if ((args.visualFeedbackVerdict || hasVisualFeedbackDetails) && args.command !== 'record') {
    throw new Error('visual feedback options are only supported with record');
  }
  if (hasVisualFeedbackDetails && !args.visualFeedbackVerdict) {
    throw new Error('--visual-feedback-note and --visual-feedback-concern require --visual-feedback');
  }
  if (args.visualFeedbackVerdict === 'note' && !args.visualFeedbackNote) {
    throw new Error('--visual-feedback note requires --visual-feedback-note');
  }
  if (args.visualFeedbackVerdict === 'concern' && args.visualFeedbackConcerns.length === 0) {
    throw new Error('--visual-feedback concern requires at least one --visual-feedback-concern');
  }
  if (args.command !== 'finish' && (args.failureClass || args.retryable || args.needsUserDecision !== null || args.failureSource)) {
    throw new Error('failure options are only supported with finish');
  }
  if (!['record', 'finish'].includes(args.command) && hasStructuredDetailOptions(args)) {
    throw new Error('structured detail options are only supported with record or finish');
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
  if (!['record', 'finish'].includes(args.command) && (hasUsage || hasInterruptionOptions(args))) {
    throw new Error('usage and interruption options are only supported with record or finish');
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
  if (['record', 'verify', 'checkpoint', 'finish', 'show', 'revision'].includes(args.command) && !args.runId) {
    throw new Error(`--run-id is required for ${args.command}`);
  }
  if (args.runReservationToken && (args.command !== 'start' || !args.runId)) {
    throw new Error('--run-reservation-token requires start with --run-id');
  }
  const migrationCommands = new Set(['migrate-layout', 'migrate-schema']);
  if ((args.dryRun || args.yes) && !migrationCommands.has(args.command)) {
    throw new Error('--dry-run and --yes are only supported with migrate-layout or migrate-schema');
  }
  if (migrationCommands.has(args.command) && !args.dryRun && !args.yes) {
    throw new Error(`${args.command} requires --yes, or use --dry-run to preview`);
  }
  return args;
}

function parseManualVerification(value) {
  const [type, status, ...commandParts] = value.split(':');
  const command = commandParts.join(':');
  if (!isVerificationType(type)) throw new Error(`manual verification type must be one of ${verificationTypeList()}`);
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

function loadTaskGraph(graphPath) {
  assertFile(graphPath, 'task graph');
  const graph = loadJson(graphPath);
  validateTaskGraphData(graph);
  return graph;
}

function taskGraphFingerprint(graph) {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}

export function assertStartTaskSourceUnchanged(source, expectedFingerprint, runId, expectedExecutionEnvelope = undefined) {
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
  if (expectedExecutionEnvelope !== undefined) {
    let currentExecutionEnvelope;
    try {
      currentExecutionEnvelope = approvedExecutionEnvelope(
        taskSourceSpecPath(source),
        source.sourceSpecRef,
        source.sourceLayout === 'graph' ? null : source.artifactRoot,
      );
    } catch (error) {
      throw new Error(
        `Gate B execution contract changed or became unavailable while run ${runId} was preparing isolation; no run was written: ${error.message}`,
      );
    }
    if (JSON.stringify(currentExecutionEnvelope) !== JSON.stringify(expectedExecutionEnvelope)) {
      throw new Error(
        `Gate B execution contract changed while run ${runId} was preparing isolation; no run was written. Re-read the approved spec and start the task again.`,
      );
    }
  }
  if (source.sourceLayout === 'maintenance') {
    let currentState;
    try {
      currentState = resolveIterationState(source.artifactRoot, {
        requireReady: false,
      });
      validateMaintenanceTaskGraphProject(currentState, currentGraph);
    } catch (error) {
      throw new Error(
        `maintenance project state changed while run ${runId} was preparing isolation; no run was written: ${error.message}`,
      );
    }
    if (currentState.projectId !== source.projectId) {
      throw new Error(
        `maintenance project identity changed while run ${runId} was preparing isolation; no run was written`,
      );
    }
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
    const contents = readFileSync(verdictPath);
    const verdict = normalizeMonitorVerdictData(JSON.parse(contents.toString('utf8')), {
      requiredConcernFields: sidecar.requiredConcernFields,
      requiredRuleIds: sidecar.ruleContract?.ruleIds,
      requireRulesReviewed: sidecar.ruleContract !== null,
    });
    return { verdict, evidenceSha256: monitorVerdictEvidenceSha256(contents) };
  } catch (error) {
    throw new Error(`${error.message}: ${displayPath(verdictPath)}`);
  }
}

function assertMonitorRuleContractCurrent(sidecar, taskSource, workspacePath, run) {
  const contract = sidecar?.ruleContract;
  if (!contract) return null;
  const current = monitorRuleContract(taskSource, workspacePath);
  if (JSON.stringify(current) !== JSON.stringify(contract)) {
    throw new Error([
      `monitor rule contract source changed or is unavailable for run ${run.runId}`,
      `expected=${JSON.stringify(contract)}`,
      `current=${JSON.stringify(current)}`,
    ].join('; '));
  }
  return current;
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

function applyMonitorGate(
  args,
  runsDir,
  run,
  taskSource,
  workspacePath,
  sidecar = readOrchestrationSidecar(runsDir, run.runId),
  { enforceAcceptance = true } = {},
) {
  assertRunMonitorGateBinding(run, sidecar);
  if (!sidecar?.required) return null;
  assertMonitorRuleContractCurrent(sidecar, taskSource, workspacePath, run);
  const monitorEvidence = readMonitorVerdict(runsDir, sidecar);
  const { verdict, evidenceSha256 } = monitorEvidence;
  if (sidecar.acceptedVerdicts.includes(verdict.verdict) && !verdict.hasConcerns) {
    return {
      accepted: true,
      verdict: verdict.verdict,
      concerns: monitorConcernSummary(verdict),
      evidenceSha256,
    };
  }
  const mappedFailureClass = sidecar.failureClassMap[verdict.failureSignal]
    ?? sidecar.failureClassMap[verdict.verdict]
    ?? 'other';
  if (enforceAcceptance) {
    args.status = 'blocked';
    args.failureClass = mappedFailureClass;
    args.failureSource = 'monitor';
    args.needsUserDecision = verdict.needsUserDecision;
  }
  return {
    accepted: false,
    verdict: verdict.failureSignal,
    rawVerdict: verdict.verdict,
    failureClass: args.failureClass,
    concerns: monitorConcernSummary(verdict),
    evidenceSha256,
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

function taskSourceSpecPath(source) {
  const reference = source.sourceSpecRef;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(path.dirname(source.graphPath), reference),
        path.resolve(source.artifactRoot, reference),
        path.resolve(ROOT, reference),
        path.resolve(P2A_PATHS.toolRoot, reference),
      ];
  const resolved = candidates.find((candidate) => (
    existsSync(candidate) && lstatSync(candidate).isFile()
  ));
  if (!resolved) {
    throw new Error(`task graph sourceSpec cannot be resolved: ${JSON.stringify(reference)}`);
  }
  return resolved;
}

function resolveTaskSource(args) {
  if (args.artifacts) {
    const artifactRoot = path.resolve(args.artifacts);
    const state = resolveIterationState(artifactRoot, { requireReady: !args.maintenance });
    if (args.maintenance) {
      const graphPath = path.join(state.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      const graph = loadTaskGraph(graphPath);
      validateMaintenanceTaskGraphProject(state, graph);
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
    artifactRoot: defaultArtifactRootForGraph(graphPath),
    graphPath,
    graph,
    taskGraphRef: canonicalTaskGraphRef(graphPath),
    sourceSpecRef: graph.sourceSpec,
    runsDir: resolveRunsDir(args),
  };
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

function runOnlyTaskSource(runsDir, run) {
  const artifactRoot = path.dirname(path.resolve(runsDir));
  const graphPath = resolveRunTaskGraphPath(run, artifactRoot);
  const graph = loadTaskGraph(graphPath);
  if (graph.projectId !== run.projectId) {
    throw new Error(
      `run ${run.runId} projectId ${run.projectId} does not match task graph projectId ${graph.projectId}`,
    );
  }
  return {
    projectId: run.projectId,
    artifactRoot: run.sourceLayout === 'graph'
      ? defaultArtifactRootForGraph(graphPath)
      : artifactRoot,
    graphPath,
    graph,
  };
}

function monitorRuleRef(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return displayPath(filePath);
}

function monitorRuleFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hasSubstantiveRuleValue(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => hasSubstantiveRuleValue(item));
  if (value && typeof value === 'object') return Object.values(value).some((item) => hasSubstantiveRuleValue(item));
  return value !== null && value !== undefined;
}

function constitutionMonitorRuleIds(constitution) {
  return uniqueStrings([
    ...constitution.architecture.map((rule) => rule.id),
    ...constitution.stack.map((rule) => rule.id),
    ...constitution.prohibitions
      .filter((rule) => ['validator', 'review'].includes(rule.enforcement))
      .map((rule) => rule.id),
    ...(hasSubstantiveRuleValue(constitution.style) ? ['STYLE'] : []),
  ]);
}

function monitorRuleContract(source, workspacePath) {
  const roots = uniqueStrings([
    canonicalWorkspacePathForArtifactRoot(source.artifactRoot),
    path.resolve(workspacePath),
    process.cwd(),
  ].map((candidate) => path.resolve(candidate)));
  for (const projectRoot of roots) {
    const constitutionPath = path.join(projectRoot, '.plan2agent', 'constitution.json');
    if (!existsSync(constitutionPath)) continue;
    assertFile(constitutionPath, 'monitor constitution');
    const constitution = validateConstitution(constitutionPath, { requireApproved: true, projectId: source.projectId });
    return {
      source: 'constitution',
      ref: monitorRuleRef(projectRoot, constitutionPath),
      sha256: monitorRuleFileSha256(constitutionPath),
      ruleIds: constitutionMonitorRuleIds(constitution),
    };
  }
  for (const projectRoot of roots) {
    const legacyStylePath = path.join(projectRoot, '.plan2agent', 'style.md');
    if (!existsSync(legacyStylePath)) continue;
    assertFile(legacyStylePath, 'legacy monitor style');
    if (!readFileSync(legacyStylePath, 'utf8').trim()) continue;
    return {
      source: 'legacy_style',
      ref: monitorRuleRef(projectRoot, legacyStylePath),
      sha256: monitorRuleFileSha256(legacyStylePath),
      ruleIds: ['STYLE'],
    };
  }
  return { source: 'none', ref: null, sha256: null, ruleIds: [] };
}

function sourceRunArgs(args) {
  if (args.artifacts) return ['--artifacts', args.artifacts, ...(args.maintenance ? ['--maintenance'] : [])];
  if (args.graph) return ['--graph', args.graph];
  return null;
}

function runLifecycleSourceArgs(args) {
  return sourceRunArgs(args) ?? (args.runs ? ['--runs', args.runs] : null);
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
    runKind: run.runKind ?? null,
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

function normalizedSelectorSet(values, label, { allowNull = false } = {}) {
  if (values === undefined) return null;
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = new Set();
  for (const value of values) {
    if (allowNull && value === null) {
      normalized.add(null);
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label} values must be non-empty strings${allowNull ? ' or null' : ''}`);
    }
    normalized.add(value.trim());
  }
  return normalized;
}

function pruneScopeMatches(entry, selectors) {
  if (selectors.iterationIds && !selectors.iterationIds.has(entry.iterationId)) return false;
  if (selectors.taskIds && !selectors.taskIds.has(entry.taskId)) return false;
  if (selectors.runKinds && !selectors.runKinds.has(entry.runKind ?? null)) return false;
  return true;
}

const RETROSPECTIVE_SUMMARY_LIMIT = 8;
const RETROSPECTIVE_SUMMARY_REASONS = new Set(['superseded', 'completed_maintenance']);

function emptyRetrospectiveSummary(iterationId) {
  return {
    iterationId,
    runCount: 0,
    reasonCounts: { superseded: 0, completed_maintenance: 0 },
    statusCounts: { finished: 0, failed: 0, blocked: 0 },
    verificationCount: 0,
    verificationDuration: { sampleCount: 0, totalMs: 0, maxMs: 0 },
    verificationStatusCounts: {
      passed: 0,
      failed: 0,
      skipped: 0,
      not_run: 0,
      unavailable: 0,
    },
    interruptionCounts: {
      implementation_decision: 0,
      user_correction: 0,
      gate_return_valid: 0,
      gate_return_invalid: 0,
    },
  };
}

function safeCountAdd(current, increment = 1) {
  if (!Number.isSafeInteger(increment) || increment < 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function addPrunedRunToSummary(summary, entry, run, reason) {
  summary.runCount = safeCountAdd(summary.runCount);
  summary.reasonCounts[reason] = safeCountAdd(summary.reasonCounts[reason]);
  if (Object.hasOwn(summary.statusCounts, entry.status)) {
    summary.statusCounts[entry.status] = safeCountAdd(summary.statusCounts[entry.status]);
  }
  for (const verification of Array.isArray(run?.verification) ? run.verification : []) {
    summary.verificationCount = safeCountAdd(summary.verificationCount);
    if (Object.hasOwn(summary.verificationStatusCounts, verification?.status)) {
      summary.verificationStatusCounts[verification.status] = safeCountAdd(
        summary.verificationStatusCounts[verification.status],
      );
    }
    if (Number.isSafeInteger(verification?.durationMs) && verification.durationMs >= 0) {
      summary.verificationDuration.sampleCount = safeCountAdd(summary.verificationDuration.sampleCount);
      summary.verificationDuration.totalMs = safeCountAdd(
        summary.verificationDuration.totalMs,
        verification.durationMs,
      );
      summary.verificationDuration.maxMs = Math.max(
        summary.verificationDuration.maxMs,
        verification.durationMs,
      );
    }
  }
  for (const interruption of Array.isArray(run?.interruptions) ? run.interruptions : []) {
    let field = interruption?.type;
    if (field === 'gate_return') field = `gate_return_${interruption.assessment}`;
    if (Object.hasOwn(summary.interruptionCounts, field)) {
      summary.interruptionCounts[field] = safeCountAdd(summary.interruptionCounts[field]);
    }
  }
}

function summarizePrunedRuns(index, runsDir, selected, reason) {
  const iterations = structuredClone(index.retrospective?.iterations ?? []);
  const byIteration = new Map(iterations.map((summary) => [summary.iterationId, summary]));
  for (const entry of selected) {
    let summary = byIteration.get(entry.iterationId);
    if (!summary) {
      summary = emptyRetrospectiveSummary(entry.iterationId);
      iterations.push(summary);
      byIteration.set(entry.iterationId, summary);
    }
    let run = null;
    try {
      const runRef = indexedRunRef(runsDir, entry.runId, index);
      const runPath = path.resolve(runsDir, runRef);
      if (existsSync(runPath)) run = loadJson(runPath);
    } catch {
      // The index status still contributes to the bounded summary. Detailed
      // counters are best effort so cleanup does not preserve corrupt history.
    }
    addPrunedRunToSummary(summary, entry, run, reason);
  }
  return {
    iterations: iterations.slice(-RETROSPECTIVE_SUMMARY_LIMIT),
  };
}

function dropRetrospectiveIterations(index, iterationIds) {
  if (!index.retrospective) return null;
  const iterations = index.retrospective.iterations
    .filter((summary) => !iterationIds.has(summary.iterationId));
  return iterations.length ? { iterations } : null;
}

function mergeRunIndexRetrospectives(indexes) {
  const iterations = [];
  const byIteration = new Map();
  for (const index of indexes) {
    for (const source of index.retrospective?.iterations ?? []) {
      let target = byIteration.get(source.iterationId);
      if (!target) {
        target = emptyRetrospectiveSummary(source.iterationId);
        iterations.push(target);
        byIteration.set(source.iterationId, target);
      }
      target.runCount = safeCountAdd(target.runCount, source.runCount);
      target.verificationCount = safeCountAdd(target.verificationCount, source.verificationCount);
      for (const field of Object.keys(target.reasonCounts)) {
        target.reasonCounts[field] = safeCountAdd(target.reasonCounts[field], source.reasonCounts[field]);
      }
      for (const field of Object.keys(target.statusCounts)) {
        target.statusCounts[field] = safeCountAdd(target.statusCounts[field], source.statusCounts[field]);
      }
      target.verificationDuration.sampleCount = safeCountAdd(
        target.verificationDuration.sampleCount,
        source.verificationDuration.sampleCount,
      );
      target.verificationDuration.totalMs = safeCountAdd(
        target.verificationDuration.totalMs,
        source.verificationDuration.totalMs,
      );
      target.verificationDuration.maxMs = Math.max(
        target.verificationDuration.maxMs,
        source.verificationDuration.maxMs,
      );
      for (const field of Object.keys(target.verificationStatusCounts)) {
        target.verificationStatusCounts[field] = safeCountAdd(
          target.verificationStatusCounts[field],
          source.verificationStatusCounts[field],
        );
      }
      for (const field of Object.keys(target.interruptionCounts)) {
        target.interruptionCounts[field] = safeCountAdd(
          target.interruptionCounts[field],
          source.interruptionCounts[field],
        );
      }
    }
  }
  return iterations.length
    ? { iterations: iterations.slice(-RETROSPECTIVE_SUMMARY_LIMIT) }
    : null;
}

function pruneIndexedRunEvidenceLocked(runsDir, options = {}) {
  assertNoPendingRunMigration(runsDir);
  recoverPendingRunWrite(runsDir);
  if (!existsSync(indexPath(runsDir))) {
    return { prunedRunIds: [], cleanupFailures: [] };
  }
  const selectors = {
    iterationIds: normalizedSelectorSet(options.iterationIds, 'iterationIds'),
    taskIds: normalizedSelectorSet(options.taskIds, 'taskIds'),
    runKinds: normalizedSelectorSet(options.runKinds, 'runKinds', { allowNull: true }),
  };
  if (!Object.values(selectors).some(Boolean)) {
    throw new Error('run evidence pruning requires at least one scope selector');
  }
  if (options.summaryReason && !RETROSPECTIVE_SUMMARY_REASONS.has(options.summaryReason)) {
    throw new Error(`unsupported retrospective summary reason: ${JSON.stringify(options.summaryReason)}`);
  }
  if (options.dropRetrospective === true && !selectors.iterationIds) {
    throw new Error('dropRetrospective requires iterationIds');
  }
  if (options.dropRetrospective === true && options.summaryReason) {
    throw new Error('dropRetrospective cannot be combined with summaryReason');
  }
  const keepRunIds = normalizedSelectorSet(options.keepRunIds ?? [], 'keepRunIds');
  const index = loadIndex(runsDir);
  const scoped = index.runs.filter((entry) => pruneScopeMatches(entry, selectors));
  const started = scoped.filter((entry) => entry.status === 'started');
  if (started.length && options.requireNoStarted !== false) {
    throw new Error(
      `cannot prune active run evidence; finish or block started run(s): ${started.map((entry) => entry.runId).join(', ')}`,
    );
  }
  const selected = scoped.filter((entry) => (
    entry.status !== 'started'
    && !keepRunIds.has(entry.runId)
  ));
  const droppedRetrospective = options.dropRetrospective === true
    ? dropRetrospectiveIterations(index, selectors.iterationIds)
    : index.retrospective;
  const retrospectiveChanged = JSON.stringify(droppedRetrospective) !== JSON.stringify(index.retrospective);
  if (!selected.length) {
    if (retrospectiveChanged) {
      const nextIndex = { ...index };
      if (droppedRetrospective) nextIndex.retrospective = droppedRetrospective;
      else delete nextIndex.retrospective;
      writeIndex(runsDir, nextIndex);
    }
    return { prunedRunIds: [], cleanupFailures: [] };
  }

  const selectedIds = new Set(selected.map((entry) => entry.runId));
  const evidencePaths = [];
  for (const entry of selected) {
    const runRef = indexedRunRef(runsDir, entry.runId, index);
    const references = [
      runRef,
      ...RUN_SIDECAR_SUFFIXES.map((suffix) => runSidecarRef(runRef, suffix)),
    ];
    for (const reference of references) {
      const evidencePath = path.resolve(runsDir, reference);
      const relative = path.relative(path.resolve(runsDir), evidencePath);
      if (
        !relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw new Error(`run evidence path escapes runs directory: ${JSON.stringify(reference)}`);
      }
      if (existsSync(evidencePath)) evidencePaths.push(evidencePath);
    }
  }

  // Commit the authoritative index first so cleanup never leaves indexed
  // entries pointing at files that were already removed.
  const nextIndex = {
    ...index,
    runs: index.runs.filter((entry) => !selectedIds.has(entry.runId)),
  };
  if (options.summaryReason) {
    nextIndex.retrospective = summarizePrunedRuns(index, runsDir, selected, options.summaryReason);
  } else if (droppedRetrospective) {
    nextIndex.retrospective = droppedRetrospective;
  } else {
    delete nextIndex.retrospective;
  }
  writeIndex(runsDir, nextIndex);
  const cleanupFailures = [];
  for (const evidencePath of evidencePaths) {
    try {
      unlinkSync(evidencePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupFailures.push(`${displayPath(evidencePath)}: ${error.message}`);
    }
  }

  return {
    prunedRunIds: selected.map((entry) => entry.runId),
    cleanupFailures,
  };
}

export function pruneIndexedRunEvidence(runsDir, options = {}) {
  const resolvedRunsDir = path.resolve(runsDir);
  if (!existsSync(resolvedRunsDir)) {
    return { prunedRunIds: [], cleanupFailures: [] };
  }
  const prune = () => pruneIndexedRunEvidenceLocked(resolvedRunsDir, options);
  return options.alreadyLocked === true
    ? prune()
    : withRunStoreLocks([resolvedRunsDir], prune);
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
  let monitorGate = null;
  if (transaction.monitorGate !== undefined) {
    assertNoIndexedRunSidecarCollision(runsDir, transaction.index, transaction.run.runId, transaction.runRef, '.monitor-gate.json');
    monitorGate = normalizeMonitorGateSidecar(transaction.monitorGate, transaction.run.runId, transaction.runRef);
    assertRunMonitorGateBinding(transaction.run, monitorGate);
    const expectedVerdictRef = runSidecarRef(transaction.runRef, '.monitor-verdict.json');
    if (monitorGate.runId !== transaction.run.runId
      || monitorGate.required !== true
      || monitorGate.verdictPath !== expectedVerdictRef) {
      throw new Error(`pending run write transaction has an invalid monitor gate for ${transaction.run.runId}`);
    }
  }
  atomicWriteJson(path.join(runsDir, expectedRef), transaction.run);
  atomicWriteJson(indexPath(runsDir), transaction.index);
  if (monitorGate) {
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
  let monitorGate = null;
  if (options.monitorGateRequired) {
    monitorGate = normalizeMonitorGateSidecar({
      required: true,
      requiredConcernFields: MONITOR_CONCERN_FIELDS,
      ruleContract: options.monitorRuleContract ?? { source: 'none', ref: null, sha256: null },
    }, run.runId, runRef);
    run.monitorGate = {
      required: true,
      policy: MONITOR_GATE_POLICY,
      contractSha256: monitorGateContractSha256(monitorGate),
    };
    validateRunData(run);
  }
  const transaction = {
    schema_version: 'p2a.run_write_transaction.v1',
    runRef,
    run,
    index,
    ...(monitorGate ? { monitorGate } : {}),
  };
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

function appendRunTelemetry(run, args, recordedAt = new Date().toISOString()) {
  run.usage ??= [];
  run.interruptions ??= [];
  if (args.usageModel !== null) {
    run.usage.push({
      recordedAt,
      source: args.usageSource,
      modelProfile: args.usageModel,
      inputTokens: args.usageInputTokens,
      outputTokens: args.usageOutputTokens,
      totalTokens: args.usageInputTokens + args.usageOutputTokens,
    });
  }
  for (const summary of args.implementationInterruptions) {
    run.interruptions.push({
      recordedAt,
      type: 'implementation_decision',
      summary,
      assessment: 'not_applicable',
    });
  }
  for (const summary of args.userCorrections) {
    run.interruptions.push({
      recordedAt,
      type: 'user_correction',
      summary,
      assessment: 'not_applicable',
    });
  }
  for (const gateReturn of args.gateReturns) {
    run.interruptions.push({
      recordedAt,
      type: 'gate_return',
      summary: gateReturn.summary,
      assessment: gateReturn.assessment,
    });
  }
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
  if (result?.error && result.error.code !== 'ETIMEDOUT') {
    const errorCode = typeof result.error.code === 'string' && result.error.code.trim()
      ? result.error.code.trim().toUpperCase()
      : 'UNKNOWN';
    return {
      status: 'unavailable',
      reason: 'spawn_error',
      hint: `verification command could not be started reliably (${errorCode})`,
    };
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

export function runVerificationCommand(spec, workspacePath, timeoutMs, options = {}) {
  if (spec.status === 'skipped') return spec;
  const normalized = normalizeProjectLocalLauncherCommand(spec.command, workspacePath);
  const command = normalized.command;
  const startedAt = new Date();
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn(command, {
    cwd: workspacePath,
    shell: true,
    maxBuffer: 1024 * 1024 * 10,
    timeout: timeoutMs,
  });
  const finishedAt = new Date();
  result.stdout = decodeVerificationOutput(result.stdout);
  result.stderr = decodeVerificationOutput(result.stderr);
  const exitCode = result.error ? null : (typeof result.status === 'number' ? result.status : 1);
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

function executionStrategy(source, runKind = null) {
  const execution = source.graph.execution;
  const mode = execution?.mode ?? 'orchestrated';
  const selectionRationale = execution?.selectionRationale
    ?? (source.sourceLayout === 'maintenance'
      ? 'Maintenance task graph execution.'
      : 'Approved Gate C task graph execution.');
  const milestones = mode === 'planned' && !runKind
    ? execution.milestones.map((milestone) => ({
        ...structuredClone(milestone),
        status: 'pending',
        verifiedAt: null,
      }))
    : null;
  return { mode, selectionRationale, milestones };
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
  if (args.runKind === 'final_visual_review') {
    const unfinishedTasks = source.graph.tasks.filter((candidate) => candidate.status !== 'done');
    if (unfinishedTasks.length) {
      throw new Error(
        `final visual review requires every iteration task to be done; unfinished task(s): ${unfinishedTasks.map((candidate) => `${candidate.id}:${candidate.status}`).join(', ')}`,
      );
    }
    if (task.status !== 'done') {
      throw new Error(`final visual review run requires ${task.id} to be done; current status is ${task.status}`);
    }
    if (!task.visualImpact) {
      throw new Error(`final visual review run requires ${task.id} to carry visualImpact`);
    }
    if (args.changedFiles.length) {
      throw new Error('final visual review run does not allow --changed-file');
    }
    if (args.isolation !== 'none' || args.createIsolation || args.branch || args.worktree) {
      throw new Error('final visual review run requires --isolation none without branch/worktree creation');
    }
    if (source.sourceLayout === 'graph' && !args.workspace) {
      throw new Error('--workspace is required for final visual review in --graph mode');
    }
    if (source.sourceLayout !== 'graph') {
      const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(source.artifactRoot);
      if (realpathSync(workspacePath) !== realpathSync(canonicalWorkspacePath)) {
        throw new Error(
          `final visual review workspace must be the canonical integration workspace ${canonicalWorkspacePath}`,
        );
      }
    }
  }
  if (args.runKind === 'final_acceptance_review') {
    const unfinishedTasks = source.graph.tasks.filter((candidate) => candidate.status !== 'done');
    if (unfinishedTasks.length) {
      throw new Error(
        `final acceptance review requires every iteration task to be done; unfinished task(s): ${unfinishedTasks.map((candidate) => `${candidate.id}:${candidate.status}`).join(', ')}`,
      );
    }
    if (source.sourceLayout !== 'iteration') {
      throw new Error('final acceptance review is only supported for an active iteration');
    }
    if (approvedVisualReviewContract(taskSourceSpecPath(source), source.artifactRoot)) {
      throw new Error('final acceptance review is not used when Gate B requires a final visual review');
    }
    if (task.status !== 'done') {
      throw new Error(`final acceptance review run requires ${task.id} to be done; current status is ${task.status}`);
    }
    if (args.changedFiles.length) {
      throw new Error('final acceptance review run does not allow --changed-file');
    }
    if (args.isolation !== 'none' || args.createIsolation || args.branch || args.worktree) {
      throw new Error('final acceptance review run requires --isolation none without branch/worktree creation');
    }
    const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(source.artifactRoot);
    if (realpathSync(workspacePath) !== realpathSync(canonicalWorkspacePath)) {
      throw new Error(
        `final acceptance review workspace must be the canonical integration workspace ${canonicalWorkspacePath}`,
      );
    }
  }
  const visualReview = args.runKind === 'final_visual_review'
    ? approvedVisualReviewContract(
        taskSourceSpecPath(source),
        source.sourceLayout === 'graph' ? null : source.artifactRoot,
      )
    : null;
  if (args.runKind === 'final_visual_review' && !visualReview) {
    throw new Error('final visual review run requires an approved full current-iteration visual contract');
  }
  const acceptanceReview = args.runKind === 'final_acceptance_review'
    ? acceptanceReviewContract(taskSourceSpecPath(source), source.artifactRoot)
    : null;
  const executionEnvelope = source.sourceLayout === 'maintenance'
    ? null
    : approvedExecutionEnvelope(
        taskSourceSpecPath(source),
        source.sourceSpecRef,
        source.sourceLayout === 'graph' ? null : source.artifactRoot,
      );
  const ruleContract = args.requireMonitor ? monitorRuleContract(source, configWorkspacePath) : null;
  const strategy = executionStrategy(source, args.runKind);
  // A fresh worktree is the future workspace: validate its existing Git base
  // before creation, then validate the worktree itself after prepareIsolation.
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
    schema_version: 'p2a.run.v2',
    runId,
    projectId: source.projectId,
    taskId: task.id,
    taskTitle: task.title,
    iterationId: source.iterationId,
    sourceLayout: source.sourceLayout,
    taskGraphRef: source.taskGraphRef,
    sourceSpecRef: source.sourceSpecRef,
    ...(args.runKind ? { runKind: args.runKind } : {}),
    taskContractSha256: taskContractSha256(task),
    mode: strategy.mode,
    selectionRationale: strategy.selectionRationale,
    ...(strategy.milestones ? { milestones: strategy.milestones } : {}),
    ...(executionEnvelope ? {
      executionEnvelope,
      executionEnvelopeSha256: executionEnvelopeSha256(executionEnvelope),
    } : {}),
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
    usage: [],
    interruptions: [],
    telemetryProtocol: RUN_TELEMETRY_PROTOCOL,
    ...(visualReview ? { visualReview } : {}),
    ...(acceptanceReview ? { acceptanceReview } : {}),
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
      assertStartTaskSourceUnchanged(
        source,
        initialTaskGraphFingerprint,
        run.runId,
        executionEnvelope ?? undefined,
      );
    } catch (error) {
      if (allocation.reservationToken) {
        releaseRunIdReservation(runsDir, run.runId, allocation.reservationToken);
      }
      throw error;
    }
    writeRun(runsDir, run, {
      createOnly: true,
      monitorGateRequired: args.requireMonitor,
      monitorRuleContract: ruleContract,
      reservationToken: allocation.reservationToken,
    });
  });
  console.log(`Plan2Agent run started: ${run.runId}`);
  console.log(`- task: ${run.taskId}`);
  console.log(`- executionMode: ${run.mode}`);
  console.log(`- agentTool: ${run.agentTool}`);
  console.log(`- workspaceRef: ${run.workspaceRef}`);
  if (executionEnvelope) {
    console.log(`- executionEnvelope: ${run.executionEnvelopeSha256}`);
  }
  if (ruleContract) {
    const ruleLabel = ruleContract.source === 'none'
      ? 'none (no constitution or legacy style found)'
      : `${ruleContract.source}:${ruleContract.ref} sha256=${ruleContract.sha256}`;
    console.log(`- monitorRules: ${ruleLabel}`);
  }
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
  appendRunTelemetry(run, args);
  if (args.visualFeedbackVerdict) {
    run.visualFeedback ??= [];
    run.visualFeedback.push({
      reviewedAt: new Date().toISOString(),
      reviewer: run.agentTool,
      verdict: args.visualFeedbackVerdict,
      concerns: uniqueStrings(args.visualFeedbackConcerns),
      note: args.visualFeedbackNote ?? '',
    });
  }
  mergeStructuredRunDetails(run, args);
  run.updatedAt = new Date().toISOString();
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent run recorded: ${run.runId}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  console.log(`- usageSamples: ${run.usage?.length ?? 0}`);
  console.log(`- interruptions: ${run.interruptions?.length ?? 0}`);
  if (run.failure) console.log(`- failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`);
  return 0;
}

function verifyRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  if (run.status !== 'started') {
    throw new Error(`run ${run.runId} is already ${run.status}; verification commands only run while a run is started`);
  }
  if (run.schema_version === 'p2a.run.v2' || run.mode !== undefined) {
    validateRunTaskContract(run, path.dirname(path.resolve(runsDir)));
  }
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

function checkpointRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  if (run.status !== 'started') throw new Error(`run ${run.runId} is already ${run.status}`);
  validateRunTaskContract(run, path.dirname(path.resolve(runsDir)));
  if (run.mode !== 'planned' || !run.milestones) {
    throw new Error(`run ${run.runId} does not use planned execution checkpoints`);
  }
  const milestoneIndex = run.milestones.findIndex((milestone) => milestone.id === args.milestoneId);
  if (milestoneIndex < 0) throw new Error(`unknown milestone id: ${args.milestoneId}`);
  const milestone = run.milestones[milestoneIndex];
  if (milestone.status === 'verified') {
    console.log(`Plan2Agent checkpoint already verified: ${milestone.id}`);
    return 0;
  }
  const previousFailure = run.verification.find((item) => (
    item.milestoneId === milestone.id
    && (item.status === 'failed' || item.status === 'unavailable')
  ));
  if (previousFailure) {
    throw new Error(
      `checkpoint ${milestone.id} already recorded immutable ${previousFailure.status} evidence; `
      + 'finish this run as failed or blocked, then start a new retry run',
    );
  }
  const previousPending = run.milestones.slice(0, milestoneIndex).find((candidate) => candidate.status !== 'verified');
  if (previousPending) {
    throw new Error(`checkpoint ${milestone.id} is out of order; verify ${previousPending.id} first`);
  }

  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  assertDirectory(workspacePath, 'run workspace');
  const config = loadProjectConfigWithPath(runsDir, run, workspacePath).config;
  const timeoutMs = verificationTimeoutMs(config);
  const results = milestone.verification.map((command) => ({
    ...runVerificationCommand({ type: 'custom', command, source: 'command' }, workspacePath, timeoutMs),
    milestoneId: milestone.id,
  }));
  run.verification.push(...results);
  const passed = results.every((result) => result.status === 'passed');
  if (passed) {
    const verifiedAt = new Date().toISOString();
    milestone.status = 'verified';
    milestone.verifiedAt = verifiedAt;
    run.updatedAt = verifiedAt;
  } else {
    run.updatedAt = new Date().toISOString();
  }
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent checkpoint ${passed ? 'verified' : 'failed'}: ${milestone.id}`);
  console.log(`- outcome: ${milestone.outcome}`);
  for (const result of results) console.log(`- ${result.status}: ${result.command}`);
  const next = run.milestones.find((candidate) => candidate.status === 'pending');
  if (passed && next) {
    console.log(`- next: ${sharedCommandLine(P2A_PATHS, 'p2a_runs.mjs', ['checkpoint', ...(runLifecycleSourceArgs(args) ?? ['--runs', runsDir]), '--run-id', run.runId, '--milestone', next.id])}`);
  }
  return passed ? 0 : 1;
}

function finishRun(args) {
  const source = mutationSource(args);
  const runsDir = source?.runsDir ?? resolveRunsDir(args);
  const { run, expectedRun } = readRunForUpdate(runsDir, args.runId);
  if (source) assertRunMatchesSourceContext(run, source);
  const taskSource = source ?? runOnlyTaskSource(runsDir, run);
  const task = requireTask(taskSource.graph, run.taskId);
  const currentContractSha256 = taskContractSha256(task);
  if (run.taskContractSha256 === undefined && run.schema_version === 'p2a.run.v1') {
    run.schema_version = 'p2a.run.v2';
    run.taskContractSha256 = currentContractSha256;
  } else if (run.taskContractSha256 !== currentContractSha256) {
    throw new Error(
      `run ${run.runId} task contract changed after start; expected ${run.taskContractSha256}, got ${currentContractSha256}. Start a new run from the current task graph.`,
    );
  }
  if (run.status !== 'started') {
    throw new Error(`run ${run.runId} is already ${run.status}; use record to append evidence instead of finishing it again`);
  }
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  const changedFiles = [...args.changedFiles];
  if (args.collectGit) changedFiles.push(...collectGitChangedFiles(workspacePath));
  run.changedFiles = uniqueStrings([...run.changedFiles, ...changedFiles]);
  run.verification.push(...args.manualVerification);
  run.notes = uniqueStrings([...run.notes, ...args.notes]);
  appendRunTelemetry(run, args);
  mergeStructuredRunDetails(run, args);
  const requestedStatus = deriveFinishStatus(run, args.status);
  const monitorSidecar = readOrchestrationSidecar(runsDir, run.runId);
  assertRunMonitorGateBinding(run, monitorSidecar);
  const monitorResult = applyMonitorGate(
    args,
    runsDir,
    run,
    taskSource,
    workspacePath,
    monitorSidecar,
    { enforceAcceptance: requestedStatus === 'finished' },
  );
  if (monitorResult) run.monitorVerdictEvidenceSha256 = monitorResult.evidenceSha256;
  if (requestedStatus === 'finished' && monitorResult && !monitorResult.accepted) {
    console.error(`monitor gate blocked finish: verdict=${monitorResult.rawVerdict ?? monitorResult.verdict}; signal=${monitorResult.verdict}; failureClass=${monitorResult.failureClass}; concerns=${monitorResult.concerns}`);
    console.error('blocked monitor finish requires structured detail: add --repro-*/--localization*/--guard* before finishing.');
  }
  const finalStatus = deriveFinishStatus(run, args.status);
  if (finalStatus === 'finished' && run.mode === 'planned' && run.milestones) {
    const pending = run.milestones.find((milestone) => milestone.status !== 'verified');
    if (pending) {
      throw new Error(`planned run ${run.runId} cannot finish before checkpoint ${pending.id}; run p2a runs checkpoint --run-id ${run.runId} --milestone ${pending.id}`);
    }
  }
  const validatedSource = finalStatus === 'finished'
    ? validateRunTaskContract(run, path.dirname(path.resolve(runsDir)))
    : null;
  const visualReviewCutoff = new Date().toISOString();
  if (finalStatus === 'finished') {
    let workspaceRevision = null;
    if (run.visualReview?.required || run.acceptanceReview?.required) {
      if (realpathSync(workspacePath) !== realpathSync(path.resolve(run.workspacePath))) {
        throw new Error(
          `run ${run.runId} final review evidence must be finalized in its recorded workspacePath`,
        );
      }
      workspaceRevision = workspaceRevisionSha256(
        workspacePath,
        workspaceRevisionExcludedPathsForRun(
          runsDir,
          run,
          {
            artifactRoot: taskSource.artifactRoot,
            graphPath: taskSource.graphPath,
            workspacePath,
          },
        ),
      );
    }
    const visualReviewEvidence = readRequiredVisualReviewEvidence(
      runsDir,
      run,
      {
        finishedAt: visualReviewCutoff,
        artifactRoot: path.dirname(path.resolve(runsDir)),
        sourceArtifactRoot: validatedSource.sourceArtifactRoot,
      },
    );
    if (
      visualReviewEvidence
      && visualReviewEvidence.review.workspace_revision_sha256 !== workspaceRevision
    ) {
      throw new Error(
        `run ${run.runId} visual review workspace revision does not match the current workspace; recapture the evidence`,
      );
    }
    if (workspaceRevision) run.workspaceRevisionSha256 = workspaceRevision;
    if (visualReviewEvidence) {
      run.visualReviewEvidenceSha256 = visualReviewEvidence.reviewSha256;
    }
    const acceptanceReviewEvidence = readRequiredAcceptanceReviewEvidence(runsDir, run);
    if (acceptanceReviewEvidence) {
      run.acceptanceReviewEvidenceSha256 = acceptanceReviewEvidence.reviewSha256;
    }
  }
  run.status = finalStatus;
  assertFinishedRunGuard(run);
  const failure = buildFailure(args, run.status);
  assertFailedRunStructuredDetails(run, monitorResult);
  if (failure) run.failure = failure;
  else delete run.failure;
  const finishedAt = new Date().toISOString();
  run.updatedAt = finishedAt;
  run.finishedAt = finishedAt;
  writeRun(runsDir, run, { expectedRun });
  console.log(`Plan2Agent run finished: ${run.runId}`);
  console.log(`- status: ${run.status}`);
  console.log(`- changedFiles: ${run.changedFiles.length}`);
  console.log(`- verification: ${run.verification.length}`);
  console.log(`- usageSamples: ${run.usage?.length ?? 0}`);
  console.log(`- interruptions: ${run.interruptions?.length ?? 0}`);
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

function showWorkspaceRevision(args) {
  const runsDir = resolveRunsDir(args);
  const run = readRun(runsDir, args.runId);
  const workspacePath = args.workspace ? path.resolve(args.workspace) : path.resolve(run.workspacePath);
  assertDirectory(workspacePath, '--workspace');
  if (
    run.visualReview?.required
    && realpathSync(workspacePath) !== realpathSync(path.resolve(run.workspacePath))
  ) {
    throw new Error(`run ${run.runId} visual revision must be computed from its recorded workspacePath`);
  }
  const taskSource = run.visualReview?.required ? runOnlyTaskSource(runsDir, run) : null;
  console.log(workspaceRevisionSha256(
    workspacePath,
    workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot: taskSource?.artifactRoot,
      graphPath: taskSource?.graphPath ?? args.graph,
      workspacePath,
    }),
  ));
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

function migrationRunReplacement(migration) {
  const runFile = migration.files.find((file) => file.suffix === '.json');
  const gateFile = migration.files.find((file) => file.suffix === '.monitor-gate.json');
  if (!runFile || !gateFile) return null;
  const run = JSON.parse(readFileSync(runFile.source, 'utf8'));
  if (!run.monitorGate?.required) return null;
  const gateData = JSON.parse(readFileSync(gateFile.source, 'utf8'));
  gateData.verdictPath = runSidecarRef(migration.targetRef, '.monitor-verdict.json');
  const migratedGate = normalizeMonitorGateSidecar(gateData, run.runId, migration.targetRef);
  const migratedContractSha256 = monitorGateContractSha256(migratedGate);
  if (run.monitorGate.contractSha256 === migratedContractSha256) return null;
  run.monitorGate.contractSha256 = migratedContractSha256;
  validateRunData(run);
  return `${JSON.stringify(run, null, 2)}\n`;
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
  const mergedRetrospective = mergeRunIndexRetrospectives(
    sourceStates.map((state) => state.index),
  );
  if (mergedRetrospective) mergedIndex.retrospective = mergedRetrospective;
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
        replacement: file.suffix === '.json'
          ? migrationRunReplacement(migration)
          : migrationSidecarReplacement(file.source, file.suffix, migration.targetRef),
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

function migrateRunSchema(args) {
  const runsDir = resolveRunsDir(args);
  return withRunStoreLocks([runsDir], () => {
    assertNoPendingRunMigration(runsDir);
    recoverPendingRunWrite(runsDir);
    const runIndex = validateRunsDir(runsDir);
    const selectedEntries = args.runId
      ? runIndex.runs.filter((entry) => entry.runId === args.runId)
      : runIndex.runs;
    if (args.runId && selectedEntries.length === 0) {
      throw new Error(`unknown run id: ${args.runId}`);
    }

    const upgrades = [];
    const skipped = [];
    const artifactRoot = path.dirname(path.resolve(runsDir));
    for (const entry of selectedEntries) {
      const run = readRun(runsDir, entry.runId);
      if (run.schema_version === 'p2a.run.v2') {
        skipped.push({ runId: run.runId, reason: 'already p2a.run.v2' });
        continue;
      }
      if (run.status !== 'finished') {
        skipped.push({ runId: run.runId, reason: `status ${run.status}; only finished evidence is migrated` });
        continue;
      }
      const source = validateRunTaskContract(run, artifactRoot);
      const upgraded = {
        ...run,
        schema_version: 'p2a.run.v2',
        taskContractSha256: taskContractSha256(source.task),
      };
      validateRunData(upgraded);
      validateRunTaskContract(upgraded, artifactRoot);
      upgrades.push({
        run: upgraded,
        expectedRun: JSON.stringify(run),
        runRef: indexedRunRef(runsDir, run.runId, runIndex),
      });
    }

    console.log('Plan2Agent run schema migration');
    console.log(`- runs: ${displayPath(runsDir)}`);
    console.log(`- upgrades: ${upgrades.length}`);
    for (const upgrade of upgrades) console.log(`- ${upgrade.run.runId}: p2a.run.v1 -> p2a.run.v2`);
    for (const item of skipped) console.log(`- skip ${item.runId}: ${item.reason}`);
    if (args.dryRun) {
      console.log('- result: dry-run; source provenance validated; no files changed');
      return 0;
    }

    const mutableIndex = loadIndex(runsDir);
    for (const upgrade of upgrades) {
      const current = loadJson(path.join(runsDir, upgrade.runRef));
      if (JSON.stringify(current) !== upgrade.expectedRun) {
        throw new Error(`run ${upgrade.run.runId} changed while preparing schema migration`);
      }
      upsertIndexRun(runsDir, mutableIndex, upgrade.run, upgrade.runRef);
      commitRunWrite(runsDir, upgrade.runRef, upgrade.run, mutableIndex);
    }
    validateRunsDir(runsDir);
    console.log(`- result: migrated ${upgrades.length} finished run(s) and validated`);
    return 0;
  });
}

function validateRuns(args) {
  const runsDir = resolveRunsDir(args);
  if (args.runId) {
    const index = validateRunsDir(runsDir);
    if (!index.runs.some((run) => run.runId === args.runId)) {
      throw new ValidationError(`unknown run id: ${args.runId}`);
    }
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
    if (args.command === 'checkpoint') return checkpointRun(args);
    if (args.command === 'finish') return finishRun(args);
    if (args.command === 'list') return listRuns(args);
    if (args.command === 'show') return showRun(args);
    if (args.command === 'revision') return showWorkspaceRevision(args);
    if (args.command === 'validate') return validateRuns(args);
    if (args.command === 'migrate-layout') return migrateRunLayout(args);
    if (args.command === 'migrate-schema') return migrateRunSchema(args);
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
