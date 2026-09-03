/** Preview and publish one P2A retrospective as a GitHub issue. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeProjectIdFromPath } from './p2a_paths.mjs';

export const P2A_GITHUB_REPOSITORY = 'silbaram/plan2agent';
const REPOSITORY_SELECTOR = `github.com/${P2A_GITHUB_REPOSITORY}`;
const REQUIRED_HEADINGS = [
  'Observed issue',
  'User impact',
  'Suggested improvement',
  'Evidence',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function headingsOutsideFences(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const match = /^ {0,3}##(?!#)[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match) headings.push({ name: match[1].replace(/[ \t]+#+[ \t]*$/, '').trim(), index });
  });
  return { headings, lines };
}

export function parseRetrospectiveMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.includes('\0')) {
    throw new Error('retrospective must be plain Markdown text');
  }
  const { headings, lines } = headingsOutsideFences(markdown);
  if (headings.length !== REQUIRED_HEADINGS.length
    || headings.some((heading, index) => heading.name !== REQUIRED_HEADINGS[index])) {
    throw new Error(`retrospective must contain these H2 sections in order: ${REQUIRED_HEADINGS.join(', ')}`);
  }
  return Object.fromEntries(headings.map((heading, index) => {
    const value = lines.slice(heading.index + 1, headings[index + 1]?.index ?? lines.length).join('\n').trim();
    if (!value) throw new Error(`${heading.name} must not be empty`);
    return [heading.name, value];
  }));
}

function firstLine(markdown) {
  const line = markdown.split('\n').map((value) => value.trim()).find(Boolean);
  if (!line) throw new Error('Observed issue must contain text');
  return line.replace(/^(?:[-+*]|\d+[.)])[ \t]+/, '').replace(/^\[[ xX]\][ \t]+/, '').trim();
}

function checklist(markdown) {
  const items = markdown.split('\n')
    .map((line) => /^(?:[-+*]|\d+[.)])[ \t]+(.+)$/.exec(line)?.[1]?.replace(/^\[[ xX]\][ \t]+/, '').trim())
    .filter(Boolean);
  return (items.length ? items : [firstLine(markdown)]).map((item) => `- [ ] ${item}`).join('\n');
}

function sourceProjectId(workspaceRoot) {
  for (const relativePath of ['.plan2agent/project.config.json', '.plan2agent/manifest.json']) {
    try {
      const value = JSON.parse(readFileSync(path.join(workspaceRoot, relativePath), 'utf8')).projectId;
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value ?? '')) return value;
    } catch {
      // Projects without P2A metadata use their directory name.
    }
  }
  return normalizeProjectIdFromPath(workspaceRoot);
}

function resolveRetrospective(workspaceRoot, input) {
  if (typeof input !== 'string' || path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new Error('--retrospective must be a project-relative Markdown path');
  }
  const relativePath = input.replaceAll('\\', '/');
  if (!relativePath.startsWith('docs/retrospective/')
    || !relativePath.toLowerCase().endsWith('.md')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('--retrospective must point below docs/retrospective/');
  }
  const root = realpathSync(workspaceRoot);
  const filePath = path.resolve(root, relativePath);
  if (!existsSync(filePath)) throw new Error('retrospective file does not exist');
  const realFile = realpathSync(filePath);
  if (!lstatSync(realFile).isFile()) throw new Error('retrospective must be a file');
  const contained = path.relative(root, realFile);
  if (contained.startsWith(`..${path.sep}`) || contained === '..' || path.isAbsolute(contained)) {
    throw new Error('retrospective must stay inside the project');
  }
  return { relativePath, filePath: realFile };
}

function containsSecret(text) {
  const patterns = [
    /-----BEGIN (?:PGP |RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
    /\b(?:gh[pousr]_|github_pat_|npm_|glpat-|sk_live_|rk_live_|whsec_|sntrys_|hf_|dckr_pat_|pypi-)[A-Za-z0-9_-]{16,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:AIza[0-9A-Za-z_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/,
    /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\b(?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*(?:session(?:id)?|auth(?:token)?|access[_-]?token)\s*=\s*[A-Za-z0-9._~+/-]{16,}/i,
    /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@[^\s/]+/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) return true;
  const assignment = /["']?([A-Za-z][A-Za-z0-9_-]{0,127})["']?\s*(?::|=)\s*["']?([^\s"'`,;}\]]+)/g;
  for (const match of text.matchAll(assignment)) {
    const key = match[1].toLowerCase().replaceAll('-', '_');
    if (/(?:^|_)(?:password|passwd|secret|token|credential|api_key|access_key|private_key)$/.test(key)
      && !/^(?:x+|\*+|redacted|masked|example|placeholder|changeme|none|null)$/i.test(match[2])) return true;
  }
  return false;
}

function assertPublicContentIsSafe(text) {
  if (containsSecret(text)) throw new Error('retrospective appears to contain a secret; public issue not created');
  if (/(?:^|[\s`'"(])\/(?:home|Users)\/[^/\s`'"()]+\//m.test(text)
    || /[A-Za-z]:[\\/]Users[\\/][^\\/\s`'"()]+[\\/]/.test(text)
    || /\\\\wsl(?:\.localhost)?\\[^\\\s]+\\home\\[^\\\s]+\\/i.test(text)) {
    throw new Error('retrospective contains an absolute user path; public issue not created');
  }
}

function issueTitle(observed, options) {
  if (options.title != null) {
    const title = options.title.trim();
    if (!title || /[\r\n\0]/.test(title) || title.length > 256) throw new Error('--title must be one line');
    return title;
  }
  const area = (options.targetArea ?? 'Process').trim();
  if (!area || /[\[\]\r\n\0]/.test(area)) throw new Error('--target-area must be one line without brackets');
  const title = `[Retrospective][${area}] ${firstLine(observed)}`;
  return title.length <= 256 ? title : `${title.slice(0, 255).trimEnd()}…`;
}

export function createGithubIssuePreview(retrospectivePath, options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const source = resolveRetrospective(workspaceRoot, retrospectivePath);
  const sections = parseRetrospectiveMarkdown(readFileSync(source.filePath, 'utf8'));
  const projectId = sourceProjectId(workspaceRoot);
  const key = sha256(JSON.stringify({ repo: P2A_GITHUB_REPOSITORY, projectId, path: source.relativePath })).slice(0, 12);
  const marker = `<!-- p2a-retrospective-issue:v1 key=${key} -->`;
  const title = issueTitle(sections['Observed issue'], options);
  const body = [
    '## 요약', firstLine(sections['Observed issue']),
    '## 관찰된 문제', sections['Observed issue'],
    '## 사용자 영향', sections['User impact'],
    '## 제안', sections['Suggested improvement'],
    '## 완료 조건', checklist(sections['Suggested improvement']),
    '## 근거', sections.Evidence,
    marker,
  ].join('\n\n') + '\n';
  assertPublicContentIsSafe(`${title}\n${body}`);
  return { source: `${projectId}:${source.relativePath}`, targetRepo: P2A_GITHUB_REPOSITORY, title, body, marker };
}

export function defaultGhRunner(argv, options) {
  return spawnSync('gh', argv, options);
}

function runGhOrThrow(runGh, argv, workspaceRoot, input, phase) {
  let result;
  try {
    result = runGh(argv, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      shell: false,
      input,
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_REPO: REPOSITORY_SELECTOR,
        GH_PROMPT_DISABLED: '1',
      },
    });
  } catch {
    throw new Error(`GitHub CLI failed during ${phase}`);
  }
  const status = Number.isInteger(result?.status) ? result.status : result?.exitCode;
  if (status !== 0) throw new Error(`GitHub CLI failed during ${phase}`);
  return result.stdout ?? '';
}

export function publishGithubIssue(issue, options = {}) {
  if (options.yes !== true) throw new Error('publish-issue requires --yes');
  assertPublicContentIsSafe(`${issue.title}\n${issue.body}`);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const runGh = options.runGh ?? defaultGhRunner;
  const key = /key=([a-f0-9]{12})/.exec(issue.marker)?.[1];
  if (!key || !issue.body.endsWith(`${issue.marker}\n`)) throw new Error('invalid issue marker');

  const listed = runGhOrThrow(runGh, [
    'issue', 'list',
    '--repo', REPOSITORY_SELECTOR,
    '--state', 'all',
    '--search', `${key} in:body`,
    '--limit', '20',
    '--json', 'number,url,state,body',
  ], workspaceRoot, undefined, 'duplicate lookup');
  let issues;
  try { issues = JSON.parse(listed || '[]'); } catch { throw new Error('GitHub CLI returned invalid issue data'); }
  if (!Array.isArray(issues)) throw new Error('GitHub CLI returned invalid issue data');
  const matches = issues.filter((candidate) => candidate?.body?.includes(issue.marker));
  if (matches.length > 1) throw new Error('multiple GitHub issues contain the retrospective marker');
  if (matches.length === 1) {
    return { action: 'duplicate', issue: { number: matches[0].number, url: matches[0].url } };
  }

  const created = runGhOrThrow(runGh, [
    'issue', 'create',
    '--repo', REPOSITORY_SELECTOR,
    '--title', issue.title,
    '--body-file', '-',
  ], workspaceRoot, issue.body, 'issue creation').trim();
  const match = /^https:\/\/github\.com\/silbaram\/plan2agent\/issues\/([1-9][0-9]*)\/?$/.exec(created);
  if (!match) throw new Error('GitHub CLI returned an unexpected issue URL');
  return { action: 'published', issue: { number: Number(match[1]), url: created.replace(/\/$/, '') } };
}
