# Plan2Agent 반복/고도화 개발 스펙

참고 기준일: 2026-08-05

이 문서는 Plan2Agent(P2A)가 MVP 이후 기존 프로젝트에 기능을 이어 추가하는 반복/고도화 개발 구조와 현재 구현 상태를 정의한다.

문서 홈: [Plan2Agent Docs](README.md) · 사용자 시작점: [Quickstart](quickstart.md)

## 0. 구현 범위 요약

이 문서는 완성된 CLI 계약과 후속 고도화 계약을 함께 담는다. 아래 표가 현재 구현 상태의 정본이다.

### 0-1. 구현 완료

| 범위 | 구현 | 검증 기준 |
| --- | --- | --- |
| 결정 원장 | `p2a decide`, `p2a decisions`, `p2a shape` | Gate ①② 승인·철회와 범위·헌법 변경을 append-only `decisions.jsonl`에 기록하고 원장이 존재하면 승인 상태의 정본으로 사용한다. |
| greenfield -> iteration 변환 | `p2a iteration init` | 기존 Gate A-C 산출물을 `iterations/<iter-id>/gate-*`로 이동하고, 이동된 spec/task를 재검증하며 원장 승인을 새 경로에 재결합한다. |
| root index 생성 | `current-spec.json`, generated `status.md`, `iterations/maintenance/README.md` | thin current-spec pointer와 optional status view를 생성한다. |
| active iteration 해석 | `p2a iteration current` | `current-spec.json.active_iteration`을 정본으로 active 경로를 출력한다. |
| task CLI 반복 적응 | `p2a tasks --artifacts` | current development contract에서 active 반복의 `task-graph.json`을 선택해 ready/prompt/start/done 전이를 수행하고, 쓰기 직전 current binding을 다시 확인한다. 과거 composition은 일반 전환에서 읽지 않으며 `--maintenance`로 maintenance 레인도 선택할 수 있다. |
| agent run 추적 | `p2a runs start/verify/finish` | `runs/`에 task별 runId, changedFiles, verification, agentTool, workspaceRef, branch/worktree 격리 기준을 기록한다. |
| Gate B/C ready 검증 | `p2a iteration validate` | active 반복의 approved spec, task graph, task dependency를 검증한다. |
| close-ready 검증 | `p2a iteration validate --require-close-ready` | active 반복의 모든 task가 `done`인지 확인하고, visual evidence가 이후 task 변경보다 최신인지 검증한다. |
| planning stage 검증 | `p2a iteration validate --allow-planning`, `--stage` | Gate A-ready, Gate B draft, Gate B approved 상태를 Gate B/C 누락 실패 없이 검증한다. |
| 반복 close | `p2a iteration close` | current development contract와 현재 task/run 증거만으로 close-ready를 판정해 active 반복을 `archived` metadata로 표시하고 `current-spec.json.closed_iterations`에 기록한다. 과거 composition source의 존재 여부는 close를 차단하지 않는다. |
| archived 감사 | `p2a iteration validate` | close 시 기록한 artifact 존재 여부/hash와 현재 파일 상태를 기본 검증으로 비교한다. legacy/migration 상황은 `--skip-archive-audit`로 우회한다. |
| 다음 반복 open | `p2a iteration open` | archived current iteration의 `current-development-contract.json`을 작은 baseline spec으로 materialize하고 새 active 반복 skeleton과 `pending_iteration`을 생성한다. legacy composition source의 존재나 정합성은 일반 open을 차단하지 않는다. |
| Gate A/B draft | `p2a iteration draft` | Gate A-only 초기 반복은 승인된 scope intake로 Gate B 초안을 만들고, baseline이 있는 반복은 먼저 delta scope를 확인받은 뒤 delta Gate B를 생성한다. |
| Gate B 승인 반영 | `p2a iteration promote-spec` | approved active spec을 기록하고, 초기 반복처럼 baseline이 없던 경우 `effective_spec_ref`를 설정한다. |
| agent 저작 Gate C backbone | `p2a iteration context`, `validate --stage gate-c-draft`, `promote-tasks` | task 작성용 context JSON 출력, draft task graph 검증, validator 통과 후 canonical task graph 승격을 제공한다. 상세 계약은 §10이다. |
| diff 기반 task graph 초안 | `p2a iteration diff-tasks` | active spec과 baseline spec의 field 차이를 semantic group으로 병합/분할해 Gate C task graph 초안을 생성한다. |
| historical composition administration | `p2a iteration compose` | 명시적 감사·마이그레이션 때만 approved + close-ready 과거 반복을 조합한다. 일반 `next/open/draft/execute`의 선행 조건이 아니다. |
| maintenance graph 생성/검증 | `p2a iteration maintenance add`, `validate` | maintenance task graph를 lazy 생성/append하고, 존재하면 schema/dependency를 검증한다. |
| package init | `p2a init` | 정식 진입점. 빈 코드 프로젝트에 project config, manifest, 시작 가이드, 프로젝트용 `.gitignore`, 선택한 AI 자산을 설치한다. 반복 CLI와 schema는 전역 `p2a` 패키지가 제공한다. |
| 반복 handoff | `p2a handoff --iteration-id active` | 레거시/특수 흐름. plan2agent에서 이미 기획한 산출물을 별도 프로젝트로 옮길 때 active 반복 산출물, `.plan2agent/current-spec.json`, maintenance graph를 대상 프로젝트에 복사하고 handoff 기준점을 기록한다. |
| 회귀 fixture | `scripts/run_fixtures.mjs` | Plan2Agent 본체 저장소에서 greenfield -> init -> current -> tasks ready -> close -> open -> validate/current, draft/compose/handoff 흐름을 검증한다. |

### 0-2. 부분 구현

| 범위 | 현재 구현 | 남은 구현 |
| --- | --- | --- |
| `status.md` 반복 인덱스 | current-spec의 close summary로 과거 행을 렌더링하고 현재 반복만 실제 파일에서 읽는다. | 더 풍부한 사용자용 diff/요약은 후속 UX 항목이다. |
| baseline-aware Gate A/B | entry document 기반 scope ledger, 필요한 만큼 이어지는 확인 대화, Gate A 명시적 확인 차단, current-contract baseline, full-shaped spec의 delta-first view를 제공한다. 과거 intake 답변/disposition 본문은 자동 재사용하지 않는다. legacy `interview` 객체는 opaque 호환 데이터로만 보존한다. | 질문 문구와 변경 영향의 고도화된 의미 판단은 harness agent가 수행하며 품질 평가는 지속 dogfooding한다. |
| 구조적 diff task | current-contract baseline과 active spec의 field 차이를 semantic group으로 병합/분할한다. 과거 task graph overlap은 읽지 않는다. 기존 정본을 `--force`로 다시 만들 수 있는 범위는 모든 task가 `todo`이고 active iteration run history가 없는 실행 전뿐이며 이때 active task id를 재사용한다. | code-aware/LLM 기반 의미 판단은 후속 실행 레이어에서 다룬다. |
| agent 저작 task gate | backbone(`context`, `gate-c-draft` 검증, `promote-tasks`), `p2a-task-author` 스킬, 정식 `task-context` schema, provenance sidecar가 구현됐다. 정본 교체는 모든 task가 `todo`이고 run history가 없는 실행 전 구간에서만 명시적 `--replace-existing`으로 허용하며, 실행 시작 뒤에는 task를 다시 `todo`로 열어도 새 feature iteration 또는 maintenance lane을 사용한다. 상세 계약은 §10이다. | richer code-aware task authoring은 후속 실행 레이어에서 다룬다. |
| archived close | close artifact 존재 여부/hash 기록과 기본 validate-time archive audit을 제공한다. | 기존 pre-audit artifact migration은 필요할 때 `--skip-archive-audit`로 우회한다. |
| maintenance 반복 | lazy README, `maintenance add` task 생성, `maintenance add --from-draft` 승격, 존재하는 task graph 검증, `context --scope maintenance`, `tasks --maintenance` source/target 표와 prompt next command, handoff 시 별도 `.plan2agent/maintenance/task-graph.json` 복사를 제공한다. | 후보 승인/실행 조작은 CLI와 agent 대화 표면을 기준으로 유지한다. |
| agent 실행 추적 | `p2a runs`가 전역 `runs/run-index.json`과 iteration별 `runs/<iterationId>/<runId>.json`을 관리하고, test/lint/typecheck 실행 결과와 git changed files를 수집한다. run/index 갱신은 project lock, atomic write, 중단 복구 journal을 사용한다. legacy 평면 run과 이전 `iterations/<iterationId>/runs/` index는 source/target lock과 재개 가능한 journal을 거친 전역 migration을 지원한다. `--graph` 실행은 경로와 무관하게 graph provenance를 유지하고 milestone 증거에서 제외한다. `p2a-dev-execution`은 한 ready snapshot의 bounded batch에서 task별 직렬 start, 격리 worktree 병렬 구현, 직렬 로컬 통합·검증·finish를 조율한다. | PTY/headless 자동 scheduler, persistent batch CLI, PR 생성은 후속이다. |
| Visual Experience Track | 반복별 spec이 `none|minimal|reuse|full`과 current/deferred timing을 선언한다. `full + current_iteration`은 승인된 screen contract와 dependency-closed offline HTML prototype을 Gate B에 묶고, task에는 명시적 `workKind`와 가벼운 `visualImpact`만 전달하며, 통합 뒤 전체 matrix를 한 번 검증하는 pre-close PNG·접근성 sidecar gate를 둔다. | 브라우저 renderer 자체는 provider 도구를 사용하며 P2A가 별도 headless browser farm을 운영하지 않는다. |

