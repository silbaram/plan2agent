import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateAbRuns } from '../scripts/p2a_ab_metrics.mjs';
import { evaluateRuntimeRoutingPerformance } from '../scripts/p2a_runtime_performance_gate.mjs';

function run({
  scenarioId,
  status = 'available',
  supported = true,
  toolOperations = 1,
  repeatedSourceReads = 0,
  unattributedReadOperations = 0,
  unknownOperations = 0,
  packetManagedAttributionComplete = true,
  packetManagedRepeatedSourceReads = 0,
  packetManagedUnattributedReadOperations = 0,
  packetManagedUnknownOperations = 0,
  usage = { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 },
}) {
  return {
    variant: 'candidate',
    scenarioId,
    grade: { verdict: 'pass' },
    metadata: {
      execution: {
        usage,
        durationMs: 50,
        toolCalls: toolOperations,
        toolFailures: 0,
        toolTrace: {
          status,
          eventShape: { supported },
          metrics: {
            toolOperations,
            contentReadOperations: 1,
            metadataInspectOperations: 0,
            uniqueSourcesRead: 1,
            sourceReadOccurrences: 1,
            repeatedSourceReads,
            unattributedReadOperations,
            unknownOperations,
            packetManagedAttributionComplete,
            packetManagedRepeatedSourceReads,
            packetManagedUnattributedReadOperations,
            packetManagedUnknownOperations,
          },
        },
      },
    },
  };
}

test('A/B aggregation keeps event metrics when source attribution is partial', () => {
  const runs = [
    run({ scenarioId: 'direct-execution' }),
    run({
      scenarioId: 'direct-execution',
      status: 'partial',
      toolOperations: 2,
      unattributedReadOperations: 1,
      unknownOperations: 1,
    }),
  ];

  const metrics = aggregateAbRuns(runs, 'candidate', 'direct-execution');
  assert.equal(metrics.traceCoverage.eventShapeComplete, true);
  assert.equal(metrics.traceCoverage.attributionComplete, false);
  assert.equal(metrics.traceCoverage.partialRuns, 1);
  assert.equal(metrics.toolOperations, 3);
  assert.equal(metrics.medians.toolOperations, 1.5);
  assert.equal(metrics.repeatedSourceReads, 0);
  assert.equal(metrics.unattributedReadOperations, 1);
  assert.equal(metrics.unknownOperations, 1);
});

test('A/B aggregation blocks tool-operation claims for unsupported event shapes', () => {
  const metrics = aggregateAbRuns([
    run({ scenarioId: 'direct-execution', status: 'unsupported', supported: false }),
  ], 'candidate', 'direct-execution');

  assert.equal(metrics.traceCoverage.eventShapeComplete, false);
  assert.equal(metrics.toolOperations, null);
  assert.equal(metrics.medians.toolOperations, null);
});

test('A/B aggregation preserves missing and invalid usage as unavailable', () => {
  const missing = run({ scenarioId: 'direct-execution', usage: null });
  const invalidUncached = run({
    scenarioId: 'direct-execution',
    usage: { input_tokens: 10, cached_input_tokens: 20, output_tokens: 1 },
  });
  const metrics = aggregateAbRuns([missing, invalidUncached], 'candidate', 'direct-execution');

  assert.equal(metrics.inputTokens, null);
  assert.equal(metrics.uncachedInputTokens, null);
  assert.equal(metrics.medians.inputTokens, null);
  assert.equal(metrics.measurementCoverage.inputTokens.complete, false);
  assert.equal(metrics.measurementCoverage.uncachedInputTokens.complete, false);
});

function referenceSummary() {
  const scenario = (scenarioId, inputTokens, toolOperations) => ({
    scenarioId,
    metrics: {
      medians: { inputTokens, toolOperations },
    },
  });
  return {
    metrics: {
      inputTokens: 1000,
      durationMs: 1000,
      uncachedInputTokens: 800,
    },
    scenarios: [
      scenario('gate-b-spec', 100, 2),
      scenario('direct-execution', 100, 2),
      scenario('planned-retry', 100, 3),
    ],
  };
}

