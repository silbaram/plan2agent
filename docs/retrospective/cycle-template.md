# p2a 사이클 회고: <project_id> v<N>

- 기간: YYYY-MM-DD ~ YYYY-MM-DD
- 실행 모드: (direct / planned / orchestrated)
- 총 run 수:
- 작성 시점: iteration close 직전

> **에이전트 작성 규칙**: 각 항목 옆 `[출처]` 표기된 아티팩트에서 사실만 수집해 채운다.
> 판정이 필요한 항목은 근거를 제시하고 `사용자 확정 필요`로 남긴다.
> 증거가 없으면 빈 칸으로 둔다. 추측으로 채우지 않는다. 이 파일 외부를 수정하지 않는다.

## A. 동작 정합성 — 의도대로 되었나

### A1. 라우팅이 틀렸던 순간
`p2a next`가 잘못된 상태를 판단하거나 엉뚱한 명령을 권장한 적이 있는가?
(없으면 "없음")

-

### A2. 검증 오탐·부작동
validate/verify가 통과 못 시켰어야 할 것을 통과시켰거나, 정상인 걸 막은 적이 있는가?

-

### A3. 데이터 손실
prune·삭제로 나중에 필요한 증거가 사라져 후회한 순간이 있는가?

-

## B. 성능 — 느렸던 것

### B1. 체감상 느렸던 명령 `[출처: 현재 run verification[]; 삭제 run은 run-index.retrospective의 시간 집계만 사용]`
명령명과 대략 소요 시간. "없음"도 답이다.

-

### B2. 반복 대기 `[출처: 위 집계에서 동일 명령 반복 여부]`
매번 같은 명령에서 기다린 경험이 있는가? (익숙해져서 놓치기 쉬운 누적 비용)

-

## C. 게이트 가치 — 승인 경계가 일했나

### C1. 실제로 잡은 문제 `[출처: 현재 run.interruptions[] 및 run-index.retrospective interruptionCounts, 사용자 판정 필요]`
Gate A/②/B 또는 완료 조건에서, 그 경계가 없었다면 잘못된 상태로 넘어갔을 명확한 순간.

-

### C2. 도장만 찍은 승인 `[출처: 현재 gate_return 목록 및 제한 집계의 valid/invalid 횟수 / 승인 직후 수정 없음]`
기여 없이 형식으로만 통과한 승인. 어느 게이트였는지.

-

## D. 우회와 마찰

### D1. 하네스를 피해 손으로 한 작업
정식 절차 대신 터미널에서 직접 처리한 것과 이유.

-

### D2. 자유 메모
- 가장 아팠던 마찰 1가지:
- 예상 밖으로 좋았던 것 1가지:

## E. skill·subagent 효율 — 실제로 도움이 되었나

> 설치 목록이나 route 등록은 사용 증거가 아니다. provider 세션 기록 또는 tool trace로
> 실제 사용이 확인된 항목만 적는다. 기록이 없으면 `확인 불가`로 남긴다.

### E1. 실제 사용과 기여 `[출처: provider 세션 기록/tool trace, 필요시 관련 run id]`

| 종류 | 이름 | 실제로 맡긴 일 | 결과에 준 도움 | 비용·중복·재작업 | 다음 판단 |
| --- | --- | --- | --- | --- | --- |
| skill / subagent | | | | | 유지 / 조건부 / 제외 후보 / 사용자 확정 필요 |

### E2. 가장 효율적이었던 사용
구체적인 산출물, 발견한 문제 또는 줄인 재작업을 하나만 적는다. 없으면 "없음".

-

### E3. 과했거나 불필요했던 사용
호출하지 않아도 결과가 같았거나, context 전달·중복 검토·재설명 비용이 더 컸던 사례를
하나만 적는다. 없으면 "없음".

-

### E4. 다음 사이클 변경
유지할 것 또는 호출 조건을 바꿀 것 중 근거가 가장 강한 한 가지만 적는다.

-

## 수집 요약 (에이전트 기록란)

> 아래 숫자는 작성 시점의 현재 run과 같은 iteration의 `run-index.retrospective` 제한 집계를
> 합산한 값이다. 제한 집계에는 원문·명령·run ID가 없으므로 정성 판단은 현재 증거 범위만 쓴다.

| 지표 | 값 | 출처 |
| --- | --- | --- |
| 총 run 수 / 상태 분포 | | run-index runs[] + retrospective statusCounts |
| gate_return 횟수 (valid/invalid) | | run.interruptions[] + retrospective interruptionCounts |
| user_correction 횟수 | | run.interruptions[] + retrospective interruptionCounts |
| implementation_decision 횟수 | | run.interruptions[] + retrospective interruptionCounts |
| 검증 실행 횟수 / 평균·최대 durationMs | | run.verification[] + retrospective verification* |
| 실패·재시도 run 수 | | run-index status + retrospective reasonCounts.superseded |
| 확인된 skill / subagent 사용 수 | | provider 세션 기록/tool trace (없으면 확인 불가) |
| 구조화된 회고 후보 수 / signal | | `p2a next --json --contract v2`의 retrospective (자동 탐지 사용 시) |

## F. 다음 사이클 결정

### F1. 하네스 동결 여부
다음 사이클은 하네스 수정 없이 제품에 집중하는가? (Y/N)

### F2. 동결 해제 시 최우선 수정 1개
F1이 N일 때만. 딱 하나만.

-

---

> 작성 규칙: 추측 금지, 근거(run id / 명령명) 우선, 모르면 비움.
> 판정 규칙은 [README](./README.md) 참조.
