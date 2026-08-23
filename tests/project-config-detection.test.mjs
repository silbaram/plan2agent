import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildProjectConfig,
  defaultDevExecution,
  detectProjectCommands,
  mergeDevSkillConfig,
  resolveExecutionModePolicy,
  resolveReviewPasses,
  resolveRunPersistence,
} from '../scripts/p2a_project_config.mjs';

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

test('defaults new projects to adaptive while preserving legacy omitted-mode behavior', () => {
  assert.equal(defaultDevExecution().executionMode, 'adaptive');
  assert.equal(Object.hasOwn(defaultDevExecution(), 'defaultIsolation'), false);
  assert.equal(resolveExecutionModePolicy({}), 'orchestrated');
  const projectConfig = buildProjectConfig(tempProject());
  assert.equal(projectConfig.devExecution.executionMode, 'adaptive');
  assert.equal(projectConfig.runTracking.defaultIsolation, 'none');
  assert.equal(projectConfig.runTracking.persistence, 'active_only');
  assert.equal(resolveRunPersistence(projectConfig), 'active_only');
  assert.equal(resolveRunPersistence({}), 'persistent');
  assert.equal(mergeDevSkillConfig({ devExecution: {} }).config.devExecution.executionMode, 'orchestrated');
  assert.equal(mergeDevSkillConfig({ devExecution: {} }).config.runTracking.persistence, 'active_only');
  assert.equal(mergeDevSkillConfig({
    runTracking: { persistence: 'persistent' },
    devExecution: {},
  }).config.runTracking.persistence, 'persistent');
  assert.deepEqual(defaultDevExecution().reviewPasses, {
    monitor: 'opt_in',
    visual: 'off',
    acceptance: 'opt_in',
  });
  assert.deepEqual(resolveReviewPasses({}), {
    monitor: 'opt_in',
    visual: 'off',
    acceptance: 'opt_in',
  });
});

test('validates explicit run persistence policies', () => {
  for (const persistence of ['persistent', 'active_only']) {
    assert.equal(resolveRunPersistence({ runTracking: { persistence } }), persistence);
  }
  assert.throws(
    () => resolveRunPersistence({ runTracking: { persistence: 'archive' } }),
    /runTracking\.persistence must be one of persistent, active_only/,
  );
  assert.throws(
    () => resolveRunPersistence({ runTracking: [] }),
    /runTracking must be an object/,
  );
});

test('supports explicit execution mode policies', () => {
  for (const mode of ['adaptive', 'direct', 'planned', 'orchestrated']) {
    assert.equal(resolveExecutionModePolicy({ devExecution: { executionMode: mode } }), mode);
  }
  assert.throws(
    () => resolveExecutionModePolicy({ devExecution: { executionMode: 'automatic' } }),
    /devExecution\.executionMode must be one of adaptive, direct, planned, orchestrated/,
  );
});

test('merges review pass defaults without replacing project overrides', () => {
  const merged = mergeDevSkillConfig({
    devExecution: {
      reviewPasses: {
        milestone: 'on',
        visual: 'opt_in',
      },
    },
  }).config;

  assert.deepEqual(merged.devExecution.reviewPasses, {
    milestone: 'on',
    visual: 'opt_in',
    monitor: 'opt_in',
    acceptance: 'opt_in',
  });
  assert.deepEqual(resolveReviewPasses(merged), {
    monitor: 'opt_in',
    milestone: 'on',
    visual: 'opt_in',
    acceptance: 'opt_in',
  });
});

test('rejects invalid review pass configuration values', () => {
  for (const value of ['enabled', true, '', 1, null]) {
    assert.throws(
      () => resolveReviewPasses({ devExecution: { reviewPasses: { style: value } } }),
      /devExecution\.reviewPasses\.style must be one of off, opt_in, on/,
    );
  }
  assert.throws(
    () => resolveReviewPasses({ devExecution: { reviewPasses: [] } }),
    /devExecution\.reviewPasses must be an object/,
  );
  assert.throws(
    () => resolveReviewPasses({
      devExecution: {
        reviewPasses: {
          mile: 'on',
          visuals: 'on',
        },
      },
    }),
    /devExecution\.reviewPasses has unknown key\(s\): mile, visuals/,
  );
});
