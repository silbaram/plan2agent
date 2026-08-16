import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectSanitizedToolTrace,
  inspectCommandEventShape,
} from '../scripts/p2a_tool_trace.mjs';

function commandEvent(command, exitCode = 0) {
  return {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command,
      exit_code: exitCode,
    },
  };
}

test('sanitized tool trace separates multi-source reads from repeated operations', () => {
  const trace = collectSanitizedToolTrace([
    commandEvent('sed -n 1,80p .agents/skills/p2a-next/SKILL.md .agents/skills/p2a-dev-execution/references/execution-lifecycle.md'),
    commandEvent('rg PRIVATE-QUERY .agents/skills/p2a-next/SKILL.md'),
    commandEvent('npm test'),
  ], [
    { id: 'skill:p2a-next', paths: ['.agents/skills/p2a-next/SKILL.md'] },
    { id: 'execution.lifecycle', paths: ['.agents/skills/p2a-dev-execution/references/execution-lifecycle.md'] },
  ], { workspaceRoot: '/workspace/project' });

  assert.equal(trace.status, 'available');
  assert.deepEqual(trace.metrics, {
    toolOperations: 3,
    contentReadOperations: 2,
    metadataInspectOperations: 0,
    uniqueSourcesRead: 2,
    sourceReadOccurrences: 3,
    repeatedSourceReads: 1,
    unattributedReadOperations: 0,
    sourcesPerReadOperation: 1.5,
    unknownOperations: 0,
  });
  assert.deepEqual(trace.operations[0].sourceIds, ['execution.lifecycle', 'skill:p2a-next']);
  assert.equal(trace.operations[0].operationFingerprint, 'content_read:sed:allowlisted_source:execution.lifecycle,skill:p2a-next');
  assert.equal(trace.operations[0].readTool, 'sed');
  assert.equal(trace.operations[0].targetClass, 'allowlisted_source');
  assert.equal(trace.operations[2].commandClass, 'verify');
  const serialized = JSON.stringify(trace);
  assert.doesNotMatch(serialized, /PRIVATE-QUERY|sed -n|npm test|SKILL\.md/);
  assert.doesNotMatch(serialized, /[a-f0-9]{64}/);
});

test('unattributed reads make a trace partial and do not use path suffix matches', () => {
  const trace = collectSanitizedToolTrace([
    commandEvent('cat /workspace/project/.agents/skills/p2a-next/SKILL.md'),
    commandEvent('cat /tmp/foreign/.agents/skills/p2a-next/SKILL.md'),
    commandEvent('rg TODO .'),
  ], [
    {
      id: 'skill:p2a-next',
      paths: [
        '.agents/skills/p2a-next/SKILL.md',
        '/workspace/project/.agents/skills/p2a-next/SKILL.md',
      ],
    },
  ], { workspaceRoot: '/workspace/project' });

  assert.equal(trace.status, 'partial');
  assert.deepEqual(trace.operations.map((operation) => operation.sourceIds), [
    ['skill:p2a-next'],
    [],
    [],
  ]);
  assert.equal(trace.metrics.sourceReadOccurrences, 1);
  assert.equal(trace.metrics.repeatedSourceReads, 0);
  assert.equal(trace.metrics.unattributedReadOperations, 2);
  assert.equal(trace.metrics.unknownOperations, 2);
  assert.deepEqual(trace.operations.map((operation) => operation.targetClass), [
    'allowlisted_source',
    'outside_workspace',
    'workspace_other',
  ]);
});

test('metadata inspection is not treated as an unattributed content read', () => {
  const trace = collectSanitizedToolTrace([
    commandEvent('ls -la .agents/skills/p2a-next'),
    commandEvent('find .agents -maxdepth 2 -type f'),
    commandEvent('stat .agents/context-routes.json'),
    commandEvent('readlink .agents/skills/p2a-next'),
    commandEvent('rg --files .agents/skills'),
  ], [], { workspaceRoot: '/workspace/project' });

  assert.equal(trace.status, 'available');
  assert.equal(trace.metrics.toolOperations, 5);
  assert.equal(trace.metrics.contentReadOperations, 0);
  assert.equal(trace.metrics.metadataInspectOperations, 5);
  assert.equal(trace.metrics.unattributedReadOperations, 0);
  assert.equal(trace.metrics.unknownOperations, 0);
  assert.deepEqual(trace.operations.map((operation) => operation.commandClass), [
    'metadata_inspect',
    'metadata_inspect',
    'metadata_inspect',
    'metadata_inspect',
    'metadata_inspect',
  ]);
  assert.deepEqual(trace.operations.map((operation) => operation.readTool), [
    'ls',
    'find',
    'stat',
    'readlink',
    'rg_files',
  ]);
  assert.ok(trace.operations.every((operation) => operation.targetClass === 'workspace_other'));
});

test('unsupported command event shapes preserve only safe field types', () => {
  const event = commandEvent({ raw: 'SECRET-COMMAND' });
  const shape = inspectCommandEventShape(event);
  assert.deepEqual(shape, {
    applicable: true,
    supported: false,
    fields: {
      command: 'object',
      exitCode: 'integer',
    },
  });
  const trace = collectSanitizedToolTrace([event]);
  assert.equal(trace.status, 'unsupported');
  assert.equal(trace.metrics.toolOperations, 1);
  assert.equal(trace.metrics.unknownOperations, 1);
  assert.equal(trace.metrics.unattributedReadOperations, 0);
  assert.doesNotMatch(JSON.stringify(trace), /SECRET-COMMAND/);
});
