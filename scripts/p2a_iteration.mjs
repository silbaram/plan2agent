#!/usr/bin/env node
/** Manage Plan2Agent iterative artifact layout. */

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadJson,
  resolveSpecSourceIntake,
  validateIntake,
  validateMilestoneReview,
  validateHandoffReadyArtifactRoot,
  validateSpec,
  validateEvalMaintenanceDraftData,
  validateRunIndexData,
  validateRunsDir,
  validateTaskGraph,
  validateTaskContextData,
  validateTaskGraphData,
  approvedVisualReviewContract,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  formatIterationState,
  resolveIterationState,
  serializeIterationState,
  validateActiveIterationBaselineContract as assertActivePlanningBaselineContract,
  validateCurrentSpecCompositionData,
  validateMaintenanceTaskGraphProject,
} from './p2a_iteration_state.mjs';
import { loadRunsForArtifactRoot } from './p2a_runs.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';
import {
  atomicWriteJson,
  atomicWriteText,
  withRunStoreLocks,
} from './p2a_run_store.mjs';
import { shellQuote } from './p2a_run_commands.mjs';
import {
  DEFAULT_MEMORY_CLOSE_TIMEOUT_MS,
  DEFAULT_MEMORY_REQUEST_TIMEOUT_MS,
} from './p2a_constants.mjs';
import {
  buildFeatureRadarEvidence,
  buildFeatureRadarReferenceCandidates,
  loadFeatureRadarPreflight,
} from './p2a_radar_preflight.mjs';
import {
  buildInitialCanonicalSections,
  canonicalComposedBaselineSnapshotRef,
  compositionOpenDecisions,
  compositionReplayContractError,
  compositionSourceContractError,
  composeCanonicalSpecSources,
  IMPLEMENTATION_FIELDS,
  isComposedBaselineReference,
  PRODUCT_FIELDS,
} from './p2a_spec_model.mjs';
import { assertFinalVisualReviewRunReady } from './p2a_visual_review_gate.mjs';
import { resolveReviewPasses } from './p2a_project_config.mjs';
import {
  compareRunEvidence,
  taskGraphContextForGraph,
  taskGraphRefMatchesGraph,
} from './p2a_run_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const GATE_DIRS = ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph'];
const STATUS_ORDER = ['todo', 'in_progress', 'done', 'blocked'];
const DEFAULT_ITERATION_ID = 'v1-mvp';
const INIT_REBASED_SOURCE_INTAKE = '../gate-a-intake/intake.json';
const INIT_REBASED_SOURCE_SPEC = '../gate-b-spec/spec.json';
const COMMANDS = new Set(['init', 'current', 'validate', 'close', 'open', 'draft', 'context', 'promote-spec', 'promote-tasks', 'promote-milestone', 'diff-tasks', 'compose', 'maintenance']);
const MAINTENANCE_ACTIONS = new Set(['add']);
const CONTEXT_SCOPES = new Set(['feature', 'maintenance']);
const VALIDATE_STAGES = new Set(['ready', 'gate-a', 'gate-b-draft', 'gate-b-approved', 'gate-c-draft']);
const PRODUCT_ARRAY_FIELDS = PRODUCT_FIELDS.filter((field) => field !== 'problem');

export { validateCurrentSpecCompositionData };

function usage() {
  return [
    'Usage:',
    '  p2a iteration init --artifacts <greenfield-project-dir> [--iteration-id v1-mvp] [--dry-run]',
    '  p2a iteration current --artifacts <iterative-project-dir> [--json]',
    '  p2a iteration validate --artifacts <iterative-project-dir> [--require-close-ready] [--allow-planning] [--stage ready|gate-a|gate-b-draft|gate-b-approved|gate-c-draft] [--skip-archive-audit]',
    '  p2a iteration close --artifacts <iterative-project-dir> [--iteration-id active]',
    '  p2a iteration open --artifacts <iterative-project-dir> --iteration-id <id> --idea <text>',
    '  p2a iteration draft --artifacts <iterative-project-dir> [--idea <text>] [--force]',
    '  p2a iteration context --artifacts <iterative-project-dir> [--scope feature|maintenance] [--idea <text>] [--code-root <dir>]',
    '  p2a iteration promote-spec --artifacts <iterative-project-dir>',
    '  p2a iteration promote-tasks --artifacts <iterative-project-dir> [--replace-existing]',
    '  p2a iteration promote-milestone --artifacts <iterative-project-dir> --draft <unique-draft-path>',
    '  p2a iteration diff-tasks --artifacts <iterative-project-dir> [--force]',
    '  p2a iteration compose --artifacts <iterative-project-dir> [--allow-conflicts]',
    '  p2a iteration maintenance add --artifacts <iterative-project-dir> --title <text> --accept <text> [--accept <text> ...] [--description <text>] [--area <text>] [--prompt <text>] [--ref <value> ...] [--depends <task-id> ...] [--dry-run]',
    '  p2a iteration maintenance add --artifacts <iterative-project-dir> --from-draft <path> [--dry-run|--yes]',
    '',
    'Commands:',
    '  init                  Convert a greenfield artifact root into iterations/<id>/gate-*.',
    '  current               Print the active iteration paths resolved from current-spec.json.',
    '  validate              Validate active iteration structure and Gate B/C readiness.',
    '  close                 Mark the active close-ready iteration as closed/archived metadata.',
    '  open                  Create a new active iteration skeleton from the current baseline.',
    '  draft                 Generate Gate A scope confirmation, then Gate B after explicit Gate A confirmation.',
    '  context               Print JSON context for agent-authored Gate C task drafting.',
    '  promote-spec          Record an approved active Gate B spec and initialize current-spec when needed.',
    '  promote-tasks         Promote a validated Gate C draft task graph to the canonical graph.',
    '  promote-milestone     Atomically promote one validated unique milestone-review draft.',
    '  diff-tasks            Generate a task graph draft from active spec changes against the baseline.',
    '  compose               Rebuild current-spec.json as a composed effective spec view.',
    '  maintenance           Manage the always-on maintenance task graph (currently: add).',
    '',
    'Common options:',
    '  --artifacts <dir>     Artifact directory. Required.',
    '  --help, -h            Show this help.',
    '',
    'init options:',
    `  --iteration-id <id>  First iteration id. Default: ${DEFAULT_ITERATION_ID}.`,
    '  --dry-run            Print the conversion plan without writing files.',
    '',
    'current options:',
    '  --json               Print machine-readable JSON.',
    '',
    'validate options:',
    '  --require-close-ready  Require every active iteration task to be done.',
    '  --allow-planning      Accept Gate A/B planning states instead of requiring Gate B/C readiness.',
    '  --stage <stage>       Validate a specific stage: ready, gate-a, gate-b-draft, gate-b-approved, gate-c-draft.',
    '  --audit-archive       Verify hashes recorded when iterations were closed. This is now the default.',
    '  --skip-archive-audit  Skip closed-iteration hash verification for legacy/migration cases.',
    '',
    'close options:',
    '  --iteration-id active|<id>  Iteration to close. Default: active. Only active is supported for now.',
    '',
    'open options:',
    '  --iteration-id <id>   New iteration id. Required.',
    '  --idea <text>         Change idea for the new iteration. Required.',
    '',
    'draft options:',
    '  --idea <text>         Override the change idea stored by open.',
    '  --force               Reset existing baseline-aware Gate A/B drafts and restart Gate A scope confirmation.',
    '',
    'context options:',
    '  --scope <scope>      Context scope: feature or maintenance. Default: feature.',
    '  --idea <text>         Override the idea included in the emitted context JSON.',
    '  --code-root <dir>     Code root to scan for L1 file-tree signals. Default: current working directory.',
    '',
    'promote-tasks options:',
    '  --replace-existing     Replace a validated complete graph only before any active-iteration task/run execution history exists.',
    '',
    'promote-milestone options:',
    '  --draft <path>         Unique <checkpoint>.<id>.draft.json inside the active iteration milestone-reviews directory.',
    '',
    'diff-tasks options:',
    '  --force               Overwrite existing Gate C task graph draft.',
    '',
    'compose options:',
    '  --allow-conflicts     Write current-spec open_decisions when composition conflicts are detected.',
    '',
    'maintenance add options:',
    '  --title <text>        Task title. Required.',
    '  --accept <text>       Acceptance criterion. Required; repeat for multiple criteria.',
    '  --description <text>  Task description. Defaults to --title.',
    '  --area <text>         Task targetArea. Defaults to maintenance.',
    '  --prompt <text>       suggestedAgentPrompt. Defaults to a generated scoped prompt.',
    '  --ref <value>         sourceSpecRefs entry. Repeatable; defaults to maintenance.',
    '  --depends <task-id>   Dependency task id. Repeatable; defaults to none.',
    '  --from-draft <path>   Append tasks from a reviewed maintenance draft JSON.',
    '  --yes                 Confirm writing tasks from --from-draft. Not needed with --dry-run.',
    '  --dry-run            Print the task and graph path without writing files.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    help: false,
    iterationId: DEFAULT_ITERATION_ID,
    iterationIdProvided: false,
    idea: null,
    json: false,
    force: false,
    requireCloseReady: false,
    allowPlanning: false,
    stage: null,
    auditArchive: false,
    skipArchiveAudit: false,
    allowConflicts: false,
    action: null,
    title: null,
    description: null,
    area: 'maintenance',
    prompt: null,
    fromDraft: null,
    acceptanceCriteria: [],
    sourceSpecRefs: [],
    dependencies: [],
    areaProvided: false,
    codeRoot: process.cwd(),
    scope: 'feature',
    replaceExisting: false,
    milestoneDraft: null,
    yes: false,
  };
  const command = argv[0];
  if (!command) throw new Error(`missing command\n\n${usage()}`);
  if (command === '--help' || command === '-h') return { ...args, help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  args.command = command;
  let startIndex = 1;
  if (command === 'maintenance') {
    args.action = argv[1];
    if (!args.action) throw new Error(`maintenance requires an action: ${[...MAINTENANCE_ACTIONS].join(', ')}`);
    if (!MAINTENANCE_ACTIONS.has(args.action)) throw new Error(`unsupported maintenance action: ${args.action}`);
    startIndex = 2;
  }

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--artifacts') {
      args.artifacts = argv[++index];
      if (!args.artifacts) throw new Error('--artifacts requires a directory');
    } else if (arg === '--iteration-id') {
      if (command !== 'init' && command !== 'open' && command !== 'close') throw new Error('--iteration-id is only supported by init, open, and close');
      args.iterationId = argv[++index];
      if (!args.iterationId) throw new Error('--iteration-id requires a value');
      args.iterationIdProvided = true;
    } else if (arg === '--idea') {
      if (command !== 'open' && command !== 'draft' && command !== 'context') throw new Error('--idea is only supported by open, draft, and context');
      args.idea = argv[++index];
      if (!args.idea) throw new Error('--idea requires a value');
    } else if (arg === '--code-root') {
      if (command !== 'context') throw new Error('--code-root is only supported by context');
      args.codeRoot = argv[++index];
      if (!args.codeRoot) throw new Error('--code-root requires a directory');
    } else if (arg === '--scope') {
      if (command !== 'context') throw new Error('--scope is only supported by context');
      args.scope = argv[++index];
      if (!CONTEXT_SCOPES.has(args.scope)) throw new Error(`--scope must be one of ${[...CONTEXT_SCOPES].join(', ')}`);
    } else if (arg === '--force') {
      if (command !== 'draft' && command !== 'diff-tasks') throw new Error('--force is only supported by draft and diff-tasks');
      args.force = true;
    } else if (arg === '--dry-run') {
      if (command !== 'init' && !(command === 'maintenance' && args.action === 'add')) throw new Error('--dry-run is only supported by init and maintenance add');
      args.dryRun = true;
    } else if (arg === '--json') {
      if (command !== 'current') throw new Error('--json is only supported by current');
      args.json = true;
    } else if (arg === '--require-close-ready') {
      if (command !== 'validate') throw new Error('--require-close-ready is only supported by validate');
      args.requireCloseReady = true;
    } else if (arg === '--allow-planning') {
      if (command !== 'validate') throw new Error('--allow-planning is only supported by validate');
      args.allowPlanning = true;
    } else if (arg === '--stage') {
      if (command !== 'validate') throw new Error('--stage is only supported by validate');
      args.stage = argv[++index];
      if (!VALIDATE_STAGES.has(args.stage)) throw new Error(`--stage must be one of ${[...VALIDATE_STAGES].join(', ')}`);
    } else if (arg === '--audit-archive') {
      if (command !== 'validate') throw new Error('--audit-archive is only supported by validate');
      args.auditArchive = true;
    } else if (arg === '--skip-archive-audit') {
      if (command !== 'validate') throw new Error('--skip-archive-audit is only supported by validate');
      args.skipArchiveAudit = true;
    } else if (arg === '--allow-conflicts') {
      if (command !== 'compose') throw new Error('--allow-conflicts is only supported by compose');
      args.allowConflicts = true;
    } else if (arg === '--replace-existing') {
      if (command !== 'promote-tasks') throw new Error('--replace-existing is only supported by promote-tasks');
      args.replaceExisting = true;
    } else if (arg === '--draft') {
      if (command !== 'promote-milestone') throw new Error('--draft is only supported by promote-milestone');
      args.milestoneDraft = argv[++index];
      if (!args.milestoneDraft) throw new Error('--draft requires a path');
    } else if (arg === '--title') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--title is only supported by maintenance add');
      args.title = argv[++index];
      if (!args.title) throw new Error('--title requires a value');
    } else if (arg === '--accept') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--accept is only supported by maintenance add');
      const value = argv[++index];
      if (!value) throw new Error('--accept requires a value');
      args.acceptanceCriteria.push(value);
    } else if (arg === '--description') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--description is only supported by maintenance add');
      args.description = argv[++index];
      if (!args.description) throw new Error('--description requires a value');
    } else if (arg === '--area') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--area is only supported by maintenance add');
      args.areaProvided = true;
      args.area = argv[++index];
      if (!args.area) throw new Error('--area requires a value');
    } else if (arg === '--prompt') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--prompt is only supported by maintenance add');
      args.prompt = argv[++index];
      if (!args.prompt) throw new Error('--prompt requires a value');
    } else if (arg === '--ref') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--ref is only supported by maintenance add');
      const value = argv[++index];
      if (!value) throw new Error('--ref requires a value');
      args.sourceSpecRefs.push(value);
    } else if (arg === '--depends') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--depends is only supported by maintenance add');
      const value = argv[++index];
      if (!value) throw new Error('--depends requires a value');
      args.dependencies.push(value);
    } else if (arg === '--from-draft') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--from-draft is only supported by maintenance add');
      args.fromDraft = argv[++index];
      if (!args.fromDraft) throw new Error('--from-draft requires a path');
    } else if (arg === '--yes') {
      if (command !== 'maintenance' || args.action !== 'add') throw new Error('--yes is only supported by maintenance add --from-draft');
      args.yes = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!args.help && !args.artifacts) throw new Error(`--artifacts is required\n\n${usage()}`);
  if (command === 'open' && !args.iterationIdProvided) throw new Error('--iteration-id is required for open');
  if (command === 'open' && (!args.idea || args.idea.trim().length === 0)) throw new Error('--idea is required for open');
  if (command === 'promote-milestone' && !args.milestoneDraft) throw new Error('--draft is required for promote-milestone');
  if (command === 'maintenance' && args.action === 'add') {
    if (args.fromDraft) {
      if (args.title || args.description || args.prompt || args.acceptanceCriteria.length || args.sourceSpecRefs.length || args.dependencies.length || args.areaProvided) {
        throw new Error('--from-draft cannot be combined with --title, --description, --area, --prompt, --accept, --ref, or --depends');
      }
      if (args.yes && args.dryRun) throw new Error('--yes and --dry-run cannot be combined');
      if (!args.dryRun && !args.yes) throw new Error('maintenance add --from-draft requires --yes unless --dry-run is used');
    } else {
      if (args.yes) throw new Error('--yes is only supported with maintenance add --from-draft');
      if (!args.title || args.title.trim().length === 0) throw new Error('--title is required for maintenance add');
      if (!args.acceptanceCriteria.length) throw new Error('--accept is required for maintenance add');
    }
  }
  return args;
}

