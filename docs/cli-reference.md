# Plan2Agent CLI 사용자 가이드

이 문서는 Plan2Agent에서 자주 쓰는 CLI 흐름과 대표 명령을 한곳에 모은 사용자 가이드다. 옵션 전체를 복제하지 않고, 실제 사용 흐름에 필요한 주요 명령과 예시만 다룬다. 세부 옵션은 각 도구의 `--help` 또는 스크립트 usage가 정본이다.

문서 홈: [Plan2Agent Docs](README.md) · 먼저 보기: [Quickstart](quickstart.md)

## 1. 개요

Plan2Agent CLI는 기획 산출물 검증, 승인된 task graph 실행, agent run 기록, 반복 개발 상태 관리를 제공한다. npm 패키지는 runtime scripts와 schemas를 제공하고, 각 프로젝트는 `.plan2agent/`에 상태·설정·선택한 provider asset만 보관한다.

| 명령 | 역할 |
| --- | --- |
| `p2a init` | 새 프로젝트의 상태와 provider asset을 초기화한다. |
| `p2a next` | 현재 상태에 맞는 한 가지 다음 행동을 반환한다. |
| `p2a decide`, `p2a decisions` | Gate ①·범위 변경을 append-only 원장에 기록하고 결정 계보를 조회한다. |
| `p2a shape` | Gate ② constitution 상태, legacy style migration, 인용 승인 기록을 관리한다. |
| `p2a iteration`, `p2a tasks`, `p2a runs`, `p2a execute` | 반복·task·run 실행 흐름을 관리한다. |
| `p2a validate`, `p2a eval`, `p2a memory`, `p2a proposals` | 산출물 검증, 평가, Memory, 개선 제안을 관리한다. |
| `p2a doctor`, `p2a enhance`, `p2a update` | 프로젝트 상태를 진단하고 provider/config 자산을 관리한다. |
| `p2a handoff` | 승인된 산출물을 별도 대상 프로젝트로 인계한다. |

Plan2Agent 본체 개발에서만 `scripts/sync_cli_assets.mjs`, `scripts/check_cli_parity.mjs`, `scripts/run_fixtures.mjs`를 직접 실행한다.

전체 흐름은 다음과 같다.

1. 하네스가 짧은 Markdown 또는 text 진입 문서에서 **Gate A intake → Gate ② constitution → Gate B spec → Gate C task graph** 산출물을 만든다.
2. Plan2Agent 본체 저장소에서는 `scripts/validate_artifacts.mjs`, `scripts/run_fixtures.mjs`, `scripts/check_cli_parity.mjs`로 fixture와 CLI 구성을 검증한다. `init` 대상 프로젝트에서는 `p2a validate`와 `p2a iteration`로 산출물을 검증한다.
3. 새 프로젝트는 먼저 `p2a init --target <project-dir> --tools all`로 하네스를 설치하고 같은 저장소 안에서 기획부터 반복까지 진행한다. 외부 산출물을 옮기는 경우에만 기존 handoff로 승인된 산출물을 개발 대상 저장소의 `.plan2agent/artifacts/`로 인계한다.
4. 대상 저장소에서는 `p2a info`로 현재 상태를 확인하고, `p2a execute plan/start`로 ready task 1건의 run을 열어 감독형 agent prompt를 출력한다. 여러 독립 ready task를 실행할 때도 batch CLI를 만들지 않고 `p2a-dev-execution` owner가 같은 ready snapshot에서 task별 `execute start`를 직렬 호출한다. 세션이 끊기면 `p2a execute resume`으로 같은 run prompt를 다시 출력한다. 복수 agent 역할이나 monitor gate가 필요한 task는 `p2a execute start --require-monitor`로 task별 실행 계획을 만든다.
5. `p2a execute status/finish`로 run 상태 확인, verification, run finish, task done/block 전이를 묶어 기록한다. Full visual iteration의 모든 task를 완료·통합한 뒤에는 `p2a execute review`로 iteration당 하나의 canonical no-change pre-close 검토 run을 연다. 세부 제어가 필요하면 `p2a tasks`와 `p2a runs`를 직접 사용한다.
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

