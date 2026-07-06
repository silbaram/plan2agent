import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function runDigest(evalDir) {
  const result = spawnSync(process.execPath, ['scripts/p2a_eval.mjs', 'digest', '--eval', evalDir, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeMetrics(evalDir) {
  writeFileSync(path.join(evalDir, 'stable-metrics.json'), `${JSON.stringify({
    schema_version: 'p2a.eval_stable_metrics.v1',
    metrics: [
      {
        id: 'failed_or_blocked_runs',
        description: 'Failed or blocked run count.',
        calculation: 'selfImprovement.runs.failedOrBlocked',
        direction: 'lower_is_better',
      },
      {
        id: 'failure_evidence_complete_rate',
        description: 'Complete structured failure evidence rate.',
        calculation: 'selfImprovement.runs.failureEvidence.completeRate',
        direction: 'higher_is_better',
      },
    ],
  }, null, 2)}\n`, 'utf8');
}

test('eval digest stable metrics are deterministic for identical inputs', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-eval-metrics-deterministic-'));
  try {
    const evalDir = path.join(tempRoot, 'eval');
    mkdirSync(evalDir, { recursive: true });
    writeMetrics(evalDir);
    const first = runDigest(evalDir).stableMetrics.results;
    const second = runDigest(evalDir).stableMetrics.results;
    assert.deepEqual(second, first);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('eval digest records baseline when no previous digest exists', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-eval-metrics-baseline-'));
  try {
    const evalDir = path.join(tempRoot, 'eval');
    mkdirSync(evalDir, { recursive: true });
    writeMetrics(evalDir);
    const digest = runDigest(evalDir);
    assert.equal(digest.stableMetrics.baseline, true);
    assert.equal(digest.stableMetrics.previousDigestId, null);
    assert.equal(digest.stableMetrics.results[0].delta, null);
    assert.equal(digest.stableMetrics.results[0].trend, 'baseline');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('eval digest computes deltas against the previous digest', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-eval-metrics-delta-'));
  try {
    const evalDir = path.join(tempRoot, 'eval');
    mkdirSync(evalDir, { recursive: true });
    writeMetrics(evalDir);
    writeFileSync(path.join(evalDir, 'eval-digest.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_digest.v1',
      digestId: 'eval-digest-previous',
      generatedAt: '2026-07-06T00:00:00.000Z',
      evalDir,
      files: { grades: 0, analyses: 0, compares: 0, skipped: 0 },
      grades: { total: 0, byVerdict: {}, nonPass: [] },
      compares: { total: 0, byVerdict: {}, failingSignals: [] },
      analyses: { total: 0, clusters: 0, byClassification: {} },
      stableMetrics: {
        definitionsPath: path.join(evalDir, 'stable-metrics.json'),
        baseline: true,
        previousDigestId: null,
        results: [
          { id: 'failed_or_blocked_runs', value: 2 },
          { id: 'failure_evidence_complete_rate', value: 0.5 },
        ],
      },
      nextActions: ['previous'],
    }, null, 2)}\n`, 'utf8');
    const digest = runDigest(evalDir);
    assert.equal(digest.stableMetrics.baseline, false);
    assert.equal(digest.stableMetrics.previousDigestId, 'eval-digest-previous');
    assert.deepEqual(digest.stableMetrics.results.map((metric) => [metric.id, metric.delta, metric.trend]), [
      ['failed_or_blocked_runs', -2, 'improved'],
      ['failure_evidence_complete_rate', null, 'baseline'],
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
