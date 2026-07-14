#!/usr/bin/env node
/** Check that Plan2Agent CLI configuration mirrors and command shims stay in sync. */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SKILLS = ['p2a-harness', 'p2a-intake', 'p2a-spec', 'p2a-task-author', 'p2a-dev-execution', 'p2a-task-breakdown', 'p2a-review'];
const AGENTS = ['p2a-requirements', 'p2a-spec-author', 'p2a-implementation-planner', 'p2a-task-graph', 'p2a-task-author', 'p2a-quality-reviewer', 'p2a-milestone-reviewer', 'p2a-skill-curator', 'p2a-performance-monitor', 'p2a-style-rater', 'p2a-implementer'];
const GEMINI_COMMANDS = {
  harness: 'p2a-harness',
  intake: 'p2a-intake',
  spec: 'p2a-spec',
  'task-author': 'p2a-task-author',
  'dev-execution': 'p2a-dev-execution',
  'task-breakdown': 'p2a-task-breakdown',
  review: 'p2a-review',
};

function fail(message) {
  console.error(`parity failed: ${message}`);
  return 1;
}

function parseSimpleToml(text) {
  const data = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) throw new Error(`Expected '=' in ${rawLine}`);
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value === '"""' || value === "'''") {
      const delimiter = value;
      const collected = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== delimiter) {
        collected.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error(`Unterminated multiline string for ${key}`);
      data[key] = collected.join('\n');
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}

function checkGeminiCommand(command, skill) {
  const commandPath = path.join(ROOT, '.gemini', 'commands', 'p2a', `${command}.toml`);
  const label = path.relative(ROOT, commandPath);
  if (!existsSync(commandPath)) return `missing Gemini command shim ${label}`;
  let data;
  try {
    data = parseSimpleToml(readFileSync(commandPath, 'utf8'));
  } catch (error) {
    return `invalid TOML in Gemini command shim ${label}: ${error.message}`;
  }
  const description = data.description;
  if (typeof description !== 'string' || !description.trim()) return `Gemini command shim ${label} has missing or empty description`;
  const prompt = data.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return `Gemini command shim ${label} has missing or empty prompt`;
  if (!prompt.includes(skill)) return `Gemini command shim ${label} prompt must include skill name ${skill}`;
  if (!prompt.includes('{{args}}')) return `Gemini command shim ${label} prompt must include {{args}}`;
  return null;
}

export function main() {
  const syncCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync_cli_assets.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (syncCheck.status !== 0) {
    if (syncCheck.stderr) process.stderr.write(syncCheck.stderr);
    return syncCheck.status ?? 1;
  }

  for (const skill of SKILLS) {
    const source = path.join(ROOT, '.agents', 'skills', skill, 'SKILL.md');
    const mirror = path.join(ROOT, '.claude', 'skills', skill, 'SKILL.md');
    if (!existsSync(source)) return fail(`missing source skill ${source}`);
    if (!existsSync(mirror)) return fail(`missing Claude skill mirror ${mirror}`);
    if (!readFileSync(source).equals(readFileSync(mirror))) return fail(`skill mirror drift for ${skill}`);
  }

  for (const agent of AGENTS) {
    const source = path.join(ROOT, '.agents', 'agents', `${agent}.md`);
    const claude = path.join(ROOT, '.claude', 'agents', `${agent}.md`);
    const codex = path.join(ROOT, '.codex', 'agents', `${agent}.toml`);
    const gemini = path.join(ROOT, '.gemini', 'agents', `${agent}.md`);
    const missing = [source, claude, codex, gemini].filter((filePath) => !existsSync(filePath)).map((filePath) => path.relative(ROOT, filePath));
    if (missing.length) return fail(`missing agent mirrors for ${agent}: ${missing.join(', ')}`);
    const sourceText = readFileSync(source, 'utf8');
    const codexText = readFileSync(codex, 'utf8');
    const hasWebCapability = /capabilities:\s*[\s\S]*?^\s*-\s+web\s*$/m.test(sourceText.split(/^---\s*$/m)[1] ?? sourceText);
    if (hasWebCapability && !/^web_search\s*=\s*"live"\s*$/m.test(codexText)) {
      return fail(`Codex agent mirror ${agent} must enable live web search for the neutral web capability`);
    }
    if (!hasWebCapability && /^web_search\s*=/m.test(codexText)) {
      return fail(`Codex agent mirror ${agent} must inherit parent web search when neutral web capability is absent`);
    }
  }

  for (const [command, skill] of Object.entries(GEMINI_COMMANDS)) {
    const error = checkGeminiCommand(command, skill);
    if (error) return fail(error);
  }
  console.log('Plan2Agent CLI parity passed');
  return 0;
}

process.exitCode = main();