### 0-3. 미구현 / 후속 고도화

| 우선순위 | 항목 | 이유 |
| --- | --- | --- |
| P2 | maintenance task graph 정식 운영 | 생성/검증/handoff 정책은 구현됐고, maintenance 전용 UX가 더 필요하다. |
| P2 | archived 감사 정책 강화 | 기본 검증 강제는 구현됐고, 대규모 legacy migration 도구는 필요 시 후속이다. |
| P3 | agent 자동 실행 orchestration, PR 생성, 병렬 실행 scheduler | foreground skill-level bounded batch는 구현됐고, agent를 직접 headless로 구동·감시하는 scheduler와 persistent batch CLI는 후속이다. |
| P3 | brownfield code-aware intake, 병렬/branch/worktree별 반복 | 파일 기반 단일 반복 루프가 안정된 뒤 확장한다. |

## 1. 배경과 목적

Plan2Agent의 핵심 가치는 기획의 변경 사항이 agent가 실행 가능한 명세와 task로 이어지고, 그 과정과 결과가 시맨틱 문서로 남는 순환 시스템을 만드는 것이다.

현재 권장 greenfield 흐름은 `p2a init --target <project>`로 코드 프로젝트에 하네스를 설치한 뒤, 그 프로젝트가 기획부터 반복 실행까지 같은 artifact root를 소유한다. 기존 handoff는 이미 다른 위치에 만들어진 planning bundle을 복사해야 하는 특수 상황에 남겨둔다.

현재 greenfield 흐름은 다음 한 바퀴를 담당한다.

```text
진입 문서 -> Gate ①/② 결정 -> spec 승인 -> 실행 mode/readiness validation -> iteration init -> 감독형 실행
```

MVP 이후에는 이미 만들어진 산출물과 대상 프로젝트 위에 작은 기능, 개선, 수정, 재작업을 계속 얹어야 한다. 반복/고도화 구조는 그 다음에 오는 흐름을 파일 기반으로 고정한다.

```text
변경 아이디어 -> baseline-aware intake/spec -> Direct/Planned 준비 또는 새 Orchestrated graph -> validate -> handoff/update -> 개발
```

연결 기준:

- 현재 구현 상태와 후속 고도화 후보는 이 문서의 §0 표를 기준으로 삼는다.
- 변경 추적, 반복별 spec/task graph, diff 기반 재작업 task 생성의 상세 계약은 이 문서가 정본이다.
- Gate A-C 산출물 인계와 scaffold 이후 반복 구조는 이 문서와 `docs/cli-reference.md`의 handoff 명령 계약을 따른다.

## 2. 확정 아키텍처

### 2-1. 분절 단위는 `iteration`이다

반복 개발의 분절 단위는 `iteration`이다.

| 결정 | 기준 |
| --- | --- |
| 단위 | 기능 반복 또는 고도화 반복 하나 |
| 저장 방식 | append-only. 아카이브된 반복은 불변으로 두고, 변경은 다음 반복의 새 task로 만든다. |
| 크기 | bounded. Task 수 목표는 두지 않으며, 실제 dependency·별도 write owner·독립 verification/rollback·cross-session resume 경계가 있을 때만 분할한다. |
| 영역 | `core`, `cluster`, `starter` 같은 영역은 분절 축이 아니라 task의 `targetArea` 태그로 둔다. |

근거는 “끝나는 단위”다. 아카이브하려면 명시적으로 끝나는 단위가 필요하다. 반복은 사용자 close와 모든 task 완료로 끝나지만, `core`, `cluster`, `starter` 같은 영역은 계속 살아 있는 제품 영역이므로 아카이브 단위가 되기 어렵다. 영역은 조회와 필터링을 위해 `task.targetArea`에 남긴다.

### 2-2. 생명주기는 활성 기능 반복 1개 + maintenance 반복 1개다

기본 생명주기는 선형 진행으로 둔다.

```text
open iteration -> task 실행 -> 모든 task done -> 사용자 close -> archived -> next iteration open
```

BuildLore는 iteration state machine 안에서 자동 실행되지 않는다. 장기 지식이 필요한 프로젝트는 iteration 전후에 `p2a buildlore sync --dry-run`으로 projection plan을 검토하고, 승인된 로컬 P2A planning·execution evidence를 `p2a buildlore sync`로 별도 knowledge workspace에 기록한다. 다음 Gate A에서 과거 지식이 필요하면 `p2a buildlore search` 또는 `p2a buildlore context`를 명시적으로 실행하며, BuildLore의 project ID 격리를 우회하는 암묵적 cross-project recall은 하지 않는다.

`iteration close`는 BuildLore sync, knowledge commit, push, parent submodule pin을 자동 실행하지 않는다. 따라서 BuildLore 미설정이나 retrieval 실패가 iteration archive를 차단하지 않는다.

규칙:

- 동시에 열린 기능 반복은 1개다.
- 작은 fix, 문서 수정, 패치성 변경은 상시 `maintenance` 반복에 append한다.
- 반복 전환은 암묵적으로 일어나지 않는다. 모든 task done과 사용자 close가 모두 만족될 때만 마감한다.
- 마감 시 해당 반복을 `archived`로 동결하고, 루트 `status.md` 반복 인덱스에 표시한다.
- 마감 상태는 단조롭다. active 반복의 `iteration.json.status`/`closed_at`/`close`와 `current-spec.json.closed_iterations`/`last_closed_iteration`은 함께 archived 상태를 나타내고 `current-spec.json.pending_iteration`은 없어야 하며, `close` 뒤 같은 반복을 planning 상태로 되돌리지 않는다.
- 마감 시 필요하면 개발 대상 프로젝트로 재인계하고, 장기 지식이 필요하면 BuildLore로 선별 projection한다. application git commit은 제품 소스코드 기준점에만 사용한다.
- 한 active iteration 안에서 ready task의 foreground bounded batch는 허용한다. 동시에 여러 iteration을 여는 병렬 반복, branch별 반복, worktree별 planning lane은 후속 고도화로 둔다.

이 결정은 현재 task 상태 CLI가 단일 task graph를 기준으로 동작하는 단순성을 유지한다. 활성 반복 인식은 “현재 어떤 task graph를 볼 것인가”의 선택 문제로 제한한다.

### 2-3. 레이아웃은 루트 인덱스 + current-spec + 반복별 게이트다

반복 개발 산출물은 `.plan2agent/artifacts/<project>/` 아래에 다음 구조로 둔다.

