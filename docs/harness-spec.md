# Plan2Agent 하네스 구현 기준

참고 기준일: 2026-06-15

이 문서는 Plan2Agent v1 하네스의 구현 기준이다. Claude Code, Codex, Gemini CLI에서 같은 역할과 절차를 제공하기 위해 skill, subagent, command scaffold의 경로, 역할, 안전 정책, 승인 게이트, 재개 규칙, 검증 기준을 정의한다.

문서 홈: [Plan2Agent Docs](README.md) · 사용자 시작점: [Quickstart](quickstart.md)

Plan2Agent의 핵심 가치는 기획 변경이 개발 가능한 명세와 task로 연결되고, 그 과정이 시맨틱 문서로 남는 순환 시스템을 만드는 것이다. 이 하네스는 그 순환 중 "아이디어를 명세와 task graph로 바꾸는 단계"를 먼저 고정한다.

## 1. MVP 하네스 목표

v1 하네스는 실제 코드 변경을 자동 실행하지 않는다. 대신 세 가지 CLI agent가 공통으로 사용할 수 있는 기획/분해 절차를 제공한다.

v1 책임:

- 사용자의 한 문장 아이디어를 구조화한다.
- 부족한 정보를 schema-compatible 질문 목록과 `needs_user_decision`으로 만든다.
- 승인 게이트를 지켜 제품 명세와 구현 명세를 생성한다.
- 구현 가능한 task graph로 분해한다.
- task별 agent 실행 prompt 초안을 만든다.
- task graph를 검토해 누락, 과대 task, 의존성 오류, gate 위반을 찾는다.
- 반복 구조에서 semantic diff task 초안과 파일 기반 실행 로그를 관리한다.
- CLI별 mirror drift를 검사한다.

v1 제외:

- Claude Code, Codex, Gemini CLI의 실제 자동 실행
- PTY 기반 agent orchestration
- code-aware spec 역생성 또는 코드 diff 자동 병합
- task 결과 자동 병합
- DB 또는 지식 그래프 저장소

## 2. 공통 하네스 모델

Plan2Agent는 CLI별 구현 차이를 감추기 위해 공통 역할 이름과 CLI-중립 agent metadata를 먼저 정의한다. `.agents/agents/*.md`는 canonical 원본이며, 특정 CLI의 `tools`/`model` 문법 대신 `capabilities`, `access`, `tier`만 사용한다.

### Subagents

| 이름 | 역할 | v1 권한 |
| --- | --- | --- |
| `p2a-requirements` | 한 문장 아이디어를 `intake_json`으로 변환 | read-only, optional web lookup |
| `p2a-spec-author` | answered intake를 제품 명세와 `spec_json.product`로 변환 | read-only, optional web lookup |
| `p2a-implementation-planner` | 승인 가능한 제품 명세를 구현 계획과 `spec_json.implementation`으로 변환 | read-only, optional web lookup |
| `p2a-task-graph` | 승인된 구현 계획을 agent 실행 가능한 `task_graph_json`으로 분해 | read-only |
| `p2a-quality-reviewer` | 명세, 계획, task graph의 누락, gate 위반, 의존성 오류 검토 | read-only |

### Skills

| 이름 | 역할 | 입력 | 출력 |
| --- | --- | --- | --- |
| `p2a-intake` | 아이디어를 받아 질문 목록 생성 | 한 문장 아이디어, optional resume answers | `intake_json` |
| `p2a-spec` | 답변을 제품/구현 명세로 정리 | answered intake | Markdown spec, `spec_json` |
| `p2a-task-breakdown` | 승인된 구현 명세를 task graph로 분해 | approved `spec_json` | `task_graph_json` |
| `p2a-review` | 산출물을 검토하고 수정 요청 생성 | spec, task graph | `review_json`, `review_report` |
| `p2a-harness` | 전체 흐름을 orchestration하는 상위 workflow | idea, answers, or existing artifacts | gated state artifacts |

MVP에서는 `p2a-harness`가 상위 skill이고, 나머지 skill은 단계별 재사용 단위다. subagent는 독립 검토와 전문 역할 분리를 위해 사용한다.

