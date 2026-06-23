# 02-1 p2a-dev-orchestrator 개발 계획

작성일: 2026-06-23 · 상태: 개발 전 · 상위 문서: `plans/02-development-team-ai-agent.md` · 연결 문서: `plans/01-product-roadmap.md`, `plans/03-p2a-gui-mvp.md`

이 문서는 Team Big Five의 `team-lead` 역할을 Plan2Agent-native로 구현하기 위한 최소 개발 계획이다. 목표는 여러 agent를 무인으로 돌리는 것이 아니라, 기존 CLI/GUI 감독 흐름 위에서 **어떤 task를 solo/team으로 처리할지 판단하고, 역할별 실행 계획과 검증 흐름을 남기는 것**이다.

## 1. 현재 전제

완료된 기반:

- `p2a_tasks.mjs`: task ready/start/done/block 상태와 의존성 관리.
- `p2a_runs.mjs`: run log, verification, changedFiles, workspaceRef, failureClass 기록.
- `p2a_execute.mjs`: ready task 1건의 start/finish/status lifecycle.
- `apps/p2a-gui`: PTY 세션, task/run/artifact 표시, start/finish 감독 UI.
- `p2a-implementer`: Codex/Claude 구현자 계약. Gemini는 read-only.
- `p2a-performance-monitor`: 실행 결과 독립 검증 계약.
- `p2a-skill-curator`: Hermes식 proposal 검토 계약.
- Team Big Five adapter 설치: CLI별 kickoff 파일 설치와 source manifest 기록.

아직 없는 것:

- `team-lead` 판단을 담당하는 P2A-native orchestrator.
- solo/team mode 자동 판단.
- 역할별 session plan과 shared mental model 파일.
- orchestrator 결과를 run log/GUI에 남기는 계약.
- 실패 시 retry/ask/blocked 판단 자동화.

## 2. MVP 목표

MVP는 아래를 개발 완료 기준으로 본다.

| 기능 | 완료 기준 |
| --- | --- |
| task triage | task metadata, dependency, acceptance criteria를 읽고 `solo`, `solo+monitor`, `team` 중 하나를 추천한다 |
| execution plan | 역할, agent tool, 작업 범위, 검증 명령, monitor gate를 구조화 JSON으로 만든다 |
| supervised handoff | GUI/CLI에서 사람이 열 수 있는 agent별 session command/prompt를 제공한다 |
| run 연결 | orchestration plan id와 역할별 session 결과를 run log sidecar로 추적한다 |
| monitor gate | finish 전에 monitor verdict가 필요한 조건을 명시하고 결과를 기록한다 |
| 안전 경계 | planning artifact 직접 수정, 무인 실행, 자동 push/merge를 금지한다 |

MVP에서 하지 않는 것:

- headless 무인 실행.
- 여러 CLI 세션의 완전 자동 병렬 scheduler.
- 사용자 승인 없는 dependency install, PR 생성, push, merge.
- Gemini write 실행.
- Hermes proposal 자동 적용.

## 3. 산출물

1. `schemas/orchestration-plan.schema.json`
   - `schema_version`
   - `projectId`, `taskId`, `sourceTaskGraph`
   - `mode`: `solo` | `solo_monitor` | `team`
   - `roles`: `lead`, `contributor`, `reviewer`, `monitor`
   - `agentTool`: `codex` | `claude` | `gemini` | `manual`
   - `scope`, `acceptanceCriteria`, `verificationPlan`
   - `handoffPrompts`
   - `monitorGate`
   - `riskFlags`

2. `.agents/agents/p2a-dev-orchestrator.md`
   - read-only team-lead agent 계약.
   - task를 분석하고 orchestration plan만 작성한다.
   - 직접 코드 수정, run finish, task done/block 처리는 하지 않는다.

3. CLI mirror
   - `.codex/agents/p2a-dev-orchestrator.toml`
   - `.claude/agents/p2a-dev-orchestrator.md`
   - `.gemini/commands/p2a/dev-orchestrator.toml`
   - `sync_cli_assets.mjs`, `check_cli_parity.mjs`에 포함.

4. `scripts/p2a_orchestrate.mjs`
   - `plan`: ready task 기준 orchestration plan 생성/검증.
   - `show`: 저장된 plan 표시.
   - `validate`: schema와 task/run 참조 검증.
   - `handoff`: 역할별 agent prompt/command 출력.

