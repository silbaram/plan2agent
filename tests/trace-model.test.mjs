import assert from 'node:assert/strict';
import test from 'node:test';

import { SanitizedAgyToolTrace } from '../scripts/p2a_agy_tool_trace.mjs';
import { collectSanitizedToolTrace } from '../scripts/p2a_tool_trace.mjs';

const WORKSPACE = '/workspace/project';
const CANONICAL_PATH = '.agents/skills/p2a-next/SKILL.md';
const ALLOWLIST = [{ id: 'skill:p2a-next', paths: [CANONICAL_PATH] }];

function commandEvent(command) {
  return {
    type: 'item.completed',
    item: { type: 'command_execution', command, exit_code: 0 },
  };
}

test('Codex and AGY adapters produce the same provider-neutral trace metrics', () => {
  const codex = collectSanitizedToolTrace([
    commandEvent(`cat ${CANONICAL_PATH}`),
    commandEvent('cat src/runtime.mjs'),
    commandEvent('cat src/runtime.mjs'),
  ], ALLOWLIST, { workspaceRoot: WORKSPACE });

  const agyTrace = new SanitizedAgyToolTrace(ALLOWLIST, { workspaceRoot: WORKSPACE });
  agyTrace.observeTool('view_file', { AbsolutePath: `${WORKSPACE}/${CANONICAL_PATH}` });
  agyTrace.observeTool('view_file', { AbsolutePath: `${WORKSPACE}/src/runtime.mjs` });
  agyTrace.observeTool('view_file', { AbsolutePath: `${WORKSPACE}/src/runtime.mjs` });
  const agy = agyTrace.summary();

  assert.equal(codex.schema_version, 'p2a.sanitized_tool_trace.v3');
  assert.equal(agy.schema_version, codex.schema_version);
  assert.equal(agy.status, codex.status);
  assert.deepEqual(agy.metrics, codex.metrics);
});

test('provider adapters fail packet attribution through the same shared summary contract', () => {
  const codex = collectSanitizedToolTrace([
    commandEvent('rg TODO .'),
  ], ALLOWLIST, { workspaceRoot: WORKSPACE });

  const agyTrace = new SanitizedAgyToolTrace(ALLOWLIST, { workspaceRoot: WORKSPACE });
  agyTrace.observeTool('grep_search', { SearchPath: WORKSPACE });
  const agy = agyTrace.summary();

  for (const trace of [codex, agy]) {
    assert.equal(trace.status, 'partial');
    assert.equal(trace.metrics.packetManagedAttributionComplete, false);
    assert.equal(trace.metrics.packetManagedUnattributedReadOperations, 1);
    assert.equal(trace.metrics.packetManagedRepeatedSourceReads, 0);
  }
});

test('AGY canonical attribution rejects matching suffixes outside the workspace', () => {
  const trace = new SanitizedAgyToolTrace(ALLOWLIST, { workspaceRoot: WORKSPACE });
  trace.observeTool('view_file', { AbsolutePath: `/tmp/foreign/${CANONICAL_PATH}` });
  const summary = trace.summary();

  assert.deepEqual(summary.operations[0].sourceIds, []);
  assert.equal(summary.operations[0].targetClass, 'outside_workspace');
  assert.equal(summary.metrics.unattributedReadOperations, 1);
  assert.equal(summary.metrics.unknownOperations, 1);
});
