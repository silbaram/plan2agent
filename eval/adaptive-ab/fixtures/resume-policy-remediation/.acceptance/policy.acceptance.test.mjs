import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const workspace = process.env.P2A_AB_WORKSPACE;
if (!workspace) throw new Error('P2A_AB_WORKSPACE is required');
const { authorizeTransition } = await import(pathToFileURL(`${workspace}/src/policy.mjs`));

test('held-out transition matrix and nested immutability', () => {
  const rejected = { id: 'p-2', state: 'rejected', payload: { nested: { value: 1 } } };
  const draft = authorizeTransition(rejected, 'draft', 'owner');
  assert.equal(draft.state, 'draft');
  assert.deepEqual(rejected, { id: 'p-2', state: 'rejected', payload: { nested: { value: 1 } } });
  assert.throws(() => authorizeTransition({ state: 'review' }, 'approved', 'owner'));
  assert.throws(() => authorizeTransition({ state: 'review' }, 'rejected', 'owner'));
  assert.equal(authorizeTransition({ state: 'review' }, 'rejected', 'reviewer').state, 'rejected');
  assert.throws(() => authorizeTransition({ state: 'draft' }, 'approved', 'reviewer'));
  assert.throws(() => authorizeTransition({ state: 'draft' }, 'review', 'unknown-role'));
});
