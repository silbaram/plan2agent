/** Shared proposal-mining state helpers used by routing and run retention. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonObject(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function proposalQueuePath(targetRoot, proposals = {}) {
  const queueDir = stringValue(proposals.queueDir) ?? '.plan2agent/proposals';
  return path.isAbsolute(queueDir)
    ? path.resolve(queueDir)
    : path.resolve(targetRoot, queueDir);
}

export function minedProposalRunIds(targetRoot, proposals = {}) {
  const queuePath = proposalQueuePath(targetRoot, proposals);
  if (!isDirectory(queuePath)) return new Set();
  const runIds = new Set();
  for (const entry of readdirSync(queuePath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sourceRunId = stringValue(readJsonObject(path.join(queuePath, entry.name))?.sourceRunId);
    if (sourceRunId) runIds.add(sourceRunId);
  }
  return runIds;
}
