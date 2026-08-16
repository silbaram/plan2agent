import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SanitizedAgyToolTrace,
  computeEvaluationSummary,
  createIsolatedSourceSnapshot,
  evaluateGeminiPerformanceGate,
  gradeResult,
  isScopeOverlappingCanonical,
  parseArgs,
  sourceManifest,
  validateAndCleanSnapshot,
  validateOutputDir,
} from './run-agy-ab.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../../../../..');

describe('Gemini A/B Runner Safety & Logic Tests', () => {
  it('sourceManifest excludes plans/evidence and produces valid SHA256', () => {
    const manifest = sourceManifest(ROOT);
    assert.ok(manifest.files > 0, 'manifest should have files');
    assert.equal(manifest.sha256.length, 64, 'valid sha256 hex string');
  });

  it('createIsolatedSourceSnapshot copies files without evidence and cleans up safely', () => {
    const snapshot = createIsolatedSourceSnapshot(ROOT, 'test-unit');
    try {
      assert.ok(snapshot.path.length > 0, 'snapshot path exists');
      assert.ok(snapshot.path.includes('p2a-gemini-test-unit-'), 'has p2a-gemini prefix');
      assert.equal(snapshot.manifest.files, sourceManifest(ROOT).files, 'file count matches');
      assert.equal(snapshot.manifest.sha256, sourceManifest(ROOT).sha256, 'sha256 matches');
    } finally {
      snapshot.cleanup();
    }
    assert.equal(existsSync(snapshot.path), false, 'directory should be deleted after cleanup');
  });

  it('validateAndCleanSnapshot rejects non-snapshot or invalid prefix targets with path.sep boundary', () => {
    assert.throws(() => validateAndCleanSnapshot('/etc'), /Snapshot cleanup aborted/);
    assert.throws(() => validateAndCleanSnapshot(ROOT), /Snapshot cleanup aborted/);

    const validTmpNonP2A = mkdtempSync(path.join(os.tmpdir(), 'other-prefix-'));
    try {
      assert.throws(() => validateAndCleanSnapshot(validTmpNonP2A), /does not have prefix 'p2a-gemini-'/);
    } finally {
      rmSync(validTmpNonP2A, { recursive: true, force: true });
    }
  });

  it('validateOutputDir rejects CE-011 and existing evidence directories', () => {
    assert.throws(
      () => validateOutputDir(path.join(ROOT, 'plans/evidence/context-engineering/CE-011-gemini-runtime-routing-ab/agy')),
      /cannot target existing CE-011 evidence/
    );

    const tempWithEvidence = mkdtempSync(path.join(os.tmpdir(), 'p2a-test-output-'));
    try {
      writeFileSync(path.join(tempWithEvidence, 'gemini-ab-summary.json'), '{}');
      assert.throws(
        () => validateOutputDir(tempWithEvidence),
        /already contains existing evaluation evidence/
      );
    } finally {
      rmSync(tempWithEvidence, { recursive: true, force: true });
    }
  });

  const sampleAllowlist = [
    { id: 'skill:p2a-spec', paths: ['.agents/skills/p2a-spec/SKILL.md', path.join(ROOT, '.agents/skills/p2a-spec/SKILL.md')] },
    { id: 'reference:execution-lifecycle', paths: ['.agents/skills/p2a-dev-execution/references/execution-lifecycle.md'] },
  ];

  it('Case 1: Workspace scope search unrelated to canonical routes does not fail packet attribution', () => {
    const trace = new SanitizedAgyToolTrace(sampleAllowlist, { workspaceRoot: ROOT });
    // Search in src/ which does not overlap .agents/...
    trace.observeTool('grep_search', { SearchPath: path.join(ROOT, 'src') });
    const summary = trace.summary();

    assert.equal(summary.operations[0].attributionLevel, 'scope');
    assert.equal(summary.operations[0].packetManagedUnattributed, false);
    assert.equal(summary.metrics.scopeAttributedReadOperations, 1);
    assert.equal(summary.metrics.packetManagedUnattributedReadOperations, 0);
    assert.equal(summary.metrics.packetManagedAttributionComplete, true);
  });

  it('Case 2: Search overlapping canonical routes without matchedFiles fails packet attribution', () => {
    const trace = new SanitizedAgyToolTrace(sampleAllowlist, { workspaceRoot: ROOT });
    // Search in .agents which overlaps canonical matchers
    trace.observeTool('grep_search', { SearchPath: path.join(ROOT, '.agents/skills') });
    const summary = trace.summary();

    assert.equal(summary.operations[0].attributionLevel, 'scope');
    assert.equal(summary.operations[0].packetManagedUnattributed, true);
    assert.equal(summary.metrics.scopeAttributedReadOperations, 1);
    assert.equal(summary.metrics.packetManagedUnattributedReadOperations, 1);
    assert.equal(summary.metrics.packetManagedAttributionComplete, false);
  });

  it('Case 3: Canonical search with matchedFiles elevates to file/canonical attribution level', () => {
    const trace = new SanitizedAgyToolTrace(sampleAllowlist, { workspaceRoot: ROOT });
    trace.observeTool(
      'grep_search',
      { SearchPath: path.join(ROOT, '.agents/skills') },
      false,
      { matchedFiles: ['.agents/skills/p2a-spec/SKILL.md'] }
    );
    const summary = trace.summary();

    assert.equal(summary.operations[0].attributionLevel, 'canonical');
    assert.equal(summary.operations[0].sourceIds.includes('skill:p2a-spec'), true);
    assert.equal(summary.metrics.packetManagedUnattributedReadOperations, 0);
    assert.equal(summary.metrics.packetManagedAttributionComplete, true);
  });

  it('Case 4: Workspace-other repeated reads do not count as canonical packet-managed repeated reads', () => {
    const trace = new SanitizedAgyToolTrace(sampleAllowlist, { workspaceRoot: ROOT });
    // 1 canonical read (single)
    trace.observeTool('view_file', { AbsolutePath: path.join(ROOT, '.agents/skills/p2a-spec/SKILL.md') });
    // 3 repeated reads of a non-canonical workspace file
    trace.observeTool('view_file', { AbsolutePath: path.join(ROOT, 'src/util.ts') });
    trace.observeTool('view_file', { AbsolutePath: path.join(ROOT, 'src/util.ts') });
    trace.observeTool('view_file', { AbsolutePath: path.join(ROOT, 'src/util.ts') });

    const summary = trace.summary();

    assert.equal(summary.metrics.canonicalUniqueSourcesRead, 1);
    assert.equal(summary.metrics.canonicalSourceReadOccurrences, 1);
    assert.equal(summary.metrics.packetManagedRepeatedSourceReads, 0, 'canonical repeated reads must be 0');

    assert.equal(summary.metrics.repeatedSourceReads, 2, 'total repeated reads include workspace-other');
    assert.equal(summary.metrics.workspaceOtherReadOperations, 3);
    assert.equal(summary.metrics.packetManagedAttributionComplete, true);
  });

  it('SanitizedAgyToolTrace handles unavailable status when exitCode != 0 and zero tool operations', () => {
    const trace = new SanitizedAgyToolTrace([], { workspaceRoot: ROOT });
    const summary = trace.summary({ exitCode: 1 });
    assert.equal(summary.status, 'unavailable', 'status should be unavailable on error with 0 ops');
    assert.equal(summary.metrics.toolOperations, 0);
  });

  it('Recomputes a portable synthetic 30-run fixture with strict verdict & uncached nulling', () => {
    const scenarioIds = ['gate-b-spec', 'direct-execution', 'planned-retry'];
    const runs = ['baseline', 'candidate'].flatMap((variant) => (
      scenarioIds.flatMap((scenarioId) => (
        Array.from({ length: 5 }, (_, index) => {
          const trace = new SanitizedAgyToolTrace([], { workspaceRoot: ROOT });
          trace.observeTool('view_file', { AbsolutePath: path.join(ROOT, 'scripts/p2a.mjs') });
          return {
            variant,
            scenarioId,
            repetition: index + 1,
            metadata: {
              execution: {
                usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
                durationMs: 100,
                toolCalls: 1,
                toolFailures: 0,
                toolTrace: trace.summary(),
              },
            },
            grade: { verdict: 'pass' },
            result: { scenarioId },
          };
        })
      ))
    ));
    assert.equal(runs.length, 30);
    const manifest = sourceManifest(ROOT);
    const recomputed = computeEvaluationSummary({
      evaluationId: 'ce-012-gemini-runtime-routing-2026-08-16',
      model: 'gemini-3.7-flash-medium',
      repetitions: 5,
      selectedScenarios: scenarioIds.map((id) => ({ id })),
      sourceManifestData: manifest,
      contractSha: 'a'.repeat(64),
      schemaSha: 'b'.repeat(64),
      runs,
      runEvidence: [],
    });

    assert.equal(recomputed.baseline.uncachedInputTokens, null);
    assert.equal(recomputed.candidate.uncachedInputTokens, null);
    assert.equal(recomputed.uncachedInputTokenDelta, null);

    const uncachedCheck = recomputed.performanceGate.checks.some((c) => c.id === 'aggregate_uncached_input_tokens');
    assert.equal(uncachedCheck, false, 'uncached input check must be excluded');
    assert.ok(recomputed.performanceGate.excludedChecks.length > 0);

    assert.equal(recomputed.performanceGate.verdict, 'fail');
    assert.equal(recomputed.providerVerdict, 'provider_limited');
    assert.equal(recomputed.coverageComplete, true);
    assert.equal(recomputed.candidateAllPass, true);
    assert.equal(recomputed.regression, false);
  });

  it('Dry-run arguments parsing defaults to CE-012 output and ce-012 evaluationId', () => {
    const args = parseArgs(['--dry-run', '--repetitions', '5']);
    assert.equal(args.dryRun, true);
    assert.equal(args.repetitions, 5);
    assert.equal(args.evaluationId, 'ce-012-gemini-runtime-routing-2026-08-16');
    assert.ok(args.output.includes('CE-012-gemini-runtime-routing-ab'), 'output should point to CE-012');
  });
});
