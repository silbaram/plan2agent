# Plan2Agent CLI 사용자 가이드

이 문서는 Plan2Agent에서 자주 쓰는 CLI 흐름과 대표 명령을 한곳에 모은 사용자 가이드다. 옵션 전체를 복제하지 않고, 실제 사용 흐름에 필요한 주요 명령과 예시만 다룬다. 세부 옵션은 각 도구의 `--help` 또는 스크립트 usage가 정본이다.

문서 홈: [Plan2Agent Docs](README.md) · 먼저 보기: [Quickstart](quickstart.md)

## 1. 개요

Plan2Agent CLI는 기획 산출물 검증, 승인된 task graph 실행, agent run 기록, 반복 개발 상태 관리를 제공한다. npm 패키지는 runtime scripts와 schemas를 제공하고, 각 프로젝트는 `.plan2agent/`에 상태·설정·선택한 provider asset만 보관한다.

| 명령 | 역할 |
| --- | --- |
| `p2a init` | 새 프로젝트의 상태와 provider asset을 초기화한다. |
| `p2a next` | 현재 상태에 맞는 한 가지 다음 행동을 반환한다. |
| `p2a iteration`, `p2a tasks`, `p2a runs`, `p2a execute` | 반복·task·run 실행 흐름을 관리한다. |
| `p2a validate`, `p2a eval`, `p2a memory`, `p2a proposals` | 산출물 검증, 평가, Memory, 개선 제안을 관리한다. |
| `p2a doctor`, `p2a enhance`, `p2a update` | 프로젝트 상태를 진단하고 provider/config 자산을 관리한다. |
| `p2a handoff` | 승인된 산출물을 별도 대상 프로젝트로 인계한다. |

Plan2Agent 본체 개발에서만 `scripts/sync_cli_assets.mjs`, `scripts/check_cli_parity.mjs`, `scripts/run_fixtures.mjs`를 직접 실행한다.

전체 흐름은 다음과 같다.

1. 하네스가 한 문장 아이디어에서 **Gate A intake → Gate B spec → Gate C task graph → Gate D review** 산출물을 만든다.
2. Plan2Agent 본체 저장소에서는 `scripts/validate_artifacts.mjs`, `scripts/run_fixtures.mjs`, `scripts/check_cli_parity.mjs`로 fixture와 CLI 구성을 검증한다. `init` 대상 프로젝트에서는 `p2a validate`와 `p2a iteration`로 산출물을 검증한다.
3. 새 프로젝트는 먼저 `p2a init --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서는 `p2a info`로 현재 상태를 확인하고, `p2a execute plan/start`로 ready task 1건의 run을 열어 감독형 agent prompt를 출력한다. 여러 독립 ready task를 실행할 때도 batch CLI를 만들지 않고 `p2a-dev-execution` owner가 같은 ready snapshot에서 task별 `execute start`를 직렬 호출한다. 세션이 끊기면 `p2a execute resume`으로 같은 run prompt를 다시 출력한다. 복수 agent 역할이나 monitor gate가 필요한 task는 `p2a execute start --require-monitor`로 task별 실행 계획을 만든다.
5. `p2a execute status/finish`로 run 상태 확인, verification, run finish, task done/block 전이를 묶어 기록한다. 세부 제어가 필요하면 `p2a tasks`와 `p2a runs`를 직접 사용한다.
6. 실패, blocked monitor verdict, verification gap이 쌓이면 `p2a proposals mine/review/curate/draft-patch/approve-draft/digest`로 개선 proposal queue, curator review artifact, approval-ready curation artifact, non-applying patch draft, 승인 artifact를 만든다. proposal 적용은 승인된 maintenance task를 별도 실행해서 진행한다.
7. `p2a eval grade/compare/analyze/generate/digest`로 run acceptance 증거, iteration regression, 실패 클러스터를 평가하고 proposal/maintenance/delta draft 경로로 연결한다.
8. 장기 보존이나 회고 검색이 필요하면 `p2a memory status/push/pull/search/history/trace/impact/precedent/digest`로 로컬 산출물과 Memory 서버 snapshot의 차이, 검색 결과, 계보, timeline, 유지보수 후보를 확인하고, 명시 승인 후 push한다. `memory search`는 하위호환 기본값인 `keyword`와 명시적 `semantic`/`hybrid` 모드를 지원한다. `--project <sourceProjectId>`는 해당 프로젝트의 모든 반복을 검색하고, 조건부 cross-project recall은 `--global --exclude-project <sourceProjectId>`로 현재 프로젝트를 제외한다.

## 2. 전역 공통 진입점 — `p2a`

Plan2Agent는 npm 전역 패키지의 `p2a` 명령으로 실행한다. 프로젝트에는 `.plan2agent/` 상태, 설정, 선택한 provider asset만 저장하며 runtime script와 schema는 패키지에 남는다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
p2a info
p2a next
```

