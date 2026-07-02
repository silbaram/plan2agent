# Plan2Agent Quickstart

Plan2Agent는 한 문장 아이디어를 승인 가능한 제품/구현 명세와 실행 가능한 task graph로 바꾸고, 이후 개발 handoff와 agent 실행 결과 추적까지 이어주는 파일 기반 planning harness다.

이 문서는 처음 사용하는 사람이 전체 제품 흐름을 빠르게 이해하고 바로 명령을 실행할 수 있도록 만든 사용자용 시작 페이지다. 세부 옵션은 [CLI 사용자 가이드](cli-reference.md), 반복 구조의 정식 계약은 [반복/고도화 개발 스펙](iteration-spec.md)을 본다.

문서 홈: [Plan2Agent Docs](README.md)

## 한눈에 보기

| 원하는 일 | 사용하는 것 | 결과 |
| --- | --- | --- |
| 아이디어를 기획 산출물로 만들기 | P2A skills/subagents | `.plan2agent/artifacts/<project_id>/gate-*` |
| 산출물 검증하기 | `p2a.mjs validate`, `p2a.mjs iteration` | schema/gate 오류 조기 발견 |
| 다음 반복 열기 | `p2a.mjs iteration` | `iterations/<iter-id>/`와 `current-spec.json` |
| 변경분 task 만들기 | `diff-tasks`, `context`, `promote-tasks` | semantic 또는 agent-authored draft task graph |
| 대상 프로젝트로 넘기기 | `p2a_handoff.mjs`, 이후 `p2a.mjs` | `.plan2agent/`와 실행 CLI 설치 |
| 현재 상태 보기 | `p2a.mjs info` | active artifact, task/run 요약 |
| 감독형 단일 task 실행 | `p2a.mjs execute` | task/run lifecycle 반자동 진행 |
| 개발 task 실행 관리 | `p2a.mjs tasks` | ready/prompt/start/done 상태 전이 |
| agent 실행 결과 기록 | `p2a.mjs runs` | `runs/run-index.json`, `runs/<runId>.json` |
| 실행 회고 개선 후보 만들기 | `p2a.mjs proposals` | `proposals/<proposalId>.json`, `proposals/reviews/<reviewId>.json`, `proposals/curations/<curationId>.json`, `proposals/patch-drafts/<draftId>.json` |

## 권장 시작: co-located scaffold

새 코드 프로젝트는 프로젝트 디렉터리 안에 P2A 하네스 전체를 먼저 설치하는 co-located 모델을 권장한다. 이 모델에서는 같은 디렉터리에서 greenfield 기획(Gate A-D), 개발 task 실행, run tracking, 다음 반복을 모두 진행한다.

```bash
node /path/to/plan2agent/scripts/p2a_handoff.mjs scaffold \
  --target <project-dir> \
  --tools all
```

`scaffold`는 co-located 정식 진입점으로, 빈 프로젝트에 하네스와 프로젝트용 `.gitignore`를 설치한다. 설치 후 `<project-dir>`에서 Claude Code/Codex/Gemini를 열고 `/p2a-harness "<한 문장 아이디어>"`를 실행한다. 산출물은 이 프로젝트의 `.plan2agent/artifacts/<project>/gate-*`에 생성된다. 승인 후 `node .plan2agent/scripts/p2a.mjs iteration init --artifacts .plan2agent/artifacts/<project>`로 반복 구조로 전환하고, `p2a.mjs execute`를 기본 진입점으로 개발 task 실행과 run tracking을 진행한다. `p2a.mjs eval grade/compare/analyze/generate/digest`는 run 평가, regression/failure cluster 점검, eval artifact 생성과 요약에 쓰고, `p2a.mjs tasks`/`p2a.mjs runs`는 세부 상태 전이와 run log를 직접 다룰 때 쓴다. 설치 후 drift 점검은 프로젝트 루트에서 `node .plan2agent/scripts/p2a.mjs update --dry-run` 또는 `upgrade --dry-run`으로 확인하고, 검토 후 안전 항목만 적용하려면 `--apply`를 붙인다. preview/apply 결과는 대상 프로젝트의 `.plan2agent/update-reports/`에 남는다. `handoff`는 plan2agent에서 이미 기획한 승인 산출물을 별도 프로젝트로 옮기는 레거시/특수 흐름으로 유지된다.

Scaffold가 생성하는 `.plan2agent/`는 application source git에 커밋하지 않는 로컬 하네스 상태다. 장기 보존, 검색, 재개 기준은 `p2a_memory.mjs status/push/digest` 기반 Plan2Agent Memory 동기화를 기준으로 두고, git commit은 제품 소스코드 변경에 집중한다.

