/** Shared path resolution helpers for Plan2Agent run artifacts. */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNS_DIR } from './p2a_constants.mjs';
export { DEFAULT_RUNS_DIR };

const RUN_ID_PATTERN = /^run-[A-Za-z0-9._-]+$/;
const RUN_PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSCOPED_RUN_PARTITION = 'unscoped';
const RUN_SIDECAR_SUFFIXES = [
  '.orchestration.json',
  '.orchestration-runtime.json',
  '.monitor-gate.json',
  '.monitor-verdict.json',
  '.style-verdict.json',
];
const RUN_SIDECAR_ID_SUFFIXES = RUN_SIDECAR_SUFFIXES
  .map((suffix) => suffix.slice(0, -'.json'.length));

export function normalizeRunPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function assertSafeRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId ?? '')) {
    throw new Error(`run id must match run-[A-Za-z0-9._-]+, got ${JSON.stringify(runId)}`);
  }
}

export function assertStartableRunId(runId) {
  assertSafeRunId(runId);
  const sidecarSuffix = RUN_SIDECAR_ID_SUFFIXES.find((suffix) => runId.endsWith(suffix));
  if (sidecarSuffix) {
    throw new Error(
      `run id must not end with reserved sidecar suffix ${sidecarSuffix}: ${JSON.stringify(runId)}`,
    );
  }
}

export function runPartitionId(iterationId) {
  return typeof iterationId === 'string' && RUN_PARTITION_PATTERN.test(iterationId)
    ? iterationId
    : UNSCOPED_RUN_PARTITION;
}

export function legacyRunRef(runId) {
  assertSafeRunId(runId);
  return `${runId}.json`;
}

export function canonicalRunRef(runOrEntry) {
  assertSafeRunId(runOrEntry?.runId);
  return `${runPartitionId(runOrEntry?.iterationId)}/${runOrEntry.runId}.json`;
}

export function artifactRunRef(runRef) {
  return `runs/${normalizeIndexedRunRef(runRef)}`;
}

export function normalizeIndexedRunRef(runRef, runId = null) {
  if (typeof runRef !== 'string' || !runRef.trim()) throw new Error('runRef must be a non-empty string');
  const normalized = normalizeRunPath(runRef.trim());
  if (path.isAbsolute(normalized)) throw new Error(`runRef must be relative: ${JSON.stringify(runRef)}`);
  const segments = normalized.split('/');
  if (segments.length < 1 || segments.length > 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`runRef must be <runId>.json or <iterationId>/<runId>.json: ${JSON.stringify(runRef)}`);
  }
  const expectedName = runId ? legacyRunRef(runId) : null;
  if (expectedName && segments.at(-1) !== expectedName) {
    throw new Error(`runRef for ${runId} must end with ${expectedName}: ${JSON.stringify(runRef)}`);
  }
  if (segments.length === 2 && !RUN_PARTITION_PATTERN.test(segments[0])) {
    throw new Error(`runRef partition must be path-safe: ${JSON.stringify(runRef)}`);
  }
  return segments.join('/');
}

export function isSupportedRunRef(entry) {
  try {
    const normalized = normalizeIndexedRunRef(entry?.runRef, entry?.runId);
    return normalized === legacyRunRef(entry.runId) || normalized === canonicalRunRef(entry);
  } catch {
    return false;
  }
}

export function isRunRecordFile(filePath) {
  const filename = path.basename(filePath);
  if (filename === 'run-index.json' || !filename.endsWith('.json')) return false;
  const runId = filename.slice(0, -'.json'.length);
  try {
    assertSafeRunId(runId);
  } catch {
    return false;
  }
  if (!RUN_SIDECAR_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return true;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data?.schema_version === 'p2a.run.v1' && data.runId === runId;
  } catch {
    return false;
  }
}

