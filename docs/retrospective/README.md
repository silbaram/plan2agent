# 개발 사이클 회고 (Cycle Retrospective)

p2a 하네스로 개발할 때 "하네스가 도움이 되는가, 방해가 되는가"를 판정하기 위한
최소 회고 절차다. 계측 인프라 없이, 고정 질문에 대한 짧은 기록만 쌓아 패턴으로 판단한다.
게이트와 명령뿐 아니라 실제로 사용한 skill·subagent가 결과에 기여했는지도 함께 본다.

## 언제 하는가

**iteration close 직전, 다음 iteration open 전에 단 한 번.**

`runTracking.persistence: active_only`에서는 다음 iteration을 open하는 순간
과거 run 증거와 해당 반복의 제한 집계가 삭제된다. 같은 반복 안에서 superseded run 상세가
먼저 삭제되더라도 `run-index.json.retrospective`에는 텍스트 없는 횟수·시간 집계가 남는다.
회고는 현재 run 상세와 이 집계를 함께 읽을 수 있는 close 직전에 끝내야 한다.

같은 시점에 `p2a next --json --contract v2`는 retry, failed/blocked, 명시적 correction,
반복 process defect, verification gap, monitor mismatch를 기본으로 탐지하고, 설정된 성능 예산과
회귀 baseline도 최대 32개의 구조화된 후보로 보여준다. 자동 탐지가 필요 없으면
`runTracking.retrospectiveSignals.enabled: false`로 끌 수 있다.
후보는 현재 iteration과 텍스트 없는 제한 집계만 사용하며 원본 command, output, note,
source 값을 보존하지 않는다. 이 자동 요약은 아래 5분 회고를 대체하지 않고 우선순위를
잡는 근거다. 완료 선택의 `P2A 회고`는 후보를 짧게 보고하고, 후보가 없으면 사용자 체감
마찰이 있었는지 한 번만 묻는다. 사용자가 회고 진행을 승인하면 장문 템플릿 대신 관찰된
문제·사용자 영향·개선 제안·간단한 근거만 `action.report.path`에 먼저 기록할 수 있다.
Proposal 저장은 다시 별도 승인이 필요하며 회고를 건너뛰거나 저장을 거절해도 close할 수 있다.

```
사이클 완료 → [회고 5분] → p2a iteration open
```

## 어떻게 하는가

완료 선택에서 승인한 짧은 회고는 반환된 경로에 아래 네 항목만 기록한다. 이미 파일이
있으면 덮어쓰지 않는다.

- Observed issue
- User impact
- Suggested improvement
- Evidence

아래 전체 템플릿은 사용자가 5분 상세 회고를 요청한 경우에만 사용한다.

1. [cycle-template.md](./cycle-template.md)를 복사해
   `docs/retrospective/<project_id>-v<N>.md`로 만든다.
2. 각 질문에 체감 그대로 답한다. 가능하면 run id 또는 명령명을 근거로 남긴다.
3. 모르면 비워둔다. 추측으로 채우지 않는다.
4. 구조화된 후보가 있으면 signal/domain/observed/threshold를 수집 요약에 옮기되,
   후보가 없다는 사실만으로 개선점이 없다고 단정하지 않는다.

## 판정 규칙 (3회 축적 후)

| 신호 | 조치 |
| --- | --- |
| 같은 명령이 2회 이상 "느리다"로 지목 | 성능 이슈화 (재현 측정 포함) |
| C2(도장 승인)가 반복되는 게이트 | 자동 검증 강등 또는 인접 경계 병합 검토 |
| A3(증거 소실) 발생 | retention 정책 재검토 |
| F1(제품 집중)이 연속 사이클 지속 | 하네스 동결 원칙 유지 |
| D1(우회)이 반복되는 절차 | 해당 절차의 단순화·자동화 1순위 |
| 기여 근거가 없는 skill·subagent 사용이 반복 | 기본 호출에서 제외하거나 활성화 조건을 좁히는 개선 후보로 기록 |
| 같은 handoff에서 수정·재설명이 반복 | 역할 계약이나 전달 context를 줄이거나 명확히 하는 개선 후보로 기록 |

## 기록 파일 관례

- 위치: `docs/retrospective/<project_id>-v<iteration>.md`
  (하네스 상태인 `.plan2agent/` 내부에 두지 않는다)
- 한 사이클당 파일 하나. 과거 파일은 수정하지 않는다.

## 에이전트 세션에서 실행하기

트리거 프롬프트 예시:

```
docs/retrospective를 읽고 <project_id> v<N> 사이클 회고해
```

에이전트는 아래 절차를 따른다.

### 절차

1. **대상 확인**: `<project>`의 `.plan2agent/artifacts/<project_id>/` 위치와
   active iteration id를 `runs/run-index.json`에서 확인한다.
2. **증거 수집** (읽기만 수행, 어떤 하네스 상태도 수정하지 않는다):
   - 현재 남아 있는 `runs/<iterationId>/*.json` 각 run 파일:
     status, startedAt/finishedAt, interruptions[], verification[]
   - `runs/run-index.json`: 현재 상태 분포, task별 run 수,
     `retrospective.iterations[]`의 삭제 run 상태·검증·개입 제한 집계
   - 사용할 수 있는 provider 세션 기록 또는 tool trace:
     실제로 읽은 skill id, 실제로 호출한 subagent 이름, 맡긴 일, 반환 결과
     (기록이 없으면 설치 목록으로 사용 여부를 추정하지 않는다)
3. **집계**: 현재 run 값에 같은 iteration의 `retrospective` 값을 더해 템플릿 말미
   "수집 요약" 표를 계산한다. 검증 평균은 현재·삭제 run의 duration 표본 합계와
   `verificationDuration.totalMs/sampleCount`를 함께 사용한다. 구형 index에 집계가 없으면
   삭제된 run 수치를 추정하지 말고 `상세 삭제 전 집계 없음`으로 표시한다.
4. **작성**: [cycle-template.md](./cycle-template.md)를 복사해
   `docs/retrospective/<project_id>-v<N>.md`로 저장하고 채운다.
5. **판정 위임**: C1(게이트 기여), D2(체감), E(skill·subagent 효율),
   F1/F2(다음 결정)는 사실 근거만 먼저 제시하고 `사용자 확정 필요`로 표시한다.
6. **보고**: 완성된 파일 경로와 수집 요약 숫자, 사용자가 채울 항목 목록을
   대화로 반환한다.

### 제약

- 추측 금지: 증거 없는 답은 빈 칸. 해석은 사용자 몫.
- 설치되었거나 route에 등록된 skill·subagent를 실제 사용한 것으로 세지 않는다.
- 효율은 호출 횟수만으로 판정하지 않는다. 구체적인 산출물, 발견한 문제,
  줄인 재작업 또는 반대로 발생시킨 handoff·중복 작업을 근거로 삼는다.
- 이 절차는 읽기 전용이다. `.plan2agent`와 기존 회고 파일을 수정하지 않는다.
- active iteration의 현재 run과 같은 iteration의 제한 집계만 유효하다(open 후 둘 다 삭제됨).
