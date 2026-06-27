#!/usr/bin/env node
/** Manage Plan2Agent iterative artifact layout. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadJson,
  validateIntake,
  validateReview,
  validateHandoffReadyArtifactRoot,
  validateReviewPass,
  validateSpec,
  validateStatusApprovalAudit,
  validateStatusDoc,
  validateTaskGraph,
  validateTaskContextData,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  formatIterationState,
  resolveIterationState,
  serializeIterationState,
} from './p2a_iteration_state.mjs';
import { loadRunsForArtifactRoot } from './p2a_runs.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const GATE_DIRS = ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph', 'gate-d-review'];
const STATUS_ORDER = ['todo', 'in_progress', 'done', 'blocked'];
const DEFAULT_ITERATION_ID = 'v1-mvp';
const INIT_REBASED_SOURCE_SPEC = '../gate-b-spec/spec.json';
const COMMANDS = new Set(['init', 'current', 'validate', 'close', 'open', 'draft', 'context', 'promote-spec', 'promote-tasks', 'diff-tasks', 'compose', 'maintenance']);
const MAINTENANCE_ACTIONS = new Set(['add']);
const VALIDATE_STAGES = new Set(['ready', 'gate-a', 'gate-b-draft', 'gate-b-approved', 'gate-c-draft']);
const PRODUCT_FIELDS = [
  'problem',
  'target_users',
  'goals',
  'non_goals',
  'core_flows',
  'screens_or_interfaces',
  'data_model_draft',
  'external_integrations',
  'success_criteria',
  'constraints',
];
const PRODUCT_ARRAY_FIELDS = PRODUCT_FIELDS.filter((field) => field !== 'problem');
const IMPLEMENTATION_FIELDS = [
  'architecture',
  'interfaces',
  'data_flow',
  'dependencies',
  'edge_cases',
  'verification',
];

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_iteration.mjs init --artifacts <greenfield-project-dir> [--iteration-id v1-mvp] [--dry-run]',
    '  node .plan2agent/scripts/p2a_iteration.mjs current --artifacts <iterative-project-dir> [--json]',
    '  node .plan2agent/scripts/p2a_iteration.mjs validate --artifacts <iterative-project-dir> [--require-close-ready] [--allow-planning] [--stage ready|gate-a|gate-b-draft|gate-b-approved|gate-c-draft] [--skip-archive-audit]',
    '  node .plan2agent/scripts/p2a_iteration.mjs close --artifacts <iterative-project-dir> [--iteration-id active]',
    '  node .plan2agent/scripts/p2a_iteration.mjs open --artifacts <iterative-project-dir> --iteration-id <id> --idea <text>',
    '  node .plan2agent/scripts/p2a_iteration.mjs draft --artifacts <iterative-project-dir> [--idea <text>] [--force]',
    '  node .plan2agent/scripts/p2a_iteration.mjs context --artifacts <iterative-project-dir> [--idea <text>] [--code-root <dir>]',
    '  node .plan2agent/scripts/p2a_iteration.mjs promote-spec --artifacts <iterative-project-dir>',
    '  node .plan2agent/scripts/p2a_iteration.mjs promote-tasks --artifacts <iterative-project-dir>',
    '  node .plan2agent/scripts/p2a_iteration.mjs diff-tasks --artifacts <iterative-project-dir> [--force]',
    '  node .plan2agent/scripts/p2a_iteration.mjs compose --artifacts <iterative-project-dir> [--allow-conflicts]',
    '  node .plan2agent/scripts/p2a_iteration.mjs maintenance add --artifacts <iterative-project-dir> --title <text> --accept <text> [--accept <text> ...] [--description <text>] [--area <text>] [--prompt <text>] [--ref <value> ...] [--depends <task-id> ...] [--dry-run]',
    '',
    'Commands:',
    '  init                  Convert a greenfield artifact root into iterations/<id>/gate-*.',
    '  current               Print the active iteration paths resolved from current-spec.json.',
    '  validate              Validate active iteration structure and Gate B-D readiness.',
    '  close                 Mark the active close-ready iteration as closed/archived metadata.',
    '  open                  Create a new active iteration skeleton from the current baseline.',
    '  draft                 Generate baseline-aware Gate A/B draft artifacts for the active planning iteration.',
    '  context               Print JSON context for agent-authored Gate C task drafting.',
    '  promote-spec          Record an approved active Gate B spec and initialize current-spec when needed.',
    '  promote-tasks         Promote an approved Gate C draft task graph to the canonical graph.',
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
    '  --allow-planning      Accept Gate A/B planning states instead of requiring Gate B-D readiness.',
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
    '  --force               Overwrite existing Gate A/B draft files.',
    '',
    'context options:',
    '  --idea <text>         Override the idea included in the emitted context JSON.',
    '  --code-root <dir>     Code root to scan for L1 file-tree signals. Default: current working directory.',
    '',
    'promote-tasks options:',
    '  (none)                Requires approved spec plus Gate C approval audit in status.md.',
    '',
    'diff-tasks options:',
    '  --force               Overwrite existing Gate C task graph.',
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
    acceptanceCriteria: [],
    sourceSpecRefs: [],
    dependencies: [],
    codeRoot: process.cwd(),
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
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!args.help && !args.artifacts) throw new Error(`--artifacts is required\n\n${usage()}`);
  if (command === 'open' && !args.iterationIdProvided) throw new Error('--iteration-id is required for open');
  if (command === 'open' && (!args.idea || args.idea.trim().length === 0)) throw new Error('--idea is required for open');
  if (command === 'maintenance' && args.action === 'add') {
    if (!args.title || args.title.trim().length === 0) throw new Error('--title is required for maintenance add');
    if (!args.acceptanceCriteria.length) throw new Error('--accept is required for maintenance add');
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
    reviewJson: path.join(artifactRoot, 'gate-d-review', 'review.json'),
    movedSpecJson: path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
    movedTaskGraph: path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'),
    movedReviewJson: path.join(iterationRoot, 'gate-d-review', 'review.json'),
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
  assertFile(paths.reviewJson, 'greenfield gate-d-review/review.json');

  const rootValidation = validateHandoffReadyArtifactRoot(paths.artifactRoot);
  const gateBApprovalAudit = gateBApprovalAuditForIteration(
    parseGateBApprovalAudit(paths.statusMd),
    iterationId,
    'Gate B approval preserved from greenfield status during iteration init.',
  );

  return {
    spec: rootValidation.spec,
    taskGraph: rootValidation.taskGraph,
    review: rootValidation.review,
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

function gateSummary(spec, taskGraph, review) {
  const blockingIssueCount = Array.isArray(review.blocking_issues) ? review.blocking_issues.length : 0;
  const approval = spec.approval ?? 'unknown';
  const bBadge = approval === 'approved' ? `B✅(${approval})` : `B⚠️(${approval})`;
  const cBadge = Array.isArray(taskGraph.tasks) && taskGraph.tasks.length > 0 ? 'C✅' : 'C⚠️';
  const dBadge = blockingIssueCount === 0 ? 'D✅(blocker 0)' : `D⚠️(blocker ${blockingIssueCount})`;
  return `A✅ ${bBadge} ${cBadge} ${dBadge}`;
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
  const reviewPath = path.join(artifactRoot, reviewRef(iterationId));
  if (!existsSync(specPath)) return 'A/B/C/D 대기';
  try {
    const spec = validateSpec(specPath);
    if (!existsSync(taskGraphPath)) return spec.approval === 'approved' ? 'B✅ C/D 대기' : `B⚠️(${spec.approval}) C/D 대기`;
    const taskGraph = validateTaskGraph(taskGraphPath, specPath);
    if (!existsSync(reviewPath)) return `${spec.approval === 'approved' ? 'B✅' : `B⚠️(${spec.approval})`} C✅ D 대기`;
    const review = validateReview(reviewPath);
    return gateSummary(spec, taskGraph, review);
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
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function closedIterationArtifactRefs(iterationId) {
  return [
    `iterations/${iterationId}/gate-a-intake/intake.json`,
    `iterations/${iterationId}/gate-a-intake/intake.md`,
    `iterations/${iterationId}/gate-b-spec/product-spec.md`,
    `iterations/${iterationId}/gate-b-spec/implementation-plan.md`,
    sourceSpecRef(iterationId),
    taskGraphRef(iterationId),
    `iterations/${iterationId}/gate-d-review/review-report.md`,
    reviewRef(iterationId),
  ];
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
    `iterations/${iterationId}/gate-b-spec/product-spec.md`,
    `iterations/${iterationId}/gate-b-spec/implementation-plan.md`,
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

function progressForIteration(currentSpec, activeIteration) {
  const status = statusForIterationId(currentSpec, activeIteration);
  if (status === 'active_planning') return '[A:pending] -> [B:pending] -> [C:pending] -> [D:pending]';
  if (status === 'gate_a_ready') return '[A:complete] -> [B:current] -> [C:pending] -> [D:pending]';
  if (status === 'gate_b_draft') return '[A:complete] -> [B:draft] -> [C:pending] -> [D:pending]';
  if (status === 'gate_b_approved') return '[A:complete] -> [B:approved] -> [C:pending] -> [D:pending]';
  if (status === 'archived') return '[A:complete] -> [B:approved] -> [C:valid] -> [D:passed]';
  return '[A:complete] -> [B:approved] -> [C:valid] -> [D:passed]';
}

function renderActiveGateSections(artifactRoot, activeIteration, currentSpec) {
  const iterationRoot = path.join(artifactRoot, 'iterations', activeIteration);
  const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
  const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
  const taskGraphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
  const reviewPath = path.join(iterationRoot, 'gate-d-review', 'review.json');
  const spec = existsSync(specPath) ? loadJson(specPath) : null;
  const taskGraph = existsSync(taskGraphPath) ? loadJson(taskGraphPath) : null;
  const review = existsSync(reviewPath) ? loadJson(reviewPath) : null;
  const blockerCount = Array.isArray(review?.blocking_issues) ? review.blocking_issues.length : null;
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
    `### Gate D - Review blockers\n\n` +
    `- 상태: ${review ? `blocking_issues=${blockerCount}` : 'pending'}\n` +
    `- 정본 파일: \`iterations/${activeIteration}/gate-d-review/review.json\`\n`;
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
    `Progress: ${progressForIteration(currentSpec, activeIteration)}\n\n` +
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
    `- 새 기능 → \`p2a_iteration open --iteration-id <next> --idea <text>\`\n` +
    `- 작은 fix → \`p2a_iteration maintenance add ...\`\n` +
    `- 검증 → \`p2a_iteration validate --artifacts <dir>\` (closed iteration archive audit 기본 수행)\n\n` +
    `## 5. 변경 이력\n\n` +
    `- status generated from current-spec.json for active iteration \`${activeIteration}\`.\n`;
}

function writeIterationStatus(artifactRoot, currentSpec) {
  writeFileSync(path.join(artifactRoot, 'status.md'), renderIterationIndexMarkdown(artifactRoot, currentSpec), 'utf8');
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

function loadEffectiveBaselineSpec(filePath) {
  const data = loadJson(filePath);
  if (data.schema_version === 'p2a.spec.v1') return validateSpec(filePath);
  if (data.schema_version !== 'p2a.current_spec.v1') {
    throw new ValidationError(`baseline must be p2a.spec.v1 or p2a.current_spec.v1, got ${JSON.stringify(data.schema_version)}`);
  }
  validateCurrentSpecCompositionData(data, path.dirname(filePath), { requireNoOpenDecisions: true });
  return {
    schema_version: 'p2a.spec.v1',
    project_id: data.project_id,
    source_intake: data.effective_spec_ref ?? 'current-spec.json',
    product: data.effective_product,
    implementation: data.effective_implementation,
    clarifying_question_disposition: [],
    open_decisions: [],
    approval: 'approved',
    evidence: currentSpecWebEvidence(data, path.dirname(filePath)),
  };
}

function statusMarkdown(projectId, iterationId, spec, taskGraph, review) {
  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
    `<!-- p2a:active-iteration=${iterationId} -->\n\n` +
    `> 정본: iterations/${iterationId}/gate-*/, current-spec.json\n` +
    `> 반복 목록 + 현재 활성 포인터.\n\n` +
    `## 현재\n` +
    `- 활성 기능 반복: ${iterationId} (active — 개발 중)\n` +
    `- maintenance: iterations/maintenance (상시, task-graph는 첫 fix 때 생성)\n` +
    `- current-spec: current-spec.json (→ ${iterationId})\n\n` +
    `## 반복 목록\n` +
    `| 반복 | 상태 | task | 게이트 | 위치 |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `| ${iterationId} | active | ${taskSummary(taskGraph)} | ${gateSummary(spec, taskGraph, review)} | iterations/${iterationId}/ |\n` +
    `| maintenance | 상시 active | 0 (graph 미생성) | — | iterations/maintenance/ |\n\n` +
    `## 다음\n` +
    `- 신규 기능 → 새 반복 open (baseline=current-spec.json)\n` +
    `- 작은 fix → maintenance에 append\n`;
}

