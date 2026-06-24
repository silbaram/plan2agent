/** Read-only Plan2Agent project detection and summary model for the GUI shell. */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  loadJson,
  validateReview,
  validateRunData,
  validateRunIndexData,
  validateSpec,
  validateTaskGraphData,
} from '../../../scripts/validate_artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../../..');
const REQUIRED_HARNESS_FILES = [
  '.plan2agent/manifest.json',
  '.plan2agent/project.config.json',
  'scripts/p2a_tasks.mjs',
  'scripts/p2a_runs.mjs',
  'scripts/p2a_execute.mjs',
  'scripts/p2a_orchestrate.mjs',
  'scripts/p2a_proposals.mjs',
  'scripts/p2a_run_paths.mjs',
  'scripts/p2a_iteration_state.mjs',
  'scripts/validate_artifacts.mjs',
  'schemas/task-graph.schema.json',
  'schemas/run.schema.json',
  'schemas/run-index.schema.json',
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath, root = process.cwd()) {
  if (!filePath) return null;
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return normalizePath(filePath);
}

function fileExists(filePath) {
  return existsSync(filePath) && lstatSync(filePath).isFile();
}

function dirExists(dirPath) {
  return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
}

function sortedChildDirs(dirPath) {
  if (!dirExists(dirPath)) return [];
  return readdirSync(dirPath)
    .map((entry) => path.join(dirPath, entry))
    .filter((entryPath) => dirExists(entryPath))
    .sort((left, right) => left.localeCompare(right));
}

function readJson(filePath, diagnostics, label) {
  try {
    if (!fileExists(filePath)) return null;
    return loadJson(filePath);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'json_read_failed',
      message: `${label} could not be read: ${error.message}`,
      path: filePath,
    });
    return null;
  }
}

function diagnosticForMissing(filePath, projectRoot) {
  return {
    severity: 'error',
    code: 'missing_harness_file',
    message: `Required P2A harness file is missing: ${normalizePath(filePath)}`,
    path: path.join(projectRoot, filePath),
  };
}

function taskMap(graph) {
  return new Map((graph?.tasks ?? []).map((task) => [task.id, task]));
}

function isTaskReady(task, tasksById) {
  return task.status === 'todo' && task.dependencies.every((dependency) => tasksById.get(dependency)?.status === 'done');
}

function summarizeTasks(graph) {
  const tasks = graph?.tasks ?? [];
  const byStatus = { todo: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const tasksById = taskMap(graph);
  const ready = tasks
    .filter((task) => isTaskReady(task, tasksById))
    .map((task) => ({
      id: task.id,
      title: task.title,
      targetArea: task.targetArea,
      dependencies: task.dependencies,
      acceptanceCriteriaCount: task.acceptanceCriteria.length,
    }));
  return {
    total: tasks.length,
    byStatus,
    ready,
  };
}

function summarizeRuns(runsDir, diagnostics) {
  const indexPath = path.join(runsDir, 'run-index.json');
  if (!fileExists(indexPath)) {
    return {
      runsDir,
      indexPath,
      total: 0,
      byStatus: { started: 0, finished: 0, failed: 0, blocked: 0 },
      latestRun: null,
    };
  }
  let index = null;
  try {
    index = validateRunIndexData(loadJson(indexPath));
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'run_index_invalid',
      message: `run-index.json is invalid: ${error.message}`,
      path: indexPath,
    });
    return {
      runsDir,
      indexPath,
      total: 0,
      byStatus: { started: 0, finished: 0, failed: 0, blocked: 0 },
      latestRun: null,
    };
  }

  const byStatus = { started: 0, finished: 0, failed: 0, blocked: 0 };
  let latestRun = null;
  for (const runRef of index.runs) {
    byStatus[runRef.status] = (byStatus[runRef.status] ?? 0) + 1;
    latestRun = runRef;
    if (runRef.runRef !== `${runRef.runId}.json`) {
      diagnostics.push({
        severity: 'error',
        code: 'run_ref_invalid',
        message: `run-index ${runRef.runId}.runRef must be ${runRef.runId}.json`,
        path: indexPath,
      });
      continue;
    }
    const runPath = path.join(runsDir, `${runRef.runId}.json`);
    try {
      validateRunData(loadJson(runPath));
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'run_log_invalid',
        message: `run log ${runRef.runRef} is invalid: ${error.message}`,
        path: runPath,
      });
    }
  }
  return {
    runsDir,
    indexPath,
    total: index.runs.length,
    byStatus,
    latestRun,
  };
}

