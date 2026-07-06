import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectProjectCommands } from '../scripts/p2a_project_config.mjs';

function tempProject() {
  return mkdtempSync(path.join(tmpdir(), 'p2a-project-config-'));
}

test('detects Gradle wrapper checkstyle lint and compile typecheck', () => {
  const root = tempProject();
  writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\n', 'utf8');
  writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'checkstyle' }\n", 'utf8');

  const detected = detectProjectCommands(root);

  assert.equal(detected.packageManager, 'gradle');
  assert.equal(detected.testCommand, './gradlew test');
  assert.equal(detected.lintCommand, './gradlew checkstyleMain');
  assert.equal(detected.typecheckCommand, './gradlew classes testClasses');
});

test('detects Gradle spotless lint without wrapper', () => {
  const root = tempProject();
  writeFileSync(path.join(root, 'build.gradle.kts'), 'plugins { id("com.diffplug.spotless") }\n', 'utf8');

  const detected = detectProjectCommands(root);

  assert.equal(detected.packageManager, 'gradle');
  assert.equal(detected.testCommand, 'gradle test');
  assert.equal(detected.lintCommand, 'gradle spotlessCheck');
  assert.equal(detected.typecheckCommand, 'gradle classes testClasses');
});

test('leaves Gradle lint null without static analysis plugin evidence', () => {
  const root = tempProject();
  writeFileSync(path.join(root, 'build.gradle'), "plugins { id 'java' }\n", 'utf8');

  const detected = detectProjectCommands(root);

  assert.equal(detected.packageManager, 'gradle');
  assert.equal(detected.lintCommand, null);
  assert.equal(detected.typecheckCommand, 'gradle classes testClasses');
});

test('detects Maven checkstyle lint and test compile typecheck', () => {
  const root = tempProject();
  writeFileSync(path.join(root, 'pom.xml'), `<project><build><plugins><plugin><artifactId>maven-checkstyle-plugin</artifactId></plugin></plugins></build></project>\n`, 'utf8');

  const detected = detectProjectCommands(root);

  assert.equal(detected.packageManager, 'maven');
  assert.equal(detected.testCommand, 'mvn test');
  assert.equal(detected.lintCommand, 'mvn checkstyle:check');
  assert.equal(detected.typecheckCommand, 'mvn test-compile');
});

test('keeps existing JavaScript package script command detection', () => {
  const root = tempProject();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node --test',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
    },
  }), 'utf8');

  const detected = detectProjectCommands(root);

  assert.equal(detected.packageManager, 'npm');
  assert.equal(detected.installCommand, 'npm install');
  assert.equal(detected.testCommand, 'npm test');
  assert.equal(detected.lintCommand, 'npm run lint');
  assert.equal(detected.typecheckCommand, 'npm run typecheck');
});
