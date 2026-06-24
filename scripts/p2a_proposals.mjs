#!/usr/bin/env node
/** Mine and review Plan2Agent retrospective proposal candidates from run logs. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadJson,
  validateOrchestrationPlanData,
  validateProposalsDir,
  validateRunData,
  validateRunIndexData,
  validateProposalReviewData,
  validateSkillProposal,
  validateSkillProposalData,
  ValidationError,
} from './validate_artifacts.mjs';
import { DEFAULT_RUNS_DIR, resolveRunsDir } from './p2a_run_paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const COMMANDS = new Set(['mine', 'list', 'show', 'validate', 'digest', 'review']);
const DEFAULT_PROPOSALS_DIR = path.join('.plan2agent', 'proposals');
const DEFAULT_HANDOFF_GRAPH = path.join('.plan2agent', 'artifacts', 'task-graph.json');

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_proposals.mjs mine (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>] [--proposals <dir>] [--dry-run] [--overwrite] [--json]',
    '  node scripts/p2a_proposals.mjs list [--proposals <dir>] [--json]',
    '  node scripts/p2a_proposals.mjs show (--proposal <path>|--proposal-id <id>) [--proposals <dir>]',
    '  node scripts/p2a_proposals.mjs validate [--proposal <path>|--proposals <dir>]',
    '  node scripts/p2a_proposals.mjs digest [--proposals <dir>] [--json]',
    '  node scripts/p2a_proposals.mjs review [--proposals <dir>] [--output <path>] [--dry-run] [--overwrite] [--json]',
    '',
    'Commands:',
    '  mine       Read run logs and orchestration sidecars, then write proposed skill-proposal JSON files.',
    '  list       List proposal queue entries.',
    '  show       Print one proposal JSON.',
    '  validate   Validate one proposal or a proposal directory.',
    '  digest     Print a compact review digest for human/curator review.',
    '  review     Group proposals and write a deterministic curator review artifact.',
    '',
    'Source options:',
    '  --artifacts <dir>   Iterative artifact root; reads runs/ and writes proposals/ under that root by default.',
    '  --graph <path>      Task graph JSON path; default runs path is beside the graph parent.',
    '  --runs <dir>        Explicit runs directory.',
    '  --proposals <dir>   Proposal queue directory. Default: sibling proposals/ beside runs/, or .plan2agent/proposals.',
    '  --output <path>     Review output path. Default: proposals/reviews/<reviewId>.json.',
    '  --run-id <run-id>   Limit mine to one run.',
    '',
    '  --dry-run           Print candidates without writing files.',
    '  --overwrite         Replace an existing proposal file with the same proposalId.',
    '  --json              Machine-readable output for mine/list/digest/review.',
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
    proposals: null,
    proposal: null,
    proposalId: null,
    output: null,
    runId: null,
    dryRun: false,
    overwrite: false,
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--runs') args.runs = requiredValue(argv, ++index, '--runs');
    else if (arg === '--proposals') args.proposals = requiredValue(argv, ++index, '--proposals');
    else if (arg === '--proposal') args.proposal = requiredValue(argv, ++index, '--proposal');
    else if (arg === '--proposal-id') args.proposalId = requiredValue(argv, ++index, '--proposal-id');
    else if (arg === '--output') args.output = requiredValue(argv, ++index, '--output');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--overwrite') args.overwrite = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  const sourceCount = [args.artifacts, args.graph, args.runs].filter(Boolean).length;
  if (sourceCount > 1) throw new Error('--artifacts, --graph, and --runs cannot be combined');
  if (args.command === 'mine' && sourceCount === 0) {
    if (existsSync(DEFAULT_HANDOFF_GRAPH)) args.graph = DEFAULT_HANDOFF_GRAPH;
    else if (existsSync(DEFAULT_RUNS_DIR)) args.runs = DEFAULT_RUNS_DIR;
    else throw new Error('--artifacts, --graph, or --runs is required for mine');
  }
  if (args.command === 'show' && [args.proposal, args.proposalId].filter(Boolean).length !== 1) {
    throw new Error('show requires exactly one of --proposal or --proposal-id');
  }
  if (args.command === 'validate') {
    if (args.proposalId) throw new Error('validate supports --proposal or --proposals, not --proposal-id');
    if (args.proposal && args.proposals) throw new Error('validate supports --proposal or --proposals, not both');
  }
  if (args.output && args.command !== 'review') throw new Error('--output is only supported by review');
  if (args.runId) assertSafeRunId(args.runId);
  return args;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function assertSafeRunId(runId) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runId ?? '')) {
    throw new Error(`run id must match run-[A-Za-z0-9._-]+, got ${JSON.stringify(runId)}`);
  }
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} must be a file: ${filePath}`);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath, root = process.cwd()) {
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return normalizePath(filePath);
}

function resolveRunsDirForProposals(args) {
  return resolveRunsDir(args);
}

function resolveProposalDir(args) {
  if (args.proposals) return path.resolve(args.proposals);
  if (args.artifacts || args.graph || args.runs) return path.join(path.dirname(resolveRunsDirForProposals(args)), 'proposals');
  return path.resolve(DEFAULT_PROPOSALS_DIR);
}

function runPath(runsDir, runId) {
  assertSafeRunId(runId);
  return path.join(runsDir, `${runId}.json`);
}

function runIndexPath(runsDir) {
  return path.join(runsDir, 'run-index.json');
}

function orchestrationSidecarPath(runsDir, runId) {
  assertSafeRunId(runId);
  return path.join(runsDir, `${runId}.orchestration.json`);
}

function proposalPath(proposalsDir, proposalId) {
  return path.join(proposalsDir, `${proposalId}.json`);
}

function readRun(runsDir, runId) {
  const filePath = runPath(runsDir, runId);
  assertFile(filePath, runId);
  return validateRunData(loadJson(filePath));
}

function readRuns(runsDir, runId = null) {
  if (runId) return [readRun(runsDir, runId)];
  const indexFile = runIndexPath(runsDir);
  if (!existsSync(indexFile)) return [];
  const index = validateRunIndexData(loadJson(indexFile));
  return index.runs
    .map((entry) => readRun(runsDir, entry.runId));
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function readRunForMining(runsDir, runId) {
  try {
    return { run: readRun(runsDir, runId), skipped: null };
  } catch (error) {
    return { run: null, skipped: { runId, reason: errorMessage(error) } };
  }
}

function readRunsForMining(runsDir, runId = null) {
  if (runId) {
    const result = readRunForMining(runsDir, runId);
    return {
      runs: result.run ? [result.run] : [],
      skippedRuns: result.skipped ? [result.skipped] : [],
      totalRunRefs: 1,
    };
  }
  const indexFile = runIndexPath(runsDir);
  if (!existsSync(indexFile)) return { runs: [], skippedRuns: [], totalRunRefs: 0 };
  const index = validateRunIndexData(loadJson(indexFile));
  const runs = [];
  const skippedRuns = [];
  for (const entry of index.runs) {
    const result = readRunForMining(runsDir, entry.runId);
    if (result.run) runs.push(result.run);
    else skippedRuns.push(result.skipped);
  }
  return { runs, skippedRuns, totalRunRefs: index.runs.length };
}

function readSidecar(runsDir, runId) {
  const filePath = orchestrationSidecarPath(runsDir, runId);
  if (!existsSync(filePath)) return null;
  return validateOrchestrationPlanData(loadJson(filePath));
}

function readSidecarForMining(runsDir, runId) {
  try {
    return { sidecar: readSidecar(runsDir, runId), warning: null };
  } catch (error) {
    return {
      sidecar: null,
      warning: {
        runId,
        reason: `orchestration sidecar ignored: ${errorMessage(error)}`,
      },
    };
  }
}

function readMonitorVerdict(runsDir, sidecar) {
  if (!sidecar?.monitorGate?.required || !sidecar.monitorGate.verdictPath) return null;
  const verdictPath = path.resolve(runsDir, sidecar.monitorGate.verdictPath);
  if (!existsSync(verdictPath)) return null;
  const data = loadJson(verdictPath);
  const verdict = typeof data === 'string' ? data : data?.verdict;
  return typeof verdict === 'string' && verdict.trim() ? verdict.trim() : null;
}

function readMonitorVerdictForMining(runsDir, runId, sidecar) {
  try {
    return { verdict: readMonitorVerdict(runsDir, sidecar), warning: null };
  } catch (error) {
    return {
      verdict: null,
      warning: {
        runId,
        reason: `monitor verdict ignored: ${errorMessage(error)}`,
      },
    };
  }
}

function safeIdPart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function failedVerificationEvidence(run) {
  return run.verification
    .filter((item) => item.status === 'failed')
    .map((item) => `failed verification: ${item.type} (${item.command})`);
}

function targetFilesForFailure(failureClass) {
  const common = ['.agents/skills/p2a-dev-execution/SKILL.md', 'docs/cli-reference.md'];
  if (failureClass === 'scope_violation') return ['.agents/agents/p2a-implementer.md', '.agents/skills/p2a-dev-execution/SKILL.md'];
  if (failureClass === 'missing_dependency') return ['.agents/skills/p2a-harness/SKILL.md', '.agents/skills/p2a-dev-execution/SKILL.md'];
  if (failureClass === 'implementation_incomplete') return ['.agents/agents/p2a-performance-monitor.md', '.agents/skills/p2a-dev-execution/SKILL.md'];
  if (failureClass === 'environment_failure') return ['docs/quickstart.md', 'docs/cli-reference.md'];
  return common;
}

function riskForFailure(failureClass) {
  if (failureClass === 'scope_violation' || failureClass === 'missing_dependency') return 'high';
  if (failureClass === 'environment_failure' || failureClass === 'test_flake') return 'low';
  return 'medium';
}

function failureRecommendation(failureClass) {
  const recommendations = {
    verification_failed: 'Clarify verification setup or execution guidance so future runs fail earlier with actionable checks.',
    test_flake: 'Document flaky-test handling and retry evidence requirements for future supervised runs.',
    scope_violation: 'Tighten implementer scope boundaries and owner review prompts before future task execution.',
    missing_dependency: 'Capture missing dependency or user-decision prerequisites before starting implementation runs.',
    environment_failure: 'Document environment prerequisites or fallback checks needed before executing similar tasks.',
    implementation_incomplete: 'Strengthen acceptance-coverage and monitor-gate prompts so incomplete implementations are caught earlier.',
    other: 'Classify this failure pattern more specifically after curator review.',
  };
  return recommendations[failureClass] ?? recommendations.other;
}

function buildFailureProposal(run, sidecar, verdict) {
  if (!['failed', 'blocked'].includes(run.status) || !run.failure) return null;
  const evidence = [
    `runId: ${run.runId}`,
    `task: ${run.taskId} - ${run.taskTitle}`,
    `failure: ${run.failure.class} retryable=${run.failure.retryable} needsUserDecision=${run.failure.needsUserDecision} source=${run.failure.source}`,
    ...failedVerificationEvidence(run),
  ];
  if (sidecar) evidence.push(`orchestration: ${sidecar.mode} ${sidecar.planId}`);
  if (verdict) evidence.push(`monitor verdict: ${verdict}`);
  const proposal = {
    schema_version: 'p2a.skill_proposal.v1',
    proposalId: `proposal-${safeIdPart(run.runId)}-${safeIdPart(run.failure.class)}`,
    sourceRunId: run.runId,
    problem: `Run ${run.runId} ended ${run.status} with ${run.failure.class}.`,
    evidence,
    recommendedChange: failureRecommendation(run.failure.class),
    targetFiles: targetFilesForFailure(run.failure.class),
    risk: riskForFailure(run.failure.class),
    status: 'proposed',
    note: 'Generated by p2a_proposals.mjs from run failure metadata.',
  };
  return validateSkillProposalData(proposal);
}

function buildVerificationGapProposal(run) {
  if (run.status !== 'finished' || run.verification.length > 0) return null;
  const proposal = {
    schema_version: 'p2a.skill_proposal.v1',
    proposalId: `proposal-${safeIdPart(run.runId)}-verification-gap`,
    sourceRunId: run.runId,
    problem: `Run ${run.runId} finished without recorded verification.`,
    evidence: [
      `runId: ${run.runId}`,
      `task: ${run.taskId} - ${run.taskTitle}`,
      `changedFiles: ${run.changedFiles.length}`,
      'verification: none recorded',
    ],
    recommendedChange: 'Require an explicit verification command, skipped-verification rationale, or owner note before closing comparable runs.',
    targetFiles: ['.agents/skills/p2a-dev-execution/SKILL.md', 'scripts/p2a_execute.mjs', 'docs/cli-reference.md'],
    risk: 'medium',
    status: 'proposed',
    note: 'Generated by p2a_proposals.mjs from a finished run with no verification evidence.',
  };
  return validateSkillProposalData(proposal);
}

function buildMonitorProposal(run, sidecar, verdict) {
  if (!sidecar?.monitorGate?.required || !verdict || sidecar.monitorGate.acceptedVerdicts.includes(verdict)) return null;
  if (run.failure?.source === 'monitor') return null;
  const proposal = {
    schema_version: 'p2a.skill_proposal.v1',
    proposalId: `proposal-${safeIdPart(run.runId)}-monitor-${safeIdPart(verdict)}`,
    sourceRunId: run.runId,
    problem: `Monitor gate returned ${verdict} for run ${run.runId} but the run was not closed by monitor failure metadata.`,
    evidence: [
      `runId: ${run.runId}`,
      `task: ${run.taskId} - ${run.taskTitle}`,
      `orchestration: ${sidecar.mode} ${sidecar.planId}`,
      `monitor verdict: ${verdict}`,
    ],
    recommendedChange: 'Review monitor gate closeout handling so rejected verdicts consistently map to blocked run metadata.',
    targetFiles: ['scripts/p2a_execute.mjs', '.agents/agents/p2a-performance-monitor.md'],
    risk: 'medium',
    status: 'proposed',
    note: 'Generated by p2a_proposals.mjs from orchestration sidecar monitor evidence.',
  };
  return validateSkillProposalData(proposal);
}

function proposalsForRun(runsDir, run) {
  const warnings = [];
  const sidecarResult = readSidecarForMining(runsDir, run.runId);
  if (sidecarResult.warning) warnings.push(sidecarResult.warning);
  const sidecar = sidecarResult.sidecar;
  const verdictResult = readMonitorVerdictForMining(runsDir, run.runId, sidecar);
  if (verdictResult.warning) warnings.push(verdictResult.warning);
  const verdict = verdictResult.verdict;
  return {
    proposals: [
      buildFailureProposal(run, sidecar, verdict),
      buildVerificationGapProposal(run),
      buildMonitorProposal(run, sidecar, verdict),
    ].filter(Boolean),
    warnings,
  };
}

function uniqueByProposalId(proposals) {
  const byId = new Map();
  for (const proposal of proposals) {
    if (!byId.has(proposal.proposalId)) byId.set(proposal.proposalId, proposal);
  }
  return [...byId.values()];
}

function writeProposal(proposalsDir, proposal, overwrite = false) {
  const filePath = proposalPath(proposalsDir, proposal.proposalId);
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(proposalsDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  return { action: existed ? 'overwritten' : 'written', filePath };
}

function proposalFiles(proposalsDir) {
  if (!existsSync(proposalsDir)) return [];
  if (!lstatSync(proposalsDir).isDirectory()) throw new Error(`proposals path must be a directory: ${proposalsDir}`);
  return readdirSync(proposalsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => path.join(proposalsDir, entry));
}

function loadProposals(proposalsDir) {
  return proposalFiles(proposalsDir)
    .map((filePath) => validateSkillProposal(filePath));
}

function digestForProposals(proposals) {
  const byStatus = {};
  const byRisk = {};
  const bySourceRun = {};
  for (const proposal of proposals) {
    byStatus[proposal.status] = (byStatus[proposal.status] ?? 0) + 1;
    byRisk[proposal.risk] = (byRisk[proposal.risk] ?? 0) + 1;
    if (proposal.sourceRunId) bySourceRun[proposal.sourceRunId] = (bySourceRun[proposal.sourceRunId] ?? 0) + 1;
  }
  const priority = { high: 0, medium: 1, low: 2 };
  return {
    total: proposals.length,
    byStatus,
    byRisk,
    sourceRunCount: Object.keys(bySourceRun).length,
    proposed: proposals
      .filter((proposal) => proposal.status === 'proposed')
      .sort((a, b) => (priority[a.risk] ?? 9) - (priority[b.risk] ?? 9) || a.proposalId.localeCompare(b.proposalId))
      .map((proposal) => ({
        proposalId: proposal.proposalId,
        risk: proposal.risk,
        sourceRunId: proposal.sourceRunId ?? null,
        problem: proposal.problem,
      })),
  };
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function emptyStatusSummary() {
  return { proposed: 0, approved: 0, rejected: 0, deferred: 0 };
}

function emptyRiskSummary() {
  return { high: 0, medium: 0, low: 0 };
}

function emptyDispositionSummary() {
  return { approve: 0, defer: 0, reject: 0, needs_more_evidence: 0 };
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))].sort((a, b) => a.localeCompare(b));
}

function highestRisk(proposals) {
  if (proposals.some((proposal) => proposal.risk === 'high')) return 'high';
  if (proposals.some((proposal) => proposal.risk === 'medium')) return 'medium';
  return 'low';
}

function proposalClassification(proposal) {
  const failureEvidence = (proposal.evidence ?? []).find((item) => item.startsWith('failure: '));
  if (failureEvidence) {
    const match = failureEvidence.match(/^failure:\s+([A-Za-z0-9._-]+)/);
    if (match) return match[1];
  }
  if (proposal.proposalId.includes('verification-gap')) return 'verification_gap';
  if (proposal.proposalId.includes('-monitor-')) return 'monitor_gate_mismatch';
  return safeIdPart(proposal.problem);
}

function proposalGroupKey(proposal) {
  return [
    proposalClassification(proposal),
    sortedUnique(proposal.targetFiles).join(','),
    proposal.recommendedChange,
  ].join('|');
}

function statusSummaryFor(proposals) {
  const summary = emptyStatusSummary();
  for (const proposal of proposals) summary[proposal.status] += 1;
  return summary;
}

function dispositionForGroup(group) {
  if (group.statusSummary.proposed === 0) {
    return {
      recommendedDisposition: 'defer',
      rationale: 'No proposed items remain in this group.',
      nextAction: 'Keep the group for audit history; no immediate action is required.',
    };
  }
  if (group.classification === 'verification_gap') {
    return {
      recommendedDisposition: 'needs_more_evidence',
      rationale: 'Verification-gap proposals can include valid docs/config-only work until skipped-verification rationale is standardized.',
      nextAction: 'Ask the owner whether verification was intentionally skipped before approving a harness change.',
    };
  }
  if (group.risk === 'high' || group.frequency >= 2) {
    return {
      recommendedDisposition: 'approve',
      rationale: group.risk === 'high'
        ? 'High-risk execution pattern should be reviewed for a corrective harness change.'
        : `This pattern appears ${group.frequency} times and is likely worth a corrective harness change.`,
      nextAction: 'Review targetFiles and prepare a separate patch only after human approval.',
    };
  }
  return {
    recommendedDisposition: 'defer',
    rationale: 'Single medium/low-risk proposal should remain in the queue until more evidence appears.',
    nextAction: 'Keep the proposal queued and re-run review after more execution history is available.',
  };
}

function buildProposalReview(proposals, proposalsDir, generatedAt = new Date().toISOString()) {
  const sorted = [...proposals].sort((a, b) => a.proposalId.localeCompare(b.proposalId));
  const groupsByKey = new Map();
  for (const proposal of sorted) {
    const key = proposalGroupKey(proposal);
    if (!groupsByKey.has(key)) groupsByKey.set(key, []);
    groupsByKey.get(key).push(proposal);
  }

  const groups = [...groupsByKey.entries()].map(([key, groupProposals]) => {
    const proposalIds = groupProposals.map((proposal) => proposal.proposalId).sort((a, b) => a.localeCompare(b));
    const group = {
      groupId: `group-${stableHash({ key, proposalIds })}`,
      proposalIds,
      risk: highestRisk(groupProposals),
      frequency: groupProposals.length,
      classification: proposalClassification(groupProposals[0]),
      targetFiles: sortedUnique(groupProposals.flatMap((proposal) => proposal.targetFiles)),
      sourceRunIds: sortedUnique(groupProposals.map((proposal) => proposal.sourceRunId).filter(Boolean)),
      statusSummary: statusSummaryFor(groupProposals),
      recommendedDisposition: 'defer',
      rationale: 'Pending review.',
      nextAction: 'Pending review.',
    };
    return { ...group, ...dispositionForGroup(group) };
  }).sort((a, b) => {
    const dispositionPriority = { approve: 0, needs_more_evidence: 1, defer: 2, reject: 3 };
    const riskPriority = { high: 0, medium: 1, low: 2 };
    return (dispositionPriority[a.recommendedDisposition] ?? 9) - (dispositionPriority[b.recommendedDisposition] ?? 9)
      || (riskPriority[a.risk] ?? 9) - (riskPriority[b.risk] ?? 9)
      || b.frequency - a.frequency
      || a.groupId.localeCompare(b.groupId);
  });

  const byStatus = emptyStatusSummary();
  const byRisk = emptyRiskSummary();
  for (const proposal of sorted) {
    byStatus[proposal.status] += 1;
    byRisk[proposal.risk] += 1;
  }
  const byRecommendedDisposition = emptyDispositionSummary();
  for (const group of groups) byRecommendedDisposition[group.recommendedDisposition] += 1;

  const reviewId = `proposal-review-${stableHash({
    proposals: sorted.map((proposal) => ({
      proposalId: proposal.proposalId,
      status: proposal.status,
      risk: proposal.risk,
      sourceRunId: proposal.sourceRunId ?? null,
      targetFiles: sortedUnique(proposal.targetFiles),
      recommendedChange: proposal.recommendedChange,
    })),
    groups: groups.map((group) => ({
      groupId: group.groupId,
      recommendedDisposition: group.recommendedDisposition,
    })),
  })}`;

  return validateProposalReviewData({
    schema_version: 'p2a.proposal_review.v1',
    reviewId,
    generatedAt,
    sourceProposalsDir: displayPath(proposalsDir),
    summary: {
      totalProposals: sorted.length,
      totalGroups: groups.length,
      byStatus,
      byRisk,
      byRecommendedDisposition,
    },
    groups,
  });
}

function reviewPath(proposalsDir, reviewId) {
  return path.join(proposalsDir, 'reviews', `${reviewId}.json`);
}

function assertReviewOutputPath(proposalsDir, filePath) {
  if (path.dirname(path.resolve(filePath)) === path.resolve(proposalsDir)) {
    throw new Error('--output must not write a review JSON directly inside the proposal queue root; use proposals/reviews/ or another directory');
  }
}

function writeReview(filePath, review, overwrite = false) {
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  return { action: existed ? 'overwritten' : 'written', filePath };
}

function runMine(args) {
  const runsDir = resolveRunsDirForProposals(args);
  const proposalsDir = resolveProposalDir(args);
  const runScan = readRunsForMining(runsDir, args.runId);
  const proposalScan = runScan.runs.map((run) => proposalsForRun(runsDir, run));
  const warnings = proposalScan.flatMap((result) => result.warnings);
  const candidates = uniqueByProposalId(proposalScan.flatMap((result) => result.proposals));
  const results = candidates.map((proposal) => {
    if (args.dryRun) return { proposal, action: 'dry-run', filePath: proposalPath(proposalsDir, proposal.proposalId) };
    const writeResult = writeProposal(proposalsDir, proposal, args.overwrite);
    return { proposal, ...writeResult };
  });
  if (args.json) {
    console.log(JSON.stringify({
      runsDir: displayPath(runsDir),
      proposalsDir: displayPath(proposalsDir),
      runsScanned: runScan.totalRunRefs,
      runsUsable: runScan.runs.length,
      skippedRuns: runScan.skippedRuns,
      warnings,
      candidates: results.map((result) => ({
        proposalId: result.proposal.proposalId,
        sourceRunId: result.proposal.sourceRunId,
        risk: result.proposal.risk,
        action: result.action,
        filePath: displayPath(result.filePath),
      })),
    }, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal mining');
  console.log(`- runs: ${displayPath(runsDir)}`);
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- runs scanned: ${runScan.totalRunRefs}`);
  console.log(`- runs usable: ${runScan.runs.length}`);
  if (runScan.skippedRuns.length) console.log(`- skipped runs: ${runScan.skippedRuns.length}`);
  if (warnings.length) console.log(`- warnings: ${warnings.length}`);
  console.log(`- candidates: ${results.length}`);
  for (const skipped of runScan.skippedRuns) {
    console.warn(`warning: skipped run ${skipped.runId}: ${skipped.reason}`);
  }
  for (const warning of warnings) {
    console.warn(`warning: ${warning.runId}: ${warning.reason}`);
  }
  for (const result of results) {
    console.log(`- ${result.action}: ${result.proposal.proposalId} -> ${displayPath(result.filePath)}`);
  }
  return 0;
}

function runReview(args) {
  const proposalsDir = resolveProposalDir(args);
  const requestedFilePath = args.output ? path.resolve(args.output) : null;
  if (requestedFilePath) assertReviewOutputPath(proposalsDir, requestedFilePath);
  const proposals = loadProposals(proposalsDir);
  const review = buildProposalReview(proposals, proposalsDir);
  const filePath = requestedFilePath ?? reviewPath(proposalsDir, review.reviewId);
  const writeResult = args.dryRun
    ? { action: 'dry-run', filePath }
    : writeReview(filePath, review, args.overwrite);
  if (args.json) {
    console.log(JSON.stringify({
      proposalsDir: displayPath(proposalsDir),
      reviewFile: displayPath(filePath),
      action: writeResult.action,
      review,
    }, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal review');
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- review: ${displayPath(filePath)}`);
  console.log(`- action: ${writeResult.action}`);
  console.log(`- proposals total: ${review.summary.totalProposals}`);
  console.log(`- groups total: ${review.summary.totalGroups}`);
  console.log(`- dispositions: ${JSON.stringify(review.summary.byRecommendedDisposition)}`);
  for (const group of review.groups) {
    console.log(`- ${group.groupId} [${group.risk} x${group.frequency}] ${group.recommendedDisposition}: ${group.classification}`);
  }
  return 0;
}

function runList(args) {
  const proposalsDir = resolveProposalDir(args);
  const proposals = loadProposals(proposalsDir);
  if (args.json) {
    console.log(JSON.stringify(proposals, null, 2));
    return 0;
  }
  console.log('proposalId\tstatus\trisk\tsourceRunId\tproblem');
  for (const proposal of proposals) {
    console.log(`${proposal.proposalId}\t${proposal.status}\t${proposal.risk}\t${proposal.sourceRunId ?? '-'}\t${proposal.problem}`);
  }
  return 0;
}

function runShow(args) {
  const filePath = args.proposal ? path.resolve(args.proposal) : proposalPath(resolveProposalDir(args), args.proposalId);
  const proposal = validateSkillProposal(filePath);
  console.log(JSON.stringify(proposal, null, 2));
  return 0;
}

function runValidate(args) {
  if (args.proposal) {
    const proposal = validateSkillProposal(path.resolve(args.proposal));
    console.log(`Plan2Agent proposal validation passed: ${proposal.proposalId}`);
    return 0;
  }
  const proposalsDir = resolveProposalDir(args);
  const proposals = validateProposalsDir(proposalsDir);
  console.log(`Plan2Agent proposals validation passed: ${displayPath(proposalsDir)} (${proposals.length})`);
  return 0;
}

function runDigest(args) {
  const proposalsDir = resolveProposalDir(args);
  const proposals = loadProposals(proposalsDir);
  const digest = digestForProposals(proposals);
  if (args.json) {
    console.log(JSON.stringify(digest, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal digest');
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- total: ${digest.total}`);
  console.log(`- byStatus: ${JSON.stringify(digest.byStatus)}`);
  console.log(`- byRisk: ${JSON.stringify(digest.byRisk)}`);
  console.log(`- sourceRuns: ${digest.sourceRunCount}`);
  console.log('Proposed queue:');
  for (const item of digest.proposed) {
    console.log(`- ${item.proposalId} [${item.risk}] ${item.problem}`);
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'mine') return runMine(args);
    if (args.command === 'list') return runList(args);
    if (args.command === 'show') return runShow(args);
    if (args.command === 'validate') return runValidate(args);
    if (args.command === 'digest') return runDigest(args);
    if (args.command === 'review') return runReview(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'p2a proposal validation failed' : 'p2a proposal command failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(__filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
