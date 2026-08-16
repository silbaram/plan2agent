import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  normalizeSourceAllowlist,
  summarizeSanitizedTrace,
} from './p2a_trace_model.mjs';

export { normalizeSourceAllowlist } from './p2a_trace_model.mjs';

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

const CONTENT_READ_TOOLS = new Set(['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'wc']);
const METADATA_INSPECT_TOOLS = new Set(['find', 'ls', 'stat', 'readlink']);
const SHELL_SEPARATORS = new Set([';', '&&', '||', '|', '>', '>>', '<', '<<']);
const OPTIONS_WITH_VALUE = Object.freeze({
  rg: new Set([
    '-A', '-B', '-C', '-e', '-f', '-g', '-j', '-m', '-t', '-T',
    '--after-context', '--before-context', '--context', '--encoding', '--engine',
    '--file', '--glob', '--iglob', '--ignore-file', '--max-count', '--max-depth',
    '--pre', '--pre-glob', '--regexp', '--replace', '--sort', '--sortr', '--threads',
    '--type', '--type-add', '--type-not',
  ]),
  grep: new Set([
    '-A', '-B', '-C', '-e', '-f', '-m',
    '--after-context', '--before-context', '--context', '--exclude', '--exclude-dir',
    '--file', '--include', '--max-count', '--regexp',
  ]),
  sed: new Set(['-e', '-f', '--expression', '--file']),
  head: new Set(['-c', '-n', '--bytes', '--lines']),
  tail: new Set(['-c', '-n', '--bytes', '--lines', '--pid', '--sleep-interval']),
  wc: new Set(['--files0-from']),
  cat: new Set([]),
});

function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (';|&<>'.includes(character)) {
      push();
      const doubled = command[index + 1] === character;
      tokens.push(doubled ? `${character}${character}` : character);
      if (doubled) index += 1;
      continue;
    }
    current += character;
  }
  push();
  return { tokens, complete: quote === null && !escaped };
}

function executableName(token) {
  return path.posix.basename(normalizePath(token));
}

function toolInvocations(tokens, tools) {
  const invocations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tool = executableName(tokens[index]);
    if (!tools.has(tool)) continue;
    const args = [];
    for (let cursor = index + 1; cursor < tokens.length && !SHELL_SEPARATORS.has(tokens[cursor]); cursor += 1) {
      args.push(tokens[cursor]);
    }
    invocations.push({ tool, args });
  }
  return invocations;
}

function positionalArguments(invocation) {
  const values = [];
  const valueOptions = OPTIONS_WITH_VALUE[invocation.tool] ?? new Set();
  let expressionProvided = false;
  for (let index = 0; index < invocation.args.length; index += 1) {
    const argument = invocation.args[index];
    if (argument === '--') {
      values.push(...invocation.args.slice(index + 1));
      break;
    }
    const optionName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (['-e', '-f', '--regexp', '--file', '--expression'].includes(optionName)) {
      expressionProvided = true;
    }
    if (argument.startsWith('-') && argument !== '-') {
      if (!argument.includes('=') && valueOptions.has(optionName)) index += 1;
      continue;
    }
    values.push(argument);
  }
  return { values, expressionProvided };
}

function readTargets(invocations) {
  const targets = [];
  for (const invocation of invocations) {
    const { values, expressionProvided } = positionalArguments(invocation);
    if (invocation.tool === 'rg' || invocation.tool === 'grep') {
      const pathValues = expressionProvided ? values : values.slice(1);
      if (!pathValues.length && invocation.tool === 'rg') {
        targets.push({ kind: 'scope', value: '.' });
      } else {
        targets.push(...pathValues.map((value) => ({ kind: 'search', value })));
      }
      continue;
    }
    if (invocation.tool === 'sed') {
      const fileValues = expressionProvided ? values : values.slice(1);
      targets.push(...fileValues.map((value) => ({ kind: 'file', value })));
      continue;
    }
    targets.push(...values.filter((value) => value !== '-').map((value) => ({ kind: 'file', value })));
  }
  return targets;
}

