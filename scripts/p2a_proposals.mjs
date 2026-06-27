#!/usr/bin/env node
/** Mine and review Plan2Agent retrospective proposal candidates from run logs. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadJson,
  validateOrchestrationPlanData,
  validateProposalsDir,
  validateRunData,
  validateRunIndexData,
  validateProposalPatchDraftData,
  validateProposalDraftApprovalData,
  validateProposalCurationData,
  validateProposalReviewData,
  validateSkillProposal,
  validateSkillProposalData,
  validateTaskGraphData,
  ValidationError,
} from './validate_artifacts.mjs';
import { DEFAULT_RUNS_DIR, resolveRunsDir } from './p2a_run_paths.mjs';
import { configuredTaskGraphPath, resolveP2aPaths, singleArtifactProjectRoot } from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const COMMANDS = new Set(['mine', 'list', 'show', 'validate', 'digest', 'review', 'curate', 'draft-patch', 'approve-draft']);
const DEFAULT_PROPOSALS_DIR = path.join('.plan2agent', 'proposals');

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_proposals.mjs mine (--artifacts <dir>|--runs <dir>|--graph <path>) [--run-id <run-id>] [--proposals <dir>] [--dry-run] [--overwrite] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs list [--proposals <dir>] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs show (--proposal <path>|--proposal-id <id>) [--proposals <dir>]',
    '  node .plan2agent/scripts/p2a_proposals.mjs validate [--proposal <path>|--proposals <dir>]',
    '  node .plan2agent/scripts/p2a_proposals.mjs digest [--proposals <dir>] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs review [--proposals <dir>] [--output <path>] [--dry-run] [--overwrite] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs curate --review <path> [--proposals <dir>] [--output <path>] [--dry-run] [--overwrite] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs draft-patch --curation <path> [--candidate-id <id>] [--proposals <dir>] [--output <path>] [--dry-run] [--overwrite] [--json]',
    '  node .plan2agent/scripts/p2a_proposals.mjs approve-draft --draft <path> --artifacts <iterative-project-dir> --approved-by <name> [--approval-note <text>] [--proposals <dir>] [--output <path>] [--dry-run] [--overwrite] [--json]',
    '',
    'Commands:',
    '  mine       Read run logs and orchestration sidecars, then write proposed skill-proposal JSON files.',
    '  list       List proposal queue entries.',
    '  show       Print one proposal JSON.',
    '  validate   Validate one proposal or a proposal directory.',
    '  digest     Print a compact review digest for human/curator review.',
    '  review     Group proposals and write a deterministic curator review artifact.',
    '  curate     Turn a proposal review into approval-ready improvement candidates.',
    '  draft-patch Create a non-applying patch draft for one curation candidate.',
    '  approve-draft Record human approval and append a maintenance task without applying files.',
    '',
    'Source options:',
    '  --artifacts <dir>   Iterative artifact root; reads runs/ and writes proposals/ under that root by default.',
    '  --graph <path>      Task graph JSON path; default runs path is beside the graph parent.',
    '  --runs <dir>        Explicit runs directory.',
    '  --proposals <dir>   Proposal queue directory. Default: sibling proposals/ beside runs/, or .plan2agent/proposals.',
    '  --review <path>     Proposal review JSON to curate.',
    '  --curation <path>   Proposal curation JSON to draft from.',
    '  --draft <path>      Proposal patch draft JSON to approve.',
    '  --candidate-id <id> Candidate id for draft-patch. Required when curation has multiple candidates.',
    '  --approved-by <name> Human approver recorded for approve-draft.',
    '  --approval-note <text> Optional approval note recorded for approve-draft.',
    '  --output <path>     Review/curation/patch-draft/approval output path.',
    '  --run-id <run-id>   Limit mine to one run.',
    '',
    '  --dry-run           Print candidates without writing files.',
    '  --overwrite         Replace an existing proposal file with the same proposalId.',
    '  --json              Machine-readable output for mine/list/digest/review/curate/draft-patch/approve-draft.',
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
    review: null,
    curation: null,
    draft: null,
    candidateId: null,
    approvedBy: null,
    approvalNote: null,
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
    else if (arg === '--review') args.review = requiredValue(argv, ++index, '--review');
    else if (arg === '--curation') args.curation = requiredValue(argv, ++index, '--curation');
    else if (arg === '--draft') args.draft = requiredValue(argv, ++index, '--draft');
    else if (arg === '--candidate-id') args.candidateId = requiredValue(argv, ++index, '--candidate-id');
    else if (arg === '--approved-by') args.approvedBy = requiredValue(argv, ++index, '--approved-by');
    else if (arg === '--approval-note') args.approvalNote = requiredValue(argv, ++index, '--approval-note');
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
    const defaultArtifacts = singleArtifactProjectRoot();
    const configuredGraph = configuredTaskGraphPath();
    if (defaultArtifacts) args.artifacts = defaultArtifacts;
    else if (configuredGraph) args.graph = configuredGraph;
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
  if (args.command === 'curate' && !args.review) throw new Error('curate requires --review');
  if (args.review && args.command !== 'curate') throw new Error('--review is only supported by curate');
  if (args.command === 'draft-patch' && !args.curation) throw new Error('draft-patch requires --curation');
  if (args.curation && args.command !== 'draft-patch') throw new Error('--curation is only supported by draft-patch');
  if (args.candidateId && args.command !== 'draft-patch') throw new Error('--candidate-id is only supported by draft-patch');
  if (args.command === 'approve-draft' && !args.draft) throw new Error('approve-draft requires --draft');
  if (args.command === 'approve-draft' && !args.artifacts) throw new Error('approve-draft requires --artifacts');
  if (args.command === 'approve-draft' && !args.approvedBy) throw new Error('approve-draft requires --approved-by');
  if (args.draft && args.command !== 'approve-draft') throw new Error('--draft is only supported by approve-draft');
  if (args.approvedBy && args.command !== 'approve-draft') throw new Error('--approved-by is only supported by approve-draft');
  if (args.approvalNote && args.command !== 'approve-draft') throw new Error('--approval-note is only supported by approve-draft');
  if (args.output && !['review', 'curate', 'draft-patch', 'approve-draft'].includes(args.command)) {
    throw new Error('--output is only supported by review, curate, draft-patch, or approve-draft');
  }
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

function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new Error(`${label} is missing: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new Error(`${label} must be a directory: ${dirPath}`);
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

function emptyReadinessSummary() {
  return { patch_candidate: 0, needs_evidence: 0, watch: 0, no_action: 0 };
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

function curationPath(proposalsDir, curationId) {
  return path.join(proposalsDir, 'curations', `${curationId}.json`);
}

function patchDraftPath(proposalsDir, draftId) {
  return path.join(proposalsDir, 'patch-drafts', `${draftId}.json`);
}

function approvalPath(proposalsDir, approvalId) {
  return path.join(proposalsDir, 'approvals', `${approvalId}.json`);
}

function assertReviewOutputPath(proposalsDir, filePath) {
  if (path.dirname(path.resolve(filePath)) === path.resolve(proposalsDir)) {
    throw new Error('--output must not write a review JSON directly inside the proposal queue root; use proposals/reviews/ or another directory');
  }
}

function assertCurationOutputPath(proposalsDir, filePath) {
  if (path.dirname(path.resolve(filePath)) === path.resolve(proposalsDir)) {
    throw new Error('--output must not write a curation JSON directly inside the proposal queue root; use proposals/curations/ or another directory');
  }
}

function assertPatchDraftOutputPath(proposalsDir, filePath) {
  if (path.dirname(path.resolve(filePath)) === path.resolve(proposalsDir)) {
    throw new Error('--output must not write a patch draft JSON directly inside the proposal queue root; use proposals/patch-drafts/ or another directory');
  }
}

function assertApprovalOutputPath(proposalsDir, filePath) {
  if (path.dirname(path.resolve(filePath)) === path.resolve(proposalsDir)) {
    throw new Error('--output must not write an approval JSON directly inside the proposal queue root; use proposals/approvals/ or another directory');
  }
}

function writeReview(filePath, review, overwrite = false) {
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  return { action: existed ? 'overwritten' : 'written', filePath };
}

function resolveProposalDirForCuration(args, reviewFilePath) {
  if (args.proposals) return path.resolve(args.proposals);
  const reviewDir = path.dirname(reviewFilePath);
  if (path.basename(reviewDir) === 'reviews') return path.dirname(reviewDir);
  return resolveProposalDir(args);
}

function proposalMapById(proposals) {
  return new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
}

function readinessForGroup(group) {
  if (group.recommendedDisposition === 'approve') return 'patch_candidate';
  if (group.recommendedDisposition === 'needs_more_evidence') return 'needs_evidence';
  if (group.recommendedDisposition === 'reject') return 'no_action';
  if (group.statusSummary.proposed === 0) return 'no_action';
  return 'watch';
}

function priorityForCandidate(group, readiness) {
  if (readiness === 'patch_candidate' && group.risk === 'high') return 'P0';
  if (readiness === 'patch_candidate' || group.frequency >= 2) return 'P1';
  if (readiness === 'needs_evidence') return 'P2';
  return 'P3';
}

function evidenceStrengthForGroup(group) {
  if (group.frequency >= 2 || group.sourceRunIds.length >= 2) return 'strong';
  if (group.sourceRunIds.length === 1) return 'medium';
  return 'weak';
}

function humanizeClassification(classification) {
  return classification.split(/[_-]+/).filter(Boolean).join(' ');
}

function representativeProposal(group, proposalsById) {
  return group.proposalIds
    .map((proposalId) => proposalsById.get(proposalId))
    .find(Boolean) ?? null;
}

function titleForCandidate(group) {
  return `Improve ${humanizeClassification(group.classification)} handling`;
}

function problemStatementForCandidate(group, representative) {
  if (representative?.problem) return representative.problem;
  return `${group.classification} appeared in ${group.frequency} proposal(s).`;
}

function recommendedChangeForCandidate(group, representative) {
  if (representative?.recommendedChange) return representative.recommendedChange;
  return group.nextAction;
}

function nextActionForCandidate(group, readiness) {
  if (readiness === 'patch_candidate') return 'Prepare a separate patch for human approval; do not apply automatically.';
  if (readiness === 'needs_evidence') return 'Collect owner rationale or additional run evidence before approving a patch.';
  if (readiness === 'no_action') return 'Keep the item for audit history; no immediate patch is recommended.';
  return group.nextAction;
}

function candidateForGroup(group, proposalsById) {
  const representative = representativeProposal(group, proposalsById);
  const readiness = readinessForGroup(group);
  const priority = priorityForCandidate(group, readiness);
  const evidenceStrength = evidenceStrengthForGroup(group);
  return {
    candidateId: `candidate-${stableHash({
      groupId: group.groupId,
      proposalIds: group.proposalIds,
      readiness,
      priority,
      disposition: group.recommendedDisposition,
    })}`,
    groupId: group.groupId,
    proposalIds: group.proposalIds,
    classification: group.classification,
    title: titleForCandidate(group),
    problemStatement: problemStatementForCandidate(group, representative),
    recommendedChange: recommendedChangeForCandidate(group, representative),
    recommendedDisposition: group.recommendedDisposition,
    readiness,
    priority,
    risk: group.risk,
    frequency: group.frequency,
    targetFiles: group.targetFiles,
    sourceRunIds: group.sourceRunIds,
    evidenceStrength,
    rationale: `${group.rationale} Evidence strength is ${evidenceStrength}.`,
    nextAction: nextActionForCandidate(group, readiness),
    separatePatchRequired: true,
  };
}

function buildProposalCuration(review, proposals, proposalsDir, reviewPathForDisplay, generatedAt = new Date().toISOString()) {
  const proposalsById = proposalMapById(proposals);
  const requiredProposalIds = sortedUnique(review.groups.flatMap((group) => group.proposalIds));
  const missingProposalIds = requiredProposalIds.filter((proposalId) => !proposalsById.has(proposalId));
  if (missingProposalIds.length) {
    throw new Error(`proposal review references missing proposal files: ${missingProposalIds.join(', ')}`);
  }
  const candidates = review.groups
    .map((group) => candidateForGroup(group, proposalsById))
    .sort((a, b) => {
      const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
      const readinessRank = { patch_candidate: 0, needs_evidence: 1, watch: 2, no_action: 3 };
      const riskRank = { high: 0, medium: 1, low: 2 };
      return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)
        || (readinessRank[a.readiness] ?? 9) - (readinessRank[b.readiness] ?? 9)
        || (riskRank[a.risk] ?? 9) - (riskRank[b.risk] ?? 9)
        || b.frequency - a.frequency
        || a.candidateId.localeCompare(b.candidateId);
    });

  const byReadiness = emptyReadinessSummary();
  const byRecommendedDisposition = emptyDispositionSummary();
  for (const candidate of candidates) {
    byReadiness[candidate.readiness] += 1;
    byRecommendedDisposition[candidate.recommendedDisposition] += 1;
  }

  const curationId = `proposal-curation-${stableHash({
    reviewId: review.reviewId,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      readiness: candidate.readiness,
      priority: candidate.priority,
      recommendedDisposition: candidate.recommendedDisposition,
    })),
  })}`;

  return validateProposalCurationData({
    schema_version: 'p2a.proposal_curation.v1',
    curationId,
    generatedAt,
    sourceReview: displayPath(reviewPathForDisplay),
    sourceProposalsDir: displayPath(proposalsDir),
    summary: {
      totalCandidates: candidates.length,
      byReadiness,
      byRecommendedDisposition,
    },
    candidates,
  });
}

function writeCuration(filePath, curation, overwrite = false) {
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(curation, null, 2)}\n`, 'utf8');
  return { action: existed ? 'overwritten' : 'written', filePath };
}

function resolveProposalDirForPatchDraft(args, curationFilePath) {
  if (args.proposals) return path.resolve(args.proposals);
  const curationDir = path.dirname(curationFilePath);
  if (path.basename(curationDir) === 'curations') return path.dirname(curationDir);
  return resolveProposalDir(args);
}

function selectCurationCandidate(curation, candidateId) {
  if (candidateId) {
    const candidate = curation.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new Error(`candidate not found in curation: ${candidateId}`);
    return candidate;
  }
  if (curation.candidates.length !== 1) {
    throw new Error('--candidate-id is required when curation has zero or multiple candidates');
  }
  return curation.candidates[0];
}

function changeTypeForTargetFile(filePath) {
  if (filePath.endsWith('.schema.json')) return 'update';
  if (filePath.endsWith('.md') || filePath.endsWith('.toml')) return 'update';
  if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) return 'update';
  return 'review';
}

function intendedChangeForFile(filePath, candidate) {
  return {
    file: filePath,
    changeType: changeTypeForTargetFile(filePath),
    description: `Address ${candidate.classification} by applying the candidate recommendation: ${candidate.recommendedChange}`,
  };
}

function verificationPlanForCandidate(candidate) {
  const plan = [
    { type: 'syntax', command: 'node --check scripts/p2a_proposals.mjs', required: true },
    { type: 'validation', command: 'node --check scripts/validate_artifacts.mjs', required: true },
    { type: 'fixture', command: 'node scripts/run_fixtures.mjs', required: true },
    { type: 'parity', command: 'node scripts/check_cli_parity.mjs', required: true },
  ];
  if (candidate.targetFiles.some((filePath) => filePath.endsWith('.md') || filePath.endsWith('.toml'))) {
    plan.push({ type: 'custom', command: 'git diff --check', required: true });
  }
  return plan;
}

function risksForCandidate(candidate) {
  const risks = [
    `Risk level from curation: ${candidate.risk}.`,
    'Patch draft is advisory only and may be incomplete until a human reviews the target files.',
  ];
  if (candidate.readiness !== 'patch_candidate') {
    risks.push(`Candidate readiness is ${candidate.readiness}; collect more evidence before implementation if needed.`);
  }
  return risks;
}

function buildProposalPatchDraft(curation, candidate, proposalsDir, curationPathForDisplay, generatedAt = new Date().toISOString()) {
  const draftId = `proposal-patch-draft-${stableHash({
    curationId: curation.curationId,
    candidateId: candidate.candidateId,
    targetFiles: candidate.targetFiles,
    recommendedChange: candidate.recommendedChange,
  })}`;
  return validateProposalPatchDraftData({
    schema_version: 'p2a.proposal_patch_draft.v1',
    draftId,
    generatedAt,
    sourceCuration: displayPath(curationPathForDisplay),
    candidateId: candidate.candidateId,
    classification: candidate.classification,
    title: `Patch draft: ${candidate.title}`,
    status: 'draft',
    approvalRequired: true,
    autoApplyAllowed: false,
    targetFiles: candidate.targetFiles,
    intendedChanges: candidate.targetFiles.map((filePath) => intendedChangeForFile(filePath, candidate)),
    verificationPlan: verificationPlanForCandidate(candidate),
    risks: risksForCandidate(candidate),
    rationale: `${candidate.rationale} This draft records intended changes only; it does not modify ${displayPath(proposalsDir)} or target files.`,
  });
}

function writePatchDraft(filePath, draft, overwrite = false) {
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return { action: existed ? 'overwritten' : 'written', filePath };
}

function resolveProposalDirForApproval(args, draftFilePath) {
  if (args.proposals) return path.resolve(args.proposals);
  const draftDir = path.dirname(draftFilePath);
  if (path.basename(draftDir) === 'patch-drafts') return path.dirname(draftDir);
  return resolveProposalDir(args);
}

function maintenanceTaskGraphPathForArtifactRoot(artifactRoot) {
  return path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
}

function loadProjectIdForApproval(artifactRoot, graphPath) {
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  if (existsSync(currentSpecPath)) {
    const currentSpec = loadJson(currentSpecPath);
    if (typeof currentSpec.project_id === 'string' && currentSpec.project_id.trim()) return currentSpec.project_id.trim();
    if (typeof currentSpec.projectId === 'string' && currentSpec.projectId.trim()) return currentSpec.projectId.trim();
  }
  if (existsSync(graphPath)) {
    const graph = loadJson(graphPath);
    if (typeof graph.projectId === 'string' && graph.projectId.trim()) return graph.projectId.trim();
  }
  return path.basename(path.resolve(artifactRoot)) || 'plan2agent-project';
}

function initialMaintenanceTaskGraph(projectId) {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId,
    version: 'maintenance',
    sourceSpec: '../../../current-spec.json',
    tasks: [],
  };
}

function nextMaintenanceTaskId(tasks) {
  const max = tasks.reduce((highest, task) => {
    const match = typeof task.id === 'string' ? task.id.match(/^task-([0-9]+)$/) : null;
    return match ? Math.max(highest, Number.parseInt(match[1], 10)) : highest;
  }, 0);
  return `task-${String(max + 1).padStart(3, '0')}`;
}

function buildProposalDraftApprovalId(draft, approvedBy, approvalNote) {
  return `proposal-draft-approval-${stableHash({
    draftId: draft.draftId,
    candidateId: draft.candidateId,
    approvedBy,
    approvalNote: approvalNote ?? null,
  })}`;
}

function proposalDraftApprovalRefs(draft, approvalId) {
  return [
    `proposal-draft-approval:${approvalId}`,
    `proposal-patch-draft:${draft.draftId}`,
    `proposal-candidate:${draft.candidateId}`,
    `proposal-classification:${draft.classification}`,
  ];
}

function verificationLine(item) {
  const command = item.command ?? 'owner-approved skipped verification rationale';
  return `${item.type}: ${command}`;
}

function patchDraftApprovalTask(projectId, draft, approvalId, taskId) {
  const targetFiles = draft.targetFiles.join(', ');
  const intendedChanges = draft.intendedChanges
    .map((change) => `- ${change.file}: ${change.description}`)
    .join('\n');
  const verificationPlan = draft.verificationPlan
    .map((item) => `- ${verificationLine(item)}`)
    .join('\n');
  return {
    id: taskId,
    title: `Apply approved proposal patch draft ${draft.draftId}`,
    description: `Implement the human-approved proposal patch draft ${draft.draftId} for ${draft.title}. Target files: ${targetFiles}.`,
    status: 'todo',
    dependencies: [],
    acceptanceCriteria: [
      `The approved patch draft ${draft.draftId} is implemented within the recorded target files or each skipped target file has an explicit owner rationale.`,
      'The implementation remains scoped to the approved proposal and does not broaden unrelated harness behavior.',
      'The draft verification plan is run, or any intentionally skipped verification has an owner-approved rationale in the run notes.',
    ],
    targetArea: 'maintenance',
    suggestedAgentPrompt: [
      `Implement approved Plan2Agent proposal patch draft ${draft.draftId} in project ${projectId}.`,
      `Approval artifact id: ${approvalId}. Candidate: ${draft.candidateId}. Source curation: ${draft.sourceCuration}.`,
      `Target files: ${targetFiles}.`,
      'Intended changes:',
      intendedChanges,
      'Verification plan:',
      verificationPlan,
      'Keep the change scoped to this approved proposal. Do not modify additional files unless the implementation requires it and the reason is recorded in the run notes.',
    ].join('\n'),
    sourceSpecRefs: proposalDraftApprovalRefs(draft, approvalId),
  };
}

function planMaintenanceTaskForApproval(artifactRoot, draft, approvalId) {
  const graphPath = maintenanceTaskGraphPathForArtifactRoot(artifactRoot);
  const projectId = loadProjectIdForApproval(artifactRoot, graphPath);
  const graph = existsSync(graphPath)
    ? loadJson(graphPath)
    : initialMaintenanceTaskGraph(projectId);
  if (!Array.isArray(graph.tasks)) graph.tasks = [];
  const draftRef = `proposal-patch-draft:${draft.draftId}`;
  const existingTask = graph.tasks.find((task) => (task.sourceSpecRefs ?? []).includes(draftRef));
  if (existingTask) {
    const approvalRef = `proposal-draft-approval:${approvalId}`;
    if (!existingTask.sourceSpecRefs.includes(approvalRef)) {
      existingTask.sourceSpecRefs.push(approvalRef);
      validateTaskGraphData(graph);
      return { action: 'updated', graphPath, graph, task: existingTask, shouldWrite: true };
    }
    validateTaskGraphData(graph);
    return { action: 'existing', graphPath, graph, task: existingTask, shouldWrite: false };
  }
  const task = patchDraftApprovalTask(projectId, draft, approvalId, nextMaintenanceTaskId(graph.tasks));
  graph.tasks.push(task);
  validateTaskGraphData(graph);
  return { action: 'appended', graphPath, graph, task, shouldWrite: true };
}

function writeMaintenanceTaskGraph(graphPath, graph) {
  mkdirSync(path.dirname(graphPath), { recursive: true });
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

function buildProposalDraftApproval(draft, draftFilePath, maintenancePlan, approvedBy, approvalNote, approvalId, approvedAt = new Date().toISOString()) {
  return validateProposalDraftApprovalData({
    schema_version: 'p2a.proposal_draft_approval.v1',
    approvalId,
    approvedAt,
    approvedBy,
    approvalNote: approvalNote ?? null,
    sourceDraft: displayPath(draftFilePath),
    draftId: draft.draftId,
    candidateId: draft.candidateId,
    autoApplyPerformed: false,
    maintenanceTask: {
      taskGraph: displayPath(maintenancePlan.graphPath),
      taskId: maintenancePlan.task.id,
      title: maintenancePlan.task.title,
      sourceSpecRefs: maintenancePlan.task.sourceSpecRefs,
    },
  });
}

function assertExistingApprovalMatches(filePath, approval) {
  if (!existsSync(filePath)) return;
  assertFile(filePath, 'approval output');
  const existing = validateProposalDraftApprovalData(loadJson(filePath));
  const expectedFields = ['approvalId', 'draftId', 'candidateId', 'approvedBy', 'approvalNote', 'autoApplyPerformed'];
  const mismatchedFields = expectedFields.filter((field) => JSON.stringify(existing[field]) !== JSON.stringify(approval[field]));
  if (existing.maintenanceTask.taskId !== approval.maintenanceTask.taskId) mismatchedFields.push('maintenanceTask.taskId');
  if (mismatchedFields.length) {
    throw new Error(`existing approval output does not match requested approval: ${mismatchedFields.join(', ')}`);
  }
}

function writeApproval(filePath, approval, overwrite = false) {
  const existed = existsSync(filePath);
  if (existed && !overwrite) return { action: 'skipped', filePath };
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
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

function runCurate(args) {
  const reviewFilePath = path.resolve(args.review);
  assertFile(reviewFilePath, 'proposal review');
  const proposalsDir = resolveProposalDirForCuration(args, reviewFilePath);
  const requestedFilePath = args.output ? path.resolve(args.output) : null;
  if (requestedFilePath) assertCurationOutputPath(proposalsDir, requestedFilePath);
  const review = validateProposalReviewData(loadJson(reviewFilePath));
  const proposals = loadProposals(proposalsDir);
  const curation = buildProposalCuration(review, proposals, proposalsDir, reviewFilePath);
  const filePath = requestedFilePath ?? curationPath(proposalsDir, curation.curationId);
  const writeResult = args.dryRun
    ? { action: 'dry-run', filePath }
    : writeCuration(filePath, curation, args.overwrite);
  if (args.json) {
    console.log(JSON.stringify({
      proposalsDir: displayPath(proposalsDir),
      reviewFile: displayPath(reviewFilePath),
      curationFile: displayPath(filePath),
      action: writeResult.action,
      curation,
    }, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal curation');
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- review: ${displayPath(reviewFilePath)}`);
  console.log(`- curation: ${displayPath(filePath)}`);
  console.log(`- action: ${writeResult.action}`);
  console.log(`- candidates total: ${curation.summary.totalCandidates}`);
  console.log(`- readiness: ${JSON.stringify(curation.summary.byReadiness)}`);
  for (const candidate of curation.candidates) {
    console.log(`- ${candidate.candidateId} [${candidate.priority} ${candidate.readiness}] ${candidate.title}`);
  }
  return 0;
}

function runDraftPatch(args) {
  const curationFilePath = path.resolve(args.curation);
  assertFile(curationFilePath, 'proposal curation');
  const proposalsDir = resolveProposalDirForPatchDraft(args, curationFilePath);
  const requestedFilePath = args.output ? path.resolve(args.output) : null;
  if (requestedFilePath) assertPatchDraftOutputPath(proposalsDir, requestedFilePath);
  const curation = validateProposalCurationData(loadJson(curationFilePath));
  const candidate = selectCurationCandidate(curation, args.candidateId);
  const draft = buildProposalPatchDraft(curation, candidate, proposalsDir, curationFilePath);
  const filePath = requestedFilePath ?? patchDraftPath(proposalsDir, draft.draftId);
  const writeResult = args.dryRun
    ? { action: 'dry-run', filePath }
    : writePatchDraft(filePath, draft, args.overwrite);
  if (args.json) {
    console.log(JSON.stringify({
      proposalsDir: displayPath(proposalsDir),
      curationFile: displayPath(curationFilePath),
      patchDraftFile: displayPath(filePath),
      action: writeResult.action,
      draft,
    }, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal patch draft');
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- curation: ${displayPath(curationFilePath)}`);
  console.log(`- patch draft: ${displayPath(filePath)}`);
  console.log(`- action: ${writeResult.action}`);
  console.log(`- candidate: ${candidate.candidateId}`);
  console.log(`- target files: ${draft.targetFiles.length}`);
  console.log(`- auto apply allowed: ${draft.autoApplyAllowed}`);
  return 0;
}

function runApproveDraft(args) {
  const draftFilePath = path.resolve(args.draft);
  assertFile(draftFilePath, 'proposal patch draft');
  const artifactRoot = path.resolve(args.artifacts);
  assertDirectory(artifactRoot, 'iterative artifact root');
  const proposalsDir = resolveProposalDirForApproval(args, draftFilePath);
  const approvedBy = args.approvedBy.trim();
  const approvalNote = args.approvalNote?.trim() || null;
  if (!approvedBy) throw new Error('--approved-by must not be blank');

  const draft = validateProposalPatchDraftData(loadJson(draftFilePath));
  const approvalId = buildProposalDraftApprovalId(draft, approvedBy, approvalNote);
  const maintenancePlan = planMaintenanceTaskForApproval(artifactRoot, draft, approvalId);
  const approval = buildProposalDraftApproval(draft, draftFilePath, maintenancePlan, approvedBy, approvalNote, approvalId);
  const requestedFilePath = args.output ? path.resolve(args.output) : null;
  if (requestedFilePath) assertApprovalOutputPath(proposalsDir, requestedFilePath);
  const filePath = requestedFilePath ?? approvalPath(proposalsDir, approval.approvalId);
  if (!args.dryRun && !args.overwrite) assertExistingApprovalMatches(filePath, approval);

  const taskGraphAction = args.dryRun
    ? 'dry-run'
    : maintenancePlan.shouldWrite
      ? 'written'
      : 'unchanged';
  if (!args.dryRun && maintenancePlan.shouldWrite) {
    writeMaintenanceTaskGraph(maintenancePlan.graphPath, maintenancePlan.graph);
  }
  const writeResult = args.dryRun
    ? { action: 'dry-run', filePath }
    : writeApproval(filePath, approval, args.overwrite);

  if (args.json) {
    console.log(JSON.stringify({
      proposalsDir: displayPath(proposalsDir),
      draftFile: displayPath(draftFilePath),
      approvalFile: displayPath(filePath),
      action: writeResult.action,
      taskGraphAction,
      approval,
    }, null, 2));
    return 0;
  }
  console.log('Plan2Agent proposal draft approval');
  console.log(`- proposals: ${displayPath(proposalsDir)}`);
  console.log(`- draft: ${displayPath(draftFilePath)}`);
  console.log(`- approval: ${displayPath(filePath)}`);
  console.log(`- approval action: ${writeResult.action}`);
  console.log(`- maintenance graph: ${displayPath(maintenancePlan.graphPath)} (${taskGraphAction})`);
  console.log(`- maintenance task: ${maintenancePlan.task.id} (${maintenancePlan.action})`);
  console.log(`- auto apply performed: ${approval.autoApplyPerformed}`);
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
    if (args.command === 'curate') return runCurate(args);
    if (args.command === 'draft-patch') return runDraftPatch(args);
    if (args.command === 'approve-draft') return runApproveDraft(args);
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
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
