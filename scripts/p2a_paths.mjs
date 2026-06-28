/** Shared path helpers for relocatable Plan2Agent project harness scripts. */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const P2A_DIR = '.plan2agent';
export const P2A_ARTIFACTS_DIR = path.join(P2A_DIR, 'artifacts');
export const P2A_SCRIPTS_DIR = path.join(P2A_DIR, 'scripts');
export const P2A_SCHEMAS_DIR = path.join(P2A_DIR, 'schemas');
export const P2A_PROJECT_CONFIG = path.join(P2A_DIR, 'project.config.json');
export const P2A_MANIFEST = path.join(P2A_DIR, 'manifest.json');
const GREENFIELD_REQUIRED_FILES = [
  'status.md',
  path.join('gate-a-intake', 'intake.json'),
  path.join('gate-b-spec', 'spec.json'),
  path.join('gate-c-task-graph', 'task-graph.json'),
  path.join('gate-d-review', 'review.json'),
];

export function resolveP2aPaths(importMetaUrl) {
  const filename = fileURLToPath(importMetaUrl);
  const scriptDir = path.dirname(filename);
  const toolRoot = path.resolve(scriptDir, '..');
  const embedded = path.basename(toolRoot) === P2A_DIR;
  const projectRoot = embedded ? path.resolve(toolRoot, '..') : toolRoot;
  return {
    filename,
    scriptDir,
    toolRoot,
    projectRoot,
    scriptsDir: path.join(toolRoot, 'scripts'),
    schemasDir: path.join(toolRoot, 'schemas'),
    embedded,
  };
}

export function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
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

export function artifactProjectRoots(cwd = process.cwd()) {
  const artifactsRoot = path.join(cwd, P2A_ARTIFACTS_DIR);
  if (!existsSync(artifactsRoot)) return [];
  try {
    return readdirSync(artifactsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(P2A_ARTIFACTS_DIR, entry.name))
      .filter((candidate) => isIterativeArtifactRoot(path.join(cwd, candidate)))
      .sort();
  } catch {
    return [];
  }
}

export function singleArtifactProjectRoot(cwd = process.cwd()) {
  const roots = artifactProjectRoots(cwd);
  return roots.length === 1 ? roots[0] : null;
}

export function configuredTaskGraphPath(cwd = process.cwd()) {
  const configPath = path.join(cwd, P2A_PROJECT_CONFIG);
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof config?.taskGraph !== 'string' || config.taskGraph.trim() === '') return null;
    return config.taskGraph;
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

export function isScaffoldProject(cwd = process.cwd()) {
  const manifest = readJsonIfPresent(path.join(cwd, P2A_MANIFEST));
  return manifest?.provenance?.mode === 'scaffold';
}

export function uninitializedScaffoldArtifactRootInfos(cwd = process.cwd()) {
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

function incompleteScaffoldArtifactRootInfos(cwd = process.cwd()) {
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
      `Run: node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${info.artifactRootRef} --iteration-id v1-mvp`,
    ].join('\n');
  }
  return [
    `${subject}; multiple greenfield artifact roots were found:`,
    ...roots.map((info) => `- ${info.artifactRootRef}`),
    'Convert one of them before task execution, for example:',
    `node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${roots[0]?.artifactRootRef ?? '.plan2agent/artifacts/<project_id>'} --iteration-id v1-mvp`,
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

export function assertNoUninitializedScaffoldArtifactRoots(cwd = process.cwd()) {
  const incompleteInfos = incompleteScaffoldArtifactRootInfos(cwd);
  if (incompleteInfos.length) throw new Error(formatIncompleteScaffoldArtifactMessage(incompleteInfos));
  const infos = uninitializedScaffoldArtifactRootInfos(cwd);
  if (!infos.length) return;
  throw new Error(formatUninitializedScaffoldArtifactMessage(infos));
}

function scaffoldGraphArtifactRootInfo(graphPath, cwd = process.cwd()) {
  if (!isScaffoldProject(cwd)) return null;
  if (typeof graphPath !== 'string' || graphPath.trim().length === 0) return null;

  const resolvedGraphPath = path.resolve(cwd, graphPath);
  if (path.basename(resolvedGraphPath) !== 'task-graph.json') return null;

  const gateDir = path.dirname(resolvedGraphPath);
  if (path.basename(gateDir) !== 'gate-c-task-graph') return null;

  const artifactRoot = path.dirname(gateDir);
  const artifactsRoot = path.resolve(cwd, P2A_ARTIFACTS_DIR);
  if (!isPathInside(artifactRoot, artifactsRoot)) return null;

  const artifactRelative = path.relative(artifactsRoot, artifactRoot);
  if (!artifactRelative || artifactRelative.startsWith('..') || path.isAbsolute(artifactRelative)) return null;
  if (artifactRelative.split(path.sep).length !== 1) return null;

  return {
    ...scaffoldArtifactRootInfo(cwd, path.basename(artifactRoot), artifactRoot),
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
    `Run: node .plan2agent/scripts/p2a_iteration.mjs init --artifacts ${info.artifactRootRef} --iteration-id v1-mvp`,
  ].join('\n'));
}