function flatArtifactSource(projectRoot, artifactRoot) {
  return {
    sourceLayout: 'handoff',
    artifactRoot,
    activeIteration: null,
    intakePath: path.join(artifactRoot, 'intake.json'),
    statusPath: path.join(artifactRoot, 'status.md'),
    currentSpecPath: path.join(projectRoot, '.plan2agent', 'current-spec.json'),
    specPath: path.join(artifactRoot, 'spec.json'),
    taskGraphPath: path.join(artifactRoot, 'task-graph.json'),
    reviewPath: path.join(artifactRoot, 'review.json'),
  };
}

function directArtifactSource(projectRoot, artifactRoot = projectRoot, sourceLayout = 'artifact_root') {
  return {
    sourceLayout,
    artifactRoot,
    activeIteration: null,
    intakePath: path.join(artifactRoot, 'gate-a-intake', 'intake.json'),
    statusPath: path.join(artifactRoot, 'status.md'),
    currentSpecPath: path.join(artifactRoot, 'current-spec.json'),
    specPath: path.join(artifactRoot, 'gate-b-spec', 'spec.json'),
    taskGraphPath: path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'),
    reviewPath: path.join(artifactRoot, 'gate-d-review', 'review.json'),
  };
}

function iterativeArtifactSource(projectRoot, artifactRoot, diagnostics, sourceLayout = 'iteration') {
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const currentSpec = readJson(currentSpecPath, diagnostics, 'current-spec.json');
  const activeIteration = currentSpec?.active_iteration ?? null;
  const iterationRoot = activeIteration ? path.join(artifactRoot, 'iterations', activeIteration) : null;
  return {
    sourceLayout,
    artifactRoot,
    activeIteration,
    intakePath: iterationRoot ? path.join(iterationRoot, 'gate-a-intake', 'intake.json') : null,
    statusPath: path.join(artifactRoot, 'status.md'),
    currentSpecPath,
    specPath: iterationRoot ? path.join(iterationRoot, 'gate-b-spec', 'spec.json') : null,
    taskGraphPath: iterationRoot ? path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json') : null,
    reviewPath: iterationRoot ? path.join(iterationRoot, 'gate-d-review', 'review.json') : null,
  };
}

function isArtifactRoot(artifactRoot) {
  return fileExists(path.join(artifactRoot, 'status.md'))
    && (
      dirExists(path.join(artifactRoot, 'gate-b-spec'))
      || dirExists(path.join(artifactRoot, 'iterations'))
    );
}

function artifactSourceFromRoot(projectRoot, artifactRoot, diagnostics, sourceLayout = 'artifact_root') {
  if (fileExists(path.join(artifactRoot, 'current-spec.json')) && dirExists(path.join(artifactRoot, 'iterations'))) {
    return iterativeArtifactSource(
      projectRoot,
      artifactRoot,
      diagnostics,
      sourceLayout === 'co_located' ? 'co_located_iteration' : 'iteration',
    );
  }
  return directArtifactSource(projectRoot, artifactRoot, sourceLayout);
}

function resolveCoLocatedArtifactSource(projectRoot, diagnostics, projectHint = null) {
  const artifactsRoot = path.join(projectRoot, 'artifacts');
  if (!dirExists(artifactsRoot)) return null;

  if (projectHint) {
    const hintedRoot = path.join(artifactsRoot, projectHint);
    if (isArtifactRoot(hintedRoot)) return artifactSourceFromRoot(projectRoot, hintedRoot, diagnostics, 'co_located');
  }

  const candidates = sortedChildDirs(artifactsRoot).filter(isArtifactRoot);
  if (!candidates.length) return null;
  if (candidates.length > 1) {
    diagnostics.push({
      severity: 'warning',
      code: 'multiple_artifact_roots',
      message: `Multiple artifacts/<project_id> roots were found; using ${path.basename(candidates[0])}`,
      path: artifactsRoot,
    });
  }
  return artifactSourceFromRoot(projectRoot, candidates[0], diagnostics, 'co_located');
}

