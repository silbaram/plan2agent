import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkMemoryAtClose,
  collectCodeFileTree,
  consumePlanningMemoryLayer,
  memoryFreshnessFromStatusReport,
  mergePlanningMemoryIntoIntake,
  mergePlanningMemoryIntoSpec,
  planningMemoryIncompleteWarningLines,
  planningMemoryRecallCommand,
  planningMemoryRecallPlan,
  planningMemoryValidationErrors,
  validatePlanningMemoryEvidence,
} from '../scripts/p2a_iteration.mjs';
import {
  E2E_FIXTURE_ROOT,
  formatCommandResult,
  makeTempDir,
  runHandoff,
  runTargetP2a,
} from './helpers/fixtures.mjs';

function withProjectConfig(config, callback) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'p2a-memory-recall-'));
  try {
    mkdirSync(path.join(projectRoot, '.plan2agent'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.plan2agent', 'project.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );
    return callback(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('planning recall stays silent when Memory is disabled or unconfigured', () => {
  withProjectConfig({ memory: { enabled: false } }, (projectRoot) => {
    assert.equal(planningMemoryRecallCommand({
      projectRoot,
      projectId: 'demo-project',
      iterationRoot: path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project', 'iterations', 'iter-002'),
      idea: 'Add dashboard',
      environment: {},
    }), null);
  });

  withProjectConfig({ memory: { enabled: true, serverUrlEnv: 'P2A_TEST_MEMORY_URL' } }, (projectRoot) => {
    assert.equal(planningMemoryRecallCommand({
      projectRoot,
      projectId: 'demo-project',
      iterationRoot: path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project', 'iterations', 'iter-002'),
      idea: 'Add dashboard',
      environment: {},
    }), null);
  });
});

test('planning recall emits a project-wide hybrid search with a durable report', () => {
  withProjectConfig({ memory: { enabled: true, serverUrlEnv: 'P2A_TEST_MEMORY_URL' } }, (projectRoot) => {
    const command = planningMemoryRecallCommand({
      projectRoot,
      projectId: 'demo-project',
      iterationRoot: path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project', 'iterations', 'iter-002'),
      idea: 'Add follow-up dashboard',
      environment: { P2A_TEST_MEMORY_URL: 'http://127.0.0.1:8080' },
    });

    assert.match(command, /memory search --project demo-project --mode hybrid/);
    assert.match(command, /--query 'Add follow-up dashboard'/);
    assert.match(command, /gate-a-intake\/memory-recall\.json/);
  });
});

test('planning recall accepts an explicit configured server URL', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const command = planningMemoryRecallCommand({
      projectRoot,
      projectId: 'demo-project',
      iterationRoot: path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project', 'iterations', 'iter-002'),
      idea: 'Reuse prior decision',
      environment: {},
    });

    assert.match(command, /memory search --project demo-project --mode hybrid/);
  });
});

test('reusable concerns add a global cross-project recall that excludes the current project', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-002');
    const plan = planningMemoryRecallPlan({
      projectRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationRoot,
      previousIterationId: 'iter-001',
      idea: 'Harden authentication failure handling and queue reliability',
      environment: {},
    });

    assert.equal(plan.status, 'pending');
    assert.equal(plan.layers.project.status, 'pending');
    assert.equal(plan.layers.cross_project.required, true);
    assert.equal(plan.layers.cross_project.status, 'pending');
    assert.match(plan.layers.cross_project.command, /memory search --global --exclude-project demo-project --mode hybrid/);
    assert.match(plan.layers.cross_project.command, /memory-recall-cross-project\.json/);
  });
});

test('ordinary product wording skips the cross-project layer without disabling project recall', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const plan = planningMemoryRecallPlan({
      projectRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationRoot: path.join(artifactRoot, 'iterations', 'iter-002'),
      previousIterationId: 'iter-001',
      idea: 'Rename the dashboard heading',
      environment: {},
    });

    assert.equal(plan.layers.project.status, 'pending');
    assert.equal(plan.layers.cross_project.required, false);
    assert.equal(plan.layers.cross_project.status, 'skipped');
    assert.equal(plan.layers.cross_project.command, null);
  });
});

