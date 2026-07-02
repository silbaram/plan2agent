# Plan2Agent CLI 사용자 가이드

이 문서는 Plan2Agent에서 자주 쓰는 CLI 흐름과 대표 명령을 한곳에 모은 사용자 가이드다. 옵션 전체를 복제하지 않고, 실제 사용 흐름에 필요한 주요 명령과 예시만 다룬다. 세부 옵션은 각 도구의 `--help` 또는 스크립트 usage가 정본이다.

문서 홈: [Plan2Agent Docs](README.md) · 먼저 보기: [Quickstart](quickstart.md)

## 1. 개요

Plan2Agent CLI는 기획 산출물을 검증하고, 승인된 task graph를 기반으로 개발 진행 상태와 agent 실행 결과를 관리하며, 대상 저장소로 인계하는 데 필요한 보조 도구다.

| 스크립트 | 한 줄 요약 |
| --- | --- |
| `scripts/sync_cli_assets.mjs` | Plan2Agent 본체 저장소 루트에서 `.agents/` canonical skill/agent 원본을 Claude/Codex/Gemini용 mirror로 생성하거나 drift를 검사한다. |
| `scripts/check_cli_parity.mjs` | Plan2Agent 본체 저장소 루트에서 생성 산출물과 CLI shim이 canonical 원본과 동기화되어 있는지 검사한다. |
| `scripts/run_fixtures.mjs` | Plan2Agent 본체 저장소 루트에서 `fixtures/` 아래 golden fixture들을 한 번에 검증한다. |
| `scripts/p2a_doctor.mjs` | Plan2Agent 본체 저장소 루트에서 scaffold 대상 프로젝트의 runtime scripts/schemas/config/manifest 상태를 진단한다. |
| `.plan2agent/scripts/validate_artifacts.mjs` | intake, spec, task graph, review, fixture 산출물이 schema/gate 계약을 만족하는지 검증한다. |
| `.plan2agent/scripts/p2a_iteration.mjs` | 반복 구조 변환, active iteration 확인, 반복 검증, close/open, Gate A/B draft 생성을 관리한다. |
| `.plan2agent/scripts/p2a_tasks.mjs` | 승인된 task graph의 ready task 확인, 실행 prompt 출력, 상태 전이를 관리한다. |
| `.plan2agent/scripts/p2a_runs.mjs` | task별 agent run log, changed files, verification, workspace/branch/worktree 참조를 기록한다. |
| `.plan2agent/scripts/p2a_execute.mjs` | ready task 1건의 plan/start/finish/status를 감독형 실행 흐름으로 묶는다. |
| `.plan2agent/scripts/p2a_orchestrate.mjs` | ready task 1건의 supervised orchestration plan, role prompt, monitor gate, runtime sidecar를 생성·기록한다. |
| `.plan2agent/scripts/p2a_proposals.mjs` | run log와 orchestration sidecar에서 Hermes식 개선 proposal 후보, review/curation artifact, non-applying patch draft, approval artifact를 생성한다. |
| `scripts/p2a_handoff.mjs` | Plan2Agent 본체 저장소 루트에서 새 프로젝트에 co-located 하네스를 scaffold하거나, Gate D까지 통과한 산출물을 대상 프로젝트로 복사/이동한다. |

스크립트 경계는 `scripts/p2a_tool_manifest.mjs`가 정본이다.

| 분류 | 실행 위치 | 포함 스크립트 | 대상 프로젝트 설치 여부 |
| --- | --- | --- | --- |
| repo-only toolkit | Plan2Agent 본체 저장소 | `p2a_tool_manifest.mjs`, `p2a_doctor.mjs`, `p2a_handoff.mjs`, `sync_cli_assets.mjs`, `check_cli_parity.mjs`, `run_fixtures.mjs` | 설치하지 않음 |
| project runtime | scaffold/handoff 대상 프로젝트 | `p2a_paths.mjs`, `p2a_project_config.mjs`, `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_orchestrate.mjs`, `p2a_proposals.mjs`, `p2a_run_paths.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs` | `.plan2agent/scripts/`에 설치 |
| GUI app-local | `apps/p2a-gui` | `ensure-node-pty-helper-mode.mjs`, `packaged-smoke.mjs` | 설치하지 않음 |

전체 흐름은 다음과 같다.

