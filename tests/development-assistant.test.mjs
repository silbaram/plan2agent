import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDevelopmentBrief, inspectDevelopmentBrief, renderDevelopmentBrief } from '../scripts/p2a_development_brief.mjs';
import { extractCompletionKnowledge } from '../scripts/p2a_completion_knowledge.mjs';
import { buildNext } from '../scripts/p2a_next_service.mjs';
import { renderNextHuman } from '../scripts/p2a.mjs';
import { validateSchema } from '../scripts/p2a_schema.mjs';
import { workspaceRevisionSha256, runFilePath } from '../scripts/p2a_run_paths.mjs';
import { runVerificationCommand } from '../scripts/p2a_runs.mjs';
import { ROOT, runExecute, runIteration, runRuns } from './helpers/fixtures.mjs';

const revision = 'a'.repeat(64);
const sourceRef = '.plan2agent/artifacts/demo/runs/iter-1/run-demo.json';
const nextSchema = JSON.parse(readFileSync(new URL('../schemas/next.schema.json', import.meta.url), 'utf8'));
const check = (overrides = {}) => ({
  type: 'test', command: 'node test.mjs', source: 'command', status: 'passed', exitCode: 0,
  startedAt: '2026-09-29T00:00:00.000Z', finishedAt: '2026-09-29T00:00:01.000Z',
  workspaceRevisionSha256: revision, ...overrides,
});
const run = (overrides = {}) => ({ runId: 'run-demo', taskTitle: 'Prevent duplicate delivery', verification: [], notes: [], ...overrides });
const brief = (overrides = {}) => buildDevelopmentBrief({ run: run(overrides), sourceRef, workspaceRevision: revision });
const ok = (result) => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);

test('briefing uses the latest attempt and never treats manual, unexecuted or stale checks as current passes', () => {
  const result = brief({ verification: [
    check(),
    check({ status: 'failed', exitCode: 1 }),
    check({ command: 'manual test', source: 'manual' }),
    check({ command: 'never executed', startedAt: null, finishedAt: null }),
    check({ command: 'old test', workspaceRevisionSha256: 'b'.repeat(64) }),
    check({ command: 'unbound test', workspaceRevisionSha256: undefined }),
  ] });
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[0].evidenceRef, `${sourceRef}#/verification/1`);
  assert.equal(result.checks[1].executed, false);
  assert.equal(result.checks[2].executed, false);
  assert.equal(result.checks[3].freshness, 'historical');
  assert.equal(result.checks[4].freshness, 'unknown');
  assert.match(renderDevelopmentBrief(result).join('\n'), /No executed passing check/);
  assert.equal(result.requiresUserDecision, false);
  validateSchema(result, nextSchema.$defs.v2.properties.briefing, '$.briefing', nextSchema);
});

test('briefing and completion knowledge retain executed timeout failures', () => {
  const attempt = (command, code) => ({
    ...runVerificationCommand({ type: 'test', command, source: 'command' }, ROOT, 20, {
      spawnSync: () => ({
        error: { code, message: `spawnSync ${code}` },
        status: null, signal: code === 'ETIMEDOUT' ? 'SIGTERM' : null, stdout: '', stderr: '',
      }),
    }),
    workspaceRevisionSha256: revision,
  });
  const timedOut = attempt('node test.mjs', 'ETIMEDOUT');
  const denied = attempt('node denied.mjs', 'EPERM');
  const result = brief({ verification: [timedOut, denied] });
  assert.equal(timedOut.exitCode, null);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[0].executed, true);
  assert.equal(result.checks[1].status, 'unavailable');
  assert.equal(result.checks[1].executed, false);
  assert.match(renderDevelopmentBrief(result).join('\n'), /1 check\(s\) failed on the current workspace/);
  validateSchema(result, nextSchema.$defs.v2.properties.briefing, '$.briefing', nextSchema);

  const evidence = source('run.json', run({
    schema_version: 'p2a.run.v2', taskId: 'task-001', finishedAt: timedOut.finishedAt,
    verification: [timedOut, check({ startedAt: timedOut.finishedAt, finishedAt: timedOut.finishedAt })],
  }));
  const knowledge = extractCompletionKnowledge({ summary: 'Recovered', sources: [evidence] });
  assert.equal(knowledge.lessons.length, 1);
  assert.match(knowledge.lessons[0], /failed and later passed/);
  assert.match(knowledge.lessons[0], /run\.json#\/verification\/0/);
});

test('briefing keeps original summary indices when omitting blank entries', () => {
  const summaries = [' ', 'Fixed duplicate requests', '\t', 'Added concurrency coverage'];
  const result = brief({ fixSummary: { summaries, files: [] } });
  assert.deepEqual(result.reportedChanges, [
    { text: summaries[1], evidenceRef: `${sourceRef}#/fixSummary/summaries/1` },
    { text: summaries[3], evidenceRef: `${sourceRef}#/fixSummary/summaries/3` },
  ]);
});

