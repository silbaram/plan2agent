import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_ROOT, runValidator, formatCommandResult } from './helpers/fixtures.mjs';

const fixtureDirs = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => !entry.name.startsWith('_'))
  .map((entry) => path.join(FIXTURE_ROOT, entry.name))
  .sort();

describe('schema/golden fixtures', () => {
  for (const fixtureDir of fixtureDirs) {
    test(path.relative(FIXTURE_ROOT, fixtureDir), () => {
      const result = runValidator(['--fixture-dir', fixtureDir]);
      assert.equal(result.status, 0, formatCommandResult(result));
    });
  }
});
