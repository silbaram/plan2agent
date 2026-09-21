/** External Agent Skills lifecycle support for the Plan2Agent CLI. */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  atomicWriteJson,
  atomicWriteText,
  withRunStoreLocks,
} from './p2a_run_store.mjs';

const require = createRequire(import.meta.url);
const P2A_PACKAGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const P2A_PACKAGE = JSON.parse(readFileSync(P2A_PACKAGE_PATH, 'utf8'));
const EXPECTED_SKILLS_VERSION = P2A_PACKAGE.dependencies?.skills;
let resolvedSkillsPackage = null;

function resolveSkillsPackage() {
  if (resolvedSkillsPackage) return resolvedSkillsPackage;
  let packagePath;
  try {
    packagePath = require.resolve('skills/package.json');
  } catch (error) {
    throw new Error(`upstream skills@${EXPECTED_SKILLS_VERSION} dependency is unavailable: ${error.code || error.message}`);
  }
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (metadata.version !== EXPECTED_SKILLS_VERSION) {
    throw new Error(`upstream skills dependency version mismatch: expected ${EXPECTED_SKILLS_VERSION}, found ${metadata.version}`);
  }
  const bin = path.join(path.dirname(packagePath), 'bin', 'cli.mjs');
  if (!existsSync(bin) || !lstatSync(bin).isFile()) {
    throw new Error(`upstream skills@${EXPECTED_SKILLS_VERSION} CLI entrypoint is unavailable`);
  }
  resolvedSkillsPackage = { bin, version: metadata.version };
  return resolvedSkillsPackage;
}

export const EXTERNAL_SKILLS_LOCK_FILE = 'p2a-skills.lock.json';
export const EXTERNAL_SKILLS_LOCK_SCHEMA = 'p2a.external-skills-lock.v1';
export const EXTERNAL_SKILLS_TRANSACTION_FILE = 'external-skills-transaction.json';
export const EXTERNAL_SKILLS_UPSTREAM = Object.freeze({
  package: 'skills',
  version: EXPECTED_SKILLS_VERSION,
});
export const EXTERNAL_SKILL_TOOLS = Object.freeze(['codex', 'claude', 'gemini']);

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_SKILLS = 500;
const MAX_STAGED_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_UPSTREAM_OUTPUT_BYTES = 20 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Lock hashes and reviewed plans must use the same order on every machine.
function comparePortableText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(filePath, label = filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function readOptionalJson(filePath, label = filePath) {
  if (!existsSync(filePath)) return null;
  return readJson(filePath, label);
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertNoSymlinkComponents(root, candidate, { allowMissing = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`path escapes the project root: ${normalizePath(path.relative(resolvedRoot, resolvedCandidate))}`);
  }
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`path must not traverse a symbolic link: ${normalizePath(path.relative(resolvedRoot, current))}`);
      }
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function validatePortableSegment(segment, relativePath) {
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(`unsafe skill path segment in ${relativePath}`);
  }
  if (/[\u0000-\u001f<>:"|?*\\]/.test(segment) || /[. ]$/.test(segment)) {
    throw new Error(`skill path is not portable across supported systems: ${relativePath}`);
  }
  if (WINDOWS_RESERVED_NAME.test(segment)) {
    throw new Error(`skill path uses a reserved Windows name: ${relativePath}`);
  }
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('skill path must be a string');
  const normalized = normalizePath(relativePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`unsafe skill path: ${relativePath}`);
  }
  for (const segment of normalized.split('/')) validatePortableSegment(segment, normalized);
  return normalized;
}

// Register ancestors too: Foo/a and foo/b collide on case-insensitive filesystems.
function registerPortablePath(paths, relative) {
  const segments = relative.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const folded = prefix.toLowerCase();
    if (paths.has(folded) && paths.get(folded) !== prefix) {
      throw new Error(`case-insensitive collision in external skill: ${prefix}`);
    }
    paths.set(folded, prefix);
  }
}

function parseSkillFrontmatter(skillRoot) {
  const skillFile = path.join(skillRoot, 'SKILL.md');
  if (!existsSync(skillFile) || !lstatSync(skillFile).isFile()) {
    throw new Error('external skill must contain a regular root SKILL.md file');
  }
  const content = readFileSync(skillFile, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter');
  let metadata;
  try {
    metadata = parseYaml(match[1]);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid YAML: ${error.message}`);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('SKILL.md frontmatter must be an object');
  }
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(`SKILL.md name must be lowercase kebab-case and at most 64 characters: ${JSON.stringify(name)}`);
  }
  if (!description || description.length > 1_024) {
    throw new Error('SKILL.md description must be between 1 and 1024 characters');
  }
  return { name, description };
}

function inspectSkillDirectory(skillRoot) {
  const rootEntry = lstatSync(skillRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('staged skill root must be a regular directory');
  }
  const metadata = parseSkillFrontmatter(skillRoot);
  const files = [];
  const portablePaths = new Map();
  let totalBytes = 0;
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePortableText(left.name, right.name));
    for (const entry of entries) {
      validatePortableSegment(entry.name, entry.name);
      const absolute = path.join(directory, entry.name);
      const relative = validateRelativePath(path.relative(skillRoot, absolute));
      registerPortablePath(portablePaths, relative);
      const details = lstatSync(absolute);
      if (details.isSymbolicLink()) throw new Error(`symbolic links are not allowed in external skills: ${relative}`);
      if (details.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!details.isFile()) throw new Error(`external skills may contain only regular files: ${relative}`);
      if (details.size > MAX_SKILL_FILE_BYTES) {
        throw new Error(`external skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${relative}`);
      }
      totalBytes += details.size;
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new Error(`external skill exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`);
      }
      files.push({
        path: relative,
        sha256: sha256(readFileSync(absolute)),
        bytes: details.size,
      });
      if (files.length > MAX_SKILL_FILES) {
        throw new Error(`external skill exceeds ${MAX_SKILL_FILES} files`);
      }
    }
  };
  visit(skillRoot);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('external skill must contain SKILL.md');
  }
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path);
    digest.update('\0');
    digest.update(readFileSync(path.join(skillRoot, ...file.path.split('/'))));
    digest.update('\0');
  }
  return { ...metadata, files, contentSha256: digest.digest('hex'), totalBytes };
}

function findLocalSkillRoot(sourceRoot, skillName) {
  const matches = [];
  let directories = 0;
  const visit = (directory) => {
    directories += 1;
    if (directories > 10_000) throw new Error('local skill source exceeds the directory discovery limit');
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      try {
        if (parseSkillFrontmatter(directory).name === skillName) matches.push(directory);
      } catch {
        // Upstream discovery decides whether unrelated SKILL.md candidates are valid.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      visit(path.join(directory, entry.name));
    }
  };
  visit(sourceRoot);
  if (matches.length !== 1) {
    throw new Error(`local source must contain exactly one discoverable ${skillName} skill directory`);
  }
  return matches[0];
}

function sanitizeUrlCredentials(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactSecrets(value) {
  let redacted = String(value)
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1<credentials>@')
    .replace(/(?:ghp|github_pat|glpat)-?[A-Za-z0-9_\-]{10,}/g, '<token>');
  if (process.env.HOME) redacted = redacted.replaceAll(process.env.HOME, '<home>');
  for (const [key, secret] of Object.entries(process.env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)/i.test(key)) continue;
    if (typeof secret === 'string' && secret.length >= 4) redacted = redacted.replaceAll(secret, `<${key.toLowerCase()}>`);
  }
  return redacted;
}

export function redactExternalSkillsMessage(value) {
  return redactSecrets(value);
}

function assertSourceHasNoUrlCredentials(source) {
  let parsed;
  try { parsed = new URL(source); } catch { return; }
  if (parsed.protocol === 'file:') {
    throw new Error('file: source URLs are not portable; use a project-relative local path instead');
  }
  if (parsed.username || parsed.password) {
    throw new Error('source URLs must not contain userinfo or credentials; use a Git credential helper instead');
  }
}

function normalizeLocalSource(source, targetRoot) {
  const candidate = path.isAbsolute(source) ? source : path.resolve(targetRoot, source);
  if (!existsSync(candidate)) return null;
  assertNoSymlinkComponents(targetRoot, candidate);
  const realTarget = realpathSync(targetRoot);
  const realSource = realpathSync(candidate);
  if (!isPathInside(realTarget, realSource)) {
    throw new Error('local external skill sources must be inside the target project for a portable team lock');
  }
  const relative = normalizePath(path.relative(realTarget, realSource));
  if (!relative) throw new Error('local external skill source must be a project subdirectory, not the target root');
  return {
    invocation: realSource,
    portable: `./${relative}`,
  };
}

function invocationSource(source, targetRoot, sourceTypeHint = null) {
  assertSourceHasNoUrlCredentials(source);
  const local = sourceTypeHint && sourceTypeHint !== 'local'
    ? null
    : normalizeLocalSource(source, targetRoot);
  if (sourceTypeHint === 'local' && !local) {
    throw new Error(`locked local external skill source is missing: ${source}`);
  }
  if (local) return { type: 'local', ...local };
  // skills@1.7.0 can clone git:// sources but treats #ref as part of that
  // repository URL. Give its parser an HTTPS-shaped alias and let Git rewrite
  // it only in the child process; provenance always keeps the original remote.
  if (/^git:\/\//i.test(source)) {
    const remoteSpec = source.split('#')[0];
    const alias = `https://p2a-git-adapter.invalid/${sha256(remoteSpec)}.git`;
    return {
      type: 'git',
      invocation: `${alias}${source.slice(remoteSpec.length)}`,
      portable: sanitizeUrlCredentials(source),
      remoteSpec,
      gitConfig: [[`url.${remoteSpec}.insteadOf`, alias]],
    };
  }
  return { type: sourceTypeHint, invocation: source, portable: sanitizeUrlCredentials(source) };
}

function canonicalSourceSpec(upstreamEntry, sourceInfo) {
  if (sourceInfo.remoteSpec) return sanitizeUrlCredentials(sourceInfo.remoteSpec);
  if (upstreamEntry?.sourceType === 'local') return sourceInfo.portable;
  const value = upstreamEntry?.sourceUrl || upstreamEntry?.source || sourceInfo.portable;
  return sanitizeUrlCredentials(value);
}

function gitRemoteForSource(sourceType, sourceSpec) {
  if (sourceType === 'github' && /^[^/:\s]+\/[^/\s]+$/.test(sourceSpec)) {
    return `https://github.com/${sourceSpec.replace(/\.git$/, '')}.git`;
  }
  if (sourceType === 'gitlab' && /^[^/:\s]+\/[^/\s]+$/.test(sourceSpec)) {
    return `https://gitlab.com/${sourceSpec.replace(/\.git$/, '')}.git`;
  }
  return sourceSpec;
}

function resolveGitCommit(sourceType, sourceSpec, ref) {
  if (!['github', 'gitlab', 'git'].includes(sourceType)) return null;
  if (ref && GIT_COMMIT_PATTERN.test(ref)) return ref.toLowerCase();
  const remote = gitRemoteForSource(sourceType, sourceSpec);
  // Resolve exact ref names, preferring a branch over a same-named tag as clone
  // does. Annotated tags must be peeled to their commit, not stored as tag IDs.
  const refs = !ref ? ['HEAD'] : ref.startsWith('refs/')
    ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
  const patterns = refs.flatMap((candidate) => [candidate, `${candidate}^{}`]);
  const result = spawnSync('git', ['ls-remote', '--exit-code', remote, ...patterns], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 2 * 1024 * 1024, timeout: 60_000,
  });
  if (result.status === 0) {
    const revisions = new Map(String(result.stdout).split(/\r?\n/).map((line) => {
      const [hash, name] = line.trim().split(/\s+/);
      return [name, hash];
    }));
    for (const candidate of refs) {
      const commit = revisions.get(`${candidate}^{}`) ?? revisions.get(candidate);
      if (GIT_COMMIT_PATTERN.test(commit || '')) return commit.toLowerCase();
    }
  }
  throw new Error(`unable to resolve an immutable Git commit for ${redactSecrets(sourceSpec)}`);
}