`p2a`의 하위 명령은 `eval`, `memory`, `execute`, `tasks`, `runs`, `iteration`, `proposals`, `validate`, `doctor`, `enhance`, `update`, `upgrade`, `handoff`다. `--target`을 생략하면 현재 작업 디렉터리를 대상으로 삼는다.

## 3. 프로젝트 초기화 — `p2a init`

```bash
p2a init [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
p2a enhance <capability> [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
p2a update [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--dry-run|--apply] [--prune]
```

`init`은 fresh 프로젝트에 manifest, project config, style contract, `PLAN2AGENT.md`, `.gitignore`, 선택한 AI tool asset을 만든다. npm으로 설치된 package runtime에서 실행하면 `.plan2agent/scripts/`와 `.plan2agent/schemas/`를 만들지 않는다. Plan2Agent clone checkout에서 실행하면 기존 사용자를 위해 두 디렉터리와 `toolkitRoot`를 포함한 co-located runtime을 계속 설치한다. 터미널과 agent skill은 항상 `p2a …`를 실행한다. 기존 `scaffold`는 호환 별칭이지만 새 프로젝트 문서와 자동 안내에서는 사용하지 않는다.

`update`는 현재 패키지 버전의 provider asset과 안전한 config 기본값을 비교한다. 이번 전환에서는 기존 co-located runtime 프로젝트를 자동 마이그레이션하거나 로컬 runtime 파일을 삭제하지 않는다. 새 설치는 `p2a init`으로 시작한다.

## 4. 동기화·검증

### `p2a doctor`

프로젝트 진단 명령이다. 패키지가 제공하는 runtime script/schema 목록, `manifest.json`, `project.config.json`, 선택한 provider asset의 상태를 확인한다. package runtime으로 만든 새 `init` 프로젝트에는 로컬 `.plan2agent/scripts/`·`.plan2agent/schemas/`가 없어도 정상이며, 그 경로에 남아 있는 repo-only script는 경고한다. Clone checkout에서 만든 co-located runtime은 manifest에 기록된 script/schema 목록을 기준으로 진단한다.

```bash
p2a doctor --target <project-dir>
p2a doctor --target <project-dir> --json
p2a doctor --target <project-dir> --dev --json
p2a doctor --target <project-dir> --strict
```

출력에는 설치 파일 체크와 별개로 `projectState`가 포함된다. `projectState.state`는 `installed_empty`, `planning_in_progress`, `iteration_init_required`, `execution_ready`, `cycle_close_ready`, `broken_install`, `no_p2a` 중 하나이며, artifact root별 Gate A-D 존재 여부, Gate B approval/open decision 수, Gate C task count/ready 수, Gate D blocker 수, run-index 요약을 함께 보여준다. `init` 프로젝트에 greenfield Gate A-D bundle이 있으면 `project_state` 체크가 warning으로 표시되고 `p2a iteration init` 명령을 next action으로 출력한다.

