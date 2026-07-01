#!/usr/bin/env node
/** Handoff approved Plan2Agent artifacts into a target project without executing build/install/codegen. */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import {
  loadJson,
  validateArtifactRoot,
  validateHandoffReadyArtifactRoot,
  validateReviewPass,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import { renderIterationIndexMarkdown } from './p2a_iteration.mjs';
import { P2A_ARTIFACTS_DIR, P2A_SCHEMAS_DIR, P2A_SCRIPTS_DIR, resolveP2aPaths } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.toolRoot;
const VALID_MODES = new Set(['copy', 'move']);
const TOOL_TARGET_ORDER = ['codex', 'claude', 'gemini'];
const VALID_TOOL_TARGETS = new Set(TOOL_TARGET_ORDER);
const ARTIFACT_TARGET_BASE = P2A_ARTIFACTS_DIR;
const TEAM_BIGFIVE_HARNESS_DIR = path.join('.plan2agent', 'team-harnesses', 'team-bigfive');
const TEAM_BIGFIVE_SOURCE_MANIFEST = path.join(TEAM_BIGFIVE_HARNESS_DIR, 'source-manifest.json');
const TEAM_BIGFIVE_ADAPTATION_NOTES = path.join(TEAM_BIGFIVE_HARNESS_DIR, 'adaptation-notes.md');
const DEFAULT_ITERATION_ID = 'active';

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_handoff.mjs scaffold --target <project-dir> [--tools <list>] [--overwrite] [--dry-run]',
    '  node scripts/p2a_handoff.mjs --project-id <id> --artifacts <path> --target <path> [options]',
    '',
    'Options:',
    'Scaffold:',
    '  scaffold             Install the full co-located P2A planning/development harness into a project.',
    '  --target <path>      Project directory to create or update.',
    '  --tools <list>       Copy portable P2A AI tool assets for codex,claude,gemini. Use comma list, all, or none. Default: all.',
    '',
    'Handoff options:',
    '  --mode copy|move     Copy artifacts by default; move removes source files after successful write.',
    '  --iteration-id <id>  Use iterative artifacts. Default: active when --artifacts is an iterative root.',
    '  --include-intake     Include generated gate-a-intake/intake.md when present (intake.json is always copied).',
    '  --tools <list>       Copy portable P2A AI tool assets for codex,claude,gemini. Use comma list or all.',
    '  --include-team-bigfive',
    '                       Install Team Big Five adapter files for selected CLI targets.',
    '  --team-bigfive-source <path-or-git-url>',
    '                       Record the Team Big Five source. Local directories are fingerprinted.',
    '  --team-bigfive-targets <list>',
    '                       Adapter targets for codex,claude,gemini. Defaults to --tools or all.',
    '  --overwrite          Allow replacing existing target files.',
    '  --dry-run            Validate and print the handoff plan without writing files.',
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

function isGitUrl(value) {
  return /^(https?|ssh|git):\/\//i.test(value) || /^git@[^:]+:.+/.test(value);
}

function parseArgs(argv) {
  const command = argv[0] === 'scaffold' ? argv.shift() : 'handoff';
  const args = {
    command,
    mode: 'copy',
    iterationId: DEFAULT_ITERATION_ID,
    iterationIdProvided: false,
    includeIntake: false,
    tools: command === 'scaffold' ? [...TOOL_TARGET_ORDER] : [],
    includeTeamBigFive: false,
    teamBigFiveSource: null,
    teamBigFiveTargets: null,
    overwrite: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (command === 'scaffold' && (arg === '--project-id' || arg === '--artifacts' || arg === '--mode' || arg === '--iteration-id' || arg === '--include-intake' || arg === '--include-team-bigfive' || arg === '--team-bigfive-source' || arg === '--team-bigfive-targets')) {
      throw new Error(`${arg} is not valid for scaffold`);
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
    } else if (arg === '--include-intake') {
      args.includeIntake = true;
    } else if (arg === '--tools') {
      args.tools = parseToolTargets(argv[++index]);
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
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (command === 'scaffold') {
    if (!args.target) throw new Error('--target is required');
    return args;
  }
  for (const required of ['projectId', 'artifacts', 'target']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required`);
  }
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
    reviewReport: path.join(iterationRoot, 'gate-d-review', 'review-report.md'),
    reviewJson: path.join(iterationRoot, 'gate-d-review', 'review.json'),
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
  const state = iterationIdArg === DEFAULT_ITERATION_ID
    ? resolveIterationState(artifactsRoot)
    : resolveIterationState(artifactsRoot, { requireReady: false });
  const iterationId = iterationIdArg === DEFAULT_ITERATION_ID ? state.activeIteration : iterationIdArg;
  const paths = iterationGatePaths(artifactsRoot, iterationId, state.currentSpecPath);

  assertFile(paths.currentSpec, 'current-spec.json');
  assertNoCurrentSpecOpenDecisions(state.currentSpec);
  assertFile(paths.specJson, `iterations/${iterationId}/gate-b-spec/spec.json`);
  assertFile(paths.taskGraph, `iterations/${iterationId}/gate-c-task-graph/task-graph.json`);
  assertFile(paths.reviewJson, `iterations/${iterationId}/gate-d-review/review.json`);

  const spec = validateSpec(paths.specJson);
  if (spec.approval !== 'approved') throw new ValidationError('handoff requires spec.approval to be approved');
  if (spec.open_decisions.length) throw new ValidationError('handoff requires spec.open_decisions to be empty');
  assertProjectId('spec.project_id', spec.project_id, projectId);

  const taskGraph = validateTaskGraph(paths.taskGraph, paths.specJson);
  assertProjectId('taskGraph.projectId', taskGraph.projectId, projectId);
  const review = validateReviewPass(paths.reviewJson);
  assertProjectId('review.projectId', review.projectId, projectId);

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

function pushArtifactIfExists(plan, source, targetRoot, targetRelative, options = {}) {
  if (!existsSync(source)) return false;
  assertFile(source, targetRelative);
  pushArtifact(plan, source, targetRoot, targetRelative, options);
  return true;
}

function maintenanceTaskGraphSourcePath(artifactsRoot) {
  return path.join(artifactsRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
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

function isPortableP2aTopLevelAsset(relativePath) {
  const [firstSegment] = normalizePath(relativePath).split('/');
  return isP2aTopLevelAsset(relativePath) && firstSegment !== 'p2a-design-system';
}

function isPortableGeminiP2aCommand(relativePath) {
  return normalizePath(relativePath) !== 'design-system.toml';
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
    pushArtifact(plan, source, targetRoot, targetRelative);
    files.push(normalizePath(targetRelative));
  }
  return files;
}

function selectedToolAssetSpecs(toolTargets) {
  if (!toolTargets.length) return [];
  const specs = [
    {
      key: 'common-skills',
      source: path.join('.agents', 'skills'),
      target: path.join('.agents', 'skills'),
      filter: isPortableP2aTopLevelAsset,
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
    });
  }
  if (toolTargets.includes('claude')) {
    specs.push(
      {
        key: 'claude-skills',
        source: path.join('.claude', 'skills'),
        target: path.join('.claude', 'skills'),
        filter: isPortableP2aTopLevelAsset,
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
        filter: isPortableGeminiP2aCommand,
      },
    );
  }
  return specs;
}

function pushToolAssets(plan, targetRoot, toolTargets) {
  const files = [];
  const groups = [];
  for (const spec of selectedToolAssetSpecs(toolTargets)) {
    const groupFiles = pushToolAssetDirectory(plan, targetRoot, spec.source, spec.target, { filter: spec.filter });
    files.push(...groupFiles);
    groups.push({ key: spec.key, source: normalizePath(spec.source), target: normalizePath(spec.target), files: groupFiles });
  }
  return { files, groups };
}

function pushGenerated(plan, targetRoot, targetRelative, type, content) {
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
  });
}

function pushGeneratedText(plan, targetRoot, targetRelative, text) {
  pushGenerated(plan, targetRoot, targetRelative, 'write-text', text.endsWith('\n') ? text : `${text}\n`);
}

function pushGeneratedJson(plan, targetRoot, targetRelative, data) {
  pushGenerated(plan, targetRoot, targetRelative, 'write-json', `${JSON.stringify(data, null, 2)}\n`);
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
- The task prompt from \`node .plan2agent/scripts/p2a_execute.mjs start --graph <task-graph> --task <task-id>\` or \`node .plan2agent/scripts/p2a_tasks.mjs prompt --graph <task-graph> <task-id>\`.
- Optional verification commands from \`.plan2agent/project.config.json\`.

## Workflow

1. Read the task prompt, acceptance criteria, source spec refs, and project config.
2. Split the work into five lanes: coordination, implementation plan, code changes, review, and verification.
3. Keep all work tied to the task id and source spec refs.
4. Do not edit approved Plan2Agent artifacts except through the task/status CLIs.
5. Track execution with \`node .plan2agent/scripts/p2a_execute.mjs start/finish/status\` or the lower-level \`node .plan2agent/scripts/p2a_runs.mjs start/verify/finish\` so runId, changed files, verification, agent tool, and workspace reference are preserved.
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

Do not modify .plan2agent/artifacts/* directly. Use .plan2agent/scripts/p2a_execute.mjs for supervised task lifecycle records, or .plan2agent/scripts/p2a_tasks.mjs and .plan2agent/scripts/p2a_runs.mjs for lower-level task state and run records. Do not run package install, destructive git commands, or external network operations unless the user explicitly approves them. When finished, report the run id, changed files, verification commands, results, and any remaining blockers. Target adapter: ${target}.`;
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
model: sonnet
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

function pushTeamBigFiveAdapter(plan, targetRoot, args) {
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

  const sourceManifest = teamBigFiveSourceManifest(sourceInfo, targets);
  pushGeneratedJson(plan, targetRoot, TEAM_BIGFIVE_SOURCE_MANIFEST, sourceManifest);
  files.push(normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST));
  pushGeneratedText(plan, targetRoot, TEAM_BIGFIVE_ADAPTATION_NOTES, teamBigFiveAdaptationNotes(sourceInfo, targets));
  files.push(normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES));
  groups.push({ key: 'team-bigfive-metadata', files: [normalizePath(TEAM_BIGFIVE_SOURCE_MANIFEST), normalizePath(TEAM_BIGFIVE_ADAPTATION_NOTES)] });

  const needsCommonSkill = targets.includes('codex') || targets.includes('gemini');
  if (needsCommonSkill) {
    const skillPath = path.join('.agents', 'skills', 'team-bigfive-kickoff', 'SKILL.md');
    pushGeneratedText(plan, targetRoot, skillPath, teamBigFiveSkillMarkdown());
    files.push(normalizePath(skillPath));
    groups.push({ key: 'team-bigfive-common-skill', files: [normalizePath(skillPath)] });
  }

  if (targets.includes('codex')) {
    const adapterFiles = [path.join('.codex', 'agents', 'team-bigfive-coordinator.toml')];
    pushGeneratedText(plan, targetRoot, adapterFiles[0], renderCodexTeamBigFiveAgent());
    files.push(...adapterFiles.map(normalizePath));
    groups.push({ key: 'team-bigfive-codex', files: adapterFiles.map(normalizePath) });
  }

  if (targets.includes('claude')) {
    const adapterFiles = [
      path.join('.claude', 'skills', 'team-bigfive-kickoff', 'SKILL.md'),
      path.join('.claude', 'agents', 'team-bigfive-coordinator.md'),
    ];
    pushGeneratedText(plan, targetRoot, adapterFiles[0], teamBigFiveSkillMarkdown());
    pushGeneratedText(plan, targetRoot, adapterFiles[1], renderClaudeTeamBigFiveAgent());
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
    pushGeneratedText(plan, targetRoot, adapterFiles[0], renderGeminiTeamBigFiveAgent());
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


const SCAFFOLD_SCRIPT_FILES = ['p2a_paths.mjs', 'p2a_iteration.mjs', 'p2a_tasks.mjs', 'p2a_runs.mjs', 'p2a_execute.mjs', 'p2a_orchestrate.mjs', 'p2a_proposals.mjs', 'p2a_run_paths.mjs', 'p2a_iteration_state.mjs', 'validate_artifacts.mjs'];
const SCAFFOLD_SCHEMA_FILES = ['intake.schema.json', 'spec.schema.json', 'task-graph.schema.json', 'task-context.schema.json', 'review.schema.json', 'run.schema.json', 'run-index.schema.json', 'orchestration-plan.schema.json', 'orchestration-runtime.schema.json', 'skill-proposal.schema.json', 'proposal-review.schema.json', 'proposal-curation.schema.json', 'proposal-patch-draft.schema.json', 'proposal-draft-approval.schema.json'];

function targetScriptPath(file) {
  return path.join(P2A_SCRIPTS_DIR, file);
}

function targetSchemaPath(file) {
  return path.join(P2A_SCHEMAS_DIR, file);
}

function targetArtifactDir(projectId) {
  return path.join(ARTIFACT_TARGET_BASE, projectId);
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

function renderPlan2AgentGuide() {
  return `# Plan2Agent Project Harness

This repository owns its Plan2Agent planning and development loop in-place.

## Start a greenfield plan

1. Open Claude Code, Codex, or Gemini in this directory and run:

   \`/p2a-harness "<one sentence idea>"\`

   Planning Gates A-D write artifacts under \`.plan2agent/artifacts/<project>/gate-*\`.

2. Convert approved planning artifacts into the iteration structure:

   \`node .plan2agent/scripts/p2a_iteration.mjs init --artifacts .plan2agent/artifacts/<project>\`

3. Develop from ready tasks and track execution:

   - \`node .plan2agent/scripts/p2a_execute.mjs plan|start|finish|status\`
   - \`node .plan2agent/scripts/p2a_orchestrate.mjs plan|handoff\`
   - \`node .plan2agent/scripts/p2a_proposals.mjs mine|review|curate|draft-patch|approve-draft|digest\`
   - \`node .plan2agent/scripts/p2a_tasks.mjs ready|prompt|start|done\`
   - \`node .plan2agent/scripts/p2a_runs.mjs start|verify|finish\`

4. Open the next iteration in this same project:

   \`node .plan2agent/scripts/p2a_iteration.mjs open|draft|context|promote-tasks\`

## Storage policy

The generated \`.plan2agent/\` directory is local harness state and is ignored by git.
Keep application/source commits focused on product code, and persist P2A planning and run
history through Plan2Agent Memory or an explicit export when needed.
`;
}

function buildScaffoldPlan(args, targetRoot, createdAt = new Date().toISOString()) {
  const plan = [];
  for (const file of SCAFFOLD_SCRIPT_FILES) {
    pushArtifact(plan, path.join(ROOT, 'scripts', file), targetRoot, targetScriptPath(file));
  }
  for (const file of SCAFFOLD_SCHEMA_FILES) {
    pushArtifact(plan, path.join(ROOT, 'schemas', file), targetRoot, targetSchemaPath(file));
  }
  const toolAssetPlan = pushToolAssets(plan, targetRoot, args.tools);
  const claudeCoarseDeny = args.tools.includes('claude') ? claudeCoarseDenyRules(targetRoot) : { omitted: [] };
  const scriptFiles = SCAFFOLD_SCRIPT_FILES.map((file) => normalizePath(targetScriptPath(file)));
  const schemaFiles = SCAFFOLD_SCHEMA_FILES.map((file) => normalizePath(targetSchemaPath(file)));
  const manifest = {
    schema_version: 'p2a.handoff.v1',
    provenance: { mode: 'scaffold', createdAt, toolkitRoot: ROOT },
    targetProject: targetRoot,
    createdAt,
    includedTools: [...SCAFFOLD_SCRIPT_FILES.map((file) => file.replace(/\.mjs$/, '')), ...args.tools.map((target) => `p2a_${target}_assets`)],
    aiToolTargets: args.tools,
    scriptFiles,
    schemaFiles,
    toolFiles: [...scriptFiles, ...toolAssetPlan.files],
    aiToolFiles: toolAssetPlan.files,
    aiToolGroups: toolAssetPlan.groups,
    notes: [
      'co-located scaffold: this project owns greenfield planning, development, and iteration artifacts',
      args.tools.length ? `AI tool assets copied for: ${args.tools.join(', ')}` : 'AI tool assets not requested',
    ],
  };
  if (args.tools.includes('claude')) {
    pushGeneratedJson(plan, targetRoot, path.join('.claude', 'settings.json'), buildClaudeProjectSettings(targetRoot));
    pushGeneratedJson(plan, targetRoot, path.join('.claude', 'settings.local.json'), buildClaudeLocalSettings());
  }
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'manifest.json'), manifest);
  pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'project.config.json'), buildProjectConfig(targetRoot, { enabled: false }, { emptyCommands: true }));
  pushGeneratedText(plan, targetRoot, '.gitignore', renderProjectGitignore());
  pushGeneratedText(plan, targetRoot, 'PLAN2AGENT.md', renderPlan2AgentGuide());
  plan.scaffoldWarnings = claudeCoarseDeny.omitted.map((prefix) => `Claude coarse deny ${prefix}/** omitted because targetProject is under that prefix; the PreToolUse hook enforces the workspace boundary instead.`);
  return plan;
}

function printScaffoldPlan(plan, args, targetRoot) {
  console.log(`Plan2Agent scaffold ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`aiTools: ${args.tools.length ? args.tools.join(',') : 'none'}`);
  console.log(`targetProject: ${targetRoot}`);
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

function buildPlan(paths, args, artifactsRoot, targetRoot, sourceInfo, options = {}) {
  const { record = null, createdAt = new Date().toISOString() } = options;
  const plan = [];
  const artifactTargetDir = targetArtifactDir(args.projectId);
  const targetIntakeRef = normalizePath(targetIntakeJsonPath(args.projectId));
  const targetSpecRef = normalizePath(targetSpecJsonPath(args.projectId));
  const targetTaskGraphRef = normalizePath(targetTaskGraphPath(args.projectId));
  pushArtifactIfExists(plan, paths.productSpec, targetRoot, path.join(artifactTargetDir, 'gate-b-spec', 'product-spec.md'));
  pushArtifactIfExists(plan, paths.implementationPlan, targetRoot, path.join(artifactTargetDir, 'gate-b-spec', 'implementation-plan.md'));
  pushArtifact(plan, paths.specJson, targetRoot, targetSpecJsonPath(args.projectId), { type: 'rewrite-json', transform: (source) => rebaseSpecSourceIntake(source, targetIntakeRef, targetSpecRef) });
  pushArtifact(plan, paths.taskGraph, targetRoot, targetTaskGraphPath(args.projectId), { type: 'rewrite-json', transform: (source) => rebaseTaskGraphSourceSpec(source, targetSpecRef) });
  pushArtifactIfExists(plan, paths.reviewReport, targetRoot, path.join(artifactTargetDir, 'gate-d-review', 'review-report.md'));
  pushArtifact(plan, paths.reviewJson, targetRoot, path.join(artifactTargetDir, 'gate-d-review', 'review.json'));

  assertFile(paths.intakeJson, 'gate-a-intake/intake.json');
  pushArtifact(plan, paths.intakeJson, targetRoot, targetIntakeJsonPath(args.projectId));
  if (args.includeIntake) {
    pushArtifactIfExists(plan, paths.intakeMd, targetRoot, path.join(artifactTargetDir, 'gate-a-intake', 'intake.md'));
  }

  const currentSpecForHandoff = record && sourceInfo.currentSpec
    ? appendHandoffRecord(sourceInfo.currentSpec, record)
    : null;
  if (currentSpecForHandoff) {
    pushGeneratedText(
      plan,
      targetRoot,
      path.join(artifactTargetDir, 'status.md'),
      renderIterationIndexMarkdown(artifactsRoot, currentSpecForHandoff),
    );
  } else {
    pushArtifactIfExists(plan, paths.statusDoc, targetRoot, path.join(artifactTargetDir, 'status.md'));
  }
  if (sourceInfo.currentSpecPath) {
    if (currentSpecForHandoff) {
      pushGeneratedJson(plan, targetRoot, path.join('.plan2agent', 'current-spec.json'), currentSpecForHandoff);
    } else {
      pushArtifact(plan, sourceInfo.currentSpecPath, targetRoot, path.join('.plan2agent', 'current-spec.json'));
    }
  }

  const maintenanceGraphPath = sourceInfo.kind === 'iteration' ? maintenanceTaskGraphSourcePath(artifactsRoot) : null;
  const maintenanceFiles = [];
  if (maintenanceGraphPath && existsSync(maintenanceGraphPath)) {
    validateTaskGraph(maintenanceGraphPath);
    const targetRelative = path.join('.plan2agent', 'maintenance', 'task-graph.json');
    pushArtifact(plan, maintenanceGraphPath, targetRoot, targetRelative);
    maintenanceFiles.push(normalizePath(targetRelative));
  }

  for (const file of SCAFFOLD_SCRIPT_FILES) {
    pushArtifact(plan, path.join(ROOT, 'scripts', file), targetRoot, targetScriptPath(file));
  }
  for (const schemaFile of ['intake.schema.json', 'spec.schema.json', 'task-graph.schema.json', 'task-context.schema.json', 'review.schema.json', 'run.schema.json', 'run-index.schema.json', 'orchestration-plan.schema.json', 'orchestration-runtime.schema.json', 'skill-proposal.schema.json', 'proposal-review.schema.json', 'proposal-curation.schema.json', 'proposal-patch-draft.schema.json', 'proposal-draft-approval.schema.json']) {
    pushArtifact(plan, path.join(ROOT, 'schemas', schemaFile), targetRoot, targetSchemaPath(schemaFile));
  }
  const toolAssetPlan = pushToolAssets(plan, targetRoot, args.tools);
  const teamBigFivePlan = pushTeamBigFiveAdapter(plan, targetRoot, args);

  const artifactFiles = plan
    .filter((item) => item.targetRelative.startsWith(`${artifactTargetDir}${path.sep}`) || item.targetRelative.startsWith(`${artifactTargetDir}/`))
    .map((item) => normalizePath(item.targetRelative));
  const schemaFiles = plan
    .filter((item) => item.targetRelative.startsWith(`${P2A_SCHEMAS_DIR}${path.sep}`) || item.targetRelative.startsWith(`${P2A_SCHEMAS_DIR}/`))
    .map((item) => normalizePath(item.targetRelative));
  const p2aToolFiles = SCAFFOLD_SCRIPT_FILES.map((file) => normalizePath(targetScriptPath(file)));
  const toolFiles = [
    ...p2aToolFiles,
    ...toolAssetPlan.files,
    ...teamBigFivePlan.files,
  ];
  const includedTools = SCAFFOLD_SCRIPT_FILES.map((file) => file.replace(/\.mjs$/, ''));
  for (const target of args.tools) includedTools.push(`p2a_${target}_assets`);
  if (teamBigFivePlan.enabled) includedTools.push('team_bigfive_adapter');

  const manifest = {
    schema_version: 'p2a.handoff.v1',
    projectId: args.projectId,
    sourceArtifacts: artifactsRoot,
    sourceLayout: sourceInfo.kind,
    sourceIterationId: sourceInfo.iterationId,
    targetProject: targetRoot,
    handoffMode: args.mode,
    createdAt,
    includedTools,
    aiToolTargets: args.tools,
    externalHarnesses: teamBigFivePlan.externalHarness ? [teamBigFivePlan.externalHarness] : [],
    artifactFiles,
    currentSpecFile: sourceInfo.currentSpecPath ? '.plan2agent/current-spec.json' : null,
    maintenanceFiles,
    toolFiles,
    aiToolFiles: toolAssetPlan.files,
    aiToolGroups: toolAssetPlan.groups,
    externalHarnessFiles: teamBigFivePlan.files,
    externalHarnessGroups: teamBigFivePlan.groups,
    schemaFiles,
    notes: [
      `task-graph.sourceSpec rebased to ${targetSpecRef}`,
      `spec.source_intake rebased to ${targetIntakeRef}`,
      sourceInfo.kind === 'iteration' ? `iteration handoff source: ${sourceInfo.iterationId}` : 'greenfield handoff source',
      args.tools.length ? `AI tool assets copied for: ${args.tools.join(', ')}` : 'AI tool assets not requested',
      teamBigFivePlan.enabled ? `Team Big Five adapter installed for: ${teamBigFivePlan.targets.join(', ')}` : 'Team Big Five adapter not requested',
    ],
  };

  const projectConfig = buildProjectConfig(targetRoot, teamBigFivePlan.projectConfig, {
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

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function rebaseSpecSourceIntake(source, sourceIntakeRef, sourceSpecRef) {
  const spec = loadJson(source);
  spec.source_intake = sourceIntakeRef;
  if (spec.approval_audit) {
    spec.approval_audit.approved_artifacts = [sourceSpecRef];
  }
  return `${JSON.stringify(spec, null, 2)}\n`;
}

function rebaseTaskGraphSourceSpec(source, sourceSpecRef) {
  const taskGraph = loadJson(source);
  taskGraph.sourceSpec = sourceSpecRef;
  const sourceText = readFileSync(source, 'utf8');
  const rewritten = sourceText.replace(/(\"sourceSpec\"\s*:\s*)\"(?:[^\"\\]|\\.)*\"/, `$1${JSON.stringify(sourceSpecRef)}`);
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

function buildProjectConfig(targetRoot, teamBigFiveConfig = { enabled: false }, options = {}) {
  const taskGraph = options.taskGraph ?? null;
  const providerNativeCapabilities = {
    codex: {
      skills: 'manual_check',
      customAgents: 'manual_check',
      explicitSubagentPrompt: 'manual_check',
    },
    claude: {
      subagents: 'manual_check',
      skills: 'manual_check',
      agentTeams: 'manual_check',
    },
    gemini: {
      extensions: 'manual_check',
      customCommands: 'manual_check',
      geminiContext: 'manual_check',
    },
  };
  if (options.emptyCommands) {
    return {
      schema_version: 'p2a.project_config.v1',
      packageManager: null,
      installCommand: null,
      testCommand: null,
      lintCommand: null,
      typecheckCommand: null,
      taskGraph,
      runTracking: {
        runsDir: '.plan2agent/runs',
        defaultIsolation: 'none',
        branchPattern: 'p2a/<taskId>-<runId>',
        worktreePattern: '../.worktrees/<taskId>-<runId>',
      },
      teamBigFive: teamBigFiveConfig,
      providerNativeCapabilities,
      notes: ['TODO: fill install/test/lint/typecheck commands after project stack is chosen'],
    };
  }
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
    taskGraph,
    runTracking: {
      runsDir: '.plan2agent/runs',
      defaultIsolation: 'none',
      branchPattern: 'p2a/<taskId>-<runId>',
      worktreePattern: '../.worktrees/<taskId>-<runId>',
    },
    teamBigFive: teamBigFiveConfig,
    providerNativeCapabilities,
    notes,
  };
}

function assertNoConflicts(plan, overwrite) {
  if (overwrite) return;
  const conflicts = plan.filter((item) => existsSync(item.target)).map((item) => normalizePath(item.targetRelative));
  if (conflicts.length) throw new Error(`target file(s) already exist; rerun with --overwrite to replace: ${conflicts.join(', ')}`);
}

function printPlan(plan, args, artifactsRoot, targetRoot, sourceInfo) {
  console.log(`Plan2Agent handoff ${args.dryRun ? 'dry run' : 'plan'}`);
  console.log(`projectId: ${args.projectId}`);
  console.log(`mode: ${args.mode}`);
  console.log(`aiTools: ${args.tools.length ? args.tools.join(',') : 'none'}`);
  console.log(`teamBigFive: ${args.includeTeamBigFive ? args.teamBigFiveTargets.join(',') : 'none'}`);
  console.log(`sourceLayout: ${sourceInfo.kind}`);
  if (sourceInfo.iterationId) console.log(`sourceIterationId: ${sourceInfo.iterationId}`);
  console.log(`sourceArtifacts: ${artifactsRoot}`);
  console.log(`targetProject: ${targetRoot}`);
  console.log('writes:');
  for (const item of plan) {
    const action = item.type === 'write-json' || item.type === 'write-text' ? 'generate' : item.type === 'rewrite-json' ? 'copy+rewrite' : 'copy';
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
      writeFileSync(item.target, item.content ?? `${JSON.stringify(item.data, null, 2)}\n`, 'utf8');
    } else if (item.type === 'write-text') {
      writeFileSync(item.target, item.content, 'utf8');
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

function recordSourceHandoff(artifactsRoot, sourceInfo, record) {
  if (!record || !sourceInfo.currentSpecPath) return;
  const currentSpec = loadJson(sourceInfo.currentSpecPath);
  const nextCurrentSpec = appendHandoffRecord(currentSpec, record);
  writeFileSync(sourceInfo.currentSpecPath, `${JSON.stringify(nextCurrentSpec, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(artifactsRoot, 'status.md'), renderIterationIndexMarkdown(artifactsRoot, nextCurrentSpec), 'utf8');
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
  const includeIntake = await askYesNo(rl, 'include-intake?', 'gate-a-intake 산출물도 포함', false);
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

function artifactRootFromTaskGraphRef(taskGraphRef) {
  if (!taskGraphRef) return '.plan2agent/artifacts/<projectId>';
  const graphDir = path.dirname(taskGraphRef);
  if (path.basename(graphDir) !== 'gate-c-task-graph') return path.dirname(taskGraphRef);
  const parent = path.dirname(graphDir);
  const parentBase = path.basename(parent);
  if (parentBase === 'maintenance' || parentBase.startsWith('iter-')) {
    const iterationsDir = path.dirname(parent);
    if (path.basename(iterationsDir) === 'iterations') return normalizePath(path.dirname(iterationsDir));
  }
  return normalizePath(parent);
}

function printNextSteps(targetRoot) {
  let config = null;
  try {
    config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
  } catch {
    config = null;
  }
  const sourceArg = config?.taskGraph
    ? `--graph ${normalizePath(config.taskGraph)}`
    : '--graph .plan2agent/artifacts/<projectId>/gate-c-task-graph/task-graph.json';
  const artifactRoot = artifactRootFromTaskGraphRef(config?.taskGraph);
  console.log(`✅ 인계 완료 — ${targetRoot}`);
  console.log(`다음: cd ${targetRoot}`);
  console.log(`      node .plan2agent/scripts/p2a_execute.mjs plan ${sourceArg} --task <task-id>`);
  console.log(`      node .plan2agent/scripts/p2a_orchestrate.mjs plan ${sourceArg} --task <task-id> --output .plan2agent/orchestration/<task-id>.json`);
  console.log(`      node .plan2agent/scripts/p2a_execute.mjs start ${sourceArg} --task <task-id> --agent-tool <tool>`);
  console.log(`      node .plan2agent/scripts/p2a_execute.mjs finish ${sourceArg} --run-id <run-id> --test --lint --typecheck`);
  console.log(`      node .plan2agent/scripts/p2a_proposals.mjs mine ${sourceArg}`);
  console.log('      node .plan2agent/scripts/p2a_proposals.mjs review --proposals .plan2agent/proposals');
  console.log('      node .plan2agent/scripts/p2a_proposals.mjs curate --review .plan2agent/proposals/reviews/<review-id>.json');
  console.log('      node .plan2agent/scripts/p2a_proposals.mjs draft-patch --curation .plan2agent/proposals/curations/<curation-id>.json --candidate-id <candidate-id>');
  console.log(`      node .plan2agent/scripts/p2a_proposals.mjs approve-draft --draft .plan2agent/proposals/patch-drafts/<draft-id>.json --artifacts ${artifactRoot} --approved-by <name>`);
  console.log('참고: 이 next step은 legacy handoff 대상용입니다. co-located scaffold 프로젝트는 Gate D 이후 p2a_iteration init을 먼저 실행하고 --artifacts를 사용하세요.');

  try {
    if (!config) throw new Error('missing config');
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
    if (args.command === 'scaffold') {
      if (existsSync(targetRoot) && !lstatSync(targetRoot).isDirectory()) {
        throw new Error(`--target must be a directory path, but a non-directory exists: ${targetRoot}`);
      }
      const plan = buildScaffoldPlan(args, targetRoot);
      assertNoConflicts(plan, args.overwrite);
      printScaffoldPlan(plan, args, targetRoot);
      if (args.dryRun) return 0;
      writePlan(plan);
      console.log('scaffold complete');
      return 0;
    }

    const artifactsRoot = path.resolve(args.artifacts);
    if (!existsSync(artifactsRoot) || !lstatSync(artifactsRoot).isDirectory()) {
      throw new Error(`--artifacts must point to an existing directory: ${artifactsRoot}`);
    }
    if (existsSync(targetRoot) && !lstatSync(targetRoot).isDirectory()) {
      throw new Error(`--target must be a directory path, but a non-directory exists: ${targetRoot}`);
    }

    const sourceInfo = resolveHandoffSource(artifactsRoot, args);
    const createdAt = new Date().toISOString();
    const maintenanceGraphPath = sourceInfo.kind === 'iteration' ? maintenanceTaskGraphSourcePath(artifactsRoot) : null;
    const maintenanceIncluded = Boolean(maintenanceGraphPath && existsSync(maintenanceGraphPath));
    const record = sourceInfo.kind === 'iteration'
      ? handoffRecord(args, targetRoot, sourceInfo, maintenanceIncluded, maintenanceIncluded ? maintenanceTaskCount(maintenanceGraphPath) : 0, createdAt)
      : null;
    const plan = buildPlan(sourceInfo.paths, args, artifactsRoot, targetRoot, sourceInfo, { record, createdAt });
    assertNoConflicts(plan, args.overwrite);
    printPlan(plan, args, artifactsRoot, targetRoot, sourceInfo);
    if (args.dryRun) return 0;
    writePlan(plan);
    recordSourceHandoff(artifactsRoot, sourceInfo, record);
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
