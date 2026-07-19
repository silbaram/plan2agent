import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { describe, test } from 'node:test';
import {
  milestoneRunSnapshotSha256,
  milestoneSnapshotSha256,
  validateMilestoneReview,
  validateMilestoneReviewData,
  validateRunsDir,
  ValidationError,
} from '../scripts/validate_artifacts.mjs';
import { ROOT, runRuns } from './helpers/fixtures.mjs';

const PROJECT_ID = 'webhook-api-service';
const ITERATION_ID = 'iter-002';
const TASK_GRAPH_REF = `iterations/${ITERATION_ID}/gate-c-task-graph/task-graph.json`;
const SPEC_REF = `iterations/${ITERATION_ID}/gate-b-spec/spec.json`;

function rawFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function task(index, status) {
  const suffix = String(index).padStart(3, '0');
  return {
    id: `task-${suffix}`,
    title: `${status === 'done' ? 'Completed' : 'Remaining'} task ${index}`,
    description: `Fixture task ${index} description.`,
    status,
    dependencies: [],
    acceptanceCriteria: [`Fixture task ${index} is verifiably complete.`],
    targetArea: `area-${index}`,
    suggestedAgentPrompt: `Implement fixture task ${index}.`,
    sourceSpecRefs: ['implementation.verification'],
  };
}

function taskGraph(statuses = ['done', 'done', 'todo', 'in_progress']) {
  return {
    schema_version: 'p2a.task_graph.v1',
    projectId: PROJECT_ID,
    version: `${ITERATION_ID}`,
    sourceSpec: '../gate-b-spec/spec.json',
    tasks: statuses.map((status, index) => task(index + 1, status)),
  };
}

function normalizedVerification(index) {
  const suffix = String(index).padStart(3, '0');
  return [{
    type: 'test',
    command: `node --test task-${suffix}`,
    status: 'passed',
    exit_code: 0,
    source: 'command',
  }];
}

function supplementalRunVerification() {
  return {
    type: 'lint',
    command: 'node --check supplemented.mjs',
    status: 'passed',
    exitCode: 0,
    durationMs: 2,
    startedAt: '2026-07-11T00:11:00.000Z',
    finishedAt: '2026-07-11T00:11:01.000Z',
    stdoutTail: 'passed',
    stderrTail: null,
    source: 'command',
  };
}

function completedTaskEvidence(index) {
  const suffix = String(index).padStart(3, '0');
  const evidence = {
    task_id: `task-${suffix}`,
    task_title: `Completed task ${index}`,
    run_id: `run-task-${suffix}`,
    run_ref: `runs/run-task-${suffix}.json`,
    run_sha256: 'b'.repeat(64),
    run_finished_at: `2026-07-11T00:0${index}:00.000Z`,
    changed_files: [`src/task-${suffix}.mjs`],
    verification: normalizedVerification(index),
  };
  const runSnapshot = fullRun(evidence);
  return {
    ...evidence,
    run_snapshot: runSnapshot,
    run_snapshot_sha256: milestoneRunSnapshotSha256(runSnapshot),
  };
}

function midpointReview() {
  const graph = taskGraph();
  return {
    schema_version: 'p2a.milestone_review.v1',
    project_id: PROJECT_ID,
    iteration_id: ITERATION_ID,
    checkpoint: 'midpoint',
    generated_at: '2026-07-11T00:10:00.000Z',
    source: {
      task_graph_ref: TASK_GRAPH_REF,
      task_graph_sha256: 'a'.repeat(64),
      task_graph_snapshot: graph,
      task_graph_snapshot_sha256: milestoneSnapshotSha256(graph),
      spec_ref: SPEC_REF,
      style_ref: '.plan2agent/style.md',
      task_counts: {
        total: 4,
        done: 2,
        todo: 1,
        in_progress: 1,
        blocked: 0,
      },
      task_snapshot: graph.tasks.map((item) => ({
        task_id: item.id,
        task_title: item.title,
        status: item.status,
      })),
      completed_task_evidence: [completedTaskEvidence(1), completedTaskEvidence(2)],
      remaining_task_ids: ['task-003', 'task-004'],
    },
    confirmed_findings: [
      {
        finding_id: 'MRF-001',
        category: 'integration',
        severity: 'medium',
        summary: 'Completed modules disagree on the event identifier field.',
        evidence: [
          {
            kind: 'file',
            reference: 'src/task-001.mjs:12',
            detail: 'Producer emits eventId while the completed consumer reads id.',
          },
        ],
        affected_completed_tasks: ['task-001', 'task-002'],
        maintenance_recommendation: 'Align the completed producer and consumer contract.',
      },
    ],
    planned_todo_not_findings: [
      {
        summary: 'End-to-end retry coverage is planned but not implemented yet.',
        covered_by_remaining_tasks: ['task-004'],
        evidence: [
          {
            kind: 'task',
            reference: 'task-004',
            detail: 'Its acceptance criteria require retry integration coverage.',
          },
        ],
      },
    ],
    note: '',
  };
}

