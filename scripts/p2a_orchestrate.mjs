#!/usr/bin/env node
/** Build supervised orchestration plans for one ready Plan2Agent task. */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadJson, validateOrchestrationPlanData, validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';
import { resolveIterationState } from './p2a_iteration_state.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const COMMANDS = new Set(['plan', 'show', 'validate', 'handoff']);
const AGENT_TOOLS = new Set(['codex', 'claude', 'gemini', 'manual']);
const DEFAULT_HANDOFF_GRAPH = path.join('.plan2agent', 'artifacts', 'task-graph.json');

function usage() {
  return [
    'Usage:',
    '  node scripts/p2a_orchestrate.mjs plan (--artifacts <dir>|--graph <path>) [--task <task-id>] [--output <path>] [options]',
    '  node scripts/p2a_orchestrate.mjs show --plan <path>',
    '  node scripts/p2a_orchestrate.mjs validate --plan <path>',
    '  node scripts/p2a_orchestrate.mjs handoff --plan <path>',
    '',
    'Commands:',
    '  plan                 Create a deterministic supervised orchestration plan. No task/run files are changed.',
    '  show                 Print a compact plan summary.',
    '  validate             Validate an orchestration plan JSON file.',
    '  handoff              Print the owner start command and role prompts for the plan.',
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
  } else {
    if (!args.plan) throw new Error(`--plan is required for ${args.command}`);
    if (args.artifacts || args.graph || args.spec || args.maintenance || args.taskId || args.output) {
      throw new Error(`${args.command} only supports --plan and --json`);
    }
  }
  return args;
}

function parseAgentTool(value, optionName) {
  if (!AGENT_TOOLS.has(value)) throw new Error(`${optionName} must be one of ${[...AGENT_TOOLS].join(', ')}`);
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
  if (/[,+/]| and |&/i.test(targetArea)) flags.push('multi_area');
  if (task.acceptanceCriteria.length >= 4) flags.push('high_acceptance_count');
  if (task.dependencies.length >= 2) flags.push('dependency_heavy');
  if (flags.length) flags.push('monitor_required');
  if (flags.includes('multi_area') || flags.includes('high_acceptance_count')) flags.push('reviewer_recommended', 'read_only_reviewer');
  return [...new Set(flags)];
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
      verdictPath: monitorRequired ? 'runs/{runId}.monitor-verdict.json' : null,
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
