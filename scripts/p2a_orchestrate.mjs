#!/usr/bin/env node
/** Build supervised orchestration plans for one ready Plan2Agent task. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadJson, validateOrchestrationPlanData, validateOrchestrationRuntimeData, validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const COMMANDS = new Set(['plan', 'show', 'validate', 'handoff', 'init-runtime', 'record', 'runtime-status', 'next-role', 'role-prompt', 'mark-role']);
const AGENT_TOOLS = new Set(['codex', 'claude', 'gemini', 'manual']);
const RUNTIME_EVENT_TYPES = new Set(['handoff', 'status', 'question', 'answer', 'ack', 'concern', 'decision', 'blocker', 'verification', 'monitor_verdict', 'owner_note']);
const RUNTIME_ROLE_STATUSES = new Set(['pending', 'active', 'blocked', 'complete', 'skipped']);
const RUNTIME_PHASES = new Set(['initialized', 'running', 'blocked', 'ready_for_monitor', 'ready_to_finish', 'closed']);
const DEFAULT_HANDOFF_GRAPH = path.join('.plan2agent', 'artifacts', 'task-graph.json');
const HIGH_ACCEPTANCE_MONITOR_THRESHOLD = 6;

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_orchestrate.mjs plan (--artifacts <dir>|--graph <path>) [--task <task-id>] [--output <path>] [options]',
    '  node scripts/p2a_orchestrate.mjs show --plan <path>',
    '  node scripts/p2a_orchestrate.mjs validate --plan <path>',
    '  node scripts/p2a_orchestrate.mjs handoff --plan <path>',
    '  node scripts/p2a_orchestrate.mjs init-runtime --plan <path> --run-id <run-id> [--output <path>] [--json]',
    '  node scripts/p2a_orchestrate.mjs record --runtime <path> --role <role-id> --type <type> --summary <text> [options]',
    '  node scripts/p2a_orchestrate.mjs runtime-status --runtime <path> [--json]',
    '  node scripts/p2a_orchestrate.mjs next-role --runtime <path> [--json]',
    '  node scripts/p2a_orchestrate.mjs role-prompt --runtime <path> --role <role-id> [--json]',
    '  node scripts/p2a_orchestrate.mjs mark-role --runtime <path> --role <role-id> --role-status <status> [options]',
    '',
    'Commands:',
    '  plan                 Create a deterministic supervised orchestration plan. No task/run files are changed.',
    '  show                 Print a compact plan summary.',
    '  validate             Validate an orchestration plan JSON file.',
    '  handoff              Print the owner start command and role prompts for the plan.',
    '  init-runtime         Create the run-level shared mental model and communication log sidecar.',
    '  record               Append one runtime communication event.',
    '  runtime-status       Print the runtime phase, role status, and latest communication event.',
    '  next-role            Compute the next supervised role. Does not start any agent or CLI process.',
    '  role-prompt          Print the prompt for a role so a human can paste it into an official CLI/app.',
    '  mark-role            Record a human-observed role state transition.',
    '',
    'Source options:',
    '  --artifacts <dir>    Iterative artifact root; uses the active iteration task graph.',
    '  --graph <path>       Task graph JSON path. Defaults to .plan2agent/artifacts/task-graph.json if present.',
    '  --spec <path>        Spec JSON path for prompt context. Only supported with --graph.',
    '  --maintenance        With --artifacts, use the maintenance task graph.',
    '',
    'Plan options:',
    '  --task <task-id>         Task to plan. If omitted, there must be exactly one ready task.',
    '  --agent-tool <tool>      Implementer tool label: codex, claude, gemini, or manual. Default: codex.',
    '  --reviewer-tool <tool>   Read-only reviewer/monitor tool label. Default: gemini.',
    '  --output <path>          Write plan JSON to a file. Without this, JSON is printed to stdout.',
    '  --json                   With --output, also print the JSON payload.',
    '',
    'Runtime options:',
    '  --run-id <run-id>         Run id for init-runtime.',
    '  --runtime <path>          Runtime sidecar path for record/status.',
    '  --role <role-id>          Role assignment that writes the record event.',
    `  --type <type>             Event type: ${[...RUNTIME_EVENT_TYPES].join(', ')}.`,
    '  --summary <text>          Event summary.',
    '  --detail <text>           Optional event detail.',
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

  const args = {
    command,
    artifacts: null,
    graph: null,
    spec: null,
    maintenance: false,
    taskId: null,
    agentTool: 'codex',
    reviewerTool: 'gemini',
    output: null,
    plan: null,
    runtime: null,
    runId: null,
    roleId: null,
    eventType: null,
    summary: null,
    detail: null,
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
    else if (arg === '--agent-tool') args.agentTool = parseAgentTool(requiredValue(argv, ++index, '--agent-tool'), '--agent-tool');
    else if (arg === '--reviewer-tool') args.reviewerTool = parseAgentTool(requiredValue(argv, ++index, '--reviewer-tool'), '--reviewer-tool');
    else if (arg === '--output') args.output = requiredValue(argv, ++index, '--output');
    else if (arg === '--plan') args.plan = requiredValue(argv, ++index, '--plan');
    else if (arg === '--runtime') args.runtime = requiredValue(argv, ++index, '--runtime');
    else if (arg === '--run-id') args.runId = requiredValue(argv, ++index, '--run-id');
    else if (arg === '--role') args.roleId = requiredValue(argv, ++index, '--role');
    else if (arg === '--type') args.eventType = parseEnumValue(requiredValue(argv, ++index, '--type'), RUNTIME_EVENT_TYPES, '--type');
    else if (arg === '--summary') args.summary = requiredValue(argv, ++index, '--summary');
    else if (arg === '--detail') args.detail = requiredValue(argv, ++index, '--detail');
    else if (arg === '--linked-role') args.linkedRoleId = requiredValue(argv, ++index, '--linked-role');
    else if (arg === '--role-status') args.roleStatus = parseEnumValue(requiredValue(argv, ++index, '--role-status'), RUNTIME_ROLE_STATUSES, '--role-status');
    else if (arg === '--phase') args.phase = parseEnumValue(requiredValue(argv, ++index, '--phase'), RUNTIME_PHASES, '--phase');
    else if (arg === '--requires-owner-action') args.requiresOwnerAction = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  if (args.command === 'plan') {
    const sourceCount = [args.artifacts, args.graph].filter(Boolean).length;
    if (sourceCount > 1) throw new Error('--artifacts and --graph cannot be used together');
    if (sourceCount === 0) {
      if (existsSync(DEFAULT_HANDOFF_GRAPH)) args.graph = DEFAULT_HANDOFF_GRAPH;
      else throw new Error('--artifacts or --graph is required');
    }
    if (args.spec && args.artifacts) throw new Error('--spec is only supported with --graph; --artifacts uses the active iteration spec');
    if (args.maintenance && !args.artifacts) throw new Error('--maintenance is only supported with --artifacts');
    if (args.plan || args.runtime || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('runtime/show options are not supported with plan');
    }
  } else if (['show', 'validate', 'handoff'].includes(args.command)) {
    if (!args.plan) throw new Error(`--plan is required for ${args.command}`);
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.runtime || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error(`${args.command} only supports --plan and --json`);
    }
  } else if (args.command === 'init-runtime') {
    if (!args.plan) throw new Error('--plan is required for init-runtime');
    if (!args.runId) throw new Error('--run-id is required for init-runtime');
    assertSafeRunId(args.runId);
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.runtime || args.roleId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('init-runtime only supports --plan, --run-id, --output, and --json');
    }
  } else if (args.command === 'record') {
    if (!args.runtime) throw new Error('--runtime is required for record');
    if (!args.roleId) throw new Error('--role is required for record');
    if (!args.eventType) throw new Error('--type is required for record');
    if (!args.summary) throw new Error('--summary is required for record');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runId) {
      throw new Error('record only supports --runtime, --role, --type, --summary, --detail, --linked-role, --role-status, --phase, --requires-owner-action, and --json');
    }
  } else if (args.command === 'runtime-status') {
    if (!args.runtime) throw new Error('--runtime is required for runtime-status');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('runtime-status only supports --runtime and --json');
    }
  } else if (args.command === 'next-role') {
    if (!args.runtime) throw new Error('--runtime is required for next-role');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runId || args.roleId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('next-role only supports --runtime and --json');
    }
  } else if (args.command === 'role-prompt') {
    if (!args.runtime) throw new Error('--runtime is required for role-prompt');
    if (!args.roleId) throw new Error('--role is required for role-prompt');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runId || args.eventType || args.summary || args.detail || args.linkedRoleId || args.roleStatus || args.phase || args.requiresOwnerAction) {
      throw new Error('role-prompt only supports --runtime, --role, and --json');
    }
  } else if (args.command === 'mark-role') {
    if (!args.runtime) throw new Error('--runtime is required for mark-role');
    if (!args.roleId) throw new Error('--role is required for mark-role');
    if (!args.roleStatus) throw new Error('--role-status is required for mark-role');
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output || args.plan || args.runId || args.eventType || args.linkedRoleId) {
      throw new Error('mark-role only supports --runtime, --role, --role-status, --summary, --detail, --phase, --requires-owner-action, and --json');
    }
  }
  return args;
}

function parseAgentTool(value, optionName) {
  if (!AGENT_TOOLS.has(value)) throw new Error(`${optionName} must be one of ${[...AGENT_TOOLS].join(', ')}`);
  return value;
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
    sourceLayout: path.resolve(graphPath) === path.resolve(DEFAULT_HANDOFF_GRAPH) ? 'handoff' : 'graph',
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

function buildPlan(args, source, task, now = new Date()) {
  const riskFlags = buildRiskFlags(task);
  const mode = modeForRiskFlags(riskFlags);
  const monitorRequired = mode !== 'solo';
  const roles = [
    {
      roleId: 'owner',
      role: 'lead',
      agentTool: 'manual',
      scope: 'Own the run lifecycle, approvals, verification recording, and final task state transition.',
      prompt: `Supervise ${task.id}, start the run with p2a_execute, and only finish after verification and monitor gate policy are satisfied.`,
      requiresWrite: false,
    },
    {
      roleId: 'implementer',
      role: 'contributor',
      agentTool: args.agentTool,
      scope: 'Implement the approved ready task in the selected workspace or isolated worktree.',
      prompt: buildTaskPrompt(task),
      requiresWrite: args.agentTool !== 'manual',
    },
  ];
  if (mode === 'team') {
    roles.push({
      roleId: 'reviewer',
      role: 'reviewer',
      agentTool: args.reviewerTool,
      scope: 'Read-only review of implementation scope, acceptance coverage, and verification evidence.',
      prompt: buildMonitorPrompt(task),
      requiresWrite: false,
    });
  }
  if (monitorRequired) {
    roles.push({
      roleId: 'monitor',
      role: 'monitor',
      agentTool: 'manual',
      scope: 'Owner-visible monitor gate that decides whether the run can close as done.',
      prompt: buildMonitorPrompt(task),
      requiresWrite: false,
    });
  }

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
        ...plan.roles.map((role) => `${role.roleId}: ${role.scope}`),
      ],
      acceptanceCriteria: plan.acceptanceCriteria,
      roleAssignments: plan.roles.map((role) => ({
        roleId: role.roleId,
        role: role.role,
        agentTool: role.agentTool,
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
  runtime.updatedAt = createdAt;
  runtime.status.lastEventId = event.eventId;
  runtime.status.phase = args.phase ?? inferredRuntimePhase(runtime.status.phase, args.eventType);
  runtime.status.blocked = runtime.status.blocked || runtime.status.phase === 'blocked' || args.eventType === 'blocker' || args.roleStatus === 'blocked';
  runtime.status.needsUserDecision = runtime.status.needsUserDecision || event.requiresOwnerAction;
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
          agentTool: decision.role.agentTool,
          status: decision.role.status,
          command: decision.role.agentTool === 'manual' ? null : decision.role.agentTool,
        }
      : null,
    reason: decision.reason,
    instruction: decision.instruction,
    safetyBoundary: 'Open the official CLI/app manually, paste the role prompt, then record the observed result. Do not use this scheduler to bypass subscription limits or run background automation.',
  };
}

function handoffEventForRole(runtime, roleId) {
  return [...runtime.communicationLog].reverse().find((event) => event.type === 'handoff' && event.roleId === roleId) ?? null;
}

function recentRuntimeEvents(runtime, limit = 5) {
  return runtime.communicationLog.slice(-limit);
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
    `Status: ${role.status}`,
    '',
    'Supervision boundary:',
    '- A human must open the official CLI/app and paste this prompt manually.',
    '- Do not run background loops, browser automation, unofficial APIs, token reuse, or quota/rate-limit bypass.',
    '- Report results back to the owner, then record them with p2a_orchestrate mark-role or record.',
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
      agentTool: role.agentTool,
      status: role.status,
      command: role.agentTool === 'manual' ? null : role.agentTool,
    },
    supervisedOnly: true,
    startsProcess: false,
    prompt: buildSupervisedRolePrompt(runtime, role),
  };
}

function markRoleDefaults(runtime, role, status) {
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
      return {
        eventType: 'monitor_verdict',
        phase: 'ready_to_finish',
        requiresOwnerAction: false,
        summary: `${role.roleId} completed supervised monitor check`,
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
  return ['node', `scripts/${scriptName}`, ...args].map(shellQuote).join(' ');
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
  console.log(`- monitorGate: ${plan.monitorGate.required ? plan.monitorGate.verdictPath : 'not required'}`);
  console.log(`- roles: ${plan.roles.map((role) => `${role.roleId}:${role.agentTool}`).join(', ')}`);
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
    console.log(`- nextRole: ${hint.nextRole.roleId} (${hint.nextRole.role}, ${hint.nextRole.agentTool}, ${hint.nextRole.status})`);
    console.log(`- command: ${hint.nextRole.command ?? 'manual'}`);
  } else {
    console.log('- nextRole: none');
  }
  console.log(`- reason: ${hint.reason}`);
  console.log(`- instruction: ${hint.instruction}`);
  console.log(`- safety: ${hint.safetyBoundary}`);
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
  console.log(`- role: ${payload.role.roleId} (${payload.role.agentTool})`);
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
  const defaults = markRoleDefaults(runtime, role, args.roleStatus);
  const { runtime: updatedRuntime, event } = recordOrchestrationRuntimeEvent(runtimePath, {
    roleId: args.roleId,
    eventType: defaults.eventType,
    summary: args.summary ?? defaults.summary,
    detail: args.detail,
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
    console.log(`- nextRole: ${hint.nextRole.roleId} (${hint.nextRole.agentTool})`);
    console.log(`- nextCommand: ${hint.nextRole.command ?? 'manual'}`);
  } else {
    console.log('- nextRole: none');
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
    if (args.command === 'init-runtime') return runInitRuntime(args);
    if (args.command === 'record') return runRecord(args);
    if (args.command === 'runtime-status') return runRuntimeStatus(args);
    if (args.command === 'next-role') return runNextRole(args);
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
    return realpathSync(__filename) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) {
  process.exitCode = main();
}