## 3. 오케스트레이션 계약

| Stage | Skill | Subagent owner | Input artifact | Output artifact | Gate |
| --- | --- | --- | --- | --- | --- |
| 1. Intake | `p2a-intake` | `p2a-requirements` | raw idea and notes | `intake_json` | Gate A |
| 2. Product spec | `p2a-spec` | `p2a-spec-author` | intake plus answered decisions | `product_spec_markdown`, product part of `spec_json` | Gate B |
| 3. Implementation plan | `p2a-spec` | `p2a-implementation-planner` | product spec draft plus Gate A constraints | `implementation_plan_markdown`, implementation part of `spec_json` | Gate B |
| 4. Task graph | `p2a-task-breakdown` | `p2a-task-graph` | approved `spec_json` | `task_graph_json` | Gate C |
| 5. Review | `p2a-review` | `p2a-quality-reviewer` | spec and task graph | `review_json`, `review_report` | Gate D |

If a CLI cannot spawn subagents automatically, the active model executes the same stage locally while preserving the same input/output contract.

## 4. Approval Gates

- **Gate A — Intake decisions:** If any `needs_user_decision.status` is `open` or `deferred`, stop after intake and ask only those decisions. Do not produce a product spec except as a clearly labeled sketch.
- **Gate B — Spec approval:** If any intake `CQ-n` is not disposed in `spec_json.clarifying_question_disposition`, `spec_json.approval` is not `approved`, or `spec_json.open_decisions` is non-empty, stop before task graph generation. When Gate B selects or recommends libraries, frameworks, runtimes, protocols, packages, databases, cloud services, or external APIs, perform read-only technology reconnaissance and record material sources in `spec_json.evidence`.
- **Gate C — Task graph validation:** Before final output, check that every dependency references a task id, the graph is acyclic, and every task has acceptance criteria.
- **Gate D — Review blockers:** The canonical Gate D artifact is `review_json` persisted as `gate-d-review/review.json`; `review_report` is the human-readable Markdown rendering of the same findings. Gate D passes only when `review.json.blocking_issues` is `[]`. If review finds blocking issues, return the blockers and the artifact section that must be revised instead of claiming the plan is ready. Missing Technology Reconnaissance evidence for a material Gate B technology choice is a blocking Gate B issue.

Each gate is a review checkpoint: persist the stage's artifact files, present a readable summary with per-item rationale, invite both free-form feedback and structured approval, revise and re-present on feedback, and advance only on explicit approval.

## 5. Resume Contract

- When the user answers decisions such as `ND-1` or `ND-4`, merge the answers into `intake_json.needs_user_decision[*].answer`, set those decisions to `answered`, and recompute `intake_json.status`.
- Resume from the earliest stage whose input changed. Changed intake answers invalidate spec, implementation plan, task graph, and review.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## 6. State and Schema Contract

The harness passes intermediate artifacts with these exact names:

| Artifact | Schema or format | Required next-step condition |
| --- | --- | --- |
| `intake_json` | `.plan2agent/schemas/intake.schema.json` | `status: ready_for_spec` |
| `product_spec_markdown` | Markdown | user review |
| `implementation_plan_markdown` | Markdown | user review |
| `spec_json` | `.plan2agent/schemas/spec.schema.json` | all `CQ-n` dispositions recorded, `approval: approved`, and `open_decisions: []` |
| `task_graph_json` | `.plan2agent/schemas/task-graph.schema.json` | dependency ids valid and DAG acyclic |
| `review_json` | `.plan2agent/schemas/review.schema.json` | `blocking_issues: []` |
| `review_report` | Markdown rendering of `review_json` | human review; not the Gate D decision source |

Schema validation is intentionally complemented by `scripts/validate_artifacts.mjs` and scaffold-installed `.plan2agent/scripts/validate_artifacts.mjs`, which perform gate checks that are easier to express procedurally: open/deferred decision blocking, `CQ-n` disposition coverage, spec/intake `open_decisions` traceability including promoted clarifying-question decisions, approved-spec requirement, missing dependency ids, duplicate task ids, and cycle detection.