function sourceWithCommit(source) {
  if (!source.resolvedCommit) return source.spec;
  const withoutFragment = source.spec.split('#')[0];
  return `${withoutFragment}#${source.resolvedCommit}`;
}

function assertSkillsRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new Error(`p2a skills requires Node.js >=22.20.0 because skills@${EXPECTED_SKILLS_VERSION} requires it`);
  }
}

export function externalSkillsPaths(targetRoot) {
  const root = path.resolve(targetRoot);
  return {
    targetRoot: root,
    p2aDir: path.join(root, '.plan2agent'),
    manifest: path.join(root, '.plan2agent', 'manifest.json'),
    lock: path.join(root, EXTERNAL_SKILLS_LOCK_FILE),
    temporaryRoot: path.join(root, '.plan2agent', 'tmp'),
    transaction: path.join(root, '.plan2agent', 'tmp', EXTERNAL_SKILLS_TRANSACTION_FILE),
  };
}

export function readExternalSkillsProject(targetRoot) {
  const paths = externalSkillsPaths(targetRoot);
  if (!existsSync(paths.targetRoot) || !lstatSync(paths.targetRoot).isDirectory()) {
    throw new Error(`target project directory does not exist: ${paths.targetRoot}`);
  }
  assertNoSymlinkComponents(paths.targetRoot, paths.p2aDir);
  if (!existsSync(paths.manifest)) {
    throw new Error('target is not initialized: .plan2agent/manifest.json is missing; run p2a init first');
  }
  assertNoSymlinkComponents(paths.targetRoot, paths.manifest);
  assertNoSymlinkComponents(paths.targetRoot, paths.lock, { allowMissing: true });
  const manifest = readJson(paths.manifest, '.plan2agent/manifest.json');
  const lock = readOptionalJson(paths.lock, EXTERNAL_SKILLS_LOCK_FILE) ?? {
    schema_version: EXTERNAL_SKILLS_LOCK_SCHEMA,
    generatedAt: new Date().toISOString(),
    upstream: EXTERNAL_SKILLS_UPSTREAM,
    skills: {},
  };
  validateExternalSkillsLock(lock);
  return { paths, manifest, lock };
}

export function validateExternalSkillsLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('external skills lock must be an object');
  if (lock.schema_version !== EXTERNAL_SKILLS_LOCK_SCHEMA) {
    throw new Error(`unsupported external skills lock schema: ${JSON.stringify(lock.schema_version)}`);
  }
  if (typeof lock.generatedAt !== 'string' || !Number.isFinite(Date.parse(lock.generatedAt))) {
    throw new Error('external skills lock has an invalid generatedAt timestamp');
  }
  if (lock.upstream?.package !== 'skills' || typeof lock.upstream.version !== 'string') {
    throw new Error('external skills lock has invalid upstream package metadata');
  }
  if (!lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) {
    throw new Error('external skills lock skills must be an object');
  }
  for (const [name, record] of Object.entries(lock.skills)) {
    if (!SKILL_NAME_PATTERN.test(name) || record?.name !== name) throw new Error(`invalid external skill record name: ${name}`);
    if (typeof record.description !== 'string' || !record.description.trim() || record.description.length > 1_024) {
      throw new Error(`external skill ${name} has an invalid description`);
    }
    if (!record.source || typeof record.source.spec !== 'string' || !record.source.spec) throw new Error(`external skill ${name} has an invalid source`);
    if (!['github', 'gitlab', 'git', 'local'].includes(record.source.type)) {
      throw new Error(`external skill ${name} has an unsupported source type`);
    }
    assertSourceHasNoUrlCredentials(record.source.spec);
    if (record.source.type === 'local'
      && (!record.source.spec.startsWith('./') || path.isAbsolute(record.source.spec))) {
      throw new Error(`external skill ${name} local source must be project-relative`);
    }
    if (record.source.type === 'local') validateRelativePath(record.source.spec.slice(2));
    if (record.source.type !== 'local' && path.isAbsolute(record.source.spec)) {
      throw new Error(`external skill ${name} source must not contain a private absolute path`);
    }
    if (['github', 'gitlab', 'git'].includes(record.source.type)
      && !GIT_COMMIT_PATTERN.test(record.source.resolvedCommit || '')) {
      throw new Error(`external skill ${name} is missing a resolved Git commit`);
    }
    if (record.source.skillPath !== undefined) {
      const skillPath = validateRelativePath(record.source.skillPath);
      if (path.posix.basename(skillPath) !== 'SKILL.md') throw new Error(`external skill ${name} has an invalid source skillPath`);
    }
    if (!SHA256_PATTERN.test(record.contentSha256 || '')) throw new Error(`external skill ${name} has an invalid content digest`);
    if (!Array.isArray(record.tools) || !record.tools.length
      || record.tools.some((tool) => !EXTERNAL_SKILL_TOOLS.includes(tool))) {
      throw new Error(`external skill ${name} has invalid tool targets`);
    }
    if (!Array.isArray(record.installedPaths) || !record.installedPaths.length) {
      throw new Error(`external skill ${name} has no installed paths`);
    }
    const normalizedTools = normalizeTools(record.tools, null);
    if (JSON.stringify(record.tools) !== JSON.stringify(normalizedTools)) {
      throw new Error(`external skill ${name} tool targets must be unique and canonical`);
    }
    const expectedTargets = [
      ...(normalizedTools.some((tool) => tool === 'codex' || tool === 'gemini') ? ['agents-shared'] : []),
      ...(normalizedTools.includes('claude') ? ['claude'] : []),
    ];
    if (JSON.stringify(record.targets) !== JSON.stringify(expectedTargets)) {
      throw new Error(`external skill ${name} normalized provider targets are invalid`);
    }
    if (JSON.stringify(record.installedPaths) !== JSON.stringify(installedPathsForSkill(name, normalizedTools))) {
      throw new Error(`external skill ${name} installed paths do not match its tool targets`);
    }
    if (!Array.isArray(record.files) || !record.files.length) throw new Error(`external skill ${name} has no file inventory`);
    if (record.files.length > MAX_SKILL_FILES) throw new Error(`external skill ${name} exceeds the file count limit`);
    const seenFiles = new Set();
    const portablePaths = new Map();
    let totalBytes = 0;
    for (const file of record.files) {
      const filePath = validateRelativePath(file?.path);
      if (seenFiles.has(filePath)) throw new Error(`external skill ${name} has duplicate file inventory: ${filePath}`);
      seenFiles.add(filePath);
      registerPortablePath(portablePaths, filePath);
      if (!SHA256_PATTERN.test(file?.sha256 || '') || !Number.isSafeInteger(file?.bytes) || file.bytes < 0) {
        throw new Error(`external skill ${name} has an invalid file record`);
      }
      if (file.bytes > MAX_SKILL_FILE_BYTES) throw new Error(`external skill ${name} exceeds the per-file byte limit`);
      totalBytes += file.bytes;
    }
    if (!seenFiles.has('SKILL.md')) throw new Error(`external skill ${name} inventory is missing SKILL.md`);
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) throw new Error(`external skill ${name} exceeds the total byte limit`);
  }
  return lock;
}

