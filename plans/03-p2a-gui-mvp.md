# P2A GUI MVP 계획

작성일: 2026-06-21 · 갱신일: 2026-06-24 · 상태: 범위 확정, 2B read-only Electron shell 1차 구현 · 연결 문서: `plans/02-development-team-ai-agent.md`, `.agents/skills/p2a-design-system/SKILL.md`

이 문서는 Plan2Agent Phase 2의 **PTY+Electron 감독 GUI**를 제품 MVP로 고정한다. 목표는 완전한 multi-agent orchestration이 아니라, 현재 구현된 파일 기반 하네스와 감독형 단일 task 실행기 Phase 1을 데스크톱 UI에서 읽고, 사람이 보기 편하게 감독할 수 있게 만드는 것이다.

## 0. 현재 결론

P2A GUI MVP는 **단일 task 감독 실행 GUI**다. GUI는 Plan2Agent 내부 앱이며, 지금까지 개발된 CLI와 파일 기반 상태를 보기 좋은 데스크톱 표면으로 제공한다. GUI가 내부 하네스 구현(`scripts/`, `schemas/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`)을 생성, 수정, 업그레이드, 복구하지 않는다. 현재 코드는 read-only 프로젝트 검사 모델/CLI와 Electron main/preload/renderer shell 1차를 구현했다.

핵심 흐름:

```text
프로젝트 폴더 선택
-> P2A 설치 상태 감지
-> Open / 진단 / CLI 안내 중 필요한 진입 선택
-> gate/iteration/task 상태 확인
-> ready task 선택
-> task detail과 acceptance criteria 확인
-> PTY 세션으로 Codex/Claude CLI 실행
-> 실행 중 terminal과 Message agent 입력으로 감독
-> verification 결과와 run record 확인
-> done 또는 blocked 처리
```

MVP는 기존 파일 구조를 단일 진실원으로 둔다. GUI가 별도 DB나 API 서버를 정본으로 만들지 않고, `run.schema.json`도 확장하지 않는다.

## 1. 제품 목표

사용자가 P2A 프로젝트의 현재 상태를 빠르게 파악하고, ready task 1건을 실제 agent CLI 실행까지 안전하게 감독할 수 있게 한다.

첫 화면에서 답해야 하는 질문:

- 현재 프로젝트와 active iteration이 무엇인가.
- Gate A-D 중 어디까지 진행됐고 무엇이 막혀 있는가.
- 지금 실행 가능한 task가 무엇인가.
- 이 프로젝트에서 기본 실행 agent CLI가 무엇인가.
- 다음 행동을 어느 탭에서 해야 하는가.
- 최근 run이나 검증 상태에 주의할 점이 있는가.

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
- Harness는 shell, live terminal output, DotChar agent state, provider tint의 기준이다.
- DevSync는 table, badge, modal, tab, input, dense row pattern의 보조 기준이다.
- PTY live output은 실행 화면의 주 객체이며 card preview처럼 숨기지 않는다. raw PTY transcript 전체는 기본 저장하지 않는다.
- 첫 화면은 summary-first로 구성한다. 사용자가 처음 보는 화면에는 현재 상태, 다음 행동, 기본 agent CLI, 하네스 변경 금지만 보인다. 설명성 문구는 별도 패널에 두지 않고 `?` 도움말 버튼 또는 hover/focus tooltip으로 제공한다. command preview와 실행 조작은 담당 탭에서만 보여준다.
- Overview는 프로젝트 전체 상황을 확인하는 상태판이다. task 실행, test/lint 실행, PTY 입력, stop/kill, done/blocked 처리는 Overview에서 하지 않고 Tasks, Terminal, Runs 같은 담당 탭에서만 수행한다.
- 진행 단계는 카드 나열보다 흐름도 형태로 보여준다. 첫 화면에는 `폴더 감지 -> 설치 확인 -> Gate A -> Gate B/C -> Gate D -> 실행 준비` 같은 현재 위치 중심 도형을 우선 표시하고, 설명은 tooltip으로 둔다.
- UI 문구는 한글을 우선하고 필요한 곳에 영문을 보조로 병기한다. 명령어, 파일 경로, schema field, task/run id 같은 기술 식별자는 영문 원문을 유지한다.
- UI 문구는 짧고 사실적으로 쓴다. emoji, exclamation, marketing hero를 쓰지 않는다.

