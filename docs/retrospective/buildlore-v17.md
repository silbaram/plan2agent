# p2a 사이클 회고: buildlore v17

- 기간: 2026-08-26 ~ 2026-08-26
- 실행 모드: planned
- 총 run 수: 7 (현재 보존 2, `run-index.retrospective` 제한 집계 5)
- 작성 시점: iteration close 직전

> **에이전트 작성 규칙**: 각 항목 옆 `[출처]` 표기된 아티팩트에서 사실만 수집해 채운다.
> 판정이 필요한 항목은 근거를 제시하고 `사용자 확정 필요`로 남긴다.
> 증거가 없으면 빈 칸으로 둔다. 추측으로 채우지 않는다. 이 파일 외부를 수정하지 않는다.

## A. 동작 정합성 — 의도대로 되었나

### A1. 라우팅이 틀렸던 순간
`p2a next`가 잘못된 상태를 판단하거나 엉뚱한 명령을 권장한 적이 있는가?
(없으면 "없음")

- 현재 보존 run과 provider tool trace에서 확인된 오라우팅은 없다. 구현과 독립 인수 검증을 모두 끝낸 뒤 `p2a next --json --contract v2`는 자동 종료하지 않고 `iteration_review_or_close_required`를 반환해, 추가 리뷰 또는 명시적 close만 허용했다. `[출처: run-2026-08-26T01-13-24-657Z-task-001, run-2026-08-26T02-11-13-296Z-task-001, provider tool trace 2026-08-26T02:27:34Z]`

### A2. 검증 오탐·부작동
validate/verify가 통과 못 시켰어야 할 것을 통과시켰거나, 정상인 걸 막은 적이 있는가?

- 현재 보존 verification 15개는 모두 `source=command`, `status=passed`, `exitCode=0`이고 실행 출력 또는 성공 의미에 맞는 빈 출력(`git diff --check`)을 가졌다. 삭제 run 제한 집계 29개도 `passed 28`, `unavailable 1`로 구분돼, 실행 불가를 성공으로 기록한 증거는 없다. 삭제된 `unavailable` 1개의 명령과 원인은 제한 집계만으로 확인할 수 없다. `[출처: 두 현재 run verification[], runs/run-index.json.retrospective]`

### A3. 데이터 손실
prune·삭제로 나중에 필요한 증거가 사라져 후회한 순간이 있는가?

- 부분적으로 있음. superseded run 5개의 상태·검증 횟수·시간·interruption 제한 집계는 남았지만 원문 run은 삭제됐다. 따라서 `failed 2`와 `unavailable 1`의 구체적인 원인, 명령, 수정 연결 관계를 이번 회고에서 복원하지 못했다. 최종 제품 검증과 인수 판정에는 현재 finished run이 충분했으나, 실패·재시도 원인 분석에는 상세 소실이 실제 제약이 됐다. `[출처: runs/run-index.json.retrospective]`

## B. 성능 — 느렸던 것

### B1. 체감상 느렸던 명령 `[출처: 현재 run verification[]; 삭제 run은 run-index.retrospective의 시간 집계만 사용]`
명령명과 대략 소요 시간. "없음"도 답이다.

- 전체 필수 검증 결합 명령(`build + test + lint + typecheck + doctor + entry validate`)이 현재 run에서 각각 39.436초, 39.448초로 가장 길었다.
- 현재·삭제 run의 duration 표본 44개 합계는 323.334초, 평균은 7.349초, 최대는 39.448초였다. 삭제 run만의 최대 표본은 38.363초지만 제한 집계에는 명령명이 없다. `[출처: 두 현재 run verification[], runs/run-index.json.retrospective.verificationDuration]`

### B2. 반복 대기 `[출처: 위 집계에서 동일 명령 반복 여부]`
매번 같은 명령에서 기다린 경험이 있는가? (익숙해져서 놓치기 쉬운 누적 비용)

- 전체 필수 검증 결합 명령을 구현 run과 최종 인수 run에서 정확히 2회 실행해 약 78.884초를 사용했다. 대상 테스트를 먼저 실행하고 전체 검증을 마지막 경계에서 다시 실행한 구조였으며, 삭제 run의 명령별 반복 여부는 제한 집계에 원문이 없어 계산하지 않았다. `[출처: 두 현재 run verification[]]`

## C. 게이트 가치 — 승인 경계가 일했나

### C1. 실제로 잡은 문제 `[출처: 현재 run.interruptions[] 및 run-index.retrospective interruptionCounts, 사용자 판정 필요]`
Gate A/②/B 또는 완료 조건에서, 그 경계가 없었다면 잘못된 상태로 넘어갔을 명확한 순간.

