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

function printNextOption(option) {
  console.log(`  - ${option.label} (${option.id})`);
  console.log(`    ${option.description}`);
  if (option.action?.display) console.log(`    Action: ${option.action.display}`);
  if (typeof option.action?.requiresApproval === 'boolean') {
    console.log(`    Approval required: ${option.action.requiresApproval ? 'yes' : 'no'}`);
  }
  if (option.action?.remediation?.display) {
    console.log(`    Remediation: ${option.action.remediation.display}`);
    if (typeof option.action.remediation.requiresApproval === 'boolean') {
      console.log(`    Remediation approval required: ${option.action.remediation.requiresApproval ? 'yes' : 'no'}`);
    }
  }
}

function printNext(next) {
  console.log('Plan2Agent next');
  console.log(`- target: ${next.target}`);
  if (next.projectId) console.log(`- projectId: ${next.projectId}`);
  console.log(`- state: ${next.state}`);
  console.log('Next action:');
  console.log(`  ${next.command.display}`);
  if (Array.isArray(next.command.options) && next.command.options.length) {
    console.log('Options:');
    next.command.options.forEach(printNextOption);
  }
  console.log(`Reason: ${next.reason}`);
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
