# 승인 계약 기반 개발 실행 레퍼런스

작성일: 2026-08-05 · 상태: 완료 기능 레퍼런스

이 문서는 과거 개발 실행 계층 계획을 완료 기능 기준으로 정리한 문서다. 세부 작업 이력과 단계별 구현 계획 대신, 현재 사용자가 알아야 할 운영 계약만 이 문서와 [CLI 사용자 가이드](cli-reference.md)에 남긴다.

## 1. 현재 결론

Plan2Agent는 승인된 Gate B에서 `executionEnvelope`를 파생해 실행 AI가 구현·검증·수정을 자율적으로 소유하고 결과를 run log로 추적한다. 새 프로젝트는 `adaptive`를 기본으로 사용하며 `direct`, `planned`, `orchestrated` 모드를 지원한다. 과도기 Direct/Planned도 기존 lifecycle 호환을 위해 한 synthetic work item을 사용하지만 제품 의미의 정본은 Gate B다.

완료된 범위:

| 영역 | 구현 |
| --- | --- |
| task/run tracking | `p2a tasks`, `p2a runs`, run/run-index schema |
| Gate-derived envelope | 새 run에 objective, source Gate hash, scope, `mustPreserve`, non-goal, acceptance, verification, 권한 경계를 고정 |
| adaptive execution | project policy `adaptive|direct|planned|orchestrated`, mode/rationale 기록, Direct/Planned synthetic compatibility work item |
| planned checkpoint | 2–5개 ordered outcome과 실제 command verification, resume 안내, pending checkpoint finish 차단 |
| 감독형 단일 task 실행 | `p2a execute plan/start/resume/status/finish` |
| 감독형 ready batch | `p2a-dev-execution` owner가 직렬 start, 격리 worktree 병렬 구현, 직렬 로컬 통합·검증·finish를 조율 |
| 감독형 orchestration | `p2a execute start --require-monitor/show/validate/handoff/next-role/role-prompt/mark-role/failure-policy` |
| runtime sidecar | `runs/<iterationId>/<runId>.orchestration.json`, `runs/<iterationId>/<runId>.monitor-gate.json` |
| monitor gate | 기본 `opt_in`. `--require-monitor`로 시작한 run만 `p2a-performance-monitor`와 monitor verdict 기반 finish 차단 |
| Hermes proposal loop | `p2a proposals mine/review/curate/draft-patch/approve-draft/digest` |
| provider-native guide | Codex, Claude, Gemini용 role prompt와 capability evidence |

이 실행 계층은 범용 background scheduler가 아니다. 승인된 envelope 안의 start/resume/검증/필수 review는 task별 추가 승인을 요구하지 않지만 iteration close는 별도 사용자 선택을 요구한다. 모든 task와 필수 review가 끝나면 `iteration_review_or_close_required`가 구조화된 review/close 옵션을 반환한다. Review finding은 반환된 remediation template으로 owning done task를 reopen하고 정상 run lifecycle로 수정하며, 깨끗한 리뷰도 같은 선택 상태로 돌아온다. Close는 사용자가 close 옵션을 명시적으로 선택한 경우에만 실행한다. Codex workspace-write 또는 Claude scaffold/OS confinement 안에서 실행 AI가 같은 session의 구현 loop를 계속 소유하며, 외부 write·비용·credential·배포·불가역 동작만 별도 사용자 authorization을 요구한다.

Direct와 일반 단일-owner Planned 실행은 현재 foreground owner가 현재 workspace에서 직접 수행하고 `runTracking.defaultIsolation`을 따른다. 기본 격리는 `none`이며, 별도 implementer·worktree·병렬 owner는 Orchestrated/batch, 명시 정책, 동시 write owner 또는 구체적인 격리·rollback 위험이 있을 때만 사용한다.

### 리뷰 패스 정책

`.plan2agent/project.config.json`의 `devExecution.reviewPasses`가 비용이 큰 독립 리뷰 패스의 진입을 제어한다. 허용 값은 모든 키에서 `off`, `opt_in`, `on`뿐이며, 설정하지 않은 키는 아래 기본값을 사용한다.

