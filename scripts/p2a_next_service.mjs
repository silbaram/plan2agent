/** Next-state discovery and decision service, independent from CLI dispatch. */


import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_RUNS_DIR, GATE_FILES, GREENFIELD_REQUIRED_FILES } from './p2a_constants.mjs';
import { resolveExecutionModePolicy, resolveOrchestrationAgentTool, resolveReviewPasses } from './p2a_project_config.mjs';
import { normalizePath, resolveP2aPaths } from './p2a_paths.mjs';
import { p2aCommandLine } from './p2a_run_commands.mjs';
import {
  auditArchivedIterationArtifacts,
  iterationCompositionRequirement,
  resolveIterationState,
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
import { minedProposalRunIds } from './p2a_proposal_mining.mjs';
import {
  discoverEntryDocument,
  discoverFeatureRadarPreflightRuns,
} from './p2a_radar_preflight.mjs';
import {
  approvedVisualReviewContract,
  createValidationSession,
  validateConstitution,
  validateIntake,
  validateRunIndexData,
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

function cliNextAction(state, reason, argv, requiresApproval = true, continuation = null) {
  return {
    state,
    reason,
    continuation,
    command: {
      kind: 'cli',
      argv,
      display: p2aCommandLine(P2A_PATHS, argv),
      requiresApproval,
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

function approvalNextAction(state, reason, display, options = null) {
  const command = {
    kind: 'approval',
    display,
  };
  if (Array.isArray(options) && options.length) command.options = options;
  return {
    state,
    reason,
    continuation: null,
    command,
  };
}

function reviewOrCloseOptions(context) {
  const remediationArgv = [
    'tasks',
    'todo',
    '--artifacts',
    context.artifactArg,
    '<task-id>',
    '--reopen',
    '--note',
    '<review finding>',
  ];
  const closeArgv = ['iteration', 'close', '--artifacts', context.artifactArg];
  return [
    {
      id: 'review',
      label: 'Review and remediate',
      description: 'Keep the active iteration open, review the completed implementation, and reopen the owning completed task when a finding requires code changes.',
      action: {
        kind: 'review',
        display: 'Review the completed implementation while keeping the active iteration open. A clean review returns to this same decision without closing the iteration.',
        remediation: {
          kind: 'cli',
          argv: remediationArgv,
          display: p2aCommandLine(P2A_PATHS, remediationArgv),
          requiresApproval: false,
        },
      },
    },
    {
      id: 'close',
      label: 'Close iteration',
      description: 'Archive the completed active iteration without running another optional review, or after explicitly ending the review loop.',
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
    entry: explicitEntry,
    entryArg: explicitEntry ? commandProjectPath(targetRoot, explicitEntry.path) : null,
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
  const decisions = inspectDecisions(artifactRoot);
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
        'The active iteration is closed; start the next iteration when a new change idea is ready.',
        [
          'iteration',
          'open',
          '--artifacts',
          artifactArg,
          '--iteration-id',
          '<id>',
          '--idea',
          '<change idea>',
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
  const compositionRequirement = iterationCompositionRequirement(detail.currentSpec);
  const hasRequiredVisualContract = Boolean(
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
  const acceptanceReviewEnabled = reviewPasses.acceptance === 'on' || acceptanceReviewActivated;
  const needsCloseReadyVisualAudit = (
    hasRequiredVisualContract
    && allTasksDone
    && detail.layout.kind === 'iteration'
  );
  const needsCloseReadyAcceptanceAudit = (
    acceptanceReviewEnabled
    && allTasksDone
    && detail.layout.kind === 'iteration'
    && !hasRequiredVisualContract
  );
  const proposals = info.enhancements.proposals;
  const minedRunIds = proposals.enabled
    ? minedProposalRunIds(targetRoot, proposals)
    : null;
  const failedOrBlockedRunCandidate = proposals.enabled
    ? activeRuns.find((run) => {
        const runId = stringValue(run.runId);
        return Boolean(runId)
          && ['failed', 'blocked'].includes(run.status)
          && !minedRunIds.has(runId);
      })
    : null;
  let runEvidenceValidationError = null;
  if (
    detail.runs.runsDir
    && (failedOrBlockedRunCandidate || needsCloseReadyVisualAudit || needsCloseReadyAcceptanceAudit)
  ) {
    try {
      validateRunsDir(detail.runs.runsDir, { validationSession });
    } catch (error) {
      runEvidenceValidationError = error instanceof Error
        ? error.message
        : String(error);
    }
  }
  const unminedFailedOrBlockedRun = runEvidenceValidationError
    ? null
    : failedOrBlockedRunCandidate;
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
  if (constitution.valid && decisions.valid && constitution.exists) {
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
  const gateAApproval = gates.intakePath && decisions.valid
    ? scopeApprovalState(
        decisions.records,
        intakeScopeRef,
        rawFileSha256(gates.intakePath),
        gates.intake?.status === 'ready_for_spec' && Boolean(gates.intake?.approval_audit),
        { allowLegacyFallback: !decisions.exists },
      )
    : { approved: false, source: 'approval_audit', event: null };
  const gateBApproval = gates.specPath && decisions.valid
    ? scopeApprovalState(
        decisions.records,
        specScopeRef,
        rawFileSha256(gates.specPath),
        gates.spec?.approval === 'approved' && Boolean(gates.spec?.approval_audit),
        { allowLegacyFallback: !decisions.exists },
      )
    : { approved: false, source: 'approval_audit', event: null };
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
    readyIds: readyTaskIds(gates.taskGraph),
    blockedTaskIds: taskIdsWithStatus(detail.tasks, 'blocked'),
    allTasksDone,
    closedIteration: isClosedIteration(detail.currentSpec, detail.activeIteration),
    iterationCompositionRequired: compositionRequirement.required,
    missingClosedCompositionIterations: compositionRequirement.missingClosedIterations,
    proposalQueueArg: proposals.enabled
      ? commandProjectPath(targetRoot, resolveProjectRelativePath(targetRoot, proposals.queueDir))
      : null,
    runEvidenceValidationError,
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
        ? `Active iteration ${context.detail.activeIteration} is ready for Gate A, but a concise entry document is required before planning can begin.`
        : 'The harness is installed, but a concise entry document is required before planning can begin.'
    ),
    command: () => 'Create or choose an entry document, then run p2a next --entry <path>.',
  },
  {
    state: 'incomplete_iteration_layout',
    kind: 'cli',
    when: (context) => context.detail.layout.hasIncompleteIterationLayout,
    reason: () => 'current-spec.json and iterations/ do not form a complete iteration layout.',
    command: (context) => ['iteration', 'validate', '--artifacts', context.artifactArg],
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
    kind: (context) => context.constitution.exists ? 'approval' : 'skill',
    skill: 'p2a-harness',
    args: ['--stage', 'gate-shape'],
    when: (context) => (
      context.gateAValid
      && context.gateAApproved
      && !context.constitution.approved
      && (
        context.constitution.exists
        || (!context.gateBExists && !context.constitution.legacyStyleExists)
      )
    ),
    reason: (context) => (
      context.constitution.exists
        ? 'The Gate ② project constitution is valid but still needs an explicit quoted user approval.'
        : 'Gate A scope is approved, but the project has no Gate ② constitution yet.'
    ),
    command: (context) => (
      context.constitution.exists
        ? `Review ${commandProjectPath(context.targetRoot, context.constitution.path)}, then run p2a shape approve --quote "<user utterance>".`
        : '/p2a-harness (Gate ②: propose architecture, stack, prohibitions, and style)'
    ),
  },
  {
    state: (context) => context.gateAApproved
      ? gateANextState(context.gates.intake)
      : 'gate_a_needs_approval',
    kind: (context) => context.gateAApproved
      ? gateANextKind(context.gates.intake)
      : 'approval',
    skill: 'p2a-spec',
    args: [],
    when: (context) => (
      context.gateAValid
      && (!context.gateAApproved || !context.gateBExists || context.gateAInvalidatesGateB)
    ),
    reason: (context) => (
      !context.gateAApproved
        ? 'Gate ① scope is not approved by the decision ledger or legacy approval audit.'
        : context.gateAInvalidatesGateB
        ? 'Gate A is not confirmed for the existing Gate B specification, or its persisted bytes have changed; resume from Gate A before continuing downstream.'
        : gateANextReason(context.gates.intake)
    ),
    command: (context) => context.gateAApproved
      ? gateANextCommand(
          context.gates.intake,
          commandProjectPath(context.targetRoot, context.gates.intakePath),
        )
      : gateAApprovalCommand(context),
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
    state: 'started_run_contract_drift',
    kind: 'approval',
    when: (context) => Boolean(
      context.startedRun
      && context.startedRunContractError
      && (!context.gateCExists || context.gateCValid),
    ),
    reason: (context) => (
      `Run ${context.startedRun.runId} cannot resume because its recorded execution contract no longer matches the current Gate B/Gate C source: ${context.startedRunContractError}`
    ),
    command: (context) => (
      `Restore the recorded Gate B/Gate C source for run ${context.startedRun.runId}, or close that run as failed/blocked with structured evidence before approving and starting replacement work.`
    ),
  },
  {
    state: 'gate_b_needs_approval',
    kind: 'approval',
    when: (context) => (
      context.gateBValid
      && !context.gateBApproved
    ),
    reason: () => 'The Gate ① specification decision is not approved or has been revoked.',
    command: (context) => `Review ${commandProjectPath(context.targetRoot, context.gates.specPath)}, then run p2a decide --quote "<user utterance>" --artifacts ${JSON.stringify(context.artifactArg)}.`,
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
    kind: 'cli',
    requiresApproval: false,
    when: (context) => context.blockedTaskIds.length > 0 && !context.readyIds.length,
    reason: (context) => `No task is ready and task ${context.blockedTaskIds[0]} is blocked.`,
    command: (context) => [
      'tasks',
      'show',
      ...taskSourceArgs(context),
      context.blockedTaskIds[0],
    ],
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
    state: (context) => (
      context.detail.layout.kind === 'iteration'
        ? 'iteration_review_or_close_required'
        : 'flat_execution_complete'
    ),
    kind: 'approval',
    when: (context) => (
      context.allTasksDone
      && !context.closedIteration
      && (
        context.detail.layout.kind === 'iteration'
        || !context.unminedFailedOrBlockedRun
      )
    ),
    reason: (context) => (
      context.detail.layout.kind === 'iteration'
        ? 'Every task in the active iteration is done and the iteration is still open. The user must explicitly choose review and remediation or close. A clean review keeps the iteration open and returns to this decision; only the close choice authorizes iteration close.'
        : 'Every task in the handed-off flat artifact bundle is done; this layout has no iteration state to close.'
    ),
    command: (context) => (
      context.detail.layout.kind === 'iteration'
        ? 'Choose review and remediation to keep the active iteration open, or choose close to archive it.'
        : `Review the completed task and run evidence under ${context.artifactArg}; no iteration close is required for this flat handoff.`
    ),
    options: (context) => (
      context.detail.layout.kind === 'iteration'
        ? reviewOrCloseOptions(context)
        : null
    ),
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
    state: 'iteration_composition_required',
    kind: 'cli',
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
  const continuationValue = resolveNextRuleValue(rule.continuation ?? null, context);
  const continuation = continuationValue
    ? { ...continuationValue, sourceState: state }
    : null;
  if (kind === 'cli') {
    return cliNextAction(
      state,
      reason,
      command,
      resolveNextRuleValue(rule.requiresApproval ?? true, context),
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
    resolveNextRuleValue(rule.options ?? null, context),
  );
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
    snapshot.explicitEntry,
    snapshot.validationSession,
  );
  const action = decideNextAction(context);
  const command = contract === 'v1'
    ? action.command.kind === 'skill'
      ? { kind: 'skill', display: action.command.display }
      : action.command.kind === 'approval'
        ? { kind: 'approval', display: action.command.display }
        : action.command
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
  const candidates = [
    path.join(context.targetRoot, '.plan2agent', 'manifest.json'),
    path.join(context.targetRoot, '.plan2agent', 'project.config.json'),
    path.join(context.targetRoot, '.plan2agent', 'constitution.json'),
    context.artifactRoot ? path.join(context.artifactRoot, 'decisions.jsonl') : null,
    context.artifactRoot ? path.join(context.artifactRoot, 'current-spec.json') : null,
    context.entry?.path ?? null,
    context.gates?.intakePath ?? null,
    context.gates?.specPath ?? null,
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
  const autoEntries = inspectedArtifacts
    .map((artifact) => artifact.entry)
    .filter(Boolean);
  const selectedEntry = explicitEntry ?? (autoEntries.length === 1 ? autoEntries[0] : null);
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
    nextActions.push('Provide a Markdown or text idea document, then run p2a next --entry <path>.');
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
    explicitEntry,
    validationSession,
  };
}

export function buildInfo(targetRootInput, options = {}) {
  return buildInfoSnapshot(targetRootInput, options).info;
}
