import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'p2a.mjs');

function runP2a(args, { cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function runP2aJson(args, opts = {}) {
  const res = runP2a([...args, '--json'], opts);
  assert.equal(res.status, 0, `expected exit 0 for p2a ${args.join(' ')}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function makeTempProject({ withGit = true, testScript = 'node test.mjs' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2a-v1-test-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'sample-app', private: true, scripts: { test: testScript } }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 1;\n', 'utf8');
  writeFileSync(
    path.join(dir, 'test.mjs'),
    "import assert from 'node:assert/strict';\nimport { value } from './app.mjs';\nassert.equal(value, 1);\n",
    'utf8',
  );
  if (withGit) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'P2A Test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  }
  return dir;
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

test('p2a init creates only config.json + provider assets and zero auto-generated markdown', (t) => {
  const dir = makeTempProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const init = runP2aJson(['init', '--target', dir, '--tools', 'all']);
  assert.equal(init.config.schema_version, 'p2a.config.v1');
  assert.equal(init.config.verify.test, 'npm test');

  const p2aFiles = walkFiles(path.join(dir, '.plan2agent'));
  assert.deepEqual(p2aFiles, ['config.json']);

  const allFiles = walkFiles(dir);
  assert.equal(allFiles.includes('PLAN2AGENT.md'), false);
  assert.equal(allFiles.some((f) => f.startsWith('.plan2agent/') && f.endsWith('.md')), false);
  assert.equal(existsSync(path.join(dir, '.agents', 'skills', 'p2a-next', 'SKILL.md')), true);
  assert.equal(existsSync(path.join(dir, '.agents', 'skills', 'p2a-work', 'SKILL.md')), true);
  assert.equal(existsSync(path.join(dir, '.claude', 'settings.json')), true);

  const doctor = runP2aJson(['doctor', '--target', dir]);
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctor.errors, []);
});

test('p2a init detects cargo, go, and pytest verify commands when package.json is absent', (t) => {
  const cases = [
    ['Cargo.toml', '[package]\nname = "demo"\n', 'cargo test'],
    ['go.mod', 'module example.com/demo\n', 'go test ./...'],
    ['pyproject.toml', '[project]\nname = "demo"\n', 'pytest'],
  ];
  for (const [filename, content, expectedCmd] of cases) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'p2a-detect-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, filename), content, 'utf8');
    const init = runP2aJson(['init', '--target', dir, '--tools', 'none']);
    assert.equal(init.config.verify.test, expectedCmd);
    assert.deepEqual(init.installedFiles, ['.plan2agent/config.json']);
  }
});

test('full lifecycle: draft -> 1-time approval -> drift block -> verify freshness -> session resume -> done cleanup', (t) => {
  const dir = makeTempProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1. Uninitialized -> Initialized -> No work
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'uninitialized');
  runP2aJson(['init', '--target', dir, '--tools', 'none']);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'no_work');

  // 2. Start draft from --idea
  const draftNext = runP2aJson(['next', '--target', dir, '--idea', 'Update value to 2 and add helper']);
  assert.equal(draftNext.state, 'draft_needs_plan');
  assert.equal(existsSync(path.join(dir, '.plan2agent', 'work.json')), true);

  // Starting another idea while work.json exists does not overwrite active work
  const conflictNext = runP2aJson(['next', '--target', dir, '--idea', 'Another feature']);
  assert.equal(conflictNext.state, 'active_work_exists');
  assert.equal(conflictNext.work.goal, 'Update value to 2 and add helper');

  // 3. Add tasks with dependency T2 -> T1
  runP2aJson([
    'task', 'add', '--target', dir,
    '--title', 'Bump exported value to 2',
    '--accept', 'app.mjs exports value === 2',
    '--accept', 'npm test passes',
  ]);
  runP2aJson([
    'task', 'add', '--target', dir,
    '--title', 'Add doubleValue helper',
    '--depends', 'T1',
    '--accept', 'doubleValue(2) returns 4',
  ]);

  // Human output for draft_needs_approval lists ALL tasks including dependent T2
  const humanApproval = runP2a(['next', '--target', dir]);
  assert.equal(humanApproval.status, 0);
  assert.match(humanApproval.stdout, /T1:/);
  assert.match(humanApproval.stdout, /T2:.*T1/);

  const needsApproval = runP2aJson(['next', '--target', dir]);
  assert.equal(needsApproval.state, 'draft_needs_approval');
  assert.equal(needsApproval.action.requires_approval, true);

  // Cannot start or verify before approval
  assert.equal(runP2a(['task', 'start', 'T1', '--target', dir]).status, 1);
  assert.equal(runP2a(['verify', '--task', 'T1', '--target', dir]).status, 1);

  // 4. One-time unified approval
  const approved = runP2aJson(['approve', '--target', dir, '--quote', '이 계획대로 진행하자']);
  assert.equal(approved.approval.approved, true);
  assert.match(approved.approval.plan_sha256, /^[a-f0-9]{64}$/);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'ready_task');

  // 5. Plan drift detection (tampering with approved goal fails closed)
  const workFile = path.join(dir, '.plan2agent', 'work.json');
  const tampered = JSON.parse(readFileSync(workFile, 'utf8'));
  tampered.goal = 'Unapproved scope expansion';
  writeFileSync(workFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

  assert.equal(runP2aJson(['next', '--target', dir]).state, 'plan_drifted');
  assert.equal(runP2a(['task', 'start', 'T1', '--target', dir]).status, 1);

  // Re-approve updated plan
  runP2aJson(['approve', '--target', dir, '--quote', '수정된 목표 확인']);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'ready_task');

  // 6. Dependency enforcement: T2 cannot start before T1 is done
  assert.equal(runP2a(['task', 'start', 'T2', '--target', dir]).status, 1);

  // Start T1
  runP2aJson(['task', 'start', 'T1', '--target', dir, '--summary', 'Updating value to 2']);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'task_in_progress');

  // Cannot mark T1 done without verification
  assert.equal(runP2a(['task', 'done', 'T1', '--target', dir]).status, 1);

  // Edit code so test fails first
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 2;\n', 'utf8');
  const failedVerify = runP2a(['verify', '--task', 'T1', '--target', dir, '--json']);
  assert.equal(failedVerify.status, 1);
  const failedBody = JSON.parse(failedVerify.stdout);
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.verification.status, 'failed');
  assert.notEqual(failedBody.verification.exit_code, 0);
  assert.equal(runP2a(['task', 'done', 'T1', '--target', dir]).status, 1);

  // Fix test to expect 2 and verify
  writeFileSync(
    path.join(dir, 'test.mjs'),
    "import assert from 'node:assert/strict';\nimport { value } from './app.mjs';\nassert.equal(value, 2);\n",
    'utf8',
  );
  const passedVerify = runP2aJson(['verify', '--task', 'T1', '--target', dir]);
  assert.equal(passedVerify.ok, true);
  assert.equal(passedVerify.verification.status, 'passed');
  assert.equal(passedVerify.verification.exit_code, 0);
  assert.deepEqual(passedVerify.changedFiles, ['app.mjs', 'test.mjs']);
  assert.equal(passedVerify.changedFiles.some((f) => f.startsWith('.plan2agent')), false);

  // Adding a note to work.json must NOT invalidate code verification freshness
  runP2aJson(['task', 'note', 'T1', '--target', dir, '--note', 'Updated value and test', '--summary', 'T1 verified']);

  // Editing product code AFTER passing verification MUST invalidate freshness
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 2; // touched after verify\n', 'utf8');
  const staleDone = runP2a(['task', 'done', 'T1', '--target', dir]);
  assert.equal(staleDone.status, 1);
  assert.match(staleDone.stderr, /workspace changed after the last passing verification/);

  // Re-verify and complete T1
  runP2aJson(['verify', '--task', 'T1', '--target', dir]);
  runP2aJson(['task', 'done', 'T1', '--target', dir, '--summary', 'T1 done; T2 ready']);

  // 7. Session stop & resume simulation on T2
  runP2aJson(['task', 'start', 'T2', '--target', dir, '--summary', 'Starting doubleValue helper']);
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 2;\nexport const doubleValue = (n) => n * 3;\n', 'utf8');
  writeFileSync(
    path.join(dir, 'test.mjs'),
    "import assert from 'node:assert/strict';\nimport { value, doubleValue } from './app.mjs';\nassert.equal(value, 2);\nassert.equal(doubleValue(2), 4);\n",
    'utf8',
  );
  assert.equal(runP2a(['verify', '--task', 'T2', '--target', dir]).status, 1);
  runP2aJson([
    'task', 'note', 'T2', '--target', dir,
    '--note', 'doubleValue multiplied by 3 instead of 2',
    '--summary', 'Fix doubleValue multiplier in app.mjs and rerun p2a verify',
  ]);

  // Simulate brand new session calling `p2a next --json` with zero prior context
  const resumed = runP2aJson(['next', '--target', dir]);
  assert.equal(resumed.state, 'task_in_progress');
  assert.deepEqual(resumed.work.progress, { total: 2, done: 1, in_progress: 1, todo: 0, blocked: 0 });
  assert.equal(resumed.work.active_task.id, 'T2');
  assert.equal(resumed.work.active_task.verification.status, 'failed');
  assert.equal(resumed.work.active_task.notes.at(-1), 'doubleValue multiplied by 3 instead of 2');
  assert.equal(resumed.work.resume.summary, 'Fix doubleValue multiplier in app.mjs and rerun p2a verify');

  // Block and unblock flow
  runP2aJson(['task', 'block', 'T2', '--target', dir, '--reason', 'Waiting on confirmation']);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'tasks_blocked');
  runP2aJson(['task', 'unblock', 'T2', '--target', dir]);
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'ready_task');
  runP2aJson(['task', 'start', 'T2', '--target', dir]);

  // Fix T2, verify, complete
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 2;\nexport const doubleValue = (n) => n * 2;\n', 'utf8');
  runP2aJson(['verify', '--task', 'T2', '--target', dir]);
  runP2aJson(['task', 'done', 'T2', '--target', dir, '--summary', 'All tasks complete']);

  // 8. Ready to finish -> p2a done removes work.json
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'ready_to_finish');
  const finished = runP2aJson(['done', '--target', dir]);
  assert.equal(finished.cleared, true);
  assert.equal(finished.aborted, false);
  assert.equal(existsSync(workFile), false);
  assert.deepEqual(walkFiles(path.join(dir, '.plan2agent')), ['config.json']);

  // Immediately ready for next development item
  assert.equal(runP2aJson(['next', '--target', dir]).state, 'no_work');
  const nextFeature = runP2aJson(['next', '--target', dir, '--idea', 'Next independent task']);
  assert.equal(nextFeature.state, 'draft_needs_plan');

  // Abort clears incomplete draft cleanly
  const aborted = runP2aJson(['done', '--abort', '--target', dir]);
  assert.equal(aborted.cleared, true);
  assert.equal(aborted.aborted, true);
  assert.equal(existsSync(workFile), false);
});

test('entry file intake, DAG cycle rejection, and validate/doctor error reporting', (t) => {
  const dir = makeTempProject({ withGit: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runP2aJson(['init', '--target', dir, '--tools', 'none']);
  const notePath = path.join(dir, 'request.md');
  writeFileSync(notePath, '# Build CLI status formatter\n\nKeep output concise.\n', 'utf8');

  const draft = runP2aJson(['next', '--target', dir, '--entry', 'request.md']);
  assert.equal(draft.state, 'draft_needs_plan');
  assert.equal(draft.work.goal, 'Build CLI status formatter');

  // Unknown dependency rejected
  assert.equal(
    runP2a(['task', 'add', '--target', dir, '--id', 'T1', '--title', 'First', '--accept', 'works', '--depends', 'T99']).status,
    1,
  );

  // Add valid T1 then corrupt work.json with a cycle to confirm fail-closed validation
  runP2aJson(['task', 'add', '--target', dir, '--id', 'T1', '--title', 'First', '--accept', 'works']);
  assert.equal(runP2aJson(['validate', '--target', dir]).valid, true);

  const workFile = path.join(dir, '.plan2agent', 'work.json');
  const work = JSON.parse(readFileSync(workFile, 'utf8'));
  work.tasks.push({
    id: 'T2',
    title: 'Cycle node',
    status: 'todo',
    depends_on: ['T1'],
    acceptance: ['cycles rejected'],
    verification: null,
    changed_files: [],
    notes: [],
  });
  work.tasks[0].depends_on = ['T2'];
  writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`, 'utf8');

  assert.equal(runP2aJson(['next', '--target', dir]).state, 'invalid_work');
  assert.equal(runP2a(['validate', '--target', dir]).status, 1);
  const doctor = runP2a(['doctor', '--target', dir, '--json']);
  assert.equal(doctor.status, 1);
  assert.match(JSON.parse(doctor.stdout).errors.join('\n'), /cycle/i);
});

test('edge cases: monorepo subdirectory + Unicode filenames, dependency bypass on done, re-init options, and subcommand --help', (t) => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'p2a-monorepo-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const pkgDir = path.join(repoRoot, 'packages', 'api');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'api', private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
    'utf8',
  );
  writeFileSync(path.join(pkgDir, '기능.mjs'), 'export const v = 1;\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'P2A Test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init monorepo'], { cwd: repoRoot });

  // 1. Re-init preserves existing tools when --tools is omitted, and applies --project-id
  const firstInit = runP2aJson(['init', '--target', pkgDir, '--tools', 'claude', '--project-id', 'api-v1']);
  assert.deepEqual(firstInit.config.tools, ['claude']);
  assert.equal(firstInit.config.project_id, 'api-v1');

  const reInit = runP2aJson(['init', '--target', pkgDir, '--project-id', 'api-v2']);
  assert.deepEqual(reInit.config.tools, ['claude']);
  assert.equal(reInit.config.project_id, 'api-v2');
  assert.equal(runP2a(['init', '--target', pkgDir, '--project-id', '!!!']).status, 1);

  // 2. Subcommand --help works cleanly
  const taskHelp = runP2a(['task', 'start', '--help']);
  assert.equal(taskHelp.status, 0);
  assert.match(taskHelp.stdout, /p2a task start/);

  // 3. Monorepo subdirectory + Unicode filename freshness detection & dependency bypass prevention
  runP2aJson(['next', '--target', pkgDir, '--idea', 'Update Korean-named module']);
  runP2aJson(['task', 'add', '--target', pkgDir, '--title', 'First', '--accept', 'ok']);
  runP2aJson(['task', 'add', '--target', pkgDir, '--title', 'Second', '--depends', 'T1', '--accept', 'ok']);
  runP2aJson(['approve', '--target', pkgDir, '--quote', '진행하자']);

  // Cannot bypass T1 dependency by verifying T2 directly and running `task done T2`
  runP2aJson(['verify', '--task', 'T2', '--target', pkgDir]);
  const bypassDone = runP2a(['task', 'done', 'T2', '--target', pkgDir]);
  assert.equal(bypassDone.status, 1);
  assert.match(bypassDone.stderr, /dependencies remain incomplete: T1/);

  // Modify Korean-named file inside monorepo subdir, verify, then modify again -> must detect stale fingerprint!
  runP2aJson(['task', 'start', 'T1', '--target', pkgDir]);
  writeFileSync(path.join(pkgDir, '기능.mjs'), 'export const v = 2;\n', 'utf8');
  const v1 = runP2aJson(['verify', '--task', 'T1', '--target', pkgDir]);
  assert.equal(v1.changedFiles.includes('packages/api/기능.mjs'), true);
  assert.equal(v1.changedFiles.some((f) => f.includes('.plan2agent')), false);

  // Updating work.json notes must NOT invalidate verification
  runP2aJson(['task', 'note', 'T1', '--target', pkgDir, '--note', 'still fresh']);

  // Touching the Korean-named file AFTER verify MUST invalidate freshness even in monorepo subdir
  writeFileSync(path.join(pkgDir, '기능.mjs'), 'export const v = 3;\n', 'utf8');
  const stale = runP2a(['task', 'done', 'T1', '--target', pkgDir]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /workspace changed after the last passing verification/);

  // Re-verify and complete T1
  runP2aJson(['verify', '--task', 'T1', '--target', pkgDir]);
  runP2aJson(['task', 'done', 'T1', '--target', pkgDir]);

  // Malformed config.json handled cleanly by `next` and `validate`, and recovered by `init --force`
  writeFileSync(path.join(pkgDir, '.plan2agent', 'config.json'), '{broken json', 'utf8');
  assert.equal(runP2aJson(['next', '--target', pkgDir]).state, 'invalid_config');
  const badVal = runP2a(['validate', '--target', pkgDir]);
  assert.equal(badVal.status, 1);
  assert.match(badVal.stderr, /invalid \.plan2agent\/config\.json/);
  const recovered = runP2aJson(['init', '--target', pkgDir, '--tools', 'none', '--force']);
  assert.equal(recovered.config.schema_version, 'p2a.config.v1');
});

