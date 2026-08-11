# 감독형 개발 실행 레퍼런스

작성일: 2026-08-05 · 상태: 완료 기능 레퍼런스

이 문서는 과거 개발 실행 계층 계획을 완료 기능 기준으로 정리한 문서다. 세부 작업 이력과 단계별 구현 계획 대신, 현재 사용자가 알아야 할 운영 계약만 이 문서와 [CLI 사용자 가이드](cli-reference.md)에 남긴다.

## 1. 현재 결론

Plan2Agent는 Gate A-C planning harness 이후, 승인된 ready task 1건 또는 한 ready snapshot의 bounded batch를 사람이 감독하는 foreground agent 세션으로 실행하고 결과를 task별 파일 기반 run log로 추적하는 흐름을 제공한다.

완료된 범위:

| 영역 | 구현 |
| --- | --- |
| task/run tracking | `p2a tasks`, `p2a runs`, run/run-index schema |
| 감독형 단일 task 실행 | `p2a execute plan/start/resume/status/finish` |
| 감독형 ready batch | `p2a-dev-execution` owner가 직렬 start, 격리 worktree 병렬 구현, 직렬 로컬 통합·검증·finish를 조율 |
| 감독형 orchestration | `p2a execute start --require-monitor/show/validate/handoff/next-role/role-prompt/mark-role/failure-policy` |
| runtime sidecar | `runs/<iterationId>/<runId>.orchestration.json`, `runs/<iterationId>/<runId>.monitor-gate.json`, 위반이 있을 때만 생성하는 `.style-verdict.json` |
| monitor gate | 기본 `opt_in`. `--require-monitor`로 시작한 run만 `p2a-performance-monitor`와 monitor verdict 기반 finish 차단 |
| milestone review | 기본 `off`. 활성화한 경우에만 `p2a-milestone-reviewer`가 완료된 task 범위의 통합 결함을 중간·종료 직전에 비차단 검토 |
| Hermes proposal loop | `p2a proposals mine/review/curate/draft-patch/approve-draft/digest` |
| provider-native guide | Codex, Claude, Gemini용 role prompt와 capability evidence |

이 실행 계층은 여러 agent를 무인으로 돌리는 scheduler가 아니다. P2A는 ready task, role, prompt, runtime 상태, monitor gate, proposal artifact를 조율하고, 실제 agent CLI/앱 세션은 사용자가 foreground에서 열어 감독한다. Batch mode도 같은 foreground 세션 안에서 provider-native write subagent를 bounded하게 병렬 실행할 뿐, start·통합·검증·finish 소유권은 main owner에게 남는다.

### 리뷰 패스 정책

`.plan2agent/project.config.json`의 `devExecution.reviewPasses`가 비용이 큰 독립 리뷰 패스의 진입을 제어한다. 허용 값은 모든 키에서 `off`, `opt_in`, `on`뿐이며, 설정하지 않은 키는 아래 기본값을 사용한다.

| 키 | 기본값 | 진입 조건 |
| --- | --- | --- |
| `monitor` | `opt_in` | `opt_in`에서는 `p2a execute start --require-monitor`로 시작한 run만 진입한다. `off`이면 신규 run을 opt-in할 수 없다. |
| `style` | `off` | `off`이면 `p2a-style-rater`를 호출하지 않고 run에 `STYLE_REVIEW: skipped; reason=reviewPasses.style=off`를 기록한다. |
| `milestone` | `off` | `off`가 아니면서 `done >= ceil(total / 2)`인 midpoint 또는 `done == total`인 pre-close 시점에만 진입한다. |
| `visual` | `off` | `off`이면 최종 시각 리뷰 절차 전체를 건너뛰고 `p2a execute review` run을 열지 않는다. |
| `acceptance` | `on` | 비UI iteration의 모든 task가 완료되면 실제 명령 증거를 요구하는 `p2a execute accept` run을 연다. `off`이면 기존처럼 이 게이트를 생략한다. |

