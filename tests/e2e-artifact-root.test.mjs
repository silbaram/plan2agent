import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertE2eCaseShape,
  formatCommandResult,
  loadE2eFixtureManifest,
  makeTempDir,
  runHandoff,
  runTargetExecute,
  runTargetP2a,
  runTargetProposals,
  runTargetRuns,
  runTargetTasks,
  runValidator,
} from './helpers/fixtures.mjs';

function assertOk(result, message) {
  assert.equal(result.status, 0, `${message}\n${formatCommandResult(result)}`);
}

function assertTargetSpecSourceIntake(targetRoot, projectId, caseId, label) {
  const artifactsDir = path.join(targetRoot, '.plan2agent', 'artifacts', projectId);
  const targetSpecPath = path.join(artifactsDir, 'gate-b-spec', 'spec.json');
  const targetIntakePath = path.join(artifactsDir, 'gate-a-intake', 'intake.json');
  const targetIntakeRef = `.plan2agent/artifacts/${projectId}/gate-a-intake/intake.json`;
  const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
  assert.ok(existsSync(targetIntakePath) && targetSpec.source_intake === targetIntakeRef, `${label} handoff source_intake mismatch: ${caseId}`);
}

const manifest = loadE2eFixtureManifest();

for (const caseData of manifest.cases ?? []) {
  test(`e2e artifact root: ${caseData.id}`, () => {
    assertE2eCaseShape(caseData);
    let result = runValidator([
      '--artifact-root',
      caseData.artifact_root,
      '--project-id',
      caseData.project_id,
      '--require-handoff-ready',
    ]);
    assertOk(result, `e2e fixture check failed: ${caseData.id}`);

    const tempRoot = makeTempDir('p2a-greenfield-handoff-');
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
      assertOk(result, `greenfield handoff fixture check failed: ${caseData.id}`);
      assert.ok(existsSync(path.join(targetRoot, '.plan2agent', 'artifacts', caseData.project_id, 'gate-b-spec', 'spec.json')));

      const expectedRuntimeFiles = [
        ['.plan2agent', 'scripts', 'p2a.mjs'],
        ['.plan2agent', 'scripts', 'p2a_paths.mjs'],
        ['.plan2agent', 'scripts', 'p2a_project_config.mjs'],
        ['.plan2agent', 'scripts', 'p2a_run_commands.mjs'],
        ['.plan2agent', 'scripts', 'validate_artifacts.mjs'],
        ['.plan2agent', 'scripts', 'p2a_iteration_state.mjs'],
        ['.plan2agent', 'scripts', 'p2a_runs.mjs'],
        ['.plan2agent', 'scripts', 'p2a_execute.mjs'],
        ['.plan2agent', 'scripts', 'p2a_monitor_gate.mjs'],
        ['.plan2agent', 'scripts', 'p2a_proposals.mjs'],
        ['.plan2agent', 'scripts', 'p2a_run_paths.mjs'],
        ['.plan2agent', 'schemas', 'task-context.schema.json'],
        ['.plan2agent', 'schemas', 'run.schema.json'],
        ['.plan2agent', 'schemas', 'run-index.schema.json'],
        ['.plan2agent', 'schemas', 'skill-proposal.schema.json'],
        ['.plan2agent', 'schemas', 'proposal-review.schema.json'],
        ['.plan2agent', 'schemas', 'proposal-curation.schema.json'],
        ['.plan2agent', 'schemas', 'proposal-patch-draft.schema.json'],
        ['.plan2agent', 'schemas', 'proposal-draft-approval.schema.json'],
        ['.plan2agent', 'schemas', 'eval-index.schema.json'],
        ['.plan2agent', 'schemas', 'eval-digest.schema.json'],
        ['.plan2agent', 'schemas', 'eval-maintenance-draft.schema.json'],
        ['.plan2agent', 'schemas', 'eval-maintenance-apply-report.schema.json'],
      ];
      const missingRuntimeFiles = expectedRuntimeFiles.map((parts) => path.join(...parts)).filter((filePath) => !existsSync(path.join(targetRoot, filePath)));
      assert.deepEqual(missingRuntimeFiles, [], `greenfield handoff missing runtime files: ${caseData.id}`);
      assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json')), false, `greenfield handoff wrote current-spec: ${caseData.id}`);
      assertTargetSpecSourceIntake(targetRoot, caseData.project_id, caseData.id, 'greenfield');

      const targetArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', caseData.project_id);
      const targetTaskGraphPath = path.join(targetArtifactRoot, 'gate-c-task-graph', 'task-graph.json');
      result = runTargetTasks(targetRoot, ['ready', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a_tasks execution failed: ${caseData.id}`);
      result = runTargetRuns(targetRoot, ['list', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a_runs execution failed: ${caseData.id}`);
      assert.match(result.stdout, /runId/);
      result = runTargetExecute(targetRoot, ['plan', '--graph', targetTaskGraphPath, '--task', 'task-001', '--run-id', 'run-target-execute-plan']);
      assertOk(result, `greenfield handoff target p2a_execute execution failed: ${caseData.id}`);
      assert.match(result.stdout, /Plan2Agent supervised task execution/);
      result = runTargetProposals(targetRoot, ['list']);
      assertOk(result, `greenfield handoff target p2a_proposals execution failed: ${caseData.id}`);
      assert.match(result.stdout, /proposalId/);
      result = runTargetP2a(targetRoot, ['tasks', 'ready', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a tasks dispatch failed: ${caseData.id}`);
      assert.match(result.stdout, /task-001/);

      const toolTargetRoot = path.join(tempRoot, 'target-project-tools');
      result = runHandoff(['--project-id', caseData.project_id, '--artifacts', caseData.artifact_root, '--target', toolTargetRoot, '--tools', 'codex,gemini']);
      assertOk(result, `greenfield handoff --tools fixture check failed: ${caseData.id}`);
      const expectedNewAgentFiles = [
        path.join('.agents', 'agents', 'p2a-task-author.md'),
        path.join('.agents', 'agents', 'p2a-milestone-reviewer.md'),
        path.join('.codex', 'agents', 'p2a-task-author.toml'),
        path.join('.codex', 'agents', 'p2a-milestone-reviewer.toml'),
        path.join('.gemini', 'agents', 'p2a-task-author.md'),
        path.join('.gemini', 'agents', 'p2a-milestone-reviewer.md'),
      ];
      const expectedToolFiles = [
        path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
        path.join('.agents', 'agents', 'p2a-requirements.md'),
        path.join('.codex', 'agents', 'p2a-task-graph.toml'),
        path.join('.gemini', 'agents', 'p2a-task-graph.md'),
        path.join('.gemini', 'commands', 'p2a', 'harness.toml'),
        ...expectedNewAgentFiles,
      ];
      const missingToolFiles = expectedToolFiles.filter((filePath) => !existsSync(path.join(toolTargetRoot, filePath)));
      const toolManifest = JSON.parse(readFileSync(path.join(toolTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      assert.deepEqual({ missingToolFiles }, { missingToolFiles: [] });
      assert.equal(toolManifest.aiToolTargets.join(','), 'codex,gemini');
      for (const includedTool of ['p2a_codex_assets', 'p2a_gemini_assets', 'p2a_runs', 'p2a', 'p2a_execute', 'p2a_monitor_gate', 'p2a_proposals']) assert.ok(toolManifest.includedTools.includes(includedTool));
      for (const toolFile of ['.agents/skills/p2a-harness/SKILL.md', '.gemini/commands/p2a/harness.toml', '.plan2agent/scripts/p2a.mjs', '.plan2agent/scripts/p2a_constants.mjs', '.plan2agent/scripts/p2a_runs.mjs', '.plan2agent/scripts/p2a_execute.mjs', '.plan2agent/scripts/p2a_monitor_gate.mjs', '.plan2agent/scripts/p2a_proposals.mjs', '.plan2agent/scripts/p2a_run_paths.mjs']) assert.ok(toolManifest.toolFiles.includes(toolFile), `${toolFile} missing from manifest`);
      for (const toolFile of expectedNewAgentFiles) {
        assert.ok(toolManifest.aiToolFiles.includes(toolFile), `${toolFile} missing from manifest.aiToolFiles`);
        assert.ok(toolManifest.toolFiles.includes(toolFile), `${toolFile} missing from manifest.toolFiles`);
      }
      for (const schemaFile of ['.plan2agent/schemas/run.schema.json', '.plan2agent/schemas/proposal-review.schema.json', '.plan2agent/schemas/proposal-curation.schema.json', '.plan2agent/schemas/proposal-patch-draft.schema.json', '.plan2agent/schemas/proposal-draft-approval.schema.json', '.plan2agent/schemas/eval-index.schema.json', '.plan2agent/schemas/eval-digest.schema.json', '.plan2agent/schemas/eval-maintenance-draft.schema.json', '.plan2agent/schemas/eval-maintenance-apply-report.schema.json']) assert.ok(toolManifest.schemaFiles.includes(schemaFile), `${schemaFile} missing from manifest`);

      const teamSourceRoot = path.join(tempRoot, 'team-bigfive-source');
      mkdirSync(path.join(teamSourceRoot, '_workspace'), { recursive: true });
      writeFileSync(path.join(teamSourceRoot, 'package.json'), JSON.stringify({ name: 'team-bigfive', version: '1.2.3' }, null, 2));
      writeFileSync(path.join(teamSourceRoot, 'README.md'), '# Team Big Five fixture\n');
      writeFileSync(path.join(teamSourceRoot, '.env'), 'SHOULD_NOT_COPY=1\n');
      writeFileSync(path.join(teamSourceRoot, '_workspace', 'run.log'), 'SHOULD_NOT_COPY\n');

      const teamTargetRoot = path.join(tempRoot, 'target-project-team-bigfive');
      result = runHandoff(['--project-id', caseData.project_id, '--artifacts', caseData.artifact_root, '--target', teamTargetRoot, '--include-team-bigfive', '--team-bigfive-source', teamSourceRoot, '--team-bigfive-targets', 'all']);
      assertOk(result, `greenfield handoff Team Big Five fixture check failed: ${caseData.id}`);
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
      assert.deepEqual(missingTeamFiles, []);
      assert.equal(existsSync(path.join(teamTargetRoot, '.claude-plugin', 'team-bigfive', 'source', '.env')), false);
      assert.equal(existsSync(path.join(teamTargetRoot, '.claude-plugin', 'team-bigfive', 'source', '_workspace', 'run.log')), false);
      assert.ok(teamManifest.includedTools.includes('team_bigfive_adapter'));
      assert.equal(teamManifest.externalHarnesses.length, 1);
      assert.equal(teamManifest.externalHarnesses[0].name, 'team-bigfive');
      assert.equal(teamManifest.externalHarnesses[0].targets.join(','), 'codex,claude,gemini');
      assert.equal(teamManifest.externalHarnesses[0].sourceVersion, '1.2.3');
      assert.equal(teamProjectConfig.providerNativeCapabilities?.claude?.agentTeams, 'manual_check');
      assert.equal(teamProjectConfig.providerNativeCapabilities?.codex?.customAgents, 'manual_check');
      assert.equal(teamSourceManifest.source.fileCount, 2);
      assert.equal(teamSourceManifest.source.files.some((file) => file.path === '.env' || file.path.startsWith('_workspace/')), false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}