1. 하네스가 한 문장 아이디어에서 **Gate A intake → Gate B spec → Gate C task graph → Gate D review** 산출물을 만든다.
2. Plan2Agent 본체 저장소에서는 `scripts/validate_artifacts.mjs`, `scripts/run_fixtures.mjs`, `scripts/check_cli_parity.mjs`로 fixture와 CLI 구성을 검증한다. scaffold 대상 프로젝트에서는 `.plan2agent/scripts/validate_artifacts.mjs`와 `.plan2agent/scripts/p2a_iteration.mjs`로 산출물을 검증한다.
3. 새 프로젝트는 먼저 `p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서 `p2a_execute.mjs plan/start`로 ready task 1건의 run을 열고 감독형 agent prompt를 출력한다. 세션이 끊기면 `p2a_execute.mjs resume`으로 같은 run prompt를 다시 출력한다. 복수 agent 역할이나 monitor gate가 필요한 task는 먼저 `p2a_orchestrate.mjs plan`으로 실행 계획을 만든다.
5. `p2a_execute.mjs status/finish`로 run 상태 확인, verification, run finish, task done/block 전이를 묶어 기록한다. 세부 제어가 필요하면 `p2a_tasks.mjs`와 `p2a_runs.mjs`를 직접 사용한다.
6. 실패, blocked monitor verdict, verification gap이 쌓이면 `p2a_proposals.mjs mine/review/curate/draft-patch/approve-draft/digest`로 개선 proposal queue, curator review artifact, approval-ready curation artifact, non-applying patch draft, 승인 artifact를 만든다. proposal 적용은 승인된 maintenance task를 별도 실행해서 진행한다.

## 2. Co-located scaffold — `p2a_handoff.mjs scaffold`

```bash
node scripts/p2a_handoff.mjs scaffold --target <project-dir> [--tools all|none|codex,claude,gemini] [--overwrite] [--dry-run]
node scripts/p2a_handoff.mjs enhance dev-skills --target <project-dir> [--tools all|none|codex,claude,gemini] [--overwrite] [--dry-run]
node scripts/p2a_handoff.mjs upgrade --target <project-dir> --dry-run [--tools all|none|codex,claude,gemini]
```

`scaffold`는 아직 산출물이 없는 fresh 프로젝트에 P2A 하네스 전체를 1회 설치한다. `.plan2agent/scripts/`에는 `p2a_paths.mjs`, `p2a_project_config.mjs`, `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_orchestrate.mjs`, `p2a_proposals.mjs`, `p2a_run_paths.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs`가 복사되고, `.plan2agent/schemas/`에는 intake/spec/task graph/task context/review/run/run-index/orchestration-plan/orchestration-runtime/skill-proposal/proposal-review/proposal-curation/proposal-patch-draft/proposal-draft-approval schema가 복사된다. `--tools` 기본값은 `all`이며, AI 자산 복사 로직으로 `.agents`, `.claude`, `.codex`, `.gemini` 자산을 설치한다. 단, `p2a-design-system` skill과 Gemini `design-system.toml` command는 Plan2Agent 본체 UI 개발용 자산이므로 scaffold 대상 프로젝트에는 복사하지 않는다. `.plan2agent/project.config.json`, `.plan2agent/manifest.json`, `PLAN2AGENT.md`, 프로젝트용 `.gitignore`도 생성한다. 기존 코드가 있으면 `project.config.json`의 package/test/lint/typecheck 기본값을 감지하고, 빈 프로젝트는 이후 `verify --test` 같은 검증 시점에 다시 감지해 저장한다. 생성된 `.gitignore`는 `.plan2agent/` 전체를 로컬 하네스 상태로 보고 application source git에서 제외한다. `scaffold`는 co-located 정식 진입점으로, 빈 프로젝트에 하네스를 설치한 뒤 기획·개발·반복을 그 프로젝트 안에서 진행하게 한다.

`enhance dev-skills`는 기존 scaffold 대상 프로젝트에 provider별 P2A skill/agent/command shim과 development config 기본값을 설치하거나 보강한다. `project.config.json`에는 `devExecution`, `roleProfiles`, `promptTemplates` 기본값을 비파괴 병합하고, `manifest.json.enhancements.devSkills`에는 선택한 provider와 prompt/role/provider guide version을 기록한다. 기존 asset 파일이 대상에 있고 toolkit 내용과 다르면 기본적으로 실패하며, 사람이 dry-run 결과를 검토한 뒤 `--overwrite`를 명시해야 덮어쓴다.

`upgrade --dry-run`은 기존 scaffold 대상 프로젝트의 runtime script/schema/AI tool asset/generated file을 현재 toolkit 기준과 비교한다. 출력은 `unchanged`, `missing`, `would_update`, `manual_review`, `conflict`, `error`로 나뉘며 파일은 쓰지 않는다. `.plan2agent/manifest.json` 또는 `project.config.json`을 읽을 수 없거나 target path가 유효하지 않으면 non-zero exit를 반환한다. 실제 upgrade write는 아직 의도적으로 막혀 있으며, dry-run 없이 실행하면 실패한다.

P2A planning artifact, run log, proposal, 생성된 runtime helper의 장기 보존은 Plan2Agent Memory 동기화 또는 명시 export를 기준으로 한다. git commit은 제품 소스코드와 사람이 유지할 프로젝트 설정 이력에 집중한다.

`--artifacts`는 필요 없다. `--dry-run`은 쓸 파일 목록만 출력하고, `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다. 서브커맨드 없이 실행하는 기존 flag 기반 handoff 동작은 하위호환으로 유지된다. `handoff`는 plan2agent에서 이미 기획한 승인 산출물을 별도 프로젝트로 옮길 때 쓰는 레거시/특수 흐름이다.

## 3. 동기화·검증

### `p2a_doctor.mjs`

Plan2Agent 본체 개발자용 진단 스크립트다. `scripts/p2a_tool_manifest.mjs`의 runtime script/schema 목록을 기준으로 scaffold 대상 프로젝트의 `.plan2agent/scripts/`, `.plan2agent/schemas/`, `manifest.json`, `project.config.json` 상태를 확인한다. repo-only script가 대상 프로젝트의 `.plan2agent/scripts/`에 들어가 있으면 경고한다.

```bash
node scripts/p2a_doctor.mjs --target <project-dir>
node scripts/p2a_doctor.mjs --target <project-dir> --json
node scripts/p2a_doctor.mjs --target <project-dir> --dev --json
node scripts/p2a_doctor.mjs --target <project-dir> --strict
```

