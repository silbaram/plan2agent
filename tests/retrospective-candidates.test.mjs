import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultRetrospectiveSignals,
  resolveRetrospectiveSignals,
} from '../scripts/p2a_project_config.mjs';
import { buildRetrospectiveCandidates } from '../scripts/p2a_retrospective.mjs';
import { validateRetrospectiveCandidateData } from '../scripts/validate_artifacts.mjs';

function policy(overrides = {}) {
  return {
    ...defaultRetrospectiveSignals(),
    enabled: true,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    runId: overrides.runId ?? 'run-task-001-001',
    taskId: overrides.taskId ?? 'task-001',
    iterationId: 'v20',
    status: overrides.status ?? 'finished',
    runKind: null,
    verification: overrides.verification ?? [],
    interruptions: overrides.interruptions ?? [],
    ...(overrides.failure ? { failure: overrides.failure } : {}),
    notes: ['SECRET_NOTE_VALUE'],
    stdoutTail: 'SECRET_STDOUT_VALUE',
  };
}

test('retrospective signal policy defaults inactive and validates deterministic thresholds', () => {
  assert.deepEqual(resolveRetrospectiveSignals({}), defaultRetrospectiveSignals());
  assert.throws(
    () => resolveRetrospectiveSignals({ runTracking: 'invalid' }),
    /runTracking must be an object/,
  );
  assert.throws(
    () => resolveRetrospectiveSignals({
      runTracking: { retrospectiveSignals: { enabled: true, verificationBudgetsMs: { test: 0 } } },
    }),
    /must be a positive safe integer/,
  );
  assert.throws(
    () => resolveRetrospectiveSignals({
      runTracking: { retrospectiveSignals: { enabled: true, retryThreshold: 1 } },
    }),
    /retryThreshold must be an integer between 2 and 1000/,
  );
});

test('normal finished verification produces bounded performance candidates without raw values', () => {
  const source = run({
    verification: [{
      type: 'test',
      status: 'passed',
      durationMs: 1500,
      command: 'token=SECRET_COMMAND_VALUE npm test',
      stdoutTail: 'SECRET_OUTPUT_VALUE',
      stderrTail: 'SECRET_ERROR_VALUE',
    }],
    interruptions: [{
      type: 'user_correction',
      summary: 'SECRET_CORRECTION_VALUE',
      assessment: 'not_applicable',
    }],
  });
  const candidates = buildRetrospectiveCandidates({
    projectId: 'sample',
    iterationId: 'v20',
    runs: [source],
    policy: policy({
      verificationBudgetsMs: { test: 1000 },
      verificationBaselinesMs: { test: 800 },
      performanceRegressionPercent: 25,
    }),
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.signal).sort(),
    ['explicit_correction', 'performance_regression', 'slow_verification'],
  );
  for (const candidate of candidates) validateRetrospectiveCandidateData(candidate);
  const serialized = JSON.stringify(candidates);
  assert.doesNotMatch(serialized, /SECRET_|token=|npm test/);
});

test('retry and repeated defect signals use current runs plus bounded active-only summary', () => {
  const failure = {
    class: 'environment_failure',
    retryable: 'yes',
    needsUserDecision: false,
    source: 'owner',
  };
  const runs = [
    run({ runId: 'run-task-001-001', status: 'failed', failure }),
    run({ runId: 'run-task-001-002', status: 'blocked', failure }),
  ];
  const retrospective = {
    iterations: [{
      iterationId: 'v20',
      runCount: 1,
      reasonCounts: { superseded: 1, completed_maintenance: 0 },
      statusCounts: { finished: 1, failed: 1, blocked: 0 },
      verificationCount: 0,
      verificationDuration: { sampleCount: 0, totalMs: 0, maxMs: 0 },
      verificationStatusCounts: {
        passed: 0,
        failed: 0,
        skipped: 0,
        not_run: 0,
        unavailable: 0,
      },
      interruptionCounts: {
        implementation_decision: 0,
        user_correction: 1,
        gate_return_valid: 0,
        gate_return_invalid: 0,
      },
    }],
  };
  const candidates = buildRetrospectiveCandidates({
    projectId: 'sample',
    iterationId: 'v20',
    runs,
    retrospective,
    policy: policy({ retryThreshold: 2, repeatedDefectThreshold: 2 }),
  });
  const signals = candidates.map((candidate) => candidate.signal);
  for (const expected of [
    'failed_run',
    'blocked_run',
    'retry_overhead',
    'repeated_process_defect',
    'explicit_correction',
  ]) assert.ok(signals.includes(expected), `missing ${expected}`);
  assert.equal(
    candidates.find((candidate) => candidate.signal === 'failed_run').measurement.observed,
    2,
  );
  for (const candidate of candidates) validateRetrospectiveCandidateData(candidate);
});

test('disabled retrospective policy produces no closeout candidates', () => {
  assert.deepEqual(buildRetrospectiveCandidates({
    projectId: 'sample',
    iterationId: 'v20',
    runs: [run({ status: 'failed' })],
    policy: defaultRetrospectiveSignals(),
  }), []);
});
