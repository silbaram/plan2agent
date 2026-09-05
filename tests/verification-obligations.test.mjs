import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  configuredRelatedVerificationObligations,
  configuredVerificationObligations,
  evaluateVerificationObligations,
  verificationAttemptKey,
  verificationCommandIdentity,
} from '../scripts/p2a_verification_evidence.mjs';
import {
  automaticDocsMetadataFiles,
  collectGitChangedFiles,
  collectGitChangedFilesSince,
  normalizeChangedFiles,
} from '../scripts/p2a_runs.mjs';

function attempt(overrides = {}) {
  return {
    type: 'test',
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    source: 'command',
    scope: 'full',
    workspaceRevisionSha256: 'revision-current',
    ...overrides,
  };
}

test('verification identity prefers original commands and preserves structured argv boundaries', () => {
  assert.equal(verificationCommandIdentity({
    originalCommand: './tools/test',
    command: '/workspace/tools/test',
    argv: ['ignored', 'argv'],
  }), './tools/test');
  assert.notEqual(
    verificationAttemptKey(attempt({ argv: ['node', '-e', 'a b'], command: 'display only' })),
    verificationAttemptKey(attempt({ argv: ['node', '-e a', 'b'], command: 'display only' })),
  );
});

test('configured obligations stay current while old-revision failures are retired', () => {
  const configured = configuredVerificationObligations({
    testCommand: './tools/test',
    lintCommand: 'npm run lint',
  });
  const items = [
    attempt({
      command: '/workspace/tools/test',
      originalCommand: './tools/test',
      status: 'failed',
      exitCode: 1,
      workspaceRevisionSha256: 'revision-old',
    }),
    attempt({
      type: 'lint',
      command: 'npm run lint',
    }),
  ];
  let evaluation = evaluateVerificationObligations(items, configured, {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.deepEqual(
    evaluation.missing.map(({ type, command, reasons }) => ({ type, command, reasons })),
    [{
      type: 'test',
      command: './tools/test',
      reasons: ['configured'],
    }],
  );

  items.push(attempt({
    command: '/workspace/tools/test',
    originalCommand: './tools/test',
  }));
  evaluation = evaluateVerificationObligations(items, configured, {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.deepEqual(evaluation.missing, []);
});

test('related retries keep one command identity when the selected file set changes', () => {
  const failed = attempt({
    command: 'node check-related.mjs a.js',
    argv: ['node', 'check-related.mjs', 'a.js'],
    scope: 'related',
    selectedFileCount: 1,
    status: 'failed',
    exitCode: 1,
    workspaceRevisionSha256: 'revision-old',
  });
  const passed = attempt({
    command: 'node check-related.mjs a.js b.js',
    argv: ['node', 'check-related.mjs', 'a.js', 'b.js'],
    scope: 'related',
    selectedFileCount: 2,
  });
  assert.equal(verificationAttemptKey(failed), verificationAttemptKey(passed));
  const evaluation = evaluateVerificationObligations([failed, passed], [], {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.equal(evaluation.required.length, 0);
  assert.deepEqual(evaluation.missing, []);
});

test('configured related verification is bound to the current command, file set, and workspace', () => {
  const selectedFiles = ['docs/guide.md'];
  const firstConfig = configuredRelatedVerificationObligations([{
    type: 'test',
    argv: ['node', 'check-docs-v1.mjs'],
  }], selectedFiles);
  const oldPass = attempt({
    command: 'node check-docs-v1.mjs docs/guide.md',
    argv: firstConfig[0].argv,
    selectedFileCount: 1,
    source: 'config',
    scope: 'related',
    workspaceRevisionSha256: 'revision-old',
  });
  assert.equal(evaluateVerificationObligations([oldPass], firstConfig, {
    workspaceRevisionSha256: 'revision-current',
  }).missing.length, 1);

  const currentPass = {
    ...oldPass,
    workspaceRevisionSha256: 'revision-current',
  };
  assert.deepEqual(evaluateVerificationObligations([currentPass], firstConfig, {
    workspaceRevisionSha256: 'revision-current',
  }).missing, []);

  const changedConfig = configuredRelatedVerificationObligations([{
    type: 'test',
    argv: ['node', 'check-docs-v2.mjs'],
  }], selectedFiles);
  assert.equal(evaluateVerificationObligations([currentPass], changedConfig, {
    workspaceRevisionSha256: 'revision-current',
  }).missing.length, 1);
});

test('a related pass must cover every file from the failed selection', () => {
  const failed = attempt({
    command: 'node check-related.mjs b.js',
    argv: ['node', 'check-related.mjs', 'b.js'],
    scope: 'related',
    selectedFileCount: 1,
    status: 'failed',
    exitCode: 1,
    workspaceRevisionSha256: 'revision-current',
  });
  const partialPass = attempt({
    command: 'node check-related.mjs a.js',
    argv: ['node', 'check-related.mjs', 'a.js'],
    scope: 'related',
    selectedFileCount: 1,
  });
  let evaluation = evaluateVerificationObligations([failed, partialPass], [], {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.deepEqual(evaluation.missing[0]?.requiredSelectedFiles, ['b.js']);

  const coveringPass = attempt({
    command: 'node check-related.mjs a.js b.js',
    argv: ['node', 'check-related.mjs', 'a.js', 'b.js'],
    scope: 'related',
    selectedFileCount: 2,
  });
  evaluation = evaluateVerificationObligations([failed, partialPass, coveringPass], [], {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.deepEqual(evaluation.missing, []);
});

test('legacy unbound and old unavailable evidence are never promoted to current obligations', () => {
  const items = [
    attempt({
      command: 'legacy test',
      workspaceRevisionSha256: undefined,
    }),
    attempt({
      command: 'missing tool',
      status: 'unavailable',
      exitCode: null,
      workspaceRevisionSha256: 'revision-old',
    }),
  ];
  const evaluation = evaluateVerificationObligations(items, [], {
    workspaceRevisionSha256: 'revision-current',
  });
  assert.deepEqual(evaluation.required, []);
  assert.deepEqual(evaluation.satisfied, []);
});

test('changed-file paths are canonical workspace-relative paths and cannot traverse symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-changed-paths-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  try {
    mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(workspace, 'external'));
    assert.deepEqual(
      normalizeChangedFiles(workspace, ['./docs//guide.md', 'docs/guide.md']),
      ['docs/guide.md'],
    );
    assert.throws(
      () => normalizeChangedFiles(workspace, ['docs/../src/app.js']),
      /'\.\.' is not allowed/,
    );
    assert.throws(
      () => normalizeChangedFiles(workspace, ['external/file.md']),
      /resolves outside the workspace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('git rename collection retains both old and new canonical paths', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-git-rename-'));
  try {
    const runGit = (args) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'fixture@example.com']);
    runGit(['config', 'user.name', 'Plan2Agent Fixture']);
    writeFileSync(path.join(workspace, 'old-name.md'), '# Before\n', 'utf8');
    runGit(['add', 'old-name.md']);
    runGit(['commit', '-qm', 'baseline']);
    const baseRef = runGit(['rev-parse', 'HEAD']);
    renameSync(path.join(workspace, 'old-name.md'), path.join(workspace, 'new-name.md'));
    runGit(['add', '-A']);
    assert.deepEqual(
      new Set(collectGitChangedFiles(workspace)),
      new Set(['old-name.md', 'new-name.md']),
    );
    runGit(['commit', '-qm', 'rename documentation']);
    assert.deepEqual(
      new Set(collectGitChangedFilesSince(workspace, baseRef)),
      new Set(['old-name.md', 'new-name.md']),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Git collection omits only untracked generated paths, retaining source and explicit evidence', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-generated-paths-'));
  try {
    const runGit = (args) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'fixture@example.com']);
    runGit(['config', 'user.name', 'Plan2Agent Fixture']);
    const files = [
      '.buildlore/backups/tracked.json',
      '.buildlore/backups/deleted.json',
      '.buildlore/backups/old-name.json',
      '.buildlore/backups/new.json',
      '.buildlore/backups/staged.json',
      '.buildlore/handoffs/result.md',
      '.buildlore/backups-source/new.js',
      '.plan2agent/artifacts/example/runs/run-new.json',
      '.plan2agent/project.config.json',
      'src/new.js',
      'docs/guide.md',
    ];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
      writeFileSync(path.join(workspace, file), 'before\n');
    }
    runGit(['add', ...files.slice(0, 3)]);
    runGit(['commit', '-qm', 'baseline']);
    writeFileSync(path.join(workspace, files[0]), 'after\n');
    rmSync(path.join(workspace, files[1]));
    runGit(['mv', files[2], '.buildlore/backups/renamed.json']);
    runGit(['add', '.buildlore/backups/staged.json']);

    const config = { runTracking: { generatedPaths: ['./.buildlore//backups/', '.buildlore/handoffs'] } };
    const changed = collectGitChangedFiles(workspace, config);
    assert.deepEqual(new Set(changed), new Set([
      ...files.slice(0, 3),
      '.buildlore/backups/renamed.json',
      '.buildlore/backups/staged.json',
      '.buildlore/backups-source/new.js',
      '.plan2agent/project.config.json',
      'src/new.js',
      'docs/guide.md',
    ]));
    assert.ok(collectGitChangedFiles(workspace).includes('.buildlore/backups/new.json'), 'unknown product paths are not guessed to be junk');
    assert.ok(normalizeChangedFiles(workspace, [
      ...changed, '.buildlore/backups/new.json',
    ]).includes('.buildlore/backups/new.json'), 'an explicit path remains authoritative');
    for (const generatedPaths of ['cache', ['..'], ['.'], ['/tmp'], ['cache/**'], [null]]) {
      assert.throws(() => collectGitChangedFiles(workspace, { runTracking: { generatedPaths } }));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('generated path matching does not resolve external cache symlinks but recorded paths still do', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-excluded-cache-link-'));
  const workspace = path.join(root, 'workspace');
  const cache = path.join(root, 'cache');
  try {
    mkdirSync(workspace);
    mkdirSync(cache);
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '-q']);
    writeFileSync(path.join(workspace, '.gitignore'), '.cache\n');
    writeFileSync(path.join(workspace, 'README.md'), '# Changed\n');
    symlinkSync(cache, path.join(workspace, '.cache'));
    const config = { runTracking: { generatedPaths: ['.cache'] } };
    assert.deepEqual(collectGitChangedFiles(workspace, config), collectGitChangedFiles(workspace));
    assert.throws(() => normalizeChangedFiles(workspace, ['.cache']), /resolves outside the workspace/);
    git(['add', '-f', '.cache']);
    assert.throws(() => collectGitChangedFiles(workspace, config), /resolves outside the workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic documentation scans exclude generated files but retain tracked and verification metadata', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'p2a-generated-doc-scan-'));
  try {
    const files = ['docs/guide.md', 'docs/generated/tracked.md', 'docs/generated/untracked.md', '.plan2agent/project.config.json'];
    for (const file of files) {
      mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
      writeFileSync(path.join(workspace, file), '{}\n');
    }
    const config = { runTracking: { generatedPaths: ['docs/generated', '.plan2agent'] } };
    assert.deepEqual(new Set(automaticDocsMetadataFiles(workspace, config)), new Set(files), 'non-Git scans cannot infer tracking');
    for (const args of [['init', '-q'], ['add', 'docs/generated/tracked.md']]) {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(new Set(automaticDocsMetadataFiles(workspace, config)), new Set([
      'docs/guide.md', 'docs/generated/tracked.md', '.plan2agent/project.config.json',
    ]));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
