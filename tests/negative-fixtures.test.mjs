import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCaseShape,
  formatCommandResult,
  loadNegativeFixtureManifest,
  runValidator,
} from './helpers/fixtures.mjs';

const manifest = loadNegativeFixtureManifest();

describe('negative fixtures expected pass', () => {
  for (const caseData of manifest.expected_pass ?? []) {
    test(caseData.id, () => {
      assertCaseShape(caseData, 'expected_pass');
      const result = runValidator(caseData.args);
      assert.equal(result.status, 0, formatCommandResult(result));
    });
  }
});

describe('negative fixtures expected failure', () => {
  for (const caseData of manifest.expected_failure ?? []) {
    test(caseData.id, () => {
      assertCaseShape(caseData, 'expected_failure');
      assert.equal(typeof caseData.expected_message, 'string', `${caseData.id} must provide expected_message`);
      const result = runValidator(caseData.args);
      const output = formatCommandResult(result);
      assert.notEqual(result.status, 0, 'negative fixture expected failure but command passed');
      assert.match(output, new RegExp(caseData.expected_message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }
});

describe('invalid failed run negative fixture', () => {
  const now = '2026-06-19T00:00:00.000Z';
  const baseRun = {
    schema_version: 'p2a.run.v1',
    runId: 'run-invalid-failed-without-failure',
    projectId: 'fixture-project',
    taskId: 'task-001',
    taskTitle: 'Invalid failed run fixture',
    iterationId: 'v1-mvp',
    sourceLayout: 'iteration',
    taskGraphRef: 'iterations/v1-mvp/gate-c-task-graph/task-graph.json',
    sourceSpecRef: '../gate-b-spec/spec.json',
    agentTool: 'codex',
    workspaceRef: 'fixture-workspace',
    workspacePath: '.',
    isolation: { mode: 'none', branch: null, worktree: null, baseRef: null, created: false, createCommand: null, createExitCode: null, createOutputTail: null },
    status: 'failed',
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    changedFiles: [],
    verification: [],
    notes: [],
  };
  const indexFor = (id) => ({
    schema_version: 'p2a.run_index.v1',
    projectId: 'fixture-project',
    runs: [{
      runId: id,
      taskId: 'task-001',
      iterationId: 'v1-mvp',
      status: 'failed',
      agentTool: 'codex',
      workspaceRef: 'fixture-workspace',
      taskGraphRef: 'iterations/v1-mvp/gate-c-task-graph/task-graph.json',
      runRef: `${id}.json`,
      startedAt: now,
      finishedAt: now,
    }],
    tasks: [{ taskId: 'task-001', runIds: [id], latestRunId: id }],
  });

  function runCase(run, expectedMessage) {
    const runsDir = mkdtempSync(path.join(tmpdir(), 'p2a-invalid-runs-'));
    try {
      writeFileSync(path.join(runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(indexFor(run.runId), null, 2)}\n`, 'utf8');
      const result = runValidator(['--runs-dir', runsDir]);
      const output = formatCommandResult(result);
      assert.notEqual(result.status, 0, 'invalid failed run fixture was not rejected by validator');
      assert.match(output, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  }

  test('missing failure object is rejected', () => {
    runCase(baseRun, 'failed run must include failure');
  });

  test('missing structured detail is rejected', () => {
    runCase({
      ...baseRun,
      runId: 'run-invalid-failed-without-structured-detail',
      failure: { class: 'verification_failed', retryable: 'after_fix', needsUserDecision: false, source: 'owner' },
    }, 'missing required keys: reproduction, localization, guard');
  });

  test('empty structured detail is rejected', () => {
    runCase({
      ...baseRun,
      runId: 'run-invalid-failed-with-empty-structured-detail',
      failure: { class: 'verification_failed', retryable: 'after_fix', needsUserDecision: false, source: 'owner' },
      reproduction: { steps: [], commands: [], notes: [] },
      localization: { findings: [], files: [] },
      guard: { checks: [], notes: [] },
    }, 'failed run must include structured debug detail: reproduction, localization, guard');
  });
});
