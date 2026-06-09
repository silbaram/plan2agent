# Plan2Agent 제품 기준과 고도화 로드맵

이 문서는 Plan2Agent(P2A)의 제품 방향, MVP 범위, 산출물 구조, task 분할 기준, 고도화 로드맵을 정의한다. 앞으로 기능을 추가하거나 하네스를 고도화할 때 이 문서를 제품 기준으로 사용한다.

## 1. 프로젝트 기본 정보

- 프로젝트명: Plan2Agent
- 약어: P2A
- 저장소 이름: `plan2agent`
- 핵심 가치: 기획(Plan)의 변경 사항이 에이전트(Agent)를 통해 개발 가능한 명세와 task로 연결되고, 그 과정과 결과가 시맨틱 문서로 남는 순환 시스템을 만든다.

## 2. 프로젝트 방향

Plan2Agent는 사용자의 한 문장 아이디어를 출발점으로 삼아, 대화를 통해 기획을 구체화하고, 개발 가능한 명세와 task graph로 분해한 뒤, 그 task를 관리하는 하네스다.

제품 방향:

- v1은 "아이디어 입력 -> 대화 보강 -> 개발 명세 -> task graph 생성/관리"까지 담당한다.
- v1은 실제 agent 자동 실행보다, agent가 실행할 수 있는 수준의 task를 만드는 데 집중한다.
- v2 이후에 Codex, Claude Code, Gemini CLI 같은 agent 실행과 결과 추적을 붙인다.

현재 기준:

- Plan2Agent는 먼저 "기획/태스크 생성 하네스"로 개발한다.
- "agent 실행 오케스트레이터"는 v2 이후 고도화 항목으로 둔다.
- 사용자가 보는 핵심 산출물은 제품 명세와 task graph다.

## 3. MVP 범위

v1 포함 범위:

- 한 문장 아이디어 입력
- 부족한 정보를 묻는 대화형 보강
- 제품/기능 명세 Markdown 생성
- 구현 단계 도출
- agent 실행 가능한 task 분할
- task 상태와 의존성 관리

v1 제외 범위:

- 실제 agent 자동 실행
- 복잡한 시각 캔버스 편집기
- Neo4j, pgvector 기반 지식 그래프
- 코드 diff 자동 분석
- 기획 변경에 따른 재작업 task 자동 생성

v2 이후 후보:

- task별 agent 세션 실행 및 로그 관리
- 코드 변경 결과와 task 연결
- 기획 변경 diff 기반 task 재생성
- 캔버스 기반 시각 기획 입력
- 지식 그래프 기반 plan-code 계보 추적

## 4. 입력 방식

v1 권장 입력:

- 사용자가 한 문장으로 아이디어를 입력한다.
- 시스템이 부족한 항목을 질문한다.
- 질문 답변을 바탕으로 기획 명세를 만든다.

입력 예시:

