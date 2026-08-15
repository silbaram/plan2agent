import path from 'node:path';

function normalizePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

function commandText(item) {
  if (typeof item?.command === 'string') return item.command;
  if (Array.isArray(item?.command) && item.command.every((part) => typeof part === 'string')) {
    return item.command.join(' ');
  }
  return null;
}

function commandClass(command) {
  if (!command) return 'unknown';
  const normalized = command.toLowerCase();
  if (/\b(?:cat|sed|head|tail|rg|grep|find|ls|stat|wc|readlink)\b/.test(normalized)) return 'read';
  if (/\b(?:npm|node|npx|pnpm|yarn|cargo|go|pytest|vitest|jest|make)\b/.test(normalized)
    && /\b(?:test|check|lint|typecheck|verify)\b/.test(normalized)) return 'verify';
  if (/\b(?:git status|git diff|git show|git log|pwd)\b/.test(normalized)) return 'inspect';
  return 'other';
}

function exitClass(exitCode) {
  if (!Number.isInteger(exitCode)) return 'unknown';
  return exitCode === 0 ? 'success' : 'failure';
}

function operationSourceIds(command, sourceAllowlist) {
  if (!command) return [];
  const normalized = normalizePath(command);
  return [...new Set(sourceAllowlist
    .filter((source) => source.matchers.some((matcher) => normalized.includes(matcher)))
    .map((source) => source.id))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeSourceAllowlist(entries) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) continue;
    const matchers = [...new Set((entry.paths ?? [])
      .filter((value) => typeof value === 'string' && value.trim())
      .map(normalizePath))]
      .sort((left, right) => left.localeCompare(right));
    if (!matchers.length || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push({ id: entry.id, matchers });
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function inspectCommandEventShape(event) {
  if (event?.type !== 'item.completed' || event?.item?.type !== 'command_execution') {
    return { applicable: false, supported: true, fields: null };
  }
  const command = commandText(event.item);
  const supported = command !== null && Number.isInteger(event.item.exit_code);
  return {
    applicable: true,
    supported,
    fields: {
      command: command === null ? typeof event.item.command : Array.isArray(event.item.command) ? 'string[]' : 'string',
      exitCode: Number.isInteger(event.item.exit_code) ? 'integer' : typeof event.item.exit_code,
    },
  };
}

export class SanitizedToolTrace {
  constructor(sourceAllowlist = []) {
    this.sourceAllowlist = normalizeSourceAllowlist(sourceAllowlist);
    this.operations = [];
    this.unsupportedShapes = [];
  }

  observe(event) {
    const shape = inspectCommandEventShape(event);
    if (!shape.applicable) return false;
    const sequence = this.operations.length + this.unsupportedShapes.length + 1;
    if (!shape.supported) {
      this.unsupportedShapes.push({ sequence, fields: shape.fields });
      return true;
    }
    const command = commandText(event.item);
    const classification = commandClass(command);
    const sourceIds = classification === 'read'
      ? operationSourceIds(command, this.sourceAllowlist)
      : [];
    this.operations.push({
      sequence,
      commandClass: classification,
      exitClass: exitClass(event.item.exit_code),
      sourceIds,
      operationFingerprint: `${classification}:${sourceIds.join(',') || 'none'}`,
    });
    return true;
  }

  summary() {
    const readOperations = this.operations.filter((operation) => operation.commandClass === 'read');
    const occurrenceCounts = new Map();
    for (const operation of readOperations) {
      for (const sourceId of operation.sourceIds) {
        occurrenceCounts.set(sourceId, (occurrenceCounts.get(sourceId) ?? 0) + 1);
      }
    }
    const sourceReadOccurrences = [...occurrenceCounts.values()]
      .reduce((total, count) => total + count, 0);
    const repeatedSourceReads = [...occurrenceCounts.values()]
      .reduce((total, count) => total + Math.max(0, count - 1), 0);
    const supported = this.unsupportedShapes.length === 0;
    return {
      schema_version: 'p2a.sanitized_tool_trace.v1',
      status: supported ? 'available' : 'unsupported',
      eventShape: {
        supported,
        unsupportedCount: this.unsupportedShapes.length,
        unsupportedFields: this.unsupportedShapes,
      },
      operations: this.operations,
      metrics: {
        toolOperations: this.operations.length + this.unsupportedShapes.length,
        uniqueSourcesRead: occurrenceCounts.size,
        sourceReadOccurrences,
        repeatedSourceReads,
        sourcesPerReadOperation: readOperations.length
          ? Number((sourceReadOccurrences / readOperations.length).toFixed(4))
          : 0,
        unknownOperations: this.operations.filter((operation) => operation.commandClass === 'unknown').length
          + this.unsupportedShapes.length,
      },
    };
  }
}

export function collectSanitizedToolTrace(events, sourceAllowlist = []) {
  const trace = new SanitizedToolTrace(sourceAllowlist);
  for (const event of events ?? []) trace.observe(event);
  return trace.summary();
}
