import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FIXTURE_ROOT,
  ROOT,
  makeTempDir,
  runP2a,
} from './helpers/fixtures.mjs';
import { inspectEntryDocument } from '../scripts/p2a_radar_preflight.mjs';

const posix = (value) => String(value).replace(/\\+/g, '/');

test('path assertions normalize Linux and Windows separators', () => {
  const expected = 'C:/Users/dev/002-followup/collection-report.md';
  assert.equal(posix('/tmp/p2a/002-followup/collection-report.md'), '/tmp/p2a/002-followup/collection-report.md');
  assert.equal(posix(String.raw`C:\Users\dev\002-followup\collection-report.md`), expected);
  assert.equal(posix(String.raw`C:\\Users\\dev\\002-followup\\collection-report.md`), expected);
});

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function project() {
  const root = makeTempDir('p2a-entry-');
  writeJson(path.join(root, '.plan2agent', 'manifest.json'), {
    provenance: { mode: 'scaffold' },
  });
  return root;
}

function writeRadarSequence(artifactRoot, sequence, files, options = {}) {
  const sequenceRoot = path.join(artifactRoot, 'preflight-research', sequence);
  mkdirSync(sequenceRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(sequenceRoot, name), content, 'utf8');
  }
  writeFileSync(
    path.join(sequenceRoot, 'handoff-manifest.md'),
    [
      '# Feature Radar Handoff Manifest',
      '',
      `source_run: /tmp/feature-radar/${sequence}`,
      'mode: p2a-preflight',
      `run_mode: ${options.runMode ?? 'idea'}`,
      'handoff_mode: p2a-preflight',
      `preflight_sequence: ${sequence}`,
      'source_complete: true',
      '',
      '## Copied Files',
      '',
      ...Object.keys(files).map((name) => `- ${name}`),
      '',
    ].join('\n'),
    'utf8',
  );
  return sequenceRoot;
}