- 사용자 확정 필요. `gate_return`은 현재·삭제 run 모두 0건이라 Gate A/②/B가 결함을 잡았다고 판정할 아티팩트는 없다. 다만 완료 조건은 별도 `final_acceptance_review` run, 현재 실행 출력, 정본 36개 criterion과 정확히 일치하는 독립 reviewer 판정을 요구했고, 36/36 `confirm_behavior`가 저장될 때까지 iteration을 close-ready로 취급하지 않았다. 이를 완료 게이트의 실질 기여로 볼지는 사용자 판정이 필요하다. `[출처: run-2026-08-26T02-11-13-296Z-task-001, 해당 acceptance-review.json, runs/run-index.json]`

### C2. 도장만 찍은 승인 `[출처: 현재 gate_return 목록 및 제한 집계의 valid/invalid 횟수 / 승인 직후 수정 없음]`
기여 없이 형식으로만 통과한 승인. 어느 게이트였는지.

- 사용자 확정 필요. 현재 run과 제한 집계에 `gate_return_valid=0`, `gate_return_invalid=0`만 있어 특정 승인을 도장 승인으로 분류할 근거가 없다.

## D. 우회와 마찰

### D1. 하네스를 피해 손으로 한 작업
정식 절차 대신 터미널에서 직접 처리한 것과 이유.

- 확인된 우회는 없다. 제품 수정·검증·재시도·최종 인수는 planned run으로 기록했다. 독립 reviewer가 반환한 JSON을 owner가 현재 run의 9개 증거와 다시 대조해 sidecar로 저장한 작업은 `p2a-dev-execution`의 owner persistence 절차였고, 저장 후 `p2a execute finish`로 봉인했다. `[출처: 두 현재 run, provider tool trace]`

### D2. 자유 메모
- 가장 아팠던 마찰 1가지: 사용자 확정 필요. 근거 후보는 총 7개 run 중 5개가 superseded됐고, 검증 44회 뒤에도 삭제된 실패 run 2개와 unavailable 검증 1개의 구체 원인을 회고에서 복원할 수 없었던 점이다. `[출처: runs/run-index.json.retrospective]`
- 예상 밖으로 좋았던 것 1가지: 사용자 확정 필요. 근거 후보는 V16에서 문제였던 실행 불가 검증의 성공 오기록이 재발하지 않았고, V17 최종 인수에서는 현재 실행 출력 9개로 정본 36개 기준을 모두 독립 판정하면서 제품 변경 0개인 전용 acceptance run을 완성한 점이다. `[출처: run-2026-08-26T02-11-13-296Z-task-001 및 acceptance-review.json]`

## E. skill·subagent 효율 — 실제로 도움이 되었나

> 설치 목록이나 route 등록은 사용 증거가 아니다. provider 세션 기록 또는 tool trace로
> 실제 사용이 확인된 항목만 적는다. 기록이 없으면 `확인 불가`로 남긴다.

### E1. 실제 사용과 기여 `[출처: provider 세션 기록/tool trace, 필요시 관련 run id]`

| 종류 | 이름 | 실제로 맡긴 일 | 결과에 준 도움 | 비용·중복·재작업 | 다음 판단 |
| --- | --- | --- | --- | --- | --- |
| skill | `p2a-harness` | provenance-bound Issue #21 v2 entry에서 V17 intake와 승인 경계 진행 | caller-owned session compile이라는 범위와 baseline supersession을 고정 | 여러 승인 경계를 거쳤으나 run interruption에는 비용이 기록되지 않음 | 사용자 확정 필요 |
| skill | `p2a-spec` | V17 product spec과 implementation plan 정본화 | child CLI process가 아닌 현재 세션 subagent 사용, LLM-free plan/apply, untrusted staging 계약을 명시 | 후속 코드 리뷰에서 구현 보강은 있었지만 spec 재작성 근거는 없음 | 사용자 확정 필요 |
| skill | `p2a-task-author` | 승인 spec을 `task-001` 실행 계약으로 변환 | 구현·검증·인수 기준을 한 owning task에 결박 | 단일 task가 넓어 다각도 리뷰 중 여러 remediation run이 발생 | 사용자 확정 필요 |
| skill | `p2a-next` | 각 상태에서 단일 다음 행동과 최종 review-or-close 결정 | 잘못된 자동 close 없이 구현, acceptance, 최종 사용자 결정으로 라우팅 | 상태 판정 호출 비용은 있었지만 확인된 오라우팅 없음 | 사용자 확정 필요 |
| skill | `p2a-dev-execution` | 구현, 다각도 수정, 검증 기록, 독립 인수 sidecar와 closeout | finished 구현 run과 36/36 acceptance run을 남기고 미검증 완료를 막음 | 총 7 run·44 verification, superseded 5 run | 사용자 확정 필요 |
| subagent | `v17_product_spec` (`p2a-spec-author`) | V17 product delta 작성 | 승인된 caller-session 목표·흐름·성공 기준의 초안을 제공 | 별도 재작성 또는 무효 반환은 확인되지 않음 | 사용자 확정 필요 |
| subagent | `v17_implementation_plan` (`p2a-implementation-planner`) | V17 구현 계획 작성 | session boundary, schema, admission, SDK staging, 검증 계획을 구체화 | 후속 코드 리뷰에서 경계 사례 보강이 필요했음 | 사용자 확정 필요 |
| subagent | `v17_acceptance_review` (`p2a-acceptance-reviewer`) | 현재 acceptance run의 정본 36개 기준을 독립 판정 | 36개 case, 현재 명령 증거, `confirm_behavior`, `unmet=[]`를 반환 | reviewer 반환 JSON을 owner가 sidecar로 저장·재검증하는 한 번의 handoff 필요 | 사용자 확정 필요 |

