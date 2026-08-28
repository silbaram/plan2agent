/** Shared path resolution helpers for Plan2Agent run artifacts. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNS_DIR } from './p2a_constants.mjs';
import { RUN_STORE_LOCK_FILE } from './p2a_run_store.mjs';
export { DEFAULT_RUNS_DIR };

const RUN_ID_PATTERN = /^run-[A-Za-z0-9._-]+$/;
const RUN_PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UNSCOPED_RUN_PARTITION = 'unscoped';
export const RUN_SIDECAR_SUFFIXES = [
  '.orchestration.json',
  '.orchestration-runtime.json',
  '.monitor-gate.json',
  '.monitor-verdict.json',
  '.style-verdict.json',
  '.visual-review.json',
  '.acceptance-review.json',
];
const RUN_SIDECAR_ID_SUFFIXES = RUN_SIDECAR_SUFFIXES
  .map((suffix) => suffix.slice(0, -'.json'.length));

export function runIndexEvidenceTime(indexEntry) {
  for (const value of [indexEntry?.finishedAt, indexEntry?.startedAt]) {
    const time = Date.parse(value ?? '');
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

export function runEvidenceTime(run, indexEntry) {
  for (const value of [run?.finishedAt, run?.updatedAt, run?.startedAt, indexEntry?.finishedAt, indexEntry?.startedAt]) {
    const time = Date.parse(value ?? '');
    if (!Number.isNaN(time)) return time;
  }
  return 0;
}

export function compareRunIndexEvidence(left, right) {
  return runIndexEvidenceTime(right.indexEntry) - runIndexEvidenceTime(left.indexEntry)
    || right.runOrder - left.runOrder;
}

export function compareRunEvidence(left, right) {
  return runEvidenceTime(right.run, right.indexEntry) - runEvidenceTime(left.run, left.indexEntry)
    || right.runOrder - left.runOrder;
}

export function normalizeRunPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function immutableTaskContract(task) {
  const { status, blockReason, blockNote, intent, ...contract } = task;
  return contract;
}

export function taskContractSha256(task) {
  const contract = {
    schema_version: 'p2a.task_contract.v1',
    task: immutableTaskContract(task),
  };
  return createHash('sha256').update(canonicalJson(contract)).digest('hex');
}

export function canonicalWorkspacePathForArtifactRoot(artifactRoot) {
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const lexicalArtifactsDir = path.dirname(resolvedArtifactRoot);
  const lexicalP2aDir = path.dirname(lexicalArtifactsDir);
  if (
    path.basename(lexicalArtifactsDir) === 'artifacts'
    && path.basename(lexicalP2aDir) === '.plan2agent'
  ) {
    return resolvedRealPath(path.dirname(lexicalP2aDir));
  }
  let canonicalArtifactRoot = resolvedArtifactRoot;
  try {
    canonicalArtifactRoot = realpathSync(resolvedArtifactRoot);
  } catch {
    // Preserve path-only behavior for callers that are validating a future layout.
  }
  const artifactsDir = path.dirname(canonicalArtifactRoot);
  const p2aDir = path.dirname(artifactsDir);
  return (
    path.basename(artifactsDir) === 'artifacts'
    && path.basename(p2aDir) === '.plan2agent'
  ) ? path.dirname(p2aDir) : canonicalArtifactRoot;
}

function pathIsInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolvedRealPath(candidatePath) {
  const resolved = path.resolve(candidatePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function safeReportPathSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && path.basename(value) === value;
}

function retrospectiveReportPathForRun(run, workspacePath) {
  if (!safeReportPathSegment(run?.projectId)) return null;
  let reportName = null;
  if (run.sourceLayout === 'iteration' && safeReportPathSegment(run.iterationId)) {
    reportName = `${run.projectId}-${run.iterationId}.md`;
  } else if (run.sourceLayout === 'maintenance' && safeReportPathSegment(run.taskId)) {
    reportName = `${run.projectId}-maintenance-${run.taskId}.md`;
  }
  return reportName
    ? path.join(workspacePath, 'docs', 'retrospective', reportName)
    : null;
}

function retrospectiveReportExclusion(run, workspacePath) {
  const reportPath = retrospectiveReportPathForRun(run, workspacePath);
  if (!reportPath || !existsSync(reportPath)) return reportPath;
  const revisionBoundary = Date.parse(run?.startedAt ?? run?.finishedAt ?? '');
  const resolvedWorkspace = resolvedRealPath(workspacePath);
  let exclusion = reportPath;
  let childPath = reportPath;
  let directory = path.dirname(reportPath);
  while (directory !== resolvedWorkspace && pathIsInside(resolvedWorkspace, directory)) {
    try {
      const entries = readdirSync(directory);
      const createdAt = statSync(directory).birthtimeMs;
      if (
        entries.length !== 1
        || resolvedRealPath(path.join(directory, entries[0])) !== resolvedRealPath(childPath)
        || Number.isNaN(revisionBoundary)
        || !Number.isFinite(createdAt)
        || createdAt <= 0
        || createdAt <= revisionBoundary
      ) break;
    } catch {
      break;
    }
    exclusion = directory;
    childPath = directory;
    directory = path.dirname(directory);
  }
  return exclusion;
}

function hashFileInChunks(hash, filePath) {
  const descriptor = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

export function workspaceRevisionSha256(workspacePath, excludedPaths = []) {
  const workspaceRoot = realpathSync(path.resolve(workspacePath));
  const requestedExclusions = excludedPaths
    .filter(Boolean)
    .map((candidate) => {
      const resolved = path.resolve(candidate);
      try {
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
  const excludeLegacyRootArtifacts = requestedExclusions.includes(workspaceRoot);
  const excludedRoots = requestedExclusions
    .filter((candidate) => candidate !== workspaceRoot && pathIsInside(workspaceRoot, candidate));
  const rootArtifactEntries = new Set([
    'runs',
    'visual-evidence',
    'iterations',
    'gate-a-intake',
    'gate-b-spec',
    'gate-c-task-graph',
    'gate-d-review',
    'milestone-reviews',
    'preflight-research',
    'proposals',
  ]);
  const ignoredEntryNames = new Set(['.git', '.plan2agent', 'node_modules']);
  const legacyRootControlEntries = new Set(['current-spec.json', 'status.md', 'iteration.json']);
  const hash = createHash('sha256');
  hash.update('p2a.workspace_revision.v1\0');

  function excludedWorkspacePath(candidatePath) {
    if (excludedRoots.some((excludedRoot) => pathIsInside(excludedRoot, candidatePath))) {
      return true;
    }
    if (!pathIsInside(workspaceRoot, candidatePath)) return false;
    const relative = path.relative(workspaceRoot, candidatePath);
    if (!relative) return false;
    const segments = relative.split(path.sep);
    if (segments.some((segment) => ignoredEntryNames.has(segment))) return true;
    return excludeLegacyRootArtifacts
      && segments.length === 1
      && (rootArtifactEntries.has(segments[0]) || legacyRootControlEntries.has(segments[0]));
  }

  function visit(directory, prefix = '', ancestorDirectories = new Set()) {
    const realDirectory = realpathSync(directory);
    if (ancestorDirectories.has(realDirectory)) {
      throw new Error(`workspace revision encountered a symbolic-link directory cycle at ${prefix || '.'}`);
    }
    const nextAncestors = new Set(ancestorDirectories);
    nextAncestors.add(realDirectory);
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (excludedWorkspacePath(entryPath)) continue;
      const relative = normalizeRunPath(path.join(prefix, entry.name));
      const stat = lstatSync(entryPath);
      if (stat.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        visit(entryPath, relative, nextAncestors);
      } else if (stat.isFile()) {
        hash.update(`file\0${relative}\0${stat.mode & 0o111}\0${stat.size}\0`);
        hashFileInChunks(hash, entryPath);
        hash.update('\0');
      } else if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(entryPath);
        let targetPath;
        try {
          targetPath = realpathSync(entryPath);
        } catch (error) {
          throw new Error(
            `workspace revision cannot resolve symbolic link ${relative}: ${error.message}`,
            { cause: error },
          );
        }
        const targetStat = lstatSync(targetPath);
        const targetInsideWorkspace = pathIsInside(workspaceRoot, targetPath);
        if (!targetInsideWorkspace && targetStat.isDirectory()) {
          throw new Error(
            `workspace revision cannot follow symbolic-link directory ${relative} outside the workspace`,
          );
        }
        if (targetInsideWorkspace && excludedWorkspacePath(targetPath)) continue;
        hash.update(`symlink\0${relative}\0${linkTarget}\0`);
        if (targetStat.isDirectory()) {
          hash.update(`symlink-directory\0${relative}\0`);
          visit(targetPath, relative, nextAncestors);
        } else if (targetStat.isFile()) {
          hash.update(`symlink-file\0${relative}\0${targetStat.mode & 0o111}\0${targetStat.size}\0`);
          hashFileInChunks(hash, targetPath);
          hash.update('\0');
        } else {
          hash.update(`symlink-special\0${relative}\0${targetStat.mode}\0`);
        }
      } else {
        hash.update(`special\0${relative}\0${stat.mode}\0`);
      }
    }
  }

  visit(workspaceRoot);
  return hash.digest('hex');
}

export function workspaceRevisionExcludedPaths(
  runsDir,
  artifactRoot = null,
  graphPath = null,
  workspacePath = null,
) {
  const resolvedRunsDir = resolvedRealPath(runsDir);
  if (artifactRoot) {
    const resolvedArtifactRoot = path.resolve(artifactRoot);
    return [
      resolvedArtifactRoot,
      resolvedRunsDir,
      path.join(resolvedArtifactRoot, 'visual-evidence'),
    ];
  }
  const resolvedWorkspace = workspacePath ? resolvedRealPath(workspacePath) : null;
  const resolvedGraphPath = graphPath ? resolvedRealPath(graphPath) : null;
  const legacyArtifactRoot = (
    resolvedWorkspace === path.dirname(resolvedRunsDir)
    && resolvedGraphPath === path.join(
      resolvedWorkspace,
      'gate-c-task-graph',
      'task-graph.json',
    )
  )
    ? resolvedWorkspace
    : null;
  return [
    legacyArtifactRoot,
    resolvedRunsDir,
    path.join(path.dirname(resolvedRunsDir), 'visual-evidence'),
    graphPath ? path.resolve(graphPath) : null,
    graphPath ? path.join(path.dirname(path.resolve(graphPath)), RUN_STORE_LOCK_FILE) : null,
  ];
}

export function workspaceRevisionExcludedPathsForRun(
  runsDir,
  run,
  options = {},
) {
  const managedLayout = ['iteration', 'maintenance'].includes(run?.sourceLayout);
  const artifactRoot = managedLayout
    ? (options.artifactRoot ?? path.dirname(path.resolve(runsDir)))
    : null;
  const graphPath = managedLayout
    ? null
    : (
        options.graphPath
        ?? (path.isAbsolute(run?.taskGraphRef ?? '') ? run.taskGraphRef : null)
      );
  const workspacePath = options.workspacePath ?? run?.workspacePath ?? null;
  return [
    ...workspaceRevisionExcludedPaths(
      runsDir,
      artifactRoot,
      graphPath,
      workspacePath,
    ),
    workspacePath ? retrospectiveReportExclusion(run, workspacePath) : null,
  ];
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

export function executionEnvelopeStoreRef(runOrEntry, sha256) {
  if (!SHA256_PATTERN.test(sha256 ?? '')) {
    throw new Error(`execution envelope sha256 must be 64 lowercase hexadecimal characters, got ${JSON.stringify(sha256)}`);
  }
  return `${runPartitionId(runOrEntry?.iterationId)}/envelopes/${sha256}.json`;
}

export function safeRunStoreFilePath(runsDir, fileRef, label = 'run-store file') {
  const resolvedRunsDir = path.resolve(runsDir);
  const filePath = path.resolve(resolvedRunsDir, fileRef);
  const relative = path.relative(resolvedRunsDir, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the runs directory: ${JSON.stringify(fileRef)}`);
  }
  const segments = relative.split(path.sep);
  let current = resolvedRunsDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} path must not traverse a symbolic link: ${JSON.stringify(fileRef)}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} parent must be a directory: ${JSON.stringify(fileRef)}`);
    }
  }
  return filePath;
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
    return ['p2a.run.v1', 'p2a.run.v2'].includes(data?.schema_version) && data.runId === runId;
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

export function runSidecarRef(runRef, suffix) {
  if (typeof suffix !== 'string' || !suffix.startsWith('.') || !suffix.endsWith('.json')) {
    throw new Error(`run sidecar suffix must look like .<name>.json, got ${JSON.stringify(suffix)}`);
  }
  const normalized = normalizeIndexedRunRef(runRef);
  if (!normalized.endsWith('.json')) throw new Error(`runRef must end with .json: ${JSON.stringify(runRef)}`);
  return `${normalized.slice(0, -'.json'.length)}${suffix}`;
}

function isRunEvidenceFile(filePath) {
  if (isRunRecordFile(filePath)) return true;
  const filename = path.basename(filePath);
  for (const suffix of RUN_SIDECAR_SUFFIXES) {
    if (!filename.endsWith(suffix)) continue;
    const runId = filename.slice(0, -suffix.length);
    try {
      assertSafeRunId(runId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Return run records and sidecars that are not referenced by run-index.json. */
