#!/usr/bin/env node
/** Inspect, migrate, and approve the persistent Plan2Agent project constitution. */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendDecisionEventsLocked,
  constitutionApprovalState,
  constitutionContentSha256,
  decisionLedgerPath,
  fileSha256,
  latestActiveConstitutionApproval,
  latestConstitutionApproval,
  readDecisions,
  resolveDecisionArtifactRoot,
  withDecisionLedgerLock,
} from './p2a_decision_ledger.mjs';
import { atomicWriteJson, atomicWriteText } from './p2a_run_store.mjs';
import { resolveP2aPaths } from './p2a_paths.mjs';
import { resolveProjectIdDefault } from './p2a_project_config.mjs';
import { validateConstitution, ValidationError } from './validate_artifacts.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const CONSTITUTION_RELATIVE = path.join('.plan2agent', 'constitution.json');
const LEGACY_STYLE_RELATIVE = path.join('.plan2agent', 'style.md');
const COMMANDS = new Set(['status', 'approve', 'revoke', 'migrate-style']);

function usage() {
  return [
    'Usage:',
    '  p2a shape [--target <dir>] [--json]',
    '  p2a shape approve --quote <user-utterance> [--target <dir>]',
    '  p2a shape revoke --quote <user-utterance> [--target <dir>]',
    '  p2a shape migrate-style [--project-id <id>] [--target <dir>]',
    '',
    'Notes:',
    '  Gate ② approval always requires a verbatim user quote.',
    '  migrate-style creates a draft constitution and leaves approval to the user.',
  ].join('\n');
}

function parseArgs(argv) {
  const first = argv[0];
  const command = first && !first.startsWith('-') ? first : 'status';
  if (!COMMANDS.has(command)) throw new ValidationError(`unknown shape command: ${command}`);
  const args = {
    command,
    target: P2A_PATHS.projectRoot,
    projectId: null,
    quote: null,
    json: false,
    help: false,
  };
  const start = command === 'status' && command !== first ? 0 : 1;
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--target') {
      args.target = argv[++index];
      if (!args.target) throw new ValidationError('--target requires a project directory');
    } else if (arg === '--project-id') {
      args.projectId = argv[++index];
      if (!args.projectId) throw new ValidationError('--project-id requires a project id');
    } else if (arg === '--quote') {
      args.quote = argv[++index];
      if (!args.quote?.trim()) throw new ValidationError('--quote requires a non-empty verbatim user utterance');
    } else {
      throw new ValidationError(`unknown shape option: ${arg}`);
    }
  }
  if (!['approve', 'revoke'].includes(command) && args.quote !== null) throw new ValidationError('--quote is only supported by shape approve or revoke');
  if (command !== 'migrate-style' && args.projectId !== null) throw new ValidationError('--project-id is only supported by shape migrate-style');
  return args;
}

function assertDirectory(directory, label) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new ValidationError(`${label} must be an existing directory: ${directory}`);
  }
}

