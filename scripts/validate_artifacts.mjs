#!/usr/bin/env node
/** Validate Plan2Agent JSON artifacts and golden fixtures with Node.js stdlib only. */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizePath, P2A_DIR, resolveP2aPaths } from './p2a_paths.mjs';
import {
  APPROVAL_SIDECAR_SHA256_PREFIX,
  REFERENCE_BUNDLE_SOURCE_DIRNAME,
  REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME,
  REFERENCE_BUNDLE_SNAPSHOT_FILENAME,
  REFERENCE_BUNDLE_USAGE_FILENAME,
} from './p2a_constants.mjs';
import { validatedPngDimensions } from './p2a_visual_media.mjs';
import {
  artifactRunRef,
  canonicalRunRef,
  defaultArtifactRootForGraph,
  executionEnvelopeStoreRef,
  isRunRecordFile,
  isSupportedRunRef,
  legacyRunRef,
  normalizeIndexedRunRef,
  RUN_SIDECAR_SUFFIXES,
  safeRunStoreFilePath,
  runSidecarPath,
  taskContractSha256,
  taskGraphRefMatchesGraph,
} from './p2a_run_paths.mjs';
import {
  baselineSupersessionViolations,
  compositionReplayContractError,
  compositionSourceContractError,
  composeCanonicalSpecSources,
  decisionAffectedSpecRefs,
  findSpecCapabilityContradictions,
  isComposedBaselineReference,
  isSupersedingDecision,
  supersedingDecisionResolution,
} from './p2a_spec_model.mjs';
import { inspectEntryDocument } from './p2a_radar_preflight.mjs';
import {
  assertRunMonitorGateBinding,
  assertRunMonitorVerdictBinding,
  normalizeMonitorGateSidecar,
  normalizeMonitorVerdictData,
} from './p2a_monitor_gate.mjs';
import { ValidationError, validateSchema } from './p2a_schema.mjs';
import { missingRequiredFailureDetails } from './p2a_failure_details.mjs';
import { runWriteTransactionPath } from './p2a_run_store.mjs';

export { ValidationError, validateSchema } from './p2a_schema.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const SCHEMA_PATHS = {
  constitution: path.join(P2A_PATHS.schemasDir, 'constitution.schema.json'),
  current_development_contract: path.join(P2A_PATHS.schemasDir, 'current-development-contract.schema.json'),
  decisions: path.join(P2A_PATHS.schemasDir, 'decisions.schema.json'),
  intake: path.join(P2A_PATHS.schemasDir, 'intake.schema.json'),
  spec: path.join(P2A_PATHS.schemasDir, 'spec.schema.json'),
  reference_bundle_snapshot: path.join(P2A_PATHS.schemasDir, 'reference-bundle-snapshot.schema.json'),
  reference_bundle_usage: path.join(P2A_PATHS.schemasDir, 'reference-bundle-usage.schema.json'),
  task_graph: path.join(P2A_PATHS.schemasDir, 'task-graph.schema.json'),
  task_context: path.join(P2A_PATHS.schemasDir, 'task-context.schema.json'),
  review: path.join(P2A_PATHS.schemasDir, 'review.schema.json'),
  run: path.join(P2A_PATHS.schemasDir, 'run.schema.json'),
  run_index: path.join(P2A_PATHS.schemasDir, 'run-index.schema.json'),
  visual_experience: path.join(P2A_PATHS.schemasDir, 'visual-experience.schema.json'),
  visual_prototype: path.join(P2A_PATHS.schemasDir, 'visual-prototype.schema.json'),
  visual_review: path.join(P2A_PATHS.schemasDir, 'visual-review.schema.json'),
  acceptance_review: path.join(P2A_PATHS.schemasDir, 'acceptance-review.schema.json'),
  milestone_review: path.join(P2A_PATHS.schemasDir, 'milestone-review.schema.json'),
  retrospective_candidate: path.join(P2A_PATHS.schemasDir, 'retrospective-candidate.schema.json'),
  skill_proposal: path.join(P2A_PATHS.schemasDir, 'skill-proposal.schema.json'),
  proposal_review: path.join(P2A_PATHS.schemasDir, 'proposal-review.schema.json'),
  proposal_curation: path.join(P2A_PATHS.schemasDir, 'proposal-curation.schema.json'),
  proposal_patch_draft: path.join(P2A_PATHS.schemasDir, 'proposal-patch-draft.schema.json'),
  proposal_draft_approval: path.join(P2A_PATHS.schemasDir, 'proposal-draft-approval.schema.json'),
  eval_index: path.join(P2A_PATHS.schemasDir, 'eval-index.schema.json'),
  eval_digest: path.join(P2A_PATHS.schemasDir, 'eval-digest.schema.json'),
  eval_maintenance_draft: path.join(P2A_PATHS.schemasDir, 'eval-maintenance-draft.schema.json'),
  eval_maintenance_apply_report: path.join(P2A_PATHS.schemasDir, 'eval-maintenance-apply-report.schema.json'),
};
const SCHEMA_CACHE = new Map();
const GATE_PATHS = {
  decisions: 'decisions.jsonl',
  statusDoc: 'status.md',
  intakeJson: path.join('gate-a-intake', 'intake.json'),
  intakeMd: path.join('gate-a-intake', 'intake.md'),
  productSpec: path.join('gate-b-spec', 'product-spec.md'),
  implementationPlan: path.join('gate-b-spec', 'implementation-plan.md'),
  specJson: path.join('gate-b-spec', 'spec.json'),
  taskGraph: path.join('gate-c-task-graph', 'task-graph.json'),
  reviewReport: path.join('gate-d-review', 'review-report.md'),
  reviewJson: path.join('gate-d-review', 'review.json'),
};

function expectedExecutionGuide(agentTool, role, profile) {
  if (agentTool === 'codex') {
    return {
      surface: 'Codex CLI/app foreground session',
      recommendedFeature: role === 'contributor'
        ? 'skills_custom_agents_explicit_subagent_prompt'
        : 'read_only_review_skill_or_custom_agent_prompt',
      fallbackMode: 'single supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Open Codex manually in the foreground workspace.'],
    };
  }
  if (agentTool === 'claude') {
    return {
      surface: 'Claude Code foreground session',
      recommendedFeature: role === 'contributor'
        ? 'agent_teams_or_subagents'
        : 'read_only_review_subagent',
      fallbackMode: 'supervised foreground role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Open Claude Code manually in the foreground workspace.'],
    };
  }
  if (agentTool === 'gemini') {
    return {
      surface: 'Gemini CLI foreground session',
      recommendedFeature: 'extensions_custom_commands_gemini_context',
      fallbackMode: 'read-only supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: ['Use Gemini only for read-only planning, review, or monitor support.'],
    };
  }
  return {
    surface: 'Human owner foreground action',
    recommendedFeature: role === 'lead'
      ? 'manual_approval_and_run_lifecycle'
      : 'manual_prompt_copy_and_status_recording',
    fallbackMode: 'manual status update',
    supervisionRequired: true,
    startsProcess: false,
    constraints: [
      profile === 'manual_monitor'
        ? 'Record an explicit monitor verdict before finish.'
        : 'Perform the role directly in the foreground workspace.',
    ],
  };
}

function roleWithExecutionGuide(role) {
  if (role.executionGuide) return role;
  return {
    ...role,
    executionGuide: expectedExecutionGuide(role.agentTool, role.role, role.profile),
  };
}

/**
 * @deprecated Kept as a compatibility export for scaffolded runtime consumers.
 */
export function normalizeOrchestrationPlanData(data) {
  const normalized = JSON.parse(JSON.stringify(data));
  if (Array.isArray(normalized?.roles)) {
    normalized.roles = normalized.roles.map(roleWithExecutionGuide);
  }
  return normalized;
}

/**
 * @deprecated Kept as a compatibility export for scaffolded runtime consumers.
 */
export function normalizeOrchestrationRuntimeData(data) {
  const normalized = JSON.parse(JSON.stringify(data));
  const roleAssignments = normalized?.sharedMentalModel?.roleAssignments;
  if (Array.isArray(roleAssignments)) {
    normalized.sharedMentalModel.roleAssignments = roleAssignments.map(roleWithExecutionGuide);
  }
  return normalized;
}

export function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadSchema(schemaName) {
  if (!SCHEMA_CACHE.has(schemaName)) {
    SCHEMA_CACHE.set(schemaName, loadJson(SCHEMA_PATHS[schemaName]));
  }
  return SCHEMA_CACHE.get(schemaName);
}

export function createValidationSession() {
  return {
    artifactValidations: new Map(),
    fileSnapshots: new Map(),
    stats: {
      fileReads: 0,
      jsonParses: 0,
      validatorRuns: {},
    },
  };
}

function validationFileSnapshot(filePath, options = {}) {
  const session = options.validationSession;
  if (!(session?.fileSnapshots instanceof Map)) return null;
  const resolvedPath = existsSync(filePath) ? realpathSync(filePath) : path.resolve(filePath);
  const stat = statSync(resolvedPath);
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const cached = session.fileSnapshots.get(resolvedPath);
  if (cached?.signature === signature) return cached;
  const source = readFileSync(resolvedPath, 'utf8');
  session.stats.fileReads += 1;
  const data = JSON.parse(source);
  session.stats.jsonParses += 1;
  const snapshot = {
    resolvedPath,
    signature,
    sha256: createHash('sha256').update(source).digest('hex'),
    data,
  };
  session.fileSnapshots.set(resolvedPath, snapshot);
  return snapshot;
}

function loadValidationJson(filePath, options = {}) {
  return validationFileSnapshot(filePath, options)?.data ?? loadJson(filePath);
}

function validationFileIdentity(filePath, options = {}) {
  const snapshot = validationFileSnapshot(filePath, options);
  if (!snapshot) return path.resolve(filePath);
  return `${snapshot.resolvedPath}\n${snapshot.sha256}`;
}

function recordValidationRun(options, kind) {
  const stats = options.validationSession?.stats;
  if (!stats) return;
  stats.validatorRuns[kind] = (stats.validatorRuns[kind] ?? 0) + 1;
}

function validationSessionKey(kind, filePath, options = {}, suffix = '') {
  const session = options.validationSession;
  if (!(session?.artifactValidations instanceof Map)) return null;
  const snapshot = validationFileSnapshot(filePath, options);
  const artifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : '';
  const constitutionPath = options.constitutionPath
    ? path.resolve(options.constitutionPath)
    : '';
  const requiresMissingBaselineRoot = (
    options.requireBaselineContextArtifactRoot === true
    && !options.artifactRoot
  );
  return [
    kind,
    snapshot.resolvedPath,
    snapshot.sha256,
    artifactRoot,
    constitutionPath,
    kind === 'intake' ? '' : options.projectId ?? '',
    requiresMissingBaselineRoot ? 'baseline-required' : '',
    options.requireApprovedConstitution === false ? 'constitution-optional' : '',
    suffix,
  ].join('\n');
}

function cachedValidation(options, key) {
  if (!key) return null;
  const cache = options.validationSession.artifactValidations;
  return cache.has(key) ? { hit: true, value: cache.get(key) } : null;
}

function cacheValidation(options, key, value) {
  if (key) options.validationSession.artifactValidations.set(key, value);
  return value;
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new ValidationError(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new ValidationError(`${label} must be a file: ${filePath}`);
}

function assertFileInsideArtifactRoot(filePath, artifactRoot, label) {
  const realArtifactRoot = realpathSync(artifactRoot);
  const realFilePath = realpathSync(filePath);
  const relative = path.relative(realArtifactRoot, realFilePath);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new ValidationError(`${label} resolves outside the artifact root`);
  }
}

function resolveProjectRelativeReference(reference, baseDir) {
  if (!reference.startsWith(`${P2A_DIR}/`) && !reference.startsWith(`${P2A_DIR}${path.sep}`)) return null;
  let current = path.resolve(baseDir);
  while (true) {
    const p2aDir = path.join(current, P2A_DIR);
    if (existsSync(p2aDir) && lstatSync(p2aDir).isDirectory()) {
      return path.resolve(current, reference);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveExistingFileReference(reference, baseDir) {
  if (!reference || typeof reference !== 'string') return null;
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(process.cwd(), reference),
        path.resolve(baseDir, reference),
        path.resolve(P2A_PATHS.toolRoot, reference),
        resolveProjectRelativeReference(reference, baseDir),
      ];
  return candidates.filter(Boolean).find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
}

export function resolveSpecSourceIntake(specPath, specReference = loadJson(specPath)) {
  return resolveExistingFileReference(specReference.source_intake, path.dirname(specPath));
}

function requireSpecSourceIntake(specPath, specReference = loadJson(specPath)) {
  if (!specReference.source_intake) return null;
  const sourceIntakePath = resolveSpecSourceIntake(specPath, specReference);
  if (!sourceIntakePath) {
    throw new ValidationError(`spec.source_intake cannot be resolved to a file: ${JSON.stringify(specReference.source_intake)}`);
  }
  return sourceIntakePath;
}

function inferArtifactRootFromIntakePath(intakePath) {
  const resolvedIntakePath = path.resolve(intakePath);
  const gateADir = path.dirname(resolvedIntakePath);
  if (path.basename(gateADir) === 'gate-a-intake') {
    const gateContainer = path.dirname(gateADir);
    const gateContainerParent = path.dirname(gateContainer);
    if (path.basename(gateContainerParent) === 'iterations') {
      return path.dirname(gateContainerParent);
    }
    return gateContainer;
  }

  let current = path.dirname(resolvedIntakePath);
  while (true) {
    const currentSpecPath = path.join(current, 'current-spec.json');
    if (existsSync(currentSpecPath) && lstatSync(currentSpecPath).isFile()) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function validateAgainstSchema(filePath, schemaName, options = {}) {
  const cacheKey = validationSessionKey(`schema:${schemaName}`, filePath, options);
  const cached = cachedValidation(options, cacheKey);
  if (cached) return cached.value;
  const data = loadValidationJson(filePath, options);
  const schema = loadSchema(schemaName);
  validateSchema(data, schema);
  return cacheValidation(options, cacheKey, data);
}

export function validateEvidence(evidence, label) {
  const sourceIds = evidence.map((item) => item.source_id);
  if (sourceIds.length !== new Set(sourceIds).size) {
    throw new ValidationError(`${label}.evidence source_id values must be unique`);
  }
  for (const item of evidence) {
    if (item.source_id.startsWith('WEB-') && !(item.url ?? '').startsWith('http://') && !(item.url ?? '').startsWith('https://')) {
      throw new ValidationError(`${label}.evidence ${item.source_id} must include an http(s) url`);
    }
  }
}

function assertPortableSnapshotPath(value, label) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw new ValidationError(`${label} must be a non-empty snapshot-relative path`);
  }
  const normalized = normalizeReference(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ValidationError(`${label} must not escape the Gate A snapshot directory`);
  }
  return normalized;
}

const REFERENCE_BUNDLE_CAPTURE_PREFIX = `${REFERENCE_BUNDLE_SOURCE_DIRNAME}/${REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME}/`;

function approvalAuditRequiresSidecar(approvalAudit, filename) {
  if (!approvalAudit || typeof approvalAudit !== 'object') return false;
  if ((approvalAudit.approved_artifacts ?? []).some((reference) => (
    typeof reference === 'string'
    && path.posix.basename(normalizeReference(reference)) === filename
  ))) {
    return true;
  }
  const bindingPrefix = `${APPROVAL_SIDECAR_SHA256_PREFIX} `;
  return String(approvalAudit.approval_note ?? '')
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(bindingPrefix)) return false;
      const [reference] = trimmed.slice(bindingPrefix.length).split(/\s+/);
      return path.posix.basename(normalizeReference(reference ?? '')) === filename;
    });
}

function resolveSnapshotCapturedFile(snapshotPath, reference, label) {
  const normalized = assertPortableSnapshotPath(reference, label);
  if (!normalized.startsWith(REFERENCE_BUNDLE_CAPTURE_PREFIX)) {
    throw new ValidationError(
      `${label} must reference a captured file under ${REFERENCE_BUNDLE_CAPTURE_PREFIX}`,
    );
  }
  const snapshotDirectory = path.dirname(path.resolve(snapshotPath));
  const sourceRoot = path.join(
    snapshotDirectory,
    REFERENCE_BUNDLE_SOURCE_DIRNAME,
  );
  const captureRoot = path.join(
    sourceRoot,
    REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME,
  );
  if (!existsSync(sourceRoot)) {
    throw new ValidationError(
      `Gate A reference source capture is missing: ${sourceRoot}`,
    );
  }
  if (!lstatSync(sourceRoot).isDirectory()) {
    throw new ValidationError(
      `Gate A reference source capture root must be a real directory: ${sourceRoot}`,
    );
  }
  if (!existsSync(captureRoot) || !lstatSync(captureRoot).isDirectory()) {
    throw new ValidationError(
      `Gate A reference source capture is missing: ${captureRoot}`,
    );
  }
  const realSnapshotDirectory = realpathSync(snapshotDirectory);
  const realCaptureRoot = realpathSync(captureRoot);
  if (!pathIsAtOrUnder(realSnapshotDirectory, realCaptureRoot)) {
    throw new ValidationError(
      'Gate A reference source capture must stay inside the Gate A snapshot directory',
    );
  }
  const filePath = path.resolve(snapshotDirectory, normalized);
  assertFile(filePath, label);
  if (!pathIsAtOrUnder(realCaptureRoot, realpathSync(filePath))) {
    throw new ValidationError(`${label} resolves outside the Gate A reference source capture`);
  }
  return {
    path: filePath,
    captureRoot,
    relativePath: normalizePath(path.relative(captureRoot, filePath)),
  };
}

function validateReferenceBundleSnapshotSources(snapshotPath, snapshot) {
  const bundle = resolveSnapshotCapturedFile(
    snapshotPath,
    snapshot.source_bundle_ref,
    'reference bundle snapshot.source_bundle_ref',
  );
  const entry = resolveSnapshotCapturedFile(
    snapshotPath,
    snapshot.entry_ref,
    'reference bundle snapshot.entry_ref',
  );
  if (snapshot.source_bundle_sha256 !== rawFileSha256(bundle.path)) {
    throw new ValidationError(
      'reference bundle snapshot.source_bundle_sha256 does not match the captured source bundle',
    );
  }
  if (snapshot.entry_sha256 !== rawFileSha256(entry.path)) {
    throw new ValidationError(
      'reference bundle snapshot.entry_sha256 does not match the captured entry document',
    );
  }

  const inspected = inspectEntryDocument(entry.path, {
    baseDir: bundle.captureRoot,
    referenceRoot: bundle.captureRoot,
    referenceBundlePath: bundle.path,
    selection: 'gate-a-snapshot',
  });
  if (!inspected.valid || !inspected.referenceBundle?.valid) {
    const errors = [...new Set([
      ...(inspected.errors ?? []),
      ...(inspected.referenceBundle?.errors ?? []),
    ])];
    throw new ValidationError(
      `Gate A reference source capture fails entry validation: ${errors.join('; ')}`,
    );
  }
  if (inspected.referenceBundle.sha256 !== snapshot.source_bundle_sha256) {
    throw new ValidationError(
      'reference bundle snapshot source bundle hash differs from the validated capture',
    );
  }

  const inspectedById = new Map(
    inspected.referenceBundle.references.map((reference) => [reference.id, reference]),
  );
  if (inspectedById.size !== snapshot.references.length) {
    throw new ValidationError(
      'reference bundle snapshot references must exactly match the captured source bundle',
    );
  }
  for (const reference of snapshot.references) {
    const captured = resolveSnapshotCapturedFile(
      snapshotPath,
      reference.path,
      `reference bundle snapshot ${reference.id}.path`,
    );
    if (reference.sha256 !== rawFileSha256(captured.path)) {
      throw new ValidationError(
        `reference bundle snapshot ${reference.id}.sha256 does not match the captured reference file`,
      );
    }
    const declared = inspectedById.get(reference.id);
    if (
      !declared
      || declared.path !== captured.relativePath
      || declared.kind !== reference.kind
      || declared.sha256 !== reference.sha256
      || declared.loadWhen !== reference.load_when
      || declared.description !== reference.description
    ) {
      throw new ValidationError(
        `reference bundle snapshot ${reference.id} metadata does not match the captured source bundle`,
      );
    }
  }
}

function optionalSidecarPath(primaryPath, filename, label) {
  const sidecarPath = path.join(path.dirname(path.resolve(primaryPath)), filename);
  if (!existsSync(sidecarPath)) return null;
  assertFile(sidecarPath, label);
  return sidecarPath;
}