`p2a`의 하위 명령은 `decide`, `decisions`, `shape`, `eval`, `memory`, `execute`, `tasks`, `runs`, `iteration`, `proposals`, `validate`, `doctor`, `enhance`, `update`, `upgrade`, `handoff`다. `--target`을 생략하면 현재 작업 디렉터리를 대상으로 삼는다.

### 결정 원장 — `p2a decide`, `p2a decisions`

Gate 승인과 범위·헌법 변경은 `.plan2agent/artifacts/<project_id>/decisions.jsonl`에만 append한다. 각 줄은 단조 증가하는 `seq`와 직전 결정의 canonical SHA-256인 `prev_sha256`을 가지며, 기존 줄을 수정하거나 삭제하지 않는다. 기존 `approval_audit`는 호환·가독성을 위한 아티팩트 사본으로 계속 유지하지만, 원장이 존재하면 `p2a next`는 원장만 승인 상태의 1차 근거로 사용한다. 원장이 전혀 없는 기존 프로젝트만 audit 스캔으로 폴백한다.

```bash
p2a decide --artifacts .plan2agent/artifacts/<project_id> \
  --quote "이 범위로 진행해"

p2a decide revoke --artifacts .plan2agent/artifacts/<project_id> \
  --quote "승인을 철회해"

p2a decide add --artifacts .plan2agent/artifacts/<project_id> \
  --scope "재시도 지원" --quote "재시도도 넣자"

p2a decisions --artifacts .plan2agent/artifacts/<project_id>
p2a decisions --artifacts .plan2agent/artifacts/<project_id> \
  --why src/example.ts
```

`p2a decide`는 가장 이른 미승인 Gate ① intake/spec을 승인하고 실제 사용자 발화를 원장과 audit 사본에 함께 기록한다. `revoke`, `add`, `remove`도 이전 기록을 지우지 않고 새 이벤트를 append한다. `p2a shape approve|revoke`는 같은 원장에 Gate ② 이력을 남기며, 헌법 본문이 바뀐 재승인은 `constitution.changed`도 기록한다. `decisions --why`는 run의 `changedFiles`, `sourceSpecRef`, Gate ① 결정과 당시 활성 Gate ② 결정을 조인한다. 인터뷰 라운드, task 분해, run 시작·종료, validator 실행 상세는 원장 이벤트가 아니다.

## 3. 프로젝트 초기화 — `p2a init`

```bash
p2a init [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
p2a enhance <capability> [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--overwrite] [--dry-run]
p2a update [--target <project-dir>] [--tools all|none|codex,claude,gemini] [--codex-profile quality|inherit] [--dry-run|--apply] [--prune]
```

`init`은 fresh 프로젝트에 manifest, project config, `PLAN2AGENT.md`, `.gitignore`, 선택한 AI tool asset을 만든다. Constitution은 Gate A 승인 뒤 Gate ②에서 제안·승인하므로 init이 빈 계약을 미리 만들지 않는다. npm으로 설치된 package runtime에서 실행하면 `.plan2agent/scripts/`와 `.plan2agent/schemas/`를 만들지 않는다. Plan2Agent clone checkout에서 실행하면 기존 사용자를 위해 두 디렉터리와 `toolkitRoot`를 포함한 co-located runtime을 계속 설치한다. 터미널과 agent skill은 항상 `p2a …`를 실행한다. 기존 `scaffold`는 호환 별칭이지만 새 프로젝트 문서와 자동 안내에서는 사용하지 않는다.

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

출력에는 설치 파일 체크와 별개로 `projectState`가 포함된다. `projectState.state`는 `installed_empty`, `planning_in_progress`, `iteration_init_required`, `execution_ready`, `cycle_close_ready`, `broken_install`, `no_p2a` 중 하나이며, artifact root별 Gate A-C 존재 여부, Gate B approval/open decision 수, Gate C task count/ready 수, run-index 요약을 함께 보여준다. `init` 프로젝트에 greenfield Gate A-C bundle이 있으면 `project_state` 체크가 warning으로 표시되고 `p2a iteration init` 명령을 next action으로 출력한다.

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

동일한 장기 회귀 gate는 저장소 표준 script인 `npm run test:full`로 실행할 수 있다. Completed/resumable handoff portability 행렬도 이 gate에 포함된다.

### `validate_artifacts.mjs`

개별 산출물 또는 fixture 디렉터리를 검증한다. 자주 쓰는 조합은 다음과 같다.

