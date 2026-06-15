# Plan2Agent 반복/고도화 개발 스펙

참고 기준일: 2026-06-15

이 문서는 Plan2Agent(P2A)가 MVP 이후 기존 프로젝트에 기능을 이어 추가하는 반복/고도화 개발 구조를 정의한다. `plans/01-product-roadmap.md`는 제품 방향과 상태 요약을 담고, 이 문서는 다회차 기획과 개발 운영에 필요한 구현 계약을 더 자세히 고정한다.

문서 홈: [Plan2Agent Docs](README.md) · 사용자 시작점: [Quickstart](quickstart.md)

## 0. 구현 범위 요약

이 문서는 완성된 CLI 계약과 후속 고도화 계약을 함께 담는다. 아래 표가 현재 구현 상태의 정본이다.

### 0-1. 구현 완료

| 범위 | 구현 | 검증 기준 |
| --- | --- | --- |
| greenfield -> iteration 변환 | `p2a_iteration.mjs init` | 기존 `gate-*` 산출물을 `iterations/<iter-id>/gate-*`로 이동하고, 이동된 spec/task/review를 재검증한다. |
| root index 생성 | `status.md`, `current-spec.json`, `iterations/maintenance/README.md` | active iteration marker와 thin current-spec pointer를 생성한다. |
| active iteration 해석 | `p2a_iteration.mjs current` | `current-spec.json.active_iteration`과 `status.md` marker를 대조하고 active 경로를 출력한다. |
| task CLI 반복 적응 | `p2a_tasks.mjs --artifacts` | active 반복의 `task-graph.json`을 자동 선택해 ready/prompt/start/done 전이를 수행하고, `--maintenance`로 maintenance 레인도 선택할 수 있다. |
| agent run 추적 | `p2a_runs.mjs start/verify/finish` | `runs/`에 task별 runId, changedFiles, verification, agentTool, workspaceRef, branch/worktree 격리 기준을 기록한다. |
| Gate B-D ready 검증 | `p2a_iteration.mjs validate` | active 반복의 approved spec, task graph, review pass, task dependency를 검증한다. |
| close-ready 검증 | `p2a_iteration.mjs validate --require-close-ready` | active 반복의 모든 task가 `done`인지 추가 확인한다. |
| planning stage 검증 | `p2a_iteration.mjs validate --allow-planning`, `--stage` | Gate A-ready, Gate B draft, Gate B approved 상태를 Gate B-D 누락 실패 없이 검증한다. |
| 반복 close | `p2a_iteration.mjs close` | close-ready active 반복을 `archived` metadata로 표시하고 `current-spec.json.closed_iterations`에 기록한다. |
| archived 감사 | `p2a_iteration.mjs validate` | close 시 기록한 artifact 존재 여부/hash와 현재 파일 상태를 기본 검증으로 비교한다. legacy/migration 상황은 `--skip-archive-audit`로 우회한다. |
| 다음 반복 open | `p2a_iteration.mjs open` | archived + composed baseline 위에 새 active 반복 skeleton과 `pending_iteration`을 생성한다. |
| Gate A/B draft | `p2a_iteration.mjs draft` | Gate A-only 초기 반복은 Gate B 초안을 만들고, baseline이 있는 반복은 delta Gate A/B 초안을 생성한다. |
| Gate B 승인 반영 | `p2a_iteration.mjs promote-spec` | approved active spec을 기록하고, 초기 반복처럼 baseline이 없던 경우 `effective_spec_ref`를 설정한다. |
| agent 저작 Gate C backbone | `p2a_iteration.mjs context`, `validate --stage gate-c-draft`, `promote-tasks` | task 작성용 context JSON 출력, draft task graph 검증, 사람 승인 audit 이후 canonical task graph 승격을 제공한다. 상세 계약은 §10이다. |
| diff 기반 task graph 초안 | `p2a_iteration.mjs diff-tasks` | active spec과 baseline spec의 field 차이를 semantic group으로 병합/분할해 Gate C task graph 초안을 생성한다. |
| current-spec composition | `p2a_iteration.mjs compose` | approved + close-ready 반복들을 `effective_product`, `effective_implementation`으로 조합한다. |
| maintenance graph 생성/검증 | `p2a_iteration.mjs maintenance add`, `validate` | maintenance task graph를 lazy 생성/append하고, 존재하면 schema/dependency를 검증한다. |
| 반복 handoff | `p2a_handoff.mjs --iteration-id active` | active 반복 산출물, `.plan2agent/current-spec.json`, maintenance graph를 대상 프로젝트에 복사하고 handoff 기준점을 기록한다. |
| 회귀 fixture | `scripts/run_fixtures.mjs` | greenfield -> init -> current -> tasks ready -> close -> open -> validate/current, draft/compose/handoff 흐름을 검증한다. |

### 0-2. 부분 구현

