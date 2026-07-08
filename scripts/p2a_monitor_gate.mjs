/** Shared monitor gate helpers for Plan2Agent run lifecycle. */

import path from 'node:path';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';

export const MONITOR_CONCERN_FIELDS = ['scope_concerns', 'verification_concerns', 'unmet_acceptance', 'needs_user_decision'];
export const DEFAULT_MONITOR_ACCEPTED_VERDICTS = ['confirm_done'];
export const DEFAULT_MONITOR_FAILURE_CLASS_MAP = {
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
  return path.join(runsDir, `${runId}.monitor-gate.json`);
}

export function monitorVerdictPath(runsDir, runId) {
  assertSafeRunId(runId);
  return path.join(runsDir, `${runId}.monitor-verdict.json`);
}

function monitorConcernValues(data, field) {
  if (!data || typeof data !== 'object') return [];
  const value = data[field];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function normalizeMonitorVerdictData(data) {
  if (typeof data === 'string') {
    const verdict = data.trim();
    if (!verdict) throw new Error('monitor verdict must not be blank');
    return { verdict, failureSignal: verdict, concerns: {}, concernFields: [], hasConcerns: false, needsUserDecision: false, note: null };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('monitor verdict must be a JSON string or object with a verdict field');
  }
  const verdict = typeof data.verdict === 'string' ? data.verdict.trim() : '';
  if (!verdict) throw new Error('monitor verdict object must include a non-empty verdict field');
  const concerns = Object.fromEntries(MONITOR_CONCERN_FIELDS.map((field) => [field, monitorConcernValues(data, field)]));
  const concernFields = MONITOR_CONCERN_FIELDS.filter((field) => concerns[field].length > 0);
  const failureSignal = concernFields[0] ?? (verdict === 'block' ? 'block' : verdict);
  const needsUserDecision = concerns.needs_user_decision.length > 0;
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : null;
  return { verdict, failureSignal, concerns, concernFields, hasConcerns: concernFields.length > 0, needsUserDecision, note };
}

export function normalizeMonitorGateSidecar(data, runId = null) {
  const gate = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    schema_version: 'p2a.monitor_gate.v1',
    runId: typeof gate.runId === 'string' ? gate.runId : runId,
    required: gate.required === true,
    verdictPath: typeof gate.verdictPath === 'string' && gate.verdictPath.trim()
      ? gate.verdictPath.trim()
      : (runId ? `${runId}.monitor-verdict.json` : null),
    acceptedVerdicts: Array.isArray(gate.acceptedVerdicts) && gate.acceptedVerdicts.length
      ? gate.acceptedVerdicts.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [...DEFAULT_MONITOR_ACCEPTED_VERDICTS],
    failureClassMap: { ...DEFAULT_MONITOR_FAILURE_CLASS_MAP, ...(gate.failureClassMap ?? {}) },
  };
}

export function writeMonitorGateSidecar(runsDir, runId) {
  const sidecar = normalizeMonitorGateSidecar({ required: true }, runId);
  const filePath = monitorGateSidecarPath(runsDir, runId);
  writeFileSync(filePath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
  return { filePath, sidecar };
}

export function readMonitorGateSidecar(runsDir, runId) {
  const filePath = monitorGateSidecarPath(runsDir, runId);
  if (!existsSync(filePath)) return null;
  if (!lstatSync(filePath).isFile()) throw new Error(`monitor gate sidecar must be a file: ${filePath}`);
  return normalizeMonitorGateSidecar(JSON.parse(readFileSync(filePath, 'utf8')), runId);
}