test('planning recall warnings disclose incomplete history, report paths, and failure details', () => {
  const failedLines = planningMemoryIncompleteWarningLines({
    status: 'failed',
    layers: {
      project: {
        scope: 'project',
        status: 'failed',
        report_ref: 'iterations/iter-002/gate-a-intake/memory-recall.json',
        detail: 'Memory server unavailable.',
      },
      cross_project: {
        scope: 'cross_project',
        required: false,
        status: 'skipped',
        report_ref: 'iterations/iter-002/gate-a-intake/memory-recall-cross-project.json',
        detail: 'No reusable cross-project concern was detected.',
      },
    },
  });

  assert.match(failedLines.join('\n'), /continued without complete historical Memory evidence/);
  assert.match(failedLines.join('\n'), /does not mean that no prior decisions or failures exist/);
  assert.match(failedLines.join('\n'), /report=iterations\/iter-002\/gate-a-intake\/memory-recall\.json/);
  assert.match(failedLines.join('\n'), /detail=Memory server unavailable/);
  assert.doesNotMatch(failedLines.join('\n'), /memory-recall-cross-project\.json/);

  const skippedLines = planningMemoryIncompleteWarningLines({
    status: 'skipped',
    layers: {
      project: {
        scope: 'project',
        status: 'skipped',
        report_ref: 'iterations/iter-003/gate-a-intake/memory-recall.json',
        detail: 'Recall report was not created before draft.',
      },
      cross_project: {
        scope: 'cross_project',
        required: true,
        status: 'skipped',
        report_ref: 'iterations/iter-003/gate-a-intake/memory-recall-cross-project.json',
        detail: 'Recall report was not created before draft.',
      },
    },
  });

  assert.match(skippedLines.join('\n'), /is incomplete \(overall=skipped\)/);
  assert.match(skippedLines.join('\n'), /memory-recall\.json/);
  assert.match(skippedLines.join('\n'), /memory-recall-cross-project\.json/);

  const fallbackWithSkippedCrossProject = planningMemoryIncompleteWarningLines({
    status: 'fallback',
    layers: {
      project: {
        scope: 'project',
        status: 'fallback',
        report_ref: 'iterations/iter-004/gate-a-intake/memory-recall.json',
      },
      cross_project: {
        scope: 'cross_project',
        required: true,
        status: 'skipped',
        report_ref: 'iterations/iter-004/gate-a-intake/memory-recall-cross-project.json',
        detail: 'Recall report was not created before draft.',
      },
    },
  });
  assert.match(fallbackWithSkippedCrossProject.join('\n'), /is incomplete \(overall=fallback\)/);
  assert.match(fallbackWithSkippedCrossProject.join('\n'), /memory-recall-cross-project\.json/);

  const skippedProjectWithFallbackCrossProject = planningMemoryIncompleteWarningLines({
    status: 'fallback',
    layers: {
      project: {
        scope: 'project',
        status: 'skipped',
        report_ref: 'iterations/iter-005/gate-a-intake/memory-recall.json',
        detail: 'Recall report was not created before draft.',
      },
      cross_project: {
        scope: 'cross_project',
        required: true,
        status: 'fallback',
        report_ref: 'iterations/iter-005/gate-a-intake/memory-recall-cross-project.json',
      },
    },
  });
  assert.match(skippedProjectWithFallbackCrossProject.join('\n'), /is incomplete \(overall=fallback\)/);
  assert.match(skippedProjectWithFallbackCrossProject.join('\n'), /memory-recall\.json/);
  assert.doesNotMatch(skippedProjectWithFallbackCrossProject.join('\n'), /memory-recall-cross-project\.json/);

  assert.deepEqual(planningMemoryIncompleteWarningLines({
    status: 'fallback',
    layers: {
      project: { scope: 'project', status: 'fallback' },
      cross_project: { scope: 'cross_project', required: true, status: 'fallback' },
    },
  }), []);
  assert.deepEqual(planningMemoryIncompleteWarningLines({ status: 'succeeded' }), []);
  assert.deepEqual(planningMemoryIncompleteWarningLines({ status: 'not_configured' }), []);
});