`--dev`는 development skill/config 진단을 추가한다. `manifest.aiToolTargets` 기준으로 Codex/Claude/Gemini provider asset, role profile, `manifest.aiToolFiles`, `project.config.json.providerNativeCapabilities`, `runTracking`, `devExecution`, `roleProfiles`, `promptTemplates`, Claude PreToolUse confinement hook 상태를 확인한다. `--strict`는 warning만 있어도 non-zero exit를 반환한다. 일반 실행은 failure가 있을 때만 non-zero exit를 반환한다.

### `sync_cli_assets.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `.agents/skills/`와 `.agents/agents/`를 기준으로 Claude, Codex, Gemini용 mirror 파일을 생성한다. 일반 실행은 파일을 갱신하고, `--check`는 쓰기 없이 drift만 검사한다. `init` 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/sync_cli_assets.mjs
node scripts/sync_cli_assets.mjs --check
```

### `check_cli_parity.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `sync_cli_assets.mjs --check`를 포함해 skill mirror byte 비교, agent mirror 존재 여부, Gemini command shim 필수 내용 등을 검사한다. `init` 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/check_cli_parity.mjs
```

### `run_fixtures.mjs`

Plan2Agent 본체 개발자용 스크립트다. Plan2Agent 저장소 루트에서 `fixtures/` 아래 각 일반 fixture 디렉터리를 `validate_artifacts.mjs --fixture-dir` 조합으로 검증한다. `fixtures/_e2e/manifest.json`이 있으면 artifact-root fixture를 `--require-handoff-ready`로 검증하고, `fixtures/_negative/manifest.json`이 있으면 중단/실패 fixture도 실행해서 기대한 실패 메시지가 나오는지 확인한다. fixture/golden 변경 후 전체 회귀 확인용으로 쓴다. `init` 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/run_fixtures.mjs
```

### `validate_artifacts.mjs`

개별 산출물 또는 fixture 디렉터리를 검증한다. 자주 쓰는 조합은 다음과 같다.

```bash
p2a validate \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json

p2a validate \
  --status .plan2agent/artifacts/<project_id>/status.md

p2a validate \
  --artifact-root .plan2agent/artifacts/<project_id>

p2a validate \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json

p2a validate \
  --task-graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json

p2a validate \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json

p2a validate \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass

p2a validate \
  --runs-dir .plan2agent/artifacts/<project_id>/runs

p2a validate \
  --milestone-review .plan2agent/artifacts/<project_id>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.json

p2a validate \
  --proposals-dir .plan2agent/artifacts/<project_id>/proposals

p2a validate \
  --proposal-review .plan2agent/artifacts/<project_id>/proposals/reviews/proposal-review-<hash>.json

p2a validate \
  --proposal-curation .plan2agent/artifacts/<project_id>/proposals/curations/proposal-curation-<hash>.json

p2a validate \
  --proposal-patch-draft .plan2agent/artifacts/<project_id>/proposals/patch-drafts/proposal-patch-draft-<hash>.json

p2a validate \
  --proposal-draft-approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

p2a validate \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

p2a validate \
  --fixture-dir fixtures/cache-library

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

p2a iteration close \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

p2a iteration draft \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration context \
  --artifacts .plan2agent/artifacts/<project_id> \
  --code-root .

p2a iteration context \
  --artifacts .plan2agent/artifacts/<project_id> \
  --scope maintenance \
  --code-root .

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

p2a iteration promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."

p2a iteration promote-milestone \
  --artifacts .plan2agent/artifacts/<project_id> \
  --draft .plan2agent/artifacts/<project_id>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<id>.draft.json

p2a iteration compose \
  --artifacts .plan2agent/artifacts/<project_id> \
  [--allow-conflicts]

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --dry-run

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --yes
```

`--status`는 generated `status.md` view의 최소 구조만 확인한다. `--artifact-root`는 `.plan2agent/artifacts/<project_id>/` 아래 Gate A-D JSON bundle을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `spec.approval_audit`도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다.

