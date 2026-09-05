import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { completionEvidenceRuns, renderNextHuman } from '../scripts/p2a.mjs';
import { approvedSpecTaskIntent } from '../scripts/p2a_execute.mjs';
import { renderShapeHuman } from '../scripts/p2a_shape.mjs';
import {
  EXPLICIT_INTAKE_MARKDOWN_MARKER,
  renderImplementationPlanMarkdown,
  renderIntakeMarkdown,
  renderProductSpecMarkdown,
  semanticTaskIntent,
} from '../scripts/p2a_iteration.mjs';
import { taskContractSha256 } from '../scripts/p2a_run_paths.mjs';
import { validateTaskGraphData } from '../scripts/validate_artifacts.mjs';
import { FIXTURE_ROOT, makeTempDir, runP2a } from './helpers/fixtures.mjs';

function fixtureJson(relativePath) {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, relativePath), 'utf8'));
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('human next approval rendering is layered without changing the v2 payload', () => {
  const payload = {
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-24T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'gate_b_needs_approval',
    reasonCode: 'gate_b_needs_approval',
    reason: 'The Gate ① specification decision is not approved or has been revoked.',
    continuation: null,
    command: {
      kind: 'approval',
      display: 'Review /workspace/demo/spec.json, then run p2a decide --quote "<user utterance>" --artifacts "/workspace/demo".',
    },
  };
  const before = `${JSON.stringify(payload, null, 2)}\n`;
  const output = renderNextHuman(payload, {
    spec: {
      product: {
        problem: 'Readers cannot tell what they are approving.',
        goals: ['Show the decision and both outcomes before technical details.'],
      },
    },
  });

  assert.match(output, /^Plan2Agent\n\n\[At a glance\]/u);
  assert.match(output, /Readers cannot tell what they are approving/u);
  assert.match(output, /\[Recommended next action\]\nApprove if this understanding is correct/u);
  assert.doesNotMatch(output, /Gate|gate_b|\/workspace\/demo|p2a decide|state:|reason:|[가-힣]/u);
  const detailed = renderNextHuman(payload, {}, { details: true });
  assert.match(detailed, /\[내부 실행 정보\]/u);
  assert.match(detailed, /p2a decide --quote "<사용자가 실제로 승인한 문장>"/u);
  assert.match(detailed, /state: gate_b_needs_approval/u);
  assert.equal(`${JSON.stringify(payload, null, 2)}\n`, before);
});

test('human next gives state-specific requests instead of generic approval language', () => {
  const base = {
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-29T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    continuation: null,
  };
  const cases = [
    {
      state: 'entry_missing',
      reason: 'The harness is installed; provide a concise idea or entry document.',
      command: { kind: 'approval', display: 'Run p2a next --idea "<what to build>".' },
      expected: /만들거나 고칠 내용을 한두 문장으로 알려주세요/u,
    },
    {
      state: 'entry_invalid',
      reason: 'The entry document did not validate.',
      command: { kind: 'approval', display: 'Fix the entry document.' },
      expected: /수정한 기획 문서를 다시 지정하거나/u,
    },
    {
      state: 'entry_deferred',
      reason: 'The new request is saved while approved work remains active.',
      command: { kind: 'approval', display: 'Continue or pause the current work.' },
      expected: /기존 범위로 계속할지, 새 요청에 맞춰 범위 변경을 논의할지/u,
    },
    {
      state: 'blocked_scope_replacement_ready',
      reason: 'The blocked scope can be replaced without closing the incomplete iteration.',
      command: {
        kind: 'cli',
        argv: ['iteration', 'replace-scope'],
        requiresApproval: true,
      },
      expected: /막힌 이력은 그대로 보존하고.*새 전체 범위 계획/u,
    },
    {
      state: 'started_run_contract_drift',
      reason: 'The recorded execution contract no longer matches the current development source.',
      command: { kind: 'approval', display: 'Restore the contract or close the run.' },
      expected: /실수인지 의도한 계획 변경인지/u,
    },
    {
      state: 'project_selection_required',
      reason: 'Multiple artifact roots are available (alpha, beta). Select one project explicitly.',
      command: { kind: 'cli', argv: ['next', '--project-id', '<project-id>'], requiresApproval: true },
      expected: /이어서 개발할 프로젝트 이름을 하나 알려주세요/u,
    },
    {
      state: 'iteration_complete',
      reason: 'The active iteration is closed.',
      command: { kind: 'cli', argv: ['iteration', 'open'], requiresApproval: true },
      expected: /다음 개발을 시작하려면 새 변경 내용을 알려주세요/u,
    },
  ];

  for (const scenario of cases) {
    const output = renderNextHuman({
      ...base,
      state: scenario.state,
      reasonCode: scenario.state,
      reason: scenario.reason,
      command: scenario.command,
    }, {});
    assert.match(output, scenario.expected, scenario.state);
    assert.doesNotMatch(output, /위 내용이 맞으면 승인|사용자의 권한이 필요/u, scenario.state);
  }
});