function classifyCommand(command) {
  if (!command) return { commandClass: 'unknown', readTool: null, targets: [], parseComplete: false };
  const parsed = shellTokens(command);
  const contentInvocations = toolInvocations(parsed.tokens, CONTENT_READ_TOOLS)
    .filter((invocation) => !(invocation.tool === 'rg' && invocation.args.includes('--files')));
  if (contentInvocations.length) {
    const tools = [...new Set(contentInvocations.map((invocation) => invocation.tool))];
    return {
      commandClass: 'content_read',
      readTool: tools.length === 1 ? tools[0] : 'multiple',
      targets: readTargets(contentInvocations),
      parseComplete: parsed.complete,
    };
  }
  const metadataInvocations = toolInvocations(parsed.tokens, METADATA_INSPECT_TOOLS);
  const rgFiles = toolInvocations(parsed.tokens, new Set(['rg']))
    .some((invocation) => invocation.args.includes('--files'));
  if (metadataInvocations.length || rgFiles) {
    const tools = metadataInvocations.map((invocation) => invocation.tool);
    if (rgFiles) tools.push('rg_files');
    const uniqueTools = [...new Set(tools)];
    return {
      commandClass: 'metadata_inspect',
      readTool: uniqueTools.length === 1 ? uniqueTools[0] : 'multiple',
      targets: [],
      parseComplete: parsed.complete,
    };
  }
  const normalized = command.toLowerCase();
  if (/\b(?:npm|node|npx|pnpm|yarn|cargo|go|pytest|vitest|jest|make)\b/.test(normalized)
    && /\b(?:test|check|lint|typecheck|verify)\b/.test(normalized)) {
    return { commandClass: 'verify', readTool: null, targets: [], parseComplete: parsed.complete };
  }
  if (/\b(?:git status|git diff|git show|git log|pwd)\b/.test(normalized)) {
    return { commandClass: 'inspect', readTool: null, targets: [], parseComplete: parsed.complete };
  }
  return { commandClass: 'other', readTool: null, targets: [], parseComplete: parsed.complete };
}

function exitClass(exitCode) {
  if (!Number.isInteger(exitCode)) return 'unknown';
  return exitCode === 0 ? 'success' : 'failure';
}

function isInsideWorkspace(candidate, workspaceRoot) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function opaqueId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function matcherAbsolutePath(matcher, workspaceRoot) {
  if (!workspaceRoot) return null;
  return path.resolve(workspaceRoot, matcher);
}

function exactCanonicalSources(candidate, sourceAllowlist, workspaceRoot) {
  return sourceAllowlist.filter((source) => source.matchers.some((matcher) => {
    if (workspaceRoot) return matcherAbsolutePath(matcher, workspaceRoot) === candidate.absolutePath;
    return normalizePath(matcher) === normalizePath(candidate.rawValue);
  }));
}

function scopeOverlapsCanonical(scopePath, sourceAllowlist, workspaceRoot) {
  if (!workspaceRoot) return false;
  return sourceAllowlist.some((source) => source.packetManaged && source.matchers.some((matcher) => (
    isInsideWorkspace(matcherAbsolutePath(matcher, workspaceRoot), scopePath)
  )));
}

