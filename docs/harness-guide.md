# Plan2Agent 하네스 사용자 가이드

이 문서는 Plan2Agent(P2A)의 Gate A-D 산출물, schema, evidence, approval audit을 자세히 설명하는 사용자 레퍼런스다. 처음 시작하는 흐름은 [Quickstart](quickstart.md)를 먼저 보고, 명령 예시는 [CLI 사용자 가이드](cli-reference.md)를 본다.

문서 홈: [Plan2Agent Docs](README.md)

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
| 1. Intake | `p2a-intake` | 아이디어를 사실, 가정, 질문, 사용자 결정 항목으로 구조화한다. | `intake_json` |
| 2. Product spec | `p2a-spec` | 답변된 intake를 제품 목표, 범위, 사용자 흐름, 성공 기준으로 정리한다. | `spec_json.product` |
| 3. Implementation plan | `p2a-spec` | 승인 가능한 제품 명세를 아키텍처, 인터페이스, 데이터 흐름, 검증 계획으로 바꾼다. | `spec_json.implementation` |
| 4. Task graph | `p2a-task-breakdown` | 승인된 구현 명세를 의존성 있는 작은 task로 분해한다. | `task_graph_json` |
| 5. Review | `p2a-review` | 명세와 task graph의 누락, gate 위반, 의존성 오류, 실행 리스크를 검토한다. | `review_json` |

하네스는 대화 안에서도 `intake_json`, `spec_json`, `task_graph_json`, `review_json`이라는 이름의 상태 섹션을 반환한다. 동시에 각 단계의 정본 JSON 산출물을 `.plan2agent/artifacts/<project_id>/` 아래 gate별 폴더에 저장한다. Markdown은 필요할 때 JSON에서 생성하는 사람용 view/export다.

### 1.1 전제조건과 첫 검증

- **명령 실행 위치를 구분한다.** Plan2Agent 본체 검증/개발 스크립트는 `/workspace/plan2agent` 같은 Plan2Agent 저장소 루트에서 실행한다. scaffold로 하네스를 설치한 실제 프로젝트의 런타임 명령은 `.plan2agent/`가 생성된 프로젝트 루트에서 실행한다.
- **Node.js가 필요하다.** 검증/동기화/fixture/task 관리 스크립트는 `#!/usr/bin/env node`로 실행되는 ESM(`.mjs`) 스크립트다. 별도 npm dependency를 설치하지 않고 Node.js 표준 라이브러리만 사용한다.
- **v1 하네스는 read-only planning이다.** 하네스와 subagent는 제품 기획 산출물(`.md`, `.json`)을 만드는 데 집중한다. 코드 변경, dependency 설치, 구현 목적 shell 실행, git 조작은 v1 workflow에 포함하지 않는다. 단, 이 저장소의 검증 스크립트를 실행해 산출물 계약을 확인하는 것은 문서화된 검증 절차다.
- **클론 직후 첫 검증은 fixture와 CLI parity를 확인한다.** 아래 두 명령이 통과하면 스키마/게이트 검증과 CLI mirror 상태가 기본적으로 맞아 있다.

```bash
node scripts/run_fixtures.mjs
node scripts/check_cli_parity.mjs
```

주의: `check_cli_parity.mjs`, `run_fixtures.mjs`, `sync_cli_assets.mjs`는 Plan2Agent 본체 개발자용 스크립트이며 scaffold 대상 프로젝트에는 설치되지 않는다. scaffold 대상 프로젝트에서는 `.plan2agent/scripts/validate_artifacts.mjs`, `.plan2agent/scripts/p2a_iteration.mjs`, `.plan2agent/scripts/p2a_execute.mjs` 같은 런타임 명령만 사용한다.

개별 fixture만 빠르게 확인하려면 Plan2Agent 본체 저장소 루트에서 다음 명령을 사용한다.

```bash
node scripts/validate_artifacts.mjs --fixture-dir fixtures/cache-library
```

## 2. 승인 게이트

각 게이트는 단순 체크리스트가 아니라 사용자 검토 지점이다. 하네스는 해당 단계의 파일을 먼저 저장하고, 근거와 추천을 포함한 읽기 쉬운 요약을 제시한 뒤, 자유 형식 피드백과 구조화된 답변 또는 승인을 명시적으로 요청한다. 사용자가 응답하면 산출물을 수정해 다시 제시하고, 명시적 승인 없이는 다음 단계로 넘어가지 않는다.

### Gate A — Intake decisions

