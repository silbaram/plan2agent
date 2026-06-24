# Plan2Agent CLI 사용자 가이드

이 문서는 Plan2Agent에서 자주 쓰는 CLI 흐름과 대표 명령을 한곳에 모은 사용자 가이드다. 옵션 전체를 복제하지 않고, 실제 사용 흐름에 필요한 주요 명령과 예시만 다룬다. 세부 옵션은 각 도구의 `--help` 또는 스크립트 usage가 정본이다.

문서 홈: [Plan2Agent Docs](README.md) · 먼저 보기: [Quickstart](quickstart.md)

## 1. 개요

Plan2Agent CLI는 기획 산출물을 검증하고, 승인된 task graph를 기반으로 개발 진행 상태와 agent 실행 결과를 관리하며, 대상 저장소로 인계하는 데 필요한 보조 도구다.

| 스크립트 | 한 줄 요약 |
| --- | --- |
| `scripts/sync_cli_assets.mjs` | `.agents/` canonical skill/agent 원본을 Claude/Codex/Gemini용 mirror로 생성하거나 drift를 검사한다. |
| `scripts/check_cli_parity.mjs` | 생성 산출물과 CLI shim이 canonical 원본과 동기화되어 있는지 검사한다. |
| `scripts/run_fixtures.mjs` | `fixtures/` 아래 golden fixture들을 한 번에 검증한다. |
| `scripts/validate_artifacts.mjs` | intake, spec, task graph, review, fixture 산출물이 schema/gate 계약을 만족하는지 검증한다. |
| `scripts/p2a_iteration.mjs` | 반복 구조 변환, active iteration 확인, 반복 검증, close/open, Gate A/B draft 생성을 관리한다. |
| `scripts/p2a_tasks.mjs` | 승인된 task graph의 ready task 확인, 실행 prompt 출력, 상태 전이를 관리한다. |
| `scripts/p2a_runs.mjs` | task별 agent run log, changed files, verification, workspace/branch/worktree 참조를 기록한다. |
| `scripts/p2a_execute.mjs` | ready task 1건의 plan/start/finish/status를 감독형 실행 흐름으로 묶는다. |
| `scripts/p2a_orchestrate.mjs` | ready task 1건의 supervised orchestration plan, role prompt, monitor gate를 생성한다. |
| `scripts/p2a_proposals.mjs` | run log와 orchestration sidecar에서 Hermes식 개선 proposal 후보, review/curation artifact, non-applying patch draft, approval artifact를 생성한다. |
| `scripts/p2a_handoff.mjs` | 새 프로젝트에 co-located 하네스를 scaffold하거나, Gate D까지 통과한 산출물을 대상 프로젝트로 복사/이동한다. |
| `apps/p2a-gui/bin/p2a-gui-project.mjs` | GUI Phase 2B용 read-only 프로젝트 감지, task/run/artifact 요약, setup/import/validate 명령 안내를 출력한다. |

전체 흐름은 다음과 같다.

1. 하네스가 한 문장 아이디어에서 **Gate A intake → Gate B spec → Gate C task graph → Gate D review** 산출물을 만든다.
2. `validate_artifacts.mjs`, `run_fixtures.mjs`, `check_cli_parity.mjs`로 산출물과 CLI 구성을 검증한다.
3. 새 프로젝트는 먼저 `p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서 `p2a_execute.mjs plan/start`로 ready task 1건의 run을 열고 감독형 agent prompt를 출력한다. 복수 agent 역할이나 monitor gate가 필요한 task는 먼저 `p2a_orchestrate.mjs plan`으로 실행 계획을 만든다.
5. `p2a_execute.mjs finish`로 verification, run finish, task done/block 전이를 묶어 기록한다. 세부 제어가 필요하면 `p2a_tasks.mjs`와 `p2a_runs.mjs`를 직접 사용한다.
6. 실패, blocked monitor verdict, verification gap이 쌓이면 `p2a_proposals.mjs mine/review/curate/draft-patch/approve-draft/digest`로 개선 proposal queue, curator review artifact, approval-ready curation artifact, non-applying patch draft, 승인 artifact를 만든다. proposal 적용은 승인된 maintenance task를 별도 실행해서 진행한다.

## 2. Co-located scaffold — `p2a_handoff.mjs scaffold`

```bash
node scripts/p2a_handoff.mjs scaffold --target <project-dir> [--tools all|none|codex,claude,gemini] [--overwrite] [--dry-run]
```

`scaffold`는 아직 산출물이 없는 fresh 프로젝트에 P2A 하네스 전체를 1회 설치한다. `scripts/`에는 `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_orchestrate.mjs`, `p2a_proposals.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs`가 복사되고, `schemas/`에는 intake/spec/task graph/task context/review/run/run-index/orchestration-plan/skill-proposal/proposal-review/proposal-curation/proposal-patch-draft/proposal-draft-approval schema가 복사된다. `--tools` 기본값은 `all`이며, 기존 AI 자산 복사 로직으로 `.agents`, `.claude`, `.codex`, `.gemini` 자산을 설치한다. `.plan2agent/project.config.json`, `.plan2agent/manifest.json`, `PLAN2AGENT.md`, 프로젝트용 `.gitignore`도 생성한다. `scaffold`는 co-located 정식 진입점으로, 빈 프로젝트에 하네스를 설치한 뒤 기획·개발·반복을 그 프로젝트 안에서 진행하게 한다.

`--artifacts`는 필요 없다. `--dry-run`은 쓸 파일 목록만 출력하고, `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다. 서브커맨드 없이 실행하는 기존 flag 기반 handoff 동작은 하위호환으로 유지된다. `handoff`는 plan2agent에서 이미 기획한 승인 산출물을 별도 프로젝트로 옮길 때 쓰는 레거시/특수 흐름이다.

