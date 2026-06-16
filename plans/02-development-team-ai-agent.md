# 개발팀 AI agent 구성 계획

작성일: 2026-06-16  
다음 작업 기준일: 2026-06-17

이 문서는 Plan2Agent의 Gate A-D planning harness 다음 단계로, 실제 개발 task를 수행하는 개발팀 AI agent 계층을 구성하기 위한 작업 메모다. 내일은 이 문서를 기준으로 간단한 웹서비스를 실제로 개발하면서 하네스가 planning -> task -> implementation -> verification -> run log까지 이어지는지 확인한다.

## 1. 현재 상태

이미 준비된 것:

- Gate A-D planning harness는 기획 산출물 생성, 승인, task graph, review까지 다룬다.
- `p2a_tasks.mjs`는 승인된 task graph에서 ready task, prompt, start/done/block 상태 전이를 관리한다.
- `p2a_runs.mjs`는 task별 실행 로그, changed files, test/lint/typecheck 결과, branch/worktree 격리 기준을 기록한다.
- handoff/scaffold는 대상 프로젝트에 P2A 도구와 선택적 Team Big Five adapter를 설치할 수 있다.
- 현재 `.agents/skills/p2a-harness/SKILL.md`와 planning subagent는 의도적으로 소스 코드 수정, dependency 설치, 구현 shell 실행을 금지한다.

아직 없는 것:

- 실제 코드를 수정하는 `p2a-implementer` 역할.
- task 실행을 조율하는 `p2a-dev-orchestrator` skill/agent.
- 구현 결과를 독립적으로 검증하는 `p2a-performance-monitor` 또는 `p2a-verifier`.
- 반복 작업 결과를 skill 개선 제안으로 남기는 `p2a-skill-curator`.
- write-capable agent를 CLI mirror로 생성하는 neutral metadata/sync 규칙.

중요한 경계:

- 기존 planning harness는 계속 read-only planning 계층으로 유지한다.
- 개발 실행 계층은 별도 skill/agent로 추가한다.
- 첫 MVP는 PTY 기반 자동 agent 실행기가 아니라, Codex/Claude/Gemini 세션에서 명시적으로 호출할 수 있는 개발팀 skill/subagent 구성이다.

## 2. 참고 레포에서 가져올 아이디어

Hermes agent에서 가져올 것:

- Skill은 반복 가능한 절차 기억으로 둔다.
- 한 번의 실행으로 바로 skill을 고치지 않고, 실행 후 retrospective에서 skill proposal을 만든다.
- skill 생성/수정은 staged proposal -> review -> approval -> apply 흐름으로 둔다.
- agent가 모르는 최신 기술이나 도구는 필요한 시점에 조사하고 근거를 남긴다.

Team Big Five에서 가져올 것:

- 모든 task에 팀 오버헤드를 붙이지 않고, 복잡도에 따라 solo/team 실행 모드를 고른다.
- `team lead`, `contributor`, `performance monitor` 역할을 분리한다.
- shared mental model을 짧은 실행 컨텍스트로 유지한다.
- 구현자는 완료 보고를 하고, monitor가 acceptance criteria와 검증 명령을 확인한다.
- closed-loop communication을 강제해서 task 의도, 변경 파일, 검증 결과, 남은 위험을 명시한다.

주의:

- 외부 레포의 코드를 그대로 복사하지 않는다.
- Hermes는 skill lifecycle 패턴을, Team Big Five는 팀 운영 패턴을 차용한다.
- Team Big Five 쪽은 실제 코드/문서 복사 전 라이선스와 사용 범위를 다시 확인한다.

## 3. 목표 아키텍처

세 계층으로 분리한다.

| 계층 | 책임 | 파일/도구 |
| --- | --- | --- |
| Planning layer | 아이디어를 승인된 spec/task graph로 변환 | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Execution layer | 승인된 task를 실제 코드 변경과 검증으로 수행 | `p2a-dev-execution`, `p2a-dev-orchestrator`, `p2a-implementer`, `p2a-performance-monitor` |
| Skill evolution layer | 반복 실행 결과를 skill 개선 제안으로 축적 | `p2a-skill-curator`, `skill-proposal.json` |

기본 실행 흐름:

