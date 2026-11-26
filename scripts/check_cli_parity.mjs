#!/usr/bin/env node
/** Verify that Plan2Agent v1 canonical skills/agents and provider mirrors are in sync with no extras. */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expectedMirrorFiles, syncCliAssets } from './sync_cli_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_SKILLS = ['p2a-next', 'p2a-work'];
const EXPECTED_AGENTS = ['p2a-implementer', 'p2a-reviewer'];

function listRelativeFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const results = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  walk(abs);
  return results.sort();
}

function main() {
  const failures = [];

  for (const skill of EXPECTED_SKILLS) {
    const file = path.join(ROOT, '.agents', 'skills', skill, 'SKILL.md');
    if (!existsSync(file)) failures.push(`missing canonical skill: .agents/skills/${skill}/SKILL.md`);
  }
  for (const agent of EXPECTED_AGENTS) {
    const file = path.join(ROOT, '.agents', 'agents', `${agent}.md`);
    if (!existsSync(file)) failures.push(`missing canonical agent: .agents/agents/${agent}.md`);
  }

  const expectedCanonical = new Set([
    ...EXPECTED_SKILLS.map((s) => `.agents/skills/${s}/SKILL.md`),
    ...EXPECTED_AGENTS.map((a) => `.agents/agents/${a}.md`),
  ]);
  for (const found of listRelativeFiles('.agents')) {
    if (!expectedCanonical.has(found)) {
      failures.push(`unexpected canonical file in .agents: ${found}`);
    }
  }

  const syncResult = syncCliAssets({ check: true });
  for (const drifted of syncResult.drifted) {
    failures.push(`mirror out of sync: ${drifted}`);
  }

  const expectedSet = new Set(
    [...expectedMirrorFiles().keys()].map((p) => p.split(path.sep).join('/')),
  );
  const mirrorDirs = [
    '.claude/skills',
    '.claude/agents',
    '.codex/agents',
    '.gemini/agents',
    '.gemini/commands/p2a',
  ];
  for (const dir of mirrorDirs) {
    for (const found of listRelativeFiles(dir)) {
      if (!expectedSet.has(found)) {
        failures.push(`unexpected stale mirror file: ${found}`);
      }
    }
  }

  if (failures.length) {
    for (const item of failures) console.error(`parity failed: ${item}`);
    return 1;
  }
  console.log('Plan2Agent CLI parity passed');
  return 0;
}

process.exitCode = main();