출력에는 설치 파일 체크와 별개로 `projectState`가 포함된다. `projectState.state`는 `installed_empty`, `planning_in_progress`, `iteration_init_required`, `execution_ready`, `cycle_close_ready`, `broken_install`, `no_p2a` 중 하나이며, artifact root별 Gate A-D 존재 여부, Gate B approval/open decision 수, Gate C task count/ready 수, Gate D blocker 수, run-index 요약을 함께 보여준다. scaffold 프로젝트에 greenfield Gate A-D bundle이 있으면 `project_state` 체크가 warning으로 표시되고 `p2a_iteration init` 명령을 next action으로 출력한다.

`--dev`는 development skill/config 진단을 추가한다. `manifest.aiToolTargets` 기준으로 Codex/Claude/Gemini provider asset, role profile, `manifest.aiToolFiles`, `project.config.json.providerNativeCapabilities`, `runTracking`, `devExecution`, `roleProfiles`, `promptTemplates`, Claude PreToolUse confinement hook 상태를 확인한다. `--strict`는 warning만 있어도 non-zero exit를 반환한다. 일반 실행은 failure가 있을 때만 non-zero exit를 반환한다.

### `sync_cli_assets.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `.agents/skills/`와 `.agents/agents/`를 기준으로 Claude, Codex, Gemini용 mirror 파일을 생성한다. 일반 실행은 파일을 갱신하고, `--check`는 쓰기 없이 drift만 검사한다. scaffold 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/sync_cli_assets.mjs
node scripts/sync_cli_assets.mjs --check
```

### `check_cli_parity.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `sync_cli_assets.mjs --check`를 포함해 skill mirror byte 비교, agent mirror 존재 여부, Gemini command shim 필수 내용 등을 검사한다. scaffold 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/check_cli_parity.mjs
```

### `run_fixtures.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `fixtures/` 아래 각 일반 fixture 디렉터리를 `validate_artifacts.mjs --fixture-dir` 조합으로 검증한다. `fixtures/_e2e/manifest.json`이 있으면 artifact-root fixture를 `--require-handoff-ready`로 검증하고, `fixtures/_negative/manifest.json`이 있으면 중단/실패 fixture도 실행해서 기대한 실패 메시지가 나오는지 확인한다. fixture/golden 변경 후 전체 회귀 확인용으로 쓴다. scaffold 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/run_fixtures.mjs
```

### `validate_artifacts.mjs`

개별 산출물 또는 fixture 디렉터리를 검증한다. 자주 쓰는 조합은 다음과 같다.

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --status .plan2agent/artifacts/<project_id>/status.md

node .plan2agent/scripts/validate_artifacts.mjs \
  --artifact-root .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/validate_artifacts.mjs \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --task-graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass

node .plan2agent/scripts/validate_artifacts.mjs \
  --runs-dir .plan2agent/artifacts/<project_id>/runs

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposals-dir .plan2agent/artifacts/<project_id>/proposals

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-review .plan2agent/artifacts/<project_id>/proposals/reviews/proposal-review-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-curation .plan2agent/artifacts/<project_id>/proposals/curations/proposal-curation-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-patch-draft .plan2agent/artifacts/<project_id>/proposals/patch-drafts/proposal-patch-draft-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-draft-approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

node .plan2agent/scripts/validate_artifacts.mjs \
  --fixture-dir fixtures/cache-library

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

node .plan2agent/scripts/p2a_iteration.mjs close \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

node .plan2agent/scripts/p2a_iteration.mjs draft \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs context \
  --artifacts .plan2agent/artifacts/<project_id> \
  --code-root .

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

node .plan2agent/scripts/p2a_iteration.mjs promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."

node .plan2agent/scripts/p2a_iteration.mjs compose \
  --artifacts .plan2agent/artifacts/<project_id> \
  [--allow-conflicts]

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"
```

`--status`는 generated `status.md` view의 최소 구조만 확인한다. `--artifact-root`는 `.plan2agent/artifacts/<project_id>/` 아래 Gate A-D JSON bundle을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `spec.approval_audit`도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다.

`--run`, `--run-index`, `--runs-dir`는 `p2a_runs.mjs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--orchestration-plan`, `--orchestration-runtime`, `--skill-proposal`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`, `--proposals-dir`는 실행 계획/runtime sidecar와 Hermes식 proposal queue/review/curation/patch draft/approval artifact를 검증한다.

`p2a_iteration.mjs validate`는 반복 구조의 active iteration 포인터, active Gate B-D 산출물, task dependency, review blocker, current-spec composition을 검증한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지까지 확인한다. 개별 flat task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때는 `validate_artifacts.mjs --task-graph ... --require-approved-spec ...`를 사용한다.

`p2a_iteration.mjs close/open/draft/promote-spec/context/diff-tasks/promote-tasks/compose`는 반복 planning과 task graph 초안/승격을 다룬다. `diff-tasks`는 `task-graph.draft.json`만 만들고, `promote-tasks`가 사람 승인 audit과 함께 정본 `task-graph.json`으로 승격한다. `p2a_iteration.mjs maintenance add`는 Gate A/B/D 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`, `--area`, `--prompt`, 반복 가능한 `--ref`, 반복 가능한 `--depends`, `--dry-run`이다.

