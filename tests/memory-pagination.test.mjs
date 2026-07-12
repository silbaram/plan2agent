import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPagedMemoryItems } from '../scripts/p2a_memory.mjs';

const connection = { server: 'https://memory.example.test' };

test('paged Memory lookup reads items from a single page response', async () => {
  const calls = [];
  const items = await fetchPagedMemoryItems(connection, '/artifacts', {
    sourceProjectId: 'project-1',
  }, {
    pageSize: 5000,
    get: async (_connection, pathName, searchParams) => {
      calls.push({ pathName, searchParams });
      return { items: [{ artifactId: 'artifact-1' }], nextCursor: null };
    },
  });

  assert.deepEqual(items, [{ artifactId: 'artifact-1' }]);
  assert.deepEqual(calls, [{
    pathName: '/artifacts',
    searchParams: { sourceProjectId: 'project-1', limit: 5000, cursor: null },
  }]);
});

test('paged Memory lookup follows nextCursor and accumulates every page', async () => {
  const calls = [];
  const pages = new Map([
    [null, { items: [{ artifactId: 'artifact-1' }], nextCursor: 'cursor-1' }],
    ['cursor-1', { items: [{ artifactId: 'artifact-2' }], nextCursor: 'cursor-2' }],
    ['cursor-2', { items: [{ artifactId: 'artifact-3' }], nextCursor: null }],
  ]);
  const items = await fetchPagedMemoryItems(connection, '/artifacts', {}, {
    pageSize: 2,
    get: async (_connection, _pathName, searchParams) => {
      calls.push(searchParams);
      return pages.get(searchParams.cursor);
    },
  });

  assert.deepEqual(items.map((item) => item.artifactId), ['artifact-1', 'artifact-2', 'artifact-3']);
  assert.deepEqual(calls.map((call) => call.cursor), [null, 'cursor-1', 'cursor-2']);
  assert.ok(calls.every((call) => call.limit === 2));
});

test('paged Memory lookup respects a caller result limit', async () => {
  const calls = [];
  const items = await fetchPagedMemoryItems(connection, '/search/keyword', { q: 'decision' }, {
    pageSize: 2,
    maxItems: 3,
    get: async (_connection, _pathName, searchParams) => {
      calls.push(searchParams);
      if (searchParams.cursor === null) {
        return { items: [{ id: 'result-1' }, { id: 'result-2' }], nextCursor: 'cursor-1' };
      }
      return { items: [{ id: 'result-3' }, { id: 'result-4' }], nextCursor: 'cursor-2' };
    },
  });

  assert.deepEqual(items.map((item) => item.id), ['result-1', 'result-2', 'result-3']);
  assert.deepEqual(calls.map((call) => call.limit), [2, 1]);
});

test('paged Memory lookup remains compatible with legacy array responses', async () => {
  const items = await fetchPagedMemoryItems(connection, '/artifacts', {}, {
    pageSize: 50,
    get: async () => [{ artifactId: 'legacy-artifact' }],
  });

  assert.deepEqual(items, [{ artifactId: 'legacy-artifact' }]);
});

test('paged Memory lookup rejects malformed pages instead of reporting an empty result', async () => {
  await assert.rejects(
    fetchPagedMemoryItems(connection, '/artifacts', {}, {
      pageSize: 50,
      get: async () => ({ results: [] }),
    }),
    /invalid paged response/,
  );
});

test('paged Memory lookup rejects a repeated cursor', async () => {
  await assert.rejects(
    fetchPagedMemoryItems(connection, '/artifacts', {}, {
      pageSize: 50,
      get: async () => ({ items: [], nextCursor: 'same-cursor' }),
    }),
    /repeated nextCursor/,
  );
});