function upstreamChildEnvironment(templateDirectory = null, gitConfig = []) {
  const environment = {
    ...process.env,
    CI: '1',
    DO_NOT_TRACK: '1',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(environment)) {
    if (/^(?:CODEX|CLAUDE|GEMINI)_/.test(key)) delete environment[key];
  }
  // Keep checkout bytes independent of the caller's platform and Git settings.
  // Append overrides so credential helpers and URL rewrites remain available.
  let count = Number(environment.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid GIT_CONFIG_COUNT environment');
  for (const [key, value] of [['core.autocrlf', 'false'], ['core.eol', 'lf'], ...gitConfig]) {
    environment[`GIT_CONFIG_KEY_${count}`] = key;
    environment[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  environment.GIT_CONFIG_COUNT = String(count);
  if (templateDirectory) environment.GIT_TEMPLATE_DIR = templateDirectory;
  return environment;
}

function findUpstreamLockEntry(upstreamLock, name) {
  if (upstreamLock?.skills?.[name]) return upstreamLock.skills[name];
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return Object.entries(upstreamLock?.skills ?? {}).find(([candidate]) => (
    candidate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') === normalized
  ))?.[1] ?? null;
}

function parseUpstreamJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`skills@${EXPECTED_SKILLS_VERSION} returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`skills@${EXPECTED_SKILLS_VERSION} JSON result must be an array`);
  return parsed;
}

function sourceTypeFrom(sourceInfo, upstreamEntry) {
  const type = upstreamEntry?.sourceType ?? sourceInfo.type;
  if (['github', 'gitlab', 'git', 'local'].includes(type)) return type;
  if (type) throw new Error(`unsupported external skill source type: ${type}; use a Git repository or project-relative local path`);
  if (/^[^/:\s]+\/[^/\s]+(?:#.*)?$/.test(sourceInfo.portable)) return 'github';
  if (/^https?:\/\//.test(sourceInfo.portable)) return 'git';
  return 'git';
}

// The upstream copy adapter dereferences links. Verify its result against the
// immutable Git tree, without checking out or following any repository links.
function verifyRemoteSkill(stageRoot, source, skillFile, inspected, skillRoot, repositories) {
  if (typeof skillFile !== 'string') throw new Error('upstream did not report the remote skill path');
  const portableSkillFile = validateRelativePath(skillFile);
  if (path.posix.basename(portableSkillFile) !== 'SKILL.md') throw new Error('remote skill path must identify SKILL.md');
  const key = `${source.spec}#${source.resolvedCommit}`;
  const git = (directory, args) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${path.join(stageRoot, 'empty-template')}`, '-C', directory, ...args], {
      encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: MAX_UPSTREAM_OUTPUT_BYTES,
      env: { ...upstreamChildEnvironment(), GIT_ALLOW_PROTOCOL: 'https:http:ssh:git', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`remote Git validation failed: ${redactSecrets(result.error?.message || result.stderr)}`);
    }
    return result.stdout;
  };
  let repository = repositories.get(key);
  if (!repository) {
    repository = mkdtempSync(path.join(stageRoot, 'git-audit-'));
    const template = path.join(stageRoot, 'empty-template');
    mkdirSync(template, { recursive: true });
    git(repository, ['init', '--bare', `--template=${template}`]);
    git(repository, ['fetch', '--no-tags', '--depth=1', gitRemoteForSource(source.type, source.spec), source.resolvedCommit]);
    const commit = git(repository, ['rev-parse', 'FETCH_HEAD^{commit}']).trim();
    if (commit !== source.resolvedCommit) throw new Error('resolved revision is not the locked Git commit');
    repositories.set(key, repository);
  }
  const directory = path.posix.dirname(portableSkillFile);
  const prefix = directory === '.' ? '' : `${directory}/`;
  const tree = git(repository, ['ls-tree', '-r', '-z', '--full-tree', source.resolvedCommit, '--', `:(literal)${prefix || '.'}`]);
  const blobs = new Map();
  const portablePaths = new Map();
  for (const entry of tree.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match || !match[4].startsWith(prefix)) throw new Error('invalid remote Git tree entry');
    const relative = validateRelativePath(match[4].slice(prefix.length));
    registerPortablePath(portablePaths, relative);
    if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob') {
      throw new Error(`remote skill contains a symbolic link or non-regular Git entry: ${relative}`);
    }
    blobs.set(relative, match[3]);
  }
  for (const file of inspected.files) {
    const bytes = readFileSync(path.join(skillRoot, ...file.path.split('/')));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blobs.get(file.path) !== blob) throw new Error(`staged remote bytes differ from the pinned Git source: ${file.path}`);
  }
  return portableSkillFile;
}

export function prepareExternalSkills(targetRoot, source, skillNames = ['*'], options = {}) {
  assertSkillsRuntime();
  const upstreamPackage = resolveSkillsPackage();
  const project = readExternalSkillsProject(targetRoot);
  const sourceInfo = invocationSource(source, project.paths.targetRoot, options.sourceType ?? null);
  assertNoSymlinkComponents(project.paths.targetRoot, project.paths.temporaryRoot, { allowMissing: true });
  const temporaryRootExisted = existsSync(project.paths.temporaryRoot);
  mkdirSync(project.paths.temporaryRoot, { recursive: true });
  const stageRoot = mkdtempSync(path.join(project.paths.temporaryRoot, 'skills-'));
  const cleanupStage = () => {
    rmSync(stageRoot, { recursive: true, force: true });
    if (!temporaryRootExisted) {
      try {
        if (readdirSync(project.paths.temporaryRoot).length === 0) rmdirSync(project.paths.temporaryRoot);
      } catch {
        // Another process or an apply transaction may be using the shared temporary root.
      }
    }
  };
  const args = [
    upstreamPackage.bin,
    'add',
    sourceInfo.invocation,
    '--skill',
    ...skillNames,
    '--agent',
    'codex',
    '--copy',
    '--yes',
    '--json',
    '--full-depth',
  ];
  try {
    // info/attributes takes precedence over repository attributes. Raw Git blob
    // bytes are the portable contract, including for sources requesting CRLF,
    // ident expansion or checkout filters. The private template has no hooks.
    const templateDirectory = path.join(stageRoot, 'git-template');
    mkdirSync(path.join(templateDirectory, 'info'), { recursive: true });
    writeFileSync(path.join(templateDirectory, 'info', 'attributes'), '* -text -ident -filter -working-tree-encoding\n');
    const result = spawnSync(process.execPath, args, {
      cwd: stageRoot,
      encoding: 'utf8',
      shell: false,
      env: upstreamChildEnvironment(templateDirectory, sourceInfo.gitConfig),
      maxBuffer: MAX_UPSTREAM_OUTPUT_BYTES,
      timeout: 120_000,
    });
    if (result.error) throw new Error(`failed to start skills@${EXPECTED_SKILLS_VERSION}: ${redactSecrets(result.error.message)}`);
    const jsonResults = result.stdout?.trim() ? parseUpstreamJson(result.stdout) : [];
    if (result.status !== 0) {
      const formalErrors = jsonResults
        .filter((item) => item?.status !== 'installed')
        .map((item) => item?.error || item?.reason)
        .filter(Boolean);
      const fallback = redactSecrets(String(result.stderr || '')).trim().slice(-4_000);
      const detail = formalErrors.join('; ') || fallback || `skills@${EXPECTED_SKILLS_VERSION} exited with status ${result.status}`;
      throw new Error(redactSecrets(detail));
    }
    const failed = jsonResults.filter((item) => item?.status !== 'installed');
    if (failed.length) {
      throw new Error(redactSecrets(failed.map((item) => `${item?.name ?? 'skill'}: ${item?.error || item?.reason || item?.status}`).join('; ')));
    }
    const installedRoot = path.join(stageRoot, '.agents', 'skills');
    if (!existsSync(installedRoot) || !lstatSync(installedRoot).isDirectory()) {
      throw new Error(`skills@${EXPECTED_SKILLS_VERSION} did not create a staged .agents/skills directory`);
    }
    const upstreamLock = readOptionalJson(path.join(stageRoot, 'skills-lock.json'), 'staged skills-lock.json') ?? { skills: {} };
    const prepared = [];
    const names = new Set();
    let stagedBytes = 0;
    const repositories = new Map();
    for (const entry of readdirSync(installedRoot, { withFileTypes: true }).sort((left, right) => comparePortableText(left.name, right.name))) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`skills@${EXPECTED_SKILLS_VERSION} created an unsafe staged entry: ${entry.name}`);
      }
      validatePortableSegment(entry.name, entry.name);
      const skillRoot = path.join(installedRoot, entry.name);
      const inspected = inspectSkillDirectory(skillRoot);
      stagedBytes += inspected.totalBytes;
      if (prepared.length + 1 > MAX_SOURCE_SKILLS || stagedBytes > MAX_STAGED_TOTAL_BYTES) {
        throw new Error(`source exceeds staging limits (${MAX_SOURCE_SKILLS} skills or ${MAX_STAGED_TOTAL_BYTES} bytes)`);
      }
      if (sourceInfo.type === 'local') {
        const localSkillRoot = findLocalSkillRoot(sourceInfo.invocation, inspected.name);
        const localInspected = inspectSkillDirectory(localSkillRoot);
        if (localInspected.contentSha256 !== inspected.contentSha256) {
          throw new Error(`staged local skill bytes differ from the validated source: ${inspected.name}`);
        }
      }
      if (names.has(inspected.name)) throw new Error(`source produced duplicate skill name: ${inspected.name}`);
      names.add(inspected.name);
      const upstreamResult = jsonResults.find((item) => item?.name === inspected.name)
        ?? jsonResults.find((item) => path.basename(item?.path || '') === entry.name)
        ?? null;
      const upstreamEntry = findUpstreamLockEntry(upstreamLock, inspected.name);
      const sourceType = sourceTypeFrom(sourceInfo, upstreamEntry);
      const sourceSpec = canonicalSourceSpec(upstreamEntry, sourceInfo);
      const ref = upstreamEntry?.ref ?? upstreamResult?.ref ?? null;
      const resolvedCommit = resolveGitCommit(sourceType, sourceSpec, ref);
      const sourceRecord = { type: sourceType, spec: sourceSpec, ref, resolvedCommit };
      if (resolvedCommit) {
        sourceRecord.skillPath = verifyRemoteSkill(stageRoot, sourceRecord, upstreamEntry?.skillPath, inspected, skillRoot, repositories);
      }
      prepared.push({
        ...inspected,
        skillRoot,
        source: sourceRecord,
        upstreamHash: typeof upstreamResult?.hash === 'string'
          ? upstreamResult.hash
          : typeof upstreamEntry?.computedHash === 'string'
            ? upstreamEntry.computedHash
            : null,
      });
    }
    if (!prepared.length) throw new Error('source did not produce any validated skills');
    if (!skillNames.includes('*')) {
      const missing = skillNames.filter((name) => !names.has(name));
      if (missing.length) throw new Error(`source did not contain requested skill(s): ${missing.join(', ')}`);
    }

    return {
      stageRoot,
      skills: prepared,
      cleanup() {
        cleanupStage();
      },
    };
  } catch (error) {
    cleanupStage();
    throw error;
  }
}

function normalizeTools(tools, manifest) {
  const requested = Array.isArray(tools) && tools.length
    ? tools
    : Array.isArray(manifest?.aiToolTargets)
      ? manifest.aiToolTargets.filter((tool) => EXTERNAL_SKILL_TOOLS.includes(tool))
      : [];
  const normalized = [...new Set(requested.map((tool) => String(tool).trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) normalized.push('codex');
  const invalid = normalized.filter((tool) => !EXTERNAL_SKILL_TOOLS.includes(tool));
  if (invalid.length) throw new Error(`unsupported external skill tool target(s): ${invalid.join(', ')}`);
  return normalized.sort((left, right) => EXTERNAL_SKILL_TOOLS.indexOf(left) - EXTERNAL_SKILL_TOOLS.indexOf(right));
}

export function installedPathsForSkill(name, tools) {
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`invalid external skill name: ${name}`);
  const installed = new Set();
  for (const tool of tools) {
    if (tool === 'claude') installed.add(normalizePath(path.join('.claude', 'skills', name)));
    else if (tool === 'codex' || tool === 'gemini') installed.add(normalizePath(path.join('.agents', 'skills', name)));
    else throw new Error(`unsupported external skill tool target: ${tool}`);
  }
  return [...installed].sort();
}

function recordFromPrepared(prepared, tools) {
  const normalizedTools = normalizeTools(tools, null);
  const targets = [
    ...(normalizedTools.some((tool) => tool === 'codex' || tool === 'gemini') ? ['agents-shared'] : []),
    ...(normalizedTools.includes('claude') ? ['claude'] : []),
  ];
  return {
    name: prepared.name,
    description: prepared.description,
    source: prepared.source,
    upstreamHash: prepared.upstreamHash,
    contentSha256: prepared.contentSha256,
    tools: normalizedTools,
    targets,
    installedPaths: installedPathsForSkill(prepared.name, normalizedTools),
    files: prepared.files,
  };
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertSkillOwnershipAvailable(project, record, { existingName = null } = {}) {
  const expectedOwner = existingName ? `external-skill:${existingName}` : null;
  for (const destination of record.installedPaths) {
    validateRelativePath(destination);
    for (const managed of Array.isArray(project.manifest.managedFiles) ? project.manifest.managedFiles : []) {
      if (typeof managed?.path !== 'string' || !pathsOverlap(normalizePath(managed.path).toLowerCase(), destination.toLowerCase())) continue;
      if (managed.owner !== expectedOwner) {
        throw new Error(`external skill destination collides with ${managed.owner || 'an unknown owner'}: ${destination}`);
      }
    }
    const absolute = path.join(project.paths.targetRoot, ...destination.split('/'));
    assertNoSymlinkComponents(project.paths.targetRoot, absolute, { allowMissing: true });
    const parent = path.dirname(absolute);
    if (existsSync(parent) && lstatSync(parent).isDirectory()) {
      const caseCollision = readdirSync(parent).find((entry) => (
        entry.toLowerCase() === path.basename(absolute).toLowerCase()
        && entry !== path.basename(absolute)
      ));
      if (caseCollision) {
        throw new Error(`external skill destination has a case-insensitive collision: ${normalizePath(path.join(path.dirname(destination), caseCollision))}`);
      }
    }
    if (existsSync(absolute) && existingName) {
      const owned = new Map((project.manifest.managedFiles ?? []).map((item) => [item.path, item]));
      for (const file of record.files) {
        const expected = owned.get(`${destination}/${file.path}`);
        if (expected?.owner !== expectedOwner || expected.sha256 !== file.sha256) {
          throw new Error(`manual_review: external skill ownership is missing or changed: ${destination}/${file.path}`);
        }
      }
    }
    if (existsSync(absolute) && !existingName) {
      throw new Error(`external skill destination already exists and is not P2A-owned: ${destination}`);
    }
  }
}

function inspectInstalledRecord(targetRoot, record) {
  const issues = [];
  for (const installedPath of record.installedPaths) {
    let relative;
    try {
      relative = validateRelativePath(installedPath);
      const absolute = path.join(targetRoot, ...relative.split('/'));
      assertNoSymlinkComponents(targetRoot, absolute, { allowMissing: true });
      if (!existsSync(absolute)) {
        issues.push({ path: relative, kind: 'missing', detail: 'installed skill directory is missing' });
        continue;
      }
      const inspected = inspectSkillDirectory(absolute);
      if (inspected.name !== record.name) {
        issues.push({ path: relative, kind: 'name_mismatch', detail: 'installed SKILL.md name differs from the lock', expected: record.name, actual: inspected.name });
      }
      if (inspected.contentSha256 !== record.contentSha256) {
        issues.push({
          path: relative,
          kind: 'hash_mismatch',
          detail: 'installed skill content differs from the lock',
          expectedSha256: record.contentSha256,
          actualSha256: inspected.contentSha256,
        });
      }
      const expectedFiles = new Map(record.files.map((file) => [file.path, file]));
      const actualFiles = new Map(inspected.files.map((file) => [file.path, file]));
      for (const [filePath, expected] of expectedFiles) {
        const actual = actualFiles.get(filePath);
        const installedFilePath = normalizePath(path.posix.join(relative, filePath));
        if (!actual) {
          issues.push({ path: installedFilePath, kind: 'missing_file', detail: 'locked external skill file is missing' });
        } else if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
          issues.push({
            path: installedFilePath,
            kind: 'file_hash_mismatch',
            detail: 'external skill file differs from the lock',
            expectedSha256: expected.sha256,
            actualSha256: actual.sha256,
          });
        }
      }
      for (const filePath of actualFiles.keys()) {
        if (!expectedFiles.has(filePath)) {
          issues.push({
            path: normalizePath(path.posix.join(relative, filePath)),
            kind: 'extra_file',
            detail: 'installed external skill contains a file absent from the lock',
          });
        }
      }
    } catch (error) {
      issues.push({
        path: typeof relative === 'string' ? relative : String(installedPath),
        kind: /symbolic link/.test(error.message) ? 'symbolic_link' : 'invalid_installation',
        detail: error.message,
      });
    }
  }
  return issues;
}

function externalManagedRecords(lock) {
  const records = [];
  for (const skill of Object.values(lock.skills).sort((left, right) => comparePortableText(left.name, right.name))) {
    for (const installedPath of skill.installedPaths) {
      for (const file of skill.files) {
        records.push({
          path: normalizePath(path.posix.join(installedPath, file.path)),
          owner: `external-skill:${skill.name}`,
          sha256: file.sha256,
        });
      }
    }
  }
  return records.sort((left, right) => comparePortableText(left.path, right.path));
}

function manifestWithExternalSkills(manifest, lock) {
  const externalSkills = Object.values(lock.skills)
    .sort((left, right) => comparePortableText(left.name, right.name))
    .map((skill) => ({
      name: skill.name,
      source: skill.source,
      contentSha256: skill.contentSha256,
      tools: skill.tools,
      targets: skill.targets,
      installedPaths: skill.installedPaths,
    }));
  const managedFiles = [
    ...(Array.isArray(manifest.managedFiles)
      ? manifest.managedFiles.filter((record) => !String(record?.owner || '').startsWith('external-skill:'))
      : []),
    ...externalManagedRecords(lock),
  ].sort((left, right) => comparePortableText(String(left.path), String(right.path)));
  return {
    ...manifest,
    externalSkills,
    externalSkillFiles: externalSkills.flatMap((skill) => {
      const record = lock.skills[skill.name];
      return record.installedPaths.flatMap((installedPath) => (
        record.files.map((file) => normalizePath(path.posix.join(installedPath, file.path)))
      ));
    }).sort(),
    managedFiles,
  };
}

function assertExternalManifestReconciled(project, { allowMissingInventory = false } = {}) {
  const expected = manifestWithExternalSkills({}, project.lock);
  const skills = new Map(expected.externalSkills.map((record) => [record.name, record]));
  const files = new Map(expected.managedFiles.map((record) => [record.path, record]));
  const fail = (detail) => {
    throw new Error(`manual_review: external manifest and lock disagree (${detail}); restore the matching lock or reconcile ownership before changing skills`);
  };
  // Missing local inventory is allowed for clean-clone sync. Existing inventory
  // must be represented by the current lock before any operation rebuilds it.
  for (const record of project.manifest.externalSkills ?? []) {
    if (!skills.has(record?.name) || canonicalJson(record) !== canonicalJson(skills.get(record.name))) {
      fail(`skill ${record?.name ?? '(invalid)'}`);
    }
  }
  for (const file of project.manifest.externalSkillFiles ?? []) {
    if (!files.has(normalizePath(file))) fail(`file ${file}`);
  }
  for (const record of project.manifest.managedFiles ?? []) {
    const expectedFile = files.get(normalizePath(record.path));
    if (expectedFile && record.owner !== expectedFile.owner) fail(`owner collides with ${record.owner} at ${record.path}`);
    if (!String(record?.owner || '').startsWith('external-skill:')) continue;
    if (!expectedFile || record.owner !== expectedFile.owner || record.sha256 !== expectedFile.sha256) {
      fail(`owner ${record.owner} at ${record.path}`);
    }
  }
  if (!allowMissingInventory) {
    const manifestNames = new Set((project.manifest.externalSkills ?? []).map((record) => record.name));
    const manifestFiles = new Set(normalizedStringArray(project.manifest.externalSkillFiles));
    const managed = new Map((project.manifest.managedFiles ?? []).map((record) => [normalizePath(record.path), record]));
    if ([...skills.keys()].some((name) => !manifestNames.has(name))
      || [...files.keys()].some((file) => !manifestFiles.has(file) || !managed.has(file))) {
      fail('missing local inventory; preview sync to restore lock-only declarations');
    }
  }
}

function lockWithSkills(skills) {
  return {
    schema_version: EXTERNAL_SKILLS_LOCK_SCHEMA,
    generatedAt: new Date().toISOString(),
    upstream: EXTERNAL_SKILLS_UPSTREAM,
    skills: Object.fromEntries(
      Object.entries(skills).sort(([left], [right]) => comparePortableText(left, right)),
    ),
  };
}

function metadataSnapshot(filePath) {
  if (!existsSync(filePath)) return { exists: false, base64: null };
  const entry = lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`transaction metadata target must be a regular file: ${filePath}`);
  return { exists: true, base64: readFileSync(filePath).toString('base64') };
}

function restoreMetadata(filePath, snapshot) {
  if (snapshot.exists) atomicWriteText(filePath, Buffer.from(snapshot.base64, 'base64').toString('utf8'));
  else if (existsSync(filePath)) unlinkSync(filePath);
}

function cleanupTransactionArtifacts(transaction) {
  let clean = true;
  for (const replacement of transaction.replacements ?? []) {
    for (const candidate of [replacement.backup, replacement.temporary]) {
      if (!candidate) continue;
      try {
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        clean = false;
      }
    }
  }
  return clean;
}

function rollbackTransaction(transaction) {
  for (const replacement of [...(transaction.replacements ?? [])].reverse()) {
    if (existsSync(replacement.backup)) {
      rmSync(replacement.destination, { recursive: true, force: true });
      renameSync(replacement.backup, replacement.destination);
    } else if (transaction.phase !== 'preparing' && !replacement.originalExists) {
      rmSync(replacement.destination, { recursive: true, force: true });
    }
    rmSync(replacement.temporary, { recursive: true, force: true });
  }
  if (transaction.phase !== 'preparing') {
    restoreMetadata(transaction.manifestPath, transaction.manifestBefore);
    restoreMetadata(transaction.lockPath, transaction.lockBefore);
  }
  for (const directory of [...(transaction.createdDirectories ?? [])].reverse()) {
    try { rmdirSync(directory); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

function validateTransactionJournal(transaction, paths) {
  if (path.resolve(transaction.targetRoot || '') !== paths.targetRoot) {
    throw new Error('external skills transaction journal belongs to a different target; manual review is required');
  }
  if (path.resolve(transaction.manifestPath || '') !== paths.manifest
    || path.resolve(transaction.lockPath || '') !== paths.lock) {
    throw new Error('external skills transaction journal has unsafe metadata paths; manual review is required');
  }
  if (!['preparing', 'applying', 'committed'].includes(transaction.phase) || !Array.isArray(transaction.replacements)) {
    throw new Error('external skills transaction journal has an invalid phase or replacement inventory');
  }
  for (const metadata of [paths.manifest, paths.lock, paths.transaction]) {
    assertNoSymlinkComponents(paths.targetRoot, metadata, { allowMissing: true });
  }
  for (const directory of transaction.createdDirectories ?? []) {
    const relative = normalizePath(path.relative(paths.targetRoot, directory));
    if (!['.agents', '.agents/skills', '.claude', '.claude/skills'].includes(relative)) {
      throw new Error('external skills transaction has unsafe created directories');
    }
    assertNoSymlinkComponents(paths.targetRoot, directory, { allowMissing: true });
  }
  for (const replacement of transaction.replacements) {
    const installedPath = validateRelativePath(replacement?.installedPath);
    if (!/^\.(?:agents|claude)\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(installedPath)) {
      throw new Error(`external skills transaction has an unsafe provider path: ${installedPath}`);
    }
    const expectedDestination = path.join(paths.targetRoot, ...installedPath.split('/'));
    assertNoSymlinkComponents(paths.targetRoot, expectedDestination, { allowMissing: true });
    if (path.resolve(replacement.destination || '') !== expectedDestination) {
      throw new Error(`external skills transaction destination does not match its inventory: ${installedPath}`);
    }
    for (const [kind, candidate] of [['backup', replacement.backup], ['temporary', replacement.temporary]]) {
      if (path.dirname(path.resolve(candidate || '')) !== path.dirname(expectedDestination)) {
        throw new Error(`external skills transaction ${kind} path escapes the destination directory`);
      }
      assertNoSymlinkComponents(paths.targetRoot, candidate, { allowMissing: true });
      const expectedPrefix = `.${path.basename(expectedDestination)}.p2a-${kind === 'backup' ? 'backup' : 'next'}-`;
      if (!path.basename(candidate || '').startsWith(expectedPrefix)) {
        throw new Error(`external skills transaction ${kind} path is invalid`);
      }
    }
  }
  for (const snapshot of [transaction.manifestBefore, transaction.lockBefore]) {
    if (!snapshot || typeof snapshot.exists !== 'boolean'
      || (snapshot.exists && typeof snapshot.base64 !== 'string')) {
      throw new Error('external skills transaction metadata snapshot is invalid');
    }
  }
}

function recoverTransactionUnlocked(paths) {
  if (!existsSync(paths.transaction)) return null;
  const transaction = readJson(paths.transaction, 'external skills transaction journal');
  validateTransactionJournal(transaction, paths);
  if (transaction.phase === 'committed') {
    const clean = cleanupTransactionArtifacts(transaction);
    if (clean) unlinkSync(paths.transaction);
    return { action: 'completed_cleanup', clean };
  }
  rollbackTransaction(transaction);
  cleanupTransactionArtifacts(transaction);
  unlinkSync(paths.transaction);
  return { action: 'rolled_back', clean: true };
}

function assertNoPendingTransaction(targetRoot) {
  const paths = externalSkillsPaths(targetRoot);
  assertNoSymlinkComponents(paths.targetRoot, paths.transaction, { allowMissing: true });
  if (existsSync(paths.transaction)) {
    throw new Error('incomplete external skills transaction; review p2a skills recover --dry-run before recovery');
  }
}

function recoveryFilesystemState(paths, transaction) {
  if (!transaction) return [];
  const roots = new Set([paths.manifest, paths.lock]);
  for (const replacement of transaction.replacements) {
    for (const file of [replacement.destination, replacement.backup, replacement.temporary]) roots.add(file);
  }
  const inventory = [];
  for (const root of [...roots].sort()) {
    let count = 0;
    let totalBytes = 0;
    const visit = (file) => {
      const relative = normalizePath(path.relative(paths.targetRoot, file));
      let entry;
      try { entry = lstatSync(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        inventory.push({ path: relative, kind: 'missing' });
        return;
      }
      count += 1;
      if (count > MAX_SKILL_FILES * 2 || relative.split('/').length > 128) {
        throw new Error('manual_review: recovery inventory exceeds the safe traversal limit');
      }
      if (entry.isDirectory()) {
        inventory.push({ path: relative, kind: 'directory', mode: entry.mode & 0o777 });
        for (const name of readdirSync(file).sort()) visit(path.join(file, name));
      } else if (entry.isFile()) {
        totalBytes += entry.size;
        if (entry.size > MAX_SKILL_FILE_BYTES || totalBytes > MAX_SKILL_TOTAL_BYTES) {
          throw new Error(`manual_review: recovery file limit exceeded at ${relative}`);
        }
        inventory.push({ path: relative, kind: 'file', mode: entry.mode & 0o777, sha256: sha256(readFileSync(file)) });
      } else {
        throw new Error(`manual_review: recovery contains a symbolic link or non-regular entry at ${relative}`);
      }
    };
    assertNoSymlinkComponents(paths.targetRoot, root, { allowMissing: true });
    visit(root);
  }
  return inventory;
}

export function recoverExternalSkillsTransaction(targetRoot, options = {}) {
  const paths = externalSkillsPaths(targetRoot);
  assertNoSymlinkComponents(paths.targetRoot, paths.transaction, { allowMissing: true });
  const transaction = readOptionalJson(paths.transaction, 'external skills transaction journal');
  if (transaction) validateTransactionJournal(transaction, paths);
  const plan = finalizePlan({
    schema_version: 'p2a.external-skills-plan.v1',
    operation: 'recover',
    target: displayPath(paths.targetRoot),
    transactionSha256: transaction ? sha256(canonicalJson(transaction)) : null,
    recoveryState: recoveryFilesystemState(paths, transaction),
    changes: [], blockers: [], applied: false,
  });
  assertExpectedPlan(plan, options);
  if (!options.apply || !transaction) return plan;
  const recovery = withRunStoreLocks([paths.p2aDir], () => {
    if (sha256(canonicalJson(readJson(paths.transaction))) !== plan.transactionSha256) {
      throw new Error('transaction changed after review; rerun recovery dry-run');
    }
    if (canonicalJson(recoveryFilesystemState(paths, transaction)) !== canonicalJson(plan.recoveryState)) {
      throw new Error('recovery files changed after review; rerun recovery dry-run');
    }
    return recoverTransactionUnlocked(paths);
  });
  return { ...plan, applied: true, recovery };
}

function applyExternalSkillsTransaction(project, nextLock, replacements) {
  const transactionId = randomUUID();
  const nextManifest = manifestWithExternalSkills(project.manifest, nextLock);
  const createdDirectories = new Set();
  const preparedReplacements = replacements.map((replacement) => {
    const destination = path.join(project.paths.targetRoot, ...replacement.installedPath.split('/'));
    const parent = path.dirname(destination);
    assertNoSymlinkComponents(project.paths.targetRoot, destination, { allowMissing: true });
    const missing = [];
    for (let directory = parent; !existsSync(directory); directory = path.dirname(directory)) {
      missing.unshift(directory);
    }
    for (const directory of missing) createdDirectories.add(directory);
    const suffix = `${process.pid}-${transactionId}`;
    return {
      installedPath: replacement.installedPath,
      destination,
      temporary: path.join(parent, `.${path.basename(destination)}.p2a-next-${suffix}`),
      backup: path.join(parent, `.${path.basename(destination)}.p2a-backup-${suffix}`),
      originalExists: existsSync(destination),
      remove: !replacement.skillRoot,
    };
  });
  const transaction = {
    schema_version: 'p2a.external-skills-transaction.v1',
    id: transactionId,
    phase: 'preparing',
    targetRoot: project.paths.targetRoot,
    manifestPath: project.paths.manifest,
    lockPath: project.paths.lock,
    manifestBefore: metadataSnapshot(project.paths.manifest),
    lockBefore: metadataSnapshot(project.paths.lock),
    replacements: preparedReplacements,
    createdDirectories: [...createdDirectories],
  };
  // Persist recovery information before the first provider directory or copy is created.
  atomicWriteJson(project.paths.transaction, transaction);
  try {
    for (const [index, replacement] of preparedReplacements.entries()) {
      mkdirSync(path.dirname(replacement.destination), { recursive: true });
      assertNoSymlinkComponents(project.paths.targetRoot, path.dirname(replacement.destination));
      if (replacement.remove) continue;
      cpSync(replacements[index].skillRoot, replacement.temporary, {
        recursive: true, force: false, errorOnExist: true, dereference: false,
      });
      if (inspectSkillDirectory(replacement.temporary).contentSha256 !== replacements[index].contentSha256) {
        throw new Error(`transaction copy digest mismatch for ${replacement.installedPath}`);
      }
    }
    transaction.phase = 'applying';
    atomicWriteJson(project.paths.transaction, transaction);
    for (const replacement of preparedReplacements) {
      if (replacement.originalExists) renameSync(replacement.destination, replacement.backup);
      if (!replacement.remove) renameSync(replacement.temporary, replacement.destination);
    }
    atomicWriteJson(project.paths.lock, nextLock);
    atomicWriteJson(project.paths.manifest, nextManifest);
    transaction.phase = 'committed';
    atomicWriteJson(project.paths.transaction, transaction);
  } catch (error) {
    try {
      rollbackTransaction(transaction);
      cleanupTransactionArtifacts(transaction);
      if (existsSync(project.paths.transaction)) unlinkSync(project.paths.transaction);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'external skills apply failed and rollback requires manual review');
    }
    throw error;
  }
  if (cleanupTransactionArtifacts(transaction)) unlinkSync(project.paths.transaction);
  return { lock: nextLock, manifest: nextManifest };
}

function stablePlanDigest(plan) {
  const stable = {
    schema_version: plan.schema_version,
    operation: plan.operation,
    transactionSha256: plan.transactionSha256 ?? null,
    recoveryState: plan.recoveryState ?? null,
    changes: plan.changes,
    blockers: plan.blockers,
  };
  return sha256(JSON.stringify(stable));
}

function displayPath(value) {
  const resolved = path.resolve(value);
  if (process.env.HOME && isPathInside(process.env.HOME, resolved)) {
    const relative = normalizePath(path.relative(process.env.HOME, resolved));
    return relative ? `~/${relative}` : '~';
  }
  return normalizePath(resolved);
}

function finalizePlan(plan) {
  return { ...plan, planDigest: stablePlanDigest(plan) };
}

function skillChange(current, next, action) {
  const currentFiles = new Map((current?.files ?? []).map((file) => [file.path, file.sha256]));
  const nextFiles = new Map((next?.files ?? []).map((file) => [file.path, file.sha256]));
  return {
    name: next?.name ?? current?.name,
    action,
    fromSha256: current?.contentSha256 ?? null,
    toSha256: next?.contentSha256 ?? null,
    source: next?.source ?? current?.source ?? null,
    tools: next?.tools ?? current?.tools ?? [],
    targets: next?.targets ?? current?.targets ?? [],
    installedPaths: next?.installedPaths ?? current?.installedPaths ?? [],
    frontmatterChanged: Boolean(current && next && current.description !== next.description),
    files: {
      added: [...nextFiles.keys()].filter((file) => !currentFiles.has(file)).sort(),
      removed: [...currentFiles.keys()].filter((file) => !nextFiles.has(file)).sort(),
      modified: [...nextFiles.keys()].filter((file) => (
        currentFiles.has(file) && currentFiles.get(file) !== nextFiles.get(file)
      )).sort(),
    },
  };
}

function assertExpectedPlan(plan, options) {
  if (!options.apply) return;
  if (!options.expectedPlan || options.expectedPlan !== plan.planDigest) {
    const message = options.expectedPlan
      ? `source/content changed after review: expected plan ${options.expectedPlan}, current plan ${plan.planDigest}`
      : '--apply requires --expect-plan <dry-run-plan-sha256>';
    throw Object.assign(new Error(`${message}; review a new --dry-run`), { plan });
  }
}

function sourceForUpdate(record) {
  if (record.source.type === 'local' || !record.source.ref) return record.source.spec;
  return `${record.source.spec.split('#')[0]}#${record.source.ref}`;
}

function assertLockedRecordsUnchanged(before, after, names) {
  for (const name of names) {
    if (JSON.stringify(before.skills[name] ?? null) !== JSON.stringify(after.skills[name] ?? null)) {
      throw new Error(`external skill lock changed while preparing ${name}; rerun the command`);
    }
  }
}

function applyPreparedRecords(project, nextRecords, preparedByName, namesToRemove = [], options = {}) {
  assertExternalManifestReconciled(project, options);
  const nextSkills = { ...project.lock.skills };
  for (const name of namesToRemove) delete nextSkills[name];
  for (const [name, record] of nextRecords) nextSkills[name] = record;
  const skillsChanged = JSON.stringify(project.lock.skills) !== JSON.stringify(nextSkills);
  const nextLock = skillsChanged ? lockWithSkills(nextSkills) : project.lock;
  const replacements = [];
  for (const name of namesToRemove) {
    const current = project.lock.skills[name];
    for (const installedPath of current.installedPaths) {
      replacements.push({ installedPath, skillRoot: null, contentSha256: null });
    }
  }
  for (const [name, record] of nextRecords) {
    const prepared = preparedByName.get(name);
    const current = project.lock.skills[name];
    const currentPaths = new Set(current?.installedPaths ?? []);
    const nextPaths = new Set(record.installedPaths);
    for (const installedPath of currentPaths) {
      if (!nextPaths.has(installedPath)) replacements.push({ installedPath, skillRoot: null, contentSha256: null });
    }
    for (const installedPath of nextPaths) {
      const requiresWrite = !current
        || current.contentSha256 !== record.contentSha256
        || !currentPaths.has(installedPath)
        || inspectInstalledRecord(project.paths.targetRoot, {
          ...record,
          installedPaths: [installedPath],
        }).length > 0;
      if (requiresWrite) {
        replacements.push({
          installedPath,
          skillRoot: prepared.skillRoot,
          contentSha256: prepared.contentSha256,
        });
      }
    }
  }
  const nextManifest = manifestWithExternalSkills(project.manifest, nextLock);
  if (!skillsChanged && replacements.length === 0
    && JSON.stringify(nextManifest) === JSON.stringify(project.manifest)) {
    return { lock: project.lock, manifest: project.manifest };
  }
  return applyExternalSkillsTransaction(project, nextLock, replacements);
}

export function listExternalSkills(targetRoot) {
  const project = readExternalSkillsProject(targetRoot);
  const integrity = inspectExternalSkillsState(project.paths.targetRoot, project.manifest);
  return {
    schema_version: 'p2a.external-skills-list.v1',
    target: displayPath(project.paths.targetRoot),
    upstream: project.lock.upstream,
    status: integrity.status === 'pass' ? 'ok' : 'drifted',
    issues: integrity.issues.filter((issue) => !issue.name),
    skills: Object.values(project.lock.skills)
      .sort((left, right) => comparePortableText(left.name, right.name))
      .map((record) => {
        const issues = inspectInstalledRecord(project.paths.targetRoot, record);
        return {
          name: record.name,
          description: record.description,
          source: record.source,
          contentSha256: record.contentSha256,
          tools: record.tools,
          installedPaths: record.installedPaths,
          status: issues.length ? 'drifted' : 'installed',
          issues,
        };
      }),
  };
}

export function listExternalSkillSource(targetRoot, source) {
  assertNoPendingTransaction(targetRoot);
  const staged = prepareExternalSkills(targetRoot, source, ['*'], { verifyPin: false });
  try {
    return {
      schema_version: 'p2a.external-skills-source.v1',
      source: staged.skills[0]?.source.spec ?? sanitizeUrlCredentials(source),
      upstream: EXTERNAL_SKILLS_UPSTREAM,
      skills: staged.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        contentSha256: skill.contentSha256,
        source: skill.source,
        files: skill.files.length,
        bytes: skill.totalBytes,
      })),
    };
  } finally {
    staged.cleanup();
  }
}