### GUI desktop app — `apps/p2a-gui`

GUI는 Electron Forge + React + TypeScript 앱이다. 선택한 프로젝트의 P2A 설치 상태, task/run/artifact, orchestration runtime/scheduler 상태, PTY session, start/finish lifecycle, 한글/영문 UI를 파일 기반 CLI 계약 위에서 표시한다. GUI의 프로젝트 읽기와 실행 action은 Electron main process의 typed IPC를 거치며, renderer가 임의 파일 경로나 shell API를 직접 호출하지 않는다. orchestration GUI action은 `p2a_orchestrate.mjs mark-role`만 호출해 사람이 관찰한 role 상태를 기록하며, Codex/Claude/Gemini CLI나 browser/background loop를 대신 실행하지 않는다.

운영 원칙: API 요금제 기반 완전 자동 개발은 비용상 보류한다. 구독 로그인 기반 Codex/Claude/Gemini 사용은 공식 CLI/앱을 사람이 foreground에서 열고 승인·감독하는 방식으로 제한한다. p2a는 role, prompt, order, run state를 조율하고 기록할 뿐, browser/background loop, 세션 쿠키·토큰 재사용, 여러 계정 로테이션, rate limit 우회, 무인 headless 실행을 구현하지 않는다.

```bash
cd apps/p2a-gui
npm start -- --project <project-dir>
```

```bash
cd apps/p2a-gui
npm run typecheck
npm test
npm run package
```

## 4. 감독형 단일 task 실행 — `p2a_execute.mjs`

`p2a_execute.mjs`는 Phase 1 감독형 실행기다. 여러 task를 스케줄링하지 않고, ready task 1건에 대해 기존 `p2a_tasks.mjs`와 `p2a_runs.mjs` 흐름을 묶는다. Codex/Claude 구현 세션 자체는 사람이 보는 foreground에서 진행하며, 이 CLI는 run 생성, task 상태 전이, verification, finish, done/block 기록을 연결한다.

Co-located scaffold 프로젝트에서는 Gate D 통과 후 먼저 `p2a_iteration init`으로 반복 구조를 만들고 `--artifacts`를 사용한다.

```bash
node .plan2agent/scripts/p2a_iteration.mjs init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp

node .plan2agent/scripts/p2a_execute.mjs plan \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task task-001

node .plan2agent/scripts/p2a_execute.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task task-001 \
  --agent-tool codex \
  --workspace . \
  --workspace-ref target-project

node .plan2agent/scripts/p2a_execute.mjs finish \
  --artifacts .plan2agent/artifacts/<project_id> \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

Legacy handoff 대상처럼 반복 루트가 아닌 task graph를 명시해야 하는 경우에는 `--graph`를 사용할 수 있다.

```bash
node .plan2agent/scripts/p2a_execute.mjs plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001
```

승인된 proposal patch draft는 approval artifact로 maintenance task를 자동 선택할 수 있다. `--approval`은 `--artifacts`와 함께 쓰며 maintenance task graph를 사용한다.

```bash
node .plan2agent/scripts/p2a_execute.mjs plan \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

node .plan2agent/scripts/p2a_execute.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json \
  --agent-tool codex

node .plan2agent/scripts/p2a_execute.mjs finish \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck
```

`start`는 run을 먼저 만들고 task를 `in_progress`로 바꾼 뒤 manual launcher prompt를 출력한다. `finish`는 verification이 실패하면 기본 failure class를 `verification_failed`로 기록하고 task를 `blocked`로 전이한다. 실패 class를 직접 지정하려면 `--status failed|blocked --failure-class <class>`를 넘긴다.

## 5. 감독형 오케스트레이션 계획 — `p2a_orchestrate.mjs`

`p2a_orchestrate.mjs`는 ready task 1건을 대상으로 deterministic heuristic을 적용해 `solo`, `solo_monitor`, `team` 중 하나의 실행 계획을 만든다. 이 도구는 agent를 자동 실행하지 않는다. owner가 foreground agent 세션을 열고, 생성된 role prompt와 monitor gate를 보며 감독형으로 실행한다.

team mode의 기본 전략은 single-provider다. `--reviewer-tool`을 생략하면 reviewer도 implementer와 같은 provider를 쓴다. Gemini는 write-required implementer로 쓰지 않고, 사용자가 `--reviewer-tool gemini`를 명시한 경우에만 read-only reviewer/monitor 보조로 배정한다. plan에는 `providerStrategy`, `providerCapabilities`, role별 `executionGuide`가 함께 기록되어 이 제한을 검증할 수 있다. `executionGuide`는 공식 foreground CLI/app 표면, 추천 provider 기능, fallback 방식, supervision-required/starts-no-process 경계를 남긴다.

role은 `owner`/`implementer`/`reviewer`/`monitor`를 유지하고, 세부 전문성은 `profile`로 기록한다. 현재 profile은 `frontend_implementer`, `backend_implementer`, `fullstack_implementer`, `test_implementer`, `docs_implementer`, `qa_reviewer`, `architecture_reviewer`, `security_reviewer`, `owner_supervisor`, `manual_monitor`다. `targetArea`, task 본문, acceptance criteria를 기준으로 deterministic하게 선택되며, `profileSource`와 `profileReason`에 자동 선택/수동 override 근거가 남는다. 필요하면 `--implementer-profile <profile>` 또는 team-mode task의 `--reviewer-profile <profile>`로 사람이 전문성을 명시할 수 있고 role prompt에도 profile별 지시와 선택 근거가 포함된다.

`team` mode는 명시적인 다중 영역 task에만 보수적으로 추천한다. `targetArea`에서 복수 영역을 의도할 때는 `api+ui`, `api,ui`, `api&ui`, `api and ui`처럼 comma/plus/ampersand/`and`를 쓴다. `auth/login` 같은 slash 표기는 단일 영역 label로 취급한다.

```bash
node .plan2agent/scripts/p2a_orchestrate.mjs plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --output .plan2agent/orchestration/task-001.json

