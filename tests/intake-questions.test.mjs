import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deltaClarifyingQuestions,
  greenfieldClarifyingQuestions,
} from '../scripts/p2a_intake_questions.mjs';

test('a sufficiently bounded idea produces no ceremonial clarifying questions', () => {
  const greenfield = greenfieldClarifyingQuestions(
    '초보자가 릴리스 오류를 확인할 수 있도록 첫 버전에는 오류 목록만 포함하고 설정 화면은 제외하며, 목록 표시 테스트가 통과하면 완료한다.',
  );
  const delta = deltaClarifyingQuestions(
    '현재 검색 결과에서 문서 경로만 표시하고 코드 결과는 그대로 유지하며 관련 경로 테스트가 통과하면 완료한다.',
  );
  assert.deepEqual(greenfield, []);
  assert.deepEqual(delta, []);
});

test('one material boundary question replaces overlapping outcome and scope questions', () => {
  const questions = deltaClarifyingQuestions('OAuth 연동을 개선한다.');
  assert.equal(questions.length, 1);
  assert.deepEqual(questions.map((item) => item.id), ['CQ-1']);
  assert.match(questions[0].question, /인증 방식|호환성/u);
});

test('specific Korean delta requests infer the smallest baseline-preserving change', () => {
  const ideas = [
    'API 응답 캐시 TTL을 60초로 변경',
    '기존 로그인 API 오류 메시지를 한국어로 변경',
    '로그인 API 오류 메시지를 한국어로 바꿔줘',
    '로그인 API 오류 메시지만 한국어로 바꿔줘',
    '인증 오류 메시지를 한국어로 변경해줘',
    '결제 오류 메시지를 한국어로 변경해줘',
    '보안 안내 문구를 한국어로 변경해줘',
    'README 설치 예제를 최신 명령으로 변경',
  ];

  for (const idea of ideas) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('specific values remain concrete while generic action-only requests ask for missing bounds', () => {
  for (const idea of [
    'package.json 버전을 0.5.20으로 올려줘',
    '캐시 TTL을 60초로 맞춰줘',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }

  for (const idea of [
    'Update the app',
    'Can you update the app',
    'Update login',
    'Update API',
    'Update UI',
    'Explore a change that should not ship',
    '앱을 변경해줘',
    'API를 변경해줘',
    'API를 바꿔줘',
    '로그인을 바꿔줘',
    '화면을 변경해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 2, idea);
    assert.ok(questions.some((item) => item.blocks.includes('spec.product.success_criteria')));
    assert.ok(questions.some((item) => item.blocks.includes('spec.product.goals')));
  }
});

test('an auxiliary test clause does not make a vague product request concrete', () => {
  for (const idea of [
    'Improve the dashboard and add regression tests',
    '대시보드를 개선하고 테스트를 추가해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.ok(questions.length > 0, idea);
    assert.equal(
      questions.some((item) => item.blocks.includes('spec.product.goals')),
      true,
      idea,
    );
  }
});

test('a feature around an existing webhook does not imply an integration-boundary change', () => {
  assert.deepEqual(
    deltaClarifyingQuestions('Add follow-up webhook delivery dashboard'),
    [],
  );
  assert.deepEqual(
    deltaClarifyingQuestions('Add monitoring to the existing integration dashboard'),
    [],
  );
  assert.equal(
    deltaClarifyingQuestions('Add a new third-party webhook integration').length,
    1,
  );
});

test('Korean scope particles are recognized without an ASCII word boundary', () => {
  const questions = deltaClarifyingQuestions(
    '문서 경로만 보여주고 관련 테스트가 통과하면 완료한다.',
  );
  assert.equal(
    questions.some((item) => item.blocks.includes('spec.product.goals')),
    false,
  );
});

test('a consequential but ambiguous authentication change asks one decision', () => {
  for (const idea of [
    '로그인 방식을 개선해줘.',
    'Update authentication method from sessions to JWT',
    '인증 방식을 세션에서 JWT로 업데이트해줘',
    '인증 방식을 JWT로 바꿔줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary');
    if (/[가-힣]/u.test(idea)) {
      assert.match(questions[0].question, /인증 방식|호환성/u);
    } else {
      assert.match(questions[0].question, /authentication|compatibility/i);
    }
  }
});

test('adding or removing a material system boundary asks one bounded decision', () => {
  for (const idea of [
    'Add a database',
    'Add PostgreSQL storage',
    'Remove OAuth authentication',
    '결제 연동을 삭제해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary');
    assert.ok(questions[0].blocks.includes('spec.implementation.dependencies'));
  }
});

test('mixed copy and security requests still ask only for the material boundary', () => {
  for (const idea of [
    '인증 문구와 인증 방식을 변경해줘',
    '인증 방식과 오류 문구를 변경해줘',
    '보안 안내 문구와 권한 구조를 변경해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary');
    assert.match(questions[0].question, /인증 방식|연동·권한·보안|호환성/u);
  }
});

test('a webhook dashboard layout change is not treated as an integration change', () => {
  assert.deepEqual(
    deltaClarifyingQuestions('웹훅 대시보드 레이아웃을 변경해줘'),
    [],
  );
});

test('a public API contract change remains a material boundary decision', () => {
  const questions = deltaClarifyingQuestions('공개 API 응답 구조를 변경해줘.');
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /공개 API|호환성/u);
});

test('API documentation and regression-test work do not imply an interface-boundary change', () => {
  for (const idea of [
    'Update API endpoint documentation',
    'Add a regression test for the login API endpoint',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('a data migration remains a material boundary decision', () => {
  assert.equal(deltaClarifyingQuestions('Migrate customer data to the new schema').length, 1);
  assert.equal(deltaClarifyingQuestions('고객 데이터 마이그레이션을 진행해줘.').length, 1);
});

test('migration execution remains material when a test clause comes first', () => {
  for (const idea of [
    'Test the database migration and then perform the migration',
    '데이터 마이그레이션 테스트하고 실제 마이그레이션을 진행해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary');
    assert.match(questions[0].question, /migrat|마이그레이션/i);
  }
});

test('migration documentation and regression tests do not imply a migration-boundary change', () => {
  for (const idea of [
    'Update documentation for the database migration',
    'Add a regression test for the existing database migration',
    '기존 데이터 마이그레이션 문서를 수정해줘',
    '기존 데이터 마이그레이션 회귀 테스트를 추가해줘',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('an explicit unchanged or excluded material boundary is not asked again', () => {
  const delta = deltaClarifyingQuestions(
    'Keep the approved OAuth integration unchanged; update only documentation and complete when its path test passes.',
  );
  const greenfield = greenfieldClarifyingQuestions(
    'Help developers verify releases with only the existing OAuth integration, no new integration, and pass the release-list test.',
  );
  assert.equal(delta.some((item) => /integration.*boundary/i.test(item.question)), false);
  assert.equal(greenfield.some((item) => /integration.*constraint/i.test(item.question)), false);

  const unrelatedExclusion = deltaClarifyingQuestions(
    'Improve the OAuth integration and exclude documentation; complete when the integration test passes.',
  );
  assert.equal(
    unrelatedExclusion.some((item) => item.decision_kind === 'material_boundary'),
    true,
  );

  const koreanUnrelatedExclusion = deltaClarifyingQuestions(
    '인증 방식을 변경하되 오류 문구는 제외해줘.',
  );
  assert.equal(koreanUnrelatedExclusion.length, 1);
  assert.equal(koreanUnrelatedExclusion[0].decision_kind, 'material_boundary');

  for (const idea of [
    'Do not change the OAuth integration; only update README.',
    'OAuth 통합은 변경하지 말고 README만 수정해줘.',
    '인증 방식은 건드리지 않고 로그인 오류 문구만 변경해줘.',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('a resolved boundary does not hide a second unresolved material boundary', () => {
  const delta = deltaClarifyingQuestions(
    'Only add a database migration while keeping the approved OAuth integration unchanged, and complete when the migration test passes.',
  );
  const greenfield = greenfieldClarifyingQuestions(
    'Help developers release safely by adding only a database migration while keeping OAuth unchanged, and complete when the migration test passes.',
  );

  assert.equal(
    delta.some((item) => item.decision_kind === 'material_boundary'),
    true,
  );
  assert.equal(
    greenfield.some((item) => item.decision_kind === 'material_boundary'),
    true,
  );
});

test('distinct unresolved material boundaries each produce one focused question', () => {
  for (const [idea, expectedQuestions] of [
    [
      '인증 방식을 JWT로 변경하고 데이터 저장소를 PostgreSQL로 변경해줘',
      [/인증 방식|로그인 호환성/u, /데이터|저장|보존/u],
    ],
    [
      'Replace session authentication with JWT and migrate customer data to PostgreSQL',
      [/authentication|login compatibility/i, /data will be migrated|compatibility/i],
    ],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, expectedQuestions.length, idea);
    assert.deepEqual(questions.map((item) => item.id), ['CQ-1', 'CQ-2'], idea);
    assert.ok(questions.every((item) => item.decision_kind === 'material_boundary'), idea);
    for (const expectedQuestion of expectedQuestions) {
      assert.ok(questions.some((item) => expectedQuestion.test(item.question)), idea);
    }
  }
});

test('a shared action applies once to each distinct parallel material boundary', () => {
  for (const [idea, expectedQuestions] of [
    [
      'Change the authentication method and database storage',
      [/authentication|login compatibility/i, /data will be stored|preservation/i],
    ],
    [
      '인증 방식과 데이터 저장소를 변경해줘',
      [/인증 방식|로그인 호환성/u, /데이터|저장|보존/u],
    ],
    [
      'We need to change the authentication method and database storage',
      [/authentication|login compatibility/i, /data will be stored|preservation/i],
    ],
    [
      '인증 방식 및 데이터 저장소를 변경해줘',
      [/인증 방식|로그인 호환성/u, /데이터|저장|보존/u],
    ],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 2, idea);
    assert.deepEqual(questions.map((item) => item.id), ['CQ-1', 'CQ-2'], idea);
    assert.ok(questions.every((item) => item.decision_kind === 'material_boundary'), idea);
    for (const expectedQuestion of expectedQuestions) {
      assert.ok(questions.some((item) => expectedQuestion.test(item.question)), idea);
    }
  }
});

test('a shared action supports comma-separated material boundaries', () => {
  for (const idea of [
    'Change the authentication method, database storage, and payment provider',
    'Could you please change the authentication method, database storage, and payment provider?',
    '인증 방식, 데이터 저장소 및 결제 제공자를 변경해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 3, idea);
    assert.deepEqual(questions.map((item) => item.id), ['CQ-1', 'CQ-2', 'CQ-3'], idea);
    assert.ok(questions.every((item) => item.decision_kind === 'material_boundary'), idea);
    assert.ok(questions.some((item) => /인증 방식|authentication|login compatibility/iu.test(item.question)), idea);
    assert.ok(questions.some((item) => /데이터|저장|보존|data|preservation/iu.test(item.question)), idea);
    assert.ok(questions.some((item) => /결제|payment/iu.test(item.question)), idea);
  }
});

test('parallel boundary nouns need a shared product-change action', () => {
  for (const idea of [
    'Authentication and database storage',
    'Update documentation for authentication and database storage',
    'Authentication, database storage, and payment provider',
    'We need to update documentation for authentication, database storage, and payment provider',
    '인증 방식과 데이터 저장소',
    '인증 방식과 데이터 저장소 문서를 정리해줘',
    '인증 방식, 데이터 저장소 및 결제 방식',
    '인증 방식, 데이터 저장소 및 결제 방식 문서를 변경해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(
      questions.some((item) => item.decision_kind === 'material_boundary'),
      false,
      idea,
    );
  }
});

test('repeated clauses for the same unresolved material boundary do not duplicate questions', () => {
  for (const idea of [
    '인증 방식을 JWT로 변경하고 로그인 방식을 패스키로 교체해줘',
    'Replace session authentication with JWT and change the OAuth authentication method',
    '세션 인증 방식과 OAuth 인증 방식을 변경해줘',
    'Change session authentication and OAuth authentication',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, /인증 방식|authentication|compatibility/iu, idea);
  }
});

test('fully specified material boundary decisions are not asked again', () => {
  for (const idea of [
    '세션 인증을 JWT로 교체하고 기존 세션 사용자는 모두 다시 로그인하게 해줘',
    '공개 API 응답 구조를 v2로 변경하고 기존 클라이언트 호환성은 유지하지 않아도 돼',
    'Migrate only the users table and preserve every existing user id',
    'Replace session authentication with JWT and intentionally invalidate existing sessions',
    'Store passwords using bcrypt and require all existing users to reset passwords',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('preservation of a different concern does not resolve a material boundary', () => {
  for (const [idea, expectedQuestion] of [
    ['인증 방식을 JWT로 변경하고 사용자 데이터는 유지해줘', /인증 방식|로그인 호환성/u],
    ['공개 API 응답 구조를 v2로 변경하고 OAuth 연동은 그대로 유지해줘', /공개 API|호환성/u],
    ['Migrate authentication to JWT and preserve all user data', /authentication|login compatibility/i],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, expectedQuestion, idea);
  }
});

test('preserving adjacent non-boundary details does not hide an unresolved product boundary', () => {
  for (const [idea, expectedQuestion] of [
    ['Replace session authentication with JWT and keep the login error message unchanged', /authentication|login compatibility/i],
    ['Change the public API response schema and preserve its documentation', /public API|existing clients/i],
    ['Migrate the users table and keep the migration documentation unchanged', /data will be migrated|compatibility/i],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, expectedQuestion, idea);
  }
});

test('documentation and regression tests about a material boundary remain non-product work', () => {
  for (const idea of [
    'Update authentication flow documentation',
    'Add regression tests for OAuth authentication flow',
    'Update payment provider documentation',
    'Add regression tests for payment integration',
    'Update storage documentation',
    'Add storage regression tests',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('a mixed request asks about the changed boundary instead of adjacent documentation', () => {
  const questions = deltaClarifyingQuestions(
    'Update authentication method from sessions to JWT; update API endpoint documentation',
  );
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /authentication|login compatibility/i);
});

test('material changes remain visible when tests or documentation share the same clause', () => {
  for (const [idea, expectedQuestion] of [
    ['Update authentication method from sessions to JWT with regression tests', /authentication|login compatibility/i],
    ['Replace session authentication with JWT with regression tests', /authentication|login compatibility/i],
    ['Replace payment provider with Stripe with updated documentation', /integration|permission|security/i],
    ['Switch storage from local files to S3 with tests', /data will be stored|preservation/i],
    ['인증 방식을 세션에서 JWT로 테스트와 함께 변경해줘', /인증 방식|호환성/u],
    ['Change the public API response schema to v2 with updated documentation', /public API|existing clients/i],
    ['Migrate the users table with regression tests', /data will be migrated|compatibility/i],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, expectedQuestion, idea);
  }
});

test('boundary copy is not mistaken for a boundary change and concise replacements stay material', () => {
  for (const idea of [
    '인증 방식 설명 문구를 변경해줘',
    '권한 구조 설명 문구를 변경해줘',
    '공개 API 응답 구조 설명 문구를 변경해줘',
    'Update authentication flow documentation',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }

  const concise = deltaClarifyingQuestions('인증 방식을 JWT로 해줘');
  assert.equal(concise.length, 1);
  assert.equal(concise[0].decision_kind, 'material_boundary');
  assert.match(concise[0].question, /인증 방식|호환성/u);

  const authApi = deltaClarifyingQuestions(
    'Change the authentication API endpoint from session cookies to JWT',
  );
  assert.equal(authApi.length, 1);
  assert.match(authApi[0].question, /authentication|login compatibility/i);
});

test('authentication migration language is classified as authentication, not data migration', () => {
  const questions = deltaClarifyingQuestions(
    'Migrate user authentication to JWT and preserve all user data',
  );
  assert.equal(questions.length, 1);
  assert.match(questions[0].question, /authentication|login compatibility/i);
});

test('Korean storage and sensitive-data changes are treated as material boundaries', () => {
  for (const idea of [
    '데이터 저장소를 PostgreSQL로 변경해줘',
    'DB 구조를 변경해줘',
    '비밀번호 저장 방식을 bcrypt로 변경해줘',
    '개인정보를 외부 서버로 전송하도록 변경해줘',
    'Set password storage to plaintext',
    'Set personal data storage to an external server',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, /data|preservation|데이터|저장|전송|보존/iu, idea);
  }
});

test('copy and documentation mentioning sensitive boundaries remain ordinary maintenance', () => {
  for (const idea of [
    'Git 저장소 README URL을 변경해줘',
    '비밀번호 안내 문구를 변경해줘',
    '개인정보 처리방침 문서를 최신화해줘',
    '외부 서버 상태 화면의 라벨을 변경해줘',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('English changing and replacing forms do not hide consequential transitions', () => {
  for (const idea of [
    'Changing authentication from sessions to JWT',
    'Replacing session authentication with JWT',
    'We are changing the public API response schema to v2',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
  }
});

test('unrelated preservation in the same clause does not resolve auth or API compatibility', () => {
  for (const [idea, expectedQuestion] of [
    ['오류 문구를 제외한 인증 방식 개선', /인증 방식|호환성/u],
    ['인증 방식을 JWT로 변경 및 오류 문구는 유지해줘', /인증 방식|호환성/u],
    ['공개 API 응답 구조를 v2로 변경 및 안내 문구는 제외해줘', /공개 API|호환성/u],
    ['Change the public API response schema to v2 plus keep documentation unchanged', /public API|existing clients/i],
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
    assert.match(questions[0].question, expectedQuestion, idea);
  }
});

test('a compatibility decision immediately before its boundary is recognized', () => {
  for (const idea of [
    'Keep existing sessions; replacing session authentication with JWT',
    'Keep existing clients compatible. Change the public API response schema to v2',
    '기존 세션은 유지하고 인증 방식을 JWT로 변경해줘',
    '기존 클라이언트 호환성은 유지하고 공개 API 응답 구조를 v2로 변경해줘',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }
});

test('specified ordinary permission security and integration changes avoid duplicate questions', () => {
  for (const idea of [
    '관리자에게 보고서 삭제 권한을 추가해줘',
    '관리자에게 보고서 조회 권한을 부여해줘',
    '프로젝트 삭제 권한을 관리자에게만 허용하도록 변경해줘',
    '웹훅 서명을 HMAC-SHA256으로 변경해줘',
    'Add Slack webhook integration for release failures',
    'Grant administrators permission to delete reports',
    'Give admins permission to delete reports',
    'Allow administrators to view reports',
    'Let administrators view reports',
    'Permit operators to read audit logs',
  ]) {
    assert.deepEqual(deltaClarifyingQuestions(idea), [], idea);
  }

  for (const idea of [
    '권한 구조를 변경해줘',
    '보안 정책을 변경해줘',
    '외부 연동을 변경해줘',
    '기존 역할 호환성은 미정이며 관리자에게 보고서 삭제 권한을 추가해줘',
  ]) {
    const questions = deltaClarifyingQuestions(idea);
    assert.equal(questions.length, 1, idea);
    assert.equal(questions[0].decision_kind, 'material_boundary', idea);
  }
});
