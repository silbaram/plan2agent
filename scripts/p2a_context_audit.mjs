/** Build a static, provider-aware inventory of Plan2Agent prompt context. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './p2a_schema.mjs';
import {
  CONTEXT_MODES,
  CONTEXT_PHASES,
  CONTEXT_PROVIDERS,
  readContextRouteSource,
  referenceAppliesToProvider,
  referenceConditionId as sharedReferenceConditionId,
  referencePathForProvider,
  routeModeApplies,
  selectContextReferenceRoutes,
} from './p2a_context_routes.mjs';

const ROUTE_SCHEMA_VERSION = 'p2a.context_routes.v1';
const AUDIT_SCHEMA_VERSION = 'p2a.context_audit.v1';
const PROVIDERS = CONTEXT_PROVIDERS;
const EXECUTION_MODES = CONTEXT_MODES;
const LOAD_PRIORITY = { 'on-demand': 0, conditional: 1, always: 2 };
const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-routes.schema.json', import.meta.url),
  'utf8',
));
const AUDIT_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-audit.schema.json', import.meta.url),
  'utf8',
));

function normalizePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

function isFile(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { ok: false, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
    : [];
}

function recordArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function tokenEstimate(bytes) {
  return Math.ceil(bytes / 4);
}

function imperativeCount(content) {
  return [...String(content).matchAll(/\b(?:do not|never|must|required?|forbid(?:den)?|only|cannot|can't|should not)\b/gi)].length;
}

function instructionOwnerForPath(value) {
  const sourcePath = normalizePath(value);
  if (sourcePath.startsWith('runtime:schemas/') || sourcePath.startsWith('schemas/')) return 'schema';
  if (sourcePath.startsWith('runtime:scripts/') || sourcePath.startsWith('scripts/')) return 'cli';
  if (sourcePath.includes('/hooks/')) return 'hook';
  if (sourcePath.startsWith('.gemini/commands/')) return 'provider-wrapper';
  if (
    sourcePath.startsWith('.agents/agents/')
    || sourcePath.startsWith('.claude/agents/')
    || sourcePath.startsWith('.codex/agents/')
    || sourcePath.startsWith('.gemini/agents/')
  ) return 'agent';
  if (sourcePath.includes('/skills/')) return 'skill';
  return null;
}

function referenceConditionId(skillId, referencePath) {
  return sharedReferenceConditionId(skillId, referencePath);
}

function declaredReferencePaths(reference) {
  return [...new Set([
    reference?.path,
    ...recordArray(reference?.provider_paths).map((item) => item.path),
  ].map(safeReferencePath).filter(Boolean))];
}

function canonicalReferenceRouteSignature(reference) {
  const parts = [
    `${reference.required ? 'Required' : 'Optional'}, ${reference.load}`,
    `stages: ${stringArray(reference.stages).join(', ')}`,
  ];
  const modes = stringArray(reference.modes);
  if (modes.length) parts.push(`modes: ${modes.join(', ')}`);
  const providers = stringArray(reference.providers);
  if (providers.length) parts.push(`providers: ${providers.join(', ')}`);
  const providerPaths = recordArray(reference.provider_paths);
  if (providerPaths.length) {
    parts.push(`provider paths: ${providerPaths
      .map((item) => `${item.provider}=\`${item.path}\``)
      .join(', ')}`);
  }
  const referencePath = reference.source_skill
    ? `.agents/skills/${reference.source_skill}/${reference.path}`
    : reference.path;
  return `${parts.join('; ')} — \`${referencePath}\` — ${reference.condition}`;
}

function agentConditionId(agentId) {
  return `agent:${agentId}`;
}

function safeAssetPath(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) return null;
  const normalized = normalizePath(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

function sourceRecord(targetRoot, filePath, fields, diagnostics) {
  const relativePath = normalizePath(path.relative(targetRoot, filePath));
  if (!isFile(filePath)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing_context_source',
      message: `Declared context source is missing: ${relativePath}`,
      paths: [relativePath],
    });
    return null;
  }
  const content = readFileSync(filePath);
  const text = content.toString('utf8');
  const bytes = content.byteLength;
  return {
    path: relativePath,
    role: fields.role,
    owner: fields.owner,
    load: fields.load,
    ...(typeof fields.required === 'boolean' ? { required: fields.required } : {}),
    condition: fields.condition,
    conditionId: fields.conditionId,
    bytes,
    estimatedTokens: tokenEstimate(bytes),
    sha256: digest(content),
    imperativeCount: imperativeCount(text),
  };
}

function resolvedReferenceSourceRecord(resolved, fields) {
  const text = resolved.body;
  return {
    path: resolved.path,
    role: 'reference',
    owner: 'skill',
    load: resolved.load,
    required: resolved.required,
    condition: resolved.condition,
    conditionId: resolved.conditionId,
    bytes: resolved.bytes,
    estimatedTokens: tokenEstimate(resolved.bytes),
    sha256: resolved.sha256,
    imperativeCount: imperativeCount(text),
    ...fields,
  };
}

function instructionOwnerRecord(targetRoot, authority, diagnostics) {
  const relativePath = safeAssetPath(authority.path);
  const sourceRoot = authority.root === 'runtime' ? RUNTIME_ROOT : targetRoot;
  const filePath = relativePath ? path.join(sourceRoot, relativePath) : null;
  const displayPath = authority.root === 'runtime'
    ? `runtime:${relativePath ?? '<invalid>'}`
    : relativePath ?? '<invalid>';
  if (!filePath || !isFile(filePath)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing_instruction_owner_source',
      message: `Declared ${authority.owner} instruction owner is missing: ${displayPath}`,
      paths: [displayPath],
    });
    return null;
  }
  const content = readFileSync(filePath);
  return {
    id: authority.id,
    owner: authority.owner,
    path: displayPath,
    condition: authority.condition,
    bytes: content.byteLength,
    sha256: digest(content),
  };
}

function reportMirrorDrift(targetRoot, canonicalPath, mirrorPath, diagnostics, reported) {
  if (!isFile(canonicalPath) || !isFile(mirrorPath)) return;
  const key = `${normalizePath(canonicalPath)}\0${normalizePath(mirrorPath)}`;
  if (reported.has(key)) return;
  reported.add(key);
  const canonical = readFileSync(canonicalPath);
  const mirror = readFileSync(mirrorPath);
  if (digest(canonical) === digest(mirror)) return;
  diagnostics.push({
    severity: 'error',
    code: 'provider_skill_mirror_drift',
    message: `Generated provider skill differs from its canonical source: ${normalizePath(path.relative(targetRoot, mirrorPath))}`,
    paths: [
      normalizePath(path.relative(targetRoot, canonicalPath)),
      normalizePath(path.relative(targetRoot, mirrorPath)),
    ],
  });
}

function sourcePathForSkill(targetRoot, provider, skillId, relativePath = 'SKILL.md') {
  const root = provider === 'claude'
    ? path.join(targetRoot, '.claude', 'skills')
    : path.join(targetRoot, '.agents', 'skills');
  return path.join(root, skillId, relativePath);
}

function sourcePathForAgent(targetRoot, provider, agentId) {
  if (provider === 'codex') return path.join(targetRoot, '.codex', 'agents', `${agentId}.toml`);
  if (provider === 'claude') return path.join(targetRoot, '.claude', 'agents', `${agentId}.md`);
  return path.join(targetRoot, '.gemini', 'agents', `${agentId}.md`);
}

function sourcePathForAdapter(targetRoot, provider, skill) {
  if (provider !== 'gemini') return null;
  return path.join(targetRoot, '.gemini', 'commands', 'p2a', `${skill.gemini_command}.toml`);
}

function safeReferencePath(value) {
  const normalized = typeof value === 'string' ? normalizePath(value) : '';
  return normalized.startsWith('references/')
    && !normalized.includes('../')
    && !path.isAbsolute(value)
    ? normalized
    : null;
}

function listFiles(root) {
  if (!isDirectory(root)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  visit(root);
  return files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function validateRouteManifest(targetRoot, manifest, diagnostics) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    diagnostics.push({ severity: 'error', code: 'invalid_route_manifest', message: 'Context route manifest root must be an object.' });
    return { providers: [], skills: [], agents: [], authorities: [] };
  }
  if (manifest.schema_version !== ROUTE_SCHEMA_VERSION) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid_route_schema_version',
      message: `Context route manifest must use ${ROUTE_SCHEMA_VERSION}.`,
    });
  }

  const providers = stringArray(manifest.providers);
  const unknownProviders = providers.filter((provider) => !PROVIDERS.includes(provider));
  if (!providers.length || unknownProviders.length || new Set(providers).size !== providers.length) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid_route_providers',
      message: `Context route providers must be a unique subset of ${PROVIDERS.join(', ')}.`,
    });
  }

  const skills = recordArray(manifest.skills);
  const skillIds = new Set();
  const referenceIds = new Set();
  for (const skill of skills) {
    if (typeof skill.id !== 'string' || !skill.id.startsWith('p2a-') || skillIds.has(skill.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid_skill_route',
        message: `Skill route ids must be unique p2a-* strings: ${String(skill.id)}`,
      });
      continue;
    }
    skillIds.add(skill.id);
    const skillStages = stringArray(skill.stages);
    if (!skillStages.length || typeof skill.gemini_command !== 'string' || !skill.gemini_command.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'incomplete_skill_route',
        message: `Skill route ${skill.id} requires stages and gemini_command.`,
      });
    }
    const canonicalMain = path.join(targetRoot, '.agents', 'skills', skill.id, 'SKILL.md');
    const canonicalText = isFile(canonicalMain) ? readFileSync(canonicalMain, 'utf8') : '';
    const declaredReferences = new Set();
    for (const reference of recordArray(skill.references)) {
      const relativePath = safeReferencePath(reference.path) ?? '';
      const referenceStages = stringArray(reference.stages);
      const referenceModes = stringArray(reference.modes);
      const skillModes = stringArray(skill.modes);
      const referenceProviders = stringArray(reference.providers);
      const providerPaths = recordArray(reference.provider_paths);
      const providerPathProviders = providerPaths.map((item) => item.provider);
      const providerPathValues = providerPaths.map((item) => safeReferencePath(item.path));
      if (referenceIds.has(reference.id)) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate_reference_route_id',
          message: `Reference route id is declared more than once: ${String(reference.id)}`,
        });
      }
      referenceIds.add(reference.id);
      if (
        !relativePath
        || !['conditional', 'on-demand'].includes(reference.load)
        || typeof reference.required !== 'boolean'
        || typeof reference.condition !== 'string'
        || !reference.condition.trim()
        || !referenceStages.length
        || referenceStages.some((stage) => !skillStages.includes(stage))
        || (skillModes.length && referenceModes.some((mode) => !skillModes.includes(mode)))
        || referenceProviders.some((provider) => !providers.includes(provider))
        || new Set(referenceProviders).size !== referenceProviders.length
        || providerPathProviders.some((provider) => !providers.includes(provider))
        || new Set(providerPathProviders).size !== providerPathProviders.length
        || providerPathValues.some((providerPath) => !providerPath)
        || (
          referenceProviders.length
          && providerPathProviders.some((provider) => !referenceProviders.includes(provider))
        )
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'invalid_reference_route',
          message: `Reference route for ${skill.id} is incomplete or escapes the skill stages: ${relativePath || '<missing>'}`,
        });
        continue;
      }
      for (const declaredPath of declaredReferencePaths(reference)) {
        const sourceKey = `${reference.source_skill ?? skill.id}/${declaredPath}`;
        if (declaredReferences.has(sourceKey)) {
          diagnostics.push({
            severity: 'error',
            code: 'duplicate_reference_route',
            message: `Reference route is declared more than once for ${skill.id}: ${declaredPath}`,
          });
        }
        declaredReferences.add(sourceKey);
      }
      const routeSignature = canonicalReferenceRouteSignature(reference);
      if (!canonicalText.includes(routeSignature)) {
        diagnostics.push({
          severity: 'error',
          code: 'canonical_skill_route_drift',
          message: `${skill.id}/SKILL.md does not preserve the canonical load, requirement, condition, stage, mode, or provider semantics for ${relativePath}.`,
          paths: [normalizePath(path.relative(targetRoot, canonicalMain))],
        });
      }
    }
    for (const match of canonicalText.matchAll(/\.agents\/skills\/(p2a-[a-z0-9-]+)\/(references\/[A-Za-z0-9._/-]+\.md)\b/g)) {
      if (match[1] !== skill.id && !declaredReferences.has(`${match[1]}/${match[2]}`)) {
        diagnostics.push({
          severity: 'error',
          code: 'unrouted_shared_reference',
          message: `${skill.id}/SKILL.md links a shared reference without a canonical load condition: ${match[0]}`,
          paths: [normalizePath(path.relative(targetRoot, canonicalMain))],
        });
      }
    }
    const referenceRoot = path.join(targetRoot, '.agents', 'skills', skill.id, 'references');
    for (const filePath of listFiles(referenceRoot)) {
      const relativePath = normalizePath(path.relative(path.dirname(referenceRoot), filePath));
      if (!declaredReferences.has(`${skill.id}/${relativePath}`)) {
        diagnostics.push({
          severity: 'warn',
          code: 'unrouted_reference',
          message: `Reference file has no canonical load condition: ${skill.id}/${relativePath}`,
          paths: [normalizePath(path.relative(targetRoot, filePath))],
          owners: ['skill'],
        });
      }
    }
  }

  const agents = recordArray(manifest.agents);
  const agentIds = new Set();
  for (const agent of agents) {
    const skillsForAgent = stringArray(agent.skills);
    const stagesForAgent = stringArray(agent.stages);
    const routedSkillStages = new Set(
      skills
        .filter((skill) => skillsForAgent.includes(skill.id))
        .flatMap((skill) => stringArray(skill.stages)),
    );
    if (
      typeof agent.id !== 'string'
      || !agent.id.startsWith('p2a-')
      || agentIds.has(agent.id)
      || !skillsForAgent.length
      || skillsForAgent.some((skillId) => !skillIds.has(skillId))
      || !stagesForAgent.length
      || stagesForAgent.some((stage) => !routedSkillStages.has(stage))
      || typeof agent.condition !== 'string'
      || !agent.condition.trim()
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid_agent_route',
        message: `Agent route is incomplete, duplicated, or points to an unknown skill: ${String(agent.id)}`,
      });
      continue;
    }
    agentIds.add(agent.id);
  }

  const canonicalAgentRoot = path.join(targetRoot, '.agents', 'agents');
  for (const filePath of listFiles(canonicalAgentRoot).filter((candidate) => candidate.endsWith('.md'))) {
    const id = path.basename(filePath, '.md');
    if (!agentIds.has(id)) {
      diagnostics.push({
        severity: 'info',
        code: 'unrouted_agent',
        message: `Agent is not part of a declared skill context route: ${id}`,
        paths: [normalizePath(path.relative(targetRoot, filePath))],
        owners: ['agent'],
      });
    }
  }

  const authorities = recordArray(manifest.authorities);
  const authorityIds = new Set();
  for (const authority of authorities) {
    if (
      typeof authority.id !== 'string'
      || authorityIds.has(authority.id)
      || !['schema', 'cli', 'hook'].includes(authority.owner)
      || !['runtime', 'target'].includes(authority.root)
      || !safeAssetPath(authority.path)
      || !stringArray(authority.stages).length
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid_instruction_owner',
        message: `Instruction owner is incomplete, duplicated, or has an unsafe path: ${String(authority.id)}`,
      });
      continue;
    }
    authorityIds.add(authority.id);
  }

  return {
    schema_version: manifest.schema_version,
    providers,
    skills,
    agents,
    authorities,
  };
}

function buildContexts(targetRoot, routes, diagnostics, scenario = null) {
  const contexts = [];
  const reportedMirrorDrift = new Set();
  const ownerCache = new Map();
  const activeConditions = new Set(stringArray(scenario?.conditions));
  const assembled = Boolean(scenario);
  for (const provider of routes.providers.filter((item) => PROVIDERS.includes(item))) {
    for (const skill of routes.skills) {
      if (typeof skill.id !== 'string') continue;
      if (scenario?.skill && skill.id !== scenario.skill) continue;
      if (!routeModeApplies(skill, scenario?.executionMode)) continue;
      for (const stage of stringArray(skill.stages)) {
        if (scenario?.stage && stage !== scenario.stage) continue;
        const sources = [];
        const main = sourceRecord(
          targetRoot,
          sourcePathForSkill(targetRoot, provider, skill.id),
          {
            role: 'skill',
            owner: 'skill',
            load: 'always',
            condition: `The ${skill.id} skill is selected for the ${stage} stage.`,
            conditionId: `skill:${skill.id}`,
          },
          diagnostics,
        );
        if (main) sources.push(main);
        if (provider === 'claude') {
          reportMirrorDrift(
            targetRoot,
            sourcePathForSkill(targetRoot, 'codex', skill.id),
            sourcePathForSkill(targetRoot, provider, skill.id),
            diagnostics,
            reportedMirrorDrift,
          );
        }

        const adapterPath = sourcePathForAdapter(targetRoot, provider, skill);
        if (adapterPath) {
          const adapter = sourceRecord(
            targetRoot,
            adapterPath,
            {
              role: 'provider-adapter',
              owner: 'provider-wrapper',
              load: 'always',
              condition: `Gemini invokes ${skill.id} through its generated command adapter.`,
              conditionId: `provider-adapter:${skill.id}`,
            },
            diagnostics,
          );
          if (adapter) {
            sources.push(adapter);
            const adapterText = readFileSync(adapterPath, 'utf8');
            const duplicatesCanonicalRouting = adapterText.includes('Conditional references for')
              || adapterText.includes('otherwise do not read it')
              || recordArray(skill.references).some((reference) => (
                declaredReferencePaths(reference)
                  .some((referencePath) => adapterText.includes(referencePath))
                || (
                  typeof reference.condition === 'string'
                  && adapterText.includes(reference.condition)
                )
              ));
            if (duplicatesCanonicalRouting) {
              diagnostics.push({
                severity: 'error',
                code: 'provider_adapter_route_drift',
                message: `Gemini adapter for ${skill.id} duplicates canonical reference routing instead of remaining a thin provider wrapper.`,
                paths: [adapter.path],
                owners: ['provider-wrapper'],
              });
            }
          }
        }

        let selectedReferences = [];
        try {
          selectedReferences = selectContextReferenceRoutes(routes, {
            provider,
            skill: skill.id,
            stage,
            phase: scenario?.phase ?? null,
            mode: scenario?.executionMode ?? null,
            conditionIds: scenario?.phase ? null : assembled ? activeConditions : null,
          });
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'context_route_resolution_failed',
            message: error.message,
          });
        }
        for (const reference of selectedReferences) {
          try {
            const resolved = readContextRouteSource(targetRoot, provider, reference);
            sources.push(resolvedReferenceSourceRecord(resolved));
          } catch (error) {
            diagnostics.push({
              severity: 'error',
              code: 'missing_context_source',
              message: error.message,
              paths: [normalizePath(path.join(
                provider === 'claude' ? '.claude' : '.agents',
                'skills',
                reference.sourceSkillId ?? skill.id,
                reference.relativePath,
              ))],
            });
            continue;
          }
          if (provider === 'claude') {
            reportMirrorDrift(
              targetRoot,
              sourcePathForSkill(targetRoot, 'codex', reference.sourceSkillId ?? skill.id, reference.canonicalPath),
              sourcePathForSkill(targetRoot, provider, reference.sourceSkillId ?? skill.id, reference.relativePath),
              diagnostics,
              reportedMirrorDrift,
            );
          }
        }

        for (const agent of routes.agents) {
          if (!stringArray(agent.skills).includes(skill.id) || !stringArray(agent.stages).includes(stage)) continue;
          if (!routeModeApplies(agent, scenario?.executionMode)) continue;
          const conditionId = agentConditionId(agent.id);
          if (assembled && !activeConditions.has(conditionId)) continue;
          const item = sourceRecord(
            targetRoot,
            sourcePathForAgent(targetRoot, provider, agent.id),
            {
              role: 'agent',
              owner: 'agent',
              load: 'conditional',
              condition: agent.condition,
              conditionId,
            },
            diagnostics,
          );
          if (item) sources.push(item);
        }

        sources.sort((left, right) => left.path.localeCompare(right.path));
        const owners = recordArray(routes.authorities)
          .filter((authority) => stringArray(authority.stages).includes(stage))
          .filter((authority) => !stringArray(authority.providers).length || stringArray(authority.providers).includes(provider))
          .filter((authority) => routeModeApplies(authority, scenario?.executionMode))
          .map((authority) => {
            if (!ownerCache.has(authority.id)) {
              ownerCache.set(authority.id, instructionOwnerRecord(targetRoot, authority, diagnostics));
            }
            return ownerCache.get(authority.id);
          })
          .filter(Boolean)
          .sort((left, right) => left.id.localeCompare(right.id));
        contexts.push({
          provider,
          skill: skill.id,
          stage,
          sources,
          owners,
          totals: summarizeSources(sources, { assembled }),
        });
      }
    }
  }
  if (scenario && !contexts.length) {
    diagnostics.push({
      severity: 'error',
      code: 'empty_context_scenario',
      message: `No context route matches skill=${scenario.skill} stage=${scenario.stage} mode=${scenario.executionMode ?? 'any'}.`,
    });
  }
  if (scenario) {
    const declaredConditions = new Set([
      ...routes.skills.flatMap((skill) => recordArray(skill.references)
        .map((reference) => referenceConditionId(skill.id, reference.path))),
      ...routes.agents.map((agent) => agentConditionId(agent.id)),
    ]);
    const applicableConditions = new Set([
      ...routes.skills
        .filter((skill) => skill.id === scenario.skill)
        .flatMap((skill) => recordArray(skill.references)
          .filter((reference) => stringArray(reference.stages).includes(scenario.stage))
          .filter((reference) => routeModeApplies(reference, scenario.executionMode))
          .filter((reference) => routes.providers.some((provider) => (
            referenceAppliesToProvider(reference, provider)
          )))
          .map((reference) => referenceConditionId(skill.id, reference.path))),
      ...routes.agents
        .filter((agent) => stringArray(agent.skills).includes(scenario.skill))
        .filter((agent) => stringArray(agent.stages).includes(scenario.stage))
        .filter((agent) => routeModeApplies(agent, scenario.executionMode))
        .map((agent) => agentConditionId(agent.id)),
    ]);
    for (const conditionId of activeConditions) {
      if (!declaredConditions.has(conditionId)) {
        diagnostics.push({
          severity: 'warn',
          code: 'unknown_context_condition',
          message: `Scenario condition is not declared by the canonical routes: ${conditionId}`,
        });
      } else if (!applicableConditions.has(conditionId)) {
        diagnostics.push({
          severity: 'warn',
          code: 'inapplicable_context_condition',
          message: `Scenario condition does not apply to ${scenario.skill}/${scenario.stage}/${scenario.executionMode ?? 'any'}: ${conditionId}`,
        });
      }
    }
  }
  return contexts.sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.skill.localeCompare(right.skill)
    || left.stage.localeCompare(right.stage)
  ));
}

function uniqueSources(contexts) {
  const sources = new Map();
  for (const context of contexts) {
    for (const source of context.sources) {
      const existing = sources.get(source.path);
      if (!existing || LOAD_PRIORITY[source.load] > LOAD_PRIORITY[existing.load]) {
        sources.set(source.path, source);
      }
    }
  }
  return [...sources.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeSources(sources, { assembled = false } = {}) {
  return sources.reduce((summary, source) => {
    if (source.load === 'always') summary.alwaysLoadedBytes += source.bytes;
    else summary.conditionalBytes += source.bytes;
    summary.estimatedTokens += source.estimatedTokens;
    if (assembled || source.load === 'always') {
      summary.promptBytes += source.bytes;
      summary.promptEstimatedTokens += source.estimatedTokens;
    }
    return summary;
  }, {
    alwaysLoadedBytes: 0,
    conditionalBytes: 0,
    estimatedTokens: 0,
    promptBytes: 0,
    promptEstimatedTokens: 0,
  });
}

function providerSummaries(contexts, providers, { assembled = false } = {}) {
  return providers.map((provider) => {
    const providerContexts = contexts.filter((context) => context.provider === provider);
    const sources = uniqueSources(providerContexts);
    return {
      provider,
      contexts: providerContexts.length,
      sources: sources.length,
      ...summarizeSources(sources, { assembled }),
    };
  });
}

function uniqueInstructionOwners(contexts) {
  const owners = new Map();
  for (const context of contexts) {
    for (const owner of context.owners ?? []) owners.set(`${owner.id}\0${owner.path}`, owner);
  }
  return [...owners.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalSourcePaths(targetRoot, routes) {
  const paths = new Set();
  for (const skill of routes.skills) {
    paths.add(sourcePathForSkill(targetRoot, 'codex', skill.id));
    for (const reference of recordArray(skill.references)) {
      for (const referencePath of declaredReferencePaths(reference)) {
        paths.add(sourcePathForSkill(targetRoot, 'codex', reference.source_skill ?? skill.id, referencePath));
      }
    }
    for (const provider of routes.providers) {
      const adapterPath = sourcePathForAdapter(targetRoot, provider, skill);
      if (adapterPath) paths.add(adapterPath);
    }
  }
  for (const agent of routes.agents) {
    paths.add(path.join(targetRoot, '.agents', 'agents', `${agent.id}.md`));
  }
  return [...paths].filter(isFile).sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function assembledSourcePaths(targetRoot, sources) {
  return [...new Set(sources
    .map((source) => safeAssetPath(source.path))
    .filter(Boolean)
    .map((relativePath) => path.join(targetRoot, relativePath)))]
    .filter(isFile)
    .sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function assembledDuplicateParagraphs(targetRoot, contexts) {
  const clusters = new Map();
  for (const context of contexts) {
    const filePaths = assembledSourcePaths(targetRoot, context.sources);
    for (const cluster of duplicateParagraphs(targetRoot, filePaths)) {
      const key = [
        cluster.hash,
        ...cluster.occurrences.map((occurrence) => (
          `${occurrence.path}\0${occurrence.count}`
        )),
      ].join('\0');
      if (!clusters.has(key)) clusters.set(key, cluster);
    }
  }
  return [...clusters.values()]
    .sort((left, right) => (
      right.occurrences.length - left.occurrences.length
      || left.hash.localeCompare(right.hash)
    ))
    .slice(0, 50);
}

function assembledConflictCandidates(targetRoot, contexts) {
  const candidates = new Map();
  for (const context of contexts) {
    const filePaths = assembledSourcePaths(targetRoot, context.sources);
    for (const candidate of conflictCandidates(targetRoot, filePaths)) {
      const key = [
        candidate.hash,
        ...candidate.positiveOccurrences.map((occurrence) => (
          `positive\0${occurrence.path}\0${occurrence.text}`
        )),
        ...candidate.negativeOccurrences.map((occurrence) => (
          `negative\0${occurrence.path}\0${occurrence.text}`
        )),
      ].join('\0');
      if (!candidates.has(key)) candidates.set(key, candidate);
    }
  }
  return [...candidates.values()]
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .slice(0, 50);
}

function normalizeParagraph(paragraph) {
  return paragraph
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/[`*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function duplicateParagraphs(targetRoot, filePaths) {
  const paragraphs = new Map();
  const records = [];
  for (const filePath of filePaths) {
    const relativePath = normalizePath(path.relative(targetRoot, filePath));
    const localCounts = new Map();
    for (const paragraph of readFileSync(filePath, 'utf8').split(/\n\s*\n/)) {
      const normalized = normalizeParagraph(paragraph);
      if (normalized.length < 120) continue;
      localCounts.set(normalized, (localCounts.get(normalized) ?? 0) + 1);
    }
    for (const [normalized, count] of localCounts) {
      const occurrences = paragraphs.get(normalized) ?? [];
      occurrences.push({ path: relativePath, count, owner: instructionOwnerForPath(relativePath) ?? 'skill' });
      paragraphs.set(normalized, occurrences);
      records.push({ normalized, path: relativePath, count });
    }
  }
  const clusters = [...paragraphs.entries()]
    .filter(([, occurrences]) => new Set(occurrences.map((item) => item.path)).size >= 2)
    .map(([normalized, occurrences]) => ({
      hash: digest(normalized),
      preview: `sha256:${digest(normalized)}`,
      occurrences: occurrences.sort((left, right) => left.path.localeCompare(right.path)),
    }));

  function tokenSet(value) {
    return new Set(value.split(/[^a-z0-9가-힣]+/u).filter((token) => token.length > 2));
  }
  function similarity(left, right) {
    const leftTokens = tokenSet(left);
    const rightTokens = tokenSet(right);
    if (!leftTokens.size || !rightTokens.size) return 0;
    const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    return intersection / new Set([...leftTokens, ...rightTokens]).size;
  }
  const nearPairs = new Set();
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const first = records[left];
      const second = records[right];
      if (first.path === second.path || first.normalized === second.normalized) continue;
      const lengthRatio = Math.min(first.normalized.length, second.normalized.length)
        / Math.max(first.normalized.length, second.normalized.length);
      const score = lengthRatio >= 0.85 ? similarity(first.normalized, second.normalized) : 0;
      if (score < 0.9) continue;
      const key = [first.path, second.path].sort().join('\0');
      if (nearPairs.has(key)) continue;
      nearPairs.add(key);
      const pairHash = digest([first.normalized, second.normalized].sort().join('\0'));
      clusters.push({
        hash: pairHash,
        preview: `sha256:${pairHash}`,
        occurrences: [
          { path: first.path, count: first.count, owner: instructionOwnerForPath(first.path) ?? 'skill' },
          { path: second.path, count: second.count, owner: instructionOwnerForPath(second.path) ?? 'skill' },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }
  return clusters
    .sort((left, right) => (
      right.occurrences.length - left.occurrences.length
      || left.hash.localeCompare(right.hash)
    ))
    .slice(0, 50);
}

function conflictCandidates(targetRoot, filePaths) {
  const directives = new Map();
  const negativePattern = /\b(?:do not|don't|never|must not|cannot|can't|should not|forbid(?:den)?|prohibit(?:ed)?)\b/i;
  const positivePattern = /\b(?:always|must|required?|should|allow(?:ed)?|permit(?:ted)?)\b/i;
  const modalPattern = /\b(?:do not|don't|never|must not|cannot|can't|should not|forbid(?:den)?|prohibit(?:ed)?|always|must|required?|should|allow(?:ed)?|permit(?:ted)?)\b/gi;
  for (const filePath of filePaths) {
    const relativePath = normalizePath(path.relative(targetRoot, filePath));
    const fragments = readFileSync(filePath, 'utf8').split(/(?:\n+|(?<=[.!?])\s+)/u);
    for (const fragment of fragments) {
      const text = normalizeParagraph(fragment);
      const polarity = negativePattern.test(text) ? 'negative' : positivePattern.test(text) ? 'positive' : null;
      if (!polarity) continue;
      const fingerprint = text
        .replace(modalPattern, ' ')
        .replace(/[^a-z0-9가-힣]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (fingerprint.length < 35) continue;
      const record = directives.get(fingerprint) ?? { positive: [], negative: [] };
      record[polarity].push({
        path: relativePath,
        text: `sha256:${digest(text)}`,
        owner: instructionOwnerForPath(relativePath) ?? 'skill',
      });
      directives.set(fingerprint, record);
    }
  }
  return [...directives.entries()]
    .filter(([, occurrences]) => occurrences.positive.length && occurrences.negative.length)
    .map(([fingerprint, occurrences]) => ({
      hash: digest(fingerprint),
      preview: `sha256:${digest(fingerprint)}`,
      positiveOccurrences: occurrences.positive.sort((left, right) => left.path.localeCompare(right.path)),
      negativeOccurrences: occurrences.negative.sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .slice(0, 50);
}

function normalizedScenarioIdentity(scenario) {
  if (!scenario) return null;
  return {
    skill: scenario.skill,
    stage: scenario.stage,
    phase: scenario.phase ?? null,
    executionMode: scenario.executionMode ?? null,
    conditions: [...stringArray(scenario.conditions)].sort(),
  };
}

function reportProviderIds(report) {
  if (Array.isArray(report.providers)) {
    return report.providers
      .map((provider) => provider?.provider)
      .filter((provider) => PROVIDERS.includes(provider))
      .sort();
  }
  return [...new Set((report.contexts ?? [])
    .map((context) => context?.provider)
    .filter((provider) => PROVIDERS.includes(provider)))]
    .sort();
}

function comparableSourceMap(report) {
  const sources = new Map();
  for (const context of recordArray(report?.contexts)) {
    if (!PROVIDERS.includes(context.provider)) continue;
    for (const source of recordArray(context.sources)) {
      if (typeof source.path !== 'string' || typeof source.conditionId !== 'string') continue;
      const identity = [
        context.provider,
        context.skill,
        context.stage,
        source.path,
        source.conditionId,
      ].join(':');
      sources.set(identity, {
        identity,
        path: source.path,
        load: source.load,
        required: typeof source.required === 'boolean' ? source.required : null,
        condition: source.condition,
        role: source.role,
        owner: source.owner,
        sha256: source.sha256,
      });
    }
  }
  return sources;
}

function comparisonOwners(paths, contexts, baseline) {
  const owners = new Set();
  const currentSources = comparableSourceMap({ contexts });
  const baselineSources = comparableSourceMap(baseline ?? {});
  const sourceRecords = [
    ...currentSources.values(),
    ...baselineSources.values(),
  ];
  for (const sourcePath of paths) {
    const exact = currentSources.get(sourcePath) ?? baselineSources.get(sourcePath);
    if (exact?.owner) owners.add(exact.owner);
    for (const source of sourceRecords) {
      if (source.path === sourcePath && source.owner) owners.add(source.owner);
    }
    const inferred = instructionOwnerForPath(sourcePath);
    if (inferred) owners.add(inferred);
  }
  return [...owners].sort();
}

function sourceRouteIdentity(source) {
  return JSON.stringify([
    source.load,
    source.required,
    source.condition,
    source.role,
    source.owner,
  ]);
}

function compareBaseline(report, baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
  const baselineSummary = baseline.summary && typeof baseline.summary === 'object' ? baseline.summary : {};
  const measurementMatches = baseline.measurement === report.measurement;
  const scenarioMatches = JSON.stringify(normalizedScenarioIdentity(baseline.scenario))
    === JSON.stringify(normalizedScenarioIdentity(report.scenario));
  const providerSetMatches = JSON.stringify(reportProviderIds(baseline))
    === JSON.stringify(reportProviderIds(report));
  const comparable = measurementMatches && scenarioMatches && providerSetMatches;
  let conditionalPromotedToAlways = [];
  let addedSources = [];
  let removedSources = [];
  let contentChangedSources = [];
  let routeChangedSources = [];
  if (comparable) {
    const beforeSources = new Map(uniqueSources(Array.isArray(baseline.contexts) ? baseline.contexts : [])
      .map((source) => [source.path, source.load]));
    const afterSources = new Map(uniqueSources(report.contexts).map((source) => [source.path, source.load]));
    conditionalPromotedToAlways = [...afterSources.entries()]
      .filter(([sourcePath, load]) => load === 'always' && ['conditional', 'on-demand'].includes(beforeSources.get(sourcePath)))
      .map(([sourcePath]) => sourcePath)
      .sort();
    const beforeComparableSources = comparableSourceMap(baseline);
    const afterComparableSources = comparableSourceMap(report);
    addedSources = [...afterComparableSources.keys()]
      .filter((identity) => !beforeComparableSources.has(identity))
      .sort();
    removedSources = [...beforeComparableSources.keys()]
      .filter((identity) => !afterComparableSources.has(identity))
      .sort();
    contentChangedSources = [...afterComparableSources.entries()]
      .filter(([identity, source]) => (
        beforeComparableSources.has(identity)
          && beforeComparableSources.get(identity).sha256 !== source.sha256
      ))
      .map(([identity]) => identity)
      .sort();
    routeChangedSources = [...afterComparableSources.entries()]
      .filter(([identity, source]) => (
        beforeComparableSources.has(identity)
          && sourceRouteIdentity(beforeComparableSources.get(identity)) !== sourceRouteIdentity(source)
      ))
      .map(([identity]) => identity)
      .sort();
  }
  const baselinePromptBytes = Number.isInteger(baselineSummary.promptBytes)
    ? baselineSummary.promptBytes
    : Number.isInteger(baselineSummary.alwaysLoadedBytes) ? baselineSummary.alwaysLoadedBytes : 0;
  return {
    baselineGeneratedAt: typeof baseline.generatedAt === 'string' ? baseline.generatedAt : null,
    measurementMatches,
    scenarioMatches,
    providerSetMatches,
    comparable,
    alwaysLoadedBytesDelta: comparable
      ? report.summary.alwaysLoadedBytes - (baselineSummary.alwaysLoadedBytes ?? 0)
      : null,
    promptBytesDelta: comparable
      ? report.summary.promptBytes - baselinePromptBytes
      : null,
    conditionalPromotedToAlways,
    addedSources,
    removedSources,
    contentChangedSources,
    routeChangedSources,
  };
}

function normalizeScenario(value, routes, diagnostics) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push({ severity: 'error', code: 'invalid_context_scenario', message: 'Context scenario must be an object.' });
    return null;
  }
  const skill = typeof value.skill === 'string' ? value.skill.trim() : '';
  const stage = typeof value.stage === 'string' ? value.stage.trim() : '';
  const executionMode = value.executionMode === null || value.executionMode === undefined
    ? null
    : String(value.executionMode).trim();
  const conditions = [...new Set(stringArray(value.conditions))].sort();
  const phase = value.phase === null || value.phase === undefined ? null : String(value.phase).trim();
  if (!skill || !stage || (phase && !CONTEXT_PHASES.includes(phase)) || (executionMode && !EXECUTION_MODES.includes(executionMode))) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid_context_scenario',
      message: 'Context scenario requires skill/stage and optional known phase and direct|planned|orchestrated executionMode.',
    });
  }
  const skillRoute = routes.skills.find((item) => item.id === skill);
  if (!skillRoute || !stringArray(skillRoute.stages).includes(stage)) {
    diagnostics.push({
      severity: 'error',
      code: 'unknown_context_scenario_route',
      message: `Context scenario does not match a canonical skill/stage route: ${skill || '<missing>'}/${stage || '<missing>'}`,
    });
  }
  return { skill, stage, phase, executionMode, conditions };
}

function emptyAudit(targetRoot, manifestPath, diagnostics, { scenario = null } = {}) {
  const failures = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warn').length;
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    measurement: scenario ? 'assembled' : 'inventory',
    scenario,
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    manifestPath: normalizePath(path.relative(targetRoot, manifestPath)) || '.',
    status: failures ? 'fail' : warnings ? 'warn' : 'pass',
    summary: {
      providerCount: 0,
      skillCount: 0,
      contextCount: 0,
      sourceCount: 0,
      ownerCount: 0,
      alwaysLoadedBytes: 0,
      conditionalBytes: 0,
      estimatedTokens: 0,
      promptBytes: 0,
      promptEstimatedTokens: 0,
      duplicateClusters: 0,
      conflictCandidates: 0,
      warnings,
      failures,
    },
    providers: [],
    contexts: [],
    instructionOwners: [],
    duplicateClusters: [],
    conflictCandidates: [],
    baselineComparison: null,
    diagnostics,
  };
}

export function auditContext(targetRootInput, options = {}) {
  const targetRoot = path.resolve(targetRootInput);
  const manifestPath = path.join(targetRoot, '.agents', 'context-routes.json');
  const diagnostics = [];
  if (!isDirectory(targetRoot)) {
    diagnostics.push({ severity: 'error', code: 'missing_target', message: `Target directory is missing: ${targetRoot}` });
    return emptyAudit(targetRoot, manifestPath, diagnostics, { scenario: options.scenario ?? null });
  }
  if (!isFile(manifestPath)) {
    diagnostics.push({
      severity: 'error',
      code: 'missing_route_manifest',
      message: 'Canonical context route manifest is missing: .agents/context-routes.json',
      paths: ['.agents/context-routes.json'],
    });
    return emptyAudit(targetRoot, manifestPath, diagnostics, { scenario: options.scenario ?? null });
  }
  const manifestResult = readJson(manifestPath);
  if (!manifestResult.ok) {
    diagnostics.push({
      severity: 'error',
      code: 'unreadable_route_manifest',
      message: `Canonical context route manifest is not readable JSON: ${manifestResult.error}`,
      paths: ['.agents/context-routes.json'],
    });
    return emptyAudit(targetRoot, manifestPath, diagnostics, { scenario: options.scenario ?? null });
  }

  try {
    validateSchema(manifestResult.data, ROUTE_SCHEMA);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'invalid_route_manifest_schema',
      message: `Canonical context route manifest fails context-routes.schema.json: ${error.message}`,
      paths: ['.agents/context-routes.json'],
    });
    return emptyAudit(targetRoot, manifestPath, diagnostics, { scenario: options.scenario ?? null });
  }

  const routes = validateRouteManifest(targetRoot, manifestResult.data, diagnostics);
  const installManifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  if (isFile(installManifestPath)) {
    const installManifest = readJson(installManifestPath);
    if (installManifest.ok && Array.isArray(installManifest.data?.aiToolTargets)) {
      const selectedProviders = stringArray(installManifest.data.aiToolTargets)
        .filter((provider) => PROVIDERS.includes(provider));
      routes.providers = routes.providers.filter((provider) => selectedProviders.includes(provider));
    }
  }
  const scenario = normalizeScenario(options.scenario, routes, diagnostics);
  if (options.scenario && !scenario) {
    return emptyAudit(targetRoot, manifestPath, diagnostics);
  }
  const assembled = Boolean(scenario);
  const contexts = buildContexts(targetRoot, routes, diagnostics, scenario);
  const providers = providerSummaries(
    contexts,
    routes.providers.filter((item) => PROVIDERS.includes(item)),
    { assembled },
  );
  const sources = uniqueSources(contexts);
  const instructionOwners = uniqueInstructionOwners(contexts);
  const sourceTotals = summarizeSources(sources, { assembled });
  const diagnosticPaths = assembled ? null : canonicalSourcePaths(targetRoot, routes);
  const duplicateClusters = assembled
    ? assembledDuplicateParagraphs(targetRoot, contexts)
    : duplicateParagraphs(targetRoot, diagnosticPaths);
  const conflicts = assembled
    ? assembledConflictCandidates(targetRoot, contexts)
    : conflictCandidates(targetRoot, diagnosticPaths);
  if (duplicateClusters.length) {
    const occurrences = duplicateClusters.flatMap((cluster) => cluster.occurrences);
    diagnostics.push({
      severity: 'info',
      code: 'duplicate_instruction_candidates',
      message: `${duplicateClusters.length} exact or near-duplicate paragraph cluster(s) are candidates for consolidation.`,
      paths: [...new Set(occurrences.map((occurrence) => occurrence.path))].sort(),
      owners: [...new Set(occurrences.map((occurrence) => occurrence.owner))].sort(),
    });
  }
  if (conflicts.length) {
    const occurrences = conflicts.flatMap((candidate) => [
      ...candidate.positiveOccurrences,
      ...candidate.negativeOccurrences,
    ]);
    diagnostics.push({
      severity: 'info',
      code: 'conflicting_instruction_candidates',
      message: `${conflicts.length} opposite-polarity directive candidate(s) need human review.`,
      paths: [...new Set(occurrences.map((occurrence) => occurrence.path))].sort(),
      owners: [...new Set(occurrences.map((occurrence) => occurrence.owner))].sort(),
    });
  }
  const measurement = assembled ? 'assembled' : 'inventory';
  const summary = {
    providerCount: providers.length,
    skillCount: new Set(contexts.map((context) => context.skill)).size,
    contextCount: contexts.length,
    sourceCount: sources.length,
    ownerCount: instructionOwners.length,
    ...sourceTotals,
    duplicateClusters: duplicateClusters.length,
    conflictCandidates: conflicts.length,
    warnings: 0,
    failures: 0,
  };
  let baseline = options.baseline ?? null;
  if (baseline) {
    try {
      validateSchema(baseline, AUDIT_SCHEMA);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'invalid_context_baseline',
        message: `Context baseline fails context-audit.schema.json: ${error.message}`,
      });
      baseline = null;
    }
  }
  const baselineComparison = compareBaseline({
    measurement,
    scenario,
    summary,
    providers,
    contexts,
  }, baseline);
  if (baselineComparison) {
    if (baselineComparison.comparable) {
      const sizeChanged = baselineComparison.alwaysLoadedBytesDelta !== 0
        || baselineComparison.promptBytesDelta !== 0;
      diagnostics.push({
        severity: sizeChanged ? 'warn' : 'info',
        code: 'context_size_change',
        message: `Always-loaded bytes changed by ${baselineComparison.alwaysLoadedBytesDelta}; unique resolved corpus bytes changed by ${baselineComparison.promptBytesDelta}.`,
      });
    }
    if (!baselineComparison.measurementMatches) {
      diagnostics.push({
        severity: 'warn',
        code: 'context_baseline_measurement_mismatch',
        message: `Baseline measurement ${baseline.measurement} cannot be compared directly with ${measurement}.`,
      });
    }
    if (!baselineComparison.scenarioMatches) {
      diagnostics.push({
        severity: 'warn',
        code: 'context_baseline_scenario_mismatch',
        message: 'Baseline and current audit scenarios differ; size and load-promotion deltas were not calculated.',
      });
    }
    if (!baselineComparison.providerSetMatches) {
      diagnostics.push({
        severity: 'warn',
        code: 'context_baseline_provider_mismatch',
        message: 'Baseline and current provider sets differ; size and load-promotion deltas were not calculated.',
      });
    }
    if (baselineComparison.conditionalPromotedToAlways.length) {
      const paths = baselineComparison.conditionalPromotedToAlways;
      diagnostics.push({
        severity: 'warn',
        code: 'conditional_context_promoted_to_always',
        message: `${paths.length} source(s) changed from conditional/on-demand to always-loaded.`,
        paths,
        owners: comparisonOwners(paths, contexts, baseline),
      });
    }
    if (baselineComparison.addedSources.length || baselineComparison.removedSources.length) {
      const paths = [...baselineComparison.addedSources, ...baselineComparison.removedSources];
      diagnostics.push({
        severity: 'warn',
        code: 'context_source_set_changed',
        message: `${baselineComparison.addedSources.length} source route(s) were added and ${baselineComparison.removedSources.length} were removed relative to the baseline.`,
        paths,
        owners: comparisonOwners(paths, contexts, baseline),
      });
    }
    if (baselineComparison.contentChangedSources.length) {
      const paths = baselineComparison.contentChangedSources;
      diagnostics.push({
        severity: 'warn',
        code: 'context_source_content_changed',
        message: `${paths.length} source route(s) have different SHA-256 content from the baseline.`,
        paths,
        owners: comparisonOwners(paths, contexts, baseline),
      });
    }
    if (baselineComparison.routeChangedSources.length) {
      const paths = baselineComparison.routeChangedSources;
      diagnostics.push({
        severity: 'warn',
        code: 'context_source_route_changed',
        message: `${paths.length} source route(s) changed load, requirement, condition, role, or owner metadata.`,
        paths,
        owners: comparisonOwners(paths, contexts, baseline),
      });
    }
  }
  const failures = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warn').length;
  summary.failures = failures;
  summary.warnings = warnings;
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    measurement,
    scenario,
    generatedAt: new Date().toISOString(),
    target: targetRoot,
    manifestPath: '.agents/context-routes.json',
    status: failures ? 'fail' : warnings ? 'warn' : 'pass',
    summary,
    providers,
    contexts,
    instructionOwners,
    duplicateClusters,
    conflictCandidates: conflicts,
    baselineComparison,
    diagnostics,
  };
}

export function printContextAudit(report) {
  console.log(`Plan2Agent context audit: ${report.status}`);
  console.log(`target: ${report.target}`);
  console.log(`manifest: ${report.manifestPath}`);
  console.log(`measurement: ${report.measurement}`);
  if (report.scenario) {
    console.log(`scenario: skill=${report.scenario.skill} stage=${report.scenario.stage} phase=${report.scenario.phase ?? 'any'} mode=${report.scenario.executionMode ?? 'any'} conditions=${report.scenario.conditions.length}`);
  }
  console.log(
    `summary: ${report.summary.providerCount} provider(s), ${report.summary.skillCount} skill(s), ${report.summary.contextCount} context(s), ${report.summary.sourceCount} source(s)`,
  );
  console.log(
    `declared bytes: ${report.summary.alwaysLoadedBytes} always, ${report.summary.conditionalBytes} conditional/on-demand, ~${report.summary.estimatedTokens} declared token(s)`,
  );
  console.log(`unique resolved corpus: ${report.summary.promptBytes} byte(s), ~${report.summary.promptEstimatedTokens} token(s)`);
  console.log(`instruction owners: ${report.summary.ownerCount}`);
  console.log(`duplicate candidates: ${report.summary.duplicateClusters}`);
  for (const cluster of report.duplicateClusters) {
    console.log(`  duplicate ${cluster.hash}:`);
    for (const occurrence of cluster.occurrences) {
      console.log(`    owner: ${occurrence.owner}; path: ${occurrence.path}; count: ${occurrence.count}`);
    }
  }
  console.log(`conflict candidates: ${report.summary.conflictCandidates}`);
  for (const candidate of report.conflictCandidates) {
    console.log(`  conflict ${candidate.hash}:`);
    for (const occurrence of [...candidate.positiveOccurrences, ...candidate.negativeOccurrences]) {
      console.log(`    owner: ${occurrence.owner}; path: ${occurrence.path}`);
    }
  }
  for (const provider of report.providers) {
    console.log(
      `- ${provider.provider}: ${provider.contexts} context(s), ${provider.sources} source(s), ${provider.promptBytes} resolved byte(s), ~${provider.promptEstimatedTokens} resolved token(s)`,
    );
  }
  if (report.baselineComparison) {
    const alwaysDelta = report.baselineComparison.alwaysLoadedBytesDelta ?? 'n/a';
    const promptDelta = report.baselineComparison.promptBytesDelta ?? 'n/a';
    console.log(`baseline: comparable=${report.baselineComparison.comparable ?? true}, always delta=${alwaysDelta}, corpus delta=${promptDelta}, promoted=${report.baselineComparison.conditionalPromotedToAlways.length}, added=${report.baselineComparison.addedSources?.length ?? 0}, removed=${report.baselineComparison.removedSources?.length ?? 0}, content changed=${report.baselineComparison.contentChangedSources?.length ?? 0}, route changed=${report.baselineComparison.routeChangedSources?.length ?? 0}`);
  }
  for (const diagnostic of report.diagnostics) {
    const prefix = diagnostic.severity === 'error' ? 'FAIL' : diagnostic.severity === 'warn' ? 'WARN' : 'INFO';
    console.log(`- ${prefix} ${diagnostic.code}: ${diagnostic.message}`);
    for (const owner of diagnostic.owners ?? []) console.log(`  owner: ${owner}`);
    for (const filePath of diagnostic.paths ?? []) console.log(`  path: ${filePath}`);
  }
}
