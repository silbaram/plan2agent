import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
import {
  validateIntake,
  validateSchema,
  validateSpec,
} from '../scripts/validate_artifacts.mjs';

const posix = (value) => String(value).replace(/\\+/g, '/');
const REFERENCE_BUNDLE_SCHEMA = JSON.parse(readFileSync(
  path.join(ROOT, 'schemas', 'reference-bundle.schema.json'),
  'utf8',
));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

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

  assert.ok(Buffer.byteLength(section, 'utf8') >= 1500);
  assert.ok(Buffer.byteLength(section, 'utf8') <= 2500);
  assert.match(section, /Present one compact interpretation/);
  assert.match(section, /There is no fixed question count or conversation-turn limit/);
  assert.match(section, /explicitly ask the user to confirm that interpretation/);
  assert.match(section, /every promoted candidate with exactly one `selected`, `rejected`, or `deferred` disposition/);
  assert.match(section, /persist `intake\.json`/);
  assert.match(section, /The entry file is evidence, not the control plane/);

  const geminiCommand = readFileSync(
    path.join(ROOT, '.gemini', 'commands', 'p2a', 'harness.toml'),
    'utf8',
  );
  assert.match(geminiCommand, /Gemini is read-only/);
  assert.doesNotMatch(geminiCommand, /validated --entry document/);
  assert.doesNotMatch(geminiCommand, /explicit Gate A approval/);
});