function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new Error(`${label} does not exist: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new Error(`${label} is not a directory: ${dirPath}`);
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

function toRelativeFromRoot(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function normalizeArtifactPath(artifactPath) {
  return path.resolve(process.cwd(), artifactPath);
}

function assertSafeIterationId(iterationId) {
  if (iterationId.includes('/') || iterationId.includes('\\') || iterationId === '.' || iterationId === '..') {
    throw new Error(`--iteration-id must be a single path segment, got ${JSON.stringify(iterationId)}`);
  }
  if (iterationId.trim().length === 0) throw new Error('--iteration-id must not be blank');
  if (!/^[A-Za-z0-9._-]+$/.test(iterationId)) {
    throw new Error(`--iteration-id may only contain letters, numbers, dots, underscores, and hyphens, got ${JSON.stringify(iterationId)}`);
  }
}

function assertSafeCompositionIterationId(iterationId, label) {
  if (
    iterationId.includes('/')
    || iterationId.includes('\\')
    || iterationId === '.'
    || iterationId === '..'
    || !/^[A-Za-z0-9._-]+$/.test(iterationId)
  ) {
    throw new ValidationError(
      `${label} must be a safe single path segment, got ${JSON.stringify(iterationId)}`,
    );
  }
}

function assertFileInsideArtifactRoot(filePath, artifactRoot, label) {
  const rootRealPath = realpathSync(artifactRoot);
  const fileRealPath = realpathSync(filePath);
  const relativePath = path.relative(rootRealPath, fileRealPath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new ValidationError(`${label} must resolve inside the artifact root`);
  }
  return fileRealPath;
}

function pathsFor(artifactRoot, iterationId) {
  const iterationRoot = path.join(artifactRoot, 'iterations', iterationId);
  return {
    artifactRoot,
    iterationRoot,
    iterationsRoot: path.join(artifactRoot, 'iterations'),
    maintenanceRoot: path.join(artifactRoot, 'iterations', 'maintenance'),
    maintenanceReadme: path.join(artifactRoot, 'iterations', 'maintenance', 'README.md'),
    statusMd: path.join(artifactRoot, 'status.md'),
    currentSpec: path.join(artifactRoot, 'current-spec.json'),
    specJson: path.join(artifactRoot, 'gate-b-spec', 'spec.json'),
    taskGraph: path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'),
    movedSpecJson: path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
    movedTaskGraph: path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'),
  };
}

function preflight(paths, iterationId) {
  assertSafeIterationId(iterationId);
  assertDirectory(paths.artifactRoot, '--artifacts');
  if (existsSync(paths.iterationsRoot)) {
    throw new Error(`already iterative layout: ${paths.iterationsRoot} exists`);
  }
  assertFile(paths.specJson, 'greenfield gate-b-spec/spec.json');
  const missingGates = GATE_DIRS.filter((gate) => !existsSync(path.join(paths.artifactRoot, gate)));
  if (missingGates.length) throw new Error(`missing greenfield gate directories: ${missingGates.join(', ')}`);
  for (const gate of GATE_DIRS) assertDirectory(path.join(paths.artifactRoot, gate), gate);
  assertFile(paths.taskGraph, 'greenfield gate-c-task-graph/task-graph.json');

  const rootValidation = validateHandoffReadyArtifactRoot(paths.artifactRoot);
  const gateBApprovalAudit = gateBApprovalAuditForIteration(
    rootValidation.spec.approval_audit ?? parseGateBApprovalAudit(paths.statusMd),
    iterationId,
    'Gate B approval preserved from greenfield status during iteration init.',
  );
  return {
    spec: rootValidation.spec,
    taskGraph: rootValidation.taskGraph,
    gateBApprovalAudit,
  };
}

function countStatuses(tasks) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function projectIdFrom(artifactRoot, spec, taskGraph) {
  return spec.project_id ?? taskGraph.projectId ?? path.basename(artifactRoot);
}

function gateSummary(spec, taskGraph) {
  const approval = spec.approval ?? 'unknown';
  const bBadge = approval === 'approved' ? `B✅(${approval})` : `B⚠️(${approval})`;
  const cBadge = Array.isArray(taskGraph.tasks) && taskGraph.tasks.length > 0 ? 'C✅' : 'C⚠️';
  return `A✅ ${bBadge} ${cBadge}`;
}

function taskSummary(taskGraph) {
  const counts = countStatuses(taskGraph.tasks ?? []);
  return `${taskGraph.tasks?.length ?? 0}(todo ${counts.todo}·in_progress ${counts.in_progress}·done ${counts.done}·blocked ${counts.blocked})`;
}

function taskSummaryIfPresent(filePath) {
  if (!existsSync(filePath)) return '0 (graph 미생성)';
  try {
    return taskSummary(loadJson(filePath));
  } catch {
    return 'graph invalid';
  }
}

function gateSummaryIfPresent(artifactRoot, iterationId) {
  const specPath = path.join(artifactRoot, sourceSpecRef(iterationId));
  const taskGraphPath = path.join(artifactRoot, taskGraphRef(iterationId));
  if (!existsSync(specPath)) return 'A/B/C 대기';
  try {
    const spec = validateSpec(specPath, null, { artifactRoot });
    if (!existsSync(taskGraphPath)) return spec.approval === 'approved' ? 'B✅ C 대기' : `B⚠️(${spec.approval}) C 대기`;
    const taskGraph = validateTaskGraph(taskGraphPath, specPath);
    return gateSummary(spec, taskGraph);
  } catch {
    return 'gate invalid';
  }
}

function normalizeDisplayPath(reference) {
  return String(reference).split(path.sep).join('/');
}

function artifactRelativePath(artifactRoot, filePath) {
  return normalizeDisplayPath(path.relative(artifactRoot, filePath));
}

function artifactStateLockDir(artifactRoot) {
  return path.join(artifactRoot, 'iterations');
}

function resolveArtifactFileReference(reference, artifactRoot) {
  if (!reference || typeof reference !== 'string') return null;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(artifactRoot, reference),
        path.resolve(ROOT, reference),
      ];
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? candidates[0];
}

function writeJson(filePath, value) {
  atomicWriteJson(filePath, value);
}

function captureRollbackFiles(filePaths) {
  return [...new Set(filePaths.map((filePath) => path.resolve(filePath)))]
    .map((filePath) => {
      if (!existsSync(filePath)) return { filePath, kind: 'absent' };
      const stat = lstatSync(filePath);
      if (!stat.isFile()) return { filePath, kind: 'other' };
      return {
        filePath,
        kind: 'file',
        contents: readFileSync(filePath),
      };
    });
}

function restoreRollbackFiles(snapshot) {
  const failures = [];
  for (const item of [...snapshot].reverse()) {
    try {
      if (item.kind === 'other') continue;
      if (item.kind === 'absent') {
        if (!existsSync(item.filePath)) continue;
        const stat = lstatSync(item.filePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new Error('rollback target was created as a non-file');
        }
        unlinkSync(item.filePath);
        continue;
      }
      if (existsSync(item.filePath)) {
        const stat = lstatSync(item.filePath);
        if (!stat.isFile()) throw new Error('rollback target is no longer a file');
      } else {
        mkdirSync(path.dirname(item.filePath), { recursive: true });
      }
      atomicWriteText(item.filePath, item.contents);
    } catch (error) {
      failures.push(`${item.filePath}: ${error.message}`);
    }
  }
  return failures;
}

export function withIterationCloseRollback(paths, callback) {
  const snapshot = captureRollbackFiles([
    paths.metadataPath,
    paths.currentSpecPath,
    paths.statusPath,
    paths.memoryStatusPath,
  ]);
  try {
    return callback();
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(snapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; iteration close rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function optionalArtifactHash(artifactRoot, reference) {
  const filePath = resolveArtifactFileReference(reference, artifactRoot);
  return existsSync(filePath) && lstatSync(filePath).isFile() ? fileSha256(filePath) : null;
}

function artifactAuditEntry(artifactRoot, reference) {
  const hash = optionalArtifactHash(artifactRoot, reference);
  return hash
    ? { present: true, sha256: hash }
    : { present: false, sha256: null };
}

function closedIterationVisualArtifactRefs(iterationId, artifactRoot) {
  const gateBRoot = path.join(artifactRoot, 'iterations', iterationId, 'gate-b-spec');
  const refs = [];
  const experiencePath = path.join(gateBRoot, 'experience-spec.json');
  if (existsSync(experiencePath) && lstatSync(experiencePath).isFile()) {
    refs.push(normalizeDisplayPath(path.relative(artifactRoot, experiencePath)));
  }
  const visualDesignRoot = path.join(gateBRoot, 'visual-design');
  if (!existsSync(visualDesignRoot)) return refs;
  if (!lstatSync(visualDesignRoot).isDirectory()) {
    throw new ValidationError(`closed iteration visual-design path must be a directory: ${visualDesignRoot}`);
  }
  const directories = [visualDesignRoot];
  while (directories.length) {
    const directory = directories.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile()) refs.push(normalizeDisplayPath(path.relative(artifactRoot, entryPath)));
      else {
        throw new ValidationError(
          `closed iteration visual-design contains unsupported entry: ${entryPath}`,
        );
      }
    }
  }
  return refs.sort();
}

function closedIterationArtifactRefs(iterationId, artifactRoot) {
  const experienceRef = `iterations/${iterationId}/gate-b-spec/experience-spec.json`;
  const visualRefs = closedIterationVisualArtifactRefs(iterationId, artifactRoot)
    .filter((reference) => reference !== experienceRef);
  return [
    canonicalComposedBaselineSnapshotRef(iterationId),
    `iterations/${iterationId}/gate-a-intake/intake.json`,
    `iterations/${iterationId}/gate-a-intake/intake.md`,
    `iterations/${iterationId}/gate-b-spec/product-spec.md`,
    `iterations/${iterationId}/gate-b-spec/implementation-plan.md`,
    experienceRef,
    sourceSpecRef(iterationId),
    taskGraphRef(iterationId),
    ...visualRefs,
  ];
}

function isClosedIterationVisualArtifactRef(reference, iterationId) {
  const gateBPrefix = `iterations/${iterationId}/gate-b-spec/`;
  return reference === `${gateBPrefix}experience-spec.json`
    || reference.startsWith(`${gateBPrefix}visual-design/`);
}

function artifactHashes(artifactRoot, references) {
  const hashes = {};
  for (const reference of references) {
    hashes[reference] = artifactAuditEntry(artifactRoot, reference);
  }
  return hashes;
}

function statusIterationIds(artifactRoot, currentSpec) {
  const ids = [];
  const add = (iterationId) => {
    if (typeof iterationId === 'string' && iterationId && iterationId !== 'maintenance' && !ids.includes(iterationId)) {
      ids.push(iterationId);
    }
  };
  for (const iterationId of currentSpec.composed_from ?? []) add(iterationId);
  for (const closed of currentSpec.closed_iterations ?? []) add(closed?.iteration_id);
  add(currentSpec.last_closed_iteration?.iteration_id);
  add(currentSpec.pending_iteration?.iteration_id);
  add(currentSpec.active_iteration);

  const iterationsRoot = path.join(artifactRoot, 'iterations');
  if (existsSync(iterationsRoot) && lstatSync(iterationsRoot).isDirectory()) {
    for (const entry of readdirSync(iterationsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) add(entry.name);
    }
  }
  return ids;
}

function statusForIterationId(currentSpec, iterationId) {
  const pending = currentSpec.pending_iteration;
  if (pending?.iteration_id === iterationId) return pending.status ?? 'active_planning';
  const closed = (currentSpec.closed_iterations ?? []).find((record) => record?.iteration_id === iterationId);
  if (closed) return closed.status ?? 'archived';
  if (iterationId === currentSpec.active_iteration) return 'active';
  return 'archived';
}

function statusMaintenanceSummary(artifactRoot) {
  const graphPath = maintenanceTaskGraphPath(artifactRoot);
  return taskSummaryIfPresent(graphPath);
}

function renderClosedIterationAudit(currentSpec) {
  const closed = currentSpec.closed_iterations ?? [];
  if (!closed.length) return '아직 close된 반복이 없습니다.\n';
  const rows = [
    '| 반복 | closed_at | effective spec | artifact audit |',
    '| --- | --- | --- | --- |',
  ];
  for (const record of closed) {
    const auditCount = record.artifact_hashes && typeof record.artifact_hashes === 'object'
      ? Object.keys(record.artifact_hashes).length
      : 0;
    rows.push(`| ${record.iteration_id} | ${record.closed_at ?? 'unknown'} | ${record.effective_spec_ref ?? 'unknown'} | ${auditCount} file(s) |`);
  }
  return `${rows.join('\n')}\n`;
}

function renderHandoffAudit(currentSpec) {
  const handoffs = currentSpec.handoff_records ?? [];
  if (!handoffs.length) return '아직 handoff 기록이 없습니다.\n';
  const rows = [
    '| handed_off_at | 반복 | 대상 | mode | 도구 | maintenance |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of handoffs) {
    rows.push(`| ${record.handed_off_at ?? 'unknown'} | ${record.iteration_id ?? 'unknown'} | ${record.target_project ?? 'unknown'} | ${record.mode ?? 'copy'} | ${(record.ai_tool_targets ?? []).join(', ') || 'none'} | ${record.maintenance_included ? 'included' : 'not included'} |`);
  }
  return `${rows.join('\n')}\n`;
}

function parseApprovalAudit(statusPath, heading) {
  if (!existsSync(statusPath)) return null;
  const text = readFileSync(statusPath, 'utf8');
  const headingMatch = text.match(new RegExp(`^#{3,6}\\s+${heading}\\s*$`, 'im'));
  if (!headingMatch) return null;
  const tail = text.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = tail.search(/^#{1,6}\s+/m);
  const block = nextHeading === -1 ? tail : tail.slice(0, nextHeading);
  const get = (label) => {
    const match = block.match(new RegExp(`^\\s*-\\s*${label}:\\s*(.+?)\\s*$`, 'im'));
    return match ? match[1].trim() : null;
  };
  return {
    approved_by: get('Approved by'),
    approved_at: get('Approved at'),
    approved_artifacts: parseApprovedArtifacts(get('Approved artifacts')),
    approval_note: get('Approval note'),
  };
}

function parseApprovedArtifacts(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

function parseGateBApprovalAudit(statusPath) {
  return parseApprovalAudit(statusPath, 'Gate B approval audit');
}

function gateBApprovalArtifactsForIteration(iterationId) {
  return [
    sourceSpecRef(iterationId),
  ];
}

function gateBApprovalAuditForIteration(audit, iterationId, fallbackNote, approvedAtOverride = null) {
  const approvedAt = approvedAtOverride ?? audit?.approved_at ?? new Date().toISOString().slice(0, 10);
  return {
    approved_by: audit?.approved_by ?? 'user',
    approved_at: approvedAt.slice(0, 10),
    approved_artifacts: gateBApprovalArtifactsForIteration(iterationId),
    approval_note: audit?.approval_note ?? fallbackNote,
  };
}

function currentSpecWithGateBApprovalAudit(currentSpec, iterationId, audit) {
  return {
    ...currentSpec,
    gate_b_approval_audits: {
      ...(currentSpec.gate_b_approval_audits ?? {}),
      [iterationId]: audit,
    },
  };
}

function renderGateBApprovalAudit(currentSpec, iterationId) {
  const audit = currentSpec.gate_b_approval_audits?.[iterationId];
  if (!audit) return '';
  const artifacts = Array.isArray(audit.approved_artifacts)
    ? audit.approved_artifacts
    : parseApprovedArtifacts(audit.approved_artifacts);
  const artifactText = artifacts.map((item) => `\`${item}\``).join(', ');
  return `#### Gate B approval audit\n\n` +
    `- Approved by: ${audit.approved_by ?? 'user'}\n` +
    `- Approved at: ${(audit.approved_at ?? new Date().toISOString()).slice(0, 10)}\n` +
    `- Approved artifacts: ${artifactText || '`iterations/<iter-id>/gate-b-spec/spec.json`'}\n` +
    `- Approval note: ${audit.approval_note ?? 'Gate B approved.'}\n\n`;
}

function progressForIteration(artifactRoot, currentSpec, activeIteration) {
  const status = statusForIterationId(currentSpec, activeIteration);
  if (status === 'active_planning') return '[scope:pending] -> [spec:pending] -> [plan:pending]';
  if (status === 'gate_a_ready') return '[scope:approved] -> [spec:current] -> [plan:pending]';
  if (status === 'gate_b_draft') return '[scope:approved] -> [spec:draft] -> [plan:pending]';
  if (status === 'gate_b_approved') {
    const specPath = path.join(artifactRoot, sourceSpecRef(activeIteration));
    const taskGraphPath = path.join(artifactRoot, taskGraphRef(activeIteration));
    if (existsSync(specPath) && existsSync(taskGraphPath)) {
      try {
        validateTaskGraph(taskGraphPath, specPath);
        return '[scope:approved] -> [spec:approved] -> [plan:valid]';
      } catch {
        // The detailed Gate C section reports invalid or incomplete graph state.
      }
    }
    return '[scope:approved] -> [spec:approved] -> [plan:pending]';
  }
  return '[scope:approved] -> [spec:approved] -> [plan:valid]';
}

function renderActiveGateSections(artifactRoot, activeIteration, currentSpec) {
  const iterationRoot = path.join(artifactRoot, 'iterations', activeIteration);
  const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
  const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
  const taskGraphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
  const spec = existsSync(specPath) ? loadJson(specPath) : null;
  const taskGraph = existsSync(taskGraphPath) ? loadJson(taskGraphPath) : null;
  return `### Gate A - Intake decisions\n\n` +
    `- 상태: ${existsSync(intakePath) ? 'present' : 'pending'}\n` +
    `- 정본 파일: \`iterations/${activeIteration}/gate-a-intake/intake.json\`\n\n` +
    `### Gate B - Spec approval\n\n` +
    `- 상태: ${spec ? `approval=${spec.approval}, open_decisions=${spec.open_decisions?.length ?? 'unknown'}` : 'pending'}\n` +
    `- 정본 파일: \`iterations/${activeIteration}/gate-b-spec/spec.json\`\n\n` +
    renderGateBApprovalAudit(currentSpec, activeIteration) +
    `### Gate C - Task graph validation\n\n` +
    `- 상태: ${taskGraph ? `${taskGraph.tasks?.length ?? 0} task(s)` : 'pending'}\n` +
    `- 정본 파일: \`iterations/${activeIteration}/gate-c-task-graph/task-graph.json\`\n\n` +
    `- 검증: \`p2a iteration validate --artifacts <dir>\`\n`;
}

export function renderIterationIndexMarkdown(artifactRoot, currentSpec) {
  const projectId = currentSpec.project_id ?? path.basename(artifactRoot);
  const activeIteration = currentSpec.active_iteration;
  const rows = [
    '| 반복 | 상태 | task | 게이트 | 위치 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const iterationId of statusIterationIds(artifactRoot, currentSpec)) {
    rows.push(`| ${iterationId} | ${statusForIterationId(currentSpec, iterationId)} | ${taskSummaryIfPresent(path.join(artifactRoot, taskGraphRef(iterationId)))} | ${gateSummaryIfPresent(artifactRoot, iterationId)} | iterations/${iterationId}/ |`);
  }
  rows.push(`| maintenance | 상시 active | ${statusMaintenanceSummary(artifactRoot)} | task graph only | iterations/maintenance/ |`);

  const pending = currentSpec.pending_iteration;
  const pendingBlock = pending
    ? `### 열린 변경 아이디어\n\n- iteration: ${pending.iteration_id}\n- status: ${pending.status ?? 'active_planning'}\n- opened_at: ${pending.opened_at ?? 'unknown'}\n- drafted_at: ${pending.drafted_at ?? 'not drafted'}\n- idea: ${pending.idea ?? 'not recorded'}\n\n`
    : '';

  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
    `<!-- p2a:active-iteration=${activeIteration} -->\n\n` +
    `Progress: ${progressForIteration(artifactRoot, currentSpec, activeIteration)}\n\n` +
    `> 정본: iterations/<iter-id>/gate-*, current-spec.json\n` +
    `> 반복 history, close 기준점, handoff 기준점을 누적 렌더링합니다.\n\n` +
    `## 1. 진행 상태\n\n` +
    `- 활성 기능 반복: ${activeIteration} (${statusForIterationId(currentSpec, activeIteration)})\n` +
    `- maintenance: iterations/maintenance (상시)\n` +
    `- current-spec: current-spec.json (effective → ${currentSpec.effective_spec_ref ?? 'not set'})\n\n` +
    pendingBlock +
    `## 2. 게이트별\n\n` +
    renderActiveGateSections(artifactRoot, activeIteration, currentSpec) +
    `\n## 3. 열린 결정 / 반복 목록\n\n` +
    `- current-spec open_decisions: ${(currentSpec.open_decisions ?? []).length}\n\n` +
    `${rows.join('\n')}\n\n` +
    `### Close Audit\n\n${renderClosedIterationAudit(currentSpec)}\n` +
    `### Handoff Audit\n\n${renderHandoffAudit(currentSpec)}\n` +
    `## 4. 다음\n\n` +
    `- 새 기능 → \`p2a iteration open --iteration-id <next> --idea <text>\`\n` +
    `- 작은 fix → \`p2a iteration maintenance add ...\`\n` +
    `- 검증 → \`p2a iteration validate --artifacts <dir>\` (closed iteration archive audit 기본 수행)\n\n` +
    `## 5. 변경 이력\n\n` +
    `- status generated from current-spec.json for active iteration \`${activeIteration}\`.\n`;
}

function writeIterationStatus(artifactRoot, currentSpec) {
  atomicWriteText(
    path.join(artifactRoot, 'status.md'),
    renderIterationIndexMarkdown(artifactRoot, currentSpec),
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function appendUnique(values, additions) {
  const next = [...asStringArray(values)];
  for (const addition of additions) {
    if (addition && !next.includes(addition)) next.push(addition);
  }
  return next;
}

function markdownList(values) {
  const items = asStringArray(values);
  if (!items.length) return '- None';
  return items.map((item) => `- ${item}`).join('\n');
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') throw new ValidationError(`${label}[${index}] must be a string`);
  }
}

function validateProductShape(product, label = 'effective_product') {
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw new ValidationError(`${label} must be an object`);
  }
  assertString(product.problem, `${label}.problem`);
  for (const field of PRODUCT_ARRAY_FIELDS) {
    assertStringArray(product[field], `${label}.${field}`);
  }
}

function validateImplementationShape(implementation, label = 'effective_implementation') {
  if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) {
    throw new ValidationError(`${label} must be an object`);
  }
  for (const field of IMPLEMENTATION_FIELDS) {
    assertStringArray(implementation[field], `${label}.${field}`);
  }
}

function validateEffectiveSections(product, implementation, label = 'current-spec.json') {
  validateProductShape(product, `${label}.effective_product`);
  validateImplementationShape(implementation, `${label}.effective_implementation`);
}

function currentSpecWebEvidence(currentSpec, artifactRoot) {
  const sourceSpecs = Array.isArray(currentSpec.source_specs) ? currentSpec.source_specs : [];
  const entries = [];
  const seen = new Set();
  for (const source of sourceSpecs) {
    if (!source?.spec_ref) continue;
    const sourcePath = resolveArtifactFileReference(source.spec_ref, artifactRoot);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) continue;
    const sourceSpec = loadJson(sourcePath);
    for (const item of sourceSpec.evidence ?? []) {
      if (typeof item?.source_id !== 'string' || !item.source_id.startsWith('WEB-')) continue;
      const key = `${item.url ?? ''}\n${item.title ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        ...item,
        used_for: `Carried forward from composed source ${source.spec_ref} (${item.source_id}): ${item.used_for}`,
      });
    }
  }
  return entries.map((item, index) => ({
    ...item,
    source_id: `WEB-${index + 1}`,
  }));
}

function loadEffectiveBaselineSpec(filePath, artifactRoot = path.dirname(filePath)) {
  const data = loadJson(filePath);
  if (data.schema_version === 'p2a.spec.v1') {
    return validateSpec(filePath, null, { artifactRoot });
  }
  if (data.schema_version !== 'p2a.current_spec.v1') {
    throw new ValidationError(`baseline must be p2a.spec.v1 or p2a.current_spec.v1, got ${JSON.stringify(data.schema_version)}`);
  }
  validateCurrentSpecCompositionData(data, artifactRoot, { requireNoOpenDecisions: true });
  return {
    schema_version: 'p2a.spec.v1',
    project_id: data.project_id,
    source_intake: data.effective_spec_ref ?? 'current-spec.json',
    product: data.effective_product,
    implementation: data.effective_implementation,
    clarifying_question_disposition: [],
    open_decisions: [],
    approval: 'approved',
    evidence: currentSpecWebEvidence(data, artifactRoot),
  };
}

function currentSpecPointer(projectId, iterationId, gateBApprovalAudit) {
  let currentSpec = {
    schema_version: 'p2a.current_spec.v1',
    project_id: projectId,
    composed_from: [iterationId],
    active_iteration: iterationId,
    effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    note: '반복 1개라 이 반복 spec이 곧 현재 유효 spec. 다중 반복 조합 규칙은 docs/iteration-spec.md에서 정식화.',
  };
  if (gateBApprovalAudit) currentSpec = currentSpecWithGateBApprovalAudit(currentSpec, iterationId, gateBApprovalAudit);
  return currentSpec;
}

function currentSpecForOpen(
  currentSpec,
  nextIterationId,
  previousIterationId,
  idea,
  openedAt,
  baselineSpecRef,
  baselineSpecSha256,
) {
  return {
    ...currentSpec,
    active_iteration: nextIterationId,
    pending_iteration: {
      iteration_id: nextIterationId,
      status: 'active_planning',
      opened_at: openedAt,
      idea,
      baseline_iteration: previousIterationId,
      baseline_effective_spec_ref: baselineSpecRef,
      ...(baselineSpecSha256
        ? { baseline_effective_spec_sha256: baselineSpecSha256 }
        : {}),
    },
  };
}

function closeRecord(iterationId, closedAt, taskGraph, effectiveSpecRef, artifactRoot) {
  return {
    iteration_id: iterationId,
    status: 'archived',
    closed_at: closedAt,
    effective_spec_ref: effectiveSpecRef,
    spec_ref: sourceSpecRef(iterationId),
    task_graph_ref: taskGraphRef(iterationId),
    task_count: taskGraph.tasks?.length ?? 0,
    task_status_counts: countStatuses(taskGraph.tasks ?? []),
    artifact_hashes: artifactHashes(artifactRoot, closedIterationArtifactRefs(iterationId, artifactRoot)),
  };
}

function currentSpecForClose(currentSpec, iterationId, record) {
  const closedIterations = Array.isArray(currentSpec.closed_iterations)
    ? currentSpec.closed_iterations.filter((closed) => closed?.iteration_id !== iterationId)
    : [];
  const nextCurrentSpec = {
    ...currentSpec,
    last_closed_iteration: record,
    closed_iterations: [...closedIterations, record],
  };

  if (nextCurrentSpec.pending_iteration?.iteration_id === iterationId) {
    delete nextCurrentSpec.pending_iteration;
  }
  if (Array.isArray(nextCurrentSpec.source_specs)) {
    nextCurrentSpec.source_specs = nextCurrentSpec.source_specs.map((source) => (
      source.iteration_id === iterationId ? { ...source, status: 'archived' } : source
    ));
  }
  return nextCurrentSpec;
}

function assertArchivedBaselineForOpen(currentSpec, artifactRoot, iterationId) {
  if (currentSpec.pending_iteration) {
    throw new ValidationError('open requires no pending_iteration; finish or discard the active planning iteration first');
  }

  const metadata = loadOptionalIterationMetadata(artifactRoot, iterationId);
  if (metadata?.status !== 'archived') {
    throw new ValidationError(`open requires active iteration ${JSON.stringify(iterationId)} to be archived by \`p2a iteration close\``);
  }

  const closedIterations = currentSpec.closed_iterations ?? [];
  if (!Array.isArray(closedIterations)) {
    throw new ValidationError('open requires current-spec.json closed_iterations to be an array');
  }
  const closedRecord = closedIterations.find((closed) => closed?.iteration_id === iterationId);
  if (!closedRecord) {
    throw new ValidationError(`open requires active iteration ${JSON.stringify(iterationId)} to be recorded in current-spec.json.closed_iterations`);
  }
  if (closedRecord.status && closedRecord.status !== 'archived') {
    throw new ValidationError(`open requires closed iteration ${JSON.stringify(iterationId)} status archived`);
  }
  if (currentSpec.last_closed_iteration?.iteration_id !== iterationId) {
    throw new ValidationError(`open requires active iteration ${JSON.stringify(iterationId)} to be current-spec.json.last_closed_iteration`);
  }

  if (closedIterations.length > 1 && currentSpec.effective_spec_ref !== 'current-spec.json') {
    throw new ValidationError('open requires current-spec.json composition after multiple closed iterations; run `p2a iteration compose` first');
  }
  validateCurrentSpecCompositionData(currentSpec, artifactRoot, { requireNoOpenDecisions: true });
  if (currentSpec.effective_spec_ref === 'current-spec.json') {
    const composedIterationIds = new Set(currentSpec.composed_from ?? []);
    const missingClosedIterations = closedIterations
      .map((closed) => closed?.iteration_id)
      .filter((closedIterationId) => (
        typeof closedIterationId === 'string'
        && closedIterationId
        && !composedIterationIds.has(closedIterationId)
      ));
    if (missingClosedIterations.length) {
      throw new ValidationError(
        `open requires every closed iteration in the current composition; missing ${JSON.stringify(missingClosedIterations)}. Run \`p2a iteration compose\` first`,
      );
    }
  }
}

function maintenanceReadme() {
  return `# maintenance\n\n` +
    `작은 fix, 문서 수정, 패치성 변경을 append하는 상시 반복입니다.\n\n` +
    `task graph는 첫 fix가 생길 때 \`gate-c-task-graph/task-graph.json\`으로 생성합니다. ` +
    `빈 task graph는 \`.plan2agent/schemas/task-graph.schema.json\`의 \`tasks\` 최소 1개 제약을 위반하므로 만들지 않습니다.\n`;
}

function iterationReadme(iterationId, idea, previousIterationId, effectiveSpecRef) {
  return `# ${iterationId}\n\n` +
    `Status: active_planning\n\n` +
    `Baseline iteration: ${previousIterationId}\n\n` +
    `Baseline effective spec: ${effectiveSpecRef}\n\n` +
    `Change idea:\n\n${idea}\n\n` +
    `Expected canonical artifacts:\n\n` +
    `- gate-a-intake/intake.json\n` +
    `- gate-b-spec/spec.json\n` +
    `- gate-c-task-graph/task-graph.json\n\n` +
    `Optional generated views/exports:\n\n` +
    `- gate-a-intake/intake.md (explicit Markdown export only)\n` +
    `- gate-b-spec/product-spec.md\n` +
    `- gate-b-spec/implementation-plan.md\n`;
}

function gateReadme(gateLabel, iterationId) {
  return `# ${gateLabel}\n\n` +
    `이 디렉터리는 ${iterationId} 반복의 ${gateLabel} 산출물을 작성하는 위치입니다.\n`;
}

const CANONICAL_ITERATION_ARTIFACTS = [
  'gate-a-intake/intake.json',
  'gate-b-spec/spec.json',
  'gate-c-task-graph/task-graph.json',
];

const OPTIONAL_ITERATION_ARTIFACTS = [
  'gate-a-intake/intake.md',
  'gate-b-spec/product-spec.md',
  'gate-b-spec/implementation-plan.md',
];

function withCurrentIterationArtifactManifest(metadata) {
  const previousExpected = Array.isArray(metadata?.expected_artifacts)
    ? metadata.expected_artifacts.filter((item) => (
        typeof item === 'string'
        && !OPTIONAL_ITERATION_ARTIFACTS.includes(item)
      ))
    : [];
  const requiredArtifacts = [...CANONICAL_ITERATION_ARTIFACTS];
  const effectiveSpecRef = metadata?.baseline?.effective_spec_ref;
  if (isComposedBaselineReference(effectiveSpecRef) && effectiveSpecRef !== 'current-spec.json') {
    requiredArtifacts.unshift('baseline/current-spec.json');
  }
  const previousOptional = Array.isArray(metadata?.optional_artifacts)
    ? metadata.optional_artifacts.filter((item) => typeof item === 'string')
    : [];
  return {
    ...metadata,
    expected_artifacts: [...new Set([...requiredArtifacts, ...previousExpected])],
    optional_artifacts: [...new Set([...OPTIONAL_ITERATION_ARTIFACTS, ...previousOptional])],
  };
}

function iterationMetadata(
  projectId,
  iterationId,
  previousIterationId,
  idea,
  openedAt,
  effectiveSpecRef,
  effectiveSpecSha256,
  planningMemory = null,
) {
  return withCurrentIterationArtifactManifest({
    schema_version: 'p2a.iteration_metadata.v1',
    project_id: projectId,
    iteration_id: iterationId,
    status: 'active_planning',
    opened_at: openedAt,
    idea,
    baseline: {
      iteration_id: previousIterationId,
      current_spec_ref: 'current-spec.json',
      effective_spec_ref: effectiveSpecRef,
      ...(effectiveSpecSha256
        ? { effective_spec_sha256: effectiveSpecSha256 }
        : {}),
    },
    planning_memory: planningMemory,
  });
}

function draftArtifactPaths(iterationRoot) {
  return {
    intakeJson: path.join(iterationRoot, 'gate-a-intake', 'intake.json'),
    intakeMd: path.join(iterationRoot, 'gate-a-intake', 'intake.md'),
    productSpecMd: path.join(iterationRoot, 'gate-b-spec', 'product-spec.md'),
    implementationPlanMd: path.join(iterationRoot, 'gate-b-spec', 'implementation-plan.md'),
    specJson: path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
  };
}

function loadIterationMetadata(iterationRoot) {
  const metadataPath = path.join(iterationRoot, 'iteration.json');
  assertFile(metadataPath, 'iteration.json');
  return loadJson(metadataPath);
}

function activePendingIteration(state) {
  const pending = state.currentSpec.pending_iteration;
  if (!pending || typeof pending !== 'object') {
    throw new Error('draft requires a planning iteration opened by `p2a iteration open`; current-spec.json.pending_iteration is missing');
  }
  if (pending.iteration_id !== state.activeIteration) {
    throw new Error(`current-spec.json.pending_iteration.iteration_id must match active_iteration ${JSON.stringify(state.activeIteration)}`);
  }
  return pending;
}

function assertWritableDraftFiles(files, artifactRoot, force, options = {}) {
  const allowExisting = new Set(options.allowExisting ?? []);
  const fileStats = assertWritableDraftFilePaths(files, artifactRoot);
  const existing = Object.entries(files)
    .filter(([key]) => !allowExisting.has(key) && fileStats.get(key))
    .map(([, filePath]) => filePath);
  if (existing.length && !force) {
    const summary = existing.map((filePath) => artifactRelativePath(artifactRoot, filePath)).join(', ');
    throw new Error(`Gate A/B draft files already exist: ${summary}. Re-run with --force to overwrite them.`);
  }
}

function assertWritableDraftFilePaths(files, artifactRoot) {
  const labels = {
    intakeJson: 'Gate A intake JSON snapshot',
    intakeMd: 'Gate A intake Markdown export',
  };
  const fileStats = new Map();
  for (const [key, filePath] of Object.entries(files)) {
    fileStats.set(
      key,
      assertWritableArtifactFilePath(
        filePath,
        artifactRoot,
        labels[key] ?? 'Gate A/B draft artifact',
      ),
    );
  }
  return fileStats;
}

function assertWritableArtifactFilePath(filePath, artifactRoot, label) {
  const rootPath = path.resolve(artifactRoot);
  const targetPath = path.resolve(filePath);
  const relativePath = path.relative(rootPath, targetPath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new ValidationError(`${label} must resolve inside the artifact root`);
  }

  let currentPath = rootPath;
  for (const segment of relativePath.split(path.sep).slice(0, -1)) {
    currentPath = path.join(currentPath, segment);
    const stat = lstatIfPresent(currentPath);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new ValidationError(`${label} parent directory must not be a symbolic link: ${currentPath}`);
    }
    if (!stat.isDirectory()) {
      throw new ValidationError(`${label} parent must be a directory: ${currentPath}`);
    }
  }

  const targetStat = lstatIfPresent(targetPath);
  if (targetStat && !targetStat.isFile()) {
    throw new ValidationError(`${label} must be a regular file: ${targetPath}`);
  }
  if (targetStat) assertFileInsideArtifactRoot(targetPath, artifactRoot, label);
  return targetStat;
}

function draftIdea(args, pending, metadata) {
  const idea = args.idea ?? pending.idea ?? metadata.idea;
  if (!idea || idea.trim().length === 0) {
    throw new Error('draft requires --idea or an idea stored by `p2a iteration open`');
  }
  return idea.trim();
}

function baselineSourceSpecPaths(baselineSpecPath, artifactRoot) {
  const baseline = loadJson(baselineSpecPath);
  if (baseline.schema_version === 'p2a.spec.v1') return [baselineSpecPath];
  return (baseline.source_specs ?? [])
    .map((source) => resolveArtifactFileReference(source.spec_ref, artifactRoot))
    .filter((filePath) => filePath && existsSync(filePath));
}

