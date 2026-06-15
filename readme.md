# Plan2Agent

Plan2Agent(P2A)는 사용자의 한 문장 아이디어를 출발점으로 삼아, 대화로 기획을 보강하고, 개발 가능한 명세와 task graph로 분해하는 planning harness다.

현재 v1 하네스는 코드 변경을 자동 실행하지 않는다. Claude Code, Codex, Gemini CLI가 공통 skill과 subagent를 사용해 `idea -> intake -> spec -> task graph -> review` 흐름을 수행하고, handoff 이후에는 task 상태와 agent 실행 결과를 파일 기반 sidecar로 기록한다.

## 현재 범위

v1에서 하는 일:

- 한 문장 아이디어를 구조화한다.
- 부족한 정보를 schema-compatible 질문과 `needs_user_decision`으로 만든다.
- 승인 게이트를 지켜 제품 명세와 구현 명세를 생성한다.
- 승인된 구현 명세를 구현 가능한 task graph로 분해한다.
- task별 agent 실행 prompt 초안을 만든다.
- 명세와 task graph의 누락, 과대 task, 의존성 오류, gate 위반을 검토한다.
- 반복 구조에서 close/open, semantic diff task, maintenance task, handoff 기준점을 관리한다.
- 대상 프로젝트로 산출물과 실행 도구를 handoff한다.
- agent 실행 결과를 run log로 기록한다.
- 4개 CLI 구성의 mirror drift를 검사한다.

v1에서 하지 않는 일:

- 실제 코드 변경 자동 실행
- dependency 설치 또는 shell 기반 구현 작업
- agent 실행 결과 자동 병합
- DB 또는 지식 그래프 저장소 운영

## 기준 문서

- [제품 기준과 고도화 로드맵](plans/01-product-roadmap.md)
- [문서 홈](docs/README.md)
- [제품 퀵스타트](docs/quickstart.md)
- [하네스 구현 기준](docs/harness-spec.md)
- [반복/고도화 개발 스펙](docs/iteration-spec.md)
- [CLI 사용자 가이드](docs/cli-reference.md)

## 하네스 구조

Canonical 원본은 `.agents/skills/`와 CLI-중립 `.agents/agents/`다. `.agents/agents/*.md` frontmatter는 `capabilities`, `access`, `tier`만 사용하고 특정 CLI의 `tools`/`model` 문법을 넣지 않는다. `.claude/`, `.codex/`, `.gemini/` 아래 agent/skill mirror는 `scripts/sync_cli_assets.mjs`로 생성되는 산출물이므로 직접 수정하지 않는다. Gemini command shim은 수동 관리 대상이다.

공통 canonical 원본:

```text
.agents/
  skills/
    p2a-harness/
    p2a-intake/
    p2a-spec/
    p2a-task-breakdown/
    p2a-review/
  agents/
    p2a-requirements.md
    p2a-spec-author.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
```

Claude Code용 구성:

```text
.claude/
  agents/
    p2a-requirements.md
    p2a-spec-author.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  skills/
    p2a-harness/
    p2a-intake/
    p2a-spec/
    p2a-task-breakdown/
    p2a-review/
```

Codex용 구성:

```text
.codex/agents/
  p2a-requirements.toml
  p2a-spec-author.toml
  p2a-implementation-planner.toml
  p2a-task-graph.toml
  p2a-quality-reviewer.toml
```

Gemini CLI용 구성:

```text
.gemini/
  agents/
    p2a-requirements.md
    p2a-spec-author.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  commands/p2a/
    harness.toml
    intake.toml
    spec.toml
    task-breakdown.toml
    review.toml
```

Fixtures, schemas, and checks:

```text
fixtures/
  cache-library/
    status.md
    input.md
    intake.blocked.json
    intake.answered.json
    spec.approved.json
    task-graph.json
    review-report.md
    review.json
  webhook-api-service/
    status.md
    input.md
    intake.blocked.json
    intake.answered.json
    spec.approved.json
    task-graph.json
    review-report.md
    review.json
  _e2e/
    manifest.json
    webhook-api-service/
      status.md
      gate-a-intake/
      gate-b-spec/
      gate-c-task-graph/
      gate-d-review/
  _negative/
    manifest.json
    missing-approval-audit/
      status.md
      gate-a-intake/
      gate-b-spec/
    promoted-decision-draft/
      spec.draft.json
      spec.invalid-missing-open-decision.json
      task-graph.json
    review-blocked/
      review.blocked.json
schemas/
  intake.schema.json
  spec.schema.json
  task-graph.schema.json
scripts/
  sync_cli_assets.mjs
  check_cli_parity.mjs
  validate_artifacts.mjs
  run_fixtures.mjs
  p2a_tasks.mjs
```


## CLI-neutral agent mapping

`.agents/agents/*.md`는 중립 metadata를 갖고, sync 스크립트가 CLI별 native 설정으로 변환한다.

| Neutral metadata | Claude target | Gemini target | Codex target |
| --- | --- | --- | --- |
| `capabilities: read` | `tools: Read` | `tools: read_file` | per-tool list 없음 |
| `capabilities: search` | `tools: Grep`, `Glob` | `tools: grep_search` | per-tool list 없음 |
| `capabilities: web` | `tools: WebSearch`, `WebFetch` | `tools: google_web_search`, `web_fetch` | 별도 custom-agent web flag를 생성하지 않음 |
| `access: read-only` | tool set으로 암시 | `kind: local` | `sandbox_mode = "read-only"` |
| `tier: standard` | `model: sonnet` | `temperature: 0.2`, `max_turns: 10` | `model_reasoning_effort = "medium"` |

Codex custom agent 공식 스키마는 `name`, `description`, `developer_instructions`를 필수로 하고 `model_reasoning_effort`, `sandbox_mode` 등 config key override를 허용하지만, per-agent web search flag는 문서화된 필드로 확인되지 않아 생성하지 않는다. 따라서 agent 본문은 web 사용을 “where the CLI provides it”로 표현한다.

## 역할

Subagents:

| 이름 | 역할 |
| --- | --- |
| `p2a-requirements` | 아이디어를 `intake_json`의 known facts, assumptions, clarification questions, `needs_user_decision`으로 정리 |
| `p2a-spec-author` | answered intake를 제품 명세와 `spec_json.product`로 변환 |
| `p2a-implementation-planner` | 승인 가능한 제품 명세를 구현 계획과 `spec_json.implementation`으로 변환 |
| `p2a-task-graph` | 승인된 구현 계획을 dependency-aware `task_graph_json`으로 분해 |
| `p2a-quality-reviewer` | 명세, 계획, task graph의 누락, gate 위반, 의존성 오류, 실행 리스크 검토 |

Skills:

| 이름 | 역할 |
| --- | --- |
| `p2a-harness` | 전체 workflow orchestration, 단계→subagent 매핑, 승인 gate, resume 규칙 관리 |
| `p2a-intake` | 초기 아이디어 분석과 schema-compatible 질문 생성 |
| `p2a-spec` | 제품/구현 명세 생성과 승인 상태 추적 |
| `p2a-task-breakdown` | 승인된 spec을 task graph로 분해 |
| `p2a-review` | 산출물 검토와 blocking issue 보고 |

## 표준 산출물 계약

하네스는 중간 상태를 다음 이름으로 전달한다.

| Artifact | Schema | 생성 단계 | 다음 단계로 넘어가는 조건 |
| --- | --- | --- | --- |
| `intake_json` | `schemas/intake.schema.json` | Intake | `status: ready_for_spec` |
| `product_spec_markdown` | Markdown | Product Spec | 사용자 검토 가능 |
| `implementation_plan_markdown` | Markdown | Implementation Plan | 사용자 검토 가능 |
| `spec_json` | `schemas/spec.schema.json` | Spec | 모든 `CQ-n` disposition 완료, `approval: approved`, `open_decisions: []` |
| `task_graph_json` | `schemas/task-graph.schema.json` | Task Breakdown | dependency ids valid and DAG acyclic |
| `review_report` | Markdown/JSON-compatible sections | Review | no blocking issues |

