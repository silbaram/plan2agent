# Plan2Agent 반복/고도화 개발 아키텍처

참고 기준일: 2026-06-12

이 문서는 Plan2Agent(P2A)가 MVP 이후 기존 프로젝트에 기능을 이어 추가하는 반복/고도화 개발 구조를 정의한다. 현재 v1 하네스가 `idea -> intake -> spec -> task graph -> review`의 greenfield 반바퀴를 고정했다면, 이 문서는 그 다음에 오는 `변경 -> 명세 -> task -> 실행` 순환의 나머지 반바퀴를 파일 기반 아키텍처로 고정한다.

이 문서는 설계 기준이다. 코드, skill, schema, validator, handoff 명령을 변경하지 않는다.

## 1. 배경/목적

Plan2Agent의 핵심 가치는 기획의 변경 사항이 agent가 실행 가능한 명세와 task로 이어지고, 그 과정과 결과가 시맨틱 문서로 남는 순환 시스템을 만드는 것이다. `plans/01-product-roadmap.md` §1은 이 가치를 제품의 출발점으로 둔다.

현재 greenfield 흐름은 다음 한 바퀴의 앞쪽만 담당한다.

```text
한 문장 아이디어 -> intake -> spec -> task graph -> review -> handoff
```

MVP 이후에는 이미 만들어진 산출물과 대상 프로젝트 위에 작은 기능, 개선, 수정, 재작업을 계속 얹어야 한다. 이 문서는 그 반복 흐름을 정의한다.

연결 기준:

- `plans/01-product-roadmap.md` §9의 변경 추적 방식은 “새 버전의 명세와 task graph” 및 v2 이후 구조적 diff를 백로그로 둔다. 본 문서는 구조적 diff 자동화 이전에 파일 기반 반복 단위를 먼저 고정한다.
- `plans/01-product-roadmap.md` §14의 “기획 변경 diff 기반 재작업 task 생성” 백로그는 본 문서의 반복/고도화 구조 위에서 구현한다.
- `plans/03-v2-development-handoff.md`의 개발 인계는 단일 Gate D 산출물 인계를 다룬다. 본 문서는 인계 이후 다음 반복 산출물을 어떻게 쌓고 다시 인계할지 정의한다.

## 2. 확정 아키텍처

### 2-1. 분절 단위는 iteration이다

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
- 반복 전환은 암묵적으로 일어나지 않는다. “모든 task done”과 “사용자 close”가 모두 만족될 때만 마감한다.
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
    maintenance/
      gate-c-task-graph/
        task-graph.json
