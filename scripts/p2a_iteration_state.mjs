#!/usr/bin/env node
/** Resolve the active Plan2Agent iteration from an iterative artifact root. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {
  loadJson,
  resolveSpecSourceIntake,
  validateCurrentSpecGateBApprovalAudit,
  validateSpec,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';
import {
  composeCanonicalSpecSources,
  canonicalComposedBaselineSnapshotRef,
  compositionReplayContractError,
  compositionSourceContractError,
  IMPLEMENTATION_FIELDS,
  isComposedBaselineReference,
  PRODUCT_FIELDS,
} from './p2a_spec_model.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
export const ROOT = P2A_PATHS.projectRoot;

function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new ValidationError(`${label} does not exist: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new ValidationError(`${label} is not a directory: ${dirPath}`);
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new ValidationError(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new ValidationError(`${label} is not a file: ${filePath}`);
}

function assertFileInsideArtifactRoot(filePath, artifactRoot, label) {
  const rootRealPath = realpathSync(artifactRoot);
  const fileRealPath = realpathSync(filePath);
  const relativePath = path.relative(rootRealPath, fileRealPath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new ValidationError(`${label} must resolve inside the artifact root`);
  }
}

function assertSafeIterationId(
  iterationId,
  label = 'current-spec.json active_iteration',
) {
  if (typeof iterationId !== 'string' || iterationId.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (iterationId.includes('/') || iterationId.includes('\\') || iterationId === '.' || iterationId === '..') {
    throw new ValidationError(`${label} must be a safe single path segment, got ${JSON.stringify(iterationId)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(iterationId)) {
    throw new ValidationError(`${label} may only contain letters, numbers, dots, underscores, and hyphens, got ${JSON.stringify(iterationId)}`);
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new ValidationError(`${label}[${index}] must be a string`);
    }
  }
}

function validateEffectiveSections(product, implementation) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw new ValidationError('current-spec.json effective_product must be an object');
  }
  assertString(product.problem, 'current-spec.json effective_product.problem');
  for (const field of PRODUCT_FIELDS.filter((candidate) => candidate !== 'problem')) {
    assertStringArray(product[field], `current-spec.json effective_product.${field}`);
  }
  if (!implementation || typeof implementation !== 'object' || Array.isArray(implementation)) {
    throw new ValidationError('current-spec.json effective_implementation must be an object');
  }
  for (const field of IMPLEMENTATION_FIELDS) {
    assertStringArray(
      implementation[field],
      `current-spec.json effective_implementation.${field}`,
    );
  }
}

function optionalIterationMetadata(artifactRoot, iterationId) {
  const metadataPath = path.join(
    artifactRoot,
    'iterations',
    iterationId,
    'iteration.json',
  );
  return existsSync(metadataPath) ? loadJson(metadataPath) : null;
}

function expectedCompositionSourceStatus(currentSpec, source, metadata) {
  if (metadata?.status === 'archived' || source.iteration_id !== currentSpec.active_iteration) {
    return 'archived';
  }
  return 'close-ready';
}

function validateCompositionSourceReadiness(
  currentSpec,
  source,
  specPath,
  artifactRoot,
  metadata,
) {
  const iterationRoot = path.join(artifactRoot, 'iterations', source.iteration_id);
  const taskGraphPath = path.join(
    iterationRoot,
    'gate-c-task-graph',
    'task-graph.json',
  );
  assertFile(taskGraphPath, `current-spec.json source_specs ${source.iteration_id} task graph`);
  assertFileInsideArtifactRoot(
    taskGraphPath,
    artifactRoot,
    `current-spec.json source_specs ${source.iteration_id} task graph`,
  );
  const taskGraph = validateTaskGraph(taskGraphPath, specPath);
  if (taskGraph.projectId !== currentSpec.project_id) {
    throw new ValidationError(
      `current-spec.json source_specs ${source.iteration_id} task graph project mismatch`,
    );
  }
  const taskGraphSpecPath = resolveFileReference(
    taskGraph.sourceSpec,
    path.dirname(taskGraphPath),
  );
  assertFile(
    taskGraphSpecPath,
    `current-spec.json source_specs ${source.iteration_id} task graph sourceSpec`,
  );
  assertFileInsideArtifactRoot(
    taskGraphSpecPath,
    artifactRoot,
    `current-spec.json source_specs ${source.iteration_id} task graph sourceSpec`,
  );
  if (realpathSync(taskGraphSpecPath) !== realpathSync(specPath)) {
    throw new ValidationError(
      `current-spec.json source_specs ${source.iteration_id} task graph must reference its source spec`,
    );
  }
  const incomplete = taskGraph.tasks.filter((task) => task.status !== 'done');
  if (incomplete.length) {
    throw new ValidationError(
      `current-spec.json source_specs ${source.iteration_id} must be close-ready; incomplete tasks: ${incomplete.map((task) => `${task.id}:${task.status}`).join(', ')}`,
    );
  }
  const expectedStatus = expectedCompositionSourceStatus(
    currentSpec,
    source,
    metadata,
  );
  if (source.status !== expectedStatus) {
    throw new ValidationError(
      `current-spec.json source_specs ${source.iteration_id} status must be ${expectedStatus}, got ${JSON.stringify(source.status)}`,
    );
  }
}

export function validateCurrentSpecCompositionData(
  currentSpec,
  artifactRoot,
  options = {},
) {
  const openDecisions = currentSpec.open_decisions ?? [];
  if (!Array.isArray(openDecisions)) {
    throw new ValidationError('current-spec.json open_decisions must be an array');
  }
  if (options.requireNoOpenDecisions && openDecisions.length) {
    throw new ValidationError(
      `current-spec.json open_decisions contains unresolved entries: ${JSON.stringify(openDecisions.map((decision) => decision.id ?? decision))}`,
    );
  }

  const hasCompositionFields = Object.hasOwn(currentSpec, 'source_specs')
    || Object.hasOwn(currentSpec, 'effective_product')
    || Object.hasOwn(currentSpec, 'effective_implementation')
    || currentSpec.effective_spec_ref === 'current-spec.json';
  if (!hasCompositionFields) return currentSpec;
  if (currentSpec.effective_spec_ref !== 'current-spec.json') {
    throw new ValidationError(
      'current-spec.json effective_spec_ref must be "current-spec.json" for composition',
    );
  }
  if (!Array.isArray(currentSpec.source_specs) || !currentSpec.source_specs.length) {
    throw new ValidationError(
      'current-spec.json source_specs must be a non-empty array for composition',
    );
  }
  if (!Array.isArray(currentSpec.composed_from) || !currentSpec.composed_from.length) {
    throw new ValidationError(
      'current-spec.json composed_from must be a non-empty array for composition',
    );
  }
  const sourceIterationIds = currentSpec.source_specs.map((source) => source.iteration_id);
  if (!jsonEqual(sourceIterationIds, currentSpec.composed_from)) {
    throw new ValidationError(
      'current-spec.json composed_from must match source_specs iteration order',
    );
  }
  validateEffectiveSections(
    currentSpec.effective_product,
    currentSpec.effective_implementation,
  );

  const validatedSources = [];
  const sourceRealPaths = new Set();
  for (const source of currentSpec.source_specs) {
    assertString(
      source.iteration_id,
      'current-spec.json source_specs[].iteration_id',
    );
    assertSafeIterationId(
      source.iteration_id,
      'current-spec.json source_specs[].iteration_id',
    );
    assertString(
      source.spec_ref,
      `current-spec.json source_specs ${source.iteration_id}.spec_ref`,
    );
    const specPath = resolveFileReference(source.spec_ref, artifactRoot);
    assertFile(
      specPath,
      `current-spec.json source_specs ${source.iteration_id}.spec_ref`,
    );
    assertFileInsideArtifactRoot(
      specPath,
      artifactRoot,
      `current-spec.json source_specs ${source.iteration_id}.spec_ref`,
    );
    const canonicalSpecRef = `iterations/${source.iteration_id}/gate-b-spec/spec.json`;
    const normalizedSpecRef = source.spec_ref
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (normalizedSpecRef !== canonicalSpecRef) {
      throw new ValidationError(
        `current-spec.json source ${source.iteration_id} spec_ref must be ${canonicalSpecRef}`,
      );
    }
    const specRealPath = realpathSync(specPath);
    if (sourceRealPaths.has(specRealPath)) {
      throw new ValidationError(
        'current-spec.json source_specs must reference unique spec files',
      );
    }
    sourceRealPaths.add(specRealPath);
    const spec = validateSpec(specPath, null, { artifactRoot });
    if (spec.project_id !== currentSpec.project_id) {
      throw new ValidationError(
        `current-spec.json source_specs ${source.iteration_id} project_id mismatch`,
      );
    }
    if (spec.approval !== 'approved') {
      throw new ValidationError(
        `current-spec.json source_specs ${source.iteration_id} must reference an approved spec`,
      );
    }
    if (source.approval !== undefined && source.approval !== spec.approval) {
      throw new ValidationError(
        `current-spec.json source_specs ${source.iteration_id} approval does not match source spec`,
      );
    }
    const metadata = optionalIterationMetadata(artifactRoot, source.iteration_id);
    if (
      metadata
      && (
        metadata.iteration_id !== source.iteration_id
        || metadata.project_id !== currentSpec.project_id
      )
    ) {
      throw new ValidationError(
        `current-spec.json source_specs ${source.iteration_id} iteration metadata mismatch`,
      );
    }
    validateCompositionSourceReadiness(
      currentSpec,
      source,
      specPath,
      artifactRoot,
      metadata,
    );
    const sourceIntakePath = resolveSpecSourceIntake(specPath, spec);
    const sourceIntake = sourceIntakePath ? loadJson(sourceIntakePath) : null;
    validatedSources.push({
      ...source,
      spec,
      metadata,
      source_intake: sourceIntake,
    });
  }

  const sourceContractError = compositionSourceContractError(validatedSources);
  if (sourceContractError) {
    throw new ValidationError(`current-spec.json ${sourceContractError}`);
  }
  const replayedComposition = composeCanonicalSpecSources(validatedSources);
  if (
    options.requireNoOpenDecisions
    && replayedComposition.compositionConflicts.length
  ) {
    throw new ValidationError(
      'current-spec.json has unresolved stale-baseline composition conflicts',
    );
  }
  if (
    !jsonEqual(currentSpec.effective_product, replayedComposition.effectiveProduct)
    || !jsonEqual(
      currentSpec.effective_implementation,
      replayedComposition.effectiveImplementation,
    )
  ) {
    throw new ValidationError(
      'current-spec.json effective sections must exactly match ordered source composition',
    );
  }
  const replayContractError = compositionReplayContractError(
    currentSpec,
    replayedComposition,
  );
  if (replayContractError) {
    throw new ValidationError(`current-spec.json ${replayContractError}`);
  }
  return currentSpec;
}

export function normalizeArtifactRoot(artifactPath, cwd = process.cwd()) {
  return path.resolve(cwd, artifactPath);
}

export function validateMaintenanceTaskGraphProject(state, graph) {
  if (graph.projectId !== state.projectId) {
    throw new ValidationError(
      `maintenance taskGraph.projectId ${JSON.stringify(graph.projectId)} must match current-spec.json project_id ${JSON.stringify(state.projectId)}`,
    );
  }
  return graph;
}

function resolveFileReference(reference, baseDir, fallbackDir = ROOT) {
  if (!reference || typeof reference !== 'string') return null;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(baseDir, reference),
        path.resolve(fallbackDir, reference),
      ];
  return candidates.find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? candidates[0];
}

export function resolveTaskGraphSourceSpec(taskGraph, taskGraphPath) {
  return resolveFileReference(taskGraph.sourceSpec, path.dirname(taskGraphPath));
}

function resolveEffectiveSpecPath(currentSpec, artifactRoot, currentSpecPath) {
  if (!currentSpec.effective_spec_ref) return currentSpecPath;
  return resolveFileReference(currentSpec.effective_spec_ref, artifactRoot);
}

function assertSameFile(actualPath, expectedPath, label) {
  if (path.resolve(actualPath) !== path.resolve(expectedPath)) {
    throw new ValidationError(`${label} must resolve to ${expectedPath}, got ${actualPath}`);
  }
}

function normalizeReference(reference) {
  return String(reference).replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizedRelative(fromPath, toPath) {
  return path.relative(fromPath, toPath).split(path.sep).join('/');
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function normalizeDisplayPath(reference) {
  return String(reference).split(path.sep).join('/');
}

function activeIntakePath(state) {
  return path.join(state.iterationRoot, 'gate-a-intake', 'intake.json');
}

function assertIntakeBaselineMatchesPending(
  intake,
  baselineSpecRef,
  baselineSpecPath,
  artifactRoot,
  baselineSpecSha256 = null,
) {
  if (!baselineSpecRef) {
    if (intake.baseline_context) {
      throw new ValidationError(
        'greenfield Gate A intake must not define baseline_context when the pending iteration has no baseline',
      );
    }
    return;
  }
  if (!intake.baseline_context?.spec_ref) {
    throw new ValidationError(
      'baseline-aware Gate A intake must preserve baseline_context.spec_ref',
    );
  }
  if (
    normalizeDisplayPath(intake.baseline_context.spec_ref)
    !== normalizeDisplayPath(baselineSpecRef)
  ) {
    throw new ValidationError(
      `intake baseline_context.spec_ref ${JSON.stringify(intake.baseline_context.spec_ref)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }
  const intakeBaselineSpecPath = resolveFileReference(
    intake.baseline_context.spec_ref,
    artifactRoot,
  );
  assertFile(intakeBaselineSpecPath, 'intake baseline_context.spec_ref');
  assertFileInsideArtifactRoot(
    intakeBaselineSpecPath,
    artifactRoot,
    'intake baseline_context.spec_ref',
  );
  if (realpathSync(intakeBaselineSpecPath) !== realpathSync(baselineSpecPath)) {
    throw new ValidationError(
      `intake baseline_context.spec_ref ${JSON.stringify(intake.baseline_context.spec_ref)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }
  if (
    baselineSpecSha256
    && intake.baseline_context.spec_sha256 !== baselineSpecSha256
  ) {
    throw new ValidationError(
      'intake baseline_context.spec_sha256 must match the pending baseline hash',
    );
  }
}

function assertPendingBaselineIntegrity(
  state,
  pending,
  metadata,
  baselineSpecRef,
  baselineSpecPath,
) {
  const metadataBaselineRef = metadata.baseline?.effective_spec_ref;
  if (normalizeDisplayPath(metadataBaselineRef) !== normalizeDisplayPath(baselineSpecRef)) {
    throw new ValidationError(
      `iteration metadata baseline ${JSON.stringify(metadataBaselineRef)} must match pending baseline ${JSON.stringify(baselineSpecRef)}`,
    );
  }

  const pendingHash = pending.baseline_effective_spec_sha256;
  const metadataHash = metadata.baseline?.effective_spec_sha256;
  const pendingHasHash = Object.hasOwn(
    pending,
    'baseline_effective_spec_sha256',
  );
  const metadataHasHash = Object.hasOwn(
    metadata.baseline ?? {},
    'effective_spec_sha256',
  );
  if (pendingHasHash !== metadataHasHash) {
    throw new ValidationError(
      'pending and iteration metadata must both record the baseline effective spec hash',
    );
  }
  if (
    pendingHasHash
    && (
      typeof pendingHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(pendingHash)
      || typeof metadataHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(metadataHash)
    )
  ) {
    throw new ValidationError(
      'pending and iteration metadata baseline effective spec hashes must be lowercase SHA-256 values',
    );
  }
  if (pendingHasHash && pendingHash !== metadataHash) {
    throw new ValidationError(
      'pending and iteration metadata baseline effective spec hashes must match',
    );
  }
  const expectedHash = pendingHasHash ? pendingHash : null;
  if (expectedHash !== null && fileSha256(baselineSpecPath) !== expectedHash) {
    throw new ValidationError(
      `pending baseline hash does not match ${baselineSpecRef}`,
    );
  }

  if (
    isComposedBaselineReference(baselineSpecRef)
    && baselineSpecRef !== 'current-spec.json'
  ) {
    const expectedSnapshotRef = canonicalComposedBaselineSnapshotRef(
      state.activeIteration,
    );
    if (normalizeDisplayPath(baselineSpecRef) !== expectedSnapshotRef) {
      throw new ValidationError(
        `pending composed baseline snapshot must be ${expectedSnapshotRef}`,
      );
    }
    if (!expectedHash) {
      throw new ValidationError(
        'pending composed baseline snapshot must record baseline_effective_spec_sha256',
      );
    }
    const snapshot = loadJson(baselineSpecPath);
    validateCurrentSpecCompositionData(snapshot, state.artifactRoot, {
      requireNoOpenDecisions: true,
    });
    for (const field of [
      'project_id',
      'composed_from',
      'source_specs',
      'effective_product',
      'effective_implementation',
      'superseded_refs',
      'composition_conflicts',
      'open_decisions',
    ]) {
      if (!jsonEqual(snapshot[field] ?? null, state.currentSpec[field] ?? null)) {
        throw new ValidationError(
          `pending composed baseline snapshot ${field} must match the current effective composition`,
        );
      }
    }
  }

  return expectedHash;
}

export function validateActiveIterationBaselineContract(
  state,
  metadata = optionalIterationMetadata(state.artifactRoot, state.activeIteration),
) {
  const pending = state.currentSpec.pending_iteration;
  if (!pending) return;

  const baselineSpecRef = pending.baseline_effective_spec_ref ?? null;
  const metadataBaselineRef = metadata?.baseline?.effective_spec_ref ?? null;
  for (const [label, reference] of [
    ['pending baseline', baselineSpecRef],
    ['iteration metadata baseline', metadataBaselineRef],
  ]) {
    if (
      reference !== null
      && (typeof reference !== 'string' || !reference.trim())
    ) {
      throw new ValidationError(`${label} reference must be a non-empty string or null`);
    }
  }
  const pendingBaselineIteration = pending.baseline_iteration ?? null;
  const metadataBaselineIteration = metadata?.baseline?.iteration_id ?? null;
  if (pendingBaselineIteration !== metadataBaselineIteration) {
    throw new ValidationError(
      `iteration metadata baseline iteration ${JSON.stringify(metadataBaselineIteration)} must match pending baseline iteration ${JSON.stringify(pendingBaselineIteration)}`,
    );
  }
  const intakePath = activeIntakePath(state);
  if (!baselineSpecRef) {
    if (pendingBaselineIteration !== null) {
      throw new ValidationError(
        'greenfield pending and iteration metadata must not record a baseline iteration',
      );
    }
    if (metadataBaselineRef) {
      throw new ValidationError(
        `iteration metadata baseline ${JSON.stringify(metadataBaselineRef)} must match pending baseline null`,
      );
    }
    if (
      Object.hasOwn(pending, 'baseline_effective_spec_sha256')
      || Object.hasOwn(metadata?.baseline ?? {}, 'effective_spec_sha256')
    ) {
      throw new ValidationError(
        'greenfield pending and iteration metadata must not record a baseline effective spec hash',
      );
    }
    if (existsSync(intakePath)) {
      assertIntakeBaselineMatchesPending(
        loadJson(intakePath),
        null,
        null,
        state.artifactRoot,
      );
    }
    return;
  }
  if (!metadata) {
    throw new ValidationError(
      'pending baseline validation requires iteration metadata',
    );
  }
  if (
    typeof pendingBaselineIteration !== 'string'
    || !pendingBaselineIteration.trim()
  ) {
    throw new ValidationError(
      'baseline-aware pending and iteration metadata must record a baseline iteration',
    );
  }
  assertSafeIterationId(
    pendingBaselineIteration,
    'pending baseline_iteration',
  );

  const baselineSpecPath = resolveFileReference(
    baselineSpecRef,
    state.artifactRoot,
  );
  assertFile(
    baselineSpecPath,
    'current-spec.json pending_iteration.baseline_effective_spec_ref',
  );
  assertFileInsideArtifactRoot(
    baselineSpecPath,
    state.artifactRoot,
    'current-spec.json pending_iteration.baseline_effective_spec_ref',
  );
  const baselineSpecSha256 = assertPendingBaselineIntegrity(
    state,
    pending,
    metadata,
    baselineSpecRef,
    baselineSpecPath,
  );
  if (existsSync(intakePath)) {
    assertIntakeBaselineMatchesPending(
      loadJson(intakePath),
      baselineSpecRef,
      baselineSpecPath,
      state.artifactRoot,
      baselineSpecSha256,
    );
  }
}

function validateReadyIterationArtifacts(state) {
  validateCurrentSpecCompositionData(
    state.currentSpec,
    state.artifactRoot,
    { requireNoOpenDecisions: true },
  );
  validateActiveIterationBaselineContract(state);
  const currentSpecOpenDecisions = state.currentSpec.open_decisions ?? [];
  if (!Array.isArray(currentSpecOpenDecisions)) {
    throw new ValidationError('ready iteration requires current-spec.json open_decisions to be an array when present');
  }
  if (currentSpecOpenDecisions.length) {
    throw new ValidationError(`ready iteration requires current-spec.json open_decisions to be empty, got ${JSON.stringify(currentSpecOpenDecisions.map((decision) => decision.id ?? decision))}`);
  }
  const spec = validateSpec(
    state.specPath,
    null,
    { artifactRoot: state.artifactRoot },
  );
  if (spec.approval !== 'approved') {
    throw new ValidationError(`ready iteration requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError(`ready iteration requires spec.open_decisions to be empty, got ${JSON.stringify(spec.open_decisions)}`);
  }
  if (spec.project_id !== state.projectId) {
    throw new ValidationError(
      `ready iteration requires spec.project_id ${JSON.stringify(spec.project_id)} to match current-spec.json project_id ${JSON.stringify(state.projectId)}`,
    );
  }
  validateCurrentSpecGateBApprovalAudit(state.currentSpec, state.activeIteration, spec);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath);
  if (taskGraph.projectId !== state.projectId) {
    throw new ValidationError(
      `ready iteration requires taskGraph.projectId ${JSON.stringify(taskGraph.projectId)} to match current-spec.json project_id ${JSON.stringify(state.projectId)}`,
    );
  }
}

function parseStatusActiveIteration(statusPath) {
  const statusText = readFileSync(statusPath, 'utf8');
  const markerMatch = statusText.match(/<!--\s*p2a:active-iteration=(.*?)\s*-->/);
  if (markerMatch) return markerMatch[1].trim();

  const activeLineMatch = statusText.match(/^\s*-\s*활성 기능 반복:\s*(.+?)(?:\s*\(|\s*$)/m);
  return activeLineMatch ? activeLineMatch[1].trim() : null;
}

export function resolveIterationState(artifactPath, options = {}) {
  const { requireReady = true, cwd = process.cwd() } = options;
  const artifactRoot = normalizeArtifactRoot(artifactPath, cwd);
  assertDirectory(artifactRoot, '--artifacts');

  const statusPath = path.join(artifactRoot, 'status.md');
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const iterationsRoot = path.join(artifactRoot, 'iterations');

  assertFile(currentSpecPath, 'current-spec.json');
  assertDirectory(iterationsRoot, 'iterations');

  const currentSpec = loadJson(currentSpecPath);
  if (currentSpec.schema_version !== 'p2a.current_spec.v1') {
    throw new ValidationError(`current-spec.json schema_version must be "p2a.current_spec.v1", got ${JSON.stringify(currentSpec.schema_version)}`);
  }
  assertString(currentSpec.project_id, 'current-spec.json project_id');
  const projectId = currentSpec.project_id;

  const activeIteration = currentSpec.active_iteration;
  assertSafeIterationId(activeIteration);
  const statusActiveIteration = existsSync(statusPath) && lstatSync(statusPath).isFile()
    ? parseStatusActiveIteration(statusPath)
    : null;

  const iterationRoot = path.join(iterationsRoot, activeIteration);
  const gateBSpecRoot = path.join(iterationRoot, 'gate-b-spec');
  const gateCTaskGraphRoot = path.join(iterationRoot, 'gate-c-task-graph');
  const specPath = path.join(gateBSpecRoot, 'spec.json');
  const taskGraphPath = path.join(gateCTaskGraphRoot, 'task-graph.json');
  const effectiveSpecPath = resolveEffectiveSpecPath(currentSpec, artifactRoot, currentSpecPath);

  assertDirectory(iterationRoot, `iterations/${activeIteration}`);
  assertFile(effectiveSpecPath, 'current-spec.json effective_spec_ref');
  assertFileInsideArtifactRoot(
    effectiveSpecPath,
    artifactRoot,
    'current-spec.json effective_spec_ref',
  );
  if (requireReady) {
    assertFile(specPath, `iterations/${activeIteration}/gate-b-spec/spec.json`);
    assertFile(taskGraphPath, `iterations/${activeIteration}/gate-c-task-graph/task-graph.json`);
    const taskGraph = loadJson(taskGraphPath);
    const taskGraphSourceSpecPath = resolveTaskGraphSourceSpec(taskGraph, taskGraphPath);
    assertFile(taskGraphSourceSpecPath, 'task-graph.sourceSpec');
    assertSameFile(taskGraphSourceSpecPath, specPath, 'task-graph.sourceSpec');

    const state = {
      projectId,
      artifactRoot,
      statusPath,
      currentSpecPath,
      currentSpec,
      statusActiveIteration,
      effectiveSpecPath,
      activeIteration,
      iterationRoot,
      specPath,
      taskGraphPath,
      taskGraphSourceSpecPath,
    };
    validateReadyIterationArtifacts(state);
    return state;
  }

  return {
    projectId,
    artifactRoot,
    statusPath,
    currentSpecPath,
    currentSpec,
    statusActiveIteration,
    effectiveSpecPath,
    activeIteration,
    iterationRoot,
    specPath,
    taskGraphPath,
    taskGraphSourceSpecPath: null,
  };
}

export function formatDisplayPath(filePath, root = ROOT) {
  const relativePath = path.relative(root, filePath);
  const isRootRelative = relativePath
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
  const displayPath = isRootRelative ? relativePath : filePath;
  return displayPath.split(path.sep).join('/');
}

export function serializeIterationState(state, root = ROOT) {
  return {
    projectId: state.projectId,
    artifactRoot: state.artifactRoot,
    statusPath: state.statusPath,
    activeIteration: state.activeIteration,
    statusActiveIteration: state.statusActiveIteration,
    iterationRoot: state.iterationRoot,
    currentSpecPath: state.currentSpecPath,
    effectiveSpecPath: state.effectiveSpecPath,
    specPath: state.specPath,
    taskGraphPath: state.taskGraphPath,
    taskGraphSourceSpecPath: state.taskGraphSourceSpecPath,
    displayPaths: {
      artifactRoot: formatDisplayPath(state.artifactRoot, root),
      statusPath: formatDisplayPath(state.statusPath, root),
      iterationRoot: formatDisplayPath(state.iterationRoot, root),
      currentSpecPath: formatDisplayPath(state.currentSpecPath, root),
      effectiveSpecPath: formatDisplayPath(state.effectiveSpecPath, root),
      specPath: formatDisplayPath(state.specPath, root),
      taskGraphPath: formatDisplayPath(state.taskGraphPath, root),
      taskGraphSourceSpecPath: state.taskGraphSourceSpecPath
        ? formatDisplayPath(state.taskGraphSourceSpecPath, root)
        : null,
    },
  };
}

export function formatIterationState(state) {
  const serialized = serializeIterationState(state).displayPaths;
  return [
    'Plan2Agent current iteration:',
    `- project: ${state.projectId}`,
    `- artifact root: ${serialized.artifactRoot}`,
    `- active iteration: ${state.activeIteration}`,
    `- iteration root: ${serialized.iterationRoot}`,
    `- current spec: ${serialized.currentSpecPath}`,
    `- effective spec: ${serialized.effectiveSpecPath}`,
    `- active spec: ${serialized.specPath}`,
    `- task graph: ${serialized.taskGraphPath}`,
  ].join('\n');
}
