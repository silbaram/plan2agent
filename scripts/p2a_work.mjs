/** Single-file work state engine (.plan2agent/work.json) for Plan2Agent v1. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError, validateSchema } from './p2a_schema.mjs';
import { atomicWriteJson, workPath } from './p2a_config.mjs';

const WORK_SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../schemas/work.schema.json', import.meta.url)),
  'utf8',
));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function computePlanSha256(work) {
  const planProjection = {
    goal: work.goal,
    scope: work.scope,
    non_goals: work.non_goals,
    constraints: work.constraints,
    tasks: (work.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      depends_on: task.depends_on,
      acceptance: task.acceptance,
    })),
  };
  return sha256Text(canonicalJson(planProjection));
}

export function isPlanDrifted(work) {
  if (!work?.approval?.approved) return false;
  return work.approval.plan_sha256 !== computePlanSha256(work);
}

function assertValidTaskDag(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw new ValidationError(`duplicate task id: ${task.id}`);
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (dep === task.id) {
        throw new ValidationError(`task ${task.id} cannot depend on itself`);
      }
      if (!byId.has(dep)) {
        throw new ValidationError(`task ${task.id} depends on unknown task ${dep}`);
      }
    }
  }
  const state = new Map(); // 0/undefined = unvisited, 1 = visiting, 2 = visited
  function visit(id, trail) {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(' -> ');
      throw new ValidationError(`task dependency cycle detected: ${cycle}`);
    }
    if (current === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id).depends_on) {
      visit(dep, [...trail, id]);
    }
    state.set(id, 2);
  }
  for (const id of byId.keys()) visit(id, []);
}

export function validateWork(data) {
  validateSchema(data, WORK_SCHEMA);
  assertValidTaskDag(data.tasks);
  if (data.approval.approved) {
    if (!data.tasks.length) {
      throw new ValidationError('approved work must contain at least one task');
    }
    if (!data.approval.quote || !data.approval.quote.trim()) {
      throw new ValidationError('approved work requires a non-empty approval quote');
    }
    if (!data.approval.at || Number.isNaN(Date.parse(data.approval.at))) {
      throw new ValidationError('approved work requires a valid approval timestamp');
    }
    if (!data.approval.plan_sha256) {
      throw new ValidationError('approved work requires approval.plan_sha256');
    }
  }
  if (data.resume.active_task_id && !data.tasks.some((t) => t.id === data.resume.active_task_id)) {
    throw new ValidationError(`resume.active_task_id references unknown task ${data.resume.active_task_id}`);
  }
  return data;
}

export function readWork(targetRoot) {
  const file = workPath(targetRoot);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ValidationError(`invalid .plan2agent/work.json JSON: ${error.message}`);
  }
  return validateWork(raw);
}

export function writeWork(targetRoot, work) {
  const validated = validateWork(work);
  atomicWriteJson(workPath(targetRoot), validated);
  return validated;
}

export function removeWork(targetRoot) {
  const file = workPath(targetRoot);
  if (existsSync(file)) unlinkSync(file);
}

export function nowIso() {
  return new Date().toISOString();
}

export function generateWorkId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
  return `work-${stamp}`;
}

export function createDraftWork({ idea = null, entryPath = null, targetRoot = process.cwd() } = {}) {
  const now = nowIso();
  let entry = null;
  let goal = '';

  if (entryPath) {
    const resolved = path.resolve(targetRoot, entryPath);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`entry file does not exist: ${entryPath}`);
    }
    const content = readFileSync(resolved, 'utf8');
    if (!content.trim()) {
      throw new Error(`entry file is empty: ${entryPath}`);
    }
    const firstLine = content
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? path.basename(resolved);
    const relativePath = path.relative(path.resolve(targetRoot), resolved).split(path.sep).join('/');
    entry = {
      kind: 'file',
      text: null,
      path: relativePath.startsWith('..') ? resolved : relativePath,
      sha256: sha256Text(content),
    };
    goal = firstLine.slice(0, 200);
  } else if (typeof idea === 'string' && idea.trim()) {
    const text = idea.trim();
    entry = {
      kind: 'idea',
      text,
      path: null,
      sha256: sha256Text(text),
    };
    goal = text.split(/\r?\n/)[0].trim().slice(0, 200);
  } else {
    throw new Error('createDraftWork requires --idea "<text>" or --entry <path>');
  }

  return validateWork({
    schema_version: 'p2a.work.v1',
    id: generateWorkId(),
    status: 'draft',
    entry,
    goal,
    scope: [],
    non_goals: [],
    constraints: [],
    approval: {
      approved: false,
      at: null,
      quote: null,
      plan_sha256: null,
    },
    tasks: [],
    resume: {
      active_task_id: null,
      summary: null,
      updated_at: now,
    },
  });
}

export function createTask({ id, title, acceptance, depends_on = [] }) {
  return {
    id,
    title,
    status: 'todo',
    depends_on,
    acceptance,
    verification: null,
    changed_files: [],
    notes: [],
  };
}

export function findTask(work, taskId) {
  const task = work.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  return task;
}

export function readyTasks(work) {
  const doneIds = new Set(work.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return work.tasks.filter(
    (t) => t.status === 'todo' && t.depends_on.every((dep) => doneIds.has(dep)),
  );
}

export function approveWork(targetRoot, quote) {
  if (typeof quote !== 'string' || !quote.trim()) {
    throw new Error('--quote requires the user confirmation utterance');
  }
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found; start work first');
  if (!work.tasks.length) {
    throw new Error('cannot approve work without at least one task in work.json');
  }
  const now = nowIso();
  work.approval = {
    approved: true,
    at: now,
    quote: quote.trim(),
    plan_sha256: computePlanSha256(work),
  };
  if (work.status === 'draft' || (work.status === 'done' && work.tasks.some((t) => t.status !== 'done'))) {
    work.status = work.tasks.some((t) => t.status === 'in_progress') ? 'in_progress' : 'approved';
  }
  work.resume.updated_at = now;
  return writeWork(targetRoot, work);
}

export function assertApprovedAndCurrent(work) {
  if (!work.approval.approved) {
    throw new Error('work plan is not approved yet; confirm the plan with the user and run p2a approve --quote "<utterance>"');
  }
  if (isPlanDrifted(work)) {
    throw new Error('approved plan changed after approval; reconfirm with the user and run p2a approve --quote "<utterance>"');
  }
}

export function startTask(targetRoot, taskId, { summary = null, allowParallel = false } = {}) {
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  assertApprovedAndCurrent(work);
  const task = findTask(work, taskId);
  if (task.status === 'done') {
    throw new Error(`task ${taskId} is already done`);
  }
  const otherActive = work.tasks.find((t) => t.status === 'in_progress' && t.id !== taskId);
  if (otherActive && !allowParallel) {
    throw new Error(`task ${otherActive.id} is already in_progress; finish or block it first (or pass --allow-parallel)`);
  }
  const doneIds = new Set(work.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const unmet = task.depends_on.filter((dep) => !doneIds.has(dep));
  if (unmet.length) {
    throw new Error(`task ${taskId} is waiting on incomplete dependencies: ${unmet.join(', ')}`);
  }
  const now = nowIso();
  task.status = 'in_progress';
  work.status = 'in_progress';
  work.resume.active_task_id = task.id;
  if (summary && summary.trim()) work.resume.summary = summary.trim();
  work.resume.updated_at = now;
  return writeWork(targetRoot, work);
}

export function addTaskNote(targetRoot, taskId, { note = null, summary = null } = {}) {
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  const task = findTask(work, taskId);
  if (note && note.trim()) {
    task.notes.push(note.trim());
  }
  if (summary && summary.trim()) {
    work.resume.summary = summary.trim();
  }
  if (!note?.trim() && !summary?.trim()) {
    throw new Error('task note requires --note "<text>" and/or --summary "<text>"');
  }
  work.resume.updated_at = nowIso();
  return writeWork(targetRoot, work);
}

export function blockTask(targetRoot, taskId, { reason, summary = null }) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('task block requires --reason "<text>"');
  }
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  const task = findTask(work, taskId);
  task.status = 'blocked';
  task.notes.push(`blocked: ${reason.trim()}`);
  if (work.resume.active_task_id === task.id) {
    work.resume.active_task_id = work.tasks.find((t) => t.status === 'in_progress')?.id ?? null;
  }
  work.resume.summary = summary?.trim() || `Blocked on ${task.id}: ${reason.trim()}`;
  work.resume.updated_at = nowIso();
  return writeWork(targetRoot, work);
}

export function unblockTask(targetRoot, taskId) {
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  const task = findTask(work, taskId);
  if (task.status !== 'blocked') {
    throw new Error(`task ${taskId} is not blocked (current status: ${task.status})`);
  }
  task.status = 'todo';
  work.resume.updated_at = nowIso();
  return writeWork(targetRoot, work);
}

export function addTaskToWork(targetRoot, { id, title, acceptance, depends_on = [] }) {
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  let nextId = id;
  if (!nextId) {
    let n = work.tasks.length + 1;
    const existingIds = new Set(work.tasks.map((t) => t.id));
    while (existingIds.has(`T${n}`)) n += 1;
    nextId = `T${n}`;
  }
  work.tasks.push(createTask({
    id: nextId,
    title,
    acceptance: Array.isArray(acceptance) ? acceptance : [acceptance],
    depends_on,
  }));
  if (work.status === 'done') {
    work.status = work.approval.approved ? 'approved' : 'draft';
  }
  work.resume.updated_at = nowIso();
  return writeWork(targetRoot, work);
}

export function completeTask(targetRoot, taskId, { summary = null, currentFingerprint = null } = {}) {
  const work = readWork(targetRoot);
  if (!work) throw new Error('no .plan2agent/work.json found');
  assertApprovedAndCurrent(work);
  const task = findTask(work, taskId);
  if (task.status === 'blocked') {
    throw new Error(`task ${taskId} is blocked; unblock and verify it before completing`);
  }
  const doneIds = new Set(work.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const unmet = task.depends_on.filter((dep) => !doneIds.has(dep));
  if (unmet.length) {
    throw new Error(`task ${taskId} cannot be completed while dependencies remain incomplete: ${unmet.join(', ')}`);
  }
  if (!task.verification || task.verification.status !== 'passed' || task.verification.exit_code !== 0) {
    throw new Error(`task ${taskId} has no passing verification; run p2a verify --task ${taskId} first`);
  }
  if (
    currentFingerprint
    && task.verification.worktree_fingerprint
    && task.verification.worktree_fingerprint !== currentFingerprint
  ) {
    throw new Error(`workspace changed after the last passing verification for ${taskId}; rerun p2a verify --task ${taskId}`);
  }
  const now = nowIso();
  task.status = 'done';
  if (work.resume.active_task_id === task.id) {
    work.resume.active_task_id = work.tasks.find((t) => t.status === 'in_progress')?.id ?? null;
  }
  if (work.tasks.every((t) => t.status === 'done')) {
    work.status = 'done';
  }
  if (summary && summary.trim()) {
    work.resume.summary = summary.trim();
  }
  work.resume.updated_at = now;
  return writeWork(targetRoot, work);
}

export function finishWork(targetRoot, { abort = false } = {}) {
  const work = readWork(targetRoot);
  if (!work) {
    throw new Error('no active .plan2agent/work.json to finish');
  }
  if (!abort) {
    assertApprovedAndCurrent(work);
    const remaining = work.tasks.filter((t) => t.status !== 'done');
    if (remaining.length) {
      throw new Error(`cannot finish work while tasks remain incomplete: ${remaining.map((t) => `${t.id}(${t.status})`).join(', ')}`);
    }
    const unverified = work.tasks.filter(
      (t) => !t.verification || t.verification.status !== 'passed' || t.verification.exit_code !== 0,
    );
    if (unverified.length) {
      throw new Error(`cannot finish work without passing verification on: ${unverified.map((t) => t.id).join(', ')}`);
    }
  }
  const snapshot = structuredClone(work);
  removeWork(targetRoot);
  return snapshot;
}
