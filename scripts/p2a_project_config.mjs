/** Shared Plan2Agent project config detection and merge helpers. */

import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ORCHESTRATION_AGENT_TOOLS = new Set(['codex', 'claude', 'manual']);
const AI_TOOL_TARGETS = new Set(['codex', 'claude', 'gemini']);
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 600000;

export function defaultRunTracking() {
  return {
    runsDir: '.plan2agent/runs',
    defaultIsolation: 'none',
    branchPattern: 'p2a/<taskId>-<runId>',
    worktreePattern: '../.worktrees/<taskId>-<runId>',
  };
}

export function defaultProviderNativeCapabilities() {
  return {
    codex: {
      skills: 'manual_check',
      customAgents: 'manual_check',
      explicitSubagentPrompt: 'manual_check',
    },
    claude: {
      subagents: 'manual_check',
      skills: 'manual_check',
      agentTeams: 'manual_check',
    },
    gemini: {
      extensions: 'manual_check',
      customCommands: 'manual_check',
      geminiContext: 'manual_check',
    },
  };
}

export function defaultDevExecution() {
  return {
    defaultProvider: 'codex',
    allowedProviders: ['codex', 'claude', 'gemini', 'manual'],
    writeProviders: ['codex', 'claude'],
    readOnlyProviders: ['gemini'],
    defaultIsolation: 'none',
    scopePolicy: 'task_only',
    verificationPolicy: 'required_for_done',
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedProviderValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizedProviderList(value) {
  return Array.isArray(value)
    ? value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
    : [];
}

function uniqueOrdered(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function resolveOrchestrationAgentTool(config, manifest) {
  const defaults = defaultDevExecution();
  const devExecution = objectValue(config?.devExecution);
  const configuredAllowed = normalizedProviderList(devExecution.allowedProviders);
  const configuredWrite = normalizedProviderList(devExecution.writeProviders);
  const allowedSet = new Set(configuredAllowed.length ? configuredAllowed : defaults.allowedProviders);
  const writeProviders = configuredWrite.length ? configuredWrite : defaults.writeProviders;
  const writeSet = new Set(writeProviders);
  const defaultProvider = normalizedProviderValue(devExecution.defaultProvider) ?? defaults.defaultProvider;
  const manifestTargets = normalizedProviderList(manifest?.aiToolTargets)
    .filter((target) => AI_TOOL_TARGETS.has(target));
  const manifestTargetSet = new Set(manifestTargets);
  const hasManifestTargets = manifestTargets.length > 0;
  const candidates = uniqueOrdered([
    defaultProvider,
    ...writeProviders,
    ...configuredAllowed,
    ...defaults.writeProviders,
    'manual',
  ]);

  for (const tool of candidates) {
    if (!ORCHESTRATION_AGENT_TOOLS.has(tool) || !allowedSet.has(tool)) continue;
    if (tool === 'manual') return tool;
    if (!writeSet.has(tool)) continue;
    if (!hasManifestTargets) continue;
    if (!manifestTargetSet.has(tool)) continue;
    return tool;
  }

  return allowedSet.has('manual') ? 'manual' : '<agent-tool>';
}

export function defaultRoleProfiles() {
  return {
    implementer: {
      defaultProfile: 'fullstack',
      allowedProfiles: ['frontend', 'backend', 'fullstack', 'test', 'docs'],
    },
    reviewer: {
      defaultProfile: 'qa',
      allowedProfiles: ['qa', 'architecture', 'security'],
    },
    monitor: {
      defaultProfile: 'manual_monitor',
      allowedProfiles: ['manual_monitor', 'qa'],
    },
  };
}

export function defaultPromptTemplates() {
  return {
    devExecution: 'p2a.dev_prompt.v1',
    roleContract: 'p2a.role_contract.v1',
    providerGuide: 'p2a.provider_guide.v1',
  };
}

export function defaultCapabilityConfig(capability) {
  if (capability === 'memory') {
    return {
      enabled: true,
      mode: 'manual_sync',
      serverUrlEnv: 'P2A_MEMORY_URL',
      projectIdSource: 'manifest',
      syncTiers: ['trace', 'content', 'analytics', 'search'],
      statusPolicy: 'local_first',
      pushPolicy: 'explicit_approval',
    };
  }
  if (capability === 'gui') {
    return {
      enabled: true,
      metadataSource: '.plan2agent/manifest.json',
      stateSource: 'p2a_doctor_json',
      defaultView: 'overview',
      commandMode: 'guidance_only',
      projectConfigSource: '.plan2agent/project.config.json',
    };
  }
  if (capability === 'orchestration') {
    return {
      enabled: true,
      defaultMode: 'solo',
      supervisedRun: true,
      providerRouting: 'project_config',
      monitorGatePolicy: 'explicit_plan_only',
      runtimeDir: '.plan2agent/runs',
    };
  }
  if (capability === 'proposals') {
    return {
      enabled: true,
      queueDir: '.plan2agent/proposals',
      mineOn: ['failed_run', 'blocked_run', 'verification_gap'],
      reviewPolicy: 'manual_curate',
      patchPolicy: 'draft_only',
      approvalRequired: true,
    };
  }
  throw new Error(`unknown capability config: ${capability}`);
}

export function detectPackageManager(targetRoot) {
  if (existsSync(path.join(targetRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(targetRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(targetRoot, 'package-lock.json'))) return 'npm';
  if (existsSync(path.join(targetRoot, 'package.json'))) return 'npm';
  if (existsSync(path.join(targetRoot, 'gradlew')) || existsSync(path.join(targetRoot, 'build.gradle')) || existsSync(path.join(targetRoot, 'build.gradle.kts'))) return 'gradle';
  if (existsSync(path.join(targetRoot, 'pom.xml'))) return 'maven';
  return null;
}

function readJsonObject(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function detectProjectCommands(targetRoot) {
  const packageManager = detectPackageManager(targetRoot);
  let installCommand = null;
  let testCommand = null;
  let lintCommand = null;
  let typecheckCommand = null;

  if (packageManager === 'pnpm') installCommand = 'pnpm install';
  else if (packageManager === 'yarn') installCommand = 'yarn install';
  else if (packageManager === 'npm') installCommand = 'npm install';
  else if (packageManager === 'gradle') testCommand = existsSync(path.join(targetRoot, 'gradlew')) ? './gradlew test' : 'gradle test';
  else if (packageManager === 'maven') testCommand = 'mvn test';

  if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    const packageJson = readJsonObject(path.join(targetRoot, 'package.json'));
    const scripts = packageJson?.scripts ?? {};
    const runner = packageManager === 'npm' ? 'npm run' : packageManager;
    if (scripts.test) testCommand = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
    if (scripts.lint) lintCommand = `${runner} lint`;
    if (scripts.typecheck) typecheckCommand = `${runner} typecheck`;
  }

  return {
    packageManager,
    installCommand,
    testCommand,
    lintCommand,
    typecheckCommand,
    notes: packageManager
      ? ['Detected by Plan2Agent from project files; review commands before relying on them for release gates']
      : ['Commands pending; rerun verification after project scaffold files exist or pass an explicit command with --save-config'],
  };
}

export function buildProjectConfig(targetRoot, teamBigFiveConfig = { enabled: false }, options = {}) {
  const taskGraph = options.taskGraph ?? null;
  const detected = options.emptyCommands
    ? {
        packageManager: null,
        installCommand: null,
        testCommand: null,
        lintCommand: null,
        typecheckCommand: null,
        notes: ['Commands pending; rerun verification after project scaffold files exist or pass an explicit command with --save-config'],
      }
    : detectProjectCommands(targetRoot);
  return {
    schema_version: 'p2a.project_config.v1',
    packageManager: detected.packageManager,
    installCommand: detected.installCommand,
    testCommand: detected.testCommand,
    lintCommand: detected.lintCommand,
    typecheckCommand: detected.typecheckCommand,
    verificationTimeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
    taskGraph,
    runTracking: defaultRunTracking(),
    teamBigFive: teamBigFiveConfig,
    providerNativeCapabilities: defaultProviderNativeCapabilities(),
    devExecution: defaultDevExecution(),
    roleProfiles: defaultRoleProfiles(),
    promptTemplates: defaultPromptTemplates(),
    notes: detected.notes,
  };
}

export function commandKeyForVerificationType(type) {
  if (type === 'test') return 'testCommand';
  if (type === 'lint') return 'lintCommand';
  if (type === 'typecheck') return 'typecheckCommand';
  return null;
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

function addUniqueNote(config, note) {
  const notes = Array.isArray(config.notes) ? config.notes.filter((item) => typeof item === 'string') : [];
  if (!notes.includes(note)) notes.push(note);
  config.notes = notes;
}

function isMissingDefaultValue(value) {
  return isEmptyValue(value) || (Array.isArray(value) && value.length === 0);
}

function mergeObjectDefaults(target, defaults) {
  const next = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  const updatedKeys = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = mergeObjectDefaults(next[key], value);
      if (nested.updatedKeys.length) {
        next[key] = nested.value;
        updatedKeys.push(key);
      }
    } else if (isMissingDefaultValue(next[key])) {
      next[key] = value;
      updatedKeys.push(key);
    }
  }
  return { value: next, updatedKeys };
}

export function mergeDevSkillConfig(config) {
  const next = { ...config };
  const updatedKeys = [];
  const merges = [
    ['devExecution', defaultDevExecution()],
    ['roleProfiles', defaultRoleProfiles()],
    ['promptTemplates', defaultPromptTemplates()],
  ];
  for (const [key, defaults] of merges) {
    const merged = mergeObjectDefaults(next[key], defaults);
    if (merged.updatedKeys.length || isMissingDefaultValue(next[key])) {
      next[key] = merged.value;
      updatedKeys.push(key);
    }
  }
  if (updatedKeys.length) {
    if (!next.schema_version) next.schema_version = 'p2a.project_config.v1';
    if (!next.runTracking) next.runTracking = defaultRunTracking();
    if (!next.providerNativeCapabilities) next.providerNativeCapabilities = defaultProviderNativeCapabilities();
    addUniqueNote(next, 'Development skill execution defaults were installed by p2a enhance dev-skills');
  }
  return { config: next, updatedKeys };
}

export function mergeCapabilityConfig(config, capability) {
  const defaults = defaultCapabilityConfig(capability);
  const next = { ...config };
  const merged = mergeObjectDefaults(next[capability], defaults);
  const updatedKeys = [];
  if (merged.updatedKeys.length || isMissingDefaultValue(next[capability])) {
    next[capability] = merged.value;
    updatedKeys.push(capability);
  }
  if (updatedKeys.length) {
    if (!next.schema_version) next.schema_version = 'p2a.project_config.v1';
    if (!next.runTracking) next.runTracking = defaultRunTracking();
    if (!next.providerNativeCapabilities) next.providerNativeCapabilities = defaultProviderNativeCapabilities();
    addUniqueNote(next, `Capability defaults were installed by p2a enhance ${capability}`);
  }
  return { config: next, updatedKeys };
}

export function mergeDetectedProjectConfig(config, detected, options = {}) {
  const overwrite = options.overwrite === true;
  const next = { ...config };
  const updatedKeys = [];
  for (const key of ['packageManager', 'installCommand', 'testCommand', 'lintCommand', 'typecheckCommand']) {
    const value = detected?.[key] ?? null;
    if (isEmptyValue(value)) continue;
    if (overwrite || isEmptyValue(next[key])) {
      next[key] = value;
      updatedKeys.push(key);
    }
  }
  if (isEmptyValue(next.verificationTimeoutMs)) {
    next.verificationTimeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS;
    updatedKeys.push('verificationTimeoutMs');
  }
  if (updatedKeys.length) {
    if (!next.schema_version) next.schema_version = 'p2a.project_config.v1';
    if (!next.runTracking) next.runTracking = defaultRunTracking();
    if (!next.providerNativeCapabilities) next.providerNativeCapabilities = defaultProviderNativeCapabilities();
    addUniqueNote(next, 'Verification commands were detected from project files');
  }
  return { config: next, updatedKeys };
}

export function mergeExplicitVerificationCommands(config, verifyRequests, options = {}) {
  const overwrite = options.overwrite !== false;
  const next = { ...config };
  const updatedKeys = [];
  for (const request of verifyRequests) {
    if (request?.source !== 'command' || !request.command) continue;
    const key = commandKeyForVerificationType(request.type);
    if (!key) continue;
    if (overwrite || isEmptyValue(next[key])) {
      next[key] = request.command;
      updatedKeys.push(key);
    }
  }
  if (isEmptyValue(next.verificationTimeoutMs)) {
    next.verificationTimeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS;
    updatedKeys.push('verificationTimeoutMs');
  }
  if (updatedKeys.length) {
    if (!next.schema_version) next.schema_version = 'p2a.project_config.v1';
    if (!next.runTracking) next.runTracking = defaultRunTracking();
    if (!next.providerNativeCapabilities) next.providerNativeCapabilities = defaultProviderNativeCapabilities();
    addUniqueNote(next, 'Verification commands were saved from explicit CLI options');
  }
  return { config: next, updatedKeys };
}

export function writeProjectConfig(configPath, config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
