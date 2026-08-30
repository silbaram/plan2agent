/** Shared deterministic change-risk classification for verification and routing. */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { P2A_VERIFICATION_METADATA_REFS } from './p2a_run_paths.mjs';

const PROSE_DOCUMENT_EXTENSIONS = new Set([
  '.adoc',
  '.asciidoc',
  '.htm',
  '.html',
  '.md',
  '.mdx',
  '.rst',
  '.txt',
]);
const STATIC_DOCUMENT_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
]);
const DOCUMENT_EXTENSIONS = new Set([
  ...PROSE_DOCUMENT_EXTENSIONS,
  ...STATIC_DOCUMENT_EXTENSIONS,
]);
const ROOT_METADATA_NAMES = new Set([
  'readme',
  'changelog',
  'contributing',
  'license',
  'notice',
]);
const REVISION_SCAN_IGNORED_DIRECTORIES = new Set(['.git', '.plan2agent', 'node_modules']);

export const VERIFICATION_PROFILES = Object.freeze({
  docs_metadata: Object.freeze({
    id: 'docs_metadata',
    label: 'docs/metadata',
    requiredEvidence: 'current relevant verification',
    separateFinalRun: false,
  }),
  isolated_code: Object.freeze({
    id: 'isolated_code',
    label: 'isolated code',
    requiredEvidence: 'current product-revision full verification',
    separateFinalRun: false,
  }),
  high_risk_integration: Object.freeze({
    id: 'high_risk_integration',
    label: 'high-risk integration',
    requiredEvidence: 'canonical final full verification',
    separateFinalRun: true,
  }),
});

function normalizedRelativePath(value) {
  const candidate = String(value ?? '').trim().replaceAll('\\', '/');
  if (
    !candidate
    || candidate.includes('\0')
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)
    || /^[A-Za-z]:/u.test(candidate)
    || candidate.split('/').includes('..')
  ) return '';
  const normalized = path.posix.normalize(candidate).replace(/^\.\//, '').toLowerCase();
  return normalized === '.' ? '' : normalized;
}

function hasDocumentExtension(candidate) {
  return DOCUMENT_EXTENSIONS.has(path.posix.extname(candidate));
}

function isNamedMetadataDocument(candidate) {
  const basename = path.posix.basename(candidate);
  const [name] = basename.split('.');
  if (!ROOT_METADATA_NAMES.has(name)) return false;
  return basename === name || PROSE_DOCUMENT_EXTENSIONS.has(path.posix.extname(basename));
}

export function isDocsMetadataPath(value) {
  const candidate = normalizedRelativePath(value);
  if (!candidate) return false;
  return (candidate.startsWith('docs/') && hasDocumentExtension(candidate))
    || candidate.startsWith('.plan2agent/')
    || candidate.startsWith('.github/issue_template/')
    || candidate === '.github/pull_request_template.md'
    || isNamedMetadataDocument(candidate);
}

