/** Next-state discovery and decision service, independent from CLI dispatch. */


import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_RUNS_DIR, GATE_FILES, GREENFIELD_REQUIRED_FILES } from './p2a_constants.mjs';
import {
  resolveExecutionModePolicy,
  resolveOrchestrationAgentTool,
  resolveRetrospectiveSignals,
  resolveReviewPasses,
} from './p2a_project_config.mjs';
import { normalizePath, resolveP2aPaths } from './p2a_paths.mjs';
import { p2aCommandLine } from './p2a_run_commands.mjs';
import {
  auditArchivedIterationArtifacts,
  currentDevelopmentContractPath,
  iterationCompositionRequirement,
  resolveIterationState,
  resolveCurrentDevelopmentState,
  validateActiveGateBPromotionBinding,
  validateActiveIterationArchiveConsistency,
  validateActiveIterationPlanningContract,
  validateClosedIterationComposition,
  validateClosedIterationRoutingData,
} from './p2a_iteration_state.mjs';
import {
  constitutionApprovalState,
  decisionLedgerPath,
  readDecisions,
  scopeApprovalState,
} from './p2a_decision_ledger.mjs';
import {
  continuationDescriptor,
  runtimePacketModeForContext,
} from './p2a_continuations.mjs';
import { compareRunEvidence, taskGraphRefMatchesGraph } from './p2a_run_paths.mjs';
import { assertFinalVisualReviewRunReady } from './p2a_visual_review_gate.mjs';
import { assertFinalAcceptanceReviewRunReady } from './p2a_acceptance_review_gate.mjs';
import { iterationVerificationStatus } from './p2a_final_verification_gate.mjs';
import {
  buildRetrospectiveCandidates,
  retrospectiveMonitorMismatchRunIds,
} from './p2a_retrospective.mjs';
import {
  discoverEntryDocument,
  discoverFeatureRadarPreflightRuns,
  inspectEntryDocument,
} from './p2a_radar_preflight.mjs';
import {
  acceptanceReviewContract,
  approvedVisualReviewContract,
  createValidationSession,
  currentDevelopmentAcceptanceReviewContract,
  validateConstitution,
  validateIntake,
  validateRunIndexData,
  validateRetrospectiveCandidateData,
  validateRunsDir,
  validateRunTaskContract,
  validateSpec,
  validateTaskGraph,
} from './validate_artifacts.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);

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

function tracePhase(trace, phase, detail = null) {
  if (typeof trace !== 'function') return;
  trace(detail ? `${phase}: ${detail}` : phase);
}