function sourceIntakePath(specPath, sourceIntake, artifactRoot) {
  if (!sourceIntake || typeof sourceIntake !== 'string') return null;
  let projectRelativePath = null;
  if (
    sourceIntake.startsWith('.plan2agent/')
    || sourceIntake.startsWith(`.plan2agent${path.sep}`)
  ) {
    let current = path.dirname(specPath);
    while (true) {
      const p2aDir = path.join(current, '.plan2agent');
      if (existsSync(p2aDir) && lstatSync(p2aDir).isDirectory()) {
        projectRelativePath = path.resolve(current, sourceIntake);
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const candidates = path.isAbsolute(sourceIntake)
    ? [sourceIntake]
    : [
        path.resolve(path.dirname(specPath), sourceIntake),
        path.resolve(artifactRoot, sourceIntake),
        projectRelativePath,
        path.resolve(ROOT, sourceIntake),
      ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
}

function dispositionResolution(disposition) {
  return disposition.resolved_by
    ?? disposition.assumption
    ?? disposition.non_goal
    ?? disposition.resolution
    ?? disposition.rationale;
}

function loadBaselineContext(baselineSpecPath, artifactRoot, baselineSpecRef) {
  const reusedAnswers = [];
  const reusedQuestionDispositions = [];
  for (const specPath of baselineSourceSpecPaths(baselineSpecPath, artifactRoot)) {
    const spec = validateSpec(specPath, null, { artifactRoot });
    const specRef = artifactRelativePath(artifactRoot, specPath);
    const intakePath = sourceIntakePath(specPath, spec.source_intake, artifactRoot);
    if (intakePath) {
      const intake = validateIntake(intakePath, { artifactRoot });
      const intakeRef = artifactRelativePath(artifactRoot, intakePath);
      for (const decision of intake.needs_user_decision ?? []) {
        if (decision.status !== 'answered' || !decision.answer) continue;
        reusedAnswers.push({
          id: decision.id,
          question: decision.question,
          answer: decision.answer,
          source_intake: intakeRef,
        });
      }
    }
    for (const disposition of spec.clarifying_question_disposition ?? []) {
      reusedQuestionDispositions.push({
        id: disposition.id,
        status: disposition.status,
        resolution: dispositionResolution(disposition),
        affects: disposition.affects,
        source_spec: specRef,
      });
    }
  }
  return {
    spec_ref: baselineSpecRef,
    spec_sha256: fileSha256(baselineSpecPath),
    reused_answers: reusedAnswers,
    reused_question_dispositions: reusedQuestionDispositions,
  };
}

function buildDeltaIntake({
  projectId,
  iterationId,
  idea,
  baselineIteration,
  baselineSpecRef,
  baselineSpec,
  baselineContext,
}) {
  return {
    schema_version: 'p2a.intake.v1',
    idea,
    summary: `${projectId}의 현재 baseline spec 위에 다음 변경을 반복 기획한다: ${idea}`,
    known_facts: [
      `Project id: ${projectId}`,
      `Active iteration: ${iterationId}`,
      `Baseline iteration: ${baselineIteration}`,
      `Baseline effective spec: ${baselineSpecRef}`,
      `Change idea: ${idea}`,
    ],
    assumptions: [
      {
        id: 'A-1',
        statement: '기존 승인 spec의 목표, 제약, 인터페이스는 변경 아이디어에 필요한 범위만 수정하고 나머지는 유지한다.',
        risk: 'medium',
        confirmation_needed: false,
      },
      {
        id: 'A-2',
        statement: '이번 단계는 승인할 변경 범위를 기록한 뒤 Gate B 초안을 생성한다.',
        risk: 'low',
        confirmation_needed: false,
      },
    ],
    clarifying_questions: [
      {
        id: 'CQ-1',
        question: 'What observable outcome and verification would make this delta successful?',
        why_it_matters: 'The answer defines the expected outcome and delta-specific success criteria without repeating the baseline.',
        blocks: ['spec.product.success_criteria', 'spec.implementation.verification'],
        status: 'open',
      },
      {
        id: 'CQ-2',
        question: 'What is the smallest scope required now, and which adjacent changes are explicitly out of scope?',
        why_it_matters: 'The answer bounds the delta while preserving baseline goals and non-goals that are not being changed.',
        blocks: ['spec.product.goals', 'spec.product.non_goals', 'spec.product.core_flows'],
        status: 'open',
      },
      {
        id: 'CQ-3',
        question: 'Which baseline users, constraints, integrations, interfaces, or compatibility requirements does this delta change? If none, answer that the baseline remains unchanged.',
        why_it_matters: 'The answer reuses approved baseline decisions by default and asks only for explicit delta overrides.',
        blocks: [
          'spec.product.target_users',
          'spec.product.constraints',
          'spec.product.external_integrations',
          'spec.implementation.interfaces',
          'spec.implementation.edge_cases',
        ],
        status: 'open',
      },
    ],
    needs_user_decision: [],
    baseline_context: baselineContext,
    status: 'blocked_on_user',
    evidence: [
      {
        source_id: 'LOCAL-1',
        title: 'current-spec.json baseline pointer',
        url: 'current-spec.json',
        used_for: `Resolved active iteration ${iterationId} and baseline spec ${baselineSpecRef}.`,
      },
      {
        source_id: 'USER-1',
        title: 'Iteration change idea',
        url: '',
        used_for: `Captured requested delta: ${idea}`,
      },
    ],
  };
}

function buildGreenfieldRestartIntake(intake, idea, iterationId) {
  const hasReusableIntake = (
    intake
    && typeof intake === 'object'
    && typeof intake.idea === 'string'
  );
  const ideaChanged = !hasReusableIntake || intake.idea.trim() !== idea;
  const priorIntakeContext = ideaChanged
    ? []
    : [
        ...(intake.clarifying_questions ?? []).map((question) => (
          `Prior Gate A question to reconsider after restart (${question.id}): ${question.question}`
        )),
        ...(intake.needs_user_decision ?? [])
          .filter((decision) => decision.status === 'answered' && decision.answer)
          .map((decision) => (
            `Prior Gate A answered decision to reconfirm after restart (${decision.id}): ${decision.question} — ${decision.answer}`
          )),
      ];
  const resetBase = ideaChanged
    ? {
        schema_version: 'p2a.intake.v1',
        idea,
        summary: `The user wants to explore a new greenfield product idea: ${idea}`,
        known_facts: [`The requested greenfield product idea is: ${idea}`],
        assumptions: [],
        evidence: [
          {
            source_id: 'USER-1',
            title: 'Replacement greenfield product idea',
            url: '',
            used_for: `Restarted Gate A scope confirmation from the replacement idea: ${idea}`,
          },
        ],
      }
    : cloneJson(intake);
  const next = {
    ...resetBase,
    idea,
    known_facts: appendUnique(resetBase.known_facts, priorIntakeContext),
    clarifying_questions: [
      {
        id: 'CQ-1',
        question: 'Who are the target users, and what core problem must the first iteration solve for them?',
        why_it_matters: 'The answer establishes the greenfield problem statement and target users before Gate B.',
        blocks: ['spec.product.problem', 'spec.product.target_users'],
        status: 'open',
      },
      {
        id: 'CQ-2',
        question: 'What is the smallest first-iteration scope, expected outcome, and explicit non-goal?',
        why_it_matters: 'The answer bounds goals, flows, exclusions, success criteria, and verification.',
        blocks: [
          'spec.product.goals',
          'spec.product.non_goals',
          'spec.product.core_flows',
          'spec.product.success_criteria',
          'spec.implementation.verification',
        ],
        status: 'open',
      },
      {
        id: 'CQ-3',
        question: 'Which constraints, risks, integrations, and compatibility requirements must the first iteration respect?',
        why_it_matters: 'The answer defines external and implementation boundaries before Gate B.',
        blocks: [
          'spec.product.constraints',
          'spec.product.external_integrations',
          'spec.implementation.interfaces',
          'spec.implementation.edge_cases',
        ],
        status: 'open',
      },
    ],
    needs_user_decision: [],
    status: 'blocked_on_user',
  };
  delete next.approval_audit;
  delete next.baseline_context;
  return next;
}

function initialReferenceReconnaissance(iterationId, idea) {
  return {
    triggers: [
      `Gate B ${iterationId} draft should record reusable local patterns, prior artifacts, Memory results, or primary-source technology references before approval when they affect implementation choices.`,
    ],
    candidates: [
      {
        candidate_id: 'REF-1',
        title: 'Gate A intake',
        source_id: 'LOCAL-1',
        source_type: 'local_artifact',
        summary: 'Canonical intake artifact for the current Gate B draft.',
        used_for: 'Kept product and implementation scope traceable to Gate A.',
        decision: 'context',
        rationale: 'The intake defines scope context but does not by itself select an implementation pattern.',
      },
      {
        candidate_id: 'REF-2',
        title: 'Iteration idea',
        source_id: 'USER-1',
        source_type: 'user_input',
        summary: idea,
        used_for: 'Scoped the current Gate B draft before task generation.',
        decision: 'context',
        rationale: 'The idea constrains the draft and should be supplemented with concrete reference candidates before approving material technology choices.',
      },
    ],
    selected_patterns: [],
    rejected_patterns: [],
    open_questions: [],
  };
}

function carriedReferenceReconnaissance(baselineSpec, iterationId) {
  const reconnaissance = baselineSpec.reference_reconnaissance;
  if (!reconnaissance || !Array.isArray(reconnaissance.candidates)) return null;
  const candidates = reconnaissance.candidates
    .filter((candidate) => typeof candidate?.source_id === 'string' && candidate.source_id.startsWith('WEB-'))
    .map((candidate) => ({
      ...candidate,
      used_for: `Carried forward for iteration ${iterationId}: ${candidate.used_for}`,
      rationale: `Baseline reference still applies unless this delta supersedes it. ${candidate.rationale}`,
    }));
  if (!candidates.length) return null;
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));
  return {
    triggers: [
      ...asStringArray(reconnaissance.triggers).map((trigger) => `Carried forward baseline Gate B reference for ${iterationId}: ${trigger}`),
      `Review whether iteration ${iterationId} needs new local or Memory reference candidates before approval.`,
    ],
    candidates,
    selected_patterns: Array.isArray(reconnaissance.selected_patterns)
      ? reconnaissance.selected_patterns.filter((pattern) => candidateIds.has(pattern.candidate_id))
      : [],
    rejected_patterns: Array.isArray(reconnaissance.rejected_patterns)
      ? reconnaissance.rejected_patterns.filter((pattern) => candidateIds.has(pattern.candidate_id))
      : [],
    open_questions: [],
  };
}

function intakeQuestionDisposition(question, fallbackRationale) {
  const common = {
    id: question.id,
    rationale: question.answer
      ? `Gate A recorded this handling before Gate B synthesis: ${question.answer}`
      : fallbackRationale,
    affects: question.blocks,
  };
  if (question.status === 'answered') {
    return {
      ...common,
      status: 'answered',
      resolved_by: question.answer,
    };
  }
  if (question.status === 'not_applicable') {
    return {
      ...common,
      status: 'deferred_non_goal',
      non_goal: question.answer,
    };
  }
  return {
    ...common,
    status: 'assumed',
    assumption: question.answer ?? question.question,
  };
}

function intakeQuestionDispositions(intake, fallbackRationale) {
  return (intake.clarifying_questions ?? [])
    .map((question) => intakeQuestionDisposition(question, fallbackRationale));
}

function unresolvedIntakeDecisionIds(intake) {
  return (intake.needs_user_decision ?? [])
    .filter((decision) => decision.status !== 'answered')
    .map((decision) => decision.id);
}

function appendSpecContribution(spec, fieldRef, value) {
  const match = /^spec\.(product|implementation)\.([a-z_]+)$/.exec(fieldRef);
  if (!match || !value) return;
  const [, section, field] = match;
  const current = spec[section]?.[field];
  if (Array.isArray(current)) {
    spec[section][field] = appendUnique(current, [value]);
    return;
  }
  if (section === 'product' && field === 'problem' && typeof current === 'string' && !current.includes(value)) {
    spec.product.problem = `${current}\n\n${value}`;
  }
}

function applyConfirmedIntakeToSpec(spec, intake) {
  const next = cloneJson(spec);
  for (const question of intake.clarifying_questions ?? []) {
    if (!question.answer || !['answered', 'assumed', 'not_applicable'].includes(question.status)) continue;
    const contribution = `Gate A ${question.id} (${question.status}): ${question.answer}`;
    const refs = question.status === 'not_applicable'
      ? ['spec.product.non_goals']
      : question.blocks;
    for (const fieldRef of refs) appendSpecContribution(next, fieldRef, contribution);
  }
  for (const decision of intake.needs_user_decision ?? []) {
    if (decision.status !== 'answered' || !decision.answer) continue;
    const contribution = `Gate A ${decision.id} decision: ${decision.question} — ${decision.answer}`;
    for (const fieldRef of decision.blocks ?? []) {
      appendSpecContribution(next, fieldRef, contribution);
    }
  }
  return next;
}

function inferredVisualExperience(idea, intake) {
  const signals = JSON.stringify({
    idea,
    summary: intake.summary,
    known_facts: intake.known_facts,
    answers: [
      ...(intake.clarifying_questions ?? []).map((item) => item.answer),
      ...(intake.needs_user_decision ?? []).map((item) => item.answer),
    ],
  });
  const hasVisualInterface = /\b(?:ui|ux|front[ -]?end|web[ -]?app|mobile[ -]?app|dashboard|screen|page|visual interface)\b|화면|프론트엔드|웹앱|모바일 앱|대시보드|페이지/i.test(signals);
  return hasVisualInterface
    ? {
        has_visual_interface: true,
        design_scope: 'minimal',
        design_timing: 'current_iteration',
        rationale: 'The deterministic draft detected a visual-interface signal and defaults to function-first minimal UI; Gate B may explicitly select reuse, full, or deferral.',
      }
    : {
        has_visual_interface: false,
        design_scope: 'none',
        design_timing: 'not_applicable',
        rationale: 'The deterministic draft found no explicit visual-interface signal; Gate B must change this classification if the iteration adds a rendered screen.',
      };
}

function buildDeltaSpec({ projectId, iterationId, idea, baselineSpec, baselineSpecRef, intake }) {
  const product = baselineSpec.product;
  const implementation = baselineSpec.implementation;
  const baselineWebEvidence = Array.isArray(baselineSpec.evidence)
    ? baselineSpec.evidence
        .filter((item) => typeof item?.source_id === 'string' && item.source_id.startsWith('WEB-'))
        .map((item) => ({
          ...item,
          used_for: `Carried forward from baseline Gate B Technology Reconnaissance for iteration ${iterationId}: ${item.used_for}`,
        }))
    : [];
  const spec = {
    schema_version: 'p2a.spec.v1',
    project_id: projectId,
    source_intake: '../gate-a-intake/intake.json',
    product: cloneJson(product),
    implementation: cloneJson(implementation),
    visual_experience: inferredVisualExperience(idea, intake),
    clarifying_question_disposition: intakeQuestionDispositions(
      intake,
      'The confirmed Gate A delta intake carries this question into Gate B as an explicit assumption.',
    ),
    open_decisions: unresolvedIntakeDecisionIds(intake),
    approval: 'draft',
    evidence: [
      {
        source_id: 'LOCAL-1',
        title: 'Baseline effective spec',
        url: baselineSpecRef,
        used_for: `Used as the baseline for iteration ${iterationId}.`,
      },
      {
        source_id: 'USER-1',
        title: 'Iteration change idea',
        url: '',
        used_for: `Scoped the delta spec: ${idea}`,
      },
      ...baselineWebEvidence,
    ],
    reference_reconnaissance: carriedReferenceReconnaissance(baselineSpec, iterationId) ?? initialReferenceReconnaissance(iterationId, idea),
  };
  return applyConfirmedIntakeToSpec(spec, intake);
}

function buildInitialSpec({ projectId, iterationId, idea, intake }) {
  const { product, implementation } = buildInitialCanonicalSections({
    iterationId,
    idea,
    intake,
  });
  const spec = {
    schema_version: 'p2a.spec.v1',
    project_id: projectId,
    source_intake: '../gate-a-intake/intake.json',
    product,
    implementation,
    visual_experience: inferredVisualExperience(idea, intake),
    clarifying_question_disposition: intakeQuestionDispositions(
      intake,
      'Initial Gate B draft keeps this question as an explicit implementation assumption unless the user overrides it before approval.',
    ),
    open_decisions: unresolvedIntakeDecisionIds(intake),
    approval: 'draft',
    evidence: [
      {
        source_id: 'LOCAL-1',
        title: 'Gate A intake',
        url: '../gate-a-intake/intake.json',
        used_for: `Generated initial Gate B draft for ${iterationId}.`,
      },
      {
        source_id: 'USER-1',
        title: 'Initial product idea',
        url: '',
        used_for: idea,
      },
    ],
    reference_reconnaissance: initialReferenceReconnaissance(iterationId, idea),
  };
  return applyConfirmedIntakeToSpec(spec, intake);
}

function featureRadarSummary(preflight) {
  const runRefs = (preflight.runs ?? []).map((run) => run.ref).filter(Boolean);
  const parts = [
    `${runRefs.length} run(s)`,
    `${preflight.recommendations?.length ?? 0} recommendation(s)`,
    `${preflight.webSources?.length ?? 0} web source(s)`,
  ];
  return `${parts.join(', ')}${runRefs.length ? `: ${runRefs.join(', ')}` : ''}`;
}

function nextAssumptionId(assumptions) {
  const highest = (assumptions ?? []).reduce((max, assumption) => {
    const match = typeof assumption?.id === 'string' ? assumption.id.match(/^A-([0-9]+)$/) : null;
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
  }, 0);
  return `A-${highest + 1}`;
}

function mergeFeatureRadarIntoIntake(intake, preflight) {
  if (!preflight.detected) return intake;
  const evidenceMap = buildFeatureRadarEvidence(preflight, intake.evidence, { includeWeb: false });
  return {
    ...intake,
    known_facts: appendUnique(intake.known_facts, [
      `Feature Radar preflight research detected and attached for Gate A/B review: ${featureRadarSummary(preflight)}`,
    ]),
    assumptions: [
      ...intake.assumptions,
      {
        id: nextAssumptionId(intake.assumptions),
        statement: 'Feature Radar recommendations are preflight candidates, not approved scope, until Gate B explicitly marks them selected, deferred, or rejected.',
        risk: 'medium',
        confirmation_needed: false,
      },
    ],
    evidence: [
      ...intake.evidence,
      ...evidenceMap.evidence,
    ],
  };
}

function mergeFeatureRadarIntoSpec(spec, preflight) {
  if (!preflight.detected) return spec;
  const evidenceMap = buildFeatureRadarEvidence(preflight, spec.evidence, { includeWeb: true });
  const reconnaissance = spec.reference_reconnaissance ?? {
    triggers: [],
    candidates: [],
    selected_patterns: [],
    rejected_patterns: [],
    open_questions: [],
  };
  const radarCandidates = buildFeatureRadarReferenceCandidates(
    preflight,
    evidenceMap,
    reconnaissance.candidates,
  );
  return {
    ...spec,
    evidence: [
      ...spec.evidence,
      ...evidenceMap.evidence,
    ],
    reference_reconnaissance: {
      ...reconnaissance,
      triggers: appendUnique(reconnaissance.triggers, [
        `Feature Radar preflight research was detected for this artifact root: ${featureRadarSummary(preflight)}`,
      ]),
      candidates: [
        ...(Array.isArray(reconnaissance.candidates) ? reconnaissance.candidates : []),
        ...radarCandidates,
      ],
      selected_patterns: Array.isArray(reconnaissance.selected_patterns) ? reconnaissance.selected_patterns : [],
      rejected_patterns: Array.isArray(reconnaissance.rejected_patterns) ? reconnaissance.rejected_patterns : [],
      open_questions: Array.isArray(reconnaissance.open_questions) ? reconnaissance.open_questions : [],
    },
  };
}

export const EXPLICIT_INTAKE_MARKDOWN_MARKER = '<!-- plan2agent:intake-md-export=explicit -->';

function renderIntakeDecisionMarkdown(item) {
  const options = Array.isArray(item.options) ? item.options : [];
  const recommendedOption = options.find((option) => option?.id === item.default);
  const optionLines = options.length
    ? options.map((option) => (
        `  - ${option.id} — ${option.label}: ${option.description}`
      )).join('\n')
    : '  - None recorded.';
  const recommendation = recommendedOption
    ? `${recommendedOption.id} — ${recommendedOption.label}: ${recommendedOption.description}`
    : item.default ?? 'none';
  return `### ${item.id} — ${item.question}\n\n` +
    `- status: ${item.status}\n` +
    `${item.answer ? `- answer: ${item.answer}\n` : ''}` +
    `- impact: ${item.impact ?? 'Not recorded.'}\n` +
    `- options:\n${optionLines}\n` +
    `- recommended: ${recommendation}\n` +
    `- potential blocks: ${(item.blocks ?? []).join(', ') || 'legacy/unspecified'}`;
}

function renderIntakeClarifyingQuestionMarkdown(item) {
  return `### ${item.id} — ${item.question}\n\n` +
    `- status: ${item.status ?? 'unspecified'}\n` +
    `${item.answer ? `- answer: ${item.answer}\n` : ''}` +
    `- why it matters: ${item.why_it_matters}\n` +
    `- potential blocks: ${(item.blocks ?? []).join(', ') || 'none'}`;
}

export function renderIntakeMarkdown(intake, options = {}) {
  const decisions = intake.needs_user_decision.length
    ? intake.needs_user_decision.map(renderIntakeDecisionMarkdown).join('\n\n')
    : 'No formal user decisions in the current intake.';
  const questions = intake.clarifying_questions.length
    ? intake.clarifying_questions.map(renderIntakeClarifyingQuestionMarkdown).join('\n\n')
    : 'No clarifying questions in the current intake.';
  const baseline = intake.baseline_context
    ? `## Reused Baseline Context\n\n` +
      `### Reused Answers\n\n` +
      `${intake.baseline_context.reused_answers.length
        ? markdownList(intake.baseline_context.reused_answers.map((item) => (
            `${item.id}: ${item.answer} (from ${item.source_intake})`
          )))
        : 'No reusable answered decisions were found.'}\n\n` +
      `### Reused Question Dispositions\n\n` +
      `${intake.baseline_context.reused_question_dispositions.length
        ? markdownList(intake.baseline_context.reused_question_dispositions.map((item) => (
            `${item.id}: ${item.status} — ${item.resolution} (from ${item.source_spec})`
          )))
        : 'No reusable clarifying-question dispositions were found.'}\n\n`
    : '';
  const provenance = options.explicitExport
    ? `${EXPLICIT_INTAKE_MARKDOWN_MARKER}\n\n`
    : '';
  return provenance + `# Intake\n\n` +
    `## Idea\n\n${intake.idea}\n\n` +
    `## Summary\n\n${intake.summary}\n\n` +
    `## Known Facts\n\n${markdownList(intake.known_facts)}\n\n` +
    `## Assumptions\n\n${markdownList(intake.assumptions.map((item) => (
      `${item.id}: ${item.statement} ` +
      `(risk: ${item.risk}; confirmation_needed: ${item.confirmation_needed})`
    )))}\n\n` +
    baseline +
    `## Decisions\n\n${decisions}\n\n` +
    `## Clarifying Questions\n\n${questions}\n`;
}

function deltaChangeMarkdown(spec, baselineSpec, section) {
  const changes = collectDetailedSpecChanges(baselineSpec, spec)
    .filter((change) => change.section === section);
  if (!changes.length) return '- No changes from the approved baseline.';
  return markdownList(changeSummaryLines({ changes }));
}

function visualExperienceMarkdown(spec) {
  const visual = spec.visual_experience;
  if (!visual) return '- Not classified (legacy spec).';
  return [
    `- Visual interface: ${visual.has_visual_interface ? 'yes' : 'no'}`,
    `- Scope: ${visual.design_scope}`,
    `- Timing: ${visual.design_timing}`,
    `- Rationale: ${visual.rationale}`,
    ...(visual.experience_spec_ref ? [`- Experience spec: ${visual.experience_spec_ref}`] : []),
    ...(visual.design_system_refs?.length ? [`- Design system: ${visual.design_system_refs.join(', ')}`] : []),
  ].join('\n');
}

function renderProductSpecMarkdown(spec, { iterationId, idea, baselineSpecRef, baselineSpec = null }) {
  if (baselineSpec) {
    return `# Product Spec\n\n` +
      `Project: ${spec.project_id}\n\n` +
      `Iteration: ${iterationId}\n\n` +
      `Baseline: ${baselineSpecRef}\n\n` +
      `Approval: ${spec.approval}\n\n` +
      `## Delta\n\n${idea}\n\n` +
      `## Changed Product Fields\n\n${deltaChangeMarkdown(spec, baselineSpec, 'product')}\n\n` +
      `## Visual Experience\n\n${visualExperienceMarkdown(spec)}\n\n` +
      `## Baseline-Preserved Fields\n\n` +
      `Unchanged baseline values are intentionally omitted from this review view. ` +
      `The complete backward-compatible specification remains in \`spec.json\`.\n`;
  }
  return `# Product Spec\n\n` +
    `Project: ${spec.project_id}\n\n` +
    `Iteration: ${iterationId}\n\n` +
    `Baseline: ${baselineSpecRef}\n\n` +
    `Approval: ${spec.approval}\n\n` +
    `## Delta\n\n${idea}\n\n` +
    `## Problem\n\n${spec.product.problem}\n\n` +
    `## Target Users\n\n${markdownList(spec.product.target_users)}\n\n` +
    `## Goals\n\n${markdownList(spec.product.goals)}\n\n` +
    `## Non-Goals\n\n${markdownList(spec.product.non_goals)}\n\n` +
    `## Core Flows\n\n${markdownList(spec.product.core_flows)}\n\n` +
    `## Interfaces\n\n${markdownList(spec.product.screens_or_interfaces)}\n\n` +
    `## Visual Experience\n\n${visualExperienceMarkdown(spec)}\n\n` +
    `## Success Criteria\n\n${markdownList(spec.product.success_criteria)}\n`;
}

function renderImplementationPlanMarkdown(spec, {
  iterationId,
  idea,
  baselineSpecRef,
  baselineSpec = null,
}) {
  if (baselineSpec) {
    return `# Implementation Plan\n\n` +
      `Project: ${spec.project_id}\n\n` +
      `Iteration: ${iterationId}\n\n` +
      `Baseline: ${baselineSpecRef}\n\n` +
      `Approval: ${spec.approval}\n\n` +
      `## Delta\n\n${idea}\n\n` +
      `## Changed Implementation Fields\n\n${deltaChangeMarkdown(spec, baselineSpec, 'implementation')}\n\n` +
      `## Baseline-Preserved Fields\n\n` +
      `Unchanged baseline values are intentionally omitted from this review view. ` +
      `The complete backward-compatible specification remains in \`spec.json\`.\n`;
  }
  return `# Implementation Plan\n\n` +
    `Project: ${spec.project_id}\n\n` +
    `Iteration: ${iterationId}\n\n` +
    `Baseline: ${baselineSpecRef}\n\n` +
    `Approval: ${spec.approval}\n\n` +
    `## Delta\n\n${idea}\n\n` +
    `## Architecture\n\n${markdownList(spec.implementation.architecture)}\n\n` +
    `## Interfaces\n\n${markdownList(spec.implementation.interfaces)}\n\n` +
    `## Data Flow\n\n${markdownList(spec.implementation.data_flow)}\n\n` +
    `## Dependencies\n\n${markdownList(spec.implementation.dependencies)}\n\n` +
    `## Edge Cases\n\n${markdownList(spec.implementation.edge_cases)}\n\n` +
    `## Verification\n\n${markdownList(spec.implementation.verification)}\n`;
}

function currentSpecForDraft(currentSpec, iterationId, idea, draftedAt, artifacts) {
  return {
    ...currentSpec,
    pending_iteration: {
      ...currentSpec.pending_iteration,
      iteration_id: iterationId,
      status: 'gate_b_draft',
      idea,
      drafted_at: draftedAt,
      artifacts,
    },
  };
}

function currentSpecForGateAScope(currentSpec, iterationId, idea, draftedAt, artifacts) {
  const pendingIteration = {
    ...currentSpec.pending_iteration,
  };
  delete pendingIteration.promoted_at;
  return {
    ...currentSpec,
    pending_iteration: {
      ...pendingIteration,
      iteration_id: iterationId,
      status: 'active_planning',
      idea,
      drafted_at: draftedAt,
      artifacts: {
        intake_ref: artifacts.intake_ref,
      },
    },
  };
}

function currentSpecWithoutIterationApprovalAudits(currentSpec, iterationId) {
  const next = cloneJson(currentSpec);
  for (const field of ['gate_b_approval_audits']) {
    if (!next[field] || typeof next[field] !== 'object' || Array.isArray(next[field])) continue;
    delete next[field][iterationId];
    if (Object.keys(next[field]).length === 0) delete next[field];
  }
  return next;
}

function currentSpecAfterGateAForceReset(
  currentSpec,
  iterationId,
  effectiveSpecPath,
  activeSpecPath,
) {
  const next = currentSpecWithoutIterationApprovalAudits(currentSpec, iterationId);
  if (
    next.effective_spec_ref
    && path.resolve(effectiveSpecPath) === path.resolve(activeSpecPath)
  ) {
    next.effective_spec_ref = null;
    next.composed_from = asStringArray(next.composed_from)
      .filter((sourceIterationId) => sourceIterationId !== iterationId);
    if (next.composed_from.length === 0) {
      for (const field of [
        'effective_product',
        'effective_implementation',
        'source_specs',
        'product_sources',
        'implementation_sources',
        'open_decisions',
        'composed_at',
      ]) {
        delete next[field];
      }
    }
  }
  delete next.gate_b_promoted_at;
  if (next.pending_iteration?.iteration_id === iterationId) {
    delete next.pending_iteration.promoted_at;
  }
  return next;
}

function currentSpecForPromotedSpec(currentSpec, iterationId, promotedAt, artifacts, gateBApprovalAudit) {
  let next = {
    ...currentSpec,
    active_iteration: iterationId,
    gate_b_promoted_at: promotedAt,
  };
  const activeSpecRef = sourceSpecRef(iterationId);
  const hasNoEffectiveSpec = !currentSpec.effective_spec_ref;

  if (hasNoEffectiveSpec) {
    next.composed_from = appendUnique(currentSpec.composed_from, [iterationId]);
    next.effective_spec_ref = activeSpecRef;
  } else if (currentSpec.effective_spec_ref === activeSpecRef) {
    next.effective_spec_ref = activeSpecRef;
  }
  if (next.pending_iteration?.iteration_id === iterationId) {
    next.pending_iteration = {
      ...next.pending_iteration,
      status: 'gate_b_approved',
      promoted_at: promotedAt,
      artifacts: {
        ...next.pending_iteration.artifacts,
        ...artifacts,
      },
    };
  }
  if (gateBApprovalAudit) {
    next = currentSpecWithGateBApprovalAudit(next, iterationId, gateBApprovalAudit);
  }
  return next;
}

function iterationMetadataForDraft(metadata, idea, draftedAt, artifacts, planningMemory = metadata.planning_memory ?? null) {
  const planningMetadata = withCurrentIterationArtifactManifest(metadata);
  return {
    ...planningMetadata,
    status: 'gate_b_draft',
    idea,
    drafted_at: draftedAt,
    draft_artifacts: artifacts,
    planning_memory: planningMemory,
  };
}

function iterationMetadataAfterGateAForceReset(metadata) {
  const {
    promoted_at: _promotedAt,
    approved_spec_artifacts: _approvedSpecArtifacts,
    ...planningMetadata
  } = metadata;
  return withCurrentIterationArtifactManifest(planningMetadata);
}

function iterationMetadataForGateAScope(
  metadata,
  idea,
  draftedAt,
  artifacts,
  planningMemory = metadata.planning_memory ?? null,
) {
  const planningMetadata = iterationMetadataAfterGateAForceReset(metadata);
  return {
    ...planningMetadata,
    status: 'active_planning',
    idea,
    drafted_at: draftedAt,
    draft_artifacts: {
      intake_ref: artifacts.intake_ref,
    },
    planning_memory: planningMemory,
  };
}

function iterationMetadataForPromotedSpec(metadata, projectId, iterationId, promotedAt, artifacts) {
  const planningMetadata = withCurrentIterationArtifactManifest(metadata ?? {
    schema_version: 'p2a.iteration_metadata.v1',
    project_id: projectId,
    iteration_id: iterationId,
  });
  return {
    ...planningMetadata,
    project_id: metadata?.project_id ?? projectId,
    iteration_id: metadata?.iteration_id ?? iterationId,
    status: 'gate_b_approved',
    promoted_at: promotedAt,
    approved_spec_artifacts: artifacts,
  };
}

function iterationMetadataForClose(metadata, projectId, iterationId, closedAt, record, memoryFreshness = null) {
  const planningMetadata = withCurrentIterationArtifactManifest(metadata ?? {
    schema_version: 'p2a.iteration_metadata.v1',
    project_id: projectId,
    iteration_id: iterationId,
  });
  return {
    ...planningMetadata,
    project_id: metadata?.project_id ?? projectId,
    iteration_id: metadata?.iteration_id ?? iterationId,
    status: 'archived',
    closed_at: closedAt,
    close: record,
    memory_freshness: memoryFreshness,
  };
}

function sourceSpecRef(iterationId) {
  return `iterations/${iterationId}/gate-b-spec/spec.json`;
}

function taskGraphRef(iterationId) {
  return `iterations/${iterationId}/gate-c-task-graph/task-graph.json`;
}

const SEMANTIC_AREAS = [
  {
    id: 'requirements',
    label: 'requirements and question disposition',
    fields: ['problem', 'target_users', 'goals', 'non_goals', 'success_criteria', 'constraints', 'clarifying_question_disposition'],
    keywords: ['requirement', 'decision', 'question', 'answer', 'assumption', 'scope', 'goal', 'success', 'constraint', 'non-goal'],
  },
  {
    id: 'security',
    label: 'security and authorization',
    fields: [],
    keywords: ['auth', 'authorization', 'authentication', 'permission', 'secret', 'signature', 'hmac', 'token', 'credential'],
  },
  {
    id: 'integration',
    label: 'external integration',
    fields: ['external_integrations'],
    keywords: ['integration', 'provider', 'external', 'third-party', 'oauth', 'webhook provider'],
  },
  {
    id: 'api',
    label: 'interface and API contract',
    fields: ['interfaces'],
    keywords: ['api', 'endpoint', 'http', 'request', 'response', 'contract', 'interface', 'header', 'webhook', 'cli', 'command'],
  },
  {
    id: 'ui',
    label: 'user-facing workflow and view',
    fields: ['screens_or_interfaces'],
    keywords: ['dashboard', 'screen', 'view', 'page', 'chart', 'report', 'table', 'form', 'ui'],
  },
  {
    id: 'data',
    label: 'data model and data flow',
    fields: ['data_model_draft', 'data_flow'],
    keywords: ['data', 'schema', 'model', 'event', 'payload', 'record', 'state', 'storage', 'database', 'db'],
  },
  {
    id: 'delivery',
    label: 'delivery workflow and reliability',
    fields: ['core_flows', 'edge_cases'],
    keywords: ['delivery', 'queue', 'retry', 'idempotency', 'dead-letter', 'background', 'worker', 'async', 'schedule'],
  },
  {
    id: 'architecture',
    label: 'architecture and dependencies',
    fields: ['architecture', 'dependencies'],
    keywords: ['architecture', 'dependency', 'dependencies', 'runtime', 'module', 'service', 'component'],
  },
  {
    id: 'verification',
    label: 'verification and regression coverage',
    fields: ['verification'],
    keywords: ['test', 'tests', 'verification', 'verify', 'coverage', 'lint', 'typecheck', 'acceptance', 'regression'],
  },
  {
    id: 'misc',
    label: 'supporting implementation detail',
    fields: [],
    keywords: [],
  },
];

const SEMANTIC_AREA_ORDER = SEMANTIC_AREAS.map((area) => area.id);

function semanticAreaById(areaId) {
  return SEMANTIC_AREAS.find((area) => area.id === areaId) ?? SEMANTIC_AREAS[SEMANTIC_AREAS.length - 1];
}

function fieldValueChanged(baselineSpec, activeSpec, section, field) {
  if (!baselineSpec) return true;
  return !jsonEqual(baselineSpec[section]?.[field], activeSpec[section]?.[field]);
}

function collectSpecFieldChanges(baselineSpec, activeSpec) {
  const changes = [];
  for (const field of PRODUCT_FIELDS) {
    if (fieldValueChanged(baselineSpec, activeSpec, 'product', field)) {
      changes.push({ section: 'product', field, specRef: `product.${field}` });
    }
  }
  for (const field of IMPLEMENTATION_FIELDS) {
    if (fieldValueChanged(baselineSpec, activeSpec, 'implementation', field)) {
      changes.push({ section: 'implementation', field, specRef: `implementation.${field}` });
    }
  }
  return changes;
}

function specValueText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function normalizeSpecValueItems(value) {
  if (Array.isArray(value)) {
    return value.map(specValueText).filter((item) => item.length > 0);
  }
  const text = specValueText(value);
  return text.length ? [text] : [];
}

function valueHasContent(value) {
  return normalizeSpecValueItems(value).length > 0;
}

function changedItemSet(baselineValue, activeValue) {
  const baselineItems = normalizeSpecValueItems(baselineValue);
  const activeItems = normalizeSpecValueItems(activeValue);
  const baselineSet = new Set(baselineItems);
  const activeSet = new Set(activeItems);
  return {
    added: activeItems.filter((item) => !baselineSet.has(item)),
    removed: baselineItems.filter((item) => !activeSet.has(item)),
  };
}

function changeTypeForValues(baselineValue, activeValue) {
  const baselineHasContent = valueHasContent(baselineValue);
  const activeHasContent = valueHasContent(activeValue);
  if (!baselineHasContent && activeHasContent) return 'added';
  if (baselineHasContent && !activeHasContent) return 'removed';
  return 'changed';
}

function summarizeValue(value, limit = 160) {
  const text = normalizeSpecValueItems(value).join('; ').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function detailedSpecChange(baselineSpec, activeSpec, section, field) {
  const baselineValue = baselineSpec?.[section]?.[field];
  const activeValue = activeSpec?.[section]?.[field];
  const { added, removed } = changedItemSet(baselineValue, activeValue);
  const specRef = section === 'spec' ? field : `${section}.${field}`;
  return {
    section,
    field,
    specRef,
    changeType: changeTypeForValues(baselineValue, activeValue),
    addedValues: added,
    removedValues: removed,
    activeSummary: summarizeValue(activeValue),
    baselineSummary: summarizeValue(baselineValue),
  };
}

function collectDetailedSpecChanges(baselineSpec, activeSpec) {
  const changes = [];
  for (const field of PRODUCT_FIELDS) {
    if (fieldValueChanged(baselineSpec, activeSpec, 'product', field)) {
      changes.push(detailedSpecChange(baselineSpec, activeSpec, 'product', field));
    }
  }
  for (const field of IMPLEMENTATION_FIELDS) {
    if (fieldValueChanged(baselineSpec, activeSpec, 'implementation', field)) {
      changes.push(detailedSpecChange(baselineSpec, activeSpec, 'implementation', field));
    }
  }
  const activeDisposition = activeSpec.clarifying_question_disposition ?? [];
  const baselineDisposition = baselineSpec?.clarifying_question_disposition ?? [];
  if ((activeDisposition.length || baselineDisposition.length) && !jsonEqual(baselineDisposition, activeDisposition)) {
    changes.push(detailedSpecChange(
      { spec: { clarifying_question_disposition: baselineDisposition } },
      { spec: { clarifying_question_disposition: activeDisposition } },
      'spec',
      'clarifying_question_disposition',
    ));
  }
  const activeVisualExperience = activeSpec.visual_experience ?? null;
  const baselineVisualExperience = baselineSpec?.visual_experience ?? null;
  const implementsCurrentVisualExperience = (
    activeVisualExperience?.has_visual_interface === true
    && ['reuse', 'full'].includes(activeVisualExperience.design_scope)
    && activeVisualExperience.design_timing === 'current_iteration'
  );
  if (
    implementsCurrentVisualExperience
    && !jsonEqual(baselineVisualExperience, activeVisualExperience)
  ) {
    changes.push(detailedSpecChange(
      { spec: { visual_experience: baselineVisualExperience } },
      { spec: { visual_experience: activeVisualExperience } },
      'spec',
      'visual_experience',
    ));
  }
  return changes;
}

function keywordHits(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword)).length;
}

function semanticAreaScore(area, change) {
  if (area.id === 'verification' && change.specRef === 'implementation.verification') return 100;
  if (area.id === 'requirements' && change.specRef === 'clarifying_question_disposition') return 100;
  if (area.id === 'ui' && change.specRef === 'visual_experience') return 100;
  const corpus = [
    change.section,
    change.field,
    change.specRef,
    change.activeSummary,
    change.baselineSummary,
    ...change.addedValues,
    ...change.removedValues,
  ].join(' ');
  let score = 0;
  if (area.fields.includes(change.field)) score += 4;
  score += keywordHits(corpus, area.keywords);
  return score;
}

function semanticAreaForChange(change) {
  let bestArea = semanticAreaById('misc');
  let bestScore = -1;
  for (const area of SEMANTIC_AREAS) {
    if (area.id === 'misc') continue;
    const score = semanticAreaScore(area, change);
    if (score > bestScore) {
      bestArea = area;
      bestScore = score;
    }
  }
  return bestScore > 0 ? bestArea : semanticAreaById('misc');
}

function normalizeRefs(refs) {
  return [...new Set((refs ?? []).filter((ref) => typeof ref === 'string' && ref.trim().length > 0))];
}

function refsOverlap(leftRefs, rightRefs) {
  const right = new Set(normalizeRefs(rightRefs));
  return normalizeRefs(leftRefs).some((ref) => right.has(ref));
}

function dispositionAffectsChangedRefs(disposition, changedRefs) {
  const affects = normalizeRefs(disposition?.affects);
  if (!affects.length) return false;
  return affects.some((ref) => (
    changedRefs.has(ref)
    || [...changedRefs].some((changedRef) => changedRef.startsWith(`${ref}.`) || ref.startsWith(`${changedRef}.`))
  ));
}

function questionDispositionReviewChange(activeSpec, changes) {
  const dispositions = Array.isArray(activeSpec.clarifying_question_disposition)
    ? activeSpec.clarifying_question_disposition
    : [];
  if (!dispositions.length) return null;
  const changedRefs = new Set(changes.map((change) => change.specRef));
  const impacted = dispositions.filter((disposition) => dispositionAffectsChangedRefs(disposition, changedRefs));
  if (!impacted.length) return null;
  const ids = impacted.map((disposition) => disposition.id).filter(Boolean).join(', ');
  return {
    section: 'spec',
    field: 'clarifying_question_disposition',
    specRef: 'clarifying_question_disposition',
    changeType: 'review',
    addedValues: [`Re-dispose or confirm user question answers affected by changed refs: ${ids}`],
    removedValues: [],
    activeSummary: ids,
    baselineSummary: '',
  };
}

function semanticGroupsFromChanges(activeSpec, detailedChanges) {
  const changes = [...detailedChanges];
  const dispositionReview = questionDispositionReviewChange(activeSpec, changes);
  if (dispositionReview && !changes.some((change) => change.specRef === 'clarifying_question_disposition')) {
    changes.push(dispositionReview);
  }
  if (!changes.length) {
    changes.push({
      section: 'implementation',
      field: 'verification',
      specRef: 'implementation.verification',
      changeType: 'unchanged',
      addedValues: ['Confirm the active spec has no semantic changes against the selected baseline.'],
      removedValues: [],
      activeSummary: '',
      baselineSummary: '',
    });
  }

  const groupsByArea = new Map();
  for (const change of changes) {
    const area = semanticAreaForChange(change);
    if (!groupsByArea.has(area.id)) {
      groupsByArea.set(area.id, {
        areaId: area.id,
        label: area.label,
        changes: [],
      });
    }
    groupsByArea.get(area.id).changes.push(change);
  }

  return [...groupsByArea.values()].sort((left, right) => (
    SEMANTIC_AREA_ORDER.indexOf(left.areaId) - SEMANTIC_AREA_ORDER.indexOf(right.areaId)
  ));
}

function taskIdNumber(task) {
  const match = typeof task?.id === 'string' ? task.id.match(/^task-([0-9]+)$/) : null;
  return match ? Number.parseInt(match[1], 10) : 0;
}

function formatTaskId(number) {
  return `task-${String(number).padStart(3, '0')}`;
}

function nextTaskIdAllocator(existingTasks) {
  let next = existingTasks.reduce((highest, task) => Math.max(highest, taskIdNumber(task)), 0) + 1;
  return () => formatTaskId(next++);
}

function groupSourceRefs(group) {
  return normalizeRefs(group.changes.map((change) => change.specRef));
}

function reusableTaskScore(group, task) {
  if (!task || task.status === 'done') return 0;
  const groupRefs = groupSourceRefs(group);
  const taskRefs = normalizeRefs(task.sourceSpecRefs);
  let score = 0;
  for (const ref of groupRefs) {
    if (taskRefs.includes(ref)) score += 4;
  }
  if (task.targetArea === group.areaId) score += 6;
  if (typeof task.title === 'string' && task.title.toLowerCase().includes(group.label.split(' ')[0])) score += 1;
  return score;
}

function findReusableTask(group, existingTasks, usedTaskIds) {
  let best = null;
  let bestScore = 0;
  for (const task of existingTasks) {
    if (usedTaskIds.has(task.id)) continue;
    const score = reusableTaskScore(group, task);
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function matchingCompletedTasks(group, historicalTasks) {
  const groupRefs = groupSourceRefs(group);
  return historicalTasks
    .filter((task) => task.status === 'done' && refsOverlap(groupRefs, task.sourceSpecRefs))
    .slice(0, 5);
}

function conciseList(values, limit = 4) {
  const items = normalizeRefs(values);
  const visible = items.slice(0, limit);
  const suffix = items.length > visible.length ? `, +${items.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

function changeSummaryLines(group) {
  const lines = [];
  for (const change of group.changes) {
    const additions = change.addedValues.slice(0, 2).map((item) => `added "${summarizeValue(item, 100)}"`);
    const removals = change.removedValues.slice(0, 1).map((item) => `removed "${summarizeValue(item, 100)}"`);
    const detail = [...additions, ...removals].join('; ');
    lines.push(`${change.specRef} (${change.changeType}${detail ? `: ${detail}` : ''})`);
  }
  return lines;
}

function historicalTaskSummary(tasks) {
  return tasks
    .map((task) => `${task.iterationId ? `${task.iterationId}/` : ''}${task.id} ${task.title}`)
    .join('; ');
}

function semanticTaskTitle(group, reworkTasks) {
  if (group.areaId === 'verification') return 'Verify semantic change set';
  const verb = reworkTasks.length ? 'Rework' : 'Implement';
  return `${verb} ${group.label}`;
}

function semanticTaskDescription(group, baselineRef, reworkTasks, reusableTask) {
  const baselineLabel = baselineRef ? `baseline ${baselineRef}` : 'no prior baseline';
  const lines = [
    `Semantic diff group "${group.label}" covers ${conciseList(groupSourceRefs(group))} against ${baselineLabel}.`,
    `Changed refs: ${changeSummaryLines(group).join(' | ')}`,
  ];
  if (reworkTasks.length) {
    lines.push(`Rework previous completed task(s): ${historicalTaskSummary(reworkTasks)}.`);
  }
  if (reusableTask) {
    lines.push(`Reuses existing active task id ${reusableTask.id} while refreshing its semantic scope.`);
  }
  if (group.areaId === 'requirements') {
    lines.push('Regenerate or re-dispose affected user questions and answers before implementation scope is treated as final.');
  }
  return lines.join(' ');
}

function semanticTaskAcceptance(group, reworkTasks) {
  if (group.areaId === 'verification') {
    return [
      'All semantic implementation tasks in this diff graph have automated or documented verification.',
      'Regression coverage exists for any reworked completed task overlap.',
      'Clarifying question disposition and reused user answers remain consistent with the approved active spec.',
    ];
  }
  const criteria = [
    `Active spec refs are implemented together: ${conciseList(groupSourceRefs(group), 8)}.`,
    'Related changed fields are handled as one semantic change, not as isolated field edits.',
    'Relevant tests or verification notes are added or updated for this semantic area.',
  ];
  if (reworkTasks.length) {
    criteria.push('Previously completed overlapping work is reused where valid and deliberately revised where the active spec changed behavior.');
  }
  if (group.areaId === 'requirements') {
    criteria.push('Affected clarifying questions, assumptions, and user answers are re-disposed or explicitly confirmed.');
  }
  return criteria;
}

function semanticTaskPrompt({ projectId, iterationId, group, reworkTasks }) {
  const refs = conciseList(groupSourceRefs(group), 8);
  const reworkLine = reworkTasks.length
    ? `Re-evaluate these completed task overlaps before editing: ${historicalTaskSummary(reworkTasks)}.`
    : 'No completed task overlap was detected for this semantic group.';
  return [
    `Use the approved active Plan2Agent spec for ${projectId} iteration ${iterationId}.`,
    `Work on semantic area "${group.label}" covering refs: ${refs}.`,
    reworkLine,
    'Keep the change scoped to this task, preserve unrelated baseline behavior, and update tests or verification artifacts as needed.',
  ].join('\n');
}

function buildSemanticTask({ projectId, iterationId, group, taskId, status, dependencies, baselineRef, historicalTasks, reusableTask }) {
  const reworkTasks = matchingCompletedTasks(group, historicalTasks);
  return {
    id: taskId,
    title: semanticTaskTitle(group, reworkTasks),
    description: semanticTaskDescription(group, baselineRef, reworkTasks, reusableTask),
    status,
    dependencies,
    acceptanceCriteria: semanticTaskAcceptance(group, reworkTasks),
    targetArea: group.areaId,
    suggestedAgentPrompt: semanticTaskPrompt({ projectId, iterationId, group, reworkTasks }),
    sourceSpecRefs: groupSourceRefs(group),
  };
}

function addSyntheticVerificationGroup(groups) {
  if (groups.some((group) => group.areaId === 'verification')) return groups;
  if (!groups.some((group) => group.areaId !== 'verification')) return groups;
  return [
    ...groups,
    {
      areaId: 'verification',
      label: semanticAreaById('verification').label,
      changes: [{
        section: 'implementation',
        field: 'verification',
        specRef: 'implementation.verification',
        changeType: 'review',
        addedValues: ['Verify the semantic diff task set and regression coverage.'],
        removedValues: [],
        activeSummary: '',
        baselineSummary: '',
      }],
    },
  ];
}

function semanticTasksFromGroups({ projectId, iterationId, groups, baselineRef, existingTaskGraph, historicalTasks }) {
  const existingTasks = existingTaskGraph?.tasks ?? [];
  const nextTaskId = nextTaskIdAllocator(existingTasks);
  const usedTaskIds = new Set();
  const taskSlots = [];

  for (const group of groups) {
    const reusableTask = findReusableTask(group, existingTasks, usedTaskIds);
    const taskId = reusableTask?.id ?? nextTaskId();
    if (reusableTask) usedTaskIds.add(reusableTask.id);
    taskSlots.push({
      group,
      taskId,
      status: reusableTask?.status ?? 'todo',
      reusableTask,
    });
  }

  const requirementsTaskIds = taskSlots
    .filter((slot) => slot.group.areaId === 'requirements')
    .map((slot) => slot.taskId);
  const implementationTaskIds = taskSlots
    .filter((slot) => slot.group.areaId !== 'verification')
    .map((slot) => slot.taskId);

  return taskSlots.map((slot) => {
    let dependencies = [];
    if (slot.group.areaId === 'verification') {
      dependencies = implementationTaskIds.filter((taskId) => taskId !== slot.taskId);
    } else if (slot.group.areaId !== 'requirements') {
      dependencies = requirementsTaskIds.filter((taskId) => taskId !== slot.taskId);
    }
    return buildSemanticTask({
      projectId,
      iterationId,
      group: slot.group,
      taskId: slot.taskId,
      status: slot.status,
      dependencies,
      baselineRef,
      historicalTasks,
      reusableTask: slot.reusableTask,
    });
  });
}

function expandVisualSemanticGroups(groups, visualContract) {
  if (!visualContract || visualContract.screenStates.length < 2) return groups;
  const uiGroupIndex = groups.findIndex((group) => group.areaId === 'ui');
  if (uiGroupIndex < 0) return groups;
  const uiGroup = groups[uiGroupIndex];
  return groups.flatMap((group, index) => (
    index === uiGroupIndex
      ? visualContract.screenStates.map((screenState) => ({
          ...group,
          label: `${uiGroup.label} (${screenState.screenId})`,
        }))
      : [group]
  ));
}

function applyDeterministicVisualImpact(tasks, visualContract) {
  if (!visualContract) return tasks;
  const uiOwnerIndexes = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.targetArea === 'ui')
    .map(({ index }) => index);
  const fallbackOwnerIndex = tasks.findIndex((task) => task.targetArea !== 'verification');
  const ownerIndexes = uiOwnerIndexes.length ? uiOwnerIndexes : [fallbackOwnerIndex];
  if (ownerIndexes[0] < 0) {
    throw new ValidationError('full current-iteration visual experience requires at least one implementation task');
  }
  const impactByOwnerIndex = new Map(ownerIndexes.map((ownerIndex, ownerOrder) => [
    ownerIndex,
    {
      screenStates: ownerIndexes.length === visualContract.screenStates.length
        ? [cloneJson(visualContract.screenStates[ownerOrder])]
        : cloneJson(visualContract.screenStates),
    },
  ]));
  return tasks.map((task, index) => {
    const visualImpact = impactByOwnerIndex.get(index);
    return {
      ...task,
      workKind: visualImpact
        ? (task.targetArea === 'ui' ? 'ui' : 'mixed')
        : 'non_ui',
      ...(visualImpact ? { visualImpact } : {}),
    };
  });
}

export function taskGraphFromSpecChanges({ projectId, iterationId, activeSpec, baselineSpec, baselineRef, existingTaskGraph = null, historicalTasks = [], visualContract = null }) {
  const detailedChanges = collectDetailedSpecChanges(baselineSpec, activeSpec);
  const groups = addSyntheticVerificationGroup(expandVisualSemanticGroups(
    semanticGroupsFromChanges(activeSpec, detailedChanges),
    visualContract,
  ));
  const tasks = applyDeterministicVisualImpact(semanticTasksFromGroups({
    projectId,
    iterationId,
    groups,
    baselineRef,
    existingTaskGraph,
    historicalTasks,
  }), visualContract);
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId,
    version: iterationId,
    sourceSpec: '../gate-b-spec/spec.json',
    tasks,
  };
}

function iterationMetadataPath(artifactRoot, iterationId) {
  return path.join(artifactRoot, 'iterations', iterationId, 'iteration.json');
}

function loadOptionalIterationMetadata(artifactRoot, iterationId) {
  const metadataPath = iterationMetadataPath(artifactRoot, iterationId);
  if (!existsSync(metadataPath)) return null;
  return loadJson(metadataPath);
}

function sortIterationIds(iterationIds, artifactRoot, currentSpec) {
  const composedOrder = new Map((currentSpec.composed_from ?? []).map((iterationId, index) => [iterationId, index]));
  return [...iterationIds].sort((left, right) => {
    const leftKnown = composedOrder.has(left);
    const rightKnown = composedOrder.has(right);
    if (leftKnown || rightKnown) {
      if (leftKnown && rightKnown) return composedOrder.get(left) - composedOrder.get(right);
      if (leftKnown) return -1;
      if (rightKnown) return 1;
    }

    const leftMetadata = loadOptionalIterationMetadata(artifactRoot, left);
    const rightMetadata = loadOptionalIterationMetadata(artifactRoot, right);
    const leftOpened = leftMetadata?.opened_at ?? '';
    const rightOpened = rightMetadata?.opened_at ?? '';
    if (leftOpened !== rightOpened) return leftOpened.localeCompare(rightOpened);
    return left.localeCompare(right);
  });
}

function inferSourceStatus({ iterationId, activeIteration, metadata, taskGraph }) {
  if (metadata?.status === 'archived') return 'archived';
  if (iterationId !== activeIteration) return 'archived';
  const incomplete = taskGraph.tasks.filter((task) => task.status !== 'done');
  return incomplete.length ? 'active' : 'close-ready';
}

function collectCompositionSources(artifactRoot, currentSpec) {
  const iterationsRoot = path.join(artifactRoot, 'iterations');
  assertDirectory(iterationsRoot, 'iterations');
  const iterationIds = readdirSync(iterationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((iterationId) => iterationId !== 'maintenance');
  const orderedIterationIds = sortIterationIds(iterationIds, artifactRoot, currentSpec);
  const sources = [];
  const skipped = [];

  for (const iterationId of orderedIterationIds) {
    const specPath = path.join(artifactRoot, sourceSpecRef(iterationId));
    const taskGraphPath = path.join(artifactRoot, taskGraphRef(iterationId));
    if (!existsSync(specPath)) {
      skipped.push({ iteration_id: iterationId, reason: 'missing spec.json' });
      continue;
    }

    const spec = validateSpec(specPath, null, { artifactRoot });
    if (spec.project_id !== currentSpec.project_id) {
      throw new ValidationError(`iterations/${iterationId}/gate-b-spec/spec.json project_id must match current-spec.json project_id ${JSON.stringify(currentSpec.project_id)}`);
    }
    if (spec.approval !== 'approved') {
      skipped.push({ iteration_id: iterationId, reason: `spec approval is ${spec.approval}` });
      continue;
    }
    if (spec.open_decisions.length) {
      skipped.push({ iteration_id: iterationId, reason: 'spec has open_decisions' });
      continue;
    }
    if (!existsSync(taskGraphPath)) {
      skipped.push({ iteration_id: iterationId, reason: 'missing task-graph.json' });
      continue;
    }
    const taskGraph = validateTaskGraph(taskGraphPath, specPath);
    const incomplete = taskGraph.tasks.filter((task) => task.status !== 'done');
    if (incomplete.length) {
      skipped.push({
        iteration_id: iterationId,
        reason: `tasks are not all done: ${incomplete.map((task) => `${task.id}:${task.status}`).join(', ')}`,
      });
      continue;
    }
    const metadata = loadOptionalIterationMetadata(artifactRoot, iterationId);
    const resolvedSourceIntakePath = resolveSpecSourceIntake(specPath, spec);
    const sourceIntake = resolvedSourceIntakePath
      ? loadJson(resolvedSourceIntakePath)
      : null;
    sources.push({
      iteration_id: iterationId,
      spec_ref: sourceSpecRef(iterationId),
      task_graph_ref: taskGraphRef(iterationId),
      status: inferSourceStatus({
        iterationId,
        activeIteration: currentSpec.active_iteration,
        metadata,
        taskGraph,
      }),
      approval: spec.approval,
      spec,
      metadata,
      source_intake: sourceIntake,
    });
  }

  return { sources, skipped };
}

function buildComposedCurrentSpec(previousCurrentSpec, sources, skipped) {
  if (sources.length < 2) {
    throw new ValidationError('compose requires at least two approved close-ready iteration specs; thin pointer remains sufficient');
  }
  const {
    effectiveProduct,
    effectiveImplementation,
    supersededRefs,
    compositionConflicts,
  } = composeCanonicalSpecSources(sources);

  const openDecisions = compositionOpenDecisions(compositionConflicts);
  const composedIterationIds = sources.map((source) => source.iteration_id);
  const composedCurrentSpec = {
    schema_version: 'p2a.current_spec.v1',
    project_id: previousCurrentSpec.project_id,
    active_iteration: previousCurrentSpec.active_iteration,
    composed_from: composedIterationIds,
    effective_spec_ref: 'current-spec.json',
    source_specs: sources.map((source) => ({
      iteration_id: source.iteration_id,
      spec_ref: source.spec_ref,
      status: source.status,
      approval: source.approval,
    })),
    effective_product: effectiveProduct,
    effective_implementation: effectiveImplementation,
    superseded_refs: supersededRefs,
    open_decisions: openDecisions,
    composition_conflicts: compositionConflicts,
    skipped_iterations: skipped,
    composed_at: new Date().toISOString(),
    note: 'current-spec.json is the composed effective view across approved close-ready iterations. Conflicts must be resolved before new planning uses this baseline.',
  };

  if (previousCurrentSpec.last_closed_iteration) {
    composedCurrentSpec.last_closed_iteration = previousCurrentSpec.last_closed_iteration;
  }
  if (Array.isArray(previousCurrentSpec.closed_iterations)) {
    composedCurrentSpec.closed_iterations = previousCurrentSpec.closed_iterations;
  }
  if (previousCurrentSpec.gate_b_approval_audits && typeof previousCurrentSpec.gate_b_approval_audits === 'object') {
    composedCurrentSpec.gate_b_approval_audits = cloneJson(previousCurrentSpec.gate_b_approval_audits);
  }
  const pending = previousCurrentSpec.pending_iteration;
  if (pending) composedCurrentSpec.pending_iteration = pending;

  return composedCurrentSpec;
}

function buildPlan(paths, iterationId, facts) {
  const projectId = projectIdFrom(paths.artifactRoot, facts.spec, facts.taskGraph);
  return {
    projectId,
    gateBApprovalAudit: facts.gateBApprovalAudit,
    moves: GATE_DIRS.map((gate) => ({
      from: path.join(paths.artifactRoot, gate),
      to: path.join(paths.iterationRoot, gate),
    })),
    movedSpec: paths.movedSpecJson,
    movedTaskGraph: paths.movedTaskGraph,
    writes: [
      { path: paths.statusMd, description: 'write root iteration index status.md' },
      { path: paths.currentSpec, description: 'write thin current-spec.json pointer' },
      { path: paths.maintenanceReadme, description: 'write lazy maintenance README.md' },
    ],
  };
}

function printPlan(plan, dryRun) {
  console.log(`${dryRun ? 'Dry-run conversion plan' : 'Conversion plan'} for ${plan.projectId}:`);
  for (const move of plan.moves) {
    console.log(`- move ${toRelativeFromRoot(move.from)} -> ${toRelativeFromRoot(move.to)}`);
  }
  console.log(`- rebase spec.source_intake -> ${INIT_REBASED_SOURCE_INTAKE}: ${toRelativeFromRoot(plan.movedSpec)}`);
  console.log(`- rebase task-graph.sourceSpec -> ${INIT_REBASED_SOURCE_SPEC}: ${toRelativeFromRoot(plan.movedTaskGraph)}`);
  for (const write of plan.writes) {
    console.log(`- ${write.description}: ${toRelativeFromRoot(write.path)}`);
  }
}

function rebaseMovedGateBApprovalReference(reference, iterationId) {
  if (typeof reference !== 'string') return reference;
  const normalized = reference.replaceAll('\\', '/');
  const marker = 'gate-b-spec/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return reference;
  const prefix = normalized.slice(0, markerIndex);
  if (/(?:^|\/)iterations\/[^/]+\/$/.test(prefix)) return reference;
  return prefix + 'iterations/' + iterationId + '/' + normalized.slice(markerIndex);
}

function rebaseMovedSpecReferences(source, iterationId) {
  const sourceText = readFileSync(source, 'utf8');
  const spec = JSON.parse(sourceText);
  if (typeof spec.source_intake !== 'string') {
    throw new Error('could not find source_intake in ' + source);
  }
  spec.source_intake = INIT_REBASED_SOURCE_INTAKE;
  if (Array.isArray(spec.approval_audit?.approved_artifacts)) {
    spec.approval_audit.approved_artifacts = spec.approval_audit.approved_artifacts.map(
      (reference) => rebaseMovedGateBApprovalReference(reference, iterationId),
    );
  }
  const rewritten = JSON.stringify(spec, null, 2) + '\n';
  if (rewritten === sourceText) return sourceText;
  atomicWriteText(source, rewritten);
  return sourceText;
}

function rebaseMovedTaskGraphSourceSpec(source) {
  const sourceText = readFileSync(source, 'utf8');
  const pattern = /(\"sourceSpec\"\s*:\s*)(\"(?:[^\"\\]|\\.)*\")/;
  const match = sourceText.match(pattern);
  if (!match) throw new Error(`could not find sourceSpec in ${source}`);
  if (JSON.parse(match[2]) === INIT_REBASED_SOURCE_SPEC) return sourceText;
  const rewritten = sourceText.replace(pattern, `$1${JSON.stringify(INIT_REBASED_SOURCE_SPEC)}`);
  atomicWriteText(source, rewritten);
  return sourceText;
}

function applyPlan(paths, iterationId, plan) {
  const moved = [];
  const outputSnapshot = captureRollbackFiles([
    paths.currentSpec,
    paths.statusMd,
    paths.maintenanceReadme,
  ]);
  const directoryExisted = new Map([
    [paths.iterationsRoot, existsSync(paths.iterationsRoot)],
    [paths.iterationRoot, existsSync(paths.iterationRoot)],
    [paths.maintenanceRoot, existsSync(paths.maintenanceRoot)],
  ]);
  let originalMovedSpec = null;
  let originalMovedTaskGraph = null;
  try {
    mkdirSync(paths.iterationRoot, { recursive: true });
    for (const move of plan.moves) {
      renameSync(move.from, move.to);
      moved.push(move);
    }
    originalMovedSpec = rebaseMovedSpecReferences(paths.movedSpecJson, iterationId);
    originalMovedTaskGraph = rebaseMovedTaskGraphSourceSpec(paths.movedTaskGraph);
    const movedFacts = validateMoved(paths);
    const projectId = projectIdFrom(paths.artifactRoot, movedFacts.spec, movedFacts.taskGraph);
    const currentSpec = currentSpecPointer(projectId, iterationId, plan.gateBApprovalAudit);
    mkdirSync(paths.maintenanceRoot, { recursive: true });
    atomicWriteJson(paths.currentSpec, currentSpec);
    writeIterationStatus(paths.artifactRoot, currentSpec);
    atomicWriteText(paths.maintenanceReadme, maintenanceReadme());
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(outputSnapshot);
    if (originalMovedTaskGraph !== null && existsSync(paths.movedTaskGraph)) {
      try {
        atomicWriteText(paths.movedTaskGraph, originalMovedTaskGraph);
      } catch (rollbackError) {
        rollbackFailures.push(`${paths.movedTaskGraph}: ${rollbackError.message}`);
      }
    }
    if (originalMovedSpec !== null && existsSync(paths.movedSpecJson)) {
      try {
        atomicWriteText(paths.movedSpecJson, originalMovedSpec);
      } catch (rollbackError) {
        rollbackFailures.push(`${paths.movedSpecJson}: ${rollbackError.message}`);
      }
    }
    for (const move of moved.reverse()) {
      try {
        if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from);
      } catch (rollbackError) {
        rollbackFailures.push(`${move.to} -> ${move.from}: ${rollbackError.message}`);
      }
    }
    for (const directory of [
      paths.maintenanceRoot,
      paths.iterationRoot,
      paths.iterationsRoot,
    ]) {
      if (directoryExisted.get(directory) || !existsSync(directory)) continue;
      try {
        rmdirSync(directory);
      } catch (rollbackError) {
        rollbackFailures.push(`${directory}: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; iteration init rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function validateMoved(paths) {
  const spec = validateSpec(paths.movedSpecJson);
  if (spec.approval !== 'approved') {
    throw new ValidationError(`moved spec.approval must be approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError(`moved spec.open_decisions must be empty, got ${JSON.stringify(spec.open_decisions)}`);
  }
  const taskGraph = validateTaskGraph(paths.movedTaskGraph, paths.movedSpecJson);
  return { spec, taskGraph };
}

function init(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const paths = pathsFor(artifactRoot, args.iterationId);
  const facts = preflight(paths, args.iterationId);
  const plan = buildPlan(paths, args.iterationId, facts);
  printPlan(plan, args.dryRun);
  if (args.dryRun) {
    console.log('Dry-run only; no files written.');
    return 0;
  }

  applyPlan(paths, args.iterationId, plan);
  validateMoved(paths);
  resolveIterationState(artifactRoot);
  console.log(`Plan2Agent iteration init passed: ${toRelativeFromRoot(artifactRoot)} -> iterations/${args.iterationId}/`);
  console.log('Moved artifacts revalidated: spec approved, task graph valid, Gate B approval audit present.');
  console.log('Maintenance is lazy: no empty task-graph.json was created.');
  return 0;
}

function current(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  if (args.json) {
    console.log(JSON.stringify(serializeIterationState(state), null, 2));
  } else {
    console.log(formatIterationState(state));
  }
  return 0;
}

function assertCloseReadyTasks(taskGraph) {
  const incomplete = taskGraph.tasks.filter((task) => task.status !== 'done');
  if (incomplete.length) {
    const summary = incomplete.map((task) => `${task.id}:${task.status}`).join(', ');
    throw new ValidationError(`close-ready validation requires all tasks done; incomplete tasks: ${summary}`);
  }
}

export function validateCloseReadyVisualEvidence({
  artifactRoot,
  activeIteration,
  taskGraphPath,
  taskGraph,
  reviewPasses,
}) {
  const policy = reviewPasses ?? projectReviewPasses();
  const visualTasks = taskGraph.tasks.filter((task) => task.visualImpact);
  if (!visualTasks.length) return 0;
  if (policy.visual === 'off') {
    console.log(`- visual review: skipped (reviewPasses.visual=off, ${visualTasks.length} visualImpact task(s))`);
    return 0;
  }
  const runsDir = path.join(path.resolve(artifactRoot), 'runs');
  validateRunsDir(runsDir);
  const expectedSourceLayout = taskGraphContextForGraph(taskGraphPath).sourceLayout;
  const currentRuns = loadRunsForArtifactRoot(artifactRoot)
    .filter((run) => (
      run.iterationId === activeIteration
      && run.sourceLayout === expectedSourceLayout
      && taskGraphRefMatchesGraph(run.taskGraphRef, taskGraphPath, artifactRoot)
    ));
  const activeRuns = currentRuns.filter((run) => run.status === 'started');
  if (activeRuns.length) {
    throw new ValidationError(
      `close-ready visual validation requires no active run(s): ${activeRuns.map((run) => run.runId).join(', ')}`,
    );
  }
  const reviewHint = `Run p2a execute review --artifacts ${artifactRoot} after canonical integration.`;
  const latestRun = currentRuns
    .map((run, runOrder) => ({ run, runOrder }))
    .filter(({ run }) => run.runKind === 'final_visual_review')
    .sort(compareRunEvidence)[0]?.run;
  try {
    assertFinalVisualReviewRunReady({
      runsDir,
      run: latestRun,
      taskId: 'the active iteration',
      artifactRoot,
      graphPath: taskGraphPath,
    });
  } catch (error) {
    throw new ValidationError(
      `close-ready visual validation failed: ${error.message}. ${reviewHint}`,
    );
  }
  return 1;
}

function loadReadyIterationFacts(artifactRoot) {
  const state = resolveIterationState(artifactRoot);
  const spec = validateActiveSpecWithOptionalIntake(state);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  return { state, spec, taskGraph };
}

function activeIntakePath(state) {
  return path.join(state.iterationRoot, 'gate-a-intake', 'intake.json');
}

function validateActiveSpecWithOptionalIntake(state) {
  assertActivePlanningBaselineContract(state);
  const intakePath = activeIntakePath(state);
  if (!existsSync(intakePath)) {
    return validateSpec(
      state.specPath,
      null,
      { artifactRoot: state.artifactRoot },
    );
  }
  validateIntake(intakePath, { artifactRoot: state.artifactRoot });
  return validateSpec(state.specPath, intakePath, { artifactRoot: state.artifactRoot });
}

function inferPlanningStage(state) {
  if (existsSync(state.taskGraphPath) && existsSync(state.specPath)) return 'ready';
  if (existsSync(state.specPath)) {
    const spec = validateActiveSpecWithOptionalIntake(state);
    return spec.approval === 'approved' ? 'gate-b-approved' : 'gate-b-draft';
  }
  return 'gate-a';
}

function validatePlanningIteration(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  validateCurrentSpecCompositionData(state.currentSpec, state.artifactRoot, { requireNoOpenDecisions: true });
  const stage = args.stage ?? inferPlanningStage(state);
  if (stage === 'ready') return validateIteration({ ...args, stage: null, allowPlanning: false });
  const iterationMetadata = loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration);
  assertActivePlanningBaselineContract(state, iterationMetadata);
  const planningMemory = iterationMetadata?.planning_memory ?? null;
  const planningMemoryErrors = planningMemoryValidationErrors(planningMemory, state.artifactRoot, state.projectId, iterationMetadata?.idea ?? state.currentSpec.pending_iteration?.idea);
  if (planningMemory?.status === 'pending') planningMemoryErrors.push('planning_memory.status must be resolved before validating a gate');
  if (planningMemoryErrors.length) {
    throw new ValidationError(`planning Memory validation failed: ${planningMemoryErrors.join('; ')}`);
  }

  const pendingStatus = state.currentSpec.pending_iteration?.status;
  const allowedPendingStatuses = new Set([
    'active_planning',
    'gate_a_ready',
    'gate_b_draft',
    'gate_b_approved',
  ]);
  if (pendingStatus && !allowedPendingStatuses.has(pendingStatus)) {
    throw new ValidationError(`current-spec.json pending_iteration.status is not a planning status: ${JSON.stringify(pendingStatus)}`);
  }
  if (state.currentSpec.pending_iteration && state.currentSpec.pending_iteration.iteration_id !== state.activeIteration) {
    throw new ValidationError(`current-spec.json pending_iteration.iteration_id must match active_iteration ${JSON.stringify(state.activeIteration)}`);
  }

  const intakePath = activeIntakePath(state);
  if (stage === 'gate-c-draft') {
    const draftPath = gateCTaskGraphDraftPath(state);
    if (!existsSync(draftPath)) throw new ValidationError(`gate-c draft not found: ${draftPath}`);
    const draft = loadJson(draftPath);
    validateTaskGraphData(draft);
    const intakePath = activeIntakePath(state);
    if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, state.artifactRoot);
    if (existsSync(state.specPath)) validatePlanningMemoryEvidence(planningMemory, loadJson(state.specPath), state.specPath, state.artifactRoot);
    console.log(`Plan2Agent gate-c draft valid: ${draft.tasks.length} task(s)`);
    return 0;
  }

  if (stage === 'gate-a') {
    assertFile(intakePath, `iterations/${state.activeIteration}/gate-a-intake/intake.json`);
    const intake = validateIntake(intakePath, { artifactRoot: state.artifactRoot });
    validatePlanningMemoryEvidence(planningMemory, intake, intakePath, state.artifactRoot);
    console.log(`Plan2Agent planning iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
    console.log(`- active iteration: ${state.activeIteration}`);
    console.log(`- stage: gate-a`);
    console.log(`- intake: status=${intake.status}`);
    console.log('- Gate B/C artifacts are pending');
    return 0;
  }

  if (stage !== 'gate-b-draft' && stage !== 'gate-b-approved') {
    throw new Error(`unsupported planning validation stage: ${stage}`);
  }
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  const spec = validateActiveSpecWithOptionalIntake(state);
  if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, state.artifactRoot);
  validatePlanningMemoryEvidence(planningMemory, spec, state.specPath, state.artifactRoot);
  if (stage === 'gate-b-approved' && spec.approval !== 'approved') {
    throw new ValidationError(`--stage gate-b-approved requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (stage === 'gate-b-draft' && spec.approval === 'approved') {
    throw new ValidationError('--stage gate-b-draft expected a non-approved spec; use --stage gate-b-approved for approved Gate B');
  }

  console.log(`Plan2Agent planning iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- stage: ${stage}`);
  console.log(`- spec: approval=${spec.approval}`);
  console.log('- task graph validation is pending');
  return 0;
}

function maintenanceTaskGraphPath(artifactRoot) {
  return path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
}

function gateCTaskGraphDraftPath(state) {
  return path.join(path.dirname(state.taskGraphPath), 'task-graph.draft.json');
}

function gateCTaskGraphDraftMetaPath(state) {
  return path.join(path.dirname(state.taskGraphPath), 'task-graph.draft.meta.json');
}

function activeBaselineEffectiveSpecRef(state) {
  return state.currentSpec.pending_iteration?.baseline_effective_spec_ref
    ?? state.currentSpec.effective_spec_ref
    ?? null;
}

function taskDraftProvenance(state, draftPath, promotedAt) {
  const existingMetaPath = gateCTaskGraphDraftMetaPath(state);
  const existingMeta = existsSync(existingMetaPath) ? loadJson(existingMetaPath) : null;
  return {
    ...(existingMeta ?? {}),
    schema_version: 'p2a.task_graph_draft_meta.v1',
    project_id: state.projectId,
    iteration_id: state.activeIteration,
    draft_ref: artifactRelativePath(state.artifactRoot, draftPath),
    canonical_task_graph_ref: artifactRelativePath(state.artifactRoot, state.taskGraphPath),
    source_spec_ref: sourceSpecRef(state.activeIteration),
    baseline_effective_spec_ref: activeBaselineEffectiveSpecRef(state),
    source_idea: state.currentSpec.pending_iteration?.idea ?? null,
    draft_sha256: fileSha256(draftPath),
    source_spec_sha256: existsSync(state.specPath) ? fileSha256(state.specPath) : null,
    promoted_at: promotedAt,
  };
}

function summarizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    targetArea: task.targetArea,
    ...(task.workKind ? { workKind: task.workKind } : {}),
    sourceSpecRefs: task.sourceSpecRefs,
    ...(task.visualImpact ? { visualImpact: cloneJson(task.visualImpact) } : {}),
  };
}

function summarizeTaskGraphIfPresent(graphPath) {
  if (!existsSync(graphPath)) return [];
  return (loadJson(graphPath).tasks ?? []).map(summarizeTask);
}

function loadContextEffectiveSpec(state) {
  const activeSpec = existsSync(state.specPath) ? loadJson(state.specPath) : null;
  const visualExperience = activeSpec?.visual_experience
    ? { visual_experience: cloneJson(activeSpec.visual_experience) }
    : {};
  if (state.currentSpec.effective_product && state.currentSpec.effective_implementation) {
    return {
      product: cloneJson(state.currentSpec.effective_product),
      implementation: cloneJson(state.currentSpec.effective_implementation),
      ...visualExperience,
    };
  }
  const fallbackPath = existsSync(state.effectiveSpecPath) ? state.effectiveSpecPath : state.specPath;
  const data = loadJson(fallbackPath);
  return {
    product: cloneJson(data.product ?? {}),
    implementation: cloneJson(data.implementation ?? {}),
    ...(data.visual_experience ? { visual_experience: cloneJson(data.visual_experience) } : visualExperience),
  };
}

function contextSpecFieldChanges(state) {
  if (!existsSync(state.specPath) || !existsSync(state.effectiveSpecPath)) return [];
  const activeSpec = loadJson(state.specPath);
  const baselineSpec = state.currentSpec.effective_product && state.currentSpec.effective_implementation
    ? {
        product: state.currentSpec.effective_product,
        implementation: state.currentSpec.effective_implementation,
      }
    : loadEffectiveBaselineSpec(state.effectiveSpecPath, state.artifactRoot);
  return collectSpecFieldChanges(baselineSpec, activeSpec);
}

const CODE_SIGNAL_FILE_TREE_LIMIT = 300;
const CODE_SIGNAL_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.plan2agent',
  'build',
  'dist',
  'out',
  'target',
  '.gradle',
  '.idea',
  '.claude',
  '.codex',
  '.gemini',
  '.agents',
]);

export function collectCodeFileTree(codeRoot, limit = CODE_SIGNAL_FILE_TREE_LIMIT) {
  const root = path.resolve(process.cwd(), codeRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    return { code_root: null, file_tree: [], truncated: false };
  }
  const fileTree = [];
  const directoryFrames = [{
    dirPath: root,
    entries: readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name)),
    index: 0,
  }];
  while (directoryFrames.length && fileTree.length <= limit) {
    const frame = directoryFrames.shift();
    const entry = frame.entries[frame.index];
    frame.index += 1;
    if (frame.index < frame.entries.length) directoryFrames.push(frame);
    if (!entry) continue;
    const entryPath = path.join(frame.dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!CODE_SIGNAL_EXCLUDED_DIRS.has(entry.name)) {
        directoryFrames.push({
          dirPath: entryPath,
          entries: readdirSync(entryPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name)),
          index: 0,
        });
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = normalizeDisplayPath(path.relative(root, entryPath));
    if (!relative || relative.startsWith('..')) continue;
    fileTree.push(relative);
  }
  const truncated = fileTree.length > limit;
  return {
    code_root: normalizeDisplayPath(toRelativeFromRoot(root)),
    file_tree: fileTree.slice(0, limit),
    truncated,
  };
}

function recentRunChanges(artifactRoot) {
  try {
    return loadRunsForArtifactRoot(artifactRoot).map((run) => ({
      taskId: run.taskId,
      runId: run.runId,
      status: run.status,
      changedFiles: run.changedFiles ?? [],
      finishedAt: run.finishedAt ?? null,
    }));
  } catch {
    return [];
  }
}

function collectCodeSignals(args, state) {
  const fileSignals = collectCodeFileTree(args.codeRoot ?? process.cwd());
  return {
    ...fileSignals,
    recent_changes: recentRunChanges(state.artifactRoot),
  };
}

function planningMemoryTaskContext(state) {
  const memory = loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration)?.planning_memory ?? null;
  if (!memory) {
    return {
      status: 'not_configured',
      baseline_freshness: { status: 'unchecked', report_ref: null, detail: 'No planning Memory metadata is present.' },
      layers: [],
      relevant_results: [],
      relevant_failures: [],
    };
  }
  const layers = Object.values(memory.layers ?? {}).map((layer) => ({
    scope: layer.scope,
    status: layer.status,
    report_ref: layer.report_ref ?? null,
    query: layer.query ?? null,
    requested_mode: layer.requested_mode ?? null,
    effective_mode: layer.effective_mode ?? null,
    fallback: layer.fallback ?? null,
    result_count: Number(layer.result_count ?? 0),
  }));
  const relevantResults = Object.values(memory.layers ?? {})
    .flatMap((layer) => (layer.relevant_results ?? []).map((result) => ({ scope: layer.scope, ...result })));
  const relevantFailures = Object.values(memory.layers ?? {})
    .flatMap((layer) => (layer.relevant_failures ?? []).map((result) => ({ scope: layer.scope, ...result })));
  return {
    status: memory.status,
    baseline_freshness: memory.baseline_freshness ?? { status: 'unchecked', report_ref: null, detail: null },
    layers,
    relevant_results: relevantResults,
    relevant_failures: relevantFailures,
  };
}

function context(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  assertActivePlanningBaselineContract(state);
  const effectiveSpec = loadContextEffectiveSpec(state);
  const scope = args.scope ?? 'feature';
  const contextData = {
    schema_version: 'p2a.task_context.v1',
    project_id: state.projectId,
    active_iteration: scope === 'maintenance' ? 'maintenance' : state.activeIteration,
    scope,
    idea: scope === 'maintenance' ? (args.idea ?? null) : (args.idea ?? state.currentSpec.pending_iteration?.idea ?? null),
    baseline_effective_spec_ref: activeBaselineEffectiveSpecRef(state),
    effective_spec: effectiveSpec,
    existing_tasks: {
      active: summarizeTaskGraphIfPresent(state.taskGraphPath),
      maintenance: summarizeTaskGraphIfPresent(maintenanceTaskGraphPath(state.artifactRoot)),
    },
    spec_field_changes: scope === 'maintenance' ? [] : contextSpecFieldChanges(state),
    planning_memory: planningMemoryTaskContext(state),
    code_signals: collectCodeSignals(args, state),
  };
  validateTaskContextData(contextData);
  console.log(JSON.stringify(contextData, null, 2));
  return 0;
}

function validateMaintenanceTaskGraphIfPresent(state) {
  const graphPath = maintenanceTaskGraphPath(state.artifactRoot);
  if (!existsSync(graphPath)) return null;
  const graph = validateTaskGraph(graphPath);
  validateMaintenanceTaskGraphProject(state, graph);
  return { graphPath, graph };
}

function initialMaintenanceTaskGraph(projectId) {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId,
    version: 'maintenance',
    sourceSpec: '../../../current-spec.json',
    tasks: [],
  };
}

function writeMaintenanceGraphAndStatus(state, graphPath, graph) {
  const statusPath = path.join(state.artifactRoot, 'status.md');
  const snapshot = captureRollbackFiles([graphPath, statusPath]);
  try {
    mkdirSync(path.dirname(graphPath), { recursive: true });
    atomicWriteJson(graphPath, graph);
    writeIterationStatus(state.artifactRoot, state.currentSpec);
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(snapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; maintenance graph rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function nextMaintenanceTaskId(tasks) {
  const max = tasks.reduce((highest, task) => {
    const match = typeof task.id === 'string' ? task.id.match(/^task-([0-9]+)$/) : null;
    return match ? Math.max(highest, Number.parseInt(match[1], 10)) : highest;
  }, 0);
  return `task-${String(max + 1).padStart(3, '0')}`;
}

function suggestedMaintenancePrompt(title, projectId) {
  return `Apply the maintenance fix "${title}" in project ${projectId}. ` +
    'Keep the change minimal and scoped to this fix, and add or update tests/verification as needed.';
}

const MAINTENANCE_DRAFT_DEDUPE_REF_PREFIXES = [
  'eval-cluster:',
  'proposal-draft-approval:',
  'proposal-patch-draft:',
  'proposal-candidate:',
  'proposal:',
  'skill-proposal:',
];

function nonBlankString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonBlankString(value, label) {
  if (value === undefined || value === null) return null;
  return nonBlankString(value, label);
}

function nonBlankStringArray(value, label, options = {}) {
  if (value === undefined || value === null) {
    return options.defaultValue ? [...options.defaultValue] : [];
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = nonBlankString(item, `${label}[]`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  if (options.requireNonEmpty && values.length === 0) {
    throw new Error(`${label} must include at least one value`);
  }
  return values;
}

function maintenanceDraftTaskAliases(task, index) {
  return nonBlankStringArray([task.id, task.taskId, task.clusterId].filter((value) => value !== undefined && value !== null), `draft task ${index + 1} aliases`);
}

function normalizeMaintenanceDraftTask(task, index, state) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`draft task ${index + 1} must be an object`);
  }
  const title = nonBlankString(task.title, `draft task ${index + 1}.title`);
  const targetArea = optionalNonBlankString(task.targetArea ?? task.area, `draft task ${index + 1}.targetArea`) ?? 'maintenance';
  const description = optionalNonBlankString(task.description, `draft task ${index + 1}.description`) ?? title;
  const suggestedAgentPrompt = optionalNonBlankString(
    task.suggestedAgentPrompt ?? task.prompt,
    `draft task ${index + 1}.suggestedAgentPrompt`,
  ) ?? suggestedMaintenancePrompt(title, state.projectId);
  return {
    aliases: maintenanceDraftTaskAliases(task, index),
    title,
    description,
    status: 'todo',
    dependencies: nonBlankStringArray(task.dependencies ?? task.depends, `draft task ${index + 1}.dependencies`),
    acceptanceCriteria: nonBlankStringArray(task.acceptanceCriteria, `draft task ${index + 1}.acceptanceCriteria`, { requireNonEmpty: true }),
    targetArea,
    suggestedAgentPrompt,
    sourceSpecRefs: nonBlankStringArray(task.sourceSpecRefs, `draft task ${index + 1}.sourceSpecRefs`, { defaultValue: ['maintenance'], requireNonEmpty: true }),
  };
}

function maintenanceDraftDedupeRefs(sourceSpecRefs) {
  return sourceSpecRefs.filter((ref) => MAINTENANCE_DRAFT_DEDUPE_REF_PREFIXES.some((prefix) => ref.startsWith(prefix)));
}

function maintenanceDedupeRefsByTaskId(tasks) {
  const refs = new Map();
  for (const task of tasks) {
    for (const ref of maintenanceDraftDedupeRefs(task.sourceSpecRefs ?? [])) {
      if (!refs.has(ref)) refs.set(ref, task.id);
    }
  }
  return refs;
}

function registerMaintenanceDraftAliases(aliasToTaskId, aliases, taskId) {
  for (const alias of aliases) {
    const existing = aliasToTaskId.get(alias);
    if (existing && existing !== taskId) {
      throw new Error(`maintenance draft aliases must be unique; ${alias} maps to both ${existing} and ${taskId}`);
    }
    aliasToTaskId.set(alias, taskId);
  }
}

function normalizeMaintenanceDraftPath(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function loadMaintenanceDraft(filePath) {
  const draftPath = normalizeMaintenanceDraftPath(filePath);
  const draft = validateEvalMaintenanceDraftData(loadJson(draftPath));
  return { draftPath, draft };
}

function applyMaintenanceTasksFromDraft(args, state, draftPath, draft, graphPath) {
  const graph = existsSync(graphPath)
    ? loadJson(graphPath)
    : initialMaintenanceTaskGraph(state.projectId);
  validateMaintenanceTaskGraphProject(state, graph);
  if (!Array.isArray(graph.tasks)) graph.tasks = [];

  const normalizedTasks = draft.tasks.map((task, index) => normalizeMaintenanceDraftTask(task, index, state));
  const dedupeRefs = maintenanceDedupeRefsByTaskId(graph.tasks);
  const aliasToTaskId = new Map();
  const plannedTasks = [];
  const skippedTasks = [];

  for (const task of normalizedTasks) {
    const duplicateRef = maintenanceDraftDedupeRefs(task.sourceSpecRefs).find((ref) => dedupeRefs.has(ref)) ?? null;
    if (duplicateRef) {
      const existingTaskId = dedupeRefs.get(duplicateRef);
      registerMaintenanceDraftAliases(aliasToTaskId, task.aliases, existingTaskId);
      skippedTasks.push({
        title: task.title,
        ref: duplicateRef,
        taskId: existingTaskId,
      });
      continue;
    }

    const taskId = nextMaintenanceTaskId([...graph.tasks, ...plannedTasks]);
    registerMaintenanceDraftAliases(aliasToTaskId, task.aliases, taskId);
    const plannedTask = {
      id: taskId,
      title: task.title,
      description: task.description,
      status: task.status,
      dependencies: task.dependencies,
      acceptanceCriteria: task.acceptanceCriteria,
      targetArea: task.targetArea,
      suggestedAgentPrompt: task.suggestedAgentPrompt,
      sourceSpecRefs: task.sourceSpecRefs,
    };
    plannedTasks.push(plannedTask);
    for (const ref of maintenanceDraftDedupeRefs(task.sourceSpecRefs)) {
      if (!dedupeRefs.has(ref)) dedupeRefs.set(ref, taskId);
    }
  }

  for (const task of plannedTasks) {
    task.dependencies = task.dependencies.map((dependency) => aliasToTaskId.get(dependency) ?? dependency);
  }

  const nextGraph = {
    ...graph,
    tasks: [...graph.tasks, ...plannedTasks],
  };
  if (nextGraph.tasks.length) validateTaskGraphData(nextGraph);

  const label = args.dryRun ? 'Plan2Agent maintenance draft dry run' : 'Plan2Agent maintenance draft applied';
  console.log(`${label}:`);
  console.log(`- draft: ${toRelativeFromRoot(draftPath)}`);
  console.log(`- graph: ${toRelativeFromRoot(graphPath)}`);
  console.log(`- draft tasks: ${normalizedTasks.length}`);
  console.log(`- appended: ${plannedTasks.length}`);
  console.log(`- skipped: ${skippedTasks.length}`);
  for (const task of plannedTasks) {
    console.log(`- append ${task.id}: ${task.title}`);
  }
  for (const skipped of skippedTasks) {
    console.log(`- skip ${skipped.title}: ${skipped.ref} already tracked by ${skipped.taskId}`);
  }
  if (args.dryRun) {
    console.log('- write: no files changed; rerun with --yes to append.');
    return 0;
  }
  if (plannedTasks.length) {
    writeMaintenanceGraphAndStatus(state, graphPath, nextGraph);
  }
  console.log(`- tasks total: ${nextGraph.tasks.length}`);
  return 0;
}

function addMaintenanceTasksFromDraft(args) {
  const initialState = resolveIterationState(args.artifacts, { requireReady: false });
  const { draftPath, draft } = loadMaintenanceDraft(args.fromDraft);
  const graphPath = maintenanceTaskGraphPath(initialState.artifactRoot);
  const apply = () => {
    const state = resolveIterationState(args.artifacts, { requireReady: false });
    return applyMaintenanceTasksFromDraft(args, state, draftPath, draft, graphPath);
  };
  return args.dryRun
    ? apply()
    : withRunStoreLocks([
        artifactStateLockDir(initialState.artifactRoot),
        path.dirname(graphPath),
      ], apply);
}

function addMaintenanceTask(args) {
  if (args.fromDraft) return addMaintenanceTasksFromDraft(args);

  const initialState = resolveIterationState(args.artifacts, { requireReady: false });
  const graphPath = maintenanceTaskGraphPath(initialState.artifactRoot);
  const apply = () => {
    const state = resolveIterationState(args.artifacts, { requireReady: false });
    const graph = existsSync(graphPath)
      ? loadJson(graphPath)
      : initialMaintenanceTaskGraph(state.projectId);
    validateMaintenanceTaskGraphProject(state, graph);
    const task = {
      id: nextMaintenanceTaskId(graph.tasks ?? []),
      title: args.title,
      description: args.description ?? args.title,
      status: 'todo',
      dependencies: args.dependencies,
      acceptanceCriteria: args.acceptanceCriteria,
      targetArea: args.area,
      suggestedAgentPrompt: args.prompt ?? suggestedMaintenancePrompt(args.title, state.projectId),
      sourceSpecRefs: args.sourceSpecRefs.length ? args.sourceSpecRefs : ['maintenance'],
    };

    graph.tasks.push(task);
    validateTaskGraphData(graph);

    if (args.dryRun) {
      console.log('Plan2Agent maintenance task dry run:');
      console.log(`- graph: ${toRelativeFromRoot(graphPath)}`);
      console.log(`- task: ${JSON.stringify(task, null, 2)}`);
      return 0;
    }

    writeMaintenanceGraphAndStatus(state, graphPath, graph);
    console.log(`Plan2Agent maintenance task added: ${task.id}`);
    console.log(`- graph: ${toRelativeFromRoot(graphPath)}`);
    console.log(`- tasks: ${graph.tasks.length}`);
    return 0;
  };
  return args.dryRun
    ? apply()
    : withRunStoreLocks([
        artifactStateLockDir(initialState.artifactRoot),
        path.dirname(graphPath),
      ], apply);
}

function maintenance(args) {
  if (args.action === 'add') return addMaintenanceTask(args);
  throw new Error(`unsupported maintenance action: ${args.action}`);
}

function auditArchivedIterations(currentSpec, artifactRoot) {
  const closedIterations = currentSpec.closed_iterations ?? [];
  if (!Array.isArray(closedIterations)) {
    throw new ValidationError('current-spec.json closed_iterations must be an array when present');
  }
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  for (const closed of closedIterations) {
    if (!closed?.iteration_id) throw new ValidationError('current-spec.json closed_iterations entries must include iteration_id');
    if (!closed.artifact_hashes || typeof closed.artifact_hashes !== 'object' || Array.isArray(closed.artifact_hashes)) {
      throw new ValidationError(`closed iteration ${closed.iteration_id} is missing artifact_hashes; re-close or migrate audit metadata`);
    }
    const expectedVisualRefs = new Set(Object.entries(closed.artifact_hashes)
      .filter(([reference, audit]) => (
        isClosedIterationVisualArtifactRef(reference.replaceAll('\\', '/'), closed.iteration_id)
        && (typeof audit === 'string' || audit?.present === true)
      ))
      .map(([reference]) => reference.replaceAll('\\', '/')));
    const currentVisualRefs = new Set(
      closedIterationVisualArtifactRefs(closed.iteration_id, resolvedArtifactRoot),
    );
    const addedVisualRefs = [...currentVisualRefs].filter((reference) => !expectedVisualRefs.has(reference));
    const removedVisualRefs = [...expectedVisualRefs].filter((reference) => !currentVisualRefs.has(reference));
    if (addedVisualRefs.length || removedVisualRefs.length) {
      const details = [
        ...(addedVisualRefs.length ? [`added ${addedVisualRefs.join(', ')}`] : []),
        ...(removedVisualRefs.length ? [`removed ${removedVisualRefs.join(', ')}`] : []),
      ].join('; ');
      throw new ValidationError(
        `closed iteration ${closed.iteration_id} visual artifact set changed after close: ${details}`,
      );
    }
    for (const [reference, expectedAudit] of Object.entries(closed.artifact_hashes)) {
      const normalizedReference = typeof reference === 'string'
        ? reference.replaceAll('\\', '/')
        : '';
      if (
        !normalizedReference
        || path.isAbsolute(reference)
        || path.win32.isAbsolute(reference)
        || normalizedReference.split('/').includes('..')
      ) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact reference must be artifact-root-relative: ${JSON.stringify(reference)}`,
        );
      }
      const filePath = path.resolve(resolvedArtifactRoot, reference);
      const relativePath = path.relative(resolvedArtifactRoot, filePath);
      if (
        !relativePath
        || relativePath.startsWith('..')
        || path.isAbsolute(relativePath)
      ) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact reference escapes the artifact root: ${JSON.stringify(reference)}`,
        );
      }
      if (typeof expectedAudit === 'string') {
        assertFile(filePath, `closed iteration artifact ${reference}`);
        assertFileInsideArtifactRoot(
          filePath,
          resolvedArtifactRoot,
          `closed iteration artifact ${reference}`,
        );
        const actualHash = fileSha256(filePath);
        if (actualHash !== expectedAudit) {
          throw new ValidationError(`closed iteration ${closed.iteration_id} artifact changed after close: ${reference}`);
        }
        continue;
      }
      if (!expectedAudit || typeof expectedAudit !== 'object' || Array.isArray(expectedAudit)) {
        throw new ValidationError(`closed iteration ${closed.iteration_id} artifact audit entry is invalid: ${reference}`);
      }
      if (expectedAudit.present === false) {
        if (existsSync(filePath)) {
          throw new ValidationError(`closed iteration ${closed.iteration_id} artifact appeared after close: ${reference}`);
        }
        continue;
      }
      if (expectedAudit.present !== true || typeof expectedAudit.sha256 !== 'string') {
        throw new ValidationError(`closed iteration ${closed.iteration_id} artifact audit entry is invalid: ${reference}`);
      }
      assertFile(filePath, `closed iteration artifact ${reference}`);
      assertFileInsideArtifactRoot(
        filePath,
        resolvedArtifactRoot,
        `closed iteration artifact ${reference}`,
      );
      const actualHash = fileSha256(filePath);
      if (actualHash !== expectedAudit.sha256) {
        throw new ValidationError(`closed iteration ${closed.iteration_id} artifact changed after close: ${reference}`);
      }
    }
  }
  return closedIterations.length;
}

function validateIteration(args) {
  if (args.allowPlanning || args.stage) return validatePlanningIteration(args);
  const state = resolveIterationState(args.artifacts);
  validateCurrentSpecCompositionData(state.currentSpec, state.artifactRoot, { requireNoOpenDecisions: true });
  const iterationMetadata = loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration);
  const planningMemory = iterationMetadata?.planning_memory ?? null;
  const planningMemoryErrors = planningMemoryValidationErrors(planningMemory, state.artifactRoot, state.projectId, iterationMetadata?.idea);
  if (planningMemory?.status === 'pending') planningMemoryErrors.push('planning_memory.status must be resolved before readiness validation');
  if (planningMemoryErrors.length) {
    throw new ValidationError(`planning Memory validation failed: ${planningMemoryErrors.join('; ')}`);
  }
  const spec = validateActiveSpecWithOptionalIntake(state);
  const intakePath = activeIntakePath(state);
  if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, state.artifactRoot);
  validatePlanningMemoryEvidence(planningMemory, spec, state.specPath, state.artifactRoot);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  if (args.requireCloseReady) {
    assertCloseReadyTasks(taskGraph);
    validateCloseReadyVisualEvidence({
      artifactRoot: state.artifactRoot,
      activeIteration: state.activeIteration,
      taskGraphPath: state.taskGraphPath,
      taskGraph,
      reviewPasses: projectReviewPasses(),
    });
  }
  const maintenance = validateMaintenanceTaskGraphIfPresent(state);
  const archivedAuditCount = args.skipArchiveAudit ? null : auditArchivedIterations(state.currentSpec, state.artifactRoot);

  const statusCounts = countStatuses(taskGraph.tasks);
  console.log(`Plan2Agent iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- spec: approved=${spec.approval}`);
  console.log(`- task graph: ${taskGraph.tasks.length} task(s), todo ${statusCounts.todo}·in_progress ${statusCounts.in_progress}·done ${statusCounts.done}·blocked ${statusCounts.blocked}`);
  console.log('- planning validation: passed');
  if (args.requireCloseReady) console.log('- close-ready: all tasks done');
  if (maintenance) console.log(`- maintenance: ${maintenance.graph.tasks.length} task(s) valid`);
  if (archivedAuditCount !== null) console.log(`- archived audit: ${archivedAuditCount} closed iteration(s) verified`);
  else console.log('- archived audit: skipped');
  return 0;
}

function closeLocked(args, artifactRoot) {
  const requestedIteration = args.iterationIdProvided ? args.iterationId : 'active';
  if (requestedIteration !== 'active') assertSafeIterationId(requestedIteration);

  const facts = loadReadyIterationFacts(artifactRoot);
  assertCloseReadyTasks(facts.taskGraph);
  validateCloseReadyVisualEvidence({
    artifactRoot,
    activeIteration: facts.state.activeIteration,
    taskGraphPath: facts.state.taskGraphPath,
    taskGraph: facts.taskGraph,
    reviewPasses: projectReviewPasses(),
  });
  const activeMetadata = loadOptionalIterationMetadata(artifactRoot, facts.state.activeIteration);
  const planningMemory = activeMetadata?.planning_memory ?? null;
  const planningMemoryErrors = planningMemoryValidationErrors(planningMemory, artifactRoot, facts.state.projectId, activeMetadata?.idea);
  if (planningMemory?.status === 'pending') planningMemoryErrors.push('planning_memory.status must be resolved before close');
  if (planningMemoryErrors.length) {
    throw new ValidationError(`planning Memory validation failed: ${planningMemoryErrors.join('; ')}`);
  }
  const intakePath = activeIntakePath(facts.state);
  if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, artifactRoot);
  validatePlanningMemoryEvidence(planningMemory, facts.spec, facts.state.specPath, artifactRoot);

  if (requestedIteration !== 'active' && requestedIteration !== facts.state.activeIteration) {
    throw new Error(`close currently supports only active iteration ${JSON.stringify(facts.state.activeIteration)}, got ${JSON.stringify(requestedIteration)}`);
  }

  const closedAt = new Date().toISOString();
  const record = closeRecord(
    facts.state.activeIteration,
    closedAt,
    facts.taskGraph,
    facts.state.currentSpec.effective_spec_ref,
    artifactRoot,
  );
  const memoryConfiguration = planningMemoryConfiguration({ projectRoot: ROOT });
  const initialMemoryFreshness = {
    status: memoryConfiguration.configured ? 'unchecked' : 'not_configured',
    report_ref: memoryConfiguration.configured
      ? artifactRelativePath(artifactRoot, path.join(facts.state.iterationRoot, 'memory-status.json'))
      : null,
    detail: memoryConfiguration.configured
      ? 'Automatic close-time Memory check has not completed.'
      : memoryConfiguration.reason,
  };
  const initialMetadata = iterationMetadataForClose(
    activeMetadata,
    facts.state.projectId,
    facts.state.activeIteration,
    closedAt,
    record,
    initialMemoryFreshness,
  );

  const metadataPath = iterationMetadataPath(
    artifactRoot,
    facts.state.activeIteration,
  );
  const memoryStatusPath = path.join(facts.state.iterationRoot, 'memory-status.json');
  const nextCurrentSpec = currentSpecForClose(facts.state.currentSpec, facts.state.activeIteration, record);
  const statusPath = path.join(artifactRoot, 'status.md');
  const nextStatus = renderIterationIndexMarkdown(artifactRoot, nextCurrentSpec);
  let memoryFreshness;
  withIterationCloseRollback({
    metadataPath,
    currentSpecPath: facts.state.currentSpecPath,
    statusPath,
    memoryStatusPath,
  }, () => {
    atomicWriteJson(metadataPath, initialMetadata);
    atomicWriteJson(facts.state.currentSpecPath, nextCurrentSpec);
    atomicWriteText(statusPath, nextStatus);

    memoryFreshness = checkMemoryAtClose({
      artifactRoot,
      iterationRoot: facts.state.iterationRoot,
      configuration: memoryConfiguration,
    });
    atomicWriteJson(
      metadataPath,
      iterationMetadataForClose(
        activeMetadata,
        facts.state.projectId,
        facts.state.activeIteration,
        closedAt,
        record,
        memoryFreshness,
      ),
    );
  });

  console.log(`Plan2Agent iteration closed: ${toRelativeFromRoot(facts.state.iterationRoot)}`);
  console.log(`- active iteration: ${facts.state.activeIteration}`);
  console.log(`- status: archived`);
  console.log(`- closed_at: ${closedAt}`);
  if (memoryFreshness.status_command) {
    console.log(`- Memory push preview: ${memoryFreshness.push_preview_command}`);
    console.log(`- Memory freshness: ${memoryFreshness.status} (${memoryFreshness.detail})`);
    console.log(`- Memory freshness report: ${memoryFreshness.report_ref}`);
    console.log(`- Memory freshness recheck (run after any approved push): ${memoryFreshness.status_command}`);
    console.log('- Memory push remains an explicit external write; use memory push --yes only with user approval, then rerun the freshness check.');
    if (memoryFreshness.status === 'unavailable') {
      console.warn('WARNING: Memory server connection failed at iteration close. This iteration was archived, but its Memory sync could not be verified.');
    } else if (memoryFreshness.status === 'stale') {
      console.warn('WARNING: Memory is reachable, but this iteration is not fully synchronized. Review the push preview before an approved push.');
    }
  } else {
    console.log(`- Memory freshness: not configured (${memoryFreshness.detail})`);
  }
  if (['failed', 'skipped'].includes(planningMemory?.status)) {
    console.warn(`WARNING: Planning Memory recall ended as ${planningMemory.status}; historical Memory evidence was not fully consulted.`);
  }
  console.log('Active pointer remains on the closed baseline so `p2a iteration open` can create the next iteration.');
  return 0;
}

function close(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const initialState = resolveIterationState(artifactRoot, { requireReady: false });
  return withRunStoreLocks(
    [
      artifactStateLockDir(artifactRoot),
      path.dirname(initialState.taskGraphPath),
      path.join(artifactRoot, 'runs'),
    ],
    () => {
      const lockedState = resolveIterationState(artifactRoot, { requireReady: false });
      if (
        lockedState.activeIteration !== initialState.activeIteration
        || path.resolve(lockedState.taskGraphPath)
          !== path.resolve(initialState.taskGraphPath)
      ) {
        throw new ValidationError(
          'active iteration changed while close was waiting for state locks; retry the command',
        );
      }
      return closeLocked(args, artifactRoot);
    },
  );
}

function activeSpecArtifacts(artifactRoot, iterationId) {
  const iterationRoot = path.join(artifactRoot, 'iterations', iterationId);
  return {
    spec_ref: sourceSpecRef(iterationId),
    product_spec_ref: artifactRelativePath(artifactRoot, path.join(iterationRoot, 'gate-b-spec', 'product-spec.md')),
    implementation_plan_ref: artifactRelativePath(artifactRoot, path.join(iterationRoot, 'gate-b-spec', 'implementation-plan.md')),
  };
}

function promoteSpecLocked(args, artifactRoot) {
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  const spec = validateActiveSpecWithOptionalIntake(state);
  const metadata = loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration);
  const planningMemory = metadata?.planning_memory ?? null;
  const planningMemoryErrors = planningMemoryValidationErrors(planningMemory, state.artifactRoot, state.projectId, metadata?.idea);
  if (planningMemory?.status === 'pending') planningMemoryErrors.push('planning_memory.status must be resolved before Gate B promotion');
  if (planningMemoryErrors.length) {
    throw new ValidationError(`planning Memory validation failed: ${planningMemoryErrors.join('; ')}`);
  }
  const intakePath = activeIntakePath(state);
  if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, state.artifactRoot);
  validatePlanningMemoryEvidence(planningMemory, spec, state.specPath, state.artifactRoot);
  if (spec.approval !== 'approved') {
    throw new ValidationError(`promote-spec requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError('promote-spec requires spec.open_decisions to be empty');
  }

  const promotedAt = new Date().toISOString();
  const artifacts = activeSpecArtifacts(state.artifactRoot, state.activeIteration);
  const gateBApprovalAudit = gateBApprovalAuditForIteration(
    spec.approval_audit,
    state.activeIteration,
    'Gate B approval recorded by p2a iteration promote-spec after approved spec with no open decisions.',
  );
  const nextCurrentSpec = currentSpecForPromotedSpec(
    state.currentSpec,
    state.activeIteration,
    promotedAt,
    artifacts,
    gateBApprovalAudit,
  );
  const metadataPath = iterationMetadataPath(
    state.artifactRoot,
    state.activeIteration,
  );
  const statusPath = path.join(state.artifactRoot, 'status.md');
  const nextStatus = renderIterationIndexMarkdown(
    state.artifactRoot,
    nextCurrentSpec,
  );
  const stateSnapshot = captureRollbackFiles([
    state.currentSpecPath,
    metadataPath,
    statusPath,
  ]);
  try {
    atomicWriteJson(state.currentSpecPath, nextCurrentSpec);
    atomicWriteJson(
      metadataPath,
      iterationMetadataForPromotedSpec(
        metadata,
        state.projectId,
        state.activeIteration,
        promotedAt,
        artifacts,
      ),
    );
    atomicWriteText(statusPath, nextStatus);
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(stateSnapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; Gate B promotion rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }

  const promotedState = resolveIterationState(artifactRoot, { requireReady: false });
  console.log(`Plan2Agent active spec promoted: ${toRelativeFromRoot(state.specPath)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- approval: ${spec.approval}`);
  console.log(`- effective spec: ${promotedState.currentSpec.effective_spec_ref ?? 'unchanged'}`);
  return 0;
}

function promoteSpec(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  return withRunStoreLocks(
    [artifactStateLockDir(artifactRoot)],
    () => promoteSpecLocked(args, artifactRoot),
  );
}

function canonicalDraftVersion(version) {
  return typeof version === 'string' && version.endsWith('-draft')
    ? version.slice(0, -'-draft'.length)
    : version;
}

function activeIterationRunHistory(state) {
  const runIndexPath = path.join(state.artifactRoot, 'runs', 'run-index.json');
  if (!existsSync(runIndexPath)) return [];
  const runIndex = validateRunIndexData(loadJson(runIndexPath));
  if (runIndex.projectId !== state.projectId) {
    throw new ValidationError(`run-index projectId must match active project ${state.projectId}`);
  }
  return runIndex.runs.filter((entry) => entry.iterationId === state.activeIteration);
}

function assertNoTaskGraphExecutionHistory(state, operation) {
  const runHistory = activeIterationRunHistory(state);
  if (!runHistory.length) return;
  const examples = runHistory.slice(0, 5).map((entry) => `${entry.runId}:${entry.status}`).join(', ');
  throw new ValidationError(
    `${operation} cannot replace a task graph after execution history exists; run(s): ${examples}. ` +
    'Preserve run lineage by opening a new feature iteration or using the maintenance lane',
  );
}

function promoteTasksLocked(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const metadata = loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration);
  assertActivePlanningBaselineContract(state, metadata);
  const planningMemory = metadata?.planning_memory ?? null;
  const planningMemoryErrors = planningMemoryValidationErrors(planningMemory, state.artifactRoot, state.projectId, metadata?.idea);
  if (planningMemory?.status === 'pending') planningMemoryErrors.push('planning_memory.status must be resolved before Gate C promotion');
  if (planningMemoryErrors.length) {
    throw new ValidationError(`planning Memory validation failed: ${planningMemoryErrors.join('; ')}`);
  }
  const intakePath = activeIntakePath(state);
  if (existsSync(intakePath)) validatePlanningMemoryEvidence(planningMemory, loadJson(intakePath), intakePath, state.artifactRoot);
  if (existsSync(state.specPath)) validatePlanningMemoryEvidence(planningMemory, loadJson(state.specPath), state.specPath, state.artifactRoot);
  const draftPath = gateCTaskGraphDraftPath(state);
  if (!existsSync(draftPath)) throw new ValidationError(`gate-c draft not found; author one at ${draftPath} first`);
  const draft = loadJson(draftPath);
  validateTaskGraphData(draft, state.specPath);
  const preExecutedDraftTasks = draft.tasks.filter((task) => task.status !== 'todo');
  if (preExecutedDraftTasks.length) {
    throw new ValidationError(
      `Gate C draft tasks must all start as todo; non-todo task(s): ${preExecutedDraftTasks.map((task) => `${task.id}:${task.status}`).join(', ')}`,
    );
  }
  if (existsSync(state.taskGraphPath) && !args.replaceExisting) {
    throw new ValidationError(
      'canonical task graph already exists; refusing to replace it with a potentially incremental-only draft. ' +
      'Generate and validate a complete replacement with diff-tasks --force, then rerun promote-tasks with --replace-existing',
    );
  }
  if (existsSync(state.taskGraphPath) && args.replaceExisting) {
    const existingTaskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
    const startedTasks = existingTaskGraph.tasks.filter((task) => task.status !== 'todo');
    if (startedTasks.length) {
      throw new ValidationError(
        `cannot replace a canonical task graph after execution has started; non-todo task(s): ${startedTasks.map((task) => `${task.id}:${task.status}`).join(', ')}. ` +
        'Preserve run lineage by opening a new feature iteration or using the maintenance lane',
      );
    }
    assertNoTaskGraphExecutionHistory(state, 'promote-tasks --replace-existing');
  }
  const promotedAt = new Date().toISOString();
  const nextCurrentSpec = state.currentSpec;
  const metaPath = gateCTaskGraphDraftMetaPath(state);
  const promoted = {
    ...draft,
    version: canonicalDraftVersion(draft.version),
  };
  const promotedDraftPath = `${draftPath}.promoted`;
  const statusPath = path.join(state.artifactRoot, 'status.md');
  const stateSnapshot = captureRollbackFiles([
    metaPath,
    state.taskGraphPath,
    draftPath,
    promotedDraftPath,
    statusPath,
  ]);
  try {
    atomicWriteJson(
      metaPath,
      taskDraftProvenance(
        { ...state, currentSpec: nextCurrentSpec },
        draftPath,
        promotedAt,
      ),
    );
    atomicWriteJson(state.taskGraphPath, promoted);
    renameSync(draftPath, promotedDraftPath);
    const nextStatus = renderIterationIndexMarkdown(
      state.artifactRoot,
      nextCurrentSpec,
    );
    atomicWriteText(statusPath, nextStatus);
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(stateSnapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; Gate C promotion rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }

  console.log(`Plan2Agent tasks promoted: ${promoted.tasks.length} task(s)`);
  console.log(`- graph: ${toRelativeFromRoot(state.taskGraphPath)}`);
  console.log('- promoted from: task-graph.draft.json');
  console.log(`- provenance: ${toRelativeFromRoot(metaPath)}`);
  return 0;
}

function promoteTasks(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const lockDirs = [
    artifactStateLockDir(state.artifactRoot),
    path.dirname(state.taskGraphPath),
  ];
  if (args.replaceExisting) lockDirs.push(path.join(state.artifactRoot, 'runs'));
  return withRunStoreLocks(lockDirs, () => {
    const lockedState = resolveIterationState(args.artifacts, { requireReady: false });
    if (
      lockedState.activeIteration !== state.activeIteration
      || path.resolve(lockedState.taskGraphPath) !== path.resolve(state.taskGraphPath)
    ) {
      throw new ValidationError(
        'active iteration changed while promote-tasks was waiting for state locks; retry the command',
      );
    }
    return promoteTasksLocked(args);
  });
}

const MILESTONE_DRAFT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertUniqueMilestoneDraftPath(draftPath, reviewDir, checkpoint) {
  if (path.dirname(draftPath) !== reviewDir) {
    throw new ValidationError(`milestone draft must be a direct child of ${reviewDir}`);
  }
  const filename = path.basename(draftPath);
  const prefix = `${checkpoint}.`;
  const suffix = '.draft.json';
  const token = filename.startsWith(prefix) && filename.endsWith(suffix)
    ? filename.slice(prefix.length, -suffix.length)
    : '';
  if (!MILESTONE_DRAFT_TOKEN_PATTERN.test(token)) {
    throw new ValidationError(
      `milestone draft must use unique filename ${checkpoint}.<id>.draft.json; got ${filename}`,
    );
  }
}

export function promoteMilestoneDraftAtomically(draftPath, stablePath, operations = { linkSync, unlinkSync }) {
  const link = operations.linkSync ?? linkSync;
  const unlink = operations.unlinkSync ?? unlinkSync;
  try {
    link(draftPath, stablePath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ValidationError(`milestone checkpoint already exists and will not be overwritten: ${stablePath}`);
    }
    throw error;
  }

  try {
    unlink(draftPath);
    return { draftRemoved: true, cleanupError: null };
  } catch (cleanupError) {
    try {
      unlink(stablePath);
    } catch (rollbackError) {
      throw new ValidationError(
        `milestone promotion cleanup failed and rollback could not remove the stable checkpoint: cleanup=${cleanupError?.message ?? cleanupError}; rollback=${rollbackError?.message ?? rollbackError}`,
      );
    }
    throw new ValidationError(
      `milestone promotion rolled back because unique draft cleanup failed: ${cleanupError?.message ?? cleanupError}`,
    );
  }
}

function promoteMilestone(args) {
  const initialState = resolveIterationState(args.artifacts, { requireReady: false });
  const initialReviewDir = path.resolve(initialState.iterationRoot, 'milestone-reviews');
  return withRunStoreLocks(
    [
      artifactStateLockDir(initialState.artifactRoot),
      initialReviewDir,
    ],
    () => {
      const state = resolveIterationState(args.artifacts, { requireReady: false });
      const reviewDir = path.resolve(state.iterationRoot, 'milestone-reviews');
      if (
        state.activeIteration !== initialState.activeIteration
        || reviewDir !== initialReviewDir
      ) {
        throw new ValidationError(
          'active iteration changed while milestone promotion was waiting for state locks; retry the command',
        );
      }
      assertActivePlanningBaselineContract(state);
      const draftPath = path.resolve(process.cwd(), args.milestoneDraft);
      if (path.dirname(draftPath) !== reviewDir) {
        throw new ValidationError(`milestone draft must be a direct child of ${reviewDir}`);
      }
      if (!existsSync(draftPath)) throw new ValidationError(`milestone draft not found: ${draftPath}`);
      if (!lstatSync(draftPath).isFile()) throw new ValidationError(`milestone draft must be a regular file: ${draftPath}`);

      const review = validateMilestoneReview(draftPath, {
        artifactRoot: state.artifactRoot,
        expectedProjectId: state.projectId,
        expectedIterationId: state.activeIteration,
      });
      if (review.project_id !== state.projectId) {
        throw new ValidationError(`milestone review project_id must be ${state.projectId}, got ${review.project_id}`);
      }
      if (review.iteration_id !== state.activeIteration) {
        throw new ValidationError(`milestone review iteration_id must be ${state.activeIteration}, got ${review.iteration_id}`);
      }
      assertUniqueMilestoneDraftPath(draftPath, reviewDir, review.checkpoint);

      const stablePath = path.join(reviewDir, `${review.checkpoint}.json`);
      promoteMilestoneDraftAtomically(draftPath, stablePath);
      console.log(`Plan2Agent milestone review promoted: ${toRelativeFromRoot(stablePath)}`);
      console.log(`- checkpoint: ${review.checkpoint}`);
      console.log(`- promoted from: ${toRelativeFromRoot(draftPath)}`);
      return 0;
    },
  );
}

function loadDiffBaseline(state) {
  const activeSpecRef = sourceSpecRef(state.activeIteration);
  const pendingBaselineRef = state.currentSpec.pending_iteration?.baseline_effective_spec_ref;
  let baselineRef = pendingBaselineRef && normalizeDisplayPath(pendingBaselineRef) !== activeSpecRef
    ? pendingBaselineRef
    : null;
  if (!baselineRef && state.currentSpec.effective_spec_ref && normalizeDisplayPath(state.currentSpec.effective_spec_ref) !== activeSpecRef) {
    baselineRef = state.currentSpec.effective_spec_ref;
  }
  if (!baselineRef) return { baselineSpec: null, baselineRef: null };

  const baselinePath = resolveArtifactFileReference(baselineRef, state.artifactRoot);
  assertFile(baselinePath, `diff baseline ${baselineRef}`);
  return {
    baselineSpec: loadEffectiveBaselineSpec(baselinePath, state.artifactRoot),
    baselineRef,
  };
}

function loadExistingTaskGraphIfPresent(taskGraphPath) {
  if (!existsSync(taskGraphPath)) return null;
  const graph = loadJson(taskGraphPath);
  validateTaskGraphData(graph);
  return graph;
}

function historicalCompletedTasks(state) {
  const tasks = [];
  const seenGraphRefs = new Set();
  const addTasksFromGraphRef = (graphRef, iterationId) => {
    if (!graphRef || seenGraphRefs.has(graphRef)) return;
    seenGraphRefs.add(graphRef);
    const graphPath = resolveArtifactFileReference(graphRef, state.artifactRoot);
    if (!existsSync(graphPath) || !lstatSync(graphPath).isFile()) return;
    const graph = loadJson(graphPath);
    validateTaskGraphData(graph);
    for (const task of graph.tasks ?? []) {
      if (task.status === 'done') tasks.push({ ...task, iterationId });
    }
  };

  for (const closed of state.currentSpec.closed_iterations ?? []) {
    const iterationId = closed?.iteration_id;
    if (!iterationId) continue;
    addTasksFromGraphRef(closed.task_graph_ref ?? taskGraphRef(iterationId), iterationId);
  }
  for (const source of state.currentSpec.source_specs ?? []) {
    const iterationId = source?.iteration_id;
    if (!iterationId) continue;
    addTasksFromGraphRef(taskGraphRef(iterationId), iterationId);
  }
  return tasks;
}

function semanticGraphStats(graph) {
  const tasks = graph.tasks ?? [];
  return {
    groups: normalizeRefs(tasks.map((task) => task.targetArea)),
    rework: tasks.filter((task) => task.title.startsWith('Rework ') || task.description.includes('Rework previous completed task')).length,
    reused: tasks.filter((task) => task.description.includes('Reuses existing active task id')).length,
  };
}

function diffTasksLocked(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  const activeSpec = validateActiveSpecWithOptionalIntake(state);
  if (activeSpec.approval !== 'approved') {
    throw new ValidationError(`diff-tasks requires approved active spec, got ${JSON.stringify(activeSpec.approval)}`);
  }
  if (activeSpec.open_decisions.length) {
    throw new ValidationError('diff-tasks requires active spec.open_decisions to be empty');
  }

  const draftPath = gateCTaskGraphDraftPath(state);
  if (existsSync(draftPath) && !args.force) {
    throw new Error(`task graph draft already exists: ${draftPath}; use --force to overwrite`);
  }
  if (existsSync(state.taskGraphPath) && !args.force) {
    throw new Error(`canonical task graph already exists: ${state.taskGraphPath}; use --force to create a replacement draft`);
  }
  const { baselineSpec, baselineRef } = loadDiffBaseline(state);
  const existingTaskGraph = args.force ? loadExistingTaskGraphIfPresent(state.taskGraphPath) : null;
  if (existingTaskGraph) {
    const startedTasks = existingTaskGraph.tasks.filter((task) => task.status !== 'todo');
    if (startedTasks.length) {
      throw new ValidationError(
        `diff-tasks --force cannot replace a task graph after execution has started; non-todo task(s): ${startedTasks.map((task) => `${task.id}:${task.status}`).join(', ')}. ` +
        'Open a new feature iteration or use the maintenance lane instead',
      );
    }
    assertNoTaskGraphExecutionHistory(state, 'diff-tasks --force');
  }
  const graph = taskGraphFromSpecChanges({
    projectId: state.projectId,
    iterationId: state.activeIteration,
    activeSpec,
    baselineSpec,
    baselineRef,
    existingTaskGraph,
    historicalTasks: historicalCompletedTasks(state),
    visualContract: approvedVisualReviewContract(state.specPath, state.artifactRoot),
  });
  const draft = {
    ...graph,
    version: typeof graph.version === 'string' && graph.version.endsWith('-draft')
      ? graph.version
      : `${graph.version}-draft`,
  };
  validateTaskGraphData(draft, state.specPath);
  mkdirSync(path.dirname(draftPath), { recursive: true });
  atomicWriteJson(draftPath, draft);

  const stats = semanticGraphStats(draft);
  console.log(`Plan2Agent diff task graph draft generated: ${toRelativeFromRoot(draftPath)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- baseline: ${baselineRef ?? 'none'}`);
  console.log(`- semantic groups: ${stats.groups.join(', ')}`);
  console.log(`- rework groups: ${stats.rework}`);
  console.log(`- reused active tasks: ${stats.reused}`);
  console.log(`- tasks: ${draft.tasks.length}`);
  return 0;
}

function diffTasks(args) {
  const initialState = resolveIterationState(args.artifacts, { requireReady: false });
  const lockDirs = [
    artifactStateLockDir(initialState.artifactRoot),
    path.dirname(initialState.taskGraphPath),
  ];
  if (args.force) lockDirs.push(path.join(initialState.artifactRoot, 'runs'));
  return withRunStoreLocks(lockDirs, () => {
    const state = resolveIterationState(args.artifacts, { requireReady: false });
    if (
      state.activeIteration !== initialState.activeIteration
      || path.resolve(state.taskGraphPath) !== path.resolve(initialState.taskGraphPath)
    ) {
      throw new ValidationError(
        'active iteration changed while diff-tasks was waiting for state locks; retry the command',
      );
    }
    return diffTasksLocked(args);
  });
}

const PLANNING_MEMORY_STATUSES = new Set([
  'not_configured',
  'pending',
  'succeeded',
  'fallback',
  'failed',
  'skipped',
]);
const MEMORY_FRESHNESS_STATUSES = new Set(['fresh', 'stale', 'unavailable', 'unchecked']);
const PLANNING_MEMORY_SEARCH_MODES = new Set(['keyword', 'semantic', 'hybrid']);
const PLANNING_MEMORY_SERVER_STATUSES = new Set(['up', 'unknown', 'unavailable', 'not_configured']);
const CROSS_PROJECT_RECALL_PATTERN = /\b(?:architecture|protocol|migration|migrate|authentication|authorization|auth|security|integration|external api|database|storage|queue|performance|reliability|failure|incident)\b|(?:아키텍처|프로토콜|마이그레이션|인증|인가|보안|연동|통합|외부\s*API|데이터베이스|저장소|큐|성능|신뢰성|장애|실패)/i;

function projectReviewPasses(projectRoot = ROOT) {
  const configPath = path.join(projectRoot, '.plan2agent', 'project.config.json');
  if (!existsSync(configPath)) return resolveReviewPasses({});
  try {
    return resolveReviewPasses(loadJson(configPath));
  } catch (error) {
    throw new ValidationError(`project config review pass policy is invalid: ${error.message}`);
  }
}

function planningMemoryConfiguration(options) {
  const projectRoot = options.projectRoot ?? ROOT;
  const configPath = path.join(projectRoot, '.plan2agent', 'project.config.json');
  if (!existsSync(configPath)) return { enabled: false, configured: false, reason: 'project_config_missing' };
  let config;
  try {
    config = loadJson(configPath);
  } catch {
    return { enabled: false, configured: false, reason: 'project_config_invalid' };
  }
  const memory = config?.memory;
  if (!memory || typeof memory !== 'object' || Array.isArray(memory) || memory.enabled !== true) {
    return { enabled: false, configured: false, reason: 'memory_disabled' };
  }
  const serverUrlEnv = typeof memory.serverUrlEnv === 'string' && memory.serverUrlEnv.trim()
    ? memory.serverUrlEnv.trim()
    : 'P2A_MEMORY_URL';
  const configuredServer = typeof memory.serverUrl === 'string' && memory.serverUrl.trim()
    ? memory.serverUrl.trim()
    : null;
  const environment = options.environment ?? process.env;
  const environmentServer = typeof environment[serverUrlEnv] === 'string' && environment[serverUrlEnv].trim()
    ? environment[serverUrlEnv].trim()
    : null;
  const configuredTimeoutMs = Number(memory.requestTimeoutMs);
  const requestTimeoutMs = Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_MEMORY_REQUEST_TIMEOUT_MS;
  if (!configuredServer && !environmentServer) {
    return {
      enabled: true,
      configured: false,
      reason: `server_missing:${serverUrlEnv}`,
      serverUrlEnv,
      requestTimeoutMs,
    };
  }
  return {
    enabled: true,
    configured: true,
    reason: null,
    serverUrlEnv,
    server: configuredServer ?? environmentServer,
    requestTimeoutMs,
  };
}

function planningMemoryDisplayPath(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  return normalizeDisplayPath(relative || '.');
}

function planningMemorySearchCommand({
  projectRoot,
  projectId,
  idea,
  outputPath,
  global = false,
}) {
  const command = [
    'p2a',
    'memory',
    'search',
    ...(global
      ? ['--global', '--exclude-project', projectId]
      : ['--project', projectId]),
    '--mode',
    'hybrid',
    '--query',
    idea,
    '--output',
    planningMemoryDisplayPath(projectRoot, outputPath),
  ];
  return command.map((value) => shellQuote(String(value))).join(' ');
}

export function planningMemoryCrossProjectReason(idea) {
  const match = String(idea ?? '').match(CROSS_PROJECT_RECALL_PATTERN);
  return match
    ? `Reusable concern detected in the iteration idea: ${match[0]}`
    : null;
}

export function memoryFreshnessFromStatusReport(report, expectedContext = {}) {
  if (!report || typeof report !== 'object') return { status: 'unchecked', detail: 'No Memory status report was found.' };
  if (report.schema_version !== 'p2a.memory_status.v1') {
    return { status: 'unavailable', detail: `Unsupported Memory status report schema: ${report.schema_version ?? 'missing'}` };
  }
  if (report.server?.status !== 'up') {
    return { status: 'unavailable', detail: `Memory server status was ${report.server?.status ?? 'unknown'}.` };
  }
  const context = report.context && typeof report.context === 'object' && !Array.isArray(report.context)
    ? report.context
    : null;
  if (expectedContext.projectId) {
    const actualProjectId = context?.sourceProjectId ?? context?.projectId ?? null;
    if (actualProjectId !== expectedContext.projectId) {
      return {
        status: 'unavailable',
        detail: `Memory status report project context mismatch: expected ${expectedContext.projectId}, got ${actualProjectId ?? 'missing'}.`,
      };
    }
  }
  if (expectedContext.iterationId && context?.iterationId !== expectedContext.iterationId) {
    return {
      status: 'unavailable',
      detail: `Memory status report iteration context mismatch: expected ${expectedContext.iterationId}, got ${context?.iterationId ?? 'missing'}.`,
    };
  }
  const summary = report.sync?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return { status: 'unavailable', detail: 'Memory status report sync.summary is missing or invalid.' };
  }
  for (const field of ['synced', 'missingRemote', 'remoteDiffers', 'extraRemote']) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      return {
        status: 'unavailable',
        detail: `Memory status report sync.summary.${field} must be a non-negative integer.`,
      };
    }
  }
  if (!Array.isArray(report.skippedRuns) || !Array.isArray(report.skippedProposals)) {
    return { status: 'unavailable', detail: 'Memory status report skippedRuns and skippedProposals must be arrays.' };
  }
  const skippedRuns = report.skippedRuns.length;
  const skippedProposals = report.skippedProposals.length;
  const missingRemote = summary.missingRemote;
  const remoteDiffers = summary.remoteDiffers;
  if (missingRemote > 0 || remoteDiffers > 0 || skippedRuns > 0 || skippedProposals > 0) {
    return {
      status: 'stale',
      detail: `missingRemote=${missingRemote} remoteDiffers=${remoteDiffers} skippedRuns=${skippedRuns} skippedProposals=${skippedProposals}`,
    };
  }
  return { status: 'fresh', detail: 'Local planning artifacts matched Memory at the recorded status check.' };
}

function closeMemoryCommands(artifactRoot, memoryStatusPath, requestTimeoutMs) {
  const statusCommand = [
    'p2a',
    'memory',
    'status',
    '--artifacts',
    planningMemoryDisplayPath(ROOT, artifactRoot),
    '--timeout-ms',
    String(requestTimeoutMs),
    '--output',
    planningMemoryDisplayPath(ROOT, memoryStatusPath),
  ].map((value) => shellQuote(String(value))).join(' ');
  const pushPreviewCommand = [
    'p2a',
    'memory',
    'push',
    '--artifacts',
    planningMemoryDisplayPath(ROOT, artifactRoot),
    '--dry-run',
  ].map((value) => shellQuote(String(value))).join(' ');
  return { statusCommand, pushPreviewCommand };
}

function failedCloseMemoryStatusReport(projectId, iterationId, server, timeoutMs, operationTimeoutMs, detail) {
  return {
    schema_version: 'p2a.memory_status.v1',
    generatedAt: new Date().toISOString(),
    context: {
      projectId,
      sourceProjectId: projectId,
      canonicalProjectId: null,
      iterationId,
      sourceKind: 'artifacts',
      sourcePath: null,
    },
    server: {
      url: server,
      source: 'iteration_close',
      timeoutMs,
      operationTimeoutMs,
      status: 'unavailable',
      detail,
    },
    local: null,
    sync: {
      summary: { synced: 0, missingRemote: 0, remoteDiffers: 0, extraRemote: 0 },
      items: [],
      extraRemote: [],
    },
    skippedRuns: [],
    skippedProposals: [],
    nextActions: ['Restore Memory connectivity, then rerun the recorded freshness check.'],
  };
}

export function checkMemoryAtClose(options) {
  const artifactRoot = path.resolve(options.artifactRoot);
  const iterationRoot = path.resolve(options.iterationRoot);
  const configuration = options.configuration ?? planningMemoryConfiguration({
    projectRoot: options.projectRoot ?? ROOT,
    environment: options.environment,
  });
  const memoryStatusPath = path.join(iterationRoot, 'memory-status.json');
  if (!configuration.configured) {
    return {
      status: 'not_configured',
      report_ref: null,
      checked_at: null,
      status_command: null,
      push_preview_command: null,
      detail: configuration.reason,
    };
  }

  const requestTimeoutMs = configuration.requestTimeoutMs ?? DEFAULT_MEMORY_REQUEST_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs
    ?? Math.max(DEFAULT_MEMORY_CLOSE_TIMEOUT_MS, requestTimeoutMs + 1000);
  const { statusCommand, pushPreviewCommand } = closeMemoryCommands(artifactRoot, memoryStatusPath, requestTimeoutMs);
  const memoryScriptPath = options.memoryScriptPath ?? path.join(P2A_PATHS.scriptsDir, 'p2a_memory.mjs');
  const temporaryStatusPath = path.join(
    iterationRoot,
    `.memory-status.${process.pid}.${Date.now()}.tmp.json`,
  );
  const runner = options.runner ?? spawnSync;
  let result;
  try {
    result = runner(process.execPath, [
      memoryScriptPath,
      'status',
      '--artifacts',
      artifactRoot,
      '--server',
      configuration.server,
      '--timeout-ms',
      String(requestTimeoutMs),
      '--output',
      temporaryStatusPath,
    ], {
      cwd: options.projectRoot ?? ROOT,
      encoding: 'utf8',
      env: options.environment ?? process.env,
      timeout: operationTimeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    result = { status: 1, error, stdout: '', stderr: '' };
  }

  const runnerCompleted = !result?.error
    && !result?.signal
    && Number.isInteger(result?.status)
    && [0, 1].includes(result.status);
  let report = runnerCompleted ? loadJsonIfPresent(temporaryStatusPath) : null;
  if (!report) {
    const stderr = String(result?.stderr ?? '').trim();
    const detail = result?.error?.code === 'ETIMEDOUT'
      ? `Memory status check exceeded its ${operationTimeoutMs}ms close-time limit.`
      : (result?.error?.message
        || stderr
        || (result?.signal
          ? `Memory status check was terminated by ${result.signal}.`
          : `Memory status check exited with ${result?.status ?? 'unknown'}.`));
    report = failedCloseMemoryStatusReport(
      path.basename(artifactRoot),
      path.basename(iterationRoot),
      configuration.server,
      requestTimeoutMs,
      operationTimeoutMs,
      detail,
    );
  }
  try {
    atomicWriteJson(memoryStatusPath, report);
  } finally {
    if (existsSync(temporaryStatusPath)) unlinkSync(temporaryStatusPath);
  }

  const freshness = memoryFreshnessFromStatusReport(report, {
    projectId: options.projectId ?? path.basename(artifactRoot),
    iterationId: options.iterationId ?? path.basename(iterationRoot),
  });
  const detail = freshness.status === 'unavailable' && report.server?.detail
    ? String(report.server.detail)
    : freshness.detail;
  return {
    status: freshness.status,
    report_ref: artifactRelativePath(artifactRoot, memoryStatusPath),
    checked_at: report.generatedAt ?? new Date().toISOString(),
    status_command: statusCommand,
    push_preview_command: pushPreviewCommand,
    check_exit_code: Number.isInteger(result?.status) ? result.status : 1,
    operation_timeout_ms: operationTimeoutMs,
    detail,
  };
}

function loadJsonIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return loadJson(filePath);
  } catch {
    return null;
  }
}

export function planningMemoryRecallPlan(options) {
  const projectRoot = options.projectRoot ?? ROOT;
  const artifactRoot = options.artifactRoot ?? path.resolve(options.iterationRoot, '..', '..');
  const configuration = planningMemoryConfiguration({ ...options, projectRoot });
  const projectReportPath = path.join(options.iterationRoot, 'gate-a-intake', 'memory-recall.json');
  const crossProjectReportPath = path.join(options.iterationRoot, 'gate-a-intake', 'memory-recall-cross-project.json');
  const crossProjectReason = planningMemoryCrossProjectReason(options.idea);
  const previousStatusPath = options.previousIterationId
    ? path.join(artifactRoot, 'iterations', options.previousIterationId, 'memory-status.json')
    : null;
  const previousStatusReport = previousStatusPath ? loadJsonIfPresent(previousStatusPath) : null;
  const baselineFreshness = {
    ...memoryFreshnessFromStatusReport(previousStatusReport, {
      projectId: options.projectId,
      iterationId: options.previousIterationId,
    }),
    report_ref: previousStatusPath && existsSync(previousStatusPath)
      ? artifactRelativePath(artifactRoot, previousStatusPath)
      : null,
  };
  const configured = configuration.enabled && configuration.configured;
  const projectLayer = {
    scope: 'project',
    status: configured ? 'pending' : 'not_configured',
    query: options.idea,
    requested_mode: 'hybrid',
    report_ref: artifactRelativePath(artifactRoot, projectReportPath),
    command: configured
      ? planningMemorySearchCommand({
          projectRoot,
          projectId: options.projectId,
          idea: options.idea,
          outputPath: projectReportPath,
        })
      : null,
    detail: configuration.reason,
  };
  const crossProjectLayer = {
    scope: 'cross_project',
    required: Boolean(crossProjectReason),
    reason: crossProjectReason,
    status: configured && crossProjectReason
      ? 'pending'
      : configured
        ? 'skipped'
        : 'not_configured',
    query: options.idea,
    requested_mode: 'hybrid',
    exclude_project: options.projectId,
    report_ref: artifactRelativePath(artifactRoot, crossProjectReportPath),
    command: configured && crossProjectReason
      ? planningMemorySearchCommand({
          projectRoot,
          projectId: options.projectId,
          idea: options.idea,
          outputPath: crossProjectReportPath,
          global: true,
        })
      : null,
    detail: configured ? (crossProjectReason ? null : 'No reusable cross-project concern was detected.') : configuration.reason,
  };
  return {
    status: configured ? 'pending' : 'not_configured',
    configured,
    configuration_reason: configuration.reason,
    baseline_freshness: baselineFreshness,
    layers: {
      project: projectLayer,
      cross_project: crossProjectLayer,
    },
  };
}

export function planningMemoryRecallCommand(options) {
  return planningMemoryRecallPlan(options).layers.project.command;
}

function planningMemorySourceReference(result) {
  const reference = result?.sourceReference ?? result?.citation?.sourceReference ?? null;
  if (typeof reference === 'string') return reference.trim() || null;
  if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
    const base = [reference.path, reference.uri, reference.canonicalServerId]
      .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
    const fragment = typeof reference.fragment === 'string' && reference.fragment.trim()
      ? reference.fragment.trim()
      : null;
    if (base) return fragment ? `${base}#${fragment}` : base;
  }
  const fallback = [
    result?.sourcePath,
    result?.lineage?.sourcePath,
    result?.citation?.lineage?.sourcePath,
  ].find((value) => typeof value === 'string' && value.trim());
  return fallback?.trim() ?? null;
}

