# p2a 사이클 회고: <project_id> v<N>

- 기간: YYYY-MM-DD ~ YYYY-MM-DD
- 실행 모드: (direct / planned / orchestrated)
- 총 run 수:
- 작성 시점: iteration close 직전

> **에이전트 작성 규칙**: 각 항목 옆 `[출처]` 표기된 아티팩트에서 사실만 수집해 채운다.
> 판정이 필요한 항목(C1·E1)은 근거를 제시하고 `사용자 확정 필요`로 남긴다.
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

### B1. 체감상 느렸던 명령 `[출처: run 파일 verification[].durationMs 상위 집계]`
명령명과 대략 소요 시간. "없음"도 답이다.

-

### B2. 반복 대기 `[출처: 위 집계에서 동일 명령 반복 여부]`
매번 같은 명령에서 기다린 경험이 있는가? (익숙해져서 놓치기 쉬운 누적 비용)

-

## C. 게이트 가치 — 승인 경계가 일했나

### C1. 실제로 잡은 문제 `[출처: run.interruptions[] gate_return + assessment, 사용자 판정 필요]`
Gate A/②/B 또는 완료 조건에서, 그 경계가 없었다면 잘못된 상태로 넘어갔을 명확한 순간.

-

### C2. 도장만 찍은 승인 `[출처: gate_return 목록 중 assessment=valid가 아닌 것 / 승인 직후 수정 없음]`
기여 없이 형식으로만 통과한 승인. 어느 게이트였는지.

-

## D. 우회와 마찰

### D1. 하네스를 피해 손으로 한 작업
정식 절차 대신 터미널에서 직접 처리한 것과 이유.

-

### D2. 자유 메모
- 가장 아팠던 마찰 1가지:
- 예상 밖으로 좋았던 것 1가지:

## 수집 요약 (에이전트 기록란)

> 아래 숫자는 작성 시점 아티팩트에서 계산한 값이다.

| 지표 | 값 | 출처 |
| --- | --- | --- |
| 총 run 수 / 상태 분포 | | runs/run-index.json |
| gate_return 횟수 (valid/invalid) | | run.interruptions[] |
| user_correction 횟수 | | run.interruptions[] |
| implementation_interruption 횟수 | | run.interruptions[] |
| 검증 실행 횟수 / 평균·최대 durationMs | | run.verification[] |
| 실패·재시도 run 수 | | run-index status 집계 |

## E. 다음 사이클 결정

### E1. 하네스 동결 여부
다음 사이클은 하네스 수정 없이 제품에 집중하는가? (Y/N)

### E2. 동결 해제 시 최우선 수정 1개
E1이 N일 때만. 딱 하나만.

-

---

> 작성 규칙: 추측 금지, 근거(run id / 명령명) 우선, 모르면 비움.
> 판정 규칙은 [README](./README.md) 참조.
