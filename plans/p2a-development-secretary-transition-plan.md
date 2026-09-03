# P2A 개발 비서 전환 계획

- 상태: 개발 기준 계획
- 작성일: 2026-08-29
- 관련 작업: GitHub Issue #197
- 기준 방향: 사용자는 제품 목표와 중요한 결정을 맡고, P2A는 절차·상태·검증·복구를 내부에서 관리한다.

## 1. 목적

Plan2Agent를 사용자가 하네스 규칙을 배워서 조작하는 도구에서, 사용자의 개발 의도를 이해하고 다음 행동을 안내하는 개발 비서로 전환한다.

완성된 P2A는 다음과 같이 동작해야 한다.

1. 사용자의 요청을 목표, 최소 변경 범위, 유지할 동작으로 짧게 정리한다.
2. 제품 결과가 달라지는 중요한 정보가 없을 때만 질문한다.
3. 실행 모드, Gate 번호, CQ ID, run, hash, revision, 검증 프로필은 내부에서 관리한다.
4. 위험도와 변경 범위에 맞는 검증을 자동으로 선택한다.
5. 복구 가능한 오류는 자동으로 정리·재시도하고, 사용자의 결정이나 권한이 필요할 때만 멈춘다.
6. 완료 시 결과와 근거를 요약하고 종료, 리뷰, 회고 중 권장 행동을 제시한다.

이 계획의 성공 기준은 사용자가 P2A의 내부 문서 구조와 Gate 명칭을 몰라도 자연어 요청만으로 개발 과정을 이어갈 수 있는 것이다.

## 2. 제품 원칙

### 2.1 사용자에게 맡길 것

- 무엇을 만들거나 고칠지
- 성공했을 때 어떤 결과가 보여야 하는지
- 반드시 유지해야 할 제품 동작
- 서로 충돌하는 중요한 선택지의 결정
- 배포, 외부 쓰기, 삭제, 보안·개인정보처럼 명시적 권한이 필요한 행동

### 2.2 P2A가 내부에서 처리할 것

- Gate, CQ, run, sidecar의 생성과 연결
- 파일 경로, hash, revision, contract binding
- 실행 모드와 작업 분해 수준 선택
- 변경 위험도에 따른 검증 범위 선택
- 검증 실패 기록, 재시도, task 재개
- 현재 iteration 상태 확인과 다음 행동 계산

### 2.3 사용자에게 보여 줄 정보

기본 출력은 다음 네 가지로 제한한다.

1. `이해한 내용`: 목표, 최소 범위, 유지할 동작
2. `필요한 결정`: 지금 답하지 않으면 제품 결과가 달라지는 질문
3. `진행 결과`: 무엇을 변경했고 어떤 검증이 통과했는지
4. `권장 다음 행동`: 계속 개발, 수정, 리뷰, 회고, 종료 중 하나

내부 용어와 상세 경로는 `--json`, 진단 모드 또는 사용자가 상세 설명을 요청했을 때만 보여 준다.

### 2.4 유지할 안전 경계

다음 항목은 간소화하지 않는다. 다만 사용자에게는 기술 용어 대신 이유를 설명한다.

- 실행되지 않은 검증을 성공으로 기록하지 않는다.
- 현재 제품 revision과 맞지 않는 코드 검증 증거를 재사용하지 않는다.
- 승인된 범위, 유지 조건, 아키텍처·인터페이스 제약을 실행 계약에 보존한다.
- 외부 쓰기, 배포, 파괴적 변경, 보안 경계 변경에는 사용자 권한을 요구한다.
- 실제 제품 실패와 계약 위반은 fail-closed로 처리한다.

## 3. 목표 사용자 흐름

### 3.1 구체적인 유지보수 요청

사용자:

> 로그인 API 오류 메시지를 한국어로 변경해줘.

P2A:

> 로그인 실패 메시지만 한국어로 변경하는 작업으로 이해했습니다. 로그인 처리 방식과 API 응답 구조는 유지하고 관련 테스트로 확인하겠습니다.