| 키 | 기본값 | 진입 조건 |
| --- | --- | --- |
| `monitor` | `opt_in` | `opt_in`에서는 `p2a execute start --require-monitor`로 시작한 run만 진입한다. `off`이면 신규 run을 opt-in할 수 없다. |
| `visual` | `off` | 추가 독립 visual reviewer 강도를 조정한다. 승인 visual contract가 요구하는 owner render evidence와 close gate는 이 값으로 끌 수 없다. |
| `acceptance` | `opt_in` | 일반 비UI iteration은 task verification으로 닫는다. 사용자가 독립 기능 검수를 요청해 `p2a execute accept`를 시작했거나 값을 `on`으로 설정한 경우에만 실제 명령 증거를 요구한다. 시작된 acceptance run은 완료 전까지 close gate로 유지된다. |

기본 비용을 유지하면서 monitor와 acceptance를 모두 opt-in으로 두려면 다음처럼 설정한다.

```json
{
  "devExecution": {
    "executionMode": "adaptive",
    "reviewPasses": {
      "monitor": "opt_in",
      "visual": "off",
      "acceptance": "opt_in"
    }
  }
}
```

새로 생성하는 project config의 `executionMode` 기본값은 `adaptive`다. 기존 config에 이 필드가 없으면 historical 동작을 보존하기 위해 `orchestrated`로 해석하며, 기록된 `direct`, `planned`, `orchestrated`, `adaptive` 값은 그대로 유지한다. `adaptive`는 실행 AI가 Gate B와 repository를 조사해 mode를 선택한다. Mode 선택과 checkpoint는 추가 사용자 승인 Gate가 아니다.

미지 키나 허용 목록 밖의 값은 설정 오류로 거부된다. Phase 0 project에 이미 기록된 `style`/`milestone` 설정과 sidecar는 읽기 호환되지만 새 실행은 별도 reviewer를 만들지 않는다. Style은 단일 monitor rule contract가 검사하고 통합 acceptance는 기능/시각 close evidence가 담당한다.

현재 적용값은 다음 명령의 `reviewPasses=monitor:opt_in,visual:off,acceptance:opt_in` 형태 출력으로 확인한다.

```bash
p2a doctor --dev
```

#### 개발 중 자동 시각 검수

UI task는 일반 구현 run을 열어 둔 채 실행 owner가 영향 route/state/viewport를 실제 렌더링하고 시각 drift를 자율적으로 수정한다. 사용자에게 task별 시각 승인을 요청하지 않는다. 승인된 필수 visual contract가 있으면 이 반복과 별개로 iteration 최종 render evidence가 항상 필요하다.

```text
p2a execute start <task>     # 일반 구현 run, task in_progress
  → 구현
  → owner render/review → drift 수정 → 재검증 (필요한 만큼 반복)
  → 영향 화면 통과
p2a execute finish           # task 구현·검증 완료
```

일반 구현 run은 `changedFiles`를 전제하므로 이 반복 중 같은 할당 workspace에서 계속 수정해도 된다. Workspace 불변과 빈 `changedFiles` 제약은 `final_visual_review`와 `final_acceptance_review` run에만 적용된다. 이 task-level 루프는 비게이팅·무기록이며 추가 review run, sidecar, screenshot hash, verdict를 만들지 않고 iteration 최종 `confirm_ui`를 대체하지도 않는다. Contract 변경이 필요할 때만 Gate B로 돌아가며, `finish` 후 시각 문제를 발견한 경우에는 `p2a tasks todo <id> --reopen --note <reason>`으로 task를 다시 연 뒤 수정한다.

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

Gate B가 승인됐지만 Gate C가 아직 없고 execution mode가 `adaptive|direct|planned`이면 `p2a next`가 `p2a-dev-execution --prepare-mode <policy>`를 반환한다. 실행 AI는 별도 승인 질문 없이 mode를 선택하고 Direct 또는 Planned 호환 레코드를 준비한다.

```bash
p2a execute prepare --artifacts .plan2agent/artifacts/<project> \
  --mode direct \
  --selection-rationale '<근거>'

# Planned는 2-5개 선언
p2a execute prepare --artifacts .plan2agent/artifacts/<project> \
  --mode planned \
  --selection-rationale '<근거>' \
  --milestone 'milestone-1|<결과>|<검증 명령>' \
  --milestone 'milestone-2|<결과>|<검증 명령>'
```

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

3. 일반 run 시작:

```bash
p2a execute start \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id> \
  --agent-tool codex
```

승인 constitution의 판단형 규칙을 독립적으로 검사해야 하거나 프로젝트 정책이 요구할 때만 `--require-monitor`를 추가한다. 이 플래그 없이 시작한 일반 run에는 monitor agent나 sidecar를 만들지 않는다.

