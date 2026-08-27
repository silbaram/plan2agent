#!/usr/bin/env node
/** Top-level Plan2Agent command dispatcher. Domain decisions live in p2a_next_service.mjs. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveP2aPaths } from './p2a_paths.mjs';
import { p2aCommandLine } from './p2a_run_commands.mjs';
import { buildInfo, buildNext } from './p2a_next_service.mjs';

export {
  buildInfo,
  buildNext,
  buildNextActionContract,
  NEXT_DECISION_RULES,
} from './p2a_next_service.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);

const RUNTIME_COMMANDS = new Map([
  ['decide', { script: 'p2a_decisions.mjs', forwardsCommand: true }],
  ['decisions', { script: 'p2a_decisions.mjs', forwardsCommand: true }],
  ['shape', { script: 'p2a_shape.mjs' }],
  ['iteration', { script: 'p2a_iteration.mjs' }],
  ['task', { script: 'p2a_tasks.mjs' }],
  ['tasks', { script: 'p2a_tasks.mjs' }],
  ['run', { script: 'p2a_runs.mjs' }],
  ['runs', { script: 'p2a_runs.mjs' }],
  ['execute', { script: 'p2a_execute.mjs' }],
  ['context', { script: 'p2a_context.mjs' }],
  ['proposal', { script: 'p2a_proposals.mjs' }],
  ['proposals', { script: 'p2a_proposals.mjs' }],
  ['eval', { script: 'p2a_eval.mjs' }],
  ['buildlore', { script: 'p2a_buildlore.mjs' }],
  ['reference', { script: 'p2a_reference.mjs' }],
  ['validate', { script: 'validate_artifacts.mjs' }],
]);

const TOOLKIT_COMMANDS = new Map([
  ['doctor', { script: 'p2a_doctor.mjs', forwardsCommand: false, defaultTargetWhenEmbedded: true }],
  ['init', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['scaffold', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['enhance', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['update', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['upgrade', { script: 'p2a_upgrade.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['handoff', { script: 'p2a_handoff.mjs', forwardsCommand: false, defaultTargetWhenEmbedded: false }],
]);

function usage() {
  return [
    'Usage:',
    '  p2a init [--target <dir>] [--tools <list>] [--codex-profile quality|inherit]',
    '  p2a next [--target <dir>] [--project-id <id>] [--entry <path>] [--contract v1|v2] [--json] [--trace]',
    '  p2a decide --quote <user-utterance> [--entry <path>] [--target <dir>|--artifacts <dir>]',
    '  p2a decisions [--why <file-path>] [--target <dir>|--artifacts <dir>] [--json]',
    '  p2a shape [approve|revoke|migrate-style] [options]',
    '  p2a info [--target <dir>] [--entry <path>] [--json]',
    '  p2a doctor [--target <dir>] [--dev|--context] [--json] [--strict]',
    '  p2a update [--target <dir>] [--dry-run|--apply]',
    '  p2a upgrade [--target <dir>] (--dry-run|--apply)',
    '  p2a enhance <capability> [--target <dir>] [--dry-run] [--overwrite]',
    '  p2a eval <grade|compare|analyze|generate|digest> [options]',
    '  p2a buildlore <status|sync|check|search|context|compile|query> [options]',
    '  p2a reference snapshot --entry <path> --artifacts <dir> [--target <dir>] [--json]',
    '  p2a execute <prepare|plan|start|review|accept|resume|status|finish> [options]',
    '  p2a context show --artifacts <dir> (--continuation <id>|--phase <phase>) --provider <provider> [options]',
    '  p2a tasks|runs|iteration|proposals|validate ...',
    '',
    'Examples:',
    '  p2a init --target <project-dir>',
    '  p2a doctor --target <project-dir> --dev',
    '  p2a doctor --context --target <project-dir>',
    '  p2a eval generate --artifacts .plan2agent/artifacts/<project>',
    '',
    'Notes:',
    '  Install Plan2Agent globally before using p2a. New projects keep only project state and provider assets in .plan2agent/.',
    '  upgrade --apply updates only an npm-global installation; npx, local package, and clone runtimes are preview-only.',
    '  --help, -h  Show this help.',
    '  --version, -v  Show the installed Plan2Agent version.',
  ].join('\n');
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJsonObject(filePath) {
  try {
    if (!isFile(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function runVersion(argv) {
  if (argv.length) {
    console.error(`p2a version error: unexpected argument ${JSON.stringify(argv[0])}`);
    return 1;
  }
  const packageJson = readJsonObject(path.join(P2A_PATHS.toolRoot, 'package.json'));
  const embeddedManifest = P2A_PATHS.embedded ? readManifest(P2A_PATHS.projectRoot) : null;
  const version = stringValue(packageJson?.version)
    ?? stringValue(embeddedManifest?.provenance?.packageVersion);
  if (!version) {
    console.error('p2a version error: runtime package metadata does not expose a version');
    return 1;
  }
  console.log(version);
  return 0;
}

function readManifest(targetRoot) {
  return readJsonObject(path.join(targetRoot, '.plan2agent', 'manifest.json'));
}

function toolkitScriptFromManifest(targetRoot, scriptName) {
  const manifest = readManifest(targetRoot);
  const toolkitRoot = stringValue(manifest?.provenance?.toolkitRoot);
  if (!toolkitRoot) return null;
  const scriptPath = path.join(toolkitRoot, 'scripts', scriptName);
  return isFile(scriptPath) ? scriptPath : null;
}

function resolveSiblingScript(scriptName) {
  const scriptPath = path.join(P2A_PATHS.scriptsDir, scriptName);
  return isFile(scriptPath) ? scriptPath : null;
}

function resolveToolkitScript(scriptName) {
  if (P2A_PATHS.embedded) {
    const manifestScript = toolkitScriptFromManifest(P2A_PATHS.projectRoot, scriptName);
    if (manifestScript) return manifestScript;
  }
  return resolveSiblingScript(scriptName);
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function withDefaultTarget(args) {
  return hasFlag(args, '--target') ? args : ['--target', P2A_PATHS.projectRoot, ...args];
}

function withDefaultToolkitTarget(command, args) {
  if (hasFlag(args, '--target') || hasFlag(args, '--help') || hasFlag(args, '-h')) return args;
  if (command === 'enhance' && args.length > 1 && !args[1].startsWith('-')) {
    return [args[0], args[1], '--target', P2A_PATHS.projectRoot, ...args.slice(2)];
  }
  if (command === 'enhance') return args;
  if (['init', 'update', 'upgrade', 'scaffold'].includes(command)) {
    return [args[0], '--target', P2A_PATHS.projectRoot, ...args.slice(1)];
  }
  return withDefaultTarget(args);
}

function runScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`p2a error: failed to run ${scriptPath}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`p2a error: command terminated by signal ${result.signal}: ${scriptPath}`);
    return 1;
  }
  return result.status ?? 0;
}

function dispatchRuntime(command, commandArgs) {
  const mapping = RUNTIME_COMMANDS.get(command);
  const scriptPath = resolveSiblingScript(mapping.script);
  if (!scriptPath) {
    console.error(`p2a error: runtime command "${command}" is unavailable because ${mapping.script} is missing`);
    return 1;
  }
  return runScript(scriptPath, mapping.forwardsCommand ? [command, ...commandArgs] : commandArgs);
}

function dispatchToolkit(command, commandArgs) {
  const mapping = TOOLKIT_COMMANDS.get(command);
  const scriptPath = resolveToolkitScript(mapping.script);
  if (!scriptPath) {
    console.error(`p2a error: toolkit command "${command}" is unavailable because ${mapping.script} was not found.`);
    if (P2A_PATHS.embedded) {
      console.error('Run this command from the Plan2Agent toolkit checkout, or repair .plan2agent/manifest.json provenance.toolkitRoot.');
    }
    return 1;
  }
  const forwardedArgs = mapping.forwardsCommand ? [command, ...commandArgs] : commandArgs;
  const args = mapping.defaultTargetWhenEmbedded
    ? withDefaultToolkitTarget(command, forwardedArgs)
    : forwardedArgs;
  return runScript(scriptPath, args);
}

function parseInfoArgs(argv) {
  const args = { target: P2A_PATHS.projectRoot, entry: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else if (arg === '--entry') {
      args.entry = argv[++index];
      if (!args.entry) throw new Error('--entry requires a Markdown or text document path');
    } else throw new Error(`unknown info option: ${arg}`);
  }
  return args;
}

function parseNextArgs(argv) {
  const args = {
    target: P2A_PATHS.projectRoot,
    projectId: null,
    entry: null,
    contract: null,
    json: false,
    trace: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--trace') args.trace = true;
    else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else if (arg === '--project-id') {
      args.projectId = argv[++index];
      if (!args.projectId) throw new Error('--project-id requires a project id');
    } else if (arg === '--entry') {
      args.entry = argv[++index];
      if (!args.entry) throw new Error('--entry requires a document path');
    } else if (arg === '--contract') {
      args.contract = argv[++index];
      if (!['v1', 'v2'].includes(args.contract)) throw new Error('--contract requires v1 or v2');
    } else throw new Error(`unknown next option: ${arg}`);
  }
  args.contract ??= args.json ? 'v1' : 'v2';
  return args;
}

function formatStatusCounts(statusCounts) {
  const entries = Object.entries(statusCounts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([status, count]) => `${status}:${count}`).join(' ') : 'none';
}

function printInfo(info) {
  console.log('Plan2Agent info');
  console.log(`- target: ${info.target}`);
  console.log(`- surface: ${info.surface}`);
  console.log(`- mode: ${info.mode}`);
  console.log(`- artifacts: ${info.artifactCount}`);
  if (info.entry) {
    console.log(`- entry: ${info.entry.path} (${info.entry.valid ? 'valid' : 'invalid'}, ${info.entry.sourceKind})`);
  }
  if (info.config) {
    console.log(`- verification: test=${info.config.testCommand ?? 'none'} lint=${info.config.lintCommand ?? 'none'} typecheck=${info.config.typecheckCommand ?? 'none'}`);
  }
  if (info.enhancements?.enabled?.length) {
    console.log(`- enhancements: ${info.enhancements.enabled.join(', ')}`);
  }
  if (info.enhancements?.buildlore?.enabled) {
    const buildlore = info.enhancements.buildlore;
    console.log(`- buildlore: mode=${buildlore.mode} sync=${buildlore.inSync ? 'ok' : 'drift'} command=${buildlore.command} commandEnv=${buildlore.commandEnv} syncPolicy=${buildlore.syncPolicy} publicationPolicy=${buildlore.publicationPolicy}`);
  }
  if (info.enhancements?.proposals?.enabled) {
    const proposals = info.enhancements.proposals;
    console.log(`- proposals: queue=${proposals.queueDir} entries=${proposals.queueJsonFiles} sync=${proposals.inSync ? 'ok' : 'drift'} reviewPolicy=${proposals.reviewPolicy} patchPolicy=${proposals.patchPolicy} approvalRequired=${proposals.approvalRequired ? 'yes' : 'no'}`);
  }
  if (info.enhancements?.orchestration?.enabled) {
    const orchestration = info.enhancements.orchestration;
    console.log(`- monitor gate: sync=${orchestration.inSync ? 'ok' : 'drift'} policy=${orchestration.monitorGatePolicy}`);
  }
  for (const artifact of info.artifacts) {
    const active = artifact.activeIteration ? ` active=${artifact.activeIteration}` : '';
    console.log(`  - ${artifact.artifactRoot}: ${artifact.layout.kind}${active}`);
    console.log(`    tasks: total=${artifact.taskCounts.total} ready=${artifact.taskCounts.ready} blocked=${artifact.taskCounts.blocked} done=${artifact.taskCounts.done}`);
    console.log(`    runs: total=${artifact.runs.runCount} latest=${artifact.runs.latestRunId ?? 'none'} statuses=${formatStatusCounts(artifact.runs.statusCounts)}`);
    if (artifact.readyTaskIds.length) console.log(`    ready: ${artifact.readyTaskIds.join(', ')}`);
  }
  console.log(`Next: ${p2aCommandLine(P2A_PATHS, ['next'])}`);
}

function runInfo(argv) {
  let args;
  try {
    args = parseInfoArgs(argv);
  } catch (error) {
    console.error(`p2a info error: ${error.message}`);
    console.error('Run with --help for usage.');
    return 1;
  }
  if (args.help) {
    console.log('Usage: p2a info [--target <dir>] [--entry <path>] [--json]');
    return 0;
  }
  try {
    const info = buildInfo(args.target, { entryPath: args.entry });
    if (args.json) console.log(JSON.stringify(info, null, 2));
    else printInfo(info);
    return 0;
  } catch (error) {
    console.error(`p2a info error: ${error.message}`);
    return 1;
  }
}

function renderNextOptionLines(option) {
  const lines = [
    `  - ${option.label} (${option.id})`,
    `    ${option.description}`,
  ];
  if (option.action?.display) lines.push(`    Action: ${option.action.display}`);
  if (typeof option.action?.requiresApproval === 'boolean') {
    lines.push(`    Approval required: ${option.action.requiresApproval ? 'yes' : 'no'}`);
  }
  if (option.action?.remediation?.display) {
    lines.push(`    Remediation: ${option.action.remediation.display}`);
    if (typeof option.action.remediation.requiresApproval === 'boolean') {
      lines.push(`    Remediation approval required: ${option.action.remediation.requiresApproval ? 'yes' : 'no'}`);
    }
  }
  if (option.action?.proposalMining?.display) {
    lines.push(`    Proposal mining: ${option.action.proposalMining.display}`);
    lines.push(`    Proposal mining approval required: ${option.action.proposalMining.requiresApproval ? 'yes' : 'no'}`);
  }
  return lines;
}

function nextCommandArg(next, option) {
  const argv = Array.isArray(next.command?.argv) ? next.command.argv : [];
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function humanNextArtifactContext(next) {
  if (!next.projectId) return {};
  const artifactRoot = path.join(
    next.target,
    '.plan2agent',
    'artifacts',
    next.projectId,
  );
  const currentSpec = readJsonObject(path.join(artifactRoot, 'current-spec.json'));
  const activeIteration = stringValue(currentSpec?.active_iteration);
  const gateRoot = activeIteration
    ? path.join(artifactRoot, 'iterations', activeIteration)
    : artifactRoot;
  const intake = readJsonObject(path.join(gateRoot, 'gate-a-intake', 'intake.json'));
  const spec = readJsonObject(path.join(gateRoot, 'gate-b-spec', 'spec.json'));
  const runId = nextCommandArg(next, '--run-id');
  const runIndex = readJsonObject(path.join(artifactRoot, 'runs', 'run-index.json'));
  const runEntry = Array.isArray(runIndex?.runs)
    ? runIndex.runs.find((entry) => entry?.runId === runId)
    : null;
  const maintenance = Array.isArray(next.command?.argv)
    && (
      next.command.argv.includes('--maintenance')
      || runEntry?.sourceLayout === 'maintenance'
      || runEntry?.iterationId === 'maintenance'
    );
  const taskGraphPath = maintenance
    ? path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json')
    : path.join(gateRoot, 'gate-c-task-graph', 'task-graph.json');
  const taskGraph = readJsonObject(taskGraphPath);
  const positionalTaskId = Array.isArray(next.command?.argv)
    ? next.command.argv.findLast((value) => /^task-[0-9]+$/u.test(value))
    : null;
  const taskId = nextCommandArg(next, '--task') ?? positionalTaskId ?? runEntry?.taskId ?? null;
  const task = Array.isArray(taskGraph?.tasks)
    ? taskGraph.tasks.find((candidate) => candidate?.id === taskId)
    : null;
  return {
    artifactRoot,
    intake,
    spec,
    task,
  };
}

function normalizedSentence(value) {
  return stringValue(value)?.replace(/\s+/gu, ' ').trim() ?? null;
}

function humanNextSummary(next, context) {
  const intakeSummary = normalizedSentence(context.intake?.summary)
    ?? normalizedSentence(context.intake?.idea);
  const problem = normalizedSentence(context.spec?.product?.problem);
  const goal = Array.isArray(context.spec?.product?.goals)
    ? normalizedSentence(context.spec.product.goals[0])
    : null;
  const taskIntent = normalizedSentence(context.task?.intent)
    ?? normalizedSentence(context.task?.title);
  switch (next.state) {
    case 'gate_what':
      return [
        '지금 결정하는 것: 요청한 결과와 포함·제외 범위를 이렇게 이해한 것이 맞는지 확인합니다.',
        '맞으면 → 확인한 범위를 기록합니다.',
        '다르면 → 잘못 이해한 부분을 고친 뒤 다시 확인합니다.',
      ];
    case 'gate_a_needs_approval':
      return [
        `지금 결정하는 것: ${intakeSummary ?? '무엇을 만들고 어디까지 포함할지 정한 범위입니다.'}`,
        '승인하면 → 이 범위로 개발 계획을 작성합니다.',
        '거부하면 → 범위를 수정한 뒤 다시 확인합니다.',
      ];
    case 'shape':
      return [
        `지금 결정하는 것: ${next.projectId ?? '이 프로젝트'}에서 개발하는 동안 계속 지킬 공통 원칙입니다.`,
        '승인하면 → 이 원칙을 기준으로 개발 계획을 구체화합니다.',
        '거부하면 → 원칙을 수정한 뒤 다시 확인합니다.',
      ];
    case 'gate_b_needs_approval':
      return [
        `지금 결정하는 것: ${[problem, goal].filter(Boolean).join(' ') || '무엇을 만들고 완료 여부를 어떻게 확인할지 정한 개발 계획입니다.'}`,
        '승인하면 → 이 계획 안에서 구현과 검증을 시작합니다.',
        '거부하면 → 계획을 수정한 뒤 다시 확인합니다.',
      ];
    case 'iteration_review_or_close_required':
      return [
        '개발이 끝났습니다. 결과를 한 번 더 살펴볼지, 현재 작업 묶음을 완료 처리할지 선택합니다.',
        ...(next.retrospective?.candidateCount
          ? [`현재 실행 증거에서 회고 후보 ${next.retrospective.candidateCount}개를 찾았습니다. 후보 검토는 선택 사항입니다.`]
          : []),
        '검토를 선택하면 → 문제가 있으면 수정하고, 없으면 다시 완료 여부를 묻습니다.',
        '완료를 선택하면 → 현재 작업 묶음을 닫습니다.',
      ];
    case 'ready_task_available':
      return [
        `다음에 할 일: ${taskIntent ?? '승인된 계획에서 다음 작업을 시작합니다.'}`,
        '실행하면 → 이 결과를 만들고 확인 절차까지 이어갑니다.',
      ];
    case 'run_started':
      return [
        `진행 중인 일: ${taskIntent ?? '이미 시작한 작업을 이어서 완료합니다.'}`,
        '이어가면 → 남은 구현과 확인 절차를 계속합니다.',
      ];
    case 'tasks_blocked':
      return [
        `멈춘 일: ${taskIntent ?? '진행을 막는 원인을 확인해야 합니다.'}`,
        '원인을 해결하면 → 같은 작업을 다시 시작할 수 있습니다.',
      ];
    case 'final_visual_review_required':
      return [
        '화면이 약속한 모습과 동작을 갖췄는지 마지막으로 확인합니다.',
        '문제가 없으면 → 완료 여부를 선택하는 단계로 이동합니다.',
        '문제가 있으면 → 관련 작업을 다시 열어 수정합니다.',
      ];
    case 'final_acceptance_review_required':
      return [
        '사용자가 기대한 동작이 실제로 작동하는지 마지막으로 확인합니다.',
        '문제가 없으면 → 완료 여부를 선택하는 단계로 이동합니다.',
        '문제가 있으면 → 관련 작업을 다시 열어 수정합니다.',
      ];
    case 'final_verification_required':
      return [
        '현재 코드 전체가 함께 정상 동작하는지 마지막 검증을 한 번 실행합니다.',
        '통과하면 → 결과 검토 또는 작업 묶음 완료를 선택합니다.',
        '실패하면 → 관련 작업을 다시 열어 수정합니다.',
      ];
    default:
      return ['다음 단계로 진행하려면 아래 안내를 따르세요.'];
  }
}

function humanCommandDisplay(next) {
  const display = next.command?.display ?? '';
  if (next.command?.kind !== 'approval') return display;
  const commandStart = display.indexOf('p2a ');
  const command = commandStart >= 0
    ? display.slice(commandStart).replace(/\.$/u, '')
    : display;
  return command.replace(
    /<user utterance>|<user-utterance>/gu,
    '<사용자가 실제로 승인한 문장>',
  );
}

export function renderNextHuman(next, context = humanNextArtifactContext(next)) {
  const lines = [
    'Plan2Agent next',
    '',
    '[한눈에]',
    ...humanNextSummary(next, context),
    '',
    '[실행 명령]',
    `  ${humanCommandDisplay(next)}`,
  ];
  if (Array.isArray(next.command.options) && next.command.options.length) {
    lines.push('Options:');
    for (const option of next.command.options) lines.push(...renderNextOptionLines(option));
  }
  if (Array.isArray(next.retrospective?.candidates) && next.retrospective.candidates.length) {
    lines.push('Retrospective candidates:');
    for (const candidate of next.retrospective.candidates) {
      lines.push(
        `  - ${candidate.signal}: ${candidate.measurement.category} observed=${candidate.measurement.observed} threshold=${candidate.measurement.threshold}`,
      );
    }
  }
  lines.push('', '[세부 계약]', `- target: ${next.target}`);
  if (next.projectId) lines.push(`- projectId: ${next.projectId}`);
  lines.push(`- state: ${next.state}`, `- reason: ${next.reason}`);
  return `${lines.join('\n')}\n`;
}

function printNext(next) {
  process.stdout.write(renderNextHuman(next));
}

function runNext(argv) {
  let args;
  try {
    args = parseNextArgs(argv);
  } catch (error) {
    console.error(`p2a next error: ${error.message}`);
    console.error('Run with --help for usage.');
    return 1;
  }
  if (args.help) {
    console.log('Usage: p2a next [--target <dir>] [--project-id <id>] [--entry <path>] [--contract v1|v2] [--json] [--trace]');
    return 0;
  }
  try {
    const next = buildNext(
      args.target,
      args.projectId,
      args.entry,
      args.contract,
      args.trace
        ? { trace: (message) => console.error(`[p2a next] ${message}`) }
        : {},
    );
    if (args.json) console.log(JSON.stringify(next, null, 2));
    else printNext(next);
    return 0;
  } catch (error) {
    console.error(`p2a next error: ${error.message}`);
    return 1;
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, ...commandArgs] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    return 0;
  }
  if (command === '--version' || command === '-v') return runVersion(commandArgs);
  if (command === 'next') return runNext(commandArgs);
  if (command === 'info' || command === 'status') return runInfo(commandArgs);
  if (RUNTIME_COMMANDS.has(command)) return dispatchRuntime(command, commandArgs);
  if (TOOLKIT_COMMANDS.has(command)) return dispatchToolkit(command, commandArgs);
  console.error(`p2a error: unknown command "${command}"`);
  console.error('Run with --help for usage.');
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
