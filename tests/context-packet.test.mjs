import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateSchema } from '../scripts/p2a_schema.mjs';
import { validateContextPacket } from '../scripts/p2a_context.mjs';
import { CONTINUATION_DEFINITIONS } from '../scripts/p2a_continuations.mjs';
import {
  E2E_FIXTURE_ROOT,
  ROOT,
  runExecute,
  runIteration,
  runP2aFrom,
  runRuns,
} from './helpers/fixtures.mjs';

const PACKET_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-packet.schema.json', import.meta.url),
  'utf8',
));

function contextProject(label) {
  const targetRoot = mkdtempSync(path.join(tmpdir(), `p2a-context-packet-${label}-`));
  cpSync(path.join(ROOT, '.agents'), path.join(targetRoot, '.agents'), { recursive: true });
  cpSync(path.join(ROOT, '.claude'), path.join(targetRoot, '.claude'), { recursive: true });
  const artifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), artifactRoot, { recursive: true });
  rmSync(path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'));
  writeFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), `${JSON.stringify({
    devExecution: { executionMode: 'adaptive' },
  }, null, 2)}\n`, 'utf8');
  return { targetRoot, artifactRoot };
}

function runContext(fixture, args) {
  return runP2aFrom(fixture.targetRoot, [
    'context',
    'show',
    '--artifacts', fixture.artifactRoot,
    '--provider', 'codex',
    ...args,
  ]);
}

function jsonPacket(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const packet = JSON.parse(result.stdout);
  validateSchema(packet, PACKET_SCHEMA);
  return packet;
}

function validPacket(overrides = {}) {
  return {
    schema_version: 'p2a.context_packet.v1',
    provider: 'codex',
    skill: 'p2a-dev-execution',
    phase: 'prepare',
    activation: 'immediate',
    mode: 'direct',
    continuation: {
      id: 'execution.prepare',
      sourceState: 'gate_b_approved_needs_execution_prepare',
    },
    binding: {
      kind: 'action',
      sourceState: 'gate_b_approved_needs_execution_prepare',
      artifactContractSha256: 'a'.repeat(64),
    },
    sources: [{
      routeId: 'execution.lifecycle',
      path: '.agents/skills/p2a-dev-execution/references/execution-lifecycle.md',
      sha256: 'b'.repeat(64),
      bytes: 42,
    }],
    totalBytes: 42,
    generatedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

test('context packet schema rejects inconsistent activation, phase, continuation, and binding combinations', () => {
  validateSchema(validPacket(), PACKET_SCHEMA);
  assert.throws(
    () => validateSchema(validPacket({ activation: 'run_declared' }), PACKET_SCHEMA),
    /oneOf/,
  );
  assert.throws(
    () => validateSchema(validPacket({ phase: 'monitor' }), PACKET_SCHEMA),
    /oneOf/,
  );
  assert.throws(
    () => validateSchema(validPacket({ continuation: null }), PACKET_SCHEMA),
    /oneOf/,
  );
  assert.throws(
    () => validateSchema(validPacket({
      binding: {
        kind: 'run',
        runId: 'run-invalid-combination',
        taskId: 'task-1',
        taskContractSha256: 'c'.repeat(64),
      },
    }), PACKET_SCHEMA),
    /oneOf/,
  );
});

test('context packet combinations stay aligned with the canonical continuation registry', () => {
  const declaredCases = PACKET_SCHEMA.oneOf
    .filter((candidate) => candidate.properties?.continuation?.type === 'object')
    .map((candidate) => ({
      id: candidate.properties.continuation.properties.id.const,
      activation: candidate.properties.activation.const,
      phase: candidate.properties.phase.const,
      bindingKind: candidate.properties.binding.properties.kind.const,
    }));
  const expectedCases = Object.entries(CONTINUATION_DEFINITIONS).map(([id, definition]) => ({
    id,
    activation: definition.activation,
    phase: definition.phase,
    bindingKind: definition.activation === 'immediate' ? 'action' : 'run',
  }));
  assert.deepEqual(
    declaredCases.sort((left, right) => left.id.localeCompare(right.id)),
    expectedCases.sort((left, right) => left.id.localeCompare(right.id)),
  );
});

test('context packet semantic validation rejects drifted metadata', () => {
  assert.throws(
    () => validateContextPacket(validPacket({ totalBytes: 41 })),
    /source byte sum 42/,
  );
  assert.throws(
    () => validateContextPacket(validPacket({
      continuation: { id: 'execution.prepare', sourceState: 'different-state' },
    })),
    /must equal.*binding\.sourceState/,
  );
  assert.throws(
    () => validateContextPacket(validPacket({ generatedAt: '2026-99-99T00:00:00.000Z' })),
    /valid canonical UTC timestamp/,
  );
  assert.throws(
    () => validateContextPacket(validPacket({
      sources: [
        validPacket().sources[0],
        { ...validPacket().sources[0], path: '.agents/duplicate.md', bytes: 0 },
      ],
    })),
    /routeId values must be unique/,
  );
});

test('immediate context packet binds the current action without exposing artifact bodies', () => {
  const fixture = contextProject('immediate');
  try {
    const result = runContext(fixture, [
      '--continuation', 'execution.prepare',
      '--json', '--metadata-only',
    ]);
    const packet = jsonPacket(result);
    assert.equal(packet.activation, 'immediate');
    assert.equal(packet.phase, 'prepare');
    assert.equal(packet.binding.kind, 'action');
    assert.equal(packet.binding.sourceState, 'gate_b_approved_needs_execution_prepare');
    assert.deepEqual(packet.sources.map((source) => source.routeId), ['execution.lifecycle']);
    assert.ok(!result.stdout.includes('Create an auditable webhook API service'));

    const modelOne = runContext(fixture, ['--continuation', 'execution.prepare']);
    const modelTwo = runContext(fixture, ['--continuation', 'execution.prepare']);
    assert.equal(modelOne.status, 0, modelOne.stderr);
    assert.equal(modelTwo.status, 0, modelTwo.stderr);
    assert.equal(modelOne.stdout, modelTwo.stdout);
    assert.match(modelOne.stdout, /BEGIN PLAN2AGENT SOURCE routeId=execution\.lifecycle/);
    assert.doesNotMatch(modelOne.stdout, /generatedAt/);

    const prepare = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One bounded work item is sufficient for the packet fixture.',
    ]);
    assert.equal(prepare.status, 0, `${prepare.stdout}\n${prepare.stderr}`);
    const stale = runContext(fixture, ['--continuation', 'execution.prepare']);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /stale action/);
  } finally {
    rmSync(fixture.targetRoot, { recursive: true, force: true });
  }
});