export function addExternalSkill(targetRoot, source, name, options = {}) {
  assertNoPendingTransaction(targetRoot);
  const initial = readExternalSkillsProject(targetRoot);
  assertExternalManifestReconciled(initial);
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`--skill must be lowercase kebab-case: ${name}`);
  if (initial.lock.skills[name]) throw new Error(`external skill ${name} is already installed; use p2a skills update ${name}`);
  const tools = normalizeTools(options.tools, initial.manifest);
  const staged = prepareExternalSkills(targetRoot, source, [name]);
  try {
    const prepared = staged.skills.find((skill) => skill.name === name);
    if (!prepared) throw new Error(`source did not produce requested skill: ${name}`);
    const record = recordFromPrepared(prepared, tools);
    assertSkillOwnershipAvailable(initial, record);
    const plan = finalizePlan({
      schema_version: 'p2a.external-skills-plan.v1',
      operation: 'add',
      target: displayPath(initial.paths.targetRoot),
      changes: [skillChange(null, record, 'add')],
      blockers: [],
      applied: false,
    });
    assertExpectedPlan(plan, options);
    if (!options.apply) return plan;
    const applied = withRunStoreLocks([initial.paths.p2aDir], () => {
      assertNoPendingTransaction(targetRoot);
      const current = readExternalSkillsProject(targetRoot);
      if (current.lock.skills[name]) throw new Error(`external skill ${name} was installed concurrently; rerun the command`);
      assertSkillOwnershipAvailable(current, record);
      return applyPreparedRecords(current, new Map([[name, record]]), new Map([[name, prepared]]));
    });
    return { ...plan, applied: true, lock: applied.lock };
  } finally {
    staged.cleanup();
  }
}

