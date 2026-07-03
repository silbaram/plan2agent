#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for positive, e2e, iteration, and negative fixture cases. */

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateOrchestrationPlanData,
  validateOrchestrationRuntimeData,
  validateTaskContextData,
  validateTaskGraphData,
} from './validate_artifacts.mjs';
import { compareSync } from './p2a_memory.mjs';
import { PROJECT_RUNTIME_SCHEMA_FILES, PROJECT_RUNTIME_SCRIPT_FILES } from './p2a_tool_manifest.mjs';
import { shellQuote } from './p2a_run_commands.mjs';

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
const EVAL_CLI = path.join(ROOT, 'scripts', 'p2a_eval.mjs');
const MEMORY_CLI = path.join(ROOT, 'scripts', 'p2a_memory.mjs');
const HANDOFF_CLI = path.join(ROOT, 'scripts', 'p2a_handoff.mjs');
const DOCTOR_CLI = path.join(ROOT, 'scripts', 'p2a_doctor.mjs');
const P2A_CLI = path.join(ROOT, 'scripts', 'p2a.mjs');

function runValidator(args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runIteration(args) {
  return spawnSync(process.execPath, [ITERATION_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runTasks(args, options = {}) {
  return spawnSync(process.execPath, [TASKS_CLI, ...args], { cwd: ROOT, encoding: 'utf8', input: options.input });
}

function runRuns(args, options = {}) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], { cwd: options.cwd ?? ROOT, encoding: 'utf8' });
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

function runEval(args) {
  return spawnSync(process.execPath, [EVAL_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runMemory(args) {
  return spawnSync(process.execPath, [MEMORY_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P2A_MEMORY_URL: '', P2A_MEMORY_TOKEN: '' },
  });
}

function fixtureFailureDetailArgs(label) {
  return [
    '--repro-step',
    `${label} can be reproduced from the fixture run output.`,
    '--localization',
    `${label} is localized by the fixture assertion.`,
    '--guard',
    `${label} is guarded by the fixture regression check.`,
  ];
}

function runHandoff(args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runHandoffFrom(cwd, args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd, encoding: 'utf8' });
}

function runDoctor(args) {
  return spawnSync(process.execPath, [DOCTOR_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runP2a(args) {
  return spawnSync(process.execPath, [P2A_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runTargetP2a(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetTasks(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_tasks.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetRuns(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_runs.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetExecute(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_execute.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetOrchestrate(targetRoot, args, options = {}) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_orchestrate.mjs'), ...args], {
    cwd: targetRoot,
    encoding: 'utf8',
    env: options.env,
  });
}

function runTargetProposals(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetEval(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetMemory(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_memory.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetIteration(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_iteration.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function writeResultOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function writeFakeProviderCli(binDir, command, versionOutput) {
  mkdirSync(binDir, { recursive: true });
  const commandPath = process.platform === 'win32'
    ? path.join(binDir, `${command}.cmd`)
    : path.join(binDir, command);
  const contents = process.platform === 'win32'
    ? `@echo off\r\necho ${versionOutput}\r\n`
    : `#!/usr/bin/env node\nconsole.log(${JSON.stringify(versionOutput)});\n`;
  writeFileSync(commandPath, contents, 'utf8');
  if (process.platform !== 'win32') chmodSync(commandPath, 0o755);
  return commandPath;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeFixturePath(filePath) {
  const relative = path.relative(ROOT, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return filePath.split(path.sep).join('/');
}

function quotedCommand(parts) {
  return parts.map(shellQuote).join(' ');
}

function sourceDocumentId(projectId, iterationId, sourcePath) {
  return `${projectId}:${iterationId}:${sourcePath}`;
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


function assertTargetSpecSourceIntake(targetRoot, projectId, caseId, label) {
  const artifactsDir = path.join(targetRoot, '.plan2agent', 'artifacts', projectId);
  const targetSpecPath = path.join(artifactsDir, 'gate-b-spec', 'spec.json');
  const targetIntakePath = path.join(artifactsDir, 'gate-a-intake', 'intake.json');
  const targetIntakeRef = `.plan2agent/artifacts/${projectId}/gate-a-intake/intake.json`;
  const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
  if (!existsSync(targetIntakePath) || targetSpec.source_intake !== targetIntakeRef) {
    console.error(`${label} handoff spec.source_intake/intake.json mismatch: ${caseId}`);
    console.error(JSON.stringify({ source_intake: targetSpec.source_intake, intakeExists: existsSync(targetIntakePath) }, null, 2));
    return { status: 1 };
  }
  const result = runValidator(['--artifact-root', artifactsDir, '--project-id', projectId, '--require-handoff-ready']);
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

    const expectedScripts = PROJECT_RUNTIME_SCRIPT_FILES
      .map((file) => path.join('.plan2agent', 'scripts', file));
    const expectedSchemas = PROJECT_RUNTIME_SCHEMA_FILES
      .map((file) => path.join('.plan2agent', 'schemas', file));
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
    const excludedToolFiles = [
      path.join('.agents', 'skills', 'p2a-design-system', 'SKILL.md'),
      path.join('.claude', 'skills', 'p2a-design-system', 'SKILL.md'),
      path.join('.gemini', 'commands', 'p2a', 'design-system.toml'),
    ];
    const copiedExcludedToolFiles = excludedToolFiles.filter((filePath) => existsSync(path.join(targetRoot, filePath)));
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const manifestDesignSystemFiles = [...(manifest.aiToolFiles ?? []), ...(manifest.toolFiles ?? [])]
      .filter((filePath) => filePath.includes('p2a-design-system') || filePath.endsWith('/design-system.toml'));
    const config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    const claudeSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.json'), 'utf8'));
    const claudeLocalSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.local.json'), 'utf8'));
    const gitignore = readFileSync(path.join(targetRoot, '.gitignore'), 'utf8');
    const gitignoreLines = new Set(gitignore.split(/\r?\n/));
    const expectedSandboxEnabled = process.platform === 'darwin' || process.platform === 'linux';
    if (
      missingFiles.length
      || copiedExcludedToolFiles.length
      || manifestDesignSystemFiles.length
      || manifest.provenance?.mode !== 'scaffold'
      || manifest.aiToolTargets.join(',') !== 'codex,claude,gemini'
      || config.testCommand !== null
      || config.verificationTimeoutMs !== 600000
      || config.runTracking?.runsDir !== '.plan2agent/runs'
      || config.devExecution?.scopePolicy !== 'task_only'
      || config.devExecution?.verificationPolicy !== 'required_for_done'
      || config.roleProfiles?.implementer?.defaultProfile !== 'fullstack'
      || config.promptTemplates?.devExecution !== 'p2a.dev_prompt.v1'
      || !claudeSettings.permissions?.deny?.includes('Edit(~/**)')
      || claudeSettings.hooks?.PreToolUse?.[0]?.matcher !== 'Write|Edit|Bash'
      || claudeSettings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command !== 'node .claude/hooks/p2a-confine-workspace.mjs'
      || (expectedSandboxEnabled && claudeLocalSettings.sandbox?.filesystem?.allowWrite?.[0] !== '.')
      || (!expectedSandboxEnabled && Object.keys(claudeLocalSettings).length !== 0)
      || !gitignoreLines.has('.plan2agent/')
      || !gitignore.includes('Plan2Agent Memory')
      || !gitignore.includes('.claude/settings.local.json')
      || !gitignore.includes('node_modules/')
    ) {
      console.error('scaffold output mismatch');
      console.error(JSON.stringify({ missingFiles, copiedExcludedToolFiles, manifestDesignSystemFiles, manifest, config, claudeSettings, claudeLocalSettings }, null, 2));
      return { status: 1, checks };
    }

    result = runTargetIteration(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a_iteration.mjs init')) {
      console.error('scaffold target p2a_iteration --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetEval(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a_eval.mjs grade')) {
      console.error('scaffold target p2a_eval --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetMemory(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a_memory.mjs status')) {
      console.error('scaffold target p2a_memory --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetP2a(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a.mjs info')) {
      console.error('scaffold target p2a --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetP2a(targetRoot, ['info', '--json']);
    checks += 1;
    const p2aInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || p2aInfo.schema_version !== 'p2a.info.v1'
      || p2aInfo.surface !== 'project_runtime'
      || p2aInfo.mode !== 'scaffold'
      || p2aInfo.artifactCount !== 0
    ) {
      console.error('scaffold target p2a info fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ p2aInfo }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runP2a(['info', '--target', path.join(tempRoot, 'missing-info-target'), '--json']);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('--target must be an existing directory')) {
      console.error('top-level p2a info did not reject a missing target');
      writeResultOutput(result);
      return { status: result.status === 0 ? 1 : failureStatus(result), checks };
    }

    const misplacedEmbeddedDoctorPath = path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_doctor.mjs');
    writeFileSync(misplacedEmbeddedDoctorPath, 'this is not valid JavaScript\n', 'utf8');
    result = runTargetP2a(targetRoot, ['doctor', '--json']);
    checks += 1;
    const targetP2aDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    const targetP2aDoctorRepoOnlyCheck = targetP2aDoctor?.checks?.find((check) => check.id === 'repo_only_scripts_absent');
    if (
      result.status !== 0
      || targetP2aDoctor.schema_version !== 'p2a.doctor.v1'
      || !['pass', 'warn'].includes(targetP2aDoctor.status)
      || targetP2aDoctor.summary?.failures !== 0
      || realpathSync(targetP2aDoctor.target) !== realpathSync(targetRoot)
      || targetP2aDoctorRepoOnlyCheck?.status !== 'warn'
      || !targetP2aDoctorRepoOnlyCheck.unexpected?.includes('.plan2agent/scripts/p2a_doctor.mjs')
    ) {
      console.error('scaffold target p2a doctor dispatch failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ targetP2aDoctor }, null, 2));
      return { status: failureStatus(result), checks };
    }
    unlinkSync(misplacedEmbeddedDoctorPath);

    result = runTargetP2a(targetRoot, ['eval', '--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a_eval.mjs grade')) {
      console.error('scaffold target p2a eval dispatch failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const signalDispatchRoot = path.join(tempRoot, 'p2a-signal-dispatch-target');
    cpSync(targetRoot, signalDispatchRoot, { recursive: true });
    writeFileSync(
      path.join(signalDispatchRoot, '.plan2agent', 'scripts', 'p2a_tasks.mjs'),
      "process.kill(process.pid, 'SIGTERM');\n",
      'utf8',
    );
    result = runTargetP2a(signalDispatchRoot, ['tasks', 'ready']);
    checks += 1;
    const signalDispatchAccepted = process.platform === 'win32'
      ? result.status !== 0
      : result.status !== 0 && result.stderr.includes('p2a error: command terminated by signal SIGTERM');
    if (!signalDispatchAccepted) {
      console.error('top-level p2a signal dispatch fixture failed');
      writeResultOutput(result);
      return { status: result.status === 0 ? 1 : failureStatus(result), checks };
    }

    const lazyConfigGraphPath = path.join(tempRoot, 'lazy-config-task-graph.json');
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service', 'gate-c-task-graph', 'task-graph.json'), lazyConfigGraphPath);
    writeFileSync(path.join(targetRoot, 'package.json'), `${JSON.stringify({
      scripts: {
        test: 'node -p 1',
      },
    }, null, 2)}\n`);
    result = runTargetRuns(targetRoot, [
      'start',
      '--graph',
      lazyConfigGraphPath,
      '--task',
      'task-001',
      '--agent-tool',
      'codex',
      '--run-id',
      'run-lazy-config',
    ]);
    checks += 1;
    if (result.status !== 0) {
      console.error('scaffold target lazy config run start failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runTargetRuns(targetRoot, [
      'verify',
      '--graph',
      lazyConfigGraphPath,
      '--run-id',
      'run-lazy-config',
      '--test',
    ]);
    checks += 1;
    const lazyConfig = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    const lazyRun = JSON.parse(readFileSync(path.join(tempRoot, 'runs', 'run-lazy-config.json'), 'utf8'));
    if (
      result.status !== 0
      || lazyConfig.packageManager !== 'npm'
      || lazyConfig.testCommand !== 'npm test'
      || lazyConfig.verificationTimeoutMs !== 600000
      || !result.stdout.includes('saved detected packageManager,installCommand,testCommand')
      || lazyRun.verification[0]?.status !== 'passed'
      || lazyRun.verification[0]?.command !== 'npm test'
    ) {
      console.error('scaffold target lazy project config detection failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ lazyConfig, lazyRun }, null, 2));
      return { status: 1, checks };
    }

    const malformedConfigPath = path.join(targetRoot, '.plan2agent', 'project.config.json');
    const malformedConfigText = '{bad json';
    writeFileSync(malformedConfigPath, malformedConfigText, 'utf8');
    result = runTargetRuns(targetRoot, [
      'verify',
      '--graph',
      lazyConfigGraphPath,
      '--run-id',
      'run-lazy-config',
      '--test',
    ]);
    checks += 1;
    if (
      result.status === 0
      || !`${result.stdout}${result.stderr}`.includes('project config is malformed')
      || readFileSync(malformedConfigPath, 'utf8') !== malformedConfigText
    ) {
      console.error('scaffold target malformed project config was not preserved and rejected');
      writeResultOutput(result);
      return { status: 1, checks };
    }
    writeFileSync(malformedConfigPath, `${JSON.stringify(lazyConfig, null, 2)}\n`, 'utf8');

    result = runDoctor(['--target', targetRoot, '--json']);
    checks += 1;
    const doctorReport = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || doctorReport.schema_version !== 'p2a.doctor.v1'
      || doctorReport.status !== 'pass'
      || doctorReport.summary.failures !== 0
      || doctorReport.checks.find((check) => check.id === 'runtime_scripts')?.status !== 'pass'
      || doctorReport.checks.find((check) => check.id === 'runtime_schemas')?.status !== 'pass'
      || doctorReport.checks.find((check) => check.id === 'repo_only_scripts_absent')?.status !== 'pass'
      || doctorReport.checks.find((check) => check.id === 'verification_commands')?.status !== 'pass'
      || doctorReport.checks.find((check) => check.id === 'project_state')?.status !== 'pass'
      || doctorReport.projectState?.state !== 'installed_empty'
      || doctorReport.projectState?.artifactCount !== 0
    ) {
      console.error('p2a_doctor did not pass for a complete scaffold target');
      writeResultOutput(result);
      console.error(JSON.stringify({ doctorReport }, null, 2));
      return { status: 1, checks };
    }

    result = runP2a(['doctor', '--target', targetRoot, '--json']);
    checks += 1;
    const p2aDoctorReport = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || p2aDoctorReport.schema_version !== 'p2a.doctor.v1'
      || p2aDoctorReport.status !== 'pass'
    ) {
      console.error('top-level p2a doctor dispatch failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ p2aDoctorReport }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runDoctor(['--target', targetRoot, '--dev', '--json']);
    checks += 1;
    const devDoctorReport = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || devDoctorReport.schema_version !== 'p2a.doctor.v1'
      || devDoctorReport.status !== 'pass'
      || devDoctorReport.summary.failures !== 0
      || devDoctorReport.dev?.aiToolTargets?.join(',') !== 'codex,claude,gemini'
      || devDoctorReport.dev?.checks?.some((check) => check.status !== 'pass')
      || devDoctorReport.checks.find((check) => check.id === 'dev_manifest_ai_tool_files')?.status !== 'pass'
      || devDoctorReport.checks.find((check) => check.id === 'dev_claude_confinement')?.status !== 'pass'
    ) {
      console.error('p2a_doctor --dev did not pass for a complete scaffold target');
      writeResultOutput(result);
      console.error(JSON.stringify({ devDoctorReport }, null, 2));
      return { status: 1, checks };
    }

    const misplacedDoctorPath = path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_doctor.mjs');
    writeFileSync(misplacedDoctorPath, 'repo-only script should not be scaffold-installed\n', 'utf8');
    result = runDoctor(['--target', targetRoot, '--json']);
    checks += 1;
    const misplacedDoctorReport = result.status === 0 ? JSON.parse(result.stdout) : null;
    const repoOnlyCheck = misplacedDoctorReport?.checks.find((check) => check.id === 'repo_only_scripts_absent');
    if (
      result.status !== 0
      || misplacedDoctorReport.status !== 'warn'
      || repoOnlyCheck?.status !== 'warn'
      || !repoOnlyCheck.unexpected?.includes('.plan2agent/scripts/p2a_doctor.mjs')
    ) {
      console.error('p2a_doctor did not warn for a repo-only script under .plan2agent/scripts');
      writeResultOutput(result);
      console.error(JSON.stringify({ misplacedDoctorReport }, null, 2));
      return { status: 1, checks };
    }
    unlinkSync(misplacedDoctorPath);

    const scaffoldArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(scaffoldArtifactRoot), { recursive: true });
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), scaffoldArtifactRoot, { recursive: true });
    result = runDoctor(['--target', targetRoot, '--json']);
    checks += 1;
    const initDoctorReport = result.status === 0 ? JSON.parse(result.stdout) : null;
    const initArtifact = initDoctorReport?.projectState?.artifacts?.[0];
    if (
      result.status !== 0
      || initDoctorReport.status !== 'warn'
      || initDoctorReport.summary.failures !== 0
      || initDoctorReport.checks.find((check) => check.id === 'project_state')?.status !== 'warn'
      || initDoctorReport.projectState?.state !== 'iteration_init_required'
      || initArtifact?.projectId !== 'webhook-api-service'
      || initArtifact?.layout?.requiresIterationInit !== true
      || initArtifact?.spec?.approval !== 'approved'
      || initArtifact?.spec?.openDecisions !== 0
      || initArtifact?.taskGraph?.taskCounts?.total !== 4
      || initArtifact?.taskGraph?.taskCounts?.ready !== 1
      || initArtifact?.review?.blockingIssues !== 0
      || !initDoctorReport.projectState?.commands?.find((command) => command.id === 'init_iteration')?.command?.includes('p2a.mjs iteration init')
    ) {
      console.error('p2a_doctor did not summarize greenfield scaffold artifacts');
      writeResultOutput(result);
      console.error(JSON.stringify({ initDoctorReport }, null, 2));
      return { status: 1, checks };
    }
    const initRequiredCases = [
      ['p2a_execute plan without source', () => runTargetExecute(targetRoot, ['plan', '--task', 'task-001'])],
      ['p2a_tasks ready without source', () => runTargetTasks(targetRoot, ['ready'])],
      ['p2a_runs start without source', () => runTargetRuns(targetRoot, ['start', '--task', 'task-001', '--agent-tool', 'codex'])],
      ['p2a_orchestrate plan without source', () => runTargetOrchestrate(targetRoot, ['plan', '--task', 'task-001'])],
      ['p2a_proposals mine without source', () => runTargetProposals(targetRoot, ['mine'])],
    ];
    for (const [label, runCase] of initRequiredCases) {
      result = runCase();
      checks += 1;
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !output.includes('p2a.mjs iteration init') || !output.includes('.plan2agent/artifacts/webhook-api-service')) {
        console.error(`scaffold target did not require iteration init: ${label}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    const partialIterationArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', 'partial-iteration-service');
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), partialIterationArtifactRoot, { recursive: true });
    mkdirSync(path.join(partialIterationArtifactRoot, 'iterations'), { recursive: true });
    result = runTargetExecute(targetRoot, [
      'plan',
      '--graph',
      '.plan2agent/artifacts/partial-iteration-service/gate-c-task-graph/task-graph.json',
      '--task',
      'task-001',
    ]);
    checks += 1;
    {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !output.includes('iteration layout is incomplete') || output.includes('p2a_iteration.mjs init')) {
        console.error('scaffold partial iteration layout was not rejected with a repair diagnostic');
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    const movedPartialArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', 'moved-partial-service');
    const movedPartialIterationRoot = path.join(movedPartialArtifactRoot, 'iterations', 'v1-mvp');
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), movedPartialArtifactRoot, { recursive: true });
    mkdirSync(movedPartialIterationRoot, { recursive: true });
    for (const gate of ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph', 'gate-d-review']) {
      renameSync(path.join(movedPartialArtifactRoot, gate), path.join(movedPartialIterationRoot, gate));
    }
    result = runTargetExecute(targetRoot, ['plan', '--task', 'task-001']);
    checks += 1;
    {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !output.includes('iteration layout is incomplete') || !output.includes('.plan2agent/artifacts/moved-partial-service')) {
        console.error('scaffold moved partial iteration layout was not rejected with a repair diagnostic');
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    result = runTargetOrchestrate(targetRoot, ['runner-doctor', '--root', targetRoot, '--json']);
    checks += 1;
    const runnerDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || runnerDoctor.schema_version !== 'p2a.provider_runner_doctor.v1'
      || runnerDoctor.supervisedOnly !== true
      || runnerDoctor.live !== false
      || runnerDoctor.startsProcess !== false
      || runnerDoctor.startsAgentSession !== false
      || !runnerDoctor.safetyBoundary.includes('does not start Codex')
      || runnerDoctor.projectConfig.providerNativeCapabilities !== true
      || runnerDoctor.providers.map((provider) => provider.status).join(',') !== 'ready,ready,ready'
      || runnerDoctor.providers.find((provider) => provider.provider === 'codex')?.summary.requiredPresent !== 8
      || runnerDoctor.providers.find((provider) => provider.provider === 'codex')?.capabilitySummary.available !== 2
      || runnerDoctor.providers.find((provider) => provider.provider === 'codex')?.capabilitySummary.manualCheck !== 1
      || runnerDoctor.providers.find((provider) => provider.provider === 'claude')?.capabilities.find((capability) => capability.id === 'agentTeams')?.status !== 'manual_check'
      || runnerDoctor.providers.find((provider) => provider.provider === 'gemini')?.capabilities.find((capability) => capability.id === 'customCommands')?.status !== 'available'
      || runnerDoctor.providers.find((provider) => provider.provider === 'claude')?.checks.find((check) => check.id === 'claude_workspace_hook')?.present !== true
      || runnerDoctor.providers.find((provider) => provider.provider === 'gemini')?.checks.find((check) => check.id === 'gemini_context')?.present !== false
      || runnerDoctor.providers.some((provider) => provider.liveStatus !== 'not_checked')
    ) {
      console.error('scaffold target runner-doctor fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ runnerDoctor }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const capabilityTargetRoot = path.join(tempRoot, 'capability-target');
    cpSync(targetRoot, capabilityTargetRoot, { recursive: true });
    const capabilityConfigPath = path.join(capabilityTargetRoot, '.plan2agent', 'project.config.json');
    const capabilityConfig = JSON.parse(readFileSync(capabilityConfigPath, 'utf8'));
    capabilityConfig.providerNativeCapabilities.codex.customAgents = {
      status: 'available',
      evidence: 'fixture intentionally claims availability while asset is missing',
    };
    writeFileSync(capabilityConfigPath, `${JSON.stringify(capabilityConfig, null, 2)}\n`);
    rmSync(path.join(capabilityTargetRoot, '.codex', 'agents', 'p2a-implementer.toml'));
    result = runTargetOrchestrate(capabilityTargetRoot, ['runner-doctor', '--root', capabilityTargetRoot, '--provider', 'codex', '--json']);
    checks += 1;
    const capabilityDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    const customAgentsCapability = capabilityDoctor?.providers?.[0]?.capabilities?.find((capability) => capability.id === 'customAgents');
    if (
      result.status !== 0
      || customAgentsCapability?.status !== 'manual_check'
      || customAgentsCapability?.assetPresent !== false
      || customAgentsCapability?.evidence !== 'fixture intentionally claims availability while asset is missing'
    ) {
      console.error('scaffold target runner-doctor capability fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ capabilityDoctor }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const fakeBinDir = path.join(tempRoot, 'fake-provider-bin');
    writeFakeProviderCli(fakeBinDir, 'codex', 'codex-cli fixture-1.0.0');
    writeFakeProviderCli(fakeBinDir, 'claude', 'claude-code fixture-1.0.0');
    writeFakeProviderCli(fakeBinDir, 'gemini', 'gemini-cli fixture-1.0.0');
    result = runTargetOrchestrate(targetRoot, ['runner-doctor', '--root', targetRoot, '--provider', 'all', '--live', '--json'], {
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    checks += 1;
    const liveRunnerDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || liveRunnerDoctor.live !== true
      || liveRunnerDoctor.startsProcess !== true
      || liveRunnerDoctor.startsAgentSession !== false
      || !liveRunnerDoctor.safetyBoundary.includes('--version probes')
      || liveRunnerDoctor.providers.map((provider) => provider.liveStatus).join(',') !== 'available,available,available'
      || liveRunnerDoctor.providers.find((provider) => provider.provider === 'codex')?.liveChecks[0]?.output !== 'codex-cli fixture-1.0.0'
      || liveRunnerDoctor.providers.find((provider) => provider.provider === 'claude')?.liveChecks[0]?.startsAgentSession !== false
      || liveRunnerDoctor.providers.find((provider) => provider.provider === 'gemini')?.liveChecks[0]?.command !== 'gemini'
    ) {
      console.error('scaffold target runner-doctor live fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ liveRunnerDoctor }, null, 2));
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

    const enhanceTargetRoot = path.join(tempRoot, 'enhance-target');
    result = runHandoff(['scaffold', '--target', enhanceTargetRoot, '--tools', 'none']);
    checks += 1;
    if (result.status !== 0) {
      console.error('enhance target scaffold fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    const enhanceConfigPath = path.join(enhanceTargetRoot, '.plan2agent', 'project.config.json');
    const enhanceConfig = JSON.parse(readFileSync(enhanceConfigPath, 'utf8'));
    delete enhanceConfig.devExecution;
    delete enhanceConfig.roleProfiles;
    delete enhanceConfig.promptTemplates;
    writeFileSync(enhanceConfigPath, `${JSON.stringify(enhanceConfig, null, 2)}\n`);
    result = runHandoff(['enhance', 'dev-skills', '--target', enhanceTargetRoot, '--tools', 'codex', '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent enhance dev-skills dry run')
      || !result.stdout.includes('configUpdatedKeys: devExecution,roleProfiles,promptTemplates')
      || !result.stdout.includes('dry-run: no files written')
      || existsSync(path.join(enhanceTargetRoot, '.codex', 'agents', 'p2a-implementer.toml'))
    ) {
      console.error('enhance dev-skills dry-run fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['enhance', 'dev-skills', '--target', enhanceTargetRoot, '--tools', 'codex']);
    checks += 1;
    const enhancedConfig = JSON.parse(readFileSync(enhanceConfigPath, 'utf8'));
    const enhancedManifest = JSON.parse(readFileSync(path.join(enhanceTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || enhancedConfig.devExecution?.scopePolicy !== 'task_only'
      || enhancedConfig.roleProfiles?.monitor?.defaultProfile !== 'manual_monitor'
      || enhancedConfig.promptTemplates?.providerGuide !== 'p2a.provider_guide.v1'
      || !enhancedManifest.aiToolTargets?.includes('codex')
      || enhancedManifest.enhancements?.devSkills?.promptTemplateVersion !== 'p2a.dev_prompt.v1'
      || !existsSync(path.join(enhanceTargetRoot, '.codex', 'agents', 'p2a-implementer.toml'))
    ) {
      console.error('enhance dev-skills fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ enhancedConfig, enhancedManifest }, null, 2));
      return { status: failureStatus(result), checks };
    }
    writeFileSync(path.join(enhanceTargetRoot, '.codex', 'agents', 'p2a-implementer.toml'), 'local conflicting asset\n', 'utf8');
    result = runHandoff(['enhance', 'dev-skills', '--target', enhanceTargetRoot, '--tools', 'codex']);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('--overwrite')) {
      console.error('enhance dev-skills conflict fixture did not require --overwrite');
      writeResultOutput(result);
      return { status: 1, checks };
    }

    result = runHandoff(['enhance', 'memory', '--target', enhanceTargetRoot, '--dry-run']);
    checks += 1;
    const dryRunCapabilityConfig = JSON.parse(readFileSync(enhanceConfigPath, 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent enhance memory dry run')
      || !result.stdout.includes('configUpdatedKeys: memory')
      || !result.stdout.includes('After creating an artifact root, check local/Memory sync: node .plan2agent/scripts/p2a.mjs memory status --artifacts .plan2agent/artifacts/<project_id>')
      || !result.stdout.includes('After Memory is configured, preview restore diff: node .plan2agent/scripts/p2a.mjs memory pull --artifacts .plan2agent/artifacts/<project_id> --dry-run')
      || !result.stdout.includes('After Memory contains snapshots, search history: node .plan2agent/scripts/p2a.mjs memory search --artifacts .plan2agent/artifacts/<project_id> --query <term>')
      || !result.stdout.includes('After Memory contains snapshots, show timeline: node .plan2agent/scripts/p2a.mjs memory history --artifacts .plan2agent/artifacts/<project_id>')
      || !result.stdout.includes('dry-run: no files written')
      || dryRunCapabilityConfig.memory
    ) {
      console.error('enhance memory dry-run fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ dryRunCapabilityConfig }, null, 2));
      return { status: failureStatus(result), checks };
    }

    for (const capability of ['memory', 'gui', 'orchestration', 'proposals']) {
      result = runHandoff(['enhance', capability, '--target', enhanceTargetRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes(`enhance ${capability} complete`)) {
        console.error(`enhance ${capability} fixture failed`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      if (
        capability === 'proposals'
        && !result.stdout.includes('After runs exist, mine proposal candidates: node .plan2agent/scripts/p2a.mjs proposals mine --artifacts .plan2agent/artifacts/<project_id> --proposals .plan2agent/proposals --dry-run')
      ) {
        console.error('enhance proposals next-actions fixture failed');
        writeResultOutput(result);
        return { status: 1, checks };
      }
      if (
        capability === 'orchestration'
        && (
          !result.stdout.includes('Check provider runner readiness: node .plan2agent/scripts/p2a.mjs orchestrate runner-doctor --root .')
          || !result.stdout.includes('After a ready task exists, plan supervised orchestration: node .plan2agent/scripts/p2a.mjs orchestrate plan --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool codex --output .plan2agent/orchestration/<task-id>.json')
          || !result.stdout.includes('After reviewing the plan, start supervised run with orchestration: node .plan2agent/scripts/p2a.mjs execute start --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool codex --orchestration-plan .plan2agent/orchestration/<task-id>.json')
          || !result.stdout.includes('Inspect orchestration runtime after start: node .plan2agent/scripts/p2a.mjs orchestrate runtime-status --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json')
        )
      ) {
        console.error('enhance orchestration next-actions fixture failed');
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    const orchestrationClaudeRoot = path.join(tempRoot, 'orchestration-claude-target');
    result = runHandoff(['scaffold', '--target', orchestrationClaudeRoot, '--tools', 'claude']);
    checks += 1;
    if (result.status !== 0) {
      console.error('orchestration claude provider scaffold fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['enhance', 'orchestration', '--target', orchestrationClaudeRoot]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('After a ready task exists, plan supervised orchestration: node .plan2agent/scripts/p2a.mjs orchestrate plan --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool claude --output .plan2agent/orchestration/<task-id>.json')
      || !result.stdout.includes('After reviewing the plan, start supervised run with orchestration: node .plan2agent/scripts/p2a.mjs execute start --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool claude --orchestration-plan .plan2agent/orchestration/<task-id>.json')
    ) {
      console.error('enhance orchestration claude provider next-actions fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    const providerArtifactRoot = path.join(orchestrationClaudeRoot, '.plan2agent', 'artifacts', 'provider-check');
    mkdirSync(providerArtifactRoot, { recursive: true });
    writeFileSync(path.join(providerArtifactRoot, 'current-spec.json'), `${JSON.stringify({ schema_version: 'p2a.spec.v1', project_id: 'provider-check' }, null, 2)}\n`, 'utf8');
    result = runTargetP2a(orchestrationClaudeRoot, ['info', '--json']);
    checks += 1;
    const claudeProviderInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || !claudeProviderInfo.nextActions?.some((action) => action.includes('orchestrate plan --artifacts .plan2agent/artifacts/provider-check --task <task-id> --agent-tool claude'))
      || !claudeProviderInfo.nextActions?.some((action) => action.includes('execute start --artifacts .plan2agent/artifacts/provider-check --task <task-id> --agent-tool claude --orchestration-plan'))
    ) {
      console.error('p2a info orchestration claude provider next-actions fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ claudeProviderInfo }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const orchestrationManualRoot = path.join(tempRoot, 'orchestration-manual-target');
    result = runHandoff(['scaffold', '--target', orchestrationManualRoot, '--tools', 'none']);
    checks += 1;
    if (result.status !== 0) {
      console.error('orchestration manual provider scaffold fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['enhance', 'orchestration', '--target', orchestrationManualRoot]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('After a ready task exists, plan supervised orchestration: node .plan2agent/scripts/p2a.mjs orchestrate plan --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool manual --output .plan2agent/orchestration/<task-id>.json')
      || !result.stdout.includes('After reviewing the plan, start supervised run with orchestration: node .plan2agent/scripts/p2a.mjs execute start --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool manual --orchestration-plan .plan2agent/orchestration/<task-id>.json')
    ) {
      console.error('enhance orchestration manual provider next-actions fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const enhancedCapabilityConfig = JSON.parse(readFileSync(enhanceConfigPath, 'utf8'));
    const enhancedCapabilityManifest = JSON.parse(readFileSync(path.join(enhanceTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      enhancedCapabilityConfig.memory?.serverUrlEnv !== 'P2A_MEMORY_URL'
      || enhancedCapabilityConfig.gui?.commandMode !== 'guidance_only'
      || enhancedCapabilityConfig.orchestration?.monitorGatePolicy !== 'explicit_plan_only'
      || enhancedCapabilityConfig.proposals?.patchPolicy !== 'draft_only'
      || enhancedCapabilityManifest.enhancements?.memory?.configVersion !== 'p2a.memory_config.v1'
      || enhancedCapabilityManifest.enhancements?.gui?.configKey !== 'gui'
      || enhancedCapabilityManifest.enhancements?.orchestration?.mode !== 'solo'
      || enhancedCapabilityManifest.enhancements?.proposals?.mode !== 'manual_curate'
    ) {
      console.error('enhance capability config/manifest fixture failed');
      console.error(JSON.stringify({ enhancedCapabilityConfig, enhancedCapabilityManifest }, null, 2));
      return { status: 1, checks };
    }

    result = runTargetP2a(enhanceTargetRoot, ['info', '--json']);
    checks += 1;
    const enhancedCapabilityInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || !enhancedCapabilityInfo.enhancements?.enabled?.includes('memory')
      || !enhancedCapabilityInfo.enhancements?.enabled?.includes('orchestration')
      || !enhancedCapabilityInfo.enhancements?.enabled?.includes('proposals')
      || enhancedCapabilityInfo.enhancements?.memory?.enabled !== true
      || enhancedCapabilityInfo.enhancements?.memory?.pushPolicy !== 'explicit_approval'
      || enhancedCapabilityInfo.enhancements?.orchestration?.enabled !== true
      || enhancedCapabilityInfo.enhancements?.orchestration?.defaultMode !== 'solo'
      || enhancedCapabilityInfo.enhancements?.orchestration?.providerRouting !== 'project_config'
      || enhancedCapabilityInfo.enhancements?.orchestration?.monitorGatePolicy !== 'explicit_plan_only'
      || enhancedCapabilityInfo.enhancements?.proposals?.enabled !== true
      || enhancedCapabilityInfo.enhancements?.proposals?.reviewPolicy !== 'manual_curate'
      || enhancedCapabilityInfo.enhancements?.proposals?.patchPolicy !== 'draft_only'
      || enhancedCapabilityInfo.enhancements?.proposals?.approvalRequired !== true
    ) {
      console.error('enhance capability info fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ enhancedCapabilityInfo }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runDoctor(['--target', enhanceTargetRoot, '--dev', '--json']);
    checks += 1;
    const enhancedCapabilityDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || !enhancedCapabilityDoctor.dev?.capabilities?.includes('memory')
      || !enhancedCapabilityDoctor.dev?.capabilities?.includes('orchestration')
      || !enhancedCapabilityDoctor.dev?.capabilities?.includes('proposals')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_memory_manifest' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_memory_config' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_memory_push_policy' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_orchestration_manifest' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_orchestration_config' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_orchestration_provider_routing' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_orchestration_monitor_gate' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_proposals_manifest' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_proposals_config' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_proposals_patch_policy' && item.status === 'pass')
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_proposals_approval' && item.status === 'pass')
    ) {
      console.error('enhance capability doctor fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ enhancedCapabilityDoctor }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const capabilityDriftRoot = path.join(tempRoot, 'capability-drift-target');
    cpSync(enhanceTargetRoot, capabilityDriftRoot, { recursive: true });
    const capabilityDriftManifestPath = path.join(capabilityDriftRoot, '.plan2agent', 'manifest.json');
    const capabilityDriftManifest = JSON.parse(readFileSync(capabilityDriftManifestPath, 'utf8'));
    delete capabilityDriftManifest.enhancements.proposals;
    writeFileSync(capabilityDriftManifestPath, `${JSON.stringify(capabilityDriftManifest, null, 2)}\n`);

    result = runDoctor(['--target', capabilityDriftRoot, '--dev', '--json']);
    checks += 1;
    const capabilityDriftDoctor = result.stdout ? JSON.parse(result.stdout) : null;
    if (
      result.status === 0
      || !capabilityDriftDoctor?.checks?.some((item) => item.id === 'capability_proposals_manifest' && item.status === 'fail')
      || !capabilityDriftDoctor?.nextActions?.some((action) => action.includes('enhance proposals'))
    ) {
      console.error('capability manifest drift doctor fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ capabilityDriftDoctor }, null, 2));
      return { status: result.status === 0 ? 1 : failureStatus(result), checks };
    }

    result = runTargetP2a(capabilityDriftRoot, ['info', '--json']);
    checks += 1;
    const capabilityDriftInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || capabilityDriftInfo.enhancements?.proposals?.enabled !== true
      || capabilityDriftInfo.enhancements?.proposals?.inSync !== false
      || !capabilityDriftInfo.nextActions?.some((action) => action.includes('Repair proposal capability manifest/config drift'))
    ) {
      console.error('capability manifest drift info fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ capabilityDriftInfo }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runHandoff(['upgrade', '--target', targetRoot, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
	      || !result.stdout.includes('Plan2Agent upgrade dry run')
	      || !result.stdout.includes('status: pass')
	      || !result.stdout.includes('changes: none')
	      || !result.stdout.includes('report: .plan2agent/update-reports/upgrade-')
	      || !result.stdout.includes('dry-run: no harness files written')
	    ) {
      console.error('upgrade dry-run fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runHandoff(['update', '--target', targetRoot]);
    checks += 1;
    if (
      result.status !== 0
	      || !result.stdout.includes('Plan2Agent update preview')
	      || !result.stdout.includes('status: pass')
	      || !result.stdout.includes('changes: none')
	      || !result.stdout.includes('report: .plan2agent/update-reports/update-')
	      || !result.stdout.includes('dry-run: no harness files written')
	    ) {
      console.error('update preview fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const p2aUpdateRoot = path.join(tempRoot, 'p2a-update-target');
    cpSync(targetRoot, p2aUpdateRoot, { recursive: true });
    writeFileSync(path.join(p2aUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), 'stale runtime script\n', 'utf8');
    result = runTargetP2a(p2aUpdateRoot, ['update', '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes('report: .plan2agent/update-reports/update-')
      || !result.stdout.includes('Apply safe updates with: node .plan2agent/scripts/p2a.mjs update --apply')
      || !result.stdout.includes('dry-run: no harness files written')
    ) {
      console.error('scaffold target p2a update dispatch failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const spacedUpdateRoot = path.join(tempRoot, 'target project with spaces');
    cpSync(targetRoot, spacedUpdateRoot, { recursive: true });
    writeFileSync(path.join(spacedUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), 'stale runtime script\n', 'utf8');
    result = runHandoff(['update', '--target', spacedUpdateRoot]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes(`node '${path.join(spacedUpdateRoot, '.plan2agent', 'scripts', 'p2a.mjs')}' update --apply`)
    ) {
      console.error('update preview next action quoting fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const legacyP2aMissingRoot = path.join(tempRoot, 'legacy-p2a-missing-target');
    cpSync(targetRoot, legacyP2aMissingRoot, { recursive: true });
    unlinkSync(path.join(legacyP2aMissingRoot, '.plan2agent', 'scripts', 'p2a.mjs'));
    result = runHandoffFrom(tempRoot, ['update', '--target', legacyP2aMissingRoot]);
    checks += 1;
    const legacyApplyCommand = quotedCommand(['node', P2A_CLI, 'update', '--target', legacyP2aMissingRoot, '--apply']);
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes(`Apply safe updates with: ${legacyApplyCommand}`)
    ) {
      console.error('legacy update preview next action fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const applyUpdateRoot = path.join(tempRoot, 'apply-update-target');
    cpSync(targetRoot, applyUpdateRoot, { recursive: true });
    const staleRuntimePath = path.join(applyUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs');
    writeFileSync(staleRuntimePath, 'stale runtime script\n', 'utf8');
    const applyConfigPath = path.join(applyUpdateRoot, '.plan2agent', 'project.config.json');
    const applyConfig = JSON.parse(readFileSync(applyConfigPath, 'utf8'));
    delete applyConfig.devExecution;
    writeFileSync(applyConfigPath, `${JSON.stringify(applyConfig, null, 2)}\n`);
    result = runHandoff(['update', '--target', applyUpdateRoot, '--apply']);
    checks += 1;
    const appliedUpdateConfig = JSON.parse(readFileSync(applyConfigPath, 'utf8'));
    const appliedUpdateManifest = JSON.parse(readFileSync(path.join(applyUpdateRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const applyUpdateReports = readdirSync(path.join(applyUpdateRoot, '.plan2agent', 'update-reports')).filter((entry) => entry.endsWith('.json'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update apply')
      || !result.stdout.includes('status: applied')
      || !result.stdout.includes('report: .plan2agent/update-reports/update-')
      || readFileSync(staleRuntimePath, 'utf8') !== readFileSync(path.join(ROOT, 'scripts', 'p2a_eval.mjs'), 'utf8')
      || appliedUpdateConfig.devExecution?.scopePolicy !== 'task_only'
      || !appliedUpdateManifest.updates?.some((entry) => entry.command === 'update')
	      || applyUpdateReports.length !== 3
	    ) {
      console.error('update apply fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ appliedUpdateConfig, appliedUpdateManifest, applyUpdateReports }, null, 2));
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['update', '--target', applyUpdateRoot, '--apply']);
    checks += 1;
    const applyUpdateReportsAfterNoop = readdirSync(path.join(applyUpdateRoot, '.plan2agent', 'update-reports')).filter((entry) => entry.endsWith('.json'));
    const appliedUpdateManifestAfterNoop = JSON.parse(readFileSync(path.join(applyUpdateRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update apply')
      || !result.stdout.includes('status: noop')
      || appliedUpdateManifestAfterNoop.updates.filter((entry) => entry.command === 'update').length !== 1
	      || applyUpdateReportsAfterNoop.length !== 4
	    ) {
      console.error('update apply idempotency fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ appliedUpdateManifestAfterNoop, applyUpdateReportsAfterNoop }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const applyUpgradeRoot = path.join(tempRoot, 'apply-upgrade-target');
    cpSync(targetRoot, applyUpgradeRoot, { recursive: true });
    const staleSchemaPath = path.join(applyUpgradeRoot, '.plan2agent', 'schemas', 'run.schema.json');
    writeFileSync(staleSchemaPath, '{"stale": true}\n', 'utf8');
    result = runHandoff(['upgrade', '--target', applyUpgradeRoot, '--apply']);
    checks += 1;
    const appliedUpgradeManifest = JSON.parse(readFileSync(path.join(applyUpgradeRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent upgrade apply')
      || !result.stdout.includes('status: applied')
      || readFileSync(staleSchemaPath, 'utf8') !== readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8')
      || !appliedUpgradeManifest.updates?.some((entry) => entry.command === 'upgrade')
    ) {
      console.error('upgrade apply fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ appliedUpgradeManifest }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const blockedUpdateRoot = path.join(tempRoot, 'blocked-update-target');
    cpSync(targetRoot, blockedUpdateRoot, { recursive: true });
    const conflictRuntimePath = path.join(blockedUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs');
    rmSync(conflictRuntimePath, { force: true });
    mkdirSync(conflictRuntimePath, { recursive: true });
    result = runHandoff(['update', '--target', blockedUpdateRoot, '--apply']);
    checks += 1;
    const blockedReportsDir = path.join(blockedUpdateRoot, '.plan2agent', 'update-reports');
    const blockedReports = existsSync(blockedReportsDir) ? readdirSync(blockedReportsDir).filter((entry) => entry.endsWith('.json')) : [];
    if (
      result.status === 0
      || !result.stdout.includes('Plan2Agent update apply')
      || !result.stdout.includes('status: blocked')
      || !result.stdout.includes('blockers:')
	      || blockedReports.length !== 3
	    ) {
      console.error('update apply blocker fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ blockedReports }, null, 2));
      return { status: 1, checks };
    }

    const failedApplyRoot = path.join(tempRoot, 'failed-apply-target');
    cpSync(targetRoot, failedApplyRoot, { recursive: true });
    const failedRuntimePath = path.join(failedApplyRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs');
    const failedSchemaPath = path.join(failedApplyRoot, '.plan2agent', 'schemas', 'run.schema.json');
    writeFileSync(failedRuntimePath, 'stale runtime script before partial failure\n', 'utf8');
    writeFileSync(failedSchemaPath, '{"stale": "read-only"}\n', 'utf8');
    chmodSync(failedSchemaPath, 0o444);
    result = runHandoff(['upgrade', '--target', failedApplyRoot, '--apply']);
    checks += 1;
    chmodSync(failedSchemaPath, 0o644);
    const failedReportsDir = path.join(failedApplyRoot, '.plan2agent', 'update-reports');
    const failedReports = existsSync(failedReportsDir) ? readdirSync(failedReportsDir).filter((entry) => entry.endsWith('.json')) : [];
	    const failedReport = failedReports
	      .map((entry) => JSON.parse(readFileSync(path.join(failedReportsDir, entry), 'utf8')))
	      .find((report) => report.schema_version === 'p2a.upgrade_apply.v1' && report.status === 'failed') ?? null;
	    if (
	      result.status === 0
	      || !result.stdout.includes('Plan2Agent upgrade apply')
	      || !result.stdout.includes('status: failed')
	      || failedReports.length !== 3
      || failedReport?.status !== 'failed'
      || !failedReport?.applied?.files?.includes('.plan2agent/scripts/p2a_eval.mjs')
      || !failedReport?.error
      || readFileSync(failedRuntimePath, 'utf8') !== readFileSync(path.join(ROOT, 'scripts', 'p2a_eval.mjs'), 'utf8')
    ) {
      console.error('upgrade apply partial failure report fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ failedReports, failedReport }, null, 2));
      return { status: 1, checks };
    }

    const legacyUpgradeRoot = path.join(tempRoot, 'legacy-upgrade-target');
    cpSync(targetRoot, legacyUpgradeRoot, { recursive: true });
    const legacyConfigPath = path.join(legacyUpgradeRoot, '.plan2agent', 'project.config.json');
    const legacyConfig = JSON.parse(readFileSync(legacyConfigPath, 'utf8'));
    delete legacyConfig.devExecution;
    delete legacyConfig.roleProfiles;
    delete legacyConfig.promptTemplates;
    writeFileSync(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`);
    result = runHandoff(['upgrade', '--target', legacyUpgradeRoot, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('migrations:')
      || !result.stdout.includes('dev_skills_config: would_update')
      || !result.stdout.includes('devExecution,roleProfiles,promptTemplates')
    ) {
      console.error('upgrade dry-run did not preview dev-skills config migration');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const capabilityUpgradeRoot = path.join(tempRoot, 'capability-upgrade-target');
    cpSync(enhanceTargetRoot, capabilityUpgradeRoot, { recursive: true });
    const capabilityUpgradeConfigPath = path.join(capabilityUpgradeRoot, '.plan2agent', 'project.config.json');
    const capabilityUpgradeConfig = JSON.parse(readFileSync(capabilityUpgradeConfigPath, 'utf8'));
    delete capabilityUpgradeConfig.memory;
    writeFileSync(capabilityUpgradeConfigPath, `${JSON.stringify(capabilityUpgradeConfig, null, 2)}\n`);
    result = runHandoff(['upgrade', '--target', capabilityUpgradeRoot, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('memory_config: would_update')
      || !result.stdout.includes('(memory)')
    ) {
      console.error('upgrade dry-run did not preview enabled capability config migration');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runHandoff(['upgrade', '--target', targetRoot]);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('upgrade requires --dry-run or --apply')) {
      console.error('upgrade without dry-run did not fail explicitly');
      writeResultOutput(result);
      return { status: 1, checks };
    }

    const nonHarnessRoot = path.join(tempRoot, 'non-harness-target');
    mkdirSync(nonHarnessRoot, { recursive: true });
    result = runHandoff(['upgrade', '--target', nonHarnessRoot, '--dry-run']);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('upgrade requires .plan2agent/manifest.json')) {
      console.error('upgrade dry-run did not fail for a non-P2A target');
      writeResultOutput(result);
      return { status: 1, checks };
    }

    result = runHandoff(['update', '--target', nonHarnessRoot]);
    checks += 1;
    if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('update requires .plan2agent/manifest.json')) {
      console.error('update preview did not fail for a non-P2A target');
      writeResultOutput(result);
      return { status: 1, checks };
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

function evalRunFixture(runId, status = 'finished') {
  const failed = status === 'failed';
  return {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'webhook-api-service',
    taskId: 'task-002',
    taskTitle: 'Implement HMAC webhook verification',
    iterationId: '1',
    sourceLayout: 'graph',
    taskGraphRef: 'fixtures/webhook-api-service/task-graph.json',
    sourceSpecRef: 'fixtures/webhook-api-service/spec.approved.json',
    agentTool: 'manual',
    workspaceRef: 'fixture',
    workspacePath: ROOT,
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
    status,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:01:00.000Z',
    finishedAt: '2026-07-02T00:01:00.000Z',
    changedFiles: ['src/webhook-verification.ts', 'test/webhook-verification.test.ts'],
    verification: [{
      type: 'test',
      command: 'npm test -- webhook-verification',
      status: failed ? 'failed' : 'passed',
      exitCode: failed ? 1 : 0,
      durationMs: 1000,
      startedAt: '2026-07-02T00:00:30.000Z',
      finishedAt: '2026-07-02T00:00:31.000Z',
      stdoutTail: failed
        ? 'invalid signatures still pass verification'
        : 'Missing or invalid signatures are rejected. Expired timestamps are rejected. Valid signatures pass verification with deterministic tests.',
      stderrTail: null,
      source: 'command',
    }],
    notes: failed
      ? ['Verification failed while checking HMAC rejection behavior.']
      : ['Missing or invalid signatures are rejected. Expired timestamps are rejected. Valid signatures pass verification with deterministic tests.'],
    ...(failed ? {
      failure: {
        class: 'verification_failed',
        retryable: 'after_fix',
        needsUserDecision: false,
        source: 'owner',
      },
      reproduction: {
        steps: ['Run webhook verification tests against invalid signatures.'],
        commands: ['npm test -- webhook-verification'],
        notes: [],
      },
      localization: {
        findings: ['HMAC rejection path still accepts invalid signatures.'],
        files: ['src/webhook-verification.ts'],
      },
      guard: {
        checks: ['npm test -- webhook-verification covers invalid, expired, and valid signatures.'],
        notes: [],
      },
    } : {}),
  };
}

function writeEvalRuns(runsDir, runs) {
  mkdirSync(runsDir, { recursive: true });
  for (const run of runs) {
    writeFileSync(path.join(runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify({
    schema_version: 'p2a.run_index.v1',
    projectId: 'webhook-api-service',
    runs: runs.map((run) => ({
      runId: run.runId,
      taskId: run.taskId,
      iterationId: run.iterationId,
      status: run.status,
      agentTool: run.agentTool,
      workspaceRef: run.workspaceRef,
      taskGraphRef: run.taskGraphRef,
      runRef: `${run.runId}.json`,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    tasks: [{
      taskId: 'task-002',
      runIds: runs.map((run) => run.runId),
      latestRunId: runs[runs.length - 1]?.runId ?? null,
    }],
  }, null, 2)}\n`, 'utf8');
}

function validateEvalFixtureCases() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-eval-'));
  let checks = 0;
  try {
    const baselineRunsDir = path.join(tempRoot, 'baseline-runs');
    const candidateRunsDir = path.join(tempRoot, 'candidate-runs');
    const passRun = evalRunFixture('run-eval-pass');
    const failedRun = evalRunFixture('run-eval-failed', 'failed');
    writeEvalRuns(baselineRunsDir, [passRun]);
    writeEvalRuns(candidateRunsDir, [passRun, failedRun]);

    const graphPath = path.join(FIXTURE_ROOT, 'webhook-api-service', 'task-graph.json');
    let result = runEval(['grade', '--graph', graphPath, '--run', path.join(baselineRunsDir, 'run-eval-pass.json')]);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('Plan2Agent eval grade') || !result.stdout.includes('grade: pass')) {
      console.error('eval grade fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runEval(['compare', '--baseline', baselineRunsDir, '--candidate', candidateRunsDir]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent eval compare')
      || !result.stdout.includes('verdict: fail')
      || !result.stdout.includes('failed_or_blocked_runs')
    ) {
      console.error('eval compare fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runEval(['grade', '--graph', graphPath, '--run', path.join(candidateRunsDir, 'run-eval-failed.json')]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('grade: fail')
      || !result.stdout.includes('Mine proposal candidates')
    ) {
      console.error('eval failed-run grade fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runProposals(['mine', '--runs', candidateRunsDir, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('proposal-run-eval-failed-verification_failed')
      || !result.stdout.includes('verification_failed')
    ) {
      console.error('proposal failure mining fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runEval(['analyze', '--runs', candidateRunsDir]);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('Plan2Agent eval analyze') || !result.stdout.includes('cluster: verification_failed')) {
      console.error('eval analyze fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runRuns([
      'record',
      '--runs',
      candidateRunsDir,
      '--run-id',
      'run-eval-failed',
      '--repro-step',
      'Run webhook verification tests against invalid signatures.',
      '--repro-command',
      'npm test -- webhook-verification',
      '--localization',
      'HMAC rejection path still accepts invalid signatures.',
      '--localized-file',
      'src/webhook-verification.ts',
      '--fix-summary',
      'Reject invalid HMAC signatures before normalization.',
      '--fix-file',
      'src/webhook-verification.ts',
      '--guard',
      'npm test -- webhook-verification covers invalid, expired, and valid signatures.',
    ]);
    checks += 1;
    const structuredRun = JSON.parse(readFileSync(path.join(candidateRunsDir, 'run-eval-failed.json'), 'utf8'));
    if (
      result.status !== 0
      || structuredRun.reproduction?.steps?.length !== 1
      || structuredRun.reproduction?.commands?.length !== 1
      || structuredRun.localization?.files?.[0] !== 'src/webhook-verification.ts'
      || structuredRun.fixSummary?.summaries?.length !== 1
      || structuredRun.guard?.checks?.length !== 1
    ) {
      console.error('run structured detail record fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const evalOutputDir = path.join(tempRoot, 'candidate-eval');
    result = runEval(['generate', '--graph', graphPath, '--runs', candidateRunsDir, '--output', evalOutputDir]);
    checks += 1;
    const evalIndexPath = path.join(evalOutputDir, 'eval-index.json');
    const passGradePath = path.join(evalOutputDir, 'grades', 'run-eval-pass.json');
    const failedGradePath = path.join(evalOutputDir, 'grades', 'run-eval-failed.json');
    const analysisPath = path.join(evalOutputDir, 'analysis.json');
    const evalIndex = existsSync(evalIndexPath) ? JSON.parse(readFileSync(evalIndexPath, 'utf8')) : null;
    const failedGrade = existsSync(failedGradePath) ? JSON.parse(readFileSync(failedGradePath, 'utf8')) : null;
	    if (
	      result.status !== 0
	      || !result.stdout.includes('Plan2Agent eval generate')
	      || !existsSync(passGradePath)
      || !existsSync(failedGradePath)
      || !existsSync(analysisPath)
      || evalIndex?.schema_version !== 'p2a.eval_index.v1'
      || evalIndex?.summary?.grades !== 2
      || evalIndex?.summary?.nonPassGrades !== 1
      || evalIndex?.summary?.clusters !== 1
      || failedGrade?.run?.structuredEvidence?.hasGuard !== true
    ) {
      console.error('eval generate fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runValidator(['--eval-index', evalIndexPath]);
	    checks += 1;
	    if (result.status !== 0) {
	      console.error('eval index schema validation fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    const staleGradePath = path.join(evalOutputDir, 'grades', 'run-stale-old.json');
	    writeFileSync(staleGradePath, `${JSON.stringify({
	      schema_version: 'p2a.eval_grade.v1',
	      run: { runId: 'run-stale-old' },
	      task: { taskId: 'task-999' },
	      verdict: 'fail',
	      score: 0,
	      acceptanceCoverage: [],
	      reasons: ['stale fixture grade'],
	    }, null, 2)}\n`, 'utf8');
	    result = runEval(['generate', '--graph', graphPath, '--runs', candidateRunsDir, '--output', evalOutputDir]);
	    checks += 1;
	    const regeneratedEvalIndex = existsSync(evalIndexPath) ? JSON.parse(readFileSync(evalIndexPath, 'utf8')) : null;
	    if (
	      result.status !== 0
	      || existsSync(staleGradePath)
	      || regeneratedEvalIndex?.summary?.grades !== 2
	      || regeneratedEvalIndex?.summary?.nonPassGrades !== 1
	    ) {
	      console.error('eval generate stale output cleanup fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runEval(['digest', '--eval', evalOutputDir]);
	    checks += 1;
	    if (result.status !== 0 || !result.stdout.includes('Plan2Agent eval digest') || !result.stdout.includes('"pass":1') || !result.stdout.includes('"fail":1')) {
	      console.error('eval digest fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    const nestedEvalDigestPath = path.join(evalOutputDir, 'eval-digest.json');
	    result = runEval(['digest', '--eval', evalOutputDir, '--output', nestedEvalDigestPath]);
	    checks += 1;
	    if (result.status !== 0 || !existsSync(nestedEvalDigestPath)) {
	      console.error('eval digest nested output fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runEval(['digest', '--eval', evalOutputDir]);
	    checks += 1;
	    if (result.status !== 0 || !result.stdout.includes('digests=1') || !result.stdout.includes('skipped=0')) {
	      console.error('eval digest should ignore supported nested digest fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

    const evalDigestPath = path.join(tempRoot, 'eval-digest.json');
    result = runEval(['digest', '--eval', evalOutputDir, '--output', evalDigestPath]);
    checks += 1;
    const evalDigest = existsSync(evalDigestPath) ? JSON.parse(readFileSync(evalDigestPath, 'utf8')) : null;
	    if (
	      result.status !== 0
	      || !existsSync(evalDigestPath)
      || evalDigest?.schema_version !== 'p2a.eval_digest.v1'
      || evalDigest?.grades?.byVerdict?.pass !== 1
      || evalDigest?.grades?.byVerdict?.fail !== 1
      || evalDigest?.analyses?.clusters !== 1
    ) {
      console.error('eval digest output fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runValidator(['--eval-digest', evalDigestPath]);
	    checks += 1;
	    if (result.status !== 0) {
	      console.error('eval digest schema validation fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

    const evalArtifactRoot = path.join(tempRoot, 'eval-artifact-root');
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), evalArtifactRoot, { recursive: true });
    result = runIteration(['init', '--artifacts', evalArtifactRoot, '--iteration-id', 'v1-mvp']);
    checks += 1;
    if (result.status !== 0) {
      console.error('eval maintenance fixture iteration init failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    writeEvalRuns(path.join(evalArtifactRoot, 'runs'), [passRun, structuredRun]);
    const maintenanceDraftPath = path.join(tempRoot, 'eval-maintenance-draft.json');
    result = runEval(['analyze', '--artifacts', evalArtifactRoot, '--maintenance-draft', maintenanceDraftPath]);
    checks += 1;
    const maintenanceDraft = existsSync(maintenanceDraftPath) ? JSON.parse(readFileSync(maintenanceDraftPath, 'utf8')) : null;
	    if (
	      result.status !== 0
	      || !result.stdout.includes('maintenance draft: tasks=1')
	      || maintenanceDraft?.schema_version !== 'p2a.eval_maintenance_draft.v1'
	      || maintenanceDraft?.tasks?.[0]?.sourceSpecRefs?.some((ref) => typeof ref === 'string' && ref.startsWith('eval-cluster:cluster-verification_failed-')) !== true
	    ) {
	      console.error('eval maintenance draft fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runValidator(['--eval-maintenance-draft', maintenanceDraftPath]);
	    checks += 1;
	    if (result.status !== 0) {
	      console.error('eval maintenance draft schema validation fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

    result = runEval(['analyze', '--artifacts', evalArtifactRoot, '--apply-maintenance', '--dry-run']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('maintenance apply: dry_run')) {
      console.error('eval maintenance dry-run apply fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runEval(['analyze', '--artifacts', evalArtifactRoot, '--apply-maintenance', '--yes']);
	    checks += 1;
	    const evalMaintenanceGraphPath = path.join(evalArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
	    const evalMaintenanceGraph = existsSync(evalMaintenanceGraphPath) ? JSON.parse(readFileSync(evalMaintenanceGraphPath, 'utf8')) : null;
	    const evalMaintenanceReportPath = path.join(evalArtifactRoot, 'eval', 'maintenance-apply-report.json');
	    const evalMaintenanceReport = existsSync(evalMaintenanceReportPath) ? JSON.parse(readFileSync(evalMaintenanceReportPath, 'utf8')) : null;
	    if (
	      result.status !== 0
	      || !result.stdout.includes('maintenance apply: applied')
	      || evalMaintenanceGraph?.tasks?.length !== 1
	      || evalMaintenanceGraph?.tasks?.[0]?.sourceSpecRefs?.some((ref) => typeof ref === 'string' && ref.startsWith('eval-cluster:cluster-verification_failed-')) !== true
	      || evalMaintenanceReport?.schema_version !== 'p2a.eval_maintenance_apply_report.v1'
	      || evalMaintenanceReport?.status !== 'applied'
	    ) {
	      console.error('eval maintenance apply fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runValidator(['--eval-maintenance-apply-report', evalMaintenanceReportPath]);
	    checks += 1;
	    if (result.status !== 0) {
	      console.error('eval maintenance apply report schema validation fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

    result = runEval(['analyze', '--artifacts', evalArtifactRoot, '--apply-maintenance', '--yes']);
    checks += 1;
    const evalMaintenanceGraphAfterNoop = JSON.parse(readFileSync(evalMaintenanceGraphPath, 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('maintenance apply: noop')
      || evalMaintenanceGraphAfterNoop.tasks?.length !== 1
    ) {
      console.error('eval maintenance apply idempotency fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return { status: 0, checks };
}

function validateMemoryFixtureCases() {
  let checks = 0;
  const graphPath = path.join(FIXTURE_ROOT, 'webhook-api-service', 'task-graph.json');

  let result = runMemory(['status', '--graph', graphPath]);
  checks += 1;
  if (result.status !== 0 || !result.stdout.includes('Plan2Agent memory status') || !result.stdout.includes('documents=2') || !result.stdout.includes('taskGraphs=1')) {
    console.error('memory status fixture failed');
    writeResultOutput(result);
    return { status: failureStatus(result), checks };
  }

  result = runMemory(['status', '--graph', graphPath, '--json']);
  checks += 1;
  const memoryStatusJson = result.status === 0 ? JSON.parse(result.stdout) : null;
  const memoryProjectItem = memoryStatusJson?.sync?.items?.find((item) => item.artifactType === 'PROJECT');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    result.status !== 0
    || memoryStatusJson?.schema_version !== 'p2a.memory_status.v1'
    || !uuidPattern.test(memoryProjectItem?.artifactId ?? '')
    || memoryProjectItem?.artifactId?.startsWith('p2a-project-')
  ) {
    console.error('memory status canonical UUID fixture failed');
    writeResultOutput(result);
    return { status: failureStatus(result), checks };
  }

  result = runMemory(['push', '--graph', graphPath, '--dry-run']);
  checks += 1;
  if (result.status !== 0 || !result.stdout.includes('Plan2Agent memory push dry run') || !result.stdout.includes('dry-run: no server writes') || !result.stdout.includes('DOCUMENT_CHUNK:')) {
    console.error('memory push dry-run fixture failed');
    writeResultOutput(result);
    return { status: failureStatus(result), checks };
  }

  result = runMemory(['pull', '--graph', graphPath, '--dry-run']);
  checks += 1;
  if (result.status === 0 || !result.stdout.includes('Plan2Agent memory pull dry run') || !result.stdout.includes('server: not_configured') || !result.stdout.includes('dry-run: no artifact files written') || !result.stdout.includes('restore: canApply=no')) {
    console.error('memory pull dry-run not-configured fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  const pullReportDir = mkdtempSync(path.join(tmpdir(), 'p2a-memory-pull-report-'));
  const pullReportPath = path.join(pullReportDir, 'memory-pull-report.json');
  result = runMemory(['pull', '--graph', graphPath, '--dry-run', '--output', pullReportPath]);
  checks += 1;
  const pullReport = existsSync(pullReportPath) ? JSON.parse(readFileSync(pullReportPath, 'utf8')) : null;
  if (
    result.status === 0
    || !pullReport
    || pullReport.schema_version !== 'p2a.memory_pull_preview.v1'
    || pullReport.restorePlan?.canApply !== false
    || pullReport.reportWrites !== 1
  ) {
    console.error('memory pull restore report fixture failed');
    writeResultOutput(result);
    console.error(JSON.stringify({ pullReport }, null, 2));
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }
  rmSync(pullReportDir, { recursive: true, force: true });

  result = runMemory(['pull', '--graph', graphPath]);
  checks += 1;
  if (result.status === 0 || !result.stderr.includes('pull is preview-only for now and requires --dry-run')) {
    console.error('memory pull dry-run guard fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['pull', '--graph', graphPath, '--apply', '--yes']);
  checks += 1;
  if (result.status === 0 || !result.stderr.includes('memory pull --apply is not available')) {
    console.error('memory pull apply guard fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['search', '--graph', graphPath, '--query', 'webhook', '--type', 'document']);
  checks += 1;
  if (result.status === 0 || !result.stdout.includes('Plan2Agent memory search') || !result.stdout.includes('server: not_configured') || !result.stdout.includes('Set P2A_MEMORY_URL or pass --server to search Memory.')) {
    console.error('memory search not-configured fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['search', '--graph', graphPath, '--query', 'webhook', '--type', 'proposal']);
  checks += 1;
  if (result.status === 0 || !result.stderr.includes('Memory search does not support proposal type yet')) {
    console.error('memory search unsupported type fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['search', '--query', 'webhook', '--global', '--source-path', './fixtures/webhook-api-service/task-graph.json', '--json']);
  checks += 1;
  const searchSourcePathPayload = result.stdout ? JSON.parse(result.stdout) : null;
  if (
    result.status === 0
    || searchSourcePathPayload?.query?.sourcePath !== 'fixtures/webhook-api-service/task-graph.json'
  ) {
    console.error('memory search source-path normalization fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['history', '--graph', graphPath]);
  checks += 1;
  if (
    result.status !== 0
    || !result.stdout.includes('Plan2Agent memory history')
    || !result.stdout.includes('server: not_configured')
    || !result.stdout.includes('TASK_GRAPH=')
    || !result.stdout.includes('Set P2A_MEMORY_URL or pass --server to include remote Memory history.')
  ) {
    console.error('memory history local fixture failed');
    writeResultOutput(result);
    return { status: failureStatus(result), checks };
  }

  const historyRunsDir = mkdtempSync(path.join(tmpdir(), 'p2a-memory-history-runs-'));
  try {
    writeEvalRuns(historyRunsDir, [evalRunFixture('run-memory-history-failed', 'failed')]);
    result = runMemory(['history', '--runs', historyRunsDir]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('failedOrBlockedRuns=1')
      || !result.stdout.includes('Summarize maintenance candidates: node .plan2agent/scripts/p2a.mjs memory digest --runs')
      || !result.stdout.includes('Analyze failure clusters: node .plan2agent/scripts/p2a.mjs eval analyze --runs')
    ) {
      console.error('memory history failed run next actions fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  } finally {
    rmSync(historyRunsDir, { recursive: true, force: true });
  }

  result = runMemory(['history', '--global', '--project', 'webhook-api-service', '--json']);
  checks += 1;
  const historyGlobalPayload = result.stdout ? JSON.parse(result.stdout) : null;
  if (
    result.status === 0
    || historyGlobalPayload?.schema_version !== 'p2a.memory_history.v1'
    || historyGlobalPayload?.scope?.mode !== 'global'
    || historyGlobalPayload?.scope?.projectId !== 'webhook-api-service'
    || historyGlobalPayload?.server?.status !== 'not_configured'
  ) {
    console.error('memory history global not-configured fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const graphSourcePath = normalizeFixturePath(graphPath);
  const graphDocumentSourceId = sourceDocumentId(graph.projectId, graph.version, graphSourcePath);
  const duplicateRemoteSync = compareSync({
    syncItems: [
      {
        artifactType: 'DOCUMENT_SNAPSHOT',
        sourceKey: graphDocumentSourceId,
        sourcePath: graphSourcePath,
        contentHash: hashText(readFileSync(graphPath, 'utf8')),
        sourceIds: {
          sourceDocumentId: graphDocumentSourceId,
        },
      },
    ],
  }, [
    {
      artifactType: 'DOCUMENT_SNAPSHOT',
      artifactId: 'remote-task-graph-latest',
      projectId: 'remote-project-id',
      iterationId: 'remote-iteration-id',
      sourcePath: graphSourcePath,
      title: path.basename(graphPath),
      contentHash: hashText(readFileSync(graphPath, 'utf8')),
      snapshotVersion: 2,
      createdAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      sourceIds: {
        sourceProjectId: graph.projectId,
        sourceIterationId: graph.version,
        sourceDocumentId: graphDocumentSourceId,
      },
      metadata: {
        sourceDocumentId: graphDocumentSourceId,
      },
    },
    {
      artifactType: 'DOCUMENT_SNAPSHOT',
      artifactId: 'remote-task-graph-old',
      projectId: 'remote-project-id',
      iterationId: 'remote-iteration-id',
      sourcePath: graphSourcePath,
      title: path.basename(graphPath),
      contentHash: 'older-task-graph-hash',
      snapshotVersion: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      sourceIds: {
        sourceProjectId: graph.projectId,
        sourceIterationId: graph.version,
        sourceDocumentId: graphDocumentSourceId,
      },
      metadata: {
        sourceDocumentId: graphDocumentSourceId,
      },
    },
  ]);
  checks += 1;
  const duplicateRemoteItem = duplicateRemoteSync.items[0];
  if (
    duplicateRemoteSync.summary.synced !== 1
    || duplicateRemoteSync.summary.remoteDiffers !== 0
    || duplicateRemoteSync.summary.extraRemote !== 0
    || duplicateRemoteItem.remoteArtifactId !== 'remote-task-graph-latest'
    || duplicateRemoteItem.remoteSnapshotVersion !== 2
  ) {
    console.error('memory duplicate remote snapshot comparison fixture failed');
    console.error(JSON.stringify({ duplicateRemoteSync }, null, 2));
    return { status: 1, checks };
  }

  result = runMemory(['digest', '--graph', graphPath]);
  checks += 1;
  if (result.status !== 0 || !result.stdout.includes('Plan2Agent memory digest') || !result.stdout.includes('runs: total=0')) {
    console.error('memory digest fixture failed');
    writeResultOutput(result);
    return { status: failureStatus(result), checks };
  }

  const digestRunsDir = mkdtempSync(path.join(tmpdir(), 'p2a-memory-digest-runs-'));
  try {
    writeEvalRuns(digestRunsDir, [evalRunFixture('run-memory-digest-failed', 'failed')]);
    result = runMemory(['digest', '--runs', digestRunsDir]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('structured: reproduction=1/1 localization=1/1 guard=1/1')
      || !result.stdout.includes('Mine missing proposal candidates')
    ) {
      console.error('memory digest structured detail fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  } finally {
    rmSync(digestRunsDir, { recursive: true, force: true });
  }

  result = runMemory(['push', '--graph', graphPath]);
  checks += 1;
  if (result.status === 0 || !result.stdout.includes('Actual Memory writes require --yes')) {
    console.error('memory push approval guard fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
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
      if (result.status !== 0 || !existsSync(path.join(targetRoot, '.plan2agent', 'artifacts', caseData.project_id, 'gate-b-spec', 'spec.json'))) {
        console.error(`greenfield handoff fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      if (
        !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_paths.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_project_config.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_run_commands.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'validate_artifacts.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_execute.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_orchestrate.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_run_paths.mjs'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'task-context.schema.json'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'run.schema.json'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'run-index.schema.json'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'orchestration-plan.schema.json'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'orchestration-runtime.schema.json'))
        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'skill-proposal.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'proposal-review.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'proposal-curation.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'proposal-patch-draft.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'proposal-draft-approval.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'eval-index.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'eval-digest.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'eval-maintenance-draft.schema.json'))
	        || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'eval-maintenance-apply-report.schema.json'))
	        || existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json'))
      ) {
        console.error(`greenfield handoff wrote unexpected tool/current-spec files: ${caseData.id}`);
        return { status: 1, checks };
      }
      result = assertTargetSpecSourceIntake(targetRoot, caseData.project_id, caseData.id, 'greenfield');
      checks += 1;
      if (result.status !== 0) return { status: result.status, checks };

      const targetArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', caseData.project_id);
      const targetTaskGraphPath = path.join(targetArtifactRoot, 'gate-c-task-graph', 'task-graph.json');
      result = runTargetTasks(targetRoot, ['ready', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`greenfield handoff target p2a_tasks execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetRuns(targetRoot, ['list', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('runId')) {
        console.error(`greenfield handoff target p2a_runs execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetExecute(targetRoot, ['plan', '--graph', targetTaskGraphPath, '--task', 'task-001', '--run-id', 'run-target-execute-plan']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Plan2Agent supervised task execution')) {
        console.error(`greenfield handoff target p2a_execute execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetOrchestrate(targetRoot, ['plan', '--graph', targetTaskGraphPath, '--task', 'task-001']);
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

      result = runTargetP2a(targetRoot, ['tasks', 'ready', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`greenfield handoff target p2a tasks dispatch failed: ${caseData.id}`);
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
      const excludedToolFiles = [
        path.join('.agents', 'skills', 'p2a-design-system', 'SKILL.md'),
        path.join('.gemini', 'commands', 'p2a', 'design-system.toml'),
      ];
      const copiedExcludedToolFiles = excludedToolFiles.filter((filePath) => existsSync(path.join(toolTargetRoot, filePath)));
      const toolManifest = JSON.parse(readFileSync(path.join(toolTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      const manifestDesignSystemFiles = [...(toolManifest.aiToolFiles ?? []), ...(toolManifest.toolFiles ?? [])]
        .filter((filePath) => filePath.includes('p2a-design-system') || filePath.endsWith('/design-system.toml'));
      if (
        missingToolFiles.length
        || copiedExcludedToolFiles.length
        || manifestDesignSystemFiles.length
        || toolManifest.aiToolTargets.join(',') !== 'codex,gemini'
        || !toolManifest.includedTools.includes('p2a_codex_assets')
        || !toolManifest.includedTools.includes('p2a_gemini_assets')
        || !toolManifest.includedTools.includes('p2a_runs')
        || !toolManifest.includedTools.includes('p2a')
        || !toolManifest.includedTools.includes('p2a_execute')
        || !toolManifest.includedTools.includes('p2a_orchestrate')
        || !toolManifest.includedTools.includes('p2a_proposals')
        || !toolManifest.toolFiles.includes('.agents/skills/p2a-harness/SKILL.md')
        || !toolManifest.toolFiles.includes('.gemini/commands/p2a/harness.toml')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a.mjs')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a_runs.mjs')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a_execute.mjs')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a_orchestrate.mjs')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a_proposals.mjs')
        || !toolManifest.toolFiles.includes('.plan2agent/scripts/p2a_run_paths.mjs')
        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/run.schema.json')
        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/orchestration-plan.schema.json')
        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/orchestration-runtime.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/proposal-review.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/proposal-curation.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/proposal-patch-draft.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/proposal-draft-approval.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/eval-index.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/eval-digest.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-draft.schema.json')
	        || !toolManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-apply-report.schema.json')
	      ) {
        console.error(`greenfield handoff --tools output mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ missingToolFiles, copiedExcludedToolFiles, manifestDesignSystemFiles, toolManifest }, null, 2));
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
      const teamProjectConfig = JSON.parse(readFileSync(path.join(teamTargetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
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
        || teamProjectConfig.providerNativeCapabilities?.claude?.agentTeams !== 'manual_check'
        || teamProjectConfig.providerNativeCapabilities?.codex?.customAgents !== 'manual_check'
        || teamSourceManifest.source.fileCount !== 2
        || teamSourceManifest.source.files.some((file) => file.path === '.env' || file.path.startsWith('_workspace/'))
      ) {
        console.error(`greenfield handoff Team Big Five output mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ missingTeamFiles, teamManifest, teamProjectConfig, teamSourceManifest }, null, 2));
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

  function copyWebhookTaskGraph(tempRoot, name) {
    const graphPath = path.join(tempRoot, name, 'gate-c-task-graph', 'task-graph.json');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service', 'gate-c-task-graph', 'task-graph.json'), graphPath);
    return graphPath;
  }

  function passedFixtureVerification(command) {
    return {
      type: 'custom',
      command,
      status: 'passed',
      exitCode: 0,
      durationMs: 1,
      startedAt: '2026-07-02T00:00:00.000Z',
      finishedAt: '2026-07-02T00:00:00.001Z',
      stdoutTail: 'passed',
      stderrTail: null,
      source: 'command',
    };
  }

  function writeLatestRunEvidence(runsDir, taskId, run) {
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(path.join(runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify({
      schema_version: 'p2a.run_index.v1',
      projectId: run.projectId,
      runs: [{
        runId: run.runId,
        taskId,
        iterationId: run.iterationId,
        status: run.status,
        agentTool: run.agentTool,
        workspaceRef: run.workspaceRef,
        taskGraphRef: run.taskGraphRef,
        runRef: `${run.runId}.json`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      }],
      tasks: [{
        taskId,
        runIds: [run.runId],
        latestRunId: run.runId,
      }],
    }, null, 2)}\n`, 'utf8');
  }

  function writeRunEvidenceSet(runsDir, taskId, runs) {
    mkdirSync(runsDir, { recursive: true });
    for (const run of runs) {
      writeFileSync(path.join(runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    }
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify({
      schema_version: 'p2a.run_index.v1',
      projectId: runs[0]?.projectId ?? 'fixture-project',
      runs: runs.map((run) => ({
        runId: run.runId,
        taskId: run.taskId,
        iterationId: run.iterationId,
        status: run.status,
        agentTool: run.agentTool,
        workspaceRef: run.workspaceRef,
        taskGraphRef: run.taskGraphRef,
        runRef: `${run.runId}.json`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
      tasks: [{
        taskId,
        runIds: runs.map((run) => run.runId),
        latestRunId: runs[runs.length - 1]?.runId ?? null,
      }],
    }, null, 2)}\n`, 'utf8');
  }

  for (const caseData of cases) {
    assertE2eCaseShape(caseData);
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'p2a-iteration-fixture-'));
    try {
      const sourceRoot = path.resolve(ROOT, caseData.artifact_root);
      const artifactRoot = path.join(tempRoot, path.basename(caseData.artifact_root));
      cpSync(sourceRoot, artifactRoot, { recursive: true });

      const greenfieldStatusText = readFileSync(path.join(artifactRoot, 'status.md'), 'utf8');
      writeFileSync(path.join(artifactRoot, 'status.md'), '# broken generated status\n', 'utf8');
      let result = runValidator(['--artifact-root', artifactRoot, '--project-id', caseData.project_id]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('artifact validation passed')) {
        console.error(`artifact-root validation did not tolerate broken generated status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), greenfieldStatusText, 'utf8');
        return { status: failureStatus(result), checks };
      }
      result = runValidator(['--status', path.join(artifactRoot, 'status.md')]);
      checks += 1;
      const explicitGreenfieldStatusOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !explicitGreenfieldStatusOutput.includes('status.md missing Progress line')) {
        console.error(`explicit status validator did not reject broken greenfield status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), greenfieldStatusText, 'utf8');
        return { status: 1, checks };
      }
      writeFileSync(path.join(artifactRoot, 'status.md'), greenfieldStatusText, 'utf8');

      const markdownOnlyRoot = path.join(tempRoot, 'markdown-only-gate-root');
      mkdirSync(path.join(markdownOnlyRoot, 'gate-a-intake'), { recursive: true });
      mkdirSync(path.join(markdownOnlyRoot, 'gate-b-spec'), { recursive: true });
      mkdirSync(path.join(markdownOnlyRoot, 'gate-d-review'), { recursive: true });
      cpSync(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), path.join(markdownOnlyRoot, 'gate-a-intake', 'intake.json'));
      writeFileSync(path.join(markdownOnlyRoot, 'gate-b-spec', 'product-spec.md'), '# generated product spec view\n', 'utf8');
      writeFileSync(path.join(markdownOnlyRoot, 'gate-b-spec', 'implementation-plan.md'), '# generated implementation plan view\n', 'utf8');
      writeFileSync(path.join(markdownOnlyRoot, 'gate-d-review', 'review-report.md'), '# generated review view\n', 'utf8');
      result = runValidator(['--artifact-root', markdownOnlyRoot, '--project-id', caseData.project_id]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('artifact validation passed')) {
        console.error(`artifact-root validation treated generated markdown views as gate presence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'v1-mvp']);
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
      if (result.status !== 0 || !brokenStatusOutput.includes('iteration validation passed')) {
        console.error(`iteration validate fixture did not tolerate broken generated status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), statusText, 'utf8');
        return { status: failureStatus(result), checks };
      }
      result = runValidator(['--status', path.join(artifactRoot, 'status.md')]);
      checks += 1;
      const explicitStatusOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !explicitStatusOutput.includes('status.md missing Progress line')) {
        console.error(`explicit status validator did not reject broken status.md structure: ${caseData.id}`);
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

      result = runTasks(['ready', '--graph', state.taskGraphPath]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stderr.includes('--graph mode does not check Gate B/D prerequisites')
      ) {
        console.error(`p2a_tasks --graph warning fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const missingValueChecks = [
        ['p2a_tasks', runTasks(['ready', '--graph', '--artifacts'])],
        ['p2a_runs', runRuns(['list', '--graph', '--runs'])],
        ['p2a_execute', runExecute(['plan', '--graph', '--task', 'task-001'])],
        ['p2a_orchestrate', runOrchestrate(['plan', '--graph', '--task', 'task-001'])],
      ];
      for (const [label, checkResult] of missingValueChecks) {
        checks += 1;
        const output = `${checkResult.stdout ?? ''}${checkResult.stderr ?? ''}`;
        if (checkResult.status === 0 || !output.includes('missing value for')) {
          console.error(`${label} did not reject missing flag value: ${caseData.id}`);
          writeResultOutput(checkResult);
          return { status: 1, checks };
        }
      }

      const leadingDashNoteGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-leading-dash-note');
      result = runTasks(['block', '--graph', leadingDashNoteGraphPath, 'task-001', '--note', '--blocked-by-owner']);
      checks += 1;
      const leadingDashTaskGraph = JSON.parse(readFileSync(leadingDashNoteGraphPath, 'utf8'));
      const leadingDashTask = leadingDashTaskGraph.tasks.find((task) => task.id === 'task-001');
      if (
        result.status !== 0
        || leadingDashTask?.status !== 'blocked'
        || leadingDashTask?.blockNote !== '--blocked-by-owner'
      ) {
        console.error(`p2a_tasks rejected leading-dash block note value: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ leadingDashTask }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const leadingDashRunNote = runRuns(['record', '--graph', state.taskGraphPath, '--run-id', 'run-leading-dash-note', '--note', '--blocked-by-owner']);
      checks += 1;
      const leadingDashRunNoteOutput = `${leadingDashRunNote.stdout ?? ''}${leadingDashRunNote.stderr ?? ''}`;
      if (
        leadingDashRunNote.status === 0
        || leadingDashRunNoteOutput.includes('missing value for --note')
        || !leadingDashRunNoteOutput.includes('run-leading-dash-note is missing')
      ) {
        console.error(`p2a_runs did not accept leading-dash note value before run lookup: ${caseData.id}`);
        writeResultOutput(leadingDashRunNote);
        return { status: 1, checks };
      }

      const leadingDashExecuteCommand = runExecute(['finish', '--graph', state.taskGraphPath, '--run-id', 'run-leading-dash-command', '--test-command', '--version']);
      checks += 1;
      const leadingDashExecuteOutput = `${leadingDashExecuteCommand.stdout ?? ''}${leadingDashExecuteCommand.stderr ?? ''}`;
      if (
        leadingDashExecuteCommand.status === 0
        || leadingDashExecuteOutput.includes('missing value for --test-command')
        || !leadingDashExecuteOutput.includes('run-leading-dash-command is missing')
      ) {
        console.error(`p2a_execute did not accept leading-dash command value before run lookup: ${caseData.id}`);
        writeResultOutput(leadingDashExecuteCommand);
        return { status: 1, checks };
      }

      const leadingDashRuntimePath = path.join(tempRoot, 'missing-leading-dash-runtime.json');
      const leadingDashOrchestrateSummary = runOrchestrate([
        'record',
        '--runtime',
        leadingDashRuntimePath,
        '--role',
        'implementer',
        '--type',
        'status',
        '--summary',
        '--blocked',
      ]);
      checks += 1;
      const leadingDashOrchestrateOutput = `${leadingDashOrchestrateSummary.stdout ?? ''}${leadingDashOrchestrateSummary.stderr ?? ''}`;
      if (
        leadingDashOrchestrateSummary.status === 0
        || leadingDashOrchestrateOutput.includes('missing value for --summary')
        || !leadingDashOrchestrateOutput.includes('orchestration runtime is missing')
      ) {
        console.error(`p2a_orchestrate did not accept leading-dash summary value before runtime lookup: ${caseData.id}`);
        writeResultOutput(leadingDashOrchestrateSummary);
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
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent supervised task execution')
        || !result.stderr.includes('--graph mode does not check Gate B/D prerequisites')
      ) {
        console.error(`p2a_execute plan fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('"schema_version": "p2a.orchestration_plan.v1"')
        || !result.stderr.includes('--graph mode does not check Gate B/D prerequisites')
      ) {
        console.error(`p2a_orchestrate --graph warning fixture failed: ${caseData.id}`);
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
        || executeOrchestrationPlan.roles.find((role) => role.roleId === 'owner')?.profile !== 'owner_supervisor'
        || executeOrchestrationPlan.roles.find((role) => role.roleId === 'owner')?.profileSource !== 'auto'
        || !executeOrchestrationPlan.roles.every((role) => typeof role.profile === 'string' && role.profile.length > 0)
        || !executeOrchestrationPlan.roles.every((role) => role.profileSource === 'auto' && typeof role.profileReason === 'string' && role.profileReason.length > 0)
        || !executeOrchestrationPlan.roles.every((role) => role.executionGuide?.startsProcess === false && role.executionGuide?.supervisionRequired === true)
        || executeOrchestrationPlan.roles.find((role) => role.roleId === 'implementer')?.executionGuide?.recommendedFeature !== 'skills_custom_agents_explicit_subagent_prompt'
        || executeOrchestrationPlan.monitorGate.required
        || executeOrchestrationPlan.monitorGate.verdictPath !== null
      ) {
        console.error(`p2a_orchestrate default fixture should stay solo: ${caseData.id}`);
        console.error(JSON.stringify({ executeOrchestrationPlan }, null, 2));
        return { status: 1, checks };
      }

      const legacyOrchestrationPlanPath = path.join(tempRoot, 'p2a-execute', 'orchestration', 'task-001-legacy-execution-guide.json');
      const legacyOrchestrationPlan = JSON.parse(JSON.stringify(executeOrchestrationPlan));
      legacyOrchestrationPlan.roles.forEach((role) => {
        delete role.executionGuide;
      });
      writeFileSync(legacyOrchestrationPlanPath, `${JSON.stringify(legacyOrchestrationPlan, null, 2)}\n`, 'utf8');
      result = runValidator(['--orchestration-plan', legacyOrchestrationPlanPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`orchestration plan validator should backfill legacy executionGuide: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const legacyOrchestrationPlanForDirectValidation = JSON.parse(JSON.stringify(legacyOrchestrationPlan));
      const normalizedLegacyOrchestrationPlan = validateOrchestrationPlanData(legacyOrchestrationPlanForDirectValidation);
      checks += 1;
      if (
        legacyOrchestrationPlanForDirectValidation.roles.some((role) => role.executionGuide)
        || !normalizedLegacyOrchestrationPlan.roles.every((role) => role.executionGuide?.startsProcess === false)
      ) {
        console.error(`orchestration plan direct validator should normalize without mutating input: ${caseData.id}`);
        console.error(JSON.stringify({ legacyOrchestrationPlanForDirectValidation, normalizedLegacyOrchestrationPlan }, null, 2));
        return { status: 1, checks };
      }

      const mismatchedExecutionGuidePlanPath = path.join(tempRoot, 'p2a-execute', 'orchestration', 'task-001-mismatched-execution-guide.json');
      const mismatchedExecutionGuidePlan = JSON.parse(JSON.stringify(executeOrchestrationPlan));
      mismatchedExecutionGuidePlan.roles.find((role) => role.roleId === 'implementer').executionGuide.surface = 'Claude Code foreground session';
      writeFileSync(mismatchedExecutionGuidePlanPath, `${JSON.stringify(mismatchedExecutionGuidePlan, null, 2)}\n`, 'utf8');
      result = runValidator(['--orchestration-plan', mismatchedExecutionGuidePlanPath]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('executionGuide.surface must match codex/contributor')) {
        console.error(`orchestration plan validator should reject mismatched executionGuide provider: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const executeUiProfileGraphPath = path.join(tempRoot, 'p2a-orchestrate-ui-profile', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeUiProfileGraphPath), { recursive: true });
      const executeUiProfileGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      const executeUiProfileTask = executeUiProfileGraph.tasks.find((task) => task.id === 'task-001');
      executeUiProfileTask.title = 'Build frontend settings screen';
      executeUiProfileTask.description = 'Add a React UI screen with responsive layout, empty state, and accessible controls.';
      executeUiProfileTask.targetArea = 'ui';
      executeUiProfileTask.acceptanceCriteria = ['The UI screen renders responsive controls.', 'Empty and error states are visible.'];
      executeUiProfileTask.suggestedAgentPrompt = 'Implement the frontend screen without changing backend contracts.';
      writeFileSync(executeUiProfileGraphPath, `${JSON.stringify(executeUiProfileGraph, null, 2)}\n`, 'utf8');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeUiProfileGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
      ]);
      checks += 1;
      const executeUiProfilePlan = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeUiProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profile !== 'frontend_implementer'
        || executeUiProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profileSource !== 'auto'
        || !executeUiProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profileReason.includes('targetArea')
        || !executeUiProfilePlan.handoffPrompts.find((prompt) => prompt.roleId === 'implementer')?.prompt.includes('Profile: frontend_implementer')
        || !executeUiProfilePlan.handoffPrompts.find((prompt) => prompt.roleId === 'implementer')?.prompt.includes('Recommended feature: skills_custom_agents_explicit_subagent_prompt')
      ) {
        console.error(`p2a_orchestrate UI task should select frontend_implementer: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeUiProfilePlan }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeUiProfileGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--implementer-profile',
        'backend_implementer',
      ]);
      checks += 1;
      const executeOverrideProfilePlan = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeOverrideProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profile !== 'backend_implementer'
        || executeOverrideProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profileSource !== 'override'
        || !executeOverrideProfilePlan.roles.find((role) => role.roleId === 'implementer')?.profileReason.includes('--implementer-profile')
      ) {
        console.error(`p2a_orchestrate should record implementer profile override: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeOverrideProfilePlan }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'plan',
        '--graph',
        executeUiProfileGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--reviewer-profile',
        'qa_reviewer',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('--reviewer-profile requires a team-mode task')) {
        console.error(`p2a_orchestrate should reject unused reviewer profile override on solo task: ${caseData.id}`);
        writeResultOutput(result);
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
        || executeRuntime.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'implementer')?.profileSource !== executeSidecar.roles.find((role) => role.roleId === 'implementer')?.profileSource
        || !executeRuntime.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'implementer')?.profileReason
        || executeRuntime.sharedMentalModel.roleAssignments.find((role) => role.roleId === 'implementer')?.executionGuide?.surface !== 'Codex CLI/app foreground session'
        || !executeRuntime.communicationLog.some((event) => event.type === 'handoff')
        || executeRuntime.status.phase !== 'running'
      ) {
        console.error(`p2a_execute start wrote unexpected orchestration runtime: ${caseData.id}`);
        console.error(JSON.stringify({ executeRuntime, executeSidecar }, null, 2));
        return { status: 1, checks };
      }

      result = runExecute([
        'resume',
        '--graph',
        executeGraphPath,
        '--spec',
        state.specPath,
        '--run-id',
        'run-execute-fixture',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent execution resume')
        || !result.stdout.includes('Manual launcher prompt')
        || !result.stdout.includes('p2a.mjs execute status')
        || !result.stdout.includes('p2a.mjs execute finish')
        || !result.stdout.includes('p2a.mjs proposals mine')
      ) {
        console.error(`p2a_execute resume fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeIsolationGraphPath = path.join(tempRoot, 'p2a-execute-isolation', 'gate-c-task-graph', 'task-graph.json');
      const executeIsolationWorkspace = path.join(tempRoot, 'execute-isolation-workspace');
      const executeIsolationWorktree = path.join(tempRoot, 'execute-isolation-worktree');
      mkdirSync(path.dirname(executeIsolationGraphPath), { recursive: true });
      mkdirSync(executeIsolationWorkspace, { recursive: true });
      writeFileSync(executeIsolationGraphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
      writeFileSync(path.join(executeIsolationWorkspace, 'baseline.txt'), 'baseline\n', 'utf8');
      result = spawnSync('git', ['init'], { cwd: executeIsolationWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute create-isolation fixture git init failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['add', 'baseline.txt'], { cwd: executeIsolationWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute create-isolation fixture git add failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Fixture', 'commit', '-m', 'initial'], { cwd: executeIsolationWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_execute create-isolation fixture git commit failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runExecute([
        'start',
        '--graph',
        executeIsolationGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--run-id',
        'run-execute-create-worktree',
        '--agent-tool',
        'codex',
        '--workspace',
        executeIsolationWorkspace,
        '--workspace-ref',
        'execute-create-isolation-worktree',
        '--isolation',
        'worktree',
        '--worktree',
        executeIsolationWorktree,
        '--create-isolation',
      ]);
      checks += 1;
      if (result.status !== 0 || !existsSync(path.join(executeIsolationWorktree, 'baseline.txt'))) {
        console.error(`p2a_execute create-isolation worktree fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeIsolationRun = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-isolation', 'runs', 'run-execute-create-worktree.json'), 'utf8'));
      const executeIsolationGraph = JSON.parse(readFileSync(executeIsolationGraphPath, 'utf8'));
      const expectedExecuteWorktreePath = realpathSync(executeIsolationWorktree);
      const recordedExecuteWorkspacePath = path.resolve(ROOT, executeIsolationRun.workspacePath);
      const recordedExecuteWorktreePath = path.resolve(ROOT, executeIsolationRun.isolation.worktree);
      if (
        executeIsolationRun.workspaceRef !== 'execute-create-isolation-worktree'
        || executeIsolationRun.isolation.mode !== 'worktree'
        || executeIsolationRun.isolation.created !== true
        || executeIsolationRun.isolation.createExitCode !== 0
        || realpathSync(recordedExecuteWorkspacePath) !== expectedExecuteWorktreePath
        || realpathSync(recordedExecuteWorktreePath) !== expectedExecuteWorktreePath
        || executeIsolationGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'in_progress'
      ) {
        console.error(`p2a_execute create-isolation fixture wrote unexpected state: ${caseData.id}`);
        console.error(JSON.stringify({ executeIsolationRun, executeIsolationGraph }, null, 2));
        return { status: 1, checks };
      }

      const legacyRuntimePath = path.join(tempRoot, 'p2a-execute', 'runs', 'run-execute-fixture-legacy.orchestration-runtime.json');
      const legacyRuntime = JSON.parse(JSON.stringify(executeRuntime));
      legacyRuntime.sharedMentalModel.roleAssignments.forEach((role) => {
        delete role.executionGuide;
      });
      writeFileSync(legacyRuntimePath, `${JSON.stringify(legacyRuntime, null, 2)}\n`, 'utf8');
      result = runValidator(['--orchestration-runtime', legacyRuntimePath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`orchestration runtime validator should backfill legacy executionGuide: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const legacyRuntimeForDirectValidation = JSON.parse(JSON.stringify(legacyRuntime));
      const normalizedLegacyRuntime = validateOrchestrationRuntimeData(legacyRuntimeForDirectValidation);
      checks += 1;
      if (
        legacyRuntimeForDirectValidation.sharedMentalModel.roleAssignments.some((role) => role.executionGuide)
        || !normalizedLegacyRuntime.sharedMentalModel.roleAssignments.every((role) => role.executionGuide?.startsProcess === false)
      ) {
        console.error(`orchestration runtime direct validator should normalize without mutating input: ${caseData.id}`);
        console.error(JSON.stringify({ legacyRuntimeForDirectValidation, normalizedLegacyRuntime }, null, 2));
        return { status: 1, checks };
      }
      result = runOrchestrate(['next-role', '--runtime', legacyRuntimePath, '--json']);
      checks += 1;
      const legacyRuntimeNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || legacyRuntimeNextRole.nextRole?.executionGuide?.surface !== 'Codex CLI/app foreground session'
      ) {
        console.error(`p2a_orchestrate should read legacy runtime without executionGuide: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ legacyRuntimeNextRole }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate(['next-role', '--runtime', executeRuntimePath, '--json']);
      checks += 1;
      const executeNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeNextRole.nextRole?.roleId !== 'implementer'
        || executeNextRole.nextRole?.profileSource !== 'auto'
        || executeNextRole.nextRole?.executionGuide?.startsProcess !== false
        || !executeNextRole.resolutionHints?.some((hint) => hint.includes('Open codex'))
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
        || !result.stdout.includes('Profile source: auto')
        || !result.stdout.includes('Provider surface: Codex CLI/app foreground session')
        || !result.stdout.includes('startsProcess: false')
        || !result.stdout.includes('Provider-native delegation')
        || !result.stdout.includes('Provider-native skills, subagents, custom agents, or agent teams are allowed inside that foreground session')
        || !result.stdout.includes('P2A itself must not launch provider CLIs')
      ) {
        console.error(`p2a_orchestrate role-prompt fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate(['runner-guide', '--runtime', executeRuntimePath, '--role', 'implementer', '--json']);
      checks += 1;
      const executeRuntimeRunnerGuide = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeRuntimeRunnerGuide.schema_version !== 'p2a.provider_runner_guide.v1'
        || executeRuntimeRunnerGuide.source.type !== 'runtime'
        || executeRuntimeRunnerGuide.supervisedOnly !== true
        || executeRuntimeRunnerGuide.startsProcess !== false
        || executeRuntimeRunnerGuide.roles[0]?.runnerAdapter?.adapterName !== 'codex_supervised_skills_custom_agents'
        || !executeRuntimeRunnerGuide.roles[0]?.runnerAdapter?.foregroundSteps?.some((step) => step.includes('foreground Codex session'))
        || !executeRuntimeRunnerGuide.roles[0]?.actionCommand?.includes('role-prompt')
      ) {
        console.error(`p2a_orchestrate runner-guide runtime fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeRuntimeRunnerGuide }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate(['runner-guide', '--runtime', executeRuntimePath, '--role', 'implementer', '--agent-tool', 'claude']);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('--agent-tool is only supported with plan')) {
        console.error(`p2a_orchestrate runner-guide should reject ignored provider override: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      result = runOrchestrate(['runner-guide', '--runtime', executeRuntimePath, '--role', 'implementer', '--provider', 'codex']);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('runner-guide only supports --plan or --runtime')) {
        console.error(`p2a_orchestrate runner-guide should reject runner-doctor provider option: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
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

      result = runOrchestrate([
        'record',
        '--runtime',
        executeRuntimePath,
        '--role',
        'implementer',
        '--type',
        'question',
        '--summary',
        'Need owner decision before continuing',
        '--linked-role',
        'owner',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate question record fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runOrchestrate(['next-role', '--runtime', executeRuntimePath, '--json']);
      checks += 1;
      const questionNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || typeof questionNextRole?.reason !== 'string'
        || !questionNextRole.reason.startsWith('open_question:')
        || questionNextRole.nextRole?.roleId !== 'owner'
      ) {
        console.error(`p2a_orchestrate question should route to owner: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ questionNextRole }, null, 2));
        return { status: failureStatus(result), checks };
      }
      result = runOrchestrate(['failure-policy', '--runtime', executeRuntimePath, '--json']);
      checks += 1;
      const questionFailurePolicy = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || questionFailurePolicy.action !== 'ask_user'
        || questionFailurePolicy.source.signal !== 'open_question'
        || questionFailurePolicy.startsProcess !== false
      ) {
        console.error(`p2a_orchestrate failure-policy should ask user for open question: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ questionFailurePolicy }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runOrchestrate([
        'record',
        '--runtime',
        executeRuntimePath,
        '--role',
        'owner',
        '--type',
        'answer',
        '--summary',
        'Proceed with the scoped implementation',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate answer record fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runOrchestrate(['next-role', '--runtime', executeRuntimePath, '--json']);
      checks += 1;
      const answerNextRole = result.status === 0 ? JSON.parse(result.stdout) : null;
      const executeRuntimeAfterAnswer = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        result.status !== 0
        || typeof answerNextRole?.reason !== 'string'
        || answerNextRole.reason.startsWith('open_question:')
        || answerNextRole.nextRole?.roleId !== 'implementer'
        || executeRuntimeAfterAnswer.status.needsUserDecision !== false
        || executeRuntimeAfterAnswer.sharedMentalModel.openQuestions[0]?.status !== 'answered'
        || executeRuntimeAfterAnswer.sharedMentalModel.openQuestions[0]?.answer !== 'Proceed with the scoped implementation'
      ) {
        console.error(`p2a_orchestrate answer should close open question: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ answerNextRole, executeRuntimeAfterAnswer }, null, 2));
        return { status: failureStatus(result), checks };
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

      const executeGraphNeedingRecovery = JSON.parse(readFileSync(executeGraphPath, 'utf8'));
      executeGraphNeedingRecovery.tasks = executeGraphNeedingRecovery.tasks.map((task) => (
        task.id === 'task-001' ? { ...task, status: 'in_progress' } : task
      ));
      writeFileSync(executeGraphPath, `${JSON.stringify(executeGraphNeedingRecovery, null, 2)}\n`, 'utf8');
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
      const recoveredFinishGraph = JSON.parse(readFileSync(executeGraphPath, 'utf8'));
      const recoveredFinishRuntime = JSON.parse(readFileSync(executeRuntimePath, 'utf8'));
      if (
        result.status !== 0
        || !(`${result.stdout ?? ''}${result.stderr ?? ''}`).includes('Orchestration runtime already closed')
        || !(`${result.stdout ?? ''}${result.stderr ?? ''}`).includes('task-001 status is now done')
        || recoveredFinishGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'done'
        || recoveredFinishRuntime.communicationLog.length !== executeRuntimeAfterFinish.communicationLog.length
      ) {
        console.error(`p2a_execute closed runtime should still recover pending task transition: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ recoveredFinishGraph, recoveredFinishRuntime }, null, 2));
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
        || executeMonitorPlan.roles.find((role) => role.roleId === 'implementer')?.profile !== 'fullstack_implementer'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'implementer')?.profileSource !== 'auto'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'reviewer')?.agentTool !== 'codex'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'reviewer')?.profile !== 'security_reviewer'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'reviewer')?.profileSource !== 'auto'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'monitor')?.profile !== 'manual_monitor'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'monitor')?.profileReason !== 'fixed manual monitor gate role'
        || executeMonitorPlan.roles.find((role) => role.roleId === 'reviewer')?.executionGuide?.recommendedFeature !== 'read_only_review_skill_or_custom_agent_prompt'
        || !executeMonitorPlan.monitorGate.required
        || !executeMonitorPlan.riskFlags.includes('multi_area')
      ) {
        console.error(`p2a_orchestrate monitor fixture should use explicit multi-area team mode: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorPlan }, null, 2));
        return { status: 1, checks };
      }

      const executeClaudePlanPath = path.join(tempRoot, 'p2a-orchestrate-claude', 'orchestration', 'task-001.json');
      result = runOrchestrate([
        'plan',
        '--graph',
        executeMonitorGraphPath,
        '--spec',
        state.specPath,
        '--task',
        'task-001',
        '--agent-tool',
        'claude',
        '--output',
        executeClaudePlanPath,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_orchestrate claude team fixture plan failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeClaudePlan = JSON.parse(readFileSync(executeClaudePlanPath, 'utf8'));
      if (
        executeClaudePlan.providerStrategy.primaryProvider !== 'claude'
        || executeClaudePlan.roles.find((role) => role.roleId === 'implementer')?.executionGuide?.recommendedFeature !== 'agent_teams_or_subagents'
      ) {
        console.error(`p2a_orchestrate claude team fixture should use provider-native guide: ${caseData.id}`);
        console.error(JSON.stringify({ executeClaudePlan }, null, 2));
        return { status: 1, checks };
      }
      result = runOrchestrate(['runner-guide', '--plan', executeClaudePlanPath, '--role', 'implementer']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('claude_supervised_agent_teams_subagents')
        || !result.stdout.includes('agent teams/subagents')
        || !result.stdout.includes('startsProcess: false')
        || !result.stdout.includes('Do not let P2A spawn')
      ) {
        console.error(`p2a_orchestrate runner-guide claude fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
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
        '--reviewer-profile',
        'qa_reviewer',
      ]);
      checks += 1;
      const executeReviewerOverridePlan = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || executeReviewerOverridePlan.roles.find((role) => role.roleId === 'reviewer')?.profile !== 'qa_reviewer'
        || executeReviewerOverridePlan.roles.find((role) => role.roleId === 'reviewer')?.profileSource !== 'override'
        || !executeReviewerOverridePlan.roles.find((role) => role.roleId === 'reviewer')?.profileReason.includes('--reviewer-profile')
      ) {
        console.error(`p2a_orchestrate should record reviewer profile override on team task: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ executeReviewerOverridePlan }, null, 2));
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
        '--reviewer-profile',
        'frontend_implementer',
      ]);
      checks += 1;
      if (result.status === 0 || !result.stderr.includes('--reviewer-profile must be one of')) {
        console.error(`p2a_orchestrate should reject reviewer profile from implementer profile set: ${caseData.id}`);
        writeResultOutput(result);
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
        || explicitGeminiReviewerPlan.roles.find((role) => role.roleId === 'reviewer')?.profile !== 'security_reviewer'
        || explicitGeminiReviewerPlan.roles.find((role) => role.roleId === 'reviewer')?.executionGuide?.recommendedFeature !== 'extensions_custom_commands_gemini_context'
        || explicitGeminiReviewerPlan.roles.find((role) => role.roleId === 'reviewer')?.requiresWrite !== false
      ) {
        console.error(`p2a_orchestrate should allow Gemini as explicit read-only reviewer: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ explicitGeminiReviewerPlan }, null, 2));
        return { status: failureStatus(result), checks };
      }
      const explicitGeminiReviewerPlanPath = path.join(tempRoot, 'p2a-orchestrate-gemini-reviewer', 'orchestration', 'task-001.json');
      mkdirSync(path.dirname(explicitGeminiReviewerPlanPath), { recursive: true });
      writeFileSync(explicitGeminiReviewerPlanPath, `${JSON.stringify(explicitGeminiReviewerPlan, null, 2)}\n`, 'utf8');
      result = runOrchestrate(['runner-guide', '--plan', explicitGeminiReviewerPlanPath, '--role', 'reviewer']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('gemini_read_only_extensions_custom_commands')
        || !result.stdout.includes('Gemini is read-only')
        || !result.stdout.includes('without editing files')
        || !result.stdout.includes('Do not use Gemini for write-required')
      ) {
        console.error(`p2a_orchestrate runner-guide gemini fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
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
        'verification_concerns',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('phase: blocked')
        || !result.stdout.includes('nextRole: owner')
        || !result.stdout.includes('failure-policy --runtime')
        || !result.stdout.includes('Do not retry inside this blocked runtime')
        || result.stdout.includes('mark monitor active')
      ) {
        console.error(`p2a_orchestrate monitor mark-role should block rejected verdicts: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runOrchestrate(['failure-policy', '--runtime', executeMonitorRuntimePath, '--json']);
      checks += 1;
      const monitorFailurePolicy = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || monitorFailurePolicy.action !== 'retry'
        || monitorFailurePolicy.failure.class !== 'verification_failed'
        || monitorFailurePolicy.failure.retryable !== 'after_fix'
        || monitorFailurePolicy.source.signal !== 'monitor_verdict'
        || monitorFailurePolicy.startsProcess !== false
      ) {
        console.error(`p2a_orchestrate failure-policy should retry after rejected monitor verdict: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ monitorFailurePolicy }, null, 2));
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

      result = runRuns([
        'finish',
        '--graph',
        executeMonitorGraphPath,
        '--run-id',
        'run-execute-monitor-fixture',
      ]);
      checks += 1;
      const rawMissingVerdictOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !rawMissingVerdictOutput.includes('monitor verdict')) {
        console.error(`p2a_runs monitor fixture did not require verdict: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const contradictoryMonitorRunId = 'run-execute-monitor-confirm-done-with-concern';
      const contradictoryMonitorGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-monitor-contradictory');
      const contradictoryMonitorRunsDir = path.join(tempRoot, 'p2a-monitor-contradictory', 'runs');
      result = runRuns([
        'start',
        '--graph',
        contradictoryMonitorGraphPath,
        '--task',
        'task-001',
        '--run-id',
        contradictoryMonitorRunId,
        '--agent-tool',
        'codex',
        '--workspace-ref',
        'fixture-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs contradictory monitor fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const contradictoryMonitorSidecar = {
        ...executeMonitorPlan,
        monitorGate: {
          ...executeMonitorPlan.monitorGate,
          verdictPath: `${contradictoryMonitorRunId}.monitor-verdict.json`,
        },
        runLink: {
          runId: contradictoryMonitorRunId,
          sidecarRef: `${contradictoryMonitorRunId}.orchestration.json`,
        },
      };
      writeFileSync(
        path.join(contradictoryMonitorRunsDir, `${contradictoryMonitorRunId}.orchestration.json`),
        `${JSON.stringify(contradictoryMonitorSidecar, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(path.join(contradictoryMonitorRunsDir, contradictoryMonitorSidecar.monitorGate.verdictPath), `${JSON.stringify({
        verdict: 'confirm_done',
        unmet_acceptance: [],
        verification_concerns: ['Monitor reported verification concerns while using confirm_done.'],
        scope_concerns: [],
        needs_user_decision: [],
        note: 'Contradictory monitor verdict fixture.',
      })}\n`, 'utf8');
      result = runRuns([
        'finish',
        '--graph',
        contradictoryMonitorGraphPath,
        '--run-id',
        contradictoryMonitorRunId,
        '--verification',
        'test:passed:manual monitor contradiction fixture',
        ...fixtureFailureDetailArgs('monitor contradictory verdict fixture'),
      ]);
      checks += 1;
      const contradictoryMonitorOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const contradictoryMonitorRun = JSON.parse(readFileSync(path.join(contradictoryMonitorRunsDir, `${contradictoryMonitorRunId}.json`), 'utf8'));
      if (
        result.status !== 0
        || !contradictoryMonitorOutput.includes('- status: blocked')
        || contradictoryMonitorRun.status !== 'blocked'
        || contradictoryMonitorRun.failure?.class !== 'verification_failed'
        || contradictoryMonitorRun.failure?.source !== 'monitor'
      ) {
        console.error(`p2a_runs monitor fixture allowed confirm_done with concerns: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ contradictoryMonitorRun }, null, 2));
        return { status: result.status === 0 ? 1 : failureStatus(result), checks };
      }

      const executeMonitorSidecar = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', 'run-execute-monitor-fixture.orchestration.json'), 'utf8'));
      if (!executeMonitorSidecar.monitorGate.required) {
        console.error(`p2a_execute monitor fixture did not create required monitor gate: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorSidecar }, null, 2));
        return { status: 1, checks };
      }
      writeFileSync(path.join(tempRoot, 'p2a-execute-monitor', 'runs', executeMonitorSidecar.monitorGate.verdictPath), `${JSON.stringify({
        verdict: 'block',
        unmet_acceptance: ['Acceptance criteria are not fully met.'],
        verification_concerns: [],
        scope_concerns: [],
        needs_user_decision: [],
        note: 'Fixture monitor block.',
      })}\n`, 'utf8');
      result = runExecute([
        'finish',
        '--graph',
        executeMonitorGraphPath,
        '--run-id',
        'run-execute-monitor-fixture',
        ...fixtureFailureDetailArgs('monitor blocked finish'),
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
      result = runOrchestrate(['failure-policy', '--runtime', executeMonitorRuntimePath, '--json']);
      checks += 1;
      const monitorRunFailurePolicy = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || monitorRunFailurePolicy.action !== 'retry'
        || monitorRunFailurePolicy.source.signal !== 'run_failure'
        || monitorRunFailurePolicy.source.runStatus !== 'blocked'
        || monitorRunFailurePolicy.failure.retryable !== 'after_fix'
      ) {
        console.error(`p2a_orchestrate failure-policy should prefer blocked run failure: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ monitorRunFailurePolicy }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const stopPolicyDir = path.join(tempRoot, 'p2a-policy-stop', 'runs');
      mkdirSync(stopPolicyDir, { recursive: true });
      const stopPolicyRuntimePath = path.join(stopPolicyDir, 'run-policy-stop.orchestration-runtime.json');
      const stopPolicyRunPath = path.join(stopPolicyDir, 'run-policy-stop.json');
      const stopPolicyRuntime = {
        ...executeMonitorFinishedRuntime,
        runtimeId: 'runtime-run-policy-stop',
        runId: 'run-policy-stop',
        status: {
          ...executeMonitorFinishedRuntime.status,
          phase: 'blocked',
          blocked: true,
          needsUserDecision: false,
        },
      };
      const stopPolicyRun = {
        ...executeMonitorFinishedRun,
        runId: 'run-policy-stop',
        status: 'blocked',
        failure: {
          class: 'scope_violation',
          retryable: 'no',
          needsUserDecision: false,
          source: 'owner',
        },
      };
      writeFileSync(stopPolicyRuntimePath, `${JSON.stringify(stopPolicyRuntime, null, 2)}\n`, 'utf8');
      writeFileSync(stopPolicyRunPath, `${JSON.stringify(stopPolicyRun, null, 2)}\n`, 'utf8');
      result = runOrchestrate(['failure-policy', '--runtime', stopPolicyRuntimePath, '--json']);
      checks += 1;
      const stopFailurePolicy = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || stopFailurePolicy.action !== 'stop'
        || stopFailurePolicy.source.signal !== 'run_failure'
        || stopFailurePolicy.failure.class !== 'scope_violation'
        || stopFailurePolicy.failure.retryable !== 'no'
      ) {
        console.error(`p2a_orchestrate failure-policy should stop non-retryable run failures: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ stopFailurePolicy }, null, 2));
        return { status: failureStatus(result), checks };
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
        || !executeMonitorProposal.evidence.includes('monitor failure signal: unmet_acceptance')
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
        || !executeMonitorReview.groups.some((group) => group.classification === 'implementation_incomplete' && group.recommendedDisposition === 'defer')
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
      const executeMonitorImplementationCandidate = executeMonitorCuration.candidates.find((candidate) => candidate.classification === 'implementation_incomplete');
      if (
        executeMonitorCuration.schema_version !== 'p2a.proposal_curation.v1'
        || executeMonitorCuration.summary.totalCandidates !== 1
        || executeMonitorImplementationCandidate?.readiness !== 'watch'
        || executeMonitorImplementationCandidate?.separatePatchRequired !== true
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
        executeMonitorImplementationCandidate.candidateId,
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
        || executeMonitorPatchDraft.candidateId !== executeMonitorImplementationCandidate.candidateId
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
        '--verify-command',
        'custom:node --version',
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
        '--verify-command',
        'custom:node --version',
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
        ...fixtureFailureDetailArgs('execute failed verification'),
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
      const quotedArtifactRoot = shellQuote(artifactRoot);
      if (
        result.status !== 0
        || !result.stdout.includes(`Plan2Agent run started: ${fixtureRunId}`)
        || !result.stdout.includes(`resume: node `)
        || !result.stdout.includes(`p2a.mjs execute resume --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
        || !result.stdout.includes(`status: node `)
        || !result.stdout.includes(`p2a.mjs execute status --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
        || !result.stdout.includes(`finish: node `)
        || !result.stdout.includes(`p2a.mjs execute finish --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId} --test --lint --typecheck`)
        || !result.stdout.includes(`review: node `)
        || !result.stdout.includes(`p2a.mjs proposals mine --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
      ) {
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
      mkdirSync(path.join(collectGitWorkspace, '새 폴더'), { recursive: true });
      writeFileSync(path.join(collectGitWorkspace, '새 폴더', '한글 파일.txt'), 'new\n', 'utf8');

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
        'verify',
        '--artifacts',
        artifactRoot,
        '--run-id',
        collectGitRunId,
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('test: passed')) {
        console.error(`p2a_runs collect-git fixture verify failed: ${caseData.id}`);
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
      if (result.status !== 0 || !result.stdout.includes('- changedFiles: 2')) {
        console.error(`p2a_runs collect-git fixture finish failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const collectGitRun = JSON.parse(readFileSync(path.join(runsDir, `${collectGitRunId}.json`), 'utf8'));
      const collectGitFiles = new Set(collectGitRun.changedFiles);
      if (
        collectGitRun.changedFiles.length !== 2
        || !collectGitFiles.has('src/tracked.txt')
        || !collectGitFiles.has('새 폴더/한글 파일.txt')
      ) {
        console.error(`p2a_runs collect-git fixture wrote unexpected changed files: ${caseData.id}`);
        console.error(JSON.stringify(collectGitRun, null, 2));
        return { status: 1, checks };
      }

      const isolationBaseWorkspace = path.join(tempRoot, 'isolation-base-workspace');
      const isolationWorktree = path.join(tempRoot, 'isolation-worktree');
      mkdirSync(isolationBaseWorkspace, { recursive: true });
      writeFileSync(path.join(isolationBaseWorkspace, 'baseline.txt'), 'baseline\n', 'utf8');
      result = spawnSync('git', ['init'], { cwd: isolationBaseWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`create-isolation fixture git init failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['add', 'baseline.txt'], { cwd: isolationBaseWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`create-isolation fixture git add failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = spawnSync('git', ['-c', 'user.email=p2a@example.invalid', '-c', 'user.name=P2A Fixture', 'commit', '-m', 'initial'], { cwd: isolationBaseWorkspace, encoding: 'utf8' });
      checks += 1;
      if (result.status !== 0) {
        console.error(`create-isolation fixture git commit failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const isolationRunId = 'run-fixture-create-worktree';
      result = runRuns([
        'start',
        '--artifacts',
        artifactRoot,
        '--task',
        'task-001',
        '--run-id',
        isolationRunId,
        '--agent-tool',
        'codex',
        '--workspace',
        isolationWorktree,
        '--workspace-ref',
        'create-isolation-worktree',
        '--isolation',
        'worktree',
        '--worktree',
        isolationWorktree,
        '--create-isolation',
      ], { cwd: isolationBaseWorkspace });
      checks += 1;
      if (result.status !== 0 || !existsSync(path.join(isolationWorktree, 'baseline.txt'))) {
        console.error(`p2a_runs create-isolation worktree fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const isolationRun = JSON.parse(readFileSync(path.join(runsDir, `${isolationRunId}.json`), 'utf8'));
      const expectedWorktreePath = realpathSync(isolationWorktree);
      const recordedWorkspacePath = path.resolve(isolationBaseWorkspace, isolationRun.workspacePath);
      const recordedIsolationWorktree = path.resolve(isolationBaseWorkspace, isolationRun.isolation.worktree);
      if (
        isolationRun.workspaceRef !== 'create-isolation-worktree'
        || isolationRun.isolation.mode !== 'worktree'
        || isolationRun.isolation.created !== true
        || isolationRun.isolation.createExitCode !== 0
        || realpathSync(recordedIsolationWorktree) !== expectedWorktreePath
        || realpathSync(recordedWorkspacePath) !== expectedWorktreePath
      ) {
        console.error(`p2a_runs create-isolation worktree fixture wrote unexpected run log: ${caseData.id}`);
        console.error(JSON.stringify(isolationRun, null, 2));
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
      const missingStructuredOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !missingStructuredOutput.includes('failed/blocked run requires structured debug detail: reproduction, localization, guard')) {
        console.error(`p2a_runs did not reject failed finish without structured detail: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runRuns([
        'finish',
        '--artifacts',
        artifactRoot,
        '--run-id',
        failedRunId,
        '--status',
        'failed',
        '--failure-class',
        'verification_failed',
        ...fixtureFailureDetailArgs('failed fixture'),
      ]);
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

      result = runRuns([
        'finish',
        '--artifacts',
        artifactRoot,
        '--run-id',
        blockedRunId,
        '--status',
        'blocked',
        '--failure-class',
        'implementation_incomplete',
        '--failure-source',
        'monitor',
        ...fixtureFailureDetailArgs('blocked fixture'),
      ]);
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

      const finishedWithFailedVerificationRunId = 'run-fixture-finished-with-failed-verification';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedWithFailedVerificationRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs failed-verification guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['record', '--artifacts', artifactRoot, '--run-id', finishedWithFailedVerificationRunId, '--verification', 'test:failed:npm test']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs failed-verification guard fixture record failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedWithFailedVerificationRunId, '--status', 'finished']);
      checks += 1;
      const finishedWithFailedVerificationOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !finishedWithFailedVerificationOutput.includes('finished run cannot include failed verification')
      ) {
        console.error(`p2a_runs allowed finished status with failed verification: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const finishedWithoutVerificationRunId = 'run-fixture-finished-without-verification';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedWithoutVerificationRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs missing-verification guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedWithoutVerificationRunId, '--status', 'finished']);
      checks += 1;
      const finishedWithoutVerificationOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !finishedWithoutVerificationOutput.includes('finished run requires verification evidence')
      ) {
        console.error(`p2a_runs allowed finished status without verification: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const finishedWithManualVerificationRunId = 'run-fixture-finished-with-manual-verification';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedWithManualVerificationRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs manual-verification guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedWithManualVerificationRunId, '--verification', 'test:passed:manual self-report', '--status', 'finished']);
      checks += 1;
      const finishedWithManualVerificationOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !finishedWithManualVerificationOutput.includes('Manual verification records are not sufficient')
      ) {
        console.error(`p2a_runs allowed finished status with manual-only verification: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const finishedWithIncompleteVerificationRunId = 'run-fixture-finished-with-incomplete-verification';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedWithIncompleteVerificationRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs incomplete-verification guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['record', '--artifacts', artifactRoot, '--run-id', finishedWithIncompleteVerificationRunId, '--verification', 'test:skipped:npm test']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs incomplete-verification guard fixture record failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns(['finish', '--artifacts', artifactRoot, '--run-id', finishedWithIncompleteVerificationRunId, '--status', 'finished']);
      checks += 1;
      const finishedWithIncompleteVerificationOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !finishedWithIncompleteVerificationOutput.includes('finished run cannot include incomplete verification')
      ) {
        console.error(`p2a_runs allowed finished status with incomplete verification: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const graphBlockedRunId = 'run-fixture-graph-blocked';
      const graphBlockedGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-graph-blocked');
      result = runRuns(['start', '--graph', graphBlockedGraphPath, '--task', 'task-001', '--run-id', graphBlockedRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs --graph blocked fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns([
        'finish',
        '--graph',
        graphBlockedGraphPath,
        '--run-id',
        graphBlockedRunId,
        '--status',
        'blocked',
        '--failure-class',
        'missing_dependency',
        ...fixtureFailureDetailArgs('graph blocked fixture'),
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('failure: missing_dependency retryable=after_fix needsUserDecision=true source=owner')) {
        console.error(`p2a_runs --graph blocked fixture did not record missing_dependency failure: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['block', '--graph', graphBlockedGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('- blockReason: missing_dependency')) {
        console.error(`p2a_tasks block --graph did not mirror latest run failure class: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const graphBlockedTaskGraph = JSON.parse(readFileSync(graphBlockedGraphPath, 'utf8'));
      if (graphBlockedTaskGraph.tasks.find((task) => task.id === 'task-001')?.blockReason !== 'missing_dependency') {
        console.error(`p2a_tasks block --graph did not persist blockReason: ${caseData.id}`);
        console.error(JSON.stringify(graphBlockedTaskGraph.tasks.find((task) => task.id === 'task-001'), null, 2));
        return { status: 1, checks };
      }

      const blockNoteGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-block-note');
      result = runTasks(['block', '--graph', blockNoteGraphPath, 'task-001', '--note', 'Waiting for owner confirmation.']);
      checks += 1;
      const blockNoteGraph = JSON.parse(readFileSync(blockNoteGraphPath, 'utf8'));
      const blockNoteTask = blockNoteGraph.tasks.find((task) => task.id === 'task-001');
      if (
        result.status !== 0
        || !result.stdout.includes('- blockNote: Waiting for owner confirmation.')
        || blockNoteTask?.status !== 'blocked'
        || blockNoteTask?.blockNote !== 'Waiting for owner confirmation.'
      ) {
        console.error(`p2a_tasks block note fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ blockNoteTask }, null, 2));
        return { status: failureStatus(result), checks };
      }
      result = runTasks(['todo', '--graph', blockNoteGraphPath, 'task-001']);
      checks += 1;
      const todoAfterBlockGraph = JSON.parse(readFileSync(blockNoteGraphPath, 'utf8'));
      const todoAfterBlockTask = todoAfterBlockGraph.tasks.find((task) => task.id === 'task-001');
      if (
        result.status !== 0
        || todoAfterBlockTask?.status !== 'todo'
        || Object.hasOwn(todoAfterBlockTask, 'blockNote')
        || Object.hasOwn(todoAfterBlockTask, 'blockReason')
      ) {
        console.error(`p2a_tasks todo did not clear block fields: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ todoAfterBlockTask }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const blockedTransitionGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-blocked-transition-guard');
      const blockedTransitionGraph = JSON.parse(readFileSync(blockedTransitionGraphPath, 'utf8'));
      blockedTransitionGraph.tasks.find((task) => task.id === 'task-001').status = 'blocked';
      writeFileSync(blockedTransitionGraphPath, `${JSON.stringify(blockedTransitionGraph, null, 2)}\n`, 'utf8');
      result = runTasks(['block', '--graph', blockedTransitionGraphPath, 'task-001']);
      checks += 1;
      const blockedBlockOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !blockedBlockOutput.includes('task-001 must be todo or in_progress before block; current status is blocked')
      ) {
        console.error(`p2a_tasks allowed block from blocked state: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const doneTransitionGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-transition-guard');
      const doneTransitionGraph = JSON.parse(readFileSync(doneTransitionGraphPath, 'utf8'));
      doneTransitionGraph.tasks.find((task) => task.id === 'task-001').status = 'done';
      writeFileSync(doneTransitionGraphPath, `${JSON.stringify(doneTransitionGraph, null, 2)}\n`, 'utf8');
      result = runTasks(['block', '--graph', doneTransitionGraphPath, 'task-001']);
      checks += 1;
      const doneBlockOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !doneBlockOutput.includes('task-001 must be todo or in_progress before block; current status is done')
      ) {
        console.error(`p2a_tasks allowed block from done state: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      result = runTasks(['todo', '--graph', doneTransitionGraphPath, 'task-001']);
      checks += 1;
      const doneTodoOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !doneTodoOutput.includes('task-001 must be blocked or in_progress before todo; current status is done')
      ) {
        console.error(`p2a_tasks allowed todo from done state: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const noEvidenceGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-no-evidence');
      result = runTasks(['start', '--graph', noEvidenceGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks no-evidence guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runTasks(['done', '--graph', noEvidenceGraphPath, 'task-001']);
      checks += 1;
      const noEvidenceDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !noEvidenceDoneOutput.includes('no run evidence found for task-001')
      ) {
        console.error(`p2a_tasks allowed done without run evidence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const doneGuardGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-guard');
      result = runTasks(['start', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks done guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const doneGuardRunId = 'run-fixture-done-guard-failed';
      result = runRuns(['start', '--graph', doneGuardGraphPath, '--task', 'task-001', '--run-id', doneGuardRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs done guard fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns([
        'finish',
        '--graph',
        doneGuardGraphPath,
        '--run-id',
        doneGuardRunId,
        '--status',
        'failed',
        '--failure-class',
        'verification_failed',
        ...fixtureFailureDetailArgs('done guard failed fixture'),
      ]);
      checks += 1;
      if (result.status !== 1) {
        console.error(`p2a_runs done guard fixture failed finish did not return failed status: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const doneGuardOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !doneGuardOutput.includes(`task-001 cannot be marked done because latest run ${doneGuardRunId} is failed (verification_failed)`)
      ) {
        console.error(`p2a_tasks allowed done after failed latest run: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      const doneGuardRunsDir = path.join(tempRoot, 'p2a-done-guard', 'runs');
      const doneGuardRunPath = path.join(doneGuardRunsDir, `${doneGuardRunId}.json`);
      const doneGuardBaseRun = JSON.parse(readFileSync(doneGuardRunPath, 'utf8'));
      unlinkSync(doneGuardRunPath);
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const missingRunGuardOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !missingRunGuardOutput.includes(`latest run ${doneGuardRunId} for task-001 is missing`)
      ) {
        console.error(`p2a_tasks allowed done with missing latest run evidence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      function finishedDoneGuardRun(overrides = {}) {
        const run = {
          ...doneGuardBaseRun,
          status: 'finished',
          updatedAt: '2026-07-02T00:02:00.000Z',
          finishedAt: '2026-07-02T00:02:00.000Z',
          changedFiles: ['src/webhook-verification.ts'],
          verification: [passedFixtureVerification('done guard fixture')],
          notes: ['Done guard fixture.'],
          ...overrides,
        };
        delete run.failure;
        return run;
      }

      const dependencyDoneGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-dependency-recheck');
      const dependencyDoneGraph = JSON.parse(readFileSync(dependencyDoneGraphPath, 'utf8'));
      const dependencyParentTask = dependencyDoneGraph.tasks.find((task) => task.id === 'task-001');
      const dependencyChildTask = dependencyDoneGraph.tasks.find((task) => task.id === 'task-002');
      dependencyParentTask.status = 'todo';
      dependencyChildTask.status = 'in_progress';
      dependencyChildTask.dependencies = ['task-001'];
      writeFileSync(dependencyDoneGraphPath, `${JSON.stringify(dependencyDoneGraph, null, 2)}\n`, 'utf8');
      writeLatestRunEvidence(
        path.join(tempRoot, 'p2a-done-dependency-recheck', 'runs'),
        'task-002',
        finishedDoneGuardRun({
          runId: 'run-fixture-done-dependency-recheck',
          taskId: 'task-002',
          taskTitle: dependencyChildTask.title,
          taskGraphRef: path.resolve(dependencyDoneGraphPath).split(path.sep).join('/'),
        }),
      );
      result = runTasks(['done', '--graph', dependencyDoneGraphPath, 'task-002']);
      checks += 1;
      const dependencyDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !dependencyDoneOutput.includes('task-002 cannot be marked done until dependencies are done: task-001')
      ) {
        console.error(`p2a_tasks allowed done while dependency regressed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const timeoutWorkspace = path.join(tempRoot, 'p2a-verification-timeout-workspace');
      mkdirSync(path.join(timeoutWorkspace, '.plan2agent'), { recursive: true });
      writeFileSync(path.join(timeoutWorkspace, '.plan2agent', 'project.config.json'), `${JSON.stringify({
        schema_version: 'p2a.project_config.v1',
        verificationTimeoutMs: 50,
      }, null, 2)}\n`, 'utf8');
      const timeoutGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-verification-timeout');
      const timeoutRunId = 'run-fixture-verification-timeout';
      result = runRuns([
        'start',
        '--graph',
        timeoutGraphPath,
        '--task',
        'task-001',
        '--run-id',
        timeoutRunId,
        '--agent-tool',
        'codex',
        '--workspace',
        timeoutWorkspace,
        '--workspace-ref',
        'timeout-workspace',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs timeout fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRuns([
        'verify',
        '--graph',
        timeoutGraphPath,
        '--run-id',
        timeoutRunId,
        '--workspace',
        timeoutWorkspace,
        '--test-command',
        `"${process.execPath}" -e "setTimeout(() => {}, 1000)"`,
      ]);
      checks += 1;
      const timeoutRun = JSON.parse(readFileSync(path.join(tempRoot, 'p2a-verification-timeout', 'runs', `${timeoutRunId}.json`), 'utf8'));
      const timeoutVerification = timeoutRun.verification.at(-1);
      if (
        result.status === 0
        || !result.stdout.includes('- test: failed')
        || timeoutVerification?.status !== 'failed'
        || !timeoutVerification?.stderrTail?.includes('verification command timed out after 50ms')
      ) {
        console.error(`p2a_runs verification timeout fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ timeoutVerification }, null, 2));
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({
        taskId: 'task-002',
        taskTitle: 'Mismatched fixture task',
      }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const mismatchedRunGuardOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !mismatchedRunGuardOutput.includes(`latest run ${doneGuardRunId} belongs to task-002, not task-001`)
      ) {
        console.error(`p2a_tasks allowed done with mismatched latest run task: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({
        iterationId: 'previous-iteration',
        taskGraphRef: 'iterations/previous-iteration/gate-c-task-graph/task-graph.json',
      }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const outOfContextDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !outOfContextDoneOutput.includes('no latest run evidence found for task-001 in current task graph context')
      ) {
        console.error(`p2a_tasks allowed done with out-of-context iteration evidence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({ verification: [] }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const noVerificationDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !noVerificationDoneOutput.includes(`task-001 cannot be marked done because latest run ${doneGuardRunId} has no verification evidence`)
      ) {
        console.error(`p2a_tasks allowed done with no verification evidence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({
        verification: [{
          ...passedFixtureVerification('done guard skipped fixture'),
          status: 'skipped',
          exitCode: null,
        }],
      }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const incompleteDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !incompleteDoneOutput.includes(`task-001 cannot be marked done because latest run ${doneGuardRunId} has incomplete verification`)
      ) {
        console.error(`p2a_tasks allowed done with incomplete verification: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({
        verification: [{
          ...passedFixtureVerification('done guard manual fixture'),
          exitCode: null,
          source: 'manual',
        }],
      }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const manualDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !manualDoneOutput.includes(`task-001 cannot be marked done because latest run ${doneGuardRunId} has no executed passed verification evidence`)
      ) {
        console.error(`p2a_tasks allowed done with manual-only verification evidence: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun({
        changedFiles: ['.plan2agent/project.config.json'],
      }));
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      const controlArtifactDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !controlArtifactDoneOutput.includes(`task-001 cannot be marked done because latest run ${doneGuardRunId} changed Plan2Agent control artifacts`)
      ) {
        console.error(`p2a_tasks allowed done with control artifact changes: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const timeOrderedDoneGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-time-order');
      result = runTasks(['start', '--graph', timeOrderedDoneGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks time-ordered done fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const timeOrderedRunsDir = path.join(tempRoot, 'p2a-done-time-order', 'runs');
      const timeOrderedTaskGraphRef = path.resolve(timeOrderedDoneGraphPath).split(path.sep).join('/');
      const newerFinishedRun = finishedDoneGuardRun({
        runId: 'run-fixture-done-time-order-finished',
        taskGraphRef: timeOrderedTaskGraphRef,
        updatedAt: '2026-07-02T00:05:00.000Z',
        finishedAt: '2026-07-02T00:05:00.000Z',
      });
      const olderFailedRun = finishedDoneGuardRun({
        runId: 'run-fixture-done-time-order-failed',
        taskGraphRef: timeOrderedTaskGraphRef,
        updatedAt: '2026-07-02T00:04:00.000Z',
        finishedAt: '2026-07-02T00:04:00.000Z',
        verification: [{
          ...passedFixtureVerification('done guard stale failed fixture'),
          status: 'failed',
          exitCode: 1,
          stderrTail: 'stale failure',
        }],
      });
      olderFailedRun.status = 'failed';
      olderFailedRun.failure = {
        class: 'verification_failed',
        retryable: 'after_fix',
        needsUserDecision: false,
        source: 'owner',
      };
      olderFailedRun.reproduction = {
        steps: ['Run the stale fixture verification.'],
        commands: ['done guard stale failed fixture'],
        notes: [],
      };
      olderFailedRun.localization = {
        findings: ['The stale run failed before a newer successful run completed.'],
        files: ['src/webhook-verification.ts'],
      };
      olderFailedRun.guard = {
        checks: ['Use finishedAt ordering before accepting latest done evidence.'],
        notes: [],
      };
      writeRunEvidenceSet(timeOrderedRunsDir, 'task-001', [newerFinishedRun, olderFailedRun]);
      result = runTasks(['done', '--graph', timeOrderedDoneGraphPath, 'task-001']);
      checks += 1;
      const timeOrderedDoneGraph = JSON.parse(readFileSync(timeOrderedDoneGraphPath, 'utf8'));
      if (
        result.status !== 0
        || !result.stdout.includes('task-001 status is now done')
        || timeOrderedDoneGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'done'
      ) {
        console.error(`p2a_tasks did not use timestamp order for latest run evidence: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ newerFinishedRun, olderFailedRun }, null, 2));
        return { status: failureStatus(result), checks };
      }

      writeLatestRunEvidence(doneGuardRunsDir, 'task-001', finishedDoneGuardRun());
      result = runTasks(['done', '--graph', doneGuardGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001 status is now done')) {
        console.error(`p2a_tasks done guard fixture did not allow valid finished run: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const finishedFailureFlagRunId = 'run-fixture-finished-with-failure-flag';
      result = runRuns(['start', '--artifacts', artifactRoot, '--task', 'task-001', '--run-id', finishedFailureFlagRunId, '--agent-tool', 'codex', '--workspace-ref', 'fixture-workspace']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs finished failure flag fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runRuns([
        'verify',
        '--artifacts',
        artifactRoot,
        '--run-id',
        finishedFailureFlagRunId,
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('test: passed')) {
        console.error(`p2a_runs finished failure flag fixture verify failed: ${caseData.id}`);
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

      result = runRuns([
        'finish',
        '--artifacts',
        artifactRoot,
        '--run-id',
        otherRunId,
        '--status',
        'failed',
        '--failure-class',
        'other',
        '--note',
        'Fixture cannot classify this failure.',
        ...fixtureFailureDetailArgs('other failure fixture'),
      ]);
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
      const draftSpec = JSON.parse(readFileSync(draftSpecPath, 'utf8'));
      if (
        !draftSpec.reference_reconnaissance
        || !draftSpec.reference_reconnaissance.candidates?.some((candidate) => candidate.candidate_id === 'REF-1')
        || !draftSpec.reference_reconnaissance.candidates?.every((candidate) => draftSpec.evidence.some((item) => item.source_id === candidate.source_id))
      ) {
        console.error(`iteration draft did not include valid Gate B reference reconnaissance: ${caseData.id}`);
        console.error(JSON.stringify(draftSpec.reference_reconnaissance ?? null, null, 2));
        return { status: 1, checks };
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
      if (result.status !== 0 || !brokenPlanningStatusOutput.includes('stage: gate-b-draft')) {
        console.error(`iteration planning validate did not tolerate broken generated status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), draftStatusText, 'utf8');
        return { status: failureStatus(result), checks };
      }
      result = runValidator(['--status', path.join(artifactRoot, 'status.md')]);
      checks += 1;
      const explicitPlanningStatusOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !explicitPlanningStatusOutput.includes('status.md missing Progress line')) {
        console.error(`explicit status validator did not reject broken planning status.md structure: ${caseData.id}`);
        writeResultOutput(result);
        writeFileSync(path.join(artifactRoot, 'status.md'), draftStatusText, 'utf8');
        return { status: 1, checks };
      }
      writeFileSync(path.join(artifactRoot, 'status.md'), draftStatusText, 'utf8');

      const approvedDraftSpec = JSON.parse(readFileSync(draftSpecPath, 'utf8'));
      approvedDraftSpec.approval = 'approved';
      approvedDraftSpec.approval_audit = {
        approved_by: 'user',
        approved_at: '2026-06-15',
        approved_artifacts: ['iterations/iter-002/gate-b-spec/spec.json'],
        approval_note: 'Fixture approved iter-002 Gate B draft spec for promotion.',
      };
      writeFileSync(draftSpecPath, `${JSON.stringify(approvedDraftSpec, null, 2)}\n`, 'utf8');
      const iter2TaskGraphPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-c-task-graph', 'task-graph.json');
      const iter2DraftPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-c-task-graph', 'task-graph.draft.json');
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
      if (
        result.status !== 0
        || !result.stdout.includes('diff task graph draft generated')
        || !existsSync(iter2DraftPath)
        || existsSync(iter2TaskGraphPath)
      ) {
        console.error(`iteration diff-tasks fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      let iter2DraftGraph = JSON.parse(readFileSync(iter2DraftPath, 'utf8'));
      if (iter2DraftGraph.sourceSpec !== '../gate-b-spec/spec.json' || !iter2DraftGraph.tasks.length) {
        console.error(`iteration diff-tasks wrote invalid task graph draft fixture: ${caseData.id}`);
        console.error(JSON.stringify(iter2DraftGraph, null, 2));
        return { status: 1, checks };
      }
      const iter2VerificationTask = iter2DraftGraph.tasks.find((task) => task.targetArea === 'verification');
      const iter2ImplementationTaskIds = iter2DraftGraph.tasks
        .filter((task) => task.targetArea !== 'verification')
        .map((task) => task.id);
      if (
        iter2DraftGraph.tasks.length >= 16
        || !iter2VerificationTask
        || JSON.stringify(iter2VerificationTask.dependencies) !== JSON.stringify(iter2ImplementationTaskIds)
        || !iter2DraftGraph.tasks.some((task) => task.title.startsWith('Rework '))
        || !iter2DraftGraph.tasks.some((task) => task.description.includes('Rework previous completed task'))
      ) {
        console.error(`iteration diff-tasks did not generate expected semantic/rework graph: ${caseData.id}`);
        console.error(JSON.stringify(iter2DraftGraph, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-c-draft']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('gate-c draft valid')) {
        console.error(`iteration diff-tasks draft validation fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'promote-tasks',
        '--artifacts',
        artifactRoot,
        '--approved-by',
        'user',
        '--approval-note',
        'Fixture reviewed the semantic diff Gate C draft task graph.',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent tasks promoted')
        || !existsSync(iter2TaskGraphPath)
        || existsSync(iter2DraftPath)
      ) {
        console.error(`iteration diff-tasks promote fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      let iter2TaskGraph = JSON.parse(readFileSync(iter2TaskGraphPath, 'utf8'));
      const originalSemanticTaskIds = iter2TaskGraph.tasks.map((task) => task.id);
      result = runIteration(['diff-tasks', '--artifacts', artifactRoot, '--force']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('reused active tasks:') || !existsSync(iter2DraftPath)) {
        console.error(`iteration diff-tasks --force reuse fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      iter2DraftGraph = JSON.parse(readFileSync(iter2DraftPath, 'utf8'));
	      if (
	        JSON.stringify(iter2DraftGraph.tasks.map((task) => task.id)) !== JSON.stringify(originalSemanticTaskIds)
	        || !iter2DraftGraph.tasks.some((task) => task.description.includes('Reuses existing active task id'))
	      ) {
	        console.error(`iteration diff-tasks --force did not reuse active semantic tasks: ${caseData.id}`);
	        console.error(JSON.stringify(iter2DraftGraph, null, 2));
	        return { status: 1, checks };
	      }

	      result = runIteration(['promote-tasks', '--artifacts', artifactRoot]);
	      checks += 1;
	      const staleGateCAuditOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
	      if (result.status === 0 || !staleGateCAuditOutput.includes('does not match current task-graph.draft.json')) {
	        console.error(`iteration promote-tasks reused stale Gate C audit for regenerated draft: ${caseData.id}`);
	        writeResultOutput(result);
	        return { status: 1, checks };
	      }

	      result = runIteration([
	        'promote-tasks',
	        '--artifacts',
        artifactRoot,
        '--approved-by',
        'user',
        '--approval-note',
        'Fixture reviewed regenerated semantic diff task graph.',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent tasks promoted')
        || !existsSync(iter2TaskGraphPath)
        || existsSync(iter2DraftPath)
      ) {
        console.error(`iteration diff-tasks --force promote fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      iter2TaskGraph = JSON.parse(readFileSync(iter2TaskGraphPath, 'utf8'));
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
        || !result.stdout.includes(`gate-b-spec/spec.json -> .plan2agent/artifacts/${caseData.project_id}/gate-b-spec/spec.json`)
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
      const iterationTargetArtifactRoot = path.join(iterationTargetRoot, '.plan2agent', 'artifacts', caseData.project_id);
      const targetTaskGraphPath = path.join(iterationTargetArtifactRoot, 'gate-c-task-graph', 'task-graph.json');
      const targetSpecPath = path.join(iterationTargetArtifactRoot, 'gate-b-spec', 'spec.json');
      const targetIntakePath = path.join(iterationTargetArtifactRoot, 'gate-a-intake', 'intake.json');
      const targetMaintenanceGraphPath = path.join(iterationTargetRoot, '.plan2agent', 'maintenance', 'task-graph.json');
      if (
        !existsSync(targetCurrentSpecPath)
        || !existsSync(targetSpecPath)
        || !existsSync(targetIntakePath)
        || !existsSync(targetMaintenanceGraphPath)
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_execute.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_orchestrate.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'run-index.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'orchestration-plan.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'orchestration-runtime.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'eval-index.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'eval-digest.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'eval-maintenance-draft.schema.json'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'eval-maintenance-apply-report.schema.json'))
	      ) {
        console.error(`iteration handoff did not copy active artifacts/current-spec/tools: ${caseData.id}`);
        return { status: 1, checks };
      }
      const targetManifest = JSON.parse(readFileSync(targetManifestPath, 'utf8'));
      const targetCurrentSpec = JSON.parse(readFileSync(targetCurrentSpecPath, 'utf8'));
      const sourceCurrentSpecAfterHandoff = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
      const targetTaskGraph = JSON.parse(readFileSync(targetTaskGraphPath, 'utf8'));
      const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
      const expectedTargetSpecRef = `.plan2agent/artifacts/${caseData.project_id}/gate-b-spec/spec.json`;
      const expectedTargetIntakeRef = `.plan2agent/artifacts/${caseData.project_id}/gate-a-intake/intake.json`;
      if (
        targetManifest.sourceLayout !== 'iteration'
        || targetManifest.sourceIterationId !== 'iter-002'
        || targetManifest.currentSpecFile !== '.plan2agent/current-spec.json'
        || JSON.stringify(targetManifest.maintenanceFiles) !== JSON.stringify(['.plan2agent/maintenance/task-graph.json'])
        || !targetManifest.includedTools.includes('p2a')
        || !targetManifest.includedTools.includes('p2a_runs')
        || !targetManifest.includedTools.includes('p2a_execute')
        || !targetManifest.includedTools.includes('p2a_orchestrate')
        || !targetManifest.includedTools.includes('p2a_proposals')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_runs.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_execute.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_orchestrate.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_proposals.mjs')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/task-context.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/run-index.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/orchestration-plan.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/orchestration-runtime.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/skill-proposal.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-review.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-curation.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-patch-draft.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-draft-approval.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-index.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-digest.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-draft.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-apply-report.schema.json')
	        || targetCurrentSpec.last_handoff?.iteration_id !== 'iter-002'
        || targetCurrentSpec.last_handoff?.maintenance_included !== true
        || sourceCurrentSpecAfterHandoff.last_handoff?.target_project !== iterationTargetRoot
        || targetTaskGraph.sourceSpec !== expectedTargetSpecRef
        || targetSpec.source_intake !== expectedTargetIntakeRef
      ) {
        console.error(`iteration handoff manifest/task graph contract mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ targetManifest, targetCurrentSpec, sourceCurrentSpecAfterHandoff, targetTaskGraphSourceSpec: targetTaskGraph.sourceSpec, targetSpecSourceIntake: targetSpec.source_intake }, null, 2));
        return { status: 1, checks };
      }

      result = assertTargetSpecSourceIntake(iterationTargetRoot, caseData.project_id, caseData.id, 'iteration');
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
      approvedIter3Spec.approval_audit = {
        approved_by: 'user',
        approved_at: '2026-06-15',
        approved_artifacts: ['iterations/iter-003/gate-b-spec/spec.json'],
        approval_note: 'Fixture approved iter-003 Gate B draft spec for promotion.',
      };
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
        || !promoteTasksNoAuditOutput.includes('Gate C approval audit required in current-spec.json')
        || existsSync(iter3TaskGraphPath)
        || !existsSync(iter3DraftPath)
      ) {
        console.error(`iteration promote-tasks missing audit fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration([
        'promote-tasks',
        '--artifacts',
        artifactRoot,
        '--approved-by',
        'user',
        '--approval-note',
        'Fixture reviewed the Gate C draft task graph.',
      ]);
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
        || iter3DraftMeta.gate_c_approval_audit?.approved_by !== 'user'
        || iter3DraftMeta.gate_c_approval_audit?.approval_note !== 'Fixture reviewed the Gate C draft task graph.'
      ) {
        console.error(`iteration promote-tasks did not write provenance sidecar: ${caseData.id}`);
        console.error(JSON.stringify(iter3DraftMeta, null, 2));
        return { status: 1, checks };
      }

      const statusBeforeMismatch = readFileSync(path.join(artifactRoot, 'status.md'), 'utf8');
      writeFileSync(
        path.join(artifactRoot, 'status.md'),
        statusBeforeMismatch.replace(/p2a:active-iteration=\S+/, 'p2a:active-iteration=stale-status'),
        'utf8',
      );
      result = runIteration(['current', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('active iteration: iter-003')) {
        console.error(`iteration current fixture did not ignore stale status/current-spec mismatch: ${caseData.id}`);
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
  const indexFor = (id) => ({
    schema_version: 'p2a.run_index.v1',
    projectId: 'fixture-project',
    runs: [{
      runId: id,
      taskId: 'task-001',
      iterationId: 'v1-mvp',
      status: 'failed',
      agentTool: 'codex',
      workspaceRef: 'fixture-workspace',
      taskGraphRef: 'iterations/v1-mvp/gate-c-task-graph/task-graph.json',
      runRef: `${id}.json`,
      startedAt: now,
      finishedAt: now,
    }],
    tasks: [{ taskId: 'task-001', runIds: [id], latestRunId: id }],
  });

  try {
    writeFileSync(path.join(runsDir, `${runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(indexFor(runId), null, 2)}\n`, 'utf8');
    const result = runValidator(['--runs-dir', runsDir]);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 || !output.includes('failed run must include failure')) {
      console.error('negative fixture invalid failed run without failure was not rejected by validator');
      writeResultOutput(result);
      return { status: result.status === 0 ? 1 : failureStatus(result), checks: 1 };
    }

    const missingStructuredRunId = 'run-invalid-failed-without-structured-detail';
    const missingStructuredRun = {
      ...run,
      runId: missingStructuredRunId,
      failure: {
        class: 'verification_failed',
        retryable: 'after_fix',
        needsUserDecision: false,
        source: 'owner',
      },
    };
    writeFileSync(path.join(runsDir, `${missingStructuredRunId}.json`), `${JSON.stringify(missingStructuredRun, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(indexFor(missingStructuredRunId), null, 2)}\n`, 'utf8');
    const structuredResult = runValidator(['--runs-dir', runsDir]);
    const structuredOutput = `${structuredResult.stdout ?? ''}${structuredResult.stderr ?? ''}`;
    if (
      structuredResult.status === 0
      || !structuredOutput.includes('missing required keys: reproduction, localization, guard')
    ) {
      console.error('negative fixture invalid failed run without structured detail was not rejected by validator');
      writeResultOutput(structuredResult);
      return { status: structuredResult.status === 0 ? 1 : failureStatus(structuredResult), checks: 2 };
    }

    const emptyStructuredRunId = 'run-invalid-failed-with-empty-structured-detail';
    const emptyStructuredRun = {
      ...missingStructuredRun,
      runId: emptyStructuredRunId,
      reproduction: {
        steps: [],
        commands: [],
        notes: [],
      },
      localization: {
        findings: [],
        files: [],
      },
      guard: {
        checks: [],
        notes: [],
      },
    };
    writeFileSync(path.join(runsDir, `${emptyStructuredRunId}.json`), `${JSON.stringify(emptyStructuredRun, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runsDir, 'run-index.json'), `${JSON.stringify(indexFor(emptyStructuredRunId), null, 2)}\n`, 'utf8');
    const emptyStructuredResult = runValidator(['--runs-dir', runsDir]);
    const emptyStructuredOutput = `${emptyStructuredResult.stdout ?? ''}${emptyStructuredResult.stderr ?? ''}`;
    if (
      emptyStructuredResult.status === 0
      || !emptyStructuredOutput.includes('failed run must include structured debug detail: reproduction, localization, guard')
    ) {
      console.error('negative fixture invalid failed run with empty structured detail was not rejected by validator');
      writeResultOutput(emptyStructuredResult);
      return { status: emptyStructuredResult.status === 0 ? 1 : failureStatus(emptyStructuredResult), checks: 3 };
    }
    return { status: 0, checks: 3 };
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

  let evalResult;
  try {
    evalResult = validateEvalFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (evalResult.status !== 0) return evalResult.status;

  let memoryResult;
  try {
    memoryResult = validateMemoryFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (memoryResult.status !== 0) return memoryResult.status;

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
  if (evalResult.checks) segments.push(`${evalResult.checks} eval fixture check(s)`);
  if (memoryResult.checks) segments.push(`${memoryResult.checks} memory fixture check(s)`);
  if (e2eResult.checks) segments.push(`${e2eResult.checks} e2e fixture check(s)`);
  if (iterationResult.checks) segments.push(`${iterationResult.checks} iteration fixture check(s)`);
  if (negativeResult.checks) segments.push(`${negativeResult.checks} negative fixture check(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