| 범위 | 현재 구현 | 남은 구현 |
| --- | --- | --- |
| `status.md` 반복 인덱스 | 전체 반복 history, close audit, handoff audit, maintenance 요약을 누적 렌더링한다. | 더 풍부한 사용자용 diff/요약은 후속 UX 항목이다. |
| baseline-aware Gate A/B | 초기 Gate A-only 초안과 baseline 기반 delta 초안을 만든다. | 구조적 질문 재생성, 사용자 답변 재사용/재처분 로직이 필요하다. |
| 구조적 diff task | spec field 차이를 semantic group으로 병합/분할하고, 완료 task overlap은 rework로 표시하며, `--force` 시 미완료 active task id/status를 재사용한다. | code-aware/LLM 기반 의미 판단은 후속 실행 레이어에서 다룬다. |
| agent 저작 task gate | backbone(`context`, `gate-c-draft` 검증, `promote-tasks`), `p2a-task-author` 스킬, 정식 `task-context` schema, provenance sidecar가 구현됐다. 상세 계약은 §10이다. | maintenance draft 승격(`--scope maintenance`/`maintenance add --from-draft`)은 낮은 우선순위 후속이다. |
| archived close | close artifact 존재 여부/hash 기록과 기본 validate-time archive audit을 제공한다. | 기존 pre-audit artifact migration은 필요할 때 `--skip-archive-audit`로 우회한다. |
| maintenance 반복 | lazy README, `maintenance add` task 생성, 존재하는 task graph 검증, handoff 시 별도 `.plan2agent/maintenance/task-graph.json` 복사를 제공한다. | maintenance 전용 UX는 후속이다. |
| agent 실행 추적 | `p2a_runs.mjs`가 `runs/run-index.json`과 `runs/<runId>.json`을 관리하고, test/lint/typecheck 실행 결과와 git changed files를 수집한다. | PTY 기반 자동 agent orchestration, PR 생성, 병렬 실행 scheduler는 후속이다. |

### 0-3. 미구현 / 후속 고도화

| 우선순위 | 항목 | 이유 |
| --- | --- | --- |
| P2 | maintenance task graph 정식 운영 | 생성/검증/handoff 정책은 구현됐고, maintenance 전용 UX가 더 필요하다. |
| P2 | archived 감사 정책 강화 | 기본 검증 강제는 구현됐고, 대규모 legacy migration 도구는 필요 시 후속이다. |
| P3 | agent 자동 실행 orchestration, PR 생성, 병렬 실행 scheduler | run log와 선택적 branch/worktree 생성은 구현됐고, agent를 직접 구동·감시하는 실행기는 후속이다. |
| P3 | brownfield code-aware intake, 병렬/branch/worktree별 반복 | 파일 기반 단일 반복 루프가 안정된 뒤 확장한다. |

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

현재 구현은 첫 반복에서는 thin pointer를 만들고, 반복이 2개 이상 close-ready 상태가 되면 `p2a_iteration.mjs compose`로 `current-spec.json` 조합본을 생성한다.

### 2-4. `maintenance`는 작은 변경의 집이다

`maintenance`는 작은 fix, 문서 수정, 패치성 변경을 모으는 상시 반복이다. 가벼운 fix를 위해 매번 전체 Gate A-D를 강제하지 않고 task graph 중심으로 관리한다. 생성 CLI는 `p2a_iteration.mjs maintenance add`이며, 첫 task에서 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하고 이후 task를 append한다.

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

```bash
node scripts/p2a_iteration.mjs current --artifacts artifacts/<project_id>
```

`current`는 active iteration id, task graph 경로, current spec 경로를 출력해 `p2a_tasks`와 후속 handoff가 같은 기준을 읽게 한다.

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id>
```

`validate`는 루트 `status.md`와 `current-spec.json`의 active pointer 일치, active iteration Gate B-D 산출물, task graph dependency, Gate D review blocker 여부를 확인한다.

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --require-close-ready
```

`--require-close-ready`는 모든 active iteration task가 `done`인지 추가로 확인한다.

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --allow-planning

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --stage gate-a

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --stage gate-b-approved
```

`--allow-planning`은 active 반복이 아직 Gate B-D ready 상태가 아니어도 Gate A-ready, Gate B draft, Gate B approved planning state를 정상 상태로 검증한다. `--stage`는 기대 stage를 명시해 잘못된 상태 전이를 잡는다.

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --audit-archive
```

`--audit-archive`는 `close` 시점에 기록한 artifact 존재 여부/hash와 현재 파일 상태를 비교해 archived 반복 변경을 감지한다. close 이후 파일 내용이 바뀌거나, close 시점에 없던 감사 대상 파일이 새로 생겨도 실패한다.

```bash
node scripts/p2a_iteration.mjs close \
  --artifacts artifacts/<project_id>
```

`close`는 active 반복의 Gate B-D 통과, `review.json.blocking_issues: []`, 모든 task `done`을 재확인한 뒤 `iterations/<iter-id>/iteration.json`을 `status: "archived"`로 갱신한다. 루트 `current-spec.json`에는 `last_closed_iteration`과 `closed_iterations`가 기록되고, `status.md` 반복 인덱스에는 close 시점이 남는다. active pointer는 닫힌 반복에 그대로 유지된다. `--iteration-id active`가 기본값이며, 현재 구현은 active 반복 close만 지원한다.

```bash
node scripts/p2a_iteration.mjs open \
  --artifacts artifacts/<project_id> \
  --iteration-id <next-iter-id> \
  --idea "<change idea>"
```

`open`은 현재 active 반복이 `close`로 archived 되었고 `current-spec.json.closed_iterations`/`last_closed_iteration`에 기록된 경우에만 새 반복 skeleton을 생성한다. 닫힌 반복이 2개 이상이면 `current-spec.json.effective_spec_ref`가 조합본(`current-spec.json`)이어야 하므로, 다음 반복을 열기 전에 `compose`를 실행해야 한다. 새 반복에는 `iteration.json`, `README.md`, Gate A-D 디렉터리, Gate A/B 작성 위치 안내가 생기며, 루트 `status.md`와 `current-spec.json.active_iteration`은 새 반복을 가리킨다. 이 시점에는 baseline-aware spec 자동 생성은 하지 않으므로 Gate B-D JSON 산출물이 생기기 전까지 `validate`는 실패한다.

