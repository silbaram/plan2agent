import test from 'node:test';
import assert from 'node:assert/strict';
import { addItem, renderCartSummary } from '../src/cart.mjs';

test('addItem validates, merges, and stays immutable', () => {
  const original = [{ sku: 'tea', name: 'Tea', priceCents: 450, quantity: 1 }];
  const next = addItem(original, { sku: 'tea', name: 'Tea', priceCents: 450, quantity: 2 });
  assert.deepEqual(next, [{ sku: 'tea', name: 'Tea', priceCents: 450, quantity: 3 }]);
  assert.deepEqual(original, [{ sku: 'tea', name: 'Tea', priceCents: 450, quantity: 1 }]);
  assert.throws(() => addItem([], { sku: '', name: 'Bad', priceCents: 1, quantity: 1 }));
  assert.throws(() => addItem([], { sku: 'x', name: 'Bad', priceCents: 1, quantity: 1.5 }));
});

test('renderCartSummary handles empty, escaping, quantities, and cents', () => {
  assert.match(renderCartSummary([]), /Cart is empty/);
  const html = renderCartSummary([
    { sku: 'x', name: '<Tea & Cake>', priceCents: 425, quantity: 2 },
    { sku: 'y', name: 'Coffee', priceCents: 199, quantity: 1 },
  ]);
  assert.doesNotMatch(html, /<Tea & Cake>/);
  assert.match(html, /&lt;Tea &amp; Cake&gt;/);
  assert.match(html, /2/);
  assert.match(html, /\$10\.49/);
});
