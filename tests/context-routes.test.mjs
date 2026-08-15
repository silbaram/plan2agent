import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditContext } from '../scripts/p2a_context_audit.mjs';
import {
  loadContextRoutes,
  resolveRuntimeContext,
} from '../scripts/p2a_context_routes.mjs';
import { ROOT } from './helpers/fixtures.mjs';

function tempContextRoot(label) {
  const targetRoot = mkdtempSync(path.join(tmpdir(), `p2a-context-routes-${label}-`));
  cpSync(path.join(ROOT, '.agents'), path.join(targetRoot, '.agents'), { recursive: true });
  cpSync(path.join(ROOT, '.claude'), path.join(targetRoot, '.claude'), { recursive: true });
  return targetRoot;
}

test('runtime and audit use the same phase-selected source paths and hashes', () => {
  for (const provider of ['codex', 'claude', 'gemini']) {
    const runtime = resolveRuntimeContext({
      targetRoot: ROOT,
      provider,
      skill: 'p2a-dev-execution',
      phase: 'prepare',
      mode: 'direct',
    });
    assert.deepEqual(runtime.sources.map((source) => source.routeId), ['execution.lifecycle']);

    const audit = auditContext(ROOT, {
      scenario: {
        skill: 'p2a-dev-execution',
        stage: 'gate-c',
        phase: 'prepare',
        executionMode: 'direct',
        conditions: [],
      },
    });
    assert.equal(audit.status, 'pass');
    const auditReferences = audit.contexts
      .find((context) => context.provider === provider)
      .sources
      .filter((source) => source.role === 'reference')
      .map(({ path: sourcePath, sha256 }) => ({ path: sourcePath, sha256 }));
    assert.deepEqual(
      runtime.sources.map(({ path: sourcePath, sha256 }) => ({ path: sourcePath, sha256 })),
      auditReferences,
    );
  }
});

test('owner-start resolves lifecycle and confinement exactly once', () => {
  const runtime = resolveRuntimeContext({
    targetRoot: ROOT,
    provider: 'codex',
    skill: 'p2a-dev-execution',
    phase: 'owner-start',
    mode: 'planned',
  });
  assert.deepEqual(runtime.sources.map((source) => source.routeId), [
    'execution.lifecycle',
    'execution.provider-confinement',
  ]);
  assert.equal(new Set(runtime.sources.map((source) => source.path)).size, 2);
});

test('runtime rollout rejects unsupported mode and ineligible review phases', () => {
  assert.throws(() => resolveRuntimeContext({
    targetRoot: ROOT,
    provider: 'codex',
    phase: 'batch',
    mode: 'orchestrated',
  }), /Direct\/Planned non-batch/);
  assert.throws(() => resolveRuntimeContext({
    targetRoot: ROOT,
    provider: 'codex',
    phase: 'visual-review',
    mode: 'direct',
    eligibility: { runKind: null, visualContract: false },
  }), /approved visual contract/);
  assert.throws(() => resolveRuntimeContext({
    targetRoot: ROOT,
    provider: 'codex',
    phase: 'verify-closeout',
    mode: 'direct',
    eligibility: { runKind: 'final_visual_review' },
  }), /ordinary implementation run/);
});

test('dedicated review eligibility selects only its own reference', () => {
  const cases = [
    ['visual-review', { runKind: 'final_visual_review', visualContract: true }, 'execution.visual-evidence'],
    ['acceptance-review', { runKind: 'final_acceptance_review', acceptanceActive: true }, 'execution.acceptance-review'],
    ['monitor', { runKind: null, monitorRequired: true }, 'execution.monitor-gate'],
    ['verify-closeout', { runKind: null }, 'execution.verification-closeout'],
  ];
  for (const [phase, eligibility, routeId] of cases) {
    const runtime = resolveRuntimeContext({
      targetRoot: ROOT,
      provider: 'codex',
      phase,
      mode: 'direct',
      eligibility,
    });
    assert.deepEqual(runtime.sources.map((source) => source.routeId), [routeId]);
  }
});

test('route validation rejects duplicate ids and unknown phases', () => {
  const targetRoot = tempContextRoot('invalid-manifest');
  try {
    const manifestPath = path.join(targetRoot, '.agents', 'context-routes.json');
    const routes = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const execution = routes.skills.find((skill) => skill.id === 'p2a-dev-execution');
    execution.references[1].id = execution.references[0].id;
    writeFileSync(manifestPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextRoutes(targetRoot), /duplicate context route id/);

    execution.references[1].id = 'execution.provider-confinement';
    execution.references[1].phases = ['unknown-phase'];
    writeFileSync(manifestPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextRoutes(targetRoot), /must be one of/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('runtime source confinement rejects missing files and symlink escapes', () => {
  const targetRoot = tempContextRoot('source-confinement');
  const externalRoot = mkdtempSync(path.join(tmpdir(), 'p2a-context-routes-external-'));
  try {
    const referencePath = path.join(
      targetRoot,
      '.agents',
      'skills',
      'p2a-dev-execution',
      'references',
      'execution-lifecycle.md',
    );
    const externalPath = path.join(externalRoot, 'outside.md');
    writeFileSync(externalPath, 'outside\n', 'utf8');
    rmSync(referencePath);
    symlinkSync(externalPath, referencePath);
    assert.throws(() => resolveRuntimeContext({
      targetRoot,
      provider: 'codex',
      phase: 'prepare',
      mode: 'direct',
    }), /regular non-symlink file/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});
