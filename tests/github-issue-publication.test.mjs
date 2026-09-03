import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createGithubIssuePreview,
  parseRetrospectiveMarkdown,
  publishGithubIssue,
} from '../scripts/p2a_github_issues.mjs';

const CLI = path.resolve('scripts/p2a_proposals.mjs');
const REPO = 'silbaram/plan2agent';
const SELECTOR = `github.com/${REPO}`;
const REPORT = `# Retrospective

## Observed issue

1. Issue creation is repeated by hand.

## User impact

Maintainers copy the same text repeatedly.

## Suggested improvement

1. Preview the issue.
2. Publish it explicitly.

## Evidence

The workflow was performed manually.
`;

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-issue-'));
  const relativePath = 'docs/retrospective/demo-v1.md';
  mkdirSync(path.join(root, 'docs', 'retrospective'), { recursive: true });
  mkdirSync(path.join(root, '.plan2agent'), { recursive: true });
  writeFileSync(path.join(root, relativePath), REPORT, 'utf8');
  writeFileSync(path.join(root, '.plan2agent', 'manifest.json'), JSON.stringify({ projectId: 'demo' }), 'utf8');
  return { root, relativePath };
}

function ghResult(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function runCli(root, args, env = process.env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env });
}

test('parses the four retrospective sections and builds a deterministic issue', () => {
  const project = workspace();
  try {
    assert.deepEqual(parseRetrospectiveMarkdown(REPORT), {
      'Observed issue': '1. Issue creation is repeated by hand.',
      'User impact': 'Maintainers copy the same text repeatedly.',
      'Suggested improvement': '1. Preview the issue.\n2. Publish it explicitly.',
      Evidence: 'The workflow was performed manually.',
    });
    const first = createGithubIssuePreview(project.relativePath, { workspaceRoot: project.root });
    const second = createGithubIssuePreview(project.relativePath, { workspaceRoot: project.root });
    assert.deepEqual(second, first);
    assert.equal(first.targetRepo, REPO);
    assert.equal(first.source, `demo:${project.relativePath}`);
    assert.equal(first.title, '[Retrospective][Process] Issue creation is repeated by hand.');
    assert.match(first.body, /## 완료 조건\n\n- \[ \] Preview the issue\.\n- \[ \] Publish it explicitly\./);
    assert.match(first.body, /<!-- p2a-retrospective-issue:v1 key=[a-f0-9]{12} -->\n$/);
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});

test('rejects malformed reports, escaping paths, secrets, and private user paths', async (t) => {
  const project = workspace();
  const outside = mkdtempSync(path.join(tmpdir(), 'p2a-issue-outside-'));
  try {
    await t.test('missing heading', () => {
      assert.throws(() => parseRetrospectiveMarkdown(REPORT.replace('## Evidence', '### Evidence')), /H2 sections/);
    });
    await t.test('outside path', () => {
      assert.throws(
        () => createGithubIssuePreview('../outside.md', { workspaceRoot: project.root }),
        /docs\/retrospective|project-relative/,
      );
    });
    await t.test('symlink escape', () => {
      const target = path.join(outside, 'report.md');
      writeFileSync(target, REPORT, 'utf8');
      symlinkSync(target, path.join(project.root, 'docs', 'retrospective', 'linked.md'));
      assert.throws(
        () => createGithubIssuePreview('docs/retrospective/linked.md', { workspaceRoot: project.root }),
        /inside the project/,
      );
    });
    for (const value of [
      'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      '{"password":"CorrectHorseBatteryStaple"}',
      'Authorization: Basic YWxpY2U6c3VwZXJzZWNyZXQ=',
      'Cookie: session=0123456789abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '/home/alice/private/file.log',
    ]) {
      await t.test(value.slice(0, 18), () => {
        writeFileSync(
          path.join(project.root, project.relativePath),
          REPORT.replace('The workflow was performed manually.', value),
          'utf8',
        );
        assert.throws(
          () => createGithubIssuePreview(project.relativePath, { workspaceRoot: project.root }),
          /secret|absolute user path/,
        );
      });
    }
  } finally {
    rmSync(project.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('CLI preview is read-only and publish requires --yes', () => {
  const project = workspace();
  const bin = path.join(project.root, 'bin');
  const sentinel = path.join(project.root, 'gh-called');
  try {
    mkdirSync(bin);
    const fakeGh = path.join(bin, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\ntouch "$GH_SENTINEL"\nexit 99\n', 'utf8');
    chmodSync(fakeGh, 0o700);
    const env = { ...process.env, PATH: bin, GH_SENTINEL: sentinel };
    const preview = runCli(project.root, [
      'issue-preview', '--retrospective', project.relativePath, '--json',
    ], env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).targetRepo, REPO);
    assert.equal(existsSync(sentinel), false);

    const publish = runCli(project.root, [
      'publish-issue', '--retrospective', project.relativePath, '--json',
    ], env);
    assert.notEqual(publish.status, 0);
    assert.match(publish.stderr, /--yes/);
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});

test('publish pins github.com, avoids a duplicate, and creates with the body on stdin', async (t) => {
  for (const duplicate of [true, false]) {
    await t.test(duplicate ? 'duplicate' : 'create', () => {
      const project = workspace();
      try {
        const issue = createGithubIssuePreview(project.relativePath, { workspaceRoot: project.root });
        const calls = [];
        const result = publishGithubIssue(issue, {
          workspaceRoot: project.root,
          yes: true,
          runGh(argv, options) {
            calls.push(argv);
            assert.equal(options.shell, false);
            assert.equal(options.env.GH_HOST, 'github.com');
            assert.equal(options.env.GH_REPO, SELECTOR);
            assert.equal(argv[argv.indexOf('--repo') + 1], SELECTOR);
            if (argv[0] === 'issue' && argv[1] === 'list') {
              const matches = duplicate ? [{
                number: 41,
                url: `https://github.com/${REPO}/issues/41`,
                state: 'CLOSED',
                body: `Existing\n${issue.marker}\n`,
              }] : [];
              return ghResult(JSON.stringify(matches));
            }
            assert.deepEqual(argv.slice(0, 2), ['issue', 'create']);
            assert.equal(argv[argv.indexOf('--body-file') + 1], '-');
            assert.equal(options.input, issue.body);
            return ghResult(`https://github.com/${REPO}/issues/42\n`);
          },
        });
        assert.equal(result.action, duplicate ? 'duplicate' : 'published');
        assert.equal(result.issue.number, duplicate ? 41 : 42);
        assert.equal(calls.some((call) => call[1] === 'create'), !duplicate);
      } finally {
        rmSync(project.root, { recursive: true, force: true });
      }
    });
  }
});

test('publish fails closed when duplicate lookup does not complete', () => {
  const project = workspace();
  try {
    const issue = createGithubIssuePreview(project.relativePath, { workspaceRoot: project.root });
    let created = false;
    assert.throws(() => publishGithubIssue(issue, {
      workspaceRoot: project.root,
      yes: true,
      runGh(argv) {
        if (argv[1] === 'create') created = true;
        return { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
      },
    }), /duplicate lookup/);
    assert.equal(created, false);
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});