function runNext(root, args = []) {
  const result = runP2a(['next', '--target', root, '--json', ...args]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('entry confirmation dialogue stays compact and preserves the existing gate contracts', () => {
  const skill = readFileSync(path.join(ROOT, '.agents', 'skills', 'p2a-harness', 'SKILL.md'), 'utf8');
  const heading = '## Entry Document Confirmation Dialogue';
  const start = skill.indexOf(heading);
  const end = skill.indexOf('\n## ', start + heading.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const section = skill.slice(start, end);

  assert.ok(Buffer.byteLength(section, 'utf8') <= 2500);
  assert.match(section, /Present one compact interpretation of what will be built/);
  assert.match(section, /Ask only for information or decisions that cannot be safely inferred/);
  assert.match(section, /no fixed question-count or round limit/);
  assert.match(section, /Do not materialize discovery dimensions, CQ\/ND ids/);
  assert.match(section, /explicitly ask the user to confirm/);
  assert.match(section, /`selected`, `rejected`, or `deferred`/);
  assert.match(section, /unchanged `p2a\.intake\.v1` contract/);
  assert.match(skill, /## Discovery Interview Loop/);

  const geminiCommand = readFileSync(
    path.join(ROOT, '.gemini', 'commands', 'p2a', 'harness.toml'),
    'utf8',
  );
  assert.match(geminiCommand, /validated --entry document/);
  assert.match(geminiCommand, /no fixed question or round limit/);
});

test('entry contract documentation records discovery, validation, dialogue, and compatibility boundaries', () => {
  const contract = readFileSync(path.join(ROOT, 'docs', 'entry-contract.md'), 'utf8');
  assert.match(contract, /## 2\. 최소 문서 계약/);
  assert.match(contract, /## 3\. 발견과 우선순위/);
  assert.match(contract, /`p2a next --entry <path>`/);
  assert.match(contract, /collection-report\.md/);
  assert.match(contract, /next-iteration-recommendations\.md/);
  assert.match(contract, /handoff-manifest\.md/);
  assert.match(contract, /capability-gap-analysis\.md/);
  assert.match(contract, /source-candidates\.md/);
  assert.match(contract, /`constitution\.json` 재사용/);
  assert.match(contract, /`CQ-n`\/`ND-n`/);
  assert.match(contract, /12개를 초과하거나 추천 항목이 8개를 초과하면.*warning/);
  assert.match(contract, /`state: entry_invalid`/);
  assert.match(contract, /`state: initialized_without_artifacts`/);
  assert.match(contract, /`state: gate_what`/);
  assert.match(contract, /## 6\. 범위 확인 대화/);
  assert.match(contract, /`selected`, `rejected`, `deferred`/);
  assert.match(contract, /기존 intake\/requirements 인터뷰/);
  assert.match(contract, /approved spec이 없을 때 downstream task 생성을 막는 규칙/);
});

test('a thin user-authored entry document validates and enters scope confirmation without Radar', () => {
  const root = project();
  try {
    const entryPath = path.join(root, 'idea.md');
    writeFileSync(
      entryPath,
      '팀이 실패한 배포를 재현할 수 있도록 실행 증거를 모으는 CLI 도구를 만든다.\n',
      'utf8',
    );

    const validation = runP2a(['validate', '--entry', entryPath]);
    assert.equal(validation.status, 0, `${validation.stdout}${validation.stderr}`);
    assert.match(validation.stdout, /document: present and non-empty/);
    assert.match(validation.stdout, /scope: what will be built is described/);
    assert.match(validation.stdout, /limits: 0 web source\(s\), 0 recommendation\(s\)/);
    assert.match(validation.stdout, /provenance: user document/);

    const next = runNext(root, ['--entry', 'idea.md']);
    assert.equal(next.state, 'gate_what');
    assert.equal(next.command.kind, 'skill');
    assert.match(next.command.display, /p2a-harness --entry ".*idea\.md"/);

    writeFileSync(entryPath, '릴리즈 상태를 한눈에 보여주는 운영 화면.\n', 'utf8');
    const thinNounPhrase = runP2a(['validate', '--entry', entryPath]);
    assert.equal(thinNounPhrase.status, 0, `${thinNounPhrase.stdout}${thinNounPhrase.stderr}`);

    const missing = runP2a(['validate', '--entry', path.join(root, 'missing.md')]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /entry document is missing/);

    writeFileSync(entryPath, '팀은 지금 많은 시간을 낭비하고 있다.\n', 'utf8');
    const missingWhat = runP2a(['validate', '--entry', entryPath]);
    assert.equal(missingWhat.status, 0, `${missingWhat.stdout}${missingWhat.stderr}`);
    assert.match(missingWhat.stdout, /scope: confirm what will be built in the dialogue/);
    assert.match(missingWhat.stderr, /may not state what will be built/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plain description without dictionary keywords still validates with a scope warning', () => {
  const root = project();
  try {
    const entryPath = path.join(root, 'idea.md');
    writeFileSync(
      entryPath,
      'Webhook relay for Slack. Receives inbound events and forwards them.\n',
      'utf8',
    );

    const entry = inspectEntryDocument(entryPath);
    assert.equal(entry.valid, true);
    assert.equal(entry.checks.scopeWhat, false);
    assert.deepEqual(entry.errors, []);
    assert.match(entry.warnings.join('\n'), /confirm the scope in the dialogue/);

    const validation = runP2a(['validate', '--entry', entryPath]);
    assert.equal(validation.status, 0, `${validation.stdout}${validation.stderr}`);
    assert.match(validation.stderr, /may not state what will be built/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh harness without an entry document still routes to the one-line idea interview', () => {
  const root = project();
  try {
    const next = runNext(root);
    assert.equal(next.state, 'initialized_without_artifacts');
    assert.equal(next.command.kind, 'skill');
    assert.equal(next.command.display, '/p2a-harness "<one-sentence idea>"');

    const invalid = runNext(root, ['--entry', 'missing.md']);
    assert.equal(invalid.state, 'entry_invalid');
    assert.equal(invalid.command.kind, 'approval');
    assert.match(invalid.command.display, /validate --entry .*missing\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('entry source and recommendation caps warn without rejecting the original document', () => {
  const root = project();
  try {
    const entryPath = path.join(root, 'large-entry.txt');
    const urls = Array.from(
      { length: 13 },
      (_, index) => `- Source ${index + 1}: https://example.com/source-${index + 1}`,
    );
    const recommendations = Array.from(
      { length: 9 },
      (_, index) => `${index + 1}. Add dashboard capability ${index + 1}`,
    );
    writeFileSync(
      entryPath,
      [
        'Build a release dashboard for platform teams.',
        '',
        ...urls,
        '',
        ...recommendations,
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runP2a(['validate', '--entry', entryPath]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /13 web sources; only the first 12 are promoted/);
    assert.match(result.stderr, /9 recommendations; only the first 8 are promoted/);
    assert.doesNotMatch(result.stderr, /22 recommendations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the latest Radar sequence chooses collection report first and existing-project recommendations as fallback', () => {
  const root = project();
  try {
    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'sample');
    writeRadarSequence(artifactRoot, '001-initial', {
      'collection-report.md': '# Collection Report\n\nBuild an operator dashboard for webhook delivery.\n',
    });
    const latestRoot = writeRadarSequence(
      artifactRoot,
      '002-followup',
      {
        'collection-report.md': '# Collection Report\n\nBuild a retry timeline for webhook operators.\n',
        'next-iteration-recommendations.md': [
          '# Next Iteration Recommendations',
          '',
          'mode: existing-project',
          '',
          '1. Add a retry timeline to the operator dashboard.',
          '',
        ].join('\n'),
      },
      { runMode: 'existing-project' },
    );

    let next = runNext(root);
    assert.equal(next.state, 'gate_what');
    assert.match(posix(next.command.display), /002-followup\/collection-report\.md/);

    const info = runP2a(['info', '--target', root, '--json']);
    assert.equal(info.status, 0, `${info.stdout}${info.stderr}`);
    const infoPayload = JSON.parse(info.stdout);
    assert.equal(infoPayload.entry.valid, true);
    assert.match(posix(infoPayload.entry.path), /002-followup\/collection-report\.md$/);

    const doctor = runP2a(['doctor', '--target', root, '--json']);
    assert.notEqual(doctor.status, null, `${doctor.stdout}${doctor.stderr}`);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.projectState.state, 'planning_in_progress');
    assert.match(
      posix(doctorPayload.projectState.commands[0].command),
      /p2a validate --entry .*002-followup\/collection-report\.md/,
    );

    rmSync(path.join(latestRoot, 'collection-report.md'));
    const manifestPath = path.join(latestRoot, 'handoff-manifest.md');
    const manifest = readFileSync(manifestPath, 'utf8')
      .replace('- collection-report.md\n', '');
    writeFileSync(manifestPath, manifest, 'utf8');
    next = runNext(root);
    assert.equal(next.state, 'gate_what');
    assert.match(posix(next.command.display), /002-followup\/next-iteration-recommendations\.md/);

    rmSync(manifestPath);
    const incompleteRadar = runP2a([
      'validate',
      '--entry',
      path.join(latestRoot, 'next-iteration-recommendations.md'),
    ]);
    assert.equal(incompleteRadar.status, 0, `${incompleteRadar.stdout}${incompleteRadar.stderr}`);
    assert.match(incompleteRadar.stderr, /requires sibling handoff-manifest\.md/);

    const incompleteDoctor = runP2a(['doctor', '--target', root, '--json']);
    assert.equal(JSON.parse(incompleteDoctor.stdout).projectState.state, 'planning_in_progress');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an incomplete Radar handoff manifest warns but does not block entry', () => {
  const root = project();
  try {
    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'sample');
    const sequenceRoot = writeRadarSequence(artifactRoot, '001-entry', {
      'collection-report.md': '# Collection Report\n\nBuild a delivery dashboard.\n',
    });
    const entryPath = path.join(sequenceRoot, 'collection-report.md');
    writeFileSync(
      path.join(sequenceRoot, 'handoff-manifest.md'),
      '# Feature Radar Handoff Manifest\n\nhandoff_mode: p2a-preflight\n',
      'utf8',
    );

    const entry = inspectEntryDocument(entryPath);
    assert.equal(entry.valid, true);
    assert.equal(entry.checks.provenance, false);
    assert.deepEqual(entry.errors, []);
    assert.ok(entry.warnings.length > 0);
    assert.match(entry.warnings.join('\n'), /must record source_run/);

    const next = runNext(root);
    assert.equal(next.state, 'gate_what');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical Gate artifacts take deterministic priority over a coexisting entry document', () => {
  const root = project();
  try {
    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(path.dirname(artifactRoot), { recursive: true });
    cpSync(path.join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, {
      recursive: true,
    });
    const sequenceRoot = writeRadarSequence(artifactRoot, '001-entry', {
      'collection-report.md': '# Collection Report\n\nBuild a delivery dashboard for webhook operators.\n',
    });
    const directEntry = path.join(root, 'direct-entry.md');
    writeFileSync(directEntry, 'Build a competing project dashboard.\n', 'utf8');

    for (const args of [
      [],
      ['--entry', 'direct-entry.md'],
      ['--entry', 'missing-entry.md'],
    ]) {
      const next = runNext(root, args);
      assert.equal(next.state, 'gate_d_passed_needs_iteration_init');
      assert.equal(next.command.kind, 'cli');
    }

    rmSync(path.join(sequenceRoot, 'handoff-manifest.md'));
    const doctor = runP2a(['doctor', '--target', root, '--json']);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.notEqual(doctorPayload.projectState.state, 'broken_install');
    assert.doesNotMatch(
      JSON.stringify(doctorPayload.projectState.diagnostics),
      /Entry document is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit entry wins over multiple automatically discovered preflight roots', () => {
  const root = project();
  try {
    for (const projectId of ['one', 'two']) {
      writeRadarSequence(
        path.join(root, '.plan2agent', 'artifacts', projectId),
        '001-entry',
        {
          'collection-report.md': `# Collection Report\n\nBuild a dashboard for ${projectId}.\n`,
        },
      );
    }
    writeFileSync(path.join(root, 'idea.md'), 'Build a separate release console.\n', 'utf8');

    const next = runNext(root, ['--entry', 'idea.md']);
    assert.equal(next.state, 'gate_what');
    assert.match(next.command.display, /idea\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a confirmed entry can hand off to the existing approved Gate B flow', () => {
  const root = project();
  try {
    const entryPath = path.join(root, 'idea.md');
    writeFileSync(entryPath, 'Build a webhook delivery console.\n', 'utf8');
    assert.equal(runNext(root, ['--entry', 'idea.md']).state, 'gate_what');

    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'webhook-api-service');
    mkdirSync(artifactRoot, { recursive: true });
    for (const gate of ['gate-a-intake', 'gate-b-spec']) {
      cpSync(path.join(FIXTURE_ROOT, '_e2e', 'webhook-api-service', gate), path.join(artifactRoot, gate), {
        recursive: true,
      });
    }

    const next = runNext(root, ['--entry', 'idea.md']);
    assert.equal(next.state, 'gate_b_approved_needs_tasks');
    assert.equal(next.command.display, '/p2a-task-breakdown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
