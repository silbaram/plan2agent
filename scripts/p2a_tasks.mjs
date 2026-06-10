#!/usr/bin/env node
/** Manage Plan2Agent task graph status and dependency workflow. */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { validateTaskGraphData, ValidationError } from './validate_artifacts.mjs';

const VALID_TRANSITIONS = new Set(['start', 'done', 'block', 'todo']);

function usage() {
  return [
    'Usage: node scripts/p2a_tasks.mjs <command> --graph <path> [task-id]',
    '',
    'Commands:',
    '  list                 Show all tasks with readiness.',
    '  ready                Show ready todo tasks.',
    '  show <task-id>       Show the full task JSON.',
    '  prompt <task-id>     Print suggestedAgentPrompt plus acceptance criteria.',
    '  start <task-id>      Mark a ready todo task in_progress.',
    '  done <task-id>       Mark an in_progress task done.',
    '  block <task-id>      Mark a task blocked.',
    '  todo <task-id>       Mark a task todo.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  let graphPath = null;
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--graph') {
      graphPath = rest[++index];
      if (!graphPath) throw new Error('--graph requires a path');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (!graphPath) throw new Error('--graph is required');
  return { command, graphPath, taskId: positional[0], extra: positional.slice(1) };
}

function loadGraph(graphPath) {
  return JSON.parse(readFileSync(graphPath, 'utf8'));
}

function taskMap(graph) {
  return new Map(graph.tasks.map((task) => [task.id, task]));
}

function isReady(task, tasksById) {
  return task.status === 'todo' && task.dependencies.every((dependency) => tasksById.get(dependency)?.status === 'done');
}

function requireTask(graph, taskId) {
  if (!taskId) throw new Error('task-id is required for this command');
  const task = taskMap(graph).get(taskId);
  if (!task) throw new Error(`unknown task id: ${taskId}`);
  return task;
}

function printTaskTable(tasks, tasksById) {
  console.log('id\ttitle\tstatus\tdependencies\tready');
  for (const task of tasks) {
    console.log(`${task.id}\t${task.title}\t${task.status}\t${task.dependencies.join(',') || '-'}\t${isReady(task, tasksById) ? 'yes' : 'no'}`);
  }
}

function printPrompt(task) {
  console.log(task.suggestedAgentPrompt.trimEnd());
  console.log('');
  console.log('Acceptance criteria:');
  for (const criterion of task.acceptanceCriteria) console.log(`- ${criterion}`);
}

function transitionTask(graph, task, command) {
  const tasksById = taskMap(graph);
  if (command === 'start') {
    if (task.status !== 'todo') throw new Error(`${task.id} must be todo before start; current status is ${task.status}`);
    const incomplete = task.dependencies.filter((dependency) => tasksById.get(dependency)?.status !== 'done');
    if (incomplete.length) throw new Error(`${task.id} cannot start until dependencies are done: ${incomplete.join(', ')}`);
    task.status = 'in_progress';
  } else if (command === 'done') {
    if (task.status !== 'in_progress') throw new Error(`${task.id} must be in_progress before done; current status is ${task.status}`);
    task.status = 'done';
  } else if (command === 'block') {
    task.status = 'blocked';
  } else if (command === 'todo') {
    task.status = 'todo';
  }
}

function saveValidatedGraph(graphPath, graph) {
  validateTaskGraphData(graph);
  writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.extra?.length) throw new Error(`unexpected extra argument(s): ${args.extra.join(', ')}`);

    const graph = loadGraph(args.graphPath);
    validateTaskGraphData(graph);
    const tasksById = taskMap(graph);

    if (args.command === 'list') {
      printTaskTable(graph.tasks, tasksById);
    } else if (args.command === 'ready') {
      printTaskTable(graph.tasks.filter((task) => isReady(task, tasksById)), tasksById);
    } else if (args.command === 'show') {
      console.log(JSON.stringify(requireTask(graph, args.taskId), null, 2));
    } else if (args.command === 'prompt') {
      printPrompt(requireTask(graph, args.taskId));
    } else if (VALID_TRANSITIONS.has(args.command)) {
      const task = requireTask(graph, args.taskId);
      transitionTask(graph, task, args.command);
      saveValidatedGraph(args.graphPath, graph);
      console.log(`${task.id} status is now ${task.status}`);
    } else {
      throw new Error(`unknown command: ${args.command}`);
    }
  } catch (error) {
    const prefix = error instanceof ValidationError ? 'task graph validation failed' : 'p2a task command failed';
    console.error(`${prefix}: ${error.message}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
