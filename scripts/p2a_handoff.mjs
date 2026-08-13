#!/usr/bin/env node
/** Handoff approved Plan2Agent artifacts into a target project without executing build/install/codegen. */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import {
  loadJson,
  milestoneRunSnapshotSha256,
  milestoneSnapshotSha256,
  validateArtifactRoot,
  validateApprovalAuditData,
  validateConstitution,
  validateHandoffReadyArtifactRoot,
  validateIntake,
  validateMilestoneReview,
  validateRunsDir,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';
import {
  resolveIterationState,
  validateCurrentSpecCompositionData,
} from './p2a_iteration_state.mjs';
import {
  EXPLICIT_INTAKE_MARKDOWN_MARKER,
  renderIntakeMarkdown,
  renderIterationIndexMarkdown,
} from './p2a_iteration.mjs';
import {
  normalizePath,
  P2A_ARTIFACTS_DIR,
  P2A_SCHEMAS_DIR,
  P2A_SCRIPTS_DIR,
  resolveP2aPaths,
} from './p2a_paths.mjs';
import { artifactRunRef, legacyRunRef, runSidecarRef } from './p2a_run_paths.mjs';
import {
  assertCanonicalPortableRun,
  closeReadyAcceptanceReviewRunIds,
  closeReadyVisualReviewRunIds,
  completedEvidenceRunIds,
  portableProvenanceMigrationHint,
  selectHandoffRunEntries,
  validatePortableHandoffTarget,
} from './p2a_handoff_portability.mjs';
import { shellQuote } from './p2a_run_commands.mjs';
import {
  buildProjectConfig,
  defaultCapabilityConfig,
  defaultPromptTemplates,
  mergeCapabilityConfig,
  mergeDevSkillConfig,
  mergeProjectIdConfig,
  mergeProjectIdManifest,
  resolveOrchestrationAgentTool,
  resolveProjectIdDefault,
} from './p2a_project_config.mjs';
import {
  PROJECT_RUNTIME_SCHEMA_FILES,
  PROJECT_RUNTIME_SCRIPT_FILES,
} from './p2a_tool_manifest.mjs';
import {
  FEATURE_RADAR_COPY_FILES,
  FEATURE_RADAR_PREFLIGHT_DIR,
} from './p2a_radar_preflight.mjs';
import {
  atomicWriteJson,
  atomicWriteText,
  withRunStoreLocks,
} from './p2a_run_store.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.toolRoot;
const VALID_MODES = new Set(['copy', 'move']);
const RUN_TRANSFER_MODES = new Set(['completed', 'resumable']);
const TOOL_TARGET_ORDER = ['codex', 'claude', 'gemini'];
const VALID_TOOL_TARGETS = new Set(TOOL_TARGET_ORDER);
const CODEX_AGENT_PROFILE_ORDER = ['quality', 'inherit'];
const VALID_CODEX_AGENT_PROFILES = new Set(CODEX_AGENT_PROFILE_ORDER);
const DEFAULT_CODEX_AGENT_PROFILE = 'quality';
const ENHANCEMENT_ORDER = ['dev-skills', 'memory', 'orchestration', 'proposals'];
const VALID_ENHANCEMENTS = new Set(ENHANCEMENT_ORDER);
const MILESTONE_REVIEW_CHECKPOINTS = ['midpoint', 'pre_close'];
const ARTIFACT_TARGET_BASE = P2A_ARTIFACTS_DIR;
const TEAM_BIGFIVE_HARNESS_DIR = path.join('.plan2agent', 'team-harnesses', 'team-bigfive');
const TEAM_BIGFIVE_SOURCE_MANIFEST = path.join(TEAM_BIGFIVE_HARNESS_DIR, 'source-manifest.json');
const TEAM_BIGFIVE_ADAPTATION_NOTES = path.join(TEAM_BIGFIVE_HARNESS_DIR, 'adaptation-notes.md');
const DEFAULT_ITERATION_ID = 'active';
const MANAGED_FILE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const INITIALIZE_COMMANDS = new Set(['init', 'scaffold']);
const UPGRADE_APPLY_PREFLIGHT_ENV = 'P2A_UPGRADE_APPLY_PREFLIGHT';
const SCAFFOLD_SCRIPT_FILES = PROJECT_RUNTIME_SCRIPT_FILES;
const SCAFFOLD_SCHEMA_FILES = PROJECT_RUNTIME_SCHEMA_FILES;

function readPackageCoordinates() {
  const packagePath = path.join(ROOT, 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (typeof packageJson.name !== 'string' || !packageJson.name.trim()) {
      throw new Error('name must be a non-empty string');
    }
    if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
      throw new Error('version must be a non-empty string');
    }
    return {
      packageName: packageJson.name.trim(),
      packageVersion: packageJson.version.trim(),
    };
  } catch (error) {
    throw new Error(`Plan2Agent package metadata is unavailable at ${normalizePath(packagePath)}: ${error.message}`);
  }
}

function targetScriptPath(file) {
  return path.join(P2A_SCRIPTS_DIR, file);
}

function targetSchemaPath(file) {
  return path.join(P2A_SCHEMAS_DIR, file);
}

function isInitializeCommand(command) {
  return INITIALIZE_COMMANDS.has(command);
}

function usage() {
  return [
    'Usage:',
    '  p2a init [--target <project-dir>] [--tools <list>] [--codex-profile quality|inherit] [--overwrite] [--dry-run]',
    '  p2a enhance <capability> [--target <project-dir>] [--tools <list>] [--codex-profile quality|inherit] [--overwrite] [--dry-run]',
    '  p2a update [--target <project-dir>] [--tools <list>] [--codex-profile quality|inherit] [--dry-run|--apply] [--prune]',
    '  p2a upgrade [--target <project-dir>] (--dry-run|--apply) [--tools <list>] [--codex-profile quality|inherit] [--prune]',
    '  p2a handoff --project-id <id> --artifacts <path> --target <path> [--codex-profile quality|inherit] [options]',
    '',
    'Options:',
    'Initialization:',
    '  init                 Initialize project state and selected AI tool assets. Runtime scripts and schemas stay in the installed package.',
    '  enhance <capability> Install or refresh one capability: dev-skills, memory, orchestration, proposals.',
    '  update               Preview or apply scaffolded harness updates.',
    '  upgrade              Preview or apply scaffolded harness file updates.',
    '  --target <path>      Project directory to initialize or update. Defaults to the current directory through p2a.',
    '  --tools <list>       Copy portable P2A AI tool assets for init/enhance dev-skills. Use comma list, all, or none. Default: all.',
    '  --codex-profile <p>  Codex agent profile: quality pins GPT-5.6 Sol by tier; inherit uses the parent session model/effort. Default: quality.',
    '',
    'Handoff options:',
    '  --mode copy|move     Copy artifacts by default; move removes source files after successful write.',
    '  --iteration-id <id>  Use iterative artifacts. The id must match current-spec.json active_iteration; default: active.',
    '  --run-transfer <m>   completed byte-copies milestone-referenced finished v2 evidence only (default); resumable performs compatibility transfer and also ports active non-visual runs.',
    '  --include-intake     Generate an explicit gate-a-intake/intake.md export from canonical intake.json.',
    '  --tools <list>       Copy portable P2A AI tool assets for codex,claude,gemini. Use comma list or all.',
    '  --include-team-bigfive',
    '                       Install Team Big Five adapter files for selected CLI targets.',
    '  --team-bigfive-source <path-or-git-url>',
    '                       Record the Team Big Five source. Local directories are fingerprinted.',
    '  --team-bigfive-targets <list>',
    '                       Adapter targets for codex,claude,gemini. Defaults to --tools or all.',
    '  --overwrite          Allow replacing existing target files.',
    '  --dry-run            Validate and print the plan without writing project files or reports.',
    '  --apply              Apply safe update/upgrade changes after reviewing the preview.',
    '  --prune              With update/upgrade, remove retired managed files only when their installation SHA-256 still matches.',
    '  --help, -h           Show this help.',
  ].join('\n');
}

function parseToolTargets(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('--tools requires codex, claude, gemini, all, or none');
  }
  const rawTargets = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!rawTargets.length) throw new Error('--tools requires at least one target');
  const unique = new Set(rawTargets);
  if (unique.has('none')) {
    if (unique.size > 1) throw new Error('--tools none cannot be combined with other targets');
    return [];
  }
  if (unique.has('all')) {
    if (unique.size > 1) throw new Error('--tools all cannot be combined with other targets');
    return [...TOOL_TARGET_ORDER];
  }
  const unknown = [...unique].filter((target) => !VALID_TOOL_TARGETS.has(target)).sort();
  if (unknown.length) {
    throw new Error(`unknown --tools target(s): ${unknown.join(', ')}; expected codex, claude, gemini, all, or none`);
  }
  return TOOL_TARGET_ORDER.filter((target) => unique.has(target));
}

function parseRequiredToolTargets(value, optionName) {
  const targets = parseToolTargets(value);
  if (!targets.length) throw new Error(`${optionName} requires at least one of codex, claude, gemini, or all`);
  return targets;
}

function parseCodexAgentProfile(value) {
  if (typeof value !== 'string' || !VALID_CODEX_AGENT_PROFILES.has(value.trim().toLowerCase())) {
    throw new Error(`--codex-profile requires one of: ${CODEX_AGENT_PROFILE_ORDER.join(', ')}`);
  }
  return value.trim().toLowerCase();
}

function isGitUrl(value) {
  return /^(https?|ssh|git):\/\//i.test(value) || /^git@[^:]+:.+/.test(value);
}

