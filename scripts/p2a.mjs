#!/usr/bin/env node
/** Top-level Plan2Agent command dispatcher for the npm package and legacy projects. */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MEMORY_REQUEST_TIMEOUT_MS, DEFAULT_RUNS_DIR, GATE_FILES, GREENFIELD_REQUIRED_FILES } from './p2a_constants.mjs';
import { resolveOrchestrationAgentTool } from './p2a_project_config.mjs';
import { normalizePath, resolveP2aPaths } from './p2a_paths.mjs';
import { p2aCommandLine } from './p2a_run_commands.mjs';

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
  ['init', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['scaffold', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['enhance', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['update', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['upgrade', { script: 'p2a_handoff.mjs', forwardsCommand: true, defaultTargetWhenEmbedded: true }],
  ['handoff', { script: 'p2a_handoff.mjs', forwardsCommand: false, defaultTargetWhenEmbedded: false }],
]);

function usage() {
  return [
    'Usage:',
    '  p2a init [--target <dir>] [--tools <list>] [--codex-profile quality|inherit]',
    '  p2a next [--target <dir>] [--project-id <id>] [--json]',
    '  p2a info [--target <dir>] [--json]',
    '  p2a doctor [--target <dir>] [--dev] [--json] [--strict]',
    '  p2a update [--target <dir>] [--dry-run|--apply]',
    '  p2a upgrade [--target <dir>] (--dry-run|--apply)',
    '  p2a enhance <capability> [--target <dir>] [--dry-run] [--overwrite]',
    '  p2a eval <grade|compare|analyze|generate|digest> [options]',
    '  p2a memory <status|push|pull|search|history|digest|trace|impact|precedent> [options]',
    '  p2a execute <plan|start|resume|status|finish> [options]',
    '  p2a tasks|runs|iteration|proposals|validate ...',
    '',
    'Examples:',
    '  p2a init --target <project-dir>',
    '  p2a doctor --target <project-dir> --dev',
    '  p2a eval generate --artifacts .plan2agent/artifacts/<project>',
    '',
    'Notes:',
    '  Install Plan2Agent globally before using p2a. New projects keep only project state and provider assets in .plan2agent/.',
    '  --help, -h  Show this help.',
  ].join('\n');
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
  const args = mapping.defaultTargetWhenEmbedded
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

function inspectRuns(targetRoot, artifactRoot) {
  const runsDir = [
    path.join(artifactRoot, 'runs'),
    path.join(path.dirname(artifactRoot), 'runs'),
    path.join(targetRoot, '.plan2agent', 'runs'),
  ].find((candidate) => isDirectory(candidate) && isFile(path.join(candidate, 'run-index.json')));
  if (!runsDir) {
    return {
      records: [],
      summary: {
        runIndexPath: null,
        runCount: 0,
        latestRunId: null,
        statusCounts: {},
      },
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
    records: runs,
    summary: {
      runIndexPath: relativeToTarget(targetRoot, runIndexPath),
      runCount: runs.length,
      latestRunId: stringValue(runs.at(-1)?.runId),
      statusCounts,
    },
  };
}

function summarizeRuns(targetRoot, artifactRoot) {
  return inspectRuns(targetRoot, artifactRoot).summary;
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

function artifactSearchRoots(artifactRoot, activeIteration) {
  const iterationRoot = activeIteration ? path.join(artifactRoot, 'iterations', activeIteration) : null;
  return iterationRoot && isDirectory(iterationRoot) ? [iterationRoot, artifactRoot] : [artifactRoot];
}

function firstGateFile(searchRoots, gateDirectory, filename) {
  return firstExistingFile(searchRoots.map((root) => path.join(root, gateDirectory, filename)));
}

function inspectArtifact(targetRoot, artifactRoot, isScaffoldProject) {
  const layout = artifactLayout(artifactRoot, isScaffoldProject);
  const currentSpec = readJsonObject(path.join(artifactRoot, 'current-spec.json'));
  const activeIteration = stringValue(currentSpec?.active_iteration);
  const projectId = stringValue(currentSpec?.project_id) ?? path.basename(artifactRoot);
  const searchRoots = artifactSearchRoots(artifactRoot, activeIteration);
  const intakePath = firstGateFile(searchRoots, 'gate-a-intake', 'intake.json');
  const specPath = firstGateFile(searchRoots, 'gate-b-spec', 'spec.json');
  const taskGraphPath = firstExistingFile(searchRoots.flatMap((root) => [
    path.join(root, 'gate-c-task-graph', 'task-graph.json'),
    path.join(root, 'task-graph.json'),
  ]));
  const reviewPath = firstGateFile(searchRoots, 'gate-d-review', 'review.json');
  const intake = intakePath ? readJsonObject(intakePath) : null;
  const spec = specPath ? readJsonObject(specPath) : null;
  const taskGraph = taskGraphPath ? readJsonObject(taskGraphPath) : null;
  const review = reviewPath ? readJsonObject(reviewPath) : null;
  const runs = inspectRuns(targetRoot, artifactRoot);
  const tasks = jsonRecords(taskGraph?.tasks);
  return {
    projectId,
    artifactRoot,
    layout,
    activeIteration,
    currentSpec,
    gates: {
      intakePath,
      intake,
      specPath,
      spec,
      taskGraphPath,
      taskGraph,
      reviewPath,
      review,
    },
    tasks,
    runs,
  };
}

function summarizeArtifact(targetRoot, inspected) {
  const { gates } = inspected;
  const readyTasks = readyTaskIds(gates.taskGraph);
  return {
    projectId: inspected.projectId,
    artifactRoot: relativeToTarget(targetRoot, inspected.artifactRoot),
    layout: inspected.layout,
    activeIteration: inspected.activeIteration,
    taskGraphPath: gates.taskGraphPath ? relativeToTarget(targetRoot, gates.taskGraphPath) : null,
    taskCounts: countTasks(gates.taskGraph),
    readyTaskIds: readyTasks,
    review: {
      path: gates.reviewPath ? relativeToTarget(targetRoot, gates.reviewPath) : null,
      blockingIssues: jsonRecords(gates.review?.blocking_issues).length,
    },
    runs: inspected.runs.summary,
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
    requestTimeoutMs: Number.isInteger(configMemory.requestTimeoutMs) && configMemory.requestTimeoutMs > 0
      ? configMemory.requestTimeoutMs
      : DEFAULT_MEMORY_REQUEST_TIMEOUT_MS,
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
  const keys = ['devSkills', 'memory', 'orchestration', 'proposals'];
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
    target: P2A_PATHS.projectRoot,
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

function parseNextArgs(argv) {
  const args = {
    target: P2A_PATHS.projectRoot,
    projectId: null,
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
    } else if (arg === '--project-id') {
      args.projectId = argv[++index];
      if (!args.projectId) throw new Error('--project-id requires a project id');
    } else {
      throw new Error(`unknown next option: ${arg}`);
    }
  }
  return args;
}

function commandTarget(targetRoot) {
  return path.resolve(process.cwd()) === targetRoot ? '.' : targetRoot;
}

function commandArtifact(targetRoot, artifactRoot) {
  return path.resolve(process.cwd()) === targetRoot
    ? relativeToTarget(targetRoot, artifactRoot)
    : artifactRoot;
}

function commandProjectPath(targetRoot, filePath) {
  return path.resolve(process.cwd()) === targetRoot
    ? relativeToTarget(targetRoot, filePath)
    : filePath;
}

function minedProposalRunIds(targetRoot, proposals) {
  const queuePath = resolveProjectRelativePath(targetRoot, proposals.queueDir);
  if (!isDirectory(queuePath)) return new Set();
  const runIds = new Set();
  for (const entry of readdirSync(queuePath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sourceRunId = stringValue(readJsonObject(path.join(queuePath, entry.name))?.sourceRunId);
    if (sourceRunId) runIds.add(sourceRunId);
  }
  return runIds;
}

function cliNextAction(state, reason, argv) {
  return {
    state,
    reason,
    command: {
      kind: 'cli',
      argv,
      display: p2aCommandLine(P2A_PATHS, argv),
    },
  };
}

function skillNextAction(state, reason, display) {
  return {
    state,
    reason,
    command: {
      kind: 'skill',
      display,
    },
  };
}

function approvalNextAction(state, reason, display) {
  return {
    state,
    reason,
    command: {
      kind: 'approval',
      display,
    },
  };
}

function taskIdsWithStatus(tasks, status) {
  return tasks
    .filter((task) => task.status === status)
    .map((task) => stringValue(task.id))
    .filter(Boolean);
}

function isClosedIteration(currentSpec, activeIteration) {
  if (!activeIteration) return false;
  const closed = [
    currentSpec?.last_closed_iteration,
    ...jsonRecords(currentSpec?.closed_iterations),
  ];
  return closed.some((record) => (
    record?.iteration_id === activeIteration && record?.status === 'archived'
  ));
}

function runsForActiveIteration(records, activeIteration) {
  return records.filter((run) => {
    const iterationId = stringValue(run.iterationId);
    return activeIteration ? iterationId === activeIteration : !iterationId;
  });
}

function inspectionForArtifact(targetRoot, artifact, inspectedArtifacts) {
  const artifactRoot = path.resolve(targetRoot, artifact.artifactRoot);
  return inspectedArtifacts.find((candidate) => candidate.artifactRoot === artifactRoot) ?? null;
}

function selectNextArtifact(info, targetRoot, requestedProjectId, inspectedArtifacts) {
  const artifacts = info.artifacts;
  if (requestedProjectId) {
    const matches = artifacts.filter((artifact) => artifact.projectId === requestedProjectId);
    if (!matches.length) throw new Error(`no artifact found for --project-id ${JSON.stringify(requestedProjectId)}`);
    if (matches.length > 1) throw new Error(`multiple artifacts use project id ${JSON.stringify(requestedProjectId)}`);
    return { artifact: matches[0] };
  }
  if (artifacts.length === 1) return { artifact: artifacts[0] };
  const active = artifacts.filter((artifact) => {
    const inspected = inspectionForArtifact(targetRoot, artifact, inspectedArtifacts);
    return inspected && artifact.activeIteration && !isClosedIteration(
      inspected.currentSpec,
      artifact.activeIteration,
    );
  });
  if (active.length === 1) return { artifact: active[0] };
  const projectIds = artifacts.map((artifact) => artifact.projectId).sort();
  return {
    selection: cliNextAction(
      'project_selection_required',
      `Multiple artifact roots are available (${projectIds.join(', ')}). Select one project explicitly.`,
      ['next', '--project-id', '<project-id>'],
    ),
  };
}

function buildNextDecisionContext(info, targetRoot, requestedProjectId, inspectedArtifacts) {
  const hasHarness = isDirectory(path.join(targetRoot, '.plan2agent'));
  const context = { info, targetRoot, hasHarness };
  if (!hasHarness || !info.artifacts.length) return context;

  const selected = selectNextArtifact(info, targetRoot, requestedProjectId, inspectedArtifacts);
  if (selected.selection) return { ...context, selection: selected.selection };

  const artifactRoot = path.resolve(targetRoot, selected.artifact.artifactRoot);
  const detail = inspectionForArtifact(targetRoot, selected.artifact, inspectedArtifacts);
  if (!detail) throw new Error(`artifact inspection is unavailable: ${artifactRoot}`);
  const { gates } = detail;
  const activeRuns = runsForActiveIteration(detail.runs.records, detail.activeIteration);
  const taskCounts = countTasks(gates.taskGraph);
  const proposals = info.enhancements.proposals;
  const minedRunIds = proposals.enabled ? minedProposalRunIds(targetRoot, proposals) : new Set();
  const unminedFailedOrBlockedRun = activeRuns.find((run) => {
    const runId = stringValue(run.runId);
    return Boolean(runId)
      && ['failed', 'blocked'].includes(run.status)
      && !minedRunIds.has(runId);
  });
  return {
    ...context,
    artifactRoot,
    artifactArg: commandArtifact(targetRoot, artifactRoot),
    projectId: detail.projectId,
    detail,
    gates,
    gateAExists: Boolean(gates.intakePath),
    gateBExists: Boolean(gates.specPath),
    gateCExists: Boolean(gates.taskGraphPath),
    gateDExists: Boolean(gates.reviewPath),
    reviewBlockingIssues: jsonRecords(gates.review?.blocking_issues).length,
    activeRuns,
    startedRun: activeRuns.find((run) => run.status === 'started' && stringValue(run.runId)),
    readyIds: readyTaskIds(gates.taskGraph),
    blockedTaskIds: taskIdsWithStatus(detail.tasks, 'blocked'),
    allTasksDone: taskCounts.total > 0 && taskCounts.done === taskCounts.total,
    closedIteration: isClosedIteration(detail.currentSpec, detail.activeIteration),
    proposalQueueArg: proposals.enabled
      ? commandProjectPath(targetRoot, resolveProjectRelativePath(targetRoot, proposals.queueDir))
      : null,
    unminedFailedOrBlockedRun,
  };
}

export const NEXT_DECISION_RULES = [
  {
    state: 'uninitialized',
    kind: 'cli',
    when: (context) => !context.hasHarness,
    reason: () => 'This project has no .plan2agent directory.',
    command: (context) => ['init', '--target', commandTarget(context.targetRoot)],
  },
  {
    state: 'initialized_without_artifacts',
    kind: 'skill',
    when: (context) => context.hasHarness && !context.info.artifacts.length,
    reason: () => 'The harness is installed, but no planning artifact root exists yet.',
    command: () => '/p2a-harness "<one-sentence idea>"',
  },
  {
    state: 'incomplete_iteration_layout',
    kind: 'cli',
    when: (context) => context.detail.layout.hasIncompleteIterationLayout,
    reason: () => 'current-spec.json and iterations/ do not form a complete iteration layout.',
    command: (context) => ['iteration', 'validate', '--artifacts', context.artifactArg],
  },
  {
    state: (context) => (context.gates.intake?.status === 'ready_for_spec'
      ? 'gate_a_ready_for_spec'
      : 'gate_a_needs_approval'),
    kind: (context) => (context.gates.intake?.status === 'ready_for_spec' ? 'skill' : 'approval'),
    when: (context) => context.gateAExists && !context.gateBExists,
    reason: (context) => (context.gates.intake?.status === 'ready_for_spec'
      ? 'Gate A intake has no remaining user decisions and is ready for specification.'
      : 'Gate A intake still needs a human decision or approval before a specification can be written.'),
    command: (context) => (context.gates.intake?.status === 'ready_for_spec'
      ? '/p2a-spec'
      : `Review and approve ${path.join(context.artifactArg, 'gate-a-intake', 'intake.json')}.`),
  },
  {
    state: 'gate_b_needs_approval',
    kind: 'approval',
    when: (context) => context.gateBExists && context.gates.spec?.approval !== 'approved',
    reason: () => 'The Gate B specification is still a draft.',
    command: (context) => `Review ${path.join(context.artifactArg, 'gate-b-spec', 'spec.json')}, approve it, and record approval_audit.`,
  },
  {
    state: 'gate_b_approved_needs_tasks',
    kind: 'skill',
    when: (context) => context.gateBExists && context.gates.spec?.approval === 'approved' && !context.gateCExists,
    reason: () => 'The approved Gate B specification has no Gate C task graph yet.',
    command: () => '/p2a-task-breakdown',
  },
  {
    state: (context) => (context.gateDExists ? 'gate_d_blocked' : 'gate_c_needs_review'),
    kind: (context) => (context.gateDExists ? 'approval' : 'skill'),
    when: (context) => context.gateCExists && (!context.gateDExists || context.reviewBlockingIssues > 0),
    reason: (context) => (context.gateDExists
      ? `Gate D review has ${context.reviewBlockingIssues} blocking issue(s).`
      : 'The Gate C task graph exists but has not passed Gate D review.'),
    command: (context) => (context.gateDExists
      ? `Resolve the blockers in ${path.join(context.artifactArg, 'gate-d-review', 'review.json')}, then run ${p2aCommandLine(P2A_PATHS, ['next'])} again.`
      : '/p2a-review'),
  },
  {
    state: 'gate_d_passed_needs_iteration_init',
    kind: 'cli',
    when: (context) => context.gateDExists && context.detail.layout.requiresIterationInit,
    reason: () => 'Gate D passed with no blocking issues, but the iteration layout has not been initialized.',
    command: (context) => ['iteration', 'init', '--artifacts', context.artifactArg],
  },
  {
    state: 'run_started',
    kind: 'cli',
    when: (context) => Boolean(context.startedRun),
    reason: (context) => `Run ${context.startedRun.runId} is still open and should be resumed before starting new work.`,
    command: (context) => ['execute', 'resume', '--artifacts', context.artifactArg, '--run-id', context.startedRun.runId],
  },
  {
    state: 'ready_task_available',
    kind: 'cli',
    when: (context) => context.readyIds.length > 0,
    reason: (context) => `Task ${context.readyIds[0]} is ready to plan for supervised execution.`,
    command: (context) => ['execute', 'plan', '--artifacts', context.artifactArg, '--task', context.readyIds[0]],
  },
  {
    state: 'tasks_blocked',
    kind: 'cli',
    when: (context) => context.blockedTaskIds.length > 0 && !context.readyIds.length,
    reason: (context) => `No task is ready and task ${context.blockedTaskIds[0]} is blocked.`,
    command: (context) => ['tasks', 'show', '--artifacts', context.artifactArg, context.blockedTaskIds[0]],
  },
  {
    state: 'iteration_ready_to_close',
    kind: 'cli',
    when: (context) => context.allTasksDone && !context.closedIteration,
    reason: () => 'Every task in the active iteration is done and the iteration is still open.',
    command: (context) => ['iteration', 'close', '--artifacts', context.artifactArg],
  },
  {
    state: 'run_evidence_needs_proposal_mining',
    kind: 'cli',
    when: (context) => Boolean(context.unminedFailedOrBlockedRun),
    reason: (context) => `Run ${context.unminedFailedOrBlockedRun.runId} has not been mined for proposals yet.`,
    command: (context) => [
      'proposals',
      'mine',
      '--artifacts',
      context.artifactArg,
      '--run-id',
      context.unminedFailedOrBlockedRun.runId,
      '--proposals',
      context.proposalQueueArg,
    ],
  },
  {
    state: 'iteration_complete',
    kind: 'cli',
    when: (context) => context.allTasksDone && context.closedIteration,
    reason: () => 'The active iteration is closed; start the next iteration when a new change idea is ready.',
    command: (context) => ['iteration', 'open', '--artifacts', context.artifactArg, '--iteration-id', '<id>', '--idea', '<change idea>'],
  },
];

function resolveNextRuleValue(value, context) {
  return typeof value === 'function' ? value(context) : value;
}

function actionForNextRule(rule, context) {
  const state = resolveNextRuleValue(rule.state, context);
  const kind = resolveNextRuleValue(rule.kind, context);
  const reason = rule.reason(context);
  const command = rule.command(context);
  if (kind === 'cli') return cliNextAction(state, reason, command);
  if (kind === 'skill') return skillNextAction(state, reason, command);
  return approvalNextAction(state, reason, command);
}

function decideNextAction(context) {
  if (context.selection) return context.selection;
  const rule = NEXT_DECISION_RULES.find((candidate) => candidate.when(context));
  if (rule) return actionForNextRule(rule, context);
  return cliNextAction(
    'state_needs_inspection',
    'The current artifact combination does not match a safe automatic next-action rule.',
    ['info'],
  );
}

function buildNext(targetRootInput, requestedProjectId) {
  const snapshot = buildInfoSnapshot(targetRootInput);
  const { info } = snapshot;
  const targetRoot = info.target;
  const context = buildNextDecisionContext(info, targetRoot, requestedProjectId, snapshot.inspectedArtifacts);
  const action = decideNextAction(context);
  return {
    schema_version: 'p2a.next.v1',
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    projectId: context.projectId ?? null,
    ...action,
  };
}

function buildInfoSnapshot(targetRootInput) {
  const targetRoot = path.resolve(targetRootInput);
  if (!isDirectory(targetRoot)) {
    throw new Error(`--target must be an existing directory: ${targetRoot}`);
  }
  const manifest = readManifest(targetRoot);
  const config = readJsonObject(path.join(targetRoot, '.plan2agent', 'project.config.json'));
  const isScaffoldProject = ['init', 'scaffold'].includes(manifest?.provenance?.mode);
  const inspectedArtifacts = discoverArtifactRoots(targetRoot)
    .map((artifactRoot) => inspectArtifact(targetRoot, artifactRoot, isScaffoldProject));
  const artifacts = inspectedArtifacts
    .map((inspected) => summarizeArtifact(targetRoot, inspected));
  const hasP2aDir = isDirectory(path.join(targetRoot, '.plan2agent'));
  const enhancements = summarizeEnhancements(targetRoot, manifest, config);
  const mode = manifest?.provenance?.mode
    ?? (hasP2aDir ? 'installed' : P2A_PATHS.embedded ? 'embedded' : 'toolkit_or_uninstalled');
  const p2aCommand = (args) => p2aCommandLine(P2A_PATHS, args);
  const nextActions = [];
  if (!hasP2aDir) {
    nextActions.push(`Install a project harness: ${p2aCommand(['init', '--target', '<project-dir>'])}`);
  }
  for (const artifact of artifacts) {
    if (artifact.layout.hasIncompleteIterationLayout) {
      nextActions.push(`Repair incomplete iteration layout before task execution: ${artifact.artifactRoot}`);
    } else if (artifact.layout.requiresIterationInit) {
      nextActions.push(`Initialize iteration layout: ${p2aCommand(['iteration', 'init', '--artifacts', artifact.artifactRoot, '--iteration-id', 'v1-mvp'])}`);
    } else if (artifact.readyTaskIds.length) {
      nextActions.push(`Plan the next ready task: ${p2aCommand(['execute', 'plan', '--artifacts', artifact.artifactRoot, '--task', artifact.readyTaskIds[0]])}`);
    } else if (artifact.taskCounts.total > 0 && artifact.taskCounts.done === artifact.taskCounts.total) {
      nextActions.push(`Validate close readiness: ${p2aCommand(['iteration', 'validate', '--artifacts', artifact.artifactRoot, '--require-close-ready'])}`);
    }
  }
  if (enhancements.memory.enabled) {
    if (!enhancements.memory.inSync) {
      nextActions.push(`Repair Memory capability manifest/config drift: ${p2aCommand(['enhance', 'memory'])}`);
    } else if (artifacts.length) {
      nextActions.push(`Check Memory sync: ${p2aCommand(['memory', 'status', '--artifacts', artifacts[0].artifactRoot])}`);
      nextActions.push(`Preview Memory pull: ${p2aCommand(['memory', 'pull', '--artifacts', artifacts[0].artifactRoot, '--dry-run'])}`);
      nextActions.push(`Search project Memory history: ${p2aCommand(['memory', 'search', '--project', artifacts[0].projectId, '--mode', 'hybrid', '--query', '<term>'])}`);
      nextActions.push(`Show Memory timeline: ${p2aCommand(['memory', 'history', '--artifacts', artifacts[0].artifactRoot])}`);
      nextActions.push(`Digest Memory maintenance candidates: ${p2aCommand(['memory', 'digest', '--artifacts', artifacts[0].artifactRoot])}`);
    }
  }
  if (enhancements.proposals.enabled) {
    if (!enhancements.proposals.inSync) {
      nextActions.push(`Repair proposal capability manifest/config drift: ${p2aCommand(['enhance', 'proposals'])}`);
    } else {
      if (artifacts.length) {
        nextActions.push(`Mine proposal candidates: ${p2aCommand(['proposals', 'mine', '--artifacts', artifacts[0].artifactRoot, '--dry-run'])}`);
      }
      nextActions.push(`Review proposal queue: ${p2aCommand(['proposals', 'digest', '--proposals', enhancements.proposals.queueDir])}`);
      nextActions.push(`Preview proposal curation review: ${p2aCommand(['proposals', 'review', '--proposals', enhancements.proposals.queueDir, '--dry-run'])}`);
    }
  }
  if (enhancements.orchestration.enabled) {
    if (!enhancements.orchestration.inSync) {
      nextActions.push(`Repair orchestration capability manifest/config drift: ${p2aCommand(['enhance', 'orchestration'])}`);
    } else {
      const orchestrationAgentTool = resolveOrchestrationAgentTool(config, manifest);
      if (artifacts.length) {
        const monitorCommand = p2aCommand([
          'execute', 'start',
          '--artifacts', artifacts[0].artifactRoot,
          '--task', '<task-id>',
          '--agent-tool', orchestrationAgentTool,
          '--require-monitor',
        ]);
        nextActions.push(`Start run with monitor gate: ${monitorCommand}`);
        nextActions.push(`Start supervised run with monitor gate: ${monitorCommand}`);
      }
    }
  }
  if (!nextActions.length) nextActions.push('No immediate P2A action detected from local files.');
  const info = {
    schema_version: 'p2a.info.v1',
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    surface: P2A_PATHS.embedded
      ? 'project_runtime'
      : P2A_PATHS.toolkitCheckout ? 'toolkit_checkout' : 'package_runtime',
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
  return { info, inspectedArtifacts };
}

function buildInfo(targetRootInput) {
  return buildInfoSnapshot(targetRootInput).info;
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
    console.log(`- memory: mode=${memory.mode} sync=${memory.inSync ? 'ok' : 'drift'} serverEnv=${memory.serverUrlEnv} serverConfigured=${memory.serverConfigured ? 'yes' : 'no'} timeoutMs=${memory.requestTimeoutMs} pushPolicy=${memory.pushPolicy}`);
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
    console.log('Usage: p2a info [--target <dir>] [--json]');
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

function printNext(next) {
  console.log('Plan2Agent next');
  console.log(`- target: ${next.target}`);
  if (next.projectId) console.log(`- projectId: ${next.projectId}`);
  console.log(`- state: ${next.state}`);
  console.log('Next action:');
  console.log(`  ${next.command.display}`);
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
    console.log('Usage: p2a next [--target <dir>] [--project-id <id>] [--json]');
    return 0;
  }
  try {
    const next = buildNext(args.target, args.projectId);
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