```text
사용자의 식단 기록을 받아서 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

고도화 시 결정할 내용:

- 질문을 몇 단계까지 허용할지 정한다.
- 사용자가 답하지 않은 항목을 기본값으로 채울 수 있는지 정한다.
- v1에서 파일, 이미지, 캔버스 입력을 받을지 여부를 정한다.

권장 기본값:

- v1은 텍스트 입력과 대화형 질문만 지원한다.
- 이미지와 캔버스 입력은 v2 이후로 미룬다.

## 5. 기획 진행 단계

권장 상태 모델:

1. `Idea`: 사용자의 초기 한 문장 아이디어
2. `Clarifying Questions`: 구현에 필요한 정보 질문
3. `Product Spec`: 제품 목표, 사용자, 기능 범위 정리
4. `Implementation Plan`: 아키텍처, 화면/API/데이터 흐름 정리
5. `Task Breakdown`: 실행 가능한 task graph 생성
6. `Task Management`: task 상태, 의존성, 진행 상황 관리
7. `Review`: 산출물 검토와 수정

고도화 시 결정할 내용:

- 각 단계 전환 시 사용자 승인이 필요한지 정한다.
- 어느 단계부터 개발자가 바로 구현할 수 있는 산출물로 볼지 정한다.
- task 생성 전 반드시 확정해야 하는 필수 항목을 정한다.

권장 승인 게이트:

- 기획 명세 확정 전
- task graph 확정 전
- 실제 코드 변경 또는 agent 실행 전

## 6. 산출물 구조

v1 권장 산출물:

- 사용자에게 보여주는 Markdown 명세
- 내부 처리를 위한 구조화된 JSON
- task 목록 또는 task graph

기획 명세 기본 항목:

- 문제 정의
- 대상 사용자
- 핵심 기능
- 제외 범위
- 사용자 흐름
- 주요 화면 또는 인터페이스
- 데이터 모델 초안
- API 또는 외부 연동 초안
- 성공 기준

task graph 기본 필드:

- `id`
- `title`
- `description`
- `status`
- `dependencies`
- `acceptanceCriteria`
- `targetArea`
- `suggestedAgentPrompt`
- `sourceSpecRefs`

현재 기준:

- 내부 원본은 JSON으로 관리한다.
- 사용자가 보는 문서는 Markdown으로 렌더링한다.
- task graph의 의존성은 필수 필드로 둔다.
- task 상태값은 `todo`, `in_progress`, `blocked`, `done`으로 시작한다.

고도화 기준:

- task가 실제 agent 실행 결과와 연결되는 시점에는 `runId`, `resultSummary`, `changedFiles`, `verification` 필드를 추가한다.
- spec 항목과 task는 안정적인 id로 연결한다.

## 7. Task 분할 기준

권장 분할 기준:

- 하나의 task는 한 명의 agent 또는 개발자가 독립적으로 처리할 수 있어야 한다.
- task는 명확한 완료 기준을 가져야 한다.
- task 간 선후관계가 있으면 의존성으로 표시한다.
- 너무 큰 기능은 화면, API, 데이터 모델, 테스트 단위로 나눈다.

task로 만들기 좋은 단위:

- 프로젝트 초기 세팅
- 데이터 모델 정의
- 화면 또는 컴포넌트 구현
- API 엔드포인트 구현
- 비즈니스 로직 구현
- 테스트 추가
- 문서 업데이트

고도화 시 결정할 내용:

- task 크기의 상한을 어떻게 볼지 정한다.
- agent가 실행할 prompt를 task마다 자동 생성할지 정한다.
- task가 실패했을 때 재시도 task를 만들지 기존 task를 수정할지 정한다.

## 8. Agent 실행 관리 범위

v1 권장 범위:

- agent가 실행할 수 있는 task와 prompt를 만든다.
- 실제 agent 실행은 사용자가 수동으로 수행하거나 별도 단계로 둔다.
- 실행 로그, PTY 제어, worktree 관리는 v1에서 제외한다.

v2 이후 범위:

- task별 agent 세션 생성
- worktree 또는 branch 분리
- 실행 로그 저장
- 실패/재시도/중단 상태 관리
- 결과 diff와 task 연결

고도화 시 결정할 내용:

- 첫 번째로 연동할 agent를 무엇으로 할지 정한다.
- agent 실행을 백엔드에서 직접 제어할지, CLI 명령을 감싸는 방식으로 할지 정한다.
- task별 격리 단위를 branch, worktree, directory 중 무엇으로 둘지 정한다.

권장 기본값:

- v1은 agent 실행을 하지 않는다.
- v2 첫 연동 대상은 Codex로 둔다.

## 9. 변경 추적 방식

v1 권장 방식:

- 기획 명세와 task graph에 version을 둔다.
- 각 task는 어떤 spec 항목에서 생성됐는지 source를 가진다.
- 변경이 생기면 새 버전의 명세와 task graph를 생성한다.

v2 이후 방식:

- 이전 spec과 새 spec의 구조적 diff를 계산한다.
- 변경된 spec 항목에 연결된 task를 찾는다.
- 필요한 재작업 task를 자동 생성한다.
- 코드 변경 결과와 spec 항목의 연결을 저장한다.

고도화 시 결정할 내용:

- 변경 이력을 파일로 저장할지 DB로 저장할지 정한다.
- spec 항목마다 안정적인 id를 부여할지 정한다.
- 변경 diff를 사용자에게 어떤 형태로 보여줄지 정한다.

권장 기본값:

- v1은 파일 기반 versioning으로 시작한다.
- spec 항목과 task에는 안정적인 id를 둔다.

## 10. 저장소/DB 전략

v1 권장 방식:

- repo 안의 파일 기반 저장으로 시작한다.
- Markdown 문서와 JSON 산출물을 함께 관리한다.
- DB 도입은 agent 실행 로그와 다중 프로젝트 관리가 필요해진 뒤 판단한다.

기준 디렉터리 구조:

```text
plans/
  01-product-roadmap.md
  02-harness-spec.md