function parseArgs(argv) {
  const harnessCommand = new Set(['init', 'scaffold', 'update', 'upgrade', 'enhance']);
  const command = harnessCommand.has(argv[0]) ? argv.shift() : 'handoff';
  const enhancement = command === 'enhance' ? argv.shift() : null;
  const enhancementHelp = enhancement === '--help' || enhancement === '-h';
  const args = {
    command,
    enhancement,
    mode: 'copy',
    iterationId: DEFAULT_ITERATION_ID,
    iterationIdProvided: false,
    includeIntake: false,
    runTransfer: 'completed',
    tools: isInitializeCommand(command) || command === 'enhance' ? [...TOOL_TARGET_ORDER] : command === 'update' || command === 'upgrade' ? null : [],
    includeTeamBigFive: false,
    teamBigFiveSource: null,
    teamBigFiveTargets: null,
    overwrite: false,
    dryRun: false,
    apply: false,
    prune: false,
    help: enhancementHelp,
    toolsProvided: false,
    codexProfile: command === 'update' || command === 'upgrade' || command === 'enhance' ? null : DEFAULT_CODEX_AGENT_PROFILE,
    codexProfileProvided: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if ((isInitializeCommand(command) || command === 'update' || command === 'upgrade' || command === 'enhance') && (arg === '--project-id' || arg === '--artifacts' || arg === '--mode' || arg === '--iteration-id' || arg === '--run-transfer' || arg === '--include-intake' || arg === '--include-team-bigfive' || arg === '--team-bigfive-source' || arg === '--team-bigfive-targets')) {
      throw new Error(`${arg} is not valid for ${command}`);
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
    } else if (arg === '--iteration-id') {
      args.iterationId = argv[++index];
      if (!args.iterationId) throw new Error('--iteration-id requires active or an iteration id');
      args.iterationIdProvided = true;
    } else if (arg === '--run-transfer') {
      args.runTransfer = argv[++index];
      if (!RUN_TRANSFER_MODES.has(args.runTransfer)) {
        throw new Error(`--run-transfer must be completed or resumable, got ${JSON.stringify(args.runTransfer)}`);
      }
    } else if (arg === '--include-intake') {
      args.includeIntake = true;
    } else if (arg === '--tools') {
      args.tools = parseToolTargets(argv[++index]);
      args.toolsProvided = true;
    } else if (arg === '--codex-profile') {
      args.codexProfile = parseCodexAgentProfile(argv[++index]);
      args.codexProfileProvided = true;
    } else if (arg === '--include-team-bigfive') {
      args.includeTeamBigFive = true;
    } else if (arg === '--team-bigfive-source') {
      args.teamBigFiveSource = argv[++index];
      if (!args.teamBigFiveSource) throw new Error('--team-bigfive-source requires a path or Git URL');
    } else if (arg === '--team-bigfive-targets') {
      const value = argv[++index];
      if (!value) throw new Error('--team-bigfive-targets requires codex, claude, gemini, or all');
      args.teamBigFiveTargets = parseRequiredToolTargets(value, '--team-bigfive-targets');
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--prune') {
      args.prune = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (command === 'enhance') {
    if (!VALID_ENHANCEMENTS.has(enhancement)) throw new Error(`enhance requires one of: ${ENHANCEMENT_ORDER.join(', ')}`);
  }
  if (isInitializeCommand(command) || command === 'update' || command === 'upgrade' || command === 'enhance') {
    if (!args.target) throw new Error('--target is required');
    if (args.apply && args.dryRun) throw new Error('--apply cannot be combined with --dry-run');
    if (args.apply && command !== 'update' && command !== 'upgrade') throw new Error('--apply is only supported by update and upgrade');
    if (args.prune && command !== 'update' && command !== 'upgrade') throw new Error('--prune is only supported by update and upgrade');
    if (command === 'upgrade' && !args.dryRun && !args.apply) throw new Error('upgrade requires --dry-run or --apply');
    return args;
  }
  for (const required of ['projectId', 'artifacts', 'target']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required`);
  }
  if (args.apply) throw new Error('--apply is only supported by update and upgrade');
  if (args.prune) throw new Error('--prune is only supported by update and upgrade');
  if (!args.includeTeamBigFive && (args.teamBigFiveSource || args.teamBigFiveTargets)) {
    throw new Error('--team-bigfive-source and --team-bigfive-targets require --include-team-bigfive');
  }
  if (args.includeTeamBigFive) {
    if (!args.teamBigFiveSource) throw new Error('--include-team-bigfive requires --team-bigfive-source');
    if (!args.teamBigFiveTargets) {
      args.teamBigFiveTargets = args.tools.length ? [...args.tools] : [...TOOL_TARGET_ORDER];
    }
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

function isIterativeArtifactRoot(artifactsRoot) {
  return existsSync(path.join(artifactsRoot, 'current-spec.json'))
    && existsSync(path.join(artifactsRoot, 'iterations'))
    && lstatSync(path.join(artifactsRoot, 'iterations')).isDirectory();
}

function assertSafeIterationId(iterationId) {
  if (iterationId === DEFAULT_ITERATION_ID) return;
  if (iterationId.includes('/') || iterationId.includes('\\') || iterationId === '.' || iterationId === '..') {
    throw new ValidationError(`--iteration-id must be "active" or a single path segment, got ${JSON.stringify(iterationId)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(iterationId)) {
    throw new ValidationError(`--iteration-id may only contain letters, numbers, dots, underscores, and hyphens, got ${JSON.stringify(iterationId)}`);
  }
}

function iterationGatePaths(artifactsRoot, iterationId, currentSpecPath) {
  const iterationRoot = path.join(artifactsRoot, 'iterations', iterationId);
  return {
    statusDoc: path.join(artifactsRoot, 'status.md'),
    currentSpec: currentSpecPath,
    intakeJson: path.join(iterationRoot, 'gate-a-intake', 'intake.json'),
    intakeMd: path.join(iterationRoot, 'gate-a-intake', 'intake.md'),
    productSpec: path.join(iterationRoot, 'gate-b-spec', 'product-spec.md'),
    implementationPlan: path.join(iterationRoot, 'gate-b-spec', 'implementation-plan.md'),
    specJson: path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
    taskGraph: path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'),
  };
}

function assertProjectId(label, actual, expected) {
  if (actual !== expected) {
    throw new ValidationError(`${label} must match project id ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNoCurrentSpecOpenDecisions(currentSpec) {
  const openDecisions = currentSpec.open_decisions ?? [];
  if (!Array.isArray(openDecisions)) {
    throw new ValidationError('current-spec.json open_decisions must be an array when present');
  }
  if (openDecisions.length) {
    throw new ValidationError(`current-spec.json has unresolved open_decisions: ${JSON.stringify(openDecisions.map((decision) => decision.id ?? decision))}`);
  }
}

function validateIterationHandoffSource(artifactsRoot, projectId, iterationIdArg) {
  assertSafeIterationId(iterationIdArg);
  const structuralState = resolveIterationState(artifactsRoot, { requireReady: false });
  const iterationId = iterationIdArg === DEFAULT_ITERATION_ID
    ? structuralState.activeIteration
    : iterationIdArg;
  if (iterationId !== structuralState.activeIteration) {
    throw new ValidationError(
      `handoff --iteration-id must select the active iteration ${JSON.stringify(structuralState.activeIteration)}, got ${JSON.stringify(iterationId)}`,
    );
  }
  const state = resolveIterationState(artifactsRoot);
  const paths = iterationGatePaths(artifactsRoot, iterationId, state.currentSpecPath);

  assertFile(paths.currentSpec, 'current-spec.json');
  assertNoCurrentSpecOpenDecisions(state.currentSpec);
  validateCurrentSpecCompositionData(state.currentSpec, artifactsRoot, {
    requireNoOpenDecisions: true,
  });
  assertFile(paths.specJson, `iterations/${iterationId}/gate-b-spec/spec.json`);
  assertFile(paths.taskGraph, `iterations/${iterationId}/gate-c-task-graph/task-graph.json`);
  assertFile(paths.intakeJson, `iterations/${iterationId}/gate-a-intake/intake.json`);
  validateIntake(paths.intakeJson, { artifactRoot: artifactsRoot });

  const spec = validateSpec(
    paths.specJson,
    paths.intakeJson,
    { artifactRoot: artifactsRoot },
  );
  if (spec.approval !== 'approved') throw new ValidationError('handoff requires spec.approval to be approved');
  if (spec.open_decisions.length) throw new ValidationError('handoff requires spec.open_decisions to be empty');
  assertProjectId('spec.project_id', spec.project_id, projectId);

  const taskGraph = validateTaskGraph(paths.taskGraph, paths.specJson);
  assertProjectId('taskGraph.projectId', taskGraph.projectId, projectId);

  return {
    kind: 'iteration',
    iterationId,
    paths,
    currentSpecPath: paths.currentSpec,
    currentSpec: state.currentSpec,
  };
}

function resolveHandoffSource(artifactsRoot, args) {
  const iterative = isIterativeArtifactRoot(artifactsRoot);
  if (iterative) {
    if (args.mode === 'move') {
      throw new Error('--mode move is not supported for iterative artifact roots; use copy to keep iteration history intact');
    }
    return validateIterationHandoffSource(artifactsRoot, args.projectId, args.iterationId);
  }
  if (args.iterationIdProvided) {
    throw new Error('--iteration-id requires an iterative artifact root with current-spec.json and iterations/');
  }
  return {
    kind: 'greenfield',
    iterationId: null,
    paths: validateGates(artifactsRoot, args.projectId),
    currentSpecPath: null,
    currentSpec: null,
  };
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

function sha256Value(value) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(content).digest('hex');
}

function sameFileContent(left, right) {
  const leftContent = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const rightContent = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return leftContent.equals(rightContent);
}

function normalizeManagedFileRecords(records) {
  const recordsByPath = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (typeof record.path !== 'string' || !record.path.trim()) continue;
    if (typeof record.owner !== 'string' || !record.owner.trim()) continue;
    if (typeof record.sha256 !== 'string' || !MANAGED_FILE_HASH_PATTERN.test(record.sha256)) continue;
    const managedPath = normalizePath(record.path);
    recordsByPath.set(managedPath, {
      path: managedPath,
      owner: record.owner,
      sha256: record.sha256,
    });
  }
  return [...recordsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function mergeManagedFileRecords(existingRecords, nextRecords) {
  const recordsByPath = new Map(normalizeManagedFileRecords(existingRecords).map((record) => [record.path, record]));
  for (const record of normalizeManagedFileRecords(nextRecords)) recordsByPath.set(record.path, record);
  return [...recordsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function plannedManagedFileRecords(plan, { scriptFiles = [], schemaFiles = [], aiToolGroups = [] } = {}) {
  const itemByTarget = new Map(plan.map((item) => [normalizePath(item.targetRelative), item]));
  const ownerByTarget = new Map();
  for (const file of scriptFiles) ownerByTarget.set(normalizePath(file), 'runtime-script');
  for (const file of schemaFiles) ownerByTarget.set(normalizePath(file), 'runtime-schema');
  for (const group of Array.isArray(aiToolGroups) ? aiToolGroups : []) {
    if (!group || typeof group.key !== 'string') continue;
    for (const file of Array.isArray(group.files) ? group.files : []) {
      ownerByTarget.set(normalizePath(file), `ai-tool:${group.key}`);
    }
  }
  const records = [];
  for (const [managedPath, owner] of [...ownerByTarget.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const item = itemByTarget.get(managedPath);
    if (!item) throw new Error(`managed file is missing from the write plan: ${managedPath}`);
    records.push({
      path: managedPath,
      owner,
      sha256: sha256Value(plannedItemContent(item)),
    });
  }
  return records;
}

function scaffoldManagedPaths(manifest) {
  const externalHarnessFiles = new Set(uniqueNormalizedList(manifest?.externalHarnessFiles));
  const ownedToolFiles = uniqueNormalizedList(manifest?.toolFiles)
    .filter((managedPath) => !externalHarnessFiles.has(managedPath));
  return uniqueNormalizedList(manifest?.scriptFiles, manifest?.schemaFiles, manifest?.aiToolFiles, ownedToolFiles);
}

function plannedManifestFromPlan(plan) {
  const item = plan.find((entry) => isManifestTarget(entry.targetRelative));
  if (!item) return {};
  if (item.data) return item.data;
  if (typeof item.content === 'string') return JSON.parse(item.content);
  return {};
}

function safeManagedScaffoldTarget(targetRelative) {
  const normalized = normalizePath(targetRelative);
  if (!normalized || path.isAbsolute(normalized)) return false;
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return false;
  return isAutoUpgradableTarget(normalized);
}

function pushRetiredScaffoldFileCandidates(plan, targetRoot, existingManifest, args) {
  const desiredManifest = plannedManifestFromPlan(plan);
  const desiredPaths = new Set(scaffoldManagedPaths(desiredManifest));
  const managedRecordByPath = new Map(
    normalizeManagedFileRecords(existingManifest.managedFiles).map((record) => [record.path, record]),
  );
  const retiredPaths = scaffoldManagedPaths(existingManifest)
    .filter((managedPath) => !desiredPaths.has(managedPath))
    .sort((left, right) => left.localeCompare(right));
  for (const targetRelative of retiredPaths) {
    const safeTarget = safeManagedScaffoldTarget(targetRelative);
    plan.push({
      type: 'delete-file',
      targetRelative,
      target: safeTarget ? targetPath(targetRoot, targetRelative) : targetRoot,
      sourceLabel: '(manifest)',
      retired: true,
      safeTarget,
      installedSha256: managedRecordByPath.get(targetRelative)?.sha256 ?? null,
      pruneRequested: args.prune === true,
    });
  }
}

function pushArtifactIfExists(plan, source, targetRoot, targetRelative, options = {}) {
  if (!existsSync(source)) return false;
  assertFile(source, targetRelative);
  pushArtifact(plan, source, targetRoot, targetRelative, options);
  return true;
}

function maintenanceTaskGraphSourcePath(artifactsRoot) {
  return path.join(artifactsRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
}

function pushFeatureRadarPreflightIfExists(plan, artifactsRoot, targetRoot, projectId) {
  const sourceDir = path.join(artifactsRoot, FEATURE_RADAR_PREFLIGHT_DIR);
  if (!existsSync(sourceDir) || !lstatSync(sourceDir).isDirectory()) return [];
  const copied = [];
  for (const fileName of FEATURE_RADAR_COPY_FILES) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!existsSync(sourcePath)) continue;
    assertFile(sourcePath, path.join(FEATURE_RADAR_PREFLIGHT_DIR, fileName));
    const targetRelative = path.join(targetArtifactDir(projectId), FEATURE_RADAR_PREFLIGHT_DIR, fileName);
    pushArtifact(plan, sourcePath, targetRoot, targetRelative);
    copied.push(normalizePath(targetRelative));
  }
  return copied;
}

function resolveVisualBundleReference(reference, sourcePath, artifactsRoot, label) {
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(path.dirname(sourcePath), reference),
        path.resolve(artifactsRoot, reference),
      ];
  const resolved = candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
  if (!resolved) throw new ValidationError(`${label} cannot be resolved: ${JSON.stringify(reference)}`);
  const realRoot = realpathSync(artifactsRoot);
  const realResolved = realpathSync(resolved);
  const relative = path.relative(realRoot, realResolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError(`${label} resolves outside the artifact root`);
  }
  return resolved;
}

function pushVisualExperienceBundleIfExists(plan, specPath, artifactsRoot, targetRoot, projectId) {
  const spec = loadJson(specPath);
  const reference = spec.visual_experience?.experience_spec_ref;
  if (!reference) return [];
  const experiencePath = resolveVisualBundleReference(
    reference,
    specPath,
    artifactsRoot,
    'visual experience reference',
  );
  const sourceGateB = path.dirname(specPath);
  const files = new Set([experiencePath]);
  const experience = loadJson(experiencePath);
  for (const candidate of experience.visual_direction?.candidates ?? []) {
    const manifestPath = resolveVisualBundleReference(
      candidate.prototype_manifest_ref,
      experiencePath,
      artifactsRoot,
      `${candidate.id} prototype manifest`,
    );
    files.add(manifestPath);
    const manifest = loadJson(manifestPath);
    for (const entry of manifest.files ?? []) {
      const filePath = path.resolve(path.dirname(manifestPath), entry.path);
      assertFile(filePath, `${candidate.id} prototype file ${entry.path}`);
      files.add(filePath);
    }
  }
  const copied = [];
  for (const sourcePath of [...files].sort()) {
    const relative = path.relative(sourceGateB, sourcePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ValidationError(`visual experience artifact must stay under gate-b-spec: ${sourcePath}`);
    }
    const targetRelative = path.join(targetArtifactDir(projectId), 'gate-b-spec', relative);
    pushArtifact(plan, sourcePath, targetRoot, targetRelative);
    copied.push(normalizePath(targetRelative));
  }
  return copied;
}

class NonPortableArtifactReferenceError extends ValidationError {}

function resolveMilestoneBundleReference(artifactsRoot, reference, label, baseDir = artifactsRoot) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new ValidationError(`${label} must be a non-empty path inside the artifact root`);
  }
  const sourcePath = path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(baseDir, reference);
  assertFile(sourcePath, label);
  const relativePath = path.relative(realpathSync(artifactsRoot), realpathSync(sourcePath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new NonPortableArtifactReferenceError(
      `${label} resolves outside the artifact root: ${JSON.stringify(reference)}`,
    );
  }
  return { sourcePath, relativePath: normalizePath(relativePath) };
}

function portableVisualEvidenceTarget(reference, label) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new ValidationError(`${label} must be a non-empty relative path`);
  }
  const normalized = normalizePath(reference.trim()).replace(/^\.\//, '');
  if (
    path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').includes('..')
  ) {
    throw new ValidationError(`${label} must stay inside the artifact root`);
  }
  return normalized;
}

function projectRelativeBundleCandidate(baseDir, reference) {
  if (
    !reference.startsWith('.plan2agent/')
    && !reference.startsWith(`.plan2agent${path.sep}`)
  ) {
    return null;
  }
  let current = path.resolve(baseDir);
  while (true) {
    const p2aDir = path.join(current, '.plan2agent');
    if (existsSync(p2aDir) && lstatSync(p2aDir).isDirectory()) {
      return path.resolve(current, reference);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveSpecSourceIntakeBundleReference(
  artifactsRoot,
  reference,
  label,
  specDir,
) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new ValidationError(`${label} must be a non-empty path`);
  }
  const root = path.resolve(artifactsRoot);
  const candidates = path.isAbsolute(reference)
    ? [path.resolve(reference)]
    : [
        path.resolve(specDir, reference),
        path.resolve(root, reference),
        projectRelativeBundleCandidate(specDir, reference),
      ].filter(Boolean);
  const seen = new Set();
  let foundExternalReference = false;
  for (const sourcePath of candidates) {
    const normalizedSource = path.resolve(sourcePath);
    if (seen.has(normalizedSource)) continue;
    seen.add(normalizedSource);
    if (!existsSync(normalizedSource) || !lstatSync(normalizedSource).isFile()) continue;
    const relativePath = path.relative(root, normalizedSource);
    if (
      !relativePath
      || relativePath.startsWith('..')
      || path.isAbsolute(relativePath)
    ) {
      foundExternalReference = true;
      continue;
    }
    const realRelativePath = path.relative(realpathSync(root), realpathSync(normalizedSource));
    if (
      !realRelativePath
      || realRelativePath.startsWith('..')
      || path.isAbsolute(realRelativePath)
    ) {
      foundExternalReference = true;
      continue;
    }
    return {
      sourcePath: normalizedSource,
      relativePath: normalizePath(realRelativePath),
    };
  }
  if (foundExternalReference) {
    throw new NonPortableArtifactReferenceError(
      `${label} resolves outside the artifact root: ${JSON.stringify(reference)}`,
    );
  }
  throw new ValidationError(
    `${label} cannot be resolved inside the artifact root: ${JSON.stringify(reference)}`,
  );
}

function appendCurrentSpecSourceReferences(
  references,
  currentSpec,
  sourceArtifactRoot,
  label,
) {
  for (const [sourceIndex, sourceSpec] of (currentSpec.source_specs ?? []).entries()) {
    assertSafeIterationId(sourceSpec.iteration_id);
    references.push({
      label: `${label}.source_specs[${sourceIndex}].spec_ref`,
      reference: sourceSpec.spec_ref,
      baseDir: sourceArtifactRoot,
    });
    references.push({
      label: `${label}.source_specs[${sourceIndex}] task graph`,
      reference: normalizePath(path.join(
        'iterations',
        sourceSpec.iteration_id,
        'gate-c-task-graph',
        'task-graph.json',
      )),
      baseDir: sourceArtifactRoot,
    });
    const metadataRef = normalizePath(path.join(
      'iterations',
      sourceSpec.iteration_id,
      'iteration.json',
    ));
    const metadataPath = path.join(sourceArtifactRoot, metadataRef);
    if (existsSync(metadataPath) && lstatSync(metadataPath).isFile()) {
      references.push({
        label: `${label}.source_specs[${sourceIndex}] iteration metadata`,
        reference: metadataRef,
        baseDir: sourceArtifactRoot,
      });
    }
  }
  for (const [closedIndex, closed] of (currentSpec.closed_iterations ?? []).entries()) {
    for (const [reference, audit] of Object.entries(closed?.artifact_hashes ?? {})) {
      if (typeof audit !== 'string' && audit?.present !== true) continue;
      references.push({
        label: `${label}.closed_iterations[${closedIndex}].artifact_hashes[${JSON.stringify(reference)}]`,
        reference,
        baseDir: sourceArtifactRoot,
        inspectJson: false,
      });
    }
  }
}

function inferBundleArtifactRootFromIntakePath(intakePath, fallbackRoot) {
  const resolvedIntakePath = path.resolve(intakePath);
  const gateADir = path.dirname(resolvedIntakePath);
  if (path.basename(gateADir) === 'gate-a-intake') {
    const gateContainer = path.dirname(gateADir);
    const gateContainerParent = path.dirname(gateContainer);
    return path.basename(gateContainerParent) === 'iterations'
      ? path.dirname(gateContainerParent)
      : gateContainer;
  }
  let current = path.dirname(resolvedIntakePath);
  const outerRoot = path.resolve(fallbackRoot);
  while (pathIsAtOrUnder(current, outerRoot)) {
    const currentSpecPath = path.join(current, 'current-spec.json');
    if (existsSync(currentSpecPath) && lstatSync(currentSpecPath).isFile()) return current;
    if (current === outerRoot) break;
    current = path.dirname(current);
  }
  return outerRoot;
}

function resolvePortableArtifactReferenceBundle(references, artifactsRoot) {
  const pendingReferences = [...references];
  const resolvedFiles = [];
  const copiedSources = new Map();
  const inspectedJsonSources = new Set();
  for (let index = 0; index < pendingReferences.length; index += 1) {
    const {
      label,
      reference,
      baseDir,
      referenceKind = 'artifact-root',
      inspectJson = true,
      sourceArtifactRoot = artifactsRoot,
      targetRelativePath = null,
    } = pendingReferences[index];
    const resolved = referenceKind === 'spec-source-intake'
      ? resolveSpecSourceIntakeBundleReference(
          artifactsRoot,
          reference,
          label,
          baseDir,
        )
      : resolveMilestoneBundleReference(
          artifactsRoot,
          reference,
          label,
          baseDir,
        );
    const sourceRealPath = realpathSync(resolved.sourcePath);
    const portableRelativePath = normalizePath(targetRelativePath ?? resolved.relativePath);
    const existingSource = copiedSources.get(sourceRealPath);
    if (existingSource && existingSource.relativePath !== portableRelativePath) {
      throw new ValidationError(
        `${label} requires conflicting portable target paths for the same artifact: ${existingSource.relativePath} and ${portableRelativePath}`,
      );
    }
    if (existingSource && inspectJson) existingSource.inspectJson = true;
    const resolvedFile = existingSource ?? {
      ...resolved,
      relativePath: portableRelativePath,
      label,
      inspectJson,
    };
    if (!existingSource) {
      copiedSources.set(sourceRealPath, resolvedFile);
      resolvedFiles.push(resolvedFile);
    }

    if (!inspectJson || inspectedJsonSources.has(sourceRealPath)) continue;
    inspectedJsonSources.add(sourceRealPath);
    const sourceData = loadJson(resolved.sourcePath);
    if (
      sourceData.schema_version === 'p2a.spec.v1'
      && typeof sourceData.source_intake === 'string'
      && sourceData.source_intake.trim()
    ) {
      pendingReferences.push({
        label: `${label}.source_intake`,
        reference: sourceData.source_intake,
        baseDir: path.dirname(resolved.sourcePath),
        referenceKind: 'spec-source-intake',
      });
    }
    if (
      sourceData.schema_version === 'p2a.spec.v1'
      && typeof sourceData.visual_experience?.experience_spec_ref === 'string'
      && sourceData.visual_experience.experience_spec_ref.trim()
    ) {
      pendingReferences.push({
        label: `${label}.visual_experience.experience_spec_ref`,
        reference: sourceData.visual_experience.experience_spec_ref,
        baseDir: path.dirname(resolved.sourcePath),
        targetRelativePath: portableVisualChildPath(
          resolvedFile.relativePath,
          sourceData.visual_experience.experience_spec_ref,
          `${label}.visual_experience.experience_spec_ref`,
        ),
      });
    }
    if (sourceData.schema_version === 'p2a.visual_experience.v1') {
      pendingReferences.push(
        {
          label: `${label}.source_spec_ref`,
          reference: sourceData.source_spec_ref,
          baseDir: path.dirname(resolved.sourcePath),
          targetRelativePath: portableVisualChildPath(
            resolvedFile.relativePath,
            sourceData.source_spec_ref,
            `${label}.source_spec_ref`,
          ),
        },
        ...(sourceData.visual_direction?.candidates ?? []).map((candidate, candidateIndex) => ({
          label: `${label}.visual_direction.candidates[${candidateIndex}].prototype_manifest_ref`,
          reference: candidate.prototype_manifest_ref,
          baseDir: path.dirname(resolved.sourcePath),
          targetRelativePath: portableVisualChildPath(
            resolvedFile.relativePath,
            candidate.prototype_manifest_ref,
            `${label}.visual_direction.candidates[${candidateIndex}].prototype_manifest_ref`,
          ),
        })),
      );
    }
    if (sourceData.schema_version === 'p2a.visual_prototype.v1') {
      pendingReferences.push(
        {
          label: `${label}.experience_spec_ref`,
          reference: sourceData.experience_spec_ref,
          baseDir: path.dirname(resolved.sourcePath),
          targetRelativePath: portableVisualChildPath(
            resolvedFile.relativePath,
            sourceData.experience_spec_ref,
            `${label}.experience_spec_ref`,
          ),
        },
        ...(sourceData.files ?? []).map((entry, fileIndex) => ({
          label: `${label}.files[${fileIndex}].path`,
          reference: entry.path,
          baseDir: path.dirname(resolved.sourcePath),
          inspectJson: false,
          targetRelativePath: portableVisualChildPath(
            resolvedFile.relativePath,
            entry.path,
            `${label}.files[${fileIndex}].path`,
          ),
        })),
      );
    }
    if (
      sourceData.schema_version === 'p2a.current_spec.v1'
      && Array.isArray(sourceData.source_specs)
    ) {
      appendCurrentSpecSourceReferences(
        pendingReferences,
        sourceData,
        sourceArtifactRoot,
        label,
      );
    }
    if (sourceData.schema_version === 'p2a.intake.v1' && sourceData.baseline_context) {
      const sourceArtifactRoot = inferBundleArtifactRootFromIntakePath(
        resolved.sourcePath,
        artifactsRoot,
      );
      pendingReferences.push(
        {
          label: `${label}.baseline_context.spec_ref`,
          reference: sourceData.baseline_context.spec_ref,
          baseDir: sourceArtifactRoot,
          sourceArtifactRoot,
        },
        ...(sourceData.baseline_context.reused_answers ?? []).map((item, answerIndex) => ({
          label: `${label}.baseline_context.reused_answers[${answerIndex}].source_intake`,
          reference: item.source_intake,
          baseDir: sourceArtifactRoot,
          sourceArtifactRoot,
        })),
        ...(sourceData.baseline_context.reused_question_dispositions ?? [])
          .map((item, dispositionIndex) => ({
            label: `${label}.baseline_context.reused_question_dispositions[${dispositionIndex}].source_spec`,
            reference: item.source_spec,
            baseDir: sourceArtifactRoot,
            sourceArtifactRoot,
          })),
      );
    }
  }
  return resolvedFiles;
}

function portableBundleRelativeReference(sourceRelativePath, targetRelativePath) {
  const reference = path.posix.relative(
    path.posix.dirname(normalizePath(sourceRelativePath)),
    normalizePath(targetRelativePath),
  );
  return reference || path.posix.basename(normalizePath(targetRelativePath));
}

function portableVisualChildPath(parentRelativePath, reference, label) {
  if (
    typeof reference !== 'string'
    || !reference.trim()
    || path.isAbsolute(reference)
    || path.win32.isAbsolute(reference)
  ) {
    throw new ValidationError(`${label} must be a non-empty relative visual artifact path`);
  }
  const targetRelativePath = path.posix.normalize(path.posix.join(
    path.posix.dirname(normalizePath(parentRelativePath)),
    normalizePath(reference),
  ));
  if (
    !targetRelativePath
    || targetRelativePath === '..'
    || targetRelativePath.startsWith('../')
    || path.posix.isAbsolute(targetRelativePath)
  ) {
    throw new ValidationError(`${label} escapes the portable artifact root`);
  }
  return targetRelativePath;
}

function portableBundleRootRelative(sourceRoot, artifactsRoot) {
  const relative = path.relative(realpathSync(artifactsRoot), realpathSync(sourceRoot));
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new NonPortableArtifactReferenceError(
      `portable artifact dependency root resolves outside the artifact root: ${sourceRoot}`,
    );
  }
  return normalizePath(relative);
}

function portableBundleArtifactReference(rootRelativePath, targetRelativePath) {
  const reference = path.posix.relative(
    rootRelativePath || '.',
    normalizePath(targetRelativePath),
  );
  if (!reference || reference.startsWith('../') || path.posix.isAbsolute(reference)) {
    throw new ValidationError(
      `portable artifact dependency escapes its source artifact root: ${targetRelativePath}`,
    );
  }
  return reference;
}

function portableArtifactBundleContents(
  resolvedFiles,
  artifactsRoot,
  projectId,
  existingPlan = [],
) {
  const filesByRealPath = new Map(
    resolvedFiles.map((file) => [realpathSync(file.sourcePath), file]),
  );
  const plannedByTarget = new Map(
    existingPlan.map((item) => [normalizePath(item.targetRelative), item]),
  );
  const contentsByRealPath = new Map();
  const resolving = new Set();

  function recordForResolvedReference(resolved, label) {
    const record = filesByRealPath.get(realpathSync(resolved.sourcePath));
    if (!record) {
      throw new ValidationError(`${label} is missing from its portable dependency closure`);
    }
    return record;
  }

  function artifactRootForIntake(intakeRecord) {
    return inferBundleArtifactRootFromIntakePath(intakeRecord.sourcePath, artifactsRoot);
  }

  function artifactRootReference(sourceRoot, targetRecord) {
    return portableBundleArtifactReference(
      portableBundleRootRelative(sourceRoot, artifactsRoot),
      targetRecord.relativePath,
    );
  }

  function resolveKnownApprovalArtifact(reference, sourceRecord, sourceRoot) {
    if (typeof reference !== 'string' || !reference.trim()) return null;
    const candidates = path.isAbsolute(reference)
      ? [reference]
      : [
          path.resolve(path.dirname(sourceRecord.sourcePath), reference),
          path.resolve(sourceRoot, reference),
          projectRelativeBundleCandidate(path.dirname(sourceRecord.sourcePath), reference),
        ].filter(Boolean);
    for (const candidate of candidates) {
      if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
      const targetRecord = filesByRealPath.get(realpathSync(candidate));
      if (targetRecord) return targetRecord;
    }
    return null;
  }

  function rebaseKnownApprovalArtifacts(
    data,
    sourceRecord,
    sourceRoot,
    referenceStyle = 'artifact-root',
  ) {
    if (!Array.isArray(data.approval_audit?.approved_artifacts)) return;
    data.approval_audit.approved_artifacts = data.approval_audit.approved_artifacts.map(
      (reference) => {
        const targetRecord = resolveKnownApprovalArtifact(
          reference,
          sourceRecord,
          sourceRoot,
        );
        if (!targetRecord) return reference;
        return data.schema_version === 'p2a.spec.v1' || referenceStyle === 'relative'
          ? portableBundleRelativeReference(sourceRecord.relativePath, targetRecord.relativePath)
          : artifactRootReference(sourceRoot, targetRecord);
      },
    );
  }

  function portableContent(record) {
    const sourceRealPath = realpathSync(record.sourcePath);
    if (contentsByRealPath.has(sourceRealPath)) return contentsByRealPath.get(sourceRealPath);
    const targetRelative = normalizePath(path.join(
      targetArtifactDir(projectId),
      record.relativePath,
    ));
    const existing = plannedByTarget.get(targetRelative);
    if (existing && existing.type !== 'copy') {
      const content = plannedItemContent(existing);
      contentsByRealPath.set(sourceRealPath, content);
      return content;
    }
    const rawContent = readFileSync(record.sourcePath);
    if (record.inspectJson === false || path.extname(record.sourcePath) !== '.json') {
      contentsByRealPath.set(sourceRealPath, rawContent);
      return rawContent;
    }
    if (resolving.has(sourceRealPath)) {
      throw new ValidationError(
        `portable artifact dependency closure contains a rewrite cycle through ${record.relativePath}`,
      );
    }
    resolving.add(sourceRealPath);
    try {
      const sourceData = loadJson(record.sourcePath);
      const portableData = structuredClone(sourceData);
      if (
        portableData.schema_version === 'p2a.spec.v1'
        && typeof portableData.source_intake === 'string'
        && portableData.source_intake.trim()
      ) {
        const intakeRecord = recordForResolvedReference(
          resolveSpecSourceIntakeBundleReference(
            artifactsRoot,
            portableData.source_intake,
            `${record.label}.source_intake`,
            path.dirname(record.sourcePath),
          ),
          `${record.label}.source_intake`,
        );
        portableData.source_intake = portableBundleRelativeReference(
          record.relativePath,
          intakeRecord.relativePath,
        );
        if (portableData.source_intake_sha256) {
          portableData.source_intake_sha256 = sha256Value(portableContent(intakeRecord));
        }
        rebaseKnownApprovalArtifacts(
          portableData,
          record,
          artifactRootForIntake(intakeRecord),
        );
      }
      if (
        portableData.schema_version === 'p2a.spec.v1'
        && typeof portableData.visual_experience?.experience_spec_ref === 'string'
        && portableData.visual_experience.experience_spec_ref.trim()
      ) {
        const experienceRecord = recordForResolvedReference(
          resolveMilestoneBundleReference(
            artifactsRoot,
            portableData.visual_experience.experience_spec_ref,
            `${record.label}.visual_experience.experience_spec_ref`,
            path.dirname(record.sourcePath),
          ),
          `${record.label}.visual_experience.experience_spec_ref`,
        );
        portableData.visual_experience.experience_spec_ref = portableBundleRelativeReference(
          record.relativePath,
          experienceRecord.relativePath,
        );
        if (portableData.visual_experience.experience_spec_sha256) {
          portableData.visual_experience.experience_spec_sha256 = sha256Value(
            portableContent(experienceRecord),
          );
        }
      }
      if (portableData.schema_version === 'p2a.visual_experience.v1') {
        const sourceSpecRecord = recordForResolvedReference(
          resolveMilestoneBundleReference(
            artifactsRoot,
            portableData.source_spec_ref,
            `${record.label}.source_spec_ref`,
            path.dirname(record.sourcePath),
          ),
          `${record.label}.source_spec_ref`,
        );
        portableData.source_spec_ref = portableBundleRelativeReference(
          record.relativePath,
          sourceSpecRecord.relativePath,
        );
        for (const [candidateIndex, candidate] of (
          portableData.visual_direction?.candidates ?? []
        ).entries()) {
          const manifestRecord = recordForResolvedReference(
            resolveMilestoneBundleReference(
              artifactsRoot,
              candidate.prototype_manifest_ref,
              `${record.label}.visual_direction.candidates[${candidateIndex}].prototype_manifest_ref`,
              path.dirname(record.sourcePath),
            ),
            `${record.label}.visual_direction.candidates[${candidateIndex}].prototype_manifest_ref`,
          );
          candidate.prototype_manifest_ref = portableBundleRelativeReference(
            record.relativePath,
            manifestRecord.relativePath,
          );
          candidate.prototype_manifest_sha256 = sha256Value(portableContent(manifestRecord));
        }
        rebaseKnownApprovalArtifacts(portableData, record, artifactsRoot, 'relative');
      }
      if (portableData.schema_version === 'p2a.visual_prototype.v1') {
        const experienceRecord = recordForResolvedReference(
          resolveMilestoneBundleReference(
            artifactsRoot,
            portableData.experience_spec_ref,
            `${record.label}.experience_spec_ref`,
            path.dirname(record.sourcePath),
          ),
          `${record.label}.experience_spec_ref`,
        );
        portableData.experience_spec_ref = portableBundleRelativeReference(
          record.relativePath,
          experienceRecord.relativePath,
        );
        for (const [fileIndex, entry] of portableData.files.entries()) {
          const fileRecord = recordForResolvedReference(
            resolveMilestoneBundleReference(
              artifactsRoot,
              entry.path,
              `${record.label}.files[${fileIndex}].path`,
              path.dirname(record.sourcePath),
            ),
            `${record.label}.files[${fileIndex}].path`,
          );
          entry.path = portableBundleRelativeReference(
            record.relativePath,
            fileRecord.relativePath,
          );
          entry.sha256 = sha256Value(portableContent(fileRecord));
        }
        rebaseKnownApprovalArtifacts(portableData, record, artifactsRoot, 'relative');
      }
      if (portableData.schema_version === 'p2a.intake.v1') {
        const sourceRoot = artifactRootForIntake(record);
        const baselineContext = portableData.baseline_context;
        if (baselineContext) {
          const baselineSpecRecord = recordForResolvedReference(
            resolveMilestoneBundleReference(
              artifactsRoot,
              baselineContext.spec_ref,
              `${record.label}.baseline_context.spec_ref`,
              sourceRoot,
            ),
            `${record.label}.baseline_context.spec_ref`,
          );
          baselineContext.spec_ref = artifactRootReference(sourceRoot, baselineSpecRecord);
          if (baselineContext.spec_sha256) {
            baselineContext.spec_sha256 = sha256Value(portableContent(baselineSpecRecord));
          }
          for (const [answerIndex, answer] of baselineContext.reused_answers.entries()) {
            const sourceIntakeRecord = recordForResolvedReference(
              resolveMilestoneBundleReference(
                artifactsRoot,
                answer.source_intake,
                `${record.label}.baseline_context.reused_answers[${answerIndex}].source_intake`,
                sourceRoot,
              ),
              `${record.label}.baseline_context.reused_answers[${answerIndex}].source_intake`,
            );
            answer.source_intake = artifactRootReference(sourceRoot, sourceIntakeRecord);
          }
          const dispositions = baselineContext.reused_question_dispositions;
          for (const [dispositionIndex, disposition] of dispositions.entries()) {
            const sourceSpecRecord = recordForResolvedReference(
              resolveMilestoneBundleReference(
                artifactsRoot,
                disposition.source_spec,
                `${record.label}.baseline_context.reused_question_dispositions[${dispositionIndex}].source_spec`,
                sourceRoot,
              ),
              `${record.label}.baseline_context.reused_question_dispositions[${dispositionIndex}].source_spec`,
            );
            disposition.source_spec = artifactRootReference(sourceRoot, sourceSpecRecord);
          }
        }
        rebaseKnownApprovalArtifacts(portableData, record, sourceRoot);
      }
      const dataChanged = JSON.stringify(portableData) !== JSON.stringify(sourceData);
      const content = dataChanged
        ? `${JSON.stringify(portableData, null, 2)}\n`
        : rawContent;
      contentsByRealPath.set(sourceRealPath, content);
      return content;
    } finally {
      resolving.delete(sourceRealPath);
    }
  }

  for (const file of resolvedFiles) portableContent(file);
  return contentsByRealPath;
}

function pushPortableArtifactReferenceBundle(
  plan,
  references,
  artifactsRoot,
  targetRoot,
  projectId,
) {
  const plannedByTarget = new Map(
    plan.map((item) => [normalizePath(item.targetRelative), item]),
  );
  const resolvedFiles = resolvePortableArtifactReferenceBundle(references, artifactsRoot);
  const portableContents = portableArtifactBundleContents(
    resolvedFiles,
    artifactsRoot,
    projectId,
    plan,
  );
  for (const resolved of resolvedFiles) {
    const targetRelative = normalizePath(path.join(
      targetArtifactDir(projectId),
      resolved.relativePath,
    ));
    const portableContent = portableContents.get(realpathSync(resolved.sourcePath));
    const rewritesSource = !sameFileContent(
      readFileSync(resolved.sourcePath),
      portableContent,
    );
    const existing = plannedByTarget.get(targetRelative);
    if (existing) {
      if (
        !existing.source
        || realpathSync(existing.source) !== realpathSync(resolved.sourcePath)
      ) {
        throw new ValidationError(
          `${resolved.label} target collides with a different planned artifact: ${targetRelative}`,
        );
      }
      if (rewritesSource) {
        if (existing.type === 'copy') {
          existing.type = 'rewrite-json';
          existing.transform = () => portableContent;
        } else if (!sameFileContent(plannedItemContent(existing), portableContent)) {
          throw new ValidationError(
            `${resolved.label} target requires conflicting portable rewrites: ${targetRelative}`,
          );
        }
      }
    } else {
      pushArtifact(
        plan,
        resolved.sourcePath,
        targetRoot,
        targetRelative,
        rewritesSource
          ? { type: 'rewrite-json', transform: () => portableContent }
          : {},
      );
      plannedByTarget.set(targetRelative, plan.at(-1));
    }
  }
}

function pushIntakeBaselineContextBundleIfPresent(
  plan,
  intakePath,
  artifactsRoot,
  targetRoot,
  projectId,
) {
  const intake = loadJson(intakePath);
  const baselineContext = intake.baseline_context;
  if (!baselineContext) return;

  pushPortableArtifactReferenceBundle(
    plan,
    [
      {
        label: 'baseline_context.spec_ref',
        reference: baselineContext.spec_ref,
        baseDir: artifactsRoot,
      },
      ...(baselineContext.reused_answers ?? []).map((item, index) => ({
        label: `baseline_context.reused_answers[${index}].source_intake`,
        reference: item.source_intake,
        baseDir: artifactsRoot,
      })),
      ...(baselineContext.reused_question_dispositions ?? []).map((item, index) => ({
        label: `baseline_context.reused_question_dispositions[${index}].source_spec`,
        reference: item.source_spec,
        baseDir: artifactsRoot,
      })),
    ],
    artifactsRoot,
    targetRoot,
    projectId,
  );
}

function pushCurrentSpecCompositionBundleIfPresent(
  plan,
  currentSpec,
  artifactsRoot,
  targetRoot,
  projectId,
) {
  if (!Array.isArray(currentSpec?.source_specs) || !currentSpec.source_specs.length) {
    return;
  }
  const references = [];
  appendCurrentSpecSourceReferences(
    references,
    currentSpec,
    artifactsRoot,
    'current-spec.json',
  );
  pushPortableArtifactReferenceBundle(
    plan,
    references,
    artifactsRoot,
    targetRoot,
    projectId,
  );
}

function currentSpecWithPortableClosedArtifactHashes(currentSpec, plan, projectId) {
  if (!currentSpec || !Array.isArray(currentSpec.closed_iterations)) return currentSpec;
  const next = structuredClone(currentSpec);
  const artifactTargetRoot = normalizePath(targetArtifactDir(projectId));
  const plannedByTarget = new Map(
    plan.map((item) => [normalizePath(item.targetRelative), item]),
  );

  for (const closed of next.closed_iterations) {
    for (const [reference, audit] of Object.entries(closed?.artifact_hashes ?? {})) {
      if (typeof audit !== 'string' && audit?.present !== true) continue;
      const targetRelative = normalizePath(path.posix.join(
        artifactTargetRoot,
        normalizePath(reference),
      ));
      const planned = plannedByTarget.get(targetRelative);
      if (!planned) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact is missing from the portable handoff plan: ${reference}`,
        );
      }
      const portableSha256 = sha256Value(plannedItemContent(planned));
      closed.artifact_hashes[reference] = typeof audit === 'string'
        ? portableSha256
        : { ...audit, sha256: portableSha256 };
    }
  }

  if (next.last_closed_iteration?.iteration_id) {
    const matchingClosed = next.closed_iterations.find(
      (closed) => closed.iteration_id === next.last_closed_iteration.iteration_id,
    );
    if (matchingClosed) {
      next.last_closed_iteration = {
        ...next.last_closed_iteration,
        artifact_hashes: structuredClone(matchingClosed.artifact_hashes),
      };
    }
  }
  return next;
}

function pushMilestoneReviewBundleIfExists(
  plan,
  artifactsRoot,
  targetRoot,
  projectId,
  iterationId,
  runTransfer = 'completed',
) {
  if (!iterationId) return { reviewFiles: [], evidenceFiles: [] };
  const reviewFiles = [];
  const evidenceFiles = [];
  const availableReviews = MILESTONE_REVIEW_CHECKPOINTS.flatMap((checkpoint) => {
    const sourcePath = path.join(
      artifactsRoot,
      'iterations',
      iterationId,
      'milestone-reviews',
      `${checkpoint}.json`,
    );
    if (!existsSync(sourcePath)) return [];
    assertFile(sourcePath, path.join('iterations', iterationId, 'milestone-reviews', `${checkpoint}.json`));
    return [{ checkpoint, sourcePath, milestoneReview: validateMilestoneReview(sourcePath) }];
  });
  const requiredCompletedRunIds = completedEvidenceRunIds(
    availableReviews.map(({ milestoneReview }) => milestoneReview),
  );
  const copiedTargets = new Set(plan.map((item) => normalizePath(item.targetRelative)));
  function pushBundleFile(sourcePath, artifactRelativePath, destinationList, options = {}) {
    const targetRelative = normalizePath(path.join(targetArtifactDir(projectId), artifactRelativePath));
    if (!copiedTargets.has(targetRelative)) {
      pushArtifact(plan, sourcePath, targetRoot, targetRelative, options);
      copiedTargets.add(targetRelative);
    } else if (options.type === 'rewrite-json') {
      const existing = plan.find(
        (item) => normalizePath(item.targetRelative) === targetRelative,
      );
      if (
        !existing?.source
        || realpathSync(existing.source) !== realpathSync(sourcePath)
      ) {
        throw new ValidationError(
          `milestone bundle target collides with a different planned artifact: ${targetRelative}`,
        );
      }
      if (existing.type === 'copy') {
        existing.type = 'rewrite-json';
        existing.transform = options.transform;
      } else if (
        existing.type !== 'rewrite-json'
        || existing.transform(existing.source) !== options.transform(sourcePath)
      ) {
        throw new ValidationError(
          `milestone bundle target requires conflicting rewrites: ${targetRelative}`,
        );
      }
    }
    if (!destinationList.includes(targetRelative)) destinationList.push(targetRelative);
  }

  function resolveRunSourceBundle(runData, checkpoint, indexedRun) {
    const taskGraphLabel = `${checkpoint} run-index ${indexedRun.runId} task graph`;
    const runTaskGraph = resolveMilestoneBundleReference(
      artifactsRoot,
      runData.taskGraphRef,
      taskGraphLabel,
    );
    const files = [{ ...runTaskGraph, label: taskGraphLabel }];
    const runTaskGraphData = loadJson(runTaskGraph.sourcePath);

    const requiresSourceArtifact = (
      runData.schema_version === 'p2a.run.v2'
      || runData.visualReview?.required
      || runData.status !== 'finished'
      || path.isAbsolute(runData.sourceSpecRef)
      || path.isAbsolute(runTaskGraphData.sourceSpec)
    );
    if (!requiresSourceArtifact) {
      return { runTaskGraph, files, portableSourceSpecRef: null };
    }

    const sourceSpecLabel = `${checkpoint} run-index ${indexedRun.runId} source spec`;
    const sourceFiles = resolvePortableArtifactReferenceBundle([{
      label: sourceSpecLabel,
      reference: runData.sourceSpecRef,
      baseDir: path.dirname(runTaskGraph.sourcePath),
      referenceKind: path.isAbsolute(runData.sourceSpecRef)
        ? 'artifact-root'
        : 'spec-source-intake',
    }], artifactsRoot);
    const runSourceSpec = sourceFiles[0];
    const canonicalSourceSpecRef = path.posix.relative(
      path.posix.dirname(runTaskGraph.relativePath),
      runSourceSpec.relativePath,
    );
    const currentRunSourceSpecRef = path.isAbsolute(runData.sourceSpecRef)
      ? null
      : normalizePath(runData.sourceSpecRef).replace(/^\.\//, '');
    const currentGraphSourceSpecRef = path.isAbsolute(runTaskGraphData.sourceSpec)
      ? null
      : normalizePath(runTaskGraphData.sourceSpec).replace(/^\.\//, '');
    const portableSourceSpecRef = (
      currentRunSourceSpecRef === canonicalSourceSpecRef
      && currentGraphSourceSpecRef === canonicalSourceSpecRef
    ) ? null : canonicalSourceSpecRef;
    const sourceRealPaths = new Set(files.map((file) => realpathSync(file.sourcePath)));
    for (const file of sourceFiles) {
      const sourceRealPath = realpathSync(file.sourcePath);
      if (sourceRealPaths.has(sourceRealPath)) continue;
      sourceRealPaths.add(sourceRealPath);
      files.push(file);
    }
    return { runTaskGraph, files, portableSourceSpecRef };
  }

  function portableTaskGraphText(source, portableSourceSpecRef) {
    const portableTaskGraph = loadJson(source);
    portableTaskGraph.sourceSpec = portableSourceSpecRef;
    return `${JSON.stringify(portableTaskGraph, null, 2)}\n`;
  }

  function portableRunData(
    runBundle,
    portableTaskGraphRef,
    portableSourceSpecRef = runBundle.sourceBundle.portableSourceSpecRef,
  ) {
    const portableRun = structuredClone(runBundle.runData);
    if (portableTaskGraphRef) portableRun.taskGraphRef = portableTaskGraphRef;
    if (portableSourceSpecRef) portableRun.sourceSpecRef = portableSourceSpecRef;
    return portableRun;
  }

  function portableRunText(runBundle, portableTaskGraphRef, portableSourceSpecRef) {
    return `${JSON.stringify(portableRunData(
      runBundle,
      portableTaskGraphRef,
      portableSourceSpecRef,
    ), null, 2)}\n`;
  }

  function pushRunSourceBundle(bundle, portableSourceSpecRef) {
    const portableContents = runTransfer === 'completed'
      ? null
      : portableArtifactBundleContents(
          bundle.files,
          artifactsRoot,
          projectId,
          plan,
        );
    for (const file of bundle.files) {
      const rewritesTaskGraph = (
        portableSourceSpecRef
        && realpathSync(file.sourcePath) === realpathSync(bundle.runTaskGraph.sourcePath)
      );
      const portableContent = rewritesTaskGraph
        ? portableTaskGraphText(file.sourcePath, portableSourceSpecRef)
        : (portableContents?.get(realpathSync(file.sourcePath)) ?? readFileSync(file.sourcePath));
      const rewritesSource = !sameFileContent(
        readFileSync(file.sourcePath),
        portableContent,
      );
      if (runTransfer === 'completed' && rewritesSource) {
        throw new ValidationError(
          `portable handoff requires canonical byte-copyable run provenance at ${file.relativePath}; ${portableProvenanceMigrationHint()}`,
        );
      }
      pushBundleFile(
        file.sourcePath,
        file.relativePath,
        evidenceFiles,
        rewritesSource
          ? {
              type: 'rewrite-json',
              transform: () => portableContent,
            }
          : {},
      );
    }
  }

  function resolvePortableRunBundle(runIndex, checkpoint, indexedRun) {
    if (!taskGraphIsPortable(indexedRun.taskGraphRef)) return null;
    const run = resolveMilestoneBundleReference(
      artifactsRoot,
      indexedRun.runRef,
      `${checkpoint} run-index ${indexedRun.runId}.runRef`,
      path.dirname(runIndex.sourcePath),
    );
    const runData = loadJson(run.sourcePath);
    if (runData.status === 'started' && runTransfer !== 'resumable') return null;
    try {
      if (runTransfer === 'completed') assertCanonicalPortableRun(runData);
      const sourceBundle = resolveRunSourceBundle(runData, checkpoint, indexedRun);
      if (runData.status === 'started' && (runData.visualReview?.required || runData.acceptanceReview?.required)) {
        const reviewLabel = runData.acceptanceReview?.required ? 'acceptance' : 'visual';
        throw new ValidationError(
          `handoff cannot port started ${reviewLabel} run ${indexedRun.runId}; finish or block the run before handoff`,
        );
      }
      return {
        indexedRun,
        run,
        runData,
        sourceBundle,
      };
    } catch (error) {
      if (error instanceof NonPortableArtifactReferenceError) return null;
      throw error;
    }
  }

  function taskGraphIsPortable(reference) {
    if (!path.isAbsolute(reference)) return true;
    const absoluteReference = path.resolve(reference);
    if (!existsSync(absoluteReference)) {
      return pathIsAtOrUnder(absoluteReference, path.resolve(artifactsRoot));
    }
    try {
      return pathIsAtOrUnder(realpathSync(absoluteReference), realpathSync(artifactsRoot));
    } catch {
      return false;
    }
  }

  function portableRunIndexText(source, portableRunIds, portableTaskGraphRefs) {
    const portableRunIndex = loadJson(source);
    portableRunIndex.runs = (portableRunIndex.runs ?? [])
      .filter((indexedRun) => portableRunIds.has(indexedRun.runId));
    for (const indexedRun of portableRunIndex.runs) {
      const portableRef = portableTaskGraphRefs.get(indexedRun.runId);
      if (portableRef) indexedRun.taskGraphRef = portableRef;
    }
    const taskEntries = [];
    const taskEntriesById = new Map();
    for (const indexedRun of portableRunIndex.runs) {
      if (!taskEntriesById.has(indexedRun.taskId)) {
        const taskEntry = { taskId: indexedRun.taskId, runIds: [], latestRunId: null };
        taskEntriesById.set(indexedRun.taskId, taskEntry);
        taskEntries.push(taskEntry);
      }
      const taskEntry = taskEntriesById.get(indexedRun.taskId);
      taskEntry.runIds.push(indexedRun.runId);
      taskEntry.latestRunId = indexedRun.runId;
    }
    portableRunIndex.tasks = taskEntries;
    return `${JSON.stringify(portableRunIndex, null, 2)}\n`;
  }

  for (const { checkpoint, sourcePath, milestoneReview } of availableReviews) {
    const reviewRelativePath = normalizePath(path.relative(artifactsRoot, sourcePath));
    pushBundleFile(sourcePath, reviewRelativePath, reviewFiles);

    const taskGraph = resolveMilestoneBundleReference(
      artifactsRoot,
      milestoneReview.source.task_graph_ref,
      `${checkpoint}.source.task_graph_ref`,
    );
    const spec = resolveMilestoneBundleReference(
      artifactsRoot,
      milestoneReview.source.spec_ref,
      `${checkpoint}.source.spec_ref`,
    );
    pushBundleFile(taskGraph.sourcePath, taskGraph.relativePath, evidenceFiles);
    pushBundleFile(spec.sourcePath, spec.relativePath, evidenceFiles);

    const specData = loadJson(spec.sourcePath);
    if (typeof specData.source_intake === 'string' && specData.source_intake.trim()) {
      const intake = resolveSpecSourceIntakeBundleReference(
        artifactsRoot,
        specData.source_intake,
        `${checkpoint}.source.spec_ref source_intake`,
        path.dirname(spec.sourcePath),
      );
      pushBundleFile(intake.sourcePath, intake.relativePath, evidenceFiles);
    }

    const runIndex = resolveMilestoneBundleReference(
      artifactsRoot,
      path.join('runs', 'run-index.json'),
      `${checkpoint} run index`,
    );
    const runIndexData = validateRunsDir(path.dirname(runIndex.sourcePath));
    const indexedRunRecords = runIndexData.runs.map((indexedRun) => {
      const indexedRunArtifact = resolveMilestoneBundleReference(
        artifactsRoot,
        indexedRun.runRef,
        `${checkpoint} run-index ${indexedRun.runId}.runRef`,
        path.dirname(runIndex.sourcePath),
      );
      return loadJson(indexedRunArtifact.sourcePath);
    });
    const closeReadyRunIds = closeReadyVisualReviewRunIds(indexedRunRecords, {
      iterationId,
      taskGraphRef: milestoneReview.source.task_graph_ref,
    });
    for (const runId of closeReadyAcceptanceReviewRunIds(indexedRunRecords, {
      iterationId,
      taskGraphRef: milestoneReview.source.task_graph_ref,
    })) closeReadyRunIds.add(runId);
    const transferRunEntries = selectHandoffRunEntries(
      runIndexData,
      requiredCompletedRunIds,
      runTransfer,
      { additionalRunIds: closeReadyRunIds },
    );
    const portableRunBundles = transferRunEntries
      .map((indexedRun) => resolvePortableRunBundle(runIndex, checkpoint, indexedRun))
      .filter(Boolean);
    const portableRuns = portableRunBundles.map((bundle) => bundle.indexedRun);
    const portableRunIds = new Set(portableRuns.map((indexedRun) => indexedRun.runId));
    const portableTaskGraphRefs = new Map();
    const portableTaskGraphSourceSpecRefs = new Map();
    for (const { indexedRun, sourceBundle } of portableRunBundles) {
      const normalizedTaskGraphRef = path.isAbsolute(indexedRun.taskGraphRef)
        ? null
        : normalizePath(indexedRun.taskGraphRef).replace(/^\.\//, '');
      if (normalizedTaskGraphRef !== sourceBundle.runTaskGraph.relativePath) {
        portableTaskGraphRefs.set(indexedRun.runId, sourceBundle.runTaskGraph.relativePath);
      }
      if (sourceBundle.portableSourceSpecRef) {
        const taskGraphRealPath = realpathSync(sourceBundle.runTaskGraph.sourcePath);
        const existingRef = portableTaskGraphSourceSpecRefs.get(taskGraphRealPath);
        if (existingRef && existingRef !== sourceBundle.portableSourceSpecRef) {
          throw new ValidationError(
            `${checkpoint} run task graph requires conflicting portable source specs: ${sourceBundle.runTaskGraph.relativePath}`,
          );
        }
        portableTaskGraphSourceSpecRefs.set(
          taskGraphRealPath,
          sourceBundle.portableSourceSpecRef,
        );
      }
    }
    if (
      runTransfer === 'completed'
      && (portableTaskGraphRefs.size || portableTaskGraphSourceSpecRefs.size)
    ) {
      throw new ValidationError(
        `portable handoff requires canonical relative run provenance without JSON rewriting; ${portableProvenanceMigrationHint()}`,
      );
    }
    pushBundleFile(
      runIndex.sourcePath,
      runIndex.relativePath,
      evidenceFiles,
      portableTaskGraphRefs.size || portableRuns.length !== runIndexData.runs.length
        ? {
            type: 'rewrite-json',
            transform: (source) => portableRunIndexText(
              source,
              portableRunIds,
              portableTaskGraphRefs,
            ),
          }
        : {},
    );
    for (const {
      indexedRun,
      run,
      runData,
      sourceBundle,
    } of portableRunBundles) {
      const portableTaskGraphRef = portableTaskGraphRefs.get(indexedRun.runId);
      const portableSourceSpecRef = portableTaskGraphSourceSpecRefs.get(
        realpathSync(sourceBundle.runTaskGraph.sourcePath),
      ) ?? sourceBundle.portableSourceSpecRef;
      pushBundleFile(
        run.sourcePath,
        run.relativePath,
        evidenceFiles,
        portableTaskGraphRef || portableSourceSpecRef
          ? {
              type: 'rewrite-json',
              transform: () => portableRunText(
                { runData, sourceBundle },
                portableTaskGraphRef,
                portableSourceSpecRef,
              ),
            }
          : {},
      );
      pushRunSourceBundle(sourceBundle, portableSourceSpecRef);
      const monitorGateRef = runSidecarRef(indexedRun.runRef, '.monitor-gate.json');
      const monitorGateSourcePath = path.resolve(path.dirname(runIndex.sourcePath), monitorGateRef);
      if (existsSync(monitorGateSourcePath)) {
        const monitorGate = resolveMilestoneBundleReference(
          artifactsRoot,
          monitorGateRef,
          `${checkpoint} run-index ${indexedRun.runId} monitor gate`,
          path.dirname(runIndex.sourcePath),
        );
        pushBundleFile(monitorGate.sourcePath, monitorGate.relativePath, evidenceFiles);
        const monitorGateData = loadJson(monitorGate.sourcePath);
        const verdictRef = typeof monitorGateData.verdictPath === 'string'
          ? monitorGateData.verdictPath.trim()
          : '';
        const verdictSourcePath = verdictRef
          ? path.resolve(path.dirname(runIndex.sourcePath), verdictRef)
          : null;
        if (verdictSourcePath && existsSync(verdictSourcePath)) {
          const verdict = resolveMilestoneBundleReference(
            artifactsRoot,
            verdictRef,
            `${checkpoint} run-index ${indexedRun.runId} monitor verdict`,
            path.dirname(runIndex.sourcePath),
          );
          pushBundleFile(verdict.sourcePath, verdict.relativePath, evidenceFiles);
        } else if (runData.status === 'finished' && runData.monitorGate?.required) {
          throw new ValidationError(
            `${checkpoint} finished monitor-gated run ${indexedRun.runId} is missing its monitor verdict`,
          );
        }
      } else if (runData.monitorGate?.required) {
        throw new ValidationError(
          `${checkpoint} run ${indexedRun.runId} is missing its bound monitor gate sidecar`,
        );
      }
      if (runData.status === 'finished' && runData.visualReview?.required) {
        const sidecar = resolveMilestoneBundleReference(
          artifactsRoot,
          runSidecarRef(indexedRun.runRef, '.visual-review.json'),
          `${checkpoint} run-index ${indexedRun.runId} visual review`,
          path.dirname(runIndex.sourcePath),
        );
        pushBundleFile(sidecar.sourcePath, sidecar.relativePath, evidenceFiles);
        const visualReview = loadJson(sidecar.sourcePath);
        const visualEvidenceRefs = [
          ...(visualReview.results ?? []).map((result) => result.artifact_ref),
          visualReview.accessibility?.report_ref,
        ].filter(Boolean);
        for (const [evidenceIndex, reference] of visualEvidenceRefs.entries()) {
          const evidenceLabel = `${checkpoint} run-index ${indexedRun.runId} visual evidence ${evidenceIndex + 1}`;
          const visualEvidence = resolveMilestoneBundleReference(
            artifactsRoot,
            reference,
            evidenceLabel,
          );
          // Preserve the sidecar's validated reference as a regular target file even
          // when the source reached the bytes through an artifact-root symlink alias.
          pushBundleFile(
            visualEvidence.sourcePath,
            portableVisualEvidenceTarget(reference, evidenceLabel),
            evidenceFiles,
          );
        }
      }
      if (runData.status === 'finished' && runData.acceptanceReview?.required) {
        const sidecar = resolveMilestoneBundleReference(
          artifactsRoot,
          runSidecarRef(indexedRun.runRef, '.acceptance-review.json'),
          `${checkpoint} run-index ${indexedRun.runId} acceptance review`,
          path.dirname(runIndex.sourcePath),
        );
        pushBundleFile(sidecar.sourcePath, sidecar.relativePath, evidenceFiles);
      }
    }
    const portableRunBundlesById = new Map(
      portableRunBundles.map((bundle) => [bundle.indexedRun.runId, bundle]),
    );
    const milestoneTaskGraphSourceSpecRef = portableTaskGraphSourceSpecRefs.get(
      realpathSync(taskGraph.sourcePath),
    );
    const rewritesCompletedEvidence = milestoneReview.source.completed_task_evidence.some(
      (evidence) => {
        const runBundle = portableRunBundlesById.get(evidence.run_snapshot.runId);
        return Boolean(
          runBundle
          && (
            portableTaskGraphRefs.has(runBundle.indexedRun.runId)
            || portableTaskGraphSourceSpecRefs.has(
              realpathSync(runBundle.sourceBundle.runTaskGraph.sourcePath),
            )
          )
        );
      },
    );
    if (milestoneTaskGraphSourceSpecRef || rewritesCompletedEvidence) {
      pushBundleFile(
        sourcePath,
        reviewRelativePath,
        reviewFiles,
        {
          type: 'rewrite-json',
          transform: (source) => {
            const portableReview = loadJson(source);
            if (milestoneTaskGraphSourceSpecRef) {
              portableReview.source.task_graph_snapshot.sourceSpec = milestoneTaskGraphSourceSpecRef;
              portableReview.source.task_graph_snapshot_sha256 = milestoneSnapshotSha256(
                portableReview.source.task_graph_snapshot,
              );
              portableReview.source.task_graph_sha256 = sha256Value(portableTaskGraphText(
                taskGraph.sourcePath,
                milestoneTaskGraphSourceSpecRef,
              ));
            }
            for (const evidence of portableReview.source.completed_task_evidence) {
              const runBundle = portableRunBundlesById.get(evidence.run_snapshot.runId);
              if (!runBundle) continue;
              const portableTaskGraphRef = portableTaskGraphRefs.get(runBundle.indexedRun.runId);
              const portableSourceSpecRef = portableTaskGraphSourceSpecRefs.get(
                realpathSync(runBundle.sourceBundle.runTaskGraph.sourcePath),
              ) ?? runBundle.sourceBundle.portableSourceSpecRef;
              if (!portableTaskGraphRef && !portableSourceSpecRef) continue;
              const portableRunSnapshot = structuredClone(evidence.run_snapshot);
              if (portableTaskGraphRef) portableRunSnapshot.taskGraphRef = portableTaskGraphRef;
              if (portableSourceSpecRef) portableRunSnapshot.sourceSpecRef = portableSourceSpecRef;
              evidence.run_snapshot = portableRunSnapshot;
              evidence.run_snapshot_sha256 = milestoneRunSnapshotSha256(portableRunSnapshot);
              evidence.run_sha256 = sha256Value(portableRunText(
                runBundle,
                portableTaskGraphRef,
                portableSourceSpecRef,
              ));
            }
            return `${JSON.stringify(portableReview, null, 2)}\n`;
          },
        },
      );
    }
    for (const evidence of milestoneReview.source.completed_task_evidence) {
      const runId = evidence.run_snapshot.runId;
      const taskId = evidence.run_snapshot.taskId;
      const indexedRun = runIndexData.runs.find((run) => run.runId === runId);
      const expectedRunRef = indexedRun ? artifactRunRef(indexedRun.runRef) : null;
      const legacyEvidenceRef = normalizePath(path.join('runs', legacyRunRef(runId)));
      if (!indexedRun || ![expectedRunRef, legacyEvidenceRef].includes(normalizePath(evidence.run_ref))) {
        throw new ValidationError(
          `${checkpoint} ${taskId}.run_ref must be ${JSON.stringify(expectedRunRef)} for a portable handoff bundle`,
        );
      }
    }
  }
  return { reviewFiles, evidenceFiles };
}

function appendHandoffRecord(currentSpec, record) {
  const records = Array.isArray(currentSpec.handoff_records)
    ? currentSpec.handoff_records.filter((item) => item?.handoff_id !== record.handoff_id)
    : [];
  return {
    ...currentSpec,
    last_handoff: record,
    handoff_records: [...records, record],
  };
}

function pushApprovalEvidence(plan, sourcePath, targetRoot, targetRelative, label) {
  const normalizedTarget = normalizePath(targetRelative);
  const existing = plan.find(
    (item) => normalizePath(item.targetRelative) === normalizedTarget,
  );
  if (existing) {
    if (
      !existing.source
      || realpathSync(existing.source) !== realpathSync(sourcePath)
    ) {
      throw new ValidationError(
        `${label} target collides with a different planned artifact: ${normalizedTarget}`,
      );
    }
    return;
  }
  pushArtifact(plan, sourcePath, targetRoot, normalizedTarget);
}

function bundleCurrentSpecApprovalAudits(
  plan,
  currentSpec,
  selectedIterationId,
  artifactsRoot,
  targetRoot,
  projectId,
  targetSpecRef,
) {
  const next = JSON.parse(JSON.stringify(currentSpec));
  for (const [iterationId, audit] of Object.entries(next.gate_b_approval_audits ?? {})) {
    assertSafeIterationId(iterationId);
    validateApprovalAuditData(audit, `gate_b_approval_audits.${iterationId}`);
    const source = resolveMilestoneBundleReference(
      artifactsRoot,
      `iterations/${iterationId}/gate-b-spec/spec.json`,
      `gate_b_approval_audits.${iterationId} approved spec`,
    );
    const targetRef = iterationId === selectedIterationId
      ? targetSpecRef
      : normalizePath(path.join(targetArtifactDir(projectId), source.relativePath));
    pushApprovalEvidence(
      plan,
      source.sourcePath,
      targetRoot,
      targetRef,
      `gate_b_approval_audits.${iterationId}`,
    );
    audit.approved_artifacts = [targetRef];
    if (Object.hasOwn(audit, 'approved_source')) audit.approved_source = targetRef;
  }

  delete next.gate_c_approval_audits;
  return next;
}

function handoffRecord(args, targetRoot, sourceInfo, maintenanceIncluded, maintenanceTaskCount, createdAt) {
  return {
    handoff_id: `handoff-${createdAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '')}`,
    handed_off_at: createdAt,
    iteration_id: sourceInfo.iterationId,
    source_layout: sourceInfo.kind,
    source_artifacts: path.resolve(args.artifacts),
    target_project: targetRoot,
    mode: args.mode,
    included_intake: args.includeIntake,
    ai_tool_targets: args.tools,
    codex_agent_profile: codexAgentProfileRecord(resolveCodexAgentProfile(args.codexProfile), args.tools.includes('codex')),
    maintenance_included: maintenanceIncluded,
    maintenance_task_count: maintenanceTaskCount,
    current_spec_ref: sourceInfo.currentSpecPath ? 'current-spec.json' : null,
  };
}

function maintenanceTaskCount(graphPath) {
  if (!existsSync(graphPath)) return 0;
  try {
    const graph = loadJson(graphPath);
    return Array.isArray(graph.tasks) ? graph.tasks.length : 0;
  } catch {
    return 0;
  }
}

function relativeFileList(sourceRoot, filter = () => true) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && filter(relative)) {
        files.push(relative);
      }
    }
  }
  visit(sourceRoot);
  return files.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));
}

