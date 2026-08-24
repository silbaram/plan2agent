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

test('runtime modules do not depend on retired planning evidence implementations', () => {
  const scriptsDir = path.join(ROOT, 'scripts');
  const modules = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs'));
  for (const name of modules) {
    const contents = readFileSync(path.join(scriptsDir, name), 'utf8');
    assert.doesNotMatch(
      contents,
      /(?:from\s+|import\s*)['"][^'"]*plans\/evidence\//,
      `${name} must use stable runtime modules instead of retired plan evidence`,
    );
  }
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