function pathIsAtOrUnder(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function approvalSidecarRef(sidecarPath, artifactRoot, label) {
  if (!artifactRoot) return normalizePath(path.basename(sidecarPath));
  if (!pathIsAtOrUnder(artifactRoot, sidecarPath)) {
    throw new ValidationError(`${label} must stay inside the artifact root`);
  }
  return normalizePath(path.relative(path.resolve(artifactRoot), path.resolve(sidecarPath)));
}

function validateApprovalSidecarBinding(approvalAudit, sidecarPath, artifactRoot, label) {
  const sidecarRef = approvalSidecarRef(sidecarPath, artifactRoot, label);
  const approvedRefs = new Set(
    approvalAudit.approved_artifacts.map((item) => normalizeReference(item)),
  );
  const approvedSidecarRef = [...approvedRefs].find((reference) => (
    reference === sidecarRef || reference.endsWith(`/${sidecarRef}`)
  ));
  if (!approvedSidecarRef) {
    throw new ValidationError(
      `${label} must be listed in approval_audit.approved_artifacts as ${sidecarRef}`,
    );
  }
  const binding = `${APPROVAL_SIDECAR_SHA256_PREFIX} ${approvedSidecarRef} ${rawFileSha256(sidecarPath)}`;
  const approvalLines = approvalAudit.approval_note.split(/\r?\n/).map((line) => line.trim());
  if (!approvalLines.includes(binding)) {
    throw new ValidationError(
      `${label} approval_audit.approval_note must bind the exact sidecar hash with ${JSON.stringify(binding)}`,
    );
  }
}

function validateReferenceBundleSnapshot(intakePath, intake, options = {}) {
  const snapshotPath = optionalSidecarPath(
    intakePath,
    REFERENCE_BUNDLE_SNAPSHOT_FILENAME,
    'Gate A reference bundle snapshot',
  );
  if (!snapshotPath) {
    if (
      intake.status === 'ready_for_spec'
      && approvalAuditRequiresSidecar(
        intake.approval_audit,
        REFERENCE_BUNDLE_SNAPSHOT_FILENAME,
      )
    ) {
      throw new ValidationError(
        'Gate A reference-bundle-snapshot.json is required by intake.approval_audit',
      );
    }
    return null;
  }
  const snapshot = validateAgainstSchema(snapshotPath, 'reference_bundle_snapshot');
  assertPortableSnapshotPath(
    snapshot.source_bundle_ref,
    'reference bundle snapshot.source_bundle_ref',
  );
  assertPortableSnapshotPath(snapshot.entry_ref, 'reference bundle snapshot.entry_ref');
  const ids = new Set();
  const paths = new Set();
  for (const reference of snapshot.references) {
    if (ids.has(reference.id)) {
      throw new ValidationError(`reference bundle snapshot contains duplicate id ${reference.id}`);
    }
    ids.add(reference.id);
    const referencePath = assertPortableSnapshotPath(
      reference.path,
      `reference bundle snapshot ${reference.id}.path`,
    );
    if (paths.has(referencePath)) {
      throw new ValidationError(`reference bundle snapshot contains duplicate path ${referencePath}`);
    }
    paths.add(referencePath);
  }
  validateReferenceBundleSnapshotSources(snapshotPath, snapshot);
  if (intake.status === 'ready_for_spec') {
    const artifactRoot = options.artifactRoot ?? inferArtifactRootFromIntakePath(intakePath);
    validateApprovalSidecarBinding(
      intake.approval_audit,
      snapshotPath,
      artifactRoot,
      'Gate A reference bundle snapshot',
    );
  }
  return {
    data: snapshot,
    path: snapshotPath,
    sha256: rawFileSha256(snapshotPath),
  };
}

const REFERENCE_SUPPORTED_DECISION_ROOTS = new Set([
  'product',
  'implementation',
  'visual_experience',
  'reference_reconnaissance',
]);

function referenceSupportedDecisionExists(spec, reference) {
  const segments = String(reference).split('.');
  if (
    segments.shift() !== 'spec'
    || !segments.length
    || !REFERENCE_SUPPORTED_DECISION_ROOTS.has(segments[0])
  ) {
    return false;
  }
  let current = spec;
  for (const segment of segments) {
    if (
      current === null
      || typeof current !== 'object'
      || !Object.hasOwn(current, segment)
    ) {
      return false;
    }
    current = current[segment];
  }
  return true;
}

function validateReferenceBundleUsage(specPath, spec, intakePath, intake, artifactRoot) {
  const snapshot = intakePath
    ? validateReferenceBundleSnapshot(intakePath, intake, { artifactRoot })
    : null;
  const usagePath = optionalSidecarPath(
    specPath,
    REFERENCE_BUNDLE_USAGE_FILENAME,
    'Gate B reference bundle usage',
  );
  if (
    !usagePath
    && spec.approval === 'approved'
    && approvalAuditRequiresSidecar(
      spec.approval_audit,
      REFERENCE_BUNDLE_USAGE_FILENAME,
    )
  ) {
    throw new ValidationError(
      'Gate B reference-bundle-usage.json is required by spec.approval_audit',
    );
  }
  if (snapshot && spec.approval === 'approved' && !usagePath) {
    throw new ValidationError(
      'Gate B reference-bundle-usage.json is required when an approved spec derives from a Gate A reference bundle snapshot',
    );
  }
  if (usagePath && !snapshot) {
    throw new ValidationError(
      'Gate B reference-bundle-usage.json requires a matching Gate A reference-bundle-snapshot.json',
    );
  }
  if (!usagePath) return null;
  const usage = validateAgainstSchema(usagePath, 'reference_bundle_usage');
  const snapshotReference = usage.source_snapshot_ref;
  if (
    typeof snapshotReference !== 'string'
    || !snapshotReference.trim()
    || path.isAbsolute(snapshotReference)
    || path.win32.isAbsolute(snapshotReference)
  ) {
    throw new ValidationError(
      'reference bundle usage.source_snapshot_ref must be a non-empty relative path',
    );
  }
  const resolvedSnapshotPath = path.resolve(path.dirname(usagePath), snapshotReference);
  if (
    !existsSync(resolvedSnapshotPath)
    || !lstatSync(resolvedSnapshotPath).isFile()
    || realpathSync(resolvedSnapshotPath) !== realpathSync(snapshot.path)
  ) {
    throw new ValidationError(
      'reference bundle usage.source_snapshot_ref must resolve to the source intake snapshot',
    );
  }
  if (usage.source_snapshot_sha256 !== snapshot.sha256) {
    throw new ValidationError(
      'reference bundle usage.source_snapshot_sha256 does not match the Gate A snapshot',
    );
  }
  if (
    normalizeReference(usage.source_bundle_ref) !== normalizeReference(snapshot.data.source_bundle_ref)
    || usage.source_bundle_sha256 !== snapshot.data.source_bundle_sha256
  ) {
    throw new ValidationError(
      'reference bundle usage source bundle ref and hash must match the Gate A snapshot',
    );
  }
  const snapshotById = new Map(
    snapshot.data.references.map((reference) => [reference.id, reference]),
  );
  const evidenceById = new Map((spec.evidence ?? []).map((item) => [item.source_id, item]));
  const usedReferenceIds = new Set();
  const usedEvidenceIds = new Set();
  const usageByEvidenceId = new Map();
  for (const referenceUsage of usage.inspected_references) {
    if (usedReferenceIds.has(referenceUsage.id)) {
      throw new ValidationError(`reference bundle usage contains duplicate id ${referenceUsage.id}`);
    }
    if (usedEvidenceIds.has(referenceUsage.evidence_source_id)) {
      throw new ValidationError(
        `reference bundle usage evidence_source_id must identify one inspected file: ${referenceUsage.evidence_source_id}`,
      );
    }
    usedReferenceIds.add(referenceUsage.id);
    usedEvidenceIds.add(referenceUsage.evidence_source_id);
    const declared = snapshotById.get(referenceUsage.id);
    if (!declared || declared.sha256 !== referenceUsage.sha256) {
      throw new ValidationError(
        `reference bundle usage ${referenceUsage.id} does not match the approved Gate A reference hash`,
      );
    }
    const evidence = evidenceById.get(referenceUsage.evidence_source_id);
    if (!evidence || !referenceUsage.evidence_source_id.startsWith('LOCAL-')) {
      throw new ValidationError(
        `reference bundle usage ${referenceUsage.id} requires matching LOCAL-n evidence`,
      );
    }
    if (normalizeReference(evidence.url) !== normalizeReference(declared.path)) {
      throw new ValidationError(
        `reference bundle usage ${referenceUsage.id} evidence url must match ${declared.path}`,
      );
    }
    if (!referenceSupportedDecisionExists(spec, referenceUsage.supported_decision)) {
      throw new ValidationError(
        `reference bundle usage ${referenceUsage.id}.supported_decision must resolve to an existing spec product, implementation, visual_experience, or reference_reconnaissance field`,
      );
    }
    usageByEvidenceId.set(referenceUsage.evidence_source_id, referenceUsage);
  }
  const snapshotIdByPath = new Map(snapshot.data.references.map((reference) => [
    normalizeReference(reference.path),
    reference.id,
  ]));
  for (const evidence of spec.evidence ?? []) {
    if (!evidence.source_id.startsWith('LOCAL-')) continue;
    const referenceId = snapshotIdByPath.get(normalizeReference(evidence.url));
    if (!referenceId) continue;
    const referenceUsage = usageByEvidenceId.get(evidence.source_id);
    if (!referenceUsage || referenceUsage.id !== referenceId) {
      throw new ValidationError(
        `spec evidence ${evidence.source_id} cites captured reference ${referenceId} but is not mapped exactly once in reference bundle usage`,
      );
    }
  }
  if (spec.approval === 'approved') {
    validateApprovalSidecarBinding(
      spec.approval_audit,
      usagePath,
      artifactRoot,
      'Gate B reference bundle usage',
    );
  }
  return {
    data: usage,
    path: usagePath,
    sha256: rawFileSha256(usagePath),
  };
}

const TECHNOLOGY_RECON_PATTERN = /\b(?:cloud|cloud service|database|db|external api|external service|framework|library|npm|package|protocol|runtime|sdk|typescript|node\.?js|python|react|redis|postgres|postgresql|mysql|sqlite|queue|kafka|rabbitmq|aws|gcp|azure)\b/gi;
const TECHNOLOGY_RECON_NEGATION_PATTERN = /\b(?:no|without|avoid(?:s|ed|ing)?|prohibit(?:s|ed|ing)?|forbid(?:s|den|ding)?|exclude(?:s|d|ing)?|not|do not|don't)\b/i;

function hasMaterialTechnologyReconTrigger(item) {
  const text = item.trim();
  if (/^(?:none|n\/a|not applicable)$/i.test(text)) return false;

  for (const match of text.matchAll(TECHNOLOGY_RECON_PATTERN)) {
    const precedingPhrase = text.slice(0, match.index).split(/[.;:,(\[\]{}]/).pop() ?? '';
    if (!TECHNOLOGY_RECON_NEGATION_PATTERN.test(precedingPhrase)) {
      return true;
    }
  }
  return false;
}

function specTechnologyReconTriggers(spec) {
  const candidateFields = [
    ...(spec.product?.external_integrations ?? []),
    ...(spec.implementation?.architecture ?? []),
    ...(spec.implementation?.interfaces ?? []),
    ...(spec.implementation?.dependencies ?? []),
  ];
  return candidateFields
    .filter((item) => typeof item === 'string')
    .filter((item) => hasMaterialTechnologyReconTrigger(item));
}

function validateTechnologyReconnaissanceEvidence(spec) {
  if (spec.approval !== 'approved') return;
  const triggers = specTechnologyReconTriggers(spec);
  if (!triggers.length) return;
  const hasWebEvidence = (spec.evidence ?? []).some((item) => item.source_id.startsWith('WEB-'));
  if (!hasWebEvidence) {
    throw new ValidationError(
      `approved spec with material technology choices requires WEB-n evidence from Gate B Technology Reconnaissance: ${JSON.stringify(triggers.slice(0, 3))}`,
    );
  }
}

function validateReferenceReconnaissance(spec) {
  const reconnaissance = spec.reference_reconnaissance;
  if (!reconnaissance) return;

  if (spec.approval === 'approved' && reconnaissance.open_questions.length) {
    throw new ValidationError('approved spec must not contain reference_reconnaissance.open_questions');
  }

  const evidenceById = new Map((spec.evidence ?? []).map((item) => [item.source_id, item]));
  const evidenceIds = new Set(evidenceById.keys());
  const candidateIds = reconnaissance.candidates.map((candidate) => candidate.candidate_id);
  if (candidateIds.length !== new Set(candidateIds).size) {
    throw new ValidationError('spec.reference_reconnaissance candidate_id values must be unique');
  }

  for (const candidate of reconnaissance.candidates) {
    if (!evidenceIds.has(candidate.source_id)) {
      throw new ValidationError(`spec.reference_reconnaissance ${candidate.candidate_id} references unknown evidence source_id ${candidate.source_id}`);
    }
    const evidence = evidenceById.get(candidate.source_id);
    const isFeatureRadarCandidate = candidate.origin === 'feature_radar_preflight'
      || (typeof candidate.title === 'string' && candidate.title.startsWith('Feature Radar:'))
      || (typeof evidence?.title === 'string' && evidence.title.startsWith('Feature Radar '))
      || (typeof evidence?.used_for === 'string' && evidence.used_for.includes('Feature Radar'));
    if (
      spec.approval === 'approved'
      && isFeatureRadarCandidate
      && (candidate.decision === 'context' || candidate.decision === 'open')
    ) {
      throw new ValidationError(`approved spec must resolve Feature Radar candidate ${candidate.candidate_id} as selected, rejected, or deferred before Gate B approval`);
    }
  }

  const knownCandidateIds = new Set(candidateIds);
  for (const pattern of [...reconnaissance.selected_patterns, ...reconnaissance.rejected_patterns]) {
    if (!knownCandidateIds.has(pattern.candidate_id)) {
      throw new ValidationError(`spec.reference_reconnaissance pattern references unknown candidate_id ${pattern.candidate_id}`);
    }
  }
}

function validateIntakeQuestion(question) {
  const hasAnswer = Object.hasOwn(question, 'answer');
  const hasNonBlankAnswer = (
    typeof question.answer === 'string'
    && question.answer.trim().length > 0
  );
  if (question.status === 'open' && hasAnswer) {
    throw new ValidationError(`${question.id} is open but has an answer`);
  }
  if (
    ['answered', 'assumed', 'not_applicable'].includes(question.status)
    && !hasNonBlankAnswer
  ) {
    throw new ValidationError(`${question.id} is ${question.status} but has no non-blank answer`);
  }
}

function baselineDispositionResolution(disposition) {
  return disposition.resolved_by
    ?? disposition.assumption
    ?? disposition.non_goal
    ?? disposition.resolution
    ?? disposition.rationale;
}

function validateSafeCurrentSpecIterationId(iterationId, label) {
  if (typeof iterationId !== 'string' || !iterationId.trim()) {
    throw new ValidationError(`${label} must have a non-empty active_iteration`);
  }
  if (
    iterationId.includes('/')
    || iterationId.includes('\\')
    || iterationId === '.'
    || iterationId === '..'
    || !/^[A-Za-z0-9._-]+$/.test(iterationId)
  ) {
    throw new ValidationError(
      `${label}.active_iteration must be a safe single path segment, got ${JSON.stringify(iterationId)}`,
    );
  }
}

function validateComposedBaselineSourceReadiness(
  baselineSpec,
  source,
  sourceSpecPath,
  metadata,
  artifactRoot,
  label,
  options = {},
) {
  const iterationRoot = path.join(
    artifactRoot,
    'iterations',
    source.iteration_id,
  );
  const taskGraphPath = path.join(
    iterationRoot,
    'gate-c-task-graph',
    'task-graph.json',
  );
  assertFile(taskGraphPath, `${label} task graph`);
  assertFileInsideArtifactRoot(taskGraphPath, artifactRoot, `${label} task graph`);

  const taskGraph = validateTaskGraph(taskGraphPath, sourceSpecPath, {
    ...options,
    artifactRoot,
  });
  if (taskGraph.projectId !== baselineSpec.project_id) {
    throw new ValidationError(`${label} task graph project must match the composed current spec`);
  }
  const taskGraphSpecPath = resolveExistingFileReference(
    taskGraph.sourceSpec,
    path.dirname(taskGraphPath),
  );
  if (!taskGraphSpecPath) {
    throw new ValidationError(`${label} task graph sourceSpec cannot be resolved`);
  }
  assertFileInsideArtifactRoot(
    taskGraphSpecPath,
    artifactRoot,
    `${label} task graph sourceSpec`,
  );
  if (realpathSync(taskGraphSpecPath) !== realpathSync(sourceSpecPath)) {
    throw new ValidationError(`${label} task graph must reference its source spec`);
  }
  const incompleteTasks = taskGraph.tasks.filter((task) => task.status !== 'done');
  if (incompleteTasks.length) {
    throw new ValidationError(
      `${label} must be close-ready; incomplete tasks: ${incompleteTasks.map((task) => `${task.id}:${task.status}`).join(', ')}`,
    );
  }


  const expectedStatus = (
    metadata?.status === 'archived'
    || source.iteration_id !== baselineSpec.active_iteration
  )
    ? 'archived'
    : 'close-ready';
  if (source.status !== expectedStatus) {
    throw new ValidationError(
      `${label}.status must be ${expectedStatus}, got ${JSON.stringify(source.status)}`,
    );
  }
  return taskGraph;
}

function isBlockedScopeReplacementBaseline(context) {
  const replacement = context?.replacement;
  return Boolean(
    replacement
    && replacement.kind === 'blocked_scope_replan'
    && replacement.task_coverage === 'full_spec'
    && typeof replacement.replaces_iteration === 'string'
    && replacement.replaces_iteration.trim()
    && Array.isArray(replacement.blocked_task_ids)
    && replacement.blocked_task_ids.length > 0
    && typeof replacement.reason === 'string'
    && replacement.reason.trim()
    && typeof replacement.current_development_contract_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(replacement.current_development_contract_sha256)
  );
}

function canonicalReplacementSnapshotPath(root, reference, expected, label) {
  if (reference !== expected) {
    throw new ValidationError(`${label} must be ${expected}`);
  }
  const filePath = path.resolve(root, reference);
  assertFile(filePath, label);
  assertFileInsideArtifactRoot(filePath, root, label);
  return filePath;
}

function validateBlockedScopeReplacementSnapshot({
  context,
  root,
  intakePath,
  baselineSpecPath,
  baselineSpec,
}) {
  if (!intakePath || !existsSync(intakePath)) {
    throw new ValidationError(
      'blocked-scope replacement baseline requires its canonical active iteration intake path',
    );
  }
  const intakeRelative = normalizePath(path.relative(
    realpathSync(root),
    realpathSync(intakePath),
  ));
  const intakeMatch = /^iterations\/([A-Za-z0-9._-]+)\/gate-a-intake\/intake\.json$/u.exec(
    intakeRelative,
  );
  if (!intakeMatch) {
    throw new ValidationError(
      'blocked-scope replacement baseline is valid only from a canonical iteration Gate A intake',
    );
  }
  const iterationId = intakeMatch[1];
  const metadataRef = `iterations/${iterationId}/iteration.json`;
  const metadataPath = canonicalReplacementSnapshotPath(
    root,
    metadataRef,
    metadataRef,
    'blocked-scope replacement iteration metadata',
  );
  const metadata = loadJson(metadataPath);
  if (
    metadata.schema_version !== 'p2a.iteration_metadata.v1'
    || metadata.iteration_id !== iterationId
    || metadata.project_id !== baselineSpec.project_id
    || !sameJson(metadata.replacement, context.replacement)
  ) {
    throw new ValidationError(
      'blocked-scope replacement baseline must match its canonical iteration metadata lineage',
    );
  }
  if (
    metadata.baseline?.effective_spec_ref !== context.spec_ref
    || metadata.baseline?.effective_spec_sha256 !== context.spec_sha256
  ) {
    throw new ValidationError(
      'blocked-scope replacement baseline ref and hash must match iteration metadata',
    );
  }

  const currentSpecPath = path.join(root, 'current-spec.json');
  assertFile(currentSpecPath, 'blocked-scope replacement current-spec.json');
  const currentSpec = loadJson(currentSpecPath);
  if (metadata.status === 'archived') {
    const closed = (currentSpec.closed_iterations ?? []).find((item) => (
      item?.iteration_id === iterationId && item?.status === 'archived'
    ));
    if (!closed) {
      throw new ValidationError(
        'archived blocked-scope replacement must be recorded in current-spec.json.closed_iterations',
      );
    }
  } else {
    const pending = currentSpec.pending_iteration;
    if (
      currentSpec.active_iteration !== iterationId
      || pending?.iteration_id !== iterationId
      || !sameJson(pending.replacement, context.replacement)
      || pending.baseline_effective_spec_ref !== context.spec_ref
      || pending.baseline_effective_spec_sha256 !== context.spec_sha256
      || !sameJson(pending.resume_authority, metadata.resume_authority)
    ) {
      throw new ValidationError(
        'active blocked-scope replacement baseline must match current-spec.json pending lifecycle state',
      );
    }
  }

  const resumeAuthority = metadata.resume_authority;
  const replacementSource = resumeAuthority?.replacement_source;
  if (
    !replacementSource
    || context.replacement.current_development_contract_sha256
      !== resumeAuthority.current_development_contract_sha256
  ) {
    throw new ValidationError(
      'blocked-scope replacement baseline must bind its resume contract and source snapshots',
    );
  }
  const baselineRootRef = `iterations/${iterationId}/baseline`;
  const contractRef = `${baselineRootRef}/current-development-contract.json`;
  const contractPath = canonicalReplacementSnapshotPath(
    root,
    resumeAuthority.current_development_contract_ref,
    contractRef,
    'blocked-scope replacement resume contract',
  );
  if (rawFileSha256(contractPath) !== resumeAuthority.current_development_contract_sha256) {
    throw new ValidationError('blocked-scope replacement resume contract hash does not match');
  }
  const contract = validateCurrentDevelopmentContractData(loadJson(contractPath), {
    projectId: baselineSpec.project_id,
    iterationId: context.replacement.replaces_iteration,
  });

  const sourceSpecRef = `${baselineRootRef}/replacement-source-spec.json`;
  const sourceIntakeRef = `${baselineRootRef}/replacement-source-intake.json`;
  const sourceSpecPath = canonicalReplacementSnapshotPath(
    root,
    replacementSource.spec_ref,
    sourceSpecRef,
    'blocked-scope replacement source spec snapshot',
  );
  const sourceIntakePath = canonicalReplacementSnapshotPath(
    root,
    replacementSource.intake_ref,
    sourceIntakeRef,
    'blocked-scope replacement source intake snapshot',
  );
  if (
    rawFileSha256(sourceSpecPath) !== replacementSource.spec_sha256
    || rawFileSha256(sourceIntakePath) !== replacementSource.intake_sha256
    || contract.bindings.activeSpec.sha256 !== replacementSource.spec_sha256
  ) {
    throw new ValidationError(
      'blocked-scope replacement source snapshots do not match their resume contract binding',
    );
  }
  const sourceSpec = validateAgainstSchema(sourceSpecPath, 'spec');
  validateAgainstSchema(sourceIntakePath, 'intake');
  if (
    sourceSpec.approval !== 'approved'
    || sourceSpec.open_decisions.length > 0
    || (
      sourceSpec.source_intake_sha256
      && sourceSpec.source_intake_sha256 !== replacementSource.intake_sha256
    )
  ) {
    throw new ValidationError(
      'blocked-scope replacement source snapshots must preserve the approved source contract',
    );
  }

  const baselineIntakePath = requireSpecSourceIntake(baselineSpecPath, baselineSpec);
  const baselineIntakeRef = normalizePath(path.relative(root, baselineIntakePath));
  const expectedBaselineSpec = structuredClone(sourceSpec);
  expectedBaselineSpec.source_intake = path.posix.relative(
    path.posix.dirname(context.spec_ref),
    baselineIntakeRef,
  );
  expectedBaselineSpec.source_intake_sha256 = rawFileSha256(baselineIntakePath);
  expectedBaselineSpec.approval = 'draft';
  delete expectedBaselineSpec.approval_audit;
  if (!sameJson(baselineSpec, expectedBaselineSpec)) {
    throw new ValidationError(
      'blocked-scope replacement baseline must be an exact semantic snapshot of the bound approved source spec',
    );
  }
}

function validateBaselineContext(
  intake,
  artifactRoot = null,
  requireArtifactRoot = false,
  provenanceVisited = new Set(),
  intakePath = null,
  validationSession = null,
) {
  const context = intake.baseline_context;
  if (!context) return;
  const answerKeys = context.reused_answers.map((item) => `${item.source_intake}#${item.id}`);
  if (answerKeys.length !== new Set(answerKeys).size) {
    throw new ValidationError('intake.baseline_context reused answer source/id pairs must be unique');
  }
  const dispositionKeys = context.reused_question_dispositions
    .map((item) => `${item.source_spec}#${item.id}`);
  if (dispositionKeys.length !== new Set(dispositionKeys).size) {
    throw new ValidationError('intake.baseline_context reused disposition source/id pairs must be unique');
  }
  if (!artifactRoot) {
    if (requireArtifactRoot) {
      throw new ValidationError(
        'validating intake.baseline_context provenance requires --artifact-root',
      );
    }
    return;
  }

  const root = path.resolve(artifactRoot);
  const intakeRealPath = intakePath && existsSync(intakePath)
    ? realpathSync(intakePath)
    : null;
  let activeVisitKey = null;
  let completedVisitKey = null;
  if (intakeRealPath) {
    activeVisitKey = `active:intake:${intakeRealPath}`;
    completedVisitKey = `completed:intake:${intakeRealPath}`;
    if (provenanceVisited.has(completedVisitKey)) return;
    if (provenanceVisited.has(activeVisitKey)) {
      throw new ValidationError(
        `intake.baseline_context provenance contains a cycle through ${intakeRealPath}`,
      );
    }
    provenanceVisited.add(activeVisitKey);
  }
  const references = [
    ['baseline_context.spec_ref', context.spec_ref],
    ...context.reused_answers.map((item, index) => [
      `baseline_context.reused_answers[${index}].source_intake`,
      item.source_intake,
    ]),
    ...context.reused_question_dispositions.map((item, index) => [
      `baseline_context.reused_question_dispositions[${index}].source_spec`,
      item.source_spec,
    ]),
  ];
  const resolvedReferences = new Map();
  for (const [label, reference] of references) {
    if (path.isAbsolute(reference)) {
      throw new ValidationError(`${label} must be an artifact-root-relative path`);
    }
    const resolved = path.resolve(root, reference);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ValidationError(`${label} escapes the artifact root: ${JSON.stringify(reference)}`);
    }
    if (!existsSync(resolved)) {
      throw new ValidationError(`${label} is missing: ${resolved}`);
    }
    if (!lstatSync(resolved).isFile()) {
      throw new ValidationError(`${label} is not a file: ${resolved}`);
    }
    const realRelative = path.relative(realpathSync(root), realpathSync(resolved));
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new ValidationError(`${label} resolves outside the artifact root: ${JSON.stringify(reference)}`);
    }
    resolvedReferences.set(label, resolved);
  }

  const baselineSpecPath = resolvedReferences.get('baseline_context.spec_ref');
  if (
    isComposedBaselineReference(context.spec_ref)
    && context.spec_ref !== 'current-spec.json'
    && !context.spec_sha256
  ) {
    throw new ValidationError(
      'baseline_context.spec_sha256 is required for an immutable composed baseline snapshot',
    );
  }
  if (
    context.spec_sha256
    && rawFileSha256(baselineSpecPath) !== context.spec_sha256
  ) {
    throw new ValidationError(
      `baseline_context.spec_sha256 does not match ${context.spec_ref}`,
    );
  }
  const baselineSpec = loadJson(baselineSpecPath);
  const nestedOptions = {
    artifactRoot: root,
    requireBaselineContextArtifactRoot: true,
    provenanceVisited,
    validationSession,
  };
  const rootRealPath = realpathSync(root);
  const allowedBaselineSpecPaths = new Set();
  const allowedBaselineIntakePaths = new Set();
  function registerBaselineSpec(specPath, spec, label) {
    allowedBaselineSpecPaths.add(realpathSync(specPath));
    const sourceIntakePath = requireSpecSourceIntake(specPath, spec);
    if (!sourceIntakePath) return;
    const sourceIntakeRealPath = realpathSync(sourceIntakePath);
    const sourceIntakeRelative = path.relative(rootRealPath, sourceIntakeRealPath);
    if (
      !sourceIntakeRelative
      || sourceIntakeRelative.startsWith('..')
      || path.isAbsolute(sourceIntakeRelative)
    ) {
      throw new ValidationError(
        `${label}.source_intake resolves outside the artifact root: ${JSON.stringify(spec.source_intake)}`,
      );
    }
    allowedBaselineIntakePaths.add(sourceIntakeRealPath);
  }
  if (baselineSpec.schema_version === 'p2a.spec.v1') {
    const validatedBaselineSpec = validateSpec(baselineSpecPath, null, nestedOptions);
    const approvedBaseline = validatedBaselineSpec.approval === 'approved';
    const replacementSnapshot = (
      validatedBaselineSpec.approval === 'draft'
      && isBlockedScopeReplacementBaseline(context)
    );
    if (replacementSnapshot) {
      validateBlockedScopeReplacementSnapshot({
        context,
        root,
        intakePath,
        baselineSpecPath,
        baselineSpec: validatedBaselineSpec,
      });
    }
    if (
      (!approvedBaseline && !replacementSnapshot)
      || validatedBaselineSpec.open_decisions.length > 0
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref must reference an approved spec, or an immutable blocked-scope replacement snapshot, with no open_decisions',
      );
    }
    registerBaselineSpec(
      baselineSpecPath,
      validatedBaselineSpec,
      'baseline_context.spec_ref',
    );
  } else if (
    baselineSpec.schema_version !== 'p2a.current_spec.v1'
    || !baselineSpec.effective_product
    || typeof baselineSpec.effective_product !== 'object'
    || Array.isArray(baselineSpec.effective_product)
    || !baselineSpec.effective_implementation
    || typeof baselineSpec.effective_implementation !== 'object'
    || Array.isArray(baselineSpec.effective_implementation)
  ) {
    throw new ValidationError(
      'baseline_context.spec_ref must reference a p2a.spec.v1 artifact or a composed p2a.current_spec.v1 artifact',
    );
  } else {
    validateSafeCurrentSpecIterationId(
      baselineSpec.active_iteration,
      'baseline_context.spec_ref composed current spec',
    );
    if (!Array.isArray(baselineSpec.source_specs) || baselineSpec.source_specs.length === 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty source_specs array',
      );
    }
    if (!Array.isArray(baselineSpec.composed_from) || baselineSpec.composed_from.length === 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty composed_from array',
      );
    }
    if (baselineSpec.effective_spec_ref !== 'current-spec.json') {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must use effective_spec_ref current-spec.json',
      );
    }
    if (typeof baselineSpec.project_id !== 'string' || !baselineSpec.project_id.trim()) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must have a non-empty project_id',
      );
    }
    const sourceIterationIds = baselineSpec.source_specs.map((source) => source?.iteration_id);
    if (
      sourceIterationIds.some((iterationId) => (
        typeof iterationId !== 'string' || !iterationId.trim()
      ))
      || sourceIterationIds.length !== new Set(sourceIterationIds).size
      || !sameJson(sourceIterationIds, baselineSpec.composed_from)
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref composed_from must exactly match unique source_specs iteration_id values in order',
      );
    }
    const openDecisions = baselineSpec.open_decisions ?? [];
    if (!Array.isArray(openDecisions) || openDecisions.length > 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec must not have unresolved open_decisions',
      );
    }
    const validatedSources = [];
    const sourceRealPaths = new Set();
    for (const [index, source] of baselineSpec.source_specs.entries()) {
      validateSafeCurrentSpecIterationId(
        source?.iteration_id,
        `baseline_context.spec_ref source_specs[${index}]`,
      );
      const sourceRef = source?.spec_ref;
      if (typeof sourceRef !== 'string' || !sourceRef.trim()) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref must be a non-empty string`,
        );
      }
      if (path.isAbsolute(sourceRef)) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref must be artifact-root-relative`,
        );
      }
      const sourcePath = path.resolve(root, sourceRef);
      const sourceRelative = path.relative(root, sourcePath);
      if (
        !sourceRelative
        || sourceRelative.startsWith('..')
        || path.isAbsolute(sourceRelative)
        || !existsSync(sourcePath)
        || !lstatSync(sourcePath).isFile()
      ) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref is missing or escapes the artifact root: ${JSON.stringify(sourceRef)}`,
        );
      }
      const sourceRealPath = realpathSync(sourcePath);
      const sourceRealRelative = path.relative(realpathSync(root), sourceRealPath);
      if (
        !sourceRealRelative
        || sourceRealRelative.startsWith('..')
        || path.isAbsolute(sourceRealRelative)
      ) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].spec_ref resolves outside the artifact root: ${JSON.stringify(sourceRef)}`,
        );
      }
      const canonicalSourceRef =
        `iterations/${source.iteration_id}/gate-b-spec/spec.json`;
      if (normalizeReference(sourceRef) !== canonicalSourceRef) {
        throw new ValidationError(
          `baseline_context.spec_ref composed current spec source ${source.iteration_id} spec_ref must be ${canonicalSourceRef}`,
        );
      }
      if (sourceRealPaths.has(sourceRealPath)) {
        throw new ValidationError(
          'baseline_context.spec_ref source_specs must reference unique spec files',
        );
      }
      sourceRealPaths.add(sourceRealPath);
      const sourceSpec = validateSpec(sourcePath, null, nestedOptions);
      if (sourceSpec.project_id !== baselineSpec.project_id) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}] project_id must match the composed current spec`,
        );
      }
      if (sourceSpec.approval !== 'approved') {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}] must reference an approved spec`,
        );
      }
      if (source.approval !== undefined && source.approval !== sourceSpec.approval) {
        throw new ValidationError(
          `baseline_context.spec_ref source_specs[${index}].approval must match its source spec`,
        );
      }
      registerBaselineSpec(
        sourcePath,
        sourceSpec,
        `baseline_context.spec_ref source_specs[${index}]`,
      );
      const metadataPath = path.join(
        root,
        'iterations',
        source.iteration_id,
        'iteration.json',
      );
      let metadata = null;
      if (existsSync(metadataPath)) {
        metadata = loadJson(metadataPath);
        if (
          metadata.iteration_id !== source.iteration_id
          || metadata.project_id !== baselineSpec.project_id
        ) {
          throw new ValidationError(
            `baseline_context.spec_ref source_specs[${index}] iteration metadata must match its source iteration and project`,
          );
        }
      }
      const taskGraph = validateComposedBaselineSourceReadiness(
        baselineSpec,
        source,
        sourcePath,
        metadata,
        root,
        `baseline_context.spec_ref source_specs[${index}]`,
        nestedOptions,
      );
      const sourceIntakePath = requireSpecSourceIntake(sourcePath, sourceSpec);
      const sourceIntake = sourceIntakePath ? loadJson(sourceIntakePath) : null;
      validatedSources.push({
        ...source,
        spec: sourceSpec,
        task_graph: taskGraph,
        metadata,
        source_intake: sourceIntake,
      });
    }
    const sourceContractError = compositionSourceContractError(validatedSources);
    if (sourceContractError) {
      throw new ValidationError(
        `baseline_context.spec_ref composed current spec ${sourceContractError}`,
      );
    }
    const replayedComposition = composeCanonicalSpecSources(validatedSources);
    if (replayedComposition.compositionConflicts.length > 0) {
      throw new ValidationError(
        'baseline_context.spec_ref composed current spec has unresolved stale-baseline composition conflicts',
      );
    }
    if (
      !sameJson(baselineSpec.effective_product, replayedComposition.effectiveProduct)
      || !sameJson(
        baselineSpec.effective_implementation,
        replayedComposition.effectiveImplementation,
      )
    ) {
      throw new ValidationError(
        'baseline_context.spec_ref effective sections must exactly match ordered source composition',
      );
    }
    const replayContractError = compositionReplayContractError(
      baselineSpec,
      replayedComposition,
    );
    if (replayContractError) {
      throw new ValidationError(
        `baseline_context.spec_ref composed current spec ${replayContractError}`,
      );
    }
  }

  const sourceIntakes = new Map();
  for (const [index, item] of context.reused_answers.entries()) {
    const label = `baseline_context.reused_answers[${index}].source_intake`;
    const sourcePath = resolvedReferences.get(label);
    const sourceRealPath = realpathSync(sourcePath);
    if (!allowedBaselineIntakePaths.has(sourceRealPath)) {
      throw new ValidationError(
        `${label} does not belong to the baseline spec source closure`,
      );
    }
    let sourceIntake = sourceIntakes.get(sourceRealPath);
    if (!sourceIntake) {
      sourceIntake = validateIntake(sourcePath, nestedOptions);
      sourceIntakes.set(sourceRealPath, sourceIntake);
    }
    const sourceDecision = sourceIntake.needs_user_decision
      .find((decision) => decision.id === item.id);
    const sourceResolution = isSupersedingDecision(sourceDecision)
      ? supersedingDecisionResolution(sourceDecision)
      : sourceDecision?.answer;
    if (
      !sourceDecision
      || sourceDecision.status !== 'answered'
      || sourceDecision.question !== item.question
      || sourceResolution !== item.answer
      || (
        item.disposition !== undefined
        && item.disposition !== sourceDecision.disposition
      )
      || (
        item.current_resolution !== undefined
        && item.current_resolution !== sourceDecision.current_resolution
      )
      || (
        item.affected_fields !== undefined
        && !sameJson(item.affected_fields, decisionAffectedSpecRefs(sourceDecision))
      )
      || (
        item.supersedes !== undefined
        && !sameJson(item.supersedes, sourceDecision.supersedes)
      )
    ) {
      throw new ValidationError(
        `${label} does not contain matching answered decision ${item.id}`,
      );
    }
  }

  const sourceSpecs = new Map();
  for (const [index, item] of context.reused_question_dispositions.entries()) {
    const label = `baseline_context.reused_question_dispositions[${index}].source_spec`;
    const sourcePath = resolvedReferences.get(label);
    const sourceRealPath = realpathSync(sourcePath);
    if (!allowedBaselineSpecPaths.has(sourceRealPath)) {
      throw new ValidationError(
        `${label} does not belong to the baseline spec source closure`,
      );
    }
    let sourceSpec = sourceSpecs.get(sourceRealPath);
    if (!sourceSpec) {
      sourceSpec = validateSpec(sourcePath, null, nestedOptions);
      sourceSpecs.set(sourceRealPath, sourceSpec);
    }
    const sourceDisposition = sourceSpec.clarifying_question_disposition
      .find((disposition) => disposition.id === item.id);
    if (
      !sourceDisposition
      || sourceDisposition.status !== item.status
      || baselineDispositionResolution(sourceDisposition) !== item.resolution
      || !sameJson(sourceDisposition.affects, item.affects)
    ) {
      throw new ValidationError(
        `${label} does not contain matching disposition ${item.id}`,
      );
    }
  }
  if (activeVisitKey) provenanceVisited.delete(activeVisitKey);
  if (completedVisitKey) provenanceVisited.add(completedVisitKey);
}

export function validateIntake(filePath, options = {}) {
  const cacheKey = validationSessionKey('intake', filePath, options);
  const cached = cachedValidation(options, cacheKey);
  if (cached) return cached.value;
  recordValidationRun(options, 'intake');
  const data = validateAgainstSchema(filePath, 'intake', options);
  validateEvidence(data.evidence, 'intake');
  validateReferenceBundleSnapshot(filePath, data, options);

  const clarifyingQuestionIds = data.clarifying_questions.map((question) => question.id);
  if (clarifyingQuestionIds.length !== new Set(clarifyingQuestionIds).size) {
    throw new ValidationError('intake.clarifying_questions id values must be unique');
  }
  for (const question of data.clarifying_questions) validateIntakeQuestion(question);

  const decisionIds = data.needs_user_decision.map((decision) => decision.id);
  if (decisionIds.length !== new Set(decisionIds).size) {
    throw new ValidationError('intake.needs_user_decision id values must be unique');
  }
  const unresolvedDecisions = [];
  const supersedingDecisionIds = [];
  for (const decision of data.needs_user_decision) {
    const optionIds = decision.options.map((option) => option.id);
    if (optionIds.length !== new Set(optionIds).size) {
      throw new ValidationError(`${decision.id} option id values must be unique`);
    }
    if (!optionIds.includes(decision.default)) {
      throw new ValidationError(`${decision.id} default must match one of its option ids`);
    }
    if (decision.status === 'open' || decision.status === 'deferred') {
      unresolvedDecisions.push(decision.id);
    }
    const hasAnswer = Object.hasOwn(decision, 'answer');
    const hasNonBlankAnswer = (
      typeof decision.answer === 'string'
      && decision.answer.trim().length > 0
    );
    const hasSupersessionPrefix = (
      typeof decision.disposition === 'string'
      && decision.disposition.startsWith('superseded_by_')
    );
    if (hasSupersessionPrefix && !isSupersedingDecision(decision)) {
      throw new ValidationError(
        `${decision.id}.disposition must match superseded_by_<scope-id>`,
      );
    }
    if (Array.isArray(decision.supersedes) && !isSupersedingDecision(decision)) {
      throw new ValidationError(
        `${decision.id}.supersedes is only allowed with a superseded_by_<scope-id> disposition`,
      );
    }
    if (isSupersedingDecision(decision)) {
      supersedingDecisionIds.push(decision.id);
      if (decision.status !== 'answered') {
        throw new ValidationError(
          `${decision.id} baseline supersession must have status answered`,
        );
      }
      if (
        typeof decision.current_resolution !== 'string'
        || !decision.current_resolution.trim()
      ) {
        throw new ValidationError(
          `${decision.id} baseline supersession requires a non-blank current_resolution`,
        );
      }
      const declaredRefs = Array.isArray(decision.affected_fields) && decision.affected_fields.length
        ? decision.affected_fields
        : decision.blocks;
      const validRefs = decisionAffectedSpecRefs(decision);
      if (
        Array.isArray(declaredRefs)
        && declaredRefs.some((reference) => !validRefs.includes(reference))
      ) {
        throw new ValidationError(
          `${decision.id} baseline supersession affected_fields/blocks must contain only spec.product.* or spec.implementation.* references`,
        );
      }
      const targetKeys = (decision.supersedes ?? [])
        .map((target) => `${target.field_ref}\n${target.baseline_value}`);
      if (targetKeys.length !== new Set(targetKeys).size) {
        throw new ValidationError(
          `${decision.id}.supersedes field_ref/baseline_value targets must be unique`,
        );
      }
      const targetOutsideAffectedFields = (decision.supersedes ?? [])
        .filter((target) => validRefs.length > 0 && !validRefs.includes(target.field_ref));
      if (targetOutsideAffectedFields.length) {
        throw new ValidationError(
          `${decision.id}.supersedes targets must belong to affected_fields/blocks: ${JSON.stringify(targetOutsideAffectedFields.map((target) => target.field_ref))}`,
        );
      }
    }
    if (
      decision.status === 'answered'
      && !hasNonBlankAnswer
      && !supersedingDecisionResolution(decision)
    ) {
      throw new ValidationError(`${decision.id} is answered but has no non-blank answer`);
    }
    if (
      (decision.status === 'open' || decision.status === 'deferred')
      && (hasAnswer || Object.hasOwn(decision, 'current_resolution'))
    ) {
      throw new ValidationError(`${decision.id} is unresolved but has an answer or current_resolution`);
    }
  }

  if (supersedingDecisionIds.length && !data.baseline_context) {
    throw new ValidationError(
      `baseline supersession decisions require intake.baseline_context: ${JSON.stringify(supersedingDecisionIds)}`,
    );
  }

  validateBaselineContext(
    data,
    options.artifactRoot,
    options.requireBaselineContextArtifactRoot === true,
    options.provenanceVisited ?? new Set(),
    filePath,
    options.validationSession ?? null,
  );
  const openQuestionIds = data.clarifying_questions
    .filter((question) => question.status === 'open')
    .map((question) => question.id);
  if (data.approval_audit) {
    validateApprovalAuditData(data.approval_audit, 'intake.approval_audit');
  }
  if (data.status === 'ready_for_spec') {
    const unresolved = [...openQuestionIds, ...unresolvedDecisions];
    if (unresolved.length) {
      throw new ValidationError(
        `ready_for_spec intake contains unresolved items: ${JSON.stringify(unresolved)}`,
      );
    }
    if (!data.approval_audit) {
      throw new ValidationError('ready_for_spec intake requires approval_audit');
    }
    if (!data.approval_audit.approved_artifacts.some((item) => item.endsWith('gate-a-intake/intake.json'))) {
      throw new ValidationError('intake.approval_audit.approved_artifacts must include gate-a-intake/intake.json');
    }
  } else if (data.approval_audit) {
    throw new ValidationError(
      'blocked_on_user intake must not include approval_audit',
    );
  }
  if (options.intakeMdPath) validateIntakeMarkdownDecisionSync(data, options.intakeMdPath);
  return cacheValidation(options, cacheKey, data);
}