```text
p2a_tasks ready
-> p2a_tasks prompt <task-id>
-> p2a_runs start <task-id>
-> p2a-dev-execution skill 호출
-> dev orchestrator가 solo/team 모드 결정
-> implementer가 코드 수정
-> performance monitor가 acceptance/test/lint/typecheck 검증
-> p2a_runs verify/finish
-> p2a_tasks done 또는 block
-> skill curator가 개선 제안이 있으면 proposal 작성
```

## 4. 내일 구현할 MVP

MVP 목표:

- 간단한 웹서비스 task 하나 이상을 실제로 코드 변경까지 수행한다.
- planning skill은 그대로 안전하게 유지한다.
- 실행 skill은 승인된 task graph와 ready task만 입력으로 받는다.
- 구현 결과는 `p2a_runs.mjs` run log에 남긴다.
- 구현 과정에서 반복되는 절차 개선점은 바로 skill을 고치지 않고 proposal로 남긴다.

추가할 canonical skill:

- `.agents/skills/p2a-dev-execution/SKILL.md`
  - 승인된 task를 실제 개발 작업으로 수행하는 상위 실행 workflow.
  - 입력: ready task id, task graph, spec, project config, optional run id.
  - 출력: 변경 요약, changed files, verification summary, task status recommendation.
  - 금지: Gate B-D 미통과 task 실행, 무근거 dependency 설치, secret 접근, planning artifact 무단 수정.

- `.agents/skills/p2a-skill-evolution/SKILL.md`
  - 개발 실행 후 skill 개선 필요성을 proposal로 정리.
  - 바로 skill을 수정하지 않고 `skill-proposal.json` 또는 Markdown proposal을 만든다.
  - 사용자 승인 후 별도 turn에서 skill patch를 적용한다.

추가할 canonical agents:

- `.agents/agents/p2a-dev-orchestrator.md`
  - task context를 읽고 solo/team 모드를 결정한다.
  - shared mental model을 만든다.
  - 구현자와 monitor에게 넘길 작업 범위를 정한다.

- `.agents/agents/p2a-implementer.md`
  - 실제 코드 수정 담당.
  - write-capable agent로 만들 경우 `sync_cli_assets.mjs`의 access/capability 모델을 확장해야 한다.
  - MVP에서 CLI별 write-capable subagent 지원이 불명확하면 main Codex/Claude/Gemini 세션이 implementer 역할을 수행하고, 이 파일은 role prompt로만 둔다.

- `.agents/agents/p2a-performance-monitor.md`
  - acceptance criteria, test/lint/typecheck 결과, changed files를 검토한다.
  - 실패 시 `done` 대신 `block` 또는 follow-up task를 권장한다.

- `.agents/agents/p2a-skill-curator.md`
  - 실행 후 반복된 실수, 누락된 검증, 유용한 절차를 skill proposal로 정리한다.
  - 직접 skill을 수정하지 않는다.

동기화/검증 스크립트 변경:

- `scripts/sync_cli_assets.mjs`
  - 신규 skill/agent mirror 생성이 되도록 한다.
  - write-capable agent를 지원할지 결정한다.
  - 지원한다면 `access: workspace-write`와 `capabilities: edit, shell` 같은 neutral metadata를 추가하고 CLI별 tool/sandbox mapping을 명확히 둔다.

- `scripts/check_cli_parity.mjs`
  - 신규 skill/agent 목록과 Gemini command shim을 검증한다.

가능하면 추가할 schema:

- `schemas/skill-proposal.schema.json`
  - skill 개선 제안을 구조화한다.
  - 필드 후보: `proposalId`, `sourceRunId`, `problem`, `evidence`, `recommendedChange`, `targetFiles`, `risk`, `approval`.

## 5. 안전 정책

실행 skill은 다음 조건을 만족할 때만 코드를 수정한다.

- task가 `p2a_tasks ready`에 노출되는 상태다.
- Gate B spec이 approved이고 open decisions가 없다.
- Gate D review blockers가 없다.
- task acceptance criteria가 있다.
- 사용자가 구현 실행을 명시했다.

실행 skill이 하면 안 되는 일:

- planning artifact를 우회해서 새 요구사항을 임의로 추가.
- dependency를 최신이라는 이유만으로 무근거 설치.
- `.env`, credential, token, private key 접근 또는 출력.
- 실패한 검증을 숨기고 task를 done 처리.
- skill 파일을 자동으로 self-modify.

write-capable subagent를 추가할 때의 별도 주의:

- planning subagent는 계속 `read-only`로 둔다.
- 구현 subagent만 `workspace-write`를 허용한다.
- shell capability는 검증 명령 중심으로 제한한다.
- CLI별 권한 모델이 다르므로 Codex, Claude, Gemini mirror 결과를 각각 확인한다.

## 6. 간단한 웹서비스 테스트 시나리오

내일 smoke test 후보:

- 작은 CRUD 또는 bookmark 웹서비스.
- Node.js 기반 최소 웹앱 또는 현재 scaffold가 감지하기 쉬운 프레임워크.
- 외부 DB 없이 파일/메모리 저장소로 시작.
- 테스트 명령이 빠르게 끝나는 구조.

테스트 절차:

1. 새 대상 프로젝트를 만들거나 co-located scaffold를 사용한다.
2. 한 문장 아이디어로 Gate A-D planning을 통과시킨다.
3. `node scripts/p2a_iteration.mjs init --artifacts artifacts/<project_id>`로 반복 구조를 만든다.
4. `node scripts/p2a_tasks.mjs ready --artifacts artifacts/<project_id>`로 실행 가능한 task를 확인한다.
5. `node scripts/p2a_runs.mjs start --artifacts artifacts/<project_id> <task-id>`로 run을 시작한다.
6. `p2a-dev-execution` skill로 task를 실제 구현한다.
7. `node scripts/p2a_runs.mjs verify ...`로 test/lint/typecheck 결과를 기록한다.
8. 통과하면 `p2a_tasks done`, 실패하면 `p2a_tasks block`으로 상태를 반영한다.
9. monitor가 acceptance criteria와 변경 파일이 맞는지 검토한다.
10. skill curator가 개선 제안이 있으면 proposal로 남긴다.

완료 기준:

- 최소 1개 task가 실제 코드 변경으로 완료된다.
- run log에 `changedFiles`와 verification 결과가 남는다.
- task graph 상태가 `done` 또는 명확한 `blocked`로 업데이트된다.
- planning harness의 read-only 안전 경계가 깨지지 않는다.
- 신규 skill/agent mirror parity가 통과한다.

## 7. 내일 작업 순서

권장 순서:

1. 이 문서를 기준으로 구현 범위를 다시 확인한다.
2. `scripts/sync_cli_assets.mjs`의 read-only 전제를 먼저 점검한다.
3. write-capable subagent를 바로 지원할지, MVP에서는 main agent가 implementer 역할을 수행할지 결정한다.
4. `p2a-dev-execution` skill을 먼저 추가한다.
5. dev orchestrator, implementer, performance monitor, skill curator agent를 추가한다.
6. 필요한 경우 `p2a-skill-evolution` skill과 `skill-proposal` schema를 추가한다.
7. mirror sync와 parity 검증을 통과시킨다.
8. 간단한 웹서비스로 planning -> execution -> run log까지 end-to-end smoke test를 실행한다.

검증 명령:

```bash
node --check scripts/sync_cli_assets.mjs
node --check scripts/check_cli_parity.mjs
node scripts/sync_cli_assets.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
git diff --check
```

## 8. 열려 있는 결정

내일 결정해야 할 것:

- write-capable subagent를 CLI mirror 수준에서 바로 지원할지 여부.
- 첫 MVP의 실제 구현 agent를 Codex only로 둘지, Claude/Gemini mirror까지 같은 날 맞출지 여부.
- `p2a-skill-evolution`을 별도 skill로 둘지, `p2a-dev-execution`의 retrospective section으로 먼저 시작할지 여부.
- 간단한 웹서비스 smoke test의 정확한 예제 주제.

권장 기본값:

- 구현은 Codex 기준으로 먼저 검증한다.
- planning skill은 절대 완화하지 않는다.
- write-capable agent 지원은 추가하되, 실패하면 MVP에서는 main agent가 implementer 역할을 수행하도록 fallback한다.
- skill 개선은 자동 적용하지 않고 proposal만 만든다.
