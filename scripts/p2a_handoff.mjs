#!/usr/bin/env node
/** Handoff approved Plan2Agent artifacts into a target project without executing build/install/codegen. */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  loadJson,
  validateReview,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const VALID_MODES = new Set(['copy', 'move']);
const ARTIFACT_TARGET_DIR = path.join('.plan2agent', 'artifacts');
const REBASED_SOURCE_SPEC = 'spec.json';

function usage() {
  return [
    'Usage: node scripts/p2a_handoff.mjs --project-id <id> --artifacts <path> --target <path> [options]',
    '',
    'Options:',
    '  --mode copy|move     Copy artifacts by default; move removes source files after successful write.',
    '  --include-intake     Include gate-a-intake/intake.json and intake.md.',
    '  --overwrite          Allow replacing existing target files.',
    '  --dry-run            Validate and print the handoff plan without writing files.',
    '  --help, -h           Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    mode: 'copy',
    includeIntake: false,
    overwrite: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--project-id') {
      args.projectId = argv[++index];
      if (!args.projectId) throw new Error('--project-id requires a value');
    } else if (arg === '--artifacts') {
      args.artifacts = argv[++index];
      if (!args.artifacts) throw new Error('--artifacts requires a path');
    } else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a path');
    } else if (arg === '--mode') {
      args.mode = argv[++index];
      if (!args.mode) throw new Error('--mode requires copy or move');
      if (!VALID_MODES.has(args.mode)) throw new Error(`--mode must be copy or move, got ${JSON.stringify(args.mode)}`);
    } else if (arg === '--include-intake') {
      args.includeIntake = true;
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.help) return args;
  for (const required of ['projectId', 'artifacts', 'target']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required`);
  }
  return args;
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} must be a file: ${filePath}`);
}

