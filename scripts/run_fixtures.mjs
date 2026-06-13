#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for positive, e2e, and negative fixture cases. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures');
const E2E_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_e2e');
const NEGATIVE_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_negative');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate_artifacts.mjs');

function runValidator(args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function writeResultOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function formatSegments(segments) {
  if (segments.length <= 2) return segments.join(' and ');
  return `${segments.slice(0, -1).join(', ')}, and ${segments[segments.length - 1]}`;
}

function loadNegativeFixtureManifest() {
  const manifestPath = path.join(NEGATIVE_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { expected_pass: [], expected_failure: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function loadE2eFixtureManifest() {
  const manifestPath = path.join(E2E_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { cases: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function assertCaseShape(caseData, groupName) {
  if (!caseData || typeof caseData !== 'object') {
    throw new Error(`${groupName} fixture case must be an object`);
  }
  if (!caseData.id || typeof caseData.id !== 'string') {
    throw new Error(`${groupName} fixture case is missing string id`);
  }
  if (!Array.isArray(caseData.args) || caseData.args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`${caseData.id} must provide args as a string array`);
  }
}

function assertE2eCaseShape(caseData) {
  if (!caseData || typeof caseData !== 'object') {
    throw new Error('e2e fixture case must be an object');
  }
  if (!caseData.id || typeof caseData.id !== 'string') {
    throw new Error('e2e fixture case is missing string id');
  }
  if (!caseData.artifact_root || typeof caseData.artifact_root !== 'string') {
    throw new Error(`${caseData.id} must provide artifact_root`);
  }
  if (!caseData.project_id || typeof caseData.project_id !== 'string') {
    throw new Error(`${caseData.id} must provide project_id`);
  }
}

function validateE2eFixtureCases() {
  const manifest = loadE2eFixtureManifest();
  const cases = manifest.cases ?? [];
  let checks = 0;

  for (const caseData of cases) {
    assertE2eCaseShape(caseData);
    const result = runValidator([
      '--artifact-root',
      caseData.artifact_root,
      '--project-id',
      caseData.project_id,
      '--require-handoff-ready',
    ]);
    checks += 1;
    if (result.status !== 0) {
      console.error(`e2e fixture check failed: ${caseData.id}`);
      writeResultOutput(result);
      return { status: result.status ?? 1, checks };
    }
  }

  return { status: 0, checks };
}

function validateNegativeFixtureCases() {
  const manifest = loadNegativeFixtureManifest();
  const expectedPass = manifest.expected_pass ?? [];
  const expectedFailure = manifest.expected_failure ?? [];
  let checks = 0;

  for (const caseData of expectedPass) {
    assertCaseShape(caseData, 'expected_pass');
    const result = runValidator(caseData.args);
    checks += 1;
    if (result.status !== 0) {
      console.error(`negative fixture pass check failed unexpectedly: ${caseData.id}`);
      writeResultOutput(result);
      return { status: result.status ?? 1, checks };
    }
  }

  for (const caseData of expectedFailure) {
    assertCaseShape(caseData, 'expected_failure');
    if (!caseData.expected_message || typeof caseData.expected_message !== 'string') {
      throw new Error(`${caseData.id} must provide expected_message`);
    }
    const result = runValidator(caseData.args);
    checks += 1;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0) {
      console.error(`negative fixture expected failure but command passed: ${caseData.id}`);
      writeResultOutput(result);
      return { status: 1, checks };
    }
    if (!output.includes(caseData.expected_message)) {
      console.error(`negative fixture failed with unexpected message: ${caseData.id}`);
      console.error(`expected message fragment: ${caseData.expected_message}`);
      writeResultOutput(result);
      return { status: 1, checks };
    }
  }

  return { status: 0, checks };
}

export function main() {
  const fixtureDirs = existsSync(FIXTURE_ROOT)
    ? readdirSync(FIXTURE_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.startsWith('_'))
        .map((entry) => path.join(FIXTURE_ROOT, entry.name))
        .sort()
    : [];
  if (!fixtureDirs.length) {
    console.error('fixture validation failed: no fixture directories found');
    return 1;
  }

  const command = [VALIDATOR];
  for (const fixtureDir of fixtureDirs) command.push('--fixture-dir', fixtureDir);
  const result = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8' });
  writeResultOutput(result);
  if (result.status !== 0) return result.status ?? 1;

  let e2eResult;
  try {
    e2eResult = validateE2eFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (e2eResult.status !== 0) return e2eResult.status;

  let negativeResult;
  try {
    negativeResult = validateNegativeFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (negativeResult.status !== 0) return negativeResult.status;

  const segments = [`${fixtureDirs.length} Plan2Agent fixture set(s)`];
  if (e2eResult.checks) segments.push(`${e2eResult.checks} e2e fixture check(s)`);
  if (negativeResult.checks) segments.push(`${negativeResult.checks} negative fixture check(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
