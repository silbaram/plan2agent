import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('markup has a semantic card heading, metadata, and action', () => {
  assert.match(html, /<article\b/i);
  assert.match(html, /<h1\b[^>]*>[^<]+<\/h1>/i);
  assert.match(html, /(?:Product Design|Seoul|Design systems)/i);
  assert.match(html, /<(?:a|button)\b/i);
  assert.match(html, /Alexandria-Cassandra-Montgomery/i);
});

test('styles consume the supplied design tokens', () => {
  for (const token of ['--color-canvas', '--color-surface', '--color-text', '--color-muted', '--color-accent', '--space-3', '--radius-card', '--shadow-card']) {
    assert.match(css, new RegExp(`var\\(${token}\\)`), `missing ${token}`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /rgb\(/i);
});

test('styles protect focus, long content, mobile layout, and overflow', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /overflow-wrap|word-break/);
  assert.match(css, /@media\s*\([^)]*max-width/i);
  assert.doesNotMatch(css, /overflow-x\s*:\s*hidden/);
});
