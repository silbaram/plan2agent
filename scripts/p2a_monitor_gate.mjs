/** Shared monitor gate helpers for Plan2Agent run lifecycle. */

import path from 'node:path';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { indexedRunRef, runSidecarPath, runSidecarRef } from './p2a_run_paths.mjs';

export const LEGACY_MONITOR_CONCERN_FIELDS = ['scope_concerns', 'verification_concerns', 'unmet_acceptance', 'needs_user_decision'];
export const MONITOR_CONCERN_FIELDS = ['rule_concerns', ...LEGACY_MONITOR_CONCERN_FIELDS];
export const DEFAULT_MONITOR_ACCEPTED_VERDICTS = ['confirm_done'];
export const MONITOR_GATE_POLICY = 'p2a.monitor_gate.rules.v1';
export const DEFAULT_MONITOR_FAILURE_CLASS_MAP = {
  rule_concerns: 'scope_violation',
  scope_concerns: 'scope_violation',
  verification_concerns: 'verification_failed',
  unmet_acceptance: 'implementation_incomplete',
  needs_user_decision: 'missing_dependency',
  block: 'other',
};

function assertSafeRunId(runId) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`unsafe run id: ${runId}`);
}

export function monitorGateSidecarPath(runsDir, runId) {
  assertSafeRunId(runId);
  return runSidecarPath(runsDir, runId, '.monitor-gate.json');
}

function monitorConcernValues(data, field) {
  if (!data || typeof data !== 'object') return [];
  const value = data[field];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeRequiredConcernFields(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  if (value.some((field) => typeof field !== 'string' || !field.trim())) {
    throw new Error('monitor gate requiredConcernFields must contain only non-empty strings');
  }
  const fields = [...new Set(value.map((field) => field.trim()))];
  const unknown = fields.filter((field) => !MONITOR_CONCERN_FIELDS.includes(field));
  if (unknown.length) throw new Error(`monitor gate has unknown required concern field(s): ${unknown.join(', ')}`);
  return fields;
}

function normalizeRuleContract(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('monitor gate ruleContract must be an object');
  }
  const source = value.source;
  if (!['constitution', 'legacy_style', 'none'].includes(source)) {
    throw new Error('monitor gate ruleContract.source must be constitution, legacy_style, or none');
  }
  if (value.ruleIds !== undefined && !Array.isArray(value.ruleIds)) {
    throw new Error('monitor gate ruleContract.ruleIds must be an array');
  }
  const rawRuleIds = value.ruleIds ?? [];
  if (rawRuleIds.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('monitor gate ruleContract.ruleIds must contain only non-empty strings');
  }
  const ruleIds = [...new Set(rawRuleIds.map((item) => item.trim()))];
  if (ruleIds.length !== rawRuleIds.length) {
    throw new Error('monitor gate ruleContract.ruleIds must be unique');
  }
  if (source === 'none') {
    if (value.ref !== undefined && value.ref !== null) throw new Error('monitor gate none ruleContract.ref must be null');
    if (value.sha256 !== undefined && value.sha256 !== null) throw new Error('monitor gate none ruleContract.sha256 must be null');
    if (ruleIds.length) throw new Error('monitor gate none ruleContract.ruleIds must be empty');
    return { source, ref: null, sha256: null, ruleIds: [] };
  }
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim() : '';
  if (!ref) throw new Error(`monitor gate ${source} ruleContract requires ref`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`monitor gate ${source} ruleContract requires a SHA-256 digest`);
  return { source, ref, sha256, ruleIds };
}

