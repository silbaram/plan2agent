import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  memorySearchReportMatchesContext,
  readMemorySearchReports,
  searchNextActions,
  searchRemoteMemory,
} from '../scripts/p2a_memory.mjs';
import { runMemory, runP2a } from './helpers/fixtures.mjs';

const connection = { server: 'https://memory.example.test' };
const contextualPlan = {
  context: {
    canonicalProjectId: '2810dbd3-2cd5-5f09-8cfc-a9c2095404fe',
  },
  project: {
    id: '2810dbd3-2cd5-5f09-8cfc-a9c2095404fe',
  },
  iteration: {
    id: '54dcc7cd-86f0-523c-b91a-2da3ccab4abb',
  },
};

function searchArgs(overrides = {}) {
  return {
    query: 'webhook decision',
    searchMode: 'keyword',
    project: null,
    excludeProject: null,
    global: false,
    artifactType: null,
    sourcePath: null,
    limit: 20,
    ...overrides,
  };
}

test('keyword search keeps the backward-compatible GET contract and active iteration scope', async () => {
  const calls = [];
  const result = await searchRemoteMemory(connection, searchArgs(), contextualPlan, {
    get: async (_connection, pathName, searchParams) => {
      calls.push({ pathName, searchParams });
      return { items: [{ artifactType: 'DOCUMENT_SNAPSHOT' }], nextCursor: null };
    },
  });

  assert.equal(result.requestedMode, 'keyword');
  assert.equal(result.effectiveMode, 'keyword');
  assert.equal(result.fallback, null);
  assert.equal(result.results.length, 1);
  assert.deepEqual(calls, [{
    pathName: '/search/keyword',
    searchParams: {
      q: 'webhook decision',
      projectId: contextualPlan.project.id,
      iterationId: contextualPlan.iteration.id,
      artifactType: null,
      sourcePath: null,
      limit: 20,
      cursor: null,
    },
  }]);
});

test('project-scoped hybrid search uses POST and omits the iteration filter', async () => {
  const calls = [];
  const result = await searchRemoteMemory(connection, searchArgs({
    searchMode: 'hybrid',
    project: 'webhook-api-service',
  }), null, {
    post: async (_connection, pathName, body) => {
      calls.push({ pathName, body });
      return { items: [{ artifactType: 'DOCUMENT_SNAPSHOT' }], nextCursor: null };
    },
  });

  assert.equal(result.requestedMode, 'hybrid');
  assert.equal(result.effectiveMode, 'hybrid');
  assert.equal(result.fallback, null);
  assert.equal(calls[0].pathName, '/search/hybrid');
  assert.match(calls[0].body.projectId, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].body.iterationId, null);
  assert.deepEqual(calls[0].body.metadataFilters, {});
  assert.equal(calls[0].body.candidateLimit, 80);
});

test('semantic or hybrid failure falls back to keyword search', async () => {
  const calls = [];
  const result = await searchRemoteMemory(connection, searchArgs({ searchMode: 'semantic' }), contextualPlan, {
    post: async (_connection, pathName) => {
      calls.push(pathName);
      throw new Error('embedding provider unavailable');
    },
    get: async (_connection, pathName) => {
      calls.push(pathName);
      return { items: [{ artifactType: 'DOCUMENT_SNAPSHOT' }], nextCursor: null };
    },
  });

  assert.deepEqual(calls, ['/search/semantic', '/search/keyword']);
  assert.equal(result.requestedMode, 'semantic');
  assert.equal(result.effectiveMode, 'keyword');
  assert.deepEqual(result.fallback, {
    from: 'semantic',
    to: 'keyword',
    reason: 'embedding provider unavailable',
  });
  assert.equal(result.error, null);
  assert.equal(result.results.length, 1);
});

test('failed keyword fallback preserves both remote errors', async () => {
  const result = await searchRemoteMemory(connection, searchArgs({ searchMode: 'hybrid' }), contextualPlan, {
    post: async () => {
      throw new Error('hybrid unavailable');
    },
    get: async () => {
      throw new Error('keyword unavailable');
    },
  });

  assert.equal(result.effectiveMode, null);
  assert.match(result.error, /hybrid unavailable/);
  assert.match(result.error, /keyword fallback failed: keyword unavailable/);
});