export function validateIntakeMarkdownDecisionSync(intake, intakeMdPath) {
  const text = readFileSync(intakeMdPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const decision of intake.needs_user_decision) {
    if (decision.status !== 'answered') continue;
    const idPattern = new RegExp(String.raw`(^|\n)([^\n]*\b${escapeRegExp(decision.id)}\b[^\n]*)([\s\S]*?)(?=\n[^\n]*\b(?:ND|CQ|A)-\d+\b|\n#{1,6}\s+|$)`, 'i');
    const match = text.match(idPattern);
    if (!match) continue;
    const block = `${match[2]}${match[3]}`;
    const clearlyOpen = /(?:status|상태)\s*[:：-]\s*(?:`?open`?|미해결|열림)\b/i.test(block);
    const clearlyAnswered = /(?:status|상태)\s*[:：-]\s*(?:`?answered`?|답변|완료)\b/i.test(block);
    if (clearlyOpen && !clearlyAnswered) {
      throw new ValidationError(`${decision.id} is answered in intake.json but intake.md still marks it open`);
    }
  }
  return text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateSpec(filePath, intakePath = null, options = {}) {
  const referenceData = validateAgainstSchema(filePath, 'spec', options);
  const referencedIntakePath = requireSpecSourceIntake(filePath, referenceData);
  const providedIntakePath = intakePath ? path.resolve(intakePath) : null;
  if (providedIntakePath) {
    assertFile(providedIntakePath, 'provided intake');
    if (!referencedIntakePath) {
      throw new ValidationError(
        `spec.source_intake cannot be resolved to the provided intake: ${JSON.stringify(referenceData.source_intake)}`,
      );
    }
    if (realpathSync(referencedIntakePath) !== realpathSync(providedIntakePath)) {
      throw new ValidationError(
        `provided intake does not match spec.source_intake ${JSON.stringify(referenceData.source_intake)}`,
      );
    }
  }
  const resolvedIntakePath = providedIntakePath ?? referencedIntakePath;
  const artifactRoot = options.artifactRoot
    ?? (resolvedIntakePath ? inferArtifactRootFromIntakePath(resolvedIntakePath) : null);
  const cacheOptions = {
    ...options,
    ...(artifactRoot ? { artifactRoot } : {}),
    projectId: options.projectId ?? referenceData.project_id,
  };
  const intakeCacheRef = resolvedIntakePath
    ? validationFileIdentity(resolvedIntakePath, cacheOptions)
    : '';
  const cacheKey = validationSessionKey('spec', filePath, cacheOptions, intakeCacheRef);
  const cached = cachedValidation(cacheOptions, cacheKey);
  if (cached) return cached.value;
  recordValidationRun(cacheOptions, 'spec');
  const data = referenceData;
  const constitutionContract = resolveConstitutionForArtifact(filePath, {
    ...cacheOptions,
  });
  if (resolvedIntakePath && artifactRoot) {
    assertFileInsideArtifactRoot(
      resolvedIntakePath,
      artifactRoot,
      'spec.source_intake',
    );
  }
  const intakeValidationOptions = cacheOptions;
  const intake = resolvedIntakePath
    ? validateIntake(resolvedIntakePath, intakeValidationOptions)
    : null;
  if (
    data.source_intake_sha256
    && rawFileSha256(resolvedIntakePath) !== data.source_intake_sha256
  ) {
    throw new ValidationError(
      `spec.source_intake_sha256 does not match ${resolvedIntakePath}`,
    );
  }
  validateEvidence(data.evidence, 'spec');
  validateReferenceBundleUsage(
    filePath,
    data,
    resolvedIntakePath,
    intake,
    artifactRoot,
  );
  validateTechnologyReconnaissanceEvidence(data);
  validateReferenceReconnaissance(data);
  validateClarifyingQuestionDisposition(data, intake);
  if (intake?.baseline_context && artifactRoot) {
    const supersedingDecisions = intake.needs_user_decision.filter(isSupersedingDecision);
    if (supersedingDecisions.length) {
      const baselineSpecPath = path.resolve(artifactRoot, intake.baseline_context.spec_ref);
      const violations = baselineSupersessionViolations(
        loadJson(baselineSpecPath),
        intake,
        data,
      );
      if (violations.length) {
        const violation = violations[0];
        if (violation.kind === 'unresolved') {
          const detail = violation.invalidTargets?.length
            ? `invalid exact targets ${JSON.stringify(violation.invalidTargets)}`
            : `no restrictive baseline item matched capabilities ${JSON.stringify(violation.capabilities)}`;
          throw new ValidationError(
            `spec baseline supersession ${violation.decisionId} (${violation.disposition}) cannot be applied to ${intake.baseline_context.spec_ref}: `
            + detail,
          );
        }
        throw new ValidationError(
          `spec baseline supersession ${violation.decisionId} is not applied: ${violation.fieldRef} still retains `
          + `${JSON.stringify(violation.baselineText)} from ${intake.baseline_context.spec_ref}`,
        );
      }
    }
  }
  const semanticContradictions = findSpecCapabilityContradictions(data);
  if (semanticContradictions.length) {
    const contradiction = semanticContradictions[0];
    throw new ValidationError(
      `spec semantic contradiction for capability ${JSON.stringify(contradiction.capability)}: `
      + `${contradiction.positive.fieldRef}[${contradiction.positive.index}] includes it while `
      + `${contradiction.restrictive.fieldRef}[${contradiction.restrictive.index}] restricts it`,
    );
  }
  if (data.approval === 'approved' && data.open_decisions.length) {
    throw new ValidationError('approved specs must not contain open_decisions');
  }
  validateSpecApprovalAudit(data);
  validateSpecVisualExperience(data, filePath, artifactRoot);
  if (constitutionContract.constitution) {
    validateConstitutionProhibitions(
      constitutionContract.constitution,
      data,
      'spec',
      'spec',
    );
  }

  if (intake) {
    const intakeDecisions = new Map(intake.needs_user_decision.map((decision) => [decision.id, decision.status]));
    const promotedDecisions = new Set(
      data.clarifying_question_disposition
        .filter((item) => item.status === 'promoted_to_decision')
        .map((item) => item.promoted_decision_id),
    );
    const promotedDecisionIds = [...promotedDecisions];
    const collidingPromotedDecisions = promotedDecisionIds.filter((decisionId) => intakeDecisions.has(decisionId));
    if (collidingPromotedDecisions.length) {
      throw new ValidationError(`spec.clarifying_question_disposition promoted_decision_id must not reuse intake decision ids: ${JSON.stringify(collidingPromotedDecisions)}`);
    }
    const unknownDecisions = data.open_decisions.filter((decisionId) => !intakeDecisions.has(decisionId) && !promotedDecisions.has(decisionId));
    if (unknownDecisions.length) {
      throw new ValidationError(`spec.open_decisions references unknown decisions: ${JSON.stringify(unknownDecisions)}`);
    }
    const unresolvedDecisions = new Set(
      [...intakeDecisions.entries()]
        .filter(([, status]) => status === 'open' || status === 'deferred')
        .map(([decisionId]) => decisionId),
    );
    for (const item of data.clarifying_question_disposition) {
      if (item.status === 'promoted_to_decision' && !item.resolution) {
        unresolvedDecisions.add(item.promoted_decision_id);
      }
    }
    const specOpenDecisions = new Set(data.open_decisions);
    const expected = [...unresolvedDecisions].sort();
    const got = [...specOpenDecisions].sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      throw new ValidationError(
        `spec.open_decisions must exactly match unresolved decisions: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
    }
  }
  return cacheValidation(cacheOptions, cacheKey, data);
}

export function validateApprovalAuditData(audit, label = 'approval audit') {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const requiredStrings = ['approved_by', 'approved_at', 'approval_note'];
  for (const field of requiredStrings) {
    if (typeof audit[field] !== 'string' || audit[field].trim().length === 0) {
      throw new ValidationError(`${label}.${field} must be a non-empty string`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(audit.approved_at)) {
    throw new ValidationError(`${label}.approved_at must start with YYYY-MM-DD`);
  }
  if (!Array.isArray(audit.approved_artifacts) || audit.approved_artifacts.length === 0) {
    throw new ValidationError(`${label}.approved_artifacts must be a non-empty array`);
  }
  validateNonBlankStrings(audit.approved_artifacts, `${label}.approved_artifacts`);
  return audit;
}

function approvalNoteContainsQuote(note) {
  return (
    /"[^"\r\n]+"/.test(note)
    || /'[^'\r\n]+'/.test(note)
    || /“[^”\r\n]+”/.test(note)
    || /‘[^’\r\n]+’/.test(note)
  );
}

function assertUniqueConstitutionIds(items, label) {
  const ids = items.map((item) => item.id);
  if (ids.length !== new Set(ids).size) {
    throw new ValidationError(`constitution.${label} id values must be unique`);
  }
}

function validateConstitutionApprovalAudit(constitution) {
  const audit = constitution.approval_audit;
  if (!audit) return null;
  validateApprovalAuditData(audit, 'constitution.approval_audit');
  if (audit.approved_by !== 'user') {
    throw new ValidationError('constitution.approval_audit.approved_by must be user');
  }
  if (!audit.approved_artifacts.some((item) => normalizeReference(item) === '.plan2agent/constitution.json')) {
    throw new ValidationError(
      'constitution.approval_audit.approved_artifacts must include .plan2agent/constitution.json',
    );
  }
  if (!approvalNoteContainsQuote(audit.approval_note)) {
    throw new ValidationError(
      'constitution.approval_audit.approval_note must contain the verbatim user approval in quotation marks',
    );
  }
  return audit;
}

function validateValidatorProhibitionContract(prohibition) {
  const enforcement = prohibition.enforcement ?? 'advisory';
  if (enforcement !== 'validator') return;
  validateNonBlankStrings(prohibition.targets ?? [], `${prohibition.id}.targets`);
  validateNonBlankStrings(prohibition.forbidden_terms ?? [], `${prohibition.id}.forbidden_terms`);
  for (const term of prohibition.forbidden_terms) {
    if (!term.trim()) {
      throw new ValidationError(`${prohibition.id}.forbidden_terms must not contain blank values`);
    }
  }
}

export function validateConstitutionData(data, options = {}) {
  validateSchema(data, loadJson(SCHEMA_PATHS.constitution));
  assertUniqueConstitutionIds(data.architecture, 'architecture');
  assertUniqueConstitutionIds(data.stack, 'stack');
  assertUniqueConstitutionIds(data.prohibitions, 'prohibitions');
  for (const prohibition of data.prohibitions) validateValidatorProhibitionContract(prohibition);
  const audit = validateConstitutionApprovalAudit(data);
  if (options.requireApproved && !audit) {
    throw new ValidationError('constitution requires explicit Gate ② approval_audit');
  }
  if (options.projectId && data.projectId !== options.projectId) {
    throw new ValidationError(
      `constitution.projectId must match ${JSON.stringify(options.projectId)}, got ${JSON.stringify(data.projectId)}`,
    );
  }
  return data;
}

export function validateConstitution(filePath, options = {}) {
  return validateConstitutionData(loadJson(filePath), options);
}

export function currentDevelopmentContractSha256(contract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function validateCurrentDevelopmentContractData(data, options = {}) {
  validateSchema(data, loadJson(SCHEMA_PATHS.current_development_contract));
  const taskIds = data.bindings.taskGraph.tasks.map((task) => task.taskId);
  if (taskIds.length !== new Set(taskIds).size) {
    throw new ValidationError('current development contract task bindings must use unique taskId values');
  }
  const technologyEvidenceIds = (data.technologyEvidence ?? []).map((item) => item.source_id);
  if (technologyEvidenceIds.length !== new Set(technologyEvidenceIds).size) {
    throw new ValidationError('current development contract technologyEvidence must use unique source_id values');
  }
  for (const field of ['scope', 'mustPreserve', 'nonGoals', 'acceptance', 'verification']) {
    validateNonBlankStrings(data[field], `current development contract ${field}`);
  }
  if (data.iterationConstraints) {
    for (const field of ['architecture', 'interfaces', 'dependencies']) {
      validateNonBlankStrings(
        data.iterationConstraints[field],
        `current development contract iterationConstraints.${field}`,
      );
    }
  }
  validateConstitutionData({
    schema_version: 'p2a.constitution.v1',
    projectId: data.projectId,
    architecture: data.architecture,
    stack: data.stack,
    prohibitions: data.prohibitions,
    style: data.style,
  });
  if (options.projectId && data.projectId !== options.projectId) {
    throw new ValidationError(
      `current development contract projectId must match ${JSON.stringify(options.projectId)}, got ${JSON.stringify(data.projectId)}`,
    );
  }
  if (options.iterationId && data.iterationId !== options.iterationId) {
    throw new ValidationError(
      `current development contract iterationId must match ${JSON.stringify(options.iterationId)}, got ${JSON.stringify(data.iterationId)}`,
    );
  }
  return data;
}

export function validateCurrentDevelopmentContract(filePath, options = {}) {
  const key = validationSessionKey('current-development-contract', filePath, options);
  const cached = cachedValidation(options, key);
  if (cached) return cached.value;
  recordValidationRun(options, 'current-development-contract');
  return cacheValidation(
    options,
    key,
    validateCurrentDevelopmentContractData(loadValidationJson(filePath, options), options),
  );
}

export function executionEnvelopeFromCurrentDevelopmentContract(contract, sourceRef, options = {}) {
  validateCurrentDevelopmentContractData(contract);
  const iterationConstraints = contract.iterationConstraints ?? options.iterationConstraints ?? null;
  const envelope = {
    objective: contract.objective,
    sourceGateRefs: [{
      path: sourceRef,
      sha256: currentDevelopmentContractSha256(contract),
    }],
    scope: structuredClone(contract.scope),
    ...(iterationConstraints ? {
      iterationConstraints: structuredClone(iterationConstraints),
    } : {}),
    architecture: structuredClone(contract.architecture),
    stack: structuredClone(contract.stack),
    prohibitions: structuredClone(contract.prohibitions),
    style: structuredClone(contract.style),
    mustPreserve: structuredClone(contract.mustPreserve),
    nonGoals: structuredClone(contract.nonGoals),
    acceptance: structuredClone(contract.acceptance),
    verification: structuredClone(contract.verification),
    executionAuthority: {
      mayChoose: structuredClone(contract.authority.mayChoose),
      mustReturnToGate: structuredClone(contract.authority.mustReturnToGate),
    },
    ...(contract.visualContract ? {
      visualContract: structuredClone(contract.visualContract),
    } : {}),
  };
  return validateExecutionEnvelopeData(envelope);
}

export function decisionRecordSha256(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export function validateDecisionData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.decisions));
  if (!Number.isInteger(data.seq) || data.seq < 1) {
    throw new ValidationError('decision.seq must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(data.at))) {
    throw new ValidationError(`decision.at must be an ISO-compatible timestamp, got ${JSON.stringify(data.at)}`);
  }
  if (typeof data.quote !== 'string' || !data.quote.trim()) {
    throw new ValidationError('decision.quote must preserve a non-empty user utterance');
  }
  if (data.scope_ref !== undefined) {
    const normalized = normalizeReference(data.scope_ref);
    const segments = normalized.split('/');
    if (
      path.isAbsolute(data.scope_ref)
      || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new ValidationError(
        `decision.scope_ref must be a safe artifact-relative path, got ${JSON.stringify(data.scope_ref)}`,
      );
    }
  }
  return data;
}

function decisionScopeIdentity(reference) {
  return normalizeReference(reference).replace(/^iterations\/[^/]+\//, '');
}

export function validateDecisionLedger(filePath) {
  assertFile(filePath, 'decisions.jsonl');
  const text = readFileSync(filePath, 'utf8');
  if (!text.trim()) throw new ValidationError('decisions.jsonl must contain at least one decision');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records = [];
  let previousSha256 = null;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (!lines[index].trim()) {
      throw new ValidationError(`decisions.jsonl line ${lineNumber} must not be blank`);
    }
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch (error) {
      throw new ValidationError(`decisions.jsonl line ${lineNumber} is invalid JSON: ${error.message}`);
    }
    validateDecisionData(record);
    if (record.seq !== lineNumber) {
      throw new ValidationError(
        `decisions.jsonl seq must increase by one: line ${lineNumber} has seq ${JSON.stringify(record.seq)}`,
      );
    }
    if (record.prev_sha256 !== previousSha256) {
      throw new ValidationError(
        `decisions.jsonl chain mismatch at seq ${record.seq}: expected prev_sha256 ${JSON.stringify(previousSha256)}, got ${JSON.stringify(record.prev_sha256)}`,
      );
    }
    if (record.prev_seq !== undefined) {
      if (!Number.isInteger(record.prev_seq) || record.prev_seq < 1 || record.prev_seq >= record.seq) {
        throw new ValidationError(
          `decisions.jsonl seq ${record.seq} prev_seq must reference an earlier decision`,
        );
      }
      const referenced = records[record.prev_seq - 1];
      if (!referenced || referenced.seq !== record.prev_seq) {
        throw new ValidationError(
          `decisions.jsonl seq ${record.seq} prev_seq ${record.prev_seq} cannot be resolved`,
        );
      }
      if (
        ['gate.what.revoked', 'scope.added', 'scope.removed'].includes(record.type)
        && (
          !['gate.what.approved', 'scope.added', 'scope.removed'].includes(referenced.type)
          || normalizeReference(referenced.scope_ref) !== normalizeReference(record.scope_ref)
        )
      ) {
        throw new ValidationError(
          `decisions.jsonl seq ${record.seq} prev_seq must reference the active decision for the same scope_ref`,
        );
      }
      if (['gate.what.revoked', 'scope.added', 'scope.removed'].includes(record.type)) {
        const latestForScope = records.filter((candidate) => (
          ['gate.what.approved', 'gate.what.revoked', 'scope.added', 'scope.removed'].includes(candidate.type)
          && normalizeReference(candidate.scope_ref) === normalizeReference(record.scope_ref)
        )).at(-1);
        if (latestForScope?.seq !== referenced.seq) {
          throw new ValidationError(
            `decisions.jsonl seq ${record.seq} prev_seq must reference the latest active decision for the same scope_ref`,
          );
        }
      }
      if (
        record.type === 'gate.what.approved'
        && (
          !['gate.what.approved', 'scope.added', 'scope.removed'].includes(referenced.type)
          || decisionScopeIdentity(referenced.scope_ref) !== decisionScopeIdentity(record.scope_ref)
        )
      ) {
        throw new ValidationError(
          `decisions.jsonl seq ${record.seq} relocated approval must reference the same Gate artifact`,
        );
      }
      if (record.type === 'gate.what.approved') {
        const latestForArtifact = records.filter((candidate) => (
          ['gate.what.approved', 'gate.what.revoked', 'scope.added', 'scope.removed'].includes(candidate.type)
          && decisionScopeIdentity(candidate.scope_ref) === decisionScopeIdentity(record.scope_ref)
        )).at(-1);
        if (latestForArtifact?.seq !== referenced.seq) {
          throw new ValidationError(
            `decisions.jsonl seq ${record.seq} relocated approval must reference the latest active decision for the same Gate artifact`,
          );
        }
      }
      if (record.type === 'gate.how.revoked' && referenced.type !== 'gate.how.approved') {
        throw new ValidationError(
          `decisions.jsonl seq ${record.seq} prev_seq must reference a gate.how.approved decision`,
        );
      }
      if (record.type === 'gate.how.revoked') {
        const latestGateHow = records.filter((candidate) => (
          ['gate.how.approved', 'gate.how.revoked'].includes(candidate.type)
        )).at(-1);
        if (latestGateHow?.seq !== referenced.seq) {
          throw new ValidationError(
            `decisions.jsonl seq ${record.seq} prev_seq must reference the latest active gate.how.approved decision`,
          );
        }
      }
    }
    records.push(record);
    previousSha256 = decisionRecordSha256(record);
  }
  return records;
}

function stringLeaves(value, valuePath = '$', leaves = []) {
  if (typeof value === 'string') {
    leaves.push({ path: valuePath, value });
    return leaves;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, `${valuePath}[${index}]`, leaves));
    return leaves;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      stringLeaves(item, `${valuePath}.${key}`, leaves);
    }
  }
  return leaves;
}

const CONSTITUTION_PROHIBITION_PATHS = {
  spec: [
    /^\$\.product\.(?:goals|core_flows|screens_or_interfaces|data_model_draft|external_integrations|constraints)\[\d+\]$/,
    /^\$\.implementation\.(?:architecture|interfaces|data_flow|dependencies)\[\d+\]$/,
  ],
  task_graph: [
    /^\$\.tasks\[\d+\]\.(?:title|description|targetArea|suggestedAgentPrompt)$/,
    /^\$\.tasks\[\d+\]\.acceptanceCriteria\[\d+\]$/,
  ],
};

function prohibitionCandidateLeaves(artifact, target) {
  const pathPatterns = CONSTITUTION_PROHIBITION_PATHS[target] ?? [];
  return stringLeaves(artifact).filter((leaf) => (
    pathPatterns.some((pattern) => pattern.test(leaf.path))
  ));
}

function isNegatedProhibitionMention(value, start, length) {
  const before = value.slice(Math.max(0, start - 96), start);
  const after = value.slice(start + length, start + length + 96);
  const englishBefore = (
    /(?:^|\b)(?:no|without)\s+(?:[\w'-]+\s+){0,3}$/i.test(before)
    || /(?:^|\b)(?:avoid(?:ing)?|never|do\s+not|don't|must\s+not|not)\s+(?:(?:use|using|introduce|introducing|add|adding|depend(?:ing)?\s+on)\s+)?(?:[\w'-]+\s+){0,2}$/i.test(before)
    || /(?:^|\b)(?:remove|removing|eliminate|eliminating|exclude|excluding|forbid|forbidden|disallow|disallowed)\s+(?:[\w'-]+\s+){0,2}$/i.test(before)
  );
  const englishAfter = /^\s*(?:(?:must|should)\s+not\s+be\s+(?:used|introduced|added)|(?:(?:is|are|must\s+be|should\s+be|usage\s+is|use\s+is)\s+)?(?:not\s+allowed|not\s+used|not\s+introduced|not\s+added|forbidden|disallowed|excluded|removed|absent|unused))\b/i.test(after);
  const koreanBefore = /(?:금지(?:된)?|제외(?:한|된)?|제거(?:할|하는)?|사용하지\s*않는|쓰지\s*않는|피하는)\s*$/u.test(before);
  const koreanAfter = /^\s*(?:을|를|이|가|은|는)?\s*(?:사용|도입|추가|연동)?(?:을|를)?\s*(?:금지|제외|제거|하지\s*않|안\s*씀|없음|피함)/u.test(after);
  return englishBefore || englishAfter || koreanBefore || koreanAfter;
}

function activeForbiddenTermMatch(value, term) {
  const normalizedValue = value.toLocaleLowerCase('en-US');
  const normalizedTerm = term.trim().toLocaleLowerCase('en-US');
  let cursor = 0;
  while (cursor <= normalizedValue.length - normalizedTerm.length) {
    const index = normalizedValue.indexOf(normalizedTerm, cursor);
    if (index === -1) return false;
    if (!isNegatedProhibitionMention(value, index, normalizedTerm.length)) return true;
    cursor = index + normalizedTerm.length;
  }
  return false;
}

export function validateConstitutionProhibitions(constitution, artifact, target, label = target) {
  const leaves = prohibitionCandidateLeaves(artifact, target);
  for (const prohibition of constitution.prohibitions) {
    if ((prohibition.enforcement ?? 'advisory') !== 'validator') continue;
    if (!prohibition.targets.includes(target)) continue;
    for (const term of prohibition.forbidden_terms) {
      const violation = leaves.find((leaf) => activeForbiddenTermMatch(leaf.value, term));
      if (violation) {
        throw new ValidationError(
          `${label} violates constitution prohibition ${prohibition.id} at ${violation.path}: forbidden term ${JSON.stringify(term)}`,
        );
      }
    }
  }
  return artifact;
}

function projectConstitutionPathFrom(filePath) {
  let current = path.resolve(filePath);
  try {
    if (existsSync(current) && lstatSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    if (path.basename(current) === P2A_DIR) {
      const candidate = path.join(current, 'constitution.json');
      return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
    }
    const nested = path.join(current, P2A_DIR, 'constitution.json');
    if (existsSync(nested) && lstatSync(nested).isFile()) return nested;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveConstitutionForArtifact(filePath, options = {}) {
  const explicit = options.constitutionPath ?? null;
  const constitutionPath = explicit ? path.resolve(explicit) : projectConstitutionPathFrom(filePath);
  if (!constitutionPath) return { constitution: null, constitutionPath: null };
  assertFile(constitutionPath, 'constitution');
  return {
    constitution: validateConstitution(constitutionPath, {
      requireApproved: options.requireApprovedConstitution !== false,
      projectId: options.projectId,
    }),
    constitutionPath,
  };
}

export function validateSpecApprovalAudit(spec, label = 'spec.approval_audit') {
  if (spec.approval !== 'approved') return null;
  if (!spec.approval_audit) {
    throw new ValidationError(`${label} is required when spec.approval is approved`);
  }
  return validateApprovalAuditData(spec.approval_audit, label);
}

export function validateCurrentSpecGateBApprovalAudit(currentSpec, iterationId, spec) {
  if (spec.approval !== 'approved') return null;
  const audit = currentSpec?.gate_b_approval_audits?.[iterationId];
  if (!audit) {
    throw new ValidationError(`current-spec.json gate_b_approval_audits.${iterationId} is required for approved Gate B`);
  }
  return validateApprovalAuditData(audit, `current-spec.json gate_b_approval_audits.${iterationId}`);
}

function visualArtifactRoot(filePath, artifactRoot = null) {
  if (artifactRoot) return path.resolve(artifactRoot);
  const parent = path.dirname(path.resolve(filePath));
  if (path.basename(parent) !== 'gate-b-spec') return parent;
  const container = path.dirname(parent);
  const iterationsDir = path.dirname(container);
  return path.basename(iterationsDir) === 'iterations'
    ? path.dirname(iterationsDir)
    : container;
}

function safeRelativeArtifactPath(reference, label) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new ValidationError(`${label} must be a non-empty path`);
  }
  const normalized = normalizeReference(reference.trim());
  if (
    path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').includes('..')
  ) {
    throw new ValidationError(`${label} must be a relative path that does not traverse outside its artifact directory`);
  }
  return normalized;
}

function requireRunScopedVisualEvidence(reference, expectedContract, label) {
  if (!expectedContract?.iteration_id || !expectedContract?.run_id) return;
  const prefix = `visual-evidence/${expectedContract.iteration_id}/${expectedContract.run_id}/`;
  if (!reference.startsWith(prefix) || reference.length === prefix.length) {
    throw new ValidationError(`${label} must stay under ${prefix}`);
  }
}

function resolveVisualReference(reference, sourcePath, artifactRoot = null) {
  if (!reference || typeof reference !== 'string') return null;
  const baseDir = path.dirname(path.resolve(sourcePath));
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(baseDir, reference),
        artifactRoot ? path.resolve(artifactRoot, reference) : null,
        path.resolve(process.cwd(), reference),
        resolveProjectRelativeReference(reference, baseDir),
      ];
  return candidates
    .filter(Boolean)
    .find((candidate) => existsSync(candidate) && lstatSync(candidate).isFile()) ?? null;
}

function requireVisualReference(reference, sourcePath, artifactRoot, label) {
  const resolved = resolveVisualReference(reference, sourcePath, artifactRoot);
  if (!resolved) {
    throw new ValidationError(`${label} cannot be resolved to a file: ${JSON.stringify(reference)}`);
  }
  assertFileInsideArtifactRoot(resolved, visualArtifactRoot(sourcePath, artifactRoot), label);
  return resolved;
}

function referenceMatchesVisualFile(reference, sourcePath, targetPath, artifactRoot = null) {
  const resolved = resolveVisualReference(reference, sourcePath, artifactRoot);
  if (resolved) return realpathSync(resolved) === realpathSync(targetPath);
  const normalized = normalizeReference(reference);
  const candidates = new Set([
    normalizePath(path.relative(path.dirname(sourcePath), targetPath)),
    normalizePath(path.relative(visualArtifactRoot(sourcePath, artifactRoot), targetPath)),
    normalizePath(path.basename(targetPath)),
  ]);
  return candidates.has(normalized);
}

function uniqueObjectIds(items, field, label) {
  const ids = items.map((item) => item[field]);
  if (ids.length !== new Set(ids).size) {
    throw new ValidationError(`${label} ${field} values must be unique`);
  }
}

function requireSubset(values, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = values.filter((value) => !allowedSet.has(value));
  if (unknown.length) {
    throw new ValidationError(`${label} contains values outside the approved visual contract: ${JSON.stringify(unknown)}`);
  }
}

function requireSameSet(values, expected, label) {
  requireSubset(values, expected, label);
  requireSubset(expected, values, label);
}

const OFFLINE_PROTOTYPE_CSP = new Map([
  ['default-src', ["'none'"]],
  ['script-src', ["'none'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', ["'self'", 'data:', 'blob:']],
  ['font-src', ["'self'", 'data:']],
  ['connect-src', ["'none'"]],
  ['object-src', ["'none'"]],
  ['frame-src', ["'none'"]],
  ['child-src', ["'none'"]],
  ['worker-src', ["'none'"]],
  ['form-action', ["'none'"]],
  ['base-uri', ["'none'"]],
]);

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const HTML_RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

function parseHtmlTagAttributes(tag, nameOffset) {
  const attributes = new Map();
  let offset = nameOffset;
  while (offset < tag.length) {
    while (/\s/.test(tag[offset] ?? '')) offset += 1;
    if (offset >= tag.length || tag[offset] === '>' || (tag[offset] === '/' && tag[offset + 1] === '>')) break;
    const nameStart = offset;
    while (offset < tag.length && !/[\s"'<>/=]/.test(tag[offset])) offset += 1;
    if (offset === nameStart) {
      offset += 1;
      continue;
    }
    const name = tag.slice(nameStart, offset).toLowerCase();
    while (/\s/.test(tag[offset] ?? '')) offset += 1;
    let value = null;
    if (tag[offset] === '=') {
      offset += 1;
      while (/\s/.test(tag[offset] ?? '')) offset += 1;
      if (tag[offset] === '"' || tag[offset] === "'") {
        const quote = tag[offset];
        offset += 1;
        const valueStart = offset;
        while (offset < tag.length && tag[offset] !== quote) offset += 1;
        value = tag.slice(valueStart, offset);
        if (tag[offset] === quote) offset += 1;
      } else {
        const valueStart = offset;
        while (offset < tag.length && !/[\s"'`=<>]/.test(tag[offset])) offset += 1;
        value = tag.slice(valueStart, offset);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function htmlTagEnd(content, start) {
  let quote = null;
  for (let offset = start + 1; offset < content.length; offset += 1) {
    const character = content[offset];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return offset;
    }
  }
  return -1;
}

function renderedHtmlElements(content, options = {}) {
  const elements = [];
  const stack = [];
  const lowerContent = content.toLowerCase();
  let offset = 0;
  while (offset < content.length) {
    const activeRawTextElement = stack.at(-1)?.rawTextElement;
    if (activeRawTextElement) {
      const closingOffset = lowerContent.indexOf(`</${activeRawTextElement}`, offset);
      if (closingOffset < 0) break;
      offset = closingOffset;
    }
    const tagStart = content.indexOf('<', offset);
    if (tagStart < 0) break;
    if (content.startsWith('<!--', tagStart)) {
      const commentEnd = content.indexOf('-->', tagStart + 4);
      if (commentEnd < 0) break;
      offset = commentEnd + 3;
      continue;
    }
    if (content.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = content.indexOf(']]>', tagStart + 9);
      if (cdataEnd < 0) break;
      offset = cdataEnd + 3;
      continue;
    }
    const tagEnd = htmlTagEnd(content, tagStart);
    if (tagEnd < 0) break;
    const tag = content.slice(tagStart, tagEnd + 1);
    const closingMatch = tag.match(/^<\s*\/\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (closingMatch) {
      const tagName = closingMatch[1].toLowerCase();
      let stackIndex = stack.length - 1;
      while (stackIndex >= 0 && stack[stackIndex].tagName !== tagName) stackIndex -= 1;
      if (stackIndex >= 0) stack.length = stackIndex;
      offset = tagEnd + 1;
      continue;
    }
    const openingMatch = tag.match(/^<\s*([A-Za-z][A-Za-z0-9:-]*)/);
    if (!openingMatch) {
      offset = tagEnd + 1;
      continue;
    }
    const tagName = openingMatch[1].toLowerCase();
    const attributes = parseHtmlTagAttributes(tag, openingMatch[0].length);
    const element = { tagName, attributes };
    const parentInactive = stack.at(-1)?.inactive ?? false;
    const parentTreeSuppressed = stack.at(-1)?.treeSuppressed ?? false;
    const inactive = parentInactive || tagName === 'template' || tagName === 'noscript';
    const treeSuppressed = parentTreeSuppressed
      || inactive
      || attributes.has('hidden')
      || (options.excludeInert && attributes.has('inert'))
      || (tagName === 'dialog' && !attributes.has('open'));
    const suppressed = treeSuppressed;
    const rawTextElement = HTML_RAW_TEXT_ELEMENTS.has(tagName) ? tagName : null;
    let textContent = null;
    if (rawTextElement) {
      const closingOffset = lowerContent.indexOf(`</${rawTextElement}`, tagEnd + 1);
      textContent = content.slice(tagEnd + 1, closingOffset < 0 ? content.length : closingOffset);
    }
    if (
      !suppressed
      || options.includeSuppressed
      || (options.includeActiveStyles && ['link', 'style'].includes(tagName) && !inactive)
    ) {
      elements.push({ ...element, sourceOffset: tagStart, textContent });
    }
    const selfClosing = /\/\s*>$/.test(tag);
    if (!selfClosing && !HTML_VOID_ELEMENTS.has(tagName)) {
      stack.push({
        tagName,
        attributes,
        inactive,
        suppressed,
        treeSuppressed,
        rawTextElement,
      });
    }
    offset = tagEnd + 1;
  }
  return elements;
}

function assertOfflinePrototypeCsp(content, label) {
  const metaTag = renderedHtmlElements(content, { includeSuppressed: true }).find((element) => (
    element.tagName === 'meta'
    && decodeHtmlUrlReference(element.attributes.get('http-equiv') ?? '').trim().toLowerCase()
      === 'content-security-policy'
  ));
  if (!metaTag) {
    throw new ValidationError(`${label} must declare a Content-Security-Policy meta tag for network_policy offline`);
  }
  const policyOffset = metaTag.sourceOffset;
  const prefix = content.slice(0, policyOffset);
  if (!/^\s*(?:<!doctype\s+html\s*>\s*)?(?:<html(?:\s[^>]*)?>\s*)?(?:<head(?:\s[^>]*)?>\s*)?$/i.test(prefix)) {
    throw new ValidationError(`${label} Content-Security-Policy must precede all prototype content`);
  }
  const policyText = decodeHtmlUrlReference(metaTag.attributes.get('content') ?? '');
  if (!policyText) {
    throw new ValidationError(`${label} Content-Security-Policy must not be empty`);
  }
  const directives = new Map();
  for (const rawDirective of policyText.split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens.shift().toLowerCase();
    if (directives.has(name)) {
      throw new ValidationError(`${label} Content-Security-Policy repeats directive ${name}`);
    }
    directives.set(name, tokens.map((token) => token.toLowerCase()));
  }
  const additionalDirectives = [...directives.keys()].filter(
    (name) => !OFFLINE_PROTOTYPE_CSP.has(name),
  );
  if (additionalDirectives.length) {
    throw new ValidationError(
      `${label} Content-Security-Policy must not include additional directives: ${additionalDirectives.join(', ')}`,
    );
  }
  for (const [name, expectedTokens] of OFFLINE_PROTOTYPE_CSP) {
    const actualTokens = directives.get(name);
    if (
      !actualTokens
      || actualTokens.length !== expectedTokens.length
      || expectedTokens.some((token) => !actualTokens.includes(token))
    ) {
      throw new ValidationError(
        `${label} Content-Security-Policy ${name} must be exactly ${expectedTokens.join(' ')}`,
      );
    }
  }
}

function assertOfflinePrototypeContent(filePath, mediaType, label) {
  if (!['text/html', 'text/css', 'image/svg+xml'].includes(mediaType)) return;
  const content = readFileSync(filePath, 'utf8');
  if (mediaType === 'text/html') assertOfflinePrototypeCsp(content, label);
  const remoteResource = /(?:src|srcset|href|data|action|formaction|poster|ping)\s*=\s*(?:["']\s*)?(?:https?:)?\/\//i.test(content)
    || /url\(\s*["']?(?:https?:)?\/\//i.test(content)
    || /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(content)
    || /\bimport\s*(?:\(|[^;]*?from\s*)["'](?:https?:)?\/\//i.test(content);
  const decodedMetaRefresh = mediaType === 'text/html'
    && renderedHtmlElements(content, { includeSuppressed: true }).some((element) => (
      element.tagName === 'meta'
      && decodeHtmlUrlReference(element.attributes.get('http-equiv') ?? '').trim().toLowerCase()
        === 'refresh'
    ));
  const browserRedirect = decodedMetaRefresh
    || /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:["']\s*)?refresh\b/i.test(content)
    || /\blocation\s*\.\s*(?:assign|replace)\s*\(/.test(content)
    || /\blocation(?:\s*\.\s*href)?\s*=/.test(content)
    || /\b(?:window|globalThis|top|parent|self)\s*\.\s*open\b/.test(content)
    || /\b(?:window|globalThis|top|parent|self)\s*\[\s*["']open["']\s*\]/.test(content)
    || /(?:^|[^.\w$])open\s*\(/m.test(content);
  const networkApi = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|importScripts)\s*\(/.test(content)
    || /\bnavigator\s*\.\s*sendBeacon\s*\(/.test(content)
    || /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/.test(content);
  if (remoteResource || browserRedirect || networkApi) {
    throw new ValidationError(`${label} violates network_policy offline`);
  }
  if (
    ['text/html', 'image/svg+xml'].includes(mediaType)
    && (
      /<script\b/i.test(content)
      || /\son[a-z][a-z0-9_-]*\s*=/i.test(content)
    )
  ) {
    throw new ValidationError(`${label} must not contain executable script or event handlers`);
  }
}

const PROTOTYPE_MEDIA_TYPE_EXTENSIONS = new Map([
  ['text/html', new Set(['.html', '.htm'])],
  ['text/css', new Set(['.css'])],
  ['application/json', new Set(['.json'])],
  ['image/svg+xml', new Set(['.svg'])],
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/webp', new Set(['.webp'])],
  ['font/woff', new Set(['.woff'])],
  ['font/woff2', new Set(['.woff2'])],
]);
const PROTOTYPE_MAX_FILE_BYTES = 25 * 1024 * 1024;

function assertPrototypeFileSize(filePath, label) {
  const fileSize = lstatSync(filePath).size;
  if (fileSize > PROTOTYPE_MAX_FILE_BYTES) {
    throw new ValidationError(
      `${label} file size exceeds the ${PROTOTYPE_MAX_FILE_BYTES} byte limit`,
    );
  }
}

function assertPrototypeMediaType(entry) {
  const extension = path.posix.extname(normalizePath(entry.path)).toLowerCase();
  if (!PROTOTYPE_MEDIA_TYPE_EXTENSIONS.get(entry.media_type)?.has(extension)) {
    throw new ValidationError(
      `visual prototype file media_type ${JSON.stringify(entry.media_type)} does not match its extension: ${entry.path}`,
    );
  }
}

function assertPrototypeFileContentType(filePath, entry) {
  const label = `visual prototype file ${entry.path}`;
  if (entry.media_type === 'image/png') {
    validatedPngDimensions(filePath, label);
    return;
  }
  const buffer = readFileSync(filePath);
  if (entry.media_type === 'image/jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
      throw new ValidationError(`${label} content does not match media_type image/jpeg`);
    }
    return;
  }
  if (entry.media_type === 'image/webp') {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
      throw new ValidationError(`${label} content does not match media_type image/webp`);
    }
    return;
  }
  if (entry.media_type === 'font/woff' && buffer.toString('ascii', 0, 4) !== 'wOFF') {
    throw new ValidationError(`${label} content does not match media_type font/woff`);
  }
  if (entry.media_type === 'font/woff2' && buffer.toString('ascii', 0, 4) !== 'wOF2') {
    throw new ValidationError(`${label} content does not match media_type font/woff2`);
  }
  if (entry.media_type === 'application/json') {
    try {
      JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      throw new ValidationError(`${label} content does not match media_type application/json: ${error.message}`);
    }
  }
  if (entry.media_type === 'image/svg+xml' && !/<svg\b/i.test(buffer.toString('utf8'))) {
    throw new ValidationError(`${label} content does not match media_type image/svg+xml`);
  }
}

const HTML_URL_ENTITY_VALUES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['quot', '"'],
  ['colon', ':'],
  ['sol', '/'],
  ['bsol', '\\'],
  ['tab', '\t'],
  ['newline', '\n'],
]);

function decodeHtmlUrlReference(value) {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (match, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&([a-z]+);?/gi, (match, name) => HTML_URL_ENTITY_VALUES.get(name.toLowerCase()) ?? match);
}

function addPrototypeReference(references, rawReference, sourceEntryPath, label, options = {}) {
  const reference = (options.html ? decodeHtmlUrlReference(rawReference) : rawReference).trim();
  if (
    !reference
    || reference.startsWith('#')
    || reference.startsWith('?')
  ) return;
  const schemeReference = reference.replace(/[\u0000-\u0020]+/g, '');
  if (/^(?:data|blob):/i.test(schemeReference) && options.allowEmbeddedData) return;
  if (/^(?:\/\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(schemeReference)) {
    throw new ValidationError(`${label} violates network_policy offline: ${JSON.stringify(reference)}`);
  }
  const withoutFragment = reference.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return;
  if (withoutFragment.startsWith('/')) {
    throw new ValidationError(`${label} must use a prototype-relative resource path: ${JSON.stringify(reference)}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new ValidationError(`${label} contains an invalid encoded resource path: ${JSON.stringify(reference)}`);
  }
  const sourceDir = path.posix.dirname(normalizePath(sourceEntryPath));
  const normalized = safeRelativeArtifactPath(
    path.posix.normalize(path.posix.join(sourceDir, normalizePath(decoded))),
    label,
  );
  references.add(normalized);
}

function prototypeLocalReferences(filePath, entry) {
  if (!['text/html', 'text/css', 'image/svg+xml'].includes(entry.media_type)) {
    return new Set();
  }
  const content = readFileSync(filePath, 'utf8');
  const references = new Set();
  const add = (reference, kind, options = {}) => addPrototypeReference(
    references,
    reference,
    entry.path,
    `visual prototype ${entry.path} ${kind}`,
    options,
  );
  for (const match of content.matchAll(/\b(src|href|data|action|formaction|poster|ping)\s*=\s*["']([^"']+)["']/gi)) {
    const attribute = match[1].toLowerCase();
    add(match[2], 'resource reference', {
      html: ['text/html', 'image/svg+xml'].includes(entry.media_type),
      allowEmbeddedData: ['src', 'poster'].includes(attribute),
    });
  }
  for (const match of content.matchAll(/\b(src|href|data|action|formaction|poster|ping)\s*=\s*([^\s"'`=<>]+)/gi)) {
    const attribute = match[1].toLowerCase();
    add(match[2], 'unquoted resource reference', {
      html: ['text/html', 'image/svg+xml'].includes(entry.media_type),
      allowEmbeddedData: ['src', 'poster'].includes(attribute),
    });
  }
  for (const match of content.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) add(candidate.trim().split(/\s+/, 1)[0], 'srcset reference');
  }
  for (const match of content.matchAll(/\bsrcset\s*=\s*([^\s"'`=<>]+)/gi)) {
    for (const candidate of match[1].split(',')) add(candidate.trim(), 'unquoted srcset reference');
  }
  for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    add(match[1], 'CSS url', { allowEmbeddedData: true });
  }
  for (const match of content.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) add(match[1], 'CSS import');
  return references;
}

function normalizePrototypeNavigationReference(rawReference, sourceEntryPath, label, options = {}) {
  const reference = decodeHtmlUrlReference(rawReference).trim();
  if (!reference || reference.startsWith('?')) return null;
  const schemeReference = reference.replace(/[\u0000-\u0020]+/g, '');
  if (/^(?:\/\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(schemeReference)) return null;
  if (reference.startsWith('/')) {
    throw new ValidationError(`${label} must use a prototype-relative path: ${JSON.stringify(reference)}`);
  }
  const [rawPath, rawFragment = ''] = reference.split('#', 2);
  const withoutQuery = rawPath.split('?', 1)[0];
  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(withoutQuery);
    fragment = decodeURIComponent(rawFragment);
  } catch {
    throw new ValidationError(`${label} contains invalid URL encoding: ${JSON.stringify(reference)}`);
  }
  const sourceDir = path.posix.dirname(normalizePath(sourceEntryPath));
  const referenceBase = withoutQuery
    ? (options.rootRelative ? '.' : sourceDir)
    : sourceDir;
  const referencePath = decodedPath || path.posix.basename(sourceEntryPath);
  const resolvedPath = safeRelativeArtifactPath(
    path.posix.normalize(path.posix.join(referenceBase, normalizePath(referencePath))),
    label,
  );
  return { path: resolvedPath, fragment };
}

function prototypeRenderedHtmlElements(filePath, entry, entriesByPath, prototypeDir, options = {}) {
  const content = readFileSync(filePath, 'utf8');
  return renderedHtmlElements(content, options);
}

function prototypeAnchorReferences(filePath, entry, entriesByPath, prototypeDir) {
  if (entry.media_type !== 'text/html') return [];
  const references = [];
  for (const element of prototypeRenderedHtmlElements(
    filePath,
    entry,
    entriesByPath,
    prototypeDir,
    { excludeInert: true },
  )) {
    if (element.tagName !== 'a') continue;
    const href = element.attributes.get('href');
    if (typeof href !== 'string') continue;
    const reference = normalizePrototypeNavigationReference(
      href,
      entry.path,
      `visual prototype ${entry.path} anchor href`,
    );
    if (reference) references.push(reference);
  }
  return references;
}

function htmlHasFragmentTarget(filePath, entry, fragment, entriesByPath, prototypeDir) {
  if (!fragment) return true;
  for (const element of prototypeRenderedHtmlElements(
    filePath,
    entry,
    entriesByPath,
    prototypeDir,
  )) {
    const id = element.attributes.get('id');
    const name = element.attributes.get('name');
    if (
      (id !== undefined && id !== null && decodeHtmlUrlReference(id) === fragment)
      || (
        element.tagName === 'a'
        && name !== undefined
        && name !== null
        && decodeHtmlUrlReference(name) === fragment
      )
    ) {
      return true;
    }
  }
  return false;
}

function validatePrototypeStateArtifacts(data, prototypeDir) {
  const entriesByPath = new Map(data.files.map((entry) => [normalizePath(entry.path), entry]));
  const reachableDocuments = new Set([normalizePath(data.entrypoint)]);
  const reachableFragments = new Set();
  const pending = [normalizePath(data.entrypoint)];
  while (pending.length) {
    const sourcePath = pending.shift();
    const sourceEntry = entriesByPath.get(sourcePath);
    const sourceFile = path.resolve(prototypeDir, sourcePath);
    for (const reference of prototypeAnchorReferences(
      sourceFile,
      sourceEntry,
      entriesByPath,
      prototypeDir,
    )) {
      const target = entriesByPath.get(reference.path);
      if (!target || target.media_type !== 'text/html') continue;
      if (reference.fragment) reachableFragments.add(`${reference.path}#${reference.fragment}`);
      if (!reachableDocuments.has(reference.path)) {
        reachableDocuments.add(reference.path);
        pending.push(reference.path);
      }
    }
  }

  for (const screen of data.screen_states) {
    uniqueObjectIds(screen.state_artifacts, 'state', `${screen.screen_id}.state_artifacts`);
    requireSameSet(
      screen.state_artifacts.map((artifact) => artifact.state),
      screen.states,
      `${screen.screen_id}.state_artifacts states`,
    );
    for (const artifact of screen.state_artifacts) {
      const reference = normalizePrototypeNavigationReference(
        artifact.artifact_ref,
        data.entrypoint,
        `${screen.screen_id} ${artifact.state} artifact_ref`,
        { rootRelative: true },
      );
      if (!reference) {
        throw new ValidationError(`${screen.screen_id} ${artifact.state} artifact_ref must reference local HTML`);
      }
      const target = entriesByPath.get(reference.path);
      if (!target || target.media_type !== 'text/html') {
        throw new ValidationError(
          `${screen.screen_id} ${artifact.state} artifact_ref must reference a declared HTML file: ${artifact.artifact_ref}`,
        );
      }
      const targetFile = path.resolve(prototypeDir, reference.path);
      if (!htmlHasFragmentTarget(
        targetFile,
        target,
        reference.fragment,
        entriesByPath,
        prototypeDir,
      )) {
        throw new ValidationError(
          `${screen.screen_id} ${artifact.state} artifact_ref fragment does not exist: ${artifact.artifact_ref}`,
        );
      }
      const reachable = reference.fragment
        ? reachableFragments.has(`${reference.path}#${reference.fragment}`)
        : reachableDocuments.has(reference.path);
      if (!reachable) {
        throw new ValidationError(
          `${screen.screen_id} ${artifact.state} artifact_ref is not reachable from ${data.entrypoint}: ${artifact.artifact_ref}`,
        );
      }
    }
  }
}

export function validateVisualPrototypeData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.visual_prototype));
  uniqueObjectIds(data.files, 'path', 'visual prototype files');
  uniqueObjectIds(data.screen_states, 'screen_id', 'visual prototype screen_states');
  for (const screen of data.screen_states) {
    uniqueObjectIds(screen.state_artifacts, 'state', `${screen.screen_id}.state_artifacts`);
    requireSameSet(
      screen.state_artifacts.map((artifact) => artifact.state),
      screen.states,
      `${screen.screen_id}.state_artifacts states`,
    );
  }
  const entrypoint = data.files.find((entry) => entry.path === data.entrypoint);
  if (!entrypoint || entrypoint.media_type !== 'text/html') {
    throw new ValidationError('visual prototype entrypoint must be listed in files with media_type text/html');
  }
  for (const [index, entry] of data.files.entries()) {
    safeRelativeArtifactPath(entry.path, `visual prototype files[${index}].path`);
    assertPrototypeMediaType(entry);
  }
  if (data.status === 'approved') {
    if (!data.approval_audit) {
      throw new ValidationError('approved visual prototypes must include approval_audit');
    }
    validateApprovalAuditData(data.approval_audit, 'visual prototype approval_audit');
    if (!data.approval_audit.approved_artifacts.includes(data.entrypoint)) {
      throw new ValidationError('approved visual prototype approval_audit.approved_artifacts must include entrypoint');
    }
  } else if (data.approval_audit) {
    throw new ValidationError('candidate visual prototypes must not include approval_audit');
  }
  return data;
}

function prototypeBundleFiles(prototypeDir) {
  const files = [];
  const directories = [prototypeDir];
  const unsupported = [];
  while (directories.length) {
    const directory = directories.shift();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = normalizePath(path.relative(prototypeDir, entryPath));
      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        unsupported.push(relative);
      }
    }
  }
  if (unsupported.length) {
    throw new ValidationError(
      `visual prototype directory contains unsupported entry(s): ${unsupported.sort().join(', ')}`,
    );
  }
  return files.sort();
}

export function validateVisualPrototype(filePath, options = {}) {
  assertFile(filePath, 'visual prototype manifest');
  assertPrototypeFileSize(filePath, 'visual prototype manifest');
  const data = validateVisualPrototypeData(loadJson(filePath));
  const prototypeDir = path.dirname(path.resolve(filePath));
  const manifestPaths = new Set(data.files.map((entry) => normalizePath(entry.path)));
  const manifestRef = normalizePath(path.relative(prototypeDir, path.resolve(filePath)));
  const allowedBundleFiles = new Set([manifestRef, ...manifestPaths]);
  const undeclaredBundleFiles = prototypeBundleFiles(prototypeDir)
    .filter((reference) => !allowedBundleFiles.has(reference));
  if (undeclaredBundleFiles.length) {
    throw new ValidationError(
      `visual prototype directory contains file(s) missing from the manifest: ${undeclaredBundleFiles.join(', ')}`,
    );
  }
  for (const entry of data.files) {
    const relative = safeRelativeArtifactPath(entry.path, `visual prototype file ${entry.path}`);
    const artifactPath = path.resolve(prototypeDir, relative);
    assertFile(artifactPath, `visual prototype file ${entry.path}`);
    assertFileInsideArtifactRoot(artifactPath, prototypeDir, `visual prototype file ${entry.path}`);
    assertPrototypeFileSize(artifactPath, `visual prototype file ${entry.path}`);
    if (rawFileSha256(artifactPath) !== entry.sha256) {
      throw new ValidationError(`visual prototype file hash does not match manifest: ${entry.path}`);
    }
    assertPrototypeFileContentType(artifactPath, entry);
    assertOfflinePrototypeContent(artifactPath, entry.media_type, `visual prototype file ${entry.path}`);
    for (const reference of prototypeLocalReferences(artifactPath, entry)) {
      if (!manifestPaths.has(reference)) {
        throw new ValidationError(
          `visual prototype file ${entry.path} references undeclared manifest file: ${reference}`,
        );
      }
    }
  }
  validatePrototypeStateArtifacts(data, prototypeDir);
  for (const [field, expected] of Object.entries(options.expected ?? {})) {
    if (data[field] !== expected) {
      throw new ValidationError(`visual prototype ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(data[field])}`);
    }
  }
  return data;
}

export function validateVisualExperienceData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.visual_experience));
  uniqueObjectIds(data.visual_direction.candidates, 'id', 'visual direction candidates');
  uniqueObjectIds(data.screens, 'id', 'visual experience screens');
  uniqueObjectIds(data.validation.viewports, 'name', 'visual experience viewports');
  for (const screen of data.screens) {
    uniqueObjectIds(screen.regions, 'id', `${screen.id}.regions`);
  }
  const screenStateUnion = [...new Set(data.screens.flatMap((screen) => screen.states))];
  requireSameSet(
    data.validation.required_states,
    screenStateUnion,
    'visual experience validation.required_states',
  );
  const candidateIds = new Set(data.visual_direction.candidates.map((candidate) => candidate.id));
  for (const candidate of data.visual_direction.candidates) {
    const canonicalRef = `visual-design/${candidate.id}/prototype.json`;
    if (normalizeReference(candidate.prototype_manifest_ref) !== canonicalRef) {
      throw new ValidationError(`${candidate.id}.prototype_manifest_ref must be ${JSON.stringify(canonicalRef)}`);
    }
  }
  const selected = data.visual_direction.selected_candidate;
  if (selected !== null && !candidateIds.has(selected)) {
    throw new ValidationError(`visual_direction.selected_candidate is unknown: ${JSON.stringify(selected)}`);
  }
  if (data.approval === 'approved') {
    if (!selected) throw new ValidationError('approved visual experience must select a candidate');
    if (!data.approval_audit) throw new ValidationError('approved visual experience must include approval_audit');
    validateApprovalAuditData(data.approval_audit, 'visual experience approval_audit');
    const selectedCandidate = data.visual_direction.candidates.find((candidate) => candidate.id === selected);
    if (!data.approval_audit.approved_artifacts.includes(selectedCandidate.prototype_manifest_ref)) {
      throw new ValidationError('visual experience approval_audit.approved_artifacts must include the selected prototype manifest');
    }
  } else if (data.approval_audit) {
    throw new ValidationError('draft visual experience must not include approval_audit');
  }
  return data;
}

export function validateVisualExperience(filePath, options = {}) {
  const data = validateVisualExperienceData(loadJson(filePath));
  const artifactRoot = visualArtifactRoot(filePath, options.artifactRoot);
  const selectedId = data.visual_direction.selected_candidate;
  let selectedPrototype = null;
  let selectedPrototypePath = null;
  for (const candidate of data.visual_direction.candidates) {
    const manifestPath = requireVisualReference(
      candidate.prototype_manifest_ref,
      filePath,
      artifactRoot,
      `${candidate.id}.prototype_manifest_ref`,
    );
    const prototype = validateVisualPrototype(manifestPath, {
      expected: { project_id: data.project_id, candidate_id: candidate.id },
    });
    if (rawFileSha256(manifestPath) !== candidate.prototype_manifest_sha256) {
      throw new ValidationError(`${candidate.id} prototype manifest hash does not match visual experience`);
    }
    if (!referenceMatchesVisualFile(prototype.experience_spec_ref, manifestPath, filePath, artifactRoot)) {
      throw new ValidationError(`${candidate.id} prototype experience_spec_ref must reference its visual experience spec`);
    }
    if (candidate.id === selectedId) {
      selectedPrototype = prototype;
      selectedPrototypePath = manifestPath;
    } else if (data.approval === 'approved' && prototype.status !== 'candidate') {
      throw new ValidationError(`${candidate.id} must remain a candidate when another visual direction is selected`);
    }
  }
  if (data.approval === 'approved') {
    if (selectedPrototype.status !== 'approved') {
      throw new ValidationError('the selected visual prototype must have status approved');
    }
    const screenIds = data.screens.map((screen) => screen.id);
    const prototypeScreenIds = selectedPrototype.screen_states.map((screen) => screen.screen_id);
    const viewportNames = data.validation.viewports.map((viewport) => viewport.name);
    requireSameSet(screenIds, prototypeScreenIds, 'selected prototype screens');
    const prototypeStatesByScreen = new Map(
      selectedPrototype.screen_states.map((screen) => [screen.screen_id, screen.states]),
    );
    for (const screen of data.screens) {
      requireSameSet(
        screen.states,
        prototypeStatesByScreen.get(screen.id) ?? [],
        `selected prototype ${screen.id} states`,
      );
    }
    requireSameSet(viewportNames, selectedPrototype.viewports, 'selected prototype viewports');
    if (!data.approval_audit.approved_artifacts.some((reference) => (
      referenceMatchesVisualFile(reference, filePath, selectedPrototypePath, artifactRoot)
    ))) {
      throw new ValidationError('visual experience approval_audit must reference the selected prototype manifest');
    }
  }
  for (const [field, expected] of Object.entries(options.expected ?? {})) {
    if (data[field] !== expected) {
      throw new ValidationError(`visual experience ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(data[field])}`);
    }
  }
  return data;
}

function resolveVisualReviewSourceSpec(expectedContract, artifactRoot, options = {}) {
  const sourceSpecRef = expectedContract?.source_spec_ref;
  if (typeof sourceSpecRef !== 'string' || !sourceSpecRef.trim()) {
    throw new ValidationError('visual review run contract source_spec_ref must be a non-empty string');
  }
  const candidates = [];
  if (path.isAbsolute(sourceSpecRef)) candidates.push(sourceSpecRef);
  const taskGraphRef = expectedContract?.task_graph_ref;
  if (typeof taskGraphRef === 'string' && taskGraphRef.trim()) {
    const taskGraphPath = path.isAbsolute(taskGraphRef)
      ? taskGraphRef
      : path.resolve(artifactRoot, taskGraphRef);
    candidates.push(path.resolve(path.dirname(taskGraphPath), sourceSpecRef));
    const projectRelative = resolveProjectRelativeReference(sourceSpecRef, path.dirname(taskGraphPath));
    if (projectRelative) candidates.push(projectRelative);
  }
  candidates.push(path.resolve(artifactRoot, sourceSpecRef));
  candidates.push(path.resolve(process.cwd(), sourceSpecRef));
  candidates.push(path.resolve(P2A_PATHS.toolRoot, sourceSpecRef));
  const sourceSpecPath = candidates.find(
    (candidate) => existsSync(candidate) && lstatSync(candidate).isFile(),
  );
  if (!sourceSpecPath) {
    throw new ValidationError(
      `visual review source_spec_ref cannot be resolved: ${JSON.stringify(sourceSpecRef)}`,
    );
  }
  if (options.requireInsideArtifactRoot !== false) {
    assertFileInsideArtifactRoot(sourceSpecPath, artifactRoot, 'visual review source_spec_ref');
  }
  return sourceSpecPath;
}

export function validateVisualReviewSourceArtifacts(expectedContract, options = {}) {
  const artifactRoot = path.resolve(
    options.sourceArtifactRoot
    ?? options.artifactRoot
    ?? process.cwd(),
  );
  const sourceSpecPath = resolveVisualReviewSourceSpec(expectedContract, artifactRoot);
  const sourceSpec = loadJson(sourceSpecPath);
  const experienceRef = expectedContract?.source_experience_ref;
  const prototypeRef = expectedContract?.source_prototype_ref;
  const expectedExperienceHash = expectedContract?.experience_spec_sha256;
  const expectedPrototypeHash = expectedContract?.prototype_manifest_sha256;
  for (const [field, value] of [
    ['source_experience_ref', experienceRef],
    ['source_prototype_ref', prototypeRef],
  ]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ValidationError(`visual review run contract ${field} must be a non-empty string`);
    }
  }
  for (const [field, value] of [
    ['experience_spec_sha256', expectedExperienceHash],
    ['prototype_manifest_sha256', expectedPrototypeHash],
  ]) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new ValidationError(`visual review run contract ${field} must be a SHA-256 hex digest`);
    }
  }

  const experiencePath = path.resolve(path.dirname(sourceSpecPath), safeRelativeArtifactPath(
    experienceRef,
    'visual review source_experience_ref',
  ));
  assertFile(experiencePath, 'visual review approved experience');
  assertFileInsideArtifactRoot(experiencePath, artifactRoot, 'visual review approved experience');
  if (sourceSpec.project_id !== expectedContract?.project_id) {
    throw new ValidationError('visual review source spec project_id does not match the run contract');
  }
  if (sourceSpec.approval !== 'approved') {
    throw new ValidationError('visual review source spec must remain approved');
  }
  const sourceVisual = sourceSpec.visual_experience;
  if (
    sourceVisual?.has_visual_interface !== true
    || sourceVisual.design_scope !== 'full'
    || sourceVisual.design_timing !== 'current_iteration'
    || sourceVisual.experience_spec_sha256 !== expectedExperienceHash
    || !referenceMatchesVisualFile(sourceVisual.experience_spec_ref, sourceSpecPath, experiencePath, artifactRoot)
  ) {
    throw new ValidationError('visual review source spec no longer approves the run experience contract');
  }
  if (!sourceSpec.approval_audit?.approved_artifacts?.some((reference) => (
    referenceMatchesVisualFile(reference, sourceSpecPath, experiencePath, artifactRoot)
  ))) {
    throw new ValidationError('visual review source spec approval audit must include the approved experience');
  }
  if (rawFileSha256(experiencePath) !== expectedExperienceHash) {
    throw new ValidationError('visual review approved experience hash does not match the run contract');
  }
  const experience = validateVisualExperience(experiencePath, {
    artifactRoot,
    expected: {
      ...(expectedContract.project_id ? { project_id: expectedContract.project_id } : {}),
      mode: 'full',
    },
  });
  if (experience.approval !== 'approved') {
    throw new ValidationError('visual review source experience must remain approved');
  }
  if (!referenceMatchesVisualFile(experience.source_spec_ref, experiencePath, sourceSpecPath, artifactRoot)) {
    throw new ValidationError('visual review source experience must reference the run source spec');
  }
  const selected = experience.visual_direction.candidates.find(
    (candidate) => candidate.id === experience.visual_direction.selected_candidate,
  );
  if (
    !selected
    || normalizeReference(selected.prototype_manifest_ref) !== normalizeReference(prototypeRef)
    || selected.prototype_manifest_sha256 !== expectedPrototypeHash
  ) {
    throw new ValidationError('visual review selected prototype does not match the run contract');
  }
  const prototypePath = path.resolve(path.dirname(experiencePath), safeRelativeArtifactPath(
    prototypeRef,
    'visual review source_prototype_ref',
  ));
  assertFile(prototypePath, 'visual review approved prototype manifest');
  assertFileInsideArtifactRoot(prototypePath, artifactRoot, 'visual review approved prototype manifest');
  if (rawFileSha256(prototypePath) !== expectedPrototypeHash) {
    throw new ValidationError('visual review approved prototype manifest hash does not match the run contract');
  }
  return { sourceSpecPath, experiencePath, prototypePath, experience };
}