이 요청은 대상과 행동이 구체적이므로 `API`라는 단어만으로 추가 아키텍처 질문을 만들지 않는다. 별도 제품 결정 질문은 만들지 않지만, 아래 두 승인 경계는 자연어 요약으로 명확히 확인한다.

### 3.2 사용자 승인 지점

Gate 명칭은 기본 출력에서 숨기되 범위 승인과 구현 명세 승인은 생략하거나 합치지 않는다.

1. **범위 승인:** 질문을 해결한 뒤 목표, 최소 변경 범위, 유지할 동작을 요약하고 “이 이해로 계획을 준비할까요?”라고 한 번 확인한다. 내부적으로 Gate A 결정에 기록한다.
2. **구현 명세 승인:** 구현 전 변경 방법, 중요한 제약, 검증 방법과 의미 있는 trade-off만 요약하고 “이 계획으로 개발을 진행할까요?”라고 한 번 확인한다. 내부적으로 Gate B 결정에 기록한다.
3. **조건부 project-shape 승인:** 되돌리기 어려운 stack/architecture 선택이나 hard prohibition이 새로 생길 때만 별도로 설명하고 승인받는다. 내부적으로 Gate ②에 기록한다.

사용자는 Gate 번호, artifact 경로, 승인 명령을 알 필요가 없다. P2A가 사용자 발화를 해당 결정에 바인딩한다. 이미 승인된 baseline과 충돌하지 않는 내용은 다시 설명하도록 요구하지 않는다.

### 3.3 결과가 달라지는 모호함이 있는 요청

사용자:

> 로그인 방식을 개선해줘.

P2A:

> 로그인 방식 변경은 사용자 경험과 호환성에 영향을 줄 수 있습니다. 현재 방식을 유지하면서 오류 처리만 개선할까요, 아니면 인증 방식 자체를 변경할까요?

질문은 제품 결과를 결정하는 한 가지 쟁점으로 묶는다. 사용자가 이미 말한 내용을 다른 표현으로 다시 묻지 않는다.

### 3.4 복구 가능한 실패

P2A:

> 관련 테스트 1개가 실패했습니다. 이번 변경과 연결된 오류라서 수정한 뒤 같은 범위를 다시 검증하겠습니다.

P2A는 task 상태와 실패 증거를 내부에서 갱신하고 자동으로 수정 흐름을 재개한다. 동일 원인이 반복되거나 사용자의 제품 결정이 필요할 때만 멈춘다.

### 3.5 개발 완료

P2A:

> 요청한 변경과 검증이 완료되었습니다. 특이 사항이 없어 종료를 권장합니다.
>
> - 종료
> - 코드 리뷰
> - 회고

깨끗한 리뷰가 끝났다면 같은 메뉴를 반복하지 않고 “문제 없음, 종료할까요?”를 한 번만 제시한다.

## 4. 현재 구현 상태

2026-08-29 작업 트리에는 Issue #197 방향의 기반 구현이 포함되어 있다. 후속 개발자는 이를 제거하거나 새 흐름으로 다시 만들지 말고, 아래 동작을 먼저 보존·검증한다.

- `p2a next --idea`의 provisional entry 생성
- 현재 baseline을 이용한 delta intake
- material project shape가 있을 때만 여는 조건부 constitution
- docs/metadata, isolated code, high-risk 검증 프로필
- 같은 run 안의 append-only 검증 재시도
- 검증 실패 시 task를 수정 가능한 상태로 되돌리는 흐름
- 완료 시 review, retrospective, close를 분리한 선택
- `[한눈에]` 중심의 사람용 안내

현재 확인된 남은 핵심 문제는 다음 네 가지다.

1. 한국어의 구체적인 변경 요청도 불필요한 CQ를 여러 개 생성할 수 있다.
2. constitution이 없으면 Gate B에서 승인한 구현 제약 일부가 실행 계약에서 사라질 수 있다.
3. high-risk 제품 검증 후 README만 바뀌어도 제품 검증 전체가 오래된 것으로 처리된다.
4. 일부 사용자 문서와 실행 reference가 항상 Gate ②를 거치는 과거 흐름을 설명한다.