```bash
p2a validate \
  --intake .plan2agent/artifacts/<project_id>/gate-a-intake/intake.json

p2a shape

p2a validate \
  --constitution .plan2agent/constitution.json \
  --require-approved-constitution

p2a validate \
  --decisions \
  --artifacts .plan2agent/artifacts/<project_id>

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
  --visual-experience .plan2agent/artifacts/<project_id>/gate-b-spec/experience-spec.json

p2a validate \
  --visual-prototype .plan2agent/artifacts/<project_id>/gate-b-spec/visual-design/VD-1/prototype.json

p2a validate \
  --visual-review .plan2agent/artifacts/<project_id>/runs/<iteration-id>/<run-id>.visual-review.json

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
  --artifacts .plan2agent/artifacts/<project_id>

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

`--status`는 generated `status.md` view의 최소 구조만 확인한다. `--decisions`는 명시 경로 또는 `--artifacts <root>/decisions.jsonl`의 줄별 schema, 단조 `seq`, `prev_sha256` 체인을 검증한다. `--artifact-root`/`--artifacts`는 `.plan2agent/artifacts/<project_id>/` 아래 Gate A-C JSON bundle과 존재하는 결정 원장을 한 번에 검증하며, 승인된 Gate B spec이 있으면 `spec.approval_audit`도 확인한다. `--spec`은 `--intake`가 있으면 그 intake를 사용하고, 없으면 `spec.source_intake`를 실제 파일로 자동 연결해 Gate B traceability를 검사한다. `spec.source_intake`가 명시됐지만 파일로 해석되지 않으면 실패한다. 레거시 `review.json`을 명시적으로 검사해야 할 때만 `--review`와 선택적인 `--require-review-pass`를 사용할 수 있으며, 이 파일은 readiness 조건이 아니다.

`--visual-experience`, `--visual-prototype`, `--visual-review`는 Gate B의 screen composition, prototype 디렉터리의 모든 regular file이 manifest 해시 집합에 포함된 passive offline HTML/CSS bundle, 실제 PNG·접근성 JSON의 해시와 capture metadata를 포함한 iteration 최종 verdict를 개별 검증한다. Full mode는 최소 두 후보를 요구하고, 각 screen state는 진입점에서 구조적으로 활성인 local anchor로 도달 가능한 HTML/fragment에 매핑되어야 한다. Core artifact validator는 CSS cascade·specificity로 렌더링 visibility를 추정하지 않으며 실제 표시 상태는 브라우저 캡처 기반 최종 review가 판정한다. Prototype은 `script-src 'none'` CSP를 사용하며 executable JavaScript, inline event handler, 외부 navigation을 허용하지 않는다. Prototype manifest와 각 선언 파일은 해시·parse 전에 25MiB 상한을 적용하고, PNG chunk ordering·palette·scanline 검증은 별도 media validator가 담당한다. `--runs-dir`는 새 `p2a.run.v2` finished run을 원본 task graph와 승인 spec에 다시 결합해 run-start `taskContractSha256`을 확인한다. 일반 `visualImpact` 구현 run은 sidecar를 요구하지 않으며, 필요하면 `p2a runs record --visual-feedback note|concern ...`으로 비차단 중간 피드백을 남길 수 있다. `runKind: final_visual_review` run만 Gate B에서 파생한 전체 `visualReview` 계약, `iteration_id` 귀속 sidecar, workspace identity/revision, 봉인된 `visualReviewEvidenceSha256`, evidence-backed `confirm_ui`를 검증한다. Graph mode에서는 `--runs`가 원본 graph와 다른 디렉터리를 가리키거나 graph가 project-relative source spec을 참조해도 실제로 해석된 spec의 artifact root에서 provenance를 검증하며, 성공 finish 전에 같은 검사를 수행한다. `p2a runs validate --run-id`도 schema-only shortcut을 사용하지 않고 run store 전체의 index와 provenance를 함께 검증한다. 기존 `p2a.run.v1` non-visual 이력은 digest 없이도 계속 읽을 수 있으며 진행 중 v1 run은 finish 시 v2로 승격된다.

`--run`, `--run-index`, `--runs-dir`는 `p2a runs`가 만든 run log와 index의 schema 및 상호 참조를 검증한다. `--require-monitor`, `--monitor-gate`, `--skill-proposal`, `--proposal-review`, `--proposal-curation`, `--proposal-patch-draft`, `--proposal-draft-approval`, `--proposals-dir`는 monitor gate sidecar와 Hermes식 proposal queue/review/curation/patch draft/approval artifact를 검증한다.

`p2a iteration validate`는 반복 구조의 active iteration 포인터, active Gate B/C 산출물, task dependency, current-spec composition과 planning Memory 상태/보고서/`LOCAL-n` 인용 정합성을 검증한다. `--allow-planning`/`--stage`는 Gate A-ready, Gate B draft/approved, 또는 `gate-c-task-graph/task-graph.draft.json`을 검증하는 Gate C draft 상태를 planning state로 검증한다. `--require-close-ready`를 붙이면 모든 active task가 `done`인지 확인하며, visual task의 최신 run이 `p2a execute review`가 연 `runKind: final_visual_review` canonical integration workspace의 변경 없는 run인지, 봉인된 workspace revision이 현재 canonical revision과 같은지, sidecar와 evidence digest가 여전히 유효한지 검증한다. 개별 flat task graph가 승인된 spec을 기준으로 생성됐는지 확인할 때는 `validate_artifacts.mjs --task-graph ... --require-approved-spec ...`를 사용한다.

`p2a iteration close/open/draft/promote-spec/context/diff-tasks/promote-tasks/promote-milestone/compose`는 반복 planning과 task graph·milestone 초안/승격을 다룬다. `context --scope feature`는 기본값이며 active 기능 반복의 task 저작 context를 출력한다. `context --scope maintenance`는 active feature diff를 섞지 않고 `active_iteration: "maintenance"`와 maintenance task 요약을 포함한 유지보수용 context를 출력한다. `draft`는 `.plan2agent/artifacts/<project_id>/preflight-research/`의 Feature Radar 산출물을 발견하면 Gate A/B 초안의 `evidence`와 `reference_reconnaissance`에 후보 근거로 반영한다. `diff-tasks`는 `task-graph.draft.json`만 만들고, `promote-tasks`는 validator를 통과한 draft를 별도 사람 승인 audit 없이 정본 `task-graph.json`으로 승격한다. `promote-milestone`은 checkpoint와 evidence를 검증한 고유 draft를 기존 안정 파일을 덮어쓰지 않는 원자적 방식으로 `<checkpoint>.json`에 승격한다. `p2a iteration maintenance add`는 Gate A/B 없이 `iterations/maintenance/gate-c-task-graph/task-graph.json`을 lazy 생성하거나 append한다. 단일 task 필수 옵션은 `--title`과 하나 이상의 `--accept`이며, 선택 옵션은 `--description`, `--area`, `--prompt`, 반복 가능한 `--ref`, 반복 가능한 `--depends`, `--dry-run`이다. `--from-draft <file>`은 검토된 maintenance draft의 task들을 한 번에 검증해 append하며, 쓰기 전 `--dry-run`으로 preview하고 실제 append에는 `--yes`가 필요하다. 이미 같은 `eval-cluster:*`/proposal ref가 maintenance graph에 있으면 중복 task는 skip한다.

| `--tools codex,claude,gemini|all` | 대상 프로젝트에 P2A AI 개발용 skill/agent/command shim을 복사한다. 생략하면 복사하지 않는다. |
| `--include-team-bigfive` | 대상 프로젝트에 Team Big Five adapter를 설치한다. |
| `--team-bigfive-source <path-or-git-url>` | Team Big Five 원본 출처. local directory는 파일 목록과 SHA-256을 기록하고, Git URL은 fetch 없이 URL만 기록한다. |
| `--team-bigfive-targets codex,claude,gemini|all` | adapter 설치 대상. 생략하면 `--tools` 값, `--tools`도 없으면 `all`을 사용한다. |
| `--overwrite` | 대상 파일이 이미 있을 때 덮어쓰기를 허용한다. |
| `--dry-run` | 파일을 쓰지 않고 gate 검증과 인계 계획 출력만 수행한다. |

인계 전제는 Gate B/C가 validator를 통과한 상태다. 특히 `spec.approval`은 `approved`여야 하고, `spec.approval_audit`가 있어야 하며, 모든 intake `CQ-n`은 `spec.clarifying_question_disposition`에서 처분되어야 하고 `spec.open_decisions`는 비어 있어야 한다. Gate C 사람 승인 audit과 Gate D review 파일은 요구하지 않는다. 승인된 `.plan2agent/constitution.json`이 source 프로젝트에 있으면 대상 프로젝트에도 함께 복사되며, legacy no-constitution handoff도 계속 지원한다. 반복 구조 root를 넘기면 active 반복 산출물을 `.plan2agent/artifacts/`로 평탄화하고, `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase한다. 이때 `intake.json`은 항상 함께 복사되며, 루트 `current-spec.json`은 `.plan2agent/current-spec.json`으로 함께 복사한다. Markdown view 파일은 존재할 때만 함께 복사된다. 반복 history 보존을 위해 iterative root에서는 `--mode move`를 지원하지 않는다. 대상 프로젝트는 `p2a tasks`, `p2a runs`, `p2a execute`, `p2a proposals`, `p2a eval`, `p2a memory`, `p2a validate`를 전역 패키지에서 실행하며, run/monitor/proposal 관련 schema도 패키지가 제공한다. `.plan2agent/project.config.json.runTracking`에는 참고용 기본 runs directory와 branch/worktree naming hint가 기록된다. 현재 실행 경로는 이 설정을 자동 소비하지 않고 CLI 인자에서 계산한다.