```text
Idea
  -> Gate A intake
  -> Gate B product spec + implementation plan
  -> Gate C task graph
  -> Gate D review
  -> handoff to target project
  -> task execution + run logs
  -> retrospective proposals
  -> next iteration
```

## 설치 후 첫 확인

Plan2Agent 본체 저장소를 개발하거나 검증할 때는 Plan2Agent 저장소 루트에서 다음 명령이 통과하면 기본 schema, fixture, CLI mirror 상태가 맞다.

```bash
node scripts/run_fixtures.mjs
node scripts/check_cli_parity.mjs
```

주의: `check_cli_parity.mjs`, `run_fixtures.mjs`, `sync_cli_assets.mjs`는 Plan2Agent 본체 개발자용 스크립트이며 scaffold 대상 프로젝트에는 설치되지 않는다.

scaffold로 하네스를 설치한 실제 프로젝트에서는 먼저 공통 진입점으로 상태를 확인한다.

```bash
node .plan2agent/scripts/p2a.mjs info
```

개별 artifact root를 검증할 때는 다음을 사용한다.

```bash
node .plan2agent/scripts/p2a.mjs validate \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready
```

초기 Gate A-D bundle이 준비되면 같은 실제 프로젝트 루트에서 반복 구조로 전환한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

## 제품 흐름

### 1. 기획 생성

P2A 하네스는 다음 gate를 지킨다.

| Gate | 의미 | 통과 조건 |
| --- | --- | --- |
| Gate A | intake 결정 | high-impact decision이 답변됨 |
| Gate B | 제품/구현 spec 승인 | `approval: approved`, `open_decisions: []` |
| Gate C | task graph 확정 | dependency 유효, cycle 없음, acceptance 있음 |
| Gate D | review 통과 | `review.json.blocking_issues == []` |

생성되는 기본 파일 구조:

```text
.plan2agent/artifacts/<project_id>/
  status.md
  gate-a-intake/
    intake.json
    intake.md
  gate-b-spec/
    product-spec.md
    implementation-plan.md
    spec.json
  gate-c-task-graph/
    task-graph.json
  gate-d-review/
    review.json
    review-report.md
```

### 2. 반복 구조로 전환

초기 planning bundle이 Gate B-D까지 준비되면 반복 구조로 전환한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

현재 활성 반복을 확인한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration current \
  --artifacts .plan2agent/artifacts/<project_id>
```

반복 구조가 생기면 정본은 다음 파일들이다.

```text
.plan2agent/artifacts/<project_id>/
  status.md
  current-spec.json
  iterations/
    v1-mvp/
      gate-a-intake/
      gate-b-spec/
      gate-c-task-graph/
      gate-d-review/
    maintenance/
```

### 3. 새 변경 열기

현재 반복의 task가 완료되고 close-ready 상태가 되면 반복을 닫는다.

```bash
node .plan2agent/scripts/p2a.mjs iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

node .plan2agent/scripts/p2a.mjs iteration close \
  --artifacts .plan2agent/artifacts/<project_id>
```

다음 변경을 연다.

```bash
node .plan2agent/scripts/p2a.mjs iteration open \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id iter-002 \
  --idea "Add follow-up dashboard"
```

Gate A/B 초안을 만든다.

```bash
node .plan2agent/scripts/p2a.mjs iteration draft \
  --artifacts .plan2agent/artifacts/<project_id>
```

사용자가 Gate B를 승인한 뒤 active spec으로 반영한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration promote-spec \
  --artifacts .plan2agent/artifacts/<project_id>
```

### 4. 변경분 task 만들기

빠른 deterministic 경로는 `diff-tasks`다. active spec과 baseline spec의 field 차이를 semantic group으로 병합/분할하고, 이전 완료 task와 겹치면 `Rework` task로 표시한 `task-graph.draft.json`을 만든다.

```bash
node .plan2agent/scripts/p2a.mjs iteration diff-tasks \
  --artifacts .plan2agent/artifacts/<project_id>
```

복잡한 task graph를 agent가 저작하게 하려면 context를 뽑는다.

```bash
node .plan2agent/scripts/p2a.mjs iteration context \
  --artifacts .plan2agent/artifacts/<project_id> \
  > task-context.json
```

`diff-tasks` 또는 agent가 만든 `task-graph.draft.json`을 검증하고, 사람이 승인한 뒤 Gate C approval audit을 `current-spec.json`에 기록하며 정본으로 승격한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