function validateAccessibilityReportData(data, expected = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('visual accessibility report must be a JSON object');
  }
  if (data.schema_version !== 'p2a.visual_accessibility_report.v1') {
    throw new ValidationError('visual accessibility report schema_version must be p2a.visual_accessibility_report.v1');
  }
  for (const field of ['tool', 'standard', 'scanned_at']) {
    if (typeof data[field] !== 'string' || !data[field].trim()) {
      throw new ValidationError(`visual accessibility report ${field} must be a non-empty string`);
    }
  }
  const scannedAt = Date.parse(data.scanned_at);
  if (Number.isNaN(scannedAt)) {
    throw new ValidationError('visual accessibility report scanned_at must be a valid timestamp');
  }
  if (expected.startedAt !== undefined) {
    const startedAt = Date.parse(expected.startedAt);
    if (Number.isNaN(startedAt)) {
      throw new ValidationError('visual accessibility report run contract started_at must be a valid timestamp');
    }
    if (scannedAt < startedAt) {
      throw new ValidationError('visual accessibility report scanned_at must not predate the run start');
    }
  }
  if (expected.notBefore !== undefined) {
    const notBefore = Date.parse(expected.notBefore);
    if (Number.isNaN(notBefore)) {
      throw new ValidationError('visual accessibility report final integration cutoff must be a valid timestamp');
    }
    if (scannedAt < notBefore) {
      throw new ValidationError('visual accessibility report scanned_at must not predate the final integration cutoff');
    }
  }
  if (expected.reviewedAt !== undefined) {
    const reviewedAt = Date.parse(expected.reviewedAt);
    if (Number.isNaN(reviewedAt)) {
      throw new ValidationError('visual accessibility report reviewed_at contract must be a valid timestamp');
    }
    if (scannedAt > reviewedAt) {
      throw new ValidationError('visual accessibility report scanned_at must not be later than reviewed_at');
    }
  }
  if (expected.finishedAt !== undefined) {
    const finishedAt = Date.parse(expected.finishedAt);
    if (Number.isNaN(finishedAt)) {
      throw new ValidationError('visual accessibility report run contract finished_at must be a valid timestamp');
    }
    if (scannedAt > finishedAt) {
      throw new ValidationError('visual accessibility report scanned_at must not be later than the run finish');
    }
  }
  if (!Array.isArray(data.page_urls) || !data.page_urls.length || data.page_urls.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new ValidationError('visual accessibility report page_urls must be a non-empty string array');
  }
  if (!Array.isArray(data.violations)) {
    throw new ValidationError('visual accessibility report violations must be an array');
  }
  const allowedImpacts = new Set(['critical', 'serious', 'moderate', 'minor', null]);
  for (const [index, violation] of data.violations.entries()) {
    if (!violation || typeof violation !== 'object' || Array.isArray(violation)) {
      throw new ValidationError(`visual accessibility report violations[${index}] must be an object`);
    }
    if (typeof violation.id !== 'string' || !violation.id.trim() || !allowedImpacts.has(violation.impact)) {
      throw new ValidationError(`visual accessibility report violations[${index}] must include id and a supported impact`);
    }
    if (!Array.isArray(violation.nodes)) {
      throw new ValidationError(`visual accessibility report violations[${index}].nodes must be an array`);
    }
  }
  if (expected.standard !== undefined && data.standard !== expected.standard) {
    throw new ValidationError('visual accessibility report standard does not match the run contract');
  }
  if (expected.pageUrls) requireSameSet(data.page_urls, expected.pageUrls, 'visual accessibility report page_urls');
  return data;
}