function prepareUpdates(targetRoot, records, { pinned = false } = {}) {
  const temporaryRoot = externalSkillsPaths(targetRoot).temporaryRoot;
  const temporaryRootExisted = existsSync(temporaryRoot);
  const groups = new Map();
  for (const record of records) {
    const source = pinned ? sourceWithCommit(record.source) : sourceForUpdate(record);
    const key = `${source}\0${record.source.type}`;
    const group = groups.get(key) ?? { source, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const stages = [];
  const preparedByName = new Map();
  try {
    for (const group of groups.values()) {
      const stage = prepareExternalSkills(
        targetRoot,
        group.source,
        group.records.map((record) => record.name),
        { sourceType: group.records[0].source.type, verifyPin: !pinned },
      );
      stages.push(stage);
      for (const record of group.records) {
        const prepared = stage.skills.find((skill) => skill.name === record.name);
        if (!prepared) throw new Error(`source did not produce locked skill: ${record.name}`);
        preparedByName.set(record.name, prepared);
      }
    }
    return {
      preparedByName,
      cleanup() {
        for (const stage of stages) stage.cleanup();
        if (!temporaryRootExisted) {
          try {
            if (existsSync(temporaryRoot) && readdirSync(temporaryRoot).length === 0) rmdirSync(temporaryRoot);
          } catch {
            // Another process or transaction may be using the shared temporary root.
          }
        }
      },
    };
  } catch (error) {
    for (const stage of stages) stage.cleanup();
    if (!temporaryRootExisted) {
      try {
        if (existsSync(temporaryRoot) && readdirSync(temporaryRoot).length === 0) rmdirSync(temporaryRoot);
      } catch {
        // Preserve the primary preparation error.
      }
    }
    throw error;
  }
}

export function updateExternalSkills(targetRoot, requestedNames = [], options = {}) {
  assertNoPendingTransaction(targetRoot);
  const initial = readExternalSkillsProject(targetRoot);
  assertExternalManifestReconciled(initial);
  const names = requestedNames.length
    ? [...new Set(requestedNames)]
    : Object.keys(initial.lock.skills).sort();
  if (!names.length) throw new Error('no external skills are installed');
  const missing = names.filter((name) => !initial.lock.skills[name]);
  if (missing.length) throw new Error(`external skill(s) are not installed: ${missing.join(', ')}`);
  const records = names.map((name) => initial.lock.skills[name]);
  const blockers = records.flatMap((record) => inspectInstalledRecord(initial.paths.targetRoot, record)
    .map((issue) => ({ name: record.name, ...issue })));
  const staged = prepareUpdates(targetRoot, records);
  try {
    const nextRecords = new Map();
    const changes = [];
    for (const current of records) {
      const prepared = staged.preparedByName.get(current.name);
      const next = recordFromPrepared(prepared, current.tools);
      assertSkillOwnershipAvailable(initial, current, { existingName: current.name });
      nextRecords.set(current.name, next);
      changes.push(skillChange(
        current,
        next,
        JSON.stringify(current) === JSON.stringify(next) ? 'unchanged' : 'update',
      ));
    }
    const plan = finalizePlan({
      schema_version: 'p2a.external-skills-plan.v1',
      operation: 'update',
      target: displayPath(initial.paths.targetRoot),
      changes,
      blockers,
      applied: false,
    });
    assertExpectedPlan(plan, options);
    if (!options.apply) return plan;
    if (blockers.length) throw new Error('installed external skill drift blocks update; manual_review: preserve your edits and resolve the drift before retrying');
    const applied = withRunStoreLocks([initial.paths.p2aDir], () => {
      assertNoPendingTransaction(targetRoot);
      const current = readExternalSkillsProject(targetRoot);
      assertLockedRecordsUnchanged(initial.lock, current.lock, names);
      for (const name of names) {
        assertSkillOwnershipAvailable(current, current.lock.skills[name], { existingName: name });
        const drift = inspectInstalledRecord(current.paths.targetRoot, current.lock.skills[name]);
        if (drift.length) throw new Error(`external skill ${name} changed while preparing the update; rerun after repair`);
      }
      return applyPreparedRecords(current, nextRecords, staged.preparedByName);
    });
    return { ...plan, applied: true, lock: applied.lock };
  } finally {
    staged.cleanup();
  }
}

export function removeExternalSkill(targetRoot, name, options = {}) {
  assertNoPendingTransaction(targetRoot);
  const initial = readExternalSkillsProject(targetRoot);
  assertExternalManifestReconciled(initial);
  const record = initial.lock.skills[name];
  if (!record) throw new Error(`external skill is not installed: ${name}`);
  assertSkillOwnershipAvailable(initial, record, { existingName: name });
  const blockers = inspectInstalledRecord(initial.paths.targetRoot, record).map((issue) => ({ name, ...issue }));
  const plan = finalizePlan({
    schema_version: 'p2a.external-skills-plan.v1',
    operation: 'remove',
    target: displayPath(initial.paths.targetRoot),
    changes: [skillChange(record, null, 'remove')],
    blockers,
    applied: false,
  });
  assertExpectedPlan(plan, options);
  if (!options.apply) return plan;
  if (blockers.length) throw new Error('installed external skill drift blocks removal; manual_review: preserve your edits and resolve the drift before retrying');
  const applied = withRunStoreLocks([initial.paths.p2aDir], () => {
    assertNoPendingTransaction(targetRoot);
    const current = readExternalSkillsProject(targetRoot);
    assertLockedRecordsUnchanged(initial.lock, current.lock, [name]);
    assertSkillOwnershipAvailable(current, current.lock.skills[name], { existingName: name });
    const drift = inspectInstalledRecord(current.paths.targetRoot, current.lock.skills[name]);
    if (drift.length) throw new Error(`external skill ${name} changed while preparing removal; rerun after repair`);
    return applyPreparedRecords(current, new Map(), new Map(), [name]);
  });
  return { ...plan, applied: true, lock: applied.lock };
}

export function syncExternalSkills(targetRoot, options = {}) {
  assertNoPendingTransaction(targetRoot);
  const initial = readExternalSkillsProject(targetRoot);
  assertExternalManifestReconciled(initial, { allowMissingInventory: true });
  const records = Object.values(initial.lock.skills).sort((left, right) => comparePortableText(left.name, right.name));
  if (!records.length) throw new Error('no external skills are installed');
  const staged = prepareUpdates(targetRoot, records, { pinned: true });
  try {
    const blockers = [];
    const preparedByName = staged.preparedByName;
    const nextRecords = new Map();
    const changes = [];
    const reviewedIssues = new Map();
    for (const current of records) {
      const prepared = preparedByName.get(current.name);
      if (prepared.contentSha256 !== current.contentSha256) {
        blockers.push({
          name: current.name,
          kind: 'locked_source_mismatch',
          expectedSha256: current.contentSha256,
          actualSha256: prepared.contentSha256,
          detail: 'the pinned source no longer reproduces the locked content',
        });
      }
      assertSkillOwnershipAvailable(initial, current, { existingName: current.name });
      const drift = inspectInstalledRecord(initial.paths.targetRoot, current);
      reviewedIssues.set(current.name, drift);
      blockers.push(...drift.filter((issue) => issue.kind !== 'missing').map((issue) => ({ name: current.name, ...issue })));
      changes.push({
        ...skillChange(current, current, drift.length ? 'restore' : 'unchanged'),
        installationIssues: drift,
      });
      nextRecords.set(current.name, current);
    }
    const plan = finalizePlan({
      schema_version: 'p2a.external-skills-plan.v1',
      operation: 'sync',
      target: displayPath(initial.paths.targetRoot),
      changes,
      blockers,
      applied: false,
    });
    assertExpectedPlan(plan, options);
    if (!options.apply) return plan;
    if (blockers.length) throw new Error('manual_review: sync cannot overwrite modified, extra, or unverified files; preserve edits and resolve blockers first');
    const applied = withRunStoreLocks([initial.paths.p2aDir], () => {
      assertNoPendingTransaction(targetRoot);
      const current = readExternalSkillsProject(targetRoot);
      assertLockedRecordsUnchanged(initial.lock, current.lock, records.map((record) => record.name));
      for (const record of records) {
        assertSkillOwnershipAvailable(current, record, { existingName: record.name });
        const before = reviewedIssues.get(record.name);
        const after = inspectInstalledRecord(current.paths.targetRoot, record);
        if (canonicalJson(before) !== canonicalJson(after) || after.some((issue) => issue.kind !== 'missing')) {
          throw new Error(`external skill ${record.name} changed while preparing sync; manual_review required`);
        }
      }
      return applyPreparedRecords(current, nextRecords, preparedByName, [], { allowMissingInventory: true });
    });
    return { ...plan, applied: true, lock: applied.lock };
  } finally {
    staged.cleanup();
  }
}

function normalizedStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string')
    .map(normalizePath))].sort();
}