node .plan2agent/scripts/p2a.mjs iteration promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by user \
  --approval-note "Reviewed and approved the Gate C draft task graph."
```

### 5. 대상 프로젝트로 인계

Gate B-D가 통과된 artifact를 대상 프로젝트로 넘긴다.

```bash
node /path/to/plan2agent/scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --include-intake \
  --tools codex,claude,gemini
```

대상 프로젝트에는 다음이 설치된다.

```text
  .plan2agent/
    artifacts/
      spec.json
      task-graph.json
      review.json
      status.md
    current-spec.json
    manifest.json
    project.config.json
    proposals/      # p2a_proposals mine/review/curate/draft-patch/approve-draft 실행 시 생성
    scripts/
      p2a_paths.mjs
      p2a_project_config.mjs
      p2a_iteration.mjs
      p2a_tasks.mjs
      p2a_runs.mjs
      p2a_execute.mjs
      p2a_orchestrate.mjs
      p2a_proposals.mjs
      p2a_run_paths.mjs
      p2a_iteration_state.mjs
      validate_artifacts.mjs
    schemas/
      *.schema.json
```

Team Big Five adapter도 함께 설치할 수 있다.

```bash
node /path/to/plan2agent/scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts .plan2agent/artifacts/<project_id> \
  --target ../target-project \
  --tools codex,claude,gemini \
  --include-team-bigfive \
  --team-bigfive-source /path/to/team-bigfive \
  --team-bigfive-targets all
```

## 대상 프로젝트에서 개발하기

Co-located scaffold 프로젝트라면 Gate D 통과 후 먼저 `p2a.mjs iteration init`을 실행하고 `--artifacts .plan2agent/artifacts/<project_id>`를 사용한다. 아래 `--graph` 예시는 이미 승인 산출물을 별도 대상 프로젝트로 옮긴 legacy handoff 흐름에서 명시 graph를 사용할 때의 형태다.

인계 후 대상 프로젝트에서 ready task 실행 계획을 확인한다.

```bash
cd ../target-project

node .plan2agent/scripts/p2a.mjs execute plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001
```

복수 agent 역할이나 monitor gate가 필요한 task는 실행 전에 오케스트레이션 계획을 만들 수 있다.

```bash
node .plan2agent/scripts/p2a.mjs orchestrate plan \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --output .plan2agent/orchestration/task-001.json

node .plan2agent/scripts/p2a.mjs orchestrate handoff \
  --plan .plan2agent/orchestration/task-001.json

node .plan2agent/scripts/p2a.mjs orchestrate runner-guide \
  --plan .plan2agent/orchestration/task-001.json \
  --role implementer

node .plan2agent/scripts/p2a.mjs orchestrate runner-doctor \
  --root . \
  --provider all

node .plan2agent/scripts/p2a.mjs orchestrate runner-doctor \
  --root . \
  --provider codex \
  --live
```

`runner-guide`는 선택 provider의 공식 foreground 기능을 어떻게 쓰면 되는지 보여주는 안내다. `runner-doctor`는 현재 프로젝트에 필요한 provider 자산과 `.plan2agent/project.config.json.providerNativeCapabilities`의 수동 capability evidence를 파일만 읽어 확인한다. `--live`를 명시하면 provider `--version`만 실행해 CLI 존재와 버전 출력만 확인한다. 둘 다 agent session을 열지 않고, owner가 공식 CLI/앱을 직접 열어 prompt를 붙여넣는 전제를 유지한다. 붙여넣은 foreground 세션 안에서 provider-native skill/subagent/custom agent/agent team을 쓰는 것은 허용되는 감독형 자동화다.

blocked runtime에서는 `node .plan2agent/scripts/p2a.mjs orchestrate failure-policy --runtime <runtime-path>`로 다음 조치를 `retry`, `ask_user`, `stop` 중 하나로 확인한다. 이 명령도 후속 조치만 계산하며 provider CLI나 재시도 run을 자동으로 시작하지 않는다.

task를 시작하고 run log를 연다. 출력되는 manual launcher prompt를 Codex/Claude 같은 감독형 agent 세션에 붙여넣는다. 오케스트레이션 계획을 만들지 않았다면 `--orchestration-plan` 옵션은 빼고 실행한다. 이 옵션을 넘기면 `runs/<runId>.orchestration.json`과 `runs/<runId>.orchestration-runtime.json`이 함께 생성된다.

```bash
node .plan2agent/scripts/p2a.mjs execute start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --orchestration-plan .plan2agent/orchestration/task-001.json \
  --workspace . \
  --workspace-ref target-project