node .plan2agent/scripts/p2a_orchestrate.mjs handoff \
  --plan .plan2agent/orchestration/task-001.json

node .plan2agent/scripts/p2a_orchestrate.mjs runner-guide \
  --plan .plan2agent/orchestration/task-001.json \
  --role implementer

node .plan2agent/scripts/p2a_orchestrate.mjs runner-doctor \
  --root . \
  --provider all

node .plan2agent/scripts/p2a_orchestrate.mjs runner-doctor \
  --root . \
  --provider codex \
  --live

node .plan2agent/scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --orchestration-plan .plan2agent/orchestration/task-001.json

node .plan2agent/scripts/p2a_orchestrate.mjs runtime-status \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json

node .plan2agent/scripts/p2a_orchestrate.mjs record \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json \
  --role implementer \
  --type status \
  --summary "Implementation session opened"

node .plan2agent/scripts/p2a_orchestrate.mjs next-role \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json

node .plan2agent/scripts/p2a_orchestrate.mjs role-prompt \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json \
  --role implementer

node .plan2agent/scripts/p2a_orchestrate.mjs runner-guide \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json \
  --role implementer

node .plan2agent/scripts/p2a_orchestrate.mjs mark-role \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json \
  --role implementer \
  --role-status complete

node .plan2agent/scripts/p2a_orchestrate.mjs failure-policy \
  --runtime .plan2agent/runs/<run-id>.orchestration-runtime.json
```

`p2a_execute start --orchestration-plan <path>`는 원본 plan을 `runs/<runId>.orchestration.json` sidecar로 연결하고, 같은 run에 `runs/<runId>.orchestration-runtime.json`을 초기화한다. runtime sidecar에는 shared mental model, role assignment, communication log, runtime phase가 들어간다. `record`는 실행 중 질문, 상태, 결정, 검증, monitor verdict 같은 closed-loop 이벤트를 append한다.

`runner-guide`는 plan 또는 runtime에서 role별 provider-native adapter 절차를 출력한다. Codex는 skills/custom agents/명시 subagent prompt, Claude는 agent teams/subagents와 foreground prompt fallback, Gemini는 extensions/custom commands/GEMINI.md 기반 read-only review/monitor 절차를 보여준다. 사용자가 공식 CLI/앱 foreground 세션을 열고 prompt를 붙여넣으면, 그 세션 내부에서 provider-native skill/subagent/custom agent/agent team이 동작할 수 있다. P2A 자체는 guide만 출력하고 provider CLI나 background process를 시작하지 않는다.

`runner-doctor`는 선택한 project root 아래에 P2A CLI, orchestration schema, Codex/Claude/Gemini provider 자산이 설치되어 있는지 파일만 읽어 점검한다. `.plan2agent/project.config.json.providerNativeCapabilities`가 있으면 사람이 확인한 provider-native 기능 evidence도 함께 표시한다. 파일로 확인 가능한 skills/custom agents/custom commands는 asset 상태로 판정하고, Claude agent teams 같은 계정별 기능은 evidence가 없으면 `manual_check`로 남긴다. 기본 모드에서는 provider CLI, browser, background loop, API session을 시작하지 않는다. `--provider codex|claude|gemini`로 범위를 좁힐 수 있다. `--live`를 명시하면 해당 provider의 `--version` probe만 실행해 CLI 존재와 버전 출력만 확인하며, 인증·agent session·API 호출·background loop는 열지 않는다.

`next-role`, `role-prompt`, `mark-role`, `failure-policy`는 감독형 scheduler 명령이다. 이 명령들은 다음 role, provider execution guide, prompt, blocked next action 후보, 실패 후 `retry|ask_user|stop` 정책을 계산하고 사람이 관찰한 상태 전이를 기록할 뿐, Codex/Claude/Gemini CLI, browser, background loop, unofficial API를 실행하지 않는다. `role-prompt`는 provider-native delegation 섹션을 포함해 사용자가 연 foreground 세션 안에서 skill/subagent/custom agent/agent team을 쓰도록 요청할 수 있다. 구독 로그인 기반 사용에서는 사람이 공식 CLI/앱을 직접 열어 prompt를 붙여넣고 결과를 다시 기록한다. monitor role을 `complete`로 기록할 때는 실제 판단값을 `--verdict confirm_done`처럼 함께 넘긴다. 허용 verdict가 아니면 runtime phase는 `blocked`가 되며, 이 runtime은 자동으로 unblock하지 않는다. 계속 진행하려면 `failure-policy`가 제안한 방식에 따라 현재 run을 blocked로 닫고 후속 supervised run이나 maintenance task로 이어간다.

monitor gate가 필요한 plan은 `runs/<runId>.monitor-verdict.json`에 `{"verdict":"confirm_done"}` 같은 verdict가 있어야 `finish`가 done으로 닫힌다. 허용되지 않은 verdict는 plan의 `failureClassMap`에 따라 기존 run failure class로 변환되어 blocked 흐름으로 기록된다.

## 6. 개발 진행 — `p2a_tasks.mjs`

`p2a_tasks.mjs`는 task graph를 읽어 개발 가능한 task를 찾고, 개별 task 실행 prompt를 만들며, 상태를 `todo`, `in_progress`, `done`, `blocked` 사이에서 전이한다.

```bash
node .plan2agent/scripts/p2a_tasks.mjs <command> --graph <path> [--spec <path>] [task-id]
node .plan2agent/scripts/p2a_tasks.mjs <command> --artifacts <iterative-project-dir> [--maintenance] [task-id]
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
node .plan2agent/scripts/p2a_tasks.mjs list \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_tasks.mjs ready \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_tasks.mjs prompt \
  --artifacts .plan2agent/artifacts/<project_id> \
  task-001