```bash
node scripts/p2a_iteration.mjs draft \
  --artifacts artifacts/<project_id>
```

`draft`는 `open`으로 저장된 `current-spec.json.pending_iteration.idea`와 `baseline_effective_spec_ref`를 읽어 active 반복의 Gate A/B 초안을 생성한다.

초기 Gate A-only 반복에서는 `baseline_effective_spec_ref`가 없어도 기존 `gate-a-intake/intake.json`을 사용해 Gate B 초안을 생성한다. 이 경우 기존 intake 파일은 유지하고 Gate B 산출물만 쓴다.

생성 산출물:

- `iterations/<iter-id>/gate-a-intake/intake.json`
- `iterations/<iter-id>/gate-a-intake/intake.md`
- `iterations/<iter-id>/gate-b-spec/spec.json`
- `iterations/<iter-id>/gate-b-spec/product-spec.md`
- `iterations/<iter-id>/gate-b-spec/implementation-plan.md`

기본 동작은 기존 Gate A/B 파일이 있으면 중단한다. 변경 아이디어를 덮어 쓰려면 `--idea "<change idea>"`, 기존 초안을 재생성하려면 `--force`를 명시한다. 생성된 `spec.json`은 `approval: "draft"`이므로 Gate C task graph 생성 전 사용자 검토와 승인 단계가 필요하다. `current-spec.json.effective_spec_ref`는 계속 baseline spec을 가리키고, 새 반복 spec은 `pending_iteration.artifacts.spec_ref`에 기록된다.

```bash
node scripts/p2a_iteration.mjs promote-spec \
  --artifacts artifacts/<project_id>
```

`promote-spec`는 active 반복의 Gate B `spec.json`이 `approval: "approved"`이고 `open_decisions`가 비어 있는지 검증한 뒤 `iteration.json`과 `current-spec.json.pending_iteration`에 `gate_b_approved` 상태를 기록한다. 초기 Gate A-only 반복처럼 `current-spec.json.effective_spec_ref`가 없던 경우에는 active spec을 현재 유효 spec으로 설정한다. 이미 baseline이 있는 후속 반복에서는 baseline pointer와 `composed_from/source_specs` 조합본을 보존하고, 실제 current-effective 반영은 Gate C/D와 close/compose 이후 수행한다.

```bash
node scripts/p2a_iteration.mjs diff-tasks \
  --artifacts artifacts/<project_id>
```

`diff-tasks`는 approved active spec과 baseline spec을 field 단위로 비교한 뒤, 변경을 requirements/security/integration/api/ui/data/delivery/architecture/verification semantic group으로 병합/분할해 `iterations/<iter-id>/gate-c-task-graph/task-graph.json` 초안을 생성한다. 초기 반복처럼 baseline이 없으면 active spec 전체를 구현 대상으로 보고 semantic group을 만든다. 닫힌 반복의 완료 task와 `sourceSpecRefs`가 겹치면 새 task title을 `Rework ...`로 표시하고 description/prompt에 이전 task overlap을 남긴다. implementation group이 있으면 verification task가 후속 dependency로 붙으며, clarifying question disposition과 사용자 답변 재처분 검토는 requirements/verification task acceptance에 포함된다. 기존 task graph가 있으면 중단하며, 재생성하려면 `--force`를 명시한다. `--force`는 기존 active graph의 미완료 task와 semantic group이 겹칠 때 task id/status를 재사용한다.

```bash
node scripts/p2a_iteration.mjs maintenance add \
  --artifacts artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"
```

`maintenance add`는 `resolveIterationState(..., requireReady: false)` 기준으로 iterative root와 project id만 확인한다. 생성되는 graph는 기존 `p2a.task_graph.v1` 스키마를 그대로 사용하며 `version: "maintenance"`, `sourceSpec: "../../../current-spec.json"`를 기록한다. `--ref`가 없으면 `sourceSpecRefs`는 `["maintenance"]`이고, `--ref effective_product.problem`처럼 현재 baseline의 추적 위치를 free string으로 지정할 수 있다. `--depends`는 같은 maintenance graph 안의 기존 task id만 허용되며, 쓰기 전 `validateTaskGraphData`로 schema, 중복 id, dependency, cycle을 재검증한다.

```bash
node scripts/p2a_iteration.mjs compose \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs compose \
  --artifacts artifacts/<project_id> \
  --allow-conflicts
```

`compose`는 반복 디렉터리들을 순서대로 읽어 approved + close-ready 상태인 반복만 `current-spec.json`의 current-effective view로 조합한다. 포함 조건은 다음과 같다.

- `gate-b-spec/spec.json`이 존재하고 `approval: "approved"`이며 `open_decisions`가 비어 있다.
- `gate-c-task-graph/task-graph.json`이 존재하고 모든 task가 `done`이다.
- `gate-d-review/review.json`이 존재하고 `blocking_issues`가 비어 있다.

조합 결과는 `effective_spec_ref: "current-spec.json"`로 바뀌며, 다음 `open`/`draft`는 개별 반복 spec이 아니라 `effective_product`와 `effective_implementation`을 baseline으로 읽는다. `close`가 기록한 metadata가 있으면 source status는 `archived`로 보존된다. non-active source는 `source_specs.status: "archived"`로 추론하고, active source는 task 완료 여부에 따라 `close-ready` 또는 `active`로 기록한다. composition conflict가 있으면 기본 `compose`는 `current-spec.json`을 변경하지 않고 실패한다. 충돌 결정을 파일에 기록하려면 `--allow-conflicts`를 명시하며, 이 경우 `current-spec.json.open_decisions`를 해결하기 전까지 다음 `open`은 막힌다.