function planningMemoryResultRef(result) {
  return {
    artifact_type: result?.artifactType ?? null,
    source_path: result?.sourcePath ?? result?.lineage?.sourcePath ?? null,
    source_reference: planningMemorySourceReference(result),
    natural_key: result?.naturalKey ?? result?.metadata?.naturalKey ?? null,
    source_project_id: result?.sourceIds?.sourceProjectId ?? result?.metadata?.sourceProjectId ?? null,
    status: result?.metadata?.status ?? null,
    failure_class: result?.metadata?.failureClass ?? null,
  };
}

function planningMemoryReportErrors(report, layer, projectId) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['report is missing or invalid JSON'];
  if (report.schema_version !== 'p2a.memory_search.v1') errors.push(`schema_version must be p2a.memory_search.v1, got ${report.schema_version ?? 'missing'}`);
  if (!report.server || typeof report.server !== 'object' || Array.isArray(report.server)) {
    errors.push('server must be an object');
  } else if (!PLANNING_MEMORY_SERVER_STATUSES.has(report.server.status)) {
    errors.push(`server.status is invalid: ${report.server.status ?? 'missing'}`);
  }
  if (report.query?.text !== layer.query) errors.push('query.text does not match the iteration idea');
  if (report.query?.mode !== layer.requested_mode) errors.push(`query.mode must be ${layer.requested_mode}`);
  if (!Array.isArray(report.results)) errors.push('results must be an array');
  else if (report.results.some((result) => !result || typeof result !== 'object' || Array.isArray(result))) {
    errors.push('results entries must be objects');
  }
  if (!Number.isInteger(report.summary?.total) || report.summary.total < 0) {
    errors.push('summary.total must be a non-negative integer');
  } else if (Array.isArray(report.results) && report.summary.total !== report.results.length) {
    errors.push('summary.total must match results.length');
  }
  const effectiveMode = report.query?.effectiveMode ?? null;
  if (effectiveMode !== null && !PLANNING_MEMORY_SEARCH_MODES.has(effectiveMode)) {
    errors.push(`query.effectiveMode is invalid: ${effectiveMode}`);
  }
  if (report.server?.status === 'not_configured' && effectiveMode !== null) {
    errors.push('query.effectiveMode must be null when the Memory server is not configured');
  }
  if (
    ['up', 'unknown'].includes(report.server?.status)
    && effectiveMode === null
  ) {
    errors.push('query.effectiveMode is required when the Memory search completed');
  }
  const fallback = report.query?.fallback;
  if (
    fallback !== null
    && fallback !== undefined
    && (
      typeof fallback !== 'object'
      || Array.isArray(fallback)
      || typeof fallback.from !== 'string'
      || typeof fallback.to !== 'string'
    )
  ) {
    errors.push('query.fallback must be null or an object with string from/to fields');
  } else if (fallback && typeof fallback === 'object') {
    if (fallback.from !== layer.requested_mode || fallback.to !== 'keyword') {
      errors.push(`query.fallback must describe ${layer.requested_mode}->keyword`);
    }
    if (fallback.supplemental !== undefined && typeof fallback.supplemental !== 'boolean') {
      errors.push('query.fallback.supplemental must be a boolean when present');
    }
    if (effectiveMode !== null) {
      const expectedEffectiveMode = fallback.supplemental === true ? fallback.from : fallback.to;
      if (effectiveMode !== expectedEffectiveMode) {
        errors.push(`query.effectiveMode must be ${expectedEffectiveMode} for the recorded fallback`);
      }
    }
  } else if (effectiveMode !== null && effectiveMode !== layer.requested_mode) {
    errors.push('query.effectiveMode differs from the requested mode without a fallback');
  }
  if (layer.scope === 'project') {
    if (report.query?.scope !== 'project') errors.push('project recall query.scope must be project');
    const sourceProjectId = report.context?.sourceProjectId ?? report.context?.projectId;
    if (sourceProjectId !== projectId) errors.push(`project recall context must identify ${projectId}`);
  } else {
    if (report.query?.scope !== 'global') errors.push('cross-project recall query.scope must be global');
    if (report.query?.excludeProject !== projectId) errors.push(`cross-project recall must exclude ${projectId}`);
  }
  return errors;
}

