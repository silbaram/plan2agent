# 승인된 계약 기반 자율 개발 개선안

작성일: 2026-08-13<br>
상태: 설계 제안 — 현재 동작이 아님

문서 홈: [Plan2Agent Docs](README.md) · 현재 구현 계약: [하네스 구현 기준](harness-spec.md) · [반복 개발 스펙](iteration-spec.md) · [감독형 실행 레퍼런스](supervised-execution.md)

## 1. 최상위 개선 목표

Plan2Agent의 단일 최상위 개선 목표는 **승인된 계약 기반 자율 개발(Contract-driven Autonomous Development)** 이다.

> 사용자는 무엇을 왜 만들지 승인하고, 하네스는 기획 계약의 완전성·일관성·추적성을 검증한다. AI는 승인된 계약과 프로젝트 규칙 안에서 구현 방법을 자율적으로 결정하고, 실제 검증을 통과할 때까지 개발한다.

정상 흐름에서는 Gate B 승인 이후 사용자가 task, 파일, 코드 구조나 구현 순서를 다시 지시하지 않는다. 실행 AI가 repository와 승인 계약을 직접 읽고 내부 계획을 세우며, 구현·테스트·렌더링·수정 반복을 거쳐 close-ready 상태까지 책임진다. 제품 의미나 승인 경계를 바꿔야 할 때만 정확한 충돌과 필요한 결정을 제시하고 Gate로 돌아온다.

### 권한과 책임

| 주체 | 권한과 책임 | 하지 않는 일 |
| --- | --- | --- |
| 사용자 | 목표, 범위, non-goal, UX, 중요한 trade-off와 acceptance 계약을 승인한다. | 파일별 구현 방법이나 AI의 내부 실행 계획을 일상적으로 승인하지 않는다. |
| 하네스 | 기획을 구조화하고 누락·충돌·근거·hash·승인 lineage를 검증하며 실행 가능한 계약으로 전달한다. | 사용자 대신 제품 결정을 승인하거나 구현 recipe를 task로 미리 고정하지 않는다. |
| 실행 AI | repository 조사, 내부 작업 분할, 파일·구조·도구 선택, 구현, 테스트, 렌더링, self-review와 수정 반복을 소유한다. | 승인된 제품 의미, project constitution, 권한·안전 경계를 임의로 변경하지 않는다. |
| Validator/reviewer | 기계 규칙과 실제 기능·시각·접근성 evidence를 독립적으로 검사한다. | 제품 결정을 새로 만들거나 evidence 없이 완료를 추정하지 않는다. |

### AI가 자율적으로 결정하는 범위

- 내부 작업 순서·분할, 파일·코드 구조, 기존 pattern과 승인 stack 안의 구현 대안
- 테스트/fixture 추가, 실패·UI drift 수정, scope 안의 refactoring과 mode 변경
- 허용된 provider 도구와 bounded subagent 사용

여러 구현 대안이 존재한다는 이유만으로 사용자에게 선택을 넘기지 않는다. AI는 repository evidence, constitution, Gate B acceptance와 검증 비용을 근거로 가장 적절한 방식을 선택하고 그 근거를 run evidence에 남긴다.

### AI가 중단하고 Gate로 돌아오는 조건

- 목표, 사용자 흐름, acceptance 또는 non-goal을 변경해야 한다.
- 승인 범위 밖의 기능이나 dependency가 필요하다.
- project constitution의 아키텍처, foundational stack, prohibition 또는 style 변경이 필요하다.
- 보안, 개인정보, 데이터 보존·migration 의미가 승인 계약과 달라진다.
- 되돌리기 어려운 외부 write, 배포, 비용 발생 또는 새 권한이 필요하다.
- 상충하는 Gate 근거 때문에 어느 구현도 계약을 만족할 수 없다.

Gate 복귀 보고는 막연한 질문이 아니라 충돌한 source field, repository evidence, 가능한 선택지와 trade-off를 포함한 최소 변경 요청이어야 한다. 일반 구현 실패, 테스트 실패와 UI drift는 Gate 복귀 사유가 아니며 AI가 같은 실행 안에서 수정한다.

### 후속 변경안 판단 기준

변경은 기획 계약을 명확히 하고, 승인 후 개입을 줄이며, AI의 구현·검증 책임과 rule/evidence gate를 강화해야 한다. 기여하지 않는 compatibility layer, task field, prompt rule 또는 review pass는 제거하거나 조건부로 내린다.

## 2. 결정 요약

Plan2Agent의 개발 계약 정본은 승인된 Gate 산출물로 둔다. Task는 Gate의 목표와 제약을 다시 서술하거나 구현 방법을 미리 결정하는 문서가 아니라, 필요한 경우에만 실행 순서·의존성·병렬 소유권·상태를 기록하는 얇은 실행 단위로 축소한다.

