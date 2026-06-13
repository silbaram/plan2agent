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
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  loadJson,
  validateArtifactRoot,
  validateHandoffReadyArtifactRoot,
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

function validateGates(artifactsRoot, projectId) {
  return validateHandoffReadyArtifactRoot(artifactsRoot, { projectId }).paths;
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

  assertFile(paths.statusDoc, 'status.md');
  pushArtifact(plan, paths.statusDoc, targetRoot, path.join(ARTIFACT_TARGET_DIR, 'status.md'));

  pushArtifact(plan, path.join(ROOT, 'scripts', 'p2a_tasks.mjs'), targetRoot, path.join('scripts', 'p2a_tasks.mjs'));
  pushArtifact(plan, path.join(ROOT, 'scripts', 'validate_artifacts.mjs'), targetRoot, path.join('scripts', 'validate_artifacts.mjs'));
  for (const schemaFile of ['intake.schema.json', 'spec.schema.json', 'task-graph.schema.json', 'review.schema.json']) {
    pushArtifact(plan, path.join(ROOT, 'schemas', schemaFile), targetRoot, path.join('schemas', schemaFile));
  }

  const artifactFiles = plan
    .filter((item) => item.targetRelative.startsWith(`${ARTIFACT_TARGET_DIR}${path.sep}`) || item.targetRelative.startsWith(`${ARTIFACT_TARGET_DIR}/`))
    .map((item) => normalizePath(item.targetRelative));
  const schemaFiles = plan
    .filter((item) => item.targetRelative.startsWith(`schemas${path.sep}`) || item.targetRelative.startsWith('schemas/'))
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
    schemaFiles,
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

function isCancel(input) {
  const trimmed = input.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'q';
}

async function askRequired(rl, label, description, defaultValue = null) {
  const defaultLabel = defaultValue ? ` [${defaultValue}]` : '';
  const input = await rl.question(`${label}${defaultLabel} - ${description}: `);
  if (input.trim().toLowerCase() === 'q') return null;
  if (input.trim() === '') return defaultValue;
  return input.trim();
}

async function askMenu(rl, title, items, formatItem) {
  console.log(title);
  items.forEach((item, index) => console.log(formatItem(item, index + 1)));
  while (true) {
    const input = await rl.question('번호 선택 (빈 입력/q=취소): ');
    if (isCancel(input)) return null;
    const selected = Number.parseInt(input.trim(), 10);
    if (Number.isInteger(selected) && selected >= 1 && selected <= items.length) return items[selected - 1];
    console.log(`1-${items.length} 사이의 번호를 입력하세요.`);
  }
}

function listProjects(artifactsBase) {
  try {
    return readdirSync(artifactsBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(path.join(artifactsBase, entry.name, 'gate-b-spec', 'spec.json')))
      .map((entry) => ({ projectId: entry.name, dir: path.join(artifactsBase, entry.name) }));
  } catch {
    return [];
  }
}

function probeGateStatus(projectDir) {
  try {
    const validation = validateArtifactRoot(projectDir);
    const spec = validation.spec;
    const review = validation.review;
    const approved = spec ? spec.approval === 'approved' : false;
    const openDecisions = Array.isArray(spec?.open_decisions) ? spec.open_decisions.length : null;
    const blocking = Array.isArray(review?.blocking_issues) ? review.blocking_issues.length : null;
    return {
      statusDoc: true,
      a: validation.gates.a.present,
      b: validation.gates.b.present,
      c: validation.gates.c.present,
      d: validation.gates.d.present,
      approved,
      openDecisions,
      blocking,
      ready: validation.readyForHandoff,
    };
  } catch {
    return { statusDoc: false, a: false, b: false, c: false, d: false, approved: false, openDecisions: null, blocking: null, ready: false };
  }
}

function formatGateStatus(status, key) {
  return `${key.toUpperCase()}${status[key] ? '✅' : '⬜'}`;
}

function formatProjectItem(item, number) {
  if (item.manual) return `${number}) 직접 입력`;
  const status = item.status;
  const gates = ['a', 'b', 'c', 'd'].map((key) => formatGateStatus(status, key)).join(' ');
  const detail = status.ready
    ? `blocker ${status.blocking} · 인계가능`
    : '미완';
  return `${number}) ${item.projectId.padEnd(20)} ${gates} · ${detail}`;
}

async function pickProject(rl, artifactsBase) {
  const projects = listProjects(artifactsBase).map((project) => ({
    ...project,
    status: probeGateStatus(project.dir),
  }));
  if (projects.length === 0) return 'manual';

  const selected = await askMenu(
    rl,
    'Plan2Agent 프로젝트를 선택하세요.',
    [...projects, { manual: true }],
    formatProjectItem,
  );
  if (!selected) return null;
  if (selected.manual) return 'manual';
  return { projectId: selected.projectId, artifactsRoot: selected.dir };
}

function readinessProblems(status) {
  const problems = [];
  const missing = [];
  if (!status.a) missing.push('A');
  if (!status.b) missing.push('B');
  if (!status.c) missing.push('C');
  if (!status.d) missing.push('D');
  if (!status.statusDoc) problems.push('status.md 누락/검증 실패');
  if (missing.length) problems.push(`게이트 누락: ${missing.join(', ')}`);
  if (!status.approved) problems.push('미승인(spec.approval != approved)');
  if (status.openDecisions === null) problems.push('열린 결정 수 확인 불가');
  if (status.openDecisions > 0) problems.push(`open_decisions ${status.openDecisions}개`);
  if (status.blocking === null) problems.push('리뷰없음/검토 상태 확인 불가');
  if (status.blocking > 0) problems.push(`blocking_issues ${status.blocking}개`);
  return problems;
}

async function chooseReadyProject(rl, artifactsBase) {
  while (true) {
    const picked = await pickProject(rl, artifactsBase);
    if (!picked || picked === 'manual') return picked;

    const status = probeGateStatus(picked.artifactsRoot);
    if (status.ready) return picked;

    console.log(`인계 준비가 아직 완료되지 않았습니다: ${readinessProblems(status).join(', ')}`);
    const retry = await askYesNo(rl, '다른 프로젝트 선택할까요?', '준비된 프로젝트 다시 선택', true);
    if (retry) continue;
    return null;
  }
}

async function askMode(rl) {
  console.log('mode - 산출물 처리 방식');
  console.log('1) copy   원본 유지 [기본값]');
  console.log('2) move   원본 제거');
  while (true) {
    const input = await rl.question('번호 선택 [1] (빈 입력/q=취소): ');
    if (input.trim().toLowerCase() === 'q') return null;
    if (input.trim() === '' || input.trim() === '1') return 'copy';
    if (input.trim() === '2') return 'move';
    console.log('1-2 사이의 번호를 입력하세요.');
  }
}

async function askYesNo(rl, label, description, defaultValue) {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  while (true) {
    const input = await rl.question(`${label} - ${description} (${suffix}): `);
    const normalized = input.trim().toLowerCase();
    if (normalized === 'q' || (normalized === '' && defaultValue === null)) return null;
    if (normalized === '') return defaultValue;
    if (normalized === 'y' || normalized === 'yes') return true;
    if (normalized === 'n' || normalized === 'no') return false;
    console.log('y 또는 n을 입력하세요.');
  }
}

function defaultArtifactsBase() {
  const artifactsBase = path.resolve(process.cwd(), 'artifacts');
  try {
    if (!existsSync(artifactsBase) || !lstatSync(artifactsBase).isDirectory() || readdirSync(artifactsBase).length === 0) {
      return null;
    }
    return artifactsBase;
  } catch {
    return null;
  }
}

async function buildInteractiveArgv(rl) {
  let projectId;
  let artifacts;
  const artifactsBase = defaultArtifactsBase();
  const picked = artifactsBase ? await chooseReadyProject(rl, artifactsBase) : 'manual';
  if (!picked) return null;

  if (picked === 'manual') {
    projectId = await askRequired(rl, 'project-id', '프로젝트 식별자');
    if (!projectId) return null;
    artifacts = await askRequired(rl, 'artifacts', '원본 산출물 디렉터리 (예: artifacts/<id>)', path.join('artifacts', projectId));
    if (!artifacts) return null;
  } else {
    projectId = picked.projectId;
    artifacts = picked.artifactsRoot;
  }

  const target = await askRequired(rl, 'target', '개발 대상 디렉터리');
  if (!target) return null;
  const mode = await askMode(rl);
  if (!mode) return null;
  const includeIntake = await askYesNo(rl, 'include-intake?', 'gate-a-intake 산출물도 포함', false);
  if (includeIntake === null) return null;
  const overwrite = await askYesNo(rl, 'overwrite?', '기존 대상 파일 덮어쓰기 허용', false);
  if (overwrite === null) return null;

  const argv = ['--project-id', projectId, '--artifacts', artifacts, '--target', target, '--mode', mode];
  if (includeIntake) argv.push('--include-intake');
  if (overwrite) argv.push('--overwrite');
  return argv;
}

function argvValue(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? null : argv[index + 1];
}

function printNextSteps(targetRoot) {
  console.log(`✅ 인계 완료 — ${targetRoot}`);
  console.log(`다음: cd ${targetRoot}`);
  console.log('      node scripts/p2a_tasks.mjs ready --graph .plan2agent/artifacts/task-graph.json');

  try {
    const config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    if (['testCommand', 'lintCommand', 'typecheckCommand'].some((key) => config[key] === null)) {
      console.log('참고: .plan2agent/project.config.json 의 test/lint/typecheck 명령을 채우세요.');
    }
  } catch {
    // Best-effort hint only.
  }
}

function createQuestioner() {
  if (process.stdin.isTTY) return createInterface({ input: process.stdin, output: process.stdout });

  const answers = readFileSync(0, 'utf8').split(/\r?\n/);
  return {
    async question(prompt) {
      const answer = answers.length ? answers.shift() : '';
      const rl = createInterface({ input: Readable.from([`${answer}\n`]), output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    close() {},
  };
}

export async function interactiveMain() {
  const rl = createQuestioner();
  try {
    const argv = await buildInteractiveArgv(rl);
    if (!argv) return 0;

    const previewCode = main([...argv, '--dry-run']);
    if (previewCode !== 0) return previewCode;

    const go = await askYesNo(rl, '이대로 실제 인계?', '위 계획대로 실행', false);
    if (!go) {
      console.log('취소됨');
      return 0;
    }

    const code = main(argv);
    if (code === 0) printNextSteps(argvValue(argv, '--target'));
    return code;
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'handoff gate validation failed' : 'p2a handoff interactive failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  } finally {
    rl.close();
  }
}

function shouldRunInteractive(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return false;
  if (argv.includes('--interactive') || argv.includes('-i')) return true;
  return argv.length === 0 && process.stdin.isTTY;
}

function isDirectEntry() {
  return process.argv[1] && __filename === path.resolve(process.argv[1]);
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

    const paths = validateGates(artifactsRoot, args.projectId);
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

if (isDirectEntry()) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 && !process.stdin.isTTY) {
    console.log(usage());
    process.exitCode = 0;
  } else if (shouldRunInteractive(argv)) {
    process.exitCode = await interactiveMain();
  } else {
    process.exitCode = main(argv);
  }
}