function resolveArtifactSource(projectRoot, diagnostics, projectHint = null) {
  const packagedArtifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts');
  if (dirExists(packagedArtifactRoot)) {
    if (fileExists(path.join(packagedArtifactRoot, 'current-spec.json')) && dirExists(path.join(packagedArtifactRoot, 'iterations'))) {
      return iterativeArtifactSource(projectRoot, packagedArtifactRoot, diagnostics);
    }
    return flatArtifactSource(projectRoot, packagedArtifactRoot);
  }
  if (isArtifactRoot(projectRoot)) {
    return artifactSourceFromRoot(projectRoot, projectRoot, diagnostics);
  }
  return resolveCoLocatedArtifactSource(projectRoot, diagnostics, projectHint);
}

function readTaskGraph(taskGraphPath, diagnostics) {
  if (!taskGraphPath || !fileExists(taskGraphPath)) return null;
  try {
    return validateTaskGraphData(loadJson(taskGraphPath));
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'task_graph_invalid',
      message: `task graph is invalid: ${error.message}`,
      path: taskGraphPath,
    });
    return null;
  }
}

function readSpecSummary(specPath, intakePath, diagnostics) {
  if (!specPath || !fileExists(specPath)) return null;
  let spec = null;
  try {
    spec = validateSpec(specPath, intakePath && fileExists(intakePath) ? intakePath : null);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'spec_invalid',
      message: `spec.json is invalid: ${error.message}`,
      path: specPath,
    });
    return null;
  }
  return {
    projectId: spec.project_id ?? null,
    approval: spec.approval ?? null,
    openDecisionCount: Array.isArray(spec.open_decisions) ? spec.open_decisions.length : null,
    goalCount: Array.isArray(spec.product?.goals) ? spec.product.goals.length : null,
    verificationCount: Array.isArray(spec.implementation?.verification) ? spec.implementation.verification.length : null,
  };
}

function readReviewSummary(reviewPath, diagnostics) {
  if (!reviewPath || !fileExists(reviewPath)) return null;
  try {
    const review = validateReview(reviewPath);
    return {
      projectId: review.projectId ?? null,
      blockingIssueCount: Array.isArray(review.blocking_issues) ? review.blocking_issues.length : null,
      nonBlockingRiskCount: Array.isArray(review.non_blocking_risks) ? review.non_blocking_risks.length : null,
      missingTestsOrAcceptanceCriteriaCount: Array.isArray(review.missing_tests_or_acceptance_criteria)
        ? review.missing_tests_or_acceptance_criteria.length
        : null,
    };
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'review_invalid',
      message: `review.json is invalid: ${error.message}`,
      path: reviewPath,
    });
    return null;
  }
}

function gateSummary(source) {
  return {
    gateA: {
      label: 'Gate A',
      status: source.intakePath && fileExists(source.intakePath) ? 'present' : 'missing',
    },
    gateB: {
      label: 'Gate B',
      status: source.specPath && fileExists(source.specPath) ? 'present' : 'missing',
    },
    gateC: {
      label: 'Gate C',
      status: source.taskGraphPath && fileExists(source.taskGraphPath) ? 'present' : 'missing',
    },
    gateD: {
      label: 'Gate D',
      status: source.reviewPath && fileExists(source.reviewPath) ? 'present' : 'missing',
    },
  };
}

function runsDirFor(projectRoot, artifactRoot) {
  const projectRunsDir = path.join(projectRoot, '.plan2agent', 'runs');
  if (dirExists(path.join(projectRoot, '.plan2agent'))) return projectRunsDir;
  return path.join(artifactRoot, 'runs');
}

