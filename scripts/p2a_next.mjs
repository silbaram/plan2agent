/** Minimal state router (p2a next) for Plan2Agent v1. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readConfig, workPath } from './p2a_config.mjs';
import {
  createDraftWork,
  isPlanDrifted,
  readWork,
  readyTasks,
  writeWork,
} from './p2a_work.mjs';

function selectActiveTask(work) {
  if (!work?.tasks?.length) return null;
  if (work.resume?.active_task_id) {
    const preferred = work.tasks.find(
      (t) => t.id === work.resume.active_task_id && t.status === 'in_progress',
    );
    if (preferred) return preferred;
  }
  return work.tasks.find((t) => t.status === 'in_progress') ?? null;
}

function compactWorkSummary(work) {
  if (!work) return null;
  const counts = {
    total: work.tasks.length,
    done: work.tasks.filter((t) => t.status === 'done').length,
    in_progress: work.tasks.filter((t) => t.status === 'in_progress').length,
    todo: work.tasks.filter((t) => t.status === 'todo').length,
    blocked: work.tasks.filter((t) => t.status === 'blocked').length,
  };
  const activeTask = selectActiveTask(work);
  return {
    id: work.id,
    status: work.status,
    goal: work.goal,
    scope: work.scope,
    non_goals: work.non_goals,
    constraints: work.constraints,
    approved: work.approval.approved,
    progress: counts,
    tasks: work.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends_on: t.depends_on,
      acceptance: t.acceptance,
    })),
    active_task: activeTask,
    ready_tasks: readyTasks(work).map((t) => ({ id: t.id, title: t.title, acceptance: t.acceptance })),
    blocked_tasks: work.tasks
      .filter((t) => t.status === 'blocked')
      .map((t) => ({ id: t.id, title: t.title, notes: t.notes })),
    resume: work.resume,
  };
}

export function evaluateNext(targetRoot, { idea = null, entry = null } = {}) {
  const root = path.resolve(targetRoot);
  let config;
  try {
    config = readConfig(root);
  } catch (error) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'invalid_config',
      project_root: root,
      reason: error.message,
      action: {
        kind: 'cli',
        command: 'p2a doctor',
        requires_approval: false,
      },
      work: null,
    };
  }

  if (!config) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'uninitialized',
      project_root: root,
      reason: 'Project is not initialized for Plan2Agent yet.',
      action: {
        kind: 'cli',
        command: 'p2a init',
        requires_approval: false,
      },
      work: null,
    };
  }

  const hasWorkFile = existsSync(workPath(root));
  if ((idea || entry) && hasWorkFile) {
    let existing = null;
    try {
      existing = readWork(root);
    } catch {
      existing = null;
    }
    return {
      schema_version: 'p2a.next.v1',
      state: 'active_work_exists',
      project_root: root,
      reason: 'An active .plan2agent/work.json already exists. Finish it with `p2a done` or discard it with `p2a done --abort` before starting a new request.',
      action: {
        kind: 'user',
        command: 'p2a next',
        requires_approval: false,
      },
      work: compactWorkSummary(existing),
    };
  }

  if ((idea || entry) && !hasWorkFile) {
    const draft = createDraftWork({ idea, entryPath: entry, targetRoot: root });
    writeWork(root, draft);
  }

  let work;
  try {
    work = readWork(root);
  } catch (error) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'invalid_work',
      project_root: root,
      reason: `.plan2agent/work.json is invalid: ${error.message}`,
      action: {
        kind: 'cli',
        command: 'p2a validate',
        requires_approval: false,
      },
      work: null,
    };
  }

  if (!work) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'no_work',
      project_root: root,
      reason: 'No active work. Start a task with `p2a next --idea "<what to build>"`.',
      action: {
        kind: 'user',
        command: 'p2a next --idea "<what to build>"',
        requires_approval: false,
      },
      work: null,
    };
  }

  const summary = compactWorkSummary(work);

  if (!work.tasks.length) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'draft_needs_plan',
      project_root: root,
      reason: 'Draft work has no tasks yet. Inspect the codebase, clarify only material unknowns, and fill goal/scope/non_goals/constraints/tasks in .plan2agent/work.json.',
      action: {
        kind: 'skill',
        skill: 'p2a-work',
        command: '/p2a-work',
        requires_approval: false,
      },
      work: summary,
    };
  }

  if (!work.approval.approved) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'draft_needs_approval',
      project_root: root,
      reason: 'Plan draft is ready for one-time user confirmation of goal, scope, constraints, and tasks.',
      action: {
        kind: 'approval',
        command: 'p2a approve --quote "<user-utterance>"',
        requires_approval: true,
      },
      work: summary,
    };
  }

  if (isPlanDrifted(work)) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'plan_drifted',
      project_root: root,
      reason: 'The approved plan fields in .plan2agent/work.json changed after approval. Reconfirm the updated plan with the user.',
      action: {
        kind: 'approval',
        command: 'p2a approve --quote "<user-utterance>"',
        requires_approval: true,
      },
      work: summary,
    };
  }

  const activeTask = selectActiveTask(work);
  if (activeTask) {
    const verifyStatus = activeTask.verification?.status ?? 'not_run';
    return {
      schema_version: 'p2a.next.v1',
      state: 'task_in_progress',
      project_root: root,
      reason: verifyStatus === 'failed'
        ? `Resume ${activeTask.id} (${activeTask.title}): fix the failed verification and rerun p2a verify.`
        : `Resume ${activeTask.id} (${activeTask.title}) from the recorded state in .plan2agent/work.json.`,
      action: {
        kind: 'skill',
        skill: 'p2a-work',
        command: `/p2a-work --task ${activeTask.id}`,
        requires_approval: false,
      },
      work: summary,
    };
  }

  const nextReady = readyTasks(work);
  if (nextReady.length) {
    const first = nextReady[0];
    return {
      schema_version: 'p2a.next.v1',
      state: 'ready_task',
      project_root: root,
      reason: `Start next ready task ${first.id}: ${first.title}.`,
      action: {
        kind: 'cli',
        command: `p2a task start ${first.id}`,
        skill: 'p2a-work',
        requires_approval: false,
      },
      work: summary,
    };
  }

  if (work.tasks.every((t) => t.status === 'done')) {
    return {
      schema_version: 'p2a.next.v1',
      state: 'ready_to_finish',
      project_root: root,
      reason: config.buildlore?.enabled
        ? 'All tasks are done and verified. Optionally capture knowledge with `p2a buildlore handoff`, then clear work.json with `p2a done`.'
        : 'All tasks are done and verified. Review the summary and finish with `p2a done` to clear work.json.',
      action: {
        kind: 'approval',
        command: 'p2a done',
        requires_approval: true,
      },
      work: summary,
    };
  }

  return {
    schema_version: 'p2a.next.v1',
    state: 'tasks_blocked',
    project_root: root,
    reason: 'No task is ready to start because remaining tasks are blocked or waiting on blocked dependencies.',
    action: {
      kind: 'user',
      command: 'p2a task unblock <id>',
      requires_approval: false,
    },
    work: summary,
  };
}

export function formatNextHuman(result) {
  const lines = [];
  const work = result.work;

  if (work) {
    lines.push(`목표: ${work.goal}`);
    lines.push(`진행: ${work.progress.done}/${work.progress.total} 완료`);
    if (work.resume?.summary) {
      lines.push(`재개 메모: ${work.resume.summary}`);
    }
    if (work.active_task) {
      const t = work.active_task;
      const ver = t.verification ? `${t.verification.status} (exit ${t.verification.exit_code})` : '미실행';
      lines.push(`진행 중 태스크: ${t.id} — ${t.title} [검증: ${ver}]`);
      if (t.notes.length) {
        lines.push(`최근 메모: ${t.notes.at(-1)}`);
      }
    } else if (result.state === 'draft_needs_approval' || result.state === 'plan_drifted') {
      if (work.scope?.length) lines.push(`범위: ${work.scope.join(', ')}`);
      if (work.non_goals?.length) lines.push(`제외: ${work.non_goals.join(', ')}`);
      if (work.constraints?.length) lines.push(`제약: ${work.constraints.join(', ')}`);
      lines.push('태스크 계획:');
      for (const t of work.tasks) {
        const deps = t.depends_on.length ? ` (선행: ${t.depends_on.join(', ')})` : '';
        lines.push(`  - ${t.id}: ${t.title}${deps}`);
      }
    } else if (work.blocked_tasks.length) {
      lines.push('차단된 태스크:');
      for (const t of work.blocked_tasks) {
        lines.push(`  - ${t.id}: ${t.title}${t.notes.length ? ` (${t.notes.at(-1)})` : ''}`);
      }
    }
    lines.push('');
  }

  lines.push(`상태: ${result.state}`);
  lines.push(`안내: ${result.reason}`);
  lines.push(`다음 행동: ${result.action.command}`);
  return lines.join('\n');
}