`--tools`를 지정하면 공통 P2A 원본인 `.agents/skills`, `.agents/agents`와 선택한 CLI별 mirror를 함께 복사한다. `codex`는 `.codex/agents`, `claude`는 `.claude/skills`와 `.claude/agents`, `gemini`는 `.gemini/agents`와 `.gemini/commands/p2a`를 추가한다. 복사된 파일과 선택한 CLI 범위는 `.plan2agent/manifest.json`의 `aiToolTargets`, `aiToolFiles`, `toolFiles`에 기록된다.

`--include-team-bigfive`를 지정하면 `.plan2agent/team-harnesses/team-bigfive/source-manifest.json`과 `adaptation-notes.md`를 생성하고, 선택한 CLI별 adapter entrypoint를 설치한다. Codex는 `.agents/skills/team-bigfive-kickoff/`와 `.codex/agents/team-bigfive-coordinator.toml`, Claude는 `.claude/skills/team-bigfive-kickoff/`와 `.claude/agents/team-bigfive-coordinator.md`, Gemini는 `.agents/skills/team-bigfive-kickoff/`, `.gemini/agents/team-bigfive-coordinator.md`, `.gemini/commands/p2a/team-bigfive.toml`을 사용한다. local source이고 Claude target이 포함되면 안전 필터를 통과한 원본 파일도 `.claude-plugin/team-bigfive/source/`에 복사한다. 설치 내역은 `manifest.json.externalHarnesses`, `externalHarnessFiles`, `project.config.json.teamBigFive`에 기록된다.

