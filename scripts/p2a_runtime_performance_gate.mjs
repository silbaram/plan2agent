/** Evaluate the declared final runtime-routing thresholds against a frozen trace baseline. */

const PACKET_MANAGED_SCENARIOS = ['direct-execution', 'planned-retry'];

function scenarioMetrics(summary, scenarioId) {
  return summary.scenarios?.find((item) => item.scenarioId === scenarioId)?.metrics ?? null;
}

function sumScenarioMetric(scenarios, field) {
  const values = scenarios.map((metrics) => metrics?.[field]);
  return values.every(Number.isFinite)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function packetAttributionComplete(metrics) {
  return metrics?.packetManagedAttributionComplete === true;
}

export function validatePerformanceReference(summary, expected) {
  if (summary?.schema_version !== 'p2a.context_engineering_codex_trace_summary.v1') {
    throw new Error('performance reference must use p2a.context_engineering_codex_trace_summary.v1');
  }
  for (const field of ['provider', 'model', 'reasoning', 'repetitions']) {
    if (summary.scope?.[field] !== expected[field]) {
      throw new Error(`performance reference ${field} mismatch: expected ${expected[field]}; got ${summary.scope?.[field]}`);
    }
  }
  const expectedScenarios = [...expected.scenarios].sort();
  const actualScenarios = [...(summary.scope?.scenarios ?? [])].sort();
  if (JSON.stringify(actualScenarios) !== JSON.stringify(expectedScenarios)) {
    throw new Error(`performance reference scenario mismatch: expected ${expectedScenarios.join(',')}; got ${actualScenarios.join(',')}`);
  }
  if (!summary.coverageComplete || !summary.traceComplete || !summary.candidateAllPass) {
    throw new Error('performance reference must have complete passing run and trace coverage');
  }
  for (const field of ['inputTokens', 'durationMs', 'uncachedInputTokens']) {
    if (!Number.isFinite(summary.metrics?.[field])) {
      throw new Error(`performance reference metric ${field} must be finite`);
    }
  }
  return summary;
}

export function evaluateRuntimeRoutingPerformance(reference, candidate, options = {}) {
  const checks = [];
  const excludedChecks = [];
  const exclusions = options.excludedChecks ?? {};
  const add = (id, pass, expected, actual) => {
    if (Object.hasOwn(exclusions, id)) {
      excludedChecks.push({ id, reason: exclusions[id] });
      return;
    }
    checks.push({ id, pass, expected, actual });
  };
  const directReference = scenarioMetrics(reference, 'direct-execution');
  const directCandidate = candidate.scenarioMetrics.get('direct-execution');
  const packetScenarios = PACKET_MANAGED_SCENARIOS.map(
    (scenarioId) => candidate.scenarioMetrics.get(scenarioId),
  );
  const packetAttributionIsComplete = packetScenarios.every(packetAttributionComplete);
  const packetRepeatedSourceReads = sumScenarioMetric(packetScenarios, 'packetManagedRepeatedSourceReads');
  const packetUnattributedReads = sumScenarioMetric(
    packetScenarios,
    'packetManagedUnattributedReadOperations',
  );
  const packetUnknownOperations = sumScenarioMetric(packetScenarios, 'packetManagedUnknownOperations');

  add(
    'direct_median_tool_operations',
    Number.isFinite(directCandidate?.medians?.toolOperations)
      && Number.isFinite(directReference?.medians?.toolOperations)
      && directCandidate.medians.toolOperations <= directReference.medians.toolOperations - 1,
    `<= ${directReference?.medians?.toolOperations - 1}`,
    directCandidate?.medians?.toolOperations ?? null,
  );
  add(
    'direct_median_input_tokens',
    Number.isFinite(directCandidate?.medians?.inputTokens)
      && Number.isFinite(directReference?.medians?.inputTokens)
      && directCandidate.medians.inputTokens <= directReference.medians.inputTokens * 0.9,
    `<= ${Math.floor((directReference?.medians?.inputTokens ?? 0) * 0.9)}`,
    directCandidate?.medians?.inputTokens ?? null,
  );
  add(
    'aggregate_input_tokens',
    Number.isFinite(candidate.metrics.inputTokens)
      && Number.isFinite(reference.metrics.inputTokens)
      && candidate.metrics.inputTokens <= reference.metrics.inputTokens,
    `<= ${reference.metrics.inputTokens}`,
    candidate.metrics.inputTokens,
  );
  add(
    'aggregate_elapsed_ms',
    Number.isFinite(candidate.metrics.durationMs)
      && Number.isFinite(reference.metrics.durationMs)
      && candidate.metrics.durationMs <= reference.metrics.durationMs,
    `<= ${reference.metrics.durationMs}`,
    candidate.metrics.durationMs,
  );
  add(
    'aggregate_uncached_input_tokens',
    Number.isFinite(candidate.metrics.uncachedInputTokens)
      && Number.isFinite(reference.metrics.uncachedInputTokens)
      && candidate.metrics.uncachedInputTokens <= reference.metrics.uncachedInputTokens * 1.05,
    `<= ${Math.floor(reference.metrics.uncachedInputTokens * 1.05)}`,
    candidate.metrics.uncachedInputTokens,
  );
  for (const referenceScenario of reference.scenarios ?? []) {
    const actual = candidate.scenarioMetrics.get(referenceScenario.scenarioId)?.medians?.inputTokens;
    const baseline = referenceScenario.metrics?.medians?.inputTokens;
    add(
      `scenario_median_input:${referenceScenario.scenarioId}`,
      Number.isFinite(actual) && Number.isFinite(baseline) && actual <= baseline * 1.1,
      `<= ${Math.floor((baseline ?? 0) * 1.1)}`,
      actual ?? null,
    );
  }
  add(
    'packet_managed_source_attribution_complete',
    packetAttributionIsComplete,
    true,
    packetAttributionIsComplete,
  );
  add(
    'packet_managed_repeated_source_reads',
    packetAttributionIsComplete
      && Number.isFinite(packetRepeatedSourceReads)
      && packetRepeatedSourceReads === 0,
    0,
    packetRepeatedSourceReads,
  );
  add(
    'packet_managed_unattributed_content_reads',
    Number.isFinite(packetUnattributedReads) && packetUnattributedReads === 0,
    0,
    packetUnattributedReads,
  );
  add(
    'packet_managed_unknown_operations',
    Number.isFinite(packetUnknownOperations) && packetUnknownOperations === 0,
    0,
    packetUnknownOperations,
  );
  return {
    schema_version: 'p2a.context_engineering_runtime_performance_gate.v2',
    verdict: checks.every((check) => check.pass) ? 'pass' : 'fail',
    checks,
    ...(excludedChecks.length ? { excludedChecks } : {}),
  };
}
