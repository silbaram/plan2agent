# Plan2Agent 하네스 구현 기준

참고 기준일: 2026-08-05

이 문서는 현재 Plan2Agent 하네스의 구현 기준이다. Claude Code, Codex, Gemini CLI에서 같은 역할과 절차를 제공하기 위해 skill, subagent, command scaffold의 경로, 역할, 안전 정책, 승인 게이트, 결정 원장, 재개 규칙, 검증 기준을 정의한다.

문서 홈: [Plan2Agent Docs](README.md) · 사용자 시작점: [Quickstart](quickstart.md)

Plan2Agent의 핵심 가치는 기획 변경이 개발 가능한 명세와 task로 연결되고, 그 과정이 시맨틱 문서로 남는 순환 시스템을 만드는 것이다. 이 하네스는 그 순환 중 "아이디어를 명세와 task graph로 바꾸는 단계"를 먼저 고정한다.

## 1. 하네스 목표

하네스는 실제 코드 변경을 무인 자동 실행하지 않는다. 대신 세 가지 CLI agent가 공통으로 사용할 수 있는 기획/분해 절차와 foreground 감독형 실행 계약을 제공한다.

현재 책임:

- 사용자가 제공한 간결한 entry document를 검증하고 제품 범위로 구조화한다.
- 문서에서 안전하게 추론할 수 없는 중요한 항목만 `clarifying_questions`와 `needs_user_decision` ledger에 기록한다.
- compact Gate A 이해 요약을 명시적으로 확인받은 뒤 Gate B를 이어간다.
- Gate ①·② 승인, 철회, 범위·헌법 변경을 append-only `decisions.jsonl`에 기록하고 기존 `approval_audit`은 호환 사본으로 유지한다.
- 승인 게이트를 지켜 제품 명세와 구현 명세를 생성한다.
- 구현 가능한 task graph로 분해한다.
- task별 agent 실행 prompt 초안을 만든다.
- task graph validator로 누락, 과대 task, 의존성 오류, gate 위반을 찾는다.
- 반복 구조에서 semantic diff task 초안과 파일 기반 실행 로그를 관리한다.
- CLI별 mirror drift를 검사한다.

현재 제외:

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
| `p2a-spec-author` | answered intake를 제품 명세와 `spec_json.product`로 변환 | read-only, optional web lookup |
| `p2a-implementation-planner` | 승인 가능한 제품 명세를 구현 계획과 `spec_json.implementation`으로 변환 | read-only, optional web lookup |
| `p2a-visual-designer` | screen composition contract에서 offline HTML prototype 후보를 생성 | read-only |
| `p2a-task-graph` | 승인된 구현 계획을 agent 실행 가능한 `task_graph_json`으로 분해 | read-only |
| `p2a-visual-reviewer` | 실제 앱 렌더링을 승인된 experience/prototype과 비교해 UI 완료를 판정 | read-only |

### Skills

| 이름 | 역할 | 입력 | 출력 |
| --- | --- | --- | --- |
| `p2a-spec` | 답변을 제품/구현 명세로 정리 | answered intake | `spec_json` |
| `p2a-visual-experience` | 화면 구성과 offline HTML 후보를 만들고 사람 선택을 Gate B에 기록 | `full + current_iteration` Gate B draft | `experience-spec.json`, candidate manifests/files |
| `p2a-task-breakdown` | 승인된 구현 명세를 task graph로 분해 | approved `spec_json` | `task_graph_json` |
| `p2a-harness` | 전체 흐름을 orchestration하는 상위 workflow | entry document or existing artifacts | gated state artifacts |

MVP에서는 `p2a-harness`가 상위 skill이고, 나머지 skill은 단계별 재사용 단위다. subagent는 독립 검토와 전문 역할 분리를 위해 사용한다.

### Codex GPT-5.6 품질 프로필

Codex에서는 메인 오케스트레이터를 사용자 또는 세션 설정의 `gpt-5.6-sol` + `ultra`로 실행하고, 생성된 역할별 leaf agent는 자동 재위임이 중첩되지 않도록 `ultra`를 사용하지 않는다. CLI-neutral `tier`는 Codex mirror에서 다음과 같이 변환한다.