### 산출물 파일 저장

하네스 오케스트레이터는 각 단계 산출물을 `artifacts/<project_id>/` 아래 gate별 폴더에 기록해 사용자가 게이트 전에 파일로 검토할 수 있게 한다.

- `status.md` — 모든 게이트 전환마다 갱신되는 standing 진행상태 및 결정 인덱스
- `gate-a-intake/intake.json`, `gate-a-intake/intake.md`
- `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, `gate-b-spec/spec.json`
- `gate-c-task-graph/task-graph.json`
- `gate-d-review/review-report.md`

subagent는 read-only를 유지하며, 파일 기록은 하네스 오케스트레이터만 수행한다. `scripts/validate_artifacts.mjs`로 이 파일들을 그대로 검증할 수 있다.

`artifacts/<project_id>/` 산출물은 git에 커밋해 기획 이력(파일 기반 versioning)으로 보존한다.


## Evidence와 Web citation 규칙

Intake와 spec 단계가 web lookup 또는 외부 문서를 사용하면 결과 JSON의 `evidence` 배열에 source를 남긴다. Web lookup은 해당 CLI가 제공하는 경우에만 사용한다.

- `USER-n`: 사용자가 직접 제공한 요구사항, 답변, pasted artifact
- `LOCAL-n`: 저장소 또는 로컬 파일에서 읽은 근거
- `WEB-n`: web lookup으로 확인한 prior art, API, integration, domain behavior

모든 `WEB-n` 항목은 `title`, `url`, `used_for`를 포함해야 하며, web 근거가 질문·가정·제품 결정·integration 선택에 영향을 주면 주변 rationale에서 `source_id`를 언급한다.

## 승인 게이트와 재개 규칙

1. **Gate A — Intake decisions**
   - `needs_user_decision.status`가 하나라도 `open` 또는 `deferred`이면 intake에서 멈춘다.
   - 제품 명세는 확정하지 않고, 사용자에게 open/deferred decision만 질문한다.

2. **Gate B — Spec approval**
   - intake의 모든 `CQ-n`은 `spec_json.clarifying_question_disposition`에서 처분되어야 한다.
   - `spec_json.approval`이 `approved`가 아니거나 `open_decisions`가 남아 있으면 task graph를 만들지 않는다.
   - 승인된 Gate B가 있는 artifact root 또는 fixture는 `status.md`에 `Gate B approval audit` block을 기록해야 한다.

3. **Gate C — Task graph validation**
   - 모든 dependency는 같은 graph 안의 task id를 참조해야 한다.
   - dependency graph는 cycle이 없어야 한다.
   - 모든 task는 acceptance criteria와 source spec reference를 가져야 한다.

4. **Resume**
   - 사용자가 `ND-1`, `ND-4`처럼 기존 decision에 답하면 해당 decision의 `answer`를 채우고 `status`를 `answered`로 바꾼다.
   - 변경된 artifact의 downstream 산출물만 다시 만든다.
   - Markdown artifact만 주어진 경우 다음 단계로 넘어가기 전에 대응 JSON 계약을 재구성한다.

## 구동 방식

이 저장소는 현재 별도 서버를 실행하지 않는다. 각 CLI를 저장소 루트에서 실행하면, 해당 CLI가 repo-scoped skill, subagent, command 파일을 읽어 하네스를 사용한다.

공통 전제:

- 저장소 루트에서 CLI를 시작한다.
- 새 skill, subagent, command가 인식되지 않으면 CLI를 재시작하거나 reload 명령을 실행한다.
- v1 하네스는 read-only planning 용도다. 코드 수정, 패키지 설치, shell 실행을 요청하지 않는다.

## Claude Code 사용

저장소 루트에서 Claude Code를 시작한다.

```bash
claude
```

전체 하네스 실행:

```text
/p2a-harness 사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

단계별 실행:

```text
/p2a-intake <한 문장 아이디어>
/p2a-spec <intake_json과 사용자 답변>
/p2a-task-breakdown <승인된 spec_json>
/p2a-review <spec_json과 task_graph_json>
```

Claude Code의 project skills는 `.claude/skills/`에서 읽히고, project subagents는 `.claude/agents/`에서 읽힌다. 새 디렉터리가 처음 추가된 경우 Claude Code 재시작이 필요할 수 있다.

## Codex 사용

저장소 루트에서 Codex를 시작한 뒤 skill을 명시적으로 호출한다.

```text
Use the $p2a-harness skill on this idea:
사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

Codex subagent까지 명시적으로 쓰려면 다음처럼 요청한다.

```text
Use the $p2a-harness skill.
Spawn p2a-requirements, p2a-spec-author, p2a-implementation-planner, p2a-task-graph, and p2a-quality-reviewer only for read-only planning.
Stop at each approval gate and return the named state artifacts.
```

Codex custom agents는 `.codex/agents/*.toml`에 정의되어 있다. Codex는 subagent를 자동으로 spawn하지 않으므로, 병렬 또는 subagent 작업이 필요하면 prompt에서 명시해야 한다.

## Gemini CLI 사용

저장소 루트에서 Gemini CLI를 시작한다. command 파일을 수정한 직후라면 reload한다.

```text
/commands reload
/commands list
```

전체 하네스 실행:

```text
/p2a:harness 사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

단계별 실행:

```text
/p2a:intake <한 문장 아이디어>
/p2a:spec <intake_json과 사용자 답변>
/p2a:task-breakdown <승인된 spec_json>
/p2a:review <spec_json과 task_graph_json>
```

Gemini CLI에서 `.gemini/commands/p2a/harness.toml`은 `/p2a:harness` 명령이 된다. 하위 디렉터리의 `/`는 command namespace에서 `:`로 변환된다.

## 검증 스크립트

CLI mirror 생성/동기화:

```bash
node scripts/sync_cli_assets.mjs
```

CLI mirror drift 확인(검사 항목: agent mirror 동기화, skill mirror byte 비교, Gemini command shim 내용 검사(skill 이름, `{{args}}`, 필수 필드)):

```bash
node scripts/check_cli_parity.mjs
```

Fixture/golden output 확인:

```bash
node scripts/run_fixtures.mjs
```

`run_fixtures.mjs`는 일반 fixture set을 통과 검증하고, `fixtures/_e2e/manifest.json`의 artifact-root fixture는 handoff-ready 상태인지 확인한다. 승인된 Gate B가 있는 status 문서는 `Gate B approval audit` block까지 확인한다. `fixtures/_negative/manifest.json`에 정의된 중단/실패 fixture는 기대한 실패 메시지가 나오는지 확인한다.

artifact gate 확인:

```bash
node scripts/validate_artifacts.mjs --intake artifacts/<project_id>/gate-a-intake/intake.json
node scripts/validate_artifacts.mjs --status artifacts/<project_id>/status.md
node scripts/validate_artifacts.mjs --artifact-root artifacts/<project_id>
node scripts/validate_artifacts.mjs --spec artifacts/<project_id>/gate-b-spec/spec.json
node scripts/validate_artifacts.mjs --task-graph artifacts/<project_id>/gate-c-task-graph/task-graph.json --require-approved-spec artifacts/<project_id>/gate-b-spec/spec.json
node scripts/validate_artifacts.mjs --review artifacts/<project_id>/gate-d-review/review.json --require-review-pass
node scripts/validate_artifacts.mjs --artifact-root artifacts/<project_id> --project-id <project_id> --require-handoff-ready
```

`--spec`은 `--intake`를 함께 주면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B의 `clarifying_question_disposition` 추적성까지 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다. raw `CQ-n`은 `open_decisions`에 넣지 않고, blocker가 되면 `ND-n`으로 승격해 추적한다.

## Task 관리

Gate D까지 통과해 `artifacts/<project_id>/gate-c-task-graph/task-graph.json`이 확정되면 Node.js task CLI로 개발 진행 상태를 관리한다. 기본 사용법은 다음과 같다.

```bash
node scripts/p2a_tasks.mjs <command> --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json [task-id]
```

명령:

- `list`: 전체 task의 `id`, `title`, `status`, `dependencies`, ready 여부를 표로 출력한다.
- `ready`: 모든 dependency가 `done`이고 자신의 상태가 `todo`인 task만 출력한다.
- `show <task-id>`: acceptance criteria와 source spec refs를 포함한 task 전체 JSON을 출력한다.
- `prompt <task-id>`: `suggestedAgentPrompt`에 acceptance criteria, task description, 참조 spec 섹션, 전체 명세 경로를 덧붙여 agent CLI에 바로 붙여넣을 수 있는 실행 prompt를 출력한다.
- `start <task-id>`: 모든 dependency가 `done`인 `todo` task만 `in_progress`로 바꾼다.
- `done <task-id>`: `in_progress` task만 `done`으로 바꾼다.
- `block <task-id>`: task를 `blocked`로 표시한다.
- `todo <task-id>`: task를 `todo`로 되돌린다.

개발 진행 루프:

1. 기획 완료 후 `node scripts/p2a_tasks.mjs ready --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json`로 실행 가능한 task를 고른다.
2. `node scripts/p2a_tasks.mjs prompt --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json <task-id>`로 실행 prompt를 만든다.
3. 해당 prompt를 Claude Code, Codex, Gemini CLI 같은 agent CLI에 붙여넣어 구현 작업을 수행한다.
4. 작업을 시작할 때 `start`, 검증 후 `done`, 막히면 `block`으로 상태를 기록한다.
5. 각 전이는 저장 전에 task graph 전체를 `scripts/validate_artifacts.mjs`의 검증 로직으로 재검증하므로 잘못된 graph는 기록되지 않는다.

## Task Graph 기준

각 task는 최소한 다음 필드를 가진다.

```json
{
  "schema_version": "p2a.task_graph.v1",
  "projectId": "example-project",
  "version": "1",
  "sourceSpec": "example-spec",
  "tasks": [
    {
      "id": "task-001",
      "title": "Define product spec schema",
      "description": "Create the first JSON schema for Plan2Agent product specs.",
      "status": "todo",
      "dependencies": [],
      "acceptanceCriteria": [
        "Schema includes problem, target_users, goals, non_goals, core_flows, constraints"
      ],
      "targetArea": "spec-schema",
      "suggestedAgentPrompt": "Create a Plan2Agent product spec JSON schema. Do not implement unrelated app code.",
      "sourceSpecRefs": ["spec.product"]
    }
  ]
}
```

기준:

- `dependencies`는 task id를 참조한다.
- 기본 상태는 `todo`다.
- 완료 기준이 불명확하면 task를 확정하지 않는다.
- 너무 큰 task는 화면, API, 데이터 모델, 테스트, 문서 단위로 나눈다.

## 안전 정책

- v1 하네스는 read-only planning이다.
- 어떤 skill이나 subagent도 코드 변경을 지시하지 않는다.
- dependency 설치, shell 실행, git 조작은 v1 workflow에 포함하지 않는다.
- 하네스 오케스트레이터는 planning 산출물(.md/.json)을 `artifacts/<project_id>/`에만 기록할 수 있다. 소스코드 변경, 의존성 설치, shell 실행(구현 목적), git 조작은 계속 금지하며, subagent는 read-only를 유지한다.
- 불명확한 요구사항은 임의 구현하지 않고 `needs_user_decision`으로 남긴다.
- 실제 구현은 task graph 승인 이후 별도 단계에서 수행한다.

## 다음 고도화 작업

- CLI asset drift check와 fixture runner의 CI 연결은 사용자 관리 항목으로 유지
- 완료: `p2a_runs.mjs` 기반 agent 실행 로그, branch/worktree 격리 기준, 결과 diff 연결 sidecar 추가. PTY 기반 agent 자동 실행과 PR 생성은 후속.
