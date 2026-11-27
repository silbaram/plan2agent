/** Minimal project config detection, read, write, and validation for Plan2Agent v1. */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ValidationError, validateSchema } from './p2a_schema.mjs';

export const P2A_DIR = '.plan2agent';
export const CONFIG_FILENAME = 'config.json';
export const WORK_FILENAME = 'work.json';
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const TOOL_TARGETS = ['codex', 'claude', 'gemini'];

const CONFIG_SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../schemas/config.schema.json', import.meta.url)),
  'utf8',
));

export function p2aDir(targetRoot) {
  return path.join(path.resolve(targetRoot), P2A_DIR);
}

export function configPath(targetRoot) {
  return path.join(p2aDir(targetRoot), CONFIG_FILENAME);
}

export function workPath(targetRoot) {
  return path.join(p2aDir(targetRoot), WORK_FILENAME);
}

export function normalizeProjectId(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64);
  return cleaned && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(cleaned) ? cleaned : null;
}

export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, filePath);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error;
  }
}

export function detectVerifyCommands(targetRoot) {
  const root = path.resolve(targetRoot);
  let test = null;
  let lint = null;
  let typecheck = null;

  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath) && lstatSync(pkgPath).isFile()) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      const pm = existsSync(path.join(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(path.join(root, 'yarn.lock'))
          ? 'yarn'
          : 'npm';
      const run = pm === 'npm' ? 'npm run' : pm;
      if (typeof scripts.test === 'string' && scripts.test.trim() && !scripts.test.includes('no test specified')) {
        test = pm === 'npm' ? 'npm test' : `${pm} test`;
      }
      if (typeof scripts.lint === 'string' && scripts.lint.trim()) lint = `${run} lint`;
      if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) typecheck = `${run} typecheck`;
    } catch {
      // Malformed package.json leaves verification commands unset for explicit configuration.
    }
  }
  if (!test) {
    if (existsSync(path.join(root, 'Cargo.toml'))) {
      test = 'cargo test';
    } else if (existsSync(path.join(root, 'go.mod'))) {
      test = 'go test ./...';
    } else if (existsSync(path.join(root, 'pyproject.toml')) || existsSync(path.join(root, 'pytest.ini'))) {
      test = 'pytest';
    } else if (existsSync(path.join(root, 'build.gradle')) || existsSync(path.join(root, 'build.gradle.kts'))) {
      const isWin = process.platform === 'win32';
      const gradle = isWin && existsSync(path.join(root, 'gradlew.bat'))
        ? 'gradlew.bat'
        : existsSync(path.join(root, 'gradlew'))
          ? './gradlew'
          : 'gradle';
      test = `${gradle} test`;
    } else if (existsSync(path.join(root, 'pom.xml'))) {
      test = 'mvn test';
    }
  }

  return {
    test,
    lint,
    typecheck,
    timeout_ms: DEFAULT_VERIFY_TIMEOUT_MS,
  };
}

export function createDefaultConfig(targetRoot, options = {}) {
  const root = path.resolve(targetRoot);
  let projectId;
  if (options.projectId !== undefined && options.projectId !== null) {
    projectId = normalizeProjectId(options.projectId);
    if (!projectId) {
      throw new ValidationError(`invalid --project-id: ${JSON.stringify(options.projectId)}`);
    }
  } else {
    projectId = normalizeProjectId(path.basename(root)) ?? 'project';
  }
  const tools = Array.isArray(options.tools) ? options.tools : [...TOOL_TARGETS];
  const verify = detectVerifyCommands(root);
  return validateConfig({
    schema_version: 'p2a.config.v1',
    project_id: projectId,
    tools,
    verify,
    buildlore: {
      enabled: false,
      command: 'buildlore',
    },
  });
}

export function validateConfig(data) {
  validateSchema(data, CONFIG_SCHEMA);
  return data;
}

export function readConfig(targetRoot) {
  const file = configPath(targetRoot);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return validateConfig(raw);
  } catch (error) {
    throw new ValidationError(`invalid ${P2A_DIR}/${CONFIG_FILENAME}: ${error.message}`);
  }
}

export function writeConfig(targetRoot, config) {
  const validated = validateConfig(config);
  atomicWriteJson(configPath(targetRoot), validated);
  return validated;
}

export function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(configPath(current)) || existsSync(workPath(current))) {
      return current;
    }
    if (existsSync(path.join(current, '.git'))) {
      return path.resolve(startDir);
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}