test('entry contract documentation records validation, dialogue, and compatibility boundaries', () => {
  const contract = readFileSync(path.join(ROOT, 'docs', 'entry-contract.md'), 'utf8');
  const harnessGuide = readFileSync(path.join(ROOT, 'docs', 'harness-guide.md'), 'utf8');
  assert.match(contract, /## 2\. 최소 문서 계약/);
  assert.match(contract, /## 3\. 발견과 우선순위/);
  assert.match(contract, /`p2a next --entry <path>`/);
  assert.match(contract, /`p2a next --idea/);
  assert.match(contract, /collection-report\.md/);
  assert.match(contract, /next-iteration-recommendations\.md/);
  assert.match(contract, /handoff-manifest\.md/);
  assert.match(contract, /capability-gap-analysis\.md/);
  assert.match(contract, /source-candidates\.md/);
  assert.match(contract, /`constitution\.json` 재사용/);
  assert.match(contract, /의무적인 질문·결정 id 목록/);
  assert.match(contract, /12개를 초과하거나 추천 항목이 8개를 초과하면.*warning/);
  assert.match(contract, /`state: entry_invalid`/);
  assert.match(contract, /`state: entry_missing`/);
  assert.match(contract, /`command\.kind: approval`/);
  assert.match(contract, /`state: gate_what`/);
  assert.match(contract, /## 6\. 범위 확인 대화/);
  assert.match(contract, /`selected`, `rejected`, `deferred`/);
  assert.match(contract, /optional `interview` object/);
  assert.match(contract, /opaque 호환 데이터/);
  assert.match(contract, /approved spec이 없을 때 downstream task 생성을 막는 규칙/);
  assert.match(
    harnessGuide,
    /Entry document scope confirmation\(Gate A\)[\s\S]*Material project constitution approval\(Gate ②, 필요한 경우만\)[\s\S]*Product spec \+ Implementation plan\(Gate B\)/,
  );
});

test('Gate B authoring instructions never interpret opaque legacy interview data', () => {
  const instructionPaths = [
    path.join(ROOT, '.agents', 'skills', 'p2a-spec', 'SKILL.md'),
    path.join(ROOT, '.agents', 'agents', 'p2a-spec-author.md'),
    path.join(ROOT, '.agents', 'agents', 'p2a-implementation-planner.md'),
    path.join(ROOT, '.claude', 'skills', 'p2a-spec', 'SKILL.md'),
    path.join(ROOT, '.claude', 'agents', 'p2a-spec-author.md'),
    path.join(ROOT, '.claude', 'agents', 'p2a-implementation-planner.md'),
    path.join(ROOT, '.codex', 'agents', 'p2a-spec-author.toml'),
    path.join(ROOT, '.codex', 'agents', 'p2a-implementation-planner.toml'),
    path.join(ROOT, '.gemini', 'agents', 'p2a-spec-author.md'),
    path.join(ROOT, '.gemini', 'agents', 'p2a-implementation-planner.md'),
  ];

  for (const instructionPath of instructionPaths) {
    const content = readFileSync(instructionPath, 'utf8');
    assert.doesNotMatch(content, /current interview|interview-aware|legacy interview item/i, instructionPath);
  }

  const specSkill = readFileSync(instructionPaths[0], 'utf8');
  assert.match(specSkill, /Treat a legacy `interview` object as opaque compatibility data/);
  assert.match(specSkill, /Never inspect a legacy `interview` object to derive routing/);
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

test('entry reference bundle verifies rich local evidence without loading it into the entry text', () => {
  const root = makeTempDir('p2a-entry-reference-bundle-');
  try {
    const entryPath = path.join(root, 'idea.md');
    const htmlPath = path.join(root, 'prototype.html');
    const testPath = path.join(root, 'acceptance.test.mjs');
    const html = '<!doctype html><title>Reference prototype</title>\n';
    const acceptance = 'export const rubric = "entry stays concise";\n';
    writeFileSync(entryPath, '검증 가능한 참고 자료를 조건부로 제공하는 진입 계약을 구현한다.\n', 'utf8');
    writeFileSync(htmlPath, html, 'utf8');
    writeFileSync(testPath, acceptance, 'utf8');
    const bundle = {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [
        {
          id: 'REF-1',
          path: 'prototype.html',
          kind: 'html',
          sha256: sha256(html),
          load_when: 'Gate B needs screen composition evidence.',
          description: 'Passive reference prototype.',
        },
        {
          id: 'REF-2',
          path: 'acceptance.test.mjs',
          kind: 'test',
          sha256: sha256(acceptance),
          load_when: 'Gate B defines executable acceptance.',
          description: 'Reference acceptance rubric expressed as code.',
        },
      ],
    };
    assert.doesNotThrow(() => validateSchema(bundle, REFERENCE_BUNDLE_SCHEMA));
    writeJson(path.join(root, 'p2a-reference-bundle.json'), bundle);

    const inspected = inspectEntryDocument(entryPath);
    assert.equal(inspected.valid, true);
    assert.equal(inspected.referenceBundle.referenceCount, 2);
    assert.equal(inspected.referenceBundle.sha256, sha256(`${JSON.stringify(bundle, null, 2)}\n`));
    assert.deepEqual(inspected.referenceBundle.references.map((item) => item.kind), ['html', 'test']);
    assert.ok(inspected.referenceBundle.references.every((item) => item.bytes > 0));

    const validation = runP2a(['validate', '--entry', entryPath]);
    assert.equal(validation.status, 0, `${validation.stdout}${validation.stderr}`);
    assert.match(validation.stdout, /references: 2 hash-verified item\(s\)/);

    const info = runP2a(['info', '--target', root, '--entry', 'idea.md', '--json']);
    assert.equal(info.status, 0, `${info.stdout}${info.stderr}`);
    const infoPayload = JSON.parse(info.stdout);
    assert.equal(infoPayload.entry.referenceBundle.referenceCount, 2);
    assert.equal(infoPayload.entry.referenceBundle.sha256, inspected.referenceBundle.sha256);
    assert.deepEqual(
      infoPayload.entry.referenceBundle.references.map((item) => item.id),
      ['REF-1', 'REF-2'],
    );
    assert.ok(infoPayload.entry.referenceBundle.references.every((item) => !('content' in item)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate B reference usage is bound to the approved Gate A bundle snapshot and LOCAL evidence', () => {
  const root = makeTempDir('p2a-reference-provenance-');
  try {
    const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
    const specPath = path.join(root, 'gate-b-spec', 'spec.json');
    const snapshotPath = path.join(root, 'gate-a-intake', 'reference-bundle-snapshot.json');
    const usagePath = path.join(root, 'gate-b-spec', 'reference-bundle-usage.json');
    const intake = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'), 'utf8'));
    const spec = JSON.parse(readFileSync(path.join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'), 'utf8'));
    const approvalAudit = structuredClone(intake.approval_audit);
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
    writeJson(intakePath, intake);
    const entry = 'Build a workflow from approved references.\n';
    const prototype = '<!doctype html><title>Approved reference</title>\n';
    const sourceBundle = {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [
        {
          id: 'REF-1',
          path: 'prototype.html',
          kind: 'html',
          sha256: sha256(prototype),
          load_when: 'Gate B needs the approved screen composition.',
          description: 'Approved reference prototype.',
        },
      ],
    };
    writeFileSync(path.join(root, 'idea.md'), entry, 'utf8');
    writeFileSync(path.join(root, 'prototype.html'), prototype, 'utf8');
    writeJson(path.join(root, 'p2a-reference-bundle.json'), sourceBundle);
    const capture = runP2a([
      'reference',
      'snapshot',
      '--target', root,
      '--entry', 'idea.md',
      '--artifacts', root,
      '--json',
    ]);
    assert.equal(capture.status, 0, `${capture.stdout}${capture.stderr}`);
    const captureResult = JSON.parse(capture.stdout);
    assert.equal(captureResult.capturedFiles, 3);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const referenceSha = snapshot.references[0].sha256;
    const bundleSha = snapshot.source_bundle_sha256;
    const capturedReferencePath = path.join(
      path.dirname(snapshotPath),
      snapshot.references[0].path,
    );

    intake.status = 'ready_for_spec';
    intake.approval_audit = approvalAudit;
    intake.approval_audit.approved_artifacts.push('gate-a-intake/reference-bundle-snapshot.json');
    intake.approval_audit.approval_note += `\nSidecar SHA-256: gate-a-intake/reference-bundle-snapshot.json ${sha256(readFileSync(snapshotPath))}`;
    spec.source_intake = '../gate-a-intake/intake.json';
    spec.evidence.push({
      source_id: 'LOCAL-1',
      title: 'Approved reference prototype',
      url: snapshot.references[0].path,
      used_for: 'Supported the Gate B screen-composition decision.',
    });
    const usage = {
      schema_version: 'p2a.reference_bundle_usage.v1',
      source_snapshot_ref: '../gate-a-intake/reference-bundle-snapshot.json',
      source_snapshot_sha256: sha256(readFileSync(snapshotPath)),
      source_bundle_ref: snapshot.source_bundle_ref,
      source_bundle_sha256: bundleSha,
      inspected_references: [
        {
          id: 'REF-1',
          sha256: referenceSha,
          evidence_source_id: 'LOCAL-1',
          supported_decision: 'spec.product.screens_or_interfaces',
        },
      ],
    };
    writeJson(usagePath, usage);
    spec.approval_audit.approved_artifacts.push('gate-b-spec/reference-bundle-usage.json');
    spec.approval_audit.approval_note += `\nSidecar SHA-256: gate-b-spec/reference-bundle-usage.json ${sha256(readFileSync(usagePath))}`;
    writeJson(intakePath, intake);
    writeJson(specPath, spec);

    assert.doesNotThrow(() => validateIntake(intakePath, { artifactRoot: root }));
    assert.doesNotThrow(() => validateSpec(specPath, intakePath, { artifactRoot: root }));

    usage.inspected_references = [];
    writeJson(usagePath, usage);
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /cites captured reference REF-1 but is not mapped exactly once/,
    );

    usage.inspected_references = [{
      id: 'REF-1',
      sha256: referenceSha,
      evidence_source_id: 'LOCAL-1',
      supported_decision: 'spec.product.missing_decision_field',
    }];
    writeJson(usagePath, usage);
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /supported_decision must resolve to an existing spec/,
    );

    usage.inspected_references[0].supported_decision = 'spec.product.screens_or_interfaces';
    writeJson(usagePath, usage);
    assert.doesNotThrow(() => validateSpec(specPath, intakePath, { artifactRoot: root }));

    rmSync(usagePath);
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /reference-bundle-usage\.json is required/,
    );

    usage.inspected_references[0].sha256 = '0'.repeat(64);
    writeJson(usagePath, usage);
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /does not match the approved Gate A reference hash/,
    );

    usage.inspected_references[0].sha256 = referenceSha;
    writeJson(usagePath, usage);
    writeFileSync(capturedReferencePath, '<!doctype html><title>Changed reference</title>\n', 'utf8');
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /sha256 does not match the captured reference file|sha256 does not match/,
    );
    writeFileSync(capturedReferencePath, prototype, 'utf8');
    assert.doesNotThrow(() => validateSpec(specPath, intakePath, { artifactRoot: root }));

    rmSync(snapshotPath);
    rmSync(usagePath);
    assert.throws(
      () => validateSpec(specPath, intakePath, { artifactRoot: root }),
      /reference-bundle-snapshot\.json is required by intake\.approval_audit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate A reference snapshot rejects fabricated hashes without captured source bytes', () => {
  const root = makeTempDir('p2a-reference-fabricated-snapshot-');
  try {
    const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
    const snapshotPath = path.join(root, 'gate-a-intake', 'reference-bundle-snapshot.json');
    const intake = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'),
      'utf8',
    ));
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
    writeJson(intakePath, intake);
    writeJson(snapshotPath, {
      schema_version: 'p2a.reference_bundle_snapshot.v1',
      source_bundle_ref: 'reference-sources/files/p2a-reference-bundle.json',
      source_bundle_sha256: 'a'.repeat(64),
      entry_ref: 'reference-sources/files/idea.md',
      entry_sha256: 'b'.repeat(64),
      references: [{
        id: 'REF-1',
        path: 'reference-sources/files/prototype.html',
        kind: 'html',
        sha256: 'c'.repeat(64),
        load_when: 'Gate B needs the screen composition.',
        description: 'Fabricated prototype metadata.',
      }],
    });
    assert.throws(
      () => validateIntake(intakePath, { artifactRoot: root }),
      /reference source capture is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gate A reference snapshot rejects a capture root symlinked outside the artifact', () => {
  const root = makeTempDir('p2a-reference-symlink-capture-');
  const externalRoot = makeTempDir('p2a-reference-external-capture-');
  try {
    const intakePath = path.join(root, 'gate-a-intake', 'intake.json');
    const snapshotPath = path.join(root, 'gate-a-intake', 'reference-bundle-snapshot.json');
    const externalFiles = path.join(externalRoot, 'files');
    const entryPath = path.join(externalFiles, 'idea.md');
    const referencePath = path.join(externalFiles, 'prototype.html');
    const bundlePath = path.join(externalFiles, 'p2a-reference-bundle.json');
    const intake = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'),
      'utf8',
    ));
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
    writeJson(intakePath, intake);
    mkdirSync(externalFiles, { recursive: true });
    writeFileSync(entryPath, 'Build a portable workflow from captured references.\n', 'utf8');
    writeFileSync(referencePath, '<!doctype html><title>External capture</title>\n', 'utf8');
    writeJson(bundlePath, {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [{
        id: 'REF-1',
        path: 'prototype.html',
        kind: 'html',
        sha256: sha256(readFileSync(referencePath)),
        load_when: 'Gate B needs the approved prototype.',
        description: 'Prototype outside the artifact root.',
      }],
    });
    symlinkSync(externalRoot, path.join(root, 'gate-a-intake', 'reference-sources'));
    writeJson(snapshotPath, {
      schema_version: 'p2a.reference_bundle_snapshot.v1',
      source_bundle_ref: 'reference-sources/files/p2a-reference-bundle.json',
      source_bundle_sha256: sha256(readFileSync(bundlePath)),
      entry_ref: 'reference-sources/files/idea.md',
      entry_sha256: sha256(readFileSync(entryPath)),
      references: [{
        id: 'REF-1',
        path: 'reference-sources/files/prototype.html',
        kind: 'html',
        sha256: sha256(readFileSync(referencePath)),
        load_when: 'Gate B needs the approved prototype.',
        description: 'Prototype outside the artifact root.',
      }],
    });

    assert.throws(
      () => validateIntake(intakePath, { artifactRoot: root }),
      /capture root must be a real directory|must stay inside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('entry reference bundle rejects stale hashes and paths outside its project root', () => {
  const root = makeTempDir('p2a-entry-reference-invalid-');
  const outsideRoot = makeTempDir('p2a-entry-reference-outside-');
  try {
    const entryPath = path.join(root, 'idea.md');
    const evidencePath = path.join(root, 'evidence.json');
    const outsidePath = path.join(outsideRoot, 'private.txt');
    writeFileSync(entryPath, '해시가 바뀐 참고 자료를 진입 검증에서 차단하는 기능을 구현한다.\n', 'utf8');
    writeFileSync(evidencePath, '{}\n', 'utf8');
    writeFileSync(outsidePath, 'outside\n', 'utf8');
    writeJson(path.join(root, 'p2a-reference-bundle.json'), {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [
        {
          id: 'REF-1',
          path: 'evidence.json',
          kind: 'data',
          sha256: '0'.repeat(64),
          load_when: 'Gate B needs sample data.',
          description: 'Stale sample data.',
        },
        {
          id: 'REF-2',
          path: path.relative(root, outsidePath),
          kind: 'document',
          sha256: sha256('outside\n'),
          load_when: 'Never, because this escapes the project root.',
          description: 'Out-of-root reference.',
        },
      ],
    });

    const inspected = inspectEntryDocument(entryPath);
    assert.equal(inspected.valid, false);
    assert.ok(inspected.errors.some((error) => error.includes('sha256 does not match')));
    assert.ok(inspected.errors.some((error) => error.includes('escapes the project reference root')));

    const validation = runP2a(['validate', '--entry', entryPath]);
    assert.notEqual(validation.status, 0);
    assert.match(`${validation.stdout}${validation.stderr}`, /sha256 does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('entry reference bundle rejects a directory symlink that resolves outside the project root', () => {
  const root = makeTempDir('p2a-entry-reference-symlink-');
  const outsideRoot = makeTempDir('p2a-entry-reference-symlink-outside-');
  try {
    const entryPath = path.join(root, 'idea.md');
    const outsidePath = path.join(outsideRoot, 'evidence.txt');
    writeFileSync(entryPath, '프로젝트 밖 symlink 참고 자료를 차단하는 진입 계약을 구현한다.\n', 'utf8');
    writeFileSync(outsidePath, 'outside through directory link\n', 'utf8');
    symlinkSync(outsideRoot, path.join(root, 'linked-evidence'), process.platform === 'win32' ? 'junction' : 'dir');
    writeJson(path.join(root, 'p2a-reference-bundle.json'), {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [
        {
          id: 'REF-1',
          path: 'linked-evidence/evidence.txt',
          kind: 'document',
          sha256: sha256('outside through directory link\n'),
          load_when: 'Gate B needs external evidence.',
          description: 'Reference reached through an escaping directory symlink.',
        },
      ],
    });

    const inspected = inspectEntryDocument(entryPath);
    assert.equal(inspected.valid, false);
    assert.ok(inspected.errors.some((error) => error.includes('through a symbolic link')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('Gate A snapshot preserves a reference path through an internal directory symlink', () => {
  const root = makeTempDir('p2a-entry-reference-internal-symlink-');
  try {
    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'cache-library');
    const intakePath = path.join(artifactRoot, 'gate-a-intake', 'intake.json');
    const entryPath = path.join(root, 'idea.md');
    const assetsRoot = path.join(root, 'assets');
    const prototypePath = path.join(assetsRoot, 'prototype.html');
    const prototype = '<!doctype html><title>Internal linked evidence</title>\n';
    const intake = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'),
      'utf8',
    ));
    intake.status = 'blocked_on_user';
    delete intake.approval_audit;
    writeJson(intakePath, intake);
    writeFileSync(entryPath, '프로젝트 내부 링크의 참고 자료를 승인 증거로 보존한다.\n', 'utf8');
    mkdirSync(assetsRoot, { recursive: true });
    writeFileSync(prototypePath, prototype, 'utf8');
    symlinkSync(assetsRoot, path.join(root, 'linked-assets'), process.platform === 'win32' ? 'junction' : 'dir');
    writeJson(path.join(root, 'p2a-reference-bundle.json'), {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'idea.md',
      references: [{
        id: 'REF-1',
        path: 'linked-assets/prototype.html',
        kind: 'html',
        sha256: sha256(prototype),
        load_when: 'Gate B needs the internal prototype.',
        description: 'Project-confined prototype reached through a directory symlink.',
      }],
    });

    const capture = runP2a([
      'reference', 'snapshot',
      '--target', root,
      '--entry', 'idea.md',
      '--artifacts', artifactRoot,
      '--json',
    ]);
    assert.equal(capture.status, 0, `${capture.stdout}${capture.stderr}`);
    const snapshotPath = path.join(
      artifactRoot,
      'gate-a-intake',
      'reference-bundle-snapshot.json',
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assert.equal(
      snapshot.references[0].path,
      'reference-sources/files/linked-assets/prototype.html',
    );
    assert.equal(existsSync(path.join(
      artifactRoot,
      'gate-a-intake',
      snapshot.references[0].path,
    )), true);
    assert.doesNotThrow(() => validateIntake(intakePath, { artifactRoot }));

    const approval = runP2a([
      'decide', '--target', root, '--artifacts', artifactRoot,
      '--entry', 'idea.md', '--quote', '내부 링크 참고 자료를 포함해 승인해',
    ]);
    assert.equal(approval.status, 0, `${approval.stdout}${approval.stderr}`);
    assert.doesNotThrow(() => validateIntake(intakePath, { artifactRoot }));
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

test('a fresh harness without an entry offers idea text or a document path', () => {
  const root = project();
  try {
    const next = runNext(root);
    assert.equal(next.state, 'entry_missing');
    assert.equal(next.command.kind, 'approval');
    assert.match(next.command.display, /p2a next --idea "<what to build>"/);
    assert.match(next.command.display, /p2a next --entry <path>/);

    const invalid = runNext(root, ['--entry', 'missing.md']);
    assert.equal(invalid.state, 'entry_invalid');
    assert.equal(invalid.command.kind, 'approval');
    assert.match(invalid.command.display, /validate --entry .*missing\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('next materializes a conversational idea as a stable provisional entry snapshot', () => {
  const root = project();
  try {
    const idea = '초보자가 릴리스 상태를 한눈에 확인하고 다음 작업을 선택할 수 있는 화면을 만든다.';
    const first = runNext(root, ['--contract', 'v2', '--idea', idea]);
    assert.equal(first.state, 'gate_what');
    assert.equal(first.command.kind, 'skill');
    const entryPath = first.command.args[1];
    assert.match(posix(entryPath), /\.plan2agent\/entries\/idea-[a-f0-9]{12}\.md$/);
    assert.equal(readFileSync(entryPath, 'utf8'), `${idea}\n`);

    const resumed = runNext(root, ['--contract', 'v2']);
    assert.equal(resumed.state, 'gate_what');
    assert.equal(resumed.command.kind, 'skill');
    assert.equal(resumed.command.args[1], entryPath);

    const second = runNext(root, ['--contract', 'v2', '--idea', idea]);
    assert.equal(second.state, 'gate_what');
    assert.equal(second.command.args[1], entryPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plain next resumes the provisional entry bound to persisted Gate A state', () => {
  const root = project();
  try {
    const idea = '초보자가 현재 배포 실패 원인을 확인할 수 있는 화면을 만든다.';
    const created = runNext(root, ['--contract', 'v2', '--idea', idea]);
    const entryPath = created.command.args[1];
    runNext(root, [
      '--contract', 'v2',
      '--idea', '이전 범위와 관련 없는 임시 아이디어를 남긴다.',
    ]);

    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'sample');
    const intake = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.blocked.json'),
      'utf8',
    ));
    intake.idea = idea;
    intake.summary = idea;
    writeJson(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), intake);

    const resumed = runNext(root, ['--contract', 'v2']);
    assert.equal(resumed.state, 'gate_what');
    assert.equal(resumed.command.kind, 'skill');
    assert.deepEqual(resumed.command.args, ['--entry', entryPath]);
    assert.match(resumed.command.display, new RegExp(entryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    assert.doesNotMatch(resumed.command.display, /<original-entry-path>/u);

    const approvalReady = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'),
      'utf8',
    ));
    approvalReady.idea = idea;
    approvalReady.summary = idea;
    writeJson(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), approvalReady);
    const revoked = runP2a([
      'decide',
      'revoke',
      '--artifacts',
      artifactRoot,
      '--quote',
      '범위를 한 번 더 확인하자',
    ]);
    assert.equal(revoked.status, 0, `${revoked.stdout}${revoked.stderr}`);

    const approval = runNext(root, ['--contract', 'v2']);
    assert.equal(approval.state, 'gate_a_needs_approval');
    assert.equal(approval.command.kind, 'approval');
    assert.deepEqual(approval.command.argv, [
      'decide',
      '--quote',
      '<user-utterance>',
      '--entry',
      entryPath,
      '--artifacts',
      path.join(root, '.plan2agent', 'artifacts', 'sample'),
    ]);
    assert.doesNotMatch(approval.command.display, /<original-entry-path>/u);

    rmSync(entryPath);
    writeJson(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), intake);
    const unrelatedOnly = runNext(root, ['--contract', 'v2']);
    assert.equal(unrelatedOnly.state, 'gate_what');
    assert.deepEqual(unrelatedOnly.command.args, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human next preserves the first idea summary and language before canonical intake exists', () => {
  const root = project();
  try {
    const englishIdea = 'Change the login error message to plain English.';
    const english = runP2a(['next', '--target', root, '--idea', englishIdea]);
    assert.equal(english.status, 0, `${english.stdout}${english.stderr}`);
    assert.match(english.stdout, /^Plan2Agent\n\n\[At a glance\]/u);
    assert.match(
      english.stdout,
      /Understood request: Change the login error message to plain English\./u,
    );
    assert.doesNotMatch(english.stdout, /[가-힣]/u);

    const koreanIdea = '로그인 API 오류 메시지를 한국어로 바꿔줘.';
    const korean = runP2a(['next', '--target', root, '--idea', koreanIdea]);
    assert.equal(korean.status, 0, `${korean.stdout}${korean.stderr}`);
    assert.match(korean.stdout, /^Plan2Agent\n\n\[한눈에\]/u);
    assert.match(korean.stdout, /이해한 요청: 로그인 API 오류 메시지를 한국어로 바꿔줘\./u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('next refuses a provisional entry directory that redirects outside the project', () => {
  const root = project();
  const outside = makeTempDir('p2a-entry-outside-');
  try {
    symlinkSync(outside, path.join(root, '.plan2agent', 'entries'), 'dir');
    const result = runP2a([
      'next',
      '--target', root,
      '--json',
      '--idea', 'Keep this idea inside the initialized project.',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provisional entry directory must be a real directory/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
    const sharedEvidencePath = path.join(root, 'shared-evidence.json');
    const sharedEvidence = '{"source":"project-root"}\n';
    writeFileSync(sharedEvidencePath, sharedEvidence, 'utf8');
    writeJson(path.join(latestRoot, 'p2a-reference-bundle.json'), {
      schema_version: 'p2a.reference_bundle.v1',
      entry: 'collection-report.md',
      references: [
        {
          id: 'REF-1',
          path: path.relative(latestRoot, sharedEvidencePath),
          kind: 'data',
          sha256: sha256(sharedEvidence),
          load_when: 'Gate B needs project-root sample data.',
          description: 'Shared project evidence outside the Radar sequence directory.',
        },
      ],
    });

    let next = runNext(root);
    assert.equal(next.state, 'gate_what');
    assert.match(posix(next.command.display), /002-followup\/collection-report\.md/);

    const info = runP2a(['info', '--target', root, '--json']);
    assert.equal(info.status, 0, `${info.stdout}${info.stderr}`);
    const infoPayload = JSON.parse(info.stdout);
    assert.equal(infoPayload.entry.valid, true);
    assert.match(posix(infoPayload.entry.path), /002-followup\/collection-report\.md$/);
    assert.equal(infoPayload.entry.referenceBundle.referenceCount, 1);

    const doctor = runP2a(['doctor', '--target', root, '--json']);
    assert.notEqual(doctor.status, null, `${doctor.stdout}${doctor.stderr}`);
    const doctorPayload = JSON.parse(doctor.stdout);
    assert.equal(doctorPayload.projectState.state, 'planning_in_progress');
    assert.match(
      posix(doctorPayload.projectState.commands[0].command),
      /p2a validate --entry .*002-followup\/collection-report\.md/,
    );

    rmSync(path.join(latestRoot, 'p2a-reference-bundle.json'));
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

test('canonical work stays authoritative while an explicit competing entry is deferred', () => {
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

    const canonical = runNext(root);
    assert.equal(canonical.state, 'gate_c_validated_needs_iteration_init');
    assert.equal(canonical.command.kind, 'cli');

    const deferred = runNext(root, ['--contract', 'v2', '--entry', 'direct-entry.md']);
    assert.equal(deferred.state, 'entry_deferred');
    assert.equal(deferred.command.kind, 'approval');
    assert.match(deferred.reason, /will not be started or replaced implicitly/u);
    assert.doesNotMatch(deferred.command.display, /execute start/u);

    const deferredIdea = runNext(root, [
      '--contract', 'v2',
      '--idea', 'Add a separate operator replay dashboard.',
    ]);
    assert.equal(deferredIdea.state, 'entry_deferred');
    assert.equal(deferredIdea.command.kind, 'approval');
    assert.doesNotMatch(JSON.stringify(deferredIdea.command), /execute start/u);

    const invalid = runNext(root, ['--contract', 'v2', '--entry', 'missing-entry.md']);
    assert.equal(invalid.state, 'entry_invalid');
    assert.equal(invalid.command.kind, 'approval');

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

test('a confirmed entry proceeds through Gate A-C execution and opens a baseline-backed next iteration', () => {
  const root = project();
  try {
    writeJson(path.join(root, '.plan2agent', 'project.config.json'), {
      devExecution: { reviewPasses: { acceptance: 'off' } },
    });
    const entryPath = path.join(root, 'idea.md');
    const fixtureArtifactRoot = path.join(FIXTURE_ROOT, '_e2e', 'webhook-api-service');
    const fixtureIntake = JSON.parse(readFileSync(
      path.join(fixtureArtifactRoot, 'gate-a-intake', 'intake.json'),
      'utf8',
    ));
    writeFileSync(entryPath, `${fixtureIntake.idea}\n`, 'utf8');

    const entryValidation = runP2a(['validate', '--entry', entryPath]);
    assert.equal(entryValidation.status, 0, `${entryValidation.stdout}${entryValidation.stderr}`);
    assert.equal(runNext(root, ['--entry', 'idea.md']).state, 'gate_what');

    const artifactRoot = path.join(root, '.plan2agent', 'artifacts', 'webhook-api-service');
    fixtureIntake.evidence[0].url = 'idea.md';
    fixtureIntake.approval_audit.approval_note = 'Confirmed the scope interpretation derived from idea.md.';
    writeJson(path.join(artifactRoot, 'gate-a-intake', 'intake.json'), fixtureIntake);
    assert.equal(runNext(root, ['--entry', 'idea.md']).state, 'gate_a_ready_for_spec');
    writeJson(path.join(root, '.plan2agent', 'constitution.json'), {
      schema_version: 'p2a.constitution.v1',
      projectId: 'webhook-api-service',
      architecture: [],
      stack: [],
      prohibitions: [],
      style: {},
      approval_audit: {
        approved_by: 'user',
        approved_at: '2026-08-04',
        approved_artifacts: ['.plan2agent/constitution.json'],
        approval_note: 'User quote: "이 구조로 진행해"',
      },
    });
    assert.equal(runNext(root, ['--entry', 'idea.md']).state, 'gate_a_ready_for_spec');

    const fixtureSpec = JSON.parse(readFileSync(
      path.join(fixtureArtifactRoot, 'gate-b-spec', 'spec.json'),
      'utf8',
    ));
    writeJson(path.join(artifactRoot, 'gate-b-spec', 'spec.json'), fixtureSpec);
    assert.equal(runNext(root, ['--entry', 'idea.md']).state, 'gate_b_approved_needs_tasks');

    const fixtureGraph = JSON.parse(readFileSync(
      path.join(fixtureArtifactRoot, 'gate-c-task-graph', 'task-graph.json'),
      'utf8',
    ));
    fixtureGraph.tasks = [fixtureGraph.tasks[0]];
    writeJson(path.join(artifactRoot, 'gate-c-task-graph', 'task-graph.json'), fixtureGraph);
    writeFileSync(
      path.join(artifactRoot, 'status.md'),
      '# Webhook API Service\n\nGate A-C artifacts are validated and ready for iteration init.\n',
      'utf8',
    );

    let next = runNext(root, ['--entry', 'idea.md']);
    assert.equal(next.state, 'gate_c_validated_needs_iteration_init');
    let result = runP2a(next.command.argv);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    next = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(next.state, 'ready_task_available');

    const runId = 'run-entry-contract-e2e';
    result = runP2a([
      'execute', 'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
      '--workspace', root,
      '--workspace-ref', 'entry-contract-e2e',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runP2a([
      'execute', 'finish',
      '--artifacts', artifactRoot,
      '--run-id', runId,
      '--status', 'finished',
      '--test-command', `"${process.execPath}" -e "process.exit(0)"`,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    next = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(next.state, 'final_verification_required');
    const finalRunId = 'run-entry-contract-final-verification';
    result = runP2a([
      'execute', 'verify-final',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', finalRunId,
      '--agent-tool', 'manual',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runP2a([
      'runs', 'verify',
      '--artifacts', artifactRoot,
      '--run-id', finalRunId,
      '--test-command', `"${process.execPath}" -e "process.exit(0)"`,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    result = runP2a([
      'execute', 'finish',
      '--artifacts', artifactRoot,
      '--run-id', finalRunId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runP2a([
      'iteration', 'validate',
      '--artifacts', artifactRoot,
      '--require-close-ready',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /close-ready: all tasks done/);

    next = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(next.state, 'iteration_review_or_close_required');
    assert.equal(next.command.kind, 'approval');
    assert.deepEqual(next.command.options.map((option) => option.id), ['review', 'retrospective', 'close']);
    const reviewOption = next.command.options[0];
    assert.equal(reviewOption.action.kind, 'review');

    const cleanReviewDecision = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(cleanReviewDecision.state, 'iteration_review_or_close_required');
    assert.equal(cleanReviewDecision.command.kind, 'approval');

    const remediationArgv = reviewOption.action.remediation.argv.map((arg) => {
      if (arg === '<task-id>') return 'task-001';
      if (arg === '<review finding>') return 'Code review found a scoped remediation for task-001.';
      return arg;
    });
    result = runP2a(remediationArgv);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    next = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(next.state, 'ready_task_available');
    const remediationRunId = 'run-entry-contract-review-remediation';
    result = runP2a([
      'execute', 'start',
      '--artifacts', artifactRoot,
      '--task', 'task-001',
      '--run-id', remediationRunId,
      '--agent-tool', 'codex',
      '--workspace', root,
      '--workspace-ref', 'entry-contract-review-remediation',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    result = runP2a([
      'execute', 'finish',
      '--artifacts', artifactRoot,
      '--run-id', remediationRunId,
      '--status', 'finished',
      '--test-command', `"${process.execPath}" -e "process.exit(0)"`,
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    next = runNext(root, ['--entry', 'idea.md', '--contract', 'v2']);
    assert.equal(next.state, 'iteration_review_or_close_required');
    const closeOption = next.command.options.find((option) => option.id === 'close');
    assert.equal(closeOption.action.requiresApproval, true);
    result = runP2a(closeOption.action.argv);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /iteration closed/);

    const iteration = JSON.parse(readFileSync(
      path.join(artifactRoot, 'iterations', 'v1-mvp', 'iteration.json'),
      'utf8',
    ));
    assert.equal(iteration.status, 'archived');

    result = runP2a([
      'iteration', 'open',
      '--artifacts', artifactRoot,
      '--iteration-id', 'v2-entry-contract',
      '--idea', 'Add the next baseline-backed capability from the entry document',
    ]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    const currentSpec = JSON.parse(readFileSync(
      path.join(artifactRoot, 'current-spec.json'),
      'utf8',
    ));
    assert.equal(currentSpec.active_iteration, 'v2-entry-contract');
    assert.equal(currentSpec.pending_iteration?.iteration_id, 'v2-entry-contract');
    assert.equal(currentSpec.pending_iteration?.status, 'active_planning');
    assert.equal(currentSpec.pending_iteration?.baseline_iteration, 'v1-mvp');

    next = runNext(root, ['--contract', 'v2', '--entry', 'idea.md']);
    assert.equal(next.state, 'gate_what');
    assert.equal(next.command.kind, 'skill');
    assert.equal(next.command.skill, 'p2a-harness');
    assert.deepEqual(next.command.args, ['--entry', entryPath]);

    next = runNext(root, ['--contract', 'v2']);
    assert.equal(next.state, 'entry_missing');
    assert.equal(next.command.kind, 'approval');
    assert.match(next.command.display, /p2a next --entry <path>/);

    next = runNext(root, ['--contract', 'v2', '--entry', 'missing.md']);
    assert.equal(next.state, 'entry_invalid');
    assert.equal(next.command.kind, 'approval');
    assert.match(next.command.display, /validate --entry .*missing\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
