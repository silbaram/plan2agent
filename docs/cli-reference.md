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
| `.plan2agent/scripts/p2a.mjs` | scaffold 대상 프로젝트의 공통 진입점이다. `info`, `eval`, `memory`, `execute`, `tasks`, `runs`, `iteration`, `orchestrate`, `proposals`, `validate`를 하위 명령으로 위임한다. |
| `.plan2agent/scripts/validate_artifacts.mjs` | intake, spec, task graph, review, fixture 산출물이 schema/gate 계약을 만족하는지 검증한다. |
| `.plan2agent/scripts/p2a_iteration.mjs` | 반복 구조 변환, active iteration 확인, 반복 검증, close/open, Gate A/B draft 생성을 관리한다. |
| `.plan2agent/scripts/p2a_tasks.mjs` | 승인된 task graph의 ready task 확인, 실행 prompt 출력, 상태 전이를 관리한다. |
| `.plan2agent/scripts/p2a_runs.mjs` | task별 agent run log, changed files, verification, workspace/branch/worktree 참조를 기록한다. |
| `.plan2agent/scripts/p2a_execute.mjs` | ready task 1건의 plan/start/finish/status를 감독형 실행 흐름으로 묶는다. |
| `.plan2agent/scripts/p2a_monitor_gate.mjs` | ready task 1건의 supervised monitor gate, role prompt, monitor gate, runtime sidecar를 생성·기록한다. |
| `.plan2agent/scripts/p2a_proposals.mjs` | run log와 orchestration sidecar에서 Hermes식 개선 proposal 후보, review/curation artifact, non-applying patch draft, approval artifact를 생성한다. |
| `.plan2agent/scripts/p2a_eval.mjs` | run acceptance grade, iteration/run regression compare, failure cluster analyze 평가 루프를 수행한다. |
| `.plan2agent/scripts/p2a_memory.mjs` | 로컬 `.plan2agent` 산출물과 Plan2Agent Memory 서버의 status/push/pull/search/history/digest 동기화 루프를 관리한다. |
| `scripts/p2a_handoff.mjs` | Plan2Agent 본체 저장소 루트에서 새 프로젝트에 co-located 하네스를 scaffold하거나, Gate D까지 통과한 산출물을 대상 프로젝트로 복사/이동한다. |

스크립트 경계는 `scripts/p2a_tool_manifest.mjs`가 정본이다.

| 분류 | 실행 위치 | 포함 스크립트 | 대상 프로젝트 설치 여부 |
| --- | --- | --- | --- |
| repo-only toolkit | Plan2Agent 본체 저장소 | `p2a_tool_manifest.mjs`, `p2a_doctor.mjs`, `p2a_handoff.mjs`, `sync_cli_assets.mjs`, `check_cli_parity.mjs`, `run_fixtures.mjs` | 설치하지 않음 |
| project runtime | scaffold/handoff 대상 프로젝트 | `p2a.mjs`, `p2a_paths.mjs`, `p2a_project_config.mjs`, `p2a_run_commands.mjs`, `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_monitor_gate.mjs`, `p2a_proposals.mjs`, `p2a_eval.mjs`, `p2a_memory.mjs`, `p2a_radar_preflight.mjs`, `p2a_run_paths.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs` | `.plan2agent/scripts/`에 설치 |
| GUI app-local | `apps/p2a-gui` | `ensure-node-pty-helper-mode.mjs`, `packaged-smoke.mjs` | 설치하지 않음 |

전체 흐름은 다음과 같다.

