# Plan2Agent Quickstart

Plan2Agent는 자연어 요청을 이해해 범위와 계획을 짧게 확인하고, 구현·복구·검증의 다음 행동을 안내하는 개발 비서다.

이 문서는 새 프로젝트에서 첫 실행 가능한 산출물을 만드는 최단 경로만 다룬다. 명령 옵션은 [CLI 사용자 가이드](cli-reference.md), 산출물 계약은 [하네스 사용자 가이드](harness-guide.md)를 기준으로 삼는다.

문서 홈: [Plan2Agent Docs](README.md)

## 설치

프로젝트 디렉터리에서 한 번만 초기화한다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
```

부모 AI 세션의 모델 설정을 그대로 쓰려면 `quality` 대신 `inherit`을 선택한다.

## 개발 시작

AI agent에게 원하는 결과를 자연어로 말하면 된다. 터미널에서 시작할 때는 한 문장을 넘긴다.

```bash
p2a next --idea "로그인 API 오류 메시지를 한국어로 바꿔줘"
```

이미 요구사항 문서가 있으면 그 경로를 사용할 수 있다.

```bash
p2a next --entry docs/idea.md
```

P2A와의 대화는 보통 다음 순서다.

1. P2A가 목표, 이번에 바꿀 최소 범위, 유지할 동작을 짧게 정리한다.
2. 맞으면 “이 이해로 계획해”라고 답한다. 다르면 바꿀 부분만 말한다.
3. P2A가 변경 방법과 검증 방법을 요약하면 “이 계획으로 개발해”라고 답한다.
4. 이후 구현, 필요한 수정, 위험도에 맞는 검증은 agent가 이어서 처리한다.

제품 결과가 달라지는 선택이 있을 때만 질문이 하나 더 생긴다. 일반적인 작은 수정에서는 내부 단계 이름, 파일 경로, 해시나 승인 명령을 알 필요가 없다.

## 진행 중에는

상태를 잊었거나 다음 행동을 모르겠으면 이것만 실행한다.

```bash
p2a next
```

P2A는 현재 이해한 상황, 필요한 행동 하나, 그 행동을 권하는 이유를 보여 준다. 복구할 수 있는 검증 실패는 agent가 수정하고 같은 범위를 다시 확인한다. 사용자 결정이나 추가 권한이 필요한 경우에만 멈춰서 묻는다.

내부 상태와 정확한 명령이 필요한 문제 해결 상황에서는 상세 출력을 켠다.

```bash
p2a next --details
p2a doctor --dev
```

## 개발이 끝나면

P2A가 변경 결과와 통과한 검증을 요약하고 다음 선택을 제시한다.

- 특이 사항이 없으면 `종료`를 권장한다.
- 구현을 한 번 더 살펴보고 싶으면 `코드 리뷰`를 선택한다.
- P2A 진행 중 지연, 잘못된 안내, 불필요한 단계가 있었다면 `회고`를 선택한다.

깨끗한 코드 리뷰 뒤에는 같은 메뉴를 반복하지 않고 종료할지만 한 번 묻는다. 회고할 문제가 없다고 답하면 문서를 만들지 않는다.

## P2A가 내부에서 하는 일

P2A는 작업 크기와 위험에 따라 Direct/Planned 실행 또는 Orchestrated 작업 분해를 선택한다. 문서만 바뀌면 관련 파일 검사만 하고, 제품 코드 검증이 필요하면 설정된 테스트·lint·typecheck를 실행한다. 유효한 제품 검증 뒤 문서만 바뀐 경우에는 제품 전체를 다시 검사하지 않고 문서 관련 검사만 추가한다.

이 내부 계약이나 수동 운영 명령이 필요할 때만 아래 상세 문서를 본다.

## 다음에 볼 문서

- [Adaptive Harness 사용자 흐름](adaptive-harness-user-flow.md) — Gate 승인부터 실행 방식 선택, context routing, 검증·종료까지의 전체 여정
- [CLI 사용자 가이드](cli-reference.md) — 명령별 사용법, handoff와 proposal 흐름
- [하네스 사용자 가이드](harness-guide.md) — Gate A-C, 산출물 schema, 검증과 문제 해결
- [반복/고도화 개발 스펙](iteration-spec.md) — 반복 구조, close/open, 변경분 task 계약
- [감독형 개발 실행 레퍼런스](supervised-execution.md) — ready task 실행, monitor gate, planned checkpoint, retry recovery
- [하네스 구현 기준](harness-spec.md) — P2A skill/subagent와 mirror를 수정할 때의 원칙