4. 사람이 foreground agent 세션에서 prompt를 실행하고 결과를 확인한다.

   Planned run은 각 결과 뒤 선언된 checkpoint를 순서대로 실행한다. `p2a execute resume`은 다음 pending checkpoint를 출력한다. 단, checkpoint가 `failed` 또는 `unavailable` evidence를 남기면 같은 run에서 해당 milestone을 다시 실행하지 않는다. 그 run을 failed/blocked로 닫고 새 retry run을 시작하며, resume도 다음 checkpoint 대신 이 복구 요구사항을 출력한다.

   Start가 기록한 task contract와 Gate B execution envelope는 run이 열린 동안에도 고정된다. `resume`, `verify`, `checkpoint`는 새 실행 증거를 만들기 전에 현재 Gate B/Gate C 원본을 다시 검증하며, command verification은 열린 run에서만 실행한다. 원본이 바뀌거나 사라졌다면 실행을 계속하지 않으며, `p2a next`는 실패할 resume 대신 `started_run_contract_drift`를 반환한다. 변경이 실수라면 기록된 원본을 복원하고, 의도된 계약 변경이라면 기존 run을 structured failed/blocked evidence로 닫은 뒤 변경 계약을 승인하고 새 run을 시작한다.

```bash
p2a runs checkpoint --artifacts .plan2agent/artifacts/<project> \
  --run-id <run-id> \
  --milestone milestone-1
```

5. `--require-monitor`로 시작한 run에만 독립 monitor 결과를 run 파일 옆의 `.monitor-verdict.json` sidecar에 기록한다. 예를 들어 run ref가 `runs/<iteration-id>/<run-id>.json`이면 verdict 경로는 `runs/<iteration-id>/<run-id>.monitor-verdict.json`이다. 이 파일은 CLI 명령으로 임의 생성하는 대신, foreground 실행 owner가 §6의 표준 JSON shape으로 작성한다. 새 `.monitor-gate.json`은 `ruleContract`에 승인 constitution 또는 legacy style의 ref와 SHA-256을 고정하고 `requiredConcernFields`에 `rule_concerns`를 포함한다. Monitor에는 이 sidecar와 규칙 원문 전체를 함께 전달한다. 일반 run은 이 단계를 건너뛴다.

   `full + current_iteration` task는 `workKind`와 `visualImpact.screenStates`로 UI 영향 범위만 명시한다. 모든 task를 통합한 뒤 승인 experience가 `visual_review_required`이면 `reviewPasses.visual`과 무관하게 `p2a execute review --artifacts <root>`로 iteration당 하나의 `runKind: final_visual_review` run을 연다. 이 run은 Gate B에서 전체 screen/state/viewport/접근성 계약을 직접 가져오고 canonical workspace, isolation 없음, 변경 파일 없음을 강제한다. 실제 앱 PNG, 접근성 보고서, capture metadata, workspace revision과 승인 prototype 비교 결과를 `.visual-review.json`에 기록하며 close-ready와 `p2a next`가 revision과 digest를 재검증한다.

   비UI iteration은 기본 `reviewPasses.acceptance: opt_in`에서 독립 acceptance run을 자동으로 만들지 않는다. 사용자가 요청해 `p2a execute accept --artifacts <root> --agent-tool <reviewer>`를 시작했거나 정책이 `on`이면 baseline에 이미 있던 동작을 제외한 현재 반복의 Gate B `product.core_flows`와 `product.success_criteria`를 계약으로 고정한 `final_acceptance_review` run을 canonical workspace, isolation 없음, 변경 파일 없음으로 연다. Owner가 각 동작을 `p2a runs verify --verify-command 'custom:<command>'`로 실제 실행하고, read-only `p2a-acceptance-reviewer`가 run verification과 일치하는 `command`·`source: command|config`·정수 `exitCode`·`stdoutTail`을 `.acceptance-review.json`에 기록한다. exit 0이어도 출력이 비어 있거나 의미 없는 결과면 `block`이다. 일단 시작한 review는 모든 기준이 실제 동작으로 확인된 `confirm_behavior`로 끝나야 하며 exact sidecar hash와 canonical workspace revision을 봉인한다. 이후 workspace 변경은 새 acceptance review를 요구한다.

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
7. 충돌이 없고 필수 verification이 통과했으며 필요한 단일 monitor gate가 acceptance와 constitution 규칙을 확인한 candidate만 canonical integration branch에 반영한다. 그 뒤에만 `p2a execute finish`로 run을 `finished`, task를 `done`으로 전이한다.
8. batch harvest 후 `ready`를 다시 계산하고 다음 batch worktree는 최신 canonical integration head에서 시작한다.