반복 구조 root를 인계할 때 maintenance task graph가 있으면 `.plan2agent/maintenance/task-graph.json`으로 별도 복사한다. active feature graph와 병합하지 않으며, `manifest.json.maintenanceFiles`와 `current-spec.json.handoff_records`에 handoff 기준점이 남는다. `preflight-research/`가 있으면 알려진 Feature Radar 파일도 대상 `.plan2agent/artifacts/<project_id>/preflight-research/`로 복사하고 `manifest.json.preflightResearchFiles`에 기록한다.

Run 이관은 목적을 분리한다. 기본 `--run-transfer completed`는 milestone review가 직접 참조한 `finished` `p2a.run.v2` evidence와 동일 iteration/task graph에서 가장 최근에 끝난 v2 `final_visual_review` evidence를 portable bundle에 포함한다. 최종 visual review는 pre-close milestone 뒤에 실행되므로 milestone snapshot에 직접 참조되지 않은 close-ready 증거도 누락되지 않는다. Run 파일 위치는 `p2a runs migrate-layout`, finished v1 schema는 `p2a runs migrate-schema`로 handoff 전에 각각 정규화한다. Absolute/non-canonical provenance reference는 명시적 import/migration workflow로 정리해야 하며 portable handoff 본체는 이를 rewrite하지 않는다. 다른 환경에서 진행 중 non-visual run이나 구형 호환 이력을 실제로 재개할 때만 `--run-transfer resumable`을 사용하며, 이 모드는 해당 run의 task graph/spec/intake source closure까지 보존하고 호환 rewrite를 허용한다. 진행 중 `final_visual_review`는 canonical integration workspace의 snapshot에 묶여 있어 resumable 모드에서도 거부된다. 실제 쓰기 뒤에는 대상 Gate A-C bundle과 run store를 다시 검증하고 실패하면 target 변경을 rollback한다.

