/** Failure-class-specific debug detail requirements shared by runtime and validators. */

export const FAILURE_DETAIL_REQUIREMENTS = Object.freeze({
  verification_failed: ['reproduction', 'localization', 'guard'],
  test_flake: ['reproduction', 'guard'],
  scope_violation: ['reproduction', 'localization', 'guard'],
  missing_dependency: ['reproduction', 'guard'],
  environment_failure: ['reproduction', 'guard'],
  implementation_incomplete: ['reproduction', 'localization', 'guard'],
  other: ['reproduction', 'localization', 'guard'],
});

export function structuredDetailHasValue(detail, fields) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
  return fields.some((field) => (
    Array.isArray(detail[field])
    && detail[field].some((value) => typeof value === 'string' && value.trim())
  ));
}

export function missingRequiredFailureDetails(run) {
  if (!['failed', 'blocked'].includes(run?.status)) return [];
  const required = FAILURE_DETAIL_REQUIREMENTS[run?.failure?.class] ?? [];
  const hasValue = {
    reproduction: structuredDetailHasValue(run.reproduction, ['steps', 'commands', 'notes']),
    localization: structuredDetailHasValue(run.localization, ['findings', 'files']),
    guard: structuredDetailHasValue(run.guard, ['checks', 'notes']),
  };
  return required.filter((section) => !hasValue[section]);
}