function planningMemoryReportPath(artifactRoot, reportRef) {
  if (typeof reportRef !== 'string' || !reportRef.trim()) return null;
  const root = path.resolve(artifactRoot);
  const resolved = path.resolve(root, reportRef);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function planningMemoryReportStatus(report, errors, requestedMode) {
  if (
    errors.length
    || ['unavailable', 'not_configured'].includes(report?.server?.status)
    || !report?.query?.effectiveMode
  ) return 'failed';
  if (report.query.fallback || report.query.effectiveMode !== requestedMode) return 'fallback';
  return 'succeeded';
}

export function consumePlanningMemoryLayer(layer, artifactRoot, projectId) {
  if (!layer || layer.status === 'not_configured' || layer.status === 'skipped') return layer;
  const reportPath = planningMemoryReportPath(artifactRoot, layer.report_ref);
  if (!reportPath) {
    return { ...layer, status: 'failed', detail: 'Recall report_ref must stay inside the artifact root.', result_count: 0, relevant_results: [], relevant_failures: [] };
  }
  if (!existsSync(reportPath)) {
    return { ...layer, status: 'skipped', detail: 'Recall report was not created before draft.', result_count: 0, relevant_results: [], relevant_failures: [] };
  }
  const report = loadJsonIfPresent(reportPath);
  const errors = planningMemoryReportErrors(report, layer, projectId);
  const effectiveMode = report?.query?.effectiveMode ?? null;
  const fallback = report?.query?.fallback ?? null;
  const status = planningMemoryReportStatus(report, errors, layer.requested_mode);
  const reportResults = Array.isArray(report?.results) ? report.results : [];
  const normalizedResults = reportResults.map(planningMemoryResultRef);
  const relevantResults = normalizedResults.slice(0, 8);
  const relevantFailures = normalizedResults
    .filter((result) => result.failure_class || ['failed', 'blocked'].includes(result.status))
    .slice(0, 8);
  const resultCount = Number.isInteger(report?.summary?.total) && report.summary.total >= 0
    ? report.summary.total
    : relevantResults.length;
  return {
    ...layer,
    status,
    effective_mode: effectiveMode,
    fallback,
    detail: errors.length ? errors.join('; ') : (report?.server?.detail ?? null),
    result_count: resultCount,
    relevant_results: relevantResults,
    relevant_failures: relevantFailures,
  };
}

function planningMemoryOverallStatus(layers) {
  const statuses = [layers.project?.status, layers.cross_project?.required ? layers.cross_project?.status : null].filter(Boolean);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('fallback')) return 'fallback';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('skipped')) return 'skipped';
  if (statuses.includes('succeeded')) return 'succeeded';
  return 'not_configured';
}

