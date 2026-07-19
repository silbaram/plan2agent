/** Atomic writes and cross-process locking for Plan2Agent run stores. */

import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export const RUN_STORE_LOCK_FILE = '.run-store.lock';
export const RUN_STORE_REAPER_LOCK_FILE = '.run-store.lock.reaper';
export const RUN_LAYOUT_MIGRATION_JOURNAL = '.run-layout-migration';
export const RUN_STORE_REDIRECT_FILE = '.run-store-redirect.json';
export const RUN_WRITE_TRANSACTION_FILE = '.run-write-transaction';

const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 25;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;
const REAPER_CLAIM_PREFIX = '.run-store.lock.reaper.claim-';
const REAPER_CLAIM_SETTLE_MS = LOCK_POLL_MS * 2;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Map();

function sleepSync(durationMs) {
  Atomics.wait(WAIT_BUFFER, 0, 0, durationMs);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function reaperClaimName() {
  const monotonicOrder = process.hrtime.bigint().toString().padStart(24, '0');
  return `${REAPER_CLAIM_PREFIX}${monotonicOrder}-${process.pid}-${randomUUID()}`;
}

function reaperClaimOwner(name) {
  const match = new RegExp(`^${REAPER_CLAIM_PREFIX.replaceAll('.', '\\.')}(\\d+)-(\\d+)-`).exec(name);
  if (!match) return null;
  return { order: BigInt(match[1]), pid: Number(match[2]) };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockFileIsStale(filePath) {
  try {
    const owner = JSON.parse(readFileSync(filePath, 'utf8'));
    return !processIsAlive(owner?.pid);
  } catch {
    try {
      return Date.now() - statSync(filePath).mtimeMs >= INCOMPLETE_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
}

function createOwnedLockFile(lockPath, owner) {
  const directory = path.dirname(lockPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(lockPath)}.${process.pid}.${randomUUID()}.initializing`,
  );
  let descriptor = null;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      // Publish only a fully written lock. This keeps a paused owner from being
      // mistaken for an incomplete stale lock between openSync and writeFileSync.
      linkSync(tempPath, lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tempPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function cleanupAbandonedReaperClaims(reaperPath) {
  const directory = path.dirname(reaperPath);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(REAPER_CLAIM_PREFIX)) continue;
    const claimant = reaperClaimOwner(entry.name);
    if (claimant && processIsAlive(claimant.pid)) continue;
    try { unlinkSync(path.join(directory, entry.name)); } catch { /* best effort */ }
  }
}

function reclaimStaleReaper(reaperPath) {
  if (!lockFileIsStale(reaperPath)) return false;
  const claimPath = path.join(path.dirname(reaperPath), reaperClaimName());
  try {
    // A hard link pins the stale inode. Claims are ordered by the system monotonic clock,
    // so a later contender cannot unlink a replacement created by the first claimant.
    try {
      linkSync(reaperPath, claimPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
    if (!lockFileIsStale(claimPath)) return false;
    const claimedFile = statSync(claimPath, { bigint: true });
    sleepSync(REAPER_CLAIM_SETTLE_MS);

    const contenders = [];
    for (const entry of readdirSync(path.dirname(reaperPath), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(REAPER_CLAIM_PREFIX)) continue;
      const claimant = reaperClaimOwner(entry.name);
      if (!claimant) continue;
      const contenderPath = path.join(path.dirname(reaperPath), entry.name);
      let contenderFile;
      try {
        contenderFile = statSync(contenderPath, { bigint: true });
      } catch {
        continue;
      }
      if (!sameFile(claimedFile, contenderFile)) continue;
      if (claimant.pid !== process.pid && !processIsAlive(claimant.pid)) {
        try { unlinkSync(contenderPath); } catch { /* best effort */ }
        continue;
      }
      contenders.push({ path: contenderPath, order: claimant.order });
    }
    const firstOrder = contenders.reduce(
      (minimum, contender) => minimum === null || contender.order < minimum ? contender.order : minimum,
      null,
    );
    const first = contenders.filter((contender) => contender.order === firstOrder);
    // Equal clock values fail closed and retry; picking a UUID tie-breaker could let a
    // later claimant overtake a process already about to unlink the stale inode.
    if (first.length !== 1 || first[0].path !== claimPath) return false;

    let currentFile;
    try {
      currentFile = statSync(reaperPath, { bigint: true });
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    if (!sameFile(claimedFile, currentFile) || !lockFileIsStale(reaperPath)) return false;
    try {
      unlinkSync(reaperPath);
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  } finally {
    try { unlinkSync(claimPath); } catch { /* best effort */ }
  }
}

function acquireStaleLockReaper(lockPath) {
  const reaperPath = path.join(path.dirname(lockPath), RUN_STORE_REAPER_LOCK_FILE);
  cleanupAbandonedReaperClaims(reaperPath);
  const token = randomUUID();
  try {
    if (createOwnedLockFile(reaperPath, { pid: process.pid, token, acquiredAt: new Date().toISOString() })) {
      return { reaperPath, token };
    }
  } catch (error) {
    throw error;
  }
  return reclaimStaleReaper(reaperPath) ? acquireStaleLockReaper(lockPath) : null;
}

function releaseStaleLockReaper(reaper) {
  try {
    const owner = JSON.parse(readFileSync(reaper.reaperPath, 'utf8'));
    if (owner.token === reaper.token) unlinkSync(reaper.reaperPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function removeStaleLock(lockPath) {
  const reaper = acquireStaleLockReaper(lockPath);
  if (!reaper) return false;
  let owner = null;
  let ageMs = 0;
  try {
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        return true;
      }
    }
    const stale = owner
      ? !processIsAlive(owner.pid)
      : ageMs >= INCOMPLETE_LOCK_GRACE_MS;
    if (!stale) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      return false;
    }
  } finally {
    releaseStaleLockReaper(reaper);
  }
}

function acquireLock(runsDir, timeoutMs) {
  const normalizedRunsDir = path.resolve(runsDir);
  const reentrant = heldLocks.get(normalizedRunsDir);
  if (reentrant) {
    reentrant.depth += 1;
    return reentrant;
  }

  mkdirSync(normalizedRunsDir, { recursive: true });
  const lockPath = path.join(normalizedRunsDir, RUN_STORE_LOCK_FILE);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (createOwnedLockFile(lockPath, { pid: process.pid, token, acquiredAt: new Date().toISOString() })) {
        const lock = { runsDir: normalizedRunsDir, lockPath, token, depth: 1 };
        heldLocks.set(normalizedRunsDir, lock);
        return lock;
      }
    } catch (error) {
      throw error;
    }
    if (removeStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for run store lock: ${lockPath}`);
    }
    sleepSync(LOCK_POLL_MS);
  }
}

function releaseLock(lock) {
  const held = heldLocks.get(lock.runsDir);
  if (!held || held.token !== lock.token) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  heldLocks.delete(lock.runsDir);
  try {
    const owner = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    if (owner.token === lock.token) unlinkSync(lock.lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function withRunStoreLocks(runsDirs, callback, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const normalized = [...new Set(runsDirs.map((runsDir) => path.resolve(runsDir)))].sort();
  const locks = [];
  let result;
  let operationError = null;
  let operationFailed = false;
  try {
    for (const runsDir of normalized) locks.push(acquireLock(runsDir, timeoutMs));
    result = callback();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const releaseErrors = [];
  for (const lock of locks.reverse()) {
    try {
      releaseLock(lock);
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  if (operationFailed) {
    if (releaseErrors.length && operationError !== null
      && (typeof operationError === 'object' || typeof operationError === 'function')) {
      try {
        Object.defineProperty(operationError, 'releaseErrors', {
          value: releaseErrors,
          configurable: true,
        });
      } catch {
        // Preserve the primary operation error even when it cannot carry suppressed release errors.
      }
    }
    throw operationError;
  }
  if (releaseErrors.length === 1) throw releaseErrors[0];
  if (releaseErrors.length > 1) {
    throw new AggregateError(releaseErrors, `failed to release ${releaseErrors.length} run store locks`);
  }
  return result;
}

export function atomicWriteText(filePath, text) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let existingMode = null;
  try {
    const target = lstatSync(filePath);
    if (target.isFile()) existingMode = target.mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let descriptor = null;
  try {
    descriptor = openSync(tempPath, 'wx', existingMode ?? 0o666);
    if (existingMode !== null) fchmodSync(descriptor, existingMode);
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempPath, filePath);
    let directoryDescriptor = null;
    try {
      directoryDescriptor = openSync(directory, 'r');
      fsyncSync(directoryDescriptor);
    } catch {
      // Some filesystems do not support fsync on directories; the atomic rename still protects readers.
    } finally {
      if (directoryDescriptor !== null) closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tempPath); } catch { /* best effort; preserve the primary write error */ }
  }
}

export function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function migrationJournalPath(runsDir) {
  return path.join(path.resolve(runsDir), RUN_LAYOUT_MIGRATION_JOURNAL);
}

export function runWriteTransactionPath(runsDir) {
  return path.join(path.resolve(runsDir), RUN_WRITE_TRANSACTION_FILE);
}

export function runStoreRedirectPath(runsDir) {
  return path.join(path.resolve(runsDir), RUN_STORE_REDIRECT_FILE);
}

export function readRunStoreRedirect(runsDir) {
  const redirectPath = runStoreRedirectPath(runsDir);
  if (!existsSync(redirectPath)) return null;
  let redirect;
  try {
    redirect = JSON.parse(readFileSync(redirectPath, 'utf8'));
  } catch (error) {
    throw new Error(`run store redirect is malformed: ${redirectPath}: ${error.message}`);
  }
  if (redirect?.schema_version !== 'p2a.run_store_redirect.v1'
    || typeof redirect.targetRunsDir !== 'string'
    || !path.isAbsolute(redirect.targetRunsDir)
    || path.resolve(redirect.targetRunsDir) === path.resolve(runsDir)) {
    throw new Error(`run store redirect is invalid: ${redirectPath}`);
  }
  return { ...redirect, targetRunsDir: path.resolve(redirect.targetRunsDir) };
}

export function writeRunStoreRedirect(runsDir, targetRunsDir) {
  const source = path.resolve(runsDir);
  const target = path.resolve(targetRunsDir);
  if (source === target) throw new Error(`run store redirect cannot target itself: ${source}`);
  atomicWriteJson(runStoreRedirectPath(source), {
    schema_version: 'p2a.run_store_redirect.v1',
    targetRunsDir: target,
  });
}

export function assertNoPendingRunMigration(runsDir) {
  const redirect = readRunStoreRedirect(runsDir);
  if (redirect) {
    throw new Error(`run store is retired after layout migration: ${path.resolve(runsDir)}. Use the canonical runs directory: ${redirect.targetRunsDir}`);
  }
  const journalPath = migrationJournalPath(runsDir);
  if (existsSync(journalPath)) {
    throw new Error(`run layout migration is incomplete; resume it with p2a_runs.mjs migrate-layout --yes: ${journalPath}`);
  }
}