export function unindexedRunRecordRefs(runsDir) {
  const resolvedRunsDir = path.resolve(runsDir);
  if (existsSync(path.join(resolvedRunsDir, 'run-index.json')) || !existsSync(resolvedRunsDir)) return [];
  if (!lstatSync(resolvedRunsDir).isDirectory()) return [];
  const refs = [];
  for (const entry of readdirSync(resolvedRunsDir, { withFileTypes: true })) {
    const entryPath = path.join(resolvedRunsDir, entry.name);
    if (entry.isFile() && isRunRecordFile(entryPath)) {
      refs.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.') || !RUN_PARTITION_PATTERN.test(entry.name)) continue;
    for (const child of readdirSync(path.join(resolvedRunsDir, entry.name), { withFileTypes: true })) {
      const childPath = path.join(resolvedRunsDir, entry.name, child.name);
      if (child.isFile() && isRunRecordFile(childPath)) refs.push(`${entry.name}/${child.name}`);
    }
  }
  return refs.sort();
}

export function assertRunIndexCanInitialize(runsDir) {
  const refs = unindexedRunRecordRefs(runsDir);
  if (!refs.length) return;
  throw new Error(
    `run-index.json is missing while run records still exist in ${path.resolve(runsDir)}: ${refs.join(', ')}. `
    + 'Restore or reconstruct the run index before starting or updating runs.',
  );
}

function rawRunIndex(runsDir) {
  const indexFile = path.join(runsDir, 'run-index.json');
  if (!existsSync(indexFile)) return null;
  try {
    return JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    return null;
  }
}

export function indexedRunRef(runsDir, runId, index = null) {
  assertSafeRunId(runId);
  const resolvedIndex = index ?? rawRunIndex(runsDir);
  const entry = resolvedIndex?.runs?.find((candidate) => candidate?.runId === runId);
  if (!entry) return legacyRunRef(runId);
  if (!isSupportedRunRef(entry)) {
    throw new Error(`run-index ${runId}.runRef is unsupported: ${JSON.stringify(entry.runRef)}`);
  }
  return normalizeIndexedRunRef(entry.runRef, runId);
}

export function runFilePath(runsDir, runId, index = null) {
  return path.join(runsDir, indexedRunRef(runsDir, runId, index));
}

export function canonicalRunFilePath(runsDir, runOrEntry) {
  return path.join(runsDir, canonicalRunRef(runOrEntry));
}

export function runSidecarRef(runRef, suffix) {
  if (typeof suffix !== 'string' || !suffix.startsWith('.') || !suffix.endsWith('.json')) {
    throw new Error(`run sidecar suffix must look like .<name>.json, got ${JSON.stringify(suffix)}`);
  }
  const normalized = normalizeIndexedRunRef(runRef);
  if (!normalized.endsWith('.json')) throw new Error(`runRef must end with .json: ${JSON.stringify(runRef)}`);
  return `${normalized.slice(0, -'.json'.length)}${suffix}`;
}

export function runSidecarPath(runsDir, runId, suffix, index = null) {
  return path.join(runsDir, runSidecarRef(indexedRunRef(runsDir, runId, index), suffix));
}

export function canonicalTaskGraphRef(graphPath) {
  const absolutePath = path.resolve(graphPath);
  try {
    return normalizeRunPath(realpathSync(absolutePath));
  } catch {
    return normalizeRunPath(absolutePath);
  }
}

function iterationGraphContextForAbsolutePath(absoluteGraphPath) {
  const graphDir = path.dirname(absoluteGraphPath);
  if (path.basename(graphDir) !== 'gate-c-task-graph') return null;
  const iterationDir = path.dirname(graphDir);
  const iterationsDir = path.dirname(iterationDir);
  if (path.basename(iterationsDir) !== 'iterations') return null;
  const artifactRoot = path.dirname(iterationsDir);
  return {
    artifactRoot,
    iterationId: path.basename(iterationDir),
    sourceLayout: path.basename(iterationDir) === 'maintenance' ? 'maintenance' : 'iteration',
    graphPath: absoluteGraphPath,
    taskGraphRef: normalizeRunPath(path.relative(artifactRoot, absoluteGraphPath)),
  };
}

export function iterationGraphContext(graphPath) {
  const requestedGraphPath = path.resolve(graphPath);
  const requestedContext = iterationGraphContextForAbsolutePath(requestedGraphPath);
  if (requestedContext) return requestedContext;
  try {
    return iterationGraphContextForAbsolutePath(realpathSync(requestedGraphPath));
  } catch {
    return null;
  }
}

export function assertUnmanagedGraphMutation(graphPath, command) {
  const iterationContext = iterationGraphContext(graphPath);
  if (!iterationContext) return;
  const maintenanceArg = iterationContext.sourceLayout === 'maintenance' ? ' --maintenance' : '';
  throw new Error(
    `${command} cannot mutate a managed ${iterationContext.sourceLayout} task graph through --graph: ${iterationContext.graphPath}. `
    + `Use --artifacts ${iterationContext.artifactRoot}${maintenanceArg} so Gate and run provenance checks are enforced.`,
  );
}

export function taskGraphContextForGraph(graphPath, fallbackIterationId = null) {
  const iterationContext = iterationGraphContext(graphPath);
  if (iterationContext) return iterationContext;
  const absoluteGraphPath = path.resolve(graphPath);
  return {
    artifactRoot: null,
    iterationId: fallbackIterationId,
    sourceLayout: 'graph',
    graphPath: absoluteGraphPath,
    taskGraphRef: canonicalTaskGraphRef(absoluteGraphPath),
  };
}

export function legacyRunsDirForGraph(graphPath) {
  const iterationContext = iterationGraphContext(graphPath);
  if (!iterationContext) return null;
  return path.join(path.dirname(path.dirname(iterationContext.graphPath)), 'runs');
}

export function taskGraphRefMatchesGraph(actualRef, graphPath, artifactRoot = null) {
  if (typeof actualRef !== 'string' || !actualRef.trim()) return false;
  const graphContext = taskGraphContextForGraph(graphPath);
  const normalizedActual = normalizeRunPath(actualRef.trim());
  if (normalizedActual === graphContext.taskGraphRef) return true;
  const expectedCanonicalRef = canonicalTaskGraphRef(graphContext.graphPath);
  const bases = [
    artifactRoot ?? graphContext.artifactRoot,
    process.cwd(),
    path.dirname(graphContext.graphPath),
    path.dirname(path.dirname(graphContext.graphPath)),
  ].filter(Boolean);
  for (const basePath of new Set(bases)) {
    const resolvedRef = path.isAbsolute(actualRef) ? actualRef : path.resolve(basePath, actualRef);
    if (canonicalTaskGraphRef(resolvedRef) === expectedCanonicalRef) return true;
  }
  return false;
}

export function defaultRunsDirForGraph(graphPath) {
  const iterationContext = iterationGraphContext(graphPath);
  if (iterationContext) return path.join(iterationContext.artifactRoot, 'runs');
  const graphDir = path.dirname(path.resolve(graphPath));
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
