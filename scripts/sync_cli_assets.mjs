#!/usr/bin/env node
/** Generate Plan2Agent CLI mirrors from canonical .agents sources. */

import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SKILL_SOURCE = path.join(ROOT, '.agents', 'skills');
const AGENT_SOURCE = path.join(ROOT, '.agents', 'agents');
const CAPABILITY_VALUES = new Set(['read', 'search', 'web', 'edit', 'shell']);
const ACCESS_VALUES = new Set(['read-only', 'workspace-write']);
const TIER_VALUES = new Set(['light', 'standard', 'heavy']);
const CLAUDE_TOOL_MAP = { read: ['Read'], search: ['Grep', 'Glob'], web: ['WebSearch', 'WebFetch'], edit: ['Edit', 'Write'], shell: ['Bash'] };
const GEMINI_TOOL_MAP = { read: ['read_file'], search: ['grep_search'], web: ['google_web_search', 'web_fetch'], edit: [], shell: [] };
const CLAUDE_TIER_MODEL = { light: 'haiku', standard: 'sonnet', heavy: 'opus' };
const CODEX_TIER_EFFORT = { light: 'low', standard: 'medium', heavy: 'high' };
const GEMINI_TIER_CONFIG = {
  light: { temperature: 0.1, max_turns: 6 },
  standard: { temperature: 0.2, max_turns: 10 },
  heavy: { temperature: 0.2, max_turns: 20 },
};
const GEMINI_COMMANDS = {
  harness: {
    skill: 'p2a-harness',
    description: 'Run the gated Plan2Agent harness on an idea, answers, or approved spec.',
    prompt: `Use the Plan2Agent p2a-harness skill for the following input:

{{args}}

Rules:
- Only write Plan2Agent planning artifacts under .plan2agent/artifacts/<project_id>/; never edit source code.
- Do not run mutating commands.
- Follow the stage-to-subagent mapping in the skill.
- Stop at intake if any needs_user_decision is open.
- Stop before task graph unless spec_json.approval is approved and open_decisions is empty.
- Return the named state sections required by the harness.`,
  },
  intake: {
    skill: 'p2a-intake',
    description: 'Run Plan2Agent intake on a one-sentence idea or resume answered decisions.',
    prompt: `Use the Plan2Agent p2a-intake skill for the following idea or resume context:

{{args}}

Return intake_json conforming to .plan2agent/schemas/intake.schema.json and a table of open needs_user_decision items when blocked.`,
  },
  review: {
    skill: 'p2a-review',
    description: 'Review Plan2Agent planning artifacts before implementation.',
    prompt: `Use the Plan2Agent p2a-review skill for the following planning artifacts:

{{args}}

Return review_report with blocking issues, non-blocking risks, missing acceptance criteria, oversized tasks, dependency issues, schema_or_gate_issues, and recommended changes.`,
  },
  spec: {
    skill: 'p2a-spec',
    description: 'Create a Plan2Agent product and implementation spec from answered intake.',
    prompt: `Use the Plan2Agent p2a-spec skill for the following context:

{{args}}

Return product_spec_markdown, implementation_plan_markdown, spec_json conforming to .plan2agent/schemas/spec.schema.json, and open_decisions. Keep approval as draft until explicitly approved.`,
  },
  'task-author': {
    skill: 'p2a-task-author',
    description: 'Author a Gate C task graph draft from a Plan2Agent context bundle.',
    prompt: `Use the Plan2Agent p2a-task-author skill for the following context:

{{args}}

Run or use the provided p2a.task_context.v1 context, write only iterations/<active_iteration>/gate-c-task-graph/task-graph.draft.json, never write canonical task-graph.json, and hand off validation, audit, and promote-tasks instructions for human approval.`,
  },
  'dev-execution': {
    skill: 'p2a-dev-execution',
    description: 'Implement a single ready Plan2Agent task and record the run.',
    prompt: `Use the Plan2Agent p2a-dev-execution skill for the following ready task execution context:

{{args}}

Confirm the task is ready, start or use the run, implement only inside the target workspaceRef or worktree, run verify, finish with collected git state, update task status, and return the execution summary.`,
  },
  'design-system': {
    skill: 'p2a-design-system',
    description: 'Design or implement Plan2Agent GUI screens using the P2A design system.',
    prompt: `Use the Plan2Agent p2a-design-system skill for the following GUI design or implementation request:

{{args}}

Read the packaged Harness and DevSync references inside the p2a-design-system skill before acting. Use Harness as the primary visual language, DevSync for dense developer-tool primitives, and preserve P2A operator workflows for gates, tasks, runs, PTY sessions, approvals, and verification.`,
  },
  'task-breakdown': {
    skill: 'p2a-task-breakdown',
    description: 'Create a Plan2Agent task graph from an approved implementation spec.',
    prompt: `Use the Plan2Agent p2a-task-breakdown skill for the following approved implementation spec:

{{args}}

Return task_graph_json conforming to .plan2agent/schemas/task-graph.schema.json only. Do not implement tasks. Reject the request if the spec is not approved or open decisions remain.`,
  },
};