The harness orchestrator also persists each artifact as a file under `.plan2agent/artifacts/<project_id>/` using gate-specific folders (`gate-a-intake/intake.json`, `gate-a-intake/intake.md`, `gate-b-spec/product-spec.md`, `gate-b-spec/implementation-plan.md`, `gate-b-spec/spec.json`, `gate-c-task-graph/task-graph.json`, `gate-d-review/review.json`, `gate-d-review/review-report.md`) plus top-level `status.md` as a standing progress and decision index refreshed at every gate transition, so the user can review artifacts at each gate and run `validate_artifacts.mjs` against them. In co-located scaffold projects, Gate D success is followed by `p2a_iteration.mjs init`, which moves root `gate-*` folders into `iterations/<iter-id>/gate-*` before task execution starts. Subagents remain read-only; only the orchestrator writes planning files, and neither the harness nor subagents perform git operations. `.plan2agent/` is local harness state in scaffolded application projects; planning history, run logs, and proposal artifacts are expected to be persisted through Plan2Agent Memory or explicit export rather than application source git.


## 7. Evidence and Citation Convention

Intake and spec artifacts include an `evidence` array so web-grounded or local-source-grounded decisions remain machine-consumable.

- `USER-n` identifies user-provided source material.
- `LOCAL-n` identifies repository or local artifact sources.
- `WEB-n` identifies read-only web lookup sources.
- Every `WEB-n` item must include a title, http(s) URL, and `used_for` rationale.
- If a web source materially changes a question, assumption, product decision, or integration choice, the artifact must include the source in `evidence` and refer to the source id in nearby rationale.
- Gate B technology recommendations should prefer primary sources such as official docs, release notes, standards documents, package registries, source repositories, or vendor documentation.

## 8. 기준 저장 구조

```text
.agents/skills/                 # common skill source
.agents/agents/                 # CLI-neutral canonical agent source
.claude/skills/                 # generated Claude skill mirror
.claude/agents/                 # generated Claude subagents
.codex/agents/                  # generated Codex subagents
.gemini/agents/                 # generated Gemini subagents
.gemini/commands/p2a/           # Gemini command shims
schemas/                                    # artifact JSON schemas
scripts/sync_cli_assets.mjs                 # generate CLI mirrors from canonical sources
scripts/check_cli_parity.mjs                # mirror drift check
scripts/validate_artifacts.mjs              # schema, gate, and graph validation
scripts/run_fixtures.mjs                    # fixture/golden validation
scripts/p2a_iteration.mjs                   # iteration init/open/close/maintenance CLI
scripts/p2a_tasks.mjs                       # task status and dependency management CLI
scripts/p2a_runs.mjs                        # task run log and verification tracking CLI
scripts/p2a_execute.mjs                     # supervised single-task lifecycle runner
```

구조 판단:

- v1 skill 원본은 `.agents/skills`에 둔다.
- CLI-neutral agent 원본은 `.agents/agents`에 둔다.
- `.claude/agents`, `.codex/agents`, `.gemini/agents`는 `.plan2agent/scripts/sync_cli_assets.mjs`가 생성하는 target별 산출물이다.
- Gemini CLI의 `.gemini/commands`는 skill 자체가 아니라 invocation shortcut으로만 둔다.

## 9. 공통 Skill 내용 규칙

모든 `SKILL.md`는 다음 원칙을 지킨다.

- 각 skill은 하나의 일만 한다.
- 입력과 출력 형식을 명시한다.
- 불명확하면 질문 목록을 만들고, 임의 구현을 시작하지 않는다.
- 코드 변경, shell 실행, dependency 설치는 v1 skill에서 금지한다.
- 단, 하네스 오케스트레이터는 planning 산출물(.md/.json)을 `.plan2agent/artifacts/<project_id>/`에 기록할 수 있다. 소스코드 변경·의존성 설치·shell 실행(구현)·git 조작은 여전히 금지하고 subagent는 read-only를 유지한다.
- 산출물은 Markdown과 JSON을 모두 고려하되, 내부 원본은 JSON으로 본다.
- 하네스 skill은 단계→subagent 매핑, gate, resume, state passing contract를 포함한다.


