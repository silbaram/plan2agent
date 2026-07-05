import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

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

const MAX_WEB_SOURCES = 12;
const MAX_RECOMMENDATIONS = 8;
const RECOMMENDATION_FILES = new Set([
  'next-iteration-recommendations.md',
  'collection-report.md',
  'p2a-context.json',
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

function normalizePath(filePath) {
  return String(filePath).split(path.sep).join('/');
}

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
  addCandidateRun(
    runs,
    seen,
    artifactRoot,
    path.join(artifactRoot, FEATURE_RADAR_PREFLIGHT_DIR),
    'p2a-preflight',
  );

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
