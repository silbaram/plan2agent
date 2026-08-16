/** Resolve schema-declared Plan2Agent context references through one confined path. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import { validateSchema } from './p2a_schema.mjs';

export const CONTEXT_PROVIDERS = Object.freeze(['codex', 'claude', 'gemini']);
export const CONTEXT_PHASES = Object.freeze([
  'prepare',
  'owner-start',
  'retry',
  'verify-closeout',
  'batch',
  'visual-review',
  'acceptance-review',
  'monitor',
]);
export const CONTEXT_MODES = Object.freeze(['direct', 'planned', 'orchestrated']);

const ROUTE_SCHEMA = JSON.parse(readFileSync(
  new URL('../schemas/context-routes.schema.json', import.meta.url),
  'utf8',
));

export function normalizeContextPath(value) {
  return String(value).replaceAll(path.sep, '/');
}

export function referenceConditionId(skillId, referencePath) {
  return `reference:${skillId}:${normalizeContextPath(referencePath)}`;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
    : [];
}

export function routeModeApplies(route, mode) {
  if (!mode) return true;
  const modes = stringArray(route?.modes);
  return !modes.length || modes.includes(mode);
}

export function referenceAppliesToProvider(reference, provider) {
  const providers = stringArray(reference?.providers);
  return !providers.length || providers.includes(provider);
}

export function referencePathForProvider(reference, provider) {
  const override = (reference.provider_paths ?? []).find((item) => item?.provider === provider);
  return override?.path ?? reference.path;
}

function assertRelativeReferencePath(value, label) {
  const normalized = typeof value === 'string' ? normalizeContextPath(value) : '';
  if (
    !normalized.startsWith('references/')
    || normalized.includes('../')
    || path.isAbsolute(value)
  ) {
    throw new Error(`${label} must stay under references/: ${String(value)}`);
  }
  return normalized;
}

function stableReferenceIds(routes) {
  const ids = new Map();
  for (const skill of routes.skills) {
    for (const reference of skill.references) {
      const previous = ids.get(reference.id);
      if (previous) {
        throw new Error(`duplicate context route id ${reference.id}: ${previous} and ${skill.id}/${reference.path}`);
      }
      ids.set(reference.id, `${skill.id}/${reference.path}`);
    }
  }
  return ids;
}

export function validateContextRoutesData(routes) {
  validateSchema(routes, ROUTE_SCHEMA);
  const skillIds = new Set();
  for (const skill of routes.skills) {
    if (skillIds.has(skill.id)) throw new Error(`duplicate context skill id: ${skill.id}`);
    skillIds.add(skill.id);
    const paths = new Set();
    for (const reference of skill.references) {
      assertRelativeReferencePath(reference.path, `${reference.id}.path`);
      if (paths.has(reference.path)) {
        throw new Error(`duplicate context reference path for ${skill.id}: ${reference.path}`);
      }
      paths.add(reference.path);
      for (const override of reference.provider_paths ?? []) {
        assertRelativeReferencePath(override.path, `${reference.id}.provider_paths.${override.provider}`);
      }
    }
  }
  stableReferenceIds(routes);
  return routes;
}

export function loadContextRoutes(targetRootInput) {
  const targetRoot = path.resolve(targetRootInput);
  const manifestPath = path.join(targetRoot, '.agents', 'context-routes.json');
  let routes;
  try {
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error('manifest must be a regular non-symlink file');
    }
    routes = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`context route manifest is unreadable: ${manifestPath}: ${error.message}`);
  }
  return {
    targetRoot,
    manifestPath,
    routes: validateContextRoutesData(routes),
  };
}

export function selectContextReferenceRoutes(routesInput, options) {
  const routes = validateContextRoutesData(routesInput);
  const provider = options.provider;
  const skillId = options.skill;
  const phase = options.phase ?? null;
  const stage = options.stage ?? null;
  const mode = options.mode ?? null;
  const conditionIds = options.conditionIds === null || options.conditionIds === undefined
    ? null
    : new Set(options.conditionIds);

  if (!CONTEXT_PROVIDERS.includes(provider) || !routes.providers.includes(provider)) {
    throw new Error(`unknown context provider: ${String(provider)}`);
  }
  if (phase && !CONTEXT_PHASES.includes(phase)) throw new Error(`unknown context phase: ${phase}`);
  if (mode && !CONTEXT_MODES.includes(mode)) throw new Error(`unknown context execution mode: ${mode}`);
  const skill = routes.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error(`unknown context skill route: ${String(skillId)}`);
  if (stage && !stringArray(skill.stages).includes(stage)) {
    throw new Error(`context stage ${stage} does not apply to ${skillId}`);
  }
  if (!routeModeApplies(skill, mode)) {
    throw new Error(`context mode ${mode} does not apply to ${skillId}`);
  }

  return skill.references
    .filter((reference) => !stage || stringArray(reference.stages).includes(stage))
    .filter((reference) => !phase || stringArray(reference.phases).includes(phase))
    .filter((reference) => routeModeApplies(reference, mode))
    .filter((reference) => referenceAppliesToProvider(reference, provider))
    .filter((reference) => (
      conditionIds === null
      || conditionIds.has(referenceConditionId(skillId, reference.path))
    ))
    .map((reference) => ({
      skillId,
      routeId: reference.id,
      conditionId: referenceConditionId(skillId, reference.path),
      relativePath: assertRelativeReferencePath(
        referencePathForProvider(reference, provider),
        `${reference.id}.${provider}`,
      ),
      canonicalPath: reference.path,
      load: reference.load,
      required: reference.required,
      condition: reference.condition,
      phases: [...reference.phases],
      stages: [...reference.stages],
      modes: [...(reference.modes ?? [])],
    }))
    .sort((left, right) => (
      left.routeId.localeCompare(right.routeId)
      || left.relativePath.localeCompare(right.relativePath)
    ));
}

function skillSourceRoot(targetRoot, provider, skillId) {
  const providerRoot = provider === 'claude' ? '.claude' : '.agents';
  return path.join(targetRoot, providerRoot, 'skills', skillId);
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function readContextRouteSource(targetRootInput, provider, route) {
  const targetRoot = path.resolve(targetRootInput);
  const sourceRoot = skillSourceRoot(targetRoot, provider, route.skillId);
  const candidate = path.join(sourceRoot, route.relativePath);
  if (!existsSync(sourceRoot)) throw new Error(`context source root is missing: ${sourceRoot}`);
  if (!pathIsInside(sourceRoot, candidate)) throw new Error(`context source escapes its declared root: ${route.relativePath}`);
  const candidateStat = lstatSync(candidate);
  if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
    throw new Error(`context source must be a regular non-symlink file: ${route.relativePath}`);
  }
  const confinedRoot = realpathSync(sourceRoot);
  const confinedTarget = realpathSync(targetRoot);
  if (!pathIsInside(confinedTarget, confinedRoot)) {
    throw new Error(`context source root resolves outside the target: ${route.skillId}`);
  }
  const confinedSource = realpathSync(candidate);
  if (!pathIsInside(confinedRoot, confinedSource)) {
    throw new Error(`context source resolves outside its declared root: ${route.relativePath}`);
  }
  const raw = readFileSync(confinedSource);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error(`context source must contain valid UTF-8 text: ${route.relativePath}`);
  }
  const body = text.replace(/\r\n?/g, '\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  return {
    routeId: route.routeId,
    conditionId: route.conditionId,
    path: normalizeContextPath(path.relative(targetRoot, confinedSource)),
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    bytes,
    body,
    load: route.load,
    required: route.required,
    condition: route.condition,
  };
}

function assertRuntimeEligibility(phase, eligibility = {}) {
  const runKind = eligibility.runKind ?? null;
  if (phase === 'verify-closeout' && runKind) {
    throw new Error('verify-closeout is only valid for an ordinary implementation run');
  }
  if (phase === 'visual-review' && !(eligibility.visualContract && runKind === 'final_visual_review')) {
    throw new Error('visual-review requires an approved visual contract and final_visual_review run');
  }
  if (phase === 'acceptance-review' && !(eligibility.acceptanceActive && runKind === 'final_acceptance_review')) {
    throw new Error('acceptance-review requires active acceptance policy and final_acceptance_review run');
  }
  if (phase === 'monitor' && !(!runKind && eligibility.monitorRequired)) {
    throw new Error('monitor requires an ordinary implementation run with an active monitor gate');
  }
}

export function resolveRuntimeContext(options) {
  const { targetRoot, routes } = loadContextRoutes(options.targetRoot);
  const skill = options.skill ?? 'p2a-dev-execution';
  const mode = options.mode ?? null;
  if (skill !== 'p2a-dev-execution') {
    throw new Error(`runtime context rollout currently supports p2a-dev-execution only: ${skill}`);
  }
  if (mode === 'orchestrated' || options.phase === 'batch') {
    throw new Error('runtime context rollout currently supports Direct/Planned non-batch execution only');
  }
  assertRuntimeEligibility(options.phase, options.eligibility);
  const selected = selectContextReferenceRoutes(routes, {
    provider: options.provider,
    skill,
    phase: options.phase,
    mode,
  });
  if (!selected.length) {
    throw new Error(`no runtime context route for ${skill}/${options.phase}/${mode ?? 'any'}`);
  }
  const sources = selected.map((route) => readContextRouteSource(targetRoot, options.provider, route));
  const seenPaths = new Set();
  const uniqueSources = [];
  for (const source of sources) {
    if (seenPaths.has(source.path)) continue;
    seenPaths.add(source.path);
    uniqueSources.push(source);
  }
  return {
    provider: options.provider,
    skill,
    phase: options.phase,
    mode,
    sources: uniqueSources,
  };
}