function isP2aTopLevelAsset(relativePath) {
  const [firstSegment] = normalizePath(relativePath).split('/');
  return firstSegment.startsWith('p2a-');
}


function resolveCodexAgentProfile(value) {
  if (value == null) return DEFAULT_CODEX_AGENT_PROFILE;
  return parseCodexAgentProfile(value);
}

function resolveExistingCodexAgentProfile(args, manifest) {
  return resolveCodexAgentProfile(
    args.codexProfile ?? manifest.codexAgentProfile?.name ?? 'inherit',
  );
}

function codexAgentProfileRecord(profile, enabled = true) {
  if (!enabled) return null;
  if (profile === 'inherit') {
    return {
      name: 'inherit',
      model: null,
      reasoningEffortByTier: null,
    };
  }
  return {
    name: 'quality',
    model: 'gpt-5.6-sol',
    reasoningEffortByTier: { light: 'medium', standard: 'high', heavy: 'max' },
  };
}

function inheritedCodexAgentContent(sourcePath) {
  const source = readFileSync(sourcePath, 'utf8');
  return source
    .replace(/^model\s*=.*\n/m, '')
    .replace(/^model_reasoning_effort\s*=.*\n/m, '');
}

const P2A_SUBCOMMAND_PATTERN = /\bp2a (?=(?:decide|decisions|doctor|enhance|eval|execute|handoff|info|init|iteration|memory|next|proposal|proposals|run|runs|scaffold|shape|task|tasks|update|upgrade|validate)\b)/g;