```text
.plan2agent/artifacts/<project>/
  status.md                         # generated 반복 인덱스 view
  decisions.jsonl                  # append-only Gate/scope/constitution decision authority
  current-spec.json                 # 현재 유효 spec 조합본, baseline-aware 기획 컨텍스트
  iterations/
    <iter-id>/
      gate-a-intake/
        intake.json                    # canonical
        intake.md                      # optional explicit Markdown export
      gate-b-spec/
        product-spec.md
        implementation-plan.md
        spec.json
        experience-spec.json             # conditional: full + current_iteration
        visual-design/VD-1/               # conditional offline HTML candidate
      gate-c-task-graph/
        task-graph.json
      milestone-reviews/
        midpoint.json                  # optional, informational, one per checkpoint
        pre_close.json                 # optional, informational, one per checkpoint
    maintenance/
      README.md
      gate-c-task-graph/
        task-graph.json
```

`current-spec.json`은 active iteration과 planning 상태를 가리키는 얇은 포인터다. 실행 정본은 `current-development-contract.json`이고, `status.md`와 사람용 Markdown view는 current-spec의 summary에서 생성하는 읽기용 인덱스다. 과거 composition 필드는 명시적 관리 명령과 구버전 읽기 호환에서만 사용한다.

### 2-4. `maintenance`는 작은 변경의 집이다

`maintenance`는 작은 fix, 문서 수정, 패치성 변경을 모으는 상시 반복이다. 가벼운 fix를 위해 매번 전체 Gate A-C를 강제하지 않고 task graph 중심으로 관리한다. 생성 CLI는 `p2a iteration maintenance add`이며, 첫 task에서 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하고 이후 task를 append한다.

다만 제품 의미가 바뀌는 변경은 `maintenance`에 넣지 않는다. 사용자 흐름, API, 데이터 모델, 성공 기준, 보안/운영성 기준이 바뀌면 별도 기능 반복을 열어 Gate A-C를 다시 통과한다.

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

### 2-6. milestone review는 historical compatibility artifact다

Phase 1부터 새 iteration은 별도 milestone reviewer/sidecar를 만들지 않는다. 통합 결함은 실제 verification, 최종 functional acceptance 또는 필수 visual contract evidence, 그리고 단일 monitor rule gate에서 판정한다. 기존 `iterations/<iter-id>/milestone-reviews/` 파일은 당시 실행 재현과 eval을 위해 계속 읽는다.

Historical artifact는 계속 `p2a.milestone_review.v1` schema로 검증되며 기존 maintenance citation도 보존한다. 새 실행 prompt와 close-ready 판정은 이 파일의 생성을 요구하지 않는다.

## 3. 핵심 원칙

| 원칙 | 설명 |
| --- | --- |
| current authority | 닫힌 반복 문서는 참고·감사용이며 이동하거나 정리해도 현재 개발 권한과 실행은 바뀌지 않는다. 변경, 누락, 재작업은 현재 contract 또는 다음 반복의 새 task로 남긴다. |
| bounded iteration | 반복 하나가 너무 커지면 review, handoff, 실행이 어려워진다. task 개수가 아니라 승인 scope와 검증 가능성으로 경계를 정한다. |
| maintenance | 작은 fix와 운영성 변경은 상시 maintenance 반복에 모아 기능 반복의 의미를 흐리지 않는다. |
| current contract | 사용자가 보는 현재 기준은 `current-development-contract.json`이다. `current-spec.json`은 active/planning pointer이고 다음 기획 baseline은 current contract에서 materialize한다. |

## 4. 재사용과 신규 책임

### 재사용

| 항목 | 재사용 방식 |
| --- | --- |
| Gate A-C | 반복마다 기존 intake/spec/task 게이트 한 벌을 재사용한다. |
| task graph schema | `p2a` package schema `task-graph.schema.json`을 그대로 사용한다. |
| artifact validator | `p2a validate`를 반복 내부 gate 검증에 재사용한다. |
| task graph/task 필드 | top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 반복 개발의 versioning, 상태, 영역 태그, spec trace에 사용한다. 새 task는 사람용 한 문장 `intent`를 추가하지만 기존 graph에서는 선택 필드이며 완료 판정에 사용하지 않는다. |
| source git | 제품 소스코드 기준점을 남긴다. 선별된 P2A 반복·실행 지식은 BuildLore의 별도 knowledge Git 저장소에 보존한다. |
| `p2a handoff` | 활성 반복 산출물과 `current-spec.json`을 대상 프로젝트로 다시 동기화하는 흐름에 재사용한다. |

### 신규

| 항목 | 신규 책임 |
| --- | --- |
| baseline-aware intake/spec | 현재 유효 spec과 변경 아이디어를 함께 읽어 다음 반복의 delta spec과 새 task 후보를 만든다. |
| 활성 반복 인식 | task CLI와 handoff가 `current-spec.json.active_iteration`에서 현재 활성 반복의 task graph 경로를 찾는다. |
| `status.md` 반복 인덱스 | 반복 목록, 상태, close 시점, handoff 기준점을 보여주는 generated view다. |
| `current-spec.json` 조합 | 닫힌 반복 spec과 maintenance 변경 중 현재 유효한 기준을 하나로 조합한다. |
| 반복 open/close | 새 반복 생성, 완료 검증, archived 표시, 다음 반복 open을 명령화한다. |
| handoff 적응 | `p2a handoff --overwrite`로 대상 프로젝트의 `.plan2agent` 기준 산출물을 최신 반복 기준으로 덮어쓴다. |

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
  + optional BuildLore sync preview
      |
      v
p2a handoff --overwrite
      |
      v
대상 프로젝트 .plan2agent 동기화
      |
      v
p2a tasks로 이어서 개발
```

세부 흐름:

1. 사용자는 현재 프로젝트의 `current-spec.json`과 변경 아이디어를 입력한다.
2. baseline-aware intake/spec가 기존 spec과 변경 요청의 차이를 질문과 delta spec으로 정리한다.
3. 승인된 delta spec은 새 반복의 `gate-b-spec/spec.json`으로 저장된다.
4. task breakdown은 새 반복 안에서만 자기완결 `task-graph.draft.json`을 만들고, validator 통과 후 `promote-tasks`가 `task-graph.json`으로 승격한다.
5. 루트 `status.md`는 `current-spec.json.active_iteration`에서 생성되는 view로 갱신할 수 있다.
6. 반복 실행 중 task 상태 변경은 활성 반복의 task graph에만 적용한다.
7. 반복 close 시 `current-spec.json`을 갱신하고, 필요하면 `p2a handoff --overwrite`로 대상 프로젝트를 동기화한다.

## 6. 명령 계약

### 6-1. 현재 구현된 명령

```bash
p2a iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

`init`은 기존 greenfield 산출물을 첫 반복으로 감싼다.

1. 기존 `gate-a-intake/`, `gate-b-spec/`, `gate-c-task-graph/`를 `iterations/<iteration-id>/` 아래로 이동한다.
2. 루트 `status.md`는 반복 인덱스로 재작성한다.
3. 루트 `current-spec.json`은 `iterations/<iteration-id>/gate-b-spec/spec.json`을 가리키는 thin pointer로 생성한다.
4. `iterations/maintenance/README.md`를 만든다. 빈 task graph는 `p2a` package schema `task-graph.schema.json`의 최소 task 수 제약을 위반하므로 만들지 않는다.
5. 이동된 spec과 task graph를 다시 검증한다.
6. `decisions.jsonl`이 있으면 기존 Gate ① 승인을 이동된 artifact 경로와 SHA-256에 다시 결합하는 append 항목을 기록한다. 이 append나 이동 후 검증이 실패하면 이동 파일, generated state와 원장 bytes를 모두 init 전 상태로 롤백한다.

```bash
p2a iteration current --artifacts .plan2agent/artifacts/<project_id>
```

`current`는 active iteration id, task graph 경로, current spec 경로를 출력해 `p2a tasks`와 후속 handoff가 같은 기준을 읽게 한다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id>
```

`validate`는 `current-spec.json.active_iteration`, active iteration Gate B/C JSON 산출물, Gate B approval audit과 Gate C execution metadata를 확인한다. Direct/Planned는 단일 synthetic work item과 mode별 milestone 계약을, Orchestrated는 task dependency를 검사한다. `status.md`는 generated view라서 `--status`로 명시 검증할 때만 구조를 확인한다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready
```