function fullRun(evidence, overrides = {}) {
  const index = Number.parseInt(evidence.task_id.slice('task-'.length), 10);
  const finishedAt = overrides.finishedAt ?? evidence.run_finished_at;
  const verification = (overrides.verification ?? evidence.verification).map((item) => ({
    type: item.type,
    command: item.command,
    status: item.status,
    exitCode: item.exit_code,
    durationMs: 1,
    startedAt: '2026-07-11T00:00:00.000Z',
    finishedAt,
    stdoutTail: 'passed',
    stderrTail: null,
    source: item.source,
  }));
  return {
    schema_version: 'p2a.run.v1',
    runId: overrides.runId ?? evidence.run_id,
    projectId: overrides.projectId ?? PROJECT_ID,
    taskId: overrides.taskId ?? evidence.task_id,
    taskTitle: overrides.taskTitle ?? evidence.task_title,
    iterationId: overrides.iterationId ?? ITERATION_ID,
    sourceLayout: 'iteration',
    taskGraphRef: overrides.taskGraphRef ?? TASK_GRAPH_REF,
    sourceSpecRef: '../gate-b-spec/spec.json',
    agentTool: 'codex',
    workspaceRef: `fixture-workspace-${index}`,
    workspacePath: `/tmp/fixture-workspace-${index}`,
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
    status: overrides.status ?? 'finished',
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: finishedAt,
    finishedAt,
    changedFiles: overrides.changedFiles ?? evidence.changed_files,
    verification,
    notes: [],
  };
}