## 3. 동기화·검증

### `sync_cli_assets.mjs`

`.agents/skills/`와 `.agents/agents/`를 기준으로 Claude, Codex, Gemini용 mirror 파일을 생성한다. 일반 실행은 파일을 갱신하고, `--check`는 쓰기 없이 drift만 검사한다.

```bash
node scripts/sync_cli_assets.mjs
node scripts/sync_cli_assets.mjs --check
```

### `check_cli_parity.mjs`

`sync_cli_assets.mjs --check`를 포함해 skill mirror byte 비교, agent mirror 존재 여부, Gemini command shim 필수 내용 등을 검사한다.

```bash
node scripts/check_cli_parity.mjs
```

### `run_fixtures.mjs`

`fixtures/` 아래 각 일반 fixture 디렉터리를 `validate_artifacts.mjs --fixture-dir` 조합으로 검증한다. `fixtures/_e2e/manifest.json`이 있으면 artifact-root fixture를 `--require-handoff-ready`로 검증하고, `fixtures/_negative/manifest.json`이 있으면 중단/실패 fixture도 실행해서 기대한 실패 메시지가 나오는지 확인한다. fixture/golden 변경 후 전체 회귀 확인용으로 쓴다.

```bash
node scripts/run_fixtures.mjs
```

### `validate_artifacts.mjs`

개별 산출물 또는 fixture 디렉터리를 검증한다. 자주 쓰는 조합은 다음과 같다.

```bash
node scripts/validate_artifacts.mjs \
  --intake artifacts/<project_id>/gate-a-intake/intake.json

node scripts/validate_artifacts.mjs \
  --status artifacts/<project_id>/status.md

node scripts/validate_artifacts.mjs \
  --artifact-root artifacts/<project_id>

node scripts/validate_artifacts.mjs \
  --intake artifacts/<project_id>/gate-a-intake/intake.json \
  --spec artifacts/<project_id>/gate-b-spec/spec.json

node scripts/validate_artifacts.mjs \
  --task-graph artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec artifacts/<project_id>/gate-b-spec/spec.json

node scripts/validate_artifacts.mjs \
  --review artifacts/<project_id>/gate-d-review/review.json

node scripts/validate_artifacts.mjs \
  --review artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass

node scripts/validate_artifacts.mjs \
  --runs-dir artifacts/<project_id>/runs

node scripts/validate_artifacts.mjs \
  --proposals-dir artifacts/<project_id>/proposals

node scripts/validate_artifacts.mjs \
  --proposal-review artifacts/<project_id>/proposals/reviews/proposal-review-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-curation artifacts/<project_id>/proposals/curations/proposal-curation-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-patch-draft artifacts/<project_id>/proposals/patch-drafts/proposal-patch-draft-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-draft-approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

node scripts/validate_artifacts.mjs \
  --artifact-root artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

node scripts/validate_artifacts.mjs \
  --fixture-dir fixtures/cache-library

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --require-close-ready

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --allow-planning

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --stage gate-c-draft

node scripts/p2a_iteration.mjs close \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs open \
  --artifacts artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

node scripts/p2a_iteration.mjs draft \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs promote-spec \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs context \
  --artifacts artifacts/<project_id> \
  --code-root .

node scripts/p2a_iteration.mjs promote-tasks \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs diff-tasks \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs compose \
  --artifacts artifacts/<project_id> \
  [--allow-conflicts]

node scripts/p2a_iteration.mjs maintenance add \
  --artifacts artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"
```