`--require-close-ready`는 모든 active iteration task가 `done`인지 추가로 확인한다. 또한 canonical workspace에서 변경 파일 없이 끝난 final run에 현재 `workspaceRevisionSha256`과 일치하는 full test/lint/typecheck 성공 증거가 있어야 한다. `scope: related` 증거나 이후 source 변경으로 stale해진 full 증거는 거부한다. `visualImpact` task가 있으면 `p2a execute review`가 연 iteration당 하나의 canonical, 변경 없는 review-only run을 요구한다. 비UI iteration의 acceptance 기본값은 `opt_in`이다. 사용자가 `p2a execute accept`를 시작했거나 정책이 `on`이면 `final_acceptance_review` run과 실제 실행 verification에 결합된 `confirm_behavior` sidecar를 요구한다. 시작된 opt-in review는 완료될 때까지 gate로 유지된다. `off`는 이 추가 gate를 비활성화하며, 명시적 검수를 허용하려면 `opt_in`을 사용한다. 두 review 모두 canonical workspace revision과 exact sidecar digest를 봉인하며, acceptance는 각 command/source/exitCode/stdoutTail의 run evidence 일치도 재검증한다. Visual/acceptance final run에서 같은 revision의 full 증거를 기록하면 close가 그대로 재사용하고, 그렇지 않으면 `p2a execute verify-final`이 별도 final verification run을 연다.

Close-ready는 자동 archive 권한이 아니다. 모든 필수 검증이 끝난 뒤 v2 `p2a next`는 `iteration_review_or_close_required` approval action과 구조화된 `review`/`close` 옵션을 반환한다. `review` 옵션은 active iteration을 유지하고 finding 발생 시 owning done task를 reopen하는 remediation command template을 제공한다. 수정 run이 끝나거나 리뷰가 깨끗하면 같은 결정으로 돌아온다. `close` 옵션 안의 정확한 close command는 사용자가 그 옵션을 명시적으로 선택한 경우에만 실행한다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-a

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-b-approved
```

`--allow-planning`은 active 반복이 아직 Gate B/C ready 상태가 아니어도 Gate A-ready, Gate B draft, Gate B approved planning state를 정상 상태로 검증한다. `--stage`는 기대 stage를 명시해 잘못된 상태 전이를 잡는다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --audit-archive
```

`--audit-archive`는 `close` 시점에 기록한 artifact 존재 여부/hash와 현재 파일 상태를 비교해 archived 반복 변경을 감지한다. close 이후 파일 내용이 바뀌거나, close 시점에 없던 감사 대상 파일이 새로 생겨도 실패한다.

```bash
p2a iteration close \
  --artifacts .plan2agent/artifacts/<project_id>
```

`close`는 active 반복의 Gate B/C validation과 모든 task `done`을 재확인한 뒤 `iterations/<iter-id>/iteration.json`을 `status: "archived"`로 갱신한다. Gate D review 파일은 요구하지 않는다. 루트 `current-spec.json`에는 `last_closed_iteration`과 `closed_iterations`가 기록되고, `status.md` 반복 인덱스에는 close 시점이 남는다. active pointer는 닫힌 반복에 그대로 유지된다. 이 세 archive 표면이 모순되면 `validate`가 실패하고 `p2a next`는 `invalid_iteration_state`와 검증 명령을 반환한다. `--iteration-id active`가 기본값이며, 현재 구현은 active 반복 close만 지원한다.

```bash
p2a iteration open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id <next-iter-id> \
  --idea "<change idea>"
```

`open`은 현재 active 반복이 `close`로 archived 되었고 `current-spec.json.closed_iterations`/`last_closed_iteration`에 기록된 경우에만 새 반복 skeleton을 생성한다. `compose`는 필요하지 않다. 직전 `current-development-contract.json`에서 새 반복의 `baseline/gate-a-intake/intake.json`과 `baseline/gate-b-spec/spec.json`을 materialize하고 SHA-256을 pending state와 iteration metadata에 기록한다. 새 contract는 승인된 WEB 근거를 최대 10개까지 보존하고, 이전 contract는 stack evidence에 포함된 공식 URL만 bounded하게 복원한다. 과거 Gate 문서나 archived hash를 baseline 입력으로 읽지 않는다. 새 반복에는 `iteration.json`, `README.md`, Gate A-C 디렉터리, Gate A/B 작성 위치 안내가 생기며, `current-spec.json`은 새 active iteration과 baseline spec만 가리킨다. Gate B/C 정본이 생기기 전까지 기본 `validate`는 실패한다.

```bash
p2a iteration draft \
  --artifacts .plan2agent/artifacts/<project_id>
```

`draft`는 `open`으로 저장된 `idea`, current-contract baseline ref/hash만 읽고 hash를 검증한다. baseline이 있는 반복에 ready intake가 없으면 변경 아이디어와 baseline provenance를 담은 Gate A scope draft만 만들고, 결과·최소 범위·baseline override처럼 범위를 실질적으로 바꾸는 open question을 기록한다. 과거 intake/spec 본문과 답변 provenance는 context packet에 싣지 않는다. 사용자가 scope 요약을 명시적으로 확인한 뒤 `p2a decide --quote "<사용자 발화>" --artifacts <root>`를 실행하면 다시 `draft`를 호출해 Gate B 초안을 생성할 수 있다.

초기 Gate A-only 반복에서는 `baseline_effective_spec_ref`가 없어도 기존 `gate-a-intake/intake.json`을 사용해 Gate B 초안을 생성한다. 이 경우 기존 intake 파일은 유지하고 Gate B 산출물만 쓴다.

baseline-aware Gate A의 `baseline_context`는 current-contract baseline ref/hash와 빈 historical answer/disposition 목록을 기록한다. 현재 scope에서 새로 답한 `ND-n`/`CQ-n`만 Gate B에 반영한다. 기존 범위를 대체하는 answered `ND-n`은 exact `field_ref`/`baseline_value` target을 기록하며, target이 current baseline과 일치하지 않으면 Gate B 생성을 차단한다.

생성 산출물과 선택적 view:

- `iterations/<iter-id>/gate-a-intake/intake.json`
- `iterations/<iter-id>/gate-a-intake/intake.md` (사용자가 명시적으로 요청한 경우만)
- `iterations/<iter-id>/gate-b-spec/spec.json`
- `iterations/<iter-id>/gate-b-spec/product-spec.md`
- `iterations/<iter-id>/gate-b-spec/implementation-plan.md`

기본 동작은 기존 Gate B 파일이 있으면 중단한다. 승인 전 Gate A intake가 있으면 이를 덮어쓰지 않고 현재 intake decision 목록을 유지한다. 변경 아이디어를 덮어 쓰려면 `--idea "<change idea>"`, Gate A/B 초안을 처음부터 재생성하려면 `--force`를 명시한다. `--force`로 baseline-aware 초안을 재생성하면 이전 Gate B draft를 제거하고 새 Gate A scope 확인부터 다시 시작한다. 생성된 `spec.json`은 `approval: "draft"`이므로 Gate C 실행 준비 전 사용자 검토 후 `p2a decide --quote "<사용자 발화>" --artifacts <root>`로 Gate B 승인을 기록해야 한다. `current-spec.json.effective_spec_ref`는 계속 baseline spec을 가리키고, 새 반복 spec은 `pending_iteration.artifacts.spec_ref`에 기록된다.

```bash
p2a iteration promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>
```

`promote-spec`는 승인된 active Gate B `spec.json`과 binding을 기록하고 `current-spec.json.effective_spec_ref`를 즉시 active spec으로 전환한다. 누적 `source_specs/effective_product/effective_implementation`은 current state에 유지하지 않는다. Gate C 승격은 이 active spec에서 `current-development-contract.json`을 새로 materialize한다.

