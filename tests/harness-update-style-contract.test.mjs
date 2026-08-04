import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatCommandResult,
  makeTempDir,
  runHandoff,
} from './helpers/fixtures.mjs';

test('checkout scaffold guide directs users through the co-located runtime', () => {
  const targetRoot = makeTempDir('p2a-next-guide-');
  try {
    const result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(result.status, 0, formatCommandResult(result));

    const guide = readFileSync(path.join(targetRoot, 'PLAN2AGENT.md'), 'utf8');
    assert.match(guide, /`node \.plan2agent\/scripts\/p2a\.mjs next`/);
    assert.match(guide, /\/p2a-next/);
    assert.doesNotMatch(guide, /p2a\.mjs info/);
    assert.doesNotMatch(guide, /p2a\.mjs execute plan/);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('new scaffolds defer Gate ② and update preserves a legacy project-defined style contract', () => {
  const targetRoot = makeTempDir('p2a-style-contract-update-');
  const stylePath = path.join(targetRoot, '.plan2agent', 'style.md');
  try {
    let result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(stylePath), false);
    assert.equal(existsSync(path.join(targetRoot, '.plan2agent', 'constitution.json')), false);

    result = runHandoff(['update', '--target', targetRoot, '--dry-run']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.doesNotMatch(result.stdout, /\.plan2agent\/(?:style\.md|constitution\.json)/);

    writeFileSync(stylePath, '# Project-specific style\n\nKeep this contract.\n', 'utf8');
    result = runHandoff(['update', '--target', targetRoot, '--dry-run']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /changes: none/);
    assert.equal(readFileSync(stylePath, 'utf8'), '# Project-specific style\n\nKeep this contract.\n');
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('update discovers retired managed files from the manifest and prunes only unchanged files explicitly', () => {
  const targetRoot = makeTempDir('p2a-retired-harness-update-');
  const retiredRelative = '.plan2agent/scripts/p2a_retired_example.mjs';
  const retiredPath = path.join(targetRoot, retiredRelative);
  const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  try {
    let result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(result.status, 0, formatCommandResult(result));

    const retiredContent = '// formerly managed helper\n';
    mkdirSync(path.dirname(retiredPath), { recursive: true });
    writeFileSync(retiredPath, retiredContent, 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.includedTools.push('p2a_retired_example');
    manifest.scriptFiles.push(retiredRelative);
    manifest.toolFiles.push(retiredRelative);
    manifest.managedFiles.push({
      path: retiredRelative,
      owner: 'runtime-script',
      sha256: createHash('sha256').update(retiredContent).digest('hex'),
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    result = runHandoff(['update', '--target', targetRoot, '--dry-run']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /prunable: remove \(manifest\) -> \.plan2agent\/scripts\/p2a_retired_example\.mjs/);
    assert.match(result.stdout, /--apply --prune/);

    result = runHandoff(['update', '--target', targetRoot, '--apply']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(retiredPath), true);

    result = runHandoff(['update', '--target', targetRoot, '--apply', '--prune']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(retiredPath), false);
    const updatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updatedManifest.includedTools.includes('p2a_retired_example'), false);
    assert.equal(updatedManifest.scriptFiles.includes(retiredRelative), false);
    assert.equal(updatedManifest.toolFiles.includes(retiredRelative), false);
    assert.equal(updatedManifest.managedFiles.some((record) => record.path === retiredRelative), false);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('update reports legacy or modified retired files without deleting them', () => {
  const targetRoot = makeTempDir('p2a-retired-manual-review-');
  const legacyRelative = '.plan2agent/scripts/p2a_legacy_retired.mjs';
  const modifiedRelative = '.plan2agent/scripts/p2a_modified_retired.mjs';
  const legacyPath = path.join(targetRoot, legacyRelative);
  const modifiedPath = path.join(targetRoot, modifiedRelative);
  const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  try {
    let result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'none']);
    assert.equal(result.status, 0, formatCommandResult(result));

    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, '// legacy file without an installation hash\n', 'utf8');
    writeFileSync(modifiedPath, '// locally modified file\n', 'utf8');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scriptFiles.push(legacyRelative, modifiedRelative);
    manifest.toolFiles.push(legacyRelative, modifiedRelative);
    manifest.managedFiles.push({
      path: modifiedRelative,
      owner: 'runtime-script',
      sha256: createHash('sha256').update('// original installed file\n').digest('hex'),
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    result = runHandoff(['update', '--target', targetRoot, '--dry-run', '--prune']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /retired: remove \(manifest\) -> \.plan2agent\/scripts\/p2a_legacy_retired\.mjs/);
    assert.match(result.stdout, /installation hash is unavailable/);
    assert.match(result.stdout, /retired: remove \(manifest\) -> \.plan2agent\/scripts\/p2a_modified_retired\.mjs/);
    assert.match(result.stdout, /changed after installation/);

    result = runHandoff(['update', '--target', targetRoot, '--apply', '--prune']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(legacyPath), true);
    assert.equal(existsSync(modifiedPath), true);

    unlinkSync(legacyPath);
    result = runHandoff(['update', '--target', targetRoot, '--apply']);
    assert.equal(result.status, 0, formatCommandResult(result));
    const updatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(updatedManifest.scriptFiles.includes(legacyRelative), false);
    assert.equal(updatedManifest.toolFiles.includes(legacyRelative), false);
    assert.equal(updatedManifest.scriptFiles.includes(modifiedRelative), true);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('update prunes deselected provider assets and their manifest ownership without path allowlists', () => {
  const targetRoot = makeTempDir('p2a-provider-prune-');
  const manifestPath = path.join(targetRoot, '.plan2agent', 'manifest.json');
  const codexAgentPath = path.join(targetRoot, '.codex', 'agents', 'p2a-implementer.toml');
  try {
    let result = runHandoff(['scaffold', '--target', targetRoot, '--tools', 'all']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(codexAgentPath), true);

    result = runHandoff(['update', '--target', targetRoot, '--tools', 'none', '--apply', '--prune']);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.equal(existsSync(codexAgentPath), false);

    const updatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(updatedManifest.aiToolTargets, []);
    assert.deepEqual(updatedManifest.aiToolFiles, []);
    assert.deepEqual(updatedManifest.aiToolGroups, []);
    assert.equal(updatedManifest.includedTools.some((tool) => /^p2a_(codex|claude|gemini)_assets$/.test(tool)), false);
    assert.equal(updatedManifest.managedFiles.some((record) => record.owner.startsWith('ai-tool:')), false);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