예를 들어 프로젝트별로 monitor opt-in을 유지하면서 style과 milestone 리뷰를 활성화하려면 다음처럼 설정한다.

```json
{
  "devExecution": {
    "reviewPasses": {
      "monitor": "opt_in",
      "style": "on",
      "milestone": "on",
      "visual": "off",
      "acceptance": "on"
    }
  }
}
```

미지 키나 허용 목록 밖의 값은 설정 오류로 거부된다. 리뷰 패스를 `off`로 두는 것은 해당 리뷰 아티팩트의 **생성을 생략할 수 있게 하는 것**이지 검증 코드를 제거하는 것이 아니다. 관련 아티팩트가 존재하면 `validate_artifacts.mjs`가 계속 schema와 참조 무결성을 검증하며, 아티팩트가 없을 때만 비활성 정책에 따라 통과한다.

현재 적용값은 다음 명령의 `reviewPasses=monitor:opt_in,style:off,milestone:off,visual:off,acceptance:on` 형태 출력으로 확인한다.

```bash
p2a doctor --dev
```

#### 개발 중 사용자 시각 검수

`reviewPasses.visual`의 iteration 최종 게이트와 별개로, UI task는 일반 구현 run을 열어 둔 채 사용자 시각 검수를 반복한다.

```text
p2a execute start <task>     # 일반 구현 run, task in_progress
  → 구현
  → 사용자 시각 검수 → drift 수정 → 재검수 (필요한 만큼 반복)
  → 만족
p2a execute finish           # task-level 시각 검수 통과 지점
```

일반 구현 run은 `changedFiles`를 전제하므로 이 반복 중 같은 할당 workspace에서 계속 수정해도 된다. Workspace 불변과 빈 `changedFiles` 제약은 `final_visual_review`와 `final_acceptance_review` run에만 적용된다. 이 task-level 루프는 비게이팅·무기록이며 추가 review run, sidecar, screenshot hash, verdict를 만들지 않고 iteration 최종 `confirm_ui`를 대체하지도 않는다. `finish` 후에 시각 문제를 발견한 경우에만 `p2a tasks todo <id> --reopen --note <reason>`으로 task를 다시 연 뒤 수정한다.

## 2. 감독형 자동화 경계

허용:

- 사용자가 공식 Codex/Claude/Gemini CLI 또는 앱을 foreground로 열고 P2A가 출력한 prompt를 붙여넣는다.
- 해당 foreground 세션 내부에서 provider-native skill, subagent, custom agent, agent team, extension을 사용한다.
- 한 ready snapshot에서 독립 task를 고르고, 동일 write-capable provider의 격리 worktree implementer를 bounded하게 병렬 실행한다.
- 사용자가 승인한 canonical integration branch/worktree에 main owner가 결과를 하나씩 로컬 통합하고 통합 상태를 검증한다.
- P2A는 role prompt, next role, monitor gate, run state, proposal state를 파일로 기록한다.
- 결과는 사용자가 확인한 뒤 `p2a execute finish`, run 옆 monitor verdict sidecar 기록, `p2a proposals approve-draft` 같은 명시적 단계로 기록한다.

제외:

- P2A가 SDK/API로 provider를 직접 호출하는 방식.
- Codex/Claude/Gemini CLI를 background/headless로 무인 실행하는 방식.
- browser loop, 세션 쿠키/토큰 재사용, 계정 로테이션, rate limit 우회.
- 여러 provider가 같은 파일을 동시에 수정하는 mixed-provider implementation.
- 자동 충돌 해결, dirty worktree 강제 삭제, 파괴적 reset.
- approval 없는 patch 적용, PR 생성, push, remote merge.

## 3. Provider 전략

기본값은 single-provider supervised team이다.

