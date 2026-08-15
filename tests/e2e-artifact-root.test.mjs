import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertE2eCaseShape,
  formatCommandResult,
  loadE2eFixtureManifest,
  makeTempDir,
  ROOT,
  runEmbeddedTargetP2a,
  runHandoff,
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
  const targetIntake = existsSync(targetIntakePath)
    ? JSON.parse(readFileSync(targetIntakePath, 'utf8'))
    : null;
  assert.ok(targetIntake && targetSpec.source_intake === targetIntakeRef, `${label} handoff source_intake mismatch: ${caseId}`);
  if (targetIntake.approval_audit) {
    assert.deepEqual(
      targetIntake.approval_audit.approved_artifacts,
      [targetIntakeRef],
      `${label} handoff Gate A approval audit mismatch: ${caseId}`,
    );
  }
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
      const invalidArtifactRoot = path.join(tempRoot, 'invalid-baseline-context');
      cpSync(caseData.artifact_root, invalidArtifactRoot, { recursive: true });
      const invalidIntakePath = path.join(invalidArtifactRoot, 'gate-a-intake', 'intake.json');
      const invalidIntake = JSON.parse(readFileSync(invalidIntakePath, 'utf8'));
      invalidIntake.baseline_context = {
        spec_ref: 'missing/spec.json',
        reused_answers: [],
        reused_question_dispositions: [],
      };
      writeFileSync(invalidIntakePath, `${JSON.stringify(invalidIntake, null, 2)}\n`, 'utf8');
      result = runValidator([
        '--artifact-root',
        invalidArtifactRoot,
        '--project-id',
        caseData.project_id,
        '--require-handoff-ready',
      ]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /baseline_context\.spec_ref is missing/);

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

      assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs')), true, `greenfield handoff missing runtime CLI: ${caseData.id}`);
      assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'next.schema.json')), true, `greenfield handoff missing runtime schema: ${caseData.id}`);
      const targetManifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      assert.equal(realpathSync(targetManifest.provenance.toolkitRoot), realpathSync(ROOT));
      assert.equal('runtime' in targetManifest, false);
      assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'current-spec.json')), false, `greenfield handoff wrote current-spec: ${caseData.id}`);
      assertTargetSpecSourceIntake(targetRoot, caseData.project_id, caseData.id, 'greenfield');

      const targetArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', caseData.project_id);
      const targetTaskGraphPath = path.join(targetArtifactRoot, 'gate-c-task-graph', 'task-graph.json');
      result = runEmbeddedTargetP2a(targetRoot, ['tasks', 'ready', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a_tasks execution failed: ${caseData.id}`);
      result = runEmbeddedTargetP2a(targetRoot, ['runs', 'list', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a_runs execution failed: ${caseData.id}`);
      assert.match(result.stdout, /runId/);
      result = runEmbeddedTargetP2a(targetRoot, ['execute', 'plan', '--graph', targetTaskGraphPath, '--task', 'task-001', '--run-id', 'run-target-execute-plan']);
      assertOk(result, `greenfield handoff target p2a_execute execution failed: ${caseData.id}`);
      assert.match(result.stdout, /Plan2Agent supervised task execution/);
      result = runEmbeddedTargetP2a(targetRoot, ['proposals', 'list']);
      assertOk(result, `greenfield handoff target p2a_proposals execution failed: ${caseData.id}`);
      assert.match(result.stdout, /proposalId/);
      result = runEmbeddedTargetP2a(targetRoot, ['tasks', 'ready', '--graph', targetTaskGraphPath]);
      assertOk(result, `greenfield handoff target p2a tasks dispatch failed: ${caseData.id}`);
      assert.match(result.stdout, /task-001/);
      result = runEmbeddedTargetP2a(targetRoot, ['next', '--json']);
      assertOk(result, `greenfield handoff target p2a next failed: ${caseData.id}`);
      const targetNext = JSON.parse(result.stdout);
      assert.equal(targetNext.schema_version, 'p2a.next.v1');
      assert.equal(targetNext.state, 'ready_task_available');
      assert.equal(targetNext.command.kind, 'cli');
      assert.equal(targetNext.command.requiresApproval, false);
      assert.deepEqual(targetNext.command.argv, [
        'execute', 'start',
        '--graph',
        path.join(
          '.plan2agent',
          'artifacts',
          caseData.project_id,
          'gate-c-task-graph',
          'task-graph.json',
        ).split(path.sep).join('/'),
        '--task', 'task-001',
      ]);
      result = runEmbeddedTargetP2a(targetRoot, targetNext.command.argv);
      assertOk(result, `greenfield handoff target p2a next recommendation failed: ${caseData.id}`);

      const toolTargetRoot = path.join(tempRoot, 'target-project-tools');
      result = runHandoff(['--project-id', caseData.project_id, '--artifacts', caseData.artifact_root, '--target', toolTargetRoot, '--tools', 'codex,gemini']);
      assertOk(result, `greenfield handoff --tools fixture check failed: ${caseData.id}`);
      const expectedNewAgentFiles = [
        path.join('.agents', 'agents', 'p2a-task-author.md'),
        path.join('.codex', 'agents', 'p2a-task-author.toml'),
        path.join('.gemini', 'agents', 'p2a-task-author.md'),
      ];
      const expectedToolFiles = [
        path.join('.agents', 'skills', 'p2a-harness', 'SKILL.md'),
        path.join('.agents', 'skills', 'p2a-next', 'SKILL.md'),
        path.join('.codex', 'agents', 'p2a-task-graph.toml'),
        path.join('.gemini', 'agents', 'p2a-task-graph.md'),
        path.join('.gemini', 'commands', 'p2a', 'harness.toml'),
        path.join('.gemini', 'commands', 'p2a', 'next.toml'),
        ...expectedNewAgentFiles,
      ];
      const missingToolFiles = expectedToolFiles.filter((filePath) => !existsSync(path.join(toolTargetRoot, filePath)));
      const toolManifest = JSON.parse(readFileSync(path.join(toolTargetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
      assert.deepEqual({ missingToolFiles }, { missingToolFiles: [] });
      assert.equal(toolManifest.aiToolTargets.join(','), 'codex,gemini');
      for (const includedTool of ['p2a_codex_assets', 'p2a_gemini_assets']) assert.ok(toolManifest.includedTools.includes(includedTool));
      for (const toolFile of ['.agents/skills/p2a-harness/SKILL.md', '.agents/skills/p2a-next/SKILL.md', '.gemini/commands/p2a/harness.toml', '.gemini/commands/p2a/next.toml']) assert.ok(toolManifest.toolFiles.includes(toolFile), `${toolFile} missing from manifest`);
      for (const toolFile of expectedNewAgentFiles) {
        const manifestToolFile = toolFile.split(path.sep).join('/');
        assert.ok(toolManifest.aiToolFiles.includes(manifestToolFile), `${manifestToolFile} missing from manifest.aiToolFiles`);
        assert.ok(toolManifest.toolFiles.includes(manifestToolFile), `${manifestToolFile} missing from manifest.toolFiles`);
      }
      assert.ok(toolManifest.schemaFiles.includes('.plan2agent/schemas/next.schema.json'));
      const installedSkill = readFileSync(
        path.join(toolTargetRoot, '.agents', 'skills', 'p2a-dev-execution', 'SKILL.md'),
        'utf8',
      );
      assert.match(installedSkill, /node \.plan2agent\/scripts\/p2a\.mjs tasks ready/);

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