| tier | Codex model | reasoning effort | 용도 |
| --- | --- | --- | --- |
| `heavy` | `gpt-5.6-sol` | `max` | 요구사항, 명세, 구현 계획, 품질 검토, task draft, 코드 구현 |
| `standard` | `gpt-5.6-sol` | `high` | task graph, milestone/완료 검토, 개선안 검토 |
| `light` | `gpt-5.6-sol` | `medium` | 비차단 스타일 판정 |

`ultra`는 메인 오케스트레이터에만 두고 subagent nesting은 기본 `max_depth = 1` 경계를 유지한다. scaffold/handoff의 기본 `--codex-profile quality`는 위 설정을 설치하고 manifest에 기록한다. 모델 접근 권한, 외부 provider, 구형 Codex 호환성이 필요한 배포는 `--codex-profile inherit`을 사용해 agent TOML의 `model`과 `model_reasoning_effort`를 생략하고 부모 세션 설정을 상속한다. update/upgrade는 manifest에 기록된 프로필을 유지한다.

## 3. 오케스트레이션 계약

| Stage | Skill | Subagent owner | Input artifact | Output artifact | Gate |
| --- | --- | --- | --- | --- | --- |
| 1. Scope + Intake | `p2a-harness` | orchestrator | validated entry document and optional baseline context | `intake_json` | Gate A |
| 2. Product spec | `p2a-spec` | `p2a-spec-author` | intake plus answered decisions | product part of `spec_json` | Gate B |
| 3. Implementation plan | `p2a-spec` | `p2a-implementation-planner` | product spec draft plus Gate A constraints | implementation part of `spec_json` | Gate B |
| 3.5 Visual experience (conditional) | `p2a-visual-experience` | `p2a-visual-designer` | `full + current_iteration` Gate B draft | approved experience + offline HTML prototype | Gate B |
| 4. Task graph | `p2a-task-breakdown` | `p2a-task-graph` | approved `spec_json` | `task_graph_json` | Gate C |

If a CLI cannot spawn subagents automatically, the active model executes the same stage locally while preserving the same input/output contract.

## 4. Approval Gates와 결정 원장