### 6-2. 후속 명령 후보

후속 `close` 고도화는 archived 반복의 append-only 감사, `deferred`/`non-goal` 같은 task 처분 상태 지원, close 시점의 자동 composition 갱신이다. 현재 task schema에는 `deferred`가 없으므로 v1 close 조건은 모든 task `done`이다.

## 7. `current-spec.json` 계약

초기 상태는 thin pointer다.

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

Gate A만 완료된 초기 planning 반복은 아직 approved spec이 없으므로 임시로 다음 형태를 허용한다. 이 형태는 `p2a_iteration current`의 active pointer 해석 대상이지만, 현재 `p2a_iteration validate`의 통과 대상은 아니다.

```json
{
  "schema_version": "p2a.current_spec.v1",
  "project_id": "example-project",
  "composed_from": ["v1-mvp"],
  "active_iteration": "v1-mvp",
  "effective_spec_ref": null,
  "pending_iteration": {
    "iteration_id": "v1-mvp",
    "status": "gate_a_ready",
    "artifacts": {
      "intake_ref": "iterations/v1-mvp/gate-a-intake/intake.json",
      "intake_markdown_ref": "iterations/v1-mvp/gate-a-intake/intake.md"
    }
  },
  "note": "Gate B spec is not available yet."
}
```

Gate B가 승인되면 `p2a_iteration.mjs promote-spec`로 `effective_spec_ref`를 `iterations/v1-mvp/gate-b-spec/spec.json`로 갱신한다.

`open`과 `draft` 중인 반복은 `pending_iteration`을 함께 기록한다.

```json
{
  "pending_iteration": {
    "iteration_id": "iter-002",
    "status": "gate_b_draft",
    "idea": "변경 아이디어",
    "baseline_iteration": "v1-mvp",
    "baseline_effective_spec_ref": "iterations/v1-mvp/gate-b-spec/spec.json",
    "artifacts": {
      "intake_ref": "iterations/iter-002/gate-a-intake/intake.json",
      "spec_ref": "iterations/iter-002/gate-b-spec/spec.json"
    }
  }
}
```

이 단계의 `effective_spec_ref`는 새 draft가 아니라 안정된 baseline을 유지한다. 새 draft는 승인과 Gate C/D 검증을 통과한 뒤 후속 close/composition 단계에서 current-effective view로 반영한다.

`compose` 이후에는 다음 필드가 추가된다.

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
      "status": "archived",
      "approval": "approved"
    }
  ],
  "effective_product": {},
  "effective_implementation": {},
  "superseded_refs": [],
  "open_decisions": [],
  "composition_conflicts": []
}
```

조합 규칙:

- archived 반복은 history로 보존한다.
- 최신 반복이 대체한 spec field는 `superseded_refs`에 `superseded_ref`와 `replaced_by_ref`로 기록한다.
- `effective_product`와 `effective_implementation`은 다음 intake/spec가 읽을 현재 기준이다.
- 모호한 충돌은 자동 병합하지 않는다. 기본 `compose`는 쓰기 전에 실패하고, `--allow-conflicts`를 명시하면 `current-spec.json.open_decisions`에 composition decision으로 올린다. `validate`, `open`, 다음 `draft`는 unresolved composition decision이 있으면 실패한다.

## 8. 검증 계약

반복 구조 validator는 `p2a_iteration.mjs validate`에서 시작한다. 현재 구현은 **Gate B-D가 존재하는 실행 가능한 반복**을 대상으로 한다.

- 루트 `status.md`가 active iteration을 가리킨다.
- `current-spec.json.active_iteration`이 실제 `iterations/<id>/`와 일치한다.
- active iteration의 Gate B-D 산출물이 존재하고 기존 JSON schema 검증을 통과한다.
- 반복 내부 task dependencies는 같은 반복 안의 task id만 참조한다.
- close 대상 반복은 `review.json.blocking_issues: []`이고 task가 모두 완료 상태다.
- `current-spec.json`이 composition 형태이면 `source_specs`, `composed_from`, `effective_product`, `effective_implementation`, `open_decisions` 상태를 검증한다.

현재 구현의 planning 검증:

- Gate A만 완료된 반복(`gate_a_ready`)은 `--allow-planning` 또는 `--stage gate-a`로 검증한다.
- Gate B draft는 `--allow-planning` 또는 `--stage gate-b-draft`로 검증한다.
- Gate B approved는 `--stage gate-b-approved`로 검증한다.
- maintenance 반복은 `p2a_iteration.mjs maintenance add`로 task graph를 lazy 생성/append하고, `iterations/maintenance/gate-c-task-graph/task-graph.json`이 존재하면 schema/dependency를 검증한다.
- archived 반복은 `--audit-archive`를 명시하면 close 시점의 artifact 존재 여부/hash와 현재 파일 상태를 비교한다.

기존 `validate_artifacts.mjs --artifact-root`는 greenfield root 구조를 검증한다. 반복 구조 검증은 `p2a_iteration.mjs validate`가 담당한다.

현재 명령:

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --require-close-ready
```