test('code signals keep application scripts, schemas, artifacts, and run sources', () => {
  const codeRoot = makeTempDir('p2a-code-signals-');
  try {
    const expectedFiles = [
      'artifacts/generated-client.ts',
      'runs/job-runner.ts',
      'schemas/domain.schema.json',
      'scripts/migrate.mjs',
    ];
    for (const relativePath of expectedFiles) {
      const filePath = path.join(codeRoot, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '// application source\n', 'utf8');
    }
    const harnessFile = path.join(codeRoot, '.plan2agent', 'scripts', 'p2a.mjs');
    mkdirSync(path.dirname(harnessFile), { recursive: true });
    writeFileSync(harnessFile, '// harness source\n', 'utf8');

    const signals = collectCodeFileTree(codeRoot);
    assert.deepEqual(signals.file_tree, expectedFiles);
    assert.equal(signals.file_tree.some((filePath) => filePath.startsWith('.plan2agent/')), false);
  } finally {
    rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('code signal cap is distributed across directories so generated artifacts cannot hide source files', () => {
  const codeRoot = makeTempDir('p2a-code-signal-cap-');
  try {
    const artifactsDir = path.join(codeRoot, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(
        path.join(artifactsDir, `${String(index).padStart(3, '0')}.json`),
        '{}\n',
        'utf8',
      );
    }
    mkdirSync(path.join(codeRoot, 'src'), { recursive: true });
    writeFileSync(path.join(codeRoot, 'src', 'main.ts'), 'export {};\n', 'utf8');

    const signals = collectCodeFileTree(codeRoot);
    assert.equal(signals.truncated, true);
    assert.equal(signals.file_tree.length, 300);
    assert.equal(signals.file_tree.includes('src/main.ts'), true);
  } finally {
    rmSync(codeRoot, { recursive: true, force: true });
  }
});

test('Memory freshness reports distinguish fresh, stale, unavailable, and unchecked baselines', () => {
  const base = {
    schema_version: 'p2a.memory_status.v1',
    server: { status: 'up' },
    sync: { summary: { synced: 1, missingRemote: 0, remoteDiffers: 0, extraRemote: 0 } },
    skippedRuns: [],
    skippedProposals: [],
  };
  assert.equal(memoryFreshnessFromStatusReport(null).status, 'unchecked');
  assert.equal(memoryFreshnessFromStatusReport(base).status, 'fresh');
  assert.equal(memoryFreshnessFromStatusReport({
    ...base,
    sync: { summary: { synced: 0, missingRemote: 1, remoteDiffers: 0, extraRemote: 0 } },
  }).status, 'stale');
  assert.equal(memoryFreshnessFromStatusReport({
    ...base,
    server: { status: 'unavailable' },
  }).status, 'unavailable');
  assert.equal(memoryFreshnessFromStatusReport({
    schema_version: 'p2a.memory_status.v1',
    server: { status: 'up' },
  }).status, 'unavailable');
  assert.equal(memoryFreshnessFromStatusReport({
    ...base,
    sync: { summary: { synced: 1, missingRemote: 'invalid', remoteDiffers: 0, extraRemote: 0 } },
  }).status, 'unavailable');
  assert.equal(memoryFreshnessFromStatusReport({
    ...base,
    context: { projectId: 'other-project', iterationId: 'iter-001' },
  }, {
    projectId: 'demo-project',
    iterationId: 'iter-001',
  }).status, 'unavailable');
});

test('iteration close persists and surfaces an unavailable automatic Memory check without blocking archive', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080', requestTimeoutMs: 250 } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-001');
    mkdirSync(iterationRoot, { recursive: true });
    let runnerOptions = null;
    const result = checkMemoryAtClose({
      projectRoot,
      artifactRoot,
      iterationRoot,
      configuration: {
        enabled: true,
        configured: true,
        reason: null,
        server: 'http://127.0.0.1:8080',
        requestTimeoutMs: 250,
      },
      runner(_executable, argv, options) {
        runnerOptions = options;
        const outputPath = argv[argv.indexOf('--output') + 1];
        writeFileSync(outputPath, `${JSON.stringify({
          schema_version: 'p2a.memory_status.v1',
          generatedAt: '2026-07-25T00:00:00.000Z',
          server: {
            url: 'http://127.0.0.1:8080',
            status: 'unavailable',
            detail: 'connect ECONNREFUSED 127.0.0.1:8080',
          },
          sync: { summary: { missingRemote: 0, remoteDiffers: 0 } },
          skippedRuns: [],
          skippedProposals: [],
        }, null, 2)}\n`, 'utf8');
        return { status: 1, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.check_exit_code, 1);
    assert.match(result.detail, /ECONNREFUSED/);
    assert.match(result.status_command, /memory status/);
    assert.match(result.status_command, /--timeout-ms 250/);
    assert.equal(result.report_ref, 'iterations/iter-001/memory-status.json');
    assert.equal(result.operation_timeout_ms, 15000);
    assert.equal(runnerOptions.timeout, 15000);
    assert.equal(runnerOptions.killSignal, 'SIGTERM');
    const report = JSON.parse(readFileSync(path.join(iterationRoot, 'memory-status.json'), 'utf8'));
    assert.equal(report.server.status, 'unavailable');
    assert.deepEqual(
      readdirSync(iterationRoot).filter((entry) => entry.startsWith('.memory-status.')),
      [],
    );
  });
});

test('close-time Memory check never reuses an older report when the child process times out', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080', requestTimeoutMs: 250 } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-001');
    mkdirSync(iterationRoot, { recursive: true });
    const reportPath = path.join(iterationRoot, 'memory-status.json');
    writeFileSync(reportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_status.v1',
      generatedAt: '2026-07-24T00:00:00.000Z',
      server: { status: 'up' },
      sync: { summary: { missingRemote: 0, remoteDiffers: 0 } },
      skippedRuns: [],
      skippedProposals: [],
    }, null, 2)}\n`, 'utf8');

    const timeoutError = new Error('spawnSync ETIMEDOUT');
    timeoutError.code = 'ETIMEDOUT';
    const result = checkMemoryAtClose({
      projectRoot,
      artifactRoot,
      iterationRoot,
      operationTimeoutMs: 600,
      configuration: {
        enabled: true,
        configured: true,
        reason: null,
        server: 'http://127.0.0.1:8080',
        requestTimeoutMs: 250,
      },
      runner() {
        return {
          status: null,
          signal: 'SIGTERM',
          error: timeoutError,
          stdout: '',
          stderr: '',
        };
      },
    });

    assert.equal(result.status, 'unavailable');
    assert.equal(result.check_exit_code, 1);
    assert.equal(result.operation_timeout_ms, 600);
    assert.match(result.detail, /600ms close-time limit/);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.server.status, 'unavailable');
    assert.equal(report.server.operationTimeoutMs, 600);
    assert.notEqual(report.generatedAt, '2026-07-24T00:00:00.000Z');
  });
});

test('planning recall rejects a completed mode when the report says the server was not configured', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-002');
    const plan = planningMemoryRecallPlan({
      projectRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationRoot,
      previousIterationId: 'iter-001',
      idea: 'Add webhook retries',
      environment: {},
    });
    const reportPath = path.join(artifactRoot, plan.layers.project.report_ref);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      server: { status: 'not_configured' },
      summary: { total: 0 },
      results: [],
    }, null, 2)}\n`, 'utf8');

    const layer = consumePlanningMemoryLayer(plan.layers.project, artifactRoot, 'demo-project');
    assert.equal(layer.status, 'failed');
    assert.match(layer.detail, /effectiveMode must be null/);
  });
});