function analyzeReadTargets(targets, sourceAllowlist, workspaceRoot, parseComplete) {
  const canonicalIds = new Set();
  const packetManagedIds = new Set();
  const workspaceIds = new Set();
  let outsideWorkspace = false;
  let dynamicOrUnresolved = !parseComplete || targets.length === 0;
  let scopeAttributed = false;
  let packetUnattributed = dynamicOrUnresolved;

  for (const target of targets) {
    const rawValue = normalizePath(target.value);
    if (!rawValue || /\$\{|\$\(|[`*?]/.test(rawValue)) {
      dynamicOrUnresolved = true;
      packetUnattributed = true;
      continue;
    }
    const absolutePath = workspaceRoot
      ? path.resolve(workspaceRoot, rawValue)
      : path.posix.isAbsolute(rawValue) ? path.resolve(rawValue) : null;
    if (workspaceRoot && absolutePath && !isInsideWorkspace(absolutePath, workspaceRoot)) {
      outsideWorkspace = true;
      continue;
    }
    const candidate = { rawValue, absolutePath };
    const exactSources = exactCanonicalSources(candidate, sourceAllowlist, workspaceRoot);
    if (exactSources.length) {
      for (const source of exactSources) {
        canonicalIds.add(source.id);
        if (source.packetManaged) packetManagedIds.add(source.id);
      }
      continue;
    }
    if (!workspaceRoot || !absolutePath) {
      dynamicOrUnresolved = true;
      packetUnattributed = true;
      continue;
    }
    const relativePath = normalizePath(path.relative(workspaceRoot, absolutePath)) || '.';
    if (target.kind === 'search' || target.kind === 'scope') {
      scopeAttributed = true;
      workspaceIds.add(opaqueId('search_scope', relativePath));
      if (scopeOverlapsCanonical(absolutePath, sourceAllowlist, workspaceRoot)) {
        packetUnattributed = true;
      }
    } else {
      workspaceIds.add(opaqueId('workspace', relativePath));
    }
  }

  let targetClass = 'workspace_other';
  if (outsideWorkspace) targetClass = 'outside_workspace';
  else if (dynamicOrUnresolved) targetClass = 'dynamic_or_unresolved';
  else if (canonicalIds.size && !workspaceIds.size) targetClass = 'allowlisted_source';
  else if (packetUnattributed) targetClass = 'canonical_scope';
  else if (canonicalIds.size) targetClass = 'mixed_workspace';

  return {
    sourceIds: [...canonicalIds].sort((left, right) => left.localeCompare(right)),
    packetManagedSourceIds: [...packetManagedIds].sort((left, right) => left.localeCompare(right)),
    workspaceSourceIds: [...workspaceIds].sort((left, right) => left.localeCompare(right)),
    targetClass,
    attributionLevel: scopeAttributed ? 'scope' : dynamicOrUnresolved ? 'unresolved' : 'file',
    packetUnattributed,
    globallyUnattributed: outsideWorkspace || dynamicOrUnresolved,
  };
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
    const attribution = classification.commandClass === 'content_read'
      ? analyzeReadTargets(
          classification.targets,
          this.sourceAllowlist,
          this.workspaceRoot,
          classification.parseComplete,
        )
      : {
          sourceIds: [],
          packetManagedSourceIds: [],
          workspaceSourceIds: [],
          targetClass: classification.commandClass === 'metadata_inspect' ? 'workspace_other' : null,
          attributionLevel: classification.commandClass === 'metadata_inspect' ? 'scope' : 'none',
          packetUnattributed: false,
          globallyUnattributed: false,
        };
    this.operations.push({
      sequence,
      commandClass: classification.commandClass,
      readTool: classification.readTool,
      targetClass: attribution.targetClass,
      attributionLevel: attribution.attributionLevel,
      exitClass: exitClass(event.item.exit_code),
      sourceIds: attribution.sourceIds,
      packetManagedSourceIds: attribution.packetManagedSourceIds,
      workspaceSourceIds: attribution.workspaceSourceIds,
      packetManagedUnattributed: attribution.packetUnattributed,
      globallyUnattributed: attribution.globallyUnattributed,
      operationFingerprint: [
        classification.commandClass,
        classification.readTool ?? 'none',
        attribution.targetClass ?? 'none',
        attribution.sourceIds.join(',') || 'none',
        attribution.workspaceSourceIds.join(',') || 'none',
      ].join(':'),
    });
    return true;
  }

  summary() {
    return summarizeSanitizedTrace({
      operations: this.operations,
      unsupportedShapes: this.unsupportedShapes,
    });
  }
}

export function collectSanitizedToolTrace(events, sourceAllowlist = [], options = {}) {
  const trace = new SanitizedToolTrace(sourceAllowlist, options);
  for (const event of events ?? []) trace.observe(event);
  return trace.summary();
}