specs/
  <project-id>.md
  <project-id>.json
tasks/
  <project-id>.tasks.json
runs/
  <run-id>.json
```

고도화 시 결정할 내용:

- `specs/`, `tasks/`, `runs/` 디렉터리를 v1부터 만들지 정한다.
- 프로젝트 단위를 어떻게 식별할지 정한다.
- PostgreSQL 도입 시점을 정한다.

권장 기본값:

- v1 프로토타입은 파일 기반으로 시작한다.
- PostgreSQL은 다중 사용자, 검색, 실행 이력 관리가 필요해질 때 도입한다.
- pgvector와 Neo4j는 v1 범위에서 제외한다.

## 11. 프론트엔드 선택

현재 후보:

- TLDraw: 자유로운 캔버스 기반 기획에 적합하다.
- React Flow: task graph, 흐름도, 의존성 표현에 적합하다.
- 일반 task board: v1 task 관리 화면을 가장 빠르게 만들 수 있다.

v1 권장 방향:

- 한 문장 입력과 대화형 보강 화면을 먼저 만든다.
- 생성된 명세를 Markdown preview로 보여준다.
- 생성된 task를 board 또는 list로 관리한다.
- task 의존성을 보여줘야 할 때 React Flow를 붙인다.

v1에서 TLDraw를 미루는 이유:

- 현재 핵심은 자유로운 캔버스 편집이 아니라, 기획을 개발 가능한 task로 바꾸는 하네스다.
- 캔버스 입력은 schema와 task 분할 규칙이 안정된 뒤 붙이는 편이 낫다.

고도화 시 결정할 내용:

- v1 UI를 task board 중심으로 만들지, graph 중심으로 만들지 정한다.
- React Flow를 v1에 바로 포함할지 정한다.
- TLDraw를 v2 기능으로 명시할지 정한다.

## 12. 작업 방식

Plan2Agent 개발은 아래 흐름을 기본 협업 방식으로 둔다.

1. 대화: 특정 step의 아이디어와 의사결정을 구체화한다.
2. 문서화: 결정된 내용을 개발 가능한 spec 또는 plan 문서로 남긴다.
3. 개발: 확정된 spec과 task graph를 기준으로 실제 scaffold 또는 코드를 구현한다.
4. 구체화: 구현 중 나온 피드백을 다시 문서와 하네스 구조에 반영한다.

이 흐름은 Plan2Agent 자체의 제품 철학과도 같다. 사용자의 아이디어가 명세, task, 실행 결과, 변경 이력으로 이어지는 순환을 제품 안에서도 재현한다.

## 13. 현재 확정 기준

- v1의 최종 산출물은 task graph다.
- 기획 명세와 task graph 확정 시점에는 사용자 승인을 받는다.
- 내부 원본은 JSON, 사용자 표시용은 Markdown으로 둔다.
- task 의존성은 필수 필드로 둔다.
- v1은 웹 UI를 만들더라도 캔버스가 아니라 입력, 명세, task 관리 화면에 집중한다.

## 14. 고도화 백로그

- v2: task별 agent 세션 실행과 로그 관리
- v2: 코드 변경 결과와 task 연결
- v2: 기획 변경 diff 기반 재작업 task 생성
- v2: worktree 또는 branch 기반 task 격리
- v3: 캔버스 기반 시각 기획 입력
- v3: pgvector 또는 Neo4j 기반 plan-code 계보 추적

## 15. 다음 개발 액션

1. fixture coverage를 cache library 외 product domain으로 확장한다.
2. `scripts/sync_cli_assets.py`, `scripts/check_cli_parity.py`, `scripts/run_fixtures.py`를 CI에 연결한다.
3. v1 UI 또는 CLI 프로토타입 방식을 결정한다.
4. v2 agent 실행 로그, worktree 분리, 결과 diff 연결 방식을 설계한다.