## 3. Project onboarding / detection

P2A GUI 앱은 중앙 DB를 가진 별도 제품이 아니라, **Plan2Agent repo/package에 포함되는 내부 데스크톱 앱**이다. 선택한 프로젝트 디렉터리의 P2A 파일 기반 상태를 읽고, 이미 구현된 CLI lifecycle을 보기 좋게 호출한다. MVP에서 GUI는 P2A 하네스 자체를 설치, 업그레이드, 복구하지 않는다.

앱 첫 진입점:

```text
Recent projects
Open project folder
Show setup command
Show import command
```

용어와 CLI 대응:

| UI 용어 | 의미 | CLI 대응 |
| --- | --- | --- |
| Open P2A Project | 이미 P2A가 설치된 프로젝트를 연다 | 파일 감지 + read-only load |
| Setup Guidance | P2A가 없는 폴더에 필요한 CLI 명령을 안내한다 | `node scripts/p2a_handoff.mjs scaffold --target <project-dir> --tools all` 안내만 |
| Import Guidance | 외부 planning artifact bundle을 가져오는 CLI 명령을 안내한다 | `node scripts/p2a_handoff.mjs --project-id <id> --artifacts <path> --target <project-dir> --tools all` 안내만 |
| Validate Guidance | 누락/드리프트를 진단하고 사용자가 터미널에서 실행할 명령을 안내한다 | validate command preview |

프로젝트 선택 후 detection 상태:

| 상태 | 감지 기준 | 기본 UI |
| --- | --- | --- |
| No P2A | `.plan2agent/manifest.json`, `PLAN2AGENT.md`, P2A scripts가 없음 | Setup Guidance |
| Installed empty | P2A harness는 있으나 planning artifacts가 없음 | Start planning 안내 / Import Guidance |
| Planning in progress | Gate artifact 또는 iteration이 있으나 ready task 없음 | Gate overview / Artifacts |
| Execution ready | ready task 또는 run history가 있음 | Tasks / Runs / Terminal |
| Outdated harness | manifest/source version이 앱 번들과 다름 | Validate Guidance |
| Broken install | 필수 script/schema/manifest 일부 누락 | Validate Guidance |

onboarding guidance 원칙:

- GUI는 setup/import/upgrade/repair 명령을 직접 실행하지 않고, command, target path, tool targets, overwrite 여부를 보여준다.
- 사용자는 안내된 명령을 터미널에서 실행한다.
- GUI는 하네스 파일, source code, planning artifacts를 임의로 덮어쓰지 않는다.
- 사용자가 외부 터미널에서 명령을 실행한 뒤에는 파일 watcher와 reload로 상태 변화를 감지한다.

GUI local config:

- recent project path와 프로젝트별 `defaultAgentTool`은 GUI 앱 local config에만 저장한다.
- 이 설정은 `.plan2agent/`, `scripts/`, `schemas/`, planning artifact에 쓰지 않는다.
- `defaultAgentTool` 기본값은 `codex`다. `claude`는 provider adapter가 준비된 경우 선택 가능하게 한다.
- 실제 run에는 기존 `run.json.agentTool`로 실행 시점의 선택값이 기록된다.

## 4. 단계 범위

### 2A. 정적 GUI 프로토타입

목적: 실제 Electron이나 PTY를 붙이기 전에, 화면 구조와 정보 밀도를 검증한다.

포함:

- Project onboarding screen mock.
- No P2A / Installed empty / Planning in progress / Execution ready / Outdated / Broken 상태 mock.
- Open / Setup Guidance / Import Guidance / Validate Guidance의 담당 탭 안내 mock.
- 현재 진행 단계 flow mock.
- Overview 상태판과 Tasks/Terminal/Runs 탭 handoff mock.
- mock project, task graph, run record, artifacts 데이터.
- Overview, Tasks, Runs, Artifacts, Terminal shell 화면.
- task list, selected task inspector, run detail, artifact viewer.
- PTY console처럼 보이는 live output mock.
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