function rawFileSha256(filePath) {
  try {
    if (!isFile(filePath)) return null;
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function contentLanguage(...values) {
  return /[가-힣]/u.test(JSON.stringify(values)) ? 'ko' : 'en';
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

function provisionalEntryDocuments(targetRoot) {
  const entriesRoot = path.join(targetRoot, '.plan2agent', 'entries');
  if (!isDirectory(entriesRoot)) return [];
  try {
    return readdirSync(entriesRoot, { withFileTypes: true })
      .filter((entry) => (
        entry.isFile()
        && /^idea-[a-f0-9]{12}\.md$/u.test(entry.name)
      ))
      .map((entry) => {
        const inspected = inspectEntryDocument(path.join(entriesRoot, entry.name), {
          baseDir: targetRoot,
          selection: 'auto',
        });
        let modifiedAtMs = null;
        try {
          const value = lstatSync(inspected.path).mtimeMs;
          modifiedAtMs = Number.isFinite(value) ? value : null;
        } catch {
          // Invalid or concurrently removed entries are discarded below.
        }
        return { ...inspected, modifiedAtMs };
      })
      .filter((entry) => entry.valid)
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

function timestampMs(value) {
  if (!stringValue(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function activeIntakeForInspection(inspection) {
  const artifactRoot = inspection?.artifactRoot;
  const activeIteration = stringValue(inspection?.activeIteration);
  const paths = new Set([
    inspection?.gates?.intakePath,
    artifactRoot && activeIteration
      ? path.join(artifactRoot, 'iterations', activeIteration, 'gate-a-intake', 'intake.json')
      : null,
    artifactRoot ? path.join(artifactRoot, 'gate-a-intake', 'intake.json') : null,
  ].filter(Boolean));
  for (const intakePath of paths) {
    const data = readJsonObject(intakePath);
    if (!data || !stringValue(data.idea)) continue;
    let modifiedAtMs = null;
    try {
      const value = lstatSync(intakePath).mtimeMs;
      modifiedAtMs = Number.isFinite(value) ? value : null;
    } catch {
      // The caller can still use canonical lifecycle timestamps.
    }
    return { path: intakePath, data, modifiedAtMs };
  }
  return null;
}

function activeScopeForInspection(inspection) {
  const currentSpec = inspection?.currentSpec;
  const activeIteration = stringValue(inspection?.activeIteration);
  const intake = activeIntakeForInspection(inspection);
  const metadata = activeIteration && inspection?.artifactRoot
    ? readJsonObject(path.join(
        inspection.artifactRoot,
        'iterations',
        activeIteration,
        'iteration.json',
      ))
    : null;
  const closedRecords = [
    currentSpec?.last_closed_iteration,
    ...jsonRecords(currentSpec?.closed_iterations),
  ].filter((record) => record?.iteration_id === activeIteration);
  const closed = isClosedIteration(currentSpec, activeIteration);
  const pending = currentSpec?.pending_iteration?.iteration_id === activeIteration
    ? currentSpec.pending_iteration
    : null;
  const idea = stringValue(intake?.data?.idea) ?? stringValue(pending?.idea);
  return {
    closed,
    idea: idea?.trim() ?? null,
    intakeModifiedAtMs: intake?.modifiedAtMs ?? null,
    openedAtMs: timestampMs(pending?.opened_at ?? metadata?.opened_at),
    closedAtMs: timestampMs(
      closedRecords.find((record) => stringValue(record?.closed_at))?.closed_at
      ?? metadata?.closed_at,
    ),
  };
}

function candidateIsNewerThan(candidate, boundaries) {
  const finiteBoundaries = boundaries.filter(Number.isFinite);
  if (!Number.isFinite(candidate.modifiedAtMs)) return finiteBoundaries.length === 0;
  return finiteBoundaries.length === 0
    || candidate.modifiedAtMs > Math.max(...finiteBoundaries);
}

function latestDistinctCandidate(candidates) {
  if (candidates.length === 1) return candidates[0];
  const ordered = [...candidates].sort((left, right) => (
    (right.modifiedAtMs ?? Number.NEGATIVE_INFINITY)
    - (left.modifiedAtMs ?? Number.NEGATIVE_INFINITY)
  ));
  return Number.isFinite(ordered[0]?.modifiedAtMs)
    && ordered[0].modifiedAtMs > (ordered[1]?.modifiedAtMs ?? Number.NEGATIVE_INFINITY)
    ? ordered[0]
    : null;
}

function discoverRelevantProvisionalEntry(targetRoot, inspectedArtifacts) {
  const candidates = provisionalEntryDocuments(targetRoot)
    .map((entry) => ({ ...entry, idea: readFileSync(entry.path, 'utf8').trim() }))
    .filter((entry) => entry.idea);
  if (!candidates.length) return null;

  const activeScopes = inspectedArtifacts.map(activeScopeForInspection);
  const openScopes = activeScopes.filter((scope) => !scope.closed && scope.idea);
  const openScopeIdeas = new Set(openScopes.map((scope) => scope.idea));
  const currentMatches = candidates.filter((entry) => openScopeIdeas.has(entry.idea));
  if (currentMatches.length === 1) {
    return { ...currentMatches[0], provisionalRole: 'current_scope' };
  }

  // A lone saved idea is not enough to associate it with a different live
  // scope. Keep it dormant until that scope closes instead of feeding stale
  // text back into the active Gate A conversation.
  if (openScopes.length) return null;

  const closedScopes = activeScopes.filter((scope) => scope.closed);
  const pending = candidates.filter((entry) => {
    const matchingClosedScopes = closedScopes.filter((scope) => scope.idea === entry.idea);
    if (matchingClosedScopes.length) {
      return candidateIsNewerThan(entry, matchingClosedScopes.flatMap((scope) => [
        scope.closedAtMs,
        scope.closedAtMs === null ? scope.intakeModifiedAtMs : null,
        scope.closedAtMs === null && scope.intakeModifiedAtMs === null
          ? scope.openedAtMs
          : null,
      ]));
    }
    return candidateIsNewerThan(entry, closedScopes.flatMap((scope) => [
      scope.openedAtMs,
      scope.openedAtMs === null ? scope.intakeModifiedAtMs : null,
    ]));
  });
  const selectedPending = latestDistinctCandidate(pending);
  return selectedPending
    ? { ...selectedPending, provisionalRole: 'pending_scope' }
    : null;
}

function readManifest(targetRoot) {
  return readJsonObject(path.join(targetRoot, '.plan2agent', 'manifest.json'));
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
      || discoverFeatureRadarPreflightRuns(candidate, { includeNative: false })
        .some((run) => run.source_kind === 'p2a-preflight')
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

function discoverRunsDir(targetRoot, artifactRoot) {
  return [
    path.join(artifactRoot, 'runs'),
    path.join(path.dirname(artifactRoot), 'runs'),
    path.join(targetRoot, '.plan2agent', 'runs'),
  ].find((candidate) => isDirectory(candidate) && isFile(path.join(candidate, 'run-index.json')));
}

function summarizeRunRecords(targetRoot, runIndexPath, records) {
  const statusCounts = records.reduce((counts, run) => {
    const status = stringValue(run.status) ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    runIndexPath: runIndexPath ? relativeToTarget(targetRoot, runIndexPath) : null,
    runCount: records.length,
    latestRunId: stringValue(records.at(-1)?.runId),
    statusCounts,
  };
}

function inspectRunIndex(targetRoot, artifactRoot) {
  const runsDir = discoverRunsDir(targetRoot, artifactRoot);
  if (!runsDir) {
    return {
      runsDir: null,
      records: [],
      projectId: null,
      valid: true,
      error: null,
      summary: summarizeRunRecords(targetRoot, null, []),
    };
  }
  const runIndexPath = path.join(runsDir, 'run-index.json');
  const runIndex = readJsonObject(runIndexPath);
  if (!runIndex) {
    return {
      runsDir,
      records: [],
      projectId: null,
      valid: false,
      error: 'The canonical run-index.json is unreadable.',
      summary: summarizeRunRecords(targetRoot, runIndexPath, []),
      retrospective: null,
    };
  }
  try {
    validateRunIndexData(runIndex);
  } catch (error) {
    return {
      runsDir,
      records: [],
      projectId: stringValue(runIndex.projectId),
      valid: false,
      error: error instanceof Error ? error.message : String(error),
      summary: summarizeRunRecords(targetRoot, runIndexPath, []),
      retrospective: null,
    };
  }
  const records = jsonRecords(runIndex.runs);
  return {
    runsDir,
    records,
    projectId: stringValue(runIndex.projectId),
    valid: true,
    error: null,
    summary: summarizeRunRecords(targetRoot, runIndexPath, records),
    retrospective: runIndex.retrospective ?? null,
  };
}

function hydrateActiveRunRoutingRecords(runs, activeIteration) {
  if (!runs.runsDir) return [];
  return runs.records
    .filter((run) => run.iterationId === activeIteration)
    .map((indexedRun) => {
      const runId = stringValue(indexedRun.runId) ?? '<unknown>';
      const runRef = stringValue(indexedRun.runRef);
      if (!runRef) {
        throw new Error(`run-index validation failed: active run ${runId} is missing runRef`);
      }
      const runPath = path.resolve(runs.runsDir, runRef);
      try {
        const relative = path.relative(realpathSync(runs.runsDir), realpathSync(runPath));
        if (
          !relative
          || relative === '..'
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
        ) {
          throw new Error('outside run store');
        }
      } catch {
        throw new Error(
          `run-index validation failed: active run ${runId} cannot be resolved inside the run store`,
        );
      }
      const run = readJsonObject(runPath);
      if (!run) {
        throw new Error(`run-index validation failed: active run ${runId} is unreadable`);
      }
      for (const field of ['runId', 'taskId', 'iterationId', 'status', 'startedAt', 'finishedAt']) {
        if (JSON.stringify(run[field]) !== JSON.stringify(indexedRun[field])) {
          throw new Error(
            `run-index validation failed: active run ${runId}.${field} does not match its run file`,
          );
        }
      }
      if (
        Object.hasOwn(indexedRun, 'runKind')
        && (indexedRun.runKind ?? null) !== (run.runKind ?? null)
      ) {
        throw new Error(
          `run-index validation failed: active run ${runId}.runKind does not match its run file`,
        );
      }
      return run;
    });
}

function inspectCurrentRunRouting(targetRoot, artifactRoot, activeIteration) {
  const indexedRuns = inspectRunIndex(targetRoot, artifactRoot);
  if (!indexedRuns.valid || !indexedRuns.runsDir) return indexedRuns;
  try {
    const records = hydrateActiveRunRoutingRecords(indexedRuns, activeIteration);
    return {
      ...indexedRuns,
      records,
      summary: summarizeRunRecords(
        targetRoot,
        path.join(indexedRuns.runsDir, 'run-index.json'),
        records,
      ),
    };
  } catch (error) {
    return {
      ...indexedRuns,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function closedIterationReviewRoutingRequired(
  artifactRoot,
  iterationState,
  runs,
  reviewPasses,
) {
  const activeIteration = iterationState.activeIteration;
  const spec = readJsonObject(iterationState.specPath);
  const experience = readJsonObject(path.join(
    artifactRoot,
    'iterations',
    activeIteration,
    'gate-b-spec',
    'experience-spec.json',
  ));
  if (
    spec?.approval === 'approved'
    && spec?.visual_experience?.experience_spec_ref
    && experience?.validation?.visual_review_required === true
  ) {
    return 'active visual contract requires evidence-aware routing';
  }
  if (reviewPasses?.acceptance === 'on') {
    return 'acceptance review policy requires evidence-aware routing';
  }
  const activeRuns = hydrateActiveRunRoutingRecords(runs, activeIteration);
  if (activeRuns.some((run) => (
    run.runKind === 'final_visual_review'
    || run.runKind === 'final_acceptance_review'
  ))) {
    return 'active review run requires evidence-aware routing';
  }
  return null;
}

function inspectRuns(targetRoot, artifactRoot, trace = null) {
  const runsDir = discoverRunsDir(targetRoot, artifactRoot);
  if (!runsDir) return inspectRunIndex(targetRoot, artifactRoot);
  const runIndexPath = path.join(runsDir, 'run-index.json');
  const runIndex = readJsonObject(runIndexPath);
  const indexedRuns = jsonRecords(runIndex?.runs);
  tracePhase(trace, 'runs:hydrate', `${indexedRuns.length} indexed run(s)`);
  const runs = indexedRuns.map((indexedRun) => {
    const runRef = stringValue(indexedRun.runRef);
    if (!runRef) return indexedRun;
    const runPath = path.resolve(runsDir, runRef);
    try {
      const realRunsDir = realpathSync(runsDir);
      const realRunPath = realpathSync(runPath);
      const relative = path.relative(realRunsDir, realRunPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return indexedRun;
      }
    } catch {
      return indexedRun;
    }
    const run = readJsonObject(runPath);
    if (!run) return indexedRun;
    for (const field of ['runId', 'taskId', 'iterationId', 'status', 'startedAt', 'finishedAt']) {
      if (JSON.stringify(run[field]) !== JSON.stringify(indexedRun[field])) return indexedRun;
    }
    return run;
  });
  return {
    runsDir,
    records: runs,
    projectId: stringValue(runIndex?.projectId),
    valid: Boolean(runIndex),
    error: runIndex ? null : 'The canonical run-index.json is unreadable.',
    summary: summarizeRunRecords(targetRoot, runIndexPath, runs),
    retrospective: runIndex?.retrospective ?? null,
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

function artifactSearchRoots(artifactRoot, activeIteration) {
  const iterationRoot = activeIteration ? path.join(artifactRoot, 'iterations', activeIteration) : null;
  return iterationRoot && isDirectory(iterationRoot) ? [iterationRoot, artifactRoot] : [artifactRoot];
}

function firstGateFile(searchRoots, gateDirectory, filename) {
  return firstExistingFile(searchRoots.map((root) => path.join(root, gateDirectory, filename)));
}

function artifactReferenceMatchesPath(
  reference,
  artifactRoot,
  referenceFilePath,
  expectedPath,
) {
  if (typeof reference !== 'string' || !reference.trim()) return false;
  if (path.isAbsolute(reference)) {
    return path.resolve(reference) === path.resolve(expectedPath);
  }
  const normalizedReference = normalizePath(reference)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const artifactRelative = normalizePath(path.relative(artifactRoot, expectedPath));
  const referenceDirectory = path.dirname(referenceFilePath);
  const gateRoot = path.dirname(referenceDirectory);
  return new Set([
    normalizePath(path.relative(referenceDirectory, expectedPath)),
    normalizePath(path.relative(gateRoot, expectedPath)),
    artifactRelative,
    `${path.basename(artifactRoot)}/${artifactRelative}`,
    `.plan2agent/artifacts/${path.basename(artifactRoot)}/${artifactRelative}`,
  ]).has(normalizedReference);
}

function inspectClosedIterationRouting(
  targetRoot,
  artifactRoot,
  iterationState,
  reviewPasses,
  trace = null,
) {
  const archive = validateActiveIterationArchiveConsistency(iterationState);
  if (!archive.archived) return null;
  const closedIterations = iterationState.currentSpec.closed_iterations ?? [];
  if (
    !closedIterations.length
    || closedIterations.some((closed) => (
      !closed?.artifact_hashes
      || typeof closed.artifact_hashes !== 'object'
      || Array.isArray(closed.artifact_hashes)
    ))
  ) {
    tracePhase(trace, 'closed-route:fallback', 'legacy close records have no artifact hashes');
    return null;
  }

  try {
    tracePhase(trace, 'closed-route:structure');
    validateClosedIterationRoutingData(iterationState.currentSpec);
    tracePhase(trace, 'closed-route:archive-audit', `${closedIterations.length} iteration(s)`);
    auditArchivedIterationArtifacts(iterationState.currentSpec, artifactRoot);
    tracePhase(trace, 'closed-route:composition');
    validateClosedIterationComposition(iterationState.currentSpec, artifactRoot);

    tracePhase(trace, 'closed-route:run-index');
    const runs = inspectRunIndex(targetRoot, artifactRoot);
    if (!runs.valid) {
      throw new Error(`run-index validation failed: ${runs.error}`);
    }
    if (
      runs.runsDir
      && runs.projectId !== iterationState.projectId
    ) {
      throw new Error('run-index projectId must match current-spec.json project_id');
    }
    const activeRuns = runs.records.filter(
      (run) => run.iterationId === iterationState.activeIteration,
    );
    if (activeRuns.some((run) => ['started', 'failed', 'blocked'].includes(run.status))) {
      tracePhase(
        trace,
        'closed-route:fallback',
        'active run requires evidence-aware routing',
      );
      return null;
    }
    const reviewRoutingReason = closedIterationReviewRoutingRequired(
      artifactRoot,
      iterationState,
      runs,
      reviewPasses,
    );
    if (reviewRoutingReason) {
      tracePhase(trace, 'closed-route:fallback', reviewRoutingReason);
      return null;
    }

    const taskGraphPath = iterationState.taskGraphPath;
    const taskGraph = readJsonObject(taskGraphPath);
    const tasks = jsonRecords(taskGraph?.tasks);
    if (!taskGraph || !tasks.length || tasks.some((task) => task.status !== 'done')) {
      throw new Error(
        'archived active iteration must retain a readable, close-ready task graph',
      );
    }
    const composition = iterationCompositionRequirement(iterationState.currentSpec);
    tracePhase(
      trace,
      'closed-route:ready',
      composition.required ? 'composition required' : 'iteration complete',
    );
    return {
      eligible: true,
      error: null,
      composition,
      taskGraphPath,
      taskGraph,
      tasks,
      runs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracePhase(trace, 'closed-route:invalid', message);
    return {
      eligible: false,
      error: message,
    };
  }
}

function inspectArtifact(targetRoot, artifactRoot, isScaffoldProject, options = {}) {
  const { trace = null, validationSession = null, reviewPasses = null } = options;
  tracePhase(trace, 'artifact:inspect', relativeToTarget(targetRoot, artifactRoot));
  const layout = artifactLayout(artifactRoot, isScaffoldProject);
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const currentSpec = readJsonObject(currentSpecPath);
  if (layout.kind === 'iteration' && currentSpec) {
    const activeIteration = stringValue(currentSpec.active_iteration);
    const contractPath = currentDevelopmentContractPath(artifactRoot);
    const currentTaskGraphPath = activeIteration
      ? path.join(
          artifactRoot,
          'iterations',
          activeIteration,
          'gate-c-task-graph',
          'task-graph.json',
        )
      : null;
    if (isFile(contractPath)) {
      tracePhase(trace, 'current:read', relativeToTarget(targetRoot, currentSpecPath));
      tracePhase(trace, 'current:read', relativeToTarget(targetRoot, contractPath));
      try {
        const currentState = resolveCurrentDevelopmentState(artifactRoot, {
          validationSession,
        });
        if (currentState.constitutionPath) {
          tracePhase(
            trace,
            'current:read',
            relativeToTarget(targetRoot, currentState.constitutionPath),
          );
        }
        tracePhase(
          trace,
          'current:read',
          relativeToTarget(targetRoot, currentState.taskGraphPath),
        );
        tracePhase(trace, 'historical:reads', '0');
        const runs = inspectCurrentRunRouting(
          targetRoot,
          artifactRoot,
          currentState.activeIteration,
        );
        return {
          projectId: currentState.projectId,
          artifactRoot,
          layout,
          activeIteration: currentState.activeIteration,
          currentSpec,
          currentSpecReadable: true,
          currentSpecValid: true,
          currentSpecValidationError: null,
          gateBPromotionValid: true,
          gateBPromotionValidationError: null,
          entry: null,
          currentDevelopmentRouting: {
            eligible: true,
            missing: false,
            state: currentState,
          },
          gates: {
            intakePath: contractPath,
            intake: { status: 'ready_for_spec', approval_audit: { current_contract: true } },
            intakeValid: true,
            intakeValidationError: null,
            specPath: contractPath,
            spec: {
              approval: 'approved',
              approval_audit: { current_contract: true },
              product: {
                goals: currentState.currentDevelopmentContract.scope,
              },
            },
            specValid: true,
            specValidationError: null,
            taskGraphPath: currentState.taskGraphPath,
            taskGraph: currentState.taskGraph,
            taskGraphValid: true,
            taskGraphValidationError: null,
          },
          tasks: currentState.taskGraph.tasks,
          runs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tracePhase(trace, 'current:invalid', message);
        tracePhase(trace, 'historical:reads', '0');
        return {
          projectId: stringValue(currentSpec.project_id) ?? path.basename(artifactRoot),
          artifactRoot,
          layout,
          activeIteration,
          currentSpec,
          currentSpecReadable: true,
          currentSpecValid: false,
          currentSpecValidationError: message,
          gateBPromotionValid: false,
          gateBPromotionValidationError: message,
          entry: null,
          currentDevelopmentRouting: {
            eligible: false,
            missing: false,
            error: message,
          },
          gates: {
            intakePath: contractPath,
            intake: null,
            intakeValid: false,
            intakeValidationError: message,
            specPath: contractPath,
            spec: null,
            specValid: false,
            specValidationError: message,
            taskGraphPath: currentTaskGraphPath,
            taskGraph: currentTaskGraphPath ? readJsonObject(currentTaskGraphPath) : null,
            taskGraphValid: false,
            taskGraphValidationError: message,
          },
          tasks: [],
          runs: inspectCurrentRunRouting(targetRoot, artifactRoot, activeIteration),
        };
      }
    }
    if (currentTaskGraphPath && isFile(currentTaskGraphPath)) {
      tracePhase(trace, 'current:contract-missing', relativeToTarget(targetRoot, contractPath));
      tracePhase(trace, 'historical:reads', '0');
      const taskGraph = readJsonObject(currentTaskGraphPath);
      return {
        projectId: stringValue(currentSpec.project_id) ?? path.basename(artifactRoot),
        artifactRoot,
        layout,
        activeIteration,
        currentSpec,
        currentSpecReadable: true,
        currentSpecValid: true,
        currentSpecValidationError: null,
        gateBPromotionValid: true,
        gateBPromotionValidationError: null,
        entry: null,
        currentDevelopmentRouting: {
          eligible: false,
          missing: true,
        },
        gates: {
          intakePath: null,
          intake: null,
          intakeValid: null,
          intakeValidationError: null,
          specPath: null,
          spec: null,
          specValid: null,
          specValidationError: null,
          taskGraphPath: currentTaskGraphPath,
          taskGraph,
          taskGraphValid: Boolean(taskGraph),
          taskGraphValidationError: taskGraph ? null : 'The current task graph is unreadable.',
        },
        tasks: jsonRecords(taskGraph?.tasks),
        runs: inspectCurrentRunRouting(targetRoot, artifactRoot, activeIteration),
      };
    }
  }
  let iterationState = null;
  let currentSpecValidationError = null;
  if (layout.kind === 'iteration') {
    if (!currentSpec) {
      currentSpecValidationError = 'The canonical current-spec.json is unreadable.';
    } else {
      try {
        const resolvedIterationState = resolveIterationState(
          artifactRoot,
          { requireReady: false, validationSession },
        );
        validateActiveIterationPlanningContract(
          resolvedIterationState,
          undefined,
          { validationSession },
        );
        iterationState = resolvedIterationState;
      } catch (error) {
        currentSpecValidationError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const activeIteration = iterationState?.activeIteration ?? null;
  const projectId = stringValue(currentSpec?.project_id) ?? path.basename(artifactRoot);
  const entry = discoverEntryDocument(artifactRoot, {
    baseDir: targetRoot,
    projectId,
    repeatedDevelopment: layout.kind === 'iteration',
  });
  const closedRouting = iterationState
    ? inspectClosedIterationRouting(
        targetRoot,
        artifactRoot,
        iterationState,
        reviewPasses,
        trace,
      )
    : null;
  if (closedRouting) {
    const taskGraphPath = closedRouting.taskGraphPath ?? iterationState.taskGraphPath;
    const taskGraph = closedRouting.taskGraph ?? readJsonObject(taskGraphPath);
    const runs = closedRouting.runs ?? inspectRunIndex(targetRoot, artifactRoot);
    return {
      projectId,
      artifactRoot,
      layout,
      activeIteration,
      currentSpec,
      currentSpecReadable: Boolean(currentSpec),
      currentSpecValid: closedRouting.eligible,
      currentSpecValidationError: closedRouting.error,
      gateBPromotionValid: true,
      gateBPromotionValidationError: null,
      entry,
      closedRouting,
      gates: {
        intakePath: null,
        intake: null,
        intakeValid: null,
        intakeValidationError: null,
        specPath: iterationState.specPath,
        spec: null,
        specValid: null,
        specValidationError: null,
        taskGraphPath,
        taskGraph,
        taskGraphValid: null,
        taskGraphValidationError: null,
      },
      tasks: jsonRecords(taskGraph?.tasks),
      runs,
    };
  }
  tracePhase(trace, 'artifact:deep-validation', relativeToTarget(targetRoot, artifactRoot));
  const searchRoots = artifactSearchRoots(artifactRoot, activeIteration);
  const intakePath = firstGateFile(searchRoots, 'gate-a-intake', 'intake.json');
  const specPath = firstGateFile(searchRoots, 'gate-b-spec', 'spec.json');
  const taskGraphPath = firstExistingFile(searchRoots.flatMap((root) => [
    path.join(root, 'gate-c-task-graph', 'task-graph.json'),
    path.join(root, 'task-graph.json'),
  ]));
  const intake = intakePath ? readJsonObject(intakePath) : null;
  let intakeValid = false;
  let intakeValidationError = null;
  if (intakePath && intake) {
    try {
      validateIntake(intakePath, { artifactRoot, projectId, validationSession });
      intakeValid = true;
    } catch (error) {
      intakeValidationError = error instanceof Error ? error.message : String(error);
    }
  }
  const spec = specPath ? readJsonObject(specPath) : null;
  let specValid = false;
  let specValidationError = null;
  if (specPath && spec) {
    try {
      validateSpec(specPath, intakePath, { artifactRoot, validationSession });
      specValid = true;
    } catch (error) {
      specValidationError = error instanceof Error ? error.message : String(error);
    }
  } else if (specPath) {
    specValidationError = 'The canonical Gate B specification is unreadable.';
  }
  let gateBPromotionValid = layout.kind !== 'iteration';
  let gateBPromotionValidationError = null;
  if (
    layout.kind === 'iteration'
    && iterationState
    && specValid
    && spec?.approval === 'approved'
  ) {
    try {
      validateActiveGateBPromotionBinding(iterationState, spec);
      gateBPromotionValid = true;
    } catch (error) {
      gateBPromotionValidationError = error instanceof Error ? error.message : String(error);
    }
  }
  const taskGraph = taskGraphPath ? readJsonObject(taskGraphPath) : null;
  let taskGraphValid = false;
  let taskGraphValidationError = null;
  if (taskGraphPath && taskGraph) {
    try {
      const validatedTaskGraph = validateTaskGraph(taskGraphPath, specPath, {
        artifactRoot,
        validationSession,
      });
      if (spec?.project_id && validatedTaskGraph.projectId !== spec.project_id) {
        throw new Error('Gate C task graph projectId must match Gate B spec.project_id');
      }
      if (
        specPath
        && !artifactReferenceMatchesPath(
          validatedTaskGraph.sourceSpec,
          artifactRoot,
          taskGraphPath,
          specPath,
        )
      ) {
        throw new Error('Gate C task graph sourceSpec must reference the canonical Gate B specification');
      }
      taskGraphValid = true;
    } catch (error) {
      taskGraphValidationError = error instanceof Error ? error.message : String(error);
    }
  } else if (taskGraphPath) {
    taskGraphValidationError = 'The canonical Gate C task graph is unreadable.';
  }
  let currentSpecValid = layout.kind !== 'iteration' || Boolean(iterationState);
  const shouldValidateReadyIteration = (
    layout.kind === 'iteration'
    && currentSpecValid
    && intakeValid
    && specValid
    && spec?.approval === 'approved'
    && gateBPromotionValid
    && taskGraphValid
  );
  if (shouldValidateReadyIteration) {
    try {
      iterationState = resolveIterationState(artifactRoot, { validationSession });
    } catch (error) {
      currentSpecValid = false;
      currentSpecValidationError = error instanceof Error ? error.message : String(error);
    }
  }
  const runs = inspectRuns(targetRoot, artifactRoot, trace);
  const tasks = jsonRecords(taskGraph?.tasks);
  return {
    projectId,
    artifactRoot,
    layout,
    activeIteration,
    currentSpec,
    currentSpecReadable: Boolean(currentSpec),
    currentSpecValid,
    currentSpecValidationError,
    gateBPromotionValid,
    gateBPromotionValidationError,
    entry,
    gates: {
      intakePath,
      intake,
      intakeValid,
      intakeValidationError,
      specPath,
      spec,
      specValid,
      specValidationError,
      taskGraphPath,
      taskGraph,
      taskGraphValid,
      taskGraphValidationError,
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
    entry: summarizeEntry(targetRoot, inspected.entry),
    taskGraphPath: gates.taskGraphPath ? relativeToTarget(targetRoot, gates.taskGraphPath) : null,
    taskCounts: countTasks(gates.taskGraph),
    readyTaskIds: readyTasks,
    runs: inspected.runs.summary,
  };
}

function summarizeEntry(targetRoot, entry) {
  if (!entry) return null;
  return {
    path: relativeToTarget(targetRoot, entry.path),
    sourceKind: entry.sourceKind,
    selection: entry.selection,
    sequence: entry.sequence,
    manifestPath: entry.manifestPath
      ? relativeToTarget(targetRoot, entry.manifestPath)
      : null,
    sourceComplete: entry.sourceComplete,
    valid: entry.valid,
    errors: entry.errors,
    warnings: entry.warnings,
    webSourceCount: entry.webSourceCount,
    recommendationCount: entry.recommendationCount,
    referenceBundle: entry.referenceBundle ? {
      path: relativeToTarget(targetRoot, entry.referenceBundle.path),
      sha256: entry.referenceBundle.sha256,
      valid: entry.referenceBundle.valid,
      referenceCount: entry.referenceBundle.referenceCount,
      references: entry.referenceBundle.references.map((reference) => ({ ...reference })),
    } : null,
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

function summarizeBuildLoreEnhancement(manifest, config) {
  const state = capabilityState(manifest, config, 'buildlore');
  const configBuildLore = state.configRecord;
  const manifestBuildLore = state.manifestRecord;
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
  const commandEnv = stringValue(configBuildLore.commandEnv) ?? 'BUILDLORE_BIN';
  return {
    enabled: true,
    mode: stringValue(manifestBuildLore.mode) ?? stringValue(configBuildLore.mode) ?? 'local_cli',
    manifestPresent: state.manifestPresent,
    configPresent: state.configPresent,
    manifestEnabled: state.manifestEnabled,
    configEnabled: state.configEnabled,
    inSync: state.inSync,
    command: stringValue(configBuildLore.command) ?? 'buildlore',
    commandEnv,
    commandConfigured: Boolean(process.env[commandEnv] || stringValue(configBuildLore.command)),
    syncPolicy: stringValue(configBuildLore.syncPolicy) ?? 'explicit',
    retrievalMode: stringValue(configBuildLore.retrievalMode) ?? 'hybrid',
    publicationPolicy: stringValue(configBuildLore.publicationPolicy) ?? 'explicit_git',
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
  const keys = ['devSkills', 'buildlore', 'orchestration', 'proposals'];
  const enabled = keys.filter((key) => capabilityState(manifest, config, key).enabled);
  return {
    enabled,
    buildlore: summarizeBuildLoreEnhancement(manifest, config),
    orchestration: summarizeOrchestrationEnhancement(manifest, config),
    proposals: summarizeProposalsEnhancement(targetRoot, manifest, config),
  };
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

function taskSourceArgs(context) {
  if (context.detail.layout.kind === 'iteration') {
    return ['--artifacts', context.artifactArg];
  }
  return [
    '--graph',
    commandProjectPath(context.targetRoot, context.gates.taskGraphPath),
  ];
}

function latestBlockedUserDecisionRun(activeRuns, blockedTaskIds) {
  const reversed = [...activeRuns].reverse();
  const latestTaskRuns = blockedTaskIds
    .map((taskId) => reversed.find((run) => run.taskId === taskId))
    .filter(Boolean);
  return latestTaskRuns.find((run) => (
    ['failed', 'blocked'].includes(run.status)
    && run.failure?.needsUserDecision === true
  )) ?? null;
}

function latestRetryableBlockedRun(activeRuns, blockedTaskIds) {
  const reversed = [...activeRuns].reverse();
  return blockedTaskIds
    .map((taskId) => reversed.find((run) => run.taskId === taskId))
    .filter(Boolean)
    .find((run) => (
      run.status === 'blocked'
      && run.failure?.needsUserDecision === false
      && run.failure?.retryable !== 'no'
    )) ?? null;
}

function firstRecordedBlockerDetail(run) {
  const candidates = [
    ...(run?.localization?.findings ?? []),
    ...(run?.reproduction?.notes ?? []),
    ...(run?.reproduction?.steps ?? []),
    ...(run?.guard?.notes ?? []),
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim()
    ?? `the blocker recorded by run ${run?.runId ?? '<unknown>'}`;
}

function blockedUserDecisionReason(run) {
  const detail = firstRecordedBlockerDetail(run);
  if (run?.failure?.class === 'scope_violation') {
    return `Task ${run.taskId} is blocked by an out-of-scope change described as ${JSON.stringify(detail)}. Confirm that P2A should revert that change and retry inside the approved scope. Reject this action if the product goal itself must expand; the task will stay blocked until a replacement scope is approved.`;
  }
  if (run?.failure?.class === 'missing_dependency') {
    return `Task ${run.taskId} is blocked by a missing dependency described as ${JSON.stringify(detail)}. Confirm the dependency or bounded alternative that is authorized inside the approved plan, then retry the same task. Reject this action if the approved dependency contract must change.`;
  }
  return `Task ${run?.taskId ?? '<unknown>'} is blocked and cannot be resolved automatically. Confirm the intended resolution for ${JSON.stringify(detail)} only if it stays inside the approved plan, then retry the same task.`;
}

function blockedUserDecisionSummary(run) {
  const detail = firstRecordedBlockerDetail(run);
  const korean = contentLanguage(detail) === 'ko';
  if (run?.failure?.class === 'scope_violation') {
    return korean
      ? [
          `승인 범위를 벗어난 변경을 되돌리고 현재 범위 안에서 다시 진행합니다: ${detail}`,
          '제품 목표를 넓혀야 한다면 승인하지 말고 새 범위 계획을 요청합니다.',
        ]
      : [
          `Revert the out-of-scope change and retry inside the approved scope: ${detail}`,
          'If the product goal must expand, reject this recovery and request a new scope plan.',
        ];
  }
  if (run?.failure?.class === 'missing_dependency') {
    return korean
      ? [
          `승인된 계획 안에서 사용할 dependency 또는 대안을 확인하고 다시 진행합니다: ${detail}`,
          'dependency 계약 자체가 바뀌어야 한다면 승인하지 말고 계획 변경을 요청합니다.',
        ]
      : [
          `Confirm the dependency or bounded alternative allowed by the approved plan: ${detail}`,
          'If the dependency contract itself must change, reject this recovery and request a plan change.',
        ];
  }
  return korean
    ? [`승인된 계획 안에서 다음 해결 방향을 적용하고 다시 진행합니다: ${detail}`]
    : [`Apply this bounded resolution inside the approved plan and retry: ${detail}`];
}

function entryIdea(entry) {
  if (!entry?.valid || !isFile(entry.path)) return null;
  const idea = readFileSync(entry.path, 'utf8').trim();
  return idea || null;
}

function entryMatchesCurrentScope(context) {
  const candidateIdea = entryIdea(context.entry);
  if (!candidateIdea) return false;
  const routedIntakeIdea = stringValue(context.gates?.intake?.idea);
  if (routedIntakeIdea?.trim() === candidateIdea) return true;
  const activeIteration = stringValue(context.detail?.activeIteration);
  if (!activeIteration || !context.artifactRoot) return false;
  const activeIntake = readJsonObject(path.join(
    context.artifactRoot,
    'iterations',
    activeIteration,
    'gate-a-intake',
    'intake.json',
  ));
  return stringValue(activeIntake?.idea)?.trim() === candidateIdea;
}

function deferredEntryDecisionSummary(context) {
  const idea = entryIdea(context.entry);
  const preview = idea && idea.length > 180 ? `${idea.slice(0, 177).trimEnd()}...` : idea;
  return [
    `Saved the new request for the next scope${preview ? `: ${preview}` : '.'}`,
    'The current approved work remains authoritative until it is finished or explicitly replaced.',
  ];
}

function nextIterationIdea(context) {
  if (!context.explicitEntryRequested && !context.pendingProvisionalEntry) {
    return '<change idea>';
  }
  return entryIdea(context.entry) ?? '<change idea>';
}

function readOnlyNextCommand(argv) {
  if (!Array.isArray(argv) || !argv.length) return false;
  const [command, action] = argv;
  if (['info', 'status', 'doctor', 'validate', 'decisions'].includes(command)) return true;
  if (command === 'next') return !argv.includes('--idea');
  if (command === 'iteration' && ['current', 'validate', 'context'].includes(action)) return true;
  if (['run', 'runs'].includes(command) && ['list', 'show', 'revision', 'validate'].includes(action)) return true;
  if (['task', 'tasks'].includes(command) && ['list', 'show', 'prompt'].includes(action)) return true;
  if (command === 'execute' && ['plan', 'status', 'resume'].includes(action)) return true;
  return ['update', 'upgrade'].includes(command) && argv.includes('--dry-run');
}

function cliNextAction(state, reason, argv, requiresApproval = null, continuation = null) {
  return {
    state,
    reason,
    continuation,
    command: {
      kind: 'cli',
      argv,
      display: p2aCommandLine(P2A_PATHS, argv),
      requiresApproval: requiresApproval ?? !readOnlyNextCommand(argv),
    },
  };
}

function skillNextAction(state, reason, display, skill, args = [], continuation = null) {
  return {
    state,
    reason,
    continuation,
    command: {
      kind: 'skill',
      skill,
      args,
      display,
    },
  };
}

function approvalNextAction(
  state,
  reason,
  display,
  { options = null, argv = null, decisionSummary = null } = {},
) {
  const command = {
    kind: 'approval',
    display,
  };
  if (Array.isArray(options) && options.length) command.options = options;
  if (Array.isArray(argv) && argv.length) {
    command.argv = argv;
    command.quotePlaceholder = '<user-utterance>';
  }
  if (Array.isArray(decisionSummary) && decisionSummary.length) {
    command.decisionSummary = decisionSummary;
  }
  return {
    state,
    reason,
    continuation: null,
    command,
  };
}

function completionOptions(context) {
  const remediationArgv = [
    'execute',
    'remediate',
    '--artifacts',
    context.artifactArg,
    '--task',
    '<task-id>',
    '--finding',
    '<review finding>',
  ];
  const closeArgv = ['iteration', 'close', '--artifacts', context.artifactArg];
  const proposalArgv = [
    'proposals',
    'mine',
    '--artifacts',
    context.artifactArg,
    '--iteration',
    context.detail.activeIteration,
    '--proposals',
    context.proposalQueueArg,
  ];
  const proposalMining = context.retrospectiveCandidates.length
    && context.proposalQueueArg
    ? {
        kind: 'cli',
        argv: proposalArgv,
        display: p2aCommandLine(P2A_PATHS, proposalArgv),
        requiresApproval: true,
      }
    : null;
  const reportPath = commandProjectPath(
    context.targetRoot,
    path.join(
      context.targetRoot,
      'docs',
      'retrospective',
      `${context.projectId}-${context.detail.activeIteration}.md`,
    ),
  );
  return [
    {
      id: 'review',
      label: 'Review and remediate',
      description: 'Keep the active iteration open, review the completed implementation read-only using current final verification evidence, and start a linked in-iteration remediation run only when a finding requires code changes.',
      action: {
        kind: 'review',
        display: `Review the completed implementation read-only while keeping the active iteration open. Inspect the diff, code, tests, and current verification evidence without rerunning product commands. If no material finding exists, do not repeat this menu: report "No material issue found" and ask once whether to close with ${p2aCommandLine(P2A_PATHS, closeArgv)}. A material finding starts a linked remediation run in the same iteration and returns the task to done only after verification passes.`,
        remediation: {
          kind: 'cli',
          argv: remediationArgv,
          display: p2aCommandLine(P2A_PATHS, remediationArgv),
          requiresApproval: false,
        },
      },
    },
    {
      id: 'retrospective',
      label: context.retrospectiveCandidates.length
        ? 'Review development process (Recommended)'
        : 'Review development process',
      description: context.retrospectiveCandidates.length
        ? `Review ${context.retrospectiveCandidates.length} detected development performance or P2A process signal(s) before deciding whether to continue the retrospective.`
        : 'No automatic development process signal was found. Ask once whether the user experienced delay, errors, wrong routing, or unnecessary steps.',
      action: {
        kind: 'retrospective',
        display: context.retrospectiveCandidates.length
          ? 'Report the bounded development-process retrospective candidates in plain language, distinguish product verification from P2A workflow signals, then ask whether to continue the retrospective. Keep product review and iteration close separate.'
          : 'Ask once whether the user experienced any P2A delay, error, wrong routing, or unnecessary step. If not, return to this decision without creating a report.',
        report: {
          kind: 'artifact',
          path: reportPath,
          display: `After the user explicitly continues the retrospective, write the minimal report to ${reportPath}.`,
          requiresApproval: true,
        },
        ...(proposalMining ? { proposalMining } : {}),
      },
    },
    {
      id: 'close',
      label: context.retrospectiveCandidates.length
        ? 'Close iteration'
        : 'Close iteration (Recommended)',
      description: context.retrospectiveCandidates.length
        ? 'Archive the completed active iteration without running another optional review, or after explicitly ending the review loop.'
        : 'Current verification is fresh and no automatic review or retrospective signal is open; archive this completed work unless you want an optional review.',
      action: {
        kind: 'cli',
        argv: closeArgv,
        display: p2aCommandLine(P2A_PATHS, closeArgv),
        requiresApproval: true,
      },
    },
  ];
}

function gateANextState(intake) {
  return intake?.status === 'ready_for_spec'
    ? 'gate_a_ready_for_spec'
    : 'gate_a_needs_approval';
}

function gateANextKind(intake) {
  return intake?.status === 'ready_for_spec' ? 'skill' : 'approval';
}

function gateANextReason(intake) {
  return intake?.status === 'ready_for_spec'
    ? 'Gate A scope is approved and ready for specification.'
    : 'Gate A scope still needs explicit user approval before a specification can be written.';
}

function gateANextCommand(intake, intakePath) {
  return intake?.status === 'ready_for_spec'
    ? '/p2a-spec'
    : `Review and approve ${intakePath}; then record the Gate A approval_audit.`;
}

function gateAHasOpenQuestions(intake) {
  return Boolean(intake && intake.status !== 'ready_for_spec');
}

function gateAApprovalCommand(context) {
  const intakePath = commandProjectPath(context.targetRoot, context.gates.intakePath);
  const hasLegacyApprovalCopy = Boolean(
    context.gates.intake?.status === 'ready_for_spec'
    && context.gates.intake?.approval_audit,
  );
  const needsDocumentEntry = !context.gates.intake?.baseline_context && !hasLegacyApprovalCopy;
  if (needsDocumentEntry && !context.entryArg) {
    return `Review ${intakePath}, then rerun p2a next --entry <original-entry-path> so Gate A approval can bind entry and reference provenance.`;
  }
  const entryOption = context.entryArg
    ? ` --entry ${JSON.stringify(context.entryArg)}`
    : '';
  return `Review ${intakePath}, then run p2a decide --quote "<user utterance>"${entryOption} --artifacts ${JSON.stringify(context.artifactArg)}.`;
}

function gateAApprovalArgv(context) {
  const hasLegacyApprovalCopy = Boolean(
    context.gates.intake?.status === 'ready_for_spec'
    && context.gates.intake?.approval_audit,
  );
  const needsDocumentEntry = !context.gates.intake?.baseline_context && !hasLegacyApprovalCopy;
  if (needsDocumentEntry && !context.entryArg) return null;
  return [
    'decide',
    '--quote',
    '<user-utterance>',
    ...(context.entryArg ? ['--entry', context.entryArg] : []),
    '--artifacts',
    context.artifactArg,
  ];
}

function compactDecisionSummary(values, maxItems = 8) {
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))].slice(0, maxItems);
}

function gateAScopeDecisionSummary(context) {
  const intake = context.gates.intake;
  if (!intake) return [];
  const korean = contentLanguage(intake.idea, intake.summary) === 'ko';
  const idea = stringValue(intake.idea);
  const summary = stringValue(intake.summary);
  const assumptions = jsonRecords(intake.assumptions)
    .map((item) => stringValue(item.statement))
    .filter(Boolean);
  const confirmedAnswers = [
    ...jsonRecords(intake.clarifying_questions),
    ...jsonRecords(intake.needs_user_decision),
  ]
    .filter((item) => item.status === 'answered' && stringValue(item.answer))
    .map((item) => {
      const question = stringValue(item.question);
      const answer = stringValue(item.answer);
      return question
        ? `${korean ? '확인한 결정' : 'Confirmed decision'}: ${question} → ${answer}`
        : `${korean ? '확인한 결정' : 'Confirmed decision'}: ${answer}`;
    });
  return compactDecisionSummary([
    idea ? `${korean ? '목표' : 'Goal'}: ${idea}` : null,
    summary && summary !== idea ? `${korean ? '범위 요약' : 'Scope summary'}: ${summary}` : null,
    ...confirmedAnswers,
    intake.baseline_context
      ? korean
        ? '최소 범위: 요청한 변경에 필요한 부분만 수정합니다.'
        : 'Minimum scope: change only what the request requires.'
      : null,
    ...(intake.baseline_context
      ? assumptions.slice(0, 2).map((item) => `${korean ? '유지 조건' : 'Must preserve'}: ${item}`)
      : assumptions.slice(0, 2).map((item) => `${korean ? '가정' : 'Assumption'}: ${item}`)),
  ]);
}

function constitutionDecisionSummary(context) {
  const constitution = context.constitution.data;
  if (!constitution) return [];
  const korean = contentLanguage(constitution) === 'ko';
  const summary = compactDecisionSummary([
    ...jsonRecords(constitution.architecture).map((item) => (
      stringValue(item.rule) ? `${korean ? '아키텍처' : 'Architecture'}: ${item.rule}` : null
    )),
    ...jsonRecords(constitution.stack).map((item) => (
      stringValue(item.choice) ? `${korean ? '기술 선택' : 'Stack choice'}: ${item.choice}` : null
    )),
    ...jsonRecords(constitution.prohibitions).map((item) => (
      stringValue(item.rule) ? `${korean ? '금지 조건' : 'Prohibition'}: ${item.rule}` : null
    )),
  ]);
  return summary.length
    ? summary
    : [korean
        ? '장기 프로젝트 제약: 새로 추가할 아키텍처·기술·금지 조건이 없습니다.'
        : 'Long-term project constraints: no new architecture, stack, or prohibition rules.'];
}

function gateBDecisionSummary(context) {
  const spec = context.gates.spec;
  if (!spec) return [];
  const korean = contentLanguage(spec.product, spec.implementation) === 'ko';
  const product = spec.product ?? {};
  const implementation = spec.implementation ?? {};
  const first = (value) => stringArrayValue(value).map(stringValue).filter(Boolean)[0] ?? null;
  const implementationChoices = compactDecisionSummary([
    first(implementation.architecture),
    first(implementation.interfaces),
    first(implementation.dependencies),
  ], 3);
  return compactDecisionSummary([
    stringValue(product.problem) ? `${korean ? '제품 결과' : 'Product outcome'}: ${product.problem.trim()}` : null,
    first(product.goals) ? `${korean ? '최소 범위' : 'Minimum scope'}: ${first(product.goals)}` : null,
    first(product.must_preserve) ? `${korean ? '유지 조건' : 'Must preserve'}: ${first(product.must_preserve)}` : null,
    implementationChoices.length
      ? `${korean ? '구현 방법' : 'Implementation'}: ${implementationChoices.join(' / ')}`
      : null,
    first(implementation.verification) ? `${korean ? '검증 방법' : 'Verification'}: ${first(implementation.verification)}` : null,
  ]);
}

function inspectConstitution(targetRoot) {
  const constitutionPath = path.join(targetRoot, '.plan2agent', 'constitution.json');
  const legacyStylePath = path.join(targetRoot, '.plan2agent', 'style.md');
  const legacyStyleExists = isFile(legacyStylePath);
  if (!existsSync(constitutionPath)) {
    return {
      path: constitutionPath,
      exists: false,
      readable: false,
      valid: false,
      approved: false,
      error: null,
      legacyStyleExists,
    };
  }
  if (!isFile(constitutionPath)) {
    return {
      path: constitutionPath,
      exists: true,
      readable: false,
      valid: false,
      approved: false,
      error: 'The project constitution is not a regular file.',
      legacyStyleExists,
    };
  }
  const data = readJsonObject(constitutionPath);
  if (!data) {
    return {
      path: constitutionPath,
      exists: true,
      readable: false,
      valid: false,
      approved: false,
      error: 'The project constitution is unreadable.',
      legacyStyleExists,
    };
  }
  try {
    const constitution = validateConstitution(constitutionPath);
    return {
      path: constitutionPath,
      exists: true,
      readable: true,
      valid: true,
      approved: Boolean(constitution.approval_audit),
      error: null,
      legacyStyleExists,
      data: constitution,
    };
  } catch (error) {
    return {
      path: constitutionPath,
      exists: true,
      readable: true,
      valid: false,
      approved: false,
      error: error instanceof Error ? error.message : String(error),
      legacyStyleExists,
      data,
    };
  }
}

function inspectDecisions(artifactRoot) {
  const ledgerPath = decisionLedgerPath(artifactRoot);
  if (!existsSync(ledgerPath)) {
    return { path: ledgerPath, exists: false, valid: true, records: [], error: null };
  }
  try {
    return {
      path: ledgerPath,
      exists: true,
      valid: true,
      records: readDecisions(artifactRoot, { required: true }),
      error: null,
    };
  } catch (error) {
    return {
      path: ledgerPath,
      exists: true,
      valid: false,
      records: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function gateAInvalidatesGateB(gates) {
  if (!gates.intake || !gates.specPath) return false;
  if (gates.intake.status !== 'ready_for_spec' || !gates.intake.approval_audit) return true;
  const expectedIntakeSha256 = stringValue(gates.spec?.source_intake_sha256);
  if (!expectedIntakeSha256) return false;
  const actualIntakeSha256 = rawFileSha256(gates.intakePath);
  return !actualIntakeSha256 || expectedIntakeSha256 !== actualIntakeSha256;
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

function iterationReviewNeeded(activeRuns, options, runKind, assertReady) {
  const latestRun = activeRuns
    .map((run, runOrder) => ({ run, runOrder }))
    .filter(({ run }) => run.runKind === runKind)
    .sort(compareRunEvidence)[0]?.run;
  try {
    assertReady({
      runsDir: options.runsDir,
      run: latestRun,
      artifactRoot: options.artifactRoot,
      graphPath: options.graphPath,
    });
    return false;
  } catch {
    return true;
  }
}

function iterationVisualReviewNeeded(activeRuns, options) {
  return iterationReviewNeeded(
    activeRuns,
    options,
    'final_visual_review',
    (reviewOptions) => assertFinalVisualReviewRunReady({
      ...reviewOptions,
      taskId: 'the active iteration',
    }),
  );
}

function iterationAcceptanceReviewNeeded(activeRuns, options) {
  return iterationReviewNeeded(
    activeRuns,
    options,
    'final_acceptance_review',
    assertFinalAcceptanceReviewRunReady,
  );
}

function inspectionForArtifact(targetRoot, artifact, inspectedArtifacts) {
  const artifactRoot = path.resolve(targetRoot, artifact.artifactRoot);
  return inspectedArtifacts.find((candidate) => candidate.artifactRoot === artifactRoot) ?? null;
}

function hasCanonicalPlanningState(inspection) {
  const { gates, layout } = inspection;
  return Boolean(
    layout.hasCurrentSpec
    || layout.hasIterations
    || gates.intakePath
    || gates.specPath
    || gates.taskGraphPath
  );
}

function activeIterationAwaitsGateA(context) {
  const activeIteration = stringValue(context.detail?.activeIteration);
  const pendingIteration = context.detail?.currentSpec?.pending_iteration;
  const gateAEntryStatus = ['active_planning', 'gate_a_interview'].includes(
    pendingIteration?.status,
  );
  if (
    context.detail?.layout?.kind !== 'iteration'
    || context.currentSpecValid !== true
    || !activeIteration
    || pendingIteration?.iteration_id !== activeIteration
    || !gateAEntryStatus
    || context.gateAExists
    || context.gateBExists
    || context.gateCExists
    || context.decisions?.valid === false
    || context.startedRun
  ) {
    return false;
  }

  const iterationRoot = path.join(
    context.artifactRoot,
    'iterations',
    activeIteration,
  );
  return ![
    path.join(iterationRoot, 'gate-a-intake', 'intake.json'),
    path.join(iterationRoot, 'gate-b-spec', 'spec.json'),
    path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json'),
    path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.draft.json'),
    path.join(iterationRoot, 'task-graph.json'),
  ].some(isFile);
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

function iterationStateValidationCommand(context) {
  return [
    'iteration',
    'validate',
    '--artifacts',
    context.artifactArg,
    ...(context.detail.currentSpec?.pending_iteration ? ['--allow-planning'] : []),
  ];
}

function buildNextDecisionContext(
  info,
  targetRoot,
  requestedProjectId,
  inspectedArtifacts,
  reviewPasses,
  executionModePolicy,
  retrospectivePolicy,
  explicitEntry,
  validationSession,
) {
  const hasHarness = isDirectory(path.join(targetRoot, '.plan2agent'));
  const context = {
    info,
    targetRoot,
    hasHarness,
    reviewPasses,
    executionModePolicy,
    retrospectivePolicy,
    entry: explicitEntry,
    entryArg: explicitEntry ? commandProjectPath(targetRoot, explicitEntry.path) : null,
    explicitEntryRequested: explicitEntry?.selection === 'explicit',
    pendingProvisionalEntry: explicitEntry?.provisionalRole === 'pending_scope',
    projectId: requestedProjectId,
    hasCanonicalPlanningState: false,
    constitution: inspectConstitution(targetRoot),
  };
  if (!hasHarness || !info.artifacts.length) return context;

  let selectionInfo = info;
  let selectionInspections = inspectedArtifacts;
  if (explicitEntry && !requestedProjectId) {
    const canonicalInspections = inspectedArtifacts.filter(hasCanonicalPlanningState);
    if (!canonicalInspections.length) return context;
    const canonicalRoots = new Set(
      canonicalInspections.map((inspection) => inspection.artifactRoot),
    );
    selectionInfo = {
      ...info,
      artifacts: info.artifacts.filter((artifact) => (
        canonicalRoots.has(path.resolve(targetRoot, artifact.artifactRoot))
      )),
    };
    selectionInspections = canonicalInspections;
  }

  const selected = selectNextArtifact(
    selectionInfo,
    targetRoot,
    requestedProjectId,
    selectionInspections,
  );
  if (selected.selection) return { ...context, selection: selected.selection };

  const artifactRoot = path.resolve(targetRoot, selected.artifact.artifactRoot);
  const detail = inspectionForArtifact(targetRoot, selected.artifact, inspectedArtifacts);
  if (!detail) throw new Error(`artifact inspection is unavailable: ${artifactRoot}`);
  const { gates } = detail;
  const decisions = detail.currentDevelopmentRouting?.eligible
    ? { path: decisionLedgerPath(artifactRoot), exists: false, valid: true, records: [], error: null }
    : inspectDecisions(artifactRoot);
  const entry = explicitEntry ?? detail.entry;
  const artifactArg = commandArtifact(targetRoot, artifactRoot);
  if (detail.closedRouting) {
    const closedContext = {
      ...context,
      decisions,
      artifactRoot,
      artifactArg,
      projectId: detail.projectId,
      entry,
      entryArg: entry ? commandProjectPath(targetRoot, entry.path) : null,
      hasCanonicalPlanningState: true,
      detail,
      gates,
    };
    if (decisions.exists && !decisions.valid) {
      return {
        ...closedContext,
        selection: cliNextAction(
          'invalid_decisions',
          `The decision ledger is invalid: ${decisions.error ?? 'validation failed'}`,
          ['validate', '--decisions', '--artifacts', artifactArg],
        ),
      };
    }
    if (!detail.closedRouting.eligible) {
      const runIndexFailure = detail.closedRouting.error?.startsWith(
        'run-index validation failed:',
      );
      return {
        ...closedContext,
        selection: cliNextAction(
          'invalid_iteration_state',
          `The archived iteration routing state is invalid: ${detail.closedRouting.error}`,
          runIndexFailure && detail.runs.runsDir
            ? ['validate', '--runs-dir', commandProjectPath(targetRoot, detail.runs.runsDir)]
            : ['iteration', 'validate', '--artifacts', artifactArg],
        ),
      };
    }
    if (closedContext.explicitEntryRequested && entry?.valid === false) {
      return {
        ...closedContext,
        selection: approvalNextAction(
          'entry_invalid',
          `The entry document did not validate: ${closedContext.entryArg}`,
          `Fix the document, then run ${p2aCommandLine(P2A_PATHS, ['validate', '--entry', closedContext.entryArg])}.`,
        ),
      };
    }
    const composition = detail.closedRouting.composition;
    if (composition.required) {
      return {
        ...closedContext,
        selection: cliNextAction(
          'iteration_composition_required',
          composition.missingClosedIterations.length
            ? `The closed iteration baseline is incomplete; compose missing iterations ${JSON.stringify(composition.missingClosedIterations)} before opening the next iteration.`
            : 'Multiple iterations are closed, but current-spec.json has not been composed into the effective baseline.',
          ['iteration', 'compose', '--artifacts', artifactArg],
        ),
      };
    }
    return {
      ...closedContext,
      selection: cliNextAction(
        'iteration_complete',
        (closedContext.explicitEntryRequested || closedContext.pendingProvisionalEntry)
          ? 'The active iteration is closed and the supplied request is ready to open as the next iteration.'
          : 'The active iteration is closed; start the next iteration when a new change idea is ready.',
        [
          'iteration',
          'open',
          '--artifacts',
          artifactArg,
          '--iteration-id',
          '<id>',
          '--idea',
          nextIterationIdea(closedContext),
        ],
      ),
    };
  }
  const canonicalPlanningState = hasCanonicalPlanningState(detail);
  const iterationScopedRuns = runsForActiveIteration(detail.runs.records, detail.activeIteration);
  const activeRuns = detail.layout.kind === 'iteration'
    ? iterationScopedRuns.filter((run) => (
        run.sourceLayout === 'iteration'
        && gates.taskGraphPath
        && taskGraphRefMatchesGraph(run.taskGraphRef, gates.taskGraphPath, artifactRoot)
      ))
    : iterationScopedRuns;
  const startedRun = iterationScopedRuns.find((run) => (
    run.status === 'started'
    && stringValue(run.runId)
    && (detail.layout.kind !== 'iteration' || run.sourceLayout === 'iteration')
  ));
  let startedRunContractError = null;
  if (startedRun && detail.runs.runsDir) {
    try {
      validateRunTaskContract(
        startedRun,
        path.dirname(path.resolve(detail.runs.runsDir)),
        { validationSession, runsDir: detail.runs.runsDir },
      );
    } catch (error) {
      startedRunContractError = error instanceof Error ? error.message : String(error);
    }
  }
  const taskCounts = countTasks(gates.taskGraph);
  const allTasksDone = taskCounts.total > 0 && taskCounts.done === taskCounts.total;
  const compositionRequirement = detail.currentDevelopmentRouting?.eligible
    ? { required: false, missingClosedIterations: [] }
    : iterationCompositionRequirement(detail.currentSpec);
  const hasRequiredVisualContract = detail.currentDevelopmentRouting?.eligible
    ? Boolean(
        detail.currentDevelopmentRouting.state.currentDevelopmentContract.visualContract,
      )
    : Boolean(
        gates.specValid
        && gates.specPath
        && approvedVisualReviewContract(
          gates.specPath,
          artifactRoot,
          { validationSession },
        ),
      );
  const acceptanceReviewActivated = (
    reviewPasses.acceptance === 'opt_in'
    && activeRuns.some((run) => run.runKind === 'final_acceptance_review')
  );
  let acceptanceReviewApplicable = false;
  if (
    reviewPasses.acceptance === 'on'
    && !hasRequiredVisualContract
    && allTasksDone
    && detail.layout.kind === 'iteration'
    && gates.specValid
  ) {
    try {
      const currentAcceptance = detail.currentDevelopmentRouting?.eligible
        ? currentDevelopmentAcceptanceReviewContract(
            detail.currentDevelopmentRouting.state.currentDevelopmentContract,
            artifactRoot,
            { validationSession, allowEmpty: true },
          )
        : acceptanceReviewContract(
            gates.specPath,
            artifactRoot,
            { validationSession, allowEmpty: true },
          );
      acceptanceReviewApplicable = currentAcceptance.criteria.length > 0;
    } catch {
      // Preserve the existing fail-closed route for malformed acceptance inputs.
      // Only a valid, explicitly empty current-iteration contract is not applicable.
      acceptanceReviewApplicable = true;
    }
  }
  const acceptanceReviewEnabled = acceptanceReviewActivated || (
    reviewPasses.acceptance === 'on'
    && acceptanceReviewApplicable
  );
  const needsCloseReadyFullVerificationAudit = (
    allTasksDone
    && detail.layout.kind === 'iteration'
  );
  const proposals = info.enhancements.proposals;
  let runEvidenceValidationError = null;
  if (
    detail.runs.runsDir
    && allTasksDone
  ) {
    try {
      if (detail.currentDevelopmentRouting?.eligible) {
        if (!detail.runs.valid) {
          throw new Error(detail.runs.error ?? 'The canonical run index is invalid.');
        }
        validateRunsDir(detail.runs.runsDir, {
          validationSession,
          iterationId: detail.activeIteration,
        });
      } else {
        validateRunsDir(detail.runs.runsDir, { validationSession });
      }
    } catch (error) {
      runEvidenceValidationError = error instanceof Error
        ? error.message
        : String(error);
    }
  }
  const retrospectiveCandidates = (
    retrospectivePolicy.enabled
    && allTasksDone
    && detail.layout.kind === 'iteration'
    && !runEvidenceValidationError
  ) ? buildRetrospectiveCandidates({
      projectId: detail.projectId,
      iterationId: detail.activeIteration,
      runs: activeRuns,
      retrospective: detail.runs.retrospective,
      policy: retrospectivePolicy,
      monitorMismatchRunIds: retrospectiveMonitorMismatchRunIds(
        detail.runs.runsDir,
        activeRuns,
      ),
    }).map(validateRetrospectiveCandidateData) : [];
  const verificationStatus = (
    needsCloseReadyFullVerificationAudit
    && !runEvidenceValidationError
  ) ? iterationVerificationStatus({
      runsDir: detail.runs.runsDir ?? path.join(artifactRoot, 'runs'),
      runs: activeRuns,
      artifactRoot,
      graphPath: gates.taskGraphPath,
      activeIteration: detail.activeIteration,
    }) : { needed: false, profile: null, error: null, scope: null };
  const fullVerificationNeeded = verificationStatus.needed;
  const visualReviewNeeded = (
    hasRequiredVisualContract
    && allTasksDone
    && detail.layout.kind === 'iteration'
  )
    ? iterationVisualReviewNeeded(activeRuns, {
        runsDir: detail.runs.runsDir,
        artifactRoot,
        graphPath: gates.taskGraphPath,
      })
    : false;
  const acceptanceReviewNeeded = (
    acceptanceReviewEnabled
    && !hasRequiredVisualContract
    && allTasksDone
    && detail.layout.kind === 'iteration'
  )
    ? iterationAcceptanceReviewNeeded(activeRuns, {
        runsDir: detail.runs.runsDir,
        artifactRoot,
        graphPath: gates.taskGraphPath,
      })
    : false;
  let constitution = (
    context.constitution.valid
    && context.constitution.data?.projectId !== detail.projectId
  )
    ? {
        ...context.constitution,
        valid: false,
        error: `constitution projectId ${JSON.stringify(context.constitution.data.projectId)} does not match selected project ${JSON.stringify(detail.projectId)}`,
    }
    : context.constitution;
  if (detail.currentDevelopmentRouting?.eligible) {
    constitution = {
      ...constitution,
      valid: true,
      approved: true,
      approvalSource: 'current_development_contract',
      approvalDecision: null,
    };
  } else if (constitution.valid && decisions.valid && constitution.exists) {
    const approval = constitutionApprovalState(
      decisions.records,
      rawFileSha256(constitution.path),
      constitution.approved,
      { allowLegacyFallback: !decisions.exists },
    );
    constitution = {
      ...constitution,
      approved: approval.approved,
      approvalSource: approval.source,
      approvalDecision: approval.event,
    };
  }
  const intakeScopeRef = gates.intakePath
    ? normalizePath(path.relative(artifactRoot, gates.intakePath))
    : null;
  const specScopeRef = gates.specPath
    ? normalizePath(path.relative(artifactRoot, gates.specPath))
    : null;
  const gateAApproval = detail.currentDevelopmentRouting?.eligible
    ? { approved: true, source: 'current_development_contract', event: null }
    : gates.intakePath && decisions.valid
    ? scopeApprovalState(
        decisions.records,
        intakeScopeRef,
        rawFileSha256(gates.intakePath),
        gates.intake?.status === 'ready_for_spec' && Boolean(gates.intake?.approval_audit),
        { allowLegacyFallback: !decisions.exists },
      )
    : { approved: false, source: 'approval_audit', event: null };
  const gateBApproval = detail.currentDevelopmentRouting?.eligible
    ? { approved: true, source: 'current_development_contract', event: null }
    : gates.specPath && decisions.valid
    ? scopeApprovalState(
        decisions.records,
        specScopeRef,
        rawFileSha256(gates.specPath),
        gates.spec?.approval === 'approved' && Boolean(gates.spec?.approval_audit),
        { allowLegacyFallback: !decisions.exists },
      )
    : { approved: false, source: 'approval_audit', event: null };
  const blockedTaskIds = taskIdsWithStatus(detail.tasks, 'blocked');
  const inProgressTaskIds = taskIdsWithStatus(detail.tasks, 'in_progress');
  const blockedUserDecisionRun = latestBlockedUserDecisionRun(activeRuns, blockedTaskIds);
  const retryableBlockedRun = latestRetryableBlockedRun(activeRuns, blockedTaskIds);
  return {
    ...context,
    constitution,
    decisions,
    artifactRoot,
    artifactArg,
    projectId: detail.projectId,
    entry,
    entryArg: entry ? commandProjectPath(targetRoot, entry.path) : null,
    hasCanonicalPlanningState: canonicalPlanningState,
    detail,
    gates,
    gateAExists: Boolean(gates.intakePath),
    gateAReadable: Boolean(gates.intake),
    gateAValid: gates.intakeValid === true,
    gateAValidationError: gates.intakeValidationError,
    gateAApproved: gateAApproval.approved,
    gateAApprovalSource: gateAApproval.source,
    gateAApprovalDecision: gateAApproval.event,
    currentSpecReadable: detail.currentSpecReadable,
    currentSpecValid: detail.currentSpecValid,
    currentSpecValidationError: detail.currentSpecValidationError,
    gateBExists: Boolean(gates.specPath),
    gateBReadable: Boolean(gates.spec),
    gateBValid: gates.specValid === true,
    gateBValidationError: gates.specValidationError,
    gateBApproved: gateBApproval.approved,
    gateBApprovalSource: gateBApproval.source,
    gateBApprovalDecision: gateBApproval.event,
    gateBPromoted: detail.layout.kind !== 'iteration' || detail.gateBPromotionValid,
    gateBPromotionValidationError: detail.gateBPromotionValidationError,
    gateAInvalidatesGateB: gateAInvalidatesGateB(gates),
    currentDevelopmentContractMissing: detail.currentDevelopmentRouting?.missing === true,
    currentDevelopmentContractInvalid: Boolean(
      detail.currentDevelopmentRouting
      && !detail.currentDevelopmentRouting.eligible
      && !detail.currentDevelopmentRouting.missing
    ),
    gateCExists: Boolean(gates.taskGraphPath),
    gateCReadable: Boolean(gates.taskGraph),
    gateCValid: gates.taskGraphValid === true,
    gateCValidationError: gates.taskGraphValidationError,
    activeRuns,
    startedRun,
    startedRunContractError,
    visualReviewNeeded,
    hasRequiredVisualContract,
    acceptanceReviewNeeded,
    acceptanceReviewActivated,
    acceptanceReviewApplicable,
    fullVerificationNeeded,
    verificationProfile: verificationStatus.profile,
    verificationReadinessError: verificationStatus.error,
    verificationScope: verificationStatus.scope,
    retrospectiveCandidates,
    readyIds: readyTaskIds(gates.taskGraph),
    blockedTaskIds,
    inProgressTaskIds,
    blockedUserDecisionRun,
    retryableBlockedRun,
    allTasksDone,
    closedIteration: isClosedIteration(detail.currentSpec, detail.activeIteration),
    iterationCompositionRequired: compositionRequirement.required,
    missingClosedCompositionIterations: compositionRequirement.missingClosedIterations,
    proposalQueueArg: commandProjectPath(
      targetRoot,
      resolveProjectRelativePath(
        targetRoot,
        proposals.enabled ? proposals.queueDir : '.plan2agent/proposals',
      ),
    ),
    runEvidenceValidationError,
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
    state: 'entry_invalid',
    kind: 'approval',
    when: (context) => (
      context.hasHarness
      && (
        !context.hasCanonicalPlanningState
        || activeIterationAwaitsGateA(context)
      )
      && context.entry
      && context.entry.valid === false
    ),
    reason: (context) => `The entry document did not validate: ${context.entryArg}`,
    command: (context) => (
      `Fix the document, then run ${p2aCommandLine(P2A_PATHS, ['validate', '--entry', context.entryArg])}.`
    ),
  },
  {
    state: 'gate_what',
    kind: 'skill',
    skill: 'p2a-harness',
    args: (context) => ['--entry', context.entryArg],
    when: (context) => (
      context.hasHarness
      && (
        !context.hasCanonicalPlanningState
        || activeIterationAwaitsGateA(context)
      )
      && context.entry?.valid === true
    ),
    reason: (context) => (
      `The entry document is ready for scope confirmation: ${context.entryArg}`
    ),
    command: (context) => `/p2a-harness --entry ${JSON.stringify(context.entryArg)}`,
  },
  {
    state: 'entry_missing',
    kind: 'approval',
    when: (context) => (
      context.hasHarness
      && (
        !context.info.artifacts.length
        || activeIterationAwaitsGateA(context)
      )
    ),
    reason: (context) => (
      activeIterationAwaitsGateA(context)
        ? `Active iteration ${context.detail.activeIteration} is ready for Gate A; provide a concise idea or entry document to begin scope confirmation.`
        : 'The harness is installed; provide a concise idea or entry document to begin scope confirmation.'
    ),
    command: () => 'Run p2a next --idea "<what to build>" or p2a next --entry <path>.',
  },
  {
    state: 'incomplete_iteration_layout',
    kind: 'cli',
    when: (context) => context.detail.layout.hasIncompleteIterationLayout,
    reason: () => 'current-spec.json and iterations/ do not form a complete iteration layout.',
    command: (context) => ['iteration', 'validate', '--artifacts', context.artifactArg],
  },
  {
    state: 'started_run_contract_drift',
    kind: 'approval',
    when: (context) => Boolean(
      context.startedRun
      && context.startedRunContractError
    ),
    reason: (context) => (
      `Run ${context.startedRun.runId} cannot resume because its recorded execution contract no longer matches the current development source: ${context.startedRunContractError}`
    ),
    command: (context) => (
      `Restore the recorded current contract/task graph for run ${context.startedRun.runId}, or close that run as failed/blocked with structured evidence before approving and starting replacement work.`
    ),
  },
  {
    state: 'current_development_contract_required',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => context.currentDevelopmentContractMissing === true,
    reason: () => (
      'The approved current task graph predates the current-development-first runtime and needs one deterministic contract migration.'
    ),
    command: (context) => [
      'iteration',
      'migrate-current-contract',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'invalid_current_development_contract',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => context.currentDevelopmentContractInvalid === true,
    reason: (context) => (
      `The current development contract or one of its current bindings is invalid: ${context.currentSpecValidationError ?? 'validation failed'}`
    ),
    command: (context) => [
      'iteration',
      'migrate-current-contract',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'invalid_iteration_state',
    kind: 'cli',
    when: (context) => (
      context.detail.layout.kind === 'iteration'
      && !context.currentSpecValid
    ),
    reason: (context) => (
      !context.currentSpecReadable
        ? 'The canonical current-spec.json is unreadable.'
        : `The canonical iteration state is invalid: ${context.currentSpecValidationError ?? 'validation failed'}`
    ),
    command: iterationStateValidationCommand,
  },
  {
    state: 'invalid_decisions',
    kind: 'cli',
    when: (context) => context.decisions?.exists && !context.decisions.valid,
    reason: (context) => `The decision ledger is invalid: ${context.decisions.error ?? 'validation failed'}`,
    command: (context) => [
      'validate',
      '--decisions',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'invalid_gate_a',
    kind: 'cli',
    when: (context) => (
      (context.gateAExists && !context.gateAValid)
      || (
        !context.gateAExists
        && (
          context.gateBExists
          || context.gateCExists
        )
      )
    ),
    reason: (context) => {
      if (!context.gateAExists) {
        return 'Downstream gate artifacts exist, but the canonical Gate A intake is missing.';
      }
      if (!context.gateAReadable) {
        return 'The canonical Gate A intake is unreadable.';
      }
      return `The canonical Gate A intake is invalid: ${context.gateAValidationError ?? 'validation failed'}`;
    },
    command: (context) => (
      context.detail.layout.kind === 'iteration'
        ? [
            'iteration',
            'validate',
            '--artifacts',
            context.artifactArg,
            '--allow-planning',
            '--stage',
            'gate-a',
          ]
        : ['validate', '--artifact-root', context.artifactArg]
    ),
  },
  {
    state: 'invalid_constitution',
    kind: 'cli',
    when: (context) => context.constitution.exists && !context.constitution.valid,
    reason: (context) => `The project constitution is invalid: ${context.constitution.error ?? 'validation failed'}`,
    command: (context) => [
      'validate',
      '--constitution',
      commandProjectPath(context.targetRoot, context.constitution.path),
    ],
  },
  {
    state: 'shape',
    kind: 'approval',
    when: (context) => (
      context.gateAValid
      && context.gateAApproved
      && context.constitution.exists
      && !context.constitution.approved
    ),
    reason: () => 'A material project constitution was created and still needs explicit quoted user approval.',
    command: (context) => (
      `Review ${commandProjectPath(context.targetRoot, context.constitution.path)}, then run p2a shape approve --quote "<user utterance>".`
    ),
    approvalArgv: (context) => [
      'shape',
      'approve',
      '--target',
      context.targetRoot,
      '--quote',
      '<user-utterance>',
    ],
    decisionSummary: constitutionDecisionSummary,
  },
  {
    state: (context) => gateAHasOpenQuestions(context.gates.intake)
      ? 'gate_what'
      : context.gateAApproved
        ? gateANextState(context.gates.intake)
        : 'gate_a_needs_approval',
    kind: (context) => gateAHasOpenQuestions(context.gates.intake)
      ? 'skill'
      : context.gateAApproved
        ? gateANextKind(context.gates.intake)
        : 'approval',
    skill: (context) => gateAHasOpenQuestions(context.gates.intake)
      ? 'p2a-harness'
      : 'p2a-spec',
    args: (context) => (
      gateAHasOpenQuestions(context.gates.intake) && context.entryArg
        ? ['--entry', context.entryArg]
        : []
    ),
    when: (context) => (
      context.gateAValid
      && (!context.gateAApproved || !context.gateBExists || context.gateAInvalidatesGateB)
    ),
    reason: (context) => (
      gateAHasOpenQuestions(context.gates.intake)
        ? 'Material scope questions remain unresolved; resume the scope conversation before requesting approval.'
        : !context.gateAApproved
        ? 'Gate ① scope is not approved by the decision ledger or legacy approval audit.'
        : context.gateAInvalidatesGateB
        ? 'Gate A is not confirmed for the existing Gate B specification, or its persisted bytes have changed; resume from Gate A before continuing downstream.'
        : gateANextReason(context.gates.intake)
    ),
    command: (context) => gateAHasOpenQuestions(context.gates.intake)
      ? context.entryArg
        ? `/p2a-harness --entry ${JSON.stringify(context.entryArg)}`
        : '/p2a-harness'
      : context.gateAApproved
      ? gateANextCommand(
          context.gates.intake,
          commandProjectPath(context.targetRoot, context.gates.intakePath),
        )
      : gateAApprovalCommand(context),
    approvalArgv: gateAApprovalArgv,
    decisionSummary: gateAScopeDecisionSummary,
  },
  {
    state: 'gate_b_needs_decisions',
    kind: 'skill',
    skill: 'p2a-spec',
    args: [],
    when: (context) => (
      context.gateBValid
      && !context.gateBApproved
      && Array.isArray(context.gates.spec?.open_decisions)
      && context.gates.spec.open_decisions.length > 0
    ),
    reason: () => 'The draft development plan still has material open decisions; resolve them before requesting approval.',
    command: () => '/p2a-spec',
  },
  {
    state: 'invalid_gate_b',
    kind: 'cli',
    when: (context) => context.gateBExists && !context.gateBValid,
    reason: (context) => (
      context.gateBReadable
        ? `The canonical Gate B specification is invalid: ${context.gateBValidationError ?? 'validation failed'}`
        : 'The canonical Gate B specification is unreadable.'
    ),
    command: (context) => (
      context.detail.layout.kind === 'iteration'
        ? [
            'iteration',
            'validate',
            '--artifacts',
            context.artifactArg,
            '--allow-planning',
            '--stage',
            context.gates.spec?.approval === 'approved'
              ? 'gate-b-approved'
              : 'gate-b-draft',
          ]
        : ['validate', '--artifact-root', context.artifactArg]
    ),
  },
  {
    state: 'gate_b_needs_approval',
    kind: 'approval',
    when: (context) => (
      context.gateBValid
      && !context.gateBApproved
      && Array.isArray(context.gates.spec?.open_decisions)
      && context.gates.spec.open_decisions.length === 0
    ),
    reason: () => 'The Gate ① specification decision is not approved or has been revoked.',
    command: (context) => `Review ${commandProjectPath(context.targetRoot, context.gates.specPath)}, then run p2a decide --quote "<user utterance>" --artifacts ${JSON.stringify(context.artifactArg)}.`,
    approvalArgv: (context) => [
      'decide',
      '--quote',
      '<user-utterance>',
      '--artifacts',
      context.artifactArg,
    ],
    decisionSummary: gateBDecisionSummary,
  },
  {
    state: 'gate_b_approved_needs_spec_promotion',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => (
      context.detail.layout.kind === 'iteration'
      && context.gateBValid
      && context.gateBApproved
      && !context.gateBPromoted
    ),
    reason: (context) => (
      'The approved Gate B artifact is intact, but its canonical current-spec.json promotion is still pending'
      + `${context.gateBPromotionValidationError ? `: ${context.gateBPromotionValidationError}` : '.'}`
    ),
    command: (context) => [
      'iteration',
      'promote-spec',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'gate_b_approved_needs_execution_prepare',
    kind: 'skill',
    skill: 'p2a-dev-execution',
    args: (context) => [
      '--artifacts',
      context.artifactArg,
      '--prepare-mode',
      context.executionModePolicy,
    ],
    continuation: continuationDescriptor('execution.prepare'),
    when: (context) => (
      context.gateBValid
      && context.gateBApproved
      && context.gateBPromoted
      && !context.gateCExists
      && context.executionModePolicy !== 'orchestrated'
    ),
    reason: (context) => (
      `The approved Gate B specification is ready for ${context.executionModePolicy} execution-mode preparation without another product approval.`
    ),
    command: (context) => (
      `/p2a-dev-execution --artifacts ${JSON.stringify(context.artifactArg)} --prepare-mode ${context.executionModePolicy}`
    ),
  },
  {
    state: 'gate_b_approved_needs_tasks',
    kind: 'skill',
    skill: 'p2a-task-breakdown',
    args: [],
    when: (context) => (
      context.gateBValid
      && context.gateBApproved
      && context.gateBPromoted
      && !context.gateCExists
      && context.executionModePolicy === 'orchestrated'
    ),
    reason: () => 'The approved Gate B specification has no Gate C task graph yet.',
    command: () => '/p2a-task-breakdown',
  },
  {
    state: 'invalid_gate_c',
    kind: 'cli',
    when: (context) => context.gateCExists && !context.gateCValid,
    reason: (context) => (
      context.gateCReadable
        ? `The canonical Gate C task graph is invalid: ${context.gateCValidationError ?? 'validation failed'}`
        : 'The canonical Gate C task graph is unreadable.'
    ),
    command: (context) => [
      'validate',
      '--task-graph',
      commandProjectPath(context.targetRoot, context.gates.taskGraphPath),
      '--require-approved-spec',
      commandProjectPath(context.targetRoot, context.gates.specPath),
    ],
  },
  {
    state: 'entry_invalid',
    kind: 'approval',
    when: (context) => (
      context.explicitEntryRequested
      && context.gateCValid
      && context.entry?.valid === false
    ),
    reason: (context) => `The new entry document did not validate: ${context.entryArg}`,
    command: (context) => (
      `Fix the document, then run ${p2aCommandLine(P2A_PATHS, ['validate', '--entry', context.entryArg])}. The current approved work remains unchanged.`
    ),
  },
  {
    state: 'blocked_scope_replacement_ready',
    kind: 'cli',
    requiresApproval: true,
    when: (context) => (
      context.explicitEntryRequested
      && context.entry?.valid === true
      && context.gateCValid
      && !entryMatchesCurrentScope(context)
      && Boolean(context.blockedUserDecisionRun)
      && !context.startedRun
      && context.inProgressTaskIds.length === 0
      && context.readyIds.length === 0
    ),
    reason: (context) => (
      `The bounded recovery for task ${context.blockedUserDecisionRun.taskId} was not selected. The supplied request can replace the blocked scope without closing that incomplete iteration or changing its run history.`
    ),
    command: (context) => [
      'iteration',
      'replace-scope',
      '--artifacts',
      context.artifactArg,
      '--idea',
      entryIdea(context.entry),
      '--reason',
      `User requested a replacement scope instead of bounded recovery for task ${context.blockedUserDecisionRun.taskId}.`,
    ],
  },
  {
    state: 'entry_deferred',
    kind: 'approval',
    when: (context) => (
      context.explicitEntryRequested
      && context.entry?.valid === true
      && context.gateCValid
      && !entryMatchesCurrentScope(context)
      && (
        Boolean(context.startedRun)
        || context.readyIds.length > 0
        || context.blockedTaskIds.length > 0
        || context.inProgressTaskIds.length > 0
        || (context.allTasksDone && !context.closedIteration)
        || context.detail.layout.requiresIterationInit
      )
    ),
    reason: (context) => (
      `The new request is saved at ${context.entryArg}, but the current approved development still has active work. It will not be started or replaced implicitly.`
    ),
    command: (context) => (
      `Continue the current approved work with ${p2aCommandLine(P2A_PATHS, ['next', '--target', commandTarget(context.targetRoot)])}, or leave it paused. After the current iteration closes, resume the saved request with ${p2aCommandLine(P2A_PATHS, ['next', '--target', commandTarget(context.targetRoot), '--entry', context.entryArg])}.`
    ),
    decisionSummary: deferredEntryDecisionSummary,
  },
  {
    state: 'gate_c_validated_needs_iteration_init',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => context.gateCValid && context.detail.layout.requiresIterationInit,
    reason: () => 'The task graph passed planning validation, but the iteration layout has not been initialized.',
    command: (context) => ['iteration', 'init', '--artifacts', context.artifactArg],
  },
  {
    state: 'invalid_run_evidence',
    kind: 'cli',
    when: (context) => Boolean(context.runEvidenceValidationError),
    reason: (context) => (
      `The run store is invalid and must be repaired before continuing: ${context.runEvidenceValidationError}`
    ),
    command: (context) => [
      'runs',
      'validate',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'run_started',
    kind: 'cli',
    requiresApproval: false,
    continuation: (context) => {
      const mode = runtimePacketModeForContext(context);
      if (!mode) return null;
      const runKind = context.startedRun?.runKind;
      if (runKind === 'final_verification') return null;
      if (runKind === 'final_visual_review') {
        return continuationDescriptor('execution.visual-review', mode);
      }
      if (runKind === 'final_acceptance_review') {
        return continuationDescriptor('execution.acceptance-review', mode);
      }
      return continuationDescriptor('execution.owner-start', mode);
    },
    when: (context) => Boolean(context.startedRun),
    reason: (context) => `Run ${context.startedRun.runId} is still open and should be resumed before starting new work.`,
    command: (context) => [
      'execute',
      'resume',
      ...taskSourceArgs(context),
      '--run-id',
      context.startedRun.runId,
    ],
  },
  {
    state: 'ready_task_available',
    kind: 'cli',
    requiresApproval: false,
    continuation: (context) => {
      const mode = runtimePacketModeForContext(context);
      return mode ? continuationDescriptor('execution.owner-start', mode) : null;
    },
    when: (context) => context.readyIds.length > 0,
    reason: (context) => `Work item ${context.readyIds[0]} is ready to start inside the approved Gate B execution envelope.`,
    command: (context) => [
      'execute',
      'start',
      ...taskSourceArgs(context),
      '--task',
      context.readyIds[0],
    ],
  },
  {
    state: 'tasks_blocked',
    kind: (context) => context.blockedUserDecisionRun ? 'approval' : 'cli',
    requiresApproval: false,
    when: (context) => context.blockedTaskIds.length > 0 && !context.readyIds.length,
    reason: (context) => context.blockedUserDecisionRun
      ? blockedUserDecisionReason(context.blockedUserDecisionRun)
      : context.retryableBlockedRun
        ? `Task ${context.retryableBlockedRun.taskId} is still marked blocked after retryable run ${context.retryableBlockedRun.runId}. Recover its already-recorded transition and retry without asking the user.`
      : `No task is ready and task ${context.blockedTaskIds[0]} is blocked.`,
    command: (context) => context.blockedUserDecisionRun
      ? 'Confirm the bounded recovery above, or reject it and request a replacement product scope.'
      : context.retryableBlockedRun
        ? [
            'execute',
            'finish',
            ...taskSourceArgs(context),
            '--run-id',
            context.retryableBlockedRun.runId,
          ]
      : [
          'tasks',
          'show',
          ...taskSourceArgs(context),
          context.blockedTaskIds[0],
        ],
    approvalArgv: (context) => context.blockedUserDecisionRun
      ? [
          'tasks',
          'todo',
          ...taskSourceArgs(context),
          context.blockedUserDecisionRun.taskId,
          '--note',
          '<user-utterance>',
        ]
      : null,
    decisionSummary: (context) => context.blockedUserDecisionRun
      ? blockedUserDecisionSummary(context.blockedUserDecisionRun)
      : null,
  },
  {
    state: 'final_visual_review_required',
    kind: 'cli',
    requiresApproval: false,
    continuation: (context) => {
      const mode = runtimePacketModeForContext(context);
      return mode ? continuationDescriptor('execution.visual-review', mode) : null;
    },
    when: (context) => (
      context.hasRequiredVisualContract
      && context.allTasksDone
      && !context.closedIteration
      && context.detail.layout.kind === 'iteration'
      && context.visualReviewNeeded
    ),
    reason: (context) => (
      'The completed visual iteration still needs one canonical pre-close review run.'
    ),
    command: (context) => [
      'execute',
      'review',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'final_acceptance_review_required',
    kind: 'cli',
    requiresApproval: false,
    continuation: (context) => {
      const mode = runtimePacketModeForContext(context);
      return mode ? continuationDescriptor('execution.acceptance-review', mode) : null;
    },
    when: (context) => (
      (
        (context.reviewPasses?.acceptance ?? 'opt_in') === 'on'
        || Boolean(context.acceptanceReviewActivated)
      )
      && context.allTasksDone
      && !context.closedIteration
      && context.detail.layout.kind === 'iteration'
      && context.acceptanceReviewNeeded
    ),
    reason: () => (
      'The completed non-UI iteration still needs one functional acceptance review backed by executed commands.'
    ),
    command: (context) => [
      'execute',
      'accept',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'relevant_verification_required',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => (
      context.allTasksDone
      && !context.closedIteration
      && context.detail.layout.kind === 'iteration'
      && context.fullVerificationNeeded
      && context.verificationScope === 'relevant'
    ),
    reason: (context) => (
      context.verificationProfile?.id === 'docs_metadata'
        ? 'Only documentation or metadata changed, so product-wide verification is not required; the current workspace still needs one related check before close.'
        : 'Product verification is still current; only the docs/metadata changes need a related check before close.'
    ),
    command: (context) => [
      'execute',
      'verify-final',
      '--scope',
      'relevant',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: 'final_verification_required',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => (
      context.allTasksDone
      && !context.closedIteration
      && context.detail.layout.kind === 'iteration'
      && context.fullVerificationNeeded
      && context.verificationScope !== 'relevant'
    ),
    reason: (context) => {
      const profile = context.verificationProfile?.id;
      if (profile === 'isolated_code') {
        return 'The isolated code change has no reusable full verification bound to the current product revision.';
      }
      return 'This high-risk or integrated change needs one canonical final full verification before close.';
    },
    command: (context) => [
      'execute',
      'verify-final',
      '--artifacts',
      context.artifactArg,
    ],
  },
  {
    state: (context) => (
      context.detail.layout.kind === 'iteration'
        ? 'iteration_review_or_close_required'
        : 'flat_execution_complete'
    ),
    kind: 'approval',
    when: (context) => (
      context.allTasksDone
      && !context.closedIteration
    ),
    reason: (context) => (
      context.detail.layout.kind === 'iteration'
        ? context.retrospectiveCandidates.length
          ? `Every task in the active iteration is done and the iteration is still open. ${context.retrospectiveCandidates.length} bounded retrospective candidate(s) were found. The user must explicitly choose product review, P2A retrospective, or close.`
          : 'Every task is done, current verification evidence is fresh, and no automatic retrospective signal was found. Closing the iteration is recommended; review remains optional.'
        : 'Every task in the handed-off flat artifact bundle is done; this layout has no iteration state to close.'
    ),
    command: (context) => (
      context.detail.layout.kind === 'iteration'
        ? 'Choose product review, P2A retrospective, or close the completed iteration.'
        : `Review the completed task and run evidence under ${context.artifactArg}; no iteration close is required for this flat handoff.`
    ),
    options: (context) => (
      context.detail.layout.kind === 'iteration'
        ? completionOptions(context)
        : null
    ),
  },
  {
    state: 'iteration_composition_required',
    kind: 'cli',
    requiresApproval: false,
    when: (context) => (
      context.allTasksDone
      && context.closedIteration
      && context.iterationCompositionRequired
    ),
    reason: (context) => (
      context.missingClosedCompositionIterations.length
        ? `The closed iteration baseline is incomplete; compose missing iterations ${JSON.stringify(context.missingClosedCompositionIterations)} before opening the next iteration.`
        : 'Multiple iterations are closed, but current-spec.json has not been composed into the effective baseline.'
    ),
    command: (context) => ['iteration', 'compose', '--artifacts', context.artifactArg],
  },
  {
    state: 'iteration_complete',
    kind: 'cli',
    when: (context) => (
      context.allTasksDone
      && context.closedIteration
      && !context.iterationCompositionRequired
    ),
    reason: (context) => (
      context.explicitEntryRequested
      || context.pendingProvisionalEntry
    )
      ? 'The active iteration is closed and the supplied request is ready to open as the next iteration.'
      : 'The active iteration is closed; start the next iteration when a new change idea is ready.',
    command: (context) => [
      'iteration',
      'open',
      '--artifacts',
      context.artifactArg,
      '--iteration-id',
      '<id>',
      '--idea',
      nextIterationIdea(context),
    ],
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
  const continuationValue = resolveNextRuleValue(rule.continuation ?? null, context);
  const continuation = continuationValue
    ? { ...continuationValue, sourceState: state }
    : null;
  if (kind === 'cli') {
    return cliNextAction(
      state,
      reason,
      command,
      resolveNextRuleValue(rule.requiresApproval ?? null, context),
      continuation,
    );
  }
  if (kind === 'skill') {
    return skillNextAction(
      state,
      reason,
      command,
      resolveNextRuleValue(rule.skill, context),
      resolveNextRuleValue(rule.args ?? [], context),
      continuation,
    );
  }
  return approvalNextAction(
    state,
    reason,
    command,
    {
      options: resolveNextRuleValue(rule.options ?? null, context),
      argv: resolveNextRuleValue(rule.approvalArgv ?? null, context),
      decisionSummary: resolveNextRuleValue(rule.decisionSummary ?? null, context),
    },
  );
}

function conversationalIterationOpenCommand(command) {
  const argv = [...command.argv];
  const iterationIdIndex = argv.indexOf('--iteration-id');
  if (iterationIdIndex >= 0 && argv[iterationIdIndex + 1] === '<id>') {
    argv.splice(iterationIdIndex, 2);
  }
  return {
    ...command,
    argv,
    display: p2aCommandLine(P2A_PATHS, argv),
  };
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

function resolveNextDecision(
  targetRootInput,
  requestedProjectId,
  entryPath,
  contract,
  options = {},
) {
  const snapshot = buildInfoSnapshot(targetRootInput, { entryPath, ...options });
  const { info } = snapshot;
  const targetRoot = info.target;
  const context = buildNextDecisionContext(
    info,
    targetRoot,
    requestedProjectId,
    snapshot.inspectedArtifacts,
    snapshot.reviewPasses,
    snapshot.executionModePolicy,
    snapshot.retrospectivePolicy,
    snapshot.nextEntry,
    snapshot.validationSession,
  );
  const action = decideNextAction(context);
  const command = contract === 'v1'
    ? action.command.kind === 'skill'
      ? { kind: 'skill', display: action.command.display }
      : action.command.kind === 'approval'
        ? { kind: 'approval', display: action.command.display }
        : action.command
    : action.state === 'iteration_complete' && action.command.kind === 'cli'
      ? conversationalIterationOpenCommand(action.command)
      : action.command.kind === 'cli' && action.continuation?.activation === 'after_command_success'
      ? {
          ...action.command,
          argv: action.command.argv.includes('--json')
            ? action.command.argv
            : [...action.command.argv, '--json'],
          display: p2aCommandLine(
            P2A_PATHS,
            action.command.argv.includes('--json')
              ? action.command.argv
              : [...action.command.argv, '--json'],
          ),
        }
      : action.command;
  const payload = {
    schema_version: contract === 'v2' ? 'p2a.next.v2' : 'p2a.next.v1',
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    projectId: context.projectId ?? null,
    state: action.state,
    reason: action.reason,
    command,
  };
  if (contract === 'v2') {
    payload.reasonCode = action.state;
    payload.continuation = action.continuation ?? null;
    if (action.state === 'iteration_review_or_close_required') {
      payload.retrospective = {
        enabled: context.retrospectivePolicy.enabled,
        candidateCount: context.retrospectiveCandidates.length,
        candidates: context.retrospectiveCandidates,
      };
    }
  }
  return { context, payload };
}

export function buildNext(
  targetRootInput,
  requestedProjectId,
  entryPath,
  contract = 'v1',
  options = {},
) {
  return resolveNextDecision(
    targetRootInput,
    requestedProjectId,
    entryPath,
    contract,
    options,
  ).payload;
}

function nextActionContractSources(context) {
  const currentDevelopment = context.detail?.currentDevelopmentRouting?.eligible
    ? context.detail.currentDevelopmentRouting.state
    : null;
  const candidates = [
    path.join(context.targetRoot, '.plan2agent', 'manifest.json'),
    path.join(context.targetRoot, '.plan2agent', 'project.config.json'),
    path.join(context.targetRoot, '.plan2agent', 'constitution.json'),
    currentDevelopment?.currentDevelopmentContractPath ?? null,
    !currentDevelopment && context.artifactRoot
      ? path.join(context.artifactRoot, 'decisions.jsonl')
      : null,
    !currentDevelopment && context.artifactRoot
      ? path.join(context.artifactRoot, 'current-spec.json')
      : null,
    context.entry?.path ?? null,
    !currentDevelopment ? context.gates?.intakePath ?? null : null,
    !currentDevelopment ? context.gates?.specPath ?? null : null,
    context.gates?.taskGraphPath ?? null,
  ];
  return [...new Set(candidates.filter(Boolean).map((filePath) => path.resolve(filePath)))]
    .filter(isFile)
    .map((filePath) => ({
      ref: normalizePath(path.relative(context.targetRoot, filePath)),
      sha256: rawFileSha256(filePath),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

export function buildNextActionContract(
  targetRootInput,
  requestedProjectId,
  entryPath,
  contract = 'v2',
) {
  const resolved = resolveNextDecision(targetRootInput, requestedProjectId, entryPath, contract);
  return {
    next: resolved.payload,
    sources: nextActionContractSources(resolved.context),
  };
}

function buildInfoSnapshot(targetRootInput, options = {}) {
  const targetRoot = path.resolve(targetRootInput);
  if (!isDirectory(targetRoot)) {
    throw new Error(`--target must be an existing directory: ${targetRoot}`);
  }
  const manifest = readManifest(targetRoot);
  const config = readJsonObject(path.join(targetRoot, '.plan2agent', 'project.config.json'));
  const reviewPasses = resolveReviewPasses(config);
  const executionModePolicy = resolveExecutionModePolicy(config);
  const retrospectivePolicy = resolveRetrospectiveSignals(config);
  const isScaffoldProject = ['init', 'scaffold'].includes(manifest?.provenance?.mode);
  const validationSession = options.validationSession ?? createValidationSession();
  const inspectedArtifacts = discoverArtifactRoots(targetRoot)
    .map((artifactRoot) => inspectArtifact(
      targetRoot,
      artifactRoot,
      isScaffoldProject,
      { trace: options.trace, validationSession, reviewPasses },
    ));
  const explicitEntry = options.entryPath
    ? discoverEntryDocument(targetRoot, {
        entryPath: options.entryPath,
        baseDir: targetRoot,
      })
    : null;
  const provisionalEntry = !explicitEntry
    ? discoverRelevantProvisionalEntry(targetRoot, inspectedArtifacts)
    : null;
  const autoEntries = inspectedArtifacts
    .map((artifact) => artifact.entry)
    .filter(Boolean);
  const selectedEntry = explicitEntry
    ?? provisionalEntry
    ?? (autoEntries.length === 1 ? autoEntries[0] : null);
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
  if (selectedEntry) {
    const entryArg = relativeToTarget(targetRoot, selectedEntry.path);
    if (selectedEntry.valid) {
      nextActions.push(`Validate the entry document: ${p2aCommand(['validate', '--entry', entryArg])}`);
      nextActions.push(`Confirm the entry scope: /p2a-harness --entry ${JSON.stringify(entryArg)}`);
    } else {
      nextActions.push(`Repair the entry document: ${selectedEntry.errors.join('; ')}`);
    }
  } else if (hasP2aDir && !artifacts.length) {
    nextActions.push('Run p2a next --idea "<what to build>" or provide a Markdown/text document with p2a next --entry <path>.');
  }
  for (const artifact of artifacts) {
    if (artifact.layout.hasIncompleteIterationLayout) {
      nextActions.push(`Repair incomplete iteration layout before task execution: ${artifact.artifactRoot}`);
    } else if (artifact.layout.requiresIterationInit) {
      nextActions.push(`Initialize iteration layout: ${p2aCommand(['iteration', 'init', '--artifacts', artifact.artifactRoot, '--iteration-id', 'v1-mvp'])}`);
    } else if (artifact.readyTaskIds.length) {
      nextActions.push(`Plan the next ready task: ${p2aCommand(['execute', 'plan', '--artifacts', artifact.artifactRoot, '--task', artifact.readyTaskIds[0]])}`);
    } else if (artifact.taskCounts.total > 0 && artifact.taskCounts.done === artifact.taskCounts.total) {
      if (artifact.layout.kind === 'iteration') {
        nextActions.push(`Validate close readiness: ${p2aCommand(['iteration', 'validate', '--artifacts', artifact.artifactRoot, '--require-close-ready'])}`);
      } else {
        nextActions.push(`Review completed flat handoff evidence under ${artifact.artifactRoot}; no iteration close is required.`);
      }
    }
  }
  if (enhancements.buildlore.enabled) {
    if (!enhancements.buildlore.inSync) {
      nextActions.push(`Repair BuildLore capability manifest/config drift: ${p2aCommand(['enhance', 'buildlore'])}`);
    } else if (artifacts.length) {
      nextActions.push(`Preview BuildLore projection: ${p2aCommand(['buildlore', 'sync', '--project', artifacts[0].projectId, '--dry-run'])}`);
      nextActions.push(`Search committed BuildLore knowledge: ${p2aCommand(['buildlore', 'search', '--project', artifacts[0].projectId, '--mode', enhancements.buildlore.retrievalMode, '--query', '<term>'])}`);
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
    ...(selectedEntry ? { entry: summarizeEntry(targetRoot, selectedEntry) } : {}),
    enhancements,
    artifactCount: artifacts.length,
    artifacts,
    nextActions,
  };
  return {
    info,
    inspectedArtifacts,
    reviewPasses,
    executionModePolicy,
    retrospectivePolicy,
    explicitEntry,
    nextEntry: explicitEntry ?? provisionalEntry,
    validationSession,
  };
}

export function buildInfo(targetRootInput, options = {}) {
  return buildInfoSnapshot(targetRootInput, options).info;
}