function currentSpecPointer(projectId, iterationId, gateBApprovalAudit) {
  const currentSpec = {
    schema_version: 'p2a.current_spec.v1',
    project_id: projectId,
    composed_from: [iterationId],
    active_iteration: iterationId,
    effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    note: '반복 1개라 이 반복 spec이 곧 현재 유효 spec. 다중 반복 조합 규칙은 docs/iteration-spec.md에서 정식화.',
  };
  return gateBApprovalAudit
    ? currentSpecWithGateBApprovalAudit(currentSpec, iterationId, gateBApprovalAudit)
    : currentSpec;
}

function currentSpecForOpen(currentSpec, nextIterationId, previousIterationId, idea, openedAt) {
  return {
    ...currentSpec,
    active_iteration: nextIterationId,
    pending_iteration: {
      iteration_id: nextIterationId,
      status: 'active_planning',
      opened_at: openedAt,
      idea,
      baseline_iteration: previousIterationId,
      baseline_effective_spec_ref: currentSpec.effective_spec_ref,
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
    review_ref: reviewRef(iterationId),
    task_count: taskGraph.tasks?.length ?? 0,
    task_status_counts: countStatuses(taskGraph.tasks ?? []),
    artifact_hashes: artifactHashes(artifactRoot, closedIterationArtifactRefs(iterationId)),
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
    throw new ValidationError(`open requires active iteration ${JSON.stringify(iterationId)} to be archived by \`p2a_iteration close\``);
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
    throw new ValidationError('open requires current-spec.json composition after multiple closed iterations; run `p2a_iteration compose` first');
  }
  validateCurrentSpecCompositionData(currentSpec, artifactRoot, { requireNoOpenDecisions: true });
}

function maintenanceReadme() {
  return `# maintenance\n\n` +
    `작은 fix, 문서 수정, 패치성 변경을 append하는 상시 반복입니다.\n\n` +
    `task graph는 첫 fix가 생길 때 \`gate-c-task-graph/task-graph.json\`으로 생성합니다. ` +
    `빈 task graph는 \`.plan2agent/schemas/task-graph.schema.json\`의 \`tasks\` 최소 1개 제약을 위반하므로 만들지 않습니다.\n`;
}

function closeStatusMarkdown(projectId, iterationId, spec, taskGraph, review, closedAt, effectiveSpecRef) {
  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
    `<!-- p2a:active-iteration=${iterationId} -->\n\n` +
    `> 정본: iterations/${iterationId}/gate-*, current-spec.json\n` +
    `> 현재 반복은 close-ready 검증을 통과해 archived metadata가 기록되었습니다.\n\n` +
    `## 현재\n` +
    `- 활성 기능 반복: ${iterationId} (archived — 다음 반복 open 대기)\n` +
    `- maintenance: iterations/maintenance (상시, task-graph는 첫 fix 때 생성)\n` +
    `- current-spec: current-spec.json (baseline → ${effectiveSpecRef})\n` +
    `- closed_at: ${closedAt}\n\n` +
    `## 반복 목록\n` +
    `| 반복 | 상태 | task | 게이트 | 위치 |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `| ${iterationId} | archived | ${taskSummary(taskGraph)} | ${gateSummary(spec, taskGraph, review)} | iterations/${iterationId}/ |\n` +
    `| maintenance | 상시 active | 0 (graph 미생성) | — | iterations/maintenance/ |\n\n` +
    `## 다음\n` +
    `- 새 기능 → \`p2a_iteration open --iteration-id <next> --idea <text>\`\n` +
    `- 작은 fix → maintenance에 append\n`;
}

function openStatusMarkdown(projectId, activeIterationId, previousIterationId, previousTaskGraph, idea, openedAt, effectiveSpecRef) {
  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
    `<!-- p2a:active-iteration=${activeIterationId} -->\n\n` +
    `> 정본: iterations/${activeIterationId}/gate-*, current-spec.json\n` +
    `> 반복 목록 + 현재 활성 포인터.\n\n` +
    `## 현재\n` +
    `- 활성 기능 반복: ${activeIterationId} (active — 기획 중)\n` +
    `- 이전 기준 반복: ${previousIterationId} (close-ready)\n` +
    `- maintenance: iterations/maintenance (상시, task-graph는 첫 fix 때 생성)\n` +
    `- current-spec: current-spec.json (baseline → ${effectiveSpecRef})\n\n` +
    `## 열린 변경 아이디어\n` +
    `- opened_at: ${openedAt}\n` +
    `- idea: ${idea}\n\n` +
    `## 반복 목록\n` +
    `| 반복 | 상태 | task | 게이트 | 위치 |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `| ${previousIterationId} | close-ready | ${taskSummary(previousTaskGraph)} | B✅ C✅ D✅(blocker 0) | iterations/${previousIterationId}/ |\n` +
    `| ${activeIterationId} | active_planning | 0 (graph 미생성) | A/B/C/D 대기 | iterations/${activeIterationId}/ |\n` +
    `| maintenance | 상시 active | 0 (graph 미생성) | — | iterations/maintenance/ |\n\n` +
    `## 다음\n` +
    `- Gate A intake 산출물을 iterations/${activeIterationId}/gate-a-intake/에 작성한다.\n` +
    `- Gate B spec 산출물을 iterations/${activeIterationId}/gate-b-spec/에 작성한다.\n` +
    `- Gate C/D 산출물이 생기면 \`p2a_iteration validate\`로 검증한다.\n`;
}

function iterationReadme(iterationId, idea, previousIterationId, effectiveSpecRef) {
  return `# ${iterationId}\n\n` +
    `Status: active_planning\n\n` +
    `Baseline iteration: ${previousIterationId}\n\n` +
    `Baseline effective spec: ${effectiveSpecRef}\n\n` +
    `Change idea:\n\n${idea}\n\n` +
    `Expected artifacts:\n\n` +
    `- gate-a-intake/intake.json\n` +
    `- gate-a-intake/intake.md\n` +
    `- gate-b-spec/product-spec.md\n` +
    `- gate-b-spec/implementation-plan.md\n` +
    `- gate-b-spec/spec.json\n` +
    `- gate-c-task-graph/task-graph.json\n` +
    `- gate-d-review/review-report.md\n` +
    `- gate-d-review/review.json\n`;
}

function gateReadme(gateLabel, iterationId) {
  return `# ${gateLabel}\n\n` +
    `이 디렉터리는 ${iterationId} 반복의 ${gateLabel} 산출물을 작성하는 위치입니다.\n`;
}

function iterationMetadata(projectId, iterationId, previousIterationId, idea, openedAt, effectiveSpecRef) {
  return {
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
    },
    expected_artifacts: [
      'gate-a-intake/intake.json',
      'gate-a-intake/intake.md',
      'gate-b-spec/product-spec.md',
      'gate-b-spec/implementation-plan.md',
      'gate-b-spec/spec.json',
      'gate-c-task-graph/task-graph.json',
      'gate-d-review/review-report.md',
      'gate-d-review/review.json',
    ],
  };
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
    throw new Error('draft requires a planning iteration opened by `p2a_iteration open`; current-spec.json.pending_iteration is missing');
  }
  if (pending.iteration_id !== state.activeIteration) {
    throw new Error(`current-spec.json.pending_iteration.iteration_id must match active_iteration ${JSON.stringify(state.activeIteration)}`);
  }
  return pending;
}