export function planningMemoryIncompleteWarningLines(memory) {
  const incompleteLayers = [
    ['project', memory?.layers?.project],
    ['cross-project', memory?.layers?.cross_project],
  ].filter(([label, layer]) => (
    ['failed', 'skipped'].includes(layer?.status)
    && (label === 'project' || layer.required)
  ));
  if (!incompleteLayers.length) return [];
  const lines = [
    `WARNING: Planning Memory recall is incomplete (overall=${memory?.status ?? 'unknown'}); planning continued without complete historical Memory evidence.`,
    'WARNING: This does not mean that no prior decisions or failures exist.',
  ];
  incompleteLayers.forEach(([label, layer]) => {
    lines.push(`- planning Memory recall (${label}): status=${layer.status}; report=${layer.report_ref ?? 'not recorded'}; detail=${layer.detail ?? 'not available'}`);
  });
  return lines;
}

function consumePlanningMemory(metadata, state, idea) {
  const storedMemory = metadata.planning_memory;
  const storedQueriesMatchIdea = (
    storedMemory?.layers?.project?.query === idea
    && storedMemory?.layers?.cross_project?.query === idea
  );
  const regenerated = Boolean(storedMemory) && !storedQueriesMatchIdea;
  const initial = storedQueriesMatchIdea
    ? storedMemory
    : planningMemoryRecallPlan({
        projectId: state.projectId,
        artifactRoot: state.artifactRoot,
        iterationRoot: state.iterationRoot,
        previousIterationId: metadata.baseline?.iteration_id,
        idea,
      });
  const consumeLayer = (layer) => {
    if (regenerated) return layer;
    return consumePlanningMemoryLayer(layer, state.artifactRoot, state.projectId);
  };
  const layers = {
    project: consumeLayer(initial.layers?.project),
    cross_project: consumeLayer(initial.layers?.cross_project),
  };
  return {
    ...initial,
    status: planningMemoryOverallStatus(layers),
    consumed_at: new Date().toISOString(),
    layers,
  };
}