export function validateVisualReviewData(data, expectedContract = null) {
  validateSchema(data, loadJson(SCHEMA_PATHS.visual_review));
  const resultKeys = data.results.map((result) => `${result.screen_id}\u0000${result.state}\u0000${result.viewport}`);
  if (resultKeys.length !== new Set(resultKeys).size) {
    throw new ValidationError('visual review screen/state/viewport result combinations must be unique');
  }
  if (expectedContract) {
    for (const field of [
      'run_id',
      'iteration_id',
      'workspace_ref',
      'workspace_revision_sha256',
      'source_experience_ref',
      'source_prototype_ref',
    ]) {
      if (expectedContract[field] !== undefined && data[field] !== expectedContract[field]) {
        throw new ValidationError(`visual review ${field} must be ${JSON.stringify(expectedContract[field])}, got ${JSON.stringify(data[field])}`);
      }
    }
    const expectedKeys = [];
    for (const screen of expectedContract.screen_states ?? []) {
      for (const state of screen.states ?? []) {
        for (const viewport of expectedContract.viewports ?? []) {
          expectedKeys.push(`${screen.screen_id}\u0000${state}\u0000${viewport.name}`);
        }
      }
    }
    const actual = new Set(resultKeys);
    const missing = expectedKeys.filter((key) => !actual.has(key));
    if (missing.length) {
      throw new ValidationError(`visual review is missing ${missing.length} required screen/state/viewport result(s)`);
    }
    const expected = new Set(expectedKeys);
    const extra = resultKeys.filter((key) => !expected.has(key));
    if (extra.length) {
      throw new ValidationError(`visual review contains ${extra.length} screen/state/viewport result(s) outside the run contract`);
    }
    const expectedViewports = new Map((expectedContract.viewports ?? []).map((viewport) => [viewport.name, viewport]));
    for (const result of data.results) {
      const viewport = expectedViewports.get(result.viewport);
      if (!viewport || result.width !== viewport.width || (viewport.height !== null && result.height !== viewport.height)) {
        throw new ValidationError(`visual review ${result.screen_id}/${result.state}/${result.viewport} dimensions do not match the run contract`);
      }
    }
    if (
      expectedContract.accessibility_standard !== undefined
      && data.accessibility.standard !== expectedContract.accessibility_standard
    ) {
      throw new ValidationError('visual review accessibility.standard does not match the run contract');
    }
  }
  const reviewedAt = Date.parse(data.reviewed_at);
  if (Number.isNaN(reviewedAt)) {
    throw new ValidationError('visual review reviewed_at must be a valid timestamp');
  }
  const startedAt = expectedContract?.started_at === undefined
    ? null
    : Date.parse(expectedContract.started_at);
  if (startedAt !== null && Number.isNaN(startedAt)) {
    throw new ValidationError('visual review run contract started_at must be a valid timestamp');
  }
  const finishedAt = expectedContract?.finished_at === undefined
    ? null
    : Date.parse(expectedContract.finished_at);
  if (finishedAt !== null && Number.isNaN(finishedAt)) {
    throw new ValidationError('visual review run contract finished_at must be a valid timestamp');
  }
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) {
    throw new ValidationError('visual review run contract finished_at must not predate started_at');
  }
  const evidenceNotBefore = expectedContract?.evidence_not_before === undefined
    ? null
    : Date.parse(expectedContract.evidence_not_before);
  if (evidenceNotBefore !== null && Number.isNaN(evidenceNotBefore)) {
    throw new ValidationError('visual review final integration cutoff must be a valid timestamp');
  }
  if (startedAt !== null && reviewedAt < startedAt) {
    throw new ValidationError('visual review reviewed_at must not predate the run start');
  }
  if (evidenceNotBefore !== null && reviewedAt < evidenceNotBefore) {
    throw new ValidationError('visual review reviewed_at must not predate the final integration cutoff');
  }
  if (finishedAt !== null && reviewedAt > finishedAt) {
    throw new ValidationError('visual review reviewed_at must not be later than the run finish');
  }
  for (const [index, result] of data.results.entries()) {
    const capturedAt = Date.parse(result.captured_at);
    if (Number.isNaN(capturedAt)) {
      throw new ValidationError(`visual review results[${index}].captured_at must be a valid timestamp`);
    }
    if (startedAt !== null && capturedAt < startedAt) {
      throw new ValidationError(`visual review results[${index}].captured_at must not predate the run start`);
    }
    if (evidenceNotBefore !== null && capturedAt < evidenceNotBefore) {
      throw new ValidationError(`visual review results[${index}].captured_at must not predate the final integration cutoff`);
    }
    if (finishedAt !== null && capturedAt > finishedAt) {
      throw new ValidationError(`visual review results[${index}].captured_at must not be later than the run finish`);
    }
    if (capturedAt > reviewedAt) {
      throw new ValidationError(`visual review results[${index}].captured_at must not be later than reviewed_at`);
    }
    try {
      const captureUrl = new URL(result.capture_url);
      if (!['http:', 'https:'].includes(captureUrl.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new ValidationError(`visual review results[${index}].capture_url must be an absolute http or https URL`);
    }
  }
  if (data.accessibility.status !== 'not_run' && (!data.accessibility.report_ref || !data.accessibility.report_sha256)) {
    throw new ValidationError('executed visual review accessibility must include report_ref and report_sha256');
  }
  if (data.accessibility.status === 'not_run' && (data.accessibility.report_ref || data.accessibility.report_sha256)) {
    throw new ValidationError('not_run visual review accessibility must not include report evidence');
  }
  if (data.verdict === 'confirm_ui') {
    const failed = data.results.filter((result) => result.status !== 'passed' || result.concerns.length);
    if (failed.length || data.concerns.length) {
      throw new ValidationError('confirm_ui visual review must have only passed results and no concerns');
    }
    if (data.accessibility.status !== 'passed' || data.accessibility.critical_violations !== 0) {
      throw new ValidationError('confirm_ui visual review requires passed accessibility with zero critical violations');
    }
  }
  return data;
}

export function validateVisualReview(filePath, expectedContract = null, options = {}) {
  const data = validateVisualReviewData(loadJson(filePath), expectedContract);
  const expectedName = `${data.run_id}.visual-review.json`;
  if (path.basename(filePath) !== expectedName) {
    throw new ValidationError(`visual review filename must be ${expectedName}`);
  }
  if (expectedContract) {
    validateVisualReviewSourceArtifacts(expectedContract, options);
  }
  if (options.requireEvidenceFiles !== false) {
    let evidenceRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : null;
    if (!evidenceRoot) {
      let current = path.dirname(path.resolve(filePath));
      while (true) {
        if (path.basename(current) === 'runs') {
          evidenceRoot = path.dirname(current);
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    evidenceRoot ??= path.dirname(path.resolve(filePath));
    for (const [index, result] of data.results.entries()) {
      const artifactRef = safeRelativeArtifactPath(
        result.artifact_ref,
        `visual review results[${index}].artifact_ref`,
      );
      requireRunScopedVisualEvidence(
        artifactRef,
        expectedContract,
        `visual review results[${index}].artifact_ref`,
      );
      const artifactPath = path.resolve(evidenceRoot, artifactRef);
      if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) {
        throw new ValidationError(`visual review results[${index}].artifact_ref cannot be resolved: ${JSON.stringify(result.artifact_ref)}`);
      }
      assertFileInsideArtifactRoot(artifactPath, evidenceRoot, `visual review results[${index}].artifact_ref`);
      if (path.extname(artifactPath).toLowerCase() !== '.png' || result.media_type !== 'image/png') {
        throw new ValidationError(`visual review results[${index}] evidence must be a PNG image`);
      }
      if (rawFileSha256(artifactPath) !== result.artifact_sha256) {
        throw new ValidationError(`visual review results[${index}].artifact_sha256 does not match its screenshot`);
      }
      const dimensions = validatedPngDimensions(artifactPath, `visual review results[${index}].artifact_ref`);
      if (dimensions.width !== result.width || dimensions.height !== result.height) {
        throw new ValidationError(`visual review results[${index}] dimensions do not match its screenshot`);
      }
    }
    if (data.accessibility.report_ref) {
      const reportRef = safeRelativeArtifactPath(
        data.accessibility.report_ref,
        'visual review accessibility.report_ref',
      );
      requireRunScopedVisualEvidence(
        reportRef,
        expectedContract,
        'visual review accessibility.report_ref',
      );
      const reportPath = path.resolve(evidenceRoot, reportRef);
      if (!existsSync(reportPath) || !lstatSync(reportPath).isFile()) {
        throw new ValidationError(`visual review accessibility.report_ref cannot be resolved: ${JSON.stringify(data.accessibility.report_ref)}`);
      }
      assertFileInsideArtifactRoot(reportPath, evidenceRoot, 'visual review accessibility.report_ref');
      if (path.extname(reportPath).toLowerCase() !== '.json') {
        throw new ValidationError('visual review accessibility.report_ref must reference a JSON report');
      }
      if (rawFileSha256(reportPath) !== data.accessibility.report_sha256) {
        throw new ValidationError('visual review accessibility.report_sha256 does not match its report');
      }
      let report;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch (error) {
        throw new ValidationError(`visual accessibility report is not valid JSON: ${error.message}`);
      }
      validateAccessibilityReportData(report, {
        standard: data.accessibility.standard,
        pageUrls: [...new Set(data.results.map((result) => result.capture_url))],
        ...(expectedContract?.started_at ? { startedAt: expectedContract.started_at } : {}),
        ...(expectedContract?.evidence_not_before ? { notBefore: expectedContract.evidence_not_before } : {}),
        ...(expectedContract?.finished_at ? { finishedAt: expectedContract.finished_at } : {}),
        reviewedAt: data.reviewed_at,
      });
      const criticalViolations = report.violations.filter((violation) => violation.impact === 'critical').length;
      if (criticalViolations !== data.accessibility.critical_violations) {
        throw new ValidationError('visual review accessibility.critical_violations does not match its report');
      }
    }
  }
  return data;
}

function consumeBaselineValue(counts, value) {
  const remaining = counts.get(value) ?? 0;
  if (remaining <= 0) return false;
  if (remaining === 1) counts.delete(value);
  else counts.set(value, remaining - 1);
  return true;
}

export function iterationAcceptanceCriteria(product, baselineProduct = null) {
  const criteria = [];
  for (const [field, values] of [
    ['core_flows', product.core_flows],
    ['success_criteria', product.success_criteria],
  ]) {
    const baselineCounts = new Map();
    for (const value of baselineProduct?.[field] ?? []) {
      baselineCounts.set(value, (baselineCounts.get(value) ?? 0) + 1);
    }
    for (const [index, text] of values.entries()) {
      if (
        typeof text === 'string'
        && text.trim()
        && (!baselineProduct || !consumeBaselineValue(baselineCounts, text))
      ) {
        criteria.push({ ref: `product.${field}[${index}]`, text });
      }
    }
  }
  return criteria;
}

function iterationBaselineProduct(sourceIntakePath, artifactRoot) {
  if (!artifactRoot || !sourceIntakePath) return null;
  const artifactPath = path.resolve(artifactRoot);
  assertFileInsideArtifactRoot(
    sourceIntakePath,
    artifactPath,
    'functional acceptance source intake',
  );
  const intake = loadJson(sourceIntakePath);
  const baselineRef = intake.baseline_context?.spec_ref;
  if (typeof baselineRef !== 'string' || !baselineRef.trim()) return null;
  if (path.isAbsolute(baselineRef)) {
    throw new ValidationError('functional acceptance baseline reference must be artifact-root-relative');
  }
  const baselinePath = path.resolve(artifactPath, baselineRef);
  assertFile(baselinePath, 'functional acceptance baseline');
  assertFileInsideArtifactRoot(
    baselinePath,
    artifactPath,
    'functional acceptance baseline',
  );
  const baseline = loadJson(baselinePath);
  const baselineProduct = baseline.schema_version === 'p2a.spec.v1'
    ? baseline.product
    : baseline.schema_version === 'p2a.current_spec.v1'
      ? baseline.effective_product
      : null;
  if (!baselineProduct || typeof baselineProduct !== 'object' || Array.isArray(baselineProduct)) {
    throw new ValidationError(
      'functional acceptance baseline must provide product or effective_product',
    );
  }
  for (const field of ['core_flows', 'success_criteria']) {
    if (!Array.isArray(baselineProduct[field])) {
      throw new ValidationError(`functional acceptance baseline product.${field} must be an array`);
    }
  }
  return baselineProduct;
}

function acceptanceReviewContracts(specPath, artifactRoot = null, options = {}) {
  const specReference = loadJson(specPath);
  const sourceIntakePath = resolveSpecSourceIntake(specPath, specReference);
  const spec = validateSpec(specPath, sourceIntakePath, {
    artifactRoot,
    validationSession: options.validationSession,
  });
  const full = { required: true, criteria: iterationAcceptanceCriteria(spec.product) };
  if (!full.criteria.length) {
    throw new ValidationError('functional acceptance requires at least one product core flow or success criterion');
  }
  const baselineProduct = iterationBaselineProduct(sourceIntakePath, artifactRoot);
  if (!baselineProduct) return { current: full, full };
  const current = {
    required: true,
    criteria: iterationAcceptanceCriteria(spec.product, baselineProduct),
  };
  return { current, full };
}

export function acceptanceReviewContract(specPath, artifactRoot = null, options = {}) {
  const contracts = acceptanceReviewContracts(specPath, artifactRoot, options);
  const contract = options.scope === 'full' ? contracts.full : contracts.current;
  if (!contract.criteria.length && options.allowEmpty !== true) {
    throw new ValidationError(
      'functional acceptance requires at least one current-iteration core flow or success criterion not already present in the baseline',
    );
  }
  return contract;
}

export function currentDevelopmentAcceptanceReviewContract(
  currentDevelopmentContract,
  artifactRoot,
  options = {},
) {
  const contracts = currentIterationAcceptanceReviewContracts(
    { contract: currentDevelopmentContract },
    artifactRoot,
    options,
  );
  const contract = options.scope === 'full' ? contracts.full : contracts.current;
  if (!contract.criteria.length && options.allowEmpty !== true) {
    throw new ValidationError(
      'functional acceptance requires at least one current-iteration core flow or success criterion not already present in the baseline',
    );
  }
  return contract;
}

export function validateAcceptanceReviewData(data, expectedContract = null) {
  validateSchema(data, loadJson(SCHEMA_PATHS.acceptance_review));
  const criterionRefs = data.cases.map((item) => item.criterion_ref);
  if (criterionRefs.length !== new Set(criterionRefs).size) {
    throw new ValidationError('acceptance review criterion_ref values must be unique');
  }
  if (expectedContract) {
    for (const field of ['iteration_id', 'source_spec_ref']) {
      if (expectedContract[field] !== undefined && data[field] !== expectedContract[field]) {
        throw new ValidationError(`acceptance review ${field} must be ${JSON.stringify(expectedContract[field])}, got ${JSON.stringify(data[field])}`);
      }
    }
    const expectedRefs = (expectedContract.criteria ?? []).map((criterion) => criterion.ref);
    requireSameSet(criterionRefs, expectedRefs, 'acceptance review criterion_ref values');
    const verification = expectedContract.verification ?? [];
    for (const [index, item] of data.cases.entries()) {
      const matchingEvidence = verification.find((entry) => (
        entry.command === item.command
        && entry.source === item.source
        && entry.exitCode === item.exitCode
        && (entry.stdoutTail ?? '') === item.stdoutTail
        && entry.startedAt !== null
        && entry.finishedAt !== null
      ));
      if (!matchingEvidence) {
        throw new ValidationError(
          `acceptance review cases[${index}] must match an actually executed run verification command, source, exitCode, and stdoutTail`,
        );
      }
      if (item.verdict === 'pass' && matchingEvidence.status !== 'passed') {
        throw new ValidationError(
          `acceptance review cases[${index}] cannot pass verification with status ${matchingEvidence.status}`,
        );
      }
    }
  }
  if (data.verdict === 'confirm_behavior') {
    if (data.unmet.length || data.cases.some((item) => item.verdict !== 'pass' || item.exitCode !== 0)) {
      throw new ValidationError('confirm_behavior acceptance review requires every case to pass with exitCode 0 and no unmet criteria');
    }
  } else if (!data.unmet.length && data.cases.every((item) => item.verdict === 'pass')) {
    throw new ValidationError('blocked acceptance review must identify an unmet criterion or failed case');
  }
  return data;
}

export function validateAcceptanceReview(filePath, expectedContract = null) {
  const data = validateAcceptanceReviewData(loadJson(filePath), expectedContract);
  if (expectedContract?.run_id) {
    const expectedName = `${expectedContract.run_id}.acceptance-review.json`;
    if (path.basename(filePath) !== expectedName) {
      throw new ValidationError(`acceptance review filename must be ${expectedName}`);
    }
  }
  return data;
}

function validateSpecVisualExperience(spec, specPath, artifactRoot = null) {
  const visual = spec.visual_experience;
  if (!visual) return null;
  const hasExperienceRef = Boolean(visual.experience_spec_ref);
  const hasExperienceHash = Boolean(visual.experience_spec_sha256);
  if (hasExperienceRef !== hasExperienceHash) {
    throw new ValidationError('visual_experience experience_spec_ref and experience_spec_sha256 must be provided together');
  }
  if (!visual.has_visual_interface && hasExperienceHash) {
    throw new ValidationError('non-visual specs must not include an experience spec hash');
  }
  if (visual.has_visual_interface && spec.product.screens_or_interfaces.length === 0) {
    throw new ValidationError('visual_experience.has_visual_interface true requires product.screens_or_interfaces');
  }
  const supportsExperienceArtifact = (
    visual.has_visual_interface
    && ['full', 'reuse'].includes(visual.design_scope)
    && visual.design_timing === 'current_iteration'
  );
  if (hasExperienceRef && !supportsExperienceArtifact) {
    throw new ValidationError(
      'visual_experience experience_spec_ref is only allowed for full or reuse current_iteration visual experience',
    );
  }
  const requiresApprovedExperience = (
    supportsExperienceArtifact
    && hasExperienceRef
    && spec.approval === 'approved'
  );
  if (!requiresApprovedExperience) return null;
  const experiencePath = requireVisualReference(
    visual.experience_spec_ref,
    specPath,
    artifactRoot,
    'spec.visual_experience.experience_spec_ref',
  );
  const experience = validateVisualExperience(experiencePath, {
    artifactRoot,
    expected: { project_id: spec.project_id, mode: visual.design_scope },
  });
  if (visual.design_scope === 'reuse') {
    requireSubset(
      visual.design_system_refs,
      experience.design_system.references,
      'spec.visual_experience.design_system_refs',
    );
  }
  if (rawFileSha256(experiencePath) !== visual.experience_spec_sha256) {
    throw new ValidationError('spec.visual_experience.experience_spec_sha256 does not match the visual experience artifact');
  }
  if (experience.approval !== 'approved') {
    throw new ValidationError('approved full visual scope requires an approved visual experience');
  }
  if (!referenceMatchesVisualFile(experience.source_spec_ref, experiencePath, specPath, artifactRoot)) {
    throw new ValidationError('visual experience source_spec_ref must reference its source spec');
  }
  if (!spec.approval_audit.approved_artifacts.some((reference) => (
    referenceMatchesVisualFile(reference, specPath, experiencePath, artifactRoot)
  ))) {
    throw new ValidationError('spec.approval_audit.approved_artifacts must include the approved visual experience');
  }
  return { experience, experiencePath };
}

export function approvedVisualReviewContract(specPath, artifactRoot = null, options = {}) {
  const specReference = loadJson(specPath);
  const sourceIntakePath = resolveSpecSourceIntake(specPath, specReference);
  const spec = validateSpec(specPath, sourceIntakePath, {
    artifactRoot,
    validationSession: options.validationSession,
  });
  const approvedVisual = validateSpecVisualExperience(spec, specPath, artifactRoot);
  if (!approvedVisual?.experience.validation.visual_review_required) return null;
  const { experience } = approvedVisual;
  const selected = experience.visual_direction.candidates.find(
    (candidate) => candidate.id === experience.visual_direction.selected_candidate,
  );
  if (!selected) {
    throw new ValidationError('approved visual review contract requires a selected prototype');
  }
  return {
    required: true,
    experienceSpecRef: spec.visual_experience.experience_spec_ref,
    experienceSpecSha256: spec.visual_experience.experience_spec_sha256,
    prototypeManifestRef: selected.prototype_manifest_ref,
    prototypeManifestSha256: selected.prototype_manifest_sha256,
    screenStates: experience.screens.map((screen) => ({
      screenId: screen.id,
      states: structuredClone(screen.states),
    })),
    viewports: structuredClone(experience.validation.viewports),
    accessibilityStandard: experience.validation.accessibility_standard,
  };
}

function nonBlankUniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function iterationConstraintsFromSpec(spec) {
  return {
    architecture: nonBlankUniqueStrings(spec.implementation.architecture),
    interfaces: nonBlankUniqueStrings(spec.implementation.interfaces),
    dependencies: nonBlankUniqueStrings(spec.implementation.dependencies),
  };
}

export function executionEnvelopeSha256(envelope) {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function validateExecutionEnvelopeData(envelope) {
  validateSchema(envelope, loadJson(SCHEMA_PATHS.run).properties.executionEnvelope);
  const visualContract = envelope.visualContract;
  if (!visualContract) return envelope;
  const extendedFields = [
    'prototypeManifestRef',
    'prototypeManifestSha256',
    'screens',
    'viewports',
    'accessibilityStandard',
    'visualInvariants',
  ];
  const presentExtendedFields = extendedFields.filter((field) => visualContract[field] !== undefined);
  if (presentExtendedFields.length > 0 && presentExtendedFields.length !== extendedFields.length) {
    throw new ValidationError(
      `executionEnvelope.visualContract extended fields must be recorded together: ${extendedFields.join(', ')}`,
    );
  }
  return envelope;
}

export function resolveRunExecutionEnvelope(runData, runsDir) {
  if (runData.executionEnvelope !== undefined && runData.executionEnvelopeRef !== undefined) {
    throw new ValidationError(
      `run ${runData.runId} must record either executionEnvelope or executionEnvelopeRef, not both`,
    );
  }
  if (runData.executionEnvelope !== undefined) {
    if (executionEnvelopeSha256(runData.executionEnvelope) !== runData.executionEnvelopeSha256) {
      throw new ValidationError(`run ${runData.runId} executionEnvelopeSha256 does not match executionEnvelope`);
    }
    return validateExecutionEnvelopeData(runData.executionEnvelope);
  }
  if (runData.executionEnvelopeRef === undefined) return null;
  let envelopeRef;
  try {
    envelopeRef = executionEnvelopeStoreRef(runData, runData.executionEnvelopeRef.sha256);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
  let envelopePath;
  try {
    envelopePath = safeRunStoreFilePath(
      runsDir,
      envelopeRef,
      `run ${runData.runId} executionEnvelopeRef`,
    );
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
  if (!existsSync(envelopePath)) {
    throw new ValidationError(`run ${runData.runId} execution envelope is missing: ${envelopeRef}`);
  }
  const envelopeStat = lstatSync(envelopePath);
  if (!envelopeStat.isFile() || envelopeStat.isSymbolicLink()) {
    throw new ValidationError(`run ${runData.runId} execution envelope must be a regular non-symbolic-link file: ${envelopeRef}`);
  }
  const envelope = loadJson(envelopePath);
  const actualSha256 = executionEnvelopeSha256(envelope);
  if (
    actualSha256 !== runData.executionEnvelopeRef.sha256
    || actualSha256 !== runData.executionEnvelopeSha256
  ) {
    throw new ValidationError(`run ${runData.runId} execution envelope content hash does not match executionEnvelopeRef`);
  }
  return validateExecutionEnvelopeData(envelope);
}

export function approvedExecutionEnvelope(specPath, sourceSpecRef, artifactRoot = null, options = {}) {
  const specReference = loadJson(specPath);
  const sourceIntakePath = resolveSpecSourceIntake(specPath, specReference);
  const spec = validateSpec(specPath, sourceIntakePath, {
    artifactRoot,
    validationSession: options.validationSession,
  });
  if (spec.approval !== 'approved') {
    throw new ValidationError('execution envelope requires an approved Gate B specification');
  }
  const approvedVisual = validateSpecVisualExperience(spec, specPath, artifactRoot);
  const acceptance = nonBlankUniqueStrings([
    ...spec.product.core_flows,
    ...spec.product.success_criteria,
  ]);
  const verification = nonBlankUniqueStrings(spec.implementation.verification);
  if (!acceptance.length || !verification.length) {
    throw new ValidationError('execution envelope requires non-empty Gate B acceptance and verification');
  }
  return {
    objective: spec.product.problem.trim(),
    sourceGateRefs: [{
      path: sourceSpecRef,
      sha256: rawFileSha256(specPath),
    }],
    scope: nonBlankUniqueStrings(spec.product.goals),
    iterationConstraints: iterationConstraintsFromSpec(spec),
    mustPreserve: nonBlankUniqueStrings(spec.product.must_preserve),
    nonGoals: nonBlankUniqueStrings(spec.product.non_goals),
    acceptance,
    verification,
    executionAuthority: {
      mayChoose: [
        'internal work breakdown and order',
        'files and code structure within the approved scope',
        'implementation corrections required to pass approved verification',
      ],
      mustReturnToGate: [
        'product meaning or acceptance change',
        'approved scope expansion',
        'project constitution change',
        'new external write, cost, credential, or irreversible action',
      ],
    },
    ...(approvedVisual?.experience.validation.visual_review_required ? {
      visualContract: (() => {
        const { experience } = approvedVisual;
        const selected = experience.visual_direction.candidates.find(
          (candidate) => candidate.id === experience.visual_direction.selected_candidate,
        );
        if (!selected) {
          throw new ValidationError('execution envelope visual contract requires a selected prototype');
        }
        return {
          experienceSpecRef: spec.visual_experience.experience_spec_ref,
          experienceSpecSha256: spec.visual_experience.experience_spec_sha256,
          prototypeManifestRef: selected.prototype_manifest_ref,
          prototypeManifestSha256: selected.prototype_manifest_sha256,
          screens: experience.screens.map((screen) => ({
            screenId: screen.id,
            route: screen.route,
            entryPoints: structuredClone(screen.entry_points),
            states: structuredClone(screen.states),
            responsiveRules: structuredClone(screen.responsive_rules),
            accessibilityRequirements: structuredClone(screen.accessibility_requirements),
          })),
          viewports: structuredClone(experience.validation.viewports),
          accessibilityStandard: experience.validation.accessibility_standard,
          visualInvariants: nonBlankUniqueStrings([
            ...experience.visual_direction.avoid,
            ...experience.design_system.token_rules,
            ...experience.design_system.component_rules,
          ]),
        };
      })(),
    } : {}),
  };
}

function validateClarifyingQuestionDisposition(spec, intake = null) {
  const dispositions = spec.clarifying_question_disposition;
  const dispositionIds = dispositions.map((item) => item.id);
  if (dispositionIds.length !== new Set(dispositionIds).size) {
    throw new ValidationError('spec.clarifying_question_disposition id values must be unique');
  }
  const openDecisions = new Set(spec.open_decisions);
  const detailFields = ['resolved_by', 'assumption', 'non_goal', 'promoted_decision_id', 'resolution'];
  const allowedDetailFields = new Map([
    ['answered', new Set(['resolved_by'])],
    ['assumed', new Set(['assumption'])],
    ['deferred_non_goal', new Set(['non_goal'])],
    ['promoted_to_decision', new Set(['promoted_decision_id', 'resolution'])],
  ]);
  const promotedDecisionIds = dispositions
    .filter((item) => item.status === 'promoted_to_decision')
    .map((item) => item.promoted_decision_id);
  if (promotedDecisionIds.length !== new Set(promotedDecisionIds).size) {
    throw new ValidationError('spec.clarifying_question_disposition promoted_decision_id values must be unique');
  }

  for (const item of dispositions) {
    validateNonBlankStrings(item.affects, `${item.id}.affects`);
    const allowedFields = allowedDetailFields.get(item.status);
    const disallowedFields = detailFields.filter((field) => Object.hasOwn(item, field) && !allowedFields.has(field));
    if (disallowedFields.length) {
      throw new ValidationError(`${item.id} disposition status ${item.status} does not allow fields: ${JSON.stringify(disallowedFields)}`);
    }
    if (item.status === 'answered' && !item.resolved_by) {
      throw new ValidationError(`${item.id} disposition status answered requires resolved_by`);
    }
    if (item.status === 'assumed' && !item.assumption) {
      throw new ValidationError(`${item.id} disposition status assumed requires assumption`);
    }
    if (item.status === 'deferred_non_goal' && !item.non_goal) {
      throw new ValidationError(`${item.id} disposition status deferred_non_goal requires non_goal`);
    }
    if (item.status === 'promoted_to_decision') {
      if (!item.promoted_decision_id) {
        throw new ValidationError(`${item.id} disposition status promoted_to_decision requires promoted_decision_id`);
      }
      const isOpen = openDecisions.has(item.promoted_decision_id);
      if (isOpen && item.resolution) {
        throw new ValidationError(`${item.id} promoted decision ${item.promoted_decision_id} has resolution but is still listed in open_decisions`);
      }
      if (!isOpen && !item.resolution) {
        throw new ValidationError(`${item.id} promoted decision ${item.promoted_decision_id} must be in open_decisions until it has a resolution`);
      }
    }
  }

  if (intake) {
    const intakeCqIds = intake.clarifying_questions.map((question) => question.id);
    const intakeCqSet = new Set(intakeCqIds);
    const unknown = dispositionIds.filter((id) => !intakeCqSet.has(id));
    if (unknown.length) {
      throw new ValidationError(`spec.clarifying_question_disposition references unknown intake clarifying questions: ${JSON.stringify(unknown)}`);
    }
    const dispositionSet = new Set(dispositionIds);
    const missing = intakeCqIds.filter((id) => !dispositionSet.has(id));
    if (missing.length) {
      throw new ValidationError(`spec.clarifying_question_disposition is missing intake clarifying questions: ${JSON.stringify(missing)}`);
    }
  }
}

export function validateTaskContextData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.task_context));
  return data;
}

export function validateTaskGraphData(data, requireApprovedSpec = null, options = {}) {
  const schema = loadSchema('task_graph');
  validateSchema(data, schema);
  let approvedSpec = null;
  let approvedVisual = null;
  if (requireApprovedSpec) {
    const specReference = loadValidationJson(requireApprovedSpec, options);
    const sourceIntakePath = requireSpecSourceIntake(requireApprovedSpec, specReference);
    approvedSpec = validateSpec(requireApprovedSpec, sourceIntakePath, {
      ...options,
      projectId: options.projectId ?? data.projectId,
    });
    if (approvedSpec.approval !== 'approved') {
      throw new ValidationError('task graph generation is blocked until spec.approval is approved');
    }
    if (approvedSpec.open_decisions.length) {
      throw new ValidationError('task graph generation is blocked while spec.open_decisions is non-empty');
    }
    approvedVisual = validateSpecVisualExperience(
      approvedSpec,
      requireApprovedSpec,
      inferArtifactRootFromIntakePath(sourceIntakePath),
    );
  }

  const tasks = data.tasks;
  if (data.execution) {
    const { mode, syntheticWorkItem, milestones } = data.execution;
    if ((mode === 'direct' || mode === 'planned') && syntheticWorkItem !== true) {
      throw new ValidationError(`task graph execution mode ${mode} requires syntheticWorkItem true`);
    }
    if (mode === 'orchestrated' && syntheticWorkItem !== false) {
      throw new ValidationError('task graph execution mode orchestrated requires syntheticWorkItem false');
    }
    if ((mode === 'direct' || mode === 'planned') && tasks.length !== 1) {
      throw new ValidationError(`task graph execution mode ${mode} requires exactly one synthetic work item`);
    }
    if (mode === 'planned') {
      if (!Array.isArray(milestones)) {
        throw new ValidationError('task graph execution mode planned requires 2 to 5 milestones');
      }
      const milestoneIds = milestones.map((milestone) => milestone.id);
      if (milestoneIds.length !== new Set(milestoneIds).size) {
        throw new ValidationError('planned execution milestone ids must be unique');
      }
      for (const milestone of milestones) {
        if (!milestone.outcome.trim()) {
          throw new ValidationError(`${milestone.id}.outcome must not be blank`);
        }
        validateNonBlankStrings(milestone.verification, `${milestone.id}.verification`);
      }
    } else if (milestones !== undefined) {
      throw new ValidationError(`task graph execution mode ${mode} must not define milestones`);
    }
  }
  const taskIds = tasks.map((task) => task.id);
  if (taskIds.length !== new Set(taskIds).size) {
    throw new ValidationError('task ids must be unique');
  }
  const taskIdSet = new Set(taskIds);
  const visualReviewEnabled = Boolean(approvedVisual?.experience.validation.visual_review_required);

  const graph = new Map();
  for (const task of tasks) {
    if (typeof task.intent === 'string' && task.intent.trim().length === 0) {
      throw new ValidationError(`${task.id}.intent must not be blank`);
    }
    validateNonBlankStrings(task.acceptanceCriteria, `${task.id}.acceptanceCriteria`);
    validateNonBlankStrings(task.sourceSpecRefs, `${task.id}.sourceSpecRefs`);
    if (typeof task.blockNote === 'string' && task.blockNote.trim().length === 0) {
      throw new ValidationError(`${task.id}.blockNote must not be blank`);
    }
    if (visualReviewEnabled && !task.workKind) {
      throw new ValidationError(`${task.id}.workKind is required when the approved visual experience requires visual review`);
    }
    const hasVisualImpact = visualReviewEnabled && ['ui', 'mixed'].includes(task.workKind);
    if (hasVisualImpact && !task.visualImpact) {
      throw new ValidationError(`${task.id} implements a visual experience and must include visualImpact`);
    }
    if (visualReviewEnabled && task.workKind === 'non_ui' && task.visualImpact) {
      throw new ValidationError(`${task.id} is classified non_ui and must not include visualImpact`);
    }
    if (task.visualImpact && requireApprovedSpec && !visualReviewEnabled) {
      throw new ValidationError(`${task.id}.visualImpact is only allowed when the approved current-iteration visual experience requires review`);
    }
    if (task.visualImpact && visualReviewEnabled) {
      const { experience } = approvedVisual;
      uniqueObjectIds(task.visualImpact.screenStates, 'screenId', `${task.id}.visualImpact.screenStates`);
      const experienceScreens = new Map(experience.screens.map((screen) => [screen.id, screen]));
      for (const screenState of task.visualImpact.screenStates) {
        const screen = experienceScreens.get(screenState.screenId);
        if (!screen) {
          throw new ValidationError(`${task.id}.visualImpact.screenStates contains unknown screen ${JSON.stringify(screenState.screenId)}`);
        }
        requireSubset(
          screenState.states,
          screen.states,
          `${task.id}.visualImpact.screenStates.${screenState.screenId}.states`,
        );
      }
    }
    const unknownDependencies = task.dependencies.filter((dependency) => !taskIdSet.has(dependency));
    if (unknownDependencies.length) {
      throw new ValidationError(`${task.id} has unknown dependencies: ${JSON.stringify(unknownDependencies)}`);
    }
    graph.set(task.id, [...task.dependencies]);
  }

  if (visualReviewEnabled && !tasks.some((task) => task.visualImpact)) {
    throw new ValidationError(
      'task graph must include at least one ui or mixed task with visualImpact for the approved visual experience',
    );
  }

  detectCycles(graph);
  const constitutionContract = resolveConstitutionForArtifact(
    requireApprovedSpec ?? options.artifactPath ?? process.cwd(),
    {
      ...options,
      projectId: options.projectId ?? data.projectId,
    },
  );
  if (constitutionContract.constitution) {
    validateConstitutionProhibitions(
      constitutionContract.constitution,
      data,
      'task_graph',
      'task graph',
    );
  }
  return data;
}

function validateNonBlankStrings(values, label) {
  for (const [index, value] of values.entries()) {
    if (value.trim().length === 0) {
      throw new ValidationError(`${label}[${index}] must not be blank`);
    }
  }
}

export function validateTaskGraph(filePath, requireApprovedSpec = null, options = {}) {
  const specCacheRef = requireApprovedSpec
    ? validationFileIdentity(requireApprovedSpec, options)
    : '';
  const cacheKey = validationSessionKey('task-graph', filePath, options, specCacheRef);
  const cached = cachedValidation(options, cacheKey);
  if (cached) return cached.value;
  recordValidationRun(options, 'task-graph');
  const data = validateTaskGraphData(loadValidationJson(filePath, options), requireApprovedSpec, {
    ...options,
    artifactPath: filePath,
  });
  return cacheValidation(options, cacheKey, data);
}

export function validateReview(filePath, expectedSources = null, options = {}) {
  const data = validateAgainstSchema(filePath, 'review');
  if (expectedSources) {
    for (const [field, expected] of Object.entries(expectedSources)) {
      if (data[field] !== expected) {
        throw new ValidationError(`review.${field} must reference ${JSON.stringify(expected)}, got ${JSON.stringify(data[field])}`);
      }
    }
  }
  if (options.requirePass) validateReviewPassData(data);
  return data;
}

export function validateRunData(data) {
  try {
    validateSchema(data, loadJson(SCHEMA_PATHS.run));
  } catch (error) {
    if (error instanceof ValidationError && data?.status && ['failed', 'blocked'].includes(data.status) && !data.failure) {
      throw new ValidationError(`${data.status} run must include failure with class, retryable, needsUserDecision, and source`);
    }
    if (error instanceof ValidationError && data?.failure && ['started', 'finished'].includes(data.status)) {
      throw new ValidationError(`${data.status} run must not include failure`);
    }
    throw error;
  }
  for (const [index, item] of (data.verification ?? []).entries()) {
    if (item.status === 'unavailable' && (!item.failureReason || !item.failureHint)) {
      throw new ValidationError(`verification[${index}] unavailable status must include failureReason and failureHint`);
    }
    if (item.scope !== undefined) {
      if (item.source !== 'config' && item.source !== 'command') {
        throw new ValidationError(
          `verification[${index}] scoped evidence must use source config or command`,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(item.workspaceRevisionSha256 ?? '')) {
        throw new ValidationError(
          `verification[${index}] executed evidence with scope must include workspaceRevisionSha256`,
        );
      }
    }
    const legacyFinishedUnboundRelated = item.scope === 'related'
      && data.status === 'finished'
      && item.argv === undefined
      && item.selectedFileCount === undefined;
    if (item.scope === 'related' && !legacyFinishedUnboundRelated) {
      if (!Number.isSafeInteger(item.selectedFileCount) || item.selectedFileCount < 1) {
        throw new ValidationError(`verification[${index}] related evidence must include selectedFileCount`);
      }
      if (!Array.isArray(item.argv) || item.argv.length < item.selectedFileCount + 1) {
        throw new ValidationError(
          `verification[${index}] related evidence argv must include the executable and selected files`,
        );
      }
      const selectedFiles = item.argv.slice(-item.selectedFileCount);
      const finalVerificationSelection = data.runKind === 'final_verification'
        && data.changedFiles.length === 0;
      if (
        new Set(selectedFiles).size !== selectedFiles.length
        || (!finalVerificationSelection && selectedFiles.some((file) => !data.changedFiles.includes(file)))
      ) {
        throw new ValidationError(
          `verification[${index}] selected files must be unique${finalVerificationSelection ? '' : ' members of run.changedFiles'}`,
        );
      }
    } else if (item.selectedFileCount !== undefined) {
      throw new ValidationError(
        `verification[${index}] selectedFileCount is only allowed for scope related`,
      );
    }
  }
  for (const [index, sample] of (data.usage ?? []).entries()) {
    if (![sample.inputTokens, sample.outputTokens, sample.totalTokens].every(Number.isSafeInteger)) {
      throw new ValidationError(`usage[${index}] token counts must be safe integers`);
    }
    if (!sample.modelProfile.trim()) {
      throw new ValidationError(`usage[${index}].modelProfile must not be blank`);
    }
    if (sample.totalTokens !== sample.inputTokens + sample.outputTokens) {
      throw new ValidationError(
        `usage[${index}].totalTokens must equal inputTokens + outputTokens`,
      );
    }
  }
  for (const [index, interruption] of (data.interruptions ?? []).entries()) {
    if (!interruption.summary.trim()) {
      throw new ValidationError(`interruptions[${index}].summary must not be blank`);
    }
  }
  const hasMode = data.mode !== undefined;
  const hasSelectionRationale = data.selectionRationale !== undefined;
  if (data.verificationScope !== undefined && data.runKind !== 'final_verification') {
    throw new ValidationError('verificationScope is only allowed for final_verification runs');
  }
  if (hasMode !== hasSelectionRationale) {
    throw new ValidationError('run mode and selectionRationale must be recorded together');
  }
  if (hasSelectionRationale && !data.selectionRationale.trim()) {
    throw new ValidationError('run selectionRationale must not be blank');
  }
  if (data.mode === 'planned' && !data.runKind && !data.milestones) {
    throw new ValidationError('planned implementation run requires milestones');
  }
  if (data.mode !== 'planned' && data.milestones !== undefined) {
    throw new ValidationError('run milestones are only allowed for planned execution');
  }
  if (data.milestones) {
    const milestoneIds = data.milestones.map((milestone) => milestone.id);
    if (milestoneIds.length !== new Set(milestoneIds).size) {
      throw new ValidationError('run milestone ids must be unique');
    }
    let pendingSeen = false;
    for (const milestone of data.milestones) {
      validateNonBlankStrings(milestone.verification, `${milestone.id}.verification`);
      if (!milestone.outcome.trim()) {
        throw new ValidationError(`${milestone.id}.outcome must not be blank`);
      }
      if (milestone.status === 'pending') {
        pendingSeen = true;
        if (milestone.verifiedAt !== null) {
          throw new ValidationError(`${milestone.id}.verifiedAt must be null while pending`);
        }
      } else {
        if (pendingSeen) {
          throw new ValidationError('planned run milestones must be verified in declared order');
        }
        if (typeof milestone.verifiedAt !== 'string' || !milestone.verifiedAt.trim()) {
          throw new ValidationError(`${milestone.id}.verifiedAt is required when verified`);
        }
      }
    }
    const knownMilestones = new Set(milestoneIds);
    for (const [index, verification] of data.verification.entries()) {
      if (verification.milestoneId && !knownMilestones.has(verification.milestoneId)) {
        throw new ValidationError(`verification[${index}].milestoneId references an unknown run milestone`);
      }
    }
    if (data.status === 'finished' && data.milestones.some((milestone) => milestone.status !== 'verified')) {
      throw new ValidationError('finished planned run requires every milestone to be verified');
    }
  } else if (data.verification.some((verification) => verification.milestoneId !== undefined)) {
    throw new ValidationError('verification milestoneId requires planned run milestones');
  }
  if (data.monitorVerdictEvidenceSha256 && !data.monitorGate?.required) {
    throw new ValidationError('monitorVerdictEvidenceSha256 requires monitorGate.required');
  }
  if (data.status === 'started' && data.monitorVerdictEvidenceSha256) {
    throw new ValidationError('started run must not seal monitor verdict evidence');
  }
  if (data.monitorGate?.required && data.status === 'finished' && !data.monitorVerdictEvidenceSha256) {
    throw new ValidationError(`finished run ${data.runId} must include monitorVerdictEvidenceSha256`);
  }
  if (data.monitorGate?.required
    && data.failure?.source === 'monitor'
    && !data.monitorVerdictEvidenceSha256) {
    throw new ValidationError(`${data.status} run ${data.runId} with monitor failure must include monitorVerdictEvidenceSha256`);
  }
  const hasInlineExecutionEnvelope = data.executionEnvelope !== undefined;
  const hasReferencedExecutionEnvelope = data.executionEnvelopeRef !== undefined;
  const hasExecutionEnvelope = hasInlineExecutionEnvelope || hasReferencedExecutionEnvelope;
  if (hasInlineExecutionEnvelope && hasReferencedExecutionEnvelope) {
    throw new ValidationError('run must record either executionEnvelope or executionEnvelopeRef, not both');
  }
  if (hasExecutionEnvelope !== (data.executionEnvelopeSha256 !== undefined)) {
    throw new ValidationError('executionEnvelope or executionEnvelopeRef and executionEnvelopeSha256 must be recorded together');
  }
  if (hasMode && data.sourceLayout !== 'maintenance' && !hasExecutionEnvelope) {
    throw new ValidationError('non-maintenance run mode requires a Gate B executionEnvelope reference and executionEnvelopeSha256');
  }
  if (data.sourceLayout === 'maintenance' && hasExecutionEnvelope) {
    throw new ValidationError('maintenance run must not record a Gate B executionEnvelope or executionEnvelopeRef');
  }
  if (hasReferencedExecutionEnvelope
    && data.executionEnvelopeRef.sha256 !== data.executionEnvelopeSha256) {
    throw new ValidationError('executionEnvelopeRef.sha256 must match executionEnvelopeSha256');
  }
  if (data.executionEnvelope !== undefined
    && data.executionEnvelopeSha256 !== executionEnvelopeSha256(data.executionEnvelope)) {
    throw new ValidationError('executionEnvelopeSha256 does not match executionEnvelope');
  }
  if (data.executionEnvelope !== undefined) validateExecutionEnvelopeData(data.executionEnvelope);
  if (
    (data.currentDevelopmentContractRef !== undefined)
    !== (data.currentDevelopmentContractSha256 !== undefined)
  ) {
    throw new ValidationError(
      'currentDevelopmentContractRef and currentDevelopmentContractSha256 must be recorded together',
    );
  }
  if (data.status === 'started' && data.finishedAt !== null) {
    throw new ValidationError('started run must have finishedAt null');
  }
  if (data.status !== 'started' && data.finishedAt === null) {
    throw new ValidationError(`${data.status} run must include finishedAt`);
  }
  const missingStructured = missingRequiredFailureDetails(data);
  if (missingStructured.length) {
    throw new ValidationError(
      `${data.status} run failure detail missing required keys: ${missingStructured.join(', ')}`,
    );
  }
  return data;
}

export function validateRun(filePath) {
  const data = validateRunData(loadJson(filePath));
  const expectedName = `${data.runId}.json`;
  if (path.basename(filePath) !== expectedName) {
    throw new ValidationError(`run filename must be ${expectedName}`);
  }
  return data;
}

export function validateRunIndexData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.run_index));
  const runIds = data.runs.map((run) => run.runId);
  if (runIds.length !== new Set(runIds).size) {
    throw new ValidationError('run-index runs[].runId values must be unique');
  }
  const indexedTaskIds = data.tasks.map((task) => task.taskId);
  if (indexedTaskIds.length !== new Set(indexedTaskIds).size) {
    throw new ValidationError('run-index tasks[].taskId values must be unique');
  }
  const runIdSet = new Set(runIds);
  const runIdsByTask = new Map();
  for (const run of data.runs) {
    if (!isSupportedRunRef(run)) {
      throw new ValidationError(
        `run-index ${run.runId}.runRef must be ${legacyRunRef(run.runId)} or ${canonicalRunRef(run)}`,
      );
    }
    const taskRunIds = runIdsByTask.get(run.taskId) ?? [];
    taskRunIds.push(run.runId);
    runIdsByTask.set(run.taskId, taskRunIds);
  }
  for (const task of data.tasks) {
    const missing = task.runIds.filter((runId) => !runIdSet.has(runId));
    if (missing.length) throw new ValidationError(`${task.taskId} references unknown run ids: ${JSON.stringify(missing)}`);
    if (task.latestRunId !== null && !runIdSet.has(task.latestRunId)) {
      throw new ValidationError(`${task.taskId} latestRunId is unknown: ${task.latestRunId}`);
    }
    const indexedRuns = runIdsByTask.get(task.taskId) ?? [];
    if (JSON.stringify(indexedRuns) !== JSON.stringify(task.runIds)) {
      throw new ValidationError(`${task.taskId} runIds must match runs[] order`);
    }
    const expectedLatestRunId = task.runIds.at(-1) ?? null;
    if (task.latestRunId !== expectedLatestRunId) {
      throw new ValidationError(`${task.taskId} latestRunId must be the last runIds entry: ${expectedLatestRunId ?? 'null'}`);
    }
  }
  const taskIdSet = new Set(indexedTaskIds);
  const missingTasks = [...runIdsByTask.keys()].filter((taskId) => !taskIdSet.has(taskId));
  if (missingTasks.length) {
    throw new ValidationError(`run-index tasks[] is missing task ids: ${JSON.stringify([...new Set(missingTasks)])}`);
  }
  return data;
}

export function validateRunIndex(filePath) {
  return validateRunIndexData(loadJson(filePath));
}

function assertUniqueStrings(values, label) {
  if (values.length !== new Set(values).size) {
    throw new ValidationError(`${label} values must be unique`);
  }
}

function rawFileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function deterministicSnapshotSha256(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function milestoneSnapshotSha256(taskGraph) {
  return deterministicSnapshotSha256(taskGraph);
}

export function milestoneRunSnapshotSha256(run) {
  return deterministicSnapshotSha256(run);
}

function parsedTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new ValidationError(`${label} must be a valid timestamp`);
  return timestamp;
}

export function validateMilestoneReviewData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.milestone_review));

  const graphSnapshot = validateTaskGraphData(data.source.task_graph_snapshot);
  if (graphSnapshot.projectId !== data.project_id) {
    throw new ValidationError(`milestone review task_graph_snapshot.projectId must match project_id ${JSON.stringify(data.project_id)}`);
  }
  const snapshotSha256 = milestoneSnapshotSha256(graphSnapshot);
  if (snapshotSha256 !== data.source.task_graph_snapshot_sha256) {
    throw new ValidationError(`milestone review task_graph_snapshot_sha256 mismatch: expected ${snapshotSha256}`);
  }
  parsedTimestamp(data.generated_at, 'milestone review generated_at');

  const counts = data.source.task_counts;
  const accountedTotal = counts.done + counts.todo + counts.in_progress + counts.blocked;
  if (accountedTotal !== counts.total) {
    throw new ValidationError(`milestone review task_counts must sum to total ${counts.total}, got ${accountedTotal}`);
  }

  const taskSnapshotIds = data.source.task_snapshot.map((item) => item.task_id);
  assertUniqueStrings(taskSnapshotIds, 'milestone review task snapshot ids');
  if (taskSnapshotIds.length !== counts.total) {
    throw new ValidationError(`milestone review task_snapshot must contain ${counts.total} task(s)`);
  }
  for (const status of ['done', 'todo', 'in_progress', 'blocked']) {
    const snapshotCount = data.source.task_snapshot.filter((item) => item.status === status).length;
    if (snapshotCount !== counts[status]) {
      throw new ValidationError(`milestone review task_snapshot ${status} count must be ${counts[status]}, got ${snapshotCount}`);
    }
  }
  if (graphSnapshot.tasks.length !== data.source.task_snapshot.length) {
    throw new ValidationError('milestone review task_snapshot must cover every task in task_graph_snapshot');
  }
  for (const item of data.source.task_snapshot) {
    const graphTask = graphSnapshot.tasks.find((task) => task.id === item.task_id);
    if (!graphTask || graphTask.title !== item.task_title || graphTask.status !== item.status) {
      throw new ValidationError(`${item.task_id} task_snapshot must match task_graph_snapshot id/title/status`);
    }
  }

  const completedTaskEvidence = data.source.completed_task_evidence.map((item) => ({
    item,
    runSnapshot: validateRunData(item.run_snapshot),
  }));
  const completedTaskIds = completedTaskEvidence.map(({ runSnapshot }) => runSnapshot.taskId);
  const remainingTaskIds = data.source.remaining_task_ids;
  assertUniqueStrings(completedTaskIds, 'milestone review completed task ids');
  assertUniqueStrings(remainingTaskIds, 'milestone review remaining task ids');
  if (completedTaskIds.length !== counts.done) {
    throw new ValidationError(`milestone review completed_task_evidence must contain ${counts.done} done task(s)`);
  }
  if (remainingTaskIds.length !== counts.total - counts.done) {
    throw new ValidationError(`milestone review remaining_task_ids must contain ${counts.total - counts.done} task(s)`);
  }
  const completedTaskIdSet = new Set(completedTaskIds);
  const remainingTaskIdSet = new Set(remainingTaskIds);
  const overlap = completedTaskIds.filter((taskId) => remainingTaskIdSet.has(taskId));
  if (overlap.length) {
    throw new ValidationError(`milestone review completed and remaining task ids overlap: ${JSON.stringify(overlap)}`);
  }
  const snapshotDoneIds = new Set(data.source.task_snapshot.filter((item) => item.status === 'done').map((item) => item.task_id));
  const snapshotRemainingIds = new Set(data.source.task_snapshot.filter((item) => item.status !== 'done').map((item) => item.task_id));
  const completedMismatch = completedTaskIds.filter((taskId) => !snapshotDoneIds.has(taskId));
  const remainingMismatch = remainingTaskIds.filter((taskId) => !snapshotRemainingIds.has(taskId));
  if (completedMismatch.length || completedTaskIds.some((taskId) => !taskSnapshotIds.includes(taskId))) {
    throw new ValidationError(`milestone review completed_task_evidence must match done tasks in task_snapshot: ${JSON.stringify(completedMismatch)}`);
  }
  if (remainingMismatch.length || remainingTaskIds.some((taskId) => !taskSnapshotIds.includes(taskId))) {
    throw new ValidationError(`milestone review remaining_task_ids must match non-done tasks in task_snapshot: ${JSON.stringify(remainingMismatch)}`);
  }

  for (const { item, runSnapshot } of completedTaskEvidence) {
    const taskId = runSnapshot.taskId;
    parsedTimestamp(runSnapshot.finishedAt, `${taskId}.run_snapshot.finishedAt`);
    const snapshotTask = data.source.task_snapshot.find((task) => task.task_id === taskId);
    if (snapshotTask.task_title !== runSnapshot.taskTitle) {
      throw new ValidationError(`${taskId}.run_snapshot.taskTitle must match task_snapshot`);
    }
    const runSnapshotSha256 = milestoneRunSnapshotSha256(runSnapshot);
    if (runSnapshotSha256 !== item.run_snapshot_sha256) {
      throw new ValidationError(`${taskId}.run_snapshot_sha256 mismatch: expected ${runSnapshotSha256}`);
    }
    const snapshotFields = {
      runId: item.run_id,
      taskId: item.task_id,
      taskTitle: item.task_title,
      finishedAt: item.run_finished_at,
    };
    for (const [field, expected] of Object.entries(snapshotFields)) {
      if (expected !== undefined && runSnapshot[field] !== expected) {
        throw new ValidationError(`${taskId}.run_snapshot ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(runSnapshot[field])}`);
      }
    }
    if (runSnapshot.status !== 'finished') {
      throw new ValidationError(`${taskId}.run_snapshot status must be "finished", got ${JSON.stringify(runSnapshot.status)}`);
    }
    if (item.workspace_ref !== undefined && runSnapshot.workspaceRef !== item.workspace_ref) {
      throw new ValidationError(`${taskId}.workspace_ref must exactly match run_snapshot.workspaceRef`);
    }
    if (item.changed_files !== undefined && !sameJson(runSnapshot.changedFiles, item.changed_files)) {
      throw new ValidationError(`${taskId}.changed_files must exactly match run_snapshot`);
    }
    const verification = normalizedRunVerification(runSnapshot);
    if (item.verification !== undefined && !sameJson(verification, item.verification)) {
      throw new ValidationError(`${taskId}.verification must exactly match run_snapshot`);
    }
    const hasExecutedPass = verification.some((entry) => entry.status === 'passed'
      && entry.exit_code === 0
      && ['config', 'command'].includes(entry.source));
    if (!hasExecutedPass) {
      throw new ValidationError(`${taskId}.run_snapshot verification must include an executed config/command check that passed with exit_code 0`);
    }
  }

  if (data.checkpoint === 'midpoint') {
    const threshold = Math.ceil(counts.total / 2);
    if (counts.done < threshold || counts.done >= counts.total) {
      throw new ValidationError(`midpoint milestone review requires ${threshold} <= done < ${counts.total}, got ${counts.done}`);
    }
  } else if (counts.done !== counts.total || remainingTaskIds.length !== 0) {
    throw new ValidationError('pre_close milestone review requires every iteration task to be done');
  }

  const findingIds = data.confirmed_findings.map((finding) => finding.finding_id);
  assertUniqueStrings(findingIds, 'milestone review finding ids');
  for (const finding of data.confirmed_findings) {
    assertUniqueStrings(finding.affected_completed_tasks, `${finding.finding_id}.affected_completed_tasks`);
    const nonCompleted = finding.affected_completed_tasks.filter((taskId) => !completedTaskIdSet.has(taskId));
    if (nonCompleted.length) {
      throw new ValidationError(`${finding.finding_id}.affected_completed_tasks must reference completed task evidence: ${JSON.stringify(nonCompleted)}`);
    }
  }
  for (const [index, item] of data.planned_todo_not_findings.entries()) {
    assertUniqueStrings(item.covered_by_remaining_tasks, `planned_todo_not_findings[${index}].covered_by_remaining_tasks`);
    const nonRemaining = item.covered_by_remaining_tasks.filter((taskId) => !remainingTaskIdSet.has(taskId));
    if (nonRemaining.length) {
      throw new ValidationError(`planned_todo_not_findings[${index}] must reference remaining tasks: ${JSON.stringify(nonRemaining)}`);
    }
  }
  return data;
}