## 5. 개발 범위

### 작업 1. 질문 생성기를 “중요한 결정만 질문”하도록 수정

#### 문제

`scripts/p2a_intake_questions.mjs`는 단어 포함 여부에 크게 의존한다. 이 때문에 다음과 같은 구체적인 요청에도 결과, 범위, 아키텍처 질문을 동시에 만들 수 있다.

- `API 응답 캐시 TTL을 60초로 변경`
- `기존 로그인 API 오류 메시지를 한국어로 변경`
- `README 설치 예제를 최신 명령으로 변경`

또한 JavaScript의 `\b`가 한국어 조사·어미 경계를 의도대로 처리하지 못해 `만` 같은 범위 표현이 누락될 수 있다.

#### 수정 방향

1. 대상과 행동이 모두 구체적인 delta 요청은 기본적으로 최소 변경으로 추론한다.
2. `API` 하나만으로 material boundary 질문을 생성하지 않는다.
3. 인증 방식, 데이터 저장 구조, 공개 인터페이스 호환성, 권한, 결제, 외부 연동처럼 실제 경계 변경 동사가 함께 있을 때만 boundary 질문을 생성한다.
4. `~만`, `~으로 변경`, `유지`, `제외`, `건드리지 않음` 등 한국어 범위를 유니코드 친화적으로 판정한다.
5. baseline이 있는 delta에서는 사용자가 말하지 않은 인접 영역을 “기존 동작 유지”로 추론한다.
6. 질문 수는 material decision 수만큼만 만들고, 같은 쟁점을 outcome/scope/boundary로 중복 질문하지 않는다.

#### 주요 수정 파일

- `scripts/p2a_intake_questions.mjs`
- `scripts/p2a_next_service.mjs`
- `tests/intake-questions.test.mjs`
- `tests/next-decision.test.mjs`

#### 완료 조건

- 구체적인 한국어 유지보수 예시 세 개는 CQ를 생성하지 않는다.
- `로그인 방식을 개선`처럼 결과가 달라지는 요청은 하나의 핵심 질문을 만든다.
- 공개 API 응답 구조 변경, 인증 방식 교체, 데이터 마이그레이션은 경계 질문을 만든다.
- 질문하지 않은 baseline 동작은 유지 조건으로 전달된다.

### 작업 2. 승인된 구현 제약을 constitution과 무관하게 실행 계약에 전달

#### 문제

현재 development contract의 `architecture`, `stack`, `prohibitions`, `style`은 주로 constitution에서 온다. constitution을 만들지 않는 정상 유지보수 흐름에서는 Gate B spec의 다음 정보가 실행 envelope와 synthetic task의 source reference에서 빠질 수 있다.

- `implementation.architecture`
- `implementation.interfaces`
- `implementation.dependencies`

조건부 constitution을 유지하면서도 사용자가 승인한 구현 제약은 반드시 실행에 전달되어야 한다.

#### 수정 방향

1. Gate B spec에서 실행에 필요한 구현 제약을 정규화한다.
2. `approvedExecutionEnvelope()`에 승인된 architecture, interfaces, dependencies를 포함한다.
3. `materializeCurrentDevelopmentContract()`는 constitution의 장기 원칙과 현재 spec의 iteration 제약을 구분해 함께 보존한다.
4. Direct/Planned synthetic task의 `sourceSpecRefs`에 관련 구현 경로를 포함한다.
5. 현재 spec 또는 constitution이 변경되면 기존 hash/revision 검증 방식으로 drift를 탐지한다.
6. 별도 Gate ②는 장기적 hard prohibition이나 되돌리기 어려운 project shape 결정에만 사용한다.

#### 고정 데이터 계약

constitution의 장기 규칙 객체와 Gate B의 문자열 배열을 같은 `architecture` 필드에 섞지 않는다. current development contract와 execution envelope에 다음 선택 필드를 추가한다.