`--status`는 top-level `status.md` standing document의 최소 구조를 확인한다. `--artifact-root`는 `artifacts/<project_id>/` 아래 Gate A-D bundle을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `status.md`의 `Gate B approval audit` block도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다.

`--run`, `--run-index`, `--runs-dir`는 `p2a_runs.mjs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--orchestration-plan`, `--skill-proposal`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`, `--proposals-dir`는 실행 계획 sidecar와 Hermes식 proposal queue/review/curation/patch draft/approval artifact를 검증한다.

`p2a_iteration.mjs validate`는 반복 구조의 active iteration 포인터, active Gate B-D 산출물, task dependency, review blocker, current-spec composition을 검증한다. `--require-approved-spec`는 task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때 함께 사용한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지까지 확인한다.

`p2a_iteration.mjs close/open/draft/promote-spec/context/promote-tasks/diff-tasks/compose`는 반복 planning과 task graph 승격을 다룬다. `p2a_iteration.mjs maintenance add`는 Gate A/B/D 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`, `--area`, `--prompt`, 반복 가능한 `--ref`, 반복 가능한 `--depends`, `--dry-run`이다.

### GUI project inspection — `p2a-gui-project.mjs`

GUI Phase 2B의 첫 구현은 Electron 화면을 띄우기 전, 선택한 프로젝트를 read-only로 검사하는 모델과 CLI다. 이 명령은 P2A 설치 여부, `.plan2agent/artifacts`, `artifacts/<project_id>`, 직접 artifact root 같은 artifact layout, gate/task/run 요약, 기본 agent CLI, setup/import/validate command preview를 출력한다. 하네스 파일, source code, planning artifact를 수정하지 않는다.

```bash
node apps/p2a-gui/bin/p2a-gui-project.mjs inspect --project <project-dir>
node apps/p2a-gui/bin/p2a-gui-project.mjs inspect --project <project-dir> --json
```

대표 상태는 `no_p2a`, `installed_empty`, `planning_in_progress`, `execution_ready`, `broken_install`이다. JSON 출력은 이후 Electron main/renderer가 그대로 소비할 read model의 기준으로 사용한다. `broken_install`처럼 명확한 오류 진단이 있으면 exit code 1로 종료하고, 단순 `no_p2a`는 setup guidance 상태로 exit code 0을 반환한다.

Electron shell은 같은 read model을 folder picker, `--project`, file watcher로 표시한다. 최근 프로젝트와 마지막으로 연 프로젝트는 Electron `userData`의 `p2a-gui-config.json`에 저장하고, 다음 실행 때 자동 복원한다. `AR` 탭은 현재 프로젝트의 known artifact와 run JSON을 read-only로 목록화하고, main process가 catalog에 있는 파일 id만 읽는다. `TK` 탭은 task graph를 read-only로 읽어 task 목록, 상태, dependency, acceptance criteria, source refs, suggested prompt를 표시한다. `RN` 탭은 run index와 run JSON을 read-only로 읽어 run 목록, changed files, verification, failure, notes를 표시한다. 개발 런타임은 Node.js `>=22.12.0`과 Electron `42.5.0`을 기준으로 고정한다.

```bash
cd apps/p2a-gui
npm start -- --project <project-dir>
```

## 4. 감독형 단일 task 실행 — `p2a_execute.mjs`

`p2a_execute.mjs`는 Phase 1 감독형 실행기다. 여러 task를 스케줄링하지 않고, ready task 1건에 대해 기존 `p2a_tasks.mjs`와 `p2a_runs.mjs` 흐름을 묶는다. Codex/Claude 구현 세션 자체는 사람이 보는 foreground에서 진행하며, 이 CLI는 run 생성, task 상태 전이, verification, finish, done/block 기록을 연결한다.

```bash
node scripts/p2a_execute.mjs plan \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001

node scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --workspace . \
  --workspace-ref target-project

node scripts/p2a_execute.mjs finish \
  --graph .plan2agent/artifacts/task-graph.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git

node scripts/p2a_execute.mjs status \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001
```

반복 구조 artifact root에서는 active iteration을 자동 인식한다.

```bash
node scripts/p2a_execute.mjs plan \
  --artifacts artifacts/<project_id> \
  --task task-001

node scripts/p2a_execute.mjs start \
  --artifacts artifacts/<project_id> \
  --task task-001 \
  --isolation branch \
  --create-isolation
```

승인된 proposal patch draft는 approval artifact로 maintenance task를 자동 선택할 수 있다. `--approval`은 `--artifacts`와 함께 쓰며 maintenance task graph를 사용한다.