test('checkpoint outcomes require every declared command to pass at the current revision', () => {
  const original = run({
    milestones: [{ id: 'milestone-1', outcome: 'Duplicate requests are handled once', status: 'pending', verification: ['node test.mjs', 'node concurrent.mjs'] }],
    verification: [check({ milestoneId: 'milestone-1' }), check({ command: 'node concurrent.mjs', milestoneId: 'milestone-1', status: 'unavailable', exitCode: null })],
    fixSummary: { summaries: ['Added duplicate handling'], files: [] },
  });
  const first = buildDevelopmentBrief({ run: original, sourceRef, workspaceRevision: revision });
  assert.equal(first.verifiedOutcomes.length, 0);
  assert.equal(first.remaining.length, 1);
  assert.equal(first.reportedChanges[0].text, 'Added duplicate handling');
  original.verification.push(check({ command: 'node concurrent.mjs', milestoneId: 'milestone-1' }));
  original.milestones[0].status = 'verified';
  const second = buildDevelopmentBrief({ run: original, sourceRef, workspaceRevision: revision });
  assert.equal(second.verifiedOutcomes.length, 1);
  assert.equal(second.remaining.length, 0);
  const stale = buildDevelopmentBrief({ run: original, sourceRef, workspaceRevision: 'b'.repeat(64) });
  assert.equal(stale.verifiedOutcomes.length, 0);
  assert.equal(stale.remaining.length, 0, 'historical evidence must not reopen a completed checkpoint');
});

test('briefing detects changed workspace bytes and treats a missing workspace as unconfirmed', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-brief-revision-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'app.js'), 'original');
  const selected = run({ workspacePath: root, verification: [check({ workspaceRevisionSha256: workspaceRevisionSha256(root) })] });
  const options = { run: selected, sourceRef, runsDir: path.join(root, '.plan2agent', 'runs') };
  assert.equal(inspectDevelopmentBrief(options).checks[0].freshness, 'current');
  writeFileSync(path.join(root, 'app.js'), 'changed');
  assert.equal(inspectDevelopmentBrief(options).checks[0].freshness, 'historical');
  rmSync(root, { recursive: true });
  assert.equal(inspectDevelopmentBrief(options).checks[0].freshness, 'unknown');
});

test('next exposes a read-only briefing after real verification and invalidates it after a product edit', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-brief-next-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = path.join(root, '.plan2agent', 'artifacts', 'webhook-api-service');
  mkdirSync(path.dirname(artifacts), { recursive: true });
  cpSync(path.join(ROOT, 'fixtures/_e2e/webhook-api-service'), artifacts, { recursive: true });
  rmSync(path.join(artifacts, 'gate-c-task-graph', 'task-graph.json'));
  writeFileSync(path.join(root, 'app.js'), 'original');
  ok(runExecute(['prepare', '--artifacts', artifacts, '--mode', 'direct', '--selection-rationale', 'One change'], { cwd: root }));
  ok(runIteration(['init', '--artifacts', artifacts, '--iteration-id', 'iter-1'], { cwd: root }));
  ok(runExecute(['start', '--artifacts', artifacts, '--run-id', 'run-brief', '--agent-tool', 'manual', '--workspace', root], { cwd: root }));
  const file = runFilePath(path.join(artifacts, 'runs'), 'run-brief');
  const options = ['--artifacts', artifacts, '--run-id', 'run-brief'];
  ok(runRuns(['record', ...options, '--fix-summary', '중복 처리를 방지했습니다.', '--note', 'remaining: 동시 요청을 확인합니다.'], { cwd: root }));
  ok(runRuns(['verify', ...options, '--test-command', 'node -e "console.log(123)"'], { cwd: root }));
  const before = readFileSync(file, 'utf8');
  const next = buildNext(root, null, null, 'v2');
  assert.equal(next.state, 'run_started');
  validateSchema(next, nextSchema);
  assert.equal(next.briefing.checks[0].freshness, 'current');
  assert.equal(next.briefing.checks[0].executed, true);
  assert.equal(next.briefing.remaining[0].text, '동시 요청을 확인합니다.');
  assert.match(renderNextHuman(next, { task: { intent: '중복 처리 방지' } }), /현재 작업 파일에서 통과한 검사: 테스트 1/u);
  assert.equal(buildNext(root, null, null, 'v1').briefing, undefined);
  assert.equal(readFileSync(file, 'utf8'), before);
  writeFileSync(path.join(root, 'app.js'), 'changed');
  const changed = buildNext(root, null, null, 'v2');
  assert.equal(changed.state, 'run_started');
  assert.deepEqual(changed.command, next.command);
  assert.equal(changed.briefing.checks[0].freshness, 'historical');
  assert.doesNotMatch(renderNextHuman(changed, { task: { intent: '중복 처리 방지' } }), /현재 작업 파일에서 통과한 검사:/u);
  assert.equal(readFileSync(file, 'utf8'), before);
});