Gate A는 문제·범위·제외, Gate ②는 architecture/stack/prohibition/style, Gate B는 제품·구현·acceptance·검증·시각 경험을 승인한다. Gate C는 항상 graph를 만드는 단계가 아니라 **실행 방식과 준비 상태를 검증하는 선택형 단계**다. 실행 AI가 Gate와 repository에서 응집된 구현 단위를 결정하되 안전·승인·evidence 기준은 model/mode와 무관하다.

Task는 없애지 않는다. 다중 owner·실제 선후 관계·장기 재개가 필요할 때만 사용한다.

## 3. 현재 구현에서 확인된 사실

아래 내용은 개선 가설이 아니라 현재 repository 계약에서 직접 확인되는 사실이다.

| 확인 사항 | 현재 상태 | 근거 |
| --- | --- | --- |
| 개발 실행 전 task graph | canonical task graph 검증을 실행 진입의 필수 조건으로 둔다. | [`p2a-harness` 역할/검증 계약](../.agents/skills/p2a-harness/SKILL.md), [감독형 실행 안전 정책](supervised-execution.md#8-안전-정책) |
| 권장 task 개수 | 의미 있는 iteration을 보통 10~50개의 작은 task로 나누도록 지시한다. 이 수치는 schema 제약이 아니라 저작 지침이다. | [`p2a-task-author`](../.agents/skills/p2a-task-author/SKILL.md), [`task-graph.schema.json`](../schemas/task-graph.schema.json) |
| task 중복 서술 | 각 task에 `description`, `acceptanceCriteria`, `suggestedAgentPrompt`, `sourceSpecRefs`를 모두 요구한다. | [`task-graph.schema.json`](../schemas/task-graph.schema.json) |
| 구현 agent 단위 | implementer 역할은 정확히 한 ready task를 구현하도록 고정되어 있다. | [`p2a-implementer`](../.agents/agents/p2a-implementer.md) |
| UI 최종 review 기본값 | `devExecution.reviewPasses.visual` 기본값은 `off`다. | [감독형 실행 리뷰 패스 정책](supervised-execution.md#리뷰-패스-정책) |
| 개발 중 시각 검수 | task-level 사용자 시각 검수는 비게이팅·무기록 절차다. | [개발 중 사용자 시각 검수](supervised-execution.md#개발-중-사용자-시각-검수) |
| 현재 eval 범위 | stable metrics에는 모델별 성공률, task 크기, prompt 길이, first-pass acceptance, UI drift가 없다. | [`eval/stable-metrics.json`](../eval/stable-metrics.json) |
| 헌법의 실제 강제 범위 | validator prohibition의 target은 `spec`/`task_graph`뿐이고 해당 JSON의 문자열 leaf에서 금지어를 찾는다. architecture/stack/style 및 제품 코드는 검사하지 않는다. | `schemas/constitution.schema.json:52-91`, `scripts/validate_artifacts.mjs:1503-1517` |
| 완료 후 review | style과 milestone은 informational이고 monitor만 기존 finish를 차단할 수 있다. monitor의 세 검사는 acceptance, 실제 verification, changedFiles scope이며 헌법 준수 검사는 없다. | `.agents/skills/p2a-dev-execution/SKILL.md:166,180-182`, `.claude/agents/p2a-performance-monitor.md:19-42`, `scripts/p2a_monitor_gate.mjs:8-15` |
| review 기본값 | monitor는 `opt_in`, style/milestone/visual은 `off`, acceptance는 `on`이다. | `scripts/p2a_project_config.mjs:228-244` |
| fixture 분할 | webhook fixture의 task 4개는 `task-001 → 002 → 003 → 004` 선형 체인이라 task 간 병렬성이 0이다. | `fixtures/_e2e/webhook-api-service/gate-c-task-graph/task-graph.json:6-86` |
| task 계약과 중복 | task는 9개 필드를 요구하지만 일반 task의 추가 의미 검사는 `acceptanceCriteria`와 `sourceSpecRefs`의 non-blank 검사다. webhook fixture에서 단순 영숫자 token 기준 description 어휘의 prompt 재등장률은 31~63%다. | `schemas/task-graph.schema.json:26-37`, `scripts/validate_artifacts.mjs:3161-3165`, `fixtures/_e2e/webhook-api-service/gate-c-task-graph/task-graph.json:8-85` |
| 기존 prompt 해석 | `p2a_tasks.mjs`는 `sourceSpecRefs`의 dot path를 spec 값으로 해석하고 full spec 경로도 출력한다. 얇은 task 전환에 새 해석 계층은 필요 없다. | `scripts/p2a_tasks.mjs:338-363,384-403` |
| 분할 뒤처리 기구 | milestone/batch reference, milestone reviewer, schema 네 파일이 합계 27,891 bytes다. | `.agents/skills/p2a-dev-execution/references/milestone-review.md`, `.agents/skills/p2a-dev-execution/references/batch-execution.md`, `.agents/agents/p2a-milestone-reviewer.md`, `schemas/milestone-review.schema.json` |
| 자율 실행 차단 | Claude write는 전경 human-supervised 경로로 고정되고 `p2a next`의 CLI는 매번 승인 대기하며 implementer에는 WebSearch/WebFetch가 없다. | `.agents/skills/p2a-dev-execution/SKILL.md:36-40`, `.agents/skills/p2a-next/SKILL.md:16-22`, `.claude/agents/p2a-implementer.md:4-11` |
| 모델 pin | `.claude/agents/*.md` 12개 모두 `model:`을 고정한다. implementer는 opus, monitor/acceptance/visual reviewer는 sonnet, style rater는 haiku다. 이는 §16의 모델 하드코딩 금지와 충돌한다. | `.claude/agents/p2a-implementer.md:1-11`, `.claude/agents/p2a-performance-monitor.md:1-8`, `.claude/agents/p2a-style-rater.md:1-8` |
| 계측과 보존 계약 | spec에는 `product.constraints`와 `implementation.verification`이 있지만 `must_preserve`가 없고, run에는 verification 시간은 있지만 token/usage/사용자 개입 필드가 없다. | `schemas/spec.schema.json:34-107,110-158`, `schemas/run.schema.json:6-28,203-268` |
| 최근 시각 검수 결정 | v0.2.3은 task 구현 중 반복 사용자 시각 검수 loop를 추가했다. | commit `52626e6` (2026-08-11), `.agents/skills/p2a-dev-execution/SKILL.md:106-110` |

따라서 다음 주장은 아직 실험으로 입증된 사실이 아니라 검증할 설계 가설이다.

- 긴 task prompt를 줄이면 최신 상위 모델의 성능이 좋아진다.
- task 수를 줄이면 중간급 모델의 통합 오류가 감소한다.
- Gate 중심 Direct 실행이 현재 graph 실행보다 비용과 시간이 적게 든다.
- 통합된 render/review loop가 UI 품질을 개선한다.

기본값을 바꾸기 전에 §13의 비교 평가로 이 가설을 검증해야 한다.

## 4. 현재 구조의 문제

Gate B 계약을 task description·acceptance·prompt로 반복하면 drift·중복이 생기고 조사 전에 파일·순서를 고정한다. `10~50` 목표는 작은 slice도 선형 run으로 쪼개지만 task 수는 품질 지표가 아니다(§3 `분할 뒤처리 기구`·`fixture 분할`·`task 계약과 중복`). 별도 owner, 실제 dependency, 독립 검증·rollback 또는 장기 재개 때만 분할한다. UI도 task별 `visualImpact`가 아니라 승인된 전체 screen/state/viewport와 통합 render로 판정한다.

## 5. 설계 원칙

### 5-1. Gate는 의미 계약, 실행 계획은 운영 메타데이터다

Gate는 목표·사용자 결과·non-goal·제약·관찰 가능한 acceptance와 기능/시각/접근성 검증을 소유한다. 실행 계획은 실행 단위·의존성·owner·상태·evidence만 기록한다.

### 5-2. 상세함과 명확함을 구분한다

목표·source hash·scope/non-goal·보존 동작·acceptance·검증 matrix·중단 조건은 모델과 무관하게 명시한다. 파일 목록, 내부 구조, 작성 순서, recipe와 task 개수는 정형 변환이나 안전상 순서가 필요하지 않으면 구현 AI가 결정한다.

### 5-3. 기계 규칙은 prompt가 아니라 CLI가 강제한다

Schema, hash, 승인 lineage, 경로 경계, 상태 전이, evidence 형식, dependency cycle은 validator와 CLI가 검사한다. Agent prompt에는 같은 규칙의 전문을 반복하지 않고 실패 시 필요한 메시지와 source reference만 제공한다.

### 5-4. 자율성은 무검증이 아니라 실행 책임이다

AI의 자율성은 규칙을 생략하거나 결과를 self-report만으로 승인한다는 뜻이 아니다. AI가 구현 선택과 실패 수정을 끝까지 책임지되, 권한 경계와 완료 판정은 외부 validator와 실제 실행 evidence가 강제한다는 뜻이다.

Gate B 승인 뒤 사용자 개입이 없는 것이 목표지만, 다음 두 결과는 명확히 구분한다.

- 구현 실패: AI가 계획을 바꾸고 재시도한다.
- 계약 실패: AI가 정확한 Gate 변경 요청과 함께 중단한다.

### 5-5. 모델이 아니라 작업 특성으로 실행 모드를 고른다

상위 모델이라고 항상 큰 작업을 주거나, 중간급 모델이라고 항상 많은 task로 나누지 않는다. 결합도, 위험, 병렬성, 재개 필요성과 검증 가능성이 실행 모드를 결정한다. 모델 profile은 같은 계약을 얼마나 자세히 보여줄지 정하는 보조 신호로만 사용한다.

### 5-6. 강제 수단 없는 규칙은 강제된다고 표시하지 않는다

규칙은 승인 시점에 강제 수단과 함께 제시한다. 린트·테스트로 표현 가능한 규칙은 프로젝트 lint/test 설정에 넣는다. 기존 `p2a runs verify --lint`와 `verificationPolicy: required_for_done`이 실패한 검증의 done 전이를 막으므로 하네스 schema를 늘릴 필요가 없다(`.agents/skills/p2a-dev-execution/SKILL.md:80-90`, `scripts/p2a_project_config.mjs:228-244`). 판단이 필요한 architecture/stack/prohibition/style 규칙은 하나의 게이팅 monitor가 실제 `changedFiles`를 읽어 검사한다. 둘 다 불가능하면 `advisory`로 두고 **위반을 검출하지 못한다는 사실을 승인 화면에 표시한다.**

자율 실행에서 산문 규칙은 조용히 위반될 수 있다. 따라서 검출기 없는 규칙을 강제되는 것처럼 표시하는 것이 자율성보다 위험하다. `constitution.schema.json`에 `check` 같은 필드를 추가하는 안은 채택하지 않는다. 실행할 강제 수단 없이 규칙 schema만 늘리면 같은 허위 보장을 반복하기 때문이다.

## 6. 목표 workflow

`Gate A → Gate ② → Gate B 승인 → repository 조사와 mode 선택 → 자율 구현 → 통합 검증 → evidence 봉인`이 정상 흐름이다. 구현 실패는 같은 loop에서 수정하고 계약 변경만 최소 근거와 함께 Gate B로 돌아간다.

Gate B 승인 뒤 `p2a next`는 자율 개발 session을 시작한다. AI가 조사 후 모드를 선택·변경하며 이는 새 승인 Gate가 아니다. 사용자는 운영 정책으로 범위를 제한할 수 있고, 판정이 애매하면 실행 단위를 넓히지 말고 verify checkpoint를 더 촘촘히 둔다.

## 7. 세 가지 실행 모드

세 모드는 사용자가 작성해야 하는 계획 종류가 아니라 실행 AI가 목표를 완수하기 위해 선택하는 내부 운영 전략이다. 하네스는 선택 근거와 mode별 계약을 검증하지만 정상적인 mode 선택을 사용자에게 다시 묻지 않는다.

| 모드 | 적용 조건 | 계획 산출물 | 실행 단위 |
| --- | --- | --- | --- |
| `direct` | 단일 owner, 응집된 vertical slice, 독립 병렬화 이점이 작음 | Gate B를 참조하는 얇은 execution record | iteration run 1개 |
| `planned` | 한 owner가 수행하지만 2~5개의 순차 checkpoint와 재개 지점이 필요함 | milestone 목록과 각 검증 조건 | milestone 단위 |
| `orchestrated` | 여러 owner/agent, 실제 dependency branch, 격리 병렬 작업 또는 독립 rollback 필요 | dependency-aware task graph | ready task 또는 bounded batch |

### 7-1. Direct

한 agent가 context 안에서 끝낼 작은 vertical slice나 통합 UI 변경은 Direct 후보다.

Direct에서도 승인 Gate, run log, verification evidence, visual review와 close 조건은 생략하지 않는다. 생략하는 것은 사람이 저작한 세부 task graph뿐이다.

한 run 안에서 `p2a runs verify`를 여러 번 호출해 checkpoint evidence를 남긴다. 즉 rollback·재개 기록 경계를 task라는 프로세스 경계에서 verify checkpoint로 낮추며, 모든 변경을 하나의 무검증 거대 run으로 합치지 않는다.

현재 v1 task 기반 실행기와 호환하는 과도기에는 CLI가 Gate B를 참조하는 단일 synthetic work item을 생성할 수 있다. 이 레코드는 상세 구현 prompt를 저장하지 않으며 사용자 산출물인 task graph로 취급하지 않는다.

### 7-2. Planned

Planned는 task 대신 `id`, 결과(`outcome`), 검증 조건만 가진 2~5개 milestone을 사용한다. Milestone은 파일별 recipe가 아니며 이전 milestone의 구현을 다시 서술하지 않는다.

### 7-3. Orchestrated

다음 조건 중 하나라도 해당하면 task graph를 유지한다.

- 둘 이상의 write owner가 동시에 작업한다.
- 독립 branch를 병렬화했을 때 명확한 시간 이점이 있다.
- migration, 배포, API 전환처럼 실제 선후 관계가 존재한다.
- 실패 격리나 부분 rollback 단위가 필요하다.
- 장기 작업이라 여러 session에서 소유권과 재개 상태를 보존해야 한다.

이 모드에서도 `10~50` 같은 고정 개수 기준은 사용하지 않는다. 각 task는 독립적으로 검증할 수 있는 결과와 실제 dependency를 가질 때만 만든다.

## 8. 얇은 실행 계약

모드와 관계없이 runtime에는 다음 최소 envelope를 전달한다.

**불변식:** 아래 모든 필드는 승인된 Gate 산출물과 hash에서 파생만 허용한다. 실행 AI가 실행 시점에 새로 저작하거나 의미를 넓힐 수 없다. 특히 `must_preserve`는 Gate B에서 사용자가 승인한 `spec.product.must_preserve`가 정본이다.

```json
{
  "objective": "이번 실행에서 완성할 사용자 결과",
  "source_gate_refs": [
    {
      "path": "iterations/iter-002/gate-b-spec/spec.json",
      "sha256": "..."
    }
  ],
  "scope": ["변경 가능한 제품 영역"],
  "must_preserve": ["회귀하면 안 되는 기존 동작"],
  "non_goals": ["명시적으로 제외된 범위"],
  "acceptance": ["관찰 가능한 완료 조건"],
  "verification": ["실행할 검증"],
  "execution_authority": {
    "may_choose": ["내부 분할", "파일과 코드 구조", "검증을 위한 구현 수정"],
    "must_return_to_gate": ["제품 의미 변경", "승인 범위 확대", "constitution 변경"]
  }
}
```

구현 agent 지시는 Gate/constitution을 정본으로 읽고 repository를 조사한 뒤, non-goal과 보존 조건 안에서 구현·실제 검증·수정을 close-ready까지 소유하며 Gate 의미 변경이 필요할 때만 중단하는 수준으로 제한한다. 모델 profile은 계약을 바꾸지 않고 locator·예시 등 표시 scaffolding만 조절한다.

## 9. UI/UX 실행 계약 보강

UI 품질 문제는 task 개수만 줄여서는 해결되지 않는다. Gate B의 시각 계약이 구현 agent와 실제 render/review loop까지 손실 없이 전달되어야 한다.

### 9-1. Gate B가 소유해야 하는 정보

- screen 목적, route/flow와 기본·loading·empty·error·success·disabled 상태
- viewport/responsive, hierarchy/interaction, token/component와 의도된 예외
- keyboard/focus/contrast, prototype hash와 화면별 acceptance

### 9-2. 구현 run에 전달할 정보

UI 또는 mixed 실행에는 `visualImpact`만 전달하지 않고 다음 정보를 runtime envelope에서 직접 resolve한다.

- 승인된 experience spec/prototype의 경로와 hash
- 영향 screen/state, 전체 capture matrix와 실행 가능한 route/state fixture
- 승인된 visual invariant

### 9-3. 필수 render/review loop

`repository/visual contract 확인 → app 구현 → route/state/viewport render·interaction 확인 → 기능·접근성·시각 drift 수정 → 영향 화면 재검증 → 통합 후 전체 matrix review`를 한 loop로 수행한다.

현재 iteration에 승인된 시각 계약이 있으면 최종 visual review를 일반 비용 옵션과 분리한다.

- `has_visual_contract`: Gate B 산출물에서 계산하는 사실
- `final_visual_review_required`: 시각 계약 유형과 명시적 정책으로 계산하는 완료 조건
- `reviewPasses.visual`: 추가 독립 reviewer의 실행 강도를 조정하는 운영 옵션

즉 승인된 필수 시각 계약이 있는데 reviewer 옵션이 `off`라는 이유만으로 전체 visual acceptance가 사라져서는 안 된다. 독립 reviewer를 생략하더라도 owner가 수행한 실제 render evidence는 필요하다.

Screenshot 존재와 hash만 확인하지 말고 application URL, workspace revision, state fixture, viewport, capture command와 결과를 함께 결합해야 한다. 최종 판정은 개별 task 화면이 아니라 통합된 사용자 flow를 기준으로 한다.

개발 중의 일반적인 visual drift는 실행 AI가 render/review loop에서 스스로 수정한다. 다만 v0.2.3이 추가한 반복 사용자 시각 검수 loop의 제거 여부는 **Phase 2 판단**으로 내린다. 자동 capture+reviewer가 이를 대체할 수 있는지는 §13 UI fixture의 visual drift와 user correction 결과로 먼저 검증한다. 그전에는 기존 loop를 유지한다. AI가 visual contract의 충분성을 스스로 판정하고 곧바로 사용자 검수를 제거하는 순환 논리는 근거로 사용하지 않는다.

## 10. Gate C의 새 역할

Gate C라는 이름은 호환성을 위해 유지할 수 있지만 의미는 `Task graph validation`에서 `Execution readiness validation`으로 확장한다.

공통 검증은 Gate A/②/B 승인, open decision 부재, artifact hash, 비어 있지 않은 acceptance/verification 및 필요한 visual contract resolve다. Planned는 milestone outcome·검증·cycle을, Orchestrated는 task id·dependency·ownership·충돌·독립 검증 가능성을 추가 검사한다.

Mode 선택과 내부 실행 계획에는 별도 사용자 승인 audit을 요구하지 않는다. Gate C validator는 AI의 계획을 제품 결정으로 승격하지 않고, 승인 계약과의 연결·권한·검증 준비 상태만 확인한다.

## 11. Schema와 CLI 변경 제안

### 11-1. 얇은 execution record

`schemas/spec.schema.json`의 Gate B 승인 대상 `product`에 `must_preserve`를 추가한다. 별도 범용 계약 schema는 만들지 않고 기존 run/task graph record에 mode와 다음 참조·운영 metadata만 둔다.

```text
mode: direct | planned | orchestrated
sourceSpec + sourceSpecSha256
objective
scope / mustPreserve / nonGoals
acceptance / verification
milestones[]                 # planned에서만 사용
taskGraphRef                 # orchestrated에서만 사용
visualContractRef            # 필요한 경우
selectionRationale            # 운영 mode 선택 근거
```

`task-graph.schema.json`은 orchestrated/legacy에만 유지하며 historical graph를 다시 쓰지 않는다. §8의 objective/scope/acceptance 등은 execution record의 새 저작 필드가 아니라 source spec을 읽어 만든 runtime view다.

### 11-2. CLI 흐름

기존 `p2a execute prepare/start/status/finish`와 iteration validation 표면을 mode 공통 진입·상태·검증·evidence 전이에 재사용한다. 최종 이름보다 기존 lifecycle 통합을 우선한다.

`p2a next`는 Gate B 뒤에 사용자에게 mode 선택 menu를 보여주지 않는다. 다음 중 정확히 하나의 상태 기반 행동을 반환한다.

- 자율 개발 session 시작 또는 재개
- 실행 AI가 근거와 함께 요청한 최소 Gate 계약 보완
- 권한·환경·외부 write처럼 사용자 authorization이 필요한 blocker 해소

### 11-3. Prompt 조립

Prompt는 다음 계층을 한 번씩만 조립한다.

1. provider 안전·권한 경계
2. project constitution과 style
3. 승인 Gate B에서 추출한 현재 실행 계약
4. 현재 milestone/task와 repository evidence
5. UI, migration, 보안 등 해당할 때만 읽는 조건부 상세 자료

긴 global rule을 모든 task prompt에 복사하지 않는다. Source artifact를 읽을 수 없거나 hash가 다르면 prompt를 생성하지 않고 차단한다.

## 12. 호환 마이그레이션

### Phase 0 — baseline 보존과 계측 구축
- `10~50` graph를 A로 동결해 baseline을 수집하고 분할은 유지한다.
- Phase 0에 monitor 헌법 검사를 A/B에 적용한다.
- `run.schema.json`에 usage/token과 interruption 필드를 추가하고 Gate 복귀 이벤트 기록 경로를 정의한다. 현재 schema에는 이 데이터가 없어 단순히 “측정”할 수 없다(`schemas/run.schema.json:6-28,182-268`).
- eval fixture에서는 milestone/visual pass를 강제로 `on`으로 실행해 선택적 기본값으로 인한 누락을 막는다.
- `user correction count`와 `implementation-decision interruption count`는 자동 관측할 수 없으므로 수동 주석 protocol을 정의한다. 신뢰도 있는 protocol을 만들지 못하면 두 지표를 비교 판정에서 제외한다.
- task 수, first-pass, rework, 통합 결함, UI drift와 Gate return을 기록하고 동일 fixture에서 model profile만 구분한다.

### Phase 1 — `task-lite` 호환 경로

- Phase 0 baseline을 봉인한 뒤 `10~50 task` 저작 지침을 제거하고 outcome/dependency 기반 분할로 바꾼다.
- implementer를 objective owner로 확장하고, 작은 iteration에는 Gate B를 참조하는 얇은 work item을 만든다.
- 기존 task/run/handoff/history schema를 유지하며 자율 범위·Gate return·UI 계약을 envelope에 전달하고 필요한 render evidence를 close 조건으로 강제한다.

### Phase 2 — 적응형 실행 opt-in

- 기존 execution record에 `mode`를 추가한다.
- Direct와 Planned를 opt-in으로 제공한다.
- Orchestrated는 기존 task graph를 그대로 사용한다.
- mode별 resume, block, retry, close와 handoff 회귀 테스트를 추가한다.

### Phase 3 — 검증 후 기본값 전환

- §13 기준을 통과한 경우 새 project의 기본값을 `adaptive`로 바꾼다.
- 기존 project와 historical iteration은 기록된 mode 또는 legacy graph를 계속 사용한다.
- `p2a.task_graph.v1` reader와 validator는 적어도 하나의 명시된 호환 기간 동안 유지한다.
- deprecated path 제거는 usage telemetry 또는 migration audit 없이 진행하지 않는다.

## 13. 평가 계획

현재 방식과 개선 방식을 동일한 요구사항, repository snapshot, 모델 profile에서 비교한다.

### 비교군

- A: 현재 Gate B → 10~50 지향 task graph → task별 실행
- B: Gate B → 승인 계약 기반 자율 개발 → AI가 adaptive mode 선택. model pin 제거와 monitor 헌법 검사는 task 분할 방식이 아닌 심사·계측 조건이므로 A와 B 양쪽에 동일하게 적용한 뒤 baseline을 수집한다.

### fixture 구성

- 단일 backend 변경
- frontend/backend가 결합된 vertical slice
- 상태가 여러 개인 UI 화면
- 기존 design system을 재사용하는 UI 변경
- schema/data migration
- 병렬화 가치가 있는 다중 영역 기능
- 실패 후 resume와 remediation이 필요한 변경

### 필수 지표

| 지표 | 목적 | 현재 데이터 소스/계측 상태 |
| --- | --- | --- |
| post-Gate autonomous completion rate | 추가 구현 지시 없이 close-ready에 도달한 비율 | iteration/run status + Phase 0 interruption 주석¹ |
| implementation-decision interruption count | 구현 선택을 사용자에게 되물은 횟수 | 없음; Phase 0 수동 주석¹ |
| valid Gate return precision | 실제 계약 변경이 필요했던 Gate 복귀 비율 | 없음; Phase 0 Gate-return event + 판정 주석¹ |
| first-pass acceptance rate | 첫 구현의 Gate acceptance 만족률 | run index/monitor·acceptance verdict² |
| user correction count | 요구사항 또는 UI를 다시 설명한 횟수 | 없음; Phase 0 수동 주석¹ |
| rework run count | 완료 뒤 다시 열린 실행 단위 수 | task 상태와 run index² |
| integration defect count | 단위 통과 뒤 통합에서 발견된 결함 수 | milestone/acceptance verdict²; eval에서 pass 강제 |
| visual drift count | 승인 matrix와 다른 결과 수 | visual review sidecar²; eval에서 visual 강제 |
| scope violation count | non-goal 또는 승인 밖 변경 수 | monitor `scope_concerns`² |
| rule violation count | constitution·권한·안전 위반 수 | **현재 검출기 없음**; §14 P0 monitor 적용 전에는 항상 0으로 관측됨³ |
| elapsed time | Gate B 승인부터 close-ready까지 시간 | Gate approval timestamp + run/iteration timestamp² |
| prompt/input tokens | 반복 설명과 context 비용 | 없음; Phase 0 `run.usage`¹ |
| verification evidence completeness | 실제 실행 증거의 완전성 | run `verification` + acceptance/monitor verdict² |

¹ Phase 0에서 schema/event 또는 수동 protocol을 만든 뒤에만 사용한다. ² 기존 run/review 산출물에서 파생한다. ³ 검출기 없는 0을 “위반 없음”으로 해석하거나 A/B 안전성 결론에 사용하지 않는다.

Adaptive를 기본값으로 전환하려면 추가 구현 지시 없이 완료하는 비율이 증가하고 불필요한 구현 선택 질문이 감소해야 한다. 동시에 실패율, scope violation과 rule violation은 악화되지 않아야 한다. UI fixture에서는 visual drift와 사용자 수정 횟수가 감소해야 하며, 시간/token 개선만으로 품질 저하를 정당화하지 않는다.

## 14. 우선순위와 실행 순서

| 우선순위 | Phase | 개선 | 이유 |
| --- | --- | --- | --- |
| P0 | 0 | monitor에 constitution architecture/stack/prohibitions/style 검사 추가 | monitor 확장이라 기구는 그대로다. A/B 적용으로 rule violation을 비교한다. informational style 중복은 finish·baseline에 영향이 없다. |
| P0 | 1 | style·milestone review pass와 사이드카 규칙 제거 | p2a-style-rater/p2a-milestone-reviewer, SKILL 규칙·config 설정을 지운다(SKILL.md:139-182,220-224, p2a_project_config.mjs:228-244). 정본은 8,570 bytes, reviewer는 3 → 1로 준다. |
| P0 | 0 | `.claude/agents/*.md`의 `model:` pin 12개 제거 | 세션 모델을 상속해야 생산자보다 약한 심사자 고정을 없애고 §13 model profile A/B가 가능하다. |
| P0 | 1 | `schemas/spec.schema.json`의 `product`에 `must_preserve` 추가 | §8 파생 전용 envelope의 전제이며, 없으면 회귀 방지 계약이 실행 시점 저작으로 되돌아간다. |
| P0 | 1 | 자율 차단 조항 세 개 해제 | Provider Confinement는 동일 workspace 안전 경계 안의 무인 실행을 허용하도록 재작성하고, `p2a next` 개발 loop의 매 단계 승인을 없애며, implementer에 WebSearch/WebFetch를 부여한다. |
| P0 | 1 | `10~50 task` 고정 지침 제거 | Phase 0에서 비교군 A baseline을 봉인한 뒤 과분해를 제거한다. |
| P0 | 1 | implementer를 objective owner로 확장하고 Gate-derived envelope 전달 | 기존 spec 해석·검증 경로를 통합해 구현·수정 반복을 AI가 소유한다. |
| P0 | 1 | 현재 시각 계약과 owner render evidence를 공통 close 조건에 연결 | reviewer 옵션과 제품 acceptance를 분리하되 새 review pass를 만들지 않는다. |
| P1 | 2 | direct/planned를 기존 run/verify 기록 위에 opt-in | task 대신 verify checkpoint를 쓰고 orchestrated graph는 필요한 경우만 유지한다. |
| P1 | 2 | task/model/UI eval과 통합 acceptance 실행 | 기본값 전환 근거를 만들며 반복 사용자 시각 검수 제거 여부도 여기서 결정한다. |
| P2 | 3 | legacy graph와 중복 milestone/batch 기구 정리 | 남은 §3 reference/schema 22,580 bytes와 legacy graph 표면은 Phase 3에서 지운다. |

## 15. 완료 조건

이 개선안의 구현은 다음 조건을 모두 만족할 때 완료로 본다.

- Gate B 뒤 task별 승인 없이 자율 개발이 시작되고, AI가 repository evidence로 mode·계획·구현·실패 수정을 소유한다.
- 계약 변경 때만 충돌 field와 최소 결정 요청으로 Gate에 복귀하며 모든 mode가 spec hash, acceptance와 실제 verification evidence를 보존한다.
- Direct는 사람 저작 graph 없이 동작하고, Planned는 checkpoint 재개를, Orchestrated는 기존 dependency·batch·history 호환을 유지한다.
- UI는 승인 contract와 capture matrix의 실제 render evidence 없이는 close-ready가 되지 않는다.
- Phase 1부터 reviewer 총량 감소를 검증하고, 완료 시 중복 task/reviewer/compatibility 기구의 총량이 도입 전보다 감소한다.

## 16. 비목표

- 승인 Gate를 없애거나 모델이 제품 결정을 임의로 바꾸게 하지 않는다.
- 하네스나 validator를 사용자 승인 권한의 대체자로 만들지 않는다.
- 사용자가 AI의 내부 task, mode 또는 파일 계획을 매번 승인하게 하지 않는다.
- 안전·보안·migration 검증을 모델 자율성이라는 이유로 완화하지 않는다.
- 모든 작업을 하나의 거대한 run으로 합치지 않는다.
- multi-agent task graph를 제거하지 않는다.
- 모델 이름에 workflow를 하드코딩하지 않는다.
- 평가 없이 기존 project의 기본 실행 방식을 즉시 변경하지 않는다.

## 17. 최종 원칙

> 기획은 사용자가 승인하고 하네스가 검증한다.<br>
> 개발은 AI가 승인된 계약과 규칙 안에서 자율적으로 완수한다.<br>
> Gate가 계약을 소유하고, AI가 구현을 소유하며, 하나의 게이팅 reviewer가 규칙을 지킨다.<br>
> **이 개선은 새 계약·review pass를 쌓지 않고 기존 기구를 정리·통합해 하네스를 줄인다.**
