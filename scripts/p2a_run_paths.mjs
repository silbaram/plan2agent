/** Shared path resolution helpers for Plan2Agent run artifacts. */

import path from 'node:path';
import { P2A_DIR } from './p2a_paths.mjs';

export const DEFAULT_RUNS_DIR = path.join(P2A_DIR, 'runs');

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