test('a bound next-iteration idea is acknowledged instead of requested again', () => {
  const idea = '결제 실패 재시도 화면을 추가해줘.';
  const output = renderNextHuman({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-30T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'iteration_complete',
    reasonCode: 'iteration_complete',
    reason: 'The active iteration is closed and the supplied request is ready.',
    continuation: null,
    command: {
      kind: 'cli',
      argv: ['iteration', 'open', '--artifacts', '.plan2agent/artifacts/demo', '--idea', idea],
      display: `p2a iteration open --idea ${JSON.stringify(idea)}`,
      requiresApproval: true,
    },
  }, {});

  assert.match(output, new RegExp(`다음 요청으로 저장된 내용: ${idea}`, 'u'));
  assert.match(output, /다시 입력하지 않고/u);
  assert.match(output, /저장된 다음 요청으로 새 개발 범위를 열어도 되는지/u);
  assert.doesNotMatch(output, /새 변경 내용을 알려|새로 만들거나 고칠 내용을 알려/u);
});

test('deferred and replacement routing explain the safety boundary in English', () => {
  const base = {
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-30T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    continuation: null,
  };
  const deferred = renderNextHuman({
    ...base,
    state: 'entry_deferred',
    reasonCode: 'entry_deferred',
    reason: 'The new request is saved while approved work remains active.',
    command: { kind: 'approval', display: 'Continue or pause.' },
  }, { requestIdea: 'Add a new operator dashboard.' });
  assert.match(deferred, /saved the new request/u);
  assert.match(deferred, /will not silently replace/u);
  assert.match(deferred, /continue the current scope or discuss changing it/u);

  const replacement = renderNextHuman({
    ...base,
    state: 'blocked_scope_replacement_ready',
    reasonCode: 'blocked_scope_replacement_ready',
    reason: 'The blocked scope can be replaced without closing the incomplete iteration.',
    command: {
      kind: 'cli',
      argv: ['iteration', 'replace-scope'],
      requiresApproval: true,
    },
  }, { requestIdea: 'Replace the payment contract.' });
  assert.match(replacement, /keeping the incomplete task graph and run evidence unchanged/u);
  assert.match(replacement, /old work is not marked complete/u);
  assert.match(replacement, /explicit approval is required/u);
});

test('automatic planning transitions explain the next product-facing step', () => {
  const expected = new Map([
    ['gate_a_ready_for_spec', /개발 계획으로 정리합니다/u],
    ['gate_b_approved_needs_execution_prepare', /진행 방식을 준비한 뒤 구현을 시작합니다/u],
    ['gate_b_approved_needs_tasks', /작업 순서와 서로 의존하는 부분/u],
    ['gate_c_validated_needs_iteration_init', /추가 승인 없이 첫 작업을 시작합니다/u],
  ]);
  for (const [state, pattern] of expected) {
    const output = renderNextHuman({
      schema_version: 'p2a.next.v2',
      generatedAt: '2026-08-30T00:00:00.000Z',
      target: '/workspace/demo',
      projectId: 'demo',
      state,
      reasonCode: state,
      reason: 'An automatic transition is ready.',
      continuation: null,
      command: {
        kind: 'skill',
        skill: 'p2a-dev-execution',
        args: [],
        display: '/p2a-dev-execution',
      },
    }, {});
    assert.match(output, pattern, state);
    assert.doesNotMatch(output, /다음 단계로 진행하려면 아래 안내/u, state);
  }
});

