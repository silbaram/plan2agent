#!/usr/bin/env node
/** Validate the repo-only adaptive execution A/B report and its sealed evidence bytes. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ValidationError,
  loadJson,
  validateSchema,
} from '../../scripts/validate_artifacts.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EVAL_ROOT = path.dirname(SCRIPT_PATH);
const TOOLKIT_ROOT = path.resolve(EVAL_ROOT, '..', '..');
const REPORT_SCHEMA = path.join(EVAL_ROOT, 'report.schema.json');

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function rawFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function evidenceInventory(fixturesDir) {
  const inventory = [];
  function visit(directory, relativeDir = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        const contents = readFileSync(absolutePath);
        inventory.push({
          path: normalizeRelative(relativePath),
          sha256: createHash('sha256').update(contents).digest('hex'),
          bytes: contents.length,
        });
      }
    }
  }
  visit(fixturesDir);
  return inventory;
}

export function validateAdaptiveAbReport(reportPath) {
  const resolvedReport = realpathSync(reportPath);
  const data = loadJson(resolvedReport);
  validateSchema(data, loadJson(REPORT_SCHEMA));
  if (data.fixture_count.completed !== data.fixtures.length) {
    throw new ValidationError('adaptive A/B fixture_count.completed must match fixtures.length');
  }
  if (data.fixture_count.completed > data.fixture_count.required) {
    throw new ValidationError('adaptive A/B completed fixture count exceeds required count');
  }
  const complete = data.fixture_count.completed === data.fixture_count.required;
  const allPass = complete && data.fixtures.every((fixture) => fixture.comparison.status === 'pass');
  const expectedStatus = allPass ? 'sealed' : complete ? 'failed' : 'incomplete';
  if (data.status !== expectedStatus) {
    throw new ValidationError(`adaptive A/B status must be ${expectedStatus} for its fixture comparisons`);
  }
  const manifestPath = path.resolve(TOOLKIT_ROOT, data.manifest_ref);
  const manifestRelative = path.relative(TOOLKIT_ROOT, manifestPath);
  if (!manifestRelative || manifestRelative.startsWith('..') || path.isAbsolute(manifestRelative)) {
    throw new ValidationError('adaptive A/B manifest_ref must resolve inside the toolkit root');
  }
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) {
    throw new ValidationError('adaptive A/B manifest_ref does not resolve to a file');
  }
  if (rawFileSha256(manifestPath) !== data.manifest_sha256) {
    throw new ValidationError('adaptive A/B manifest_sha256 does not match manifest_ref');
  }
  const reportDir = path.dirname(resolvedReport);
  for (const fixture of data.fixtures) {
    for (const field of ['a_ref', 'b_ref']) {
      const variantPath = path.resolve(reportDir, fixture[field]);
      const relative = path.relative(reportDir, variantPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new ValidationError(`adaptive A/B ${fixture.fixture_id}.${field} must stay inside the report directory`);
      }
      if (!existsSync(variantPath) || !lstatSync(variantPath).isFile()) {
        throw new ValidationError(`adaptive A/B ${fixture.fixture_id}.${field} does not resolve to a file`);
      }
    }
  }
  const fixturesDir = path.join(reportDir, 'fixtures');
  if (!existsSync(fixturesDir) || !lstatSync(fixturesDir).isDirectory()) {
    throw new ValidationError('adaptive A/B fixtures evidence directory is missing');
  }
  const actualInventory = evidenceInventory(fixturesDir);
  if (JSON.stringify(actualInventory) !== JSON.stringify(data.evidence_inventory)) {
    throw new ValidationError('adaptive A/B evidence_inventory does not match the fixture evidence bytes');
  }
  const inventorySha256 = createHash('sha256').update(JSON.stringify(actualInventory)).digest('hex');
  if (inventorySha256 !== data.evidence_inventory_sha256) {
    throw new ValidationError('adaptive A/B evidence_inventory_sha256 does not match evidence_inventory');
  }
  return data;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: node eval/adaptive-ab/validate_report.mjs <report.json>');
    return argv.length === 1 ? 0 : 1;
  }
  try {
    const report = validateAdaptiveAbReport(argv[0]);
    console.log(`Adaptive A/B report valid: ${path.resolve(argv[0])}`);
    console.log(`- status: ${report.status}`);
    console.log(`- fixtures: ${report.fixture_count.completed}/${report.fixture_count.required}`);
    return 0;
  } catch (error) {
    console.error(`adaptive A/B validation failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main();
}
