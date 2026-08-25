# p2a 사이클 회고: buildlore v16

- 기간: 2026-08-25 ~ 2026-08-25
- 실행 모드: planned
- 총 run 수: 확인된 전체 실행 6 (현재 run-index 보존 3, provider trace에서 삭제된 V16 run 3개 추가 확인)
- 작성 시점: iteration close 전 (`task-001` blocked)

> **에이전트 작성 규칙**: 각 항목 옆 `[출처]` 표기된 아티팩트에서 사실만 수집해 채운다.
> 판정이 필요한 항목은 근거를 제시하고 `사용자 확정 필요`로 남긴다.
> 증거가 없으면 빈 칸으로 둔다. 추측으로 채우지 않는다. 이 파일 외부를 수정하지 않는다.

## A. 동작 정합성 — 의도대로 되었나

### A1. 라우팅이 틀렸던 순간
`p2a next`가 잘못된 상태를 판단하거나 엉뚱한 명령을 권장한 적이 있는가?
(없으면 "없음")

- `p2a next --json --contract v2`가 전역 설치의 `constitution.schema.json`을 찾지 못해 `invalid_iteration_state`를 반환했다. 안내된 `p2a iteration validate --artifacts .plan2agent/artifacts/buildlore --allow-planning`은 약 98초 뒤 정상 통과했고, 이어서 다시 실행한 `p2a next`는 실제 다음 작업을 반환했다. 정본 iteration이 손상된 것이 아니라 runtime schema 탐색 실패가 잘못된 상태 판정을 만들었다. `[출처: provider tool trace 2026-08-25T11:23:21Z~11:26:18Z]`

### A2. 검증 오탐·부작동
validate/verify가 통과 못 시켰어야 할 것을 통과시켰거나, 정상인 걸 막은 적이 있는가?

- 31개 verification 중 10개가 `status=passed`, `exitCode=0`이면서 `stdoutTail`은 비어 있고 `stderrTail`은 `spawnSync /bin/sh EPERM`이었다. 구현 run에 3개, 최종 승인 run에 7개가 기록됐다. 이 10개는 실행 성공 증거로 사용할 수 없었지만 통과로 저장됐다. 이후 정상 권한에서 다시 실행한 전체 테스트 526개와 대상 테스트 121개 등은 실제 출력과 함께 통과했다. `[출처: run-2026-08-25T09-42-59-520Z-task-001, run-2026-08-25T10-21-38-394Z-task-001 verification[]]`

### A3. 데이터 손실
prune·삭제로 나중에 필요한 증거가 사라져 후회한 순간이 있는가?

- 있음. V16에서 run을 `finished`로 닫을 때 `Transient run cleanup: removed 1 superseded run(s)`가 3번 발생했다. 그 결과 `run-2026-08-25T07-59-26-281Z-task-001`, `run-2026-08-25T08-33-11-480Z-task-001`, `run-2026-08-25T08-55-44-376Z-task-001`이 현재 run-index와 run 디렉터리에서 사라졌다. 마지막 삭제 run에는 verification 11개와 `user_correction` interruption 2개가 있었으므로 현재 집계의 run·검증·수정 횟수는 실제 사이클 활동을 과소 집계한다. `[출처: provider tool trace 2026-08-25T08:42:07Z, 09:17:42Z, 10:06:42Z; 현재 runs/run-index.json]`

## B. 성능 — 느렸던 것

### B1. 체감상 느렸던 명령 `[출처: run 파일 verification[].durationMs 상위 집계]`
명령명과 대략 소요 시간. "없음"도 답이다.

- 전체 필수 검증을 한 번에 실행한 결합 명령이 37.628초로 가장 길었다. `[출처: run-2026-08-25T10-21-38-394Z-task-001]`
- `npm test`는 3회, 평균 24.043초, 최대 24.197초였다. 누적 시간은 72.128초다.
- `npm run lint`는 3회, 평균 7.168초, 최대 7.439초였다. 누적 시간은 21.505초다.

### B2. 반복 대기 `[출처: 위 집계에서 동일 명령 반복 여부]`
매번 같은 명령에서 기다린 경험이 있는가? (익숙해져서 놓치기 쉬운 누적 비용)

- `npm test`, `npm run build`, `npm run lint`, `npm run typecheck`, `p2a doctor`, entry validation, `git diff --check`가 각각 3회 기록됐다. 최종 승인 run에서는 최초 7개가 `EPERM` 오탐이어서 같은 묶음을 정상 권한으로 다시 실행했고, 마지막에 전체 필수 검증 결합 명령도 한 번 더 실행했다. `[출처: 3개 run의 verification[]]`

## C. 게이트 가치 — 승인 경계가 일했나

