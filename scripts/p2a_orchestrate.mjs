#!/usr/bin/env node
/** Build supervised orchestration plans for one ready Plan2Agent task. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadJson, validateOrchestrationPlanData, validateOrchestrationRuntimeData, validateRunData, validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  nodeScriptCommand,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const ROOT = P2A_PATHS.projectRoot;
const COMMANDS = new Set(['plan', 'show', 'validate', 'handoff', 'runner-guide', 'runner-doctor', 'init-runtime', 'record', 'runtime-status', 'next-role', 'role-prompt', 'mark-role', 'failure-policy']);
const AGENT_TOOLS = new Set(['codex', 'claude', 'gemini', 'manual']);
const RUNNER_DOCTOR_PROVIDERS = new Set(['all', 'codex', 'claude', 'gemini']);
const PROVIDER_CAPABILITY_STATUSES = new Set(['available', 'unavailable', 'manual_check', 'unknown']);
const RUNNER_DOCTOR_COMMANDS = Object.freeze({
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
});
const RUNNER_DOCTOR_VERSION_ARGS = ['--version'];
const RUNTIME_EVENT_TYPES = new Set(['handoff', 'status', 'question', 'answer', 'ack', 'concern', 'decision', 'blocker', 'verification', 'monitor_verdict', 'owner_note']);
const RUNTIME_ROLE_STATUSES = new Set(['pending', 'active', 'blocked', 'complete', 'skipped']);
const RUNTIME_PHASES = new Set(['initialized', 'running', 'blocked', 'ready_for_monitor', 'ready_to_finish', 'closed']);
const RUNTIME_FAILURE_RETRYABLE = new Set(['yes', 'no', 'after_fix']);
const RUNTIME_FAILURE_SOURCES = new Set(['run_failure', 'monitor_verdict', 'open_question', 'blocked_runtime', 'closed_runtime', 'none']);
const DEFAULT_ACCEPTED_MONITOR_VERDICTS = ['confirm_done'];
const HIGH_ACCEPTANCE_MONITOR_THRESHOLD = 6;
const ROLE_PROFILE_SOURCES = new Set(['auto', 'override']);
const ROLE_PROFILE_TO_ROLE = Object.freeze({
  owner_supervisor: 'lead',
  frontend_implementer: 'contributor',
  backend_implementer: 'contributor',
  fullstack_implementer: 'contributor',
  test_implementer: 'contributor',
  docs_implementer: 'contributor',
  qa_reviewer: 'reviewer',
  architecture_reviewer: 'reviewer',
  security_reviewer: 'reviewer',
  manual_monitor: 'monitor',
});
const IMPLEMENTER_PROFILES = new Set(Object.entries(ROLE_PROFILE_TO_ROLE)
  .filter(([, role]) => role === 'contributor')
  .map(([profile]) => profile));
const REVIEWER_PROFILES = new Set(Object.entries(ROLE_PROFILE_TO_ROLE)
  .filter(([, role]) => role === 'reviewer')
  .map(([profile]) => profile));
const ROLE_PROFILE_GUIDANCE = Object.freeze({
  owner_supervisor: [
    'Profile: owner_supervisor.',
    'Coordinate approvals, user decisions, run lifecycle commands, and final done/block state.',
    'Do not implement code in this role unless explicitly taking over a manual implementation role.',
  ],
  frontend_implementer: [
    'Profile: frontend_implementer.',
    'Focus on UI state, interaction flow, responsive constraints, accessibility, empty/loading/error states, and user-facing copy.',
    'Verify visual behavior with the project’s available frontend checks or a clearly documented manual check.',
  ],
  backend_implementer: [
    'Profile: backend_implementer.',
    'Focus on API/CLI contracts, validation, persistence, error handling, idempotency, and regression tests.',
    'Keep interfaces stable unless the task explicitly approves a contract change.',
  ],
  fullstack_implementer: [
    'Profile: fullstack_implementer.',
    'Coordinate UI, API/CLI, data shape, and verification changes as one scoped implementation.',
    'Call out any split that should become separate frontend/backend follow-up tasks.',
  ],
  test_implementer: [
    'Profile: test_implementer.',
    'Focus on regression coverage, fixture quality, deterministic commands, and meaningful failure messages.',
    'Avoid broad refactors unless needed to make the tests reliable.',
  ],
  docs_implementer: [
    'Profile: docs_implementer.',
    'Focus on accurate user-facing documentation, concise examples, CLI options, and stale-plan cleanup.',
    'Keep docs aligned with implemented behavior and avoid speculative promises.',
  ],
  qa_reviewer: [
    'Profile: qa_reviewer.',
    'Review acceptance criteria coverage, verification evidence, failure handling, and regression risk.',
    'Report concrete blockers or confirm readiness with a small verdict.',
  ],
  architecture_reviewer: [
    'Profile: architecture_reviewer.',
    'Review ownership boundaries, contracts, migration risk, coupling, and future extension points.',
    'Prefer targeted follow-up recommendations over broad redesign.',
  ],
  security_reviewer: [
    'Profile: security_reviewer.',
    'Review permissions, path confinement, secret exposure, shell/process boundaries, and unsafe automation risk.',
    'Flag security blockers separately from ordinary implementation concerns.',
  ],
  manual_monitor: [
    'Profile: manual_monitor.',
    'Check the run output, changed files, verification results, and acceptance criteria before allowing finish.',
    'Record an explicit verdict; only confirm_done should move the runtime toward finish.',
  ],
});
const PROVIDER_CAPABILITIES = Object.freeze({
  codex: {
    provider: 'codex',
    roles: ['contributor', 'reviewer', 'monitor'],
    writeAllowed: true,
    executionSurface: 'Codex CLI/app foreground session with skills, custom agents, and explicitly requested subagents.',
    officialFeatures: ['skills', 'custom_agents', 'explicit_subagent_prompt'],
    supervisionMode: 'foreground_human_supervised',
    restrictions: [
      'P2A does not spawn Codex subagents; the foreground Codex session may use skills, custom agents, or subagents when the pasted prompt requests them.',
      'P2A never starts Codex as a background process.',
    ],
  },
  claude: {
    provider: 'claude',
    roles: ['contributor', 'reviewer', 'monitor'],
    writeAllowed: true,
    executionSurface: 'Claude Code foreground session with subagents, plugins, skills, and agent teams when enabled.',
    officialFeatures: ['subagents', 'plugins', 'skills', 'agent_teams'],
    supervisionMode: 'foreground_human_supervised',
    restrictions: [
      'P2A does not start Claude Code agent teams; the foreground Claude Code session may use native agent teams/subagents when enabled.',
      'P2A never starts Claude Code as a background process.',
    ],
  },
  gemini: {
    provider: 'gemini',
    roles: ['reviewer', 'monitor'],
    writeAllowed: false,
    executionSurface: 'Gemini CLI foreground session with extensions, custom commands, GEMINI.md context, and MCP tools.',
    officialFeatures: ['extensions', 'custom_commands', 'GEMINI.md', 'mcp_tools'],
    supervisionMode: 'foreground_human_supervised',
    restrictions: [
      'Gemini is read-only in P2A orchestration until an official write-safe team/subagent runner is verified.',
      'Use Gemini for planning, review, or monitor support, not write-required implementation.',
    ],
  },
  manual: {
    provider: 'manual',
    roles: ['lead', 'contributor', 'reviewer', 'monitor'],
    writeAllowed: true,
    executionSurface: 'Human owner action in the foreground workspace.',
    officialFeatures: ['manual_approval', 'manual_prompt_copy', 'manual_status_recording'],
    supervisionMode: 'foreground_human_supervised',
    restrictions: [
      'Manual roles require the owner to perform or record the work directly.',
    ],
  },
});
const COMMON_PROHIBITED_AUTOMATION = Object.freeze([
  'Do not let P2A spawn the provider CLI/app or run hidden background loops.',
  'Do not use browser automation, unofficial APIs, token reuse, account rotation, or rate-limit bypass.',
  'Do not edit Plan2Agent task graph, run log, or runtime files by hand.',
]);

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs plan (--artifacts <dir>|--graph <path>) [--task <task-id>] [--output <path>] [options]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs show --plan <path>',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs validate --plan <path>',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs handoff --plan <path>',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs runner-guide (--plan <path>|--runtime <path>) [--role <role-id>] [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs runner-doctor [--root <dir>] [--provider all|codex|claude|gemini] [--live] [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs init-runtime --plan <path> --run-id <run-id> [--output <path>] [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs record --runtime <path> --role <role-id> --type <type> --summary <text> [options]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs runtime-status --runtime <path> [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs next-role --runtime <path> [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs role-prompt --runtime <path> --role <role-id> [--json]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs mark-role --runtime <path> --role <role-id> --role-status <status> [options]',
    '  node .plan2agent/scripts/p2a_orchestrate.mjs failure-policy --runtime <path> [--json]',
    '',
    'Commands:',
    '  plan                 Create a deterministic supervised orchestration plan. No task/run files are changed.',
    '  show                 Print a compact plan summary.',
    '  validate             Validate an orchestration plan JSON file.',
    '  handoff              Print the owner start command and role prompts for the plan.',
    '  runner-guide         Print provider-native supervised runner steps. Does not start any agent or CLI process.',
    '  runner-doctor        Check provider-native P2A assets and optional CLI version probes under a project root.',
    '  init-runtime         Create the run-level shared mental model and communication log sidecar.',
    '  record               Append one runtime communication event.',
    '  runtime-status       Print the runtime phase, role status, and latest communication event.',
    '  next-role            Compute the next supervised role. Does not start any agent or CLI process.',
    '  role-prompt          Print the prompt for a role so a human can paste it into an official CLI/app.',
    '  mark-role            Record a human-observed role state transition.',
    '  failure-policy       Decide retry, ask-user, or stop for a blocked/failed supervised runtime.',
    '',
    'Source options:',
    '  --artifacts <dir>    Iterative artifact root; uses the active iteration task graph.',
    '  --graph <path>       Task graph JSON path.',
    '  --spec <path>        Spec JSON path for prompt context. Only supported with --graph.',
    '  --maintenance        With --artifacts, use the maintenance task graph.',
    '',
    'Plan options:',
    '  --task <task-id>         Task to plan. If omitted, there must be exactly one ready task.',
    '  --agent-tool <tool>      Implementer tool label: codex, claude, or manual. Default: codex.',
    '  --reviewer-tool <tool>   Read-only reviewer tool label: codex, claude, gemini, or manual. Default: same as --agent-tool.',
    '  --implementer-profile <profile> Override implementer specialization profile.',
    '  --reviewer-profile <profile>    Override reviewer specialization profile.',
    '  --output <path>          Write plan JSON to a file. Without this, JSON is printed to stdout.',
    '  --json                   With --output, also print the JSON payload.',
    '  --root <dir>             Project root for runner-doctor. Default: current directory.',
    '  --provider <provider>    runner-doctor provider filter: all, codex, claude, or gemini.',
    '  --live                   runner-doctor also runs provider --version probes. No agent session is opened.',
    '',
    'Runtime options:',
    '  --run-id <run-id>         Run id for init-runtime.',
    '  --runtime <path>          Runtime sidecar path for record/status.',
    '  --role <role-id>          Role assignment that writes the record event.',
    `  --type <type>             Event type: ${[...RUNTIME_EVENT_TYPES].join(', ')}.`,
    '  --summary <text>          Event summary.',
    '  --detail <text>           Optional event detail.',
    '  --verdict <value>         Required when mark-role completes the monitor role.',
    '  --linked-role <role-id>   Optional related role assignment.',
    `  --role-status <status>    Update the event role status: ${[...RUNTIME_ROLE_STATUSES].join(', ')}.`,
    `  --phase <phase>           Update runtime phase: ${[...RUNTIME_PHASES].join(', ')}.`,
    '  --requires-owner-action  Mark the event as requiring owner action.',
    '  Scheduler commands never spawn Codex, Claude, Gemini, browsers, or background agent loops.',
    '',
    '  --help, -h          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  const providedOptions = new Set();

  const args = {
    command,
    artifacts: null,
    graph: null,
    spec: null,
    maintenance: false,
    taskId: null,
    agentTool: 'codex',
    reviewerTool: null,
    implementerProfile: null,
    reviewerProfile: null,
    root: '.',
    provider: 'all',
    live: false,
    output: null,
    plan: null,
    runtime: null,
    runId: null,
    roleId: null,
    eventType: null,
    summary: null,
    detail: null,
    verdict: null,
    linkedRoleId: null,
    roleStatus: null,
    phase: null,
    requiresOwnerAction: false,
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--spec') args.spec = requiredValue(argv, ++index, '--spec');
    else if (arg === '--maintenance') args.maintenance = true;
    else if (arg === '--task') args.taskId = requiredValue(argv, ++index, '--task');
    else if (arg === '--agent-tool') {
      providedOptions.add('--agent-tool');
      args.agentTool = parseAgentTool(requiredValue(argv, ++index, '--agent-tool'), '--agent-tool');
    } else if (arg === '--reviewer-tool') {
      providedOptions.add('--reviewer-tool');
      args.reviewerTool = parseAgentTool(requiredValue(argv, ++index, '--reviewer-tool'), '--reviewer-tool');
    } else if (arg === '--implementer-profile') {
      providedOptions.add('--implementer-profile');
      args.implementerProfile = parseRoleProfile(requiredValue(argv, ++index, '--implementer-profile'), IMPLEMENTER_PROFILES, '--implementer-profile');
    } else if (arg === '--reviewer-profile') {
      providedOptions.add('--reviewer-profile');
      args.reviewerProfile = parseRoleProfile(requiredValue(argv, ++index, '--reviewer-profile'), REVIEWER_PROFILES, '--reviewer-profile');
    } else if (arg === '--root') {
      providedOptions.add('--root');
      args.root = requiredValue(argv, ++index, '--root');
    } else if (arg === '--provider') {
      providedOptions.add('--provider');
      args.provider = parseRunnerDoctorProvider(requiredValue(argv, ++index, '--provider'));
    } else if (arg === '--live') args.live = true;
    else if (arg === '--output') args.output = requiredValue(argv, ++index, '--output');
    else if (arg === '--plan') args.plan = requiredValue(argv, ++index, '--plan');
    else if (arg === '--runtime') args.runtime = requiredValue(argv, ++index, '--runtime');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--role') args.roleId = requiredValue(argv, ++index, '--role');
    else if (arg === '--type') args.eventType = parseEnumValue(requiredValue(argv, ++index, '--type'), RUNTIME_EVENT_TYPES, '--type');
    else if (arg === '--summary') args.summary = requiredValue(argv, ++index, '--summary');
    else if (arg === '--detail') args.detail = requiredValue(argv, ++index, '--detail');
    else if (arg === '--verdict') args.verdict = requiredValue(argv, ++index, '--verdict').trim();
    else if (arg === '--linked-role') args.linkedRoleId = requiredValue(argv, ++index, '--linked-role');
    else if (arg === '--role-status') args.roleStatus = parseEnumValue(requiredValue(argv, ++index, '--role-status'), RUNTIME_ROLE_STATUSES, '--role-status');
    else if (arg === '--phase') args.phase = parseEnumValue(requiredValue(argv, ++index, '--phase'), RUNTIME_PHASES, '--phase');
    else if (arg === '--requires-owner-action') args.requiresOwnerAction = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  if (args.command !== 'plan') rejectPlanOnlyOptions(args.command, providedOptions);
  if (args.command === 'plan') {
    const sourceCount = [args.artifacts, args.graph].filter(Boolean).length;
    if (sourceCount > 1) throw new Error('--artifacts and --graph cannot be used together');
    if (sourceCount === 0) {
      const defaultArtifacts = singleArtifactProjectRoot();
      const configuredGraph = configuredTaskGraphPath();
      if (defaultArtifacts) args.artifacts = defaultArtifacts;
      else if (configuredGraph) args.graph = configuredGraph;
      else assertNoUninitializedScaffoldArtifactRoots();
      if (!args.artifacts && !args.graph) {
        throw new Error('--artifacts or --graph is required');
      }
    }
    if (args.spec && args.artifacts) throw new Error('--spec is only supported with --graph; --artifacts uses the active iteration spec');
    if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
    if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
    if (args.plan || args.runtime || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('runtime/show options are not supported with plan');
    }
  } else if (['show', 'validate', 'handoff'].includes(args.command)) {
    if (!args.plan) throw new Error(`--plan is required for ${args.command}`);
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.runtime || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error(`${args.command} only supports --plan and --json`);
    }
  } else if (args.command === 'runner-guide') {
    const sourceCount = [args.plan, args.runtime].filter(Boolean).length;
    if (sourceCount !== 1) throw new Error('runner-guide requires exactly one of --plan or --runtime');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.live || hasRunnerDoctorOptions(providedOptions) || args.runId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('runner-guide only supports --plan or --runtime, optional --role, and --json');
    }
  } else if (args.command === 'runner-doctor') {
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runtime || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('runner-doctor only supports --root, --provider, --live, and --json');
    }
  } else if (args.command === 'init-runtime') {
    if (!args.plan) throw new Error('--plan is required for init-runtime');
    if (!args.runId) throw new Error('--run-id is required for init-runtime');
    assertSafeRunId(args.runId);
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.runtime || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('init-runtime only supports --plan, --run-id, --output, and --json');
    }
  } else if (args.command === 'record') {
    if (!args.runtime) throw new Error('--runtime is required for record');
    if (!args.roleId) throw new Error('--role is required for record');
    if (!args.eventType) throw new Error('--type is required for record');
    if (!args.summary) throw new Error('--summary is required for record');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.verdict || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('record only supports --runtime, --role, --type, --summary, --detail, --linked-role, --role-status, --phase, --requires-owner-action, and --json');
    }
  } else if (args.command === 'runtime-status') {
    if (!args.runtime) throw new Error('--runtime is required for runtime-status');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('runtime-status only supports --runtime and --json');
    }
  } else if (args.command === 'next-role') {
    if (!args.runtime) throw new Error('--runtime is required for next-role');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('next-role only supports --runtime and --json');
    }
  } else if (args.command === 'failure-policy') {
    if (!args.runtime) throw new Error('--runtime is required for failure-policy');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('failure-policy only supports --runtime and --json');
    }
  } else if (args.command === 'role-prompt') {
    if (!args.runtime) throw new Error('--runtime is required for role-prompt');
    if (!args.roleId) throw new Error('--role is required for role-prompt');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.eventType || args.summary || args.detail || args.verdict || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('role-prompt only supports --runtime, --role, and --json');
    }
  } else if (args.command === 'mark-role') {
    if (!args.runtime) throw new Error('--runtime is required for mark-role');
    if (!args.roleId) throw new Error('--role is required for mark-role');
    if (!args.roleStatus) throw new Error('--role-status is required for mark-role');
    if (args.verdict !== null && !args.verdict) throw new Error('--verdict requires a non-empty value');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.implementerProfile || args.reviewerProfile || args.output || args.plan || args.runId || args.eventType || args.linkedRoleId || args.live || hasRunnerDoctorOptions(providedOptions)) {
      throw new Error('mark-role only supports --runtime, --role, --role-status, --summary, --detail, --verdict, --phase, --requires-owner-action, and --json');
    }
  }
  return args;
}

function hasRunnerDoctorOptions(providedOptions) {
  return providedOptions.has('--root') || providedOptions.has('--provider');
}

function rejectPlanOnlyOptions(command, providedOptions) {
  const invalidOptions = ['--agent-tool', '--reviewer-tool', '--implementer-profile', '--reviewer-profile']
    .filter((option) => providedOptions.has(option));
  if (invalidOptions.length) {
    throw new Error(`${invalidOptions.join(', ')} ${invalidOptions.length === 1 ? 'is' : 'are'} only supported with plan; ${command} reads provider/profile assignments from the existing plan or runtime`);
  }
}

function parseAgentTool(value, optionName) {
  if (!AGENT_TOOLS.has(value)) throw new Error(`${optionName} must be one of ${[...AGENT_TOOLS].join(', ')}`);
  return value;
}

function parseRunnerDoctorProvider(value) {
  if (!RUNNER_DOCTOR_PROVIDERS.has(value)) throw new Error(`--provider must be one of ${[...RUNNER_DOCTOR_PROVIDERS].join(', ')}`);
  return value;
}

function parseRoleProfile(value, allowedProfiles, optionName) {
  if (!allowedProfiles.has(value)) throw new Error(`${optionName} must be one of ${[...allowedProfiles].join(', ')}`);
  return value;
}

function providerCapabilityList() {
  return Object.values(PROVIDER_CAPABILITIES).map((capability) => ({
    ...capability,
    roles: [...capability.roles],
    officialFeatures: [...capability.officialFeatures],
    restrictions: [...capability.restrictions],
  }));
}

function assertProviderRoleCapability(role) {
  const capability = PROVIDER_CAPABILITIES[role.agentTool];
  if (!capability) throw new Error(`unknown provider: ${role.agentTool}`);
  if (!capability.roles.includes(role.role)) {
    throw new Error(`${role.agentTool} cannot serve ${role.role} in provider-native orchestration`);
  }
  if (ROLE_PROFILE_TO_ROLE[role.profile] !== role.role) {
    throw new Error(`${role.profile} cannot serve ${role.role} in role-profile orchestration`);
  }
  if (!ROLE_PROFILE_SOURCES.has(role.profileSource)) {
    throw new Error(`${role.roleId} uses unsupported role profile source: ${role.profileSource}`);
  }
  if (role.profileSource === 'override' && !['implementer', 'reviewer'].includes(role.roleId)) {
    throw new Error(`${role.roleId} cannot use override role profile source`);
  }
  if (!role.executionGuide || role.executionGuide.startsProcess !== false || role.executionGuide.supervisionRequired !== true) {
    throw new Error(`${role.roleId} must use a supervised execution guide that starts no process`);
  }
  if (role.requiresWrite && !capability.writeAllowed) {
    throw new Error(`${role.agentTool} is read-only in P2A orchestration; use --agent-tool codex, claude, or manual for implementation and --reviewer-tool gemini for read-only review`);
  }
}

function assertReviewerToolCompatible(agentTool, reviewerTool) {
  if (!reviewerTool || reviewerTool === agentTool || reviewerTool === 'manual') return;
  const reviewerCapability = PROVIDER_CAPABILITIES[reviewerTool];
  if (!reviewerCapability) throw new Error(`unknown reviewer provider: ${reviewerTool}`);
  if (reviewerCapability.writeAllowed) {
    throw new Error(`--reviewer-tool ${reviewerTool} is write-capable; cross-provider reviewers must be read-only. Omit --reviewer-tool for single-provider review, or use --reviewer-tool gemini for read-only review`);
  }
}

function providerStrategyForRoles(roles) {
  roles.forEach(assertProviderRoleCapability);
  const implementer = roles.find((role) => role.roleId === 'implementer');
  const reviewer = roles.find((role) => role.roleId === 'reviewer');
  const implementationProvider = implementer?.agentTool ?? 'manual';
  const reviewProvider = reviewer?.agentTool ?? null;
  const hasDifferentProviderReviewer = reviewProvider && reviewProvider !== implementationProvider && reviewProvider !== 'manual';
  const mode = implementationProvider === 'manual'
    ? 'manual'
    : hasDifferentProviderReviewer
      ? 'single_provider_with_read_only_reviewer'
      : 'single_provider';
  const notes = [
    'P2A coordinates role order, prompts, runtime state, and monitor gates only.',
    'A human owner opens the official provider CLI/app in the foreground and records observed progress.',
    'Provider-native skills, subagents, custom agents, or agent teams may run inside that foreground session when requested by the pasted prompt.',
    'P2A does not run background loops, browser automation, unofficial APIs, token reuse, account rotation, or rate-limit bypass.',
  ];
  if (implementationProvider === 'codex') {
    notes.push('Codex team execution uses skills, custom agents, and explicit subagent prompts; subagents must be requested in the prompt.');
  } else if (implementationProvider === 'claude') {
    notes.push('Claude team execution uses native agent teams/subagents when available and falls back to supervised role prompts when disabled.');
  } else if (implementationProvider === 'manual') {
    notes.push('Manual implementation means the owner performs the write-required role directly.');
  }
  if (reviewProvider === 'gemini') {
    notes.push('Gemini is assigned only to read-only review or monitor support.');
  }
  if (mode === 'single_provider_with_read_only_reviewer') {
    notes.push('Mixed-provider implementation remains disabled; the non-primary provider is read-only.');
  }
  return {
    mode,
    primaryProvider: implementationProvider,
    implementationProvider,
    reviewProvider,
    monitorProvider: 'manual',
    mixedProviderImplementation: false,
    notes,
  };
}

function providerExecutionGuide(agentTool, role, profile) {
  if (agentTool === 'codex') {
    const recommendedFeature = role === 'contributor'
      ? 'skills_custom_agents_explicit_subagent_prompt'
      : 'read_only_review_skill_or_custom_agent_prompt';
    return {
      surface: 'Codex CLI/app foreground session',
      recommendedFeature,
      fallbackMode: 'single supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        'Open Codex manually in the foreground workspace.',
        'Inside the foreground Codex session, use skills or custom agents when they are available for this profile.',
        'Explicitly request subagents in the pasted prompt if role separation is needed.',
        role === 'contributor' ? 'Write only within the approved task scope.' : 'Review read-only unless the owner explicitly reassigns implementation.',
      ],
    };
  }
  if (agentTool === 'claude') {
    const recommendedFeature = role === 'contributor'
      ? 'agent_teams_or_subagents'
      : 'read_only_review_subagent';
    return {
      surface: 'Claude Code foreground session',
      recommendedFeature,
      fallbackMode: 'supervised foreground role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        'Open Claude Code manually in the foreground workspace.',
        'Inside the foreground Claude Code session, use native agent teams or subagents when enabled for this account and project.',
        'Fall back to the pasted role prompt when agent teams are unavailable.',
        role === 'contributor' ? 'Write only within the approved task scope.' : 'Review read-only unless the owner explicitly reassigns implementation.',
      ],
    };
  }
  if (agentTool === 'gemini') {
    return {
      surface: 'Gemini CLI foreground session',
      recommendedFeature: 'extensions_custom_commands_gemini_context',
      fallbackMode: 'read-only supervised role prompt',
      supervisionRequired: true,
      startsProcess: false,
      constraints: [
        'Open Gemini CLI manually in the foreground workspace.',
        'Use extensions, custom commands, and GEMINI.md context for planning, review, or monitor support.',
        'Do not edit files or perform write-required implementation in this role.',
        'Return findings for the owner to record in P2A.',
      ],
    };
  }
  return {
    surface: 'Human owner foreground action',
    recommendedFeature: role === 'lead' ? 'manual_approval_and_run_lifecycle' : 'manual_prompt_copy_and_status_recording',
    fallbackMode: 'manual status update',
    supervisionRequired: true,
    startsProcess: false,
    constraints: [
      'Perform the role directly in the foreground workspace.',
      'Record observed state with p2a_orchestrate record or mark-role.',
      'Do not bypass monitor gates or edit run logs by hand.',
      profile === 'manual_monitor' ? 'Record an explicit monitor verdict before finish.' : 'Keep changes inside the approved task scope.',
    ],
  };
}

function providerPromptPrefix(role) {
  const guide = role.executionGuide;
  return [
    `Provider surface: ${guide.surface}.`,
    `Recommended feature: ${guide.recommendedFeature}.`,
    `Fallback mode: ${guide.fallbackMode}.`,
    `P2A starts process: ${guide.startsProcess}.`,
    `Supervision required: ${guide.supervisionRequired}.`,
    'Provider constraints:',
    ...guide.constraints.map((constraint) => `- ${constraint}`),
  ];
}

function taskProfileText(task) {
  return [
    task.title,
    task.description,
    task.targetArea,
    task.suggestedAgentPrompt,
    ...(task.acceptanceCriteria ?? []),
  ].filter(Boolean).join('\n').toLowerCase();
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function roleProfileSelection(profile, reason, source = 'auto') {
  if (!ROLE_PROFILE_SOURCES.has(source)) throw new Error(`unknown role profile source: ${source}`);
  return {
    profile,
    profileSource: source,
    profileReason: reason,
  };
}

function overrideRoleProfile(selection, overrideProfile, optionName) {
  if (!overrideProfile) return selection;
  return roleProfileSelection(overrideProfile, `${optionName} explicitly set to ${overrideProfile}`, 'override');
}

function selectImplementerProfile(task) {
  const text = taskProfileText(task);
  const targetArea = String(task.targetArea ?? '').toLowerCase();
  const targetFrontend = includesAny(targetArea, [/\bui\b/, /\bgui\b/, /\bfrontend\b/, /\bscreen\b/, /\bview\b/]);
  const targetBackend = includesAny(targetArea, [/\bapi\b/, /\bbackend\b/, /\bserver\b/, /\bservice\b/, /\bdb\b/, /\bdatabase\b/, /\bcli\b/, /\bschema\b/]);
  const targetTest = includesAny(targetArea, [/\btest\b/, /\bqa\b/, /\bverification\b/]);
  const targetDocs = includesAny(targetArea, [/\bdocs?\b/, /\breadme\b/, /\bplans?\b/]);
  if (targetFrontend && targetBackend) return roleProfileSelection('fullstack_implementer', `targetArea "${task.targetArea}" matched frontend and backend signals`);
  if (targetTest) return roleProfileSelection('test_implementer', `targetArea "${task.targetArea}" matched test/QA signals`);
  if (targetDocs) return roleProfileSelection('docs_implementer', `targetArea "${task.targetArea}" matched docs/plans signals`);
  if (targetFrontend) return roleProfileSelection('frontend_implementer', `targetArea "${task.targetArea}" matched UI/frontend signals`);
  if (targetBackend) return roleProfileSelection('backend_implementer', `targetArea "${task.targetArea}" matched API/backend/CLI signals`);
  const frontend = includesAny(text, [/\bui\b/, /\bgui\b/, /\bfrontend\b/, /\bscreen\b/, /\bview\b/, /\bcomponent\b/, /\breact\b/, /\brenderer\b/, /\bcss\b/, /\bux\b/, /\baccessib/, /\bresponsive\b/]);
  const backend = includesAny(text, [/\bapi\b/, /\bbackend\b/, /\bserver\b/, /\bservice\b/, /\bdb\b/, /\bdatabase\b/, /\bpersist/, /\bschema\b/, /\bcli\b/, /\bscript\b/, /\bvalidator\b/, /\bruntime\b/, /\borchestrat/]);
  if (frontend && backend) return roleProfileSelection('fullstack_implementer', 'task text matched both frontend and backend signals');
  if (includesAny(text, [/\bfixture\b/, /\bregression\b/, /\bvitest\b/, /\bunit test\b/, /\be2e\b/])) {
    return roleProfileSelection('test_implementer', 'task text matched test/fixture signals');
  }
  if (includesAny(text, [/\bdocumentation\b/, /\bmarkdown\b/, /\bcopy\b/, /\bcli reference\b/, /\b개발계획\b/])) {
    return roleProfileSelection('docs_implementer', 'task text matched documentation signals');
  }
  if (frontend) return roleProfileSelection('frontend_implementer', 'task text matched UI/frontend signals');
  if (backend) return roleProfileSelection('backend_implementer', 'task text matched API/backend/CLI signals');
  return roleProfileSelection('fullstack_implementer', 'fallback for implementation task without narrower specialization signal');
}

function selectReviewerProfile(task, reviewerTool) {
  const text = taskProfileText(task);
  if (includesAny(text, [/\bsecurity\b/, /\bsecret\b/, /\btoken\b/, /\bpermission\b/, /\bsandbox\b/, /\bpath traversal\b/, /\bconfinement\b/, /\bshell\b/, /\bspawn\b/, /\bipc\b/])) {
    return roleProfileSelection('security_reviewer', 'task text matched security/process-boundary signals');
  }
  if (includesAny(text, [/\barchitecture\b/, /\bdesign\b/, /\bboundary\b/, /\bcontract\b/, /\bmigration\b/, /\bdependency\b/, /\bschema\b/, /\bprovider\b/, /\borchestrat/])) {
    return roleProfileSelection('architecture_reviewer', 'task text matched architecture/contract signals');
  }
  if (reviewerTool === 'gemini') return roleProfileSelection('qa_reviewer', 'Gemini reviewer defaults to read-only QA coverage');
  return roleProfileSelection('qa_reviewer', 'default reviewer specialization for acceptance and verification coverage');
}

function profileGuidance(profile) {
  return ROLE_PROFILE_GUIDANCE[profile] ?? [`Profile: ${profile}.`];
}

function providerAwarePrompt(role, basePrompt) {
  return [
    ...providerPromptPrefix(role),
    '',
    ...profileGuidance(role.profile),
    '',
    basePrompt,
  ].join('\n');
}

function parseEnumValue(value, allowedValues, optionName) {
  if (!allowedValues.has(value)) throw new Error(`${optionName} must be one of ${[...allowedValues].join(', ')}`);
  return value;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${label} must be a file: ${filePath}`);
}

function assertSafeRunId(runId) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`run id must start with run- and contain only letters, digits, dot, underscore, or hyphen: ${runId}`);
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function displayPath(filePath, root = process.cwd()) {
  if (!filePath) return null;
  const relative = path.relative(root, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative);
  return normalizePath(filePath);
}

function artifactRelativePath(artifactRoot, filePath) {
  return normalizePath(path.relative(artifactRoot, filePath));
}

function resolveSource(args) {
  if (args.artifacts) {
    const state = resolveIterationState(args.artifacts, { requireReady: !args.maintenance });
    if (args.maintenance) {
      const graphPath = path.join(state.artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      assertFile(graphPath, 'maintenance task graph');
      const graph = loadJson(graphPath);
      validateTaskGraphData(graph);
      return {
        projectId: state.projectId,
        sourceArgs: ['--artifacts', args.artifacts, '--maintenance'],
        sourceLayout: 'maintenance',
        graphPath,
        specPath: state.currentSpecPath,
        graph,
        taskGraphRef: artifactRelativePath(state.artifactRoot, graphPath),
        sourceSpecRef: state.currentSpecPath ? artifactRelativePath(state.artifactRoot, state.currentSpecPath) : null,
      };
    }
    const graph = loadJson(state.taskGraphPath);
    validateTaskGraphData(graph);
    return {
      projectId: state.projectId,
      sourceArgs: ['--artifacts', args.artifacts],
      sourceLayout: 'iteration',
      graphPath: state.taskGraphPath,
      specPath: state.specPath,
      graph,
      taskGraphRef: artifactRelativePath(state.artifactRoot, state.taskGraphPath),
      sourceSpecRef: artifactRelativePath(state.artifactRoot, state.specPath),
    };
  }

  const graphPath = path.resolve(args.graph);
  assertFile(graphPath, 'task graph');
  const graph = loadJson(graphPath);
  validateTaskGraphData(graph);
  return {
    projectId: graph.projectId,
    sourceArgs: ['--graph', args.graph, ...(args.spec ? ['--spec', args.spec] : [])],
    sourceLayout: 'graph',
    graphPath,
    specPath: args.spec ? path.resolve(args.spec) : null,
    graph,
    taskGraphRef: displayPath(graphPath),
    sourceSpecRef: args.spec ? displayPath(path.resolve(args.spec)) : graph.sourceSpec ?? null,
  };
}

function taskMap(graph) {
  return new Map(graph.tasks.map((task) => [task.id, task]));
}

function isReady(task, tasksById) {
  return task.status === 'todo' && task.dependencies.every((dependency) => tasksById.get(dependency)?.status === 'done');
}

function readyTasks(graph) {
  const tasksById = taskMap(graph);
  return graph.tasks.filter((task) => isReady(task, tasksById));
}

function selectReadyTask(source, taskId = null) {
  const tasksById = taskMap(source.graph);
  if (taskId) {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`unknown task id: ${taskId}`);
    if (!isReady(task, tasksById)) {
      const incomplete = task.dependencies.filter((dependency) => tasksById.get(dependency)?.status !== 'done');
      const suffix = incomplete.length ? `; incomplete dependencies: ${incomplete.join(', ')}` : '';
      throw new Error(`${task.id} is not ready; status is ${task.status}${suffix}`);
    }
    return task;
  }
  const ready = readyTasks(source.graph);
  if (ready.length === 0) throw new Error('no ready task found');
  if (ready.length > 1) {
    const summary = ready.map((task) => `${task.id} (${task.title})`).join(', ');
    throw new Error(`multiple ready tasks found; pass --task. Ready tasks: ${summary}`);
  }
  return ready[0];
}

function buildRiskFlags(task) {
  const flags = [];
  const targetArea = String(task.targetArea ?? '');
  if (hasExplicitMultiArea(targetArea)) flags.push('multi_area');
  if (task.acceptanceCriteria.length >= HIGH_ACCEPTANCE_MONITOR_THRESHOLD) flags.push('high_acceptance_count');
  if (task.dependencies.length >= 2) flags.push('dependency_heavy');
  if (flags.includes('multi_area') || flags.includes('high_acceptance_count')) flags.push('monitor_required');
  if (flags.includes('multi_area')) flags.push('reviewer_recommended', 'read_only_reviewer');
  return [...new Set(flags)];
}

function hasExplicitMultiArea(targetArea) {
  return /[,+&]/.test(targetArea) || /\band\b/i.test(targetArea);
}

function modeForRiskFlags(flags) {
  if (flags.includes('reviewer_recommended')) return 'team';
  if (flags.includes('monitor_required')) return 'solo_monitor';
  return 'solo';
}

function generatedPlanId(taskId, now) {
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
  return `orch-${timestamp}-${taskId}`;
}

function generatedRuntimeId(runId) {
  assertSafeRunId(runId);
  return `runtime-${runId}`;
}

function generatedRuntimeSlug(now) {
  return now.toISOString().replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
}

function sanitizeRuntimeToken(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-|-$/g, '') || 'event';
}

function generatedEventId(now, label, index = 0) {
  const suffix = index > 0 ? `-${index}` : '';
  return `event-${generatedRuntimeSlug(now)}-${sanitizeRuntimeToken(label)}${suffix}`;
}

function nextEventId(runtime, now, type) {
  const existing = new Set(runtime.communicationLog.map((event) => event.eventId));
  let index = runtime.communicationLog.length + 1;
  let candidate = generatedEventId(now, type, index);
  while (existing.has(candidate)) {
    index += 1;
    candidate = generatedEventId(now, type, index);
  }
  return candidate;
}

function buildTaskPrompt(task) {
  return [
    `Implement Plan2Agent task ${task.id}: ${task.title}.`,
    '',
    task.description,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    `Target area: ${task.targetArea}`,
    '',
    task.suggestedAgentPrompt,
  ].join('\n');
}

function buildMonitorPrompt(task) {
  return [
    `Review whether Plan2Agent task ${task.id} can be accepted after implementation.`,
    '',
    'Return a small JSON verdict file with one of these values:',
    '- {"verdict":"confirm_done"}',
    '- {"verdict":"block"}',
    '- {"verdict":"scope_concerns"}',
    '- {"verdict":"verification_concerns"}',
    '- {"verdict":"unmet_acceptance"}',
    '- {"verdict":"needs_user_decision"}',
    '',
    'Check the run output, changed files, verification results, and acceptance criteria.',
  ].join('\n');
}

function orchestrationRole({ roleId, role, profileSelection, agentTool, scope, basePrompt, requiresWrite }) {
  const roleData = {
    roleId,
    role,
    profile: profileSelection.profile,
    profileSource: profileSelection.profileSource,
    profileReason: profileSelection.profileReason,
    agentTool,
    scope,
    executionGuide: providerExecutionGuide(agentTool, role, profileSelection.profile),
    prompt: null,
    requiresWrite,
  };
  roleData.prompt = providerAwarePrompt(roleData, basePrompt);
  return roleData;
}

function buildPlan(args, source, task, now = new Date()) {
  const riskFlags = buildRiskFlags(task);
  const mode = modeForRiskFlags(riskFlags);
  const monitorRequired = mode !== 'solo';
  if (args.reviewerProfile && mode !== 'team') {
    throw new Error('--reviewer-profile requires a team-mode task with a reviewer role');
  }
  if (args.agentTool === 'gemini') {
    throw new Error('Gemini is read-only in P2A orchestration; use --agent-tool codex, claude, or manual for implementation and --reviewer-tool gemini for read-only review');
  }
  const reviewerTool = args.reviewerTool ?? args.agentTool;
  assertReviewerToolCompatible(args.agentTool, reviewerTool);
  const implementerProfile = overrideRoleProfile(
    selectImplementerProfile(task),
    args.implementerProfile,
    '--implementer-profile',
  );
  const reviewerProfile = overrideRoleProfile(
    selectReviewerProfile(task, reviewerTool),
    args.reviewerProfile,
    '--reviewer-profile',
  );
  const ownerProfile = roleProfileSelection('owner_supervisor', 'fixed owner supervision role');
  const monitorProfile = roleProfileSelection('manual_monitor', 'fixed manual monitor gate role');
  const roles = [
    orchestrationRole({
      roleId: 'owner',
      role: 'lead',
      profileSelection: ownerProfile,
      agentTool: 'manual',
      scope: 'Own the run lifecycle, approvals, verification recording, and final task state transition.',
      basePrompt: `Supervise ${task.id}, start the run with p2a_execute, and only finish after verification and monitor gate policy are satisfied.`,
      requiresWrite: false,
    }),
    orchestrationRole({
      roleId: 'implementer',
      role: 'contributor',
      profileSelection: implementerProfile,
      agentTool: args.agentTool,
      scope: 'Implement the approved ready task in the selected workspace or isolated worktree.',
      basePrompt: buildTaskPrompt(task),
      requiresWrite: args.agentTool !== 'manual',
    }),
  ];
  if (mode === 'team') {
    roles.push(orchestrationRole({
      roleId: 'reviewer',
      role: 'reviewer',
      profileSelection: reviewerProfile,
      agentTool: reviewerTool,
      scope: 'Read-only review of implementation scope, acceptance coverage, and verification evidence.',
      basePrompt: buildMonitorPrompt(task),
      requiresWrite: false,
    }));
  }
  if (monitorRequired) {
    roles.push(orchestrationRole({
      roleId: 'monitor',
      role: 'monitor',
      profileSelection: monitorProfile,
      agentTool: 'manual',
      scope: 'Owner-visible monitor gate that decides whether the run can close as done.',
      basePrompt: buildMonitorPrompt(task),
      requiresWrite: false,
    }));
  }
  const providerStrategy = providerStrategyForRoles(roles);

  const handoffPrompts = roles.map((role) => ({
    roleId: role.roleId,
    command: role.roleId === 'owner' ? null : role.agentTool,
    prompt: role.prompt,
  }));

  const plan = {
    schema_version: 'p2a.orchestration_plan.v1',
    planId: generatedPlanId(task.id, now),
    projectId: source.projectId,
    taskId: task.id,
    taskTitle: task.title,
    sourceLayout: source.sourceLayout,
    sourceArgs: source.sourceArgs,
    sourceTaskGraph: source.taskGraphRef,
    sourceSpec: source.sourceSpecRef,
    mode,
    createdAt: now.toISOString(),
    planner: {
      type: 'deterministic',
      name: 'p2a_orchestrate',
      version: 'mvp-1',
    },
    providerStrategy,
    providerCapabilities: providerCapabilityList(),
    roles,
    acceptanceCriteria: task.acceptanceCriteria,
    verificationPlan: [
      {
        type: 'custom',
        command: null,
        required: true,
      },
    ],
    handoffPrompts,
    monitorGate: {
      required: monitorRequired,
      verdictPath: monitorRequired ? '{runId}.monitor-verdict.json' : null,
      acceptedVerdicts: monitorRequired ? ['confirm_done'] : [],
      failureClassMap: {
        block: 'implementation_incomplete',
        scope_concerns: 'scope_violation',
        verification_concerns: 'verification_failed',
        unmet_acceptance: 'implementation_incomplete',
        needs_user_decision: 'missing_dependency',
      },
    },
    riskFlags,
    runLink: {
      runId: null,
      sidecarRef: null,
    },
  };
  return validateOrchestrationPlanData(plan);
}

function writeJson(filePath, data) {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return resolved;
}

function loadPlan(filePath) {
  assertFile(filePath, 'orchestration plan');
  return validateOrchestrationPlanData(JSON.parse(readFileSync(filePath, 'utf8')));
}

function acceptedMonitorVerdictsForRuntime(runtimePath, runtime) {
  if (!runtime.sourcePlanRef) return DEFAULT_ACCEPTED_MONITOR_VERDICTS;
  const planPath = path.resolve(path.dirname(runtimePath), runtime.sourcePlanRef);
  if (!existsSync(planPath)) return DEFAULT_ACCEPTED_MONITOR_VERDICTS;
  const plan = loadPlan(planPath);
  return plan.monitorGate.acceptedVerdicts.length
    ? plan.monitorGate.acceptedVerdicts
    : DEFAULT_ACCEPTED_MONITOR_VERDICTS;
}

export function orchestrationRuntimePath(runsDir, runId) {
  assertSafeRunId(runId);
  return path.join(runsDir, `${runId}.orchestration-runtime.json`);
}

export function readOrchestrationRuntime(filePath) {
  assertFile(filePath, 'orchestration runtime');
  return validateOrchestrationRuntimeData(JSON.parse(readFileSync(filePath, 'utf8')));
}

function runtimeRoleStatusFor(role) {
  if (role.roleId === 'owner' || role.roleId === 'implementer') return 'active';
  return 'pending';
}

function runtimeRoleMap(runtimeOrPlan) {
  const roles = runtimeOrPlan.roles ?? runtimeOrPlan.sharedMentalModel?.roleAssignments ?? [];
  return new Map(roles.map((role) => [role.roleId, role]));
}

export function buildInitialRuntime(plan, runId, sourcePlanRef = null, now = new Date()) {
  assertSafeRunId(runId);
  const createdAt = now.toISOString();
  const rolesById = runtimeRoleMap(plan);
  const communicationLog = plan.handoffPrompts.map((prompt, index) => {
    const role = rolesById.get(prompt.roleId);
    return {
      eventId: generatedEventId(now, `handoff-${prompt.roleId}`, index + 1),
      createdAt,
      roleId: prompt.roleId,
      role: role.role,
      agentTool: role.agentTool,
      type: 'handoff',
      summary: `Handoff prepared for ${prompt.roleId}`,
      detail: prompt.prompt,
      linkedRoleId: null,
      requiresOwnerAction: false,
    };
  });
  const runtime = {
    schema_version: 'p2a.orchestration_runtime.v1',
    runtimeId: generatedRuntimeId(runId),
    projectId: plan.projectId,
    taskId: plan.taskId,
    taskTitle: plan.taskTitle,
    runId,
    planId: plan.planId,
    mode: plan.mode,
    sourcePlanRef: sourcePlanRef ?? plan.runLink?.sidecarRef ?? `${runId}.orchestration.json`,
    createdAt,
    updatedAt: createdAt,
    sharedMentalModel: {
      objective: `Complete ${plan.taskId}: ${plan.taskTitle}`,
      currentState: `Run ${runId} is started and role handoff prompts are prepared.`,
      constraints: [
        'Use p2a_execute and p2a_runs for run lifecycle changes; do not edit run logs by hand.',
        'Do not change the task graph or planning artifacts unless the owner explicitly approves it.',
        ...plan.roles.map((role) => `${role.roleId} [${role.profile}]: ${role.scope}`),
      ],
      acceptanceCriteria: plan.acceptanceCriteria,
      roleAssignments: plan.roles.map((role) => ({
        roleId: role.roleId,
        role: role.role,
        profile: role.profile,
        profileSource: role.profileSource,
        profileReason: role.profileReason,
        agentTool: role.agentTool,
        executionGuide: role.executionGuide,
        scope: role.scope,
        status: runtimeRoleStatusFor(role),
      })),
      decisions: [],
      openQuestions: [],
      risks: plan.riskFlags,
    },
    communicationLog,
    status: {
      phase: 'running',
      blocked: false,
      needsUserDecision: false,
      lastEventId: communicationLog.at(-1)?.eventId ?? null,
    },
  };
  return validateOrchestrationRuntimeData(runtime);
}

export function writeOrchestrationRuntimeForRun(plan, runsDir, runId, now = new Date()) {
  const sourcePlanRef = plan.runLink?.sidecarRef ?? `${runId}.orchestration.json`;
  const runtime = buildInitialRuntime(plan, runId, sourcePlanRef, now);
  const filePath = orchestrationRuntimePath(runsDir, runId);
  return { filePath: writeJson(filePath, runtime), runtime };
}

function roleAssignment(runtime, roleId) {
  const role = runtime.sharedMentalModel.roleAssignments.find((item) => item.roleId === roleId);
  if (!role) throw new Error(`unknown runtime role: ${roleId}`);
  return role;
}

function appendRuntimeEvent(runtime, args, now = new Date()) {
  const role = roleAssignment(runtime, args.roleId);
  const linkedRole = args.linkedRoleId ? roleAssignment(runtime, args.linkedRoleId) : null;
  const createdAt = now.toISOString();
  const event = {
    eventId: nextEventId(runtime, now, args.eventType),
    createdAt,
    roleId: role.roleId,
    role: role.role,
    agentTool: role.agentTool,
    type: args.eventType,
    summary: args.summary,
    detail: args.detail ?? null,
    linkedRoleId: linkedRole?.roleId ?? null,
    requiresOwnerAction: args.requiresOwnerAction || ['question', 'concern', 'blocker'].includes(args.eventType),
  };
  runtime.communicationLog.push(event);
  if (args.roleStatus) role.status = args.roleStatus;
  if (args.eventType === 'decision') {
    runtime.sharedMentalModel.decisions.push({
      decisionId: `decision-${event.eventId.slice('event-'.length)}`,
      summary: event.summary,
      rationale: event.detail,
      createdAt,
      roleId: role.roleId,
    });
  }
  if (args.eventType === 'question') {
    runtime.sharedMentalModel.openQuestions.push({
      questionId: `question-${event.eventId.slice('event-'.length)}`,
      summary: event.summary,
      askedByRoleId: role.roleId,
      targetRoleId: linkedRole?.roleId ?? null,
      status: 'open',
      answer: null,
      createdAt,
      answeredAt: null,
    });
  }
  if (args.eventType === 'answer') {
    const matchingQuestion = runtime.sharedMentalModel.openQuestions.find((question) => (
      question.status === 'open'
      && (question.targetRoleId === role.roleId || question.targetRoleId === null)
    )) ?? runtime.sharedMentalModel.openQuestions.find((question) => question.status === 'open');
    if (matchingQuestion) {
      matchingQuestion.status = 'answered';
      matchingQuestion.answer = event.detail ?? event.summary;
      matchingQuestion.answeredAt = createdAt;
    }
  }
  runtime.updatedAt = createdAt;
  runtime.status.lastEventId = event.eventId;
  runtime.status.phase = args.phase ?? inferredRuntimePhase(runtime.status.phase, args.eventType);
  runtime.status.blocked = runtime.status.blocked || runtime.status.phase === 'blocked' || args.eventType === 'blocker' || args.roleStatus === 'blocked';
  const hasOpenQuestion = runtime.sharedMentalModel.openQuestions.some((question) => question.status === 'open');
  if (['answer', 'ack', 'decision'].includes(args.eventType) && !hasOpenQuestion && !runtime.status.blocked) {
    runtime.status.needsUserDecision = false;
  } else {
    runtime.status.needsUserDecision = runtime.status.needsUserDecision || event.requiresOwnerAction || hasOpenQuestion;
  }
  return { runtime: validateOrchestrationRuntimeData(runtime), event };
}

export function recordOrchestrationRuntimeEvent(filePath, eventInput, now = new Date()) {
  const runtime = readOrchestrationRuntime(filePath);
  const { runtime: updatedRuntime, event } = appendRuntimeEvent(runtime, {
    roleId: eventInput.roleId,
    eventType: eventInput.eventType,
    summary: eventInput.summary,
    detail: eventInput.detail ?? null,
    linkedRoleId: eventInput.linkedRoleId ?? null,
    roleStatus: eventInput.roleStatus ?? null,
    phase: eventInput.phase ?? null,
    requiresOwnerAction: eventInput.requiresOwnerAction ?? false,
  }, now);
  writeJson(filePath, updatedRuntime);
  return { runtime: updatedRuntime, event };
}

function inferredRuntimePhase(currentPhase, eventType) {
  if (eventType === 'blocker') return 'blocked';
  if (eventType === 'verification') return 'ready_for_monitor';
  if (eventType === 'monitor_verdict') return 'ready_to_finish';
  if (currentPhase === 'initialized') return 'running';
  return currentPhase;
}

function runtimeRoles(runtime) {
  return runtime.sharedMentalModel.roleAssignments;
}

function findRuntimeRole(runtime, roleId) {
  return runtimeRoles(runtime).find((role) => role.roleId === roleId) ?? null;
}

function requireRuntimeRole(runtime, roleId) {
  const role = findRuntimeRole(runtime, roleId);
  if (!role) throw new Error(`unknown runtime role: ${roleId}`);
  return role;
}

function roleIsIncomplete(role) {
  return !['complete', 'skipped'].includes(role.status);
}

function preferredRuntimeRole(runtime, roleIds) {
  for (const roleId of roleIds) {
    const role = findRuntimeRole(runtime, roleId);
    if (role && roleIsIncomplete(role)) return role;
  }
  return null;
}

function nextRoleDecision(runtime) {
  const owner = findRuntimeRole(runtime, 'owner') ?? runtimeRoles(runtime)[0] ?? null;
  const blockedRole = runtimeRoles(runtime).find((role) => role.status === 'blocked');
  if (runtime.status.phase === 'closed') {
    return {
      role: null,
      reason: 'runtime_closed',
      instruction: 'No next role. The run runtime is closed.',
    };
  }
  if (runtime.status.blocked || runtime.status.phase === 'blocked' || blockedRole) {
    return {
      role: owner,
      reason: blockedRole ? `role_blocked:${blockedRole.roleId}` : 'runtime_blocked',
      instruction: 'Owner should inspect the blocker and decide whether to unblock, ask the user, or finish blocked.',
    };
  }

  const openQuestion = runtime.sharedMentalModel.openQuestions.find((question) => question.status === 'open');
  if (openQuestion) {
    const targetRole = openQuestion.targetRoleId ? findRuntimeRole(runtime, openQuestion.targetRoleId) : null;
    return {
      role: targetRole ?? owner,
      reason: `open_question:${openQuestion.questionId}`,
      instruction: targetRole
        ? `Answer the open question from ${openQuestion.askedByRoleId}.`
        : 'Owner should route or answer the open question.',
    };
  }

  if (runtime.status.needsUserDecision) {
    return {
      role: owner,
      reason: 'owner_decision_required',
      instruction: 'Owner should make or record the required decision before continuing.',
    };
  }

  if (runtime.status.phase === 'ready_to_finish') {
    return {
      role: owner,
      reason: 'ready_to_finish',
      instruction: 'Owner should review the runtime, run verification/finish commands, and close the task lifecycle.',
    };
  }

  if (runtime.status.phase === 'ready_for_monitor') {
    const monitorRole = preferredRuntimeRole(runtime, ['monitor']);
    if (monitorRole) {
      return {
        role: monitorRole,
        reason: 'monitor_required',
        instruction: 'Human should open the monitor role prompt in the official CLI/app and record the verdict.',
      };
    }
    const reviewerRole = preferredRuntimeRole(runtime, ['reviewer']);
    if (reviewerRole) {
      return {
        role: reviewerRole,
        reason: 'reviewer_required',
        instruction: 'Human should open the reviewer role prompt in the official CLI/app and record the result.',
      };
    }
    return {
      role: owner,
      reason: 'monitor_not_configured',
      instruction: 'Owner should decide whether the run is ready to finish.',
    };
  }

  const implementerRole = preferredRuntimeRole(runtime, ['implementer']);
  if (implementerRole) {
    return {
      role: implementerRole,
      reason: 'implementation_required',
      instruction: 'Human should open the implementer role prompt in the official CLI/app and record the result.',
    };
  }

  const reviewerRole = preferredRuntimeRole(runtime, ['reviewer']);
  if (reviewerRole) {
    return {
      role: reviewerRole,
      reason: 'review_required',
      instruction: 'Human should open the reviewer role prompt in the official CLI/app and record the result.',
    };
  }

  const monitorRole = preferredRuntimeRole(runtime, ['monitor']);
  if (monitorRole) {
    return {
      role: monitorRole,
      reason: 'monitor_required',
      instruction: 'Human should open the monitor role prompt in the official CLI/app and record the verdict.',
    };
  }

  return {
    role: owner,
    reason: 'roles_complete',
    instruction: 'Owner should finish the run lifecycle. No agent process is started by this scheduler.',
  };
}

function schedulerResolutionHints(runtime, decision) {
  if (runtime.status.phase === 'closed') {
    return ['No scheduler action remains for this runtime.'];
  }
  const blockedRole = runtimeRoles(runtime).find((role) => role.status === 'blocked');
  const latestBlocker = [...runtime.communicationLog].reverse().find((event) => event.type === 'blocker');
  if (runtime.status.blocked || runtime.status.phase === 'blocked' || blockedRole) {
    return [
      latestBlocker ? `Inspect blocker ${latestBlocker.eventId}: ${latestBlocker.summary}.` : 'Inspect the latest blocked role and run output.',
      'Run p2a_orchestrate failure-policy --runtime <path> to choose retry, ask-user, or stop.',
      'Record an owner decision before skipping or finishing blocked.',
      blockedRole ? `Do not mark ${blockedRole.roleId} active as a retry; this runtime remains blocked until it is closed.` : 'Do not retry inside this blocked runtime.',
      'If continuing is approved, finish this run blocked and open a follow-up supervised run or maintenance task.',
      'If acceptance cannot be met, finish blocked with the appropriate failure class.',
    ];
  }
  if (runtime.status.needsUserDecision) {
    return ['Record the owner decision, then recompute next-role before continuing.'];
  }
  if (runtime.status.phase === 'ready_for_monitor') {
    return ['Open the monitor or reviewer role prompt manually and record the verdict/result.'];
  }
  if (runtime.status.phase === 'ready_to_finish') {
    return ['Review verification evidence and close the run lifecycle with p2a_execute finish.'];
  }
  if (decision.role) {
    return [
      `Open ${decision.role.agentTool === 'manual' ? 'the manual workflow' : `${decision.role.agentTool} in the official foreground CLI/app`} for ${decision.role.roleId}.`,
      'Paste the role prompt and keep the owner supervising the session.',
      'Record complete, blocked, or skipped when the observed role result is clear.',
    ];
  }
  return ['Recompute next-role after recording any missing runtime event.'];
}

function schedulerHint(runtime) {
  const decision = nextRoleDecision(runtime);
  return {
    schema_version: 'p2a.orchestration_scheduler_hint.v1',
    runtimeId: runtime.runtimeId,
    runId: runtime.runId,
    taskId: runtime.taskId,
    phase: runtime.status.phase,
    supervisedOnly: true,
    startsProcess: false,
    nextRole: decision.role
      ? {
          roleId: decision.role.roleId,
          role: decision.role.role,
          profile: decision.role.profile,
          profileSource: decision.role.profileSource,
          profileReason: decision.role.profileReason,
          agentTool: decision.role.agentTool,
          executionGuide: decision.role.executionGuide,
          status: decision.role.status,
          command: decision.role.agentTool === 'manual' ? null : decision.role.agentTool,
        }
      : null,
    reason: decision.reason,
    instruction: decision.instruction,
    resolutionHints: schedulerResolutionHints(runtime, decision),
    safetyBoundary: 'Open the official CLI/app manually, paste the role prompt, then record the observed result. Do not use this scheduler to bypass subscription limits or run background automation.',
  };
}

function readRunForRuntime(runtimePath, runtime) {
  const runPath = path.join(path.dirname(runtimePath), `${runtime.runId}.json`);
  if (!existsSync(runPath)) {
    return {
      present: false,
      path: displayPath(runPath),
      run: null,
    };
  }
  const run = validateRunData(loadJson(runPath));
  if (run.runId !== runtime.runId) {
    throw new Error(`runtime runId ${runtime.runId} does not match run log ${run.runId}`);
  }
  return {
    present: true,
    path: displayPath(runPath),
    run,
  };
}

function latestRuntimeEvent(runtime, type) {
  return [...runtime.communicationLog].reverse().find((event) => event.type === type) ?? null;
}

function monitorFailureFromRuntime(runtime) {
  const event = latestRuntimeEvent(runtime, 'monitor_verdict');
  if (!event?.detail) return null;
  try {
    const detail = JSON.parse(event.detail);
    if (detail?.accepted === false) {
      return {
        source: 'monitor_verdict',
        class: 'implementation_incomplete',
        retryable: 'after_fix',
        needsUserDecision: false,
        evidence: `${event.eventId}: ${event.summary}`,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function runtimeFailureSignal(runtime, runInfo) {
  const runFailure = runInfo.run?.failure ?? null;
  if (runFailure) {
    return {
      source: 'run_failure',
      class: runFailure.class,
      retryable: runFailure.retryable,
      needsUserDecision: runFailure.needsUserDecision,
      evidence: `run ${runInfo.run.runId} status=${runInfo.run.status} source=${runFailure.source}`,
    };
  }
  const openQuestion = runtime.sharedMentalModel.openQuestions.find((question) => question.status === 'open');
  if (openQuestion) {
    return {
      source: 'open_question',
      class: 'other',
      retryable: 'no',
      needsUserDecision: true,
      evidence: `${openQuestion.questionId}: ${openQuestion.summary}`,
    };
  }
  const monitorFailure = monitorFailureFromRuntime(runtime);
  if (monitorFailure) return monitorFailure;
  if (runtime.status.needsUserDecision) {
    return {
      source: 'open_question',
      class: 'other',
      retryable: 'no',
      needsUserDecision: true,
      evidence: 'runtime status.needsUserDecision=true',
    };
  }
  const blockedRole = runtimeRoles(runtime).find((role) => role.status === 'blocked');
  if (runtime.status.blocked || runtime.status.phase === 'blocked' || blockedRole) {
    const latestBlocker = latestRuntimeEvent(runtime, 'blocker');
    return {
      source: 'blocked_runtime',
      class: 'other',
      retryable: 'no',
      needsUserDecision: true,
      evidence: latestBlocker ? `${latestBlocker.eventId}: ${latestBlocker.summary}` : (blockedRole ? `blocked role: ${blockedRole.roleId}` : 'runtime blocked'),
    };
  }
  if (runtime.status.phase === 'closed') {
    return {
      source: 'closed_runtime',
      class: null,
      retryable: 'no',
      needsUserDecision: false,
      evidence: 'runtime already closed',
    };
  }
  return {
    source: 'none',
    class: null,
    retryable: 'no',
    needsUserDecision: false,
    evidence: 'no failure signal found',
  };
}

function failurePolicyAction(signal, runtime, runInfo) {
  if (runInfo.run?.status === 'finished' || runtime.status.phase === 'closed') return 'stop';
  if (signal.needsUserDecision) return 'ask_user';
  if (signal.retryable === 'yes' || signal.retryable === 'after_fix') return 'retry';
  return 'stop';
}

function failurePolicyInstructions(action, signal, runtime) {
  if (action === 'retry') {
    const afterFix = signal.retryable === 'after_fix';
    return [
      afterFix
        ? 'Do not retry inside the blocked runtime. Fix or scope the blocker first, then open a follow-up supervised run or maintenance task.'
        : 'Do not retry inside the current runtime. Open a follow-up supervised run if the owner approves another attempt.',
      'Keep the provider CLI/app foreground and human-supervised; P2A should only provide role prompts and state recording.',
      `Record the next attempt against ${runtime.taskId} with a new run id so the blocked run remains auditable.`,
    ];
  }
  if (action === 'ask_user') {
    return [
      'Ask the user or owner for the missing decision before attempting more implementation.',
      'Record the answer with p2a_orchestrate record --type answer or a decision event, then recompute next-role.',
      'Do not start a retry until the open decision is answered and the owner explicitly approves the follow-up.',
    ];
  }
  return [
    'Do not start another attempt from this runtime.',
    'Keep or close the run as blocked/failed with the recorded failure class and preserve the audit trail.',
    'Create a new task only if the owner changes scope or accepts a separate follow-up.',
  ];
}

function failurePolicyPayload(runtimePath) {
  const resolvedRuntimePath = path.resolve(runtimePath);
  const runtime = readOrchestrationRuntime(resolvedRuntimePath);
  const runInfo = readRunForRuntime(resolvedRuntimePath, runtime);
  const signal = runtimeFailureSignal(runtime, runInfo);
  if (!RUNTIME_FAILURE_RETRYABLE.has(signal.retryable)) {
    throw new Error(`unsupported failure retryability in runtime policy: ${signal.retryable}`);
  }
  if (!RUNTIME_FAILURE_SOURCES.has(signal.source)) {
    throw new Error(`unsupported runtime failure source: ${signal.source}`);
  }
  const action = failurePolicyAction(signal, runtime, runInfo);
  return {
    schema_version: 'p2a.orchestration_failure_policy.v1',
    runtimeId: runtime.runtimeId,
    runId: runtime.runId,
    taskId: runtime.taskId,
    mode: runtime.mode,
    phase: runtime.status.phase,
    supervisedOnly: true,
    startsProcess: false,
    source: {
      runtimePath: displayPath(resolvedRuntimePath),
      runPath: runInfo.path,
      runPresent: runInfo.present,
      runStatus: runInfo.run?.status ?? null,
      signal: signal.source,
      evidence: signal.evidence,
    },
    failure: {
      class: signal.class,
      retryable: signal.retryable,
      needsUserDecision: signal.needsUserDecision,
    },
    action,
    ownerActionRequired: action === 'ask_user',
    instructions: failurePolicyInstructions(action, signal, runtime),
    safetyBoundary: 'This policy chooses the next supervised action only. It does not start provider CLIs, browser automation, background loops, unofficial APIs, or retries.',
  };
}

function handoffEventForRole(runtime, roleId) {
  return [...runtime.communicationLog].reverse().find((event) => event.type === 'handoff' && event.roleId === roleId) ?? null;
}

function recentRuntimeEvents(runtime, limit = 5) {
  return runtime.communicationLog.slice(-limit);
}

function providerDelegationInstructions(role) {
  if (role.agentTool === 'codex') {
    return [
      'Use Codex skills/custom agents for this profile when they are installed in the workspace.',
      'If role separation is useful, explicitly delegate inside this foreground Codex session to the relevant specialist or subagent.',
      'Do not ask P2A to launch Codex or any additional background session.',
    ];
  }
  if (role.agentTool === 'claude') {
    return [
      'Use Claude Code subagents, skills, or agent teams inside this foreground session when they are enabled for the account/project.',
      'If native agent teams are unavailable, continue with the supervised role prompt in the same foreground session.',
      'Do not ask P2A to launch Claude Code or any additional background session.',
    ];
  }
  if (role.agentTool === 'gemini') {
    return [
      'Use Gemini extensions, custom commands, GEMINI.md context, or MCP tools only for read-only planning/review/monitor support.',
      'Do not perform write-required implementation from the Gemini role.',
      'Do not ask P2A to launch Gemini or any additional background session.',
    ];
  }
  return [
    'Perform or supervise this role directly as the owner.',
    'Use provider-native delegation only from a manually opened foreground CLI/app session.',
  ];
}

function buildSupervisedRolePrompt(runtime, role) {
  const handoffEvent = handoffEventForRole(runtime, role.roleId);
  const basePrompt = handoffEvent?.detail ?? role.scope;
  const lines = [
    'Plan2Agent supervised role prompt',
    '',
    `Run: ${runtime.runId}`,
    `Task: ${runtime.taskId} - ${runtime.taskTitle}`,
    `Role: ${role.roleId} (${role.role}, ${role.agentTool})`,
    `Profile: ${role.profile}`,
    `Profile source: ${role.profileSource}`,
    `Profile reason: ${role.profileReason}`,
    `Status: ${role.status}`,
    `Provider surface: ${role.executionGuide.surface}`,
    `Recommended feature: ${role.executionGuide.recommendedFeature}`,
    `Fallback mode: ${role.executionGuide.fallbackMode}`,
    '',
    'Supervision boundary:',
    '- A human must open the official CLI/app and paste this prompt manually.',
    '- Provider-native skills, subagents, custom agents, or agent teams are allowed inside that foreground session when requested here.',
    '- P2A itself must not launch provider CLIs, background loops, browser automation, unofficial APIs, token reuse, or quota/rate-limit bypass.',
    '- Report results back to the owner, then record them with p2a_orchestrate mark-role or record.',
    '',
    'Provider-native delegation:',
    ...providerDelegationInstructions(role).map((instruction) => `- ${instruction}`),
    '',
    `Objective: ${runtime.sharedMentalModel.objective}`,
    `Current state: ${runtime.sharedMentalModel.currentState}`,
    '',
    'Role scope:',
    role.scope,
    '',
    'Acceptance criteria:',
    ...runtime.sharedMentalModel.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    'Constraints:',
    ...runtime.sharedMentalModel.constraints.map((constraint) => `- ${constraint}`),
    '',
    'Recent runtime events:',
    ...recentRuntimeEvents(runtime).map((event) => `- ${event.createdAt} ${event.roleId}/${event.type}: ${event.summary}`),
    '',
    'Role handoff prompt:',
    basePrompt,
    '',
    'Completion report:',
    '- Summarize what was done or reviewed.',
    '- List changed files, verification commands/results, blockers, and user decisions needed.',
    '- Do not directly edit Plan2Agent run logs or task graph files.',
  ];
  return lines.join('\n');
}

function rolePromptPayload(runtime, role) {
  return {
    schema_version: 'p2a.orchestration_role_prompt.v1',
    runtimeId: runtime.runtimeId,
    runId: runtime.runId,
    taskId: runtime.taskId,
    role: {
      roleId: role.roleId,
      role: role.role,
      profile: role.profile,
      profileSource: role.profileSource,
      profileReason: role.profileReason,
      agentTool: role.agentTool,
      executionGuide: role.executionGuide,
      status: role.status,
      command: role.agentTool === 'manual' ? null : role.agentTool,
    },
    supervisedOnly: true,
    startsProcess: false,
    prompt: buildSupervisedRolePrompt(runtime, role),
  };
}

function providerRunnerAdapter(role) {
  const capability = PROVIDER_CAPABILITIES[role.agentTool] ?? PROVIDER_CAPABILITIES.manual;
  const profileLabel = role.profile.split('_').join(' ');
  if (role.agentTool === 'codex') {
    return {
      adapterName: 'codex_supervised_skills_custom_agents',
      provider: 'codex',
      surface: capability.executionSurface,
      officialFeatures: [...capability.officialFeatures],
      availabilityChecks: [
        'Confirm Codex CLI/app is opened manually in the target workspace.',
        `Confirm a suitable skill/custom agent exists for ${profileLabel}, or use the plain role prompt.`,
        'Confirm the owner can see the foreground session before any write action.',
      ],
      foregroundSteps: [
        'Open Codex manually in the project workspace.',
        `Paste the supervised role prompt and explicitly request the ${profileLabel} specialist behavior.`,
        'Inside that foreground Codex session, ask Codex to use the relevant skill/custom agent or subagent explicitly in the prompt when role separation is useful.',
        'Keep the owner supervising the foreground session and capture changed files plus verification evidence.',
        `Record the observed result with mark-role for ${role.roleId}.`,
      ],
      fallbackSteps: [
        'Use the same supervised role prompt without a custom agent or subagent.',
        'If the session cannot continue safely, record the role as blocked and let the owner close or open a follow-up run.',
      ],
      prohibitedAutomation: [...COMMON_PROHIBITED_AUTOMATION],
    };
  }
  if (role.agentTool === 'claude') {
    return {
      adapterName: 'claude_supervised_agent_teams_subagents',
      provider: 'claude',
      surface: capability.executionSurface,
      officialFeatures: [...capability.officialFeatures],
      availabilityChecks: [
        'Confirm Claude Code is opened manually in the target workspace.',
        'Confirm agent teams/subagents are enabled for the account and project before using them.',
        'Confirm the owner can supervise the foreground session and approve tool use.',
      ],
      foregroundSteps: [
        'Open Claude Code manually in the project workspace.',
        `Inside that foreground Claude Code session, use native agent teams/subagents for ${profileLabel} when they are available.`,
        'If agent teams are disabled or experimental access is unavailable, paste the supervised role prompt as a normal foreground task.',
        'Keep implementation and review inside the assigned role scope.',
        `Record the observed result with mark-role for ${role.roleId}.`,
      ],
      fallbackSteps: [
        'Use a single supervised Claude Code role prompt.',
        'If team/subagent behavior is unavailable, do not emulate it by starting hidden background sessions.',
      ],
      prohibitedAutomation: [...COMMON_PROHIBITED_AUTOMATION],
    };
  }
  if (role.agentTool === 'gemini') {
    return {
      adapterName: 'gemini_read_only_extensions_custom_commands',
      provider: 'gemini',
      surface: capability.executionSurface,
      officialFeatures: [...capability.officialFeatures],
      availabilityChecks: [
        'Confirm Gemini CLI is opened manually in the target workspace.',
        'Confirm the role is review or monitor only; Gemini is read-only in P2A orchestration.',
        'Confirm extensions/custom commands/GEMINI.md context are available if the project uses them.',
      ],
      foregroundSteps: [
        'Open Gemini CLI manually in the project workspace.',
        `Paste the supervised read-only prompt for ${profileLabel}.`,
        'Use extensions, custom commands, GEMINI.md context, or MCP tools only for planning, review, or monitor support.',
        'Return findings to the owner without editing files.',
        `Record the observed result with mark-role for ${role.roleId}.`,
      ],
      fallbackSteps: [
        'Use the pasted read-only prompt without extensions or custom commands.',
        'If review cannot be completed read-only, record the role as blocked and assign a write-capable provider in a follow-up plan.',
      ],
      prohibitedAutomation: [
        ...COMMON_PROHIBITED_AUTOMATION,
        'Do not use Gemini for write-required implementation in this P2A mode.',
      ],
    };
  }
  return {
    adapterName: 'manual_owner_foreground_action',
    provider: 'manual',
    surface: capability.executionSurface,
    officialFeatures: [...capability.officialFeatures],
    availabilityChecks: [
      'Confirm the owner is ready to perform or record this role directly.',
      'Confirm run lifecycle and monitor gate decisions are visible before state changes.',
    ],
    foregroundSteps: [
      'Review the plan/runtime state in the foreground workspace.',
      `Perform or supervise the ${role.roleId} role directly.`,
      'Record the observed state with p2a_orchestrate record or mark-role.',
      'Close the run lifecycle only after verification and monitor policy are satisfied.',
    ],
    fallbackSteps: [
      'If the owner cannot decide, record an owner_note or blocker and keep the runtime supervised.',
    ],
    prohibitedAutomation: [...COMMON_PROHIBITED_AUTOMATION],
  };
}

function selectGuideRoles(roles, roleId, sourceLabel) {
  if (!roleId) return roles;
  const role = roles.find((item) => item.roleId === roleId);
  if (!role) throw new Error(`unknown ${sourceLabel} role: ${roleId}`);
  return [role];
}

function runnerGuideRole(role, actionCommand) {
  return {
    roleId: role.roleId,
    role: role.role,
    profile: role.profile,
    profileSource: role.profileSource,
    profileReason: role.profileReason,
    agentTool: role.agentTool,
    status: role.status ?? null,
    executionGuide: role.executionGuide,
    actionCommand,
    runnerAdapter: providerRunnerAdapter(role),
  };
}

function runnerGuideFromPlan(plan, planPath, roleId) {
  const sourcePath = displayPath(path.resolve(planPath));
  const roles = selectGuideRoles(plan.roles, roleId, 'plan');
  return {
    schema_version: 'p2a.provider_runner_guide.v1',
    source: {
      type: 'plan',
      path: sourcePath,
      planId: plan.planId,
      runtimeId: null,
      runId: null,
    },
    taskId: plan.taskId,
    taskTitle: plan.taskTitle,
    mode: plan.mode,
    providerStrategy: plan.providerStrategy,
    supervisedOnly: true,
    startsProcess: false,
    safetyBoundary: 'This guide prints provider-native supervised steps only. P2A does not start provider CLIs, browser automation, background loops, or unofficial API sessions.',
    roles: roles.map((role) => runnerGuideRole(
      role,
      commandLine('p2a_orchestrate.mjs', ['handoff', '--plan', sourcePath]),
    )),
  };
}

function runnerGuideFromRuntime(runtime, runtimePath, roleId) {
  const sourcePath = displayPath(path.resolve(runtimePath));
  const roles = selectGuideRoles(runtime.sharedMentalModel.roleAssignments, roleId, 'runtime');
  return {
    schema_version: 'p2a.provider_runner_guide.v1',
    source: {
      type: 'runtime',
      path: sourcePath,
      planId: runtime.planId,
      runtimeId: runtime.runtimeId,
      runId: runtime.runId,
    },
    taskId: runtime.taskId,
    taskTitle: runtime.taskTitle,
    mode: runtime.mode,
    providerStrategy: null,
    supervisedOnly: true,
    startsProcess: false,
    safetyBoundary: 'This guide prints provider-native supervised steps only. P2A does not start provider CLIs, browser automation, background loops, or unofficial API sessions.',
    roles: roles.map((role) => runnerGuideRole(
      role,
      commandLine('p2a_orchestrate.mjs', ['role-prompt', '--runtime', sourcePath, '--role', role.roleId]),
    )),
  };
}

function printRunnerGuide(payload) {
  console.log('Plan2Agent provider-native runner guide');
  console.log(`- source: ${payload.source.type} ${payload.source.path}`);
  console.log(`- task: ${payload.taskId} - ${payload.taskTitle}`);
  console.log(`- mode: ${payload.mode}`);
  if (payload.providerStrategy) {
    console.log(`- providerStrategy: ${payload.providerStrategy.mode} (${payload.providerStrategy.primaryProvider})`);
  }
  console.log(`- supervisedOnly: ${payload.supervisedOnly}`);
  console.log(`- startsProcess: ${payload.startsProcess}`);
  console.log(`- safety: ${payload.safetyBoundary}`);
  console.log('');
  for (const role of payload.roles) {
    console.log(`[${role.roleId}]`);
    console.log(`provider: ${role.agentTool}`);
    console.log(`profile: ${role.profile} (${role.profileSource})`);
    console.log(`adapter: ${role.runnerAdapter.adapterName}`);
    console.log(`surface: ${role.runnerAdapter.surface}`);
    console.log(`officialFeatures: ${role.runnerAdapter.officialFeatures.join(', ')}`);
    console.log(`actionCommand: ${role.actionCommand}`);
    console.log('availabilityChecks:');
    role.runnerAdapter.availabilityChecks.forEach((step) => console.log(`- ${step}`));
    console.log('foregroundSteps:');
    role.runnerAdapter.foregroundSteps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
    console.log('fallbackSteps:');
    role.runnerAdapter.fallbackSteps.forEach((step) => console.log(`- ${step}`));
    console.log('prohibitedAutomation:');
    role.runnerAdapter.prohibitedAutomation.forEach((step) => console.log(`- ${step}`));
    console.log('');
  }
}

function assertDirectory(dirPath, label) {
  if (!existsSync(dirPath)) throw new Error(`${label} is missing: ${dirPath}`);
  if (!lstatSync(dirPath).isDirectory()) throw new Error(`${label} must be a directory: ${dirPath}`);
}

function runnerDoctorCommonChecks() {
  return [
    { id: 'orchestrator_cli', label: 'p2a_orchestrate CLI', path: path.join('.plan2agent', 'scripts', 'p2a_orchestrate.mjs'), required: true },
    { id: 'execute_cli', label: 'p2a_execute CLI', path: path.join('.plan2agent', 'scripts', 'p2a_execute.mjs'), required: true },
    { id: 'orchestration_plan_schema', label: 'orchestration plan schema', path: path.join('.plan2agent', 'schemas', 'orchestration-plan.schema.json'), required: true },
    { id: 'orchestration_runtime_schema', label: 'orchestration runtime schema', path: path.join('.plan2agent', 'schemas', 'orchestration-runtime.schema.json'), required: true },
    { id: 'manifest', label: 'Plan2Agent install manifest', path: path.join('.plan2agent', 'manifest.json'), required: false },
  ];
}

function runnerDoctorProviderChecks(provider) {
  if (provider === 'codex') {
    return [
      { id: 'codex_implementer_agent', label: 'Codex implementer custom agent', path: path.join('.codex', 'agents', 'p2a-implementer.toml'), required: true },
      { id: 'codex_monitor_agent', label: 'Codex performance monitor custom agent', path: path.join('.codex', 'agents', 'p2a-performance-monitor.toml'), required: true },
      { id: 'codex_orchestrator_agent', label: 'Codex dev orchestrator custom agent', path: path.join('.codex', 'agents', 'p2a-dev-orchestrator.toml'), required: true },
      { id: 'common_dev_execution_skill', label: 'P2A dev execution skill', path: path.join('.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'), required: true },
      { id: 'team_bigfive_skill', label: 'Team Big Five kickoff skill', path: path.join('.agents', 'skills', 'team-bigfive-kickoff', 'SKILL.md'), required: false },
      { id: 'team_bigfive_codex_agent', label: 'Team Big Five Codex coordinator', path: path.join('.codex', 'agents', 'team-bigfive-coordinator.toml'), required: false },
    ];
  }
  if (provider === 'claude') {
    return [
      { id: 'claude_implementer_agent', label: 'Claude implementer subagent', path: path.join('.claude', 'agents', 'p2a-implementer.md'), required: true },
      { id: 'claude_monitor_agent', label: 'Claude performance monitor subagent', path: path.join('.claude', 'agents', 'p2a-performance-monitor.md'), required: true },
      { id: 'claude_orchestrator_agent', label: 'Claude dev orchestrator subagent', path: path.join('.claude', 'agents', 'p2a-dev-orchestrator.md'), required: true },
      { id: 'claude_dev_execution_skill', label: 'Claude dev execution skill', path: path.join('.claude', 'skills', 'p2a-dev-execution', 'SKILL.md'), required: true },
      { id: 'claude_workspace_hook', label: 'Claude workspace confinement hook', path: path.join('.claude', 'hooks', 'p2a-confine-workspace.mjs'), required: true },
      { id: 'claude_project_settings', label: 'Claude project settings', path: path.join('.claude', 'settings.json'), required: false },
      { id: 'team_bigfive_claude_skill', label: 'Team Big Five Claude kickoff skill', path: path.join('.claude', 'skills', 'team-bigfive-kickoff', 'SKILL.md'), required: false },
      { id: 'team_bigfive_claude_agent', label: 'Team Big Five Claude coordinator', path: path.join('.claude', 'agents', 'team-bigfive-coordinator.md'), required: false },
    ];
  }
  if (provider === 'gemini') {
    return [
      { id: 'gemini_orchestrator_agent', label: 'Gemini dev orchestrator subagent', path: path.join('.gemini', 'agents', 'p2a-dev-orchestrator.md'), required: true },
      { id: 'gemini_monitor_agent', label: 'Gemini performance monitor subagent', path: path.join('.gemini', 'agents', 'p2a-performance-monitor.md'), required: true },
      { id: 'gemini_review_agent', label: 'Gemini quality reviewer subagent', path: path.join('.gemini', 'agents', 'p2a-quality-reviewer.md'), required: true },
      { id: 'gemini_dev_execution_command', label: 'Gemini dev execution command', path: path.join('.gemini', 'commands', 'p2a', 'dev-execution.toml'), required: true },
      { id: 'gemini_context', label: 'GEMINI.md project context', path: 'GEMINI.md', required: false },
      { id: 'team_bigfive_gemini_command', label: 'Team Big Five Gemini command', path: path.join('.gemini', 'commands', 'p2a', 'team-bigfive.toml'), required: false },
      { id: 'team_bigfive_gemini_agent', label: 'Team Big Five Gemini coordinator', path: path.join('.gemini', 'agents', 'team-bigfive-coordinator.md'), required: false },
    ];
  }
  throw new Error(`unsupported runner-doctor provider: ${provider}`);
}

function providerNativeCapabilityDefinitions(provider) {
  if (provider === 'codex') {
    return [
      {
        id: 'skills',
        label: 'Codex skills',
        source: 'asset',
        assetPath: path.join('.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
        nextAction: 'Install P2A skills or rerun scaffold/handoff with Codex assets.',
      },
      {
        id: 'customAgents',
        label: 'Codex custom agents',
        source: 'asset',
        assetPath: path.join('.codex', 'agents', 'p2a-implementer.toml'),
        nextAction: 'Install Codex custom agents or use a plain supervised role prompt.',
      },
      {
        id: 'explicitSubagentPrompt',
        label: 'Explicit subagent prompt support',
        source: 'manual_evidence',
        nextAction: 'Open Codex manually and confirm that explicit subagent/specialist prompting works for this account.',
      },
    ];
  }
  if (provider === 'claude') {
    return [
      {
        id: 'subagents',
        label: 'Claude subagent files',
        source: 'asset',
        assetPath: path.join('.claude', 'agents', 'p2a-implementer.md'),
        nextAction: 'Install Claude subagent assets or use a plain supervised foreground prompt.',
      },
      {
        id: 'skills',
        label: 'Claude skills',
        source: 'asset',
        assetPath: path.join('.claude', 'skills', 'p2a-dev-execution', 'SKILL.md'),
        nextAction: 'Install Claude skill assets or use a plain supervised foreground prompt.',
      },
      {
        id: 'agentTeams',
        label: 'Claude agent teams account capability',
        source: 'manual_evidence',
        nextAction: 'Open Claude Code manually and record whether native agent teams are enabled for this account/project.',
      },
    ];
  }
  if (provider === 'gemini') {
    return [
      {
        id: 'extensions',
        label: 'Gemini extensions account capability',
        source: 'manual_evidence',
        nextAction: 'Open Gemini CLI manually and record whether extensions/MCP are available for read-only planning or review.',
      },
      {
        id: 'customCommands',
        label: 'Gemini custom commands',
        source: 'asset',
        assetPath: path.join('.gemini', 'commands', 'p2a', 'dev-execution.toml'),
        nextAction: 'Install Gemini custom command assets or use a plain supervised read-only prompt.',
      },
      {
        id: 'geminiContext',
        label: 'GEMINI.md project context',
        source: 'asset',
        assetPath: 'GEMINI.md',
        nextAction: 'Add GEMINI.md when this project needs shared Gemini read-only context.',
      },
    ];
  }
  throw new Error(`unsupported runner-doctor provider: ${provider}`);
}

function doctorCheck(rootPath, definition) {
  const absolutePath = path.resolve(rootPath, definition.path);
  const present = existsSync(absolutePath);
  const kind = present
    ? (lstatSync(absolutePath).isDirectory() ? 'directory' : (lstatSync(absolutePath).isFile() ? 'file' : 'other'))
    : 'missing';
  return {
    id: definition.id,
    label: definition.label,
    path: normalizePath(definition.path),
    required: definition.required,
    present,
    kind,
  };
}

function readOptionalJson(rootPath, relativePath) {
  const filePath = path.resolve(rootPath, relativePath);
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeCapabilityEvidence(value) {
  if (typeof value === 'boolean') {
    return {
      status: value ? 'available' : 'unavailable',
      evidence: null,
      checkedAt: null,
    };
  }
  if (typeof value === 'string') {
    return {
      status: PROVIDER_CAPABILITY_STATUSES.has(value) ? value : 'unknown',
      evidence: null,
      checkedAt: null,
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rawStatus = typeof value.status === 'string' ? value.status : 'unknown';
    return {
      status: PROVIDER_CAPABILITY_STATUSES.has(rawStatus) ? rawStatus : 'unknown',
      evidence: typeof value.evidence === 'string' && value.evidence.trim() ? value.evidence.trim() : null,
      checkedAt: typeof value.checkedAt === 'string' && value.checkedAt.trim() ? value.checkedAt.trim() : null,
    };
  }
  return {
    status: 'unknown',
    evidence: null,
    checkedAt: null,
  };
}

function providerCapabilityResult(rootPath, projectConfig, provider, definition) {
  const configured = normalizeCapabilityEvidence(projectConfig?.providerNativeCapabilities?.[provider]?.[definition.id]);
  const assetPath = definition.assetPath ?? null;
  const assetPresent = assetPath ? existsSync(path.resolve(rootPath, assetPath)) : null;
  let status;
  if (assetPath) {
    if (configured.status === 'unavailable') {
      status = 'unavailable';
    } else {
      status = assetPresent ? 'available' : 'manual_check';
    }
  } else {
    status = configured.status === 'unknown' ? 'manual_check' : configured.status;
  }
  return {
    id: definition.id,
    label: definition.label,
    source: definition.source,
    status,
    evidence: configured.evidence,
    checkedAt: configured.checkedAt,
    assetPath: assetPath ? normalizePath(assetPath) : null,
    assetPresent,
    nextAction: status === 'available' ? null : definition.nextAction,
  };
}

function capabilitySummary(capabilities) {
  return {
    available: capabilities.filter((capability) => capability.status === 'available').length,
    manualCheck: capabilities.filter((capability) => capability.status === 'manual_check').length,
    unavailable: capabilities.filter((capability) => capability.status === 'unavailable').length,
    unknown: capabilities.filter((capability) => capability.status === 'unknown').length,
    total: capabilities.length,
  };
}

function checkSummary(checks) {
  const requiredChecks = checks.filter((check) => check.required);
  const optionalChecks = checks.filter((check) => !check.required);
  return {
    requiredPresent: requiredChecks.filter((check) => check.present).length,
    requiredTotal: requiredChecks.length,
    optionalPresent: optionalChecks.filter((check) => check.present).length,
    optionalTotal: optionalChecks.length,
    missingRequired: requiredChecks.filter((check) => !check.present).map((check) => check.path),
    missingOptional: optionalChecks.filter((check) => !check.present).map((check) => check.path),
  };
}

function liveVersionProbe(provider, rootPath) {
  const command = RUNNER_DOCTOR_COMMANDS[provider];
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, RUNNER_DOCTOR_VERSION_ARGS, {
    cwd: rootPath,
    encoding: 'utf8',
    shell: false,
    timeout: 5000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const firstLine = output.split(/\r?\n/).find(Boolean) ?? null;
  let status = 'available';
  if (result.error?.code === 'ENOENT') status = 'missing';
  else if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') status = 'timeout';
  else if (result.error) status = 'error';
  else if ((result.status ?? 1) !== 0) status = 'error';
  return {
    id: `${provider}_version_probe`,
    provider,
    command,
    args: [...RUNNER_DOCTOR_VERSION_ARGS],
    status,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    output: firstLine,
    startedAt,
    startsAgentSession: false,
  };
}

function providerLiveStatus(liveChecks) {
  if (!liveChecks.length) return 'not_checked';
  const status = liveChecks[0].status;
  if (status === 'available') return 'available';
  if (status === 'missing') return 'missing';
  if (status === 'timeout') return 'timeout';
  return 'error';
}

function providerDoctorResult(rootPath, provider, commonChecks, manifestTargets, projectConfig, live) {
  const checks = runnerDoctorProviderChecks(provider).map((definition) => doctorCheck(rootPath, definition));
  const capabilities = providerNativeCapabilityDefinitions(provider)
    .map((definition) => providerCapabilityResult(rootPath, projectConfig, provider, definition));
  const requiredSummary = checkSummary([...commonChecks, ...checks]);
  const providerSummary = checkSummary(checks);
  const summary = {
    requiredPresent: requiredSummary.requiredPresent,
    requiredTotal: requiredSummary.requiredTotal,
    optionalPresent: providerSummary.optionalPresent,
    optionalTotal: providerSummary.optionalTotal,
    missingRequired: requiredSummary.missingRequired,
    missingOptional: providerSummary.missingOptional,
  };
  const providerCapabilitySummary = capabilitySummary(capabilities);
  const manifestTargeted = manifestTargets ? manifestTargets.includes(provider) : null;
  const liveChecks = live ? [liveVersionProbe(provider, rootPath)] : [];
  const liveStatus = providerLiveStatus(liveChecks);
  const status = summary.missingRequired.length
    ? 'missing'
    : manifestTargeted === false
      ? 'not_targeted'
      : 'ready';
  const nextActions = [];
  if (summary.missingRequired.length) {
    nextActions.push(`Install or refresh P2A ${provider} assets; missing required files: ${summary.missingRequired.join(', ')}`);
  }
  if (manifestTargeted === false) {
    nextActions.push(`Manifest aiToolTargets does not include ${provider}; rerun scaffold/handoff with --tools ${provider} or all if this provider should be used.`);
  }
  if (summary.missingOptional.length) {
    nextActions.push(`Optional provider enhancements are not installed: ${summary.missingOptional.join(', ')}`);
  }
  for (const capability of capabilities) {
    if (capability.nextAction) nextActions.push(`${capability.label}: ${capability.nextAction}`);
  }
  if (liveStatus === 'missing') {
    nextActions.push(`${provider} command was not found on PATH; install the official CLI/app or open it manually outside P2A.`);
  } else if (liveStatus === 'timeout') {
    nextActions.push(`${provider} --version probe timed out; verify the official CLI manually before using this provider.`);
  } else if (liveStatus === 'error') {
    nextActions.push(`${provider} --version probe failed; verify the official CLI manually before using this provider.`);
  }
  if (!nextActions.length) {
    nextActions.push('Provider assets are ready for supervised foreground use; open the official CLI/app manually and paste the role prompt.');
  }
  return {
    provider,
    status,
    manifestTargeted,
    summary,
    checks,
    capabilitySummary: providerCapabilitySummary,
    capabilities,
    liveStatus,
    liveChecks,
    nextActions,
    startsProcess: live,
    startsAgentSession: false,
  };
}

function runnerDoctorPayload(root, providerFilter, live, now = new Date()) {
  const rootPath = path.resolve(root);
  assertDirectory(rootPath, 'runner-doctor root');
  const manifest = readOptionalJson(rootPath, path.join('.plan2agent', 'manifest.json'));
  const projectConfig = readOptionalJson(rootPath, path.join('.plan2agent', 'project.config.json'));
  const manifestTargets = Array.isArray(manifest?.aiToolTargets) ? manifest.aiToolTargets : null;
  const commonChecks = runnerDoctorCommonChecks().map((definition) => doctorCheck(rootPath, definition));
  const providers = (providerFilter === 'all' ? ['codex', 'claude', 'gemini'] : [providerFilter])
    .map((provider) => providerDoctorResult(rootPath, provider, commonChecks, manifestTargets, projectConfig, live));
  return {
    schema_version: 'p2a.provider_runner_doctor.v1',
    checkedAt: now.toISOString(),
    root: displayPath(rootPath),
    supervisedOnly: true,
    live,
    startsProcess: live,
    startsAgentSession: false,
    safetyBoundary: live
      ? 'runner-doctor --live only runs provider --version probes. It does not authenticate, open agent sessions, run browser automation, background loops, or provider APIs.'
      : 'runner-doctor only reads files under the selected root. It does not start Codex, Claude, Gemini, browser automation, background loops, or provider APIs.',
    manifest: {
      present: manifest !== null,
      aiToolTargets: manifestTargets,
    },
    projectConfig: {
      present: projectConfig !== null,
      providerNativeCapabilities: projectConfig?.providerNativeCapabilities ? true : false,
    },
    commonChecks,
    providers,
  };
}

function printRunnerDoctor(payload) {
  console.log('Plan2Agent provider runner doctor');
  console.log(`- root: ${payload.root}`);
  console.log(`- supervisedOnly: ${payload.supervisedOnly}`);
  console.log(`- live: ${payload.live}`);
  console.log(`- startsProcess: ${payload.startsProcess}`);
  console.log(`- startsAgentSession: ${payload.startsAgentSession}`);
  console.log(`- safety: ${payload.safetyBoundary}`);
  console.log(`- manifest: ${payload.manifest.present ? `aiToolTargets=${(payload.manifest.aiToolTargets ?? []).join(',') || '-'}` : 'not found'}`);
  console.log(`- projectConfig: ${payload.projectConfig.present ? `providerNativeCapabilities=${payload.projectConfig.providerNativeCapabilities}` : 'not found'}`);
  console.log('');
  console.log('[common]');
  for (const check of payload.commonChecks) {
    console.log(`- ${check.present ? 'ok' : (check.required ? 'missing' : 'optional-missing')}: ${check.path}`);
  }
  console.log('');
  for (const provider of payload.providers) {
    console.log(`[${provider.provider}]`);
    console.log(`status: ${provider.status}`);
    console.log(`liveStatus: ${provider.liveStatus}`);
    console.log(`manifestTargeted: ${provider.manifestTargeted === null ? 'unknown' : provider.manifestTargeted}`);
    console.log(`required: ${provider.summary.requiredPresent}/${provider.summary.requiredTotal}`);
    console.log(`optional: ${provider.summary.optionalPresent}/${provider.summary.optionalTotal}`);
    console.log(`capabilities: available=${provider.capabilitySummary.available}/${provider.capabilitySummary.total}, manualCheck=${provider.capabilitySummary.manualCheck}, unavailable=${provider.capabilitySummary.unavailable}`);
    for (const check of provider.checks) {
      console.log(`- ${check.present ? 'ok' : (check.required ? 'missing' : 'optional-missing')}: ${check.path}`);
    }
    console.log('capabilityChecks:');
    for (const capability of provider.capabilities) {
      const asset = capability.assetPath ? ` asset=${capability.assetPath} present=${capability.assetPresent}` : '';
      const evidence = capability.evidence ? ` evidence=${capability.evidence}` : '';
      console.log(`- ${capability.status}: ${capability.id}${asset}${evidence}`);
    }
    if (provider.liveChecks.length) {
      console.log('liveChecks:');
      for (const check of provider.liveChecks) {
        const output = check.output ? ` output=${check.output}` : '';
        console.log(`- ${check.status}: ${check.command} ${check.args.join(' ')} exit=${check.exitCode ?? '-'}${output}`);
      }
    }
    console.log('nextActions:');
    provider.nextActions.forEach((action) => console.log(`- ${action}`));
    console.log('');
  }
}

function markRoleDefaults(runtime, role, status, options = {}) {
  if (status === 'blocked') {
    return {
      eventType: 'blocker',
      phase: 'blocked',
      requiresOwnerAction: true,
      summary: `${role.roleId} is blocked`,
    };
  }
  if (status === 'complete') {
    if (role.roleId === 'implementer') {
      const reviewer = preferredRuntimeRole(runtime, ['reviewer']);
      const monitor = preferredRuntimeRole(runtime, ['monitor']);
      return {
        eventType: 'status',
        phase: reviewer ? 'running' : (monitor ? 'ready_for_monitor' : 'ready_to_finish'),
        requiresOwnerAction: false,
        summary: `${role.roleId} completed supervised work`,
      };
    }
    if (role.roleId === 'reviewer') {
      const monitor = preferredRuntimeRole(runtime, ['monitor']);
      return {
        eventType: 'status',
        phase: monitor ? 'ready_for_monitor' : 'ready_to_finish',
        requiresOwnerAction: false,
        summary: `${role.roleId} completed supervised review`,
      };
    }
    if (role.roleId === 'monitor') {
      if (!options.verdict) {
        throw new Error('--verdict is required when marking monitor complete');
      }
      const acceptedVerdicts = options.acceptedMonitorVerdicts ?? DEFAULT_ACCEPTED_MONITOR_VERDICTS;
      const accepted = acceptedVerdicts.includes(options.verdict);
      return {
        eventType: 'monitor_verdict',
        phase: accepted ? 'ready_to_finish' : 'blocked',
        requiresOwnerAction: !accepted,
        summary: `${role.roleId} verdict ${options.verdict}`,
        detail: JSON.stringify({
          verdict: options.verdict,
          accepted,
        }),
      };
    }
  }
  return {
    eventType: 'status',
    phase: status === 'active' ? 'running' : runtime.status.phase,
    requiresOwnerAction: false,
    summary: `${role.roleId} marked ${status}`,
  };
}

function commandLine(scriptName, args) {
  return nodeScriptCommand(P2A_PATHS, scriptName, args).map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ownerStartArgs(plan, planPath) {
  const args = ['start', ...plan.sourceArgs, '--task', plan.taskId, '--orchestration-plan', planPath];
  const implementer = plan.roles.find((role) => role.roleId === 'implementer');
  if (implementer?.agentTool) args.push('--agent-tool', implementer.agentTool);
  return args;
}

function printSummary(plan) {
  console.log('Plan2Agent orchestration plan');
  console.log(`- planId: ${plan.planId}`);
  console.log(`- project: ${plan.projectId}`);
  console.log(`- task: ${plan.taskId} - ${plan.taskTitle}`);
  console.log(`- mode: ${plan.mode}`);
  console.log(`- providerStrategy: ${plan.providerStrategy.mode} (${plan.providerStrategy.primaryProvider})`);
  console.log(`- monitorGate: ${plan.monitorGate.required ? plan.monitorGate.verdictPath : 'not required'}`);
  console.log(`- roles: ${plan.roles.map((role) => `${role.roleId}:${role.agentTool}/${role.profile}(${role.profileSource})`).join(', ')}`);
  console.log(`- riskFlags: ${plan.riskFlags.join(', ') || '-'}`);
}

function runPlan(args) {
  const source = resolveSource(args);
  const task = selectReadyTask(source, args.taskId);
  const plan = buildPlan(args, source, task);
  const payload = `${JSON.stringify(plan, null, 2)}\n`;
  if (args.output) {
    const outputPath = writeJson(args.output, plan);
    printSummary(plan);
    console.log(`- written: ${displayPath(outputPath)}`);
    console.log('');
    console.log(`Handoff command: ${commandLine('p2a_orchestrate.mjs', ['handoff', '--plan', displayPath(outputPath)])}`);
    if (args.json) process.stdout.write(payload);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

function runShow(args) {
  const plan = loadPlan(args.plan);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  printSummary(plan);
  return 0;
}

function runValidate(args) {
  const plan = loadPlan(args.plan);
  console.log(`Plan2Agent orchestration plan validation passed: ${plan.planId}`);
  return 0;
}

function runHandoff(args) {
  const plan = loadPlan(args.plan);
  console.log('Plan2Agent orchestration handoff');
  console.log(`- planId: ${plan.planId}`);
  console.log(`- task: ${plan.taskId} - ${plan.taskTitle}`);
  console.log(`- start: ${commandLine('p2a_execute.mjs', ownerStartArgs(plan, args.plan))}`);
  if (plan.monitorGate.required) {
    console.log(`- monitor verdict: ${plan.monitorGate.verdictPath}`);
  }
  console.log('');
  for (const prompt of plan.handoffPrompts) {
    console.log(`[${prompt.roleId}]`);
    if (prompt.command) console.log(`command: ${prompt.command}`);
    console.log(prompt.prompt);
    console.log('');
  }
  return 0;
}

function runRunnerGuide(args) {
  const payload = args.plan
    ? runnerGuideFromPlan(loadPlan(args.plan), args.plan, args.roleId)
    : runnerGuideFromRuntime(readOrchestrationRuntime(path.resolve(args.runtime)), args.runtime, args.roleId);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  printRunnerGuide(payload);
  return 0;
}

function runRunnerDoctor(args) {
  const payload = runnerDoctorPayload(args.root, args.provider, args.live);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  printRunnerDoctor(payload);
  return 0;
}

function runInitRuntime(args) {
  const planPath = path.resolve(args.plan);
  const plan = loadPlan(planPath);
  const runtime = buildInitialRuntime(plan, args.runId, displayPath(planPath));
  const payload = `${JSON.stringify(runtime, null, 2)}\n`;
  if (args.output) {
    const outputPath = writeJson(args.output, runtime);
    console.log('Plan2Agent orchestration runtime initialized');
    console.log(`- runtimeId: ${runtime.runtimeId}`);
    console.log(`- runId: ${runtime.runId}`);
    console.log(`- task: ${runtime.taskId} - ${runtime.taskTitle}`);
    console.log(`- phase: ${runtime.status.phase}`);
    console.log(`- events: ${runtime.communicationLog.length}`);
    console.log(`- written: ${displayPath(outputPath)}`);
    if (args.json) process.stdout.write(payload);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

function runRecord(args) {
  const runtimePath = path.resolve(args.runtime);
  const { runtime: updatedRuntime, event } = recordOrchestrationRuntimeEvent(runtimePath, {
    roleId: args.roleId,
    eventType: args.eventType,
    summary: args.summary,
    detail: args.detail,
    linkedRoleId: args.linkedRoleId,
    roleStatus: args.roleStatus,
    phase: args.phase,
    requiresOwnerAction: args.requiresOwnerAction,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(updatedRuntime, null, 2)}\n`);
    return 0;
  }
  console.log('Plan2Agent orchestration runtime event recorded');
  console.log(`- runtimeId: ${updatedRuntime.runtimeId}`);
  console.log(`- event: ${event.eventId} ${event.type}`);
  console.log(`- role: ${event.roleId}`);
  console.log(`- phase: ${updatedRuntime.status.phase}`);
  console.log(`- needsUserDecision: ${updatedRuntime.status.needsUserDecision}`);
  console.log(`- runtime: ${displayPath(runtimePath)}`);
  return 0;
}

function runRuntimeStatus(args) {
  const runtime = readOrchestrationRuntime(path.resolve(args.runtime));
  if (args.json) {
    process.stdout.write(`${JSON.stringify(runtime, null, 2)}\n`);
    return 0;
  }
  const lastEvent = runtime.communicationLog.at(-1);
  console.log('Plan2Agent orchestration runtime status');
  console.log(`- runtimeId: ${runtime.runtimeId}`);
  console.log(`- runId: ${runtime.runId}`);
  console.log(`- task: ${runtime.taskId} - ${runtime.taskTitle}`);
  console.log(`- mode: ${runtime.mode}`);
  console.log(`- phase: ${runtime.status.phase}`);
  console.log(`- blocked: ${runtime.status.blocked}`);
  console.log(`- needsUserDecision: ${runtime.status.needsUserDecision}`);
  console.log(`- roles: ${runtime.sharedMentalModel.roleAssignments.map((role) => `${role.roleId}:${role.status}`).join(', ')}`);
  console.log(`- events: ${runtime.communicationLog.length}`);
  if (lastEvent) console.log(`- lastEvent: ${lastEvent.eventId} ${lastEvent.type} ${lastEvent.roleId} - ${lastEvent.summary}`);
  return 0;
}

function runNextRole(args) {
  const runtime = readOrchestrationRuntime(path.resolve(args.runtime));
  const hint = schedulerHint(runtime);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(hint, null, 2)}\n`);
    return 0;
  }
  console.log('Plan2Agent supervised scheduler hint');
  console.log(`- runtimeId: ${hint.runtimeId}`);
  console.log(`- runId: ${hint.runId}`);
  console.log(`- task: ${hint.taskId}`);
  console.log(`- phase: ${hint.phase}`);
  console.log(`- supervisedOnly: ${hint.supervisedOnly}`);
  console.log(`- startsProcess: ${hint.startsProcess}`);
  if (hint.nextRole) {
    console.log(`- nextRole: ${hint.nextRole.roleId} (${hint.nextRole.role}, ${hint.nextRole.agentTool}, ${hint.nextRole.profile}, ${hint.nextRole.status})`);
    console.log(`- command: ${hint.nextRole.command ?? 'manual'}`);
  } else {
    console.log('- nextRole: none');
  }
  console.log(`- reason: ${hint.reason}`);
  console.log(`- instruction: ${hint.instruction}`);
  if (hint.resolutionHints.length) {
    console.log(`- nextActions: ${hint.resolutionHints.join(' | ')}`);
  }
  console.log(`- safety: ${hint.safetyBoundary}`);
  return 0;
}

function runFailurePolicy(args) {
  const payload = failurePolicyPayload(args.runtime);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  console.log('Plan2Agent supervised failure policy');
  console.log(`- runtimeId: ${payload.runtimeId}`);
  console.log(`- runId: ${payload.runId}`);
  console.log(`- task: ${payload.taskId}`);
  console.log(`- mode: ${payload.mode}`);
  console.log(`- phase: ${payload.phase}`);
  console.log(`- action: ${payload.action}`);
  console.log(`- failure: ${payload.failure.class ?? 'none'} retryable=${payload.failure.retryable} needsUserDecision=${payload.failure.needsUserDecision}`);
  console.log(`- signal: ${payload.source.signal} ${payload.source.evidence}`);
  console.log(`- run: ${payload.source.runPresent ? `${payload.source.runStatus} ${payload.source.runPath}` : `not found ${payload.source.runPath}`}`);
  console.log(`- supervisedOnly: ${payload.supervisedOnly}`);
  console.log(`- startsProcess: ${payload.startsProcess}`);
  console.log('- instructions:');
  payload.instructions.forEach((instruction) => console.log(`  - ${instruction}`));
  console.log(`- safety: ${payload.safetyBoundary}`);
  return 0;
}

function runRolePrompt(args) {
  const runtime = readOrchestrationRuntime(path.resolve(args.runtime));
  const role = requireRuntimeRole(runtime, args.roleId);
  const payload = rolePromptPayload(runtime, role);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  console.log('Plan2Agent supervised role prompt');
  console.log(`- runtimeId: ${payload.runtimeId}`);
  console.log(`- runId: ${payload.runId}`);
  console.log(`- role: ${payload.role.roleId} (${payload.role.agentTool}, ${payload.role.profile})`);
  console.log(`- command: ${payload.role.command ?? 'manual'}`);
  console.log('- supervisedOnly: true');
  console.log('- startsProcess: false');
  console.log('');
  console.log(payload.prompt);
  return 0;
}

function runMarkRole(args) {
  const runtimePath = path.resolve(args.runtime);
  const runtime = readOrchestrationRuntime(runtimePath);
  const role = requireRuntimeRole(runtime, args.roleId);
  const needsMonitorVerdict = role.roleId === 'monitor' && args.roleStatus === 'complete';
  const defaults = markRoleDefaults(runtime, role, args.roleStatus, {
    verdict: args.verdict,
    acceptedMonitorVerdicts: needsMonitorVerdict
      ? acceptedMonitorVerdictsForRuntime(runtimePath, runtime)
      : DEFAULT_ACCEPTED_MONITOR_VERDICTS,
  });
  const { runtime: updatedRuntime, event } = recordOrchestrationRuntimeEvent(runtimePath, {
    roleId: args.roleId,
    eventType: defaults.eventType,
    summary: args.summary ?? defaults.summary,
    detail: args.detail ?? defaults.detail,
    roleStatus: args.roleStatus,
    phase: args.phase ?? defaults.phase,
    requiresOwnerAction: args.requiresOwnerAction || defaults.requiresOwnerAction,
  });
  const hint = schedulerHint(updatedRuntime);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ runtime: updatedRuntime, event, next: hint }, null, 2)}\n`);
    return 0;
  }
  console.log('Plan2Agent supervised role state recorded');
  console.log(`- runtimeId: ${updatedRuntime.runtimeId}`);
  console.log(`- event: ${event.eventId} ${event.type}`);
  console.log(`- role: ${args.roleId} -> ${args.roleStatus}`);
  console.log(`- phase: ${updatedRuntime.status.phase}`);
  if (hint.nextRole) {
    console.log(`- nextRole: ${hint.nextRole.roleId} (${hint.nextRole.agentTool}, ${hint.nextRole.profile})`);
    console.log(`- nextCommand: ${hint.nextRole.command ?? 'manual'}`);
  } else {
    console.log('- nextRole: none');
  }
  if (hint.resolutionHints.length) {
    console.log(`- nextActions: ${hint.resolutionHints.join(' | ')}`);
  }
  console.log('- startsProcess: false');
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'plan') return runPlan(args);
    if (args.command === 'show') return runShow(args);
    if (args.command === 'validate') return runValidate(args);
    if (args.command === 'handoff') return runHandoff(args);
    if (args.command === 'runner-guide') return runRunnerGuide(args);
    if (args.command === 'runner-doctor') return runRunnerDoctor(args);
    if (args.command === 'init-runtime') return runInitRuntime(args);
    if (args.command === 'record') return runRecord(args);
    if (args.command === 'runtime-status') return runRuntimeStatus(args);
    if (args.command === 'next-role') return runNextRole(args);
    if (args.command === 'failure-policy') return runFailurePolicy(args);
    if (args.command === 'role-prompt') return runRolePrompt(args);
    if (args.command === 'mark-role') return runMarkRole(args);
    throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'p2a orchestrate validation failed' : 'p2a orchestrate command failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(P2A_PATHS.filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