| Provider | 역할 |
| --- | --- |
| Codex | skills/custom agents/명시 subagent prompt 기반 구현 후보. workspace-write 구현 agent 계약을 제공한다. |
| Claude | write-capable implementer mirror와 deterministic confinement를 제공한다. foreground 사람 승인 기준으로 사용한다. |
| Gemini | read-only planning/review/monitor 보조. write-required role에는 배정하지 않는다. |
| Manual | provider-native 기능이 없거나 위험한 경우 사람이 직접 실행하고 결과만 기록한다. |

P2A는 provider capability matrix와 role profile을 바탕으로 implementer, reviewer, monitor role을 배정한다. 계정 내부 team/subagent/extension 자동 introspection은 비목표이며, provider CLI의 설치·버전 확인과 foreground 실행은 owner가 직접 수행한다.

Batch write는 Codex 또는 foreground 승인·confinement가 충족된 Claude처럼 write-capable subagent를 별도 worktree에 가둘 수 있을 때만 사용한다. Gemini는 read-only 정책을 유지하며, write 요청은 ready task 또는 frozen batch context를 write-capable foreground owner에게 handoff한다. 안전한 병렬 write capacity가 1인 write-capable provider만 기존 단건 흐름으로 fallback한다.

## 4. 표준 실행 흐름

1. ready task 확인:

```bash
p2a tasks ready --artifacts .plan2agent/artifacts/<project>
```

2. 단일 task 실행 계획 확인:

```bash
p2a execute plan \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id>
```

3. monitor gate가 필요한 run 시작:

```bash
p2a execute start \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id> \
  --agent-tool codex \
  --require-monitor
```

4. 사람이 foreground agent 세션에서 prompt를 실행하고 결과를 확인한다.

5. 독립 monitor 결과를 run 파일 옆의 `.monitor-verdict.json` sidecar에 기록한다. 예를 들어 run ref가 `runs/<iteration-id>/<run-id>.json`이면 verdict 경로는 `runs/<iteration-id>/<run-id>.monitor-verdict.json`이다. 이 파일은 CLI 명령으로 임의 생성하는 대신, foreground 실행 owner가 §6의 표준 JSON shape으로 작성한다.

   `full + current_iteration` task는 `workKind`와 `visualImpact.screenStates`로 UI 영향 범위만 명시한다. 일반 구현 run은 기능 검증과 §1의 사용자 시각 검수 반복을 모두 통과한 뒤 끝내며 visual sidecar를 요구하지 않는다. 필수 검수 반복 자체는 `visualFeedback`이나 별도 review evidence로 기록하지 않는다. `reviewPasses.visual`이 `off`가 아니면 모든 task를 통합한 뒤 `p2a execute review --artifacts <root>`로 iteration당 하나의 `runKind: final_visual_review` run을 연다. 이 run은 Gate B에서 전체 승인 screen/state/viewport/접근성 계약을 직접 가져오고 canonical workspace, isolation 없음, 변경 파일 없음을 강제한다. `p2a runs revision`으로 application workspace snapshot SHA-256을 계산한 뒤 실제 앱의 정확한 크기 PNG와 `p2a.visual_accessibility_report.v1` 보고서를 만들고, 파일 SHA-256·capture metadata·`iteration_id`·workspace identity/revision과 승인된 experience/prototype 비교 결과를 `.visual-review.json`에 기록한다. Sidecar에는 task ownership을 기록하지 않으며 run의 task id는 실패 시 remediation pointer로만 사용한다. Workspace snapshot은 symlink file target의 실제 bytes를 포함하되 제외 디렉터리를 symlink alias로 다시 포함하지 않으며, workspace 밖의 directory symlink는 거부한다. Review finish는 sidecar revision을 현재 workspace와 비교하고 정확한 sidecar 바이트를 `visualReviewEvidenceSha256`으로 봉인한다. Run-directory/close-ready/`p2a next`는 이 단일 최종 run의 revision과 digest를 재검증한다. Review가 failed/blocked면 remediation owner task를 `todo`로 reopen한 뒤 구현과 최종 review를 반복한다.

   비UI iteration은 기본 `reviewPasses.acceptance: on`에서 모든 task 통합 뒤 `p2a execute accept --artifacts <root> --agent-tool <reviewer>`를 실행한다. 이 명령은 Gate B `product.core_flows`와 `product.success_criteria`를 계약으로 고정한 `final_acceptance_review` run을 canonical workspace, isolation 없음, 변경 파일 없음으로 연다. Owner가 각 동작을 `p2a runs verify --verify-command 'custom:<command>'`로 실제 실행하고, read-only `p2a-acceptance-reviewer`가 run verification과 일치하는 `command`·`source: command|config`·정수 `exitCode`·`stdoutTail`을 `.acceptance-review.json`에 기록한다. exit 0이어도 출력이 비어 있거나 의미 없는 결과면 `block`이다. 모든 기준이 실제 동작으로 확인된 `confirm_behavior`만 finish할 수 있고 exact sidecar hash와 canonical workspace revision이 run에 봉인된다. 이후 workspace 변경은 새 acceptance review를 요구한다.