spawn, scope, integration, verification 또는 monitor가 실패한 task는 canonical integration branch를 전진시키거나 `done` 처리하지 않는다. 기존 structured failure contract로 `blocked`/`failed` 처리하거나 사용자 결정이 필요하면 active로 유지한다. 다른 독립 task의 직렬 harvest는 계속할 수 있다.

dirty, unmerged, failed, blocked task 또는 integration-candidate worktree는 자동 제거하지 않는다. 결과가 canonical integration branch와 run evidence에 durable하게 남은 accepted worktree만 사용자 확인 또는 승인된 cleanup 정책에 따라 정리할 수 있다.

## 5. Run과 orchestration artifact

정본 파일:

| 파일 | 역할 |
| --- | --- |
| `.plan2agent/artifacts/<project>/runs/run-index.json` | run 목록과 최신 상태 index. `active_only`가 상세 재시도를 지울 때 텍스트 없는 제한 회고 집계도 임시 보존 |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.json` | Gate-derived `executionEnvelopeRef`/hash, task 실행 기록, changedFiles, verification, failureClass |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/envelopes/<sha256>.json` | 내용 주소화한 Gate B 실행 계약. 같은 계약을 쓰는 run들이 공유 |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.orchestration.json` | shared mental model, role assignment, communication log, runtime phase |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.monitor-gate.json` | 실행 당시 monitor 정책, verdict 경로와 규칙 계약 snapshot |
| `.plan2agent/artifacts/<project>/runs/<iterationId>/<runId>.visual-review.json` | iteration 최종 review run의 실제 렌더링·접근성 증거와 `confirm_ui|block` verdict. 해당 review run의 성공 finish를 차단함 |
| `.plan2agent/artifacts/<project>/visual-evidence/<iterationId>/<runId>/` | visual review가 참조하는 실제 앱 screenshot과 접근성 보고서. run store 밖에 두어 run-index/migration 계약과 분리함 |
| `.plan2agent/proposals/*.json` | 실행 회고 기반 개선 후보 |
| `.plan2agent/proposals/reviews/*.json` | proposal deterministic review |
| `.plan2agent/proposals/curations/*.json` | proposal grouping/prioritization |

Git workspace의 run은 시작과 finish 시점에 `headSha`, branch, dirty 상태를 갱신해 상세 diff를
Git에서 찾을 수 있게 한다. `active_only` cleanup은 proposal queue가 아직 소비하지 않은
failed/blocked run을 보존한다. 수동 정리가 필요하면 먼저 `p2a runs gc --dry-run`으로
indexed/orphan 대상을 확인하며, `started` run과 `persistent` 모드는 각각 종료 처리와
명시적인 `--force` 없이는 삭제하지 않는다.
| `.plan2agent/proposals/patch-drafts/*.json` | 적용하지 않는 patch draft |
| `.plan2agent/proposals/approvals/*.json` | 사람이 승인한 proposal draft와 maintenance task 연결 |

Task에는 가벼운 `visualImpact`만 두고, 전체 승인 계약은 최종 review run의 `visualReview`에 한 번만 materialize한다. 화면별 실제 렌더링 결과와 접근성 판정은 그 run의 sidecar로 분리한다.

## 6. Monitor gate와 failure policy

monitor gate가 필요한 run은 monitor verdict 없이 `done`으로 닫지 않는다.

표준 verdict shape:

```json
{
  "verdict": "confirm_done",
  "rules_reviewed": [],
  "rule_concerns": [],
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "needs_user_decision": [],
  "note": ""
}
```

