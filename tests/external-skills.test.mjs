import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  E2E_FIXTURE_ROOT,
  formatCommandResult,
  makeTempDir,
  runDoctor,
  runHandoff,
  runP2a,
  runP2aFrom,
} from './helpers/fixtures.mjs';

function scaffoldTarget(prefix = 'p2a-external-skills-') {
  const targetRoot = makeTempDir(prefix);
  writeFileSync(
    path.join(targetRoot, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node -p 1' } }, null, 2)}\n`,
    'utf8',
  );
  const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'codex,claude']);
  assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
  return targetRoot;
}

function writeSkillSource(targetRoot, name, body = '# Fixture skill\n', extra = {}) {
  const skillRoot = path.join(targetRoot, 'external-source', 'skills', name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} lifecycle fixture.\n---\n\n${body}`,
    'utf8',
  );
  for (const [relative, content] of Object.entries(extra)) {
    const destination = path.join(skillRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content, 'utf8');
  }
  return skillRoot;
}

function runSkills(targetRoot, args) {
  return runP2aFrom(targetRoot, ['skills', ...args, '--target', targetRoot]);
}

function applyReviewedSkills(targetRoot, args) {
  if (args.includes('--expect-plan')) return runSkills(targetRoot, args);
  const previewArgs = args.map((arg) => arg === '--apply' ? '--dry-run' : arg);
  if (!previewArgs.includes('--json')) previewArgs.push('--json');
  const preview = runSkills(targetRoot, previewArgs);
  if (preview.status !== 0) return preview;
  return runSkills(targetRoot, [...args, '--expect-plan', JSON.parse(preview.stdout).planDigest]);
}

function parseJsonResult(result) {
  assert.equal(result.status, 0, formatCommandResult(result));
  return JSON.parse(result.stdout);
}

test('external skills source, dry-run, apply, list, update, and core update preserve ownership', () => {
  const targetRoot = scaffoldTarget();
  try {
    const sourceSkill = writeSkillSource(targetRoot, 'fixture-skill', '# Fixture v1\n', {
      'references/example.md': 'fixture reference\n',
    });
    const temporaryRoot = path.join(targetRoot, '.plan2agent', 'tmp');
    const temporaryRootExisted = existsSync(temporaryRoot);
    const source = parseJsonResult(runSkills(targetRoot, [
      'source', './external-source', '--list', '--json',
    ]));
    assert.deepEqual(source.skills.map((skill) => skill.name), ['fixture-skill']);
    assert.equal(existsSync(temporaryRoot), temporaryRootExisted);

    const preview = parseJsonResult(runSkills(targetRoot, [
      'add', './external-source', '--skill', 'fixture-skill',
      '--tools', 'codex,claude,gemini', '--dry-run', '--json',
    ]));
    assert.equal(preview.applied, false);
    assert.equal(preview.changes[0].action, 'add');
    assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), false);
    assert.equal(existsSync(path.join(targetRoot, '.agents', 'skills', 'fixture-skill')), false);

    const changedAfterReview = path.join(sourceSkill, 'references', 'changed-after-review.md');
    writeFileSync(changedAfterReview, 'changed after review\n', 'utf8');
    const staleApply = applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'fixture-skill',
      '--tools', 'codex,claude,gemini', '--apply', '--expect-plan', preview.planDigest,
    ]);
    assert.notEqual(staleApply.status, 0);
    assert.match(staleApply.stderr, /source\/content changed after review/);
    assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), false);
    rmSync(changedAfterReview);

    const applied = parseJsonResult(applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'fixture-skill',
      '--tools', 'codex,claude,gemini', '--apply', '--json',
    ]));
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.changes[0].installedPaths, [
      '.agents/skills/fixture-skill',
      '.claude/skills/fixture-skill',
    ]);
    assert.equal(existsSync(path.join(targetRoot, '.agents', 'skills', 'fixture-skill', 'SKILL.md')), true);
    assert.equal(existsSync(path.join(targetRoot, '.claude', 'skills', 'fixture-skill', 'SKILL.md')), true);

    const lock = JSON.parse(readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8'));
    assert.equal(lock.schema_version, 'p2a.external-skills-lock.v1');
    assert.equal(lock.upstream.package, 'skills');
    assert.match(lock.skills['fixture-skill'].contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(lock.skills['fixture-skill'].source.spec, './external-source');
    assert.equal(lock.skills['fixture-skill'].source.resolvedCommit, null);

    let manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.externalSkills.map((skill) => skill.name), ['fixture-skill']);
    assert.ok(manifest.externalSkillFiles.includes('.agents/skills/fixture-skill/SKILL.md'));
    assert.ok(manifest.managedFiles.some((record) => record.owner === 'external-skill:fixture-skill'));

    const listed = parseJsonResult(runSkills(targetRoot, ['list', '--json']));
    assert.equal(listed.skills[0].status, 'installed');

    const doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(doctor.status, 0, formatCommandResult(doctor));
    const externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.equal(externalCheck.status, 'pass');

    const coreUpdate = runP2aFrom(targetRoot, ['update', '--target', targetRoot, '--apply']);
    assert.equal(coreUpdate.status, 0, formatCommandResult(coreUpdate));
    manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.externalSkills.map((skill) => skill.name), ['fixture-skill']);
    assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), true);

    writeFileSync(
      path.join(sourceSkill, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: fixture-skill lifecycle fixture.\n---\n\n# Fixture v2\n',
      'utf8',
    );
    const updatePreview = parseJsonResult(runSkills(targetRoot, ['update', 'fixture-skill', '--dry-run', '--json']));
    assert.equal(updatePreview.changes[0].action, 'update');
    const updateApply = parseJsonResult(applyReviewedSkills(targetRoot, ['update', 'fixture-skill', '--apply', '--json']));
    assert.equal(updateApply.applied, true);
    assert.match(
      readFileSync(path.join(targetRoot, '.agents', 'skills', 'fixture-skill', 'SKILL.md'), 'utf8'),
      /Fixture v2/,
    );
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('external skill drift blocks update, remove, and sync while missing copies can be restored', () => {
  const targetRoot = scaffoldTarget();
  try {
    writeSkillSource(targetRoot, 'repair-skill');
    parseJsonResult(applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'repair-skill', '--apply', '--json',
    ]));
    const installedSkill = path.join(targetRoot, '.agents', 'skills', 'repair-skill', 'SKILL.md');
    const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
    const lockPath = path.join(targetRoot, 'p2a-skills.lock.json');
    const originalManifestText = readFileSync(manifestPath, 'utf8');
    const originalLockText = readFileSync(lockPath, 'utf8');
    const manifestWithoutExternal = JSON.parse(originalManifestText);
    manifestWithoutExternal.externalSkills = [];
    manifestWithoutExternal.externalSkillFiles = [];
    manifestWithoutExternal.managedFiles = manifestWithoutExternal.managedFiles
      .filter((record) => record.owner !== 'external-skill:repair-skill');
    writeFileSync(manifestPath, `${JSON.stringify(manifestWithoutExternal, null, 2)}\n`, 'utf8');
    let doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(doctor.status, 1, formatCommandResult(doctor));
    let externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'manifest_inventory_mismatch'));
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'manifest_ownership_mismatch'));
    writeFileSync(manifestPath, originalManifestText, 'utf8');

    rmSync(lockPath);
    doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(doctor.status, 1, formatCommandResult(doctor));
    externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'missing_lock'));
    writeFileSync(lockPath, originalLockText, 'utf8');

    rmSync(path.dirname(installedSkill), { recursive: true, force: true });
    doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'missing'));
    parseJsonResult(applyReviewedSkills(targetRoot, ['sync', '--apply', '--json']));

    writeFileSync(path.join(path.dirname(installedSkill), 'extra.txt'), 'extra\n', 'utf8');
    doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'extra_file'));
    const extraSync = applyReviewedSkills(targetRoot, ['sync', '--apply', '--json']);
    assert.notEqual(extraSync.status, 0);
    assert.equal(readFileSync(path.join(path.dirname(installedSkill), 'extra.txt'), 'utf8'), 'extra\n');
    rmSync(path.join(path.dirname(installedSkill), 'extra.txt'));

    const installedBeforeEdit = readFileSync(installedSkill, 'utf8');
    writeFileSync(installedSkill, `${readFileSync(installedSkill, 'utf8')}\nlocal drift\n`, 'utf8');

    const update = applyReviewedSkills(targetRoot, ['update', 'repair-skill', '--apply']);
    assert.notEqual(update.status, 0);
    assert.match(update.stderr, /drift blocks update/);
    const remove = applyReviewedSkills(targetRoot, ['remove', 'repair-skill', '--apply']);
    assert.notEqual(remove.status, 0);
    assert.match(remove.stderr, /drift blocks removal/);

    doctor = runDoctor(['--target', targetRoot, '--dev', '--json']);
    assert.equal(doctor.status, 1, formatCommandResult(doctor));
    externalCheck = JSON.parse(doctor.stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.equal(externalCheck.status, 'fail');
    assert.ok(externalCheck.issues.some((issue) => issue.kind === 'hash_mismatch'));

    const syncPreview = parseJsonResult(runSkills(targetRoot, ['sync', '--dry-run', '--json']));
    assert.equal(syncPreview.changes[0].action, 'restore');
    assert.ok(syncPreview.blockers.some((issue) => issue.kind === 'file_hash_mismatch'));
    assert.notEqual(applyReviewedSkills(targetRoot, ['sync', '--apply', '--json']).status, 0);
    assert.match(readFileSync(installedSkill, 'utf8'), /local drift/);
    writeFileSync(installedSkill, installedBeforeEdit);

    const removed = parseJsonResult(applyReviewedSkills(targetRoot, ['remove', 'repair-skill', '--apply', '--json']));
    assert.equal(removed.applied, true);
    assert.equal(existsSync(path.dirname(installedSkill)), false);
    const lock = JSON.parse(readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8'));
    assert.deepEqual(lock.skills, {});
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('external skill install rejects P2A-owned collisions and non-portable paths', () => {
  const targetRoot = scaffoldTarget();
  try {
    writeSkillSource(targetRoot, 'p2a-harness');
    const collision = runSkills(targetRoot, [
      'add', './external-source', '--skill', 'p2a-harness', '--dry-run',
    ]);
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /collides with ai-tool:/);

    rmSync(path.join(targetRoot, 'external-source'), { recursive: true, force: true });
    writeSkillSource(targetRoot, 'unsafe-skill', '# Unsafe\n', { CON: 'reserved\n' });
    const unsafe = runSkills(targetRoot, [
      'add', './external-source', '--skill', 'unsafe-skill', '--dry-run',
    ]);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /reserved Windows name/);
    assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), false);

    rmSync(path.join(targetRoot, 'external-source'), { recursive: true, force: true });
    writeSkillSource(targetRoot, 'case-skill');
    mkdirSync(path.join(targetRoot, '.agents', 'skills', 'Case-Skill'), { recursive: true });
    const caseCollision = runSkills(targetRoot, [
      'add', './external-source', '--skill', 'case-skill', '--dry-run',
    ]);
    assert.notEqual(caseCollision.status, 0);
    assert.match(caseCollision.stderr, /case-insensitive collision/);

    const credentials = runSkills(targetRoot, [
      'source', 'https://private-user:secret-token@example.invalid/repo.git', '--list',
    ]);
    assert.notEqual(credentials.status, 0);
    assert.match(credentials.stderr, /must not contain userinfo or credentials/);
    assert.doesNotMatch(formatCommandResult(credentials), /private-user|secret-token/);

    if (process.platform !== 'win32') {
      rmSync(path.join(targetRoot, 'external-source'), { recursive: true, force: true });
      const symlinkSkill = writeSkillSource(targetRoot, 'symlink-skill');
      const outside = path.join(targetRoot, 'outside-skill-file.txt');
      writeFileSync(outside, 'outside\n', 'utf8');
      symlinkSync(outside, path.join(symlinkSkill, 'linked.txt'));
      const symlinked = runSkills(targetRoot, [
        'add', './external-source', '--skill', 'symlink-skill', '--dry-run',
      ]);
      assert.notEqual(symlinked.status, 0);
      assert.match(formatCommandResult(symlinked), /symbolic link|regular files|unsafe/i);
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('interrupted transactions remain untouched by reads and require reviewed recovery', () => {
  const targetRoot = scaffoldTarget();
  try {
    writeSkillSource(targetRoot, 'recovery-skill');
    parseJsonResult(applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'recovery-skill', '--apply', '--json',
    ]));
    const installed = path.join(targetRoot, '.agents', 'skills', 'recovery-skill');
    const backup = path.join(path.dirname(installed), '.recovery-skill.p2a-backup-test');
    const temporary = path.join(path.dirname(installed), '.recovery-skill.p2a-next-test');
    renameSync(installed, backup);
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, 'SKILL.md'), 'partial transaction\n', 'utf8');
    const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
    const lockPath = path.join(targetRoot, 'p2a-skills.lock.json');
    const journalPath = path.join(targetRoot, '.plan2agent', 'tmp', 'external-skills-transaction.json');
    mkdirSync(path.dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, `${JSON.stringify({
      schema_version: 'p2a.external-skills-transaction.v1',
      id: 'test-interruption',
      phase: 'applying',
      targetRoot,
      manifestPath,
      lockPath,
      manifestBefore: { exists: true, base64: readFileSync(manifestPath).toString('base64') },
      lockBefore: { exists: true, base64: readFileSync(lockPath).toString('base64') },
      replacements: [{
        installedPath: '.agents/skills/recovery-skill',
        destination: installed,
        temporary,
        backup,
        originalExists: true,
        remove: false,
      }],
    }, null, 2)}\n`, 'utf8');

    const listed = parseJsonResult(runSkills(targetRoot, ['list', '--json']));
    assert.equal(listed.skills[0].status, 'drifted');
    const readOnly = runSkills(targetRoot, ['remove', 'recovery-skill', '--dry-run']);
    assert.notEqual(readOnly.status, 0);
    assert.equal(readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), 'partial transaction\n');
    assert.equal(existsSync(journalPath), true);
    assert.equal(existsSync(backup), true);
    const recoveryPreview = parseJsonResult(runSkills(targetRoot, ['recover', '--dry-run', '--json']));
    const journalBefore = readFileSync(journalPath, 'utf8');
    for (const changedFile of [
      path.join(installed, 'user-notes.md'),
      path.join(backup, 'SKILL.md'),
      manifestPath,
      lockPath,
    ]) {
      const original = existsSync(changedFile) ? readFileSync(changedFile) : null;
      const changed = original ? Buffer.concat([original, Buffer.from('\n ')]) : Buffer.from('new user notes\n');
      writeFileSync(changedFile, changed);
      const staleRecovery = runSkills(targetRoot, [
        'recover', '--apply', '--expect-plan', recoveryPreview.planDigest, '--json',
      ]);
      assert.notEqual(staleRecovery.status, 0, changedFile);
      assert.match(staleRecovery.stderr, /changed after review/);
      assert.deepEqual(readFileSync(changedFile), changed);
      assert.equal(readFileSync(journalPath, 'utf8'), journalBefore);
      assert.equal(existsSync(backup), true);
      if (original) writeFileSync(changedFile, original);
      else rmSync(changedFile);
    }
    parseJsonResult(applyReviewedSkills(targetRoot, ['recover', '--apply', '--json']));
    assert.match(readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), /recovery-skill lifecycle fixture/);
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('apply requires the reviewed digest and returns the changed plan without writing', () => {
  const targetRoot = scaffoldTarget();
  try {
    const source = writeSkillSource(targetRoot, 'reviewed-skill', '# Version one\n');
    const args = ['add', './external-source', '--skill', 'reviewed-skill'];
    const preview = parseJsonResult(runSkills(targetRoot, [...args, '--dry-run', '--json']));
    writeFileSync(path.join(source, 'new.md'), 'unreviewed content\n');
    for (const extra of [[], ['--expect-plan', preview.planDigest]]) {
      const apply = runSkills(targetRoot, [...args, '--apply', '--json', ...extra]);
      assert.notEqual(apply.status, 0);
      const error = JSON.parse(apply.stderr);
      assert.equal(error.plan.applied, false);
      assert.notEqual(error.plan.planDigest, preview.planDigest);
      assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), false);
    }
    parseJsonResult(applyReviewedSkills(targetRoot, [...args, '--apply', '--json']));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('core update and upgrade cannot claim an external destination', () => {
  const targetRoot = makeTempDir('p2a-core-collision-');
  try {
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
    writeSkillSource(targetRoot, 'p2a-harness');
    parseJsonResult(applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'p2a-harness', '--tools', 'codex', '--apply', '--json',
    ]));
    const files = ['.agents/skills/p2a-harness/SKILL.md', '.plan2agent/manifest.json', 'p2a-skills.lock.json'];
    const reinitialize = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none', '--overwrite']);
    assert.equal(reinitialize.status, 0, formatCommandResult(reinitialize));
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, '.plan2agent/manifest.json')));
    assert.deepEqual(manifest.externalSkills.map((record) => record.name), ['p2a-harness']);
    assert.ok(manifest.managedFiles.some((record) => record.owner === 'external-skill:p2a-harness'));
    const before = files.map((file) => readFileSync(path.join(targetRoot, file), 'utf8'));
    for (const command of ['update', 'upgrade']) {
      const result = runHandoff([command, '--target', targetRoot, '--tools', 'codex', '--apply']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /collides with external skill ownership/);
      assert.deepEqual(files.map((file) => readFileSync(path.join(targetRoot, file), 'utf8')), before);
    }
    for (const mode of [[], ['--dry-run']]) {
      const result = runHandoff(['enhance', 'dev-skills', '--target', targetRoot, '--tools', 'codex', '--overwrite', ...mode]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /collides with external skill ownership/);
      assert.deepEqual(files.map((file) => readFileSync(path.join(targetRoot, file), 'utf8')), before);
      const handoff = runHandoff([
        '--project-id', 'webhook-api-service', '--artifacts', path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'),
        '--target', targetRoot, '--tools', 'codex', '--overwrite', ...mode,
      ]);
      assert.notEqual(handoff.status, 0);
      assert.match(handoff.stderr, /collides with external skill ownership/);
      assert.deepEqual(files.map((file) => readFileSync(path.join(targetRoot, file), 'utf8')), before);
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('handoff preserves existing external inventory and installed files', () => {
  const targetRoot = scaffoldTarget('p2a-external-handoff-');
  try {
    writeSkillSource(targetRoot, 'handoff-skill');
    parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', 'handoff-skill', '--apply', '--json']));
    const manifestPath = path.join(targetRoot, '.plan2agent/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    const lockBefore = readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'));
    const installedBefore = readFileSync(path.join(targetRoot, '.agents/skills/handoff-skill/SKILL.md'));
    const handoff = runHandoff([
      '--project-id', 'webhook-api-service', '--artifacts', path.join(E2E_FIXTURE_ROOT, 'webhook-api-service'),
      '--target', targetRoot, '--tools', 'codex', '--overwrite',
    ]);
    assert.equal(handoff.status, 0, formatCommandResult(handoff));
    const after = JSON.parse(readFileSync(manifestPath));
    for (const key of ['externalSkills', 'externalSkillFiles']) assert.deepEqual(after[key], manifest[key]);
    assert.deepEqual(after.managedFiles.filter((record) => record.owner.startsWith('external-skill:')),
      manifest.managedFiles.filter((record) => record.owner.startsWith('external-skill:')));
    assert.deepEqual(readFileSync(path.join(targetRoot, 'p2a-skills.lock.json')), lockBefore);
    assert.deepEqual(readFileSync(path.join(targetRoot, '.agents/skills/handoff-skill/SKILL.md')), installedBefore);
    assert.equal(parseJsonResult(runSkills(targetRoot, ['list', '--json'])).status, 'ok');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('external skill hashes and reviewed plans are independent of process locale', () => {
  const targetRoot = scaffoldTarget('p2a-external-locale-');
  try {
    writeSkillSource(targetRoot, 'locale-skill', '# Locale fixture\n', { 'zulu.md': 'z\n', 'äther.md': 'umlaut\n' });
    const run = (locale, args) => runP2a(['skills', ...args, '--target', targetRoot, '--json'], {
      cwd: targetRoot, env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    const add = ['add', './external-source', '--skill', 'locale-skill'];
    const english = parseJsonResult(run('en_US.UTF-8', [...add, '--dry-run']));
    const swedish = parseJsonResult(run('sv_SE.UTF-8', [...add, '--dry-run']));
    assert.equal(swedish.changes[0].toSha256, english.changes[0].toSha256);
    assert.equal(swedish.planDigest, english.planDigest);
    parseJsonResult(run('sv_SE.UTF-8', [...add, '--apply', '--expect-plan', english.planDigest]));
    const listed = parseJsonResult(run('en_US.UTF-8', ['list']));
    assert.equal(listed.status, 'ok');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('doctor detects orphan external ownership and duplicate owners', () => {
  const targetRoot = scaffoldTarget('p2a-external-doctor-');
  try {
    writeSkillSource(targetRoot, 'doctor-skill');
    parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', 'doctor-skill', '--apply', '--json']));
    const manifestPath = path.join(targetRoot, '.plan2agent/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    const lockPath = path.join(targetRoot, 'p2a-skills.lock.json');
    const lockBytes = readFileSync(lockPath);
    const orphan = structuredClone(manifest);
    delete orphan.externalSkills;
    delete orphan.externalSkillFiles;
    writeFileSync(manifestPath, JSON.stringify(orphan));
    rmSync(lockPath);
    const missing = JSON.parse(runDoctor(['--target', targetRoot, '--dev', '--json']).stdout).checks
      .find((check) => check.id === 'dev_external_skills_integrity');
    assert.equal(missing.status, 'fail');
    assert.ok(missing.issues.some((issue) => issue.kind === 'missing_lock'));
    writeFileSync(lockPath, lockBytes);
    const external = manifest.managedFiles.find((record) => record.owner === 'external-skill:doctor-skill');
    for (const duplicate of [external, { ...external, owner: 'ai-tool:common-skills' }]) {
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, managedFiles: [...manifest.managedFiles, duplicate] }));
      const check = JSON.parse(runDoctor(['--target', targetRoot, '--dev', '--json']).stdout).checks
        .find((entry) => entry.id === 'dev_external_skills_integrity');
      assert.equal(check.status, 'fail');
      assert.ok(check.issues.some((issue) => issue.kind === 'manifest_ownership_mismatch'));
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('remove validates ownership and clean-clone sync cannot overwrite unowned copies', () => {
  const targetRoot = scaffoldTarget();
  try {
    writeSkillSource(targetRoot, 'owner-skill');
    parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', 'owner-skill', '--apply', '--json']));
    const manifestPath = path.join(targetRoot, '.plan2agent/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath));
    manifest.managedFiles.find((record) => record.path === '.agents/skills/owner-skill/SKILL.md').owner = 'ai-tool:common-skills';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let result = runSkills(targetRoot, ['remove', 'owner-skill', '--apply', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /collides with ai-tool/);
    const installed = path.join(targetRoot, '.agents/skills/owner-skill');
    assert.equal(existsSync(path.join(installed, 'SKILL.md')), true);

    manifest.managedFiles = manifest.managedFiles.filter((record) => !record.path.includes('/owner-skill/'));
    manifest.externalSkills = [];
    manifest.externalSkillFiles = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    result = runSkills(targetRoot, ['sync', '--dry-run', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ownership is missing or changed/);
    rmSync(installed, { recursive: true });
    rmSync(path.join(targetRoot, '.claude/skills/owner-skill'), { recursive: true });
    parseJsonResult(applyReviewedSkills(targetRoot, ['sync', '--apply', '--json']));
    assert.equal(existsSync(path.join(installed, 'SKILL.md')), true);
    const doctor = runDoctor(['--target', targetRoot, '--dev', '--strict', '--json']);
    assert.equal(doctor.status, 0, formatCommandResult(doctor));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('initialization checks team lock ownership before creating a manifest in a clean clone', () => {
  const targetRoot = makeTempDir('p2a-clone-ownership-');
  try {
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
    writeSkillSource(targetRoot, 'p2a-harness');
    parseJsonResult(applyReviewedSkills(targetRoot, [
      'add', './external-source', '--skill', 'p2a-harness', '--tools', 'codex', '--apply', '--json',
    ]));
    rmSync(path.join(targetRoot, '.plan2agent'), { recursive: true });
    rmSync(path.join(targetRoot, '.agents'), { recursive: true });
    const lockBefore = readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8');
    for (const mode of [[], ['--dry-run']]) {
      const initialized = runHandoff(['init', '--target', targetRoot, '--tools', 'codex', '--overwrite', ...mode]);
      assert.notEqual(initialized.status, 0);
      assert.match(initialized.stderr, /collides with external skill ownership/);
      assert.equal(existsSync(path.join(targetRoot, '.plan2agent')), false);
      assert.equal(existsSync(path.join(targetRoot, '.agents')), false);
      assert.equal(readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8'), lockBefore);
    }
    const compatible = runHandoff(['init', '--target', targetRoot, '--tools', 'none', '--overwrite']);
    assert.equal(compatible.status, 0, formatCommandResult(compatible));
    parseJsonResult(applyReviewedSkills(targetRoot, ['sync', '--apply', '--json']));
    assert.equal(existsSync(path.join(targetRoot, '.agents/skills/p2a-harness/SKILL.md')), true);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('all external mutations preserve installed-only ownership instead of silently rebuilding it', () => {
  const targetRoot = scaffoldTarget();
  try {
    for (const name of ['alpha', 'beta', 'gamma']) writeSkillSource(targetRoot, name);
    for (const name of ['alpha', 'beta']) {
      parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', name, '--apply', '--json']));
    }
    const lockPath = path.join(targetRoot, 'p2a-skills.lock.json');
    const manifestPath = path.join(targetRoot, '.plan2agent/manifest.json');
    const originalLock = readFileSync(lockPath, 'utf8');
    const originalManifest = JSON.parse(readFileSync(manifestPath));
    const lock = JSON.parse(originalLock);
    delete lock.skills.beta;
    writeFileSync(lockPath, JSON.stringify(lock));
    for (const retainedField of ['externalSkills', 'externalSkillFiles', 'managedFiles']) {
      const manifest = structuredClone(originalManifest);
      if (retainedField !== 'externalSkills') manifest.externalSkills = manifest.externalSkills.filter((record) => record.name !== 'beta');
      if (retainedField !== 'externalSkillFiles') manifest.externalSkillFiles = manifest.externalSkillFiles.filter((file) => !file.includes('/beta/'));
      if (retainedField !== 'managedFiles') manifest.managedFiles = manifest.managedFiles.filter((record) => record.owner !== 'external-skill:beta');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const before = [manifestPath, lockPath].map((file) => readFileSync(file, 'utf8'));
      for (const operation of [
        ['add', './external-source', '--skill', 'gamma'], ['update', 'alpha'], ['remove', 'alpha'], ['sync'],
      ]) {
        const preview = runSkills(targetRoot, [...operation, '--dry-run', '--json']);
        assert.notEqual(preview.status, 0, `${retainedField}: ${operation[0]}`);
        assert.match(preview.stderr, /manual_review.*manifest.*lock/);
        assert.deepEqual([manifestPath, lockPath].map((file) => readFileSync(file, 'utf8')), before);
        assert.equal(existsSync(path.join(targetRoot, '.agents/skills/beta/SKILL.md')), true);
      }
      assert.equal(parseJsonResult(runSkills(targetRoot, ['list', '--json'])).status, 'drifted');
    }
    writeFileSync(lockPath, originalLock);
    const missingInventory = structuredClone(originalManifest);
    missingInventory.externalSkills = [];
    missingInventory.externalSkillFiles = [];
    missingInventory.managedFiles = missingInventory.managedFiles.filter((record) => !record.owner.startsWith('external-skill:'));
    writeFileSync(manifestPath, JSON.stringify(missingInventory));
    const unowned = runSkills(targetRoot, ['add', './external-source', '--skill', 'gamma', '--dry-run', '--json']);
    assert.notEqual(unowned.status, 0);
    assert.match(unowned.stderr, /missing local inventory/);
    writeFileSync(manifestPath, JSON.stringify(originalManifest));
    parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', 'gamma', '--apply', '--json']));
    assert.equal(parseJsonResult(runSkills(targetRoot, ['list', '--json'])).status, 'ok');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('skill inventories reject case-fold collisions in files and ancestor directories', async () => {
  const { validateExternalSkillsLock } = await import('../scripts/p2a_external_skills.mjs');
  const targetRoot = scaffoldTarget();
  try {
    writeSkillSource(targetRoot, 'portable-skill', '# Portable\n', { 'Foo/a.md': 'one\n' });
    const report = parseJsonResult(applyReviewedSkills(targetRoot, ['add', './external-source', '--skill', 'portable-skill', '--apply', '--json']));
    const lock = report.lock;
    const record = lock.skills['portable-skill'];
    const file = record.files.find((item) => item.path === 'Foo/a.md');
    for (const conflicting of ['foo/a.md', 'foo/b.md']) {
      const changed = structuredClone(lock);
      changed.skills['portable-skill'].files.push({ ...file, path: conflicting });
      assert.throws(() => validateExternalSkillsLock(changed), /case-insensitive collision/);
    }
    const source = path.join(targetRoot, 'external-source/skills/portable-skill');
    // Only case-sensitive hosts can physically represent both spellings.
    if (!existsSync(path.join(source, 'foo/a.md'))) {
      mkdirSync(path.join(source, 'foo'));
      writeFileSync(path.join(source, 'foo/b.md'), 'two\n');
      const preview = runSkills(targetRoot, ['update', '--dry-run', '--json']);
      assert.notEqual(preview.status, 0);
      assert.match(preview.stderr, /case-insensitive collision/);
    }
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('a failed second provider copy removes prepared copies and newly created directories', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { addExternalSkill } = await import('../scripts/p2a_external_skills.mjs');
  const targetRoot = makeTempDir('p2a-copy-failure-');
  const originalCopy = fs.cpSync;
  try {
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
    writeSkillSource(targetRoot, 'copy-skill');
    const manifestBefore = readFileSync(path.join(targetRoot, '.plan2agent/manifest.json'), 'utf8');
    const options = { tools: ['codex', 'claude'] };
    const preview = addExternalSkill(targetRoot, './external-source', 'copy-skill', options);
    fs.cpSync = (source, destination, copyOptions) => {
      if (destination.includes(`${path.sep}.claude${path.sep}`)) {
        throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      }
      return originalCopy(source, destination, copyOptions);
    };
    syncBuiltinESMExports();
    assert.throws(() => addExternalSkill(targetRoot, './external-source', 'copy-skill', {
      ...options, apply: true, expectedPlan: preview.planDigest,
    }), /injected disk full/);
    assert.equal(existsSync(path.join(targetRoot, '.agents')), false);
    assert.equal(existsSync(path.join(targetRoot, '.claude')), false);
    assert.equal(existsSync(path.join(targetRoot, 'p2a-skills.lock.json')), false);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent/tmp/external-skills-transaction.json')), false);
    assert.equal(readFileSync(path.join(targetRoot, '.plan2agent/manifest.json'), 'utf8'), manifestBefore);
  } finally {
    fs.cpSync = originalCopy;
    syncBuiltinESMExports();
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('remote Git validation rejects dereferenced links and sync restores the pinned commit', async (context) => {
  const { spawn, spawnSync } = await import('node:child_process');
  const net = await import('node:net');
  const root = makeTempDir('p2a-remote-fixture-');
  let daemon;
  try {
    const targetRoot = path.join(root, 'project');
    const repository = path.join(root, 'fixture.git');
    mkdirSync(targetRoot);
    mkdirSync(repository);
    writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    const scaffold = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(scaffold.status, 0, formatCommandResult(scaffold));
    const skill = path.join(repository, 'skills/remote-skill');
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote fixture\n---\nVersion one\n');
    writeFileSync(path.join(repository, '.gitattributes'), '*.md text eol=crlf\n');
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
      assert.equal(result.status, 0, formatCommandResult(result));
      return result.stdout.trim();
    };
    git('init', '-b', 'main');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-a', 'v1.0', '-m', 'annotated release');
    const initialCommit = git('rev-parse', 'HEAD');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--listen=127.0.0.1', `--port=${port}`, `--base-path=${root}`, root], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.git://127.0.0.1:${port}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://p2a-fixture.invalid/' };
    const run = (args, extraEnv = {}, destination = targetRoot) => spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/p2a.mjs'), 'skills', ...args, '--target', destination, '--json'], { cwd: destination, encoding: 'utf8', env: { ...env, ...extraEnv } });
    const gitTarget = path.join(root, 'git-target');
    const gitScaffold = runHandoff(['scaffold', '--target', gitTarget, '--tools', 'none']);
    assert.equal(gitScaffold.status, 0, formatCommandResult(gitScaffold));
    const gitSource = `git://127.0.0.1:${port}/fixture.git`;
    const gitAdd = ['add', gitSource, '--skill', 'remote-skill', '--tools', 'codex'];
    const gitPreview = parseJsonResult(run([...gitAdd, '--dry-run'], {}, gitTarget));
    const gitTagged = parseJsonResult(run([
      ...gitAdd.map((arg) => arg === gitSource ? `${gitSource}#v1.0` : arg), '--dry-run',
    ], {}, gitTarget));
    assert.equal(gitTagged.changes[0].source.spec, gitSource);
    assert.equal(gitTagged.changes[0].source.ref, 'v1.0');
    assert.equal(gitTagged.changes[0].source.resolvedCommit, initialCommit);
    const gitApplied = parseJsonResult(run([...gitAdd, '--apply', '--expect-plan', gitPreview.planDigest], {}, gitTarget));
    assert.equal(gitApplied.lock.skills['remote-skill'].source.spec, gitSource);
    const add = ['add', 'https://p2a-fixture.invalid/fixture.git', '--skill', 'remote-skill', '--tools', 'codex'];
    const preview = parseJsonResult(run([...add, '--dry-run']));
    const tagged = parseJsonResult(run([...add.map((arg) => arg === add[1] ? `${arg}#v1.0` : arg), '--dry-run']));
    assert.equal(tagged.changes[0].source.resolvedCommit, initialCommit);
    assert.equal(tagged.changes[0].toSha256, preview.changes[0].toSha256);
    const crlfEnvironment = {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_KEY_2: 'core.eol', GIT_CONFIG_VALUE_2: 'crlf',
    };
    const crlfPreview = parseJsonResult(run([...add, '--dry-run'], crlfEnvironment));
    assert.equal(crlfPreview.planDigest, preview.planDigest);
    const applied = parseJsonResult(run([...add, '--apply', '--expect-plan', preview.planDigest], crlfEnvironment));
    assert.equal(applied.lock.skills['remote-skill'].source.skillPath, 'skills/remote-skill/SKILL.md');
    const installed = path.join(targetRoot, '.agents/skills/remote-skill');
    const lockedBytes = readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
    writeFileSync(path.join(skill, 'SKILL.md'), lockedBytes.replace('Version one', 'Version two'));
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'updated');
    rmSync(installed, { recursive: true });
    const sync = parseJsonResult(run(['sync', '--dry-run']));
    parseJsonResult(run(['sync', '--apply', '--expect-plan', sync.planDigest], crlfEnvironment));
    assert.equal(readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), lockedBytes);
    const gitInstalled = path.join(gitTarget, '.agents/skills/remote-skill');
    rmSync(gitInstalled, { recursive: true });
    const gitSync = parseJsonResult(run(['sync', '--dry-run'], {}, gitTarget));
    parseJsonResult(run(['sync', '--apply', '--expect-plan', gitSync.planDigest], crlfEnvironment, gitTarget));
    assert.equal(readFileSync(path.join(gitInstalled, 'SKILL.md'), 'utf8'), lockedBytes);
    const gitUpdate = parseJsonResult(run(['update', '--dry-run'], {}, gitTarget));
    assert.equal(gitUpdate.changes[0].source.spec, gitSource);
    assert.equal(gitUpdate.changes[0].source.resolvedCommit, git('rev-parse', 'HEAD'));
    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'outside fixture bytes');
    try { symlinkSync(outside, path.join(skill, 'outside.txt')); } catch (error) {
      if (error.code === 'EPERM') { context.diagnostic('host does not permit symlinks; pinned restoration verified'); return; }
      throw error;
    }
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'symlink');
    const before = readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8');
    const rejected = run(['update', '--apply', '--expect-plan', preview.planDigest]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /symbolic link or non-regular Git entry/);
    assert.equal(existsSync(path.join(installed, 'outside.txt')), false);
    assert.equal(readFileSync(path.join(targetRoot, 'p2a-skills.lock.json'), 'utf8'), before);
  } finally {
    if (daemon) {
      daemon.kill();
      if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