```json
{
  "iterationConstraints": {
    "architecture": ["string"],
    "interfaces": ["string"],
    "dependencies": ["string"]
  }
}
```

- 세 배열은 Gate B `implementation.architecture`, `implementation.interfaces`, `implementation.dependencies`에서 공백 제거·중복 제거 후 복사한다.
- 새로 materialize하는 contract와 새 execution envelope에는 `iterationConstraints`를 항상 기록한다. 빈 제약은 빈 배열로 기록한다.
- 기존 `architecture`, `stack`, `prohibitions`, `style`은 constitution의 장기 project-shape 규칙으로 의미를 유지한다.
- `p2a.current_development_contract.v1`에는 `iterationConstraints`를 optional property로 추가해 기존 파일을 그대로 읽는다. 새 schema version과 일괄 migration은 만들지 않는다.
- `run.schema.json`의 `executionEnvelope`에도 같은 optional property를 추가한다. 기존 완료 run의 envelope에는 필드가 없어도 유효하지만 새 run에는 반드시 생성한다.
- execution envelope 전체 JSON의 기존 SHA-256 계산에 이 필드가 자동 포함된다. `bindings.activeSpec.sha256`과 expected-envelope 비교가 승인 후 변경을 탐지한다.
- `executionEnvelopeFromCurrentDevelopmentContract()`도 이 필드를 복사한다. legacy contract에 필드가 없으면 기존 완료 evidence 검증에서만 누락을 허용한다.

#### 주요 수정 파일

- `scripts/validate_artifacts.mjs`
- `scripts/p2a_iteration_state.mjs`
- `scripts/p2a_execute.mjs`
- `schemas/current-development-contract.schema.json`
- `schemas/run.schema.json`
- `tests/adaptive-execution.test.mjs`
- `tests/supervised-batch-execution.test.mjs`
- `tests/negative-fixtures.test.mjs`

#### 완료 조건

- constitution이 없는 프로젝트도 Gate B에서 승인한 interface와 dependency 제약을 실행 owner가 받는다.
- 해당 제약을 위반하거나 승인 후 변경하면 validation이 실패한다.
- 일반적인 작은 유지보수 작업에는 새 constitution이나 Gate ② 승인이 생기지 않는다.
- 기존 constitution이 있는 프로젝트의 hard prohibition 동작은 그대로 유지된다.
- 기존 v1 contract와 완료 run은 migration 없이 검증되고, 새 run만 `iterationConstraints`를 필수 생성한다.

### 작업 3. 검증 증거를 제품 revision과 문서 revision으로 분리

#### 문제

high-risk profile은 제품 코드 전체 검증이 통과한 뒤 README만 수정되어도 기존 제품 검증을 오래된 것으로 처리한다. 이는 제품 코드가 바뀌지 않은 문서 수정에 전체 테스트를 다시 요구하게 만든다.

#### 수정 방향

1. 검증 증거를 제품 검증과 비제품 검증의 두 축으로 판단한다.
2. high-risk 작업은 별도의 canonical final verification을 계속 요구한다.
3. final verification 이후 제품 hash가 같다면 제품 테스트 증거를 재사용한다.
4. 이후 README나 metadata가 바뀌었다면 현재 workspace revision에 맞는 문서 관련 검사만 추가한다.
5. 제품 파일이 바뀌면 기존 high-risk 제품 검증은 즉시 무효화한다.
6. 실패한 최신 검증 시도는 이전 성공 증거보다 우선한다.

#### 고정 obligation과 실행 경로

close readiness가 요구하는 검증을 다음 두 obligation으로 분리한다.

- `product_full`: 현재 `productRevisionSha256`에 바인딩된 full 검증. isolated-code는 현재 task-level full evidence로 충족할 수 있고, high-risk/integrated는 canonical final run이어야 한다.
- `workspace_relevant`: 현재 `workspaceRevisionSha256`에 바인딩된 변경 파일 관련 검증

