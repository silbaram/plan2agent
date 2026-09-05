import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { auditContext } from '../scripts/p2a_context_audit.mjs';
import { validateSchema } from '../scripts/p2a_schema.mjs';
import {
  formatCommandResult,
  makeTempDir,
  ROOT,
  runDoctor,
  runHandoff,
} from './helpers/fixtures.mjs';

const ROUTES_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'context-routes.schema.json'), 'utf8'));
const AUDIT_SCHEMA = JSON.parse(readFileSync(path.join(ROOT, 'schemas', 'context-audit.schema.json'), 'utf8'));

function referenceRouteSignature(reference) {
  const parts = [
    `${reference.required ? 'Required' : 'Optional'}, ${reference.load}`,
    `stages: ${reference.stages.join(', ')}`,
  ];
  if (reference.modes?.length) parts.push(`modes: ${reference.modes.join(', ')}`);
  if (reference.providers?.length) parts.push(`providers: ${reference.providers.join(', ')}`);
  if (reference.provider_paths?.length) {
    parts.push(`provider paths: ${reference.provider_paths
      .map((item) => `${item.provider}=\`${item.path}\``)
      .join(', ')}`);
  }
  const referencePath = reference.source_skill
    ? `.agents/skills/${reference.source_skill}/${reference.path}`
    : reference.path;
  return `${parts.join('; ')} — \`${referencePath}\` — ${reference.condition}`;
}

test('canonical context routes produce a schema-valid provider and stage audit', () => {
  const routes = JSON.parse(readFileSync(path.join(ROOT, '.agents', 'context-routes.json'), 'utf8'));
  assert.doesNotThrow(() => validateSchema(routes, ROUTES_SCHEMA));
  assert.ok(routes.skills.flatMap((skill) => skill.references).every((reference) => (
    typeof reference.required === 'boolean'
  )));

  const report = auditContext(ROOT);
  assert.doesNotThrow(() => validateSchema(report, AUDIT_SCHEMA));
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.providers.map((item) => item.provider), ['codex', 'claude', 'gemini']);
  assert.ok(report.summary.contextCount > 0);
  assert.ok(report.summary.alwaysLoadedBytes > 0);
  assert.ok(report.summary.estimatedTokens > 0);

  const harnessGateA = report.contexts.find((context) => (
    context.provider === 'gemini'
      && context.skill === 'p2a-harness'
      && context.stage === 'gate-a'
  ));
  assert.ok(harnessGateA);
  assert.ok(harnessGateA.sources.some((source) => source.path.endsWith('references/existing-documents.md')));
  assert.ok(harnessGateA.sources.some((source) => source.path.endsWith('references/buildlore-knowledge.md')));
  assert.equal(
    harnessGateA.sources.find((source) => source.path.endsWith('references/existing-documents.md')).required,
    true,
  );
  assert.equal(
    harnessGateA.sources.find((source) => source.path.endsWith('references/buildlore-knowledge.md')).required,
    false,
  );
  assert.ok(harnessGateA.sources.some((source) => source.role === 'provider-adapter'));
});

test('doctor context mode is harness-independent and supports JSON, human, and strict output', () => {
  let result = runDoctor(['--target', ROOT, '--context', '--json', '--strict']);
  assert.equal(result.status, 0, formatCommandResult(result));
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, 'p2a.context_audit.v1');
  assert.equal(report.status, 'pass');

  result = runDoctor(['--target', ROOT, '--context']);
  assert.equal(result.status, 0, formatCommandResult(result));
  assert.match(result.stdout, /Plan2Agent context audit: pass/);
  assert.match(result.stdout, /declared bytes:/);
  assert.match(result.stdout, /unique resolved corpus:/);
  assert.match(result.stdout, /codex:/);
  assert.doesNotMatch(result.stdout, /\.plan2agent directory is missing/);
});