6. 검증과 finish:

```bash
p2a execute finish \
  --run-id <run-id> \
  --artifacts .plan2agent/artifacts/<project> \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

자세한 옵션은 [CLI 사용자 가이드](cli-reference.md)의 `p2a execute`, monitor gate, `p2a proposals` 섹션을 기준으로 삼는다.

### 4.1 감독형 ready batch

`p2a-dev-execution` batch mode는 신규 batch CLI나 batch run을 만들지 않는다. 모든 task는 기존 단건 CLI와 고유 run id를 그대로 사용한다.

1. main owner가 `p2a tasks ready` 결과를 ready snapshot으로 고정하고 동시성 상한 안에서 batch를 선택한다. 같은 파일, 공유 설정, DB schema, API 계약처럼 알려진 integration surface가 겹치면 batch에서 제외하거나 concurrency를 1로 낮춘다.
2. committed canonical integration head를 `batchBase`로 정하고, task마다 같은 base의 fresh branch/worktree를 만든다. `p2a execute start`는 main이 task별로 직렬 호출한다.
3. task별 `p2a-implementer`는 자기 worktree에서 파일 편집과 self-check만 병렬 수행한다. lifecycle, harness, 다른 worktree, canonical integration 상태는 수정하지 않는다.
4. main이 완료 결과를 하나씩 scope 검토하고 task별 changed-file 목록을 동결한 뒤 reproducible commit 또는 patch로 만든다.
5. 최신 canonical integration head에서 integration candidate를 만들고 결과를 적용한다. 충돌을 자동 해결하지 않으며, task worktree 검증과 별개로 candidate에서 필수 verification을 실행한다.
6. integration base/ref/workspace를 `INTEGRATION:` run note로 남기고 task별 changed files를 명시 기록한다. 누적 integration worktree의 전체 git status를 한 task에 귀속하지 않는다.
7. 충돌이 없고 필수 verification이 통과했으며 필요한 monitor gate가 acceptance를 확인한 candidate만 canonical integration branch에 반영한다. style-rating은 적용 대상이면 실행하고 기록하되, 기존 계약처럼 정보성 근거로만 남기고 canonical 반영이나 `done`/`blocked` 판단을 직접 차단하지 않는다. 그 뒤에만 `p2a execute finish`로 run을 `finished`, task를 `done`으로 전이한다.
8. batch harvest 후 `ready`를 다시 계산하고 다음 batch worktree는 최신 canonical integration head에서 시작한다.

spawn, scope, integration, verification 또는 monitor가 실패한 task는 canonical integration branch를 전진시키거나 `done` 처리하지 않는다. 기존 structured failure contract로 `blocked`/`failed` 처리하거나 사용자 결정이 필요하면 active로 유지한다. 다른 독립 task의 직렬 harvest는 계속할 수 있다.

dirty, unmerged, failed, blocked task 또는 integration-candidate worktree는 자동 제거하지 않는다. 결과가 canonical integration branch와 run evidence에 durable하게 남은 accepted worktree만 사용자 확인 또는 승인된 cleanup 정책에 따라 정리할 수 있다.

## 5. Run과 orchestration artifact

정본 파일:

| 파일 | 역할 |
| --- | --- |
| `.plan2agent/artifacts/<project>/runs/run-index.json` | run 목록과 최신 상태 index |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.json` | task 실행 기록, changedFiles, verification, failureClass |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.orchestration.json` | 실행 당시 monitor gate snapshot |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.monitor-gate.json` | shared mental model, role assignment, communication log, runtime phase |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.style-verdict.json` | `violationCount > 0`인 style review 근거. 0건·미적용·생략은 run note에 기록하고 파일은 만들지 않음 |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.visual-review.json` | iteration 최종 review run의 실제 렌더링·접근성 증거와 `confirm_ui|block` verdict. 해당 review run의 성공 finish를 차단함 |
| `.plan2agent/artifacts/<project>/visual-evidence/<iterationId>/<runId>/` | visual review가 참조하는 실제 앱 screenshot과 접근성 보고서. run store 밖에 두어 run-index/migration 계약과 분리함 |
| `.plan2agent/artifacts/<project>/iterations/<iteration-id>/milestone-reviews/{midpoint,pre_close}.json` | 완료 task의 run evidence를 포함하는 checkpoint별 비차단 통합 리뷰 |
| `.plan2agent/proposals/*.json` | 실행 회고 기반 개선 후보 |
| `.plan2agent/proposals/reviews/*.json` | proposal deterministic review |
| `.plan2agent/proposals/curations/*.json` | proposal grouping/prioritization |
| `.plan2agent/proposals/patch-drafts/*.json` | 적용하지 않는 patch draft |
| `.plan2agent/proposals/approvals/*.json` | 사람이 승인한 proposal draft와 maintenance task 연결 |