function assertWritableDraftFiles(files, artifactRoot, force, options = {}) {
  const allowExisting = new Set(options.allowExisting ?? []);
  const existing = Object.entries(files)
    .filter(([key, filePath]) => !allowExisting.has(key) && existsSync(filePath))
    .map(([, filePath]) => filePath);
  if (existing.length && !force) {
    const summary = existing.map((filePath) => artifactRelativePath(artifactRoot, filePath)).join(', ');
    throw new Error(`Gate A/B draft files already exist: ${summary}. Re-run with --force to overwrite them.`);
  }
}

function draftIdea(args, pending, metadata) {
  const idea = args.idea ?? pending.idea ?? metadata.idea;
  if (!idea || idea.trim().length === 0) {
    throw new Error('draft requires --idea or an idea stored by `p2a_iteration open`');
  }
  return idea.trim();
}

function buildDeltaIntake({ projectId, iterationId, idea, baselineIteration, baselineSpecRef }) {
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
        statement: '이번 단계는 Gate A/B 초안을 생성하며 Gate C task graph와 Gate D review는 별도 단계에서 확정한다.',
        risk: 'low',
        confirmation_needed: false,
      },
    ],
    clarifying_questions: [],
    needs_user_decision: [],
    status: 'ready_for_spec',
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

function buildDeltaSpec({ projectId, iterationId, idea, baselineSpec, baselineSpecRef }) {
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
  return {
    schema_version: 'p2a.spec.v1',
    project_id: projectId,
    source_intake: '../gate-a-intake/intake.json',
    product: {
      problem: `Baseline problem: ${product.problem}\n\nIteration delta: ${idea}`,
      target_users: asStringArray(product.target_users),
      goals: appendUnique(product.goals, [
        `Deliver the iteration delta: ${idea}`,
      ]),
      non_goals: appendUnique(product.non_goals, [
        'Do not rewrite baseline behavior outside the change idea unless compatibility requires it.',
      ]),
      core_flows: appendUnique(product.core_flows, [
        `Iteration ${iterationId} delta flow: ${idea}`,
      ]),
      screens_or_interfaces: appendUnique(product.screens_or_interfaces, [
        `New or changed user/developer-facing interface required by iteration ${iterationId}: ${idea}`,
      ]),
      data_model_draft: appendUnique(product.data_model_draft, [
        `Delta data model changes needed to support iteration ${iterationId}: ${idea}`,
      ]),
      external_integrations: asStringArray(product.external_integrations),
      success_criteria: appendUnique(product.success_criteria, [
        `The iteration satisfies the change idea without regressing baseline success criteria: ${idea}`,
      ]),
      constraints: appendUnique(product.constraints, [
        'Baseline constraints remain in force unless this iteration explicitly changes them.',
      ]),
    },
    implementation: {
      architecture: appendUnique(implementation.architecture, [
        `Implement the delta as an additive change on top of the current baseline architecture: ${idea}`,
      ]),
      interfaces: appendUnique(implementation.interfaces, [
        `Update or add only the interfaces needed for iteration ${iterationId}: ${idea}`,
      ]),
      data_flow: appendUnique(implementation.data_flow, [
        `Preserve baseline data flow and add delta-specific flow where required by: ${idea}`,
      ]),
      dependencies: appendUnique(implementation.dependencies, [
        'Reuse baseline dependencies unless the delta requires an explicit addition.',
      ]),
      edge_cases: appendUnique(implementation.edge_cases, [
        `Baseline behavior must remain compatible while introducing: ${idea}`,
      ]),
      verification: appendUnique(implementation.verification, [
        `Add regression coverage for baseline behavior touched by this iteration and acceptance coverage for: ${idea}`,
      ]),
    },
    clarifying_question_disposition: [],
    open_decisions: [],
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
  };
}