프로필과 변경 순서별 요구 조건을 다음처럼 고정한다.

| 상태 | 요구 obligation | 규칙 |
| --- | --- | --- |
| docs/metadata-only | `workspace_relevant`만 | `product_full`을 만들거나 요구하지 않는다. |
| isolated-code 제품 변경 | `product_full` | 현재 product revision의 유효한 task-level full evidence를 재사용할 수 있다. |
| high-risk/integrated 제품 변경 | `product_full` | 현재 product revision의 canonical final full run만 인정한다. |
| 유효한 `product_full`과 같은 workspace | 추가 obligation 없음 | full run이 실행된 workspace의 비제품 파일까지 현재이므로 `workspace_relevant`도 충족한 것으로 본다. |
| 유효한 `product_full` 이후 비제품 파일만 변경 | 기존 `product_full` + 새 `workspace_relevant` | 제품 full은 유지하고 현재 문서·metadata 관련 검사만 추가한다. |
| `product_full` 이후 제품 파일 변경 | 새 `product_full` | 이전 product full을 무효화하고 현재 workspace에서 full을 다시 실행한다. 이 새 full은 같은 시점의 `workspace_relevant`도 충족한다. |

`p2a next`와 실행 명령은 outstanding obligation에 따라 다음처럼 연결한다.

1. 해당 프로필에 필요한 `product_full`이 없으면 기존 `final_verification_required`를 반환하고 `p2a execute verify-final --artifacts <root>`를 실행한다. docs/metadata-only에는 이 분기를 적용하지 않는다.
2. docs/metadata-only이거나, 유효한 `product_full` 이후 비제품 변경으로 `workspace_relevant`만 없으면 `relevant_verification_required`를 반환하고 `p2a execute verify-final --scope relevant --artifacts <root>`를 실행한다.
3. `--scope relevant`는 현재 비제품 변경 파일에 대해 프로젝트 설정의 관련 명령을 실행하고, 설정이 없으면 P2A의 최소 파일 무결성 검사를 실행해 `scope: related` evidence를 기록한다. full evidence를 새로 만들거나 기존 `product_full`을 무효화하지 않는다.
4. 기존 flag 없는 `verify-final`은 canonical full 검증 의미를 유지한다.
5. 관련 명령을 실행할 수 없으면 성공으로 대체하지 않고 environment failure를 기록한다.

이 action과 명령은 내부 orchestration용이다. 기본 사용자 출력에는 “문서 변경에 필요한 검사만 실행하겠습니다”라고 표시한다.

#### 주요 수정 파일

- `scripts/p2a_final_verification_gate.mjs`
- `scripts/p2a_verification_evidence.mjs`
- `scripts/p2a_verification_profile.mjs`
- `scripts/p2a_next_service.mjs`
- `scripts/p2a_execute.mjs`
- `scripts/p2a.mjs`
- `tests/layered-verification.test.mjs`
- `tests/verification-obligations.test.mjs`
- `tests/verification-preflight.test.mjs`

#### 완료 조건

- high-risk 제품 전체 테스트 통과 후 README만 변경하면 제품 전체 테스트를 다시 요구하지 않는다.
- 같은 상황에서 README 관련 검증은 현재 revision으로 새로 요구한다.
- 문서 관련 검증만 남으면 `relevant_verification_required`와 `--scope relevant` 경로를 사용한다.
- 제품 코드 한 줄이라도 변경되면 high-risk 제품 검증을 다시 요구한다.
- 실행되지 않았거나 `EPERM` 등으로 시작하지 못한 명령은 성공 증거가 되지 않는다.

### 작업 4. 사용자 출력과 복구 안내를 비서형으로 정리

#### 문제

내부 상태 계산이 간소화되어도 CLI와 skill이 Gate, artifact, command를 먼저 설명하면 사용자는 여전히 하네스를 직접 운영한다고 느낀다.

#### 수정 방향

