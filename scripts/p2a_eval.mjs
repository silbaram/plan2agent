#!/usr/bin/env node
/** Deterministic Plan2Agent run grading, regression compare, and failure analysis. */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  loadJson,
  validateProposalDraftApprovalData,
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
const COMMANDS = new Set(['grade', 'compare', 'analyze', 'generate', 'digest']);
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
    '  node .plan2agent/scripts/p2a_eval.mjs analyze (--artifacts <dir>|--graph <path>|--runs <dir>) [--proposals <dir>] [--maintenance-draft <path>] [--apply-maintenance [--yes]] [--output <path>] [--dry-run] [--json]',
    '  node .plan2agent/scripts/p2a_eval.mjs generate [--artifacts <dir>|--graph <path> [--runs <dir>]|--runs <dir>] [--baseline <dir> --candidate <dir>] [--proposals <dir>] [--output <dir>] [--dry-run] [--json]',
    '  node .plan2agent/scripts/p2a_eval.mjs digest [--eval <dir>|--artifacts <dir>|--graph <path>|--runs <dir>] [--output <path>] [--dry-run] [--json]',
    '',
    'Commands:',
    '  grade     Evaluate one run against its task acceptance criteria and verification evidence.',
    '  compare   Compare two local iteration/run snapshots for regression signals.',
    '  analyze   Cluster failed runs, verification gaps, and proposal coverage into follow-up candidates.',
    '  generate  Write grade/analyze/compare eval artifacts for the selected local source.',
    '  digest    Summarize generated eval artifacts into a compact follow-up view.',
    '',
    'Source options:',
    '  --artifacts <dir>   Iterative artifact root.',
    '  --graph <path>      Task graph JSON path.',
    '  --runs <dir>        Explicit runs directory for analyze/digest/generate, or generate with --graph.',
    '  --run-id <id>       Run id to grade. Reads the matching runs directory.',
    '  --run <path>        Explicit run JSON path to grade.',
    '  --baseline <path>   Baseline artifact root or runs directory for compare.',
    '  --candidate <path>  Candidate artifact root or runs directory for compare.',
    '  --proposals <dir>   Proposal queue directory for analyze/generate.',
    '  --maintenance-draft <path>',
    '                      For analyze, write a maintenance task draft JSON from failure clusters.',
    '  --apply-maintenance For analyze with --artifacts, add drafted maintenance tasks to the maintenance graph.',
    '  --yes               Required with --apply-maintenance unless --dry-run is also set.',
    '  --eval <dir>        Generated eval artifact directory for digest.',
    '  --output <path>     Optional output path. For generate this is a directory; otherwise a JSON file.',
    '  --dry-run           Print output plan/result without writing outputs.',
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
    maintenanceDraft: null,
    applyMaintenance: false,
    yes: false,
    evalDir: null,
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
    else if (arg === '--maintenance-draft') args.maintenanceDraft = requiredValue(argv, ++index, '--maintenance-draft');
    else if (arg === '--apply-maintenance') args.applyMaintenance = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--eval') args.evalDir = requiredValue(argv, ++index, '--eval');
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
    if (args.evalDir) throw new Error('grade does not support --eval');
    if (args.maintenanceDraft || args.applyMaintenance || args.yes) throw new Error('grade does not support maintenance draft/apply options');
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
    if (args.artifacts || args.graph || args.runs || args.run || args.runId || args.proposals || args.evalDir || args.maintenanceDraft || args.applyMaintenance || args.yes) {
      throw new Error('compare only supports --baseline, --candidate, --output, --dry-run, and --json');
    }
    return;
  }
  if (args.command === 'analyze') {
    if (args.evalDir) throw new Error('analyze does not support --eval');
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
    if ((args.maintenanceDraft || args.applyMaintenance) && !args.artifacts) {
      throw new Error('maintenance draft/apply requires analyze --artifacts so tasks can target the maintenance graph');
    }
    if (args.applyMaintenance && !args.dryRun && !args.yes) {
      throw new Error('--apply-maintenance requires --yes, or use --dry-run to preview');
    }
    if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
    return;
  }
  if (args.command === 'generate') {
    if (args.evalDir) throw new Error('generate uses --output for the eval artifact directory, not --eval');
    if (args.maintenanceDraft || args.applyMaintenance || args.yes) throw new Error('generate does not support maintenance draft/apply options');
    if (args.run || args.runId) throw new Error('generate grades all indexed runs; use grade for one --run or --run-id');
    if ((args.baseline && !args.candidate) || (!args.baseline && args.candidate)) {
      throw new Error('generate requires both --baseline and --candidate when generating compare output');
    }
    if (args.artifacts && args.graph) throw new Error('generate cannot combine --artifacts and --graph');
    if (args.artifacts && args.runs) throw new Error('generate cannot combine --artifacts and --runs; use --graph with --runs for detached run directories');
    if (!args.artifacts && !args.graph && !args.runs && !args.baseline) {
      const defaultArtifacts = singleArtifactProjectRoot();
      const configuredGraph = configuredTaskGraphPath();
      if (defaultArtifacts) args.artifacts = defaultArtifacts;
      else if (configuredGraph) args.graph = configuredGraph;
      else if (existsSync(path.join('.plan2agent', 'runs'))) args.runs = path.join('.plan2agent', 'runs');
      else assertNoUninitializedScaffoldArtifactRoots();
    }
    if (args.proposals && !args.artifacts && !args.graph && !args.runs) {
      throw new Error('generate only supports --proposals when a local source is selected');
    }
    if (!args.artifacts && !args.graph && !args.runs && !args.baseline) {
      throw new Error('generate requires a local source or --baseline/--candidate compare sources');
    }
    if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
    return;
  }
  if (args.command === 'digest') {
    if (args.run || args.runId || args.baseline || args.candidate || args.proposals || args.maintenanceDraft || args.applyMaintenance || args.yes) {
      throw new Error('digest supports only --eval, source options, --output, --dry-run, and --json');
    }
    const sourceCount = [args.evalDir, args.artifacts, args.graph, args.runs].filter(Boolean).length;
    if (sourceCount === 0) {
      const defaultArtifacts = singleArtifactProjectRoot();
      const configuredGraph = configuredTaskGraphPath();
      if (existsSync(path.join('.plan2agent', 'eval'))) args.evalDir = path.join('.plan2agent', 'eval');
      else if (defaultArtifacts) args.artifacts = defaultArtifacts;
      else if (configuredGraph) args.graph = configuredGraph;
      else if (existsSync(path.join('.plan2agent', 'runs'))) args.runs = path.join('.plan2agent', 'runs');
      else assertNoUninitializedScaffoldArtifactRoots();
    }
    if ([args.evalDir, args.artifacts, args.graph, args.runs].filter(Boolean).length !== 1) {
      throw new Error('digest requires exactly one of --eval, --artifacts, --graph, or --runs');
    }
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

function loadGenerateSource(args) {
  if (args.artifacts || args.graph) {
    const source = loadGraphSource(args);
    if (!args.runs) return source;
    const runsDir = path.resolve(args.runs);
    return {
      ...source,
      runsDir,
      proposalsDir: path.join(path.dirname(runsDir), 'proposals'),
    };
  }
  if (args.runs) return loadAnalyzeSource(args);
  return null;
}

function evalOutputDirForSource(source) {
  if (source.sourceKind === 'artifacts') return path.join(source.sourcePath, 'eval');
  return path.join(path.dirname(source.runsDir), 'eval');
}

function resolveGenerateOutputDir(args, source) {
  if (args.output) return path.resolve(args.output);
  if (source) return evalOutputDirForSource(source);
  return path.resolve('.plan2agent', 'eval');
}

function resolveDigestEvalDir(args) {
  if (args.evalDir) return path.resolve(args.evalDir);
  const source = loadAnalyzeSource(args);
  return evalOutputDirForSource(source);
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
    ...structuredRunEvidence(run.reproduction),
    ...structuredRunEvidence(run.localization),
    ...structuredRunEvidence(run.fixSummary),
    ...structuredRunEvidence(run.guard),
    ...(run.verification ?? []).flatMap((item) => [
      item.type,
      item.command,
      item.status,
      item.stdoutTail,
      item.stderrTail,
    ]),
  ].filter(Boolean).join('\n');
}

function structuredRunEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap((item) => Array.isArray(item) ? item : [item]).filter(Boolean);
}

function arrayLength(value) {
  return Array.isArray(value) ? value.filter(Boolean).length : 0;
}

function structuredRunSummary(run) {
  const reproductionSteps = arrayLength(run.reproduction?.steps);
  const reproductionCommands = arrayLength(run.reproduction?.commands);
  const reproductionNotes = arrayLength(run.reproduction?.notes);
  const localizationFindings = arrayLength(run.localization?.findings);
  const localizedFiles = arrayLength(run.localization?.files);
  const fixSummaries = arrayLength(run.fixSummary?.summaries);
  const fixFiles = arrayLength(run.fixSummary?.files);
  const guardChecks = arrayLength(run.guard?.checks);
  const guardNotes = arrayLength(run.guard?.notes);
  return {
    hasReproduction: reproductionSteps + reproductionCommands + reproductionNotes > 0,
    hasLocalization: localizationFindings + localizedFiles > 0,
    hasFixSummary: fixSummaries + fixFiles > 0,
    hasGuard: guardChecks + guardNotes > 0,
    reproductionSteps,
    reproductionCommands,
    reproductionNotes,
    localizationFindings,
    localizedFiles,
    fixSummaries,
    fixFiles,
    guardChecks,
    guardNotes,
  };
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
      reproduction: runInfo.run.reproduction ?? null,
      localization: runInfo.run.localization ?? null,
      fixSummary: runInfo.run.fixSummary ?? null,
      guard: runInfo.run.guard ?? null,
      failure: runInfo.run.failure ?? null,
      structuredEvidence: structuredRunSummary(runInfo.run),
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
    `Inspect run evidence: node .plan2agent/scripts/p2a.mjs runs show --runs ${displayPath(source.runsDir)} --run-id ${run.runId}`,
  ];
  if (run.status === 'failed' || run.status === 'blocked' || verdict === 'needs_evidence') {
    actions.push(`Mine proposal candidates: node .plan2agent/scripts/p2a.mjs proposals mine --runs ${displayPath(source.runsDir)} --run-id ${run.runId}`);
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
  let failedOrBlockedRuns = 0;
  let missingReproduction = 0;
  let missingLocalization = 0;
  let missingGuard = 0;
  let guardedFailures = 0;
  for (const run of source.runs.runs) {
    runStatus[run.status] = (runStatus[run.status] ?? 0) + 1;
    if (run.failure?.class) failureClasses[run.failure.class] = (failureClasses[run.failure.class] ?? 0) + 1;
    if (run.verification.some((item) => item.status === 'failed')) verificationFailures += 1;
    if (run.status === 'finished' && run.verification.length === 0) verificationGaps += 1;
    if (['failed', 'blocked'].includes(run.status)) {
      failedOrBlockedRuns += 1;
      const structured = structuredRunSummary(run);
      if (!structured.hasReproduction) missingReproduction += 1;
      if (!structured.hasLocalization) missingLocalization += 1;
      if (!structured.hasGuard) missingGuard += 1;
      if (structured.hasGuard) guardedFailures += 1;
    }
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
      structuredEvidence: {
        failedOrBlockedRuns,
        missingReproduction,
        missingLocalization,
        missingGuard,
        guardedFailures,
      },
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
  for (const metric of ['missingReproduction', 'missingLocalization', 'missingGuard']) {
    const baselineValue = baseline.runs.structuredEvidence?.[metric] ?? 0;
    const candidateValue = candidate.runs.structuredEvidence?.[metric] ?? 0;
    if (candidateValue > baselineValue) {
      signals.push({ severity: 'warn', metric: `structured_${metric}`, baseline: baselineValue, candidate: candidateValue });
    }
  }
  if (!signals.length) signals.push({ severity: 'pass', metric: 'regression_checks', baseline: 'no worse', candidate: 'no worse' });
  return signals;
}

function compareNextActions(verdict, candidate) {
  if (verdict === 'pass') return ['No regression follow-up required by local eval compare.'];
  return [
    `Analyze candidate failures: node .plan2agent/scripts/p2a.mjs eval analyze --runs ${candidate.runsDir}`,
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
  return buildAnalyzeForSource(source, args.proposals);
}

function buildAnalyzeForSource(source, proposalsArg = null) {
  const proposalsDir = proposalsArg ? path.resolve(proposalsArg) : source.proposalsDir ?? DEFAULT_PROPOSALS_DIR;
  const runs = readRuns(source.runsDir);
  const { proposals, skippedProposals } = readProposals(proposalsDir);
  const clustersByKey = new Map();
  for (const run of runs.runs) {
    const key = clusterKeyForRun(run);
    if (!key) continue;
    if (!clustersByKey.has(key)) {
      clustersByKey.set(key, {
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
    .map((cluster) => {
      const runIds = sortedUnique(cluster.runIds);
      const taskIds = sortedUnique(cluster.taskIds);
      const changedFiles = sortedUnique([...cluster.changedFiles]).slice(0, 20);
      const clusterId = `cluster-${cluster.classification}-${stableHash({ runIds, taskIds, changedFiles })}`;
      const normalizedCluster = {
        ...cluster,
        clusterId,
        runIds,
        taskIds,
        changedFiles,
        proposalCoverage: runIds.filter((runId) => proposalSourceRuns.has(runId)).length,
        recommendation: clusterRecommendation(cluster.classification),
      };
      return {
        ...normalizedCluster,
        maintenanceCommand: maintenanceCommandForCluster(source, normalizedCluster),
        deltaDraftCommand: deltaDraftCommandForCluster(source, normalizedCluster),
      };
    })
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
    'node .plan2agent/scripts/p2a.mjs iteration maintenance add',
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
    'node .plan2agent/scripts/p2a.mjs iteration open',
    '--artifacts',
    shellQuote(displayPath(source.sourcePath)),
    '--iteration-id',
    'v-next',
    '--idea',
    shellQuote(idea),
    '&& node .plan2agent/scripts/p2a.mjs iteration draft --artifacts',
    shellQuote(displayPath(source.sourcePath)),
  ].join(' ');
}

function analyzeNextActions(source, clusters) {
  if (!clusters.length) return ['No failure clusters found in local run evidence.'];
  const actions = [`Mine proposal candidates: node .plan2agent/scripts/p2a.mjs proposals mine --runs ${displayPath(source.runsDir)}`];
  if (source.sourceKind === 'artifacts') {
    actions.push('For execution hygiene issues, use the maintenanceCommand from the relevant cluster.');
    actions.push('For product/spec scope issues, use the deltaDraftCommand from the relevant cluster when present.');
  }
  return actions;
}

function maintenanceDraftTask(source, analysis, cluster) {
  const title = `Improve ${cluster.classification} handling`;
  const runList = cluster.runIds.join(', ');
  const taskList = cluster.taskIds.join(', ');
  const sourceSpecRefs = sortedUnique([
    `eval-analysis:${analysis.analysisId}`,
    `eval-cluster:${cluster.clusterId}`,
    ...cluster.runIds.map((runId) => `run:${runId}`),
  ]);
  const acceptanceCriteria = [
    `Future runs avoid or explicitly classify ${cluster.classification}.`,
    `Local verification or documented guard covers the failure pattern from ${cluster.runIds.length} run(s).`,
  ];
  if (cluster.changedFiles.length) {
    acceptanceCriteria.push('The maintenance fix stays scoped to the files or workflow area implicated by the eval cluster.');
  }
  const description = [
    `Eval cluster ${cluster.clusterId} found ${cluster.runIds.length} run(s) classified as ${cluster.classification}.`,
    `Runs: ${runList || 'none'}.`,
    `Tasks: ${taskList || 'none'}.`,
    `Recommendation: ${cluster.recommendation}`,
  ].join('\n');
  const suggestedAgentPrompt = [
    `Apply the maintenance follow-up for eval cluster ${cluster.clusterId} in project ${source.projectId}.`,
    `Classification: ${cluster.classification}.`,
    `Runs: ${runList || 'none'}.`,
    `Tasks: ${taskList || 'none'}.`,
    cluster.changedFiles.length ? `Impacted files: ${cluster.changedFiles.join(', ')}.` : null,
    `Recommendation: ${cluster.recommendation}`,
    'Keep the change scoped, update verification evidence, and record the guard that prevents recurrence.',
  ].filter(Boolean).join('\n');
  return {
    clusterId: cluster.clusterId,
    classification: cluster.classification,
    runIds: cluster.runIds,
    taskIds: cluster.taskIds,
    title,
    description,
    acceptanceCriteria,
    targetArea: 'maintenance',
    suggestedAgentPrompt,
    sourceSpecRefs,
    applyCommand: maintenanceAddCommandForTask(source, {
      title,
      description,
      acceptanceCriteria,
      targetArea: 'maintenance',
      suggestedAgentPrompt,
      sourceSpecRefs,
    }),
  };
}

function maintenanceAddCommandForTask(source, task) {
  return [
    'node .plan2agent/scripts/p2a.mjs iteration maintenance add',
    '--artifacts',
    shellQuote(displayPath(source.sourcePath)),
    '--title',
    shellQuote(task.title),
    '--description',
    shellQuote(task.description),
    '--area',
    shellQuote(task.targetArea),
    '--prompt',
    shellQuote(task.suggestedAgentPrompt),
    ...task.acceptanceCriteria.flatMap((criterion) => ['--accept', shellQuote(criterion)]),
    ...task.sourceSpecRefs.flatMap((ref) => ['--ref', shellQuote(ref)]),
  ].join(' ');
}

function buildMaintenanceDraft(source, analysis) {
  if (source.sourceKind !== 'artifacts') {
    throw new Error('maintenance draft requires an artifact source');
  }
  const tasks = analysis.clusters.map((cluster) => maintenanceDraftTask(source, analysis, cluster));
  return {
    schema_version: 'p2a.eval_maintenance_draft.v1',
    draftId: `eval-maintenance-draft-${stableHash({
      analysisId: analysis.analysisId,
      source: source.sourcePath,
      tasks: tasks.map((task) => ({ clusterId: task.clusterId, refs: task.sourceSpecRefs })),
    })}`,
    generatedAt: new Date().toISOString(),
    source: analysis.source,
    analysisId: analysis.analysisId,
    summary: {
      clusters: analysis.clusters.length,
      tasks: tasks.length,
    },
    tasks,
    nextActions: tasks.length
      ? [
          'Review this draft before applying it to the maintenance graph.',
          `Apply after review: node .plan2agent/scripts/p2a.mjs eval analyze --artifacts ${shellQuote(displayPath(source.sourcePath))} --apply-maintenance --yes`,
        ]
      : ['No maintenance tasks were drafted because no failure clusters were found.'],
  };
}

function writeMaintenanceDraftIfRequested(args, draft) {
  if (!draft || !args.maintenanceDraft) return { wrote: false, filePath: null };
  const filePath = path.resolve(args.maintenanceDraft);
  if (args.dryRun) return { wrote: false, filePath };
  writeJsonFile(filePath, draft);
  return { wrote: true, filePath };
}

function maintenanceGraphPathForSource(source) {
  return path.join(source.sourcePath, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
}

function existingMaintenanceClusterRefs(source) {
  const graphPath = maintenanceGraphPathForSource(source);
  if (!fileExists(graphPath)) return new Set();
  try {
    const graph = loadJson(graphPath);
    return new Set(
      (graph.tasks ?? [])
        .flatMap((task) => Array.isArray(task.sourceSpecRefs) ? task.sourceSpecRefs : [])
        .filter((ref) => typeof ref === 'string' && ref.startsWith('eval-cluster:')),
    );
  } catch {
    return new Set();
  }
}

function tailText(value) {
  const text = String(value ?? '');
  return text.length > 4000 ? text.slice(-4000) : text;
}

function maintenanceAddCliArgs(source, task, dryRun) {
  const iterationScript = path.join(P2A_PATHS.scriptsDir, 'p2a_iteration.mjs');
  return [
    iterationScript,
    'maintenance',
    'add',
    '--artifacts',
    source.sourcePath,
    '--title',
    task.title,
    '--description',
    task.description,
    '--area',
    task.targetArea,
    '--prompt',
    task.suggestedAgentPrompt,
    ...task.acceptanceCriteria.flatMap((criterion) => ['--accept', criterion]),
    ...task.sourceSpecRefs.flatMap((ref) => ['--ref', ref]),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

function runMaintenanceAddTask(source, task, dryRun) {
  return spawnSync(process.execPath, maintenanceAddCliArgs(source, task, dryRun), {
    cwd: P2A_PATHS.projectRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 5,
  });
}

function maintenanceTaskApplyResult(task, status, reason, result = null) {
  return {
    clusterId: task.clusterId,
    title: task.title,
    status,
    reason,
    exitCode: result ? typeof result.status === 'number' ? result.status : 1 : null,
    stdoutTail: result ? tailText(result.stdout) : undefined,
    stderrTail: result ? tailText([result.stderr, result.error?.message].filter(Boolean).join('\n')) : undefined,
  };
}

function buildMaintenanceApplyResult(source, draft, args, results) {
  const failed = results.filter((result) => result.status === 'failed').length;
  const applied = results.filter((result) => result.status === 'applied').length;
  const dryRun = results.filter((result) => result.status === 'dry_run').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  return {
    status: failed ? 'failed' : applied ? 'applied' : dryRun ? 'dry_run' : 'noop',
    graphPath: displayPath(maintenanceGraphPathForSource(source)),
    dryRun: args.dryRun,
    summary: {
      tasks: draft.tasks.length,
      applied,
      dryRun,
      skipped,
      failed,
    },
    results,
  };
}

function maintenanceApplyReportPath(source) {
  return path.join(source.sourcePath, 'eval', 'maintenance-apply-report.json');
}

function writeMaintenanceApplyReportIfNeeded(source, applyResult, args) {
  if (args.dryRun) return null;
  const filePath = maintenanceApplyReportPath(source);
  writeJsonFile(filePath, {
    schema_version: 'p2a.eval_maintenance_apply_report.v1',
    generatedAt: new Date().toISOString(),
    source: sourceDescriptor(source),
    ...applyResult,
  });
  return displayPath(filePath);
}

function applyMaintenanceDraft(source, draft, args) {
  const existingRefs = existingMaintenanceClusterRefs(source);
  const results = [];
  const pending = [];
  for (const task of draft.tasks) {
    const clusterRef = task.sourceSpecRefs.find((ref) => ref.startsWith('eval-cluster:')) ?? null;
    if (clusterRef && existingRefs.has(clusterRef)) {
      results.push(maintenanceTaskApplyResult(
        task,
        'skipped',
        `maintenance graph already contains ${clusterRef}`,
      ));
      continue;
    }
    pending.push({ task, clusterRef });
  }

  if (args.dryRun) {
    for (const item of pending) {
      const result = runMaintenanceAddTask(source, item.task, true);
      const status = result.status === 0 ? 'dry_run' : 'failed';
      results.push(maintenanceTaskApplyResult(
        item.task,
        status,
        status === 'failed' ? 'p2a_iteration maintenance add dry-run failed' : null,
        result,
      ));
    }
    return buildMaintenanceApplyResult(source, draft, args, results);
  }

  const preflightFailures = [];
  for (const item of pending) {
    const result = runMaintenanceAddTask(source, item.task, true);
    if (result.status !== 0) {
      preflightFailures.push(maintenanceTaskApplyResult(
        item.task,
        'failed',
        'p2a_iteration maintenance add dry-run preflight failed',
        result,
      ));
    }
  }
  if (preflightFailures.length) {
    const applyResult = buildMaintenanceApplyResult(source, draft, args, [...results, ...preflightFailures]);
    return {
      ...applyResult,
      reportPath: writeMaintenanceApplyReportIfNeeded(source, applyResult, args),
    };
  }

  for (const item of pending) {
    const result = runMaintenanceAddTask(source, item.task, false);
    const status = result.status === 0 ? 'applied' : 'failed';
    if (status === 'applied' && item.clusterRef) existingRefs.add(item.clusterRef);
    results.push(maintenanceTaskApplyResult(
      item.task,
      status,
      status === 'failed' ? 'p2a_iteration maintenance add failed' : null,
      result,
    ));
  }
  const applyResult = buildMaintenanceApplyResult(source, draft, args, results);
  return {
    ...applyResult,
    reportPath: writeMaintenanceApplyReportIfNeeded(source, applyResult, args),
  };
}

function printAnalyze(payload, writeResult) {
  console.log('Plan2Agent eval analyze');
  console.log(`- source: ${payload.source.sourceKind} ${payload.source.sourcePath}`);
  console.log(`- runs: ${payload.summary.runs} clusters=${payload.summary.clusters} proposals=${payload.summary.proposals}`);
  payload.clusters.forEach((cluster) => {
    console.log(`- cluster: ${cluster.classification} runs=${cluster.runIds.length} proposalCoverage=${cluster.proposalCoverage}`);
    console.log(`  recommendation: ${cluster.recommendation}`);
  });
  if (payload.maintenanceDraft) {
    console.log(`- maintenance draft: tasks=${payload.maintenanceDraft.summary.tasks}`);
    if (payload.maintenanceDraft.outputPath) {
      console.log(`- maintenance draft output: ${payload.maintenanceDraft.outputPath}${payload.maintenanceDraft.dryRun ? ' (dry-run)' : ''}`);
    }
    if (payload.maintenanceDraft.applyResult) {
      const result = payload.maintenanceDraft.applyResult;
      console.log(`- maintenance apply: ${result.status} applied=${result.summary.applied} skipped=${result.summary.skipped} failed=${result.summary.failed}`);
      if (result.reportPath) console.log(`- maintenance apply report: ${result.reportPath}`);
    }
  }
  if (writeResult.wrote) console.log(`- output: ${displayPath(writeResult.filePath)}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function buildGeneratedGrades(source, runs) {
  const grades = [];
  const skippedGrades = [];
  if (!source.graph) {
    for (const run of runs.runs) {
      skippedGrades.push({
        runId: run.runId,
        taskId: run.taskId,
        reason: 'task graph is unavailable; use --artifacts or --graph to generate grades',
      });
    }
    return { grades, skippedGrades };
  }
  for (const run of runs.runs) {
    try {
      grades.push(buildGrade(source, {
        run,
        filePath: runFilePath(source.runsDir, run.runId),
      }));
    } catch (error) {
      skippedGrades.push({
        runId: run.runId,
        taskId: run.taskId,
        reason: errorMessage(error),
      });
    }
  }
  return { grades, skippedGrades };
}

function generateFileMap(outputDir, grades, analysis, compare) {
  return {
    index: displayPath(path.join(outputDir, 'eval-index.json')),
    grades: grades.map((grade) => ({
      runId: grade.run.runId,
      taskId: grade.task.taskId,
      verdict: grade.verdict,
      score: grade.score,
      path: displayPath(path.join(outputDir, 'grades', `${grade.run.runId}.json`)),
    })),
    analysis: analysis ? displayPath(path.join(outputDir, 'analysis.json')) : null,
    compare: compare ? displayPath(path.join(outputDir, 'compare.json')) : null,
  };
}

function sourceDescriptor(source) {
  if (!source) return null;
  return {
    sourceKind: source.sourceKind,
    sourcePath: displayPath(source.sourcePath),
    projectId: source.projectId,
    iterationId: source.iterationId,
    graphPath: source.graphPath ? displayPath(source.graphPath) : null,
    runsDir: displayPath(source.runsDir),
    proposalsDir: source.proposalsDir ? displayPath(source.proposalsDir) : null,
  };
}

function buildGenerate(args) {
  const source = loadGenerateSource(args);
  const outputDir = resolveGenerateOutputDir(args, source);
  const runs = source ? readRuns(source.runsDir) : { runs: [], skippedRuns: [] };
  const { grades, skippedGrades } = source
    ? buildGeneratedGrades(source, runs)
    : { grades: [], skippedGrades: [] };
  const analysis = source ? buildAnalyzeForSource(source, args.proposals) : null;
  const compare = args.baseline && args.candidate ? buildCompare(args) : null;
  const nonPassGrades = grades.filter((grade) => grade.verdict !== 'pass');
  const summary = {
    runs: runs.runs.length,
    skippedRuns: runs.skippedRuns.length,
    grades: grades.length,
    nonPassGrades: nonPassGrades.length,
    skippedGrades: skippedGrades.length,
    analyses: analysis ? 1 : 0,
    compares: compare ? 1 : 0,
    clusters: analysis?.summary?.clusters ?? 0,
    compareVerdict: compare?.verdict ?? null,
  };
  const files = generateFileMap(outputDir, grades, analysis, compare);
  const payload = {
    schema_version: 'p2a.eval_generate.v1',
    generateId: `eval-generate-${stableHash({
      source: sourceDescriptor(source),
      compare: compare ? { baseline: args.baseline, candidate: args.candidate, verdict: compare.verdict } : null,
      summary,
    })}`,
    generatedAt: new Date().toISOString(),
    outputDir: displayPath(outputDir),
    source: sourceDescriptor(source),
    compareSource: compare ? {
      baseline: displayPath(path.resolve(args.baseline)),
      candidate: displayPath(path.resolve(args.candidate)),
    } : null,
    summary,
    files,
    skippedRuns: runs.skippedRuns,
    skippedGrades,
    nextActions: [],
    results: {
      grades,
      analysis,
      compare,
    },
  };
  payload.nextActions = generateNextActions(payload);
  return payload;
}

function generateNextActions(payload) {
  const digestOutputPath = path.join(payload.outputDir, 'eval-digest.json');
  const actions = [
    `Summarize generated eval artifacts: node .plan2agent/scripts/p2a.mjs eval digest --eval ${shellQuote(payload.outputDir)} --output ${shellQuote(digestOutputPath)}`,
  ];
  if (payload.skippedGrades.length) {
    actions.push('Review skippedGrades; runs without a matching task graph cannot receive acceptance coverage grades.');
  }
  if (payload.summary.nonPassGrades > 0) {
    actions.push('Review non-pass grade files under the generated grades directory before closing the related tasks.');
  }
  if (payload.results.analysis?.clusters?.length) {
    actions.push('Use analysis cluster maintenanceCommand or deltaDraftCommand when the failure pattern requires follow-up work.');
  }
  if (payload.results.compare && payload.results.compare.verdict !== 'pass') {
    actions.push('Review compare.json regression signals before promoting the candidate run set.');
  }
  return actions;
}

function writeJsonFile(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function removeFileIfExists(filePath) {
  if (!fileExists(filePath)) return;
  rmSync(filePath, { force: true });
}

function cleanGenerateOutputs(outputDir) {
  removeFileIfExists(path.join(outputDir, 'eval-index.json'));
  removeFileIfExists(path.join(outputDir, 'analysis.json'));
  removeFileIfExists(path.join(outputDir, 'compare.json'));
  const gradesDir = path.join(outputDir, 'grades');
  if (!directoryExists(gradesDir)) return;
  for (const entry of readdirSync(gradesDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      removeFileIfExists(path.join(gradesDir, entry.name));
    }
  }
}

function writeGenerateOutputs(args, payload) {
  const outputDir = path.resolve(args.output ?? payload.outputDir);
  const gradeFiles = payload.results.grades.map((grade) => ({
    grade,
    filePath: path.join(outputDir, 'grades', `${grade.run.runId}.json`),
  }));
  const analysisPath = payload.results.analysis ? path.join(outputDir, 'analysis.json') : null;
  const comparePath = payload.results.compare ? path.join(outputDir, 'compare.json') : null;
  const indexPath = path.join(outputDir, 'eval-index.json');
  if (args.dryRun) {
    return {
      wrote: false,
      outputDir,
      files: {
        index: indexPath,
        grades: gradeFiles.map((item) => item.filePath),
        analysis: analysisPath,
        compare: comparePath,
      },
    };
  }
  cleanGenerateOutputs(outputDir);
  for (const item of gradeFiles) writeJsonFile(item.filePath, item.grade);
  if (payload.results.analysis) writeJsonFile(analysisPath, payload.results.analysis);
  if (payload.results.compare) writeJsonFile(comparePath, payload.results.compare);
  const { results, ...indexPayload } = payload;
  writeJsonFile(indexPath, {
    ...indexPayload,
    schema_version: 'p2a.eval_index.v1',
    generateSchemaVersion: payload.schema_version,
  });
  return {
    wrote: true,
    outputDir,
    files: {
      index: indexPath,
      grades: gradeFiles.map((item) => item.filePath),
      analysis: analysisPath,
      compare: comparePath,
    },
  };
}

function printGenerate(payload, writeResult, dryRun) {
  console.log('Plan2Agent eval generate');
  if (payload.source) console.log(`- source: ${payload.source.sourceKind} ${payload.source.sourcePath}`);
  if (payload.compareSource) console.log(`- compare: ${payload.compareSource.baseline} -> ${payload.compareSource.candidate}`);
  console.log(`- output: ${payload.outputDir}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`- grades: ${payload.summary.grades} nonPass=${payload.summary.nonPassGrades} skipped=${payload.summary.skippedGrades}`);
  console.log(`- analysis: ${payload.summary.analyses} clusters=${payload.summary.clusters}`);
  if (payload.summary.compares) console.log(`- compare: verdict=${payload.summary.compareVerdict}`);
  if (writeResult.wrote) console.log(`- index: ${displayPath(writeResult.files.index)}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function jsonFilesRecursive(dirPath) {
  if (!directoryExists(dirPath)) throw new Error(`eval directory is missing: ${dirPath}`);
  const entries = readdirSync(dirPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) files.push(...jsonFilesRecursive(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files;
}

function readEvalArtifacts(evalDir) {
  const artifacts = {
    indexes: [],
    grades: [],
    analyses: [],
    compares: [],
    digests: [],
    applyReports: [],
    skippedFiles: [],
    totalJsonFiles: 0,
  };
  for (const filePath of jsonFilesRecursive(evalDir)) {
    artifacts.totalJsonFiles += 1;
    try {
      const payload = JSON.parse(readFileSync(filePath, 'utf8'));
      const schemaVersion = payload?.schema_version;
      if (schemaVersion === 'p2a.eval_index.v1' || schemaVersion === 'p2a.eval_generate.v1') {
        artifacts.indexes.push({ filePath, payload });
      } else if (schemaVersion === 'p2a.eval_grade.v1') {
        artifacts.grades.push({ filePath, payload });
      } else if (schemaVersion === 'p2a.eval_analysis.v1') {
        artifacts.analyses.push({ filePath, payload });
      } else if (schemaVersion === 'p2a.eval_compare.v1') {
        artifacts.compares.push({ filePath, payload });
      } else if (schemaVersion === 'p2a.eval_digest.v1') {
        artifacts.digests.push({ filePath, payload });
      } else if (schemaVersion === 'p2a.eval_maintenance_apply_report.v1') {
        artifacts.applyReports.push({ filePath, payload });
      } else {
        artifacts.skippedFiles.push({ filePath: displayPath(filePath), reason: `unsupported schema_version: ${schemaVersion ?? 'missing'}` });
      }
    } catch (error) {
      artifacts.skippedFiles.push({ filePath: displayPath(filePath), reason: errorMessage(error) });
    }
  }
  return artifacts;
}

function incrementCounter(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(3));
}

function percentLabel(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function resolveArtifactPath(value) {
  if (!value || typeof value !== 'string') return null;
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(P2A_PATHS.projectRoot, value);
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(item)))];
}

function firstEvalSource(artifacts) {
  for (const collection of [artifacts.analyses, artifacts.indexes, artifacts.grades]) {
    for (const item of collection) {
      if (item.payload?.source && typeof item.payload.source === 'object') return item.payload.source;
    }
  }
  return null;
}

function digestSourceFromArgs(args) {
  if (args.evalDir) return null;
  try {
    return loadAnalyzeSource(args);
  } catch {
    return null;
  }
}

function buildDigestSourceContext(args, evalDir, artifacts) {
  const directSource = digestSourceFromArgs(args);
  const artifactSource = firstEvalSource(artifacts);
  const runsDir = directSource?.runsDir
    ?? resolveArtifactPath(artifactSource?.runsDir)
    ?? (directoryExists(path.join(path.dirname(evalDir), 'runs')) ? path.join(path.dirname(evalDir), 'runs') : null);
  const proposalsDir = directSource?.proposalsDir
    ?? resolveArtifactPath(artifactSource?.proposalsDir)
    ?? (directoryExists(path.join(path.dirname(evalDir), 'proposals')) ? path.join(path.dirname(evalDir), 'proposals') : null);
  const sourcePath = directSource?.sourcePath
    ?? resolveArtifactPath(artifactSource?.sourcePath)
    ?? null;
  const sourceKind = directSource?.sourceKind ?? artifactSource?.sourceKind ?? null;
  const maintenanceGraphPaths = [];
  if (sourceKind === 'artifacts' && sourcePath) {
    maintenanceGraphPaths.push(maintenanceGraphPathForSource({ sourcePath }));
  }
  const scanRoots = [
    evalDir,
    sourcePath && directoryExists(sourcePath) ? sourcePath : null,
    runsDir ? path.dirname(runsDir) : null,
    proposalsDir ? path.dirname(proposalsDir) : null,
  ];
  return {
    sourceKind,
    sourcePath,
    runsDir,
    proposalsDir,
    maintenanceGraphPaths: uniquePaths(maintenanceGraphPaths),
    scanRoots: uniquePaths(scanRoots).filter((dirPath) => directoryExists(dirPath)),
  };
}

function safeJsonFilesRecursive(dirPath, maxFiles = 500) {
  if (!directoryExists(dirPath)) return [];
  const files = [];
  function visit(currentPath) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
    }
  }
  visit(dirPath);
  return files;
}

function readProposalDraftApprovals(scanRoots) {
  const approvals = [];
  const skippedApprovals = [];
  const seenFiles = new Set();
  for (const root of scanRoots) {
    for (const filePath of safeJsonFilesRecursive(root)) {
      const resolved = path.resolve(filePath);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      try {
        const payload = loadJson(resolved);
        if (payload?.schema_version !== 'p2a.proposal_draft_approval.v1') continue;
        approvals.push({
          filePath: resolved,
          payload: validateProposalDraftApprovalData(payload),
        });
      } catch (error) {
        if (path.basename(resolved).includes('approval')) {
          skippedApprovals.push({ filePath: displayPath(resolved), reason: errorMessage(error) });
        }
      }
    }
  }
  return { approvals, skippedApprovals, scannedFiles: seenFiles.size };
}

function readMaintenanceGraphs(sourceContext, approvals) {
  const approvalGraphPaths = approvals
    .map((item) => resolveArtifactPath(item.payload?.maintenanceTask?.taskGraph));
  const graphPaths = uniquePaths([
    ...sourceContext.maintenanceGraphPaths,
    ...approvalGraphPaths,
  ]).filter((filePath) => fileExists(filePath));
  const graphs = [];
  const skippedGraphs = [];
  for (const graphPath of graphPaths) {
    try {
      graphs.push({ filePath: graphPath, graph: validateTaskGraph(graphPath) });
    } catch (error) {
      skippedGraphs.push({ filePath: displayPath(graphPath), reason: errorMessage(error) });
    }
  }
  return { graphs, skippedGraphs };
}

function proposalRefsForTask(task) {
  return (task.sourceSpecRefs ?? []).filter((ref) => (
    ref.startsWith('proposal-draft-approval:')
    || ref.startsWith('proposal-patch-draft:')
    || ref.startsWith('proposal-candidate:')
  ));
}

function notesProposalApprovalId(run) {
  const note = (run.notes ?? []).find((item) => /^proposalApproval=proposal-draft-approval-[a-f0-9]{12}$/.test(item));
  return note ? note.slice('proposalApproval='.length) : null;
}

function verificationOutcome(run) {
  const checks = Array.isArray(run.verification) ? run.verification : [];
  if (run.status === 'failed' || run.status === 'blocked' || checks.some((item) => item.status === 'failed')) return 'failed';
  if (checks.length && checks.every((item) => item.status === 'passed')) return 'passed';
  return 'not_run';
}

function runLikeFromGrade(grade) {
  const run = grade.run ?? {};
  return {
    runId: run.runId ?? 'unknown',
    taskId: grade.task?.taskId ?? 'unknown',
    status: run.status ?? 'unknown',
    sourceLayout: null,
    verification: run.verification ?? [],
    notes: [],
    changedFiles: run.changedFiles ?? [],
    failure: run.failure ?? null,
    structuredEvidence: run.structuredEvidence ?? null,
  };
}

function evidenceSummaryForRun(run) {
  return run.structuredEvidence ?? structuredRunSummary(run);
}

function buildRunSelfImprovementSummary(runs, artifacts) {
  const runLikeItems = runs.length
    ? runs
    : artifacts.grades.map((item) => runLikeFromGrade(item.payload));
  const byStatus = {};
  let successful = 0;
  let failedOrBlocked = 0;
  let failed = 0;
  let blocked = 0;
  const incompleteRuns = [];
  const missing = { reproduction: 0, localization: 0, guard: 0 };
  for (const run of runLikeItems) {
    incrementCounter(byStatus, run.status ?? 'unknown');
    if (run.status === 'finished' && verificationOutcome(run) === 'passed') successful += 1;
    if (run.status === 'failed') failed += 1;
    if (run.status === 'blocked') blocked += 1;
    if (run.status === 'failed' || run.status === 'blocked') {
      failedOrBlocked += 1;
      const evidence = evidenceSummaryForRun(run);
      const missingFields = [];
      if (!evidence.hasReproduction) missingFields.push('reproduction');
      if (!evidence.hasLocalization) missingFields.push('localization');
      if (!evidence.hasGuard) missingFields.push('guard');
      for (const field of missingFields) missing[field] += 1;
      if (missingFields.length) {
        incompleteRuns.push({
          runId: run.runId,
          taskId: run.taskId,
          status: run.status,
          missing: missingFields,
        });
      }
    }
  }
  const complete = failedOrBlocked - incompleteRuns.length;
  return {
    source: runs.length ? 'runs' : (artifacts.grades.length ? 'grades' : 'none'),
    total: runLikeItems.length,
    byStatus,
    successful,
    failed,
    blocked,
    failedOrBlocked,
    failureEvidence: {
      required: failedOrBlocked,
      complete,
      incomplete: incompleteRuns.length,
      completeRate: ratio(complete, failedOrBlocked),
      missing,
      incompleteRuns: incompleteRuns.slice(0, 20),
    },
  };
}

function buildProposalSelfImprovementSummary(proposals, skippedProposals) {
  const byStatus = { proposed: 0, approved: 0, rejected: 0, deferred: 0 };
  for (const proposal of proposals) byStatus[proposal.status] = (byStatus[proposal.status] ?? 0) + 1;
  const reviewed = byStatus.approved + byStatus.rejected + byStatus.deferred;
  return {
    total: proposals.length,
    byStatus,
    approved: byStatus.approved,
    rejected: byStatus.rejected,
    deferred: byStatus.deferred,
    proposed: byStatus.proposed,
    reviewed,
    pendingReview: byStatus.proposed,
    approvalRate: ratio(byStatus.approved, reviewed),
    rejectionRate: ratio(byStatus.rejected, reviewed),
    skipped: skippedProposals.length,
  };
}

function buildRecurringFailureSummary(clusters, runs) {
  const clusterRows = clusters.length
    ? clusters.map((cluster) => ({
      classification: cluster.classification,
      count: cluster.runIds.length,
      runIds: cluster.runIds,
      taskIds: cluster.taskIds,
      proposalCoverage: cluster.proposalCoverage ?? null,
      recommendation: cluster.recommendation ?? null,
      maintenanceCommand: cluster.maintenanceCommand ?? null,
    }))
    : failureClustersFromRuns(runs);
  const recurring = clusterRows
    .filter((cluster) => cluster.count > 1)
    .sort((left, right) => right.count - left.count || left.classification.localeCompare(right.classification));
  return {
    clusters: recurring.length,
    top: recurring.slice(0, 10),
  };
}

function failureClustersFromRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = clusterKeyForRun(run);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { classification: key, runIds: [], taskIds: [] });
    const group = groups.get(key);
    group.runIds.push(run.runId);
    group.taskIds.push(run.taskId);
  }
  return [...groups.values()].map((group) => ({
    classification: group.classification,
    count: group.runIds.length,
    runIds: sortedUnique(group.runIds),
    taskIds: sortedUnique(group.taskIds),
    proposalCoverage: null,
    recommendation: clusterRecommendation(group.classification),
    maintenanceCommand: null,
  }));
}

function buildMaintenanceSelfImprovementSummary({
  approvals,
  maintenanceGraphs,
  runs,
  artifacts,
  proposalSummary,
}) {
  const proposalTasks = [];
  for (const item of maintenanceGraphs.graphs) {
    for (const task of item.graph.tasks ?? []) {
      const proposalRefs = proposalRefsForTask(task);
      if (!proposalRefs.length) continue;
      proposalTasks.push({
        taskId: task.id,
        status: task.status,
        title: task.title,
        graphPath: displayPath(item.filePath),
        proposalRefs,
      });
    }
  }

  const approvalTaskIds = new Set(approvals.map((item) => item.payload.maintenanceTask.taskId));
  const approvalIds = new Set(approvals.map((item) => item.payload.approvalId));
  const convertedApprovals = approvals.filter((approval) => proposalTasks.some((task) => (
    task.taskId === approval.payload.maintenanceTask.taskId
    && task.proposalRefs.includes(`proposal-draft-approval:${approval.payload.approvalId}`)
  )));
  const approvalDenominator = approvals.length || proposalSummary.approved;
  const convertedCount = approvals.length ? convertedApprovals.length : proposalTasks.length;
  const boundedConvertedCount = approvalDenominator ? Math.min(convertedCount, approvalDenominator) : convertedCount;
  const postMaintenanceRuns = runs.filter((run) => {
    if (run.sourceLayout !== 'maintenance') return false;
    const noteApproval = notesProposalApprovalId(run);
    return approvalTaskIds.has(run.taskId) || (noteApproval && (approvalIds.has(noteApproval) || approvals.length === 0));
  });
  const verification = { total: postMaintenanceRuns.length, passed: 0, failed: 0, notRun: 0, successRate: null, runs: [] };
  for (const run of postMaintenanceRuns) {
    const outcome = verificationOutcome(run);
    if (outcome === 'passed') verification.passed += 1;
    else if (outcome === 'failed') verification.failed += 1;
    else verification.notRun += 1;
    verification.runs.push({
      runId: run.runId,
      taskId: run.taskId,
      status: run.status,
      outcome,
      proposalApprovalId: notesProposalApprovalId(run),
    });
  }
  verification.successRate = ratio(verification.passed, verification.total);

  const applyReports = artifacts.applyReports.map((item) => item.payload);
  return {
    approvals: approvals.length,
    skippedApprovals: maintenanceGraphs.skippedApprovals ?? 0,
    approvedProposalSignals: approvalDenominator,
    maintenanceTasksFromProposals: proposalTasks.length,
    convertedApprovals: boundedConvertedCount,
    rawConvertedApprovals: convertedCount,
    pendingConversions: approvalDenominator ? Math.max(approvalDenominator - boundedConvertedCount, 0) : 0,
    conversionRate: ratio(boundedConvertedCount, approvalDenominator),
    completedMaintenanceTasks: proposalTasks.filter((task) => task.status === 'done').length,
    maintenanceTasks: proposalTasks.slice(0, 20),
    postMaintenanceVerification: verification,
    applyReports: {
      total: applyReports.length,
      applied: applyReports.reduce((sum, report) => sum + (report.summary?.applied ?? 0), 0),
      skipped: applyReports.reduce((sum, report) => sum + (report.summary?.skipped ?? 0), 0),
      failed: applyReports.reduce((sum, report) => sum + (report.summary?.failed ?? 0), 0),
      dryRun: applyReports.reduce((sum, report) => sum + (report.summary?.dryRun ?? 0), 0),
    },
  };
}

function buildSelfImprovementDigest(args, evalDir, artifacts, clusters) {
  const sourceContext = buildDigestSourceContext(args, evalDir, artifacts);
  const runsRead = sourceContext.runsDir ? readRuns(sourceContext.runsDir) : { runs: [], skippedRuns: [] };
  const proposalRead = sourceContext.proposalsDir ? readProposals(sourceContext.proposalsDir) : { proposals: [], skippedProposals: [] };
  const approvalsRead = readProposalDraftApprovals(sourceContext.scanRoots);
  const maintenanceGraphs = readMaintenanceGraphs(sourceContext, approvalsRead.approvals);
  const runSummary = buildRunSelfImprovementSummary(runsRead.runs, artifacts);
  const proposalSummary = buildProposalSelfImprovementSummary(proposalRead.proposals, proposalRead.skippedProposals);
  const maintenanceSummary = buildMaintenanceSelfImprovementSummary({
    approvals: approvalsRead.approvals,
    maintenanceGraphs: {
      ...maintenanceGraphs,
      skippedApprovals: approvalsRead.skippedApprovals.length,
    },
    runs: runsRead.runs,
    artifacts,
    proposalSummary,
  });
  return {
    sources: {
      runsDir: sourceContext.runsDir ? displayPath(sourceContext.runsDir) : null,
      proposalsDir: sourceContext.proposalsDir ? displayPath(sourceContext.proposalsDir) : null,
      approvalFiles: approvalsRead.approvals.map((item) => displayPath(item.filePath)),
      maintenanceGraphs: maintenanceGraphs.graphs.map((item) => displayPath(item.filePath)),
      skippedRuns: runsRead.skippedRuns,
      skippedProposals: proposalRead.skippedProposals,
      skippedApprovals: approvalsRead.skippedApprovals,
      skippedMaintenanceGraphs: maintenanceGraphs.skippedGraphs,
    },
    runs: runSummary,
    proposals: proposalSummary,
    recurringFailures: buildRecurringFailureSummary(clusters, runsRead.runs),
    maintenance: maintenanceSummary,
  };
}

function buildEvalDigest(args) {
  const evalDir = resolveDigestEvalDir(args);
  const artifacts = readEvalArtifacts(evalDir);
  const byVerdict = {};
  let scoreTotal = 0;
  let scoredGrades = 0;
  let coveredCriteria = 0;
  let totalCriteria = 0;
  const nonPassGrades = [];
  for (const item of artifacts.grades) {
    const grade = item.payload;
    incrementCounter(byVerdict, grade.verdict ?? 'unknown');
    if (typeof grade.score === 'number') {
      scoreTotal += grade.score;
      scoredGrades += 1;
    }
    const coverage = Array.isArray(grade.acceptanceCoverage) ? grade.acceptanceCoverage : [];
    coveredCriteria += coverage.filter((criterion) => criterion.covered).length;
    totalCriteria += coverage.length;
    if (grade.verdict !== 'pass') {
      nonPassGrades.push({
        runId: grade.run?.runId ?? 'unknown',
        taskId: grade.task?.taskId ?? 'unknown',
        verdict: grade.verdict ?? 'unknown',
        score: grade.score ?? null,
        path: displayPath(item.filePath),
        reasons: Array.isArray(grade.reasons) ? grade.reasons : [],
      });
    }
  }

  const compareByVerdict = {};
  const failingSignals = [];
  for (const item of artifacts.compares) {
    const compare = item.payload;
    incrementCounter(compareByVerdict, compare.verdict ?? 'unknown');
    for (const signal of compare.signals ?? []) {
      if (signal.severity && signal.severity !== 'pass') {
        failingSignals.push({
          verdict: compare.verdict ?? 'unknown',
          severity: signal.severity,
          metric: signal.metric,
          baseline: signal.baseline,
          candidate: signal.candidate,
          path: displayPath(item.filePath),
        });
      }
    }
  }

  const clusterByClassification = {};
  const clusters = [];
  for (const item of artifacts.analyses) {
    const analysis = item.payload;
    for (const cluster of analysis.clusters ?? []) {
      incrementCounter(clusterByClassification, cluster.classification ?? 'unknown');
      clusters.push({
        analysisId: analysis.analysisId ?? null,
        classification: cluster.classification ?? 'unknown',
        runIds: cluster.runIds ?? [],
        taskIds: cluster.taskIds ?? [],
        recommendation: cluster.recommendation ?? null,
        maintenanceCommand: cluster.maintenanceCommand ?? null,
        deltaDraftCommand: cluster.deltaDraftCommand ?? null,
        path: displayPath(item.filePath),
      });
    }
  }
  clusters.sort((left, right) => (right.runIds.length - left.runIds.length) || left.classification.localeCompare(right.classification));
  const maintenanceCommands = sortedUnique(clusters.map((cluster) => cluster.maintenanceCommand));
  const deltaDraftCommands = sortedUnique(clusters.map((cluster) => cluster.deltaDraftCommand));
  const selfImprovement = buildSelfImprovementDigest(args, evalDir, artifacts, clusters);
  const payload = {
    schema_version: 'p2a.eval_digest.v1',
    digestId: `eval-digest-${stableHash({
      evalDir: displayPath(evalDir),
      files: artifacts.totalJsonFiles,
      grades: byVerdict,
      compares: compareByVerdict,
      clusters: clusterByClassification,
      selfImprovement: {
        runs: selfImprovement.runs.total,
        proposals: selfImprovement.proposals.total,
        approvals: selfImprovement.maintenance.approvals,
        recurring: selfImprovement.recurringFailures.clusters,
      },
    })}`,
    generatedAt: new Date().toISOString(),
    evalDir: displayPath(evalDir),
    files: {
      totalJson: artifacts.totalJsonFiles,
      indexes: artifacts.indexes.length,
      grades: artifacts.grades.length,
      analyses: artifacts.analyses.length,
      compares: artifacts.compares.length,
      digests: artifacts.digests.length,
      applyReports: artifacts.applyReports.length,
      skipped: artifacts.skippedFiles.length,
    },
    grades: {
      total: artifacts.grades.length,
      byVerdict,
      averageScore: scoredGrades ? Number((scoreTotal / scoredGrades).toFixed(3)) : null,
      acceptanceCoverage: {
        covered: coveredCriteria,
        total: totalCriteria,
      },
      nonPass: nonPassGrades.slice(0, 20),
    },
    compares: {
      total: artifacts.compares.length,
      byVerdict: compareByVerdict,
      failingSignals: failingSignals.slice(0, 20),
    },
    analyses: {
      total: artifacts.analyses.length,
      clusters: clusters.length,
      byClassification: clusterByClassification,
      topClusters: clusters.slice(0, 10),
      maintenanceCommands: maintenanceCommands.slice(0, 10),
      deltaDraftCommands: deltaDraftCommands.slice(0, 10),
    },
    selfImprovement,
    skippedFiles: artifacts.skippedFiles,
    nextActions: [],
  };
  payload.nextActions = evalDigestNextActions(payload);
  return payload;
}

function evalDigestNextActions(payload) {
  const actions = [];
  if (payload.files.grades + payload.files.analyses + payload.files.compares === 0) {
    actions.push(`Generate eval artifacts first: node .plan2agent/scripts/p2a.mjs eval generate --output ${shellQuote(payload.evalDir)}`);
  }
  if (payload.grades.nonPass.length) {
    actions.push('Review non-pass eval grades and add missing verification evidence or fixes before marking related tasks done.');
  }
  if (payload.compares.failingSignals.length) {
    actions.push('Review compare regression signals before promoting the candidate run set.');
  }
  if (payload.analyses.maintenanceCommands.length) {
    actions.push(`Create the top maintenance candidate: ${payload.analyses.maintenanceCommands[0]}`);
  }
  if (payload.analyses.deltaDraftCommands.length) {
    actions.push(`Open a delta iteration for scope-changing findings: ${payload.analyses.deltaDraftCommands[0]}`);
  }
  if (payload.selfImprovement?.runs?.failureEvidence?.incomplete > 0) {
    actions.push('Complete missing reproduction/localization/guard evidence for failed or blocked runs before mining more improvements.');
  }
  if (payload.selfImprovement?.recurringFailures?.clusters > 0) {
    actions.push('Review recurring failure clusters; repeated classifications should become proposal or maintenance follow-up work.');
  }
  if (payload.selfImprovement?.proposals?.pendingReview > 0) {
    actions.push('Review pending proposal candidates and approve, reject, or defer them before measuring conversion.');
  }
  if (payload.selfImprovement?.maintenance?.pendingConversions > 0) {
    actions.push('Convert approved proposal signals into maintenance tasks, or record why conversion is intentionally deferred.');
  }
  if (payload.selfImprovement?.maintenance?.postMaintenanceVerification?.failed > 0) {
    actions.push('Inspect failed post-maintenance verification runs before treating the improvement as effective.');
  }
  if (!actions.length) actions.push('No immediate eval follow-up required from generated artifacts.');
  return actions;
}

function printEvalDigest(payload, writeResult) {
  console.log('Plan2Agent eval digest');
  console.log(`- eval: ${payload.evalDir}`);
  console.log(`- files: grades=${payload.files.grades} analyses=${payload.files.analyses} compares=${payload.files.compares} digests=${payload.files.digests} applyReports=${payload.files.applyReports} skipped=${payload.files.skipped}`);
  console.log(`- grades: total=${payload.grades.total} byVerdict=${JSON.stringify(payload.grades.byVerdict)} averageScore=${payload.grades.averageScore ?? 'n/a'}`);
  console.log(`- acceptance: ${payload.grades.acceptanceCoverage.covered}/${payload.grades.acceptanceCoverage.total} covered`);
  console.log(`- compare: total=${payload.compares.total} byVerdict=${JSON.stringify(payload.compares.byVerdict)} failingSignals=${payload.compares.failingSignals.length}`);
  console.log(`- analysis: total=${payload.analyses.total} clusters=${payload.analyses.clusters} byClassification=${JSON.stringify(payload.analyses.byClassification)}`);
  console.log(`- self-improvement: runs=${payload.selfImprovement.runs.total} failedOrBlocked=${payload.selfImprovement.runs.failedOrBlocked} proposals=${payload.selfImprovement.proposals.total} approved=${payload.selfImprovement.proposals.approved} recurringFailures=${payload.selfImprovement.recurringFailures.clusters}`);
  console.log(`- failure evidence: complete=${payload.selfImprovement.runs.failureEvidence.complete}/${payload.selfImprovement.runs.failureEvidence.required} rate=${percentLabel(payload.selfImprovement.runs.failureEvidence.completeRate)}`);
  console.log(`- maintenance conversion: converted=${payload.selfImprovement.maintenance.convertedApprovals}/${payload.selfImprovement.maintenance.approvedProposalSignals} rate=${percentLabel(payload.selfImprovement.maintenance.conversionRate)}`);
  console.log(`- post-maintenance verification: passed=${payload.selfImprovement.maintenance.postMaintenanceVerification.passed}/${payload.selfImprovement.maintenance.postMaintenanceVerification.total} rate=${percentLabel(payload.selfImprovement.maintenance.postMaintenanceVerification.successRate)}`);
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
  const source = loadAnalyzeSource(args);
  const payload = buildAnalyzeForSource(source, args.proposals);
  let applyResult = null;
  if (args.maintenanceDraft || args.applyMaintenance) {
    const draft = buildMaintenanceDraft(source, payload);
    const draftWriteResult = writeMaintenanceDraftIfRequested(args, draft);
    applyResult = args.applyMaintenance ? applyMaintenanceDraft(source, draft, args) : null;
    payload.maintenanceDraft = {
      ...draft,
      outputPath: draftWriteResult.filePath ? displayPath(draftWriteResult.filePath) : null,
      wrote: draftWriteResult.wrote,
      dryRun: args.dryRun,
      applyResult,
    };
  }
  const writeResult = writeOutputIfRequested(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printAnalyze(payload, writeResult);
  return applyResult?.status === 'failed' ? 1 : 0;
}

function runGenerate(args) {
  const payload = buildGenerate(args);
  const writeResult = writeGenerateOutputs(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printGenerate(payload, writeResult, args.dryRun);
  return 0;
}

function runEvalDigest(args) {
  const payload = buildEvalDigest(args);
  const writeResult = writeOutputIfRequested(args, payload);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printEvalDigest(payload, writeResult);
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
  if (args.command === 'generate') return runGenerate(args);
  if (args.command === 'digest') return runEvalDigest(args);
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