function normalizedArtifactRef(reference, label) {
  if (typeof reference !== 'string' || !reference) throw new ValidationError(`${label} must be a non-empty artifact-root-relative path`);
  if (reference.includes('\\') || path.posix.isAbsolute(reference) || path.posix.normalize(reference) !== reference) {
    throw new ValidationError(`${label} must be a normalized artifact-root-relative path`);
  }
  if (reference === '..' || reference.startsWith('../') || reference.includes('/../')) {
    throw new ValidationError(`${label} must not traverse outside the artifact root`);
  }
  return reference;
}

function resolveMilestoneSourceFile(artifactRoot, reference, label) {
  const normalized = normalizedArtifactRef(reference, label);
  const resolved = path.resolve(artifactRoot, normalized);
  const relative = path.relative(artifactRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError(`${label} must resolve to a file inside the artifact root`);
  }
  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new ValidationError(`${label} does not resolve to a file: ${normalized}`);
  }
  const realArtifactRoot = realpathSync(artifactRoot);
  const realResolved = realpathSync(resolved);
  const realRelative = path.relative(realArtifactRoot, realResolved);
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new ValidationError(`${label} resolves outside the artifact root through a symbolic link`);
  }
  return resolved;
}

function milestoneFilenameKind(filename, checkpoint) {
  if (filename === `${checkpoint}.json`) return 'canonical';
  if (filename === `${checkpoint}.draft.json`) return 'draft';
  const escapedCheckpoint = checkpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uniqueDraftPattern = new RegExp(`^${escapedCheckpoint}\\.[A-Za-z0-9][A-Za-z0-9._-]*\\.draft\\.json$`);
  if (uniqueDraftPattern.test(filename)) return 'draft';
  throw new ValidationError(
    `milestone review checkpoint ${checkpoint} must use ${checkpoint}.json, ${checkpoint}.draft.json, or ${checkpoint}.<unique>.draft.json; got ${filename}`,
  );
}

function milestonePathContext(filePath, data, options) {
  const absolutePath = path.resolve(filePath);
  const milestoneDir = path.dirname(absolutePath);
  const iterationRoot = path.dirname(milestoneDir);
  const iterationsRoot = path.dirname(iterationRoot);
  const inferredArtifactRoot = path.dirname(iterationsRoot);
  const artifactRoot = path.resolve(options.artifactRoot ?? inferredArtifactRoot);
  const expectedMilestoneDir = path.join(artifactRoot, 'iterations', data.iteration_id, 'milestone-reviews');
  if (path.resolve(milestoneDir) !== path.resolve(expectedMilestoneDir)) {
    throw new ValidationError(`milestone review must be a direct file under iterations/${data.iteration_id}/milestone-reviews`);
  }
  if (options.expectedProjectId && data.project_id !== options.expectedProjectId) {
    throw new ValidationError(`milestone review project_id must be ${JSON.stringify(options.expectedProjectId)}`);
  }
  if (options.expectedIterationId && data.iteration_id !== options.expectedIterationId) {
    throw new ValidationError(`milestone review iteration_id must be ${JSON.stringify(options.expectedIterationId)}`);
  }
  return {
    artifactRoot,
    kind: milestoneFilenameKind(path.basename(absolutePath), data.checkpoint),
  };
}

function graphWithoutMutableTaskState(graph) {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const { status, blockReason, blockNote, ...stableTask } = task;
      return stableTask;
    }),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedRunVerification(run) {
  return run.verification.map((item) => ({
    type: item.type,
    command: item.command,
    status: item.status,
    exit_code: item.exitCode,
    source: item.source,
  }));
}

const MILESTONE_IMMUTABLE_RUN_FIELDS = [
  'schema_version',
  'runId',
  'projectId',
  'taskId',
  'taskTitle',
  'iterationId',
  'sourceLayout',
  'taskGraphRef',
  'sourceSpecRef',
  'runKind',
  'taskContractSha256',
  'currentDevelopmentContractRef',
  'currentDevelopmentContractSha256',
  'agentTool',
  'workspaceRef',
  'workspacePath',
  'workspaceRevisionSha256',
  'productRevisionSha256',
  'visualReviewEvidenceSha256',
  'visualReview',
  'acceptanceReviewEvidenceSha256',
  'acceptanceReview',
  'monitorGate',
  'monitorVerdictEvidenceSha256',
  'isolation',
  'status',
  'startedAt',
  'finishedAt',
];

function latestSuccessfulRunEntry(runIndex, taskId, data, generatedAt, graphPath, artifactRoot) {
  const candidates = runIndex.runs
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.taskId === taskId
      && entry.status === 'finished'
      && entry.iterationId === data.iteration_id
      && taskGraphRefMatchesGraph(entry.taskGraphRef, graphPath, artifactRoot)
      && parsedTimestamp(entry.finishedAt, `${entry.runId}.finishedAt`) <= generatedAt)
    .sort((left, right) => {
      const timeDifference = Date.parse(right.entry.finishedAt) - Date.parse(left.entry.finishedAt);
      return timeDifference || right.index - left.index;
    });
  for (const candidate of candidates) {
    const runPath = resolveMilestoneSourceFile(
      artifactRoot,
      artifactRunRef(candidate.entry.runRef),
      `${candidate.entry.runId}.runRef`,
    );
    const run = validateRun(runPath);
    if (run.sourceLayout === 'iteration') return { ...candidate, run, runPath };
  }
  return null;
}

function validateMilestoneRunEvidence(data, artifactRoot, kind, graphPath) {
  const runIndexPath = resolveMilestoneSourceFile(artifactRoot, 'runs/run-index.json', 'milestone review run-index');
  const runIndex = validateRunIndex(runIndexPath);
  if (runIndex.projectId !== data.project_id) {
    throw new ValidationError(`milestone review run-index projectId must match project_id ${JSON.stringify(data.project_id)}`);
  }
  const generatedAt = parsedTimestamp(data.generated_at, 'milestone review generated_at');

  for (const evidence of data.source.completed_task_evidence) {
    const runSnapshot = evidence.run_snapshot;
    const taskId = runSnapshot.taskId;
    const runId = runSnapshot.runId;
    const latest = latestSuccessfulRunEntry(runIndex, taskId, data, generatedAt, graphPath, artifactRoot);
    if (!latest) {
      throw new ValidationError(`${taskId} has no successful finished run in the milestone task-graph context at generated_at`);
    }
    if (latest.entry.runId !== runId) {
      throw new ValidationError(`${taskId}.run_snapshot.runId must reference latest successful finished run ${latest.entry.runId}`);
    }
    const expectedRunRef = artifactRunRef(latest.entry.runRef);
    const legacyEvidenceRef = `runs/${legacyRunRef(runId)}`;
    if (![expectedRunRef, legacyEvidenceRef].includes(evidence.run_ref)
      || (kind === 'draft' && evidence.run_ref !== expectedRunRef)) {
      throw new ValidationError(`${taskId}.run_ref must be ${expectedRunRef}`);
    }
    const runPath = latest.runPath;
    const run = latest.run;
    const expectedFields = {
      projectId: data.project_id,
      iterationId: data.iteration_id,
      sourceLayout: 'iteration',
      taskGraphRef: data.source.task_graph_ref,
      sourceSpecRef: data.source.task_graph_snapshot.sourceSpec,
      status: 'finished',
    };
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (runSnapshot[field] !== expected) {
        throw new ValidationError(`${taskId} run_snapshot ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(runSnapshot[field])}`);
      }
    }
    if (parsedTimestamp(runSnapshot.finishedAt, `${runSnapshot.runId}.finishedAt`) > generatedAt) {
      throw new ValidationError(`${taskId} run_snapshot.finishedAt must not be later than milestone generated_at`);
    }

    for (const field of MILESTONE_IMMUTABLE_RUN_FIELDS) {
      if (!sameJson(run[field], runSnapshot[field])) {
        throw new ValidationError(
          `${taskId} run ${field} must match run_snapshot immutable context: expected ${JSON.stringify(runSnapshot[field])}, got ${JSON.stringify(run[field])}`,
        );
      }
    }

    if (kind === 'draft') {
      if (rawFileSha256(runPath) !== evidence.run_sha256) {
        throw new ValidationError(`${taskId}.run_sha256 does not match ${evidence.run_ref}`);
      }
      if (!sameJson(run, runSnapshot)) {
        throw new ValidationError(`${taskId}.run_snapshot must exactly match ${evidence.run_ref} for draft validation`);
      }
    }
  }
}

function validateMilestoneSourceArtifacts(data, artifactRoot, kind) {
  const expectedGraphRef = `iterations/${data.iteration_id}/gate-c-task-graph/task-graph.json`;
  const expectedSpecRef = `iterations/${data.iteration_id}/gate-b-spec/spec.json`;
  if (normalizedArtifactRef(data.source.task_graph_ref, 'source.task_graph_ref') !== expectedGraphRef) {
    throw new ValidationError(`source.task_graph_ref must be ${expectedGraphRef}`);
  }
  if (normalizedArtifactRef(data.source.spec_ref, 'source.spec_ref') !== expectedSpecRef) {
    throw new ValidationError(`source.spec_ref must be ${expectedSpecRef}`);
  }
  const graphPath = resolveMilestoneSourceFile(artifactRoot, data.source.task_graph_ref, 'source.task_graph_ref');
  const specPath = resolveMilestoneSourceFile(artifactRoot, data.source.spec_ref, 'source.spec_ref');
  const graph = validateTaskGraphData(loadJson(graphPath));
  const spec = validateSpec(specPath);
  if (graph.projectId !== data.project_id || spec.project_id !== data.project_id) {
    throw new ValidationError('milestone review project_id must match task graph and spec project ids');
  }
  if (spec.approval !== 'approved' || spec.open_decisions.length) {
    throw new ValidationError('milestone review source spec must be approved with no open decisions');
  }
  const graphSpecPath = path.resolve(path.dirname(graphPath), graph.sourceSpec);
  if (graphSpecPath !== specPath) {
    throw new ValidationError('milestone review task graph sourceSpec must resolve to source.spec_ref');
  }

  const graphSnapshot = data.source.task_graph_snapshot;
  if (kind === 'draft') {
    if (rawFileSha256(graphPath) !== data.source.task_graph_sha256) {
      throw new ValidationError('source.task_graph_sha256 does not match the current task graph file');
    }
    if (!sameJson(graph, graphSnapshot)) {
      throw new ValidationError('source.task_graph_snapshot must exactly match the current task graph for draft validation');
    }
  } else if (!sameJson(graphWithoutMutableTaskState(graph), graphWithoutMutableTaskState(graphSnapshot))) {
    throw new ValidationError('canonical milestone task graph structure differs from its checkpoint snapshot beyond mutable task state');
  }

  validateMilestoneRunEvidence(data, artifactRoot, kind, graphPath);
}

