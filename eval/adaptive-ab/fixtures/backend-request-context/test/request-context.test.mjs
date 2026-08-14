import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequestId, resolveRequestId } from '../src/request-context.mjs';

test('normalizes safe request ids', () => {
  assert.equal(normalizeRequestId('  req_12.alpha-3  '), 'req_12.alpha-3');
  assert.equal(normalizeRequestId(''), null);
  assert.equal(normalizeRequestId('has spaces'), null);
  assert.equal(normalizeRequestId('한글'), null);
  assert.equal(normalizeRequestId('x'.repeat(65)), null);
});

test('resolves the request id header case-insensitively', () => {
  assert.equal(resolveRequestId({ 'X-Request-ID': ' req-42 ' }, 'fallback'), 'req-42');
  assert.equal(resolveRequestId({ 'x-request-id': 'bad value' }, 'fallback'), 'fallback');
  assert.equal(resolveRequestId({}, 'fallback'), 'fallback');
});
