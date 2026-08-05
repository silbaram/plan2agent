/** Append-only decision-ledger helpers shared by Gate CLIs and p2a next. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { normalizePath } from './p2a_paths.mjs';
import { withRunStoreLocks } from './p2a_run_store.mjs';
import {
  decisionRecordSha256,
  validateDecisionData,
  validateDecisionLedger,
  ValidationError,
} from './validate_artifacts.mjs';

export const DECISIONS_FILE = 'decisions.jsonl';
const GATE_WHAT_TYPES = new Set([
  'gate.what.approved',
  'gate.what.revoked',
  'scope.added',
  'scope.removed',
]);
const ACTIVE_SCOPE_TYPES = new Set(['gate.what.approved', 'scope.added', 'scope.removed']);
const GATE_HOW_TYPES = new Set(['gate.how.approved', 'gate.how.revoked']);

function isDirectory(directory) {
  try {
    return existsSync(directory) && lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isArtifactRoot(directory) {
  return isDirectory(directory) && [
    'current-spec.json',
    DECISIONS_FILE,
    path.join('gate-a-intake', 'intake.json'),
    path.join('gate-b-spec', 'spec.json'),
  ].some((relativePath) => existsSync(path.join(directory, relativePath)))
    || isDirectory(path.join(directory, 'iterations'));
}

function artifactRootCandidates(target, projectId = null) {
  const root = path.resolve(target);
  const candidates = [];
  if (isArtifactRoot(root)) candidates.push(root);
  for (const parent of [
    path.join(root, '.plan2agent', 'artifacts'),
    path.join(root, 'artifacts'),
  ]) {
    if (projectId) {
      candidates.push(path.join(parent, projectId));
      continue;
    }
    if (!isDirectory(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(parent, entry.name));
    }
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function resolveDecisionArtifactRoot(target, options = {}) {
  if (options.artifacts) {
    const explicit = path.resolve(options.artifacts);
    if (!isDirectory(explicit)) {
      throw new ValidationError(`decision artifact root must be an existing directory: ${explicit}`);
    }
    return explicit;
  }
  const candidates = artifactRootCandidates(target, options.projectId)
    .filter((candidate) => isArtifactRoot(candidate));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ValidationError(
      `multiple decision artifact roots are available: ${candidates.map((candidate) => normalizePath(candidate)).join(', ')}; use --artifacts or --project-id`,
    );
  }
  if (options.create && options.projectId) {
    const created = path.join(path.resolve(target), '.plan2agent', 'artifacts', options.projectId);
    mkdirSync(created, { recursive: true });
    return created;
  }
  if (options.optional) return null;
  throw new ValidationError('no Plan2Agent artifact root is available; use --artifacts <path>');
}

export function decisionLedgerPath(artifactRoot) {
  return path.join(path.resolve(artifactRoot), DECISIONS_FILE);
}

export function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function constitutionContentSha256(constitution) {
  const content = { ...constitution };
  delete content.approval_audit;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export function readDecisions(artifactRoot, options = {}) {
  const ledgerPath = decisionLedgerPath(artifactRoot);
  if (!existsSync(ledgerPath)) {
    if (options.required) throw new ValidationError(`decision ledger is missing: ${ledgerPath}`);
    return [];
  }
  return validateDecisionLedger(ledgerPath);
}

export function withDecisionLedgerLock(artifactRoot, callback, options = {}) {
  return withRunStoreLocks([path.resolve(artifactRoot)], callback, options);
}

function nextDecisionRecord(records, event) {
  const {
    seq: _ignoredSeq,
    at,
    prev_sha256: _ignoredPreviousSha256,
    ...decision
  } = event;
  const record = {
    seq: records.length + 1,
    at: at ?? new Date().toISOString(),
    ...decision,
    quote: event.quote,
    prev_sha256: records.length ? decisionRecordSha256(records.at(-1)) : null,
  };
  validateDecisionData(record);
  return record;
}

function rollbackDecisionAppend(ledgerPath, ledgerExisted, originalText, descriptor) {
  const failures = [];
  let rollbackDescriptor = descriptor;
  if (!ledgerExisted) {
    if (rollbackDescriptor !== null) {
      try { closeSync(rollbackDescriptor); } catch (error) { failures.push(error.message); }
    }
    if (existsSync(ledgerPath)) {
      try { unlinkSync(ledgerPath); } catch (error) { failures.push(error.message); }
    }
    return failures;
  }
  let restoreContents = false;
  try {
    if (!existsSync(ledgerPath)) {
      if (rollbackDescriptor !== null) closeSync(rollbackDescriptor);
      rollbackDescriptor = openSync(ledgerPath, 'w+');
      restoreContents = true;
    } else if (rollbackDescriptor === null) {
      rollbackDescriptor = openSync(ledgerPath, 'r+');
    }
    if (restoreContents) {
      writeFileSync(rollbackDescriptor, originalText, 'utf8');
    } else {
      ftruncateSync(rollbackDescriptor, Buffer.byteLength(originalText, 'utf8'));
    }
    fsyncSync(rollbackDescriptor);
  } catch (error) {
    failures.push(error.message);
  } finally {
    if (rollbackDescriptor !== null) {
      try { closeSync(rollbackDescriptor); } catch (error) { failures.push(error.message); }
    }
  }
  return failures;
}

export function appendDecisionEventsLocked(artifactRoot, events) {
  if (!events.length) return [];
  const root = path.resolve(artifactRoot);
  mkdirSync(root, { recursive: true });
  const ledgerPath = decisionLedgerPath(root);
  const records = readDecisions(root);
  const appended = [];
  for (const event of events) {
    const record = nextDecisionRecord(records, event);
    records.push(record);
    appended.push(record);
  }
  const ledgerExisted = existsSync(ledgerPath);
  const existingText = ledgerExisted ? readFileSync(ledgerPath, 'utf8') : '';
  const separator = existingText && !existingText.endsWith('\n') ? '\n' : '';
  const appendedText = `${separator}${appended.map((record) => JSON.stringify(record)).join('\n')}\n`;
  let descriptor = null;
  let appendStarted = false;
  try {
    descriptor = openSync(ledgerPath, 'a', 0o666);
    appendStarted = true;
    writeFileSync(descriptor, appendedText, 'utf8');
    fsyncSync(descriptor);
    try {
      closeSync(descriptor);
    } finally {
      descriptor = null;
    }
    validateDecisionLedger(ledgerPath);
  } catch (error) {
    if (!appendStarted) throw error;
    const rollbackFailures = rollbackDecisionAppend(
      ledgerPath,
      ledgerExisted,
      existingText,
      descriptor,
    );
    descriptor = null;
    if (rollbackFailures.length) {
      throw new Error(
        `${error.message}; decision ledger append rollback failed: ${rollbackFailures.join('; ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  return appended;
}

export function appendDecisionEvents(artifactRoot, events) {
  return withDecisionLedgerLock(
    artifactRoot,
    () => appendDecisionEventsLocked(artifactRoot, events),
  );
}

export function normalizedDecisionRef(reference) {
  return normalizePath(String(reference ?? '')).replace(/^\.\//, '');
}

export function scopeDecisionEvents(records, scopeRef) {
  const normalized = normalizedDecisionRef(scopeRef);
  return records.filter((record) => (
    GATE_WHAT_TYPES.has(record.type)
    && normalizedDecisionRef(record.scope_ref) === normalized
  ));
}

export function scopeApprovalState(
  records,
  scopeRef,
  sha256,
  fallbackApproved = false,
  options = {},
) {
  const matches = scopeDecisionEvents(records, scopeRef);
  if (!matches.length) {
    const allowLegacyFallback = options.allowLegacyFallback ?? (records.length === 0);
    return {
      approved: allowLegacyFallback && fallbackApproved,
      source: allowLegacyFallback ? 'approval_audit' : 'decisions',
      event: null,
    };
  }
  const latest = matches.at(-1);
  return {
    approved: ACTIVE_SCOPE_TYPES.has(latest.type) && latest.sha256 === sha256,
    source: 'decisions',
    event: latest,
  };
}

export function constitutionApprovalState(records, sha256, fallbackApproved = false, options = {}) {
  const matches = records.filter((record) => GATE_HOW_TYPES.has(record.type));
  if (!matches.length) {
    const allowLegacyFallback = options.allowLegacyFallback ?? (records.length === 0);
    return {
      approved: allowLegacyFallback && fallbackApproved,
      source: allowLegacyFallback ? 'approval_audit' : 'decisions',
      event: null,
    };
  }
  const latest = matches.at(-1);
  return {
    approved: latest.type === 'gate.how.approved' && latest.constitution_sha256 === sha256,
    source: 'decisions',
    event: latest,
  };
}

export function latestActiveScopeApproval(records, preferredRefs = []) {
  const preferred = new Set(preferredRefs.map(normalizedDecisionRef));
  const candidates = records.filter((record) => (
    ACTIVE_SCOPE_TYPES.has(record.type)
    && (!preferred.size || preferred.has(normalizedDecisionRef(record.scope_ref)))
  ));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const latest = scopeDecisionEvents(records, candidate.scope_ref).at(-1);
    if (latest && ACTIVE_SCOPE_TYPES.has(latest.type) && latest.seq === candidate.seq) return candidate;
  }
  return null;
}

export function latestActiveConstitutionApproval(records) {
  const latest = records.filter((record) => GATE_HOW_TYPES.has(record.type)).at(-1);
  return latest?.type === 'gate.how.approved' ? latest : null;
}

export function latestConstitutionApproval(records) {
  return records.filter((record) => record.type === 'gate.how.approved').at(-1) ?? null;
}
