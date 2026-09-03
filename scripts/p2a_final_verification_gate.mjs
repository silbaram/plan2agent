/** Enforce the revision-bound verification profile required before iteration close. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalWorkspacePathForArtifactRoot,
  compareRunEvidence,
  P2A_VERIFICATION_METADATA_REFS,
  taskGraphRefMatchesGraph,
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from './p2a_run_paths.mjs';
import {
  VERIFICATION_PROFILES,
  classifyVerificationProfile,
  docsMetadataFiles,
  isDocsMetadataPath,
  productRevisionExcludedPaths,
} from './p2a_verification_profile.mjs';
import {
  configuredRelatedVerificationObligations,
  configuredVerificationObligations,
  evaluateVerificationObligations,
  relatedSelectedFiles,
} from './p2a_verification_evidence.mjs';
import {
  projectConfigCandidatePaths,
  relatedVerificationCommands,
} from './p2a_project_config.mjs';
import {
  collectGitChangedFiles,
  collectGitChangedFilesSince,
  normalizeChangedFiles,
} from './p2a_runs.mjs';
import { relatedFilesSha256 } from './p2a_related_files.mjs';

export const FINAL_VERIFICATION_RUN_KINDS = new Set([
  'final_verification',
  'final_visual_review',
  'final_acceptance_review',
]);
const P2A_VERIFICATION_METADATA_REF_SET = new Set(P2A_VERIFICATION_METADATA_REFS);

function canonicalEvidenceRun(run, canonicalWorkspacePath, profile) {
  const isFinalRun = FINAL_VERIFICATION_RUN_KINDS.has(run?.runKind);
  const isReusableImplementationRun = !run?.runKind && !profile.separateFinalRun;
  if (
    !run
    || (!isFinalRun && !isReusableImplementationRun)
    || !Array.isArray(run.changedFiles)
    || (isFinalRun && run.changedFiles.length !== 0)
    || run.isolation?.mode !== 'none'
    || !run.workspacePath
    || !existsSync(run.workspacePath)
    || !lstatSync(run.workspacePath).isDirectory()
  ) return false;
  try {
    return realpathSync(run.workspacePath) === realpathSync(canonicalWorkspacePath);
  } catch {
    return false;
  }
}

function verificationTime(item, run) {
  for (const value of [item?.finishedAt, item?.startedAt, run?.finishedAt, run?.updatedAt, run?.startedAt]) {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function runCompletionTime(run) {
  for (const value of [run?.finishedAt, run?.updatedAt, run?.startedAt]) {
    const timestamp = Date.parse(value ?? '');
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return 0;
}

function verificationCompletionTime(item, run) {
  return Math.max(verificationTime(item, run), runCompletionTime(run));
}

function compareAttemptRecency(left, right) {
  if (left.runOrder === right.runOrder) {
    return right.itemOrder - left.itemOrder
      || right.timestamp - left.timestamp;
  }
  return right.timestamp - left.timestamp
    || right.runOrder - left.runOrder
    || right.itemOrder - left.itemOrder;
}

function entryCompletedAfter(left, right) {
  const leftTimestamp = left.timestamp ?? runCompletionTime(left.run);
  const rightTimestamp = right.timestamp ?? runCompletionTime(right.run);
  return leftTimestamp > rightTimestamp
    || (leftTimestamp === rightTimestamp && left.runOrder > right.runOrder);
}

function projectVerificationConfig(workspacePath, artifactRoot, graphPath) {
  const candidates = projectConfigCandidatePaths({
    workspacePath,
    artifactRoot,
    graphPath,
  });
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) continue;
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('expected a JSON object');
      }
      return config;
    } catch (error) {
      throw new Error(
        `project verification config is invalid at ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {};
}

function runRevisionMatches(entry, profile) {
  if (entry.run.workspaceRevisionSha256 === entry.currentWorkspaceRevision) return true;
  return profile.id !== 'docs_metadata'
    && entry.run.productRevisionSha256 === entry.currentProductRevision;
}

function itemRevisionMatches(item, entry, profile) {
  if (item.workspaceRevisionSha256 === entry.currentWorkspaceRevision) return true;
  return profile.id !== 'docs_metadata'
    && item.productRevisionSha256 === entry.currentProductRevision;
}

function verificationRequirementError(scope, message, profile = null) {
  const error = new Error(message);
  error.verificationScope = scope;
  if (profile) error.verificationProfile = profile;
  return error;
}

function profileForCurrentProductState(profile, runEntries) {
  if (profile.id !== 'docs_metadata') return profile;
  const driftedRuns = runEntries.filter(({ run, currentProductRevision }) => (
    !run.runKind
    && run.status === 'finished'
    && run.productRevisionSha256 !== currentProductRevision
  ));
  if (!driftedRuns.length) return profile;
  return {
    ...VERIFICATION_PROFILES.high_risk_integration,
    changedFiles: profile.changedFiles,
    reasons: [
      ...profile.reasons,
      'the current product revision differs from documentation-only implementation evidence',
    ],
  };
}

function normalizedRelatedObligationEvidence(runEntries) {
  const currentRevision = '__p2a_current_related_revision__';
  const items = [];
  for (const entry of runEntries) {
    const currentRun = entry.run.workspaceRevisionSha256 === entry.currentWorkspaceRevision;
    for (const item of entry.run.verification ?? []) {
      if (item.scope !== 'related') continue;
      const currentItem = item.workspaceRevisionSha256 === entry.currentWorkspaceRevision;
      const canSatisfy = entry.run.status === 'finished' && currentRun && currentItem;
      const mustInvalidate = item.status === 'failed' && currentItem;
      items.push(canSatisfy || mustInvalidate
        ? { ...item, workspaceRevisionSha256: currentRevision }
        : item);
    }
  }
  return {
    items,
    revisionOptions: { workspaceRevisionSha256: currentRevision },
  };
}

function relatedVerificationFiles(runEntries, workspacePath, profile, fullEvidence) {
  const recordedDocs = profile.id === 'docs_metadata'
    ? runEntries
      .filter(({ run }) => !run.runKind && run.status === 'finished')
      .flatMap(({ run }) => run.changedFiles)
      .filter(isDocsMetadataPath)
    : [];
  const recordedRelatedFiles = runEntries
    .filter(({ run }) => run.status === 'finished')
    .flatMap(({ run }) => (run.verification ?? []).flatMap(relatedSelectedFiles))
    .filter(isDocsMetadataPath);
  let workingTreeDocs = [];
  let gitStatusAvailable = false;
  try {
    workingTreeDocs = collectGitChangedFiles(workspacePath).filter(isDocsMetadataPath);
    gitStatusAvailable = true;
  } catch {
    // A non-Git workspace is covered by recorded paths or the bounded scan.
  }
  let committedDocs = [];
  const docsBaselineRun = profile.id === 'docs_metadata'
    ? [...runEntries].reverse().find(({ run }) => (
        !run.runKind
        && run.status === 'finished'
        && run.git?.headSha
      ))?.run ?? null
    : null;
  const baselineGitHeadSha = fullEvidence?.item?.gitHeadSha
    ?? fullEvidence?.run?.git?.headSha
    ?? docsBaselineRun?.git?.headSha
    ?? null;
  let gitHistoryAvailable = false;
  if (baselineGitHeadSha) {
    try {
      committedDocs = collectGitChangedFilesSince(
        workspacePath,
        baselineGitHeadSha,
      ).filter(isDocsMetadataPath);
      gitHistoryAvailable = true;
    } catch {
      // Missing Git history is covered by recorded paths or the bounded scan.
    }
  }
  const candidates = [
    ...recordedDocs,
    ...recordedRelatedFiles,
    ...workingTreeDocs,
    ...committedDocs,
  ];
  if (profile.id === 'docs_metadata' && (!gitStatusAvailable || !gitHistoryAvailable)) {
    candidates.push(...(fullEvidence?.run?.docsMetadataBaseline ?? []));
    candidates.push(...docsMetadataFiles(workspacePath));
  }
  const nonConfigCandidates = candidates.filter(
    (candidate) => !P2A_VERIFICATION_METADATA_REF_SET.has(candidate),
  );
  const selectedCandidates = nonConfigCandidates.length ? nonConfigCandidates : candidates;
  return normalizeChangedFiles(
    workspacePath,
    selectedCandidates.length ? selectedCandidates : docsMetadataFiles(workspacePath),
  );
}

function assertRelatedSelectionCoverage(item, requiredFiles, profile) {
  const selectedFiles = relatedSelectedFiles(item);
  if (!selectedFiles.length) {
    throw verificationRequirementError(
      'relevant',
      'related verification is missing the selected-file argv binding required for current evidence',
      profile,
    );
  }
  const selected = new Set(selectedFiles);
  const missing = requiredFiles.filter((file) => !selected.has(file));
  if (!missing.length) return;
  throw verificationRequirementError(
    'relevant',
    `related verification did not cover the current documentation/metadata changes: ${missing.join(', ')}`,
    profile,
  );
}

function assertRelatedContentBinding(item, requiredFiles, workspacePath, profile) {
  const requiresSeparateBinding = requiredFiles.some((file) => (
    String(file).replaceAll('\\', '/').replace(/^\.\//u, '').startsWith('.plan2agent/')
  ));
  if (!requiresSeparateBinding) return;
  const selectedFiles = relatedSelectedFiles(item);
  if (!selectedFiles.length || typeof item.relatedFilesSha256 !== 'string') {
    throw verificationRequirementError(
      'relevant',
      'related verification for Plan2Agent metadata is missing a current file-content binding',
      profile,
    );
  }
  let currentSha256;
  try {
    currentSha256 = relatedFilesSha256(selectedFiles, { workspacePath });
  } catch (error) {
    throw verificationRequirementError(
      'relevant',
      `related verification file-content binding cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
      profile,
    );
  }
  if (currentSha256 !== item.relatedFilesSha256) {
    throw verificationRequirementError(
      'relevant',
      'related verification is stale because selected Plan2Agent metadata changed after it was checked',
      profile,
    );
  }
}

function normalizedObligationEvidence(runEntries, profile) {
  const currentRevision = '__p2a_current_verification_revision__';
  const normalizedToOriginal = new Map();
  const normalizedToEntry = new Map();
  const items = [];
  for (const entry of runEntries) {
    const currentRun = runRevisionMatches(entry, profile);
    for (const item of entry.run.verification ?? []) {
      const evidenceKindMatches = profile.id === 'docs_metadata'
        ? item.scope === 'related'
        : item.type !== 'custom' && item.scope === 'full';
      if (!evidenceKindMatches) continue;
      const currentItem = itemRevisionMatches(item, entry, profile);
      const canSatisfy = entry.run.status === 'finished' && currentRun && currentItem;
      const mustInvalidate = item.status === 'failed' && currentItem;
      if (!canSatisfy && !mustInvalidate) {
        items.push(item);
        continue;
      }
      const normalized = {
        ...item,
        workspaceRevisionSha256: currentRevision,
        productRevisionSha256: currentRevision,
      };
      normalizedToOriginal.set(normalized, item);
      normalizedToEntry.set(normalized, entry);
      items.push(normalized);
    }
  }
  return {
    items,
    normalizedToOriginal,
    normalizedToEntry,
    revisionOptions: {
      workspaceRevisionSha256: currentRevision,
      productRevisionSha256: currentRevision,
    },
  };
}

function latestRequiredVerificationAttempt(runEntries, profile) {
  const attempts = [];
  runEntries.forEach(({ run, runOrder, currentWorkspaceRevision, currentProductRevision }) => {
    (run.verification ?? []).forEach((item, itemOrder) => {
      const revisionMatches = profile.id !== 'docs_metadata'
        ? (
            item.workspaceRevisionSha256 === currentWorkspaceRevision
            || item.productRevisionSha256 === currentProductRevision
          )
        : item.workspaceRevisionSha256 === currentWorkspaceRevision;
      const evidenceKindMatches = profile.id === 'docs_metadata'
        ? item.scope === 'related'
        : item.type !== 'custom' && item.scope === 'full';
      if (
        (item.source !== 'config' && item.source !== 'command')
        || !evidenceKindMatches
        || !revisionMatches
      ) return;
      attempts.push({
        run,
        item,
        runOrder,
        itemOrder,
        currentWorkspaceRevision,
        currentProductRevision,
        timestamp: verificationCompletionTime(item, run),
      });
    });
  });
  return attempts.sort(compareAttemptRecency)[0] ?? null;
}

function latestRelevantVerificationAttempt(runEntries, profile) {
  const attempts = [];
  runEntries.forEach(({ run, runOrder, currentWorkspaceRevision }, entryOrder) => {
    const eligibleRun = profile.id === 'docs_metadata'
      ? (!run.runKind || run.runKind === 'final_verification')
      : run.runKind === 'final_verification' && run.verificationScope === 'relevant';
    if (!eligibleRun) return;
    (run.verification ?? []).forEach((item, itemOrder) => {
      if (
        item.scope !== 'related'
        || (item.source !== 'config' && item.source !== 'command')
        || item.workspaceRevisionSha256 !== currentWorkspaceRevision
      ) return;
      attempts.push({
        run,
        item,
        runOrder,
        entryOrder,
        itemOrder,
        currentWorkspaceRevision,
        timestamp: verificationCompletionTime(item, run),
      });
    });
  });
  return attempts.sort((left, right) => (
    compareAttemptRecency(left, right)
    || right.entryOrder - left.entryOrder
  ))[0] ?? null;
}

function finalVerificationScope(run) {
  if (run?.verificationScope === 'full' || run?.verificationScope === 'relevant') {
    return run.verificationScope;
  }
  const scopes = new Set((run?.verification ?? []).map((item) => item.scope));
  return scopes.has('related') && !scopes.has('full') ? 'relevant' : 'full';
}

function failedRunAffectsScope(run, scope) {
  if (!['failed', 'blocked'].includes(run?.status)) return false;
  const recordedScopes = new Set(
    (run.verification ?? [])
      .filter((item) => item?.source === 'config' || item?.source === 'command')
      .map((item) => item.scope),
  );
  if (recordedScopes.has(scope === 'relevant' ? 'related' : 'full')) return true;
  if (run.runKind === 'final_verification') {
    return finalVerificationScope(run) === scope;
  }
  if (run.runKind) return false;
  const runProfile = classifyVerificationProfile([run]);
  return scope === 'full'
    ? runProfile.id !== 'docs_metadata'
    : runProfile.id === 'docs_metadata';
}

function latestFailedVerificationRun(runEntries, scope) {
  return [...runEntries]
    .filter(({ run }) => failedRunAffectsScope(run, scope))
    .map((entry) => ({
      ...entry,
      timestamp: Math.max(
        runCompletionTime(entry.run),
        ...(entry.run.verification ?? [])
          .filter((item) => item.scope === (scope === 'relevant' ? 'related' : 'full'))
          .map((item) => verificationTime(item, entry.run)),
      ),
    }))
    .sort((left, right) => (
      right.timestamp - left.timestamp
      || right.runOrder - left.runOrder
    ))[0] ?? null;
}

function assertNoNewerVerificationFailure(runEntries, scope, successfulAttempt, profile) {
  const failed = latestFailedVerificationRun(runEntries, scope);
  if (!failed || (successfulAttempt && entryCompletedAfter(successfulAttempt, failed))) return;
  throw verificationRequirementError(
    scope,
    `latest ${scope} verification-affecting run ${failed.run.runId} is ${failed.run.status}; record a later successful ${scope} verification before close`,
    profile,
  );
}

function evidenceAfterLatestFailure(canonicalRuns, currentRunEntries, scope) {
  const failed = latestFailedVerificationRun(currentRunEntries, scope);
  return {
    failed,
    runs: failed
      ? canonicalRuns.filter((entry) => entryCompletedAfter(entry, failed))
      : canonicalRuns,
  };
}

export function passedFullVerificationItems(run, workspaceRevision, productRevision = null) {
  return (run?.verification ?? []).filter((item) => (
    item.type !== 'custom'
    && item.scope === 'full'
    && item.status === 'passed'
    && item.exitCode === 0
    && (item.source === 'config' || item.source === 'command')
    && (
      item.workspaceRevisionSha256 === workspaceRevision
      || (productRevision && item.productRevisionSha256 === productRevision)
    )
  ));
}

function passedRelevantVerificationItems(run, workspaceRevision) {
  return (run?.verification ?? []).filter((item) => (
    item.scope === 'related'
    &&
    item.status === 'passed'
    && item.exitCode === 0
    && (item.source === 'config' || item.source === 'command')
    && item.workspaceRevisionSha256 === workspaceRevision
  ));
}

export function assertFinalFullVerificationReady({
  runsDir,
  runs,
  artifactRoot,
  graphPath,
  activeIteration,
  workspaceRevisionProvider = workspaceRevisionSha256,
}) {
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const canonicalWorkspacePath = canonicalWorkspacePathForArtifactRoot(resolvedArtifactRoot);
  if (!existsSync(canonicalWorkspacePath) || !lstatSync(canonicalWorkspacePath).isDirectory()) {
    throw new Error(`canonical integration workspace is missing: ${canonicalWorkspacePath}`);
  }
  const currentRuns = (runs ?? []).filter((run) => (
    run.iterationId === activeIteration
    && run.sourceLayout === 'iteration'
    && taskGraphRefMatchesGraph(run.taskGraphRef, graphPath, resolvedArtifactRoot)
  ));
  const recordedProfile = classifyVerificationProfile(currentRuns);
  const workspaceRevisionCache = new Map();
  const currentWorkspaceRevisionForRun = (run) => {
    const excludedPaths = workspaceRevisionExcludedPathsForRun(runsDir, run, {
      artifactRoot: resolvedArtifactRoot,
      graphPath,
      workspacePath: canonicalWorkspacePath,
    });
    const cacheKey = JSON.stringify(
      [...new Set(excludedPaths.filter(Boolean).map((filePath) => path.resolve(filePath)))].sort(),
    );
    if (!workspaceRevisionCache.has(cacheKey)) {
      workspaceRevisionCache.set(
        cacheKey,
        workspaceRevisionProvider(canonicalWorkspacePath, excludedPaths),
      );
    }
    return workspaceRevisionCache.get(cacheKey);
  };
  const currentProductRevisionForRun = (run) => {
    const excludedPaths = [
      ...workspaceRevisionExcludedPathsForRun(runsDir, run, {
        artifactRoot: resolvedArtifactRoot,
        graphPath,
        workspacePath: canonicalWorkspacePath,
      }),
      ...productRevisionExcludedPaths(canonicalWorkspacePath),
    ];
    const cacheKey = `product:${JSON.stringify(
      [...new Set(excludedPaths.filter(Boolean).map((filePath) => path.resolve(filePath)))].sort(),
    )}`;
    if (!workspaceRevisionCache.has(cacheKey)) {
      workspaceRevisionCache.set(
        cacheKey,
        workspaceRevisionProvider(canonicalWorkspacePath, excludedPaths),
      );
    }
    return workspaceRevisionCache.get(cacheKey);
  };
  const currentRunEntries = currentRuns
    .map((run, runOrder) => ({ run, runOrder }))
    .map((entry) => ({
      ...entry,
      currentWorkspaceRevision: currentWorkspaceRevisionForRun(entry.run),
      currentProductRevision: currentProductRevisionForRun(entry.run),
    }));
  const profile = profileForCurrentProductState(recordedProfile, currentRunEntries);
  const canonicalRuns = currentRunEntries
    .filter(({ run }) => canonicalEvidenceRun(run, canonicalWorkspacePath, profile));
  const primaryScope = profile.id === 'docs_metadata' ? 'relevant' : 'full';
  const primaryEvidence = evidenceAfterLatestFailure(
    canonicalRuns,
    currentRunEntries,
    primaryScope,
  );
  const normalizedEvidence = normalizedObligationEvidence(primaryEvidence.runs, profile);
  const config = projectVerificationConfig(
    canonicalWorkspacePath,
    resolvedArtifactRoot,
    graphPath,
  );
  const configured = profile.id === 'docs_metadata'
    ? []
    : configuredVerificationObligations(config);
  const obligationEvaluation = evaluateVerificationObligations(
    normalizedEvidence.items,
    configured,
    normalizedEvidence.revisionOptions,
  );
  const latestAttempt = latestRequiredVerificationAttempt(primaryEvidence.runs, profile);
  assertNoNewerVerificationFailure(
    currentRunEntries,
    primaryScope,
    latestAttempt,
    profile,
  );
  const matchedRunRevision = latestAttempt
    ? runRevisionMatches(latestAttempt, profile)
    : false;
  const matched = latestAttempt
    && latestAttempt.run.status === 'finished'
    && matchedRunRevision
    && latestAttempt.item.status === 'passed'
    && latestAttempt.item.exitCode === 0
    ? latestAttempt
    : null;
  if (!matched) {
    const latest = [...primaryEvidence.runs]
      .filter(({ run }) => run.status === 'finished')
      .sort(compareRunEvidence)[0];
    if (
      latest
      && !runRevisionMatches(latest, profile)
    ) {
      throw verificationRequirementError(
        profile.id === 'docs_metadata' ? 'relevant' : 'full',
        `latest eligible verification evidence ${latest.run.runId} is stale for the current canonical workspace revision`,
        profile,
      );
    }
    throw verificationRequirementError(
      profile.id === 'docs_metadata' ? 'relevant' : 'full',
      profile.id === 'docs_metadata'
        ? 'no finished canonical run contains passed related evidence for the current docs/metadata revision'
        : profile.separateFinalRun
          ? 'no finished canonical final run contains passed full test/lint/typecheck evidence for the current product revision'
          : 'no finished canonical implementation or final run contains passed full test/lint/typecheck evidence for the current product revision',
      profile,
    );
  }
  if (obligationEvaluation.missing.length) {
    const missing = obligationEvaluation.missing
      .map((item) => `${item.type}:${item.command || '<unknown command>'}`)
      .join(', ');
    throw verificationRequirementError(
      profile.id === 'docs_metadata' ? 'relevant' : 'full',
      `missing required verification for the current revision: ${missing}. Run each missing check successfully before close.`,
      profile,
    );
  }
  const fullCoversCurrentWorkspace = obligationEvaluation.required.length
    ? obligationEvaluation.satisfied.every(({ latestAttempt: item }) => {
        const original = normalizedEvidence.normalizedToOriginal.get(item) ?? item;
        const entry = normalizedEvidence.normalizedToEntry.get(item);
        return Boolean(entry)
          && original.workspaceRevisionSha256 === entry.currentWorkspaceRevision;
      })
    : matched.item.workspaceRevisionSha256 === matched.currentWorkspaceRevision;
  const relevantAttempt = profile.id !== 'docs_metadata' && !fullCoversCurrentWorkspace
    ? latestRelevantVerificationAttempt(
        evidenceAfterLatestFailure(canonicalRuns, currentRunEntries, 'relevant').runs,
        profile,
      )
    : profile.id === 'docs_metadata'
      ? matched
      : null;
  if (profile.id !== 'docs_metadata' && !fullCoversCurrentWorkspace) {
    assertNoNewerVerificationFailure(currentRunEntries, 'relevant', relevantAttempt, profile);
  }
  const relevantMatched = relevantAttempt
    && relevantAttempt.run.status === 'finished'
    && relevantAttempt.item.status === 'passed'
    && relevantAttempt.item.exitCode === 0
    ? relevantAttempt
    : null;
  if (profile.id !== 'docs_metadata' && !fullCoversCurrentWorkspace && !relevantMatched) {
    throw verificationRequirementError(
      'relevant',
      'product verification is still current, but the current docs/metadata revision needs one finished related verification run before close',
      profile,
    );
  }
  if (relevantMatched) {
    const selectedFiles = relatedVerificationFiles(
      canonicalRuns,
      canonicalWorkspacePath,
      profile,
      profile.id === 'docs_metadata' ? null : matched,
    );
    assertRelatedSelectionCoverage(relevantMatched.item, selectedFiles, profile);
    assertRelatedContentBinding(
      relevantMatched.item,
      selectedFiles,
      canonicalWorkspacePath,
      profile,
    );
    const relatedConfigured = configuredRelatedVerificationObligations(
      relatedVerificationCommands(config),
      selectedFiles,
    );
    if (relatedConfigured.length) {
      const relatedEvidence = normalizedRelatedObligationEvidence(
        evidenceAfterLatestFailure(canonicalRuns, currentRunEntries, 'relevant').runs,
      );
      const relatedEvaluation = evaluateVerificationObligations(
        relatedEvidence.items,
        relatedConfigured,
        relatedEvidence.revisionOptions,
      );
      if (relatedEvaluation.missing.length) {
        const missing = relatedEvaluation.missing
          .map((item) => `${item.type}:${item.command || '<unknown command>'}`)
          .join(', ');
        throw verificationRequirementError(
          'relevant',
          `missing configured related verification for the current revision: ${missing}`,
          profile,
        );
      }
      for (const { latestAttempt: item } of relatedEvaluation.satisfied) {
        assertRelatedSelectionCoverage(item, selectedFiles, profile);
        assertRelatedContentBinding(
          item,
          selectedFiles,
          canonicalWorkspacePath,
          profile,
        );
      }
    }
  }
  return {
    run: matched.run,
    evidenceSource: FINAL_VERIFICATION_RUN_KINDS.has(matched.run.runKind)
      ? 'final_run'
      : 'implementation_run_reuse',
    workspaceRevisionSha256: matched.currentWorkspaceRevision,
    productRevisionSha256: matched.currentProductRevision,
    profile,
    relevantRun: relevantMatched?.run ?? null,
    verification: profile.id === 'docs_metadata'
      ? passedRelevantVerificationItems(matched.run, matched.currentWorkspaceRevision)
      : obligationEvaluation.required.length
        ? obligationEvaluation.satisfied.map(({ latestAttempt: item }) => (
            normalizedEvidence.normalizedToOriginal.get(item) ?? item
          )).concat(
            relevantMatched
              ? passedRelevantVerificationItems(
                  relevantMatched.run,
                  relevantMatched.currentWorkspaceRevision,
                )
              : [],
          )
        : passedFullVerificationItems(
            matched.run,
            matched.currentWorkspaceRevision,
            matched.currentProductRevision,
          ).concat(
            relevantMatched
              ? passedRelevantVerificationItems(
                  relevantMatched.run,
                  relevantMatched.currentWorkspaceRevision,
                )
              : [],
          ),
  };
}

export function iterationFullVerificationNeeded(options) {
  return iterationVerificationStatus(options).needed;
}

export function iterationVerificationStatus(options) {
  try {
    const ready = assertFinalFullVerificationReady(options);
    return { needed: false, profile: ready.profile, error: null, scope: null };
  } catch (error) {
    const profile = error?.verificationProfile ?? classifyVerificationProfile(options.runs);
    return {
      needed: true,
      profile,
      error: error instanceof Error ? error.message : String(error),
      scope: error?.verificationScope ?? (profile.id === 'docs_metadata' ? 'relevant' : 'full'),
    };
  }
}