`--run`, `--run-index`, `--runs-dir`는 `p2a runs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--require-monitor`, `--monitor-gate`, `--skill-proposal`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`, `--proposals-dir`는 monitor gate sidecar와 Hermes식 proposal queue/review/curation/patch draft/approval artifact를 검증한다.

`p2a iteration validate`는 반복 구조의 active iteration 포인터, active Gate B-D 산출물, task dependency, review blocker, current-spec composition과 planning Memory 상태/보고서/`LOCAL-n` 인용 정합성을 검증한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지까지 확인한다. 개별 flat task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때는 `validate_artifacts.mjs --task-graph ... --require-approved-spec ...`를 사용한다.

`p2a iteration close/open/draft/promote-spec/context/diff-tasks/promote-tasks/promote-milestone/compose`는 반복 planning과 task graph·milestone 초안/승격을 다룬다. `context --scope feature`는 기본값이며 active 기능 반복의 task 저작 context를 출력한다. `context --scope maintenance`는 active feature diff를 섞지 않고 `active_iteration: "maintenance"`와 maintenance task 요약을 포함한 유지보수용 context를 출력한다. `draft`는 `.plan2agent/artifacts/<project_id>/preflight-research/`의 Feature Radar 산출물을 발견하면 Gate A/B 초안의 `evidence`와 `reference_reconnaissance`에 후보 근거로 반영한다. `diff-tasks`는 `task-graph.draft.json`만 만들고, `promote-tasks`가 사람 승인 audit과 함께 정본 `task-graph.json`으로 승격한다. `promote-milestone`은 checkpoint와 evidence를 검증한 고유 draft를 기존 안정 파일을 덮어쓰지 않는 원자적 방식으로 `<checkpoint>.json`에 승격한다. `p2a iteration maintenance add`는 Gate A/B/D 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 단일 task 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`, `--area`, `--prompt`, 반복 가능한 `--ref`, 반복 가능한 `--depends`, `--dry-run`이다. `--from-draft <file>`은 검토된 maintenance draft의 task들을 한 번에 검증해 append하며, 쓰기 전 `--dry-run`으로 preview하고 실제 append에는 `--yes`가 필요하다. 이미 같은 `eval-cluster:*`/proposal ref가 maintenance graph에 있으면 중복 task는 skip한다.

| `--tools codex,claude,gemini|all` | 대상 프로젝트에 P2A AI 개발용 skill/agent/command shim을 복사한다. 생략하면 복사하지 않는다. |
| `--include-team-bigfive` | 대상 프로젝트에 Team Big Five adapter를 설치한다. |
| `--team-bigfive-source <path-or-git-url>` | Team Big Five 원본 출처. local directory는 파일 목록과 SHA-256을 기록하고, Git URL은 fetch 없이 URL만 기록한다. |
| `--team-bigfive-targets codex,claude,gemini|all` | adapter 설치 대상. 생략하면 `--tools` 값, `--tools`도 없으면 `all`을 사용한다. |
| `--overwrite` | 대상 파일이 이미 있을 때 덮어쓰기를 허용한다. |
| `--dry-run` | 파일을 쓰지 않고 gate 검증과 인계 계획 출력만 수행한다. |

인계 전제는 Gate B~D가 통과된 상태다. 특히 `spec.approval`은 `approved`여야 하고, `spec.approval_audit`가 있어야 하며, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하고, `spec.open_decisions`와 `review.json.blocking_issues`는 비어 있어야 한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. Markdown view 파일은 존재할 때만 함께 복사된다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 대상 프로젝트는 `p2a tasks`, `p2a runs`, `p2a execute`, `p2a proposals`, `p2a eval`, `p2a memory`, `p2a validate`를 전역 패키지에서 실행하며, run/monitor/proposal 관련 schema도 패키지가 제공한다. `.plan2agent/project.config.json.runTracking`에는 참고용 기본 runs directory와 branch/worktree naming hint가 기록된다. 현재 실행 경로는 이 설정을 자동 소비하지 않고 CLI 인자에서 계산한다.

