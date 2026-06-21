# P2A GUI MVP 계획

작성일: 2026-06-21 · 상태: 범위 확정 초안 · 연결 문서: `plans/02-development-team-ai-agent.md`, `.agents/skills/p2a-design-system/SKILL.md`

이 문서는 Plan2Agent Phase 2의 **PTY+Electron 감독 GUI**를 제품 MVP로 고정한다. 목표는 완전한 multi-agent orchestration이 아니라, 현재 구현된 파일 기반 하네스와 감독형 단일 task 실행기 Phase 1을 데스크톱 UI에서 읽고, 실행하고, 사람이 감독할 수 있게 만드는 것이다.

## 0. 현재 결론

P2A GUI MVP는 **단일 task 감독 실행 GUI**다.

핵심 흐름:

```text
프로젝트 폴더 선택
-> P2A 설치 상태 감지
-> Open / Install / Import / Upgrade / Repair 중 필요한 진입 선택
-> gate/iteration/task 상태 확인
-> ready task 선택
-> task detail과 acceptance criteria 확인
-> PTY 세션으로 Codex/Claude CLI 실행
-> 실행 중 terminal과 Message agent 입력으로 감독
-> verification 결과와 run record 확인
-> done 또는 blocked 처리
```

MVP는 기존 파일 구조를 단일 진실원으로 둔다. GUI가 별도 DB나 API 서버를 정본으로 만들지 않는다.

## 1. 제품 목표

사용자가 P2A 프로젝트의 현재 상태를 빠르게 파악하고, ready task 1건을 실제 agent CLI 실행까지 안전하게 감독할 수 있게 한다.

첫 화면에서 답해야 하는 질문:

- 현재 프로젝트와 active iteration이 무엇인가.
- Gate A-D 중 어디까지 진행됐고 무엇이 막혀 있는가.
- 지금 실행 가능한 task가 무엇인가.
- 선택한 task를 실행하면 어떤 command, cwd, run record가 생기는가.
- agent가 지금 무엇을 하고 있고, 사람이 답하거나 승인해야 하는 것이 있는가.
- 실행 결과가 done인지 blocked인지 판단할 근거가 무엇인가.

## 2. 기본 UX

기본 shell은 `p2a-design-system`의 workbench 레이아웃을 따른다.

```text
titlebar: project / workspace / active iteration / run state
activity rail: Overview / Tasks / Runs / Artifacts / Terminal / Settings
sidebar: task list, filters, recent runs
main workbench: PTY console, artifact viewer, or run detail
inspector: selected task/run details, criteria, approvals, changed files
statusbar: branch / cwd / run id / duration / token-cost metadata
```

디자인 기준:

- `p2a-design-system` 내부 packaged references를 사용한다.
- Harness는 shell, transcript, DotChar agent state, provider tint의 기준이다.
- DevSync는 table, badge, modal, tab, input, dense row pattern의 보조 기준이다.
- PTY/transcript는 실행 화면의 주 객체이며 card preview처럼 숨기지 않는다.
- UI 문구는 짧고 사실적으로 쓴다. emoji, exclamation, marketing hero를 쓰지 않는다.

## 3. Project onboarding / detection

P2A GUI 앱은 중앙 DB를 가진 별도 제품이 아니라, **선택한 프로젝트 디렉터리에 P2A 하네스를 설치하고 그 파일 기반 상태를 읽고 실행하는 데스크톱 컨트롤러**다.

앱 첫 진입점:

```text
Recent projects
Open project folder
Install P2A into folder
Import planning bundle
```

용어와 CLI 대응:

| UI 용어 | 의미 | CLI 대응 |
| --- | --- | --- |
| Open P2A Project | 이미 P2A가 설치된 프로젝트를 연다 | 파일 감지 + read-only load |
| Install P2A | 일반 코드 프로젝트에 P2A 하네스를 설치한다 | `node scripts/p2a_handoff.mjs scaffold --target <project-dir> --tools all` |
| Import Plan | 외부 planning artifact bundle을 현재 프로젝트로 가져온다 | `node scripts/p2a_handoff.mjs --project-id <id> --artifacts <path> --target <project-dir> --tools all` |
| Upgrade Harness | 설치된 scripts/schemas/skills를 앱에 포함된 현재 버전으로 갱신한다 | scaffold/handoff asset copy 계약을 재사용하되 artifacts와 source code는 보존 |
| Repair / Validate | 누락/드리프트를 진단하고 안전하게 복구 가능한 항목만 제안한다 | validate + generated asset 복구 |

프로젝트 선택 후 detection 상태:

| 상태 | 감지 기준 | 기본 UI |
| --- | --- | --- |
| No P2A | `.plan2agent/manifest.json`, `PLAN2AGENT.md`, P2A scripts가 없음 | Install P2A |
| Installed empty | P2A harness는 있으나 planning artifacts가 없음 | Start planning / Import Plan |
| Planning in progress | Gate artifact 또는 iteration이 있으나 ready task 없음 | Gate overview / Artifacts |
| Execution ready | ready task 또는 run history가 있음 | Tasks / Runs / Terminal |
| Outdated harness | manifest/source version이 앱 번들과 다름 | Upgrade Harness |
| Broken install | 필수 script/schema/manifest 일부 누락 | Repair / Validate |

mutating onboarding action 원칙:

- 실행 전 command, target path, tool targets, overwrite 여부를 보여준다.
- 기본은 dry-run preview를 먼저 보여준다.
- source code와 planning artifacts를 임의로 덮어쓰지 않는다.
- `Install P2A`, `Import Plan`, `Upgrade Harness`, `Repair`는 명시 버튼과 확인 단계를 거친다.
- 실행 결과는 log panel과 statusbar에 남긴다.
- 실패 시 stderr, exit code, 수정되지 않은 항목을 표시한다.

## 4. 단계 범위

### 2A. 정적 GUI 프로토타입

목적: 실제 Electron이나 PTY를 붙이기 전에, 화면 구조와 정보 밀도를 검증한다.

포함:

- Project onboarding screen mock.
- No P2A / Installed empty / Planning in progress / Execution ready / Outdated / Broken 상태 mock.
- Open / Install / Import / Upgrade / Repair action mock.
- mock project, task graph, run record, artifacts 데이터.
- Overview, Tasks, Runs, Artifacts, Terminal shell 화면.
- task list, selected task inspector, run detail, artifact viewer.
- PTY console처럼 보이는 transcript mock.
- Supervisor communication 입력 영역 mock.

제외:

- 실제 파일 읽기.
- Electron packaging.
- node-pty, xterm.js 실제 연결.
- task 상태 변경.
- shell command 실행.

완료 기준:

- onboarding 상태와 다음 action이 명확하다.
- 데스크톱 폭에서 workbench layout이 안정적이다.
- 긴 task id, path, log line이 UI를 깨지 않는다.
- 사용자가 ready task와 다음 action을 1분 안에 이해할 수 있다.

### 2B. Read-only Electron shell

목적: 실제 P2A 프로젝트 파일을 읽어 데스크톱 앱에서 보여준다. 이 단계는 **보기 전용**이다.

포함:

- 프로젝트 폴더 열기 또는 고정 workspace 로딩.
- `.plan2agent/`, `artifacts/`, `iterations/`, `runs/` 구조 감지.
- No P2A / Installed empty / Planning in progress / Execution ready / Outdated / Broken 상태 판정.
- Install / Import / Upgrade / Repair action의 command preview와 dry-run 결과 표시.
- active iteration 확인.
- Gate A-D 상태 표시.
- `status.md`, `spec.json`, `task-graph.json`, `review.json` 읽기.
- task 목록, status filter, dependency 표시.
- 선택한 task detail 표시.
- `runs/run-index.json`, `runs/<runId>.json` 기반 run history 표시.
- artifact viewer로 Markdown/JSON 산출물 read-only 표시.
- 파일 변경 watcher로 UI 갱신.
- 읽기 실패, schema 불일치, 누락 파일을 명확한 진단으로 표시.

제외:

- task 실행 시작.
- Codex/Claude/Gemini CLI 실행.
- PTY/xterm 연결.
- stop/kill.
- verification 실행.
- done/blocked 상태 변경.
- artifact 수정.
- shell command 실행.

데이터 소스:

| 데이터 | 파일 |
| --- | --- |
| 프로젝트 설정 | `.plan2agent/project.config.json`, `.plan2agent/manifest.json` |
| standing status | `artifacts/<project_id>/status.md`, iteration `status.md` |
| spec | `gate-b-spec/spec.json`, `current-spec.json` |
| task graph | `gate-c-task-graph/task-graph.json`, maintenance task graph |
| review | `gate-d-review/review.json`, `review-report.md` |
| runs | `runs/run-index.json`, `runs/<runId>.json` |

완료 기준:

- 실제 scaffold된 P2A 프로젝트를 열 수 있다.
- task, run, artifact 상태가 CLI 결과와 일치한다.
- 앱에서 파일을 수정하지 않는 것이 보장된다.

### 2B-1. Harness onboarding actions

목적: detection 결과에 따라 P2A 설치, planning bundle import, harness upgrade, repair를 GUI에서 명시 승인 후 수행한다. 이 단계는 `2B` read-only shell과 분리된 mutating subflow다.