test('immediate action binding changes when the next-decision contract changes', () => {
  const fixture = contextProject('action-binding');
  try {
    const before = jsonPacket(runContext(fixture, [
      '--continuation', 'execution.prepare',
      '--json', '--metadata-only',
    ]));
    writeFileSync(path.join(fixture.targetRoot, '.plan2agent', 'project.config.json'), `${JSON.stringify({
      devExecution: { executionMode: 'direct' },
    }, null, 2)}\n`, 'utf8');
    const after = jsonPacket(runContext(fixture, [
      '--continuation', 'execution.prepare',
      '--json', '--metadata-only',
    ]));

    assert.notEqual(
      before.binding.artifactContractSha256,
      after.binding.artifactContractSha256,
    );
  } finally {
    rmSync(fixture.targetRoot, { recursive: true, force: true });
  }
});

test('started run packets bind command continuation and explicit closeout phase', () => {
  const fixture = contextProject('started-run');
  try {
    let result = runExecute([
      'prepare',
      '--artifacts', fixture.artifactRoot,
      '--mode', 'direct',
      '--selection-rationale', 'One bounded work item is sufficient for the packet fixture.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runIteration(['init', '--artifacts', fixture.artifactRoot, '--iteration-id', 'iter-context']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const runId = 'run-context-packet';
    result = runExecute([
      'start',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--workspace', fixture.targetRoot,
      '--json',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const owner = jsonPacket(runContext(fixture, [
      '--continuation', 'execution.owner-start',
      '--run-id', runId,
      '--json', '--metadata-only',
    ]));
    assert.equal(owner.activation, 'after_command_success');
    assert.equal(owner.binding.kind, 'run');
    assert.equal(owner.binding.runId, runId);
    assert.deepEqual(owner.sources.map((source) => source.routeId), [
      'execution.lifecycle',
      'execution.provider-confinement',
    ]);

    const closeout = jsonPacket(runContext(fixture, [
      '--phase', 'verify-closeout',
      '--run-id', runId,
      '--json', '--metadata-only',
    ]));
    assert.equal(closeout.activation, 'run_declared');
    assert.equal(closeout.continuation, null);
    assert.deepEqual(closeout.sources.map((source) => source.routeId), [
      'execution.verification-closeout',
    ]);

    const ineligible = runContext(fixture, ['--phase', 'visual-review', '--run-id', runId]);
    assert.notEqual(ineligible.status, 0);
    assert.match(ineligible.stderr, /approved visual contract/);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:node -e "process.exit(0)"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const closed = runContext(fixture, ['--phase', 'verify-closeout', '--run-id', runId]);
    assert.notEqual(closed.status, 0);
    assert.match(closed.stderr, /must be started/);
  } finally {
    rmSync(fixture.targetRoot, { recursive: true, force: true });
  }
});

test('context command rejects unbound phases and incomplete metadata mode', () => {
  const fixture = contextProject('negative-cli');
  try {
    let result = runContext(fixture, ['--phase', 'verify-closeout']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --run-id/);
    result = runContext(fixture, ['--continuation', 'execution.prepare', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--json and --metadata-only/);
  } finally {
    rmSync(fixture.targetRoot, { recursive: true, force: true });
  }
});