const SHARED_REFERENCES = [
  { skill: 'p2a-next', stage: 'closeout', owner: 'p2a-dev-execution', file: 'closeout-choices.md' },
  { skill: 'p2a-task-breakdown', stage: 'gate-c', owner: 'p2a-task-author', file: 'draft-contract.md' },
];

for (const { skill, stage, owner, file } of SHARED_REFERENCES) {
  test(`${skill} audits its shared reference only when selected and counts the real source bytes`, () => {
    const conditionId = `reference:${skill}:references/${file}`;
    const scenario = { skill, stage, conditions: [] };
    const unloaded = auditContext(ROOT, { scenario });
    const loaded = auditContext(ROOT, { scenario: { ...scenario, conditions: [conditionId] } });
    const inventory = auditContext(ROOT);
    assert.equal(unloaded.status, 'pass');
    assert.equal(loaded.status, 'pass');
    assert.equal(inventory.status, 'pass');
    for (const context of loaded.contexts) {
      const sourcePath = `${context.provider === 'claude' ? '.claude' : '.agents'}/skills/${owner}/references/${file}`;
      const body = readFileSync(path.join(ROOT, sourcePath), 'utf8').replace(/\r\n?/g, '\n');
      const references = context.sources.filter((source) => source.role === 'reference');
      assert.equal(references.length, 1);
      assert.equal(references[0].path, sourcePath);
      assert.equal(references[0].conditionId, conditionId);
      assert.equal(references[0].bytes, Buffer.byteLength(body, 'utf8'));
      assert.equal(references[0].sha256, createHash('sha256').update(body, 'utf8').digest('hex'));
      const inactive = unloaded.contexts.find((item) => item.provider === context.provider);
      assert.ok(inactive.sources.every((source) => source.role !== 'reference'));
      assert.equal(context.totals.promptBytes - inactive.totals.promptBytes, references[0].bytes);
      const declared = inventory.contexts.find((item) => (
        item.provider === context.provider && item.skill === skill && item.stage === stage
      ));
      assert.ok(declared.sources.some((source) => source.path === sourcePath));
    }
  });
}