포함:

- `Install P2A` 실행: `p2a_handoff.mjs scaffold --target <project-dir> --tools all`.
- `Import Plan` 실행: 외부 `artifacts/<project_id>/` 또는 iterative artifact root를 대상 프로젝트로 handoff.
- `Upgrade Harness` 실행: scripts, schemas, skills, agents, commands를 현재 앱 번들 버전으로 갱신.
- `Repair / Validate` 실행: 누락된 generated tool asset과 schema를 복구하고 validate 결과를 표시.
- dry-run preview, overwrite confirmation, 실행 log, exit code 표시.
- 실행 후 project detection과 read-only reload 자동 수행.

제외:

- 사용자 source code 자동 수정.
- planning artifact 내용 자동 수정.
- task 상태 변경.
- agent 실행.
- destructive cleanup 자동 수행.

완료 기준:

- 일반 코드 프로젝트에 GUI로 P2A harness를 설치할 수 있다.
- 외부 planning bundle을 GUI로 대상 프로젝트에 import할 수 있다.
- 설치/갱신/복구 후 CLI의 scaffold/handoff 결과와 같은 파일 구성이 된다.
- 실패 시 사용자가 어떤 파일/권한/옵션이 문제인지 알 수 있다.

### 2C. PTY 실행/감독 + Supervisor communication

목적: 선택한 ready task 1건을 Electron 앱 안에서 실제 CLI PTY 세션으로 실행하고, 사람이 실시간으로 감독한다.

포함:

- ready task 선택 후 execution session 시작.
- Electron main process에서 `node-pty`로 Codex/Claude CLI 실행.
- renderer에서 `xterm.js`로 live terminal 표시.
- stdout/stderr 실시간 표시와 scrollback 유지.
- terminal 직접 입력 지원.
- 별도 `Message agent` 입력창 제공.
- `Message agent` 입력을 PTY stdin으로 전달.
- supervisor message를 run event/log에 저장.
- agent 질문에 사용자가 답변 가능.
- approval, deny, stop, kill, mark blocked 같은 감독 이벤트 저장.
- 현재 command, cwd, task id, run id, startedAt, duration 표시.
- PTY resize, exit code, process close 상태 처리.
- 단일 active task와 단일 active PTY session만 지원.

감독 이벤트 예시:

```json
{
  "type": "supervisor_message",
  "taskId": "T-3",
  "runId": "run-20260621-001",
  "message": "priority 필드부터 구현하고 테스트는 npm test로 확인해",
  "sentAt": "2026-06-21T00:00:00.000Z"
}
```

제외:

- 여러 task 병렬 실행.
- 여러 agent 동시 실행.
- Team Big Five orchestration.
- 자동 retry.
- 자동 PR 생성.
- 자동 merge.
- 완전 무인 headless 실행.
- agent 출력의 자동 의미 판정.

완료 기준:

- 앱에서 ready task 1건을 시작하고 실제 CLI 세션이 열린다.
- 사용자가 terminal 직접 입력과 `Message agent` 입력 모두로 agent와 소통할 수 있다.
- stop/kill이 동작하고 run record에 흔적이 남는다.
- process exit 후 run summary가 표시된다.

### 2D. Finish / Verification 연결

목적: 실행 결과를 기존 `p2a_execute`/`p2a_runs`/`p2a_tasks` lifecycle에 연결한다.

포함:

- verification command 실행.
- verification exit code, duration, output snippet 표시.
- changed files 표시.
- run finish 기록.
- task `done` 처리.
- task `blocked` 처리와 blocker reason 기록.
- monitor verdict가 있을 경우 inspector에 표시.

제외:

- 자동 done 판정.
- 자동 코드 수정.
- PR 생성.
- reviewer comment 자동 반영.

완료 기준:

- CLI에서 `p2a_execute.mjs finish`로 하던 마무리 흐름을 GUI에서 수행할 수 있다.
- done/blocked 상태가 task graph와 run log에 일관되게 기록된다.

## 5. MVP 전체 포함 범위

- Project onboarding / detection.
- Install P2A, Import Plan, Upgrade Harness, Repair / Validate.
- Project/iteration overview.
- Gate A-D 상태 보기.
- task list와 task detail.
- run history와 run detail.
- read-only artifact viewer.
- 단일 active PTY session.
- Supervisor communication.
- verification 실행과 결과 표시.
- done/blocked 마무리.
- 파일 기반 watcher refresh.

## 6. MVP 전체 제외 범위