export function normalizeMonitorVerdictData(data, options = {}) {
  const requiredConcernFields = normalizeRequiredConcernFields(options.requiredConcernFields);
  const requiredRuleIds = Array.isArray(options.requiredRuleIds) ? options.requiredRuleIds : [];
  const requireRulesReviewed = options.requireRulesReviewed === true;
  if (typeof data === 'string') {
    const verdict = data.trim();
    if (!verdict) throw new Error('monitor verdict must not be blank');
    if (requiredConcernFields.length) {
      throw new Error(`monitor verdict must be an object with required concern field(s): ${requiredConcernFields.join(', ')}`);
    }
    return { verdict, failureSignal: verdict, concerns: {}, concernFields: [], hasConcerns: false, needsUserDecision: false, note: null };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('monitor verdict must be a JSON string or object with a verdict field');
  }
  const verdict = typeof data.verdict === 'string' ? data.verdict.trim() : '';
  if (!verdict) throw new Error('monitor verdict object must include a non-empty verdict field');
  const missingRequired = requiredConcernFields.filter((field) => !Object.hasOwn(data, field) || !Array.isArray(data[field]));
  if (missingRequired.length) {
    throw new Error(`monitor verdict must include array field(s): ${missingRequired.join(', ')}`);
  }
  const malformedRequired = requiredConcernFields.filter((field) => (
    data[field].some((item) => typeof item !== 'string' || !item.trim())
  ));
  if (malformedRequired.length) {
    throw new Error(`monitor verdict field(s) must contain only non-empty strings: ${malformedRequired.join(', ')}`);
  }
  if (requireRulesReviewed && !Array.isArray(data.rules_reviewed)) {
    throw new Error('monitor verdict must include rules_reviewed as an array');
  }
  if (requireRulesReviewed && data.rules_reviewed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('monitor verdict rules_reviewed must contain only non-empty strings');
  }
  const rulesReviewed = Array.isArray(data.rules_reviewed)
    ? [...new Set(data.rules_reviewed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))]
    : [];
  const missingRuleReviews = requiredRuleIds.filter((ruleId) => !rulesReviewed.includes(ruleId));
  if (missingRuleReviews.length) {
    throw new Error(`monitor verdict rules_reviewed is missing required rule(s): ${missingRuleReviews.join(', ')}`);
  }
  const concerns = Object.fromEntries(MONITOR_CONCERN_FIELDS.map((field) => [field, monitorConcernValues(data, field)]));
  const concernFields = MONITOR_CONCERN_FIELDS.filter((field) => concerns[field].length > 0);
  const failureSignal = concernFields[0] ?? (verdict === 'block' ? 'block' : verdict);
  const needsUserDecision = concerns.needs_user_decision.length > 0;
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : null;
  return { verdict, failureSignal, concerns, concernFields, hasConcerns: concernFields.length > 0, needsUserDecision, rulesReviewed, note };
}

