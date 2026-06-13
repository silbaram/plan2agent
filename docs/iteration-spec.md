# Plan2Agent 반복/고도화 개발 스펙

참고 기준일: 2026-06-14

이 문서는 Plan2Agent(P2A)가 MVP 이후 기존 프로젝트에 기능을 이어 추가하는 반복/고도화 개발 구조를 정의한다. `plans/01-product-roadmap.md`는 제품 방향과 상태 요약을 담고, 이 문서는 다회차 기획과 개발 운영에 필요한 구현 계약을 더 자세히 고정한다.

현재 구현 상태:

- 구현됨: `scripts/p2a_iteration.mjs init`으로 greenfield `artifacts/<project_id>/gate-*` 산출물을 `iterations/<iter-id>/gate-*` 구조로 변환한다.
- 구현됨: 변환 시 루트 `status.md`, `current-spec.json`, lazy `iterations/maintenance/README.md`를 생성한다.
- 구현됨: 이동된 spec, task graph, review를 다시 검증하고 `task-graph.sourceSpec`를 반복 구조 기준으로 rebase한다.
- 미구현: 새 반복 open/close 명령, archived 동결, active iteration 자동 인식, `current-spec.json` 다중 조합, baseline-aware intake/spec, 반복 구조 handoff 적응.
- 미구현: 구조적 diff 기반 재작업 task 생성, agent 실행 로그, worktree 분리, 결과 diff 연결.

## 1. 배경과 목적

Plan2Agent의 핵심 가치는 기획의 변경 사항이 agent가 실행 가능한 명세와 task로 이어지고, 그 과정과 결과가 시맨틱 문서로 남는 순환 시스템을 만드는 것이다.

현재 v1 greenfield 흐름은 다음 한 바퀴의 앞쪽을 담당한다.

```text
한 문장 아이디어 -> intake -> spec -> task graph -> review -> handoff
```

MVP 이후에는 이미 만들어진 산출물과 대상 프로젝트 위에 작은 기능, 개선, 수정, 재작업을 계속 얹어야 한다. 반복/고도화 구조는 그 다음에 오는 흐름을 파일 기반으로 고정한다.

```text
변경 아이디어 -> baseline-aware intake/spec -> 새 task graph -> review -> handoff/update -> 개발
```

연결 기준:

- `plans/01-product-roadmap.md` §9의 변경 추적 방식은 “새 버전의 명세와 task graph” 및 v2 이후 구조적 diff를 백로그로 둔다.
- `plans/01-product-roadmap.md` §14의 “기획 변경 diff 기반 재작업 task 생성”은 이 문서의 반복 구조 위에서 구현한다.
- `plans/01-product-roadmap.md` §8-1의 개발 인계는 단일 Gate D 산출물 인계를 다룬다. 이 문서는 인계 이후 다음 반복 산출물을 어떻게 쌓고 다시 인계할지 정의한다.

## 2. 확정 아키텍처

### 2-1. 분절 단위는 `iteration`이다

반복 개발의 분절 단위는 `iteration`이다.

| 결정 | 기준 |
| --- | --- |
| 단위 | 기능 반복 또는 고도화 반복 하나 |
| 저장 방식 | append-only. 아카이브된 반복은 불변으로 두고, 변경은 다음 반복의 새 task로 만든다. |
| 크기 | bounded. 반복 하나는 대략 10~50 task 안에 들어오게 하고, 큰 기능은 여러 반복으로 나눈다. |
| 영역 | `core`, `cluster`, `starter` 같은 영역은 분절 축이 아니라 task의 `targetArea` 태그로 둔다. |

근거는 “끝나는 단위”다. 아카이브하려면 명시적으로 끝나는 단위가 필요하다. 반복은 사용자 close와 모든 task 완료로 끝나지만, `core`, `cluster`, `starter` 같은 영역은 계속 살아 있는 제품 영역이므로 아카이브 단위가 되기 어렵다. 영역은 조회와 필터링을 위해 `task.targetArea`에 남긴다.

### 2-2. 생명주기는 활성 기능 반복 1개 + maintenance 반복 1개다

기본 생명주기는 선형 진행으로 둔다.

```text
open iteration -> task 실행 -> 모든 task done -> 사용자 close -> archived -> next iteration open
```

규칙:

- 동시에 열린 기능 반복은 1개다.
- 작은 fix, 문서 수정, 패치성 변경은 상시 `maintenance` 반복에 append한다.
- 반복 전환은 암묵적으로 일어나지 않는다. 모든 task done과 사용자 close가 모두 만족될 때만 마감한다.
- 마감 시 해당 반복을 `archived`로 동결하고, 루트 `status.md` 반복 인덱스에 표시한다.
- 마감 시 필요하면 개발 대상 프로젝트로 재인계하고 git 커밋으로 산출물 기준점을 남긴다.
- 병렬 반복, branch별 반복, worktree별 반복은 후속 고도화로 둔다.

이 결정은 현재 task 상태 CLI가 단일 task graph를 기준으로 동작하는 단순성을 유지한다. 활성 반복 인식은 “현재 어떤 task graph를 볼 것인가”의 선택 문제로 제한한다.

### 2-3. 레이아웃은 루트 인덱스 + current-spec + 반복별 게이트다

반복 개발 산출물은 `artifacts/<project>/` 아래에 다음 구조로 둔다.

```text
artifacts/<project>/
  status.md                         # 반복 인덱스 + 현재 활성 포인터
  current-spec.json                 # 현재 유효 spec 조합본, baseline-aware 기획 컨텍스트
  iterations/
    <iter-id>/
      gate-a-intake/
        intake.json
        intake.md
      gate-b-spec/
        product-spec.md
        implementation-plan.md
        spec.json
      gate-c-task-graph/
        task-graph.json
      gate-d-review/
        review-report.md
        review.json
    maintenance/
      README.md
      gate-c-task-graph/
        task-graph.json
```

`status.md`는 기존 v1의 standing 진행상태/결정 인덱스 역할을 확장해 반복 인덱스와 현재 활성 포인터를 함께 갖는다. `current-spec.json`은 모든 완료 반복의 유효 spec을 조합한 현재 기준이며, 다음 intake/spec 단계가 baseline으로 읽는 파일이다.

현재 구현은 첫 반복 하나를 가리키는 thin pointer만 만든다. 다중 반복 composition은 아직 구현되지 않았다.

### 2-4. `maintenance`는 작은 변경의 집이다

`maintenance`는 작은 fix, 문서 수정, 패치성 변경을 모으는 상시 반복이다. 가벼운 fix를 위해 매번 전체 Gate A-D를 강제하지 않고 task graph 중심으로 관리한다.

다만 제품 의미가 바뀌는 변경은 `maintenance`에 넣지 않는다. 사용자 흐름, API, 데이터 모델, 성공 기준, 보안/운영성 기준이 바뀌면 별도 기능 반복을 열어 Gate A-D를 다시 통과한다.

### 2-5. 교차 의존은 느슨한 전제 참조로 둔다

교차 반복 의존성은 `dependencies`에 직접 넣지 않는다. 각 반복의 task graph는 자기완결 그래프다.

| 대안 | 채택 여부 | 이유 |
| --- | --- | --- |
| 느슨한 전제 참조 | 채택 | 현재 task graph schema와 validator를 바꾸지 않고 반복을 쌓을 수 있다. |
| 반복 간 dependency 검증 | 기각 | `iter-id/task-id` 같은 새 참조 형식과 cross-graph validator가 필요하다. |
| 반복마다 baseline snapshot task 삽입 | 기각 | 완료된 과거 task를 새 그래프에 복제해 단일 정본을 흐린다. |

채택안의 규칙:

- 각 반복의 `dependencies`는 같은 반복 안의 task id만 참조한다.
- 이전 반복은 생명주기상 전부 done인 baseline으로 전제한다.
- “v1 위에 짓는다”, “starter 배포 구조를 전제로 한다” 같은 문맥은 task `description`과 `sourceSpecRefs`로 기록한다.
- `sourceSpecRefs`는 `current-spec.json`의 안정적인 spec 항목 id 또는 반복 spec 항목을 가리킨다.

이 규칙은 현재 task graph 계약과 맞다. schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 이미 포함하며, validator는 task id 집합을 만든 뒤 각 `dependencies` 항목이 그 집합에 있는지 확인한다. 따라서 반복 간 dependency를 `dependencies`에 넣지 않으면 schema와 validator를 변경하지 않아도 된다.