Gate A/②/B/C의 상세 통과·차단 규칙은 `p2a-harness` skill이 유일한 정본이다. 정본: [`.agents/skills/p2a-harness/SKILL.md`](../.agents/skills/p2a-harness/SKILL.md#approval-gates).

- **Gate A:** entry document에서 범위, 사용자, 결과, 제약, 제외 항목을 정리해 compact 이해 요약을 제시한다. 사용자의 실제 발화를 받은 `p2a decide --quote ...`가 Gate ① 결정을 원장에 append하고 `intake.approval_audit` 사본을 기록하기 전에는 Gate B로 넘어가지 않는다.
- **Gate ②:** 신규 project constitution은 `p2a shape approve --quote ...`로 승인한다. 승인·철회와 내용 변경 재승인은 같은 결정 원장에 append하며 정상 feature/maintenance 반복에서는 기존 승인을 재사용한다.
- **Gate B:** 모든 open decision 해소, `CQ-n` disposition, 필요한 기술 조사 근거를 갖춘 spec을 사용자에게 검토받고 `p2a decide --quote ...`로 승인해야 task graph로 넘어간다. `full + current_iteration`이면 사용자가 선택·승인한 hash-bound offline HTML prototype과 experience contract도 필요하다.
- **Gate C:** Task graph의 dependency, cycle, acceptance criteria, source spec reference를 검증한다. Validator를 통과한 draft는 별도 사람 승인 audit 없이 정본으로 승격할 수 있다.

`.plan2agent/artifacts/<project_id>/decisions.jsonl`이 존재하면 승인·철회 상태의 정본은 원장이다. `approval_audit`은 schema 호환과 사람이 읽기 쉬운 사본으로 남기되 상태 판단의 폴백으로 사용하지 않는다. 원장이 전혀 없는 기존 프로젝트만 audit 사본으로 폴백한다. Task 분해, run 시작·종료, validator 실행 상세, agent 내부 판단은 원장 이벤트가 아니다.

이 구현 기준 문서는 skill/subagent 계약과 저장소 검증 맥락만 설명하며, 게이트 규칙 전문은 위 정본을 수정한 뒤 CLI mirror를 동기화한다.

## 5. Resume Contract

- Resume from canonical JSON and continue at the earliest incomplete or invalid stage.
- Keep `status: blocked_on_user` while a material `CQ-n` or `ND-n` remains unresolved or scope approval is absent. After explicit approval, use `p2a decide --quote ...` to append the decision, record the `approval_audit` copy, and set `status: ready_for_spec`.
- If `decisions.jsonl` exists but fails schema, sequence, hash-chain, or `prev_seq` validation, stop before using audit copies and recover with `p2a validate --decisions --artifacts <root>`.
- Treat questions and decisions as ledger entries rather than conversational workflow states. Preserve any legacy `interview` object as opaque compatibility data without interpreting or generating it.
- Do not generate `gate-a-intake/intake.md` during normal resume. Create it only for an explicit Markdown export request, prefix it with `<!-- plan2agent:intake-md-export=explicit -->`, and regenerate a marked export from canonical JSON.
- Preserve the iterative `baseline_context.spec_ref`/`spec_sha256`, reuse relevant answers and dispositions with provenance, and record current-iteration overrides instead of mutating baseline records.
- A changed intake invalidates the spec, implementation plan, and task graph. Resume from the earliest affected artifact.
- Carry forward stable artifact ids (`project_id`, `source_intake`, `sourceSpec`) so later stages can trace their source. Generated Gate B artifacts record `source_intake_sha256` for the exact persisted Gate A bytes.
- If an artifact is pasted in Markdown only, reconstruct the matching JSON contract before advancing to the next gate.

## 6. State and Schema Contract

The harness passes intermediate artifacts with these exact names:

| Artifact | Schema or format | Required next-step condition |
| --- | --- | --- |
| `decisions_jsonl` | line-delimited `decisions.schema.json` entries | monotonic `seq`, valid `prev_sha256` chain, and valid active approval/revocation lineage |
| `intake_json` | `p2a` package schema `intake.schema.json` | no unresolved questions/decisions, Gate A `approval_audit`, and `status: ready_for_spec` |
| `spec_json` | `p2a` package schema `spec.schema.json` | all `CQ-n` dispositions recorded, `approval: approved`, `approval_audit` present, and `open_decisions: []` |
| `task_graph_json` | `p2a` package schema `task-graph.schema.json` | dependency ids valid and DAG acyclic |
| Optional Markdown views | Generated from JSON | human review/export only; `intake.md` requires an explicit export request and marker; not gate decision sources |

Schema validation is intentionally complemented by `scripts/validate_artifacts.mjs` and scaffold-installed `p2a validate`, which perform gate checks that are easier to express procedurally: decision sequence/hash-chain/lineage validation, Gate A approval audit enforcement, open/deferred decision blocking, `CQ-n` disposition coverage, spec/intake `open_decisions` traceability including promoted clarifying-question decisions, approved-spec requirement, missing dependency ids, duplicate task ids, and cycle detection.

The harness orchestrator persists canonical JSON artifacts under `.plan2agent/artifacts/<project_id>/` using gate-specific folders (`gate-a-intake/intake.json`, `gate-b-spec/spec.json`, `gate-c-task-graph/task-graph.json`) and keeps the append-only approval history in sibling `decisions.jsonl`. Markdown files such as `status.md`, `product-spec.md`, and `implementation-plan.md` are optional generated views for human review/export, not sources of truth. `intake.md` is stricter: the orchestrator creates it only after an explicit Markdown export request and marks its first line so legacy automatic views can be discarded. Optional Feature Radar exports live under `preflight-research/`; they are read-only input evidence, not gate state. In a project initialized by `p2a init`, Gate A-C validation is followed by `p2a iteration init`, which moves root `gate-*` folders into `iterations/<iter-id>/gate-*` before task execution starts and atomically appends approval bindings for the relocated Gate artifacts. If that append fails, the artifact move, generated current state, and ledger bytes are rolled back together. Subagents remain read-only; only the orchestrator writes planning files, and neither the harness nor subagents perform git operations. `.plan2agent/` is local harness state in application projects; runtime commands and schemas are supplied by the installed package, while planning history, run logs, and proposal artifacts are expected to be persisted through Plan2Agent Memory or explicit export rather than application source git.


## 7. Evidence and Citation Convention

Intake and spec artifacts include an `evidence` array so web-grounded or local-source-grounded decisions remain machine-consumable.

- `USER-n` identifies user-provided source material.
- `LOCAL-n` identifies repository or local artifact sources.
- `WEB-n` identifies read-only web lookup sources.
- Every `WEB-n` item must include a title, http(s) URL, and `used_for` rationale.
- If a web source materially changes a question, assumption, product decision, or integration choice, the artifact must include the source in `evidence` and refer to the source id in nearby rationale.
- Gate B technology recommendations should prefer primary sources such as official docs, release notes, standards documents, package registries, source repositories, or vendor documentation.
- If Gate B compares concrete reusable technologies, local code patterns, prior artifacts, or external implementation approaches, record the comparison in optional `spec_json.reference_reconnaissance`. Each `REF-n` candidate points to an existing `evidence[].source_id`, records a decision (`selected`, `rejected`, `deferred`, `context`, or `open`), and may include an `origin` value for adapter provenance; selected and rejected patterns point back to those candidates so source metadata stays separate from decision rationale.
- Feature Radar preflight research under `.plan2agent/artifacts/<project_id>/preflight-research/` is mapped into this same model: Radar files become `LOCAL-n`, discovered source URLs become `WEB-n`, and recommendations become `reference_reconnaissance.candidates` with `decision: "context"` and `origin: "feature_radar_preflight"` until Gate B explicitly changes them to `selected`, `rejected`, or `deferred`.

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
scripts/p2a_tool_manifest.mjs              # repo/runtime script and schema manifest
scripts/p2a_decision_ledger.mjs            # decision ledger append, locking, authority helpers
scripts/p2a_decisions.mjs                  # p2a decide/decisions record and lineage query CLI
scripts/p2a_doctor.mjs                     # scaffold target doctor, repo-only
scripts/p2a_handoff.mjs                    # scaffold/handoff installer, repo-only
scripts/sync_cli_assets.mjs                 # generate CLI mirrors from canonical sources
scripts/check_cli_parity.mjs                # mirror drift check
scripts/validate_artifacts.mjs              # schema, gate, and graph validation
scripts/run_fixtures.mjs                    # fixture/golden validation
scripts/p2a_paths.mjs                       # relocatable runtime path helpers
scripts/p2a_iteration.mjs                   # iteration init/open/close/maintenance CLI
scripts/p2a_tasks.mjs                       # task status and dependency management CLI
scripts/p2a_project_config.mjs              # project command detection and config merge helper
scripts/p2a_runs.mjs                        # task run log and verification tracking CLI
scripts/p2a_execute.mjs                     # supervised single-task lifecycle primitive
scripts/p2a_monitor_gate.mjs                 # supervised orchestration CLI
scripts/p2a_proposals.mjs                   # proposal mining/review/curation CLI
scripts/p2a_radar_preflight.mjs             # Feature Radar preflight discovery/adapter helper
scripts/p2a_run_paths.mjs                   # run directory resolution helper
scripts/p2a_iteration_state.mjs             # active iteration resolution helper
```

구조 판단:

- canonical skill 원본은 `.agents/skills`에 둔다.
- CLI-neutral agent 원본은 `.agents/agents`에 둔다.
- `.claude/agents`, `.codex/agents`, `.gemini/agents`는 Plan2Agent 본체의 `scripts/sync_cli_assets.mjs`가 생성하는 target별 산출물이다.
- Gemini CLI의 `.gemini/commands`는 skill 자체가 아니라 invocation shortcut으로만 둔다.

## 9. 공통 Skill 내용 규칙

모든 `SKILL.md`는 다음 원칙을 지킨다.

- 각 skill은 하나의 일만 한다.
- 입력과 출력 형식을 명시한다.
- 불명확하면 질문 목록을 만들고, 임의 구현을 시작하지 않는다.
- planning skill과 planning subagent는 코드 변경, 구현 shell 실행, dependency 설치를 하지 않는다. 실제 구현은 `p2a-dev-execution`의 별도 실행 계약을 따른다.
- 단, 하네스 오케스트레이터는 planning 산출물(.md/.json)을 `.plan2agent/artifacts/<project_id>/`에 기록할 수 있다. 소스코드 변경·의존성 설치·shell 실행(구현)·git 조작은 여전히 금지하고 subagent는 read-only를 유지한다.
- 산출물은 Markdown과 JSON을 모두 고려하되, 내부 원본은 JSON으로 본다.
- 하네스 skill은 단계→subagent 매핑, gate, resume, state passing contract를 포함한다.


## 10. Target Renderer Mapping

`sync_cli_assets.mjs`는 `.agents/agents/*.md`의 중립 metadata를 CLI별 native agent 파일로 렌더링한다. Claude도 예외 없이 생성 대상이며, canonical 파일을 바이트 복사하지 않는다.

| Neutral metadata | Claude target | Gemini target | Codex target |
| --- | --- | --- | --- |
| `capabilities: read` | `Read` | `read_file` | per-tool list 없음 |
| `capabilities: search` | `Grep`, `Glob` | `grep_search` | per-tool list 없음 |
| `capabilities: web` | `WebSearch`, `WebFetch` | `google_web_search`, `web_fetch` | `web_search = "live"` |
| `access: read-only` | tool set으로 암시 | `kind: local` | `sandbox_mode = "read-only"` |
| `tier: light` | `model: haiku` | `temperature: 0.1`, `max_turns: 6` | `model = "gpt-5.6-sol"`, `model_reasoning_effort = "medium"` |
| `tier: standard` | `model: sonnet` | `temperature: 0.2`, `max_turns: 10` | `model = "gpt-5.6-sol"`, `model_reasoning_effort = "high"` |
| `tier: heavy` | `model: opus` | `temperature: 0.2`, `max_turns: 20` | `model = "gpt-5.6-sol"`, `model_reasoning_effort = "max"` |

Gemini target fields use the documented subagent keys `kind`, `tools`, `temperature`, and `max_turns`; Gemini web capability maps to documented `google_web_search` and `web_fetch`. Codex custom agents use required `name`/`description`/`developer_instructions` plus normal session overrides such as `model`, `model_reasoning_effort`, `web_search`, and `sandbox_mode`. Neutral `web` roles alone receive `web_search = "live"`; other roles inherit the parent web-search mode.

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

- Plan2Agent는 세 CLI 모두에서 같은 역할 이름을 사용하되, CLI별 문법은 renderer가 생성한다.
- 각 CLI의 subagent는 read-only planning 역할로 제한한다.
- Intake/spec 단계는 prior-art 근거가 필요한 경우 read-only web lookup을 허용할 수 있다.
- 실제 코드 변경 세션은 사람이 감독하는 foreground CLI/app에서 수행하고, P2A는 task/run/orchestration 상태를 파일로 기록한다. 같은 ready snapshot의 bounded batch도 task별 단건 run을 유지하며 main owner가 start·로컬 통합·검증·finish를 직렬 소유한다.
- skill은 workflow 재사용 단위이고, subagent는 context 격리와 전문 역할 분리를 위한 단위다.

## 12. 구현 및 고도화 순서

1. 공통 skill 원본은 `.agents/skills`에서 먼저 수정한다.
2. Claude Code mirror가 필요한 skill은 `.claude/skills`에 동일하게 반영한다.
3. subagent 역할 변경은 `.codex/agents`, `.claude/agents`, `.gemini/agents`에 같은 역할명으로 반영한다.
4. Gemini CLI shortcut 변경은 `.gemini/commands/p2a/*.toml`에 반영한다.
5. Schema 변경은 `schemas/*.schema.json`과 `scripts/validate_artifacts.mjs`에 반영한다. 결정 이벤트를 바꾸면 `decisions.schema.json`, 원장 append/authority helper, CLI와 회귀 테스트를 함께 수정한다.
6. CLI agent mirror는 canonical `.agents/agents` sources에서 `scripts/sync_cli_assets.mjs`의 target renderer로 생성하고 `scripts/check_cli_parity.mjs`로 검증한다.
7. Fixture/golden output은 `fixtures/<name>/`에 추가하고 `scripts/run_fixtures.mjs`로 검증한다.
8. Gate A-C validation 이후 `p2a init` 프로젝트는 `p2a iteration init`으로 반복 구조를 만든 뒤 `p2a tasks --artifacts`로 task 상태와 의존성을 관리한다.
9. 각 CLI에서 "idea -> intake -> spec -> task graph" 흐름을 read-only로 수동 검증한다.

## 13. 산출물 Acceptance Criteria

하네스 scaffold는 다음을 만족해야 한다.

- 세 CLI 모두 같은 Plan2Agent role 이름을 가진다.
- 세 CLI 모두 `p2a-harness`에 해당하는 상위 workflow와 conditional `p2a-visual-experience` workflow를 가진다.
- `p2a-harness`는 단계별 subagent mapping, approval gate, resume rule, state passing contract를 명시한다.
- 세 CLI 모두 task graph 생성 전 사용자 결정이 필요한 항목을 `needs_user_decision`으로 남긴다.
- planning skill과 planning subagent는 코드 변경을 지시하지 않으며, 구현은 `p2a-dev-execution` 경계에서만 수행한다.
- `intake_json`, `spec_json`, `task_graph_json`, visual experience/prototype/review artifact는 schema 파일을 가진다.
- `decisions.jsonl`은 줄별 schema, 단조 `seq`, `prev_sha256` 체인과 active `prev_seq` 계보가 검증되며 기존 항목을 수정·삭제하지 않는다.
- Gate ①② 승인 명령은 사용자의 비어 있지 않은 실제 발화를 요구하고 원장과 `approval_audit` 사본을 하나의 실패 원복 경계에서 갱신한다.
- 원장이 존재하면 `p2a next`와 shape 상태 계산은 원장을 독점적인 승인 정본으로 사용하며, 원장이 없는 legacy 프로젝트만 audit 사본으로 폴백한다.
- task graph는 최소 필드 `id`, `title`, `description`, `dependencies`, `acceptanceCriteria`, `targetArea`, `suggestedAgentPrompt`, `sourceSpecRefs`를 가진다.
- validation script가 schema subset, dependency id, duplicate id, cycle, unresolved decision gate, `CQ-n` disposition coverage, spec/intake decision traceability, visual experience/prototype hash와 UI review coverage를 검사한다.
- fixture/golden output이 intake blocked, intake answered, approved spec, task graph를 포함한다.
- CLI mirror 생성 스크립트가 CLI-중립 canonical `.agents/agents` source에서 Claude/Codex/Gemini target을 재생성한다.

## 14. 현재 보완 필요 항목

- 완료: fixture coverage를 cache library 외 API/integration domain으로 확장했다(`fixtures/webhook-api-service`).
- 완료: draft/negative fixture coverage를 추가해 unresolved promoted decision과 promoted decision의 `open_decisions` 누락 실패 흐름을 고정했다(`fixtures/_negative`).
- 완료: end-to-end artifact-root golden fixture를 추가해 `--artifact-root --require-handoff-ready` 검증을 고정했다(`fixtures/_e2e/webhook-api-service`).
- 완료: Gate B 승인 audit log를 `spec_json.approval_audit`에 기록하고 validator가 확인하도록 했다.
- 완료: Gate ①② 승인·철회, 헌법 변경, 범위 추가·제거를 append-only `decisions.jsonl`에 기록하고 `p2a decide`, `p2a decisions`, `p2a decisions --why`, `p2a validate --decisions`를 제공한다.
- 완료: Gate C는 사람 승인 audit 없이 validator 통과만으로 정본 승격하며, legacy Gate D review 파일은 promotion, iteration init, handoff, close readiness 조건에서 제거했다.
- 완료: Python stdlib scripts를 Node.js ESM scripts로 대체하고, 본체 전용 `scripts/check_cli_parity.mjs`/`scripts/run_fixtures.mjs`와 scaffold-installed `p2a validate` 검증 경로를 확정했다.
- 완료: task 상태와 의존성 관리는 `p2a tasks`로 제공한다.
- CLI mirror drift check와 fixture runner의 CI 연결은 사용자 관리 항목으로 둔다.
- 완료: `p2a runs`로 파일 기반 agent 실행 로그, branch/worktree 격리 기준, changed files, verification 결과를 기록한다. PTY 기반 agent 자동 실행과 PR 생성은 후속이다.
- 완료: `p2a execute`로 ready task 1건의 plan/start/finish/status를 묶는 Phase 1 감독형 실행기를 제공한다. Codex/Claude 구현 세션 자체는 foreground 감독형으로 유지한다.
- 완료: `p2a-dev-execution`이 한 ready snapshot에서 독립 task의 직렬 start, 격리 worktree 병렬 구현, canonical integration branch로의 직렬 로컬 통합·검증·finish를 조율한다. 신규 batch CLI, headless scheduler, mixed-provider write, 자동 충돌 해결, remote merge는 포함하지 않는다.

## 15. 공식 레퍼런스

- Claude Code Skills: https://code.claude.com/docs/en/skills
- Claude Code Subagents: https://code.claude.com/docs/en/sub-agents
- Codex Skills: https://developers.openai.com/codex/skills
- Codex Subagents: https://developers.openai.com/codex/subagents
- Gemini CLI Skills: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md
- Gemini CLI Subagents: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md
- Gemini CLI Custom Commands: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md
- Gemini CLI Reference: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md