Intake 결과의 `needs_user_decision.status` 중 하나라도 `open` 또는 `deferred`이면 하네스는 intake 후 멈춘다. 이때 제품 명세를 확정하지 않고, 열린 결정 항목만 사용자에게 묻는다. 각 결정은 질문, 중요한 이유, 선택지별 trade-off, 추천 선택지와 근거, 막고 있는 downstream 산출물을 함께 보여줘야 한다.

### Gate B — Spec approval

`spec_json.approval`이 `approved`가 아니거나, `spec_json.approval_audit`가 없거나, `spec_json.open_decisions`가 비어 있지 않으면 task graph를 만들지 않는다. 또한 intake의 모든 `CQ-n`은 `spec_json.clarifying_question_disposition`에서 한 번씩 처분되어야 한다. Gate B에서 라이브러리, 프레임워크, 런타임, 프로토콜, DB, 클라우드 서비스, 외부 API를 선택하거나 추천한다면 최신 공식 문서와 패키지/릴리스 정보를 중심으로 가벼운 기술 조사를 수행하고, 근거를 `spec_json.evidence`에 남겨야 한다. 사용자가 제품/구현 spec을 명시적으로 승인하면 승인 감사 정보는 `spec_json.approval_audit`에 기록한다.

### Gate C — Task graph validation

최종 출력 전 task graph를 검증한다. 모든 dependency는 같은 graph 안의 task id를 참조해야 하고, dependency graph는 cycle이 없어야 하며, 모든 task는 acceptance criteria를 가져야 한다. 저장소 기준에서는 task가 source spec reference도 가져야 한다.

### Gate D — Review blockers

Gate D의 정본 산출물은 `review_json`이며 파일로는 `gate-d-review/review.json`에 저장된다. `review-report.md`는 동일 findings를 사람이 읽기 쉽게 렌더링한 선택적 Markdown 보고서다. Validator, iteration, handoff는 `review.json.blocking_issues`가 빈 배열인지 확인해 Gate D 통과 여부를 판단한다. Review에서 blocking issue가 나오면 하네스는 계획이 준비됐다고 말하지 않는다. 대신 blocker 목록과 수정해야 할 artifact section을 반환한다.

## 3. 산출물 파일과 데이터 계약

하네스 오케스트레이터는 안정적인 kebab-case `project_id`를 사용하고, 한 번의 run에 속한 정본 JSON 파일을 모두 `.plan2agent/artifacts/<project_id>/` 아래의 gate별 폴더에 둔다. Subagent는 read-only이며 파일을 직접 쓰지 않는다. 파일 기록은 하네스 오케스트레이터만 수행한다. `status.md` 같은 Markdown 파일은 필요할 때 JSON에서 생성하는 view다.

```text
.plan2agent/artifacts/<project_id>/
├── status.md                         # optional generated view
├── gate-a-intake/
│   ├── intake.json                    # canonical
│   └── intake.md                      # optional generated view
├── gate-b-spec/
│   ├── spec.json                      # canonical
│   ├── product-spec.md                # optional generated view
│   └── implementation-plan.md         # optional generated view
├── gate-c-task-graph/
│   └── task-graph.json                # canonical
└── gate-d-review/
    ├── review.json                    # canonical
    └── review-report.md               # optional generated view
```

| 파일 저장 위치 | 역할 |
| --- | --- |
| `status.md` | JSON에서 생성되는 standing 진행상태 view다. progress line, 게이트별 정본 파일 링크, 열린 결정, 단일 다음 액션, 변경 이력을 보여주지만 제어 흐름의 정본은 아니다. |
| `gate-a-intake/intake.json` | `intake_json` 구조화 산출물이다. 원문 아이디어, known facts, assumptions, clarifying questions, `needs_user_decision`, evidence, intake status를 담는다. |
| `gate-a-intake/intake.md` | 선택적 generated view다. 사람이 읽는 intake 분석을 보여주지만 정본은 `intake.json`이다. |
| `gate-b-spec/product-spec.md` | 선택적 generated view다. 제품 명세를 Markdown으로 보여주지만 정본은 `spec.json.product`다. |
| `gate-b-spec/implementation-plan.md` | 선택적 generated view다. 구현 계획을 Markdown으로 보여주지만 정본은 `spec.json.implementation`이다. |
| `gate-b-spec/spec.json` | 제품/구현 명세의 구조화 원본이다. `.plan2agent/schemas/spec.schema.json` 계약을 따르며 approval 상태, approval audit, open decisions, clarifying question disposition을 포함한다. |
| `gate-c-task-graph/task-graph.json` | 승인된 spec에서 생성된 task graph다. task id, dependency, acceptance criteria, target area, suggested agent prompt, source spec reference를 담는다. |
| `gate-d-review/review.json` | Gate D의 machine-readable canonical review result다. Validator, iteration 전환, handoff 준비 여부는 이 파일의 `blocking_issues`가 빈 배열인지로 판단한다. |
| `gate-d-review/review-report.md` | 선택적 generated view다. `review.json`의 동일 findings를 사람이 읽기 쉽게 렌더링한다. |

