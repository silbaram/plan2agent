import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const ROOT = path.resolve(path.dirname(__filename), '..', '..');
export const FIXTURE_ROOT = path.join(ROOT, 'fixtures');
export const E2E_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_e2e');
export const NEGATIVE_FIXTURE_ROOT = path.join(FIXTURE_ROOT, '_negative');
export const VALIDATOR = path.join(ROOT, 'scripts', 'validate_artifacts.mjs');
export const ITERATION_CLI = path.join(ROOT, 'scripts', 'p2a_iteration.mjs');
export const TASKS_CLI = path.join(ROOT, 'scripts', 'p2a_tasks.mjs');
export const RUNS_CLI = path.join(ROOT, 'scripts', 'p2a_runs.mjs');
export const EXECUTE_CLI = path.join(ROOT, 'scripts', 'p2a_execute.mjs');
export const PROPOSALS_CLI = path.join(ROOT, 'scripts', 'p2a_proposals.mjs');
export const EVAL_CLI = path.join(ROOT, 'scripts', 'p2a_eval.mjs');
export const MEMORY_CLI = path.join(ROOT, 'scripts', 'p2a_memory.mjs');
export const HANDOFF_CLI = path.join(ROOT, 'scripts', 'p2a_handoff.mjs');
export const DOCTOR_CLI = path.join(ROOT, 'scripts', 'p2a_doctor.mjs');
export const P2A_CLI = path.join(ROOT, 'scripts', 'p2a.mjs');

export function runValidator(args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runIteration(args) {
  return spawnSync(process.execPath, [ITERATION_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runTasks(args, options = {}) {
  return spawnSync(process.execPath, [TASKS_CLI, ...args], { cwd: ROOT, encoding: 'utf8', input: options.input });
}

export function runTasksFrom(cwd, args) {
  return spawnSync(process.execPath, [TASKS_CLI, ...args], { cwd, encoding: 'utf8' });
}

export function runRuns(args, options = {}) {
  return spawnSync(process.execPath, [RUNS_CLI, ...args], { cwd: options.cwd ?? ROOT, encoding: 'utf8' });
}

export function runRunsFrom(cwd, args) {
  return runRuns(args, { cwd });
}

export function runExecute(args) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runExecuteFrom(cwd, args) {
  return spawnSync(process.execPath, [EXECUTE_CLI, ...args], { cwd, encoding: 'utf8' });
}

export function runOrchestrate(args) {
  return spawnSync(process.execPath, [ORCHESTRATE_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runProposals(args) {
  return spawnSync(process.execPath, [PROPOSALS_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runEval(args) {
  return spawnSync(process.execPath, [EVAL_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runMemory(args) {
  return spawnSync(process.execPath, [MEMORY_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, P2A_MEMORY_URL: '', P2A_MEMORY_TOKEN: '' },
  });
}


export function fixtureFailureDetailArgs(label) {
  return [
    '--repro-step',
    `${label} can be reproduced from the fixture run output.`,
    '--localization',
    `${label} is localized by the fixture assertion.`,
    '--guard',
    `${label} is guarded by the fixture regression check.`,
  ];
}

export function runHandoff(args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runHandoffFrom(cwd, args) {
  return spawnSync(process.execPath, [HANDOFF_CLI, ...args], { cwd, encoding: 'utf8' });
}

export function runDoctor(args) {
  return spawnSync(process.execPath, [DOCTOR_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runP2a(args) {
  return spawnSync(process.execPath, [P2A_CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

export function runTargetP2a(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetTasks(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_tasks.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetRuns(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_runs.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetExecute(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_execute.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}


export function runTargetProposals(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_proposals.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetEval(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetMemory(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_memory.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function runTargetIteration(targetRoot, args) {
  return spawnSync(process.execPath, [path.join(targetRoot, '.plan2agent', 'scripts', 'p2a_iteration.mjs'), ...args], { cwd: targetRoot, encoding: 'utf8' });
}

export function failureStatus(result) {
  return result.status === 0 ? 1 : (result.status ?? 1);
}

export function formatCommandResult(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('');
}

export function writeResultOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function makeTempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function loadNegativeFixtureManifest() {
  const manifestPath = path.join(NEGATIVE_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { expected_pass: [], expected_failure: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function loadE2eFixtureManifest() {
  const manifestPath = path.join(E2E_FIXTURE_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { cases: [] };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function assertCaseShape(caseData, groupName) {
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

export function assertE2eCaseShape(caseData) {
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