planning stage 검증:

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --stage gate-a

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --allow-planning
```

`--stage gate-a` 또는 `--allow-planning`은 다음을 확인한다.

- active 반복 디렉터리가 존재한다.
- `status.md` marker와 `current-spec.json.active_iteration`이 일치한다.
- `gate-a-intake/intake.json`이 schema 검증을 통과한다.
- `current-spec.json.pending_iteration.status`가 `gate_a_ready`, `active_planning`, `gate_b_draft` 중 하나다.
- Gate B-D 누락은 실패가 아니라 pending 상태로 보고한다.

후속 validator 확장은 legacy archive migration과 agent 실행 결과 audit이다.

## 9. handoff 적응

기존 `p2a_handoff.mjs`는 greenfield `artifacts/<project_id>/gate-*` root를 계속 지원한다. 반복 구조 root(`current-spec.json` + `iterations/`)를 넘기면 기본값은 active 반복 인계다.

1. `--iteration-id <id>`를 명시해 특정 반복을 인계한다.
2. `current-spec.json.active_iteration`과 루트 `status.md`를 읽어 active 반복을 자동 선택한다.
3. 대상 프로젝트에는 `.plan2agent/artifacts/`에 active 반복 산출물을 배치하고, `.plan2agent/current-spec.json`도 함께 배치한다.

기본값은 `--iteration-id active`다. 다만 명령형 재현성을 위해 특정 iteration id override도 제공한다.

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target /path/to/project \
  --iteration-id active \
  --overwrite
```

반복 handoff는 active 반복의 Gate B-D가 인계 가능한 상태인지 검증한 뒤 다음을 쓴다.

- `.plan2agent/artifacts/product-spec.md`
- `.plan2agent/artifacts/implementation-plan.md`
- `.plan2agent/artifacts/spec.json`
- `.plan2agent/artifacts/task-graph.json`
- `.plan2agent/artifacts/review-report.md`
- `.plan2agent/artifacts/review.json`
- `.plan2agent/artifacts/status.md`
- `.plan2agent/current-spec.json`

`--include-intake`를 붙이면 active 반복의 Gate A intake도 `.plan2agent/artifacts/`로 함께 복사한다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않고 `copy`만 허용한다. maintenance task graph가 있으면 active graph와 병합하지 않고 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다.

`--tools codex,claude,gemini|all`은 반복 handoff에도 동일하게 적용된다. 산출물과 `current-spec.json`을 복사한 뒤 대상 프로젝트에 공통 `.agents/skills`, `.agents/agents`와 선택한 CLI별 `.codex`, `.claude`, `.gemini` P2A 자산을 설치하고, 설치 목록을 `.plan2agent/manifest.json`에 기록한다.

`--include-team-bigfive`도 반복 handoff에 동일하게 적용된다. `--team-bigfive-source`가 local directory이면 source manifest에 파일 목록과 SHA-256을 기록하고, Git URL이면 fetch 없이 URL provenance만 기록한다. 선택 target별 adapter entrypoint는 `.agents/.codex/.claude/.gemini` 아래에 생성되며, 외부 하네스 기록은 `.plan2agent/manifest.json.externalHarnesses`와 `.plan2agent/project.config.json.teamBigFive`에 남긴다.

## 10. Agent 저작 task 게이트

상태: **부분 구현**. backbone(`context` / `validate --stage gate-c-draft` / `promote-tasks`), 저작 스킬(`p2a-task-author`), 정식 context 스키마(`p2a.task_context.v1`), provenance sidecar가 구현됐고, maintenance Phase 1이 남았다.

이 문서는 agent가 task를 저작하고 사람이 게이트에서 확정하는 흐름의 구현 계약을 정의한다. 반복/고도화 개발의 정본 계약은 `docs/iteration-spec.md`이며, 이 문서는 그 위에 붙는 "Agent 저작 task 게이트" 기능의 설계 정본이다. `diff-tasks`는 deterministic semantic fallback으로 유지하고, agent 저작 경로는 더 깊은 맥락 판단과 사람 승인 게이트를 붙이는 확장 경로다.


| 조각 | 명령/파일 | 상태 |
| --- | --- | --- |
| 컨텍스트 번들 | `p2a_iteration.mjs context` | ✅ 구현 |
| 초안 검증 | `p2a_iteration.mjs validate --stage gate-c-draft` | ✅ 구현 |
| 승인 게이트 | `p2a_iteration.mjs promote-tasks` + `status.md` Gate C approval audit | ✅ 구현 |
| 저작 스킬 | `.agents/skills/p2a-task-author/SKILL.md` (+ `.claude` mirror, Gemini shim) | ✅ 구현 |
| 회귀 테스트 | `run_fixtures`(context/gate-c-draft/promote) + `check_cli_parity`(skill mirror) | ✅ |
| provenance sidecar | `task-graph.draft.meta.json` | ✅ 구현 |
| 정식 context 스키마 | `schemas/task-context.schema.json` + `validateTaskContextData` (context가 출력 전 자기검증) | ✅ 구현 |
| `context --scope maintenance` | — | ⛔ 남음 (현재 `feature`만) |
| Phase 1 (maintenance 파일럿 + fix/기능 분류) | `maintenance add --from-draft` | ⛔ 남음 (우선순위 낮음) |
| `validate`-time audit 강제(승격된 정본) | — | △ 미구현 (선택) |

남은 핵심은 없다. backbone + 저작 스킬로 "AI가 초안 저작 -> 사람 게이트 확정 -> 정본 승격"이 끝에서 끝까지 동작한다. 남은 항목은 maintenance 파일럿이다.