node .plan2agent/scripts/p2a_tasks.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  task-001
```

반복 구조로 변환된 artifact는 active iteration을 자동 인식한다. `--maintenance`를 함께 쓰면 active 기능 반복 대신 `iterations/maintenance/gate-c-task-graph/task-graph.json` 단일 그래프를 대상으로 같은 명령을 실행한다. scaffold 프로젝트에서 초기 `gate-c-task-graph/task-graph.json`을 직접 `--graph`로 실행하려 하면 CLI가 `p2a_iteration init`을 요구한다.

```bash
node .plan2agent/scripts/p2a_tasks.mjs ready \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_tasks.mjs prompt \
  --artifacts .plan2agent/artifacts/<project_id> \
  task-001

node .plan2agent/scripts/p2a_tasks.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  task-001

node .plan2agent/scripts/p2a_tasks.mjs ready \
  --artifacts .plan2agent/artifacts/<project_id> \
  --maintenance

node .plan2agent/scripts/p2a_tasks.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --maintenance \
  task-001
```

터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 번호 메뉴 기반 대화형 모드가 열린다. 대화형 모드에서도 active artifact 루트, maintenance 레인, task graph 파일 입력 중 하나를 선택할 수 있다.

```bash
node .plan2agent/scripts/p2a_tasks.mjs
node .plan2agent/scripts/p2a_tasks.mjs -i
```

## 7. 실행 추적 — `p2a_runs.mjs`

`p2a_runs.mjs`는 task graph schema를 바꾸지 않고 별도 `runs/` 디렉터리에 agent 실행 결과를 기록한다. 반복 artifact root에서는 `.plan2agent/artifacts/<project_id>/runs/`, handoff 대상 프로젝트에서는 기본적으로 `.plan2agent/runs/`를 사용한다.

주요 파일:

- `runs/run-index.json` — task별 runId 목록과 latestRunId를 담는 index
- `runs/<runId>.json` — 단일 실행의 agentTool, workspaceRef, isolation, changedFiles, verification 결과

대표 흐름:

```bash
node .plan2agent/scripts/p2a_runs.mjs start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task task-001 \
  --agent-tool codex \
  --workspace /path/to/workspace \
  --workspace-ref feature/task-001 \
  --isolation branch \
  --branch p2a/task-001-run

node .plan2agent/scripts/p2a_runs.mjs verify \
  --artifacts .plan2agent/artifacts/<project_id> \
  --run-id run-... \
  --test \
  --lint \
  --typecheck

node .plan2agent/scripts/p2a_runs.mjs finish \
  --artifacts .plan2agent/artifacts/<project_id> \
  --run-id run-... \
  --changed-file src/example.ts \
  --collect-git

node .plan2agent/scripts/p2a_runs.mjs list \
  --artifacts .plan2agent/artifacts/<project_id>
```

`verify`는 `.plan2agent/project.config.json`의 `testCommand`, `lintCommand`, `typecheckCommand`를 읽는다. 설정이 비어 있으면 현재 workspace의 `package.json`, lockfile, Gradle, Maven 파일을 다시 감지해 누락된 기본 명령을 채운 뒤 실행한다. 별도 명령을 쓰려면 `--test-command`, `--lint-command`, `--typecheck-command`, `--verify-command <type:cmd>`를 넘긴다. 명시 명령을 다음 실행의 기본값으로 저장하려면 `--save-config`를 함께 넘긴다. `--isolation branch|worktree`는 격리 기준을 run log에 기록하며, `--create-isolation`을 함께 줄 때만 실제 `git switch -c` 또는 `git worktree add`를 실행한다.

handoff 대상 프로젝트에서는 다음처럼 쓴다.

```bash
node .plan2agent/scripts/p2a_runs.mjs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex

node .plan2agent/scripts/p2a_runs.mjs verify --run-id run-...
node .plan2agent/scripts/p2a_runs.mjs finish --run-id run-... --collect-git
```

## 8. 개선 proposal 큐 — `p2a_proposals.mjs`

`p2a_proposals.mjs`는 Hermes식 자가 개선 루프의 파일 기반 MVP다. run log, orchestration sidecar, monitor verdict를 읽어 skill/agent/CLI 개선 후보를 `p2a.skill_proposal.v1` JSON으로 만들고, 사람이 검토할 review/curation artifact, non-applying patch draft, approval artifact를 생성한다. proposal 적용은 자동으로 하지 않고 승인된 maintenance task를 별도 실행한다.

기본 저장 위치:

- 반복 artifact root: `.plan2agent/artifacts/<project_id>/proposals/`
- handoff/scaffold 대상 프로젝트: `.plan2agent/proposals/`
- `--graph <path>`를 쓰면 graph에서 추론한 `runs/`의 sibling `proposals/`

대표 흐름:

```bash
node .plan2agent/scripts/p2a_proposals.mjs mine \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