function legacyRuntimeCommandContent(source) {
  return source.replace(
    P2A_SUBCOMMAND_PATTERN,
    'node .plan2agent/scripts/p2a.mjs ',
  );
}

function legacyRuntimeAssetContent(sourcePath, initialTransform = null) {
  const source = initialTransform
    ? initialTransform(sourcePath)
    : readFileSync(sourcePath, 'utf8');
  return legacyRuntimeCommandContent(source);
}

function pushToolAssetDirectory(plan, targetRoot, sourceRelativeDir, targetRelativeDir, options = {}) {
  const sourceRoot = path.join(ROOT, sourceRelativeDir);
  if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) {
    throw new Error(`tool asset source is missing: ${sourceRelativeDir}`);
  }
  const files = [];
  for (const relativeFile of relativeFileList(sourceRoot, options.filter)) {
    const targetRelative = path.join(targetRelativeDir, relativeFile);
    const existing = plan.find((item) => normalizePath(item.targetRelative) === normalizePath(targetRelative));
    const source = path.join(sourceRoot, relativeFile);
    if (existing) {
      if (existing.source && path.resolve(existing.source) === path.resolve(source)) continue;
      throw new Error(`tool asset target collision: ${normalizePath(targetRelative)}`);
    }
    if (options.transform) {
      pushArtifact(plan, source, targetRoot, targetRelative, {
        type: 'rewrite-text',
        transform: options.transform,
      });
    } else {
      pushArtifact(plan, source, targetRoot, targetRelative);
    }
    files.push(normalizePath(targetRelative));
  }
  return files;
}

function selectedToolAssetSpecs(toolTargets, { codexProfile = DEFAULT_CODEX_AGENT_PROFILE } = {}) {
  if (!toolTargets.length) return [];
  const specs = [
    {
      key: 'common-skills',
      source: path.join('.agents', 'skills'),
      target: path.join('.agents', 'skills'),
      filter: isP2aTopLevelAsset,
    },
    {
      key: 'common-agents',
      source: path.join('.agents', 'agents'),
      target: path.join('.agents', 'agents'),
      filter: isP2aTopLevelAsset,
    },
  ];
  if (toolTargets.includes('codex')) {
    specs.push({
      key: 'codex-agents',
      source: path.join('.codex', 'agents'),
      target: path.join('.codex', 'agents'),
      filter: isP2aTopLevelAsset,
      transform: codexProfile === 'inherit' ? inheritedCodexAgentContent : null,
    });
  }
  if (toolTargets.includes('claude')) {
    specs.push(
      {
        key: 'claude-skills',
        source: path.join('.claude', 'skills'),
        target: path.join('.claude', 'skills'),
        filter: isP2aTopLevelAsset,
      },
      {
        key: 'claude-agents',
        source: path.join('.claude', 'agents'),
        target: path.join('.claude', 'agents'),
        filter: isP2aTopLevelAsset,
      },
      {
        key: 'claude-hooks',
        source: path.join('.claude', 'hooks'),
        target: path.join('.claude', 'hooks'),
        filter: isP2aTopLevelAsset,
      },
    );
  }
  if (toolTargets.includes('gemini')) {
    specs.push(
      {
        key: 'gemini-agents',
        source: path.join('.gemini', 'agents'),
        target: path.join('.gemini', 'agents'),
        filter: isP2aTopLevelAsset,
      },
      {
        key: 'gemini-commands',
        source: path.join('.gemini', 'commands', 'p2a'),
        target: path.join('.gemini', 'commands', 'p2a'),
        filter: () => true,
      },
    );
  }
  return specs;
}

function pushToolAssets(
  plan,
  targetRoot,
  toolTargets,
  {
    codexProfile = DEFAULT_CODEX_AGENT_PROFILE,
    legacyRuntime = false,
  } = {},
) {
  const files = [];
  const groups = [];
  for (const spec of selectedToolAssetSpecs(toolTargets, { codexProfile })) {
    const transform = legacyRuntime
      ? (sourcePath) => legacyRuntimeAssetContent(sourcePath, spec.transform)
      : spec.transform;
    const groupFiles = pushToolAssetDirectory(plan, targetRoot, spec.source, spec.target, {
      filter: spec.filter,
      transform,
    });
    files.push(...groupFiles);
    groups.push({ key: spec.key, source: normalizePath(spec.source), target: normalizePath(spec.target), files: groupFiles });
  }
  return { files, groups };
}

function pushGenerated(plan, targetRoot, targetRelative, type, content, options = {}) {
  const normalizedTarget = normalizePath(targetRelative);
  const existing = plan.find((item) => normalizePath(item.targetRelative) === normalizedTarget);
  if (existing) {
    const existingContent = existing.content ?? (existing.type === 'write-json' ? `${JSON.stringify(existing.data, null, 2)}\n` : null);
    if (existingContent === content) return;
    throw new Error(`generated target collision: ${normalizedTarget}`);
  }
  plan.push({
    type,
    targetRelative,
    target: targetPath(targetRoot, targetRelative),
    content,
    allowExisting: options.allowExisting === true,
  });
}

function pushGeneratedText(plan, targetRoot, targetRelative, text, options = {}) {
  pushGenerated(plan, targetRoot, targetRelative, 'write-text', text.endsWith('\n') ? text : `${text}\n`, options);
}

function pushGeneratedJson(plan, targetRoot, targetRelative, data, options = {}) {
  pushGenerated(plan, targetRoot, targetRelative, 'write-json', `${JSON.stringify(data, null, 2)}\n`, options);
}

function hasExplicitIntakeMarkdownMarker(content) {
  const [firstLine = ''] = String(content).split(/\r\n|\n|\r/, 1);
  return firstLine === EXPLICIT_INTAKE_MARKDOWN_MARKER;
}

function pushVerifiedFileRemoval(plan, targetRoot, targetRelative, content) {
  plan.push({
    type: 'remove-file',
    targetRelative,
    target: targetPath(targetRoot, targetRelative),
    expectedSha256: sha256Value(content),
    allowExisting: false,
  });
}

function isUnsafeTeamBigFiveSourcePath(relativePath) {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ['.git', 'node_modules', '_workspace'].includes(segment))) return true;
  const basename = segments[segments.length - 1] ?? '';
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  return /(^|[-_.])(secret|credential|credentials)([-_.]|$)/i.test(basename);
}

function teamBigFiveSourceFiles(sourceRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(path.relative(sourceRoot, absolute));
      if (isUnsafeTeamBigFiveSourcePath(relative)) continue;
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const bytes = lstatSync(absolute).size;
        const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
        files.push({ path: relative, bytes, sha256 });
      }
    }
  }
  visit(sourceRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function tryReadJson(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectTeamBigFiveSourceMetadata(sourceRoot) {
  for (const relativePath of ['package.json', 'plugin.json', '.claude-plugin/plugin.json', 'manifest.json']) {
    const data = tryReadJson(path.join(sourceRoot, relativePath));
    if (!data) continue;
    if (typeof data.name === 'string' || typeof data.version === 'string') {
      return {
        manifestFile: normalizePath(relativePath),
        name: typeof data.name === 'string' ? data.name : null,
        version: typeof data.version === 'string' ? data.version : null,
      };
    }
  }
  return { manifestFile: null, name: null, version: null };
}

function resolveTeamBigFiveSource(sourceValue) {
  if (isGitUrl(sourceValue)) {
    return {
      type: 'git-url',
      input: sourceValue,
      url: sourceValue,
      fetched: false,
      metadata: { manifestFile: null, name: null, version: null },
      files: [],
    };
  }
  const sourceRoot = path.resolve(sourceValue);
  if (!existsSync(sourceRoot) || !lstatSync(sourceRoot).isDirectory()) {
    throw new Error(`--team-bigfive-source must be a local directory or Git URL: ${sourceValue}`);
  }
  const files = teamBigFiveSourceFiles(sourceRoot);
  return {
    type: 'local',
    input: sourceValue,
    path: sourceRoot,
    metadata: detectTeamBigFiveSourceMetadata(sourceRoot),
    files,
  };
}

function teamBigFiveSourceManifest(sourceInfo, targets) {
  return {
    schema_version: 'p2a.team_bigfive_source.v1',
    harness: 'team-bigfive',
    source: {
      type: sourceInfo.type,
      input: sourceInfo.input,
      path: sourceInfo.type === 'local' ? sourceInfo.path : null,
      url: sourceInfo.type === 'git-url' ? sourceInfo.url : null,
      fetched: sourceInfo.type === 'git-url' ? false : null,
      metadata: sourceInfo.metadata,
      fileCount: sourceInfo.files.length,
      files: sourceInfo.files,
    },
    adapterTargets: targets,
    excludedPathRules: [
      '.git/',
      'node_modules/',
      '_workspace/',
      '.env and .env.*',
      '*secret* and *credential* files',
    ],
  };
}

function teamBigFiveSkillMarkdown() {
  return `---
name: team-bigfive-kickoff
description: Kick off a Team Big Five style execution session for an approved Plan2Agent task.
---

# Team Big Five Kickoff

Use this skill only after Plan2Agent legacy handoff has installed approved flat artifacts under \`.plan2agent/artifacts/<projectId>/\`.

## Inputs

- A Plan2Agent task id from the handoff task graph recorded in \`.plan2agent/project.config.json.taskGraph\`.
- The task prompt from \`p2a execute start --graph <task-graph> --task <task-id>\` or \`p2a tasks prompt --graph <task-graph> <task-id>\`.
- Optional verification commands from \`.plan2agent/project.config.json\`.

## Workflow

1. Read the task prompt, acceptance criteria, source spec refs, and project config.
2. Split the work into five lanes: coordination, implementation plan, code changes, review, and verification.
3. Keep all work tied to the task id and source spec refs.
4. Do not edit approved Plan2Agent artifacts except through the task/status CLIs.
5. Track execution with \`p2a execute start/finish/status\` or the lower-level \`p2a runs start/verify/finish\` so runId, changed files, verification, agent tool, and workspace reference are preserved.
6. Before marking the task done, run or request the configured test, lint, and typecheck commands when available.

## Output

Return a concise kickoff plan, the lane assignments or prompts, expected changed areas, and verification checklist. If you make code changes in the target project, summarize the Plan2Agent run id, changed files, and verification results.
`;
}

function teamBigFiveCoordinatorInstructions(target) {
  return `You are the Team Big Five coordinator for Plan2Agent handoff projects.

Operate inside a legacy handoff target project after approved Plan2Agent artifacts have been installed. Use the task graph and spec recorded in .plan2agent/project.config.json and .plan2agent/artifacts/<projectId>/ as the source of truth.

Coordinate complex tasks through five lanes:
- coordination: keep task id, scope, dependencies, and acceptance criteria visible.
- implementation planning: identify files, interfaces, data flows, and risk.
- code changes: make or delegate focused implementation edits only when explicitly asked to execute.
- review: inspect behavioral regressions, missing tests, and scope drift.
- verification: run or request test/lint/typecheck commands from project.config.json.

Do not modify .plan2agent/artifacts/* directly. Use p2a execute for supervised task lifecycle records, or p2a tasks and p2a runs for lower-level task state and run records. Do not run package install, destructive git commands, or external network operations unless the user explicitly approves them. When finished, report the run id, changed files, verification commands, results, and any remaining blockers. Target adapter: ${target}.`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderCodexTeamBigFiveAgent() {
  return (
    'name = "team-bigfive-coordinator"\n' +
    'description = "Coordinates a Team Big Five style execution session for approved Plan2Agent tasks."\n' +
    'model_reasoning_effort = "high"\n' +
    `developer_instructions = ${tomlString(teamBigFiveCoordinatorInstructions('codex'))}\n`
  );
}

function renderClaudeTeamBigFiveAgent() {
  return `---
name: team-bigfive-coordinator
description: Coordinates a Team Big Five style execution session for approved Plan2Agent tasks.
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - MultiEdit
  - Write
---

${teamBigFiveCoordinatorInstructions('claude')}
`;
}

function renderGeminiTeamBigFiveAgent() {
  return `---
name: team-bigfive-coordinator
description: Coordinates a Team Big Five style execution session for approved Plan2Agent tasks.
kind: local
tools:
  - read_file
  - grep_search
temperature: 0.2
max_turns: 20
---

${teamBigFiveCoordinatorInstructions('gemini')}
`;
}

function renderGeminiTeamBigFiveCommand() {
  const prompt = `Use the Plan2Agent Team Big Five adapter for the following task or task id:

{{args}}

Read .plan2agent/project.config.json, then use its taskGraph and the matching spec under .plan2agent/artifacts/<projectId>/. Create a five-lane kickoff plan, then execute only if the user explicitly asks you to make code changes.`;
  return `description = "Kick off a Team Big Five execution session for a Plan2Agent task."\nprompt = ${tomlString(prompt)}\n`;
}

function teamBigFiveAdaptationNotes(sourceInfo, targets) {
  const sourceLine = sourceInfo.type === 'local'
    ? `Local source: ${sourceInfo.path}`
    : `Git source: ${sourceInfo.url} (not fetched by handoff)`;
  return `# Team Big Five Adapter Notes

${sourceLine}

Installed targets: ${targets.join(', ')}

Plan2Agent handoff installs adapter files only. It does not run agents, install packages, clone repositories, create branches, or execute tests.

Use approved legacy handoff artifacts as the source of truth:

- .plan2agent/project.config.json
- .plan2agent/artifacts/<projectId>/gate-b-spec/spec.json
- the task graph path recorded in .plan2agent/project.config.json.taskGraph

Target entry points:

- Codex: .agents/skills/team-bigfive-kickoff/SKILL.md and .codex/agents/team-bigfive-coordinator.toml
- Claude: .claude/skills/team-bigfive-kickoff/SKILL.md and .claude/agents/team-bigfive-coordinator.md
- Gemini: .agents/skills/team-bigfive-kickoff/SKILL.md, .gemini/agents/team-bigfive-coordinator.md, and .gemini/commands/p2a/team-bigfive.toml

Local source files are fingerprinted in source-manifest.json. For Claude targets, safe local source files are also copied to .claude-plugin/team-bigfive/source/. Files under .git, node_modules, _workspace, .env*, and secret/credential-like names are excluded.
`;
}

function pushTeamBigFiveAdapter(plan, targetRoot, args, { legacyRuntime = false } = {}) {
  if (!args.includeTeamBigFive) {
    return {
      enabled: false,
      targets: [],
      files: [],
      groups: [],
      externalHarness: null,
      projectConfig: { enabled: false },
    };
  }

  const targets = args.teamBigFiveTargets;
  const sourceInfo = resolveTeamBigFiveSource(args.teamBigFiveSource);
  const files = [];
  const groups = [];
  const runtimeContent = legacyRuntime
    ? legacyRuntimeCommandContent
    : (content) => content;

  const sourceManifest = teamBigFiveSourceManifest(sourceInfo, targets);
  pushGeneratedJson(plan, targetRoot, TEAM_BIGFIVE_SOURCE_MANIFEST, sourceManifest);
  files.push(normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST));
  pushGeneratedText(plan, targetRoot, TEAM_BIGFIVE_ADAPTATION_NOTES, teamBigFiveAdaptationNotes(sourceInfo, targets));
  files.push(normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES));
  groups.push({ key: 'team-bigfive-metadata', files: [normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST), normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES)] });

  const needsCommonSkill = targets.includes('codex') || targets.includes('gemini');
  if (needsCommonSkill) {
    const skillPath = path.join('.agents', 'skills', 'team-bigfive-kickoff', 'SKILL.md');
    pushGeneratedText(plan, targetRoot, skillPath, runtimeContent(teamBigFiveSkillMarkdown()));
    files.push(normalizePath(skillPath));
    groups.push({ key: 'team-bigfive-common-skill', files: [normalizePath(skillPath)] });
  }

  if (targets.includes('codex')) {
    const adapterFiles = [path.join('.codex', 'agents', 'team-bigfive-coordinator.toml')];
    pushGeneratedText(plan, targetRoot, adapterFiles[0], runtimeContent(renderCodexTeamBigFiveAgent()));
    files.push(...adapterFiles.map(normalizePath));
    groups.push({ key: 'team-bigfive-codex', files: adapterFiles.map(normalizePath) });
  }

  if (targets.includes('claude')) {
    const adapterFiles = [
      path.join('.claude', 'skills', 'team-bigfive-kickoff', 'SKILL.md'),
      path.join('.claude', 'agents', 'team-bigfive-coordinator.md'),
    ];
    pushGeneratedText(plan, targetRoot, adapterFiles[0], runtimeContent(teamBigFiveSkillMarkdown()));
    pushGeneratedText(plan, targetRoot, adapterFiles[1], runtimeContent(renderClaudeTeamBigFiveAgent()));
    files.push(...adapterFiles.map(normalizePath));

    const sourceCopyFiles = [];
    if (sourceInfo.type === 'local') {
      for (const file of sourceInfo.files) {
        const targetRelative = path.join('.claude-plugin', 'team-bigfive', 'source', file.path);
        pushArtifact(plan, path.join(sourceInfo.path, file.path), targetRoot, targetRelative);
        sourceCopyFiles.push(normalizePath(targetRelative));
      }
      files.push(...sourceCopyFiles);
    }
    groups.push({ key: 'team-bigfive-claude', files: [...adapterFiles.map(normalizePath), ...sourceCopyFiles] });
  }

  if (targets.includes('gemini')) {
    const adapterFiles = [
      path.join('.gemini', 'agents', 'team-bigfive-coordinator.md'),
      path.join('.gemini', 'commands', 'p2a', 'team-bigfive.toml'),
    ];
    pushGeneratedText(plan, targetRoot, adapterFiles[0], runtimeContent(renderGeminiTeamBigFiveAgent()));
    pushGeneratedText(plan, targetRoot, adapterFiles[1], renderGeminiTeamBigFiveCommand());
    files.push(...adapterFiles.map(normalizePath));
    groups.push({ key: 'team-bigfive-gemini', files: adapterFiles.map(normalizePath) });
  }

  const externalHarness = {
    name: 'team-bigfive',
    sourceType: sourceInfo.type,
    source: sourceInfo.type === 'local' ? sourceInfo.path : sourceInfo.url,
    sourceInput: sourceInfo.input,
    sourceVersion: sourceInfo.metadata.version,
    targets,
    sourceManifest: normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST),
    adaptationNotes: normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES),
    adapterFiles: files,
    fetched: sourceInfo.type === 'git-url' ? false : null,
  };

  return {
    enabled: true,
    targets,
    files,
    groups,
    externalHarness,
    projectConfig: {
      enabled: true,
      targets,
      sourceType: sourceInfo.type,
      source: sourceInfo.type === 'local' ? sourceInfo.path : sourceInfo.url,
      sourceManifest: normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST),
      adaptationNotes: normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES),
    },
  };
}