Gate B 승인 직후 이 binding이 아직 없거나 ref/hash/audit 또는 active `iteration.json` promotion metadata가 active spec과 다르면 `p2a next`는 `gate_b_approved_needs_spec_promotion` 상태와 위 `promote-spec` 명령을 반환한다. `context --scope feature`, `diff-tasks`, `validate --stage gate-c-draft`, `promote-tasks`, Direct/Planned `execute prepare`는 같은 binding guard를 공유하며 promotion 완료 전에는 Gate C 산출물을 만들거나 승격하지 않는다. 이미 사용자가 승인한 Gate B의 canonical 반영이므로 이 promotion에는 추가 사용자 승인이 필요하지 않다.

```bash
p2a iteration diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>
```

`diff-tasks`는 approved active spec과 current-contract baseline spec만 field 단위로 비교해 semantic task graph draft를 생성한다. 닫힌 반복의 task graph는 overlap/rework 판단에 읽지 않는다. `--force`는 현재 active graph가 모두 `todo`이고 실행 이력이 없을 때만 active task id를 재사용한다.

```bash
p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --intent "Readers can understand the corrected documentation." \
  --accept "Typo is fixed"
```

`maintenance add`는 `resolveIterationState(..., requireReady: false)` 기준으로 iterative root와 project id만 확인한다. 생성되는 graph는 기존 `p2a.task_graph.v1` 스키마를 그대로 사용하며 `version: "maintenance"`, `sourceSpec: "../../../current-spec.json"`를 기록한다. `--intent`는 사람에게 먼저 보여줄 한 문장 결과이며 생략하면 title을 사용한다. `--ref`가 없으면 `sourceSpecRefs`는 `["maintenance"]`이고, `--ref effective_product.problem`처럼 현재 baseline의 추적 위치를 free string으로 지정할 수 있다. `--depends`는 같은 maintenance graph 안의 기존 task id만 허용되며, 쓰기 전 `validateTaskGraphData`로 schema, 중복 id, dependency, cycle을 재검증한다.

```bash
p2a iteration compose \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration compose \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-conflicts
```

`compose`는 명시적 감사·마이그레이션용 관리 명령이다. 반복 디렉터리들을 순서대로 읽어 approved + close-ready 상태인 반복을 조합하지만, 그 결과는 정상 `next/open/draft/execute`의 권한이나 선행 조건이 아니다.

- `gate-b-spec/spec.json`이 존재하고 `approval: "approved"`이며 `open_decisions`가 비어 있다.
- `gate-c-task-graph/task-graph.json`이 존재하고 모든 task가 `done`이다.

조합 결과는 historical administration view로 기록된다. 다음 `open`은 이 view가 아니라 current contract에서 새 baseline을 만들며, Gate B promotion 때 current-spec은 다시 얇은 active pointer가 된다. composition conflict는 `compose` 자체에서만 fail closed한다.

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
  "gate_b_promoted_at": "2026-08-21T00:00:00.000Z",
  "gate_b_promotion_bindings": {
    "v1-mvp": {
      "source_spec_ref": "iterations/v1-mvp/gate-b-spec/spec.json",
      "source_spec_sha256": "<sha256>",
      "promoted_at": "2026-08-21T00:00:00.000Z"
    }
  },
  "gate_b_approval_audits": {
    "v1-mvp": {
      "approved_by": "user",
      "approved_at": "2026-08-21",
      "approved_artifacts": ["iterations/v1-mvp/gate-b-spec/spec.json"],
      "approval_note": "Gate B approved."
    }
  },
  "note": "반복 1개라 이 반복 spec이 곧 현재 유효 spec."
}
```

Gate A만 완료된 초기 planning 반복은 아직 approved spec이 없으므로 임시로 다음 형태를 허용한다. 이 형태는 `p2a iteration current`의 active pointer 해석 대상이지만, 현재 `p2a iteration validate`의 통과 대상은 아니다.

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
      "intake_ref": "iterations/v1-mvp/gate-a-intake/intake.json"
    }
  },
  "note": "Gate B spec is not available yet."
}
```

Gate B가 승인되면 `p2a iteration promote-spec`로 `effective_spec_ref`를 `iterations/v1-mvp/gate-b-spec/spec.json`로 갱신한다.

`open`과 `draft` 중인 반복은 `pending_iteration`을 함께 기록한다.

```json
{
  "pending_iteration": {
    "iteration_id": "iter-002",
    "status": "gate_b_draft",
    "idea": "변경 아이디어",
    "baseline_iteration": "v1-mvp",
    "baseline_effective_spec_ref": "iterations/iter-002/baseline/gate-b-spec/spec.json",
    "baseline_effective_spec_sha256": "<sha256>",
    "artifacts": {
      "intake_ref": "iterations/iter-002/gate-a-intake/intake.json",
      "spec_ref": "iterations/iter-002/gate-b-spec/spec.json"
    }
  }
}
```

Gate A/B draft 동안 `effective_spec_ref`는 current-contract baseline을 유지한다. `promote-spec`가 active spec을 현재 pointer로 전환하고, Gate C promotion이 새 current development contract를 materialize한다.

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
- `effective_product`와 `effective_implementation`은 관리용 historical view다. 다음 intake/spec 기준은 current contract snapshot이다.
- 모호한 충돌은 자동 병합하지 않는다. 기본 `compose`는 쓰기 전에 실패하고 `--allow-conflicts`는 관리용 composition decision을 기록한다.

## 8. 검증 계약

반복 구조 validator는 `p2a iteration validate`에서 시작한다. 현재 구현은 **Gate B/C가 존재하는 실행 가능한 반복**을 대상으로 한다.

- `current-spec.json.active_iteration`이 실제 `iterations/<id>/`와 일치한다.
- active iteration의 Gate B/C 산출물이 존재하고 기존 JSON schema 검증을 통과한다.
- 반복 내부 task dependencies는 같은 반복 안의 task id만 참조한다.
- close 대상 반복은 모든 task가 완료 상태여야 하며, visual review pass가 활성화된 경우 canonical final visual review evidence도 유효해야 한다.
- 명시적 composition/archived 감사에서는 historical source와 hash를 검증한다. 일반 current 실행은 이를 검증하지 않는다.

현재 구현의 planning 검증:

- Gate A만 완료된 반복(`gate_a_ready`)은 `--allow-planning` 또는 `--stage gate-a`로 검증한다.
- Gate B draft는 `--allow-planning` 또는 `--stage gate-b-draft`로 검증한다.
- Gate B approved는 `--stage gate-b-approved`로 검증한다.
- maintenance 반복은 `p2a iteration maintenance add`로 task graph를 lazy 생성/append하고, `iterations/maintenance/gate-c-task-graph/task-graph.json`이 존재하면 schema/dependency를 검증한다.
- archived 반복은 `--audit-archive`를 명시하면 close 시점의 artifact 존재 여부/hash와 현재 파일 상태를 비교한다.

기존 `validate_artifacts.mjs --artifact-root`는 greenfield root 구조를 검증한다. 반복 구조 검증은 `p2a iteration validate`가 담당한다.

현재 명령:

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready
```

planning stage 검증:

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-a

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning
```

`--stage gate-a` 또는 `--allow-planning`은 다음을 확인한다.

- active 반복 디렉터리가 존재한다.
- `gate-a-intake/intake.json`이 schema 검증을 통과한다.
- `current-spec.json.pending_iteration.status`가 `active_planning`, `gate_a_interview`, `gate_a_ready`, `gate_b_draft`, `gate_b_approved` 중 하나다.
- Gate B/C 누락은 실패가 아니라 pending 상태로 보고한다.

후속 validator 확장은 legacy archive migration과 agent 실행 결과 audit이다.

## 9. handoff 적응

기존 `p2a handoff`는 greenfield `.plan2agent/artifacts/<project_id>/gate-*` root를 계속 지원한다. 반복 구조 root(`current-spec.json` + `iterations/`)를 넘기면 기본값은 active 반복 인계다.

1. `current-spec.json.active_iteration`을 읽어 active 반복을 선택한다.
2. `--iteration-id <id>`를 명시한 경우에도 해당 id가 active 반복과 일치하는지 확인한다.
3. 대상 프로젝트에는 `.plan2agent/artifacts/`에 active 반복 산출물을 배치하고, `.plan2agent/current-spec.json`도 함께 배치한다.

