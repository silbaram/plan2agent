import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATE_COPY, renderState } from '../app.js';

test('state copy remains fixed and every state renders', () => {
  assert.deepEqual(STATE_COPY, {
    empty: 'No activity yet',
    loading: 'Loading current activity',
    error: 'Activity could not be loaded',
    ready: 'Activity is up to date',
  });
  for (const state of Object.keys(STATE_COPY)) {
    assert.match(renderState(state), new RegExp(STATE_COPY[state]));
  }
  assert.throws(() => renderState('unknown'), /unknown|unsupported/i);
});

test('semantics expose labelled main content, live status, and error-only retry', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<main[^>]+(?:aria-label|aria-labelledby)=/i);
  assert.match(renderState('loading'), /(?:role="status"|aria-live="polite")/i);
  assert.match(renderState('error'), /(?:role="alert"|aria-live="assertive")/i);
  assert.match(renderState('error'), /<button[^>]*>[^<]*Retry/i);
  assert.doesNotMatch(renderState('ready'), /<button/i);
});

test('responsive styles include focus and narrow-screen overflow protection', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\([^)]*max-width/i);
  assert.match(css, /overflow-wrap|word-break/);
  assert.doesNotMatch(css, /overflow-x\s*:\s*hidden/);
});