`.plan2agent/` 아래 산출물은 application source git에 커밋하지 않는 로컬 하네스 상태다. 기획 이력, task/run 진행, 검증 결과의 장기 보존은 Plan2Agent Memory 같은 artifact store에 동기화하는 방향을 기준으로 한다. 로컬 파일은 게이트 검증, 재개, UI 표시를 위한 working cache이며, git commit은 제품 소스코드 변경 이력에 집중한다.

### 3.1 산출물과 스키마 매핑

| 대화 상태 섹션 | 파일 저장 위치 | 스키마/계약 | Gate 통과 조건 |
| --- | --- | --- | --- |
| `intake_json` | `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json` | `.plan2agent/schemas/intake.schema.json` (`schema_version: p2a.intake.v1`) | 모든 high-impact 결정이 `answered`가 되어 `status: ready_for_spec`일 때 다음 단계로 간다. |
| optional Markdown views | `.plan2agent/artifacts/<project_id>/**.md` | JSON에서 생성되는 view/export다. | Gate 판정의 정본으로 쓰지 않는다. |
| `spec_json` | `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` | `.plan2agent/schemas/spec.schema.json` (`schema_version: p2a.spec.v1`) | 모든 `CQ-n`이 처분되고, `approval: approved`, `approval_audit` present, `open_decisions: []`일 때 task graph를 만들 수 있다. |
| `task_graph_json` | `.plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json` | `.plan2agent/schemas/task-graph.schema.json` (`schema_version: p2a.task_graph.v1`) | dependency id가 모두 존재하고, task id가 중복되지 않으며, graph가 DAG여야 한다. |
| `review_json` | `.plan2agent/artifacts/<project_id>/gate-d-review/review.json` | `.plan2agent/schemas/review.schema.json` (`schema_version: p2a.review.v1`) | `blocking_issues: []`일 때만 Gate D가 통과한다. |
| optional `review_report` | `.plan2agent/artifacts/<project_id>/gate-d-review/review-report.md` | Markdown rendering of `review_json` | 사람이 읽는 리뷰 보고서이며 Gate D 판정의 정본은 아니다. |

승인된 Gate B가 있으면 `spec_json.approval_audit`에 아래 구조를 포함한다.

```json
{
  "approved_by": "user",
  "approved_at": "YYYY-MM-DD",
  "approved_artifacts": ["gate-b-spec/spec.json"],
  "approval_note": "<short note describing the decision/resolution basis for approval>"
}
```

`validate_artifacts.mjs --artifact-root`와 fixture 검증은 승인된 spec이 있을 때 이 JSON audit의 존재와 네 필드를 확인한다.

### 3.2 주요 스키마 필드

`.plan2agent/schemas/intake.schema.json`의 핵심 필드는 다음과 같다.

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

`.plan2agent/schemas/spec.schema.json`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
| --- | --- |
| `schema_version` | spec artifact 버전이다. 값은 반드시 `p2a.spec.v1`이다. |
| `project_id` | 한 run의 안정적인 프로젝트 id다. artifact 경로의 `<project_id>`와 맞춰 추적한다. |
| `source_intake` | 이 spec이 근거로 삼은 intake 파일 또는 artifact 참조다. persisted artifact를 가리킬 때는 `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json` 형식을 사용한다. |
| `product` | 문제, 대상 사용자, 목표, non-goals, core flows, interfaces, data model draft, external integrations, success criteria, constraints를 담는다. |
| `implementation` | architecture, interfaces, data flow, dependencies, edge cases, verification을 담는다. |
| `clarifying_question_disposition` | Gate B에서 각 intake `CQ-n`을 어떻게 처리했는지 기록한다. 상태는 `answered`, `assumed`, `deferred_non_goal`, `promoted_to_decision` 중 하나다. |
| `open_decisions` | spec 단계에서 아직 닫히지 않은 `ND-n` decision id 목록이다. intake의 unresolved decision과 CQ에서 승격된 unresolved decision을 합친 목록과 정확히 일치해야 한다. raw `CQ-n` id는 넣지 않는다. |
| `approval` | `draft` 또는 `approved`다. 명시적 사용자 승인 전에는 `draft`를 유지한다. |
| `approval_audit` | `approval: approved`일 때 필요한 승인 감사 정보다. `approved_by`, `approved_at`, `approved_artifacts`, `approval_note`를 담는다. |
| `reference_reconnaissance` | optional Gate B 기술/패턴 조사 기록이다. 후보 `REF-n`, 연결된 `evidence[].source_id`, 선택/기각 패턴, 남은 질문을 담아 source metadata와 decision metadata를 분리한다. |
| `evidence` | intake evidence를 보존하고 spec에서 새로 사용한 local/web 근거를 추가한다. |

