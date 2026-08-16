function median(values) {
  const available = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!available.length) return null;
  const middle = Math.floor(available.length / 2);
  return available.length % 2
    ? available[middle]
    : (available[middle - 1] + available[middle]) / 2;
}

function traceMetric(run, field) {
  const value = run.metadata?.execution?.toolTrace?.metrics?.[field];
  return Number.isFinite(value) ? value : null;
}

function sumComplete(values) {
  return values.length > 0 && values.every(Number.isFinite)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

function finiteMetric(value) {
  return Number.isFinite(value) ? value : null;
}

function uncachedInputTokens(run) {
  const usage = run.metadata?.execution?.usage;
  if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.cached_input_tokens)) {
    return null;
  }
  const value = usage.input_tokens - usage.cached_input_tokens;
  return value >= 0 ? value : null;
}

function metricCoverage(values) {
  const availableRuns = values.filter(Number.isFinite).length;
  return {
    availableRuns,
    expectedRuns: values.length,
    complete: values.length > 0 && availableRuns === values.length,
  };
}

export function aggregateAbRuns(runs, variant, scenarioId = null) {
  const selected = runs.filter((run) => (
    run.variant === variant && (!scenarioId || run.scenarioId === scenarioId)
  ));
  const traces = selected.map((run) => run.metadata?.execution?.toolTrace ?? null);
  const availableRuns = traces.filter((trace) => trace?.status === 'available').length;
  const partialRuns = traces.filter((trace) => trace?.status === 'partial').length;
  const unsupportedRuns = traces.filter((trace) => trace?.status === 'unsupported').length;
  const missingRuns = traces.filter((trace) => trace === null).length;
  const eventShapeComplete = selected.length > 0 && traces.every(
    (trace) => trace?.eventShape?.supported === true,
  );
  const attributionComplete = selected.length > 0 && availableRuns === selected.length;
  const metricValues = (field) => selected.map((run) => traceMetric(run, field));
  const runMetric = (selector) => selected.map(selector);
  const measurements = {
    inputTokens: runMetric((run) => finiteMetric(run.metadata?.execution?.usage?.input_tokens)),
    cachedInputTokens: runMetric((run) => finiteMetric(run.metadata?.execution?.usage?.cached_input_tokens)),
    uncachedInputTokens: runMetric(uncachedInputTokens),
    outputTokens: runMetric((run) => finiteMetric(run.metadata?.execution?.usage?.output_tokens)),
    durationMs: runMetric((run) => finiteMetric(run.metadata?.execution?.durationMs)),
    toolCalls: runMetric((run) => finiteMetric(run.metadata?.execution?.toolCalls)),
    toolFailures: runMetric((run) => finiteMetric(run.metadata?.execution?.toolFailures)),
  };
  const measurementCoverage = Object.fromEntries(
    Object.entries(measurements).map(([field, values]) => [field, metricCoverage(values)]),
  );
  measurementCoverage.complete = Object.values(measurementCoverage).every(
    (coverage) => coverage.complete === true,
  );
  const packetManagedAttributionComplete = selected.length > 0 && traces.every(
    (trace) => trace?.metrics?.packetManagedAttributionComplete === true,
  );

  return {
    runs: selected.length,
    passed: selected.filter((run) => run.grade?.verdict === 'pass').length,
    failed: selected.filter((run) => run.grade?.verdict !== 'pass').length,
    inputTokens: sumComplete(measurements.inputTokens),
    cachedInputTokens: sumComplete(measurements.cachedInputTokens),
    uncachedInputTokens: sumComplete(measurements.uncachedInputTokens),
    outputTokens: sumComplete(measurements.outputTokens),
    durationMs: sumComplete(measurements.durationMs),
    toolCalls: sumComplete(measurements.toolCalls),
    toolFailures: sumComplete(measurements.toolFailures),
    measurementCoverage,
    traceCoverage: {
      availableRuns,
      partialRuns,
      unsupportedRuns,
      missingRuns,
      unavailableRuns: selected.length - availableRuns,
      eventShapeComplete,
      attributionComplete,
      packetManagedAttributionComplete,
      complete: attributionComplete,
    },
    toolOperations: eventShapeComplete ? sumComplete(metricValues('toolOperations')) : null,
    contentReadOperations: sumComplete(metricValues('contentReadOperations')),
    metadataInspectOperations: sumComplete(metricValues('metadataInspectOperations')),
    uniqueSourcesRead: sumComplete(metricValues('uniqueSourcesRead')),
    sourceReadOccurrences: sumComplete(metricValues('sourceReadOccurrences')),
    repeatedSourceReads: sumComplete(metricValues('repeatedSourceReads')),
    unattributedReadOperations: sumComplete(metricValues('unattributedReadOperations')),
    unknownOperations: sumComplete(metricValues('unknownOperations')),
    packetManagedAttributionComplete,
    packetManagedRepeatedSourceReads: sumComplete(metricValues('packetManagedRepeatedSourceReads')),
    packetManagedUnattributedReadOperations: sumComplete(
      metricValues('packetManagedUnattributedReadOperations'),
    ),
    packetManagedUnknownOperations: sumComplete(metricValues('packetManagedUnknownOperations')),
    medians: {
      inputTokens: measurementCoverage.inputTokens.complete ? median(measurements.inputTokens) : null,
      uncachedInputTokens: measurementCoverage.uncachedInputTokens.complete
        ? median(measurements.uncachedInputTokens)
        : null,
      outputTokens: measurementCoverage.outputTokens.complete ? median(measurements.outputTokens) : null,
      durationMs: measurementCoverage.durationMs.complete ? median(measurements.durationMs) : null,
      toolOperations: eventShapeComplete ? median(metricValues('toolOperations')) : null,
    },
  };
}