새 monitor gate는 시작 시점의 승인 `.plan2agent/constitution.json`을 `ruleContract.ref`와 `ruleContract.sha256`으로 고정하고 실제 검사해야 할 architecture/stack/enforceable prohibition/style ID를 `ruleContract.ruleIds`로 기록한다. Constitution이 없는 미이관 project는 substantive `.plan2agent/style.md`를 사용하며 둘 다 없으면 `source: none`과 빈 ID 목록을 명시한다. Run 본문도 정규화된 sidecar 전체의 SHA-256을 `monitorGate.contractSha256`에 보존하므로 sidecar 삭제·완화·경로 변경은 finish와 `p2a runs validate`에서 거부된다. Monitor는 실제 changed file을 각 규칙과 대조한 뒤 `rules_reviewed`에 모든 ID를 반환한다. Advisory prohibition은 `note`에 한계를 공개할 수 있지만 그것만으로 block하지 않는다. Finish는 규칙 원문을 다시 hash해 start 이후 drift를 차단하고, 완료 판정에 사용한 verdict 원문 바이트의 SHA-256을 `monitorVerdictEvidenceSha256`으로 run에 봉인한다. 이후 verdict 누락·변조는 runs validation, task 완료, eval, proposal mining과 handoff에서 거부되거나 무효 evidence로 제외된다. 필수 배열의 non-string/blank 값 또는 rule ID coverage가 누락된 verdict도 거부하며, run-side binding이 없는 이전 sidecar의 느슨한 verdict 형식은 과거 이력 호환을 위해 계속 읽는다.

허용되지 않은 verdict, rule violation, verification 실패, scope drift가 있으면 run은 blocked 또는 failed 상태로 닫고 `p2a proposals mine`으로 후속 조치를 만든다. 여러 concern 배열이 동시에 채워지면 failure class 매핑 우선순위는 `rule_concerns` → `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`이다. `rule_concerns`와 `scope_concerns`는 모두 `scope_violation`으로 매핑된다.

### 6.1 자율성·usage 계측

새 run은 `telemetryProtocol: p2a.run_telemetry.manual.v1` marker와 `usage`, `interruptions` 배열을 가진다. 기존 v1/v2 run에는 marker와 두 필드가 없어도 유효하다. Provider가 usage를 제공하면 한 번의 증분 sample을 다음처럼 기록한다. `totalTokens`는 CLI가 `inputTokens + outputTokens`로 계산하며 schema validator도 일치를 확인한다.

```bash
p2a runs record --run-id <id> --artifacts <root> \
  --usage-model gpt-5.6-sol/high \
  --usage-input-tokens 1200 \
  --usage-output-tokens 350 \
  --usage-source provider
```

자동으로 관측할 수 없는 사용자 개입은 발생한 run에 즉시 수동 주석한다. 구현 방법을 사용자에게 선택시킨 경우 `--implementation-interruption`, 요구사항·UI를 사용자가 다시 설명한 경우 `--user-correction`을 쓴다. 계약 Gate 복귀는 사용자가 계약 변경 필요 여부를 판정한 뒤 `--gate-return valid|invalid:<요약>`으로 기록한다. 일반 테스트 실패나 UI drift 수정은 Gate 복귀가 아니다.

```bash
p2a runs record --run-id <id> --artifacts <root> \
  --implementation-interruption "Asked the user to choose an internal module layout" \
  --user-correction "User restated the approved empty state" \
  --gate-return "valid:Approved scope lacked an external permission"
```

`p2a eval digest`는 model profile·source별 token 합계, 구현 결정 개입, 사용자 수정, Gate 복귀 precision, 무개입 성공 run 비율, task 수, first-pass acceptance, rework, integration defect, visual drift, scope/rule violation, Gate B→close-ready 시간과 verification evidence completeness를 집계한다. `runKind`가 있는 최종 visual/acceptance review run은 구현 자율성·rule-review 분모와 개입 수에서 제외한다. Usage는 review 비용도 비용이므로 digest 범위의 모든 run을 합산한다. 새 protocol marker가 없는 과거 구현 run은 `interruptions` 배열이 나중에 추가돼도 자율성 지표에서 제외한다. Digest는 autonomy telemetry, usage sample, strict rule review의 coverage도 함께 내보내므로 token 또는 violation의 낮은 합계를 coverage 저하와 혼동하면 안 된다. 동일한 annotation protocol을 적용한 A/B run만 비교한다.