`.plan2agent/schemas/task-graph.schema.json`의 핵심 필드는 다음과 같다.

| 필드 | 의미 |
| --- | --- |
| `schema_version` | task graph artifact 버전이다. 값은 반드시 `p2a.task_graph.v1`이다. |
| `projectId` | task graph의 프로젝트 id다. spec의 `project_id`와 같은 의미로 사용한다. |
| `version` | task graph 자체의 버전 문자열이다. |
| `sourceSpec` | task graph가 나온 승인 spec 파일 또는 artifact 참조다. persisted artifact를 가리킬 때는 `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` 형식을 사용한다. |
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
- Gate B 기술 추천에는 공식 문서, 릴리스 노트, 표준 문서, 패키지 레지스트리, source repository, vendor documentation 같은 primary source를 우선 사용한다.
- 승인된 spec이 라이브러리, 프레임워크, 런타임, 프로토콜, 패키지, 데이터베이스, 클라우드 서비스, 외부 API 같은 material technology choice를 담고 있으면 최소 하나의 관련 `WEB-n` evidence가 필요하다.
- Gate B에서 구체적인 외부 기술, 로컬 코드 패턴, prior artifact를 비교했다면 `reference_reconnaissance`에 후보 `REF-n`과 선택/기각 이유를 기록한다. 후보의 `source_id`는 반드시 `evidence`에 존재해야 하며, `selected_patterns`와 `rejected_patterns`는 존재하는 `candidate_id`를 참조해야 한다.
- `p2a_iteration draft`가 생성하는 Gate B 초안은 Gate A intake와 iteration idea를 `reference_reconnaissance.candidates`의 context 후보로 남긴다. 후속 iteration draft는 baseline의 WEB 기반 reference 후보를 carry-forward하므로, 승인 전에 새 기술 선택이나 로컬 패턴 재사용 근거가 있으면 추가 `REF-n` 후보와 선택/기각 패턴으로 보강한다.
- read-only web lookup은 prior art 또는 domain grounding 용도다. 구현 실행, dependency 설치, 코드 변경을 위해 사용하지 않는다.
- `.plan2agent/scripts/validate_artifacts.mjs`는 evidence `source_id` 중복, `WEB-n` URL 형식, 승인된 spec의 material technology choice에 대한 최소 `WEB-n` 존재, `reference_reconnaissance`의 evidence/candidate 참조 무결성을 검사한다. `--review`는 review artifact의 schema 유효성을 확인하고, `--require-review-pass`를 함께 쓰면 Gate D 통과 조건인 `review.json.blocking_issues: []`까지 확인한다. 다만 title/used_for의 내용 품질은 사람이 review해야 하므로, Gate D에서 근거가 실제 결정 근처에 인용됐는지 확인한다.

## 4. 재개(resume)

사용자가 `ND-1`, `ND-4` 같은 decision id에 답하면 하네스는 해당 `needs_user_decision[*].answer`를 채우고 `status`를 `answered`로 바꾼 뒤 `intake_json.status`를 다시 계산한다. `intake.md`가 존재하면 JSON에서 다시 생성해 view가 낡지 않게 한다.

재개는 입력이 바뀐 가장 이른 단계부터 다시 생성한다.

- Intake 답변이 바뀌면 spec, implementation plan, task graph, review가 모두 무효화되므로 downstream 산출물을 다시 만든다.
- Product spec이 바뀌면 implementation plan, task graph, review를 다시 만든다.
- Implementation plan이 바뀌면 task graph와 review를 다시 만든다.
- Task graph가 바뀌면 review를 다시 수행한다.