test('completion evidence keeps reusable product checks beside a relevant-only final check', () => {
  const implementation = {
    runId: 'run-implementation',
    verification: [{
      type: 'test',
      command: 'npm test',
      scope: 'full',
      status: 'passed',
      exitCode: 0,
      source: 'config',
    }],
  };
  const relevant = {
    runId: 'run-final-relevant',
    runKind: 'final_verification',
    verificationScope: 'relevant',
    verification: [{
      type: 'custom',
      command: 'docs-check',
      scope: 'related',
      status: 'passed',
      exitCode: 0,
      source: 'command',
    }],
  };

  assert.deepEqual(
    completionEvidenceRuns([implementation, relevant]).map((run) => run.runId),
    ['run-implementation', 'run-final-relevant'],
  );
});

test('completion evidence prefers the newest full pass regardless of run kind', () => {
  const fullPass = {
    type: 'test',
    command: 'npm test',
    scope: 'full',
    status: 'passed',
    exitCode: 0,
    source: 'config',
  };
  const olderFinal = {
    runId: 'run-older-final',
    runKind: 'final_verification',
    verificationScope: 'full',
    verification: [fullPass],
  };
  const currentImplementation = {
    runId: 'run-current-implementation',
    verification: [{ ...fullPass, command: 'npm run test:current' }],
  };

  assert.deepEqual(
    completionEvidenceRuns([olderFinal, currentImplementation]).map((run) => run.runId),
    ['run-current-implementation'],
  );
  assert.deepEqual(
    completionEvidenceRuns([olderFinal, currentImplementation], {
      run: olderFinal,
      relevantRun: null,
    }).map((run) => run.runId),
    ['run-older-final'],
  );
});

test('completion copy separates review, fixes, and retrospective outcomes in both languages', () => {
  const next = {
    state: 'iteration_review_or_close_required',
    command: {
      kind: 'approval',
      options: ['review', 'retrospective', 'close'].map((id) => ({ id, label: id })),
    },
  };
  for (const [problem, fixBoundary, reportBoundary] of [
    ['Make the development workflow simpler.', /fix them only when requested/, /needs no repeated approval/],
    ['개발 절차를 간결하게 만든다.', /수정은 요청한 경우에만/, /같은 요청을 재승인받지 않고/],
  ]) {
    const output = renderNextHuman(next, {
      spec: { product: { problem } },
      completion: { verificationCurrent: true },
    });
    assert.match(output, fixBoundary);
    assert.match(output, reportBoundary);
    assert.doesNotMatch(output, /fix important findings|문제가 있으면 수정하고|회고 진행 여부를 묻습니다/);
  }
});

test('completion rendering does not recommend close when its readiness recheck is stale', () => {
  const next = {
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-30T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'iteration_review_or_close_required',
    reasonCode: 'iteration_review_or_close_required',
    reason: 'All tasks and review gates are complete.',
    continuation: null,
    command: {
      kind: 'approval',
      options: [
        { id: 'review', label: 'Review' },
        { id: 'retrospective', label: 'Retrospective' },
        { id: 'close', label: 'Close' },
      ],
    },
  };
  const before = JSON.stringify(next);
  const output = renderNextHuman(next, {
    completion: {
      verificationCurrent: false,
      outcomes: ['요청한 기능 구현'],
      changedFiles: ['src/feature.js'],
      verification: [{
        type: 'test',
        command: 'npm test',
        status: 'passed',
        exitCode: 0,
        source: 'config',
      }],
    },
  });

  assert.match(output, /이전 검증을 최신 근거로 표시하지 않습니다/u);
  assert.match(output, /현재 검증 범위를 다시 계산/u);
  assert.doesNotMatch(output, /개발이 끝났습니다|통과한 확인|검증 증거가 최신|종료\(권장\)/u);
  assert.equal(JSON.stringify(next), before, 'human fallback must not mutate the JSON contract');
});

test('Gate A approval rendering states the scope decision without system terminology', () => {
  const output = renderNextHuman({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-24T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'gate_a_needs_approval',
    reasonCode: 'gate_a_needs_approval',
    reason: 'The product scope decision still needs approval.',
    continuation: null,
    command: {
      kind: 'approval',
      display: 'Review /workspace/demo/intake.json, then run p2a decide --quote "<user utterance>" --artifacts "/workspace/demo".',
    },
  }, {
    intake: { summary: '사용자가 승인할 범위와 제외할 범위를 먼저 분명하게 보여줍니다.' },
  });

  assert.match(output, /지금 결정하는 것: 사용자가 승인할 범위와 제외할 범위를 먼저 분명하게 보여줍니다/u);
  assert.match(output, /\[권장 다음 행동\]/u);
  assert.doesNotMatch(output, /Gate|constitution|spec|reasonCode|approval audit|gate_a|\/workspace/u);
});

