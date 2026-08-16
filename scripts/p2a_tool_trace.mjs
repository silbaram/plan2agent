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

const CONTENT_READ_TOOLS = ['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'wc'];
const METADATA_INSPECT_TOOLS = ['find', 'ls', 'stat', 'readlink'];
const EXECUTABLE_PATHS = new Set([
  '/bin/bash',
  '/bin/cat',
  '/bin/sh',
  '/bin/zsh',
  '/usr/bin/env',
  ...CONTENT_READ_TOOLS.map((tool) => `/usr/bin/${tool}`),
  ...METADATA_INSPECT_TOOLS.map((tool) => `/usr/bin/${tool}`),
]);

function commandContainsTool(command, tool) {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s;&|('"])(?:[^\\s;&|('"]*/)?${escaped}(?=$|[\\s;&|)'"])`, 'i')
    .test(command);
}

function classifyCommand(command) {
  if (!command) return { commandClass: 'unknown', readTool: null };
  const normalized = command.toLowerCase();
  const rgFiles = commandContainsTool(normalized, 'rg')
    && /(?:^|\s)--files(?:\s|=|$)/.test(normalized);
  const contentTools = CONTENT_READ_TOOLS.filter((tool) => (
    tool === 'rg' ? !rgFiles && commandContainsTool(normalized, tool) : commandContainsTool(normalized, tool)
  ));
  if (contentTools.length) {
    return {
      commandClass: 'content_read',
      readTool: contentTools.length === 1 ? contentTools[0] : 'multiple',
    };
  }
  const metadataTools = METADATA_INSPECT_TOOLS.filter((tool) => commandContainsTool(normalized, tool));
  if (rgFiles) metadataTools.push('rg_files');
  if (metadataTools.length) {
    return {
      commandClass: 'metadata_inspect',
      readTool: metadataTools.length === 1 ? metadataTools[0] : 'multiple',
    };
  }
  if (/\b(?:npm|node|npx|pnpm|yarn|cargo|go|pytest|vitest|jest|make)\b/.test(normalized)
    && /\b(?:test|check|lint|typecheck|verify)\b/.test(normalized)) {
    return { commandClass: 'verify', readTool: null };
  }
  if (/\b(?:git status|git diff|git show|git log|pwd)\b/.test(normalized)) {
    return { commandClass: 'inspect', readTool: null };
  }
  return { commandClass: 'other', readTool: null };
}

function exitClass(exitCode) {
  if (!Number.isInteger(exitCode)) return 'unknown';
  return exitCode === 0 ? 'success' : 'failure';
}

function matcherOccursAsPath(command, matcher) {
  const variants = path.posix.isAbsolute(matcher) || matcher.startsWith('./')
    ? [matcher]
    : [matcher, `./${matcher}`];
  return variants.some((variant) => {
    let offset = command.indexOf(variant);
    while (offset !== -1) {
      const before = offset === 0 ? '' : command[offset - 1];
      const afterOffset = offset + variant.length;
      const after = afterOffset === command.length ? '' : command[afterOffset];
      const startsAtBoundary = !before || /[\s'"=([{,;|&<>]/.test(before);
      const endsAtBoundary = !after || /[\s'"\])},;|&<>]/.test(after);
      if (startsAtBoundary && endsAtBoundary) return true;
      offset = command.indexOf(variant, offset + 1);
    }
    return false;
  });
}

function operationSourceIds(command, sourceAllowlist) {
  if (!command) return [];
  const normalized = normalizePath(command);
  return [...new Set(sourceAllowlist
    .filter((source) => source.matchers.some((matcher) => matcherOccursAsPath(normalized, matcher)))
    .map((source) => source.id))]
    .sort((left, right) => left.localeCompare(right));
}

function absolutePathCandidates(command) {
  const candidates = [];
  const matcher = /(?:^|[\s'"=([{,;|&<>])(\/[^\s'"\])},;|&<>]*)/g;
  let match = matcher.exec(normalizePath(command));
  while (match) {
    const candidate = match[1].replace(/[.:]+$/, '');
    if (candidate && !EXECUTABLE_PATHS.has(candidate)) candidates.push(candidate);
    match = matcher.exec(normalizePath(command));
  }
  return candidates;
}

function isInsideWorkspace(candidate, workspaceRoot) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function operationTargetClass(command, sourceIds, workspaceRoot) {
  const absolutePaths = absolutePathCandidates(command);
  if (workspaceRoot && absolutePaths.some((candidate) => !isInsideWorkspace(candidate, workspaceRoot))) {
    return 'outside_workspace';
  }
  if (/\$\{|\$\(|[`*?]|(?:^|\s)xargs(?:\s|$)|(?:^|\s)-exec(?:\s|$)/.test(command)) {
    return 'dynamic_or_unresolved';
  }
  if (sourceIds.length) return 'allowlisted_source';
  if (workspaceRoot) return 'workspace_other';
  return 'dynamic_or_unresolved';
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
  constructor(sourceAllowlist = [], options = {}) {
    this.sourceAllowlist = normalizeSourceAllowlist(sourceAllowlist);
    this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim()
      ? path.resolve(options.workspaceRoot)
      : null;
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
    const classification = classifyCommand(command);
    const sourceIds = classification.commandClass === 'content_read'
      ? operationSourceIds(command, this.sourceAllowlist)
      : [];
    const targetClass = ['content_read', 'metadata_inspect'].includes(classification.commandClass)
      ? operationTargetClass(command, sourceIds, this.workspaceRoot)
      : null;
    this.operations.push({
      sequence,
      commandClass: classification.commandClass,
      readTool: classification.readTool,
      targetClass,
      exitClass: exitClass(event.item.exit_code),
      sourceIds,
      operationFingerprint: [
        classification.commandClass,
        classification.readTool ?? 'none',
        targetClass ?? 'none',
        sourceIds.join(',') || 'none',
      ].join(':'),
    });
    return true;
  }

  summary() {
    const contentReadOperations = this.operations.filter(
      (operation) => operation.commandClass === 'content_read',
    );
    const metadataInspectOperations = this.operations.filter(
      (operation) => operation.commandClass === 'metadata_inspect',
    );
    const unattributedReadOperations = contentReadOperations.filter(
      (operation) => operation.sourceIds.length === 0,
    ).length;
    const occurrenceCounts = new Map();
    for (const operation of contentReadOperations) {
      for (const sourceId of operation.sourceIds) {
        occurrenceCounts.set(sourceId, (occurrenceCounts.get(sourceId) ?? 0) + 1);
      }
    }
    const sourceReadOccurrences = [...occurrenceCounts.values()]
      .reduce((total, count) => total + count, 0);
    const repeatedSourceReads = [...occurrenceCounts.values()]
      .reduce((total, count) => total + Math.max(0, count - 1), 0);
    const supported = this.unsupportedShapes.length === 0;
    const complete = supported && unattributedReadOperations === 0;
    return {
      schema_version: 'p2a.sanitized_tool_trace.v2',
      status: !supported ? 'unsupported' : complete ? 'available' : 'partial',
      eventShape: {
        supported,
        unsupportedCount: this.unsupportedShapes.length,
        unsupportedFields: this.unsupportedShapes,
      },
      operations: this.operations,
      metrics: {
        toolOperations: this.operations.length + this.unsupportedShapes.length,
        contentReadOperations: contentReadOperations.length,
        metadataInspectOperations: metadataInspectOperations.length,
        uniqueSourcesRead: occurrenceCounts.size,
        sourceReadOccurrences,
        repeatedSourceReads,
        unattributedReadOperations,
        sourcesPerReadOperation: contentReadOperations.length
          ? Number((sourceReadOccurrences / contentReadOperations.length).toFixed(4))
          : 0,
        unknownOperations: this.operations.filter((operation) => operation.commandClass === 'unknown').length
          + this.unsupportedShapes.length
          + unattributedReadOperations,
      },
    };
  }
}

export function collectSanitizedToolTrace(events, sourceAllowlist = [], options = {}) {
  const trace = new SanitizedToolTrace(sourceAllowlist, options);
  for (const event of events ?? []) trace.observe(event);
  return trace.summary();
}