`--tools`를 지정하면 공통 P2A 원본인 `.agents/skills`, `.agents/agents`와 선택한 CLI별 mirror를 함께 복사한다. `codex`는 `.codex/agents`, `claude`는 `.claude/skills`와 `.claude/agents`, `gemini`는 `.gemini/agents`와 `.gemini/commands/p2a`를 추가한다. 복사된 파일과 선택한 CLI 범위는 `.plan2agent/manifest.json`의 `aiToolTargets`, `aiToolFiles`, `toolFiles`에 기록된다.

`--include-team-bigfive`를 지정하면 `.plan2agent/team-harnesses/team-bigfive/source-manifest.json`과 `adaptation-notes.md`를 생성하고, 선택한 CLI별 adapter entrypoint를 설치한다. Codex는 `.agents/skills/team-bigfive-kickoff/`와 `.codex/agents/team-bigfive-coordinator.toml`, Claude는 `.claude/skills/team-bigfive-kickoff/`와 `.claude/agents/team-bigfive-coordinator.md`, Gemini는 `.agents/skills/team-bigfive-kickoff/`, `.gemini/agents/team-bigfive-coordinator.md`, `.gemini/commands/p2a/team-bigfive.toml`을 사용한다. local source이고 Claude target이 포함되면 안전 필터를 통과한 원본 파일도 `.claude-plugin/team-bigfive/source/`에 복사한다. 설치 내역은 `manifest.json.externalHarnesses`, `externalHarnessFiles`, `project.config.json.teamBigFive`에 기록된다.

반복 구조 root를 인계할 때 maintenance task graph가 있으면 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다. active feature graph와 병합하지 않으며, `manifest.json.maintenanceFiles`와 `current-spec.json.handoff_records`에 handoff 기준점이 남는다. `preflight-research/`가 있으면 알려진 Feature Radar 파일도 대상 `.plan2agent/artifacts/<project_id>/preflight-research/`로 복사하고 `manifest.json.preflightResearchFiles`에 기록한다.

권장 순서는 dry-run으로 계획을 확인한 뒤 실제 인계를 실행하는 것이다.

```bash
p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake \
  --dry-run

p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --mode copy \
  --include-intake

p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --iteration-id active \
  --include-intake \
  --tools codex,claude,gemini

p2a handoff \
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
p2a handoff
p2a handoff -i
```

## 13. 대표 워크플로우

### 워크플로우 A — 기획 산출물 검증 후 인계

```bash
p2a validate \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json \
  --task-graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --require-approved-spec .plan2agent/artifacts/<project_id>/gate-b-spec/spec.json \
  --review .plan2agent/artifacts/<project_id>/gate-d-review/review.json \
  --require-review-pass \
  --status .plan2agent/artifacts/<project_id>/status.md

p2a validate \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --dry-run

p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project
```

### 워크플로우 B — legacy handoff 대상 프로젝트에서 ready task로 개발 시작

인계 후 대상 프로젝트에서 실행한다. 이 흐름은 `.plan2agent/project.config.json.taskGraph`가 flat graph를 가리키는 legacy handoff 대상용이다. `p2a init` 프로젝트는 Gate D 이후 `p2a iteration init`을 먼저 실행하고 `--artifacts .plan2agent/artifacts/<project_id>`를 사용한다. 관리형 `iterations/<iteration-id>/gate-c-task-graph/task-graph.json`을 `--graph`로 지정한 start/finish/task 전이는 거부된다.

