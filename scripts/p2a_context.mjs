#!/usr/bin/env node
/** Emit one action/run-bound packet of canonical Plan2Agent execution references. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildNext } from './p2a.mjs';
import { resolveRuntimeContext } from './p2a_context_routes.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';
import { resolveRunsDir, runFilePath } from './p2a_run_paths.mjs';
import {
  loadJson,
  ValidationError,
  validateRunData,
  validateRunTaskContract,
  validateSchema,
} from './validate_artifacts.mjs';

const PACKET_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-packet.schema.json', import.meta.url),
  'utf8',
));
const P2A_PATHS = resolveP2aPaths(import.meta.url);
const CONTINUATIONS = Object.freeze({
  'execution.prepare': { activation: 'immediate', phase: 'prepare' },
  'execution.owner-start': { activation: 'after_command_success', phase: 'owner-start' },
  'execution.visual-review': { activation: 'after_command_success', phase: 'visual-review' },
  'execution.acceptance-review': { activation: 'after_command_success', phase: 'acceptance-review' },
});
const RUN_DECLARED_PHASES = new Set([
  'retry',
  'verify-closeout',
  'visual-review',
  'acceptance-review',
  'monitor',
]);

function usage() {
  return [
    'Usage:',
    '  p2a context show --artifacts <dir> --continuation <id> --provider codex|claude|gemini [--run-id <id>]',
    '  p2a context show --artifacts <dir> --phase <phase> --run-id <id> --provider codex|claude|gemini',
    '',
    'Options:',
    '  --target <dir>       Project root containing canonical provider assets. Default: cwd.',
    '  --skill <id>         Initial rollout supports p2a-dev-execution only.',
    '  --json --metadata-only  Emit schema-validated metadata without source bodies.',
    '  --help, -h',
  ].join('\n');
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] !== 'show') throw new Error(`unknown context command: ${argv[0]}`);
  const args = {
    help: false,
    command: 'show',
    target: P2A_PATHS.projectRoot,
    artifacts: null,
    provider: null,
    skill: 'p2a-dev-execution',
    continuation: null,
    phase: null,
    runId: null,
    json: false,
    metadataOnly: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--target') args.target = requiredValue(argv, ++index, arg);
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, arg);
    else if (arg === '--provider') args.provider = requiredValue(argv, ++index, arg);
    else if (arg === '--skill') args.skill = requiredValue(argv, ++index, arg);
    else if (arg === '--continuation') args.continuation = requiredValue(argv, ++index, arg);
    else if (arg === '--phase') args.phase = requiredValue(argv, ++index, arg);
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, arg);
    else if (arg === '--json') args.json = true;
    else if (arg === '--metadata-only') args.metadataOnly = true;
    else throw new Error(`unknown context option: ${arg}`);
  }
  if (args.help) return args;
  if (!args.artifacts) throw new Error('--artifacts is required');
  if (!args.provider) throw new Error('--provider is required');
  if (Boolean(args.continuation) === Boolean(args.phase)) {
    throw new Error('pass exactly one of --continuation or --phase');
  }
  if (args.phase && !args.runId) throw new Error('--phase requires --run-id');
  if (args.continuation && CONTINUATIONS[args.continuation]?.activation === 'after_command_success' && !args.runId) {
    throw new Error(`${args.continuation} requires --run-id from p2a.execution_result.v1`);
  }
  if (args.runId && args.continuation && CONTINUATIONS[args.continuation]?.activation === 'immediate') {
    throw new Error(`${args.continuation} does not accept --run-id`);
  }
  if (args.json !== args.metadataOnly) throw new Error('--json and --metadata-only must be used together');
  return args;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRoots(args) {
  const targetRoot = realpathSync(path.resolve(args.target));
  const artifactInput = path.resolve(args.artifacts);
  if (!existsSync(artifactInput) || !lstatSync(artifactInput).isDirectory()) {
    throw new Error(`--artifacts must be an existing directory: ${artifactInput}`);
  }
  if (lstatSync(artifactInput).isSymbolicLink()) throw new Error('--artifacts must not be a symbolic link');
  const artifactRoot = realpathSync(artifactInput);
  if (!pathIsInside(targetRoot, artifactRoot)) {
    throw new Error('--artifacts must stay inside --target');
  }
  return { targetRoot, artifactRoot };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJsonIfFile(filePath) {
  try {
    if (!lstatSync(filePath).isFile()) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function artifactIdentity(artifactRoot) {
  const currentSpec = readJsonIfFile(path.join(artifactRoot, 'current-spec.json'));
  const activeIteration = currentSpec?.active_iteration ?? null;
  const specPath = activeIteration
    ? path.join(artifactRoot, 'iterations', activeIteration, 'gate-b-spec', 'spec.json')
    : path.join(artifactRoot, 'gate-b-spec', 'spec.json');
  const spec = readJsonIfFile(specPath);
  const projectId = currentSpec?.project_id ?? spec?.project_id ?? path.basename(artifactRoot);
  return { projectId, activeIteration, specPath };
}

function artifactContractSources(artifactRoot, identity) {
  const candidates = [
    path.join(artifactRoot, 'current-spec.json'),
    path.join(artifactRoot, 'gate-a-intake', 'intake.json'),
    path.join(artifactRoot, 'gate-b-spec', 'spec.json'),
    path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'),
  ];
  if (identity.activeIteration) {
    const iterationRoot = path.join(artifactRoot, 'iterations', identity.activeIteration);
    candidates.push(
      path.join(iterationRoot, 'gate-a-intake', 'intake.json'),
      path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
      path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'),
    );
  }
  return [...new Set(candidates)]
    .filter((filePath) => {
      try {
        return lstatSync(filePath).isFile() && !lstatSync(filePath).isSymbolicLink();
      } catch {
        return false;
      }
    })
    .map((filePath) => ({
      ref: filePath.slice(artifactRoot.length + 1).replaceAll(path.sep, '/'),
      sha256: sha256(readFileSync(filePath)),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function actionBinding(targetRoot, artifactRoot, continuationId) {
  const definition = CONTINUATIONS[continuationId];
  if (!definition || definition.activation !== 'immediate') {
    throw new Error(`unknown immediate continuation: ${continuationId}`);
  }
  const identity = artifactIdentity(artifactRoot);
  const next = buildNext(targetRoot, identity.projectId, null, 'v2');
  if (
    next.continuation?.id !== continuationId
    || next.continuation?.activation !== 'immediate'
    || next.continuation?.sourceState !== next.state
  ) {
    throw new Error(`stale action: current next state ${next.state} does not activate ${continuationId}`);
  }
  const contract = {
    projectId: identity.projectId,
    iterationId: identity.activeIteration,
    sourceState: next.state,
    continuation: {
      id: next.continuation.id,
      activation: next.continuation.activation,
      skill: next.continuation.skill,
      phase: next.continuation.phase,
      mode: next.continuation.mode,
    },
    sources: artifactContractSources(artifactRoot, identity),
  };
  return {
    activation: definition.activation,
    phase: definition.phase,
    mode: next.continuation.mode,
    continuation: { id: continuationId, sourceState: next.state },
    binding: {
      kind: 'action',
      sourceState: next.state,
      artifactContractSha256: sha256(`${stableJson(contract)}\n`),
    },
  };
}

function loadStartedRun(artifactRoot, runId) {
  const runsDir = resolveRunsDir({ artifacts: artifactRoot });
  const runPath = runFilePath(runsDir, runId);
  if (!existsSync(runPath)) throw new Error(`unknown run: ${runId}`);
  const run = validateRunData(loadJson(runPath));
  if (run.status !== 'started') throw new Error(`run ${runId} must be started, got ${run.status}`);
  validateRunTaskContract(run, artifactRoot);
  if (!run.taskContractSha256) throw new Error(`run ${runId} has no taskContractSha256 binding`);
  return run;
}

function runEligibility(run) {
  return {
    runKind: run.runKind ?? null,
    visualContract: Boolean(run.visualReview?.required || run.executionEnvelope?.visualContract),
    acceptanceActive: Boolean(run.acceptanceReview?.required),
    monitorRequired: Boolean(run.monitorGate?.required),
  };
}

function runBinding(targetRoot, artifactRoot, args) {
  const run = loadStartedRun(artifactRoot, args.runId);
  let activation;
  let phase;
  let continuation = null;
  if (args.continuation) {
    const definition = CONTINUATIONS[args.continuation];
    if (!definition || definition.activation !== 'after_command_success') {
      throw new Error(`unknown after-command continuation: ${args.continuation}`);
    }
    const next = buildNext(targetRoot, run.projectId, null, 'v2');
    if (
      next.state !== 'run_started'
      || next.continuation?.id !== args.continuation
      || next.continuation?.activation !== 'after_command_success'
    ) {
      throw new Error(`stale command binding: current next state does not activate ${args.continuation}`);
    }
    activation = definition.activation;
    phase = definition.phase;
    continuation = { id: args.continuation, sourceState: next.state };
  } else {
    if (!RUN_DECLARED_PHASES.has(args.phase)) throw new Error(`unsupported run-declared phase: ${args.phase}`);
    activation = 'run_declared';
    phase = args.phase;
  }
  return {
    activation,
    phase,
    mode: run.mode ?? 'orchestrated',
    continuation,
    binding: {
      kind: 'run',
      runId: run.runId,
      taskId: run.taskId,
      taskContractSha256: run.taskContractSha256,
    },
    eligibility: runEligibility(run),
  };
}

function packetMetadata(args, resolvedBinding, resolvedContext) {
  const sources = resolvedContext.sources.map(({ routeId, path: sourcePath, sha256: sourceSha256, bytes }) => ({
    routeId,
    path: sourcePath,
    sha256: sourceSha256,
    bytes,
  }));
  const packet = {
    schema_version: 'p2a.context_packet.v1',
    provider: args.provider,
    skill: args.skill,
    phase: resolvedBinding.phase,
    activation: resolvedBinding.activation,
    mode: resolvedBinding.mode,
    continuation: resolvedBinding.continuation,
    binding: resolvedBinding.binding,
    sources,
    totalBytes: sources.reduce((total, source) => total + source.bytes, 0),
    generatedAt: new Date().toISOString(),
  };
  validateContextPacket(packet);
  return packet;
}

export function validateContextPacket(packet) {
  validateSchema(packet, PACKET_SCHEMA);
  if (
    packet.binding.kind === 'action'
    && packet.continuation.sourceState !== packet.binding.sourceState
  ) {
    throw new ValidationError('$.continuation.sourceState must equal $.binding.sourceState');
  }
  const expectedTotalBytes = packet.sources.reduce((total, source) => total + source.bytes, 0);
  if (packet.totalBytes !== expectedTotalBytes) {
    throw new ValidationError(`$.totalBytes must equal the source byte sum ${expectedTotalBytes}`);
  }
  const generatedAt = new Date(packet.generatedAt);
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== packet.generatedAt) {
    throw new ValidationError('$.generatedAt must be a valid canonical UTC timestamp');
  }
  const routeIds = packet.sources.map((source) => source.routeId);
  if (routeIds.length !== new Set(routeIds).size) {
    throw new ValidationError('$.sources routeId values must be unique');
  }
  const sourcePaths = packet.sources.map((source) => source.path);
  if (sourcePaths.length !== new Set(sourcePaths).size) {
    throw new ValidationError('$.sources path values must be unique');
  }
  return packet;
}

export function renderModelContextPacket(packet, resolvedSources) {
  const immutable = { ...packet };
  delete immutable.generatedAt;
  const lines = [
    'BEGIN PLAN2AGENT CONTEXT PACKET',
    stableJson(immutable),
  ];
  for (const source of resolvedSources) {
    lines.push(`BEGIN PLAN2AGENT SOURCE routeId=${source.routeId} path=${source.path} sha256=${source.sha256} bytes=${source.bytes}`);
    lines.push(source.body.endsWith('\n') ? source.body.slice(0, -1) : source.body);
    lines.push(`END PLAN2AGENT SOURCE routeId=${source.routeId}`);
  }
  lines.push('END PLAN2AGENT CONTEXT PACKET');
  return `${lines.join('\n')}\n`;
}

export function buildContextPacket(argsInput) {
  const args = { skill: 'p2a-dev-execution', ...argsInput };
  const { targetRoot, artifactRoot } = resolveRoots(args);
  const resolvedBinding = args.runId
    ? runBinding(targetRoot, artifactRoot, args)
    : actionBinding(targetRoot, artifactRoot, args.continuation);
  const resolvedContext = resolveRuntimeContext({
    targetRoot,
    provider: args.provider,
    skill: args.skill,
    phase: resolvedBinding.phase,
    mode: resolvedBinding.mode,
    eligibility: resolvedBinding.eligibility,
  });
  const packet = packetMetadata(args, resolvedBinding, resolvedContext);
  return {
    packet,
    modelPacket: renderModelContextPacket(packet, resolvedContext.sources),
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const result = buildContextPacket(args);
    if (args.json) console.log(JSON.stringify(result.packet, null, 2));
    else process.stdout.write(result.modelPacket);
    return 0;
  } catch (error) {
    console.error(`p2a context error: ${error.message}`);
    return 1;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) process.exitCode = main();