1. 기본 출력의 첫 문장은 상태명이 아니라 사용자가 해야 할 일 또는 P2A가 이어서 할 일을 말한다.
2. 질문 전에는 P2A가 이해한 목표, 범위, 유지 조건을 짧게 보여 준다.
3. 실행 가능한 내부 조치는 사용자에게 명령 선택을 요구하지 않고 권장 행동으로 제공한다.
4. 복구 가능한 실패는 자동 재시도 대상으로 설명한다.
5. 제품 결정, 외부 권한, 안전한 복구 불가일 때만 사용자에게 멈춤 이유와 한 가지 요청을 전달한다.
6. Gate, CQ, run ID, hash는 상세/JSON 출력에 남겨 자동화 호환성을 유지한다.

#### 주요 수정 파일

- `scripts/p2a_next_service.mjs`
- `scripts/p2a_failure_details.mjs`
- `scripts/p2a.mjs`
- `scripts/p2a_execute.mjs`
- `.agents/skills/p2a-next/SKILL.md`
- `.agents/skills/p2a-dev-execution/SKILL.md`
- `.claude/skills/`의 동일 mirror
- `tests/next-decision.test.mjs`
- `tests/adaptive-execution.test.mjs`

#### 완료 조건

- 초보자가 기본 출력만 보고 다음 행동을 이해할 수 있다.
- 내부 명령이나 경로를 몰라도 일반 개발 흐름을 진행할 수 있다.
- `--json --contract v2`의 machine-readable 상태와 기존 자동화 계약은 유지된다.
- 동일한 결정을 여러 표현으로 반복 요청하지 않는다.

### 작업 5. 완료, 리뷰, 회고 흐름을 조언 중심으로 고정

#### 수정 방향

1. 모든 필수 evidence가 최신이면 P2A가 기본 권장 행동을 선택한다.
2. 특이 사항과 회고 신호가 없으면 `종료 권장`을 먼저 보여 준다.
3. 코드 리뷰는 현재 iteration의 목표, diff, 검증 증거, 치명적·중요 결함을 중심으로 한다.
4. 현재 작업과 무관한 과거 iteration 문서를 자동으로 전부 읽지 않는다.
5. 장기 지식이 필요하면 BuildLore 같은 명시된 중앙 지식원을 사용하도록 연결 지점만 유지한다.
6. 깨끗한 리뷰 후에는 리뷰 메뉴를 반복하지 않는다.
7. 회고는 선택 사항이며, 회고를 생략해도 close를 막지 않는다.

#### 주요 수정 파일

- `scripts/p2a_next_service.mjs`
- `.agents/skills/p2a-dev-execution/references/verification-closeout.md`
- `.agents/skills/p2a-harness/references/artifact-persistence-and-evidence.md`
- 대응하는 `.claude/skills/` mirror
- `tests/next-decision.test.mjs`
- closeout 관련 fixture

#### 완료 조건

- 깨끗한 상태는 종료를 권장한다.
- review finding이 있으면 해당 task만 reopen하고 관련 범위만 재검증한다.
- clean review는 종료 확인으로 한 번만 이어진다.
- 회고 미선택은 close readiness에 영향을 주지 않는다.

### 작업 6. 사용자 문서와 실제 동작 통일

#### 문제

일부 문서는 아이디어 문서 작성과 Gate ②를 항상 거치는 과거 흐름을 설명한다. README에서 연결한 초보자용 문서가 실제 CLI보다 복잡하면 비서형 전환 효과가 사라진다.

#### 수정 방향

1. 초보자 문서는 자연어 요청에서 시작한다.
2. Gate A/B/②는 내부 안전 경계 설명으로 뒤로 이동한다.
3. Gate ②는 material project shape가 있을 때만 나타나도록 모든 흐름도를 수정한다.
4. constitution이 없으면 repository convention을 advisory로 사용한다고 명시한다.
5. 기본 사용자 여정은 `요청 → 이해 요약/필요한 질문 → 개발 → 자동 검증 → 권장 종료`로 표현한다.
6. 명령·artifact 상세는 CLI reference와 harness reference로 분리한다.

#### 주요 수정 파일

