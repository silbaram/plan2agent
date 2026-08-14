import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTransition } from '../src/policy.mjs';

test('allows the public happy paths without mutation', () => {
  const draft = { id: 'p-1', state: 'draft', payload: { value: 1 } };
  const review = authorizeTransition(draft, 'review', 'owner');
  assert.equal(review.state, 'review');
  assert.equal(draft.state, 'draft');
  assert.equal(authorizeTransition(review, 'approved', 'reviewer').state, 'approved');
});

test('rejects obvious role and transition violations', () => {
  assert.throws(() => authorizeTransition({ state: 'draft' }, 'review', 'viewer'));
  assert.throws(() => authorizeTransition({ state: 'approved' }, 'draft', 'owner'));
  assert.throws(() => authorizeTransition({ state: 'unknown' }, 'draft', 'owner'));
});
