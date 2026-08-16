/** Schema validation and deterministic rendering for runtime context packets. */

import { readFileSync } from 'node:fs';

import { ValidationError, validateSchema } from './p2a_schema.mjs';

const PACKET_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-packet.schema.json', import.meta.url),
  'utf8',
));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateContextPacket(packet) {
  validateSchema(packet, PACKET_SCHEMA);
  if (
    packet.binding.kind === 'action'
    && packet.continuation.sourceState !== packet.binding.sourceState
  ) {
    throw new ValidationError('$.continuation.sourceState must equal $.binding.sourceState');
  }
  const expectedTotalBytes = packet.sources.reduce((total, source) => total + source.bytes, 0);
  if (packet.totalBytes !== expectedTotalBytes) {
    throw new ValidationError(`$.totalBytes must equal the source byte sum ${expectedTotalBytes}`);
  }
  const generatedAt = new Date(packet.generatedAt);
  if (Number.isNaN(generatedAt.getTime()) || generatedAt.toISOString() !== packet.generatedAt) {
    throw new ValidationError('$.generatedAt must be a valid canonical UTC timestamp');
  }
  const routeIds = packet.sources.map((source) => source.routeId);
  if (routeIds.length !== new Set(routeIds).size) {
    throw new ValidationError('$.sources routeId values must be unique');
  }
  const sourcePaths = packet.sources.map((source) => source.path);
  if (sourcePaths.length !== new Set(sourcePaths).size) {
    throw new ValidationError('$.sources path values must be unique');
  }
  return packet;
}

export function renderModelContextPacket(packet, resolvedSources) {
  const immutable = { ...packet };
  delete immutable.generatedAt;
  const lines = [
    'BEGIN PLAN2AGENT CONTEXT PACKET',
    stableJson(immutable),
  ];
  for (const source of resolvedSources) {
    lines.push(`BEGIN PLAN2AGENT SOURCE routeId=${source.routeId} path=${source.path} sha256=${source.sha256} bytes=${source.bytes}`);
    lines.push(source.body.endsWith('\n') ? source.body.slice(0, -1) : source.body);
    lines.push(`END PLAN2AGENT SOURCE routeId=${source.routeId}`);
  }
  lines.push('END PLAN2AGENT CONTEXT PACKET');
  return `${lines.join('\n')}\n`;
}