Phase 0의 일회성 task-decomposition A/B 평가는 고정 seed·prompt·verification·UI capture matrix로 수행했고, 그 결과와 한계는 [개선 제안서 §13](gate-driven-adaptive-execution-proposal.md#13-평가-기록과-운영-계측)에 보존한다. 평가는 production `p2a execute` lifecycle 전체를 재현하지 않았으며, 의사결정 완료 뒤 전용 runner·fixture·schema·회귀 테스트를 저장소에서 제거했다. 이후 운영 비교는 실제 run의 `p2a eval digest` telemetry를 사용하고 과거 A/B를 기본 테스트나 phase별 절차로 반복하지 않는다. 당시 사용한 baseline seal CLI와 schema도 제품 runtime과 대상 프로젝트 배포 표면에 남기지 않는다.

같은 task의 latest run이 `failed` 또는 `blocked`이면 먼저 해당 로컬 run의 failure class, localization, verification evidence를 직접 확인한다. 이미 commit된 BuildLore 지식이 실제로 도움이 될 때만 같은 프로젝트를 한 번 명시적으로 검색하고, 명확히 유사한 mitigation만 적용해 조회한 source를 run note에 남긴다. 재시도를 이유로 BuildLore sync·compile·commit·push를 암묵적으로 수행하지 않으며 첫 시도에는 검색하지 않는다.

`p2a execute start/status/finish`와 직접 `p2a runs start/finish` 출력 footer에는 copy-paste 가능한 `resume`, `status`, `finish`, `review` 명령이 남는다. `resume`은 `p2a execute resume --run-id <run-id>`로 같은 run의 launcher prompt를 다시 출력한다. 실행 계획과 Launcher는 사람에게 task `intent`와 실패 시 행동을 `[한눈에]`로 먼저 보여주고, 실행 명령 뒤에 정확한 envelope·acceptance·경계를 `[세부 계약]`으로 유지한다. `intent`는 task contract hash와 완료 판정에서 제외된다. `review`의 `p2a proposals mine --run-id <run-id>`는 회고 후보를 쓰는 별도 승인 필요 작업이며, `p2a next`가 자동 실행하지 않는다.

### 6.2 Historical milestone evidence

Phase 1부터 새 실행은 style/milestone reviewer와 sidecar를 생성하지 않는다. 이전 `p2a.milestone_review.v1` 및 style verdict는 archived run, handoff, eval 재현을 위해 validator와 reader가 계속 읽지만 현재 close 조건이나 새 prompt 조립에는 참여하지 않는다.

새 run은 artifact root의 전역 `runs/run-index.json`과 iteration별 `runs/<iterationId>/<runId>.json`에 저장한다. run 파일과 index 갱신은 project run-store lock, atomic rename, 복구 journal을 사용하므로 동시 start의 lost update를 막고 중단된 commit은 다음 mutation에서 전진 복구한다. stale lock 회수도 별도 reaper lock으로 직렬화해 새 소유자의 lock을 이전 stale 판단으로 삭제하지 않는다. 기존 평면 `runs/<runId>.json` 이력은 계속 읽을 수 있으며, 이전 `--graph` 기본 위치였던 `iterations/<iterationId>/runs/`도 migration 입력으로 발견한다. `p2a runs migrate-layout --artifacts <artifact-root> --dry-run`으로 이동·병합 계획을 확인한 뒤 `--yes`로 정리할 수 있다. 마이그레이션은 source/target run store를 고정 순서로 잠그고 run, 알려진 sidecar, 소유 프로세스가 끝난 run ID 예약을 전역 runs로 이동한다. 살아 있는 start가 소유한 예약이 있으면 migration을 중단한다. migration journal을 확정한 즉시 legacy store에 `.run-store-redirect.json`을 남겨 이전 `--runs` 경로가 새 index를 재생성하지 못하게 한다. 프로세스가 중단되면 `.run-layout-migration` journal이 남으며 같은 `migrate-layout ... --yes` 명령으로 재개한 뒤 충돌 없는 단일 `run-index.json`을 확정하고 legacy index를 제거한다. Layout 정리와 별개로 `p2a runs migrate-schema --artifacts <artifact-root> --dry-run`은 source graph/spec provenance를 검증한 뒤 finished `p2a.run.v1` evidence에 immutable `taskContractSha256`을 계산해 v2 승격 계획을 보여준다. `--yes` 적용은 같은 run-store lock과 write journal을 사용하며 started/failed/blocked v1 이력은 자동 승격하지 않는다.

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
- 선택된 Gate C execution record—Direct/Planned synthetic work item 또는 Orchestrated task graph—가 validator를 통과해야 한다.
- ready work item과 acceptance criteria가 있어야 한다.
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
- BuildLore 기반 cross-session knowledge retrieval, run/proposal 검색, failure trend 분석.
- `p2a doctor/info/update/upgrade` 같은 상위 명령면 정리.

일반 multi-provider 무인 scheduler와 API 기반 완전 자동 개발은 기본 로드맵의 우선순위에서 제외한다.