function passingCandidateMetrics() {
  const scenario = (inputTokens, toolOperations) => ({
    inputTokens: 250,
    durationMs: 250,
    uncachedInputTokens: 180,
    repeatedSourceReads: 0,
    unattributedReadOperations: 0,
    unknownOperations: 0,
    packetManagedAttributionComplete: true,
    packetManagedRepeatedSourceReads: 0,
    packetManagedUnattributedReadOperations: 0,
    packetManagedUnknownOperations: 0,
    traceCoverage: { attributionComplete: true },
    medians: { inputTokens, toolOperations },
  });
  return {
    metrics: {
      inputTokens: 750,
      durationMs: 750,
      uncachedInputTokens: 540,
    },
    scenarioMetrics: new Map([
      ['gate-b-spec', scenario(90, 2)],
      ['direct-execution', scenario(90, 1)],
      ['planned-retry', scenario(90, 1)],
    ]),
  };
}

test('runtime gate ignores Gate B attribution for packet-managed source checks', () => {
  const candidate = passingCandidateMetrics();
  candidate.scenarioMetrics.set('gate-b-spec', {
    ...candidate.scenarioMetrics.get('gate-b-spec'),
    packetManagedRepeatedSourceReads: 4,
    packetManagedUnattributedReadOperations: 2,
    packetManagedUnknownOperations: 2,
    packetManagedAttributionComplete: false,
    traceCoverage: { attributionComplete: false },
  });

  const gate = evaluateRuntimeRoutingPerformance(referenceSummary(), candidate);
  assert.equal(gate.verdict, 'pass');
  assert.equal(
    gate.checks.find((check) => check.id === 'packet_managed_repeated_source_reads').actual,
    0,
  );
});

test('runtime gate fails a packet-managed attribution gap with numeric evidence', () => {
  const candidate = passingCandidateMetrics();
  candidate.scenarioMetrics.set('direct-execution', {
    ...candidate.scenarioMetrics.get('direct-execution'),
    packetManagedUnattributedReadOperations: 1,
    packetManagedUnknownOperations: 1,
    packetManagedAttributionComplete: false,
    traceCoverage: { attributionComplete: false },
  });

  const gate = evaluateRuntimeRoutingPerformance(referenceSummary(), candidate);
  assert.equal(gate.verdict, 'fail');
  assert.deepEqual(
    gate.checks
      .filter((check) => check.id.startsWith('packet_managed_'))
      .map((check) => [check.id, check.pass, check.actual]),
    [
      ['packet_managed_source_attribution_complete', false, false],
      ['packet_managed_repeated_source_reads', false, 0],
      ['packet_managed_unattributed_content_reads', false, 1],
      ['packet_managed_unknown_operations', false, 1],
    ],
  );
});

test('runtime gate fails when aggregate performance measurements are unavailable', () => {
  const candidate = passingCandidateMetrics();
  candidate.metrics.inputTokens = null;
  candidate.metrics.durationMs = null;
  candidate.metrics.uncachedInputTokens = null;

  const gate = evaluateRuntimeRoutingPerformance(referenceSummary(), candidate);
  assert.equal(gate.verdict, 'fail');
  assert.deepEqual(
    gate.checks
      .filter((check) => check.id.startsWith('aggregate_'))
      .map((check) => [check.id, check.pass, check.actual]),
    [
      ['aggregate_input_tokens', false, null],
      ['aggregate_elapsed_ms', false, null],
      ['aggregate_uncached_input_tokens', false, null],
    ],
  );
});

test('runtime gate records provider-specific measurement exclusions without duplicating gate logic', () => {
  const candidate = passingCandidateMetrics();
  candidate.metrics.uncachedInputTokens = null;
  const reason = 'Provider does not expose a reliable uncached input metric.';

  const gate = evaluateRuntimeRoutingPerformance(referenceSummary(), candidate, {
    excludedChecks: { aggregate_uncached_input_tokens: reason },
  });

  assert.equal(gate.verdict, 'pass');
  assert.equal(
    gate.checks.some((check) => check.id === 'aggregate_uncached_input_tokens'),
    false,
  );
  assert.deepEqual(gate.excludedChecks, [{ id: 'aggregate_uncached_input_tokens', reason }]);
});
