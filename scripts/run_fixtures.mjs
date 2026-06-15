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

function runHandoff(args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function runTargetTasks(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_tasks.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function runTargetRuns(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, 'scripts', 'p2a_runs.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

function writeResultOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
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
      return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }
      if (
        !existsSync(path.join(targetRoot, 'scripts', 'p2a_iteration_state.mjs'))
        || !existsSync(path.join(targetRoot, 'scripts', 'p2a_runs.mjs'))
        || !existsSync(path.join(targetRoot, 'schemas', 'run.schema.json'))
        || !existsSync(path.join(targetRoot, 'schemas', 'run-index.schema.json'))
        || existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json'))
      ) {
        console.error(`greenfield handoff wrote unexpected tool/current-spec files: ${caseData.id}`);
        return { status: 1, checks };
      }

      result = runTargetTasks(targetRoot, ['ready', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json')]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`greenfield handoff target p2a_tasks execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runTargetRuns(targetRoot, ['list', '--graph', path.join(targetRoot, '.plan2agent', 'artifacts', 'task-graph.json')]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('runId')) {
        console.error(`greenfield handoff target p2a_runs execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status || 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        || !toolManifest.toolFiles.includes('.agents/skills/p2a-harness/SKILL.md')
        || !toolManifest.toolFiles.includes('.gemini/commands/p2a/harness.toml')
        || !toolManifest.toolFiles.includes('scripts/p2a_runs.mjs')
        || !toolManifest.schemaFiles.includes('schemas/run.schema.json')
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

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
        return { status: result.status ?? 1, checks };
      }

      result = runTasks(['-i'], { input: `2\n1\n${artifactRoot}\n` });
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`p2a_tasks interactive --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runTasks(['prompt', '--artifacts', artifactRoot, 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Full spec:')) {
        console.error(`p2a_tasks prompt --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runTasks(['ready', '--graph', state.taskGraphPath, '--artifacts', artifactRoot]);
      checks += 1;
      const taskOptionOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status === 0 || !taskOptionOutput.includes('--graph and --artifacts cannot be used together')) {
        console.error(`p2a_tasks fixture did not reject mixed graph/artifacts inputs: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runTasks(['start', '--artifacts', artifactRoot, 'task-001']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_tasks start --artifacts fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status || 1, checks };
      }

      result = runRuns([
        'verify',
        '--artifacts',
        artifactRoot,
        '--run-id',
        fixtureRunId,
        '--test-command',
        `${process.execPath} -e "process.exit(0)"`,
        '--lint-command',
        `${process.execPath} -e "process.exit(0)"`,
        '--typecheck-command',
        `${process.execPath} -e "process.exit(0)"`,
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('test: passed') || !result.stdout.includes('typecheck: passed')) {
        console.error(`p2a_runs verify fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status || 1, checks };
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
        return { status: result.status || 1, checks };
      }

      result = runValidator(['--runs-dir', runsDir]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`p2a_runs validator fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        || fixtureRunIndex.tasks.find((task) => task.taskId === 'task-001')?.latestRunId !== fixtureRunId
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('archived audit: 1 closed iteration(s) verified')) {
        console.error(`iteration default archive audit fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current after open fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      const draftIntakePath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-a-intake', 'intake.json');
      const draftSpecPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-b-spec', 'spec.json');
      result = runValidator(['--intake', draftIntakePath, '--spec', draftSpecPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration draft Gate A/B artifact validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['diff-tasks', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('diff task graph generated')) {
        console.error(`iteration diff-tasks fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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

      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('close-ready: all tasks done')) {
        console.error(`iteration validate did not accept approved Gate A-D iter-002 fixture: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }
      writeFileSync(state.currentSpecPath, currentSpecBeforeConflictCompose, 'utf8');
      writeFileSync(iter2MetadataPath, originalIter2MetadataText, 'utf8');

      result = runIteration(['compose', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('current spec composed')) {
        console.error(`iteration compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      result = runTasks(['ready', '--artifacts', artifactRoot, '--maintenance']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('task-001')) {
        console.error(`p2a_tasks ready --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      const activeTaskGraphBeforeMaintenanceStartText = readFileSync(state.taskGraphPath, 'utf8');
      result = runTasks(['start', '--artifacts', artifactRoot, '--maintenance', 'task-001']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('status is now in_progress')) {
        console.error(`p2a_tasks start --artifacts --maintenance fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['current', '--artifacts', artifactRoot, '--json']);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration current after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
      if (result.status !== 0 || !result.stdout.includes('sourceIterationId: iter-002')) {
        console.error(`iteration handoff --iteration-id active dry-run fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
        || !existsSync(path.join(iterationTargetRoot, 'schemas', 'run-index.schema.json'))
      ) {
        console.error(`iteration handoff did not copy active artifacts/current-spec/tools: ${caseData.id}`);
        return { status: 1, checks };
      }
      const targetManifest = JSON.parse(readFileSync(targetManifestPath, 'utf8'));
      const targetCurrentSpec = JSON.parse(readFileSync(targetCurrentSpecPath, 'utf8'));
      const sourceCurrentSpecAfterHandoff = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
      const targetTaskGraph = JSON.parse(readFileSync(targetTaskGraphPath, 'utf8'));
      if (
        targetManifest.sourceLayout !== 'iteration'
        || targetManifest.sourceIterationId !== 'iter-002'
        || targetManifest.currentSpecFile !== '.plan2agent/current-spec.json'
        || JSON.stringify(targetManifest.maintenanceFiles) !== JSON.stringify(['.plan2agent/maintenance/task-graph.json'])
        || !targetManifest.includedTools.includes('p2a_runs')
        || !targetManifest.toolFiles.includes('scripts/p2a_runs.mjs')
        || !targetManifest.schemaFiles.includes('schemas/run-index.schema.json')
        || targetCurrentSpec.last_handoff?.iteration_id !== 'iter-002'
        || targetCurrentSpec.last_handoff?.maintenance_included !== true
        || sourceCurrentSpecAfterHandoff.last_handoff?.target_project !== iterationTargetRoot
        || targetTaskGraph.sourceSpec !== 'spec.json'
      ) {
        console.error(`iteration handoff manifest/task graph contract mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ targetManifest, targetCurrentSpec, sourceCurrentSpecAfterHandoff, targetTaskGraphSourceSpec: targetTaskGraph.sourceSpec }, null, 2));
        return { status: 1, checks };
      }

      result = runTargetTasks(iterationTargetRoot, ['ready', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target p2a_tasks execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runTargetRuns(iterationTargetRoot, ['list', '--graph', targetTaskGraphPath]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('runId')) {
        console.error(`iteration handoff target p2a_runs execution failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status || 1, checks };
      }

      result = runIteration(['open', '--artifacts', artifactRoot, '--iteration-id', 'iter-003', '--idea', 'Add composed baseline reporting']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration opened')) {
        console.error(`iteration open after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated')) {
        console.error(`iteration draft from composed current-spec fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      const iter3SpecPath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-b-spec', 'spec.json');
      const iter3IntakePath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-a-intake', 'intake.json');
      result = runValidator(['--intake', iter3IntakePath, '--spec', iter3SpecPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration draft from composed baseline Gate A/B validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      const approvedIter3Spec = JSON.parse(readFileSync(iter3SpecPath, 'utf8'));
      approvedIter3Spec.approval = 'approved';
      writeFileSync(iter3SpecPath, `${JSON.stringify(approvedIter3Spec, null, 2)}\n`, 'utf8');
      result = runIteration(['promote-spec', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('active spec promoted')) {
        console.error(`iteration promote-spec after compose fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--stage', 'gate-b-approved']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('stage: gate-b-approved')) {
        console.error(`iteration planning validate after composed promote-spec failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: result.status ?? 1, checks };
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

      result = runIteration(['context', '--artifacts', artifactRoot]);
      checks += 1;
      try {
        const taskContext = JSON.parse(result.stdout);
        if (
          result.status !== 0
          || taskContext.schema_version !== 'p2a.task_context.v1'
          || taskContext.active_iteration !== 'iter-003'
          || !taskContext.effective_spec
          || !taskContext.existing_tasks
        ) {
          throw new Error('context JSON contract mismatch');
        }
        validateTaskContextData(taskContext);
        if (taskContext.idea === undefined || taskContext.baseline_effective_spec_ref === undefined) {
          throw new Error('context JSON contract mismatch');
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
        return { status: result.status ?? 1, checks };
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
        return { status: result.status ?? 1, checks };
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
      return { status: result.status ?? 1, checks };
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
  if (result.status !== 0) return result.status ?? 1;

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
  if (e2eResult.checks) segments.push(`${e2eResult.checks} e2e fixture check(s)`);
  if (iterationResult.checks) segments.push(`${iterationResult.checks} iteration fixture check(s)`);
  if (negativeResult.checks) segments.push(`${negativeResult.checks} negative fixture check(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