## 3. 핵심 원칙

| 원칙 | 설명 |
| --- | --- |
| append-only | 닫힌 반복은 수정하지 않는다. 변경, 누락, 재작업은 다음 반복의 새 task로 남긴다. |
| bounded iteration | 반복 하나가 너무 커지면 review, handoff, task 실행이 어려워진다. 10~50 task를 기본 상한으로 보고 큰 기능은 분할한다. |
| maintenance | 작은 fix와 운영성 변경은 상시 maintenance 반복에 모아 기능 반복의 의미를 흐리지 않는다. |
| current-effective view | 사용자가 보는 현재 기준은 단일 `current-spec.json`이다. 과거 반복의 개별 spec은 history이고, 다음 기획의 baseline은 current-effective view다. |

## 4. 재사용과 신규 책임

### 재사용

| 항목 | 재사용 방식 |
| --- | --- |
| Gate A-D | 반복마다 기존 intake/spec/task/review 게이트 한 벌을 재사용한다. |
| task graph schema | `schemas/task-graph.schema.json`을 그대로 사용한다. |
| artifact validator | `scripts/validate_artifacts.mjs`를 반복 내부 gate 검증에 재사용한다. |
| task graph/task 필드 | top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 반복 개발의 versioning, 상태, 영역 태그, spec trace에 사용한다. |
| git | 반복 close와 handoff 기준점을 커밋으로 남긴다. |
| `p2a_handoff` | 활성 반복 산출물과 `current-spec.json`을 대상 프로젝트로 다시 동기화하는 흐름에 재사용한다. |

### 신규

| 항목 | 신규 책임 |
| --- | --- |
| baseline-aware intake/spec | 현재 유효 spec과 변경 아이디어를 함께 읽어 다음 반복의 delta spec과 새 task 후보를 만든다. |
| 활성 반복 인식 | task CLI와 handoff가 루트 `status.md`에서 현재 활성 반복의 task graph 경로를 찾는다. |
| `status.md` 반복 인덱스 | 반복 목록, 상태, 활성 포인터, close 시점, handoff 기준점을 기록한다. |
| `current-spec.json` 조합 | 닫힌 반복 spec과 maintenance 변경 중 현재 유효한 기준을 하나로 조합한다. |
| 반복 open/close | 새 반복 생성, 완료 검증, archived 표시, 다음 반복 open을 명령화한다. |
| handoff 적응 | `p2a_handoff --overwrite`로 대상 프로젝트의 `.plan2agent` 기준 산출물을 최신 반복 기준으로 덮어쓴다. |

중요한 제한은 schema와 validator를 불필요하게 바꾸지 않는 것이다. 교차 의존을 느슨한 전제 참조로 두는 결정 덕분에 task graph의 단일 정본과 검증 규칙을 유지한다.

## 5. 반복 개발 흐름

```text
현재 유효 spec(current-spec.json)
  + 변경 아이디어
      |
      v
baseline-aware Gate A/B 재실행
      |
      v
다음 반복 생성
  - delta spec
  - 새 task graph
  - 과거 done 보존
      |
      v
status.md/current-spec.json 갱신
  + git 커밋
      |
      v
p2a_handoff --overwrite
      |
      v
대상 프로젝트 .plan2agent 동기화
      |
      v
p2a_tasks로 이어서 개발
```

세부 흐름:

1. 사용자는 현재 프로젝트의 `current-spec.json`과 변경 아이디어를 입력한다.
2. baseline-aware intake/spec가 기존 spec과 변경 요청의 차이를 질문과 delta spec으로 정리한다.
3. 승인된 delta spec은 새 반복의 `gate-b-spec/spec.json`으로 저장된다.
4. task breakdown은 새 반복 안에서만 자기완결 `task-graph.json`을 만든다.
5. review가 통과하면 루트 `status.md`의 활성 포인터가 새 반복을 가리킨다.
6. 반복 실행 중 task 상태 변경은 활성 반복의 task graph에만 적용한다.
7. 반복 close 시 `current-spec.json`을 갱신하고, 필요하면 `p2a_handoff --overwrite`로 대상 프로젝트를 동기화한다.

## 6. 명령 계약

### 6-1. 현재 구현된 명령

