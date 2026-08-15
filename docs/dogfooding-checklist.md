# Plan2Agent 실사용 검증 체크리스트

작성 기준일: 2026-08-14

문서 홈: [Plan2Agent Docs](README.md) · 사용자 시작점: [Quickstart](quickstart.md)

이 문서는 핵심 파이프라인(idea → Gate A/②/B 승인 → adaptive 실행 준비 → 구현·검증 → close-ready)을 실제 프로젝트로 검증할 때 사용하는 기록 양식이다. 목적은 실행 모드와 게이트가 품질을 지키면서 절차 비용과 사용자 개입을 실제로 줄이는지 기록으로 판단하는 것이다.

Gate C는 항상 사람이 세부 task graph를 저작하는 단계가 아니다. Direct/Planned는 승인된 Gate B에서 synthetic compatibility work item을 준비하고, Orchestrated만 dependency-aware task graph를 사용한다. 모드 선택과 Planned checkpoint는 실행 AI의 책임이며 추가 사용자 승인 Gate가 아니다.

## 사용 방법

- 실제 프로젝트 2~3개를 아이디어부터 close-ready까지 통과시킨다. 자연스럽게 선택된 결과가 있다면 둘 이상의 실행 모드를 포함하되, 비교를 위해 부적합한 모드를 강제하지 않는다.
- 프로젝트마다 이 문서의 "프로젝트 기록 양식" 사본을 하나 만들어 채운다. 권장 위치: `docs/dogfooding/<project_id>.md` (하네스 상태인 `.plan2agent/` 내부에는 두지 않는다).
- 기록은 세션이 끝날 때마다 바로 채운다. 나중에 몰아서 복기하면 생략·개입·복구 항목이 사라진다.
- 측정값은 기억이 아니라 산출물에서 가져온다: `p2a info`, `p2a next`, `status.md` change log, `runs/run-index.json`, 개별 run과 review sidecar, `p2a eval digest`.
- UI 프로젝트의 owner render/review 반복은 사용자 승인 횟수로 세지 않는다. 사용자가 요구사항이나 시각 결과를 직접 고쳐 준 경우만 `user_correction`으로 기록하고, iteration 최종 visual evidence는 별도로 확인한다.

## 측정 기준 5가지

### 기준 1 — 소요 시간과 명령 실행 횟수

아이디어 입력부터 Gate B 승인, 실행 준비, 첫 실제 검증, close-ready까지 얼마나 걸리고 몇 번의 명령을 실행했는지 기록한다. 승인 대기와 자율 실행 checkpoint를 구분해 도구의 절차 비용을 측정한다.

| 항목 | 기록 방법 |
| --- | --- |
| 선택 모드 | `adaptive`가 선택한 실제 모드 또는 명시한 `direct\|planned\|orchestrated`와 rationale |
| 구간별 소요 시간 | Gate A, Gate ②, Gate B, 실행 준비, 첫 검증, close-ready 시각 |
| 명령 실행 횟수 | `p2a ...` 실행 횟수를 구간별로 센다 (셸 히스토리 활용) |
| 사용자 대기 지점 | 승인·제품 결정이 필요해 멈춘 지점과 사유 |
| 자율 checkpoint | Planned milestone 또는 실행 중 verify 지점과 결과. 사용자 대기로 세지 않음 |

판정 신호: 같은 모드와 비슷한 범위에서 명령 실행 횟수나 Gate B→close-ready 시간이 줄지 않으면 해당 구간의 명령·기록 계약이 과한지 확인한다. 시간만 줄고 검증 evidence가 비거나 품질이 낮아지면 개선으로 보지 않는다.

### 기준 2 — 게이트·완료 조건 적중률

각 승인 게이트와 실행 완료 조건이 실제로 문제를 잡아냈는지, 아니면 통과 도장만 찍었는지 기록한다. 실행 모드별 추가 검증은 필요한 경우에만 적용한다.