현재 구현된 1차 기반:

- `apps/p2a-gui/src/project-reader.mjs`가 선택한 프로젝트를 read-only로 검사한다.
- `apps/p2a-gui/bin/p2a-gui-project.mjs inspect --project <dir> [--json]`가 같은 read model을 CLI로 출력한다.
- `apps/p2a-gui/src/main.mjs`가 Electron lifecycle, folder picker, `--project <dir>`, read-only reload, file watcher를 담당한다.
- `apps/p2a-gui/src/preload.cjs`가 renderer에 제한된 IPC API만 노출한다.
- `apps/p2a-gui/renderer/`가 프로젝트 상태, Gate, ready task, diagnostics, command preview, read model JSON을 표시한다.
- Electron 개발 런타임은 Node.js `>=22.12.0`, Electron `42.5.0`으로 고정한다.
- `.plan2agent/`, `artifacts/<project_id>`, flat handoff artifact, iterative artifact root, direct artifact root를 감지한다.
- `no_p2a`, `installed_empty`, `planning_in_progress`, `execution_ready`, `broken_install` 상태를 판정한다.
- setup/import/validate command preview, gate/task/run 요약, 기본 agent CLI, 진단 메시지를 만든다.
- fixture smoke가 scaffold target, P2A 미설치 폴더, handoff target의 read model을 검증한다.

아직 남은 2B 범위:

- recent projects와 GUI local config 저장.
- 실제 Markdown/JSON artifact viewer 화면.
- tab별 상세 화면과 keyboard/focus hardening.
- Electron packaging 정책 정리.

포함:

- 프로젝트 폴더 열기 또는 고정 workspace 로딩.
- `.plan2agent/`, `artifacts/`, `iterations/`, `runs/` 구조 감지.
- No P2A / Installed empty / Planning in progress / Execution ready / Outdated / Broken 상태 판정.
- setup/import/validate action의 command preview 표시.
- active iteration 확인.
- Gate A-D 상태 표시.
- `status.md`, `spec.json`, `task-graph.json`, `review.json` 읽기.
- task 목록, status filter, dependency 표시.
- 선택한 task detail 표시.
- `runs/run-index.json`, `runs/<runId>.json` 기반 run history 표시.
- artifact viewer로 Markdown/JSON 산출물 read-only 표시.
- GUI local config에서 프로젝트별 `defaultAgentTool`을 읽고 표시.
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

### 2B-1. Harness onboarding guidance

목적: detection 결과에 따라 P2A 설치, planning bundle import, harness validate에 필요한 CLI 명령을 GUI에서 명확히 안내한다. 이 단계는 하네스 파일을 직접 변경하지 않는 diagnostic/guidance subflow다.

포함:

- `Setup Guidance`: `p2a_handoff.mjs scaffold --target <project-dir> --tools all` 명령 안내.
- `Import Guidance`: 외부 `artifacts/<project_id>/` 또는 iterative artifact root를 대상 프로젝트로 handoff하는 명령 안내.
- `Validate Guidance`: 누락된 generated tool asset과 schema를 진단하는 validate 명령 안내.
- command preview, target path, overwrite 위험, 터미널 실행 후 reload 안내 표시.
- 파일 변경 watcher로 외부 CLI 실행 결과를 감지하고 read-only reload 수행.

제외:

- 사용자 source code 자동 수정.
- planning artifact 내용 자동 수정.
- harness implementation 자동 수정(`scripts/`, `schemas/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`).
- GUI를 통한 scaffold/import/upgrade/repair 명령 실행.
- task 상태 변경.
- agent 실행.
- destructive cleanup 자동 수행.

완료 기준:

- 일반 코드 프로젝트에 P2A harness를 설치하기 위한 CLI 명령을 GUI가 정확히 안내한다.
- 외부 planning bundle을 import하기 위한 CLI 명령을 GUI가 정확히 안내한다.
- 사용자가 터미널에서 설치/import/validate를 수행한 뒤 GUI가 갱신된 파일 상태를 읽는다.
- 실패 시 사용자가 어떤 파일/권한/옵션을 터미널에서 확인해야 하는지 알 수 있다.