- multi-project workspace manager.
- 여러 task 병렬 실행.
- multi-agent 팀 orchestration.
- scheduler.
- 완전 무인 headless 실행.
- API-key 기반 cloud runner.
- PR 자동 생성/merge.
- 외부 issue tracker 연동.
- marketplace/plugin 관리 UI.
- rich Markdown editor.
- 복잡한 diff editor.
- 사용자 계정/권한 시스템.
- DB/API 서버를 정본으로 하는 task store.

## 7. 아키텍처 원칙

| 계층 | 책임 |
| --- | --- |
| Electron main | app lifecycle, project detection, scaffold/handoff/upgrade/repair runner, file read, watcher, PTY spawn, process lifecycle |
| Preload IPC | renderer에 안전한 read/execute API만 노출 |
| Renderer | onboarding UI, workbench UI, xterm surface, task/run/artifact views |
| P2A CLI bridge | 기존 `p2a_handoff`, `validate_artifacts`, `p2a_tasks`, `p2a_runs`, `p2a_execute` 계약 호출 |
| Filesystem | P2A artifact와 run log의 단일 진실원 |

원칙:

- renderer가 임의 shell command를 직접 실행하지 않는다.
- scaffold/handoff/upgrade/repair는 Electron main의 제한된 command runner를 통해서만 수행한다.
- mutating action은 command, cwd, target workspace, task id, run id를 UI에 노출한다.
- GUI는 기존 CLI 계약을 우회하지 않는다.
- CLI와 GUI가 같은 파일을 읽고 같은 상태 전이를 만든다.
- 실패는 badge 하나로 숨기지 않고 output, exit code, reason을 보여준다.

## 8. 우선 구현 순서

1. `2A-0` project onboarding prototype: detection states와 Open/Install/Import/Upgrade/Repair UX.
2. `2A-1` workbench static prototype: p2a-design-system 기반 화면 뼈대.
3. `2B` read-only Electron shell: 실제 project detection과 project files reader.
4. `2B-1` harness onboarding actions: scaffold/handoff/upgrade/repair 실행.
5. `2C` PTY execution: node-pty + xterm + supervisor input.
6. `2D` finish/verification: existing lifecycle 연결.
7. smoke: 작은 target 프로젝트에서 install/import부터 ready task 1건 end-to-end 실행.

## 9. 첫 smoke 기준

대상은 외부 DB나 cloud가 없는 작은 프로젝트로 한다.

성공 기준:

- GUI가 scaffold된 P2A 프로젝트를 연다.
- P2A가 없는 작은 프로젝트에 GUI로 Install P2A를 수행한다.
- 필요한 경우 외부 planning bundle을 GUI로 import한다.
- ready task 1건을 선택한다.
- Codex 또는 Claude CLI PTY session을 시작한다.
- 실행 중 supervisor message를 1회 이상 보낸다.
- verification을 실행한다.
- task를 done 또는 blocked로 마무리한다.
- CLI로 확인한 task/run 상태와 GUI 표시가 일치한다.

## 10. 열린 결정

| ID | 결정 | 기본값 | 비고 |
| --- | --- | --- | --- |
| GUI-D1 | 첫 구현 stack | Electron + React + xterm.js + node-pty | 기존 디자인 reference가 React/HTML 중심 |
| GUI-D2 | 첫 지원 agent CLI | Codex 우선, Claude 다음 | 현재 실행 모드는 감독형 |
| GUI-D3 | run event schema 확장 | `supervisor_message`, `approval`, `deny`, `stop`, `kill` 추가 | schema 변경 task 필요 |
| GUI-D4 | project open 방식 | folder picker + recent projects + detection states | 2A-0/2B에서 확정 |
| GUI-D5 | markdown rendering | read-only renderer | editor는 MVP 제외 |
| GUI-D6 | upgrade policy | scripts/schemas/skills/agents/commands만 갱신, artifacts/source 보존 | 2B-1에서 확정 |
| GUI-D7 | repair scope | generated asset/schema 복구와 validate 진단까지 | source/artifact 자동 수정 제외 |

## 11. 완료 정의

MVP 완료는 아래가 모두 충족될 때다.

- P2A 미설치 프로젝트를 감지하고 GUI에서 Install P2A를 수행한다.
- 외부 planning bundle import를 GUI에서 수행하거나 명확히 안내한다.
- 실제 P2A 프로젝트를 열고 task/run/artifact를 읽는다.
- ready task 1건을 GUI에서 시작한다.
- PTY 세션에서 agent와 실시간 소통한다.
- supervisor message와 stop/kill/approval event가 run log에 남는다.
- verification을 실행하고 결과를 표시한다.
- task를 done 또는 blocked로 마무리한다.
- `node scripts/run_fixtures.mjs`와 GUI smoke가 모두 통과한다.