function nextNumberedId(items, field, prefix) {
  let highest = 0;
  const pattern = new RegExp(`^${prefix}-([0-9]+)$`);
  for (const item of items ?? []) {
    const match = typeof item?.[field] === 'string' ? item[field].match(pattern) : null;
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest + 1;
}

function planningMemoryEvidence(memory, existingEvidence = []) {
  const evidence = [];
  let localIndex = nextNumberedId(existingEvidence, 'source_id', 'LOCAL');
  const layers = [memory?.layers?.project, memory?.layers?.cross_project];
  layers.forEach((layer) => {
    if (!['succeeded', 'fallback', 'failed'].includes(layer?.status)) return;
    const sources = (layer.relevant_results ?? [])
      .map((result) => result.source_reference ?? result.natural_key ?? result.source_path)
      .filter(Boolean)
      .slice(0, 5);
    evidence.push({
      source_id: `LOCAL-${localIndex}`,
      title: layer.scope === 'project' ? 'Project Memory recall report' : 'Cross-project Memory recall report',
      url: layer.scope === 'project' ? 'memory-recall.json' : 'memory-recall-cross-project.json',
      used_for: `Memory recall context only; query=${JSON.stringify(layer.query)}; requested=${layer.requested_mode}; effective=${layer.effective_mode ?? 'none'}; fallback=${layer.fallback ? `${layer.fallback.from}->${layer.fallback.to}` : 'none'}; sources=${sources.join(',') || 'none'}; status=${layer.status}.`,
    });
    localIndex += 1;
  });
  return evidence;
}

export function mergePlanningMemoryIntoIntake(intake, memory) {
  const evidence = planningMemoryEvidence(memory, intake.evidence);
  if (!evidence.length && memory?.status === 'not_configured') return intake;
  return {
    ...intake,
    known_facts: appendUnique(intake.known_facts, [
      `Planning Memory recall status: ${memory.status}; project=${memory.layers?.project?.status ?? 'not_configured'}; cross-project=${memory.layers?.cross_project?.status ?? 'not_configured'}. Reports are context, not automatically approved requirements.`,
    ]),
    evidence: [...intake.evidence, ...evidence],
  };
}

export function mergePlanningMemoryIntoSpec(spec, memory) {
  const intakeEvidence = planningMemoryEvidence(memory, spec.evidence);
  const evidence = intakeEvidence.map((item) => ({
    ...item,
    url: `../gate-a-intake/${item.url}`,
  }));
  if (!evidence.length && memory?.status === 'not_configured') return spec;
  const reconnaissance = spec.reference_reconnaissance ?? initialReferenceReconnaissance('current', 'current iteration');
  const candidateIndex = nextNumberedId(reconnaissance.candidates, 'candidate_id', 'REF');
  const candidates = evidence.map((item, index) => ({
    candidate_id: `REF-${candidateIndex + index}`,
    title: item.title,
    source_id: item.source_id,
    source_type: 'local_artifact',
    summary: item.used_for,
    used_for: 'Reviewed as prior-project context before approving implementation choices.',
    decision: 'context',
    rationale: 'Memory results are not adopted automatically; task boundaries and acceptance criteria must cite a result only when it materially changes the plan.',
  }));
  return {
    ...spec,
    evidence: [...spec.evidence, ...evidence],
    reference_reconnaissance: {
      ...reconnaissance,
      triggers: appendUnique(reconnaissance.triggers, [
        `Planning Memory recall was consumed with status ${memory.status}; verify any material reuse or failure mitigation before Gate B approval.`,
      ]),
      candidates: [...reconnaissance.candidates, ...candidates],
    },
  };
}

export function planningMemoryValidationErrors(memory, artifactRoot, projectId, expectedIdea = null) {
  const errors = [];
  if (!memory || typeof memory !== 'object') return errors;
  if (!PLANNING_MEMORY_STATUSES.has(memory.status)) errors.push(`planning_memory.status is invalid: ${memory.status}`);
  if (!MEMORY_FRESHNESS_STATUSES.has(memory.baseline_freshness?.status ?? 'unchecked')) {
    errors.push(`planning_memory.baseline_freshness.status is invalid: ${memory.baseline_freshness?.status}`);
  }
  const layers = memory.layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) {
    errors.push('planning_memory.layers must be an object');
    return errors;
  }
  for (const requiredLayer of ['project', 'cross_project']) {
    if (!layers[requiredLayer] || typeof layers[requiredLayer] !== 'object' || Array.isArray(layers[requiredLayer])) {
      errors.push(`planning_memory.layers.${requiredLayer} is required`);
    }
  }
  for (const name of Object.keys(layers)) {
    if (!['project', 'cross_project'].includes(name)) {
      errors.push(`planning_memory.layers.${name} is not supported`);
    }
  }
  for (const [name, layer] of Object.entries(layers)) {
    const expectedScope = name === 'project' ? 'project' : name === 'cross_project' ? 'cross_project' : null;
    if (expectedScope && layer?.scope !== expectedScope) {
      errors.push(`planning_memory.layers.${name}.scope must be ${expectedScope}`);
    }
    if (name === 'cross_project' && typeof layer?.required !== 'boolean') {
      errors.push('planning_memory.layers.cross_project.required must be a boolean');
    }
    if (!PLANNING_MEMORY_STATUSES.has(layer?.status)) {
      errors.push(`planning_memory.layers.${name}.status is invalid: ${layer?.status}`);
      continue;
    }
    if (layer.requested_mode !== 'hybrid') {
      errors.push(`planning_memory.layers.${name}.requested_mode must be hybrid`);
    }
    if (expectedIdea && layer.query !== expectedIdea) {
      errors.push(`planning_memory.layers.${name}.query must match iteration idea`);
    }
    if (['succeeded', 'fallback', 'failed'].includes(layer.status)) {
      const reportPath = planningMemoryReportPath(artifactRoot, layer.report_ref);
      if (!reportPath) {
        errors.push(`planning_memory.layers.${name}.report_ref must stay inside the artifact root`);
        continue;
      }
      const report = loadJsonIfPresent(reportPath);
      const reportErrors = planningMemoryReportErrors(report, layer, projectId);
      if (reportErrors.length) errors.push(`planning_memory.layers.${name}: ${reportErrors.join('; ')}`);
      const reportStatus = planningMemoryReportStatus(report, reportErrors, layer.requested_mode);
      if (layer.status !== reportStatus) {
        errors.push(`planning_memory.layers.${name} claims ${layer.status} but report state is ${reportStatus}`);
      }
    }
  }
  if (layers.project && layers.cross_project && PLANNING_MEMORY_STATUSES.has(memory.status)) {
    const expectedStatus = planningMemoryOverallStatus(layers);
    if (memory.status !== expectedStatus) {
      errors.push(`planning_memory.status claims ${memory.status} but layer state is ${expectedStatus}`);
    }
  }
  return errors;
}

