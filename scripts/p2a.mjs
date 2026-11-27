#!/usr/bin/env node
/** Plan2Agent v1 CLI entrypoint — minimal task & session-resume harness. */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findProjectRoot, readConfig } from './p2a_config.mjs';
import {
  addTaskNote,
  addTaskToWork,
  approveWork,
  blockTask,
  completeTask,
  finishWork,
  readWork,
  startTask,
  unblockTask,
} from './p2a_work.mjs';
import { inspectGitWorkspace, runVerification } from './p2a_verify.mjs';
import { evaluateNext, formatNextHuman } from './p2a_next.mjs';
import { diagnoseProject, initProject, parseToolList } from './p2a_init.mjs';
import { runBuildLore } from './p2a_buildlore.mjs';

const PACKAGE_JSON = JSON.parse(readFileSync(
  fileURLToPath(new URL('../package.json', import.meta.url)),
  'utf8',
));

function usage() {
  return [
    `Plan2Agent (p2a) v${PACKAGE_JSON.version} — minimal task & session-resume harness`,
    '',
    'Usage:',
    '  p2a init [--target <dir>] [--tools codex,claude,gemini|all|none] [--project-id <id>] [--force] [--json]',
    '  p2a next [--target <dir>] [--idea "<text>" | --entry <path>] [--json]',
    '  p2a approve --quote "<user utterance>" [--target <dir>] [--json]',
    '  p2a task list [--target <dir>] [--json]',
    '  p2a task add --title "<text>" --accept "<criterion>" [--accept ...] [--id <id>] [--depends <id> ...] [--target <dir>] [--json]',
    '  p2a task start <id> [--summary "<text>"] [--allow-parallel] [--target <dir>] [--json]',
    '  p2a task note <id> [--note "<text>"] [--summary "<text>"] [--target <dir>] [--json]',
    '  p2a task block <id> --reason "<text>" [--summary "<text>"] [--target <dir>] [--json]',
    '  p2a task unblock <id> [--target <dir>] [--json]',
    '  p2a task done <id> [--summary "<text>"] [--target <dir>] [--json]',
    '  p2a verify [--task <id>] [--cmd "<command>"] [--target <dir>] [--json]',
    '  p2a done [--abort] [--target <dir>] [--json]',
    '  p2a validate [--target <dir>] [--json]',
    '  p2a doctor [--target <dir>] [--json]',
    '  p2a buildlore <status|memory|lookup|search|sync|handoff> [options]',
    '',
    'Global options:',
    '  --help, -h     Show this help.',
    '  --version, -v  Show installed version.',
  ].join('\n');
}

function resolveTarget(value) {
  return path.resolve(value ?? findProjectRoot());
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      tools: { type: 'string' },
      'project-id': { type: 'string' },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = path.resolve(values.target ?? process.cwd());
  const tools = values.tools !== undefined ? parseToolList(values.tools) : null;
  const result = initProject(targetRoot, {
    tools,
    projectId: values['project-id'] ?? null,
    force: values.force,
  });
  if (values.json) {
    printJson(result);
  } else {
    console.log(`Initialized Plan2Agent in ${result.targetRoot}`);
    console.log(`project_id: ${result.config.project_id}`);
    console.log(`verify.test: ${result.config.verify.test ?? '(none)'}`);
    console.log(`files (${result.installedFiles.length}): ${result.installedFiles.join(', ')}`);
  }
  return 0;
}

function cmdNext(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      idea: { type: 'string' },
      entry: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  if (values.idea !== undefined && !values.idea.trim()) {
    throw new Error('--idea requires a non-empty description');
  }
  if (values.entry !== undefined && !values.entry.trim()) {
    throw new Error('--entry requires a non-empty file path');
  }
  if (values.idea && values.entry) {
    throw new Error('pass either --idea or --entry, not both');
  }
  const targetRoot = resolveTarget(values.target);
  const result = evaluateNext(targetRoot, {
    idea: values.idea ?? null,
    entry: values.entry ?? null,
  });
  if (values.json) printJson(result);
  else console.log(formatNextHuman(result));
  return 0;
}

function cmdApprove(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      quote: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const work = approveWork(targetRoot, values.quote);
  if (values.json) printJson(work);
  else console.log(`Approved ${work.id} (${work.tasks.length} task(s)). Next: run \`p2a next\`.`);
  return 0;
}

