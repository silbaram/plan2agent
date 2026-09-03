#!/usr/bin/env node
/** Minimal project-independent integrity check for changed docs and metadata files. */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const UTF8_EXTENSIONS = new Set([
  '.adoc',
  '.asciidoc',
  '.css',
  '.csv',
  '.htm',
  '.html',
  '.json',
  '.md',
  '.mdx',
  '.rst',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);

function normalizedRelativePath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    throw new Error(`invalid related file path: ${JSON.stringify(candidate)}`);
  }
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/u.test(candidate)) {
    throw new Error(`related file path must be workspace-relative: ${JSON.stringify(candidate)}`);
  }
  const normalized = path.normalize(candidate);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`related file path escapes the workspace: ${JSON.stringify(candidate)}`);
  }
  return normalized;
}

function assertInsideWorkspace(workspacePath, filePath, candidate) {
  const workspaceRealPath = realpathSync(workspacePath);
  const fileRealPath = realpathSync(filePath);
  const relative = path.relative(workspaceRealPath, fileRealPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`related file resolves outside the workspace: ${JSON.stringify(candidate)}`);
  }
}

function existingAncestor(filePath) {
  let candidate = filePath;
  while (!existsSync(candidate) && path.dirname(candidate) !== candidate) {
    candidate = path.dirname(candidate);
  }
  return candidate;
}

function assertValidUtf8(buffer, candidate) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`related text file is not valid UTF-8: ${candidate}`);
  }
}

function verifyFile(workspacePath, candidate) {
  const relativePath = normalizedRelativePath(candidate);
  const filePath = path.resolve(workspacePath, relativePath);
  if (!existsSync(filePath)) {
    assertInsideWorkspace(workspacePath, existingAncestor(filePath), candidate);
    return { path: relativePath.split(path.sep).join('/'), state: 'absent' };
  }
  assertInsideWorkspace(workspacePath, filePath, candidate);
  if (!lstatSync(filePath).isFile()) {
    throw new Error(`related path is not a regular file: ${candidate}`);
  }
  const content = readFileSync(filePath);
  const extension = path.extname(relativePath).toLowerCase();
  if (!extension || UTF8_EXTENSIONS.has(extension)) assertValidUtf8(content, candidate);
  if (extension === '.json') {
    try {
      JSON.parse(content.toString('utf8'));
    } catch (error) {
      throw new Error(`related JSON file is invalid: ${candidate}: ${error.message}`);
    }
  }
  return { path: relativePath.split(path.sep).join('/'), state: 'readable' };
}

export function relatedFilesSha256(candidates, options = {}) {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  if (!existsSync(workspacePath) || !lstatSync(workspacePath).isDirectory()) {
    throw new Error(`workspace directory does not exist: ${workspacePath}`);
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('at least one related file is required');
  }
  const selected = [...new Set(candidates.map(normalizedRelativePath))]
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  hash.update('p2a.related_files.v1\0');
  for (const relativePath of selected) {
    const filePath = path.resolve(workspacePath, relativePath);
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (!existsSync(filePath)) {
      assertInsideWorkspace(workspacePath, existingAncestor(filePath), relativePath);
      hash.update(`absent\0${normalizedPath}\0`);
      continue;
    }
    assertInsideWorkspace(workspacePath, filePath, relativePath);
    const stat = lstatSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`related path is not a regular file: ${relativePath}`);
    }
    const content = readFileSync(filePath);
    hash.update(`file\0${normalizedPath}\0${stat.mode & 0o111}\0${content.length}\0`);
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyRelatedFiles(candidates, options = {}) {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  if (!existsSync(workspacePath) || !lstatSync(workspacePath).isDirectory()) {
    throw new Error(`workspace directory does not exist: ${workspacePath}`);
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('at least one related file is required');
  }
  return candidates.map((candidate) => verifyFile(workspacePath, candidate));
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const results = verifyRelatedFiles(process.argv.slice(2));
    const absent = results.filter((result) => result.state === 'absent').length;
    console.log(`Related file integrity passed: ${results.length} selected (${absent} absent).`);
  } catch (error) {
    console.error(`Related file integrity failed: ${error.message}`);
    process.exitCode = 1;
  }
}
