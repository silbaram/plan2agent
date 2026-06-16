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
| `scripts/p2a_handoff.mjs` | 새 프로젝트에 co-located 하네스를 scaffold하거나, Gate D까지 통과한 산출물을 대상 프로젝트로 복사/이동한다. |

전체 흐름은 다음과 같다.

1. 하네스가 한 문장 아이디어에서 **Gate A intake → Gate B spec → Gate C task graph → Gate D review** 산출물을 만든다.
2. `validate_artifacts.mjs`, `run_fixtures.mjs`, `check_cli_parity.mjs`로 산출물과 CLI 구성을 검증한다.
3. 새 프로젝트는 먼저 `p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서 `p2a_tasks.mjs ready`와 `p2a_tasks.mjs prompt`로 구현 가능한 task와 실행 prompt를 뽑아 개발을 시작한다.
5. `p2a_runs.mjs start/verify/finish`로 agentTool, workspaceRef, branch/worktree 격리 기준, changedFiles, test/lint/typecheck 결과를 run log로 남긴다.

## 2. Co-located scaffold — `p2a_handoff.mjs scaffold`

```bash
node scripts/p2a_handoff.mjs scaffold --target <project-dir> [--tools all|none|codex,claude,gemini] [--overwrite] [--dry-run]
```

`scaffold`는 아직 산출물이 없는 fresh 프로젝트에 P2A 하네스 전체를 1회 설치한다. `scripts/`에는 `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs`가 복사되고, `schemas/`에는 intake/spec/task graph/task context/review/run/run-index schema가 복사된다. `--tools` 기본값은 `all`이며, 기존 AI 자산 복사 로직으로 `.agents`, `.claude`, `.codex`, `.gemini` 자산을 설치한다. `.plan2agent/project.config.json`, `.plan2agent/manifest.json`, `PLAN2AGENT.md`도 생성한다.

`--artifacts`는 필요 없다. `--dry-run`은 쓸 파일 목록만 출력하고, `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다. 서브커맨드 없이 실행하는 기존 flag 기반 handoff 동작은 하위호환으로 유지된다.

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
  --artifacts artifacts/<project_id>

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

`--status`는 top-level `status.md` standing document의 최소 구조를 확인한다. `--artifact-root`는 `artifacts/<project_id>/` 아래 Gate A-D bundle을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `status.md`의 `Gate B approval audit` block도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다. 이 검사는 모든 intake `CQ-n`이 `spec.clarifying_question_disposition`에 처분됐는지, `open_decisions`가 unresolved intake decision과 CQ에서 승격된 decision을 정확히 반영하는지 확인한다. `--require-handoff-ready`를 함께 쓰면 Gate B-D가 모두 통과되어 인계 가능한 상태인지까지 확인한다. `--review`는 review artifact가 schema에 맞는지 확인한다. `--require-review-pass`를 함께 쓰면 Gate D 통과 조건인 `review.blocking_issues: []`까지 확인한다. `--run`, `--run-index`, `--runs-dir`는 `p2a_runs.mjs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--require-approved-spec`는 task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때 함께 사용하며, spec의 `source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다. `p2a_iteration.mjs validate`는 반복 구조의 active iteration 포인터, active Gate B-D 산출물, task dependency, review blocker, current-spec composition을 검증한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--stage gate-c-draft`는 draft task graph의 schema, 중복 id, dependency, cycle만 확인하며 승인 audit은 요구하지 않는다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지까지 확인한다. closed iteration archive audit은 기본 수행되며, legacy/migration 상황에서만 `--skip-archive-audit`로 건너뛸 수 있다. `p2a_iteration.mjs close`는 close-ready active 반복을 archived metadata로 표시하고 `status.md`의 close audit에 누적한다. `p2a_iteration.mjs open`은 archived active 반복을 baseline으로 다음 반복 skeleton을 만들고, 닫힌 반복이 2개 이상이면 먼저 composed current-spec을 요구한다. `p2a_iteration.mjs draft`는 Gate A-only 초기 반복의 Gate B 초안 또는 baseline 기반 Gate A/B delta draft를 만든다. `p2a_iteration.mjs promote-spec`는 approved active spec을 current-spec에 기록한다. `p2a_iteration.mjs context`는 agent 저작 Gate C 초안에 필요한 `p2a.task_context.v1` JSON을 stdout으로만 출력한다. `p2a_iteration.mjs promote-tasks`는 approved active spec과 `status.md`의 `Gate C approval audit` block을 확인한 뒤 `task-graph.draft.json`을 canonical `task-graph.json`으로 승격하고, `task-graph.draft.meta.json` provenance sidecar와 draft `.promoted` history를 보존한다. `p2a_iteration.mjs diff-tasks`는 active spec과 baseline의 field 차이를 입력으로 삼아 requirements/security/integration/api/ui/data/delivery/architecture/verification semantic group으로 병합/분할한 Gate C task graph 초안을 만든다. 닫힌 반복의 완료 task와 `sourceSpecRefs`가 겹치면 `Rework ...` task로 표시하고, `--force` 재생성 시 기존 active graph의 미완료 task id/status를 재사용한다. implementation task가 있으면 verification task가 후속 dependency로 붙고, clarifying question disposition/user answer 재처분 검토는 requirements/verification task acceptance에 포함된다. `p2a_iteration.mjs compose`는 approved + close-ready 반복 spec들을 `current-spec.json`의 effective view로 조합하며, conflict는 기본적으로 쓰기 전에 실패하고 `--allow-conflicts`일 때만 `open_decisions`로 기록한다. `p2a_iteration.mjs maintenance add`는 Gate A/B/D 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`(기본 title), `--area`(기본 `maintenance`), `--prompt`(기본 자동 생성), 반복 가능한 `--ref`(기본 `maintenance`), 반복 가능한 `--depends`, `--dry-run`이다. `--ref` 값은 기존 task graph와 같이 free string으로 받으며, 예를 들어 `--ref effective_product.problem`로 current spec의 추적 위치를 남길 수 있다.

## 4. 개발 진행 — `p2a_tasks.mjs`

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

## 4. 실행 추적 — `p2a_runs.mjs`

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

## 5. 인계 — `p2a_handoff.mjs`

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

인계 전제는 Gate B~D가 통과된 상태다. 특히 `spec.approval`은 `approved`여야 하고, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하며, `spec.open_decisions`와 `review.json.blocking_issues`는 비어 있어야 한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 기본 실행 도구로 `p2a_tasks.mjs`, `p2a_runs.mjs`, `validate_artifacts.mjs`, run schema가 함께 설치되며, `.plan2agent/project.config.json.runTracking`에 기본 runs directory와 branch/worktree naming hint가 기록된다.

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

## 6. 대표 워크플로우

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
node scripts/p2a_tasks.mjs ready \
  --graph .plan2agent/artifacts/task-graph.json

node scripts/p2a_tasks.mjs prompt \
  --graph .plan2agent/artifacts/task-graph.json \
  --spec .plan2agent/artifacts/spec.json \
  task-001

node scripts/p2a_tasks.mjs start \
  --graph .plan2agent/artifacts/task-graph.json \
  task-001
```

출력된 prompt를 Claude Code, Codex, Gemini CLI 같은 agent CLI에 붙여넣고 구현한다. 검증 후에는 같은 graph에 대해 `done <task-id>`로 상태를 기록한다.

### 워크플로우 C — CLI mirror와 fixture 회귀 확인

CLI asset 또는 fixture를 건드린 뒤에는 다음 순서로 drift와 fixture 회귀를 확인한다.

```bash
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

### 워크플로우 D — 반복 열기와 Gate A/B 초안 생성

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
