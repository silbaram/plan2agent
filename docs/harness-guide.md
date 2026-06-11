# Plan2Agent 하네스 사용자 가이드

이 문서는 Plan2Agent(P2A) 하네스를 처음 사용하는 사용자가 한 문장 아이디어를 검토 가능한 기획 산출물로 바꾸는 흐름을 이해하도록 돕는 안내서다. 기준은 `p2a-harness` skill, 하네스 구현 기준, 그리고 저장소 readme의 최신 정책이다.

## 목차

- [1. 개요](#1-개요)
  - [1.1 전제조건과 첫 검증](#11-전제조건과-첫-검증)
- [2. 승인 게이트](#2-승인-게이트)
- [3. 산출물 파일과 데이터 계약](#3-산출물-파일과-데이터-계약)
  - [3.1 산출물과 스키마 매핑](#31-산출물과-스키마-매핑)
  - [3.2 주요 스키마 필드](#32-주요-스키마-필드)
  - [3.3 evidence와 인용 규칙](#33-evidence와-인용-규칙)
- [4. 재개(resume)](#4-재개resume)
- [5. CLI별 실행 방법](#5-cli별-실행-방법)
- [6. 예시: cache-library 워크스루](#6-예시-cache-library-워크스루)
  - [6.1 실제 산출물 발췌](#61-실제-산출물-발췌)
- [7. Gate D 이후 개발 진행](#7-gate-d-이후-개발-진행)
- [8. 검증 방법](#8-검증-방법)
- [9. 트러블슈팅/FAQ](#9-트러블슈팅faq)
- [10. 용어집](#10-용어집)
- [11. 추가 포인터와 v1/v2 범위](#11-추가-포인터와-v1v2-범위)

## 1. 개요

Plan2Agent 하네스는 한 문장 제품 아이디어를 바로 코드로 구현하지 않고, 승인 게이트를 거쳐 개발 가능한 계획으로 다듬는 planning workflow다. v1 하네스는 코드 변경, dependency 설치, 구현 목적의 shell 실행을 하지 않는다. 대신 Claude Code, Codex, Gemini CLI가 공통 skill과 subagent 역할을 사용해 같은 산출물 계약을 따르도록 한다.

파이프라인은 다음 순서로 진행된다.

```text
한 문장 아이디어
  -> Intake(Gate A)
  -> Product spec + Implementation plan(Gate B)
  -> Task graph(Gate C)
  -> Review(Gate D)
  -> 별도 개발 세션에서 task 실행
```

| 단계 | 담당 skill | 주요 역할 | 산출물 |
| --- | --- | --- | --- |
| 1. Intake | `p2a-intake` | 아이디어를 사실, 가정, 질문, 사용자 결정 항목으로 구조화한다. | `intake_json`, `intake.md` |
| 2. Product spec | `p2a-spec` | 답변된 intake를 제품 목표, 범위, 사용자 흐름, 성공 기준으로 정리한다. | `product_spec_markdown`, `spec_json.product` |
| 3. Implementation plan | `p2a-spec` | 승인 가능한 제품 명세를 아키텍처, 인터페이스, 데이터 흐름, 검증 계획으로 바꾼다. | `implementation_plan_markdown`, `spec_json.implementation` |
| 4. Task graph | `p2a-task-breakdown` | 승인된 구현 명세를 의존성 있는 작은 task로 분해한다. | `task_graph_json` |
| 5. Review | `p2a-review` | 명세와 task graph의 누락, gate 위반, 의존성 오류, 실행 리스크를 검토한다. | `review_report` |

하네스는 대화 안에서도 `intake_json`, `product_spec_markdown`, `implementation_plan_markdown`, `spec_json`, `task_graph_json`, `review_report`라는 이름의 상태 섹션을 반환한다. 동시에 각 단계 산출물을 `artifacts/<project_id>/` 아래 gate별 폴더에 저장해 사용자가 게이트 전에 파일로 열어 검토할 수 있게 한다.

### 1.1 전제조건과 첫 검증

- **저장소 루트에서 실행한다.** 이 문서의 모든 예시 명령은 `/workspace/plan2agent` 같은 Plan2Agent 저장소 루트를 현재 작업 디렉터리로 가정한다.
- **Node.js가 필요하다.** 검증/동기화/fixture/task 관리 스크립트는 `#!/usr/bin/env node`로 실행되는 ESM(`.mjs`) 스크립트다. 별도 npm dependency를 설치하지 않고 Node.js 표준 라이브러리만 사용한다.
- **v1 하네스는 read-only planning이다.** 하네스와 subagent는 제품 기획 산출물(`.md`, `.json`)을 만드는 데 집중한다. 코드 변경, dependency 설치, 구현 목적 shell 실행, git 조작은 v1 workflow에 포함하지 않는다. 단, 이 저장소의 검증 스크립트를 실행해 산출물 계약을 확인하는 것은 문서화된 검증 절차다.
- **클론 직후 첫 검증은 fixture와 CLI parity를 확인한다.** 아래 두 명령이 통과하면 스키마/게이트 검증과 CLI mirror 상태가 기본적으로 맞아 있다.

```bash
node scripts/run_fixtures.mjs
node scripts/check_cli_parity.mjs
```

개별 fixture만 빠르게 확인하려면 다음 명령을 사용한다.

```bash
node scripts/validate_artifacts.mjs --fixture-dir fixtures/cache-library
```

## 2. 승인 게이트

각 게이트는 단순 체크리스트가 아니라 사용자 검토 지점이다. 하네스는 해당 단계의 파일을 먼저 저장하고, 근거와 추천을 포함한 읽기 쉬운 요약을 제시한 뒤, 자유 형식 피드백과 구조화된 답변 또는 승인을 명시적으로 요청한다. 사용자가 응답하면 산출물을 수정해 다시 제시하고, 명시적 승인 없이는 다음 단계로 넘어가지 않는다.

### Gate A — Intake decisions

Intake 결과의 `needs_user_decision.status` 중 하나라도 `open` 또는 `deferred`이면 하네스는 intake 후 멈춘다. 이때 제품 명세를 확정하지 않고, 열린 결정 항목만 사용자에게 묻는다. 각 결정은 질문, 중요한 이유, 선택지별 trade-off, 추천 선택지와 근거, 막고 있는 downstream 산출물을 함께 보여줘야 한다.

### Gate B — Spec approval

`spec_json.approval`이 `approved`가 아니거나 `spec_json.open_decisions`가 비어 있지 않으면 task graph를 만들지 않는다. 제품 명세와 구현 계획은 파일로 검토할 수 있게 저장되며, 사용자가 제품/구현 spec을 명시적으로 승인해야 Gate B를 통과한다.

### Gate C — Task graph validation

최종 출력 전 task graph를 검증한다. 모든 dependency는 같은 graph 안의 task id를 참조해야 하고, dependency graph는 cycle이 없어야 하며, 모든 task는 acceptance criteria를 가져야 한다. 저장소 기준에서는 task가 source spec reference도 가져야 한다.

### Gate D — Review blockers

Review에서 blocking issue가 나오면 하네스는 계획이 준비됐다고 말하지 않는다. 대신 blocker 목록과 수정해야 할 artifact section을 반환한다. blocker가 해소되어야 승인된 planning output으로 볼 수 있다.

## 3. 산출물 파일과 데이터 계약

하네스 오케스트레이터는 안정적인 kebab-case `project_id`를 사용하고, 한 번의 run에 속한 파일을 모두 `artifacts/<project_id>/` 아래의 gate별 폴더에 둔다. Subagent는 read-only이며 파일을 직접 쓰지 않는다. 파일 기록은 하네스 오케스트레이터만 수행한다. Gate A가 `blocked_on_user`이거나 open/deferred decision이 남아 있으면 열린 질문과 답변 상태를 모아 보는 `open-questions.md`를 최상위에 반드시 둔다.

```text
artifacts/<project_id>/
├── open-questions.md
├── gate-a-intake/
│   ├── intake.json
│   └── intake.md
├── gate-b-spec/
│   ├── product-spec.md
│   ├── implementation-plan.md
│   └── spec.json
├── gate-c-task-graph/
│   └── task-graph.json
└── gate-d-review/
    └── review-report.md
```

| 파일 저장 위치 | 역할 |
| --- | --- |
| `open-questions.md` | 게이트 횡단 질문 인덱스다. Gate A가 막혔거나 open/deferred decision이 있으면 필수이며, 열린 질문, 답변된 결정, 후속 확인 항목을 한곳에서 추적한다. |
| `gate-a-intake/intake.json` | `intake_json` 구조화 산출물이다. 원문 아이디어, known facts, assumptions, clarifying questions, `needs_user_decision`, evidence, intake status를 담는다. |
| `gate-a-intake/intake.md` | 사용자가 읽는 intake 분석 문서다. 이해한 범위, 가정과 위험, decision별 trade-off와 추천, downstream block 정보를 설명한다. |
| `gate-b-spec/product-spec.md` | 사용자 검토용 제품 명세다. 문제, 대상 사용자, 목표, non-goals, 핵심 흐름, 인터페이스, 성공 기준 등을 Markdown으로 정리한다. |
| `gate-b-spec/implementation-plan.md` | 구현 계획 Markdown이다. 아키텍처, 인터페이스, 데이터 흐름, 의존 요소, edge case, 검증 방식을 정리한다. |
| `gate-b-spec/spec.json` | 제품/구현 명세의 구조화 원본이다. `schemas/spec.schema.json` 계약을 따르며 approval 상태와 open decisions를 포함한다. |
| `gate-c-task-graph/task-graph.json` | 승인된 spec에서 생성된 task graph다. task id, dependency, acceptance criteria, target area, suggested agent prompt, source spec reference를 담는다. |
| `gate-d-review/review-report.md` | quality review 결과다. blocking issues, non-blocking risks, 누락된 테스트/완료 기준, oversized tasks, dependency issues, gate issues, 추천 변경 사항을 담는다. |

`artifacts/<project_id>/` 산출물은 git에 커밋해 기획 이력(파일 기반 versioning)으로 보존한다. 따라서 artifact 디렉터리는 ignore하지 않고, 변경된 계획과 task graph를 파일 히스토리로 추적한다.

### 3.1 산출물과 스키마 매핑

| 대화 상태 섹션 | 파일 저장 위치 | 스키마/계약 | Gate 통과 조건 |
| --- | --- | --- | --- |
| `intake_json` | `artifacts/<project_id>/gate-a-intake/intake.json` | `schemas/intake.schema.json` (`schema_version: p2a.intake.v1`) | 모든 high-impact 결정이 `answered`가 되어 `status: ready_for_spec`일 때 다음 단계로 간다. |
| `product_spec_markdown` | `artifacts/<project_id>/gate-b-spec/product-spec.md` | Markdown 산출물. 구조화 원본은 `spec_json.product`다. | 사용자가 제품 spec 내용을 검토하고 명시적으로 승인해야 한다. |
| `implementation_plan_markdown` | `artifacts/<project_id>/gate-b-spec/implementation-plan.md` | Markdown 산출물. 구조화 원본은 `spec_json.implementation`이다. | 사용자가 구현 계획을 검토하고 명시적으로 승인해야 한다. |
| `spec_json` | `artifacts/<project_id>/gate-b-spec/spec.json` | `schemas/spec.schema.json` (`schema_version: p2a.spec.v1`) | `approval: approved`이고 `open_decisions: []`일 때 task graph를 만들 수 있다. |
| `task_graph_json` | `artifacts/<project_id>/gate-c-task-graph/task-graph.json` | `schemas/task-graph.schema.json` (`schema_version: p2a.task_graph.v1`) | dependency id가 모두 존재하고, task id가 중복되지 않으며, graph가 DAG여야 한다. |
| `review_report` | `artifacts/<project_id>/gate-d-review/review-report.md` | Markdown review report | blocking issue가 없어야 planning output이 준비됐다고 볼 수 있다. |

### 3.2 주요 스키마 필드

`schemas/intake.schema.json`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
| --- | --- |
| `schema_version` | intake artifact 버전이다. 값은 반드시 `p2a.intake.v1`이다. |
| `idea` | 사용자가 제공한 원문 아이디어다. |
| `summary` | 하네스가 이해한 제품 아이디어를 한 문단으로 재진술한 내용이다. |
| `known_facts` | 사용자가 직접 말했거나 입력에서 확정된 사실 목록이다. |
| `assumptions` | `A-1` 형식 id, 진술, 위험도(`low`/`medium`/`high`), 확인 필요 여부를 담는다. |
| `clarifying_questions` | `CQ-1` 형식 id, 질문, 중요한 이유, 어떤 downstream 영역을 막는지(`blocks`)를 담는다. |
| `needs_user_decision` | `ND-1` 형식 id, 질문, 최소 2개 option, impact, default, status(`open`/`answered`/`deferred`), optional answer를 담는다. |
| `status` | unresolved decision이 있으면 `blocked_on_user`, 모두 답변되면 `ready_for_spec`이다. |
| `evidence` | `USER-n`, `LOCAL-n`, `WEB-n` source 객체 목록이다. |

`schemas/spec.schema.json`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
| --- | --- |
| `schema_version` | spec artifact 버전이다. 값은 반드시 `p2a.spec.v1`이다. |
| `project_id` | 한 run의 안정적인 프로젝트 id다. artifact 경로의 `<project_id>`와 맞춰 추적한다. |
| `source_intake` | 이 spec이 근거로 삼은 intake 파일 또는 artifact 참조다. persisted artifact를 가리킬 때는 `artifacts/<project_id>/gate-a-intake/intake.json` 형식을 사용한다. |
| `product` | 문제, 대상 사용자, 목표, non-goals, core flows, interfaces, data model draft, external integrations, success criteria, constraints를 담는다. |
| `implementation` | architecture, interfaces, data flow, dependencies, edge cases, verification을 담는다. |
| `open_decisions` | spec 단계에서 아직 닫히지 않은 `ND-n` decision id 목록이다. intake의 unresolved decision과 정확히 일치해야 한다. |
| `approval` | `draft` 또는 `approved`다. 명시적 사용자 승인 전에는 `draft`를 유지한다. |
| `evidence` | intake evidence를 보존하고 spec에서 새로 사용한 local/web 근거를 추가한다. |

`schemas/task-graph.schema.json`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
| --- | --- |
| `schema_version` | task graph artifact 버전이다. 값은 반드시 `p2a.task_graph.v1`이다. |
| `projectId` | task graph의 프로젝트 id다. spec의 `project_id`와 같은 의미로 사용한다. |
| `version` | task graph 자체의 버전 문자열이다. |
| `sourceSpec` | task graph가 나온 승인 spec 파일 또는 artifact 참조다. persisted artifact를 가리킬 때는 `artifacts/<project_id>/gate-b-spec/spec.json` 형식을 사용한다. |
| `tasks` | 최소 1개 이상의 task 배열이다. 각 task는 `id`, `title`, `description`, `status`, `dependencies`, `acceptanceCriteria`, `targetArea`, `suggestedAgentPrompt`, `sourceSpecRefs`를 가진다. |
| `tasks[].status` | `todo`, `blocked`, `in_progress`, `done` 중 하나다. |
| `tasks[].dependencies` | 먼저 완료되어야 하는 `task-n` id 목록이다. 모두 같은 graph 안에 존재해야 한다. |
| `tasks[].acceptanceCriteria` | task 완료 판단 기준이다. 최소 1개 이상이어야 한다. |
| `tasks[].sourceSpecRefs` | task가 어떤 spec section에서 나왔는지 추적하는 참조 목록이다. 최소 1개 이상이어야 한다. |

### 3.3 evidence와 인용 규칙

Intake와 spec artifact는 `evidence` 배열을 가진다. 이 배열은 결정과 가정의 근거를 기계가 읽을 수 있게 보존하는 계약이다.

| source id | 사용처 | 필수 내용 |
| --- | --- | --- |
| `USER-n` | 사용자 입력, 사용자 답변, 대화에서 확정한 제약 | `source_id`, `title`, `url`, `used_for`. URL이 없으면 빈 문자열을 사용할 수 있다. |
| `LOCAL-n` | 저장소 파일, 기존 artifact, 로컬 문서 | `source_id`, `title`, `url`, `used_for`. 로컬 파일 경로를 설명에 넣고, URL은 빈 문자열일 수 있다. |
| `WEB-n` | read-only web lookup으로 확인한 prior art나 domain 근거 | `source_id`, `title`, `url`, `used_for`. URL은 반드시 `http://` 또는 `https://`로 시작해야 한다. |

운영 규칙은 다음과 같다.

- `WEB-n` evidence item은 http(s) URL, title, used_for를 모두 가져야 한다.
- 웹 근거가 질문, 가정, 제품 결정, 통합 선택을 실제로 바꾸거나 강화했다면 반드시 `evidence`에 넣고, 그 근처 rationale text에서 `WEB-1`처럼 source id를 인용한다.
- read-only web lookup은 prior art 또는 domain grounding 용도다. 구현 실행, dependency 설치, 코드 변경을 위해 사용하지 않는다.
- `scripts/validate_artifacts.mjs`는 evidence `source_id` 중복과 `WEB-n` URL 형식을 검사한다. 다만 title/used_for의 내용 품질은 사람이 review해야 하므로, Gate D에서 근거가 실제 결정 근처에 인용됐는지 확인한다.

## 4. 재개(resume)

사용자가 `ND-1`, `ND-4` 같은 decision id에 답하면 하네스는 해당 `needs_user_decision[*].answer`를 채우고 `status`를 `answered`로 바꾼 뒤 `intake_json.status`를 다시 계산한다.

재개는 입력이 바뀐 가장 이른 단계부터 다시 생성한다.

- Intake 답변이 바뀌면 spec, implementation plan, task graph, review가 모두 무효화되므로 downstream 산출물을 다시 만든다.
- Product spec이 바뀌면 implementation plan, task graph, review를 다시 만든다.
- Implementation plan이 바뀌면 task graph와 review를 다시 만든다.
- Task graph가 바뀌면 review를 다시 수행한다.

재개 중에도 `project_id`, `source_intake`, `sourceSpec`처럼 출처 추적에 필요한 안정적인 artifact id는 이어서 사용한다. 저장된 artifact를 참조할 때 `source_intake`는 `artifacts/<project_id>/gate-a-intake/intake.json`, `sourceSpec`은 `artifacts/<project_id>/gate-b-spec/spec.json` 형식을 유지한다. Markdown artifact만 붙여 넣어진 경우에는 다음 게이트로 넘어가기 전에 대응하는 JSON 계약을 먼저 재구성해야 한다.

## 5. CLI별 실행 방법

세 CLI 모두 같은 Plan2Agent 역할 이름과 산출물 계약을 사용하지만, 실행 문법은 다르다. 저장소 루트에서 CLI를 시작하고, 새 skill/subagent/command가 인식되지 않으면 CLI를 재시작하거나 reload한다.

| 항목 | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Skill 경로 | `.claude/skills` | `.agents/skills` | `.agents/skills` plus command shims |
| Subagent 경로 | `.claude/agents` | `.codex/agents` | `.gemini/agents` |
| Skill 실행 | `/skill-name` 또는 자동 | `$skill-name` 언급 또는 자동 | command shim |
| 명시 subagent 호출 | agent 이름 지정 | spawn 요청 필요 | `@agent-name` 가능 |
| v1 정책 | read-only planning | read-only planning | read-only planning |

### Claude Code

전체 하네스는 Claude Code에서 다음처럼 실행한다.

```text
/p2a-harness Redis처럼 TTL과 LRU eviction을 지원하는 embeddable in-memory cache library를 만들고 싶다.
```

단계별로 실행할 때는 `/p2a-intake`, `/p2a-spec`, `/p2a-task-breakdown`, `/p2a-review`를 사용할 수 있다.

### Codex

Codex에서는 skill을 명시적으로 언급하거나 자동 skill 인식을 사용할 수 있다.

```text
Use the $p2a-harness skill on this idea:
Redis처럼 TTL과 LRU eviction을 지원하는 embeddable in-memory cache library를 만들고 싶다.
```

Codex subagent까지 명시하려면 read-only planning 목적임을 밝히고 필요한 subagent spawn을 요청한다. Codex는 subagent를 자동으로 spawn하지 않으므로 병렬 또는 역할 분리 작업이 필요하면 prompt에서 명시해야 한다.

### Gemini CLI

Gemini CLI에서는 `.gemini/commands/p2a/harness.toml` shim이 `/p2a:harness` 명령으로 노출된다.

```text
/p2a:harness Redis처럼 TTL과 LRU eviction을 지원하는 embeddable in-memory cache library를 만들고 싶다.
```

단계별 shim은 `/p2a:intake`, `/p2a:spec`, `/p2a:task-breakdown`, `/p2a:review`다. 현재 Gemini CLI의 custom slash command 문서 기준으로 command 파일을 수정한 직후에는 `/commands reload`로 다시 불러오고 `/commands list`로 노출 여부를 확인할 수 있다.

## 6. 예시: cache-library 워크스루

`fixtures/cache-library/`는 하네스 흐름을 따라가는 golden 산출물 예시다. 시작 아이디어는 “Redis처럼 TTL과 LRU eviction을 지원하는 embeddable in-memory cache library”다.

1. `fixtures/cache-library/input.md`의 아이디어를 하네스에 입력한다.
2. Intake 단계는 이 제품이 최종 사용자 앱이 아니라 라이브러리이며 TTL, LRU eviction, Redis-like 동작을 원한다는 known facts를 만든다.
3. Gate A에서 세 가지 결정을 묻는다.
   - `ND-1`: v1 target runtime은 TypeScript/Node.js인지 Python인지.
   - `ND-2`: single-process embeddable cache인지 network server인지.
   - `ND-3`: deterministic correctness를 우선할지 maximum throughput을 우선할지.
4. 사용자가 fixture의 resume 답변처럼 TypeScript/Node.js, single-process in-memory, deterministic tests/simple API를 선택하면 `intake.answered.json`은 `status: ready_for_spec`가 된다.
5. 승인된 spec fixture는 TypeScript package, injectable clock, Map과 doubly linked list 기반 구조, lazy TTL cleanup, deterministic unit tests를 포함한다.
6. `task-graph.json`은 package scaffold, cache core data structures, public cache API, deterministic TTL/LRU tests처럼 dependency가 있는 작은 task로 나뉜다.
7. `review-report.md`는 승인 상태, dependency, acceptance criteria, source spec reference를 확인하고 blocking issue가 없을 때 계획을 준비된 상태로 본다.

이 예시는 실제 구현을 수행하지 않는다. 사용자는 fixture를 참고해 자신의 아이디어에서도 Gate A~D를 통과할 때마다 산출물을 검토하고, 필요한 결정을 답변한 뒤 downstream 파일을 재생성하면 된다.

### 6.1 실제 산출물 발췌

아래 발췌는 모두 `fixtures/cache-library/`의 실제 파일에서 가져온 짧은 예시다.

`fixtures/cache-library/intake.blocked.json`의 `needs_user_decision` 한 개:

```json
{
  "id": "ND-1",
  "question": "Which runtime should v1 target?",
  "options": [
    {
      "id": "node-ts",
      "label": "TypeScript/Node.js",
      "description": "Ship as an npm package with TypeScript types."
    },
    {
      "id": "python",
      "label": "Python",
      "description": "Ship as a PyPI package with Pythonic cache APIs."
    }
  ],
  "impact": "Determines package format, timer behavior, public API shape, and test tooling.",
  "default": "node-ts",
  "status": "open"
}
```

`fixtures/cache-library/spec.approved.json`의 핵심 필드 발췌:

```json
{
  "schema_version": "p2a.spec.v1",
  "project_id": "cache-library",
  "source_intake": "fixtures/cache-library/intake.answered.json",
  "approval": "approved",
  "open_decisions": [],
  "product": {
    "problem": "Developers need a small embeddable cache library that provides predictable TTL expiration and LRU eviction without running a Redis server.",
    "goals": [
      "Expose a small TypeScript API for get, set, delete, has, clear, and stats operations",
      "Support per-entry TTL expiration"
    ]
  },
  "implementation": {
    "architecture": [
      "Use a Map for O(1) key lookup and a doubly linked list for recency ordering",
      "Use lazy TTL cleanup on get, has, set, and capacity enforcement"
    ],
    "verification": [
      "Unit tests for set/get/delete/has/clear",
      "Unit tests for TTL with injected clock"
    ]
  }
}
```

`fixtures/cache-library/task-graph.json`의 task 한 개:

```json
{
  "id": "task-001",
  "title": "Scaffold TypeScript package",
  "description": "Create package metadata, TypeScript configuration, source entry point, and test command for the cache library.",
  "status": "todo",
  "dependencies": [],
  "acceptanceCriteria": [
    "Package exposes a TypeScript source entry point",
    "Type checking and tests can be run with documented commands"
  ],
  "targetArea": "package-scaffold",
  "suggestedAgentPrompt": "Scaffold the TypeScript package for the approved cache-library spec. Do not implement cache behavior yet.",
  "sourceSpecRefs": ["implementation.dependencies", "product.constraints"]
}
```

## 7. Gate D 이후 개발 진행

Gate D review가 blocking issue 없이 끝나면 `artifacts/<project_id>/gate-c-task-graph/task-graph.json`을 개발 진행의 단일 상태 파일로 사용한다. 하네스 자체는 여전히 기획 산출물 생성까지 담당하고, 구현은 별도 agent CLI 세션에서 task 단위로 수행한다.

사용자 관점의 루프는 다음과 같다.

1. `node scripts/p2a_tasks.mjs ready --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json`로 지금 시작할 수 있는 task를 확인한다.
2. 실행할 task를 정한 뒤 `node scripts/p2a_tasks.mjs start --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json <task-id>`로 상태를 `in_progress`로 바꾼다. dependency가 완료되지 않은 task는 시작할 수 없다.
3. `node scripts/p2a_tasks.mjs prompt --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json <task-id>`로 agent CLI에 붙여넣을 prompt를 만든다. 출력에는 task의 `suggestedAgentPrompt`와 acceptance criteria가 포함된다.
4. Claude Code, Codex, Gemini CLI 등 구현용 agent 세션에서 prompt를 실행하고, 코드 변경과 검증은 해당 작업 브랜치에서 수행한다.
5. acceptance criteria와 필요한 테스트가 통과하면 `node scripts/p2a_tasks.mjs done --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json <task-id>`로 완료 처리한다. 막히면 `block`, 재시도해야 하면 `todo`로 상태를 기록한다.
6. 다시 `ready`를 확인해 다음 dependency-unblocked task를 선택한다.

상태 변경 명령은 파일을 쓰기 전에 task graph를 재검증하므로 duplicate id, 알 수 없는 dependency, cycle, 빈 acceptance criteria 같은 Gate C 위반이 있으면 변경을 저장하지 않는다.

## 8. 검증 방법

검증 스크립트는 JSON schema subset 검사와 procedural gate 검사를 함께 수행한다. 모든 명령은 저장소 루트에서 실행한다.

### 8.1 단일 artifact 검증

Intake만 검증:

```bash
node scripts/validate_artifacts.mjs --intake artifacts/<project_id>/gate-a-intake/intake.json
```

Spec과 intake traceability를 함께 검증:

```bash
node scripts/validate_artifacts.mjs --intake artifacts/<project_id>/gate-a-intake/intake.json --spec artifacts/<project_id>/gate-b-spec/spec.json
```

Task graph가 승인 spec에서 생성될 수 있는지까지 검증:

```bash
node scripts/validate_artifacts.mjs --task-graph artifacts/<project_id>/gate-c-task-graph/task-graph.json --require-approved-spec artifacts/<project_id>/gate-b-spec/spec.json
```

세 JSON artifact를 한 번에 검증:

```bash
node scripts/validate_artifacts.mjs --intake artifacts/<project_id>/gate-a-intake/intake.json --spec artifacts/<project_id>/gate-b-spec/spec.json --task-graph artifacts/<project_id>/gate-c-task-graph/task-graph.json --require-approved-spec artifacts/<project_id>/gate-b-spec/spec.json
```

주의: `--task-graph`만 주고 `--require-approved-spec`를 생략하면 task graph 자체의 schema/dependency/cycle만 검증한다. Gate B 조건까지 확인하려면 `--require-approved-spec`를 함께 사용한다.

### 8.2 fixture와 CLI parity 검증

`fixtures/cache-library/` 한 세트를 검증:

```bash
node scripts/validate_artifacts.mjs --fixture-dir fixtures/cache-library
```

모든 fixture 디렉터리를 검증:

```bash
node scripts/run_fixtures.mjs
```

CLI mirror와 command shim drift를 검증:

```bash
node scripts/check_cli_parity.mjs
```

`check_cli_parity`는 내부적으로 `node scripts/sync_cli_assets.mjs --check`를 실행하고, skill mirror byte 비교, agent mirror 파일 존재 여부, Gemini command shim의 description/prompt/skill name/`{{args}}` 포함 여부를 확인한다. mirror를 실제로 재생성해야 할 때는 다음 명령을 사용한다.

```bash
node scripts/sync_cli_assets.mjs
```

### 8.3 `validate_artifacts`가 실제로 잡는 것

| 검사 | 기준 | 대표 실패 메시지 |
| --- | --- | --- |
| Schema required/additional/type/enum/const | `schemas/*.schema.json`의 필수 키, 타입, enum, const, pattern, minLength/minItems subset을 검사한다. | `$ missing required keys: ...`, `$ contains unsupported keys: ...`, `$.schema_version must equal ...` |
| Evidence 중복/WEB URL | `evidence[].source_id`는 중복될 수 없고, `WEB-n` URL은 `http://` 또는 `https://`로 시작해야 한다. | `intake.evidence source_id values must be unique`, `spec.evidence WEB-1 must include an http(s) url` |
| 미해결 결정 차단 | `needs_user_decision.status`가 `open` 또는 `deferred`이면 intake status는 `blocked_on_user`여야 한다. 모두 닫히면 `ready_for_spec`이어야 한다. | `intake.status must be ... when unresolved decisions are ...` |
| decision answer/status 일관성 | `answered` decision은 `answer`가 있어야 하고, `open`/`deferred` decision은 `answer`를 가지면 안 된다. | `ND-1 is answered but has no answer`, `ND-1 is unresolved but has an answer` |
| spec/intake `open_decisions` 일치 | `--spec`과 `--intake`를 함께 주면 spec의 `open_decisions`가 intake의 unresolved `ND-n` 목록과 정확히 같아야 한다. | `spec.open_decisions must exactly match unresolved intake decisions: expected ..., got ...` |
| 알 수 없는 decision id | spec의 `open_decisions`가 intake에 없는 `ND-n`을 참조하면 실패한다. | `spec.open_decisions references unknown intake decisions: ...` |
| approved spec 요구 | task graph 검증에 `--require-approved-spec`를 주면 spec이 `approval: approved`이고 `open_decisions: []`여야 한다. | `task graph generation is blocked until spec.approval is approved`, `task graph generation is blocked while spec.open_decisions is non-empty` |
| duplicate task id | task id는 graph 안에서 유일해야 한다. | `task ids must be unique` |
| dependency id 누락 | 모든 `dependencies[]` 값은 같은 graph의 task id여야 한다. | `task-002 has unknown dependencies: ...` |
| cycle 탐지 | dependency graph는 순환이 없어야 한다. | `task graph contains a dependency cycle: ...` |
| acceptance/source ref 최소 개수 | schema가 `acceptanceCriteria`와 `sourceSpecRefs`의 `minItems: 1`을 검사한다. | `$.tasks[0].acceptanceCriteria must contain at least 1 item(s)` |

## 9. 트러블슈팅/FAQ

| 증상/메시지 | 원인 | 해결 |
| --- | --- | --- |
| Gate A가 넘어가지 않는다. | `needs_user_decision`에 `open` 또는 `deferred` 항목이 남아 있다. | 사용자에게 해당 `ND-n` 질문을 근거/추천과 함께 다시 제시하고, 답변을 `answer`에 기록한 뒤 status를 `answered`로 바꾼다. |
| `intake.status must be ...` | decision status와 top-level `status`가 맞지 않는다. | `open`/`deferred`가 하나라도 있으면 `blocked_on_user`, 모두 `answered`면 `ready_for_spec`로 맞춘다. |
| `ND-1 is answered but has no answer` | decision을 `answered`로 표시했지만 실제 답변 문자열이 없다. | 사용자의 선택 또는 명시적 override를 `answer`에 적는다. |
| `ND-1 is unresolved but has an answer` | `open`/`deferred` 상태인데 `answer`가 들어 있다. | 답변을 인정하려면 status를 `answered`로 바꾸고, 아직 미결이면 `answer`를 제거한다. |
| `spec.open_decisions must exactly match unresolved intake decisions` | spec의 open decision 목록과 intake의 미해결 decision 목록이 다르다. | intake에서 unresolved인 `ND-n`만 spec `open_decisions`에 넣는다. 모든 decision이 답변됐으면 `open_decisions: []`로 둔다. |
| `approved specs must not contain open_decisions` | `approval: approved`인데 spec에 미해결 decision이 남았다. | spec을 `draft`로 되돌리거나, 모든 decision을 해결한 뒤 `open_decisions: []`로 만든다. |
| `task graph generation is blocked until spec.approval is approved` | 승인되지 않은 spec으로 task graph를 검증/생성하려 했다. | 사용자에게 product spec과 implementation plan을 파일로 검토받고 명시적 승인을 받은 뒤 `approval: approved`로 바꾼다. |
| `task graph generation is blocked while spec.open_decisions is non-empty` | spec에 미해결 결정이 남아 있다. | Gate B로 돌아가 open decision을 해결한다. |
| `task ids must be unique` | 같은 `task-001` 같은 id가 두 번 이상 있다. | task id를 안정적으로 다시 부여하고 dependency 참조도 함께 수정한다. |
| `has unknown dependencies` | task가 존재하지 않는 dependency id를 참조한다. | dependency 오타를 고치거나 누락된 선행 task를 추가한다. |
| `task graph contains a dependency cycle` | task dependency가 서로 물고 있어 시작 가능한 순서가 없다. | cycle에 포함된 task의 선후관계를 다시 설계한다. |
| `$ contains unsupported keys` 또는 `$ missing required keys` | JSON artifact가 schema와 맞지 않는다. | `schemas/intake.schema.json`, `schemas/spec.schema.json`, `schemas/task-graph.schema.json`의 required/additionalProperties 규칙에 맞춘다. |
| `WEB-1 must include an http(s) url` | web evidence의 URL이 비어 있거나 http(s)가 아니다. | 실제 참조한 웹 문서의 `http://` 또는 `https://` URL을 넣는다. |
| CLI가 skill 또는 subagent를 못 알아본다. | CLI가 mirror 파일을 아직 로드하지 않았거나 mirror drift가 있다. | 저장소 루트에서 CLI를 재시작한다. Gemini CLI command는 `/commands reload` 후 `/commands list`를 확인한다. 필요하면 `node scripts/sync_cli_assets.mjs`와 `node scripts/check_cli_parity.mjs`를 실행한다. |
| `parity failed: skill mirror drift ...` | `.agents/skills` 원본과 `.claude/skills` mirror가 다르다. | canonical `.agents` 쪽 변경을 기준으로 `node scripts/sync_cli_assets.mjs`를 실행하고 parity를 재검사한다. |
| `fixture validation failed: no fixture directories found` | `fixtures/` 아래에 fixture 디렉터리가 없다. | 최소 `fixtures/cache-library/` 같은 fixture set이 있는지 확인한다. |

## 10. 용어집

| 용어 | 정의 |
| --- | --- |
| gate | 다음 단계로 넘어가기 전 사용자 승인과 검증을 요구하는 중단점이다. |
| skill | 반복 가능한 workflow 지침 묶음이다. Plan2Agent에서는 `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review`가 핵심 skill이다. |
| subagent | 역할별 context를 분리해 읽기 전용 planning을 수행하는 전문 agent다. |
| artifact | 하네스가 생성/검토하는 `.json` 또는 `.md` 산출물이다. |
| `project_id` | 한 하네스 run의 안정적인 kebab-case 식별자다. artifact 디렉터리 이름과 spec 추적에 사용한다. |
| `needs_user_decision` | 제품 범위, 데이터 형태, UI 흐름, 구현 리스크를 바꿀 수 있어 사용자의 명시 답변이 필요한 결정 목록이다. |
| `open_decisions` | spec 단계에서 아직 해결되지 않은 `ND-n` decision id 목록이다. intake의 unresolved decision과 일치해야 한다. |
| resume | 이전 산출물과 새 답변을 합쳐, 입력이 바뀐 가장 이른 단계부터 downstream artifact를 다시 만드는 절차다. |
| mirror | Claude/Codex/Gemini CLI가 읽을 수 있도록 canonical 원본에서 생성된 target별 파일이다. |
| canonical `.agents` | Plan2Agent skill과 agent의 원본 위치다. `.agents/skills`와 `.agents/agents`를 기준으로 mirror를 생성한다. |
| `source_intake` | spec이 어떤 intake artifact에서 생성됐는지 나타내는 추적 필드다. 저장된 artifact 참조는 `artifacts/<project_id>/gate-a-intake/intake.json` 형식을 사용한다. |
| `sourceSpec` | task graph가 어떤 승인 spec에서 생성됐는지 나타내는 추적 필드다. 저장된 artifact 참조는 `artifacts/<project_id>/gate-b-spec/spec.json` 형식을 사용한다. |
| `evidence` | 사용자/로컬/웹 근거를 `USER-n`, `LOCAL-n`, `WEB-n` id로 보존하는 배열이다. |

## 11. 추가 포인터와 v1/v2 범위

- 제품 방향과 로드맵은 `plans/01-product-roadmap.md`를 먼저 본다. v1은 “아이디어 입력 -> 대화 보강 -> 개발 명세 -> task graph 생성/관리”까지 담당하고, 실제 agent 자동 실행보다 실행 가능한 task를 만드는 데 집중한다.
- 하네스 구현 기준은 `plans/02-harness-spec.md`를 본다. 이 문서는 단계, 역할, 승인 게이트, resume, state passing, evidence, 저장 구조, 검증 스크립트 기준을 정의한다.
- 최신 사용 정책과 CLI별 quick start는 `readme.md`를 본다.
- v1 한계: 코드 변경, dependency 설치, 구현 목적 shell 실행, agent 자동 실행, PTY/worktree/run log 관리는 하네스 범위가 아니다.
- v2 로드맵 한 줄 요약: v1 산출물을 실제 개발 프로젝트로 옮기고, agent 실행 로그, worktree 분리, 결과 diff 연결 같은 실행 orchestration을 붙이는 방향이다.

무엇을 보강했는지:

- 문서 상단에 TOC와 파이프라인 다이어그램을 추가했다.
- Node.js ESM 전제조건, 저장소 루트 실행, 클론 후 첫 검증 명령을 구체화했다.
- intake/spec/task graph 스키마 주요 필드와 산출물-스키마 매핑을 표로 정리했다.
- `USER-n`/`LOCAL-n`/`WEB-n` evidence 규칙과 WEB URL/인용 원칙을 별도 섹션으로 분리했다.
- `validate_artifacts`, `run_fixtures`, `check_cli_parity`, `sync_cli_assets` 사용법과 실제 gate 검사 항목을 스크립트 기준으로 설명했다.
- `fixtures/cache-library/`의 실제 JSON 발췌를 추가했다.
- validation 실패 메시지별 원인/해결과 CLI reload/parity 관련 FAQ를 추가했다.
- gate, skill, subagent, artifact, resume, mirror/canonical 등 핵심 용어집을 추가했다.
- `plans/01-product-roadmap.md`, `plans/02-harness-spec.md`, `readme.md` 포인터와 v1/v2 범위를 명확히 했다.