function readJsonObject(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return {};
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function inspect(targetInput) {
  const target = path.resolve(targetInput);
  assertDirectory(target, '--target');
  const constitutionPath = path.join(target, CONSTITUTION_RELATIVE);
  const legacyStylePath = path.join(target, LEGACY_STYLE_RELATIVE);
  const legacyStyle = existsSync(legacyStylePath) && lstatSync(legacyStylePath).isFile();
  if (!existsSync(constitutionPath)) {
    return {
      schema_version: 'p2a.shape.v1',
      target,
      state: legacyStyle ? 'legacy_style' : 'missing',
      constitution: CONSTITUTION_RELATIVE,
      approved: false,
      legacyStyle,
      counts: { architecture: 0, stack: 0, prohibitions: 0 },
      next: legacyStyle
        ? 'Legacy style.md remains supported. Run p2a shape migrate-style to create an optional Gate ② draft.'
        : 'Run the p2a-harness Gate ② procedure to propose architecture, stack, prohibitions, and style.',
    };
  }
  if (!lstatSync(constitutionPath).isFile()) {
    return {
      schema_version: 'p2a.shape.v1',
      target,
      state: 'invalid',
      constitution: CONSTITUTION_RELATIVE,
      approved: false,
      legacyStyle,
      counts: { architecture: 0, stack: 0, prohibitions: 0 },
      error: 'constitution path is not a regular file',
      next: `Repair ${CONSTITUTION_RELATIVE}, then run p2a validate --constitution ${CONSTITUTION_RELATIVE}.`,
    };
  }
  let decisionArtifactRoot = null;
  try {
    const constitution = validateConstitution(constitutionPath);
    let approval = {
      approved: Boolean(constitution.approval_audit),
      source: 'approval_audit',
      event: null,
    };
    decisionArtifactRoot = resolveDecisionArtifactRoot(target, {
      projectId: constitution.projectId,
      optional: true,
    });
    if (decisionArtifactRoot) {
      const ledgerExists = existsSync(decisionLedgerPath(decisionArtifactRoot));
      approval = constitutionApprovalState(
        readDecisions(decisionArtifactRoot),
        fileSha256(constitutionPath),
        approval.approved,
        { allowLegacyFallback: !ledgerExists },
      );
    }
    const approved = approval.approved;
    return {
      schema_version: 'p2a.shape.v1',
      target,
      projectId: constitution.projectId,
      state: approved ? 'approved' : approval.event?.type === 'gate.how.revoked' ? 'revoked' : 'draft',
      constitution: CONSTITUTION_RELATIVE,
      approved,
      approvalSource: approval.source,
      legacyStyle,
      counts: {
        architecture: constitution.architecture.length,
        stack: constitution.stack.length,
        prohibitions: constitution.prohibitions.length,
      },
      next: approved
        ? 'Reuse this constitution for specification and implementation until an architecture-changing scope explicitly reopens Gate ②.'
        : 'Review the Gate ② draft, then run p2a shape approve --quote "<user utterance>".',
    };
  } catch (error) {
    return {
      schema_version: 'p2a.shape.v1',
      target,
      state: 'invalid',
      constitution: CONSTITUTION_RELATIVE,
      approved: false,
      legacyStyle,
      counts: { architecture: 0, stack: 0, prohibitions: 0 },
      error: error.message,
      next: decisionArtifactRoot
        ? `Repair ${decisionLedgerPath(decisionArtifactRoot)}, then run p2a validate --decisions --artifacts ${JSON.stringify(decisionArtifactRoot)}.`
        : `Repair ${CONSTITUTION_RELATIVE}, then run p2a validate --constitution ${CONSTITUTION_RELATIVE}.`,
    };
  }
}

export function renderShapeHuman(result) {
  const lines = ['Plan2Agent shape', '', '[한눈에]'];
  if (result.state === 'draft' || result.state === 'revoked') {
    lines.push(
      `지금 결정하는 것: ${result.projectId ?? '이 프로젝트'}에서 개발하는 동안 계속 지킬 공통 원칙입니다.`,
      '승인하면 → 이 원칙을 기준으로 개발 계획을 구체화합니다.',
      '거부하면 → 원칙을 수정한 뒤 다시 확인합니다.',
      '',
      '[실행 명령]',
      '  p2a shape approve --quote "<사용자가 실제로 승인한 문장>"',
    );
  } else if (result.state === 'approved') {
    lines.push(
      '프로젝트의 공통 개발 원칙이 승인되어 있습니다.',
      '현재 범위가 이 원칙을 바꾸지 않는다면 다시 승인할 필요가 없습니다.',
      '',
      '[실행 명령]',
      `  ${result.next}`,
    );
  } else {
    lines.push(
      '프로젝트의 공통 개발 원칙을 준비하거나 복구해야 합니다.',
      '',
      '[실행 명령]',
      `  ${result.next}`,
    );
  }
  lines.push(
    '',
    '[세부 계약]',
    `- target: ${result.target}`,
    `- state: ${result.state}`,
    `- constitution: ${result.constitution}`,
  );
  if (result.projectId) lines.push(`- projectId: ${result.projectId}`);
  lines.push(
    `- rules: architecture=${result.counts.architecture} stack=${result.counts.stack} prohibitions=${result.counts.prohibitions}`,
    `- legacy style.md: ${result.legacyStyle ? 'present' : 'absent'}`,
  );
  if (result.error) lines.push(`- error: ${result.error}`);
  lines.push(`- next: ${result.next}`);
  return `${lines.join('\n')}\n`;
}

function printStatus(result) {
  process.stdout.write(renderShapeHuman(result));
}

function approve(args) {
  if (!args.quote?.trim()) {
    throw new ValidationError('shape approve requires --quote with the verbatim user approval utterance');
  }
  const target = path.resolve(args.target);
  assertDirectory(target, '--target');
  const constitutionPath = path.join(target, CONSTITUTION_RELATIVE);
  if (!existsSync(constitutionPath) || !lstatSync(constitutionPath).isFile()) {
    throw new ValidationError(`shape approve requires a Gate ② draft at ${constitutionPath}`);
  }
  const constitution = validateConstitution(constitutionPath);
  const artifactRoot = resolveDecisionArtifactRoot(target, {
    projectId: constitution.projectId,
    create: true,
  });
  return withDecisionLedgerLock(artifactRoot, () => {
    const original = readFileSync(constitutionPath, 'utf8');
    const records = readDecisions(artifactRoot);
    const previous = latestConstitutionApproval(records);
    const contentSha256 = constitutionContentSha256(constitution);
    const approved = {
      ...constitution,
      approval_audit: {
        approved_by: 'user',
        approved_at: new Date().toISOString().slice(0, 10),
        approved_artifacts: ['.plan2agent/constitution.json'],
        approval_note: `User quote: ${JSON.stringify(args.quote)}`,
      },
    };
    try {
      atomicWriteJson(constitutionPath, approved);
      validateConstitution(constitutionPath, { requireApproved: true });
      const constitutionSha256 = fileSha256(constitutionPath);
      const events = [];
      if (
        previous?.constitution_content_sha256
        && previous.constitution_content_sha256 !== contentSha256
      ) {
        events.push({
          type: 'constitution.changed',
          quote: args.quote,
          constitution_sha256: constitutionSha256,
          constitution_content_sha256: contentSha256,
          previous_constitution_sha256: previous.constitution_sha256,
        });
      }
      events.push({
        type: 'gate.how.approved',
        quote: args.quote,
        constitution_sha256: constitutionSha256,
        constitution_content_sha256: contentSha256,
      });
      const appended = appendDecisionEventsLocked(artifactRoot, events);
      console.log(`Plan2Agent Gate ② approved: ${constitutionPath}`);
      console.log(`- projectId: ${approved.projectId}`);
      console.log(`- decision: seq=${appended.at(-1).seq} type=gate.how.approved`);
      console.log('- approval quote: recorded');
      return 0;
    } catch (error) {
      atomicWriteText(constitutionPath, original);
      throw error;
    }
  });
}

function revoke(args) {
  if (!args.quote?.trim()) {
    throw new ValidationError('shape revoke requires --quote with the verbatim user revocation utterance');
  }
  const target = path.resolve(args.target);
  assertDirectory(target, '--target');
  const constitutionPath = path.join(target, CONSTITUTION_RELATIVE);
  if (!existsSync(constitutionPath) || !lstatSync(constitutionPath).isFile()) {
    throw new ValidationError(`shape revoke requires ${constitutionPath}`);
  }
  const constitution = validateConstitution(constitutionPath);
  const artifactRoot = resolveDecisionArtifactRoot(target, {
    projectId: constitution.projectId,
    create: true,
  });
  return withDecisionLedgerLock(artifactRoot, () => {
    const ledgerExists = existsSync(decisionLedgerPath(artifactRoot));
    const records = readDecisions(artifactRoot);
    const previous = latestActiveConstitutionApproval(records);
    if (!previous && ledgerExists) {
      throw new ValidationError('no active Gate ② decision is available to revoke');
    }
    if (!previous && !constitution.approval_audit) {
      throw new ValidationError('no approved Gate ② constitution is available to revoke');
    }
    const [event] = appendDecisionEventsLocked(artifactRoot, [{
      type: 'gate.how.revoked',
      quote: args.quote,
      constitution_sha256: fileSha256(constitutionPath),
      constitution_content_sha256: constitutionContentSha256(constitution),
      ...(previous ? { prev_seq: previous.seq } : {}),
    }]);
    console.log(`Plan2Agent Gate ② approval revoked: ${constitutionPath}`);
    console.log(`- decision: seq=${event.seq} type=${event.type}`);
    return 0;
  });
}

function migrateStyle(args) {
  const target = path.resolve(args.target);
  assertDirectory(target, '--target');
  const constitutionPath = path.join(target, CONSTITUTION_RELATIVE);
  const legacyStylePath = path.join(target, LEGACY_STYLE_RELATIVE);
  if (existsSync(constitutionPath)) {
    throw new ValidationError(`constitution already exists: ${constitutionPath}`);
  }
  if (!existsSync(legacyStylePath) || !lstatSync(legacyStylePath).isFile()) {
    throw new ValidationError(`legacy style contract is missing: ${legacyStylePath}`);
  }
  const projectConfig = readJsonObject(path.join(target, '.plan2agent', 'project.config.json'));
  const manifest = readJsonObject(path.join(target, '.plan2agent', 'manifest.json'));
  const projectId = args.projectId ?? resolveProjectIdDefault(target, projectConfig, manifest);
  const draft = {
    schema_version: 'p2a.constitution.v1',
    projectId,
    architecture: [],
    stack: [],
    prohibitions: [],
    style: {
      source: '.plan2agent/style.md',
      contract_markdown: readFileSync(legacyStylePath, 'utf8'),
    },
  };
  atomicWriteJson(constitutionPath, draft);
  validateConstitution(constitutionPath);
  console.log(`Plan2Agent legacy style migrated to Gate ② draft: ${constitutionPath}`);
  console.log('- review architecture, stack, prohibitions, and imported style before approval');
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.command === 'approve') return approve(args);
    if (args.command === 'revoke') return revoke(args);
    if (args.command === 'migrate-style') return migrateStyle(args);
    const result = inspect(args.target);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printStatus(result);
    return 0;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError || error?.code) {
      console.error(`p2a shape error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntry()) process.exitCode = main();
