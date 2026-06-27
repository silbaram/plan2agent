/** Shared path helpers for relocatable Plan2Agent project harness scripts. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const P2A_DIR = '.plan2agent';
export const P2A_ARTIFACTS_DIR = path.join(P2A_DIR, 'artifacts');
export const P2A_SCRIPTS_DIR = path.join(P2A_DIR, 'scripts');
export const P2A_SCHEMAS_DIR = path.join(P2A_DIR, 'schemas');
export const P2A_PROJECT_CONFIG = path.join(P2A_DIR, 'project.config.json');

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