Task에는 가벼운 `visualImpact`만 두고, 전체 승인 계약은 최종 review run의 `visualReview`에 한 번만 materialize한다. 화면별 실제 렌더링 결과와 접근성 판정은 그 run의 sidecar로 분리한다.

## 6. Monitor gate와 failure policy

monitor gate가 필요한 run은 monitor verdict 없이 `done`으로 닫지 않는다.

표준 verdict shape:

```json
{
  "verdict": "confirm_done",
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "needs_user_decision": [],
  "note": ""
}
```

허용되지 않은 verdict, verification 실패, scope drift가 있으면 run은 blocked 또는 failed 상태로 닫고, `p2a proposals mine` 또는 `p2a proposals mine`으로 후속 조치를 만든다. 여러 concern 배열이 동시에 채워지면 failure class 매핑 우선순위는 `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`이다.

같은 task의 latest run이 `failed` 또는 `blocked`인 retry에서만 실행 owner는 task title, failure class, localization으로 같은 프로젝트 Memory를 한 번 조회할 수 있다. 보고서는 `<failed-run-id>.memory-recall.json`으로 보존하고, 재시도 run에는 `MEMORY_RETRY: sourceRun=<id>; report=<path>; applied=<mitigation or none>; status=<succeeded|fallback|failed|skipped>` note를 남긴다. 첫 시도에는 이 조회를 하지 않으며, 유사성이 없는 결과는 적용하지 않는다.

`p2a execute start/status/finish`와 직접 `p2a runs start/finish` 출력 footer에는 copy-paste 가능한 `resume`, `status`, `finish`, `review` 명령이 남는다. `resume`은 `p2a execute resume --run-id <run-id>`로 같은 run의 launcher prompt를 다시 출력하고, `review`는 `p2a proposals mine --run-id <run-id>`로 실행 회고 후보를 생성한다.

### 6.1 Milestone review