function targetArtifactDir(projectId) {
  return path.join(ARTIFACT_TARGET_BASE, projectId);
}

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function discoverTargetArtifactRoots(targetRoot) {
  const artifactsRoot = path.join(targetRoot, P2A_ARTIFACTS_DIR);
  if (!isDirectory(artifactsRoot)) return [];
  return readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(P2A_ARTIFACTS_DIR, entry.name))
    .filter((relativePath) => isIterativeArtifactRoot(path.join(targetRoot, relativePath)))
    .sort((left, right) => left.localeCompare(right));
}

function preferredEnhanceArtifactArg(targetRoot) {
  const artifactRoots = discoverTargetArtifactRoots(targetRoot);
  const artifactRef = artifactRoots[0] ?? path.join(P2A_ARTIFACTS_DIR, '<project_id>');
  return { artifactRef: normalizePath(artifactRef), hasArtifact: artifactRoots.length > 0 };
}

function projectRelativeConfigPath(targetRoot, value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(targetRoot, raw);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  }
  return normalizePath(raw);
}

function targetGatePath(projectId, gateDir, file) {
  return path.join(targetArtifactDir(projectId), gateDir, file);
}

function targetIntakeJsonPath(projectId) {
  return targetGatePath(projectId, 'gate-a-intake', 'intake.json');
}

function targetSpecJsonPath(projectId) {
  return targetGatePath(projectId, 'gate-b-spec', 'spec.json');
}

function targetTaskGraphPath(projectId) {
  return targetGatePath(projectId, 'gate-c-task-graph', 'task-graph.json');
}


function renderProjectGitignore() {
  return `# Plan2Agent local harness state and artifacts
# Planning artifacts, run logs, proposals, and generated harness files are local state.
# Persist them through Plan2Agent Memory instead of committing them with application source.
.plan2agent/

# Dependencies / build outputs
node_modules/
build/
dist/
out/
target/
.gradle/

# Editor / OS
.idea/
.vscode/
.DS_Store

# Env / secrets
.env
.env.*
!.env.example

# Claude Code local machine settings
.claude/settings.local.json
`;
}

function renderPlan2AgentGitignoreBlock(missingLines, claudeLocalMissing) {
  const lines = [
    '# Plan2Agent local harness state and artifacts',
    '# Planning artifacts, run logs, proposals, and generated harness files are local state.',
    '# Persist them through Plan2Agent Memory instead of committing them with application source.',
    ...missingLines,
  ];
  if (claudeLocalMissing) {
    lines.push('', '# Claude Code local machine settings', '.claude/settings.local.json');
  }
  return lines.join('\n');
}

function mergeProjectGitignore(existingText) {
  const existingLines = new Set(existingText.split(/\r?\n/).map((line) => line.trim()));
  const requiredLines = ['.plan2agent/'];
  const missingLines = requiredLines.filter((line) => !existingLines.has(line));
  const claudeLocalMissing = !existingLines.has('.claude/settings.local.json');
  if (!missingLines.length && !claudeLocalMissing) {
    return existingText.endsWith('\n') ? existingText : `${existingText}\n`;
  }
  const block = renderPlan2AgentGitignoreBlock(missingLines, claudeLocalMissing);
  const base = existingText.trimEnd();
  return `${base}${base ? '\n\n' : ''}${block}\n`;
}

function scaffoldGitignoreContent(targetRoot) {
  const gitignorePath = path.join(targetRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return renderProjectGitignore();
  if (!lstatSync(gitignorePath).isFile()) return renderProjectGitignore();
  return mergeProjectGitignore(readFileSync(gitignorePath, 'utf8'));
}

const CLAUDE_COARSE_DENY_PREFIXES = [
  { prefix: '/etc', rules: ['Edit(//etc/**)', 'Write(//etc/**)'], keepForWorkspace: true },
  { prefix: '/bin', rules: ['Edit(//bin/**)', 'Write(//bin/**)'], keepForWorkspace: true },
  { prefix: '/sbin', rules: ['Edit(//sbin/**)', 'Write(//sbin/**)'], keepForWorkspace: true },
  { prefix: '/usr', rules: ['Edit(//usr/**)', 'Write(//usr/**)'] },
  { prefix: '/var', rules: ['Edit(//var/**)', 'Write(//var/**)'] },
];

function pathIsAtOrUnder(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function claudeCoarseDenyRules(targetRoot) {
  const target = path.resolve(targetRoot);
  const deny = [
    'Edit(~/**)',
    'Write(~/**)',
  ];
  const omitted = [];
  for (const entry of CLAUDE_COARSE_DENY_PREFIXES) {
    const prefix = path.resolve(entry.prefix);
    if (!entry.keepForWorkspace && pathIsAtOrUnder(target, prefix)) {
      omitted.push(entry.prefix);
      continue;
    }
    deny.push(...entry.rules);
  }
  deny.push(
    'Edit(//System/**)',
    'Write(//System/**)',
    'Edit(//Applications/**)',
    'Write(//Applications/**)',
    'Edit(//Program Files/**)',
    'Write(//Program Files/**)',
    'Edit(//Program Files (x86)/**)',
    'Write(//Program Files (x86)/**)',
    'Edit(//Windows/**)',
    'Write(//Windows/**)',
    'Bash(rm -rf /)',
    'Bash(rm -rf ~)',
    'Bash(rm -rf ~/**)',
    'Bash(sudo *)',
  );
  return { deny, omitted };
}

function buildClaudeProjectSettings(targetRoot = process.cwd()) {
  const coarse = claudeCoarseDenyRules(targetRoot);
  return {
    permissions: {
      deny: coarse.deny,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|Bash',
          hooks: [
            {
              type: 'command',
              command: 'node .claude/hooks/p2a-confine-workspace.mjs',
            },
          ],
        },
      ],
    },
  };
}

function buildClaudeLocalSettings() {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return {
      sandbox: {
        enabled: true,
        filesystem: {
          allowWrite: ['.'],
        },
      },
    };
  }
  // Claude Code sandbox.enabled currently applies to macOS/Linux only.
  // On Windows, Plan2Agent installs app-level deny rules and hooks, not an OS sandbox.
  return {};
}

function renderPlan2AgentGuide(legacyRuntime = false) {
  const terminalNextCommand = legacyRuntime
    ? 'node .plan2agent/scripts/p2a.mjs next'
    : 'p2a next';
  return `# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start or resume work

Use one state-based entry point whenever you begin or finish a Plan2Agent action:

- Terminal: \`${terminalNextCommand}\`
- Claude Code, Codex, or Gemini agent session: \`/p2a-next\`

The result provides exactly one next action and its reason. Continue a returned skill in the same agent session; review and approve a returned CLI or approval action before running it. After that action is complete, run \`next\` again.

The project constitution remains at \`.plan2agent/constitution.json\`. Planning Gates A-C, iteration artifacts, execution runs, and proposal records remain under \`.plan2agent/artifacts/<project>/\` and \`.plan2agent/proposals/\`. Treat individual P2A CLI commands as references: use them only when \`next\` returns them.

## Storage policy

The generated \`.plan2agent/\` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
history through Plan2Agent Memory or an explicit export when needed.
`;
}

function buildScaffoldPlan(
  args,
  targetRoot,
  createdAt = new Date().toISOString(),
  options = {},
) {
  const plan = [];
  const projectId = resolveProjectIdDefault(targetRoot);
  const codexProfile = resolveCodexAgentProfile(args.codexProfile);
  const legacyRuntime = options.legacyRuntime
    ?? (['init', 'scaffold'].includes(args.command) && P2A_PATHS.toolkitCheckout);
  const packageCoordinates = readPackageCoordinates();
  if (legacyRuntime) {
    for (const file of SCAFFOLD_SCRIPT_FILES) {
      pushArtifact(plan, path.join(ROOT, 'scripts', file), targetRoot, targetScriptPath(file));
    }
    for (const file of SCAFFOLD_SCHEMA_FILES) {
      pushArtifact(plan, path.join(ROOT, 'schemas', file), targetRoot, targetSchemaPath(file));
    }
  }
  const toolAssetPlan = pushToolAssets(plan, targetRoot, args.tools, {
    codexProfile,
    legacyRuntime,
  });
  const claudeCoarseDeny = args.tools.includes('claude') ? claudeCoarseDenyRules(targetRoot) : { omitted: [] };
  const scriptFiles = legacyRuntime
    ? SCAFFOLD_SCRIPT_FILES.map((file) => normalizePath(targetScriptPath(file)))
    : [];
  const schemaFiles = legacyRuntime
    ? SCAFFOLD_SCHEMA_FILES.map((file) => normalizePath(targetSchemaPath(file)))
    : [];
  const managedFiles = plannedManagedFileRecords(plan, {
    scriptFiles,
    schemaFiles,
    aiToolGroups: toolAssetPlan.groups,
  });
  const manifest = {
    schema_version: 'p2a.handoff.v1',
    projectId,
    provenance: {
      mode: args.command === 'scaffold' ? 'scaffold' : 'init',
      createdAt,
      ...packageCoordinates,
      ...(legacyRuntime ? { toolkitRoot: ROOT } : {}),
    },
    ...(legacyRuntime ? {} : { runtime: { mode: 'package', command: 'p2a' } }),
    targetProject: targetRoot,
    createdAt,
    includedTools: [
      ...(legacyRuntime ? SCAFFOLD_SCRIPT_FILES.map((file) => file.replace(/\.mjs$/, '')) : []),
      ...args.tools.map((target) => `p2a_${target}_assets`),
    ],
    aiToolTargets: args.tools,
    codexAgentProfile: codexAgentProfileRecord(codexProfile, args.tools.includes('codex')),
    scriptFiles,
    schemaFiles,
    toolFiles: [...scriptFiles, ...toolAssetPlan.files],
    aiToolFiles: toolAssetPlan.files,
    aiToolGroups: toolAssetPlan.groups,
    managedFiles,
    notes: [
      legacyRuntime
        ? 'co-located scaffold: this project owns greenfield planning, development, and iteration artifacts'
        : 'package runtime: this project owns Plan2Agent state and provider assets while the p2a package supplies commands and schemas',
      args.tools.length ? `AI tool assets copied for: ${args.tools.join(', ')}` : 'AI tool assets not requested',
      args.tools.includes('codex') ? `Codex agent profile: ${codexProfile}` : 'Codex agent profile not applicable',
    ],
  };
  if (args.tools.includes('claude')) {
    pushGeneratedJson(plan, targetRoot, path.join('.claude', 'settings.json'), buildClaudeProjectSettings(targetRoot));
    pushGeneratedJson(plan, targetRoot, path.join('.claude', 'settings.local.json'), buildClaudeLocalSettings());
  }
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'manifest.json'), manifest);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'project.config.json'), buildProjectConfig(targetRoot, { enabled: false }, { projectId }));
  pushGeneratedText(plan, targetRoot, '.gitignore', scaffoldGitignoreContent(targetRoot), { allowExisting: true });
  if (args.command !== 'scaffold' || !existsSync(path.join(targetRoot, 'PLAN2AGENT.md'))) {
    pushGeneratedText(plan, targetRoot, 'PLAN2AGENT.md', renderPlan2AgentGuide(legacyRuntime));
  }
  plan.scaffoldWarnings = claudeCoarseDeny.omitted.map((prefix) => `Claude coarse deny ${prefix}/** omitted because targetProject is under that prefix; the PreToolUse hook enforces the workspace boundary instead.`);
  if (args.command === 'scaffold' && existsSync(path.join(targetRoot, 'PLAN2AGENT.md'))) {
    plan.scaffoldWarnings.push('Existing PLAN2AGENT.md preserved; review it manually if you want to add the generated Plan2Agent project guide.');
  }
  plan.projectId = projectId;
  return plan;
}

function printScaffoldPlan(plan, args, targetRoot) {
  console.log(`Plan2Agent ${args.command} ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`aiTools: ${args.tools.length ? args.tools.join(',') : 'none'}`);
  if (args.tools.includes('codex')) console.log(`codexProfile: ${resolveCodexAgentProfile(args.codexProfile)}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log(`projectId: ${plan.projectId}`);
  if (plan.scaffoldWarnings?.length) {
    for (const warning of plan.scaffoldWarnings) console.warn(`warning: ${warning}`);
  }
  console.log('writes:');
  for (const item of plan) {
    const action = item.type === 'write-json' || item.type === 'write-text' ? 'generate' : 'copy';
    const source = item.source ? normalizePath(path.relative(process.cwd(), item.source)) : '(generated)';
    console.log(`- ${action}: ${source} -> ${normalizePath(item.targetRelative)}`);
  }
  if (args.dryRun) console.log('dry-run: no files written');
}

function readUpgradeJsonFile(filePath, label, operation = 'upgrade') {
  if (!existsSync(filePath)) throw new Error(`${operation} requires ${label}: ${normalizePath(filePath)}`);
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`upgrade could not read ${label}: ${error.message}`);
  }
}

function assertPackageUpdateVersion(args, manifest) {
  if (
    args.command !== 'update'
    || P2A_PATHS.toolkitCheckout
    || manifest?.runtime?.mode !== 'package'
  ) return;
  const coordinates = readPackageCoordinates();
  const manifestName = manifest?.provenance?.packageName;
  const manifestVersion = manifest?.provenance?.packageVersion;
  if (manifestName !== coordinates.packageName || manifestVersion !== coordinates.packageVersion) {
    throw new Error(
      `update is pinned to manifest package ${manifestName ?? 'unknown'}@${manifestVersion ?? 'unknown'}, `
      + `but the running package is ${coordinates.packageName}@${coordinates.packageVersion}; run p2a upgrade --dry-run`,
    );
  }
}

function upgradeToolTargets(args, manifest) {
  if (Array.isArray(args.tools)) return args.tools;
  const manifestTargets = Array.isArray(manifest.aiToolTargets)
    ? manifest.aiToolTargets.filter((target) => typeof target === 'string' && VALID_TOOL_TARGETS.has(target))
    : [];
  return TOOL_TARGET_ORDER.filter((target) => manifestTargets.includes(target));
}

function enabledCapabilityEnhancements(manifest) {
  const enhancements = manifest.enhancements && typeof manifest.enhancements === 'object' && !Array.isArray(manifest.enhancements)
    ? manifest.enhancements
    : {};
  return ENHANCEMENT_ORDER
    .filter((capability) => capability !== 'dev-skills')
    .filter((capability) => enhancements[capability]?.enabled === true);
}

function plannedItemContent(item) {
  if (item.type === 'write-json') return item.content ?? `${JSON.stringify(item.data, null, 2)}\n`;
  if (item.type === 'write-text') return item.content;
  if (item.type === 'rewrite-json' || item.type === 'rewrite-text') return item.transform(item.source);
  return readFileSync(item.source);
}

function plannedAction(item) {
  if (item.type === 'delete-file') return 'remove';
  if (item.type === 'write-json' || item.type === 'write-text') return 'generate';
  if (item.type === 'rewrite-json' || item.type === 'rewrite-text') return 'copy+rewrite';
  return 'copy';
}

function compareUpgradePlanItem(item) {
  const targetRelative = normalizePath(item.targetRelative);
  const base = {
    action: plannedAction(item),
    target: targetRelative,
    source: item.source ? normalizePath(path.relative(process.cwd(), item.source)) : item.sourceLabel ?? '(generated)',
  };
  if (item.type === 'delete-file') {
    if (item.safeTarget !== true) {
      return { ...base, status: 'retired', detail: 'manifest entry is outside managed harness paths; inspect it manually' };
    }
    if (!existsSync(item.target)) {
      return { ...base, status: 'would_update', detail: 'retired file is already absent; its manifest entry will be removed' };
    }
    if (!lstatSync(item.target).isFile()) {
      return { ...base, status: 'retired', detail: 'retired target path is not a regular file; inspect it manually' };
    }
    if (!item.installedSha256) {
      return { ...base, status: 'retired', detail: 'installation hash is unavailable; inspect and remove this retired file manually' };
    }
    const currentSha256 = sha256Value(readFileSync(item.target));
    if (currentSha256 !== item.installedSha256) {
      return { ...base, status: 'retired', detail: 'retired file changed after installation; it will not be deleted automatically' };
    }
    if (!item.pruneRequested) {
      return { ...base, status: 'prunable', detail: 'retired managed file is unchanged; rerun apply with --prune to remove it' };
    }
    return { ...base, status: 'would_update', detail: 'retired managed file matches its installation hash and will be removed' };
  }
  if ((targetRelative === '.plan2agent/manifest.json' || targetRelative === '.plan2agent/project.config.json') && existsSync(item.target)) {
    if (!lstatSync(item.target).isFile()) {
      return { ...base, status: 'conflict', detail: 'target path exists but is not a file' };
    }
    return {
      ...base,
      status: 'unchanged',
      detail: targetRelative === '.plan2agent/project.config.json'
        ? 'project config is preserved; safe default migrations are reported separately'
        : 'manifest is preserved; apply records update history only when safe changes are applied',
    };
  }
  if (!existsSync(item.target)) {
    if (isManualReviewUpgradeTarget(targetRelative) && !isSafeMissingUpgradeTarget(targetRelative)) {
      return { ...base, status: 'manual_review', detail: 'generated/local file is missing; review before creating it' };
    }
    return { ...base, status: 'missing', detail: 'target file is missing' };
  }
  if (!lstatSync(item.target).isFile()) {
    return { ...base, status: 'conflict', detail: 'target path exists but is not a file' };
  }
  try {
    const planned = plannedItemContent(item);
    const plannedBuffer = Buffer.isBuffer(planned) ? planned : Buffer.from(String(planned));
    const currentBuffer = readFileSync(item.target);
    if (plannedBuffer.equals(currentBuffer)) {
      return { ...base, status: 'unchanged', detail: 'target matches toolkit file' };
    }
    if (isManualReviewUpgradeTarget(targetRelative)) {
      return { ...base, status: 'manual_review', detail: 'generated/local file differs from the toolkit template; review before replacing it' };
    }
    return { ...base, status: 'would_update', detail: 'target differs from toolkit file' };
  } catch (error) {
    return { ...base, status: 'error', detail: error.message };
  }
}

function summarizeUpgradeItems(items) {
  const summary = {
    total: items.length,
    unchanged: 0,
    missing: 0,
    wouldUpdate: 0,
    manualReview: 0,
    prunable: 0,
    retired: 0,
    conflicts: 0,
    errors: 0,
  };
  for (const item of items) {
    if (item.status === 'unchanged') summary.unchanged += 1;
    else if (item.status === 'missing') summary.missing += 1;
    else if (item.status === 'would_update') summary.wouldUpdate += 1;
    else if (item.status === 'manual_review') summary.manualReview += 1;
    else if (item.status === 'prunable') summary.prunable += 1;
    else if (item.status === 'retired') summary.retired += 1;
    else if (item.status === 'conflict') summary.conflicts += 1;
    else if (item.status === 'error') summary.errors += 1;
  }
  return summary;
}

function projectP2aCommandLine(targetRoot, manifest, args) {
  const targetP2a = path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs');
  const legacyRuntime = manifest?.runtime?.mode !== 'package'
    && existsSync(targetP2a)
    && lstatSync(targetP2a).isFile();
  if (!legacyRuntime) return ['p2a', ...args].map(shellQuote).join(' ');

  const relativePath = path.relative(process.cwd(), targetP2a);
  const commandPath = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? normalizePath(relativePath)
    : normalizePath(targetP2a);
  return ['node', commandPath, ...args].map(shellQuote).join(' ');
}

function updateApplyCommand(args, targetRoot, { prune = args.prune === true } = {}) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  const parts = [args.command, '--target', targetRoot];
  if (args.toolsProvided) parts.push('--tools', args.tools.length ? args.tools.join(',') : 'none');
  if (args.codexProfileProvided) parts.push('--codex-profile', args.codexProfile);
  parts.push('--apply');
  if (prune) parts.push('--prune');
  return projectP2aCommandLine(targetRoot, manifest, parts);
}

function buildConfigMigrations(config, manifest, targetRoot) {
  let nextConfig = config;
  let nextManifest = manifest;
  const projectIdConfigMigration = mergeProjectIdConfig(nextConfig, nextManifest, targetRoot);
  nextConfig = projectIdConfigMigration.config;
  const projectIdManifestMigration = mergeProjectIdManifest(nextManifest, nextConfig, targetRoot);
  nextManifest = projectIdManifestMigration.manifest;
  const devConfigMigration = mergeDevSkillConfig(nextConfig);
  nextConfig = devConfigMigration.config;
  const migrations = [
    {
      id: 'project_id_config',
      target: 'project_config',
      status: projectIdConfigMigration.updatedKeys.length ? 'would_update' : 'up_to_date',
      updatedKeys: projectIdConfigMigration.updatedKeys,
    },
    {
      id: 'project_id_manifest',
      target: 'manifest',
      status: projectIdManifestMigration.updatedKeys.length ? 'would_update' : 'up_to_date',
      updatedKeys: projectIdManifestMigration.updatedKeys,
    },
    {
      id: 'dev_skills_config',
      target: 'project_config',
      status: devConfigMigration.updatedKeys.length ? 'would_update' : 'up_to_date',
      updatedKeys: devConfigMigration.updatedKeys,
    },
  ];
  for (const capability of enabledCapabilityEnhancements(manifest)) {
    const migration = mergeCapabilityConfig(nextConfig, capability);
    nextConfig = migration.config;
    migrations.push({
      id: `${capability}_config`,
      target: 'project_config',
      status: migration.updatedKeys.length ? 'would_update' : 'up_to_date',
      updatedKeys: migration.updatedKeys,
    });
  }
  return { config: nextConfig, manifest: nextManifest, migrations };
}

