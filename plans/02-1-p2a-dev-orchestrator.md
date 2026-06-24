# 02-1 p2a-dev-orchestrator 개발 계획

작성일: 2026-06-23 · 상태: MVP 1차 구현 완료, 오케스트레이션 runtime 1단계 완료, 감독형 scheduler 2단계 완료, GUI runtime/scheduler 표시 완료, O7 Hermes proposal queue/review/curation/patch draft/approval execution bridge 완료, provider-native team orchestration 후속 방향 확정 · 상위 문서: `plans/02-development-team-ai-agent.md` · 연결 문서: `plans/01-product-roadmap.md`, `plans/03-p2a-gui-mvp.md`

이 문서는 Team Big Five의 `team-lead` 역할을 Plan2Agent-native로 구현하기 위한 최소 개발 계획이다. 목표는 여러 agent를 무인으로 돌리는 것이 아니라, 기존 CLI-first 하네스 위에서 **어떤 task를 solo/team으로 처리할지 판단하고, 역할별 실행 계획, shared mental model, communication log, 검증 흐름을 파일로 남기는 것**이다. 최신 GUI는 task/run/artifact와 PTY 실행에 더해 orchestration mode/role/runtime/monitor gate를 읽고, 사람이 수행한 role 상태만 기록한다. 후속 개발은 generic multi-provider terminal coordinator가 아니라 provider별 공식 기능을 활용하는 provider-native team orchestration으로 진행한다.

## 0. 이번 브랜치 구현 상태

1차 구현 범위:

- `orchestration-plan.schema.json`과 validator 연결.
- `p2a_orchestrate.mjs plan/show/validate/handoff` CLI.
- `p2a_execute start --orchestration-plan <path>` run sidecar 연결.
- `orchestration-runtime.schema.json`, `p2a_orchestrate init-runtime/record/runtime-status`, `p2a_execute start` runtime sidecar 자동 초기화.
- `p2a_orchestrate next-role/role-prompt/mark-role` 감독형 scheduler. 다음 role과 prompt를 계산하고 사람이 수행한 결과만 기록한다.
- monitor verdict 기반 `finish` 차단/blocked 변환.
- `p2a-dev-orchestrator` read-only agent와 CLI mirror.
- scaffold/handoff 복사 대상, fixture, CLI 문서 갱신.
- `apps/p2a-gui` Runs 화면에서 orchestration runtime/scheduler 상태, role prompt 복사, 수동 `mark-role` 상태 기록을 제공한다.
- `p2a_proposals.mjs`가 run failure, monitor verdict, verification gap에서 Hermes식 proposal queue/review/curation/patch draft/approval gate를 생성·검증·요약하고 `p2a_execute --approval`이 승인 항목을 감독형 maintenance 실행으로 연결.

후속으로 남김:

- provider capability matrix. Claude, Codex, Gemini가 어떤 role을 공식 기능으로 수행할 수 있는지 구조화한다.
- provider-native team runner adapter. Claude는 native agent teams/subagents, Codex는 skills/custom agents/명시 subagent prompt, Gemini는 extensions/custom commands/GEMINI.md 기반 planning/review/monitor 보조로 둔다.
- 실제 적용 patch 생성.
- agent-generated orchestration plan.

## 1. 현재 전제

완료된 기반:

- `p2a_tasks.mjs`: task ready/start/done/block 상태와 의존성 관리.
- `p2a_runs.mjs`: run log, verification, changedFiles, workspaceRef, failureClass 기록.
- `p2a_execute.mjs`: ready task 1건의 start/finish/status lifecycle.
- `apps/p2a-gui`: PTY 세션, task/run/artifact 표시, start/finish 감독 UI, orchestration runtime/scheduler 표시와 수동 role 상태 기록. MVP 구현의 선행 조건은 아니다.
- `p2a-implementer`: Codex/Claude 구현자 계약. Gemini는 read-only.
- `p2a-performance-monitor`: 실행 결과 독립 검증 계약.
- `p2a-skill-curator`: Hermes식 proposal 검토 계약.
- Team Big Five adapter 설치: CLI별 kickoff 파일 설치와 source manifest 기록.
- `orchestration-runtime.schema.json`: run-level shared mental model, role assignment, communication log, runtime phase 기록.
- `p2a_orchestrate next-role/role-prompt/mark-role`: 구독 로그인 기반 사용을 위한 감독형 scheduler. 프로세스를 띄우지 않고 사람이 공식 CLI/앱에서 실행할 다음 prompt를 제공한다.

아직 후속으로 남긴 것:

- agent-generated orchestration plan.
- provider capability matrix와 provider-native team runner adapter.
- 일반 multi-provider PTY session coordinator는 후순위로 둔다.
- 자동 role/monitor 호출은 API 키 기반 별도 설계 전까지 제외한다.
- 실패 시 retry/ask/blocked 판단 규칙.

## 2. MVP 목표

MVP는 아래를 개발 완료 기준으로 본다.

| 기능 | 완료 기준 |
| --- | --- |
| deterministic task triage | task metadata, dependency, acceptance criteria를 읽고 규칙 기반으로 `solo`, `solo_monitor`, `team` 중 하나를 추천한다 |
| execution plan | 역할, agent tool, 작업 범위, 검증 명령, monitor gate를 구조화 JSON으로 만든다 |
| supervised CLI handoff | CLI에서 사람이 열 수 있는 agent별 session command/prompt를 출력한다 |
| run 연결 | orchestration plan id와 역할별 session 결과를 `runs/<runId>.orchestration.json` sidecar로 추적한다 |
| runtime 연결 | shared mental model, role assignment, communication log를 `runs/<runId>.orchestration-runtime.json` sidecar로 추적한다 |
| supervised scheduler | runtime 상태에서 다음 role을 계산하고, role prompt를 출력하고, 사람이 수행한 role 상태 전이를 기록한다 |
| monitor gate | finish 전에 필요한 verdict 경로와 허용 verdict, failureClass mapping을 명시한다 |
| 안전 경계 | planning artifact 직접 수정, 무인 실행, 자동 push/merge를 금지한다 |

MVP에서 하지 않는 것:

- headless 무인 실행.
- 여러 CLI 세션의 완전 자동 병렬 scheduler 또는 자동 role/monitor 호출.
- 사용자 승인 없는 dependency install, PR 생성, push, merge.
- Gemini write 실행.
- Hermes proposal 자동 적용.
- GUI에서 orchestration plan/runtime을 임의 편집하는 기능.
- agent-generated orchestration plan.

## 3. 산출물

1. `schemas/orchestration-plan.schema.json`
   - `schema_version`
   - `projectId`, `taskId`, `sourceTaskGraph`
   - `mode`: `solo` | `solo_monitor` | `team`
   - `roles`: `lead`, `contributor`, `reviewer`, `monitor`
   - `agentTool`: `codex` | `claude` | `gemini` | `manual`
   - `scope`, `acceptanceCriteria`, `verificationPlan`
   - `handoffPrompts`
   - `monitorGate`: `required`, `verdictPath`, `acceptedVerdicts`, `failureClassMap`
   - `riskFlags`

2. `.agents/agents/p2a-dev-orchestrator.md`
   - read-only team-lead agent 계약.
   - MVP에서는 plan 작성자가 아니라 plan review/proposal 생성 역할이다.
   - 직접 코드 수정, run finish, task done/block 처리는 하지 않는다.

3. CLI mirror
   - `.codex/agents/p2a-dev-orchestrator.toml`
   - `.claude/agents/p2a-dev-orchestrator.md`
   - `.gemini/agents/p2a-dev-orchestrator.md`
   - `sync_cli_assets.mjs`, `check_cli_parity.mjs`에 포함.

4. `scripts/p2a_orchestrate.mjs`
   - `plan`: ready task 기준 orchestration plan 생성/검증.
   - `show`: 저장된 plan 표시.
   - `validate`: schema와 task/run 참조 검증.
   - `handoff`: 역할별 agent prompt/command 출력.
   - `init-runtime`: run-level shared mental model과 communication log sidecar 생성.
   - `record`: 실행 중 status/question/decision/verification/monitor verdict 이벤트 기록.
   - `runtime-status`: runtime phase와 role/event 상태 표시.
   - `next-role`: runtime 상태에서 다음 감독 대상 role 계산. 프로세스 실행 없음.
   - `role-prompt`: 사람이 공식 CLI/앱에 붙여넣을 role prompt 출력. 프로세스 실행 없음.
   - `mark-role`: 사람이 수행한 role 결과를 `active/complete/blocked/skipped` 상태로 기록.

5. run/runtime sidecar
   - 저장 위치는 `runs/<runId>.orchestration.json`로 고정한다.
   - runtime 저장 위치는 `runs/<runId>.orchestration-runtime.json`로 고정한다.
   - MVP에서는 `task-graph.schema.json`과 `run.schema.json`을 바꾸지 않는다.
   - run log에는 필요할 때 표시용 plan id만 문자열로 남기고, 상세 계약은 sidecar들이 정본이다.

## 4. 개발 순서