`reviewPasses.milestone !== 'off'`이고 midpoint 또는 pre-close 조건을 만족할 때만 이 절차에 진입한다. 각 task의 `p2a execute finish`가 task graph를 갱신한 뒤 checkpoint를 계산한다. `midpoint`는 `done >= ceil(total / 2)`이면서 아직 미완료 task가 있을 때 한 번, `pre_close`는 모든 task가 done인 뒤 close-ready 검증 직전에 한 번만 대상이 된다. 경로는 `iterations/<iteration-id>/milestone-reviews/midpoint.json`과 `pre_close.json`으로 고정하며 파일이 이미 있으면 검증만 하고 재실행하거나 덮어쓰지 않는다. midpoint 시점을 놓치고 이미 전부 done이면 midpoint를 소급 생성하지 않고 pre-close만 실행한다.

reviewer에는 전체 task 상태와 full `task_graph_snapshot`, raw/snapshot hash, 승인 spec, 프로젝트 style contract와 함께 **모든 완료 task**의 최신 성공 run을 전달한다. 각 evidence에는 `task_id`, run id, artifact-root-relative `runs/<run-index entry runRef>` ref(일반적으로 `runs/<iterationId>/<runId>.json`), raw run hash, full immutable `run_snapshot`과 deterministic snapshot hash, finished timestamp, 전체 `changedFiles`, 전체 verification 요약이 필요하고, task마다 적어도 하나의 실제 실행된 `config|command` 검증이 exit code 0으로 통과해야 한다. milestone 완료 근거는 Gate B/D를 검증하는 `--artifacts` 실행의 `sourceLayout: iteration` run만 인정한다. legacy flat graph의 `--graph` 실행은 `sourceLayout: graph`이며 milestone 근거로 승격되지 않는다. 관리형 iteration/maintenance graph를 `--graph`로 지정한 start/finish/task 전이는 Gate 우회를 막기 위해 거부된다. draft 검증 시 snapshot은 현재 run과 exact match해야 하며, 승격 뒤 finished run에 합법적인 `record`/`verify` 증거가 추가돼도 canonical checkpoint는 당시 snapshot으로 계속 검증된다. 하나라도 빠지면 부분 리뷰를 만들지 않고 skip 이유만 보고하며, 근거가 복구되면 아직 eligible한 checkpoint를 다시 시도한다.

새 run은 artifact root의 전역 `runs/run-index.json`과 iteration별 `runs/<iterationId>/<runId>.json`에 저장한다. run 파일과 index 갱신은 project run-store lock, atomic rename, 복구 journal을 사용하므로 동시 start의 lost update를 막고 중단된 commit은 다음 mutation에서 전진 복구한다. stale lock 회수도 별도 reaper lock으로 직렬화해 새 소유자의 lock을 이전 stale 판단으로 삭제하지 않는다. 기존 평면 `runs/<runId>.json` 이력은 계속 읽을 수 있으며, 이전 `--graph` 기본 위치였던 `iterations/<iterationId>/runs/`도 migration 입력으로 발견한다. `p2a runs migrate-layout --artifacts <artifact-root> --dry-run`으로 이동·병합 계획을 확인한 뒤 `--yes`로 정리할 수 있다. 마이그레이션은 source/target run store를 고정 순서로 잠그고 run, 알려진 sidecar, 소유 프로세스가 끝난 run ID 예약을 전역 runs로 이동한다. 살아 있는 start가 소유한 예약이 있으면 migration을 중단한다. migration journal을 확정한 즉시 legacy store에 `.run-store-redirect.json`을 남겨 이전 `--runs` 경로가 새 index를 재생성하지 못하게 한다. 프로세스가 중단되면 `.run-layout-migration` journal이 남으며 같은 `migrate-layout ... --yes` 명령으로 재개한 뒤 충돌 없는 단일 `run-index.json`을 확정하고 legacy index를 제거한다. Layout 정리와 별개로 `p2a runs migrate-schema --artifacts <artifact-root> --dry-run`은 source graph/spec provenance를 검증한 뒤 finished `p2a.run.v1` evidence에 immutable `taskContractSha256`을 계산해 v2 승격 계획을 보여준다. `--yes` 적용은 같은 run-store lock과 write journal을 사용하며 started/failed/blocked v1 이력은 자동 승격하지 않는다.