test('context audit fails when a linked shared reference is omitted from consumer routes', () => {
  const targetRoot = makeTempDir('p2a-context-unrouted-shared-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const routesPath = path.join(targetRoot, '.agents', 'context-routes.json');
    const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
    for (const { skill } of SHARED_REFERENCES) {
      routes.skills.find((item) => item.id === skill).references = [];
    }
    writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    for (const { skill } of SHARED_REFERENCES) {
      assert.ok(report.diagnostics.some((item) => (
        item.code === 'unrouted_shared_reference'
          && item.paths?.includes(`.agents/skills/${skill}/SKILL.md`)
      )));
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('shared consumer audits detect missing source files and provider mirror drift', () => {
  const targetRoot = makeTempDir('p2a-context-shared-source-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const relativePath = '.claude/skills/p2a-dev-execution/references/closeout-choices.md';
    const sourcePath = path.join(targetRoot, relativePath);
    const options = { scenario: {
      skill: 'p2a-next', stage: 'closeout',
      conditions: ['reference:p2a-next:references/closeout-choices.md'],
    } };
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nMirror drift.\n`, 'utf8');
    let report = auditContext(targetRoot, options);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'provider_skill_mirror_drift' && item.paths?.includes(relativePath)
    )));
    rmSync(sourcePath);
    report = auditContext(targetRoot, options);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'missing_context_source' && item.paths?.includes(relativePath)
    )));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit candidate evidence omits prompt content and identifies source owners', () => {
  const targetRoot = makeTempDir('p2a-context-redacted-evidence-');
  const secretMarker = 'PRIVATE-CUSTOMER-PROMPT-DO-NOT-COPY';
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const duplicate = `Always preserve ${secretMarker} with enough repeated diagnostic context to exceed the paragraph threshold while validating private prompt redaction in audit output.`;
    for (const relativePath of [
      ['.agents', 'skills', 'p2a-next', 'SKILL.md'],
      ['.agents', 'skills', 'p2a-harness', 'SKILL.md'],
    ]) {
      const filePath = path.join(targetRoot, ...relativePath);
      writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n\n${duplicate}\n`, 'utf8');
    }
    const positivePath = path.join(targetRoot, '.agents', 'skills', 'p2a-spec', 'SKILL.md');
    const negativePath = path.join(targetRoot, '.agents', 'skills', 'p2a-task-author', 'SKILL.md');
    writeFileSync(
      positivePath,
      `${readFileSync(positivePath, 'utf8')}\nAlways preserve ${secretMarker} during the private evidence review boundary.\n`,
      'utf8',
    );
    writeFileSync(
      negativePath,
      `${readFileSync(negativePath, 'utf8')}\nNever preserve ${secretMarker} during the private evidence review boundary.\n`,
      'utf8',
    );

    const report = auditContext(targetRoot);
    const serialized = JSON.stringify(report);
    const injectedDuplicate = report.duplicateClusters.find((cluster) => {
      const paths = new Set(cluster.occurrences.map((occurrence) => occurrence.path));
      return paths.has('.agents/skills/p2a-next/SKILL.md')
        && paths.has('.agents/skills/p2a-harness/SKILL.md');
    });
    assert.ok(injectedDuplicate);
    assert.ok(report.duplicateClusters.every((cluster) => cluster.preview.startsWith('sha256:')));
    assert.ok(injectedDuplicate.occurrences.every((occurrence) => occurrence.owner === 'skill'));
    assert.ok(report.conflictCandidates.length > 0);
    assert.ok(report.conflictCandidates.every((candidate) => (
      candidate.preview.startsWith('sha256:')
        && [...candidate.positiveOccurrences, ...candidate.negativeOccurrences]
          .every((occurrence) => occurrence.text.startsWith('sha256:') && occurrence.owner)
    )));
    assert.ok(report.diagnostics.find((item) => item.code === 'duplicate_instruction_candidates')?.owners?.includes('skill'));
    assert.ok(!serialized.includes(secretMarker));
    assert.doesNotThrow(() => validateSchema(report, AUDIT_SCHEMA));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit resolves one provider-comparable stage and execution-mode scenario', () => {
  const conditionId = 'reference:p2a-dev-execution:references/batch-execution.md';
  const report = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-dev-execution',
      stage: 'execution',
      executionMode: 'orchestrated',
      conditions: [conditionId],
    },
  });
  assert.doesNotThrow(() => validateSchema(report, AUDIT_SCHEMA));
  assert.equal(report.status, 'pass');
  assert.equal(report.measurement, 'assembled');
  assert.equal(report.summary.contextCount, 3);
  assert.deepEqual(report.contexts.map((context) => context.provider), ['claude', 'codex', 'gemini']);
  assert.ok(report.contexts.every((context) => context.sources.some((source) => source.conditionId === conditionId)));
  assert.ok(report.contexts.every((context) => context.totals.promptBytes === (
    context.totals.alwaysLoadedBytes + context.totals.conditionalBytes
  )));
  assert.ok(report.instructionOwners.some((owner) => owner.owner === 'schema'));
  assert.ok(report.instructionOwners.some((owner) => owner.owner === 'cli'));
  assert.ok(report.instructionOwners.some((owner) => owner.owner === 'hook'));

  const direct = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-dev-execution',
      stage: 'execution',
      executionMode: 'direct',
      conditions: [conditionId],
    },
  });
  assert.ok(direct.contexts.every((context) => context.sources.every((source) => source.conditionId !== conditionId)));
  assert.equal(direct.status, 'warn');
  assert.ok(direct.diagnostics.some((item) => item.code === 'inapplicable_context_condition'));
});

