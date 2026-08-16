import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeContextFixture } from '../scripts/p2a_runtime_context_fixture.mjs';
import { ROOT } from './helpers/fixtures.mjs';

test('runtime evaluation fixture renders a deterministic packet through stable domain modules', () => {
  const scenario = {
    id: 'direct-execution',
    case: {
      routing_action: {
        schema_version: 'p2a.next.v2',
        state: 'gate_b_approved_needs_execution_prepare',
        command: {
          kind: 'skill',
          skill: 'p2a-dev-execution',
          args: ['--artifacts', '.plan2agent/artifacts/example', '--prepare-mode', 'adaptive'],
        },
        continuation: {
          id: 'execution.prepare',
          activation: 'immediate',
          sourceState: 'gate_b_approved_needs_execution_prepare',
          skill: 'p2a-dev-execution',
          phase: 'prepare',
          mode: null,
        },
      },
    },
    runtime_context: {
      provider: 'gemini',
      skill: 'p2a-dev-execution',
      phase: 'prepare',
      activation: 'immediate',
      mode: null,
      continuationId: 'execution.prepare',
      expectedRouteIds: ['execution.lifecycle'],
    },
  };

  const first = buildRuntimeContextFixture(ROOT, scenario);
  const second = buildRuntimeContextFixture(ROOT, scenario);

  assert.deepEqual(first, second);
  assert.equal(first.metadata.status, 'packet_supplied');
  assert.deepEqual(first.metadata.routeIds, ['execution.lifecycle']);
  assert.match(first.modelPacket, /^BEGIN PLAN2AGENT CONTEXT PACKET\n/);
  assert.match(first.modelPacket, /END PLAN2AGENT CONTEXT PACKET\n$/);
  assert.doesNotMatch(first.modelPacket, /generatedAt/);
});
