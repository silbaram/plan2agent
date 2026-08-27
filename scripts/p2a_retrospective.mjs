/** Deterministic, bounded retrospective signals derived from current-iteration run evidence. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  assertRunMonitorGateBinding,
  assertRunMonitorVerdictBinding,
  normalizeMonitorVerdictData,
  readMonitorGateSidecar,
} from './p2a_monitor_gate.mjs';

const MAX_CANDIDATES = 32;
const MAX_BINDINGS = 64;
const FAILURE_RETRY_CLASSES = new Set([
  'environment_failure',
  'test_flake',
  'verification_failed',
]);

function safeIdPart(value) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

function stableSuffix(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_BINDINGS);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeCountSum(...values) {
  return values.reduce(
    (total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + safeCount(value)),
    0,
  );
}

function candidateCounts(runs, overrides = {}) {
  return {
    runs: safeCount(overrides.runs ?? runs.length),
    retries: safeCount(overrides.retries ?? Math.max(0, runs.length - 1)),
    failed: safeCount(overrides.failed ?? runs.filter((run) => run.status === 'failed').length),
    blocked: safeCount(overrides.blocked ?? runs.filter((run) => run.status === 'blocked').length),
    interruptions: safeCount(overrides.interruptions ?? runs.reduce(
      (count, run) => safeCountSum(
        count,
        Array.isArray(run.interruptions) ? run.interruptions.length : 0,
      ),
      0,
    )),
  };
}

function bindingForRuns(runs) {
  return {
    taskIds: sortedUnique(runs.map((run) => run.taskId)),
    runIds: sortedUnique(runs.map((run) => run.runId)),
  };
}

function candidate({
  projectId,
  iterationId,
  signal,
  domain,
  category,
  unit,
  baseline = null,
  budget = null,
  observed,
  delta = null,
  threshold,
  runs = [],
  counts = null,
  targetArea,
  recommendedChange,
  identity = null,
}) {
  const idSource = {
    projectId,
    iterationId,
    signal,
    category,
    identity,
  };
  return {
    schema_version: 'p2a.retrospective_candidate.v1',
    candidateId: `retro-${safeIdPart(iterationId)}-${safeIdPart(signal)}-${stableSuffix(idSource)}`,
    projectId,
    iterationId,
    signal,
    domain,
    binding: bindingForRuns(runs),
    measurement: {
      category,
      unit,
      baseline,
      budget,
      observed: safeCount(observed),
      delta,
      threshold: safeCount(threshold),
    },
    counts: counts ?? candidateCounts(runs),
    targetArea,
    recommendedChange,
  };
}

function currentSummary(retrospective, iterationId) {
  const summaries = Array.isArray(retrospective?.iterations)
    ? retrospective.iterations
    : [];
  return summaries.find((summary) => summary?.iterationId === iterationId) ?? null;
}

function implementationRuns(runs, iterationId) {
  return runs.filter((run) => (
    run?.iterationId === iterationId
    && !run.runKind
    && ['finished', 'failed', 'blocked'].includes(run.status)
  ));
}

function performanceCandidates(projectId, iterationId, runs, policy) {
  const candidates = [];
  for (const type of ['test', 'lint', 'typecheck', 'custom']) {
    const measurements = runs.flatMap((run) => (
      run.status === 'finished'
        ? (run.verification ?? [])
          .filter((verification) => (
            verification?.type === type
            && verification.status === 'passed'
            && Number.isSafeInteger(verification.durationMs)
            && verification.durationMs >= 0
          ))
          .map((verification) => ({ run, durationMs: verification.durationMs }))
        : []
    ));
    if (!measurements.length) continue;
    const peak = measurements.reduce((highest, measurement) => (
      measurement.durationMs > highest.durationMs ? measurement : highest
    ));
    const budget = policy.verificationBudgetsMs[type];
    if (budget && peak.durationMs > budget) {
      candidates.push(candidate({
        projectId,
        iterationId,
        signal: 'slow_verification',
        domain: 'product_code',
        category: type,
        unit: 'milliseconds',
        budget,
        observed: peak.durationMs,
        delta: peak.durationMs - budget,
        threshold: budget,
        runs: [peak.run],
        targetArea: 'product_verification',
        recommendedChange: `Profile the ${type} verification path and reduce it below the configured ${budget} ms budget.`,
        identity: type,
      }));
    }
    const baseline = policy.verificationBaselinesMs[type];
    if (baseline) {
      const threshold = Math.ceil(
        baseline * (1 + (policy.performanceRegressionPercent / 100)),
      );
      if (peak.durationMs > threshold) {
        candidates.push(candidate({
          projectId,
          iterationId,
          signal: 'performance_regression',
          domain: 'product_code',
          category: type,
          unit: 'milliseconds',
          baseline,
          observed: peak.durationMs,
          delta: peak.durationMs - baseline,
          threshold,
          runs: [peak.run],
          targetArea: 'product_verification',
          recommendedChange: `Investigate the ${type} regression and restore duration to the approved baseline range.`,
          identity: type,
        }));
      }
    }
  }
  return candidates;
}

function statusCandidates(projectId, iterationId, runs, summary) {
  return ['failed', 'blocked'].flatMap((status) => {
    const matching = runs.filter((run) => run.status === status);
    const summarized = safeCount(summary?.statusCounts?.[status]);
    const observed = safeCountSum(matching.length, summarized);
    if (!observed) return [];
    return [candidate({
      projectId,
      iterationId,
      signal: status === 'failed' ? 'failed_run' : 'blocked_run',
      domain: 'p2a_process',
      category: 'run_status',
      unit: 'count',
      observed,
      threshold: 1,
      runs: matching,
      counts: candidateCounts(matching, {
        runs: safeCountSum(matching.length, summary?.runCount),
        [status]: observed,
      }),
      targetArea: 'execution_process',
      recommendedChange: `Review the structured ${status} run metadata before deciding whether a process guard is warranted.`,
      identity: status,
    })];
  });
}

function verificationGapCandidate(projectId, iterationId, runs) {
  const gaps = runs.filter((run) => (
    run.status === 'finished'
    && (!Array.isArray(run.verification) || run.verification.length === 0)
  ));
  if (!gaps.length) return [];
  return [candidate({
    projectId,
    iterationId,
    signal: 'verification_gap',
    domain: 'p2a_process',
    category: 'run_status',
    unit: 'count',
    observed: gaps.length,
    threshold: 1,
    runs: gaps,
    targetArea: 'execution_process',
    recommendedChange: 'Require conclusive verification evidence or an explicit supported skip path before comparable run closeout.',
  })];
}

function retryCandidates(projectId, iterationId, runs, summary, policy) {
  const byTask = new Map();
  for (const run of runs) {
    if (!byTask.has(run.taskId)) byTask.set(run.taskId, []);
    byTask.get(run.taskId).push(run);
  }
  const candidates = [];
  for (const [taskId, taskRuns] of byTask) {
    const retryCause = taskRuns.some((run) => (
      FAILURE_RETRY_CLASSES.has(run.failure?.class)
      || (run.verification ?? []).some((verification) => (
        verification?.scope === 'full'
        && ['failed', 'unavailable'].includes(verification.status)
      ))
    ));
    if (taskRuns.length < policy.retryThreshold || !retryCause) continue;
    candidates.push(candidate({
      projectId,
      iterationId,
      signal: 'retry_overhead',
      domain: 'p2a_process',
      category: 'retry_attempts',
      unit: 'count',
      observed: taskRuns.length - 1,
      threshold: policy.retryThreshold - 1,
      runs: taskRuns,
      targetArea: 'execution_process',
      recommendedChange: 'Reduce full-scope retry overhead by adding an earlier environment, flake, or verification preflight.',
      identity: taskId,
    }));
  }
  const summarizedRetries = safeCount(summary?.reasonCounts?.superseded);
  if (
    summarizedRetries >= policy.retryThreshold - 1
    && !candidates.length
    && runs.some((run) => FAILURE_RETRY_CLASSES.has(run.failure?.class))
  ) {
    candidates.push(candidate({
      projectId,
      iterationId,
      signal: 'retry_overhead',
      domain: 'p2a_process',
      category: 'retry_attempts',
      unit: 'count',
      observed: summarizedRetries,
      threshold: policy.retryThreshold - 1,
      runs: runs.filter((run) => FAILURE_RETRY_CLASSES.has(run.failure?.class)),
      counts: candidateCounts(runs, {
        runs: safeCountSum(runs.length, summary?.runCount),
        retries: summarizedRetries,
      }),
      targetArea: 'execution_process',
      recommendedChange: 'Reduce full-scope retry overhead by adding an earlier environment, flake, or verification preflight.',
      identity: 'summarized',
    }));
  }
  return candidates;
}

function correctionCandidates(projectId, iterationId, runs, summary, policy) {
  const userCorrectionRuns = runs.filter((run) => (
    (run.interruptions ?? []).some((item) => item?.type === 'user_correction')
  ));
  const summarizedCorrections = safeCount(summary?.interruptionCounts?.user_correction);
  const correctionCount = userCorrectionRuns.reduce(
    (count, run) => safeCountSum(
      count,
      run.interruptions.filter((item) => item?.type === 'user_correction').length,
    ),
    summarizedCorrections,
  );
  const candidates = [];
  if (correctionCount > 0) {
    candidates.push(candidate({
      projectId,
      iterationId,
      signal: 'explicit_correction',
      domain: 'p2a_process',
      category: 'interruption_pattern',
      unit: 'count',
      observed: correctionCount,
      threshold: 1,
      runs: userCorrectionRuns,
      counts: candidateCounts(userCorrectionRuns, { interruptions: correctionCount }),
      targetArea: 'execution_process',
      recommendedChange: 'Review the correction category and add a bounded instruction or preflight only if it generalizes.',
      identity: 'user_correction',
    }));
  }

  const failureGroups = new Map();
  for (const run of runs) {
    const failureClass = run.failure?.class;
    if (!failureClass) continue;
    if (!failureGroups.has(failureClass)) failureGroups.set(failureClass, []);
    failureGroups.get(failureClass).push(run);
  }
  for (const [failureClass, matching] of failureGroups) {
    if (matching.length < policy.repeatedDefectThreshold) continue;
    candidates.push(candidate({
      projectId,
      iterationId,
      signal: 'repeated_process_defect',
      domain: 'p2a_process',
      category: 'failure_pattern',
      unit: 'count',
      observed: matching.length,
      threshold: policy.repeatedDefectThreshold,
      runs: matching,
      targetArea: 'execution_process',
      recommendedChange: `Add one bounded guard for the repeated ${failureClass} failure category.`,
      identity: failureClass,
    }));
  }

  const invalidReturnRuns = runs.filter((run) => (
    (run.interruptions ?? []).some((item) => (
      item?.type === 'gate_return' && item.assessment === 'invalid'
    ))
  ));
  const invalidReturnCount = invalidReturnRuns.reduce(
    (count, run) => safeCountSum(count, run.interruptions.filter((item) => (
      item?.type === 'gate_return' && item.assessment === 'invalid'
    )).length),
    safeCount(summary?.interruptionCounts?.gate_return_invalid),
  );
  if (invalidReturnCount >= policy.repeatedDefectThreshold) {
    candidates.push(candidate({
      projectId,
      iterationId,
      signal: 'repeated_process_defect',
      domain: 'p2a_process',
      category: 'interruption_pattern',
      unit: 'count',
      observed: invalidReturnCount,
      threshold: policy.repeatedDefectThreshold,
      runs: invalidReturnRuns,
      counts: candidateCounts(invalidReturnRuns, { interruptions: invalidReturnCount }),
      targetArea: 'execution_process',
      recommendedChange: 'Clarify the gate-return boundary that repeatedly produced invalid process interruptions.',
      identity: 'gate_return_invalid',
    }));
  }
  return candidates;
}

function monitorCandidates(projectId, iterationId, runs, monitorMismatchRunIds) {
  const mismatchIds = new Set(monitorMismatchRunIds ?? []);
  const matching = runs.filter((run) => mismatchIds.has(run.runId));
  if (!matching.length) return [];
  return [candidate({
    projectId,
    iterationId,
    signal: 'monitor_mismatch',
    domain: 'p2a_process',
    category: 'monitor_verdict',
    unit: 'count',
    observed: matching.length,
    threshold: 1,
    runs: matching,
    targetArea: 'execution_process',
    recommendedChange: 'Align monitor rejection closeout with the structured run failure contract.',
  })];
}

export function buildRetrospectiveCandidates({
  projectId,
  iterationId,
  runs = [],
  retrospective = null,
  policy,
  monitorMismatchRunIds = [],
}) {
  if (!policy?.enabled) return [];
  const currentRuns = implementationRuns(runs, iterationId);
  const summary = currentSummary(retrospective, iterationId);
  const candidates = [
    ...performanceCandidates(projectId, iterationId, currentRuns, policy),
    ...statusCandidates(projectId, iterationId, currentRuns, summary),
    ...verificationGapCandidate(projectId, iterationId, currentRuns),
    ...retryCandidates(projectId, iterationId, currentRuns, summary, policy),
    ...correctionCandidates(projectId, iterationId, currentRuns, summary, policy),
    ...monitorCandidates(projectId, iterationId, currentRuns, monitorMismatchRunIds),
  ];
  return candidates
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .slice(0, MAX_CANDIDATES);
}

export function retrospectiveMonitorMismatchRunIds(runsDir, runs = []) {
  if (!runsDir) return [];
  const mismatches = [];
  for (const run of runs) {
    try {
      const gate = readMonitorGateSidecar(runsDir, run.runId);
      if (!gate?.required || !gate.verdictPath) continue;
      assertRunMonitorGateBinding(run, gate);
      const verdictPath = path.resolve(runsDir, gate.verdictPath);
      const relative = path.relative(realpathSync(runsDir), realpathSync(verdictPath));
      if (
        !relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || !existsSync(verdictPath)
        || !lstatSync(verdictPath).isFile()
      ) continue;
      const contents = readFileSync(verdictPath);
      assertRunMonitorVerdictBinding(run, contents);
      const verdict = normalizeMonitorVerdictData(JSON.parse(contents.toString('utf8')), {
        requiredConcernFields: gate.requiredConcernFields,
        requiredRuleIds: gate.ruleContract?.ruleIds,
        requireRulesReviewed: gate.ruleContract !== null,
      });
      if (
        !gate.acceptedVerdicts.includes(verdict.verdict)
        && run.failure?.source !== 'monitor'
      ) mismatches.push(run.runId);
    } catch {
      // Invalid sidecars remain the responsibility of run validation. Candidate
      // calculation never turns unreadable evidence into a positive signal.
    }
  }
  return sortedUnique(mismatches);
}