재개 중에도 `project_id`, `source_intake`, `sourceSpec`처럼 출처 추적에 필요한 안정적인 artifact id는 이어서 사용한다. 저장된 artifact를 참조할 때 `source_intake`는 `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json`, `sourceSpec`은 `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` 형식을 유지한다. Markdown artifact만 붙여 넣어진 경우에는 다음 게이트로 넘어가기 전에 대응하는 JSON 계약을 먼저 재구성해야 한다.

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
5. 승인된 spec fixture는 TypeScript package, injectable clock, Map과 doubly linked list 기반 구조, lazy TTL cleanup, deterministic unit tests를 포함한다. Intake의 `CQ-1`은 answered로, `CQ-2`는 v1 non-goal로 처분되어 Gate B traceability를 유지한다.
6. `task-graph.json`은 package scaffold, cache core data structures, public cache API, deterministic TTL/LRU tests처럼 dependency가 있는 작은 task로 나뉜다.
7. `review.json`은 승인 상태, dependency, acceptance criteria, source spec reference 검토 결과를 구조화해 담고, `blocking_issues: []`일 때 계획을 준비된 상태로 본다. `review-report.md`는 같은 내용을 사람이 읽기 쉽게 확인하는 보고서다.

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
  "clarifying_question_disposition": [
    {
      "id": "CQ-1",
      "status": "answered",
      "rationale": "The target runtime question is resolved by the selected v1 runtime decision.",
      "affects": [
        "spec.product.screens_or_interfaces",
        "spec.implementation.architecture"
      ],
      "resolved_by": "ND-1 answer: TypeScript/Node.js package"
    },
    {
      "id": "CQ-2",
      "status": "deferred_non_goal",
      "rationale": "The approved v1 scope excludes protocol and server compatibility.",
      "affects": [
        "spec.product.goals",
        "spec.product.non_goals"
      ],
      "non_goal": "No Redis protocol compatibility and no network server in v1"
    }
  ],
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

Co-located scaffold 프로젝트에서는 Gate D 정본 `review.json.blocking_issues`가 빈 배열인 것이 확인된 직후 root `gate-*` 산출물을 먼저 반복 구조로 변환한다. 개발 진행의 정본 task graph는 변환 후 `iterations/<iter-id>/gate-c-task-graph/task-graph.json`이며, 사용자는 root `gate-c-task-graph/task-graph.json`을 직접 실행하지 않는다.

```bash
node .plan2agent/scripts/p2a_iteration.mjs init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

사용자 관점의 루프는 다음과 같다.

1. `node .plan2agent/scripts/p2a_tasks.mjs ready --artifacts .plan2agent/artifacts/<project_id>`로 지금 시작할 수 있는 task를 확인한다.
2. 실행할 task를 정한 뒤 `node .plan2agent/scripts/p2a_execute.mjs start --artifacts .plan2agent/artifacts/<project_id> --task <task-id>`로 run을 만들고 상태를 `in_progress`로 바꾼다. dependency가 완료되지 않은 task는 시작할 수 없다.
3. `p2a_execute start`가 출력한 launcher prompt를 agent CLI에 붙여넣는다. 별도 확인이 필요하면 `node .plan2agent/scripts/p2a_tasks.mjs prompt --artifacts .plan2agent/artifacts/<project_id> <task-id>`로 같은 task context를 다시 볼 수 있다.
4. Claude Code 또는 Codex 같은 write-capable agent 세션에서 prompt를 실행하고, 코드 변경과 검증은 해당 작업 브랜치에서 수행한다. Gemini CLI는 현재 review/monitor 같은 read-only 보조로만 사용한다.
5. acceptance criteria와 필요한 테스트가 통과하면 `node .plan2agent/scripts/p2a_execute.mjs finish --artifacts .plan2agent/artifacts/<project_id> --run-id <run-id> --test --lint --typecheck --collect-git`로 검증, run closeout, task done/block 전이를 한 번에 기록한다. `done`은 최신 run이 현재 iteration/task graph에 속하고 실행된 verification(`source: config|command`, `exitCode: 0`)이 있는 경우만 허용한다. 막히면 failed/blocked finish에 `--failure-class`, `--repro-step`, `--localization`, `--guard`를 함께 기록한다.
6. 다시 `ready`를 확인해 다음 dependency-unblocked task를 선택한다.

이미 승인 산출물을 별도 대상 프로젝트로 복사한 legacy handoff 프로젝트에서는 `.plan2agent/project.config.json.taskGraph`가 가리키는 flat graph를 `--graph`로 명시할 수 있다.

상태 변경 명령은 파일을 쓰기 전에 task graph를 재검증하므로 duplicate id, 알 수 없는 dependency, cycle, 빈 acceptance criteria 같은 Gate C 위반이 있으면 변경을 저장하지 않는다.

## 8. 검증 방법

검증 스크립트는 JSON schema subset 검사와 procedural gate 검사를 함께 수행한다. 모든 명령은 저장소 루트에서 실행한다.

### 8.1 단일 artifact 검증

Intake만 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json
```

상태 문서만 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs --status .plan2agent/artifacts/<project_id>/status.md
```

artifact root의 Gate bundle을 한 번에 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs --artifact-root .plan2agent/artifacts/<project_id>
```

