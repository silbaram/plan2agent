/** Shared path resolution helpers for Plan2Agent run artifacts. */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNS_DIR } from './p2a_constants.mjs';
export { DEFAULT_RUNS_DIR };

export function normalizeRunPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function canonicalTaskGraphRef(graphPath) {
  const absolutePath = path.resolve(graphPath);
  try {
    return normalizeRunPath(realpathSync(absolutePath));
  } catch {
    return normalizeRunPath(absolutePath);
  }
}

export function defaultRunsDirForGraph(graphPath) {
  const graphDir = path.dirname(graphPath);
  if (path.basename(graphDir) === 'gate-c-task-graph') {
    return path.resolve(graphDir, '..', 'runs');
  }
  return path.resolve(graphDir, 'runs');
}

export function resolveRunsDir(args) {
  if (args.runs) return path.resolve(args.runs);
  if (args.artifacts) return path.join(path.resolve(args.artifacts), 'runs');
  if (args.graph) return defaultRunsDirForGraph(path.resolve(args.graph));
  return path.resolve(DEFAULT_RUNS_DIR);
}
