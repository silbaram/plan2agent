import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  assertUniqueMilestoneDraftPath,
  promoteMilestoneDraftAtomically,
} from '../scripts/p2a_iteration.mjs';
import { milestoneRunSnapshotSha256, milestoneSnapshotSha256, ValidationError } from '../scripts/validate_artifacts.mjs';
import { E2E_FIXTURE_ROOT, formatCommandResult, runIteration } from './helpers/fixtures.mjs';

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function finishedRun({ projectId, iterationId, task, taskGraphSourceSpec, artifactRoot }) {
  const runId = `run-milestone-${task.id}`;
  const startedAt = '2026-07-11T00:00:00.000Z';
  const finishedAt = '2026-07-11T00:01:00.000Z';
  return {
    schema_version: 'p2a.run.v1',
    runId,
    projectId,
    taskId: task.id,
    taskTitle: task.title,
    iterationId,
    sourceLayout: 'iteration',
    taskGraphRef: `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
    sourceSpecRef: taskGraphSourceSpec,
    agentTool: 'fixture',
    workspaceRef: 'fixture-workspace',
    workspacePath: artifactRoot,
    isolation: {
      mode: 'none',
      branch: null,
      worktree: null,
      baseRef: null,
      created: false,
      createCommand: null,
      createExitCode: null,
      createOutputTail: null,
    },
    status: 'finished',
    startedAt,
    updatedAt: finishedAt,
    finishedAt,
    changedFiles: [`src/${task.id}.mjs`],
    verification: [{
      type: 'test',
      command: `node --test ${task.id}`,
      status: 'passed',
      exitCode: 0,
      durationMs: 1,
      startedAt,
      finishedAt,
      stdoutTail: '',
      stderrTail: '',
      source: 'command',
    }],
    notes: ['milestone promotion fixture'],
  };
}

describe('milestone review atomic promotion', () => {
  test('hard-links one unique draft to the stable checkpoint and removes the draft name', () => {
    const reviewDir = mkdtempSync(path.join(tmpdir(), 'p2a-milestone-promotion-'));
    try {
      const draftPath = path.join(reviewDir, 'midpoint.owner-a.draft.json');
      const stablePath = path.join(reviewDir, 'midpoint.json');
      const content = '{"checkpoint":"midpoint"}\n';
      writeFileSync(draftPath, content, 'utf8');
      const draftStat = statSync(draftPath);

      const result = promoteMilestoneDraftAtomically(draftPath, stablePath);

      assert.deepEqual(result, { draftRemoved: true, cleanupError: null });
      assert.equal(existsSync(draftPath), false);
      assert.equal(readFileSync(stablePath, 'utf8'), content);
      const stableStat = statSync(stablePath);
      assert.equal(stableStat.dev, draftStat.dev);
      assert.equal(stableStat.ino, draftStat.ino);
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  test('never overwrites a stable checkpoint and preserves the losing unique draft', () => {
    const reviewDir = mkdtempSync(path.join(tmpdir(), 'p2a-milestone-promotion-race-'));
    try {
      const draftPath = path.join(reviewDir, 'pre_close.owner-b.draft.json');
      const stablePath = path.join(reviewDir, 'pre_close.json');
      writeFileSync(draftPath, 'loser\n', 'utf8');
      writeFileSync(stablePath, 'winner\n', 'utf8');

      assert.throws(
        () => promoteMilestoneDraftAtomically(draftPath, stablePath),
        (error) => error instanceof ValidationError && /already exists and will not be overwritten/.test(error.message),
      );
      assert.equal(readFileSync(stablePath, 'utf8'), 'winner\n');
      assert.equal(readFileSync(draftPath, 'utf8'), 'loser\n');
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  test('rolls back the stable hard link when unique draft cleanup fails', () => {
    const reviewDir = mkdtempSync(path.join(tmpdir(), 'p2a-milestone-promotion-cleanup-'));
    try {
      const draftPath = path.join(reviewDir, 'midpoint.owner-cleanup.draft.json');
      const stablePath = path.join(reviewDir, 'midpoint.json');
      writeFileSync(draftPath, 'draft remains authoritative\n', 'utf8');

      assert.throws(
        () => promoteMilestoneDraftAtomically(draftPath, stablePath, {
          linkSync,
          unlinkSync(filePath) {
            if (filePath === draftPath) throw new Error('simulated draft cleanup failure');
            unlinkSync(filePath);
          },
        }),
        (error) => error instanceof ValidationError && /promotion rolled back/.test(error.message),
      );
      assert.equal(existsSync(draftPath), true);
      assert.equal(existsSync(stablePath), false);
      assert.equal(readFileSync(draftPath, 'utf8'), 'draft remains authoritative\n');
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  });

  test('requires a direct unique checkpoint draft filename', () => {
    const reviewDir = path.resolve(tmpdir(), 'p2a-milestone-review-dir');
    assert.doesNotThrow(() => assertUniqueMilestoneDraftPath(
      path.join(reviewDir, 'midpoint.run-123.draft.json'),
      reviewDir,
      'midpoint',
    ));
    assert.throws(
      () => assertUniqueMilestoneDraftPath(path.join(reviewDir, 'midpoint.draft.json'), reviewDir, 'midpoint'),
      (error) => error instanceof ValidationError && /unique filename/.test(error.message),
    );
    assert.throws(
      () => assertUniqueMilestoneDraftPath(
        path.join(reviewDir, 'nested', 'midpoint.run-123.draft.json'),
        reviewDir,
        'midpoint',
      ),
      (error) => error instanceof ValidationError && /direct child/.test(error.message),
    );
  });

  test('CLI validates and atomically promotes a unique midpoint draft exactly once', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-milestone-promotion-cli-'));
    try {
      const artifactRoot = path.join(tempRoot, 'artifact-root');
      cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
      const iterationId = 'iter-atomic';
      let result = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', iterationId]);
      assert.equal(result.status, 0, formatCommandResult(result));

      const taskGraphPath = path.join(artifactRoot, 'iterations', iterationId, 'gate-c-task-graph', 'task-graph.json');
      const taskGraph = JSON.parse(readFileSync(taskGraphPath, 'utf8'));
      const doneCount = Math.ceil(taskGraph.tasks.length / 2);
      taskGraph.tasks = taskGraph.tasks.map((task, index) => ({
        ...task,
        status: index < doneCount ? 'done' : 'todo',
      }));
      writeJson(taskGraphPath, taskGraph);

      const runsDir = path.join(artifactRoot, 'runs');
      const completedRuns = taskGraph.tasks.slice(0, doneCount).map((task) => {
        const run = finishedRun({
          projectId: taskGraph.projectId,
          iterationId,
          task,
          taskGraphSourceSpec: taskGraph.sourceSpec,
          artifactRoot,
        });
        const runPath = path.join(runsDir, `${run.runId}.json`);
        writeJson(runPath, run);
        return { task, run, runPath };
      });
      writeJson(path.join(runsDir, 'run-index.json'), {
        schema_version: 'p2a.run_index.v1',
        projectId: taskGraph.projectId,
        runs: completedRuns.map(({ run }) => ({
          runId: run.runId,
          taskId: run.taskId,
          iterationId,
          status: run.status,
          agentTool: run.agentTool,
          workspaceRef: run.workspaceRef,
          taskGraphRef: run.taskGraphRef,
          runRef: `${run.runId}.json`,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        })),
        tasks: completedRuns.map(({ run }) => ({
          taskId: run.taskId,
          runIds: [run.runId],
          latestRunId: run.runId,
        })),
      });

      const reviewDir = path.join(artifactRoot, 'iterations', iterationId, 'milestone-reviews');
      const draftPath = path.join(reviewDir, 'midpoint.owner-a.draft.json');
      const stablePath = path.join(reviewDir, 'midpoint.json');
      const taskCounts = taskGraph.tasks.reduce((counts, task) => {
        counts[task.status] += 1;
        return counts;
      }, { total: taskGraph.tasks.length, done: 0, todo: 0, in_progress: 0, blocked: 0 });
      const review = {
        schema_version: 'p2a.milestone_review.v1',
        project_id: taskGraph.projectId,
        iteration_id: iterationId,
        checkpoint: 'midpoint',
        generated_at: '2026-07-11T00:02:00.000Z',
        source: {
          task_graph_ref: `iterations/${iterationId}/gate-c-task-graph/task-graph.json`,
          task_graph_sha256: sha256File(taskGraphPath),
          task_graph_snapshot: taskGraph,
          task_graph_snapshot_sha256: milestoneSnapshotSha256(taskGraph),
          spec_ref: `iterations/${iterationId}/gate-b-spec/spec.json`,
          style_ref: null,
          task_counts: taskCounts,
          task_snapshot: taskGraph.tasks.map((task) => ({
            task_id: task.id,
            task_title: task.title,
            status: task.status,
          })),
          completed_task_evidence: completedRuns.map(({ task, run, runPath }) => ({
            task_id: task.id,
            task_title: task.title,
            run_id: run.runId,
            run_ref: `runs/${run.runId}.json`,
            run_sha256: sha256File(runPath),
            run_snapshot: run,
            run_snapshot_sha256: milestoneRunSnapshotSha256(run),
            run_finished_at: run.finishedAt,
            changed_files: run.changedFiles,
            verification: run.verification.map((verification) => ({
              type: verification.type,
              command: verification.command,
              status: verification.status,
              exit_code: verification.exitCode,
              source: verification.source,
            })),
          })),
          remaining_task_ids: taskGraph.tasks.slice(doneCount).map((task) => task.id),
        },
        confirmed_findings: [],
        planned_todo_not_findings: [],
        note: '',
      };
      writeJson(draftPath, review);

      result = runIteration(['promote-milestone', '--artifacts', artifactRoot, '--draft', draftPath]);
      assert.equal(result.status, 0, formatCommandResult(result));
      assert.equal(existsSync(draftPath), false);
      assert.equal(existsSync(stablePath), true);
      const stableContent = readFileSync(stablePath, 'utf8');

      const losingDraftPath = path.join(reviewDir, 'midpoint.owner-b.draft.json');
      writeJson(losingDraftPath, review);
      result = runIteration(['promote-milestone', '--artifacts', artifactRoot, '--draft', losingDraftPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /already exists and will not be overwritten/);
      assert.equal(readFileSync(stablePath, 'utf8'), stableContent);
      assert.equal(existsSync(losingDraftPath), true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
