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

export function aggregateAbRuns(runs, variant, scenarioId = null) {
  const selected = runs.filter((run) => (
    run.variant === variant && (!scenarioId || run.scenarioId === scenarioId)
  ));
  const sum = (selector) => selected.reduce((total, run) => total + (selector(run) ?? 0), 0);
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

  return {
    runs: selected.length,
    passed: selected.filter((run) => run.grade?.verdict === 'pass').length,
    failed: selected.filter((run) => run.grade?.verdict !== 'pass').length,
    inputTokens: sum((run) => run.metadata?.execution?.usage?.input_tokens),
    cachedInputTokens: sum((run) => run.metadata?.execution?.usage?.cached_input_tokens),
    uncachedInputTokens: sum((run) => {
      const usage = run.metadata?.execution?.usage;
      return (usage?.input_tokens ?? 0) - (usage?.cached_input_tokens ?? 0);
    }),
    outputTokens: sum((run) => run.metadata?.execution?.usage?.output_tokens),
    durationMs: sum((run) => run.metadata?.execution?.durationMs),
    toolCalls: sum((run) => run.metadata?.execution?.toolCalls),
    toolFailures: sum((run) => run.metadata?.execution?.toolFailures),
    traceCoverage: {
      availableRuns,
      partialRuns,
      unsupportedRuns,
      missingRuns,
      unavailableRuns: selected.length - availableRuns,
      eventShapeComplete,
      attributionComplete,
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
    medians: {
      inputTokens: median(runMetric((run) => run.metadata?.execution?.usage?.input_tokens)),
      uncachedInputTokens: median(runMetric((run) => {
        const usage = run.metadata?.execution?.usage;
        return Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.cached_input_tokens)
          ? usage.input_tokens - usage.cached_input_tokens
          : null;
      })),
      outputTokens: median(runMetric((run) => run.metadata?.execution?.usage?.output_tokens)),
      durationMs: median(runMetric((run) => run.metadata?.execution?.durationMs)),
      toolOperations: eventShapeComplete ? median(metricValues('toolOperations')) : null,
    },
  };
}