### O1. Schema와 fixture

- `orchestration-plan.schema.json` 작성.
- solo, solo+monitor, team mode fixture 추가.
- validator가 task id, role, agent tool, verification plan을 검증.

완료 기준:

- schema validation green.
- negative fixture가 잘못된 role/tool/task 참조를 잡는다.

### O2. Orchestrator agent 계약

- `p2a-dev-orchestrator` agent를 read-only로 추가.
- MVP에서 이 agent는 deterministic plan을 검토하고 개선 proposal을 쓰는 역할로 둔다.
- Codex/Claude/Gemini mirror 생성.
- `check_cli_parity.mjs`에 포함.

완료 기준:

- agent 계약이 코드 수정, lifecycle 종료, plan 자동 적용을 금지한다.
- CLI mirror drift 검증 green.

### O3. CLI deterministic plan/handoff

- `p2a_orchestrate.mjs plan --artifacts <dir> --task <task-id>` 구현.
- plan은 deterministic heuristic으로 만든다.
- agent-generated plan은 후속으로 두고, MVP는 명확한 규칙부터 고정한다.
- `handoff`는 역할별 prompt와 터미널에서 열 command를 출력한다.

완료 기준:

- ready task만 orchestration plan을 만들 수 있다.
- not-ready task, open decision, acceptance criteria 누락은 실패한다.
- `run_fixtures.mjs`에 orchestrator fixture가 포함된다.

### O4. Run lifecycle 연결

- `p2a_execute start --orchestration-plan <path>` 또는 동등 옵션으로 plan id를 run에 연결한다.
- run sidecar는 `runs/<runId>.orchestration.json`에 저장한다.
- runtime sidecar는 `runs/<runId>.orchestration-runtime.json`에 자동 초기화한다.
- finish 시 `monitorGate.required`가 true이면 `monitorGate.verdictPath`의 verdict를 확인한다.
- 허용되지 않은 verdict는 `failureClassMap`에 따라 기존 failureClass로 변환한다.

완료 기준:

- run show/list에서 orchestration mode와 plan id를 확인할 수 있다.
- status에서 orchestration runtime phase와 event count를 확인할 수 있다.
- monitor gate가 필요한 run은 verdict 없이 done 처리되지 않는다.
- `run.schema.json` 확장 없이 sidecar validation으로 계약을 검증한다.

### O5. Fixture와 문서 검증

- `run_fixtures.mjs`에 solo, solo_monitor, team, monitor-blocked fixture를 추가한다.
- `docs/cli-reference.md`에 `p2a_orchestrate.mjs` 사용법을 추가한다.
- `docs/quickstart.md`에는 CLI-first 감독형 orchestration 흐름만 짧게 연결한다.

완료 기준:

- fixture green.
- `git diff --check` green.
- 기존 단일 task 실행 문서와 충돌하지 않는다.

### O6. GUI orchestration 표시

- Runs 화면에서 orchestration mode, runtime phase, 다음 role, monitor gate, role 상태를 보여준다.
- 선택 role의 supervised prompt를 복사해 사람이 공식 CLI/앱에 붙여넣을 수 있다.
- GUI는 plan/runtime을 임의 편집하지 않고, `p2a_orchestrate mark-role`을 통해 사람이 관찰한 role 상태만 기록한다.

완료 기준:

- solo task는 기존 단일 task 흐름을 방해하지 않는다.
- team task는 역할별 prompt/command, monitor gate, 다음 role hint가 Runs 화면에서 확인된다.
- GUI action은 Codex/Claude/Gemini CLI, browser, background loop를 실행하지 않는다.

### O7. Hermes proposal queue/review/curation/patch draft/approval execution bridge

- orchestration 결과에서 반복 실패, scope drift, verification gap을 proposal 후보로 만든다.
- 자동 적용은 금지하고 `p2a-skill-curator` 검토 대상으로만 남긴다.

완료 기준:

- `p2a_proposals.mjs mine`이 run log, orchestration sidecar, monitor verdict를 읽어 `skill-proposal` JSON을 만든다.
- 손상된 run file은 `mine`에서 warning 후 skip하고 나머지 run 분석은 계속한다. 감사용 `validate`는 계속 엄격하게 실패한다.
- `list/show/digest/review/curate/draft-patch/approve-draft/validate`로 사람이 큐와 review/curation/patch-draft/approval artifact를 검토하고 승인 항목을 maintenance task로 연결할 수 있다.
- `p2a_execute --approval <approval.json>`이 approval artifact의 maintenance task를 검증한 뒤 plan/start/status/finish 대상으로 선택한다.
- `validate_artifacts --proposals-dir`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`이 proposal directory와 review/curation/patch-draft/approval artifact 계약을 검증한다.
- scaffold/handoff 대상 프로젝트에 CLI와 schema가 포함된다.
- fixture가 monitor-blocked run에서 proposal을 생성하고 digest/review/curation/patch-draft까지 확인한다.

### O8. Provider-native team orchestration adapter

목적: `team` mode를 여러 회사 CLI를 동시에 섞는 터미널 조율 문제가 아니라, 선택한 provider의 공식 team/subagent/skill 기능을 활용하는 감독형 실행 흐름으로 고정한다. 기본값은 single-provider team이다.

범위:

- provider capability matrix를 추가한다.
- `team` plan에 `providerStrategy`, role capability, 실행 표면을 기록한다.
- Claude adapter는 Claude Code의 agent teams/subagents를 native team runner로 사용한다. agent teams가 experimental/off이면 subagent/foreground prompt로 폴백한다.
- Codex adapter는 Codex skills, custom agents, 명시 subagent prompt를 사용한다. Codex는 subagent를 자동으로 spawn하지 않으므로 prompt에 명시 요청을 포함한다.
- Gemini adapter는 Gemini CLI extensions, custom commands, `GEMINI.md` context를 사용하되 planning/review/monitor read-only 역할에 한정한다. 구현자 role에는 기본 배정하지 않는다.
- mixed-provider implementation은 기본값에서 제외한다. provider를 섞는 경우는 사람이 명시한 review/monitor 보조 역할로만 허용한다.
- GUI는 여러 터미널을 자동으로 여는 대신 provider 선택, role prompt, next-role, mark-role, monitor gate를 명확히 보여준다.

완료 기준:

- `claude`, `codex`, `gemini` capability matrix가 scaffold/handoff와 orchestrator plan에서 같은 기준으로 쓰인다.
- `team` plan 생성 시 implementer/reviewer/monitor role이 provider capability를 위반하지 않는다.
- Gemini는 write-required role에 배정되지 않는다.
- Claude team plan은 native team 또는 subagent runner prompt를 제공한다.
- Codex team plan은 custom agent/subagent 명시 실행 prompt를 제공한다.
- fixture가 provider별 role assignment와 Gemini write 금지를 검증한다.
- 문서가 single-provider 기본값, mixed-provider 후순위, 무인 실행 금지를 명시한다.

비목표:

- P2A가 Codex/Claude/Gemini 프로세스를 자동으로 여러 개 띄우는 기능.
- browser/background loop, 계정/세션/rate limit 우회.
- 여러 provider가 같은 파일을 동시에 수정하는 mixed-provider implementation.

후속:

- Hermes 고도화는 store/DB 단계로 연기한다. 실제 적용 patch 생성, skipped-verification rationale 표준화, 반복 failureClass/source/targetFiles 통계, cross-session recall, 검색/DB 저장은 지금 구현하지 않고 나중에 방향을 다시 논의한다.
- GUI supervised scheduler 표면은 완료했다. API 요금제 기반 완전 자동 개발은 비용상 보류한다. 다음 구현 축은 provider-native team orchestration adapter다. 공식 CLI/앱은 사람이 foreground에서 사용하고, p2a는 provider 선택, role/prompt/order/state, monitor gate만 조율한다. 무인 실행, browser/background loop, 계정/세션/rate limit 우회, 자동 role/monitor 호출은 계속 제외한다.

## 5. Team Big Five 완료 판단

MVP 완료:

- `team-lead` 역할을 `p2a-dev-orchestrator`가 담당한다.
- task triage와 역할별 실행 계획이 구조화 파일로 남는다.
- shared mental model과 closed-loop communication log가 runtime sidecar로 남는다.
- next-role/role-prompt/mark-role로 사람이 감독하는 role 진행 순서를 유지할 수 있다.
- contributor와 monitor가 기존 `p2a-implementer`, `p2a-performance-monitor` 계약으로 연결된다.
- CLI에서 사람이 감독하며 팀 실행을 진행할 수 있다.

완성형 완료:

- team mode에서 실패/retry/ask-user 판단이 일관되게 동작한다.
- provider capability matrix가 role 배정을 안전하게 제한한다.
- Claude/Codex/Gemini별 provider-native team runner adapter가 있다.
- single-provider team이 기본값이고, mixed-provider implementation은 기본값에서 제외된다.

## 6. Hermes와의 관계

Hermes는 orchestrator MVP 이후에 파일 기반 queue부터 붙인다. 자동 self-modify는 계속 금지하고, 실행 데이터에서 개선 후보를 모아 사람이 승인하는 방향만 허용한다.

MVP 연결:

- orchestration sidecar와 run failure metadata가 proposal 후보 입력이 된다.
- `p2a_proposals.mjs`가 proposal 후보와 review/curation/patch-draft/approval artifact를 생성하고 digest를 제공한다.
- MVP에서 proposal 자동 적용은 하지 않는다.

후속 연기 결정:

- Hermes 고도화는 현재 파일 기반 proposal bridge에서 멈춘다.
- 이전 내용 검색, run history 요약, cross-session recall, DB/vector index, 자동 patch 적용은 지금 구현하지 않는다.
- 나중에 UI/DB 기반 task store를 설계할 때 검색 대상, transcript 저장 여부, 교훈 distillation 방식, SQLite full-text/vector index 선택을 다시 논의한다.

## 7. 열린 결정

| 결정 | 기본값 |
| --- | --- |
| orchestration plan 저장 위치 | `runs/<runId>.orchestration.json`. task graph/run schema는 변경하지 않음 |
| orchestration runtime 저장 위치 | `runs/<runId>.orchestration-runtime.json`. task graph/run schema는 변경하지 않음 |
| MVP planner | deterministic CLI heuristic |
| triage 기본값 | `targetArea`의 명시 다중 영역(comma/plus/ampersand/`and`)은 `team`, acceptance criteria 6개 이상은 `solo_monitor`, 의존성 2개 이상은 risk flag만 기록하고 monitor gate를 강제하지 않음 |
| orchestrator agent 역할 | plan review/proposal. 자동 적용 없음 |
| team mode 기본 전략 | single-provider team. 선택 provider의 공식 기능을 우선 사용하고, mixed-provider implementation은 기본값에서 제외 |
| Claude team 전략 | Claude Code native agent teams/subagents를 우선 사용. experimental team 기능이 꺼져 있으면 foreground subagent/prompt로 폴백 |
| Codex team 전략 | Codex skills/custom agents/명시 subagent prompt를 사용. Codex subagent는 자동 spawn이 아니라 explicit request 기반 |
| Gemini 역할 | planning/review/monitor read-only 보조. write-required implementer에는 기본 배정하지 않음 |
| GUI 편집 여부 | plan/runtime 임의 편집은 제외. Runs 화면은 read-only 표시와 수동 `mark-role` 기록만 |
| API 기반 자동 개발 | 비용상 보류. API 키 기반 runner는 현재 개발하지 않음 |
| 구독 CLI/앱 사용 | 공식 CLI/앱을 사람이 foreground에서 사용한다. p2a는 prompt/role/order/state를 조율하고, 사용자가 승인한 입력과 상태 기록만 수행 |
| 금지 자동화 | browser/background loop, 세션 쿠키·토큰 재사용, 여러 계정 로테이션, rate limit 우회, 자동 role/monitor 호출, 무인 headless 실행 |
| supervised scheduler | `next-role`, `role-prompt`, `mark-role`은 프로세스를 실행하지 않고 prompt/상태만 다룬다 |
| Hermes queue/review/curation/patch draft/approval execution bridge | `p2a_proposals.mjs` deterministic mining/review/curation/draft-patch/approve-draft + `p2a_execute --approval` 감독형 실행 연결. 자동 적용 없음 |

## 8. Provider 공식 기능 기준

O8은 각 provider가 공식적으로 제공하는 확장 지점을 사용한다. 이 표는 구현 판단의 현재 기준이다.

| Provider | 공식 기능 기준 | P2A 적용 |
| --- | --- | --- |
| Claude Code | subagents, plugins, skills, agent teams | native team runner 우선. agent teams는 experimental이므로 사용 가능 여부를 감지하고 subagent/prompt로 폴백 |
| Codex | skills, plugins, custom agents, subagents | Codex-native team skill과 custom agent를 만들고, subagent 사용은 prompt에서 명시한다 |
| Gemini CLI | extensions, custom commands, `GEMINI.md`, MCP | planning/review/monitor read-only adapter. 공식 docs 기준 team/subagent runner가 확인되기 전까지 implementer 제외 |

공통 원칙:

- P2A는 provider의 공식 CLI/앱/확장 기능 밖으로 우회하지 않는다.
- 구독 로그인 기반 사용은 사람이 foreground에서 승인·감독한다.
- P2A는 role, prompt, order, runtime state, monitor gate를 기록하고 조율한다.
- 자동 role 실행, browser/background loop, 세션 쿠키·토큰 재사용, 여러 계정 로테이션, rate limit 우회는 금지한다.