```bash
node scripts/p2a_execute.mjs plan \
  --artifacts artifacts/<project_id> \
  --approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

node scripts/p2a_execute.mjs start \
  --artifacts artifacts/<project_id> \
  --approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json \
  --agent-tool codex

node scripts/p2a_execute.mjs finish \
  --artifacts artifacts/<project_id> \
  --approval artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck
```

`start`는 run을 먼저 만들고 task를 `in_progress`로 바꾼 뒤 manual launcher prompt를 출력한다. `finish`는 verification이 실패하면 기본 failure class를 `verification_failed`로 기록하고 task를 `blocked`로 전이한다. 실패 class를 직접 지정하려면 `--status failed|blocked --failure-class <class>`를 넘긴다.

## 5. 감독형 오케스트레이션 계획 — `p2a_orchestrate.mjs`

`p2a_orchestrate.mjs`는 ready task 1건을 대상으로 deterministic heuristic을 적용해 `solo`, `solo_monitor`, `team` 중 하나의 실행 계획을 만든다. 이 도구는 agent를 자동 실행하지 않는다. owner가 foreground agent 세션을 열고, 생성된 role prompt와 monitor gate를 보며 감독형으로 실행한다.

`team` mode는 명시적인 다중 영역 task에만 보수적으로 추천한다. `targetArea`에서 복수 영역을 의도할 때는 `api+ui`, `api,ui`, `api&ui`, `api and ui`처럼 comma/plus/ampersand/`and`를 쓴다. `auth/login` 같은 slash 표기는 단일 영역 label로 취급한다.

```bash
node scripts/p2a_orchestrate.mjs plan \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001 \
  --output .plan2agent/orchestration/task-001.json

node scripts/p2a_orchestrate.mjs handoff \
  --plan .plan2agent/orchestration/task-001.json

node scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --orchestration-plan .plan2agent/orchestration/task-001.json
```

`p2a_execute start --orchestration-plan <path>`는 원본 plan을 `runs/<runId>.orchestration.json` sidecar로 연결한다. monitor gate가 필요한 plan은 `runs/<runId>.monitor-verdict.json`에 `{"verdict":"confirm_done"}` 같은 verdict가 있어야 `finish`가 done으로 닫힌다. 허용되지 않은 verdict는 plan의 `failureClassMap`에 따라 기존 run failure class로 변환되어 blocked 흐름으로 기록된다.

## 6. 개발 진행 — `p2a_tasks.mjs`

`p2a_tasks.mjs`는 task graph를 읽어 개발 가능한 task를 찾고, 개별 task 실행 prompt를 만들며, 상태를 `todo`, `in_progress`, `done`, `blocked` 사이에서 전이한다.

```bash
node scripts/p2a_tasks.mjs <command> --graph <path> [--spec <path>] [task-id]
node scripts/p2a_tasks.mjs <command> --artifacts <iterative-project-dir> [--maintenance] [task-id]
```

| 명령 | 설명 |
| --- | --- |
| `list` | 모든 task와 readiness를 표로 출력한다. |
| `ready` | dependency가 모두 `done`이고 자신의 상태가 `todo`인 task만 출력한다. |
| `show <task-id>` | 해당 task의 전체 JSON을 출력한다. |
| `prompt <task-id>` | `suggestedAgentPrompt`, acceptance criteria, task 설명, 참조 spec context, 전체 spec 경로를 함께 출력한다. |
| `start <task-id>` | ready 상태의 `todo` task를 `in_progress`로 바꾼다. |
| `done <task-id>` | `in_progress` task를 `done`으로 바꾼다. |
| `block <task-id>` | task를 `blocked`로 표시한다. |
| `todo <task-id>` | task를 `todo`로 되돌린다. |

대표 예시:

```bash
node scripts/p2a_tasks.mjs list \
  --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json

node scripts/p2a_tasks.mjs ready \
  --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json

node scripts/p2a_tasks.mjs prompt \
  --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --spec artifacts/<project_id>/gate-b-spec/spec.json \
  task-001

node scripts/p2a_tasks.mjs start \
  --graph artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  task-001
```

반복 구조로 변환된 artifact는 active iteration을 자동 인식할 수 있다. `--maintenance`를 함께 쓰면 active 기능 반복 대신 `iterations/maintenance/gate-c-task-graph/task-graph.json` 단일 그래프를 대상으로 같은 명령을 실행한다.

```bash
node scripts/p2a_tasks.mjs ready \
  --artifacts artifacts/<project_id>

node scripts/p2a_tasks.mjs prompt \
  --artifacts artifacts/<project_id> \
  task-001

node scripts/p2a_tasks.mjs start \
  --artifacts artifacts/<project_id> \
  task-001

node scripts/p2a_tasks.mjs ready \
  --artifacts artifacts/<project_id> \
  --maintenance

node scripts/p2a_tasks.mjs start \
  --artifacts artifacts/<project_id> \
  --maintenance \
  task-001
```