export function validateMilestoneReview(filePath, options = {}) {
  const data = validateMilestoneReviewData(loadJson(filePath));
  const context = milestonePathContext(filePath, data, options);
  validateMilestoneSourceArtifacts(data, context.artifactRoot, context.kind);
  return data;
}

export function validateSkillProposalData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.skill_proposal));
  validateNonBlankStrings(data.targetFiles, `${data.proposalId}.targetFiles`);
  if (data.evidence) validateNonBlankStrings(data.evidence, `${data.proposalId}.evidence`);
  validateProposalTargetMetadata(data, data.proposalId, { requireUpstreamReason: true });
  return data;
}

export function validateRetrospectiveCandidateData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.retrospective_candidate));
  return data;
}

function validateProposalTargetMetadata(data, label, options = {}) {
  const target = data.target ?? 'project';
  if (target === 'project') {
    for (const field of ['targetRepo', 'targetArea', 'upstreamReason']) {
      if (typeof data[field] === 'string' && data[field].trim().length > 0) {
        throw new ValidationError(`${label}.${field} requires target to be p2a_toolkit or companion_project`);
      }
    }
    return;
  }
  if (typeof data.targetRepo !== 'string' || data.targetRepo.trim().length === 0) {
    throw new ValidationError(`${label}.targetRepo is required when target is ${target}`);
  }
  if (options.requireUpstreamReason && (typeof data.upstreamReason !== 'string' || data.upstreamReason.trim().length === 0)) {
    throw new ValidationError(`${label}.upstreamReason is required when target is ${target}`);
  }
}

export function validateSkillProposal(filePath) {
  return validateSkillProposalData(loadJson(filePath));
}

export function validateProposalsDir(proposalsDir) {
  if (!existsSync(proposalsDir)) throw new ValidationError(`proposals directory is missing: ${proposalsDir}`);
  if (!lstatSync(proposalsDir).isDirectory()) throw new ValidationError(`proposals path must be a directory: ${proposalsDir}`);
  const proposalFiles = readdirSync(proposalsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  const proposals = proposalFiles.map((entry) => validateSkillProposal(path.join(proposalsDir, entry)));
  const proposalIds = proposals.map((proposal) => proposal.proposalId);
  if (proposalIds.length !== new Set(proposalIds).size) {
    throw new ValidationError('proposalId values must be unique within a proposals directory');
  }
  for (const [index, proposal] of proposals.entries()) {
    const expectedName = `${proposal.proposalId}.json`;
    if (proposalFiles[index] !== expectedName) {
      throw new ValidationError(`proposal filename must be ${expectedName}, got ${proposalFiles[index]}`);
    }
  }
  return proposals;
}

export function validateProposalReviewData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_review));
  if (data.summary.totalGroups !== data.groups.length) {
    throw new ValidationError('proposal review summary.totalGroups must match groups length');
  }
  const statusTotal = Object.values(data.summary.byStatus).reduce((sum, count) => sum + count, 0);
  if (statusTotal !== data.summary.totalProposals) {
    throw new ValidationError('proposal review summary.byStatus must sum to totalProposals');
  }
  const riskTotal = Object.values(data.summary.byRisk).reduce((sum, count) => sum + count, 0);
  if (riskTotal !== data.summary.totalProposals) {
    throw new ValidationError('proposal review summary.byRisk must sum to totalProposals');
  }
  const dispositionTotal = Object.values(data.summary.byRecommendedDisposition).reduce((sum, count) => sum + count, 0);
  if (dispositionTotal !== data.summary.totalGroups) {
    throw new ValidationError('proposal review summary.byRecommendedDisposition must sum to totalGroups');
  }
  const groupIds = data.groups.map((group) => group.groupId);
  if (groupIds.length !== new Set(groupIds).size) {
    throw new ValidationError('proposal review groupId values must be unique');
  }
  const proposalIds = [];
  for (const group of data.groups) {
    validateProposalTargetMetadata(group, group.groupId);
    validateNonBlankStrings(group.proposalIds, `${group.groupId}.proposalIds`);
    validateNonBlankStrings(group.targetFiles, `${group.groupId}.targetFiles`);
    validateNonBlankStrings(group.sourceRunIds, `${group.groupId}.sourceRunIds`);
    if (group.frequency !== group.proposalIds.length) {
      throw new ValidationError(`${group.groupId}.frequency must match proposalIds length`);
    }
    const groupStatusTotal = Object.values(group.statusSummary).reduce((sum, count) => sum + count, 0);
    if (groupStatusTotal !== group.proposalIds.length) {
      throw new ValidationError(`${group.groupId}.statusSummary must sum to proposalIds length`);
    }
    proposalIds.push(...group.proposalIds);
  }
  if (proposalIds.length !== new Set(proposalIds).size) {
    throw new ValidationError('proposal review proposalIds must appear in only one group');
  }
  return data;
}

export function validateProposalReview(filePath) {
  return validateProposalReviewData(loadJson(filePath));
}

export function validateProposalCurationData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_curation));
  if (data.summary.totalCandidates !== data.candidates.length) {
    throw new ValidationError('proposal curation summary.totalCandidates must match candidates length');
  }
  const readinessTotal = Object.values(data.summary.byReadiness).reduce((sum, count) => sum + count, 0);
  if (readinessTotal !== data.summary.totalCandidates) {
    throw new ValidationError('proposal curation summary.byReadiness must sum to totalCandidates');
  }
  const dispositionTotal = Object.values(data.summary.byRecommendedDisposition).reduce((sum, count) => sum + count, 0);
  if (dispositionTotal !== data.summary.totalCandidates) {
    throw new ValidationError('proposal curation summary.byRecommendedDisposition must sum to totalCandidates');
  }
  const candidateIds = data.candidates.map((candidate) => candidate.candidateId);
  if (candidateIds.length !== new Set(candidateIds).size) {
    throw new ValidationError('proposal curation candidateId values must be unique');
  }
  const groupIds = data.candidates.map((candidate) => candidate.groupId);
  if (groupIds.length !== new Set(groupIds).size) {
    throw new ValidationError('proposal curation groupId values must be unique');
  }
  for (const candidate of data.candidates) {
    validateProposalTargetMetadata(candidate, candidate.candidateId);
    validateNonBlankStrings(candidate.proposalIds, `${candidate.candidateId}.proposalIds`);
    validateNonBlankStrings(candidate.targetFiles, `${candidate.candidateId}.targetFiles`);
    validateNonBlankStrings(candidate.sourceRunIds, `${candidate.candidateId}.sourceRunIds`);
    if (candidate.frequency !== candidate.proposalIds.length) {
      throw new ValidationError(`${candidate.candidateId}.frequency must match proposalIds length`);
    }
    if (candidate.recommendedDisposition === 'approve' && candidate.readiness !== 'patch_candidate') {
      throw new ValidationError(`${candidate.candidateId}.readiness must be patch_candidate when recommendedDisposition is approve`);
    }
  }
  return data;
}

export function validateProposalCuration(filePath) {
  return validateProposalCurationData(loadJson(filePath));
}

export function validateProposalPatchDraftData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_patch_draft));
  validateProposalTargetMetadata(data, data.draftId);
  if (data.approvalRequired !== true) {
    throw new ValidationError('proposal patch draft approvalRequired must be true');
  }
  if (data.autoApplyAllowed !== false) {
    throw new ValidationError('proposal patch draft autoApplyAllowed must be false');
  }
  validateNonBlankStrings(data.targetFiles, `${data.draftId}.targetFiles`);
  validateNonBlankStrings(data.risks, `${data.draftId}.risks`);
  const intendedFiles = data.intendedChanges.map((change) => change.file);
  validateNonBlankStrings(intendedFiles, `${data.draftId}.intendedChanges.file`);
  const targetFileSet = new Set(data.targetFiles);
  const unknownFiles = intendedFiles.filter((file) => !targetFileSet.has(file));
  if (unknownFiles.length) {
    throw new ValidationError(`proposal patch draft intendedChanges reference files not in targetFiles: ${JSON.stringify([...new Set(unknownFiles)])}`);
  }
  for (const [index, item] of data.verificationPlan.entries()) {
    if (item.required && typeof item.command === 'string' && item.command.trim().length === 0) {
      throw new ValidationError(`${data.draftId}.verificationPlan[${index}].command must not be blank when present`);
    }
  }
  return data;
}

export function validateProposalPatchDraft(filePath) {
  return validateProposalPatchDraftData(loadJson(filePath));
}

export function validateProposalDraftApprovalData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.proposal_draft_approval));
  if (data.autoApplyPerformed !== false) {
    throw new ValidationError('proposal draft approval autoApplyPerformed must be false');
  }
  const target = data.target ?? 'project';
  validateProposalTargetMetadata(data, data.approvalId);
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-draft-approval:${data.approvalId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference approvalId');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-patch-draft:${data.draftId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference draftId');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-target:${target}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference target');
  }
  if (data.targetRepo && !data.maintenanceTask.sourceSpecRefs.includes(`proposal-target-repo:${data.targetRepo}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference targetRepo');
  }
  if (data.targetArea && !data.maintenanceTask.sourceSpecRefs.includes(`proposal-target-area:${data.targetArea}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference targetArea');
  }
  if (!data.maintenanceTask.sourceSpecRefs.includes(`proposal-candidate:${data.candidateId}`)) {
    throw new ValidationError('proposal draft approval maintenanceTask.sourceSpecRefs must reference candidateId');
  }
  validateNonBlankStrings(data.maintenanceTask.sourceSpecRefs, `${data.approvalId}.maintenanceTask.sourceSpecRefs`);
  return data;
}

export function validateProposalDraftApproval(filePath) {
  return validateProposalDraftApprovalData(loadJson(filePath));
}

export function validateEvalIndexData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_index));
  return data;
}

export function validateEvalIndex(filePath) {
  return validateEvalIndexData(loadJson(filePath));
}

export function validateEvalDigestData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_digest));
  return data;
}

export function validateEvalDigest(filePath) {
  return validateEvalDigestData(loadJson(filePath));
}

export function validateEvalMaintenanceDraftData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_maintenance_draft));
  return data;
}

export function validateEvalMaintenanceDraft(filePath) {
  return validateEvalMaintenanceDraftData(loadJson(filePath));
}

export function validateEvalMaintenanceApplyReportData(data) {
  validateSchema(data, loadJson(SCHEMA_PATHS.eval_maintenance_apply_report));
  return data;
}

export function validateEvalMaintenanceApplyReport(filePath) {
  return validateEvalMaintenanceApplyReportData(loadJson(filePath));
}

export function resolveRunTaskGraphPath(runData, artifactRoot) {
  const reference = runData.taskGraphRef;
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new ValidationError(`finished run ${runData.runId} taskGraphRef must be a non-empty string`);
  }
  const candidates = path.isAbsolute(reference)
    ? [reference]
    : [
        path.resolve(artifactRoot, reference),
        resolveProjectRelativeReference(reference, artifactRoot),
      ].filter(Boolean);
  const graphPath = candidates.find(
    (candidate) => existsSync(candidate) && lstatSync(candidate).isFile(),
  );
  if (!graphPath) {
    throw new ValidationError(
      `finished run ${runData.runId} taskGraphRef cannot be resolved inside the artifact root: ${JSON.stringify(reference)}`,
    );
  }
  const externalGraphReference = (
    runData.sourceLayout === 'graph'
    && path.isAbsolute(reference)
  );
  if (!externalGraphReference) {
    assertFileInsideArtifactRoot(graphPath, artifactRoot, `finished run ${runData.runId} taskGraphRef`);
  }
  return graphPath;
}

function resolveRunCurrentDevelopmentContract(
  runData,
  artifactRoot,
  taskGraphPath,
  graphData,
  options = {},
) {
  const hasRef = runData.currentDevelopmentContractRef !== undefined;
  const hasSha256 = runData.currentDevelopmentContractSha256 !== undefined;
  if (hasRef !== hasSha256) {
    throw new ValidationError(
      `run ${runData.runId} current development contract ref and SHA-256 must be recorded together`,
    );
  }
  if (!hasRef) return null;
  if (runData.sourceLayout !== 'iteration') {
    throw new ValidationError(
      `run ${runData.runId} current development contract binding is only valid for iteration runs`,
    );
  }
  const normalizedRef = normalizeReference(runData.currentDevelopmentContractRef);
  if (normalizedRef !== 'current-development-contract.json') {
    throw new ValidationError(
      `run ${runData.runId} currentDevelopmentContractRef must be current-development-contract.json`,
    );
  }
  const contractPath = path.resolve(artifactRoot, normalizedRef);
  assertFile(contractPath, `run ${runData.runId} current development contract`);
  assertFileInsideArtifactRoot(
    contractPath,
    artifactRoot,
    `run ${runData.runId} current development contract`,
  );
  const contract = validateCurrentDevelopmentContract(contractPath, {
    projectId: runData.projectId,
    validationSession: options.validationSession,
  });
  if (contract.iterationId !== runData.iterationId) {
    const currentSpecPath = path.join(artifactRoot, 'current-spec.json');
    if (existsSync(currentSpecPath) && lstatSync(currentSpecPath).isFile()) {
      const currentSpec = loadJson(currentSpecPath);
      if (currentSpec.active_iteration === runData.iterationId) {
        throw new ValidationError(
          `current development contract iterationId must match ${JSON.stringify(runData.iterationId)}, got ${JSON.stringify(contract.iterationId)}`,
        );
      }
    }
    // A single root contract intentionally advances with current development.
    // Historical run validation therefore falls back to its sealed envelope
    // and original task/spec provenance instead of treating today's contract
    // as authority for an older iteration.
    return null;
  }
  const contractSha256 = currentDevelopmentContractSha256(contract);
  if (runData.currentDevelopmentContractSha256 !== contractSha256) {
    throw new ValidationError(
      `run ${runData.runId} current development contract changed after start`,
    );
  }
  if (!taskGraphRefMatchesGraph(contract.bindings.taskGraph.ref, taskGraphPath, artifactRoot)) {
    throw new ValidationError(
      `run ${runData.runId} current development contract task graph binding does not match taskGraphRef`,
    );
  }
  const graphSourceSpecPath = path.resolve(path.dirname(taskGraphPath), graphData.sourceSpec);
  const contractSpecPath = path.resolve(artifactRoot, contract.bindings.activeSpec.ref);
  if (graphSourceSpecPath !== contractSpecPath) {
    throw new ValidationError(
      `run ${runData.runId} current task graph sourceSpec does not match the current development contract`,
    );
  }
  assertFile(contractSpecPath, `run ${runData.runId} current development contract active spec`);
  if (rawFileSha256(contractSpecPath) !== contract.bindings.activeSpec.sha256) {
    throw new ValidationError(
      `run ${runData.runId} current development contract active spec changed after materialization`,
    );
  }
  const constitutionPath = projectConstitutionPathFrom(taskGraphPath);
  const constitutionBinding = contract.bindings.constitution;
  if (constitutionBinding.ref === null && constitutionPath) {
    throw new ValidationError(
      `run ${runData.runId} current constitution appeared after contract materialization`,
    );
  }
  if (constitutionBinding.ref !== null && !constitutionPath) {
    throw new ValidationError(`run ${runData.runId} current constitution is missing`);
  }
  const constitution = constitutionPath
    ? validateConstitution(constitutionPath, {
        requireApproved: true,
        projectId: runData.projectId,
      })
    : {
        schema_version: 'p2a.constitution.v1',
        projectId: runData.projectId,
        architecture: [],
        stack: [],
        prohibitions: [],
        style: {},
      };
  if (
    constitutionPath
    && rawFileSha256(constitutionPath) !== constitutionBinding.sha256
  ) {
    throw new ValidationError(
      `run ${runData.runId} current constitution changed after contract materialization`,
    );
  }
  for (const field of ['architecture', 'stack', 'prohibitions', 'style']) {
    if (!sameJson(contract[field], constitution[field])) {
      throw new ValidationError(
        `run ${runData.runId} current development contract ${field} does not match the constitution`,
      );
    }
  }
  const expectedTaskBindings = graphData.tasks.map((task) => ({
    taskId: task.id,
    sha256: taskContractSha256(task),
  }));
  if (!sameJson(contract.bindings.taskGraph.tasks, expectedTaskBindings)) {
    throw new ValidationError(
      `run ${runData.runId} current development contract task bindings do not match the task graph`,
    );
  }
  const expectedIterationConstraints = iterationConstraintsFromSpec(loadJson(contractSpecPath));
  if (
    contract.iterationConstraints !== undefined
    && !sameJson(contract.iterationConstraints, expectedIterationConstraints)
  ) {
    throw new ValidationError(
      `run ${runData.runId} current development contract iterationConstraints do not match the bound active spec`,
    );
  }
  return {
    contract,
    contractPath,
    constitutionPath,
    envelope: executionEnvelopeFromCurrentDevelopmentContract(contract, normalizedRef, {
      iterationConstraints: expectedIterationConstraints,
    }),
  };
}

function trustedHistoricalCurrentDevelopmentEnvelope(
  runData,
  artifactRoot,
  taskGraphPath,
  sourceSpecPath,
  graph,
) {
  if (
    runData.status !== 'finished'
    || runData.currentDevelopmentContractRef === undefined
    || runData.currentDevelopmentContractSha256 === undefined
  ) return null;
  const iterationsRoot = path.join(artifactRoot, 'iterations');
  if (!existsSync(iterationsRoot) || !lstatSync(iterationsRoot).isDirectory()) return null;
  const expectedTaskBindings = graph.tasks.map((task) => ({
    taskId: task.id,
    sha256: taskContractSha256(task),
  }));
  const candidates = readdirSync(iterationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(
      iterationsRoot,
      entry.name,
      'baseline',
      'current-development-contract.json',
    ));
  for (const contractPath of candidates) {
    try {
      if (!existsSync(contractPath)) continue;
      const contractStat = lstatSync(contractPath);
      if (!contractStat.isFile() || contractStat.isSymbolicLink()) continue;
      assertFileInsideArtifactRoot(
        contractPath,
        artifactRoot,
        `run ${runData.runId} historical current development contract snapshot`,
      );
      const contract = validateCurrentDevelopmentContractData(loadJson(contractPath), {
        projectId: runData.projectId,
        iterationId: runData.iterationId,
      });
      if (currentDevelopmentContractSha256(contract) !== runData.currentDevelopmentContractSha256) {
        continue;
      }
      const boundSpecPath = path.resolve(artifactRoot, normalizeReference(contract.bindings.activeSpec.ref));
      if (
        realpathSync(boundSpecPath) !== realpathSync(sourceSpecPath)
        || rawFileSha256(boundSpecPath) !== contract.bindings.activeSpec.sha256
        || !taskGraphRefMatchesGraph(contract.bindings.taskGraph.ref, taskGraphPath, artifactRoot)
        || !sameJson(contract.bindings.taskGraph.tasks, expectedTaskBindings)
      ) continue;
      const constitutionBinding = contract.bindings.constitution;
      let constitution;
      if (constitutionBinding.ref === null) {
        constitution = {
          architecture: [],
          stack: [],
          prohibitions: [],
          style: {},
        };
      } else {
        if (constitutionBinding.ref !== '.plan2agent/constitution.json') continue;
        const constitutionPath = path.join(path.dirname(contractPath), 'constitution.json');
        if (!existsSync(constitutionPath)) continue;
        const constitutionStat = lstatSync(constitutionPath);
        if (!constitutionStat.isFile() || constitutionStat.isSymbolicLink()) continue;
        assertFileInsideArtifactRoot(
          constitutionPath,
          artifactRoot,
          `run ${runData.runId} historical constitution snapshot`,
        );
        if (rawFileSha256(constitutionPath) !== constitutionBinding.sha256) continue;
        constitution = validateConstitution(constitutionPath, {
          requireApproved: true,
          projectId: runData.projectId,
        });
      }
      if (!['architecture', 'stack', 'prohibitions', 'style'].every(
        (field) => sameJson(contract[field], constitution[field]),
      )) continue;
      return executionEnvelopeFromCurrentDevelopmentContract(
        contract,
        'current-development-contract.json',
      );
    } catch {
      // Ignore malformed or unrelated historical snapshots. A candidate is
      // trusted only when every immutable binding above matches.
    }
  }
  return null;
}

function currentContractVisualReview(contract) {
  const visual = contract.visualContract;
  if (!visual) return null;
  return {
    required: true,
    experienceSpecRef: visual.experienceSpecRef,
    experienceSpecSha256: visual.experienceSpecSha256,
    prototypeManifestRef: visual.prototypeManifestRef,
    prototypeManifestSha256: visual.prototypeManifestSha256,
    screenStates: visual.screens.map((screen) => ({
      screenId: screen.screenId,
      states: structuredClone(screen.states),
    })),
    viewports: structuredClone(visual.viewports),
    accessibilityStandard: visual.accessibilityStandard,
  };
}

function currentContractAcceptanceReview(contract) {
  return {
    required: true,
    criteria: contract.acceptance.map((text, index) => ({
      ref: `current.acceptance[${index}]`,
      text,
    })),
  };
}

function currentIterationAcceptanceReviewContracts(currentDevelopment, artifactRoot, options = {}) {
  const activeSpecRef = currentDevelopment.contract.bindings.activeSpec.ref;
  const activeSpecPath = path.resolve(artifactRoot, activeSpecRef);
  assertFile(activeSpecPath, 'current-iteration functional acceptance spec');
  assertFileInsideArtifactRoot(
    activeSpecPath,
    artifactRoot,
    'current-iteration functional acceptance spec',
  );
  if (rawFileSha256(activeSpecPath) !== currentDevelopment.contract.bindings.activeSpec.sha256) {
    throw new ValidationError('current-iteration functional acceptance spec changed after contract materialization');
  }
  return acceptanceReviewContracts(activeSpecPath, artifactRoot, options);
}

function acceptanceReviewTextEquivalent(actual, expected) {
  return actual?.required === expected?.required
    && Array.isArray(actual?.criteria)
    && Array.isArray(expected?.criteria)
    && actual.criteria.length === expected.criteria.length
    && actual.criteria.every((criterion, index) => (
      criterion?.text === expected.criteria[index]?.text
    ));
}

export function validateRunTaskContract(runData, artifactRoot, options = {}) {
  const taskGraphPath = resolveRunTaskGraphPath(runData, artifactRoot);
  let sourceArtifactRoot = runData.sourceLayout === 'graph'
    ? defaultArtifactRootForGraph(realpathSync(taskGraphPath))
    : path.resolve(artifactRoot);
  const graphData = loadJson(taskGraphPath);
  const rawVisualContract = Boolean(runData.visualReview?.required);
  const rawAcceptanceContract = Boolean(runData.acceptanceReview?.required);
  const currentDevelopment = resolveRunCurrentDevelopmentContract(
    runData,
    sourceArtifactRoot,
    taskGraphPath,
    graphData,
    options,
  );
  let sourceSpecPath = null;
  let maintenanceSource = false;
  if (!currentDevelopment) {
    try {
      sourceSpecPath = resolveVisualReviewSourceSpec({
        source_spec_ref: runData.sourceSpecRef,
        task_graph_ref: taskGraphPath,
      }, sourceArtifactRoot, {
        requireInsideArtifactRoot: runData.sourceLayout !== 'graph',
      });
      if (runData.sourceLayout === 'graph') {
        sourceArtifactRoot = visualArtifactRoot(sourceSpecPath);
      }
      if (runData.sourceLayout === 'maintenance') {
        const sourceData = loadJson(sourceSpecPath);
        if (sourceData.schema_version !== 'p2a.current_spec.v1') {
          throw new ValidationError(
            `finished maintenance run ${runData.runId} sourceSpecRef must reference current-spec.json`,
          );
        }
        if (sourceData.project_id !== runData.projectId) {
          throw new ValidationError(
            `finished maintenance run ${runData.runId} projectId does not match current-spec.json`,
          );
        }
        maintenanceSource = true;
      }
    } catch (error) {
      if (rawVisualContract || rawAcceptanceContract || runData.schema_version === 'p2a.run.v2') {
        throw error;
      }
    }
  }
  const graph = currentDevelopment
    ? validateTaskGraphData(graphData, null, {
        artifactPath: taskGraphPath,
        artifactRoot: sourceArtifactRoot,
        ...(currentDevelopment.constitutionPath
          ? { constitutionPath: currentDevelopment.constitutionPath }
          : {}),
        projectId: runData.projectId,
      })
    : validateTaskGraphData(graphData, maintenanceSource ? null : sourceSpecPath);
  const task = graph.tasks.find((candidate) => candidate.id === runData.taskId);
  if (!task) {
    throw new ValidationError(
      `finished run ${runData.runId} taskId ${runData.taskId} is missing from its source task graph`,
    );
  }
  if (runData.mode !== undefined) {
    const expectedMode = graph.execution?.mode ?? 'orchestrated';
    const expectedRationale = graph.execution?.selectionRationale
      ?? (runData.sourceLayout === 'maintenance'
        ? 'Maintenance task graph execution.'
        : 'Approved Gate C task graph execution.');
    if (runData.mode !== expectedMode) {
      throw new ValidationError(
        `finished run ${runData.runId} mode does not match its execution task graph`,
      );
    }
    if (runData.selectionRationale !== expectedRationale) {
      throw new ValidationError(
        `finished run ${runData.runId} selectionRationale does not match its execution task graph`,
      );
    }
    if (!runData.runKind && expectedMode === 'planned') {
      const runMilestones = runData.milestones.map(({ id, outcome, verification }) => ({ id, outcome, verification }));
      if (!sameJson(runMilestones, graph.execution.milestones)) {
        throw new ValidationError(
          `finished run ${runData.runId} milestones do not match its execution task graph`,
        );
      }
    }
  }
  const currentTaskContractSha256 = taskContractSha256(task);
  const requiresTaskContract = (
    runData.schema_version === 'p2a.run.v2'
    || runData.visualReview?.required
    || runData.acceptanceReview?.required
  );
  if (requiresTaskContract && runData.taskContractSha256 === undefined) {
    throw new ValidationError(
      `finished run ${runData.runId} taskContractSha256 is required to preserve the immutable task contract recorded at start`,
    );
  }
  if (
    runData.taskContractSha256 !== undefined
    && runData.taskContractSha256 !== currentTaskContractSha256
  ) {
    throw new ValidationError(
      `finished run ${runData.runId} taskContractSha256 does not match the immutable task contract recorded at start`,
    );
  }
  if (sourceSpecPath && !currentDevelopment) {
    const artifactRelativeGraphSpec = path.resolve(sourceArtifactRoot, graph.sourceSpec);
    const graphSourceSpecPath = resolveExistingFileReference(
      graph.sourceSpec,
      path.dirname(taskGraphPath),
    ) ?? (
      existsSync(artifactRelativeGraphSpec) && lstatSync(artifactRelativeGraphSpec).isFile()
        ? artifactRelativeGraphSpec
        : null
    );
    if (!graphSourceSpecPath) {
      throw new ValidationError(`finished run ${runData.runId} source task graph sourceSpec cannot be resolved`);
    }
    assertFileInsideArtifactRoot(
      graphSourceSpecPath,
      sourceArtifactRoot,
      `finished run ${runData.runId} source task graph sourceSpec`,
    );
    if (realpathSync(graphSourceSpecPath) !== realpathSync(sourceSpecPath)) {
      throw new ValidationError(
        `finished run ${runData.runId} sourceSpecRef does not match its source task graph`,
      );
    }
  }
  const executionEnvelope = resolveRunExecutionEnvelope(
    runData,
    options.runsDir ?? path.join(path.resolve(artifactRoot), 'runs'),
  );
  const hasExecutionEnvelope = executionEnvelope !== null;
  const hasExecutionEnvelopeHash = runData.executionEnvelopeSha256 !== undefined;
  if (hasExecutionEnvelope !== hasExecutionEnvelopeHash) {
    throw new ValidationError(
      `run ${runData.runId} execution envelope and executionEnvelopeSha256 must be recorded together`,
    );
  }
  if (runData.mode !== undefined && !maintenanceSource && !hasExecutionEnvelope) {
    throw new ValidationError(
      `run ${runData.runId} requires its Gate B execution envelope for contract validation`,
    );
  }
  if (hasExecutionEnvelope) {
    if (maintenanceSource) {
      throw new ValidationError(
        `finished maintenance run ${runData.runId} must not record a Gate B execution envelope`,
      );
    }
    const expectedEnvelope = currentDevelopment?.envelope ?? approvedExecutionEnvelope(
      sourceSpecPath,
      runData.sourceSpecRef,
      runData.sourceLayout === 'graph' ? null : sourceArtifactRoot,
      options,
    );
    const legacyExpectedEnvelope = expectedEnvelope.visualContract
      ? {
          ...expectedEnvelope,
          visualContract: {
            experienceSpecRef: expectedEnvelope.visualContract.experienceSpecRef,
            experienceSpecSha256: expectedEnvelope.visualContract.experienceSpecSha256,
          },
        }
      : null;
    const allowsLegacyConstraintEnvelope = (
      runData.status === 'finished'
      && runData.productRevisionSha256 === undefined
      && executionEnvelope.iterationConstraints === undefined
    );
    const legacyConstraintEnvelope = (
      allowsLegacyConstraintEnvelope
      && expectedEnvelope.iterationConstraints
    )
      ? (() => {
          const legacy = structuredClone(expectedEnvelope);
          delete legacy.iterationConstraints;
          return legacy;
        })()
      : null;
    const legacyVisualConstraintEnvelope = (
      allowsLegacyConstraintEnvelope
      && legacyExpectedEnvelope?.iterationConstraints
    )
      ? (() => {
          const legacy = structuredClone(legacyExpectedEnvelope);
          delete legacy.iterationConstraints;
          return legacy;
        })()
      : null;
    const allowsCurrentContractLegacyEnvelope = (
      currentDevelopment
      && runData.status === 'finished'
      && runData.productRevisionSha256 === undefined
    );
    const currentContractLegacyEnvelopeVariants = allowsCurrentContractLegacyEnvelope
      ? (() => {
          const activeSpecRef = currentDevelopment.contract.bindings.activeSpec.ref;
          const activeSpecPath = path.resolve(sourceArtifactRoot, activeSpecRef);
          const trustedLegacyEnvelope = approvedExecutionEnvelope(
            activeSpecPath,
            activeSpecRef,
            sourceArtifactRoot,
            options,
          );
          const variants = [trustedLegacyEnvelope];
          if (trustedLegacyEnvelope.visualContract) {
            variants.push({
              ...trustedLegacyEnvelope,
              visualContract: {
                experienceSpecRef: trustedLegacyEnvelope.visualContract.experienceSpecRef,
                experienceSpecSha256: trustedLegacyEnvelope.visualContract.experienceSpecSha256,
              },
            });
          }
          if (trustedLegacyEnvelope.iterationConstraints !== undefined) {
            for (const candidate of [...variants]) {
              const withoutIterationConstraints = structuredClone(candidate);
              delete withoutIterationConstraints.iterationConstraints;
              variants.push(withoutIterationConstraints);
            }
          }
          return variants;
        })()
      : [];
    const historicalCurrentContractEnvelope = (
      !currentDevelopment
      && sourceSpecPath
      && runData.currentDevelopmentContractRef !== undefined
    )
      ? trustedHistoricalCurrentDevelopmentEnvelope(
          runData,
          sourceArtifactRoot,
          taskGraphPath,
          sourceSpecPath,
          graph,
        )
      : null;
    const historicalCurrentContractEnvelopeVariants = historicalCurrentContractEnvelope
      ? (() => {
          const variants = [historicalCurrentContractEnvelope];
          if (historicalCurrentContractEnvelope.visualContract) {
            variants.push({
              ...historicalCurrentContractEnvelope,
              visualContract: {
                experienceSpecRef: historicalCurrentContractEnvelope.visualContract.experienceSpecRef,
                experienceSpecSha256: historicalCurrentContractEnvelope.visualContract.experienceSpecSha256,
              },
            });
          }
          if (
            allowsLegacyConstraintEnvelope
            && historicalCurrentContractEnvelope.iterationConstraints !== undefined
          ) {
            for (const candidate of [...variants]) {
              const withoutIterationConstraints = structuredClone(candidate);
              delete withoutIterationConstraints.iterationConstraints;
              variants.push(withoutIterationConstraints);
            }
          }
          return variants;
        })()
      : [];
    if (
      !sameJson(executionEnvelope, expectedEnvelope)
      && (!legacyExpectedEnvelope || !sameJson(executionEnvelope, legacyExpectedEnvelope))
      && (!legacyConstraintEnvelope || !sameJson(executionEnvelope, legacyConstraintEnvelope))
      && (!legacyVisualConstraintEnvelope || !sameJson(executionEnvelope, legacyVisualConstraintEnvelope))
      && !currentContractLegacyEnvelopeVariants.some(
        (candidate) => sameJson(executionEnvelope, candidate),
      )
      && !historicalCurrentContractEnvelopeVariants.some(
        (candidate) => sameJson(executionEnvelope, candidate),
      )
    ) {
      throw new ValidationError(
        `finished run ${runData.runId} executionEnvelope does not match its current development contract`,
      );
    }
    const expectedEnvelopeSha256 = executionEnvelopeSha256(executionEnvelope);
    if (runData.executionEnvelopeSha256 !== expectedEnvelopeSha256) {
      throw new ValidationError(
        `finished run ${runData.runId} executionEnvelopeSha256 does not match resolved execution envelope`,
      );
    }
  }
  if (graph.projectId !== runData.projectId) {
    throw new ValidationError(`finished run ${runData.runId} projectId does not match its source task graph`);
  }
  const actualVisualReview = runData.visualReview ?? null;
  if (actualVisualReview) {
    if (runData.runKind !== 'final_visual_review') {
      throw new ValidationError(
        `finished run ${runData.runId} visualReview is only allowed for runKind final_visual_review`,
      );
    }
    const expectedVisualReview = currentDevelopment
      ? currentContractVisualReview(currentDevelopment.contract)
      : approvedVisualReviewContract(sourceSpecPath, sourceArtifactRoot, options);
    if (!expectedVisualReview || !sameJson(actualVisualReview, expectedVisualReview)) {
      throw new ValidationError(
        `finished run ${runData.runId} visualReview must match the complete approved iteration visual contract`,
      );
    }
  }
  const actualAcceptanceReview = runData.acceptanceReview ?? null;
  if (actualAcceptanceReview) {
    if (runData.runKind !== 'final_acceptance_review') {
      throw new ValidationError(
        `finished run ${runData.runId} acceptanceReview is only allowed for runKind final_acceptance_review`,
      );
    }
    if (runData.sourceLayout !== 'iteration') {
      throw new ValidationError(
        `finished acceptance review run ${runData.runId} must use the iteration source layout`,
      );
    }
    const acceptanceContracts = currentDevelopment
      ? currentIterationAcceptanceReviewContracts(
          currentDevelopment,
          sourceArtifactRoot,
          options,
        )
      : acceptanceReviewContracts(sourceSpecPath, sourceArtifactRoot, options);
    const legacyFullAcceptanceReview = currentDevelopment
      ? currentContractAcceptanceReview(currentDevelopment.contract)
      : acceptanceContracts.full;
    const expectedAcceptanceReview = acceptanceContracts.current.criteria.length
      ? acceptanceContracts.current
      : acceptanceContracts.full;
    if (
      !sameJson(actualAcceptanceReview, expectedAcceptanceReview)
      && !sameJson(actualAcceptanceReview, legacyFullAcceptanceReview)
      && !(
        currentDevelopment
        && acceptanceReviewTextEquivalent(
          actualAcceptanceReview,
          expectedAcceptanceReview,
        )
      )
    ) {
      throw new ValidationError(
        `finished run ${runData.runId} acceptanceReview must match the approved current-iteration behavior contract`,
      );
    }
  }
  return {
    task,
    graph,
    taskGraphPath,
    sourceArtifactRoot,
  };
}