Spec과 intake traceability를 함께 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json --spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json
```

반복 artifact bundle의 active iteration을 검증:

```bash
node .plan2agent/scripts/p2a_iteration.mjs validate --artifacts .plan2agent/artifacts/<project_id>
```

active iteration을 close-ready 조건까지 검증:

```bash
node .plan2agent/scripts/p2a_iteration.mjs validate --artifacts .plan2agent/artifacts/<project_id> --require-close-ready
```

Gate D pass까지 포함한 handoff readiness 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs --artifact-root .plan2agent/artifacts/<project_id> --project-id <project_id> --require-handoff-ready
```

주의: co-located scaffold 프로젝트는 `p2a_iteration init` 이후 `p2a_iteration validate --artifacts`를 기본 검증으로 사용한다. `validate_artifacts.mjs --task-graph --require-approved-spec`는 개별 flat graph나 legacy handoff artifact를 직접 검증할 때 사용한다. 이때 spec의 `source_intake`가 실제 파일로 해석되면 validator가 그 intake까지 연결해 CQ disposition traceability도 확인한다.

### 8.2 fixture와 CLI parity 검증

이 절의 fixture/parity 명령은 Plan2Agent 본체 개발자용이며 Plan2Agent 저장소 루트에서 실행한다. scaffold 대상 프로젝트에는 `run_fixtures.mjs`, `check_cli_parity.mjs`, `sync_cli_assets.mjs`가 설치되지 않는다.

`fixtures/cache-library/` 한 세트를 검증:

```bash
node scripts/validate_artifacts.mjs --fixture-dir fixtures/cache-library
```

