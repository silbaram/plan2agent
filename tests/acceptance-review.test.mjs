import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptanceReviewContract,
  iterationAcceptanceCriteria,
  validateAcceptanceReviewData,
  validateRunTaskContract,
  validateRunsDir,
} from '../scripts/validate_artifacts.mjs';
import { validateCloseReadyAcceptanceEvidence } from '../scripts/p2a_iteration.mjs';
import { runFilePath, runSidecarPath } from '../scripts/p2a_run_paths.mjs';
import { FIXTURE_ROOT, runExecute, runIteration, runP2a, runRuns } from './helpers/fixtures.mjs';

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function acceptanceSidecar(run, verification, options = {}) {
  return {
    schema_version: 'p2a.acceptance_review.v1',
    iteration_id: run.iterationId,
    source_spec_ref: run.sourceSpecRef,
    cases: run.acceptanceReview.criteria.map((criterion, index) => ({
      criterion_ref: criterion.ref,
      command: verification.command,
      source: verification.source,
      exitCode: verification.exitCode,
      stdoutTail: verification.stdoutTail ?? '',
      verdict: options.block && index === 0 ? 'fail' : 'pass',
    })),
    verdict: options.block ? 'block' : 'confirm_behavior',
    unmet: options.block ? ['The command reported 0 commits, so useful digest behavior was not demonstrated.'] : [],
  };
}

function managedNonUiIteration() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'p2a-acceptance-review-'));
  const artifactRoot = path.join(
    workspaceRoot,
    '.plan2agent',
    'artifacts',
    'webhook-api-service',
  );
  mkdirSync(path.dirname(artifactRoot), { recursive: true });
  cpSync(path.resolve('fixtures/_e2e/webhook-api-service'), artifactRoot, { recursive: true });
  const init = runIteration(['init', '--artifacts', artifactRoot, '--iteration-id', 'iter-001']);
  assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);
  const graphPath = path.join(
    artifactRoot,
    'iterations',
    'iter-001',
    'gate-c-task-graph',
    'task-graph.json',
  );
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  for (const task of graph.tasks) {
    task.status = 'done';
    delete task.visualImpact;
  }
  writeJson(graphPath, graph);
  return { workspaceRoot, artifactRoot, graphPath, graph };
}

function addCurrentIterationBaseline(fixture) {
  const iterationRoot = path.join(fixture.artifactRoot, 'iterations', 'iter-001');
  const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  const activeSpecPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
  const activeSpec = JSON.parse(readFileSync(activeSpecPath, 'utf8'));
  const baselineSpec = structuredClone(activeSpec);
  baselineSpec.product.core_flows.pop();
  baselineSpec.product.success_criteria.pop();
  writeJson(path.join(iterationRoot, 'baseline', 'gate-a-intake', 'intake.json'), intake);
  const baselineSpecPath = path.join(iterationRoot, 'baseline', 'gate-b-spec', 'spec.json');
  writeJson(baselineSpecPath, baselineSpec);

  intake.baseline_context = {
    spec_ref: 'iterations/iter-001/baseline/gate-b-spec/spec.json',
    spec_sha256: createHash('sha256').update(readFileSync(baselineSpecPath)).digest('hex'),
    reused_answers: [],
    reused_question_dispositions: [],
  };
  writeJson(intakePath, intake);
  return { activeSpec, baselineSpec };
}

function addIdenticalCurrentIterationBaseline(fixture) {
  const iterationRoot = path.join(fixture.artifactRoot, 'iterations', 'iter-001');
  const intakePath = path.join(iterationRoot, 'gate-a-intake', 'intake.json');
  const intake = JSON.parse(readFileSync(intakePath, 'utf8'));
  const activeSpecPath = path.join(iterationRoot, 'gate-b-spec', 'spec.json');
  const activeSpec = JSON.parse(readFileSync(activeSpecPath, 'utf8'));
  writeJson(path.join(iterationRoot, 'baseline', 'gate-a-intake', 'intake.json'), intake);
  const baselineSpecPath = path.join(iterationRoot, 'baseline', 'gate-b-spec', 'spec.json');
  writeJson(baselineSpecPath, activeSpec);
  intake.baseline_context = {
    spec_ref: 'iterations/iter-001/baseline/gate-b-spec/spec.json',
    spec_sha256: createHash('sha256').update(readFileSync(baselineSpecPath)).digest('hex'),
    reused_answers: [],
    reused_question_dispositions: [],
  };
  writeJson(intakePath, intake);
  return activeSpecPath;
}

