/** Provider-neutral sanitized tool-trace contract and metric aggregation. */

import { readFileSync } from 'node:fs';

import { validateSchema } from './p2a_schema.mjs';

export const SANITIZED_TOOL_TRACE_SCHEMA_VERSION = 'p2a.sanitized_tool_trace.v3';

const TRACE_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/sanitized-tool-trace.schema.json', import.meta.url),
  'utf8',
));

export function normalizeSourceAllowlist(entries) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) continue;
    const matchers = [...new Set((entry.paths ?? [])
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => String(value).replaceAll('\\', '/')))]
      .sort((left, right) => left.localeCompare(right));
    if (!matchers.length || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push({ id: entry.id, matchers, packetManaged: entry.packetManaged !== false });
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function sumOccurrences(counts) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

function repeatedOccurrences(counts) {
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

export function summarizeSanitizedTrace({
  operations = [],
  unsupportedShapes = [],
  exitCode = null,
} = {}) {
  const contentReadOperations = operations.filter(
    (operation) => operation.commandClass === 'content_read',
  );
  const metadataInspectOperations = operations.filter(
    (operation) => operation.commandClass === 'metadata_inspect',
  );
  const unattributedReadOperations = contentReadOperations.filter(
    (operation) => operation.globallyUnattributed === true,
  ).length;
  const packetManagedUnattributedReadOperations = contentReadOperations.filter(
    (operation) => operation.packetManagedUnattributed === true,
  ).length;
  const occurrenceCounts = new Map();
  const canonicalOccurrenceCounts = new Map();
  const packetManagedOccurrenceCounts = new Map();

  for (const operation of contentReadOperations) {
    for (const sourceId of [...operation.sourceIds, ...operation.workspaceSourceIds]) {
      occurrenceCounts.set(sourceId, (occurrenceCounts.get(sourceId) ?? 0) + 1);
    }
    for (const sourceId of operation.sourceIds) {
      canonicalOccurrenceCounts.set(sourceId, (canonicalOccurrenceCounts.get(sourceId) ?? 0) + 1);
    }
    for (const sourceId of operation.packetManagedSourceIds) {
      packetManagedOccurrenceCounts.set(
        sourceId,
        (packetManagedOccurrenceCounts.get(sourceId) ?? 0) + 1,
      );
    }
  }

  const sourceReadOccurrences = sumOccurrences(occurrenceCounts);
  const canonicalSourceReadOccurrences = sumOccurrences(canonicalOccurrenceCounts);
  const supported = unsupportedShapes.length === 0;
  const packetManagedAttributionComplete = supported
    && packetManagedUnattributedReadOperations === 0;
  const complete = packetManagedAttributionComplete && unattributedReadOperations === 0;
  const unknownOperations = operations.filter((operation) => (
    operation.commandClass === 'unknown'
    || ['outside_workspace', 'dynamic_or_unresolved'].includes(operation.targetClass)
  )).length + unsupportedShapes.length;
  const packetManagedUnknownOperations = operations.filter((operation) => (
    operation.targetClass === 'dynamic_or_unresolved'
  )).length + unsupportedShapes.length;
  const unavailable = Number.isInteger(exitCode) && exitCode !== 0 && operations.length === 0;

  const summary = {
    schema_version: SANITIZED_TOOL_TRACE_SCHEMA_VERSION,
    status: unavailable
      ? 'unavailable'
      : !supported
        ? 'unsupported'
        : complete
          ? 'available'
          : 'partial',
    eventShape: {
      supported,
      unsupportedCount: unsupportedShapes.length,
      unsupportedFields: unsupportedShapes,
    },
    operations,
    metrics: {
      toolOperations: operations.length + unsupportedShapes.length,
      contentReadOperations: contentReadOperations.length,
      metadataInspectOperations: metadataInspectOperations.length,
      canonicalUniqueSourcesRead: canonicalOccurrenceCounts.size,
      canonicalSourceReadOccurrences,
      packetManagedAttributionComplete,
      packetManagedRepeatedSourceReads: repeatedOccurrences(packetManagedOccurrenceCounts),
      packetManagedUnattributedReadOperations,
      packetManagedUnknownOperations,
      workspaceOtherReadOperations: contentReadOperations.filter(
        (operation) => operation.workspaceSourceIds.length > 0,
      ).length,
      scopeAttributedReadOperations: contentReadOperations.filter(
        (operation) => operation.attributionLevel === 'scope',
      ).length,
      uniqueSourcesRead: occurrenceCounts.size,
      sourceReadOccurrences,
      repeatedSourceReads: repeatedOccurrences(occurrenceCounts),
      unattributedReadOperations,
      sourcesPerReadOperation: contentReadOperations.length
        ? Number((sourceReadOccurrences / contentReadOperations.length).toFixed(4))
        : 0,
      unknownOperations,
    },
  };
  validateSchema(summary, TRACE_SCHEMA);
  return summary;
}
