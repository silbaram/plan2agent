# 개발 사이클 회고 (Cycle Retrospective)

p2a 하네스로 개발할 때 "하네스가 도움이 되는가, 방해가 되는가"를 판정하기 위한
최소 회고 절차다. 계측 인프라 없이, 고정 질문에 대한 짧은 기록만 쌓아 패턴으로 판단한다.

## 언제 하는가

**iteration close 직전, 다음 iteration open 전에 단 한 번.**

`runTracking.persistence: active_only`에서는 다음 iteration을 open하는 순간
과거 run 증거가 삭제된다. 회고는 증거가 살아있는 close 직전에 끝내야 한다.

```
사이클 완료 → [회고 5분] → p2a iteration open
```

## 어떻게 하는가

1. [cycle-template.md](./cycle-template.md)를 복사해
   `docs/retrospective/<project_id>-v<N>.md`로 만든다.
2. 각 질문에 체감 그대로 답한다. 가능하면 run id 또는 명령명을 근거로 남긴다.
3. 모르면 비워둔다. 추측으로 채우지 않는다.

## 판정 규칙 (3회 축적 후)

| 신호 | 조치 |
| --- | --- |
| 같은 명령이 2회 이상 "느리다"로 지목 | 성능 이슈화 (재현 측정 포함) |
| C2(도장 승인)가 반복되는 게이트 | 자동 검증 강등 또는 인접 경계 병합 검토 |
| A3(증거 소실) 발생 | retention 정책 재검토 |
| E1(제품 집중)이 연속 사이클 지속 | 하네스 동결 원칙 유지 |
| D1(우회)이 반복되는 절차 | 해당 절차의 단순화·자동화 1순위 |

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
   - `runs/<iterationId>/*.json` 각 run 파일:
     status, startedAt/finishedAt, interruptions[], verification[]
   - `runs/run-index.json`: 상태 분포, task별 run 수
3. **집계**: 템플릿 말미 "수집 요약" 표의 지표를 계산한다.
4. **작성**: [cycle-template.md](./cycle-template.md)를 복사해
   `docs/retrospective/<project_id>-v<N>.md`로 저장하고 채운다.
5. **판정 위임**: C1(게이트 기여 판정), D2(체감 메모), E1/E2(다음 결정)는
   근거와 함께 비워두거나 `사용자 확정 필요`로 표시한다.
6. **보고**: 완성된 파일 경로와 수집 요약 숫자, 사용자가 채울 항목 목록을
   대화로 반환한다.

### 제약

- 추측 금지: 증거 없는 답은 빈 칸. 해석은 사용자 몫.
- 이 절차는 읽기 전용이다. `.plan2agent`와 기존 회고 파일을 수정하지 않는다.
- active iteration의 증거만 유효하다(open 후 과거 run은 삭제됨).