export function inspectExternalSkillsState(targetRoot, manifestInput = null) {
  const paths = externalSkillsPaths(targetRoot);
  const issues = [];
  if (existsSync(paths.transaction)) {
    issues.push({
      kind: 'incomplete_transaction',
      path: normalizePath(path.relative(paths.targetRoot, paths.transaction)),
      detail: 'an external skills transaction journal requires recovery',
    });
  }
  const manifest = manifestInput ?? readOptionalJson(paths.manifest, '.plan2agent/manifest.json') ?? {};
  const managedFiles = Array.isArray(manifest.managedFiles) ? manifest.managedFiles : [];
  const hasExternalOwner = managedFiles.some((record) => String(record?.owner || '').startsWith('external-skill:'));
  const hasManifestInventory = Array.isArray(manifest.externalSkills) && manifest.externalSkills.length > 0;
  if (!existsSync(paths.lock)) {
    if (hasManifestInventory || normalizedStringArray(manifest.externalSkillFiles).length || hasExternalOwner) {
      issues.push({ kind: 'missing_lock', path: EXTERNAL_SKILLS_LOCK_FILE, detail: 'manifest has external skills but the team lock is missing' });
    }
    return { status: issues.length ? 'fail' : 'pass', total: 0, checked: 0, issues };
  }
  let lock;
  try {
    lock = validateExternalSkillsLock(readJson(paths.lock, EXTERNAL_SKILLS_LOCK_FILE));
  } catch (error) {
    issues.push({ kind: 'invalid_lock', path: EXTERNAL_SKILLS_LOCK_FILE, detail: error.message });
    return { status: 'fail', total: 0, checked: 0, issues };
  }
  if (lock.upstream.version !== EXTERNAL_SKILLS_UPSTREAM.version) {
    issues.push({
      kind: 'upstream_version_mismatch',
      path: EXTERNAL_SKILLS_LOCK_FILE,
      expected: EXTERNAL_SKILLS_UPSTREAM.version,
      actual: lock.upstream.version,
      detail: 'lock was produced by a different upstream skills adapter version',
    });
  }
  const lockNames = Object.keys(lock.skills).sort();
  const actualExternalSkills = (Array.isArray(manifest.externalSkills) ? manifest.externalSkills : [])
    .slice()
    .sort((left, right) => comparePortableText(String(left?.name), String(right?.name)));
  const manifestNames = actualExternalSkills
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string')
    .sort();
  if (JSON.stringify(lockNames) !== JSON.stringify(manifestNames)) {
    issues.push({ kind: 'manifest_inventory_mismatch', path: '.plan2agent/manifest.json', detail: 'manifest external skill names differ from the team lock', expected: lockNames, actual: manifestNames });
  }
  const expectedExternalSkills = Object.values(lock.skills)
    .sort((left, right) => comparePortableText(left.name, right.name))
    .map((skill) => ({
      name: skill.name,
      source: skill.source,
      contentSha256: skill.contentSha256,
      tools: skill.tools,
      targets: skill.targets,
      installedPaths: skill.installedPaths,
    }));
  if (canonicalJson(expectedExternalSkills) !== canonicalJson(actualExternalSkills)) {
    issues.push({
      kind: 'manifest_metadata_mismatch',
      path: '.plan2agent/manifest.json',
      detail: 'manifest external skill metadata differs from the team lock',
    });
  }
  const expectedFiles = externalManagedRecords(lock).map((record) => record.path).sort();
  const manifestFiles = normalizedStringArray(manifest.externalSkillFiles);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(manifestFiles)) {
    issues.push({ kind: 'manifest_file_inventory_mismatch', path: '.plan2agent/manifest.json', detail: 'manifest external skill files differ from the team lock', expected: expectedFiles, actual: manifestFiles });
  }
  const managedByPath = new Map();
  for (const record of managedFiles) {
    if (typeof record?.path !== 'string') continue;
    const key = normalizePath(record.path).toLowerCase();
    const records = managedByPath.get(key) ?? [];
    records.push(record);
    managedByPath.set(key, records);
  }
  for (const expected of externalManagedRecords(lock)) {
    const key = expected.path.toLowerCase();
    const records = managedByPath.get(key) ?? [];
    const managed = records[0];
    if (records.length !== 1 || normalizePath(managed.path) !== expected.path
      || managed.owner !== expected.owner || managed.sha256 !== expected.sha256) {
      issues.push({ kind: 'manifest_ownership_mismatch', path: expected.path, detail: 'manifest owner or digest differs from the team lock', expectedOwner: expected.owner });
    }
    managedByPath.delete(key);
  }
  for (const records of managedByPath.values()) {
    for (const record of records) {
      if (!String(record.owner || '').startsWith('external-skill:')) continue;
      issues.push({ kind: 'orphan_manifest_ownership', path: normalizePath(record.path), detail: 'manifest external owner has no matching team lock file', actualOwner: record.owner });
    }
  }
  for (const record of Object.values(lock.skills)) {
    for (const issue of inspectInstalledRecord(paths.targetRoot, record)) issues.push({ name: record.name, ...issue });
  }
  return {
    status: issues.length ? 'fail' : 'pass',
    total: lockNames.length,
    checked: lockNames.length,
    issues,
  };
}