```bash
p2a execute plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001

p2a execute start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex

p2a execute resume \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --run-id run-...

p2a execute finish \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

`start`가 출력한 prompt를 Claude Code 또는 Codex 같은 write-capable agent CLI에 붙여넣고 구현한다. Gemini CLI는 현재 review/monitor 같은 read-only 보조로만 사용한다. `resume`은 같은 run의 상태와 launcher prompt를 다시 출력하며 파일을 변경하지 않는다. `finish`는 검증 결과를 run log에 기록하고 task를 `done` 또는 `blocked`로 전이한다. 실행 footer에는 `resume`, `status`, `finish`, `review` 명령이 남고, `review`는 해당 run을 `p2a proposals mine --run-id <run-id>` 회고 후보 생성으로 연결한다.

`p2a execute start --require-monitor`는 run과 같은 `runs/<iterationId>/`에 `<run-id>.monitor-gate.json` sidecar를 만들고, 해당 run은 연결된 `.monitor-verdict.json` 없이는 `finished`로 닫을 수 없다. monitor gate가 필요하지 않은 단일 task에는 이 옵션을 붙이지 않는다.

#### `p2a-dev-execution` bounded ready batch

Batch mode는 `p2a execute`의 단건 계약을 바꾸지 않는다. Main owner가 다음 순서를 지킨다.

1. `p2a tasks ready` 결과를 한 ready snapshot으로 고정하고, 동일 파일·공유 설정·DB/API 계약처럼 알려진 integration surface가 겹치는 task는 제외한다.
2. committed canonical integration head를 `batchBase`로 정한다.
3. 선택한 task마다 같은 `--base-ref <batch-base>`의 fresh worktree를 만들며 `p2a execute start`를 직렬 호출한다.
4. 같은 write-capable provider의 `p2a-implementer`를 foreground에서 bounded하게 병렬 실행한다. Gemini는 read-only context handoff만 수행하며, 병렬 write confinement를 제공하지 않는 write-capable provider는 단건 fallback을 사용한다.
5. Main owner가 task별 diff와 changed files를 확정하고 reproducible commit/patch를 integration candidate에 하나씩 적용한다.
6. candidate에서 실제 verification과 필요한 monitor/style pass를 실행한다. 충돌·검증 실패·monitor block은 canonical integration branch를 전진시키거나 task를 `done` 처리하지 않는다.
7. 승인된 candidate만 canonical integration branch에 반영한 뒤 task별 `p2a execute finish`를 직렬 호출한다.
8. batch harvest가 끝난 뒤 `ready`를 다시 계산하고 다음 worktree는 최신 canonical integration head에서 만든다.

통합 worktree는 여러 task 결과를 누적하므로 `--collect-git` 결과 전체를 한 task의 `changedFiles`로 기록하지 않는다. Task worktree에서 동결한 파일 목록을 명시 기록하고, integration base/ref/workspace는 `INTEGRATION:` run note로 남긴다. Dirty·unmerged·failed·blocked task 또는 integration-candidate worktree는 자동 또는 강제로 제거하지 않는다.

### 워크플로우 C — CLI mirror와 fixture 회귀 확인

CLI asset 또는 fixture를 건드린 뒤에는 Plan2Agent 본체 저장소 루트에서 다음 순서로 drift와 fixture 회귀를 확인한다. `sync_cli_assets.mjs`, `check_cli_parity.mjs`, `run_fixtures.mjs`는 본체 개발자용 스크립트이며 `init` 대상 프로젝트에는 설치되지 않는다.

```bash
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

### 워크플로우 D — run 회고에서 개선 proposal 만들기

대상 프로젝트에서 실패/blocked run이나 verification gap이 쌓인 뒤 실행한다.

`p2a enhance proposals`를 적용한 프로젝트는 `.plan2agent/project.config.json.proposals`와 `manifest.json.enhancements.proposals`에 proposal queue capability가 기록된다. `p2a info`는 큐 위치, 큐 JSON 수, manifest/config sync 상태, review/patch/approval 정책을 보여주고, `p2a doctor --dev`는 proposal manifest/config drift, proposal runtime script, proposal schema, mining signal, manual curation, draft-only patch, approval gate를 로컬 설정 기준으로 검사한다.

