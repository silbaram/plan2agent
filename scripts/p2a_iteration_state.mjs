#!/usr/bin/env node
/** Resolve the active Plan2Agent iteration from an iterative artifact root. */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  loadJson,
  validateReviewPass,
  validateSpec,
  validateStatusApprovalAudit,
  validateStatusDoc,
  validateTaskGraph,
  ValidationError,
} from './validate_artifacts.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';

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

function assertSafeIterationId(iterationId) {
  if (typeof iterationId !== 'string' || iterationId.trim().length === 0) {
    throw new ValidationError('current-spec.json active_iteration must be a non-empty string');
  }
  if (iterationId.includes('/') || iterationId.includes('\\') || iterationId === '.' || iterationId === '..') {
    throw new ValidationError(`current-spec.json active_iteration must be a single path segment, got ${JSON.stringify(iterationId)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(iterationId)) {
    throw new ValidationError(`current-spec.json active_iteration may only contain letters, numbers, dots, underscores, and hyphens, got ${JSON.stringify(iterationId)}`);
  }
}

export function normalizeArtifactRoot(artifactPath, cwd = process.cwd()) {
  return path.resolve(cwd, artifactPath);
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

function artifactReferenceMatches(reference, candidates) {
  if (!reference || typeof reference !== 'string') return false;
  if (path.isAbsolute(reference)) {
    return candidates.some((candidate) => path.resolve(reference) === path.resolve(candidate.absolute));
  }
  const normalized = normalizeReference(reference);
  return candidates.some((candidate) => candidate.refs.includes(normalized));
}

function expectedReferenceCandidates({ artifactRoot, iterationRoot, fromDir, expectedPath }) {
  const artifactRelative = normalizedRelative(artifactRoot, expectedPath);
  return [{
    absolute: expectedPath,
    refs: [
      normalizedRelative(iterationRoot, expectedPath),
      normalizedRelative(fromDir, expectedPath),
      artifactRelative,
      `${path.basename(artifactRoot)}/${artifactRelative}`,
      `.plan2agent/artifacts/${path.basename(artifactRoot)}/${artifactRelative}`,
    ],
  }];
}

function validateReviewReferences({ review, artifactRoot, iterationRoot, reviewPath, specPath, taskGraphPath }) {
  const fromDir = path.dirname(reviewPath);
  const checks = [
    ['sourceSpec', specPath],
    ['sourceTaskGraph', taskGraphPath],
  ];
  for (const [field, expectedPath] of checks) {
    const candidates = expectedReferenceCandidates({ artifactRoot, iterationRoot, fromDir, expectedPath });
    if (!artifactReferenceMatches(review[field], candidates)) {
      throw new ValidationError(
        `review.${field} must reference ${normalizedRelative(iterationRoot, expectedPath)}, got ${JSON.stringify(review[field])}`,
      );
    }
  }
}

function validateReadyIterationArtifacts(state) {
  const currentSpecOpenDecisions = state.currentSpec.open_decisions ?? [];
  if (!Array.isArray(currentSpecOpenDecisions)) {
    throw new ValidationError('ready iteration requires current-spec.json open_decisions to be an array when present');
  }
  if (currentSpecOpenDecisions.length) {
    throw new ValidationError(`ready iteration requires current-spec.json open_decisions to be empty, got ${JSON.stringify(currentSpecOpenDecisions.map((decision) => decision.id ?? decision))}`);
  }
  const spec = validateSpec(state.specPath);
  if (spec.approval !== 'approved') {
    throw new ValidationError(`ready iteration requires spec.approval approved, got ${JSON.stringify(spec.approval)}`);
  }
  if (spec.open_decisions.length) {
    throw new ValidationError(`ready iteration requires spec.open_decisions to be empty, got ${JSON.stringify(spec.open_decisions)}`);
  }
  validateStatusDoc(state.statusPath);
  validateStatusApprovalAudit(state.statusPath, spec);
  validateTaskGraph(state.taskGraphPath, state.specPath);
  const review = validateReviewPass(state.reviewPath);
  validateReviewReferences({
    review,
    artifactRoot: state.artifactRoot,
    iterationRoot: state.iterationRoot,
    reviewPath: state.reviewPath,
    specPath: state.specPath,
    taskGraphPath: state.taskGraphPath,
  });
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

  assertFile(statusPath, 'status.md');
  assertFile(currentSpecPath, 'current-spec.json');
  assertDirectory(iterationsRoot, 'iterations');

  const currentSpec = loadJson(currentSpecPath);
  if (currentSpec.schema_version !== 'p2a.current_spec.v1') {
    throw new ValidationError(`current-spec.json schema_version must be "p2a.current_spec.v1", got ${JSON.stringify(currentSpec.schema_version)}`);
  }

  const activeIteration = currentSpec.active_iteration;
  assertSafeIterationId(activeIteration);
  const statusActiveIteration = parseStatusActiveIteration(statusPath);
  if (!statusActiveIteration) {
    throw new ValidationError('status.md active iteration pointer is missing');
  }
  assertSafeIterationId(statusActiveIteration);
  if (statusActiveIteration !== activeIteration) {
    throw new ValidationError(`status.md active iteration ${JSON.stringify(statusActiveIteration)} does not match current-spec.json active_iteration ${JSON.stringify(activeIteration)}`);
  }

  const iterationRoot = path.join(iterationsRoot, activeIteration);
  const gateBSpecRoot = path.join(iterationRoot, 'gate-b-spec');
  const gateCTaskGraphRoot = path.join(iterationRoot, 'gate-c-task-graph');
  const gateDReviewRoot = path.join(iterationRoot, 'gate-d-review');
  const specPath = path.join(gateBSpecRoot, 'spec.json');
  const taskGraphPath = path.join(gateCTaskGraphRoot, 'task-graph.json');
  const reviewPath = path.join(gateDReviewRoot, 'review.json');
  const effectiveSpecPath = resolveEffectiveSpecPath(currentSpec, artifactRoot, currentSpecPath);

  assertDirectory(iterationRoot, `iterations/${activeIteration}`);
  assertFile(effectiveSpecPath, 'current-spec.json effective_spec_ref');
  if (requireReady) {
    assertFile(specPath, `iterations/${activeIteration}/gate-b-spec/spec.json`);
    assertFile(taskGraphPath, `iterations/${activeIteration}/gate-c-task-graph/task-graph.json`);
    assertFile(reviewPath, `iterations/${activeIteration}/gate-d-review/review.json`);

    const taskGraph = loadJson(taskGraphPath);
    const taskGraphSourceSpecPath = resolveTaskGraphSourceSpec(taskGraph, taskGraphPath);
    assertFile(taskGraphSourceSpecPath, 'task-graph.sourceSpec');
    assertSameFile(taskGraphSourceSpecPath, specPath, 'task-graph.sourceSpec');

    const state = {
      projectId: currentSpec.project_id ?? path.basename(artifactRoot),
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
      reviewPath,
    };
    validateReadyIterationArtifacts(state);
    return state;
  }

  return {
    projectId: currentSpec.project_id ?? path.basename(artifactRoot),
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
    reviewPath,
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
    reviewPath: state.reviewPath,
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
      reviewPath: formatDisplayPath(state.reviewPath, root),
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
    `- review: ${serialized.reviewPath}`,
  ].join('\n');
}
