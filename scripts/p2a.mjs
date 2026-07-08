#!/usr/bin/env node
/** Top-level Plan2Agent command dispatcher for repo and scaffold project use. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_RUNS_DIR, GATE_FILES, GREENFIELD_REQUIRED_FILES } from './p2a_constants.mjs';
import { resolveOrchestrationAgentTool } from './p2a_project_config.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);

const RUNTIME_COMMANDS = new Map([
  ['iteration', { script: 'p2a_iteration.mjs' }],
  ['task', { script: 'p2a_tasks.mjs' }],
  ['tasks', { script: 'p2a_tasks.mjs' }],
  ['run', { script: 'p2a_runs.mjs' }],
  ['runs', { script: 'p2a_runs.mjs' }],
  ['execute', { script: 'p2a_execute.mjs' }],
  ['proposal', { script: 'p2a_proposals.mjs' }],
  ['proposals', { script: 'p2a_proposals.mjs' }],
  ['eval', { script: 'p2a_eval.mjs' }],
  ['memory', { script: 'p2a_memory.mjs' }],
  ['validate', { script: 'validate_artifacts.mjs' }],
]);

const TOOLKIT_COMMANDS = new Map([
  ['doctor', { script: 'p2a_doctor.mjs', forwardsCommand: false, defaultTargetWhenEmbedded: true }],
  ['scaffold', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: false }],
  ['enhance', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['update', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['upgrade', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['handoff', { script: 'p2a_handoff.mjs', forwardsCommand: false, defaultTargetWhenEmbedded: false }],
]);

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a.mjs info [--json]',
    '  node .plan2agent/scripts/p2a.mjs doctor [--dev] [--json] [--strict]',
    '  node .plan2agent/scripts/p2a.mjs update [--dry-run|--apply]',
    '  node .plan2agent/scripts/p2a.mjs upgrade (--dry-run|--apply)',
    '  node .plan2agent/scripts/p2a.mjs enhance <capability> [--dry-run] [--overwrite]',
    '  node .plan2agent/scripts/p2a.mjs eval <grade|compare|analyze|generate|digest> [options]',
    '  node .plan2agent/scripts/p2a.mjs memory <status|push|pull|search|history|digest> [options]',
    '  node .plan2agent/scripts/p2a.mjs execute <plan|start|resume|status|finish> [options]',
    '  node .plan2agent/scripts/p2a.mjs tasks|runs|iteration|proposals|validate ...',
    '',
    'Repo checkout examples:',
    '  node scripts/p2a.mjs scaffold --target <project-dir>',
    '  node scripts/p2a.mjs doctor --target <project-dir> --dev',
    '',
    'Scaffold project examples:',
    '  node .plan2agent/scripts/p2a.mjs info',
    '  node .plan2agent/scripts/p2a.mjs eval generate --artifacts .plan2agent/artifacts/<project>',
    '',
    'Notes:',
    '  update, upgrade, enhance, and doctor use the toolkit checkout recorded in .plan2agent/manifest.json when run inside a scaffold project.',
    '  --help, -h  Show this help.',
  ].join('\n');
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
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

function jsonRecords(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringArrayValue(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : [];
}

function relativeToTarget(targetRoot, filePath) {
  const relative = path.relative(targetRoot, filePath);
  if (!relative) return '.';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return normalizePath(filePath);
}

function listDirectories(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
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
  if (['update', 'upgrade', 'scaffold'].includes(command)) {
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
  return runScript(scriptPath, commandArgs);
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
  const args = P2A_PATHS.embedded && mapping.defaultTargetWhenEmbedded
    ? withDefaultToolkitTarget(command, forwardedArgs)
    : forwardedArgs;
  return runScript(scriptPath, args);
}

function hasGreenfieldGateBundle(artifactRoot) {
  return GREENFIELD_REQUIRED_FILES.every((relativePath) => isFile(path.join(artifactRoot, relativePath)));
}

function looksLikeArtifactRoot(candidate) {
  return isDirectory(candidate)
    && (
      isFile(path.join(candidate, 'current-spec.json'))
      || isDirectory(path.join(candidate, 'iterations'))
      || GATE_FILES.some(([, , relativePath]) => isFile(path.join(candidate, relativePath)))
    );
}

function discoverArtifactRoots(targetRoot) {
  const roots = new Set();
  if (looksLikeArtifactRoot(targetRoot)) roots.add(targetRoot);
  for (const parentPath of [
    path.join(targetRoot, 'artifacts'),
    path.join(targetRoot, '.plan2agent', 'artifacts'),
  ]) {
    for (const candidate of listDirectories(parentPath)) {
      if (looksLikeArtifactRoot(candidate)) roots.add(candidate);
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function firstExistingFile(candidates) {
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function countTasks(taskGraph) {
  const tasks = jsonRecords(taskGraph?.tasks);
  const doneTaskIds = new Set(
    tasks
      .filter((task) => task.status === 'done')
      .map((task) => stringValue(task.id))
      .filter(Boolean),
  );
  return tasks.reduce((counts, task) => {
    const status = stringValue(task.status);
    const dependencies = stringArrayValue(task.dependencies);
    const ready = status === 'todo' && dependencies.every((dependency) => doneTaskIds.has(dependency));
    counts.total += 1;
    counts.ready += ready ? 1 : 0;
    counts.todo += status === 'todo' ? 1 : 0;
    counts.inProgress += status === 'in_progress' ? 1 : 0;
    counts.blocked += status === 'blocked' ? 1 : 0;
    counts.done += status === 'done' ? 1 : 0;
    counts.other += ['todo', 'in_progress', 'blocked', 'done'].includes(status) ? 0 : 1;
    return counts;
  }, {
    total: 0,
    ready: 0,
    todo: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    other: 0,
  });
}

function readyTaskIds(taskGraph) {
  const tasks = jsonRecords(taskGraph?.tasks);
  const doneTaskIds = new Set(
    tasks
      .filter((task) => task.status === 'done')
      .map((task) => stringValue(task.id))
      .filter(Boolean),
  );
  return tasks
    .filter((task) => {
      const dependencies = stringArrayValue(task.dependencies);
      return task.status === 'todo' && dependencies.every((dependency) => doneTaskIds.has(dependency));
    })
    .map((task) => stringValue(task.id))
    .filter(Boolean);
}

function summarizeRuns(targetRoot, artifactRoot) {
  const runsDir = [
    path.join(artifactRoot, 'runs'),
    path.join(path.dirname(artifactRoot), 'runs'),
    path.join(targetRoot, '.plan2agent', 'runs'),
  ].find((candidate) => isDirectory(candidate) && isFile(path.join(candidate, 'run-index.json')));
  if (!runsDir) {
    return {
      runIndexPath: null,
      runCount: 0,
      latestRunId: null,
      statusCounts: {},
    };
  }
  const runIndexPath = path.join(runsDir, 'run-index.json');
  const runIndex = readJsonObject(runIndexPath);
  const runs = jsonRecords(runIndex?.runs);
  const statusCounts = runs.reduce((counts, run) => {
    const status = stringValue(run.status) ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    runIndexPath: relativeToTarget(targetRoot, runIndexPath),
    runCount: runs.length,
    latestRunId: stringValue(runs.at(-1)?.runId),
    statusCounts,
  };
}

function artifactLayout(artifactRoot, isScaffoldProject) {
  const hasCurrentSpec = isFile(path.join(artifactRoot, 'current-spec.json'));
  const hasIterations = isDirectory(path.join(artifactRoot, 'iterations'));
  const hasGreenfieldGateBundleValue = hasGreenfieldGateBundle(artifactRoot);
  const hasAnyIterationMarker = hasCurrentSpec || hasIterations;
  const requiresIterationInit = isScaffoldProject && hasGreenfieldGateBundleValue && !hasAnyIterationMarker;
  const hasIncompleteIterationLayout = isScaffoldProject && hasCurrentSpec !== hasIterations;
  return {
    kind: hasIncompleteIterationLayout
      ? 'incomplete_iteration'
      : hasCurrentSpec && hasIterations
      ? 'iteration'
      : hasGreenfieldGateBundleValue
        ? 'greenfield'
        : 'unknown',
    hasCurrentSpec,
    hasIterations,
    hasGreenfieldGateBundle: hasGreenfieldGateBundleValue,
    requiresIterationInit,
    hasIncompleteIterationLayout,
  };
}

function summarizeArtifact(targetRoot, artifactRoot, isScaffoldProject) {
  const layout = artifactLayout(artifactRoot, isScaffoldProject);
  const currentSpec = readJsonObject(path.join(artifactRoot, 'current-spec.json'));
  const activeIteration = stringValue(currentSpec?.active_iteration);
  const projectId = stringValue(currentSpec?.project_id) ?? path.basename(artifactRoot);
  const iterationRoot = activeIteration ? path.join(artifactRoot, 'iterations', activeIteration) : null;
  const searchRoots = iterationRoot && isDirectory(iterationRoot) ? [iterationRoot, artifactRoot] : [artifactRoot];
  const taskGraphPath = firstExistingFile(searchRoots.flatMap((root) => [
    path.join(root, 'gate-c-task-graph', 'task-graph.json'),
    path.join(root, 'task-graph.json'),
  ]));
  const reviewPath = firstExistingFile(searchRoots.map((root) => path.join(root, 'gate-d-review', 'review.json')));
  const taskGraph = taskGraphPath ? readJsonObject(taskGraphPath) : null;
  const review = reviewPath ? readJsonObject(reviewPath) : null;
  const readyTasks = readyTaskIds(taskGraph);
  return {
    projectId,
    artifactRoot: relativeToTarget(targetRoot, artifactRoot),
    layout,
    activeIteration,
    taskGraphPath: taskGraphPath ? relativeToTarget(targetRoot, taskGraphPath) : null,
    taskCounts: countTasks(taskGraph),
    readyTaskIds: readyTasks,
    review: {
      path: reviewPath ? relativeToTarget(targetRoot, reviewPath) : null,
      blockingIssues: jsonRecords(review?.blocking_issues).length,
    },
    runs: summarizeRuns(targetRoot, artifactRoot),
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function capabilityState(manifest, config, key) {
  const manifestRecord = objectValue(objectValue(manifest?.enhancements)[key]);
  const configRecord = objectValue(config?.[key]);
  const manifestEnabled = manifestRecord.enabled === true;
  const configEnabled = configRecord.enabled === true;
  return {
    manifestRecord,
    configRecord,
    manifestPresent: Object.keys(manifestRecord).length > 0,
    configPresent: Object.keys(configRecord).length > 0,
    manifestEnabled,
    configEnabled,
    enabled: manifestEnabled || configEnabled,
    inSync: manifestEnabled === configEnabled,
  };
}

function summarizeMemoryEnhancement(manifest, config) {
  const state = capabilityState(manifest, config, 'memory');
  const configMemory = state.configRecord;
  const manifestMemory = state.manifestRecord;
  if (!state.enabled) {
    return {
      enabled: false,
      manifestPresent: state.manifestPresent,
      configPresent: state.configPresent,
      manifestEnabled: state.manifestEnabled,
      configEnabled: state.configEnabled,
      inSync: state.inSync,
    };
  }
  const serverUrlEnv = stringValue(configMemory.serverUrlEnv) ?? 'P2A_MEMORY_URL';
  const tokenEnv = stringValue(configMemory.tokenEnv) ?? 'P2A_MEMORY_TOKEN';
  return {
    enabled: true,
    mode: stringValue(manifestMemory.mode) ?? stringValue(configMemory.mode) ?? 'manual_sync',
    manifestPresent: state.manifestPresent,
    configPresent: state.configPresent,
    manifestEnabled: state.manifestEnabled,
    configEnabled: state.configEnabled,
    inSync: state.inSync,
    serverUrlEnv,
    serverConfigured: Boolean(process.env[serverUrlEnv] || stringValue(configMemory.serverUrl)),
    tokenEnv,
    tokenConfigured: Boolean(process.env[tokenEnv] || stringValue(configMemory.token)),
    statusPolicy: stringValue(configMemory.statusPolicy) ?? 'local_first',
    pushPolicy: stringValue(configMemory.pushPolicy) ?? 'explicit_approval',
  };
}

function resolveProjectRelativePath(targetRoot, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.join(targetRoot, filePath);
}

function countJsonFiles(dirPath) {
  if (!isDirectory(dirPath)) return 0;
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .length;
}

function summarizeProposalsEnhancement(targetRoot, manifest, config) {
  const state = capabilityState(manifest, config, 'proposals');
  const configProposals = state.configRecord;
  const manifestProposals = state.manifestRecord;
  if (!state.enabled) {
    return {
      enabled: false,
      manifestPresent: state.manifestPresent,
      configPresent: state.configPresent,
      manifestEnabled: state.manifestEnabled,
      configEnabled: state.configEnabled,
      inSync: state.inSync,
    };
  }
  const queueDir = stringValue(configProposals.queueDir) ?? '.plan2agent/proposals';
  const queuePath = resolveProjectRelativePath(targetRoot, queueDir);
  return {
    enabled: true,
    mode: stringValue(manifestProposals.mode) ?? stringValue(configProposals.reviewPolicy) ?? 'manual_curate',
    manifestPresent: state.manifestPresent,
    configPresent: state.configPresent,
    manifestEnabled: state.manifestEnabled,
    configEnabled: state.configEnabled,
    inSync: state.inSync,
    queueDir,
    queueExists: isDirectory(queuePath),
    queueJsonFiles: countJsonFiles(queuePath),
    mineOn: stringArrayValue(configProposals.mineOn),
    reviewPolicy: stringValue(configProposals.reviewPolicy) ?? 'manual_curate',
    patchPolicy: stringValue(configProposals.patchPolicy) ?? 'draft_only',
    approvalRequired: configProposals.approvalRequired !== false,
  };
}

function summarizeOrchestrationEnhancement(manifest, config) {
  const state = capabilityState(manifest, config, 'orchestration');
  const configOrchestration = state.configRecord;
  const manifestOrchestration = state.manifestRecord;
  if (!state.enabled) {
    return {
      enabled: false,
      manifestPresent: state.manifestPresent,
      configPresent: state.configPresent,
      manifestEnabled: state.manifestEnabled,
      configEnabled: state.configEnabled,
      inSync: state.inSync,
    };
  }
  return {
    enabled: true,
    mode: stringValue(manifestOrchestration.mode) ?? stringValue(configOrchestration.defaultMode) ?? 'solo',
    manifestPresent: state.manifestPresent,
    configPresent: state.configPresent,
    manifestEnabled: state.manifestEnabled,
    configEnabled: state.configEnabled,
    inSync: state.inSync,
    defaultMode: stringValue(configOrchestration.defaultMode) ?? 'solo',
    supervisedRun: configOrchestration.supervisedRun === true,
    providerRouting: stringValue(configOrchestration.providerRouting) ?? 'project_config',
    monitorGatePolicy: stringValue(configOrchestration.monitorGatePolicy) ?? 'explicit_plan_only',
    runtimeDir: stringValue(configOrchestration.runtimeDir) ?? DEFAULT_RUNS_DIR,
  };
}

function summarizeEnhancements(targetRoot, manifest, config) {
  const keys = ['devSkills', 'memory', 'gui', 'orchestration', 'proposals'];
  const enabled = keys.filter((key) => capabilityState(manifest, config, key).enabled);
  return {
    enabled,
    memory: summarizeMemoryEnhancement(manifest, config),
    orchestration: summarizeOrchestrationEnhancement(manifest, config),
    proposals: summarizeProposalsEnhancement(targetRoot, manifest, config),
  };
}

function parseInfoArgs(argv) {
  const args = {
    target: P2A_PATHS.embedded ? P2A_PATHS.projectRoot : process.cwd(),
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else {
      throw new Error(`unknown info option: ${arg}`);
    }
  }
  return args;
}

function buildInfo(targetRootInput) {
  const targetRoot = path.resolve(targetRootInput);
  if (!isDirectory(targetRoot)) {
    throw new Error(`--target must be an existing directory: ${targetRoot}`);
  }
  const manifest = readManifest(targetRoot);
  const config = readJsonObject(path.join(targetRoot, '.plan2agent', 'project.config.json'));
  const isScaffoldProject = manifest?.provenance?.mode === 'scaffold';
  const artifacts = discoverArtifactRoots(targetRoot)
    .map((artifactRoot) => summarizeArtifact(targetRoot, artifactRoot, isScaffoldProject));
  const hasP2aDir = isDirectory(path.join(targetRoot, '.plan2agent'));
  const enhancements = summarizeEnhancements(targetRoot, manifest, config);
  const mode = manifest?.provenance?.mode
    ?? (hasP2aDir ? 'installed' : P2A_PATHS.embedded ? 'embedded' : 'toolkit_or_uninstalled');
  const nextActions = [];
  if (!hasP2aDir) {
    nextActions.push('Install a project harness: node scripts/p2a.mjs scaffold --target <project-dir>');
  }
  for (const artifact of artifacts) {
    if (artifact.layout.hasIncompleteIterationLayout) {
      nextActions.push(`Repair incomplete iteration layout before task execution: ${artifact.artifactRoot}`);
    } else if (artifact.layout.requiresIterationInit) {
      nextActions.push(`Initialize iteration layout: node .plan2agent/scripts/p2a.mjs iteration init --artifacts ${artifact.artifactRoot} --iteration-id v1-mvp`);
    } else if (artifact.readyTaskIds.length) {
      nextActions.push(`Plan the next ready task: node .plan2agent/scripts/p2a.mjs execute plan --artifacts ${artifact.artifactRoot} --task ${artifact.readyTaskIds[0]}`);
    } else if (artifact.taskCounts.total > 0 && artifact.taskCounts.done === artifact.taskCounts.total) {
      nextActions.push(`Validate close readiness: node .plan2agent/scripts/p2a.mjs iteration validate --artifacts ${artifact.artifactRoot} --require-close-ready`);
    }
  }
  if (enhancements.memory.enabled) {
    if (!enhancements.memory.inSync) {
      nextActions.push('Repair Memory capability manifest/config drift: node .plan2agent/scripts/p2a.mjs enhance memory');
    } else if (artifacts.length) {
      nextActions.push(`Check Memory sync: node .plan2agent/scripts/p2a.mjs memory status --artifacts ${artifacts[0].artifactRoot}`);
      nextActions.push(`Preview Memory pull: node .plan2agent/scripts/p2a.mjs memory pull --artifacts ${artifacts[0].artifactRoot} --dry-run`);
      nextActions.push(`Search Memory history: node .plan2agent/scripts/p2a.mjs memory search --artifacts ${artifacts[0].artifactRoot} --query <term>`);
      nextActions.push(`Show Memory timeline: node .plan2agent/scripts/p2a.mjs memory history --artifacts ${artifacts[0].artifactRoot}`);
      nextActions.push(`Digest Memory maintenance candidates: node .plan2agent/scripts/p2a.mjs memory digest --artifacts ${artifacts[0].artifactRoot}`);
    }
  }
  if (enhancements.proposals.enabled) {
    if (!enhancements.proposals.inSync) {
      nextActions.push('Repair proposal capability manifest/config drift: node .plan2agent/scripts/p2a.mjs enhance proposals');
    } else {
      if (artifacts.length) {
        nextActions.push(`Mine proposal candidates: node .plan2agent/scripts/p2a.mjs proposals mine --artifacts ${artifacts[0].artifactRoot} --dry-run`);
      }
      nextActions.push(`Review proposal queue: node .plan2agent/scripts/p2a.mjs proposals digest --proposals ${enhancements.proposals.queueDir}`);
      nextActions.push(`Preview proposal curation review: node .plan2agent/scripts/p2a.mjs proposals review --proposals ${enhancements.proposals.queueDir} --dry-run`);
    }
  }
  if (enhancements.orchestration.enabled) {
    if (!enhancements.orchestration.inSync) {
      nextActions.push('Repair orchestration capability manifest/config drift: node .plan2agent/scripts/p2a.mjs enhance orchestration');
    } else {
      const orchestrationAgentTool = resolveOrchestrationAgentTool(config, manifest);
      if (artifacts.length) {
        nextActions.push(`Start run with monitor gate: node .plan2agent/scripts/p2a.mjs execute start --artifacts ${artifacts[0].artifactRoot} --task <task-id> --agent-tool ${orchestrationAgentTool} --require-monitor`);
        nextActions.push(`Start supervised run with monitor gate: node .plan2agent/scripts/p2a.mjs execute start --artifacts ${artifacts[0].artifactRoot} --task <task-id> --agent-tool ${orchestrationAgentTool} --require-monitor`);
      }
    }
  }
  if (!nextActions.length) nextActions.push('No immediate P2A action detected from local files.');
  return {
    schema_version: 'p2a.info.v1',
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    surface: P2A_PATHS.embedded ? 'project_runtime' : 'toolkit_checkout',
    mode,
    toolkitRoot: P2A_PATHS.embedded
      ? stringValue(manifest?.provenance?.toolkitRoot)
      : P2A_PATHS.toolRoot,
    config: config ? {
      packageManager: config.packageManager ?? null,
      testCommand: config.testCommand ?? null,
      lintCommand: config.lintCommand ?? null,
      typecheckCommand: config.typecheckCommand ?? null,
    } : null,
    enhancements,
    artifactCount: artifacts.length,
    artifacts,
    nextActions,
  };
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
  if (info.config) {
    console.log(`- verification: test=${info.config.testCommand ?? 'none'} lint=${info.config.lintCommand ?? 'none'} typecheck=${info.config.typecheckCommand ?? 'none'}`);
  }
  if (info.enhancements?.enabled?.length) {
    console.log(`- enhancements: ${info.enhancements.enabled.join(', ')}`);
  }
  if (info.enhancements?.memory?.enabled) {
    const memory = info.enhancements.memory;
    console.log(`- memory: mode=${memory.mode} sync=${memory.inSync ? 'ok' : 'drift'} serverEnv=${memory.serverUrlEnv} serverConfigured=${memory.serverConfigured ? 'yes' : 'no'} pushPolicy=${memory.pushPolicy}`);
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
    if (artifact.review.blockingIssues) console.log(`    review blockers: ${artifact.review.blockingIssues}`);
  }
  console.log('Next actions:');
  for (const action of info.nextActions) console.log(`- ${action}`);
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
    console.log('Usage: node .plan2agent/scripts/p2a.mjs info [--target <dir>] [--json]');
    return 0;
  }
  try {
    const info = buildInfo(args.target);
    if (args.json) console.log(JSON.stringify(info, null, 2));
    else printInfo(info);
    return 0;
  } catch (error) {
    console.error(`p2a info error: ${error.message}`);
    return 1;
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, ...commandArgs] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    return 0;
  }
  if (command === 'info' || command === 'status') return runInfo(commandArgs);
  if (RUNTIME_COMMANDS.has(command)) return dispatchRuntime(command, commandArgs);
  if (TOOLKIT_COMMANDS.has(command)) return dispatchToolkit(command, commandArgs);
  console.error(`p2a error: unknown command "${command}"`);
  console.error('Run with --help for usage.');
  return 1;
}

process.exitCode = main();
