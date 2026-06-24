# 02-1 p2a-dev-orchestrator 개발 계획

작성일: 2026-06-23 · 상태: MVP 1차 구현 완료, O7 Hermes proposal queue/review/curation/patch draft/approval gate MVP 완료 · 상위 문서: `plans/02-development-team-ai-agent.md` · 연결 문서: `plans/01-product-roadmap.md`, `plans/03-p2a-gui-mvp.md`

이 문서는 Team Big Five의 `team-lead` 역할을 Plan2Agent-native로 구현하기 위한 최소 개발 계획이다. 목표는 여러 agent를 무인으로 돌리는 것이 아니라, 기존 CLI-first 하네스 위에서 **어떤 task를 solo/team으로 처리할지 판단하고, 역할별 실행 계획과 검증 흐름을 파일로 남기는 것**이다. GUI는 이 결과를 나중에 읽는 보조 표면으로 둔다.

## 0. 이번 브랜치 구현 상태

1차 구현 범위:

- `orchestration-plan.schema.json`과 validator 연결.
- `p2a_orchestrate.mjs plan/show/validate/handoff` CLI.
- `p2a_execute start --orchestration-plan <path>` run sidecar 연결.
- monitor verdict 기반 `finish` 차단/blocked 변환.
- `p2a-dev-orchestrator` read-only agent와 CLI mirror.
- scaffold/handoff 복사 대상, fixture, CLI 문서 갱신.
- `p2a_proposals.mjs`가 run failure, monitor verdict, verification gap에서 Hermes식 proposal queue/review/curation/patch draft/approval gate를 생성·검증·요약.

후속으로 남김:

- GUI 표시.
- 병렬 scheduler.
- 실제 적용 patch 생성.
- agent-generated orchestration plan.

## 1. 현재 전제

완료된 기반:

- `p2a_tasks.mjs`: task ready/start/done/block 상태와 의존성 관리.
- `p2a_runs.mjs`: run log, verification, changedFiles, workspaceRef, failureClass 기록.
- `p2a_execute.mjs`: ready task 1건의 start/finish/status lifecycle.
- `apps/p2a-gui`: PTY 세션, task/run/artifact 표시, start/finish 감독 UI. MVP 구현의 선행 조건은 아니다.
- `p2a-implementer`: Codex/Claude 구현자 계약. Gemini는 read-only.
- `p2a-performance-monitor`: 실행 결과 독립 검증 계약.
- `p2a-skill-curator`: Hermes식 proposal 검토 계약.
- Team Big Five adapter 설치: CLI별 kickoff 파일 설치와 source manifest 기록.

아직 후속으로 남긴 것:

- agent-generated orchestration plan.
- shared mental model 파일과 closed-loop communication 기록.
- 실제 multi-session PTY scheduler.
- 실패 시 retry/ask/blocked 판단 규칙.

## 2. MVP 목표

MVP는 아래를 개발 완료 기준으로 본다.

| 기능 | 완료 기준 |
| --- | --- |
| deterministic task triage | task metadata, dependency, acceptance criteria를 읽고 규칙 기반으로 `solo`, `solo_monitor`, `team` 중 하나를 추천한다 |
| execution plan | 역할, agent tool, 작업 범위, 검증 명령, monitor gate를 구조화 JSON으로 만든다 |
| supervised CLI handoff | CLI에서 사람이 열 수 있는 agent별 session command/prompt를 출력한다 |
| run 연결 | orchestration plan id와 역할별 session 결과를 `runs/<runId>.orchestration.json` sidecar로 추적한다 |
| monitor gate | finish 전에 필요한 verdict 경로와 허용 verdict, failureClass mapping을 명시한다 |
| 안전 경계 | planning artifact 직접 수정, 무인 실행, 자동 push/merge를 금지한다 |

MVP에서 하지 않는 것:

- headless 무인 실행.
- 여러 CLI 세션의 완전 자동 병렬 scheduler.
- 사용자 승인 없는 dependency install, PR 생성, push, merge.
- Gemini write 실행.
- Hermes proposal 자동 적용.
- GUI 표시와 편집.
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

5. run sidecar
   - 저장 위치는 `runs/<runId>.orchestration.json`로 고정한다.
   - MVP에서는 `task-graph.schema.json`과 `run.schema.json`을 바꾸지 않는다.
   - run log에는 필요할 때 표시용 plan id만 문자열로 남기고, 상세 계약은 sidecar가 정본이다.

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
- finish 시 `monitorGate.required`가 true이면 `monitorGate.verdictPath`의 verdict를 확인한다.
- 허용되지 않은 verdict는 `failureClassMap`에 따라 기존 failureClass로 변환한다.

완료 기준:

- run show/list에서 orchestration mode와 plan id를 확인할 수 있다.
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

