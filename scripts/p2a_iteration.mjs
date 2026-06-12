#!/usr/bin/env node
/** Convert a greenfield Plan2Agent artifact directory into the iterative layout. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadJson,
  validateReview,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const GATE_DIRS = ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph', 'gate-d-review'];
const STATUS_ORDER = ['todo', 'in_progress', 'done', 'blocked'];
const DEFAULT_ITERATION_ID = 'v1-mvp';
const INIT_REBASED_SOURCE_SPEC = '../gate-b-spec/spec.json';

function usage() {
  return [
    'Usage: node scripts/p2a_iteration.mjs init --artifacts <greenfield-project-dir> [--iteration-id v1-mvp] [--dry-run]',
    '',
    'Options:',
    '  --artifacts <dir>       Greenfield artifact directory to convert. Required.',
    `  --iteration-id <id>    First iteration id. Default: ${DEFAULT_ITERATION_ID}.`,
    '  --dry-run              Print the conversion plan without writing files.',
    '  --help, -h             Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { dryRun: false, help: false, iterationId: DEFAULT_ITERATION_ID };
  const command = argv[0];
  if (!command) throw new Error(`missing command\n\n${usage()}`);
  if (command === '--help' || command === '-h') return { ...args, help: true };
  if (command !== 'init') throw new Error(`unknown command: ${command}\n\n${usage()}`);

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--artifacts') {
      args.artifacts = argv[++index];
      if (!args.artifacts) throw new Error('--artifacts requires a directory');
    } else if (arg === '--iteration-id') {
      args.iterationId = argv[++index];
      if (!args.iterationId) throw new Error('--iteration-id requires a value');
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!args.help && !args.artifacts) throw new Error(`--artifacts is required\n\n${usage()}`);
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

function statusMarkdown(projectId, iterationId, spec, taskGraph, review) {
  return `# ${projectId} — 반복 인덱스 (Iteration Index)\n\n` +
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
    note: '반복 1개라 이 반복 spec이 곧 현재 유효 spec. 다중 반복 조합 규칙은 plans/04 §6 piece3에서 정식화.',
  };
}

function maintenanceReadme() {
  return `# maintenance\n\n` +
    `작은 fix, 문서 수정, 패치성 변경을 append하는 상시 반복입니다.\n\n` +
    `task graph는 첫 fix가 생길 때 \`gate-c-task-graph/task-graph.json\`으로 생성합니다. ` +
    `빈 task graph는 \`schemas/task-graph.schema.json\`의 \`tasks\` 최소 1개 제약을 위반하므로 만들지 않습니다.\n`;
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

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    return init(args);
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
