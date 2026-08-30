/** Helpers for preserving every verification attempt while judging the latest relevant result. */

export function verificationCommandIdentity(item) {
  if (item?.scope === 'related' && Array.isArray(item.argv) && item.argv.length) {
    const selectedFileCount = Number.isSafeInteger(item.selectedFileCount)
      && item.selectedFileCount > 0
      && item.selectedFileCount <= item.argv.length
      ? item.selectedFileCount
      : 0;
    return JSON.stringify(
      selectedFileCount ? item.argv.slice(0, -selectedFileCount) : item.argv,
    );
  }
  if (typeof item?.originalCommand === 'string' && item.originalCommand.trim()) {
    return item.originalCommand;
  }
  if (Array.isArray(item?.argv) && item.argv.length) return JSON.stringify(item.argv);
  return typeof item?.command === 'string' ? item.command : '';
}

export function verificationAttemptKey(item) {
  const milestone = typeof item?.milestoneId === 'string' ? item.milestoneId : '';
  const scope = typeof item?.scope === 'string' ? item.scope : 'full';
  const type = typeof item?.type === 'string' ? item.type : 'unknown';
  return `${milestone}\0${scope}\0${type}\0${verificationCommandIdentity(item)}`;
}

export function latestVerificationAttempts(items, options = {}) {
  const revision = options.workspaceRevisionSha256 ?? null;
  const productRevision = options.productRevisionSha256 ?? null;
  const includeUnbound = options.includeUnbound === true;
  const latest = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status === 'skipped') continue;
    if (
      (revision || productRevision)
      && item?.workspaceRevisionSha256 !== revision
      && item?.productRevisionSha256 !== productRevision
      && !(includeUnbound && item?.workspaceRevisionSha256 === undefined && item?.productRevisionSha256 === undefined)
    ) continue;
    latest.set(verificationAttemptKey(item), item);
  }
  return [...latest.values()];
}

function verificationAttemptMatchesRevision(item, options = {}) {
  const revision = options.workspaceRevisionSha256 ?? null;
  const productRevision = options.productRevisionSha256 ?? null;
  if (!revision && !productRevision) return true;
  return item?.workspaceRevisionSha256 === revision
    || item?.productRevisionSha256 === productRevision
    || (
      options.includeUnbound === true
      && item?.workspaceRevisionSha256 === undefined
      && item?.productRevisionSha256 === undefined
    );
}

export function latestMilestoneAttempts(items, milestoneId, options = {}) {
  return latestVerificationAttempts(
    (Array.isArray(items) ? items : []).filter((item) => item?.milestoneId === milestoneId),
    options,
  );
}

export function executedPassedVerificationItems(items, options = {}) {
  return latestVerificationAttempts(items, options).filter((item) => (
    item?.status === 'passed'
    && (item.source === 'config' || item.source === 'command')
    && item.exitCode === 0
  ));
}

export function failedVerificationItems(items, options = {}) {
  return latestVerificationAttempts(items, options).filter((item) => item?.status === 'failed');
}

export function incompleteVerificationItems(items, options = {}) {
  return latestVerificationAttempts(items, options).filter((item) => (
    item?.status === 'not_run' || item?.status === 'unavailable'
  ));
}

export function configuredVerificationObligations(config = {}) {
  return [
    ['test', config?.testCommand],
    ['lint', config?.lintCommand],
    ['typecheck', config?.typecheckCommand],
  ]
    .filter(([, command]) => typeof command === 'string' && command.trim())
    .map(([type, command]) => ({
      type,
      command,
      originalCommand: command,
      scope: 'full',
      source: 'config',
    }));
}

export function configuredRelatedVerificationObligations(requests = [], selectedFiles = []) {
  if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) return [];
  return (Array.isArray(requests) ? requests : []).map((request) => ({
    type: request.type,
    argv: [...request.argv, ...selectedFiles],
    selectedFileCount: selectedFiles.length,
    scope: 'related',
    source: 'config',
  }));
}

function passedExecutedAttempt(item) {
  return item?.status === 'passed'
    && item.exitCode === 0
    && (item.source === 'config' || item.source === 'command');
}

export function relatedSelectedFiles(item) {
  if (item?.scope !== 'related' || !Array.isArray(item.argv)) return [];
  const count = item.selectedFileCount;
  if (!Number.isSafeInteger(count) || count <= 0 || count > item.argv.length) return [];
  return item.argv.slice(-count);
}

function obligationLabel(item) {
  return `${item.type ?? 'unknown'}:${verificationCommandIdentity(item) || '<unknown command>'}`;
}

export function evaluateVerificationObligations(items, configured = [], options = {}) {
  const requiredByKey = new Map();
  const require = (item, reason) => {
    const key = verificationAttemptKey(item);
    const existing = requiredByKey.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (reason === 'previous_failure' || reason === 'configured') {
        for (const file of relatedSelectedFiles(item)) existing.requiredSelectedFiles.add(file);
      }
      return;
    }
    requiredByKey.set(key, {
      key,
      item,
      reasons: [reason],
      requiredSelectedFiles: new Set(
        reason === 'previous_failure' || reason === 'configured'
          ? relatedSelectedFiles(item)
          : [],
      ),
    });
  };

  for (const item of Array.isArray(configured) ? configured : []) require(item, 'configured');
  for (const item of Array.isArray(items) ? items : []) {
    if (
      item?.status === 'failed'
      && !item.milestoneId
      && (item.source === 'config' || item.source === 'command')
      && verificationAttemptMatchesRevision(item, options)
    ) require(item, 'previous_failure');
  }

  const currentByKey = new Map(
    latestVerificationAttempts(items, options)
      .map((item) => [verificationAttemptKey(item), item]),
  );
  const required = [...requiredByKey.values()].map(({
    key,
    item,
    reasons,
    requiredSelectedFiles,
  }) => {
    const latestAttempt = currentByKey.get(key) ?? null;
    const selectedFiles = new Set(relatedSelectedFiles(latestAttempt));
    const coversFailedSelection = [...requiredSelectedFiles]
      .every((file) => selectedFiles.has(file));
    return {
      key,
      type: item.type,
      command: verificationCommandIdentity(item),
      reasons,
      requiredSelectedFiles: [...requiredSelectedFiles],
      latestAttempt,
      satisfied: passedExecutedAttempt(latestAttempt) && coversFailedSelection,
    };
  });
  return {
    required,
    missing: required.filter((item) => !item.satisfied),
    satisfied: required.filter((item) => item.satisfied),
  };
}

export function assertVerificationObligations(items, configured = [], options = {}) {
  const result = evaluateVerificationObligations(items, configured, options);
  if (!result.missing.length) return result;
  const summary = result.missing
    .map((item) => `${obligationLabel(item)} (${item.reasons.join('+')})`)
    .join(', ');
  const error = new Error(
    `missing required verification for the current revision: ${summary}. Run each missing check successfully at the current revision before finishing.`,
  );
  error.missingVerificationObligations = result.missing;
  throw error;
}