### C1. 실제로 잡은 문제 `[출처: run.interruptions[] gate_return + assessment, 사용자 판정 필요]`
Gate A/②/B 또는 완료 조건에서, 그 경계가 없었다면 잘못된 상태로 넘어갔을 명확한 순간.

- 사용자 확정 필요. `gate_return` 기록은 0건이라 Gate A/②/B의 기여를 판정할 아티팩트는 없다. 다만 최종 승인 완료 조건은 330개 기준이 필요한 계약에 14개 V16-local 판정만 제출된 것을 차단했고, 불완전한 acceptance sidecar를 저장하지 않았다. 이를 게이트가 실제로 잡은 문제로 볼지는 사용자 판정이 필요하다. `[출처: run-2026-08-25T10-21-38-394Z-task-001 notes, acceptanceReview.criteria]`

### C2. 도장만 찍은 승인 `[출처: gate_return 목록 중 assessment=valid가 아닌 것 / 승인 직후 수정 없음]`
기여 없이 형식으로만 통과한 승인. 어느 게이트였는지.

- 사용자 확정 필요. 3개 run의 `interruptions[]`에 `gate_return`이 0건이어서 아티팩트만으로 도장 승인을 판정할 근거가 없다.

## D. 우회와 마찰

### D1. 하네스를 피해 손으로 한 작업
정식 절차 대신 터미널에서 직접 처리한 것과 이유.

- 없음. 별도 Plan2Agent 저장소에 필요한 수정은 BuildLore V16 범위에서 직접 적용하지 않고 `scope_violation`으로 차단했다. `[출처: run-2026-08-25T11-28-00-685Z-task-001]`

### D2. 자유 메모
- 가장 아팠던 마찰 1가지: 사용자 확정 필요. 근거 후보는 합성된 최종 승인 계약이 누적 330개 기준을 요구하지만 V16 독립 리뷰는 14개 기준만 다뤄 sidecar를 완성하지 못했고, 이후 수정 요청도 별도 Plan2Agent 저장소 범위 문제로 다시 차단된 점이다. `[출처: run-2026-08-25T10-21-38-394Z-task-001, run-2026-08-25T11-28-00-685Z-task-001]`
- 예상 밖으로 좋았던 것 1가지: 사용자 확정 필요. 근거 후보는 불완전한 승인 sidecar를 억지로 저장하지 않았고, 제품 코드 수정은 2개 파일에 한정한 뒤 전체 526개 테스트와 필수 검증을 실제 출력으로 통과한 점이다. `[출처: run-2026-08-25T09-42-59-520Z-task-001, run-2026-08-25T10-21-38-394Z-task-001]`

## E. skill·subagent 효율 — 실제로 도움이 되었나

> 설치 목록이나 route 등록은 사용 증거가 아니다. provider 세션 기록 또는 tool trace로
> 실제 사용이 확인된 항목만 적는다. 기록이 없으면 `확인 불가`로 남긴다.

### E1. 실제 사용과 기여 `[출처: provider 세션 기록/tool trace, 필요시 관련 run id]`

| 종류 | 이름 | 실제로 맡긴 일 | 결과에 준 도움 | 비용·중복·재작업 | 다음 판단 |
| --- | --- | --- | --- | --- | --- |
| skill | `github:github` | GitHub issue #22 원문과 provenance 확인 | V16 입력을 이슈 원문에 결박 | snapshot 생성·수정 과정에서 원문을 3회 조회 | 사용자 확정 필요 |
| skill | `p2a-harness` | V16 iteration 생성, Gate A 결정과 승인 경계 진행 | intake와 정본 iteration을 만들고 범위를 고정 | Gate 진행 중 안내문 변경으로 재설명·재검증 발생 | 사용자 확정 필요 |
| skill | `p2a-spec` | product/implementation spec 초안 작성과 쉬운 문서 표현 반영 | 승인된 Gate B 정본과 읽기용 문서를 완성 | 문서 표현 변경 뒤 draft 검증을 반복 | 사용자 확정 필요 |
| skill | `p2a-next` | 매 시점의 단일 다음 행동 판정과 run 재개 | V16 상태에 맞춰 구현·복구 run으로 이동 | schema 탐색 실패로 잘못된 `invalid_iteration_state`와 98초 재검증 발생 | 사용자 확정 필요 |
| skill | `p2a-dev-execution` | 구현, 검증, 수정, 최종 승인 기록과 차단 closeout | compiler override 결함을 2개 파일에서 수정하고 불완전한 sidecar 저장을 막음 | 검증 오탐 확인과 재실행, 별도 저장소 범위 설명에 추가 작업 발생 | 사용자 확정 필요 |
| skill | `openai-docs` | 변경된 Codex skill을 다시 읽는 방법 확인 | 사용자 지원 질문에 공식 문서 기준 답변 제공 | V16 제품 산출물에는 직접 기여하지 않은 문맥 전환 | 사용자 확정 필요 |
| subagent | `v16_product_spec` (`p2a-spec-author`) | V16 product delta 작성 | 버전 표식이 있는 목표·흐름·성공 기준 초안을 반환해 Gate B에 사용 | 추가 메시지 2회와 interrupt/followup 1회 필요 | 사용자 확정 필요 |
| subagent | `v16_implementation_plan` (`p2a-implementation-planner`) | V16 implementation plan 작성 | architecture·interface·data flow·verification 계획을 반환해 Gate B에 사용 | 추가 메시지 3회와 interrupt/followup 1회 필요 | 사용자 확정 필요 |
| subagent | `v16_acceptance_review` (`p2a-acceptance-reviewer`) | V16-local 14개 기준 독립 판정 | 제품 동작을 독립적으로 검토하려는 시도와 14-case JSON 반환 | context 전달 3회 후에도 330개 계약과 불일치하고 stdoutTail을 축약해 sidecar로 사용하지 못함 | 사용자 확정 필요 |

