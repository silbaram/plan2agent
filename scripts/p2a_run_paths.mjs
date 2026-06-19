/** Shared path resolution helpers for Plan2Agent run artifacts. */

import path from 'node:path';

export const DEFAULT_RUNS_DIR = path.join('.plan2agent', 'runs');

export function defaultRunsDirForGraph(graphPath) {
  return path.resolve(path.dirname(graphPath), '..', 'runs');
}

export function resolveRunsDir(args) {
  if (args.runs) return path.resolve(args.runs);
  if (args.artifacts) return path.join(path.resolve(args.artifacts), 'runs');
  if (args.graph) return defaultRunsDirForGraph(path.resolve(args.graph));
  return path.resolve(DEFAULT_RUNS_DIR);
}