function cmdTask(argv) {
  const subcommand = argv[0];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return 0;
  }
  const rest = argv.slice(1);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      target: { type: 'string' },
      id: { type: 'string' },
      title: { type: 'string' },
      accept: { type: 'string', multiple: true },
      depends: { type: 'string', multiple: true },
      summary: { type: 'string' },
      note: { type: 'string' },
      reason: { type: 'string' },
      'allow-parallel': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const taskId = values.id ?? positionals[0] ?? null;

  if (subcommand === 'list') {
    const work = readWork(targetRoot);
    if (!work) throw new Error('no active .plan2agent/work.json');
    if (values.json) {
      printJson({ id: work.id, goal: work.goal, status: work.status, tasks: work.tasks, resume: work.resume });
    } else {
      console.log(`${work.id}: ${work.goal} [${work.status}]`);
      for (const t of work.tasks) {
        const ver = t.verification ? ` (verify: ${t.verification.status})` : '';
        console.log(`- [${t.status}] ${t.id}: ${t.title}${ver}`);
      }
      if (work.resume.summary) console.log(`Resume: ${work.resume.summary}`);
    }
    return 0;
  }

  if (subcommand === 'add') {
    if (!values.title?.trim()) throw new Error('task add requires --title "<text>"');
    const acceptance = (values.accept ?? []).map((s) => s.trim()).filter(Boolean);
    if (!acceptance.length) throw new Error('task add requires at least one --accept "<criterion>"');
    const depends = (values.depends ?? [])
      .flatMap((entry) => entry.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    const work = addTaskToWork(targetRoot, {
      id: taskId ?? undefined,
      title: values.title.trim(),
      acceptance,
      depends_on: depends,
    });
    if (values.json) printJson(work);
    else console.log(`Added task ${work.tasks.at(-1).id}: ${work.tasks.at(-1).title}`);
    return 0;
  }

  if (!taskId) throw new Error(`task ${subcommand} requires a task id`);

  if (subcommand === 'start') {
    const work = startTask(targetRoot, taskId, {
      summary: values.summary ?? null,
      allowParallel: values['allow-parallel'],
    });
    if (values.json) printJson(work);
    else console.log(`Started ${taskId}`);
    return 0;
  }

  if (subcommand === 'note') {
    const work = addTaskNote(targetRoot, taskId, {
      note: values.note ?? null,
      summary: values.summary ?? null,
    });
    if (values.json) printJson(work);
    else console.log(`Updated notes/resume for ${taskId}`);
    return 0;
  }

  if (subcommand === 'block') {
    const work = blockTask(targetRoot, taskId, {
      reason: values.reason,
      summary: values.summary ?? null,
    });
    if (values.json) printJson(work);
    else console.log(`Blocked ${taskId}: ${values.reason}`);
    return 0;
  }

  if (subcommand === 'unblock') {
    const work = unblockTask(targetRoot, taskId);
    if (values.json) printJson(work);
    else console.log(`Unblocked ${taskId} (now todo)`);
    return 0;
  }

  if (subcommand === 'done') {
    const git = inspectGitWorkspace(targetRoot);
    const work = completeTask(targetRoot, taskId, {
      summary: values.summary ?? null,
      currentFingerprint: git.worktreeFingerprint,
    });
    if (values.json) printJson(work);
    else console.log(`Completed ${taskId}`);
    return 0;
  }

  throw new Error(`unknown task subcommand: ${subcommand}`);
}

function cmdVerify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      task: { type: 'string' },
      cmd: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const result = runVerification(targetRoot, {
    taskId: values.task ?? null,
    cmd: values.cmd ?? null,
  });
  if (values.json) {
    printJson(result);
  } else {
    console.log(`Verification ${result.verification.status} for ${result.taskId} (exit ${result.verification.exit_code ?? 'error'}, ${result.verification.duration_ms}ms)`);
    if (!result.ok && result.verification.output_tail) {
      console.error(result.verification.output_tail);
    }
  }
  return result.ok ? 0 : 1;
}

function cmdDone(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      abort: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const git = values.abort ? null : inspectGitWorkspace(targetRoot);
  const finished = finishWork(targetRoot, { abort: values.abort, git });
  if (values.json) {
    printJson({ cleared: true, aborted: values.abort, work: finished });
  } else {
    console.log(values.abort
      ? `Aborted and cleared ${finished.id} (.plan2agent/work.json removed).`
      : `Finished ${finished.id} (${finished.tasks.length} task(s)) and cleared .plan2agent/work.json.`);
  }
  return 0;
}

function cmdValidate(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const config = readConfig(targetRoot);
  if (!config) throw new Error('missing .plan2agent/config.json');
  const work = readWork(targetRoot);
  const summary = {
    valid: true,
    project_id: config.project_id,
    work_id: work?.id ?? null,
    work_status: work?.status ?? null,
  };
  if (values.json) printJson(summary);
  else console.log(`Validation passed (${config.project_id}${work ? `, ${work.id}: ${work.status}` : ', no active work'})`);
  return 0;
}

function cmdDoctor(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) { console.log(usage()); return 0; }
  const targetRoot = resolveTarget(values.target);
  const report = diagnoseProject(targetRoot);
  if (values.json) {
    printJson(report);
  } else {
    console.log(`Plan2Agent doctor: ${report.ok ? 'ok' : 'failed'} (${report.targetRoot})`);
    for (const err of report.errors) console.error(`error: ${err}`);
    for (const warn of report.warnings) console.warn(`warning: ${warn}`);
  }
  return report.ok ? 0 : 1;
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(PACKAGE_JSON.version);
    return 0;
  }
  const rest = argv.slice(1);
  try {
    switch (command) {
      case 'init': return cmdInit(rest);
      case 'next': return cmdNext(rest);
      case 'approve': return cmdApprove(rest);
      case 'task':
      case 'tasks': return cmdTask(rest);
      case 'verify': return cmdVerify(rest);
      case 'done': return cmdDone(rest);
      case 'validate': return cmdValidate(rest);
      case 'doctor': return cmdDoctor(rest);
      case 'buildlore': return runBuildLore(rest);
      default:
        console.error(`p2a error: unknown command "${command}"\n\n${usage()}`);
        return 1;
    }
  } catch (error) {
    console.error(`p2a error: ${error.message}`);
    return 1;
  }
}

if (
  process.argv[1]
  && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main();
}