test('acceptance reviewer may inspect sealed evidence without gaining execution authority', () => {
  const canonical = readFileSync(
    path.join('.agents', 'agents', 'p2a-acceptance-reviewer.md'),
    'utf8',
  );
  assert.match(canonical, /capabilities:\n  - read\n  - search/);
  assert.match(canonical, /access: read-only/);
  assert.match(canonical, /read-only file inspection and search/);
  assert.match(canonical, /read-only shell commands are permitted for those inputs only/);
  assert.match(canonical, /Do not run product behavior, tests, builds, lint, typechecking, lifecycle, network/);
  assert.doesNotMatch(canonical, /Do not edit files, execute commands/);

  const codex = readFileSync(
    path.join('.codex', 'agents', 'p2a-acceptance-reviewer.toml'),
    'utf8',
  );
  assert.match(codex, /sandbox_mode = "read-only"/);
  assert.match(codex, /read-only shell commands are permitted for those inputs only/);

  const claude = readFileSync(
    path.join('.claude', 'agents', 'p2a-acceptance-reviewer.md'),
    'utf8',
  );
  assert.match(claude, /tools:\n  - Read\n  - Grep\n  - Glob/);

  const gemini = readFileSync(
    path.join('.gemini', 'agents', 'p2a-acceptance-reviewer.md'),
    'utf8',
  );
  assert.match(gemini, /tools:\n  - read_file\n  - grep_search/);
});

test('iteration acceptance criteria keep current refs while excluding baseline behavior', () => {
  const baselineProduct = {
    core_flows: ['existing flow', 'duplicate flow'],
    success_criteria: ['existing result'],
  };
  const product = {
    core_flows: ['existing flow', 'new flow', 'duplicate flow', 'duplicate flow'],
    success_criteria: ['existing result', 'new result'],
  };

  assert.deepEqual(iterationAcceptanceCriteria(product, baselineProduct), [
    { ref: 'product.core_flows[1]', text: 'new flow' },
    { ref: 'product.core_flows[3]', text: 'duplicate flow' },
    { ref: 'product.success_criteria[1]', text: 'new result' },
  ]);
  assert.equal(iterationAcceptanceCriteria(product).length, 6);
});