test('assembled context duplicate and conflict candidates only use loaded scenario sources', () => {
  const report = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-next',
      stage: 'entry',
      executionMode: null,
      conditions: [],
    },
  });
  assert.equal(report.measurement, 'assembled');
  const loadedPaths = new Set(report.contexts.flatMap((context) => (
    context.sources.map((source) => source.path)
  )));
  const reportedPaths = new Set([
    ...report.duplicateClusters.flatMap((cluster) => (
      cluster.occurrences.map((occurrence) => occurrence.path)
    )),
    ...report.conflictCandidates.flatMap((candidate) => [
      ...candidate.positiveOccurrences.map((occurrence) => occurrence.path),
      ...candidate.negativeOccurrences.map((occurrence) => occurrence.path),
    ]),
  ]);
  assert.ok([...reportedPaths].every((sourcePath) => loadedPaths.has(sourcePath)));
  assert.ok(!reportedPaths.has('.agents/agents/p2a-performance-monitor.md'));
  assert.ok(!reportedPaths.has('.agents/skills/p2a-spec/references/spec-contract.md'));
  assert.ok(!report.duplicateClusters.some((cluster) => {
    const paths = new Set(cluster.occurrences.map((occurrence) => occurrence.path));
    return paths.has('.agents/skills/p2a-next/SKILL.md')
      && paths.has('.claude/skills/p2a-next/SKILL.md');
  }));
});