node .plan2agent/scripts/p2a_proposals.mjs list \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs digest \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs review \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node .plan2agent/scripts/p2a_proposals.mjs draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

node .plan2agent/scripts/p2a_proposals.mjs approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by <name>

node .plan2agent/scripts/p2a_proposals.mjs show \
  --proposal-id proposal-run-123-verification-gap \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs validate \
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
| `--artifacts <path>` | Gate별 산출물이 들어 있는 원본 디렉터리. 예: `.plan2agent/artifacts/<project_id>` |
| `--target <path>` | 산출물을 받을 개발 대상 프로젝트 디렉터리. |

주요 옵션은 다음 정도만 기억하면 된다.

| 주요 옵션 | 설명 |
| --- | --- |
| `--mode copy|move` | 기본은 `copy`; `move`는 성공적으로 쓴 뒤 원본 파일을 정리한다. |
| `--iteration-id active|<id>` | 반복 구조 root에서 인계할 반복. 기본값은 `active`; greenfield root에서는 생략한다. |
| `--include-intake` | generated `gate-a-intake/intake.md`가 있으면 함께 포함한다. `intake.json`은 `spec.source_intake` 추적성을 위해 항상 복사된다. |
| `--tools codex,claude,gemini|all` | 대상 프로젝트에 P2A AI 개발용 skill/agent/command shim을 복사한다. 생략하면 복사하지 않는다. |
| `--include-team-bigfive` | 대상 프로젝트에 Team Big Five adapter를 설치한다. |
| `--team-bigfive-source <path-or-git-url>` | Team Big Five 원본 출처. local directory는 파일 목록과 SHA-256을 기록하고, Git URL은 fetch 없이 URL만 기록한다. |
| `--team-bigfive-targets codex,claude,gemini|all` | adapter 설치 대상. 생략하면 `--tools` 값, `--tools`도 없으면 `all`을 사용한다. |
| `--overwrite` | 대상 파일이 이미 있을 때 덮어쓰기를 허용한다. |
| `--dry-run` | 파일을 쓰지 않고 gate 검증과 인계 계획 출력만 수행한다. |

인계 전제는 Gate B~D가 통과된 상태다. 특히 `spec.approval`은 `approved`여야 하고, `spec.approval_audit`가 있어야 하며, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하고, `spec.open_decisions`와 `review.json.blocking_issues`는 비어 있어야 한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. Markdown view 파일은 존재할 때만 함께 복사된다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 기본 실행 도구로 `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_orchestrate.mjs`, `p2a_proposals.mjs`, `validate_artifacts.mjs`, run/orchestration plan/orchestration runtime/proposal/review/curation/patch-draft schema가 함께 설치되며, `.plan2agent/project.config.json.runTracking`에 기본 runs directory와 branch/worktree naming hint가 기록된다.

`--tools`를 지정하면 공통 P2A 원본인 `.agents/skills`, `.agents/agents`와 선택한 CLI별 mirror를 함께 복사한다. `codex`는 `.codex/agents`, `claude`는 `.claude/skills`와 `.claude/agents`, `gemini`는 `.gemini/agents`와 `.gemini/commands/p2a`를 추가한다. 단, `p2a-design-system` skill과 Gemini `design-system.toml` command는 Plan2Agent 본체 UI 개발용 자산이라 대상 프로젝트로 넘기지 않는다. 복사된 파일과 선택한 CLI 범위는 `.plan2agent/manifest.json`의 `aiToolTargets`, `aiToolFiles`, `toolFiles`에 기록된다.

`--include-team-bigfive`를 지정하면 `.plan2agent/team-harnesses/team-bigfive/source-manifest.json`과 `adaptation-notes.md`를 생성하고, 선택한 CLI별 adapter entrypoint를 설치한다. Codex는 `.agents/skills/team-bigfive-kickoff/`와 `.codex/agents/team-bigfive-coordinator.toml`, Claude는 `.claude/skills/team-bigfive-kickoff/`와 `.claude/agents/team-bigfive-coordinator.md`, Gemini는 `.agents/skills/team-bigfive-kickoff/`, `.gemini/agents/team-bigfive-coordinator.md`, `.gemini/commands/p2a/team-bigfive.toml`을 사용한다. local source이고 Claude target이 포함되면 안전 필터를 통과한 원본 파일도 `.claude-plugin/team-bigfive/source/`에 복사한다. 설치 내역은 `manifest.json.externalHarnesses`, `externalHarnessFiles`, `project.config.json.teamBigFive`에 기록된다.

반복 구조 root를 인계할 때 maintenance task graph가 있으면 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다. active feature graph와 병합하지 않으며, `manifest.json.maintenanceFiles`와 `current-spec.json.handoff_records`에 handoff 기준점이 남는다.