`mine`은 기록된 run log와 monitor sidecar를 읽어 회고 후보만 만든다. provider CLI나 재시도 run을 자동으로 시작하지 않으며, blocked run의 `retry`, `ask_user`, `stop` 결정과 후속 실행은 owner가 별도로 기록·수행한다.

```bash
p2a proposals mine \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

p2a proposals digest \
  --proposals .plan2agent/proposals

p2a proposals review \
  --proposals .plan2agent/proposals

p2a proposals curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

p2a proposals draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

p2a proposals approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by <name>

p2a validate \
  --proposals-dir .plan2agent/proposals

p2a validate \
  --proposal-review .plan2agent/proposals/reviews/proposal-review-<hash>.json

p2a validate \
  --proposal-curation .plan2agent/proposals/curations/proposal-curation-<hash>.json

p2a validate \
  --proposal-patch-draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json

p2a validate \
  --proposal-draft-approval .plan2agent/proposals/approvals/proposal-draft-approval-<hash>.json
```

`digest` 결과는 빠른 현황 요약이고, `review`/`curate`/`draft-patch`/`approve-draft` 결과는 승인 판단과 후속 task 연결용 artifact다. 적용은 자동으로 하지 않고, 승인된 maintenance task를 별도 실행해서 반영한다.

### 워크플로우 E — 반복 열기와 Gate A/B 초안 생성

기존 active 반복의 모든 task가 `done`이면 반복을 close하고, 닫힌 반복이 2개 이상일 때는 compose로 current-effective 기준을 갱신한 뒤 다음 반복을 열어 baseline-aware Gate A/B draft를 생성할 수 있다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

p2a iteration close \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "변경 아이디어"

p2a iteration draft \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --allow-planning

p2a validate \
  --intake .plan2agent/artifacts/<project_id>/iterations/iter-002/gate-a-intake/intake.json \
  --spec .plan2agent/artifacts/<project_id>/iterations/iter-002/gate-b-spec/spec.json

# Gate B 승인 후:
p2a iteration promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

p2a iteration promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."

# Gate C task graph 실행과 Gate D review까지 완료한 뒤:
p2a iteration close \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration compose \
  --artifacts .plan2agent/artifacts/<project_id>

p2a iteration open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-003 \
  --idea "다음 변경 아이디어"
```

### 워크플로우 E — maintenance task 추가

작은 버그 수정, 문서 보정, 패치성 변경은 기능 반복을 새로 열지 않고 상시 `maintenance` task graph에 추가한다. 첫 task를 추가할 때 graph가 없으면 `iterations/maintenance/gate-c-task-graph/task-graph.json`이 생성되고, 이후 실행은 다음 task id로 append한다.

```bash
p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo" \
  --accept "Typo is fixed"

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Patch cache docs" \
  --accept "Cache docs describe invalidation" \
  --accept "Existing examples still render" \
  --ref effective_product.problem

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --dry-run

p2a iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --from-draft eval/maintenance-draft.json \
  --yes

p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id>
```

`maintenance add`는 active 기능 반복이 close-ready가 아니어도 실행할 수 있지만, `compose`, active iteration 회전, close 대상에는 maintenance를 포함하지 않는다. `--from-draft`는 `p2a eval analyze --maintenance-draft <file>`가 만든 draft를 읽어 task id를 새로 배정하고, draft-local dependency가 있으면 append된 task id로 매핑한다. 실제 쓰기는 `--yes`를 요구한다.

---

정확한 전체 옵션은 각 도구의 `--help`가 정본이다. `p2a tasks`와 `p2a handoff`는 터미널에서 인자 없이 실행하거나 `-i`/`--interactive`를 붙이면 대화형 메뉴가 뜬다. 이 문서는 개요·흐름·예시용이며, 옵션 세부는 `--help`를 따른다.
