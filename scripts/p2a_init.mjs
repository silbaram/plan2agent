/** Minimal project initializer (p2a init) and diagnostics (p2a doctor) for Plan2Agent v1. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_TARGETS,
  configPath,
  createDefaultConfig,
  normalizeProjectId,
  readConfig,
  workPath,
  writeConfig,
} from './p2a_config.mjs';
import { isPlanDrifted, readWork } from './p2a_work.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_HOOK_COMMAND = 'node .claude/hooks/p2a-confine-workspace.mjs';

export function parseToolList(raw) {
  if (raw === undefined || raw === null) return [...TOOL_TARGETS];
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    throw new Error('--tools requires a non-empty value: codex, claude, gemini, all, or none');
  }
  if (normalized === 'all') return [...TOOL_TARGETS];
  if (normalized === 'none') return [];
  const items = normalized.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) {
    throw new Error('--tools requires at least one tool name: codex, claude, gemini, all, or none');
  }
  const invalid = items.filter((item) => !TOOL_TARGETS.includes(item));
  if (invalid.length) {
    throw new Error(`unknown --tools value(s): ${invalid.join(', ')}; expected codex, claude, gemini, all, or none`);
  }
  return TOOL_TARGETS.filter((t) => items.includes(t));
}

export function providerAssetList(tools) {
  const files = [];
  const needsAgents = tools.includes('codex') || tools.includes('gemini');
  if (needsAgents) {
    files.push(
      '.agents/skills/p2a-next/SKILL.md',
      '.agents/skills/p2a-work/SKILL.md',
      '.agents/agents/p2a-implementer.md',
      '.agents/agents/p2a-reviewer.md',
    );
  }
  if (tools.includes('codex')) {
    files.push(
      '.codex/agents/p2a-implementer.toml',
      '.codex/agents/p2a-reviewer.toml',
    );
  }
  if (tools.includes('claude')) {
    files.push(
      '.claude/skills/p2a-next/SKILL.md',
      '.claude/skills/p2a-work/SKILL.md',
      '.claude/agents/p2a-implementer.md',
      '.claude/agents/p2a-reviewer.md',
      '.claude/hooks/p2a-confine-workspace.mjs',
    );
  }
  if (tools.includes('gemini')) {
    files.push(
      '.gemini/agents/p2a-implementer.md',
      '.gemini/agents/p2a-reviewer.md',
      '.gemini/commands/p2a/next.toml',
      '.gemini/commands/p2a/work.toml',
    );
  }
  return [...new Set(files)];
}

function ensureClaudeHookSettings(targetRoot) {
  const settingsPath = path.join(targetRoot, '.claude', 'settings.json');
  let current = {};
  if (existsSync(settingsPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      throw new Error(`cannot update .claude/settings.json because existing file is invalid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('cannot update .claude/settings.json because root JSON value must be an object');
    }
    current = parsed;
  }
  const hooks = current.hooks && typeof current.hooks === 'object' ? { ...current.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const alreadyPresent = preToolUse.some((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === CLAUDE_HOOK_COMMAND),
  );
  if (!alreadyPresent) {
    preToolUse.push({
      matcher: 'Write|Edit|Bash',
      hooks: [{ type: 'command', command: CLAUDE_HOOK_COMMAND }],
    });
  }
  hooks.PreToolUse = preToolUse;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...current, hooks }, null, 2)}\n`, 'utf8');
  return '.claude/settings.json';
}

export function initProject(targetRoot, { tools = null, projectId = null, force = false } = {}) {
  const root = path.resolve(targetRoot);
  let existing = null;
  if (existsSync(configPath(root))) {
    try {
      existing = readConfig(root);
    } catch (error) {
      if (!force) throw error;
    }
  }
  const effectiveTools = Array.isArray(tools)
    ? [...tools]
    : (existing && !force && Array.isArray(existing.tools) ? [...existing.tools] : [...TOOL_TARGETS]);

  let config;
  if (existing && !force) {
    let resolvedProjectId = existing.project_id;
    if (projectId !== null && projectId !== undefined) {
      const normalized = normalizeProjectId(projectId);
      if (!normalized) {
        throw new Error(`invalid --project-id: ${JSON.stringify(projectId)}`);
      }
      resolvedProjectId = normalized;
    }
    config = { ...existing, project_id: resolvedProjectId, tools: effectiveTools };
  } else {
    config = createDefaultConfig(root, { projectId: projectId ?? existing?.project_id, tools: effectiveTools });
  }
  writeConfig(root, config);

  const installed = ['.plan2agent/config.json'];
  for (const relPath of providerAssetList(effectiveTools)) {
    const src = path.join(PACKAGE_ROOT, relPath);
    const dst = path.join(root, relPath);
    if (!existsSync(src)) {
      throw new Error(`packaged provider asset is missing: ${relPath}`);
    }
    if (path.resolve(src) !== path.resolve(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
    installed.push(relPath);
  }
  if (effectiveTools.includes('claude')) {
    installed.push(ensureClaudeHookSettings(root));
  }

  return {
    targetRoot: root,
    config,
    installedFiles: installed,
  };
}

export function diagnoseProject(targetRoot) {
  const root = path.resolve(targetRoot);
  const errors = [];
  const warnings = [];
  let config = null;
  let work = null;

  if (!existsSync(configPath(root))) {
    errors.push('missing .plan2agent/config.json (run `p2a init`)');
  } else {
    try {
      config = readConfig(root);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (config) {
    const hasVerify = Boolean(
      config.verify?.test?.trim() || config.verify?.lint?.trim() || config.verify?.typecheck?.trim(),
    );
    if (!hasVerify) {
      warnings.push('no verify commands configured in .plan2agent/config.json (pass --cmd to `p2a verify` or set verify.test)');
    }
    for (const relPath of providerAssetList(config.tools ?? [])) {
      if (!existsSync(path.join(root, relPath))) {
        warnings.push(`missing installed provider asset: ${relPath} (run \`p2a init\` to restore)`);
      }
    }
    if ((config.tools ?? []).includes('claude')) {
      const settingsPath = path.join(root, '.claude', 'settings.json');
      if (!existsSync(settingsPath)) {
        warnings.push('missing .claude/settings.json hook registration (run `p2a init` to restore)');
      } else {
        try {
          const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
          const preToolUse = Array.isArray(parsed?.hooks?.PreToolUse) ? parsed.hooks.PreToolUse : [];
          const hasHook = preToolUse.some((entry) =>
            Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?.command === CLAUDE_HOOK_COMMAND),
          );
          if (!hasHook) {
            warnings.push('Plan2Agent workspace confinement hook is not registered in .claude/settings.json (run `p2a init`)');
          }
        } catch (error) {
          errors.push(`invalid .claude/settings.json: ${error.message}`);
        }
      }
    }
  }

  if (existsSync(workPath(root))) {
    try {
      work = readWork(root);
      if (isPlanDrifted(work)) {
        warnings.push('approved plan in .plan2agent/work.json drifted after approval; reconfirm with `p2a approve`');
      }
    } catch (error) {
      errors.push(`invalid .plan2agent/work.json: ${error.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    targetRoot: root,
    projectId: config?.project_id ?? null,
    hasWork: Boolean(work),
    workStatus: work?.status ?? null,
    errors,
    warnings,
  };
}