기본값은 `--iteration-id active`다. 특정 iteration id를 명시할 수 있지만 비활성·과거 반복은 Gate bundle과 current spec 상태가 어긋나므로 인계를 거부한다.

```bash
p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target /path/to/project \
  --iteration-id active \
  --overwrite
```

반복 handoff는 active 반복의 Gate B/C가 인계 가능한 상태인지 검증한 뒤 다음을 쓴다.

- `.plan2agent/artifacts/product-spec.md`
- `.plan2agent/artifacts/implementation-plan.md`
- `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json`
- `.plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json`
- `.plan2agent/artifacts/status.md`
- `.plan2agent/current-spec.json`

handoff는 active 반복의 `task-graph.sourceSpec`을 `spec.json`으로, `spec.source_intake`를 `intake.json`으로 rebase하고, traceability 검증을 위해 active 반복의 `gate-a-intake/intake.json`을 항상 `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json`으로 함께 복사한다. `--include-intake`를 붙이면 기존 Markdown 파일을 복사하지 않고 대상에 기록할 canonical `intake.json`에서 explicit-export marker가 있는 최신 사람용 `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.md`를 다시 생성한다. `decisions.jsonl`은 projection/rebuild 범위가 아니므로 평탄화 대상에 복사하거나 참조 경로를 다시 쓰지 않는다. 대상에 원장이 없으면 복사된 `approval_audit` 사본이 legacy fallback으로 작동하고 전체 결정 이력은 source artifact root에 보존된다. `--run-transfer completed`가 기본값이며 현재 iteration/task graph에서 task별 최신 canonical `p2a.run.v2` finished implementation evidence를 복사하고, historical milestone review가 직접 참조한 finished evidence도 호환 보존한다. 같은 iteration/task graph의 최신 finished `final_visual_review` 또는 `final_acceptance_review` evidence는 sidecar와 함께 포함한다. 이 portable 경로는 run·provenance JSON의 자동 migration/rewrite를 수행하지 않는다. Run layout은 `p2a runs migrate-layout`, finished v1 schema는 `p2a runs migrate-schema`, non-canonical provenance reference는 명시적 import/migration workflow로 handoff 전에 정규화한다. 진행 중 non-visual run이나 구형 호환 이력까지 source closure와 함께 재개해야 할 때만 `--run-transfer resumable`을 명시한다. 진행 중 final review는 resumable 인계도 거부하며 먼저 finish 또는 block해야 한다. Handoff는 쓰기 뒤 target Gate A-C bundle과 run store를 재검증하고 실패 시 target을 rollback한다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않고 `copy`만 허용한다. maintenance task graph가 있으면 active graph와 병합하지 않고 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다.

`--tools codex,claude,gemini|all`은 반복 handoff에도 동일하게 적용된다. 산출물과 `current-spec.json`을 복사한 뒤 대상 프로젝트에 공통 `.agents/skills`, `.agents/agents`와 선택한 CLI별 `.codex`, `.claude`, `.gemini` P2A 자산을 설치하고, 설치 목록을 `.plan2agent/manifest.json`에 기록한다.

`--include-team-bigfive`도 반복 handoff에 동일하게 적용된다. `--team-bigfive-source`가 local directory이면 source manifest에 파일 목록과 SHA-256을 기록하고, Git URL이면 fetch 없이 URL provenance만 기록한다. 선택 target별 adapter entrypoint는 `.agents/.codex/.claude/.gemini` 아래에 생성되며, 외부 하네스 기록은 `.plan2agent/manifest.json.externalHarnesses`와 `.plan2agent/project.config.json.teamBigFive`에 남긴다.

## 10. Agent 저작 task 게이트

상태: **핵심 게이트 구현**. backbone(`context` / `validate --stage gate-c-draft` / `promote-tasks`), 저작 스킬(`p2a-task-author`), 정식 context 스키마(`p2a.task_context.v2`), provenance sidecar가 구현됐다. maintenance context/실행 UX와 draft 파일을 maintenance graph에 append하는 Phase 1 승격 명령도 연결됐다.

이 절은 agent가 task를 저작하고 validator-clean draft를 정본으로 승격하는 흐름의 구현 계약을 정의한다. `diff-tasks`는 deterministic semantic draft generator로 유지하고, agent 저작 경로는 더 깊은 맥락 판단을 붙이는 확장 경로다.


| 조각 | 명령/파일 | 상태 |
| --- | --- | --- |
| 컨텍스트 번들 | `p2a iteration context` | ✅ 구현 |
| 초안 검증 | `p2a iteration validate --stage gate-c-draft` | ✅ 구현 |
| validator 기반 승격 | `p2a iteration promote-tasks` | ✅ 구현 |
| 저작 스킬 | `.agents/skills/p2a-task-author/SKILL.md` (+ `.claude` mirror, Gemini shim) | ✅ 구현 |
| 회귀 테스트 | `run_fixtures`(context/gate-c-draft/promote) + `check_cli_parity`(skill mirror) | ✅ |
| provenance sidecar | `task-graph.draft.meta.json` | ✅ 구현 |
| 정식 context 스키마 | `p2a` package schema `task-context.schema.json` + `validateTaskContextData` (context가 출력 전 자기검증) | ✅ 구현 |
| `context --scope maintenance` | 유지보수 레인 context JSON 출력 | ✅ 구현 |
| Phase 1 (maintenance 파일럿 + fix/기능 분류) | `context --scope maintenance`, `tasks --maintenance` 실행 UX, `maintenance add --from-draft` 구현 | ✅ 구현 |

feature task graph 기준의 핵심 backbone은 끝에서 끝까지 동작한다. maintenance 파일럿도 context 출력, 실행 UX, draft 파일의 maintenance graph append 승격 명령까지 연결됐다.

### 10-1. 목적과 위치

- 문제: deterministic `diff-tasks`는 spec field 차이를 semantic group으로 병합/분할하고 rework/reuse를 표시하지만, code-aware 판단이나 복잡한 task 재구성까지 맡기지는 않는다.
- 해법: 기획층(Gate C)에 **agent 저작 + validator 기반 승격**을 추가한다. agent는 현재 기준 맥락을 읽어 richer task 초안을 쓰고, validator 통과 후 CLI가 정본으로 승격한다.
- 불변: 실행층(`p2a tasks`)과 `p2a` package schema `task-graph.schema.json`은 바꾸지 않는다. agent 출력도 기존 `p2a.task_graph.v1`을 따른다.
- 범위 연결: diff 기반 고도화 방향을 Gate C validation/promotion 계약으로 구체화한다.

### 10-2. 핵심 원칙

| 원칙 | 계약 |
| --- | --- |
| 초안 분리 | agent 출력은 `task-graph.draft.json`에만 쓴다. 정본 `task-graph.json`은 직접 쓰지 않는다. `p2a tasks`는 정본만 읽으므로 미검증 task가 실행 대상(`ready`/`start`)에 노출되지 않는다. |
| validator 기반 승격 | 초안 -> 정본 승격은 `validateTaskGraphData`를 다시 통과한 경우에만 일어난다. 별도 사람 승인 audit은 없다. |
| 추적성 강제 | 승격 전 `validateTaskGraphData`가 schema·중복 id·dependency·cycle을 검사하고, `sourceSpecRefs` 최소 1 제약으로 agent 출력에도 spec 추적을 강제한다. |

### 10-3. 산출물 계약

| 산출물 | 역할 |
| --- | --- |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json` | agent 저작 초안. 기존 `p2a.task_graph.v1` schema를 그대로 따른다. `version`은 `"<iter-id>-draft"` 같은 초안 표식을 권장한다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.json` | 검증 후 승격된 정본. 실행/handoff 대상은 이 파일뿐이다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json.promoted` | 승격 후 history로 보존되는 직전 초안. (`promote-tasks`가 rename으로 남긴다.) |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.meta.json` | provenance sidecar. draft hash, source spec hash, source idea, baseline ref, 승격 시각을 기록한다. schema를 건드리지 않으려고 provenance는 정본 밖에 둔다. |

