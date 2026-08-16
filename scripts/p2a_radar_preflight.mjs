import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePath } from './p2a_paths.mjs';

export const FEATURE_RADAR_PREFLIGHT_DIR = 'preflight-research';

export const FEATURE_RADAR_COPY_FILES = [
  'research-plan.md',
  'source-candidates.md',
  'research-bundle.md',
  'signal-map.md',
  'collection-report.md',
  'local-project-scan.md',
  'capability-gap-analysis.md',
  'next-iteration-recommendations.md',
  'p2a-context.json',
  'handoff-manifest.md',
];

export const MAX_WEB_SOURCES = 12;
export const MAX_RECOMMENDATIONS = 8;
const RECOMMENDATION_FILES = new Set([
  'next-iteration-recommendations.md',
  'collection-report.md',
  'p2a-context.json',
]);
const REFERENCE_BUNDLE_FILENAME = 'p2a-reference-bundle.json';
const REFERENCE_BUNDLE_KINDS = new Set([
  'html',
  'test',
  'code',
  'schema',
  'data',
  'image',
  'design',
  'rubric',
  'document',
  'other',
]);

const LOCAL_USED_FOR = {
  'research-plan.md': 'Feature Radar research scope and questions for Gate A/B grounding.',
  'source-candidates.md': 'Feature Radar source registry for Gate B evidence review.',
  'research-bundle.md': 'Feature Radar analysis body behind the Gate B recommendation.',
  'signal-map.md': 'Feature Radar evidence map for product and technical signals.',
  'collection-report.md': 'Feature Radar actionable synthesis for Gate A/B scoping.',
  'local-project-scan.md': 'Feature Radar read-only local project scan for capability fit.',
  'capability-gap-analysis.md': 'Feature Radar comparison of local capabilities against external signals.',
  'next-iteration-recommendations.md': 'Feature Radar prioritized enhancement candidates for iteration planning.',
  'p2a-context.json': 'Structured Feature Radar context prepared for P2A ingestion.',
  'handoff-manifest.md': 'Feature Radar handoff provenance for the copied preflight research.',
};

function isDirectory(filePath) {
  return existsSync(filePath) && lstatSync(filePath).isDirectory();
}

function isFile(filePath) {
  return existsSync(filePath) && lstatSync(filePath).isFile();
}

function displayRef(artifactRoot, filePath) {
  const relative = path.relative(artifactRoot, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizePath(relative);
  }
  return normalizePath(filePath);
}

function featureRadarFiles(runDir) {
  return FEATURE_RADAR_COPY_FILES
    .filter((fileName) => isFile(path.join(runDir, fileName)))
    .map((fileName) => ({
      name: fileName,
      path: path.join(runDir, fileName),
    }));
}

function hasFeatureRadarArtifacts(runDir) {
  return featureRadarFiles(runDir).length > 0;
}

