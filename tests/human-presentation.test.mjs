import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { renderNextHuman } from '../scripts/p2a.mjs';
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

  assert.equal(output, `Plan2Agent next

[한눈에]
지금 결정하는 것: Readers cannot tell what they are approving. Show the decision and both outcomes before technical details.
승인하면 → 이 계획 안에서 구현과 검증을 시작합니다.
거부하면 → 계획을 수정한 뒤 다시 확인합니다.

[실행 명령]
  p2a decide --quote "<사용자가 실제로 승인한 문장>" --artifacts "/workspace/demo"

[세부 계약]
- target: /workspace/demo
- projectId: demo
- state: gate_b_needs_approval
- reason: The Gate ① specification decision is not approved or has been revoked.
`);
  assert.equal(`${JSON.stringify(payload, null, 2)}\n`, before);
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

  assert.equal(output, `Plan2Agent next

[한눈에]
지금 결정하는 것: 사용자가 승인할 범위와 제외할 범위를 먼저 분명하게 보여줍니다.
승인하면 → 이 범위로 개발 계획을 작성합니다.
거부하면 → 범위를 수정한 뒤 다시 확인합니다.

[실행 명령]
  p2a decide --quote "<사용자가 실제로 승인한 문장>" --artifacts "/workspace/demo"

[세부 계약]
- target: /workspace/demo
- projectId: demo
- state: gate_a_needs_approval
- reason: The product scope decision still needs approval.
`);
  const atAGlance = output.split('\n[실행 명령]\n', 1)[0];
  assert.doesNotMatch(atAGlance, /Gate|constitution|spec|reasonCode|approval audit/u);
});

test('Gate ② next rendering keeps system terminology below the approval command', () => {
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

  assert.equal(output, `Plan2Agent next

[한눈에]
지금 결정하는 것: demo에서 개발하는 동안 계속 지킬 공통 원칙입니다.
승인하면 → 이 원칙을 기준으로 개발 계획을 구체화합니다.
거부하면 → 원칙을 수정한 뒤 다시 확인합니다.

[실행 명령]
  p2a shape approve --quote "<사용자가 실제로 승인한 문장>"

[세부 계약]
- target: /workspace/demo
- projectId: demo
- state: shape
- reason: The Gate ② project constitution still needs approval.
`);
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
  assert.ok(
    result.stdout.indexOf('운영자는 서명된 웹훅을 안전하게 접수할 수 있습니다.')
      < result.stdout.indexOf('- state: ready_task_available'),
  );
});