export function validateRunsDir(runsDir, options = {}) {
  if (!existsSync(runsDir)) throw new ValidationError(`runs directory is missing: ${runsDir}`);
  if (!lstatSync(runsDir).isDirectory()) throw new ValidationError(`runs path must be a directory: ${runsDir}`);
  const pendingWritePath = runWriteTransactionPath(runsDir);
  if (existsSync(pendingWritePath)) {
    throw new ValidationError(
      `run write transaction is pending: ${pendingWritePath}; retry a mutating runs command before validating the run store`,
    );
  }
  const indexPath = path.join(runsDir, 'run-index.json');
  assertFile(indexPath, 'run-index.json');
  const index = validateRunIndex(indexPath);
  const validationSession = options.validationSession ?? createValidationSession();
  const runsToValidate = options.iterationId === undefined
    ? index.runs
    : index.runs.filter((run) => run.iterationId === options.iterationId);
  for (const run of runsToValidate) {
    const normalizedRunRef = normalizeIndexedRunRef(run.runRef, run.runId);
    const runPath = path.join(runsDir, normalizedRunRef);
    assertFile(runPath, run.runRef);
    const runData = validateRun(runPath);
    resolveRunExecutionEnvelope(runData, runsDir);
    for (const field of ['runId', 'taskId', 'iterationId', 'status', 'agentTool', 'workspaceRef', 'taskGraphRef', 'startedAt', 'finishedAt']) {
      if (JSON.stringify(run[field]) !== JSON.stringify(runData[field])) {
        throw new ValidationError(`run-index ${run.runId}.${field} does not match run file`);
      }
    }
    if (
      Object.hasOwn(run, 'runKind')
      && (run.runKind ?? null) !== (runData.runKind ?? null)
    ) {
      throw new ValidationError(`run-index ${run.runId}.runKind does not match run file`);
    }
    if (runData.projectId !== index.projectId) {
      throw new ValidationError(`run ${run.runId} projectId does not match run-index projectId`);
    }
    const source = runData.status === 'finished'
      ? validateRunTaskContract(
          runData,
          path.dirname(path.resolve(runsDir)),
          { validationSession, runsDir },
        )
      : null;
    if (runData.monitorGate?.required) {
      const monitorGatePath = runSidecarPath(
        runsDir,
        runData.runId,
        '.monitor-gate.json',
        index,
      );
      assertFile(monitorGatePath, `${runData.runId} monitor gate`);
      let monitorGate;
      try {
        monitorGate = normalizeMonitorGateSidecar(
          loadJson(monitorGatePath),
          runData.runId,
          normalizedRunRef,
        );
        assertRunMonitorGateBinding(runData, monitorGate);
        const verdictRequired = Boolean(
          runData.monitorVerdictEvidenceSha256
          || runData.status === 'finished'
          || runData.failure?.source === 'monitor',
        );
        if (verdictRequired) {
          const verdictPath = path.resolve(runsDir, monitorGate.verdictPath);
          assertFile(verdictPath, `${runData.runId} monitor verdict`);
          const verdictContents = readFileSync(verdictPath);
          assertRunMonitorVerdictBinding(runData, verdictContents);
          const verdict = normalizeMonitorVerdictData(
            JSON.parse(verdictContents.toString('utf8')),
            {
              requiredConcernFields: monitorGate.requiredConcernFields,
              requiredRuleIds: monitorGate.ruleContract?.ruleIds,
              requireRulesReviewed: monitorGate.ruleContract !== null,
            },
          );
          const accepted = monitorGate.acceptedVerdicts.includes(verdict.verdict)
            && !verdict.hasConcerns;
          if (runData.status === 'finished' && !accepted) {
            throw new Error(`finished run ${runData.runId} does not have an accepted monitor verdict`);
          }
          if (runData.failure?.source === 'monitor') {
            if (runData.status !== 'blocked') {
              throw new Error(`monitor-sourced run ${runData.runId} must have blocked status`);
            }
            if (accepted) {
              throw new Error(`monitor-sourced blocked run ${runData.runId} cannot have an accepted monitor verdict`);
            }
            const expectedFailureClass = monitorGate.failureClassMap[verdict.failureSignal]
              ?? monitorGate.failureClassMap[verdict.verdict]
              ?? 'other';
            if (runData.failure.class !== expectedFailureClass) {
              throw new Error(
                `monitor-sourced run ${runData.runId} failure class must be ${expectedFailureClass}`,
              );
            }
            if (runData.failure.needsUserDecision !== verdict.needsUserDecision) {
              throw new Error(
                `monitor-sourced run ${runData.runId} needsUserDecision must match its monitor verdict`,
              );
            }
          }
        } else {
          assertRunMonitorVerdictBinding(runData, null);
        }
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : String(error));
      }
    }
    if (runData.status === 'finished' && runData.visualReview?.required) {
      const visualContract = runData.visualReview;
      if (!/^[a-f0-9]{64}$/.test(runData.workspaceRevisionSha256 ?? '')) {
        throw new ValidationError(
          `finished run ${runData.runId} workspaceRevisionSha256 is required for visual evidence`,
        );
      }
      const visualReviewPath = runSidecarPath(
        runsDir,
        runData.runId,
        '.visual-review.json',
        index,
      );
      assertFile(visualReviewPath, `${runData.runId} visual review`);
      const visualReviewSha256 = rawFileSha256(visualReviewPath);
      const visualReviewSchemaVersion = loadJson(visualReviewPath).schema_version;
      if (
        runData.schema_version === 'p2a.run.v2'
        && runData.runKind === 'final_visual_review'
        && visualReviewSchemaVersion !== 'p2a.visual_review.v2'
      ) {
        throw new ValidationError(
          `finished final visual review run ${runData.runId} requires p2a.visual_review.v2 evidence`,
        );
      }
      const visualReview = validateVisualReview(visualReviewPath, {
        run_id: runData.runId,
        ...(visualReviewSchemaVersion === 'p2a.visual_review.v1'
          ? { task_id: runData.taskId }
          : { iteration_id: runData.iterationId }),
        workspace_ref: runData.workspaceRef,
        workspace_revision_sha256: runData.workspaceRevisionSha256,
        started_at: runData.startedAt,
        finished_at: runData.finishedAt,
        project_id: runData.projectId,
        source_spec_ref: runData.sourceSpecRef,
        task_graph_ref: runData.taskGraphRef,
        source_experience_ref: visualContract.experienceSpecRef,
        experience_spec_sha256: visualContract.experienceSpecSha256,
        source_prototype_ref: visualContract.prototypeManifestRef,
        prototype_manifest_sha256: visualContract.prototypeManifestSha256,
        screen_states: visualContract.screenStates.map((screen) => ({
          screen_id: screen.screenId,
          states: screen.states,
        })),
        viewports: visualContract.viewports,
        accessibility_standard: visualContract.accessibilityStandard,
      }, {
        artifactRoot: path.dirname(runsDir),
        sourceArtifactRoot: source.sourceArtifactRoot,
      });
      if (rawFileSha256(visualReviewPath) !== visualReviewSha256) {
        throw new ValidationError(`finished run ${runData.runId} visual review changed during validation`);
      }
      if (!/^[a-f0-9]{64}$/.test(runData.visualReviewEvidenceSha256 ?? '')) {
        throw new ValidationError(
          `finished run ${runData.runId} visualReviewEvidenceSha256 is required for visual evidence`,
        );
      }
      if (runData.visualReviewEvidenceSha256 !== visualReviewSha256) {
        throw new ValidationError(
          `finished run ${runData.runId} visualReviewEvidenceSha256 does not match its visual review sidecar`,
        );
      }
      if (visualReview.verdict !== 'confirm_ui') {
        throw new ValidationError(`finished run ${runData.runId} requires visual review verdict confirm_ui`);
      }
    }
    if (runData.status === 'finished' && runData.acceptanceReview?.required) {
      if (!/^[a-f0-9]{64}$/.test(runData.workspaceRevisionSha256 ?? '')) {
        throw new ValidationError(
          `finished run ${runData.runId} workspaceRevisionSha256 is required for acceptance evidence`,
        );
      }
      const acceptanceReviewPath = runSidecarPath(
        runsDir,
        runData.runId,
        '.acceptance-review.json',
        index,
      );
      assertFile(acceptanceReviewPath, `${runData.runId} acceptance review`);
      const acceptanceReviewSha256 = rawFileSha256(acceptanceReviewPath);
      const acceptanceReview = validateAcceptanceReview(acceptanceReviewPath, {
        run_id: runData.runId,
        iteration_id: runData.iterationId,
        source_spec_ref: runData.sourceSpecRef,
        criteria: runData.acceptanceReview.criteria,
        verification: runData.verification,
      });
      if (rawFileSha256(acceptanceReviewPath) !== acceptanceReviewSha256) {
        throw new ValidationError(`finished run ${runData.runId} acceptance review changed during validation`);
      }
      if (!/^[a-f0-9]{64}$/.test(runData.acceptanceReviewEvidenceSha256 ?? '')) {
        throw new ValidationError(
          `finished run ${runData.runId} acceptanceReviewEvidenceSha256 is required for acceptance evidence`,
        );
      }
      if (runData.acceptanceReviewEvidenceSha256 !== acceptanceReviewSha256) {
        throw new ValidationError(
          `finished run ${runData.runId} acceptanceReviewEvidenceSha256 does not match its acceptance review sidecar`,
        );
      }
      if (acceptanceReview.verdict !== 'confirm_behavior') {
        throw new ValidationError(`finished run ${runData.runId} requires acceptance review verdict confirm_behavior`);
      }
    }
  }
  // Current-development routing deliberately validates only the selected
  // iteration. Directory-wide orphan discovery remains an explicit runs
  // administration concern because walking archived partitions would make
  // historical evidence a normal runtime dependency again.
  if (options.iterationId !== undefined) return index;

  const indexedRunFiles = new Set(index.runs.map((run) => normalizeIndexedRunRef(run.runRef, run.runId)));
  const candidateRunFiles = [];
  const unsupportedEntries = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      candidateRunFiles.push(entry.name);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const child of readdirSync(path.join(runsDir, entry.name), { withFileTypes: true })) {
      const childRef = `${entry.name}/${child.name}`;
      if (child.isFile()) {
        candidateRunFiles.push(childRef);
        continue;
      }
      if (child.isDirectory() && child.name === 'envelopes') {
        for (const envelope of readdirSync(path.join(runsDir, childRef), { withFileTypes: true })) {
          const envelopeRef = `${childRef}/${envelope.name}`;
          if (!envelope.isFile() || !/^[a-f0-9]{64}\.json$/.test(envelope.name)) {
            unsupportedEntries.push(envelopeRef);
          }
        }
        continue;
      }
      unsupportedEntries.push(childRef);
    }
  }
  if (unsupportedEntries.length) {
    throw new ValidationError(`runs directory contains unsupported nested entry(s): ${unsupportedEntries.join(', ')}`);
  }
  const extraRunFiles = candidateRunFiles
    .filter((entry) => {
      if (!entry.endsWith('.json') || entry === 'run-index.json' || indexedRunFiles.has(entry)) return false;
      if (!RUN_SIDECAR_SUFFIXES.some((suffix) => entry.endsWith(suffix))) return true;
      return isRunRecordFile(path.join(runsDir, entry));
    });
  if (extraRunFiles.length) {
    throw new ValidationError(`runs directory contains unindexed run file(s): ${extraRunFiles.join(', ')}`);
  }
  return index;
}

function validateReviewPassData(data) {
  if (data.blocking_issues.length !== 0) {
    throw new ValidationError(`review cannot pass Gate D while blocking_issues is non-empty: ${JSON.stringify(data.blocking_issues)}`);
  }
}

export function validateStatusDoc(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const required = [
    ['Progress line', /Progress:/i],
    ['Gate A section', /Gate A/i],
    ['Gate B section', /Gate B/i],
    ['Gate C section', /Gate C/i],
    ['section 1 heading', /^##\s+1\./m],
    ['section 2 heading', /^##\s+2\./m],
    ['section 3 heading', /^##\s+3\./m],
    ['section 4 heading', /^##\s+4\./m],
    ['section 5 heading', /^##\s+5\./m],
  ];
  for (const [label, pattern] of required) {
    if (!pattern.test(text)) throw new ValidationError(`status.md missing ${label}`);
  }
  return text;
}

function artifactPaths(artifactRoot) {
  const root = path.resolve(artifactRoot);
  return Object.fromEntries(
    Object.entries(GATE_PATHS).map(([key, relativePath]) => [key, path.join(root, relativePath)]),
  );
}

function filesExist(paths, keys) {
  return keys.map((key) => paths[key]).filter((filePath) => existsSync(filePath));
}

function requireGateFiles(paths, keys, gateLabel) {
  const missing = keys.filter((key) => !existsSync(paths[key]));
  if (missing.length) {
    throw new ValidationError(`${gateLabel} is incomplete; missing ${missing.map((key) => GATE_PATHS[key]).join(', ')}`);
  }
  for (const key of keys) assertFile(paths[key], GATE_PATHS[key]);
}

function normalizeReference(reference) {
  return String(reference).replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertProjectId(label, actual, expected) {
  if (expected && actual !== expected) {
    throw new ValidationError(`${label} must match project id ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const GATE_SCOPE_DECISION_TYPES = new Set([
  'gate.what.approved',
  'gate.what.revoked',
  'scope.added',
  'scope.removed',
]);
const ACTIVE_GATE_SCOPE_DECISION_TYPES = new Set([
  'gate.what.approved',
  'scope.added',
  'scope.removed',
]);

export function gateArtifactApprovalState(decisions, artifactRoot, artifactPath) {
  const root = path.resolve(artifactRoot);
  const resolvedArtifactPath = path.resolve(artifactPath);
  if (!pathIsAtOrUnder(root, resolvedArtifactPath) || root === resolvedArtifactPath) {
    throw new ValidationError('Gate approval artifact must stay inside the artifact root');
  }
  const scopeRef = normalizeReference(path.relative(root, resolvedArtifactPath));
  if (!Array.isArray(decisions)) {
    return {
      approved: true,
      source: 'approval_audit',
      event: null,
      scopeRef,
      reason: 'legacy_without_decision_ledger',
    };
  }
  const event = decisions.filter((record) => (
    GATE_SCOPE_DECISION_TYPES.has(record.type)
    && normalizeReference(record.scope_ref) === scopeRef
  )).at(-1) ?? null;
  if (!event) {
    return {
      approved: false,
      source: 'decisions',
      event: null,
      scopeRef,
      reason: 'missing_approval_decision',
    };
  }
  if (!ACTIVE_GATE_SCOPE_DECISION_TYPES.has(event.type)) {
    return {
      approved: false,
      source: 'decisions',
      event,
      scopeRef,
      reason: 'approval_revoked',
    };
  }
  const approved = event.sha256 === rawFileSha256(resolvedArtifactPath);
  return {
    approved,
    source: 'decisions',
    event,
    scopeRef,
    reason: approved ? 'approved_hash_match' : 'approved_hash_mismatch',
  };
}

export function validateArtifactRoot(artifactRoot, options = {}) {
  const root = path.resolve(artifactRoot);
  if (!existsSync(root)) throw new ValidationError(`artifact root is missing: ${root}`);
  if (!lstatSync(root).isDirectory()) throw new ValidationError(`artifact root must be a directory: ${root}`);

  const paths = artifactPaths(root);
  const constitutionPath = options.constitutionPath ?? projectConstitutionPathFrom(root);
  const constitution = constitutionPath
    ? validateConstitution(constitutionPath, { projectId: options.projectId })
    : null;
  const decisions = existsSync(paths.decisions)
    ? validateDecisionLedger(paths.decisions)
    : null;

  requireGateFiles(paths, ['intakeJson'], 'Gate A');
  const intake = validateIntake(paths.intakeJson, { artifactRoot: root });
  const gateAApproval = intake.status === 'ready_for_spec'
    ? gateArtifactApprovalState(decisions, root, paths.intakeJson)
    : null;
  const result = {
    artifactRoot: root,
    paths,
    gates: {
      a: {
        present: true,
        valid: true,
        passed: intake.status === 'ready_for_spec' && gateAApproval.approved,
      },
      b: { present: false, valid: false, passed: false },
      c: { present: false, valid: false, passed: false },
    },
    intake,
    spec: null,
    taskGraph: null,
    constitution,
    decisions,
    readyForHandoff: false,
  };

  const gateBKeys = ['specJson'];
  const gateBExisting = filesExist(paths, gateBKeys);
  if (gateBExisting.length) {
    requireGateFiles(paths, gateBKeys, 'Gate B');
    const spec = validateSpec(paths.specJson, paths.intakeJson, {
      artifactRoot: root,
      constitutionPath,
      projectId: options.projectId,
    });
    assertProjectId('spec.project_id', spec.project_id, options.projectId);
    const gateBApproval = spec.approval === 'approved'
      ? gateArtifactApprovalState(decisions, root, paths.specJson)
      : null;
    result.spec = spec;
    result.gates.b = {
      present: true,
      valid: true,
      passed: (
        spec.approval === 'approved'
        && spec.open_decisions.length === 0
        && gateBApproval.approved
      ),
    };
  }

  const gateCKeys = ['taskGraph'];
  const gateCExisting = filesExist(paths, gateCKeys);
  if (gateCExisting.length) {
    if (!result.spec) throw new ValidationError('Gate C cannot be validated before Gate B spec exists');
    requireGateFiles(paths, gateCKeys, 'Gate C');
    const taskGraph = validateTaskGraph(paths.taskGraph, paths.specJson, {
      constitutionPath,
      projectId: options.projectId,
    });
    assertProjectId('taskGraph.projectId', taskGraph.projectId, options.projectId);
    result.taskGraph = taskGraph;
    result.gates.c = { present: true, valid: true, passed: true };
  }

  result.readyForHandoff = (
    result.gates.a.passed
    && result.gates.b.passed
    && result.gates.c.passed
  );
  if (options.requireHandoffReady && !result.readyForHandoff) {
    const missing = [];
    if (!result.gates.b.present) missing.push('Gate B');
    if (!result.gates.c.present) missing.push('Gate C');
    const reasons = [];
    if (missing.length) reasons.push(`missing ${missing.join(', ')}`);
    if (!result.gates.a.passed) {
      reasons.push(
        gateAApproval?.source === 'decisions'
          ? `Gate A approval decision binding failed: ${gateAApproval.reason}`
          : 'Gate A intake is not approved',
      );
    }
    if (result.spec && !result.gates.b.passed) {
      const gateBApproval = result.spec.approval === 'approved'
        ? gateArtifactApprovalState(decisions, root, paths.specJson)
        : null;
      reasons.push(
        gateBApproval?.source === 'decisions' && !gateBApproval.approved
          ? `Gate B approval decision binding failed: ${gateBApproval.reason}`
          : 'spec is not approved or open_decisions is non-empty',
      );
    }
    throw new ValidationError(`artifact root is not handoff-ready: ${reasons.join('; ') || 'unknown gate state'}`);
  }
  return result;
}

export function validateHandoffReadyArtifactRoot(artifactRoot, options = {}) {
  return validateArtifactRoot(artifactRoot, { ...options, requireHandoffReady: true });
}

export function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node, stack) {
    if (visiting.has(node)) {
      const cycle = [...stack, node].join(' -> ');
      throw new ValidationError(`task graph contains a dependency cycle: ${cycle}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node)) {
      visit(dependency, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    visit(node, []);
  }
}

function optionalFixtureIntakeMd(fixturePath) {
  const candidate = path.join(fixturePath, 'intake.md');
  return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
}

export function validateFixtureDir(fixturePath) {
  const required = [
    ['intake.blocked.json', (artifactPath) => validateIntake(artifactPath)],
    ['intake.answered.json', (artifactPath) => validateIntake(artifactPath, { intakeMdPath: optionalFixtureIntakeMd(fixturePath) })],
    ['spec.approved.json', (artifactPath) => validateSpec(artifactPath, path.join(fixturePath, 'intake.answered.json'))],
    ['task-graph.json', (artifactPath) => validateTaskGraph(artifactPath, path.join(fixturePath, 'spec.approved.json'))],
  ];
  for (const [filename, validator] of required) {
    const artifactPath = path.join(fixturePath, filename);
    try {
      readFileSync(artifactPath);
    } catch {
      throw new ValidationError(`fixture ${fixturePath} is missing ${filename}`);
    }
    validator(artifactPath);
  }
  const legacyReviewPath = path.join(fixturePath, 'review.json');
  if (existsSync(legacyReviewPath)) {
    validateReview(legacyReviewPath, { sourceSpec: 'spec.approved.json', sourceTaskGraph: 'task-graph.json' });
  }
  const reportPath = path.join(fixturePath, 'review-report.md');
  if (existsSync(reportPath)) assertFile(reportPath, 'review-report.md');
}

export function validateEntryDocument(entryPath) {
  const entry = inspectEntryDocument(entryPath);
  if (!entry.valid) {
    throw new ValidationError(entry.errors.join('; '));
  }
  console.log(`Plan2Agent entry validation passed: ${entry.path}`);
  console.log('- document: present and non-empty Markdown/text');
  console.log(entry.checks.scopeWhat
    ? '- scope: what will be built is described'
    : '- scope: confirm what will be built in the dialogue');
  console.log(`- limits: ${entry.webSourceCount} web source(s), ${entry.recommendationCount} recommendation(s)`);
  console.log(entry.referenceBundle
    ? `- references: ${entry.referenceBundle.referenceCount} hash-verified item(s) from ${entry.referenceBundle.path}`
    : '- references: no optional p2a-reference-bundle.json');
  console.log(`- provenance: ${entry.sourceKind === 'feature_radar_preflight'
    ? entry.checks.provenance
      ? 'Feature Radar handoff confirmed'
      : 'Feature Radar handoff requires confirmation'
    : 'user document'}`);
  for (const warning of entry.warnings) console.warn(`warning: ${warning}`);
  return entry;
}

function usage() {
  return [
    'Usage:',
    '  p2a validate [artifact options]',
    '',
    'Options:',
    '  --entry <path>                     Validate a Markdown/text entry document.',
    '  --artifact-root <dir>               Validate a Gate A-C artifact root.',
    '  --constitution <path>                Validate a project constitution.',
    '  --current-development-contract <path> Validate the canonical current execution contract.',
    '  --decisions [path]                   Validate a decision ledger; defaults to <artifact-root>/decisions.jsonl.',
    '  --require-approved-constitution      Require its Gate ② approval audit.',
    '  --project-id <id>                   Expected project id for --artifact-root.',
    '  --intake <path> [--intake-md <path>]',
    '  --status <path>',
    '  --spec <path>',
    '  --task-graph <path> [--require-approved-spec <path>]',
    '  --review <path> [--require-review-pass]',
    '  --visual-experience <path> | --visual-prototype <path> | --visual-review <path>',
    '  --acceptance-review <path>',
    '  --run <path> | --run-index <path> | --runs-dir <dir>',
    '  --milestone-review <path>',
    '  --skill-proposal <path>',
    '  --proposal-review <path>',
    '  --proposal-curation <path>',
    '  --proposal-patch-draft <path>',
    '  --proposal-draft-approval <path>',
    '  --eval-index <path>',
    '  --eval-digest <path>',
    '  --eval-maintenance-draft <path>',
    '  --eval-maintenance-apply-report <path>',
    '  --proposals-dir <dir>',
    '  --fixture-dir <dir>                 Validate a fixture directory. Repeatable.',
    '  --require-handoff-ready',
    '  --help, -h                          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { fixtureDir: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--entry') {
      args.entry = argv[++index];
      if (!args.entry) throw new ValidationError('--entry requires a document path');
    }
    else if (arg === '--intake') args.intake = argv[++index];
    else if (arg === '--intake-md') args.intakeMd = argv[++index];
    else if (arg === '--status') args.status = argv[++index];
    else if (arg === '--artifact-root' || arg === '--artifacts') args.artifactRoot = argv[++index];
    else if (arg === '--constitution') args.constitution = argv[++index];
    else if (arg === '--current-development-contract') args.currentDevelopmentContract = argv[++index];
    else if (arg === '--decisions') {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith('-')) {
        args.decisions = candidate;
        index += 1;
      } else {
        args.decisions = true;
      }
    }
    else if (arg === '--project-id') args.projectId = argv[++index];
    else if (arg === '--spec') args.spec = argv[++index];
    else if (arg === '--task-graph') args.taskGraph = argv[++index];
    else if (arg === '--review') args.review = argv[++index];
    else if (arg === '--visual-experience') args.visualExperience = argv[++index];
    else if (arg === '--visual-prototype') args.visualPrototype = argv[++index];
    else if (arg === '--visual-review') args.visualReview = argv[++index];
    else if (arg === '--acceptance-review') args.acceptanceReview = argv[++index];
    else if (arg === '--run') args.run = argv[++index];
    else if (arg === '--run-index') args.runIndex = argv[++index];
    else if (arg === '--runs-dir') args.runsDir = argv[++index];
    else if (arg === '--milestone-review') args.milestoneReview = argv[++index];
    else if (arg === '--skill-proposal') args.skillProposal = argv[++index];
    else if (arg === '--proposal-review') args.proposalReview = argv[++index];
    else if (arg === '--proposal-curation') args.proposalCuration = argv[++index];
    else if (arg === '--proposal-patch-draft') args.proposalPatchDraft = argv[++index];
    else if (arg === '--proposal-draft-approval') args.proposalDraftApproval = argv[++index];
    else if (arg === '--eval-index') args.evalIndex = argv[++index];
    else if (arg === '--eval-digest') args.evalDigest = argv[++index];
    else if (arg === '--eval-maintenance-draft') args.evalMaintenanceDraft = argv[++index];
    else if (arg === '--eval-maintenance-apply-report') args.evalMaintenanceApplyReport = argv[++index];
    else if (arg === '--proposals-dir') args.proposalsDir = argv[++index];
    else if (arg === '--require-approved-spec') args.requireApprovedSpec = argv[++index];
    else if (arg === '--require-handoff-ready') args.requireHandoffReady = true;
    else if (arg === '--require-approved-constitution') args.requireApprovedConstitution = true;
    else if (arg === '--require-review-pass') args.requireReviewPass = true;
    else if (arg === '--fixture-dir') args.fixtureDir.push(argv[++index]);
    else throw new ValidationError(`unrecognized argument: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.entry) validateEntryDocument(args.entry);
    if (args.currentDevelopmentContract) {
      validateCurrentDevelopmentContract(args.currentDevelopmentContract, {
        projectId: args.projectId,
      });
    }
    if (args.constitution) {
      validateConstitution(args.constitution, {
        requireApproved: args.requireApprovedConstitution,
        projectId: args.projectId,
      });
    } else if (args.requireApprovedConstitution) {
      throw new ValidationError('--require-approved-constitution requires --constitution');
    }
    if (args.decisions) {
      const decisionsPath = args.decisions === true
        ? args.artifactRoot && path.join(path.resolve(args.artifactRoot), 'decisions.jsonl')
        : path.resolve(args.decisions);
      if (!decisionsPath) {
        throw new ValidationError('--decisions without a path requires --artifact-root or --artifacts');
      }
      validateDecisionLedger(decisionsPath);
    }
    if (args.status) validateStatusDoc(args.status);
    if (args.artifactRoot) {
      validateArtifactRoot(args.artifactRoot, {
        projectId: args.projectId,
        requireHandoffReady: args.requireHandoffReady,
        requireReviewPass: args.requireReviewPass,
        constitutionPath: args.constitution,
      });
    } else if (args.requireHandoffReady) {
      throw new ValidationError('--require-handoff-ready requires --artifact-root');
    }
    const specSourceIntakePath = args.spec && !args.intake
      ? requireSpecSourceIntake(args.spec)
      : null;
    const provenanceIntakePath = args.intake ?? specSourceIntakePath;
    const provenanceRoot = args.artifactRoot
      ?? (provenanceIntakePath
        ? inferArtifactRootFromIntakePath(provenanceIntakePath)
        : null);
    if (args.intake) {
      validateIntake(args.intake, {
        intakeMdPath: args.intakeMd ?? undefined,
        artifactRoot: provenanceRoot,
        requireBaselineContextArtifactRoot: true,
      });
    }
    else if (args.intakeMd) throw new ValidationError('--intake-md requires --intake');
    if (args.spec) {
      validateSpec(
        args.spec,
        args.intake ?? specSourceIntakePath,
        {
          artifactRoot: provenanceRoot,
          requireBaselineContextArtifactRoot: true,
          constitutionPath: args.constitution,
          projectId: args.projectId,
        },
      );
    }
    if (args.taskGraph) validateTaskGraph(args.taskGraph, args.requireApprovedSpec ?? null, {
      constitutionPath: args.constitution,
      projectId: args.projectId,
    });
    if (args.requireReviewPass && !args.review) {
      throw new ValidationError('--require-review-pass requires --review');
    }
    if (args.review) validateReview(args.review, null, { requirePass: args.requireReviewPass });
    if (args.visualExperience) validateVisualExperience(args.visualExperience);
    if (args.visualPrototype) validateVisualPrototype(args.visualPrototype);
    if (args.visualReview) validateVisualReview(args.visualReview);
    if (args.acceptanceReview) validateAcceptanceReview(args.acceptanceReview);
    if (args.run) validateRun(args.run);
    if (args.runIndex) validateRunIndex(args.runIndex);
    if (args.runsDir) validateRunsDir(args.runsDir);
    if (args.milestoneReview) validateMilestoneReview(args.milestoneReview);
    if (args.skillProposal) validateSkillProposal(args.skillProposal);
    if (args.proposalReview) validateProposalReview(args.proposalReview);
    if (args.proposalCuration) validateProposalCuration(args.proposalCuration);
    if (args.proposalPatchDraft) validateProposalPatchDraft(args.proposalPatchDraft);
    if (args.proposalDraftApproval) validateProposalDraftApproval(args.proposalDraftApproval);
    if (args.evalIndex) validateEvalIndex(args.evalIndex);
    if (args.evalDigest) validateEvalDigest(args.evalDigest);
    if (args.evalMaintenanceDraft) validateEvalMaintenanceDraft(args.evalMaintenanceDraft);
    if (args.evalMaintenanceApplyReport) validateEvalMaintenanceApplyReport(args.evalMaintenanceApplyReport);
    if (args.proposalsDir) validateProposalsDir(args.proposalsDir);
    for (const fixtureDir of args.fixtureDir) validateFixtureDir(fixtureDir);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ValidationError || error.code) {
      console.error(`validation failed: ${error.message}`);
      return 1;
    }
    throw error;
  }

  console.log('Plan2Agent artifact validation passed');
  return 0;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