function commandPreview(scriptName, args) {
  return ['node', `scripts/${scriptName}`, ...args].map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(String(value))) return String(value);
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function guidanceCommands(projectRoot, artifactRoot, projectId) {
  return {
    setup: commandPreview('p2a_handoff.mjs', ['scaffold', '--target', projectRoot, '--tools', 'all']),
    import: commandPreview('p2a_handoff.mjs', ['--project-id', projectId ?? '<project-id>', '--artifacts', '<artifact-root>', '--target', projectRoot, '--tools', 'all']),
    validate: artifactRoot
      ? commandPreview('validate_artifacts.mjs', ['--artifact-root', artifactRoot, '--require-review-pass'])
      : commandPreview('validate_artifacts.mjs', ['--artifact-root', '<artifact-root>', '--require-review-pass']),
  };
}

function determineState({ hasP2AMarker, artifactSource, missingHarnessFiles, taskSummary, runSummary, diagnostics }) {
  if (!hasP2AMarker && !artifactSource) return 'no_p2a';
  if (hasP2AMarker && missingHarnessFiles.length) return 'broken_install';
  if (diagnostics.some((item) => item.severity === 'error')) return 'broken_install';
  if (!artifactSource) return 'installed_empty';
  if (taskSummary.ready.length || runSummary.total > 0) return 'execution_ready';
  return 'planning_in_progress';
}

function summarizeState(state) {
  const labels = {
    no_p2a: 'No P2A',
    installed_empty: 'Installed empty',
    planning_in_progress: 'Planning in progress',
    execution_ready: 'Execution ready',
    broken_install: 'Broken install',
  };
  return labels[state] ?? state;
}

