/** Select approved Plan2Agent planning Markdown for Memory synchronization. */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizePath } from './p2a_paths.mjs';
import { validateIntake, validateSpec } from './validate_artifacts.mjs';

export const PLANNING_DOCS_PROFILE = 'planning-docs';

const DOCUMENT_RULES = [
  {
    documentType: 'product_spec',
    gate: 'gate-b',
    markdownPath: path.join('gate-b-spec', 'product-spec.md'),
    canonicalJsonPath: path.join('gate-b-spec', 'spec.json'),
  },
  {
    documentType: 'implementation_plan',
    gate: 'gate-b',
    markdownPath: path.join('gate-b-spec', 'implementation-plan.md'),
    canonicalJsonPath: path.join('gate-b-spec', 'spec.json'),
  },
  {
    documentType: 'intake',
    gate: 'gate-a',
    markdownPath: path.join('gate-a-intake', 'intake.md'),
    canonicalJsonPath: path.join('gate-a-intake', 'intake.json'),
  },
];

function compareStable(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function artifactPathState(artifactRoot, filePath) {
  const root = path.resolve(artifactRoot);
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(root, resolvedPath);
  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    return { kind: 'outside_root', path: resolvedPath };
  }

  let currentPath = root;
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) return { kind: 'symlink', path: root };
    if (!rootStat.isDirectory()) return { kind: 'not_directory', path: root };
    const parts = relativePath.split(path.sep);
    for (const [index, part] of parts.entries()) {
      currentPath = path.join(currentPath, part);
      const stat = lstatSync(currentPath);
      if (stat.isSymbolicLink()) return { kind: 'symlink', path: currentPath };
      if (index < parts.length - 1 && !stat.isDirectory()) {
        return { kind: 'not_directory', path: currentPath };
      }
      if (index === parts.length - 1) {
        if (stat.isFile()) return { kind: 'file', path: currentPath };
        if (stat.isDirectory()) return { kind: 'directory', path: currentPath };
        return { kind: 'unsupported_entry', path: currentPath };
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', path: currentPath };
    throw error;
  }
  return { kind: 'missing', path: currentPath };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rawFileSha256(filePath) {
  return sha256(readFileSync(filePath));
}

function artifactRelativePath(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

function listArtifactEntries(artifactRoot) {
  const entriesFound = [];
  function visit(dirPath) {
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .sort((left, right) => compareStable(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else {
        entriesFound.push({
          filePath: entryPath,
          kind: entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'unsupported_entry',
        });
      }
    }
  }
  visit(artifactRoot);
  return entriesFound;
}

function assertSafeIterationId(iterationId, label) {
  if (
    typeof iterationId !== 'string'
    || !iterationId
    || iterationId === '.'
    || iterationId === '..'
    || !/^[A-Za-z0-9._-]+$/.test(iterationId)
  ) {
    throw new Error(`${label} must be a safe iteration ID, got ${JSON.stringify(iterationId)}`);
  }
  return iterationId;
}

function normalizedIterationIds(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const ids = values.map((value, index) => assertSafeIterationId(
    typeof value === 'string' ? value : value?.iteration_id,
    `${label}[${index}]`,
  ));
  return [...new Set(ids)].sort(compareStable);
}

function selectedIterationIds(activeIteration, archivedIterations) {
  const archived = normalizedIterationIds(archivedIterations, 'archivedIterations');
  if (activeIteration === null || activeIteration === undefined) return archived;
  const active = assertSafeIterationId(activeIteration, 'activeIteration');
  return [active, ...archived.filter((iterationId) => iterationId !== active)];
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function exclusionReason(sourcePath, context) {
  const normalized = normalizePath(sourcePath);
  const basename = path.posix.basename(normalized);
  if (normalized.startsWith('iterations/maintenance/')) return 'maintenance';
  const iterationMatch = /^iterations\/([^/]+)(?:\/|$)/.exec(normalized);
  if (iterationMatch && context.pendingIterations.has(iterationMatch[1])) return 'pending_iteration';
  if (iterationMatch && !context.selectedIterations.has(iterationMatch[1])) return 'unrecorded_iteration';
  if (/memory-(?:recall|status)|\.memory-recall\.json$/i.test(normalized)) return 'memory_recall';
  if (/(?:^|\/)runs?\//.test(normalized) || /run-(?:index|record)/i.test(basename)) return 'run_record';
  if (/gate-c-task-graph\/task-graph\.json$/.test(normalized)) return 'task_graph';
  if (/(?:^|\/)tasks?(?:\/|$)/i.test(normalized) || /^task(?:-|_).+\.json$/i.test(basename)) return 'task_record';
  if (/(?:^|\/)proposals?(?:\/|$)/i.test(normalized)) return 'proposal_record';
  if (/(?:^|\/)(?:gate-d-review|verification|acceptance|visual-review|visual-experience|milestone-reviews|evidence|tool-traces?|preflight)(?:\/|$)/i.test(normalized)) {
    return 'evidence_or_review';
  }
  if (/(?:^|\/)(?:handoff|baseline|snapshots?)(?:\/|$)/i.test(normalized)) return 'duplicate_copy';
  if (/(?:^|\/)(?:document-)?chunks?(?:\/|$)/i.test(normalized) || /(?:^|[._-])chunks?(?:[._-]|$)/i.test(basename)) return 'generated_chunk';
  if (normalized === 'status.md' || basename === 'status.md') return 'generated_index';
  if (['current-spec.json', 'iteration.json', 'spec.json', 'intake.json'].includes(basename)) {
    return 'canonical_validation_source';
  }
  if (DOCUMENT_RULES.some((rule) => path.posix.basename(rule.markdownPath) === basename)) {
    return 'non_canonical_copy';
  }
  return 'unsupported_artifact';
}

function reportDocument(document) {
  return {
    identity: document.identity,
    projectId: document.projectId,
    iterationId: document.iterationId,
    documentType: document.documentType,
    gate: document.gate,
    approval: document.approval,
    sourcePath: document.sourcePath,
    contentHash: `sha256:${document.contentHash}`,
    canonicalJsonPath: document.canonicalJsonPath,
    canonicalJsonHash: `sha256:${document.canonicalJsonHash}`,
  };
}

function excludedFile(sourcePath, reason, detail = null) {
  return {
    sourcePath,
    reason,
    ...(detail ? { detail } : {}),
  };
}

function portableDetail(artifactRoot, value) {
  const root = path.resolve(artifactRoot);
  return String(value)
    .replaceAll(root, '<artifact-root>')
    .replaceAll(normalizePath(root), '<artifact-root>');
}

function validateIterationGateB(specPath, artifactRoot) {
  const state = artifactPathState(artifactRoot, specPath);
  if (state.kind !== 'file') {
    const detail = state.kind === 'missing'
      ? 'canonical spec.json is missing'
      : `canonical spec.json is not a safe regular file (${state.kind})`;
    return { spec: null, error: detail };
  }
  try {
    return {
      spec: validateSpec(specPath, null, { artifactRoot }),
      error: null,
    };
  } catch (error) {
    return { spec: null, error: portableDetail(artifactRoot, errorMessage(error)) };
  }
}

function validateIterationGateA(intakePath, intakeMarkdownPath, artifactRoot) {
  const intakeState = artifactPathState(artifactRoot, intakePath);
  if (intakeState.kind !== 'file') {
    const detail = intakeState.kind === 'missing'
      ? 'canonical intake.json is missing'
      : `canonical intake.json is not a safe regular file (${intakeState.kind})`;
    return { intake: null, error: detail };
  }
  const markdownState = artifactPathState(artifactRoot, intakeMarkdownPath);
  try {
    return {
      intake: validateIntake(intakePath, {
        artifactRoot,
        intakeMdPath: markdownState.kind === 'file' ? intakeMarkdownPath : undefined,
      }),
      error: null,
    };
  } catch (error) {
    return { intake: null, error: portableDetail(artifactRoot, errorMessage(error)) };
  }
}

function planningDocument({
  artifactRoot,
  projectId,
  iterationId,
  rule,
  markdownPath,
  canonicalJsonPath,
}) {
  const rawContent = readFileSync(markdownPath);
  const content = rawContent.toString('utf8');
  const sourcePath = artifactRelativePath(artifactRoot, markdownPath);
  const canonicalSourcePath = artifactRelativePath(artifactRoot, canonicalJsonPath);
  return {
    identity: `${projectId}:${iterationId}:${rule.documentType}`,
    projectId,
    iterationId,
    documentType: rule.documentType,
    gate: rule.gate,
    approval: 'approved',
    absolutePath: markdownPath,
    sourcePath,
    content,
    contentHash: sha256(rawContent),
    canonicalJsonAbsolutePath: canonicalJsonPath,
    canonicalJsonPath: canonicalSourcePath,
    canonicalJsonHash: rawFileSha256(canonicalJsonPath),
  };
}

/**
 * Returns both upload candidates and a complete dry-run audit of every source file.
 * Only canonical files directly below iterations/<iteration-id> can be selected.
 */
export function selectPlanningDocuments({
  artifactRoot,
  projectId,
  activeIteration,
  archivedIterations = [],
  pendingIterations = [],
}) {
  const resolvedRoot = path.resolve(artifactRoot);
  let rootStat;
  try {
    rootStat = lstatSync(resolvedRoot);
  } catch {
    throw new Error(`planning-docs artifact root is not a directory: ${resolvedRoot}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`planning-docs artifact root must be a non-symlink directory: ${resolvedRoot}`);
  }
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('planning-docs projectId must be a non-empty string');
  }
  const iterationIds = selectedIterationIds(activeIteration, archivedIterations);
  const selectedIterations = new Set(iterationIds);
  const pendingIterationIds = new Set(normalizedIterationIds(pendingIterations, 'pendingIterations'));
  const allEntries = listArtifactEntries(resolvedRoot);
  const decisions = new Map();
  const documents = [];
  const identities = new Map();

  for (const entry of allEntries) {
    if (entry.kind !== 'symlink') continue;
    const sourcePath = artifactRelativePath(resolvedRoot, entry.filePath);
    decisions.set(sourcePath, excludedFile(sourcePath, 'symlink_not_allowed'));
  }

  function exclude(filePath, reason, detail = null) {
    decisions.set(
      artifactRelativePath(resolvedRoot, filePath),
      excludedFile(artifactRelativePath(resolvedRoot, filePath), reason, detail),
    );
  }

  function include(document) {
    const existing = identities.get(document.identity);
    if (existing) {
      const reason = existing.contentHash === document.contentHash
        ? 'duplicate_identity_and_hash'
        : 'duplicate_identity';
      exclude(document.absolutePath, reason, `selected canonical source: ${existing.sourcePath}`);
      return;
    }
    identities.set(document.identity, document);
    documents.push(document);
    decisions.set(document.sourcePath, null);
  }

  for (const iterationId of iterationIds) {
    const iterationRoot = path.join(resolvedRoot, 'iterations', iterationId);
    const iterationState = artifactPathState(resolvedRoot, iterationRoot);
    if (iterationState.kind !== 'directory') continue;
    const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const intakeMarkdownPath = path.join(iterationRoot, 'gate-a-intake', 'intake.md');
    const gateB = validateIterationGateB(specPath, resolvedRoot);
    const gateA = validateIterationGateA(intakePath, intakeMarkdownPath, resolvedRoot);

    for (const rule of DOCUMENT_RULES) {
      const markdownPath = path.join(iterationRoot, rule.markdownPath);
      const markdownState = artifactPathState(resolvedRoot, markdownPath);
      if (markdownState.kind !== 'file') continue;
      const canonicalJsonPath = path.join(iterationRoot, rule.canonicalJsonPath);
      if (rule.gate === 'gate-b') {
        if (gateB.error) {
          exclude(markdownPath, 'canonical_validation_failed', gateB.error);
          continue;
        }
        if (gateB.spec.project_id !== projectId) {
          exclude(
            markdownPath,
            'project_mismatch',
            `spec.project_id=${JSON.stringify(gateB.spec.project_id)} expected ${JSON.stringify(projectId)}`,
          );
          continue;
        }
        if (gateB.spec.approval !== 'approved') {
          exclude(markdownPath, 'gate_b_not_approved', `spec.approval=${gateB.spec.approval}`);
          continue;
        }
      } else {
        if (gateA.error) {
          exclude(markdownPath, 'canonical_validation_failed', gateA.error);
          continue;
        }
        if (gateA.intake.status !== 'ready_for_spec') {
          exclude(markdownPath, 'gate_a_not_complete', `intake.status=${gateA.intake.status}`);
          continue;
        }
      }
      const document = planningDocument({
        artifactRoot: resolvedRoot,
        projectId,
        iterationId,
        rule,
        markdownPath,
        canonicalJsonPath,
      });
      if (!document.content.trim()) {
        exclude(markdownPath, 'empty_document');
        continue;
      }
      include(document);
    }
  }

  const included = documents.map(reportDocument)
    .sort((left, right) => compareStable(left.sourcePath, right.sourcePath));
  const excluded = allEntries
    .map(({ filePath }) => {
      const sourcePath = artifactRelativePath(resolvedRoot, filePath);
      if (decisions.has(sourcePath)) return decisions.get(sourcePath);
      return excludedFile(sourcePath, exclusionReason(sourcePath, {
        pendingIterations: pendingIterationIds,
        selectedIterations,
      }));
    })
    .filter(Boolean)
    .sort((left, right) => compareStable(left.sourcePath, right.sourcePath));

  return {
    profile: PLANNING_DOCS_PROFILE,
    documents,
    included,
    excluded,
    summary: {
      scannedFiles: allEntries.length,
      includedFiles: included.length,
      excludedFiles: excluded.length,
      estimatedSnapshots: included.length,
      iterations: new Set(documents.map((document) => document.iterationId)).size,
    },
  };
}