5. run sidecar
   - `runs/<runId>.orchestration.json` 또는 run log의 `orchestration` 필드.
   - MVP에서는 task graph schema를 바꾸지 않는다.

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
- Codex/Claude/Gemini mirror 생성.
- `check_cli_parity.mjs`에 포함.

완료 기준:

- agent 계약이 코드 수정과 lifecycle 종료를 금지한다.
- CLI mirror drift 검증 green.

### O3. CLI plan/handoff

- `p2a_orchestrate.mjs plan --artifacts <dir> --task <task-id>` 구현.
- plan은 기본적으로 deterministic heuristic으로 만든다.
- agent가 개입하는 판단은 후속으로 두고, MVP는 명확한 규칙부터 고정한다.
- `handoff`는 역할별 prompt와 GUI/터미널에서 열 command를 출력한다.

완료 기준:

- ready task만 orchestration plan을 만들 수 있다.
- not-ready task, open decision, acceptance criteria 누락은 실패한다.
- `run_fixtures.mjs`에 orchestrator fixture가 포함된다.

### O4. Run lifecycle 연결

- `p2a_execute start` 또는 별도 `p2a_orchestrate handoff`가 plan id를 run에 연결한다.
- finish 시 monitor gate 필요 여부와 verdict를 확인한다.
- blocked/failed 결과는 기존 failureClass를 사용한다.

완료 기준:

- run show/list에서 orchestration mode와 plan id를 확인할 수 있다.
- monitor gate가 필요한 run은 verdict 없이 done 처리되지 않는다.

### O5. GUI 표시

- Tasks 또는 Terminal 화면에서 orchestration mode와 역할별 handoff를 보여준다.
- 사용자는 plan을 보고 각 agent 세션을 열 수 있다.
- GUI는 plan을 임의 수정하지 않고 CLI/파일 상태를 읽는다.

완료 기준:

- solo task는 기존 단일 task 흐름을 방해하지 않는다.
- team task는 역할별 prompt/command와 monitor gate가 한 화면에서 확인된다.

### O6. Hermes 연결

- orchestration 결과에서 반복 실패, scope drift, verification gap을 proposal 후보로 만든다.
- 자동 적용은 금지하고 `p2a-skill-curator` 검토 대상으로만 남긴다.

완료 기준:

- run history에서 개선 후보 digest를 만들 수 있다.
- 승인 전에는 skill/agent/schema가 수정되지 않는다.

## 5. Team Big Five 완료 판단

MVP 완료:

- `team-lead` 역할을 `p2a-dev-orchestrator`가 담당한다.
- task triage와 역할별 실행 계획이 구조화 파일로 남는다.
- contributor와 monitor가 기존 `p2a-implementer`, `p2a-performance-monitor` 계약으로 연결된다.
- GUI/CLI에서 사람이 감독하며 팀 실행을 진행할 수 있다.

완성형 완료:

- shared mental model 파일이 실행 중 유지된다.
- closed-loop communication 결과가 run history에 남는다.
- team mode에서 실패/retry/ask-user 판단이 일관되게 동작한다.
- 여러 session을 병렬/순차로 안전하게 조율하는 scheduler가 있다.

## 6. Hermes와의 관계

Hermes는 orchestrator 이후에 고도화한다. 이유는 자가발전은 실행 데이터가 쌓인 뒤 효과가 있기 때문이다.

MVP 연결:

- orchestrator run 결과를 proposal 후보로 요약.
- curator가 normalize/dedupe/prioritize.
- 사람 승인 후 별도 patch turn에서만 반영.

후속:

- cross-session recall.
- run history 검색/요약.
- 반복 실패 유형 통계.
- skill/prompt/template 개선 후보 큐.

## 7. 열린 결정

| 결정 | 기본값 |
| --- | --- |
| orchestration plan 저장 위치 | run sidecar 우선. task graph는 변경하지 않음 |
| team mode 기본 agent | Codex contributor + monitor. Claude는 사용자가 선택한 경우 |
| Gemini 역할 | read-only reviewer/planner |
| GUI 편집 여부 | MVP에서는 read-only 표시와 handoff 실행만 |
| 무인 실행 | API 키 기반 별도 설계 전까지 제외 |
