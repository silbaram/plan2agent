#!/usr/bin/env node
/** Manage project-scoped external Agent Skills through the pinned upstream adapter. */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addExternalSkill,
  listExternalSkills,
  listExternalSkillSource,
  redactExternalSkillsMessage,
  recoverExternalSkillsTransaction,
  removeExternalSkill,
  syncExternalSkills,
  updateExternalSkills,
} from './p2a_external_skills.mjs';

function usage() {
  return [
    'Usage:',
    '  p2a skills source <source> --list [--target <dir>] [--json]',
    '  p2a skills add <source> --skill <name> [--tools codex,claude,gemini] (--dry-run|--apply) [--expect-plan <sha256>] [--target <dir>] [--json]',
    '  p2a skills list [--target <dir>] [--json]',
    '  p2a skills update [names...] (--dry-run|--apply) [--target <dir>] [--json]',
    '  p2a skills remove <name> (--dry-run|--apply) [--target <dir>] [--json]',
    '  p2a skills sync (--dry-run|--apply) [--target <dir>] [--json]',
    '  p2a skills recover (--dry-run|--apply) [--target <dir>] [--json]',
    '',
    'External skills are copied into provider skill directories and tracked by p2a-skills.lock.json.',
    'Every --apply requires --expect-plan <sha256> from the reviewed dry-run.',
    'Dry-run never changes the target. Apply rechecks ownership and content before an atomic update.',
    'Review every external skill before applying it; installed skill instructions run with agent permissions.',
  ].join('\n');
}

function parseArgs(argv) {
  const input = argv[0] === 'skills' ? argv.slice(1) : [...argv];
  const command = ['--help', '-h'].includes(input[0]) ? null : input.shift();
  const args = {
    command,
    positionals: [],
    target: process.cwd(),
    json: false,
    list: false,
    apply: false,
    dryRun: false,
    skill: null,
    tools: null,
    expectPlan: null,
    help: false,
  };
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--json') args.json = true;
    else if (value === '--list' || value === '-l') args.list = true;
    else if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--target') {
      args.target = input[++index];
      if (!args.target) throw new Error('--target requires a project directory');
    } else if (value === '--skill' || value === '-s') {
      args.skill = input[++index];
      if (!args.skill) throw new Error('--skill requires a skill name');
    } else if (value === '--tools') {
      const raw = input[++index];
      if (!raw) throw new Error('--tools requires a comma-separated list');
      args.tools = raw.split(',').map((tool) => tool.trim()).filter(Boolean);
    } else if (value === '--expect-plan') {
      args.expectPlan = input[++index];
      if (!args.expectPlan || !/^[a-f0-9]{64}$/.test(args.expectPlan)) throw new Error('--expect-plan requires a SHA-256 plan digest');
    } else if (value.startsWith('-')) throw new Error(`unknown skills option: ${value}`);
    else args.positionals.push(value);
  }
  return args;
}

function requireMode(args) {
  if (args.apply === args.dryRun) throw new Error('choose exactly one of --dry-run or --apply');
  if (args.dryRun && args.expectPlan) throw new Error('--expect-plan is valid only with --apply');
}

function formatSourceReport(report) {
  const lines = [
    `External skills available from ${report.source}`,
    `Upstream adapter: ${report.upstream.package}@${report.upstream.version}`,
  ];
  for (const skill of report.skills) {
    lines.push(`- ${skill.name}: ${skill.description} (${skill.files} files, ${skill.bytes} bytes)`);
  }
  return lines.join('\n');
}

function formatListReport(report) {
  if (!report.skills.length && !report.issues?.length) return 'No external skills are installed.';
  const lines = [`External skills (${report.skills.length})`];
  for (const skill of report.skills) {
    lines.push(`- ${skill.name} [${skill.status}] ${skill.contentSha256.slice(0, 12)} ${skill.tools.join(',')}`);
    lines.push(`  source: ${skill.source.spec}${skill.source.resolvedCommit ? ` @ ${skill.source.resolvedCommit.slice(0, 12)}` : ''}`);
    for (const issue of skill.issues) lines.push(`  ${issue.kind}: ${issue.path}`);
  }
  for (const issue of report.issues ?? []) lines.push(`- project ${issue.kind}: ${issue.path}`);
  return lines.join('\n');
}