export function normalizeMonitorGateSidecar(data, runId = null, runRef = null) {
  const gate = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const ruleContract = normalizeRuleContract(gate.ruleContract);
  const strictGate = ruleContract !== null;
  const normalizedRunId = typeof gate.runId === 'string' ? gate.runId : runId;
  if (runId && normalizedRunId !== runId) {
    throw new Error(`monitor gate runId must be ${runId}`);
  }
  const expectedVerdictPath = runId
    ? runSidecarRef(runRef ?? `${runId}.json`, '.monitor-verdict.json')
    : null;
  const verdictPath = typeof gate.verdictPath === 'string' && gate.verdictPath.trim()
    ? gate.verdictPath.trim()
    : expectedVerdictPath;
  if (expectedVerdictPath && verdictPath !== expectedVerdictPath) {
    throw new Error(`monitor gate verdictPath must be ${expectedVerdictPath}`);
  }
  const acceptedVerdicts = Array.isArray(gate.acceptedVerdicts) && gate.acceptedVerdicts.length
    ? gate.acceptedVerdicts.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [...DEFAULT_MONITOR_ACCEPTED_VERDICTS];
  if (strictGate && Array.isArray(gate.acceptedVerdicts)
    && gate.acceptedVerdicts.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('strict monitor gate acceptedVerdicts must contain only non-empty strings');
  }
  if (strictGate && JSON.stringify(acceptedVerdicts) !== JSON.stringify(DEFAULT_MONITOR_ACCEPTED_VERDICTS)) {
    throw new Error('strict monitor gate acceptedVerdicts must be ["confirm_done"]');
  }
  const requiredConcernFields = normalizeRequiredConcernFields(
    gate.requiredConcernFields,
    strictGate ? MONITOR_CONCERN_FIELDS : [],
  );
  if (strictGate) {
    const missingFields = MONITOR_CONCERN_FIELDS.filter((field) => !requiredConcernFields.includes(field));
    if (missingFields.length) {
      throw new Error(`strict monitor gate requiredConcernFields is missing: ${missingFields.join(', ')}`);
    }
  }
  const suppliedFailureClassMap = gate.failureClassMap;
  if (strictGate && suppliedFailureClassMap !== undefined) {
    if (!suppliedFailureClassMap || typeof suppliedFailureClassMap !== 'object' || Array.isArray(suppliedFailureClassMap)) {
      throw new Error('strict monitor gate failureClassMap must be an object');
    }
    const changedMappings = Object.entries(DEFAULT_MONITOR_FAILURE_CLASS_MAP)
      .filter(([signal, failureClass]) => (
        Object.hasOwn(suppliedFailureClassMap, signal)
        && suppliedFailureClassMap[signal] !== failureClass
      ));
    if (changedMappings.length) {
      throw new Error(`strict monitor gate cannot override failureClassMap: ${changedMappings.map(([signal]) => signal).join(', ')}`);
    }
    const unknownMappings = Object.keys(suppliedFailureClassMap)
      .filter((signal) => !Object.hasOwn(DEFAULT_MONITOR_FAILURE_CLASS_MAP, signal));
    if (unknownMappings.length) {
      throw new Error(`strict monitor gate failureClassMap has unknown signal(s): ${unknownMappings.join(', ')}`);
    }
  }
  return {
    schema_version: 'p2a.monitor_gate.v1',
    runId: normalizedRunId,
    required: gate.required === true,
    verdictPath,
    acceptedVerdicts,
    requiredConcernFields,
    ruleContract,
    failureClassMap: { ...DEFAULT_MONITOR_FAILURE_CLASS_MAP, ...(suppliedFailureClassMap ?? {}) },
  };
}

export function monitorGateContractSha256(sidecar) {
  return createHash('sha256').update(JSON.stringify(sidecar)).digest('hex');
}

export function monitorVerdictEvidenceSha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function assertRunMonitorGateBinding(run, sidecar) {
  if (!run?.monitorGate?.required) return;
  if (!sidecar?.required) {
    throw new Error(`run ${run.runId} requires its bound monitor gate sidecar`);
  }
  if (run.monitorGate.policy !== MONITOR_GATE_POLICY) {
    throw new Error(`run ${run.runId} has unsupported monitor gate policy ${JSON.stringify(run.monitorGate.policy)}`);
  }
  const currentSha256 = monitorGateContractSha256(sidecar);
  if (run.monitorGate.contractSha256 !== currentSha256) {
    throw new Error(
      `run ${run.runId} monitor gate contract changed; expected ${run.monitorGate.contractSha256}, got ${currentSha256}`,
    );
  }
}

export function assertRunMonitorVerdictBinding(run, contents = null) {
  if (!run?.monitorGate?.required) return;
  const sealedSha256 = run.monitorVerdictEvidenceSha256;
  const verdictRequired = run.status === 'finished' || run.failure?.source === 'monitor';
  if (!sealedSha256) {
    if (verdictRequired) {
      throw new Error(`${run.status} run ${run.runId} is missing monitorVerdictEvidenceSha256`);
    }
    return;
  }
  if (contents === null) {
    throw new Error(`run ${run.runId} is missing its sealed monitor verdict evidence`);
  }
  const currentSha256 = monitorVerdictEvidenceSha256(contents);
  if (sealedSha256 !== currentSha256) {
    throw new Error(
      `run ${run.runId} monitor verdict evidence changed; expected ${sealedSha256}, got ${currentSha256}`,
    );
  }
}

export function readMonitorGateSidecar(runsDir, runId) {
  const filePath = monitorGateSidecarPath(runsDir, runId);
  if (!existsSync(filePath)) return null;
  if (!lstatSync(filePath).isFile()) throw new Error(`monitor gate sidecar must be a file: ${filePath}`);
  return normalizeMonitorGateSidecar(JSON.parse(readFileSync(filePath, 'utf8')), runId, indexedRunRef(runsDir, runId));
}