### E2. 가장 효율적이었던 사용
구체적인 산출물, 발견한 문제 또는 줄인 재작업을 하나만 적는다. 없으면 "없음".

- 사용자 확정 필요. 근거 후보는 `p2a-dev-execution`이 compiler preflight override binding 결함의 재현·위치·회귀 guard·수정을 한 finished run에 남겼고, 변경을 `src/compiler/security.ts`와 `test/compiler-security.test.ts` 두 파일로 제한한 점이다. `[출처: run-2026-08-25T09-42-59-520Z-task-001]`

### E3. 과했거나 불필요했던 사용
호출하지 않아도 결과가 같았거나, context 전달·중복 검토·재설명 비용이 더 컸던 사례를
하나만 적는다. 없으면 "없음".

- 사용자 확정 필요. acceptance reviewer 자체보다 정본 330개 기준과 V16-local 14개 기준의 불일치를 호출 전에 확인하지 않고 context를 3번 다시 전달한 과정이 비효율적이었다. 반환된 14-case 결과는 정본 계약과 맞지 않고 검증 출력도 그대로 보존하지 않아 sidecar로 사용할 수 없었다. `[출처: provider tool trace, run-2026-08-25T10-21-38-394Z-task-001]`

### E4. 다음 사이클 변경
유지할 것 또는 호출 조건을 바꿀 것 중 근거가 가장 강한 한 가지만 적는다.

- acceptance reviewer는 호출 전에 정본 criterion 수·범위와 각 criterion에 제공할 verbatim verification evidence가 완전한지 preflight하고, 불완전하면 subagent를 호출하지 않는 조건을 둔다.

## 수집 요약 (에이전트 기록란)

> 아래 숫자는 작성 시점 아티팩트에서 계산한 값이다.

| 지표 | 값 | 출처 |
| --- | --- | --- |
| 총 run 수 / 상태 분포 | 확인된 전체 6 / 현재 보존 3: finished 1·blocked 2 (provider trace에서 삭제된 V16 run 3개 추가 확인) | runs/run-index.json, provider tool trace |
| gate_return 횟수 (valid/invalid) | 0 (0/0) | run.interruptions[] |
| user_correction 횟수 | 현재 보존 run 0 (삭제된 run에서 2건 추가 확인) | run.interruptions[], provider tool trace |
| implementation_interruption 횟수 | 0 | run.interruptions[] |
| 검증 실행 횟수 / 평균·최대 durationMs | 현재 보존 31회 / 평균 5,682ms·최대 37,628ms (이 중 `EPERM` 오탐 10회; 삭제된 run 검증 제외) | run.verification[] |
| 실패·재시도 run 수 | blocked 2 / 차단 후 후속 remediation run 1 | runs/run-index.json |
| 확인된 skill / subagent 사용 수 | skill 6 / subagent 3 | provider 세션 기록/tool trace |

## F. 다음 사이클 결정

### F1. 하네스 동결 여부
다음 사이클은 하네스 수정 없이 제품에 집중하는가? (Y/N)

- N. 10개 verification이 shell `EPERM`인데도 통과로 저장됐고, 최종 승인 계약 범위가 V16 독립 리뷰 범위와 맞지 않아 하네스 수정이 필요하다.

### F2. 동결 해제 시 최우선 수정 1개
F1이 N일 때만. 딱 하나만.

- verification command의 shell spawn이 실패하면 `passed/exitCode=0` 기록을 만들지 못하도록 fail-closed하고, 실제 child process 실행과 출력이 확인된 경우에만 성공 증거를 저장한다.

---

> 작성 규칙: 추측 금지, 근거(run id / 명령명) 우선, 모르면 비움.
> 판정 규칙은 [README](./README.md) 참조.