export function isHighRiskIntegrationPath(value) {
  const candidate = normalizedRelativePath(value);
  if (!candidate || isDocsMetadataPath(candidate)) return false;
  return candidate.startsWith('.github/workflows/')
    || /(?:^|\/)(?:api|auth|authentication|authorization|deploy|infra|integration|integrations|migrations?|permissions?|routes?|security|webhooks?)(?:\/|\.|-|_)/u.test(candidate)
    || /(?:^|\/)(?:dockerfile|compose\.ya?ml|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(candidate);
}

function relevantImplementationRuns(runs) {
  return (Array.isArray(runs) ? runs : []).filter((run) => (
    !run?.runKind
    && ['finished', 'failed', 'blocked'].includes(run?.status)
    && Array.isArray(run?.changedFiles)
  ));
}

export function classifyVerificationProfile(runs) {
  const implementationRuns = relevantImplementationRuns(runs);
  const recordedPaths = implementationRuns.flatMap((run) => run.changedFiles);
  const hasUnknownScope = implementationRuns.some((run) => run.changedFiles.length === 0);
  const hasUnreportedProductChange = implementationRuns.some((run) => {
    const productChanged = run.productChangeDetected === true
      || (
        typeof run.startProductRevisionSha256 === 'string'
        && typeof run.productRevisionSha256 === 'string'
        && run.startProductRevisionSha256 !== run.productRevisionSha256
      );
    return productChanged
      && !run.changedFiles.some((filePath) => !isDocsMetadataPath(filePath));
  });
  const invalidPaths = recordedPaths.filter((filePath) => !normalizedRelativePath(filePath));
  const changedFiles = [...new Set(
    recordedPaths.map(normalizedRelativePath).filter(Boolean),
  )];
  const productRuns = implementationRuns.filter((run) => (
    run.changedFiles.some((filePath) => !isDocsMetadataPath(filePath))
  ));
  const taskIds = new Set(productRuns.map((run) => run.taskId).filter(Boolean));
  const integratesWorktrees = productRuns.some((run) => (
    run.isolation?.mode && run.isolation.mode !== 'none'
  ));
  if (
    !hasUnknownScope
    && !hasUnreportedProductChange
    && invalidPaths.length === 0
    && changedFiles.length > 0
    && changedFiles.every(isDocsMetadataPath)
  ) {
    return {
      ...VERIFICATION_PROFILES.docs_metadata,
      changedFiles,
      reasons: ['all recorded changes are documentation or non-product metadata'],
    };
  }
  if (
    hasUnknownScope
    || hasUnreportedProductChange
    || invalidPaths.length > 0
    || changedFiles.length === 0
    || taskIds.size > 1
    || integratesWorktrees
    || changedFiles.some(isHighRiskIntegrationPath)
  ) {
    return {
      ...VERIFICATION_PROFILES.high_risk_integration,
      changedFiles,
      reasons: [
        ...(hasUnknownScope ? ['an implementation attempt has no recorded changed-file scope'] : []),
        ...(hasUnreportedProductChange
          ? ['the product revision changed but the implementation run reported only documentation or metadata paths']
          : []),
        ...(invalidPaths.length > 0 ? ['an unsafe or non-relative changed path was recorded'] : []),
        ...(changedFiles.length === 0 ? ['no changed-file scope was recorded'] : []),
        ...(taskIds.size > 1 ? ['multiple implementation tasks require integration'] : []),
        ...(integratesWorktrees ? ['implementation used isolated worktrees'] : []),
        ...(changedFiles.some(isHighRiskIntegrationPath) ? ['a changed path crosses an integration or security boundary'] : []),
      ],
    };
  }
  return {
    ...VERIFICATION_PROFILES.isolated_code,
    changedFiles,
    reasons: ['one canonical task changed code without a high-risk integration path'],
  };
}

export function productRevisionExcludedPaths(workspacePath) {
  const root = path.resolve(workspacePath);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];

  function visit(directory, prefix = '') {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const exclusions = [];
    let hasIncludedEntry = false;
    let hasDocumentationEntry = false;
    for (const entry of entries) {
      const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (REVISION_SCAN_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        const child = visit(absolutePath, relativePath);
        if (child.onlyDocumentation) {
          exclusions.push(absolutePath);
          hasDocumentationEntry = true;
        } else {
          exclusions.push(...child.exclusions);
          hasIncludedEntry = true;
          if (child.hasDocumentationEntry) hasDocumentationEntry = true;
        }
        continue;
      }
      // Do not turn a documentation symlink into an exclusion for its resolved
      // target elsewhere in the product tree.
      if (entry.isFile() && isDocsMetadataPath(relativePath)) {
        exclusions.push(absolutePath);
        hasDocumentationEntry = true;
      } else {
        hasIncludedEntry = true;
      }
    }
    return {
      exclusions,
      hasDocumentationEntry,
      onlyDocumentation: prefix !== ''
        && !hasIncludedEntry
        && (
          hasDocumentationEntry
          || prefix === 'docs'
          || prefix.startsWith('docs/')
          || prefix === '.github/issue_template'
          || prefix.startsWith('.github/issue_template/')
        ),
    };
  }

  return [
    path.join(root, '.plan2agent'),
    ...visit(root).exclusions,
  ];
}

export function docsMetadataFiles(workspacePath) {
  const root = path.resolve(workspacePath);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return [];
  const files = P2A_VERIFICATION_METADATA_REFS.filter((relativePath) => {
    const filePath = path.join(root, ...relativePath.split('/'));
    return existsSync(filePath) && lstatSync(filePath).isFile();
  });

  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && REVISION_SCAN_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile() && isDocsMetadataPath(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  visit(root);
  return files;
}