reviewer는 남은 `todo`/`in_progress`/`blocked` 작업과 대조한 뒤 완료 범위에서 확인된 실제 통합 결함만 stable finding id와 구조화 evidence를 가진 `confirmed_findings`로 반환하고, 계획된 미구현 항목은 담당 task id를 포함한 `planned_todo_not_findings`로 분리한다. main owner는 source envelope와 결과를 합쳐 `<checkpoint>.<unique-id>.draft.json`을 만들고 다음 단일 명령으로 검증과 원자 승격을 수행한다.

```bash
p2a iteration promote-milestone \
  --artifacts <artifact-root> \
  --draft <artifact-root>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json
```

CLI는 hard link의 create-if-absent 의미로 stable `<checkpoint>.json`을 원자 생성하고 성공한 unique draft만 삭제한다. 다른 프로세스가 먼저 stable 이름을 얻었다면 기존 파일을 덮어쓰지 않는다. maintenance 후보에는 `milestone-review:<artifact-path>#<finding_id>`를 출처로 남긴다. 이 JSON은 안정적인 informational source일 뿐 task 완료, run 상태, 반복 close를 직접 차단하지 않는다.

## 7. Proposal loop

Hermes식 자가 개선은 자동 self-modify가 아니라 approval 기반 maintenance flow다.

```bash
p2a proposals mine --artifacts .plan2agent/artifacts/<project>
p2a proposals review --proposals .plan2agent/proposals
p2a proposals curate --review .plan2agent/proposals/reviews/<review>.json
p2a proposals draft-patch --curation .plan2agent/proposals/curations/<curation>.json --candidate-id <candidate-id>
p2a proposals approve-draft --draft .plan2agent/proposals/patch-drafts/<draft>.json --artifacts .plan2agent/artifacts/<project> --approved-by user
```

승인된 proposal은 maintenance task로 연결한 뒤 일반 `p2a execute` 흐름으로 실행한다. proposal artifact 자체는 patch를 자동 적용하지 않는다.

## 8. 안전 정책

- Gate B spec이 approved이고 open decision이 없어야 한다.
- Gate C task graph가 validator를 통과해야 한다.
- ready task와 acceptance criteria가 있어야 한다.
- 실패한 verification을 숨기고 task를 `done` 처리하지 않는다.
- isolated worktree 결과가 승인된 canonical integration branch에 반영되기 전에 task를 `done` 처리하지 않는다.
- task scope 밖 변경 파일은 run note 또는 blocker로 남긴다.
- `.plan2agent/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/` 같은 harness/install 파일은 일반 application task의 수정 대상이 아니다.
- destructive cleanup, push, remote merge, PR 생성은 자동으로 하지 않는다. 승인된 batch mode의 로컬 integration만 main owner가 직렬 수행한다.

## 9. 후속 후보

현재 완료 기능 위에 남은 후보는 다음이다.

- agent-generated monitor gate.
- `p2a execute batch` 같은 persistent batch state/CLI UX.
- integration commit/patch와 verification workspace의 run schema provenance.
- conflict-aware batch planning과 target-path overlap hint.
- PR 생성과 리뷰 상태 연동.
- code-aware spec 역생성과 결과 diff 병합.
- Memory 서버 기반 cross-session recall, run/proposal 검색, failure trend 분석.
- `p2a doctor/info/update/upgrade` 같은 상위 명령면 정리.

일반 multi-provider 무인 scheduler와 API 기반 완전 자동 개발은 기본 로드맵의 우선순위에서 제외한다.
