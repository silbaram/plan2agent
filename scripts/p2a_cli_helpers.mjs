/** Shared path, collection, and lifecycle-option helpers for Plan2Agent CLIs. */

import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizePath } from './p2a_paths.mjs';

const GATE_RETURN_ASSESSMENTS = new Set(['valid', 'invalid']);

export function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

export function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} must be a file: ${filePath}`);
}

export function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new Error(`${label} is missing: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new Error(`${label} must be a directory: ${dirPath}`);
}

export function displayPath(filePath, root = process.cwd()) {
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizePath(relative);
  }
  return normalizePath(filePath);
}

export function artifactRelativePath(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

export function hasStructuredDetailOptions(args) {
  return [
    args.reproductionSteps,
    args.reproductionCommands,
    args.reproductionNotes,
    args.localizationFindings,
    args.localizedFiles,
    args.fixSummaries,
    args.fixFiles,
    args.guardChecks,
    args.guardNotes,
  ].some((values) => values.length > 0);
}

export function hasInterruptionOptions(args) {
  return args.implementationInterruptions.length > 0
    || args.userCorrections.length > 0
    || args.gateReturns.length > 0;
}

export function requiredValue(argv, index, optionName, options = {}) {
  const value = argv[index];
  if (!value || (!options.allowLeadingDash && value.startsWith('--'))) {
    throw new Error(`missing value for ${optionName}`);
  }
  return value;
}

export function requiredNonBlankText(argv, index, optionName) {
  const value = requiredValue(argv, index, optionName, { allowLeadingDash: true }).trim();
  if (!value) throw new Error(`${optionName} must not be blank`);
  return value;
}

export function parseNonNegativeInteger(value, optionName) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${optionName} exceeds the safe integer range`);
  return parsed;
}

export function parseGateReturn(value) {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--gate-return must use valid|invalid:<summary>');
  }
  const assessment = value.slice(0, separator);
  const summary = value.slice(separator + 1).trim();
  if (!GATE_RETURN_ASSESSMENTS.has(assessment) || !summary) {
    throw new Error('--gate-return must use valid|invalid:<summary>');
  }
  return { assessment, summary };
}
