import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  MONITOR_CONCERN_FIELDS,
  monitorGateContractSha256,
  monitorVerdictEvidenceSha256,
  normalizeMonitorGateSidecar,
  normalizeMonitorVerdictData,
} from '../scripts/p2a_monitor_gate.mjs';
import { runFilePath, runSidecarPath } from '../scripts/p2a_run_paths.mjs';
import { validateRunData } from '../scripts/validate_artifacts.mjs';
import {
  EVAL_CLI,
  E2E_FIXTURE_ROOT,
  PROPOSALS_CLI,
  ROOT,
  RUNS_CLI,
  TASKS_CLI,
} from './helpers/fixtures.mjs';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runCli(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('generated Claude agents inherit the parent session model', () => {
  const agentDir = path.join(ROOT, '.claude', 'agents');
  const pinned = readdirSync(agentDir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => /^model:/m.test(readFileSync(path.join(agentDir, name), 'utf8')));
  assert.deepEqual(pinned, []);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'scripts', 'sync_cli_assets.mjs'), 'utf8'), /CLAUDE_TIER_MODEL/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'scripts', 'p2a_handoff.mjs'), 'utf8'), /model: sonnet/);
});

test('new monitor gates require an explicit rule review while legacy gates remain readable', () => {
  const legacy = normalizeMonitorGateSidecar({ required: true }, 'run-legacy', 'run-legacy.json');
  assert.deepEqual(legacy.requiredConcernFields, []);
  assert.doesNotThrow(() => normalizeMonitorVerdictData({
    verdict: 'block',
    unmet_acceptance: ['Legacy concern.'],
  }, { requiredConcernFields: legacy.requiredConcernFields }));

  const current = normalizeMonitorGateSidecar({
    required: true,
    ruleContract: { source: 'none', ref: null, sha256: null },
    requiredConcernFields: MONITOR_CONCERN_FIELDS,
  }, 'run-current', 'run-current.json');
  assert.deepEqual(current.requiredConcernFields, MONITOR_CONCERN_FIELDS);
  assert.throws(
    () => normalizeMonitorGateSidecar({
      required: true,
      ruleContract: { source: 'none', ref: null, sha256: null },
      requiredConcernFields: [],
    }, 'run-current', 'run-current.json'),
    /requiredConcernFields is missing/,
  );
  assert.throws(
    () => normalizeMonitorGateSidecar({
      required: true,
      ruleContract: { source: 'none', ref: null, sha256: null },
      acceptedVerdicts: ['skip_review'],
    }, 'run-current', 'run-current.json'),
    /acceptedVerdicts/,
  );
  assert.throws(
    () => normalizeMonitorVerdictData({
      verdict: 'confirm_done',
      scope_concerns: [],
      verification_concerns: [],
      unmet_acceptance: [],
      needs_user_decision: [],
    }, { requiredConcernFields: current.requiredConcernFields }),
    /rule_concerns/,
  );
  assert.throws(
    () => normalizeMonitorVerdictData({
      verdict: 'confirm_done',
      rules_reviewed: [],
      rule_concerns: [123],
      scope_concerns: [],
      verification_concerns: [],
      unmet_acceptance: [],
      needs_user_decision: [],
    }, {
      requiredConcernFields: current.requiredConcernFields,
      requireRulesReviewed: true,
    }),
    /non-empty strings/,
  );
  const blocked = normalizeMonitorVerdictData({
    verdict: 'block',
    rules_reviewed: [],
    rule_concerns: ['[ARCH-1] src/index.js violates the approved module boundary.'],
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
    note: '',
  }, { requiredConcernFields: current.requiredConcernFields });
  assert.equal(blocked.failureSignal, 'rule_concerns');
  assert.equal(blocked.hasConcerns, true);
});

