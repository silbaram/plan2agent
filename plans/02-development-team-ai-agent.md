# 개발팀 AI agent 개발 계획

작성일: 2026-06-16 · 갱신일: 2026-06-25 · 상태: Level 1 완료, Codex 실행 계층 부분 구현, 자가 발전 첫 사이클 적용, Claude 자율 confinement 구현(deny+hook+macOS sandbox, Level 2 step 2), 실패 분류(C-①) 완료, 감독형 단일 task 실행기 Phase 1 완료, `p2a-dev-orchestrator` MVP 1차와 오케스트레이션 runtime 1단계/감독형 scheduler 2단계 완료, Hermes proposal queue/review/curation/patch draft/approval execution bridge 완료, PTY+Electron 감독 GUI MVP 완료, provider-native team orchestration 후속 방향 확정, 실행기는 감독형 방향(구독 로그인 foreground 사용, API 기반 완전 자동은 비용상 보류)

Plan2Agent의 Gate A-D planning harness 다음 단계로, **승인된 task를 실제 코드 변경·검증까지 수행하는 개발 실행 계층**을 구성하는 계획서다. 이 문서는 현재 코드 상태를 기준으로 완료된 범위, 남은 범위, 안전 경계, 다음 개발 순서를 고정한다.

## 0. 현재 결론

현재 저장소는 "기획 산출물 생성 -> task graph 관리 -> 반복 구조 -> handoff/scaffold -> run log 기록 -> 감독형 단일 task 실행 절차 -> 감독형 오케스트레이션 계획/runtime sidecar -> 감독형 role scheduler -> 실행 회고 proposal queue/review/curation/patch draft/approval -> 승인 항목의 감독형 실행 연결 -> PTY+Electron 감독 GUI MVP"까지 구현되어 있다.

자동 multi-session scheduler나 PR 생성기는 아직 없다. 대신 **Codex(native sandbox)·Claude(deterministic confinement) write-capable implementer**와, **CLI 공통으로 동작하는 독립 monitor·skill curator(둘 다 read-only)·retrospective proposal schema/queue/review/curation/patch draft/approval gate**, ready task 1건의 `plan/start/finish/status` lifecycle을 묶는 `p2a_execute.mjs` Phase 1 실행기, `solo`/`solo_monitor`/`team` 실행 계획과 `orchestration-runtime` sidecar 및 `next-role/role-prompt/mark-role` 감독형 scheduler를 제공하는 `p2a_orchestrate.mjs` MVP, run failure/monitor verdict/verification gap을 proposal로 남기고 deterministic review/curation/patch-draft/approval artifact와 maintenance task를 만드는 `p2a_proposals.mjs` MVP, approval artifact를 `p2a_execute --approval`로 감독형 실행에 연결하는 bridge, PTY session/start-finish lifecycle을 제공하는 `apps/p2a-gui` MVP까지 들어와 있다. Claude confinement은 scaffold가 설치하는 공통 deny-rules + cross-platform PreToolUse hook(symlink/junction 우회까지 canonicalize로 차단, fail-closed)에 macOS/Linux는 OS sandbox 토글을 더한 형태다. API 요금제 기반 완전 자동 개발은 비용상 보류하며, 구독 로그인 기반 Codex/Claude/Gemini 사용은 foreground 공식 CLI/앱을 사람이 승인·감독하는 방식으로 제한한다. 다음 team 고도화는 여러 회사를 한 번에 섞는 터미널 조율이 아니라 provider-native team orchestration으로 진행한다. Gemini implementer는 설계상 read-only로 고정한다(자율/write 미추진 결정, LD-8). GUI MVP 범위는 `plans/03-p2a-gui-mvp.md`에서 관리한다.

현재 상태 요약:

| 축 | 상태 | 구현 |
| --- | --- | --- |
| Planning harness | 완료 | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Task/runtime tracking | 완료 | `p2a_tasks.mjs`, `p2a_runs.mjs`, `run.schema.json`, `run-index.schema.json` |
| Supervised single-task runner | Phase 1 완료 | `p2a_execute.mjs plan/start/finish/status`, `--approval` maintenance 실행 연결 |
| Supervised orchestration planner/runtime | MVP 1차 + runtime 1단계 + supervised scheduler 2단계 완료 | `p2a_orchestrate.mjs`, `orchestration-plan.schema.json`, `orchestration-runtime.schema.json`, `next-role/role-prompt/mark-role`, `p2a_execute --orchestration-plan`, `runs/<runId>.orchestration*.json` |
| Handoff/scaffold | 완료 | `p2a_handoff.mjs scaffold`, legacy handoff, Team Big Five adapter 설치 |
| Supervised GUI | MVP 완료 | `apps/p2a-gui` Electron Forge + React + TypeScript 앱. 프로젝트 로딩, task/run/artifact 표시, PTY 세션, start/finish lifecycle, 한글/영문 UI |
| Dev execution skill | 완료 | `.agents/skills/p2a-dev-execution/SKILL.md` 및 Claude mirror, Gemini command |
| Codex implementer | 구현됨 | `.agents/agents/p2a-implementer.md`, Codex mirror는 `sandbox_mode = "workspace-write"` |
| Claude implementer | confinement 구현 | mirror에 `Edit`/`Write`/`Bash` 부여 + scaffold가 deny-rules·PreToolUse hook(symlink-safe)·macOS/Linux OS sandbox 설치 (Level 2 step 2, blocker fix #56). 무인 자율 전환은 비용/계정 정책과 cross-OS spike 후 별도 결정, 그 전까진 foreground |
| Gemini implementer | read-only (설계 고정) | mirror는 생성되나 write tool 미부여(read/search). 자율/write 모드 미추진 결정(LD-8) — 계획/리뷰 전용 read-only CLI |
| Independent monitor | 계약 구현 | `p2a-performance-monitor` read-only verifier |
| Skill evolution | proposal queue/review/curation/patch draft/approval execution bridge 완료 | `p2a-skill-curator`, `schemas/skill-proposal.schema.json`, `schemas/proposal-review.schema.json`, `schemas/proposal-curation.schema.json`, `schemas/proposal-patch-draft.schema.json`, `schemas/proposal-draft-approval.schema.json`, `p2a_proposals.mjs`, `p2a_execute --approval` |
| Agent 감독 실행 | 부분 구현 | Phase 1 CLI semi-auto, supervised orchestration plan, GUI PTY 감독 실행 완료. provider-native team runner adapter, retry 보조, PR 연동은 후속 |

검증 기준:

- `node scripts/check_cli_parity.mjs` green
- `node scripts/run_fixtures.mjs` green
- `node --check scripts/*.mjs` 계열 문법 검사 green

## 1. 기본 컨셉

개발 실행 계층은 두 외부 레포의 **운영 패턴(코드 아님)** 을 차용한다. 상세·라이선스는 §12.

- **개발팀 컨셉 - Team Big Five**: 복잡한 task를 `team-lead`/`contributor`/`performance-monitor` 역할로 협업·교차검증한다. 현재 P2A에는 Team Big Five adapter 설치, `p2a-performance-monitor`, `p2a-dev-orchestrator` MVP 1차, deterministic solo/team triage, runtime shared mental model, communication log, supervised role scheduler가 들어와 있다. 후속은 자동 role/monitor 호출이 아니라, provider capability matrix와 provider-native team runner adapter다. 기본은 single-provider team이며 Claude는 native agent teams/subagents, Codex는 skills/custom agents/명시 subagent prompt, Gemini는 planning/review/monitor read-only 보조로 둔다.
- **자가 발전 컨셉 - Hermes**: 실행 경험에서 agent·skill 개선 후보를 축적한다. P2A는 자동 self-modify를 금지하고, `skill-proposal` JSON을 남긴 뒤 사람 승인 후 별도 turn에서 적용한다.

## 2. 현재 상태

이미 준비된 것:

- Gate A-D planning harness.
- `p2a_tasks.mjs`: `ready`/`prompt`/`start`/`done`/`block`, `--artifacts` active iteration 자동 인식, `--maintenance` lane 지원.
- `p2a_runs.mjs`: `start`/`record`/`verify`/`finish`/`list`/`show`/`validate`, `changedFiles`, verification, branch/worktree 격리 기록, `--create-isolation` 선택 생성.
- `p2a_execute.mjs`: ready task 1건의 `plan`/`start`/`finish`/`status`를 기존 `p2a_tasks`/`p2a_runs` 위에서 묶는 Phase 1 감독형 실행기. `start`는 run 생성 후 task를 `in_progress`로 전이하고 manual launcher prompt를 출력한다. `finish`는 verification, run finish, task `done`/`blocked` 전이를 연결한다. `--approval`은 proposal draft approval artifact의 maintenance task를 선택하고 run note에 approval/draft/candidate trace를 남긴다.
- `p2a_orchestrate.mjs`: ready task 1건을 deterministic heuristic으로 `solo`/`solo_monitor`/`team` mode로 분류하고 role prompt, handoff command, monitor gate를 `orchestration-plan` JSON으로 만든다.
- `p2a_orchestrate next-role/role-prompt/mark-role`: runtime 상태에서 다음 role을 계산하고, 사람이 공식 CLI/앱에 붙여넣을 prompt를 출력하고, 사람이 수행한 role 상태 전이를 기록한다. 이 명령들은 Codex/Claude/Gemini 프로세스를 자동 실행하지 않는다.
- `p2a_execute --orchestration-plan`: plan을 `runs/<runId>.orchestration.json` sidecar로 연결하고, `runs/<runId>.orchestration-runtime.json`에 shared mental model과 communication log를 초기화한다. monitor verdict가 필요한 run은 finish 전에 verdict를 확인한다.
- `p2a_handoff.mjs`: co-located `scaffold`, legacy handoff, 선택적 Team Big Five adapter 설치.
- `sync_cli_assets.mjs`: canonical skill/agent에서 Claude/Codex/Gemini mirror 생성. `access: workspace-write`를 허용하며 Codex target에는 `sandbox_mode = "workspace-write"`로 렌더링한다.
- `check_cli_parity.mjs`: 현재 canonical skill/agent와 mirror 상태를 검증한다. `p2a-dev-execution`, `p2a-implementer`, `p2a-performance-monitor`, `p2a-skill-curator`, `p2a-dev-orchestrator`를 포함한다.
- `p2a-dev-execution`: ready task 1건을 구현하고 run log로 기록하는 실행 절차 skill.
- `p2a-implementer`: Codex workspace-write 구현 agent 계약.
- `p2a-performance-monitor`: run log와 acceptance criteria를 read-only로 검토해 `confirm_done` 또는 `block` verdict를 반환하는 계약.
- `p2a-skill-curator`: retrospective proposal을 normalize/dedupe/prioritize하는 read-only 계약.
- `schemas/skill-proposal.schema.json`: retrospective proposal의 구조화 schema.
- `p2a_proposals.mjs`: run log, orchestration sidecar, monitor verdict에서 proposal 후보를 생성하고 list/show/validate/digest/review/curate/draft-patch/approve-draft를 제공한다.
- `p2a-dev-orchestrator`: ready task의 실행 mode와 역할별 감독 계획을 read-only로 검토하는 team-lead 계약.
- `schemas/orchestration-plan.schema.json`: supervised orchestration plan과 monitor gate의 구조화 schema.
- `schemas/orchestration-runtime.schema.json`: run-level shared mental model, role assignment, communication log, runtime phase schema.

아직 없는 것:

- provider capability matrix와 provider-native team runner adapter.
- 일반 multi-provider PTY session coordinator. 여러 Codex/Claude/Gemini CLI 세션을 동시에 열고 조율하는 방식은 기본값이 아니라 후순위로 둔다.
- Claude 무인 자율 *모드* 전환(permissionMode auto/background). confinement 메커니즘은 구현됨, flip은 비용/계정 정책과 cross-OS 실기 spike 후 별도 결정. (Gemini write는 미추진 결정 — LD-8)
- monitor/curator를 자동으로 호출하고 결과를 강제하는 scheduler.
- browser/background loop, 세션 쿠키·토큰 재사용, 여러 계정 로테이션, rate limit 우회.
- 실제 적용 patch 생성 흐름.
- PR 생성, 리뷰 상태 연동, 실패 재시도 정책 자동화.
- code-aware spec 역생성, 결과 diff 자동 병합.

## 3. 완료 기준과 현재 충족도

목표: **"승인된 task 1건을 실제 코드 변경까지 수행하고 결과를 run log로 추적하는 루프"를 안전하게 증명**한다.

| 기준 | 현재 상태 | 비고 |
| --- | --- | --- |
| dev-execution skill 생성 | 완료 | `.agents/skills/p2a-dev-execution/SKILL.md` |
| Codex/Claude/Gemini mirror 생성 | 완료 | `sync_cli_assets.mjs`, `check_cli_parity.mjs` |
| fixture 회귀 green | 완료 | `run_fixtures.mjs` |
| Codex write-capable implementer 계약 | 완료 | `.codex/agents/p2a-implementer.toml`은 `workspace-write` |
| independent monitor 계약 | 완료 | `p2a-performance-monitor` |
| structured retrospective proposal | 완료 | `skill-proposal.schema.json`, `p2a-skill-curator` |
| supervised single-task runner Phase 1 | 완료 | `p2a_execute.mjs`, fixture smoke |
| supervised orchestration plan/runtime/scheduler MVP | 완료 | `p2a_orchestrate.mjs`, run/runtime sidecar, next-role/role-prompt/mark-role, monitor gate fixture |
| Hermes proposal queue/review/curation/patch draft/approval execution bridge | 완료 | `p2a_proposals.mjs`가 proposal/review/curation/patch-draft/approval artifact와 maintenance task를 만들고, `p2a_execute --approval`이 승인 항목을 감독형 실행으로 연결 |
| 별도 target 프로젝트에서 실제 task 1건 smoke | 수동 검증 필요 | 저장소 fixture는 도구 회귀를 검증하지만 실제 앱 구현 smoke를 대체하지 않는다 |
| PTY+Electron 감독 GUI | 완료 | `apps/p2a-gui`가 PTY session, start/finish lifecycle, orchestration runtime/scheduler 표시를 제공 |
| provider-native team runner adapter | 미구현 | 다음 후속. Claude/Codex/Gemini capability matrix와 provider별 team 실행 prompt/adapter 필요 |

현재 문서상 Level 1은 자동 검증 기준으로 완료됐다. 다만 "외부 target 프로젝트에서 실제 앱 task 1건을 끝까지 구현"하는 smoke는 별도 수동 증빙 항목으로 남긴다.

## 4. 잠긴 결정

| # | 결정 | 현재 확정값 | 근거 |
| --- | --- | --- | --- |
| LD-1 | 구현 주체 | Codex에서는 `p2a-implementer` workspace-write subagent 사용 가능. 불가한 CLI는 main-session flow로 폴백 | Codex sandbox가 workspace-write를 제공하고 mirror가 생성된다 |
| LD-2 | `sync_cli_assets` write 확장 | Codex target에 한해 구현됨 | `ACCESS_VALUES`가 `workspace-write`를 허용하고 Codex TOML에 sandbox를 렌더링한다 |
| LD-3 | 대상 CLI | Codex(native sandbox)·Claude(deny+hook+macOS sandbox confinement). Gemini는 read-only mirror | Claude 자율 confinement 완료(step 2); 무인 자율 전환은 spike 후. Gemini는 read-only 고정(LD-8) |
| LD-4 | 실행 모드 | `solo`/`solo_monitor`/`team` deterministic plan + runtime sidecar + supervised scheduler + monitor gate MVP. 후속은 provider-native team orchestration adapter | `p2a_orchestrate.mjs`와 `p2a_execute --orchestration-plan`이 plan/runtime/scheduler 계약을 제공하고, 다음 단계는 provider capability matrix와 adapter를 붙인다 |
| LD-5 | 자가 발전 | JSON proposal queue/review/curation/patch draft/approval gate + read-only curator + 사람 승인 + 감독형 실행 연결 | `skill-proposal.schema.json`, `proposal-review.schema.json`, `proposal-curation.schema.json`, `proposal-patch-draft.schema.json`, `proposal-draft-approval.schema.json`, `p2a_proposals.mjs`, `p2a_execute --approval`, `p2a-skill-curator`가 존재한다 |
| LD-6 | smoke test 주제 | 메모리 저장 bookmark REST API 같은 외부 DB 없는 작은 앱 | 빠른 검증과 scaffold 감지가 쉽다 |
| LD-7 | 검증 원칙 | verification은 실제 명령 실행 결과여야 함 | `p2a-dev-execution`과 monitor가 manual/self-report verification을 불충분하게 본다 |
| LD-8 | Gemini 권한 | read-only 고정, 자율/write 모드 미추진 | Gemini는 native OS sandbox·write tool-map이 없어 별도 confinement 비용이 크다. 쓰기 실행은 Codex/Claude로 한정하고 Gemini는 계획/리뷰 read-only CLI로 둔다 |
| LD-9 | 실행 모드 = 감독형 (구독 요금제) | API 요금제 기반 완전 자동 개발은 비용상 보류한다. Codex/Claude/Gemini는 **구독 로그인 공식 CLI/앱**을 사람이 foreground에서 열고 승인·감독하며, p2a는 role/prompt/order/state만 조율한다 | 구독 로그인 무인화, browser/background loop, 세션 쿠키·토큰 재사용, 여러 계정 로테이션, rate limit 우회는 계정 위험이 있어 피한다 |
| LD-10 | team provider 전략 | 기본은 single-provider team. Claude는 native agent teams/subagents, Codex는 skills/custom agents/명시 subagent prompt, Gemini는 planning/review/monitor read-only 보조 | 여러 회사 구현 agent를 동시에 섞는 방식은 운영 부담과 충돌 위험이 커서 기본값에서 제외한다 |

## 5. 범위

현재 in:

| 항목 | 산출물 |
| --- | --- |
| dev-execution skill | `.agents/skills/p2a-dev-execution/SKILL.md`, `.claude/skills/...`, `.gemini/commands/p2a/dev-execution.toml` |
| Codex implementer | `.agents/agents/p2a-implementer.md`, `.codex/agents/p2a-implementer.toml` |
| monitor gate | `.agents/agents/p2a-performance-monitor.md`와 CLI mirrors |
| retrospective proposal | `schemas/skill-proposal.schema.json`, `schemas/proposal-review.schema.json`, `schemas/proposal-curation.schema.json`, `schemas/proposal-patch-draft.schema.json`, `schemas/proposal-draft-approval.schema.json`, `.agents/agents/p2a-skill-curator.md`, `p2a_proposals.mjs` |
| run tracking | `p2a_runs.mjs`, run schemas, validator support |
| isolated execution record | `--isolation branch|worktree`, `--create-isolation`, `workspaceRef`, `changedFiles` |
| supervised orchestration plan/runtime/scheduler | `p2a_orchestrate.mjs`, `schemas/orchestration-plan.schema.json`, `schemas/orchestration-runtime.schema.json`, `p2a-dev-orchestrator`, run/runtime sidecar, `next-role/role-prompt/mark-role` |
| Hermes proposal queue/review/curation/patch draft/approval execution bridge | `p2a_proposals.mjs`, `p2a_execute --approval`, `validate_artifacts --proposals-dir`, `validate_artifacts --proposal-review`, `validate_artifacts --proposal-curation`, `validate_artifacts --proposal-patch-draft`, `validate_artifacts --proposal-draft-approval`, scaffold/handoff manifest |

후속 out:

| 항목 | 미루는 이유 |
| --- | --- |
| 일반 multi-provider PTY session coordinator | provider-native team runner가 먼저다. 여러 회사를 동시에 섞어 터미널을 조율하는 방식은 운영 부담이 커서 후순위로 둔다 |
| Claude 무인 자율 모드 전환(permissionMode auto/background) | Claude confinement(deny+hook+macOS sandbox)은 완료. 무인 자율 전환은 비용/계정 정책과 실기 cross-OS spike 후 별도 결정 |
| 병렬 scheduler | 자동 조율 대신 provider-native team adapter로 제한한다. 사람이 공식 CLI/앱 세션을 열고 p2a는 role/prompt/order/state만 조율한다 |
| PR 생성/리뷰 연동 | run log와 task 상태가 안정된 뒤 붙인다 |
| 실패 재시도 정책 자동화 | retry가 요구사항 변경과 충돌할 수 있어 gate 설계 필요 |
| code-aware spec 역생성 | 코드 분석과 plan-code trace store가 필요하다 |

## 6. 에이전트 구성

목표 아키텍처:

| 계층 | 책임 | 권한 | 현재 구현 |
| --- | --- | --- | --- |
| Planning | 아이디어를 승인된 spec/task graph로 변환 | read-only | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Task authoring | 승인 spec에서 Gate C task 초안 작성 | read/write planning artifact 한정 | `p2a-task-author`, `context`, `promote-tasks` |
| Execution | ready task를 실제 코드 변경으로 수행 | Codex workspace-write, Claude confinement write(deny+hook+macOS sandbox), Gemini read-only mirror | `p2a-dev-execution`, `p2a-implementer` |
| Verification | 실행 결과와 acceptance criteria 독립 검토 | read-only | `p2a-performance-monitor` |
| Skill evolution | 실행 회고를 proposal/review/curation/patch draft/approval gate로 축적하고 승인 항목을 실행 task로 연결 | read-only + proposal review/curation/patch draft/approval artifact + supervised execution bridge | `p2a-skill-curator`, `skill-proposal`, `proposal-review`, `proposal-curation`, `proposal-patch-draft`, `proposal-draft-approval`, `p2a_execute --approval` |

Team Big Five 역할 매핑:

| Team Big Five | P2A 현재 상태 |
| --- | --- |
| `team-lead` | `p2a-dev-orchestrator` MVP 1차 + `p2a_orchestrate.mjs` deterministic triage |
| `contributor` | `p2a-implementer` |
| `performance-monitor` | `p2a-performance-monitor` |

실행 모드:

- **현재 기본 = supervised single task + 선택적 orchestration plan/runtime/scheduler/monitor**: `p2a_execute.mjs`가 ready 확인, run start, manual launcher prompt, verify, finish, task done/block 전이를 묶고, `p2a_orchestrate.mjs`는 필요한 경우 역할별 실행 계획, runtime shared mental model, communication log, 다음 role/prompt 계산, monitor gate를 sidecar로 연결한다. `p2a-dev-execution`은 사람이 감독하는 구현 절차를 안내한다.
- **Codex 구현 경로**: 가능하면 `p2a-implementer`를 isolated worktree/workspace에서 사용한다. 단 `p2a-implementer`는 scoped 파일 편집만 하고, `p2a_runs verify`/`finish`와 `p2a_tasks done|block` 같은 run lifecycle은 main owner(이 스킬을 도는 주체)가 전담한다(자가 발전 첫 사이클로 명확화됨).
- **Claude 구현 경로**: `p2a-implementer` mirror가 write-capable(`Edit`/`Write`/`Bash`)이고, scaffold가 deterministic confinement를 설치한다(Level 2 step 2 완료): 공통 deny-rules + cross-platform PreToolUse hook(`.claude/hooks/p2a-confine-workspace.mjs` — symlink/junction 하위 신규 파일까지 canonicalize로 차단, 오류 시 fail-closed)에 macOS/Linux는 OS sandbox(`sandbox.enabled`)를 `process.platform` 분기로 자동 토글한다. Write/Edit 경계는 airtight, Bash는 best-effort(macOS/Linux는 OS sandbox가 실제 경계, Windows는 app-level 잔여위험). 단 무인 자율(permissionMode auto/background) 전환은 실기 cross-OS spike 후 결정하며, 현재는 foreground 사람 승인으로 둔다.
- **Gemini 구현 경로**: 설계상 read-only로 고정한다(자율/write 미추진 결정, LD-8). 구현은 main-session/human-supervised flow로 폴백한다.
- **팀 모드**: 복잡한 task의 team orchestration은 Plan2Agent-native runtime sidecar와 supervised scheduler까지 기록한다. Team Big Five adapter 설치와 role handoff는 가능하지만, 여러 provider 구현 agent를 동시에 섞는 방식을 기본값으로 두지 않는다. 후속은 provider capability matrix와 provider-native team runner adapter다. Claude는 native agent teams/subagents, Codex는 skills/custom agents/명시 subagent prompt, Gemini는 planning/review/monitor read-only 보조로 둔다.

## 7. 경계와 안전

구현 실행 조건:

- task가 `p2a_tasks ready`에 노출되어야 한다.
- Gate B spec이 approved이고 `open_decisions`가 비어 있어야 한다.
- Gate D review blockers가 없어야 한다.
- task에 acceptance criteria가 있어야 한다.
- 사용자가 구현 실행을 명시해야 한다.

금지 행위:

- planning artifact를 우회해 요구사항을 임의 추가.
- 승인 근거 없이 dependency 설치.
- `.env`, credential, token, private key 접근·출력·복사.
- 실패한 검증을 숨기고 task를 `done` 처리.
- skill/agent/schema를 실행 중 자동 self-modify.
- Plan2Agent harness 파일을 구현 task 대상으로 수정.

쓰기 경계:

- 구현은 별도 target 프로젝트 또는 isolated worktree 안에서만 수행한다.
- `p2a-implementer`는 run의 `workspaceRef` 또는 worktree 범위를 유일한 쓰기 표면으로 본다.
- co-located 프로젝트에서는 `.plan2agent/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/` 같은 harness/install 파일을 앱 구현 변경 대상으로 보지 않는다.
- 중단/실패 시 branch/worktree는 사용자가 확인한 뒤 폐기한다. 자동 destructive cleanup은 하지 않는다.

## 8. 인터페이스 계약

`p2a_execute.mjs` / `p2a-dev-execution` 입력:

- artifact root 또는 explicit graph
- ready task id
- `agent-tool` 값, 보통 `codex`
- optional run id

표준 흐름:

```bash
node scripts/p2a_execute.mjs plan --artifacts <dir> --task <task-id>
node scripts/p2a_execute.mjs start --artifacts <dir> --task <task-id> --agent-tool codex --isolation worktree --worktree <fresh-worktree-path> --create-isolation
node scripts/p2a_execute.mjs finish --run-id <run-id> --artifacts <dir> --test --lint --typecheck --collect-git
```

저수준 구성 요소는 `p2a_tasks.mjs ready|prompt|start|done|block`과 `p2a_runs.mjs start|verify|finish`다. Phase 1 실행기는 이 둘을 재구현하지 않고 orchestration한다.

monitor gate:

- 입력은 task acceptance criteria와 latest run log다.
- 출력은 아래 shape를 따른다.

```json
{
  "verdict": "confirm_done",
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "note": ""
}
```

task 상태 반영:

```bash
node scripts/p2a_execute.mjs finish --run-id <run-id> --artifacts <dir> --status finished
node scripts/p2a_execute.mjs finish --run-id <run-id> --artifacts <dir> --status blocked --failure-class implementation_incomplete
```

retrospective proposal:

- 경로: `.plan2agent/proposals/<proposalId>.json`
- schema: `schemas/skill-proposal.schema.json`
- status 초기값: `proposed`
- 적용은 별도 사람 승인 후 생성된 maintenance task를 실행해서 수행한다.
- 생성/요약 명령:

```bash
node scripts/p2a_proposals.mjs mine --graph .plan2agent/artifacts/task-graph.json
node scripts/p2a_proposals.mjs review --proposals .plan2agent/proposals
node scripts/p2a_proposals.mjs curate --review .plan2agent/proposals/reviews/proposal-review-<hash>.json
node scripts/p2a_proposals.mjs draft-patch --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json --candidate-id candidate-<hash>
node scripts/p2a_proposals.mjs approve-draft --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json --artifacts artifacts/<project_id> --approved-by <name>
node scripts/p2a_execute.mjs plan --artifacts artifacts/<project_id> --approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json
node scripts/p2a_execute.mjs start --artifacts artifacts/<project_id> --approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json --agent-tool codex
node scripts/p2a_proposals.mjs digest --proposals .plan2agent/proposals
node scripts/validate_artifacts.mjs --proposals-dir .plan2agent/proposals
node scripts/validate_artifacts.mjs --proposal-curation .plan2agent/proposals/curations/proposal-curation-<hash>.json
node scripts/validate_artifacts.mjs --proposal-patch-draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json
node scripts/validate_artifacts.mjs --proposal-draft-approval .plan2agent/proposals/approvals/proposal-draft-approval-<hash>.json
```

## 9. 자가 발전 루프

트리거:

- task 완료
- task 실패
- verification 누락
- scope boundary 위반 위험 발견
- 반복되는 실행 실수 발견

현재 구현:

- `p2a-dev-execution`이 retrospective gate를 갖는다.
- 개선 후보는 freeform markdown이 아니라 `p2a.skill_proposal.v1` JSON으로 남긴다.
- `p2a_proposals.mjs`가 `failed`/`blocked` run, monitor verdict, verification gap을 읽어 proposal queue와 review/curation/patch-draft/approval artifact를 만들고 approval을 maintenance task로 연결한다. `p2a_execute --approval`은 이 maintenance task를 감독형 실행 대상으로 선택한다.
- `p2a-skill-curator`는 proposal과 run log를 읽어 normalize, dedupe, prioritize, recommended disposition을 반환한다.

불변식:

- 실행 중 skill/agent/schema를 자동 수정하지 않는다.
- curator는 read-only다.
- proposal 적용은 human approval 이후 별도 patch로 한다.

## 10. 검증 전략

자동 검증:

```bash
node --check scripts/check_cli_parity.mjs
node --check scripts/p2a_handoff.mjs
node --check scripts/p2a_iteration.mjs
node --check scripts/p2a_iteration_state.mjs
node --check scripts/p2a_execute.mjs
node --check scripts/p2a_proposals.mjs
node --check scripts/p2a_runs.mjs
node --check scripts/p2a_tasks.mjs
node --check scripts/run_fixtures.mjs
node --check scripts/sync_cli_assets.mjs
node --check scripts/validate_artifacts.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

수동 smoke:

1. plan2agent repo 밖에 target 프로젝트를 만든다.
2. `node scripts/p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 co-located harness를 설치한다.
3. 작은 REST API 같은 외부 DB 없는 아이디어로 Gate A-D를 통과시킨다.
4. `p2a_execute plan`으로 ready task와 실행 계획을 확인한다.
5. `p2a_execute start`로 run을 시작하고 manual launcher prompt를 Codex `p2a-implementer` 또는 foreground 구현 세션에 넘긴다.
6. `p2a_execute finish`가 실제 test/lint/typecheck 명령을 실행하고 run/task 상태를 반영하게 한다.
7. 필요하면 `p2a-performance-monitor` verdict를 `--status blocked --failure-class ...` 또는 후속 `done` 판단에 반영한다.

수동 smoke 완료 기준:

- 실제 코드 변경이 target workspace 안에서만 발생한다.
- run log에 `changedFiles`, `verification`, `agentTool`, `workspaceRef`, `finishedAt`이 남는다.
- task 상태가 `done` 또는 `blocked`로 갱신된다.
- Plan2Agent harness 파일은 구현 변경에 포함되지 않는다.

## 11. 다음 개발 순서

우선순위 원칙:

- PR 생성/리뷰 연동은 사용자가 명시적으로 요청하기 전까지 자동화하지 않는다.
- 기본 개발 루프는 branch/worktree, changedFiles, verification, run summary까지만 준비한다.
- 자동 실행보다 먼저 실패와 차단 사유를 구조화한다. 그래야 retry, orchestrator, monitor gate가 안전하게 판단할 수 있다.

우선순위 높은 순서:

1. **실패 분류/차단 사유 표준화** (✅ 완료 — C-①)
   - 목적: `done`이 아닌 run/task 결과를 사람이 읽는 메모가 아니라 기계가 판단할 수 있는 reason code로 남긴다.
   - 후보 reason code: `verification_failed`, `scope_violation`, `missing_dependency`, `needs_user_decision`, `environment_failure`, `test_flake`, `implementation_incomplete`, `monitor_blocked`.
   - 산출물 후보: run log 또는 별도 sidecar에 `blockReason`, `failureClass`, `retryable`, `needsUserDecision` 같은 구조화 필드 추가.
   - 완료 기준: `p2a_runs finish --status failed|blocked`와 `p2a_tasks block` 흐름에서 차단 사유가 일관되게 기록되고 validator/fixture가 이를 검증한다.

2. **Codex 단일 task 감독형 실행기** (✅ Phase 1 완료, LD-9: 구독 로그인 → 감독형)
   - 목적: ready task 1개에 대해 `worktree 생성 -> p2a_runs start -> Codex 구현 -> verify -> monitor -> done/block` 체인을 자동화하되, **Codex 구현 단계는 사람이 감독**한다(구독 로그인 제약).
   - 진행: **Phase 1 semi-auto(기존 CLI) 완료** — `p2a_execute.mjs`가 lifecycle을 엮고 Codex 구현만 사람이 대화형 실행 → **Phase 2 PTY+Electron 감독 GUI**(node-pty/xterm로 live watch + 승인).
   - 설계: Codex 기동 표면은 현재 manual launcher prompt다. 다음 단계에서 PTY launcher로 바꿔도 task/run orchestration 계약은 유지한다.
   - 선행 조건: 1번(실패 분류, C-①)이 retry/ask/stop 분기와 실패 이력의 연료 — 완료됨.
   - 비목표: **headless 무인 실행(API 기반 완전 자동은 비용상 보류)**, 여러 agent 병렬 자동화, PR 생성/자동 merge.

3. **`p2a-dev-orchestrator` MVP** (✅ 1차 + runtime 1단계 + supervised scheduler 2단계 완료)
   - 목적: Team Big Five의 team-lead 역할을 P2A-native로 분리한다.
   - 완료 범위: ready task 1건을 `solo`/`solo_monitor`/`team`으로 deterministic triage하고, 역할별 prompt, run/runtime sidecar, shared mental model, communication log, next-role/role-prompt/mark-role 감독형 scheduler, monitor gate를 남긴다.
   - 후속 범위: provider capability matrix, provider-native team runner adapter, retry/ask/blocked 판단 보조. 구독 로그인 기반 무인 실행과 자동 role/monitor 호출은 계속 제외한다.

4. **Hermes식 proposal queue/review/curation/patch draft/approval execution bridge** (✅ 완료)
   - 목적: 실제 run에서 쌓인 proposal을 normalize, dedupe, prioritize하고 승인 대기 목록으로 정리한다.
   - 범위: proposal 자동 적용은 계속 금지한다.
   - 완료 범위: run sidecar/failureClass/monitor verdict 기반 proposal queue, invalid run best-effort skip, list/show/validate/digest/review/curate/draft-patch/approve-draft, proposal-review/curation/patch-draft/approval schema, maintenance task 연결, `p2a_execute --approval` 실행 연결, scaffold/handoff 복사, fixture 회귀.
   - 결정: Hermes 고도화는 여기서 멈춘다. 실제 적용 patch 생성, skipped-verification rationale 표준 필드/marker, 반복 failureClass/source/targetFiles 통계, cross-session recall, 검색/DB 저장은 지금 구현하지 않고 store/DB 단계에서 방향을 다시 논의한다.

5. **오케스트레이션 런타임 고도화 2단계** (✅ 감독형 scheduler 완료)
   - 완료 범위: runtime sidecar를 기반으로 `next-role`, `role-prompt`, `mark-role`을 제공한다. 사람이 공식 CLI/앱을 열고 prompt를 붙여넣은 뒤 결과를 기록하는 흐름만 지원한다.
   - 후속 범위: provider-native team orchestration adapter. Claude는 native agent teams/subagents, Codex는 skills/custom agents/명시 subagent prompt, Gemini는 planning/review/monitor read-only 보조로 둔다. API 기반 완전 자동 개발은 비용상 보류한다. 자동 role/monitor 호출과 무인 실행은 제외한다.

6. **UI/DB 기반 task store**
   - 목적: 파일 기반 운용이 불편해지는 시점에 task/run/proposal 검색과 대시보드를 제공한다.
   - 착수 조건: 다중 프로젝트, 여러 명의 동시 사용, run history 증가, task 검색 불편이 실제 문제로 확인될 때.
   - 비목표: 현재 전문 개발자 1인/소규모 dogfooding 단계에서 즉시 구현하지 않는다.

7. **PR 생성/리뷰 연동**
   - 정책: 사용자가 명시적으로 요청한 경우에만 실행한다.
   - 기본 루프에서는 PR을 만들지 않는다. Plan2Agent는 branch, changedFiles, verification, run summary까지만 준비한다.
   - 후속 범위: PR body 자동 작성, CI 상태 읽기, 리뷰 comment/request changes를 run/task 상태와 연결.
   - 비목표: 자동 push, 자동 merge, 사용자 승인 없는 PR 생성.

추가 후속:

- code-aware spec 역생성과 result diff 병합은 execution layer와 run history가 안정된 뒤 설계한다.

## 12. 참조·라이선스

### Team Big Five (`https://github.com/tobyilee/team-bigfive`)

Salas Big Five 팀워크 모델을 agent에 적용한 하네스다. P2A가 차용하는 패턴:

- 역할 분리: `team-lead`, `contributor`, `performance-monitor`
- solo/team triage
- shared mental model 파일 외부화
- closed-loop communication
- phase boundary 검증
- debrief/AAR

주의: Team Big Five는 Claude-native다. P2A는 Codex/Claude/Gemini를 모두 대상으로 하지만 세 provider를 같은 방식으로 취급하지 않는다. Claude는 native team/subagent 기능을 우선 사용하고, Codex는 skill/custom agent/명시 subagent prompt로 유사한 역할 실행을 구성하며, Gemini는 planning/review/monitor read-only 보조로 제한한다. 코드는 무조건 복사하지 않고, local source를 설치할 때는 safe filter와 source manifest로 출처와 범위를 기록한다.

### Hermes Agent (`https://github.com/nousresearch/hermes-agent`)

Hermes의 self-improving loop에서 차용하는 패턴:

- 실행 경험에서 skill 개선 후보를 찾는다.
- cross-session 회고를 남긴다.
- 미지 기술은 근거와 함께 기록한다.

안전 분기:

- Hermes식 자동 self-modify는 P2A에서 금지한다.
- P2A는 `proposal -> curator review -> human approval -> separate patch` 흐름만 허용한다.
- 2026-06-24 결정: 현재 브랜치에서는 파일 기반 proposal bridge까지만 완료로 고정한다. Hermes 고도화(이전 내용 검색, cross-session recall, DB/vector index, 자동 patch 적용)는 나중에 UI/DB 기반 task store를 설계할 때 다시 논의한다.

## 13. 외부 레포 흡수 현황 (Team Big Five / Hermes)

§1·§12의 두 차용 컨셉을 "무엇이 흡수됐는지" 관점으로 정리한다. (✅ 완료 / 🟡 부분 / ⬜ 미착수)

### Team Big Five
| 항목 | 상태 | 비고 |
| --- | --- | --- |
| performance-monitor (독립 검증) | ✅ | `p2a-performance-monitor` |
| contributor (구현자) | ✅ | `p2a-implementer` — Codex `workspace-write` + **Claude write + deterministic confinement(deny+hook+macOS sandbox, step 2)** 구현됨. Gemini는 read-only 고정(미추진 결정, LD-8) |
| debrief/evolution (회고→개선) | ✅ | dev-execution retrospective + `p2a-skill-curator` |
| mutual monitoring (검증 강도 차등) | 🟡 | 독립 검증은 됨, "중요도별 강도 조절"은 미적용 |
| team-lead / orchestrator | 🟡 | `p2a-dev-orchestrator` MVP 1차 + runtime 1단계 + supervised scheduler 2단계 완료. 후속은 provider-native team runner adapter |
| solo/team triage | 🟡 | `p2a_orchestrate.mjs` deterministic `solo`/`solo_monitor`/`team` 판단 완료. agent-generated plan은 후속 |
| shared mental model 파일 | ✅ | `orchestration-runtime.schema.json`, `runs/<runId>.orchestration-runtime.json` |
| closed-loop 통신 | ✅ | `p2a_orchestrate record`, runtime communication log |
| supervised role scheduler | ✅ | `next-role`, `role-prompt`, `mark-role`. 프로세스 자동 실행 없음 |

### Hermes
| 항목 | 상태 | 비고 |
| --- | --- | --- |
| skill = 반복 절차 기억 | ✅ | 스킬 시스템 전반 |
| 자가 발전 (proposal→curator→승인→적용) | ✅ | 첫 사이클 완결 + `p2a_proposals.mjs` queue/review/curation/patch draft/approval + `p2a_execute --approval` bridge. 자동 적용은 금지 |
| staged proposal→review→curation→draft→approval→apply | ✅ | `skill-proposal.schema.json` + `proposal-review.schema.json` + `proposal-curation.schema.json` + `proposal-patch-draft.schema.json` + `proposal-draft-approval.schema.json` + `p2a_proposals.mjs` + `p2a-skill-curator` |
| 미지 기술 조사 + 근거 | ✅ | Gate B Technology Reconnaissance |
| cross-session recall | 🟡 | run log + curator 횡단 읽기만. 세션 전체 검색·요약은 미적용 → 아래 연기 |

### 남은 확장과 난이도 (현재 기준)
- ✅ **write-capable subagent (Codex)** — 완료. Codex `workspace-write` sandbox로 confine, spike로 실증.
- ✅ **Level 2 step 2: Claude 자율 confinement** — 완료. scaffold가 공통 deny-rules + cross-platform PreToolUse hook(symlink-safe canonicalize, fail-closed)을 설치하고, macOS/Linux는 OS sandbox 토글을 `process.platform` 분기로 자동 on, Windows는 app-level까지. symlink 탈출 blocker는 #56에서 수정·재현 검증(junction A=deny, 내부 신규=allow, parity/run_fixtures green). 무인 자율 모드(permissionMode) 전환 자체는 실기 cross-OS spike 후 사람 결정.
- ⛔ **Gemini write — 미추진 결정(LD-8)**: Gemini는 계획/리뷰 전용 read-only로 한정. Level 2(쓰기 confinement)는 Codex+Claude로 종결.
- ✅ **Hermes proposal queue/review/curation/patch draft/approval execution bridge** — 완료. `p2a_proposals.mjs`가 run failure, monitor verdict, verification gap을 proposal JSON으로 축적하고 deterministic review/curation/patch-draft/approval/digest/validate를 제공하며, `p2a_execute --approval`이 승인 항목을 감독형 maintenance 실행으로 연결한다. 자동 적용은 계속 금지.
- 🟡 **orchestrator / triage** — MVP 1차 + runtime 1단계 + supervised scheduler 2단계 완료. `p2a_orchestrate.mjs`와 run/runtime sidecar가 정본이며, 후속은 provider-native team runner adapter다. 자동 role/monitor 호출은 제외한다.
- ✅ **PTY+Electron 감독 GUI** — MVP 완료. node-pty/xterm 기반 PTY session, start/finish lifecycle, task/run/artifact 표시, orchestration runtime/scheduler 표시, role prompt 복사, 수동 `mark-role`, 한글/영문 UI가 들어왔다. 후속은 여러 provider 터미널 자동 조율이 아니라 provider 선택, role prompt, 상태 기록, monitor gate를 provider-native team 흐름에 맞춰 보여주는 방향이다.
- ⏸ **Hermes 고도화 / cross-session recall** — store/DB 단계로 연기(아래).

### Hermes 고도화 / cross-session recall — store/DB 단계로 연기 (결정)
파일 기반 단계에서 무리해 만들지 않고, **JIRA식 Task Store/DB(§11-5, v2) 도입 시 방향을 다시 논의한 뒤 함께 얹는다.**
- 이유: recall의 난관(① 관련성 검색 백엔드, ② 무-DB·결정적 제약과 충돌, ③ 어떤 실행 대화를 저장할지의 개인정보/용량 정책)이 store 도입 시 함께 결정되어야 한다.
- 그때 다시 정할 결정: (a) 검색 대상(run/proposal은 자동, 대화·세션 transcript는 별도 캡처 결정) (b) 무엇을 재사용 "교훈"으로 distill할지 (c) SQLite full-text만으로 갈지, vector index를 붙일지.
- 이번 단계의 다음 추천 구현은 Hermes가 아니라 **provider-native team orchestration adapter**다.