터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 번호 메뉴 기반 대화형 모드가 열린다. 대화형 모드에서도 active artifact 루트, maintenance 레인, task graph 파일 입력 중 하나를 선택할 수 있다.

```bash
node scripts/p2a_tasks.mjs
node scripts/p2a_tasks.mjs -i
```

## 7. 실행 추적 — `p2a_runs.mjs`

`p2a_runs.mjs`는 task graph schema를 바꾸지 않고 별도 `runs/` 디렉터리에 agent 실행 결과를 기록한다. 반복 artifact root에서는 `artifacts/<project_id>/runs/`, handoff 대상 프로젝트에서는 기본적으로 `.plan2agent/runs/`를 사용한다.

주요 파일:

- `runs/run-index.json` — task별 runId 목록과 latestRunId를 담는 index
- `runs/<runId>.json` — 단일 실행의 agentTool, workspaceRef, isolation, changedFiles, verification 결과

대표 흐름:

```bash
node scripts/p2a_runs.mjs start \
  --artifacts artifacts/<project_id> \
  --task task-001 \
  --agent-tool codex \
  --workspace /path/to/workspace \
  --workspace-ref feature/task-001 \
  --isolation branch \
  --branch p2a/task-001-run

node scripts/p2a_runs.mjs verify \
  --artifacts artifacts/<project_id> \
  --run-id run-... \
  --test \
  --lint \
  --typecheck

node scripts/p2a_runs.mjs finish \
  --artifacts artifacts/<project_id> \
  --run-id run-... \
  --changed-file src/example.ts \
  --collect-git

node scripts/p2a_runs.mjs list \
  --artifacts artifacts/<project_id>
```

`verify`는 `.plan2agent/project.config.json`의 `testCommand`, `lintCommand`, `typecheckCommand`를 읽는다. 설정이 없거나 별도 명령을 쓰려면 `--test-command`, `--lint-command`, `--typecheck-command`, `--verify-command <type:cmd>`를 넘긴다. `--isolation branch|worktree`는 격리 기준을 run log에 기록하며, `--create-isolation`을 함께 줄 때만 실제 `git switch -c` 또는 `git worktree add`를 실행한다.

handoff 대상 프로젝트에서는 다음처럼 쓴다.

```bash
node scripts/p2a_runs.mjs start \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001 \
  --agent-tool codex

node scripts/p2a_runs.mjs verify --run-id run-...
node scripts/p2a_runs.mjs finish --run-id run-... --collect-git
```

## 8. 개선 proposal 큐 — `p2a_proposals.mjs`

`p2a_proposals.mjs`는 Hermes식 자가 개선 루프의 파일 기반 MVP다. run log, orchestration sidecar, monitor verdict를 읽어 skill/agent/CLI 개선 후보를 `p2a.skill_proposal.v1` JSON으로 만들고, 사람이 검토할 review/curation artifact, non-applying patch draft, approval artifact를 생성한다. proposal 적용은 자동으로 하지 않고 승인된 maintenance task를 별도 실행한다.

기본 저장 위치:

- 반복 artifact root: `artifacts/<project_id>/proposals/`
- handoff/scaffold 대상 프로젝트: `.plan2agent/proposals/`
- `--graph <path>`를 쓰면 graph에서 추론한 `runs/`의 sibling `proposals/`

대표 흐름:

```bash
node scripts/p2a_proposals.mjs mine \
  --graph .plan2agent/artifacts/task-graph.json

node scripts/p2a_proposals.mjs list \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs digest \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs review \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node scripts/p2a_proposals.mjs draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

node scripts/p2a_proposals.mjs approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts artifacts/<project_id> \
  --approved-by <name>

node scripts/p2a_proposals.mjs show \
  --proposal-id proposal-run-123-verification-gap \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs validate \
  --proposals .plan2agent/proposals
```

`mine`은 아래 경우에 proposal 후보를 만든다.

- `failed` 또는 `blocked` run에 `failure.class`가 남아 있는 경우
- `finished` run인데 verification 기록이 없는 경우
- monitor gate가 거절 verdict를 냈지만 run failure source가 monitor로 닫히지 않은 경우

`mine`은 회고 분석용 best-effort 명령이다. run file 한 건이 legacy/손상 상태라 schema 검증에 실패하면 warning으로 건너뛰고 나머지 run을 계속 처리한다. 반대로 `validate`와 `validate_artifacts --runs-dir/--proposals-dir`는 감사용 명령이므로 계속 엄격하게 실패한다.