export function inspectProject(projectPath, options = {}) {
  const projectRoot = path.resolve(options.cwd ?? process.cwd(), projectPath);
  const diagnostics = [];
  if (!dirExists(projectRoot)) {
    const runsDir = path.join(projectRoot, '.plan2agent', 'runs');
    diagnostics.push({
      severity: 'error',
      code: 'project_missing',
      message: `Project directory does not exist: ${projectRoot}`,
      path: projectRoot,
    });
    return {
      schema_version: 'p2a.gui_project.v1',
      projectRoot,
      projectId: path.basename(projectRoot),
      state: 'broken_install',
      stateLabel: summarizeState('broken_install'),
      defaultAgentTool: 'codex',
      manifest: null,
      harness: {
        installed: false,
        missingFiles: [],
      },
      artifactSource: null,
      gates: null,
      spec: null,
      review: null,
      tasks: summarizeTasks(null),
      runs: summarizeRuns(runsDir, diagnostics),
      commands: guidanceCommands(projectRoot, null, path.basename(projectRoot)),
      diagnostics,
      displayPaths: {
        projectRoot: displayPath(projectRoot, ROOT),
        artifactRoot: null,
        runsDir: displayPath(runsDir, ROOT),
      },
    };
  }

  const manifestPath = path.join(projectRoot, '.plan2agent', 'manifest.json');
  const projectConfigPath = path.join(projectRoot, '.plan2agent', 'project.config.json');
  const manifest = readJson(manifestPath, diagnostics, 'manifest.json');
  const projectConfig = readJson(projectConfigPath, diagnostics, 'project.config.json');
  const hasP2AMarker = Boolean(
    manifest
    || fileExists(path.join(projectRoot, 'PLAN2AGENT.md'))
    || dirExists(path.join(projectRoot, '.plan2agent'))
    || fileExists(path.join(projectRoot, 'scripts', 'p2a_tasks.mjs'))
  );
  const missingHarnessFiles = hasP2AMarker
    ? REQUIRED_HARNESS_FILES.filter((filePath) => !fileExists(path.join(projectRoot, filePath)))
    : [];
  diagnostics.push(...missingHarnessFiles.map((filePath) => diagnosticForMissing(filePath, projectRoot)));

  const artifactSource = resolveArtifactSource(projectRoot, diagnostics, manifest?.projectId ?? null);
  const taskGraph = artifactSource ? readTaskGraph(artifactSource.taskGraphPath, diagnostics) : null;
  const taskSummary = summarizeTasks(taskGraph);
  const runsDir = artifactSource ? runsDirFor(projectRoot, artifactSource.artifactRoot) : path.join(projectRoot, '.plan2agent', 'runs');
  const runSummary = summarizeRuns(runsDir, diagnostics);
  const specSummary = artifactSource ? readSpecSummary(artifactSource.specPath, artifactSource.intakePath, diagnostics) : null;
  const reviewSummary = artifactSource ? readReviewSummary(artifactSource.reviewPath, diagnostics) : null;
  const projectId = manifest?.projectId ?? specSummary?.projectId ?? taskGraph?.projectId ?? manifest?.targetProject ?? path.basename(projectRoot);
  const state = determineState({
    hasP2AMarker,
    artifactSource,
    missingHarnessFiles,
    taskSummary,
    runSummary,
    diagnostics,
  });

  return {
    schema_version: 'p2a.gui_project.v1',
    projectRoot,
    projectId,
    state,
    stateLabel: summarizeState(state),
    defaultAgentTool: projectConfig?.defaultAgentTool ?? 'codex',
    manifest: manifest
      ? {
          schemaVersion: manifest.schema_version ?? null,
          sourceLayout: manifest.sourceLayout ?? manifest.provenance?.mode ?? null,
          aiToolTargets: manifest.aiToolTargets ?? [],
          createdAt: manifest.createdAt ?? null,
        }
      : null,
    harness: {
      installed: hasP2AMarker && !missingHarnessFiles.length,
      missingFiles: missingHarnessFiles,
    },
    artifactSource: artifactSource
      ? {
          sourceLayout: artifactSource.sourceLayout,
          artifactRoot: artifactSource.artifactRoot,
          activeIteration: artifactSource.activeIteration,
          intakePath: artifactSource.intakePath,
          statusPath: artifactSource.statusPath,
          currentSpecPath: artifactSource.currentSpecPath,
          specPath: artifactSource.specPath,
          taskGraphPath: artifactSource.taskGraphPath,
          reviewPath: artifactSource.reviewPath,
        }
      : null,
    gates: artifactSource ? gateSummary(artifactSource) : null,
    spec: specSummary,
    review: reviewSummary,
    tasks: taskSummary,
    runs: runSummary,
    commands: guidanceCommands(projectRoot, artifactSource?.artifactRoot ?? null, projectId),
    diagnostics,
    displayPaths: {
      projectRoot: displayPath(projectRoot, ROOT),
      artifactRoot: artifactSource ? displayPath(artifactSource.artifactRoot, ROOT) : null,
      runsDir: displayPath(runsDir, ROOT),
    },
  };
}

export function formatProjectInspection(inspection) {
  const lines = [
    'Plan2Agent GUI project inspection',
    `- project: ${inspection.displayPaths?.projectRoot ?? displayPath(inspection.projectRoot, ROOT)}`,
    `- state: ${inspection.stateLabel ?? inspection.state}`,
  ];
  if (inspection.projectId) lines.push(`- projectId: ${inspection.projectId}`);
  if (inspection.artifactSource) {
    lines.push(`- source: ${inspection.artifactSource.sourceLayout}`);
    if (inspection.artifactSource.activeIteration) lines.push(`- activeIteration: ${inspection.artifactSource.activeIteration}`);
    lines.push(`- artifactRoot: ${inspection.displayPaths.artifactRoot}`);
  }
  if (inspection.tasks) {
    lines.push(`- tasks: ${inspection.tasks.total} total, ${inspection.tasks.ready.length} ready`);
  }
  if (inspection.runs) {
    lines.push(`- runs: ${inspection.runs.total} total`);
    if (inspection.runs.latestRun) lines.push(`- latestRun: ${inspection.runs.latestRun.runId} (${inspection.runs.latestRun.status})`);
  }
  if (inspection.diagnostics?.length) {
    lines.push('Diagnostics:');
    for (const item of inspection.diagnostics) {
      lines.push(`- ${item.severity}: ${item.code}: ${item.message}`);
    }
  }
  return lines.join('\n');
}