### E2. 가장 효율적이었던 사용
구체적인 산출물, 발견한 문제 또는 줄인 재작업을 하나만 적는다. 없으면 "없음".

- 사용자 확정 필요. 근거 후보는 `v17_acceptance_review`가 호출 전에 정본 36개 기준과 9개 실행 증거가 준비된 상태에서 한 번에 36-case `confirm_behavior`를 반환해, V16의 criterion 범위 불일치와 축약 증거 재작업을 반복하지 않은 점이다. `[출처: provider tool trace, run-2026-08-26T02-11-13-296Z-task-001.acceptance-review.json]`

### E3. 과했거나 불필요했던 사용
호출하지 않아도 결과가 같았거나, context 전달·중복 검토·재설명 비용이 더 컸던 사례를
하나만 적는다. 없으면 "없음".

- 사용자 확정 필요. 실제 사용이 확인된 skill·subagent 중 산출물이 결과에 기여하지 않았다고 단정할 근거는 없다. 다만 단일 `task-001`에 계약·planner·validator·admission·SDK staging·CLI 회귀가 함께 묶여, 구현 계획 이후에도 여러 remediation run과 44회 검증이 발생했다. 이를 task graph 분할 부족으로 볼지는 사용자 판정이 필요하다.

### E4. 다음 사이클 변경
유지할 것 또는 호출 조건을 바꿀 것 중 근거가 가장 강한 한 가지만 적는다.

- acceptance reviewer는 이번 사이클처럼 정본 criterion 수·ref 집합과 각 criterion에 연결할 현재 run의 verbatim command evidence가 완전한지 owner가 먼저 preflight한 뒤 정확히 한 번 호출하는 조건을 유지한다.

## 수집 요약 (에이전트 기록란)

> 아래 숫자는 작성 시점의 현재 run과 같은 iteration의 `run-index.retrospective` 제한 집계를
> 합산한 값이다. 제한 집계에는 원문·명령·run ID가 없으므로 정성 판단은 현재 증거 범위만 쓴다.

| 지표 | 값 | 출처 |
| --- | --- | --- |
| 총 run 수 / 상태 분포 | 7 / finished 5·failed 2·blocked 0 (현재 2 + 삭제 제한 집계 5) | run-index runs[] + retrospective statusCounts |
| gate_return 횟수 (valid/invalid) | 0 (0/0) | run.interruptions[] + retrospective interruptionCounts |
| user_correction 횟수 | 0 | run.interruptions[] + retrospective interruptionCounts |
| implementation_decision 횟수 | 0 | run.interruptions[] + retrospective interruptionCounts |
| 검증 실행 횟수 / 평균·최대 durationMs | 44회 (passed 43·unavailable 1) / 평균 7,349ms·최대 39,448ms, 총 323,334ms | run.verification[] + retrospective verification* |
| 실패·재시도 run 수 | failed 2 / superseded 5 | run-index status + retrospective reasonCounts.superseded |
| 확인된 skill / subagent 사용 수 | skill 5 / subagent 3 | provider 세션 기록/tool trace |

## F. 다음 사이클 결정

### F1. 하네스 동결 여부
다음 사이클은 하네스 수정 없이 제품에 집중하는가? (Y/N)

- 사용자 확정 필요. 현재 근거로는 **Y 후보**다. V17에서 확인된 오라우팅이나 검증 성공 오탐은 없고, final acceptance 계약도 36개 기준으로 정상 동작했다. 다만 superseded 실패 run의 상세 원인을 회고에서 복원하지 못한 retention 마찰을 하네스 동결 해제 사유로 볼지는 사용자 결정이 필요하다.

### F2. 동결 해제 시 최우선 수정 1개
F1이 N일 때만. 딱 하나만.

- F1을 N으로 정할 경우: superseded run의 원문을 보존하지 않더라도 `failed`와 `unavailable`에 한해 bounded reason code와 credential-free command identity를 `run-index.retrospective`에 남겨 회고에서 재시도 원인을 구분할 수 있게 한다.

---

> 작성 규칙: 추측 금지, 근거(run id / 명령명) 우선, 모르면 비움.
> 판정 규칙은 [README](./README.md) 참조.