test('human next explains unresolved planning decisions without asking for approval', () => {
  const output = renderNextHuman({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-29T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'gate_b_needs_decisions',
    reasonCode: 'gate_b_needs_decisions',
    reason: 'The draft development plan still has material open decisions.',
    continuation: null,
    command: {
      kind: 'skill',
      skill: 'p2a-spec',
      args: [],
      display: '/p2a-spec',
      requiresApproval: false,
    },
  }, {});

  assert.match(output, /중요한 내용이 남아 있습니다/u);
  assert.match(output, /결정이 반영된 전체 계획/u);
  assert.doesNotMatch(output, /승인한다고 답해주세요|Gate|gate_b/u);
});

test('material project-shape approval stays conversational unless details are requested', () => {
  const output = renderNextHuman({
    schema_version: 'p2a.next.v2',
    generatedAt: '2026-08-24T00:00:00.000Z',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'shape',
    reasonCode: 'shape',
    reason: 'The Gate ② project constitution still needs approval.',
    continuation: null,
    command: {
      kind: 'approval',
      display: 'Review /workspace/demo/.plan2agent/constitution.json, then run p2a shape approve --quote "<user utterance>".',
    },
  });

  assert.match(output, /계속 지킬 공통 원칙/u);
  assert.doesNotMatch(output, /Gate|constitution|state: shape|p2a shape/u);
  const detailed = renderNextHuman({
    schema_version: 'p2a.next.v2',
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'shape',
    reason: 'The Gate ② project constitution still needs approval.',
    command: {
      kind: 'approval',
      display: 'Run p2a shape approve --quote "<user utterance>".',
    },
  }, {}, { details: true });
  assert.match(detailed, /p2a shape approve/u);
  assert.match(detailed, /state: shape/u);
});

test('shape draft rendering explains the decision before its technical contract', () => {
  const output = renderShapeHuman({
    target: '/workspace/demo',
    projectId: 'demo',
    state: 'draft',
    constitution: '.plan2agent/constitution.json',
    approved: false,
    legacyStyle: false,
    counts: { architecture: 2, stack: 1, prohibitions: 3 },
    next: 'Review the Gate ② draft, then run p2a shape approve --quote "<user utterance>".',
  });

  assert.equal(output, `Plan2Agent shape

[한눈에]
지금 결정하는 것: demo에서 개발하는 동안 계속 지킬 공통 원칙입니다.
승인하면 → 이 원칙을 기준으로 개발 계획을 구체화합니다.
거부하면 → 원칙을 수정한 뒤 다시 확인합니다.

[실행 명령]
  p2a shape approve --quote "<사용자가 실제로 승인한 문장>"

[세부 계약]
- target: /workspace/demo
- state: draft
- constitution: .plan2agent/constitution.json
- projectId: demo
- rules: architecture=2 stack=1 prohibitions=3
- legacy style.md: absent
- next: Review the Gate ② draft, then run p2a shape approve --quote "<user utterance>".
`);
});

test('generated Gate Markdown starts with a deterministic at-a-glance section', () => {
  const intake = fixtureJson('cache-library/intake.answered.json');
  const spec = fixtureJson('cache-library/spec.approved.json');
  const intakeMarkdown = renderIntakeMarkdown(intake, { explicitExport: true });
  const productMarkdown = renderProductSpecMarkdown(spec, {
    iterationId: 'v1',
    idea: intake.idea,
    baselineSpecRef: 'none',
  });
  const implementationMarkdown = renderImplementationPlanMarkdown(spec, {
    iterationId: 'v1',
    idea: intake.idea,
    baselineSpecRef: 'none',
  });

  assert.ok(intakeMarkdown.startsWith(
    `${EXPLICIT_INTAKE_MARKDOWN_MARKER}\n\n# Intake\n\n## [한눈에]\n\n${intake.summary}\n\n`
      + '```text\n요청 → 범위 확인 → 개발 계획 작성\n```\n',
  ));
  assert.ok(productMarkdown.startsWith(
    `# Product Spec\n\n## [한눈에]\n\n${spec.product.problem}\n\n${spec.product.goals[0]}\n\n`
      + '```text\n사용자 문제 → 이번에 만들 결과 → 성공 기준 확인\n```\n',
  ));
  assert.ok(implementationMarkdown.startsWith(
    `# Implementation Plan\n\n## [한눈에]\n\n이번 개발이 만드는 결과: ${intake.idea}\n\n`
      + '```text\n승인한 목표 → 구현 → 자동 확인 → 완료\n```\n',
  ));
  assert.equal(renderIntakeMarkdown(intake, { explicitExport: true }), intakeMarkdown);
  assert.equal(renderProductSpecMarkdown(spec, {
    iterationId: 'v1',
    idea: intake.idea,
    baselineSpecRef: 'none',
  }), productMarkdown);
  assert.equal(renderImplementationPlanMarkdown(spec, {
    iterationId: 'v1',
    idea: intake.idea,
    baselineSpecRef: 'none',
  }), implementationMarkdown);
});

