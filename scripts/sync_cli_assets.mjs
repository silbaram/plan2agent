#!/usr/bin/env node
/** Generate Plan2Agent v1 CLI mirrors (.claude, .codex, .gemini) from canonical .agents sources. */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SOURCE = path.join(ROOT, '.agents', 'skills');
const AGENT_SOURCE = path.join(ROOT, '.agents', 'agents');

const CLAUDE_TOOL_MAP = {
  read: ['Read'],
  search: ['Grep', 'Glob'],
  web: ['WebSearch', 'WebFetch'],
  edit: ['Edit', 'Write'],
  shell: ['Bash'],
};
const GEMINI_TOOL_MAP = {
  read: ['read_file'],
  search: ['grep_search'],
  web: ['google_web_search', 'web_fetch'],
  edit: ['write_file', 'replace'],
  shell: ['run_shell_command'],
};
const CODEX_TIER_EFFORT = { light: 'medium', standard: 'high', heavy: 'max' };
const GEMINI_TIER_CONFIG = {
  light: { temperature: 0.1, max_turns: 6 },
  standard: { temperature: 0.2, max_turns: 10 },
  heavy: { temperature: 0.2, max_turns: 20 },
};

const GEMINI_COMMANDS = {
  next: {
    skill: 'p2a-next',
    description: 'Check .plan2agent/work.json and show the single next Plan2Agent action.',
    prompt: `Use the Plan2Agent p2a-next skill for the following input:

{{args}}

Treat p2a next --json as the decision authority.`,
  },
  work: {
    skill: 'p2a-work',
    description: 'Draft, approve, implement, verify, and resume tasks through .plan2agent/work.json.',
    prompt: `Use the Plan2Agent p2a-work skill for the following context:

{{args}}

Keep all task and resume state in .plan2agent/work.json without creating extra Markdown docs.`,
  },
};

export function parseAgentSource(filePath) {
  const raw = readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`missing YAML frontmatter in ${filePath}`);
  const frontmatter = {};
  let currentListKey = null;
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentListKey) {
      frontmatter[currentListKey].push(listItem[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (!value.trim()) {
      frontmatter[key] = [];
      currentListKey = key;
    } else {
      frontmatter[key] = value.trim().replace(/^['"]|['"]$/g, '');
      currentListKey = null;
    }
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    capabilities: Array.isArray(frontmatter.capabilities) ? frontmatter.capabilities : [],
    access: frontmatter.access ?? 'read-only',
    tier: frontmatter.tier ?? 'standard',
    body: match[2].trim(),
  };
}

function renderClaudeAgent(agent) {
  const tools = [...new Set(agent.capabilities.flatMap((cap) => CLAUDE_TOOL_MAP[cap] ?? []))];
  return [
    '---',
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    'tools:',
    ...tools.map((tool) => `  - ${tool}`),
    '---',
    '',
    agent.body,
    '',
  ].join('\n');
}

function renderCodexAgent(agent) {
  const lines = [
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `model_reasoning_effort = ${JSON.stringify(CODEX_TIER_EFFORT[agent.tier] ?? 'high')}`,
  ];
  if (agent.access === 'read-only') {
    lines.push('sandbox_mode = "read-only"');
  }
  lines.push(`developer_instructions = ${JSON.stringify(agent.body)}`);
  return `${lines.join('\n')}\n`;
}

function renderGeminiAgent(agent) {
  const tools = [...new Set(agent.capabilities.flatMap((cap) => GEMINI_TOOL_MAP[cap] ?? []))];
  const tierCfg = GEMINI_TIER_CONFIG[agent.tier] ?? GEMINI_TIER_CONFIG.standard;
  return [
    '---',
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    'kind: local',
    'tools:',
    ...tools.map((tool) => `  - ${tool}`),
    `temperature: ${tierCfg.temperature}`,
    `max_turns: ${tierCfg.max_turns}`,
    '---',
    '',
    agent.body,
    '',
  ].join('\n');
}

function renderGeminiCommand(entry) {
  return [
    `description = ${JSON.stringify(entry.description)}`,
    'prompt = """',
    entry.prompt,
    '"""',
    '',
  ].join('\n');
}

export function expectedMirrorFiles() {
  const outputs = new Map();

  const skillEntries = readdirSync(SKILL_SOURCE, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(SKILL_SOURCE, entry.name, 'SKILL.md');
    if (!existsSync(src)) continue;
    const body = readFileSync(src, 'utf8').replace(/\r\n?/g, '\n');
    outputs.set(path.join('.claude', 'skills', entry.name, 'SKILL.md'), body);
  }

  const agentEntries = readdirSync(AGENT_SOURCE, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of agentEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const agent = parseAgentSource(path.join(AGENT_SOURCE, entry.name));
    outputs.set(path.join('.claude', 'agents', `${agent.name}.md`), renderClaudeAgent(agent));
    outputs.set(path.join('.codex', 'agents', `${agent.name}.toml`), renderCodexAgent(agent));
    outputs.set(path.join('.gemini', 'agents', `${agent.name}.md`), renderGeminiAgent(agent));
  }

  for (const [cmd, spec] of Object.entries(GEMINI_COMMANDS)) {
    outputs.set(path.join('.gemini', 'commands', 'p2a', `${cmd}.toml`), renderGeminiCommand(spec));
  }

  return outputs;
}

export function syncCliAssets({ check = false } = {}) {
  const expected = expectedMirrorFiles();
  const drifted = [];
  for (const [relPath, content] of expected.entries()) {
    const absPath = path.join(ROOT, relPath);
    const current = existsSync(absPath) ? readFileSync(absPath, 'utf8').replace(/\r\n?/g, '\n') : null;
    if (current !== content) {
      if (check) {
        drifted.push(relPath);
      } else {
        mkdirSync(path.dirname(absPath), { recursive: true });
        writeFileSync(absPath, content, 'utf8');
      }
    }
  }
  return { ok: drifted.length === 0, drifted };
}

if (
  process.argv[1]
  && existsSync(process.argv[1])
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  const check = process.argv.includes('--check');
  const result = syncCliAssets({ check });
  if (!result.ok) {
    console.error(`Plan2Agent CLI assets out of sync:\n- ${result.drifted.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(check ? 'Plan2Agent CLI assets are in sync' : 'Plan2Agent CLI assets synced');
  }
}