```

구현 후 검증, run finish, task done/block 전이를 한 번에 처리한다.

```bash
node .plan2agent/scripts/p2a.mjs execute finish \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --run-id run-... \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

실패, blocked monitor verdict, verification 누락 같은 실행 회고가 쌓이면 개선 proposal 큐를 만든다.

```bash
node .plan2agent/scripts/p2a.mjs proposals mine \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

node .plan2agent/scripts/p2a.mjs proposals digest \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a.mjs proposals review \
  --proposals .plan2agent/proposals

node .plan2agent/scripts/p2a.mjs proposals curate \
  --review .plan2agent/proposals/reviews/proposal-review-<hash>.json

node .plan2agent/scripts/p2a.mjs proposals draft-patch \
  --curation .plan2agent/proposals/curations/proposal-curation-<hash>.json \
  --candidate-id candidate-<hash>

node .plan2agent/scripts/p2a.mjs proposals approve-draft \
  --draft .plan2agent/proposals/patch-drafts/proposal-patch-draft-<hash>.json \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approved-by <name>
```

`approve-draft`는 대상 파일을 자동 수정하지 않는다. 승인 기록을 남기고 maintenance task graph에 후속 실행 task를 추가한다.

승인된 proposal은 approval artifact로 바로 실행 흐름에 넘길 수 있다. task id를 다시 찾지 않아도 `p2a.mjs execute`가 maintenance task를 확인한다.

```bash
node .plan2agent/scripts/p2a.mjs execute plan \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json

node .plan2agent/scripts/p2a.mjs execute start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json \
  --agent-tool codex
```

세부 제어가 필요하면 저수준 명령을 직접 사용할 수 있다.

```bash
node .plan2agent/scripts/p2a.mjs tasks ready \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json

node .plan2agent/scripts/p2a.mjs tasks prompt \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  task-001

node .plan2agent/scripts/p2a.mjs runs start \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  --task task-001 \
  --agent-tool codex \
  --workspace . \
  --workspace-ref target-project \
  --isolation branch \
  --branch p2a/task-001

node .plan2agent/scripts/p2a.mjs runs verify \
  --run-id run-... \
  --test \
  --lint \
  --typecheck

node .plan2agent/scripts/p2a.mjs runs finish \
  --run-id run-... \
  --collect-git \
  --status finished

node .plan2agent/scripts/p2a.mjs tasks done \
  --graph .plan2agent/artifacts/<project_id>/gate-c-task-graph/task-graph.json \
  task-001
```

`runs finish --status finished`와 `tasks done`은 verification evidence가 모두 `passed`일 때만 성공한다. 테스트 명령을 자동 감지하지 못해 `skipped`/`not_run`이 기록된 run은 성공 완료 증거로 쓰지 않는다. 그 run은 `failed`/`blocked`로 닫고, 프로젝트 설정이나 검증 명령을 고친 뒤 새 run에서 `passed` verification을 남긴다.

## Maintenance task

작은 fix나 문서 수정처럼 Gate A-D 전체 반복을 열기 애매한 일은 maintenance graph에 추가한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration maintenance add \
  --artifacts .plan2agent/artifacts/<project_id> \
  --title "Fix typo in API docs" \
  --accept "Typo is corrected." \
  --ref effective_product.problem
```

maintenance task만 조회하려면 `--maintenance`를 붙인다.

```bash
node .plan2agent/scripts/p2a.mjs tasks ready \
  --artifacts .plan2agent/artifacts/<project_id> \
  --maintenance