function buildInitialSpec({ projectId, iterationId, idea, intake }) {
  const facts = asStringArray(intake.known_facts);
  const assumptions = Array.isArray(intake.assumptions)
    ? intake.assumptions
        .map((assumption) => assumption?.statement)
        .filter((statement) => typeof statement === 'string' && statement.trim().length > 0)
    : [];
  const clarifyingQuestions = Array.isArray(intake.clarifying_questions) ? intake.clarifying_questions : [];
  return {
    schema_version: 'p2a.spec.v1',
    project_id: projectId,
    source_intake: '../gate-a-intake/intake.json',
    product: {
      problem: intake.summary || idea,
      target_users: [
        'Primary users and stakeholders described by the Gate A intake.',
      ],
      goals: appendUnique(facts.slice(0, 6), [
        `Deliver the first iteration scope for ${iterationId}: ${idea}`,
      ]),
      non_goals: [
        'Do not expand beyond the approved first-iteration scope without opening a follow-up decision.',
        'Do not treat unresolved clarification questions as final requirements until they are explicitly approved or converted into assumptions.',
      ],
      core_flows: [
        `A target user follows the first-iteration flow implied by the idea: ${idea}`,
        'The system accepts the primary input or trigger described by the intake and returns the expected first-iteration outcome.',
        'Operators or developers can verify the first-iteration behavior through the planned verification surface.',
      ],
      screens_or_interfaces: [
        'Primary user-facing, developer-facing, or service-facing interface required by the first iteration.',
        'Configuration or setup surface needed to run the first iteration safely.',
        'Verification or observability surface needed to confirm first-iteration behavior.',
      ],
      data_model_draft: [
        'Core entities, inputs, outputs, and state required by the first iteration.',
        'Identifiers, timestamps, ownership fields, or status fields needed to support the first-iteration workflow.',
      ],
      external_integrations: [
        'External systems explicitly named by the intake.',
        'No additional external integration unless required by approved assumptions or decisions.',
      ],
      success_criteria: [
        'The first-iteration workflow can be executed end to end from the primary interface.',
        'The implementation satisfies the approved intake facts and explicitly documented assumptions.',
        'Unresolved clarification questions are either answered before approval or tracked as open decisions.',
        'Verification covers the main success path and at least one relevant failure or edge case.',
      ],
      constraints: appendUnique(assumptions, [
        'Keep the first iteration narrowly scoped to the approved intake.',
        'Prefer additive implementation choices that do not block future iterations.',
        'Document any risky assumption before Gate B approval.',
      ]),
    },
    implementation: {
      architecture: [
        'Implement the smallest architecture that can satisfy the first-iteration workflow and verification criteria.',
        'Separate core domain behavior from integration, configuration, and verification concerns where the target project structure supports it.',
      ],
      interfaces: [
        'Define the primary interface contract needed by the first iteration.',
        'Define any setup, configuration, or operational contract needed to run and verify the first iteration.',
      ],
      data_flow: [
        'Primary input enters through the selected interface, is validated, and is transformed into the first-iteration output or state change.',
        'Errors and unsupported cases return a predictable result and are visible to tests or verification steps.',
      ],
      dependencies: [
        'Use the target project runtime and dependency conventions.',
        'Add new dependencies only when they are required by the approved first-iteration scope.',
      ],
      edge_cases: [
        'Required input is missing, malformed, or outside the approved first-iteration scope.',
        'Repeated or duplicate execution should have a documented behavior.',
        'Downstream or integration failure should not leave the system in an ambiguous state.',
      ],
      verification: [
        'Unit or contract tests for the primary first-iteration behavior.',
        'Regression tests for any existing behavior touched by the first iteration.',
        'A documented manual or automated verification step for the end-to-end workflow.',
      ],
    },
    clarifying_question_disposition: clarifyingQuestions.map((question) => ({
      id: question.id,
      status: 'assumed',
      rationale: 'Initial Gate B draft keeps this question as an explicit implementation assumption unless the user overrides it before approval.',
      affects: question.blocks,
      assumption: question.question,
    })),
    open_decisions: [],
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
  };
}

function renderIntakeMarkdown(intake) {
  return `# Intake\n\n` +
    `## Idea\n\n${intake.idea}\n\n` +
    `## Summary\n\n${intake.summary}\n\n` +
    `## Known Facts\n\n${markdownList(intake.known_facts)}\n\n` +
    `## Assumptions\n\n${markdownList(intake.assumptions.map((item) => `${item.id}: ${item.statement} (risk: ${item.risk})`))}\n\n` +
    `## Decisions\n\nNo open user decisions in the generated draft.\n`;
}

function renderProductSpecMarkdown(spec, { iterationId, idea, baselineSpecRef }) {
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
    `## Success Criteria\n\n${markdownList(spec.product.success_criteria)}\n`;
}

function renderImplementationPlanMarkdown(spec, { iterationId, idea, baselineSpecRef }) {
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

function iterationMetadataForDraft(metadata, idea, draftedAt, artifacts) {
  return {
    ...metadata,
    status: 'gate_b_draft',
    idea,
    drafted_at: draftedAt,
    draft_artifacts: artifacts,
  };
}

function iterationMetadataForPromotedSpec(metadata, projectId, iterationId, promotedAt, artifacts) {
  return {
    ...(metadata ?? {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: projectId,
      iteration_id: iterationId,
    }),
    project_id: metadata?.project_id ?? projectId,
    iteration_id: metadata?.iteration_id ?? iterationId,
    status: 'gate_b_approved',
    promoted_at: promotedAt,
    approved_spec_artifacts: artifacts,
  };
}

function iterationMetadataForClose(metadata, projectId, iterationId, closedAt, record) {
  return {
    ...(metadata ?? {
      schema_version: 'p2a.iteration_metadata.v1',
      project_id: projectId,
      iteration_id: iterationId,
    }),
    project_id: metadata?.project_id ?? projectId,
    iteration_id: metadata?.iteration_id ?? iterationId,
    status: 'archived',
    closed_at: closedAt,
    close: record,
  };
}

function draftStatusMarkdown(projectId, activeIterationId, baselineIterationId, idea, openedAt, draftedAt, effectiveSpecRef) {
  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
    `<!-- p2a:active-iteration=${activeIterationId} -->\n\n` +
    `> 정본: iterations/${activeIterationId}/gate-*, current-spec.json\n` +
    `> 현재 effective spec은 baseline을 가리키며, 이번 반복 spec은 Gate B draft 상태입니다.\n\n` +
    `## 현재\n` +
    `- 활성 기능 반복: ${activeIterationId} (gate_b_draft — 기획 중)\n` +
    `- 이전 기준 반복: ${baselineIterationId}\n` +
    `- current-spec: current-spec.json (effective baseline → ${effectiveSpecRef})\n\n` +
    `## 열린 변경 아이디어\n` +
    `- opened_at: ${openedAt ?? 'unknown'}\n` +
    `- drafted_at: ${draftedAt}\n` +
    `- idea: ${idea}\n\n` +
    `## 산출물\n` +
    `- Gate A intake: iterations/${activeIterationId}/gate-a-intake/intake.json\n` +
    `- Gate B spec: iterations/${activeIterationId}/gate-b-spec/spec.json (approval=draft)\n` +
    `- Gate C task graph: 대기\n` +
    `- Gate D review: 대기\n\n` +
    `## 다음\n` +
    `- Gate B draft를 검토하고 승인 상태로 전환한다.\n` +
    `- 승인 후 Gate C task graph와 Gate D review를 생성한다.\n` +
    `- Gate C/D 산출물이 생기면 \`p2a_iteration validate\`로 검증한다.\n`;
}

function sourceSpecRef(iterationId) {
  return `iterations/${iterationId}/gate-b-spec/spec.json`;
}

function taskGraphRef(iterationId) {
  return `iterations/${iterationId}/gate-c-task-graph/task-graph.json`;
}

function reviewRef(iterationId) {
  return `iterations/${iterationId}/gate-d-review/review.json`;
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
  return changes;
}

function keywordHits(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword)).length;
}