`--include-intake`는 source의 기존 `intake.md`를 신뢰하거나 복사하지 않는다. handoff가 rebase한 canonical `intake.json`에서 explicit-export marker가 포함된 최신 Markdown export를 생성하므로, 이전 버전의 자동 생성 view나 stale Markdown이 대상에 전달되지 않는다.

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
  --run-transfer completed \
  --include-intake \
  --tools codex,claude,gemini

# 진행 중 non-visual run까지 명시적으로 재개할 때만 사용
p2a handoff \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --iteration-id active \
  --run-transfer resumable

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

인계 후 대상 프로젝트에서 실행한다. 이 흐름은 `.plan2agent/project.config.json.taskGraph`가 flat graph를 가리키는 legacy handoff 대상용이다. `p2a init` 프로젝트는 Gate A-C validation 이후 `p2a iteration init`을 먼저 실행하고 `--artifacts .plan2agent/artifacts/<project_id>`를 사용한다. 관리형 `iterations/<iteration-id>/gate-c-task-graph/task-graph.json`을 `--graph`로 지정한 start/finish/task 전이는 거부된다.

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

# full visual iteration의 구현 통합이 끝난 뒤, 완료된 visual task마다 실행
p2a execute review \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool gemini \
  --workspace "$PWD"
```

`start`가 출력한 prompt를 Claude Code 또는 Codex 같은 write-capable agent CLI에 붙여넣고 구현한다. Gemini CLI는 `execute review`나 monitor 같은 read-only 보조에 사용할 수 있다. `resume`은 일반 구현 run에는 launcher prompt를, `runKind: final_visual_review` run에는 동일한 capture/revision/finish 지침을 다시 출력하며 파일을 변경하지 않는다. 일반 구현 run의 `finish`는 검증 결과를 run log에 기록하고 task를 `done` 또는 `blocked`로 전이한다. `execute review`는 모든 iteration task가 done일 때만 canonical workspace의 `isolation: none`, 빈 `changedFiles` pre-close run을 시작한다. 선택된 visual task id는 검토 범위 소유자가 아니라 실패 시 되돌릴 remediation owner다. Review가 confirm되면 task는 `done`을 유지하고, failed/blocked로 끝나면 해당 owner를 사유와 함께 `todo`로 reopen하여 다음 `p2a next`가 구현 remediation을 안내한다. 이미 봉인된 final review보다 workspace가 변경된 경우 `p2a next`는 새 review를 안내한다. 봉인된 sidecar/evidence 자체가 변경되거나 누락된 경우에는 새 review로 과거 감사 손상을 가리지 않고 `p2a runs validate` 복구 경로를 안내한다. 실행 footer의 별도 proposal `review` 링크는 해당 run을 `p2a proposals mine --run-id <run-id>` 회고 후보 생성으로 연결한다.

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

### 워크플로우 E — 반복 열기와 Gate A 범위 확인/Gate B 초안 생성

기존 active 반복의 모든 task가 `done`이면 반복을 close하고, 닫힌 반복이 2개 이상일 때는 compose로 current-effective 기준을 갱신한 뒤 다음 반복을 연다. 첫 `draft`는 Gate A 범위 확인 intake를 만들고, 사용자의 명시적 Gate A 확인을 `intake.json`에 기록한 뒤 같은 session에서 `draft`를 다시 호출하면 Gate B 초안이 생성된다.

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
  --stage gate-a

# harness scope summary -> explicit Gate A confirmation
# confirmed intake: status=ready_for_spec, approval_audit present

p2a iteration draft \
  --artifacts .plan2agent/artifacts/<project_id>

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
  --artifacts .plan2agent/artifacts/<project_id>

# Gate C task graph의 모든 task를 완료하고 close-ready validation을 통과한 뒤:
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

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