## 10. Target Renderer Mapping

`sync_cli_assets.mjs`는 `.agents/agents/*.md`의 중립 metadata를 CLI별 native agent 파일로 렌더링한다. Claude도 예외 없이 생성 대상이며, canonical 파일을 바이트 복사하지 않는다.

| Neutral metadata | Claude target | Gemini target | Codex target |
| --- | --- | --- | --- |
| `capabilities: read` | `Read` | `read_file` | per-tool list 없음 |
| `capabilities: search` | `Grep`, `Glob` | `grep_search` | per-tool list 없음 |
| `capabilities: web` | `WebSearch`, `WebFetch` | `google_web_search`, `web_fetch` | 별도 custom-agent web flag 생성 없음 |
| `access: read-only` | tool set으로 암시 | `kind: local` | `sandbox_mode = "read-only"` |
| `tier: light` | `model: haiku` | `temperature: 0.1`, `max_turns: 6` | `model_reasoning_effort = "low"` |
| `tier: standard` | `model: sonnet` | `temperature: 0.2`, `max_turns: 10` | `model_reasoning_effort = "medium"` |
| `tier: heavy` | `model: opus` | `temperature: 0.2`, `max_turns: 20` | `model_reasoning_effort = "high"` |

Gemini target fields use the documented subagent keys `kind`, `tools`, `temperature`, and `max_turns`; Gemini web capability maps to documented `google_web_search` and `web_fetch`. Codex custom agents document required `name`/`description`/`developer_instructions` plus config overrides such as `model_reasoning_effort` and `sandbox_mode`; no per-agent web-search flag is emitted.

## 11. CLI별 차이와 하네스 정책

| 항목 | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Canonical agent 원본 | `.agents/agents/*.md` | `.agents/agents/*.md` | `.agents/agents/*.md` |
| Generated project skill 경로 | `.claude/skills` | `.agents/skills` | `.agents/skills` plus command shims |
| Generated project subagent 경로 | `.claude/agents` | `.codex/agents` | `.gemini/agents` |
| Generated subagent 형식 | Markdown + YAML frontmatter | TOML | Markdown + YAML frontmatter |
| Skill 실행 | `/skill-name` 또는 자동 | `$skill-name` 언급 또는 자동 | command shim |
| 명시 subagent 호출 | agent 이름 지정 | spawn 요청 필요 | `@agent-name` 가능 |
| v1 정책 | read-only planning | read-only planning | read-only planning |

공통 정책:

- Plan2Agent v1은 세 CLI 모두에서 같은 역할 이름을 사용하되, CLI별 문법은 renderer가 생성한다.
- 각 CLI의 subagent는 read-only planning 역할로 제한한다.
- Intake/spec 단계는 prior-art 근거가 필요한 경우 read-only web lookup을 허용할 수 있다.
- 실제 코드 변경 세션은 사람이 감독하는 foreground CLI/app에서 수행하고, P2A는 task/run/orchestration 상태를 파일로 기록한다.
- skill은 workflow 재사용 단위이고, subagent는 context 격리와 전문 역할 분리를 위한 단위다.

## 12. 구현 및 고도화 순서

1. 공통 skill 원본은 `.agents/skills`에서 먼저 수정한다.
2. Claude Code mirror가 필요한 skill은 `.claude/skills`에 동일하게 반영한다.
3. subagent 역할 변경은 `.codex/agents`, `.claude/agents`, `.gemini/agents`에 같은 역할명으로 반영한다.
4. Gemini CLI shortcut 변경은 `.gemini/commands/p2a/*.toml`에 반영한다.
5. Schema 변경은 `schemas/*.schema.json`과 `scripts/validate_artifacts.mjs`에 반영한다.
6. CLI agent mirror는 canonical `.agents/agents` sources에서 `scripts/sync_cli_assets.mjs`의 target renderer로 생성하고 `scripts/check_cli_parity.mjs`로 검증한다.
7. Fixture/golden output은 `fixtures/<name>/`에 추가하고 `scripts/run_fixtures.mjs`로 검증한다.
8. Gate D 이후 co-located scaffold는 `p2a_iteration.mjs init`으로 반복 구조를 만든 뒤 `p2a_tasks.mjs --artifacts`로 task 상태와 의존성을 관리한다.
9. 각 CLI에서 "idea -> intake -> spec -> task graph -> review" 흐름을 read-only로 수동 검증한다.