test('run lifecycle binds approved rules and records autonomy telemetry for eval', (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'p2a-monitor-telemetry-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
  const graphPath = path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  const runsDir = path.join(artifactRoot, 'runs');
  const runId = 'run-monitor-telemetry';
  const constitutionPath = path.join(projectRoot, '.plan2agent', 'constitution.json');
  writeJson(constitutionPath, {
    schema_version: 'p2a.constitution.v1',
    projectId: 'webhook-api-service',
    architecture: [{
      id: 'ARCH-1',
      rule: 'Keep HTTP transport separate from signature verification.',
      rationale: 'The boundary keeps verification testable.',
      scope: 'runtime',
    }],
    stack: [{
      id: 'STACK-1',
      choice: 'Node.js and TypeScript',
      rationale: 'The approved service stack.',
      evidence: ['package.json'],
    }],
    prohibitions: [],
    style: { naming: ['Use descriptive camelCase names.'] },
    approval_audit: {
      approved_by: 'user',
      approved_at: '2026-08-13',
      approved_artifacts: ['.plan2agent/constitution.json'],
      approval_note: 'User quote: "승인합니다"',
    },
  });

  let result = runCli(RUNS_CLI, [
    'start', '--graph', graphPath, '--runs', runsDir,
    '--task', 'task-001', '--run-id', runId,
    '--agent-tool', 'codex', '--workspace', projectRoot,
    '--require-monitor',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(readFileSync(runSidecarPath(runsDir, runId, '.monitor-gate.json'), 'utf8'));
  assert.deepEqual(gate.requiredConcernFields, MONITOR_CONCERN_FIELDS);
  assert.equal(gate.ruleContract.source, 'constitution');
  assert.equal(gate.ruleContract.ref, '.plan2agent/constitution.json');
  assert.deepEqual(gate.ruleContract.ruleIds, ['ARCH-1', 'STACK-1', 'STYLE']);
  assert.equal(
    gate.ruleContract.sha256,
    createHash('sha256').update(readFileSync(constitutionPath)).digest('hex'),
  );

  result = runCli(RUNS_CLI, [
    'record', '--runs', runsDir, '--run-id', runId,
    '--usage-model', 'gpt-5.6-sol/high',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required together/);

  result = runCli(RUNS_CLI, [
    'record', '--runs', runsDir, '--run-id', runId,
    '--usage-model', ' ', '--usage-input-tokens', '1', '--usage-output-tokens', '1',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be blank/);

  result = runCli(RUNS_CLI, [
    'record', '--runs', runsDir, '--run-id', runId,
    '--usage-model', 'overflow',
    '--usage-input-tokens', String(Number.MAX_SAFE_INTEGER), '--usage-output-tokens', '1',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /total exceeds the safe integer range/);

  result = runCli(RUNS_CLI, [
    'record', '--runs', runsDir, '--run-id', runId,
    '--usage-model', 'gpt-5.6-sol/high',
    '--usage-input-tokens', '120', '--usage-output-tokens', '30',
    '--usage-source', 'provider',
    '--implementation-interruption', 'Asked the user to choose an internal module layout.',
    '--user-correction', 'User restated the required empty-state behavior.',
    '--gate-return', 'valid:Approved scope lacked a required external permission.',
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(RUNS_CLI, [
    'record', '--runs', runsDir, '--run-id', runId,
    '--usage-model', '__proto__',
    '--usage-input-tokens', '1', '--usage-output-tokens', '0',
  ]);
  assert.equal(result.status, 0, result.stderr);
  let run = validateRunData(JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8')));
  assert.equal(run.telemetryProtocol, 'p2a.run_telemetry.manual.v1');
  assert.equal(run.monitorGate.policy, 'p2a.monitor_gate.rules.v1');
  assert.equal(run.monitorGate.contractSha256, monitorGateContractSha256(gate));
  const missingTelemetryArray = structuredClone(run);
  delete missingTelemetryArray.interruptions;
  assert.throws(() => validateRunData(missingTelemetryArray), /interruptions/);
  assert.deepEqual(run.usage.map(({ modelProfile, inputTokens, outputTokens, totalTokens }) => ({
    modelProfile, inputTokens, outputTokens, totalTokens,
  })), [{
    modelProfile: 'gpt-5.6-sol/high',
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  }, {
    modelProfile: '__proto__',
    inputTokens: 1,
    outputTokens: 0,
    totalTokens: 1,
  }]);
  assert.deepEqual(run.interruptions.map(({ type, assessment }) => ({ type, assessment })), [
    { type: 'implementation_decision', assessment: 'not_applicable' },
    { type: 'user_correction', assessment: 'not_applicable' },
    { type: 'gate_return', assessment: 'valid' },
  ]);

  result = runCli(RUNS_CLI, [
    'verify', '--runs', runsDir, '--run-id', runId,
    '--workspace', projectRoot, '--test-command', 'true',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const gatePath = runSidecarPath(runsDir, runId, '.monitor-gate.json');
  const gateRaw = readFileSync(gatePath, 'utf8');
  rmSync(gatePath);
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'failed', '--failure-class', 'verification_failed',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its bound monitor gate sidecar/);
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'finished',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires its bound monitor gate sidecar/);
  writeFileSync(gatePath, gateRaw, 'utf8');
  writeJson(runSidecarPath(runsDir, runId, '.monitor-verdict.json'), {
    verdict: 'confirm_done',
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
    note: 'Missing the required rule review field.',
  });
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'finished',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rule_concerns/);

  writeJson(runSidecarPath(runsDir, runId, '.monitor-verdict.json'), {
    verdict: 'confirm_done',
    rules_reviewed: ['ARCH-1', 'STACK-1', 'STYLE'],
    rule_concerns: [],
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
    note: 'Approved constitution checked against the changed-file set.',
  });
  const weakenedGate = JSON.parse(gateRaw);
  weakenedGate.ruleContract.ruleIds = [];
  writeJson(gatePath, weakenedGate);
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'finished',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /monitor gate contract changed/);
  result = runCli(RUNS_CLI, ['validate', '--runs', runsDir, '--run-id', runId]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /monitor gate contract changed/);
  writeFileSync(gatePath, gateRaw, 'utf8');
  const constitutionRaw = readFileSync(constitutionPath, 'utf8');
  const changedConstitution = JSON.parse(constitutionRaw);
  changedConstitution.architecture[0].rule = 'A different rule introduced after the run started.';
  writeJson(constitutionPath, changedConstitution);
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'finished',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /monitor rule contract source changed or is unavailable/);
  writeFileSync(constitutionPath, constitutionRaw, 'utf8');
  const acceptedVerdictPath = runSidecarPath(runsDir, runId, '.monitor-verdict.json');
  const acceptedVerdictRaw = readFileSync(acceptedVerdictPath, 'utf8');
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', runId, '--status', 'finished',
  ]);
  assert.equal(result.status, 0, result.stderr);
  run = validateRunData(JSON.parse(readFileSync(runFilePath(runsDir, runId), 'utf8')));
  assert.equal(run.status, 'finished');
  assert.equal(
    run.monitorVerdictEvidenceSha256,
    monitorVerdictEvidenceSha256(acceptedVerdictRaw),
  );
  result = runCli(RUNS_CLI, ['validate', '--runs', runsDir, '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);

  writeJson(acceptedVerdictPath, {
    verdict: 'block',
    rules_reviewed: ['ARCH-1', 'STACK-1', 'STYLE'],
    rule_concerns: ['[ARCH-1] Retrospective fixture concern.'],
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
  });
  result = runCli(PROPOSALS_CLI, [
    'mine', '--runs', runsDir, '--run-id', runId,
    '--proposals', path.join(projectRoot, 'proposals'), '--dry-run', '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const proposalMine = JSON.parse(result.stdout);
  assert.equal(proposalMine.warnings.length, 1);
  assert.match(proposalMine.warnings[0].reason, /monitor verdict evidence changed/);
  assert.deepEqual(proposalMine.candidates, []);
  result = runCli(RUNS_CLI, ['validate', '--runs', runsDir, '--run-id', runId]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /monitor verdict evidence changed/);
  writeFileSync(acceptedVerdictPath, acceptedVerdictRaw, 'utf8');
  result = runCli(RUNS_CLI, ['validate', '--runs', runsDir, '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);

  const legacyRunId = 'run-pre-telemetry';
  const legacyRun = structuredClone(run);
  legacyRun.runId = legacyRunId;
  delete legacyRun.usage;
  delete legacyRun.telemetryProtocol;
  delete legacyRun.monitorGate;
  delete legacyRun.monitorVerdictEvidenceSha256;
  const indexPath = path.join(runsDir, 'run-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const currentEntry = index.runs.find((entry) => entry.runId === runId);
  const legacyEntry = {
    ...currentEntry,
    runId: legacyRunId,
    runRef: currentEntry.runRef.replace(`${runId}.json`, `${legacyRunId}.json`),
  };
  index.runs.unshift(legacyEntry);
  index.tasks.find((entry) => entry.taskId === legacyRun.taskId).runIds.unshift(legacyRunId);
  writeJson(path.join(runsDir, legacyEntry.runRef), legacyRun);
  writeJson(indexPath, index);
  writeJson(runSidecarPath(runsDir, legacyRunId, '.monitor-gate.json'), {
    required: true,
    requiredConcernFields: MONITOR_CONCERN_FIELDS,
    ruleContract: { source: 'none', ref: null, sha256: null, ruleIds: [] },
  });
  writeJson(runSidecarPath(runsDir, legacyRunId, '.monitor-verdict.json'), {
    verdict: 'confirm_done',
    rules_reviewed: [],
    rule_concerns: [],
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
    note: 'No enforceable project rule source was available.',
  });

  const reviewRunId = 'run-final-review';
  const reviewRun = structuredClone(run);
  reviewRun.runId = reviewRunId;
  reviewRun.runKind = 'final_acceptance_review';
  reviewRun.acceptanceReview = {
    required: true,
    criteria: [{ ref: 'product.success_criteria[0]', text: 'The behavior is accepted.' }],
  };
  reviewRun.usage = [];
  delete reviewRun.monitorGate;
  delete reviewRun.monitorVerdictEvidenceSha256;
  const reviewEntry = {
    ...currentEntry,
    runId: reviewRunId,
    runRef: currentEntry.runRef.replace(`${runId}.json`, `${reviewRunId}.json`),
  };
  index.runs.push(reviewEntry);
  const taskIndexEntry = index.tasks.find((entry) => entry.taskId === reviewRun.taskId);
  taskIndexEntry.runIds.push(reviewRunId);
  taskIndexEntry.latestRunId = reviewRunId;
  writeJson(path.join(runsDir, reviewEntry.runRef), reviewRun);
  writeJson(indexPath, index);

  mkdirSync(path.join(artifactRoot, 'eval'), { recursive: true });
  result = runCli(EVAL_CLI, ['digest', '--runs', runsDir, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const digest = JSON.parse(result.stdout);
  assert.equal(digest.selfImprovement.runs.total, 3);
  assert.equal(digest.selfImprovement.runs.autonomy.implementationRuns, 2);
  assert.equal(digest.selfImprovement.runs.autonomy.excludedReviewRuns, 1);
  assert.equal(digest.selfImprovement.runs.autonomy.autonomousCompletions, 0);
  assert.equal(digest.selfImprovement.runs.autonomy.eligibleRuns, 1);
  assert.equal(digest.selfImprovement.runs.autonomy.uninstrumentedRuns, 1);
  assert.equal(digest.selfImprovement.runs.autonomy.telemetryCoverageRate, 0.5);
  assert.equal(digest.selfImprovement.runs.autonomy.implementationDecisionInterruptions, 1);
  assert.equal(digest.selfImprovement.runs.autonomy.userCorrections, 1);
  assert.equal(digest.selfImprovement.runs.autonomy.gateReturns.validPrecision, 1);
  assert.equal(digest.selfImprovement.runs.usage.inputTokens, 121);
  assert.equal(digest.selfImprovement.runs.usage.totalTokens, 151);
  assert.equal(digest.selfImprovement.runs.usage.coverageRate, 0.333);
  assert.equal(digest.selfImprovement.runs.usage.byModelProfile['gpt-5.6-sol/high'].totalTokens, 150);
  assert.equal(digest.selfImprovement.runs.usage.byModelProfile.__proto__.totalTokens, 1);
  assert.equal(digest.selfImprovement.runs.usage.bySource.provider.totalTokens, 150);
  assert.equal(digest.selfImprovement.runs.usage.bySource.manual.totalTokens, 1);
  assert.equal(digest.selfImprovement.runs.monitor.ruleViolations, 0);
  assert.equal(digest.selfImprovement.runs.monitor.monitoredRuns, 2);
  assert.equal(digest.selfImprovement.runs.monitor.ruleReviewRuns, 1);
  assert.equal(digest.selfImprovement.runs.monitor.ruleReviewCoverageRate, 0.5);
});

test('a later non-monitor retry cannot erase an earlier bound monitor requirement', (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'p2a-monitor-retry-binding-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
  const graphPath = path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  const runsDir = path.join(artifactRoot, 'runs');

  let result = runCli(RUNS_CLI, [
    'start', '--graph', graphPath, '--runs', runsDir,
    '--task', 'task-001', '--run-id', 'run-monitor-first',
    '--agent-tool', 'codex', '--workspace', projectRoot, '--require-monitor',
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(RUNS_CLI, [
    'verify', '--runs', runsDir, '--run-id', 'run-monitor-first',
    '--workspace', projectRoot, '--test-command', 'true',
  ]);
  assert.equal(result.status, 0, result.stderr);
  writeJson(runSidecarPath(runsDir, 'run-monitor-first', '.monitor-verdict.json'), {
    verdict: 'confirm_done',
    rules_reviewed: [],
    rule_concerns: [],
    scope_concerns: [],
    verification_concerns: [],
    unmet_acceptance: [],
    needs_user_decision: [],
    note: 'No project rule source was available.',
  });
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', 'run-monitor-first', '--status', 'finished',
  ]);
  assert.equal(result.status, 0, result.stderr);

  result = runCli(RUNS_CLI, [
    'start', '--graph', graphPath, '--runs', runsDir,
    '--task', 'task-001', '--run-id', 'run-unmonitored-retry',
    '--agent-tool', 'codex', '--workspace', projectRoot,
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(RUNS_CLI, [
    'verify', '--runs', runsDir, '--run-id', 'run-unmonitored-retry',
    '--workspace', projectRoot, '--test-command', 'true',
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(RUNS_CLI, [
    'finish', '--graph', graphPath, '--runs', runsDir,
    '--run-id', 'run-unmonitored-retry', '--status', 'finished',
  ]);
  assert.equal(result.status, 0, result.stderr);
  result = runCli(TASKS_CLI, ['start', '--graph', graphPath, 'task-001']);
  assert.equal(result.status, 0, result.stderr);

  rmSync(runSidecarPath(runsDir, 'run-monitor-first', '.monitor-gate.json'));
  result = runCli(TASKS_CLI, ['done', '--graph', graphPath, 'task-001']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /monitor gate evidence for run-monitor-first is invalid/);
});