function formatPlan(plan) {
  const lines = [
    `External skills ${plan.operation} ${plan.applied ? 'applied' : 'plan'}`,
    `Plan: ${plan.planDigest}`,
    ...(plan.operation === 'recover' ? [plan.transactionSha256 ? 'Interrupted transaction will be recovered.' : 'No interrupted transaction.'] : []),
  ];
  for (const change of plan.changes) {
    lines.push(`- ${change.name}: ${change.action}`);
    lines.push(`  ${change.fromSha256?.slice(0, 12) ?? '(none)'} -> ${change.toSha256?.slice(0, 12) ?? '(removed)'}`);
    if (change.installedPaths.length) lines.push(`  paths: ${change.installedPaths.join(', ')}`);
    const fileChanges = [
      ...change.files.added.map((file) => `+${file}`),
      ...change.files.removed.map((file) => `-${file}`),
      ...change.files.modified.map((file) => `~${file}`),
    ];
    if (fileChanges.length) lines.push(`  files: ${fileChanges.join(', ')}`);
    if (change.frontmatterChanged) lines.push('  frontmatter: description changed');
    for (const issue of change.installationIssues ?? []) {
      lines.push(`  ${issue.kind}: ${issue.path}`);
    }
  }
  if (plan.operation === 'recover') {
    for (const entry of plan.recoveryState ?? []) {
      lines.push(`- ${entry.path} [${entry.kind}]${entry.sha256 ? ` ${entry.sha256.slice(0, 12)}` : ''}`);
    }
  }
  if (plan.blockers.length) {
    lines.push(`Blockers (${plan.blockers.length}):`);
    for (const blocker of plan.blockers) lines.push(`- ${blocker.name ?? 'project'}: ${blocker.kind} ${blocker.path ?? ''}`.trimEnd());
  }
  if (!plan.applied && !plan.blockers.length) lines.push(`Apply this exact operation by rerunning with --apply --expect-plan ${plan.planDigest}.`);
  return lines.join('\n');
}

function run(argv = process.argv.slice(2), io = console) {
  const wantsJson = argv.includes('--json');
  try {
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      io.log(usage());
      return 0;
    }
    let report;
    if (args.command === 'source') {
      if (args.positionals.length !== 1 || !args.list || args.expectPlan
        || args.apply || args.dryRun || args.skill || args.tools) {
        throw new Error('source requires <source> and --list');
      }
      report = listExternalSkillSource(args.target, args.positionals[0]);
      io.log(args.json ? JSON.stringify(report, null, 2) : formatSourceReport(report));
      return 0;
    }
    if (args.command === 'list') {
      if (args.positionals.length || args.list || args.apply || args.dryRun || args.expectPlan || args.skill || args.tools) throw new Error('list accepts only --target and --json');
      report = listExternalSkills(args.target);
      io.log(args.json ? JSON.stringify(report, null, 2) : formatListReport(report));
      return 0;
    }
    requireMode(args);
    const options = { apply: args.apply, tools: args.tools, expectedPlan: args.expectPlan };
    if (args.command === 'add') {
      if (args.positionals.length !== 1 || !args.skill || args.list) throw new Error('add requires <source> and --skill <name>');
      report = addExternalSkill(args.target, args.positionals[0], args.skill, options);
    } else if (args.command === 'update') {
      if (args.skill || args.tools || args.list) throw new Error('update accepts skill names as positional arguments');
      report = updateExternalSkills(args.target, args.positionals, options);
    } else if (args.command === 'remove') {
      if (args.positionals.length !== 1 || args.skill || args.tools || args.list) throw new Error('remove requires exactly one installed skill name');
      report = removeExternalSkill(args.target, args.positionals[0], options);
    } else if (args.command === 'recover') {
      if (args.positionals.length || args.skill || args.tools || args.list) throw new Error('recover does not accept skill names or source options');
      report = recoverExternalSkillsTransaction(args.target, options);
    } else if (args.command === 'sync') {
      if (args.positionals.length || args.skill || args.tools || args.list) throw new Error('sync does not accept skill names or source options');
      report = syncExternalSkills(args.target, options);
    } else {
      throw new Error(`unknown skills command: ${args.command}`);
    }
    io.log(args.json ? JSON.stringify(report, null, 2) : formatPlan(report));
    return 0;
  } catch (error) {
    const message = redactExternalSkillsMessage(error instanceof Error ? error.message : String(error));
    if (wantsJson) {
      const environmentFailure = /(?:dependency|failed to start|timed? out|exited with status|unable to resolve an immutable Git commit|network|clone|fetch)/i.test(message);
      io.error(JSON.stringify({
        schema_version: 'p2a.external-skills-error.v1',
        status: 'failed',
        ...(error.plan ? { plan: error.plan } : {}),
        error: {
          kind: environmentFailure ? 'environment_failure' : 'validation_failure',
          message,
        },
      }, null, 2));
    } else {
      if (error.plan) io.error(formatPlan(error.plan));
      io.error(`p2a skills error: ${message}`);
    }
    return 1;
  }
}

export { parseArgs, run, usage };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = run();
}
