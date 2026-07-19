#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for positive, e2e, iteration, and negative fixture cases. */

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  validateTaskContextData,
  validateTaskGraphData,
} from './validate_artifacts.mjs';
import { compareSync } from './p2a_memory.mjs';
import { PROJECT_RUNTIME_SCHEMA_FILES, PROJECT_RUNTIME_SCRIPT_FILES } from './p2a_tool_manifest.mjs';
import { shellQuote } from './p2a_run_commands.mjs';
import { runFilePath, runSidecarPath, runSidecarRef } from './p2a_run_paths.mjs';
import {
  E2E_FIXTURE_ROOT,
  FIXTURE_ROOT,
  loadE2eFixtureManifest,
  assertE2eCaseShape,
  fixtureFailureDetailArgs,
  P2A_CLI,
  ROOT,
  runDoctor,
  runEval,
  runExecute,
  runExecuteFrom,
  runHandoff,
  runHandoffFrom,
  runIteration,
  runMemory,
  runOrchestrate,
  runP2a,
  runProposals,
  runRuns,
  runRunsFrom,
  runTargetEval,
  runTargetExecute,
  runTargetIteration,
  runTargetMemory,
  runTargetP2a,
  runTargetProposals,
  runTargetRuns,
  runTargetTasks,
  runTasks,
  runTasksFrom,
  runValidator,
  writeResultOutput,
} from '../tests/helpers/fixtures.mjs';

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
    const expectedNewAgentFiles = [
      path.join('.agents', 'agents', 'p2a-task-author.md'),
      path.join('.agents', 'agents', 'p2a-milestone-reviewer.md'),
      path.join('.claude', 'agents', 'p2a-task-author.md'),
      path.join('.claude', 'agents', 'p2a-milestone-reviewer.md'),
      path.join('.codex', 'agents', 'p2a-task-author.toml'),
      path.join('.codex', 'agents', 'p2a-milestone-reviewer.toml'),
      path.join('.gemini', 'agents', 'p2a-task-author.md'),
      path.join('.gemini', 'agents', 'p2a-milestone-reviewer.md'),
    ];
    const expectedToolFiles = [
      path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
      path.join('.claude', 'skills', 'p2a-harness', 'SKILL.md'),
      path.join('.claude', 'hooks', 'p2a-confine-workspace.mjs'),
      path.join('.codex', 'agents', 'p2a-task-graph.toml'),
      path.join('.gemini', 'commands', 'p2a', 'harness.toml'),
      ...expectedNewAgentFiles,
    ];
    const expectedGenerated = [
      path.join('.claude', 'settings.json'),
      path.join('.claude', 'settings.local.json'),
      path.join('.plan2agent', 'project.config.json'),
      path.join('.plan2agent', 'manifest.json'),
      path.join('.plan2agent', 'style.md'),
      'PLAN2AGENT.md',
      '.gitignore',
    ];
    const missingFiles = [...expectedScripts, ...expectedSchemas, ...expectedToolFiles, ...expectedGenerated]
      .filter((filePath) => !existsSync(path.join(targetRoot, filePath)));
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const missingManifestNewAgentFiles = expectedNewAgentFiles
      .filter((filePath) => !manifest.aiToolFiles?.includes(filePath));
    const config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    const claudeSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.json'), 'utf8'));
    const claudeLocalSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.local.json'), 'utf8'));
    const codexQualityReviewer = readFileSync(path.join(targetRoot, '.codex', 'agents', 'p2a-quality-reviewer.toml'), 'utf8');
    const gitignore = readFileSync(path.join(targetRoot, '.gitignore'), 'utf8');
    const gitignoreLines = new Set(gitignore.split(/\r?\n/));
    const expectedSandboxEnabled = process.platform === 'darwin' || process.platform === 'linux';
    if (
      missingFiles.length
      || missingManifestNewAgentFiles.length
      || manifest.provenance?.mode !== 'scaffold'
      || manifest.projectId !== 'target-project'
      || manifest.aiToolTargets.join(',') !== 'codex,claude,gemini'
      || manifest.codexAgentProfile?.name !== 'quality'
      || manifest.codexAgentProfile?.model !== 'gpt-5.6-sol'
      || !/^model\s*=\s*"gpt-5\.6-sol"\s*$/m.test(codexQualityReviewer)
      || !/^model_reasoning_effort\s*=\s*"max"\s*$/m.test(codexQualityReviewer)
      || !/^web_search\s*=\s*"live"\s*$/m.test(codexQualityReviewer)
      || config.projectId !== 'target-project'
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
      console.error(JSON.stringify({ missingFiles, missingManifestNewAgentFiles, manifest, config, claudeSettings, claudeLocalSettings }, null, 2));
      return { status: 1, checks };
    }

    const inheritProfileRoot = path.join(tempRoot, 'codex-inherit-project');
    result = runHandoff(['scaffold', '--target', inheritProfileRoot, '--tools', 'codex', '--codex-profile', 'inherit']);
    checks += 1;
    const inheritManifest = result.status === 0
      ? JSON.parse(readFileSync(path.join(inheritProfileRoot, '.plan2agent', 'manifest.json'), 'utf8'))
      : null;
    const inheritReviewerPath = path.join(inheritProfileRoot, '.codex', 'agents', 'p2a-quality-reviewer.toml');
    const inheritReviewer = existsSync(inheritReviewerPath) ? readFileSync(inheritReviewerPath, 'utf8') : '';
    if (
      result.status !== 0
      || inheritManifest?.codexAgentProfile?.name !== 'inherit'
      || /^model\s*=/m.test(inheritReviewer)
      || /^model_reasoning_effort\s*=/m.test(inheritReviewer)
      || !/^web_search\s*=\s*"live"\s*$/m.test(inheritReviewer)
    ) {
      console.error('Codex inherit profile scaffold fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ codexAgentProfile: inheritManifest?.codexAgentProfile, inheritReviewer }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const inheritManifestPath = path.join(inheritProfileRoot, '.plan2agent', 'manifest.json');
    const legacyInheritManifest = JSON.parse(readFileSync(inheritManifestPath, 'utf8'));
    delete legacyInheritManifest.codexAgentProfile;
    writeFileSync(inheritManifestPath, `${JSON.stringify(legacyInheritManifest, null, 2)}\n`, 'utf8');
    result = runHandoff(['update', '--target', inheritProfileRoot, '--apply']);
    checks += 1;
    const migratedInheritManifest = JSON.parse(readFileSync(inheritManifestPath, 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('status: applied')
      || migratedInheritManifest.codexAgentProfile?.name !== 'inherit'
    ) {
      console.error('Legacy Codex profile migration fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ codexAgentProfile: migratedInheritManifest.codexAgentProfile }, null, 2));
      return { status: failureStatus(result), checks };
    }

    unlinkSync(inheritReviewerPath);
    result = runHandoff(['update', '--target', inheritProfileRoot, '--apply']);
    checks += 1;
    const restoredInheritReviewer = existsSync(inheritReviewerPath) ? readFileSync(inheritReviewerPath, 'utf8') : '';
    const restoredInheritManifest = JSON.parse(readFileSync(path.join(inheritProfileRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || restoredInheritManifest.codexAgentProfile?.name !== 'inherit'
      || /^model\s*=/m.test(restoredInheritReviewer)
      || /^model_reasoning_effort\s*=/m.test(restoredInheritReviewer)
      || !/^web_search\s*=\s*"live"\s*$/m.test(restoredInheritReviewer)
    ) {
      console.error('Codex inherit profile update restore fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ codexAgentProfile: restoredInheritManifest.codexAgentProfile, restoredInheritReviewer }, null, 2));
      return { status: failureStatus(result), checks };
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

    const existingFilesRoot = path.join(tempRoot, 'existing-files-project');
    mkdirSync(existingFilesRoot, { recursive: true });
    writeFileSync(path.join(existingFilesRoot, '.gitignore'), 'CUSTOM_KEEP_ME\n', 'utf8');
    writeFileSync(path.join(existingFilesRoot, 'PLAN2AGENT.md'), '# Existing guide\nCUSTOM_KEEP_ME\n', 'utf8');
    result = runHandoff(['scaffold', '--target', existingFilesRoot, '--tools', 'none']);
    checks += 1;
    const mergedGitignore = readFileSync(path.join(existingFilesRoot, '.gitignore'), 'utf8');
    const preservedPlan2AgentGuide = readFileSync(path.join(existingFilesRoot, 'PLAN2AGENT.md'), 'utf8');
    if (
      result.status !== 0
      || !mergedGitignore.includes('CUSTOM_KEEP_ME')
      || !mergedGitignore.includes('.plan2agent/')
      || !mergedGitignore.includes('.claude/settings.local.json')
      || !preservedPlan2AgentGuide.includes('CUSTOM_KEEP_ME')
      || preservedPlan2AgentGuide.includes('Plan2Agent Project Harness')
    ) {
      console.error('scaffold existing generated files were not preserved/merged safely');
      writeResultOutput(result);
      console.error(JSON.stringify({ mergedGitignore, preservedPlan2AgentGuide }, null, 2));
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
    const lazyRun = JSON.parse(readFileSync(runFilePath(path.join(tempRoot, 'runs'), 'run-lazy-config'), 'utf8'));
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
    result = runTargetP2a(targetRoot, ['info', '--json']);
    checks += 1;
    const partialInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    const partialInfoArtifact = partialInfo?.artifacts?.find((artifact) => artifact.artifactRoot === '.plan2agent/artifacts/partial-iteration-service');
    if (
      result.status !== 0
      || partialInfoArtifact?.layout?.kind !== 'incomplete_iteration'
      || !partialInfo.nextActions?.some((action) => action.includes('Repair incomplete iteration layout'))
    ) {
      console.error('p2a info did not classify partial scaffold iteration layout as incomplete');
      writeResultOutput(result);
      console.error(JSON.stringify({ partialInfoArtifact, nextActions: partialInfo?.nextActions }, null, 2));
      return { status: failureStatus(result), checks };
    }
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

    const dryRunRoot = path.join(tempRoot, 'P2AProjectIdUXCheck');
    result = runHandoff(['scaffold', '--target', dryRunRoot, '--tools', 'none', '--dry-run']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('projectId: p2-a-project-id-ux-check') || existsSync(dryRunRoot)) {
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
    delete enhanceConfig.projectId;
    writeFileSync(enhanceConfigPath, `${JSON.stringify(enhanceConfig, null, 2)}\n`);
    result = runHandoff(['enhance', 'dev-skills', '--target', enhanceTargetRoot, '--tools', 'codex', '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent enhance dev-skills dry run')
      || !result.stdout.includes('configUpdatedKeys: projectId,devExecution,roleProfiles,promptTemplates')
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
      || enhancedConfig.projectId !== 'enhance-target'
      || enhancedManifest.projectId !== 'enhance-target'
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

    for (const capability of ['memory', 'orchestration', 'proposals']) {
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
          !result.stdout.includes('After a ready task exists, start supervised run with monitor gate: node .plan2agent/scripts/p2a.mjs execute start --artifacts .plan2agent/artifacts/<project_id> --task <task-id> --agent-tool codex --require-monitor')
        )
      ) {
        console.error('enhance orchestration next-actions fixture failed');
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    const enhancedCapabilityConfig = JSON.parse(readFileSync(enhanceConfigPath, 'utf8'));
    const enhancedCapabilityManifest = JSON.parse(readFileSync(path.join(enhanceTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      enhancedCapabilityConfig.memory?.serverUrlEnv !== 'P2A_MEMORY_URL'
      || enhancedCapabilityConfig.orchestration?.monitorGatePolicy !== 'explicit_require_monitor'
      || enhancedCapabilityConfig.proposals?.patchPolicy !== 'draft_only'
      || enhancedCapabilityManifest.enhancements?.memory?.configVersion !== 'p2a.memory_config.v1'
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
      || enhancedCapabilityInfo.enhancements?.orchestration?.monitorGatePolicy !== 'explicit_require_monitor'
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

    const manualReviewUpdateRoot = path.join(tempRoot, 'manual-review-update-target');
    cpSync(targetRoot, manualReviewUpdateRoot, { recursive: true });
    writeFileSync(path.join(manualReviewUpdateRoot, 'PLAN2AGENT.md'), '# Locally edited guide\n', 'utf8');
    result = runHandoff(['update', '--target', manualReviewUpdateRoot, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes('1 manual review')
      || !result.stdout.includes('- manual_review: generate (generated) -> PLAN2AGENT.md')
      || !result.stdout.includes('safe apply is blocked until they are resolved')
      || result.stdout.includes('Review listed changes. Apply safe updates with:')
    ) {
      console.error('update dry-run did not classify generated/local file drift as manual_review');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['update', '--target', manualReviewUpdateRoot, '--apply']);
    checks += 1;
    if (
      result.status === 0
      || !result.stdout.includes('Plan2Agent update apply')
      || !result.stdout.includes('status: blocked')
      || !result.stdout.includes('manual_review: PLAN2AGENT.md')
    ) {
      console.error('update apply did not block unresolved manual_review generated/local file drift');
      writeResultOutput(result);
      return { status: 1, checks };
    }

    const p2aUpdateRoot = path.join(tempRoot, 'p2a-update-target');
    cpSync(targetRoot, p2aUpdateRoot, { recursive: true });
    writeFileSync(path.join(p2aUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), 'stale runtime script\n', 'utf8');
    result = runTargetP2a(p2aUpdateRoot, ['update', '--tools', 'none', '--dry-run']);
    checks += 1;
    const targetUpdateApplyCommand = quotedCommand(['node', path.join('.plan2agent', 'scripts', 'p2a.mjs'), 'update', '--tools', 'none', '--apply']);
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes('report: .plan2agent/update-reports/update-')
      || !result.stdout.includes(`Apply safe updates with: ${targetUpdateApplyCommand}`)
      || !result.stdout.includes('dry-run: no harness files written')
    ) {
      console.error('scaffold target p2a update dispatch failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const spacedUpdateRoot = path.join(tempRoot, 'target project with spaces');
    cpSync(targetRoot, spacedUpdateRoot, { recursive: true });
    writeFileSync(path.join(spacedUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), 'stale runtime script\n', 'utf8');
    result = runHandoff(['update', '--target', spacedUpdateRoot, '--tools', 'none']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes(`node '${path.join(spacedUpdateRoot, '.plan2agent', 'scripts', 'p2a.mjs')}' update --tools none --apply`)
    ) {
      console.error('update preview next action quoting fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const legacyP2aMissingRoot = path.join(tempRoot, 'legacy-p2a-missing-target');
    cpSync(targetRoot, legacyP2aMissingRoot, { recursive: true });
    unlinkSync(path.join(legacyP2aMissingRoot, '.plan2agent', 'scripts', 'p2a.mjs'));
    result = runHandoffFrom(tempRoot, ['update', '--target', legacyP2aMissingRoot, '--tools', 'none']);
    checks += 1;
    const legacyApplyCommand = quotedCommand(['node', P2A_CLI, 'update', '--target', legacyP2aMissingRoot, '--tools', 'none', '--apply']);
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
    delete applyConfig.projectId;
    writeFileSync(applyConfigPath, `${JSON.stringify(applyConfig, null, 2)}\n`);
    result = runHandoff(['update', '--target', applyUpdateRoot, '--tools', 'none', '--apply']);
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
      || appliedUpdateConfig.projectId !== 'target-project'
      || appliedUpdateConfig.devExecution?.scopePolicy !== 'task_only'
      || appliedUpdateManifest.projectId !== 'target-project'
      || !appliedUpdateManifest.updates?.some((entry) => entry.command === 'update')
	      || applyUpdateReports.length !== 3
	    ) {
      console.error('update apply fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ appliedUpdateConfig, appliedUpdateManifest, applyUpdateReports }, null, 2));
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['update', '--target', applyUpdateRoot, '--tools', 'none', '--apply']);
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

    const assetRestoreUpdateRoot = path.join(tempRoot, 'asset-restore-update-target');
    cpSync(targetRoot, assetRestoreUpdateRoot, { recursive: true });
    for (const filePath of expectedNewAgentFiles) {
      unlinkSync(path.join(assetRestoreUpdateRoot, filePath));
    }
    result = runHandoff(['update', '--target', assetRestoreUpdateRoot, '--apply']);
    checks += 1;
    const unrestoredNewAgentFiles = expectedNewAgentFiles.filter((filePath) => {
      const restoredPath = path.join(assetRestoreUpdateRoot, filePath);
      return !existsSync(restoredPath)
        || readFileSync(restoredPath, 'utf8') !== readFileSync(path.join(ROOT, filePath), 'utf8');
    });
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update apply')
      || !result.stdout.includes('status: applied')
      || unrestoredNewAgentFiles.length
    ) {
      console.error('update apply did not restore new canonical/provider agent assets');
      writeResultOutput(result);
      console.error(JSON.stringify({ unrestoredNewAgentFiles }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const applyUpgradeRoot = path.join(tempRoot, 'apply-upgrade-target');
    cpSync(targetRoot, applyUpgradeRoot, { recursive: true });
    const staleSchemaPath = path.join(applyUpgradeRoot, '.plan2agent', 'schemas', 'run.schema.json');
    writeFileSync(staleSchemaPath, '{"stale": true}\n', 'utf8');
    const applyUpgradeManifestPath = path.join(applyUpgradeRoot, '.plan2agent', 'manifest.json');
    const applyUpgradeManifestBefore = JSON.parse(readFileSync(applyUpgradeManifestPath, 'utf8'));
    delete applyUpgradeManifestBefore.projectId;
    writeFileSync(applyUpgradeManifestPath, `${JSON.stringify(applyUpgradeManifestBefore, null, 2)}\n`);
    result = runHandoff(['upgrade', '--target', applyUpgradeRoot, '--tools', 'none', '--apply']);
    checks += 1;
    const appliedUpgradeManifest = JSON.parse(readFileSync(applyUpgradeManifestPath, 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent upgrade apply')
      || !result.stdout.includes('status: applied')
      || readFileSync(staleSchemaPath, 'utf8') !== readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8')
      || appliedUpgradeManifest.projectId !== 'target-project'
      || !appliedUpgradeManifest.updates?.some((entry) => entry.command === 'upgrade')
    ) {
      console.error('upgrade apply fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ appliedUpgradeManifest }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const legacyProjectIdRoot = path.join(tempRoot, 'renamed-target');
    cpSync(targetRoot, legacyProjectIdRoot, { recursive: true });
    const legacyProjectIdConfigPath = path.join(legacyProjectIdRoot, '.plan2agent', 'project.config.json');
    const legacyProjectIdManifestPath = path.join(legacyProjectIdRoot, '.plan2agent', 'manifest.json');
    const legacyArtifactId = 'legacy-artifact-id';
    const legacyProjectIdConfig = JSON.parse(readFileSync(legacyProjectIdConfigPath, 'utf8'));
    const legacyProjectIdManifest = JSON.parse(readFileSync(legacyProjectIdManifestPath, 'utf8'));
    delete legacyProjectIdConfig.projectId;
    delete legacyProjectIdManifest.projectId;
    writeFileSync(legacyProjectIdConfigPath, `${JSON.stringify(legacyProjectIdConfig, null, 2)}\n`);
    writeFileSync(legacyProjectIdManifestPath, `${JSON.stringify(legacyProjectIdManifest, null, 2)}\n`);
    mkdirSync(path.join(legacyProjectIdRoot, '.plan2agent', 'artifacts', legacyArtifactId), { recursive: true });
    writeFileSync(
      path.join(legacyProjectIdRoot, '.plan2agent', 'artifacts', legacyArtifactId, 'current-spec.json'),
      `${JSON.stringify({ project_id: legacyArtifactId }, null, 2)}\n`,
      'utf8',
    );
    result = runHandoff(['update', '--target', legacyProjectIdRoot, '--tools', 'none', '--apply']);
    checks += 1;
    const restoredLegacyProjectIdConfig = JSON.parse(readFileSync(legacyProjectIdConfigPath, 'utf8'));
    const restoredLegacyProjectIdManifest = JSON.parse(readFileSync(legacyProjectIdManifestPath, 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update apply')
      || restoredLegacyProjectIdConfig.projectId !== legacyArtifactId
      || restoredLegacyProjectIdManifest.projectId !== legacyArtifactId
    ) {
      console.error('legacy artifact projectId recovery fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ restoredLegacyProjectIdConfig, restoredLegacyProjectIdManifest }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const blockedUpdateRoot = path.join(tempRoot, 'blocked-update-target');
    cpSync(targetRoot, blockedUpdateRoot, { recursive: true });
    const conflictRuntimePath = path.join(blockedUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs');
    rmSync(conflictRuntimePath, { force: true });
    mkdirSync(conflictRuntimePath, { recursive: true });
    result = runHandoff(['update', '--target', blockedUpdateRoot, '--tools', 'none', '--apply']);
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
    result = runHandoff(['upgrade', '--target', failedApplyRoot, '--tools', 'none', '--apply']);
    checks += 1;
    chmodSync(failedSchemaPath, 0o644);
    const failedReportsDir = path.join(failedApplyRoot, '.plan2agent', 'update-reports');
    const failedReports = existsSync(failedReportsDir) ? readdirSync(failedReportsDir).filter((entry) => entry.endsWith('.json')) : [];
	    const failedReport = failedReports
	      .map((entry) => JSON.parse(readFileSync(path.join(failedReportsDir, entry), 'utf8')))
	      .find((report) => report.schema_version === 'p2a.upgrade_apply.v1' && report.status === 'failed') ?? null;
	    const partialFailureObserved = result.status !== 0
	      && result.stdout.includes('Plan2Agent upgrade apply')
	      && result.stdout.includes('status: failed')
	      && failedReports.length === 3
      && failedReport?.status === 'failed'
      && failedReport?.applied?.files?.includes('.plan2agent/scripts/p2a_eval.mjs')
      && failedReport?.error
      && readFileSync(failedRuntimePath, 'utf8') === readFileSync(path.join(ROOT, 'scripts', 'p2a_eval.mjs'), 'utf8');
    const readOnlyWriteBypassed = process.getuid?.() === 0
      && result.status === 0
      && result.stdout.includes('Plan2Agent upgrade apply')
      && result.stdout.includes('status: applied')
      && readFileSync(failedRuntimePath, 'utf8') === readFileSync(path.join(ROOT, 'scripts', 'p2a_eval.mjs'), 'utf8')
      && readFileSync(failedSchemaPath, 'utf8') === readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8');
    if (!partialFailureObserved && !readOnlyWriteBypassed) {
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
    result = runHandoff(['upgrade', '--target', legacyUpgradeRoot, '--tools', 'none', '--dry-run']);
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

function maintenanceEvalRunFixture(runId, approvalId, taskId = 'task-999') {
  return {
    schema_version: 'p2a.run.v1',
    runId,
    projectId: 'webhook-api-service',
    taskId,
    taskTitle: 'Apply approved proposal maintenance',
    iterationId: 'maintenance',
    sourceLayout: 'maintenance',
    taskGraphRef: 'iterations/maintenance/gate-c-task-graph/task-graph.json',
    sourceSpecRef: 'current-spec.json',
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
    status: 'finished',
    startedAt: '2026-07-02T00:02:00.000Z',
    updatedAt: '2026-07-02T00:03:00.000Z',
    finishedAt: '2026-07-02T00:03:00.000Z',
    changedFiles: ['scripts/p2a_eval.mjs'],
    verification: [{
      type: 'test',
      command: 'node scripts/run_fixtures.mjs --eval-only',
      status: 'passed',
      exitCode: 0,
      durationMs: 1000,
      startedAt: '2026-07-02T00:02:30.000Z',
      finishedAt: '2026-07-02T00:02:31.000Z',
      stdoutTail: 'eval fixtures passed',
      stderrTail: null,
      source: 'command',
    }],
    notes: [
      `proposalApproval=${approvalId}`,
      'proposalPatchDraft=proposal-patch-draft-111111111111',
      'proposalCandidate=candidate-111111111111',
    ],
  };
}

function writeEvalProposal(proposalsDir, proposal) {
  mkdirSync(proposalsDir, { recursive: true });
  writeFileSync(path.join(proposalsDir, `${proposal.proposalId}.json`), `${JSON.stringify({
    schema_version: 'p2a.skill_proposal.v1',
    recommendedChange: 'Fixture proposal change.',
    targetFiles: ['scripts/p2a_eval.mjs'],
    risk: 'low',
    evidence: ['fixture evidence'],
    status: 'proposed',
    ...proposal,
  }, null, 2)}\n`, 'utf8');
}

function writeSelfImprovementMaintenanceFixture(rootDir, options = {}) {
  mkdirSync(rootDir, { recursive: true });
  const approvalId = options.approvalId ?? 'proposal-draft-approval-111111111111';
  const draftId = options.draftId ?? 'proposal-patch-draft-111111111111';
  const candidateId = options.candidateId ?? 'candidate-111111111111';
  const curationId = options.curationId ?? 'proposal-curation-111111111111';
  const groupId = options.groupId ?? 'group-111111111111';
  const proposalIds = options.proposalIds ?? ['proposal-run-eval-failed-verification_failed'];
  const sourceRunIds = options.sourceRunIds ?? ['run-eval-failed'];
  const taskId = options.taskId ?? 'task-999';
  const curationPath = path.join(rootDir, 'proposal-curation.json');
  const draftPath = path.join(rootDir, 'proposal-patch-draft.json');
  writeFileSync(curationPath, `${JSON.stringify({
    schema_version: 'p2a.proposal_curation.v1',
    curationId,
    generatedAt: '2026-07-02T00:01:30.000Z',
    sourceReview: 'proposal-review.json',
    sourceProposalsDir: 'proposals',
    summary: {
      totalCandidates: 1,
      byReadiness: { patch_candidate: 1, needs_evidence: 0, watch: 0, no_action: 0 },
      byRecommendedDisposition: { approve: 1, defer: 0, reject: 0, needs_more_evidence: 0 },
      quality: { averageScore: 100, strong: 1, medium: 0, weak: 0, needsAttention: 0 },
    },
    candidates: [{
      candidateId,
      groupId,
      proposalIds,
      classification: 'verification_failed',
      title: 'Improve verification failed handling',
      problemStatement: 'Fixture approved proposal without mutating the proposal status field.',
      recommendedChange: 'Fixture proposal change.',
      recommendedDisposition: 'approve',
      readiness: 'patch_candidate',
      priority: 'P1',
      risk: 'medium',
      frequency: 1,
      targetFiles: ['scripts/p2a_eval.mjs'],
      sourceRunIds,
      evidenceStrength: 'medium',
      rationale: 'Fixture approval artifact links the proposal to maintenance work.',
      nextAction: 'Prepare a separate patch for human approval; do not apply automatically.',
      separatePatchRequired: true,
      quality: {
        averageScore: 100,
        band: 'strong',
        needsAttention: 0,
        missing: [],
      },
    }],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(draftPath, `${JSON.stringify({
    schema_version: 'p2a.proposal_patch_draft.v1',
    draftId,
    generatedAt: '2026-07-02T00:01:45.000Z',
    sourceCuration: curationPath,
    candidateId,
    classification: 'verification_failed',
    title: 'Patch draft: Improve verification failed handling',
    status: 'draft',
    approvalRequired: true,
    autoApplyAllowed: false,
    targetFiles: ['scripts/p2a_eval.mjs'],
    intendedChanges: [{
      file: 'scripts/p2a_eval.mjs',
      changeType: 'update',
      description: 'Fixture approved proposal follow-up.',
    }],
    verificationPlan: [{
      type: 'fixture',
      command: 'node scripts/run_fixtures.mjs',
      required: true,
    }],
    risks: ['Fixture risk.'],
    rationale: 'Fixture draft records an approval-ready candidate without mutating source proposals.',
  }, null, 2)}\n`, 'utf8');
  const maintenanceGraphPath = path.join(rootDir, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
  mkdirSync(path.dirname(maintenanceGraphPath), { recursive: true });
  writeFileSync(maintenanceGraphPath, `${JSON.stringify({
    schema_version: 'p2a.task_graph.v1',
    projectId: 'webhook-api-service',
    version: 'maintenance',
    sourceSpec: '../../../current-spec.json',
    tasks: [{
      id: taskId,
      title: 'Apply approved proposal maintenance',
      description: 'Fixture maintenance task linked to an approved proposal.',
      status: 'done',
      dependencies: [],
      acceptanceCriteria: ['Post-maintenance eval fixtures pass.'],
      targetArea: 'maintenance',
      suggestedAgentPrompt: 'Apply the approved proposal maintenance fixture.',
      sourceSpecRefs: [
        `proposal-draft-approval:${approvalId}`,
        `proposal-patch-draft:${draftId}`,
        `proposal-candidate:${candidateId}`,
        'proposal-target:project',
      ],
    }],
  }, null, 2)}\n`, 'utf8');
  const approvalPath = path.join(rootDir, 'proposal-draft-approval.json');
  writeFileSync(approvalPath, `${JSON.stringify({
    schema_version: 'p2a.proposal_draft_approval.v1',
    approvalId,
    approvedAt: '2026-07-02T00:02:00.000Z',
    approvedBy: 'fixture-reviewer',
    approvalNote: 'Fixture approval',
    sourceDraft: draftPath,
    draftId,
    candidateId,
    target: 'project',
    autoApplyPerformed: false,
    maintenanceTask: {
      taskGraph: maintenanceGraphPath,
      taskId,
      title: 'Apply approved proposal maintenance',
      sourceSpecRefs: [
        `proposal-draft-approval:${approvalId}`,
        `proposal-patch-draft:${draftId}`,
        `proposal-candidate:${candidateId}`,
        'proposal-target:project',
      ],
    },
  }, null, 2)}\n`, 'utf8');
  return { approvalId, taskId, maintenanceGraphPath, approvalPath };
}

function writeEvalRuns(runsDir, runs) {
  mkdirSync(runsDir, { recursive: true });
  for (const run of runs) {
    writeFileSync(path.join(runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  const tasksById = new Map();
  for (const run of runs) {
    if (!tasksById.has(run.taskId)) tasksById.set(run.taskId, []);
    tasksById.get(run.taskId).push(run.runId);
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
    tasks: [...tasksById.entries()].map(([taskId, runIds]) => ({
      taskId,
      runIds,
      latestRunId: runIds[runIds.length - 1] ?? null,
    })),
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
    const repeatedFailedRun = evalRunFixture('run-eval-failed-repeat', 'failed');
    const selfImprovementFixture = writeSelfImprovementMaintenanceFixture(tempRoot);
    const maintenanceRun = maintenanceEvalRunFixture(
      'run-eval-maintenance-pass',
      selfImprovementFixture.approvalId,
      selfImprovementFixture.taskId,
    );
    writeEvalRuns(baselineRunsDir, [passRun]);
    writeEvalRuns(candidateRunsDir, [passRun, failedRun, repeatedFailedRun, maintenanceRun]);

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

    const evalProposalsDir = path.join(tempRoot, 'proposals');
    result = runProposals(['mine', '--runs', candidateRunsDir, '--proposals', evalProposalsDir]);
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
    const approvedProposalPath = path.join(evalProposalsDir, 'proposal-run-eval-failed-verification_failed.json');
    const approvedProposal = JSON.parse(readFileSync(approvedProposalPath, 'utf8'));
    if (
      approvedProposal.riskRationale !== 'verification_failed can recur across runs and should be corrected before relying on similar execution guidance.'
      || approvedProposal.quality?.score !== 100
      || approvedProposal.quality?.band !== 'strong'
      || approvedProposal.status !== 'proposed'
    ) {
      console.error('proposal quality mining fixture failed');
      console.error(JSON.stringify({ approvedProposal }, null, 2));
      return { status: 1, checks };
    }
    writeEvalProposal(evalProposalsDir, {
      proposalId: 'proposal-fixture-rejected',
      sourceRunId: 'run-eval-failed',
      problem: 'Fixture rejected proposal.',
      status: 'rejected',
      note: 'Rejected in fixture to exercise self-improvement metrics.',
    });
    writeEvalProposal(evalProposalsDir, {
      proposalId: 'proposal-fixture-deferred',
      sourceRunId: 'run-eval-failed-repeat',
      problem: 'Fixture deferred proposal.',
      status: 'deferred',
      note: 'Deferred in fixture to exercise self-improvement metrics.',
    });

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
      || evalIndex?.summary?.grades !== 3
      || evalIndex?.summary?.nonPassGrades !== 2
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
	      || regeneratedEvalIndex?.summary?.grades !== 3
	      || regeneratedEvalIndex?.summary?.nonPassGrades !== 2
	    ) {
	      console.error('eval generate stale output cleanup fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

	    result = runEval(['digest', '--eval', evalOutputDir]);
	    checks += 1;
	    if (
	      result.status !== 0
	      || !result.stdout.includes('Plan2Agent eval digest')
	      || !result.stdout.includes('"pass":1')
	      || !result.stdout.includes('"fail":2')
	      || !result.stdout.includes('self-improvement: runs=4 failedOrBlocked=2 proposals=4 approved=1 recurringFailures=1')
	    ) {
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
      || evalDigest?.grades?.byVerdict?.fail !== 2
      || evalDigest?.analyses?.clusters !== 1
      || evalDigest?.selfImprovement?.runs?.total !== 4
      || evalDigest?.selfImprovement?.runs?.failedOrBlocked !== 2
      || evalDigest?.selfImprovement?.runs?.failureEvidence?.complete !== 2
      || evalDigest?.selfImprovement?.proposals?.byStatus?.approved !== 1
      || evalDigest?.selfImprovement?.proposals?.byStatus?.rejected !== 1
      || evalDigest?.selfImprovement?.proposals?.byStatus?.deferred !== 1
      || evalDigest?.selfImprovement?.proposals?.byStatus?.proposed !== 1
      || evalDigest?.selfImprovement?.proposals?.originalByStatus?.proposed !== 2
      || evalDigest?.selfImprovement?.proposals?.approvedByArtifact !== 1
      || evalDigest?.selfImprovement?.recurringFailures?.clusters !== 1
      || evalDigest?.selfImprovement?.maintenance?.conversionRate !== 1
      || evalDigest?.selfImprovement?.maintenance?.postMaintenanceVerification?.successRate !== 1
    ) {
      console.error('eval digest output fixture failed');
	      writeResultOutput(result);
	      return { status: failureStatus(result), checks };
	    }

    const recentRoot = path.join(tempRoot, 'self-improvement-recent-runs');
    const recentRunsDir = path.join(recentRoot, 'runs');
    const recentEvalDir = path.join(recentRoot, 'eval');
    const recentProposalsDir = path.join(recentRoot, 'proposals');
    const recentOldFailedRun = evalRunFixture('run-eval-recent-old-failed', 'failed');
    const recentMiddlePassRun = evalRunFixture('run-eval-recent-middle-pass');
    const recentNewFailedRun = evalRunFixture('run-eval-recent-new-failed', 'failed');
    for (const [run, timestamp] of [
      [recentOldFailedRun, '2026-07-02T00:01:00.000Z'],
      [recentMiddlePassRun, '2026-07-02T00:02:00.000Z'],
      [recentNewFailedRun, '2026-07-02T00:03:00.000Z'],
    ]) {
      run.startedAt = timestamp;
      run.updatedAt = timestamp;
      run.finishedAt = timestamp;
    }
    writeEvalRuns(recentRunsDir, [recentOldFailedRun, recentMiddlePassRun, recentNewFailedRun]);
    writeSelfImprovementMaintenanceFixture(recentRoot);
    writeEvalProposal(recentProposalsDir, {
      proposalId: 'proposal-run-eval-failed-verification_failed',
      sourceRunId: recentOldFailedRun.runId,
      problem: 'Out-of-window proposal should not affect recent self-improvement metrics.',
      status: 'proposed',
      note: 'Exercises recent run scope filtering.',
    });
    const recentCurationLinkedProposalId = 'proposal-curation-source-run-linked';
    writeSelfImprovementMaintenanceFixture(path.join(recentRoot, 'curation-linked-flow'), {
      approvalId: 'proposal-draft-approval-222222222222',
      draftId: 'proposal-patch-draft-222222222222',
      candidateId: 'candidate-222222222222',
      curationId: 'proposal-curation-222222222222',
      groupId: 'group-222222222222',
      proposalIds: [recentCurationLinkedProposalId],
      sourceRunIds: [recentNewFailedRun.runId],
      taskId: 'task-998',
    });
    writeEvalProposal(recentProposalsDir, {
      proposalId: recentCurationLinkedProposalId,
      sourceRunId: recentOldFailedRun.runId,
      problem: 'Curation sourceRunIds should link this proposal to the recent run window.',
      status: 'proposed',
      note: 'Exercises curation sourceRunIds scope fallback.',
    });
    mkdirSync(recentEvalDir, { recursive: true });
    writeFileSync(path.join(recentEvalDir, 'analysis.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_analysis.v1',
      source: {
        sourceKind: 'runs',
        sourcePath: recentRunsDir,
        runsDir: recentRunsDir,
        proposalsDir: path.join(recentRoot, 'proposals'),
      },
      clusters: [],
    }, null, 2)}\n`, 'utf8');
    result = runEval(['digest', '--eval', recentEvalDir, '--recent-runs', '2', '--output', path.join(recentRoot, 'eval-digest.json')]);
    checks += 1;
    const recentDigest = JSON.parse(readFileSync(path.join(recentRoot, 'eval-digest.json'), 'utf8'));
    if (
      result.status !== 0
      || recentDigest.selfImprovement.sources.runLimit !== 2
      || recentDigest.selfImprovement.sources.totalRunsAvailable !== 3
      || recentDigest.selfImprovement.sources.totalProposalsAvailable !== 2
      || recentDigest.selfImprovement.sources.proposalsExcludedByRunScope !== 1
      || recentDigest.selfImprovement.runs.total !== 2
      || recentDigest.selfImprovement.runs.failedOrBlocked !== 1
      || recentDigest.selfImprovement.runs.failureEvidence.complete !== 1
      || recentDigest.selfImprovement.proposals.total !== 1
      || recentDigest.selfImprovement.proposals.approved !== 1
      || recentDigest.selfImprovement.proposals.approvedByArtifact !== 1
      || recentDigest.selfImprovement.maintenance.approvals !== 1
      || recentDigest.selfImprovement.maintenance.totalApprovalsAvailable !== 2
      || recentDigest.selfImprovement.maintenance.approvalsExcludedByRunScope !== 1
      || recentDigest.selfImprovement.maintenance.conversionRate !== 1
    ) {
      console.error('eval digest recent-runs self-improvement fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ recentDigest }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const legacyProposalRoot = path.join(tempRoot, 'self-improvement-legacy-approved-proposal');
    const legacyProposalRunsDir = path.join(legacyProposalRoot, 'runs');
    const legacyProposalEvalDir = path.join(legacyProposalRoot, 'eval');
    const legacyProposalId = 'proposal-legacy-approved';
    const legacyRun = evalRunFixture('run-eval-legacy-approved-failed', 'failed');
    writeEvalRuns(legacyProposalRunsDir, [legacyRun]);
    writeEvalProposal(path.join(legacyProposalRoot, 'proposals'), {
      proposalId: legacyProposalId,
      sourceRunId: legacyRun.runId,
      problem: 'Legacy approved proposal should convert through proposal source refs.',
      status: 'approved',
      note: 'Exercises approval-artifact-free proposal conversion.',
    });
    const legacyMaintenanceGraphPath = path.join(legacyProposalRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
    mkdirSync(path.dirname(legacyMaintenanceGraphPath), { recursive: true });
    writeFileSync(legacyMaintenanceGraphPath, `${JSON.stringify({
      schema_version: 'p2a.task_graph.v1',
      projectId: 'webhook-api-service',
      version: 'maintenance',
      sourceSpec: '../../../current-spec.json',
      tasks: [{
        id: 'task-997',
        title: 'Apply legacy approved proposal maintenance',
        description: 'Fixture legacy maintenance task linked directly to an approved proposal.',
        status: 'done',
        dependencies: [],
        acceptanceCriteria: ['Legacy proposal maintenance is represented in self-improvement metrics.'],
        targetArea: 'maintenance',
        suggestedAgentPrompt: 'Apply the legacy approved proposal.',
        sourceSpecRefs: [`proposal:${legacyProposalId}`],
      }],
    }, null, 2)}\n`, 'utf8');
    mkdirSync(legacyProposalEvalDir, { recursive: true });
    writeFileSync(path.join(legacyProposalEvalDir, 'analysis.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_analysis.v1',
      source: {
        sourceKind: 'artifacts',
        sourcePath: legacyProposalRoot,
        runsDir: legacyProposalRunsDir,
        proposalsDir: path.join(legacyProposalRoot, 'proposals'),
      },
      clusters: [],
    }, null, 2)}\n`, 'utf8');
    result = runEval(['digest', '--eval', legacyProposalEvalDir, '--output', path.join(legacyProposalRoot, 'eval-digest.json')]);
    checks += 1;
    const legacyProposalDigest = JSON.parse(readFileSync(path.join(legacyProposalRoot, 'eval-digest.json'), 'utf8'));
    if (
      result.status !== 0
      || legacyProposalDigest.selfImprovement.proposals.total !== 1
      || legacyProposalDigest.selfImprovement.proposals.approved !== 1
      || legacyProposalDigest.selfImprovement.maintenance.approvals !== 0
      || legacyProposalDigest.selfImprovement.maintenance.approvedProposalSignals !== 1
      || legacyProposalDigest.selfImprovement.maintenance.maintenanceTasksFromProposals !== 1
      || legacyProposalDigest.selfImprovement.maintenance.convertedApprovals !== 1
      || legacyProposalDigest.selfImprovement.maintenance.conversionRate !== 1
    ) {
      console.error('eval digest legacy approved proposal conversion fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ legacyProposalDigest }, null, 2));
      return { status: failureStatus(result), checks };
    }

    const noProposalRoot = path.join(tempRoot, 'self-improvement-no-proposals');
    const noProposalRunsDir = path.join(noProposalRoot, 'runs');
    const noProposalEvalDir = path.join(noProposalRoot, 'eval');
    writeEvalRuns(noProposalRunsDir, [evalRunFixture('run-eval-no-proposal-failed', 'failed')]);
    mkdirSync(noProposalEvalDir, { recursive: true });
    writeFileSync(path.join(noProposalEvalDir, 'analysis.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_analysis.v1',
      source: {
        sourceKind: 'runs',
        sourcePath: noProposalRunsDir,
        runsDir: noProposalRunsDir,
        proposalsDir: path.join(noProposalRoot, 'proposals'),
      },
      clusters: [],
    }, null, 2)}\n`, 'utf8');
    result = runEval(['digest', '--eval', noProposalEvalDir, '--output', path.join(noProposalRoot, 'eval-digest.json')]);
    checks += 1;
    const noProposalDigest = JSON.parse(readFileSync(path.join(noProposalRoot, 'eval-digest.json'), 'utf8'));
    if (
      result.status !== 0
      || noProposalDigest.selfImprovement.proposals.total !== 0
      || noProposalDigest.selfImprovement.proposals.pendingReview !== 0
      || noProposalDigest.selfImprovement.runs.failureEvidence.complete !== 1
    ) {
      console.error('eval digest no-proposal self-improvement fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const missingEvidenceEvalDir = path.join(tempRoot, 'self-improvement-missing-evidence', 'eval');
    mkdirSync(path.join(missingEvidenceEvalDir, 'grades'), { recursive: true });
    writeFileSync(path.join(missingEvidenceEvalDir, 'grades', 'run-missing-evidence.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_grade.v1',
      task: { taskId: 'task-001' },
      run: {
        runId: 'run-missing-evidence',
        status: 'failed',
        verification: [{ status: 'failed' }],
        changedFiles: [],
      },
      verdict: 'fail',
      score: 0,
      acceptanceCoverage: [],
      reasons: ['missing structured failure evidence fixture'],
    }, null, 2)}\n`, 'utf8');
    result = runEval(['digest', '--eval', missingEvidenceEvalDir, '--output', path.join(tempRoot, 'missing-evidence-digest.json')]);
    checks += 1;
    const missingEvidenceDigest = JSON.parse(readFileSync(path.join(tempRoot, 'missing-evidence-digest.json'), 'utf8'));
    if (
      result.status !== 0
      || missingEvidenceDigest.selfImprovement.runs.failedOrBlocked !== 1
      || missingEvidenceDigest.selfImprovement.runs.failureEvidence.incomplete !== 1
      || missingEvidenceDigest.selfImprovement.runs.failureEvidence.missing.reproduction !== 1
      || missingEvidenceDigest.selfImprovement.runs.failureEvidence.missing.localization !== 1
      || missingEvidenceDigest.selfImprovement.runs.failureEvidence.missing.guard !== 1
    ) {
      console.error('eval digest missing-evidence self-improvement fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const pendingConversionRoot = path.join(tempRoot, 'self-improvement-pending-conversion');
    const pendingConversionRunsDir = path.join(pendingConversionRoot, 'runs');
    const pendingConversionProposalsDir = path.join(pendingConversionRoot, 'proposals');
    const pendingConversionEvalDir = path.join(pendingConversionRoot, 'eval');
    writeEvalRuns(pendingConversionRunsDir, [evalRunFixture('run-eval-pending-conversion', 'failed')]);
    writeEvalProposal(pendingConversionProposalsDir, {
      proposalId: 'proposal-pending-conversion',
      sourceRunId: 'run-eval-pending-conversion',
      problem: 'Approved proposal without a maintenance task.',
      status: 'approved',
    });
    mkdirSync(pendingConversionEvalDir, { recursive: true });
    writeFileSync(path.join(pendingConversionEvalDir, 'analysis.json'), `${JSON.stringify({
      schema_version: 'p2a.eval_analysis.v1',
      source: {
        sourceKind: 'runs',
        sourcePath: pendingConversionRunsDir,
        runsDir: pendingConversionRunsDir,
        proposalsDir: pendingConversionProposalsDir,
      },
      clusters: [],
    }, null, 2)}\n`, 'utf8');
    result = runEval(['digest', '--eval', pendingConversionEvalDir, '--output', path.join(pendingConversionRoot, 'eval-digest.json')]);
    checks += 1;
    const pendingConversionDigest = JSON.parse(readFileSync(path.join(pendingConversionRoot, 'eval-digest.json'), 'utf8'));
    if (
      result.status !== 0
      || pendingConversionDigest.selfImprovement.proposals.byStatus.approved !== 1
      || pendingConversionDigest.selfImprovement.maintenance.pendingConversions !== 1
      || pendingConversionDigest.selfImprovement.maintenance.convertedApprovals !== 0
      || pendingConversionDigest.selfImprovement.maintenance.conversionRate !== 0
    ) {
      console.error('eval digest pending-conversion self-improvement fixture failed');
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

  let attributionResult = spawnSync(process.execPath, ['--test', path.join(ROOT, 'tests', 'memory-run-attribution.test.mjs')], { cwd: ROOT, encoding: 'utf8' });
  checks += 1;
  if (attributionResult.status !== 0) {
    console.error('memory run attribution node:test fixture failed');
    writeResultOutput(attributionResult);
    return { status: failureStatus(attributionResult), checks };
  }

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

  const memoryProposalsDir = mkdtempSync(path.join(tmpdir(), 'p2a-memory-proposals-'));
  try {
    writeEvalProposal(memoryProposalsDir, {
      proposalId: 'proposal-memory-upstream-toolkit',
      sourceRunId: 'run-memory-upstream-toolkit',
      target: 'p2a_toolkit',
      targetRepo: 'https://github.com/silbaram/plan2agent',
      targetArea: 'p2a-memory',
      upstreamReason: 'Fixture proposal should be searchable by the Plan2Agent toolkit.',
      problem: 'Memory should preserve upstream toolkit proposals.',
      note: 'Exercises proposal snapshot sync into Memory.',
    });

    result = runMemory(['status', '--graph', graphPath, '--proposals', memoryProposalsDir, '--json']);
    checks += 1;
    const memoryProposalStatus = result.status === 0 ? JSON.parse(result.stdout) : null;
    const memoryProposalItem = memoryProposalStatus?.sync?.items?.find((item) => item.artifactType === 'PROPOSAL');
    if (
      result.status !== 0
      || memoryProposalStatus?.local?.proposals !== 1
      || memoryProposalItem?.metadata?.proposalTarget !== 'p2a_toolkit'
      || memoryProposalItem?.metadata?.targetRepo !== 'https://github.com/silbaram/plan2agent'
    ) {
      console.error('memory proposal snapshot status fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ memoryProposalStatus }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runMemory(['push', '--graph', graphPath, '--proposals', memoryProposalsDir, '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('proposals=1')
      || !result.stdout.includes('PROPOSAL: 1')
    ) {
      console.error('memory proposal snapshot push dry-run fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
  } finally {
    rmSync(memoryProposalsDir, { recursive: true, force: true });
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
  if (
    result.status === 0
    || !result.stdout.includes('Plan2Agent memory search')
    || !result.stdout.includes('type=PROPOSAL')
    || !result.stdout.includes('server: not_configured')
    || !result.stdout.includes('Set P2A_MEMORY_URL or pass --server to search Memory.')
  ) {
    console.error('memory search proposal type not-configured fixture failed');
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

  const digestRoot = mkdtempSync(path.join(tmpdir(), 'p2a-memory-digest-'));
  const digestRunsDir = path.join(digestRoot, 'runs');
  try {
    const memoryDigestRun = evalRunFixture('run-memory-digest-failed', 'failed');
    memoryDigestRun.notes.push('Memory search reference used: run-memory-prior');
    writeEvalRuns(digestRunsDir, [memoryDigestRun]);
    mkdirSync(path.join(digestRoot, 'eval'), { recursive: true });
    writeFileSync(path.join(digestRoot, 'eval', 'memory-search.json'), `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      generatedAt: '2026-07-02T00:00:00.000Z',
      query: { text: 'stale search result' },
      context: {
        sourceKind: 'runs',
        sourcePath: path.join(digestRoot, 'other-runs'),
        projectId: 'webhook-api-service',
        iterationId: '1',
      },
      summary: {
        total: 1,
        byType: { RUN_RECORD: 1 },
      },
      results: [{
        artifactType: 'RUN_RECORD',
        score: 0.99,
        sourceIds: {
          sourceRunId: 'stale-run',
        },
      }],
    }, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(digestRoot, 'eval', 'prior-memory-result.json'), `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      generatedAt: '2026-07-02T00:00:00.000Z',
      query: { text: 'prior failed run memory' },
      context: {
        sourceKind: 'runs',
        sourcePath: digestRunsDir,
        projectId: 'webhook-api-service',
        iterationId: '1',
      },
      summary: {
        total: 1,
        byType: { RUN_RECORD: 1 },
      },
      results: [{
        artifactType: 'RUN_RECORD',
        score: 0.91,
        sourceIds: {
          sourceRunId: 'run-memory-prior',
        },
      }],
    }, null, 2)}\n`, 'utf8');
    const digestOutputPath = path.join(digestRoot, 'memory-digest.json');
    result = runMemory(['digest', '--runs', digestRunsDir, '--output', digestOutputPath]);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('structured: reproduction=1/1 localization=1/1 guard=1/1')
      || !result.stdout.includes('memory usefulness: searchReports=1 used=1/1 rate=1')
      || !result.stdout.includes('Mine missing proposal candidates')
    ) {
      console.error('memory digest structured detail fixture failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    const memoryDigest = JSON.parse(readFileSync(digestOutputPath, 'utf8'));
    if (
      memoryDigest.memoryUsefulness?.searchReports !== 1
      || memoryDigest.memoryUsefulness?.totalResults !== 1
      || memoryDigest.memoryUsefulness?.usedResults !== 1
      || memoryDigest.memoryUsefulness?.usedBy?.run !== 1
    ) {
      console.error('memory digest usefulness fixture failed');
      console.error(JSON.stringify({ memoryDigest }, null, 2));
      return { status: 1, checks };
    }
  } finally {
    rmSync(digestRoot, { recursive: true, force: true });
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

  function writeFeatureRadarPreflightFixture(artifactRoot) {
    const preflightDir = path.join(artifactRoot, 'preflight-research');
    mkdirSync(preflightDir, { recursive: true });
    writeFileSync(
      path.join(preflightDir, 'collection-report.md'),
      [
        '# Feature Radar Collection Report',
        '',
        'Recommended direction: prioritize a delivery visibility dashboard before adding broad notification channels.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(preflightDir, 'next-iteration-recommendations.md'),
      [
        '# Next Iteration Recommendations',
        '',
        '| rank | recommendation | action | why now | expected impact | confidence | next step |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| 1 | Add delivery visibility dashboard | add | repeated operator pain around webhook retries | faster incident triage | high | draft Gate B scope |',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(preflightDir, 'source-candidates.md'),
      [
        '# Source Candidates',
        '',
        '- Official reference: https://example.com/feature-radar/webhook-dashboard',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(preflightDir, 'p2a-context.json'),
      `${JSON.stringify({
        schema_version: 'feature_radar.p2a_context.v1',
        recommendations: [
          {
            title: 'Strengthen webhook retry observability',
            action: 'strengthen',
            why_now: 'The local project already has delivery tasks, and Radar found visibility gaps.',
            confidence: 'medium',
          },
        ],
        sources: [
          {
            title: 'Feature Radar webhook dashboard reference',
            url: 'https://example.com/feature-radar/webhook-dashboard',
            used_for: 'Grounded the visibility dashboard recommendation.',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
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

      const leadingDashRunNote = runRuns(['record', '--artifacts', artifactRoot, '--run-id', 'run-leading-dash-note', '--note', '--blocked-by-owner']);
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

      const leadingDashExecuteCommand = runExecute(['finish', '--artifacts', artifactRoot, '--run-id', 'run-leading-dash-command', '--test-command', '--version']);
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

      const crossCwdRoot = path.join(tempRoot, 'p2a-cross-cwd');
      const crossCwdGraphPath = path.join(crossCwdRoot, 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(crossCwdGraphPath), { recursive: true });
      writeFileSync(crossCwdGraphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
      result = runTasksFrom(crossCwdRoot, ['start', '--graph', 'gate-c-task-graph/task-graph.json', 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks cross-cwd start fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const crossCwdRunId = 'run-fixture-cross-cwd';
      result = runRunsFrom(crossCwdRoot, [
        'start',
        '--graph',
        'gate-c-task-graph/task-graph.json',
        '--task',
        'task-001',
        '--run-id',
        crossCwdRunId,
        '--agent-tool',
        'codex',
        '--workspace-ref',
        'cross-cwd',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs cross-cwd start fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRunsFrom(crossCwdRoot, [
        'verify',
        '--graph',
        'gate-c-task-graph/task-graph.json',
        '--run-id',
        crossCwdRunId,
        '--test-command',
        `"${process.execPath}" -e "process.exit(0)"`,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs cross-cwd verify fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      result = runRunsFrom(crossCwdRoot, ['finish', '--graph', 'gate-c-task-graph/task-graph.json', '--run-id', crossCwdRunId, '--status', 'finished']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs cross-cwd finish fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const crossCwdRun = JSON.parse(
        readFileSync(runFilePath(path.join(crossCwdRoot, 'runs'), crossCwdRunId), 'utf8'),
      );
      if (crossCwdRun.taskGraphRef !== realpathSync(crossCwdGraphPath).split(path.sep).join('/')) {
        console.error(`p2a_runs cross-cwd did not persist canonical taskGraphRef: ${caseData.id}`);
        console.error(JSON.stringify({ taskGraphRef: crossCwdRun.taskGraphRef, crossCwdGraphPath }, null, 2));
        return { status: 1, checks };
      }
      result = runTasks(['done', '--graph', crossCwdGraphPath, 'task-001']);
      checks += 1;
      const crossCwdDoneGraph = JSON.parse(readFileSync(crossCwdGraphPath, 'utf8'));
      if (
        result.status !== 0
        || !result.stdout.includes('task-001 status is now done')
        || crossCwdDoneGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'done'
      ) {
        console.error(`p2a_tasks cross-cwd done fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ crossCwdRun }, null, 2));
        return { status: failureStatus(result), checks };
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
        '--require-monitor',
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

      const executeRunsDir = path.join(tempRoot, 'p2a-execute', 'runs');
      const executeSidecarPath = runSidecarPath(executeRunsDir, 'run-execute-fixture', '.monitor-gate.json');
      const executeSidecar = JSON.parse(readFileSync(executeSidecarPath, 'utf8'));
      if (executeSidecar.runId !== 'run-execute-fixture' || executeSidecar.required !== true) {
        console.error(`p2a_execute start did not attach monitor gate sidecar: ${caseData.id}`);
        console.error(JSON.stringify({ executeSidecar }, null, 2));
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
      const executeIsolationRunsDir = path.join(tempRoot, 'p2a-execute-isolation', 'runs');
      const executeIsolationRun = JSON.parse(readFileSync(runFilePath(executeIsolationRunsDir, 'run-execute-create-worktree'), 'utf8'));
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
      const executeMonitorGraphPath = path.join(tempRoot, 'p2a-execute-monitor', 'gate-c-task-graph', 'task-graph.json');
      mkdirSync(path.dirname(executeMonitorGraphPath), { recursive: true });
      const executeMonitorGraph = JSON.parse(readFileSync(state.taskGraphPath, 'utf8'));
      const executeMonitorTask = executeMonitorGraph.tasks.find((task) => task.id === 'task-001');
      executeMonitorTask.targetArea = 'api+ui';
      executeMonitorTask.acceptanceCriteria.push('Monitor gate fixture coverage is recorded.');
      writeFileSync(executeMonitorGraphPath, `${JSON.stringify(executeMonitorGraph, null, 2)}\n`, 'utf8');
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
        '--require-monitor',
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

      const executeMonitorRunsDir = path.join(tempRoot, 'p2a-execute-monitor', 'runs');
      writeFileSync(runSidecarPath(executeMonitorRunsDir, 'run-execute-monitor-fixture', '.monitor-verdict.json'), JSON.stringify({ verdict: 'block', unmet_acceptance: ['Fixture unmet acceptance'] }, null, 2) + '\n', 'utf8');
      const executeMonitorProposalsDir = path.join(tempRoot, 'p2a-execute-monitor', 'proposals');
      const executeMonitorUpstreamProposalsDir = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposals');
      const proposalRunsDir = path.join(tempRoot, 'p2a-execute-monitor-proposal-runs');
      mkdirSync(proposalRunsDir, { recursive: true });
      const executeMonitorRunIndex = JSON.parse(readFileSync(path.join(executeMonitorRunsDir, 'run-index.json'), 'utf8'));
      const baseRunIndexEntry = executeMonitorRunIndex.runs.find((run) => run.runId === 'run-execute-monitor-fixture');
      const proposalRunPath = path.join(proposalRunsDir, baseRunIndexEntry.runRef);
      mkdirSync(path.dirname(proposalRunPath), { recursive: true });
      cpSync(runFilePath(executeMonitorRunsDir, 'run-execute-monitor-fixture'), proposalRunPath);
      cpSync(runSidecarPath(executeMonitorRunsDir, 'run-execute-monitor-fixture', '.monitor-gate.json'), path.join(proposalRunsDir, runSidecarRef(baseRunIndexEntry.runRef, '.monitor-gate.json')));
      cpSync(runSidecarPath(executeMonitorRunsDir, 'run-execute-monitor-fixture', '.monitor-verdict.json'), path.join(proposalRunsDir, runSidecarRef(baseRunIndexEntry.runRef, '.monitor-verdict.json')));
      const proposalRun = JSON.parse(readFileSync(proposalRunPath, 'utf8'));
      proposalRun.status = 'blocked';
      proposalRun.finishedAt = new Date().toISOString();
      proposalRun.updatedAt = proposalRun.finishedAt;
      proposalRun.failure = { class: 'implementation_incomplete', retryable: 'after_fix', needsUserDecision: false, source: 'monitor' };
      proposalRun.reproduction = { steps: ['fixture'], commands: [], notes: [] };
      proposalRun.localization = { findings: ['fixture'], files: [] };
      proposalRun.guard = { checks: ['fixture'], notes: [] };
      writeFileSync(proposalRunPath, `${JSON.stringify(proposalRun, null, 2)}\n`, 'utf8');
      baseRunIndexEntry.status = 'blocked';
      baseRunIndexEntry.finishedAt = proposalRun.finishedAt;
      writeFileSync(path.join(proposalRunsDir, 'run-index.json'), `${JSON.stringify({
        schema_version: 'p2a.run_index.v1',
        projectId: executeMonitorRunIndex.projectId,
        runs: [baseRunIndexEntry],
        tasks: [{
          taskId: 'task-001',
          runIds: ['run-execute-monitor-fixture'],
          latestRunId: 'run-execute-monitor-fixture',
        }],
      }, null, 2)}\n`, 'utf8');
      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        executeMonitorProposalsDir,
      ]);
      checks += 1;
      const proposalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 0 || !proposalOutput.includes('proposal-run-execute-monitor-fixture-implementation_incomplete')) {
        console.error(`p2a_proposals mine fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const executeMonitorProposalPath = path.join(executeMonitorProposalsDir, 'proposal-run-execute-monitor-fixture-implementation_incomplete.json');
      const executeMonitorProposal = JSON.parse(readFileSync(executeMonitorProposalPath, 'utf8'));
      if (
        executeMonitorProposal.sourceRunId !== 'run-execute-monitor-fixture'
        || executeMonitorProposal.status !== 'proposed'
        || executeMonitorProposal.target !== 'project'
        || executeMonitorProposal.quality?.score !== 100
        || executeMonitorProposal.quality?.band !== 'strong'
        || !executeMonitorProposal.riskRationale
      ) {
        console.error(`p2a_proposals mine wrote unexpected proposal: ${caseData.id}`);
        console.error(JSON.stringify({ executeMonitorProposal }, null, 2));
        return { status: 1, checks };
      }

      const upstreamProposalId = 'proposal-run-execute-monitor-fixture-implementation_incomplete-p2a_toolkit-p2a-harness';
      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--target',
        'p2a_toolkit',
        '--target-area',
        'p2a-harness',
        '--upstream-reason',
        'Fixture upstream proposal should be visible to the Plan2Agent toolkit.',
      ]);
      checks += 1;
      const upstreamProposalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status !== 0
        || !upstreamProposalOutput.includes('target: p2a_toolkit')
        || !upstreamProposalOutput.includes(upstreamProposalId)
      ) {
        console.error(`p2a_proposals upstream mine fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const upstreamProposalPath = path.join(executeMonitorUpstreamProposalsDir, `${upstreamProposalId}.json`);
      const upstreamProposal = JSON.parse(readFileSync(upstreamProposalPath, 'utf8'));
      if (
        upstreamProposal.proposalId !== upstreamProposalId
        || upstreamProposal.sourceRunId !== 'run-execute-monitor-fixture'
        || !existsSync(executeMonitorProposalPath)
        || existsSync(path.join(executeMonitorUpstreamProposalsDir, 'proposal-run-execute-monitor-fixture-implementation_incomplete.json'))
        || upstreamProposal.target !== 'p2a_toolkit'
        || upstreamProposal.targetRepo !== 'https://github.com/silbaram/plan2agent'
        || upstreamProposal.targetArea !== 'p2a-harness'
        || upstreamProposal.upstreamReason !== 'Fixture upstream proposal should be visible to the Plan2Agent toolkit.'
      ) {
        console.error(`p2a_proposals upstream proposal metadata fixture failed: ${caseData.id}`);
        console.error(JSON.stringify({ upstreamProposal }, null, 2));
        return { status: 1, checks };
      }

      const mixedTargetProposalsDir = path.join(tempRoot, 'p2a-execute-monitor', 'mixed-target-proposals');
      mkdirSync(mixedTargetProposalsDir, { recursive: true });
      cpSync(executeMonitorProposalPath, path.join(mixedTargetProposalsDir, path.basename(executeMonitorProposalPath)));
      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        mixedTargetProposalsDir,
        '--target',
        'p2a_toolkit',
        '--target-area',
        'p2a-harness',
        '--upstream-reason',
        'Fixture upstream proposal should coexist with the project-local proposal.',
      ]);
      checks += 1;
      const mixedProjectProposalPath = path.join(mixedTargetProposalsDir, path.basename(executeMonitorProposalPath));
      const mixedTargetProposalPath = path.join(mixedTargetProposalsDir, `${upstreamProposalId}.json`);
      const mixedTargetProposal = existsSync(mixedTargetProposalPath) ? JSON.parse(readFileSync(mixedTargetProposalPath, 'utf8')) : null;
      if (
        result.status !== 0
        || !existsSync(mixedProjectProposalPath)
        || mixedTargetProposal?.target !== 'p2a_toolkit'
        || mixedTargetProposal?.proposalId !== upstreamProposalId
      ) {
        console.error(`p2a_proposals project/upstream coexistence fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ mixedTargetProposal }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        path.join(tempRoot, 'p2a-execute-monitor', 'invalid-upstream-proposals'),
        '--target',
        'p2a_toolkit',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('--upstream-reason is required when --target is p2a_toolkit or companion_project')
      ) {
        console.error(`p2a_proposals upstream reason guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        path.join(tempRoot, 'p2a-execute-monitor', 'invalid-project-target-metadata'),
        '--target',
        'project',
        '--target-area',
        'p2a-harness',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('--target-repo, --target-area, and --upstream-reason require --target p2a_toolkit or --target companion_project')
      ) {
        console.error(`p2a_proposals project target metadata guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        path.join(tempRoot, 'p2a-execute-monitor', 'invalid-toolkit-repo-override'),
        '--target',
        'p2a_toolkit',
        '--target-repo',
        'https://github.com/example/other-toolkit',
        '--upstream-reason',
        'Fixture should reject overriding the fixed Plan2Agent toolkit repository.',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('--target-repo cannot override --target p2a_toolkit')
      ) {
        console.error(`p2a_proposals toolkit repo override guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runProposals([
        'digest',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('byTarget: {"p2a_toolkit":1}')
      ) {
        console.error(`p2a_proposals upstream digest fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runProposals([
        'list',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('proposalId\tstatus\trisk\ttarget\tsourceRunId\tproblem')
        || !result.stdout.includes('p2a_toolkit')
      ) {
        console.error(`p2a_proposals upstream list fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const upstreamReviewPath = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-review.json');
      result = runProposals([
        'review',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        upstreamReviewPath,
      ]);
      checks += 1;
      const upstreamReview = existsSync(upstreamReviewPath) ? JSON.parse(readFileSync(upstreamReviewPath, 'utf8')) : null;
      if (
        result.status !== 0
        || upstreamReview?.groups?.[0]?.target !== 'p2a_toolkit'
        || upstreamReview?.groups?.[0]?.targetRepo !== 'https://github.com/silbaram/plan2agent'
        || upstreamReview?.groups?.[0]?.targetArea !== 'p2a-harness'
      ) {
        console.error(`p2a_proposals upstream review fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamReview }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const upstreamCurationPath = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-curation.json');
      result = runProposals([
        'curate',
        '--review',
        upstreamReviewPath,
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        upstreamCurationPath,
      ]);
      checks += 1;
      const upstreamCuration = existsSync(upstreamCurationPath) ? JSON.parse(readFileSync(upstreamCurationPath, 'utf8')) : null;
      const upstreamCandidate = upstreamCuration?.candidates?.[0] ?? null;
      if (
        result.status !== 0
        || upstreamCandidate?.target !== 'p2a_toolkit'
        || upstreamCandidate?.targetRepo !== 'https://github.com/silbaram/plan2agent'
        || upstreamCandidate?.targetArea !== 'p2a-harness'
      ) {
        console.error(`p2a_proposals upstream curation fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamCuration }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const upstreamPatchDraftPath = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-patch-draft.json');
      result = runProposals([
        'draft-patch',
        '--curation',
        upstreamCurationPath,
        '--candidate-id',
        upstreamCandidate.candidateId,
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        upstreamPatchDraftPath,
      ]);
      checks += 1;
      const upstreamPatchDraft = existsSync(upstreamPatchDraftPath) ? JSON.parse(readFileSync(upstreamPatchDraftPath, 'utf8')) : null;
      if (
        result.status !== 0
        || upstreamPatchDraft?.target !== 'p2a_toolkit'
        || upstreamPatchDraft?.targetRepo !== 'https://github.com/silbaram/plan2agent'
        || upstreamPatchDraft?.targetArea !== 'p2a-harness'
      ) {
        console.error(`p2a_proposals upstream patch draft fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamPatchDraft }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const upstreamApprovalPath = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-draft-approval.json');
      const upstreamApprovalGuardArtifactRoot = path.join(tempRoot, 'p2a-execute-monitor-upstream-approval-guard-artifacts');
      cpSync(artifactRoot, upstreamApprovalGuardArtifactRoot, { recursive: true });
      result = runProposals([
        'approve-draft',
        '--draft',
        upstreamPatchDraftPath,
        '--artifacts',
        upstreamApprovalGuardArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture upstream approval',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-draft-approval-guard.json'),
      ]);
      checks += 1;
      const upstreamApprovalGuardGraphPath = path.join(upstreamApprovalGuardArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      if (
        result.status === 0
        || !result.stderr.includes('approve-draft refuses to append a local maintenance task for target p2a_toolkit')
        || existsSync(upstreamApprovalGuardGraphPath)
      ) {
        console.error(`p2a_proposals upstream local-task guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamApprovalGuardGraphExists: existsSync(upstreamApprovalGuardGraphPath) }, null, 2));
        return { status: 1, checks };
      }

      const upstreamApprovalArtifactRoot = path.join(tempRoot, 'p2a-execute-monitor-upstream-approval-artifacts');
      cpSync(artifactRoot, upstreamApprovalArtifactRoot, { recursive: true });
      result = runProposals([
        'approve-draft',
        '--draft',
        upstreamPatchDraftPath,
        '--artifacts',
        upstreamApprovalArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture upstream approval',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        upstreamApprovalPath,
        '--allow-local-upstream-task',
      ]);
      checks += 1;
      const upstreamApproval = existsSync(upstreamApprovalPath) ? JSON.parse(readFileSync(upstreamApprovalPath, 'utf8')) : null;
      const upstreamMaintenanceGraphPath = path.join(upstreamApprovalArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      const upstreamMaintenanceGraph = existsSync(upstreamMaintenanceGraphPath) ? JSON.parse(readFileSync(upstreamMaintenanceGraphPath, 'utf8')) : null;
      const upstreamMaintenanceTask = upstreamMaintenanceGraph?.tasks?.find((task) => task.id === upstreamApproval?.maintenanceTask?.taskId);
      if (
        result.status !== 0
        || upstreamApproval?.target !== 'p2a_toolkit'
        || upstreamApproval?.targetRepo !== 'https://github.com/silbaram/plan2agent'
        || upstreamApproval?.targetArea !== 'p2a-harness'
        || upstreamMaintenanceTask?.targetArea !== 'upstream:p2a-harness'
        || !upstreamMaintenanceTask?.sourceSpecRefs?.includes('proposal-target:p2a_toolkit')
        || !upstreamMaintenanceTask?.sourceSpecRefs?.includes('proposal-target-repo:https://github.com/silbaram/plan2agent')
        || !upstreamMaintenanceTask?.sourceSpecRefs?.includes('proposal-target-area:p2a-harness')
        || !upstreamMaintenanceTask?.description?.includes('Target: p2a_toolkit')
      ) {
        console.error(`p2a_proposals upstream approval fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamApproval, upstreamMaintenanceTask }, null, 2));
        return { status: failureStatus(result), checks };
      }

      const staleApprovalArtifactRoot = path.join(tempRoot, 'p2a-execute-monitor-upstream-stale-approval-artifacts');
      cpSync(artifactRoot, staleApprovalArtifactRoot, { recursive: true });
      const staleApprovalPath = path.join(tempRoot, 'p2a-execute-monitor', 'upstream-proposal-draft-approval-stale-refs.json');
      const staleApproval = JSON.parse(JSON.stringify(upstreamApproval));
      staleApproval.maintenanceTask.sourceSpecRefs = staleApproval.maintenanceTask.sourceSpecRefs
        .filter((ref) => !ref.startsWith('proposal-classification:'));
      writeFileSync(staleApprovalPath, `${JSON.stringify(staleApproval, null, 2)}\n`, 'utf8');
      result = runProposals([
        'approve-draft',
        '--draft',
        upstreamPatchDraftPath,
        '--artifacts',
        staleApprovalArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture upstream approval',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        staleApprovalPath,
        '--allow-local-upstream-task',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('maintenanceTask.sourceSpecRefs')
      ) {
        console.error(`p2a_proposals stale approval ref guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      upstreamMaintenanceTask.sourceSpecRefs = upstreamMaintenanceTask.sourceSpecRefs
        .filter((ref) => !ref.startsWith('proposal-target'));
      upstreamMaintenanceTask.targetArea = 'maintenance';
      upstreamMaintenanceTask.description = upstreamMaintenanceTask.description.replace(' Target: p2a_toolkit repo=https://github.com/silbaram/plan2agent area=p2a-harness.', '');
      upstreamMaintenanceTask.suggestedAgentPrompt = upstreamMaintenanceTask.suggestedAgentPrompt.replace('\nTarget: p2a_toolkit repo=https://github.com/silbaram/plan2agent area=p2a-harness', '');
      writeFileSync(upstreamMaintenanceGraphPath, `${JSON.stringify(upstreamMaintenanceGraph, null, 2)}\n`, 'utf8');
      result = runExecute([
        'plan',
        '--artifacts',
        upstreamApprovalArtifactRoot,
        '--approval',
        upstreamApprovalPath,
        '--run-id',
        'run-upstream-approval-missing-target-refs',
        '--agent-tool',
        'codex',
        '--workspace',
        upstreamApprovalArtifactRoot,
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('proposal-target:p2a_toolkit')
      ) {
        console.error(`p2a_execute approval target ref guard fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runProposals([
        'approve-draft',
        '--draft',
        upstreamPatchDraftPath,
        '--artifacts',
        upstreamApprovalArtifactRoot,
        '--approved-by',
        'fixture-reviewer',
        '--approval-note',
        'Fixture upstream approval',
        '--proposals',
        executeMonitorUpstreamProposalsDir,
        '--output',
        upstreamApprovalPath,
        '--allow-local-upstream-task',
      ]);
      checks += 1;
      const upstreamMaintenanceGraphAfterBackfill = JSON.parse(readFileSync(upstreamMaintenanceGraphPath, 'utf8'));
      const upstreamMaintenanceTaskAfterBackfill = upstreamMaintenanceGraphAfterBackfill.tasks.find((task) => task.id === upstreamApproval.maintenanceTask.taskId);
      if (
        result.status !== 0
        || upstreamMaintenanceTaskAfterBackfill?.targetArea !== 'upstream:p2a-harness'
        || !upstreamMaintenanceTaskAfterBackfill?.sourceSpecRefs?.includes('proposal-target:p2a_toolkit')
        || !upstreamMaintenanceTaskAfterBackfill?.sourceSpecRefs?.includes('proposal-target-repo:https://github.com/silbaram/plan2agent')
        || !upstreamMaintenanceTaskAfterBackfill?.sourceSpecRefs?.includes('proposal-target-area:p2a-harness')
        || !upstreamMaintenanceTaskAfterBackfill?.suggestedAgentPrompt?.includes('Target: p2a_toolkit')
      ) {
        console.error(`p2a_proposals upstream existing task backfill fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ upstreamMaintenanceTaskAfterBackfill }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runValidator(['--proposal-draft-approval', upstreamApprovalPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`upstream proposal draft approval validator fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const invalidRunId = 'run-execute-monitor-invalid';
      const proposalRunIndexPath = path.join(proposalRunsDir, 'run-index.json');
      const proposalRunIndex = JSON.parse(readFileSync(proposalRunIndexPath, 'utf8'));
      proposalRunIndex.runs.push({
        ...baseRunIndexEntry,
        runId: invalidRunId,
        runRef: `${invalidRunId}.json`,
        status: 'finished',
      });
      const proposalTaskIndex = proposalRunIndex.tasks.find((task) => task.taskId === 'task-001');
      proposalTaskIndex.runIds.push(invalidRunId);
      proposalTaskIndex.latestRunId = invalidRunId;
      writeFileSync(proposalRunIndexPath, `${JSON.stringify(proposalRunIndex, null, 2)}\n`, 'utf8');
      writeFileSync(path.join(proposalRunsDir, `${invalidRunId}.json`), `{"schema_version":"p2a.run.v1","runId":"${invalidRunId}"}\n`, 'utf8');

      result = runProposals([
        'mine',
        '--runs',
        proposalRunsDir,
        '--proposals',
        executeMonitorProposalsDir,
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
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent proposal digest')
        || !result.stdout.includes('quality: average=100 strong=1 medium=0 weak=0 needsAttention=0')
      ) {
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
        || executeMonitorReview.summary.quality?.averageScore !== 100
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
        || executeMonitorCuration.summary.quality?.averageScore !== 100
        || executeMonitorImplementationCandidate?.readiness !== 'watch'
        || executeMonitorImplementationCandidate?.quality?.band !== 'strong'
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

      const executeMonitorApprovalPath = path.join(tempRoot, 'p2a execute monitor', 'proposal-draft-approval.json');
      const executeMonitorApprovalArtifactRoot = path.join(tempRoot, 'p2a execute monitor approval artifacts');
      cpSync(artifactRoot, executeMonitorApprovalArtifactRoot, { recursive: true });
      const quotedExecuteMonitorApprovalArtifactRoot = shellQuote(normalizeFixturePath(executeMonitorApprovalArtifactRoot));
      const quotedExecuteMonitorApprovalPath = shellQuote(normalizeFixturePath(executeMonitorApprovalPath));
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
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent proposal draft approval')
        || !result.stdout.includes('next commands:')
        || !result.stdout.includes('node scripts/p2a.mjs tasks prompt')
        || !result.stdout.includes('node scripts/p2a.mjs execute start')
        || !result.stdout.includes('--approval')
        || !result.stdout.includes(`--artifacts ${quotedExecuteMonitorApprovalArtifactRoot}`)
        || !result.stdout.includes(`--approval ${quotedExecuteMonitorApprovalPath}`)
      ) {
        console.error(`p2a_proposals approve-draft fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

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
        path.join(tempRoot, 'p2a-execute-monitor', 'proposal-draft-approval-dry-run.json'),
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('next commands: dry-run only')
        || result.stdout.includes('execute start')
      ) {
        console.error(`p2a_proposals approve-draft dry-run next command fixture failed: ${caseData.id}`);
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

      const executeApprovedRunPath = runFilePath(path.join(executeMonitorApprovalArtifactRoot, 'runs'), 'run-approved-proposal-fixture');
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
      const executeFinishTraceRunPath = runFilePath(
        path.join(executeFinishTraceArtifactRoot, 'runs'),
        executeFinishTraceRunId,
      );
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
      const executeSkippedRun = JSON.parse(readFileSync(runFilePath(path.join(tempRoot, 'p2a-execute-not-in-progress', 'runs'), 'run-execute-fixture-not-in-progress'), 'utf8'));
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
      const collectGitRun = JSON.parse(readFileSync(runFilePath(runsDir, collectGitRunId), 'utf8'));
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
      const isolationRun = JSON.parse(readFileSync(runFilePath(runsDir, isolationRunId), 'utf8'));
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
        || !doneTodoOutput.includes('task-001 is done; use todo task-001 --reopen --note <reason> to reopen it explicitly')
      ) {
        console.error(`p2a_tasks allowed todo from done state without reopen: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      result = runTasks(['todo', '--graph', doneTransitionGraphPath, 'task-001', '--reopen']);
      checks += 1;
      const reopenNoNoteOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !reopenNoNoteOutput.includes('task-001 reopen requires --note <reason>')
      ) {
        console.error(`p2a_tasks allowed reopen without note: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      doneTransitionGraph.tasks.find((task) => task.id === 'task-002').status = 'in_progress';
      doneTransitionGraph.tasks.find((task) => task.id === 'task-002').dependencies = ['task-001'];
      writeFileSync(doneTransitionGraphPath, `${JSON.stringify(doneTransitionGraph, null, 2)}\n`, 'utf8');
      result = runTasks(['todo', '--graph', doneTransitionGraphPath, 'task-001', '--reopen', '--note', 'Regression found after done.']);
      checks += 1;
      const reopenDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const reopenedGraph = JSON.parse(readFileSync(doneTransitionGraphPath, 'utf8'));
      const reopenedTask = reopenedGraph.tasks.find((task) => task.id === 'task-001');
      if (
        result.status !== 0
        || !reopenDoneOutput.includes('warning: reopening task-001 while dependent task(s) are already in_progress/done: task-002:in_progress')
        || reopenedTask?.status !== 'todo'
        || reopenedTask?.blockNote !== 'Regression found after done.'
      ) {
        console.error(`p2a_tasks reopen fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ reopenedTask }, null, 2));
        return { status: failureStatus(result), checks };
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
      const doneGuardRunPath = runFilePath(doneGuardRunsDir, doneGuardRunId);
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

      const staleMissingGraphPath = copyWebhookTaskGraph(tempRoot, 'p2a-done-stale-missing-run');
      result = runTasks(['start', '--graph', staleMissingGraphPath, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks stale-missing run fixture start failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const staleMissingRunsDir = path.join(tempRoot, 'p2a-done-stale-missing-run', 'runs');
      const staleMissingTaskGraphRef = path.resolve(staleMissingGraphPath).split(path.sep).join('/');
      const staleMissingOldRun = finishedDoneGuardRun({
        runId: 'run-fixture-stale-missing-old',
        taskGraphRef: staleMissingTaskGraphRef,
        updatedAt: '2026-07-02T00:01:00.000Z',
        finishedAt: '2026-07-02T00:01:00.000Z',
      });
      const staleMissingLatestRun = finishedDoneGuardRun({
        runId: 'run-fixture-stale-missing-latest',
        taskGraphRef: staleMissingTaskGraphRef,
        updatedAt: '2026-07-02T00:06:00.000Z',
        finishedAt: '2026-07-02T00:06:00.000Z',
      });
      writeRunEvidenceSet(staleMissingRunsDir, 'task-001', [staleMissingOldRun, staleMissingLatestRun]);
      unlinkSync(path.join(staleMissingRunsDir, `${staleMissingOldRun.runId}.json`));
      result = runTasks(['done', '--graph', staleMissingGraphPath, 'task-001']);
      checks += 1;
      const staleMissingDoneOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const staleMissingGraph = JSON.parse(readFileSync(staleMissingGraphPath, 'utf8'));
      if (
        result.status !== 0
        || !staleMissingDoneOutput.includes(`warning: latest run ${staleMissingOldRun.runId} for task-001 is missing`)
        || staleMissingGraph.tasks.find((task) => task.id === 'task-001')?.status !== 'done'
      ) {
        console.error(`p2a_tasks stale missing old run fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ staleMissingOldRun, staleMissingLatestRun }, null, 2));
        return { status: failureStatus(result), checks };
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
      const timeoutRun = JSON.parse(
        readFileSync(
          runFilePath(path.join(tempRoot, 'p2a-verification-timeout', 'runs'), timeoutRunId),
          'utf8',
        ),
      );
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
      const fixtureRun = JSON.parse(readFileSync(runFilePath(runsDir, fixtureRunId), 'utf8'));
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

      writeFeatureRadarPreflightFixture(artifactRoot);
      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated') || !result.stdout.includes('Feature Radar preflight')) {
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
      const draftIntake = JSON.parse(readFileSync(draftIntakePath, 'utf8'));
      if (
        !draftSpec.reference_reconnaissance
        || !draftSpec.reference_reconnaissance.candidates?.some((candidate) => candidate.candidate_id === 'REF-1')
        || !draftSpec.reference_reconnaissance.candidates?.every((candidate) => draftSpec.evidence.some((item) => item.source_id === candidate.source_id))
      ) {
        console.error(`iteration draft did not include valid Gate B reference reconnaissance: ${caseData.id}`);
        console.error(JSON.stringify(draftSpec.reference_reconnaissance ?? null, null, 2));
        return { status: 1, checks };
      }
      const radarSpecEvidence = draftSpec.evidence.filter((item) => item.title.startsWith('Feature Radar'));
      if (
        !draftIntake.known_facts.some((fact) => fact.includes('Feature Radar preflight research detected'))
        || !draftIntake.evidence.some((item) => item.title === 'Feature Radar next-iteration-recommendations.md')
        || !radarSpecEvidence.some((item) => item.title === 'Feature Radar next-iteration-recommendations.md')
        || !draftSpec.evidence.some((item) => item.source_id.startsWith('WEB-') && item.url === 'https://example.com/feature-radar/webhook-dashboard')
        || !draftSpec.reference_reconnaissance.candidates.some((candidate) => candidate.title.includes('Feature Radar: Add delivery visibility dashboard'))
        || !draftSpec.reference_reconnaissance.candidates.some((candidate) => candidate.origin === 'feature_radar_preflight')
        || draftSpec.product.goals.some((goal) => goal.includes('Feature Radar'))
      ) {
        console.error(`iteration draft did not consume Feature Radar preflight research: ${caseData.id}`);
        console.error(JSON.stringify({ intakeEvidence: draftIntake.evidence, specEvidence: draftSpec.evidence, reference: draftSpec.reference_reconnaissance, goals: draftSpec.product.goals }, null, 2));
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
      result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
      checks += 1;
      const unresolvedRadarOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !unresolvedRadarOutput.includes('approved spec must resolve Feature Radar candidate')) {
        console.error(`iteration promote-spec did not reject unresolved Feature Radar candidates: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      approvedDraftSpec.reference_reconnaissance.candidates = approvedDraftSpec.reference_reconnaissance.candidates.map((candidate) => (
        candidate.title.startsWith('Feature Radar:')
          ? {
              ...candidate,
              decision: 'deferred',
              rationale: `${candidate.rationale} Fixture Gate B explicitly deferred this Radar candidate to a later iteration.`,
            }
          : candidate
      ));
      approvedDraftSpec.approval_audit.approval_note = 'Fixture approved iter-002 Gate B draft after resolving Feature Radar candidates.';
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
      const iter2CanonicalBeforeReplacement = readFileSync(iter2TaskGraphPath, 'utf8');
      const originalSemanticTaskIds = iter2TaskGraph.tasks.map((task) => task.id);
      const startedReplacementGraph = JSON.parse(iter2CanonicalBeforeReplacement);
      startedReplacementGraph.tasks[0].status = 'in_progress';
      writeFileSync(iter2TaskGraphPath, `${JSON.stringify(startedReplacementGraph, null, 2)}\n`, 'utf8');
      result = runIteration(['diff-tasks', '--artifacts', artifactRoot, '--force']);
      checks += 1;
      const startedDiffOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !startedDiffOutput.includes('cannot replace a task graph after execution has started')
        || existsSync(iter2DraftPath)
      ) {
        console.error(`iteration diff-tasks --force did not protect non-todo task state: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(iter2TaskGraphPath, iter2CanonicalBeforeReplacement, 'utf8');

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

      const nonTodoPromotionGraph = JSON.parse(iter2CanonicalBeforeReplacement);
      nonTodoPromotionGraph.tasks[0].status = 'done';
      writeFileSync(iter2TaskGraphPath, `${JSON.stringify(nonTodoPromotionGraph, null, 2)}\n`, 'utf8');
      result = runIteration([
        'promote-tasks',
        '--artifacts',
        artifactRoot,
        '--replace-existing',
        '--approved-by',
        'user',
        '--approval-note',
        'Fixture must reject replacement after execution starts.',
      ]);
      checks += 1;
      const nonTodoPromotionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !nonTodoPromotionOutput.includes('cannot replace a canonical task graph after execution has started')
        || !existsSync(iter2DraftPath)
      ) {
        console.error(`iteration promote-tasks --replace-existing did not protect non-todo task state: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(iter2TaskGraphPath, iter2CanonicalBeforeReplacement, 'utf8');

      const replacementHistoryIndexPath = path.join(runsDir, 'run-index.json');
      const replacementHistoryIndexBefore = readFileSync(replacementHistoryIndexPath, 'utf8');
      const replacementHistoryIndex = JSON.parse(replacementHistoryIndexBefore);
      const replacementHistoryRunId = 'run-task-graph-replacement-history-fixture';
      const replacementHistoryTaskId = originalSemanticTaskIds[0];
      replacementHistoryIndex.runs.push({
        runId: replacementHistoryRunId,
        taskId: replacementHistoryTaskId,
        iterationId: 'iter-002',
        status: 'started',
        agentTool: 'codex',
        workspaceRef: 'replacement-history-fixture',
        taskGraphRef: 'iterations/iter-002/gate-c-task-graph/task-graph.json',
        runRef: `${replacementHistoryRunId}.json`,
        startedAt: '2026-07-11T00:00:00.000Z',
        finishedAt: null,
      });
      const replacementHistoryTaskEntry = replacementHistoryIndex.tasks.find((entry) => entry.taskId === replacementHistoryTaskId);
      if (replacementHistoryTaskEntry) {
        replacementHistoryTaskEntry.runIds.push(replacementHistoryRunId);
        replacementHistoryTaskEntry.latestRunId = replacementHistoryRunId;
      } else {
        replacementHistoryIndex.tasks.push({
          taskId: replacementHistoryTaskId,
          runIds: [replacementHistoryRunId],
          latestRunId: replacementHistoryRunId,
        });
      }
      writeFileSync(replacementHistoryIndexPath, `${JSON.stringify(replacementHistoryIndex, null, 2)}\n`, 'utf8');

      result = runIteration(['diff-tasks', '--artifacts', artifactRoot, '--force']);
      checks += 1;
      const historyDiffOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !historyDiffOutput.includes('diff-tasks --force cannot replace a task graph after execution history exists')
        || !existsSync(iter2DraftPath)
      ) {
        console.error(`iteration diff-tasks --force did not protect reopened todo task run lineage: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['promote-tasks', '--artifacts', artifactRoot, '--replace-existing']);
      checks += 1;
      const historyPromotionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !historyPromotionOutput.includes('promote-tasks --replace-existing cannot replace a task graph after execution history exists')
        || !existsSync(iter2DraftPath)
      ) {
        console.error(`iteration promote-tasks did not protect reopened todo task run lineage: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(replacementHistoryIndexPath, replacementHistoryIndexBefore, 'utf8');

	      result = runIteration(['promote-tasks', '--artifacts', artifactRoot, '--replace-existing']);
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
      const replaceExistingGuardOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !replaceExistingGuardOutput.includes('refusing to replace it with a potentially incremental-only draft')
        || readFileSync(iter2TaskGraphPath, 'utf8') !== iter2CanonicalBeforeReplacement
        || !existsSync(iter2DraftPath)
      ) {
        console.error(`iteration promote-tasks did not guard existing canonical graph: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

	      result = runIteration([
	        'promote-tasks',
	        '--artifacts',
        artifactRoot,
        '--replace-existing',
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

      result = runIteration(['context', '--artifacts', artifactRoot, '--scope', 'maintenance', '--code-root', '.']);
      checks += 1;
      const maintenanceContext = result.status === 0 ? JSON.parse(result.stdout) : null;
      if (
        result.status !== 0
        || maintenanceContext?.scope !== 'maintenance'
        || maintenanceContext?.active_iteration !== 'maintenance'
        || maintenanceContext?.spec_field_changes?.length !== 0
        || maintenanceContext?.existing_tasks?.maintenance?.length !== 2
      ) {
        console.error(`iteration context --scope maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ maintenanceContext }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['list', '--artifacts', artifactRoot, '--maintenance']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('id\tstatus\tready\ttarget\tsource\ttitle')
        || !result.stdout.includes('task-001')
        || !result.stdout.includes('task-002')
        || !result.stdout.includes('effective_product.problem')
      ) {
        console.error(`p2a_tasks list --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['ready', '--artifacts', artifactRoot, '--maintenance']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('id\tstatus\tready\ttarget\tsource\ttitle')
        || !result.stdout.includes('task-001')
      ) {
        console.error(`p2a_tasks ready --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTasks(['prompt', '--artifacts', artifactRoot, '--maintenance', 'task-001']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Maintenance execution context:')
        || !result.stdout.includes('Next commands:')
        || !result.stdout.includes('node scripts/p2a.mjs execute start')
        || !result.stdout.includes('--maintenance --task task-001')
      ) {
        console.error(`p2a_tasks prompt --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const spacedMaintenanceArtifactRoot = path.join(tempRoot, 'p2a maintenance ux root');
      cpSync(artifactRoot, spacedMaintenanceArtifactRoot, { recursive: true });
      const quotedSpacedMaintenanceArtifactRoot = shellQuote(normalizeFixturePath(spacedMaintenanceArtifactRoot));
      result = runTasks(['prompt', '--artifacts', spacedMaintenanceArtifactRoot, '--maintenance', 'task-001']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes(`--artifacts ${quotedSpacedMaintenanceArtifactRoot}`)
      ) {
        console.error(`p2a_tasks prompt --artifacts --maintenance quoted path fixture check failed: ${caseData.id}`);
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

      const emptyMaintenanceDraftArtifactRoot = path.join(tempRoot, 'p2a-empty-maintenance-draft-artifacts');
      cpSync(artifactRoot, emptyMaintenanceDraftArtifactRoot, { recursive: true });
      const emptyDraftMaintenanceGraphPath = path.join(emptyMaintenanceDraftArtifactRoot, 'iterations', 'maintenance', 'gate-c-task-graph', 'task-graph.json');
      rmSync(path.join(emptyMaintenanceDraftArtifactRoot, 'iterations', 'maintenance'), { recursive: true, force: true });
      const emptyMaintenanceDraftPath = path.join(tempRoot, 'p2a-empty-maintenance-draft.json');
      writeFileSync(emptyMaintenanceDraftPath, `${JSON.stringify({
        schema_version: 'p2a.eval_maintenance_draft.v1',
        draftId: 'eval-maintenance-draft-empty-fixture',
        generatedAt: '2026-01-01T00:00:00.000Z',
        summary: {
          clusters: 0,
          tasks: 0,
        },
        tasks: [],
        nextActions: ['No maintenance tasks were drafted because no failure clusters were found.'],
      }, null, 2)}\n`, 'utf8');

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        emptyMaintenanceDraftArtifactRoot,
        '--from-draft',
        emptyMaintenanceDraftPath,
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('- draft tasks: 0')
        || !result.stdout.includes('- appended: 0')
        || existsSync(emptyDraftMaintenanceGraphPath)
      ) {
        console.error(`iteration maintenance add --from-draft empty dry-run fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        emptyMaintenanceDraftArtifactRoot,
        '--from-draft',
        emptyMaintenanceDraftPath,
        '--yes',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('- draft tasks: 0')
        || !result.stdout.includes('- appended: 0')
        || existsSync(emptyDraftMaintenanceGraphPath)
      ) {
        console.error(`iteration maintenance add --from-draft empty apply fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const maintenanceFromDraftPath = path.join(tempRoot, 'p2a-maintenance-from-draft.json');
      writeFileSync(maintenanceFromDraftPath, `${JSON.stringify({
        schema_version: 'p2a.eval_maintenance_draft.v1',
        draftId: 'eval-maintenance-draft-fixture',
        generatedAt: '2026-01-01T00:00:00.000Z',
        summary: {
          clusters: 2,
          tasks: 2,
        },
        tasks: [
          {
            id: 'draft-maintenance-a',
            clusterId: 'cluster-maintenance-from-draft-a',
            title: 'Improve maintenance draft apply',
            description: 'Fixture task created from a reviewed maintenance draft.',
            acceptanceCriteria: ['Maintenance draft tasks can be appended after explicit confirmation.'],
            targetArea: 'verification',
            suggestedAgentPrompt: 'Append the reviewed maintenance draft task and preserve its trace refs.',
            sourceSpecRefs: [
              'eval-analysis:analysis-maintenance-from-draft',
              'eval-cluster:cluster-maintenance-from-draft-a',
              'run:run-maintenance-from-draft-a',
            ],
          },
          {
            id: 'draft-maintenance-b',
            clusterId: 'cluster-maintenance-from-draft-b',
            title: 'Run maintenance draft follow-up',
            acceptanceCriteria: ['Draft-local dependencies are mapped to appended maintenance task ids.'],
            sourceSpecRefs: ['eval-cluster:cluster-maintenance-from-draft-b'],
            dependencies: ['draft-maintenance-a'],
          },
        ],
        nextActions: ['Review before applying.'],
      }, null, 2)}\n`, 'utf8');

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--from-draft',
        maintenanceFromDraftPath,
      ]);
      checks += 1;
      if (
        result.status === 0
        || !(`${result.stdout ?? ''}${result.stderr ?? ''}`).includes('maintenance add --from-draft requires --yes unless --dry-run is used')
        || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterAddsText
      ) {
        console.error(`iteration maintenance add --from-draft confirmation guard failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--from-draft',
        maintenanceFromDraftPath,
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent maintenance draft dry run:')
        || !result.stdout.includes('- appended: 2')
        || !result.stdout.includes('- append task-003: Improve maintenance draft apply')
        || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterAddsText
      ) {
        console.error(`iteration maintenance add --from-draft dry-run fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--from-draft',
        maintenanceFromDraftPath,
        '--yes',
      ]);
      checks += 1;
      const maintenanceGraphAfterDraftText = readFileSync(maintenanceGraphPath, 'utf8');
      const maintenanceGraphAfterDraft = JSON.parse(maintenanceGraphAfterDraftText);
      const draftTaskA = maintenanceGraphAfterDraft.tasks.find((task) => task.id === 'task-003');
      const draftTaskB = maintenanceGraphAfterDraft.tasks.find((task) => task.id === 'task-004');
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent maintenance draft applied:')
        || !result.stdout.includes('- appended: 2')
        || maintenanceGraphAfterDraft.tasks?.length !== 4
        || draftTaskA?.targetArea !== 'verification'
        || !draftTaskA?.sourceSpecRefs?.includes('eval-cluster:cluster-maintenance-from-draft-a')
        || JSON.stringify(draftTaskB?.dependencies) !== JSON.stringify(['task-003'])
      ) {
        console.error(`iteration maintenance add --from-draft apply fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        console.error(JSON.stringify({ draftTaskA, draftTaskB }, null, 2));
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--from-draft',
        maintenanceFromDraftPath,
        '--yes',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('- appended: 0')
        || !result.stdout.includes('- skipped: 2')
        || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterDraftText
      ) {
        console.error(`iteration maintenance add --from-draft duplicate skip fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--title',
        'Track legacy proposal maintenance',
        '--accept',
        'Legacy proposal refs are tracked without duplicate draft append.',
        '--ref',
        'proposal:legacy-maintenance-from-draft',
      ]);
      checks += 1;
      const maintenanceGraphAfterLegacyProposalText = readFileSync(maintenanceGraphPath, 'utf8');
      if (
        result.status !== 0
        || !result.stdout.includes('Plan2Agent maintenance task added: task-005')
        || JSON.parse(maintenanceGraphAfterLegacyProposalText).tasks?.length !== 5
      ) {
        console.error(`iteration maintenance legacy proposal setup failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const maintenanceLegacyProposalDraftPath = path.join(tempRoot, 'p2a-maintenance-legacy-proposal-draft.json');
      writeFileSync(maintenanceLegacyProposalDraftPath, `${JSON.stringify({
        schema_version: 'p2a.eval_maintenance_draft.v1',
        draftId: 'eval-maintenance-draft-legacy-proposal-fixture',
        generatedAt: '2026-01-01T00:00:00.000Z',
        summary: {
          clusters: 1,
          tasks: 1,
        },
        tasks: [
          {
            clusterId: 'cluster-maintenance-legacy-proposal',
            title: 'Avoid duplicate legacy proposal maintenance',
            acceptanceCriteria: ['Legacy proposal refs are deduped when importing maintenance drafts.'],
            sourceSpecRefs: ['proposal:legacy-maintenance-from-draft'],
          },
        ],
        nextActions: ['Review before applying.'],
      }, null, 2)}\n`, 'utf8');

      result = runIteration([
        'maintenance',
        'add',
        '--artifacts',
        artifactRoot,
        '--from-draft',
        maintenanceLegacyProposalDraftPath,
        '--yes',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('- appended: 0')
        || !result.stdout.includes('- skipped: 1')
        || !result.stdout.includes('proposal:legacy-maintenance-from-draft already tracked by task-005')
        || readFileSync(maintenanceGraphPath, 'utf8') !== maintenanceGraphAfterLegacyProposalText
      ) {
        console.error(`iteration maintenance add --from-draft legacy proposal duplicate skip fixture failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--audit-archive']);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes('archived audit: 2 closed iteration(s) verified')
        || !result.stdout.includes('maintenance: 5 task(s) valid')
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

      const milestoneHandoffArtifactRoot = path.join(tempRoot, 'milestone-handoff-artifacts');
      cpSync(artifactRoot, milestoneHandoffArtifactRoot, { recursive: true });
      const milestoneTaskGraphRef = 'iterations/iter-002/gate-c-task-graph/task-graph.json';
      const milestoneSpecRef = 'iterations/iter-002/gate-b-spec/spec.json';
      const milestoneTaskGraphPath = path.join(milestoneHandoffArtifactRoot, milestoneTaskGraphRef);
      const milestoneTaskGraph = JSON.parse(readFileSync(milestoneTaskGraphPath, 'utf8'));
      for (const task of milestoneTaskGraph.tasks) task.status = 'done';
      const milestoneTaskGraphText = `${JSON.stringify(milestoneTaskGraph, null, 2)}\n`;
      writeFileSync(milestoneTaskGraphPath, milestoneTaskGraphText, 'utf8');

      const milestoneRunsDir = path.join(milestoneHandoffArtifactRoot, 'runs');
      rmSync(milestoneRunsDir, { recursive: true, force: true });
      mkdirSync(milestoneRunsDir, { recursive: true });
      const milestoneRunStartedAt = '2026-07-11T00:00:00.000Z';
      const milestoneRunFinishedAt = '2026-07-11T00:01:00.000Z';
      const milestoneGeneratedAt = '2026-07-11T00:02:00.000Z';
      const milestoneRunIndexEntries = [];
      const milestoneRunIndexTasks = [];
      const milestoneCompletedTaskEvidence = [];
      for (const task of milestoneTaskGraph.tasks) {
        const runId = `run-milestone-${task.id}`;
        const changedFiles = [`src/${task.id}.mjs`];
        const verification = [{
          type: 'test',
          command: `node --test ${task.id}`,
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }];
        const run = {
          schema_version: 'p2a.run.v1',
          runId,
          projectId: caseData.project_id,
          taskId: task.id,
          taskTitle: task.title,
          iterationId: 'iter-002',
          sourceLayout: 'iteration',
          taskGraphRef: milestoneTaskGraphRef,
          sourceSpecRef: milestoneTaskGraph.sourceSpec,
          agentTool: 'codex',
          workspaceRef: 'milestone-handoff-fixture',
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
          status: 'finished',
          startedAt: milestoneRunStartedAt,
          updatedAt: milestoneRunFinishedAt,
          finishedAt: milestoneRunFinishedAt,
          changedFiles,
          verification,
          notes: ['Synthetic milestone handoff evidence.'],
        };
        const runText = `${JSON.stringify(run, null, 2)}\n`;
        writeFileSync(path.join(milestoneRunsDir, `${runId}.json`), runText, 'utf8');
        milestoneRunIndexEntries.push({
          runId,
          taskId: task.id,
          iterationId: 'iter-002',
          status: 'finished',
          agentTool: 'codex',
          workspaceRef: 'milestone-handoff-fixture',
          taskGraphRef: milestoneTaskGraphRef,
          runRef: `${runId}.json`,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
        });
        milestoneRunIndexTasks.push({ taskId: task.id, runIds: [runId], latestRunId: runId });
        milestoneCompletedTaskEvidence.push({
          task_id: task.id,
          task_title: task.title,
          run_id: runId,
          run_ref: `runs/${runId}.json`,
          run_sha256: hashText(runText),
          run_snapshot: run,
          run_snapshot_sha256: hashText(JSON.stringify(run)),
          run_finished_at: milestoneRunFinishedAt,
          changed_files: changedFiles,
          verification: verification.map((item) => ({
            type: item.type,
            command: item.command,
            status: item.status,
            exit_code: item.exitCode,
            source: item.source,
          })),
        });
      }
      writeFileSync(path.join(milestoneRunsDir, 'run-index.json'), `${JSON.stringify({
        schema_version: 'p2a.run_index.v1',
        projectId: caseData.project_id,
        runs: milestoneRunIndexEntries,
        tasks: milestoneRunIndexTasks,
      }, null, 2)}\n`, 'utf8');

      const sourceMilestoneReviewDir = path.join(milestoneHandoffArtifactRoot, 'iterations', 'iter-002', 'milestone-reviews');
      const sourcePreCloseReviewPath = path.join(sourceMilestoneReviewDir, 'pre_close.json');
      const sourceMidpointDraftPath = path.join(sourceMilestoneReviewDir, 'midpoint.fixture.draft.json');
      mkdirSync(sourceMilestoneReviewDir, { recursive: true });
      writeFileSync(sourcePreCloseReviewPath, `${JSON.stringify({
        schema_version: 'p2a.milestone_review.v1',
        project_id: caseData.project_id,
        iteration_id: 'iter-002',
        checkpoint: 'pre_close',
        generated_at: milestoneGeneratedAt,
        source: {
          task_graph_ref: milestoneTaskGraphRef,
          task_graph_sha256: hashText(milestoneTaskGraphText),
          task_graph_snapshot: milestoneTaskGraph,
          task_graph_snapshot_sha256: hashText(JSON.stringify(milestoneTaskGraph)),
          spec_ref: milestoneSpecRef,
          style_ref: null,
          task_counts: {
            total: milestoneTaskGraph.tasks.length,
            done: milestoneTaskGraph.tasks.length,
            todo: 0,
            in_progress: 0,
            blocked: 0,
          },
          task_snapshot: milestoneTaskGraph.tasks.map((task) => ({
            task_id: task.id,
            task_title: task.title,
            status: task.status,
          })),
          completed_task_evidence: milestoneCompletedTaskEvidence,
          remaining_task_ids: [],
        },
        confirmed_findings: [],
        planned_todo_not_findings: [],
        note: 'Legacy handoff persistence fixture.',
      }, null, 2)}\n`, 'utf8');
      writeFileSync(sourceMidpointDraftPath, `${JSON.stringify({
        schema_version: 'p2a.milestone_review.v1',
        checkpoint: 'midpoint',
        note: 'Draft milestone reviews must not be handed off.',
      }, null, 2)}\n`, 'utf8');

      result = runValidator(['--milestone-review', sourcePreCloseReviewPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`source milestone handoff bundle validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const iterationDryRunTargetRoot = path.join(tempRoot, 'target-iteration-dry-run');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        milestoneHandoffArtifactRoot,
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
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/iterations/iter-002/milestone-reviews/pre_close.json`)
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/runs/run-index.json`)
        || result.stdout.includes('midpoint.fixture.draft.json')
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
        milestoneHandoffArtifactRoot,
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
      const targetPreflightPath = path.join(iterationTargetArtifactRoot, 'preflight-research', 'next-iteration-recommendations.md');
      const targetPreCloseReviewRelative = `.plan2agent/artifacts/${caseData.project_id}/iterations/iter-002/milestone-reviews/pre_close.json`;
      const targetPreCloseReviewPath = path.join(iterationTargetRoot, targetPreCloseReviewRelative);
      const targetMidpointDraftPath = path.join(iterationTargetArtifactRoot, 'iterations', 'iter-002', 'milestone-reviews', 'midpoint.fixture.draft.json');
      const expectedMilestoneEvidenceFiles = [
        milestoneTaskGraphRef,
        milestoneSpecRef,
        'iterations/iter-002/gate-a-intake/intake.json',
        'runs/run-index.json',
        ...milestoneRunIndexEntries.map((entry) => `runs/${entry.runId}.json`),
      ].map((filePath) => `.plan2agent/artifacts/${caseData.project_id}/${filePath}`);
      const targetMaintenanceGraphPath = path.join(iterationTargetRoot, '.plan2agent', 'maintenance', 'task-graph.json');
      if (
        !existsSync(targetCurrentSpecPath)
        || !existsSync(targetSpecPath)
        || !existsSync(targetIntakePath)
        || !existsSync(targetPreflightPath)
        || !existsSync(targetPreCloseReviewPath)
        || existsSync(targetMidpointDraftPath)
        || !existsSync(targetMaintenanceGraphPath)
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_radar_preflight.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_execute.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_monitor_gate.mjs'))
        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'))
	        || !existsSync(path.join(iterationTargetRoot, '.plan2agent', 'schemas', 'run-index.schema.json'))
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
      const sourceCurrentSpecAfterHandoff = JSON.parse(readFileSync(path.join(milestoneHandoffArtifactRoot, 'current-spec.json'), 'utf8'));
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
        || !targetManifest.includedTools.includes('p2a_radar_preflight')
        || !targetManifest.includedTools.includes('p2a_runs')
        || !targetManifest.includedTools.includes('p2a_execute')
        || !targetManifest.includedTools.includes('p2a_monitor_gate')
        || !targetManifest.includedTools.includes('p2a_proposals')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_runs.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_constants.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_radar_preflight.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_execute.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_monitor_gate.mjs')
        || !targetManifest.toolFiles.includes('.plan2agent/scripts/p2a_proposals.mjs')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/task-context.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/run-index.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/skill-proposal.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-review.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-curation.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-patch-draft.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/proposal-draft-approval.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-index.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-digest.schema.json')
	        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-draft.schema.json')
        || !targetManifest.schemaFiles.includes('.plan2agent/schemas/eval-maintenance-apply-report.schema.json')
        || !targetManifest.preflightResearchFiles?.includes(`.plan2agent/artifacts/${caseData.project_id}/preflight-research/next-iteration-recommendations.md`)
	        || JSON.stringify(targetManifest.milestoneReviewFiles) !== JSON.stringify([targetPreCloseReviewRelative])
	        || expectedMilestoneEvidenceFiles.some((filePath) => !targetManifest.milestoneEvidenceFiles?.includes(filePath))
	        || targetManifest.milestoneEvidenceFiles?.length !== expectedMilestoneEvidenceFiles.length
	        || !targetManifest.artifactFiles.includes(targetPreCloseReviewRelative)
	        || expectedMilestoneEvidenceFiles.some((filePath) => !targetManifest.artifactFiles.includes(filePath))
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

      result = runTargetP2a(iterationTargetRoot, ['validate', '--milestone-review', targetPreCloseReviewPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target milestone evidence bundle validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

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
      approvedIter3Spec.reference_reconnaissance.candidates = approvedIter3Spec.reference_reconnaissance.candidates.map((candidate) => (
        candidate.title.startsWith('Feature Radar:')
          ? {
              ...candidate,
              decision: 'selected',
              rationale: `${candidate.rationale} Fixture Gate B explicitly accepted this Radar candidate for the composed-baseline iteration.`,
            }
          : candidate
      ));
      approvedIter3Spec.approval_audit = {
        approved_by: 'user',
        approved_at: '2026-06-15',
        approved_artifacts: ['iterations/iter-003/gate-b-spec/spec.json'],
        approval_note: 'Fixture approved iter-003 Gate B draft after resolving Feature Radar candidates.',
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

      const taskAuthorContract = readFileSync(path.join(ROOT, '.agents', 'agents', 'p2a-task-author.md'), 'utf8');
      const requiredTaskAuthorContractFragments = [
        '`schema_version: "p2a.task_graph.v1"`',
        'map `projectId` exactly from `context.project_id`',
        '`tasks` array',
        ...['id', 'title', 'description', 'status', 'dependencies', 'acceptanceCriteria', 'targetArea', 'suggestedAgentPrompt', 'sourceSpecRefs']
          .map((field) => `\`${field}\``),
        '`diff-tasks --force`',
        '`promote-tasks --replace-existing`',
      ];
      const missingTaskAuthorContractFragments = requiredTaskAuthorContractFragments
        .filter((fragment) => !taskAuthorContract.includes(fragment));
      checks += 1;
      if (missingTaskAuthorContractFragments.length) {
        console.error(`task-author agent schema/safe-replacement contract fixture check failed: ${caseData.id}`);
        console.error(JSON.stringify({ missingTaskAuthorContractFragments }, null, 2));
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

      const preExecutedIter3Draft = JSON.parse(JSON.stringify(iter3Draft));
      preExecutedIter3Draft.tasks[0].status = 'done';
      writeFileSync(iter3DraftPath, `${JSON.stringify(preExecutedIter3Draft, null, 2)}\n`, 'utf8');
      result = runIteration([
        'promote-tasks',
        '--artifacts',
        artifactRoot,
        '--approved-by',
        'user',
        '--approval-note',
        'Fixture must reject a draft that fabricates execution status.',
      ]);
      checks += 1;
      const preExecutedDraftOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !preExecutedDraftOutput.includes('Gate C draft tasks must all start as todo')
        || existsSync(iter3TaskGraphPath)
        || !existsSync(iter3DraftPath)
      ) {
        console.error(`iteration promote-tasks accepted pre-executed draft task state: ${caseData.id}`);
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


function runNodeTestFile(testFile) {
  return spawnSync(process.execPath, ['--test', testFile], { cwd: ROOT, encoding: 'utf8' });
}

function countNodeTestCases(stdout) {
  const match = stdout.match(/^# tests (\d+)$/m);
  return match ? Number(match[1]) : 0;
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

  const schemaResult = runNodeTestFile('tests/schema-fixtures.test.mjs');
  writeResultOutput(schemaResult);
  if (schemaResult.status !== 0) return failureStatus(schemaResult);

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

  const e2eResult = runNodeTestFile('tests/e2e-artifact-root.test.mjs');
  writeResultOutput(e2eResult);
  if (e2eResult.status !== 0) return failureStatus(e2eResult);

  let iterationResult;
  try {
    iterationResult = validateIterationCurrentFixtureCases();
  } catch (error) {
    console.error(`fixture validation failed: ${error.message}`);
    return 1;
  }
  if (iterationResult.status !== 0) return iterationResult.status;

  const negativeResult = runNodeTestFile('tests/negative-fixtures.test.mjs');
  writeResultOutput(negativeResult);
  if (negativeResult.status !== 0) return failureStatus(negativeResult);

  const projectConfigDetectionResult = runNodeTestFile('tests/project-config-detection.test.mjs');
  writeResultOutput(projectConfigDetectionResult);
  if (projectConfigDetectionResult.status !== 0) return failureStatus(projectConfigDetectionResult);

  const runIdStrategyResult = runNodeTestFile('tests/run-id-strategy.test.mjs');
  writeResultOutput(runIdStrategyResult);
  if (runIdStrategyResult.status !== 0) return failureStatus(runIdStrategyResult);

  const runLayoutResult = runNodeTestFile('tests/run-layout.test.mjs');
  writeResultOutput(runLayoutResult);
  if (runLayoutResult.status !== 0) return failureStatus(runLayoutResult);

  const evalStableMetricsResult = runNodeTestFile('tests/eval-stable-metrics.test.mjs');
  writeResultOutput(evalStableMetricsResult);
  if (evalStableMetricsResult.status !== 0) return failureStatus(evalStableMetricsResult);

  const verificationRunnerUtilsResult = runNodeTestFile('tests/verification-runner-utils.test.mjs');
  writeResultOutput(verificationRunnerUtilsResult);
  if (verificationRunnerUtilsResult.status !== 0) return failureStatus(verificationRunnerUtilsResult);

  const milestoneReviewResult = runNodeTestFile('tests/milestone-review.test.mjs');
  writeResultOutput(milestoneReviewResult);
  if (milestoneReviewResult.status !== 0) return failureStatus(milestoneReviewResult);

  const milestonePromotionResult = runNodeTestFile('tests/milestone-promotion.test.mjs');
  writeResultOutput(milestonePromotionResult);
  if (milestonePromotionResult.status !== 0) return failureStatus(milestonePromotionResult);

  const segments = [`${countNodeTestCases(schemaResult.stdout)} Plan2Agent fixture set test(s)`];
  if (scaffoldResult.checks) segments.push(`${scaffoldResult.checks} scaffold fixture check(s)`);
  if (evalResult.checks) segments.push(`${evalResult.checks} eval fixture check(s)`);
  if (memoryResult.checks) segments.push(`${memoryResult.checks} memory fixture check(s)`);
  segments.push(`${countNodeTestCases(e2eResult.stdout)} e2e fixture test(s)`);
  segments.push(`${countNodeTestCases(verificationRunnerUtilsResult.stdout)} verification runner utility test(s)`);
  segments.push(`${countNodeTestCases(milestoneReviewResult.stdout)} milestone review test(s)`);
  segments.push(`${countNodeTestCases(milestonePromotionResult.stdout)} milestone promotion test(s)`);
  if (iterationResult.checks) segments.push(`${iterationResult.checks} iteration fixture check(s)`);
  segments.push(`${countNodeTestCases(negativeResult.stdout)} negative fixture test(s)`);
  segments.push(`${countNodeTestCases(projectConfigDetectionResult.stdout)} project config detection test(s)`);
  segments.push(`${countNodeTestCases(runIdStrategyResult.stdout)} run id strategy test(s)`);
  segments.push(`${countNodeTestCases(runLayoutResult.stdout)} run layout test(s)`);
  segments.push(`${countNodeTestCases(evalStableMetricsResult.stdout)} eval stable metrics test(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
