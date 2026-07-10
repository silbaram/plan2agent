#!/usr/bin/env node
/** Diagnose a scaffolded Plan2Agent project from the toolkit checkout. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { GATE_FILES, GREENFIELD_REQUIRED_FILES } from './p2a_constants.mjs';
import {
  PROJECT_RUNTIME_SCHEMA_FILES,
  PROJECT_RUNTIME_SCRIPT_FILES,
  REPO_ONLY_SCRIPT_FILES,
} from './p2a_tool_manifest.mjs';

const EMPTY_TASK_COUNTS = {
  total: 0,
  ready: 0,
  todo: 0,
  inProgress: 0,
  blocked: 0,
  done: 0,
  other: 0,
};

const DEV_PROVIDER_FILES = {
  codex: [
    path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
    path.join('.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
    path.join('.agents', 'agents', 'p2a-implementer.md'),
    path.join('.agents', 'agents', 'p2a-performance-monitor.md'),
    path.join('.codex', 'agents', 'p2a-implementer.toml'),
    path.join('.codex', 'agents', 'p2a-performance-monitor.toml'),
  ],
  claude: [
    path.join('.claude', 'skills', 'p2a-harness', 'SKILL.md'),
    path.join('.claude', 'skills', 'p2a-dev-execution', 'SKILL.md'),
    path.join('.claude', 'agents', 'p2a-implementer.md'),
    path.join('.claude', 'agents', 'p2a-performance-monitor.md'),
    path.join('.claude', 'hooks', 'p2a-confine-workspace.mjs'),
    path.join('.claude', 'settings.json'),
  ],
  gemini: [
    path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
    path.join('.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
    path.join('.agents', 'agents', 'p2a-implementer.md'),
    path.join('.agents', 'agents', 'p2a-performance-monitor.md'),
    path.join('.gemini', 'agents', 'p2a-implementer.md'),
    path.join('.gemini', 'agents', 'p2a-performance-monitor.md'),
    path.join('.gemini', 'commands', 'p2a', 'dev-execution.toml'),
  ],
};

const PROPOSAL_SCHEMA_FILES = [
  'skill-proposal.schema.json',
  'proposal-review.schema.json',
  'proposal-curation.schema.json',
  'proposal-patch-draft.schema.json',
  'proposal-draft-approval.schema.json',
];
const ORCHESTRATION_SCHEMA_FILES = [
];
const ORCHESTRATION_MODES = new Set(['solo', 'solo_monitor', 'team']);

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_doctor.mjs [--target <project-dir>] [--json] [--strict] [--dev]',
    '',
    'Options:',
    '  --target <dir>  Project directory to inspect. Default: current working directory.',
    '  --json          Print machine-readable JSON.',
    '  --strict        Exit non-zero when warnings are present.',
    '  --dev           Include development skill/config/provider asset checks.',
    '  --help, -h      Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    target: process.cwd(),
    json: false,
    strict: false,
    dev: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--strict') {
      args.strict = true;
    } else if (arg === '--dev') {
      args.dev = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
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

function listDirectoryNames(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
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

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function capabilityState(manifest, config, capability) {
  const manifestRecord = objectValue(objectValue(manifest?.enhancements)[capability]);
  const configRecord = objectValue(config?.[capability]);
  const manifestEnabled = manifestRecord.enabled === true;
  const configEnabled = configRecord.enabled === true;
  return {
    manifestRecord,
    configRecord,
    manifestEnabled,
    configEnabled,
    enabled: manifestEnabled || configEnabled,
  };
}

function relativeToTarget(targetRoot, filePath) {
  const relativePath = path.relative(targetRoot, filePath);
  if (!relativePath) return '.';
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return normalizePath(relativePath);
  }
  return normalizePath(filePath);
}

function readJsonObject(filePath) {
  try {
    if (!isFile(filePath)) return { ok: false, data: null, error: 'file is missing' };
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, data: null, error: 'JSON root must be an object' };
    }
    return { ok: true, data, error: null };
  } catch (error) {
    return { ok: false, data: null, error: error.message };
  }
}

function readOptionalJsonObject(filePath) {
  if (!isFile(filePath)) return { ok: false, data: null, error: 'file is missing', missing: true };
  return readJsonObject(filePath);
}

function check(id, label, status, detail, fields = {}) {
  return { id, label, status, detail, ...fields };
}

function listedInManifest(manifest, relativePath, keys) {
  if (!manifest) return null;
  const normalized = normalizePath(relativePath);
  const availableKeys = keys.filter((key) => Array.isArray(manifest[key]));
  if (!availableKeys.length) return null;
  return availableKeys.some((key) => manifest[key]
    .filter((value) => typeof value === 'string')
    .map(normalizePath)
    .includes(normalized));
}

function manifestListingCheck(id, label, manifest, relativePaths, keys) {
  if (!manifest) {
    return check(id, label, 'warn', 'manifest is unavailable; listing consistency was not checked');
  }
  const availableKeys = keys.filter((key) => Array.isArray(manifest[key]));
  if (!availableKeys.length) {
    return check(id, label, 'warn', `manifest does not expose ${keys.join(' or ')}`);
  }
  const missing = relativePaths.filter((relativePath) => !listedInManifest(manifest, relativePath, availableKeys));
  if (missing.length) {
    return check(id, label, 'warn', `manifest listing is missing ${missing.length} expected file(s)`, { missing });
  }
  return check(id, label, 'pass', `manifest lists ${relativePaths.length} expected file(s)`);
}

function firstExistingFile(candidates) {
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function looksLikeArtifactRoot(candidate) {
  if (!isDirectory(candidate)) return false;
  if (isFile(path.join(candidate, 'current-spec.json'))) return true;
  if (isDirectory(path.join(candidate, 'iterations'))) return true;
  return GATE_FILES.some(([, , relativePath]) => isFile(path.join(candidate, relativePath)));
}

function discoverArtifactRoots(targetRoot) {
  const roots = new Set();
  if (looksLikeArtifactRoot(targetRoot)) roots.add(targetRoot);
  for (const parentPath of [
    path.join(targetRoot, 'artifacts'),
    path.join(targetRoot, '.plan2agent', 'artifacts'),
  ]) {
    for (const name of listDirectoryNames(parentPath)) {
      const candidate = path.join(parentPath, name);
      if (looksLikeArtifactRoot(candidate)) roots.add(candidate);
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

function hasGreenfieldGateBundle(artifactRoot) {
  return GREENFIELD_REQUIRED_FILES.every((relativePath) => isFile(path.join(artifactRoot, relativePath)));
}

function artifactLayout(targetRoot, artifactRoot, isScaffoldProject) {
  const hasCurrentSpec = isFile(path.join(artifactRoot, 'current-spec.json'));
  const hasIterations = isDirectory(path.join(artifactRoot, 'iterations'));
  const hasGreenfieldGateBundleValue = hasGreenfieldGateBundle(artifactRoot);
  const hasAnyIterationMarker = hasCurrentSpec || hasIterations;
  const requiresIterationInit = isScaffoldProject && hasGreenfieldGateBundleValue && !hasAnyIterationMarker;
  const hasIncompleteIterationLayout = isScaffoldProject && hasCurrentSpec !== hasIterations;
  const kind = hasIncompleteIterationLayout
    ? 'incomplete_iteration'
    : hasCurrentSpec && hasIterations
      ? 'iteration'
      : hasGreenfieldGateBundleValue
        ? 'greenfield'
        : 'unknown';
  return {
    kind,
    hasCurrentSpec,
    hasIterations,
    hasGreenfieldGateBundle: hasGreenfieldGateBundleValue,
    requiresIterationInit,
    hasIncompleteIterationLayout,
    initCommand: requiresIterationInit
      ? `node .plan2agent/scripts/p2a.mjs iteration init --artifacts ${relativeToTarget(targetRoot, artifactRoot)} --iteration-id v1-mvp`
      : null,
  };
}

function gateFileSummary(targetRoot, searchRoots, id, label, relativePath) {
  const filePath = firstExistingFile(searchRoots.map((searchRoot) => path.join(searchRoot, relativePath)));
  if (!filePath) {
    return { id, label, state: 'missing', relativePath };
  }
  const result = readJsonObject(filePath);
  return {
    id,
    label,
    state: result.ok ? 'present' : 'malformed',
    relativePath: relativeToTarget(targetRoot, filePath),
    error: result.ok ? null : result.error,
  };
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
    return {
      total: counts.total + 1,
      ready: counts.ready + (ready ? 1 : 0),
      todo: counts.todo + (status === 'todo' ? 1 : 0),
      inProgress: counts.inProgress + (status === 'in_progress' ? 1 : 0),
      blocked: counts.blocked + (status === 'blocked' ? 1 : 0),
      done: counts.done + (status === 'done' ? 1 : 0),
      other: counts.other + (!['todo', 'in_progress', 'blocked', 'done'].includes(status) ? 1 : 0),
    };
  }, { ...EMPTY_TASK_COUNTS });
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
      taskRunCount: 0,
      error: null,
    };
  }
  const runIndexPath = path.join(runsDir, 'run-index.json');
  const result = readJsonObject(runIndexPath);
  if (!result.ok) {
    return {
      runIndexPath: relativeToTarget(targetRoot, runIndexPath),
      runCount: 0,
      latestRunId: null,
      statusCounts: {},
      taskRunCount: 0,
      error: result.error,
    };
  }
  const runs = jsonRecords(result.data.runs);
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
    taskRunCount: jsonRecords(result.data.tasks).length,
    error: null,
  };
}

function summarizeArtifact(targetRoot, artifactRoot, isScaffoldProject) {
  const diagnostics = [];
  const layout = artifactLayout(targetRoot, artifactRoot, isScaffoldProject);
  let projectId = path.basename(artifactRoot);
  let activeIteration = null;

  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const currentSpecResult = readOptionalJsonObject(currentSpecPath);
  if (currentSpecResult.ok) {
    projectId = stringValue(currentSpecResult.data.project_id) ?? projectId;
    activeIteration = stringValue(currentSpecResult.data.active_iteration);
  } else if (!currentSpecResult.missing) {
    diagnostics.push({
      severity: 'error',
      message: `current-spec.json is not readable: ${currentSpecResult.error}`,
    });
  }

  const iterationRoot = activeIteration ? path.join(artifactRoot, 'iterations', activeIteration) : null;
  const searchRoots = iterationRoot && isDirectory(iterationRoot)
    ? [iterationRoot, artifactRoot]
    : [artifactRoot];
  const intakePath = firstExistingFile(searchRoots.map((searchRoot) => path.join(searchRoot, 'gate-a-intake', 'intake.json')));
  const specPath = firstExistingFile(searchRoots.map((searchRoot) => path.join(searchRoot, 'gate-b-spec', 'spec.json')));
  const taskGraphPath = firstExistingFile(searchRoots.flatMap((searchRoot) => [
    path.join(searchRoot, 'gate-c-task-graph', 'task-graph.json'),
    path.join(searchRoot, 'task-graph.json'),
  ]));
  const reviewPath = firstExistingFile(searchRoots.map((searchRoot) => path.join(searchRoot, 'gate-d-review', 'review.json')));

  const specResult = specPath ? readJsonObject(specPath) : null;
  const taskGraphResult = taskGraphPath ? readJsonObject(taskGraphPath) : null;
  const reviewResult = reviewPath ? readJsonObject(reviewPath) : null;
  if (specResult?.ok) projectId = stringValue(specResult.data.project_id) ?? projectId;
  if (taskGraphResult?.ok) projectId = stringValue(taskGraphResult.data.projectId) ?? projectId;
  if (reviewResult?.ok) projectId = stringValue(reviewResult.data.projectId) ?? projectId;

  for (const [label, result] of [
    ['Gate B spec', specResult],
    ['Gate C task graph', taskGraphResult],
    ['Gate D review', reviewResult],
  ]) {
    if (result && !result.ok) {
      diagnostics.push({ severity: 'error', message: `${label} is not readable: ${result.error}` });
    }
  }
  if (intakePath) {
    const intakeResult = readJsonObject(intakePath);
    if (!intakeResult.ok) diagnostics.push({ severity: 'error', message: `Gate A intake is not readable: ${intakeResult.error}` });
  }
  if (layout.requiresIterationInit) {
    diagnostics.push({
      severity: 'warn',
      message: 'Greenfield Gate A-D artifacts must be converted with p2a_iteration init before task execution.',
    });
  }
  if (layout.hasIncompleteIterationLayout) {
    diagnostics.push({
      severity: 'error',
      message: 'Iteration layout is incomplete: current-spec.json and iterations/ must exist together.',
    });
  }

  const taskCounts = taskGraphResult?.ok ? countTasks(taskGraphResult.data) : { ...EMPTY_TASK_COUNTS };
  const runSummary = summarizeRuns(targetRoot, artifactRoot);
  if (runSummary.error) {
    diagnostics.push({ severity: 'error', message: `run-index.json is not readable: ${runSummary.error}` });
  }

  return {
    projectId,
    artifactRoot: relativeToTarget(targetRoot, artifactRoot),
    activeIteration,
    layout,
    gates: GATE_FILES.map(([id, label, relativePath]) => gateFileSummary(targetRoot, searchRoots, id, label, relativePath)),
    spec: {
      path: specPath ? relativeToTarget(targetRoot, specPath) : null,
      approval: specResult?.ok ? stringValue(specResult.data.approval) : null,
      openDecisions: specResult?.ok && Array.isArray(specResult.data.open_decisions) ? specResult.data.open_decisions.length : null,
    },
    taskGraph: {
      path: taskGraphPath ? relativeToTarget(targetRoot, taskGraphPath) : null,
      version: taskGraphResult?.ok ? stringValue(taskGraphResult.data.version) : null,
      sourceSpec: taskGraphResult?.ok ? stringValue(taskGraphResult.data.sourceSpec) : null,
      taskCounts,
    },
    review: {
      path: reviewPath ? relativeToTarget(targetRoot, reviewPath) : null,
      blockingIssues: reviewResult?.ok && Array.isArray(reviewResult.data.blocking_issues) ? reviewResult.data.blocking_issues.length : null,
    },
    runs: runSummary,
    diagnostics,
  };
}

function artifactIsCycleCloseReady(artifact) {
  const counts = artifact.taskGraph.taskCounts;
  return Boolean(
    artifact.activeIteration
      && counts.total > 0
      && counts.done === counts.total
      && counts.todo === 0
      && counts.inProgress === 0
      && counts.blocked === 0,
  );
}

function determineProjectState(targetRoot, artifacts) {
  const hasInstallMarker = isDirectory(path.join(targetRoot, '.plan2agent'))
    || isFile(path.join(targetRoot, '.plan2agent', 'manifest.json'))
    || isFile(path.join(targetRoot, '.plan2agent', 'project.config.json'));
  const hasArtifactErrors = artifacts.some((artifact) => artifact.diagnostics.some((diagnostic) => diagnostic.severity === 'error'));
  if (hasArtifactErrors) return 'broken_install';
  if (artifacts.some((artifact) => artifact.layout.requiresIterationInit)) return 'iteration_init_required';
  if (artifacts.some(artifactIsCycleCloseReady)) return 'cycle_close_ready';
  if (artifacts.some((artifact) => artifact.taskGraph.taskCounts.ready > 0 || artifact.runs.runCount > 0)) return 'execution_ready';
  if (artifacts.length > 0) return 'planning_in_progress';
  if (hasInstallMarker) return 'installed_empty';
  return 'no_p2a';
}

function projectDiagnostics(state, artifacts) {
  const diagnostics = artifacts.flatMap((artifact) => artifact.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    artifactRoot: artifact.artifactRoot,
  })));
  if (state === 'no_p2a') diagnostics.push({ severity: 'warn', message: 'No P2A harness or artifact root was found.' });
  if (state === 'installed_empty') diagnostics.push({ severity: 'ok', message: 'P2A harness files exist, but no planning artifacts were found yet.' });
  if (state === 'execution_ready') diagnostics.push({ severity: 'ok', message: 'At least one ready task or run record was found.' });
  if (state === 'cycle_close_ready') diagnostics.push({ severity: 'ok', message: 'All active iteration tasks are done; the iteration is ready to close.' });
  return diagnostics;
}

function projectCommands(state, artifacts) {
  const commands = [];
  const primaryArtifact = artifacts[0] ?? null;
  if (primaryArtifact?.layout.requiresIterationInit && primaryArtifact.layout.initCommand) {
    commands.push({
      id: 'init_iteration',
      command: primaryArtifact.layout.initCommand,
      description: 'Convert greenfield Gate artifacts into the iteration layout before task execution.',
    });
  }
  if (primaryArtifact) {
    commands.push({
      id: 'validate',
      command: primaryArtifact.activeIteration
        ? `node .plan2agent/scripts/p2a.mjs iteration validate --artifacts ${primaryArtifact.artifactRoot}`
        : `node .plan2agent/scripts/validate_artifacts.mjs --artifact-root ${primaryArtifact.artifactRoot}`,
      description: 'Validate the detected planning artifacts.',
    });
  }
  if (state === 'installed_empty') {
    commands.push({
      id: 'import_or_plan',
      command: 'Start Gate A-D planning or import an existing artifact bundle.',
      description: 'No canonical artifact root was found yet.',
    });
  }
  return commands;
}

function summarizeProjectState(targetRoot, manifest) {
  const isScaffoldProject = manifest?.provenance?.mode === 'scaffold';
  const artifacts = discoverArtifactRoots(targetRoot)
    .map((artifactRoot) => summarizeArtifact(targetRoot, artifactRoot, isScaffoldProject));
  const state = determineProjectState(targetRoot, artifacts);
  return {
    state,
    isScaffoldProject,
    artifactCount: artifacts.length,
    artifacts,
    diagnostics: projectDiagnostics(state, artifacts),
    commands: projectCommands(state, artifacts),
  };
}

function projectStateCheck(projectState) {
  if (projectState.state === 'broken_install') {
    return check('project_state', 'Project state', 'fail', 'artifact layout or state diagnostics include errors', { state: projectState.state });
  }
  if (projectState.state === 'iteration_init_required') {
    return check('project_state', 'Project state', 'warn', 'greenfield Gate artifacts require p2a_iteration init before execution', { state: projectState.state });
  }
  if (projectState.state === 'no_p2a') {
    return check('project_state', 'Project state', 'warn', 'no P2A project state was detected', { state: projectState.state });
  }
  return check('project_state', 'Project state', 'pass', `state=${projectState.state}`, { state: projectState.state });
}

function selectedToolTargets(manifest) {
  const targets = stringArrayValue(manifest?.aiToolTargets)
    .filter((target) => ['codex', 'claude', 'gemini'].includes(target));
  return [...new Set(targets)];
}

function devProviderAssetChecks(targetRoot, targets) {
  if (!targets.length) {
    return [check('dev_ai_tool_targets', 'Dev AI tool targets', 'warn', 'no AI tool targets are recorded in manifest.aiToolTargets')];
  }
  return targets.map((target) => {
    const expected = DEV_PROVIDER_FILES[target] ?? [];
    const missing = expected
      .map(normalizePath)
      .filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
    return missing.length
      ? check(`dev_${target}_assets`, `${target} dev assets`, 'fail', `${missing.length} expected development asset(s) are missing`, { missing })
      : check(`dev_${target}_assets`, `${target} dev assets`, 'pass', `${expected.length} development assets are present`);
  });
}

function enabledCapabilityEnhancements(manifest, config) {
  return ['memory', 'gui', 'orchestration', 'proposals']
    .filter((capability) => capabilityState(manifest, config, capability).enabled);
}

function capabilityManifestCheck(capability, label, state) {
  return state.manifestEnabled
    ? check(`capability_${capability}_manifest`, `${label} capability manifest`, 'pass', `manifest.enhancements.${capability}.enabled is true`)
    : check(`capability_${capability}_manifest`, `${label} capability manifest`, 'fail', `project config enables ${capability} but manifest.enhancements.${capability}.enabled is not true`);
}

function memoryCapabilityChecks(targetRoot, state) {
  const memoryConfig = state.configRecord;
  const checks = [];
  checks.push(capabilityManifestCheck('memory', 'Memory', state));
  checks.push(
    memoryConfig.enabled === true
      ? check('capability_memory_config', 'Memory capability config', 'pass', `mode=${memoryConfig.mode ?? 'manual_sync'}, serverUrlEnv=${memoryConfig.serverUrlEnv ?? 'P2A_MEMORY_URL'}`)
      : check('capability_memory_config', 'Memory capability config', 'fail', 'manifest enables Memory but project.config.json memory.enabled is not true'),
  );
  checks.push(
    isFile(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_memory.mjs'))
      ? check('capability_memory_runtime', 'Memory runtime script', 'pass', '.plan2agent/scripts/p2a_memory.mjs is installed')
      : check('capability_memory_runtime', 'Memory runtime script', 'fail', 'p2a_memory.mjs is missing from the project runtime'),
  );
  checks.push(
    typeof memoryConfig.serverUrlEnv === 'string' && memoryConfig.serverUrlEnv.trim()
      ? check('capability_memory_server_env', 'Memory server env config', 'pass', `server URL env is ${memoryConfig.serverUrlEnv}`)
      : check('capability_memory_server_env', 'Memory server env config', 'warn', 'memory.serverUrlEnv is not configured; --server will be required for status/push'),
  );
  checks.push(
    memoryConfig.pushPolicy === 'explicit_approval'
      ? check('capability_memory_push_policy', 'Memory push policy', 'pass', 'push requires explicit approval')
      : check('capability_memory_push_policy', 'Memory push policy', 'fail', 'memory.pushPolicy must remain explicit_approval'),
  );
  const tiers = stringArrayValue(memoryConfig.syncTiers);
  checks.push(
    tiers.includes('trace') && tiers.includes('content')
      ? check('capability_memory_sync_tiers', 'Memory sync tiers', 'pass', `syncTiers=${tiers.join(',')}`)
      : check('capability_memory_sync_tiers', 'Memory sync tiers', 'warn', 'memory.syncTiers should include trace and content for useful status/push coverage'),
  );
  return checks;
}

function proposalsCapabilityChecks(targetRoot, state) {
  const proposalsConfig = state.configRecord;
  const checks = [];
  checks.push(capabilityManifestCheck('proposals', 'Proposal', state));
  checks.push(
    proposalsConfig.enabled === true
      ? check('capability_proposals_config', 'Proposal capability config', 'pass', `queueDir=${proposalsConfig.queueDir ?? '.plan2agent/proposals'}`)
      : check('capability_proposals_config', 'Proposal capability config', 'fail', 'manifest enables proposals but project.config.json proposals.enabled is not true'),
  );
  checks.push(
    isFile(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'))
      ? check('capability_proposals_runtime', 'Proposal runtime script', 'pass', '.plan2agent/scripts/p2a_proposals.mjs is installed')
      : check('capability_proposals_runtime', 'Proposal runtime script', 'fail', 'p2a_proposals.mjs is missing from the project runtime'),
  );
  const missingSchemas = PROPOSAL_SCHEMA_FILES
    .map((file) => `.plan2agent/schemas/${file}`)
    .filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingSchemas.length
      ? check('capability_proposals_schemas', 'Proposal schemas', 'fail', `${missingSchemas.length} proposal schema file(s) are missing`, { missing: missingSchemas })
      : check('capability_proposals_schemas', 'Proposal schemas', 'pass', `${PROPOSAL_SCHEMA_FILES.length} proposal schemas are installed`),
  );
  const mineOn = stringArrayValue(proposalsConfig.mineOn);
  const missingMineSignals = ['failed_run', 'blocked_run', 'verification_gap']
    .filter((signal) => !mineOn.includes(signal));
  checks.push(
    missingMineSignals.length
      ? check('capability_proposals_mine_signals', 'Proposal mining signals', 'warn', `missing mining signal(s): ${missingMineSignals.join(', ')}`, { missing: missingMineSignals })
      : check('capability_proposals_mine_signals', 'Proposal mining signals', 'pass', `mineOn=${mineOn.join(',')}`),
  );
  checks.push(
    proposalsConfig.reviewPolicy === 'manual_curate'
      ? check('capability_proposals_review_policy', 'Proposal review policy', 'pass', 'review requires manual curation')
      : check('capability_proposals_review_policy', 'Proposal review policy', 'fail', 'proposals.reviewPolicy must remain manual_curate'),
  );
  checks.push(
    proposalsConfig.patchPolicy === 'draft_only'
      ? check('capability_proposals_patch_policy', 'Proposal patch policy', 'pass', 'patches are draft-only')
      : check('capability_proposals_patch_policy', 'Proposal patch policy', 'fail', 'proposals.patchPolicy must remain draft_only'),
  );
  checks.push(
    proposalsConfig.approvalRequired === true
      ? check('capability_proposals_approval', 'Proposal approval gate', 'pass', 'approval is required before maintenance task handoff')
      : check('capability_proposals_approval', 'Proposal approval gate', 'fail', 'proposals.approvalRequired must remain true'),
  );
  return checks;
}

function orchestrationCapabilityChecks(targetRoot, state) {
  const orchestrationConfig = state.configRecord;
  const checks = [];
  checks.push(capabilityManifestCheck('orchestration', 'Orchestration', state));
  checks.push(
    orchestrationConfig.enabled === true
      ? check('capability_orchestration_config', 'Orchestration capability config', 'pass', `defaultMode=${orchestrationConfig.defaultMode ?? 'solo'}, runtimeDir=${orchestrationConfig.runtimeDir ?? '.plan2agent/runs'}`)
      : check('capability_orchestration_config', 'Orchestration capability config', 'fail', 'manifest enables orchestration but project.config.json orchestration.enabled is not true'),
  );
  checks.push(
    isFile(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_monitor_gate.mjs'))
      ? check('capability_orchestration_runtime', 'Monitor gate helper', 'pass', '.plan2agent/scripts/p2a_monitor_gate.mjs is installed')
      : check('capability_orchestration_runtime', 'Monitor gate helper', 'fail', 'p2a_monitor_gate.mjs is missing from the project runtime'),
  );
  const missingSchemas = ORCHESTRATION_SCHEMA_FILES
    .map((file) => `.plan2agent/schemas/${file}`)
    .filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingSchemas.length
      ? check('capability_orchestration_schemas', 'Orchestration schemas', 'fail', `${missingSchemas.length} orchestration schema file(s) are missing`, { missing: missingSchemas })
      : check('capability_orchestration_schemas', 'Orchestration schemas', 'pass', `${ORCHESTRATION_SCHEMA_FILES.length} orchestration schemas are installed`),
  );
  checks.push(
    orchestrationConfig.monitorGatePolicy === 'explicit_require_monitor'
      ? check('capability_orchestration_monitor_gate', 'Orchestration monitor gate', 'pass', 'monitor gates require explicit --require-monitor runs')
      : check('capability_orchestration_monitor_gate', 'Orchestration monitor gate', 'fail', 'orchestration.monitorGatePolicy must remain explicit_require_monitor'),
  );
  return checks;
}

function buildCapabilityReport(targetRoot, manifest, configResult) {
  const config = configResult.ok ? configResult.data : null;
  const enabled = enabledCapabilityEnhancements(manifest, config);
  const checks = [];
  if (enabled.includes('memory')) checks.push(...memoryCapabilityChecks(targetRoot, capabilityState(manifest, config, 'memory')));
  if (enabled.includes('orchestration')) checks.push(...orchestrationCapabilityChecks(targetRoot, capabilityState(manifest, config, 'orchestration')));
  if (enabled.includes('proposals')) checks.push(...proposalsCapabilityChecks(targetRoot, capabilityState(manifest, config, 'proposals')));
  return { enabled, checks };
}

function buildDevReport(targetRoot, manifest, configResult) {
  const targets = selectedToolTargets(manifest);
  const capabilityReport = buildCapabilityReport(targetRoot, manifest, configResult);
  const checks = [];
  checks.push(...devProviderAssetChecks(targetRoot, targets));
  checks.push(...capabilityReport.checks);

  const manifestAiToolFiles = stringArrayValue(manifest?.aiToolFiles).map(normalizePath);
  if (manifestAiToolFiles.length) {
    const missing = manifestAiToolFiles.filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
    checks.push(
      missing.length
        ? check('dev_manifest_ai_tool_files', 'Manifest AI tool files', 'fail', `${missing.length} manifest-listed AI tool file(s) are missing`, { missing })
        : check('dev_manifest_ai_tool_files', 'Manifest AI tool files', 'pass', `${manifestAiToolFiles.length} manifest-listed AI tool files are present`),
    );
  } else {
    checks.push(check('dev_manifest_ai_tool_files', 'Manifest AI tool files', 'warn', 'manifest.aiToolFiles is empty or unavailable'));
  }

  const config = configResult.ok ? configResult.data : null;
  const capabilityTargets = targets.filter((target) => config?.providerNativeCapabilities?.[target]);
  checks.push(
    targets.length && capabilityTargets.length === targets.length
      ? check('dev_provider_capabilities', 'Provider capability config', 'pass', `providerNativeCapabilities covers ${targets.join(', ')}`)
      : check('dev_provider_capabilities', 'Provider capability config', 'warn', 'providerNativeCapabilities does not cover every selected AI tool target', { targets, configured: capabilityTargets }),
  );

  checks.push(
    config?.runTracking?.runsDir && config?.runTracking?.defaultIsolation
      ? check('dev_run_tracking', 'Run tracking config', 'pass', `runsDir=${config.runTracking.runsDir}, defaultIsolation=${config.runTracking.defaultIsolation}`)
      : check('dev_run_tracking', 'Run tracking config', 'warn', 'runTracking.runsDir/defaultIsolation is not configured'),
  );

  checks.push(
    config?.devExecution?.defaultProvider
      && Array.isArray(config.devExecution.allowedProviders)
      && config.devExecution.scopePolicy === 'task_only'
      && config.devExecution.verificationPolicy === 'required_for_done'
      ? check('dev_execution_config', 'Dev execution config', 'pass', `defaultProvider=${config.devExecution.defaultProvider}, scopePolicy=${config.devExecution.scopePolicy}`)
      : check('dev_execution_config', 'Dev execution config', 'warn', 'devExecution defaultProvider/allowedProviders/scopePolicy/verificationPolicy is not fully configured'),
  );

  checks.push(
    config?.roleProfiles?.implementer?.defaultProfile
      && config?.roleProfiles?.reviewer?.defaultProfile
      && config?.roleProfiles?.monitor?.defaultProfile
      ? check('dev_role_profiles', 'Role profiles', 'pass', `implementer=${config.roleProfiles.implementer.defaultProfile}, reviewer=${config.roleProfiles.reviewer.defaultProfile}, monitor=${config.roleProfiles.monitor.defaultProfile}`)
      : check('dev_role_profiles', 'Role profiles', 'warn', 'roleProfiles implementer/reviewer/monitor defaults are not fully configured'),
  );

  checks.push(
    config?.promptTemplates?.devExecution === 'p2a.dev_prompt.v1'
      && config?.promptTemplates?.roleContract === 'p2a.role_contract.v1'
      && config?.promptTemplates?.providerGuide === 'p2a.provider_guide.v1'
      ? check('dev_prompt_templates', 'Prompt template versions', 'pass', 'dev prompt, role contract, and provider guide versions are configured')
      : check('dev_prompt_templates', 'Prompt template versions', 'warn', 'promptTemplates devExecution/roleContract/providerGuide versions are not fully configured'),
  );

  if (targets.includes('claude')) {
    const claudeSettingsPath = path.join(targetRoot, '.claude', 'settings.json');
    const claudeSettings = readJsonObject(claudeSettingsPath);
    const hookCommand = claudeSettings.ok
      ? claudeSettings.data.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
      : null;
    const denyRules = claudeSettings.ok && Array.isArray(claudeSettings.data.permissions?.deny)
      ? claudeSettings.data.permissions.deny
      : [];
    checks.push(
      hookCommand === 'node .claude/hooks/p2a-confine-workspace.mjs'
        && denyRules.includes('Edit(~/**)')
        && isFile(path.join(targetRoot, '.claude', 'hooks', 'p2a-confine-workspace.mjs'))
        ? check('dev_claude_confinement', 'Claude confinement', 'pass', 'settings and PreToolUse confinement hook are installed')
        : check('dev_claude_confinement', 'Claude confinement', 'fail', 'Claude settings or PreToolUse confinement hook is missing or incomplete'),
    );
  }

  return {
    enabled: true,
    aiToolTargets: targets,
    capabilities: capabilityReport.enabled,
    checks,
  };
}

function diagnose(targetRootInput, options = {}) {
  const targetRoot = path.resolve(targetRootInput);
  const checks = [];

  checks.push(
    isDirectory(targetRoot)
      ? check('target_directory', 'Target directory', 'pass', 'target directory exists', { path: targetRoot })
      : check('target_directory', 'Target directory', 'fail', 'target directory is missing or is not a directory', { path: targetRoot }),
  );

  const p2aDir = path.join(targetRoot, '.plan2agent');
  checks.push(
    isDirectory(p2aDir)
      ? check('p2a_directory', 'P2A directory', 'pass', '.plan2agent directory exists', { path: '.plan2agent' })
      : check('p2a_directory', 'P2A directory', 'fail', '.plan2agent directory is missing', { path: '.plan2agent' }),
  );

  const manifestPath = path.join(p2aDir, 'manifest.json');
  const manifestResult = readJsonObject(manifestPath);
  const manifest = manifestResult.ok ? manifestResult.data : null;
  checks.push(
    manifestResult.ok
      ? check('manifest', 'Install manifest', 'pass', 'manifest.json is readable JSON', { path: '.plan2agent/manifest.json' })
      : check('manifest', 'Install manifest', 'fail', `manifest.json is not readable: ${manifestResult.error}`, { path: '.plan2agent/manifest.json' }),
  );

  const configPath = path.join(p2aDir, 'project.config.json');
  const configResult = readJsonObject(configPath);
  checks.push(
    configResult.ok
      ? check('project_config', 'Project config', 'pass', 'project.config.json is readable JSON', { path: '.plan2agent/project.config.json' })
      : check('project_config', 'Project config', 'fail', `project.config.json is not readable: ${configResult.error}`, { path: '.plan2agent/project.config.json' }),
  );

  const runtimeScriptPaths = PROJECT_RUNTIME_SCRIPT_FILES.map((file) => `.plan2agent/scripts/${file}`);
  const missingRuntimeScripts = runtimeScriptPaths.filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingRuntimeScripts.length
      ? check('runtime_scripts', 'Runtime scripts', 'fail', `${missingRuntimeScripts.length} runtime script(s) are missing`, { missing: missingRuntimeScripts })
      : check('runtime_scripts', 'Runtime scripts', 'pass', `${runtimeScriptPaths.length} runtime scripts are present`),
  );

  const runtimeSchemaPaths = PROJECT_RUNTIME_SCHEMA_FILES.map((file) => `.plan2agent/schemas/${file}`);
  const missingRuntimeSchemas = runtimeSchemaPaths.filter((relativePath) => !isFile(path.join(targetRoot, relativePath)));
  checks.push(
    missingRuntimeSchemas.length
      ? check('runtime_schemas', 'Runtime schemas', 'fail', `${missingRuntimeSchemas.length} runtime schema file(s) are missing`, { missing: missingRuntimeSchemas })
      : check('runtime_schemas', 'Runtime schemas', 'pass', `${runtimeSchemaPaths.length} runtime schemas are present`),
  );

  const misplacedRepoOnlyScripts = REPO_ONLY_SCRIPT_FILES
    .map((file) => `.plan2agent/scripts/${file}`)
    .filter((relativePath) => isFile(path.join(targetRoot, relativePath)));
  checks.push(
    misplacedRepoOnlyScripts.length
      ? check('repo_only_scripts_absent', 'Repo-only scripts', 'warn', `${misplacedRepoOnlyScripts.length} repo-only script(s) are installed in .plan2agent/scripts`, { unexpected: misplacedRepoOnlyScripts })
      : check('repo_only_scripts_absent', 'Repo-only scripts', 'pass', 'repo-only scripts are not installed in .plan2agent/scripts'),
  );

  checks.push(manifestListingCheck('manifest_runtime_scripts', 'Manifest runtime scripts', manifest, runtimeScriptPaths, ['scriptFiles', 'toolFiles']));
  checks.push(manifestListingCheck('manifest_runtime_schemas', 'Manifest runtime schemas', manifest, runtimeSchemaPaths, ['schemaFiles']));

  const config = configResult.ok ? configResult.data : null;
  const verificationKeys = ['testCommand', 'lintCommand', 'typecheckCommand'];
  const configuredVerification = verificationKeys.filter((key) => typeof config?.[key] === 'string' && config[key].trim().length > 0);
  checks.push(
    configuredVerification.length
      ? check('verification_commands', 'Verification commands', 'pass', `configured: ${configuredVerification.join(', ')}`)
      : check('verification_commands', 'Verification commands', 'warn', 'no test/lint/typecheck command is configured'),
  );

  const projectState = summarizeProjectState(targetRoot, manifest);
  checks.push(projectStateCheck(projectState));
  const dev = options.dev ? buildDevReport(targetRoot, manifest, configResult) : null;
  if (dev) checks.push(...dev.checks);

  const failures = checks.filter((item) => item.status === 'fail').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  const passed = checks.filter((item) => item.status === 'pass').length;
  const status = failures ? 'fail' : warnings ? 'warn' : 'pass';
  return {
    schema_version: 'p2a.doctor.v1',
    target: targetRoot,
    status,
    summary: { passed, warnings, failures },
    checks,
    projectState,
    dev,
    nextActions: nextActions(status, checks),
  };
}

function nextActions(status, checks) {
  if (status === 'pass') return [];
  const actions = [];
  if (checks.some((item) => item.id === 'runtime_scripts' && item.status === 'fail')
    || checks.some((item) => item.id === 'runtime_schemas' && item.status === 'fail')) {
    actions.push('Run scaffold or upgrade from the Plan2Agent toolkit checkout to restore missing runtime files.');
  }
  if (checks.some((item) => item.id === 'repo_only_scripts_absent' && item.status === 'warn')) {
    actions.push('Remove repo-only scripts from .plan2agent/scripts or regenerate the project harness.');
  }
  if (checks.some((item) => item.id === 'verification_commands' && item.status === 'warn')) {
    actions.push('Review .plan2agent/project.config.json and add test/lint/typecheck commands when available.');
  }
  if (checks.some((item) => item.id === 'project_state' && item.state === 'iteration_init_required')) {
    actions.push('Run p2a.mjs iteration init for the detected greenfield artifact root before starting task execution.');
  }
  if (checks.some((item) => item.id.startsWith('dev_') && item.status === 'fail')) {
    actions.push('Regenerate or upgrade AI tool assets for the selected provider targets, then rerun p2a_doctor --dev.');
  }
  if (checks.some((item) => item.id === 'dev_provider_capabilities' && item.status === 'warn')) {
    actions.push('Review .plan2agent/project.config.json providerNativeCapabilities for the selected AI tool targets.');
  }
  if (checks.some((item) => item.id === 'capability_memory_manifest' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_memory_config' && item.status === 'fail')) {
    actions.push('Run p2a.mjs enhance memory or upgrade --dry-run to restore Memory capability config.');
  }
  if (checks.some((item) => item.id === 'capability_memory_runtime' && item.status === 'fail')) {
    actions.push('Run p2a.mjs upgrade --dry-run from the scaffolded project, then apply the reviewed runtime update.');
  }
  if (checks.some((item) => item.id === 'capability_memory_push_policy' && item.status === 'fail')) {
    actions.push('Restore memory.pushPolicy to explicit_approval before enabling Memory push.');
  }
  if (checks.some((item) => item.id === 'capability_orchestration_manifest' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_orchestration_config' && item.status === 'fail')) {
    actions.push('Run p2a.mjs enhance orchestration or upgrade --dry-run to restore orchestration capability config.');
  }
  if (checks.some((item) => item.id === 'capability_orchestration_runtime' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_orchestration_schemas' && item.status === 'fail')) {
    actions.push('Run p2a.mjs upgrade --dry-run from the scaffolded project, then apply the reviewed orchestration runtime/schema update.');
  }
  if (checks.some((item) => item.id === 'capability_orchestration_monitor_gate' && item.status === 'fail')) {
    actions.push('Restore orchestration monitorGatePolicy before using monitor-gated execution.');
  }
  if (checks.some((item) => item.id === 'capability_proposals_manifest' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_proposals_config' && item.status === 'fail')) {
    actions.push('Run p2a.mjs enhance proposals or upgrade --dry-run to restore proposal capability config.');
  }
  if (checks.some((item) => item.id === 'capability_proposals_runtime' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_proposals_schemas' && item.status === 'fail')) {
    actions.push('Run p2a.mjs upgrade --dry-run from the scaffolded project, then apply the reviewed proposal runtime/schema update.');
  }
  if (checks.some((item) => item.id === 'capability_proposals_review_policy' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_proposals_patch_policy' && item.status === 'fail')
    || checks.some((item) => item.id === 'capability_proposals_approval' && item.status === 'fail')) {
    actions.push('Restore proposals reviewPolicy/manual curation, draft_only patching, and approvalRequired before using proposal maintenance handoff.');
  }
  if (!actions.length) actions.push('Review failed or warning checks above.');
  return actions;
}

function printHuman(report) {
  console.log(`Plan2Agent doctor: ${report.status}`);
  console.log(`target: ${report.target}`);
  console.log(`summary: ${report.summary.passed} passed, ${report.summary.warnings} warning(s), ${report.summary.failures} failure(s)`);
  for (const item of report.checks) {
    const prefix = item.status === 'pass' ? 'PASS' : item.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`- ${prefix} ${item.label}: ${item.detail}`);
    if (Array.isArray(item.missing) && item.missing.length) {
      for (const missing of item.missing) console.log(`  missing: ${missing}`);
    }
    if (Array.isArray(item.unexpected) && item.unexpected.length) {
      for (const unexpected of item.unexpected) console.log(`  unexpected: ${unexpected}`);
    }
  }
  console.log(`project state: ${report.projectState.state}`);
  console.log(`- scaffold: ${report.projectState.isScaffoldProject ? 'yes' : 'no'}`);
  console.log(`- artifacts: ${report.projectState.artifactCount}`);
  for (const artifact of report.projectState.artifacts) {
    const counts = artifact.taskGraph.taskCounts;
    console.log(`- ${artifact.projectId}: ${artifact.artifactRoot} (${artifact.layout.kind})`);
    if (artifact.activeIteration) console.log(`  activeIteration: ${artifact.activeIteration}`);
    console.log(`  tasks: ${counts.total} total, ${counts.ready} ready, ${counts.done} done, ${counts.blocked} blocked`);
    console.log(`  runs: ${artifact.runs.runCount}${artifact.runs.latestRunId ? `, latest ${artifact.runs.latestRunId}` : ''}`);
    console.log(`  gates: ${artifact.gates.map((gate) => `${gate.id}=${gate.state}`).join(', ')}`);
    if (artifact.layout.requiresIterationInit && artifact.layout.initCommand) {
      console.log(`  init: ${artifact.layout.initCommand}`);
    }
  }
  if (report.dev) {
    console.log(`dev targets: ${report.dev.aiToolTargets.length ? report.dev.aiToolTargets.join(', ') : 'none'}`);
    console.log(`dev capabilities: ${report.dev.capabilities.length ? report.dev.capabilities.join(', ') : 'none'}`);
  }
  if (report.nextActions.length) {
    console.log('next actions:');
    for (const action of report.nextActions) console.log(`- ${action}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const report = diagnose(args.target, { dev: args.dev });
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report);
    if (report.summary.failures > 0) return 1;
    if (args.strict && report.summary.warnings > 0) return 1;
    return 0;
  } catch (error) {
    console.error(`p2a_doctor failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
