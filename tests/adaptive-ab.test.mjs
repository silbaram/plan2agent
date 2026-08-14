import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  changedFiles,
  codexExecArgs,
  comparePair,
  parseCodexJsonl,
} from '../eval/adaptive-ab/run.mjs';
import { validateAdaptiveAbReport } from '../eval/adaptive-ab/validate_report.mjs';
import { ROOT } from './helpers/fixtures.mjs';

const manifestPath = path.join(ROOT, 'eval', 'adaptive-ab', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('adaptive A/B manifest covers every approved fixture category with failing seeds', () => {
  assert.equal(manifest.schema_version, 'p2a.adaptive_ab_manifest.v1');
  assert.equal(manifest.fixtures.length, 7);
  assert.equal(new Set(manifest.fixtures.map((fixture) => fixture.id)).size, 7);
  assert.equal(manifest.fixtures.filter((fixture) => fixture.kind === 'ui').length, 2);
  for (const fixture of manifest.fixtures) {
    assert.ok(fixture.a_tasks.length >= 2);
    assert.ok(fixture.allowed_paths.length >= 1);
    const fixtureRoot = path.join(ROOT, 'eval', 'adaptive-ab', fixture.path);
    const testPath = fixture.verification[0].split(' ').at(-1);
    const result = spawnSync(process.execPath, ['--test', testPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    });
    assert.notEqual(result.status, 0, `${fixture.id} seed must require implementation`);
  }
});

test('Codex JSONL parser preserves exact provider usage and final message', () => {
  const parsed = parseCodexJsonl([
    'non-json prelude',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'MODE: direct' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 6, reasoning_output_tokens: 0 } }),
  ].join('\n'));
  assert.deepEqual(parsed.usage, {
    input_tokens: 17,
    cached_input_tokens: 4,
    output_tokens: 10,
    reasoning_output_tokens: 2,
  });
  assert.equal(parsed.finalMessage, 'MODE: direct');
});

test('Codex image review separates the variadic image list from its prompt', () => {
  const args = codexExecArgs({
    workspace: '/tmp/workspace',
    prompt: 'Review the screenshots.',
    model: 'gpt-5.6-luna',
    reasoning: 'medium',
    images: ['/tmp/one.png', '/tmp/two.png'],
    outputSchema: '/tmp/schema.json',
  });
  assert.deepEqual(args.slice(-4), ['-i', '/tmp/two.png', '--', 'Review the screenshots.']);
  assert.equal(args.filter((arg) => arg === '--').length, 1);
});

test('changed file comparison detects additions, removals, and content drift', () => {
  assert.deepEqual(changedFiles(
    [{ path: 'a.js', sha256: '1' }, { path: 'removed.js', sha256: '2' }],
    [{ path: 'a.js', sha256: '3' }, { path: 'added.js', sha256: '4' }],
  ), ['a.js', 'added.js', 'removed.js']);
});

function variant(overrides = {}) {
  return {
    result: { accepted: true },
    execution: {
      task_count: 2,
      provider_calls: [{}, {}],
      usage: { input_tokens: 100, output_tokens: 10 },
      elapsed_ms: 50,
      implementation_decision_interruptions: 0,
      user_corrections: 0,
      gate_returns: 0,
      remediation_runs: 0,
    },
    verification: { first_pass_accepted: true, integration_defects: 0, evidence_complete: true },
    monitor: { scope_violations: [], rule_violations: [] },
    visual: { drift_count: 0 },
    ...overrides,
  };
}

test('pair comparison passes only when B preserves quality and autonomy', () => {
  const a = variant();
  const b = variant({
    execution: { ...variant().execution, task_count: 1, provider_calls: [{}], usage: { input_tokens: 70, output_tokens: 8 } },
  });
  assert.equal(comparePair(a, b).status, 'pass');
  assert.equal(comparePair(a, b).task_count.delta, -1);
  const regressed = variant({ monitor: { scope_violations: ['outside.js'], rule_violations: ['outside.js'] } });
  assert.equal(comparePair(a, regressed).status, 'fail');
});

test('adaptive A/B report validator seals manifest, status, refs, and evidence bytes', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'p2a-adaptive-ab-report-'));
  const fixturesDir = path.join(output, 'fixtures');
  const aPath = path.join(fixturesDir, 'fixture-one', 'a', 'variant.json');
  const bPath = path.join(fixturesDir, 'fixture-one', 'b', 'variant.json');
  mkdirSync(path.dirname(aPath), { recursive: true });
  mkdirSync(path.dirname(bPath), { recursive: true });
  writeFileSync(aPath, '{"variant":"a"}\n');
  writeFileSync(bPath, '{"variant":"b"}\n');
  const evidenceInventory = [aPath, bPath].map((filePath) => {
    const contents = readFileSync(filePath);
    return {
      path: filePath.slice(fixturesDir.length + 1).split(path.sep).join('/'),
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.length,
    };
  });
  const report = {
    schema_version: 'p2a.adaptive_ab_report.v1',
    status: 'sealed',
    generated_at: '2026-08-14T00:00:00.000Z',
    model_profile: 'gpt-5.6-luna/medium',
    manifest_ref: 'eval/adaptive-ab/manifest.json',
    manifest_sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    fixture_count: { required: 1, completed: 1 },
    fixtures: [{
      fixture_id: 'fixture-one',
      kind: 'non-ui',
      comparison: { status: 'pass' },
      a_ref: 'fixtures/fixture-one/a/variant.json',
      b_ref: 'fixtures/fixture-one/b/variant.json',
    }],
    aggregate: {},
    decisions: {
      visual_loop: 'remove_task_level_user_visual_approval',
      historical_readers: 'retain_for_declared_compatibility_period',
      rationale: 'Compatibility readers remain intentionally available.',
    },
    evidence_inventory: evidenceInventory,
    evidence_inventory_sha256: createHash('sha256').update(JSON.stringify(evidenceInventory)).digest('hex'),
  };
  const reportPath = path.join(output, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  assert.doesNotThrow(() => validateAdaptiveAbReport(reportPath));
  writeFileSync(bPath, '{"variant":"tampered"}\n');
  assert.throws(() => validateAdaptiveAbReport(reportPath), /evidence_inventory/);
});

test('sealed UI decision removes task-level user approval but preserves the final visual gate', () => {
  const executionSkill = readFileSync(path.join(ROOT, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'), 'utf8');
  const visualSkill = readFileSync(path.join(ROOT, '.agents', 'skills', 'p2a-visual-experience', 'SKILL.md'), 'utf8');
  assert.match(executionSkill, /do not ask the user to approve each task-level visual result/);
  assert.doesNotMatch(executionSkill, /ask for user visual inspection|user visually inspects/);
  assert.match(executionSkill, /runKind: final_visual_review/);
  assert.match(visualSkill, /execution owner.*does not ask the user for task-level visual approval/);
  assert.doesNotMatch(visualSkill, /user visual-inspection loop/);
});