## 13. 산출물 Acceptance Criteria

하네스 scaffold는 다음을 만족해야 한다.

- 세 CLI 모두 같은 Plan2Agent role 이름을 가진다.
- 세 CLI 모두 `p2a-harness`에 해당하는 상위 workflow를 가진다.
- `p2a-harness`는 단계별 subagent mapping, approval gate, resume rule, state passing contract를 명시한다.
- 세 CLI 모두 task graph 생성 전 사용자 결정이 필요한 항목을 `needs_user_decision`으로 남긴다.
- 어떤 skill이나 subagent도 v1에서 코드 변경을 지시하지 않는다.
- `intake_json`, `spec_json`, `task_graph_json`은 schema 파일을 가진다.
- task graph는 최소 필드 `id`, `title`, `description`, `dependencies`, `acceptanceCriteria`, `targetArea`, `suggestedAgentPrompt`, `sourceSpecRefs`를 가진다.
- validation script가 schema subset, dependency id, duplicate id, cycle, unresolved decision gate, `CQ-n` disposition coverage, spec/intake decision traceability를 검사한다.
- fixture/golden output이 intake blocked, intake answered, approved spec, task graph, review report path를 포함한다.
- CLI mirror 생성 스크립트가 CLI-중립 canonical `.agents/agents` source에서 Claude/Codex/Gemini target을 재생성한다.

## 14. 현재 보완 필요 항목

- 완료: fixture coverage를 cache library 외 API/integration domain으로 확장했다(`fixtures/webhook-api-service`).
- 완료: draft/negative fixture coverage를 추가해 unresolved promoted decision, promoted decision의 `open_decisions` 누락 실패, Gate D blocker 실패 흐름을 고정했다(`fixtures/_negative`).
- 완료: end-to-end artifact-root golden fixture를 추가해 `--artifact-root --require-handoff-ready` 검증을 고정했다(`fixtures/_e2e/webhook-api-service`).
- 완료: Gate B 승인 audit log를 `status.md`에 기록하고 validator가 확인하도록 했다.
- 완료: Python stdlib scripts를 Node.js ESM scripts로 대체하고 `.plan2agent/scripts/check_cli_parity.mjs`, `.plan2agent/scripts/run_fixtures.mjs`, `.plan2agent/.plan2agent/scripts/validate_artifacts.mjs` 검증 경로를 확정했다.
- 완료: task 상태와 의존성 관리는 `.plan2agent/scripts/p2a_tasks.mjs`로 제공한다.
- CLI mirror drift check와 fixture runner의 CI 연결은 사용자 관리 항목으로 둔다.
- 완료: `p2a_runs.mjs`로 파일 기반 agent 실행 로그, branch/worktree 격리 기준, changed files, verification 결과를 기록한다. PTY 기반 agent 자동 실행과 PR 생성은 후속이다.
- 완료: `p2a_execute.mjs`로 ready task 1건의 plan/start/finish/status를 묶는 Phase 1 감독형 실행기를 제공한다. Codex/Claude 구현 세션 자체는 foreground 감독형으로 유지한다.

## 15. 공식 레퍼런스

- Claude Code Skills: https://code.claude.com/docs/en/skills
- Claude Code Subagents: https://code.claude.com/docs/en/sub-agents
- Codex Skills: https://developers.openai.com/codex/skills
- Codex Subagents: https://developers.openai.com/codex/subagents
- Gemini CLI Skills: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md
- Gemini CLI Subagents: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md
- Gemini CLI Custom Commands: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md
- Gemini CLI Reference: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md