1. 하네스가 한 문장 아이디어에서 **Gate A intake → Gate B spec → Gate C task graph → Gate D review** 산출물을 만든다.
2. Plan2Agent 본체 저장소에서는 `scripts/validate_artifacts.mjs`, `scripts/run_fixtures.mjs`, `scripts/check_cli_parity.mjs`로 fixture와 CLI 구성을 검증한다. scaffold 대상 프로젝트에서는 `.plan2agent/scripts/validate_artifacts.mjs`와 `.plan2agent/scripts/p2a_iteration.mjs`로 산출물을 검증한다.
3. 새 프로젝트는 먼저 `p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서는 `node .plan2agent/scripts/p2a.mjs info`로 현재 상태를 확인하고, `p2a.mjs execute plan/start`로 ready task 1건의 run을 열어 감독형 agent prompt를 출력한다. 세션이 끊기면 `p2a.mjs execute resume`으로 같은 run prompt를 다시 출력한다. 복수 agent 역할이나 monitor gate가 필요한 task는 먼저 `p2a.mjs execute start --require-monitor`으로 실행 계획을 만든다.
5. `p2a.mjs execute status/finish`로 run 상태 확인, verification, run finish, task done/block 전이를 묶어 기록한다. 세부 제어가 필요하면 `p2a.mjs tasks`와 `p2a.mjs runs`를 직접 사용한다.
6. 실패, blocked monitor verdict, verification gap이 쌓이면 `p2a.mjs proposals mine/review/curate/draft-patch/approve-draft/digest`로 개선 proposal queue, curator review artifact, approval-ready curation artifact, non-applying patch draft, 승인 artifact를 만든다. proposal 적용은 승인된 maintenance task를 별도 실행해서 진행한다.
7. `p2a.mjs eval grade/compare/analyze/generate/digest`로 run acceptance 증거, iteration regression, 실패 클러스터를 평가하고 proposal/maintenance/delta draft 경로로 연결한다.
8. 장기 보존이나 회고 검색이 필요하면 `p2a.mjs memory status/push/pull/search/history/digest`로 로컬 산출물과 Memory 서버 snapshot의 차이, 검색 결과, timeline, 유지보수 후보를 확인하고, 명시 승인 후 push한다.

## 2. 공통 진입점 — `p2a.mjs`

```bash
node .plan2agent/scripts/p2a.mjs info
node .plan2agent/scripts/p2a.mjs eval generate --artifacts .plan2agent/artifacts/<project_id>
node .plan2agent/scripts/p2a.mjs memory history --artifacts .plan2agent/artifacts/<project_id>
node .plan2agent/scripts/p2a.mjs execute plan --artifacts .plan2agent/artifacts/<project_id> --task <task-id>
node .plan2agent/scripts/p2a.mjs update --dry-run
```

`p2a.mjs`는 scaffold 대상 프로젝트에 설치되는 얇은 dispatcher다. `eval`, `memory`, `execute`, `tasks`, `runs`, `iteration`, `orchestrate`, `proposals`, `validate`는 같은 `.plan2agent/scripts/` 안의 runtime 스크립트로 위임한다. `doctor`, `update`, `upgrade`, `enhance`는 scaffold 시 `.plan2agent/manifest.json`에 기록된 `provenance.toolkitRoot`를 사용해 Plan2Agent toolkit checkout의 repo-only 스크립트로 위임하며, target을 생략하면 현재 scaffold 프로젝트를 기본 대상으로 삼는다.

P2A에는 별도 `setup` 명령이 없다. fresh project 설치 진입점은 `scaffold`이며, 설치 이후 capability 보강은 `enhance`, drift 확인과 갱신은 `update`/`upgrade`, 상태 확인은 `info`/`doctor`가 담당한다.

## 3. Co-located scaffold — `p2a_handoff.mjs scaffold`

```bash
node scripts/p2a_handoff.mjs scaffold --target <project-dir> [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
node scripts/p2a_handoff.mjs enhance <capability> --target <project-dir> [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
node scripts/p2a_handoff.mjs update --target <project-dir> [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--dry-run|--apply]
node scripts/p2a_handoff.mjs upgrade --target <project-dir> (--dry-run|--apply) [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit]
```

`scaffold`는 아직 산출물이 없는 fresh 프로젝트에 P2A 하네스 전체를 1회 설치한다. `.plan2agent/scripts/`에는 `p2a.mjs`, `p2a_paths.mjs`, `p2a_project_config.mjs`, `p2a_run_commands.mjs`, `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_monitor_gate.mjs`, `p2a_proposals.mjs`, `p2a_eval.mjs`, `p2a_memory.mjs`, `p2a_radar_preflight.mjs`, `p2a_run_paths.mjs`, `p2a_iteration_state.mjs`, `validate_artifacts.mjs`가 복사되고, `.plan2agent/schemas/`에는 intake/spec/task graph/task context/review/run/run-index/milestone-review/skill-proposal/proposal-review/proposal-curation/proposal-patch-draft/proposal-draft-approval/eval-index/eval-digest/eval-maintenance-draft/eval-maintenance-apply-report schema가 복사된다. `--tools` 기본값은 `all`이며, AI 자산 복사 로직으로 `.agents`, `.claude`, `.codex`, `.gemini` 자산을 설치한다. 단, `p2a-design-system` skill과 Gemini `design-system.toml` command는 Plan2Agent 본체 UI 개발용 자산이므로 scaffold 대상 프로젝트에는 복사하지 않는다. `.plan2agent/project.config.json`, `.plan2agent/manifest.json`, `PLAN2AGENT.md`, 프로젝트용 `.gitignore`도 생성한다. 기존 코드가 있으면 `project.config.json`의 package/test/lint/typecheck 기본값을 감지하고, 빈 프로젝트는 이후 `verify --test` 같은 검증 시점에 다시 감지해 저장한다. 생성된 `.gitignore`는 `.plan2agent/` 전체를 로컬 하네스 상태로 보고 application source git에서 제외한다. `scaffold`는 co-located 정식 진입점으로, 빈 프로젝트에 하네스를 설치한 뒤 기획·개발·반복을 그 프로젝트 안에서 진행하게 한다.

Codex agent는 기본 `--codex-profile quality`에서 `gpt-5.6-sol`과 tier별 `medium/high/max` reasoning을 사용한다. 모델 접근 권한, 외부 provider, 구형 Codex 호환성이 필요하면 `--codex-profile inherit`을 선택해 agent TOML의 model/reasoning override를 제거하고 부모 세션 값을 상속한다. 선택은 `.plan2agent/manifest.json.codexAgentProfile`에 기록되며, 별도 override가 없는 update/upgrade는 그 값을 유지한다. 이 필드가 없는 구형 manifest는 기존 부모 모델 상속 동작을 보존하도록 `inherit`으로 migration하며, `quality` 전환은 `--codex-profile quality`를 명시해야 한다.

`enhance dev-skills`는 기존 scaffold 대상 프로젝트에 provider별 P2A skill/agent/command shim과 development config 기본값을 설치하거나 보강한다. `project.config.json`에는 `devExecution`, `roleProfiles`, `promptTemplates` 기본값을 비파괴 병합하고, `manifest.json.enhancements.devSkills`에는 선택한 provider와 prompt/role/provider guide version을 기록한다. 기존 asset 파일이 대상에 있고 toolkit 내용과 다르면 기본적으로 실패하며, 사람이 dry-run 결과를 검토한 뒤 `--overwrite`를 명시해야 덮어쓴다.

`enhance memory`, `enhance gui`, `enhance orchestration`, `enhance proposals`는 provider asset을 복사하지 않고 capability별 project config 기본값과 `manifest.json.enhancements.<capability>` 기록만 비파괴 병합한다. 이 단계는 Memory sync, GUI project metadata, supervised orchestration, proposal queue를 prototype-first로 켜는 표면이며 실제 외부 push나 provider 실행은 하지 않는다. `enhance memory`는 적용/preview 출력에 `memory status`, `memory pull --dry-run`, `memory search`, `memory history`, `memory push --dry-run`, `memory digest` 다음 명령을 함께 표시하고, `p2a info`와 `p2a_doctor --dev`에서 memory capability 상태를 확인할 수 있게 한다. `enhance orchestration`은 `doctor --dev`, `execute start --require-monitor`, `execute start --require-monitor`, `runs show` 다음 명령을 표시하고, supervised run, provider routing, monitor gate, runtime dir 정책을 `p2a info`와 `p2a_doctor --dev`에 노출한다. `enhance proposals`도 `proposals mine --dry-run`, `proposals digest`, `proposals review --dry-run` 다음 명령을 표시하고, proposal queue, manual curation, draft-only patch, approval-required 정책을 `p2a info`와 `p2a_doctor --dev`에 노출한다.

`update`는 기존 scaffold 대상 프로젝트의 runtime script/schema/AI tool asset/generated file을 현재 toolkit 기준과 비교한다. 기본 실행과 `--dry-run`은 preview만 출력하고 파일을 쓰지 않는다. `upgrade --dry-run`도 같은 drift/migration 판정을 재사용한다. 출력은 `unchanged`, `missing`, `would_update`, `manual_review`, `conflict`, `error`로 나뉘고, `.plan2agent/manifest.json` 또는 `project.config.json`을 읽을 수 없거나 target path가 유효하지 않으면 non-zero exit를 반환한다. manifest에서 활성화된 capability의 config가 누락되면 migration preview에 `<capability>_config: would_update`로 표시한다.

`update`/`upgrade --dry-run`은 preview report를 `.plan2agent/update-reports/<command>-<timestamp>-<hash>.json`에 기록하고 하네스 파일은 변경하지 않는다. `update --apply`와 `upgrade --apply`는 같은 preview를 먼저 만든 뒤 안전한 항목만 적용한다. 자동 적용 대상은 `.plan2agent/scripts/`, `.plan2agent/schemas/`, provider P2A asset 디렉터리(`.agents/`, `.codex/`, `.claude/skills|agents|hooks/`, `.gemini/agents|commands/p2a/`)와 안전한 `project.config.json` 기본값 migration이다. `.gitignore`, `PLAN2AGENT.md`, Claude settings 같은 애매한 generated/local 파일이나 conflict/error가 있으면 적용 전에 중단하고 non-zero exit를 반환한다. apply 결과와 blocker도 `.plan2agent/update-reports/<command>-<timestamp>-<hash>.json`에 기록되며, 적용된 manifest에는 최근 update/upgrade 기록이 남는다.

P2A planning artifact, run log, proposal, 생성된 runtime helper의 장기 보존은 Plan2Agent Memory 동기화 또는 명시 export를 기준으로 한다. active와 closed 기능 반복의 안정 milestone review인 `midpoint.json`과 `pre_close.json`도 각각 원래 반복 계보를 유지하는 Memory document snapshot 대상이며, 아직 검증·승격되지 않은 `*.draft.json`과 maintenance 반복은 제외한다. 따라서 다음 반복을 연 뒤 처음 push하더라도 이전 반복의 안정 checkpoint가 해당 closed iteration 아래 함께 보존된다. git commit은 제품 소스코드와 사람이 유지할 프로젝트 설정 이력에 집중한다.

`--artifacts`는 필요 없다. `--dry-run`은 쓸 파일 목록만 출력하고, `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다. 서브커맨드 없이 실행하는 기존 flag 기반 handoff 동작은 하위호환으로 유지된다. `handoff`는 plan2agent에서 이미 기획한 승인 산출물을 별도 프로젝트로 옮길 때 쓰는 레거시/특수 흐름이다. 반복 산출물을 인계할 때 먼저 선택된 반복의 안정 milestone review를 검증한 뒤 원래 `iterations/<iteration-id>/milestone-reviews/` 상대 경로로 복사한다. 해당 review가 참조하는 원본 iteration spec/task graph/intake와 `runs/run-index.json`을 같은 artifact-root 상대 경로로 복사하고, index에 포함된 모든 run JSON도 exact copy해 대상에서 `validateRunsDir`와 milestone 검증을 다시 수행할 수 있게 한다. 대상 manifest는 `milestoneReviewFiles`와 `milestoneEvidenceFiles`를 분리해 기록하며, draft milestone review는 인계하지 않는다.

## 4. 동기화·검증

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
  --milestone-review .plan2agent/artifacts/<project_id>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.json

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

node .plan2agent/scripts/p2a_iteration.mjs context \
  --artifacts .plan2agent/artifacts/<project_id> \
  --scope maintenance \
  --code-root .

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

node .plan2agent/scripts/p2a_iteration.mjs promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."

node .plan2agent/scripts/p2a_iteration.mjs promote-milestone \
  --artifacts .plan2agent/artifacts/<project_id> \
  --draft .plan2agent/artifacts/<project_id>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<id>.draft.json

node .plan2agent/scripts/p2a_iteration.mjs compose \
  --artifacts .plan2agent/artifacts/<project_id> \
  [--allow-conflicts]

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --dry-run

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --yes
```

`--status`는 generated `status.md` view의 최소 구조만 확인한다. `--artifact-root`는 `.plan2agent/artifacts/<project_id>/` 아래 Gate A-D JSON bundle을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `spec.approval_audit`도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다.

`--run`, `--run-index`, `--runs-dir`는 `p2a_runs.mjs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--require-monitor`, `--monitor-gate`, `--skill-proposal`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`, `--proposals-dir`는 monitor gate sidecar와 Hermes식 proposal queue/review/curation/patch draft/approval artifact를 검증한다.

`p2a_iteration.mjs validate`는 반복 구조의 active iteration 포인터, active Gate B-D 산출물, task dependency, review blocker, current-spec composition을 검증한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지까지 확인한다. 개별 flat task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때는 `validate_artifacts.mjs --task-graph ... --require-approved-spec ...`를 사용한다.

`p2a_iteration.mjs close/open/draft/promote-spec/context/diff-tasks/promote-tasks/promote-milestone/compose`는 반복 planning과 task graph·milestone 초안/승격을 다룬다. `context --scope feature`는 기본값이며 active 기능 반복의 task 저작 context를 출력한다. `context --scope maintenance`는 active feature diff를 섞지 않고 `active_iteration: "maintenance"`와 maintenance task 요약을 포함한 유지보수용 context를 출력한다. `draft`는 `.plan2agent/artifacts/<project_id>/preflight-research/`의 Feature Radar 산출물을 발견하면 Gate A/B 초안의 `evidence`와 `reference_reconnaissance`에 후보 근거로 반영한다. `diff-tasks`는 `task-graph.draft.json`만 만들고, `promote-tasks`가 사람 승인 audit과 함께 정본 `task-graph.json`으로 승격한다. `promote-milestone`은 checkpoint와 evidence를 검증한 고유 draft를 기존 안정 파일을 덮어쓰지 않는 원자적 방식으로 `<checkpoint>.json`에 승격한다. `p2a_iteration.mjs maintenance add`는 Gate A/B/D 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 단일 task 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`, `--area`, `--prompt`, 반복 가능한 `--ref`, 반복 가능한 `--depends`, `--dry-run`이다. `--from-draft <file>`은 검토된 maintenance draft의 task들을 한 번에 검증해 append하며, 쓰기 전 `--dry-run`으로 preview하고 실제 append에는 `--yes`가 필요하다. 이미 같은 `eval-cluster:*`/proposal ref가 maintenance graph에 있으면 중복 task는 skip한다.

### GUI desktop app — `apps/p2a-gui`

GUI는 Electron Forge + React + TypeScript 앱이다. 선택한 프로젝트의 P2A 설치 상태, `p2a info`/`p2a_doctor` 요약, task/run/artifact, update preview/apply report, eval index/analysis/digest, memory digest/history/search report, monitor gate/scheduler 상태, PTY session, start/finish lifecycle, 한글/영문 UI를 파일 기반 CLI 계약 위에서 표시한다. proposal queue는 curation/draft/approval 연결과 승인 후 maintenance task 제목·현재 status를 함께 보여준다. GUI의 프로젝트 읽기와 실행 action은 Electron main process의 typed IPC를 거치며, renderer가 임의 파일 경로나 shell API를 직접 호출하지 않는다. operational report action은 `update --dry-run|--apply`, `eval generate/analyze/digest`, `memory digest/history`만 typed IPC로 실행하고, 생성된 JSON report를 artifact browser에서 다시 열 수 있게 한다. orchestration GUI action은 `p2a_monitor_gate.mjs mark-role`만 호출해 사람이 관찰한 role 상태를 기록하며, Codex/Claude/Gemini CLI나 browser/background loop를 대신 실행하지 않는다.

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

## 5. 감독형 단일 task 실행 — `p2a_execute.mjs`

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

Legacy handoff 대상처럼 반복 루트가 아닌 task graph를 명시해야 하는 경우에는 `--graph`를 사용할 수 있다. `--graph` 모드는 Gate B 승인, open decision, Gate D blocker 전제조건을 검사하지 않으므로 승인된 반복 실행에는 `--artifacts`를 기본으로 쓴다.

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

`start`는 run을 먼저 만들고 task를 `in_progress`로 바꾼 뒤 manual launcher prompt를 출력한다. `finish`는 verification이 실패하면 기본 failure class를 `verification_failed`로 기록하고 task를 `blocked`로 전이한다. 실패 class를 직접 지정하려면 `--status failed|blocked --failure-class <class>`를 넘긴다. failed/blocked로 닫는 경우에는 `--repro-step` 또는 `--repro-command`, `--localization` 또는 `--localized-file`, `--guard` 또는 `--guard-note`를 함께 남겨야 한다. `--no-task-transition`을 주면 run finish만 수행하고 task `done`/`blocked` 전이는 건너뛴다.

## 6. Monitor gate execution

`p2a_orchestrate.mjs` and the orchestration plan/runtime schemas were retired. New scaffolds install `p2a_monitor_gate.mjs` as a small shared helper module; existing scaffolded copies of `p2a_orchestrate.mjs` are left inert and are not actively deleted.

Use `p2a_execute.mjs start --require-monitor` when a task needs an independent monitor verdict before it can finish as done:

```bash
node .plan2agent/scripts/p2a_execute.mjs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --require-monitor
```

The start command records `runs/<runId>.monitor-gate.json`, and finish reads `runs/<runId>.monitor-verdict.json`. A concern-free `verdict: "confirm_done"` allows a finished run to close. A `verdict: "block"` or any populated concern array blocks finish and maps the first concern by priority: `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`. Raw `p2a_runs finish` enforces the same gate.

## 7. 개발 진행 — `p2a_tasks.mjs`

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
| `block <task-id>` | `todo` 또는 `in_progress` task를 `blocked`로 표시한다. `--note <text>`로 `blockNote`를 남길 수 있다. |
| `todo <task-id>` | `blocked` 또는 `in_progress` task를 `todo`로 되돌린다. `done` task는 `--reopen --note <reason>`을 명시해야 되돌릴 수 있다. |

`--maintenance`로 `list`/`ready`를 실행하면 일반 표 대신 `target`과 `source`가 보이는 maintenance 표를 출력한다. proposal approval에서 생성된 task는 `proposal-target:*`, `proposal-draft-approval:*`, `proposal-patch-draft:*` 같은 ref가 표시되어 프로젝트 local task와 upstream toolkit/companion task를 구분할 수 있다. `prompt --maintenance <task-id>`는 기존 prompt 뒤에 maintenance graph, target/source refs, `execute start/status --maintenance` next command를 붙여 사람이 바로 실행 흐름으로 넘어갈 수 있게 한다.

`done`은 모든 dependency가 여전히 `done`인지 확인한 뒤 최신 run evidence를 확인하는 shortcut guard를 거친다. 최신 run evidence가 없거나, run-index와 실제 run 파일의 주요 필드가 맞지 않거나, 최신 run이 아직 `started`/`failed`/`blocked`이면 `done` 전이가 실패한다. `finished` run이라도 verification이 없거나 `failed`/`skipped`/`not_run` verification이 남아 있으면 실패한다. run의 변경 파일에 `.plan2agent/` 또는 Gate 산출물이 포함된 경우도 사람이 먼저 산출물 변경 의도를 분리해야 하므로 차단한다. 같은 task의 현재 context에 monitor gate가 필요한 과거 run이 있으면, done 증거로 쓰는 최신 run도 monitor sidecar와 concern 없는 accepted verdict를 통과해야 한다.

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

반복 구조로 변환된 artifact는 active iteration을 자동 인식한다. `--maintenance`를 함께 쓰면 active 기능 반복 대신 `iterations/maintenance/gate-c-task-graph/task-graph.json` 단일 그래프를 대상으로 같은 명령을 실행한다. scaffold 프로젝트에서 초기 `gate-c-task-graph/task-graph.json`을 직접 `--graph`로 실행하려 하면 CLI가 `p2a_iteration init`을 요구한다. 그 외 `--graph` 직접 모드는 Gate B/D 전제조건을 검사하지 않으므로 승인된 반복 실행에는 `--artifacts`를 사용한다.

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

## 8. 실행 추적 — `p2a_runs.mjs`

`p2a_runs.mjs`는 task graph schema를 바꾸지 않고 별도 `runs/` 디렉터리에 agent 실행 결과를 기록한다. 반복 artifact root에서는 `.plan2agent/artifacts/<project_id>/runs/`를 사용한다. `--graph` 직접 모드에서는 graph가 `gate-c-task-graph/task-graph.json` 아래 있으면 그 sibling인 `.plan2agent/artifacts/<project_id>/runs/`를 사용하고, 그 외 graph 파일은 같은 디렉터리의 `runs/`를 사용한다. scaffold의 `.plan2agent/project.config.json.runTracking.runsDir`는 현재 branch/worktree naming과 함께 표시되는 참고용 기본값이며, `p2a_runs`의 실제 경로 결정은 `--artifacts`, `--graph`, `--runs` 인자를 따른다.

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

`verify`는 `.plan2agent/project.config.json`의 `testCommand`, `lintCommand`, `typecheckCommand`를 읽는다. 설정이 비어 있으면 현재 workspace의 `package.json`, lockfile, Gradle, Maven 파일을 다시 감지해 누락된 기본 명령을 채운 뒤 실행한다. 별도 명령을 쓰려면 `--test-command`, `--lint-command`, `--typecheck-command`, `--verify-command <type:cmd>`를 넘긴다. 명시 명령을 다음 실행의 기본값으로 저장하려면 `--save-config`를 함께 넘긴다. 검증 명령은 `project.config.json.verificationTimeoutMs`를 따르며 기본값은 600000ms다. `record`는 기존 run에 changed file, manual verification, note, 구조화 debug detail을 추가하고, `show`는 run JSON을 출력하며, `validate`는 run 또는 runs directory schema를 검사한다. `--isolation branch|worktree`는 격리 기준을 run log에 기록하며, `--create-isolation`을 함께 줄 때만 실제 `git switch -c` 또는 `git worktree add`를 실행한다.

`finish`는 `--status finished`로 닫으려는 run에 실행된 통과 verification evidence가 없거나 `failed`/`skipped`/`not_run` verification이 남아 있으면 non-zero로 거절한다. `--verification type:passed:text`로 기록한 manual evidence는 보조 기록일 뿐 done/finished 통과 증거로 인정하지 않는다. 아직 verification evidence가 없다면 같은 run에 `p2a_runs verify`로 `source: config|command`, `exitCode: 0` verification을 기록한 뒤 닫을 수 있지만, 이미 `failed`/`skipped`/`not_run` evidence가 남은 run은 `--status failed|blocked --failure-class <class>`로 닫고 새 run에서 성공 검증을 다시 남긴다. `failed`/`blocked` run은 후속 분석 품질을 위해 `reproduction`, `localization`, `guard` 구조 필드가 필수이며, 빠지면 run 파일을 쓰지 않고 non-zero로 거절한다.

handoff 대상 프로젝트에서는 다음처럼 쓴다. `p2a_runs --graph`는 실행 전제조건을 검사하지 않는 직접 graph 모드이므로 Gate B/D 검증은 별도 승인 흐름에서 끝나 있어야 한다.

```bash
node .plan2agent/scripts/p2a_runs.mjs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex

node .plan2agent/scripts/p2a_runs.mjs verify --run-id run-...
node .plan2agent/scripts/p2a_runs.mjs finish --run-id run-... --collect-git
```

## 9. 개선 proposal 큐 — `p2a_proposals.mjs`

`p2a_proposals.mjs`는 Hermes식 자가 개선 루프의 파일 기반 MVP다. run log, orchestration sidecar, monitor verdict, structured debug detail을 읽어 skill/agent/CLI 개선 후보를 `p2a.skill_proposal.v1` JSON으로 만들고, 사람이 검토할 review/curation artifact, non-applying patch draft, approval artifact를 생성한다. failed/blocked run은 schema와 finish 단계에서 `reproduction`, `localization`, `guard`를 필수로 요구하므로, proposal mine은 유효한 실패 run의 failure class와 verification gap을 중심으로 후보를 만든다. proposal 적용은 자동으로 하지 않고 승인된 maintenance task를 별도 실행한다.

기본 저장 위치:

- 반복 artifact root: `.plan2agent/artifacts/<project_id>/proposals/`
- handoff/scaffold 대상 프로젝트: `.plan2agent/proposals/`
- `--graph <path>`를 쓰면 graph에서 추론한 `runs/`의 sibling `proposals/`

대표 흐름:

```bash
node .plan2agent/scripts/p2a_proposals.mjs mine \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

node .plan2agent/scripts/p2a_proposals.mjs mine \
  --runs .plan2agent/runs \
  --proposals .plan2agent/proposals \
  --target p2a_toolkit \
  --target-area p2a-harness \
  --upstream-reason "이 실패 패턴은 개별 프로젝트가 아니라 P2A 하네스에서 고쳐야 함"

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

`--target`은 proposal의 적용 대상을 기록한다. 기본값은 `project`라서 기존 프로젝트 로컬 개선 큐와 같은 의미로 동작한다. `p2a_toolkit`은 이 proposal이 Plan2Agent 본체 하네스/CLI/스킬 개선 후보라는 뜻이며, `targetRepo`는 고정값 `https://github.com/silbaram/plan2agent`를 쓴다. 다른 repository로 보낼 개선 후보는 `companion_project`와 `--target-repo`를 사용한다. `companion_project`는 Memory, Feature Radar 같은 연동 서브프로젝트 개선 후보에 쓴다. `p2a_toolkit` 또는 `companion_project`는 `--upstream-reason`이 필요하고, `companion_project`는 `--target-repo`도 필요하다. `project` target에는 `--target-repo`, `--target-area`, `--upstream-reason`을 함께 쓸 수 없다. non-project target으로 mine한 proposal은 project-local proposal과 같은 run/failure에서 나오더라도 target-qualified proposalId를 사용하므로 같은 큐 안에서 서로 덮거나 skip하지 않는다. `review`, `curate`, `draft-patch`, `approve-draft`는 target metadata를 보존하므로 사람이 프로젝트 개선과 upstream 개선을 섞지 않고 판단할 수 있다. `approve-draft`는 upstream target을 기본적으로 현재 프로젝트 maintenance task로 전환하지 않는다. 의도적으로 현재 프로젝트 maintenance graph에 추적 task를 남길 때만 `--allow-local-upstream-task`를 함께 사용하며, 이 경우 task에는 `proposal-target:*` source ref와 `upstream:<area>` targetArea가 남는다.

`mine`은 회고 분석용 best-effort 명령이다. run file 한 건이 legacy/손상 상태라 schema 검증에 실패하면 warning으로 건너뛰고 나머지 run을 계속 처리한다. 반대로 `validate`와 `validate_artifacts --runs-dir/--proposals-dir`는 감사용 명령이므로 계속 엄격하게 실패한다.

큐 파일은 `<proposalId>.json` 이름으로 저장되며 validator가 파일명과 `proposalId` 일치를 확인한다. 같은 proposal이 이미 있으면 기본은 skip이고, 다시 쓰려면 `--overwrite`를 명시한다. 실제 skill/agent 수정은 `p2a-skill-curator` 검토와 사람 승인 이후 별도 변경으로 처리한다.

`review`는 proposal을 classification, targetFiles, recommendedChange 기준으로 그룹화하고 risk/frequency로 recommended disposition을 붙인다. 기본 출력은 `proposals/reviews/<reviewId>.json`이며, 같은 입력이면 같은 content hash 기반 `reviewId`가 나온다. `--output`을 직접 지정하더라도 proposal root 최상위에는 쓰지 않고 `reviews/` 하위나 외부 경로를 쓴다. `approve`는 자동 적용이 아니라 "별도 patch 검토 대상"이라는 추천이다. `verification_gap`은 skipped-verification rationale 표준화 전까지 기본적으로 `needs_more_evidence`로 분류한다.

`curate`는 review group을 approval-ready candidate로 바꾼다. 기본 출력은 `proposals/curations/<curationId>.json`이며, candidate에는 readiness(`patch_candidate`, `needs_evidence`, `watch`, `no_action`), priority, evidenceStrength, separatePatchRequired가 들어간다. 이 단계도 자동 적용은 하지 않으며, `patch_candidate`는 사람 승인 후 별도 patch로 다룰 항목이라는 뜻이다.

`draft-patch`는 curation candidate 1건을 `proposals/patch-drafts/<draftId>.json`으로 바꾼다. patch draft에는 targetFiles, intendedChanges, verificationPlan, risks가 들어가지만 실제 파일 diff를 만들거나 적용하지 않는다. `approvalRequired: true`, `autoApplyAllowed: false`가 validator에서 강제된다.

`approve-draft`는 사람이 승인한 patch draft를 `proposals/approvals/<approvalId>.json`으로 기록하고, `iterations/maintenance/gate-c-task-graph/task-graph.json`에 maintenance task를 append한다. 이 명령도 대상 파일을 수정하지 않으며, approval artifact에는 `autoApplyPerformed: false`가 강제된다. 같은 draft를 다시 승인하면 기존 maintenance task를 재사용해 task 중복을 피한다. 사람용 출력에는 생성된 task의 `tasks show`, `tasks prompt --maintenance`, `execute start --approval <approval.json>` next command가 함께 표시된다.

승인된 항목 실행은 `p2a_execute --approval <approval.json>`로 이어간다. 이 옵션은 approval artifact의 `maintenanceTask.taskId`와 task graph의 `sourceSpecRefs`를 대조한 뒤 해당 maintenance task를 plan/start/status/finish 대상으로 선택하고, start run note에 proposal approval/draft/candidate id를 기록한다.

MVP 제약:

- `finished` run에 verification 기록이 없으면 docs/config-only task처럼 의도적으로 검증을 생략한 경우도 verification-gap proposal이 생길 수 있다. 후속에서는 run schema 또는 표준 marker로 skipped-verification rationale을 기록해 이 노이즈를 줄인다.
- `digest`는 빠른 현황 요약이고, 승인 판단은 `review`, `curate`, `draft-patch`, `approve-draft` artifact를 기준으로 한다. 실제 코드 수정은 승인된 maintenance task를 별도 실행해서 진행한다.

## 10. 평가 루프 — `p2a_eval.mjs`

`p2a_eval.mjs`는 run 결과와 iteration 상태를 deterministic하게 평가하는 파일 기반 MVP다. AI 판정이나 서버 호출 없이, run log, task graph, proposal queue를 읽어 acceptance evidence, regression signal, failure cluster를 구조화한다.

```bash
node .plan2agent/scripts/p2a_eval.mjs grade \
  --artifacts .plan2agent/artifacts/<project_id> \
  --run-id run-<id>

node .plan2agent/scripts/p2a_eval.mjs compare \
  --baseline .plan2agent/artifacts/<project_id>/iterations/<old>/runs \
  --candidate .plan2agent/artifacts/<project_id>/runs

node .plan2agent/scripts/p2a_eval.mjs analyze \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_eval.mjs generate \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_eval.mjs digest \
  --eval .plan2agent/artifacts/<project_id>/eval \
  --recent-runs 30 \
  --output .plan2agent/artifacts/<project_id>/eval/eval-digest.json
```

`p2a_eval`은 agents-cli eval 제품군과 1:1 parity를 목표로 하지 않는다. P2A에서는 LLM response dataset, optimize, cloud submit/results 대신 로컬 spec/task/run/proposal artifact를 대상으로 하는 보수적인 품질 루프만 제공한다.

`grade`는 한 run을 해당 task의 acceptance criteria와 verification evidence에 대조한다. run이 failed/blocked거나 verification 실패가 있으면 `fail`, verification이 없거나 run이 finished가 아니면 `needs_evidence`, 일부 acceptance evidence만 보이면 `partial`, finished run + verification + acceptance evidence가 모두 맞으면 `pass`를 출력한다. `reproduction`, `localization`, `fixSummary`, `guard`는 acceptance evidence 텍스트와 grade JSON의 `run.structuredEvidence`에 포함된다. 신규 run validation 기준에서는 failed/blocked run의 reproduction/localization/guard에 실제 값이 있어야 grade/analyze 입력으로 유효하다. 이 평가는 보수적인 로컬 증거 점검이므로 최종 승인 판단은 사람이 run evidence와 task acceptance를 함께 확인한다.

`compare`는 두 artifact root 또는 runs directory의 run status, verification failure/gap, skipped run, task done count를 비교해 `pass|warn|fail` regression verdict를 낸다. candidate에 failed/blocked run이나 verification failure가 늘면 `fail`, verification gap이나 skipped run이 늘면 `warn`이다. 신규 run schema 기준에서는 failed/blocked run의 `reproduction`, `localization`, `guard`가 필수이므로, 이 값이 빠진 run은 비교 대상 이전의 artifact validation 단계에서 걸러진다.

`analyze`는 failed/blocked run, failed verification, verification gap을 failure cluster로 묶고 proposal coverage를 계산한다. artifact root를 입력하면 각 cluster에 maintenance 후보 명령과 scope/dependency 계열 Gate A/B delta draft 명령을 함께 제안한다. 기본 실행은 파일을 자동 수정하지 않으며, `--maintenance-draft <path>`를 주면 maintenance task draft JSON을 저장한다. 권장 승격 흐름은 저장된 draft를 검토한 뒤 `p2a_iteration maintenance add --from-draft <path> --dry-run`으로 preview하고 `--yes`로 append하는 것이다. `--apply-maintenance --yes`는 analyze 명령 안에서 바로 적용하고 `eval/maintenance-apply-report.json`을 남기는 shortcut이며, 먼저 확인하려면 `--apply-maintenance --dry-run`을 사용한다.

`generate`는 현재 run index를 기준으로 grade files, `analysis.json`, `eval-index.json`을 eval 디렉터리에 생성한다. 같은 출력 디렉터리에 재실행하면 이전 generated grade/index/analysis/compare 파일을 정리하고 새 결과로 대체한다. `digest`는 생성된 eval artifact를 요약하며, GUI에서 digest 문서로 확인하려면 `--output <eval-dir>/eval-digest.json`처럼 파일로 저장한다. self-improvement section은 기본적으로 최신 30개 run을 기준으로 실패 근거, 반복 실패, proposal 전환, post-maintenance verification을 계산하며, `--recent-runs <n>`으로 분석 범위를 바꿀 수 있다. proposal/approval/maintenance 집계는 분석 window 안의 run과 proposal JSON `sourceRunId` 또는 curation candidate `sourceRunIds`로 연결되는 proposal을 기준으로 제한된다. approved proposal 집계는 proposal JSON의 `status`뿐 아니라 `approve-draft`가 남긴 approval artifact와 curation/draft 연결도 effective approval signal로 반영한다. approval artifact가 없는 기존 approved proposal은 maintenance task의 `proposal:<proposalId>` 또는 `skill-proposal:<proposalId>` source ref로 conversion을 연결할 수 있다.

## 11. Memory 동기화 — `p2a_memory.mjs`

`p2a_memory.mjs`는 로컬 `.plan2agent` 산출물을 source of truth로 유지하면서 Plan2Agent Memory 서버를 장기 artifact store, hash 비교, 검색/회고 backend로 쓰는 runtime CLI다. 서버가 agent 실행이나 하네스 판단을 대신하지 않으며, 실제 push는 명시 승인 없이 수행하지 않는다.

```bash
node .plan2agent/scripts/p2a_memory.mjs status \
  --artifacts .plan2agent/artifacts/<project_id>

node .plan2agent/scripts/p2a_memory.mjs push \
  --artifacts .plan2agent/artifacts/<project_id> \
  --dry-run

P2A_MEMORY_URL=http://localhost:8080 \
node .plan2agent/scripts/p2a_memory.mjs pull \
  --artifacts .plan2agent/artifacts/<project_id> \
  --dry-run \
  --output .plan2agent/artifacts/<project_id>/memory-pull-report.json

P2A_MEMORY_URL=http://localhost:8080 \
node .plan2agent/scripts/p2a_memory.mjs push \
  --artifacts .plan2agent/artifacts/<project_id> \
  --yes

P2A_MEMORY_URL=http://localhost:8080 \
node .plan2agent/scripts/p2a_memory.mjs search \
  --artifacts .plan2agent/artifacts/<project_id> \
  --query "verification gap" \
  --type proposal

node .plan2agent/scripts/p2a_memory.mjs history \
  --artifacts .plan2agent/artifacts/<project_id> \
  --output .plan2agent/artifacts/<project_id>/memory-history.json

node .plan2agent/scripts/p2a_memory.mjs digest \
  --artifacts .plan2agent/artifacts/<project_id> \
  --output .plan2agent/artifacts/<project_id>/memory-digest.json

node .plan2agent/scripts/p2a_memory.mjs trace \
  --artifacts .plan2agent/artifacts/<project_id> \
  --node decision:ND-1 \
  --direction upstream \
  --depth 4

node .plan2agent/scripts/p2a_memory.mjs impact \
  --artifacts .plan2agent/artifacts/<project_id> \
  --node spec_section:product.scope \
  --depth 5

node .plan2agent/scripts/p2a_memory.mjs precedent \
  --project <project_id> \
  --query "cache invalidation" \
  --limit 5
```

`status`는 project, 참조된 모든 iteration, document snapshot, proposal snapshot, task graph, task, run, document chunk의 로컬 계획을 만들고 Memory `/api/artifacts` 조회 결과와 source id/hash 기준으로 비교한다. active와 closed 반복의 안정 milestone review인 `milestone-reviews/midpoint.json`과 `pre_close.json`은 원래 반복의 canonical iteration id와 `documentRole: milestone_review`를 가진 document snapshot으로 포함하며 draft 파일은 제외한다. 실제 push는 참조된 iteration을 먼저 모두 등록한 뒤 반복별 document, task graph, task, run, chunk, graph snapshot을 저장한다. 서버 URL은 `--server`, `P2A_MEMORY_URL`, 또는 `project.config.json.memory.serverUrlEnv` 순서로 찾는다. 서버가 설정되지 않으면 로컬 계획과 `not_configured` 상태를 출력하며 파일이나 서버를 변경하지 않는다.

`p2a info --json`은 `enhancements.memory`에 mode, server env, server/token 설정 여부, push policy, manifest/config sync 상태를 노출한다. `p2a_doctor --dev`는 Memory capability가 활성화된 프로젝트에서 memory manifest/config drift, runtime script, server env config, explicit approval push policy, sync tier 기본값을 검사한다. 이 검사는 서버 프로세스가 떠 있어야 통과하는 live probe가 아니라 로컬 설정/안전 정책 점검이다.

`pull --dry-run`은 Memory `/api/artifacts`의 metadata/hash 조회 결과를 로컬 계획과 비교해 `alreadyLocal`, `localOnly`, `remoteDiffers`, `remoteOnly` preview와 `restorePlan`을 출력한다. `--output <path>`를 주면 같은 payload를 JSON report로 저장해 remote-only/different 항목, 충돌 여부, 수동 복구 필요 사유를 검토할 수 있다. 이 명령은 preview-only이며 로컬 artifact 파일을 쓰지 않는다. 현재 Memory lookup API는 artifact 본문 적용용 content endpoint가 아니라 metadata/hash 조회 표면이므로, `pull --apply`는 명시적으로 거절되고 remote-only/different 항목은 사람이 검색/조회 결과를 확인한 뒤 수동 복구 대상으로 판단한다.

`search`는 Memory `/api/search/keyword`를 호출해 동기화된 document chunk와 snapshot 본문을 keyword로 조회한다. `--artifacts`, `--graph`, `--runs` 중 하나를 주면 CLI가 로컬 context를 읽고 서버 canonical project/iteration id로 scope를 좁힌다. `--global`을 주면 project/iteration filter 없이 검색한다. `--type document|chunk|task|run|graph|project|iteration|proposal`, `--source-path`, `--limit`으로 결과를 더 좁힐 수 있다. 현재 서버 keyword index의 주 검색 대상은 document/chunk/proposal content이므로 task/run type filter는 해당 artifact가 searchable content로 인덱싱된 경우에만 결과가 나온다. `--type proposal` 결과는 proposal/document 단위로 dedupe되며, 서버 raw match 수는 `summary.rawTotal`에 남는다. 서버가 설정되지 않았거나 연결할 수 없으면 non-zero exit와 복구 next action을 출력한다.

`history`는 로컬 plan에서 project, iteration, document snapshot, task graph, task, run record timeline을 만들고, Memory 서버가 설정되어 있으면 `/api/artifacts`의 created/updated/snapshot metadata를 병합한다. `--artifacts`, `--graph`, `--runs`로 현재 context를 지정하거나, 원격 조회만 필요하면 `--global --project <sourceProjectId> [--iteration <sourceIterationId>]`를 사용할 수 있다. `search`, `history`, `digest`, `trace`, `impact`, `precedent`는 `--output <path>`로 JSON report를 저장할 수 있으며, GUI는 artifact root의 `memory-search.json`, `memory-history.json`, `memory-digest.json`을 운영 리포트와 문서 브라우저에 표시한다.

`trace --node <naturalKey>`는 Memory `/api/graph/trace`를 호출해 decision/assumption/evidence/spec_section/task/run/proposal/document 계보를 조회한다. `--direction upstream|downstream|both`와 `--depth <n>`을 지원하며 텍스트 출력은 depth 기반 들여쓰기와 도달 edge type을 보여준다. `impact --node <naturalKey>`는 downstream trace의 sugar command로, "이 노드가 바뀌면 영향받는 하위 산출물" 요약과 kind별 개수를 먼저 출력한다. `precedent --query <text>`는 `/api/graph/nodes?nodeKind=decision` 키워드 검색으로 과거 decision 후보를 찾고 각 decision의 downstream trace에서 run status를 모아 "결정 → 실제 결과" 요약을 출력한다. v1은 임베딩 주입이 없는 기본 환경을 고려해 keyword 기반 graph node 검색을 주 경로로 사용한다.

`push`는 같은 계획을 Memory write DTO로 변환한다. `--dry-run`은 서버에 접속하지 않고 write 순서와 수량만 보여주며 그래프 인덱스 node/edge 개수도 포함한다. 실제 서버 write는 `--yes`가 있어야 하며, project → iteration → document/proposal snapshots/chunks → task graph → tasks → runs → graph snapshot 순서로 upsert한다. graph snapshot은 로컬 artifact에서 파생되는 인덱스이므로 push 때마다 선택 scope 전체를 재계산해 `/api/graph/snapshots`로 원자 교체한다. 구버전 Memory 서버가 graph endpoint를 404로 응답하면 graph push만 경고 후 건너뛰고 기존 artifact push는 성공시킨다. proposal snapshot은 `PROPOSAL` artifact type과 `proposalTarget`, `targetRepo`, `targetArea`, `upstreamReason` metadata를 보존한다. 인증이 필요한 Memory 서버는 `--token` 또는 `P2A_MEMORY_TOKEN` 값을 `X-P2A-Local-Token` 헤더로 받는다.

`digest`는 로컬 run index와 proposal queue를 읽어 failed/blocked run, failure class, verification failure/gap, proposal coverage, structured debug detail coverage를 요약한다. proposal 후보가 빠진 run이 있으면 `p2a_proposals.mjs mine` 명령을 next action으로 제안한다. failed/blocked run의 reproduction/localization/guard 누락은 신규 schema에서 유효하지 않은 artifact로 취급되며, 이미 proposed 상태인 항목은 review/curate 흐름으로 연결한다.

## 12. 인계 — `p2a_handoff.mjs`

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

인계 전제는 Gate B~D가 통과된 상태다. 특히 `spec.approval`은 `approved`여야 하고, `spec.approval_audit`가 있어야 하며, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하고, `spec.open_decisions`와 `review.json.blocking_issues`는 비어 있어야 한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. Markdown view 파일은 존재할 때만 함께 복사된다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 기본 실행 도구로 `p2a_tasks.mjs`, `p2a_runs.mjs`, `p2a_execute.mjs`, `p2a_monitor_gate.mjs`, `p2a_proposals.mjs`, `p2a_eval.mjs`, `p2a_memory.mjs`, `validate_artifacts.mjs`, run/monitor gate/monitor gate/proposal/review/curation/patch-draft schema가 함께 설치되며, `.plan2agent/project.config.json.runTracking`에 참고용 기본 runs directory와 branch/worktree naming hint가 기록된다. 현재 실행 경로는 이 설정을 자동 소비하지 않고 CLI 인자에서 계산한다.

`--tools`를 지정하면 공통 P2A 원본인 `.agents/skills`, `.agents/agents`와 선택한 CLI별 mirror를 함께 복사한다. `codex`는 `.codex/agents`, `claude`는 `.claude/skills`와 `.claude/agents`, `gemini`는 `.gemini/agents`와 `.gemini/commands/p2a`를 추가한다. 단, `p2a-design-system` skill과 Gemini `design-system.toml` command는 Plan2Agent 본체 UI 개발용 자산이라 대상 프로젝트로 넘기지 않는다. 복사된 파일과 선택한 CLI 범위는 `.plan2agent/manifest.json`의 `aiToolTargets`, `aiToolFiles`, `toolFiles`에 기록된다.

`--include-team-bigfive`를 지정하면 `.plan2agent/team-harnesses/team-bigfive/source-manifest.json`과 `adaptation-notes.md`를 생성하고, 선택한 CLI별 adapter entrypoint를 설치한다. Codex는 `.agents/skills/team-bigfive-kickoff/`와 `.codex/agents/team-bigfive-coordinator.toml`, Claude는 `.claude/skills/team-bigfive-kickoff/`와 `.claude/agents/team-bigfive-coordinator.md`, Gemini는 `.agents/skills/team-bigfive-kickoff/`, `.gemini/agents/team-bigfive-coordinator.md`, `.gemini/commands/p2a/team-bigfive.toml`을 사용한다. local source이고 Claude target이 포함되면 안전 필터를 통과한 원본 파일도 `.claude-plugin/team-bigfive/source/`에 복사한다. 설치 내역은 `manifest.json.externalHarnesses`, `externalHarnessFiles`, `project.config.json.teamBigFive`에 기록된다.

반복 구조 root를 인계할 때 maintenance task graph가 있으면 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다. active feature graph와 병합하지 않으며, `manifest.json.maintenanceFiles`와 `current-spec.json.handoff_records`에 handoff 기준점이 남는다. `preflight-research/`가 있으면 알려진 Feature Radar 파일도 대상 `.plan2agent/artifacts/<project_id>/preflight-research/`로 복사하고 `manifest.json.preflightResearchFiles`에 기록한다.

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

## 13. 대표 워크플로우

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

`p2a enhance proposals`를 적용한 프로젝트는 `.plan2agent/project.config.json.proposals`와 `manifest.json.enhancements.proposals`에 proposal queue capability가 기록된다. `p2a info`는 큐 위치, 큐 JSON 수, manifest/config sync 상태, review/patch/approval 정책을 보여주고, `p2a_doctor --dev`는 proposal manifest/config drift, proposal runtime script, proposal schema, mining signal, manual curation, draft-only patch, approval gate를 로컬 설정 기준으로 검사한다.

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

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --dry-run

node .plan2agent/scripts/p2a_iteration.mjs maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --yes

node .plan2agent/scripts/p2a_iteration.mjs validate \
  --artifacts .plan2agent/artifacts/<project_id>
```

`maintenance add`는 active 기능 반복이 close-ready가 아니어도 실행할 수 있지만, `compose`, active iteration 회전, close 대상에는 maintenance를 포함하지 않는다. `--from-draft`는 `p2a_eval analyze --maintenance-draft <file>`가 만든 draft를 읽어 task id를 새로 배정하고, draft-local dependency가 있으면 append된 task id로 매핑한다. 실제 쓰기는 `--yes`를 요구한다.

---

정확한 전체 옵션은 각 도구의 `--help`가 정본이다. `p2a_tasks.mjs`와 `p2a_handoff.mjs`는 터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 대화형 메뉴가 뜬다. 이 문서는 개요·흐름·예시용이며, 옵션 세부는 `--help`를 따른다.
