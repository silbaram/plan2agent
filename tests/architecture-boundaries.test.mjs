import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ROOT } from './helpers/fixtures.mjs';

function source(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('runtime context depends on the next-state service instead of the CLI entry point', () => {
  const context = source('scripts/p2a_context.mjs');
  const fixture = source('scripts/p2a_runtime_context_fixture.mjs');
  const cli = source('scripts/p2a.mjs');

  assert.match(context, /from '\.\/p2a_next_service\.mjs'/);
  assert.doesNotMatch(context, /from '\.\/p2a\.mjs'/);
  assert.match(cli, /from '\.\/p2a_next_service\.mjs'/);
  assert.doesNotMatch(cli, /from '\.\/validate_artifacts\.mjs'/);
  assert.match(fixture, /from '\.\/p2a_context_packet\.mjs'/);
  assert.doesNotMatch(fixture, /from '\.\/p2a_context\.mjs'/);
});

test('provider runners consume stable evaluation modules instead of other evidence implementations', () => {
  const codexRunner = source('plans/evidence/context-engineering/CE-009/codex/run-codex-ab.mjs');
  const geminiRunner = source('plans/evidence/context-engineering/CE-011-gemini-runtime-routing-ab/agy/run-agy-ab.mjs');
  const legacyFixture = source('plans/evidence/context-engineering/CE-009/codex/runtime-context-fixture.mjs');

  for (const runner of [codexRunner, geminiRunner]) {
    assert.match(runner, /scripts\/p2a_runtime_context_fixture\.mjs/);
  }
  assert.doesNotMatch(geminiRunner, /from '\.\.\/\.\.\/CE-009\//);
  assert.match(legacyFixture, /scripts\/p2a_runtime_context_fixture\.mjs/);
  assert.ok(legacyFixture.split('\n').length <= 5, 'historical fixture must remain a thin compatibility module');
});

test('script module dependencies remain acyclic', () => {
  const scriptsDir = path.join(ROOT, 'scripts');
  const modules = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs'));
  const moduleSet = new Set(modules);
  const dependencies = new Map(modules.map((name) => [name, []]));
  for (const name of modules) {
    const contents = readFileSync(path.join(scriptsDir, name), 'utf8');
    for (const match of contents.matchAll(/(?:from\s+|import\s*)['"](\.\/[^'"]+)['"]/g)) {
      const dependency = path.basename(match[1]);
      if (moduleSet.has(dependency)) dependencies.get(name).push(dependency);
    }
  }

  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(name) {
    if (active.has(name)) {
      const cycleStart = stack.indexOf(name);
      assert.fail(`script dependency cycle: ${[...stack.slice(cycleStart), name].join(' -> ')}`);
    }
    if (visited.has(name)) return;
    active.add(name);
    stack.push(name);
    for (const dependency of dependencies.get(name)) visit(dependency);
    stack.pop();
    active.delete(name);
    visited.add(name);
  }
  for (const name of modules) visit(name);
});