function indexEntry(run) {
  return {
    runId: run.runId,
    taskId: run.taskId,
    iterationId: run.iterationId,
    status: run.status,
    agentTool: run.agentTool,
    workspaceRef: run.workspaceRef,
    taskGraphRef: run.taskGraphRef,
    runRef: `${run.runId}.json`,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function writeRunIndex(runsDir, runs) {
  const taskIds = [...new Set(runs.map((run) => run.taskId))];
  const index = {
    schema_version: 'p2a.run_index.v1',
    projectId: PROJECT_ID,
    runs: runs.map(indexEntry),
    tasks: taskIds.map((taskId) => {
      const taskRunIds = runs.filter((run) => run.taskId === taskId).map((run) => run.runId);
      return { taskId, runIds: taskRunIds, latestRunId: taskRunIds.at(-1) };
    }),
  };
  writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

function writeBundle(data, filename = `${data.checkpoint}.fixture.draft.json`) {
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'p2a-milestone-review-'));
  const iterationRoot = path.join(artifactRoot, 'iterations', data.iteration_id);
  const graphPath = path.join(iterationRoot, 'gate-c-task-graph', 'task-graph.json');
  const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
  const milestoneDir = path.join(iterationRoot, 'milestone-reviews');
  const runsDir = path.join(artifactRoot, 'runs');
  for (const dir of [path.dirname(graphPath), path.dirname(specPath), milestoneDir, runsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(graphPath, `${JSON.stringify(data.source.task_graph_snapshot, null, 2)}\n`, 'utf8');
  data.source.task_graph_sha256 = rawFileSha256(graphPath);
  const spec = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', '_e2e', 'webhook-api-service', 'gate-b-spec', 'spec.json'), 'utf8'));
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  const runs = data.source.completed_task_evidence.map((evidence) => {
    const run = structuredClone(evidence.run_snapshot);
    const runPath = path.join(runsDir, `${run.runId}.json`);
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    evidence.run_sha256 = rawFileSha256(runPath);
    return run;
  });
  writeRunIndex(runsDir, runs);

  const reviewPath = path.join(milestoneDir, filename);
  writeFileSync(reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { artifactRoot, graphPath, milestoneDir, reviewPath, runs, runsDir };
}

function addRun(bundle, run) {
  writeFileSync(path.join(bundle.runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  bundle.runs.push(run);
  writeRunIndex(bundle.runsDir, bundle.runs);
}

describe('milestone review artifact contract', () => {
  test('accepts a complete in-memory midpoint evidence snapshot', () => {
    const data = midpointReview();
    assert.equal(validateMilestoneReviewData(data), data);
  });

  test('cross-validates a unique draft against task graph, spec, run-index, and run files', () => {
    const data = midpointReview();
    const bundle = writeBundle(data);
    try {
      assert.deepEqual(validateMilestoneReview(bundle.reviewPath), data);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('allows known run sidecars but still rejects an unindexed run-shaped JSON file', () => {
    const data = midpointReview();
    const bundle = writeBundle(data);
    try {
      writeFileSync(
        path.join(bundle.runsDir, `${bundle.runs[0].runId}.style-verdict.json`),
        `${JSON.stringify({ verdict: 'pass', violationCount: 0 }, null, 2)}\n`,
        'utf8',
      );
      assert.deepEqual(validateMilestoneReview(bundle.reviewPath), data);
      assert.equal(validateRunsDir(bundle.runsDir).projectId, PROJECT_ID);

      writeFileSync(path.join(bundle.runsDir, 'run-unindexed.json'), '{}\n', 'utf8');
      assert.throws(() => validateRunsDir(bundle.runsDir), /unindexed run file/);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('accepts canonical midpoint validation after task status and finished-run evidence progress', () => {
    const data = midpointReview();
    const bundle = writeBundle(data, 'midpoint.json');
    try {
      const progressed = structuredClone(data.source.task_graph_snapshot);
      for (const item of progressed.tasks) item.status = 'done';
      writeFileSync(bundle.graphPath, `${JSON.stringify(progressed, null, 2)}\n`, 'utf8');

      const supplementedRun = bundle.runs[0];
      supplementedRun.changedFiles.push('src/supplemented.mjs');
      supplementedRun.verification.push(supplementalRunVerification());
      supplementedRun.notes.push('Evidence supplemented after milestone promotion.');
      supplementedRun.updatedAt = '2026-07-11T00:11:01.000Z';
      writeFileSync(
        path.join(bundle.runsDir, `${supplementedRun.runId}.json`),
        `${JSON.stringify(supplementedRun, null, 2)}\n`,
        'utf8',
      );
      writeRunIndex(bundle.runsDir, bundle.runs);

      assert.deepEqual(validateMilestoneReview(bundle.reviewPath), data);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('keeps a promoted milestone valid after legacy run files migrate into the iteration directory', () => {
    const data = midpointReview();
    const bundle = writeBundle(data, 'midpoint.json');
    try {
      const result = runRuns(['migrate-layout', '--runs', bundle.runsDir, '--yes']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(validateMilestoneReview(bundle.reviewPath), data);
      assert.equal(validateRunsDir(bundle.runsDir).runs.every((run) => run.runRef.startsWith(`${ITERATION_ID}/`)), true);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('accepts a new milestone draft that references partitioned run evidence', () => {
    const data = midpointReview();
    const bundle = writeBundle(data);
    try {
      const migration = runRuns(['migrate-layout', '--runs', bundle.runsDir, '--yes']);
      assert.equal(migration.status, 0, migration.stderr);
      const index = validateRunsDir(bundle.runsDir);
      for (const evidence of data.source.completed_task_evidence) {
        const runEntry = index.runs.find((entry) => entry.runId === evidence.run_id);
        assert.ok(runEntry);
        evidence.run_ref = `runs/${runEntry.runRef}`;
      }
      writeFileSync(bundle.reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

      assert.deepEqual(validateMilestoneReview(bundle.reviewPath), data);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects graph-mode run identity even when it resolves to the milestone task graph', () => {
    const data = midpointReview();
    const bundle = writeBundle(data);
    try {
      const evidence = data.source.completed_task_evidence[0];
      const legacyRun = bundle.runs[0];
      legacyRun.sourceLayout = 'graph';
      legacyRun.taskGraphRef = bundle.graphPath;
      evidence.run_snapshot = structuredClone(legacyRun);
      evidence.run_snapshot_sha256 = milestoneRunSnapshotSha256(evidence.run_snapshot);
      const runPath = path.join(bundle.runsDir, `${legacyRun.runId}.json`);
      writeFileSync(runPath, `${JSON.stringify(legacyRun, null, 2)}\n`, 'utf8');
      evidence.run_sha256 = rawFileSha256(runPath);
      writeRunIndex(bundle.runsDir, bundle.runs);
      writeFileSync(bundle.reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

      assert.throws(
        () => validateMilestoneReview(bundle.reviewPath),
        /has no successful finished run in the milestone task-graph context/,
      );
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects a draft when the current run no longer exactly matches its run snapshot', () => {
    const data = midpointReview();
    const bundle = writeBundle(data);
    try {
      const supplementedRun = bundle.runs[0];
      supplementedRun.changedFiles.push('src/supplemented.mjs');
      supplementedRun.updatedAt = '2026-07-11T00:11:01.000Z';
      const runPath = path.join(bundle.runsDir, `${supplementedRun.runId}.json`);
      writeFileSync(runPath, `${JSON.stringify(supplementedRun, null, 2)}\n`, 'utf8');
      writeRunIndex(bundle.runsDir, bundle.runs);

      data.source.completed_task_evidence[0].run_sha256 = rawFileSha256(runPath);
      writeFileSync(bundle.reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      assert.throws(
        () => validateMilestoneReview(bundle.reviewPath),
        /run_snapshot must exactly match .* for draft validation/,
      );
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects canonical validation when current run identity or context drifts', () => {
    const data = midpointReview();
    const bundle = writeBundle(data, 'midpoint.json');
    try {
      const changedRun = bundle.runs[0];
      changedRun.taskTitle = 'Different task identity';
      writeFileSync(
        path.join(bundle.runsDir, `${changedRun.runId}.json`),
        `${JSON.stringify(changedRun, null, 2)}\n`,
        'utf8',
      );
      assert.throws(
        () => validateMilestoneReview(bundle.reviewPath),
        /run taskTitle must match run_snapshot immutable context/,
      );
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('runtime CLI accepts a complete pre-close snapshot', () => {
    const data = midpointReview();
    data.checkpoint = 'pre_close';
    data.source.task_graph_snapshot = taskGraph(['done', 'done']);
    data.source.task_graph_snapshot_sha256 = milestoneSnapshotSha256(data.source.task_graph_snapshot);
    data.source.task_counts = { total: 2, done: 2, todo: 0, in_progress: 0, blocked: 0 };
    data.source.task_snapshot = data.source.task_graph_snapshot.tasks.map((item) => ({
      task_id: item.id,
      task_title: item.title,
      status: item.status,
    }));
    data.source.remaining_task_ids = [];
    data.planned_todo_not_findings = [];
    const bundle = writeBundle(data, 'pre_close.json');
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'validate_artifacts.mjs'), '--milestone-review', bundle.reviewPath],
        { cwd: ROOT, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Plan2Agent artifact validation passed/);
    } finally {
      rmSync(bundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects task graph hash, snapshot, or immutable structure drift', () => {
    const hashData = midpointReview();
    const hashBundle = writeBundle(hashData);
    try {
      hashData.source.task_graph_sha256 = '0'.repeat(64);
      writeFileSync(hashBundle.reviewPath, `${JSON.stringify(hashData, null, 2)}\n`, 'utf8');
      assert.throws(() => validateMilestoneReview(hashBundle.reviewPath), /task_graph_sha256 does not match/);
    } finally {
      rmSync(hashBundle.artifactRoot, { recursive: true, force: true });
    }

    const canonicalData = midpointReview();
    const canonicalBundle = writeBundle(canonicalData, 'midpoint.json');
    try {
      const changed = structuredClone(canonicalData.source.task_graph_snapshot);
      changed.tasks[0].title = 'Changed after checkpoint';
      writeFileSync(canonicalBundle.graphPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
      assert.throws(() => validateMilestoneReview(canonicalBundle.reviewPath), /structure differs/);
    } finally {
      rmSync(canonicalBundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects run hashes, finished time, changed files, and verification drift', () => {
    const mutations = [
      ['run_sha256', (evidence) => { evidence.run_sha256 = '0'.repeat(64); }, /run_sha256 does not match/],
      ['run_snapshot_sha256', (evidence) => { evidence.run_snapshot_sha256 = '0'.repeat(64); }, /run_snapshot_sha256 mismatch/],
      ['run_finished_at', (evidence) => { evidence.run_finished_at = '2026-07-11T00:09:00.000Z'; }, /run_snapshot finishedAt must be/],
      ['changed_files', (evidence) => { evidence.changed_files = ['src/not-the-run-file.mjs']; }, /changed_files must exactly match/],
      ['verification', (evidence) => { evidence.verification[0].command = 'node --test different'; }, /verification must exactly match/],
    ];
    for (const [label, mutate, expected] of mutations) {
      const data = midpointReview();
      const bundle = writeBundle(data);
      try {
        mutate(data.source.completed_task_evidence[0]);
        writeFileSync(bundle.reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        assert.throws(() => validateMilestoneReview(bundle.reviewPath), expected, label);
      } finally {
        rmSync(bundle.artifactRoot, { recursive: true, force: true });
      }
    }
  });

  test('requires the latest successful finished run as of generated_at', () => {
    const beforeData = midpointReview();
    const beforeBundle = writeBundle(beforeData);
    try {
      const evidence = beforeData.source.completed_task_evidence[0];
      addRun(beforeBundle, fullRun(evidence, {
        runId: 'run-task-001-newer',
        finishedAt: '2026-07-11T00:09:00.000Z',
      }));
      assert.throws(() => validateMilestoneReview(beforeBundle.reviewPath), /latest successful finished run run-task-001-newer/);
    } finally {
      rmSync(beforeBundle.artifactRoot, { recursive: true, force: true });
    }

    const afterData = midpointReview();
    const afterBundle = writeBundle(afterData);
    try {
      const afterGenerated = fullRun(afterData.source.completed_task_evidence[0], {
        runId: 'run-task-001-after-review',
        finishedAt: '2026-07-11T00:11:00.000Z',
      });
      addRun(afterBundle, afterGenerated);
      assert.deepEqual(validateMilestoneReview(afterBundle.reviewPath), afterData);
    } finally {
      rmSync(afterBundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects project, task, iteration, and path traversal mismatches', () => {
    const cases = [
      ['project', (run) => { run.projectId = 'other-project'; }, /run-index projectId|run projectId/],
      ['task', (run) => { run.taskId = 'task-004'; }, /run-index|no successful finished run/],
      ['iteration', (run) => { run.iterationId = 'other-iteration'; }, /no successful finished run/],
    ];
    for (const [label, mutate, expected] of cases) {
      const data = midpointReview();
      const bundle = writeBundle(data);
      try {
        const run = bundle.runs[0];
        mutate(run);
        const runPath = path.join(bundle.runsDir, `${run.runId}.json`);
        writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
        data.source.completed_task_evidence[0].run_sha256 = rawFileSha256(runPath);
        writeFileSync(bundle.reviewPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        writeRunIndex(bundle.runsDir, bundle.runs);
        assert.throws(() => validateMilestoneReview(bundle.reviewPath), expected, label);
      } finally {
        rmSync(bundle.artifactRoot, { recursive: true, force: true });
      }
    }

    const traversalData = midpointReview();
    const traversalBundle = writeBundle(traversalData);
    try {
      traversalData.source.task_graph_ref = '../task-graph.json';
      writeFileSync(traversalBundle.reviewPath, `${JSON.stringify(traversalData, null, 2)}\n`, 'utf8');
      assert.throws(() => validateMilestoneReview(traversalBundle.reviewPath), /artifact-root-relative|traverse/);
    } finally {
      rmSync(traversalBundle.artifactRoot, { recursive: true, force: true });
    }
  });

  test('rejects completed evidence without an executed passing check and cross-scope findings', () => {
    const verificationData = midpointReview();
    verificationData.source.completed_task_evidence[0].verification = [{
      type: 'test',
      command: 'node --test',
      status: 'skipped',
      exit_code: null,
      source: 'manual',
    }];
    const verificationEvidence = verificationData.source.completed_task_evidence[0];
    verificationEvidence.run_snapshot = fullRun(verificationEvidence);
    verificationEvidence.run_snapshot_sha256 = milestoneRunSnapshotSha256(verificationEvidence.run_snapshot);
    assert.throws(
      () => validateMilestoneReviewData(verificationData),
      (error) => error instanceof ValidationError && /executed config\/command check/.test(error.message),
    );

    const findingData = midpointReview();
    findingData.confirmed_findings[0].affected_completed_tasks = ['task-003'];
    assert.throws(() => validateMilestoneReviewData(findingData), /must reference completed task evidence/);
  });
});