| 경계 | 실제로 잡은 문제 (건수와 내용) | 도장만 찍음 (Y/N) |
| --- | --- | --- |
| Gate A (범위 결정) | | |
| Gate ② (constitution 결정) | | |
| Gate B (spec·visual contract 승인) | | |
| 실행 준비 (공통 envelope/hash, Planned checkpoint 또는 Orchestrated graph) | | |
| 최종 완료 조건 (verification, monitor, visual/acceptance evidence) | | |

"잡은 문제"의 기준은 해당 경계가 없었다면 잘못된 상태로 다음 단계에 넘어갔을 것이 명확한 경우다. 문구 다듬기 수준의 수정은 세지 않는다. `gate_return`은 승인 계약의 의미 변경이 정말 필요했는지도 `valid` 또는 `invalid`로 함께 기록한다.

판정 신호: 2~3개 프로젝트에서 한 번도 문제를 잡지 못한 경계는 자동 검증으로 강등하거나 인접 경계와 합칠 후보다. 반대로 반복되는 valid Gate return은 상류 계약의 누락을 뜻한다.

### 기준 3 — 생략·우회 목록

귀찮아서 건너뛰었거나 정식 절차 대신 손으로 우회한 단계를 전부 기록한다. 생략한 것 자체보다 절차와 실제 사용의 괴리를 찾는 것이 목적이다.

| 생략/우회한 단계 | 정식 절차 | 실제로 한 것 | 이유 |
| --- | --- | --- | --- |
| 예: run verification | `p2a execute finish --verify-command ...` | 셸 명령만 실행하고 evidence를 남기지 않음 | 기록 방법을 몰랐음 |

판정 신호: 모든 프로젝트에서 반복적으로 생략되는 단계는 삭제·단순화·자동화 후보 1순위다. 특히 `p2a execute`, `p2a runs`, `p2a eval digest`, `p2a proposals`, `p2a memory` 흐름 중 계약상 필요하지만 자발적으로 쓰이지 않은 것이 있다면 그대로 기록한다.

### 기준 4 — 승인 후 자율 완료율

Gate B 승인 뒤 구현 선택을 사용자에게 다시 묻거나 사용자 수정에 의존하지 않고 close-ready에 도달한 비율을 기록한다. 모든 모드에 공통인 자율성 지표를 쓰되 모드별 실행 구조도 함께 남긴다.

| 항목 | 값 |
| --- | --- |
| 선택 모드와 rationale | |
| 전체 구현 run/work item | |
| 추가 구현 지시 없이 완료 | |
| 구현 선택 질문 (`implementation_interruption`) | |
| 사용자 요구/UI 수정 (`user_correction`) | |
| Gate 복귀 (`gate_return`: valid / invalid) | |
| 실패·재시도·rework | |
| Planned checkpoint 실패 또는 Orchestrated task 재작성 | 해당 모드일 때만 기록 |

Direct는 승인 objective를 추가 구현 선택 없이 완료했는지, Planned는 2~5개 ordered checkpoint를 재작성 없이 통과했는지, Orchestrated는 task를 분할·병합·계약 수정 없이 완료했는지로 원인을 세분한다. 원자료는 run의 usage/interruption/verification 기록과 `p2a eval digest`에서 가져온다.

판정 신호: 자율 완료율이 낮으면 interruption과 correction 내용을 보고 원인이 실행 AI의 불필요한 질문인지, Gate B의 누락인지, 모드 선택 또는 task/checkpoint 구성인지 구분한다. Direct의 실패를 무조건 Orchestrated로 되돌리는 식으로 해석하지 않는다.

### 기준 5 — 스타일 교정 횟수

사용자가 생성된 코드의 스타일(네이밍, 오류 처리 방식, 추상화 수준, 주석 등)을 교정한 횟수를 기록한다. constitution 스타일 계약(`.plan2agent/constitution.json.style`)의 실효성을 측정한다. 미이관 legacy 프로젝트만 `.plan2agent/style.md`를 사용한다.