test('assembled context diagnostics retain duplicates that coexist in one provider prompt', () => {
  const targetRoot = makeTempDir('p2a-context-provider-local-duplicate-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const paragraph = '# Always preserve provider-local context evidence when two loaded instruction sources repeat this deliberately long diagnostic paragraph for the same assembled prompt.\n';
    for (const filePath of [
      path.join(targetRoot, '.agents', 'skills', 'p2a-next', 'SKILL.md'),
      path.join(targetRoot, '.claude', 'skills', 'p2a-next', 'SKILL.md'),
      path.join(targetRoot, '.gemini', 'commands', 'p2a', 'next.toml'),
    ]) {
      writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n${paragraph}`, 'utf8');
    }

    const report = auditContext(targetRoot, {
      scenario: {
        skill: 'p2a-next',
        stage: 'entry',
        executionMode: null,
        conditions: [],
      },
    });
    const providerLocalCluster = report.duplicateClusters.find((cluster) => {
      const paths = new Set(cluster.occurrences.map((occurrence) => occurrence.path));
      return paths.has('.agents/skills/p2a-next/SKILL.md')
        && paths.has('.gemini/commands/p2a/next.toml');
    });
    assert.ok(providerLocalCluster);
    assert.ok(!report.duplicateClusters.some((cluster) => {
      const paths = new Set(cluster.occurrences.map((occurrence) => occurrence.path));
      return paths.has('.agents/skills/p2a-next/SKILL.md')
        && paths.has('.claude/skills/p2a-next/SKILL.md');
    }));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit compares a baseline and flags conditional sources promoted to always', () => {
  const baseline = auditContext(ROOT);
  const promotedPath = '.agents/skills/p2a-next/SKILL.md';
  for (const context of baseline.contexts) {
    for (const source of context.sources) {
      if (source.path === promotedPath) source.load = 'conditional';
    }
  }
  const report = auditContext(ROOT, { baseline });
  assert.equal(report.status, 'warn');
  assert.ok(report.baselineComparison.conditionalPromotedToAlways.includes(promotedPath));
  assert.ok(report.diagnostics.some((item) => (
    item.code === 'conditional_context_promoted_to_always'
      && item.paths?.includes(promotedPath)
      && item.owners?.includes('skill')
  )));
});

test('context baseline detects same-byte source content drift and strict doctor rejects it', () => {
  const targetRoot = makeTempDir('p2a-context-content-drift-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const baseline = auditContext(targetRoot);
    const baselinePath = path.join(targetRoot, 'context-baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    for (const providerRoot of ['.agents', '.claude']) {
      const skillPath = path.join(targetRoot, providerRoot, 'skills', 'p2a-next', 'SKILL.md');
      const original = readFileSync(skillPath, 'utf8');
      const changed = original.replace('only decision authority', 'sole decision authority');
      assert.equal(changed.length, original.length);
      assert.notEqual(changed, original);
      writeFileSync(skillPath, changed, 'utf8');
    }

    const report = auditContext(targetRoot, { baseline });
    assert.equal(report.status, 'warn');
    assert.equal(report.baselineComparison.alwaysLoadedBytesDelta, 0);
    assert.equal(report.baselineComparison.promptBytesDelta, 0);
    assert.ok(report.baselineComparison.contentChangedSources.length > 0);
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'context_source_content_changed'
        && item.owners?.includes('skill')
    )));

    const strict = runDoctor([
      '--target', targetRoot,
      '--context',
      '--baseline', baselinePath,
      '--strict',
    ]);
    assert.notEqual(strict.status, 0, formatCommandResult(strict));
    assert.match(strict.stdout, /WARN context_source_content_changed/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit rejects malformed baselines and warns before comparing different measurements', () => {
  const malformed = auditContext(ROOT, {
    baseline: { schema_version: 'p2a.context_audit.v1' },
  });
  assert.equal(malformed.status, 'fail');
  assert.ok(malformed.diagnostics.some((item) => item.code === 'invalid_context_baseline'));

  const assembledBaseline = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-next',
      stage: 'entry',
      executionMode: null,
      conditions: [],
    },
  });
  const inventory = auditContext(ROOT, { baseline: assembledBaseline });
  assert.equal(inventory.status, 'warn');
  assert.equal(inventory.baselineComparison.measurementMatches, false);
  assert.equal(inventory.baselineComparison.comparable, false);
  assert.equal(inventory.baselineComparison.alwaysLoadedBytesDelta, null);
  assert.equal(inventory.baselineComparison.promptBytesDelta, null);
  assert.ok(inventory.diagnostics.some((item) => item.code === 'context_baseline_measurement_mismatch'));
});

test('context audit refuses deltas for different assembled scenarios or provider sets', () => {
  const baseline = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-harness',
      stage: 'gate-a',
      executionMode: null,
      conditions: [],
    },
  });
  const differentScenario = auditContext(ROOT, {
    scenario: {
      skill: 'p2a-dev-execution',
      stage: 'execution',
      executionMode: 'orchestrated',
      conditions: [],
    },
    baseline,
  });
  assert.equal(differentScenario.status, 'warn');
  assert.equal(differentScenario.baselineComparison.measurementMatches, true);
  assert.equal(differentScenario.baselineComparison.scenarioMatches, false);
  assert.equal(differentScenario.baselineComparison.comparable, false);
  assert.equal(differentScenario.baselineComparison.promptBytesDelta, null);
  assert.ok(differentScenario.diagnostics.some((item) => (
    item.code === 'context_baseline_scenario_mismatch'
  )));

  const providerBaseline = structuredClone(baseline);
  providerBaseline.providers = providerBaseline.providers.filter((item) => item.provider !== 'gemini');
  const differentProviders = auditContext(ROOT, {
    scenario: baseline.scenario,
    baseline: providerBaseline,
  });
  assert.equal(differentProviders.status, 'warn');
  assert.equal(differentProviders.baselineComparison.providerSetMatches, false);
  assert.equal(differentProviders.baselineComparison.comparable, false);
  assert.ok(differentProviders.diagnostics.some((item) => (
    item.code === 'context_baseline_provider_mismatch'
  )));
});

test('context audit reports opposite-polarity instruction candidates for review', () => {
  const targetRoot = makeTempDir('p2a-context-conflict-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const firstRelative = path.join('skills', 'p2a-next', 'SKILL.md');
    const secondRelative = path.join('skills', 'p2a-harness', 'SKILL.md');
    const positive = '\nAlways preserve the deployment authority boundary after verification and before release.\n';
    const negative = '\nNever preserve the deployment authority boundary after verification and before release.\n';
    for (const rootName of ['.agents', '.claude']) {
      const firstPath = path.join(targetRoot, rootName, firstRelative);
      const secondPath = path.join(targetRoot, rootName, secondRelative);
      writeFileSync(firstPath, `${readFileSync(firstPath, 'utf8')}${positive}`, 'utf8');
      writeFileSync(secondPath, `${readFileSync(secondPath, 'utf8')}${negative}`, 'utf8');
    }

    const report = auditContext(targetRoot);
    assert.equal(report.status, 'pass');
    assert.ok(report.summary.conflictCandidates > 0);
    assert.ok(report.diagnostics.some((item) => item.code === 'conflicting_instruction_candidates'));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit detects generated provider drift', () => {
  const targetRoot = makeTempDir('p2a-context-drift-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    rmSync(path.join(targetRoot, '.gemini', 'commands', 'p2a', 'harness.toml'));
    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'missing_context_source'
        && item.paths?.includes('.gemini/commands/p2a/harness.toml')
    )));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit rejects a route manifest that fails its canonical schema', () => {
  const targetRoot = makeTempDir('p2a-context-invalid-routes-');
  try {
    mkdirSync(path.join(targetRoot, '.agents'), { recursive: true });
    writeFileSync(path.join(targetRoot, '.agents', 'context-routes.json'), `${JSON.stringify({
      schema_version: 'p2a.context_routes.v1',
      providers: ['codex'],
      skills: [],
      agents: [],
      unexpected: true,
    }, null, 2)}\n`, 'utf8');

    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.equal(report.summary.contextCount, 0);
    assert.ok(report.diagnostics.some((item) => item.code === 'invalid_route_manifest_schema'));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context route schema resolves nested definitions instead of accepting invalid modes', () => {
  const targetRoot = makeTempDir('p2a-context-invalid-nested-route-');
  try {
    mkdirSync(path.join(targetRoot, '.agents'), { recursive: true });
    writeFileSync(path.join(targetRoot, '.agents', 'context-routes.json'), `${JSON.stringify({
      schema_version: 'p2a.context_routes.v1',
      providers: ['codex'],
      skills: [{
        id: 'p2a-next',
        stages: ['entry'],
        gemini_command: 'next',
        modes: ['improvised'],
        references: [],
      }],
      agents: [],
      authorities: [],
    }, null, 2)}\n`, 'utf8');

    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => item.code === 'invalid_route_manifest_schema'));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit rejects canonical skill routing semantics that drift from the manifest', () => {
  const targetRoot = makeTempDir('p2a-context-canonical-route-drift-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const routesPath = path.join(targetRoot, '.agents', 'context-routes.json');
    const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
    const harness = routes.skills.find((skill) => skill.id === 'p2a-harness');
    const reference = harness.references.find((item) => (
      item.path === 'references/existing-documents.md'
    ));
    reference.condition = 'The active entry contains a newly approved reusable baseline.';
    writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');

    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'canonical_skill_route_drift'
        && item.paths?.includes('.agents/skills/p2a-harness/SKILL.md')
    )));
    assert.ok(!report.diagnostics.some((item) => item.code === 'provider_adapter_route_drift'));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context routes support provider restrictions and provider-specific reference paths', () => {
  const targetRoot = makeTempDir('p2a-context-provider-reference-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const routesPath = path.join(targetRoot, '.agents', 'context-routes.json');
    const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
    const harness = routes.skills.find((skill) => skill.id === 'p2a-harness');
    const reference = harness.references.find((item) => (
      item.path === 'references/existing-documents.md'
    ));
    const originalReference = structuredClone(reference);
    const alternatePath = 'references/gemini-existing-documents.md';
    reference.providers = ['gemini'];
    reference.provider_paths = [{ provider: 'gemini', path: alternatePath }];
    writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    for (const providerRoot of ['.agents', '.claude']) {
      const skillPath = path.join(targetRoot, providerRoot, 'skills', 'p2a-harness', 'SKILL.md');
      writeFileSync(
        skillPath,
        readFileSync(skillPath, 'utf8').replace(
          referenceRouteSignature(originalReference),
          referenceRouteSignature(reference),
        ),
        'utf8',
      );
    }
    cpSync(
      path.join(targetRoot, '.agents', 'skills', 'p2a-harness', reference.path),
      path.join(targetRoot, '.agents', 'skills', 'p2a-harness', alternatePath),
    );
    assert.doesNotThrow(() => validateSchema(routes, ROUTES_SCHEMA));
    const report = auditContext(targetRoot, {
      scenario: {
        skill: 'p2a-harness',
        stage: 'gate-a',
        executionMode: null,
        conditions: [`reference:p2a-harness:${reference.path}`],
      },
    });
    assert.equal(report.status, 'pass');
    const byProvider = new Map(report.contexts.map((context) => [context.provider, context]));
    assert.ok(byProvider.get('gemini').sources.some((source) => source.path.endsWith(alternatePath)));
    assert.ok(byProvider.get('codex').sources.every((source) => !source.path.endsWith(reference.path)));
    assert.ok(byProvider.get('claude').sources.every((source) => !source.path.endsWith(reference.path)));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit rejects canonical reference routing duplicated into a Gemini wrapper', () => {
  const targetRoot = makeTempDir('p2a-context-gemini-route-duplication-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const routesPath = path.join(targetRoot, '.agents', 'context-routes.json');
    const routes = JSON.parse(readFileSync(routesPath, 'utf8'));
    const harness = routes.skills.find((skill) => skill.id === 'p2a-harness');
    const reference = harness.references.find((item) => (
      item.path === 'references/existing-documents.md'
    ));
    const originalReference = structuredClone(reference);
    reference.providers = ['codex'];
    writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
    for (const providerRoot of ['.agents', '.claude']) {
      const skillPath = path.join(targetRoot, providerRoot, 'skills', 'p2a-harness', 'SKILL.md');
      writeFileSync(
        skillPath,
        readFileSync(skillPath, 'utf8').replace(
          referenceRouteSignature(originalReference),
          referenceRouteSignature(reference),
        ),
        'utf8',
      );
    }
    const adapterPath = path.join(targetRoot, '.gemini', 'commands', 'p2a', 'harness.toml');
    writeFileSync(
      adapterPath,
      `${readFileSync(adapterPath, 'utf8')}\n# references/existing-documents.md\n`,
      'utf8',
    );

    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'provider_adapter_route_drift'
        && item.owners?.includes('provider-wrapper')
        && item.paths?.includes('.gemini/commands/p2a/harness.toml')
    )));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('context audit detects Claude skill mirror drift from canonical content', () => {
  const targetRoot = makeTempDir('p2a-context-claude-drift-');
  try {
    for (const directory of ['.agents', '.claude', '.codex', '.gemini']) {
      cpSync(path.join(ROOT, directory), path.join(targetRoot, directory), { recursive: true });
    }
    const mirrorPath = path.join(targetRoot, '.claude', 'skills', 'p2a-next', 'SKILL.md');
    writeFileSync(mirrorPath, `${readFileSync(mirrorPath, 'utf8')}\nProvider-only drift.\n`, 'utf8');
    const report = auditContext(targetRoot);
    assert.equal(report.status, 'fail');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'provider_skill_mirror_drift'
        && item.paths?.includes('.claude/skills/p2a-next/SKILL.md')
    )));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('scaffold copies canonical routes and audits only selected provider surfaces', () => {
  const targetRoot = makeTempDir('p2a-context-scaffold-');
  try {
    mkdirSync(targetRoot, { recursive: true });
    const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'codex']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
    const report = auditContext(targetRoot);
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.providers.map((item) => item.provider), ['codex']);
    assert.equal(report.manifestPath, '.agents/context-routes.json');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
