#!/usr/bin/env node
/** Deterministic Plan2Agent run grading, regression compare, and failure analysis. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  loadJson,
  validateRunData,
  validateRunIndexData,
  validateSkillProposal,
  validateTaskGraph,
} from './validate_artifacts.mjs';
import { resolveRunsDir } from './p2a_run_paths.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  relativeToProject,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const COMMANDS = new Set(['grade', 'compare', 'analyze']);
const DEFAULT_PROPOSALS_DIR = path.join('.plan2agent', 'proposals');
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'or',
  'the',
  'to',
  'with',
  'without',
]);

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_eval.mjs grade (--artifacts <dir>|--graph <path>) (--run-id <id>|--run <path>) [--output <path>] [--dry-run] [--json]',
    '  node .plan2agent/scripts/p2a_eval.mjs compare --baseline <artifacts-or-runs-dir> --candidate <artifacts-or-runs-dir> [--output <path>] [--dry-run] [--json]',
    '  node .plan2agent/scripts/p2a_eval.mjs analyze (--artifacts <dir>|--graph <path>|--runs <dir>) [--proposals <dir>] [--output <path>] [--dry-run] [--json]',
    '',
    'Commands:',
    '  grade     Evaluate one run against its task acceptance criteria and verification evidence.',
    '  compare   Compare two local iteration/run snapshots for regression signals.',
    '  analyze   Cluster failed runs, verification gaps, and proposal coverage into follow-up candidates.',
    '',
    'Source options:',
    '  --artifacts <dir>   Iterative artifact root.',
    '  --graph <path>      Task graph JSON path.',
    '  --runs <dir>        Explicit runs directory. Supported by analyze only.',
    '  --run-id <id>       Run id to grade. Reads the matching runs directory.',
    '  --run <path>        Explicit run JSON path to grade.',
    '  --baseline <path>   Baseline artifact root or runs directory for compare.',
    '  --candidate <path>  Candidate artifact root or runs directory for compare.',
    '  --proposals <dir>   Proposal queue directory for analyze.',
    '  --output <path>     Optional JSON output path. Writes unless --dry-run is set.',
    '  --dry-run           Print output plan/result without writing --output.',
    '  --json              Machine-readable stdout.',
    '  --help, -h          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);

  const args = {
    command,
    artifacts: null,
    graph: null,
    runs: null,
    run: null,
    runId: null,
    baseline: null,
    candidate: null,
    proposals: null,
    output: null,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--runs') args.runs = requiredValue(argv, ++index, '--runs');
    else if (arg === '--run') args.run = requiredValue(argv, ++index, '--run');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--baseline') args.baseline = requiredValue(argv, ++index, '--baseline');
    else if (arg === '--candidate') args.candidate = requiredValue(argv, ++index, '--candidate');
    else if (arg === '--proposals') args.proposals = requiredValue(argv, ++index, '--proposals');
    else if (arg === '--output') args.output = requiredValue(argv, ++index, '--output');
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  validateArgs(args);
  return args;
}

function validateArgs(args) {
  if (args.command === 'grade') {
    if (args.runs) throw new Error('grade uses --artifacts or --graph with --run-id, or --run with --graph');
    const sourceCount = [args.artifacts, args.graph].filter(Boolean).length;
    if (sourceCount === 0) {
      const defaultArtifacts = singleArtifactProjectRoot();
      const configuredGraph = configuredTaskGraphPath();
      if (defaultArtifacts) args.artifacts = defaultArtifacts;
      else if (configuredGraph) args.graph = configuredGraph;
      else assertNoUninitializedScaffoldArtifactRoots();
    }
    if ([args.artifacts, args.graph].filter(Boolean).length !== 1) throw new Error('grade requires exactly one of --artifacts or --graph');
    if ([args.run, args.runId].filter(Boolean).length !== 1) throw new Error('grade requires exactly one of --run or --run-id');
    if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
    return;
  }
  if (args.command === 'compare') {
    if (!args.baseline || !args.candidate) throw new Error('compare requires --baseline and --candidate');
    if (args.artifacts || args.graph || args.runs || args.run || args.runId || args.proposals) {
      throw new Error('compare only supports --baseline, --candidate, --output, --dry-run, and --json');
    }
    return;
  }
  if (args.command === 'analyze') {
    const sourceCount = [args.artifacts, args.graph, args.runs].filter(Boolean).length;
    if (sourceCount === 0) {
      const defaultArtifacts = singleArtifactProjectRoot();
      const configuredGraph = configuredTaskGraphPath();
      if (defaultArtifacts) args.artifacts = defaultArtifacts;
      else if (configuredGraph) args.graph = configuredGraph;
      else if (existsSync(path.join('.plan2agent', 'runs'))) args.runs = path.join('.plan2agent', 'runs');
      else assertNoUninitializedScaffoldArtifactRoots();
    }
    if ([args.artifacts, args.graph, args.runs].filter(Boolean).length !== 1) {
      throw new Error('analyze requires exactly one of --artifacts, --graph, or --runs');
    }
    if (args.run || args.runId || args.baseline || args.candidate) throw new Error('analyze does not support run/compare options');
    if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  }
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function fileExists(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function displayPath(filePath) {
  return relativeToProject(P2A_PATHS.projectRoot, filePath);
}

function stableHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 12);
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function loadGraphSource(args) {
  if (args.artifacts) {
    const state = resolveIterationState(args.artifacts, { requireReady: false });
    if (!fileExists(state.taskGraphPath)) throw new Error(`task graph is missing: ${state.taskGraphPath}`);
    return {
      sourceKind: 'artifacts',
      sourcePath: state.artifactRoot,
      projectId: state.projectId,
      iterationId: state.activeIteration,
      graphPath: state.taskGraphPath,
      graph: validateTaskGraph(state.taskGraphPath),
      runsDir: resolveRunsDir({ artifacts: state.artifactRoot }),
      proposalsDir: path.join(state.artifactRoot, 'proposals'),
    };
  }
  const graphPath = path.resolve(args.graph);
  const graph = validateTaskGraph(graphPath);
  return {
    sourceKind: 'graph',
    sourcePath: graphPath,
    projectId: graph.projectId,
    iterationId: graph.version,
    graphPath,
    graph,
    runsDir: resolveRunsDir({ graph: graphPath }),
    proposalsDir: path.join(path.dirname(resolveRunsDir({ graph: graphPath })), 'proposals'),
  };
}

function loadAnalyzeSource(args) {
  if (args.artifacts || args.graph) return loadGraphSource(args);
  const runsDir = path.resolve(args.runs);
  const runs = readRuns(runsDir);
  return {
    sourceKind: 'runs',
    sourcePath: runsDir,
    projectId: runs.runs[0]?.projectId ?? path.basename(P2A_PATHS.projectRoot),
    iterationId: runs.runs[0]?.iterationId ?? 'runs',
    graphPath: null,
    graph: null,
    runsDir,
    proposalsDir: path.join(path.dirname(runsDir), 'proposals'),
  };
}

function runFilePath(runsDir, runId) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runId ?? '')) throw new Error(`run id must match run-[A-Za-z0-9._-]+, got ${JSON.stringify(runId)}`);
  return path.join(runsDir, `${runId}.json`);
}

function loadRunForGrade(source, args) {
  const filePath = args.run ? path.resolve(args.run) : runFilePath(source.runsDir, args.runId);
  if (!fileExists(filePath)) throw new Error(`run file is missing: ${filePath}`);
  const run = validateRunData(loadJson(filePath));
  return { run, filePath, raw: readFileSync(filePath, 'utf8') };
}

function readRuns(runsDir) {
  if (!directoryExists(runsDir)) return { runs: [], skippedRuns: [] };
  const indexPath = path.join(runsDir, 'run-index.json');
  if (!fileExists(indexPath)) return { runs: [], skippedRuns: [] };
  const index = validateRunIndexData(loadJson(indexPath));
  const runs = [];
  const skippedRuns = [];
  for (const entry of index.runs) {
    const filePath = runFilePath(runsDir, entry.runId);
    try {
      if (!fileExists(filePath)) throw new Error(`run file is missing: ${filePath}`);
      runs.push(validateRunData(loadJson(filePath)));
    } catch (error) {
      skippedRuns.push({ runId: entry.runId, reason: errorMessage(error) });
    }
  }
  return { runs, skippedRuns };
}

function taskForRun(graph, run) {
  return graph.tasks.find((task) => task.id === run.taskId) ?? null;
}

function tokenSet(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function evidenceText(run) {
  return [
    run.taskTitle,
    ...(run.notes ?? []),
    ...(run.changedFiles ?? []),
    ...(run.verification ?? []).flatMap((item) => [
      item.type,
      item.command,
      item.status,
      item.stdoutTail,
      item.stderrTail,
    ]),
  ].filter(Boolean).join('\n');
}

function criterionCoverage(criterion, run) {
  const criterionTokens = [...tokenSet(criterion)];
  const evidenceTokens = tokenSet(evidenceText(run));
  const matched = criterionTokens.filter((token) => evidenceTokens.has(token));
  const required = Math.min(2, criterionTokens.length);
  const covered = criterionTokens.length === 0 ? false : matched.length >= required;
  return {
    criterion,
    covered,
    matchedTokens: matched,
    missingTokens: criterionTokens.filter((token) => !evidenceTokens.has(token)).slice(0, 10),
  };
}

function gradeVerdict(run, coverage) {
  if (run.status === 'failed' || run.status === 'blocked') return 'fail';
  if (run.verification.some((item) => item.status === 'failed')) return 'fail';
  if (run.status !== 'finished') return 'needs_evidence';
  if (run.verification.length === 0) return 'needs_evidence';
  if (coverage.length && coverage.every((item) => item.covered)) return 'pass';
  if (coverage.some((item) => item.covered)) return 'partial';
  return 'needs_evidence';
}

function gradeReasons(run, coverage, verdict) {
  const reasons = [];
  if (run.status !== 'finished') reasons.push(`run status is ${run.status}`);
  if (run.verification.length === 0) reasons.push('no verification evidence recorded');
  const failedChecks = run.verification.filter((item) => item.status === 'failed');
  if (failedChecks.length) reasons.push(`${failedChecks.length} verification check(s) failed`);
  const uncovered = coverage.filter((item) => !item.covered);
  if (uncovered.length) reasons.push(`${uncovered.length} acceptance criterion/criteria lack direct local evidence`);
  if (!reasons.length && verdict === 'pass') reasons.push('run finished, verification passed, and acceptance criteria have local evidence');
  return reasons;
}

function buildGrade(source, runInfo) {
  const task = taskForRun(source.graph, runInfo.run);
  if (!task) throw new Error(`task ${runInfo.run.taskId} is not present in ${source.graphPath}`);
  const coverage = task.acceptanceCriteria.map((criterion) => criterionCoverage(criterion, runInfo.run));
  const verdict = gradeVerdict(runInfo.run, coverage);
  return {
    schema_version: 'p2a.eval_grade.v1',
    gradeId: `eval-grade-${stableHash({ runId: runInfo.run.runId, taskId: runInfo.run.taskId, status: runInfo.run.status, coverage })}`,
    generatedAt: new Date().toISOString(),
    source: {
      sourceKind: source.sourceKind,
      sourcePath: displayPath(source.sourcePath),
      graphPath: displayPath(source.graphPath),
      runPath: displayPath(runInfo.filePath),
    },
    projectId: runInfo.run.projectId,
    iterationId: runInfo.run.iterationId,
    task: {
      taskId: task.id,
      title: task.title,
      targetArea: task.targetArea,
      acceptanceCriteria: task.acceptanceCriteria,
    },
    run: {
      runId: runInfo.run.runId,
      status: runInfo.run.status,
      agentTool: runInfo.run.agentTool,
      changedFiles: runInfo.run.changedFiles,
      verification: runInfo.run.verification.map((item) => ({
        type: item.type,
        command: item.command,
        status: item.status,
        exitCode: item.exitCode,
      })),
      failure: runInfo.run.failure ?? null,
    },
    verdict,
    score: gradeScore(verdict, coverage),
    acceptanceCoverage: coverage,
    reasons: gradeReasons(runInfo.run, coverage, verdict),
    nextActions: gradeNextActions(verdict, source, runInfo.run),
  };
}

function gradeScore(verdict, coverage) {
  const base = { pass: 1, partial: 0.6, needs_evidence: 0.3, fail: 0 }[verdict] ?? 0;
  if (!coverage.length) return base;
  const coverageRatio = coverage.filter((item) => item.covered).length / coverage.length;
  return Number(((base + coverageRatio) / 2).toFixed(3));
}

function gradeNextActions(verdict, source, run) {
  if (verdict === 'pass') return ['No immediate eval follow-up required.'];
  const actions = [
    `Inspect run evidence: node .plan2agent/scripts/p2a_runs.mjs show --runs ${displayPath(source.runsDir)} --run-id ${run.runId}`,
  ];
  if (run.status === 'failed' || run.status === 'blocked' || verdict === 'needs_evidence') {
    actions.push(`Mine proposal candidates: node .plan2agent/scripts/p2a_proposals.mjs mine --runs ${displayPath(source.runsDir)} --run-id ${run.runId}`);
  }
  return actions;
}

function writeOutputIfRequested(args, payload) {
  if (!args.output || args.dryRun) return { wrote: false, filePath: args.output ? path.resolve(args.output) : null };
  const filePath = path.resolve(args.output);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { wrote: true, filePath };
}

function printGrade(payload, writeResult) {
  console.log('Plan2Agent eval grade');
  console.log(`- grade: ${payload.verdict} score=${payload.score}`);
  console.log(`- run: ${payload.run.runId} status=${payload.run.status}`);
  console.log(`- task: ${payload.task.taskId} ${payload.task.title}`);
  console.log(`- acceptance: ${payload.acceptanceCoverage.filter((item) => item.covered).length}/${payload.acceptanceCoverage.length} covered`);
  payload.reasons.forEach((reason) => console.log(`- reason: ${reason}`));
  if (writeResult.wrote) console.log(`- output: ${displayPath(writeResult.filePath)}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function sourceSummary(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!directoryExists(resolved)) throw new Error(`compare source must be a directory: ${sourcePath}`);
  if (fileExists(path.join(resolved, 'current-spec.json')) && directoryExists(path.join(resolved, 'iterations'))) {
    const state = resolveIterationState(resolved, { requireReady: false });
    const graph = fileExists(state.taskGraphPath) ? validateTaskGraph(state.taskGraphPath) : null;
    const runsDir = resolveRunsDir({ artifacts: state.artifactRoot });
    const runs = readRuns(runsDir);
    return summarizeSource({
      sourceKind: 'artifacts',
      sourcePath: state.artifactRoot,
      projectId: state.projectId,
      iterationId: state.activeIteration,
      graph,
      runsDir,
      runs,
    });
  }
  const runs = readRuns(resolved);
  return summarizeSource({
    sourceKind: 'runs',
    sourcePath: resolved,
    projectId: runs.runs[0]?.projectId ?? path.basename(P2A_PATHS.projectRoot),
    iterationId: runs.runs[0]?.iterationId ?? 'runs',
    graph: null,
    runsDir: resolved,
    runs,
  });
}

function summarizeSource(source) {
  const taskStatus = {};
  for (const task of source.graph?.tasks ?? []) taskStatus[task.status] = (taskStatus[task.status] ?? 0) + 1;
  const runStatus = {};
  const failureClasses = {};
  let verificationFailures = 0;
  let verificationGaps = 0;
  for (const run of source.runs.runs) {
    runStatus[run.status] = (runStatus[run.status] ?? 0) + 1;
    if (run.failure?.class) failureClasses[run.failure.class] = (failureClasses[run.failure.class] ?? 0) + 1;
    if (run.verification.some((item) => item.status === 'failed')) verificationFailures += 1;
    if (run.status === 'finished' && run.verification.length === 0) verificationGaps += 1;
  }
  return {
    sourceKind: source.sourceKind,
    sourcePath: displayPath(source.sourcePath),
    projectId: source.projectId,
    iterationId: source.iterationId,
    runsDir: displayPath(source.runsDir),
    tasks: {
      total: source.graph?.tasks?.length ?? 0,
      byStatus: taskStatus,
    },
    runs: {
      total: source.runs.runs.length,
      byStatus: runStatus,
      failureClasses,
      verificationFailures,
      verificationGaps,
      skippedRuns: source.runs.skippedRuns.length,
    },
  };
}

function buildCompare(args) {
  const baseline = sourceSummary(args.baseline);
  const candidate = sourceSummary(args.candidate);
  const signals = compareSignals(baseline, candidate);
  const verdict = signals.some((signal) => signal.severity === 'fail')
    ? 'fail'
    : signals.some((signal) => signal.severity === 'warn')
      ? 'warn'
      : 'pass';
  return {
    schema_version: 'p2a.eval_compare.v1',
    compareId: `eval-compare-${stableHash({ baseline, candidate, signals })}`,
    generatedAt: new Date().toISOString(),
    baseline,
    candidate,
    verdict,
    signals,
    nextActions: compareNextActions(verdict, candidate),
  };
}

function count(summary, area, key) {
  return summary[area]?.[key] ?? 0;
}

function compareSignals(baseline, candidate) {
  const signals = [];
  const baselineFailed = (baseline.runs.byStatus.failed ?? 0) + (baseline.runs.byStatus.blocked ?? 0);
  const candidateFailed = (candidate.runs.byStatus.failed ?? 0) + (candidate.runs.byStatus.blocked ?? 0);
  if (candidateFailed > baselineFailed) {
    signals.push({ severity: 'fail', metric: 'failed_or_blocked_runs', baseline: baselineFailed, candidate: candidateFailed });
  }
  if (candidate.runs.verificationFailures > baseline.runs.verificationFailures) {
    signals.push({ severity: 'fail', metric: 'verification_failures', baseline: baseline.runs.verificationFailures, candidate: candidate.runs.verificationFailures });
  }
  if (candidate.runs.verificationGaps > baseline.runs.verificationGaps) {
    signals.push({ severity: 'warn', metric: 'verification_gaps', baseline: baseline.runs.verificationGaps, candidate: candidate.runs.verificationGaps });
  }
  if (count(candidate, 'tasks', 'total') && (candidate.tasks.byStatus.done ?? 0) < (baseline.tasks.byStatus.done ?? 0)) {
    signals.push({ severity: 'warn', metric: 'done_tasks', baseline: baseline.tasks.byStatus.done ?? 0, candidate: candidate.tasks.byStatus.done ?? 0 });
  }
  if (candidate.runs.skippedRuns > 0) {
    signals.push({ severity: 'warn', metric: 'skipped_runs', baseline: baseline.runs.skippedRuns, candidate: candidate.runs.skippedRuns });
  }
  if (!signals.length) signals.push({ severity: 'pass', metric: 'regression_checks', baseline: 'no worse', candidate: 'no worse' });
  return signals;
}

function compareNextActions(verdict, candidate) {
  if (verdict === 'pass') return ['No regression follow-up required by local eval compare.'];
  return [
    `Analyze candidate failures: node .plan2agent/scripts/p2a_eval.mjs analyze --runs ${candidate.runsDir}`,
    'If the issue changes product/implementation scope, open a delta iteration with p2a_iteration open/draft.',
    'If the issue is harness or execution hygiene, add or approve a maintenance task before retrying.',
  ];
}

function printCompare(payload, writeResult) {
  console.log('Plan2Agent eval compare');
  console.log(`- verdict: ${payload.verdict}`);
  console.log(`- baseline: ${payload.baseline.sourcePath}`);
  console.log(`- candidate: ${payload.candidate.sourcePath}`);
  payload.signals.forEach((signal) => console.log(`- ${signal.severity}: ${signal.metric} baseline=${signal.baseline} candidate=${signal.candidate}`));
  if (writeResult.wrote) console.log(`- output: ${displayPath(writeResult.filePath)}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function proposalFiles(proposalsDir) {
  if (!directoryExists(proposalsDir)) return [];
  return readdirSync(proposalsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(proposalsDir, entry));
}

function readProposals(proposalsDir) {
  const proposals = [];
  const skippedProposals = [];
  for (const filePath of proposalFiles(proposalsDir)) {
    try {
      proposals.push(validateSkillProposal(filePath));
    } catch (error) {
      skippedProposals.push({ filePath: displayPath(filePath), reason: errorMessage(error) });
    }
  }
  return { proposals, skippedProposals };
}

function clusterKeyForRun(run) {
  if (run.failure?.class) return run.failure.class;
  if (run.status === 'finished' && run.verification.length === 0) return 'verification_gap';
  if (run.verification.some((item) => item.status === 'failed')) return 'verification_failed';
  return null;
}

function clusterRecommendation(key) {
  const recommendations = {
    verification_failed: 'Tighten verification setup, acceptance evidence, or test command guidance before retrying.',
    verification_gap: 'Require explicit verification or owner-approved skipped-verification rationale before closing similar runs.',
    test_flake: 'Record retry policy and flaky-test evidence before treating future failures as implementation issues.',
    scope_violation: 'Open a delta iteration or tighten implementer scope before applying more changes.',
    missing_dependency: 'Capture missing dependency decisions in Gate A/B or add a maintenance task for setup docs.',
    environment_failure: 'Document environment prerequisites and preflight checks.',
    implementation_incomplete: 'Improve acceptance coverage and monitor gate prompts for incomplete work.',
    other: 'Classify the failure more specifically before approving maintenance work.',
  };
  return recommendations[key] ?? recommendations.other;
}

function buildAnalyze(args) {
  const source = loadAnalyzeSource(args);
  const proposalsDir = args.proposals ? path.resolve(args.proposals) : source.proposalsDir ?? DEFAULT_PROPOSALS_DIR;
  const runs = readRuns(source.runsDir);
  const { proposals, skippedProposals } = readProposals(proposalsDir);
  const clustersByKey = new Map();
  for (const run of runs.runs) {
    const key = clusterKeyForRun(run);
    if (!key) continue;
    if (!clustersByKey.has(key)) {
      clustersByKey.set(key, {
        clusterId: `cluster-${key}`,
        classification: key,
        runIds: [],
        taskIds: [],
        failureSources: {},
        changedFiles: new Set(),
      });
    }
    const cluster = clustersByKey.get(key);
    cluster.runIds.push(run.runId);
    cluster.taskIds.push(run.taskId);
    if (run.failure?.source) cluster.failureSources[run.failure.source] = (cluster.failureSources[run.failure.source] ?? 0) + 1;
    for (const filePath of run.changedFiles ?? []) cluster.changedFiles.add(filePath);
  }
  const proposalSourceRuns = new Set(proposals.map((proposal) => proposal.sourceRunId).filter(Boolean));
  const clusters = [...clustersByKey.values()]
    .map((cluster) => ({
      ...cluster,
      runIds: sortedUnique(cluster.runIds),
      taskIds: sortedUnique(cluster.taskIds),
      changedFiles: sortedUnique([...cluster.changedFiles]).slice(0, 20),
      proposalCoverage: cluster.runIds.filter((runId) => proposalSourceRuns.has(runId)).length,
      recommendation: clusterRecommendation(cluster.classification),
      maintenanceCommand: maintenanceCommandForCluster(source, cluster),
      deltaDraftCommand: deltaDraftCommandForCluster(source, cluster),
    }))
    .sort((left, right) => right.runIds.length - left.runIds.length || left.classification.localeCompare(right.classification));
  return {
    schema_version: 'p2a.eval_analysis.v1',
    analysisId: `eval-analysis-${stableHash({ source: source.sourcePath, clusters })}`,
    generatedAt: new Date().toISOString(),
    source: {
      sourceKind: source.sourceKind,
      sourcePath: displayPath(source.sourcePath),
      projectId: source.projectId,
      iterationId: source.iterationId,
      runsDir: displayPath(source.runsDir),
      proposalsDir: displayPath(proposalsDir),
    },
    summary: {
      runs: runs.runs.length,
      skippedRuns: runs.skippedRuns.length,
      proposals: proposals.length,
      skippedProposals: skippedProposals.length,
      clusters: clusters.length,
    },
    clusters,
    skippedRuns: runs.skippedRuns,
    skippedProposals,
    nextActions: analyzeNextActions(source, clusters),
  };
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function maintenanceCommandForCluster(source, cluster) {
  if (source.sourceKind !== 'artifacts') return null;
  const title = `Improve ${cluster.classification} handling`;
  return [
    'node .plan2agent/scripts/p2a_iteration.mjs maintenance add',
    '--artifacts',
    shellQuote(displayPath(source.sourcePath)),
    '--title',
    shellQuote(title),
    '--accept',
    shellQuote(`Future runs avoid or clearly classify ${cluster.classification}.`),
    '--ref',
    shellQuote(`eval-cluster:${cluster.clusterId}`),
  ].join(' ');
}

function deltaDraftCommandForCluster(source, cluster) {
  if (source.sourceKind !== 'artifacts') return null;
  if (!['scope_violation', 'missing_dependency'].includes(cluster.classification)) return null;
  const idea = `Address repeated ${cluster.classification} evidence from ${cluster.runIds.length} run(s).`;
  return [
    'node .plan2agent/scripts/p2a_iteration.mjs open',
    '--artifacts',
    shellQuote(displayPath(source.sourcePath)),
    '--iteration-id',
    'v-next',
    '--idea',
    shellQuote(idea),
    '&& node .plan2agent/scripts/p2a_iteration.mjs draft --artifacts',
    shellQuote(displayPath(source.sourcePath)),
  ].join(' ');
}

function analyzeNextActions(source, clusters) {
  if (!clusters.length) return ['No failure clusters found in local run evidence.'];
  const actions = [`Mine proposal candidates: node .plan2agent/scripts/p2a_proposals.mjs mine --runs ${displayPath(source.runsDir)}`];
  if (source.sourceKind === 'artifacts') {
    actions.push('For execution hygiene issues, use the maintenanceCommand from the relevant cluster.');
    actions.push('For product/spec scope issues, use the deltaDraftCommand from the relevant cluster when present.');
  }
  return actions;
}

function printAnalyze(payload, writeResult) {
  console.log('Plan2Agent eval analyze');
  console.log(`- source: ${payload.source.sourceKind} ${payload.source.sourcePath}`);
  console.log(`- runs: ${payload.summary.runs} clusters=${payload.summary.clusters} proposals=${payload.summary.proposals}`);
  payload.clusters.forEach((cluster) => {
    console.log(`- cluster: ${cluster.classification} runs=${cluster.runIds.length} proposalCoverage=${cluster.proposalCoverage}`);
    console.log(`  recommendation: ${cluster.recommendation}`);
  });
  if (writeResult.wrote) console.log(`- output: ${displayPath(writeResult.filePath)}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function runGrade(args) {
  const source = loadGraphSource(args);
  const runInfo = loadRunForGrade(source, args);
  const payload = buildGrade(source, runInfo);
  const writeResult = writeOutputIfRequested(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printGrade(payload, writeResult);
  return 0;
}

function runCompare(args) {
  const payload = buildCompare(args);
  const writeResult = writeOutputIfRequested(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printCompare(payload, writeResult);
  return 0;
}

function runAnalyze(args) {
  const payload = buildAnalyze(args);
  const writeResult = writeOutputIfRequested(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printAnalyze(payload, writeResult);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.command === 'grade') return runGrade(args);
  if (args.command === 'compare') return runCompare(args);
  if (args.command === 'analyze') return runAnalyze(args);
  throw new Error(`unknown command: ${args.command}`);
}

main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`p2a_eval error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