function buildUpgradeNextActions(args, targetRoot, summary, failures, safeChanges) {
  if (failures.length) return [`Resolve conflicts/errors above before running ${args.command} again.`];
  if (summary.manualReview > 0) {
    return [
      `Review manual_review item(s) before applying ${args.command}; safe apply is blocked until they are resolved.`,
      safeChanges > 0
        ? `After resolving manual_review items, rerun preview or apply safe updates with: ${updateApplyCommand(args, targetRoot)}`
        : `After resolving manual_review items, rerun ${args.command} --dry-run.`,
    ];
  }
  const actions = [];
  if (safeChanges > 0) actions.push(`Review listed changes. Apply safe updates with: ${updateApplyCommand(args, targetRoot)}`);
  if (summary.prunable > 0) {
    actions.push(`Remove unchanged retired managed file(s) with: ${updateApplyCommand(args, targetRoot, { prune: true })}`);
  }
  if (summary.retired > 0) {
    actions.push('Inspect retired item(s) marked above; files without a matching installation hash are never deleted automatically.');
  }
  return actions;
}

function buildUpgradeDryRunReport(args, targetRoot) {
  const manifest = readUpgradeJsonFile(path.join(targetRoot, '.plan2agent', 'manifest.json'), '.plan2agent/manifest.json', args.command);
  assertPackageUpdateVersion(args, manifest);
  const config = readUpgradeJsonFile(path.join(targetRoot, '.plan2agent', 'project.config.json'), '.plan2agent/project.config.json', args.command);
  const tools = upgradeToolTargets(args, manifest);
  const codexProfile = resolveExistingCodexAgentProfile(args, manifest);
  const legacyRuntime = P2A_PATHS.toolkitCheckout
    && ['handoff', 'init', 'scaffold'].includes(manifest?.provenance?.mode)
    && manifest?.runtime?.mode !== 'package';
  const plan = buildScaffoldPlan(
    { ...args, tools, codexProfile },
    targetRoot,
    new Date().toISOString(),
    { legacyRuntime },
  );
  pushRetiredScaffoldFileCandidates(plan, targetRoot, manifest, args);
  const items = plan.map(compareUpgradePlanItem);
  const summary = summarizeUpgradeItems(items);
  const failures = items.filter((item) => item.status === 'conflict' || item.status === 'error');
  const configMigrations = buildConfigMigrations(config, manifest, targetRoot);
  const plannedManifest = plannedManifestFromPlan(plan);
  const nextManagedFiles = mergeManagedFileRecords(manifest.managedFiles, plannedManifest.managedFiles);
  if (JSON.stringify(normalizeManagedFileRecords(manifest.managedFiles)) !== JSON.stringify(nextManagedFiles)) {
    configMigrations.manifest = { ...configMigrations.manifest, managedFiles: nextManagedFiles };
    configMigrations.migrations.push({
      id: 'managed_files_manifest',
      target: 'manifest',
      status: 'would_update',
      updatedKeys: ['managedFiles'],
    });
  }
  const plannedCodexProfile = codexAgentProfileRecord(codexProfile, tools.includes('codex'));
  if (plannedCodexProfile && JSON.stringify(manifest.codexAgentProfile ?? null) !== JSON.stringify(plannedCodexProfile)) {
    configMigrations.manifest = { ...configMigrations.manifest, codexAgentProfile: plannedCodexProfile };
    configMigrations.migrations.push({
      id: 'codex_agent_profile_manifest',
      target: 'manifest',
      status: 'would_update',
      updatedKeys: ['codexAgentProfile'],
    });
  }
  const packageCoordinates = readPackageCoordinates();
  if (
    args.command === 'upgrade'
    && (
      manifest?.provenance?.packageName !== packageCoordinates.packageName
      || manifest?.provenance?.packageVersion !== packageCoordinates.packageVersion
    )
  ) {
    configMigrations.manifest = {
      ...configMigrations.manifest,
      provenance: {
        ...(configMigrations.manifest?.provenance ?? {}),
        ...packageCoordinates,
      },
    };
    configMigrations.migrations.push({
      id: 'package_version_manifest',
      target: 'manifest',
      status: 'would_update',
      updatedKeys: ['provenance.packageName', 'provenance.packageVersion'],
    });
  }
  const migrationUpdateCount = configMigrations.migrations.reduce((sum, migration) => sum + migration.updatedKeys.length, 0);
  const changes = summary.missing + summary.wouldUpdate + summary.manualReview + summary.prunable + summary.retired + migrationUpdateCount;
  const status = failures.length ? 'fail' : changes ? 'changes' : 'pass';
  const safeChanges = summary.missing + summary.wouldUpdate + migrationUpdateCount;
  return {
    schema_version: 'p2a.upgrade_dry_run.v1',
    generatedAt: new Date().toISOString(),
    command: args.command,
    status,
    targetProject: targetRoot,
    aiToolTargets: tools,
    codexAgentProfile: plannedCodexProfile,
    toolsProvided: args.toolsProvided,
    runtimeMode: legacyRuntime ? 'co-located' : 'package',
    summary,
    items,
    migrations: configMigrations.migrations,
    failures,
    nextActions: buildUpgradeNextActions(args, targetRoot, summary, failures, safeChanges),
    _plan: plan,
    _manifest: manifest,
    _config: config,
    _nextConfig: configMigrations.config,
    _nextManifest: configMigrations.manifest,
  };
}

function printUpgradeDryRunReport(report) {
  console.log(report.command === 'update' ? 'Plan2Agent update preview' : 'Plan2Agent upgrade dry run');
  console.log(`status: ${report.status}`);
  console.log(`targetProject: ${report.targetProject}`);
  console.log(`aiTools: ${report.aiToolTargets.length ? report.aiToolTargets.join(',') : 'none'}`);
  if (report.codexAgentProfile) console.log(`codexProfile: ${report.codexAgentProfile.name}`);
  console.log(`summary: ${report.summary.unchanged} unchanged, ${report.summary.missing} missing, ${report.summary.wouldUpdate} update(s), ${report.summary.manualReview} manual review, ${report.summary.prunable} prunable, ${report.summary.retired} retired, ${report.summary.conflicts} conflict(s), ${report.summary.errors} error(s)`);
  const notable = report.items.filter((item) => item.status !== 'unchanged');
  if (notable.length) {
    console.log('changes:');
    for (const item of notable) {
      console.log(`- ${item.status}: ${item.action} ${item.source} -> ${item.target}`);
      console.log(`  ${item.detail}`);
    }
  } else {
    console.log('changes: none');
  }
  if (report.nextActions.length) {
    console.log('next actions:');
    for (const action of report.nextActions) console.log(`- ${action}`);
  }
  if (report.migrations.length) {
    console.log('migrations:');
    for (const migration of report.migrations) {
      const keys = migration.updatedKeys.length ? ` (${migration.updatedKeys.join(',')})` : '';
      console.log(`- ${migration.id}: ${migration.status}${keys}`);
    }
  }
  if (report.reportPath) console.log(`report: ${report.reportPath}`);
  console.log('dry-run: no harness files written');
}

function isProjectConfigTarget(targetRelative) {
  return normalizePath(targetRelative) === '.plan2agent/project.config.json';
}

function isManifestTarget(targetRelative) {
  return normalizePath(targetRelative) === '.plan2agent/manifest.json';
}

function isAutoUpgradableTarget(targetRelative) {
  const target = normalizePath(targetRelative);
  return target.startsWith('.plan2agent/scripts/')
    || target.startsWith('.plan2agent/schemas/')
    || target.startsWith('.agents/')
    || target.startsWith('.codex/')
    || target.startsWith('.claude/skills/')
    || target.startsWith('.claude/agents/')
    || target.startsWith('.claude/hooks/')
    || target.startsWith('.gemini/agents/')
    || target.startsWith('.gemini/commands/p2a/');
}

function isSafeMissingUpgradeTarget(targetRelative) {
  return normalizePath(targetRelative) === '.plan2agent/style.md';
}

function isManualReviewUpgradeTarget(targetRelative) {
  return !isManifestTarget(targetRelative)
    && !isProjectConfigTarget(targetRelative)
    && !isAutoUpgradableTarget(targetRelative);
}

function applyCandidateStatus(status) {
  return status === 'missing' || status === 'would_update';
}

function publicUpgradeReport(report) {
  const { _plan, _manifest, _config, _nextConfig, _nextManifest, ...publicReport } = report;
  return publicReport;
}

function upgradeApplyBlockers(report) {
  const blockers = report.failures.map((item) => ({
    status: item.status,
    target: item.target,
    detail: item.detail,
  }));
  for (const item of report.items) {
    if (item.status === 'manual_review' && !isProjectConfigTarget(item.target)) {
      blockers.push({
        status: 'manual_review',
        target: item.target,
        detail: item.detail,
      });
      continue;
    }
    if (!applyCandidateStatus(item.status)) continue;
    if (
      isManifestTarget(item.target)
      || isProjectConfigTarget(item.target)
      || isAutoUpgradableTarget(item.target)
      || (item.status === 'missing' && isSafeMissingUpgradeTarget(item.target))
    ) continue;
    blockers.push({
      status: 'manual_review',
      target: item.target,
      detail: `safe apply does not overwrite ${item.target}; review this generated file manually`,
    });
  }
  return blockers;
}

function upgradeApplyItems(report) {
  const itemByTarget = new Map(report.items.map((item) => [normalizePath(item.target), item]));
  return report._plan.filter((item) => {
    const target = normalizePath(item.targetRelative);
    const comparison = itemByTarget.get(target);
    return comparison
      && applyCandidateStatus(comparison.status)
      && (
        isAutoUpgradableTarget(target)
        || item.type === 'delete-file'
        || (comparison.status === 'missing' && isSafeMissingUpgradeTarget(target))
      );
  });
}

function changedMigrations(report) {
  return report.migrations.filter((migration) => migration.updatedKeys.length > 0);
}

function reportTimestamp(value) {
  return value.replace(/[-:.]/g, '').replace(/\.\d+Z$/, 'Z');
}

function reportHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 10);
}

function upgradeReportRelativePath(command, timestamp, payload) {
  return normalizePath(path.join(
    '.plan2agent',
    'update-reports',
    `${command}-${reportTimestamp(timestamp)}-${reportHash(payload)}.json`,
  ));
}

function writeUpgradePreviewReport(targetRoot, report) {
  const reportRelative = upgradeReportRelativePath(report.command, report.generatedAt, report);
  const reportPath = targetPath(targetRoot, reportRelative);
  const reportWithPath = { ...report, reportPath: reportRelative };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(reportWithPath, null, 2)}\n`, 'utf8');
  return reportWithPath;
}

function writeUpgradeApplyReport(targetRoot, report) {
  const reportRelative = upgradeReportRelativePath(report.command, report.appliedAt, report);
  const reportPath = targetPath(targetRoot, reportRelative);
  const reportWithPath = { ...report, reportPath: reportRelative };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(reportWithPath, null, 2)}\n`, 'utf8');
  return reportWithPath;
}

function plannedManifestData(report) {
  const manifestItem = report._plan.find((item) => isManifestTarget(item.targetRelative));
  if (!manifestItem) return null;
  if (manifestItem.data) return manifestItem.data;
  if (typeof manifestItem.content === 'string') return JSON.parse(manifestItem.content);
  return null;
}

function retiredPlanTargets(report) {
  return new Set(
    report._plan
      .filter((item) => item.type === 'delete-file')
      .map((item) => normalizePath(item.targetRelative)),
  );
}

function reconcileManagedInventory(existingValues, plannedValues, resolvedRetiredPaths) {
  return uniqueNormalizedList(
    plannedValues,
    uniqueNormalizedList(existingValues).filter((value) => !resolvedRetiredPaths.has(value)),
  );
}

function retiredIncludedToolLabels(resolvedRetiredPaths) {
  const labels = new Set();
  for (const retiredPath of resolvedRetiredPaths) {
    const stem = path.basename(retiredPath, path.extname(retiredPath));
    labels.add(stem);
    labels.add(stem.replace(/-/g, '_'));
  }
  return labels;
}

function pruneResolvedManagedFileRecords(records, resolvedRetiredPaths) {
  return normalizeManagedFileRecords(records).filter((record) => !resolvedRetiredPaths.has(record.path));
}

function pruneResolvedAiToolGroups(groups, resolvedRetiredPaths) {
  return groups
    .map((group) => ({
      ...group,
      files: uniqueNormalizedList(group.files).filter((value) => !resolvedRetiredPaths.has(value)),
    }))
    .filter((group) => group.files.length > 0);
}

function mergeUpgradeManifest(existingManifest, report, appliedAt, appliedFiles, migrationIds) {
  const plannedManifest = plannedManifestData(report) ?? {};
  const retiredTargets = retiredPlanTargets(report);
  const resolvedRetiredPaths = new Set(
    appliedFiles.map((appliedFile) => normalizePath(appliedFile)).filter((appliedFile) => retiredTargets.has(appliedFile)),
  );
  const retiredToolLabels = retiredIncludedToolLabels(resolvedRetiredPaths);
  if (report.toolsProvided) {
    const selectedTargets = new Set(report.aiToolTargets);
    for (const target of uniqueNormalizedList(existingManifest.aiToolTargets)) {
      if (!selectedTargets.has(target)) retiredToolLabels.add(`p2a_${target}_assets`);
    }
  }
  const plannedIncludedTools = new Set(uniqueNormalizedList(plannedManifest.includedTools));
  const projectId = [
    existingManifest.projectId,
    report._nextManifest?.projectId,
    report._nextConfig?.projectId,
    plannedManifest.projectId,
  ].find((value) => typeof value === 'string' && value.trim())
    ?? resolveProjectIdDefault(report.targetProject, report._nextConfig, plannedManifest);
  const notes = [
    ...(Array.isArray(existingManifest.notes) ? existingManifest.notes.filter((item) => typeof item === 'string') : []),
    `Harness ${report.command} applied at ${appliedAt}`,
  ];
  const updates = Array.isArray(existingManifest.updates)
    ? existingManifest.updates.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  updates.push({
    command: report.command,
    appliedAt,
    ...(report.runtimeMode === 'co-located' ? { toolkitRoot: ROOT } : {}),
    files: appliedFiles.length,
    migrations: migrationIds,
  });
  const provenance = {
    ...(existingManifest.provenance && typeof existingManifest.provenance === 'object' && !Array.isArray(existingManifest.provenance) ? existingManifest.provenance : {}),
    ...(report.command === 'upgrade' && report._nextManifest?.provenance
      ? {
        packageName: report._nextManifest.provenance.packageName,
        packageVersion: report._nextManifest.provenance.packageVersion,
      }
      : {}),
    lastUpdatedAt: appliedAt,
    lastUpdateCommand: report.command,
  };
  if (report.runtimeMode === 'co-located') provenance.toolkitRoot = ROOT;
  else delete provenance.toolkitRoot;
  return {
    ...existingManifest,
    schema_version: existingManifest.schema_version ?? 'p2a.handoff.v1',
    projectId,
    targetProject: existingManifest.targetProject ?? report.targetProject,
    includedTools: uniqueNormalizedList(existingManifest.includedTools, plannedManifest.includedTools)
      .filter((item) => plannedIncludedTools.has(item) || !retiredToolLabels.has(item)),
    aiToolTargets: report.toolsProvided
      ? uniqueNormalizedList(report.aiToolTargets)
      : uniqueNormalizedList(existingManifest.aiToolTargets, report.aiToolTargets),
    codexAgentProfile: plannedManifest.codexAgentProfile ?? existingManifest.codexAgentProfile ?? null,
    scriptFiles: reconcileManagedInventory(existingManifest.scriptFiles, plannedManifest.scriptFiles, resolvedRetiredPaths),
    schemaFiles: reconcileManagedInventory(existingManifest.schemaFiles, plannedManifest.schemaFiles, resolvedRetiredPaths),
    toolFiles: reconcileManagedInventory(existingManifest.toolFiles, plannedManifest.toolFiles, resolvedRetiredPaths),
    aiToolFiles: reconcileManagedInventory(existingManifest.aiToolFiles, plannedManifest.aiToolFiles, resolvedRetiredPaths),
    aiToolGroups: pruneResolvedAiToolGroups(
      mergeAiToolGroups(existingManifest.aiToolGroups, plannedManifest.aiToolGroups ?? []),
      resolvedRetiredPaths,
    ),
    managedFiles: mergeManagedFileRecords(
      pruneResolvedManagedFileRecords(existingManifest.managedFiles, resolvedRetiredPaths),
      plannedManifest.managedFiles,
    ),
    provenance,
    updates: updates.slice(-20),
    notes: [...new Set(notes)],
  };
}

function writeJsonFile(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function buildUpgradeApplyReport(args, targetRoot, previewReport) {
  const appliedAt = new Date().toISOString();
  const blockers = upgradeApplyBlockers(previewReport);
  const applyItems = blockers.length ? [] : upgradeApplyItems(previewReport);
  const migrations = blockers.length ? [] : changedMigrations(previewReport);
  return {
    schema_version: 'p2a.upgrade_apply.v1',
    command: args.command,
    appliedAt,
    status: blockers.length ? 'blocked' : 'pending',
    targetProject: targetRoot,
    aiToolTargets: previewReport.aiToolTargets,
    codexAgentProfile: previewReport.codexAgentProfile,
    preview: publicUpgradeReport(previewReport),
    blockers,
    applied: {
      files: [],
      migrations: [],
      config: false,
      manifest: false,
    },
    error: null,
    nextActions: [],
    _applyItems: applyItems,
    _migrations: migrations,
  };
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function publicUpgradeApplyReport(report) {
  const { _applyItems, _migrations, ...publicReport } = report;
  return publicReport;
}

function executeUpgradeApply(targetRoot, report, previewReport) {
  if (report.blockers.length) {
    report.nextActions = ['Review blockers above, resolve conflicts/manual review items, then rerun with --apply.'];
    return report;
  }

  if (report._applyItems.length) {
    for (const item of report._applyItems) {
      writePlanItem(item);
      report.applied.files.push(normalizePath(item.targetRelative));
    }
  }
  const configMigrations = report._migrations.filter((migration) => migration.target !== 'manifest');
  const manifestMigrations = report._migrations.filter((migration) => migration.target === 'manifest');
  if (configMigrations.length) {
    writeJsonFile(path.join(targetRoot, '.plan2agent', 'project.config.json'), previewReport._nextConfig);
    report.applied.config = true;
  }
  if (report._migrations.length) {
    report.applied.migrations = report._migrations.map((migration) => ({
      id: migration.id,
      updatedKeys: migration.updatedKeys,
    }));
  }
  const shouldUpdateManifest = report.applied.files.length > 0 || report.applied.config || manifestMigrations.length > 0;
  if (shouldUpdateManifest) {
    const nextManifest = mergeUpgradeManifest(
      previewReport._manifest,
      previewReport,
      report.appliedAt,
      report.applied.files,
      report.applied.migrations.map((migration) => migration.id),
    );
    writeJsonFile(path.join(targetRoot, '.plan2agent', 'manifest.json'), nextManifest);
    report.applied.manifest = true;
  }
  const retiredNextActions = previewReport.nextActions.filter((action) => (
    action.startsWith('Remove unchanged retired') || action.startsWith('Inspect retired')
  ));
  if (!report.applied.files.length && !report.applied.config && !report.applied.manifest) {
    report.status = 'noop';
    report.nextActions = retiredNextActions.length
      ? ['No safe non-retirement update changes were required.', ...retiredNextActions]
      : ['No safe update changes were required.'];
  } else {
    report.status = 'applied';
    report.nextActions = ['Run p2a_doctor --dev against the target project to verify the applied update.', ...retiredNextActions];
  }
  return report;
}

function printUpgradeApplyReport(report) {
  console.log(report.command === 'update' ? 'Plan2Agent update apply' : 'Plan2Agent upgrade apply');
  console.log(`status: ${report.status}`);
  console.log(`targetProject: ${report.targetProject}`);
  if (report.blockers.length) {
    console.log('blockers:');
    for (const blocker of report.blockers) {
      console.log(`- ${blocker.status}: ${blocker.target}`);
      console.log(`  ${blocker.detail}`);
    }
  }
  if (report.error) console.log(`error: ${report.error}`);
  if (report.applied.files.length) {
    console.log('applied files:');
    for (const file of report.applied.files) console.log(`- ${file}`);
  }
  if (report.applied.migrations.length) {
    console.log('applied migrations:');
    for (const migration of report.applied.migrations) {
      console.log(`- ${migration.id}: ${migration.updatedKeys.join(',')}`);
    }
  }
  console.log(`manifest: ${report.applied.manifest ? 'updated' : 'unchanged'}`);
  if (report.reportPath) console.log(`report: ${report.reportPath}`);
  if (report.nextActions.length) {
    console.log('next actions:');
    for (const action of report.nextActions) console.log(`- ${action}`);
  }
}

function uniqueNormalizedList(...lists) {
  const seen = new Set();
  const values = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') continue;
      const normalized = normalizePath(item);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(normalized);
    }
  }
  return values;
}

function mergeAiToolGroups(existingGroups, nextGroups) {
  const groupsByKey = new Map();
  for (const group of Array.isArray(existingGroups) ? existingGroups : []) {
    if (group?.key && typeof group.key === 'string') groupsByKey.set(group.key, group);
  }
  for (const group of nextGroups) groupsByKey.set(group.key, group);
  return [...groupsByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function mergeEnhanceDevSkillsManifest(manifest, toolTargets, toolAssetPlan, codexProfile, managedFiles) {
  const promptTemplates = defaultPromptTemplates();
  const existingTargets = Array.isArray(manifest.aiToolTargets)
    ? manifest.aiToolTargets.filter((target) => typeof target === 'string')
    : [];
  const includedTools = [
    ...(Array.isArray(manifest.includedTools) ? manifest.includedTools.filter((item) => typeof item === 'string') : []),
    ...toolTargets.map((target) => `p2a_${target}_assets`),
  ];
  const notes = [
    ...(Array.isArray(manifest.notes) ? manifest.notes.filter((item) => typeof item === 'string') : []),
    'Development skill assets and config enhanced by p2a enhance dev-skills',
  ];
  return {
    ...manifest,
    schema_version: manifest.schema_version ?? 'p2a.handoff.v1',
    includedTools: [...new Set(includedTools)],
    aiToolTargets: TOOL_TARGET_ORDER.filter((target) => new Set([...existingTargets, ...toolTargets]).has(target)),
    codexAgentProfile: toolTargets.includes('codex')
      ? codexAgentProfileRecord(codexProfile)
      : manifest.codexAgentProfile ?? null,
    toolFiles: uniqueNormalizedList(manifest.toolFiles, toolAssetPlan.files),
    aiToolFiles: uniqueNormalizedList(manifest.aiToolFiles, toolAssetPlan.files),
    aiToolGroups: mergeAiToolGroups(manifest.aiToolGroups, toolAssetPlan.groups),
    managedFiles: mergeManagedFileRecords(manifest.managedFiles, managedFiles),
    enhancements: {
      ...(manifest.enhancements && typeof manifest.enhancements === 'object' && !Array.isArray(manifest.enhancements) ? manifest.enhancements : {}),
      devSkills: {
        enabled: true,
        aiToolTargets: toolTargets,
        promptTemplateVersion: promptTemplates.devExecution,
        roleContractVersion: promptTemplates.roleContract,
        providerGuideVersion: promptTemplates.providerGuide,
      },
    },
    notes: [...new Set(notes)],
  };
}

function mergeEnhanceCapabilityManifest(manifest, capability) {
  const defaults = defaultCapabilityConfig(capability);
  const notes = [
    ...(Array.isArray(manifest.notes) ? manifest.notes.filter((item) => typeof item === 'string') : []),
    `Capability ${capability} enhanced by p2a enhance ${capability}`,
  ];
  return {
    ...manifest,
    schema_version: manifest.schema_version ?? 'p2a.handoff.v1',
    enhancements: {
      ...(manifest.enhancements && typeof manifest.enhancements === 'object' && !Array.isArray(manifest.enhancements) ? manifest.enhancements : {}),
      [capability]: {
        enabled: true,
        configKey: capability,
        configVersion: `p2a.${capability}_config.v1`,
        mode: defaults.mode ?? defaults.defaultMode ?? defaults.commandMode ?? defaults.reviewPolicy ?? 'enabled',
      },
    },
    notes: [...new Set(notes)],
  };
}

function buildEnhanceDevSkillsPlan(args, targetRoot) {
  const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  const configPath = path.join(targetRoot, '.plan2agent', 'project.config.json');
  const manifest = readUpgradeJsonFile(manifestPath, '.plan2agent/manifest.json', 'enhance dev-skills');
  const config = readUpgradeJsonFile(configPath, '.plan2agent/project.config.json', 'enhance dev-skills');
  const plan = [];
  const codexProfile = resolveExistingCodexAgentProfile(args, manifest);
  const legacyRuntime = manifest?.runtime?.mode !== 'package';
  const toolAssetPlan = pushToolAssets(plan, targetRoot, args.tools, {
    codexProfile,
    legacyRuntime,
  });
  const managedFiles = plannedManagedFileRecords(plan, { aiToolGroups: toolAssetPlan.groups });
  const projectIdConfig = mergeProjectIdConfig(config, manifest, targetRoot);
  const projectIdManifest = mergeProjectIdManifest(manifest, projectIdConfig.config, targetRoot);
  const mergedConfig = mergeDevSkillConfig(projectIdConfig.config);
  const nextManifest = mergeEnhanceDevSkillsManifest(projectIdManifest.manifest, args.tools, toolAssetPlan, codexProfile, managedFiles);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'manifest.json'), nextManifest);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'project.config.json'), mergedConfig.config);
  plan.enhanceSummary = {
    aiToolTargets: args.tools,
    codexAgentProfile: codexAgentProfileRecord(codexProfile, args.tools.includes('codex')),
    assetFileCount: toolAssetPlan.files.length,
    configUpdatedKeys: [...new Set([...projectIdConfig.updatedKeys, ...mergedConfig.updatedKeys])],
  };
  return plan;
}

