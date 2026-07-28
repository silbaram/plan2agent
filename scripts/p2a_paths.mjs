/** Shared path helpers for relocatable Plan2Agent project harness scripts. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GREENFIELD_REQUIRED_FILES, P2A_DIR } from './p2a_constants.mjs';

export { P2A_DIR };
export const P2A_ARTIFACTS_DIR = path.join(P2A_DIR, 'artifacts');
export const P2A_SCRIPTS_DIR = path.join(P2A_DIR, 'scripts');
export const P2A_SCHEMAS_DIR = path.join(P2A_DIR, 'schemas');
export const P2A_PROJECT_CONFIG = path.join(P2A_DIR, 'project.config.json');
export const P2A_MANIFEST = path.join(P2A_DIR, 'manifest.json');

export function findP2aProjectRoot(startPath = process.cwd()) {
  const fallback = path.resolve(startPath);
  let candidate = fallback;
  while (true) {
    if (isDirectory(path.join(candidate, P2A_DIR))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return fallback;
    candidate = parent;
  }
}

export function resolveP2aPaths(importMetaUrl) {
  const filename = fileURLToPath(importMetaUrl);
  const scriptDir = path.dirname(filename);
  const runtimeRoot = path.resolve(scriptDir, '..');
  const embedded = path.basename(runtimeRoot) === P2A_DIR;
  // The runtime can be an npm package, a toolkit checkout, or a legacy copy
  // inside .plan2agent/.  It must never determine the caller's project when
  // it is installed globally.
  const projectRoot = embedded ? path.resolve(runtimeRoot, '..') : findP2aProjectRoot();
  return {
    filename,
    scriptDir,
    runtimeRoot,
    // Keep this alias for internal callers while runtimeRoot becomes the
    // explicit name used by new code.
    toolRoot: runtimeRoot,
    projectRoot,
    scriptsDir: path.join(runtimeRoot, 'scripts'),
    schemasDir: path.join(runtimeRoot, 'schemas'),
    embedded,
    toolkitCheckout: existsSync(path.join(runtimeRoot, '.git')),
  };
}

export function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function normalizeProjectId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || null;
}

export function normalizeProjectIdFromPath(targetRoot, fallback = 'project') {
  return normalizeProjectId(path.basename(path.resolve(targetRoot))) ?? fallback;
}

export function relativeToProject(projectRoot, filePath) {
  const relative = path.relative(projectRoot, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizePath(relative);
  }
  return normalizePath(filePath);
}

export function scriptCommandPath(paths, scriptName) {
  return relativeToProject(paths.projectRoot, path.join(paths.scriptsDir, scriptName));
}

export function nodeScriptCommand(paths, scriptName, args = []) {
  return ['node', scriptCommandPath(paths, scriptName), ...args];
}

function isIterativeArtifactRoot(candidate) {
  return existsSync(path.join(candidate, 'current-spec.json')) && existsSync(path.join(candidate, 'iterations'));
}

export function artifactProjectRoots(cwd = findP2aProjectRoot()) {
  const artifactsRoot = path.join(cwd, P2A_ARTIFACTS_DIR);
  if (!existsSync(artifactsRoot)) return [];
  try {
    return readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(artifactsRoot, entry.name))
      .filter((candidate) => isIterativeArtifactRoot(candidate))
      .sort();
  } catch {
    return [];
  }
}

export function singleArtifactProjectRoot(cwd = findP2aProjectRoot()) {
  const roots = artifactProjectRoots(cwd);
  return roots.length === 1 ? roots[0] : null;
}

export function configuredTaskGraphPath(cwd = findP2aProjectRoot()) {
  const configPath = path.join(cwd, P2A_PROJECT_CONFIG);
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof config?.taskGraph !== 'string' || config.taskGraph.trim() === '') return null;
    return path.resolve(cwd, config.taskGraph);
  } catch {
    return null;
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function readJsonIfPresent(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function hasGreenfieldGateBundle(artifactRoot) {
  return GREENFIELD_REQUIRED_FILES.every((relativePath) => {
    const candidate = path.join(artifactRoot, relativePath);
    return isFile(candidate);
  });
}

function scaffoldArtifactRootInfo(cwd, projectId, artifactRoot) {
  const hasCurrentSpec = isFile(path.join(artifactRoot, 'current-spec.json'));
  const hasIterations = isDirectory(path.join(artifactRoot, 'iterations'));
  return {
    projectId,
    artifactRoot,
    artifactRootRef: normalizePath(path.relative(cwd, artifactRoot)),
    hasCurrentSpec,
    hasIterations,
    hasGreenfieldGateBundle: hasGreenfieldGateBundle(artifactRoot),
  };
}

function requiresIterationInit(info) {
  return info.hasGreenfieldGateBundle && !info.hasCurrentSpec && !info.hasIterations;
}

function hasIncompleteIterationLayout(info) {
  return info.hasCurrentSpec !== info.hasIterations;
}

export function isScaffoldProject(cwd = findP2aProjectRoot()) {
  const manifest = readJsonIfPresent(path.join(cwd, P2A_MANIFEST));
  return ['init', 'scaffold'].includes(manifest?.provenance?.mode);
}

export function uninitializedScaffoldArtifactRootInfos(cwd = findP2aProjectRoot()) {
  if (!isScaffoldProject(cwd)) return [];
  const artifactsRoot = path.join(cwd, P2A_ARTIFACTS_DIR);
  if (!existsSync(artifactsRoot)) return [];
  try {
    return readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const artifactRoot = path.join(artifactsRoot, entry.name);
        const info = scaffoldArtifactRootInfo(cwd, entry.name, artifactRoot);
        return requiresIterationInit(info) ? info : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  } catch {
    return [];
  }
}

function incompleteScaffoldArtifactRootInfos(cwd = findP2aProjectRoot()) {
  if (!isScaffoldProject(cwd)) return [];
  const artifactsRoot = path.join(cwd, P2A_ARTIFACTS_DIR);
  if (!existsSync(artifactsRoot)) return [];
  try {
    return readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const artifactRoot = path.join(artifactsRoot, entry.name);
        const info = scaffoldArtifactRootInfo(cwd, entry.name, artifactRoot);
        return hasIncompleteIterationLayout(info) ? info : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  } catch {
    return [];
  }
}

export function formatUninitializedScaffoldArtifactMessage(infos, subject = 'greenfield artifact root is not ready for execution') {
  const roots = Array.isArray(infos) ? infos : [infos];
  if (roots.length === 1) {
    const info = roots[0];
    return [
      `${subject}: ${info.artifactRootRef}`,
      'This scaffold project must be converted to the iteration layout before task execution.',
      `Run: p2a iteration init --artifacts ${info.artifactRootRef} --iteration-id v1-mvp`,
    ].join('\n');
  }
  return [
    `${subject}; multiple greenfield artifact roots were found:`,
    ...roots.map((info) => `- ${info.artifactRootRef}`),
    'Convert one of them before task execution, for example:',
    `p2a iteration init --artifacts ${roots[0]?.artifactRootRef ?? '.plan2agent/artifacts/<project_id>'} --iteration-id v1-mvp`,
  ].join('\n');
}

function formatIncompleteScaffoldArtifactMessage(infos, subject = 'iteration layout is incomplete') {
  const roots = Array.isArray(infos) ? infos : [infos];
  if (roots.length === 1) {
    const info = roots[0];
    return [
      `${subject}: ${info.artifactRootRef}`,
      'current-spec.json and iterations/ must exist together before task execution.',
      'Repair or restore the iteration metadata before starting tasks.',
    ].join('\n');
  }
  return [
    `${subject}; multiple incomplete artifact roots were found:`,
    ...roots.map((info) => `- ${info.artifactRootRef}`),
    'Repair or restore one artifact root before task execution.',
  ].join('\n');
}

export function assertNoUninitializedScaffoldArtifactRoots(cwd = findP2aProjectRoot()) {
  const incompleteInfos = incompleteScaffoldArtifactRootInfos(cwd);
  if (incompleteInfos.length) throw new Error(formatIncompleteScaffoldArtifactMessage(incompleteInfos));
  const infos = uninitializedScaffoldArtifactRootInfos(cwd);
  if (!infos.length) return;
  throw new Error(formatUninitializedScaffoldArtifactMessage(infos));
}

function scaffoldGraphArtifactRootInfo(graphPath, cwd = process.cwd()) {
  const projectRoot = findP2aProjectRoot(cwd);
  if (!isScaffoldProject(projectRoot)) return null;
  if (typeof graphPath !== 'string' || graphPath.trim().length === 0) return null;

  const resolvedGraphPath = path.resolve(cwd, graphPath);
  if (path.basename(resolvedGraphPath) !== 'task-graph.json') return null;

  const gateDir = path.dirname(resolvedGraphPath);
  if (path.basename(gateDir) !== 'gate-c-task-graph') return null;

  const artifactRoot = path.dirname(gateDir);
  const artifactsRoot = path.resolve(projectRoot, P2A_ARTIFACTS_DIR);
  if (!isPathInside(artifactRoot, artifactsRoot)) return null;

  const artifactRelative = path.relative(artifactsRoot, artifactRoot);
  if (!artifactRelative || artifactRelative.startsWith('..') || path.isAbsolute(artifactRelative)) return null;
  if (artifactRelative.split(path.sep).length !== 1) return null;

  return {
    ...scaffoldArtifactRootInfo(projectRoot, path.basename(artifactRoot), artifactRoot),
    graphPath: resolvedGraphPath,
  };
}

export function uninitializedScaffoldGraphInfo(graphPath, cwd = process.cwd()) {
  const info = scaffoldGraphArtifactRootInfo(graphPath, cwd);
  return info && requiresIterationInit(info) ? info : null;
}

function incompleteScaffoldGraphInfo(graphPath, cwd = process.cwd()) {
  const info = scaffoldGraphArtifactRootInfo(graphPath, cwd);
  return info && hasIncompleteIterationLayout(info) ? info : null;
}

export function assertNotUninitializedScaffoldGraph(graphPath, cwd = process.cwd()) {
  const incompleteInfo = incompleteScaffoldGraphInfo(graphPath, cwd);
  if (incompleteInfo) {
    throw new Error([
      `iteration layout is incomplete for scaffold artifact graph: ${normalizePath(path.relative(cwd, incompleteInfo.graphPath))}`,
      `Artifact root: ${incompleteInfo.artifactRootRef}`,
      'current-spec.json and iterations/ must exist together before task execution.',
      'Repair or restore the iteration metadata before starting tasks.',
    ].join('\n'));
  }
  const info = uninitializedScaffoldGraphInfo(graphPath, cwd);
  if (!info) return;
  throw new Error([
    `greenfield artifact graph is not ready for execution: ${normalizePath(path.relative(cwd, info.graphPath))}`,
    `Artifact root: ${info.artifactRootRef}`,
    'This scaffold project must be converted to the iteration layout before task execution.',
    `Run: p2a iteration init --artifacts ${info.artifactRootRef} --iteration-id v1-mvp`,
  ].join('\n'));
}