```bash
node scripts/p2a_iteration.mjs init \
  --artifacts artifacts/<project_id> \
  --iteration-id v1-mvp
```

`init`은 기존 greenfield 산출물을 첫 반복으로 감싼다.

1. 기존 `gate-a-intake/`, `gate-b-spec/`, `gate-c-task-graph/`, `gate-d-review/`를 `iterations/<iteration-id>/` 아래로 이동한다.
2. 루트 `status.md`는 반복 인덱스로 재작성한다.
3. 루트 `current-spec.json`은 `iterations/<iteration-id>/gate-b-spec/spec.json`을 가리키는 thin pointer로 생성한다.
4. `iterations/maintenance/README.md`를 만든다. 빈 task graph는 `schemas/task-graph.schema.json`의 최소 task 수 제약을 위반하므로 만들지 않는다.
5. 이동된 spec, task graph, review를 다시 검증한다.

### 6-2. 후속 명령 후보

```bash
node scripts/p2a_iteration.mjs open \
  --artifacts artifacts/<project_id> \
  --iteration-id <next-iter-id> \
  --idea "<change idea>"
```

후속 `open`은 `current-spec.json`과 변경 아이디어를 baseline-aware intake/spec 입력으로 사용해야 한다.

```bash
node scripts/p2a_iteration.mjs close \
  --artifacts artifacts/<project_id> \
  --iteration-id <iter-id>
```

후속 `close`는 다음을 확인해야 한다.

- 해당 반복의 Gate B-D가 통과됐다.
- task graph의 모든 task가 `done`이거나 사용자가 명시적으로 남긴 `deferred`/`non-goal` 상태로 처분됐다. 현재 task schema에는 `deferred`가 없으므로 v1에서는 모든 task `done`을 기본 조건으로 둔다.
- `review.json.blocking_issues`가 비어 있다.
- `current-spec.json` composition을 갱신할 수 있다.
- 루트 `status.md` 반복 인덱스가 archived 상태와 close 시점을 기록한다.

```bash
node scripts/p2a_iteration.mjs current --artifacts artifacts/<project_id>
```

후속 `current`는 active iteration id, task graph 경로, current spec 경로를 출력해 `p2a_tasks`와 `p2a_handoff`가 같은 기준을 읽게 한다.

## 7. `current-spec.json` 계약

현재 구현은 thin pointer다.

```json
{
  "schema_version": "p2a.current_spec.v1",
  "project_id": "example-project",
  "composed_from": ["v1-mvp"],
  "active_iteration": "v1-mvp",
  "effective_spec_ref": "iterations/v1-mvp/gate-b-spec/spec.json",
  "note": "반복 1개라 이 반복 spec이 곧 현재 유효 spec."
}
```

후속 composition 구현에서는 다음 필드를 추가한다.

```json
{
  "schema_version": "p2a.current_spec.v1",
  "project_id": "example-project",
  "active_iteration": "iter-002",
  "composed_from": ["v1-mvp", "iter-001", "iter-002"],
  "effective_spec_ref": "current-spec.json",
  "source_specs": [
    {
      "iteration_id": "v1-mvp",
      "spec_ref": "iterations/v1-mvp/gate-b-spec/spec.json",
      "status": "archived"
    }
  ],
  "effective_product": {},
  "effective_implementation": {},
  "overrides": [],
  "superseded_refs": []
}
```

조합 규칙:

- archived 반복은 history로 보존한다.
- 최신 반복이 명시적으로 대체한 spec 항목은 `superseded_refs`에 기록한다.
- `effective_product`와 `effective_implementation`은 다음 intake/spec가 읽을 현재 기준이다.
- 모호한 충돌은 자동 병합하지 않고 다음 반복의 `needs_user_decision` 또는 spec `open_decisions`로 올린다.

## 8. 검증 계약

반복 구조 validator는 후속 구현에서 다음을 확인해야 한다.

- 루트 `status.md`가 active iteration을 가리킨다.
- `current-spec.json.active_iteration`이 실제 `iterations/<id>/`와 일치한다.
- active iteration의 Gate A-D 산출물이 기존 `validate_artifacts.mjs` 검증을 통과한다.
- archived iteration은 append-only로 취급한다.
- 반복 내부 task dependencies는 같은 반복 안의 task id만 참조한다.
- `maintenance` task graph가 존재하면 일반 task graph schema를 통과한다.
- close 대상 반복은 `review.json.blocking_issues: []`이고 task가 모두 완료 상태다.