test('acceptance contract scopes a direct prior-spec baseline to the current iteration', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'p2a-acceptance-direct-baseline-'));
  const artifactRoot = path.join(root, 'artifacts', 'cache-library');
  const baselineRoot = path.join(artifactRoot, 'iterations', 'v1');
  const activeRoot = path.join(artifactRoot, 'iterations', 'v2');
  try {
    const baselineIntake = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'intake.answered.json'),
      'utf8',
    ));
    const baselineSpec = JSON.parse(readFileSync(
      path.join(FIXTURE_ROOT, 'cache-library', 'spec.approved.json'),
      'utf8',
    ));
    baselineSpec.source_intake = '../gate-a-intake/intake.json';
    const baselineIntakePath = path.join(baselineRoot, 'gate-a-intake', 'intake.json');
    const baselineSpecPath = path.join(baselineRoot, 'gate-b-spec', 'spec.json');
    writeJson(baselineIntakePath, baselineIntake);
    writeJson(baselineSpecPath, baselineSpec);

    const activeIntake = structuredClone(baselineIntake);
    activeIntake.baseline_context = {
      spec_ref: 'iterations/v1/gate-b-spec/spec.json',
      spec_sha256: createHash('sha256').update(readFileSync(baselineSpecPath)).digest('hex'),
      reused_answers: [],
      reused_question_dispositions: [],
    };
    const activeIntakePath = path.join(activeRoot, 'gate-a-intake', 'intake.json');
    writeJson(activeIntakePath, activeIntake);

    const activeSpec = structuredClone(baselineSpec);
    activeSpec.product.core_flows.push('The user executes the new v2 behavior.');
    activeSpec.product.success_criteria.push('The new v2 behavior is observable.');
    const activeSpecPath = path.join(activeRoot, 'gate-b-spec', 'spec.json');
    writeJson(activeSpecPath, activeSpec);

    assert.deepEqual(acceptanceReviewContract(activeSpecPath, artifactRoot), {
      required: true,
      criteria: [
        {
          ref: `product.core_flows[${baselineSpec.product.core_flows.length}]`,
          text: 'The user executes the new v2 behavior.',
        },
        {
          ref: `product.success_criteria[${baselineSpec.product.success_criteria.length}]`,
          text: 'The new v2 behavior is observable.',
        },
      ],
    });
    assert.equal(
      acceptanceReviewContract(activeSpecPath, artifactRoot, { scope: 'full' }).criteria.length,
      baselineSpec.product.core_flows.length + baselineSpec.product.success_criteria.length + 2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an acceptance-on iteration with no new behavior criteria skips the inapplicable review', () => {
  const fixture = managedNonUiIteration();
  try {
    const activeSpecPath = addIdenticalCurrentIterationBaseline(fixture);
    assert.throws(
      () => acceptanceReviewContract(activeSpecPath, fixture.artifactRoot),
      /at least one current-iteration core flow or success criterion/,
    );
    assert.deepEqual(
      acceptanceReviewContract(activeSpecPath, fixture.artifactRoot, { allowEmpty: true }),
      { required: true, criteria: [] },
    );
    assert.equal(validateCloseReadyAcceptanceEvidence({
      artifactRoot: fixture.artifactRoot,
      activeIteration: 'iter-001',
      taskGraphPath: fixture.graphPath,
      taskGraph: fixture.graph,
      reviewPasses: { acceptance: 'on' },
    }), 0);

    writeJson(path.join(fixture.workspaceRoot, '.plan2agent', 'project.config.json'), {
      devExecution: { reviewPasses: { acceptance: 'on' } },
    });
    const next = runP2a([
      'next', '--target', fixture.workspaceRoot, '--json', '--contract', 'v2',
    ]);
    assert.equal(next.status, 0, `${next.stdout}\n${next.stderr}`);
    assert.equal(JSON.parse(next.stdout).state, 'final_verification_required');
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('execute accept uses the current-iteration delta instead of cumulative current contract acceptance', () => {
  const fixture = managedNonUiIteration();
  try {
    const { activeSpec, baselineSpec } = addCurrentIterationBaseline(fixture);
    const currentContract = JSON.parse(readFileSync(
      path.join(fixture.artifactRoot, 'current-development-contract.json'),
      'utf8',
    ));
    assert.equal(
      currentContract.acceptance.length,
      activeSpec.product.core_flows.length + activeSpec.product.success_criteria.length,
    );

    const runId = 'run-current-iteration-acceptance';
    const result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.deepEqual(run.acceptanceReview.criteria, [
      {
        ref: `product.core_flows[${baselineSpec.product.core_flows.length}]`,
        text: activeSpec.product.core_flows.at(-1),
      },
      {
        ref: `product.success_criteria[${baselineSpec.product.success_criteria.length}]`,
        text: activeSpec.product.success_criteria.at(-1),
      },
    ]);
    assert.doesNotMatch(JSON.stringify(run.acceptanceReview), /current\.acceptance/);

    const cumulativeRun = structuredClone(run);
    cumulativeRun.acceptanceReview = acceptanceReviewContract(
      path.join(fixture.artifactRoot, 'iterations', 'iter-001', 'gate-b-spec', 'spec.json'),
      fixture.artifactRoot,
      { scope: 'full' },
    );
    assert.throws(
      () => validateRunTaskContract(cumulativeRun, fixture.artifactRoot, {
        runsDir: path.join(fixture.artifactRoot, 'runs'),
      }),
      /acceptanceReview must match the approved current-iteration behavior contract/,
    );

    const legacyRun = structuredClone(run);
    legacyRun.acceptanceReview = {
      required: true,
      criteria: currentContract.acceptance.map((text, index) => ({
        ref: `current.acceptance[${index}]`,
        text,
      })),
    };
    assert.doesNotThrow(() => validateRunTaskContract(legacyRun, fixture.artifactRoot, {
      runsDir: path.join(fixture.artifactRoot, 'runs'),
    }));
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance review schema rejects manual or unexecuted evidence', () => {
  const base = {
    schema_version: 'p2a.acceptance_review.v1',
    iteration_id: 'v1-mvp',
    source_spec_ref: 'iterations/v1-mvp/gate-b-spec/spec.json',
    cases: [{
      criterion_ref: 'product.success_criteria[0]',
      command: 'node bin/weekly-digest.js --days 7',
      source: 'command',
      exitCode: 0,
      stdoutTail: '1 commit',
      verdict: 'pass',
    }],
    verdict: 'confirm_behavior',
    unmet: [],
  };
  assert.throws(
    () => validateAcceptanceReviewData({
      ...base,
      cases: [{ ...base.cases[0], source: 'manual' }],
    }),
    /source must be one of/,
  );
  assert.throws(
    () => validateAcceptanceReviewData({
      ...base,
      cases: [{ ...base.cases[0], exitCode: null }],
    }),
    /exitCode must be integer/,
  );
});

test('execute accept seals real command evidence and gates close-ready validation', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-final-acceptance-review';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'gemini',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /final functional acceptance review/);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const runPath = runFilePath(runsDir, runId);
    let run = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(run.runKind, 'final_acceptance_review');
    assert.equal(run.isolation.mode, 'none');
    assert.deepEqual(run.changedFiles, []);
    assert.ok(run.acceptanceReview.criteria.length > 0);
    assert.match(result.stdout, new RegExp(`criteria: ${run.acceptanceReview.criteria.length}`));
    assert.match(result.stdout, /candidateEvidence: 0/);
    assert.match(result.stdout, /Do not substitute the cumulative product spec or a summarized subset/);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', "custom:node -e \"console.log('0 commits')\"",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    const verification = run.verification.at(-1);
    assert.equal(verification.exitCode, 0);
    assert.equal(verification.source, 'command');

    result = runExecute([
      'resume',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /candidateEvidence: 1/);

    const sidecarPath = runSidecarPath(runsDir, runId, '.acceptance-review.json');
    writeJson(sidecarPath, acceptanceSidecar(run, verification, { block: true }));
    result = runExecute(['finish', '--artifacts', fixture.artifactRoot, '--run-id', runId]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /acceptance review blocked/);
    assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).status, 'started');

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--test-command', "node -e \"console.log('full suite passed')\"",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', "custom:node -e \"console.log('behavior confirmed for configured identity')\"",
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    writeJson(sidecarPath, acceptanceSidecar(run, run.verification.at(-1)));

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    run = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(run.status, 'finished');
    assert.match(run.acceptanceReviewEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(validateRunsDir(runsDir).projectId, 'webhook-api-service');

    result = runIteration([
      'validate',
      '--artifacts', fixture.artifactRoot,
      '--require-close-ready',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const stalePath = path.join(fixture.workspaceRoot, 'src', 'changed-after-acceptance.js');
    mkdirSync(path.dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, 'export const stale = true;\n', 'utf8');
    result = runIteration([
      'validate',
      '--artifacts', fixture.artifactRoot,
      '--require-close-ready',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /canonical workspace revision/);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('a failed product command cannot be hidden by an environment_failure label', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-misclassified-environment-acceptance';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:node -e "process.exit(1)"',
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--status', 'failed',
      '--failure-class', 'environment_failure',
      '--repro-command', 'node -e "process.exit(1)"',
      '--localization', 'The recorded product behavior command executed and failed.',
      '--guard', 'Reopen implementation when any recorded verification has status failed.',
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Reopening task task-001 after failed final acceptance review/);

    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks.find((task) => task.id === 'task-001').status, 'todo');
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('a blocking acceptance verdict overrides unrelated unavailable environment evidence', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-blocking-review-with-unavailable-evidence';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const runsDir = path.join(fixture.artifactRoot, 'runs');
    const runPath = runFilePath(runsDir, runId);
    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:node -e "console.log(\'reviewed behavior\')"',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    let run = JSON.parse(readFileSync(runPath, 'utf8'));
    writeJson(
      runSidecarPath(runsDir, runId, '.acceptance-review.json'),
      acceptanceSidecar(run, run.verification.at(-1), { block: true }),
    );

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:/definitely/missing-p2a-environment-command',
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Blocking final acceptance review evidence overrides/);
    assert.match(result.stdout, /Reopening task task-001 after failed final acceptance review/);

    run = JSON.parse(readFileSync(runPath, 'utf8'));
    assert.equal(run.failure.class, 'implementation_incomplete');
    assert.equal(
      JSON.parse(readFileSync(fixture.graphPath, 'utf8')).tasks
        .find((task) => task.id === 'task-001').status,
      'todo',
    );

    run.failure.class = 'environment_failure';
    writeJson(runPath, run);
    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    graph.tasks.find((task) => task.id === 'task-001').status = 'done';
    writeJson(fixture.graphPath, graph);
    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Reopening task task-001 after failed final acceptance review/);
    assert.equal(
      JSON.parse(readFileSync(fixture.graphPath, 'utf8')).tasks
        .find((task) => task.id === 'task-001').status,
      'todo',
    );
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('blocked acceptance review reopens its remediation owner', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-blocked-acceptance-review';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'gemini',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /--no-task-transition/);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--status', 'blocked',
      '--failure-class', 'implementation_incomplete',
      '--repro-step', 'Run the Gate B behavior command and observe that the expected behavior is absent.',
      '--localization', 'The integrated behavior does not satisfy the acceptance review criterion.',
      '--guard', 'Correct the behavior before starting another final acceptance review.',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Reopening task task-001 after blocked final acceptance review/);

    const graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks.find((task) => task.id === 'task-001').status, 'todo');
    const run = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(run.status, 'blocked');
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('environment-only acceptance failure keeps the task done for a final-review retry', () => {
  const fixture = managedNonUiIteration();
  try {
    const runId = 'run-environment-acceptance-review';
    let result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', runId,
      '--agent-tool', 'codex',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runRuns([
      'verify',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--verify-command', 'custom:/definitely/missing-p2a-environment-command',
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

    result = runExecute([
      'finish',
      '--artifacts', fixture.artifactRoot,
      '--run-id', runId,
      '--status', 'failed',
    ]);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /classified as environment_failure/);
    assert.match(result.stdout, /remains done after final acceptance environment failure/);
    assert.match(result.stdout, /Retry only the final acceptance run/);

    const failedRun = JSON.parse(readFileSync(
      runFilePath(path.join(fixture.artifactRoot, 'runs'), runId),
      'utf8',
    ));
    assert.equal(failedRun.failure.class, 'environment_failure');
    assert.equal(failedRun.verification.at(-1).status, 'unavailable');
    assert.ok(failedRun.reproduction.commands.length > 0);
    assert.ok(failedRun.localization.findings.length > 0);
    assert.ok(failedRun.guard.checks.length > 0);

    let graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks.find((task) => task.id === 'task-001').status, 'done');

    result = runExecute([
      'accept',
      '--artifacts', fixture.artifactRoot,
      '--task', 'task-001',
      '--run-id', 'run-environment-acceptance-retry',
      '--agent-tool', 'codex',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    graph = JSON.parse(readFileSync(fixture.graphPath, 'utf8'));
    assert.equal(graph.tasks.find((task) => task.id === 'task-001').status, 'done');
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance policy off preserves the previous non-UI close behavior', () => {
  const fixture = managedNonUiIteration();
  try {
    assert.equal(validateCloseReadyAcceptanceEvidence({
      artifactRoot: fixture.artifactRoot,
      activeIteration: 'iter-001',
      taskGraphPath: fixture.graphPath,
      taskGraph: fixture.graph,
      reviewPasses: { acceptance: 'off' },
    }), 0);
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('acceptance opt-in does not add a review until one is explicitly started', () => {
  const fixture = managedNonUiIteration();
  try {
    for (const reviewPasses of [{ acceptance: 'opt_in' }, {}]) {
      assert.equal(validateCloseReadyAcceptanceEvidence({
        artifactRoot: fixture.artifactRoot,
        activeIteration: 'iter-001',
        taskGraphPath: fixture.graphPath,
        taskGraph: fixture.graph,
        reviewPasses,
      }), 0);
    }
  } finally {
    rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});
