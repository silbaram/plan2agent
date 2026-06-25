#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for positive, e2e, iteration, and negative fixture cases. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateTaskContextData, validateTaskGraphData } from './validate_artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const FIXTURE_ROOT = path.join(ROOT, 'fixtures');
const E2E_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_e2e');
const NEGATIVE_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_negative');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate_artifacts.mjs');
const ITERATION_CLI = path.join(ROOT, 'scripts', 'p2a_iteration.mjs');
const TASKS_CLI = path.join(ROOT, 'scripts', 'p2a_tasks.mjs');
const RUNS_CLI = path.join(ROOT, 'scripts', 'p2a_runs.mjs');
const EXECUTE_CLI = path.join(ROOT, 'scripts', 'p2a_execute.mjs');
const ORCHESTRATE_CLI = path.join(ROOT, 'scripts', 'p2a_orchestrate.mjs');
const PROPOSALS_CLI = path.join(ROOT, 'scripts', 'p2a_proposals.mjs');
const HANDOFF_CLI = path.join(ROOT, 'scripts', 'p2a_handoff.mjs');

function runValidator(args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runIteration(args) {
  return spawnSync(process.execPath, [ITERATION_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runTasks(args, options = {}) {
  return spawnSync(process.execPath, [TASKS_CLI, ...args], { cwd: ROOT, encoding: 'utf8', input: options.input });
}

function runRuns(args) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runExecute(args) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runOrchestrate(args) {
  return spawnSync(process.execPath, [ORCHESTRATE_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runProposals(args) {
  return spawnSync(process.execPath, [PROPOSALS_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runHandoff(args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runTargetTasks(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_tasks.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetRuns(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_runs.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetExecute(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_execute.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetOrchestrate(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_orchestrate.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetProposals(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_proposals.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetIteration(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_iteration.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function writeResultOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function failureStatus(result) {
  return result.status === 0 ? 1 : (result.status ?? 1);
}

function formatSegments(segments) {
  if (segments.length <= 2) return segments.join(' and ');
  return `${segments.slice(0, -1).join(', ')}, and ${segments[segments.length - 1]}`;
}

function loadNegativeFixtureManifest() {
  const manifestPath = path.join(NEGATIVE_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { expected_pass: [], expected_failure: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function loadE2eFixtureManifest() {
  const manifestPath = path.join(E2E_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { cases: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function assertCaseShape(caseData, groupName) {
  if (!caseData || typeof caseData !== 'object') {
    throw new Error(`${groupName} fixture case must be an object`);
  }
  if (!caseData.id || typeof caseData.id !== 'string') {
    throw new Error(`${groupName} fixture case is missing string id`);
  }
  if (!Array.isArray(caseData.args) || caseData.args.some((arg) => typeof arg !== 'string')) {
    throw new Error(`${caseData.id} must provide args as a string array`);
  }
}


function assertTargetSpecSourceIntake(targetRoot, caseId, label) {
  const artifactsDir = path.join(targetRoot, '.plan2agent', 'artifacts');
  const targetSpecPath = path.join(artifactsDir, 'spec.json');
  const targetTaskGraphPath = path.join(artifactsDir, 'task-graph.json');
  const targetIntakePath = path.join(artifactsDir, 'intake.json');
  const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
  if (!existsSync(targetIntakePath) || targetSpec.source_intake !== 'intake.json') {
    console.error(`${label} handoff spec.source_intake/intake.json mismatch: ${caseId}`);
    console.error(JSON.stringify({ source_intake: targetSpec.source_intake, intakeExists: existsSync(targetIntakePath) }, null, 2));
    return { status: 1 };
  }
  const result = runValidator(['--task-graph', targetTaskGraphPath, '--require-approved-spec', targetSpecPath]);
  if (result.status !== 0) {
    console.error(`${label} handoff target approved spec validation failed: ${caseId}`);
    writeResultOutput(result);
    return { status: failureStatus(result) };
  }
  return { status: 0 };
}

function assertE2eCaseShape(caseData) {
  if (!caseData || typeof caseData !== 'object') {
    throw new Error('e2e fixture case must be an object');
  }
  if (!caseData.id || typeof caseData.id !== 'string') {
    throw new Error('e2e fixture case is missing string id');
  }
  if (!caseData.artifact_root || typeof caseData.artifact_root !== 'string') {
    throw new Error(`${caseData.id} must provide artifact_root`);
  }
  if (!caseData.project_id || typeof caseData.project_id !== 'string') {
    throw new Error(`${caseData.id} must provide project_id`);
  }
}


function validateScaffoldFixtureCase() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-scaffold-'));
  let checks = 0;
  try {
    const targetRoot = path.join(tempRoot, 'target-project');
    let result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'all']);
    checks += 1;
    if (result.status !== 0) {
      console.error('scaffold fixture check failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const expectedScripts = ['p2a_iteration.mjs', 'p2a_tasks.mjs', 'p2a_runs.mjs', 'p2a_execute.mjs', 'p2a_orchestrate.mjs', 'p2a_proposals.mjs', 'p2a_run_paths.mjs', 'p2a_iteration_state.mjs', 'validate_artifacts.mjs']
      .map((file) => path.join('scripts', file));
    const expectedSchemas = ['intake.schema.json', 'spec.schema.json', 'task-graph.schema.json', 'task-context.schema.json', 'review.schema.json', 'run.schema.json', 'run-index.schema.json', 'orchestration-plan.schema.json', 'orchestration-runtime.schema.json', 'skill-proposal.schema.json', 'proposal-review.schema.json', 'proposal-curation.schema.json', 'proposal-patch-draft.schema.json', 'proposal-draft-approval.schema.json']
      .map((file) => path.join('schemas', file));
    const expectedToolFiles = [
      path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
      path.join('.claude', 'skills', 'p2a-harness', 'SKILL.md'),
      path.join('.claude', 'hooks', 'p2a-confine-workspace.mjs'),
      path.join('.codex', 'agents', 'p2a-task-graph.toml'),
      path.join('.gemini', 'commands', 'p2a', 'harness.toml'),
    ];
    const expectedGenerated = [
      path.join('.claude', 'settings.json'),
      path.join('.claude', 'settings.local.json'),
      path.join('.plan2agent', 'project.config.json'),
      path.join('.plan2agent', 'manifest.json'),
      'PLAN2AGENT.md',
      '.gitignore',
    ];
    const missingFiles = [...expectedScripts, ...expectedSchemas, ...expectedToolFiles, ...expectedGenerated]
      .filter((filePath) => !existsSync(path.join(targetRoot, filePath)));
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    const claudeSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.json'), 'utf8'));
    const claudeLocalSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.local.json'), 'utf8'));
    const gitignore = readFileSync(path.join(targetRoot, '.gitignore'), 'utf8');
    const ignoredPlans = ['.plan2agent/artifacts', 'artifacts/<project>/gate-*', 'artifacts/**/gate-*']
      .filter((line) => gitignore.includes(line));
    const expectedSandboxEnabled = process.platform === 'darwin' || process.platform === 'linux';
    if (
      missingFiles.length
      || manifest.provenance?.mode !== 'scaffold'
      || manifest.aiToolTargets.join(',') !== 'codex,claude,gemini'
      || config.testCommand !== null
      || config.runTracking?.runsDir !== '.plan2agent/runs'
      || !claudeSettings.permissions?.deny?.includes('Edit(~/**)')
      || claudeSettings.hooks?.PreToolUse?.[0]?.matcher !== 'Write|Edit|Bash'
      || claudeSettings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command !== 'node .claude/hooks/p2a-confine-workspace.mjs'
      || (expectedSandboxEnabled && claudeLocalSettings.sandbox?.filesystem?.allowWrite?.[0] !== '.')
      || (!expectedSandboxEnabled && Object.keys(claudeLocalSettings).length !== 0)
      || !gitignore.includes('.plan2agent/runs/')
      || !gitignore.includes('artifacts/**/runs/')
      || !gitignore.includes('.claude/settings.local.json')
      || !gitignore.includes('node_modules/')
      || ignoredPlans.length
    ) {
      console.error('scaffold output mismatch');
      console.error(JSON.stringify({ missingFiles, manifest, config, claudeSettings, claudeLocalSettings, ignoredPlans }, null, 2));
      return { status: 1, checks };
    }

    result = runTargetIteration(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a_iteration.mjs init')) {
      console.error('scaffold target p2a_iteration --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const dryRunRoot = path.join(tempRoot, 'dry-run-target');
    result = runHandoff(['scaffold', '--target', dryRunRoot, '--tools', 'none', '--dry-run']);
    checks += 1;
    if (result.status !== 0 || existsSync(dryRunRoot)) {
      console.error('scaffold dry-run fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('--overwrite')) {
      console.error('scaffold conflict fixture did not require --overwrite');
      writeResultOutput(result);
      return { status: 1, checks };
    }

    result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none', '--overwrite']);
    checks += 1;
    if (result.status !== 0) {
      console.error('scaffold overwrite fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return { status: 0, checks };
}

function validateE2eFixtureCases() {
  const manifest = loadE2eFixtureManifest();
  const cases = manifest.cases ?? [];
  let checks = 0;

  for (const caseData of cases) {
    assertE2eCaseShape(caseData);
    let result = runValidator([
      '--artifact-root',
      caseData.artifact_root,
      '--project-id',
      caseData.project_id,
      '--require-handoff-ready',
    ]);
    checks += 1;
    if (result.status !== 0) {
      console.error(`e2e fixture check failed: ${caseData.id}`);
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-greenfield-handoff-'));
    try {
      const targetRoot = path.join(tempRoot, 'target-project');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        caseData.artifact_root,
        '--target',
        targetRoot,
        '--include-intake',
      ]);
      checks += 1;
      if (result.status !== 0 || !existsSync(path.join(targetRoot, '.plan2agent', 'artifacts', 'spec.json'))) {
        console.error(`greenfield handoff fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      if (
        !existsSync(path.join(targetRoot, 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_execute.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_orchestrate.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_proposals.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_run_paths.mjs'))
        || !existsSync(path.join(targetRoot, 'schemas', 'task-context.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'run.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'run-index.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'orchestration-plan.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'orchestration-runtime.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'skill-proposal.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'proposal-review.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'proposal-curation.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'proposal-patch-draft.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'proposal-draft-approval.schema.json'))
        || existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json'))
      ) {
        console.error(`greenfield handoff wrote unexpected tool/current-spec files: ${caseData.id}`);
        return { status: 1, checks };
      }
      result = assertTargetSpecSourceIntake(targetRoot, caseData.id, 'greenfield');
      checks += 1;
      if (result.status !== 0) return { status: result.status, checks };

      result = runTargetTasks(targetRoot, ['ready', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json')]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`greenfield handoff target p2a_tasks execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetRuns(targetRoot, ['list', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json')]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('runId')) {
        console.error(`greenfield handoff target p2a_runs execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetExecute(targetRoot, ['plan', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json'), '--task', 'task-001', '--run-id', 'run-target-execute-plan']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent supervised task execution')) {
        console.error(`greenfield handoff target p2a_execute execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetOrchestrate(targetRoot, ['plan', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json'), '--task', 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('"schema_version": "p2a.orchestration_plan.v1"')) {
        console.error(`greenfield handoff target p2a_orchestrate execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetProposals(targetRoot, ['list']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('proposalId')) {
        console.error(`greenfield handoff target p2a_proposals execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const toolTargetRoot = path.join(tempRoot, 'target-project-tools');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        caseData.artifact_root,
        '--target',
        toolTargetRoot,
        '--tools',
        'codex,gemini',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`greenfield handoff --tools fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const expectedToolFiles = [
        path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
        path.join('.agents', 'agents', 'p2a-requirements.md'),
        path.join('.codex', 'agents', 'p2a-task-graph.toml'),
        path.join('.gemini', 'agents', 'p2a-task-graph.md'),
        path.join('.gemini', 'commands', 'p2a', 'harness.toml'),
      ];
      const missingToolFiles = expectedToolFiles.filter((filePath) => !existsSync(path.join(toolTargetRoot, filePath)));
      const toolManifest = JSON.parse(readFileSync(path.join(toolTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      if (
        missingToolFiles.length
        || toolManifest.aiToolTargets.join(',') !== 'codex,gemini'
        || !toolManifest.includedTools.includes('p2a_codex_assets')
        || !toolManifest.includedTools.includes('p2a_gemini_assets')
        || !toolManifest.includedTools.includes('p2a_runs')
        || !toolManifest.includedTools.includes('p2a_execute')
        || !toolManifest.includedTools.includes('p2a_orchestrate')
        || !toolManifest.includedTools.includes('p2a_proposals')
        || !toolManifest.toolFiles.includes('.agents/skills/p2a-harness/SKILL.md')
        || !toolManifest.toolFiles.includes('.gemini/commands/p2a/harness.toml')
        || !toolManifest.toolFiles.includes('scripts/p2a_runs.mjs')
        || !toolManifest.toolFiles.includes('scripts/p2a_execute.mjs')
        || !toolManifest.toolFiles.includes('scripts/p2a_orchestrate.mjs')
        || !toolManifest.toolFiles.includes('scripts/p2a_proposals.mjs')
        || !toolManifest.toolFiles.includes('scripts/p2a_run_paths.mjs')
        || !toolManifest.schemaFiles.includes('schemas/run.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/orchestration-plan.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/orchestration-runtime.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/proposal-review.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/proposal-curation.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/proposal-patch-draft.schema.json')
        || !toolManifest.schemaFiles.includes('schemas/proposal-draft-approval.schema.json')
      ) {
        console.error(`greenfield handoff --tools output mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ missingToolFiles, toolManifest }, null, 2));
        return { status: 1, checks };
      }

      const teamSourceRoot = path.join(tempRoot, 'team-bigfive-source');
      mkdirSync(path.join(teamSourceRoot, '_workspace'), { recursive: true });
      writeFileSync(path.join(teamSourceRoot, 'package.json'), JSON.stringify({ name: 'team-bigfive', version: '1.2.3' }, null, 2));
      writeFileSync(path.join(teamSourceRoot, 'README.md'), '# Team Big Five fixture\n');
      writeFileSync(path.join(teamSourceRoot, '.env'), 'SHOULD_NOT_COPY=1\n');
      writeFileSync(path.join(teamSourceRoot, '_workspace', 'run.log'), 'SHOULD_NOT_COPY\n');

      const teamTargetRoot = path.join(tempRoot, 'target-project-team-bigfive');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        caseData.artifact_root,
        '--target',
        teamTargetRoot,
        '--include-team-bigfive',
        '--team-bigfive-source',
        teamSourceRoot,
        '--team-bigfive-targets',
        'all',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`greenfield handoff Team Big Five fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const expectedTeamFiles = [
        path.join('.plan2agent', 'team-harnesses', 'team-bigfive', 'source-manifest.json'),
        path.join('.plan2agent', 'team-harnesses', 'team-bigfive', 'adaptation-notes.md'),
        path.join('.agents', 'skills', 'team-bigfive-kickoff', 'SKILL.md'),
        path.join('.codex', 'agents', 'team-bigfive-coordinator.toml'),
        path.join('.claude', 'skills', 'team-bigfive-kickoff', 'SKILL.md'),
        path.join('.claude', 'agents', 'team-bigfive-coordinator.md'),
        path.join('.claude-plugin', 'team-bigfive', 'source', 'README.md'),
        path.join('.gemini', 'agents', 'team-bigfive-coordinator.md'),
        path.join('.gemini', 'commands', 'p2a', 'team-bigfive.toml'),
      ];
      const missingTeamFiles = expectedTeamFiles.filter((filePath) => !existsSync(path.join(teamTargetRoot, filePath)));
      const teamManifest = JSON.parse(readFileSync(path.join(teamTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      const teamSourceManifest = JSON.parse(readFileSync(path.join(teamTargetRoot, '.plan2agent', 'team-harnesses', 'team-bigfive', 'source-manifest.json'), 'utf8'));
      if (
        missingTeamFiles.length
        || existsSync(path.join(teamTargetRoot, '.claude-plugin', 'team-bigfive', 'source', '.env'))
        || existsSync(path.join(teamTargetRoot, '.claude-plugin', 'team-bigfive', 'source', '_workspace', 'run.log'))
        || !teamManifest.includedTools.includes('team_bigfive_adapter')
        || teamManifest.externalHarnesses.length !== 1
        || teamManifest.externalHarnesses[0].name !== 'team-bigfive'
        || teamManifest.externalHarnesses[0].targets.join(',') !== 'codex,claude,gemini'
        || teamManifest.externalHarnesses[0].sourceVersion !== '1.2.3'
        || teamSourceManifest.source.fileCount !== 2
        || teamSourceManifest.source.files.some((file) => file.path === '.env' || file.path.startsWith('_workspace/'))
      ) {
        console.error(`greenfield handoff Team Big Five output mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ missingTeamFiles, teamManifest, teamSourceManifest }, null, 2));
        return { status: 1, checks };
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return { status: 0, checks };
}

function assertAbsoluteStatePaths(state) {
  for (const key of ['artifactRoot', 'statusPath', 'iterationRoot', 'currentSpecPath', 'effectiveSpecPath', 'specPath', 'taskGraphPath', 'reviewPath']) {
    if (!path.isAbsolute(state[key])) {
      throw new Error(`current --json ${key} must be absolute, got ${JSON.stringify(state[key])}`);
    }
  }
  if (!state.displayPaths || typeof state.displayPaths !== 'object') {
    throw new Error('current --json must include displayPaths');
  }
  if (typeof state.displayPaths.taskGraphPath !== 'string') {
    throw new Error('current --json displayPaths.taskGraphPath must be a string');
  }
}

function validateIterationCurrentFixtureCases() {
  const manifest = loadE2eFixtureManifest();
  const cases = manifest.cases ?? [];
  let checks = 0;

  for (const caseData of cases) {
    assertE2eCaseShape(caseData);
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-iteration-fixture-'));
    try {
      const sourceRoot = path.resolve(ROOT, caseData.artifact_root);
      const artifactRoot = path.join(tempRoot, path.basename(caseData.artifact_root));
      cpSync(sourceRoot, artifactRoot, { recursive: true });

      let result = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'v1-mvp']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration init fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      let state;
      try {
        state = JSON.parse(result.stdout);
        assertAbsoluteStatePaths(state);
      } catch (error) {
        console.error(`iteration current fixture returned invalid JSON contract: ${caseData.id}`);
        console.error(error.message);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      if (state.activeIteration !== 'v1-mvp' || state.statusActiveIteration !== state.activeIteration) {
        console.error(`iteration current fixture resolved unexpected active iteration: ${caseData.id}`);
        console.error(JSON.stringify(state, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration validation passed')) {
        console.error(`iteration validate fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const statusText = readFileSync(path.join(artifactRoot, 'status.md'), 'utf8');
      writeFileSync(
        path.join(artifactRoot, 'status.md'),
        '# broken status\n\n' +
          '<!-- p2a:active-iteration=v1-mvp -->\n\n' +
          '#### Gate B approval audit\n\n' +
          '- Approved by: user\n' +
          '- Approved at: 2026-06-16\n' +
          '- Approved artifacts: `iterations/v1-mvp/gate-b-spec/spec.json`\n' +
          '- Approval note: fixture intentionally breaks status structure.\n',
        'utf8',
      );
      result = runIteration(['validate', '--artifacts', artifactRoot]);
      checks += 1;
      const brokenStatusOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !brokenStatusOutput.includes('status.md missing Progress line')) {
        console.error(`iteration validate fixture did not reject broken status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), statusText, 'utf8');
        return { status: 1, checks };
      }
      writeFileSync(path.join(artifactRoot, 'status.md'), statusText, 'utf8');

      const currentSpecText = readFileSync(state.currentSpecPath, 'utf8');
      const currentSpecWithOpenDecision = JSON.parse(currentSpecText);
      currentSpecWithOpenDecision.open_decisions = [{
        id: 'CD-fixture',
        type: 'fixture',
        question: 'Fixture open decision must block ready execution.',
        affects: ['product.goals'],
        status: 'open',
      }];
      writeFileSync(state.currentSpecPath, `${JSON.stringify(currentSpecWithOpenDecision, null, 2)}\n`, 'utf8');
      result = runTasks(['ready', '--artifacts', artifactRoot]);
      checks += 1;
      const currentSpecOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !currentSpecOpenOutput.includes('current-spec.json open_decisions')) {
        console.error(`p2a_tasks ready fixture did not reject current-spec open_decisions: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(state.currentSpecPath, currentSpecText, 'utf8');
        return { status: 1, checks };
      }
      writeFileSync(state.currentSpecPath, currentSpecText, 'utf8');

      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      const closeNotReadyOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !closeNotReadyOutput.includes('incomplete tasks')) {
        console.error(`iteration close-ready fixture did not reject incomplete tasks: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-blocked', '--idea', 'Should not open before tasks are done']);
      checks += 1;
      const blockedOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !blockedOpenOutput.includes('incomplete tasks')) {
        console.error(`iteration open fixture did not reject incomplete active baseline: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runTasks(['ready', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`p2a_tasks ready --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['-i'], { input: `2\n1\n${artifactRoot}\n` });
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`p2a_tasks interactive --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['prompt', '--artifacts', artifactRoot, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Full spec:')) {
        console.error(`p2a_tasks prompt --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['ready', '--graph', state.taskGraphPath, '--artifacts', artifactRoot]);
      checks += 1;
      const taskOptionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !taskOptionOutput.includes('--graph and --artifacts cannot be used together')) {
        console.error(`p2a_tasks fixture did not reject mixed graph/artifacts inputs: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeGraphPath = path.join(tempRoot, 'p2a-execute', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeGraphPath), { recursive: true });
      writeFileSync(executeGraphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
      result = runExecute([
        'plan',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-fixture',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent supervised task execution')) {
        console.error(`p2a_execute plan fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeOrchestrationPlanPath = path.join(tempRoot, 'p2a-execute', 'orchestration', 'task-001.json');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--output',
        executeOrchestrationPlanPath,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent orchestration plan')) {
        console.error(`p2a_orchestrate plan fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runValidator(['--orchestration-plan', executeOrchestrationPlanPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`orchestration plan validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeOrchestrationPlan = JSON.parse(readFileSync(executeOrchestrationPlanPath, 'utf8'));
      if (
        executeOrchestrationPlan.mode !== 'solo'
        || executeOrchestrationPlan.providerStrategy.mode !== 'single_provider'
        || executeOrchestrationPlan.providerStrategy.primaryProvider !== 'codex'
        || executeOrchestrationPlan.providerCapabilities.find((capability) => capability.provider === 'gemini')?.writeAllowed !== false
        || executeOrchestrationPlan.monitorGate.required
        || executeOrchestrationPlan.monitorGate.verdictPath !== null
      ) {
        console.error(`p2a_orchestrate default fixture should stay solo: ${caseData.id}`);
        console.error(JSON.stringify({ executeOrchestrationPlan }, null, 2));
        return { status: 1, checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--agent-tool',
        'gemini',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('Gemini is read-only in P2A orchestration')) {
        console.error(`p2a_orchestrate should reject Gemini as write implementer: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runExecute([
        'plan',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--agent-tool',
        'gemini',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('Gemini is read-only')) {
        console.error(`p2a_execute should reject Gemini as write implementer: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeSlashGraphPath = path.join(tempRoot, 'p2a-orchestrate-slash-area', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeSlashGraphPath), { recursive: true });
      const executeSlashGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      executeSlashGraph.tasks.find((task) => task.id === 'task-001').targetArea = 'auth/login';
      writeFileSync(executeSlashGraphPath, `${JSON.stringify(executeSlashGraph, null, 2)}\n`, 'utf8');
      const executeSlashPlanPath = path.join(tempRoot, 'p2a-orchestrate-slash-area', 'orchestration', 'task-001.json');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeSlashGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--output',
        executeSlashPlanPath,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate slash targetArea fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeSlashPlan = JSON.parse(readFileSync(executeSlashPlanPath, 'utf8'));
      if (executeSlashPlan.mode !== 'solo' || executeSlashPlan.riskFlags.includes('multi_area')) {
        console.error(`p2a_orchestrate slash targetArea fixture produced multi-area false positive: ${caseData.id}`);
        console.error(JSON.stringify({ executeSlashPlan }, null, 2));
        return { status: 1, checks };
      }

      const executeDependencyGraphPath = path.join(tempRoot, 'p2a-orchestrate-dependency-risk', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeDependencyGraphPath), { recursive: true });
      const executeDependencyGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      executeDependencyGraph.tasks.find((task) => task.id === 'task-001').status = 'done';
      executeDependencyGraph.tasks.find((task) => task.id === 'task-002').status = 'done';
      const executeDependencyTask = executeDependencyGraph.tasks.find((task) => task.id === 'task-003');
      executeDependencyTask.dependencies = ['task-001', 'task-002'];
      executeDependencyTask.status = 'todo';
      writeFileSync(executeDependencyGraphPath, `${JSON.stringify(executeDependencyGraph, null, 2)}\n`, 'utf8');
      const executeDependencyPlanPath = path.join(tempRoot, 'p2a-orchestrate-dependency-risk', 'orchestration', 'task-003.json');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeDependencyGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-003',
        '--output',
        executeDependencyPlanPath,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate dependency risk fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeDependencyPlan = JSON.parse(readFileSync(executeDependencyPlanPath, 'utf8'));
      if (
        executeDependencyPlan.mode !== 'solo'
        || executeDependencyPlan.monitorGate.required
        || !executeDependencyPlan.riskFlags.includes('dependency_heavy')
      ) {
        console.error(`p2a_orchestrate dependency risk fixture should not require monitor gate: ${caseData.id}`);
        console.error(JSON.stringify({ executeDependencyPlan }, null, 2));
        return { status: 1, checks };
      }

      result = runExecute([
        'start',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-fixture',
        '--agent-tool',
        'codex',
        '--orchestration-plan',
        executeOrchestrationPlanPath,
        '--workspace',
        artifactRoot,
        '--workspace-ref',
        'fixture-workspace',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Manual launcher prompt')) {
        console.error(`p2a_execute start fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeSidecarPath = path.join(tempRoot, 'p2a-execute', 'runs', 'run-execute-fixture.orchestration.json');
      const executeSidecar = JSON.parse(readFileSync(executeSidecarPath, 'utf8'));
      if (executeSidecar.runLink.runId !== 'run-execute-fixture') {
        console.error(`p2a_execute start did not attach orchestration sidecar: ${caseData.id}`);
        console.error(JSON.stringify({ executeSidecar }, null, 2));
        return { status: 1, checks };
      }
      const executeRuntimePath = path.join(tempRoot, 'p2a-execute', 'runs', 'run-execute-fixture.orchestration-runtime.json');
      result = runValidator(['--orchestration-runtime', executeRuntimePath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`orchestration runtime validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeRuntime = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        executeRuntime.schema_version !== 'p2a.orchestration_runtime.v1'
        || executeRuntime.runId !== 'run-execute-fixture'
        || executeRuntime.planId !== executeSidecar.planId
        || executeRuntime.sharedMentalModel.roleAssignments.length !== executeSidecar.roles.length
        || !executeRuntime.communicationLog.some((event) => event.type === 'handoff')
        || executeRuntime.status.phase !== 'running'
      ) {
        console.error(`p2a_execute start wrote unexpected orchestration runtime: ${caseData.id}`);
        console.error(JSON.stringify({ executeRuntime, executeSidecar }, null, 2));
        return { status: 1, checks };
      }

      result = runOrchestrate(['next-role', '--runtime', executeRuntimePath, '--json']);
      checks += 1;
      const executeNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeNextRole.nextRole?.roleId !== 'implementer'
        || executeNextRole.startsProcess !== false
        || executeNextRole.supervisedOnly !== true
      ) {
        console.error(`p2a_orchestrate next-role fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeNextRole }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate(['role-prompt', '--runtime', executeRuntimePath, '--role', 'implementer']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent supervised role prompt')
        || !result.stdout.includes('startsProcess: false')
        || !result.stdout.includes('Do not run background loops')
      ) {
        console.error(`p2a_orchestrate role-prompt fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'record',
        '--runtime',
        executeRuntimePath,
        '--role',
        'implementer',
        '--type',
        'status',
        '--summary',
        'Implementation session opened',
        '--role-status',
        'active',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent orchestration runtime event recorded')) {
        console.error(`p2a_orchestrate record fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeRuntimeAfterRecord = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        !executeRuntimeAfterRecord.communicationLog.some((event) => event.summary === 'Implementation session opened')
        || executeRuntimeAfterRecord.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'implementer')?.status !== 'active'
      ) {
        console.error(`p2a_orchestrate record wrote unexpected runtime state: ${caseData.id}`);
        console.error(JSON.stringify({ executeRuntimeAfterRecord }, null, 2));
        return { status: 1, checks };
      }
      result = runValidator(['--runs-dir', path.join(tempRoot, 'p2a-execute', 'runs')]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`runs dir validator did not accept orchestration runtime sidecar: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'mark-role',
        '--runtime',
        executeRuntimePath,
        '--role',
        'implementer',
        '--role-status',
        'complete',
        '--summary',
        'Implementation completed under human supervision',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('nextRole: owner') || !result.stdout.includes('startsProcess: false')) {
        console.error(`p2a_orchestrate mark-role solo fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeRuntimeAfterMark = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        executeRuntimeAfterMark.status.phase !== 'ready_to_finish'
        || executeRuntimeAfterMark.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'implementer')?.status !== 'complete'
      ) {
        console.error(`p2a_orchestrate mark-role solo wrote unexpected state: ${caseData.id}`);
        console.error(JSON.stringify({ executeRuntimeAfterMark }, null, 2));
        return { status: 1, checks };
      }
      if (executeSidecar.monitorGate.required) {
        writeFileSync(path.join(tempRoot, 'p2a-execute', 'runs', executeSidecar.monitorGate.verdictPath), '{"verdict":"confirm_done"}\n', 'utf8');
      }

      result = runExecute([
        'finish',
        '--graph',
        executeGraphPath,
        '--run-id',
        'run-execute-fixture',
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
        '--changed-file',
        'src/execute-fixture.ts',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001 status is now done')) {
        console.error(`p2a_execute finish fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeFinishedGraph = JSON.parse(readFileSync(executeGraphPath, 'utf8'));
      const executeFinishedRun = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute', 'runs', 'run-execute-fixture.json'), 'utf8'));
      const executeRuntimeAfterFinish = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        executeFinishedGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'done'
        || executeFinishedRun.status !== 'finished'
        || executeFinishedRun.changedFiles.join(',') !== 'src/execute-fixture.ts'
        || executeRuntimeAfterFinish.status.phase !== 'closed'
        || !executeRuntimeAfterFinish.communicationLog.some((event) => event.summary === 'Run run-execute-fixture finished with status finished')
        || executeRuntimeAfterFinish.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'owner')?.status !== 'complete'
      ) {
        console.error(`p2a_execute finish wrote unexpected state: ${caseData.id}`);
        console.error(JSON.stringify({ executeFinishedGraph, executeFinishedRun, executeRuntimeAfterFinish }, null, 2));
        return { status: 1, checks };
      }

      result = runExecute([
        'finish',
        '--graph',
        executeGraphPath,
        '--run-id',
        'run-execute-fixture',
        '--status',
        'finished',
      ]);
      checks += 1;
      const repeatedFinishRuntime = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      const repeatedFinishOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        !repeatedFinishOutput.includes('Orchestration runtime already closed')
        || repeatedFinishRuntime.status.phase !== 'closed'
        || repeatedFinishRuntime.communicationLog.length !== executeRuntimeAfterFinish.communicationLog.length
      ) {
        console.error(`p2a_execute repeated finish should not append to closed runtime: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeRuntimeAfterFinish, repeatedFinishRuntime }, null, 2));
        return { status: 1, checks };
      }

      const executeMonitorGraphPath = path.join(tempRoot, 'p2a-execute-monitor', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeMonitorGraphPath), { recursive: true });
      const executeMonitorGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      const executeMonitorTask = executeMonitorGraph.tasks.find((task) => task.id === 'task-001');
      executeMonitorTask.targetArea = 'api+ui';
      executeMonitorTask.acceptanceCriteria.push('Monitor gate fixture coverage is recorded.');
      writeFileSync(executeMonitorGraphPath, `${JSON.stringify(executeMonitorGraph, null, 2)}\n`, 'utf8');
      const executeMonitorPlanPath = path.join(tempRoot, 'p2a-execute-monitor', 'orchestration', 'task-001.json');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeMonitorGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--output',
        executeMonitorPlanPath,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate monitor fixture plan failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorPlan = JSON.parse(readFileSync(executeMonitorPlanPath, 'utf8'));
      if (
        executeMonitorPlan.mode !== 'team'
        || executeMonitorPlan.providerStrategy.mode !== 'single_provider'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'reviewer')?.agentTool !== 'codex'
        || !executeMonitorPlan.monitorGate.required
        || !executeMonitorPlan.riskFlags.includes('multi_area')
      ) {
        console.error(`p2a_orchestrate monitor fixture should use explicit multi-area team mode: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorPlan }, null, 2));
        return { status: 1, checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeMonitorGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--reviewer-tool',
        'gemini',
      ]);
      checks += 1;
      const explicitGeminiReviewerPlan = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || explicitGeminiReviewerPlan.providerStrategy.mode !== 'single_provider_with_read_only_reviewer'
        || explicitGeminiReviewerPlan.roles.find((role) => role.roleId === 'reviewer')?.agentTool !== 'gemini'
        || explicitGeminiReviewerPlan.roles.find((role) => role.roleId === 'reviewer')?.requiresWrite !== false
      ) {
        console.error(`p2a_orchestrate should allow Gemini as explicit read-only reviewer: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ explicitGeminiReviewerPlan }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeMonitorGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--agent-tool',
        'codex',
        '--reviewer-tool',
        'claude',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('cross-provider reviewers must be read-only')) {
        console.error(`p2a_orchestrate should reject write-capable cross-provider reviewers: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runExecute([
        'start',
        '--graph',
        executeMonitorGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-monitor-fixture',
        '--agent-tool',
        'codex',
        '--orchestration-plan',
        executeMonitorPlanPath,
        '--workspace',
        artifactRoot,
        '--workspace-ref',
        'fixture-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute monitor fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMonitorRuntimePath = path.join(tempRoot, 'p2a-execute-monitor', 'runs', 'run-execute-monitor-fixture.orchestration-runtime.json');
      result = runOrchestrate(['next-role', '--runtime', executeMonitorRuntimePath, '--json']);
      checks += 1;
      const executeMonitorNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeMonitorNextRole.nextRole?.roleId !== 'implementer'
        || executeMonitorNextRole.startsProcess !== false
      ) {
        console.error(`p2a_orchestrate monitor next-role fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeMonitorNextRole }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'mark-role',
        '--runtime',
        executeMonitorRuntimePath,
        '--role',
        'implementer',
        '--role-status',
        'complete',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('nextRole: reviewer') || !result.stdout.includes('startsProcess: false')) {
        console.error(`p2a_orchestrate monitor implementer mark-role fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'mark-role',
        '--runtime',
        executeMonitorRuntimePath,
        '--role',
        'reviewer',
        '--role-status',
        'complete',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('nextRole: monitor') || !result.stdout.includes('startsProcess: false')) {
        console.error(`p2a_orchestrate monitor reviewer mark-role fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorRuntimeAfterMarks = JSON.parse(readFileSync(executeMonitorRuntimePath, 'utf8'));
      if (
        executeMonitorRuntimeAfterMarks.status.phase !== 'ready_for_monitor'
        || executeMonitorRuntimeAfterMarks.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'reviewer')?.status !== 'complete'
        || executeMonitorRuntimeAfterMarks.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'monitor')?.status !== 'pending'
      ) {
        console.error(`p2a_orchestrate monitor scheduler wrote unexpected state: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorRuntimeAfterMarks }, null, 2));
        return { status: 1, checks };
      }

      result = runOrchestrate([
        'mark-role',
        '--runtime',
        executeMonitorRuntimePath,
        '--role',
        'monitor',
        '--role-status',
        'complete',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('--verdict is required when marking monitor complete')) {
        console.error(`p2a_orchestrate monitor mark-role should require verdict: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runOrchestrate([
        'mark-role',
        '--runtime',
        executeMonitorRuntimePath,
        '--role',
        'monitor',
        '--role-status',
        'complete',
        '--verdict',
        'unmet_acceptance',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('phase: blocked') || !result.stdout.includes('nextRole: owner')) {
        console.error(`p2a_orchestrate monitor mark-role should block rejected verdicts: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runExecute([
        'finish',
        '--graph',
        executeMonitorGraphPath,
        '--run-id',
        'run-execute-monitor-fixture',
      ]);
      checks += 1;
      const missingVerdictOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !missingVerdictOutput.includes('monitor verdict')) {
        console.error(`p2a_execute monitor fixture did not require verdict: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeMonitorSidecar = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', 'run-execute-monitor-fixture.orchestration.json'), 'utf8'));
      if (!executeMonitorSidecar.monitorGate.required) {
        console.error(`p2a_execute monitor fixture did not create required monitor gate: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorSidecar }, null, 2));
        return { status: 1, checks };
      }
      writeFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', executeMonitorSidecar.monitorGate.verdictPath), '{"verdict":" unmet_acceptance "}\n', 'utf8');
      result = runExecute([
        'finish',
        '--graph',
        executeMonitorGraphPath,
        '--run-id',
        'run-execute-monitor-fixture',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Monitor gate blocked finish: unmet_acceptance -> implementation_incomplete')) {
        console.error(`p2a_execute monitor fixture did not map blocked verdict: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorFinishedGraph = JSON.parse(readFileSync(executeMonitorGraphPath, 'utf8'));
      const executeMonitorFinishedRun = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', 'run-execute-monitor-fixture.json'), 'utf8'));
      const executeMonitorFinishedRuntime = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', 'run-execute-monitor-fixture.orchestration-runtime.json'), 'utf8'));
      if (
        executeMonitorFinishedGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'blocked'
        || executeMonitorFinishedRun.status !== 'blocked'
        || executeMonitorFinishedRun.failure?.class !== 'implementation_incomplete'
        || executeMonitorFinishedRun.failure?.source !== 'monitor'
        || executeMonitorFinishedRuntime.status.phase !== 'blocked'
        || executeMonitorFinishedRuntime.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'owner')?.status !== 'blocked'
      ) {
        console.error(`p2a_execute monitor fixture wrote unexpected blocked state: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorFinishedGraph, executeMonitorFinishedRun, executeMonitorFinishedRuntime }, null, 2));
        return { status: 1, checks };
      }

      result = runProposals([
        'mine',
        '--graph',
        executeMonitorGraphPath,
      ]);
      checks += 1;
      const proposalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 0 || !proposalOutput.includes('proposal-run-execute-monitor-fixture-implementation_incomplete')) {
        console.error(`p2a_proposals mine fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorProposalsDir = path.join(tempRoot, 'p2a-execute-monitor', 'proposals');
      const executeMonitorProposalPath = path.join(executeMonitorProposalsDir, 'proposal-run-execute-monitor-fixture-implementation_incomplete.json');
      const executeMonitorProposal = JSON.parse(readFileSync(executeMonitorProposalPath, 'utf8'));
      if (
        executeMonitorProposal.sourceRunId !== 'run-execute-monitor-fixture'
        || executeMonitorProposal.status !== 'proposed'
        || !executeMonitorProposal.evidence.includes('monitor verdict: unmet_acceptance')
      ) {
        console.error(`p2a_proposals mine wrote unexpected proposal: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorProposal }, null, 2));
        return { status: 1, checks };
      }

      const executeMonitorRunsDir = path.join(tempRoot, 'p2a-execute-monitor', 'runs');
      const invalidRunId = 'run-execute-monitor-invalid';
      const executeMonitorRunIndexPath = path.join(executeMonitorRunsDir, 'run-index.json');
      const executeMonitorRunIndex = JSON.parse(readFileSync(executeMonitorRunIndexPath, 'utf8'));
      const baseRunIndexEntry = executeMonitorRunIndex.runs.find((run) => run.runId === 'run-execute-monitor-fixture');
      executeMonitorRunIndex.runs.push({
        ...baseRunIndexEntry,
        runId: invalidRunId,
        runRef: `${invalidRunId}.json`,
        status: 'finished',
      });
      const executeMonitorTaskIndex = executeMonitorRunIndex.tasks.find((task) => task.taskId === 'task-001');
      executeMonitorTaskIndex.runIds.push(invalidRunId);
      executeMonitorTaskIndex.latestRunId = invalidRunId;
      writeFileSync(executeMonitorRunIndexPath, `${JSON.stringify(executeMonitorRunIndex, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(executeMonitorRunsDir, `${invalidRunId}.json`), `{"schema_version":"p2a.run.v1","runId":"${invalidRunId}"}\n`, 'utf8');

      result = runProposals([
        'mine',
        '--graph',
        executeMonitorGraphPath,
        '--overwrite',
      ]);
      checks += 1;
      const invalidRunProposalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status !== 0
        || !invalidRunProposalOutput.includes(`warning: skipped run ${invalidRunId}`)
        || !invalidRunProposalOutput.includes('proposal-run-execute-monitor-fixture-implementation_incomplete')
      ) {
        console.error(`p2a_proposals mine should skip invalid run and continue: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runValidator(['--proposals-dir', executeMonitorProposalsDir]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`proposal directory validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runProposals([
        'digest',
        '--proposals',
        executeMonitorProposalsDir,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent proposal digest')) {
        console.error(`p2a_proposals digest fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMonitorReviewPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-review.json');
      result = runProposals([
        'review',
        '--proposals',
        executeMonitorProposalsDir,
        '--output',
        executeMonitorReviewPath,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent proposal review')) {
        console.error(`p2a_proposals review fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorReview = JSON.parse(readFileSync(executeMonitorReviewPath, 'utf8'));
      if (
        executeMonitorReview.schema_version !== 'p2a.proposal_review.v1'
        || executeMonitorReview.summary.totalProposals !== 1
        || executeMonitorReview.groups[0]?.classification !== 'implementation_incomplete'
        || executeMonitorReview.groups[0]?.recommendedDisposition !== 'defer'
      ) {
        console.error(`p2a_proposals review wrote unexpected review: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorReview }, null, 2));
        return { status: 1, checks };
      }

      result = runValidator(['--proposal-review', executeMonitorReviewPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`proposal review validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMonitorCurationPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-curation.json');
      result = runProposals([
        'curate',
        '--review',
        executeMonitorReviewPath,
        '--proposals',
        executeMonitorProposalsDir,
        '--output',
        executeMonitorCurationPath,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent proposal curation')) {
        console.error(`p2a_proposals curate fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorCuration = JSON.parse(readFileSync(executeMonitorCurationPath, 'utf8'));
      if (
        executeMonitorCuration.schema_version !== 'p2a.proposal_curation.v1'
        || executeMonitorCuration.summary.totalCandidates !== 1
        || executeMonitorCuration.candidates[0]?.classification !== 'implementation_incomplete'
        || executeMonitorCuration.candidates[0]?.readiness !== 'watch'
        || executeMonitorCuration.candidates[0]?.separatePatchRequired !== true
      ) {
        console.error(`p2a_proposals curate wrote unexpected curation: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorCuration }, null, 2));
        return { status: 1, checks };
      }

      result = runValidator(['--proposal-curation', executeMonitorCurationPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`proposal curation validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMonitorPatchDraftPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-patch-draft.json');
      result = runProposals([
        'draft-patch',
        '--curation',
        executeMonitorCurationPath,
        '--candidate-id',
        executeMonitorCuration.candidates[0].candidateId,
        '--proposals',
        executeMonitorProposalsDir,
        '--output',
        executeMonitorPatchDraftPath,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent proposal patch draft')) {
        console.error(`p2a_proposals draft-patch fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorPatchDraft = JSON.parse(readFileSync(executeMonitorPatchDraftPath, 'utf8'));
      if (
        executeMonitorPatchDraft.schema_version !== 'p2a.proposal_patch_draft.v1'
        || executeMonitorPatchDraft.candidateId !== executeMonitorCuration.candidates[0].candidateId
        || executeMonitorPatchDraft.autoApplyAllowed !== false
        || executeMonitorPatchDraft.approvalRequired !== true
        || executeMonitorPatchDraft.targetFiles.length === 0
      ) {
        console.error(`p2a_proposals draft-patch wrote unexpected patch draft: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorPatchDraft }, null, 2));
        return { status: 1, checks };
      }

      result = runValidator(['--proposal-patch-draft', executeMonitorPatchDraftPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`proposal patch draft validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMonitorApprovalPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-draft-approval.json');
      const executeMonitorApprovalArtifactRoot = path.join(tempRoot, 'p2a-execute-monitor-approval-artifacts');
      cpSync(artifactRoot, executeMonitorApprovalArtifactRoot, { recursive: true });
      result = runProposals([
        'approve-draft',
        '--draft',
        executeMonitorPatchDraftPath,
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture approval',
        '--proposals',
        executeMonitorProposalsDir,
        '--output',
        executeMonitorApprovalPath,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent proposal draft approval')) {
        console.error(`p2a_proposals approve-draft fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorApproval = JSON.parse(readFileSync(executeMonitorApprovalPath, 'utf8'));
      const executeMonitorMaintenanceGraphPath = path.join(executeMonitorApprovalArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      const executeMonitorMaintenanceGraph = JSON.parse(readFileSync(executeMonitorMaintenanceGraphPath, 'utf8'));
      const executeMonitorMaintenanceTask = executeMonitorMaintenanceGraph.tasks.find((task) => task.id === executeMonitorApproval.maintenanceTask.taskId);
      if (
        executeMonitorApproval.schema_version !== 'p2a.proposal_draft_approval.v1'
        || executeMonitorApproval.draftId !== executeMonitorPatchDraft.draftId
        || executeMonitorApproval.candidateId !== executeMonitorPatchDraft.candidateId
        || executeMonitorApproval.autoApplyPerformed !== false
        || !executeMonitorMaintenanceTask
        || !executeMonitorMaintenanceTask.sourceSpecRefs.includes(`proposal-draft-approval:${executeMonitorApproval.approvalId}`)
        || !executeMonitorMaintenanceTask.sourceSpecRefs.includes(`proposal-patch-draft:${executeMonitorPatchDraft.draftId}`)
      ) {
        console.error(`p2a_proposals approve-draft wrote unexpected approval/task: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorApproval, executeMonitorMaintenanceTask }, null, 2));
        return { status: 1, checks };
      }

      result = runValidator(['--proposal-draft-approval', executeMonitorApprovalPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`proposal draft approval validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const invalidApprovalMissingSelfRefPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-draft-approval-missing-self-ref.json');
      const invalidApprovalMissingSelfRef = JSON.parse(JSON.stringify(executeMonitorApproval));
      invalidApprovalMissingSelfRef.maintenanceTask.sourceSpecRefs = invalidApprovalMissingSelfRef.maintenanceTask.sourceSpecRefs
        .filter((ref) => ref !== `proposal-draft-approval:${executeMonitorApproval.approvalId}`);
      writeFileSync(invalidApprovalMissingSelfRefPath, `${JSON.stringify(invalidApprovalMissingSelfRef, null, 2)}\n`, 'utf8');
      result = runValidator(['--proposal-draft-approval', invalidApprovalMissingSelfRefPath]);
      checks += 1;
      const invalidApprovalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !invalidApprovalOutput.includes('must reference approvalId')) {
        console.error(`proposal draft approval missing self-ref negative fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeApprovalConflictArtifactRoot = path.join(tempRoot, 'p2a-execute-approval-conflict-artifacts');
      cpSync(artifactRoot, executeApprovalConflictArtifactRoot, { recursive: true });
      const executeApprovalConflictPath = path.join(tempRoot, 'p2a-execute-monitor', 'proposal-draft-approval-conflict.json');
      const executeApprovalConflict = JSON.parse(JSON.stringify(executeMonitorApproval));
      const conflictApprovalId = 'proposal-draft-approval-000000000000';
      executeApprovalConflict.approvalId = conflictApprovalId;
      executeApprovalConflict.maintenanceTask.sourceSpecRefs = executeApprovalConflict.maintenanceTask.sourceSpecRefs
        .map((ref) => ref.startsWith('proposal-draft-approval:') ? `proposal-draft-approval:${conflictApprovalId}` : ref);
      writeFileSync(executeApprovalConflictPath, `${JSON.stringify(executeApprovalConflict, null, 2)}\n`, 'utf8');
      result = runProposals([
        'approve-draft',
        '--draft',
        executeMonitorPatchDraftPath,
        '--artifacts',
        executeApprovalConflictArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture approval',
        '--proposals',
        executeMonitorProposalsDir,
        '--output',
        executeApprovalConflictPath,
      ]);
      checks += 1;
      const approvalConflictOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const approvalConflictGraphPath = path.join(executeApprovalConflictArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      if (
        result.status === 0
        || !approvalConflictOutput.includes('existing approval output does not match requested approval')
        || existsSync(approvalConflictGraphPath)
      ) {
        console.error(`p2a_proposals approve-draft output preflight fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ approvalConflictGraphExists: existsSync(approvalConflictGraphPath) }, null, 2));
        return { status: 1, checks };
      }
      const executeFinishTraceArtifactRoot = path.join(tempRoot, 'p2a-execute-approval-finish-trace-artifacts');
      cpSync(executeMonitorApprovalArtifactRoot, executeFinishTraceArtifactRoot, { recursive: true });

      result = runExecute([
        'plan',
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
        '--run-id',
        'run-approved-proposal-fixture',
        '--agent-tool',
        'codex',
        '--workspace',
        executeMonitorApprovalArtifactRoot,
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent supervised task execution')
        || !result.stdout.includes('- source: maintenance')
        || !result.stdout.includes(`- proposalApproval: ${executeMonitorApproval.approvalId}`)
        || !result.stdout.includes('--approval')
      ) {
        console.error(`p2a_execute approval plan fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runExecute([
        'start',
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
        '--run-id',
        'run-approved-proposal-fixture',
        '--agent-tool',
        'codex',
        '--workspace',
        executeMonitorApprovalArtifactRoot,
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent run started: run-approved-proposal-fixture')
        || !result.stdout.includes(`Approved proposal: ${executeMonitorApproval.approvalId}`)
      ) {
        console.error(`p2a_execute approval start fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeApprovedRunPath = path.join(executeMonitorApprovalArtifactRoot, 'runs', 'run-approved-proposal-fixture.json');
      const executeApprovedStartedRun = JSON.parse(readFileSync(executeApprovedRunPath, 'utf8'));
      if (
        executeApprovedStartedRun.sourceLayout !== 'maintenance'
        || executeApprovedStartedRun.taskId !== executeMonitorApproval.maintenanceTask.taskId
        || !executeApprovedStartedRun.notes.includes(`proposalApproval=${executeMonitorApproval.approvalId}`)
        || !executeApprovedStartedRun.notes.includes(`proposalPatchDraft=${executeMonitorPatchDraft.draftId}`)
      ) {
        console.error(`p2a_execute approval start wrote unexpected run trace: ${caseData.id}`);
        console.error(JSON.stringify({ executeApprovedStartedRun }, null, 2));
        return { status: 1, checks };
      }

      result = runExecute([
        'status',
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent execution status')
        || !result.stdout.includes(`- proposalApproval: ${executeMonitorApproval.approvalId}`)
        || !result.stdout.includes('- runId: run-approved-proposal-fixture')
      ) {
        console.error(`p2a_execute approval status fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeMismatchedRunId = 'run-approved-proposal-mismatch';
      const executeMismatchedTaskId = 'task-999';
      writeFileSync(
        path.join(executeMonitorApprovalArtifactRoot, 'runs', `${executeMismatchedRunId}.json`),
        `${JSON.stringify({
          ...executeApprovedStartedRun,
          runId: executeMismatchedRunId,
          taskId: executeMismatchedTaskId,
          taskTitle: 'Unrelated fixture task',
        }, null, 2)}\n`,
        'utf8'
      );
      result = runExecute([
        'status',
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
        '--run-id',
        executeMismatchedRunId,
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes(`status refused: run ${executeMismatchedRunId} belongs to ${executeMismatchedTaskId}, not approval task ${executeMonitorApproval.maintenanceTask.taskId}`)
      ) {
        console.error(`p2a_execute approval status mismatch fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runExecute([
        'finish',
        '--artifacts',
        executeMonitorApprovalArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
        '--run-id',
        'run-approved-proposal-fixture',
        '--status',
        'finished',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Marking task done')) {
        console.error(`p2a_execute approval finish fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeApprovedFinishedRun = JSON.parse(readFileSync(executeApprovedRunPath, 'utf8'));
      const executeApprovedFinishedGraph = JSON.parse(readFileSync(executeMonitorMaintenanceGraphPath, 'utf8'));
      const executeApprovedFinishedTask = executeApprovedFinishedGraph.tasks.find((task) => task.id === executeMonitorApproval.maintenanceTask.taskId);
      if (
        executeApprovedFinishedRun.status !== 'finished'
        || executeApprovedFinishedTask?.status !== 'done'
      ) {
        console.error(`p2a_execute approval finish wrote unexpected final state: ${caseData.id}`);
        console.error(JSON.stringify({ executeApprovedFinishedRun, executeApprovedFinishedTask }, null, 2));
        return { status: 1, checks };
      }

      const executeFinishTraceRunId = 'run-approval-finish-trace';
      result = runExecute([
        'start',
        '--artifacts',
        executeFinishTraceArtifactRoot,
        '--maintenance',
        '--task',
        executeMonitorApproval.maintenanceTask.taskId,
        '--run-id',
        executeFinishTraceRunId,
        '--agent-tool',
        'codex',
        '--workspace',
        executeFinishTraceArtifactRoot,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes(`Plan2Agent run started: ${executeFinishTraceRunId}`)) {
        console.error(`p2a_execute approval finish trace start fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runExecute([
        'finish',
        '--artifacts',
        executeFinishTraceArtifactRoot,
        '--approval',
        executeMonitorApprovalPath,
        '--run-id',
        executeFinishTraceRunId,
        '--status',
        'finished',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Marking task done')) {
        console.error(`p2a_execute approval finish trace fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeFinishTraceRunPath = path.join(executeFinishTraceArtifactRoot, 'runs', `${executeFinishTraceRunId}.json`);
      const executeFinishTraceRun = JSON.parse(readFileSync(executeFinishTraceRunPath, 'utf8'));
      if (
        !executeFinishTraceRun.notes.includes(`proposalApproval=${executeMonitorApproval.approvalId}`)
        || !executeFinishTraceRun.notes.includes(`proposalPatchDraft=${executeMonitorPatchDraft.draftId}`)
        || !executeFinishTraceRun.notes.includes(`proposalCandidate=${executeMonitorApproval.candidateId}`)
      ) {
        console.error(`p2a_execute approval finish did not write proposal trace: ${caseData.id}`);
        console.error(JSON.stringify({ executeFinishTraceRun }, null, 2));
        return { status: 1, checks };
      }

      const executeFailedGraphPath = path.join(tempRoot, 'p2a-execute-failed', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeFailedGraphPath), { recursive: true });
      writeFileSync(executeFailedGraphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
      result = runExecute([
        'start',
        '--graph',
        executeFailedGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-fixture-failed',
        '--agent-tool',
        'codex',
        '--workspace',
        artifactRoot,
        '--workspace-ref',
        'fixture-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute failed-path start fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runExecute([
        'finish',
        '--graph',
        executeFailedGraphPath,
        '--run-id',
        'run-execute-fixture-failed',
        '--test-command',
        `"${process.execPath}" -e "process.exit(1)"`,
      ]);
      checks += 1;
      const executeFailedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 1 || !executeFailedOutput.includes('- blockReason: verification_failed')) {
        console.error(`p2a_execute failed-path finish fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeSkippedGraphPath = path.join(tempRoot, 'p2a-execute-not-in-progress', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeSkippedGraphPath), { recursive: true });
      writeFileSync(executeSkippedGraphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
      result = runRuns([
        'start',
        '--graph',
        executeSkippedGraphPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-fixture-not-in-progress',
        '--agent-tool',
        'codex',
        '--workspace',
        artifactRoot,
        '--workspace-ref',
        'fixture-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute not-in-progress fixture run start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runExecute([
        'finish',
        '--graph',
        executeSkippedGraphPath,
        '--run-id',
        'run-execute-fixture-not-in-progress',
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
      ]);
      checks += 1;
      const executeSkippedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 1 || !executeSkippedOutput.includes('task transition skipped: task-001 must be in_progress')) {
        console.error(`p2a_execute not-in-progress finish fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      const executeSkippedGraph = JSON.parse(readFileSync(executeSkippedGraphPath, 'utf8'));
      const executeSkippedRun = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-not-in-progress', 'runs', 'run-execute-fixture-not-in-progress.json'), 'utf8'));
      if (
        executeSkippedGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'todo'
        || executeSkippedRun.status !== 'finished'
      ) {
        console.error(`p2a_execute not-in-progress fixture wrote unexpected state: ${caseData.id}`);
        console.error(JSON.stringify({ executeSkippedGraph, executeSkippedRun }, null, 2));
        return { status: 1, checks };
      }

      result = runTasks(['start', '--artifacts', artifactRoot, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks start --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const updatedTaskGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      const startedTask = updatedTaskGraph.tasks.find((task) => task.id === 'task-001');
      if (startedTask?.status !== 'in_progress') {
        console.error(`p2a_tasks start --artifacts did not update active task graph: ${caseData.id}`);
        console.error(JSON.stringify(startedTask, null, 2));
        return { status: 1, checks };
      }

      const fixtureRunId = 'run-fixture-task-001';
      const runsDir = path.join(artifactRoot, 'runs');
      result = runRuns([
        'start',
        '--artifacts',
        artifactRoot,
        '--task',
        'task-001',
        '--run-id',
        fixtureRunId,
        '--agent-tool',
        'codex',
        '--workspace',
        artifactRoot,
        '--workspace-ref',
        'fixture-workspace',
        '--isolation',
        'branch',
        '--branch',
        'p2a/task-001-fixture',
        '--changed-file',
        'src/task-001.ts',
        '--note',
        'Fixture run started.',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes(`Plan2Agent run started: ${fixtureRunId}`)) {
        console.error(`p2a_runs start fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns([
        'verify',
        '--artifacts',
        artifactRoot,
        '--run-id',
        fixtureRunId,
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
        '--lint-command',
        `"${process.execPath}" -e "process.exit(0)"`,
        '--typecheck-command',
        `"${process.execPath}" -e "process.exit(0)"`,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('test: passed') || !result.stdout.includes('typecheck: passed')) {
        console.error(`p2a_runs verify fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns([
        'finish',
        '--artifacts',
        artifactRoot,
        '--run-id',
        fixtureRunId,
        '--status',
        'finished',
        '--changed-file',
        'test/task-001.test.ts',
        '--note',
        'Fixture run finished.',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('- status: finished')) {
        console.error(`p2a_runs finish fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const collectGitWorkspace = path.join(tempRoot, 'collect-git-workspace');
      mkdirSync(path.join(collectGitWorkspace, 'src'), { recursive: true });
      writeFileSync(path.join(collectGitWorkspace, 'src', 'tracked.txt'), 'before\n', 'utf8');
      result = spawnSync('git', ['init'], { cwd: collectGitWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`collect-git fixture git init failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['add', 'src/tracked.txt'], { cwd: collectGitWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`collect-git fixture git add failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Fixture', 'commit', '-m', 'initial'], { cwd: collectGitWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`collect-git fixture git commit failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      writeFileSync(path.join(collectGitWorkspace, 'src', 'tracked.txt'), 'after\n', 'utf8');

      const collectGitRunId = 'run-fixture-collect-git';
      result = runRuns([
        'start',
        '--artifacts',
        artifactRoot,
        '--task',
        'task-001',
        '--run-id',
        collectGitRunId,
        '--agent-tool',
        'codex',
        '--workspace',
        collectGitWorkspace,
        '--workspace-ref',
        'collect-git-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs collect-git fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns([
        'finish',
        '--artifacts',
        artifactRoot,
        '--run-id',
        collectGitRunId,
        '--status',
        'finished',
        '--workspace',
        collectGitWorkspace,
        '--collect-git',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('- changedFiles: 1')) {
        console.error(`p2a_runs collect-git fixture finish failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const collectGitRun = JSON.parse(readFileSync(path.join(runsDir, `${collectGitRunId}.json`), 'utf8'));
      if (collectGitRun.changedFiles.join(',') !== 'src/tracked.txt') {
        console.error(`p2a_runs collect-git fixture wrote unexpected changed files: ${caseData.id}`);
        console.error(JSON.stringify(collectGitRun, null, 2));
        return { status: 1, checks };
      }

      const failedRunId = 'run-fixture-failed';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', failedRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs failed fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', failedRunId, '--status', 'failed']);
      checks += 1;
      const missingFailureOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !missingFailureOutput.includes('--failure-class is required')) {
        console.error(`p2a_runs did not reject failed finish without failure class: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', failedRunId, '--status', 'failed', '--failure-class', 'verification_failed']);
      checks += 1;
      if (result.status !== 1 || !result.stdout.includes('failure: verification_failed retryable=after_fix needsUserDecision=false source=owner')) {
        console.error(`p2a_runs failed fixture did not record verification_failed defaults: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const blockedRunId = 'run-fixture-blocked';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', blockedRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs blocked fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', blockedRunId, '--status', 'blocked', '--failure-class', 'implementation_incomplete', '--failure-source', 'monitor']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('failure: implementation_incomplete retryable=after_fix needsUserDecision=false source=monitor')) {
        console.error(`p2a_runs blocked fixture did not record monitor implementation_incomplete failure: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['block', '--artifacts', artifactRoot, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('- blockReason: implementation_incomplete')) {
        console.error(`p2a_tasks block did not mirror latest run failure class: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const graphBlockedRunId = 'run-fixture-graph-blocked';
      result = runRuns(['start', '--graph', state.taskGraphPath, '--task', 'task-001', '--run-id', graphBlockedRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs --graph blocked fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns(['finish', '--graph', state.taskGraphPath, '--run-id', graphBlockedRunId, '--status', 'blocked', '--failure-class', 'missing_dependency']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('failure: missing_dependency retryable=after_fix needsUserDecision=true source=owner')) {
        console.error(`p2a_runs --graph blocked fixture did not record missing_dependency failure: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['block', '--graph', state.taskGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('- blockReason: missing_dependency')) {
        console.error(`p2a_tasks block --graph did not mirror latest run failure class: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const graphBlockedTaskGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      if (graphBlockedTaskGraph.tasks.find((task) => task.id === 'task-001')?.blockReason !== 'missing_dependency') {
        console.error(`p2a_tasks block --graph did not persist blockReason: ${caseData.id}`);
        console.error(JSON.stringify(graphBlockedTaskGraph.tasks.find((task) => task.id === 'task-001'), null, 2));
        return { status: 1, checks };
      }

      const finishedFailureFlagRunId = 'run-fixture-finished-with-failure-flag';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedFailureFlagRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs finished failure flag fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedFailureFlagRunId, '--status', 'finished', '--failure-class', 'verification_failed']);
      checks += 1;
      const explicitFinishedFailureOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !explicitFinishedFailureOutput.includes('failure options are only valid when the run finishes as failed or blocked (got finished)')) {
        console.error(`p2a_runs did not reject explicit finished status with failure options: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedFailureFlagRunId, '--failure-class', 'verification_failed']);
      checks += 1;
      const derivedFinishedFailureOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !derivedFinishedFailureOutput.includes('failure options are only valid when the run finishes as failed or blocked (got finished)')) {
        console.error(`p2a_runs did not reject derived finished status with failure options: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const otherRunId = 'run-fixture-other';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', otherRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs other fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', otherRunId, '--status', 'failed', '--failure-class', 'other']);
      checks += 1;
      const otherMissingNoteOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !otherMissingNoteOutput.includes('requires at least one --note')) {
        console.error(`p2a_runs did not reject other without note: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', otherRunId, '--status', 'failed', '--failure-class', 'other', '--note', 'Fixture cannot classify this failure.']);
      checks += 1;
      if (result.status !== 1 || !result.stdout.includes('failure: other retryable=no needsUserDecision=true source=owner')) {
        console.error(`p2a_runs other fixture did not record defaults with note: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runValidator(['--runs-dir', runsDir]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const fixtureRun = JSON.parse(readFileSync(path.join(runsDir, `${fixtureRunId}.json`), 'utf8'));
      const fixtureRunIndex = JSON.parse(readFileSync(path.join(runsDir, 'run-index.json'), 'utf8'));
      if (
        fixtureRun.agentTool !== 'codex'
        || fixtureRun.workspaceRef !== 'fixture-workspace'
        || fixtureRun.isolation.mode !== 'branch'
        || fixtureRun.changedFiles.join(',') !== 'src/task-001.ts,test/task-001.test.ts'
        || fixtureRun.verification.length !== 3
        || !fixtureRun.verification.every((item) => item.status === 'passed')
        || fixtureRunIndex.tasks.find((task) => task.taskId === 'task-001')?.latestRunId !== otherRunId
      ) {
        console.error(`p2a_runs wrote unexpected run log fixture: ${caseData.id}`);
        console.error(JSON.stringify({ fixtureRun, fixtureRunIndex }, null, 2));
        return { status: 1, checks };
      }

      for (const task of updatedTaskGraph.tasks) task.status = 'done';
      writeFileSync(state.taskGraphPath, `${JSON.stringify(updatedTaskGraph, null, 2)}\n`, 'utf8');
      const closedBaselineTaskGraph = JSON.parse(JSON.stringify(updatedTaskGraph));
      const closedBaselineReviewPath = state.reviewPath;
      const closedBaselineReviewReportPath = path.join(path.dirname(state.reviewPath), 'review-report.md');
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('close-ready: all tasks done')) {
        console.error(`iteration close-ready fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-skip-close', '--idea', 'Should not open before close']);
      checks += 1;
      const skipCloseOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !skipCloseOpenOutput.includes('archived by `p2a_iteration close`')) {
        console.error(`iteration open fixture did not require archived close metadata: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['close', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration closed')) {
        console.error(`iteration close fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const closedMetadata = JSON.parse(readFileSync(path.join(artifactRoot, 'iterations', state.activeIteration, 'iteration.json'), 'utf8'));
      const closedCurrentSpec = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
      const closedSpecAudit = closedMetadata.close?.artifact_hashes?.['iterations/v1-mvp/gate-b-spec/spec.json'];
      if (
        closedMetadata.status !== 'archived'
        || closedMetadata.close?.iteration_id !== state.activeIteration
        || closedSpecAudit?.present !== true
        || typeof closedSpecAudit?.sha256 !== 'string'
        || closedCurrentSpec.active_iteration !== state.activeIteration
        || closedCurrentSpec.last_closed_iteration?.iteration_id !== state.activeIteration
        || !closedCurrentSpec.closed_iterations?.some((closed) => closed.iteration_id === state.activeIteration)
      ) {
        console.error(`iteration close did not persist archived metadata: ${caseData.id}`);
        console.error(JSON.stringify({ closedMetadata, closedCurrentSpec }, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready', '--audit-archive']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('archived audit: 1 closed iteration(s) verified')) {
        console.error(`iteration archive audit fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('archived audit: 1 closed iteration(s) verified')) {
        console.error(`iteration default archive audit fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const lateArtifactRef = 'iterations/v1-mvp/gate-d-review/late-note.md';
      const lateArtifactPath = path.join(artifactRoot, lateArtifactRef);
      const auditCurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      auditCurrentSpec.closed_iterations[0].artifact_hashes[lateArtifactRef] = { present: false, sha256: null };
      writeFileSync(state.currentSpecPath, `${JSON.stringify(auditCurrentSpec, null, 2)}\n`, 'utf8');
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready', '--audit-archive']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration archive audit should accept missing artifact marker: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      writeFileSync(lateArtifactPath, '# Late note\n', 'utf8');
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready', '--audit-archive']);
      checks += 1;
      const lateAuditOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !lateAuditOutput.includes('artifact appeared after close')) {
        console.error(`iteration archive audit did not reject artifact appearance after close: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      unlinkSync(lateArtifactPath);

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-002', '--idea', 'Add follow-up webhook delivery dashboard']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration opened')) {
        console.error(`iteration open fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current after open fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      try {
        state = JSON.parse(result.stdout);
        assertAbsoluteStatePaths(state);
      } catch (error) {
        console.error(`iteration current after open returned invalid JSON contract: ${caseData.id}`);
        console.error(error.message);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      if (state.activeIteration !== 'iter-002' || !existsSync(path.join(artifactRoot, 'iterations', 'iter-002', 'iteration.json'))) {
        console.error(`iteration open did not update active iteration skeleton: ${caseData.id}`);
        console.error(JSON.stringify(state, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot]);
      checks += 1;
      const openValidateOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !openValidateOutput.includes('gate-b-spec/spec.json')) {
        console.error(`iteration validate did not reject open skeleton without Gate B-D artifacts: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated')) {
        console.error(`iteration draft fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const draftIntakePath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-a-intake', 'intake.json');
      const draftSpecPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-b-spec', 'spec.json');
      result = runValidator(['--intake', draftIntakePath, '--spec', draftSpecPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration draft Gate A/B artifact validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const draftCurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (draftCurrentSpec.pending_iteration?.status !== 'gate_b_draft' || draftCurrentSpec.effective_spec_ref !== 'iterations/v1-mvp/gate-b-spec/spec.json') {
        console.error(`iteration draft did not preserve baseline pointer with Gate B draft status: ${caseData.id}`);
        console.error(JSON.stringify(draftCurrentSpec, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot]);
      checks += 1;
      const draftValidateOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !draftValidateOutput.includes('gate-c-task-graph/task-graph.json')) {
        console.error(`iteration validate did not reject Gate A/B draft without Gate C/D artifacts: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--allow-planning']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('stage: gate-b-draft')) {
        console.error(`iteration planning validate did not accept Gate B draft fixture: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const draftStatusText = readFileSync(path.join(artifactRoot, 'status.md'), 'utf8');
      writeFileSync(
        path.join(artifactRoot, 'status.md'),
        '# broken planning status\n\n<!-- p2a:active-iteration=iter-002 -->\n',
        'utf8',
      );
      result = runIteration(['validate', '--artifacts', artifactRoot, '--allow-planning']);
      checks += 1;
      const brokenPlanningStatusOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !brokenPlanningStatusOutput.includes('status.md missing Progress line')) {
        console.error(`iteration planning validate did not reject broken status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), draftStatusText, 'utf8');
        return { status: 1, checks };
      }
      writeFileSync(path.join(artifactRoot, 'status.md'), draftStatusText, 'utf8');

      const approvedDraftSpec = JSON.parse(readFileSync(draftSpecPath, 'utf8'));
      approvedDraftSpec.approval = 'approved';
      writeFileSync(draftSpecPath, `${JSON.stringify(approvedDraftSpec, null, 2)}\n`, 'utf8');
      const iter2TaskGraphPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-c-task-graph', 'task-graph.json');
      const iter2ReviewPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-d-review', 'review.json');
      const iter2ReviewReportPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-d-review', 'review-report.md');

      result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('active spec promoted')) {
        console.error(`iteration promote-spec fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const promotedIter2CurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (
        promotedIter2CurrentSpec.effective_spec_ref !== 'iterations/v1-mvp/gate-b-spec/spec.json'
        || JSON.stringify(promotedIter2CurrentSpec.composed_from) !== JSON.stringify(['v1-mvp'])
        || promotedIter2CurrentSpec.pending_iteration?.status !== 'gate_b_approved'
      ) {
        console.error(`iteration promote-spec should preserve baseline composition before compose: ${caseData.id}`);
        console.error(JSON.stringify(promotedIter2CurrentSpec, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-b-approved']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('stage: gate-b-approved')) {
        console.error(`iteration planning validate did not accept promoted Gate B fixture: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['diff-tasks', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('diff task graph generated')) {
        console.error(`iteration diff-tasks fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      let iter2TaskGraph = JSON.parse(readFileSync(iter2TaskGraphPath, 'utf8'));
      if (iter2TaskGraph.sourceSpec !== '../gate-b-spec/spec.json' || !iter2TaskGraph.tasks.length) {
        console.error(`iteration diff-tasks wrote invalid task graph fixture: ${caseData.id}`);
        console.error(JSON.stringify(iter2TaskGraph, null, 2));
        return { status: 1, checks };
      }
      const iter2VerificationTask = iter2TaskGraph.tasks.find((task) => task.targetArea === 'verification');
      const iter2ImplementationTaskIds = iter2TaskGraph.tasks
        .filter((task) => task.targetArea !== 'verification')
        .map((task) => task.id);
      if (
        iter2TaskGraph.tasks.length >= 16
        || !iter2VerificationTask
        || JSON.stringify(iter2VerificationTask.dependencies) !== JSON.stringify(iter2ImplementationTaskIds)
        || !iter2TaskGraph.tasks.some((task) => task.title.startsWith('Rework '))
        || !iter2TaskGraph.tasks.some((task) => task.description.includes('Rework previous completed task'))
      ) {
        console.error(`iteration diff-tasks did not generate expected semantic/rework graph: ${caseData.id}`);
        console.error(JSON.stringify(iter2TaskGraph, null, 2));
        return { status: 1, checks };
      }

      const originalSemanticTaskIds = iter2TaskGraph.tasks.map((task) => task.id);
      result = runIteration(['diff-tasks', '--artifacts', artifactRoot, '--force']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('reused active tasks:')) {
        console.error(`iteration diff-tasks --force reuse fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      iter2TaskGraph = JSON.parse(readFileSync(iter2TaskGraphPath, 'utf8'));
      if (
        JSON.stringify(iter2TaskGraph.tasks.map((task) => task.id)) !== JSON.stringify(originalSemanticTaskIds)
        || !iter2TaskGraph.tasks.some((task) => task.description.includes('Reuses existing active task id'))
      ) {
        console.error(`iteration diff-tasks --force did not reuse active semantic tasks: ${caseData.id}`);
        console.error(JSON.stringify(iter2TaskGraph, null, 2));
        return { status: 1, checks };
      }
      for (const task of iter2TaskGraph.tasks) task.status = 'done';
      writeFileSync(iter2TaskGraphPath, `${JSON.stringify(iter2TaskGraph, null, 2)}\n`, 'utf8');
      cpSync(closedBaselineReviewPath, iter2ReviewPath);
      cpSync(closedBaselineReviewReportPath, iter2ReviewReportPath);
      const iter2Review = JSON.parse(readFileSync(iter2ReviewPath, 'utf8'));
      iter2Review.sourceSpec = '../gate-b-spec/spec.json';
      iter2Review.sourceTaskGraph = '../gate-c-task-graph/task-graph.json';
      writeFileSync(iter2ReviewPath, `${JSON.stringify(iter2Review, null, 2)}\n`, 'utf8');

      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('close-ready: all tasks done')) {
        console.error(`iteration validate did not accept approved Gate A-D iter-002 fixture: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-skip-close-2', '--idea', 'Should not open iter-003 before iter-002 close']);
      checks += 1;
      const skipIter2CloseOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !skipIter2CloseOpenOutput.includes('open requires no pending_iteration')) {
        console.error(`iteration open fixture did not require iter-002 archived close metadata: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['close', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration closed')) {
        console.error(`iteration close iter-002 fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const iter2ClosedCurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (
        iter2ClosedCurrentSpec.last_closed_iteration?.iteration_id !== 'iter-002'
        || !iter2ClosedCurrentSpec.closed_iterations?.some((closed) => closed.iteration_id === 'iter-002')
      ) {
        console.error(`iteration close iter-002 did not persist closed metadata: ${caseData.id}`);
        console.error(JSON.stringify(iter2ClosedCurrentSpec, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-before-compose', '--idea', 'Should not open before composition']);
      checks += 1;
      const beforeComposeOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !beforeComposeOpenOutput.includes('run `p2a_iteration compose` first')) {
        console.error(`iteration open fixture did not require composition after multiple closes: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const iter2MetadataPath = path.join(artifactRoot, 'iterations', 'iter-002', 'iteration.json');
      const originalIter2MetadataText = readFileSync(iter2MetadataPath, 'utf8');
      const currentSpecBeforeConflictCompose = readFileSync(state.currentSpecPath, 'utf8');
      const conflictIter2Metadata = JSON.parse(originalIter2MetadataText);
      conflictIter2Metadata.baseline.effective_spec_ref = 'iterations/non-existent/gate-b-spec/spec.json';
      writeFileSync(iter2MetadataPath, `${JSON.stringify(conflictIter2Metadata, null, 2)}\n`, 'utf8');
      result = runIteration(['compose', '--artifacts', artifactRoot]);
      checks += 1;
      const conflictComposeOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !conflictComposeOutput.includes('rerun with --allow-conflicts')
        || readFileSync(state.currentSpecPath, 'utf8') !== currentSpecBeforeConflictCompose
      ) {
        console.error(`iteration compose conflict fixture did not fail without mutating current-spec: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      result = runIteration(['compose', '--artifacts', artifactRoot, '--allow-conflicts']);
      checks += 1;
      const allowedConflictComposeCurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (
        result.status !== 0
        || !result.stdout.includes('current spec composed with conflicts')
        || !allowedConflictComposeCurrentSpec.open_decisions?.length
      ) {
        console.error(`iteration compose --allow-conflicts fixture did not write conflict decisions: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      writeFileSync(state.currentSpecPath, currentSpecBeforeConflictCompose, 'utf8');
      writeFileSync(iter2MetadataPath, originalIter2MetadataText, 'utf8');

      result = runIteration(['compose', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('current spec composed')) {
        console.error(`iteration compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const composedCurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (
        composedCurrentSpec.effective_spec_ref !== 'current-spec.json'
        || JSON.stringify(composedCurrentSpec.composed_from) !== JSON.stringify(['v1-mvp', 'iter-002'])
        || composedCurrentSpec.source_specs?.length !== 2
        || !composedCurrentSpec.closed_iterations?.some((closed) => closed.iteration_id === 'v1-mvp')
        || !composedCurrentSpec.closed_iterations?.some((closed) => closed.iteration_id === 'iter-002')
        || !composedCurrentSpec.effective_product
        || !composedCurrentSpec.effective_implementation
        || !Array.isArray(composedCurrentSpec.superseded_refs)
        || composedCurrentSpec.pending_iteration
      ) {
        console.error(`iteration compose did not write expected current-spec composition: ${caseData.id}`);
        console.error(JSON.stringify(composedCurrentSpec, null, 2));
        return { status: 1, checks };
      }

      const maintenanceGraphPath = path.join(artifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Update maintenance note',
        '--description',
        'Fixture maintenance task used to verify maintenance graph validation.',
        '--accept',
        'Maintenance graph validates inside the iterative root.',
        '--prompt',
        'Validate the maintenance graph path and schema.',
        '--ref',
        'effective_product.problem',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent maintenance task added: task-001') || !existsSync(maintenanceGraphPath)) {
        console.error(`iteration maintenance add lazy-create fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Fix maintenance typo',
        '--accept',
        'Typo is fixed.',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent maintenance task added: task-002')) {
        console.error(`iteration maintenance add append fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const maintenanceGraphAfterAddsText = readFileSync(maintenanceGraphPath, 'utf8');
      const maintenanceGraphAfterAdds = JSON.parse(maintenanceGraphAfterAddsText);
      if (
        maintenanceGraphAfterAdds.tasks?.length !== 2
        || maintenanceGraphAfterAdds.version !== 'maintenance'
        || maintenanceGraphAfterAdds.sourceSpec !== '../../../current-spec.json'
        || JSON.stringify(maintenanceGraphAfterAdds.tasks[0].sourceSpecRefs) !== JSON.stringify(['effective_product.problem'])
        || JSON.stringify(maintenanceGraphAfterAdds.tasks[1].sourceSpecRefs) !== JSON.stringify(['maintenance'])
      ) {
        console.error(`iteration maintenance add wrote unexpected graph: ${caseData.id}`);
        console.error(JSON.stringify(maintenanceGraphAfterAdds, null, 2));
        return { status: 1, checks };
      }

      result = runTasks(['list', '--artifacts', artifactRoot, '--maintenance']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001') || !result.stdout.includes('task-002')) {
        console.error(`p2a_tasks list --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['ready', '--artifacts', artifactRoot, '--maintenance']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`p2a_tasks ready --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const activeTaskGraphBeforeMaintenanceStartText = readFileSync(state.taskGraphPath, 'utf8');
      result = runTasks(['start', '--artifacts', artifactRoot, '--maintenance', 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('status is now in_progress')) {
        console.error(`p2a_tasks start --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const maintenanceGraphAfterStartText = readFileSync(maintenanceGraphPath, 'utf8');
      const maintenanceGraphAfterStart = JSON.parse(maintenanceGraphAfterStartText);
      if (
        maintenanceGraphAfterStart.tasks?.find((task) => task.id === 'task-001')?.status !== 'in_progress'
        || maintenanceGraphAfterStartText === maintenanceGraphAfterAddsText
        || readFileSync(state.taskGraphPath, 'utf8') !== activeTaskGraphBeforeMaintenanceStartText
      ) {
        console.error(`p2a_tasks start --artifacts --maintenance did not isolate graph writes: ${caseData.id}`);
        console.error(JSON.stringify(maintenanceGraphAfterStart, null, 2));
        return { status: 1, checks };
      }

      result = runTasks(['ready', '--graph', maintenanceGraphPath, '--maintenance']);
      checks += 1;
      const maintenanceGraphOptionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !maintenanceGraphOptionOutput.includes('--maintenance is only supported with --artifacts')) {
        console.error(`p2a_tasks fixture did not reject graph/maintenance inputs: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const freshRootParent = mkdtempSync(path.join(tmpdir(), 'p2a-no-maintenance-'));
      const freshRoot = path.join(freshRootParent, 'artifacts');
      cpSync(artifactRoot, freshRoot, { recursive: true });
      rmSync(path.join(freshRoot, 'iterations', 'maintenance', 'gate-c-task-graph'), { recursive: true, force: true });
      result = runTasks(['ready', '--artifacts', freshRoot, '--maintenance']);
      checks += 1;
      const missingMaintenanceOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      rmSync(freshRootParent, { recursive: true, force: true });
      if (result.status === 0 || !missingMaintenanceOutput.includes('no maintenance task graph yet; create one with:')) {
        console.error(`p2a_tasks fixture did not report missing maintenance graph: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(maintenanceGraphPath, maintenanceGraphAfterAddsText, 'utf8');

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Missing accept should fail',
      ]);
      checks += 1;
      if (result.status === 0 || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterAddsText) {
        console.error(`iteration maintenance add missing --accept negative check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Unknown dependency should fail',
        '--accept',
        'Unknown dependency is rejected.',
        '--depends',
        'task-999',
      ]);
      checks += 1;
      if (result.status === 0 || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterAddsText) {
        console.error(`iteration maintenance add unknown dependency negative check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--audit-archive']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('archived audit: 2 closed iteration(s) verified')
        || !result.stdout.includes('maintenance: 2 task(s) valid')
      ) {
        console.error(`iteration archive audit after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      try {
        state = JSON.parse(result.stdout);
        assertAbsoluteStatePaths(state);
      } catch (error) {
        console.error(`iteration current after compose returned invalid JSON contract: ${caseData.id}`);
        console.error(error.message);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      if (state.effectiveSpecPath !== state.currentSpecPath) {
        console.error(`iteration current after compose did not resolve effective spec to current-spec.json: ${caseData.id}`);
        console.error(JSON.stringify(state, null, 2));
        return { status: 1, checks };
      }

      const iterationDryRunTargetRoot = path.join(tempRoot, 'target-iteration-dry-run');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        artifactRoot,
        '--target',
        iterationDryRunTargetRoot,
        '--iteration-id',
        'active',
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('sourceIterationId: iter-002')
        || !result.stdout.includes('copy+rewrite:')
        || !result.stdout.includes('gate-b-spec/spec.json -> .plan2agent/artifacts/spec.json')
      ) {
        console.error(`iteration handoff --iteration-id active dry-run fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const iterationTargetRoot = path.join(tempRoot, 'target-iteration-handoff');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        artifactRoot,
        '--target',
        iterationTargetRoot,
        '--include-intake',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff active default fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const targetCurrentSpecPath = path.join(iterationTargetRoot, '.plan2agent', 'current-spec.json');
      const targetManifestPath = path.join(iterationTargetRoot, '.plan2agent', 'manifest.json');
      const targetTaskGraphPath = path.join(iterationTargetRoot, '.plan2agent', 'artifacts', 'task-graph.json');
      const targetSpecPath = path.join(iterationTargetRoot, '.plan2agent', 'artifacts', 'spec.json');
      const targetMaintenanceGraphPath = path.join(iterationTargetRoot, '.plan2agent', 'maintenance', 'task-graph.json');
      if (
        !existsSync(targetCurrentSpecPath)
        || !existsSync(targetSpecPath)
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'artifacts', 'intake.json'))
        || !existsSync(targetMaintenanceGraphPath)
        || !existsSync(path.join(iterationTargetRoot, 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(iterationTargetRoot, 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(iterationTargetRoot, 'scripts', 'p2a_execute.mjs'))
        || !existsSync(path.join(iterationTargetRoot, 'scripts', 'p2a_orchestrate.mjs'))
        || !existsSync(path.join(iterationTargetRoot, 'scripts', 'p2a_proposals.mjs'))
        || !existsSync(path.join(iterationTargetRoot, 'schemas', 'run-index.schema.json'))
        || !existsSync(path.join(iterationTargetRoot, 'schemas', 'orchestration-plan.schema.json'))
        || !existsSync(path.join(iterationTargetRoot, 'schemas', 'orchestration-runtime.schema.json'))
      ) {
        console.error(`iteration handoff did not copy active artifacts/current-spec/tools: ${caseData.id}`);
        return { status: 1, checks };
      }
      const targetManifest = JSON.parse(readFileSync(targetManifestPath, 'utf8'));
      const targetCurrentSpec = JSON.parse(readFileSync(targetCurrentSpecPath, 'utf8'));
      const sourceCurrentSpecAfterHandoff = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
      const targetTaskGraph = JSON.parse(readFileSync(targetTaskGraphPath, 'utf8'));
      const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
      if (
        targetManifest.sourceLayout !== 'iteration'
        || targetManifest.sourceIterationId !== 'iter-002'
        || targetManifest.currentSpecFile !== '.plan2agent/current-spec.json'
        || JSON.stringify(targetManifest.maintenanceFiles) !== JSON.stringify(['.plan2agent/maintenance/task-graph.json'])
        || !targetManifest.includedTools.includes('p2a_runs')
        || !targetManifest.includedTools.includes('p2a_execute')
        || !targetManifest.includedTools.includes('p2a_orchestrate')
        || !targetManifest.includedTools.includes('p2a_proposals')
        || !targetManifest.toolFiles.includes('scripts/p2a_runs.mjs')
        || !targetManifest.toolFiles.includes('scripts/p2a_execute.mjs')
        || !targetManifest.toolFiles.includes('scripts/p2a_orchestrate.mjs')
        || !targetManifest.toolFiles.includes('scripts/p2a_proposals.mjs')
        || !targetManifest.schemaFiles.includes('schemas/task-context.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/run-index.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/orchestration-plan.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/orchestration-runtime.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/skill-proposal.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/proposal-review.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/proposal-curation.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/proposal-patch-draft.schema.json')
        || !targetManifest.schemaFiles.includes('schemas/proposal-draft-approval.schema.json')
        || targetCurrentSpec.last_handoff?.iteration_id !== 'iter-002'
        || targetCurrentSpec.last_handoff?.maintenance_included !== true
        || sourceCurrentSpecAfterHandoff.last_handoff?.target_project !== iterationTargetRoot
        || targetTaskGraph.sourceSpec !== 'spec.json'
        || targetSpec.source_intake !== 'intake.json'
      ) {
        console.error(`iteration handoff manifest/task graph contract mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ targetManifest, targetCurrentSpec, sourceCurrentSpecAfterHandoff, targetTaskGraphSourceSpec: targetTaskGraph.sourceSpec, targetSpecSourceIntake: targetSpec.source_intake }, null, 2));
        return { status: 1, checks };
      }

      result = assertTargetSpecSourceIntake(iterationTargetRoot, caseData.id, 'iteration');
      checks += 1;
      if (result.status !== 0) return { status: result.status, checks };

      result = runTargetTasks(iterationTargetRoot, ['ready', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target p2a_tasks execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetRuns(iterationTargetRoot, ['list', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('runId')) {
        console.error(`iteration handoff target p2a_runs execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetExecute(iterationTargetRoot, ['status', '--graph', targetTaskGraphPath, '--task', 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent execution status')) {
        console.error(`iteration handoff target p2a_execute execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-003', '--idea', 'Add composed baseline reporting']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration opened')) {
        console.error(`iteration open after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated')) {
        console.error(`iteration draft from composed current-spec fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const iter3SpecPath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-b-spec', 'spec.json');
      const iter3IntakePath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-a-intake', 'intake.json');
      result = runValidator(['--intake', iter3IntakePath, '--spec', iter3SpecPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration draft from composed baseline Gate A/B validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const approvedIter3Spec = JSON.parse(readFileSync(iter3SpecPath, 'utf8'));
      approvedIter3Spec.approval = 'approved';
      writeFileSync(iter3SpecPath, `${JSON.stringify(approvedIter3Spec, null, 2)}\n`, 'utf8');
      result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('active spec promoted')) {
        console.error(`iteration promote-spec after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-b-approved']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('stage: gate-b-approved')) {
        console.error(`iteration planning validate after composed promote-spec failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const promotedIter3CurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      if (
        JSON.stringify(promotedIter3CurrentSpec.composed_from) !== JSON.stringify(['v1-mvp', 'iter-002'])
        || promotedIter3CurrentSpec.source_specs?.length !== 2
        || promotedIter3CurrentSpec.pending_iteration?.status !== 'gate_b_approved'
      ) {
        console.error(`iteration promote-spec after compose should preserve composed source set: ${caseData.id}`);
        console.error(JSON.stringify(promotedIter3CurrentSpec, null, 2));
        return { status: 1, checks };
      }

      const contextCodeRoot = path.join(tempRoot, 'context-code-root');
      mkdirSync(path.join(contextCodeRoot, 'src'), { recursive: true });
      mkdirSync(path.join(contextCodeRoot, '.plan2agent', 'scripts'), { recursive: true });
      mkdirSync(path.join(contextCodeRoot, 'scripts'), { recursive: true });
      writeFileSync(path.join(contextCodeRoot, 'src', 'Demo.kt'), 'class Demo\n', 'utf8');
      writeFileSync(path.join(contextCodeRoot, '.plan2agent', 'scripts', 'ignored.js'), 'ignored\n', 'utf8');
      writeFileSync(path.join(contextCodeRoot, 'scripts', 'ignored.js'), 'ignored\n', 'utf8');

      const contextRunsDir = path.join(artifactRoot, 'runs');
      mkdirSync(contextRunsDir, { recursive: true });
      const contextRun = {
        schema_version: 'p2a.run.v1',
        runId: 'run-context-fixture',
        projectId: caseData.project_id,
        taskId: 'task-001',
        taskTitle: 'Context fixture run',
        iterationId: 'iter-003',
        sourceLayout: 'iteration',
        taskGraphRef: 'iterations/iter-003/gate-c-task-graph/task-graph.json',
        sourceSpecRef: 'iterations/iter-003/gate-b-spec/spec.json',
        agentTool: 'fixture',
        workspaceRef: 'fixture-workspace',
        workspacePath: contextCodeRoot,
        isolation: {
          mode: 'none',
          branch: null,
          worktree: null,
          baseRef: null,
          created: false,
          createCommand: null,
          createExitCode: null,
          createOutputTail: null,
        },
        status: 'finished',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        changedFiles: ['src/Demo.kt'],
        verification: [],
        notes: ['fixture run'],
      };
      writeFileSync(path.join(contextRunsDir, 'run-context-fixture.json'), `${JSON.stringify(contextRun, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(contextRunsDir, 'run-index.json'), `${JSON.stringify({
        schema_version: 'p2a.run_index.v1',
        projectId: caseData.project_id,
        runs: [{
          runId: contextRun.runId,
          taskId: contextRun.taskId,
          iterationId: contextRun.iterationId,
          status: contextRun.status,
          agentTool: contextRun.agentTool,
          workspaceRef: contextRun.workspaceRef,
          taskGraphRef: contextRun.taskGraphRef,
          runRef: 'run-context-fixture.json',
          startedAt: contextRun.startedAt,
          finishedAt: contextRun.finishedAt,
        }],
        tasks: [{ taskId: contextRun.taskId, runIds: [contextRun.runId], latestRunId: contextRun.runId }],
      }, null, 2)}\n`, 'utf8');

      result = runIteration(['context', '--artifacts', artifactRoot, '--code-root', contextCodeRoot]);
      checks += 1;
      try {
        const taskContext = JSON.parse(result.stdout);
        if (
          result.status !== 0
          || taskContext.schema_version !== 'p2a.task_context.v1'
          || taskContext.active_iteration !== 'iter-003'
          || !taskContext.effective_spec
          || !taskContext.existing_tasks
          || !taskContext.code_signals
        ) {
          throw new Error('context JSON contract mismatch');
        }
        validateTaskContextData(taskContext);
        if (taskContext.idea === undefined || taskContext.baseline_effective_spec_ref === undefined) {
          throw new Error('context JSON contract mismatch');
        }
        const codeSignals = taskContext.code_signals;
        const codeSignalKeys = Object.keys(codeSignals).sort();
        if (JSON.stringify(codeSignalKeys) !== JSON.stringify(['code_root', 'file_tree', 'recent_changes', 'truncated'])) {
          throw new Error('context code_signals keys mismatch');
        }
        if (!codeSignals.file_tree.includes('src/Demo.kt')) {
          throw new Error('context code_signals file_tree missing src/Demo.kt');
        }
        if (codeSignals.file_tree.some((filePath) => filePath.includes('.plan2agent') || filePath.startsWith('scripts/'))) {
          throw new Error('context code_signals file_tree included excluded directories');
        }
        const recentChange = codeSignals.recent_changes.find((change) => change.runId === 'run-context-fixture');
        if (!recentChange || recentChange.taskId !== 'task-001' || !recentChange.changedFiles.includes('src/Demo.kt')) {
          throw new Error('context code_signals recent_changes missing fixture run');
        }
      } catch (error) {
        console.error(`iteration context fixture check failed: ${caseData.id}`);
        console.error(error.message);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const iter3TaskGraphPath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-c-task-graph', 'task-graph.json');
      const iter3DraftPath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-c-task-graph', 'task-graph.draft.json');
      const iter3Draft = JSON.parse(JSON.stringify(iter2TaskGraph));
      iter3Draft.version = 'iter-003-draft';
      iter3Draft.sourceSpec = '../gate-b-spec/spec.json';
      iter3Draft.tasks = iter3Draft.tasks.slice(0, 2).map((task, index) => ({
        ...task,
        id: `task-${String(index + 1).padStart(3, '0')}`,
        status: 'todo',
        dependencies: index === 0 ? [] : ['task-001'],
      }));
      writeFileSync(iter3DraftPath, `${JSON.stringify(iter3Draft, null, 2)}\n`, 'utf8');
      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-c-draft']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('gate-c draft valid')) {
        console.error(`iteration gate-c-draft positive fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const cycleDraft = JSON.parse(JSON.stringify(iter3Draft));
      cycleDraft.tasks[0].dependencies = [cycleDraft.tasks[1].id];
      cycleDraft.tasks[1].dependencies = [cycleDraft.tasks[0].id];
      writeFileSync(iter3DraftPath, `${JSON.stringify(cycleDraft, null, 2)}\n`, 'utf8');
      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-c-draft']);
      checks += 1;
      const cycleDraftOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !cycleDraftOutput.includes('dependency cycle')) {
        console.error(`iteration gate-c-draft cycle fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(iter3DraftPath, `${JSON.stringify(iter3Draft, null, 2)}\n`, 'utf8');

      result = runIteration(['promote-tasks', '--artifacts', artifactRoot]);
      checks += 1;
      const promoteTasksNoAuditOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !promoteTasksNoAuditOutput.includes('Gate C approval audit block required')
        || existsSync(iter3TaskGraphPath)
        || !existsSync(iter3DraftPath)
      ) {
        console.error(`iteration promote-tasks missing audit fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeFileSync(
        path.join(artifactRoot, 'status.md'),
        `${readFileSync(path.join(artifactRoot, 'status.md'), 'utf8')}\n#### Gate C approval audit\n- Approved by: user\n- Approved at: 2026-06-15\n- Approved source: gate-c-task-graph/task-graph.draft.json (agent-authored)\n- Authoring agent: codex / p2a-task-author\n- Approval note: Fixture reviewed the Gate C draft task graph.\n`,
        'utf8',
      );
      result = runIteration(['promote-tasks', '--artifacts', artifactRoot]);
      checks += 1;
      const promotedDraftPath = `${iter3DraftPath}.promoted`;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent tasks promoted')
        || !existsSync(iter3TaskGraphPath)
        || existsSync(iter3DraftPath)
        || !existsSync(promotedDraftPath)
      ) {
        console.error(`iteration promote-tasks positive fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const promotedTaskGraph = JSON.parse(readFileSync(iter3TaskGraphPath, 'utf8'));
      const iter3DraftMetaPath = path.join(path.dirname(iter3TaskGraphPath), 'task-graph.draft.meta.json');
      try {
        validateTaskGraphData(promotedTaskGraph, iter3SpecPath);
      } catch (error) {
        console.error(`iteration promoted task graph did not validate: ${caseData.id}`);
        console.error(error.message);
        return { status: 1, checks };
      }
      if (promotedTaskGraph.version !== 'iter-003') {
        console.error(`iteration promote-tasks did not remove -draft version suffix: ${caseData.id}`);
        console.error(JSON.stringify(promotedTaskGraph, null, 2));
        return { status: 1, checks };
      }
      const iter3DraftMeta = existsSync(iter3DraftMetaPath) ? JSON.parse(readFileSync(iter3DraftMetaPath, 'utf8')) : null;
      if (
        !iter3DraftMeta
        || iter3DraftMeta.schema_version !== 'p2a.task_graph_draft_meta.v1'
        || iter3DraftMeta.iteration_id !== 'iter-003'
        || typeof iter3DraftMeta.draft_sha256 !== 'string'
        || iter3DraftMeta.gate_c_approval_audit?.authoring_agent !== 'codex / p2a-task-author'
      ) {
        console.error(`iteration promote-tasks did not write provenance sidecar: ${caseData.id}`);
        console.error(JSON.stringify(iter3DraftMeta, null, 2));
        return { status: 1, checks };
      }

      const currentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      currentSpec.active_iteration = 'iter-004';
      writeFileSync(state.currentSpecPath, `${JSON.stringify(currentSpec, null, 2)}\n`, 'utf8');
      result = runIteration(['current', '--artifacts', artifactRoot]);
      checks += 1;
      const mismatchOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !mismatchOutput.includes('does not match current-spec.json active_iteration')) {
        console.error(`iteration current fixture did not reject status/current-spec mismatch: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return { status: 0, checks };
}

function validateInvalidFailedRunFixtureCase() {
  const runsDir = mkdtempSync(path.join(tmpdir(), 'p2a-invalid-runs-'));
  const now = '2026-06-19T00:00:00.000Z';
  const runId = 'run-invalid-failed-without-failure';
  const run = {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'fixture-project',
    taskId: 'task-001',
    taskTitle: 'Invalid failed run fixture',
    iterationId: 'v1-mvp',
    sourceLayout: 'iteration',
    taskGraphRef: 'iterations/v1-mvp/gate-c-task-graph/task-graph.json',
    sourceSpecRef: '../gate-b-spec/spec.json',
    agentTool: 'codex',
    workspaceRef: 'fixture-workspace',
    workspacePath: '.',
    isolation: {
      mode: 'none',
      branch: null,
      worktree: null,
      baseRef: null,
      created: false,
      createCommand: null,
      createExitCode: null,
      createOutputTail: null,
    },
    status: 'failed',
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    changedFiles: [],
    verification: [],
    notes: [],
  };
  const index = {
    schema_version: 'p2a.run_index.v1',
    projectId: 'fixture-project',
    runs: [{
      runId,
      taskId: 'task-001',
      iterationId: 'v1-mvp',
      status: 'failed',
      agentTool: 'codex',
      workspaceRef: 'fixture-workspace',
      taskGraphRef: 'iterations/v1-mvp/gate-c-task-graph/task-graph.json',
      runRef: `${runId}.json`,
      startedAt: now,
      finishedAt: now,
    }],
    tasks: [{ taskId: 'task-001', runIds: [runId], latestRunId: runId }],
  };

  try {
    writeFileSync(path.join(runsDir, `${runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    const result = runValidator(['--runs-dir', runsDir]);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 || !output.includes('failed run must include failure')) {
      console.error('negative fixture invalid failed run without failure was not rejected by validator');
      writeResultOutput(result);
      return { status: result.status === 0 ? 1 : failureStatus(result), checks: 1 };
    }
    return { status: 0, checks: 1 };
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
}

function validateNegativeFixtureCases() {
  const manifest = loadNegativeFixtureManifest();
  const expectedPass = manifest.expected_pass ?? [];
  const expectedFailure = manifest.expected_failure ?? [];
  let checks = 0;

  for (const caseData of expectedPass) {
    assertCaseShape(caseData, 'expected_pass');
    const result = runValidator(caseData.args);
    checks += 1;
    if (result.status !== 0) {
      console.error(`negative fixture pass check failed unexpectedly: ${caseData.id}`);
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  }

  for (const caseData of expectedFailure) {
    assertCaseShape(caseData, 'expected_failure');
    if (!caseData.expected_message || typeof caseData.expected_message !== 'string') {
      throw new Error(`${caseData.id} must provide expected_message`);
    }
    const result = runValidator(caseData.args);
    checks += 1;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0) {
      console.error(`negative fixture expected failure but command passed: ${caseData.id}`);
      writeResultOutput(result);
      return { status: 1, checks };
    }
    if (!output.includes(caseData.expected_message)) {
      console.error(`negative fixture failed with unexpected message: ${caseData.id}`);
      console.error(`expected message fragment: ${caseData.expected_message}`);
      writeResultOutput(result);
      return { status: 1, checks };
    }
  }

  const invalidRunResult = validateInvalidFailedRunFixtureCase();
  checks += invalidRunResult.checks;
  if (invalidRunResult.status !== 0) return { status: invalidRunResult.status, checks };

  return { status: 0, checks };
}

export function main() {
  const fixtureDirs = existsSync(FIXTURE_ROOT)
    ? readdirSync(FIXTURE_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !entry.name.startsWith('_'))
        .map((entry) => path.join(FIXTURE_ROOT, entry.name))
        .sort()
    : [];
  if (!fixtureDirs.length) {
    console.error('fixture validation failed: no fixture directories found');
    return 1;
  }

  const command = [VALIDATOR];
  for (const fixtureDir of fixtureDirs) command.push('--fixture-dir', fixtureDir);
  const result = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8' });
  writeResultOutput(result);
  if (result.status !== 0) return failureStatus(result);

  let scaffoldResult;
  try {
    scaffoldResult = validateScaffoldFixtureCase();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (scaffoldResult.status !== 0) return scaffoldResult.status;

  let e2eResult;
  try {
    e2eResult = validateE2eFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (e2eResult.status !== 0) return e2eResult.status;

  let iterationResult;
  try {
    iterationResult = validateIterationCurrentFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (iterationResult.status !== 0) return iterationResult.status;

  let negativeResult;
  try {
    negativeResult = validateNegativeFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (negativeResult.status !== 0) return negativeResult.status;

  const segments = [`${fixtureDirs.length} Plan2Agent fixture set(s)`];
  if (scaffoldResult.checks) segments.push(`${scaffoldResult.checks} scaffold fixture check(s)`);
  if (e2eResult.checks) segments.push(`${e2eResult.checks} e2e fixture check(s)`);
  if (iterationResult.checks) segments.push(`${iterationResult.checks} iteration fixture check(s)`);
  if (negativeResult.checks) segments.push(`${negativeResult.checks} negative fixture check(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
