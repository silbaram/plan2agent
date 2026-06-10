# Plan2Agent 하네스 사용자 가이드

이 문서는 Plan2Agent(P2A) 하네스를 처음 사용하는 사용자가 한 문장 아이디어를 검토 가능한 기획 산출물로 바꾸는 흐름을 이해하도록 돕는 안내서다. 기준은 `p2a-harness` skill, 하네스 구현 기준, 그리고 저장소 readme의 최신 정책이다.

## 1. 개요

Plan2Agent 하네스는 한 문장 제품 아이디어를 바로 코드로 구현하지 않고, 승인 게이트를 거쳐 개발 가능한 계획으로 다듬는 planning workflow다. v1 하네스는 코드 변경, dependency 설치, 구현 목적의 shell 실행을 하지 않는다. 대신 Claude Code, Codex, Gemini CLI가 공통 skill과 subagent 역할을 사용해 같은 산출물 계약을 따르도록 한다.

파이프라인은 다음 순서로 진행된다.

| 단계 | 담당 skill | 주요 역할 | 산출물 |
| --- | --- | --- | --- |
| 1. Intake | `p2a-intake` | 아이디어를 사실, 가정, 질문, 사용자 결정 항목으로 구조화한다. | `intake_json`, `intake.md` |
| 2. Product spec | `p2a-spec` | 답변된 intake를 제품 목표, 범위, 사용자 흐름, 성공 기준으로 정리한다. | `product_spec_markdown`, `spec_json.product` |
| 3. Implementation plan | `p2a-spec` | 승인 가능한 제품 명세를 아키텍처, 인터페이스, 데이터 흐름, 검증 계획으로 바꾼다. | `implementation_plan_markdown`, `spec_json.implementation` |
| 4. Task graph | `p2a-task-breakdown` | 승인된 구현 명세를 의존성 있는 작은 task로 분해한다. | `task_graph_json` |
| 5. Review | `p2a-review` | 명세와 task graph의 누락, gate 위반, 의존성 오류, 실행 리스크를 검토한다. | `review_report` |

하네스는 대화 안에서도 `intake_json`, `product_spec_markdown`, `implementation_plan_markdown`, `spec_json`, `task_graph_json`, `review_report`라는 이름의 상태 섹션을 반환한다. 동시에 각 단계 산출물을 `artifacts/<project_id>/` 아래 파일로 저장해 사용자가 게이트 전에 파일로 열어 검토할 수 있게 한다.

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

## 3. 산출물 파일

하네스 오케스트레이터는 안정적인 kebab-case `project_id`를 사용하고, 한 번의 run에 속한 파일을 모두 `artifacts/<project_id>/` 아래에 둔다. Subagent는 read-only이며 파일을 직접 쓰지 않는다. 파일 기록은 하네스 오케스트레이터만 수행한다.

| 파일 | 역할 |
| --- | --- |
| `intake.json` | `intake_json` 구조화 산출물이다. 원문 아이디어, known facts, assumptions, clarifying questions, `needs_user_decision`, evidence, intake status를 담는다. |
| `intake.md` | 사용자가 읽는 intake 분석 문서다. 이해한 범위, 가정과 위험, decision별 trade-off와 추천, downstream block 정보를 설명한다. |
| `product-spec.md` | 사용자 검토용 제품 명세다. 문제, 대상 사용자, 목표, non-goals, 핵심 흐름, 인터페이스, 성공 기준 등을 Markdown으로 정리한다. |
| `implementation-plan.md` | 구현 계획 Markdown이다. 아키텍처, 인터페이스, 데이터 흐름, 의존 요소, edge case, 검증 방식을 정리한다. |
| `spec.json` | 제품/구현 명세의 구조화 원본이다. `schemas/spec.schema.json` 계약을 따르며 approval 상태와 open decisions를 포함한다. |
| `task-graph.json` | 승인된 spec에서 생성된 task graph다. task id, dependency, acceptance criteria, target area, suggested agent prompt, source spec reference를 담는다. |
| `review-report.md` | quality review 결과다. blocking issues, non-blocking risks, 누락된 테스트/완료 기준, oversized tasks, dependency issues, gate issues, 추천 변경 사항을 담는다. |

`artifacts/<project_id>/` 산출물은 git에 커밋해 기획 이력(파일 기반 versioning)으로 보존한다. 따라서 artifact 디렉터리는 ignore하지 않고, 변경된 계획과 task graph를 파일 히스토리로 추적한다.

## 4. 재개(resume)

사용자가 `ND-1`, `ND-4` 같은 decision id에 답하면 하네스는 해당 `needs_user_decision[*].answer`를 채우고 `status`를 `answered`로 바꾼 뒤 `intake_json.status`를 다시 계산한다.

재개는 입력이 바뀐 가장 이른 단계부터 다시 생성한다.

- Intake 답변이 바뀌면 spec, implementation plan, task graph, review가 모두 무효화되므로 downstream 산출물을 다시 만든다.
- Product spec이 바뀌면 implementation plan, task graph, review를 다시 만든다.
- Implementation plan이 바뀌면 task graph와 review를 다시 만든다.
- Task graph가 바뀌면 review를 다시 수행한다.

재개 중에도 `project_id`, `source_intake`, `sourceSpec`처럼 출처 추적에 필요한 안정적인 artifact id는 이어서 사용한다. Markdown artifact만 붙여 넣어진 경우에는 다음 게이트로 넘어가기 전에 대응하는 JSON 계약을 먼저 재구성해야 한다.

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

단계별 shim은 `/p2a:intake`, `/p2a:spec`, `/p2a:task-breakdown`, `/p2a:review`다. Command 파일을 수정한 직후라면 `/commands reload` 후 `/commands list`로 확인한다.

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