test('planning recall preserves failed precedents outside the general result context window', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-002');
    const plan = planningMemoryRecallPlan({
      projectRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationRoot,
      previousIterationId: 'iter-001',
      idea: 'Add webhook retries',
      environment: {},
    });
    const results = Array.from({ length: 9 }, (_, index) => ({
      artifactType: 'RUN_RECORD',
      sourcePath: `runs/run-${index + 1}.json`,
      metadata: index === 8
        ? { status: 'failed', failureClass: 'network_timeout' }
        : { status: 'finished' },
    }));
    const reportPath = path.join(artifactRoot, plan.layers.project.report_ref);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      server: { status: 'up' },
      summary: { total: results.length },
      results,
    }, null, 2)}\n`, 'utf8');

    const layer = consumePlanningMemoryLayer(plan.layers.project, artifactRoot, 'demo-project');
    assert.equal(layer.status, 'succeeded');
    assert.equal(layer.result_count, 9);
    assert.equal(layer.relevant_results.length, 8);
    assert.equal(layer.relevant_failures.length, 1);
    assert.equal(layer.relevant_failures[0].source_path, 'runs/run-9.json');
    assert.equal(layer.relevant_failures[0].failure_class, 'network_timeout');
  });
});

test('configured iteration close archives successfully and warns when Memory is unreachable', () => {
  const tempRoot = makeTempDir('p2a-close-memory-integration-');
  try {
    const targetRoot = path.join(tempRoot, 'target-project');
    const sourceArtifacts = path.join(E2E_FIXTURE_ROOT, 'webhook-api-service');
    let result = runHandoff([
      '--project-id',
      'webhook-api-service',
      '--artifacts',
      sourceArtifacts,
      '--target',
      targetRoot,
      '--include-intake',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));

    const artifactRoot = path.join(
      targetRoot,
      '.plan2agent',
      'artifacts',
      'webhook-api-service',
    );
    result = runTargetP2a(targetRoot, [
      'iteration',
      'init',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'v1-mvp',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));
    const initializedSpec = JSON.parse(readFileSync(
      path.join(artifactRoot, 'iterations', 'v1-mvp', 'gate-b-spec', 'spec.json'),
      'utf8',
    ));
    assert.equal(initializedSpec.source_intake, '../gate-a-intake/intake.json');

    const configPath = path.join(targetRoot, '.plan2agent', 'project.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.memory = {
      ...config.memory,
      enabled: true,
      serverUrl: 'http://127.0.0.1:1',
      requestTimeoutMs: 100,
    };
    config.devExecution ??= {};
    config.devExecution.reviewPasses ??= {};
    config.devExecution.reviewPasses.acceptance = 'off';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const graphPath = path.join(
      artifactRoot,
      'iterations',
      'v1-mvp',
      'gate-c-task-graph',
      'task-graph.json',
    );
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
    graph.tasks.forEach((task) => { task.status = 'done'; });
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');

    result = runTargetP2a(targetRoot, ['iteration', 'close', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /iteration closed/);
    assert.match(result.stdout, /Memory freshness: unavailable/);
    assert.match(result.stderr, /Memory server connection failed at iteration close/);

    const iterationRoot = path.join(artifactRoot, 'iterations', 'v1-mvp');
    const metadata = JSON.parse(readFileSync(path.join(iterationRoot, 'iteration.json'), 'utf8'));
    const report = JSON.parse(readFileSync(path.join(iterationRoot, 'memory-status.json'), 'utf8'));
    const currentSpec = JSON.parse(readFileSync(path.join(artifactRoot, 'current-spec.json'), 'utf8'));
    assert.equal(metadata.status, 'archived');
    assert.equal(metadata.memory_freshness.status, 'unavailable');
    assert.equal(report.server.status, 'unavailable');
    assert.equal(currentSpec.last_closed_iteration.iteration_id, 'v1-mvp');
    assert.deepEqual(
      readdirSync(iterationRoot).filter((entry) => entry.startsWith('.memory-status.')),
      [],
    );

    result = runTargetP2a(targetRoot, [
      'iteration',
      'open',
      '--artifacts',
      artifactRoot,
      '--iteration-id',
      'iter-002',
      '--idea',
      'Add follow-up dashboard',
    ]);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /planning recall \(project\)/);

    result = runTargetP2a(targetRoot, ['iteration', 'draft', '--artifacts', artifactRoot]);
    assert.equal(result.status, 0, formatCommandResult(result));
    assert.match(result.stdout, /planning Memory: skipped/);
    assert.match(result.stderr, /continued without complete historical Memory evidence/);
    assert.match(result.stderr, /does not mean that no prior decisions or failures exist/);
    assert.match(result.stderr, /report=iterations\/iter-002\/gate-a-intake\/memory-recall\.json/);
    assert.match(result.stderr, /detail=Recall report was not created before draft/);

    const nextMetadata = JSON.parse(readFileSync(
      path.join(artifactRoot, 'iterations', 'iter-002', 'iteration.json'),
      'utf8',
    ));
    assert.equal(nextMetadata.planning_memory.status, 'skipped');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a recall report is consumed into Gate A/B context and its citation contract is validated', () => {
  withProjectConfig({ memory: { enabled: true, serverUrl: 'http://127.0.0.1:8080' } }, (projectRoot) => {
    const artifactRoot = path.join(projectRoot, '.plan2agent', 'artifacts', 'demo-project');
    const iterationRoot = path.join(artifactRoot, 'iterations', 'iter-002');
    const plan = planningMemoryRecallPlan({
      projectRoot,
      artifactRoot,
      projectId: 'demo-project',
      iterationRoot,
      previousIterationId: 'iter-001',
      idea: 'Add webhook retries',
      environment: {},
    });
    const reportPath = path.join(artifactRoot, plan.layers.project.report_ref);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project', sourceProjectId: 'demo-project' },
      server: { status: 'up', detail: null },
      summary: { total: 1 },
      results: [{
        artifactType: 'RUN_RECORD',
        sourcePath: 'runs/run-prior.json',
        sourceReference: {
          canonicalServerId: 'run-prior',
          uri: 'file:///workspace/runs/run-prior.json',
          path: 'runs/run-prior.json',
          fragment: 'failure',
        },
        sourceIds: { sourceProjectId: 'demo-project' },
        metadata: { status: 'failed', failureClass: 'network_timeout' },
      }],
    }, null, 2)}\n`, 'utf8');

    const projectLayer = consumePlanningMemoryLayer(plan.layers.project, artifactRoot, 'demo-project');
    const memory = {
      ...plan,
      status: projectLayer.status,
      layers: { ...plan.layers, project: projectLayer },
    };
    assert.equal(projectLayer.status, 'succeeded');
    assert.equal(projectLayer.relevant_failures.length, 1);
    assert.equal(projectLayer.relevant_results[0].source_reference, 'runs/run-prior.json#failure');

    const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
    const intake = mergePlanningMemoryIntoIntake({
      known_facts: [],
      evidence: [{ source_id: 'LOCAL-1', title: 'Baseline', url: 'current-spec.json', used_for: 'baseline' }],
    }, memory);
    writeFileSync(intakePath, `${JSON.stringify(intake, null, 2)}\n`, 'utf8');
    validatePlanningMemoryEvidence(memory, intake, intakePath, artifactRoot);
    assert.match(intake.evidence[1].used_for, /query="Add webhook retries"/);

    const specPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
    mkdirSync(path.dirname(specPath), { recursive: true });
    const spec = mergePlanningMemoryIntoSpec({
      evidence: [{ source_id: 'LOCAL-1', title: 'Intake', url: '../gate-a-intake/intake.json', used_for: 'scope' }],
      reference_reconnaissance: {
        triggers: ['Review references.'],
        candidates: [],
        selected_patterns: [],
        rejected_patterns: [],
        open_questions: [],
      },
    }, memory);
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    validatePlanningMemoryEvidence(memory, spec, specPath, artifactRoot);
    assert.equal(planningMemoryValidationErrors(memory, artifactRoot, 'demo-project').length, 0);

    const collisionSafeIntake = mergePlanningMemoryIntoIntake({
      known_facts: [],
      evidence: [{ source_id: 'LOCAL-7', title: 'Existing', url: '', used_for: 'existing' }],
    }, memory);
    assert.equal(collisionSafeIntake.evidence.at(-1).source_id, 'LOCAL-8');

    const collisionSafeSpec = mergePlanningMemoryIntoSpec({
      evidence: [{ source_id: 'LOCAL-7', title: 'Existing', url: '', used_for: 'existing' }],
      reference_reconnaissance: {
        triggers: [],
        candidates: [
          { candidate_id: 'REF-3', source_id: 'LOCAL-7' },
          { candidate_id: 'REF-9', source_id: 'LOCAL-7' },
        ],
        selected_patterns: [],
        rejected_patterns: [],
        open_questions: [],
      },
    }, memory);
    assert.equal(collisionSafeSpec.evidence.at(-1).source_id, 'LOCAL-8');
    assert.equal(collisionSafeSpec.reference_reconnaissance.candidates.at(-1).candidate_id, 'REF-10');

    const dishonest = {
      ...memory,
      status: 'failed',
      layers: {
        ...memory.layers,
        project: { ...memory.layers.project, status: 'failed' },
      },
    };
    assert.match(
      planningMemoryValidationErrors(dishonest, artifactRoot, 'demo-project').join('; '),
      /claims failed but report state is succeeded/,
    );

    const emptyLayers = {
      ...memory,
      status: 'succeeded',
      layers: {},
    };
    assert.match(
      planningMemoryValidationErrors(emptyLayers, artifactRoot, 'demo-project').join('; '),
      /layers\.project is required/,
    );

    const dishonestOverallStatus = {
      ...memory,
      status: 'succeeded',
      layers: {
        ...memory.layers,
        project: {
          ...memory.layers.project,
          status: 'skipped',
        },
      },
    };
    assert.match(
      planningMemoryValidationErrors(dishonestOverallStatus, artifactRoot, 'demo-project').join('; '),
      /status claims succeeded but layer state is skipped/,
    );

    const escaped = consumePlanningMemoryLayer({
      ...plan.layers.project,
      report_ref: '../outside-memory-recall.json',
    }, artifactRoot, 'demo-project');
    assert.equal(escaped.status, 'failed');
    assert.match(escaped.detail, /inside the artifact root/);

    const brokenSpec = {
      ...spec,
      evidence: spec.evidence.map((item) => item.source_id === 'LOCAL-2' ? { ...item, used_for: 'Memory was used.' } : item),
    };
    assert.throws(
      () => validatePlanningMemoryEvidence(memory, brokenSpec, specPath, artifactRoot),
      /used_for must include query=/,
    );

    const malformedReportPath = path.join(iterationRoot, 'gate-a-intake', 'malformed-memory-recall.json');
    writeFileSync(malformedReportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      server: { status: 'up' },
      summary: { total: 'one' },
      results: { unexpected: true },
    }, null, 2)}\n`, 'utf8');
    const malformedLayer = consumePlanningMemoryLayer({
      ...plan.layers.project,
      report_ref: path.relative(artifactRoot, malformedReportPath),
    }, artifactRoot, 'demo-project');
    assert.equal(malformedLayer.status, 'failed');
    assert.equal(malformedLayer.result_count, 0);
    assert.deepEqual(malformedLayer.relevant_results, []);
    assert.match(malformedLayer.detail, /results must be an array/);
    assert.match(malformedLayer.detail, /summary\.total must be a non-negative integer/);

    const missingServerReportPath = path.join(iterationRoot, 'gate-a-intake', 'missing-server-memory-recall.json');
    writeFileSync(missingServerReportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      summary: { total: 0 },
      results: [],
    }, null, 2)}\n`, 'utf8');
    const missingServerLayer = consumePlanningMemoryLayer({
      ...plan.layers.project,
      report_ref: path.relative(artifactRoot, missingServerReportPath),
    }, artifactRoot, 'demo-project');
    assert.equal(missingServerLayer.status, 'failed');
    assert.match(missingServerLayer.detail, /server must be an object/);

    const invalidModeReportPath = path.join(iterationRoot, 'gate-a-intake', 'invalid-mode-memory-recall.json');
    writeFileSync(invalidModeReportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'vector',
        fallback: null,
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      server: { status: 'up' },
      summary: { total: 0 },
      results: [],
    }, null, 2)}\n`, 'utf8');
    const invalidModeLayer = consumePlanningMemoryLayer({
      ...plan.layers.project,
      report_ref: path.relative(artifactRoot, invalidModeReportPath),
    }, artifactRoot, 'demo-project');
    assert.equal(invalidModeLayer.status, 'failed');
    assert.match(invalidModeLayer.detail, /query\.effectiveMode is invalid/);

    const supplementalReportPath = path.join(iterationRoot, 'gate-a-intake', 'supplemental-memory-recall.json');
    writeFileSync(supplementalReportPath, `${JSON.stringify({
      schema_version: 'p2a.memory_search.v1',
      query: {
        text: 'Add webhook retries',
        mode: 'hybrid',
        effectiveMode: 'hybrid',
        fallback: {
          from: 'hybrid',
          to: 'keyword',
          reason: 'Hybrid candidate window was exhausted.',
          supplemental: true,
        },
        scope: 'project',
      },
      context: { projectId: 'demo-project' },
      server: { status: 'up' },
      summary: { total: 0 },
      results: [],
    }, null, 2)}\n`, 'utf8');
    const supplementalLayer = consumePlanningMemoryLayer({
      ...plan.layers.project,
      report_ref: path.relative(artifactRoot, supplementalReportPath),
    }, artifactRoot, 'demo-project');
    assert.equal(supplementalLayer.status, 'fallback');
    assert.equal(supplementalLayer.fallback.supplemental, true);
  });
});
