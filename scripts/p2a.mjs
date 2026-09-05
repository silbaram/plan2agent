#!/usr/bin/env node
/** Top-level Plan2Agent command dispatcher. Domain decisions live in p2a_next_service.mjs. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveP2aPaths } from './p2a_paths.mjs';
import { p2aCommandLine } from './p2a_run_commands.mjs';
import { buildInfo, buildNext } from './p2a_next_service.mjs';
import { atomicWriteText } from './p2a_run_store.mjs';
import { assertFinalFullVerificationReady } from './p2a_final_verification_gate.mjs';

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
    '  p2a next [--target <dir>] [--project-id <id>] [--entry <path>|--idea <text>] [--contract v1|v2] [--json] [--details] [--trace]',
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
    '  p2a execute <prepare|plan|start|review|accept|retry|resume|status|finish> [options]',
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
    idea: null,
    contract: null,
    json: false,
    details: false,
    trace: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--details') args.details = true;
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
    } else if (arg === '--idea') {
      args.idea = argv[++index];
      if (!args.idea?.trim()) throw new Error('--idea requires non-blank text');
    } else if (arg === '--contract') {
      args.contract = argv[++index];
      if (!['v1', 'v2'].includes(args.contract)) throw new Error('--contract requires v1 or v2');
    } else throw new Error(`unknown next option: ${arg}`);
  }
  if (args.entry && args.idea) throw new Error('--entry and --idea cannot be combined');
  args.contract ??= args.json ? 'v1' : 'v2';
  return args;
}

function materializeProvisionalEntry(targetRoot, idea) {
  const harnessRoot = path.join(path.resolve(targetRoot), '.plan2agent');
  if (!existsSync(harnessRoot) || !lstatSync(harnessRoot).isDirectory()) {
    throw new Error('--idea requires an initialized project; run p2a init first');
  }
  const normalized = `${idea.trim().replace(/\r\n?/g, '\n')}\n`;
  const digest = createHash('sha256').update(normalized).digest('hex');
  const entriesRoot = path.join(harnessRoot, 'entries');
  if (existsSync(entriesRoot)) {
    if (!lstatSync(entriesRoot).isDirectory()) {
      throw new Error(`provisional entry directory must be a real directory: ${entriesRoot}`);
    }
  } else {
    mkdirSync(entriesRoot);
  }
  const entryPath = path.join(entriesRoot, `idea-${digest.slice(0, 12)}.md`);
  if (existsSync(entryPath)) {
    if (!lstatSync(entryPath).isFile() || readFileSync(entryPath, 'utf8') !== normalized) {
      throw new Error(`provisional entry collision at ${entryPath}`);
    }
    // Rewriting the same content keeps its stable path while marking this
    // invocation as a fresh request after an earlier iteration consumed it.
    atomicWriteText(entryPath, normalized);
    return entryPath;
  }
  atomicWriteText(entryPath, normalized);
  return entryPath;
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
  if (option.action?.report?.display) {
    lines.push(`    Retrospective report: ${option.action.report.path}`);
    lines.push(`    Report approval required: ${option.action.report.requiresApproval ? 'yes' : 'no'}`);
  }
  if (option.action?.proposalMining?.display) {
    lines.push(`    Proposal mining: ${option.action.proposalMining.display}`);
    lines.push(`    Proposal mining approval required: ${option.action.proposalMining.requiresApproval ? 'yes' : 'no'}`);
  }
  return lines;
}

function nextCommandArg(next, option) {
  const argv = Array.isArray(next.command?.argv)
    ? next.command.argv
    : Array.isArray(next.command?.args)
      ? next.command.args
      : [];
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function completionEvidenceRuns(completedRuns, readiness = null) {
  if (readiness?.run) {
    return [...new Set([readiness.run, readiness.relevantRun].filter(Boolean))];
  }
  const hasPassedFullVerification = (run) => (
    (run.verification ?? []).some((item) => (
      item.scope === 'full'
      && item.status === 'passed'
      && item.exitCode === 0
      && (item.source === 'config' || item.source === 'command')
    ))
  );
  const latestFull = [...completedRuns].reverse().find((run) => (
    (
      !run.runKind
      || (run.runKind === 'final_verification' && run.verificationScope !== 'relevant')
    )
    && hasPassedFullVerification(run)
  ));
  const latestRelevant = [...completedRuns].reverse().find((run) => (
    run.runKind === 'final_verification'
    && run.verificationScope === 'relevant'
  ));
  const selected = [...new Set([
    latestFull,
    latestRelevant,
  ].filter(Boolean))];
  return selected.length ? selected : completedRuns.slice(-1);
}

function humanNextArtifactContext(next, { requestIdea = null } = {}) {
  const requestContext = stringValue(requestIdea)
    ? { requestIdea: requestIdea.trim() }
    : {};
  if (!next.projectId) return requestContext;
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
  const runsDir = path.join(artifactRoot, 'runs');
  const runIndex = readJsonObject(path.join(runsDir, 'run-index.json'));
  const indexedRuns = Array.isArray(runIndex?.runs) ? runIndex.runs : [];
  const runEntry = indexedRuns.length
    ? indexedRuns.find((entry) => entry?.runId === runId)
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
  const currentRuns = indexedRuns
    .filter((entry) => (
      (activeIteration ? entry.iterationId === activeIteration : true)
      && typeof entry.runRef === 'string'
    ))
    .map((entry) => readJsonObject(path.join(runsDir, entry.runRef)))
    .filter(Boolean);
  const completedRuns = currentRuns.filter((run) => run.status === 'finished');
  const completedTasks = Array.isArray(taskGraph?.tasks)
    ? taskGraph.tasks.filter((candidate) => candidate?.status === 'done')
    : [];
  const implementationRuns = completedRuns.filter((run) => !run.runKind);
  let verificationReadiness = null;
  let verificationReadinessFailed = false;
  if (next.state === 'iteration_review_or_close_required' && activeIteration) {
    try {
      verificationReadiness = assertFinalFullVerificationReady({
        runsDir,
        runs: currentRuns,
        artifactRoot,
        graphPath: taskGraphPath,
        activeIteration,
      });
    } catch {
      // The workspace may have changed after the state decision. Do not present
      // older evidence as current while the next action is being recalculated.
      verificationReadinessFailed = true;
    }
  }
  const evidenceRuns = verificationReadinessFailed
    ? []
    : completionEvidenceRuns(completedRuns, verificationReadiness);
  return {
    ...requestContext,
    artifactRoot,
    intake,
    spec,
    task,
    completion: {
      verificationCurrent: verificationReadinessFailed ? false : true,
      outcomes: completedTasks
        .map((candidate) => normalizedSentence(candidate.intent) ?? normalizedSentence(candidate.title))
        .filter(Boolean),
      changedFiles: [...new Set(implementationRuns.flatMap((run) => run.changedFiles ?? []))],
      verification: verificationReadiness?.verification ?? evidenceRuns.flatMap((run) => (
        (run.verification ?? []).filter((item) => (
          item.status === 'passed'
          && item.exitCode === 0
          && (item.source === 'config' || item.source === 'command')
        ))
      )),
    },
  };
}

function normalizedSentence(value) {
  return stringValue(value)?.replace(/\s+/gu, ' ').trim() ?? null;
}

function boundNextIterationIdea(next, context = {}) {
  const idea = normalizedSentence(context.requestIdea)
    ?? normalizedSentence(nextCommandArg(next, '--idea'));
  return idea && idea !== '<change idea>' ? idea : null;
}

function humanOutputLanguage(next, context) {
  const requestIdea = normalizedSentence(context.requestIdea)
    ?? boundNextIterationIdea(next);
  if (requestIdea) {
    if (/[가-힣]/u.test(requestIdea)) return 'ko';
    if (/[A-Za-z]/u.test(requestIdea)) return 'en';
  }
  const values = [
    context.intake?.idea,
    context.intake?.summary,
    context.spec?.product,
    context.task?.intent,
    context.task?.title,
    context.completion?.outcomes,
    next.command?.decisionSummary,
  ].filter((value) => value !== null && value !== undefined);
  const signal = values.map((value) => (
    typeof value === 'string' ? value : JSON.stringify(value)
  )).join('\n');
  if (/[가-힣]/u.test(signal)) return 'ko';
  return /[A-Za-z]/u.test(signal) ? 'en' : 'ko';
}

function humanCompletionEvidence(context, language = 'ko') {
  const completion = context.completion ?? {};
  const outcomes = Array.isArray(completion.outcomes) ? completion.outcomes : [];
  const changedFiles = Array.isArray(completion.changedFiles) ? completion.changedFiles : [];
  const verification = Array.isArray(completion.verification) ? completion.verification : [];
  const verificationCounts = new Map();
  const seenVerification = new Set();
  for (const item of verification) {
    const key = `${item.type ?? 'custom'}\0${item.command ?? ''}`;
    if (seenVerification.has(key)) continue;
    seenVerification.add(key);
    verificationCounts.set(item.type, (verificationCounts.get(item.type) ?? 0) + 1);
  }
  const checks = [...verificationCounts]
    .map(([type, count]) => (
      language === 'ko'
        ? `${verificationLabel(type, language)} ${count}건`
        : `${verificationLabel(type, language)}: ${count}`
    ))
    .join(', ');
  if (language === 'en') {
    return [
      ...(outcomes.length
        ? [`Completed outcomes: ${outcomes.slice(0, 3).join(' / ')}${outcomes.length > 3 ? ` and ${outcomes.length - 3} more` : ''}`]
        : []),
      ...(changedFiles.length
        ? [`Changed scope: ${changedFiles.length} file(s) (${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` and ${changedFiles.length - 3} more` : ''})`]
        : []),
      ...(checks ? [`Passed checks: ${checks}`] : []),
    ];
  }
  return [
    ...(outcomes.length
      ? [`완료한 결과: ${outcomes.slice(0, 3).join(' / ')}${outcomes.length > 3 ? ` 외 ${outcomes.length - 3}건` : ''}`]
      : []),
    ...(changedFiles.length
      ? [`변경 범위: ${changedFiles.length}개 파일 (${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` 외 ${changedFiles.length - 3}개` : ''})`]
      : []),
    ...(checks ? [`통과한 확인: ${checks}`] : []),
  ];
}

function humanNextSummaryEnglish(next, context) {
  const intakeSummary = normalizedSentence(context.requestIdea)
    ?? normalizedSentence(context.intake?.summary)
    ?? normalizedSentence(context.intake?.idea);
  const problem = normalizedSentence(context.spec?.product?.problem);
  const goal = Array.isArray(context.spec?.product?.goals)
    ? normalizedSentence(context.spec.product.goals[0])
    : null;
  const taskIntent = normalizedSentence(context.task?.intent)
    ?? normalizedSentence(context.task?.title);
  const decisionSummary = Array.isArray(next.command?.decisionSummary)
    ? next.command.decisionSummary.map(normalizedSentence).filter(Boolean)
    : [];
  const nextIterationIdea = boundNextIterationIdea(next, context);
  switch (next.state) {
    case 'uninitialized':
      return [
        'This project needs the P2A development guide initialized.',
        'If allowed → P2A adds only its configuration and leaves product files untouched.',
      ];
    case 'project_selection_required': {
      const projects = /\(([^)]+)\)/u.exec(next.reason ?? '')?.[1];
      return [
        'More than one managed project is available, so choose which project to continue.',
        ...(projects ? [`Available projects: ${projects}`] : []),
      ];
    }
    case 'entry_missing':
      return [
        'P2A does not yet know what you want to build or change.',
        'Share a short natural-language request or an existing product document → P2A will confirm its understanding first.',
      ];
    case 'entry_invalid':
      return [
        'The supplied product document cannot be used as written.',
        'Fix the document or restate the request in natural language → P2A will resume from scope confirmation.',
      ];
    case 'entry_deferred':
      return [
        'P2A saved the new request, but the current approved work is still active.',
        'It will not silently replace that work or start the new request ahead of it.',
      ];
    case 'blocked_scope_replacement_ready':
      return [
        'The current work is blocked, and the new request changes the approved scope instead of applying the bounded recovery.',
        'P2A can start a separate replacement plan while keeping the incomplete task graph and run evidence unchanged; the old work is not marked complete.',
        'This changes the active planning scope, so explicit approval is required first.',
      ];
    case 'gate_what':
      return [
        ...(intakeSummary ? [`Understood request: ${intakeSummary}`] : []),
        'P2A is confirming the requested outcome and boundaries, and will ask only decisions that materially affect the result.',
        'If correct → P2A records the understood scope.',
        'If incorrect → correct the misunderstanding before planning continues.',
      ];
    case 'gate_a_ready_for_spec':
      return [
        'The requested outcome and scope are clear.',
        'P2A will now turn them into a development and verification plan.',
      ];
    case 'gate_a_needs_approval':
      return [
        decisionSummary.length
          ? 'Scope to confirm:'
          : `Decision now: ${intakeSummary ?? 'the outcome to build and the boundary of this change.'}`,
        ...decisionSummary.map((item) => `- ${item}`),
        'Approve → P2A prepares the development plan from this scope.',
        'Reject → P2A revises the scope and asks again.',
      ];
    case 'shape':
      return [
        decisionSummary.length
          ? 'Long-term project rules to confirm:'
          : `Decision now: shared rules that future work in ${next.projectId ?? 'this project'} must preserve.`,
        ...decisionSummary.map((item) => `- ${item}`),
        'Approve → P2A uses these rules while preparing the plan.',
        'Reject → P2A revises the rules and asks again.',
      ];
    case 'gate_b_needs_approval':
      return [
        decisionSummary.length
          ? 'Development plan to confirm:'
          : `Decision now: ${[problem, goal].filter(Boolean).join(' ') || 'the implementation plan and how completion will be verified.'}`,
        ...decisionSummary.map((item) => `- ${item}`),
        'Approve → implementation and verification begin within this plan.',
        'Reject → P2A revises the plan and asks again.',
      ];
    case 'gate_b_needs_decisions':
      return [
        'The development plan still contains an important choice only you can make.',
        'P2A will ask only that decision → then show the complete updated plan again.',
      ];
    case 'gate_b_approved_needs_execution_prepare':
      return [
        'The development plan is approved.',
        'P2A will choose an execution approach that fits the change size and risk, then start implementation.',
      ];
    case 'gate_b_approved_needs_tasks':
      return [
        'The development plan is approved.',
        'P2A will split it into a short dependency-aware work sequence that can be executed directly.',
      ];
    case 'gate_c_validated_needs_iteration_init':
      return [
        'The implementation sequence is ready.',
        'P2A will prepare this development batch and start the first task without another approval.',
      ];
    case 'iteration_review_or_close_required':
      if (context.completion?.verificationCurrent === false) {
        return [
          'The workspace changed after completion was calculated, so P2A will not present the older verification as current.',
          'Recheck the current state → P2A will select the smallest required verification before review or close.',
        ];
      }
      return [
        'Development is complete. Choose whether to review the product result, reflect on the P2A process, or close this development batch.',
        ...humanCompletionEvidence(context, 'en'),
        ...(next.retrospective?.candidateCount
          ? [`P2A found ${next.retrospective.candidateCount} bounded retrospective candidate(s) in the current execution evidence.`]
          : ['Verification is current and P2A found no automatic process concern, so closing is recommended unless you want an extra review.']),
        'Product review → report findings; fix them only when requested. If clean, ask once to close without repeating the menu.',
        'P2A retrospective → summarize detected signals or your experience. A request to write a report or publish a GitHub issue needs no repeated approval for that same outcome.',
        'Close → finish the current development batch.',
      ];
    case 'flat_execution_complete':
      return [
        'The requested development and verification are complete.',
        ...humanCompletionEvidence(context, 'en'),
        'This handoff has no separate iteration state to close.',
      ];
    case 'ready_task_available':
      return [
        `Next work: ${taskIntent ?? 'start the next task in the approved plan.'}`,
        'Continue → P2A implements this result and runs the required checks.',
      ];
    case 'run_started':
      return [
        `Work in progress: ${taskIntent ?? 'continue the task that is already in progress.'}`,
        'Continue → P2A finishes the remaining implementation and verification.',
      ];
    case 'started_run_contract_drift':
      return [
        'The approved plan and current development materials changed while work was in progress, so P2A cannot safely continue it as-is.',
        'Restore an accidental change, or close this work and prepare a new plan if the change was intentional.',
      ];
    case 'incomplete_iteration_layout':
      return [
        'Part of the current development record is missing, so P2A cannot safely continue yet.',
        'P2A will inspect the record and identify the smallest repair.',
      ];
    case 'current_development_contract_required':
    case 'gate_b_approved_needs_spec_promotion':
      return [
        'The approved plan stays unchanged while P2A updates an older development record to the current format.',
        'After repair → development preparation continues without another approval.',
      ];
    case 'invalid_current_development_contract':
      return [
        'The execution contract is no longer correctly linked to the approved plan.',
        'P2A will rebuild that link without changing the approved meaning.',
      ];
    case 'invalid_iteration_state':
    case 'invalid_decisions':
    case 'invalid_gate_a':
    case 'invalid_constitution':
    case 'invalid_gate_b':
    case 'invalid_gate_c':
      return [
        'P2A found inconsistent current development records.',
        'P2A will diagnose the exact cause first and ask you only if it cannot recover safely.',
      ];
    case 'invalid_run_evidence':
      return [
        'The execution or verification record no longer matches the current development state and cannot prove completion.',
        'P2A will inspect it and choose the smallest safe resume or re-verification path.',
      ];
    case 'tasks_blocked':
      if (next.command?.kind === 'approval' && decisionSummary.length) {
        return [
          `Blocked work: ${taskIntent ?? 'the blocking cause needs a user decision.'}`,
          'Decision needed:',
          ...decisionSummary.map((item) => `- ${item}`),
          'Approve → P2A records the answer and returns the same task to a correctable state.',
        ];
      }
      return [
        `Blocked work: ${taskIntent ?? 'the blocking cause must be resolved.'}`,
        'After the cause is resolved → P2A can retry the same task.',
      ];
    case 'final_visual_review_required':
      return [
        'P2A will verify that the interface has the promised appearance and behavior.',
        'No issue → move to the completion choice.',
        'Issue found → reopen and correct only the related task.',
      ];
    case 'final_acceptance_review_required':
      return [
        'P2A will verify that the behavior users expect actually works.',
        'No issue → move to the completion choice.',
        'Issue found → reopen and correct only the related task.',
      ];
    case 'final_verification_required':
      return [
        'P2A will run one final full check that the current product works together.',
        'Pass → move to product review or close.',
        'Fail → reopen and correct the related task.',
      ];
    case 'relevant_verification_required':
      return [
        'Product files did not change, or the existing product verification is still current, so P2A will not repeat the full test suite.',
        'P2A will run only the checks needed for the changed documentation or metadata.',
        'Pass → move to product review or close.',
      ];
    case 'iteration_complete':
      if (nextIterationIdea) {
        return [
          'The current development batch is closed.',
          `Saved next request: ${nextIterationIdea}`,
          'If this is correct → P2A can open the next scope without asking you to enter it again.',
        ];
      }
      return [
        'The current development batch is closed.',
        'Share the next change you want → P2A will derive the next scope from the completed result.',
      ];
    default:
      return ['Follow the recommendation below to continue.'];
  }
}

function humanNextSummary(next, context) {
  if (humanOutputLanguage(next, context) === 'en') {
    return humanNextSummaryEnglish(next, context);
  }
  const intakeSummary = normalizedSentence(context.requestIdea)
    ?? normalizedSentence(context.intake?.summary)
    ?? normalizedSentence(context.intake?.idea);
  const problem = normalizedSentence(context.spec?.product?.problem);
  const goal = Array.isArray(context.spec?.product?.goals)
    ? normalizedSentence(context.spec.product.goals[0])
    : null;
  const taskIntent = normalizedSentence(context.task?.intent)
    ?? normalizedSentence(context.task?.title);
  const decisionSummary = Array.isArray(next.command?.decisionSummary)
    ? next.command.decisionSummary.map(normalizedSentence).filter(Boolean)
    : [];
  const nextIterationIdea = boundNextIterationIdea(next, context);
  switch (next.state) {
    case 'uninitialized':
      return [
        '이 프로젝트에서 P2A 개발 안내를 시작할 준비가 필요합니다.',
        '허용하면 → 기존 제품 파일은 건드리지 않고 P2A 구성만 추가합니다.',
      ];
    case 'project_selection_required': {
      const projects = /\(([^)]+)\)/u.exec(next.reason ?? '')?.[1];
      return [
        '관리 중인 프로젝트가 여러 개라서 이번에 이어갈 프로젝트를 정해야 합니다.',
        ...(projects ? [`선택 가능한 프로젝트: ${projects}`] : []),
      ];
    }
    case 'entry_missing':
      return [
        '무엇을 만들거나 고칠지 아직 입력되지 않았습니다.',
        '짧은 자연어 요청이나 준비한 기획 문서를 알려주면 → 이해한 범위를 먼저 확인합니다.',
      ];
    case 'entry_invalid':
      return [
        '입력한 기획 문서를 그대로 사용할 수 없어 내용을 바로잡아야 합니다.',
        '문서를 수정하거나 같은 내용을 자연어로 알려주면 → 범위 확인부터 다시 이어갑니다.',
      ];
    case 'entry_deferred':
      return [
        '새 요청은 보관했지만, 현재 승인된 개발이 아직 진행 중입니다.',
        '기존 작업을 몰래 바꾸거나 새 요청을 먼저 시작하지 않습니다.',
      ];
    case 'blocked_scope_replacement_ready':
      return [
        '현재 작업은 막혀 있고, 새 요청은 기존 복구가 아니라 승인 범위를 바꾸는 내용입니다.',
        '이전의 미완료 작업과 실행 기록은 그대로 남기고 새 범위 계획을 시작할 수 있습니다. 이전 작업을 완료로 처리하지 않습니다.',
        '활성 개발 범위가 바뀌므로 시작 전에 사용자의 명시적 승인이 필요합니다.',
      ];
    case 'gate_what':
      return [
        ...(intakeSummary ? [`이해한 요청: ${intakeSummary}`] : []),
        '요청한 결과와 포함·제외 범위를 확인하고, 아직 답이 필요한 중요한 질문만 이어서 묻습니다.',
        '맞으면 → 확인한 범위를 기록합니다.',
        '다르면 → 잘못 이해한 부분을 고친 뒤 다시 확인합니다.',
      ];
    case 'gate_a_ready_for_spec':
      return [
        '요청한 결과와 범위 확인이 끝났습니다.',
        '이제 무엇을 어떻게 바꾸고 확인할지 개발 계획으로 정리합니다.',
      ];
    case 'gate_a_needs_approval':
      return [
        decisionSummary.length
          ? '지금 확인할 범위:'
          : `지금 결정하는 것: ${intakeSummary ?? '무엇을 만들고 어디까지 포함할지 정한 범위입니다.'}`,
        ...decisionSummary.map((item) => `- ${item}`),
        '승인하면 → 이 범위로 개발 계획을 작성합니다.',
        '거부하면 → 범위를 수정한 뒤 다시 확인합니다.',
      ];
    case 'shape':
      return [
        decisionSummary.length
          ? '지금 확인할 장기 프로젝트 원칙:'
          : `지금 결정하는 것: ${next.projectId ?? '이 프로젝트'}에서 개발하는 동안 계속 지킬 공통 원칙입니다.`,
        ...decisionSummary.map((item) => `- ${item}`),
        '승인하면 → 이 원칙을 기준으로 개발 계획을 구체화합니다.',
        '거부하면 → 원칙을 수정한 뒤 다시 확인합니다.',
      ];
    case 'gate_b_needs_approval':
      return [
        decisionSummary.length
          ? '지금 확인할 개발 계획:'
          : `지금 결정하는 것: ${[problem, goal].filter(Boolean).join(' ') || '무엇을 만들고 완료 여부를 어떻게 확인할지 정한 개발 계획입니다.'}`,
        ...decisionSummary.map((item) => `- ${item}`),
        '승인하면 → 이 계획 안에서 구현과 검증을 시작합니다.',
        '거부하면 → 계획을 수정한 뒤 다시 확인합니다.',
      ];
    case 'gate_b_needs_decisions':
      return [
        '개발 계획에 아직 사용자가 정해야 할 중요한 내용이 남아 있습니다.',
        '필요한 결정만 확인한 뒤 → 결정이 반영된 전체 계획을 다시 보여드립니다.',
      ];
    case 'gate_b_approved_needs_execution_prepare':
      return [
        '개발 계획이 승인되었습니다.',
        'P2A가 작업 크기와 위험에 맞는 진행 방식을 준비한 뒤 구현을 시작합니다.',
      ];
    case 'gate_b_approved_needs_tasks':
      return [
        '개발 계획이 승인되었습니다.',
        '바로 실행할 수 있도록 작업 순서와 서로 의존하는 부분을 짧게 나눕니다.',
      ];
    case 'gate_c_validated_needs_iteration_init':
      return [
        '구현할 작업 순서까지 확인되었습니다.',
        '현재 개발 묶음을 준비한 뒤 추가 승인 없이 첫 작업을 시작합니다.',
      ];
    case 'iteration_review_or_close_required':
      if (context.completion?.verificationCurrent === false) {
        return [
          '완료 상태를 계산한 뒤 작업 파일이 바뀌어 이전 검증을 최신 근거로 표시하지 않습니다.',
          '현재 상태를 다시 확인하면 → 필요한 최소 검증을 선택한 뒤 리뷰나 종료로 이어갑니다.',
        ];
      }
      return [
        '개발이 끝났습니다. 제품 결과를 검토할지, P2A 개발 과정을 회고할지, 현재 작업 묶음을 완료할지 선택합니다.',
        ...humanCompletionEvidence(context),
        ...(next.retrospective?.candidateCount
          ? [`현재 실행 증거에서 P2A 회고 후보 ${next.retrospective.candidateCount}개를 찾았습니다.`]
          : ['검증 증거가 최신이고 자동으로 발견된 P2A 문제도 없어, 특별히 더 확인할 내용이 없다면 종료를 권장합니다.']),
        '제품 검토를 선택하면 → 발견한 문제를 보고하고, 수정은 요청한 경우에만 진행합니다. 문제가 없으면 메뉴를 반복하지 않고 종료할지 한 번만 묻습니다.',
        'P2A 회고를 선택하면 → 발견된 신호나 사용자 경험을 짧게 정리합니다. 문서 작성이나 GitHub 이슈 등록을 요청하면 같은 요청을 재승인받지 않고 진행합니다.',
        '완료를 선택하면 → 현재 작업 묶음을 닫습니다.',
      ];
    case 'flat_execution_complete':
      return [
        '요청한 개발과 검증이 완료되었습니다.',
        ...humanCompletionEvidence(context),
        '이 전달 묶음에는 별도로 닫을 반복 개발 상태가 없습니다.',
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
    case 'started_run_contract_drift':
      return [
        '진행 중이던 작업의 승인된 계획과 현재 개발 자료가 달라 그대로 이어갈 수 없습니다.',
        '실수로 바뀐 자료라면 원래대로 복원하고, 의도한 변경이라면 현재 작업을 정리한 뒤 새 계획으로 이어갑니다.',
      ];
    case 'incomplete_iteration_layout':
      return [
        '현재 개발 기록의 일부가 빠져 있어 다음 단계로 안전하게 이어갈 수 없습니다.',
        'P2A가 기록 구조를 검사해 정확히 복구할 부분을 확인합니다.',
      ];
    case 'current_development_contract_required':
    case 'gate_b_approved_needs_spec_promotion':
      return [
        '승인된 계획은 그대로 유지하면서 이전 형식의 개발 기록을 현재 형식으로 정리합니다.',
        '정리가 끝나면 → 추가 승인 없이 개발 준비를 이어갑니다.',
      ];
    case 'invalid_current_development_contract':
      return [
        '현재 실행 계약과 승인된 계획의 연결이 맞지 않아 자동으로 다시 구성해야 합니다.',
        'P2A가 승인 내용을 바꾸지 않고 계약만 복구합니다.',
      ];
    case 'invalid_iteration_state':
    case 'invalid_decisions':
    case 'invalid_gate_a':
    case 'invalid_constitution':
    case 'invalid_gate_b':
    case 'invalid_gate_c':
      return [
        '현재 개발 기록에서 서로 맞지 않는 부분을 발견했습니다.',
        'P2A가 먼저 정확한 원인을 검사하고, 자동 복구할 수 없을 때만 필요한 결정을 요청합니다.',
      ];
    case 'invalid_run_evidence':
      return [
        '실행 또는 검증 기록이 현재 개발 상태와 맞지 않아 완료 증거로 사용할 수 없습니다.',
        'P2A가 기록을 검사해 재개하거나 다시 검증할 최소 범위를 정합니다.',
      ];
    case 'tasks_blocked':
      if (next.command?.kind === 'approval' && decisionSummary.length) {
        return [
          `멈춘 일: ${taskIntent ?? '진행을 막는 원인을 확인해야 합니다.'}`,
          '사용자 결정이 필요한 내용:',
          ...decisionSummary.map((item) => `- ${item}`),
          '승인하면 → 답변을 기록하고 같은 작업을 수정 가능한 상태로 되돌립니다.',
        ];
      }
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
    case 'relevant_verification_required':
      return [
        '제품 파일은 바뀌지 않았거나 기존 제품 검증이 그대로 유효해 전체 테스트를 반복하지 않습니다.',
        '지금 바뀐 문서·메타데이터에 필요한 검사만 실행합니다.',
        '통과하면 → 결과 검토 또는 작업 묶음 완료를 선택합니다.',
      ];
    case 'iteration_complete':
      if (nextIterationIdea) {
        return [
          '현재 작업 묶음은 완료되었습니다.',
          `다음 요청으로 저장된 내용: ${nextIterationIdea}`,
          '이 내용이 맞으면 → 다시 입력하지 않고 이 요청으로 다음 개발 범위를 엽니다.',
        ];
      }
      return [
        '현재 작업 묶음은 완료되었습니다.',
        '새로 만들거나 고칠 내용을 알려주면 → 이전 결과를 기준으로 다음 개발 범위를 정리합니다.',
      ];
    default:
      return ['다음 단계로 진행하려면 아래 안내를 따르세요.'];
  }
}

function humanDuration(milliseconds, language = 'ko') {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return `${milliseconds}ms`;
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  return language === 'ko'
    ? `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}초`
    : `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function verificationLabel(category, language = 'ko') {
  if (language === 'en') {
    return ({
      test: 'test',
      lint: 'lint',
      typecheck: 'type check',
      custom: 'custom check',
    })[category] ?? category;
  }
  return ({
    test: '테스트',
    lint: '린트',
    typecheck: '타입 검사',
    custom: '사용자 검증',
  })[category] ?? category;
}

function humanRetrospectiveCandidate(candidate, language = 'ko') {
  const observed = candidate.measurement?.observed;
  const threshold = candidate.measurement?.threshold;
  const category = candidate.measurement?.category;
  if (language === 'en') {
    switch (candidate.signal) {
      case 'slow_verification':
        return `${verificationLabel(category, language)} took ${humanDuration(observed, language)}, exceeding the configured budget of ${humanDuration(threshold, language)}.`;
      case 'performance_regression':
        return `${verificationLabel(category, language)} took ${humanDuration(observed, language)}, slower than the allowed ${humanDuration(threshold, language)}.`;
      case 'failed_run':
        return `${observed} development run(s) failed.`;
      case 'blocked_run':
        return `${observed} development run(s) were blocked.`;
      case 'verification_gap':
        return `${observed} finished run(s) have no verification evidence.`;
      case 'retry_overhead':
        return `${observed} retry attempt(s) followed a failure or verification problem.`;
      case 'explicit_correction':
        return `The user corrected the development direction ${observed} time(s).`;
      case 'repeated_process_defect':
        return `The same kind of execution problem repeated ${observed} time(s).`;
      case 'monitor_mismatch':
        return `${observed} monitor decision(s) disagree with the recorded run status.`;
      default:
        return `${candidate.signal}: ${verificationLabel(category, language)} ${observed} (review threshold ${threshold})`;
    }
  }
  switch (candidate.signal) {
    case 'slow_verification':
      return `${verificationLabel(category)}가 ${humanDuration(observed)} 걸려 설정한 예산 ${humanDuration(threshold)}를 넘었습니다.`;
    case 'performance_regression':
      return `${verificationLabel(category)}가 ${humanDuration(observed)} 걸려 허용 기준 ${humanDuration(threshold)}보다 느려졌습니다.`;
    case 'failed_run':
      return `개발 실행이 ${observed}회 실패했습니다.`;
    case 'blocked_run':
      return `개발 실행이 ${observed}회 중단되었습니다.`;
    case 'verification_gap':
      return `검증 기록 없이 완료된 실행이 ${observed}개 있습니다.`;
    case 'retry_overhead':
      return `실패나 검증 문제로 재시도가 ${observed}회 발생했습니다.`;
    case 'explicit_correction':
      return `사용자가 진행 방향을 바로잡은 기록이 ${observed}회 있습니다.`;
    case 'repeated_process_defect':
      return `같은 종류의 실행 문제가 ${observed}회 반복됐습니다.`;
    case 'monitor_mismatch':
      return `모니터 판정과 실행 종료 상태가 맞지 않은 기록이 ${observed}개 있습니다.`;
    default:
      return `${candidate.signal}: ${verificationLabel(category)} ${observed} (확인 기준 ${threshold})`;
  }
}

function humanCommandDisplay(next, language = 'ko') {
  const display = next.command?.display ?? '';
  if (next.command?.kind !== 'approval') return display;
  const commandStart = display.indexOf('p2a ');
  const command = commandStart >= 0
    ? display.slice(commandStart).replace(/\.$/u, '')
    : display;
  return command.replace(
    /<user utterance>|<user-utterance>/gu,
    language === 'ko'
      ? '<사용자가 실제로 승인한 문장>'
      : '<the user\'s actual approval statement>',
  );
}

function humanRecommendedActionEnglish(next, context = {}) {
  if (context.completion?.verificationCurrent === false) {
    return ['Run P2A next again so it can recalculate the current verification requirement.'];
  }
  if (Array.isArray(next.command?.options) && next.command.options.length) {
    const hasRetrospectiveCandidates = Boolean(next.retrospective?.candidateCount);
    return [
      hasRetrospectiveCandidates
        ? 'P2A found process signals worth reviewing, so a retrospective is recommended first. Product review and close remain available.'
        : 'Close is recommended when there is nothing else to inspect. Use an option below if you want an extra check.',
      ...next.command.options.map((option) => {
        if (option.id === 'review') return '- Code review: inspect only important or critical issues in the current change.';
        if (option.id === 'retrospective') {
          return hasRetrospectiveCandidates
            ? '- Retrospective (recommended): inspect detected delays, errors, or unnecessary process.'
            : '- Retrospective: reflect on delays, errors, or unnecessary process.';
        }
        if (option.id === 'close') {
          return hasRetrospectiveCandidates
            ? '- Close: finish the current development batch.'
            : '- Close (recommended): finish the current development batch.';
        }
        return `- ${option.label}`;
      }),
    ];
  }
  switch (next.state) {
    case 'uninitialized':
      return ['Tell P2A whether it may add its configuration to this project.'];
    case 'project_selection_required':
      return ['Name the project you want to continue.'];
    case 'entry_missing':
      return ['Describe what you want to build or change in one or two sentences.'];
    case 'entry_invalid':
      return ['Provide the corrected product document, or restate the desired change in natural language.'];
    case 'entry_deferred':
      return ['Choose whether to continue the current approved work or leave it paused. P2A will resume the saved request only after that work closes.'];
    case 'blocked_scope_replacement_ready':
      return ['Approve only if P2A should preserve the blocked history and begin a new full-scope plan from the last approved contract.'];
    case 'started_run_contract_drift':
      return ['Say whether the change was accidental or intentional. P2A will restore an accident, or close this work and prepare a new plan for an intentional change.'];
    case 'tasks_blocked':
      if (next.command?.kind === 'approval') {
        return ['Approve the bounded recovery above to continue inside the current scope. If the goal or contract must change, describe that change instead.'];
      }
      break;
    case 'iteration_complete':
      if (boundNextIterationIdea(next, context)) {
        return ['Confirm whether P2A should open the saved next request now.'];
      }
      return ['Describe the next change when you want to continue development. If there is no more work, nothing else is required.'];
    case 'flat_execution_complete':
      return ['Review the completed result. If you have no follow-up request, this development is finished.'];
    default:
      break;
  }
  if (next.command?.kind === 'approval') {
    return ['Approve if this understanding is correct, or describe what P2A should revise.'];
  }
  if (next.command?.kind === 'cli' && next.command.requiresApproval === true) {
    return ['This action needs your permission. Say whether P2A may proceed.'];
  }
  if (next.command?.kind === 'cli' || next.command?.kind === 'skill') {
    return ['Tell the agent to continue; P2A will handle this step.'];
  }
  return ['Provide the decision requested above.'];
}

function humanRecommendedAction(next, context) {
  if (humanOutputLanguage(next, context) === 'en') {
    return humanRecommendedActionEnglish(next, context);
  }
  if (context.completion?.verificationCurrent === false) {
    return ['P2A가 현재 검증 범위를 다시 계산하도록 다음 상태 확인을 다시 실행합니다.'];
  }
  if (Array.isArray(next.command?.options) && next.command.options.length) {
    const hasRetrospectiveCandidates = Boolean(next.retrospective?.candidateCount);
    return [
      hasRetrospectiveCandidates
        ? '개발 과정에서 확인할 회고 후보가 있어 회고를 먼저 살펴보는 것을 권장합니다. 제품 검토나 종료도 선택할 수 있습니다.'
        : '특이 사항이 없다면 종료를 권장합니다. 필요하면 아래 선택지로 더 확인할 수 있습니다.',
      ...next.command.options.map((option) => {
        if (option.id === 'review') return '- 코드 리뷰: 현재 변경에서 중요하거나 치명적인 문제만 확인합니다.';
        if (option.id === 'retrospective') {
          return hasRetrospectiveCandidates
            ? '- 회고(권장): 발견된 개발 과정의 지연·오류·불필요한 절차를 확인합니다.'
            : '- 회고: 개발 과정의 지연·오류·불필요한 절차를 돌아봅니다.';
        }
        if (option.id === 'close') {
          return next.retrospective?.candidateCount
            ? '- 종료: 현재 작업 묶음을 완료합니다.'
            : '- 종료(권장): 현재 작업 묶음을 완료합니다.';
        }
        return `- ${option.label}`;
      }),
    ];
  }
  switch (next.state) {
    case 'uninitialized':
      return ['P2A 구성을 이 프로젝트에 추가해도 되는지 알려주세요.'];
    case 'project_selection_required':
      return ['이번에 이어서 개발할 프로젝트 이름을 하나 알려주세요.'];
    case 'entry_missing':
      return ['만들거나 고칠 내용을 한두 문장으로 알려주세요.'];
    case 'entry_invalid':
      return ['수정한 기획 문서를 다시 지정하거나, 원하는 변경을 자연어로 알려주세요.'];
    case 'entry_deferred':
      return ['현재 승인된 개발을 계속할지, 그대로 멈춰 둘지 알려주세요. 새 요청은 현재 작업이 닫힌 뒤 이어갑니다.'];
    case 'blocked_scope_replacement_ready':
      return ['막힌 이력은 그대로 보존하고 마지막 승인 계약에서 새 전체 범위 계획을 시작해도 되는지 승인해 주세요.'];
    case 'started_run_contract_drift':
      return ['이 변경이 실수인지 의도한 계획 변경인지 알려주세요. 실수라면 복원하고, 의도한 변경이면 현재 작업을 정리한 뒤 새 계획으로 이어가겠습니다.'];
    case 'tasks_blocked':
      if (next.command?.kind === 'approval') {
        return ['현재 승인 범위 안에서 위 복구 방향으로 진행하려면 승인한다고 답해주세요. 목표나 계약을 바꿔야 한다면 변경할 내용을 알려주세요.'];
      }
      break;
    case 'iteration_complete':
      if (boundNextIterationIdea(next, context)) {
        return ['저장된 다음 요청으로 새 개발 범위를 열어도 되는지 확인해 주세요.'];
      }
      return ['다음 개발을 시작하려면 새 변경 내용을 알려주세요. 지금은 추가 작업이 없다면 그대로 두면 됩니다.'];
    case 'flat_execution_complete':
      return ['완료된 결과를 확인해주세요. 추가 요청이 없다면 이 개발은 여기서 마칩니다.'];
    default:
      break;
  }
  if (next.command?.kind === 'approval') {
    return ['위 내용이 맞으면 승인한다고 답해주세요. 다르면 수정할 내용을 알려주세요.'];
  }
  if (next.command?.kind === 'cli' && next.command.requiresApproval === true) {
    return ['이 작업은 사용자의 권한이 필요합니다. 진행해도 되는지 알려주세요.'];
  }
  if (next.command?.kind === 'cli' || next.command?.kind === 'skill') {
    return ['에이전트에게 계속 진행하라고 하면 P2A가 이 단계를 이어서 처리합니다.'];
  }
  return ['위 안내에 따라 다음 결정을 알려주세요.'];
}

export function renderNextHuman(
  next,
  context = null,
  { details = false, requestIdea = null } = {},
) {
  const resolvedContext = context ?? humanNextArtifactContext(next, { requestIdea });
  const language = humanOutputLanguage(next, resolvedContext);
  const lines = [
    'Plan2Agent',
    '',
    language === 'ko' ? '[한눈에]' : '[At a glance]',
    ...humanNextSummary(next, resolvedContext),
    '',
    language === 'ko' ? '[권장 다음 행동]' : '[Recommended next action]',
    ...humanRecommendedAction(next, resolvedContext),
  ];
  if (Array.isArray(next.retrospective?.candidates) && next.retrospective.candidates.length) {
    lines.push(language === 'ko' ? '감지된 회고 내용:' : 'Detected retrospective signals:');
    for (const candidate of next.retrospective.candidates) {
      lines.push(`  - ${humanRetrospectiveCandidate(candidate, language)}`);
    }
  }
  if (details) {
    lines.push(
      '',
      language === 'ko' ? '[내부 실행 정보]' : '[Internal execution details]',
      `- command: ${humanCommandDisplay(next, language)}`,
    );
    if (Array.isArray(next.command.options) && next.command.options.length) {
      lines.push('- options:');
      for (const option of next.command.options) lines.push(...renderNextOptionLines(option));
    }
    lines.push(`- target: ${next.target}`);
    if (next.projectId) lines.push(`- projectId: ${next.projectId}`);
    lines.push(`- state: ${next.state}`, `- reason: ${next.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

function printNext(next, options = {}) {
  process.stdout.write(renderNextHuman(next, undefined, options));
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
    console.log('Usage: p2a next [--target <dir>] [--project-id <id>] [--entry <path>|--idea <text>] [--contract v1|v2] [--json] [--details] [--trace]');
    return 0;
  }
  try {
    const entry = args.idea
      ? materializeProvisionalEntry(args.target, args.idea)
      : args.entry;
    const next = buildNext(
      args.target,
      args.projectId,
      entry,
      args.contract,
      args.trace
        ? { trace: (message) => console.error(`[p2a next] ${message}`) }
        : {},
    );
    if (args.json) console.log(JSON.stringify(next, null, 2));
    else printNext(next, { details: args.details, requestIdea: args.idea });
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
