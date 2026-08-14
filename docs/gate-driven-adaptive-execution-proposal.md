# 승인된 계약 기반 자율 개발 개선안

작성일: 2026-08-13<br>
상태: **개선 개발 완료** · Phase 0–3 및 기본 실행 경로 경량화 완료 · 일회성 7-fixture 평가 기록 보존 · production lifecycle 비용은 실사용 telemetry 검증 범위

문서 홈: [Plan2Agent Docs](README.md) · 현재 구현 계약: [하네스 구현 기준](harness-spec.md) · [반복 개발 스펙](iteration-spec.md) · [감독형 실행 레퍼런스](supervised-execution.md)

구현 완료 상태(2026-08-14): Phase 0은 monitor rule/hash 계약과 run telemetry·eval 집계를 구현했고, 일회성 평가에 사용한 seal CLI/schema와 repository evaluator는 의사결정 뒤 제거했다. Phase 1은 `product.must_preserve`, Gate-derived `executionEnvelope`/hash, outcome/dependency 기반 task 저작, objective-owner 실행, post-Gate `p2a next`, style/milestone reviewer 제거와 필수 visual close evidence를 반영했다. Phase 2는 `adaptive|direct|planned|orchestrated`, Direct/Planned synthetic work item, Planned checkpoint 실행·재개·finish 차단과 mode/rationale 보존을 구현했다. Phase 3은 새 project의 `adaptive` 기본값, mode 없는 기존 config의 `orchestrated` 호환 해석과 active milestone writer 제거를 완료했다.

