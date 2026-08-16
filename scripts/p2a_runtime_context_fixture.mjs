/** Build a schema-valid synthetic context packet for isolated runtime-routing evaluation. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { renderModelContextPacket } from './p2a_context_packet.mjs';
import { resolveRuntimeContext } from './p2a_context_routes.mjs';
import { validateSchema } from './p2a_schema.mjs';

const PACKET_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-packet.schema.json', import.meta.url),
  'utf8',
));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameStrings(left, right) {
  return stableJson([...left].sort()) === stableJson([...right].sort());
}

function fixtureBinding(scenario, config) {
  if (config.activation === 'immediate') {
    const action = scenario.case?.routing_action;
    if (!action || action.continuation?.id !== config.continuationId) {
      throw new Error(`${scenario.id} immediate context fixture must bind its structured routing action`);
    }
    return {
      continuation: {
        id: action.continuation.id,
        sourceState: action.continuation.sourceState,
      },
      binding: {
        kind: 'action',
        sourceState: action.continuation.sourceState,
        artifactContractSha256: sha256(stableJson(action)),
      },
    };
  }
  if (config.activation === 'run_declared') {
    return {
      continuation: null,
      binding: {
        kind: 'run',
        runId: `run-eval-${scenario.id}`,
        taskId: `task-eval-${scenario.id}`,
        taskContractSha256: sha256(stableJson(scenario.case)),
      },
    };
  }
  throw new Error(`${scenario.id} has unsupported evaluation activation ${String(config.activation)}`);
}

export function buildRuntimeContextFixture(sourceRoot, scenario) {
  const config = scenario.runtime_context;
  if (!config) return null;
  const resolved = resolveRuntimeContext({
    targetRoot: sourceRoot,
    provider: config.provider,
    skill: config.skill,
    phase: config.phase,
    mode: config.mode,
    eligibility: config.eligibility ?? {},
  });
  const routeIds = resolved.sources.map((source) => source.routeId);
  if (!sameStrings(routeIds, config.expectedRouteIds ?? [])) {
    throw new Error(
      `${scenario.id} runtime context routes differ: expected ${(config.expectedRouteIds ?? []).join(',')}; got ${routeIds.join(',')}`,
    );
  }
  const binding = fixtureBinding(scenario, config);
  const sources = resolved.sources.map(({ routeId, path, sha256: sourceSha256, bytes }) => ({
    routeId,
    path,
    sha256: sourceSha256,
    bytes,
  }));
  const packet = {
    schema_version: 'p2a.context_packet.v1',
    provider: config.provider,
    skill: config.skill,
    phase: config.phase,
    activation: config.activation,
    mode: config.mode,
    continuation: binding.continuation,
    binding: binding.binding,
    sources,
    totalBytes: sources.reduce((total, source) => total + source.bytes, 0),
    generatedAt: '1970-01-01T00:00:00.000Z',
  };
  validateSchema(packet, PACKET_SCHEMA);
  const modelPacket = renderModelContextPacket(packet, resolved.sources);
  return {
    modelPacket,
    metadata: {
      schema_version: 'p2a.context_engineering_runtime_context_fixture.v1',
      status: 'packet_supplied',
      provider: packet.provider,
      skill: packet.skill,
      phase: packet.phase,
      activation: packet.activation,
      mode: packet.mode,
      routeIds,
      sources,
      totalBytes: packet.totalBytes,
      modelPacketSha256: sha256(modelPacket),
    },
  };
}