### 10-4. 컨텍스트 번들 계약

`p2a iteration context`는 agent가 task를 저작하는 데 필요한 현재 기준 맥락을 읽기 전용 JSON으로 모은다.

```bash
p2a iteration context \
  --artifacts .plan2agent/artifacts/<project_id> \
  [--idea "<change idea>"] \
  [--code-root <dir>]
```

출력 형식:

```json
{
  "schema_version": "p2a.task_context.v2",
  "project_id": "example-project",
  "active_iteration": "iter-002",
  "scope": "feature",
  "idea": "변경 아이디어 또는 버그 설명",
  "baseline_effective_spec_ref": "iterations/iter-002/baseline/gate-b-spec/spec.json",
  "effective_spec": { "product": {}, "implementation": {} },
  "existing_tasks": {
    "active": [
      { "id": "task-001", "title": "...", "status": "done", "targetArea": "...", "sourceSpecRefs": ["implementation.architecture"] }
    ],
    "maintenance": []
  },
  "spec_field_changes": [
    { "section": "implementation", "field": "architecture", "specRef": "implementation.architecture" }
  ],
  "code_signals": {
    "code_root": ".",
    "file_tree": ["src/Demo.kt"],
    "truncated": false,
    "recent_changes": [
      { "taskId": "task-001", "runId": "run-...", "status": "finished", "changedFiles": ["src/Demo.kt"], "finishedAt": "2026-01-01T00:00:00.000Z" }
    ]
  }
}
```

- `effective_spec`은 `current-spec.json`의 effective view(또는 thin pointer가 가리키는 active spec)에서 읽는다.
- `existing_tasks`는 중복 저작과 재사용 판단을 돕기 위해 active 반복과 maintenance graph의 task 요약을 함께 제공한다.
- `spec_field_changes`는 baseline이 있으면 `diff-tasks`와 같은 field 비교 결과를 재사용한다.
- BuildLore 지식은 spec의 `LOCAL-n` evidence로 선택하며, history가 task boundary/dependency/AC를 바꿀 때만 실제 spec field ref 옆에 해당 evidence, `decision:` ref, concrete mitigation을 남긴다.
- `code_signals`는 L1 실제 파일 트리(`--code-root`, 하네스/빌드/의존성 디렉터리 제외, cap 적용)와 L2 run log 기반 최근 변경 파일을 제공한다. L3 git diff와 L4 코드 요약은 후속이다.
- `context`는 어떤 파일도 쓰지 않는다.
- `scope`는 `feature`가 기본값이며, `--scope maintenance`는 유지보수 레인 context를 출력한다.
- 출력은 `p2a` package schema `task-context.schema.json`(`p2a.task_context.v2`)을 따르며, `context` 명령이 출력 전 `validateTaskContextData`로 자기검증해 무효 context를 내보내지 않는다.

### 10-5. 명령 계약

| 명령 | 입력 | 동작 | 실패 조건 |
| --- | --- | --- | --- |
| `context` | iterative root, 선택적 idea | §10-4 번들을 stdout으로 출력 | iterative root 해석 실패 |
| `validate --stage gate-c-draft` | iterative root | active 반복의 `task-graph.draft.json`을 schema/dependency/cycle로 검증(승인 불요) | draft 없음, schema/dependency/cycle 위반 |
| `promote-tasks` | iterative root | active 반복의 `task-graph.draft.json`을 검증(approved spec 포함)한 뒤 `task-graph.json`으로 승격. 기존 정본 교체는 모든 task가 `todo`이고 active iteration run history가 없을 때 명시적 `--replace-existing`을 준 경우만 허용 | draft 없음, draft 검증 실패, 기존 정본이 있는데 opt-in 없음, 실행이 시작된 정본 교체 시도 |
| `maintenance add --from-draft <file>` | maintenance 초안 파일 | 초안 task들을 검증 후 maintenance graph에 append (§10-8 Phase 1) | 초안 검증 실패, `--yes` 누락, dependency/cycle 위반 |

`promote-tasks`는 기존 정본이 있으면 기본적으로 교체를 거부한다. 모든 기존 task가 아직 `todo`이고 active iteration run history가 전혀 없는 실행 전 구간에서만 완전한 replacement draft에 `--replace-existing`을 명시해 교체할 수 있다. 하나라도 `in_progress`, `done`, `blocked`이거나 run이 기록됐다면 task를 나중에 `todo`로 다시 열어도 run lineage와 task 의미를 지키기 위해 교체하지 않고 새 feature iteration 또는 maintenance lane을 사용한다. 승격 시 `version`의 `-draft` 접미사를 제거하고, provenance sidecar를 `task-graph.draft.meta.json`에 기록하며, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

### 10-6. Gate C validator 기반 승격

Gate C draft는 별도 사람 승인 audit 없이 validator 통과 여부로 승격한다.

```bash
p2a iteration promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id>
```

`promote-tasks` 동작:

1. active 반복의 `task-graph.draft.json`을 읽고 `validateTaskGraphData(draft, specPath)`로 재검증한다(approved spec + open_decisions 비어있음 + schema/dependency/cycle).
2. baseline 정본이 있으면 기본 승격을 거부한다. 완전한 replacement draft이고 모든 정본 task가 `todo`이며 active iteration run history가 없을 때만 `--replace-existing`을 요구해 교체하며, 실행이 시작된 정본은 task를 다시 열어도 교체하지 않는다.
3. 초안을 `task-graph.json`으로 승격하고, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

`validate` 확장:

- 아직 승격되지 않은 초안은 `--stage gate-c-draft`로 approved spec, schema, dependency, cycle을 검증한다.
- 승격된 정본도 같은 Gate B/C validator 계약을 따르며 Gate C audit은 요구하지 않는다.

### 10-7. 저작 스킬 `p2a-task-author`

- 입력: §10-4 context 번들. 출력: `p2a-task-author` 서브에이전트가 반환하는 draft JSON과 skill owner가 저장하는 `task-graph.draft.json`.
- 책임: read-only `p2a-task-author` 서브에이전트가 변경 의미와 spec에 선택된 BuildLore `LOCAL-n` evidence를 읽어 task를 병합/분할하고, `existing_tasks`와 중복을 피하며, 각 task의 `sourceSpecRefs`를 effective spec 항목으로 채운다. Material prior failure가 있으면 affected task에 mitigation/regression AC와 evidence/`decision:` lineage ref를 real spec field ref 옆에 추가한다. skill owner만 반환된 JSON을 초안 파일로 저장하고 검증한다.
- 제약: 서브에이전트는 파일이나 코드·의존성을 변경하지 않으며 정본을 직접 쓰지 않는다. skill owner도 초안만 쓰고, 정본 승격은 검증 이후 `promote-tasks`가 수행한다.
- mirror: 기존 skill mirror 규약(`.agents/skills` -> `.claude`/`.gemini`, command shim)을 따르고 `check_cli_parity`로 검증한다. 기존 `p2a-task-breakdown`의 sibling이다.
- **구현됨**: `.agents/skills/p2a-task-author/SKILL.md`와 `.agents/agents/p2a-task-author.md` (canonical) + provider별 skill/agent mirror + `.gemini/commands/p2a/task-author.toml` shim. mirror/shim은 `sync_cli_assets.mjs`가 생성하고 `check_cli_parity.mjs`가 검증한다. 서브에이전트는 draft JSON을 반환하고, skill owner는 초안 저장과 검증 후 `promote-tasks`를 실행한다.

### 10-8. 단계별 도입

| 단계 | 범위 | 게이트 | 상태 |
| --- | --- | --- | --- |
| Phase 1 (파일럿) | maintenance 레인 | `context --scope maintenance`, `tasks --maintenance` 실행 UX, `maintenance add --from-draft`의 `--dry-run`/`--yes` confirm + validate-before-write | ✅ 구현 |
| Phase 2 | feature task graph | Gate C validation + `promote-tasks` | ✅ backbone + 저작 스킬 구현 |

