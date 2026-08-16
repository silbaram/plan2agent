/** Translate AGY tool events into the provider-neutral sanitized trace contract. */

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  normalizeSourceAllowlist,
  summarizeSanitizedTrace,
} from './p2a_trace_model.mjs';

function normalizePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

function opaqueSourceId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function isInsideWorkspace(candidate, workspaceRoot) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function matchSourceIds(targetPath, sourceAllowlist, workspaceRoot) {
  if (!targetPath || typeof targetPath !== 'string') return [];
  const targetAbsolute = workspaceRoot
    ? path.resolve(workspaceRoot, targetPath)
    : null;
  if (workspaceRoot && !isInsideWorkspace(targetAbsolute, workspaceRoot)) return [];
  return [...new Set(sourceAllowlist
    .filter((source) => source.matchers.some((matcher) => (
      workspaceRoot
        ? path.resolve(workspaceRoot, matcher) === targetAbsolute
        : normalizePath(matcher) === normalizePath(targetPath)
    )))
    .map((source) => source.id))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaceRelative(targetPath, workspaceRoot) {
  if (!targetPath || typeof targetPath !== 'string' || !workspaceRoot) return null;
  const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizePath(relative);
}

export function isScopeOverlappingCanonical(searchRelPath, sourceAllowlist) {
  const normalizedScope = normalizePath(searchRelPath ?? '').replace(/\/+$/, '');
  if (normalizedScope === '' || normalizedScope === '.') return true;
  for (const entry of sourceAllowlist ?? []) {
    for (const matcher of entry.matchers ?? []) {
      const normalizedMatcher = normalizePath(matcher).replace(/\/+$/, '');
      if (
        normalizedMatcher === normalizedScope
        || normalizedMatcher.startsWith(`${normalizedScope}/`)
        || normalizedScope.startsWith(`${normalizedMatcher}/`)
      ) {
        return true;
      }
    }
  }
  return false;
}

export class SanitizedAgyToolTrace {
  constructor(sourceAllowlist = [], options = {}) {
    this.sourceAllowlist = normalizeSourceAllowlist(sourceAllowlist);
    this.workspaceRoot = typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim()
      ? path.resolve(options.workspaceRoot)
      : null;
    this.operations = [];
    this.unsupportedShapes = [];
  }

  observeTool(toolName, parameters, isError = false, eventInfo = {}) {
    const sequence = this.operations.length + this.unsupportedShapes.length + 1;
    let commandClass = 'unknown';
    let readTool = toolName ?? 'unknown';
    let targetClass = 'dynamic_or_unresolved';
    let attributionLevel = 'none';
    let scopeOverlapsCanonical = false;
    let sourceIds = [];
    let workspaceSourceIds = [];
    const exitClass = isError ? 'failure' : 'success';

    if (toolName === 'view_file') {
      commandClass = 'content_read';
      readTool = 'view_file';
      const absolutePath = parameters?.AbsolutePath ?? parameters?.path ?? parameters?.filePath ?? '';
      sourceIds = matchSourceIds(absolutePath, this.sourceAllowlist, this.workspaceRoot);
      if (sourceIds.length > 0) {
        targetClass = 'allowlisted_source';
        attributionLevel = 'canonical';
      } else if (this.workspaceRoot) {
        const relative = normalizeWorkspaceRelative(absolutePath, this.workspaceRoot);
        if (relative !== null) {
          workspaceSourceIds = [opaqueSourceId('workspace', relative)];
          targetClass = 'workspace_other';
          attributionLevel = 'file';
        } else if (absolutePath) {
          targetClass = 'outside_workspace';
        }
      } else if (absolutePath) {
        targetClass = 'outside_workspace';
      }
    } else if (toolName === 'list_dir') {
      commandClass = 'metadata_inspect';
      readTool = 'list_dir';
      const directoryPath = parameters?.DirectoryPath ?? parameters?.path ?? '';
      sourceIds = matchSourceIds(directoryPath, this.sourceAllowlist, this.workspaceRoot);
      if (sourceIds.length > 0) {
        targetClass = 'allowlisted_source';
        attributionLevel = 'canonical';
      } else if (this.workspaceRoot) {
        const relative = normalizeWorkspaceRelative(directoryPath, this.workspaceRoot);
        if (relative !== null) {
          workspaceSourceIds = [opaqueSourceId('search_scope', relative || '.')];
          targetClass = 'workspace_other';
          attributionLevel = 'scope';
          scopeOverlapsCanonical = isScopeOverlappingCanonical(
            relative || '.',
            this.sourceAllowlist,
          );
        } else if (directoryPath) {
          targetClass = 'outside_workspace';
        } else {
          targetClass = 'workspace_other';
        }
      } else if (directoryPath) {
        targetClass = 'outside_workspace';
      } else {
        targetClass = 'workspace_other';
      }
    } else if (toolName === 'grep_search') {
      commandClass = 'content_read';
      readTool = 'grep_search';
      const searchPath = parameters?.SearchPath ?? parameters?.path ?? parameters?.directory ?? '';
      sourceIds = matchSourceIds(searchPath, this.sourceAllowlist, this.workspaceRoot);
      if (sourceIds.length > 0) {
        targetClass = 'allowlisted_source';
        attributionLevel = 'canonical';
      } else if (this.workspaceRoot) {
        const relative = normalizeWorkspaceRelative(searchPath, this.workspaceRoot);
        if (relative !== null) {
          workspaceSourceIds = [opaqueSourceId('search_scope', relative || '.')];
          targetClass = 'workspace_other';
          attributionLevel = 'scope';
          scopeOverlapsCanonical = isScopeOverlappingCanonical(
            relative || '.',
            this.sourceAllowlist,
          );

          if (Array.isArray(eventInfo?.matchedFiles) && eventInfo.matchedFiles.length > 0) {
            const fileIds = [];
            for (const matchedFile of eventInfo.matchedFiles) {
              const matchedRelative = normalizeWorkspaceRelative(matchedFile, this.workspaceRoot);
              if (!matchedRelative) continue;
              const matchedSourceIds = matchSourceIds(
                matchedRelative,
                this.sourceAllowlist,
                this.workspaceRoot,
              );
              if (matchedSourceIds.length > 0) fileIds.push(...matchedSourceIds);
              else fileIds.push(opaqueSourceId('workspace', matchedRelative));
            }
            if (fileIds.length > 0) {
              const uniqueFileIds = [...new Set(fileIds)].sort();
              sourceIds = uniqueFileIds.filter(
                (id) => id.startsWith('skill:') || id.startsWith('reference:'),
              );
              workspaceSourceIds = uniqueFileIds.filter(
                (id) => !id.startsWith('skill:') && !id.startsWith('reference:'),
              );
              attributionLevel = sourceIds.length ? 'canonical' : 'file';
            }
          }
        } else if (searchPath) {
          targetClass = 'outside_workspace';
        }
      } else if (searchPath) {
        targetClass = 'outside_workspace';
      }
    } else if (toolName === 'run_command') {
      const command = parameters?.CommandLine ?? '';
      readTool = 'run_command';
      if (/^(?:cat|head|tail|sed|grep|rg)\b/.test(command)) commandClass = 'content_read';
      else if (/^(?:ls|find|stat)\b/.test(command)) commandClass = 'metadata_inspect';
      else commandClass = 'other';

      sourceIds = matchSourceIds(command, this.sourceAllowlist, this.workspaceRoot);
      if (sourceIds.length > 0) {
        targetClass = 'allowlisted_source';
        attributionLevel = 'canonical';
      } else {
        targetClass = 'workspace_other';
      }
    } else if (toolName === 'read_resource') {
      commandClass = 'content_read';
      readTool = 'read_resource';
      const resourceUri = parameters?.uri ?? parameters?.path ?? '';
      sourceIds = matchSourceIds(resourceUri, this.sourceAllowlist, this.workspaceRoot);
      if (sourceIds.length > 0) {
        targetClass = 'allowlisted_source';
        attributionLevel = 'canonical';
      } else {
        targetClass = 'workspace_other';
      }
    }

    const packetManagedSourceIds = sourceIds.filter((sourceId) => (
      this.sourceAllowlist.some((source) => source.id === sourceId && source.packetManaged)
    ));
    const packetManagedUnattributed = commandClass === 'content_read' && (
      attributionLevel === 'none'
      || (attributionLevel === 'scope' && scopeOverlapsCanonical)
    );
    const globallyUnattributed = commandClass === 'content_read' && (
      attributionLevel === 'none'
      || ['outside_workspace', 'dynamic_or_unresolved'].includes(targetClass)
    );
    this.operations.push({
      sequence,
      commandClass,
      readTool,
      targetClass,
      attributionLevel,
      exitClass,
      sourceIds,
      packetManagedSourceIds,
      workspaceSourceIds,
      packetManagedUnattributed,
      globallyUnattributed,
      operationFingerprint: [
        commandClass,
        readTool,
        targetClass ?? 'none',
        attributionLevel,
        sourceIds.join(',') || 'none',
        workspaceSourceIds.join(',') || 'none',
      ].join(':'),
    });
  }

  summary(options = {}) {
    return summarizeSanitizedTrace({
      operations: this.operations,
      unsupportedShapes: this.unsupportedShapes,
      exitCode: options.exitCode ?? null,
    });
  }
}
