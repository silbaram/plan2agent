import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommit } from '../src/parser.mjs';
import { renderMarkdown, summarize } from '../src/reporter.mjs';
import { buildReleaseReport } from '../src/index.mjs';

test('parseCommit reads conventional commits and ignores invalid input', () => {
  assert.deepEqual(parseCommit('feat(api)!: add <unsafe> export'), {
    type: 'feat', scope: 'api', breaking: true, message: 'add <unsafe> export',
  });
  assert.deepEqual(parseCommit('fix: repair cache'), {
    type: 'fix', scope: null, breaking: false, message: 'repair cache',
  });
  assert.equal(parseCommit('not conventional'), null);
});

test('summary is deterministic and counts breaking changes', () => {
  const summary = summarize([
    { type: 'fix', scope: null, breaking: false, message: 'z' },
    { type: 'feat', scope: 'api', breaking: true, message: 'a' },
    { type: 'fix', scope: 'ui', breaking: false, message: 'b' },
  ]);
  assert.deepEqual(summary.counts, { feat: 1, fix: 2 });
  assert.equal(summary.breaking, 1);
  assert.deepEqual(summary.entries.map((entry) => entry.message), ['a', 'b', 'z']);
});

test('Markdown is escaped and the public pipeline composes modules', () => {
  const markdown = renderMarkdown(summarize([
    { type: 'feat', scope: 'api', breaking: true, message: '<script> & release' },
  ]));
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /&lt;script&gt; &amp; release/);
  assert.match(buildReleaseReport(['fix: stable']), /stable/);
});