function requireUnderTarget(targetRoot, filePath) {
  const relative = path.relative(targetRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside target directory: ${filePath}`);
  }
}

function targetPath(targetRoot, relativePath) {
  const resolved = path.resolve(targetRoot, relativePath);
  requireUnderTarget(targetRoot, resolved);
  return resolved;
}

function validateGates(artifactsRoot) {
  const paths = {
    specJson: path.join(artifactsRoot, 'gate-b-spec', 'spec.json'),
    productSpec: path.join(artifactsRoot, 'gate-b-spec', 'product-spec.md'),
    implementationPlan: path.join(artifactsRoot, 'gate-b-spec', 'implementation-plan.md'),
    taskGraph: path.join(artifactsRoot, 'gate-c-task-graph', 'task-graph.json'),
    reviewReport: path.join(artifactsRoot, 'gate-d-review', 'review-report.md'),
    reviewJson: path.join(artifactsRoot, 'gate-d-review', 'review.json'),
    intakeJson: path.join(artifactsRoot, 'gate-a-intake', 'intake.json'),
    intakeMd: path.join(artifactsRoot, 'gate-a-intake', 'intake.md'),
    openQuestions: path.join(artifactsRoot, 'open-questions.md'),
  };

  assertFile(paths.specJson, 'gate-b-spec/spec.json');
  assertFile(paths.productSpec, 'gate-b-spec/product-spec.md');
  assertFile(paths.implementationPlan, 'gate-b-spec/implementation-plan.md');
  const spec = validateSpec(paths.specJson);
  if (spec.approval !== 'approved') throw new ValidationError('handoff requires spec.approval to be "approved"');
  if (spec.open_decisions.length !== 0) throw new ValidationError('handoff requires spec.open_decisions to be empty');

  assertFile(paths.taskGraph, 'gate-c-task-graph/task-graph.json');
  validateTaskGraph(paths.taskGraph, paths.specJson);

  assertFile(paths.reviewReport, 'gate-d-review/review-report.md');
  assertFile(paths.reviewJson, 'gate-d-review/review.json');
  const review = validateReview(paths.reviewJson);
  if (review.blocking_issues.length !== 0) {
    throw new ValidationError(`handoff blocked by review.json blocking_issues: ${JSON.stringify(review.blocking_issues)}`);
  }

  return paths;
}

function pushArtifact(plan, source, targetRoot, targetRelative, options = {}) {
  plan.push({
    type: options.type ?? 'copy',
    source,
    targetRelative,
    target: targetPath(targetRoot, targetRelative),
    transform: options.transform ?? null,
  });
}

function buildPlan(paths, args, artifactsRoot, targetRoot) {
  const plan = [];
  pushArtifact(plan, paths.productSpec, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'product-spec.md'));
  pushArtifact(plan, paths.implementationPlan, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'implementation-plan.md'));
  pushArtifact(plan, paths.specJson, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'spec.json'));
  pushArtifact(plan, paths.taskGraph, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'task-graph.json'), { type: 'rewrite-json', transform: rebaseTaskGraphSourceSpec });
  pushArtifact(plan, paths.reviewReport, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'review-report.md'));
  pushArtifact(plan, paths.reviewJson, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'review.json'));

  if (args.includeIntake) {
    assertFile(paths.intakeJson, 'gate-a-intake/intake.json');
    assertFile(paths.intakeMd, 'gate-a-intake/intake.md');
    pushArtifact(plan, paths.intakeJson, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'intake.json'));
    pushArtifact(plan, paths.intakeMd, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'intake.md'));
  }

  if (existsSync(paths.openQuestions)) {
    assertFile(paths.openQuestions, 'open-questions.md');
    pushArtifact(plan, paths.openQuestions, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'open-questions.md'));
  }

  pushArtifact(plan, path.join(ROOT, 'scripts', 'p2a_tasks.mjs'), targetRoot, path.join('scripts', 'p2a_tasks.mjs'));
  pushArtifact(plan, path.join(ROOT, 'scripts', 'validate_artifacts.mjs'), targetRoot, path.join('scripts', 'validate_artifacts.mjs'));
  for (const schemaFile of ['intake.schema.json', 'spec.schema.json', 'task-graph.schema.json', 'review.schema.json']) {
    pushArtifact(plan, path.join(ROOT, 'schemas', schemaFile), targetRoot, path.join('schemas', schemaFile));
  }

  const artifactFiles = plan
    .filter((item) => item.targetRelative.startsWith(`${ARTIFACT_TARGET_DIR}${path.sep}`) || item.targetRelative.startsWith(`${ARTIFACT_TARGET_DIR}/`))
    .map((item) => normalizePath(item.targetRelative));

  const manifest = {
    schema_version: 'p2a.handoff.v1',
    projectId: args.projectId,
    sourceArtifacts: artifactsRoot,
    targetProject: targetRoot,
    handoffMode: args.mode,
    createdAt: new Date().toISOString(),
    includedTools: ['p2a_tasks', 'validate_artifacts'],
    externalHarnesses: [],
    artifactFiles,
    toolFiles: ['scripts/p2a_tasks.mjs', 'scripts/validate_artifacts.mjs'],
    notes: [`task-graph.sourceSpec rebased to ${REBASED_SOURCE_SPEC}`],
  };

  const projectConfig = buildProjectConfig(targetRoot);
  plan.push({
    type: 'write-json',
    targetRelative: path.join('.plan2agent', 'manifest.json'),
    target: targetPath(targetRoot, path.join('.plan2agent', 'manifest.json')),
    data: manifest,
  });
  plan.push({
    type: 'write-json',
    targetRelative: path.join('.plan2agent', 'project.config.json'),
    target: targetPath(targetRoot, path.join('.plan2agent', 'project.config.json')),
    data: projectConfig,
  });
  return plan;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function rebaseTaskGraphSourceSpec(source) {
  const taskGraph = loadJson(source);
  taskGraph.sourceSpec = REBASED_SOURCE_SPEC;
  const sourceText = readFileSync(source, 'utf8');
  const rewritten = sourceText.replace(/(\"sourceSpec\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"/, `$1${JSON.stringify(REBASED_SOURCE_SPEC)}`);
  if (rewritten === sourceText) throw new Error(`could not rebase sourceSpec in ${source}`);
  return rewritten;
}

function detectPackageManager(targetRoot) {
  if (existsSync(path.join(targetRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(targetRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(targetRoot, 'package-lock.json'))) return 'npm';
  if (existsSync(path.join(targetRoot, 'package.json'))) return 'npm';
  if (existsSync(path.join(targetRoot, 'gradlew')) || existsSync(path.join(targetRoot, 'build.gradle')) || existsSync(path.join(targetRoot, 'build.gradle.kts'))) return 'gradle';
  if (existsSync(path.join(targetRoot, 'pom.xml'))) return 'maven';
  return null;
}

function buildProjectConfig(targetRoot) {
  const packageManager = detectPackageManager(targetRoot);
  let installCommand = null;
  let testCommand = null;
  let lintCommand = null;
  let typecheckCommand = null;
  const notes = ['TODO: 사용자 확인'];

  if (packageManager === 'pnpm') installCommand = 'pnpm install';
  else if (packageManager === 'yarn') installCommand = 'yarn install';
  else if (packageManager === 'npm') installCommand = 'npm install';
  else if (packageManager === 'gradle') testCommand = existsSync(path.join(targetRoot, 'gradlew')) ? './gradlew test' : 'gradle test';
  else if (packageManager === 'maven') testCommand = 'mvn test';

  if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    const packageJsonPath = path.join(targetRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson.scripts ?? {};
      const runner = packageManager === 'npm' ? 'npm run' : packageManager;
      if (scripts.test) testCommand = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
      if (scripts.lint) lintCommand = `${runner} lint`;
      if (scripts.typecheck) typecheckCommand = `${runner} typecheck`;
    }
  }

  return {
    schema_version: 'p2a.project_config.v1',
    packageManager,
    installCommand,
    testCommand,
    lintCommand,
    typecheckCommand,
    taskGraph: '.plan2agent/artifacts/task-graph.json',
    teamBigFive: { enabled: false },
    notes,
  };
}

function assertNoConflicts(plan, overwrite) {
  if (overwrite) return;
  const conflicts = plan.filter((item) => existsSync(item.target)).map((item) => normalizePath(item.targetRelative));
  if (conflicts.length) throw new Error(`target file(s) already exist; rerun with --overwrite to replace: ${conflicts.join(', ')}`);
}

function printPlan(plan, args, artifactsRoot, targetRoot) {
  console.log(`Plan2Agent handoff ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`projectId: ${args.projectId}`);
  console.log(`mode: ${args.mode}`);
  console.log(`sourceArtifacts: ${artifactsRoot}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log('writes:');
  for (const item of plan) {
    const action = item.type === 'write-json' ? 'generate' : item.type === 'rewrite-json' ? 'copy+rewrite' : 'copy';
    const source = item.source ? normalizePath(path.relative(process.cwd(), item.source)) : '(generated)';
    console.log(`- ${action}: ${source} -> ${normalizePath(item.targetRelative)}`);
  }
  if (args.mode === 'move') console.log('move cleanup: source files above will be removed after successful writes');
  if (args.dryRun) console.log('dry-run: no files written');
}

function writePlan(plan) {
  for (const item of plan) mkdirSync(path.dirname(item.target), { recursive: true });
  for (const item of plan) {
    if (item.type === 'write-json') {
      writeFileSync(item.target, `${JSON.stringify(item.data, null, 2)}\n`, 'utf8');
    } else if (item.type === 'rewrite-json') {
      writeFileSync(item.target, item.transform(item.source), 'utf8');
    } else {
      copyFileSync(item.source, item.target);
    }
  }
}

function cleanupMovedSources(plan, artifactsRoot) {
  const artifactRootResolved = path.resolve(artifactsRoot);
  for (const item of plan) {
    if (!item.source) continue;
    const source = path.resolve(item.source);
    const relative = path.relative(artifactRootResolved, source);
    const isArtifactSource = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (isArtifactSource && existsSync(source)) unlinkSync(source);
  }
  for (const directory of ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph', 'gate-d-review']) {
    const directoryPath = path.join(artifactRootResolved, directory);
    if (existsSync(directoryPath) && readdirSync(directoryPath).length === 0) rmdirSync(directoryPath);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }

    const artifactsRoot = path.resolve(args.artifacts);
    const targetRoot = path.resolve(args.target);
    if (!existsSync(artifactsRoot) || !lstatSync(artifactsRoot).isDirectory()) {
      throw new Error(`--artifacts must point to an existing directory: ${artifactsRoot}`);
    }
    if (existsSync(targetRoot) && !lstatSync(targetRoot).isDirectory()) {
      throw new Error(`--target must be a directory path, but a non-directory exists: ${targetRoot}`);
    }

    const paths = validateGates(artifactsRoot);
    const plan = buildPlan(paths, args, artifactsRoot, targetRoot);
    assertNoConflicts(plan, args.overwrite);
    printPlan(plan, args, artifactsRoot, targetRoot);
    if (args.dryRun) return 0;
    writePlan(plan);
    if (args.mode === 'move') cleanupMovedSources(plan, artifactsRoot);
    console.log('handoff complete');
    return 0;
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'handoff gate validation failed' : 'p2a handoff failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
}

process.exitCode = main();
