/** Select approved Plan2Agent planning Markdown for Memory synchronization. */

import { createHash } from 'node:crypto';
import {
  existsSync,
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

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
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

function listArtifactFiles(artifactRoot) {
  const files = [];
  function visit(dirPath) {
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  visit(artifactRoot);
  return files;
}

function iterationDirectories(artifactRoot, activeIteration) {
  const iterationsRoot = path.join(artifactRoot, 'iterations');
  if (!isDirectory(iterationsRoot)) return [];
  return readdirSync(iterationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => {
      if (left === activeIteration) return -1;
      if (right === activeIteration) return 1;
      return left.localeCompare(right);
    });
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function exclusionReason(sourcePath) {
  const normalized = normalizePath(sourcePath);
  const basename = path.posix.basename(normalized);
  if (normalized.startsWith('iterations/maintenance/')) return 'maintenance';
  if (/memory-(?:recall|status)|\.memory-recall\.json$/i.test(normalized)) return 'memory_recall';
  if (/(?:^|\/)runs?\//.test(normalized) || /run-(?:index|record)/i.test(basename)) return 'run_record';
  if (/gate-c-task-graph\/task-graph\.json$/.test(normalized)) return 'task_graph';
  if (/(?:^|\/)(?:gate-d-review|verification|acceptance|visual-review|visual-experience|milestone-reviews|evidence|tool-traces?|preflight)(?:\/|$)/i.test(normalized)) {
    return 'evidence_or_review';
  }
  if (/(?:^|\/)(?:handoff|baseline|snapshots?)(?:\/|$)/i.test(normalized)) return 'duplicate_copy';
  if (/(?:^|[._-])chunks?(?:[._-]|$)/i.test(basename)) return 'generated_chunk';
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

function validateIterationGateB(specPath, artifactRoot) {
  if (!isFile(specPath)) return { spec: null, error: 'canonical spec.json is missing' };
  try {
    return {
      spec: validateSpec(specPath, null, { artifactRoot }),
      error: null,
    };
  } catch (error) {
    return { spec: null, error: errorMessage(error) };
  }
}

function validateIterationGateA(intakePath, intakeMarkdownPath, artifactRoot) {
  if (!isFile(intakePath)) return { intake: null, error: 'canonical intake.json is missing' };
  try {
    return {
      intake: validateIntake(intakePath, {
        artifactRoot,
        intakeMdPath: isFile(intakeMarkdownPath) ? intakeMarkdownPath : undefined,
      }),
      error: null,
    };
  } catch (error) {
    return { intake: null, error: errorMessage(error) };
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
  const content = readFileSync(markdownPath, 'utf8');
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
    contentHash: sha256(content),
    canonicalJsonAbsolutePath: canonicalJsonPath,
    canonicalJsonPath: canonicalSourcePath,
    canonicalJsonHash: rawFileSha256(canonicalJsonPath),
  };
}

/**
 * Returns both upload candidates and a complete dry-run audit of every source file.
 * Only canonical files directly below iterations/<iteration-id> can be selected.
 */
export function selectPlanningDocuments({ artifactRoot, projectId, activeIteration }) {
  const resolvedRoot = path.resolve(artifactRoot);
  if (!isDirectory(resolvedRoot)) throw new Error(`planning-docs artifact root is not a directory: ${resolvedRoot}`);
  const allFiles = listArtifactFiles(resolvedRoot);
  const decisions = new Map();
  const documents = [];
  const identities = new Map();

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

  for (const iterationId of iterationDirectories(resolvedRoot, activeIteration)) {
    const iterationRoot = path.join(resolvedRoot, 'iterations', iterationId);
    if (iterationId === 'maintenance') continue;
    const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const intakeMarkdownPath = path.join(iterationRoot, 'gate-a-intake', 'intake.md');
    const gateB = validateIterationGateB(specPath, resolvedRoot);
    const gateA = validateIterationGateA(intakePath, intakeMarkdownPath, resolvedRoot);

    for (const rule of DOCUMENT_RULES) {
      const markdownPath = path.join(iterationRoot, rule.markdownPath);
      if (!isFile(markdownPath)) continue;
      const canonicalJsonPath = path.join(iterationRoot, rule.canonicalJsonPath);
      if (rule.gate === 'gate-b') {
        if (gateB.error) {
          exclude(markdownPath, 'canonical_validation_failed', gateB.error);
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
      include(planningDocument({
        artifactRoot: resolvedRoot,
        projectId,
        iterationId,
        rule,
        markdownPath,
        canonicalJsonPath,
      }));
    }
  }

  const included = documents.map(reportDocument)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const excluded = allFiles
    .map((filePath) => {
      const sourcePath = artifactRelativePath(resolvedRoot, filePath);
      if (decisions.has(sourcePath)) return decisions.get(sourcePath);
      return excludedFile(sourcePath, exclusionReason(sourcePath));
    })
    .filter(Boolean)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  return {
    profile: PLANNING_DOCS_PROFILE,
    documents,
    included,
    excluded,
    summary: {
      scannedFiles: allFiles.length,
      includedFiles: included.length,
      excludedFiles: excluded.length,
      estimatedSnapshots: included.length,
      iterations: new Set(documents.map((document) => document.iterationId)).size,
    },
  };
}
