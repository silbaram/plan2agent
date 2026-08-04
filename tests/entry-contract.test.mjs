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
  makeTempDir,
  runP2a,
} from './helpers/fixtures.mjs';

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

    const missing = runP2a(['validate', '--entry', path.join(root, 'missing.md')]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /entry document is missing/);

    writeFileSync(entryPath, '팀은 지금 많은 시간을 낭비하고 있다.\n', 'utf8');
    const missingWhat = runP2a(['validate', '--entry', entryPath]);
    assert.notEqual(missingWhat.status, 0);
    assert.match(`${missingWhat.stdout}${missingWhat.stderr}`, /describe what will be built/);
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
    assert.match(result.stderr, /22 recommendations; only the first 8 are promoted/);
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
    assert.match(next.command.display, /002-followup\/collection-report\.md/);

    const info = runP2a(['info', '--target', root, '--json']);
    assert.equal(info.status, 0, `${info.stdout}${info.stderr}`);
    const infoPayload = JSON.parse(info.stdout);
    assert.equal(infoPayload.entry.valid, true);
    assert.match(infoPayload.entry.path, /002-followup\/collection-report\.md$/);

    const doctor = runP2a(['doctor', '--target', root, '--json']);
    assert.notEqual(doctor.status, null, `${doctor.stdout}${doctor.stderr}`);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.projectState.state, 'planning_in_progress');
    assert.match(
      doctorPayload.projectState.commands[0].command,
      /p2a validate --entry .*002-followup\/collection-report\.md/,
    );

    rmSync(path.join(latestRoot, 'collection-report.md'));
    const manifestPath = path.join(latestRoot, 'handoff-manifest.md');
    const manifest = readFileSync(manifestPath, 'utf8')
      .replace('- collection-report.md\n', '');
    writeFileSync(manifestPath, manifest, 'utf8');
    next = runNext(root);
    assert.equal(next.state, 'gate_what');
    assert.match(next.command.display, /002-followup\/next-iteration-recommendations\.md/);

    rmSync(manifestPath);
    const invalidRadar = runP2a([
      'validate',
      '--entry',
      path.join(latestRoot, 'next-iteration-recommendations.md'),
    ]);
    assert.notEqual(invalidRadar.status, 0);
    assert.match(`${invalidRadar.stdout}${invalidRadar.stderr}`, /requires sibling handoff-manifest\.md/);
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
    writeRadarSequence(artifactRoot, '001-entry', {
      'collection-report.md': '# Collection Report\n\nBuild a delivery dashboard for webhook operators.\n',
    });
    const directEntry = path.join(root, 'direct-entry.md');
    writeFileSync(directEntry, 'Build a competing project dashboard.\n', 'utf8');

    for (const args of [[], ['--entry', 'direct-entry.md']]) {
      const next = runNext(root, args);
      assert.equal(next.state, 'gate_d_passed_needs_iteration_init');
      assert.equal(next.command.kind, 'cli');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