모든 일반 fixture 디렉터리, `_e2e` artifact-root handoff-ready 케이스, `_negative` manifest의 기대 실패 케이스를 검증:

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
| Schema required/additional/type/enum/const | `.plan2agent/schemas/*.schema.json`의 필수 키, 타입, enum, const, pattern, minLength/minItems subset을 검사한다. | `$ missing required keys: ...`, `$ contains unsupported keys: ...`, `$.schema_version must equal ...` |
| Evidence 중복/WEB URL | `evidence[].source_id`는 중복될 수 없고, `WEB-n` URL은 `http://` 또는 `https://`로 시작해야 한다. | `intake.evidence source_id values must be unique`, `spec.evidence WEB-1 must include an http(s) url` |
| Gate B 기술 조사 최소 근거 | 승인된 spec이 material technology choice를 담고 있으면 최소 하나의 관련 `WEB-n` evidence가 필요하다. | `approved spec with material technology choices requires WEB-n evidence ...` |
| status.md 최소 구조 | `--status`로 명시한 generated status 문서에는 `Progress:`, Gate A-D, 1-5번 섹션 heading이 있어야 한다. Artifact root 검증의 정본 조건은 아니다. | `status.md missing Progress line`, `status.md missing Gate A section` |
| artifact root bundle | `--artifact-root`는 Gate A-D의 JSON 정본 파일을 검증한다. 승인된 Gate B spec은 `spec.approval_audit`를 가져야 한다. | `Gate B is incomplete; missing ...`, `Gate C cannot be validated before Gate B spec exists`, `spec.approval_audit is required when spec.approval is approved` |
| handoff readiness | `--require-handoff-ready`는 artifact root가 Gate B approved, Gate C valid, `review.json.blocking_issues: []`인 Gate D passed 상태인지 확인한다. | `artifact root is not handoff-ready: ...` |
| 미해결 결정 차단 | `needs_user_decision.status`가 `open` 또는 `deferred`이면 intake status는 `blocked_on_user`여야 한다. 모두 닫히면 `ready_for_spec`이어야 한다. | `intake.status must be ... when unresolved decisions are ...` |
| decision answer/status 일관성 | `answered` decision은 `answer`가 있어야 하고, `open`/`deferred` decision은 `answer`를 가지면 안 된다. `--intake-md`를 명시하면 generated `intake.md`의 명백한 answered-vs-open 불일치도 실패한다. | `ND-1 is answered but has no answer`, `ND-1 is unresolved but has an answer` |
| CQ disposition 추적성 | `--spec`과 `--intake`를 함께 주면 모든 intake `CQ-n`이 `clarifying_question_disposition`에 정확히 한 번 있어야 한다. | `spec.clarifying_question_disposition is missing intake clarifying questions: ...` |
| CQ disposition 상태별 필수값 | `answered`는 `resolved_by`, `assumed`는 `assumption`, `deferred_non_goal`은 `non_goal`, `promoted_to_decision`은 `promoted_decision_id`가 필요하며, 다른 status용 detail field를 섞으면 안 된다. | `CQ-1 disposition status answered requires resolved_by`, `CQ-1 disposition status answered does not allow fields: ...` |
| spec/intake `open_decisions` 일치 | `--spec`과 `--intake`를 함께 주면 spec의 `open_decisions`가 intake의 unresolved `ND-n`과 CQ에서 승격된 unresolved `ND-n` 목록을 합친 값과 정확히 같아야 한다. | `spec.open_decisions must exactly match unresolved decisions: expected ..., got ...` |
| 알 수 없는 decision id | spec의 `open_decisions`가 intake 또는 CQ disposition에서 승격된 `ND-n`에 없는 id를 참조하면 실패한다. | `spec.open_decisions references unknown decisions: ...` |
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
| `spec.clarifying_question_disposition is missing intake clarifying questions` | intake의 `CQ-n`이 Gate B spec에서 처분되지 않았다. | 각 `CQ-n`을 `answered`, `assumed`, `deferred_non_goal`, `promoted_to_decision` 중 하나로 기록한다. |
| `CQ-1 disposition status ... requires ...` | disposition status와 필요한 근거 필드가 맞지 않는다. | status별 필수 필드(`resolved_by`, `assumption`, `non_goal`, `promoted_decision_id`)를 채운다. |
| `CQ-1 disposition status ... does not allow fields` | 한 disposition item에 다른 status용 detail field가 섞여 있다. | 현재 status에 맞는 detail field만 남긴다. `promoted_to_decision`만 `resolution`을 함께 가질 수 있다. |
| `spec.open_decisions must exactly match unresolved decisions` | spec의 open decision 목록과 미해결 decision 목록이 다르다. | intake에서 unresolved인 `ND-n`과 CQ에서 승격됐지만 해결되지 않은 `ND-n`만 spec `open_decisions`에 넣는다. 모든 decision이 답변됐으면 `open_decisions: []`로 둔다. |
| `promoted decision ND-4 must be in open_decisions until it has a resolution` | CQ를 `promoted_to_decision`으로 표시했지만 아직 해결하지 않았고 `open_decisions`에도 없다. | 해당 `ND-n`을 `open_decisions`에 넣고 spec을 `draft`로 유지하거나, 사용자 답변을 받아 disposition에 `resolution`을 기록한다. |
| `promoted_decision_id must not reuse intake decision ids` | CQ에서 승격한 decision id가 기존 intake `ND-n`과 충돌한다. | 새 `ND-n` id를 부여하고 `open_decisions` 참조도 함께 바꾼다. |
| `spec.approval_audit is required when spec.approval is approved` | 승인된 spec인데 JSON 승인 감사 정보가 없다. | `spec.json`에 `approval_audit.approved_by`, `approved_at`, `approved_artifacts`, `approval_note`를 추가한다. |
| `approved specs must not contain open_decisions` | `approval: approved`인데 spec에 미해결 decision이 남았다. | spec을 `draft`로 되돌리거나, 모든 decision을 해결한 뒤 `open_decisions: []`로 만든다. |
| `task graph generation is blocked until spec.approval is approved` | 승인되지 않은 spec으로 task graph를 검증/생성하려 했다. | 사용자에게 product spec과 implementation plan을 파일로 검토받고 명시적 승인을 받은 뒤 `approval: approved`로 바꾼다. |
| `task graph generation is blocked while spec.open_decisions is non-empty` | spec에 미해결 결정이 남아 있다. | Gate B로 돌아가 open decision을 해결한다. |
| `task ids must be unique` | 같은 `task-001` 같은 id가 두 번 이상 있다. | task id를 안정적으로 다시 부여하고 dependency 참조도 함께 수정한다. |
| `has unknown dependencies` | task가 존재하지 않는 dependency id를 참조한다. | dependency 오타를 고치거나 누락된 선행 task를 추가한다. |
| `task graph contains a dependency cycle` | task dependency가 서로 물고 있어 시작 가능한 순서가 없다. | cycle에 포함된 task의 선후관계를 다시 설계한다. |
| `$ contains unsupported keys` 또는 `$ missing required keys` | JSON artifact가 schema와 맞지 않는다. | `.plan2agent/schemas/intake.schema.json`, `.plan2agent/schemas/spec.schema.json`, `.plan2agent/schemas/task-graph.schema.json`의 required/additionalProperties 규칙에 맞춘다. |
| `WEB-1 must include an http(s) url` | web evidence의 URL이 비어 있거나 http(s)가 아니다. | 실제 참조한 웹 문서의 `http://` 또는 `https://` URL을 넣는다. |
| CLI가 skill 또는 subagent를 못 알아본다. | CLI가 mirror 파일을 아직 로드하지 않았거나 mirror drift가 있다. | Plan2Agent 저장소 루트에서 CLI를 재시작한다. Gemini CLI command는 `/commands reload` 후 `/commands list`를 확인한다. 필요하면 `node scripts/sync_cli_assets.mjs`와 `node scripts/check_cli_parity.mjs`를 실행한다. |
| `parity failed: skill mirror drift ...` | `.agents/skills` 원본과 `.claude/skills` mirror가 다르다. | canonical `.agents` 쪽 변경을 기준으로 Plan2Agent 저장소 루트에서 `node scripts/sync_cli_assets.mjs`를 실행하고 parity를 재검사한다. |
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
| `clarifying_question_disposition` | Gate B에서 intake `CQ-n`을 answered, assumed, deferred non-goal, promoted decision 중 하나로 처분한 추적 배열이다. |
| `open_decisions` | spec 단계에서 아직 해결되지 않은 `ND-n` decision id 목록이다. intake의 unresolved decision과 CQ에서 승격된 unresolved decision을 합친 값과 일치해야 한다. |
| resume | 이전 산출물과 새 답변을 합쳐, 입력이 바뀐 가장 이른 단계부터 downstream artifact를 다시 만드는 절차다. |
| mirror | Claude/Codex/Gemini CLI가 읽을 수 있도록 canonical 원본에서 생성된 target별 파일이다. |
| canonical `.agents` | Plan2Agent skill과 agent의 원본 위치다. `.agents/skills`와 `.agents/agents`를 기준으로 mirror를 생성한다. |
| `source_intake` | spec이 어떤 intake artifact에서 생성됐는지 나타내는 추적 필드다. 저장된 artifact 참조는 `.plan2agent/artifacts/<project_id>/gate-a-intake/intake.json` 형식을 사용한다. |
| `sourceSpec` | task graph가 어떤 승인 spec에서 생성됐는지 나타내는 추적 필드다. 저장된 artifact 참조는 `.plan2agent/artifacts/<project_id>/gate-b-spec/spec.json` 형식을 사용한다. |
| `evidence` | 사용자/로컬/웹 근거를 `USER-n`, `LOCAL-n`, `WEB-n` id로 보존하는 배열이다. |

