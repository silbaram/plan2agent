import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILDLORE_HANDOFF_READ_MAX_BYTES,
  BUILDLORE_READ_MAX_BYTES,
  BUILDLORE_READ_TIMEOUT_MS,
  resolveBuildLoreInvocation,
  runBuildLore,
} from '../scripts/p2a_buildlore.mjs';
import { defaultCapabilityConfig } from '../scripts/p2a_project_config.mjs';

const GENERATION = `sha256:${'a'.repeat(64)}`;
const FIRST_ID = `sha256:${'b'.repeat(64)}`;
const SECOND_ID = `sha256:${'c'.repeat(64)}`;

function projectFixture(t, config = {}, manifest = {}) {
  const targetRoot = mkdtempSync(path.join(tmpdir(), 'p2a-buildlore-'));
  t.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const p2aRoot = path.join(targetRoot, '.plan2agent');
  mkdirSync(p2aRoot);
  writeFileSync(
    path.join(p2aRoot, 'project.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    path.join(p2aRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return targetRoot;
}

function connectFixture(targetRoot, connection = { projectId: 'demo-project' }) {
  const directory = path.join(targetRoot, '.buildlore');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'connection.json'), JSON.stringify(connection));
  writeFileSync(path.join(directory, 'sources.json'), JSON.stringify({ sources: [] }));
}

function fixtureSnapshot(targetRoot) {
  const entries = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      entries.push([path.relative(targetRoot, absolute), entry.isDirectory() ? 'directory' : readFileSync(absolute).toString('base64')]);
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(targetRoot);
  return entries;
}

function childFixture(t, script) {
  const targetRoot = projectFixture(t, {
    projectId: 'demo-project',
    buildlore: {
      command: process.execPath,
      commandArgs: ['--input-type=module', '-e', script, '--'],
    },
  });
  connectFixture(targetRoot);
  writeFileSync(path.join(targetRoot, '.plan2agent', 'decisions.jsonl'), '{"untouched":"decision-ledger"}\n');
  writeFileSync(path.join(targetRoot, '.plan2agent', 'state.json'), '{"untouched":"active-work"}\n');
  return targetRoot;
}