큐 파일은 `<proposalId>.json` 이름으로 저장되며 validator가 파일명과 `proposalId` 일치를 확인한다. 같은 proposal이 이미 있으면 기본은 skip이고, 다시 쓰려면 `--overwrite`를 명시한다. 실제 skill/agent 수정은 `p2a-skill-curator` 검토와 사람 승인 이후 별도 변경으로 처리한다.

`review`는 proposal을 classification, targetFiles, recommendedChange 기준으로 그룹화하고 risk/frequency로 recommended disposition을 붙인다. 기본 출력은 `proposals/reviews/<reviewId>.json`이며, 같은 입력이면 같은 content hash 기반 `reviewId`가 나온다. `--output`을 직접 지정하더라도 proposal root 최상위에는 쓰지 않고 `reviews/` 하위나 외부 경로를 쓴다. `approve`는 자동 적용이 아니라 "별도 patch 검토 대상"이라는 추천이다. `verification_gap`은 skipped-verification rationale 표준화 전까지 기본적으로 `needs_more_evidence`로 분류한다.

`curate`는 review group을 approval-ready candidate로 바꾼다. 기본 출력은 `proposals/curations/<curationId>.json`이며, candidate에는 readiness(`patch_candidate`, `needs_evidence`, `watch`, `no_action`), priority, evidenceStrength, separatePatchRequired가 들어간다. 이 단계도 자동 적용은 하지 않으며, `patch_candidate`는 사람 승인 후 별도 patch로 다룰 항목이라는 뜻이다.

`draft-patch`는 curation candidate 1건을 `proposals/patch-drafts/<draftId>.json`으로 바꾼다. patch draft에는 targetFiles, intendedChanges, verificationPlan, risks가 들어가지만 실제 파일 diff를 만들거나 적용하지 않는다. `approvalRequired: true`, `autoApplyAllowed: false`가 validator에서 강제된다.

`approve-draft`는 사람이 승인한 patch draft를 `proposals/approvals/<approvalId>.json`으로 기록하고, `iterations/maintenance/gate-c-task-graph/task-graph.json`에 maintenance task를 append한다. 이 명령도 대상 파일을 수정하지 않으며, approval artifact에는 `autoApplyPerformed: false`가 강제된다. 같은 draft를 다시 승인하면 기존 maintenance task를 재사용해 task 중복을 피한다.

승인된 항목 실행은 `p2a_execute --approval <approval.json>`로 이어간다. 이 옵션은 approval artifact의 `maintenanceTask.taskId`와 task graph의 `sourceSpecRefs`를 대조한 뒤 해당 maintenance task를 plan/start/status/finish 대상으로 선택하고, start run note에 proposal approval/draft/candidate id를 기록한다.

MVP 제약:

- `finished` run에 verification 기록이 없으면 docs/config-only task처럼 의도적으로 검증을 생략한 경우도 verification-gap proposal이 생길 수 있다. 후속에서는 run schema 또는 표준 marker로 skipped-verification rationale을 기록해 이 노이즈를 줄인다.
- `digest`는 빠른 현황 요약이고, 승인 판단은 `review`, `curate`, `draft-patch`, `approve-draft` artifact를 기준으로 한다. 실제 코드 수정은 승인된 maintenance task를 별도 실행해서 진행한다.

## 9. 인계 — `p2a_handoff.mjs`

`p2a_handoff.mjs`는 승인된 Plan2Agent 산출물을 대상 프로젝트로 인계한다. 필수 인자는 다음 세 가지다.

| 필수 인자 | 설명 |
| --- | --- |
| `--project-id <id>` | 산출물 안의 `spec.project_id`, `taskGraph.projectId`, `review.projectId`와 일치해야 하는 프로젝트 식별자. |
| `--artifacts <path>` | Gate별 산출물이 들어 있는 원본 디렉터리. 예: `artifacts/<project_id>` |
| `--target <path>` | 산출물을 받을 개발 대상 프로젝트 디렉터리. |

주요 옵션은 다음 정도만 기억하면 된다.

