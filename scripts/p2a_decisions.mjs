#!/usr/bin/env node
/** Record and inspect the append-only Plan2Agent decision ledger. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  appendDecisionEventsLocked,
  decisionLedgerPath,
  fileSha256,
  latestActiveScopeApproval,
  normalizedDecisionRef,
  readDecisions,
  resolveDecisionArtifactRoot,
  scopeApprovalState,
  withDecisionLedgerLock,
} from './p2a_decision_ledger.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import { artifactRelativePath as artifactRelative } from './p2a_cli_helpers.mjs';
import { normalizePath, resolveP2aPaths } from './p2a_paths.mjs';
import { atomicWriteJson, atomicWriteText } from './p2a_run_store.mjs';
import {
  validateIntake,
  validateRunsDir,
  validateSpec,
  ValidationError,
} from './validate_artifacts.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const DECIDE_ACTIONS = new Set(['approve', 'revoke', 'add', 'remove']);

function usage() {
  return [
    'Usage:',
    '  p2a decide [approve] --quote <user-utterance> [--target <dir>|--artifacts <dir>]',
    '  p2a decide revoke --quote <user-utterance> [--target <dir>|--artifacts <dir>]',
    '  p2a decide add|remove --scope <description> --quote <user-utterance> [options]',
    '  p2a decisions [--target <dir>|--artifacts <dir>] [--json]',
    '  p2a decisions --why <file-path> [--target <dir>|--artifacts <dir>] [--json]',
    '',
    'Notes:',
    '  decide approves the earliest pending Gate ① scope/spec artifact and keeps approval_audit as a copy.',
    '  revoke, add, and remove append new entries; they never delete prior decisions.',
  ].join('\n');
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value) throw new ValidationError(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  let mode = argv[0];
  let index = 1;
  if (!['decide', 'decisions'].includes(mode)) {
    mode = 'decisions';
    index = 0;
  }
  let action = mode === 'decide' ? 'approve' : 'list';
  if (mode === 'decide' && argv[index] && !argv[index].startsWith('-')) {
    action = argv[index];
    index += 1;
  }
  if (mode === 'decide' && !DECIDE_ACTIONS.has(action)) {
    throw new ValidationError(`unknown decide action: ${action}`);
  }
  const args = {
    mode,
    action,
    target: P2A_PATHS.projectRoot,
    artifacts: null,
    projectId: null,
    quote: null,
    scope: null,
    why: null,
    json: false,
    help: false,
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--target') args.target = requiredValue(argv, ++index, '--target');
    else if (arg === '--artifacts' || arg === '--artifact-root') args.artifacts = requiredValue(argv, ++index, arg);
    else if (arg === '--project-id') args.projectId = requiredValue(argv, ++index, '--project-id');
    else if (arg === '--quote') args.quote = requiredValue(argv, ++index, '--quote');
    else if (arg === '--scope') args.scope = requiredValue(argv, ++index, '--scope');
    else if (arg === '--why') args.why = requiredValue(argv, ++index, '--why');
    else throw new ValidationError(`unknown ${mode} option: ${arg}`);
  }
  if (mode === 'decide' && !args.help && !args.quote?.trim()) {
    throw new ValidationError('p2a decide requires --quote with the verbatim user utterance');
  }
  if (mode === 'decide' && ['add', 'remove'].includes(action) && !args.scope?.trim()) {
    throw new ValidationError(`p2a decide ${action} requires --scope <description>`);
  }
  if (mode === 'decisions' && args.quote !== null) {
    throw new ValidationError('--quote is only supported by p2a decide');
  }
  if (mode === 'decisions' && args.scope !== null) {
    throw new ValidationError('--scope is only supported by p2a decide add or remove');
  }
  if (mode === 'decide' && args.why !== null) {
    throw new ValidationError('--why is only supported by p2a decisions');
  }
  if (mode === 'decide' && args.json) {
    throw new ValidationError('--json is only supported by p2a decisions');
  }
  if (mode === 'decide' && !['add', 'remove'].includes(action) && args.scope !== null) {
    throw new ValidationError('--scope is only supported by p2a decide add or remove');
  }
  return args;
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function gateFiles(artifactRoot) {
  const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
  const iterationsRoot = path.join(artifactRoot, 'iterations');
  if (isFile(currentSpecPath) && existsSync(iterationsRoot)) {
    const state = resolveIterationState(artifactRoot, { requireReady: false });
    return {
      intakePath: path.join(state.iterationRoot, 'gate-a-intake', 'intake.json'),
      specPath: state.specPath,
    };
  }
  return {
    intakePath: path.join(artifactRoot, 'gate-a-intake', 'intake.json'),
    specPath: path.join(artifactRoot, 'gate-b-spec', 'spec.json'),
  };
}

function approvalAudit(quote, approvedArtifacts) {
  return {
    approved_by: 'user',
    approved_at: new Date().toISOString().slice(0, 10),
    approved_artifacts: approvedArtifacts,
    approval_note: `User quote: ${JSON.stringify(quote)}`,
  };
}

function artifactApprovalCandidate(artifactRoot, kind, filePath, records, allowLegacyFallback) {
  if (!isFile(filePath)) return null;
  const data = readJson(filePath);
  const scopeRef = artifactRelative(artifactRoot, filePath);
  const sha256 = fileSha256(filePath);
  const fallbackApproved = kind === 'intake'
    ? data.status === 'ready_for_spec' && Boolean(data.approval_audit)
    : data.approval === 'approved' && Boolean(data.approval_audit);
  return {
    kind,
    filePath,
    scopeRef,
    sha256,
    data,
    approval: scopeApprovalState(
      records,
      scopeRef,
      sha256,
      fallbackApproved,
      { allowLegacyFallback },
    ),
  };
}

function selectApprovalCandidate(artifactRoot, records) {
  const files = gateFiles(artifactRoot);
  const allowLegacyFallback = !existsSync(decisionLedgerPath(artifactRoot));
  const intake = artifactApprovalCandidate(
    artifactRoot,
    'intake',
    files.intakePath,
    records,
    allowLegacyFallback,
  );
  const spec = artifactApprovalCandidate(
    artifactRoot,
    'spec',
    files.specPath,
    records,
    allowLegacyFallback,
  );
  if (intake && !intake.approval.approved) return intake;
  if (spec && !spec.approval.approved) return spec;
  throw new ValidationError('no pending Gate ① scope or specification approval was found');
}

function approvedArtifactsFor(candidate) {
  const refs = [candidate.scopeRef];
  if (candidate.kind === 'spec') {
    const visualRef = candidate.data.visual_experience?.experience_spec_ref;
    if (typeof visualRef === 'string' && visualRef.trim()) refs.push(visualRef);
  }
  return [...new Set(refs)];
}

function validateApprovedCandidate(candidate, artifactRoot) {
  if (candidate.kind === 'intake') return validateIntake(candidate.filePath, { artifactRoot });
  return validateSpec(candidate.filePath, null, { artifactRoot });
}

function approveGateWhat(args, artifactRoot) {
  return withDecisionLedgerLock(artifactRoot, () => {
    const records = readDecisions(artifactRoot);
    const candidate = selectApprovalCandidate(artifactRoot, records);
    const original = readFileSync(candidate.filePath, 'utf8');
    const next = {
      ...candidate.data,
      ...(candidate.kind === 'intake' ? { status: 'ready_for_spec' } : { approval: 'approved' }),
      approval_audit: approvalAudit(args.quote, approvedArtifactsFor(candidate)),
    };
    try {
      atomicWriteJson(candidate.filePath, next);
      validateApprovedCandidate(candidate, artifactRoot);
      const sha256 = fileSha256(candidate.filePath);
      const [event] = appendDecisionEventsLocked(artifactRoot, [{
        type: 'gate.what.approved',
        quote: args.quote,
        scope_ref: candidate.scopeRef,
        sha256,
      }]);
      console.log(`Plan2Agent Gate ① approved: ${candidate.scopeRef}`);
      console.log(`- decision: seq=${event.seq} type=${event.type}`);
      console.log(`- ledger: ${decisionLedgerPath(artifactRoot)}`);
      return 0;
    } catch (error) {
      atomicWriteText(candidate.filePath, original);
      throw error;
    }
  });
}

function scopeCandidates(artifactRoot) {
  const files = gateFiles(artifactRoot);
  return [files.specPath, files.intakePath]
    .filter(isFile)
    .map((filePath) => ({
      filePath,
      scopeRef: artifactRelative(artifactRoot, filePath),
      sha256: fileSha256(filePath),
      data: readJson(filePath),
    }));
}

function revokeGateWhat(args, artifactRoot) {
  return withDecisionLedgerLock(artifactRoot, () => {
    const ledgerExists = existsSync(decisionLedgerPath(artifactRoot));
    const records = readDecisions(artifactRoot);
    const candidates = scopeCandidates(artifactRoot);
    const active = latestActiveScopeApproval(records, candidates.map((candidate) => candidate.scopeRef));
    if (!active && ledgerExists) {
      throw new ValidationError('no active Gate ① decision is available to revoke');
    }
    let selected = active
      ? candidates.find((candidate) => normalizedDecisionRef(candidate.scopeRef) === normalizedDecisionRef(active.scope_ref))
      : null;
    if (!selected) {
      selected = candidates.find((candidate) => (
        candidate.data.approval === 'approved' && candidate.data.approval_audit
      )) ?? candidates.find((candidate) => (
        candidate.data.status === 'ready_for_spec' && candidate.data.approval_audit
      ));
    }
    if (!selected) throw new ValidationError('no approved Gate ① artifact is available to revoke');
    const [event] = appendDecisionEventsLocked(artifactRoot, [{
      type: 'gate.what.revoked',
      quote: args.quote,
      scope_ref: selected.scopeRef,
      sha256: selected.sha256,
      ...(active ? { prev_seq: active.seq } : {}),
    }]);
    console.log(`Plan2Agent Gate ① approval revoked: ${selected.scopeRef}`);
    console.log(`- decision: seq=${event.seq} type=${event.type}`);
    return 0;
  });
}

function recordScopeChange(args, artifactRoot) {
  return withDecisionLedgerLock(artifactRoot, () => {
    const records = readDecisions(artifactRoot);
    const candidates = scopeCandidates(artifactRoot);
    const active = latestActiveScopeApproval(records, candidates.map((candidate) => candidate.scopeRef));
    if (!active) {
      throw new ValidationError('scope changes require a prior active Gate ① decision in decisions.jsonl');
    }
    const selected = candidates.find((candidate) => (
      normalizedDecisionRef(candidate.scopeRef) === normalizedDecisionRef(active.scope_ref)
    ));
    if (!selected) throw new ValidationError(`active Gate ① scope cannot be resolved: ${active.scope_ref}`);
    const type = args.action === 'add' ? 'scope.added' : 'scope.removed';
    const [event] = appendDecisionEventsLocked(artifactRoot, [{
      type,
      quote: args.quote,
      scope_ref: selected.scopeRef,
      sha256: selected.sha256,
      scope_change: args.scope,
      prev_seq: active.seq,
    }]);
    console.log(`Plan2Agent scope decision recorded: ${type}`);
    console.log(`- decision: seq=${event.seq} scope=${JSON.stringify(args.scope.trim())}`);
    return 0;
  });
}

function decisionArtifactPath(artifactRoot, reference) {
  const resolved = path.isAbsolute(reference)
    ? path.resolve(reference)
    : path.resolve(artifactRoot, reference);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function runSourceSpecPath(artifactRoot, run) {
  if (path.isAbsolute(run.sourceSpecRef)) return decisionArtifactPath(artifactRoot, run.sourceSpecRef);
  const graphPath = path.isAbsolute(run.taskGraphRef)
    ? path.resolve(run.taskGraphRef)
    : path.resolve(artifactRoot, run.taskGraphRef);
  return decisionArtifactPath(
    artifactRoot,
    path.resolve(path.dirname(graphPath), run.sourceSpecRef),
  );
}

function normalizedFileCandidate(value) {
  return normalizePath(value).replace(/^\.\//, '');
}

function changedFileMatches(changedFile, requested, targetRoot) {
  const changed = normalizedFileCandidate(changedFile);
  const candidates = new Set([normalizedFileCandidate(requested)]);
  if (path.isAbsolute(requested)) {
    candidates.add(normalizedFileCandidate(path.relative(targetRoot, requested)));
  }
  return candidates.has(changed);
}

function decisionsAt(records, timestamp) {
  const cutoff = Date.parse(timestamp);
  return records.filter((record) => !Number.isFinite(cutoff) || Date.parse(record.at) <= cutoff);
}

function activeScopeDecisionsForRun(records, artifactRoot, run) {
  const sourceSpecPath = runSourceSpecPath(artifactRoot, run);
  const available = decisionsAt(records, run.startedAt);
  const scoped = available.filter((record) => (
    ['gate.what.approved', 'gate.what.revoked', 'scope.added', 'scope.removed'].includes(record.type)
    && decisionArtifactPath(artifactRoot, record.scope_ref) === sourceSpecPath
  ));
  const latest = scoped.at(-1);
  if (!latest || latest.type === 'gate.what.revoked') return [];
  const bySeq = new Map(available.map((record) => [record.seq, record]));
  const chain = [];
  let current = latest;
  while (current) {
    chain.push(current);
    current = current.prev_seq ? bySeq.get(current.prev_seq) : null;
  }
  return chain.reverse();
}

function activeShapeDecisionForRun(records, run) {
  const latest = decisionsAt(records, run.startedAt)
    .filter((record) => ['gate.how.approved', 'gate.how.revoked'].includes(record.type))
    .at(-1);
  return latest?.type === 'gate.how.approved' ? latest : null;
}

function whyResult(args, artifactRoot, records) {
  const runsDir = path.join(artifactRoot, 'runs');
  const runs = [];
  if (existsSync(path.join(runsDir, 'run-index.json'))) {
    const index = validateRunsDir(runsDir);
    for (const entry of index.runs) {
      const run = readJson(path.join(runsDir, entry.runRef));
      if (run.changedFiles.some((changedFile) => changedFileMatches(changedFile, args.why, args.target))) {
        runs.push(run);
      }
    }
  }
  const decisions = [];
  const seen = new Set();
  const addDecision = (record) => {
    if (record && !seen.has(record.seq)) {
      seen.add(record.seq);
      decisions.push(record);
    }
  };
  for (const run of runs) {
    activeScopeDecisionsForRun(records, artifactRoot, run).forEach(addDecision);
    addDecision(activeShapeDecisionForRun(records, run));
  }
  const requestedAbsolute = path.isAbsolute(args.why)
    ? path.resolve(args.why)
    : path.resolve(artifactRoot, args.why);
  records.filter((record) => (
    record.scope_ref && decisionArtifactPath(artifactRoot, record.scope_ref) === requestedAbsolute
  )).forEach(addDecision);
  return {
    schema_version: 'p2a.decision_why.v1',
    artifactRoot,
    file: args.why,
    runs: runs.map((run) => ({
      runId: run.runId,
      taskId: run.taskId,
      startedAt: run.startedAt,
      sourceSpecRef: run.sourceSpecRef,
      changedFiles: run.changedFiles,
    })),
    decisions: decisions.sort((left, right) => left.seq - right.seq),
  };
}

function printDecisions(records, artifactRoot) {
  console.log('Plan2Agent decisions');
  console.log(`- artifact root: ${artifactRoot}`);
  console.log(`- ledger: ${decisionLedgerPath(artifactRoot)}`);
  console.log(`- count: ${records.length}`);
  for (const record of records) {
    const ref = record.scope_ref ? ` ref=${record.scope_ref}` : '';
    console.log(`${record.seq}. ${record.type}${ref} quote=${JSON.stringify(record.quote)}`);
  }
}

function printWhy(result) {
  console.log('Plan2Agent decision why');
  console.log(`- file: ${result.file}`);
  console.log(`- runs: ${result.runs.length}`);
  console.log(`- decisions: ${result.decisions.length}`);
  for (const decision of result.decisions) {
    console.log(`${decision.seq}. ${decision.type} quote=${JSON.stringify(decision.quote)}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const commandName = argv[0] === 'decide' ? 'decide' : 'decisions';
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const artifactRoot = resolveDecisionArtifactRoot(args.target, {
      artifacts: args.artifacts,
      projectId: args.projectId,
    });
    if (args.mode === 'decide') {
      if (args.action === 'approve') return approveGateWhat(args, artifactRoot);
      if (args.action === 'revoke') return revokeGateWhat(args, artifactRoot);
      return recordScopeChange(args, artifactRoot);
    }
    const records = readDecisions(artifactRoot, { required: true });
    if (args.why) {
      const result = whyResult(args, artifactRoot, records);
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else printWhy(result);
      return 0;
    }
    if (args.json) console.log(JSON.stringify(records, null, 2));
    else printDecisions(records, artifactRoot);
    return 0;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError || error?.code) {
      console.error(`p2a ${commandName} error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) process.exitCode = main();