과도 적용 재검토에서는 일반 Direct/단일-owner Planned를 현재 owner와 기본 isolation `none`으로 되돌리고, 별도 implementer·worktree·monitor·acceptance reviewer·retrospective protocol은 실제 조건이 있을 때만 로드하도록 줄였다. Acceptance 기본값은 `opt_in`이며, `p2a proposals mine`은 쓰기 작업이므로 항상 승인을 요구한다. `gpt-5.6-luna/medium` 7-fixture 결과는 task decomposition과 prompt/call 비용을 비교한 repository 평가다. 양쪽 7/7 acceptance와 B의 task·호출·token·시간 감소를 기록했지만 production `p2a execute` lifecycle 전체의 worktree·monitor·acceptance 비용을 측정한 결과로 일반화하지 않는다. Task-level 사용자 시각 승인 반복은 owner 자동 render/review loop로 대체하고, historical reader는 writer 없는 호환 계층으로 유지한다.

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
| 개발 실행 전 준비 | Direct/Planned는 CLI가 synthetic compatibility work item을 만들고, Orchestrated는 canonical task graph를 사용한다. 어느 mode든 실행 전 같은 Gate/hash/readiness 검증을 통과한다. | [`p2a-harness` 역할/검증 계약](../.agents/skills/p2a-harness/SKILL.md), [감독형 실행 안전 정책](supervised-execution.md#8-안전-정책) |
| task 분할 기준 | 고정 개수 지침을 제거했다. 실제 dependency, 별도 write owner, 독립 verification/rollback, cross-session resume 경계가 있을 때만 분할한다. | [`p2a-task-author`](../.agents/skills/p2a-task-author/SKILL.md), [`p2a-task-breakdown`](../.agents/skills/p2a-task-breakdown/SKILL.md) |
| task 중복 서술 | 각 task에 `description`, `acceptanceCriteria`, `suggestedAgentPrompt`, `sourceSpecRefs`를 모두 요구한다. | [`task-graph.schema.json`](../schemas/task-graph.schema.json) |
| 구현 agent 단위 | Direct와 단일-owner Planned는 현재 실행 owner가 맡는다. 별도로 spawn한 implementer는 정확히 한 ready work item만 구현한다. | [`p2a-implementer`](../.agents/agents/p2a-implementer.md) |
| UI 최종 review 기본값 | `reviewPasses.visual` 기본값은 추가 reviewer용 `off`지만 승인 contract의 owner render evidence와 close gate는 필수다. | [실행 리뷰 패스 정책](supervised-execution.md#리뷰-패스-정책) |
| 개발 중 시각 검수 | task-level 사용자 승인은 제거했다. 실행 owner가 영향 화면을 render/review하고 drift를 자율 수정하는 비게이팅·무기록 절차다. | [개발 중 자동 시각 검수](supervised-execution.md#개발-중-자동-시각-검수) |
| 현재 eval 범위 | stable metrics는 usage/input token, 자율 완료, 사용자 개입, Gate 복귀 precision, task 수, first-pass acceptance, rework, 통합 결함, visual drift, scope/rule violation, Gate B→close-ready 시간과 verification evidence completeness를 집계한다. 모델별 성공률과 prompt 길이는 봉인 manifest의 동일 model-profile 실행을 모은 뒤 비교에서 계산할 후속 항목이다. | [`eval/stable-metrics.json`](../eval/stable-metrics.json), `scripts/p2a_eval.mjs` |
| 헌법의 실제 강제 범위 | validator prohibition의 target은 `spec`/`task_graph`뿐이고 해당 JSON의 문자열 leaf에서 금지어를 찾는다. architecture/stack/style 및 제품 코드는 검사하지 않는다. | `schemas/constitution.schema.json:52-91`, `scripts/validate_artifacts.mjs:1503-1517` |
| 완료 후 review | Monitor를 활성화한 run에서는 style을 같은 rule contract로 검사하며, 새 style/milestone reviewer는 생성하지 않는다. Historical evidence reader만 유지한다. | `.agents/skills/p2a-dev-execution/SKILL.md`, `.agents/agents/p2a-performance-monitor.md` |
| review 기본값 | monitor와 acceptance는 `opt_in`, visual은 독립 reviewer 강도용 `off`다. 명시적으로 시작한 opt-in review는 완료 전까지 gate가 되며, 필수 visual contract evidence는 visual 옵션으로 끌 수 없다. | `scripts/p2a_project_config.mjs`, `scripts/p2a_iteration.mjs` |
| fixture 분할 | webhook fixture의 task 4개는 `task-001 → 002 → 003 → 004` 선형 체인이라 task 간 병렬성이 0이다. | `fixtures/_e2e/webhook-api-service/gate-c-task-graph/task-graph.json:6-86` |
| task 계약과 중복 | task는 9개 필드를 요구하지만 일반 task의 추가 의미 검사는 `acceptanceCriteria`와 `sourceSpecRefs`의 non-blank 검사다. webhook fixture에서 단순 영숫자 token 기준 description 어휘의 prompt 재등장률은 31~63%다. | `schemas/task-graph.schema.json:26-37`, `scripts/validate_artifacts.mjs:3161-3165`, `fixtures/_e2e/webhook-api-service/gate-c-task-graph/task-graph.json:8-85` |
| 기존 prompt 해석 | `p2a_tasks.mjs`는 `sourceSpecRefs`의 dot path를 spec 값으로 해석하고 full spec 경로도 출력한다. 얇은 task 전환에 새 해석 계층은 필요 없다. | `scripts/p2a_tasks.mjs:338-363,384-403` |
| 분할 뒤처리 기구 | 새 style/milestone reviewer와 skill 경로를 제거했다. Batch reference와 historical milestone schema/reader는 orchestrated 실행과 기존 evidence 호환을 위해 남겼다. | `.agents/skills/p2a-dev-execution/references/batch-execution.md`, `schemas/milestone-review.schema.json` |
| 자율 실행 | Claude는 scaffold/OS confinement 안의 post-Gate loop를 진행할 수 있고, `p2a next`는 승인된 개발 action만 즉시 실행한다. 일반 Direct/단일-owner Planned는 현재 owner가 수행하고, 별도 implementer는 격리 owner가 실질적으로 필요할 때만 사용한다. Live web은 current owner가 version-sensitive 외부 근거를 꼭 확인해야 할 때만 사용한다. | `.agents/skills/p2a-dev-execution/SKILL.md`, `.agents/skills/p2a-next/SKILL.md`, `.agents/agents/p2a-implementer.md` |
| 모델 pin | Claude agent mirror는 `model:`을 생성하지 않고 현재 parent/session 모델을 상속한다. Codex/Gemini tier mapping은 현재 구현 계약대로 유지한다. | `scripts/sync_cli_assets.mjs`, `.claude/agents/*.md`, `docs/harness-spec.md` |
| 계측과 보존 계약 | run telemetry와 `product.must_preserve`를 추가했고, 새 run은 승인 spec hash와 보존/비목표/acceptance/verification/권한을 `executionEnvelope`/hash로 고정한다. UI run은 승인 prototype, route/state/viewport, 접근성 기준과 시각 불변 조건도 같은 envelope에 고정한다. | `schemas/run.schema.json`, `scripts/p2a_runs.mjs`, `schemas/spec.schema.json` |
| 적응형 실행 정책 | 새 project는 `adaptive`를 기본으로 사용하고, mode가 없는 기존 config는 `orchestrated`로 해석한다. `adaptive|direct|planned|orchestrated` 명시값을 지원하며 Direct/Planned는 한 synthetic work item으로 기존 lifecycle과 호환한다. | `scripts/p2a_project_config.mjs`, `scripts/p2a_execute.mjs`, `scripts/p2a_runs.mjs`, `schemas/task-graph.schema.json`, `schemas/run.schema.json` |
| 최근 시각 검수 결정 | v0.2.3의 task별 사용자 시각 검수 loop는 §13의 일회성 UI fixture 결과 뒤 owner 자동 render/review로 대체됐다. 평가 수치와 한계만 역사적 기록으로 남기고 전용 runner는 유지하지 않는다. | [§13 평가 기록](#13-평가-기록과-운영-계측), `.agents/skills/p2a-dev-execution/SKILL.md` |

다음 항목은 설계 승인 당시 검증 대상으로 둔 가설이었다.

- 긴 task prompt를 줄이면 최신 상위 모델의 성능이 좋아진다.
- task 수를 줄이면 중간급 모델의 통합 오류가 감소한다.
- Gate 중심 Direct 실행이 현재 graph 실행보다 비용과 시간이 적게 든다.
- 통합된 render/review loop가 UI 품질을 개선한다.

§13의 controlled A/B는 해당 model profile과 fixture matrix에서 task decomposition에 따른 task·provider call·token·시간 감소와 동일한 최종 품질을 확인했다. Production lifecycle 전체나 다른 모델·실제 장기 프로젝트의 비용·성공률까지 측정한 결과는 아니다.

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

Direct에서도 승인 Gate, run log와 실제 verification evidence는 생략하지 않는다. 승인된 visual contract가 있으면 owner render와 최종 visual close evidence를 유지한다. 별도 monitor와 독립 acceptance review는 정책이 `on`이거나 명시적으로 opt-in한 경우에만 추가하며, 생략하는 기본 기구는 사람이 저작한 세부 task graph와 불필요한 독립 review pass다.

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

개발 중의 일반적인 visual drift는 실행 AI가 render/review loop에서 스스로 수정한다. Phase 2에서는 v0.2.3의 반복 사용자 시각 검수 loop를 평가 전까지 유지했다. §13의 두 UI fixture에서 A/B 모두 최종 visual drift 0, user correction 0을 기록하고 B의 품질·자율성이 악화되지 않아 task-level 사용자 시각 승인을 제거했다. 구현 owner의 영향 화면 반복 검수와 iteration-level 최종 visual gate는 유지한다. 이 결정은 AI의 자기 판정이 아니라 exact-viewport screenshot, 독립 image review, verification·scope evidence가 봉인된 비교 결과를 근거로 한다.

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

`task-graph.schema.json`은 orchestrated graph와 과도기 Direct/Planned synthetic work item container에 유지한다. `execution`에는 `mode`, `selectionRationale`, `syntheticWorkItem`, Planned의 2–5개 `milestones`만 기록한다. §8의 objective/scope/acceptance 등은 새 저작 필드가 아니라 source spec을 읽어 만든 runtime view다.

### 11-2. CLI 흐름

기존 `p2a execute prepare/start/resume/status/finish`와 iteration validation 표면을 mode 공통 진입·상태·검증·evidence 전이에 재사용한다. `prepare`는 승인 Gate B와 현재 approval audit을 검증하고 Direct/Planned 호환 레코드를 원자적으로 생성한다. Planned는 `p2a runs checkpoint --milestone <id>`가 선언된 실제 명령을 순서대로 실행하며, 미검증 milestone이 있으면 finish를 거부한다. 실패·실행 불가 checkpoint evidence는 immutable이라 같은 run에서 재실행하지 않고 failed/blocked close 뒤 새 retry run으로 복구한다.

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
- Phase 0에 production monitor 헌법 검사를 구현한다. **구현 완료:** 새 monitor gate는 rule source ref/hash, 필수 `rule_concerns`, sidecar 전체의 run-side contract hash와 완료 판정 verdict의 exact-byte evidence hash를 고정한다. 일회성 A/B는 이 lifecycle을 재현하지 않고 fixture `allowed_paths`만 별도 scope guard로 검사했다.
- `run.schema.json`에 usage/token과 interruption 필드를 추가하고 Gate 복귀 이벤트 기록 경로를 정의한다. **구현 완료:** `p2a runs record|finish`와 `p2a execute finish`가 증분 usage와 수동 개입 주석을 기록한다.
- Eval fixture는 제품 runtime의 선택적 review 기본값과 분리된 고정 seed·verification·allowed-path scope·UI capture 계약으로 일회성 실행했다. Production monitor/worktree/acceptance lifecycle은 별도 제품 회귀 테스트와 실사용 telemetry 범위다. 평가가 완료된 뒤 전용 runner·fixture·schema·테스트와 baseline seal CLI를 제품 및 유지보수 표면에서 제거했다.
- `user correction count`와 `implementation-decision interruption count`는 자동 관측할 수 없으므로 수동 주석 protocol을 정의한다. **구현 완료:** `--user-correction`, `--implementation-interruption`, `--gate-return`을 동일 run에 즉시 기록한다. 동일 protocol을 지키지 않은 run은 비교 판정에서 제외한다.
- Task 수, first-pass, rework, 통합 결함, UI drift와 Gate return을 기록하고 동일 fixture에서 model profile만 구분한다. **집계 구현 완료:** production `p2a eval digest`는 task/run/monitor/acceptance/visual evidence에서 지표를 파생한다. 일회성 A/B report는 provider usage, verification, allowed-path scope와 UI evidence inventory를 기록했으며 결과 요약만 §13에 보존한다.
- 첫 UI 후보 `todo-lis`의 기존 7개 run은 7/7 실제 command verification을 보존해 fixture seed로 재사용할 수 있지만 current telemetry 0/7, provider usage 0/7, monitor 0/7, pre-close/visual review 0건, Gate B approval timestamp·visual contract 누락, eval grade 3건 partial이므로 봉인되지 않았다. 상세 판정은 [todo-lis UI baseline 후보](../eval/baseline-candidates/todo-list-ui.md)에 기록한다.
- `todo-list-ui-a` current-harness 실행은 fixture·Gate·review 계약을 복원해 7/7 task, 8개 implementation run, pre-close와 final visual review를 완료했다. 당시의 일회성 seal dry-run은 usage 4/9, strict monitor/rule review 7/8, verification 8/9와 task별 latest non-pass grade 3건을 정확히 차단했다. 이 실패 후보의 raw local workspace는 재사용하지 않고 durable 판정 요약만 보존한다.

### Phase 1 — `task-lite` 호환 경로

- **구현 완료:** `10~50 task` 저작 지침을 제거하고 outcome/dependency/owner/rollback/resume 기반 분할로 바꾼다.
- **구현 완료:** 실행 owner가 objective를 소유하도록 확장하고, task prompt를 Gate B source ref를 가리키는 짧은 work item으로 축소했다.
- **구현 완료:** 기존 task/run/handoff/history reader를 유지하며 새 run에 Gate-derived envelope/hash를 전달하고 필수 visual contract render evidence를 close 조건으로 강제했다.
- **구현 완료:** style/milestone reviewer 생성 경로를 제거하고, `p2a next` CLI action에 `requiresApproval`을 추가해 post-Gate 개발 loop의 반복 승인을 제거했다.

### Phase 2 — 적응형 실행

- **구현 완료:** 기존 graph/run record에 `mode`와 `selectionRationale`를 추가했다. 기록이 없는 legacy graph는 `orchestrated`로 해석한다.
- **구현 완료:** Direct와 Planned를 `devExecution.executionMode` 정책으로 제공하고 `adaptive`에서는 실행 AI가 repository evidence로 선택한다.
- **구현 완료:** Planned는 2–5개의 ordered checkpoint, 실제 command verification, resume의 다음 checkpoint 안내, pending checkpoint finish 차단을 제공한다.
- **구현 완료:** Orchestrated는 기존 task graph를 그대로 사용하며 mode별 start/resume/close/schema/handoff 회귀 테스트를 추가했다.
- **Task-decomposition 평가 완료:** §13의 동일 fixture/model-profile 7쌍을 실행했고 모든 pair에서 B의 fixture 품질·자율성 지표가 A보다 나쁘지 않았다. Production lifecycle 비용과 장기 success rate는 이 결과의 범위가 아니다.

### Phase 3 — 기본값 전환과 호환 정리

- **구현 완료:** 새 project의 생성 기본값을 `adaptive`로 바꿨다.
- **구현 완료:** 기존 config에 mode가 없으면 `orchestrated`로 해석하고, 기존 project와 historical iteration은 기록된 mode 또는 legacy graph를 계속 사용한다.
- **구현 완료:** 새 historical milestone sidecar를 만들던 `p2a iteration promote-milestone` writer를 제거했다.
- **호환 유지:** `p2a.task_graph.v1`, milestone sidecar, historical run의 reader·validator·eval·handoff 경로는 적어도 하나의 명시된 호환 기간 동안 유지한다.
- **정리 완료:** §13 UI fixture 기록과 현재 visual contract를 근거로 task-level 사용자 시각 승인 반복을 제거하고 owner 자동 render/review loop로 대체했다. Historical reader는 active writer가 없는 호환 계층으로 명시 유지하며, 추가 제거는 별도 release-period migration audit에서 판단한다.

## 13. 평가 기록과 운영 계측

개선 결정 당시 현재 방식과 개선 방식을 동일한 요구사항, repository snapshot, 모델 profile에서 일회성으로 비교했다. 완료 뒤에는 같은 fixture 평가를 반복하지 않고 production run telemetry로 실제 운영 품질과 비용을 관찰한다.

### 비교군

- A: Gate B 목표를 사전 저작된 2–3개 task로 분해해 task별 실행
- B: 같은 Gate B 목표 전체를 한 objective로 전달해 AI가 adaptive mode 선택

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
| implementation-decision interruption count | 구현 선택을 사용자에게 되물은 횟수 | Phase 0 run interruption 수동 주석 구현 완료¹ |
| valid Gate return precision | 실제 계약 변경이 필요했던 Gate 복귀 비율 | Phase 0 Gate-return event + valid/invalid 판정 주석 구현 완료¹ |
| first-pass acceptance rate | 첫 구현의 Gate acceptance 만족률 | Phase 0 run index/monitor verdict 파생 구현 완료² |
| user correction count | 요구사항 또는 UI를 다시 설명한 횟수 | Phase 0 run interruption 수동 주석 구현 완료¹ |
| rework run count | 완료 뒤 다시 열린 실행 단위 수 | Phase 0 task 상태와 run index 파생 구현 완료² |
| integration defect count | 단위 통과 뒤 통합에서 발견된 결함 수 | Phase 0 milestone/acceptance verdict 파생 구현 완료²; 봉인에서 pass 강제 |
| visual drift count | 승인 matrix와 다른 결과 수 | Phase 0 visual review sidecar 파생 구현 완료²; 봉인에서 visual 강제 |
| scope violation count | non-goal 또는 승인 밖 변경 수 | Phase 0 monitor `scope_concerns` 집계 구현 완료² |
| rule violation count | constitution·권한·안전 위반 수 | Phase 0 monitor `rule_concerns` 구현 완료; 명시적 rule contract가 있는 verdict만 집계³ |
| elapsed time | Gate B 승인부터 close-ready까지 시간 | Phase 0 Gate approval timestamp + terminal run timestamp 파생 구현 완료² |
| prompt/input tokens | 반복 설명과 context 비용 | Phase 0 증분 `run.usage` sample 구현 완료¹ |
| verification evidence completeness | 실제 실행 증거의 완전성 | Phase 0 run `verification` + required monitor verdict 파생 구현 완료² |

¹ 같은 수동 주석 protocol을 적용한 run만 비교하며, 미계측 과거 run은 자율 완료 분모에서 제외한다. 토큰 합계는 usage coverage와 함께 해석한다. ² 기존 run/review 산출물에서 파생한다. ³ `rule_review_coverage_rate`와 함께 해석하며, approved constitution/legacy style이 없거나 명시적 rule contract가 없는 verdict의 0을 “위반 없음”으로 사용하지 않는다.

Adaptive 기본값 전환 판단에서는 추가 구현 지시 없이 완료하는 비율과 불필요한 구현 선택 질문을 비교했고, 실패율·scope violation·UI drift가 악화되지 않는 조건을 함께 적용했다. 전환 뒤의 production 품질은 같은 원칙을 `p2a eval digest` coverage와 함께 관찰하며 시간/token 개선만으로 품질 저하를 정당화하지 않는다.

### Task-decomposition 평가 결과 — 로컬 실행 기록

2026-08-14에 7개 category를 `gpt-5.6-luna/medium` profile로 실행했다. A는 사전 저작된 15개 task prompt를 순차 실행했고 B는 7개 objective prompt를 실행해 모두 `direct`를 선택했다. 아래 수치는 당시 로컬 report의 역사적 기록이다. Raw provider JSONL·snapshot·screenshot·report는 version control에서 제외했으므로 이 표를 재현 가능한 정본 evidence나 통계적 benchmark로 해석하지 않는다.

이 평가는 개선 방향 선택이라는 목적을 달성했으므로 전용 manifest·runner·fixture·schema·회귀 테스트를 저장소에서 제거했다. 향후 모델이나 실행 정책이 크게 바뀌어 새 비교가 필요하면 당시 코드를 상시 유지하지 않고, 새 질문과 현재 production 계약에 맞는 별도 평가를 설계한다.

| 지표 | A | B | B 변화 |
| --- | ---: | ---: | ---: |
| acceptance | 7/7 | 7/7 | 동일 |
| execution task | 15 | 7 | -53.3% |
| provider call | 26 | 17 | -34.6% |
| input token | 2,276,923 | 1,110,699 | -51.2% |
| output token | 35,991 | 20,647 | -42.6% |
| aggregate elapsed | 995,574ms | 556,792ms | -44.1% |
| first-pass acceptance | 4/7 | 5/7 | +1 fixture |
| quality rework | 1 | 0 | -1 |
| integration defect | 1 | 0 | -1 |
| implementation-decision interruption / user correction | 0 / 0 | 0 / 0 | 동일 |
| final visual drift / allowed-path scope violation | 0 / 0 | 0 / 0 | 동일 |

초기 UI 캡처에서 macOS headless Chrome가 요청한 390px 대신 `innerWidth=500`으로 layout한 뒤 이미지를 390px로 잘라 false overflow를 만들었다. CDP `Emulation.setDeviceMetricsOverride`와 runtime dimension assertion으로 이를 수정하고, 실패 호출과 screenshot은 지우지 않고 보존했다. 이 환경 재시도는 A/B 각각 2건으로 별도 `infrastructure_retry_runs`에 분류해 quality rework에서는 제외했지만 provider call/token/time 합계에는 보수적으로 포함했다.

당시 모든 pair에서 B의 fixture-level `quality_no_worse`와 `autonomy_no_worse`가 참이었고 UI 두 pair의 exact-viewport 최종 drift와 user correction도 0이었다. 이 결과는 task-level 사용자 시각 승인 반복을 owner 자동 render/review loop로 바꾸고, task decomposition을 필요할 때만 사용하는 방향을 지지한다. 다만 runner는 production `p2a execute` lifecycle, worktree, 독립 monitor 또는 acceptance reviewer를 실행하지 않았으므로 전체 하네스 시간/token 절감이나 constitution rule review 품질의 증거로 사용하지 않는다. 한 model profile의 fixture당 한 쌍이라 모델 일반화나 통계적 유의성도 주장하지 않으며, production success rate와 비용은 별도 장기 telemetry 범위다.

## 14. 우선순위와 실행 순서

우선순위는 중요도, Phase는 실행 순서다.

| 우선순위 | Phase | 개선 | 이유 |
| --- | --- | --- | --- |
| P0 | 0 | monitor에 constitution architecture/stack/prohibitions/style 검사 추가 **(완료)** | 명시적으로 monitor를 요구한 production run에서만 rule contract를 검사한다. 일회성 A/B는 이 lifecycle을 평가하지 않았다. |
| P0 | 1 | style·milestone review pass와 사이드카 규칙 제거 **(완료)** | Monitor가 활성화된 run만 하나의 rule contract를 사용하고 historical reader는 유지한다. |
| P0 | 0 | Claude agent generator의 `model:` pin 제거 **(완료)** | 세션 모델을 상속해야 생산자보다 약한 심사자 고정을 없애고 §13 model profile A/B가 가능하다. |
| P0 | 1 | `schemas/spec.schema.json`의 `product`에 `must_preserve` 추가 **(완료)** | Historical v1 spec은 빈 목록으로 호환하고 새 spec은 필수 저작한다. |
| P0 | 1 | 자율 차단 조항 정리 **(완료)** | Confined post-Gate loop와 승인된 개발 action의 자동 진행을 허용하되 proposal write는 승인 대상으로 유지하고 web 조사는 필요한 외부 근거가 있을 때만 사용한다. |
| P0 | 1 | `10~50 task` 고정 지침 제거 **(완료)** | 개수가 아닌 실제 운영 경계로 분할한다. |
| P0 | 1 | 실행 owner를 objective owner로 확장하고 Gate-derived envelope 전달 **(완료)** | 새 run에 envelope/hash를 고정하고 source drift를 검증한다. |
| P0 | 1 | 현재 시각 계약과 owner render evidence를 공통 close 조건에 연결 **(완료)** | reviewer 옵션과 제품 acceptance를 분리했다. |
| P1 | 2 | direct/planned를 기존 run/verify 기록 위에 제공 **(완료)** | synthetic 호환 work item과 ordered verify checkpoint를 쓰고 orchestrated graph는 필요한 경우만 유지한다. |
| P1 | 2 | task/model/UI eval과 acceptance 정책 정리 **(완료)** | 7-fixture 동일-profile task-decomposition 비교를 기록하고 반복 사용자 시각 승인을 제거했다. 독립 acceptance는 기본 `opt_in`으로 낮췄다. |
| P2 | 3 | legacy graph와 중복 milestone/batch 기구 정리 **(완료)** | 새 milestone promotion writer는 제거했다. Orchestrated batch와 historical graph/schema reader는 writer 없는 명시적 호환 계층으로 유지하며, 향후 제거는 별도 migration audit 범위다. |

## 15. 완료 조건

이 개선안의 구현은 다음 조건을 모두 만족할 때 완료로 본다.

- Gate B 뒤 task별 승인 없이 자율 개발이 시작되고, AI가 repository evidence로 mode·계획·구현·실패 수정을 소유한다.
- 계약 변경 때만 충돌 field와 최소 결정 요청으로 Gate에 복귀하며 모든 mode가 spec hash, acceptance와 실제 verification evidence를 보존한다.
- Direct는 사람 저작 graph 없이 동작하고, Planned는 checkpoint 재개를, Orchestrated는 기존 dependency·batch·history 호환을 유지한다.
- UI는 승인 contract와 capture matrix의 실제 render evidence 없이는 close-ready가 되지 않는다.
- 일반 경로는 current owner·isolation `none`·task verification을 기본으로 하며, 별도 implementer/worktree/monitor/acceptance/retrospective는 명시 조건이 있을 때만 활성화한다.

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
> Gate가 계약을 소유하고, AI가 구현을 소유하며, 필요한 경우에만 하나의 독립 reviewer가 규칙을 검사한다.<br>
> **기본 경로에는 실제로 필요한 검증만 남기고, 고비용 격리·review·회고 기구는 조건이 성립할 때만 활성화한다.**
