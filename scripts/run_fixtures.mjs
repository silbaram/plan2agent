#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for every fixture directory. */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures');

export function main() {
  const fixtureDirs = existsSync(FIXTURE_ROOT)
    ? readdirSync(FIXTURE_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(FIXTURE_ROOT, entry.name))
        .sort()
    : [];
  if (!fixtureDirs.length) {
    console.error('fixture validation failed: no fixture directories found');
    return 1;
  }

  const command = [path.join(ROOT, 'scripts', 'validate_artifacts.mjs')];
  for (const fixtureDir of fixtureDirs) command.push('--fixture-dir', fixtureDir);
  const result = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) return result.status ?? 1;
  console.log(`Validated ${fixtureDirs.length} Plan2Agent fixture set(s)`);
  return 0;
}

process.exitCode = main();
