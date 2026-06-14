#!/usr/bin/env node
/** Manage Plan2Agent iterative artifact layout. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadJson,
  validateIntake,
  validateReview,
  validateReviewPass,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  formatIterationState,
  resolveIterationState,
  serializeIterationState,
} from './p2a_iteration_state.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const GATE_DIRS = ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph', 'gate-d-review'];
const STATUS_ORDER = ['todo', 'in_progress', 'done', 'blocked'];
const DEFAULT_ITERATION_ID = 'v1-mvp';
const INIT_REBASED_SOURCE_SPEC = '../gate-b-spec/spec.json';
const COMMANDS = new Set(['init', 'current', 'validate', 'close', 'open', 'draft', 'compose']);
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
    '  node scripts/p2a_iteration.mjs init --artifacts <greenfield-project-dir> [--iteration-id v1-mvp] [--dry-run]',
    '  node scripts/p2a_iteration.mjs current --artifacts <iterative-project-dir> [--json]',
    '  node scripts/p2a_iteration.mjs validate --artifacts <iterative-project-dir> [--require-close-ready]',
    '  node scripts/p2a_iteration.mjs close --artifacts <iterative-project-dir> [--iteration-id active]',
    '  node scripts/p2a_iteration.mjs open --artifacts <iterative-project-dir> --iteration-id <id> --idea <text>',
    '  node scripts/p2a_iteration.mjs draft --artifacts <iterative-project-dir> [--idea <text>] [--force]',
    '  node scripts/p2a_iteration.mjs compose --artifacts <iterative-project-dir>',
    '',
    'Commands:',
    '  init                  Convert a greenfield artifact root into iterations/<id>/gate-*.',
    '  current               Print the active iteration paths resolved from current-spec.json.',
    '  validate              Validate active iteration structure and Gate B-D readiness.',
    '  close                 Mark the active close-ready iteration as closed/archived metadata.',
    '  open                  Create a new active iteration skeleton from the current baseline.',
    '  draft                 Generate baseline-aware Gate A/B draft artifacts for the active planning iteration.',
    '  compose               Rebuild current-spec.json as a composed effective spec view.',
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
  };
  const command = argv[0];
  if (!command) throw new Error(`missing command\n\n${usage()}`);
  if (command === '--help' || command === '-h') return { ...args, help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  args.command = command;

  for (let index = 1; index < argv.length; index += 1) {
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
      if (command !== 'open' && command !== 'draft') throw new Error('--idea is only supported by open and draft');
      args.idea = argv[++index];
      if (!args.idea) throw new Error('--idea requires a value');
    } else if (arg === '--force') {
      if (command !== 'draft') throw new Error('--force is only supported by draft');
      args.force = true;
    } else if (arg === '--dry-run') {
      if (command !== 'init') throw new Error('--dry-run is only supported by init');
      args.dryRun = true;
    } else if (arg === '--json') {
      if (command !== 'current') throw new Error('--json is only supported by current');
      args.json = true;
    } else if (arg === '--require-close-ready') {
      if (command !== 'validate') throw new Error('--require-close-ready is only supported by validate');
      args.requireCloseReady = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!args.help && !args.artifacts) throw new Error(`--artifacts is required\n\n${usage()}`);
  if (command === 'open' && !args.iterationIdProvided) throw new Error('--iteration-id is required for open');
  if (command === 'open' && (!args.idea || args.idea.trim().length === 0)) throw new Error('--idea is required for open');
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

  const spec = validateSpec(paths.specJson);
  if (spec.approval !== 'approved') {
    throw new ValidationError(`spec.approval must be approved before init, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError(`spec.open_decisions must be empty before init, got ${JSON.stringify(spec.open_decisions)}`);
  }
  validateTaskGraph(paths.taskGraph, paths.specJson);
  validateReview(paths.reviewJson);

  return {
    spec,
    taskGraph: loadJson(paths.taskGraph),
    review: loadJson(paths.reviewJson),
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
    evidence: [],
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

function currentSpecPointer(projectId, iterationId) {
  return {
    schema_version: 'p2a.current_spec.v1',
    project_id: projectId,
    composed_from: [iterationId],
    active_iteration: iterationId,
    effective_spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
    note: '반복 1개라 이 반복 spec이 곧 현재 유효 spec. 다중 반복 조합 규칙은 docs/iteration-spec.md에서 정식화.',
  };
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

function closeRecord(iterationId, closedAt, taskGraph, effectiveSpecRef) {
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

function maintenanceReadme() {
  return `# maintenance\n\n` +
    `작은 fix, 문서 수정, 패치성 변경을 append하는 상시 반복입니다.\n\n` +
    `task graph는 첫 fix가 생길 때 \`gate-c-task-graph/task-graph.json\`으로 생성합니다. ` +
    `빈 task graph는 \`schemas/task-graph.schema.json\`의 \`tasks\` 최소 1개 제약을 위반하므로 만들지 않습니다.\n`;
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
  if (!pending.baseline_effective_spec_ref) {
    throw new Error('current-spec.json.pending_iteration.baseline_effective_spec_ref is required for baseline-aware draft generation');
  }
  return pending;
}

function assertWritableDraftFiles(files, artifactRoot, force) {
  const existing = Object.values(files).filter((filePath) => existsSync(filePath));
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

function iterationMetadataForDraft(metadata, idea, draftedAt, artifacts) {
  return {
    ...metadata,
    status: 'gate_b_draft',
    idea,
    drafted_at: draftedAt,
    draft_artifacts: artifacts,
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

  const pending = previousCurrentSpec.pending_iteration;
  if (pending && !composedIterationIds.includes(pending.iteration_id)) {
    composedCurrentSpec.pending_iteration = pending;
  }

  return composedCurrentSpec;
}

function validateCurrentSpecCompositionData(currentSpec, artifactRoot, options = {}) {
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

  const openDecisions = currentSpec.open_decisions ?? [];
  if (!Array.isArray(openDecisions)) throw new ValidationError('current-spec.json open_decisions must be an array');
  if (options.requireNoOpenDecisions && openDecisions.length) {
    throw new ValidationError(`current-spec.json composition has unresolved open_decisions: ${JSON.stringify(openDecisions.map((decision) => decision.id ?? decision))}`);
  }
  return currentSpec;
}

function buildPlan(paths, iterationId, facts) {
  const projectId = projectIdFrom(paths.artifactRoot, facts.spec, facts.taskGraph);
  return {
    projectId,
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
    mkdirSync(paths.maintenanceRoot, { recursive: true });
    writeFileSync(paths.statusMd, statusMarkdown(projectId, iterationId, movedFacts.spec, movedFacts.taskGraph, movedFacts.review));
    writeFileSync(paths.currentSpec, `${JSON.stringify(currentSpecPointer(projectId, iterationId), null, 2)}\n`);
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
  const review = validateReview(paths.movedReviewJson);
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
  console.log(`Plan2Agent iteration init passed: ${toRelativeFromRoot(artifactRoot)} -> iterations/${args.iterationId}/`);
  console.log('Moved artifacts revalidated: spec approved, task graph valid, review valid.');
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

function validateIteration(args) {
  const state = resolveIterationState(args.artifacts);
  validateCurrentSpecCompositionData(state.currentSpec, state.artifactRoot, { requireNoOpenDecisions: true });
  const spec = validateSpec(state.specPath);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  validateReviewPass(state.reviewPath);
  if (args.requireCloseReady) assertCloseReadyTasks(taskGraph);

  const statusCounts = countStatuses(taskGraph.tasks);
  console.log(`Plan2Agent iteration validation passed: ${toRelativeFromRoot(state.artifactRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- spec: approved=${spec.approval}`);
  console.log(`- task graph: ${taskGraph.tasks.length} task(s), todo ${statusCounts.todo}·in_progress ${statusCounts.in_progress}·done ${statusCounts.done}·blocked ${statusCounts.blocked}`);
  console.log('- review: no blocking issues');
  if (args.requireCloseReady) console.log('- close-ready: all tasks done');
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
  );
  const metadata = iterationMetadataForClose(
    loadOptionalIterationMetadata(artifactRoot, facts.state.activeIteration),
    facts.state.projectId,
    facts.state.activeIteration,
    closedAt,
    record,
  );

  writeJson(iterationMetadataPath(artifactRoot, facts.state.activeIteration), metadata);
  writeJson(facts.state.currentSpecPath, currentSpecForClose(facts.state.currentSpec, facts.state.activeIteration, record));
  writeFileSync(
    facts.state.statusPath,
    closeStatusMarkdown(
      facts.state.projectId,
      facts.state.activeIteration,
      facts.spec,
      facts.taskGraph,
      facts.review,
      closedAt,
      facts.state.currentSpec.effective_spec_ref,
    ),
    'utf8',
  );

  console.log(`Plan2Agent iteration closed: ${toRelativeFromRoot(facts.state.iterationRoot)}`);
  console.log(`- active iteration: ${facts.state.activeIteration}`);
  console.log(`- status: archived`);
  console.log(`- closed_at: ${closedAt}`);
  console.log('Active pointer remains on the closed baseline so `p2a_iteration open` can create the next iteration.');
  return 0;
}

function open(args) {
  const artifactRoot = normalizeArtifactPath(args.artifacts);
  assertSafeIterationId(args.iterationId);
  const idea = args.idea.trim();
  const facts = loadReadyIterationFacts(artifactRoot);
  assertCloseReadyTasks(facts.taskGraph);

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

  writeFileSync(
    facts.state.currentSpecPath,
    `${JSON.stringify(currentSpecForOpen(facts.state.currentSpec, args.iterationId, facts.state.activeIteration, idea, openedAt), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    facts.state.statusPath,
    openStatusMarkdown(projectId, args.iterationId, facts.state.activeIteration, facts.taskGraph, idea, openedAt, effectiveSpecRef),
    'utf8',
  );

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
  const baselineSpecPath = resolveArtifactFileReference(baselineSpecRef, artifactRoot);
  assertFile(baselineSpecPath, 'current-spec.json pending_iteration.baseline_effective_spec_ref');
  if (path.resolve(baselineSpecPath) !== path.resolve(state.effectiveSpecPath)) {
    throw new Error(`pending baseline spec ${baselineSpecRef} must match current effective spec ${state.currentSpec.effective_spec_ref}`);
  }
  const baselineIteration = pending.baseline_iteration ?? metadata.baseline?.iteration_id ?? 'unknown';
  const baselineSpec = loadEffectiveBaselineSpec(baselineSpecPath);
  const projectId = state.projectId;
  const files = draftArtifactPaths(state.iterationRoot);
  assertWritableDraftFiles(files, artifactRoot, args.force);

  const intake = buildDeltaIntake({
    projectId,
    iterationId: state.activeIteration,
    idea,
    baselineIteration,
    baselineSpecRef,
  });
  const spec = buildDeltaSpec({
    projectId,
    iterationId: state.activeIteration,
    idea,
    baselineSpec,
    baselineSpecRef,
  });
  const artifacts = {
    intake_ref: artifactRelativePath(artifactRoot, files.intakeJson),
    spec_ref: artifactRelativePath(artifactRoot, files.specJson),
    product_spec_ref: artifactRelativePath(artifactRoot, files.productSpecMd),
    implementation_plan_ref: artifactRelativePath(artifactRoot, files.implementationPlanMd),
  };
  const draftedAt = new Date().toISOString();

  writeJson(files.intakeJson, intake);
  writeFileSync(files.intakeMd, renderIntakeMarkdown(intake), 'utf8');
  writeFileSync(files.productSpecMd, renderProductSpecMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef,
  }), 'utf8');
  writeFileSync(files.implementationPlanMd, renderImplementationPlanMarkdown(spec, {
    iterationId: state.activeIteration,
    idea,
    baselineSpecRef,
  }), 'utf8');
  writeJson(files.specJson, spec);

  validateIntake(files.intakeJson);
  validateSpec(files.specJson, files.intakeJson);
  writeJson(
    path.join(state.iterationRoot, 'iteration.json'),
    iterationMetadataForDraft(metadata, idea, draftedAt, artifacts),
  );
  writeJson(
    state.currentSpecPath,
    currentSpecForDraft(state.currentSpec, state.activeIteration, idea, draftedAt, artifacts),
  );
  writeFileSync(
    state.statusPath,
    draftStatusMarkdown(projectId, state.activeIteration, baselineIteration, idea, pending.opened_at, draftedAt, baselineSpecRef),
    'utf8',
  );

  console.log(`Plan2Agent iteration draft generated: ${toRelativeFromRoot(state.iterationRoot)}`);
  console.log(`- active iteration: ${state.activeIteration}`);
  console.log(`- baseline spec: ${baselineSpecRef}`);
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
  writeJson(state.currentSpecPath, composedCurrentSpec);
  if (composedCurrentSpec.open_decisions.length) {
    throw new ValidationError(`current-spec composition has unresolved open_decisions: ${JSON.stringify(composedCurrentSpec.open_decisions.map((decision) => decision.id))}`);
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
    if (args.command === 'compose') return compose(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ValidationError || error.code || error.message) {
      console.error(`p2a_iteration failed: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