function projectRootForArtifactRoot(artifactRoot) {
  let current = path.resolve(artifactRoot);
  while (true) {
    if (path.basename(current) === '.plan2agent') return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (isDirectory(path.join(artifactRoot, '.plan2agent'))) return artifactRoot;
  return null;
}

function addCandidateRun(runs, seen, artifactRoot, runDir, sourceKind, slug = null) {
  if (!isDirectory(runDir) || !hasFeatureRadarArtifacts(runDir)) return;
  const key = path.resolve(runDir);
  if (seen.has(key)) return;
  seen.add(key);
  const files = featureRadarFiles(runDir);
  runs.push({
    source_kind: sourceKind,
    slug,
    path: runDir,
    ref: displayRef(artifactRoot, runDir),
    files: files.map((file) => ({
      ...file,
      ref: displayRef(artifactRoot, file.path),
    })),
  });
}

export function discoverFeatureRadarPreflightRuns(artifactRoot, options = {}) {
  const runs = [];
  const seen = new Set();
  const preflightRoot = path.join(artifactRoot, FEATURE_RADAR_PREFLIGHT_DIR);
  addCandidateRun(
    runs,
    seen,
    artifactRoot,
    preflightRoot,
    'p2a-preflight',
  );
  if (isDirectory(preflightRoot)) {
    const sequences = readdirSync(preflightRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const sequence of sequences) {
      addCandidateRun(
        runs,
        seen,
        artifactRoot,
        path.join(preflightRoot, sequence.name),
        'p2a-preflight',
        sequence.name,
      );
    }
  }

  const projectRoot = projectRootForArtifactRoot(artifactRoot);
  if (projectRoot) {
    if (options.projectId) {
      addCandidateRun(
        runs,
        seen,
        artifactRoot,
        path.join(projectRoot, '.plan2agent', 'artifacts', options.projectId, FEATURE_RADAR_PREFLIGHT_DIR),
        'p2a-preflight',
      );
    }
    if (runs.length || options.includeNative !== true) {
      return runs;
    }
    const nativeRunsRoot = path.join(projectRoot, '.feature-radar', 'runs');
    if (isDirectory(nativeRunsRoot)) {
      const entries = readdirSync(nativeRunsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        addCandidateRun(
          runs,
          seen,
          artifactRoot,
          path.join(nativeRunsRoot, entry.name),
          'radar-native',
          entry.name,
        );
      }
    }
  }

  return runs;
}

function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maxLength = 220) {
  const text = stripMarkdown(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function inspectReferenceBundle(entryPath, options = {}) {
  const bundlePath = options.referenceBundlePath
    ? path.resolve(options.baseDir ?? process.cwd(), options.referenceBundlePath)
    : path.join(path.dirname(entryPath), REFERENCE_BUNDLE_FILENAME);
  let bundleStat;
  try {
    bundleStat = lstatSync(bundlePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return {
      path: bundlePath,
      sha256: null,
      valid: false,
      errors: [`reference bundle metadata is unreadable: ${bundlePath}`],
      references: [],
    };
  }
  if (!bundleStat.isFile()) {
    return {
      path: bundlePath,
      sha256: null,
      valid: false,
      errors: [`reference bundle must be a regular file and must not be a symbolic link: ${bundlePath}`],
      references: [],
    };
  }

  const errors = [];
  const data = readJson(bundlePath);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      path: bundlePath,
      sha256: fileSha256(bundlePath),
      valid: false,
      errors: [`reference bundle is not readable JSON: ${bundlePath}`],
      references: [],
    };
  }
  if (data.schema_version !== 'p2a.reference_bundle.v1') {
    errors.push('reference bundle must use schema_version p2a.reference_bundle.v1');
  }
  const unknownBundleKeys = Object.keys(data).filter((key) => !['schema_version', 'entry', 'references'].includes(key));
  if (unknownBundleKeys.length) errors.push(`reference bundle has unknown field(s): ${unknownBundleKeys.join(', ')}`);
  if (typeof data.entry !== 'string' || !data.entry.trim()) {
    errors.push('reference bundle entry must be a non-empty relative path');
  } else if (path.isAbsolute(data.entry)) {
    errors.push('reference bundle entry must be relative to the bundle');
  } else {
    const declaredEntry = path.resolve(path.dirname(bundlePath), data.entry);
    if (declaredEntry !== path.resolve(entryPath)) {
      errors.push(`reference bundle entry must resolve to ${path.basename(entryPath)}`);
    }
  }

  const rawReferences = Array.isArray(data.references) ? data.references : [];
  if (!rawReferences.length || rawReferences.length > 64) {
    errors.push('reference bundle references must contain between 1 and 64 items');
  }
  const defaultReferenceRoot = isWithin(process.cwd(), entryPath)
    ? process.cwd()
    : path.dirname(entryPath);
  const referenceRoot = path.resolve(options.referenceRoot ?? options.baseDir ?? defaultReferenceRoot);
  let canonicalReferenceRoot = null;
  try {
    canonicalReferenceRoot = realpathSync(referenceRoot);
  } catch {
    errors.push(`project reference root is missing or unreadable: ${referenceRoot}`);
  }
  const seenIds = new Set();
  const seenPaths = new Set();
  const references = [];
  for (const item of rawReferences) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push('reference bundle items must be objects');
      continue;
    }
    const id = typeof item.id === 'string' ? item.id : '';
    const referencePath = typeof item.path === 'string' ? item.path : '';
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const sha256 = typeof item.sha256 === 'string' ? item.sha256 : '';
    const loadWhen = typeof item.load_when === 'string' ? item.load_when.trim() : '';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const unknownItemKeys = Object.keys(item).filter((key) => ![
      'id',
      'path',
      'kind',
      'sha256',
      'load_when',
      'description',
    ].includes(key));
    if (unknownItemKeys.length) errors.push(`reference ${id || '<missing>'} has unknown field(s): ${unknownItemKeys.join(', ')}`);
    if (!/^REF-[1-9][0-9]*$/.test(id) || seenIds.has(id)) {
      errors.push(`reference id must be a unique REF-n value: ${id || '<missing>'}`);
      continue;
    }
    seenIds.add(id);
    if (!referencePath || path.isAbsolute(referencePath)) {
      errors.push(`reference ${id} path must be relative to the bundle`);
      continue;
    }
    const resolvedPath = path.resolve(path.dirname(bundlePath), referencePath);
    if (!isWithin(referenceRoot, resolvedPath)) {
      errors.push(`reference ${id} escapes the project reference root: ${referencePath}`);
      continue;
    }
    const normalizedPath = normalizePath(path.relative(referenceRoot, resolvedPath));
    if (seenPaths.has(normalizedPath)) {
      errors.push(`reference path is declared more than once: ${referencePath}`);
      continue;
    }
    seenPaths.add(normalizedPath);
    if (!REFERENCE_BUNDLE_KINDS.has(kind)) errors.push(`reference ${id} has unsupported kind: ${kind}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) errors.push(`reference ${id} sha256 must be lowercase hexadecimal`);
    if (!loadWhen) errors.push(`reference ${id} load_when must be non-empty`);
    if (!description) errors.push(`reference ${id} description must be non-empty`);
    if (!isFile(resolvedPath)) {
      errors.push(`reference ${id} is missing or not a regular file: ${referencePath}`);
      continue;
    }
    if (!canonicalReferenceRoot) continue;
    let canonicalResolvedPath;
    try {
      canonicalResolvedPath = realpathSync(resolvedPath);
    } catch {
      errors.push(`reference ${id} is missing or unreadable: ${referencePath}`);
      continue;
    }
    if (!isWithin(canonicalReferenceRoot, canonicalResolvedPath)) {
      errors.push(`reference ${id} escapes the project reference root through a symbolic link: ${referencePath}`);
      continue;
    }
    const actualSha256 = fileSha256(resolvedPath);
    if (actualSha256 !== sha256) errors.push(`reference ${id} sha256 does not match ${referencePath}`);
    references.push({
      id,
      path: normalizedPath,
      kind,
      sha256,
      loadWhen,
      description,
      bytes: lstatSync(resolvedPath).size,
    });
  }
  return {
    path: bundlePath,
    sha256: fileSha256(bundlePath),
    valid: errors.length === 0,
    errors,
    references,
  };
}

function extractUrls(text) {
  const urls = [];
  const seen = new Set();
  const regex = /https?:\/\/[^\s<>"')\]]+/g;
  for (const match of String(text ?? '').matchAll(regex)) {
    const url = match[0].replace(/[),.;\]]+$/g, '');
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    return lastSegment
      ? `${parsed.hostname} ${lastSegment.replace(/[-_]/g, ' ')}`
      : parsed.hostname;
  } catch {
    return url;
  }
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripMarkdown(cell));
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function recommendationFromObject(item, sourcePath) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = truncate(item.recommendation ?? item.title ?? item.name ?? item.summary);
  if (!title) return null;
  const why = truncate(item.why_now ?? item.rationale ?? item.reason ?? item.expected_impact ?? item.impact ?? '');
  return {
    title,
    action: truncate(item.action ?? item.type ?? ''),
    why,
    confidence: truncate(item.confidence ?? ''),
    sourcePath,
  };
}

function extractStructuredRecommendations(data, sourcePath) {
  if (!data || typeof data !== 'object') return [];
  const arrays = [
    data.recommendations,
    data.next_iteration_recommendations,
    data.enhancement_candidates,
    data.candidates,
  ].filter(Array.isArray);
  return arrays.flatMap((items) => items
    .map((item) => recommendationFromObject(item, sourcePath))
    .filter(Boolean));
}

function extractStructuredWebSources(data, sourcePath) {
  if (!data || typeof data !== 'object') return [];
  const arrays = [
    data.evidence,
    data.sources,
    data.source_candidates,
    data.web_sources,
  ].filter(Array.isArray);
  return arrays.flatMap((items) => items
    .filter((item) => item && typeof item === 'object' && typeof item.url === 'string' && item.url.startsWith('http'))
    .map((item) => ({
      title: truncate(item.title ?? item.name ?? titleFromUrl(item.url), 120),
      url: item.url,
      used_for: truncate(item.used_for ?? item.summary ?? item.claim ?? `Feature Radar structured source from ${path.basename(sourcePath)}.`, 240),
    })));
}

function extractMarkdownTableRecommendations(text, sourcePath) {
  const recommendations = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let header = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      header = null;
      continue;
    }
    const cells = splitMarkdownRow(line);
    if (!cells.length) continue;
    if (!header) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    const recIndex = header.findIndex((cell) => cell.includes('recommendation') || cell.includes('candidate') || cell.includes('feature'));
    if (recIndex === -1) continue;
    const title = truncate(cells[recIndex]);
    if (!title) continue;
    const column = (names) => {
      const index = header.findIndex((cell) => names.some((name) => cell.includes(name)));
      return index >= 0 ? truncate(cells[index]) : '';
    };
    recommendations.push({
      title,
      action: column(['action']),
      why: column(['why', 'impact', 'rationale', 'reason']),
      confidence: column(['confidence']),
      sourcePath,
    });
  }
  return recommendations;
}

function extractBulletRecommendations(text, sourcePath) {
  const recommendations = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/);
    if (!match) continue;
    const title = truncate(match[1]);
    if (!title || title.toLowerCase() === 'none') continue;
    recommendations.push({
      title,
      action: '',
      why: '',
      confidence: '',
      sourcePath,
    });
  }
  return recommendations;
}

function extractMarkdownRecommendations(text, sourcePath) {
  const tableRecommendations = extractMarkdownTableRecommendations(text, sourcePath);
  if (tableRecommendations.length) return tableRecommendations;
  return extractBulletRecommendations(text, sourcePath);
}

const ENTRY_TEXT_EXTENSIONS = new Set(['', '.md', '.markdown', '.txt', '.text']);
const ENTRY_WHAT_PATTERN = new RegExp([
  '\\b(?:build|create|develop|implement|introduce|add|improve|provide|support|design|ship|launch|show|track|manage|monitor|automate|visualize|analyse|analyze|notify|collect)\\b',
  '\\b(?:app|application|service|tool|cli|api|system|feature|platform|dashboard|extension|plugin|library|adapter|website|workflow|page|screen|console|bot|sdk|module|portal|ui|client|worker|pipeline)\\b',
  '(?:만들|개발|구현|구축|도입|추가|개선|제공|지원|설계|출시|보여주|추적|관리|모니터|자동화|시각화|분석|알림|수집)',
  '(?:앱|애플리케이션|서비스|도구|기능|시스템|플랫폼|대시보드|확장|플러그인|라이브러리|어댑터|웹사이트|워크플로|화면|페이지|콘솔|봇|SDK|모듈|포털|UI|클라이언트|워커|파이프라인)',
].join('|'), 'i');

function uniqueUrls(text) {
  return [...new Set(extractUrls(text))];
}

function isReferenceListItem(recommendation) {
  const title = stripMarkdown(recommendation?.title).trim();
  return /^(?:source|evidence|reference)\b|^(?:출처|근거|참고)(?:\s|[:：])/i.test(title);
}

function manifestHeaders(text) {
  const headers = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z0-9_-]*):\s*(.*?)\s*$/i);
    if (match && !headers.has(match[1])) headers.set(match[1], match[2]);
  }
  return headers;
}

function radarEntryMetadata(entryPath) {
  const resolved = path.resolve(entryPath);
  const segments = resolved.split(path.sep);
  const preflightIndex = segments.lastIndexOf(FEATURE_RADAR_PREFLIGHT_DIR);
  if (preflightIndex === -1 || preflightIndex >= segments.length - 1) return null;
  const sequence = preflightIndex < segments.length - 2
    ? segments[preflightIndex + 1]
    : null;
  return {
    sequence,
    manifestPath: path.join(path.dirname(resolved), 'handoff-manifest.md'),
  };
}

function radarProvenanceWarnings(entryPath, metadata) {
  if (!metadata) return [];
  if (!isFile(metadata.manifestPath)) {
    return [`Feature Radar entry requires sibling handoff-manifest.md: ${metadata.manifestPath}`];
  }
  const manifest = readText(metadata.manifestPath);
  if (!manifest.trim()) {
    return [`Feature Radar handoff manifest is empty: ${metadata.manifestPath}`];
  }
  const headers = manifestHeaders(manifest);
  const errors = [];
  const handoffMode = headers.get('handoff_mode') ?? headers.get('mode');
  if (handoffMode !== 'p2a-preflight') {
    errors.push('Feature Radar handoff manifest must declare handoff_mode: p2a-preflight');
  }
  if (!headers.get('source_run')) {
    errors.push('Feature Radar handoff manifest must record source_run');
  }
  if (
    metadata.sequence
    && headers.get('preflight_sequence') !== metadata.sequence
  ) {
    errors.push(
      `Feature Radar handoff manifest preflight_sequence must match ${metadata.sequence}`,
    );
  }
  const entryName = path.basename(entryPath);
  if (!new RegExp(`^\\s*-\\s+${entryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(manifest)) {
    errors.push(`Feature Radar handoff manifest Copied Files must include ${entryName}`);
  }
  return errors;
}

function entryWhatIsDescribed(text) {
  const normalized = stripMarkdown(text);
  return normalized.length >= 12 && ENTRY_WHAT_PATTERN.test(normalized);
}

export function inspectEntryDocument(entryPath, options = {}) {
  const resolvedPath = path.resolve(options.baseDir ?? process.cwd(), entryPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  const radar = radarEntryMetadata(resolvedPath);
  const errors = [];
  const warnings = [];
  let text = '';
  if (!isFile(resolvedPath)) {
    errors.push(`entry document is missing or not a file: ${resolvedPath}`);
  } else if (!ENTRY_TEXT_EXTENSIONS.has(extension)) {
    errors.push(`entry document must be Markdown or text: ${resolvedPath}`);
  } else {
    text = readText(resolvedPath);
    if (!text.trim()) errors.push(`entry document is empty: ${resolvedPath}`);
  }
  const whatDescribed = Boolean(text.trim()) && entryWhatIsDescribed(text);
  if (text.trim() && !whatDescribed) {
    warnings.push(
      'entry document may not state what will be built; confirm the scope in the dialogue',
    );
  }
  const provenanceIssues = radarProvenanceWarnings(resolvedPath, radar);
  warnings.push(...provenanceIssues);
  const referenceBundle = inspectReferenceBundle(resolvedPath, options);
  if (referenceBundle && !referenceBundle.valid) errors.push(...referenceBundle.errors);

  const webSourceCount = uniqueUrls(text).length;
  const recommendationCount = extractMarkdownRecommendations(text, resolvedPath)
    .filter((recommendation) => !isReferenceListItem(recommendation))
    .length;
  if (webSourceCount > MAX_WEB_SOURCES) {
    warnings.push(
      `entry document contains ${webSourceCount} web sources; only the first ${MAX_WEB_SOURCES} are promoted and the original remains a reference`,
    );
  }
  if (recommendationCount > MAX_RECOMMENDATIONS) {
    warnings.push(
      `entry document contains ${recommendationCount} recommendations; only the first ${MAX_RECOMMENDATIONS} are promoted and the original remains a reference`,
    );
  }
  const manifestText = radar && isFile(radar.manifestPath)
    ? readText(radar.manifestPath)
    : '';
  const sourceComplete = radar
    ? manifestHeaders(manifestText).get('source_complete') !== 'false'
    : null;
  if (radar && sourceComplete === false) {
    warnings.push('Feature Radar handoff manifest reports source_complete=false');
  }

  return {
    path: resolvedPath,
    sourceKind: radar ? 'feature_radar_preflight' : 'user_document',
    selection: options.selection ?? 'explicit',
    sequence: radar?.sequence ?? null,
    manifestPath: radar?.manifestPath ?? null,
    sourceComplete,
    valid: errors.length === 0,
    errors,
    warnings,
    checks: {
      document: isFile(resolvedPath) && ENTRY_TEXT_EXTENSIONS.has(extension) && Boolean(text.trim()),
      scopeWhat: whatDescribed,
      limits: true,
      provenance: provenanceIssues.length === 0,
      references: referenceBundle ? referenceBundle.valid : true,
    },
    webSourceCount,
    recommendationCount,
    referenceBundle: referenceBundle ? {
      path: referenceBundle.path,
      sha256: referenceBundle.sha256,
      valid: referenceBundle.valid,
      referenceCount: referenceBundle.references.length,
      references: referenceBundle.references,
    } : null,
  };
}

function isExistingProjectRecommendation(filePath, run) {
  const text = readText(filePath);
  if (/^(?:run_)?mode:\s*existing-project\s*$/im.test(text)) return true;
  const manifestPath = path.join(run.path, 'handoff-manifest.md');
  const headers = manifestHeaders(readText(manifestPath));
  return headers.get('run_mode') === 'existing-project';
}

export function discoverEntryDocument(artifactRoot, options = {}) {
  if (options.entryPath) {
    return inspectEntryDocument(options.entryPath, {
      baseDir: options.baseDir,
      selection: 'explicit',
    });
  }
  const runs = discoverFeatureRadarPreflightRuns(artifactRoot, {
    projectId: options.projectId,
    includeNative: false,
  }).filter((run) => run.source_kind === 'p2a-preflight');
  const latest = runs.at(-1);
  if (!latest) return null;
  const collection = latest.files.find((file) => file.name === 'collection-report.md');
  if (collection) {
    return inspectEntryDocument(collection.path, {
      baseDir: options.baseDir,
      referenceRoot: options.referenceRoot,
      selection: 'auto',
    });
  }
  const recommendations = latest.files.find(
    (file) => file.name === 'next-iteration-recommendations.md',
  );
  if (
    recommendations
    && (
      options.repeatedDevelopment === true
      || isExistingProjectRecommendation(recommendations.path, latest)
    )
  ) {
    return inspectEntryDocument(recommendations.path, {
      baseDir: options.baseDir,
      referenceRoot: options.referenceRoot,
      selection: 'auto',
    });
  }
  return null;
}

function addUniqueBy(items, seen, keyFn, item) {
  const key = keyFn(item);
  if (!key || seen.has(key)) return;
  seen.add(key);
  items.push(item);
}

function recommendationDedupeKey(item) {
  return [
    stripMarkdown(item.title).toLowerCase(),
    stripMarkdown(item.action).toLowerCase(),
    stripMarkdown(item.why).toLowerCase(),
  ].join('\n');
}

export function loadFeatureRadarPreflight(artifactRoot, options = {}) {
  const runs = discoverFeatureRadarPreflightRuns(artifactRoot, options);
  const localSources = [];
  const webSources = [];
  const recommendations = [];
  const seenLocal = new Set();
  const seenWeb = new Set();
  const seenRecommendations = new Set();

  for (const run of runs) {
    for (const file of run.files) {
      addUniqueBy(localSources, seenLocal, (item) => item.path, {
        title: `Feature Radar ${file.name}`,
        path: file.path,
        ref: file.ref,
        used_for: LOCAL_USED_FOR[file.name] ?? `Feature Radar artifact ${file.name}.`,
      });

      const text = readText(file.path);
      if (file.name === 'p2a-context.json') {
        const data = readJson(file.path);
        for (const recommendation of extractStructuredRecommendations(data, file.path)) {
          addUniqueBy(recommendations, seenRecommendations, recommendationDedupeKey, recommendation);
        }
        for (const source of extractStructuredWebSources(data, file.path)) {
          addUniqueBy(webSources, seenWeb, (item) => item.url, source);
        }
      }

      if (RECOMMENDATION_FILES.has(file.name) && file.name !== 'p2a-context.json') {
        for (const recommendation of extractMarkdownRecommendations(text, file.path)) {
          addUniqueBy(recommendations, seenRecommendations, recommendationDedupeKey, recommendation);
        }
      }

      if (['source-candidates.md', 'signal-map.md', 'research-bundle.md', 'collection-report.md', 'p2a-context.json'].includes(file.name)) {
        for (const url of extractUrls(text)) {
          addUniqueBy(webSources, seenWeb, (item) => item.url, {
            title: `Feature Radar source: ${titleFromUrl(url)}`,
            url,
            used_for: `Imported from Feature Radar ${file.name} for Gate B evidence review.`,
          });
          if (webSources.length >= MAX_WEB_SOURCES) break;
        }
      }
    }
  }

  return {
    detected: runs.length > 0,
    runs,
    localSources,
    webSources: webSources.slice(0, MAX_WEB_SOURCES),
    recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS),
  };
}

function nextEvidenceNumber(existingEvidence, prefix) {
  let highest = 0;
  for (const item of existingEvidence ?? []) {
    const match = typeof item?.source_id === 'string' ? item.source_id.match(new RegExp(`^${prefix}-([0-9]+)$`)) : null;
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest + 1;
}

export function buildFeatureRadarEvidence(preflight, existingEvidence, options = {}) {
  const evidence = [];
  const sourceIdByPath = new Map();
  const sourceIdByUrl = new Map();
  let localIndex = nextEvidenceNumber(existingEvidence, 'LOCAL');
  let webIndex = nextEvidenceNumber(existingEvidence, 'WEB');
  const existingByUrl = new Map();
  for (const item of existingEvidence ?? []) {
    if (typeof item?.url === 'string' && item.url) existingByUrl.set(item.url, item.source_id);
  }

  for (const source of preflight.localSources ?? []) {
    if (existingByUrl.has(source.ref)) {
      sourceIdByPath.set(source.path, existingByUrl.get(source.ref));
      continue;
    }
    const item = {
      source_id: `LOCAL-${localIndex}`,
      title: source.title,
      url: source.ref,
      used_for: source.used_for,
    };
    localIndex += 1;
    evidence.push(item);
    sourceIdByPath.set(source.path, item.source_id);
  }

  if (options.includeWeb !== false) {
    for (const source of preflight.webSources ?? []) {
      if (existingByUrl.has(source.url)) {
        sourceIdByUrl.set(source.url, existingByUrl.get(source.url));
        continue;
      }
      const item = {
        source_id: `WEB-${webIndex}`,
        title: source.title,
        url: source.url,
        used_for: source.used_for,
      };
      webIndex += 1;
      evidence.push(item);
      sourceIdByUrl.set(source.url, item.source_id);
    }
  }

  return {
    evidence,
    sourceIdByPath,
    sourceIdByUrl,
  };
}

function nextRefNumber(existingCandidates) {
  let highest = 0;
  for (const candidate of existingCandidates ?? []) {
    const match = typeof candidate?.candidate_id === 'string' ? candidate.candidate_id.match(/^REF-([0-9]+)$/) : null;
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest + 1;
}

export function buildFeatureRadarReferenceCandidates(preflight, evidenceMap, existingCandidates = []) {
  const candidates = [];
  let refIndex = nextRefNumber(existingCandidates);
  const fallbackLocalSourceId = evidenceMap.sourceIdByPath.values().next().value;
  const recommendations = (preflight.recommendations ?? []).length
    ? preflight.recommendations
    : preflight.localSources
      .filter((source) => source.path.endsWith('collection-report.md') || source.path.endsWith('next-iteration-recommendations.md'))
      .slice(0, 2)
      .map((source) => ({
        title: source.title,
        why: source.used_for,
        action: '',
        confidence: '',
        sourcePath: source.path,
      }));

  for (const recommendation of recommendations.slice(0, MAX_RECOMMENDATIONS)) {
    const sourceId = evidenceMap.sourceIdByPath.get(recommendation.sourcePath) ?? fallbackLocalSourceId;
    if (!sourceId) continue;
    candidates.push({
      candidate_id: `REF-${refIndex}`,
      title: `Feature Radar: ${recommendation.title}`,
      source_id: sourceId,
      source_type: 'local_artifact',
      origin: 'feature_radar_preflight',
      summary: recommendation.why || recommendation.title,
      used_for: 'Imported as preflight research for Gate B scope and next-iteration review.',
      decision: 'context',
      rationale: 'Feature Radar recommendations are evidence-backed candidates; Gate B must mark them selected, deferred, or rejected before task generation.',
    });
    refIndex += 1;
  }
  return candidates;
}