### 2C. PTY 실행/감독 + Supervisor communication

목적: 선택한 ready task 1건을 Electron 앱 안에서 실제 CLI PTY 세션으로 실행하고, 사람이 실시간으로 감독한다.

포함:

- ready task 선택 후 execution session 시작.
- GUI local config의 `defaultAgentTool` 또는 실행 직전 사용자 선택값을 기존 `p2a_execute start --agent-tool <tool>`에 전달.
- Electron main process에서 `node-pty`로 Codex/Claude CLI 실행.
- renderer에서 `xterm.js`로 live terminal 표시.
- stdout/stderr 실시간 표시와 scrollback 유지.
- terminal 직접 입력 지원.
- 별도 `Message agent` 입력창 제공.
- `Message agent` 입력을 PTY stdin으로 전달. MVP에서는 이 메시지를 run log에 별도 저장하지 않는다.
- agent 질문에 사용자가 답변 가능.
- stop, kill, mark blocked 같은 감독 액션 제공. MVP에서는 별도 run event를 저장하지 않고, 필요한 경우 기존 `p2a_execute finish --status blocked|failed --failure-class ... --note ...`로 결과만 기록한다.
- 현재 command, cwd, task id, run id, startedAt, duration 표시.
- PTY resize, exit code, process close 상태 처리.
- 단일 active task와 단일 active PTY session만 지원.

제외:

- 여러 task 병렬 실행.
- 여러 agent 동시 실행.
- Team Big Five orchestration.
- 자동 retry.
- 자동 PR 생성.
- 자동 merge.
- 완전 무인 headless 실행.
- agent 출력의 자동 의미 판정.
- raw PTY transcript 전체 저장.
- supervisor message, approval, deny, stop, kill의 구조화 event schema 저장.

완료 기준:

- 앱에서 ready task 1건을 시작하고 실제 CLI 세션이 열린다.
- 사용자가 terminal 직접 입력과 `Message agent` 입력 모두로 agent와 소통할 수 있다.
- stop/kill이 동작하고, 필요한 경우 기존 run lifecycle로 blocked/failed 상태와 note를 남길 수 있다.
- process exit 후 run summary가 표시된다.

### 2D. Finish / Verification 연결

목적: 실행 결과를 기존 `p2a_execute`/`p2a_runs`/`p2a_tasks` lifecycle에 연결한다.

포함:

- verification command 실행.
- verification exit code, duration, output snippet 표시.
- changed files 표시.
- 기존 `run.json` schema의 run finish 기록.
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
- done/blocked 상태가 task graph와 기존 run log schema에 일관되게 기록된다.

## 5. MVP 전체 포함 범위

- Project onboarding / detection.
- Setup/Import/Validate command guidance.
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
- GUI를 통한 P2A harness 설치, upgrade, repair 실행.
- 내부 하네스 구현 파일 수정.
- `run.schema.json` 확장.
- raw PTY transcript 기본 저장.
- supervisor message/approval/deny/stop/kill event 영속화.

## 7. 아키텍처 원칙

| 계층 | 책임 |
| --- | --- |
| Electron main | app lifecycle, project detection, command guidance, file read, watcher, PTY spawn, process lifecycle |
| Preload IPC | renderer에 안전한 read/execute API만 노출 |
| Renderer | onboarding UI, workbench UI, xterm surface, task/run/artifact views |
| P2A CLI bridge | 기존 `p2a_tasks`, `p2a_runs`, `p2a_execute` 실행 lifecycle 호출. `p2a_handoff`/`validate_artifacts`는 MVP에서 command guidance로만 노출 |
| Filesystem | P2A artifact와 run log의 단일 진실원 |

원칙:

- renderer가 임의 shell command를 직접 실행하지 않는다.
- scaffold/handoff/upgrade/repair는 MVP에서 GUI가 직접 실행하지 않고 command guidance로만 제공한다.
- task/run 상태를 바꾸는 lifecycle action은 command, cwd, target workspace, task id, run id를 UI에 노출한다.
- GUI는 기존 CLI 계약을 우회하지 않는다.
- CLI와 GUI가 같은 파일을 읽고 같은 상태 전이를 만든다.
- GUI는 내부 하네스 구현 파일을 쓰지 않는다.
- 실패는 badge 하나로 숨기지 않고 output, exit code, reason을 보여준다.