기존 `validate_artifacts.mjs --artifact-root`는 greenfield root 구조를 검증한다. 반복 구조 검증은 별도 옵션을 추가하거나 `p2a_iteration.mjs` 내부 validator로 시작한다.

후보 명령:

```bash
node scripts/validate_artifacts.mjs \
  --iteration-root artifacts/<project_id> \
  --require-active-ready
```

## 9. handoff 적응

기존 `p2a_handoff.mjs`는 greenfield `artifacts/<project_id>/gate-*` root를 전제로 한다. 반복 구조에서는 다음 중 하나를 선택해야 한다.

1. `--iteration-id <id>`를 명시해 특정 반복을 인계한다.
2. `current-spec.json.active_iteration`과 루트 `status.md`를 읽어 active 반복을 자동 선택한다.
3. 대상 프로젝트에는 `.plan2agent/artifacts/`에 active 반복 산출물을 배치하고, `.plan2agent/current-spec.json`도 함께 배치한다.

권장 기본값은 active 반복 자동 선택이다. 다만 명령형 재현성을 위해 `--iteration-id` override를 제공한다.

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target /path/to/project \
  --iteration-id active \
  --overwrite
```

## 10. 비목표와 후속 고도화

이 문서의 비목표:

- 기존 코드베이스를 자동으로 읽고 spec을 역생성하는 brownfield code-aware intake
- 구조적 diff 기반 재작업 task 자동 생성
- 이전 spec/새 spec 구조적 diff 계산과 task 자동 연결
- 병렬 반복, branch별 반복, worktree별 반복
- agent 자동 실행, 실행 로그 수집, 결과 diff 자동 병합
- DB, pgvector, Neo4j 기반 plan-code 계보 저장

후속 고도화는 이 문서의 iteration 레이아웃, `status.md` 반복 인덱스, `current-spec.json` current-effective view를 전제로 붙인다. 구조적 diff와 코드 변경 연결은 반복 단위가 안정된 뒤 자동화한다.

## 11. 구현 조각 순서

| 순서 | 조각 | 상태 | 이유 |
| --- | --- | --- | --- |
| 1 | 레이아웃/인덱스 규약 + greenfield migration | 부분 완료 | `p2a_iteration.mjs init`으로 초기 migration은 가능하다. |
| 2 | `status.md` 반복 인덱스 | 부분 완료 | 초기 active pointer는 생성하지만 open/close/archived 상태 전이는 없다. |
| 3 | `current-spec.json` 조합 규칙 | 미구현 | baseline-aware intake/spec의 입력 기준을 고정해야 한다. |
| 4 | `p2a_tasks` active iteration 인식 | 미구현 | task 상태 변경이 현재 반복 graph에 적용되어야 한다. |
| 5 | baseline-aware intake/spec skill | 미구현 | 현재 유효 spec + 변경 아이디어 -> 다음 반복 delta를 만드는 핵심 신규 기능이다. |
| 6 | handoff 적응 | 미구현 | 활성 반복 산출물과 current-effective view를 대상 프로젝트로 덮어쓴다. |
| 7 | 반복 open/close 명령 | 미구현 | 반복 생성, 마감, archived 표시, 다음 반복 open을 자동화한다. |
| 8 | 반복 fixture/golden | 미구현 | 다회차 회귀를 고정하려면 greenfield -> init -> open/close fixture가 필요하다. |

## 12. 검증 메모

- `plans/01-product-roadmap.md` §9의 “새 버전의 명세와 task graph”는 반복별 `gate-b-spec/spec.json`과 `gate-c-task-graph/task-graph.json`으로 구체화한다.
- `plans/01-product-roadmap.md` §14의 “기획 변경 diff 기반 재작업 task 생성”은 후속 자동화이며, 본 문서는 그 전에 필요한 파일 기반 반복 구조를 정의한다.
- task graph schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 요구한다.
- validator는 같은 task graph 안의 task id 집합을 만든 뒤 `dependencies`가 그 집합 안에 있는지 검사하므로, 반복 간 dependency를 넣지 않는 채택안은 schema/validator 변경 없이 적용 가능하다.