```

반복 handoff 시 `task-graph.sourceSpec`은 `spec.json`으로, `spec.source_intake`는 `intake.json`으로 rebase되고, `intake.json`은 traceability 검증을 위해 항상 `.plan2agent/artifacts/`에 함께 복사된다. `--include-intake`는 generated `intake.md`가 있을 때 추가 복사만 제어한다. maintenance graph가 있으면 active graph와 병합하지 않고 `.plan2agent/maintenance/task-graph.json`으로 별도 복사된다.

## 어떤 파일을 봐야 하나

| 파일 | 언제 보는가 |
| --- | --- |
| `.plan2agent/artifacts/<project_id>/status.md` | generated 진행상태 view 확인 |
| `.plan2agent/artifacts/<project_id>/current-spec.json` | 현재 effective spec과 active iteration 기준 확인 |
| `iterations/<iter-id>/gate-b-spec/spec.json` | 승인된 제품/구현 spec의 구조화 원본 확인 |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.json` | 실행 가능한 task와 dependency 확인 |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.meta.json` | draft task graph provenance 확인 |
| `runs/run-index.json` | task별 runId 목록과 latest run 확인 |
| `runs/<runId>.json` | agentTool, workspaceRef, changedFiles, verification 확인 |
| `proposals/<proposalId>.json` | run 회고에서 나온 skill/agent/CLI 개선 후보 확인 |
| `proposals/reviews/<reviewId>.json` | proposal 그룹, 빈도, risk, recommended disposition 확인 |
| `proposals/curations/<curationId>.json` | 승인 후보 readiness, priority, evidence strength 확인 |
| `proposals/patch-drafts/<draftId>.json` | 사람 승인 전 변경 의도, 대상 파일, 검증 계획 확인 |
| `.plan2agent/manifest.json` | handoff에서 대상 프로젝트에 설치된 파일 목록 확인 |
| `.plan2agent/project.config.json` | 감지/저장된 test/lint/typecheck command와 run tracking 기본값 확인 |

## 검증 체크리스트

작업 전후 자주 쓰는 검증 명령:

Plan2Agent 본체 저장소에서 fixture나 CLI mirror를 바꾼 경우:

```bash
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
git diff --check
```

반복 artifact 검증:

```bash
node .plan2agent/scripts/p2a.mjs iteration validate \
  --artifacts .plan2agent/artifacts/<project_id>
```

close 가능 여부 확인:

```bash
node .plan2agent/scripts/p2a.mjs iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready
```

run log 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --runs-dir .plan2agent/artifacts/<project_id>/runs
```

proposal queue 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --proposals-dir .plan2agent/artifacts/<project_id>/proposals
```

proposal review 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-review .plan2agent/artifacts/<project_id>/proposals/reviews/proposal-review-<hash>.json
```

proposal curation 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-curation .plan2agent/artifacts/<project_id>/proposals/curations/proposal-curation-<hash>.json
```

proposal patch draft 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-patch-draft .plan2agent/artifacts/<project_id>/proposals/patch-drafts/proposal-patch-draft-<hash>.json
```

proposal draft approval 검증:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --proposal-draft-approval .plan2agent/artifacts/<project_id>/proposals/approvals/proposal-draft-approval-<hash>.json
```

대상 프로젝트 handoff 준비 상태:

```bash
node .plan2agent/scripts/validate_artifacts.mjs \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready
```

## 운영 원칙

- 승인 전 산출물을 다음 gate 입력으로 쓰지 않는다.
- `task-graph.json` schema는 실행 상태만 담고, agent 실행 결과는 `runs/` sidecar에 둔다.
- 반복은 append-only에 가깝게 보존하고, 변경/누락/재작업은 새 반복의 task로 남긴다.
- `diff-tasks`는 deterministic draft generator이고, 복잡한 task 저작은 `context`와 agent-authored draft gate를 사용한다. 두 경로 모두 `promote-tasks` 승인 후에만 정본이 된다.
- `handoff`는 파일과 실행 도구를 복사하지만 agent를 자동 실행하지 않는다.
- `p2a_runs verify --test` 같은 검증 명령은 `project.config.json`이 비어 있으면 현재 workspace를 다시 감지해 기본 명령을 저장한다.
- `p2a_runs --create-isolation`을 쓰기 전에는 git branch/worktree 생성 정책을 확인한다.
- `p2a_proposals`는 개선 후보만 만들고, skill/agent/schema 적용은 사람 승인 후 별도 변경으로 처리한다.

## 빠른 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `task graph generation is blocked` | Gate B spec의 `approval`과 `open_decisions` |
| `Gate C approval audit required in current-spec.json` | `promote-tasks --approved-by ... --approval-note ...` 또는 `current-spec.json.gate_c_approval_audits` 기록 여부 |
| `open requires ... archived` | 이전 반복을 `close`했는지 |
| `run-index ... does not match run file` | `runs/run-index.json`과 `runs/<runId>.json`을 수동 편집하지 않았는지 |
| handoff 대상에서 test/lint/typecheck가 안 잡힘 | `--test-command <cmd> --save-config`처럼 명시 명령을 저장할지 |

## 다음에 볼 문서

- [CLI 사용자 가이드](cli-reference.md) — 명령별 사용법과 옵션 예시
- [하네스 사용자 가이드](harness-guide.md) — Gate A-D 산출물 계약과 schema 설명
- [반복/고도화 개발 스펙](iteration-spec.md) — 반복 구조, close/open, semantic diff, run tracking 계약
- [하네스 구현 기준](harness-spec.md) — skill/subagent 역할과 구현 원칙
