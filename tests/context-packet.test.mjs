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

import { validateSchema } from '../scripts/validate_artifacts.mjs';
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