## 8. 우선 구현 순서

1. `2A-0` project onboarding prototype: detection states와 Open/Setup/Import/Validate guidance UX.
2. `2A-1` workbench static prototype: p2a-design-system 기반 화면 뼈대.
3. `2B-0` read-only project inspection foundation: 실제 project detection과 project files reader. **구현 완료**
4. `2B` read-only Electron shell 1차: folder picker, `--project`, 상태 화면, watcher, renderer 화면. **구현 완료**
5. `2B` hardening: recent projects, local config, artifact viewer, focus/keyboard polish.
6. `2B-1` harness onboarding guidance: scaffold/handoff/validate 명령 안내 화면.
7. `2C` PTY execution: node-pty + xterm + supervisor input.
8. `2D` finish/verification: existing lifecycle 연결.
9. smoke: 이미 scaffold된 작은 target 프로젝트에서 ready task 1건 end-to-end 실행.

## 9. 첫 smoke 기준

대상은 외부 DB나 cloud가 없는 작은 프로젝트로 한다.

성공 기준:

- GUI가 scaffold된 P2A 프로젝트를 연다.
- P2A가 없는 작은 프로젝트에서는 GUI가 setup 명령을 정확히 안내한다.
- 필요한 경우 외부 planning bundle import 명령을 정확히 안내한다.
- ready task 1건을 선택한다.
- Codex 또는 Claude CLI PTY session을 시작한다.
- 실행 중 supervisor message를 1회 이상 PTY stdin으로 보낸다.
- verification을 실행한다.
- task를 done 또는 blocked로 마무리한다.
- CLI로 확인한 task/run 상태와 GUI 표시가 일치한다.

## 10. 결정 현황

| ID | 결정 | 현재 값 | 비고 |
| --- | --- | --- | --- |
| GUI-D1 | 첫 구현 stack | Electron + React + xterm.js + node-pty | 확정. 기존 디자인 reference가 React/HTML 중심이고 PTY 감독 UI가 필요하다 |
| GUI-D2 | 실행 agent CLI 선택 | `defaultAgentTool: codex` | 프로젝트별 선택값은 GUI local config에 저장한다. `claude`는 provider adapter가 준비된 경우 선택 가능 |
| GUI-D3 | run event schema 확장 | MVP 제외 | 기존 `run.schema.json`을 유지한다. supervisor message, approval/deny event, raw PTY transcript 저장은 후속 기능으로 둔다 |
| GUI-D4 | project open 방식 | folder picker + recent projects + detection states | recent project path와 `defaultAgentTool`은 GUI local config에만 저장한다 |
| GUI-D5 | markdown rendering | read-only renderer | HTML 비활성화, 외부 링크는 OS/browser로 열기, renderer script 실행 금지 |
| GUI-D6 | upgrade policy | MVP 제외 | GUI는 내부 하네스 구현을 갱신하지 않고 command guidance만 제공한다 |
| GUI-D7 | repair scope | MVP 제외 | GUI는 validate 진단 안내만 제공하고 generated asset/schema를 복구하지 않는다 |

## 11. 완료 정의

MVP 완료는 아래가 모두 충족될 때다.

- P2A 미설치 프로젝트를 감지하고 setup CLI 명령을 명확히 안내한다.
- 외부 planning bundle import CLI 명령을 명확히 안내한다.
- 실제 P2A 프로젝트를 열고 task/run/artifact를 읽는다.
- ready task 1건을 GUI에서 시작한다.
- PTY 세션에서 agent와 실시간 소통한다.
- raw PTY transcript와 supervisor event를 저장하지 않는다.
- verification을 실행하고 결과를 기존 run schema에 기록/표시한다.
- task를 done 또는 blocked로 마무리한다.
- `node scripts/run_fixtures.mjs`와 GUI smoke가 모두 통과한다.