function buildEnhanceCapabilityPlan(args, targetRoot) {
  const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  const configPath = path.join(targetRoot, '.plan2agent', 'project.config.json');
  const manifest = readUpgradeJsonFile(manifestPath, '.plan2agent/manifest.json', `enhance ${args.enhancement}`);
  const config = readUpgradeJsonFile(configPath, '.plan2agent/project.config.json', `enhance ${args.enhancement}`);
  const plan = [];
  const projectIdConfig = mergeProjectIdConfig(config, manifest, targetRoot);
  const projectIdManifest = mergeProjectIdManifest(manifest, projectIdConfig.config, targetRoot);
  const mergedConfig = mergeCapabilityConfig(projectIdConfig.config, args.enhancement);
  const nextManifest = mergeEnhanceCapabilityManifest(projectIdManifest.manifest, args.enhancement);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'manifest.json'), nextManifest);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'project.config.json'), mergedConfig.config);
  plan.enhanceSummary = {
    capability: args.enhancement,
    configKey: args.enhancement,
    configUpdatedKeys: [...new Set([...projectIdConfig.updatedKeys, ...mergedConfig.updatedKeys])],
    nextActions: enhanceCapabilityNextActions(args.enhancement, targetRoot, mergedConfig.config, nextManifest),
  };
  return plan;
}

function enhanceCapabilityNextActions(capability, targetRoot, config, manifest) {
  const source = preferredEnhanceArtifactArg(targetRoot);
  const command = (args) => projectP2aCommandLine(targetRoot, manifest, args);
  if (capability === 'memory') {
    const projectId = typeof config?.projectId === 'string' && config.projectId.trim()
      ? config.projectId.trim()
      : source.hasArtifact
        ? path.basename(source.artifactRef)
        : '<project_id>';
    return [
      `${source.hasArtifact ? 'Check local/Memory sync' : 'After creating an artifact root, check local/Memory sync'}: ${command(['memory', 'status', '--artifacts', source.artifactRef])}`,
      `${source.hasArtifact ? 'Preview Memory restore diff' : 'After Memory is configured, preview restore diff'}: ${command(['memory', 'pull', '--artifacts', source.artifactRef, '--dry-run'])}`,
      `${source.hasArtifact ? 'Preview explicit Memory push' : 'After review, preview explicit Memory push'}: ${command(['memory', 'push', '--artifacts', source.artifactRef, '--dry-run'])}`,
      `${source.hasArtifact ? 'Search project Memory history' : 'After Memory contains snapshots, search project history'}: ${command(['memory', 'search', '--project', projectId, '--mode', 'hybrid', '--query', '<term>'])}`,
      `${source.hasArtifact ? 'Show Memory timeline' : 'After Memory contains snapshots, show timeline'}: ${command(['memory', 'history', '--artifacts', source.artifactRef])}`,
      `${source.hasArtifact ? 'Summarize run/proposal gaps' : 'After runs exist, summarize run/proposal gaps'}: ${command(['memory', 'digest', '--artifacts', source.artifactRef])}`,
    ];
  }
  if (capability === 'proposals') {
    const queueDir = projectRelativeConfigPath(targetRoot, config?.proposals?.queueDir, path.join('.plan2agent', 'proposals'));
    return [
      `${source.hasArtifact ? 'Mine proposal candidates' : 'After runs exist, mine proposal candidates'}: ${command(['proposals', 'mine', '--artifacts', source.artifactRef, '--proposals', queueDir, '--dry-run'])}`,
      `Review proposal queue: ${command(['proposals', 'digest', '--proposals', queueDir])}`,
      `Preview curation review: ${command(['proposals', 'review', '--proposals', queueDir, '--dry-run'])}`,
    ];
  }
  if (capability === 'orchestration') {
    const orchestrationAgentTool = resolveOrchestrationAgentTool(config, manifest);
    return [
      `${source.hasArtifact ? 'Start supervised run with monitor gate' : 'After a ready task exists, start supervised run with monitor gate'}: ${command(['execute', 'start', '--artifacts', source.artifactRef, '--task', '<task-id>', '--agent-tool', orchestrationAgentTool, '--require-monitor'])}`,
      'Write the monitor verdict beside the indexed run before finish: runs/<run-index entry runRef without .json>.monitor-verdict.json',
    ];
  }
  return [];
}

function compareEnhancePlanItem(item) {
  const targetRelative = normalizePath(item.targetRelative);
  const base = {
    action: plannedAction(item),
    target: targetRelative,
    source: item.source ? normalizePath(path.relative(process.cwd(), item.source)) : '(generated)',
  };
  if (!existsSync(item.target)) return { ...base, status: 'missing', detail: 'target file is missing' };
  if (!lstatSync(item.target).isFile()) return { ...base, status: 'conflict', detail: 'target path exists but is not a file' };
  try {
    const planned = plannedItemContent(item);
    const plannedBuffer = Buffer.isBuffer(planned) ? planned : Buffer.from(String(planned));
    const currentBuffer = readFileSync(item.target);
    return plannedBuffer.equals(currentBuffer)
      ? { ...base, status: 'unchanged', detail: 'target already matches planned content' }
      : { ...base, status: 'would_update', detail: 'target differs from planned content' };
  } catch (error) {
    return { ...base, status: 'error', detail: error.message };
  }
}

function enhancePlanItems(plan) {
  return plan.map(compareEnhancePlanItem);
}

function assertEnhanceNoConflicts(plan, overwrite, capability = 'dev-skills') {
  const conflicts = [];
  for (const item of plan) {
    if (!existsSync(item.target)) continue;
    if (!lstatSync(item.target).isFile()) {
      conflicts.push(`${normalizePath(item.targetRelative)} (not a file)`);
      continue;
    }
    if (item.type === 'write-json' || item.type === 'write-text') continue;
    const currentBuffer = readFileSync(item.target);
    const planned = plannedItemContent(item);
    const plannedBuffer = Buffer.isBuffer(planned) ? planned : Buffer.from(String(planned));
    if (!overwrite && !plannedBuffer.equals(currentBuffer)) {
      conflicts.push(normalizePath(item.targetRelative));
    }
  }
  if (conflicts.length) {
    throw new Error(`enhance ${capability} would replace existing file(s); rerun with --overwrite after reviewing: ${conflicts.join(', ')}`);
  }
}