### O6. GUI 표시 후속

- Tasks 또는 Terminal 화면에서 orchestration mode와 역할별 handoff를 보여준다.
- 사용자는 plan을 보고 각 agent 세션을 열 수 있다.
- GUI는 plan을 임의 수정하지 않고 CLI/파일 상태를 읽는다.

완료 기준:

- solo task는 기존 단일 task 흐름을 방해하지 않는다.
- team task는 역할별 prompt/command와 monitor gate가 한 화면에서 확인된다.

### O7. Hermes proposal queue/review/curation/patch draft/approval gate MVP

- orchestration 결과에서 반복 실패, scope drift, verification gap을 proposal 후보로 만든다.
- 자동 적용은 금지하고 `p2a-skill-curator` 검토 대상으로만 남긴다.

완료 기준:

- `p2a_proposals.mjs mine`이 run log, orchestration sidecar, monitor verdict를 읽어 `skill-proposal` JSON을 만든다.
- 손상된 run file은 `mine`에서 warning 후 skip하고 나머지 run 분석은 계속한다. 감사용 `validate`는 계속 엄격하게 실패한다.
- `list/show/digest/review/curate/draft-patch/approve-draft/validate`로 사람이 큐와 review/curation/patch-draft/approval artifact를 검토하고 승인 항목을 maintenance task로 연결할 수 있다.
- `validate_artifacts --proposals-dir`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`이 proposal directory와 review/curation/patch-draft/approval artifact 계약을 검증한다.
- scaffold/handoff 대상 프로젝트에 CLI와 schema가 포함된다.
- fixture가 monitor-blocked run에서 proposal을 생성하고 digest/review/curation/patch-draft까지 확인한다.

후속:

- 실제 적용 patch 생성.
- docs/config-only task의 verification-gap 노이즈를 줄이기 위한 skipped-verification rationale 표준화.
- 반복 failureClass/source/targetFiles 빈도 기반 proposal 우선순위.
- cross-session recall.
- 반복 실패 유형 통계.

## 5. Team Big Five 완료 판단

MVP 완료:

- `team-lead` 역할을 `p2a-dev-orchestrator`가 담당한다.
- task triage와 역할별 실행 계획이 구조화 파일로 남는다.
- contributor와 monitor가 기존 `p2a-implementer`, `p2a-performance-monitor` 계약으로 연결된다.
- CLI에서 사람이 감독하며 팀 실행을 진행할 수 있다.

완성형 완료:

- shared mental model 파일이 실행 중 유지된다.
- closed-loop communication 결과가 run history에 남는다.
- team mode에서 실패/retry/ask-user 판단이 일관되게 동작한다.
- 여러 session을 병렬/순차로 안전하게 조율하는 scheduler가 있다.

## 6. Hermes와의 관계

Hermes는 orchestrator MVP 이후에 파일 기반 queue부터 붙인다. 자동 self-modify는 계속 금지하고, 실행 데이터에서 개선 후보를 모아 사람이 승인하는 방향만 허용한다.

MVP 연결:

- orchestration sidecar와 run failure metadata가 proposal 후보 입력이 된다.
- `p2a_proposals.mjs`가 proposal 후보와 review/curation/patch-draft/approval artifact를 생성하고 digest를 제공한다.
- MVP에서 proposal 자동 적용은 하지 않는다.

후속:

- curator가 normalize/dedupe/prioritize.
- 사람 승인 후 별도 patch turn에서만 반영.
- cross-session recall.
- run history 검색/요약.
- 반복 실패 유형 통계.
- skill/prompt/template 개선 후보 큐.

## 7. 열린 결정

| 결정 | 기본값 |
| --- | --- |
| orchestration plan 저장 위치 | `runs/<runId>.orchestration.json`. task graph/run schema는 변경하지 않음 |
| MVP planner | deterministic CLI heuristic |
| triage 기본값 | `targetArea`의 명시 다중 영역(comma/plus/ampersand/`and`)은 `team`, acceptance criteria 6개 이상은 `solo_monitor`, 의존성 2개 이상은 risk flag만 기록하고 monitor gate를 강제하지 않음 |
| orchestrator agent 역할 | plan review/proposal. 자동 적용 없음 |
| team mode 기본 agent | Codex contributor + monitor. Claude는 사용자가 선택한 경우 |
| Gemini 역할 | read-only reviewer/planner |
| GUI 편집 여부 | MVP 제외. 후속에서는 read-only 표시와 handoff 실행만 |
| 무인 실행 | API 키 기반 별도 설계 전까지 제외 |
| Hermes queue/review/curation/patch draft/approval gate | `p2a_proposals.mjs` deterministic mining/review/curation/draft-patch/approve-draft + 사람 승인. 자동 적용 없음 |