function semanticAreaScore(area, change) {
  if (area.id === 'verification' && change.specRef === 'implementation.verification') return 100;
  if (area.id === 'requirements' && change.specRef === 'clarifying_question_disposition') return 100;
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

function taskGraphFromSpecChanges({ projectId, iterationId, activeSpec, baselineSpec, baselineRef, existingTaskGraph = null, historicalTasks = [] }) {
  const detailedChanges = collectDetailedSpecChanges(baselineSpec, activeSpec);
  const groups = addSyntheticVerificationGroup(semanticGroupsFromChanges(activeSpec, detailedChanges));
  const tasks = semanticTasksFromGroups({
    projectId,
    iterationId,
    groups,
    baselineRef,
    existingTaskGraph,
    historicalTasks,
  });
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
    const reviewPath = path.join(artifactRoot, reviewRef(iterationId));
    if (!existsSync(specPath)) {
      skipped.push({ iteration_id: iterationId, reason: 'missing spec.json' });
      continue;
    }

    const spec = validateSpec(specPath);
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
    if (!existsSync(reviewPath)) {
      skipped.push({ iteration_id: iterationId, reason: 'missing review.json' });
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
    validateReviewPass(reviewPath);
    const metadata = loadOptionalIterationMetadata(artifactRoot, iterationId);
    sources.push({
      iteration_id: iterationId,
      spec_ref: sourceSpecRef(iterationId),
      task_graph_ref: taskGraphRef(iterationId),
      review_ref: reviewRef(iterationId),
      status: inferSourceStatus({
        iterationId,
        activeIteration: currentSpec.active_iteration,
        metadata,
        taskGraph,
      }),
      approval: spec.approval,
      spec,
      metadata,
    });
  }

  return { sources, skipped };
}

function sourceFieldRef(source, section, field) {
  return `${source.spec_ref}#${section}.${field}`;
}

function compositionBaselineRef(source) {
  return source.metadata?.baseline?.effective_spec_ref ?? null;
}

function isCurrentSpecReference(reference) {
  return normalizeDisplayPath(reference ?? '').replace(/^\.\//, '') === 'current-spec.json';
}

function hasStaleCompositionBaseline(source, appliedSources) {
  const baselineRef = compositionBaselineRef(source);
  if (!baselineRef || isCurrentSpecReference(baselineRef)) return false;
  const lastAppliedSource = appliedSources[appliedSources.length - 1];
  return normalizeDisplayPath(baselineRef) !== lastAppliedSource.spec_ref;
}

function applySectionComposition({
  effectiveSection,
  fieldSources,
  nextSource,
  section,
  fields,
  supersededRefs,
  compositionConflicts,
  staleBaseline,
}) {
  for (const field of fields) {
    const nextValue = nextSource.spec[section][field];
    if (jsonEqual(effectiveSection[field], nextValue)) continue;
    const previousSource = fieldSources[field];
    if (staleBaseline) {
      compositionConflicts.push({
        field: `${section}.${field}`,
        reason: 'stale_baseline',
        baseline_ref: compositionBaselineRef(nextSource),
        current_ref: previousSource.spec_ref,
        sources: [
          sourceFieldRef(previousSource, section, field),
          sourceFieldRef(nextSource, section, field),
        ],
      });
      continue;
    }
    supersededRefs.push({
      field: `${section}.${field}`,
      superseded_iteration: previousSource.iteration_id,
      superseded_ref: sourceFieldRef(previousSource, section, field),
      replaced_by_iteration: nextSource.iteration_id,
      replaced_by_ref: sourceFieldRef(nextSource, section, field),
    });
    effectiveSection[field] = cloneJson(nextValue);
    fieldSources[field] = nextSource;
  }
}

function buildComposedCurrentSpec(previousCurrentSpec, sources, skipped) {
  if (sources.length < 2) {
    throw new ValidationError('compose requires at least two approved close-ready iteration specs; thin pointer remains sufficient');
  }
  const firstSource = sources[0];
  const effectiveProduct = cloneJson(firstSource.spec.product);
  const effectiveImplementation = cloneJson(firstSource.spec.implementation);
  const productSources = Object.fromEntries(PRODUCT_FIELDS.map((field) => [field, firstSource]));
  const implementationSources = Object.fromEntries(IMPLEMENTATION_FIELDS.map((field) => [field, firstSource]));
  const supersededRefs = [];
  const compositionConflicts = [];
  const appliedSources = [firstSource];

  for (const nextSource of sources.slice(1)) {
    const staleBaseline = hasStaleCompositionBaseline(nextSource, appliedSources);
    applySectionComposition({
      effectiveSection: effectiveProduct,
      fieldSources: productSources,
      nextSource,
      section: 'product',
      fields: PRODUCT_FIELDS,
      supersededRefs,
      compositionConflicts,
      staleBaseline,
    });
    applySectionComposition({
      effectiveSection: effectiveImplementation,
      fieldSources: implementationSources,
      nextSource,
      section: 'implementation',
      fields: IMPLEMENTATION_FIELDS,
      supersededRefs,
      compositionConflicts,
      staleBaseline,
    });
    appliedSources.push(nextSource);
  }

  const openDecisions = compositionConflicts.map((conflict, index) => ({
    id: `CD-${index + 1}`,
    type: 'composition_conflict',
    question: `Resolve current-spec composition conflict for ${conflict.field}`,
    affects: [conflict.field],
    status: 'open',
    sources: conflict.sources,
  }));
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
  if (pending && !composedIterationIds.includes(pending.iteration_id)) {
    composedCurrentSpec.pending_iteration = pending;
  }

  return composedCurrentSpec;
}

function validateCurrentSpecCompositionData(currentSpec, artifactRoot, options = {}) {
  const openDecisions = currentSpec.open_decisions ?? [];
  if (!Array.isArray(openDecisions)) throw new ValidationError('current-spec.json open_decisions must be an array');
  if (options.requireNoOpenDecisions && openDecisions.length) {
    throw new ValidationError(`current-spec.json has unresolved open_decisions: ${JSON.stringify(openDecisions.map((decision) => decision.id ?? decision))}`);
  }

  const hasCompositionFields = Object.hasOwn(currentSpec, 'source_specs')
    || Object.hasOwn(currentSpec, 'effective_product')
    || Object.hasOwn(currentSpec, 'effective_implementation')
    || currentSpec.effective_spec_ref === 'current-spec.json';
  if (!hasCompositionFields) return currentSpec;

  if (!Array.isArray(currentSpec.source_specs) || !currentSpec.source_specs.length) {
    throw new ValidationError('current-spec.json source_specs must be a non-empty array for composition');
  }
  if (!Array.isArray(currentSpec.composed_from) || !currentSpec.composed_from.length) {
    throw new ValidationError('current-spec.json composed_from must be a non-empty array for composition');
  }
  const sourceIterationIds = currentSpec.source_specs.map((source) => source.iteration_id);
  if (JSON.stringify(sourceIterationIds) !== JSON.stringify(currentSpec.composed_from)) {
    throw new ValidationError('current-spec.json composed_from must match source_specs iteration order');
  }
  validateEffectiveSections(currentSpec.effective_product, currentSpec.effective_implementation);

  for (const source of currentSpec.source_specs) {
    assertString(source.iteration_id, 'current-spec.json source_specs[].iteration_id');
    assertString(source.spec_ref, `current-spec.json source_specs ${source.iteration_id}.spec_ref`);
    const specPath = resolveArtifactFileReference(source.spec_ref, artifactRoot);
    assertFile(specPath, `current-spec.json source_specs ${source.iteration_id}.spec_ref`);
    const spec = validateSpec(specPath);
    if (spec.project_id !== currentSpec.project_id) {
      throw new ValidationError(`current-spec.json source_specs ${source.iteration_id} project_id mismatch`);
    }
    if (source.approval && source.approval !== spec.approval) {
      throw new ValidationError(`current-spec.json source_specs ${source.iteration_id} approval does not match source spec`);
    }
  }

  return currentSpec;
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
  console.log(`- rebase task-graph.sourceSpec -> ${INIT_REBASED_SOURCE_SPEC}: ${toRelativeFromRoot(plan.movedTaskGraph)}`);
  for (const write of plan.writes) {
    console.log(`- ${write.description}: ${toRelativeFromRoot(write.path)}`);
  }
}

function rebaseMovedTaskGraphSourceSpec(source) {
  const sourceText = readFileSync(source, 'utf8');
  const rewritten = sourceText.replace(/(\"sourceSpec\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"/, `$1${JSON.stringify(INIT_REBASED_SOURCE_SPEC)}`);
  if (rewritten === sourceText) throw new Error(`could not rebase sourceSpec in ${source}`);
  writeFileSync(source, rewritten);
  return sourceText;
}

function applyPlan(paths, iterationId, plan) {
  const moved = [];
  let originalMovedTaskGraph = null;
  try {
    mkdirSync(paths.iterationRoot, { recursive: true });
    for (const move of plan.moves) {
      renameSync(move.from, move.to);
      moved.push(move);
    }
    originalMovedTaskGraph = rebaseMovedTaskGraphSourceSpec(paths.movedTaskGraph);
    const movedFacts = validateMoved(paths);
    const projectId = projectIdFrom(paths.artifactRoot, movedFacts.spec, movedFacts.taskGraph);
    const currentSpec = currentSpecPointer(projectId, iterationId, plan.gateBApprovalAudit);
    mkdirSync(paths.maintenanceRoot, { recursive: true });
    writeJson(paths.currentSpec, currentSpec);
    writeIterationStatus(paths.artifactRoot, currentSpec);
    writeFileSync(paths.maintenanceReadme, maintenanceReadme());
  } catch (error) {
    if (originalMovedTaskGraph !== null && existsSync(paths.movedTaskGraph)) {
      writeFileSync(paths.movedTaskGraph, originalMovedTaskGraph);
    }
    for (const move of moved.reverse()) {
      if (existsSync(move.to) && !existsSync(move.from)) renameSync(move.to, move.from);
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
  const review = validateReviewPass(paths.movedReviewJson);
  return { spec, taskGraph, review };
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
  console.log('Moved artifacts revalidated: spec approved, task graph valid, review passed, Gate B approval audit present.');
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

function loadReadyIterationFacts(artifactRoot) {
  const state = resolveIterationState(artifactRoot);
  const spec = validateSpec(state.specPath);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  const review = validateReviewPass(state.reviewPath);
  return { state, spec, taskGraph, review };
}

function activeIntakePath(state) {
  return path.join(state.iterationRoot, 'gate-a-intake', 'intake.json');
}

function validateActiveSpecWithOptionalIntake(state) {
  const intakePath = activeIntakePath(state);
  return existsSync(intakePath)
    ? validateSpec(state.specPath, intakePath)
    : validateSpec(state.specPath);
}

function inferPlanningStage(state) {
  if (existsSync(state.taskGraphPath) && existsSync(state.reviewPath) && existsSync(state.specPath)) return 'ready';
  if (existsSync(state.specPath)) {
    const spec = validateActiveSpecWithOptionalIntake(state);
    return spec.approval === 'approved' ? 'gate-b-approved' : 'gate-b-draft';
  }
  return 'gate-a';
}

function validatePlanningIteration(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  validateStatusDoc(state.statusPath);
  validateCurrentSpecCompositionData(state.currentSpec, state.artifactRoot, { requireNoOpenDecisions: true });
  const stage = args.stage ?? inferPlanningStage(state);
  if (stage === 'ready') return validateIteration({ ...args, stage: null, allowPlanning: false });

  const pendingStatus = state.currentSpec.pending_iteration?.status;
  const allowedPendingStatuses = new Set(['active_planning', 'gate_a_ready', 'gate_b_draft', 'gate_b_approved']);
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
    console.log(`Plan2Agent gate-c draft valid: ${draft.tasks.length} task(s)`);
    return 0;
  }

  if (stage === 'gate-a') {
    assertFile(intakePath, `iterations/${state.activeIteration}/gate-a-intake/intake.json`);
    const intake = validateIntake(intakePath);
    console.log(`Plan2Agent planning iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
    console.log(`- active iteration: ${state.activeIteration}`);
    console.log(`- stage: gate-a`);
    console.log(`- intake: status=${intake.status}`);
    console.log('- Gate B-D artifacts are pending');
    return 0;
  }

  if (stage !== 'gate-b-draft' && stage !== 'gate-b-approved') {
    throw new Error(`unsupported planning validation stage: ${stage}`);
  }
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  const spec = validateActiveSpecWithOptionalIntake(state);
  if (stage === 'gate-b-approved' && spec.approval !== 'approved') {
    throw new ValidationError(`--stage gate-b-approved requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (stage === 'gate-b-approved') {
    validateStatusApprovalAudit(state.statusPath, spec);
  }
  if (stage === 'gate-b-draft' && spec.approval === 'approved') {
    throw new ValidationError('--stage gate-b-draft expected a non-approved spec; use --stage gate-b-approved for approved Gate B');
  }

  console.log(`Plan2Agent planning iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- stage: ${stage}`);
  console.log(`- spec: approval=${spec.approval}`);
  console.log('- Gate C/D artifacts are pending');
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

function parseGateCApprovalAudit(statusPath) {
  const text = readFileSync(statusPath, 'utf8');
  const headingMatch = text.match(/^#{3,6}\s+Gate C approval audit\s*$/im);
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
    approved_source: get('Approved source'),
    authoring_agent: get('Authoring agent'),
    approval_note: get('Approval note'),
  };
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
    baseline_effective_spec_ref: state.currentSpec.effective_spec_ref ?? null,
    source_idea: state.currentSpec.pending_iteration?.idea ?? null,
    draft_sha256: fileSha256(draftPath),
    source_spec_sha256: existsSync(state.specPath) ? fileSha256(state.specPath) : null,
    promoted_at: promotedAt,
    gate_c_approval_audit: parseGateCApprovalAudit(state.statusPath),
  };
}

function summarizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    targetArea: task.targetArea,
    sourceSpecRefs: task.sourceSpecRefs,
  };
}

function summarizeTaskGraphIfPresent(graphPath) {
  if (!existsSync(graphPath)) return [];
  return (loadJson(graphPath).tasks ?? []).map(summarizeTask);
}

function loadContextEffectiveSpec(state) {
  if (state.currentSpec.effective_product && state.currentSpec.effective_implementation) {
    return {
      product: cloneJson(state.currentSpec.effective_product),
      implementation: cloneJson(state.currentSpec.effective_implementation),
    };
  }
  const fallbackPath = existsSync(state.effectiveSpecPath) ? state.effectiveSpecPath : state.specPath;
  const data = loadJson(fallbackPath);
  return {
    product: cloneJson(data.product ?? {}),
    implementation: cloneJson(data.implementation ?? {}),
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
    : loadEffectiveBaselineSpec(state.effectiveSpecPath);
  return collectSpecFieldChanges(baselineSpec, activeSpec);
}

const CODE_SIGNAL_FILE_TREE_LIMIT = 300;
const CODE_SIGNAL_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.plan2agent',
  'artifacts',
  'runs',
  'build',
  'dist',
  'out',
  'target',
  '.gradle',
  '.idea',
  'scripts',
  'schemas',
  '.claude',
  '.codex',
  '.gemini',
  '.agents',
]);

function collectCodeFileTree(codeRoot, limit = CODE_SIGNAL_FILE_TREE_LIMIT) {
  const root = path.resolve(process.cwd(), codeRoot);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    return { code_root: null, file_tree: [], truncated: false };
  }
  const fileTree = [];
  let truncated = false;

  function visit(dirPath) {
    if (truncated) return;
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (!CODE_SIGNAL_EXCLUDED_DIRS.has(entry.name)) visit(path.join(dirPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = normalizeDisplayPath(path.relative(root, path.join(dirPath, entry.name)));
      if (!relative || relative.startsWith('..')) continue;
      if (fileTree.length >= limit) {
        truncated = true;
        return;
      }
      fileTree.push(relative);
    }
  }

  visit(root);
  return {
    code_root: normalizeDisplayPath(toRelativeFromRoot(root)),
    file_tree: fileTree,
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

function context(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const effectiveSpec = loadContextEffectiveSpec(state);
  const contextData = {
    schema_version: 'p2a.task_context.v1',
    project_id: state.projectId,
    active_iteration: state.activeIteration,
    scope: 'feature',
    idea: args.idea ?? state.currentSpec.pending_iteration?.idea ?? null,
    baseline_effective_spec_ref: state.currentSpec.effective_spec_ref ?? null,
    effective_spec: effectiveSpec,
    existing_tasks: {
      active: summarizeTaskGraphIfPresent(state.taskGraphPath),
      maintenance: summarizeTaskGraphIfPresent(maintenanceTaskGraphPath(state.artifactRoot)),
    },
    spec_field_changes: contextSpecFieldChanges(state),
    code_signals: collectCodeSignals(args, state),
  };
  validateTaskContextData(contextData);
  console.log(JSON.stringify(contextData, null, 2));
  return 0;
}

function validateMaintenanceTaskGraphIfPresent(artifactRoot) {
  const graphPath = maintenanceTaskGraphPath(artifactRoot);
  if (!existsSync(graphPath)) return null;
  const graph = validateTaskGraph(graphPath);
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

function addMaintenanceTask(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const graphPath = maintenanceTaskGraphPath(state.artifactRoot);
  const graph = existsSync(graphPath)
    ? loadJson(graphPath)
    : initialMaintenanceTaskGraph(state.projectId);
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

  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeJson(graphPath, graph);
  writeIterationStatus(state.artifactRoot, state.currentSpec);
  console.log(`Plan2Agent maintenance task added: ${task.id}`);
  console.log(`- graph: ${toRelativeFromRoot(graphPath)}`);
  console.log(`- tasks: ${graph.tasks.length}`);
  return 0;
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
  for (const closed of closedIterations) {
    if (!closed?.iteration_id) throw new ValidationError('current-spec.json closed_iterations entries must include iteration_id');
    if (!closed.artifact_hashes || typeof closed.artifact_hashes !== 'object' || Array.isArray(closed.artifact_hashes)) {
      throw new ValidationError(`closed iteration ${closed.iteration_id} is missing artifact_hashes; re-close or migrate audit metadata`);
    }
    for (const [reference, expectedAudit] of Object.entries(closed.artifact_hashes)) {
      const filePath = resolveArtifactFileReference(reference, artifactRoot);
      if (typeof expectedAudit === 'string') {
        assertFile(filePath, `closed iteration artifact ${reference}`);
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
  const spec = validateActiveSpecWithOptionalIntake(state);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  validateReviewPass(state.reviewPath);
  if (args.requireCloseReady) assertCloseReadyTasks(taskGraph);
  const maintenance = validateMaintenanceTaskGraphIfPresent(state.artifactRoot);
  const archivedAuditCount = args.skipArchiveAudit ? null : auditArchivedIterations(state.currentSpec, state.artifactRoot);

  const statusCounts = countStatuses(taskGraph.tasks);
  console.log(`Plan2Agent iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- spec: approved=${spec.approval}`);
  console.log(`- task graph: ${taskGraph.tasks.length} task(s), todo ${statusCounts.todo}·in_progress ${statusCounts.in_progress}·done ${statusCounts.done}·blocked ${statusCounts.blocked}`);
  console.log('- review: no blocking issues');
  if (args.requireCloseReady) console.log('- close-ready: all tasks done');
  if (maintenance) console.log(`- maintenance: ${maintenance.graph.tasks.length} task(s) valid`);
  if (archivedAuditCount !== null) console.log(`- archived audit: ${archivedAuditCount} closed iteration(s) verified`);
  else console.log('- archived audit: skipped');
  return 0;
}

function close(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const requestedIteration = args.iterationIdProvided ? args.iterationId : 'active';
  if (requestedIteration !== 'active') assertSafeIterationId(requestedIteration);

  const facts = loadReadyIterationFacts(artifactRoot);
  assertCloseReadyTasks(facts.taskGraph);

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
  const metadata = iterationMetadataForClose(
    loadOptionalIterationMetadata(artifactRoot, facts.state.activeIteration),
    facts.state.projectId,
    facts.state.activeIteration,
    closedAt,
    record,
  );

  const nextCurrentSpec = currentSpecForClose(facts.state.currentSpec, facts.state.activeIteration, record);
  writeJson(iterationMetadataPath(artifactRoot, facts.state.activeIteration), metadata);
  writeJson(facts.state.currentSpecPath, nextCurrentSpec);
  writeIterationStatus(artifactRoot, nextCurrentSpec);

  console.log(`Plan2Agent iteration closed: ${toRelativeFromRoot(facts.state.iterationRoot)}`);
  console.log(`- active iteration: ${facts.state.activeIteration}`);
  console.log(`- status: archived`);
  console.log(`- closed_at: ${closedAt}`);
  console.log('Active pointer remains on the closed baseline so `p2a_iteration open` can create the next iteration.');
  return 0;
}

function activeSpecArtifacts(artifactRoot, iterationId) {
  const iterationRoot = path.join(artifactRoot, 'iterations', iterationId);
  return {
    spec_ref: sourceSpecRef(iterationId),
    product_spec_ref: artifactRelativePath(artifactRoot, path.join(iterationRoot, 'gate-b-spec', 'product-spec.md')),
    implementation_plan_ref: artifactRelativePath(artifactRoot, path.join(iterationRoot, 'gate-b-spec', 'implementation-plan.md')),
  };
}

function promoteSpec(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  const spec = validateActiveSpecWithOptionalIntake(state);
  if (spec.approval !== 'approved') {
    throw new ValidationError(`promote-spec requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError('promote-spec requires spec.open_decisions to be empty');
  }

  const promotedAt = new Date().toISOString();
  const artifacts = activeSpecArtifacts(state.artifactRoot, state.activeIteration);
  const gateBApprovalAudit = gateBApprovalAuditForIteration(
    null,
    state.activeIteration,
    'Gate B approval recorded by p2a_iteration promote-spec after approved spec with no open decisions.',
    promotedAt,
  );
  const nextCurrentSpec = currentSpecForPromotedSpec(
    state.currentSpec,
    state.activeIteration,
    promotedAt,
    artifacts,
    gateBApprovalAudit,
  );
  writeJson(state.currentSpecPath, nextCurrentSpec);
  writeJson(
    iterationMetadataPath(state.artifactRoot, state.activeIteration),
    iterationMetadataForPromotedSpec(
      loadOptionalIterationMetadata(state.artifactRoot, state.activeIteration),
      state.projectId,
      state.activeIteration,
      promotedAt,
      artifacts,
    ),
  );
  writeIterationStatus(state.artifactRoot, nextCurrentSpec);

  const promotedState = resolveIterationState(artifactRoot, { requireReady: false });
  console.log(`Plan2Agent active spec promoted: ${toRelativeFromRoot(state.specPath)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- approval: ${spec.approval}`);
  console.log(`- effective spec: ${promotedState.currentSpec.effective_spec_ref ?? 'unchanged'}`);
  return 0;
}

function assertGateCApprovalAudit(statusPath) {
  const text = readFileSync(statusPath, 'utf8');
  const required = [
    /^#{3,6}\s+Gate C approval audit\s*$/im,
    /Approved by:\s*\S+/i,
    /Approved at:\s*\d{4}-\d{2}-\d{2}/i,
    /Approved source:\s*\S+/i,
    /Approval note:\s*\S+/i,
  ];
  if (!required.every((pattern) => pattern.test(text))) {
    throw new ValidationError('Gate C approval audit block required in status.md before promote-tasks');
  }
}

function canonicalDraftVersion(version) {
  return typeof version === 'string' && version.endsWith('-draft')
    ? version.slice(0, -'-draft'.length)
    : version;
}

function promoteTasks(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const draftPath = gateCTaskGraphDraftPath(state);
  if (!existsSync(draftPath)) throw new ValidationError(`gate-c draft not found; author one at ${draftPath} first`);
  const draft = loadJson(draftPath);
  validateTaskGraphData(draft, state.specPath);
  assertGateCApprovalAudit(state.statusPath);
  const promotedAt = new Date().toISOString();
  const metaPath = gateCTaskGraphDraftMetaPath(state);
  writeJson(metaPath, taskDraftProvenance(state, draftPath, promotedAt));

  const promoted = {
    ...draft,
    version: canonicalDraftVersion(draft.version),
  };
  writeJson(state.taskGraphPath, promoted);
  renameSync(draftPath, `${draftPath}.promoted`);
  writeIterationStatus(state.artifactRoot, state.currentSpec);

  console.log(`Plan2Agent tasks promoted: ${promoted.tasks.length} task(s)`);
  console.log(`- graph: ${toRelativeFromRoot(state.taskGraphPath)}`);
  console.log('- promoted from: task-graph.draft.json');
  console.log(`- provenance: ${toRelativeFromRoot(metaPath)}`);
  return 0;
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
    baselineSpec: loadEffectiveBaselineSpec(baselinePath),
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

function diffTasks(args) {
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

  const taskGraphPath = state.taskGraphPath;
  if (existsSync(taskGraphPath) && !args.force) {
    throw new Error(`task graph already exists: ${taskGraphPath}; use --force to overwrite`);
  }
  const { baselineSpec, baselineRef } = loadDiffBaseline(state);
  const existingTaskGraph = args.force ? loadExistingTaskGraphIfPresent(taskGraphPath) : null;
  const graph = taskGraphFromSpecChanges({
    projectId: state.projectId,
    iterationId: state.activeIteration,
    activeSpec,
    baselineSpec,
    baselineRef,
    existingTaskGraph,
    historicalTasks: historicalCompletedTasks(state),
  });
  validateTaskGraphData(graph, state.specPath);
  mkdirSync(path.dirname(taskGraphPath), { recursive: true });
  writeJson(taskGraphPath, graph);

  const stats = semanticGraphStats(graph);
  console.log(`Plan2Agent diff task graph generated: ${toRelativeFromRoot(taskGraphPath)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- baseline: ${baselineRef ?? 'none'}`);
  console.log(`- semantic groups: ${stats.groups.join(', ')}`);
  console.log(`- rework groups: ${stats.rework}`);
  console.log(`- reused active tasks: ${stats.reused}`);
  console.log(`- tasks: ${graph.tasks.length}`);
  return 0;
}

function open(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  assertSafeIterationId(args.iterationId);
  const idea = args.idea.trim();
  const facts = loadReadyIterationFacts(artifactRoot);
  assertCloseReadyTasks(facts.taskGraph);
  assertArchivedBaselineForOpen(facts.state.currentSpec, artifactRoot, facts.state.activeIteration);

  if (facts.state.activeIteration === args.iterationId) {
    throw new Error(`--iteration-id must differ from current active iteration ${JSON.stringify(facts.state.activeIteration)}`);
  }

  const iterationRoot = path.join(artifactRoot, 'iterations', args.iterationId);
  if (existsSync(iterationRoot)) throw new Error(`iteration already exists: ${iterationRoot}`);

  const openedAt = new Date().toISOString();
  const projectId = facts.state.projectId;
  const effectiveSpecRef = facts.state.currentSpec.effective_spec_ref;
  const gateDirs = GATE_DIRS.map((gate) => path.join(iterationRoot, gate));
  for (const gateDir of gateDirs) mkdirSync(gateDir, { recursive: true });

  writeFileSync(
    path.join(iterationRoot, 'iteration.json'),
    `${JSON.stringify(iterationMetadata(projectId, args.iterationId, facts.state.activeIteration, idea, openedAt, effectiveSpecRef), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(iterationRoot, 'README.md'),
    iterationReadme(args.iterationId, idea, facts.state.activeIteration, effectiveSpecRef),
    'utf8',
  );
  writeFileSync(path.join(iterationRoot, 'gate-a-intake', 'README.md'), gateReadme('Gate A intake', args.iterationId), 'utf8');
  writeFileSync(path.join(iterationRoot, 'gate-b-spec', 'README.md'), gateReadme('Gate B spec', args.iterationId), 'utf8');

  const nextCurrentSpec = currentSpecForOpen(facts.state.currentSpec, args.iterationId, facts.state.activeIteration, idea, openedAt);
  writeJson(facts.state.currentSpecPath, nextCurrentSpec);
  writeIterationStatus(artifactRoot, nextCurrentSpec);

  const openedState = resolveIterationState(artifactRoot, { requireReady: false });
  console.log(`Plan2Agent iteration opened: ${toRelativeFromRoot(openedState.iterationRoot)}`);
  console.log(`- active iteration: ${openedState.activeIteration}`);
  console.log(`- baseline iteration: ${facts.state.activeIteration}`);
  console.log(`- idea: ${idea}`);
  console.log('Skeleton created; Gate B-D artifacts are not required until planning outputs are written.');
  return 0;
}

function draft(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  const pending = activePendingIteration(state);
  const metadata = loadIterationMetadata(state.iterationRoot);
  const idea = draftIdea(args, pending, metadata);
  const baselineSpecRef = pending.baseline_effective_spec_ref;
  let baselineIteration = pending.baseline_iteration ?? metadata.baseline?.iteration_id ?? 'none';
  let baselineSpec = null;
  if (baselineSpecRef) {
    const baselineSpecPath = resolveArtifactFileReference(baselineSpecRef, artifactRoot);
    assertFile(baselineSpecPath, 'current-spec.json pending_iteration.baseline_effective_spec_ref');
    if (path.resolve(baselineSpecPath) !== path.resolve(state.effectiveSpecPath)) {
      throw new Error(`pending baseline spec ${baselineSpecRef} must match current effective spec ${state.currentSpec.effective_spec_ref}`);
    }
    baselineIteration = pending.baseline_iteration ?? metadata.baseline?.iteration_id ?? 'unknown';
    baselineSpec = loadEffectiveBaselineSpec(baselineSpecPath);
  }
  const projectId = state.projectId;
  const files = draftArtifactPaths(state.iterationRoot);
  const initialIntakePath = activeIntakePath(state);
  const initialIntake = baselineSpecRef ? null : validateIntake(initialIntakePath);
  assertWritableDraftFiles(files, artifactRoot, args.force, baselineSpecRef ? {} : { allowExisting: ['intakeJson', 'intakeMd'] });

  const intake = baselineSpecRef
    ? buildDeltaIntake({
        projectId,
        iterationId: state.activeIteration,
        idea,
        baselineIteration,
        baselineSpecRef,
      })
    : initialIntake;
  const spec = baselineSpecRef
    ? buildDeltaSpec({
        projectId,
        iterationId: state.activeIteration,
        idea,
        baselineSpec,
        baselineSpecRef,
      })
    : buildInitialSpec({
        projectId,
        iterationId: state.activeIteration,
        idea,
        intake: initialIntake,
      });
  const artifacts = {
    intake_ref: artifactRelativePath(artifactRoot, files.intakeJson),
    spec_ref: artifactRelativePath(artifactRoot, files.specJson),
    product_spec_ref: artifactRelativePath(artifactRoot, files.productSpecMd),
    implementation_plan_ref: artifactRelativePath(artifactRoot, files.implementationPlanMd),
  };
  const draftedAt = new Date().toISOString();

  if (baselineSpecRef) {
    writeJson(files.intakeJson, intake);
    writeFileSync(files.intakeMd, renderIntakeMarkdown(intake), 'utf8');
  }
  writeFileSync(files.productSpecMd, renderProductSpecMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef: baselineSpecRef ?? 'none',
  }), 'utf8');
  writeFileSync(files.implementationPlanMd, renderImplementationPlanMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef: baselineSpecRef ?? 'none',
  }), 'utf8');
  writeJson(files.specJson, spec);

  if (baselineSpecRef) validateIntake(files.intakeJson);
  validateSpec(files.specJson, files.intakeJson);
  writeJson(
    path.join(state.iterationRoot, 'iteration.json'),
    iterationMetadataForDraft(metadata, idea, draftedAt, artifacts),
  );
  const nextCurrentSpec = currentSpecForDraft(state.currentSpec, state.activeIteration, idea, draftedAt, artifacts);
  writeJson(state.currentSpecPath, nextCurrentSpec);
  writeIterationStatus(state.artifactRoot, nextCurrentSpec);

  console.log(`Plan2Agent iteration draft generated: ${toRelativeFromRoot(state.iterationRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- baseline spec: ${baselineSpecRef ?? 'none'}`);
  console.log(`- intake: ${artifacts.intake_ref}`);
  console.log(`- spec: ${artifacts.spec_ref} (approval=draft)`);
  console.log('Gate A/B artifacts validated; Gate C/D are still pending.');
  return 0;
}

function compose(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  const state = resolveIterationState(artifactRoot, { requireReady: false });
  const { sources, skipped } = collectCompositionSources(artifactRoot, state.currentSpec);
  const composedCurrentSpec = buildComposedCurrentSpec(state.currentSpec, sources, skipped);
  validateCurrentSpecCompositionData(composedCurrentSpec, artifactRoot);
  if (composedCurrentSpec.open_decisions.length && !args.allowConflicts) {
    throw new ValidationError(
      `current-spec composition has unresolved open_decisions: ${JSON.stringify(composedCurrentSpec.open_decisions.map((decision) => decision.id))}; rerun with --allow-conflicts to write the conflict decisions`,
    );
  }
  writeJson(state.currentSpecPath, composedCurrentSpec);
  writeIterationStatus(state.artifactRoot, composedCurrentSpec);
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
    if (args.command === 'diff-tasks') return diffTasks(args);
    if (args.command === 'compose') return compose(args);
    if (args.command === 'maintenance') return maintenance(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ValidationError || error.code || error.message) {
      console.error(`p2a_iteration failed: ${error.message}`);
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
