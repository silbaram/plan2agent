#!/usr/bin/env node
/** Capture a validated entry reference bundle as portable Gate A provenance. */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  REFERENCE_BUNDLE_SNAPSHOT_FILENAME,
  REFERENCE_BUNDLE_SOURCE_DIRNAME,
  REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME,
} from './p2a_constants.mjs';
import { requiredValue } from './p2a_cli_helpers.mjs';
import { findP2aProjectRoot, normalizePath } from './p2a_paths.mjs';
import { inspectEntryDocument } from './p2a_radar_preflight.mjs';
import { validateIntake } from './validate_artifacts.mjs';

function usage() {
  return [
    'Usage:',
    '  p2a reference snapshot --entry <path> --artifacts <dir> [--target <dir>] [--json]',
    '',
    'Captures the validated entry, p2a-reference-bundle.json, and every declared',
    'reference under gate-a-intake/reference-sources/ before Gate A approval.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? null,
    target: null,
    entry: null,
    artifacts: null,
    json: false,
    help: false,
  };
  if (args.command === '--help' || args.command === '-h') {
    args.help = true;
    return args;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') args.target = requiredValue(argv, ++index, '--target');
    else if (arg === '--entry') args.entry = requiredValue(argv, ++index, '--entry');
    else if (arg === '--artifacts' || arg === '--artifact-root') {
      args.artifacts = requiredValue(argv, ++index, arg);
    } else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (args.help) return args;
  if (args.command !== 'snapshot') throw new Error('reference command must be snapshot');
  if (!args.entry) throw new Error('reference snapshot requires --entry');
  if (!args.artifacts) throw new Error('reference snapshot requires --artifacts');
  return args;
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readJsonObject(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function pathAtOrUnder(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function projectRelativeSource(targetRoot, filePath, label) {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedFilePath = path.resolve(filePath);
  if (!isFile(resolvedFilePath)) {
    throw new Error(`${label} is missing or not a regular file: ${resolvedFilePath}`);
  }
  if (
    !pathAtOrUnder(resolvedTargetRoot, resolvedFilePath)
    || resolvedTargetRoot === resolvedFilePath
  ) {
    throw new Error(`${label} must stay inside the target project`);
  }
  const realTargetRoot = realpathSync(resolvedTargetRoot);
  const realFilePath = realpathSync(resolvedFilePath);
  if (!pathAtOrUnder(realTargetRoot, realFilePath) || realTargetRoot === realFilePath) {
    throw new Error(`${label} must stay inside the target project`);
  }
  return {
    sourcePath: realFilePath,
    relativePath: normalizePath(path.relative(resolvedTargetRoot, resolvedFilePath)),
  };
}

function captureReference(relativePath) {
  return path.posix.join(
    REFERENCE_BUNDLE_SOURCE_DIRNAME,
    REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME,
    normalizePath(relativePath),
  );
}

function copyCaptureFiles(records, stageRoot) {
  const copied = new Map();
  for (const record of records) {
    const destination = path.join(
      stageRoot,
      REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME,
      record.relativePath,
    );
    const existingSource = copied.get(destination);
    if (existingSource && existingSource !== record.sourcePath) {
      throw new Error(`reference capture target collision: ${record.relativePath}`);
    }
    if (existingSource) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(record.sourcePath, destination);
    copied.set(destination, record.sourcePath);
  }
}

export function createReferenceBundleSnapshot(options) {
  const targetRoot = path.resolve(options.target ?? findP2aProjectRoot());
  if (!isDirectory(targetRoot)) throw new Error(`target project is missing: ${targetRoot}`);
  const artifactRoot = path.resolve(targetRoot, options.artifacts);
  if (!isDirectory(artifactRoot)) throw new Error(`artifact root is missing: ${artifactRoot}`);
  if (!pathAtOrUnder(realpathSync(targetRoot), realpathSync(artifactRoot))) {
    throw new Error('artifact root must stay inside the target project');
  }

  const intakePath = path.join(artifactRoot, 'gate-a-intake', 'intake.json');
  if (!isFile(intakePath)) throw new Error(`Gate A intake is missing: ${intakePath}`);
  const intake = readJsonObject(intakePath, 'Gate A intake');
  if (intake.status === 'ready_for_spec' || intake.approval_audit) {
    throw new Error('Gate A is already approved; reopen Gate A before replacing reference provenance');
  }

  const inspected = inspectEntryDocument(options.entry, {
    baseDir: targetRoot,
    referenceRoot: targetRoot,
    selection: 'explicit',
  });
  if (!inspected.valid) {
    throw new Error(`entry reference bundle validation failed: ${inspected.errors.join('; ')}`);
  }
  if (!inspected.referenceBundle?.valid) {
    throw new Error('entry has no valid sibling p2a-reference-bundle.json');
  }

  const entry = projectRelativeSource(targetRoot, inspected.path, 'entry document');
  const bundle = projectRelativeSource(
    targetRoot,
    inspected.referenceBundle.path,
    'reference bundle',
  );
  const references = inspected.referenceBundle.references.map((reference) => ({
    ...reference,
    ...projectRelativeSource(
      targetRoot,
      path.resolve(targetRoot, reference.path),
      `reference ${reference.id}`,
    ),
  }));
  const snapshot = {
    schema_version: 'p2a.reference_bundle_snapshot.v1',
    source_bundle_ref: captureReference(bundle.relativePath),
    source_bundle_sha256: inspected.referenceBundle.sha256,
    entry_ref: captureReference(entry.relativePath),
    entry_sha256: sha256(entry.sourcePath),
    references: references.map((reference) => ({
      id: reference.id,
      path: captureReference(reference.relativePath),
      kind: reference.kind,
      sha256: reference.sha256,
      load_when: reference.loadWhen,
      description: reference.description,
    })),
  };

  const gateADirectory = path.dirname(intakePath);
  const sourceDirectory = path.join(gateADirectory, REFERENCE_BUNDLE_SOURCE_DIRNAME);
  const snapshotPath = path.join(gateADirectory, REFERENCE_BUNDLE_SNAPSHOT_FILENAME);
  if (existsSync(sourceDirectory) || existsSync(snapshotPath)) {
    throw new Error(
      'Gate A reference capture already exists; remove only the unapproved capture before regenerating it',
    );
  }
  const snapshotTempPath = `${snapshotPath}.${process.pid}.tmp`;
  let installedSources = false;
  let installedSnapshot = false;
  let snapshotTempCreated = false;
  try {
    mkdirSync(sourceDirectory, { recursive: false });
    installedSources = true;
    copyCaptureFiles([entry, bundle, ...references], sourceDirectory);
    writeFileSync(
      snapshotTempPath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    snapshotTempCreated = true;
    linkSync(snapshotTempPath, snapshotPath);
    installedSnapshot = true;
    rmSync(snapshotTempPath);
    snapshotTempCreated = false;
    validateIntake(intakePath, { artifactRoot });
  } catch (error) {
    if (snapshotTempCreated && existsSync(snapshotTempPath)) rmSync(snapshotTempPath);
    if (installedSnapshot && existsSync(snapshotPath)) rmSync(snapshotPath);
    if (installedSources && existsSync(sourceDirectory)) {
      rmSync(sourceDirectory, { recursive: true });
    }
    throw error;
  }

  return {
    schema_version: 'p2a.reference_snapshot_result.v1',
    target: targetRoot,
    artifactRoot,
    snapshotPath,
    snapshotSha256: sha256(snapshotPath),
    capturedFiles: new Set([entry.sourcePath, bundle.sourcePath, ...references.map((item) => item.sourcePath)]).size,
    snapshot,
  };
}

function printResult(result) {
  console.log('Plan2Agent reference snapshot created');
  console.log(`artifact root: ${result.artifactRoot}`);
  console.log(`snapshot: ${result.snapshotPath}`);
  console.log(`snapshot sha256: ${result.snapshotSha256}`);
  console.log(`captured files: ${result.capturedFiles}`);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`p2a reference error: ${error.message}`);
    console.error('Run p2a reference --help for usage.');
    return 1;
  }
  if (args.help || args.command === '--help' || args.command === '-h') {
    console.log(usage());
    return 0;
  }
  try {
    const result = createReferenceBundleSnapshot(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printResult(result);
    return 0;
  } catch (error) {
    console.error(`p2a reference error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
