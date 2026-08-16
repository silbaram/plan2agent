/** Shared, provider-neutral helpers for runtime-routing evaluations. */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadRuntimeEvaluationContract(filePath) {
  const declared = readJson(filePath, 'contract');
  if (declared.schema_version === 'p2a.context_engineering_codex_ab_contract.v1') {
    return {
      contract: declared,
      sha256: sha256(readFileSync(filePath)),
      evaluationId: declared.evaluation_id,
    };
  }
  if (declared.schema_version !== 'p2a.context_engineering_contract_overlay.v1') {
    throw new Error(`unsupported contract schema_version: ${String(declared.schema_version)}`);
  }
  const basePath = path.resolve(path.dirname(filePath), declared.base_contract ?? '');
  const base = readJson(basePath, 'base contract');
  if (base.schema_version !== 'p2a.context_engineering_codex_ab_contract.v1') {
    throw new Error('contract overlay base must use p2a.context_engineering_codex_ab_contract.v1');
  }
  const overrides = declared.scenario_overrides ?? {};
  const knownScenarioIds = new Set(base.scenarios.map((scenario) => scenario.id));
  const unknownOverrides = Object.keys(overrides).filter((id) => !knownScenarioIds.has(id));
  if (unknownOverrides.length) {
    throw new Error(`contract overlay has unknown scenario(s): ${unknownOverrides.join(', ')}`);
  }
  const scenarios = base.scenarios.map((scenario) => {
    const override = overrides[scenario.id];
    if (!override) return scenario;
    return {
      ...scenario,
      ...override,
      case: {
        ...scenario.case,
        ...(override.case ?? {}),
      },
    };
  });
  const baseSha256 = sha256(readFileSync(basePath));
  return {
    contract: {
      ...base,
      evaluation_id: declared.evaluation_id,
      description: declared.description ?? base.description,
      scenarios,
    },
    sha256: sha256(stableJson({ baseSha256, overlay: declared })),
    evaluationId: declared.evaluation_id,
  };
}

function normalizedRelativePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

export function runtimeEvaluationSourceManifest(root, options = {}) {
  const rows = [];
  const ignoredNames = new Set(options.ignoredNames ?? ['.git', 'node_modules', '.agents_cache']);
  const excludedPrefixes = (options.excludedPrefixes ?? ['plans/evidence'])
    .map(normalizedRelativePath);
  function visit(current, relative) {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const nextRelative = normalizedRelativePath(relative ? `${relative}/${entry.name}` : entry.name);
      if (excludedPrefixes.some((prefix) => (
        nextRelative === prefix || nextRelative.startsWith(`${prefix}/`)
      ))) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute, nextRelative);
      else if (entry.isFile()) rows.push(`${nextRelative}\0${sha256(readFileSync(absolute))}`);
    }
  }
  visit(root, '');
  return {
    files: rows.length,
    sha256: sha256(rows.join('\n')),
  };
}

function sorted(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

export function gradeRuntimeRoutingResult(scenario, result) {
  const checks = [];
  const add = (id, pass, expected, actual) => checks.push({ id, pass, expected, actual });
  add(
    'schema_version',
    result?.schemaVersion === 'p2a.context_engineering_codex_ab_result.v1',
    'p2a.context_engineering_codex_ab_result.v1',
    result?.schemaVersion ?? null,
  );
  add('scenario_id', result?.scenarioId === scenario.id, scenario.id, result?.scenarioId ?? null);
  for (const [field, expected] of Object.entries(scenario.expected?.scalars ?? {})) {
    add(`scalar:${field}`, result?.[field] === expected, expected, result?.[field] ?? null);
  }
  for (const [field, expected] of Object.entries(scenario.expected?.one_of ?? {})) {
    add(`one_of:${field}`, expected.includes(result?.[field]), expected, result?.[field] ?? null);
  }
  for (const [field, expected] of Object.entries(scenario.expected?.sets ?? {})) {
    const actual = Array.isArray(result?.[field]) ? sorted(result[field]) : [];
    add(`set:${field}`, stableJson(actual) === stableJson(sorted(expected)), sorted(expected), actual);
  }
  for (const [field, expected] of Object.entries(scenario.expected?.contains ?? {})) {
    const actual = Array.isArray(result?.[field]) ? result[field] : [];
    const missing = expected.filter((item) => !actual.includes(item));
    add(`contains:${field}`, missing.length === 0, expected, actual);
  }
  for (const [field, expected] of Object.entries(scenario.expected?.ordered ?? {})) {
    const actual = Array.isArray(result?.[field]) ? result[field] : [];
    add(`ordered:${field}`, stableJson(actual) === stableJson(expected), expected, actual);
  }
  const passed = checks.filter((check) => check.pass).length;
  return {
    schema_version: 'p2a.context_engineering_codex_ab_grade.v1',
    scenarioId: scenario.id,
    verdict: passed === checks.length ? 'pass' : 'fail',
    score: checks.length ? Number((passed / checks.length).toFixed(3)) : 0,
    checks,
  };
}
