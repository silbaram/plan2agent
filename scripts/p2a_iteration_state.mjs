#!/usr/bin/env node
/** Resolve the active Plan2Agent iteration from an iterative artifact root. */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {
  approvedExecutionEnvelope,
  currentDevelopmentContractSha256,
  executionEnvelopeFromCurrentDevelopmentContract,
  iterationConstraintsFromSpec,
  loadJson,
  resolveSpecSourceIntake,
  validateConstitution,
  validateCurrentDevelopmentContract,
  validateCurrentDevelopmentContractData,
  validateCurrentSpecGateBApprovalAudit,
  validateSpec,
  validateTaskGraph,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import { taskContractSha256 } from './p2a_run_paths.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';
import {
  composeCanonicalSpecSources,
  canonicalComposedBaselineSnapshotRef,
  compositionReplayContractError,
  compositionSourceContractError,
  IMPLEMENTATION_FIELDS,
  isComposedBaselineReference,
  jsonEqual,
  PRODUCT_FIELDS,
} from './p2a_spec_model.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
export const ROOT = P2A_PATHS.projectRoot;
export const CURRENT_DEVELOPMENT_CONTRACT_FILENAME = 'current-development-contract.json';

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

function assertReferenceInsideArtifactRoot(reference, artifactRoot, label) {
  if (!reference) return;
  assertString(reference, label);
  if (path.win32.isAbsolute(reference) && !path.isAbsolute(reference)) {
    throw new ValidationError(`${label} must resolve inside the artifact root`);
  }
  const resolvedPath = path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(artifactRoot, ...reference.replaceAll('\\', '/').split('/'));
  const relativePath = path.relative(path.resolve(artifactRoot), resolvedPath);
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

function matchingActiveCloseRecords(currentSpec, iterationId) {
  const closedIterations = currentSpec.closed_iterations;
  if (closedIterations !== undefined && !Array.isArray(closedIterations)) {
    throw new ValidationError(
      'current-spec.json closed_iterations must be an array when present',
    );
  }
  const matches = (closedIterations ?? []).filter(
    (record) => record?.iteration_id === iterationId,
  );
  if (matches.length > 1) {
    throw new ValidationError(
      `active iteration archive consistency requires exactly one current-spec.json closed_iterations record for ${JSON.stringify(iterationId)}, got ${matches.length}`,
    );
  }
  const closedRecord = matches[0] ?? null;
  const lastClosedRecord = currentSpec.last_closed_iteration?.iteration_id === iterationId
    ? currentSpec.last_closed_iteration
    : null;
  return { closedRecord, lastClosedRecord };
}

function assertArchivedCloseRecord(record, label, iterationId) {
  if (!record) return;
  if (record.status !== 'archived') {
    throw new ValidationError(
      `active iteration archive consistency requires ${label}.status archived for ${JSON.stringify(iterationId)}, got ${JSON.stringify(record.status)}`,
    );
  }
}

function assertMatchingClosedAt(left, leftLabel, right, rightLabel, iterationId) {
  if (left === undefined || right === undefined) return;
  if (left !== right) {
    throw new ValidationError(
      `active iteration archive consistency requires ${leftLabel} to match ${rightLabel} for ${JSON.stringify(iterationId)}`,
    );
  }
}

export function validateActiveIterationArchiveConsistency(
  state,
  metadata = optionalIterationMetadata(state.artifactRoot, state.activeIteration),
) {
  const iterationId = state.activeIteration;
  const { closedRecord, lastClosedRecord } = matchingActiveCloseRecords(
    state.currentSpec,
    iterationId,
  );
  assertArchivedCloseRecord(
    closedRecord,
    'current-spec.json closed_iterations record',
    iterationId,
  );
  assertArchivedCloseRecord(
    lastClosedRecord,
    'current-spec.json last_closed_iteration',
    iterationId,
  );
  if (Boolean(closedRecord) !== Boolean(lastClosedRecord)) {
    throw new ValidationError(
      `active iteration archive consistency requires matching current-spec.json last_closed_iteration and closed_iterations records for ${JSON.stringify(iterationId)}`,
    );
  }

  const archived = Boolean(closedRecord && lastClosedRecord);
  const hasClosedAt = Boolean(metadata && Object.hasOwn(metadata, 'closed_at'));
  const hasClose = Boolean(metadata && Object.hasOwn(metadata, 'close'));
  const metadataHasArchiveMarker = Boolean(
    metadata?.status === 'archived' || hasClosedAt || hasClose,
  );
  if (archived) {
    if (!metadata) {
      throw new ValidationError(
        `active iteration archive consistency requires iterations/${iterationId}/iteration.json for the archived close records`,
      );
    }
    if (metadata.status !== 'archived') {
      throw new ValidationError(
        `active iteration archive consistency requires iterations/${iterationId}/iteration.json status archived because current-spec.json records the iteration as archived, got ${JSON.stringify(metadata.status)}`,
      );
    }
    if (state.currentSpec.pending_iteration !== undefined) {
      throw new ValidationError(
        `active iteration archive consistency requires current-spec.json pending_iteration to be absent for archived active iteration ${JSON.stringify(iterationId)}`,
      );
    }
  } else if (metadataHasArchiveMarker) {
    throw new ValidationError(
      `active iteration archive consistency rejects iterations/${iterationId}/iteration.json archive markers without matching current-spec.json close records`,
    );
  }

  if (metadata) {
    assertMatchingClosedAt(
      closedRecord?.closed_at,
      'current-spec.json closed_iterations record closed_at',
      lastClosedRecord?.closed_at,
      'current-spec.json last_closed_iteration.closed_at',
      iterationId,
    );
    assertMatchingClosedAt(
      metadata.closed_at,
      `iterations/${iterationId}/iteration.json closed_at`,
      closedRecord?.closed_at,
      'current-spec.json closed_iterations record closed_at',
      iterationId,
    );
    if (hasClose) {
      if (!metadata.close || typeof metadata.close !== 'object' || Array.isArray(metadata.close)) {
        throw new ValidationError(
          `active iteration archive consistency requires iterations/${iterationId}/iteration.json close to be an object`,
        );
      }
      if (metadata.close.iteration_id !== undefined && metadata.close.iteration_id !== iterationId) {
        throw new ValidationError(
          `active iteration archive consistency requires iterations/${iterationId}/iteration.json close.iteration_id to match the active iteration`,
        );
      }
      if (metadata.close.status !== undefined && metadata.close.status !== 'archived') {
        throw new ValidationError(
          `active iteration archive consistency requires iterations/${iterationId}/iteration.json close.status archived`,
        );
      }
      assertMatchingClosedAt(
        metadata.close.closed_at,
        `iterations/${iterationId}/iteration.json close.closed_at`,
        metadata.closed_at,
        `iterations/${iterationId}/iteration.json closed_at`,
        iterationId,
      );
    }
  }

  return {
    archived,
    metadata,
    closedRecord,
    lastClosedRecord,
  };
}

function archivedVisualArtifactRef(reference, iterationId) {
  const gateBPrefix = `iterations/${iterationId}/gate-b-spec/`;
  return reference === `${gateBPrefix}experience-spec.json`
    || reference.startsWith(`${gateBPrefix}visual-design/`);
}

export function closedIterationRequiredArtifactRefs(iterationId) {
  assertSafeIterationId(iterationId, 'closed iteration id');
  return [
    `iterations/${iterationId}/baseline/current-spec.json`,
    `iterations/${iterationId}/gate-a-intake/intake.json`,
    `iterations/${iterationId}/gate-a-intake/intake.md`,
    `iterations/${iterationId}/gate-b-spec/product-spec.md`,
    `iterations/${iterationId}/gate-b-spec/implementation-plan.md`,
    `iterations/${iterationId}/gate-b-spec/experience-spec.json`,
    `iterations/${iterationId}/gate-b-spec/spec.json`,
    `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
  ];
}

export function closedIterationVisualArtifactRefs(iterationId, artifactRoot) {
  assertSafeIterationId(iterationId, 'closed iteration id');
  const gateBRoot = path.join(
    artifactRoot,
    'iterations',
    iterationId,
    'gate-b-spec',
  );
  const refs = [];
  const experiencePath = path.join(gateBRoot, 'experience-spec.json');
  if (existsSync(experiencePath) && lstatSync(experiencePath).isFile()) {
    refs.push(normalizeDisplayPath(path.relative(artifactRoot, experiencePath)));
  }
  const visualDesignRoot = path.join(gateBRoot, 'visual-design');
  if (!existsSync(visualDesignRoot)) return refs;
  if (!lstatSync(visualDesignRoot).isDirectory()) {
    throw new ValidationError(
      `closed iteration visual-design path must be a directory: ${visualDesignRoot}`,
    );
  }
  const directories = [visualDesignRoot];
  while (directories.length) {
    const directory = directories.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile()) {
        refs.push(normalizeDisplayPath(path.relative(artifactRoot, entryPath)));
      } else {
        throw new ValidationError(
          `closed iteration visual-design contains unsupported entry: ${entryPath}`,
        );
      }
    }
  }
  return refs.sort();
}

function auditedFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Verify immutable close-time artifacts without replaying Gate A/B/C provenance.
 * This intentionally stays linear in the archived bytes and is suitable for
 * read-only routing. Closed routing may separately replay only these audited
 * composition inputs; full schema and provenance validation remains the
 * responsibility of mutation preflights and explicit iteration validation.
 */
export function auditArchivedIterationArtifacts(currentSpec, artifactRoot) {
  const closedIterations = currentSpec.closed_iterations ?? [];
  if (!Array.isArray(closedIterations)) {
    throw new ValidationError(
      'current-spec.json closed_iterations must be an array when present',
    );
  }
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const iterationIds = closedIterations.map((closed) => closed?.iteration_id);
  if (iterationIds.length !== new Set(iterationIds).size) {
    throw new ValidationError(
      'current-spec.json closed_iterations iteration_id values must be unique',
    );
  }
  for (const closed of closedIterations) {
    if (!closed?.iteration_id) {
      throw new ValidationError(
        'current-spec.json closed_iterations entries must include iteration_id',
      );
    }
    assertSafeIterationId(
      closed.iteration_id,
      'current-spec.json closed_iterations[].iteration_id',
    );
    if (
      !closed.artifact_hashes
      || typeof closed.artifact_hashes !== 'object'
      || Array.isArray(closed.artifact_hashes)
    ) {
      throw new ValidationError(
        `closed iteration ${closed.iteration_id} is missing artifact_hashes; re-close or migrate audit metadata`,
      );
    }
    const normalizedAuditRefs = new Set(
      Object.keys(closed.artifact_hashes).map((reference) => reference.replaceAll('\\', '/')),
    );
    const missingAuditRefs = closedIterationRequiredArtifactRefs(closed.iteration_id)
      .filter((reference) => !normalizedAuditRefs.has(reference));
    if (missingAuditRefs.length) {
      throw new ValidationError(
        `closed iteration ${closed.iteration_id} artifact_hashes is missing required reference(s): ${missingAuditRefs.join(', ')}`,
      );
    }
    const expectedVisualRefs = new Set(
      Object.entries(closed.artifact_hashes)
        .filter(([reference, audit]) => (
          archivedVisualArtifactRef(reference.replaceAll('\\', '/'), closed.iteration_id)
          && (typeof audit === 'string' || audit?.present === true)
        ))
        .map(([reference]) => reference.replaceAll('\\', '/')),
    );
    const currentVisualRefs = new Set(
      closedIterationVisualArtifactRefs(closed.iteration_id, resolvedArtifactRoot),
    );
    const addedVisualRefs = [...currentVisualRefs]
      .filter((reference) => !expectedVisualRefs.has(reference));
    const removedVisualRefs = [...expectedVisualRefs]
      .filter((reference) => !currentVisualRefs.has(reference));
    if (addedVisualRefs.length || removedVisualRefs.length) {
      const details = [
        ...(addedVisualRefs.length ? [`added ${addedVisualRefs.join(', ')}`] : []),
        ...(removedVisualRefs.length ? [`removed ${removedVisualRefs.join(', ')}`] : []),
      ].join('; ');
      throw new ValidationError(
        `closed iteration ${closed.iteration_id} visual artifact set changed after close: ${details}`,
      );
    }
    for (const [reference, expectedAudit] of Object.entries(closed.artifact_hashes)) {
      const normalizedReference = typeof reference === 'string'
        ? reference.replaceAll('\\', '/')
        : '';
      if (
        !normalizedReference
        || path.isAbsolute(reference)
        || path.win32.isAbsolute(reference)
        || normalizedReference.split('/').includes('..')
      ) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact reference must be artifact-root-relative: ${JSON.stringify(reference)}`,
        );
      }
      const filePath = path.resolve(resolvedArtifactRoot, reference);
      const relativePath = path.relative(resolvedArtifactRoot, filePath);
      if (
        !relativePath
        || relativePath.startsWith('..')
        || path.isAbsolute(relativePath)
      ) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact reference escapes the artifact root: ${JSON.stringify(reference)}`,
        );
      }
      if (typeof expectedAudit === 'string') {
        assertFile(filePath, `closed iteration artifact ${reference}`);
        assertFileInsideArtifactRoot(
          filePath,
          resolvedArtifactRoot,
          `closed iteration artifact ${reference}`,
        );
        if (auditedFileSha256(filePath) !== expectedAudit) {
          throw new ValidationError(
            `closed iteration ${closed.iteration_id} artifact changed after close: ${reference}`,
          );
        }
        continue;
      }
      if (!expectedAudit || typeof expectedAudit !== 'object' || Array.isArray(expectedAudit)) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact audit entry is invalid: ${reference}`,
        );
      }
      if (expectedAudit.present === false) {
        if (existsSync(filePath)) {
          throw new ValidationError(
            `closed iteration ${closed.iteration_id} artifact appeared after close: ${reference}`,
          );
        }
        continue;
      }
      if (expectedAudit.present !== true || typeof expectedAudit.sha256 !== 'string') {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact audit entry is invalid: ${reference}`,
        );
      }
      assertFile(filePath, `closed iteration artifact ${reference}`);
      assertFileInsideArtifactRoot(
        filePath,
        resolvedArtifactRoot,
        `closed iteration artifact ${reference}`,
      );
      if (auditedFileSha256(filePath) !== expectedAudit.sha256) {
        throw new ValidationError(
          `closed iteration ${closed.iteration_id} artifact changed after close: ${reference}`,
        );
      }
    }
  }
  return closedIterations.length;
}

/**
 * Replay only the already-audited composition inputs needed by closed routing.
 * Source schema and provenance validation remain in explicit validation and
 * mutation preflights; this check detects canonical composition drift without
 * recursively validating historical Gate artifacts.
 */
export function validateClosedIterationComposition(currentSpec, artifactRoot) {
  if (currentSpec.effective_spec_ref !== 'current-spec.json') return currentSpec;

  const closedIds = new Set(
    currentSpec.closed_iterations.map((closed) => closed.iteration_id),
  );
  const sourceIds = currentSpec.source_specs.map((source) => source.iteration_id);
  const extraSourceIds = sourceIds.filter((iterationId) => !closedIds.has(iterationId));
  if (extraSourceIds.length) {
    throw new ValidationError(
      `current-spec.json source_specs contains iteration(s) that are not closed: ${extraSourceIds.join(', ')}`,
    );
  }

  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const sources = currentSpec.source_specs.map((source) => {
    const iterationRoot = path.join(
      resolvedArtifactRoot,
      'iterations',
      source.iteration_id,
    );
    const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const taskGraphPath = path.join(
      iterationRoot,
      'gate-c-task-graph',
      'task-graph.json',
    );
    assertFile(specPath, `closed composition source ${source.iteration_id} spec`);
    assertFileInsideArtifactRoot(
      specPath,
      resolvedArtifactRoot,
      `closed composition source ${source.iteration_id} spec`,
    );
    assertFile(intakePath, `closed composition source ${source.iteration_id} intake`);
    assertFileInsideArtifactRoot(
      intakePath,
      resolvedArtifactRoot,
      `closed composition source ${source.iteration_id} intake`,
    );
    assertFile(taskGraphPath, `closed composition source ${source.iteration_id} task graph`);
    assertFileInsideArtifactRoot(
      taskGraphPath,
      resolvedArtifactRoot,
      `closed composition source ${source.iteration_id} task graph`,
    );
    const spec = loadJson(specPath);
    if (spec.project_id !== currentSpec.project_id) {
      throw new ValidationError(
        `closed composition source ${source.iteration_id} project_id mismatch`,
      );
    }
    if (spec.approval !== 'approved' || source.approval !== spec.approval) {
      throw new ValidationError(
        `closed composition source ${source.iteration_id} must remain approved`,
      );
    }
    return {
      ...source,
      spec,
      task_graph: loadJson(taskGraphPath),
      metadata: optionalIterationMetadata(
        resolvedArtifactRoot,
        source.iteration_id,
      ),
      source_intake: loadJson(intakePath),
    };
  });

  const sourceContractError = compositionSourceContractError(sources);
  if (sourceContractError) {
    throw new ValidationError(`current-spec.json ${sourceContractError}`);
  }
  const replayedComposition = composeCanonicalSpecSources(sources);
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

/** Validate only the current-spec fields needed to route a closed iteration. */
export function validateClosedIterationRoutingData(currentSpec) {
  const closedIterations = currentSpec.closed_iterations;
  if (!Array.isArray(closedIterations) || !closedIterations.length) {
    throw new ValidationError(
      'closed iteration routing requires current-spec.json closed_iterations',
    );
  }
  if (currentSpec.pending_iteration !== undefined) {
    throw new ValidationError(
      'closed iteration routing requires current-spec.json pending_iteration to be absent',
    );
  }
  const closedIds = closedIterations.map((closed) => closed?.iteration_id);
  if (
    closedIds.some((iterationId) => typeof iterationId !== 'string' || !iterationId)
    || closedIds.length !== new Set(closedIds).size
  ) {
    throw new ValidationError(
      'closed iteration routing requires unique closed iteration ids',
    );
  }
  if (!closedIds.includes(currentSpec.active_iteration)) {
    throw new ValidationError(
      'closed iteration routing requires active_iteration in closed_iterations',
    );
  }
  const activeClosedRecord = closedIterations.find(
    (closed) => closed.iteration_id === currentSpec.active_iteration,
  );
  if (
    !currentSpec.last_closed_iteration
    || currentSpec.last_closed_iteration.iteration_id !== currentSpec.active_iteration
  ) {
    throw new ValidationError(
      'closed iteration routing requires last_closed_iteration to match active_iteration',
    );
  }
  if (
    !jsonEqual(
      currentSpec.last_closed_iteration.artifact_hashes,
      activeClosedRecord.artifact_hashes,
    )
  ) {
    throw new ValidationError(
      'closed iteration routing requires last_closed_iteration artifact_hashes to match closed_iterations',
    );
  }
  const openDecisions = currentSpec.open_decisions ?? [];
  if (!Array.isArray(openDecisions) || openDecisions.length) {
    throw new ValidationError(
      'closed iteration routing requires current-spec.json open_decisions to be empty',
    );
  }

  const hasCompositionFields = Object.hasOwn(currentSpec, 'source_specs')
    || Object.hasOwn(currentSpec, 'effective_product')
    || Object.hasOwn(currentSpec, 'effective_implementation')
    || currentSpec.effective_spec_ref === 'current-spec.json';
  if (!hasCompositionFields) {
    const expectedRef = `iterations/${currentSpec.active_iteration}/gate-b-spec/spec.json`;
    if (normalizeDisplayPath(currentSpec.effective_spec_ref) !== expectedRef) {
      throw new ValidationError(
        `closed iteration routing requires effective_spec_ref ${expectedRef}`,
      );
    }
    return currentSpec;
  }
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
  const sourceIds = currentSpec.source_specs.map((source) => source?.iteration_id);
  if (!jsonEqual(sourceIds, currentSpec.composed_from)) {
    throw new ValidationError(
      'current-spec.json composed_from must match source_specs iteration order',
    );
  }
  if (sourceIds.length !== new Set(sourceIds).size) {
    throw new ValidationError(
      'current-spec.json source_specs iteration ids must be unique',
    );
  }
  for (const source of currentSpec.source_specs) {
    assertSafeIterationId(
      source.iteration_id,
      'current-spec.json source_specs[].iteration_id',
    );
    const expectedRef = `iterations/${source.iteration_id}/gate-b-spec/spec.json`;
    if (normalizeDisplayPath(source.spec_ref) !== expectedRef) {
      throw new ValidationError(
        `current-spec.json source ${source.iteration_id} spec_ref must be ${expectedRef}`,
      );
    }
    if (source.status !== 'archived' || source.approval !== 'approved') {
      throw new ValidationError(
        `current-spec.json source ${source.iteration_id} must be archived and approved`,
      );
    }
  }
  validateEffectiveSections(
    currentSpec.effective_product,
    currentSpec.effective_implementation,
  );
  return currentSpec;
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
  options = {},
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
  const taskGraph = validateTaskGraph(taskGraphPath, specPath, {
    artifactRoot,
    validationSession: options.validationSession,
  });
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
  return taskGraph;
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
    const spec = validateSpec(specPath, null, {
      artifactRoot,
      validationSession: options.validationSession,
    });
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
    const taskGraph = validateCompositionSourceReadiness(
      currentSpec,
      source,
      specPath,
      artifactRoot,
      metadata,
      options,
    );
    const sourceIntakePath = resolveSpecSourceIntake(specPath, spec);
    const sourceIntake = sourceIntakePath ? loadJson(sourceIntakePath) : null;
    validatedSources.push({
      ...source,
      spec,
      task_graph: taskGraph,
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

export function iterationCompositionRequirement(currentSpec) {
  const closedIterations = Array.isArray(currentSpec?.closed_iterations)
    ? currentSpec.closed_iterations
    : [];
  const closedIterationIds = closedIterations
    .map((closed) => closed?.iteration_id)
    .filter((iterationId) => typeof iterationId === 'string' && iterationId);
  const hasComposedEffectiveSpec = currentSpec?.effective_spec_ref === 'current-spec.json';
  const composedIterationIds = new Set(
    Array.isArray(currentSpec?.composed_from)
      ? currentSpec.composed_from.filter(
        (iterationId) => typeof iterationId === 'string' && iterationId,
      )
      : [],
  );
  const missingClosedIterations = closedIterationIds.filter(
    (iterationId) => !composedIterationIds.has(iterationId),
  );
  const requiresComposedEffectiveSpec = (
    closedIterations.length > 1
    && !hasComposedEffectiveSpec
  );
  return {
    required: (
      requiresComposedEffectiveSpec
      || (hasComposedEffectiveSpec && missingClosedIterations.length > 0)
    ),
    requiresComposedEffectiveSpec,
    missingClosedIterations,
  };
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

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function projectConstitutionPath(artifactRoot) {
  let current = path.resolve(artifactRoot);
  while (true) {
    const candidate = path.basename(current) === '.plan2agent'
      ? path.join(current, 'constitution.json')
      : path.join(current, '.plan2agent', 'constitution.json');
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function emptyConstitution(projectId) {
  return {
    schema_version: 'p2a.constitution.v1',
    projectId,
    architecture: [],
    stack: [],
    prohibitions: [],
    style: {},
  };
}

function currentDevelopmentRef(artifactRoot, filePath) {
  return normalizeDisplayPath(path.relative(artifactRoot, filePath)).replace(/^\.\//, '');
}

export function currentDevelopmentContractPath(artifactRoot) {
  return path.join(path.resolve(artifactRoot), CURRENT_DEVELOPMENT_CONTRACT_FILENAME);
}

export function materializeCurrentDevelopmentContract(state, options = {}) {
  assertFile(state.specPath, `iterations/${state.activeIteration}/gate-b-spec/spec.json`);
  assertFile(state.taskGraphPath, `iterations/${state.activeIteration}/gate-c-task-graph/task-graph.json`);
  const activeSpecRef = currentDevelopmentRef(state.artifactRoot, state.specPath);
  const taskGraphRef = currentDevelopmentRef(state.artifactRoot, state.taskGraphPath);
  const constitutionPath = projectConstitutionPath(state.artifactRoot);
  const constitution = constitutionPath
    ? validateConstitution(constitutionPath, {
        requireApproved: true,
        projectId: state.projectId,
      })
    : emptyConstitution(state.projectId);
  const graph = validateTaskGraph(state.taskGraphPath, state.specPath, {
    artifactRoot: state.artifactRoot,
    validationSession: options.validationSession,
  });
  const envelope = approvedExecutionEnvelope(
    state.specPath,
    activeSpecRef,
    state.artifactRoot,
    options,
  );
  const technologyEvidence = (loadJson(state.specPath).evidence ?? [])
    .filter((item) => typeof item?.source_id === 'string' && item.source_id.startsWith('WEB-'))
    .slice(0, 10)
    .map((item) => structuredClone(item));
  const contract = {
    schema_version: 'p2a.current_development_contract.v1',
    projectId: state.projectId,
    iterationId: state.activeIteration,
    objective: envelope.objective,
    scope: envelope.scope,
    iterationConstraints: structuredClone(envelope.iterationConstraints),
    architecture: structuredClone(constitution.architecture),
    stack: structuredClone(constitution.stack),
    prohibitions: structuredClone(constitution.prohibitions),
    style: structuredClone(constitution.style),
    mustPreserve: envelope.mustPreserve,
    nonGoals: envelope.nonGoals,
    acceptance: envelope.acceptance,
    verification: envelope.verification,
    authority: {
      workspace: 'project_root',
      externalWrites: false,
      mayChoose: envelope.executionAuthority.mayChoose,
      mustReturnToGate: envelope.executionAuthority.mustReturnToGate,
    },
    ...(envelope.visualContract ? {
      visualContract: structuredClone(envelope.visualContract),
    } : {}),
    ...(technologyEvidence.length ? { technologyEvidence } : {}),
    bindings: {
      constitution: {
        ref: constitutionPath ? '.plan2agent/constitution.json' : null,
        sha256: constitutionPath ? fileSha256(constitutionPath) : null,
      },
      activeSpec: {
        ref: activeSpecRef,
        sha256: fileSha256(state.specPath),
      },
      taskGraph: {
        ref: taskGraphRef,
        tasks: graph.tasks.map((task) => ({
          taskId: task.id,
          sha256: taskContractSha256(task),
        })),
      },
    },
  };
  validateCurrentDevelopmentContractDataForState(contract, state, constitution, graph);
  return contract;
}

function validateCurrentDevelopmentContractDataForState(contract, state, constitution, graph) {
  validateCurrentDevelopmentContractData(contract, {
    projectId: state.projectId,
    iterationId: state.activeIteration,
  });
  const archived = (state.currentSpec.closed_iterations ?? []).some((closed) => (
    closed?.iteration_id === state.activeIteration && closed?.status === 'archived'
  ));
  if (contract.projectId !== state.projectId || contract.iterationId !== state.activeIteration) {
    throw new ValidationError('current development contract identity does not match current-spec.json');
  }
  if (!archived && fileSha256(state.specPath) !== contract.bindings.activeSpec.sha256) {
    throw new ValidationError('current development contract active spec changed after materialization');
  }
  const activeSpecMatchesBinding = (
    existsSync(state.specPath)
    && lstatSync(state.specPath).isFile()
    && fileSha256(state.specPath) === contract.bindings.activeSpec.sha256
  );
  let iterationConstraints;
  if (activeSpecMatchesBinding) {
    iterationConstraints = iterationConstraintsFromSpec(loadJson(state.specPath));
    if (
      contract.iterationConstraints !== undefined
      && !jsonEqual(contract.iterationConstraints, iterationConstraints)
    ) {
      throw new ValidationError(
        'current development contract iterationConstraints do not match the bound active spec',
      );
    }
  } else if (contract.iterationConstraints !== undefined) {
    iterationConstraints = structuredClone(contract.iterationConstraints);
  } else {
    throw new ValidationError(
      'legacy current development contract cannot recover iterationConstraints because its bound active spec changed or is unavailable',
    );
  }
  for (const field of ['architecture', 'stack', 'prohibitions', 'style']) {
    if (!jsonEqual(contract[field], constitution[field])) {
      throw new ValidationError(`current development contract ${field} does not match the current constitution`);
    }
  }
  const expectedTaskBindings = graph.tasks.map((task) => ({
    taskId: task.id,
    sha256: taskContractSha256(task),
  }));
  if (!jsonEqual(contract.bindings.taskGraph.tasks, expectedTaskBindings)) {
    throw new ValidationError('current development contract task bindings do not match the current task graph');
  }
  return iterationConstraints;
}

export function resolveCurrentDevelopmentState(artifactPath, options = {}) {
  const state = resolveIterationState(artifactPath, {
    requireReady: false,
    requireEffectiveSpec: false,
    cwd: options.cwd,
  });
  const contractPath = currentDevelopmentContractPath(state.artifactRoot);
  assertFile(contractPath, CURRENT_DEVELOPMENT_CONTRACT_FILENAME);
  const contract = validateCurrentDevelopmentContract(contractPath, {
    projectId: state.projectId,
    iterationId: state.activeIteration,
    validationSession: options.validationSession,
  });
  const expectedSpecRef = currentDevelopmentRef(state.artifactRoot, state.specPath);
  const expectedTaskGraphRef = currentDevelopmentRef(state.artifactRoot, state.taskGraphPath);
  if (normalizeDisplayPath(contract.bindings.activeSpec.ref).replace(/^\.\//, '') !== expectedSpecRef) {
    throw new ValidationError(
      `current development contract activeSpec.ref must be ${expectedSpecRef}`,
    );
  }
  if (normalizeDisplayPath(contract.bindings.taskGraph.ref).replace(/^\.\//, '') !== expectedTaskGraphRef) {
    throw new ValidationError(
      `current development contract taskGraph.ref must be ${expectedTaskGraphRef}`,
    );
  }
  const constitutionPath = projectConstitutionPath(state.artifactRoot);
  const constitutionBinding = contract.bindings.constitution;
  if (constitutionBinding.ref === null) {
    if (constitutionPath) {
      throw new ValidationError(
        'current development contract was created without a constitution, but .plan2agent/constitution.json now exists',
      );
    }
  } else {
    if (!constitutionPath) {
      throw new ValidationError('current development contract constitution binding is missing');
    }
    if (constitutionBinding.ref !== '.plan2agent/constitution.json') {
      throw new ValidationError('current development contract constitution ref is invalid');
    }
    if (fileSha256(constitutionPath) !== constitutionBinding.sha256) {
      throw new ValidationError('current development contract constitution binding changed');
    }
  }
  const constitution = constitutionPath
    ? validateConstitution(constitutionPath, {
        requireApproved: true,
        projectId: state.projectId,
      })
    : emptyConstitution(state.projectId);
  assertFile(state.taskGraphPath, `iterations/${state.activeIteration}/gate-c-task-graph/task-graph.json`);
  const graph = loadJson(state.taskGraphPath);
  validateTaskGraphData(graph, null, {
    artifactPath: state.taskGraphPath,
    artifactRoot: state.artifactRoot,
    ...(constitutionPath ? { constitutionPath } : {}),
    projectId: state.projectId,
  });
  if (graph.projectId !== state.projectId) {
    throw new ValidationError('current task graph projectId does not match the current development contract');
  }
  const graphSourceSpecPath = path.resolve(path.dirname(state.taskGraphPath), graph.sourceSpec);
  if (path.resolve(graphSourceSpecPath) !== path.resolve(state.specPath)) {
    throw new ValidationError('current task graph sourceSpec does not match the current development contract activeSpec.ref');
  }
  const iterationConstraints = validateCurrentDevelopmentContractDataForState(
    contract,
    state,
    constitution,
    graph,
  );
  return {
    ...state,
    constitutionPath,
    constitution,
    taskGraph: graph,
    currentDevelopmentContractPath: contractPath,
    currentDevelopmentContractRef: currentDevelopmentRef(state.artifactRoot, contractPath),
    currentDevelopmentContract: contract,
    currentDevelopmentContractSha256: currentDevelopmentContractSha256(contract),
    executionEnvelope: executionEnvelopeFromCurrentDevelopmentContract(
      contract,
      currentDevelopmentRef(state.artifactRoot, contractPath),
      {
        iterationConstraints,
      },
    ),
  };
}

export function normalizeDisplayPath(reference) {
  return String(reference).split(path.sep).join('/');
}

export function activeIntakePath(state) {
  return path.join(state.iterationRoot, 'gate-a-intake', 'intake.json');
}

export function maintenanceTaskGraphPath(artifactRoot) {
  return path.join(
    artifactRoot,
    'iterations',
    'maintenance',
    'gate-c-task-graph',
    'task-graph.json',
  );
}

export function initialMaintenanceTaskGraph(projectId) {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId,
    version: 'maintenance',
    sourceSpec: '../../../current-spec.json',
    tasks: [],
  };
}

export function nextMaintenanceTaskId(tasks) {
  const max = tasks.reduce((highest, task) => {
    const match = typeof task.id === 'string' ? task.id.match(/^task-([0-9]+)$/) : null;
    return match ? Math.max(highest, Number.parseInt(match[1], 10)) : highest;
  }, 0);
  return `task-${String(max + 1).padStart(3, '0')}`;
}

export function assertIntakeBaselineMatchesPending(
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

export function assertPendingBaselineIntegrity(
  state,
  pending,
  metadata,
  baselineSpecRef,
  baselineSpecPath,
  options = {},
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
      validationSession: options.validationSession,
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
  options = {},
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
  const pendingReplacement = pending.replacement ?? null;
  const metadataReplacement = metadata?.replacement ?? null;
  if (Boolean(pendingReplacement) !== Boolean(metadataReplacement)) {
    throw new ValidationError(
      'blocked scope replacement lineage must match between pending_iteration and iteration metadata',
    );
  }
  if (pendingReplacement) {
    if (
      typeof pendingReplacement !== 'object'
      || Array.isArray(pendingReplacement)
      || pendingReplacement.kind !== 'blocked_scope_replan'
      || pendingReplacement.task_coverage !== 'full_spec'
      || !jsonEqual(pendingReplacement, metadataReplacement)
    ) {
      throw new ValidationError(
        'blocked scope replacement lineage must be identical and use kind blocked_scope_replan',
      );
    }
    if (
      pendingReplacement.replaces_iteration !== pendingBaselineIteration
      || pendingReplacement.replaces_iteration !== metadataBaselineIteration
    ) {
      throw new ValidationError(
        'blocked scope replacement lineage must identify the pending baseline iteration',
      );
    }
    if (
      !Array.isArray(pendingReplacement.blocked_task_ids)
      || pendingReplacement.blocked_task_ids.length === 0
      || pendingReplacement.blocked_task_ids.some((taskId) => (
        typeof taskId !== 'string' || !taskId.trim()
      ))
      || new Set(pendingReplacement.blocked_task_ids).size
        !== pendingReplacement.blocked_task_ids.length
    ) {
      throw new ValidationError(
        'blocked scope replacement lineage must record unique blocked_task_ids',
      );
    }
    const replacedIterationIds = pendingReplacement.replaced_iteration_ids;
    if (
      replacedIterationIds !== undefined
      && (
        !Array.isArray(replacedIterationIds)
        || replacedIterationIds.length === 0
        || replacedIterationIds[0] !== pendingReplacement.replaces_iteration
        || replacedIterationIds.some((iterationId) => (
          typeof iterationId !== 'string'
          || !/^[A-Za-z0-9._-]+$/u.test(iterationId)
          || iterationId === state.activeIteration
        ))
        || new Set(replacedIterationIds).size !== replacedIterationIds.length
      )
    ) {
      throw new ValidationError(
        'blocked scope replacement lineage must record a unique direct-first replaced_iteration_ids snapshot',
      );
    }
    if (typeof pendingReplacement.reason !== 'string' || !pendingReplacement.reason.trim()) {
      throw new ValidationError('blocked scope replacement lineage must record a reason');
    }
    const contractSha256 = pendingReplacement.current_development_contract_sha256;
    if (
      typeof contractSha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(contractSha256)
      || contractSha256
        !== pending.resume_authority?.current_development_contract_sha256
      || contractSha256
        !== metadata?.resume_authority?.current_development_contract_sha256
    ) {
      throw new ValidationError(
        'blocked scope replacement lineage must bind the resume current development contract hash',
      );
    }
  }
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
    options,
  );
  if (existsSync(intakePath)) {
    const intake = loadJson(intakePath);
    assertIntakeBaselineMatchesPending(
      intake,
      baselineSpecRef,
      baselineSpecPath,
      state.artifactRoot,
      baselineSpecSha256,
    );
    if (!jsonEqual(intake.baseline_context?.replacement ?? null, pendingReplacement)) {
      throw new ValidationError(
        'Gate A intake blocked scope replacement lineage must match pending_iteration',
      );
    }
  }
}

const ACTIVE_PLANNING_PENDING_STATUSES = new Set([
  'active_planning',
  'gate_a_interview',
  'gate_a_ready',
  'gate_b_draft',
  'gate_b_approved',
]);

export function validateActiveIterationPlanningContract(
  state,
  metadata = optionalIterationMetadata(state.artifactRoot, state.activeIteration),
  options = {},
) {
  validateActiveIterationArchiveConsistency(state, metadata);
  validateActiveIterationBaselineContract(state, metadata, options);
  const pending = state.currentSpec.pending_iteration;
  if (pending) {
    if (!ACTIVE_PLANNING_PENDING_STATUSES.has(pending.status)) {
      throw new ValidationError(
        `current-spec.json pending_iteration.status is not a planning status: ${JSON.stringify(pending.status)}`,
      );
    }
    if (pending.iteration_id !== state.activeIteration) {
      throw new ValidationError(
        `current-spec.json pending_iteration.iteration_id must match active_iteration ${JSON.stringify(state.activeIteration)}`,
      );
    }
  }
}

export function validateActiveGateBPromotionBinding(state, spec = null) {
  const activeSpec = spec ?? validateSpec(
    state.specPath,
    null,
    { artifactRoot: state.artifactRoot },
  );
  if (activeSpec.approval !== 'approved') {
    throw new ValidationError(
      `active Gate B promotion requires spec.approval approved, got ${JSON.stringify(activeSpec.approval)}`,
    );
  }
  const iterationId = state.activeIteration;
  const expectedSpecRef = normalizeDisplayPath(
    path.relative(state.artifactRoot, state.specPath),
  );
  const approvalAudit = validateCurrentSpecGateBApprovalAudit(
    state.currentSpec,
    iterationId,
    activeSpec,
  );
  const normalizedApprovedArtifacts = approvalAudit.approved_artifacts
    .map((reference) => normalizeDisplayPath(reference).replace(/^\.\//, ''));
  if (
    normalizedApprovedArtifacts.length !== 1
    || normalizedApprovedArtifacts[0] !== expectedSpecRef
  ) {
    throw new ValidationError(
      `current-spec.json gate_b_approval_audits.${iterationId}.approved_artifacts must equal [${expectedSpecRef}]`,
    );
  }
  if (
    Object.hasOwn(approvalAudit, 'approved_source')
    && normalizeDisplayPath(approvalAudit.approved_source).replace(/^\.\//, '') !== expectedSpecRef
  ) {
    throw new ValidationError(
      `current-spec.json gate_b_approval_audits.${iterationId}.approved_source must be ${expectedSpecRef}`,
    );
  }
  const binding = state.currentSpec.gate_b_promotion_bindings?.[iterationId];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new ValidationError(
      `current-spec.json gate_b_promotion_bindings.${iterationId} is required for approved Gate B`,
    );
  }
  if (normalizeDisplayPath(binding.source_spec_ref).replace(/^\.\//, '') !== expectedSpecRef) {
    throw new ValidationError(
      `current-spec.json gate_b_promotion_bindings.${iterationId}.source_spec_ref must be ${expectedSpecRef}`,
    );
  }
  if (
    typeof binding.source_spec_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(binding.source_spec_sha256)
  ) {
    throw new ValidationError(
      `current-spec.json gate_b_promotion_bindings.${iterationId}.source_spec_sha256 must be a lowercase SHA-256 value`,
    );
  }
  const actualSpecSha256 = fileSha256(state.specPath);
  if (binding.source_spec_sha256 !== actualSpecSha256) {
    throw new ValidationError(
      `current-spec.json gate_b_promotion_bindings.${iterationId}.source_spec_sha256 does not match ${expectedSpecRef}`,
    );
  }
  if (typeof binding.promoted_at !== 'string' || Number.isNaN(Date.parse(binding.promoted_at))) {
    throw new ValidationError(
      `current-spec.json gate_b_promotion_bindings.${iterationId}.promoted_at must be a timestamp`,
    );
  }
  if (state.currentSpec.gate_b_promoted_at !== binding.promoted_at) {
    throw new ValidationError(
      `current-spec.json gate_b_promoted_at must match gate_b_promotion_bindings.${iterationId}.promoted_at`,
    );
  }

  const pending = state.currentSpec.pending_iteration;
  if (pending?.iteration_id === iterationId) {
    if (pending.status !== 'gate_b_approved') {
      throw new ValidationError(
        `current-spec.json pending_iteration.status must be gate_b_approved after Gate B promotion, got ${JSON.stringify(pending.status)}`,
      );
    }
    if (pending.promoted_at !== binding.promoted_at) {
      throw new ValidationError(
        'current-spec.json pending_iteration.promoted_at must match the active Gate B promotion binding',
      );
    }
    const pendingSpecRef = normalizeDisplayPath(
      pending.artifacts?.spec_ref ?? '',
    ).replace(/^\.\//, '');
    if (pendingSpecRef !== expectedSpecRef) {
      throw new ValidationError(
        `current-spec.json pending_iteration.artifacts.spec_ref must be ${expectedSpecRef}`,
      );
    }
  }
  for (const field of ['approved_by', 'approval_note']) {
    if (approvalAudit[field] !== activeSpec.approval_audit?.[field]) {
      throw new ValidationError(
        `current-spec.json gate_b_approval_audits.${iterationId}.${field} must match spec.approval_audit.${field}`,
      );
    }
  }
  const expectedApprovedAt = activeSpec.approval_audit?.approved_at?.slice(0, 10);
  if (approvalAudit.approved_at !== expectedApprovedAt) {
    throw new ValidationError(
      `current-spec.json gate_b_approval_audits.${iterationId}.approved_at must match spec.approval_audit.approved_at`,
    );
  }

  const metadata = optionalIterationMetadata(state.artifactRoot, iterationId);
  validateActiveIterationArchiveConsistency(state, metadata);
  if (metadata) {
    if (metadata.project_id !== state.projectId) {
      throw new ValidationError(
        `iterations/${iterationId}/iteration.json project_id must match current-spec.json project_id ${JSON.stringify(state.projectId)}`,
      );
    }
    if (metadata.iteration_id !== iterationId) {
      throw new ValidationError(
        `iterations/${iterationId}/iteration.json iteration_id must match active iteration ${JSON.stringify(iterationId)}`,
      );
    }
    if (!['gate_b_approved', 'archived'].includes(metadata.status)) {
      throw new ValidationError(
        `iterations/${iterationId}/iteration.json status must record Gate B promotion, got ${JSON.stringify(metadata.status)}`,
      );
    }
    if (
      (metadata.status === 'gate_b_approved' || Object.hasOwn(metadata, 'promoted_at'))
      && metadata.promoted_at !== binding.promoted_at
    ) {
      throw new ValidationError(
        `iterations/${iterationId}/iteration.json promoted_at must match the active Gate B promotion binding`,
      );
    }
    const metadataSpecRef = normalizeDisplayPath(
      metadata.approved_spec_artifacts?.spec_ref ?? '',
    ).replace(/^\.\//, '');
    if (
      (metadata.status === 'gate_b_approved' || Object.hasOwn(metadata, 'approved_spec_artifacts'))
      && metadataSpecRef !== expectedSpecRef
    ) {
      throw new ValidationError(
        `iterations/${iterationId}/iteration.json approved_spec_artifacts.spec_ref must be ${expectedSpecRef}`,
      );
    }
  }
  return binding;
}

function validateReadyIterationArtifacts(state, options = {}) {
  validateCurrentSpecCompositionData(
    state.currentSpec,
    state.artifactRoot,
    {
      requireNoOpenDecisions: true,
      validationSession: options.validationSession,
    },
  );
  validateActiveIterationPlanningContract(state, undefined, options);
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
    {
      artifactRoot: state.artifactRoot,
      validationSession: options.validationSession,
    },
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
  validateActiveGateBPromotionBinding(state, spec);
  const taskGraph = validateTaskGraph(state.taskGraphPath, state.specPath, {
    artifactRoot: state.artifactRoot,
    validationSession: options.validationSession,
  });
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
  const {
    requireReady = true,
    requireEffectiveSpec = true,
    cwd = process.cwd(),
  } = options;
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
  const effectiveSpecPath = requireEffectiveSpec
    ? resolveEffectiveSpecPath(currentSpec, artifactRoot, currentSpecPath)
    : currentSpecPath;

  assertDirectory(iterationRoot, `iterations/${activeIteration}`);
  if (requireEffectiveSpec) {
    assertFile(effectiveSpecPath, 'current-spec.json effective_spec_ref');
    assertFileInsideArtifactRoot(
      effectiveSpecPath,
      artifactRoot,
      'current-spec.json effective_spec_ref',
    );
  } else {
    assertReferenceInsideArtifactRoot(
      currentSpec.effective_spec_ref,
      artifactRoot,
      'current-spec.json effective_spec_ref',
    );
  }
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
    validateReadyIterationArtifacts(state, options);
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