function printEnhanceDevSkillsPlan(plan, args, targetRoot) {
  const items = enhancePlanItems(plan);
  const summary = summarizeUpgradeItems(items);
  console.log(`Plan2Agent enhance dev-skills ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log(`aiTools: ${args.tools.length ? args.tools.join(',') : 'none'}`);
  if (plan.enhanceSummary.codexAgentProfile) console.log(`codexProfile: ${plan.enhanceSummary.codexAgentProfile.name}`);
  console.log(`assets: ${plan.enhanceSummary.assetFileCount}`);
  console.log(`configUpdatedKeys: ${plan.enhanceSummary.configUpdatedKeys.length ? plan.enhanceSummary.configUpdatedKeys.join(',') : 'none'}`);
  console.log(`summary: ${summary.unchanged} unchanged, ${summary.missing} missing, ${summary.wouldUpdate} update(s), ${summary.conflicts} conflict(s), ${summary.errors} error(s)`);
  console.log('writes:');
  for (const item of items.filter((entry) => entry.status !== 'unchanged')) {
    console.log(`- ${item.status}: ${item.action} ${item.source} -> ${item.target}`);
    console.log(`  ${item.detail}`);
  }
  if (args.dryRun) console.log('dry-run: no files written');
}

function printEnhanceCapabilityPlan(plan, args, targetRoot) {
  const items = enhancePlanItems(plan);
  const summary = summarizeUpgradeItems(items);
  console.log(`Plan2Agent enhance ${args.enhancement} ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log(`capability: ${args.enhancement}`);
  console.log(`configKey: ${plan.enhanceSummary.configKey}`);
  console.log(`configUpdatedKeys: ${plan.enhanceSummary.configUpdatedKeys.length ? plan.enhanceSummary.configUpdatedKeys.join(',') : 'none'}`);
  console.log(`summary: ${summary.unchanged} unchanged, ${summary.missing} missing, ${summary.wouldUpdate} update(s), ${summary.conflicts} conflict(s), ${summary.errors} error(s)`);
  console.log('writes:');
  for (const item of items.filter((entry) => entry.status !== 'unchanged')) {
    console.log(`- ${item.status}: ${item.action} ${item.source} -> ${item.target}`);
    console.log(`  ${item.detail}`);
  }
  if (plan.enhanceSummary.nextActions.length) {
    console.log('next actions:');
    for (const action of plan.enhanceSummary.nextActions) console.log(`- ${action}`);
  }
  if (args.dryRun) console.log('dry-run: no files written');
}

function findProjectConstitution(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (path.basename(current) === '.plan2agent') {
      const candidate = path.join(current, 'constitution.json');
      return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
    }
    const candidate = path.join(current, '.plan2agent', 'constitution.json');
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function buildPlan(paths, args, artifactsRoot, targetRoot, sourceInfo, options = {}) {
  const {
    record = null,
    createdAt = new Date().toISOString(),
    legacyRuntime = P2A_PATHS.toolkitCheckout,
  } = options;
  const plan = [];
  const artifactTargetDir = targetArtifactDir(args.projectId);
  const targetIntakeRef = normalizePath(targetIntakeJsonPath(args.projectId));
  const targetSpecRef = normalizePath(targetSpecJsonPath(args.projectId));
  const targetTaskGraphRef = normalizePath(targetTaskGraphPath(args.projectId));
  const sourceConstitutionPath = findProjectConstitution(artifactsRoot);
  if (sourceConstitutionPath) {
    validateConstitution(sourceConstitutionPath, {
      requireApproved: true,
      projectId: args.projectId,
    });
    pushArtifact(
      plan,
      sourceConstitutionPath,
      targetRoot,
      path.join('.plan2agent', 'constitution.json'),
    );
  }
  assertFile(paths.intakeJson, 'gate-a-intake/intake.json');
  const portableIntakeFiles = resolvePortableArtifactReferenceBundle([{
    label: 'gate-a-intake/intake.json',
    reference: paths.intakeJson,
    baseDir: artifactsRoot,
  }], artifactsRoot);
  const portableIntakeContents = portableArtifactBundleContents(
    portableIntakeFiles,
    artifactsRoot,
    args.projectId,
  );
  const targetIntakeContent = rebaseIntakeApprovalAuditContent(
    portableIntakeContents.get(realpathSync(paths.intakeJson)),
    targetIntakeRef,
  );
  const targetIntakeSha256 = sha256Value(targetIntakeContent);
  pushArtifactIfExists(plan, paths.productSpec, targetRoot, path.join(artifactTargetDir, 'gate-b-spec', 'product-spec.md'));
  pushArtifactIfExists(plan, paths.implementationPlan, targetRoot, path.join(artifactTargetDir, 'gate-b-spec', 'implementation-plan.md'));
  pushArtifact(plan, paths.specJson, targetRoot, targetSpecJsonPath(args.projectId), {
    type: 'rewrite-json',
    transform: (source) => rebaseSpecSourceIntake(
      source,
      targetIntakeRef,
      targetSpecRef,
      targetIntakeSha256,
    ),
  });
  pushVisualExperienceBundleIfExists(
    plan,
    paths.specJson,
    artifactsRoot,
    targetRoot,
    args.projectId,
  );
  pushArtifact(plan, paths.taskGraph, targetRoot, targetTaskGraphPath(args.projectId), { type: 'rewrite-json', transform: (source) => rebaseTaskGraphSourceSpec(source, targetSpecRef) });

  pushArtifact(plan, paths.intakeJson, targetRoot, targetIntakeJsonPath(args.projectId), {
    type: 'rewrite-json',
    transform: () => targetIntakeContent,
  });
  const targetIntakeMarkdownRelative = path.join(
    artifactTargetDir,
    'gate-a-intake',
    'intake.md',
  );
  const targetIntakeMarkdownPath = targetPath(targetRoot, targetIntakeMarkdownRelative);
  let refreshTargetIntakeMarkdown = args.includeIntake;
  const existingTargetIntakeMarkdownStat = args.includeIntake
    ? null
    : lstatIfPresent(targetIntakeMarkdownPath);
  if (existingTargetIntakeMarkdownStat) {
    const targetIntakeMarkdownStat = existingTargetIntakeMarkdownStat;
    if (!targetIntakeMarkdownStat.isFile()) {
      throw new ValidationError(
        `existing target Gate A intake Markdown must be a regular file: ${targetIntakeMarkdownPath}`,
      );
    }
    const existingTargetIntakeMarkdown = readFileSync(targetIntakeMarkdownPath, 'utf8');
    if (hasExplicitIntakeMarkdownMarker(existingTargetIntakeMarkdown)) {
      refreshTargetIntakeMarkdown = true;
    } else {
      pushVerifiedFileRemoval(
        plan,
        targetRoot,
        targetIntakeMarkdownRelative,
        existingTargetIntakeMarkdown,
      );
    }
  }
  if (refreshTargetIntakeMarkdown) {
    const targetIntake = JSON.parse(targetIntakeContent);
    const intakeMarkdown = renderIntakeMarkdown(targetIntake, { explicitExport: true });
    if (!intakeMarkdown.startsWith(`${EXPLICIT_INTAKE_MARKDOWN_MARKER}\n`)) {
      throw new ValidationError('generated Gate A intake Markdown export is missing its explicit-export marker');
    }
    pushGeneratedText(
      plan,
      targetRoot,
      targetIntakeMarkdownRelative,
      intakeMarkdown,
    );
    if (args.includeIntake && args.mode === 'move') {
      try {
        const sourceIntakeMarkdownStat = lstatSync(paths.intakeMd);
        if (sourceIntakeMarkdownStat.isFile() || sourceIntakeMarkdownStat.isSymbolicLink()) {
          plan.moveCleanupSources = [
            ...(Array.isArray(plan.moveCleanupSources) ? plan.moveCleanupSources : []),
            paths.intakeMd,
          ];
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  if (record) record.included_intake = refreshTargetIntakeMarkdown;

  const currentSpecWithPortableApprovals = record && sourceInfo.currentSpec
    ? bundleCurrentSpecApprovalAudits(
        plan,
        sourceInfo.currentSpec,
        sourceInfo.iterationId,
        artifactsRoot,
        targetRoot,
        args.projectId,
        targetSpecRef,
      )
    : null;
  const currentSpecForHandoff = currentSpecWithPortableApprovals
    ? appendHandoffRecord(currentSpecWithPortableApprovals, record)
    : null;
  pushCurrentSpecCompositionBundleIfPresent(
    plan,
    currentSpecForHandoff,
    artifactsRoot,
    targetRoot,
    args.projectId,
  );

  const maintenanceGraphPath = sourceInfo.kind === 'iteration' ? maintenanceTaskGraphSourcePath(artifactsRoot) : null;
  const maintenanceFiles = [];
  if (maintenanceGraphPath && existsSync(maintenanceGraphPath)) {
    validateTaskGraph(maintenanceGraphPath);
    const targetRelative = path.join('.plan2agent', 'maintenance', 'task-graph.json');
    pushArtifact(plan, maintenanceGraphPath, targetRoot, targetRelative);
    maintenanceFiles.push(normalizePath(targetRelative));
  }
  const preflightResearchFiles = pushFeatureRadarPreflightIfExists(plan, artifactsRoot, targetRoot, args.projectId);
  const milestoneBundle = sourceInfo.kind === 'iteration'
    ? pushMilestoneReviewBundleIfExists(
        plan,
        artifactsRoot,
        targetRoot,
        args.projectId,
        sourceInfo.iterationId,
        args.runTransfer,
      )
    : { reviewFiles: [], evidenceFiles: [] };
  const milestoneReviewFiles = milestoneBundle.reviewFiles;
  const milestoneEvidenceFiles = milestoneBundle.evidenceFiles;
  pushIntakeBaselineContextBundleIfPresent(
    plan,
    paths.intakeJson,
    artifactsRoot,
    targetRoot,
    args.projectId,
  );
  const portableCurrentSpecForHandoff = currentSpecWithPortableClosedArtifactHashes(
    currentSpecForHandoff,
    plan,
    args.projectId,
  );
  if (portableCurrentSpecForHandoff) {
    pushGeneratedText(
      plan,
      targetRoot,
      path.join(artifactTargetDir, 'status.md'),
      renderIterationIndexMarkdown(artifactsRoot, portableCurrentSpecForHandoff),
    );
  } else {
    pushArtifactIfExists(plan, paths.statusDoc, targetRoot, path.join(artifactTargetDir, 'status.md'));
  }
  if (sourceInfo.currentSpecPath) {
    if (portableCurrentSpecForHandoff) {
      pushGeneratedJson(
        plan,
        targetRoot,
        path.join('.plan2agent', 'current-spec.json'),
        portableCurrentSpecForHandoff,
      );
    } else {
      pushArtifact(plan, sourceInfo.currentSpecPath, targetRoot, path.join('.plan2agent', 'current-spec.json'));
    }
  }

  const codexProfile = resolveCodexAgentProfile(args.codexProfile);
  if (legacyRuntime) {
    for (const file of SCAFFOLD_SCRIPT_FILES) {
      pushArtifact(plan, path.join(ROOT, 'scripts', file), targetRoot, targetScriptPath(file));
    }
    for (const file of SCAFFOLD_SCHEMA_FILES) {
      pushArtifact(plan, path.join(ROOT, 'schemas', file), targetRoot, targetSchemaPath(file));
    }
  }
  const toolAssetPlan = pushToolAssets(plan, targetRoot, args.tools, {
    codexProfile,
    legacyRuntime,
  });
  const teamBigFivePlan = pushTeamBigFiveAdapter(plan, targetRoot, args, { legacyRuntime });
  const scriptFiles = legacyRuntime
    ? SCAFFOLD_SCRIPT_FILES.map((file) => normalizePath(targetScriptPath(file)))
    : [];
  const schemaFiles = legacyRuntime
    ? SCAFFOLD_SCHEMA_FILES.map((file) => normalizePath(targetSchemaPath(file)))
    : [];

  const artifactFiles = plan
    .filter((item) => item.type !== 'remove-file')
    .filter((item) => item.targetRelative.startsWith(`${artifactTargetDir}${path.sep}`) || item.targetRelative.startsWith(`${artifactTargetDir}/`))
    .map((item) => normalizePath(item.targetRelative));
  const toolFiles = [
    ...scriptFiles,
    ...toolAssetPlan.files,
    ...teamBigFivePlan.files,
  ];
  const managedFiles = plannedManagedFileRecords(plan, {
    scriptFiles,
    schemaFiles,
    aiToolGroups: toolAssetPlan.groups,
  });
  const includedTools = legacyRuntime
    ? SCAFFOLD_SCRIPT_FILES.map((file) => file.replace(/\.mjs$/, ''))
    : [];
  for (const target of args.tools) includedTools.push(`p2a_${target}_assets`);
  if (teamBigFivePlan.enabled) includedTools.push('team_bigfive_adapter');

  const manifest = {
    schema_version: 'p2a.handoff.v1',
    projectId: args.projectId,
    provenance: {
      mode: 'handoff',
      createdAt,
      ...readPackageCoordinates(),
      ...(legacyRuntime ? { toolkitRoot: ROOT } : {}),
    },
    sourceArtifacts: artifactsRoot,
    sourceLayout: sourceInfo.kind,
    sourceIterationId: sourceInfo.iterationId,
    targetProject: targetRoot,
    handoffMode: args.mode,
    createdAt,
    ...(legacyRuntime ? {} : { runtime: { mode: 'package', command: 'p2a' } }),
    includedTools,
    aiToolTargets: args.tools,
    codexAgentProfile: codexAgentProfileRecord(codexProfile, args.tools.includes('codex')),
    externalHarnesses: teamBigFivePlan.externalHarness ? [teamBigFivePlan.externalHarness] : [],
    artifactFiles,
    preflightResearchFiles,
    milestoneReviewFiles,
    milestoneEvidenceFiles,
    currentSpecFile: sourceInfo.currentSpecPath ? '.plan2agent/current-spec.json' : null,
    constitutionFile: sourceConstitutionPath ? '.plan2agent/constitution.json' : null,
    maintenanceFiles,
    scriptFiles,
    toolFiles,
    aiToolFiles: toolAssetPlan.files,
    aiToolGroups: toolAssetPlan.groups,
    managedFiles,
    externalHarnessFiles: teamBigFivePlan.files,
    externalHarnessGroups: teamBigFivePlan.groups,
    schemaFiles,
    notes: [
      `task-graph.sourceSpec rebased to ${targetSpecRef}`,
      `spec.source_intake rebased to ${targetIntakeRef}`,
      sourceInfo.kind === 'iteration' ? `iteration handoff source: ${sourceInfo.iterationId}` : 'greenfield handoff source',
      `run transfer mode: ${args.runTransfer}`,
      sourceConstitutionPath ? 'approved Gate ② constitution copied' : 'legacy handoff without a constitution',
      preflightResearchFiles.length ? `Feature Radar preflight research copied: ${preflightResearchFiles.length} file(s)` : 'Feature Radar preflight research not present',
      milestoneReviewFiles.length ? `Milestone reviews copied: ${milestoneReviewFiles.length} file(s)` : 'Milestone reviews not present',
      milestoneEvidenceFiles.length ? `Milestone evidence bundle copied: ${milestoneEvidenceFiles.length} file(s)` : 'Milestone evidence bundle not present',
      args.tools.length ? `AI tool assets copied for: ${args.tools.join(', ')}` : 'AI tool assets not requested',
      args.tools.includes('codex') ? `Codex agent profile: ${codexProfile}` : 'Codex agent profile not applicable',
      teamBigFivePlan.enabled ? `Team Big Five adapter installed for: ${teamBigFivePlan.targets.join(', ')}` : 'Team Big Five adapter not requested',
    ],
  };

  const projectConfig = buildProjectConfig(targetRoot, teamBigFivePlan.projectConfig, {
    projectId: args.projectId,
    taskGraph: targetTaskGraphRef,
  });
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

function rebaseSpecSourceIntake(
  source,
  sourceIntakeRef,
  sourceSpecRef,
  sourceIntakeSha256,
) {
  const spec = loadJson(source);
  spec.source_intake = sourceIntakeRef;
  spec.source_intake_sha256 = sourceIntakeSha256;
  const targetExperienceRef = spec.visual_experience?.experience_spec_ref
    ? normalizePath(path.join(path.dirname(sourceSpecRef), 'experience-spec.json'))
    : null;
  if (targetExperienceRef) {
    spec.visual_experience.experience_spec_ref = 'experience-spec.json';
  }
  if (spec.approval_audit) {
    spec.approval_audit.approved_artifacts = [
      sourceSpecRef,
      ...(targetExperienceRef ? [targetExperienceRef] : []),
    ];
  }
  return `${JSON.stringify(spec, null, 2)}\n`;
}

function rebaseIntakeApprovalAuditContent(sourceContent, targetIntakeRef) {
  const intake = JSON.parse(Buffer.isBuffer(sourceContent)
    ? sourceContent.toString('utf8')
    : String(sourceContent));
  if (intake.approval_audit) {
    intake.approval_audit.approved_artifacts = [targetIntakeRef];
  }
  return `${JSON.stringify(intake, null, 2)}\n`;
}

function rebaseTaskGraphSourceSpec(source, sourceSpecRef) {
  const taskGraph = loadJson(source);
  taskGraph.sourceSpec = sourceSpecRef;
  const sourceText = readFileSync(source, 'utf8');
  const rewritten = sourceText.replace(/(\"sourceSpec\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"/, `$1${JSON.stringify(sourceSpecRef)}`);
  if (rewritten === sourceText) throw new Error(`could not rebase sourceSpec in ${source}`);
  return rewritten;
}

function assertNoConflicts(plan, overwrite) {
  if (overwrite) return;
  const conflicts = plan
    .filter((item) => existsSync(item.target) && (item.allowExisting !== true || !lstatSync(item.target).isFile()))
    .map((item) => normalizePath(item.targetRelative));
  if (conflicts.length) throw new Error(`target file(s) already exist; rerun with --overwrite to replace: ${conflicts.join(', ')}`);
}

function printPlan(plan, args, artifactsRoot, targetRoot, sourceInfo) {
  console.log(`Plan2Agent handoff ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`projectId: ${args.projectId}`);
  console.log(`mode: ${args.mode}`);
  console.log(`runTransfer: ${args.runTransfer}`);
  console.log(`aiTools: ${args.tools.length ? args.tools.join(',') : 'none'}`);
  if (args.tools.includes('codex')) console.log(`codexProfile: ${resolveCodexAgentProfile(args.codexProfile)}`);
  console.log(`teamBigFive: ${args.includeTeamBigFive ? args.teamBigFiveTargets.join(',') : 'none'}`);
  console.log(`sourceLayout: ${sourceInfo.kind}`);
  if (sourceInfo.iterationId) console.log(`sourceIterationId: ${sourceInfo.iterationId}`);
  console.log(`sourceArtifacts: ${artifactsRoot}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log('writes:');
  for (const item of plan) {
    const action = item.type === 'remove-file' ? 'remove' : item.type === 'write-json' || item.type === 'write-text' ? 'generate' : item.type === 'rewrite-json' || item.type === 'rewrite-text' ? 'copy+rewrite' : 'copy';
    const source = item.source ? normalizePath(path.relative(process.cwd(), item.source)) : '(generated)';
    console.log(`- ${action}: ${source} -> ${normalizePath(item.targetRelative)}`);
  }
  if (args.mode === 'move') {
    const supplementalCleanupSources = [...new Set(
      Array.isArray(plan.moveCleanupSources) ? plan.moveCleanupSources : [],
    )];
    console.log(
      `move cleanup: source files above${supplementalCleanupSources.length ? ' and supplemental sources below' : ''} will be removed after successful writes`,
    );
    for (const source of supplementalCleanupSources) {
      console.log(`- remove: ${normalizePath(path.relative(process.cwd(), source))}`);
    }
  }
  if (args.dryRun) console.log('dry-run: no files written');
}

function writePlanItem(item) {
  if (item.type === 'remove-file') {
    if (!existsSync(item.target)) return;
    if (!lstatSync(item.target).isFile()) {
      throw new Error(`handoff removal target is not a regular file: ${item.target}`);
    }
    if (sha256Value(readFileSync(item.target)) !== item.expectedSha256) {
      throw new Error(`handoff removal target changed after planning: ${item.target}`);
    }
    unlinkSync(item.target);
    return;
  }
  if (item.type === 'delete-file') {
    if (existsSync(item.target)) {
      if (item.safeTarget !== true || item.pruneRequested !== true || !item.installedSha256) {
        throw new Error(`refusing to remove an unverified retired file: ${item.target}`);
      }
      if (!lstatSync(item.target).isFile()) throw new Error(`retired target path is not a file: ${item.target}`);
      if (sha256Value(readFileSync(item.target)) !== item.installedSha256) {
        throw new Error(`retired file changed after preview and will not be removed: ${item.target}`);
      }
      unlinkSync(item.target);
    }
    return;
  }
  mkdirSync(path.dirname(item.target), { recursive: true });
  if (item.type === 'write-json') {
    writeFileSync(item.target, item.content ?? `${JSON.stringify(item.data, null, 2)}\n`, 'utf8');
  } else if (item.type === 'write-text') {
    writeFileSync(item.target, item.content, 'utf8');
  } else if (item.type === 'rewrite-json' || item.type === 'rewrite-text') {
    writeFileSync(item.target, item.transform(item.source), 'utf8');
  } else {
    copyFileSync(item.source, item.target);
  }
}

function writePlan(plan) {
  for (const item of plan) writePlanItem(item);
}

function lstatIfPresent(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function capturePlanTargetSnapshot(plan, targetRoot) {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const targetPaths = [...new Set(plan.map((item) => path.resolve(item.target)))];
  const existingDirectories = new Set();
  for (const targetPath of targetPaths) {
    let directory = path.dirname(targetPath);
    while (
      directory === resolvedTargetRoot
      || (
        path.relative(resolvedTargetRoot, directory)
        && !path.relative(resolvedTargetRoot, directory).startsWith('..')
        && !path.isAbsolute(path.relative(resolvedTargetRoot, directory))
      )
    ) {
      const stat = lstatIfPresent(directory);
      if (stat) {
        if (!stat.isDirectory()) {
          throw new Error(`handoff target ancestor must be a directory: ${directory}`);
        }
        existingDirectories.add(directory);
      }
      if (directory === resolvedTargetRoot) break;
      directory = path.dirname(directory);
    }
  }
  return {
    existingDirectories,
    targetPaths,
    files: targetPaths.map((filePath) => {
      const stat = lstatIfPresent(filePath);
      if (!stat) return { filePath, kind: 'absent' };
      if (!stat.isFile()) {
        throw new Error(`handoff target must be a regular file when it exists: ${filePath}`);
      }
      return {
        filePath,
        kind: 'file',
        contents: readFileSync(filePath),
        mode: stat.mode,
      };
    }),
  };
}

function restorePlanTargetSnapshot(snapshot, targetRoot) {
  const failures = [];
  for (const item of [...snapshot.files].reverse()) {
    try {
      if (item.kind === 'absent') {
        const stat = lstatIfPresent(item.filePath);
        if (!stat) continue;
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new Error('rollback target was created as a non-file');
        }
        unlinkSync(item.filePath);
        continue;
      }
      const stat = lstatIfPresent(item.filePath);
      if (stat) {
        if (!stat.isFile()) throw new Error('rollback target is no longer a file');
      } else {
        mkdirSync(path.dirname(item.filePath), { recursive: true });
      }
      writeFileSync(item.filePath, item.contents);
      chmodSync(item.filePath, item.mode);
    } catch (error) {
      failures.push(`${item.filePath}: ${error.message}`);
    }
  }

  const resolvedTargetRoot = path.resolve(targetRoot);
  const createdDirectories = new Set();
  for (const targetPath of snapshot.targetPaths) {
    let directory = path.dirname(targetPath);
    while (
      directory === resolvedTargetRoot
      || (
        path.relative(resolvedTargetRoot, directory)
        && !path.relative(resolvedTargetRoot, directory).startsWith('..')
        && !path.isAbsolute(path.relative(resolvedTargetRoot, directory))
      )
    ) {
      if (!snapshot.existingDirectories.has(directory)) createdDirectories.add(directory);
      if (directory === resolvedTargetRoot) break;
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    try {
      if (
        existsSync(directory)
        && lstatSync(directory).isDirectory()
        && readdirSync(directory).length === 0
      ) {
        rmdirSync(directory);
      }
    } catch (error) {
      failures.push(`${directory}: ${error.message}`);
    }
  }
  return failures;
}

function cleanupMovedSources(plan, artifactsRoot) {
  const artifactRootResolved = path.resolve(artifactsRoot);
  const sources = [...new Set([
    ...plan.filter((item) => item.source).map((item) => item.source),
    ...(Array.isArray(plan.moveCleanupSources) ? plan.moveCleanupSources : []),
  ]
    .map((source) => path.resolve(source))
    .filter((source) => {
      const relative = path.relative(artifactRootResolved, source);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }))];
  const stagingRoot = path.join(
    artifactRootResolved,
    `.handoff-move.${process.pid}.${randomUUID()}`,
  );
  const staged = [];
  try {
    mkdirSync(stagingRoot);
    for (const source of sources) {
      const relative = path.relative(artifactRootResolved, source);
      const stagedPath = path.join(stagingRoot, relative);
      mkdirSync(path.dirname(stagedPath), { recursive: true });
      renameSync(source, stagedPath);
      staged.push({ source, stagedPath });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const item of [...staged].reverse()) {
      try {
        if (!existsSync(item.stagedPath)) continue;
        mkdirSync(path.dirname(item.source), { recursive: true });
        renameSync(item.stagedPath, item.source);
      } catch (rollbackError) {
        rollbackFailures.push(`${item.source}: ${rollbackError.message}`);
      }
    }
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch (rollbackError) {
      rollbackFailures.push(`${stagingRoot}: ${rollbackError.message}`);
    }
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; move source rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    rmSync(stagingRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `WARNING: move completed, but staged source cleanup failed at ${stagingRoot}: ${error.message}`,
    );
  }
  for (const directory of ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph']) {
    const directoryPath = path.join(artifactRootResolved, directory);
    try {
      if (existsSync(directoryPath) && readdirSync(directoryPath).length === 0) {
        rmdirSync(directoryPath);
      }
    } catch (error) {
      console.warn(
        `WARNING: move completed, but empty source directory cleanup failed at ${directoryPath}: ${error.message}`,
      );
    }
  }
}

function recordSourceHandoffLocked(artifactsRoot, sourceInfo, record) {
  if (!record || !sourceInfo.currentSpecPath) return;
  const currentSpecBefore = readFileSync(sourceInfo.currentSpecPath);
  const statusPath = path.join(artifactsRoot, 'status.md');
  const statusBefore = !existsSync(statusPath)
    ? { kind: 'absent' }
    : lstatSync(statusPath).isFile()
      ? { kind: 'file', contents: readFileSync(statusPath) }
      : { kind: 'other' };
  const currentSpec = JSON.parse(currentSpecBefore.toString('utf8'));
  if (currentSpec.active_iteration !== sourceInfo.iterationId) {
    throw new ValidationError(
      `handoff source iteration changed while preparing the target: expected ${JSON.stringify(sourceInfo.iterationId)}, got ${JSON.stringify(currentSpec.active_iteration)}`,
    );
  }
  const nextCurrentSpec = appendHandoffRecord(currentSpec, record);
  const nextStatus = renderIterationIndexMarkdown(
    artifactsRoot,
    nextCurrentSpec,
  );
  try {
    atomicWriteJson(sourceInfo.currentSpecPath, nextCurrentSpec);
    atomicWriteText(statusPath, nextStatus);
  } catch (error) {
    const rollbackFailures = [];
    try {
      atomicWriteText(sourceInfo.currentSpecPath, currentSpecBefore);
    } catch (rollbackError) {
      rollbackFailures.push(`current-spec.json: ${rollbackError.message}`);
    }
    try {
      if (statusBefore.kind === 'file') {
        atomicWriteText(statusPath, statusBefore.contents);
      } else if (
        statusBefore.kind === 'absent'
        && existsSync(statusPath)
        && lstatSync(statusPath).isFile()
      ) {
        unlinkSync(statusPath);
      }
    } catch (rollbackError) {
      rollbackFailures.push(`status.md: ${rollbackError.message}`);
    }
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; source handoff record rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
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
    const approved = spec ? spec.approval === 'approved' : false;
    const openDecisions = Array.isArray(spec?.open_decisions) ? spec.open_decisions.length : null;
    return {
      statusDoc: true,
      a: validation.gates.a.present,
      b: validation.gates.b.present,
      c: validation.gates.c.present,
      approved,
      openDecisions,
      ready: validation.readyForHandoff,
    };
  } catch {
    return { statusDoc: false, a: false, b: false, c: false, approved: false, openDecisions: null, ready: false };
  }
}

function formatGateStatus(status, key) {
  return `${key.toUpperCase()}${status[key] ? '✅' : '⬜'}`;
}

function formatProjectItem(item, number) {
  if (item.manual) return `${number}) 직접 입력`;
  const status = item.status;
  const gates = ['a', 'b', 'c'].map((key) => formatGateStatus(status, key)).join(' ');
  const detail = status.ready
    ? '검증 통과 · 인계가능'
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
  if (missing.length) problems.push(`게이트 누락: ${missing.join(', ')}`);
  if (!status.approved) problems.push('미승인(spec.approval != approved)');
  if (status.openDecisions === null) problems.push('열린 결정 수 확인 불가');
  if (status.openDecisions > 0) problems.push(`open_decisions ${status.openDecisions}개`);
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

async function askToolTargets(rl) {
  console.log('tools - 대상 프로젝트에 복사할 P2A AI 도구 자산');
  console.log('입력 예: none, codex, claude, gemini, codex,claude,gemini, all');
  while (true) {
    const input = await rl.question('tools [none] (빈 입력=none, q=취소): ');
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === 'q') return null;
    if (trimmed === '') return [];
    try {
      return parseToolTargets(trimmed);
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function askTeamBigFiveTargets(rl, defaultTargets) {
  const defaultValue = defaultTargets.length ? defaultTargets.join(',') : 'all';
  console.log('team-bigfive-targets - Team Big Five adapter 설치 대상');
  console.log('입력 예: codex, claude, gemini, codex,claude,gemini, all');
  while (true) {
    const input = await rl.question(`team-bigfive-targets [${defaultValue}] (q=취소): `);
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === 'q') return null;
    try {
      return parseRequiredToolTargets(trimmed === '' ? defaultValue : trimmed, '--team-bigfive-targets');
    } catch (error) {
      console.log(error.message);
    }
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
    artifacts = await askRequired(rl, 'artifacts', '원본 산출물 디렉터리 (예: .plan2agent/artifacts/<id>)', path.join(P2A_ARTIFACTS_DIR, projectId));
    if (!artifacts) return null;
  } else {
    projectId = picked.projectId;
    artifacts = picked.artifactsRoot;
  }

  const target = await askRequired(rl, 'target', '개발 대상 디렉터리');
  if (!target) return null;
  const mode = await askMode(rl);
  if (!mode) return null;
  const includeIntake = await askYesNo(
    rl,
    'include-intake?',
    'canonical intake.json에서 명시적 Markdown export 생성',
    false,
  );
  if (includeIntake === null) return null;
  const tools = await askToolTargets(rl);
  if (tools === null) return null;
  const includeTeamBigFive = await askYesNo(rl, 'include-team-bigfive?', 'Team Big Five adapter 설치', false);
  if (includeTeamBigFive === null) return null;
  let teamBigFiveSource = null;
  let teamBigFiveTargets = [];
  if (includeTeamBigFive) {
    teamBigFiveSource = await askRequired(rl, 'team-bigfive-source', 'team-bigfive 원본 디렉터리 또는 Git URL');
    if (!teamBigFiveSource) return null;
    teamBigFiveTargets = await askTeamBigFiveTargets(rl, tools.length ? tools : TOOL_TARGET_ORDER);
    if (teamBigFiveTargets === null) return null;
  }
  const overwrite = await askYesNo(rl, 'overwrite?', '기존 대상 파일 덮어쓰기 허용', false);
  if (overwrite === null) return null;

  const argv = ['--project-id', projectId, '--artifacts', artifacts, '--target', target, '--mode', mode];
  if (includeIntake) argv.push('--include-intake');
  if (tools.length) argv.push('--tools', tools.join(','));
  if (includeTeamBigFive) {
    argv.push('--include-team-bigfive', '--team-bigfive-source', teamBigFiveSource, '--team-bigfive-targets', teamBigFiveTargets.join(','));
  }
  if (overwrite) argv.push('--overwrite');
  return argv;
}

function argvValue(argv, option) {
  const index = argv.indexOf(option);
  return index === -1 ? null : argv[index + 1];
}

function printNextSteps(targetRoot) {
  let config = null;
  let manifest = null;
  try {
    config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
  } catch {
    config = null;
  }
  try {
    manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  const nextCommand = manifest?.runtime?.mode === 'package'
    ? 'p2a next'
    : 'node .plan2agent/scripts/p2a.mjs next';
  console.log(`✅ 인계 완료 — ${targetRoot}`);
  console.log(`다음: cd ${targetRoot}`);
  console.log(`      ${nextCommand}`);
  console.log('      agent session: /p2a-next');
  console.log('참고: next가 반환한 CLI 또는 승인 행동만 검토 후 진행하고, 완료 뒤 next를 다시 실행하세요.');

  try {
    if (!config) throw new Error('missing config');
    if (['testCommand', 'lintCommand', 'typecheckCommand'].some((key) => config[key] === null)) {
      console.log('참고: test/lint/typecheck 명령이 비어 있으면 verify 시점에 다시 감지합니다. 명시 명령은 --save-config로 저장할 수 있습니다.');
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
  if (!process.argv[1]) return false;
  try {
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return P2A_PATHS.filename === path.resolve(process.argv[1]);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }

    const targetRoot = path.resolve(args.target);
    if (args.command === 'enhance') {
      if (!existsSync(targetRoot) || !lstatSync(targetRoot).isDirectory()) {
        throw new Error(`--target must be an existing scaffold project directory: ${targetRoot}`);
      }
      const plan = args.enhancement === 'dev-skills'
        ? buildEnhanceDevSkillsPlan(args, targetRoot)
        : buildEnhanceCapabilityPlan(args, targetRoot);
      assertEnhanceNoConflicts(plan, args.overwrite, args.enhancement);
      if (args.enhancement === 'dev-skills') printEnhanceDevSkillsPlan(plan, args, targetRoot);
      else printEnhanceCapabilityPlan(plan, args, targetRoot);
      if (args.dryRun) return 0;
      writePlan(plan);
      console.log(`enhance ${args.enhancement} complete`);
      return 0;
    }

    if (args.command === 'update' || args.command === 'upgrade') {
      if (!existsSync(targetRoot) || !lstatSync(targetRoot).isDirectory()) {
        throw new Error(`--target must be an existing scaffold project directory: ${targetRoot}`);
      }
      const report = buildUpgradeDryRunReport(args, targetRoot);
      if (args.apply) {
        const applyReport = buildUpgradeApplyReport(args, targetRoot, report);
        try {
          executeUpgradeApply(targetRoot, applyReport, report);
        } catch (error) {
          applyReport.status = 'failed';
          applyReport.error = errorDetail(error);
          applyReport.nextActions = ['Inspect the apply report, restore any partially applied files if needed, then rerun update/upgrade after resolving the failure.'];
        }
        const writtenReport = writeUpgradeApplyReport(targetRoot, publicUpgradeApplyReport(applyReport));
        printUpgradeApplyReport(writtenReport);
        return ['blocked', 'failed'].includes(writtenReport.status) ? 1 : 0;
      }
      const publicReport = publicUpgradeReport(report);
      if (args.dryRun) {
        printUpgradeDryRunReport(publicReport);
        const applyPreflightRequested = args.command === 'upgrade'
          && process.env[UPGRADE_APPLY_PREFLIGHT_ENV] === '1';
        const applyPreflightBlockers = applyPreflightRequested
          ? upgradeApplyBlockers(report)
          : [];
        if (applyPreflightRequested) {
          console.log(`apply-preflight: ${applyPreflightBlockers.length ? 'blocked' : 'ready'}`);
        }
        return publicReport.status === 'fail' || applyPreflightBlockers.length ? 1 : 0;
      }
      const writtenReport = writeUpgradePreviewReport(targetRoot, publicReport);
      printUpgradeDryRunReport(writtenReport);
      return writtenReport.status === 'fail' ? 1 : 0;
    }

    if (isInitializeCommand(args.command)) {
      if (existsSync(targetRoot) && !lstatSync(targetRoot).isDirectory()) {
        throw new Error(`--target must be a directory path, but a non-directory exists: ${targetRoot}`);
      }
      const plan = buildScaffoldPlan(args, targetRoot);
      assertNoConflicts(plan, args.overwrite);
      printScaffoldPlan(plan, args, targetRoot);
      if (args.dryRun) return 0;
      writePlan(plan);
      console.log(`${args.command} complete`);
      return 0;
    }

    const artifactsRoot = path.resolve(args.artifacts);
    if (!existsSync(artifactsRoot) || !lstatSync(artifactsRoot).isDirectory()) {
      throw new Error(`--artifacts must point to an existing directory: ${artifactsRoot}`);
    }
    if (existsSync(targetRoot) && !lstatSync(targetRoot).isDirectory()) {
      throw new Error(`--target must be a directory path, but a non-directory exists: ${targetRoot}`);
    }

    const executeHandoff = (sourceInfo = resolveHandoffSource(artifactsRoot, args)) => {
      const createdAt = new Date().toISOString();
      const maintenanceGraphPath = sourceInfo.kind === 'iteration'
        ? maintenanceTaskGraphSourcePath(artifactsRoot)
        : null;
      const maintenanceIncluded = Boolean(
        maintenanceGraphPath && existsSync(maintenanceGraphPath),
      );
      const record = sourceInfo.kind === 'iteration'
        ? handoffRecord(
            args,
            targetRoot,
            sourceInfo,
            maintenanceIncluded,
            maintenanceIncluded
              ? maintenanceTaskCount(maintenanceGraphPath)
              : 0,
            createdAt,
          )
        : null;
      const plan = buildPlan(
        sourceInfo.paths,
        args,
        artifactsRoot,
        targetRoot,
        sourceInfo,
        { record, createdAt },
      );
      assertNoConflicts(plan, args.overwrite);
      printPlan(plan, args, artifactsRoot, targetRoot, sourceInfo);
      if (args.dryRun) return 0;
      const targetSnapshot = capturePlanTargetSnapshot(plan, targetRoot);
      try {
        writePlan(plan);
        validatePortableHandoffTarget(targetRoot, args.projectId);
        if (sourceInfo.kind === 'iteration') {
          recordSourceHandoffLocked(artifactsRoot, sourceInfo, record);
        }
        if (args.mode === 'move') cleanupMovedSources(plan, artifactsRoot);
      } catch (error) {
        const rollbackFailures = restorePlanTargetSnapshot(targetSnapshot, targetRoot);
        if (rollbackFailures.length) {
          throw new Error(
            `${error.message}; handoff target rollback failed: ${rollbackFailures.join('; ')}`,
            { cause: error },
          );
        }
        throw error;
      }
      console.log('handoff complete');
      return 0;
    };

    if (!isIterativeArtifactRoot(artifactsRoot)) return executeHandoff();

    const initialSourceInfo = resolveHandoffSource(artifactsRoot, args);
    const maintenanceGraphPath = maintenanceTaskGraphSourcePath(artifactsRoot);
    const runsDir = path.join(artifactsRoot, 'runs');
    const lockDirs = [
      path.join(artifactsRoot, 'iterations'),
      path.dirname(initialSourceInfo.paths.taskGraph),
    ];
    if (existsSync(maintenanceGraphPath)) {
      lockDirs.push(path.dirname(maintenanceGraphPath));
    }
    if (existsSync(runsDir) && lstatSync(runsDir).isDirectory()) {
      lockDirs.push(runsDir);
    }
    return withRunStoreLocks(
      lockDirs,
      () => {
        const lockedSourceInfo = resolveHandoffSource(artifactsRoot, args);
        if (
          lockedSourceInfo.iterationId !== initialSourceInfo.iterationId
          || path.resolve(lockedSourceInfo.paths.taskGraph)
            !== path.resolve(initialSourceInfo.paths.taskGraph)
        ) {
          throw new ValidationError(
            'handoff source iteration changed while waiting for state locks; retry the command',
          );
        }
        return executeHandoff(lockedSourceInfo);
      },
    );
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
