/** Shared copy-paste command builders for Plan2Agent run lifecycle output. */

import { nodeScriptCommand, scriptCommandPath } from './p2a_paths.mjs';

const TOP_LEVEL_COMMANDS = new Map([
  ['p2a_iteration.mjs', 'iteration'],
  ['p2a_execute.mjs', 'execute'],
  ['p2a_tasks.mjs', 'tasks'],
  ['p2a_runs.mjs', 'runs'],
  ['p2a_proposals.mjs', 'proposals'],
]);

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function commandLine(paths, scriptName, args) {
  const topLevelCommand = TOP_LEVEL_COMMANDS.get(scriptName);
  if (topLevelCommand) {
    return ['node', scriptCommandPath(paths, 'p2a.mjs'), topLevelCommand, ...args].map(shellQuote).join(' ');
  }
  return nodeScriptCommand(paths, scriptName, args).map(shellQuote).join(' ');
}

function proposalsSourceArgs(sourceArgs, fallbackArgs = null) {
  if (!sourceArgs?.length) return fallbackArgs;
  const artifactsIndex = sourceArgs.indexOf('--artifacts');
  if (artifactsIndex !== -1 && sourceArgs[artifactsIndex + 1]) {
    return ['--artifacts', sourceArgs[artifactsIndex + 1]];
  }
  const graphIndex = sourceArgs.indexOf('--graph');
  if (graphIndex !== -1 && sourceArgs[graphIndex + 1]) {
    return ['--graph', sourceArgs[graphIndex + 1]];
  }
  return fallbackArgs;
}

export function buildRunFollowUpCommands(paths, options) {
  const {
    sourceArgs = null,
    runSourceArgs = sourceArgs,
    proposalSourceArgs = proposalsSourceArgs(sourceArgs, runSourceArgs),
    runId,
    includeResume = true,
    includeFinish = true,
    includeReview = true,
  } = options;
  const commands = [];
  const canExecute = Array.isArray(sourceArgs) && sourceArgs.length > 0;
  const runArgs = Array.isArray(runSourceArgs) && runSourceArgs.length > 0 ? runSourceArgs : null;
  if (canExecute) {
    if (includeResume) {
      commands.push({
        id: 'resume',
        label: 'resume',
        command: commandLine(paths, 'p2a_execute.mjs', ['resume', ...sourceArgs, '--run-id', runId]),
      });
    }
    commands.push({
      id: 'status',
      label: 'status',
      command: commandLine(paths, 'p2a_execute.mjs', ['status', ...sourceArgs, '--run-id', runId]),
    });
    if (includeFinish) {
      commands.push({
        id: 'finish',
        label: 'finish',
        command: commandLine(paths, 'p2a_execute.mjs', ['finish', ...sourceArgs, '--run-id', runId, '--test', '--lint', '--typecheck']),
      });
    }
  } else if (runArgs) {
    if (includeResume) {
      commands.push({
        id: 'resume',
        label: 'resume',
        command: commandLine(paths, 'p2a_runs.mjs', ['show', ...runArgs, '--run-id', runId]),
      });
    }
    commands.push({
      id: 'status',
      label: 'status',
      command: commandLine(paths, 'p2a_runs.mjs', ['show', ...runArgs, '--run-id', runId]),
    });
    if (includeFinish) {
      commands.push({
        id: 'finish',
        label: 'finish',
        command: commandLine(paths, 'p2a_runs.mjs', ['finish', ...runArgs, '--run-id', runId]),
      });
    }
  }
  if (includeReview && Array.isArray(proposalSourceArgs) && proposalSourceArgs.length > 0) {
    commands.push({
      id: 'review',
      label: 'review',
      command: commandLine(paths, 'p2a_proposals.mjs', ['mine', ...proposalSourceArgs, '--run-id', runId]),
    });
  }
  return commands;
}

export function printRunCommandFooter(paths, options) {
  const commands = buildRunFollowUpCommands(paths, options);
  if (!commands.length) return;
  console.log('');
  console.log(options.heading ?? 'Run commands:');
  for (const item of commands) {
    console.log(`- ${item.label}: ${item.command}`);
  }
}