function parseFrontmatterScalar(lines, index, rawValue) {
  let value = rawValue.trim();
  if (value === '|' || value === '>') {
    const collected = [];
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) break;
      collected.push(line.startsWith('  ') ? line.slice(2) : line.trimStart());
      index += 1;
    }
    return [(value === '|' ? collected.join('\n') : collected.join(' ')).trim(), index];
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [value, index + 1];
}

function parseFrontmatterList(lines, index) {
  const values = [];
  index += 1;
  while (index < lines.length) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped) {
      index += 1;
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) break;
    if (!stripped.startsWith('-')) throw new Error(`unsupported list item line: ${JSON.stringify(line)}`);
    let value = stripped.slice(1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.push(value);
    index += 1;
  }
  return [values, index];
}

function parseAgentMarkdown(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (text.endsWith('\n') || text.endsWith('\r')) lines.pop();
  if (!lines.length || lines[0].trim() !== '---') throw new Error(`${filePath} must start with YAML frontmatter`);
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === '---') + 1;
  if (closingIndex === 0) throw new Error(`${filePath} must close YAML frontmatter with ---`);
  const frontmatterLines = lines.slice(1, closingIndex);
  let body = lines.slice(closingIndex + 1).join('\n').replace(/^\n+/, '');
  if (text.endsWith('\n') && body) body += '\n';

  const meta = {};
  let index = 0;
  while (index < frontmatterLines.length) {
    const line = frontmatterLines[index];
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) {
      index += 1;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')) {
      throw new Error(`unexpected indented/list line outside a key in ${filePath}: ${JSON.stringify(line)}`);
    }
    if (!line.includes(':')) throw new Error(`unsupported frontmatter line in ${filePath}: ${JSON.stringify(line)}`);
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);
    let result;
    if (rawValue.trim() === '') result = parseFrontmatterList(frontmatterLines, index);
    else result = parseFrontmatterScalar(frontmatterLines, index, rawValue);
    meta[key] = result[0];
    index = result[1];
  }
  validateNeutralMetadata(filePath, meta);
  return [meta, body];
}

function validateNeutralMetadata(filePath, meta) {
  const required = new Set(['name', 'description', 'capabilities', 'access', 'tier']);
  const missing = [...required].filter((key) => !Object.hasOwn(meta, key)).sort();
  if (missing.length) throw new Error(`${filePath} missing neutral frontmatter keys: ${missing.join(', ')}`);
  const forbidden = ['tools', 'model'].filter((key) => Object.hasOwn(meta, key)).sort();
  if (forbidden.length) throw new Error(`${filePath} contains target-specific frontmatter keys: ${forbidden.join(', ')}`);
  if (!Array.isArray(meta.capabilities) || !meta.capabilities.length) throw new Error(`${filePath} capabilities must be a non-empty list`);
  const unknownCapabilities = [...new Set(meta.capabilities)].filter((capability) => !CAPABILITY_VALUES.has(capability)).sort();
  if (unknownCapabilities.length) throw new Error(`${filePath} has unknown capabilities: ${unknownCapabilities.join(', ')}`);
  if (!ACCESS_VALUES.has(meta.access)) throw new Error(`${filePath} access must be one of ${JSON.stringify([...ACCESS_VALUES].sort())}`);
  if (!TIER_VALUES.has(meta.tier)) throw new Error(`${filePath} tier must be one of ${JSON.stringify([...TIER_VALUES].sort())}`);
}

function tomlBasicString(value) {
  return JSON.stringify(value);
}

function tomlLiteralMultiline(value, label) {
  if (value.includes("'''")) throw new Error(`${label} cannot contain triple single quotes for TOML literal multiline output`);
  return "'''\n" + value.trimEnd() + "\n'''";
}