### 10-1. 목적과 위치

- 문제: deterministic `diff-tasks`는 spec field 차이를 semantic group으로 병합/분할하고 rework/reuse를 표시하지만, code-aware 판단이나 복잡한 task 재구성까지 맡기지는 않는다.
- 해법: 기획층(Gate C)에 **agent 저작 + 사람 승인 게이트**를 추가한다. agent는 현재 기준 맥락을 읽어 richer task 초안을 쓰고, 사람이 게이트에서 승격을 확정한다.
- 불변: 실행층(`p2a_tasks`)과 `schemas/task-graph.schema.json`은 바꾸지 않는다. agent 출력도 기존 `p2a.task_graph.v1`을 따른다.
- 로드맵 연결: `plans/01-product-roadmap.md` §13의 "task graph 확정 시 사용자 승인"을 명시적 게이트로 구체화하고, §14의 "기획 변경 diff 기반 재작업 task 생성" 구현 계약을 제공한다.

### 10-2. 핵심 원칙

| 원칙 | 계약 |
| --- | --- |
| 초안 분리 | agent 출력은 `task-graph.draft.json`에만 쓴다. 정본 `task-graph.json`은 직접 쓰지 않는다. `p2a_tasks`는 정본만 읽으므로 미승인 task가 실행 대상(`ready`/`start`)에 노출되지 않는다. |
| 게이트 승인 | 초안 -> 정본 승격은 사람의 명시 승인과 `status.md` Gate C approval audit block으로만 일어난다. 자동 승격은 없다. |
| 추적성 강제 | 승격 전 `validateTaskGraphData`가 schema·중복 id·dependency·cycle을 검사하고, `sourceSpecRefs` 최소 1 제약으로 agent 출력에도 spec 추적을 강제한다. |

### 10-3. 산출물 계약

| 산출물 | 역할 |
| --- | --- |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json` | agent 저작 초안. 기존 `p2a.task_graph.v1` schema를 그대로 따른다. `version`은 `"<iter-id>-draft"` 같은 초안 표식을 권장한다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.json` | 승인 후 승격된 정본. 실행/handoff 대상은 이 파일뿐이다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json.promoted` | 승격 후 history로 보존되는 직전 초안. (`promote-tasks`가 rename으로 남긴다.) |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.meta.json` | provenance sidecar. draft hash, source spec hash, source idea, baseline ref, Gate C approval audit을 기록한다. schema를 건드리지 않으려고 provenance는 정본 밖에 둔다. |
| `status.md`의 Gate C approval audit block | 승인 사실과 근거. §10-6 형식을 따른다. |

### 10-4. 컨텍스트 번들 계약

`p2a_iteration.mjs context`는 agent가 task를 저작하는 데 필요한 현재 기준 맥락을 읽기 전용 JSON으로 모은다.

```bash
node scripts/p2a_iteration.mjs context \
  --artifacts artifacts/<project_id> \
  [--idea "<change idea>"]
```

출력 형식:

```json
{
  "schema_version": "p2a.task_context.v1",
  "project_id": "example-project",
  "active_iteration": "iter-002",
  "scope": "feature",
  "idea": "변경 아이디어 또는 버그 설명",
  "baseline_effective_spec_ref": "current-spec.json",
  "effective_spec": { "product": {}, "implementation": {} },
  "existing_tasks": {
    "active": [
      { "id": "task-001", "title": "...", "status": "done", "targetArea": "...", "sourceSpecRefs": ["implementation.architecture"] }
    ],
    "maintenance": []
  },
  "spec_field_changes": [
    { "section": "implementation", "field": "architecture", "specRef": "implementation.architecture" }
  ]
}
```

- `effective_spec`은 `current-spec.json`의 effective view(또는 thin pointer가 가리키는 active spec)에서 읽는다.
- `existing_tasks`는 중복 저작과 재사용 판단을 돕기 위해 active 반복과 maintenance graph의 task 요약을 함께 제공한다.
- `spec_field_changes`는 baseline이 있으면 `diff-tasks`와 같은 field 비교 결과를 재사용한다.
- `context`는 어떤 파일도 쓰지 않는다.
- 현재 `scope`는 `feature` 고정이다. `--scope maintenance`는 후속(§10 도입부 구현 현황).
- 출력은 `schemas/task-context.schema.json`(`p2a.task_context.v1`)을 따르며, `context` 명령이 출력 전 `validateTaskContextData`로 자기검증해 무효 context를 내보내지 않는다.

### 10-5. 명령 계약

| 명령 | 입력 | 동작 | 실패 조건 |
| --- | --- | --- | --- |
| `context` | iterative root, 선택적 idea | §10-4 번들을 stdout으로 출력 | iterative root 해석 실패 |
| `validate --stage gate-c-draft` | iterative root | active 반복의 `task-graph.draft.json`을 schema/dependency/cycle로 검증(승인 불요) | draft 없음, schema/dependency/cycle 위반 |
| `promote-tasks` | iterative root | active 반복의 `task-graph.draft.json`을 검증(approved spec 포함)하고 Gate C approval audit을 확인한 뒤 `task-graph.json`으로 승격 | draft 없음, draft 검증 실패, audit block 없음 |
| `maintenance add --from-draft <file>` (미구현) | maintenance 초안 파일 | 초안 task들을 검증 후 maintenance graph에 append (§10-8 Phase 1) | 초안 검증 실패, 사람 confirm 취소 |