test('next includes scope/constraints, respects active_task_id under --allow-parallel, and verify preserves custom resume.summary', (t) => {
  const dir = makeTempProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runP2aJson(['init', '--target', dir, '--tools', 'none']);
  runP2aJson(['next', '--target', dir, '--idea', 'Parallel work check']);

  const workFile = path.join(dir, '.plan2agent', 'work.json');
  const draft = JSON.parse(readFileSync(workFile, 'utf8'));
  draft.scope = ['app.mjs'];
  draft.non_goals = ['unrelated CLI'];
  draft.constraints = ['keep zero deps'];
  writeFileSync(workFile, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  runP2aJson(['task', 'add', '--target', dir, '--title', 'Task A', '--accept', 'A passes']);
  runP2aJson(['task', 'add', '--target', dir, '--title', 'Task B', '--accept', 'B passes']);

  const approvalNext = runP2aJson(['next', '--target', dir]);
  assert.equal(approvalNext.state, 'draft_needs_approval');
  assert.deepEqual(approvalNext.work.scope, ['app.mjs']);
  assert.deepEqual(approvalNext.work.non_goals, ['unrelated CLI']);
  assert.deepEqual(approvalNext.work.constraints, ['keep zero deps']);

  const humanApproval = runP2a(['next', '--target', dir]);
  assert.match(humanApproval.stdout, /범위: app\.mjs/);
  assert.match(humanApproval.stdout, /제외: unrelated CLI/);
  assert.match(humanApproval.stdout, /제약: keep zero deps/);

  runP2aJson(['approve', '--target', dir, '--quote', '진행하자']);
  runP2aJson(['task', 'start', 'T1', '--target', dir, '--summary', 'Working on T1']);
  runP2aJson(['task', 'start', 'T2', '--target', dir, '--allow-parallel', '--summary', 'Custom resume handoff for T2']);

  // `p2a next` should pick active_task_id (T2), not just first in_progress (T1)
  const parallelNext = runP2aJson(['next', '--target', dir]);
  assert.equal(parallelNext.state, 'task_in_progress');
  assert.equal(parallelNext.work.active_task.id, 'T2');

  // Failing verification must NOT clobber existing custom resume.summary
  const failed = runP2a(['verify', '--task', 'T2', '--cmd', 'node -e "process.exit(1)"', '--target', dir, '--json']);
  assert.equal(failed.status, 1);
  const afterFail = runP2aJson(['next', '--target', dir]);
  assert.equal(afterFail.work.resume.summary, 'Custom resume handoff for T2');
  assert.equal(afterFail.work.active_task.verification.status, 'failed');
});

test('hardening: p2a done freshness, reopen on failed re-verify, block guards, malformed settings fail-closed, and validation invariants', (t) => {
  const dir = makeTempProject();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Malformed .claude/settings.json must fail closed (not get silently overwritten)
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(dir, '.claude', 'settings.json'), '{not valid json', 'utf8');
  assert.equal(runP2a(['init', '--target', dir, '--tools', 'claude']).status, 1);
  assert.equal(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{not valid json');

  // Remove broken settings, test case-insensitive --tools and empty rejection
  unlinkSync(path.join(dir, '.claude', 'settings.json'));
  assert.equal(runP2a(['init', '--target', dir, '--tools', '']).status, 1);
  assert.equal(runP2a(['init', '--target', dir, '--tools', ',,,']).status, 1);
  runP2aJson(['init', '--target', dir, '--tools', 'CLAUDE']);

  // Removing hook registration from .claude/settings.json triggers doctor warning
  writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}\n', 'utf8');
  const docWarn = runP2aJson(['doctor', '--target', dir]);
  assert.equal(docWarn.warnings.some((w) => w.includes('.claude/settings.json')), true);
  runP2aJson(['init', '--target', dir, '--tools', 'claude']);

  // Empty --idea rejected explicitly
  assert.equal(runP2a(['next', '--target', dir, '--idea', '   ']).status, 1);

  runP2aJson(['next', '--target', dir, '--idea', 'Verify hardening']);
  runP2aJson(['task', 'add', '--target', dir, '--title', 'Only task', '--accept', 'passes']);

  // Cannot block unapproved draft task
  assert.equal(runP2a(['task', 'block', 'T1', '--target', dir, '--reason', 'too early']).status, 1);

  runP2aJson(['approve', '--target', dir, '--quote', '진행하자']);
  runP2aJson(['task', 'start', 'T1', '--target', dir]);
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 1; // clean\n', 'utf8');
  runP2aJson(['verify', '--task', 'T1', '--target', dir]);
  runP2aJson(['task', 'done', 'T1', '--target', dir]);

  // Cannot block already-done task
  assert.equal(runP2a(['task', 'block', 'T1', '--target', dir, '--reason', 'late']).status, 1);

  // Editing code AFTER `task done` must block `p2a done` while workspace is dirty
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 999;\n', 'utf8');
  const dirtyDone = runP2a(['done', '--target', dir]);
  assert.equal(dirtyDone.status, 1);
  assert.match(dirtyDone.stderr, /unverified changes/);

  // Re-verifying a `done` task that now fails reopens it to `in_progress` (no ready_to_finish deadlock)
  const reFail = runP2a(['verify', '--task', 'T1', '--target', dir, '--json']);
  assert.equal(reFail.status, 1);
  const reopened = runP2aJson(['next', '--target', dir]);
  assert.equal(reopened.state, 'task_in_progress');
  assert.equal(reopened.work.active_task.id, 'T1');

  // Fix, verify, complete, then commit cleanly -> `p2a done` succeeds on clean committed tree!
  writeFileSync(path.join(dir, 'app.mjs'), 'export const value = 1; // verified\n', 'utf8');
  runP2aJson(['verify', '--task', 'T1', '--target', dir]);
  runP2aJson(['task', 'done', 'T1', '--target', dir]);
  execFileSync('git', ['add', 'app.mjs', '.claude'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'verified change'], { cwd: dir });
  const committedDone = runP2aJson(['done', '--target', dir]);
  assert.equal(committedDone.cleared, true);

  // Contradictory verification or corrupted work.json with --idea returns invalid_work
  runP2aJson(['next', '--target', dir, '--idea', 'Corruption check']);
  const workFile = path.join(dir, '.plan2agent', 'work.json');
  writeFileSync(workFile, '{broken', 'utf8');
  assert.equal(runP2aJson(['next', '--target', dir, '--idea', 'New idea']).state, 'invalid_work');

  // Symlink target mutation after verify changes fingerprint
  unlinkSync(workFile);
  mkdirSync(workFile);
  const dirWorkDoctor = runP2a(['doctor', '--target', dir, '--json']);
  assert.equal(dirWorkDoctor.status, 1);
  assert.match(JSON.parse(dirWorkDoctor.stdout).errors.join('\n'), /not a regular file/);
  rmSync(workFile, { recursive: true, force: true });

  runP2aJson(['next', '--target', dir, '--idea', 'Symlink fingerprint check']);
  runP2aJson(['task', 'add', '--target', dir, '--title', 'Link task', '--accept', 'ok']);
  runP2aJson(['approve', '--target', dir, '--quote', 'ok']);
  runP2aJson(['task', 'start', 'T1', '--target', dir]);
  try {
    symlinkSync('app.mjs', path.join(dir, 'active-link'));
    runP2aJson(['verify', '--task', 'T1', '--target', dir]);
    unlinkSync(path.join(dir, 'active-link'));
    symlinkSync('test.mjs', path.join(dir, 'active-link'));
    const retargeted = runP2a(['task', 'done', 'T1', '--target', dir]);
    assert.equal(retargeted.status, 1);
    assert.match(retargeted.stderr, /workspace changed after the last passing verification/);
  } catch (error) {
    if (!(process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;
  }
});