| 항목 | 기록 방법 |
| --- | --- |
| run/work item별 교정 횟수 | 사용자가 스타일 지적을 한 횟수를 실행 단위로 센다 |
| 교정 내용 | 무엇을 어떻게 바꾸라고 했는지 (constitution proposal 후보) |
| constitution 반영 여부 | 교정이 proposal과 필요 시 Gate ② 재승인을 거쳐 계약 파일에 반영됐는지 (Y/N) |

판정 신호: 프로젝트가 진행될수록 실행 단위당 교정 횟수가 줄어야 한다. 줄지 않으면 구현자가 constitution style을 따르지 않거나 계약 표현이 모호한 것이다. 동작 버그와 owner/monitor가 사용자 개입 없이 자체 수정한 내용은 세지 않는다.

## 프로젝트 기록 양식

프로젝트마다 아래 골격을 복사해 채운다.

```markdown
# 도그푸딩 기록: <project_id>

- 기간: YYYY-MM-DD ~ YYYY-MM-DD
- 아이디어 한 문장:
- 사용 CLI: (Claude Code / Codex / Gemini)
- project policy / 실제 선택 모드:
- selection rationale:

## 기준 1 — 시간/명령 횟수
(Gate B 승인, 실행 준비, 첫 검증, close-ready를 포함한 구간별 표)

## 기준 2 — 게이트·완료 조건 적중
(승인 게이트, 실행 준비, 최종 evidence 표)

## 기준 3 — 생략·우회
(목록 표)

## 기준 4 — 승인 후 자율 완료
(run/work item, interruption, correction, Gate return, retry 집계)

## 기준 5 — 스타일 교정
(실행 단위별 교정 횟수와 내용)

## 자유 메모
- 가장 아팠던 마찰 1가지:
- 예상 밖으로 좋았던 것 1가지:
```

## 종합 판정

프로젝트 2~3개의 기록이 모이면 아래 질문에 답하고 결과를 다음 개발 우선순위로 옮긴다.

1. **절차 비용**: 명령 횟수가 가장 많았던 구간은 어디이고, 그 구간의 명령·기록을 단순화할 수 있는가.
2. **게이트 구조**: Gate A, Gate ②, Gate B, 실행 준비, 최종 evidence 중 실제로 가치를 낸 경계는 무엇인가. 못 낸 경계는 강등·병합하는가.
3. **레이어 존폐**: `proposals` / `eval` / `memory` / `execute` 중 실사용에서 자발적으로 쓰인 것은 무엇인가. 쓰이지 않은 레이어는 계약상 필수인지부터 다시 확인한다.
4. **모드·자율성**: Direct/Planned/Orchestrated 선택이 실제 변경 규모와 위험에 맞았는가. interruption, correction, retry를 줄이려면 상류 spec, 모드 선택, checkpoint/task 중 어디를 고쳐야 하는가.
5. **스타일 학습**: 실행 단위당 스타일 교정 횟수가 프로젝트 후반으로 갈수록 줄었는가. 줄지 않았다면 constitution style 소비 지점과 계약 표현 중 어디가 문제인가.

## 검증 기간 중 개발 원칙

- 실제 측정에서 필요성이 확인되지 않은 새 스키마, 새 서브커맨드, 새 provider mirror, 메타 레이어 확장은 하지 않는다.
- 도그푸딩에서 발견된 마찰 제거(명령 단순화, validator 오탐 수정, 문서 정정)는 허용한다.
- 문서와 runtime 계약이 다르면 현재 CLI/schema/test evidence를 확인한 뒤 문서를 먼저 바로잡는다.
- 예외를 두고 싶으면 그 기능이 위 5가지 기준 중 어느 값을 개선하는지 먼저 적는다. 적을 수 없으면 하지 않는다.