- `README.md`
- `README.ko-KR.md`
- `docs/adaptive-harness-user-flow.md`
- `docs/harness-guide.md`
- `docs/harness-spec.md`
- `docs/quickstart.md`
- `.agents/skills/p2a-dev-execution/references/provider-confinement.md`
- 대응하는 `.claude/skills/` mirror

#### 완료 조건

- 모든 입문 문서에서 Gate ②가 조건부로 설명된다.
- constitution이 없는 정상 유지보수 흐름이 문서에 존재한다.
- 입문 문서의 첫 흐름에서 사용자가 artifact 경로와 hash를 다루지 않는다.
- CLI 예제와 실제 출력·명령이 일치한다.

## 6. 구현 순서와 의존성

다음 순서로 개발한다.

1. **행동 계약 고정**: 이 문서의 사용자 흐름을 테스트 fixture로 먼저 추가한다.
2. **질문 생성 수정**: 작업 1을 완료해 불필요한 사용자 왕복을 제거한다.
3. **실행 계약 보강**: 작업 2를 완료해 조건부 constitution에서도 승인 제약을 잃지 않게 한다.
4. **검증 유효성 분리**: 작업 3을 완료해 안전성을 유지하면서 불필요한 전체 검증을 줄인다.
5. **안내와 복구 정리**: 작업 4와 작업 5를 함께 적용한다.
6. **문서·skill 동기화**: 작업 6을 마지막에 실제 동작 기준으로 갱신한다.
7. **전체 회귀 검증**: package, fixture, mirror, 문서 표현을 함께 확인한다.

작업 2와 작업 3은 안전 경계에 영향을 주므로 각각 독립적으로 테스트가 통과한 뒤 다음 작업으로 넘어간다. 문서만 먼저 바꾸지 않는다.

## 7. 필수 인수 시나리오

| 시나리오 | 기대 결과 |
| --- | --- |
| 구체적인 한국어 메시지 변경 | 추가 CQ 없이 최소 변경과 baseline 유지로 해석 |
| `API`가 포함된 단순 구현 변경 | API 단어만으로 architecture 질문을 생성하지 않음 |
| 인증 방식 교체 | 호환성과 보안에 관한 한 가지 material decision 질문 |
| constitution 없는 maintenance | Gate B의 architecture/interface/dependency 제약이 실행 계약에 포함 |
| README-only 변경 | 관련 문서 검증만 요구 |
| high-risk 전체 검증 후 README 변경 | 제품 검증 재사용, 문서 검증만 추가 |
| high-risk 전체 검증 후 제품 코드 변경 | 제품 전체 검증 재실행 요구 |
| 관련 테스트 실패 | 실패 기록 후 task reopen 및 수정 흐름 안내 |
| 명령 실행 자체가 불가능함 | 성공으로 기록하지 않고 unavailable/failed로 설명 |
| 모든 검증 완료, 특이 사항 없음 | 종료를 기본 권장 |
| clean review 완료 | 반복 리뷰 메뉴 없이 종료 확인 |
| 회고 생략 | iteration close 가능 |

## 8. 검증 계획

### 8.1 집중 테스트

변경 작업별로 다음 테스트를 먼저 실행한다.

```bash
node --test tests/intake-questions.test.mjs
node --test tests/next-decision.test.mjs
node --test tests/adaptive-execution.test.mjs
node --test tests/layered-verification.test.mjs
node --test tests/verification-obligations.test.mjs
node --test tests/verification-preflight.test.mjs
node --test tests/supervised-batch-execution.test.mjs
```

### 8.2 전체 검증

```bash
npm test
npm run test:full
npm run test:package
git diff --check
```

추가로 다음을 확인한다.

- `.agents/skills`와 `.claude/skills` mirror가 동일하다.
- CLI help, README, quickstart의 명령 예제가 실제 명령과 일치한다.
- 새 기본 출력이 JSON contract를 변경하지 않는다.
- 기존 프로젝트의 constitution과 decision ledger를 마이그레이션 없이 읽을 수 있다.