```

`status.md`는 기존 v1의 standing 진행상태/결정 인덱스 역할을 확장해 반복 인덱스와 현재 활성 포인터를 함께 갖는다. `current-spec.json`은 모든 완료 반복의 유효 spec을 조합한 현재 기준이며, 다음 intake/spec 단계가 baseline으로 읽는 파일이다.

`maintenance`는 작은 변경의 집이다. 가벼운 fix를 위해 매번 전체 Gate A~D를 강제하지 않고 task graph 중심으로 관리한다. 단, 제품 의미가 바뀌는 변경은 별도 기능 반복을 열어 Gate A~D를 다시 통과한다.

### 2-4. 교차 의존은 느슨한 전제 참조로 둔다

교차 반복 의존성은 `dependencies`에 직접 넣지 않는다. 각 반복의 task graph는 자기완결 그래프다.

| 대안 | 채택 여부 | 이유 |
| --- | --- | --- |
| a. 느슨한 전제 참조 | 채택 | 현재 task graph schema와 validator를 바꾸지 않고 반복을 쌓을 수 있다. |
| b. 반복 간 dependency 검증 | 기각 | `iter-id/task-id` 같은 새 참조 형식과 cross-graph validator가 필요하다. |
| c. 반복마다 baseline snapshot task 삽입 | 기각 | 완료된 과거 task를 새 그래프에 복제해 단일 정본을 흐린다. |

채택안(a)의 규칙:

- 각 반복의 `dependencies`는 같은 반복 안의 task id만 참조한다.
- 이전 반복은 생명주기상 “전부 done인 baseline”으로 전제한다.
- “v1 위에 짓는다”, “starter 배포 구조를 전제로 한다” 같은 문맥은 task `description`과 `sourceSpecRefs`로 기록한다.
- `sourceSpecRefs`는 `current-spec.json`의 안정적인 spec 항목 id 또는 반복 spec 항목을 가리킨다.

이 규칙은 현재 task graph 계약과 맞다. schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 이미 포함하며, validator는 task id 집합을 만든 뒤 각 `dependencies` 항목이 그 집합에 있는지 확인한다. 따라서 반복 간 dependency를 `dependencies`에 넣지 않으면 schema와 validator를 변경하지 않아도 된다.

## 3. 핵심 원칙

| 원칙 | 설명 |
| --- | --- |
| 1. append-only | 닫힌 반복은 수정하지 않는다. 변경, 누락, 재작업은 다음 반복의 새 task로 남긴다. |
| 2. bounded iteration | 반복 하나가 너무 커지면 리뷰, handoff, task 실행이 어려워진다. 10~50 task를 기본 상한으로 보고 큰 기능은 분할한다. |
| 3. maintenance | 작은 fix와 운영성 변경은 상시 maintenance 반복에 모아 기능 반복의 의미를 흐리지 않는다. |
| 4. current-effective view | 사용자가 보는 현재 기준은 단일 `current-spec.json`이다. 과거 반복의 개별 spec은 history이고, 다음 기획의 baseline은 current-effective view다. |

## 4. 재사용 vs 신규

### 재사용

| 항목 | 재사용 방식 |
| --- | --- |
| Gate A~D | 반복마다 기존 intake/spec/task/review 게이트 한 벌을 재사용한다. |
| task graph schema | `schemas/task-graph.schema.json`을 그대로 사용한다. |
| artifact validator | `scripts/validate_artifacts.mjs`를 그대로 사용한다. |
| task graph/task 필드 | top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 반복 개발의 versioning, 상태, 영역 태그, spec trace에 사용한다. |
| git | 반복 close와 handoff 기준점을 커밋으로 남긴다. |
| `p2a_handoff` | 활성 반복 산출물과 `current-spec.json`을 대상 프로젝트로 다시 동기화하는 흐름에 재사용한다. |

### 신규

| 항목 | 신규 책임 |
| --- | --- |
| baseline-aware intake/spec | 현재 유효 spec과 변경 아이디어를 함께 읽어 다음 반복의 delta spec과 새 task 후보를 만든다. 반복 개발의 유일한 핵심 신규 기능이다. |
| 활성 반복 인식 | task CLI와 handoff가 루트 `status.md`에서 현재 활성 반복의 task graph 경로를 찾는다. |
| `status.md` 반복 인덱스 | 반복 목록, 상태, 활성 포인터, close 시점, handoff 기준점을 기록한다. |
| `current-spec.json` 조합 | 닫힌 반복 spec과 maintenance 변경 중 현재 유효한 기준을 하나로 조합한다. |
| 반복 open/close | 새 반복 생성, 완료 검증, archived 표시, 다음 반복 open을 명령화한다. |
| handoff 적응 | `p2a_handoff --overwrite`로 대상 프로젝트의 `.plan2agent` 기준 산출물을 최신 반복 기준으로 덮어쓴다. |

중요한 제한은 schema와 validator를 바꾸지 않는 것이다. 교차 의존을 느슨한 전제 참조로 두는 결정 덕분에 task graph의 단일 정본과 검증 규칙을 유지한다. 이는 “변경 최소, 단일 정본” 원칙과 일관된다.

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

## 6. 구현 조각 순서

의존 순서는 다음과 같다.

| 순서 | 조각 | 이유 |
| --- | --- | --- |
| 1 | 레이아웃·인덱스 규약 + wisp migration | 기존 gate-* 산출물을 반복 구조로 옮기는 기준이 먼저 필요하다. |
| 2 | `status.md` = 반복 인덱스 | 활성 반복과 archived 반복을 도구가 찾을 수 있어야 한다. |
| 3 | `current-spec.json` 조합 규칙 | baseline-aware intake/spec의 입력 기준을 고정한다. |
| 4 | `p2a_tasks` 활성-반복 인식 | task 상태 변경이 현재 반복 graph에 적용되어야 한다. |
| 5 | baseline-aware intake/spec skill | 현재 유효 spec + 변경 아이디어 -> 다음 반복 delta를 만드는 핵심 신규 기능이다. |
| 6 | handoff 적응 | 활성 반복 산출물과 current-effective view를 대상 프로젝트로 덮어쓴다. |
| 7 | 반복 open/close 명령 | 반복 생성, 마감, archived 표시, 다음 반복 open을 자동화한다. |

이 순서에서는 먼저 파일 규약과 인덱스를 고정하고, 그 다음 도구가 같은 경로 규약을 읽게 만든다. baseline-aware skill은 경로와 current-effective view가 안정된 뒤 붙인다.

## 7. wisp migration 예시

현재 v1 산출물이 다음 형태라고 가정한다.

```text
artifacts/wisp-spring-starter/
  status.md
  gate-a-intake/
  gate-b-spec/
  gate-c-task-graph/
  gate-d-review/