| 주요 옵션 | 설명 |
| --- | --- |
| `--mode copy|move` | 기본은 `copy`; `move`는 성공적으로 쓴 뒤 원본 파일을 정리한다. |
| `--iteration-id active|<id>` | 반복 구조 root에서 인계할 반복. 기본값은 `active`; greenfield root에서는 생략한다. |
| `--include-intake` | 사람용 `gate-a-intake/intake.md`도 함께 포함한다. `intake.json`은 `spec.source_intake` 추적성을 위해 항상 복사된다. |
| `--tools codex,claude,gemini|all` | 대상 프로젝트에 P2A AI 개발용 skill/agent/command shim을 복사한다. 생략하면 복사하지 않는다. |
| `--include-team-bigfive` | 대상 프로젝트에 Team Big Five adapter를 설치한다. |
| `--team-bigfive-source <path-or-git-url>` | Team Big Five 원본 출처. local directory는 파일 목록과 SHA-256을 기록하고, Git URL은 fetch 없이 URL만 기록한다. |
| `--team-bigfive-targets codex,claude,gemini|all` | adapter 설치 대상. 생략하면 `--tools` 값, `--tools`도 없으면 `all`을 사용한다. |
| `--overwrite` | 대상 파일이 이미 있을 때 덮어쓰기를 허용한다. |
| `--dry-run` | 파일을 쓰지 않고 gate 검증과 인계 계획 출력만 수행한다. |

인계 전제는 Gate B~D가 통과된 상태다. 특히 `spec.approval`은 `approved`여야 하고, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하며, `spec.open_decisions`와 `review.json.blocking_issues`는 비어 있어야 한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 기본 실행 도구로 `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_orchestrate.mjs`, `p2a_proposals.mjs`, `validate_artifacts.mjs`, run/orchestration/proposal/review/curation/patch-draft schema가 함께 설치되며, `.plan2agent/project.config.json.runTracking`에 기본 runs directory와 branch/worktree naming hint가 기록된다.

`--tools`를 지정하면 공통 P2A 원본인 `.agents/skills`, `.agents/agents`와 선택한 CLI별 mirror를 함께 복사한다. `codex`는 `.codex/agents`, `claude`는 `.claude/skills`와 `.claude/agents`, `gemini`는 `.gemini/agents`와 `.gemini/commands/p2a`를 추가한다. 복사된 파일과 선택한 CLI 범위는 `.plan2agent/manifest.json`의 `aiToolTargets`, `aiToolFiles`, `toolFiles`에 기록된다.

`--include-team-bigfive`를 지정하면 `.plan2agent/team-harnesses/team-bigfive/source-manifest.json`과 `adaptation-notes.md`를 생성하고, 선택한 CLI별 adapter entrypoint를 설치한다. Codex는 `.agents/skills/team-bigfive-kickoff/`와 `.codex/agents/team-bigfive-coordinator.toml`, Claude는 `.claude/skills/team-bigfive-kickoff/`와 `.claude/agents/team-bigfive-coordinator.md`, Gemini는 `.agents/skills/team-bigfive-kickoff/`, `.gemini/agents/team-bigfive-coordinator.md`, `.gemini/commands/p2a/team-bigfive.toml`을 사용한다. local source이고 Claude target이 포함되면 안전 필터를 통과한 원본 파일도 `.claude-plugin/team-bigfive/source/`에 복사한다. 설치 내역은 `manifest.json.externalHarnesses`, `externalHarnessFiles`, `project.config.json.teamBigFive`에 기록된다.

반복 구조 root를 인계할 때 maintenance task graph가 있으면 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다. active feature graph와 병합하지 않으며, `manifest.json.maintenanceFiles`와 `current-spec.json.handoff_records`에 handoff 기준점이 남는다.

권장 순서는 dry-run으로 계획을 확인한 뒤 실제 인계를 실행하는 것이다.

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake \
  --dry-run

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project \
  --iteration-id active \
  --include-intake \
  --tools codex,claude,gemini

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project \
  --tools codex,claude,gemini \
  --include-team-bigfive \
  --team-bigfive-source ../team-bigfive \
  --team-bigfive-targets codex,claude,gemini
```

터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 project id, artifacts 경로, target 경로, mode, include-intake, tools, Team Big Five, overwrite 여부를 순서대로 묻고 dry-run preview 후 실제 실행 여부를 확인하는 대화형 모드가 열린다.

```bash
node scripts/p2a_handoff.mjs
node scripts/p2a_handoff.mjs -i
```

## 10. 대표 워크플로우

### 워크플로우 A — 기획 산출물 검증 후 인계

```bash
node scripts/validate_artifacts.mjs \
  --intake artifacts/<project_id>/gate-a-intake/intake.json \
  --spec artifacts/<project_id>/gate-b-spec/spec.json \
  --task-graph artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec artifacts/<project_id>/gate-b-spec/spec.json \
  --review artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass \
  --status artifacts/<project_id>/status.md

node scripts/validate_artifacts.mjs \
  --artifact-root artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project \
  --dry-run

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target ../target-project
```

### 워크플로우 B — 대상 프로젝트에서 ready task로 개발 시작

인계 후 대상 프로젝트에서 실행한다.

```bash
node scripts/p2a_execute.mjs plan \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001

node scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/task-graph.json \
  --task task-001 \
  --agent-tool codex

node scripts/p2a_execute.mjs finish \
  --graph .plan2agent/artifacts/task-graph.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

`start`가 출력한 prompt를 Claude Code, Codex, Gemini CLI 같은 agent CLI에 붙여넣고 구현한다. `finish`는 검증 결과를 run log에 기록하고 task를 `done` 또는 `blocked`로 전이한다.

### 워크플로우 C — CLI mirror와 fixture 회귀 확인

CLI asset 또는 fixture를 건드린 뒤에는 다음 순서로 drift와 fixture 회귀를 확인한다.

```bash
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

### 워크플로우 D — run 회고에서 개선 proposal 만들기

대상 프로젝트에서 실패/blocked run이나 verification gap이 쌓인 뒤 실행한다.

```bash
node scripts/p2a_proposals.mjs mine \
  --graph .plan2agent/artifacts/task-graph.json

node scripts/p2a_proposals.mjs digest \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs review \
  --proposals .plan2agent/proposals

node scripts/p2a_proposals.mjs curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node scripts/p2a_proposals.mjs draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

node scripts/p2a_proposals.mjs approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts artifacts/<project_id> \
  --approved-by <name>

node scripts/validate_artifacts.mjs \
  --proposals-dir .plan2agent/proposals

node scripts/validate_artifacts.mjs \
  --proposal-review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-curation .plan2agent/proposals/curations/proposal-curation-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-patch-draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json

node scripts/validate_artifacts.mjs \
  --proposal-draft-approval .plan2agent/proposals/approvals/proposal-draft-approval-<hash>.json
```

`digest` 결과는 빠른 현황 요약이고, `review`/`curate`/`draft-patch`/`approve-draft` 결과는 승인 판단과 후속 task 연결용 artifact다. 적용은 자동으로 하지 않고, 승인된 maintenance task를 별도 실행해서 반영한다.

### 워크플로우 E — 반복 열기와 Gate A/B 초안 생성

기존 active 반복의 모든 task가 `done`이면 반복을 close하고, 닫힌 반복이 2개 이상일 때는 compose로 current-effective 기준을 갱신한 뒤 다음 반복을 열어 baseline-aware Gate A/B draft를 생성할 수 있다.

```bash
node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --require-close-ready

node scripts/p2a_iteration.mjs close \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs open \
  --artifacts artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

node scripts/p2a_iteration.mjs draft \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id> \
  --allow-planning

node scripts/validate_artifacts.mjs \
  --intake artifacts/<project_id>/iterations/iter-002/gate-a-intake/intake.json \
  --spec artifacts/<project_id>/iterations/iter-002/gate-b-spec/spec.json

# Gate B 승인 후:
node scripts/p2a_iteration.mjs promote-spec \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs diff-tasks \
  --artifacts artifacts/<project_id>

# Gate C task graph 실행과 Gate D review까지 완료한 뒤:
node scripts/p2a_iteration.mjs close \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs compose \
  --artifacts artifacts/<project_id>

node scripts/p2a_iteration.mjs open \
  --artifacts artifacts/<project_id> \
  --iteration-id iter-003 \
  --idea "다음 변경 아이디어"
```

### 워크플로우 E — maintenance task 추가

작은 버그 수정, 문서 보정, 패치성 변경은 기능 반복을 새로 열지 않고 상시 `maintenance` task graph에 추가한다. 첫 task를 추가할 때 graph가 없으면 `iterations/maintenance/gate-c-task-graph/task-graph.json`이 생성되고, 이후 실행은 다음 task id로 append한다.

```bash
node scripts/p2a_iteration.mjs maintenance add \
  --artifacts artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"

node scripts/p2a_iteration.mjs maintenance add \
  --artifacts artifacts/<project_id> \
  --title "Patch cache docs" \
  --accept "Cache docs describe invalidation" \
  --accept "Existing examples still render" \
  --ref effective_product.problem

node scripts/p2a_iteration.mjs validate \
  --artifacts artifacts/<project_id>
```

`maintenance add`는 active 기능 반복이 close-ready가 아니어도 실행할 수 있지만, `compose`, active iteration 회전, close 대상에는 maintenance를 포함하지 않는다.

---

정확한 전체 옵션은 각 도구의 `--help`가 정본이다. `p2a_tasks.mjs`와 `p2a_handoff.mjs`는 터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 대화형 메뉴가 뜬다. 이 문서는 개요·흐름·예시용이며, 옵션 세부는 `--help`를 따른다.