권장 순서는 dry-run으로 계획을 확인한 뒤 실제 인계를 실행하는 것이다.

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake \
  --dry-run

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --iteration-id active \
  --include-intake \
  --tools codex,claude,gemini

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
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
node .plan2agent/scripts/validate_artifacts.mjs \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json \
  --task-graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass \
  --status .plan2agent/artifacts/<project_id>/status.md

node .plan2agent/scripts/validate_artifacts.mjs \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --dry-run

node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project
```

### 워크플로우 B — legacy handoff 대상 프로젝트에서 ready task로 개발 시작

인계 후 대상 프로젝트에서 실행한다. 이 흐름은 `.plan2agent/project.config.json.taskGraph`가 flat graph를 가리키는 legacy handoff 대상용이다. Co-located scaffold 프로젝트는 Gate D 이후 `p2a_iteration init`을 먼저 실행하고 `--artifacts .plan2agent/artifacts/<project_id>`를 사용한다.

```bash
node .plan2agent/scripts/p2a_execute.mjs plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001

node .plan2agent/scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex

node .plan2agent/scripts/p2a_execute.mjs resume \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --run-id run-...

node .plan2agent/scripts/p2a_execute.mjs finish \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

`start`가 출력한 prompt를 Claude Code 또는 Codex 같은 write-capable agent CLI에 붙여넣고 구현한다. Gemini CLI는 현재 review/monitor 같은 read-only 보조로만 사용한다. `resume`은 같은 run의 상태와 launcher prompt를 다시 출력하며 파일을 변경하지 않는다. `finish`는 검증 결과를 run log에 기록하고 task를 `done` 또는 `blocked`로 전이한다. 실행 footer에는 `resume`, `status`, `finish`, `review` 명령이 남고, `review`는 해당 run을 `p2a_proposals.mjs mine --run-id <run-id>` 회고 후보 생성으로 연결한다.

### 워크플로우 C — CLI mirror와 fixture 회귀 확인

CLI asset 또는 fixture를 건드린 뒤에는 Plan2Agent 본체 저장소 루트에서 다음 순서로 drift와 fixture 회귀를 확인한다. `sync_cli_assets.mjs`, `check_cli_parity.mjs`, `run_fixtures.mjs`는 본체 개발자용 스크립트이며 scaffold 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

### 워크플로우 D — run 회고에서 개선 proposal 만들기

대상 프로젝트에서 실패/blocked run이나 verification gap이 쌓인 뒤 실행한다.

```bash
node .plan2agent/scripts/p2a_proposals.mjs mine \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

node .plan2agent/scripts/p2a_proposals.mjs digest \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs review \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a_proposals.mjs curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node .plan2agent/scripts/p2a_proposals.mjs draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

node .plan2agent/scripts/p2a_proposals.mjs approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by <name>

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposals-dir .plan2agent/proposals

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-curation .plan2agent/proposals/curations/proposal-curation-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-patch-draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json

node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-draft-approval .plan2agent/proposals/approvals/proposal-draft-approval-<hash>.json
```

`digest` 결과는 빠른 현황 요약이고, `review`/`curate`/`draft-patch`/`approve-draft` 결과는 승인 판단과 후속 task 연결용 artifact다. 적용은 자동으로 하지 않고, 승인된 maintenance task를 별도 실행해서 반영한다.

### 워크플로우 E — 반복 열기와 Gate A/B 초안 생성

기존 active 반복의 모든 task가 `done`이면 반복을 close하고, 닫힌 반복이 2개 이상일 때는 compose로 current-effective 기준을 갱신한 뒤 다음 반복을 열어 baseline-aware Gate A/B draft를 생성할 수 있다.

```bash
node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

node .plan2agent/scripts/p2a_iteration.mjs close \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

node .plan2agent/scripts/p2a_iteration.mjs draft \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning

node .plan2agent/scripts/validate_artifacts.mjs \
  --intake .plan2agent/artifacts/<project_id>/iterations/iter-002/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/iterations/iter-002/gate-b-spec/spec.json

# Gate B 승인 후:
node .plan2agent/scripts/p2a_iteration.mjs promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

node .plan2agent/scripts/p2a_iteration.mjs promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."

# Gate C task graph 실행과 Gate D review까지 완료한 뒤:
node .plan2agent/scripts/p2a_iteration.mjs close \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs compose \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_iteration.mjs open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-003 \
  --idea "다음 변경 아이디어"
```

### 워크플로우 E — maintenance task 추가

작은 버그 수정, 문서 보정, 패치성 변경은 기능 반복을 새로 열지 않고 상시 `maintenance` task graph에 추가한다. 첫 task를 추가할 때 graph가 없으면 `iterations/maintenance/gate-c-task-graph/task-graph.json`이 생성되고, 이후 실행은 다음 task id로 append한다.

```bash
node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Patch cache docs" \
  --accept "Cache docs describe invalidation" \
  --accept "Existing examples still render" \
  --ref effective_product.problem

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id>
```

`maintenance add`는 active 기능 반복이 close-ready가 아니어도 실행할 수 있지만, `compose`, active iteration 회전, close 대상에는 maintenance를 포함하지 않는다.

---

정확한 전체 옵션은 각 도구의 `--help`가 정본이다. `p2a_tasks.mjs`와 `p2a_handoff.mjs`는 터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 대화형 메뉴가 뜬다. 이 문서는 개요·흐름·예시용이며, 옵션 세부는 `--help`를 따른다.
