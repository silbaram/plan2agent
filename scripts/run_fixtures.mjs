#!/usr/bin/env node
/** Run Plan2Agent fixture/golden validation for positive, e2e, iteration, and negative fixture cases. */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import {
  validateTaskContextData,
  validateTaskGraphData,
} from './validate_artifacts.mjs';
import { compareSync } from './p2a_memory.mjs';
import { shellQuote } from './p2a_run_commands.mjs';
import { runFilePath, runSidecarPath, runSidecarRef, taskContractSha256 } from './p2a_run_paths.mjs';
import {
  E2E_FIXTURE_ROOT,
  FIXTURE_ROOT,
  loadE2eFixtureManifest,
  assertE2eCaseShape,
  fixtureFailureDetailArgs,
  ROOT,
  runDoctor,
  runEval,
  runExecute,
  runHandoff,
  runIteration,
  runMemory,
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

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function writePng(filePath, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function writeSyntheticApprovedVisualBundle(gateBRoot, projectId, marker = 'Ready') {
  const candidateDir = path.join(gateBRoot, 'visual-design', 'VD-1');
  const alternateCandidateDir = path.join(gateBRoot, 'visual-design', 'VD-2');
  const experiencePath = path.join(gateBRoot, 'experience-spec.json');
  const prototypePath = path.join(candidateDir, 'prototype.json');
  const htmlPath = path.join(candidateDir, 'index.html');
  const alternatePrototypePath = path.join(alternateCandidateDir, 'prototype.json');
  const alternateHtmlPath = path.join(alternateCandidateDir, 'index.html');
  mkdirSync(candidateDir, { recursive: true });
  mkdirSync(alternateCandidateDir, { recursive: true });
  const csp = [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const htmlText = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Fixture review</title><main>${marker}</main>\n`;
  writeFileSync(htmlPath, htmlText, 'utf8');
  const alternateHtmlText = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Fixture split review</title><main>${marker} in split view</main>\n`;
  writeFileSync(alternateHtmlPath, alternateHtmlText, 'utf8');
  const approvalAudit = (approvedArtifacts) => ({
    approved_by: 'fixture-owner',
    approved_at: '2026-07-10T23:59:00.000Z',
    approved_artifacts: approvedArtifacts,
    approval_note: 'Synthetic approved visual artifact for portable milestone evidence.',
  });
  const prototypeText = `${JSON.stringify({
    schema_version: 'p2a.visual_prototype.v1',
    project_id: projectId,
    experience_spec_ref: '../../experience-spec.json',
    candidate_id: 'VD-1',
    status: 'approved',
    entrypoint: 'index.html',
    screen_states: [{
      screen_id: 'SCREEN-1',
      states: ['ready'],
      state_artifacts: [{ state: 'ready', artifact_ref: 'index.html' }],
    }],
    viewports: ['desktop'],
    network_policy: 'offline',
    files: [{ path: 'index.html', sha256: hashText(htmlText), media_type: 'text/html' }],
    approval_audit: approvalAudit(['index.html']),
  }, null, 2)}\n`;
  writeFileSync(prototypePath, prototypeText, 'utf8');
  const alternatePrototypeText = `${JSON.stringify({
    schema_version: 'p2a.visual_prototype.v1',
    project_id: projectId,
    experience_spec_ref: '../../experience-spec.json',
    candidate_id: 'VD-2',
    status: 'candidate',
    entrypoint: 'index.html',
    screen_states: [{
      screen_id: 'SCREEN-1',
      states: ['ready'],
      state_artifacts: [{ state: 'ready', artifact_ref: 'index.html' }],
    }],
    viewports: ['desktop'],
    network_policy: 'offline',
    files: [{ path: 'index.html', sha256: hashText(alternateHtmlText), media_type: 'text/html' }],
  }, null, 2)}\n`;
  writeFileSync(alternatePrototypePath, alternatePrototypeText, 'utf8');
  const experienceText = `${JSON.stringify({
    schema_version: 'p2a.visual_experience.v1',
    project_id: projectId,
    source_spec_ref: 'spec.json',
    mode: 'full',
    visual_direction: {
      keywords: ['focused'],
      references: [],
      avoid: ['fixture clutter'],
      candidates: [
        {
          id: 'VD-1',
          title: 'Fixture review',
          summary: 'A deterministic visual-review fixture.',
          tradeoffs: ['Minimal styling'],
          prototype_manifest_ref: 'visual-design/VD-1/prototype.json',
          prototype_manifest_sha256: hashText(prototypeText),
        },
        {
          id: 'VD-2',
          title: 'Fixture split review',
          summary: 'A deterministic alternate visual-review fixture.',
          tradeoffs: ['Higher information density'],
          prototype_manifest_ref: 'visual-design/VD-2/prototype.json',
          prototype_manifest_sha256: hashText(alternatePrototypeText),
        },
      ],
      selected_candidate: 'VD-1',
    },
    design_system: {
      strategy: 'new',
      references: [],
      token_rules: ['Use semantic color tokens'],
      component_rules: ['Keep the primary action visible'],
    },
    screens: [{
      id: 'SCREEN-1',
      name: 'Fixture review',
      route: '/reviews/:id',
      user_goal: 'Review one fixture state.',
      entry_points: ['Fixture runner'],
      primary_action: 'Confirm fixture',
      secondary_actions: ['Inspect details'],
      regions: [{ id: 'content', purpose: 'Show fixture evidence', priority: 'primary' }],
      states: ['ready'],
      success_exit: 'The fixture review is confirmed.',
      responsive_rules: ['Keep content visible at 240px'],
      accessibility_requirements: ['Keyboard access for the primary action'],
    }],
    validation: {
      viewports: [{ name: 'desktop', width: 240, height: 240 }],
      required_states: ['ready'],
      accessibility_standard: 'WCAG 2.2 AA',
      visual_review_required: true,
    },
    approval: 'approved',
    approval_audit: approvalAudit(['visual-design/VD-1/prototype.json']),
  }, null, 2)}\n`;
  writeFileSync(experiencePath, experienceText, 'utf8');
  return {
    experienceSpecSha256: hashText(experienceText),
    prototypeManifestSha256: hashText(prototypeText),
  };
}

const DISCOVERY_FIXTURE_ANSWERS = {
  'CQ-1': 'Delivery status refreshes within five seconds and contract tests verify the result.',
  'CQ-2': 'Include operator dashboard delivery status; CSV export remains out of scope.',
  'CQ-3': 'Add operations users while preserving existing webhook integrations and signature compatibility.',
};

const DISCOVERY_FIXTURE_DECISION_ANSWER = 'Operations leads are the approved dashboard audience.';

function confirmScopeIntake(intakePath, approvedArtifactRef, contentSuffix = '') {
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  intake.clarifying_questions = (intake.clarifying_questions ?? []).map((question) => ({
    ...question,
    status: 'answered',
    answer: `${DISCOVERY_FIXTURE_ANSWERS[question.id] ?? `Fixture answer for ${question.id}`}${contentSuffix}`,
  }));
  intake.needs_user_decision = (intake.needs_user_decision ?? []).map((decision) => ({
    ...decision,
    status: 'answered',
    answer: `${decision.answer ?? decision.default}${contentSuffix}`,
  }));
  intake.needs_user_decision.push({
    id: 'ND-1',
    question: 'Which user group is the approved dashboard audience?',
    options: [
      {
        id: 'operations-leads',
        label: 'Operations leads',
        description: 'Limit the dashboard to operations leads for the current iteration.',
      },
      {
        id: 'all-operators',
        label: 'All operators',
        description: 'Expose the dashboard to every operator in the current iteration.',
      },
    ],
    impact: 'Changes the canonical target user and success criteria.',
    blocks: ['spec.product.target_users', 'spec.product.success_criteria'],
    default: 'operations-leads',
    status: 'answered',
    answer: `${DISCOVERY_FIXTURE_DECISION_ANSWER}${contentSuffix}`,
  });
  delete intake.interview;
  intake.approval_audit = {
    approved_by: 'user',
    approved_at: '2026-07-29',
    approved_artifacts: [approvedArtifactRef],
    approval_note: 'Fixture user explicitly approved the Gate A scope.',
  };
  intake.status = 'ready_for_spec';
  writeFileSync(intakePath, `${JSON.stringify(intake, null, 2)}\n`, 'utf8');
  return intake;
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
  const targetIntake = existsSync(targetIntakePath)
    ? JSON.parse(readFileSync(targetIntakePath, 'utf8'))
    : null;
  const intakeAuditMatches = !targetIntake?.approval_audit
    || JSON.stringify(targetIntake.approval_audit.approved_artifacts) === JSON.stringify([targetIntakeRef]);
  const baselineContextRefs = targetIntake?.baseline_context
    ? [
        targetIntake.baseline_context.spec_ref,
        ...(targetIntake.baseline_context.reused_answers ?? []).map((item) => item.source_intake),
        ...(targetIntake.baseline_context.reused_question_dispositions ?? []).map((item) => item.source_spec),
      ]
    : [];
  const missingBaselineContextRefs = baselineContextRefs.filter((reference) => {
    const resolved = path.resolve(artifactsDir, reference);
    const relative = path.relative(artifactsDir, resolved);
    return !relative
      || relative.startsWith('..')
      || path.isAbsolute(relative)
      || !existsSync(resolved);
  });
  if (
    !targetIntake
    || targetSpec.source_intake !== targetIntakeRef
    || !intakeAuditMatches
    || missingBaselineContextRefs.length
  ) {
    console.error(`${label} handoff spec.source_intake/intake.json mismatch: ${caseId}`);
    console.error(JSON.stringify({
      source_intake: targetSpec.source_intake,
      intakeExists: Boolean(targetIntake),
      intakeApprovedArtifacts: targetIntake?.approval_audit?.approved_artifacts ?? null,
      missingBaselineContextRefs,
    }, null, 2));
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
    let result = runHandoff(['init', '--target', targetRoot, '--tools', 'all']);
    checks += 1;
    if (result.status !== 0) {
      console.error('scaffold fixture check failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

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
    const missingFiles = [...expectedToolFiles, ...expectedGenerated]
      .filter((filePath) => !existsSync(path.join(targetRoot, filePath)));
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    const missingManifestNewAgentFiles = expectedNewAgentFiles
      .filter((filePath) => !manifest.aiToolFiles?.includes(filePath));
    const config = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'project.config.json'), 'utf8'));
    const claudeSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.json'), 'utf8'));
    const claudeLocalSettings = JSON.parse(readFileSync(path.join(targetRoot, '.claude', 'settings.local.json'), 'utf8'));
    const codexHeavyWebAgent = readFileSync(path.join(targetRoot, '.codex', 'agents', 'p2a-implementation-planner.toml'), 'utf8');
    const gitignore = readFileSync(path.join(targetRoot, '.gitignore'), 'utf8');
    const gitignoreLines = new Set(gitignore.split(/\r?\n/));
    const expectedSandboxEnabled = process.platform === 'darwin' || process.platform === 'linux';
    if (
      missingFiles.length
      || missingManifestNewAgentFiles.length
      || manifest.provenance?.mode !== 'init'
      || manifest.provenance?.toolkitRoot !== ROOT
      || 'runtime' in manifest
      || !manifest.scriptFiles?.includes('.plan2agent/scripts/p2a.mjs')
      || !manifest.schemaFiles?.includes('.plan2agent/schemas/next.schema.json')
      || !existsSync(path.join(targetRoot, '.plan2agent', 'scripts', 'p2a.mjs'))
      || !existsSync(path.join(targetRoot, '.plan2agent', 'schemas', 'next.schema.json'))
      || manifest.projectId !== 'target-project'
      || manifest.aiToolTargets.join(',') !== 'codex,claude,gemini'
      || manifest.codexAgentProfile?.name !== 'quality'
      || manifest.codexAgentProfile?.model !== 'gpt-5.6-sol'
      || !/^model\s*=\s*"gpt-5\.6-sol"\s*$/m.test(codexHeavyWebAgent)
      || !/^model_reasoning_effort\s*=\s*"max"\s*$/m.test(codexHeavyWebAgent)
      || !/^web_search\s*=\s*"live"\s*$/m.test(codexHeavyWebAgent)
      || config.projectId !== 'target-project'
      || config.testCommand !== null
      || config.verificationTimeoutMs !== 600000
      || config.runTracking?.runsDir !== '.plan2agent/runs'
      || config.devExecution?.scopePolicy !== 'task_only'
      || config.devExecution?.verificationPolicy !== 'required_for_done'
      || config.devExecution?.reviewPasses?.monitor !== 'opt_in'
      || config.devExecution?.reviewPasses?.style !== 'off'
      || config.devExecution?.reviewPasses?.milestone !== 'off'
      || config.devExecution?.reviewPasses?.visual !== 'off'
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
      console.error('checkout init output mismatch');
      console.error(JSON.stringify({ missingFiles, missingManifestNewAgentFiles, manifest, config, claudeSettings, claudeLocalSettings }, null, 2));
      return { status: 1, checks };
    }

    const inheritProfileRoot = path.join(tempRoot, 'codex-inherit-project');
    result = runHandoff(['scaffold', '--target', inheritProfileRoot, '--tools', 'codex', '--codex-profile', 'inherit']);
    checks += 1;
    const inheritManifest = result.status === 0
      ? JSON.parse(readFileSync(path.join(inheritProfileRoot, '.plan2agent', 'manifest.json'), 'utf8'))
      : null;
    const inheritAgentPath = path.join(inheritProfileRoot, '.codex', 'agents', 'p2a-implementation-planner.toml');
    const inheritAgent = existsSync(inheritAgentPath) ? readFileSync(inheritAgentPath, 'utf8') : '';
    if (
      result.status !== 0
      || inheritManifest?.codexAgentProfile?.name !== 'inherit'
      || /^model\s*=/m.test(inheritAgent)
      || /^model_reasoning_effort\s*=/m.test(inheritAgent)
      || !/^web_search\s*=\s*"live"\s*$/m.test(inheritAgent)
    ) {
      console.error('Codex inherit profile scaffold fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ codexAgentProfile: inheritManifest?.codexAgentProfile, inheritAgent }, null, 2));
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

    unlinkSync(inheritAgentPath);
    result = runHandoff(['update', '--target', inheritProfileRoot, '--apply']);
    checks += 1;
    const restoredInheritAgent = existsSync(inheritAgentPath) ? readFileSync(inheritAgentPath, 'utf8') : '';
    const restoredInheritManifest = JSON.parse(readFileSync(path.join(inheritProfileRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || restoredInheritManifest.codexAgentProfile?.name !== 'inherit'
      || /^model\s*=/m.test(restoredInheritAgent)
      || /^model_reasoning_effort\s*=/m.test(restoredInheritAgent)
      || !/^web_search\s*=\s*"live"\s*$/m.test(restoredInheritAgent)
    ) {
      console.error('Codex inherit profile update restore fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ codexAgentProfile: restoredInheritManifest.codexAgentProfile, restoredInheritAgent }, null, 2));
      return { status: failureStatus(result), checks };
    }

    result = runTargetIteration(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a iteration init')) {
      console.error('init target p2a iteration --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetEval(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a eval grade')) {
      console.error('init target p2a eval --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetMemory(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a memory status')) {
      console.error('init target p2a memory --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetP2a(targetRoot, ['--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a init')) {
      console.error('init target p2a --help failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    result = runTargetP2a(targetRoot, ['info', '--json']);
    checks += 1;
    const p2aInfo = result.status === 0 ? JSON.parse(result.stdout) : null;
    if (
      result.status !== 0
      || p2aInfo.schema_version !== 'p2a.info.v1'
      || p2aInfo.surface !== 'toolkit_checkout'
      || p2aInfo.mode !== 'init'
      || p2aInfo.artifactCount !== 0
    ) {
      console.error('init target p2a info fixture failed');
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
    mkdirSync(path.dirname(misplacedEmbeddedDoctorPath), { recursive: true });
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
      console.error('init target p2a doctor dispatch failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ targetP2aDoctor }, null, 2));
      return { status: failureStatus(result), checks };
    }
    unlinkSync(misplacedEmbeddedDoctorPath);

    result = runTargetP2a(targetRoot, ['eval', '--help']);
    checks += 1;
    if (result.status !== 0 || !result.stdout.includes('p2a eval grade')) {
      console.error('init target p2a eval dispatch failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }

    const signalDispatchRoot = path.join(tempRoot, 'p2a-signal-dispatch-target');
    cpSync(targetRoot, signalDispatchRoot, { recursive: true });
    const rogueTasksPath = path.join(signalDispatchRoot, '.plan2agent', 'scripts', 'p2a_tasks.mjs');
    mkdirSync(path.dirname(rogueTasksPath), { recursive: true });
    writeFileSync(
      rogueTasksPath,
      "process.kill(process.pid, 'SIGTERM');\n",
      'utf8',
    );
    result = runTargetP2a(signalDispatchRoot, ['tasks', 'ready']);
    checks += 1;
    if (result.status === 0 || `${result.stdout}${result.stderr}`.includes('SIGTERM')) {
      console.error('top-level p2a ran a rogue project-local runtime script');
      writeResultOutput(result);
      return { status: result.status === 0 ? 1 : failureStatus(result), checks };
    }
    rmSync(path.dirname(rogueTasksPath), { recursive: true, force: true });

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
      || !initDoctorReport.projectState?.commands?.find((command) => command.id === 'init_iteration')?.command?.includes('p2a iteration init')
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
      if (result.status === 0 || !output.includes('p2a iteration init') || !output.includes('.plan2agent/artifacts/webhook-api-service')) {
        console.error(`init target did not require iteration init: ${label}`);
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
      if (result.status === 0 || !output.includes('iteration layout is incomplete') || output.includes('p2a iteration init')) {
        console.error('init partial iteration layout was not rejected with a repair diagnostic');
        writeResultOutput(result);
        return { status: 1, checks };
      }
    }

    const movedPartialArtifactRoot = path.join(targetRoot, '.plan2agent', 'artifacts', 'moved-partial-service');
    const movedPartialIterationRoot = path.join(movedPartialArtifactRoot, 'iterations', 'v1-mvp');
    cpSync(path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'), movedPartialArtifactRoot, { recursive: true });
    mkdirSync(movedPartialIterationRoot, { recursive: true });
    for (const gate of ['gate-a-intake', 'gate-b-spec', 'gate-c-task-graph']) {
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
    const enhanceCommand = (args) => quotedCommand([
      'node',
      path.join(enhanceTargetRoot, '.plan2agent', 'scripts', 'p2a.mjs'),
      ...args,
    ]);
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
      || enhancedConfig.devExecution?.reviewPasses?.monitor !== 'opt_in'
      || enhancedConfig.devExecution?.reviewPasses?.style !== 'off'
      || enhancedConfig.devExecution?.reviewPasses?.milestone !== 'off'
      || enhancedConfig.devExecution?.reviewPasses?.visual !== 'off'
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
      || !result.stdout.includes(`After creating an artifact root, check local/Memory sync: ${enhanceCommand(['memory', 'status', '--artifacts', '.plan2agent/artifacts/<project_id>'])}`)
      || !result.stdout.includes(`After Memory is configured, preview restore diff: ${enhanceCommand(['memory', 'pull', '--artifacts', '.plan2agent/artifacts/<project_id>', '--dry-run'])}`)
      || !result.stdout.includes(`After Memory contains snapshots, search project history: ${enhanceCommand(['memory', 'search', '--project', 'enhance-target', '--mode', 'hybrid', '--query', '<term>'])}`)
      || !result.stdout.includes(`After Memory contains snapshots, show timeline: ${enhanceCommand(['memory', 'history', '--artifacts', '.plan2agent/artifacts/<project_id>'])}`)
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
        && !result.stdout.includes(`After runs exist, mine proposal candidates: ${enhanceCommand(['proposals', 'mine', '--artifacts', '.plan2agent/artifacts/<project_id>', '--proposals', '.plan2agent/proposals', '--dry-run'])}`)
      ) {
        console.error('enhance proposals next-actions fixture failed');
        writeResultOutput(result);
        return { status: 1, checks };
      }
      if (
        capability === 'orchestration'
        && (
          !result.stdout.includes(`After a ready task exists, start supervised run with monitor gate: ${enhanceCommand(['execute', 'start', '--artifacts', '.plan2agent/artifacts/<project_id>', '--task', '<task-id>', '--agent-tool', 'codex', '--require-monitor'])}`)
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
      || enhancedCapabilityConfig.memory?.requestTimeoutMs !== 5000
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
      || enhancedCapabilityInfo.enhancements?.memory?.requestTimeoutMs !== 5000
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
      || !enhancedCapabilityDoctor.checks?.some((item) => item.id === 'capability_memory_timeout' && item.status === 'pass')
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

    const invalidReviewPassConfig = structuredClone(enhancedCapabilityConfig);
    invalidReviewPassConfig.devExecution.reviewPasses = {
      milestone: 'on',
      mile: 'on',
    };
    writeFileSync(enhanceConfigPath, `${JSON.stringify(invalidReviewPassConfig, null, 2)}\n`, 'utf8');
    result = runDoctor(['--target', enhanceTargetRoot, '--dev', '--json']);
    checks += 1;
    const invalidReviewPassDoctor = result.status === 0 ? JSON.parse(result.stdout) : null;
    writeFileSync(enhanceConfigPath, `${JSON.stringify(enhancedCapabilityConfig, null, 2)}\n`, 'utf8');
    if (
      result.status !== 0
      || !invalidReviewPassDoctor?.checks?.some((item) => (
        item.id === 'dev_execution_config'
        && item.status === 'warn'
        && item.detail.includes('devExecution.reviewPasses has unknown key(s): mile')
      ))
    ) {
      console.error('invalid review pass doctor fixture failed');
      writeResultOutput(result);
      console.error(JSON.stringify({ invalidReviewPassDoctor }, null, 2));
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

    const packageUpdateRoot = path.join(tempRoot, 'package-update-target');
    cpSync(targetRoot, packageUpdateRoot, { recursive: true });
    const packageManifestPath = path.join(packageUpdateRoot, '.plan2agent', 'manifest.json');
    const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
    delete packageManifest.provenance.toolkitRoot;
    packageManifest.runtime = { mode: 'package', command: 'p2a' };
    packageManifest.includedTools = packageManifest.includedTools.filter((item) => item.endsWith('_assets'));
    packageManifest.scriptFiles = [];
    packageManifest.schemaFiles = [];
    packageManifest.toolFiles = packageManifest.aiToolFiles;
    packageManifest.managedFiles = packageManifest.managedFiles.filter(
      (item) => !item.path.startsWith('.plan2agent/scripts/') && !item.path.startsWith('.plan2agent/schemas/'),
    );
    writeFileSync(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8');
    const packageGuidePath = path.join(packageUpdateRoot, 'PLAN2AGENT.md');
    writeFileSync(
      packageGuidePath,
      readFileSync(packageGuidePath, 'utf8')
        .replace('node .plan2agent/scripts/p2a.mjs next', 'p2a next'),
      'utf8',
    );
    rmSync(path.join(packageUpdateRoot, '.plan2agent', 'scripts'), { recursive: true, force: true });
    rmSync(path.join(packageUpdateRoot, '.plan2agent', 'schemas'), { recursive: true, force: true });
    const legacyRuntimePath = path.join(packageUpdateRoot, '.plan2agent', 'scripts', 'p2a_eval.mjs');
    mkdirSync(path.dirname(legacyRuntimePath), { recursive: true });
    writeFileSync(legacyRuntimePath, 'legacy project-local runtime\n', 'utf8');
    result = runTargetP2a(packageUpdateRoot, ['update', '--tools', 'none', '--dry-run']);
    checks += 1;
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update preview')
      || !result.stdout.includes('dry-run: no harness files written')
      || !result.stdout.includes('p2a update')
    ) {
      console.error('package runtime p2a update dispatch failed');
      writeResultOutput(result);
      return { status: failureStatus(result), checks };
    }
    result = runHandoff(['update', '--target', packageUpdateRoot, '--tools', 'none', '--apply']);
    checks += 1;
    const packageUpdatedManifest = JSON.parse(readFileSync(path.join(packageUpdateRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    if (
      result.status !== 0
      || !result.stdout.includes('Plan2Agent update apply')
      || readFileSync(legacyRuntimePath, 'utf8') !== 'legacy project-local runtime\n'
      || packageUpdatedManifest.runtime?.mode !== 'package'
      || packageUpdatedManifest.runtime?.command !== 'p2a'
    ) {
      console.error('package runtime update changed a legacy project-local runtime file');
      writeResultOutput(result);
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
  const canonicalMemoryProjectId = '2810dbd3-2cd5-5f09-8cfc-a9c2095404fe';

  let result = runMemory(['status', '--graph', graphPath]);
  checks += 1;
  if (
    result.status !== 0
    || !result.stdout.includes('Plan2Agent memory status')
    || !result.stdout.includes(`canonical project ID: ${canonicalMemoryProjectId}`)
    || !result.stdout.includes('documents=2')
    || !result.stdout.includes('taskGraphs=1')
  ) {
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
    || memoryStatusJson?.context?.projectId !== 'webhook-api-service'
    || memoryStatusJson?.context?.sourceProjectId !== 'webhook-api-service'
    || memoryStatusJson?.context?.canonicalProjectId !== canonicalMemoryProjectId
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
  if (
    result.status !== 0
    || !result.stdout.includes('Plan2Agent memory push dry run')
    || !result.stdout.includes(`canonical project ID: ${canonicalMemoryProjectId}`)
    || !result.stdout.includes('dry-run: no server writes')
    || !result.stdout.includes('DOCUMENT_CHUNK:')
  ) {
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
  if (
    result.status === 0
    || !result.stdout.includes('Plan2Agent memory search')
    || !result.stdout.includes(`canonical project ID: ${canonicalMemoryProjectId}`)
    || !result.stdout.includes('mode: requested=keyword effective=not_executed')
    || !result.stdout.includes('server: not_configured')
    || !result.stdout.includes('Set P2A_MEMORY_URL or pass --server to search Memory.')
  ) {
    console.error('memory search not-configured fixture failed');
    writeResultOutput(result);
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['search', '--project', 'webhook-api-service', '--mode', 'hybrid', '--query', 'webhook', '--json']);
  checks += 1;
  const projectHybridSearchPayload = result.stdout ? JSON.parse(result.stdout) : null;
  if (
    result.status === 0
    || projectHybridSearchPayload?.query?.mode !== 'hybrid'
    || projectHybridSearchPayload?.query?.scope !== 'project'
    || projectHybridSearchPayload?.context?.projectId !== 'webhook-api-service'
    || projectHybridSearchPayload?.context?.canonicalProjectId !== canonicalMemoryProjectId
    || projectHybridSearchPayload?.context?.iterationId !== null
  ) {
    console.error('memory project-wide hybrid search fixture failed');
    writeResultOutput(result);
    console.error(JSON.stringify({ projectHybridSearchPayload }, null, 2));
    return { status: result.status === 0 ? 1 : failureStatus(result), checks };
  }

  result = runMemory(['search', '--project', 'webhook-api-service', '--mode', 'invalid', '--query', 'webhook']);
  checks += 1;
  if (result.status === 0 || !result.stderr.includes('unsupported Memory search mode')) {
    console.error('memory search mode validation fixture failed');
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
    || !result.stdout.includes(`canonical project ID: ${canonicalMemoryProjectId}`)
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
      || !result.stdout.includes('Summarize maintenance candidates: p2a memory digest --runs')
      || !result.stdout.includes('Analyze failure clusters: p2a eval analyze --runs')
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
  for (const key of ['artifactRoot', 'statusPath', 'iterationRoot', 'currentSpecPath', 'effectiveSpecPath', 'specPath', 'taskGraphPath']) {
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
    const targetRoot = path.join(tempRoot, name);
    const sourceRoot = path.join(E2E_FIXTURE_ROOT, 'webhook-api-service');
    const graphPath = path.join(targetRoot, 'gate-c-task-graph', 'task-graph.json');
    mkdirSync(path.dirname(graphPath), { recursive: true });
    cpSync(path.join(sourceRoot, 'gate-a-intake'), path.join(targetRoot, 'gate-a-intake'), { recursive: true });
    cpSync(path.join(sourceRoot, 'gate-b-spec'), path.join(targetRoot, 'gate-b-spec'), { recursive: true });
    cpSync(path.join(sourceRoot, 'gate-c-task-graph', 'task-graph.json'), graphPath);
    return graphPath;
  }

  function copyTaskSourceProvenance(state, targetRoot) {
    const sourceSpecDir = path.dirname(state.specPath);
    cpSync(
      path.join(path.dirname(sourceSpecDir), 'gate-a-intake'),
      path.join(targetRoot, 'gate-a-intake'),
      { recursive: true },
    );
    cpSync(sourceSpecDir, path.join(targetRoot, 'gate-b-spec'), { recursive: true });
  }

  function copyCurrentTaskGraph(state, graphPath) {
    const targetRoot = path.dirname(path.dirname(graphPath));
    mkdirSync(path.dirname(graphPath), { recursive: true });
    copyTaskSourceProvenance(state, targetRoot);
    writeFileSync(graphPath, readFileSync(state.taskGraphPath, 'utf8'), 'utf8');
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
      cpSync(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), path.join(markdownOnlyRoot, 'gate-a-intake', 'intake.json'));
      writeFileSync(path.join(markdownOnlyRoot, 'gate-b-spec', 'product-spec.md'), '# generated product spec view\n', 'utf8');
      writeFileSync(path.join(markdownOnlyRoot, 'gate-b-spec', 'implementation-plan.md'), '# generated implementation plan view\n', 'utf8');
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
      copyCurrentTaskGraph(state, crossCwdGraphPath);
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
      copyCurrentTaskGraph(state, executeGraphPath);
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
        || !result.stdout.includes('p2a execute status')
        || !result.stdout.includes('p2a execute finish')
        || !result.stdout.includes('p2a proposals mine')
      ) {
        console.error(`p2a_execute resume fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const executeIsolationGraphPath = path.join(tempRoot, 'p2a-execute-isolation', 'gate-c-task-graph', 'task-graph.json');
      const executeIsolationWorkspace = path.join(tempRoot, 'execute-isolation-workspace');
      const executeIsolationWorktree = path.join(tempRoot, 'execute-isolation-worktree');
      copyCurrentTaskGraph(state, executeIsolationGraphPath);
      mkdirSync(executeIsolationWorkspace, { recursive: true });
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
      copyTaskSourceProvenance(state, path.dirname(path.dirname(executeMonitorGraphPath)));
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
        || !result.stdout.includes('p2a tasks prompt')
        || !result.stdout.includes('p2a execute start')
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
      copyCurrentTaskGraph(state, executeFailedGraphPath);
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
      copyCurrentTaskGraph(state, executeSkippedGraphPath);
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
        || !result.stdout.includes(`resume: p2a `)
        || !result.stdout.includes(`p2a execute resume --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
        || !result.stdout.includes(`status: p2a `)
        || !result.stdout.includes(`p2a execute status --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
        || !result.stdout.includes(`finish: p2a `)
        || !result.stdout.includes(`p2a execute finish --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId} --test --lint --typecheck`)
        || !result.stdout.includes(`review: p2a `)
        || !result.stdout.includes(`p2a proposals mine --artifacts ${quotedArtifactRoot} --run-id ${fixtureRunId}`)
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
      if (result.status === 0 || !skipCloseOpenOutput.includes('archived by `p2a iteration close`')) {
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

      const lateArtifactRef = 'iterations/v1-mvp/gate-c-task-graph/late-note.md';
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
        console.error(`iteration validate did not reject open skeleton without Gate B/C artifacts: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      writeFeatureRadarPreflightFixture(artifactRoot);
      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Gate A scope confirmation required') || !result.stdout.includes('Feature Radar preflight')) {
        console.error(`iteration Gate A scope draft fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const draftIntakePath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-a-intake', 'intake.json');
      const draftIntakeViewPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-a-intake', 'intake.md');
      const draftSpecPath = path.join(artifactRoot, 'iterations', 'iter-002', 'gate-b-spec', 'spec.json');
      const scopeDraft = JSON.parse(readFileSync(draftIntakePath, 'utf8'));
      const baselineDeltaQuestion = scopeDraft.clarifying_questions
        .find((item) => item.id === 'CQ-3');
      if (
        existsSync(draftSpecPath)
        || Object.hasOwn(scopeDraft, 'interview')
        || !scopeDraft.baseline_context
        || !scopeDraft.baseline_context.reused_answers.length
        || !scopeDraft.baseline_context.reused_question_dispositions.length
        || !baselineDeltaQuestion?.question.includes('baseline')
        || existsSync(draftIntakeViewPath)
      ) {
        console.error(`iteration Gate A scope draft did not enforce silent JSON-only persistence or baseline reuse context: ${caseData.id}`);
        console.error(JSON.stringify(scopeDraft, null, 2));
        return { status: 1, checks };
      }
      result = runIteration([
        'draft',
        '--artifacts',
        artifactRoot,
        '--idea',
        'A different idea that was not approved',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !result.stderr.includes('does not match existing Gate A intake idea')
      ) {
        console.error(`iteration draft did not reject an idea that differs from the existing Gate A intake: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      const intakeAfterRejectedIdea = JSON.parse(readFileSync(draftIntakePath, 'utf8'));
      const currentSpecAfterRejectedIdea = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
      if (
        intakeAfterRejectedIdea.idea !== scopeDraft.idea
        || currentSpecAfterRejectedIdea.pending_iteration?.idea !== scopeDraft.idea
      ) {
        console.error(`rejected draft idea mutated Gate A/current-spec state: ${caseData.id}`);
        console.error(JSON.stringify({
          intakeIdea: intakeAfterRejectedIdea.idea,
          pendingIdea: currentSpecAfterRejectedIdea.pending_iteration?.idea,
          expected: scopeDraft.idea,
        }, null, 2));
        return { status: 1, checks };
      }
      confirmScopeIntake(
        draftIntakePath,
        'iterations/iter-002/gate-a-intake/intake.json',
      );
      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated') || !result.stdout.includes('Feature Radar preflight')) {
        console.error(`iteration Gate B draft after Gate A confirmation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

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
      if (
        !draftSpec.product.target_users.some((item) => item.includes(DISCOVERY_FIXTURE_DECISION_ANSWER))
        || !draftSpec.product.success_criteria.some((item) => item.includes(DISCOVERY_FIXTURE_ANSWERS['CQ-1']))
        || !draftSpec.product.success_criteria.some((item) => item.includes(DISCOVERY_FIXTURE_DECISION_ANSWER))
        || !draftSpec.product.goals.some((item) => item.includes(DISCOVERY_FIXTURE_ANSWERS['CQ-2']))
        || !draftSpec.product.external_integrations.some((item) => item.includes(DISCOVERY_FIXTURE_ANSWERS['CQ-3']))
        || !draftSpec.implementation.verification.some((item) => item.includes(DISCOVERY_FIXTURE_ANSWERS['CQ-1']))
        || !draftSpec.implementation.interfaces.some((item) => item.includes(DISCOVERY_FIXTURE_ANSWERS['CQ-3']))
      ) {
        console.error(`iteration Gate B draft dropped approved Gate A scope content: ${caseData.id}`);
        console.error(JSON.stringify({ product: draftSpec.product, implementation: draftSpec.implementation }, null, 2));
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

      result = runIteration([
        'promote-tasks',
        '--artifacts',
        artifactRoot,
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
      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('close-ready: all tasks done')) {
        console.error(`iteration validate did not accept validated Gate A-C iter-002 fixture: ${caseData.id}`);
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
      if (result.status === 0 || !beforeComposeOpenOutput.includes('run `p2a iteration compose` first')) {
        console.error(`iteration open fixture did not require composition after multiple closes: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      const iter2MetadataPath = path.join(artifactRoot, 'iterations', 'iter-002', 'iteration.json');
      const originalIter2MetadataText = readFileSync(iter2MetadataPath, 'utf8');
      const currentSpecBeforeConflictCompose = readFileSync(state.currentSpecPath, 'utf8');
      const staleIterationId = 'iter-stale-baseline';
      const staleIterationRoot = path.join(artifactRoot, 'iterations', staleIterationId);
      cpSync(
        path.join(artifactRoot, 'iterations', 'v1-mvp'),
        staleIterationRoot,
        { recursive: true },
      );
      const conflictIter2Metadata = JSON.parse(originalIter2MetadataText);
      conflictIter2Metadata.opened_at = '2026-01-02T00:00:00.000Z';
      const staleMetadataPath = path.join(staleIterationRoot, 'iteration.json');
      const staleMetadata = JSON.parse(readFileSync(staleMetadataPath, 'utf8'));
      staleMetadata.iteration_id = staleIterationId;
      staleMetadata.opened_at = '2026-01-03T00:00:00.000Z';
      staleMetadata.baseline = {
        iteration_id: 'v1-mvp',
        effective_spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
      };
      writeFileSync(iter2MetadataPath, `${JSON.stringify(conflictIter2Metadata, null, 2)}\n`, 'utf8');
      writeFileSync(staleMetadataPath, `${JSON.stringify(staleMetadata, null, 2)}\n`, 'utf8');
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
      rmSync(staleIterationRoot, { recursive: true, force: true });

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
        || !result.stdout.includes('p2a execute start')
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
      const composedVisualIterationId = 'v1-mvp';
      const composedVisualGateBRoot = path.join(
        milestoneHandoffArtifactRoot,
        'iterations',
        composedVisualIterationId,
        'gate-b-spec',
      );
      writeSyntheticApprovedVisualBundle(
        composedVisualGateBRoot,
        caseData.project_id,
        'Composed visual history',
      );
      const composedVisualExperiencePath = path.join(composedVisualGateBRoot, 'experience-spec.json');
      const composedVisualExperience = JSON.parse(readFileSync(composedVisualExperiencePath, 'utf8'));
      composedVisualExperience.mode = 'reuse';
      composedVisualExperience.design_system.strategy = 'existing';
      composedVisualExperience.design_system.references = ['src/ui-system.css'];
      composedVisualExperience.validation.visual_review_required = false;
      const composedVisualExperienceText = `${JSON.stringify(composedVisualExperience, null, 2)}\n`;
      writeFileSync(composedVisualExperiencePath, composedVisualExperienceText, 'utf8');
      const composedVisualSpecRef = `iterations/${composedVisualIterationId}/gate-b-spec/spec.json`;
      const composedVisualSpecPath = path.join(milestoneHandoffArtifactRoot, composedVisualSpecRef);
      const composedVisualSpec = JSON.parse(readFileSync(composedVisualSpecPath, 'utf8'));
      composedVisualSpec.source_intake = '../gate-a-intake/./intake.json';
      composedVisualSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'reuse',
        design_timing: 'current_iteration',
        rationale: 'The composed source keeps its approved reusable visual contract portable.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: hashText(composedVisualExperienceText),
        design_system_refs: ['src/ui-system.css'],
      };
      if (!composedVisualSpec.approval_audit.approved_artifacts.includes('experience-spec.json')) {
        composedVisualSpec.approval_audit.approved_artifacts.push('experience-spec.json');
      }
      const composedVisualSpecText = `${JSON.stringify(composedVisualSpec, null, 2)}\n`;
      writeFileSync(composedVisualSpecPath, composedVisualSpecText, 'utf8');
      const composedDependentIntakePath = path.join(
        milestoneHandoffArtifactRoot,
        'iterations',
        'iter-002',
        'gate-a-intake',
        'intake.json',
      );
      const composedDependentIntake = JSON.parse(readFileSync(composedDependentIntakePath, 'utf8'));
      composedDependentIntake.baseline_context.spec_sha256 = hashText(composedVisualSpecText);
      const composedDependentIntakeText = `${JSON.stringify(composedDependentIntake, null, 2)}\n`;
      writeFileSync(composedDependentIntakePath, composedDependentIntakeText, 'utf8');
      const composedDependentSpecPath = path.join(
        milestoneHandoffArtifactRoot,
        'iterations',
        'iter-002',
        'gate-b-spec',
        'spec.json',
      );
      const composedDependentSpec = JSON.parse(readFileSync(composedDependentSpecPath, 'utf8'));
      composedDependentSpec.source_intake_sha256 = hashText(composedDependentIntakeText);
      writeFileSync(
        composedDependentSpecPath,
        `${JSON.stringify(composedDependentSpec, null, 2)}\n`,
        'utf8',
      );
      const composedVisualArtifactRefs = [
        `iterations/${composedVisualIterationId}/gate-b-spec/experience-spec.json`,
        `iterations/${composedVisualIterationId}/gate-b-spec/visual-design/VD-1/prototype.json`,
        `iterations/${composedVisualIterationId}/gate-b-spec/visual-design/VD-1/index.html`,
        `iterations/${composedVisualIterationId}/gate-b-spec/visual-design/VD-2/prototype.json`,
        `iterations/${composedVisualIterationId}/gate-b-spec/visual-design/VD-2/index.html`,
      ];
      const composedCurrentSpecPath = path.join(milestoneHandoffArtifactRoot, 'current-spec.json');
      const composedCurrentSpecForHandoff = JSON.parse(readFileSync(composedCurrentSpecPath, 'utf8'));
      const composedClosedIteration = composedCurrentSpecForHandoff.closed_iterations.find(
        (closed) => closed.iteration_id === composedVisualIterationId,
      );
      composedClosedIteration.artifact_hashes[composedVisualSpecRef] = {
        present: true,
        sha256: hashText(composedVisualSpecText),
      };
      for (const reference of composedVisualArtifactRefs) {
        composedClosedIteration.artifact_hashes[reference] = {
          present: true,
          sha256: hashText(readFileSync(path.join(milestoneHandoffArtifactRoot, reference))),
        };
      }
      writeFileSync(
        composedCurrentSpecPath,
        `${JSON.stringify(composedCurrentSpecForHandoff, null, 2)}\n`,
        'utf8',
      );
      const milestoneTaskGraphRef = 'iterations/iter-002/gate-c-task-graph/task-graph.json';
      const milestoneSpecRef = 'iterations/iter-002/gate-b-spec/spec.json';
      const milestoneVisualArtifacts = writeSyntheticApprovedVisualBundle(
        path.join(milestoneHandoffArtifactRoot, 'iterations', 'iter-002', 'gate-b-spec'),
        caseData.project_id,
      );
      const milestoneVisualArtifactRefs = [
        'iterations/iter-002/gate-b-spec/experience-spec.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-1/prototype.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-1/index.html',
        'iterations/iter-002/gate-b-spec/visual-design/VD-2/prototype.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-2/index.html',
      ];
      const milestoneSpecPath = path.join(milestoneHandoffArtifactRoot, milestoneSpecRef);
      const milestoneSpec = JSON.parse(readFileSync(milestoneSpecPath, 'utf8'));
      milestoneSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'Synthetic milestone evidence binds one run to an approved visual experience.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: milestoneVisualArtifacts.experienceSpecSha256,
      };
      const milestoneExperienceApprovalRef = 'iterations/iter-002/gate-b-spec/experience-spec.json';
      if (!milestoneSpec.approval_audit.approved_artifacts.includes(milestoneExperienceApprovalRef)) {
        milestoneSpec.approval_audit.approved_artifacts.push(milestoneExperienceApprovalRef);
      }
      writeFileSync(milestoneSpecPath, `${JSON.stringify(milestoneSpec, null, 2)}\n`, 'utf8');
      const milestoneTaskGraphPath = path.join(milestoneHandoffArtifactRoot, milestoneTaskGraphRef);
      const milestoneTaskGraph = JSON.parse(readFileSync(milestoneTaskGraphPath, 'utf8'));
      milestoneTaskGraph.sourceSpec = '../gate-b-spec/spec.json';
      for (const [taskIndex, task] of milestoneTaskGraph.tasks.entries()) {
        task.status = 'done';
        task.workKind = taskIndex === 0 ? 'ui' : 'non_ui';
        if (taskIndex === 0) {
          task.visualImpact = {
            screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
          };
        }
      }
      const milestoneTaskGraphText = `${JSON.stringify(milestoneTaskGraph, null, 2)}\n`;
      writeFileSync(milestoneTaskGraphPath, milestoneTaskGraphText, 'utf8');
      const milestoneClosedIteration = composedCurrentSpecForHandoff.closed_iterations.find(
        (closed) => closed.iteration_id === 'iter-002',
      );
      for (const reference of milestoneVisualArtifactRefs) {
        milestoneClosedIteration.artifact_hashes[reference] = {
          present: true,
          sha256: hashText(readFileSync(path.join(milestoneHandoffArtifactRoot, reference))),
        };
      }
      if (composedCurrentSpecForHandoff.last_closed_iteration?.iteration_id === 'iter-002') {
        composedCurrentSpecForHandoff.last_closed_iteration.artifact_hashes = structuredClone(
          milestoneClosedIteration.artifact_hashes,
        );
      }
      writeFileSync(
        composedCurrentSpecPath,
        `${JSON.stringify(composedCurrentSpecForHandoff, null, 2)}\n`,
        'utf8',
      );

      const historicalVisualRootRef = 'run-sources/historical-visual';
      const historicalTaskGraphRef = `${historicalVisualRootRef}/gate-c-task-graph/task-graph.json`;
      const historicalSpecRef = '../gate-b-spec/spec.json';
      const historicalGateBRoot = path.join(
        milestoneHandoffArtifactRoot,
        historicalVisualRootRef,
        'gate-b-spec',
      );
      const historicalVisualArtifacts = writeSyntheticApprovedVisualBundle(
        historicalGateBRoot,
        caseData.project_id,
        'Historical visual contract',
      );
      const historicalVisualRoot = path.join(
        milestoneHandoffArtifactRoot,
        historicalVisualRootRef,
      );
      const historicalIntakePath = path.join(
        historicalVisualRoot,
        'gate-a-intake',
        'intake.json',
      );
      mkdirSync(path.dirname(historicalIntakePath), { recursive: true });
      cpSync(composedDependentIntakePath, historicalIntakePath);
      cpSync(
        path.join(milestoneHandoffArtifactRoot, 'iterations'),
        path.join(historicalVisualRoot, 'iterations'),
        { recursive: true },
      );
      cpSync(
        composedCurrentSpecPath,
        path.join(historicalVisualRoot, 'current-spec.json'),
      );
      const historicalIntake = JSON.parse(readFileSync(historicalIntakePath, 'utf8'));
      const historicalBaselineDependencyRefs = [
        historicalIntake.baseline_context.spec_ref,
        ...(historicalIntake.baseline_context.reused_answers ?? [])
          .map((item) => item.source_intake),
        ...(historicalIntake.baseline_context.reused_question_dispositions ?? [])
          .map((item) => item.source_spec),
      ].map((reference) => `${historicalVisualRootRef}/${reference}`);
      const historicalSpec = structuredClone(milestoneSpec);
      historicalSpec.source_intake = '../gate-a-intake/intake.json';
      historicalSpec.source_intake_sha256 = hashText(readFileSync(historicalIntakePath));
      historicalSpec.visual_experience = {
        has_visual_interface: true,
        design_scope: 'full',
        design_timing: 'current_iteration',
        rationale: 'Historical run evidence remains bound to its original approved visual contract.',
        experience_spec_ref: 'experience-spec.json',
        experience_spec_sha256: historicalVisualArtifacts.experienceSpecSha256,
      };
      historicalSpec.approval_audit = {
        approved_by: 'fixture-owner',
        approved_at: '2026-07-10T23:59:00.000Z',
        approved_artifacts: ['experience-spec.json'],
        approval_note: 'Synthetic historical visual contract approved for provenance testing.',
      };
      writeFileSync(
        path.join(historicalGateBRoot, 'spec.json'),
        `${JSON.stringify(historicalSpec, null, 2)}\n`,
        'utf8',
      );
      const historicalTaskGraphPath = path.join(milestoneHandoffArtifactRoot, historicalTaskGraphRef);
      mkdirSync(path.dirname(historicalTaskGraphPath), { recursive: true });
      writeFileSync(historicalTaskGraphPath, `${JSON.stringify({
        schema_version: 'p2a.task_graph.v1',
        projectId: caseData.project_id,
        version: 'iter-historical',
        sourceSpec: historicalSpecRef,
        tasks: [{
          id: 'task-999',
          title: 'Preserve historical visual provenance',
          description: 'Retain the approved historical visual evidence bundle.',
          status: 'done',
          dependencies: [],
          acceptanceCriteria: ['The historical visual evidence remains portable and verifiable.'],
          targetArea: 'ui',
          workKind: 'ui',
          suggestedAgentPrompt: 'Verify and preserve the historical visual evidence.',
          sourceSpecRefs: ['visual_experience'],
          visualImpact: {
            screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
          },
        }],
      }, null, 2)}\n`, 'utf8');

      const externalSourceRoot = path.join(tempRoot, 'external-approved-source');
      cpSync(
        path.join(milestoneHandoffArtifactRoot, 'iterations'),
        path.join(externalSourceRoot, 'iterations'),
        { recursive: true },
      );
      cpSync(
        composedCurrentSpecPath,
        path.join(externalSourceRoot, 'current-spec.json'),
      );
      const externalSourceSpecPath = path.join(
        externalSourceRoot,
        milestoneSpecRef,
      );
      const internalGraphExternalSpecRef = 'run-sources/internal-graph-external-spec/task-graph.json';
      const internalGraphExternalSpecPath = path.join(
        milestoneHandoffArtifactRoot,
        internalGraphExternalSpecRef,
      );
      const internalGraphExternalSpec = structuredClone(milestoneTaskGraph);
      internalGraphExternalSpec.sourceSpec = externalSourceSpecPath;
      mkdirSync(path.dirname(internalGraphExternalSpecPath), { recursive: true });
      writeFileSync(
        internalGraphExternalSpecPath,
        `${JSON.stringify(internalGraphExternalSpec, null, 2)}\n`,
        'utf8',
      );

      const milestoneRunsDir = path.join(milestoneHandoffArtifactRoot, 'runs');
      rmSync(milestoneRunsDir, { recursive: true, force: true });
      mkdirSync(milestoneRunsDir, { recursive: true });
      const milestoneRunStartedAt = '2026-07-11T00:00:00.000Z';
      const milestoneRunFinishedAt = '2026-07-11T00:01:00.000Z';
      const milestoneGeneratedAt = '2026-07-11T00:02:00.000Z';
      const milestoneRunIndexEntries = [];
      const milestoneRunIndexTasks = [];
      const milestoneCompletedTaskEvidence = [];
      const milestoneVisualRunId = `run-milestone-${milestoneTaskGraph.tasks[0].id}`;
      const milestoneVisualEvidenceBase = `visual-evidence/iter-002/${milestoneVisualRunId}`;
      const milestoneVisualCanonicalBase = `${milestoneVisualEvidenceBase}/canonical`;
      const milestoneVisualAliasBase = `${milestoneVisualEvidenceBase}/capture-alias`;
      const milestoneVisualScreenshotRef = `${milestoneVisualAliasBase}/screen-1-ready-desktop.png`;
      const milestoneVisualAccessibilityRef = `${milestoneVisualAliasBase}/accessibility.json`;
      const milestoneVisualSidecarRef = `runs/${milestoneVisualRunId}.visual-review.json`;
      const historicalVisualRunId = 'run-historical-visual';
      const historicalVisualTaskId = 'task-999';
      const historicalVisualIterationId = 'iter-historical';
      const historicalVisualEvidenceBase = `visual-evidence/${historicalVisualIterationId}/${historicalVisualRunId}`;
      const historicalVisualScreenshotRef = `${historicalVisualEvidenceBase}/screen-1-ready-desktop.png`;
      const historicalVisualAccessibilityRef = `${historicalVisualEvidenceBase}/accessibility.json`;
      const historicalVisualSidecarRef = `runs/${historicalVisualRunId}.visual-review.json`;
      const startedVisualRunId = 'run-started-visual-handoff-rejected';
      const maintenanceRunId = 'run-maintenance-portable';
      const maintenanceTaskId = 'task-900';
      const maintenanceTaskGraphRef = 'iterations/maintenance/gate-c-task-graph/task-graph.json';
      const unfinishedGraphRunId = 'run-unfinished-graph-portable';
      const unfinishedGraphRef = 'run-sources/unfinished-graph/task-graph.json';
      const relativeSymlinkGraphRunId = 'run-relative-symlink-graph-portable';
      const relativeSymlinkGraphAliasRef = 'run-sources/relative-graph-alias';
      const relativeSymlinkGraphRef = `${relativeSymlinkGraphAliasRef}/task-graph.json`;
      const internalAbsoluteSourceRunId = 'run-internal-absolute-source-portable';
      const internalAbsoluteSourceGraphRef = 'run-sources/internal-absolute-source/task-graph.json';
      const symlinkedAbsoluteSourceRunId = 'run-symlinked-absolute-source-portable';
      const symlinkedAbsoluteSourceGraphRef = 'run-sources/symlinked-absolute-source/task-graph.json';
      const artifactRootAliasRef = 'run-sources/artifact-root-alias';
      const legacyV1UnfinishedRunId = 'run-legacy-v1-unfinished-portable';
      const legacyV1UnfinishedRootRef = 'run-sources/legacy-v1-unfinished';
      const legacyV1UnfinishedGraphRef = `${legacyV1UnfinishedRootRef}/gate-c-task-graph/task-graph.json`;
      const externalGraphRunId = 'run-external-graph-omitted';
      const externalSourceRunId = 'run-external-source-omitted';
      const externalStartedVisualRunId = 'run-external-source-started-visual-omitted';
      for (const [taskIndex, task] of milestoneTaskGraph.tasks.entries()) {
        const runId = `run-milestone-${task.id}`;
        const changedFiles = taskIndex === 0 ? [] : [`src/${task.id}.mjs`];
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
          schema_version: 'p2a.run.v2',
          runId,
          projectId: caseData.project_id,
          taskId: task.id,
          taskTitle: task.title,
          iterationId: 'iter-002',
          sourceLayout: 'iteration',
          taskGraphRef: milestoneTaskGraphRef,
          sourceSpecRef: milestoneTaskGraph.sourceSpec,
          taskContractSha256: taskContractSha256(task),
          agentTool: 'codex',
          workspaceRef: 'milestone-handoff-fixture',
          workspacePath: '.',
          workspaceRevisionSha256: hashText('milestone-handoff-fixture-revision'),
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
        if (taskIndex === 0) {
          run.runKind = 'final_visual_review';
          run.visualReview = {
            required: true,
            experienceSpecRef: 'experience-spec.json',
            experienceSpecSha256: milestoneVisualArtifacts.experienceSpecSha256,
            prototypeManifestRef: 'visual-design/VD-1/prototype.json',
            prototypeManifestSha256: milestoneVisualArtifacts.prototypeManifestSha256,
            screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
            viewports: [{ name: 'desktop', width: 240, height: 240 }],
            accessibilityStandard: 'WCAG 2.2 AA',
          };
          const canonicalEvidenceDir = path.join(
            milestoneHandoffArtifactRoot,
            milestoneVisualCanonicalBase,
          );
          const aliasEvidenceDir = path.join(
            milestoneHandoffArtifactRoot,
            milestoneVisualAliasBase,
          );
          mkdirSync(canonicalEvidenceDir, { recursive: true });
          symlinkSync(
            path.relative(path.dirname(aliasEvidenceDir), canonicalEvidenceDir),
            aliasEvidenceDir,
            'dir',
          );
          const screenshotPath = path.join(canonicalEvidenceDir, 'screen-1-ready-desktop.png');
          const accessibilityPath = path.join(canonicalEvidenceDir, 'accessibility.json');
          writePng(screenshotPath, 240, 240);
          mkdirSync(path.dirname(accessibilityPath), { recursive: true });
          const accessibilityText = `${JSON.stringify({
            schema_version: 'p2a.visual_accessibility_report.v1',
            tool: 'axe-core',
            standard: 'WCAG 2.2 AA',
            scanned_at: milestoneRunFinishedAt,
            page_urls: ['http://127.0.0.1:4173/reviews/1'],
            violations: [],
          }, null, 2)}\n`;
          writeFileSync(accessibilityPath, accessibilityText, 'utf8');
          const visualReview = {
            schema_version: 'p2a.visual_review.v2',
            run_id: runId,
            iteration_id: run.iterationId,
            workspace_ref: run.workspaceRef,
            workspace_revision_sha256: run.workspaceRevisionSha256,
            source_experience_ref: run.visualReview.experienceSpecRef,
            source_prototype_ref: run.visualReview.prototypeManifestRef,
            reviewed_at: milestoneRunFinishedAt,
            results: [{
              screen_id: 'SCREEN-1',
              state: 'ready',
              viewport: 'desktop',
              artifact_ref: milestoneVisualScreenshotRef,
              artifact_sha256: hashText(readFileSync(screenshotPath)),
              media_type: 'image/png',
              width: 240,
              height: 240,
              capture_url: 'http://127.0.0.1:4173/reviews/1',
              captured_at: milestoneRunFinishedAt,
              status: 'passed',
              concerns: [],
            }],
            accessibility: {
              status: 'passed',
              report_ref: milestoneVisualAccessibilityRef,
              report_sha256: hashText(accessibilityText),
              standard: 'WCAG 2.2 AA',
              critical_violations: 0,
            },
            verdict: 'confirm_ui',
            concerns: [],
            note: 'Synthetic visual review evidence for milestone handoff.',
          };
          const visualReviewText = `${JSON.stringify(visualReview, null, 2)}\n`;
          run.visualReviewEvidenceSha256 = hashText(visualReviewText);
          writeFileSync(
            path.join(milestoneRunsDir, `${runId}.visual-review.json`),
            visualReviewText,
            'utf8',
          );
        }
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
          workspace_ref: run.workspaceRef,
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

      const legacyGraphRunId = 'run-legacy-graph-portable';
      const legacyGraphTask = milestoneTaskGraph.tasks.find((task) => !task.visualImpact);
      const legacyGraphRun = {
        schema_version: 'p2a.run.v2',
        runId: legacyGraphRunId,
        projectId: caseData.project_id,
        taskId: legacyGraphTask.id,
        taskTitle: legacyGraphTask.title,
        iterationId: 'iter-002',
        sourceLayout: 'graph',
        taskGraphRef: milestoneTaskGraphPath,
        sourceSpecRef: milestoneSpecPath,
        taskContractSha256: taskContractSha256(legacyGraphTask),
        agentTool: 'codex',
        workspaceRef: 'legacy-graph-handoff-fixture',
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
        changedFiles: ['src/legacy-graph-portable.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test legacy-graph-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic legacy graph-mode provenance with an absolute in-root task graph reference.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${legacyGraphRunId}.json`),
        `${JSON.stringify(legacyGraphRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: legacyGraphRunId,
        taskId: legacyGraphTask.id,
        iterationId: legacyGraphRun.iterationId,
        status: 'finished',
        agentTool: legacyGraphRun.agentTool,
        workspaceRef: legacyGraphRun.workspaceRef,
        taskGraphRef: legacyGraphRun.taskGraphRef,
        runRef: `${legacyGraphRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      const legacyGraphTaskIndex = milestoneRunIndexTasks.find(
        (task) => task.taskId === legacyGraphTask.id,
      );
      legacyGraphTaskIndex.runIds.push(legacyGraphRunId);
      legacyGraphTaskIndex.latestRunId = legacyGraphRunId;

      const unfinishedGraphPath = path.join(milestoneHandoffArtifactRoot, unfinishedGraphRef);
      const unfinishedGraph = structuredClone(milestoneTaskGraph);
      unfinishedGraph.sourceSpec = '../../iterations/iter-002/gate-b-spec/spec.json';
      mkdirSync(path.dirname(unfinishedGraphPath), { recursive: true });
      writeFileSync(unfinishedGraphPath, `${JSON.stringify(unfinishedGraph, null, 2)}\n`, 'utf8');
      const unfinishedGraphRun = {
        schema_version: 'p2a.run.v2',
        runId: unfinishedGraphRunId,
        projectId: caseData.project_id,
        taskId: legacyGraphTask.id,
        taskTitle: legacyGraphTask.title,
        iterationId: 'iter-002',
        sourceLayout: 'graph',
        taskGraphRef: unfinishedGraphPath,
        sourceSpecRef: unfinishedGraph.sourceSpec,
        taskContractSha256: taskContractSha256(legacyGraphTask),
        agentTool: 'codex',
        workspaceRef: 'unfinished-graph-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
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
        status: 'started',
        startedAt: milestoneRunStartedAt,
        updatedAt: milestoneRunStartedAt,
        finishedAt: null,
        changedFiles: [],
        verification: [{
          type: 'test',
          command: 'node --test unfinished-graph-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic unfinished graph run whose source bundle must remain finishable after handoff.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${unfinishedGraphRunId}.json`),
        `${JSON.stringify(unfinishedGraphRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: unfinishedGraphRunId,
        taskId: legacyGraphTask.id,
        iterationId: unfinishedGraphRun.iterationId,
        status: 'started',
        agentTool: unfinishedGraphRun.agentTool,
        workspaceRef: unfinishedGraphRun.workspaceRef,
        taskGraphRef: unfinishedGraphRun.taskGraphRef,
        runRef: `${unfinishedGraphRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: null,
      });
      legacyGraphTaskIndex.runIds.push(unfinishedGraphRunId);
      legacyGraphTaskIndex.latestRunId = unfinishedGraphRunId;

      symlinkSync(
        path.basename(path.dirname(unfinishedGraphRef)),
        path.join(milestoneHandoffArtifactRoot, relativeSymlinkGraphAliasRef),
        'dir',
      );
      const relativeSymlinkGraphRun = {
        ...legacyGraphRun,
        runId: relativeSymlinkGraphRunId,
        taskGraphRef: relativeSymlinkGraphRef,
        sourceSpecRef: unfinishedGraph.sourceSpec,
        workspaceRef: 'relative-symlink-graph-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        changedFiles: ['src/relative-symlink-graph-portable.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test relative-symlink-graph-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic relative directory symlink task graph reference that must be canonicalized.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${relativeSymlinkGraphRunId}.json`),
        `${JSON.stringify(relativeSymlinkGraphRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: relativeSymlinkGraphRunId,
        taskId: legacyGraphTask.id,
        iterationId: relativeSymlinkGraphRun.iterationId,
        status: 'finished',
        agentTool: relativeSymlinkGraphRun.agentTool,
        workspaceRef: relativeSymlinkGraphRun.workspaceRef,
        taskGraphRef: relativeSymlinkGraphRun.taskGraphRef,
        runRef: `${relativeSymlinkGraphRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      legacyGraphTaskIndex.runIds.push(relativeSymlinkGraphRunId);
      legacyGraphTaskIndex.latestRunId = relativeSymlinkGraphRunId;

      const internalAbsoluteSourceGraphPath = path.join(
        milestoneHandoffArtifactRoot,
        internalAbsoluteSourceGraphRef,
      );
      const internalAbsoluteSourceGraph = structuredClone(milestoneTaskGraph);
      internalAbsoluteSourceGraph.sourceSpec = milestoneSpecPath;
      mkdirSync(path.dirname(internalAbsoluteSourceGraphPath), { recursive: true });
      writeFileSync(
        internalAbsoluteSourceGraphPath,
        `${JSON.stringify(internalAbsoluteSourceGraph, null, 2)}\n`,
        'utf8',
      );
      const internalAbsoluteSourceRun = {
        ...legacyGraphRun,
        runId: internalAbsoluteSourceRunId,
        taskGraphRef: internalAbsoluteSourceGraphPath,
        sourceSpecRef: milestoneSpecPath,
        workspaceRef: 'internal-absolute-source-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        changedFiles: ['src/internal-absolute-source-portable.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test internal-absolute-source-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic internal absolute source spec references that must be rewritten after handoff.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${internalAbsoluteSourceRunId}.json`),
        `${JSON.stringify(internalAbsoluteSourceRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: internalAbsoluteSourceRunId,
        taskId: legacyGraphTask.id,
        iterationId: internalAbsoluteSourceRun.iterationId,
        status: 'finished',
        agentTool: internalAbsoluteSourceRun.agentTool,
        workspaceRef: internalAbsoluteSourceRun.workspaceRef,
        taskGraphRef: internalAbsoluteSourceRun.taskGraphRef,
        runRef: `${internalAbsoluteSourceRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      legacyGraphTaskIndex.runIds.push(internalAbsoluteSourceRunId);
      legacyGraphTaskIndex.latestRunId = internalAbsoluteSourceRunId;

      const artifactRootAliasPath = path.join(milestoneHandoffArtifactRoot, artifactRootAliasRef);
      symlinkSync('..', artifactRootAliasPath, 'dir');
      const symlinkedSourceSpecPath = path.join(
        artifactRootAliasPath,
        milestoneSpecRef,
      );
      const symlinkedAbsoluteSourceGraphPath = path.join(
        milestoneHandoffArtifactRoot,
        symlinkedAbsoluteSourceGraphRef,
      );
      const symlinkedAbsoluteSourceGraph = structuredClone(milestoneTaskGraph);
      const symlinkedSourceSpecRef = path.relative(
        path.dirname(symlinkedAbsoluteSourceGraphPath),
        symlinkedSourceSpecPath,
      ).split(path.sep).join('/');
      symlinkedAbsoluteSourceGraph.sourceSpec = symlinkedSourceSpecRef;
      mkdirSync(path.dirname(symlinkedAbsoluteSourceGraphPath), { recursive: true });
      writeFileSync(
        symlinkedAbsoluteSourceGraphPath,
        `${JSON.stringify(symlinkedAbsoluteSourceGraph, null, 2)}\n`,
        'utf8',
      );
      const symlinkedAbsoluteSourceRun = {
        ...legacyGraphRun,
        runId: symlinkedAbsoluteSourceRunId,
        taskGraphRef: symlinkedAbsoluteSourceGraphPath,
        sourceSpecRef: symlinkedSourceSpecRef,
        workspaceRef: 'symlinked-absolute-source-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        changedFiles: ['src/symlinked-absolute-source-portable.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test symlinked-absolute-source-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic in-root symlink alias that must resolve to the copied canonical source spec.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${symlinkedAbsoluteSourceRunId}.json`),
        `${JSON.stringify(symlinkedAbsoluteSourceRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: symlinkedAbsoluteSourceRunId,
        taskId: legacyGraphTask.id,
        iterationId: symlinkedAbsoluteSourceRun.iterationId,
        status: 'finished',
        agentTool: symlinkedAbsoluteSourceRun.agentTool,
        workspaceRef: symlinkedAbsoluteSourceRun.workspaceRef,
        taskGraphRef: symlinkedAbsoluteSourceRun.taskGraphRef,
        runRef: `${symlinkedAbsoluteSourceRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      legacyGraphTaskIndex.runIds.push(symlinkedAbsoluteSourceRunId);
      legacyGraphTaskIndex.latestRunId = symlinkedAbsoluteSourceRunId;

      const legacyV1UnfinishedRoot = path.join(
        milestoneHandoffArtifactRoot,
        legacyV1UnfinishedRootRef,
      );
      cpSync(historicalVisualRoot, legacyV1UnfinishedRoot, { recursive: true });
      const legacyV1CandidateRoot = path.join(
        legacyV1UnfinishedRoot,
        'gate-b-spec',
        'visual-design',
      );
      const legacyV1CandidatePath = path.join(legacyV1CandidateRoot, 'VD-1');
      const legacyV1CandidateBackingPath = path.join(legacyV1CandidateRoot, 'VD-1-source');
      renameSync(legacyV1CandidatePath, legacyV1CandidateBackingPath);
      symlinkSync('VD-1-source', legacyV1CandidatePath, 'dir');
      const legacyV1DependencyAliasRef = `${legacyV1UnfinishedRootRef}/dependency-alias`;
      symlinkSync('.', path.join(milestoneHandoffArtifactRoot, legacyV1DependencyAliasRef), 'dir');
      const legacyV1VisualAliasRef = `${legacyV1UnfinishedRootRef}/visual-alias`;
      symlinkSync('gate-b-spec', path.join(milestoneHandoffArtifactRoot, legacyV1VisualAliasRef), 'dir');
      const legacyV1UnfinishedIntakePath = path.join(
        legacyV1UnfinishedRoot,
        'gate-a-intake',
        'intake.json',
      );
      const legacyV1UnfinishedIntake = JSON.parse(
        readFileSync(legacyV1UnfinishedIntakePath, 'utf8'),
      );
      legacyV1UnfinishedIntake.baseline_context.spec_ref = (
        `dependency-alias/${legacyV1UnfinishedIntake.baseline_context.spec_ref}`
      );
      for (const answer of legacyV1UnfinishedIntake.baseline_context.reused_answers ?? []) {
        answer.source_intake = `dependency-alias/${answer.source_intake}`;
      }
      for (const disposition of (
        legacyV1UnfinishedIntake.baseline_context.reused_question_dispositions ?? []
      )) {
        disposition.source_spec = `dependency-alias/${disposition.source_spec}`;
      }
      const legacyV1UnfinishedIntakeText = `${JSON.stringify(legacyV1UnfinishedIntake, null, 2)}\n`;
      writeFileSync(legacyV1UnfinishedIntakePath, legacyV1UnfinishedIntakeText, 'utf8');
      const legacyV1UnfinishedSpecPath = path.join(
        legacyV1UnfinishedRoot,
        'gate-b-spec',
        'spec.json',
      );
      const legacyV1UnfinishedSpec = JSON.parse(
        readFileSync(legacyV1UnfinishedSpecPath, 'utf8'),
      );
      legacyV1UnfinishedSpec.source_intake = legacyV1UnfinishedIntakePath;
      legacyV1UnfinishedSpec.source_intake_sha256 = hashText(legacyV1UnfinishedIntakeText);
      legacyV1UnfinishedSpec.approval_audit.approved_artifacts = [path.join(
        milestoneHandoffArtifactRoot,
        legacyV1VisualAliasRef,
        'experience-spec.json',
      )];
      writeFileSync(
        legacyV1UnfinishedSpecPath,
        `${JSON.stringify(legacyV1UnfinishedSpec, null, 2)}\n`,
        'utf8',
      );
      const legacyV1UnfinishedGraphPath = path.join(
        milestoneHandoffArtifactRoot,
        legacyV1UnfinishedGraphRef,
      );
      const legacyV1UnfinishedGraph = JSON.parse(
        readFileSync(legacyV1UnfinishedGraphPath, 'utf8'),
      );
      const legacyV1UnfinishedTask = {
        ...legacyGraphTask,
        id: 'task-998',
        title: 'Resume a legacy v1 run after handoff',
        description: 'Keep the unique source closure needed when an unfinished v1 run upgrades on finish.',
        dependencies: [],
        acceptanceCriteria: ['The handed-off v1 run can upgrade and finish without its original artifact root.'],
        targetArea: 'runtime',
        workKind: 'non_ui',
        suggestedAgentPrompt: 'Finish the handed-off legacy v1 run from its portable source closure.',
      };
      delete legacyV1UnfinishedTask.visualImpact;
      legacyV1UnfinishedGraph.tasks.push(legacyV1UnfinishedTask);
      writeFileSync(
        legacyV1UnfinishedGraphPath,
        `${JSON.stringify(legacyV1UnfinishedGraph, null, 2)}\n`,
        'utf8',
      );
      const legacyV1UnfinishedRun = {
        ...unfinishedGraphRun,
        schema_version: 'p2a.run.v1',
        runId: legacyV1UnfinishedRunId,
        taskId: legacyV1UnfinishedTask.id,
        taskTitle: legacyV1UnfinishedTask.title,
        iterationId: 'iter-historical',
        taskGraphRef: legacyV1UnfinishedGraphPath,
        sourceSpecRef: legacyV1UnfinishedGraph.sourceSpec,
        workspaceRef: 'legacy-v1-unfinished-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        verification: [{
          type: 'test',
          command: 'node --test legacy-v1-unfinished-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic unfinished legacy v1 run with a unique source dependency closure.'],
      };
      delete legacyV1UnfinishedRun.taskContractSha256;
      writeFileSync(
        path.join(milestoneRunsDir, `${legacyV1UnfinishedRunId}.json`),
        `${JSON.stringify(legacyV1UnfinishedRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: legacyV1UnfinishedRunId,
        taskId: legacyV1UnfinishedTask.id,
        iterationId: legacyV1UnfinishedRun.iterationId,
        status: 'started',
        agentTool: legacyV1UnfinishedRun.agentTool,
        workspaceRef: legacyV1UnfinishedRun.workspaceRef,
        taskGraphRef: legacyV1UnfinishedRun.taskGraphRef,
        runRef: `${legacyV1UnfinishedRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: null,
      });
      milestoneRunIndexTasks.push({
        taskId: legacyV1UnfinishedTask.id,
        runIds: [legacyV1UnfinishedRunId],
        latestRunId: legacyV1UnfinishedRunId,
      });

      const externalGraphPath = path.join(tempRoot, 'external-graph-source', 'task-graph.json');
      mkdirSync(path.dirname(externalGraphPath), { recursive: true });
      writeFileSync(externalGraphPath, `${JSON.stringify(milestoneTaskGraph, null, 2)}\n`, 'utf8');
      const externalGraphRun = {
        schema_version: 'p2a.run.v1',
        runId: externalGraphRunId,
        projectId: caseData.project_id,
        taskId: legacyGraphTask.id,
        taskTitle: legacyGraphTask.title,
        iterationId: 'iter-002',
        sourceLayout: 'graph',
        taskGraphRef: externalGraphPath,
        sourceSpecRef: milestoneTaskGraph.sourceSpec,
        taskContractSha256: taskContractSha256(legacyGraphTask),
        agentTool: 'codex',
        workspaceRef: 'external-graph-handoff-fixture',
        workspacePath: tempRoot,
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
        changedFiles: ['src/external-graph-history.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test external-graph-history',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic valid external graph history that must not block milestone handoff.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${externalGraphRunId}.json`),
        `${JSON.stringify(externalGraphRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: externalGraphRunId,
        taskId: legacyGraphTask.id,
        iterationId: externalGraphRun.iterationId,
        status: 'finished',
        agentTool: externalGraphRun.agentTool,
        workspaceRef: externalGraphRun.workspaceRef,
        taskGraphRef: externalGraphRun.taskGraphRef,
        runRef: `${externalGraphRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      legacyGraphTaskIndex.runIds.push(externalGraphRunId);
      legacyGraphTaskIndex.latestRunId = externalGraphRunId;

      const externalSourceRun = {
        ...legacyGraphRun,
        runId: externalSourceRunId,
        taskGraphRef: internalGraphExternalSpecPath,
        sourceSpecRef: externalSourceSpecPath,
        workspaceRef: 'external-source-handoff-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        changedFiles: ['src/external-source-history.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test external-source-history',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic internal graph with an external approved source spec.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${externalSourceRunId}.json`),
        `${JSON.stringify(externalSourceRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: externalSourceRunId,
        taskId: legacyGraphTask.id,
        iterationId: externalSourceRun.iterationId,
        status: 'finished',
        agentTool: externalSourceRun.agentTool,
        workspaceRef: externalSourceRun.workspaceRef,
        taskGraphRef: externalSourceRun.taskGraphRef,
        runRef: `${externalSourceRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      legacyGraphTaskIndex.runIds.push(externalSourceRunId);
      legacyGraphTaskIndex.latestRunId = externalSourceRunId;

      const externalStartedVisualTask = milestoneTaskGraph.tasks.find(
        (task) => task.visualImpact,
      );
      const externalStartedVisualRun = {
        ...externalSourceRun,
        runId: externalStartedVisualRunId,
        taskId: externalStartedVisualTask.id,
        taskTitle: externalStartedVisualTask.title,
        taskContractSha256: taskContractSha256(externalStartedVisualTask),
        runKind: 'final_visual_review',
        visualReview: {
          required: true,
          experienceSpecRef: 'experience-spec.json',
          experienceSpecSha256: milestoneVisualArtifacts.experienceSpecSha256,
          prototypeManifestRef: 'visual-design/VD-1/prototype.json',
          prototypeManifestSha256: milestoneVisualArtifacts.prototypeManifestSha256,
          screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
          viewports: [{ name: 'desktop', width: 240, height: 240 }],
          accessibilityStandard: 'WCAG 2.2 AA',
        },
        workspaceRef: 'external-source-started-visual-handoff-fixture',
        status: 'started',
        updatedAt: milestoneRunStartedAt,
        finishedAt: null,
        changedFiles: [],
        notes: ['Synthetic started visual run with an external source closure that must be omitted.'],
      };
      delete externalStartedVisualRun.workspaceRevisionSha256;
      delete externalStartedVisualRun.visualReviewEvidenceSha256;
      writeFileSync(
        path.join(milestoneRunsDir, `${externalStartedVisualRunId}.json`),
        `${JSON.stringify(externalStartedVisualRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: externalStartedVisualRunId,
        taskId: externalStartedVisualTask.id,
        iterationId: externalStartedVisualRun.iterationId,
        status: 'started',
        agentTool: externalStartedVisualRun.agentTool,
        workspaceRef: externalStartedVisualRun.workspaceRef,
        taskGraphRef: externalStartedVisualRun.taskGraphRef,
        runRef: `${externalStartedVisualRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: null,
      });
      const externalStartedVisualTaskIndex = milestoneRunIndexTasks.find(
        (task) => task.taskId === externalStartedVisualTask.id,
      );
      externalStartedVisualTaskIndex.runIds.push(externalStartedVisualRunId);
      externalStartedVisualTaskIndex.latestRunId = externalStartedVisualRunId;

      const milestoneMaintenanceTaskGraphPath = path.join(
        milestoneHandoffArtifactRoot,
        maintenanceTaskGraphRef,
      );
      const milestoneMaintenanceTaskGraph = JSON.parse(
        readFileSync(milestoneMaintenanceTaskGraphPath, 'utf8'),
      );
      const portableMaintenanceTask = {
        id: maintenanceTaskId,
        title: 'Preserve portable maintenance provenance',
        description: 'Keep maintenance run task and current-spec provenance in milestone handoff bundles.',
        status: 'done',
        dependencies: [],
        acceptanceCriteria: ['The handed-off global run store validates maintenance run provenance.'],
        targetArea: 'maintenance',
        suggestedAgentPrompt: 'Validate maintenance run provenance after handoff.',
        sourceSpecRefs: ['maintenance'],
      };
      milestoneMaintenanceTaskGraph.tasks.push(portableMaintenanceTask);
      writeFileSync(
        milestoneMaintenanceTaskGraphPath,
        `${JSON.stringify(milestoneMaintenanceTaskGraph, null, 2)}\n`,
        'utf8',
      );
      const maintenanceRun = {
        schema_version: 'p2a.run.v2',
        runId: maintenanceRunId,
        projectId: caseData.project_id,
        taskId: maintenanceTaskId,
        taskTitle: portableMaintenanceTask.title,
        iterationId: 'maintenance',
        sourceLayout: 'maintenance',
        taskGraphRef: maintenanceTaskGraphRef,
        sourceSpecRef: milestoneMaintenanceTaskGraph.sourceSpec,
        taskContractSha256: taskContractSha256(portableMaintenanceTask),
        agentTool: 'codex',
        workspaceRef: 'maintenance-handoff-fixture',
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
        changedFiles: ['scripts/maintenance-portable.mjs'],
        verification: [{
          type: 'test',
          command: 'node --test maintenance-portable',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: milestoneRunStartedAt,
          finishedAt: milestoneRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic maintenance provenance outside the milestone task graph.'],
      };
      writeFileSync(
        path.join(milestoneRunsDir, `${maintenanceRunId}.json`),
        `${JSON.stringify(maintenanceRun, null, 2)}\n`,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: maintenanceRunId,
        taskId: maintenanceTaskId,
        iterationId: 'maintenance',
        status: 'finished',
        agentTool: maintenanceRun.agentTool,
        workspaceRef: maintenanceRun.workspaceRef,
        taskGraphRef: maintenanceTaskGraphRef,
        runRef: `${maintenanceRunId}.json`,
        startedAt: milestoneRunStartedAt,
        finishedAt: milestoneRunFinishedAt,
      });
      milestoneRunIndexTasks.push({
        taskId: maintenanceTaskId,
        runIds: [maintenanceRunId],
        latestRunId: maintenanceRunId,
      });

      const historicalRunStartedAt = '2026-07-10T00:00:00.000Z';
      const historicalRunFinishedAt = '2026-07-10T00:01:00.000Z';
      const historicalScreenshotPath = path.join(
        milestoneHandoffArtifactRoot,
        historicalVisualScreenshotRef,
      );
      const historicalAccessibilityPath = path.join(
        milestoneHandoffArtifactRoot,
        historicalVisualAccessibilityRef,
      );
      writePng(historicalScreenshotPath, 240, 240);
      mkdirSync(path.dirname(historicalAccessibilityPath), { recursive: true });
      const historicalAccessibilityText = `${JSON.stringify({
        schema_version: 'p2a.visual_accessibility_report.v1',
        tool: 'axe-core',
        standard: 'WCAG 2.2 AA',
        scanned_at: historicalRunFinishedAt,
        page_urls: ['http://127.0.0.1:4173/historical-review'],
        violations: [],
      }, null, 2)}\n`;
      writeFileSync(historicalAccessibilityPath, historicalAccessibilityText, 'utf8');
      const historicalRun = {
        schema_version: 'p2a.run.v1',
        runId: historicalVisualRunId,
        projectId: caseData.project_id,
        taskId: historicalVisualTaskId,
        taskTitle: 'Preserve historical visual provenance',
        iterationId: historicalVisualIterationId,
        sourceLayout: 'iteration',
        taskGraphRef: historicalTaskGraphRef,
        sourceSpecRef: historicalSpecRef,
        taskContractSha256: taskContractSha256(
          JSON.parse(readFileSync(historicalTaskGraphPath, 'utf8')).tasks[0],
        ),
        agentTool: 'codex',
        workspaceRef: 'historical-visual-handoff-fixture',
        workspacePath: '.',
        workspaceRevisionSha256: hashText('historical-visual-handoff-fixture-revision'),
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
        startedAt: historicalRunStartedAt,
        updatedAt: historicalRunFinishedAt,
        finishedAt: historicalRunFinishedAt,
        changedFiles: [],
        verification: [{
          type: 'test',
          command: 'node --test historical-visual',
          status: 'passed',
          exitCode: 0,
          durationMs: 1,
          startedAt: historicalRunStartedAt,
          finishedAt: historicalRunFinishedAt,
          stdoutTail: '',
          stderrTail: '',
          source: 'command',
        }],
        notes: ['Synthetic historical visual evidence with its own task graph provenance.'],
        runKind: 'final_visual_review',
        visualReview: {
          required: true,
          experienceSpecRef: 'experience-spec.json',
          experienceSpecSha256: historicalVisualArtifacts.experienceSpecSha256,
          prototypeManifestRef: 'visual-design/VD-1/prototype.json',
          prototypeManifestSha256: historicalVisualArtifacts.prototypeManifestSha256,
          screenStates: [{ screenId: 'SCREEN-1', states: ['ready'] }],
          viewports: [{ name: 'desktop', width: 240, height: 240 }],
          accessibilityStandard: 'WCAG 2.2 AA',
        },
      };
      const historicalVisualReview = {
        schema_version: 'p2a.visual_review.v1',
        run_id: historicalVisualRunId,
        task_id: historicalVisualTaskId,
        workspace_ref: historicalRun.workspaceRef,
        workspace_revision_sha256: historicalRun.workspaceRevisionSha256,
        source_experience_ref: historicalRun.visualReview.experienceSpecRef,
        source_prototype_ref: historicalRun.visualReview.prototypeManifestRef,
        reviewed_at: historicalRunFinishedAt,
        results: [{
          screen_id: 'SCREEN-1',
          state: 'ready',
          viewport: 'desktop',
          artifact_ref: historicalVisualScreenshotRef,
          artifact_sha256: hashText(readFileSync(historicalScreenshotPath)),
          media_type: 'image/png',
          width: 240,
          height: 240,
          capture_url: 'http://127.0.0.1:4173/historical-review',
          captured_at: historicalRunFinishedAt,
          status: 'passed',
          concerns: [],
        }],
        accessibility: {
          status: 'passed',
          report_ref: historicalVisualAccessibilityRef,
          report_sha256: hashText(historicalAccessibilityText),
          standard: 'WCAG 2.2 AA',
          critical_violations: 0,
        },
        verdict: 'confirm_ui',
        concerns: [],
        note: 'Historical visual evidence remains valid after a later milestone handoff.',
      };
      const historicalVisualReviewText = `${JSON.stringify(historicalVisualReview, null, 2)}\n`;
      historicalRun.visualReviewEvidenceSha256 = hashText(historicalVisualReviewText);
      const historicalRunText = `${JSON.stringify(historicalRun, null, 2)}\n`;
      writeFileSync(path.join(milestoneRunsDir, `${historicalVisualRunId}.json`), historicalRunText, 'utf8');
      writeFileSync(
        path.join(milestoneRunsDir, `${historicalVisualRunId}.visual-review.json`),
        historicalVisualReviewText,
        'utf8',
      );
      milestoneRunIndexEntries.push({
        runId: historicalVisualRunId,
        taskId: historicalVisualTaskId,
        iterationId: historicalVisualIterationId,
        status: 'finished',
        agentTool: 'codex',
        workspaceRef: historicalRun.workspaceRef,
        taskGraphRef: historicalTaskGraphRef,
        runRef: `${historicalVisualRunId}.json`,
        startedAt: historicalRunStartedAt,
        finishedAt: historicalRunFinishedAt,
      });
      milestoneRunIndexTasks.push({
        taskId: historicalVisualTaskId,
        runIds: [historicalVisualRunId],
        latestRunId: historicalVisualRunId,
      });
      const milestoneRunIndexPath = path.join(milestoneRunsDir, 'run-index.json');
      const milestoneRunIndexText = `${JSON.stringify({
        schema_version: 'p2a.run_index.v1',
        projectId: caseData.project_id,
        runs: milestoneRunIndexEntries,
        tasks: milestoneRunIndexTasks,
      }, null, 2)}\n`;
      writeFileSync(milestoneRunIndexPath, milestoneRunIndexText, 'utf8');

      const sourceMilestoneReviewDir = path.join(milestoneHandoffArtifactRoot, 'iterations', 'iter-002', 'milestone-reviews');
      const sourcePreCloseReviewPath = path.join(sourceMilestoneReviewDir, 'pre_close.json');
      const sourceMidpointDraftPath = path.join(sourceMilestoneReviewDir, 'midpoint.fixture.draft.json');
      mkdirSync(sourceMilestoneReviewDir, { recursive: true });
      const legacyMilestoneReview = {
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
      };
      writeFileSync(sourcePreCloseReviewPath, `${JSON.stringify(legacyMilestoneReview, null, 2)}\n`, 'utf8');
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

      const startedVisualRun = {
        ...historicalRun,
        runId: startedVisualRunId,
        workspaceRef: 'started-visual-handoff-rejected-fixture',
        workspacePath: milestoneHandoffArtifactRoot,
        status: 'started',
        updatedAt: historicalRunStartedAt,
        finishedAt: null,
        changedFiles: [],
      };
      delete startedVisualRun.workspaceRevisionSha256;
      delete startedVisualRun.visualReviewEvidenceSha256;
      const startedVisualRunPath = path.join(milestoneRunsDir, `${startedVisualRunId}.json`);
      writeFileSync(
        startedVisualRunPath,
        `${JSON.stringify(startedVisualRun, null, 2)}\n`,
        'utf8',
      );
      const startedVisualRunIndex = JSON.parse(milestoneRunIndexText);
      startedVisualRunIndex.runs.push({
        runId: startedVisualRunId,
        taskId: historicalVisualTaskId,
        iterationId: historicalVisualIterationId,
        status: 'started',
        agentTool: startedVisualRun.agentTool,
        workspaceRef: startedVisualRun.workspaceRef,
        taskGraphRef: historicalTaskGraphRef,
        runRef: `${startedVisualRunId}.json`,
        startedAt: historicalRunStartedAt,
        finishedAt: null,
      });
      const startedVisualTaskIndex = startedVisualRunIndex.tasks.find(
        (task) => task.taskId === historicalVisualTaskId,
      );
      startedVisualTaskIndex.runIds.push(startedVisualRunId);
      startedVisualTaskIndex.latestRunId = startedVisualRunId;
      writeFileSync(
        milestoneRunIndexPath,
        `${JSON.stringify(startedVisualRunIndex, null, 2)}\n`,
        'utf8',
      );
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        milestoneHandoffArtifactRoot,
        '--target',
        path.join(tempRoot, 'target-started-visual-rejected'),
        '--run-transfer',
        'resumable',
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status === 0
        || !`${result.stdout}\n${result.stderr}`.includes(
          `handoff cannot port started visual run ${startedVisualRunId}`,
        )
      ) {
        console.error(`iteration handoff started visual run rejection failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }
      writeFileSync(milestoneRunIndexPath, milestoneRunIndexText, 'utf8');
      rmSync(startedVisualRunPath, { force: true });

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
        || !result.stdout.includes('runTransfer: completed')
        || !result.stdout.includes('copy+rewrite:')
        || !result.stdout.includes(`gate-b-spec/spec.json -> .plan2agent/artifacts/${caseData.project_id}/gate-b-spec/spec.json`)
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/iterations/iter-002/milestone-reviews/pre_close.json`)
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/runs/run-index.json`)
        || result.stdout.includes(unfinishedGraphRunId)
        || result.stdout.includes(legacyV1UnfinishedRunId)
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
        '--run-transfer',
        'resumable',
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
      const expectedComposedVisualFiles = composedVisualArtifactRefs.map(
        (filePath) => `.plan2agent/artifacts/${caseData.project_id}/${filePath}`,
      );
      const expectedMilestoneEvidenceFiles = [
        milestoneTaskGraphRef,
        milestoneSpecRef,
        'iterations/iter-002/gate-a-intake/intake.json',
        'runs/run-index.json',
        ...milestoneRunIndexEntries
          .filter((entry) => ![
            externalGraphRunId,
            externalSourceRunId,
            externalStartedVisualRunId,
          ].includes(entry.runId))
          .map((entry) => `runs/${entry.runId}.json`),
        unfinishedGraphRef,
        internalAbsoluteSourceGraphRef,
        symlinkedAbsoluteSourceGraphRef,
        legacyV1UnfinishedGraphRef,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/spec.json`,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/experience-spec.json`,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/visual-design/VD-1/prototype.json`,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/visual-design/VD-1/index.html`,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/visual-design/VD-2/prototype.json`,
        `${legacyV1UnfinishedRootRef}/gate-b-spec/visual-design/VD-2/index.html`,
        `${legacyV1UnfinishedRootRef}/gate-a-intake/intake.json`,
        ...historicalBaselineDependencyRefs.map((reference) => reference.replace(
          historicalVisualRootRef,
          legacyV1UnfinishedRootRef,
        )),
        'iterations/iter-002/gate-b-spec/experience-spec.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-1/prototype.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-1/index.html',
        'iterations/iter-002/gate-b-spec/visual-design/VD-2/prototype.json',
        'iterations/iter-002/gate-b-spec/visual-design/VD-2/index.html',
        milestoneVisualSidecarRef,
        milestoneVisualScreenshotRef,
        milestoneVisualAccessibilityRef,
        maintenanceTaskGraphRef,
        'current-spec.json',
        historicalTaskGraphRef,
        `${historicalVisualRootRef}/gate-b-spec/spec.json`,
        `${historicalVisualRootRef}/gate-b-spec/experience-spec.json`,
        `${historicalVisualRootRef}/gate-b-spec/visual-design/VD-1/prototype.json`,
        `${historicalVisualRootRef}/gate-b-spec/visual-design/VD-1/index.html`,
        `${historicalVisualRootRef}/gate-b-spec/visual-design/VD-2/prototype.json`,
        `${historicalVisualRootRef}/gate-b-spec/visual-design/VD-2/index.html`,
        `${historicalVisualRootRef}/gate-a-intake/intake.json`,
        ...historicalBaselineDependencyRefs,
        historicalVisualSidecarRef,
        historicalVisualScreenshotRef,
        historicalVisualAccessibilityRef,
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
      const targetComposedVisualSpecPath = path.join(
        iterationTargetArtifactRoot,
        composedVisualSpecRef,
      );
      const targetComposedVisualSpec = JSON.parse(
        readFileSync(targetComposedVisualSpecPath, 'utf8'),
      );
      const targetComposedClosedIteration = targetCurrentSpec.closed_iterations.find(
        (closed) => closed.iteration_id === composedVisualIterationId,
      );
      const targetComposedSpecAudit = targetComposedClosedIteration?.artifact_hashes?.[
        composedVisualSpecRef
      ];
      const targetLastClosedTaskGraphAudit = targetCurrentSpec.last_closed_iteration
        ?.artifact_hashes?.[milestoneTaskGraphRef];
      const targetMilestoneTaskGraph = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, milestoneTaskGraphRef), 'utf8'),
      );
      const targetMilestoneReview = JSON.parse(readFileSync(targetPreCloseReviewPath, 'utf8'));
      const targetSpec = JSON.parse(readFileSync(targetSpecPath, 'utf8'));
      const targetRunIndex = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, 'runs', 'run-index.json'), 'utf8'),
      );
      const targetLegacyGraphRun = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, 'runs', `${legacyGraphRunId}.json`), 'utf8'),
      );
      const targetLegacyGraphIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === legacyGraphRunId,
      );
      const targetUnfinishedGraphRun = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, 'runs', `${unfinishedGraphRunId}.json`), 'utf8'),
      );
      const targetUnfinishedGraphIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === unfinishedGraphRunId,
      );
      const targetRelativeSymlinkGraphRun = JSON.parse(
        readFileSync(
          path.join(iterationTargetArtifactRoot, 'runs', `${relativeSymlinkGraphRunId}.json`),
          'utf8',
        ),
      );
      const targetRelativeSymlinkGraphIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === relativeSymlinkGraphRunId,
      );
      const targetInternalAbsoluteSourceRun = JSON.parse(
        readFileSync(
          path.join(iterationTargetArtifactRoot, 'runs', `${internalAbsoluteSourceRunId}.json`),
          'utf8',
        ),
      );
      const targetInternalAbsoluteSourceIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === internalAbsoluteSourceRunId,
      );
      const targetInternalAbsoluteSourceGraph = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, internalAbsoluteSourceGraphRef), 'utf8'),
      );
      const targetSymlinkedAbsoluteSourceRun = JSON.parse(
        readFileSync(
          path.join(iterationTargetArtifactRoot, 'runs', `${symlinkedAbsoluteSourceRunId}.json`),
          'utf8',
        ),
      );
      const targetSymlinkedAbsoluteSourceIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === symlinkedAbsoluteSourceRunId,
      );
      const targetSymlinkedAbsoluteSourceGraph = JSON.parse(
        readFileSync(path.join(iterationTargetArtifactRoot, symlinkedAbsoluteSourceGraphRef), 'utf8'),
      );
      const targetLegacyV1UnfinishedRun = JSON.parse(
        readFileSync(
          path.join(iterationTargetArtifactRoot, 'runs', `${legacyV1UnfinishedRunId}.json`),
          'utf8',
        ),
      );
      const targetLegacyV1UnfinishedIndexEntry = targetRunIndex.runs.find(
        (entry) => entry.runId === legacyV1UnfinishedRunId,
      );
      const targetLegacyV1UnfinishedSpec = JSON.parse(readFileSync(
        path.join(
          iterationTargetArtifactRoot,
          legacyV1UnfinishedRootRef,
          'gate-b-spec',
          'spec.json',
        ),
        'utf8',
      ));
      const targetLegacyV1UnfinishedIntakePath = path.join(
        iterationTargetArtifactRoot,
        legacyV1UnfinishedRootRef,
        'gate-a-intake',
        'intake.json',
      );
      const targetLegacyV1UnfinishedIntake = JSON.parse(
        readFileSync(targetLegacyV1UnfinishedIntakePath, 'utf8'),
      );
      const targetExternalGraphRunPath = path.join(
        iterationTargetArtifactRoot,
        'runs',
        `${externalGraphRunId}.json`,
      );
      const targetExternalSourceRunPath = path.join(
        iterationTargetArtifactRoot,
        'runs',
        `${externalSourceRunId}.json`,
      );
      const targetExternalStartedVisualRunPath = path.join(
        iterationTargetArtifactRoot,
        'runs',
        `${externalStartedVisualRunId}.json`,
      );
      const expectedTargetSpecRef = `.plan2agent/artifacts/${caseData.project_id}/gate-b-spec/spec.json`;
      const expectedTargetIntakeRef = `.plan2agent/artifacts/${caseData.project_id}/gate-a-intake/intake.json`;
      const expectedPortableAbsoluteSourceSpecRef = path.relative(
        path.dirname(internalAbsoluteSourceGraphRef),
        milestoneSpecRef,
      ).split(path.sep).join('/');
      const expectedPortableMilestoneSourceSpecRef = path.relative(
        path.dirname(milestoneTaskGraphRef),
        milestoneSpecRef,
      ).split(path.sep).join('/');
      const expectedPortableSymlinkedSourceSpecRef = path.relative(
        path.dirname(symlinkedAbsoluteSourceGraphRef),
        milestoneSpecRef,
      ).split(path.sep).join('/');
      if (
        targetManifest.sourceLayout !== 'iteration'
        || targetManifest.sourceIterationId !== 'iter-002'
        || targetManifest.currentSpecFile !== '.plan2agent/current-spec.json'
        || JSON.stringify(targetManifest.maintenanceFiles) !== JSON.stringify(['.plan2agent/maintenance/task-graph.json'])
        || 'runtime' in targetManifest
        || realpathSync(targetManifest.provenance?.toolkitRoot ?? '') !== realpathSync(ROOT)
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
	        || !targetManifest.artifactFiles.includes(targetPreCloseReviewRelative)
	        || expectedMilestoneEvidenceFiles.some((filePath) => !targetManifest.artifactFiles.includes(filePath))
	        || expectedComposedVisualFiles.some((filePath) => !targetManifest.artifactFiles.includes(filePath))
	        || expectedComposedVisualFiles.some((filePath) => !existsSync(path.join(iterationTargetRoot, filePath)))
	        || targetCurrentSpec.last_handoff?.iteration_id !== 'iter-002'
        || targetComposedVisualSpec.source_intake !== '../gate-a-intake/intake.json'
        || (typeof targetComposedSpecAudit === 'string'
          ? targetComposedSpecAudit
          : targetComposedSpecAudit?.sha256) !== hashText(readFileSync(targetComposedVisualSpecPath))
        || (typeof targetLastClosedTaskGraphAudit === 'string'
          ? targetLastClosedTaskGraphAudit
          : targetLastClosedTaskGraphAudit?.sha256) !== hashText(readFileSync(
          path.join(iterationTargetArtifactRoot, milestoneTaskGraphRef),
        ))
        || targetCurrentSpec.last_handoff?.maintenance_included !== true
        || sourceCurrentSpecAfterHandoff.last_handoff?.target_project !== iterationTargetRoot
        || targetTaskGraph.sourceSpec !== expectedTargetSpecRef
        || targetMilestoneTaskGraph.sourceSpec !== expectedPortableMilestoneSourceSpecRef
        || targetMilestoneReview.source.task_graph_snapshot.sourceSpec !== expectedPortableMilestoneSourceSpecRef
        || targetMilestoneReview.source.completed_task_evidence.some((evidence) => (
          evidence.run_snapshot.taskGraphRef !== milestoneTaskGraphRef
          || evidence.run_snapshot.sourceSpecRef !== expectedPortableMilestoneSourceSpecRef
        ))
        || targetSpec.source_intake !== expectedTargetIntakeRef
        || targetLegacyGraphRun.taskGraphRef !== milestoneTaskGraphRef
        || targetLegacyGraphRun.sourceSpecRef !== expectedPortableMilestoneSourceSpecRef
        || targetLegacyGraphIndexEntry?.taskGraphRef !== milestoneTaskGraphRef
        || targetUnfinishedGraphRun.taskGraphRef !== unfinishedGraphRef
        || targetUnfinishedGraphIndexEntry?.taskGraphRef !== unfinishedGraphRef
        || !existsSync(path.join(iterationTargetArtifactRoot, unfinishedGraphRef))
        || targetRelativeSymlinkGraphRun.taskGraphRef !== unfinishedGraphRef
        || targetRelativeSymlinkGraphIndexEntry?.taskGraphRef !== unfinishedGraphRef
        || existsSync(path.join(iterationTargetArtifactRoot, relativeSymlinkGraphAliasRef))
        || targetInternalAbsoluteSourceRun.taskGraphRef !== internalAbsoluteSourceGraphRef
        || targetInternalAbsoluteSourceIndexEntry?.taskGraphRef !== internalAbsoluteSourceGraphRef
        || targetInternalAbsoluteSourceRun.sourceSpecRef !== expectedPortableAbsoluteSourceSpecRef
        || targetInternalAbsoluteSourceGraph.sourceSpec !== expectedPortableAbsoluteSourceSpecRef
        || targetSymlinkedAbsoluteSourceRun.taskGraphRef !== symlinkedAbsoluteSourceGraphRef
        || targetSymlinkedAbsoluteSourceIndexEntry?.taskGraphRef !== symlinkedAbsoluteSourceGraphRef
        || targetSymlinkedAbsoluteSourceRun.sourceSpecRef !== expectedPortableSymlinkedSourceSpecRef
        || targetSymlinkedAbsoluteSourceGraph.sourceSpec !== expectedPortableSymlinkedSourceSpecRef
        || existsSync(path.join(iterationTargetArtifactRoot, artifactRootAliasRef))
        || targetLegacyV1UnfinishedRun.schema_version !== 'p2a.run.v1'
        || targetLegacyV1UnfinishedRun.taskContractSha256 !== undefined
        || targetLegacyV1UnfinishedRun.taskGraphRef !== legacyV1UnfinishedGraphRef
        || targetLegacyV1UnfinishedIndexEntry?.taskGraphRef !== legacyV1UnfinishedGraphRef
        || targetLegacyV1UnfinishedSpec.source_intake !== '../gate-a-intake/intake.json'
        || targetLegacyV1UnfinishedSpec.source_intake_sha256 !== hashText(
          readFileSync(targetLegacyV1UnfinishedIntakePath),
        )
        || !targetLegacyV1UnfinishedSpec.approval_audit.approved_artifacts.includes(
          'experience-spec.json',
        )
        || targetLegacyV1UnfinishedIntake.baseline_context.spec_ref.startsWith('dependency-alias/')
        || targetLegacyV1UnfinishedIntake.baseline_context.reused_answers.some(
          (answer) => answer.source_intake.startsWith('dependency-alias/'),
        )
        || targetLegacyV1UnfinishedIntake.baseline_context.reused_question_dispositions.some(
          (disposition) => disposition.source_spec.startsWith('dependency-alias/'),
        )
        || existsSync(path.join(iterationTargetArtifactRoot, legacyV1DependencyAliasRef))
        || existsSync(path.join(iterationTargetArtifactRoot, legacyV1VisualAliasRef))
        || existsSync(path.join(
          iterationTargetArtifactRoot,
          legacyV1UnfinishedRootRef,
          'gate-b-spec',
          'visual-design',
          'VD-1-source',
        ))
        || !existsSync(path.join(
          iterationTargetArtifactRoot,
          legacyV1UnfinishedRootRef,
          'gate-b-spec',
          'spec.json',
        ))
        || targetRunIndex.runs.some((entry) => entry.runId === externalGraphRunId)
        || existsSync(targetExternalGraphRunPath)
        || targetRunIndex.runs.some((entry) => entry.runId === externalSourceRunId)
        || existsSync(targetExternalSourceRunPath)
        || targetRunIndex.runs.some((entry) => entry.runId === externalStartedVisualRunId)
        || existsSync(targetExternalStartedVisualRunPath)
        || existsSync(path.join(iterationTargetArtifactRoot, internalGraphExternalSpecRef))
      ) {
        console.error(`iteration handoff manifest/task graph contract mismatch: ${caseData.id}`);
        console.error(JSON.stringify({ targetManifest, targetCurrentSpec, sourceCurrentSpecAfterHandoff, targetTaskGraphSourceSpec: targetTaskGraph.sourceSpec, targetSpecSourceIntake: targetSpec.source_intake, targetLegacyGraphRunTaskGraphRef: targetLegacyGraphRun.taskGraphRef, targetLegacyGraphIndexTaskGraphRef: targetLegacyGraphIndexEntry?.taskGraphRef, targetUnfinishedGraphRunTaskGraphRef: targetUnfinishedGraphRun.taskGraphRef, targetUnfinishedGraphIndexTaskGraphRef: targetUnfinishedGraphIndexEntry?.taskGraphRef, targetInternalAbsoluteSourceRunTaskGraphRef: targetInternalAbsoluteSourceRun.taskGraphRef, targetInternalAbsoluteSourceRunSourceSpecRef: targetInternalAbsoluteSourceRun.sourceSpecRef, targetInternalAbsoluteSourceGraphSourceSpec: targetInternalAbsoluteSourceGraph.sourceSpec, targetLegacyV1UnfinishedRunTaskGraphRef: targetLegacyV1UnfinishedRun.taskGraphRef, targetLegacyV1UnfinishedIndexTaskGraphRef: targetLegacyV1UnfinishedIndexEntry?.taskGraphRef, targetExternalGraphRunPresent: targetRunIndex.runs.some((entry) => entry.runId === externalGraphRunId), targetExternalSourceRunPresent: targetRunIndex.runs.some((entry) => entry.runId === externalSourceRunId) }, null, 2));
        return { status: 1, checks };
      }

      result = assertTargetSpecSourceIntake(iterationTargetRoot, caseData.project_id, caseData.id, 'iteration');
      checks += 1;
      if (result.status !== 0) return { status: result.status, checks };

      result = runTargetP2a(iterationTargetRoot, [
        'validate',
        '--spec',
        path.join(iterationTargetArtifactRoot, composedVisualSpecRef),
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff composed visual source bundle validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetP2a(iterationTargetRoot, ['validate', '--milestone-review', targetPreCloseReviewPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target milestone evidence bundle validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetP2a(iterationTargetRoot, ['validate', '--runs-dir', path.join(iterationTargetArtifactRoot, 'runs')]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target visual run evidence validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const portableArchiveAuditRoot = path.join(tempRoot, 'target-portable-archive-audit');
      cpSync(iterationTargetArtifactRoot, portableArchiveAuditRoot, { recursive: true });
      cpSync(
        targetCurrentSpecPath,
        path.join(portableArchiveAuditRoot, 'current-spec.json'),
      );
      result = runTargetIteration(iterationTargetRoot, [
        'validate',
        '--artifacts',
        portableArchiveAuditRoot,
        '--audit-archive',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff target archived artifact audit failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetRuns(iterationTargetRoot, [
        'finish',
        '--runs',
        path.join(iterationTargetArtifactRoot, 'runs'),
        '--run-id',
        unfinishedGraphRunId,
        '--status',
        'finished',
        '--workspace',
        iterationTargetRoot,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff unfinished graph run could not finish from its copied source bundle: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runTargetRuns(iterationTargetRoot, [
        'finish',
        '--runs',
        path.join(iterationTargetArtifactRoot, 'runs'),
        '--run-id',
        legacyV1UnfinishedRunId,
        '--status',
        'finished',
        '--workspace',
        iterationTargetRoot,
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff legacy v1 run could not finish from its copied source closure: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const finishedTargetLegacyV1Run = JSON.parse(
        readFileSync(
          path.join(iterationTargetArtifactRoot, 'runs', `${legacyV1UnfinishedRunId}.json`),
          'utf8',
        ),
      );
      checks += 1;
      if (
        finishedTargetLegacyV1Run.schema_version !== 'p2a.run.v2'
        || finishedTargetLegacyV1Run.status !== 'finished'
        || typeof finishedTargetLegacyV1Run.taskContractSha256 !== 'string'
      ) {
        console.error(`iteration handoff legacy v1 run did not upgrade on finish: ${caseData.id}`);
        console.error(JSON.stringify(finishedTargetLegacyV1Run, null, 2));
        return { status: 1, checks };
      }

      result = runTargetP2a(iterationTargetRoot, ['validate', '--runs-dir', path.join(iterationTargetArtifactRoot, 'runs')]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff finished graph runs did not validate after resume: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const compactMilestoneReview = structuredClone(legacyMilestoneReview);
      compactMilestoneReview.source.completed_task_evidence = milestoneCompletedTaskEvidence.map((evidence) => ({
        run_ref: evidence.run_ref,
        run_sha256: evidence.run_sha256,
        run_snapshot: evidence.run_snapshot,
        run_snapshot_sha256: evidence.run_snapshot_sha256,
      }));
      compactMilestoneReview.note = 'Compact handoff persistence fixture.';
      writeFileSync(sourcePreCloseReviewPath, `${JSON.stringify(compactMilestoneReview, null, 2)}\n`, 'utf8');

      result = runValidator(['--milestone-review', sourcePreCloseReviewPath]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`compact source milestone handoff bundle validation failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const compactIterationDryRunTargetRoot = path.join(tempRoot, 'target-compact-iteration-dry-run');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        milestoneHandoffArtifactRoot,
        '--target',
        compactIterationDryRunTargetRoot,
        '--iteration-id',
        'active',
        '--dry-run',
      ]);
      checks += 1;
      if (
        result.status !== 0
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/iterations/iter-002/milestone-reviews/pre_close.json`)
        || !result.stdout.includes(`.plan2agent/artifacts/${caseData.project_id}/runs/run-index.json`)
      ) {
        console.error(`compact iteration handoff dry-run fixture check failed: ${caseData.id}`);
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
      if (result.status !== 0 || !result.stdout.includes('Gate A scope confirmation required')) {
        console.error(`iteration Gate A scope draft from composed current-spec fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const iter3SpecPath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-b-spec', 'spec.json');
      const iter3IntakePath = path.join(artifactRoot, 'iterations', 'iter-003', 'gate-a-intake', 'intake.json');
      const iter3Scope = JSON.parse(readFileSync(iter3IntakePath, 'utf8'));
      if (
        existsSync(iter3SpecPath)
        || Object.hasOwn(iter3Scope, 'interview')
        || !iter3Scope.baseline_context?.reused_answers.length
      ) {
        console.error(`composed baseline Gate A scope did not preserve reusable answer provenance: ${caseData.id}`);
        console.error(JSON.stringify(iter3Scope, null, 2));
        return { status: 1, checks };
      }
      confirmScopeIntake(
        iter3IntakePath,
        'iterations/iter-003/gate-a-intake/intake.json',
        ' Iteration 3 refines this for composed baseline reporting.',
      );
      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration draft generated')) {
        console.error(`iteration Gate B draft from composed current-spec fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

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
      writeFileSync(path.join(contextCodeRoot, 'scripts', 'application.js'), 'application script\n', 'utf8');

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
          || !taskContext.planning_memory
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
        if (!codeSignals.file_tree.includes('scripts/application.js')) {
          throw new Error('context code_signals file_tree missing application scripts');
        }
        if (codeSignals.file_tree.some((filePath) => filePath.includes('.plan2agent'))) {
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
        '`planning_memory`',
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
      const promotedStatus = readFileSync(path.join(artifactRoot, 'status.md'), 'utf8');
      if (
        !promotedStatus.includes('Progress: [scope:approved] -> [spec:approved] -> [plan:valid]')
        || !promotedStatus.includes(`- 상태: ${promotedTaskGraph.tasks.length} task(s)`)
      ) {
        console.error(`iteration promote-tasks left status.md in a pending Gate C state: ${caseData.id}`);
        console.error(promotedStatus);
        return { status: 1, checks };
      }
      const iter3DraftMeta = existsSync(iter3DraftMetaPath) ? JSON.parse(readFileSync(iter3DraftMetaPath, 'utf8')) : null;
      if (
        !iter3DraftMeta
        || iter3DraftMeta.schema_version !== 'p2a.task_graph_draft_meta.v1'
        || iter3DraftMeta.iteration_id !== 'iter-003'
        || typeof iter3DraftMeta.draft_sha256 !== 'string'
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

      const closeReadyIter3TaskGraph = JSON.parse(readFileSync(iter3TaskGraphPath, 'utf8'));
      for (const task of closeReadyIter3TaskGraph.tasks) task.status = 'done';
      writeFileSync(
        iter3TaskGraphPath,
        `${JSON.stringify(closeReadyIter3TaskGraph, null, 2)}\n`,
        'utf8',
      );
      result = runIteration(['close', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration closed')) {
        console.error(`iteration close iter-003 fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration([
        'open',
        '--artifacts',
        artifactRoot,
        '--iteration-id',
        'iter-before-third-compose',
        '--idea',
        'Must not skip the latest closed iteration',
      ]);
      checks += 1;
      const staleThirdOpenOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.status === 0
        || !staleThirdOpenOutput.includes('missing ["iter-003"]')
        || !staleThirdOpenOutput.includes('iteration compose')
      ) {
        console.error(`iteration open skipped the latest closed composition source: ${caseData.id}`);
        writeResultOutput(result);
        return { status: 1, checks };
      }

      result = runIteration(['compose', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('current spec composed')) {
        console.error(`iteration compose iter-003 immutable baseline fixture check failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      result = runIteration(['validate', '--artifacts', artifactRoot, '--require-close-ready']);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('close-ready: all tasks done')) {
        console.error(`iteration validate after iter-003 composition failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const postIter3HandoffTarget = path.join(tempRoot, 'post-iter-003-handoff-target');
      result = runHandoff([
        '--project-id',
        caseData.project_id,
        '--artifacts',
        artifactRoot,
        '--target',
        postIter3HandoffTarget,
        '--iteration-id',
        'iter-003',
      ]);
      checks += 1;
      if (result.status !== 0) {
        console.error(`iteration handoff after iter-003 composition failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }

      const iter4Id = 'iter-004';
      result = runIteration([
        'open',
        '--artifacts',
        artifactRoot,
        '--iteration-id',
        iter4Id,
        '--idea',
        'Verify immutable composed baseline snapshots',
      ]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('iteration opened')) {
        console.error(`iteration open iter-004 after composition failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const iter4CurrentSpec = JSON.parse(readFileSync(state.currentSpecPath, 'utf8'));
      const iter4BaselineRef = `iterations/${iter4Id}/baseline/current-spec.json`;
      const iter4BaselinePath = path.join(artifactRoot, iter4BaselineRef);
      if (
        iter4CurrentSpec.pending_iteration?.baseline_effective_spec_ref !== iter4BaselineRef
        || !existsSync(iter4BaselinePath)
        || iter4CurrentSpec.pending_iteration?.baseline_effective_spec_sha256
          !== hashText(readFileSync(iter4BaselinePath))
      ) {
        console.error(`iteration open did not persist an immutable composed baseline snapshot: ${caseData.id}`);
        console.error(JSON.stringify(iter4CurrentSpec.pending_iteration, null, 2));
        return { status: 1, checks };
      }

      result = runIteration(['draft', '--artifacts', artifactRoot]);
      checks += 1;
      if (result.status !== 0 || !result.stdout.includes('Gate A scope confirmation required')) {
        console.error(`iteration draft from immutable composed baseline failed: ${caseData.id}`);
        writeResultOutput(result);
        return { status: failureStatus(result), checks };
      }
      const iter4Intake = JSON.parse(readFileSync(
        path.join(artifactRoot, 'iterations', iter4Id, 'gate-a-intake', 'intake.json'),
        'utf8',
      ));
      if (
        iter4Intake.baseline_context?.spec_ref !== iter4BaselineRef
        || iter4Intake.baseline_context?.spec_sha256
          !== iter4CurrentSpec.pending_iteration.baseline_effective_spec_sha256
      ) {
        console.error(`iteration Gate A did not bind the immutable composed baseline hash: ${caseData.id}`);
        console.error(JSON.stringify(iter4Intake.baseline_context, null, 2));
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

  const supervisedBatchExecutionResult = runNodeTestFile('tests/supervised-batch-execution.test.mjs');
  writeResultOutput(supervisedBatchExecutionResult);
  if (supervisedBatchExecutionResult.status !== 0) return failureStatus(supervisedBatchExecutionResult);

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
  segments.push(`${countNodeTestCases(supervisedBatchExecutionResult.stdout)} supervised batch execution test(s)`);
  segments.push(`${countNodeTestCases(evalStableMetricsResult.stdout)} eval stable metrics test(s)`);

  console.log(`Validated ${formatSegments(segments)}`);
  return 0;
}

process.exitCode = main();