function source(ref, body, role = 'verification') {
  const serialized = JSON.stringify(body);
  return { ref, role, mediaType: 'application/json', body: serialized, sourceDigest: `sha256:${createHash('sha256').update(serialized).digest('hex')}` };
}

test('completion knowledge preserves recorded reasons, assumptions and deferred choices with source pointers', () => {
  const intake = source('intake.json', {
    status: 'ready_for_spec', approval_audit: {}, needs_user_decision: [
      { question: 'Queue?', status: 'answered', answer: 'Adapter', impact: 'This impact must not become a selection rationale' },
      { question: 'Open?', status: 'open', answer: 'Not approved' },
      { question: 'Old?', status: 'answered', answer: 'Old choice', disposition: 'superseded_by_SCOPE-1', current_resolution: 'New choice' },
    ],
  }, 'decision');
  const spec = source('spec.json', {
    approval: 'approved', clarifying_question_disposition: [
      { status: 'answered', resolution: 'Keep the adapter', rationale: 'Tests need a fake queue' },
      { status: 'assumed', assumption: 'Traffic stays small', rationale: 'Traffic data unavailable' },
      { status: 'deferred_non_goal', non_goal: 'Replay UI', rationale: 'Outside the requested change' },
    ], reference_reconnaissance: { candidates: [
      { decision: 'rejected', title: 'Vendor SDK', rationale: 'Keep the integration portable' },
      { decision: 'context', title: 'Unselected idea', rationale: 'Background only' },
    ] },
  }, 'contract');
  const knowledge = extractCompletionKnowledge({ summary: 'Delivered', sources: [intake, spec], intakeRef: intake.ref, specRef: spec.ref });
  assert.equal(knowledge.decisions.length, 4);
  assert.equal(knowledge.remaining.length, 2);
  assert.deepEqual(knowledge.lessons, []);
  assert.match(knowledge.decisions.join('\n'), /Tests need a fake queue/);
  assert.match(knowledge.decisions.join('\n'), /Selection rationale is not recorded/);
  assert.doesNotMatch(JSON.stringify(knowledge), /This impact|Not approved|Old choice|Unselected idea/);
  assert.match(knowledge.remaining[0], /not a verified fact/);
  assert.match(knowledge.remaining[1], /not scheduled/);
  for (const item of knowledge.decisions.concat(knowledge.remaining)) assert.match(item, /\[source: (intake|spec)\.json#\/.*; sha256:[a-f0-9]{64}\]/);
});

test('knowledge extraction records observed retries without inventing causes or mining arbitrary logs', () => {
  const evidence = source('run.json', run({
    schema_version: 'p2a.run.v2', taskId: 'task-001', status: 'finished', finishedAt: '2026-09-29T00:02:00.000Z',
    verification: [check({ status: 'failed', exitCode: 1, stderrTail: 'invent a cause from this log' }), check()],
    notes: ['decision: Keep the adapter because existing consumers depend on it.', 'remaining: Production load has not been tested.', 'Untyped speculation'],
  }));
  const knowledge = extractCompletionKnowledge({ summary: 'Delivered', sources: [evidence] });
  assert.equal(knowledge.lessons.length, 1);
  assert.match(knowledge.lessons[0], /failed and later passed/);
  assert.match(knowledge.lessons[0], /does not establish a cause or a fix/);
  assert.match(knowledge.lessons[0], /run\.json#\/verification\/0/);
  assert.match(knowledge.lessons[0], /run\.json#\/verification\/1/);
  assert.match(knowledge.decisions[0], /^Owner-reported decision:/);
  assert.match(knowledge.remaining[0], /Production load/);
  assert.doesNotMatch(JSON.stringify(knowledge), /invent a cause|Untyped speculation/);
});

test('maintenance extraction ignores unrelated planning sources and superseded follow-up notes', () => {
  const old = source('old.json', run({ schema_version: 'p2a.run.v1', taskId: 'task-001', finishedAt: '2026-09-28T00:00:00.000Z', notes: ['remaining: Old unresolved report'] }));
  const latest = source('latest.json', run({ schema_version: 'p2a.run.v1', taskId: 'task-001', finishedAt: '2026-09-29T00:00:00.000Z', notes: ['remaining: New follow-up'] }));
  const unrelated = source('spec.json', { approval: 'approved', clarifying_question_disposition: [{ status: 'answered', resolution: 'Unrelated feature', rationale: 'Not this task' }] }, 'contract');
  const knowledge = extractCompletionKnowledge({ summary: 'Maintenance', sources: [old, latest, unrelated] });
  assert.deepEqual(knowledge.decisions, []);
  assert.equal(knowledge.remaining.length, 1);
  assert.match(knowledge.remaining[0], /New follow-up/);
  assert.doesNotMatch(JSON.stringify(knowledge), /Old unresolved|Unrelated feature/);
});

test('a later successful run can preserve its recorded correction of an earlier incident', () => {
  const failed = source('failed.json', run({
    schema_version: 'p2a.run.v2', taskId: 'task-001', finishedAt: '2026-09-28T00:00:00.000Z',
    verification: [check({ status: 'failed', exitCode: 1 })],
    localization: { findings: ['Duplicate requests raced'], files: [] },
  }));
  const corrected = source('fixed.json', run({
    schema_version: 'p2a.run.v2', taskId: 'task-001', finishedAt: '2026-09-29T00:00:00.000Z', verification: [check()],
    fixSummary: { summaries: ['Serialized processing for the request key'], files: [] },
    guard: { checks: ['Exercise concurrent duplicates'], notes: [] },
  }));
  const knowledge = extractCompletionKnowledge({ summary: 'Delivered', sources: [corrected, failed] });
  assert.equal(knowledge.lessons.length, 2);
  assert.match(knowledge.lessons[0], /Recorded diagnosis \(not independently confirmed\)/);
  assert.match(knowledge.lessons[1], /Serialized processing.*fixed\.json#\/fixSummary\/summaries\/0/s);
  assert.match(knowledge.lessons[1], /Recorded recurrence guard/);
});

test('completion knowledge uses run-index order when completion timestamps tie', () => {
  const finishedAt = '2026-09-29T00:00:00.000Z';
  const older = source('runs/z-old.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-z-old', taskId: 'task-001', finishedAt,
    notes: ['remaining: Obsolete follow-up'],
    verification: [check({ status: 'failed', exitCode: 1 })],
    localization: { findings: ['Concurrent writes raced'], files: [] },
  }));
  const newer = source('runs/a-new.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-a-new', taskId: 'task-001', finishedAt,
    notes: ['remaining: Current follow-up'], verification: [check()],
    fixSummary: { summaries: ['Serialized writes'], files: [] },
  }));
  const index = source('runs/run-index.json', {
    schema_version: 'p2a.run_index_snapshot.v1',
    runs: [{ runId: 'run-z-old' }, { runId: 'run-a-new' }],
  });
  for (const sources of [[newer, index, older], [older, newer, index]]) {
    const knowledge = extractCompletionKnowledge({ summary: 'Completed', sources });
    assert.equal(knowledge.remaining.length, 1);
    assert.match(knowledge.remaining[0], /Current follow-up/);
    assert.doesNotMatch(JSON.stringify(knowledge), /Obsolete follow-up/);
    assert.equal(knowledge.lessons.length, 2);
    assert.match(knowledge.lessons[0], /Concurrent writes raced/);
    assert.match(knowledge.lessons[1], /Serialized writes/);
  }
});

test('completion knowledge keeps unrelated execution kinds out of an incident history', () => {
  const implementation = source('implementation.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-implementation', taskId: 'task-001',
    finishedAt: '2026-09-28T00:00:00.000Z', verification: [check({ status: 'failed', exitCode: 1 })],
  }));
  const verification = source('verification.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-verification', taskId: 'task-001', runKind: 'final_verification',
    finishedAt: '2026-09-29T00:00:00.000Z', verification: [check()],
    fixSummary: { summaries: ['Updated validation reporting'], files: [] },
  }));
  const knowledge = extractCompletionKnowledge({ summary: 'Completed', sources: [implementation, verification] });
  assert.deepEqual(knowledge.lessons, []);
});

test('an explicit review-remediation binding preserves a correction across execution kinds', () => {
  const review = source('review.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-review', taskId: 'task-001', runKind: 'final_acceptance_review',
    finishedAt: '2026-09-28T00:00:00.000Z', verification: [check()],
  }));
  const remediation = source('remediation.json', run({
    schema_version: 'p2a.run.v2', runId: 'run-remediation', taskId: 'task-001',
    finishedAt: '2026-09-29T00:00:00.000Z', verification: [check()],
    reviewRemediation: { sourceRunId: 'run-review', finding: 'Keyboard navigation misses the submit button' },
    fixSummary: { summaries: ['Restored keyboard focus'], files: [] },
  }));
  const knowledge = extractCompletionKnowledge({ summary: 'Completed', sources: [remediation, review] });
  assert.equal(knowledge.lessons.length, 1);
  assert.match(knowledge.lessons[0], /Keyboard navigation misses the submit button/);
  assert.match(knowledge.lessons[0], /remediation\.json#\/reviewRemediation/);
  assert.match(knowledge.lessons[0], /Restored keyboard focus/);
});