## 11. 추가 포인터와 v1/v2 범위

- 제품 방향과 남은 로드맵은 `plans/01-product-roadmap.md`를 먼저 본다. Gate A-D 상세 계약은 이 문서, 반복 개발은 `docs/iteration-spec.md`, 감독형 실행은 `docs/supervised-execution.md`를 정본으로 본다.
- 하네스 구현 기준은 `docs/harness-spec.md`를 본다. 이 문서는 단계, 역할, 승인 게이트, resume, state passing, evidence, 저장 구조, 검증 스크립트 기준을 정의한다.
- 다회차 기획과 반복/고도화 개발 구조는 `docs/iteration-spec.md`를 본다. 이 문서는 iteration layout, `current-spec.json`, active iteration, maintenance, open/close 후보 명령을 정의한다.
- 사용자 시작점과 문서 탐색은 `docs/README.md`와 `docs/quickstart.md`를 먼저 본다. CLI별 세부 명령은 `docs/cli-reference.md`를 본다.
- 하네스 한계: Gate A-D planning 단계는 코드 변경, dependency 설치, 구현 목적 shell 실행을 하지 않는다. 승인된 task 이후의 감독형 실행 흐름은 `docs/supervised-execution.md`를 본다.
- 실행 추적: handoff 이후 `p2a_runs.mjs`가 파일 기반 run log, changed files, verification, workspace/branch/worktree 참조를 기록한다. agent 자동 실행 orchestration은 후속이다.

무엇을 보강했는지:

- 문서 상단에 TOC와 파이프라인 다이어그램을 추가했다.
- Node.js ESM 전제조건, 저장소 루트 실행, 클론 후 첫 검증 명령을 구체화했다.
- intake/spec/task graph 스키마 주요 필드와 산출물-스키마 매핑을 표로 정리했다.
- `USER-n`/`LOCAL-n`/`WEB-n` evidence 규칙과 WEB URL/인용 원칙을 별도 섹션으로 분리했다.
- `validate_artifacts`, `run_fixtures`, `check_cli_parity`, `sync_cli_assets` 사용법과 실제 gate 검사 항목을 스크립트 기준으로 설명했다.
- `fixtures/cache-library/`의 실제 JSON 발췌를 추가했다.
- validation 실패 메시지별 원인/해결과 CLI reload/parity 관련 FAQ를 추가했다.
- gate, skill, subagent, artifact, resume, mirror/canonical 등 핵심 용어집을 추가했다.
- `plans/01-product-roadmap.md`, `docs/README.md`, `docs/quickstart.md`, `docs/harness-spec.md`, `docs/iteration-spec.md` 포인터와 v1/v2 범위를 명확히 했다.