export function validatePlanningMemoryEvidence(memory, document, documentPath, artifactRoot) {
  if (!memory || !document) return;
  for (const layer of Object.values(memory.layers ?? {})) {
    if (!['succeeded', 'fallback', 'failed'].includes(layer?.status)) continue;
    const expectedReportPath = planningMemoryReportPath(artifactRoot, layer.report_ref);
    if (!expectedReportPath) throw new ValidationError(`${documentPath} Memory report_ref must stay inside the artifact root`);
    const reportName = path.basename(expectedReportPath);
    const evidence = (document.evidence ?? []).find((item) => path.basename(item.url ?? '') === reportName);
    if (!evidence) throw new ValidationError(`${documentPath} must cite ${reportName} because planning Memory status is ${layer.status}`);
    const resolved = path.resolve(path.dirname(documentPath), evidence.url);
    if (!existsSync(resolved)) throw new ValidationError(`${documentPath} Memory evidence file not found: ${evidence.url}`);
    if (resolved !== expectedReportPath) throw new ValidationError(`${documentPath} Memory evidence ${evidence.source_id} must resolve to ${layer.report_ref}`);
    for (const token of ['query=', 'requested=', 'effective=', 'fallback=', 'sources=']) {
      if (!evidence.used_for.includes(token)) throw new ValidationError(`${documentPath} Memory evidence ${evidence.source_id} used_for must include ${token}`);
    }
  }
}

function createOpenBaselineSnapshot(currentSpec, artifactRoot, iterationId) {
  const currentEffectiveRef = currentSpec.effective_spec_ref;
  const currentEffectivePath = resolveArtifactFileReference(currentEffectiveRef, artifactRoot);
  assertFile(currentEffectivePath, 'current-spec.json effective_spec_ref');
  assertFileInsideArtifactRoot(
    currentEffectivePath,
    artifactRoot,
    'current-spec.json effective_spec_ref',
  );
  if (currentEffectiveRef !== 'current-spec.json') {
    return {
      ref: currentEffectiveRef,
      sha256: fileSha256(currentEffectivePath),
    };
  }

  const snapshotRef = canonicalComposedBaselineSnapshotRef(iterationId);
  const snapshotPath = path.join(artifactRoot, snapshotRef);
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeJson(snapshotPath, currentSpec);
  validateCurrentSpecCompositionData(loadJson(snapshotPath), artifactRoot, {
    requireNoOpenDecisions: true,
  });
  return {
    ref: snapshotRef,
    sha256: fileSha256(snapshotPath),
  };
}

function openLocked(args, artifactRoot, idea) {
  const openingState = resolveIterationState(artifactRoot, { requireReady: false });
  if (openingState.currentSpec.pending_iteration) {
    throw new ValidationError(
      'open requires no pending_iteration; finish or discard the active planning iteration first',
    );
  }
  const facts = loadReadyIterationFacts(artifactRoot);
  assertCloseReadyTasks(facts.taskGraph);
  assertArchivedBaselineForOpen(
    facts.state.currentSpec,
    artifactRoot,
    facts.state.activeIteration,
  );

  if (facts.state.activeIteration === args.iterationId) {
    throw new Error(`--iteration-id must differ from current active iteration ${JSON.stringify(facts.state.activeIteration)}`);
  }

  const iterationRoot = path.join(artifactRoot, 'iterations', args.iterationId);
  if (existsSync(iterationRoot)) throw new Error(`iteration already exists: ${iterationRoot}`);

  const currentSpecBefore = readFileSync(facts.state.currentSpecPath, 'utf8');
  const statusPath = path.join(artifactRoot, 'status.md');
  const statusBefore = existsSync(statusPath)
    ? readFileSync(statusPath, 'utf8')
    : null;
  const openedAt = new Date().toISOString();
  const projectId = facts.state.projectId;
  let iterationCreated = false;
  let stateWriteStarted = false;
  try {
    const gateDirs = GATE_DIRS.map((gate) => path.join(iterationRoot, gate));
    for (const gateDir of gateDirs) {
      mkdirSync(gateDir, { recursive: true });
      iterationCreated = true;
    }
    const baseline = createOpenBaselineSnapshot(
      facts.state.currentSpec,
      artifactRoot,
      args.iterationId,
    );
    const planningMemory = planningMemoryRecallPlan({
      projectRoot: ROOT,
      projectId,
      artifactRoot,
      iterationRoot,
      previousIterationId: facts.state.activeIteration,
      idea,
    });

    writeFileSync(
      path.join(iterationRoot, 'iteration.json'),
      `${JSON.stringify(iterationMetadata(
        projectId,
        args.iterationId,
        facts.state.activeIteration,
        idea,
        openedAt,
        baseline.ref,
        baseline.sha256,
        planningMemory,
      ), null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      path.join(iterationRoot, 'README.md'),
      iterationReadme(args.iterationId, idea, facts.state.activeIteration, baseline.ref),
      'utf8',
    );
    writeFileSync(path.join(iterationRoot, 'gate-a-intake', 'README.md'), gateReadme('Gate A intake', args.iterationId), 'utf8');
    writeFileSync(path.join(iterationRoot, 'gate-b-spec', 'README.md'), gateReadme('Gate B spec', args.iterationId), 'utf8');

    const nextCurrentSpec = currentSpecForOpen(
      facts.state.currentSpec,
      args.iterationId,
      facts.state.activeIteration,
      idea,
      openedAt,
      baseline.ref,
      baseline.sha256,
    );
    stateWriteStarted = true;
    atomicWriteJson(facts.state.currentSpecPath, nextCurrentSpec);
    writeIterationStatus(artifactRoot, nextCurrentSpec);

    const openedState = resolveIterationState(artifactRoot, { requireReady: false });
    console.log(`Plan2Agent iteration opened: ${toRelativeFromRoot(openedState.iterationRoot)}`);
    console.log(`- active iteration: ${openedState.activeIteration}`);
    console.log(`- baseline iteration: ${facts.state.activeIteration}`);
    console.log(`- idea: ${idea}`);
    console.log('Skeleton created; Gate B/C artifacts are not required until planning outputs are written.');
    console.log(`- baseline Memory freshness: ${planningMemory.baseline_freshness.status} (${planningMemory.baseline_freshness.detail})`);
    if (planningMemory.layers.project.command) console.log(`- planning recall (project): ${planningMemory.layers.project.command}`);
    if (planningMemory.layers.cross_project.command) {
      console.log(`- planning recall (cross-project): ${planningMemory.layers.cross_project.command}`);
      console.log(`  reason: ${planningMemory.layers.cross_project.reason}`);
    }
    if (!planningMemory.configured) console.log(`- planning recall: not configured (${planningMemory.configuration_reason})`);
    return 0;
  } catch (error) {
    const rollbackFailures = [];
    if (stateWriteStarted) {
      try {
        writeFileSync(facts.state.currentSpecPath, currentSpecBefore, 'utf8');
      } catch (rollbackError) {
        rollbackFailures.push(`current-spec.json: ${rollbackError.message}`);
      }
      try {
        if (statusBefore === null) rmSync(statusPath, { force: true });
        else writeFileSync(statusPath, statusBefore, 'utf8');
      } catch (rollbackError) {
        rollbackFailures.push(`status.md: ${rollbackError.message}`);
      }
    }
    if (iterationCreated || existsSync(iterationRoot)) {
      try {
        rmSync(iterationRoot, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackFailures.push(`iteration directory: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; iteration open rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function open(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  assertSafeIterationId(args.iterationId);
  const idea = args.idea.trim();
  assertDirectory(artifactRoot, 'artifact root');
  const iterationsRoot = artifactStateLockDir(artifactRoot);
  assertDirectory(iterationsRoot, 'iterations directory');
  return withRunStoreLocks(
    [iterationsRoot],
    () => openLocked(args, artifactRoot, idea),
  );
}

function gateAForceResetArtifactPaths(state, files) {
  const taskGraphDraftPath = gateCTaskGraphDraftPath(state);
  return [
    files.productSpecMd,
    files.implementationPlanMd,
    files.specJson,
    taskGraphDraftPath,
    `${taskGraphDraftPath}.promoted`,
    gateCTaskGraphDraftMetaPath(state),
    state.taskGraphPath,
  ];
}

function assertGateAForceResetSafe(state) {
  const existingTaskGraph = loadExistingTaskGraphIfPresent(state.taskGraphPath);
  const startedTasks = existingTaskGraph?.tasks.filter((task) => task.status !== 'todo') ?? [];
  if (startedTasks.length) {
    throw new ValidationError(
      `draft --force cannot restart Gate A after task execution has started; non-todo task(s): ${startedTasks.map((task) => `${task.id}:${task.status}`).join(', ')}. ` +
      'Open a new feature iteration or use the maintenance lane instead',
    );
  }
  assertNoTaskGraphExecutionHistory(state, 'draft --force');
}

function lstatIfPresent(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function invalidateGateADownstreamArtifacts(state, files) {
  const intakeMarkdownStat = lstatIfPresent(files.intakeMd);
  if (intakeMarkdownStat) {
    if (!intakeMarkdownStat.isFile()) {
      throw new ValidationError(
        `Gate A intake Markdown export must be a regular file: ${files.intakeMd}`,
      );
    }
    unlinkSync(files.intakeMd);
  }
  for (const filePath of gateAForceResetArtifactPaths(state, files)) {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}

function gateAScopeDraftMessages(intake) {
  const openQuestions = (intake.clarifying_questions ?? [])
    .filter((item) => item.status === 'open')
    .map((item) => item.id);
  const openDecisions = (intake.needs_user_decision ?? [])
    .filter((item) => item.status !== 'answered')
    .map((item) => item.id);
  const blockers = [...openQuestions, ...openDecisions];
  return [
    'Plan2Agent Gate A scope confirmation required.',
    blockers.length
      ? `- Resolve ${blockers.join(', ')}, then review and explicitly approve the scope.`
      : '- Review and explicitly approve the scope, then record approval_audit.',
  ];
}

function syncGateAScopeMarkdown(files, intake, artifactRoot) {
  const intakeMarkdownStat = lstatIfPresent(files.intakeMd);
  if (!intakeMarkdownStat) return;
  if (!intakeMarkdownStat.isFile()) {
    throw new ValidationError(
      `Gate A intake Markdown export must be a regular file: ${files.intakeMd}`,
    );
  }
  assertFileInsideArtifactRoot(
    files.intakeMd,
    artifactRoot,
    'Gate A intake Markdown export',
  );
  const currentView = readFileSync(files.intakeMd, 'utf8');
  const [firstLine] = currentView.split(/\r\n|\n|\r/, 1);
  if (firstLine !== EXPLICIT_INTAKE_MARKDOWN_MARKER) {
    unlinkSync(files.intakeMd);
    return;
  }
  atomicWriteText(
    files.intakeMd,
    renderIntakeMarkdown(intake, { explicitExport: true }),
  );
}

function draftTransactionPaths(state, options = {}) {
  const files = draftArtifactPaths(state.iterationRoot);
  return [
    ...(options.includeDownstream
      ? gateAForceResetArtifactPaths(state, files)
      : [
          files.productSpecMd,
          files.implementationPlanMd,
          files.specJson,
        ]),
    files.intakeJson,
    files.intakeMd,
    path.join(state.iterationRoot, 'README.md'),
    path.join(state.iterationRoot, 'iteration.json'),
    state.currentSpecPath,
    path.join(state.artifactRoot, 'status.md'),
  ];
}

function writeIterationMetadataAndReadme(state, metadata) {
  const readmePath = path.join(state.iterationRoot, 'README.md');
  assertWritableArtifactFilePath(readmePath, state.artifactRoot, 'iteration README');
  writeJson(path.join(state.iterationRoot, 'iteration.json'), metadata);
  atomicWriteText(
    readmePath,
    iterationReadme(
      state.activeIteration,
      metadata.idea,
      metadata.baseline?.iteration_id ?? 'none',
      metadata.baseline?.effective_spec_ref ?? 'none',
    ),
  );
}

function captureDraftSnapshot(state, options = {}) {
  return captureRollbackFiles(draftTransactionPaths(state, options));
}

function restoreDraftSnapshot(snapshot) {
  return restoreRollbackFiles(snapshot);
}

function withGateAForceResetRollback(state, fn) {
  return withDraftRollback(state, fn, {
    includeDownstream: true,
    label: 'Gate A force-reset',
  });
}

function withDraftRollback(state, fn, options = {}) {
  const snapshot = captureDraftSnapshot(state, options);
  try {
    return fn();
  } catch (error) {
    const rollbackFailures = restoreDraftSnapshot(snapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; ${options.label ?? 'draft'} rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function assertIntakeBaselineMatchesPending(
  intake,
  baselineSpecRef,
  baselineSpecPath,
  artifactRoot,
  baselineSpecSha256 = null,
) {
  if (!baselineSpecRef) {
    if (intake.baseline_context) {
      throw new ValidationError(
        'greenfield Gate A intake must not define baseline_context when the pending iteration has no baseline',
      );
    }
    return;
  }
  if (!intake.baseline_context?.spec_ref) {
    throw new ValidationError(
      'baseline-aware Gate A intake must preserve baseline_context.spec_ref',
    );
  }
  if (
    normalizeDisplayPath(intake.baseline_context.spec_ref)
    !== normalizeDisplayPath(baselineSpecRef)
  ) {
    throw new ValidationError(
      `intake baseline_context.spec_ref ${JSON.stringify(intake.baseline_context.spec_ref)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }
  const intakeBaselineSpecPath = resolveArtifactFileReference(
    intake.baseline_context.spec_ref,
    artifactRoot,
  );
  assertFile(intakeBaselineSpecPath, 'intake baseline_context.spec_ref');
  assertFileInsideArtifactRoot(
    intakeBaselineSpecPath,
    artifactRoot,
    'intake baseline_context.spec_ref',
  );
  if (realpathSync(intakeBaselineSpecPath) !== realpathSync(baselineSpecPath)) {
    throw new ValidationError(
      `intake baseline_context.spec_ref ${JSON.stringify(intake.baseline_context.spec_ref)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }
  if (
    baselineSpecSha256
    && intake.baseline_context.spec_sha256 !== baselineSpecSha256
  ) {
    throw new ValidationError(
      'intake baseline_context.spec_sha256 must match the pending baseline hash',
    );
  }
}

function assertPendingBaselineIntegrity(
  state,
  pending,
  metadata,
  baselineSpecRef,
  baselineSpecPath,
) {
  const metadataBaselineRef = metadata.baseline?.effective_spec_ref;
  if (normalizeDisplayPath(metadataBaselineRef) !== normalizeDisplayPath(baselineSpecRef)) {
    throw new ValidationError(
      `iteration metadata baseline ${JSON.stringify(metadataBaselineRef)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }

  const pendingHash = pending.baseline_effective_spec_sha256;
  const metadataHash = metadata.baseline?.effective_spec_sha256;
  const pendingHasHash = Object.hasOwn(
    pending,
    'baseline_effective_spec_sha256',
  );
  const metadataHasHash = Object.hasOwn(
    metadata.baseline ?? {},
    'effective_spec_sha256',
  );
  if (pendingHasHash !== metadataHasHash) {
    throw new ValidationError(
      'pending and iteration metadata must both record the baseline effective spec hash',
    );
  }
  if (
    pendingHasHash
    && (
      typeof pendingHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(pendingHash)
      || typeof metadataHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(metadataHash)
    )
  ) {
    throw new ValidationError(
      'pending and iteration metadata baseline effective spec hashes must be lowercase SHA-256 values',
    );
  }
  if (pendingHasHash && pendingHash !== metadataHash) {
    throw new ValidationError(
      'pending and iteration metadata baseline effective spec hashes must match',
    );
  }
  const expectedHash = pendingHasHash ? pendingHash : null;
  if (expectedHash !== null && fileSha256(baselineSpecPath) !== expectedHash) {
    throw new ValidationError(
      `pending baseline hash does not match ${baselineSpecRef}`,
    );
  }

  if (
    isComposedBaselineReference(baselineSpecRef)
    && baselineSpecRef !== 'current-spec.json'
  ) {
    const expectedSnapshotRef = canonicalComposedBaselineSnapshotRef(
      state.activeIteration,
    );
    if (normalizeDisplayPath(baselineSpecRef) !== expectedSnapshotRef) {
      throw new ValidationError(
        `pending composed baseline snapshot must be ${expectedSnapshotRef}`,
      );
    }
    if (!expectedHash) {
      throw new ValidationError(
        'pending composed baseline snapshot must record baseline_effective_spec_sha256',
      );
    }
    const snapshot = loadJson(baselineSpecPath);
    validateCurrentSpecCompositionData(snapshot, state.artifactRoot, {
      requireNoOpenDecisions: true,
    });
    for (const field of [
      'project_id',
      'composed_from',
      'source_specs',
      'effective_product',
      'effective_implementation',
      'superseded_refs',
      'composition_conflicts',
      'open_decisions',
    ]) {
      if (!jsonEqual(snapshot[field] ?? null, state.currentSpec[field] ?? null)) {
        throw new ValidationError(
          `pending composed baseline snapshot ${field} must match the current effective composition`,
        );
      }
    }
    return expectedHash;
  }

  return expectedHash;
}

function draftWithState(args, state) {
  const artifactRoot = state.artifactRoot;
  const pending = activePendingIteration(state);
  const metadata = loadIterationMetadata(state.iterationRoot);
  const idea = draftIdea(args, pending, metadata);
  if (args.force) assertGateAForceResetSafe(state);
  const planningMemory = consumePlanningMemory(metadata, state, idea);
  const baselineSpecRef = pending.baseline_effective_spec_ref;
  let baselineIteration = pending.baseline_iteration ?? metadata.baseline?.iteration_id ?? 'none';
  let baselineSpec = null;
  let baselineSpecPath = null;
  let baselineSpecSha256 = null;
  if (baselineSpecRef) {
    baselineSpecPath = resolveArtifactFileReference(baselineSpecRef, artifactRoot);
    assertFile(baselineSpecPath, 'current-spec.json pending_iteration.baseline_effective_spec_ref');
    assertFileInsideArtifactRoot(
      baselineSpecPath,
      artifactRoot,
      'current-spec.json pending_iteration.baseline_effective_spec_ref',
    );
    baselineSpecSha256 = assertPendingBaselineIntegrity(
      state,
      pending,
      metadata,
      baselineSpecRef,
      baselineSpecPath,
    );
    baselineIteration = pending.baseline_iteration ?? metadata.baseline?.iteration_id ?? 'unknown';
    baselineSpec = loadEffectiveBaselineSpec(baselineSpecPath, artifactRoot);
  }
  const projectId = state.projectId;
  const files = draftArtifactPaths(state.iterationRoot);
  assertWritableDraftFilePaths(files, artifactRoot);
  assertWritableArtifactFilePath(
    path.join(state.iterationRoot, 'README.md'),
    artifactRoot,
    'iteration README',
  );
  const existingIntake = !args.force && existsSync(files.intakeJson)
    ? loadJson(files.intakeJson)
    : null;
  if (existingIntake) {
    assertIntakeBaselineMatchesPending(
      existingIntake,
      baselineSpecRef,
      baselineSpecPath,
      artifactRoot,
      baselineSpecSha256,
    );
  }
  assertWritableDraftFiles(files, artifactRoot, args.force, {
    allowExisting: ['intakeJson', 'intakeMd'],
  });
  const preflight = loadFeatureRadarPreflight(artifactRoot, { projectId });
  const resetDeltaIntake = Boolean(baselineSpecRef) && (args.force || !existsSync(files.intakeJson));
  const resetGreenfieldIntake = !baselineSpecRef && args.force;
  let writeGeneratedIntake = false;
  let intake;
  if (resetDeltaIntake) {
    const baselineContext = loadBaselineContext(baselineSpecPath, artifactRoot, baselineSpecRef);
    intake = buildDeltaIntake({
      projectId,
      iterationId: state.activeIteration,
      idea,
      baselineIteration,
      baselineSpecRef,
      baselineSpec,
      baselineContext,
    });
    intake = mergePlanningMemoryIntoIntake(intake, planningMemory);
    if (preflight.detected) intake = mergeFeatureRadarIntoIntake(intake, preflight);
    writeGeneratedIntake = true;
  } else if (resetGreenfieldIntake) {
    intake = buildGreenfieldRestartIntake(null, idea, state.activeIteration);
    if (!intake.known_facts.some((fact) => fact.startsWith('Planning Memory recall status:'))) {
      intake = mergePlanningMemoryIntoIntake(intake, planningMemory);
    }
    if (
      preflight.detected
      && !intake.known_facts.some((fact) => fact.startsWith('Feature Radar preflight research detected'))
    ) {
      intake = mergeFeatureRadarIntoIntake(intake, preflight);
    }
    writeGeneratedIntake = true;
  } else {
    const intakeBeforeValidation = existingIntake ?? loadJson(files.intakeJson);
    assertIntakeBaselineMatchesPending(
      intakeBeforeValidation,
      baselineSpecRef,
      baselineSpecPath,
      artifactRoot,
      baselineSpecSha256,
    );
    intake = validateIntake(files.intakeJson, { artifactRoot });
    if (intake.idea.trim() !== idea) {
      const recovery = baselineSpecRef
        ? 'rerun with --force to restart Gate A scope confirmation'
        : 'regenerate or update the Gate A intake before drafting Gate B';
      throw new Error(
        `draft idea ${JSON.stringify(idea)} does not match existing Gate A intake idea ${JSON.stringify(intake.idea)}; ${recovery}`,
      );
    }
  }
  assertIntakeBaselineMatchesPending(
    intake,
    baselineSpecRef,
    baselineSpecPath,
    artifactRoot,
    baselineSpecSha256,
  );
  if (args.force) invalidateGateADownstreamArtifacts(state, files);
  if (writeGeneratedIntake) {
    writeJson(files.intakeJson, intake);
  }

  const artifacts = {
    intake_ref: artifactRelativePath(artifactRoot, files.intakeJson),
    spec_ref: artifactRelativePath(artifactRoot, files.specJson),
    product_spec_ref: artifactRelativePath(artifactRoot, files.productSpecMd),
    implementation_plan_ref: artifactRelativePath(artifactRoot, files.implementationPlanMd),
  };
  const draftedAt = new Date().toISOString();
  const currentSpec = args.force
    ? currentSpecAfterGateAForceReset(
        state.currentSpec,
        state.activeIteration,
        state.effectiveSpecPath,
        state.specPath,
      )
    : state.currentSpec;
  const planningMetadata = args.force
    ? iterationMetadataAfterGateAForceReset(metadata)
    : metadata;
  if (intake.status !== 'ready_for_spec') {
    syncGateAScopeMarkdown(files, intake, artifactRoot);
    validateIntake(files.intakeJson, { artifactRoot });
    writeIterationMetadataAndReadme(
      state,
      iterationMetadataForGateAScope(
        planningMetadata,
        idea,
        draftedAt,
        artifacts,
        planningMemory,
      ),
    );
    const nextCurrentSpec = currentSpecForGateAScope(
      currentSpec,
      state.activeIteration,
      idea,
      draftedAt,
      artifacts,
    );
    writeJson(state.currentSpecPath, nextCurrentSpec);
    writeIterationStatus(state.artifactRoot, nextCurrentSpec);

    const [headline, nextAction] = gateAScopeDraftMessages(intake);
    console.log(headline);
    console.log(`- active iteration: ${state.activeIteration}`);
    console.log(nextAction);
    console.log('- Gate B synthesis is blocked until Gate A is explicitly confirmed.');
    console.log(`- planning Memory: ${planningMemory.status} (project=${planningMemory.layers.project.status}, cross-project=${planningMemory.layers.cross_project.status})`);
    planningMemoryIncompleteWarningLines(planningMemory).forEach((line) => console.warn(line));
    if (preflight.detected) {
      console.log(`- Feature Radar preflight: ${featureRadarSummary(preflight)}`);
    }
    return 0;
  }

  syncGateAScopeMarkdown(files, intake, artifactRoot);
  let spec = baselineSpecRef
    ? buildDeltaSpec({
        projectId,
        iterationId: state.activeIteration,
        idea,
        baselineSpec,
        baselineSpecRef,
        intake,
      })
    : buildInitialSpec({
        projectId,
        iterationId: state.activeIteration,
        idea,
        intake,
      });
  spec.source_intake_sha256 = fileSha256(files.intakeJson);
  spec = mergePlanningMemoryIntoSpec(spec, planningMemory);
  if (preflight.detected) {
    spec = mergeFeatureRadarIntoSpec(spec, preflight);
  }
  atomicWriteText(files.productSpecMd, renderProductSpecMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef: baselineSpecRef ?? 'none',
    baselineSpec,
  }));
  atomicWriteText(files.implementationPlanMd, renderImplementationPlanMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef: baselineSpecRef ?? 'none',
    baselineSpec,
  }));
  writeJson(files.specJson, spec);

  validateIntake(files.intakeJson, { artifactRoot });
  validateSpec(files.specJson, files.intakeJson, { artifactRoot });
  writeIterationMetadataAndReadme(
    state,
    iterationMetadataForDraft(planningMetadata, idea, draftedAt, artifacts, planningMemory),
  );
  const nextCurrentSpec = currentSpecForDraft(currentSpec, state.activeIteration, idea, draftedAt, artifacts);
  writeJson(state.currentSpecPath, nextCurrentSpec);
  writeIterationStatus(state.artifactRoot, nextCurrentSpec);

  console.log(`Plan2Agent iteration draft generated: ${toRelativeFromRoot(state.iterationRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- baseline spec: ${baselineSpecRef ?? 'none'}`);
  console.log(`- intake: ${artifacts.intake_ref}`);
  console.log(`- spec: ${artifacts.spec_ref} (approval=draft)`);
  console.log(`- planning Memory: ${planningMemory.status} (project=${planningMemory.layers.project.status}, cross-project=${planningMemory.layers.cross_project.status})`);
  planningMemoryIncompleteWarningLines(planningMemory).forEach((line) => console.warn(line));
  if (preflight.detected) {
    console.log(`- Feature Radar preflight: ${featureRadarSummary(preflight)}`);
  }
  console.log('Gate A/B artifacts validated; Gate C task graph validation is still pending.');
  return 0;
}

function draft(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  if (!args.force) {
    return withRunStoreLocks(
      [artifactStateLockDir(artifactRoot)],
      () => {
        const state = resolveIterationState(artifactRoot, { requireReady: false });
        return withDraftRollback(
          state,
          () => draftWithState(args, state),
        );
      },
    );
  }

  const initialState = resolveIterationState(artifactRoot, { requireReady: false });
  const graphDir = path.dirname(initialState.taskGraphPath);
  const runsDir = path.join(initialState.artifactRoot, 'runs');
  return withRunStoreLocks([
    artifactStateLockDir(initialState.artifactRoot),
    graphDir,
    runsDir,
  ], () => {
    const lockedState = resolveIterationState(artifactRoot, { requireReady: false });
    if (
      lockedState.activeIteration !== initialState.activeIteration
      || path.resolve(lockedState.taskGraphPath) !== path.resolve(initialState.taskGraphPath)
    ) {
      throw new ValidationError('active iteration changed while draft --force was waiting for execution locks; retry the command');
    }
    return withGateAForceResetRollback(
      lockedState,
      () => draftWithState(args, lockedState),
    );
  });
}

function composeLocked(args, artifactRoot) {
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  const { sources, skipped } = collectCompositionSources(artifactRoot, state.currentSpec);
  const composedCurrentSpec = buildComposedCurrentSpec(state.currentSpec, sources, skipped);
  validateCurrentSpecCompositionData(composedCurrentSpec, artifactRoot);
  if (composedCurrentSpec.open_decisions.length && !args.allowConflicts) {
    throw new ValidationError(
      `current-spec composition has unresolved open_decisions: ${JSON.stringify(composedCurrentSpec.open_decisions.map((decision) => decision.id))}; rerun with --allow-conflicts to write the conflict decisions`,
    );
  }
  const snapshot = captureRollbackFiles([
    state.currentSpecPath,
    path.join(state.artifactRoot, 'status.md'),
  ]);
  try {
    atomicWriteJson(state.currentSpecPath, composedCurrentSpec);
    writeIterationStatus(state.artifactRoot, composedCurrentSpec);
  } catch (error) {
    const rollbackFailures = restoreRollbackFiles(snapshot);
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; iteration compose rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (composedCurrentSpec.open_decisions.length) {
    console.log(`Plan2Agent current spec composed with conflicts: ${toRelativeFromRoot(state.currentSpecPath)}`);
    console.log(`- open decisions: ${composedCurrentSpec.open_decisions.map((decision) => decision.id).join(', ')}`);
    console.log('- resolve current-spec.json open_decisions before opening the next iteration');
    return 0;
  }

  console.log(`Plan2Agent current spec composed: ${toRelativeFromRoot(state.currentSpecPath)}`);
  console.log(`- composed iterations: ${composedCurrentSpec.composed_from.join(', ')}`);
  console.log(`- source specs: ${composedCurrentSpec.source_specs.length}`);
  console.log(`- superseded refs: ${composedCurrentSpec.superseded_refs.length}`);
  console.log(`- skipped iterations: ${skipped.length}`);
  console.log('- effective spec ref: current-spec.json');
  return 0;
}

function compose(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  return withRunStoreLocks(
    [artifactStateLockDir(artifactRoot)],
    () => composeLocked(args, artifactRoot),
  );
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'init') return init(args);
    if (args.command === 'current') return current(args);
    if (args.command === 'validate') return validateIteration(args);
    if (args.command === 'close') return close(args);
    if (args.command === 'open') return open(args);
    if (args.command === 'draft') return draft(args);
    if (args.command === 'context') return context(args);
    if (args.command === 'promote-spec') return promoteSpec(args);
    if (args.command === 'promote-tasks') return promoteTasks(args);
    if (args.command === 'promote-milestone') return promoteMilestone(args);
    if (args.command === 'diff-tasks') return diffTasks(args);
    if (args.command === 'compose') return compose(args);
    if (args.command === 'maintenance') return maintenance(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ValidationError || error.code || error.message) {
      console.error(`p2a iteration failed: ${error.message}`);
      return 1;
    }
    throw error;
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