`promote-tasks`는 baseline-aware 안전 조건(기존 정본의 `done` task id 보존 등)을 후속에서 강화한다. v1 계약은 schema/추적성/audit 확인까지다. 승격 시 `version`의 `-draft` 접미사를 제거하고, provenance sidecar를 `task-graph.draft.meta.json`에 기록하며, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

### 10-6. Gate C 승인 게이트

승인 사실은 `status.md`에 Gate B approval audit과 같은 패턴으로 남긴다.

```md
#### Gate C approval audit

- Approved by: user
- Approved at: YYYY-MM-DD
- Approved source: gate-c-task-graph/task-graph.draft.json (agent-authored)
- Authoring agent: <codex|claude|gemini> / p2a-task-author
- Approval note: <검토 근거 — 무엇을 보고 승격을 승인했는지>
```

`promote-tasks` 동작:

1. active 반복의 `task-graph.draft.json`을 읽고 `validateTaskGraphData(draft, specPath)`로 재검증한다(approved spec + open_decisions 비어있음 + schema/dependency/cycle).
2. (후속) baseline 정본이 있으면 초안이 기존 `done` task를 보존하며 안전하게 대체/확장하는지 확인한다.
3. `status.md`에 Gate C approval audit block이 있는지 확인한다. 없으면 승격을 거부한다.
4. 초안을 `task-graph.json`으로 승격하고, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

`validate` 확장:

- 아직 승격되지 않은 초안은 `--stage gate-c-draft`로 schema/dependency/cycle만 검증하고 승인은 요구하지 않는다.
- (후속, 미구현) 승인된 agent-저작 정본을 식별해 `validate`-time에도 audit block을 요구하는 강제는 marker가 필요해 후속으로 둔다. 현재 감사 강제는 `promote-tasks` 시점에서만 일어난다.

### 10-7. 저작 스킬 `p2a-task-author`

- 입력: §10-4 context 번들. 출력: `task-graph.draft.json`.
- 책임: 변경 의미를 읽어 task를 병합/분할하고, `existing_tasks`와 중복을 피하며, 각 task의 `sourceSpecRefs`를 effective spec 항목으로 채운다.
- 제약: read-only planning 원칙을 지켜 코드·의존성 변경이나 정본 직접 쓰기를 하지 않는다. 초안만 쓴다.
- mirror: 기존 skill mirror 규약(`.agents/skills` -> `.claude`/`.gemini`, command shim)을 따르고 `check_cli_parity`로 검증한다. 기존 `p2a-task-breakdown`의 sibling이다.
- **구현됨**: `.agents/skills/p2a-task-author/SKILL.md` (canonical) + `.claude/skills/p2a-task-author/SKILL.md` mirror + `.gemini/commands/p2a/task-author.toml` shim. mirror/shim은 `sync_cli_assets.mjs`가 생성하고 `check_cli_parity.mjs`가 검증한다. 스킬은 context를 읽어 초안만 저작하고, 검증·audit·`promote-tasks` 절차를 사람 게이트로 인계한다.

### 10-8. 단계별 도입

| 단계 | 범위 | 게이트 | 상태 |
| --- | --- | --- | --- |
| Phase 1 (파일럿) | maintenance 레인 | 사람 confirm + `maintenance add`의 validate-before-write | ⛔ 미구현 (우선순위 낮음) |
| Phase 2 | feature task graph | Gate C approval audit + `promote-tasks` | ✅ backbone + 저작 스킬 구현 |

Phase 1 흐름: `context --scope maintenance` -> agent가 maintenance task 초안 작성 -> 사람 확인 -> `maintenance add --from-draft`로 검증 후 append. ungated maintenance 특성상 별도 정본/초안 분리 없이 append 직전 사람 confirm을 게이트로 둔다. 단, maintenance는 본질적으로 코드-side 활동이라 planning-side 저작의 실익이 작아 우선순위를 낮춘다(이관된 fix/기능 경계 분류 포함).

Phase 2 흐름: `context` -> `p2a-task-author`가 `task-graph.draft.json` 저작 -> 사람 검토 + Gate C approval audit 기록 -> `promote-tasks`로 정본 승격 -> Gate D review -> `p2a_tasks` 실행. `diff-tasks`는 deterministic semantic fallback으로 남고, agent-authored draft 경로는 같은 Gate C approval/promotion 계약으로 수렴한다.

### 10-9. 가드레일

- 자동 승격 금지: 승격은 항상 Gate C approval audit이 선행한다.
- 추적성 완화 금지: `sourceSpecRefs` 최소 1 제약을 agent 출력에도 적용한다.
- 실행층 불변: 저작/승격 로직을 `p2a_tasks` 상태 전이 명령에 넣지 않는다.
- 초안 격리: `task-graph.draft.json`은 승격 전까지 `p2a_tasks`/`p2a_handoff` 대상이 아니다.
- 비목표 경계 유지: deterministic `diff-tasks`와 agent-authored draft는 모두 Gate C approval/promotion을 거친다. 자동 정본 승격, 자동 병합, agent 자동 실행 orchestration은 여전히 비목표다.

### 10-10. 검증/회귀 계획

- `run_fixtures.mjs` 추가 케이스: `context` 출력 형식, `--stage gate-c-draft` 초안 검증(양성/cycle 음성), audit 없을 때 `promote-tasks` 거부, audit 있을 때 승격 + 정본 검증. (구현됨.)
- `check_cli_parity.mjs`: `p2a-task-author` skill mirror와 command shim drift 검증. (구현됨.)
- 기존 회귀(`run_fixtures`, `check_cli_parity`)는 그대로 통과해야 한다.

