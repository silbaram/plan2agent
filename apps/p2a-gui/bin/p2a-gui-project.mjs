#!/usr/bin/env node
/** Inspect a Plan2Agent project for the read-only GUI shell. */

import process from 'node:process';
import { inspectProject, formatProjectInspection } from '../src/project-reader.mjs';

function usage() {
  return [
    'Usage:',
    '  node apps/p2a-gui/bin/p2a-gui-project.mjs inspect --project <dir> [--json]',
    '',
    'Commands:',
    '  inspect        Read-only project detection and summary for the GUI shell.',
    '',
    'Options:',
    '  --project <dir>  Project directory to inspect.',
    '  --json           Print machine-readable JSON.',
    '  --help, -h       Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (command !== 'inspect') throw new Error(`unknown command: ${command}`);
  const args = { command, project: null, json: false, help: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--project') {
      args.project = argv[++index];
      if (!args.project) throw new Error('--project requires a value');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (!args.project) throw new Error('--project is required');
  return args;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const inspection = inspectProject(args.project);
    if (args.json) console.log(JSON.stringify(inspection, null, 2));
    else console.log(formatProjectInspection(inspection));
    return inspection.diagnostics?.some((item) => item.severity === 'error') ? 1 : 0;
  } catch (error) {
    console.error(`p2a gui project command failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