Phase 1 흐름은 `context --scope maintenance`로 유지보수 레인 context를 출력하고, `tasks --maintenance list|ready|prompt`로 source/target과 실행 next command를 확인한 뒤, agent나 eval이 만든 maintenance draft를 사람이 검토하고 `maintenance add --from-draft <file> --dry-run`으로 preview한 다음 `--yes`로 append하는 것이다. ungated maintenance 특성상 별도 정본/초안 분리 없이 append 직전 `--yes` 확인을 게이트로 둔다. 중복 `eval-cluster:*`/proposal ref는 append 시 skip되며, draft-local dependency는 새 maintenance task id로 매핑된다. 단, maintenance는 본질적으로 코드-side 활동이라 후보 승인/실행 조작은 CLI와 agent 대화 표면을 기준으로 유지한다(이관된 fix/기능 경계 분류 포함).

Phase 2 흐름: `context` -> read-only `p2a-task-author` 서브에이전트가 draft JSON 반환 -> skill owner가 `task-graph.draft.json` 저장 -> Gate C validation -> `promote-tasks`로 정본 승격 -> `p2a tasks` 실행. `diff-tasks`는 deterministic semantic draft generator로 남고, agent-authored draft 경로와 같은 Gate C validation/promotion 계약으로 수렴한다.

### 10-9. 가드레일

- 무검증 승격 금지: 승격은 항상 Gate C validator 통과가 선행한다.
- 추적성 완화 금지: `sourceSpecRefs` 최소 1 제약을 agent 출력에도 적용한다.
- 실행층 불변: 저작/승격 로직을 `p2a tasks` 상태 전이 명령에 넣지 않는다.
- 초안 격리: `task-graph.draft.json`은 승격 전까지 `p2a tasks`/`p2a handoff` 대상이 아니다.
- 비목표 경계 유지: deterministic `diff-tasks`와 agent-authored Orchestrated draft는 모두 Gate C validation/promotion을 거친다. Adaptive foreground 실행은 별도 실행 계약에서 제공하며, agent를 직접 headless로 구동·감시하는 persistent scheduler와 자동 PR 생성은 여전히 비목표다.

### 10-10. 검증/회귀 계획

- `run_fixtures.mjs` 추가 케이스: `context` 출력 형식, `--stage gate-c-draft` 초안 검증(양성/cycle 음성), audit 없이 `promote-tasks` 승격 + 정본 검증. (구현됨.)
- `check_cli_parity.mjs`: `p2a-task-author` skill mirror와 command shim drift 검증. (구현됨.)
- 기존 회귀(`run_fixtures`, `check_cli_parity`)는 그대로 통과해야 한다.

## 11. 비목표와 후속 고도화

이 문서의 비목표:

- 기존 코드베이스를 자동으로 읽고 spec을 역생성하는 brownfield code-aware intake
- multi-iteration 병렬 scheduler, branch별 반복, worktree별 반복 planning lane
- agent 자동 실행, PTY 제어, PR 생성, 결과 diff 자동 병합
- DB, pgvector, Neo4j 기반 plan-code 계보 저장

후속 고도화는 이 문서의 iteration 레이아웃, current development contract, 얇은 `current-spec.json` pointer, semantic `diff-tasks`, 파일 기반 run log를 전제로 붙인다. code-aware spec 역생성, PTY 기반 agent orchestration, PR 생성, 결과 자동 병합은 실행 레이어가 필요해 별도 단계로 둔다.

## 12. 구현 조각 순서

| 순서 | 조각 | 상태 | 이유 |
| --- | --- | --- | --- |
| 1 | 레이아웃/인덱스 규약 + greenfield migration | 완료 | `p2a iteration init`으로 Gate B/C까지 있는 greenfield bundle을 반복 구조로 변환한다. |
| 1-1 | Gate A-only artifact 반복 동기화 | 부분 완료 | `lightweight-embedded-redis`처럼 Gate A만 있는 artifact는 반복 구조에서 해석/검증/draft 가능하다. 자동 migration 명령은 아직 없다. |
| 2 | `status.md` 반복 인덱스 | 완료 | current summary로 과거 행을 렌더링하고 현재 Gate만 읽는다. |
| 3 | current development contract | 완료 | current execution authority와 다음 iteration baseline을 historical Gate 문서에서 분리한다. |
| 4 | `p2a tasks` active iteration 인식 | 완료 | `--artifacts`가 active 반복 graph를 찾아 task 조회와 상태 변경에 사용한다. |
| 4-1 | Gate B/C 반복 구조 validator | 완료 | `p2a iteration validate`가 active 반복 구조와 close-ready 조건을 검증한다. |
| 4-2 | Gate A-ready/planning validator | 완료 | `--stage`와 `--allow-planning`이 Gate A-only, Gate B draft, Gate B approved 상태를 검증한다. |
| 4-3 | 반복 open skeleton | 완료 | `p2a iteration open`이 archived current contract에서 baseline spec과 새 반복 metadata를 만든다. |
| 5 | baseline-aware Gate A/B draft | 완료 | `draft`가 baseline provenance를 가진 Gate A scope ledger를 먼저 만들고, explicit Gate A confirmation 뒤에만 full-shaped delta spec과 delta-first readable view를 생성한다. 질문 수나 대화 turn 제한 없이 범위가 확인되면 진행하며 `p2a next` 전이 계약은 schema/validator/skill/test로 고정한다. |
| 5-1 | Gate B 승인 반영 | 완료 | `promote-spec`가 approved active spec을 현재 pointer로 전환하고 누적 composition을 current state에서 제거한다. |
| 5-2 | diff 기반 task graph 초안 | 완료 | `diff-tasks`가 current baseline과 active spec 차이만 semantic group으로 변환한다. |
| 6 | handoff 적응 | 완료 | `p2a handoff`가 active 반복 산출물, current development contract, maintenance graph를 대상 프로젝트로 복사하고 handoff 기준점을 기록한다. |
| 7 | 반복 open/close 명령 | 완료 | 반복 생성, close-ready 마감, archived summary, current-contract 기준 다음 반복 open을 자동화한다. |
| 8 | 반복 fixture/golden | 완료 | greenfield -> init -> current -> tasks ready -> close -> open -> validate/current root 흐름과 draft/compose/handoff 회귀를 고정했다. |
| 9 | archived append-only 감사 | 완료 | close 시 artifact 존재 여부/hash를 기록하고 기본 `validate`에서 변경을 감지한다. legacy/migration은 `--skip-archive-audit`로 우회한다. |
| 10 | 구조적 diff task 생성 | 완료 | `diff-tasks`가 current baseline semantic group, `--force` active task reuse, question disposition acceptance를 생성한다. |
| 11 | maintenance task graph 운영 | 완료 | `maintenance add`가 graph를 lazy 생성/append하고 validate가 schema/dependency를 검증하며 handoff 시 별도 maintenance graph로 복사한다. |
| 12 | agent 실행 추적 | 완료 | `p2a runs`가 run-index/run log, task별 runId, changedFiles, verification, agentTool, workspaceRef, 선택적 branch/worktree 격리 생성, test/lint/typecheck 결과 수집을 제공한다. `p2a-dev-execution`은 같은 ready snapshot의 task를 bounded parallel implementer worktree에 배정하고 main owner가 start·로컬 통합·검증·finish를 직렬화한다. |

## 13. 검증 메모

- 제품 로드맵의 “새 버전의 명세와 task graph” 방향은 반복별 `gate-b-spec/spec.json`과 `gate-c-task-graph/task-graph.json`으로 구체화한다.
- 제품 로드맵의 “기획 변경 diff 기반 재작업 task 생성” 방향은 이 문서의 `diff-tasks`, Gate C draft, promotion 계약으로 구체화한다.
- task graph schema는 top-level `version`과 task별 `status`, `targetArea`, `sourceSpecRefs`를 요구한다.
- validator는 같은 task graph 안의 task id 집합을 만든 뒤 `dependencies`가 그 집합 안에 있는지 검사하므로, 반복 간 dependency를 넣지 않는 채택안은 schema/validator 변경 없이 적용 가능하다.