```

반복 구조로의 1차 migration은 이 산출물을 MVP 반복으로 감싸는 작업이다.

```text
artifacts/wisp-spring-starter/
  status.md                         # 반복 인덱스로 재작성
  current-spec.json                 # v1 MVP spec을 현재 유효 spec으로 조합
  iterations/
    v1-mvp/
      gate-a-intake/
      gate-b-spec/
      gate-c-task-graph/
      gate-d-review/
    maintenance/
      gate-c-task-graph/
        task-graph.json
```

migration 규칙:

1. 기존 `gate-a-intake/`, `gate-b-spec/`, `gate-c-task-graph/`, `gate-d-review/`를 `iterations/v1-mvp/` 아래로 이동한다.
2. 루트 `status.md`는 standing 진행상태 문서에서 반복 인덱스로 확장한다.
3. 루트 `current-spec.json`은 `iterations/v1-mvp/gate-b-spec/spec.json`을 기준으로 생성한다.
4. `v1-mvp` 반복은 이미 Gate D를 통과한 baseline으로 보고 `archived` 또는 `closed` 상태로 표시한다.
5. 다음 기능 추가는 새 반복을 열고, 작은 fix는 `iterations/maintenance/gate-c-task-graph/task-graph.json`에 append한다.
6. 도구는 루트 `status.md`의 활성 반복 graph 경로를 읽어 `p2a_tasks`와 handoff 입력을 결정한다.

이 저장소에는 현재 `artifacts/wisp-spring-starter/` fixture가 추적되어 있지 않으므로, 위 migration은 기존 v1 gate 레이아웃과 `status.md` 계약을 기준으로 한 대상 형태 예시다.

## 8. 비목표/후속 고도화

이 문서의 비목표:

- 기존 코드베이스를 자동으로 읽고 spec을 역생성하는 brownfield code-aware intake
- 구조적 diff 기반 재작업 task 자동 생성
- roadmap §9의 이전 spec/새 spec 구조적 diff 계산과 task 자동 연결
- 병렬 반복, branch별 반복, worktree별 반복
- agent 자동 실행, 실행 로그 수집, 결과 diff 자동 병합
- DB, pgvector, Neo4j 기반 plan-code 계보 저장

후속 고도화는 이 문서의 iteration 레이아웃, `status.md` 반복 인덱스, `current-spec.json` current-effective view를 전제로 붙인다. 구조적 diff와 코드 변경 연결은 반복 단위가 안정된 뒤 자동화한다.

## 9. 검증 메모

- roadmap §9의 “새 버전의 명세와 task graph”는 반복별 `gate-b-spec/spec.json`과 `gate-c-task-graph/task-graph.json`으로 구체화한다.
- roadmap §14의 “기획 변경 diff 기반 재작업 task 생성”은 후속 자동화이며, 본 문서는 그 전에 필요한 파일 기반 반복 구조를 정의한다.
- task graph schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 요구한다.
- validator는 같은 task graph 안의 task id 집합을 만든 뒤 `dependencies`가 그 집합 안에 있는지 검사하므로, 반복 간 dependency를 넣지 않는 채택안(a)은 schema/validator 변경 없이 적용 가능하다.