test('global cross-project search excludes the current source project before applying the requested limit', async () => {
  const calls = [];
  const result = await searchRemoteMemory(connection, searchArgs({
    global: true,
    excludeProject: 'current-project',
    limit: 2,
  }), null, {
    get: async (_connection, pathName, searchParams) => {
      calls.push({ pathName, searchParams });
      if (!searchParams.cursor) {
        return {
          items: Array.from({ length: 80 }, () => ({
            artifactType: 'RUN_RECORD',
            sourceIds: { sourceProjectId: 'current-project' },
          })),
          nextCursor: 'after-current-project',
        };
      }
      return {
        items: [
          { artifactType: 'RUN_RECORD', sourceIds: { sourceProjectId: 'other-a' } },
          { artifactType: 'DOCUMENT_SNAPSHOT', metadata: { sourceProjectId: 'other-b' } },
        ],
        nextCursor: null,
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.projectId, null);
  assert.equal(calls[0].searchParams.limit, 80);
  assert.equal(calls[1].searchParams.cursor, 'after-current-project');
  assert.equal(result.excluded, 80);
  assert.deepEqual(result.results.map((item) => item.sourceIds?.sourceProjectId ?? item.metadata?.sourceProjectId), ['other-a', 'other-b']);
});

test('global hybrid search falls back to exhaustive keyword paging when the server candidate window contains only excluded matches', async () => {
  const currentResult = {
    artifactType: 'RUN_RECORD',
    sourceIds: { sourceProjectId: 'current-project' },
  };
  const externalResult = {
    artifactType: 'RUN_RECORD',
    sourceIds: { sourceProjectId: 'other-project' },
  };
  const allResults = [...Array.from({ length: 500 }, () => currentResult), externalResult];
  const hybridCalls = [];
  const keywordCalls = [];
  const result = await searchRemoteMemory(connection, searchArgs({
    global: true,
    excludeProject: 'current-project',
    searchMode: 'hybrid',
    limit: 1,
  }), null, {
    post: async (_connection, pathName, body) => {
      hybridCalls.push({ pathName, body });
      assert.equal(body.limit, 80);
      assert.equal(body.candidateLimit, 320);
      const candidates = allResults.slice(0, body.candidateLimit);
      const offset = body.cursor === null ? 0 : Number.parseInt(body.cursor, 10);
      const items = candidates.slice(offset, offset + body.limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < candidates.length ? String(nextOffset) : null,
      };
    },
    get: async (_connection, pathName, searchParams) => {
      keywordCalls.push({ pathName, searchParams });
      const offset = searchParams.cursor === null ? 0 : Number.parseInt(searchParams.cursor, 10);
      const items = allResults.slice(offset, offset + searchParams.limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < allResults.length ? String(nextOffset) : null,
      };
    },
  });

  assert.equal(hybridCalls.length, 4);
  assert.equal(keywordCalls.length, 7);
  assert.equal(result.effectiveMode, 'keyword');
  assert.equal(result.fallback?.supplemental, false);
  assert.match(result.fallback?.reason, /candidate window was exhausted/i);
  assert.equal(result.excluded, 500);
  assert.deepEqual(result.results, [externalResult]);
});

test('global hybrid search preserves semantic matches while keyword paging supplements results beyond the candidate window', async () => {
  const currentResult = {
    chunkId: 'current',
    artifactType: 'RUN_RECORD',
    sourceIds: { sourceProjectId: 'current-project' },
  };
  const semanticExternalResult = {
    chunkId: 'semantic-external',
    artifactType: 'DOCUMENT_CHUNK',
    sourceIds: { sourceProjectId: 'other-semantic' },
  };
  const keywordExternalResult = {
    chunkId: 'keyword-external',
    artifactType: 'DOCUMENT_CHUNK',
    sourceIds: { sourceProjectId: 'other-keyword' },
  };
  const hybridResults = [
    ...Array.from({ length: 319 }, () => currentResult),
    semanticExternalResult,
  ];
  const keywordResults = [
    ...Array.from({ length: 500 }, () => currentResult),
    semanticExternalResult,
    keywordExternalResult,
  ];
  const result = await searchRemoteMemory(connection, searchArgs({
    global: true,
    excludeProject: 'current-project',
    searchMode: 'hybrid',
    limit: 2,
  }), null, {
    post: async (_connection, _pathName, body) => {
      assert.equal(body.candidateLimit, 320);
      const offset = body.cursor === null ? 0 : Number.parseInt(body.cursor, 10);
      const items = hybridResults.slice(offset, offset + body.limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < hybridResults.length ? String(nextOffset) : null,
      };
    },
    get: async (_connection, _pathName, searchParams) => {
      const offset = searchParams.cursor === null ? 0 : Number.parseInt(searchParams.cursor, 10);
      const items = keywordResults.slice(offset, offset + searchParams.limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: nextOffset < keywordResults.length ? String(nextOffset) : null,
      };
    },
  });

  assert.equal(result.effectiveMode, 'hybrid');
  assert.equal(result.fallback?.supplemental, true);
  assert.equal(result.excluded, 500);
  assert.deepEqual(result.results, [semanticExternalResult, keywordExternalResult]);
});

test('global hybrid search preserves partial external results when the keyword supplement fails', async () => {
  const externalResult = {
    chunkId: 'semantic-external',
    artifactType: 'DOCUMENT_CHUNK',
    sourceIds: { sourceProjectId: 'other-project' },
  };
  const result = await searchRemoteMemory(connection, searchArgs({
    global: true,
    excludeProject: 'current-project',
    searchMode: 'hybrid',
    limit: 2,
  }), null, {
    post: async () => ({
      items: [
        externalResult,
        { chunkId: 'excluded', sourceIds: { sourceProjectId: 'current-project' } },
      ],
      nextCursor: null,
    }),
    get: async () => {
      throw new Error('keyword endpoint unavailable');
    },
  });

  assert.equal(result.error, null);
  assert.equal(result.effectiveMode, 'hybrid');
  assert.deepEqual(result.results, [externalResult]);
  assert.equal(result.fallback?.supplemental, true);
  assert.match(result.fallback?.error, /keyword endpoint unavailable/);
  assert.match(result.warning, /keyword fallback failed/);
});

test('project-scoped empty search actions do not describe the query as cross-project', () => {
  const actions = searchNextActions(
    connection,
    { error: null },
    [],
    null,
    searchArgs({ project: 'current-project' }),
  );

  assert.match(actions.join('\n'), /current-project artifacts/);
  assert.doesNotMatch(actions.join('\n'), /relying on cross-project search/);
});

test('global cross-project recall belongs to the excluded project only when stored inside its artifact root', () => {
  const artifactRoot = path.resolve('/workspace/.plan2agent/artifacts/current-project');
  const report = {
    schema_version: 'p2a.memory_search.v1',
    query: {
      scope: 'global',
      excludeProject: 'current-project',
    },
    context: null,
  };
  const context = {
    projectId: 'current-project',
    artifactRoot,
  };

  assert.equal(
    memorySearchReportMatchesContext(
      report,
      context,
      path.join(artifactRoot, 'iterations', 'iter-2', 'gate-a-intake', 'memory-recall-cross-project.json'),
    ),
    true,
  );
  assert.equal(
    memorySearchReportMatchesContext(
      report,
      context,
      path.resolve('/workspace/.plan2agent/artifacts/other-project/memory-recall-cross-project.json'),
    ),
    false,
  );
  assert.equal(
    memorySearchReportMatchesContext(
      { ...report, query: { ...report.query, excludeProject: 'other-project' } },
      context,
      path.join(artifactRoot, 'memory-recall-cross-project.json'),
    ),
    false,
  );
});

test('Memory CLI rejects unsupported graph scope, precedent filters, and trace depth', () => {
  for (const command of ['trace', 'impact']) {
    const result = runMemory([command, '--global', '--node', 'decision:ND-1']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--global is only supported by search, history, or precedent/);
  }

  for (const option of [['--type', 'run'], ['--source-path', 'artifacts/spec.json']]) {
    const result = runMemory(['precedent', '--query', 'retry decision', '--project', 'fixture-project', ...option]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--type and --source-path are only supported by search/);
  }

  const excessiveDepth = runMemory(['trace', '--node', 'decision:ND-1', '--project', 'fixture-project', '--depth', '31']);
  assert.notEqual(excessiveDepth.status, 0);
  assert.match(excessiveDepth.stderr, /--depth must be between 1 and 30/);

  const memoryHelp = runMemory(['--help']);
  assert.equal(memoryHelp.status, 0, memoryHelp.stderr);
  const traceUsage = memoryHelp.stdout.split('\n').find((line) => line.includes('p2a memory trace'));
  const impactUsage = memoryHelp.stdout.split('\n').find((line) => line.includes('p2a memory impact'));
  assert.ok(traceUsage);
  assert.ok(impactUsage);
  assert.doesNotMatch(traceUsage, /--global/);
  assert.doesNotMatch(impactUsage, /--global/);
  assert.match(traceUsage, /--depth <1-30>/);
  assert.match(impactUsage, /--depth <1-30>/);

  const topLevelHelp = runP2a(['--help']);
  assert.equal(topLevelHelp.status, 0, topLevelHelp.stderr);
  assert.match(topLevelHelp.stdout, /memory <status\|push\|pull\|search\|history\|digest\|trace\|impact\|precedent>/);
});

test('Memory usefulness report discovery scans scoped report names without parsing unrelated JSON files', () => {
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'p2a-memory-report-discovery-'));
  try {
    const fillerRoot = path.join(artifactRoot, 'iterations', 'iter-001', 'filler');
    mkdirSync(fillerRoot, { recursive: true });
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(
        path.join(fillerRoot, `${String(index).padStart(3, '0')}.memory-search.json`),
        '{}\n',
        'utf8',
      );
    }
    writeFileSync(
      path.join(fillerRoot, 'unrelated.json'),
      `${JSON.stringify({
        schema_version: 'p2a.memory_search.v1',
        query: { scope: 'project' },
        context: { projectId: 'demo-project' },
        results: [],
      })}\n`,
      'utf8',
    );
    const runsDir = path.join(artifactRoot, 'runs');
    const reportPath = path.join(runsDir, 'iter-001', 'run-task-001-001.memory-recall.json');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: { scope: 'project' },
      context: { projectId: 'demo-project' },
      results: [],
    }, null, 2)}\n`, 'utf8');

    const reports = readMemorySearchReports({
      sourceKind: 'artifacts',
      sourcePath: artifactRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationId: 'iter-001',
      runsDir,
    });
    assert.deepEqual(reports.map((report) => report.filePath), [reportPath]);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