export function orphanRunEvidenceRefs(runsDir, index) {
  const resolvedRunsDir = path.resolve(runsDir);
  if (!existsSync(resolvedRunsDir) || !lstatSync(resolvedRunsDir).isDirectory()) return [];
  const expected = new Set();
  for (const entry of Array.isArray(index?.runs) ? index.runs : []) {
    let runRef;
    try {
      runRef = indexedRunRef(resolvedRunsDir, entry.runId, index);
    } catch {
      continue;
    }
    expected.add(runRef);
    for (const suffix of RUN_SIDECAR_SUFFIXES) {
      expected.add(runSidecarRef(runRef, suffix));
    }
    try {
      const runData = JSON.parse(readFileSync(path.join(resolvedRunsDir, runRef), 'utf8'));
      if (runData.executionEnvelopeRef?.sha256) {
        expected.add(executionEnvelopeStoreRef(runData, runData.executionEnvelopeRef.sha256));
      }
    } catch {
      // Missing or malformed indexed runs are reported by run-store validation.
    }
  }
  const refs = [];
  const inspectDirectory = (dirPath, prefix = '') => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dirPath, entry.name);
      const ref = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isRunEvidenceFile(filePath) && !expected.has(ref)) refs.push(ref);
    }
  };
  inspectDirectory(resolvedRunsDir);
  for (const entry of readdirSync(resolvedRunsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !RUN_PARTITION_PATTERN.test(entry.name)) continue;
    const partitionPath = path.join(resolvedRunsDir, entry.name);
    inspectDirectory(partitionPath, entry.name);
    const envelopesPath = path.join(partitionPath, 'envelopes');
    if (!existsSync(envelopesPath) || !lstatSync(envelopesPath).isDirectory()) continue;
    for (const envelope of readdirSync(envelopesPath, { withFileTypes: true })) {
      if (!envelope.isFile() || !SHA256_PATTERN.test(envelope.name.slice(0, -'.json'.length)) || !envelope.name.endsWith('.json')) continue;
      const ref = `${entry.name}/envelopes/${envelope.name}`;
      if (!expected.has(ref)) refs.push(ref);
    }
  }
  return refs.sort();
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

export function runMatchesSourceContext(run, source) {
  return run.projectId === source.projectId
    && run.iterationId === source.iterationId
    && run.sourceLayout === source.sourceLayout
    && taskGraphRefMatchesGraph(run.taskGraphRef, source.graphPath, source.artifactRoot);
}

export function runsMatchingTaskGraph(runs, graphPath, artifactRoot = null) {
  return runs.filter((run) => taskGraphRefMatchesGraph(
    run.taskGraphRef,
    graphPath,
    artifactRoot,
  ));
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

export function defaultArtifactRootForGraph(graphPath) {
  return path.dirname(defaultRunsDirForGraph(graphPath));
}

export function resolveRunsDir(args) {
  if (args.runs) return path.resolve(args.runs);
  if (args.artifacts) return path.join(path.resolve(args.artifacts), 'runs');
  if (args.graph) return defaultRunsDirForGraph(path.resolve(args.graph));
  return path.resolve(DEFAULT_RUNS_DIR);
}