test('task intent is optional, human-first, and excluded from completion contracts', (t) => {
  const graph = fixtureJson('cache-library/task-graph.json');
  const task = graph.tasks[0];
  delete task.intent;
  assert.doesNotThrow(() => validateTaskGraphData(graph));
  const legacyContract = taskContractSha256(task);

  task.intent = 'Library users can store values with predictable expiration behavior.';
  assert.doesNotThrow(() => validateTaskGraphData(graph));
  assert.equal(taskContractSha256(task), legacyContract);
  task.intent = 'A different human explanation does not change completion evidence.';
  assert.equal(taskContractSha256(task), legacyContract);
  task.intent = 'Library users can store values with predictable expiration behavior.';

  const root = makeTempDir('p2a-human-task-intent-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const graphPath = join(root, 'task-graph.json');
  writeJson(graphPath, graph);

  const list = runP2a(['tasks', 'list', '--graph', graphPath]);
  assert.equal(list.status, 0, `${list.stdout}${list.stderr}`);
  assert.match(list.stdout, /^id\tintent\tstatus\tdependencies\tready/mu);
  assert.match(list.stdout, /Library users can store values with predictable expiration behavior\./u);

  const show = runP2a(['tasks', 'show', '--graph', graphPath, task.id]);
  assert.equal(show.status, 0, `${show.stdout}${show.stderr}`);
  assert.equal(show.stdout, `${JSON.stringify({ intent: task.intent, ...task }, null, 2)}\n`);
});

test('generated task intent follows the approved product language', () => {
  const koreanSpec = {
    product: {
      goals: ['사용자가 승인 내용을 이해한 뒤 선택할 수 있게 한다'],
    },
  };
  assert.equal(
    approvedSpecTaskIntent(koreanSpec, 'fallback'),
    '사용자는 이 작업이 끝나면 다음 결과를 사용할 수 있습니다: 사용자가 승인 내용을 이해한 뒤 선택할 수 있게 한다.',
  );
  assert.equal(
    semanticTaskIntent({ areaId: 'ui', label: 'user-facing workflow and view' }, [], 'ko'),
    '사용자는 승인된 사용자 화면과 흐름 결과를 사용할 수 있습니다.',
  );
  assert.equal(
    semanticTaskIntent({ areaId: 'security', label: 'security and authorization' }, [{}], 'ko'),
    '사용자는 승인된 보안과 권한 처리 결과가 안전하게 갱신되었다고 믿고 사용할 수 있습니다.',
  );
});

test('p2a next loads and renders task intent before its technical state', (t) => {
  const root = makeTempDir('p2a-human-next-intent-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactRoot = join(root, '.plan2agent', 'artifacts', 'webhook-api-service');
  cpSync(join(FIXTURE_ROOT, '_e2e', 'webhook-api-service'), artifactRoot, { recursive: true });
  const graphPath = join(artifactRoot, 'gate-c-task-graph', 'task-graph.json');
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  graph.tasks[0].intent = '운영자는 서명된 웹훅을 안전하게 접수할 수 있습니다.';
  writeJson(graphPath, graph);

  const result = runP2a([
    'next',
    '--target', root,
    '--project-id', 'webhook-api-service',
  ]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /\[한눈에\]\n다음에 할 일: 운영자는 서명된 웹훅을 안전하게 접수할 수 있습니다\./u);
  assert.match(result.stdout, /\[권장 다음 행동\]/u);
  assert.doesNotMatch(result.stdout, /state: ready_task_available|gate-c-task-graph|--artifacts/u);
});