## 11. 비목표와 후속 고도화

이 문서의 비목표:

- 기존 코드베이스를 자동으로 읽고 spec을 역생성하는 brownfield code-aware intake
- 병렬 반복 scheduler, branch별 반복, worktree별 반복 planning lane
- agent 자동 실행, PTY 제어, PR 생성, 결과 diff 자동 병합
- DB, pgvector, Neo4j 기반 plan-code 계보 저장

후속 고도화는 이 문서의 iteration 레이아웃, `status.md` 반복 인덱스, `current-spec.json` current-effective view, semantic `diff-tasks`, 파일 기반 run log를 전제로 붙인다. code-aware spec 역생성, PTY 기반 agent orchestration, PR 생성, 결과 자동 병합은 실행 레이어가 필요해 별도 단계로 둔다.

## 12. 구현 조각 순서

| 순서 | 조각 | 상태 | 이유 |
| --- | --- | --- | --- |
| 1 | 레이아웃/인덱스 규약 + greenfield migration | 완료 | `p2a_iteration.mjs init`으로 Gate B-D까지 있는 greenfield bundle을 반복 구조로 변환한다. |
| 1-1 | Gate A-only artifact 반복 동기화 | 부분 완료 | `lightweight-embedded-redis`처럼 Gate A만 있는 artifact는 반복 구조에서 해석/검증/draft 가능하다. 자동 migration 명령은 아직 없다. |
| 2 | `status.md` 반복 인덱스 | 완료 | 전체 반복 history, close audit, handoff audit, maintenance 요약을 누적 렌더링한다. |
| 3 | `current-spec.json` 조합 규칙 | 완료 | `p2a_iteration.mjs compose`가 approved + close-ready 반복들을 current-effective view로 조합한다. |
| 4 | `p2a_tasks` active iteration 인식 | 완료 | `--artifacts`가 active 반복 graph를 찾아 task 조회와 상태 변경에 사용한다. |
| 4-1 | Gate B-D 반복 구조 validator | 완료 | `p2a_iteration.mjs validate`가 active 반복 구조와 close-ready 조건을 검증한다. |
| 4-2 | Gate A-ready/planning validator | 완료 | `--stage`와 `--allow-planning`이 Gate A-only, Gate B draft, Gate B approved 상태를 검증한다. |
| 4-3 | 반복 open skeleton | 완료 | `p2a_iteration.mjs open`이 archived + composed baseline 위에 새 반복 디렉터리와 metadata를 만든다. |
| 5 | baseline-aware Gate A/B draft | 부분 완료 | `draft`가 Gate A-only 초기 Gate B 초안과 baseline 기반 delta intake/spec 초안을 만든다. 질문 재생성 고도화는 후속이다. |
| 5-1 | Gate B 승인 반영 | 완료 | `promote-spec`가 approved active spec을 기록하고, 후속 반복에서는 baseline/composition pointer를 보존한다. |
| 5-2 | diff 기반 task graph 초안 | 완료 | `diff-tasks`가 spec field 차이를 semantic group으로 병합/분할하고 rework/reuse/verification dependency를 기록한 Gate C task graph 초안을 만든다. |
| 6 | handoff 적응 | 완료 | `p2a_handoff.mjs`가 active 반복 산출물, current-effective view, maintenance graph를 대상 프로젝트로 복사하고 handoff 기준점을 기록한다. |
| 7 | 반복 open/close 명령 | 완료 | 반복 생성, close-ready 마감, archived metadata 표시, composed baseline 기준 다음 반복 open을 자동화한다. |
| 8 | 반복 fixture/golden | 완료 | greenfield -> init -> current -> tasks ready -> close -> open -> validate/current root 흐름과 draft/compose/handoff 회귀를 고정했다. |
| 9 | archived append-only 감사 | 완료 | close 시 artifact 존재 여부/hash를 기록하고 기본 `validate`에서 변경을 감지한다. legacy/migration은 `--skip-archive-audit`로 우회한다. |
| 10 | 구조적 diff 기반 재작업 task 생성 | 완료 | `diff-tasks`가 semantic group, 완료 task overlap 기반 rework, `--force` 미완료 task reuse, question disposition 재처분 acceptance를 생성한다. |
| 11 | maintenance task graph 운영 | 완료 | `maintenance add`가 graph를 lazy 생성/append하고 validate가 schema/dependency를 검증하며 handoff 시 별도 maintenance graph로 복사한다. |
| 12 | agent 실행 추적 | 완료 | `p2a_runs.mjs`가 run-index/run log, task별 runId, changedFiles, verification, agentTool, workspaceRef, 선택적 branch/worktree 격리 생성, test/lint/typecheck 결과 수집을 제공한다. |

## 13. 검증 메모

- `plans/01-product-roadmap.md` §9의 “새 버전의 명세와 task graph”는 반복별 `gate-b-spec/spec.json`과 `gate-c-task-graph/task-graph.json`으로 구체화한다.
- `plans/01-product-roadmap.md` §14의 “기획 변경 diff 기반 재작업 task 생성”은 후속 자동화이며, 본 문서는 그 전에 필요한 파일 기반 반복 구조를 정의한다.
- task graph schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 요구한다.
- validator는 같은 task graph 안의 task id 집합을 만든 뒤 `dependencies`가 그 집합 안에 있는지 검사하므로, 반복 간 dependency를 넣지 않는 채택안은 schema/validator 변경 없이 적용 가능하다.