function expandCapabilities(capabilities, mapping) {
  const tools = [];
  for (const capability of capabilities) {
    for (const tool of mapping[capability]) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return tools;
}

function renderMarkdownAgent(meta, body, { target }) {
  const lines = ['---', `name: ${meta.name}`, `description: ${meta.description}`];
  if (target === 'claude') {
    lines.push('tools:');
    lines.push(...expandCapabilities(meta.capabilities, CLAUDE_TOOL_MAP).map((tool) => `  - ${tool}`));
    lines.push(`model: ${CLAUDE_TIER_MODEL[meta.tier]}`);
  } else if (target === 'gemini') {
    lines.push('kind: local');
    lines.push('tools:');
    lines.push(...expandCapabilities(meta.capabilities, GEMINI_TOOL_MAP).map((tool) => `  - ${tool}`));
    const tierConfig = GEMINI_TIER_CONFIG[meta.tier];
    lines.push(`temperature: ${tierConfig.temperature}`);
    lines.push(`max_turns: ${tierConfig.max_turns}`);
  } else {
    throw new Error(`unknown markdown target ${target}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n\n' + body.replace(/^\n+/, '');
}

function renderCodexAgent(meta, body) {
  const sandbox = meta.access === 'workspace-write' ? 'workspace-write' : 'read-only';
  return (
    `name = ${tomlBasicString(meta.name)}\n` +
    `description = ${tomlBasicString(meta.description)}\n` +
    `model_reasoning_effort = "${CODEX_TIER_EFFORT[meta.tier]}"\n` +
    `sandbox_mode = "${sandbox}"\n` +
    'developer_instructions = ' + tomlLiteralMultiline(body, String(meta.name)) + '\n'
  );
}

function renderGeminiCommand(command) {
  const escapedPrompt = command.prompt.replaceAll('"""', '\\"\\"\\"');
  return `description = ${tomlBasicString(command.description)}\nprompt = \"\"\"\n${escapedPrompt}\n\"\"\"\n`;
}

function relativeFileList(sourceRoot) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
    }
  }
  visit(sourceRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function desiredFiles() {
  const files = [];
  for (const dirent of readdirSync(SKILL_SOURCE, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillRoot = path.join(SKILL_SOURCE, dirent.name);
    const skillFile = path.join(skillRoot, 'SKILL.md');
    if (existsSync(skillFile)) {
      for (const relativeFile of relativeFileList(skillRoot)) {
        const source = path.join(skillRoot, relativeFile);
        files.push({
          path: path.join(ROOT, '.claude', 'skills', dirent.name, relativeFile),
          content: readFileSync(source),
        });
      }
    }
  }
  for (const filename of readdirSync(AGENT_SOURCE).filter((name) => name.endsWith('.md')).sort()) {
    const source = path.join(AGENT_SOURCE, filename);
    const [meta, body] = parseAgentMarkdown(source);
    files.push({ path: path.join(ROOT, '.claude', 'agents', filename), content: renderMarkdownAgent(meta, body, { target: 'claude' }) });
    files.push({ path: path.join(ROOT, '.gemini', 'agents', filename), content: renderMarkdownAgent(meta, body, { target: 'gemini' }) });
    files.push({ path: path.join(ROOT, '.codex', 'agents', `${meta.name}.toml`), content: renderCodexAgent(meta, body) });
  }
  for (const [commandName, command] of Object.entries(GEMINI_COMMANDS).sort(([a], [b]) => a.localeCompare(b))) {
    if (!existsSync(path.join(SKILL_SOURCE, command.skill, 'SKILL.md'))) continue;
    files.push({ path: path.join(ROOT, '.gemini', 'commands', 'p2a', `${commandName}.toml`), content: renderGeminiCommand(command) });
  }
  return files;
}

function writeOrCheck(rendered, check) {
  const expectedBytes = Buffer.isBuffer(rendered.content) ? rendered.content : Buffer.from(String(rendered.content), 'utf8');
  if (check) {
    if (!existsSync(rendered.path)) return [`missing generated file ${path.relative(ROOT, rendered.path)}`];
    if (!readFileSync(rendered.path).equals(expectedBytes)) return [`generated file drift ${path.relative(ROOT, rendered.path)}`];
    return [];
  }
  mkdirSync(path.dirname(rendered.path), { recursive: true });
  writeFileSync(rendered.path, expectedBytes);
  return [];
}

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  if (argv.some((arg) => arg !== '--check')) {
    console.error(`sync failed: unrecognized argument: ${argv.find((arg) => arg !== '--check')}`);
    return 1;
  }
  const errors = [];
  try {
    for (const rendered of desiredFiles()) errors.push(...writeOrCheck(rendered, check));
  } catch (error) {
    console.error(`sync failed: ${error.message}`);
    return 1;
  }
  if (errors.length) {
    for (const error of errors) console.error(`sync failed: ${error}`);
    return 1;
  }
  console.log(check ? 'Plan2Agent CLI assets are in sync' : 'Plan2Agent CLI assets synced');
  return 0;
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(__filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