function captureRead(argv, options = {}) {
  const stdout = [];
  const stderr = [];
  const status = runBuildLore(argv, {
    environment: { ...process.env, BUILDLORE_BIN: '' },
    ...options,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

test('BuildLore capability defaults use the local CLI and explicit Git publication', () => {
  assert.deepEqual(defaultCapabilityConfig('buildlore'), {
    enabled: true,
    mode: 'local_cli',
    command: 'buildlore',
    commandEnv: 'BUILDLORE_BIN',
    commandArgs: [],
    projectIdSource: 'project_config',
    syncPolicy: 'explicit',
    retrievalMode: 'hybrid',
    publicationPolicy: 'explicit_git',
  });
});

test('p2a buildlore resolves project identity and maps sync to the BuildLore CLI', (t) => {
  const targetRoot = projectFixture(t, {
    projectId: 'demo-project',
    buildlore: { command: 'buildlore' },
  });
  const invocation = resolveBuildLoreInvocation([
    'sync', '--target', targetRoot, '--dry-run', '--json',
  ], { environment: {} });

  assert.equal(invocation.executable, 'buildlore');
  assert.equal(invocation.targetRoot, targetRoot);
  assert.deepEqual(invocation.args, [
    'sync', '--project', 'demo-project', '--dry-run', '--json',
  ]);
});

test('p2a buildlore maps status to knowledge status and accepts the manifest project id', (t) => {
  const targetRoot = projectFixture(t, {}, { projectId: 'manifest-project' });
  const invocation = resolveBuildLoreInvocation([
    'status', '--target', targetRoot, '--json',
  ], { environment: {} });

  assert.deepEqual(invocation.args, [
    'knowledge', 'status', '--project', 'manifest-project', '--json',
  ]);
});

test('p2a buildlore honors a single executable environment override without a shell', (t) => {
  const targetRoot = projectFixture(t, {
    projectId: 'demo-project',
    buildlore: {
      command: 'buildlore',
      commandEnv: 'TEST_BUILDLORE_BIN',
      commandArgs: ['dist/cli/bin.js'],
    },
  });
  const invocation = resolveBuildLoreInvocation([
    'search', '--target', targetRoot, '--query', 'failure reason', '--mode', 'lexical',
  ], { environment: { TEST_BUILDLORE_BIN: '/usr/bin/node' } });

  assert.equal(invocation.executable, '/usr/bin/node');
  assert.deepEqual(invocation.args, [
    'dist/cli/bin.js',
    'search', '--project', 'demo-project',
    '--query', 'failure reason', '--mode', 'lexical',
  ]);
});

test('p2a buildlore safely permits an executable path containing spaces', (t) => {
  const targetRoot = projectFixture(t, {
    projectId: 'demo-project',
    buildlore: { command: './tools/build lore' },
  });
  const invocation = resolveBuildLoreInvocation([
    'check', '--target', targetRoot,
  ], { environment: {} });

  assert.equal(invocation.executable, path.join(targetRoot, 'tools', 'build lore'));
  assert.deepEqual(invocation.args, ['check', '--project', 'demo-project']);
});

test('p2a buildlore executes in the project root and preserves the child exit status', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  let captured = null;
  const status = runBuildLore([
    'check', '--target', targetRoot, '--json',
  ], {
    environment: {},
    runner(executable, args, options) {
      captured = { executable, args, options };
      return { status: 5 };
    },
  });

  assert.equal(status, 5);
  assert.equal(captured.executable, 'buildlore');
  assert.deepEqual(captured.args, ['check', '--project', 'demo-project', '--json']);
  assert.equal(captured.options.cwd, targetRoot);
  assert.equal(captured.options.stdio, 'inherit');
});

test('p2a buildlore fails before execution when a project-scoped command has no id', (t) => {
  const targetRoot = projectFixture(t);
  assert.throws(
    () => resolveBuildLoreInvocation(['sync', '--target', targetRoot]),
    /BuildLore project id is required/,
  );
});

test('connected source status derives its project from connection metadata without changing it', (t) => {
  const targetRoot = projectFixture(t);
  connectFixture(targetRoot);
  const before = fixtureSnapshot(targetRoot);
  const invocation = resolveBuildLoreInvocation(['status', '--target', targetRoot, '--json'], { environment: {} });
  assert.deepEqual(invocation.args, ['connection', 'status', '--project', 'demo-project', '--json']);
  assert.equal(invocation.boundedRead, true);
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('connected context maps its prompt option to Wiki memory without rewriting the prompt value', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  for (const prompt of ['review the active implementation', '--prompt']) {
    const invocation = resolveBuildLoreInvocation(['context', '--target', targetRoot, '--prompt', prompt, '--json']);
    assert.deepEqual(invocation.args, ['wiki', 'memory', '--project', 'demo-project', '--task', prompt, '--json']);
  }
});

test('a knowledge workspace uses Wiki context and knowledge status without connection metadata', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  mkdirSync(path.join(targetRoot, '.buildlore'));
  writeFileSync(path.join(targetRoot, '.buildlore', 'workspace.json'), JSON.stringify({
    schemaVersion: 'buildlore.workspace.v1', mode: 'knowledge', knowledgeRepository: targetRoot,
  }));
  const before = fixtureSnapshot(targetRoot);
  assert.deepEqual(resolveBuildLoreInvocation(['context', '--target', targetRoot, '--prompt', 'review', '--json']).args,
    ['wiki', 'memory', '--project', 'demo-project', '--task', 'review', '--json']);
  assert.deepEqual(resolveBuildLoreInvocation(['status', '--target', targetRoot, '--json']).args,
    ['knowledge', 'status', '--project', 'demo-project', '--json']);
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('invalid workspace metadata and dangling connection metadata never fall back to legacy reads', (t) => {
  for (const marker of [null, {}, { schemaVersion: 'buildlore.workspace.v1', mode: 'unknown' }]) {
    const targetRoot = projectFixture(t, { projectId: 'demo-project' });
    mkdirSync(path.join(targetRoot, '.buildlore'));
    writeFileSync(path.join(targetRoot, '.buildlore', 'workspace.json'), JSON.stringify(marker));
    const before = fixtureSnapshot(targetRoot);
    const result = captureRead(['context', '--target', targetRoot, '--prompt', 'review'], {
      runner() { assert.fail('invalid metadata fell back to legacy execution'); },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workspace/u);
    assert.deepEqual(fixtureSnapshot(targetRoot), before);
  }
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  mkdirSync(path.join(targetRoot, '.buildlore'));
  symlinkSync(path.join(targetRoot, 'missing-connection.json'), path.join(targetRoot, '.buildlore', 'connection.json'));
  assert.throws(() => resolveBuildLoreInvocation(['status', '--target', targetRoot]), /connection/u);
});

test('legacy routes remain unchanged when no connected source metadata exists', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  const cases = [
    ['status', [], ['knowledge', 'status']],
    ['sync', ['--dry-run'], ['sync']],
    ['check', [], ['check']],
    ['search', ['--query', 'regression', '--mode', 'lexical'], ['search']],
    ['context', ['--prompt', 'current work'], ['context']],
    ['compile', ['--review'], ['compile']],
    ['query', ['--question', 'why was this changed?'], ['query']],
  ];
  for (const [command, forwarded, prefix] of cases) {
    const invocation = resolveBuildLoreInvocation([command, '--target', targetRoot, ...forwarded, '--json']);
    assert.deepEqual(invocation.args, [...prefix, '--project', 'demo-project', ...forwarded, '--json']);
    assert.equal(invocation.boundedRead, ['status', 'search', 'context'].includes(command));
  }
});

test('Wiki memory and lookup preserve generation, cursor, and ids in connected and knowledge workspaces', (t) => {
  for (const connected of [false, true]) {
    const targetRoot = projectFixture(t, { projectId: 'demo-project' });
    if (connected) connectFixture(targetRoot);
    const before = fixtureSnapshot(targetRoot);
    const reads = [
      ['memory', ['--task', '검증된 현재 목표 확인', '--json']],
      ['memory', ['--task', 'small response', '--max-bytes', '2048', '--json']],
      ['memory', ['--task', 'resume the task', '--progressive', '--max-bytes', '2048', '--cursor', 'opaque+cursor/==', '--expect-generation', GENERATION, '--json']],
      ['lookup', ['--kind', 'evidence', '--id', FIRST_ID, '--expect-generation', GENERATION, '--json']],
      ['lookup', ['--kind', 'fact', '--ids', `${FIRST_ID},${SECOND_ID}`, '--max-bytes', '65536', '--expect-generation', GENERATION, '--json']],
    ];
    for (const [command, forwarded] of reads) {
      const invocation = resolveBuildLoreInvocation([command, '--target', targetRoot, ...forwarded]);
      assert.deepEqual(invocation.args, ['wiki', command, '--project', 'demo-project', ...forwarded]);
      assert.equal(invocation.boundedRead, true);
      assert.equal(invocation.timeoutMs, BUILDLORE_READ_TIMEOUT_MS);
    }
    assert.deepEqual(fixtureSnapshot(targetRoot), before);
  }
});

test('new read commands reject invalid requests before spawning any process', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  const cases = [
    ['memory'],
    ['memory', '--task', ' '],
    ['memory', '--task', '가'.repeat(683)],
    ['memory', '--task', 'review', '--cursor', 'cursor'],
    ['memory', '--task', '--json'],
    ['memory', '--task', '--timeout-ms'],
    ['memory', '--task', '--target'],
    ['memory', '--task', '--project'],
    ['memory', '--task', 'review', '--progressive', '--max-bytes', '2047'],
    ['memory', '--task', 'review', '--progressive', '--max-bytes', '65537'],
    ['memory', '--task', 'review', '--progressive', '--max-bytes', '2e3'],
    ['memory', '--task', 'review', '--task', 'duplicate'],
    ['memory', '--task', 'review', '--json', '--json'],
    ['memory', '--task', 'review', '--sync'],
    ['memory', '--task', 'review', '--progressive', '--cursor'],
    ['memory', '--task', 'review', '--expect-generation', 'a'.repeat(64)],
    ['memory', '--task', 'review', '--expect-generation', ' '],
    ['memory', '--task', 'review', '--expect-generation', `sha256:${'A'.repeat(64)}`],
    ['lookup', '--kind', 'evidence', '--id', FIRST_ID],
    ['lookup', '--kind', 'invalid', '--id', FIRST_ID, '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--ids', SECOND_ID, '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--max-bytes', '2048', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--ids', `${FIRST_ID},${SECOND_ID}`, '--max-bytes', '0', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--expect-generation', GENERATION, '--approve'],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--expect-generation'],
    ['lookup', '--kind', 'fact', '--id', ' ', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--ids', ' ', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', 'fact-1', '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', `${FIRST_ID},${SECOND_ID}`, '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--ids', `${FIRST_ID},`, '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--ids', Array(17).fill(FIRST_ID).join(','), '--expect-generation', GENERATION],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--expect-generation', 'not-a-digest'],
  ];
  const before = fixtureSnapshot(targetRoot);
  for (const [command, ...args] of cases) {
    const result = captureRead([command, '--target', targetRoot, ...args], {
      runner() { assert.fail(`invalid request spawned a process: ${JSON.stringify([command, ...args])}`); },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0);
  }
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('memory task validation counts UTF-8 bytes rather than characters', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  const task = `${'가'.repeat(682)}ab`;
  assert.equal(Buffer.byteLength(task), 2048);
  assert.deepEqual(resolveBuildLoreInvocation(['memory', '--target', targetRoot, '--task', task]).args,
    ['wiki', 'memory', '--project', 'demo-project', '--task', task]);
});

test('connected source project mismatches and malformed metadata fail without spawning or mutating state', (t) => {
  for (const connection of [null, [], {}, { projectId: 'INVALID' }, { projectId: 'other-project' }]) {
    const targetRoot = projectFixture(t, { projectId: 'demo-project' });
    connectFixture(targetRoot, connection);
    const before = fixtureSnapshot(targetRoot);
    const result = captureRead(['status', '--target', targetRoot], {
      runner() { assert.fail('invalid connection spawned a process'); },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /connection|connected source/u);
    assert.deepEqual(fixtureSnapshot(targetRoot), before);
  }
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  writeFileSync(path.join(targetRoot, '.buildlore', 'connection.json'), '{broken-json');
  assert.throws(() => resolveBuildLoreInvocation(['status', '--target', targetRoot]), /connection/u);
});

test('an explicit project cannot escape a connected source project', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  assert.throws(() => resolveBuildLoreInvocation(['memory', '--target', targetRoot, '--project', 'other-project', '--task', 'review']), /does not match/u);
});

test('all read routes use bounded piped execution even if inherited stdio is requested', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  const reads = [
    ['status'], ['search', '--query', 'goal'], ['context', '--prompt', 'goal'],
    ['memory', '--task', 'goal'],
    ['lookup', '--kind', 'fact', '--id', FIRST_ID, '--expect-generation', GENERATION],
  ];
  for (const [command, ...args] of reads) {
    let captured;
    const result = captureRead([command, '--target', targetRoot, ...args], {
      stdio: 'inherit',
      runner(executable, argv, options) {
        captured = options;
        return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
      },
    });
    assert.equal(result.status, 0);
    assert.deepEqual(captured.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(captured.timeout, BUILDLORE_READ_TIMEOUT_MS);
    assert.equal(captured.maxBuffer, BUILDLORE_READ_MAX_BYTES);
    assert.equal(captured.killSignal, 'SIGKILL');
    assert.equal(captured.encoding, 'utf8');
    assert.notEqual(captured.shell, true);
    assert.equal(result.stdout, '{"ok":true}\n');
  }
});

test('read timeout overrides are bounded and never forwarded to BuildLore or accepted on write commands', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  for (const timeout of ['1', '60000']) {
    const invocation = resolveBuildLoreInvocation(['memory', '--target', targetRoot, '--task', 'review', '--timeout-ms', timeout]);
    assert.equal(invocation.timeoutMs, Number(timeout));
    assert.deepEqual(invocation.args, ['wiki', 'memory', '--project', 'demo-project', '--task', 'review']);
  }
  for (const timeout of ['0', '-1', '60001', '1.5', 'NaN', '', '--json']) {
    assert.throws(() => resolveBuildLoreInvocation(['status', '--target', targetRoot, '--timeout-ms', timeout]), /timeout/u);
  }
  for (const command of ['sync', 'check', 'compile', 'query']) {
    assert.throws(() => resolveBuildLoreInvocation([command, '--target', targetRoot, '--timeout-ms', '100']), /read command/u);
  }
});

test('a real child receives shell metacharacters literally and reads leave lifecycle and connection files unchanged', (t) => {
  const targetRoot = childFixture(t, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }));');
  const task = '$(touch shell-injected); touch shell-injected; `touch shell-injected`';
  const before = fixtureSnapshot(targetRoot);
  const result = captureRead(['memory', '--target', targetRoot, '--task', task, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ['wiki', 'memory', '--project', 'demo-project', '--task', task, '--json'],
    cwd: targetRoot,
  });
  assert.equal(existsSync(path.join(targetRoot, 'shell-injected')), false);
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('a real timed-out knowledge read discards partial output and preserves all project state', (t) => {
  const targetRoot = childFixture(t, 'process.stdout.write("partial-knowledge"); setInterval(() => {}, 1000);');
  const before = fixtureSnapshot(targetRoot);
  const started = performance.now();
  const result = captureRead(['memory', '--target', targetRoot, '--task', 'review', '--timeout-ms', '150']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /time budget/u);
  assert.ok(performance.now() - started < 5000, 'timeout must release the caller promptly');
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('real stdout and stderr overflows discard incomplete knowledge and preserve project state', (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const targetRoot = childFixture(t, `process.stdout.write("partial-knowledge"); process.${stream}.write("x".repeat(${BUILDLORE_READ_MAX_BYTES * 4}));`);
    const before = fixtureSnapshot(targetRoot);
    const result = captureRead(['memory', '--target', targetRoot, '--task', 'review']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /output budget/u);
    assert.ok(result.stderr.length < 1024, 'untrusted partial output should not become a diagnostic');
    assert.deepEqual(fixtureSnapshot(targetRoot), before);
  }
});

test('a missing executable returns a recoverable read error without altering project state', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project', buildlore: { command: './missing-buildlore' } });
  connectFixture(targetRoot);
  const before = fixtureSnapshot(targetRoot);
  const result = captureRead(['memory', '--target', targetRoot, '--task', 'review'], { environment: {} });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /executable.*not found/u);
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('read process exceptions and signals discard partial results rather than reporting success', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  const runners = [
    () => { throw new Error('runner failure'); },
    () => ({ status: null, signal: 'SIGTERM', stdout: 'partial-knowledge', stderr: 'partial-error' }),
    () => ({ stdout: 'partial-knowledge', stderr: 'partial-error' }),
  ];
  for (const runner of runners) {
    const result = captureRead(['memory', '--target', targetRoot, '--task', 'review'], { runner });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0);
  }
});

test('a real rejected knowledge read preserves its failure status but discards partial stdout', (t) => {
  const targetRoot = childFixture(t, 'process.stdout.write("partial-knowledge"); process.stderr.write("generation mismatch"); process.exitCode = 7;');
  const before = fixtureSnapshot(targetRoot);
  const result = captureRead(['lookup', '--target', targetRoot, '--kind', 'fact', '--id', FIRST_ID, '--expect-generation', GENERATION]);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'generation mismatch');
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('handoff import is an explicit write and never implies a commit or publication', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  for (const commit of [false, true]) {
    const invocation = resolveBuildLoreInvocation([
      'handoff', 'import', '--target', targetRoot, '--file', 'handoffs/completed.json',
      ...(commit ? ['--commit'] : []), '--json',
    ]);
    assert.deepEqual(invocation.args, [
      'handoff', 'import', '--project', 'demo-project', '--file', 'handoffs/completed.json',
      ...(commit ? ['--commit'] : []), '--json',
    ]);
    assert.equal(invocation.boundedRead, false);
  }
});

test('handoff reads remain project scoped, bounded, and distinct from approved Wiki reads', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  for (const action of ['read', 'verify']) {
    const invocation = resolveBuildLoreInvocation(['handoff', action, '--target', targetRoot, '--id', FIRST_ID, '--json']);
    assert.deepEqual(invocation.args, ['handoff', action, '--project', 'demo-project', '--id', FIRST_ID, '--json']);
    assert.equal(invocation.boundedRead, true);
    assert.equal(invocation.maxOutputBytes, action === 'read' ? BUILDLORE_HANDOFF_READ_MAX_BYTES : BUILDLORE_READ_MAX_BYTES);
  }
  const list = resolveBuildLoreInvocation(['handoff', 'list', '--target', targetRoot, '--work-id', 'iter-0001', '--limit', '5', '--json']);
  assert.deepEqual(list.args, ['handoff', 'list', '--project', 'demo-project', '--work-id', 'iter-0001', '--limit', '5', '--json']);
  assert.equal(list.boundedRead, true);
});

test('handoff option errors and mismatched projects never spawn a process', (t) => {
  const targetRoot = projectFixture(t, { projectId: 'demo-project' });
  connectFixture(targetRoot);
  const cases = [
    ['import'], ['import', '--file', '--commit'], ['import', '--file', 'bundle.json', '--push'],
    ['read'], ['read', '--id', 'e1'], ['read', '--id', FIRST_ID, '--commit'],
    ['verify', '--id', FIRST_ID, '--file', 'bundle.json'],
    ['list', '--limit', '0'], ['list', '--limit', '101'], ['list', '--work-id', '../other'],
    ['list', '--project', 'other-project'], ['approve'],
  ];
  const before = fixtureSnapshot(targetRoot);
  for (const args of cases) {
    const result = captureRead(['handoff', ...args, '--target', targetRoot], {
      runner() { assert.fail('invalid handoff request spawned a process'); },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(fixtureSnapshot(targetRoot), before);
});

test('a preserved object larger than a memory packet fits the separately bounded handoff reader', (t) => {
  const targetRoot = childFixture(t, `process.stdout.write(JSON.stringify({ wikiStatus: 'pending', cleanupEligible: false, body: 'x'.repeat(${BUILDLORE_READ_MAX_BYTES + 1}) }));`);
  const result = captureRead(['handoff', 'read', '--target', targetRoot, '--id', FIRST_ID, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.body.length, BUILDLORE_READ_MAX_BYTES + 1);
  assert.equal(body.wikiStatus, 'pending');
  assert.equal(body.cleanupEligible, false);
});