## 9. 비목표

이번 전환에서 다음은 하지 않는다.

- 범위와 구현 명세의 명시적 승인을 삭제하거나 하나로 합치지 않는다. 기본 출력에서 Gate 명칭만 숨긴다.
- Gate와 증거 체인을 모두 삭제하지 않는다.
- 실제 테스트 없이 LLM 판단만으로 완료 처리하지 않는다.
- 모든 프로젝트에 constitution 생성을 강제하지 않는다.
- 새로운 대형 workflow engine이나 별도 상태 저장소를 추가하지 않는다.
- 사용자의 제품 결정을 P2A가 임의로 대신하지 않는다.
- 장기 지식 저장 시스템을 이번 범위에서 새로 구현하지 않는다.
- CLI의 machine-readable contract를 불필요하게 변경하지 않는다.

## 10. 호환성과 위험 관리

### 기존 프로젝트

- 기존 constitution이 있으면 계속 검증하고 재사용한다.
- constitution이 없다는 이유로 migration이나 승인을 강제하지 않는다.
- 기존 run과 verification evidence는 현 schema 규칙에 따라 읽는다.
- 기존 current development contract와 execution envelope에 `iterationConstraints`가 없으면 legacy로 읽고, 다음 materialization부터 새 필드를 생성한다.

### 과도한 자동 추론 위험

- 최소 변경 추론은 baseline 유지에만 사용한다.
- 인증, 권한, 결제, 데이터 손실, 공개 호환성처럼 결과가 큰 결정은 추론하지 않는다.
- 질문을 줄이더라도 승인된 spec의 제약은 실행 계약에서 제거하지 않는다.

### 검증 재사용 위험

- workspace hash가 달라도 product hash가 같다는 이유만으로 모든 검증을 재사용하지 않는다.
- 제품 검증과 문서 검증을 분리해 각 변경 종류에 맞는 현재 증거를 요구한다.
- 최신 실패는 이전 성공을 덮어야 한다.

## 11. 최종 완료 체크리스트

- [ ] 구체적인 delta 요청은 불필요한 CQ를 만들지 않는다.
- [ ] material decision만 짧고 이해하기 쉬운 질문으로 제시한다.
- [ ] 범위와 구현 명세는 Gate 용어 없이 각각 한 번 명확히 승인받는다.
- [ ] 승인된 구현 제약이 constitution 유무와 관계없이 실행 계약에 보존된다.
- [ ] 검증은 변경 위험과 제품/문서 revision에 맞게 자동 선택된다.
- [ ] 복구 가능한 실패는 자동 수정 흐름으로 이어진다.
- [ ] 사용자 결정이나 외부 권한이 필요할 때만 실행을 멈춘다.
- [ ] 완료 시 결과, 검증, 권장 다음 행동이 먼저 보인다.
- [ ] clean review와 회고 선택이 종료를 불필요하게 반복·차단하지 않는다.
- [ ] 입문 문서와 skill이 동일한 비서형 흐름을 설명한다.
- [ ] 집중 테스트, 전체 테스트, package test가 모두 통과한다.
- [ ] 독립 리뷰에서 사용자에게 새 절차 부담을 추가한 Medium 이상 문제가 없다.

## 12. 최종 제품 판단 기준

개발이 끝난 뒤 다음 질문에 모두 `예`라고 답할 수 있어야 한다.

1. 사용자는 내부 Gate와 run 구조를 몰라도 개발을 진행할 수 있는가?
2. P2A는 사용자의 요청을 먼저 이해해서 요약하고 있는가?
3. 질문은 제품 결과를 바꾸는 중요한 결정에만 한정되는가?
4. P2A가 다음 행동을 추천하고 내부 절차를 대신 처리하는가?
5. 규칙은 사용자를 통제하기보다 실수와 증거 위조를 막는 뒤쪽 안전장치로 작동하는가?

한 항목이라도 `아니오`라면 개발 비서 전환은 완료된 것으로 보지 않는다.
