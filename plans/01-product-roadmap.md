# Plan2Agent 제품 기준과 고도화 로드맵

이 문서는 Plan2Agent(P2A)의 제품 방향, MVP 범위, 산출물 구조, task 분할 기준, 고도화 로드맵, v2 handoff, 반복/고도화 개발 구조를 정의하는 제품 정본이다. 앞으로 기능을 추가하거나 하네스를 고도화할 때 이 문서를 제품 기준으로 사용한다. 반복/고도화 개발의 상세 구현 계약은 `docs/iteration-spec.md`에서 관리한다.

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
- task 상태와 의존성 관리 (`scripts/p2a_tasks.mjs` Node.js CLI로 충족)

v1 제외 범위:

- 실제 agent 자동 실행
- 복잡한 시각 캔버스 편집기
- Neo4j, pgvector 기반 지식 그래프
- 코드 diff 자동 분석
- 기획 변경에 따른 재작업 task 자동 생성

v2 이후 후보:

- Gate D를 통과한 기획 산출물을 실제 개발 대상 프로젝트 디렉터리로 인계
- 개발 대상 프로젝트에 AI 개발 도구(skill, subagent, command shim, task CLI)를 복사하고 초기 개발 환경 세팅
- 복잡한 task 실행을 위해 `team-bigfive`의 Team Big Five 실행 패턴을 Codex, Claude Code, Gemini CLI용 skill/subagent로 이식하고 Plan2Agent task와 연결
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

- 확정된 기획 산출물을 개발 대상 프로젝트에 배치한다.
- 개발 대상 프로젝트에 Plan2Agent 개발 도구를 설치하거나 복사한다.
- 대상 프로젝트에는 선택적으로 `team-bigfive`의 팀 실행 패턴을 CLI별 adapter로 설치해 복잡한 task의 협업 실행과 상호 검증에 활용한다.
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
- v2의 첫 목표는 개발 대상 프로젝트에 산출물과 AI 개발 도구를 인계하는 부트스트랩 도구로 둔다.
- agent 자동 실행의 첫 연동 대상은 Codex로 둔다.

## 8-1. v2 개발 인계와 환경 세팅

v2의 첫 고도화 목표는 v1 하네스가 만든 산출물을 실제 개발 프로젝트로 옮기고, 그 프로젝트 안에서 AI agent가 바로 task를 실행할 수 있도록 개발 도구를 설치하는 것이다. 이 단계는 agent 자동 실행의 전제 조건이며, 자동 실행 자체는 포함하지 않는다.

현재 구현 상태:

- 완료: Gate D 통과 여부 확인, 원본 `artifacts/<project_id>/` 검증, 산출물 copy/move, `--include-intake`, `--overwrite`, `--dry-run`, `.plan2agent/artifacts/` 생성, `manifest.json`, `project.config.json`, `p2a_tasks.mjs`, `validate_artifacts.mjs`, schema 복사.
- 완료: `task-graph.sourceSpec`를 대상 프로젝트 기준 `spec.json`으로 rebase한다.
- 완료: 대상 프로젝트의 package manager와 test/lint/typecheck 명령을 best-effort로 감지해 `project.config.json`에 기록한다.
- 미구현: `--tools codex,claude,gemini` 기반 skill/subagent/command shim 복사.
- 미구현: `--include-team-bigfive` 기반 Team Big Five adapter 선택 설치.
- 제외: AI agent 자동 실행, 코드 변경 자동 생성, 테스트 자동 실행/수집, PR 생성, branch/worktree 자동 생성, 여러 agent 병렬 실행 조율.

핵심 흐름:

1. Gate D를 통과한 `artifacts/<project_id>/` 산출물을 선택한다.
2. 사용자가 지정한 개발 대상 디렉터리로 산출물을 복사하거나 이동한다.
3. 대상 프로젝트 안에 `plan2agent/` 또는 `.plan2agent/` 작업 디렉터리를 만든다.
4. `product-spec.md`, `implementation-plan.md`, `spec.json`, `task-graph.json`, `review-report.md`를 대상 프로젝트에 배치한다.
5. Codex, Claude Code, Gemini CLI에서 사용할 skill, subagent, command shim을 대상 프로젝트에 복사한다.
6. 선택한 CLI에는 `team-bigfive` 기반 팀 실행 adapter를 함께 설치해 여러 agent가 협업해야 하는 task 실행에 사용할 수 있게 한다.
7. task 실행, 상태 변경, 검증 명령을 대상 프로젝트 기준으로 사용할 수 있게 초기 설정 파일을 만든다.

대상 프로젝트 구조:

```text
<target-project>/
  .plan2agent/
    artifacts/
      product-spec.md
      implementation-plan.md
      spec.json
      task-graph.json
      review-report.md
      review.json
      status.md
    team-harnesses/
      team-bigfive/
        source-manifest.json
        adaptation-notes.md
    manifest.json
    project.config.json
  .agents/
    skills/
    agents/
  .codex/
    agents/
  .claude/
    skills/
    agents/
  .claude-plugin/
    team-bigfive/
  .gemini/
    agents/
    commands/
      p2a/
  scripts/
    p2a_tasks.mjs
    validate_artifacts.mjs
  schemas/
```

초기 CLI:

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target /path/to/target-project \
  --mode copy
```

현재 구현된 옵션:

- `--project-id`: 인계할 Plan2Agent 프로젝트 id
- `--artifacts`: 원본 산출물 디렉터리
- `--target`: 개발 대상 프로젝트 디렉터리
- `--mode copy|move`: 산출물 복사 또는 이동 방식
- `--include-intake`: intake 산출물도 함께 인계
- `--overwrite`: 기존 대상 파일 덮어쓰기 허용
- `--dry-run`: 실제 파일 쓰기 없이 계획만 출력

목표 확장 옵션:

- `--tools codex,claude,gemini`: 복사할 AI 도구 범위
- `--include-team-bigfive`: 선택한 CLI용 `team-bigfive` 기반 팀 실행 adapter 설치
- `--team-bigfive-source`: `team-bigfive` 원본 경로 또는 Git URL
- `--team-bigfive-targets codex,claude,gemini`: Team Big Five adapter 설치 대상 CLI

v2 부트스트랩 도구가 만들어야 할 결과:

- 대상 프로젝트 안에 기획 산출물 디렉터리 생성
- 대상 프로젝트 안에 AI 개발 도구 디렉터리 생성
- task graph 기준의 개발 시작 명령 안내
- 대상 프로젝트의 패키지 매니저, 테스트 명령, lint 명령을 기록하는 설정 파일
- 복사된 도구와 산출물의 출처를 기록하는 manifest
- 선택 설치된 외부 실행 하네스(`team-bigfive` 등)의 버전, 출처, CLI별 adapter, 사용 조건 기록

인계 도구가 파일을 쓰기 전에 확인할 조건:

- `spec.json`이 존재한다.
- `task-graph.json`이 존재한다.
- `review-report.md`와 `review.json`이 존재한다.
- intake의 모든 `CQ-n`이 `spec.json.clarifying_question_disposition`에서 처분되어 있다.
- `spec.json.approval`이 `approved`다.
- `spec.json.open_decisions`가 비어 있다.
- `task-graph.json`은 schema 검증을 통과한다.
- task dependency는 같은 graph 안의 task id만 참조한다.
- task graph에 cycle이 없다.
- `review.json.blocking_issues`가 비어 있다.
- 승인된 Gate B가 있으면 `status.md`에 Gate B approval audit block이 있다.

Manifest 계약:

```json
{
  "schema_version": "p2a.handoff.v1",
  "projectId": "example-project",
  "sourceArtifacts": "artifacts/example-project",
  "targetProject": "/path/to/target-project",
  "handoffMode": "copy",
  "createdAt": "2026-06-13T00:00:00.000Z",
  "includedTools": ["p2a_tasks", "validate_artifacts"],
  "externalHarnesses": [],
  "artifactFiles": [
    ".plan2agent/artifacts/product-spec.md",
    ".plan2agent/artifacts/implementation-plan.md",
    ".plan2agent/artifacts/spec.json",
    ".plan2agent/artifacts/task-graph.json",
    ".plan2agent/artifacts/review-report.md",
    ".plan2agent/artifacts/review.json",
    ".plan2agent/artifacts/status.md"
  ],
  "toolFiles": [
    "scripts/p2a_tasks.mjs",
    "scripts/validate_artifacts.mjs"
  ]
}
```

`project.config.json`은 대상 프로젝트의 개발 명령을 기록한다.

```json
{
  "schema_version": "p2a.project_config.v1",
  "packageManager": "npm",
  "installCommand": "npm install",
  "testCommand": "npm test",
  "lintCommand": "npm run lint",
  "typecheckCommand": "npm run typecheck",
  "taskGraph": ".plan2agent/artifacts/task-graph.json",
  "teamBigFive": {
    "enabled": false
  },
  "notes": ["TODO: 사용자 확인"]
}
```

Team Big Five 선택 통합:

- `team-bigfive`는 확정된 task를 여러 agent가 협업해 구현하고 검증할 때 사용하는 실행 하네스다.
- Plan2Agent는 아이디어를 명세와 task graph로 변환하고, `team-bigfive`는 복잡한 task 실행을 돕는다.
- 원본은 Claude Code plugin 구조이므로 Codex/Gemini에는 직접 복사하지 않고 CLI-native skill/subagent/command shim 형태로 변환한다.
- `_workspace/`는 실행 감사 추적용이고 `.plan2agent/artifacts/`는 승인된 기획 원본이다. 두 디렉터리를 섞지 않는다.
- 외부 하네스 버전과 출처는 manifest에 기록한다.

인계 후 개발 진행 흐름:

1. `node scripts/p2a_tasks.mjs ready --graph .plan2agent/artifacts/task-graph.json`로 시작 가능한 task를 확인한다.
2. `node scripts/p2a_tasks.mjs prompt --graph .plan2agent/artifacts/task-graph.json <task-id>`로 agent prompt를 만든다.
3. 단일 agent에 적합한 task는 Codex, Claude Code, Gemini CLI 중 설치된 도구로 구현한다.
4. 여러 영역이 맞물리는 task는 선택한 CLI에서 Team Big Five kickoff prompt로 팀 실행을 시작한다.
5. 대상 프로젝트의 test, lint, typecheck 명령으로 검증한다.
6. 통과하면 `done`, 막히면 `block`으로 task 상태를 기록한다.

안전 기준:

- 기본 동작은 복사다. 이동은 사용자가 명시한 경우에만 허용한다.
- 대상 프로젝트 밖으로 파일을 쓰지 않는다.
- `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다.
- `.env`, credential, local secret 파일은 복사 대상에 포함하지 않는다.
- 도구 복사는 Plan2Agent가 관리하는 skill, subagent, command shim, task CLI로 제한한다.
- 외부 하네스 설치는 사용자가 명시한 경우에만 수행하고, 출처와 버전을 manifest에 기록한다.
- package install이나 shell 기반 개발 명령 실행은 인계 도구의 기본 동작에 포함하지 않는다.

v2 handoff의 1차 완료 기준:

- Gate D 통과 산출물만 인계할 수 있다.
- 대상 프로젝트에 `.plan2agent/artifacts/`가 생성된다.
- 대상 프로젝트에 `p2a_tasks.mjs`, `validate_artifacts.mjs`, schema가 복사된다.
- 대상 프로젝트에서 `p2a_tasks.mjs ready`와 `p2a_tasks.mjs prompt`를 실행할 수 있다.
- `manifest.json`과 `project.config.json`이 생성된다.
- `--dry-run`으로 파일 변경 계획을 먼저 확인할 수 있다.
- 기존 파일 충돌 시 명확한 오류를 내고 중단한다.

v2 handoff의 확장 완료 기준:

- 대상 프로젝트에 선택한 AI 도구 skill/subagent/command shim이 복사된다.
- `--include-team-bigfive` 사용 시 선택한 CLI에서 Team Big Five adapter의 skill/agent/command 파일을 인식할 수 있는 구조로 설치된다.

## 8-2. 반복/고도화 개발 아키텍처

반복/고도화 개발은 v1의 greenfield 흐름 이후, 이미 만들어진 산출물과 대상 프로젝트 위에 작은 기능, 개선, 수정, 재작업을 계속 얹는 구조다.

상세 구현 계약은 `docs/iteration-spec.md`를 정본으로 본다. 이 섹션은 제품 로드맵 관점의 요약과 현재 구현 상태만 유지한다.

현재 구현 상태:

- 완료: `scripts/p2a_iteration.mjs init`으로 greenfield `artifacts/<project_id>/gate-*` 구조를 `iterations/<iteration_id>/gate-*` 구조로 변환한다.
- 완료: 변환 시 `status.md`를 반복 인덱스로 재작성하고, `current-spec.json` 포인터와 lazy `maintenance/README.md`를 생성한다.
- 완료: 이동된 spec/task graph/review를 다시 검증하고, `task-graph.sourceSpec`를 반복 구조 기준으로 rebase한다.
- 완료: `p2a_iteration.mjs current`와 `p2a_tasks.mjs --artifacts`가 active iteration을 자동 인식한다.
- 완료: `p2a_iteration.mjs validate`가 active 반복 구조, Gate B-D readiness, close-ready task 완료 조건을 검증한다.
- 완료: `p2a_iteration.mjs open`이 archived + composed baseline 위에 새 active 반복 skeleton과 metadata를 생성한다.
- 완료: `p2a_iteration.mjs draft`가 current-spec baseline과 변경 아이디어로 Gate A/B delta draft 산출물을 생성한다.
- 완료: `p2a_iteration.mjs validate --allow-planning`/`--stage`가 Gate A-ready, Gate B draft, Gate B approved planning state를 검증한다.
- 완료: `p2a_iteration.mjs draft`가 Gate A-only 초기 반복에서 Gate B 초안을 생성한다.
- 완료: `p2a_iteration.mjs promote-spec`가 approved active spec을 current-spec에 기록하되, 후속 반복에서는 baseline/composition pointer를 보존한다.
- 완료: `p2a_iteration.mjs diff-tasks`가 active spec과 baseline field 차이로 Gate C task graph 초안을 생성한다.
- 완료: `p2a_iteration.mjs context`/`validate --stage gate-c-draft`/`promote-tasks`와 `p2a-task-author` 스킬로 agent 저작 Gate C task 게이트(초안 저작 -> 사람 승인 audit -> 정본 승격)를 제공한다. 정식 `p2a.task_context.v1` 스키마와 producer-side 검증을 포함한다. 상세 계약은 `docs/iteration-spec.md` §10이다.
- 완료: `p2a_iteration.mjs compose`가 approved + close-ready 반복 spec들을 `current-spec.json` effective view로 조합하며, conflict 기본 경로는 쓰기 전에 실패한다.
- 완료: `p2a_handoff.mjs --iteration-id active`가 반복 구조 active 산출물과 `current-spec.json`을 대상 프로젝트로 인계한다.
- 완료: `p2a_iteration.mjs close`가 close-ready active 반복을 archived metadata로 표시하고 다음 `open`의 close 조건으로 고정한다.
- 완료: `p2a_iteration.mjs validate --audit-archive`가 close 시점 존재 여부/hash로 archived artifact 변경을 감지한다.
- 완료: `p2a_iteration.mjs maintenance add`가 상시 maintenance task graph를 lazy 생성/append한다.
- 부분 완료: 구조적 diff와 사용자 질문 재생성을 포함한 baseline-aware intake/spec 고도화.
- 부분 완료: 구조적 diff 기반 재작업 task 자동 생성. 현재는 field-level `diff-tasks` 초안이며 semantic diff는 후속이다.
- 미구현: agent 실행 로그, worktree 분리, 결과 diff 연결.

반복 단위:

- 분절 단위는 `iteration`이다.
- 반복 하나는 기능 반복 또는 고도화 반복 하나다.
- 닫힌 반복은 append-only로 보존하고, 변경/누락/재작업은 다음 반복의 새 task로 남긴다.
- 반복 하나는 대략 10~50 task 안에 들어오게 하고, 큰 기능은 여러 반복으로 나눈다.
- `core`, `cluster`, `starter` 같은 영역은 반복 분절 축이 아니라 task의 `targetArea` 태그로 둔다.

생명주기:

```text
open iteration -> task 실행 -> 모든 task done -> 사용자 close -> archived -> next iteration open
```

규칙:

- 동시에 열린 기능 반복은 1개다.
- 작은 fix, 문서 수정, 패치성 변경은 상시 `maintenance` 반복에 append한다.
- 반복 전환은 암묵적으로 일어나지 않는다. 모든 task done과 사용자 close가 모두 만족될 때만 마감한다.
- 마감 시 해당 반복을 `archived`로 동결하고, 루트 `status.md` 반복 인덱스에 표시한다.
- 마감 시 필요하면 개발 대상 프로젝트로 재인계하고 git 커밋으로 산출물 기준점을 남긴다.
- 병렬 반복, branch별 반복, worktree별 반복은 후속 고도화로 둔다.

반복 개발 산출물 구조:

```text
artifacts/<project>/
  status.md                         # 반복 인덱스 + 현재 활성 포인터
  current-spec.json                 # 현재 유효 spec 조합본 또는 초기 포인터
  iterations/
    <iter-id>/
      gate-a-intake/
        intake.json
        intake.md
      gate-b-spec/
        product-spec.md
        implementation-plan.md
        spec.json
      gate-c-task-graph/
        task-graph.json
      gate-d-review/
        review-report.md
        review.json
    maintenance/
      README.md
      gate-c-task-graph/
        task-graph.json
```

`status.md`는 기존 v1의 standing 진행상태/결정 인덱스 역할을 확장해 반복 인덱스와 현재 활성 포인터를 함께 갖는다. `current-spec.json`은 모든 완료 반복의 유효 spec을 조합한 현재 기준이며, 다음 intake/spec 단계가 baseline으로 읽는 파일이다. 현재 구현은 첫 반복 thin pointer와 approved + close-ready 반복들을 조합하는 `compose` 명령을 제공한다.

교차 반복 의존성:

- 각 반복의 `dependencies`는 같은 반복 안의 task id만 참조한다.
- 이전 반복은 생명주기상 전부 done인 baseline으로 전제한다.
- “v1 위에 짓는다”, “starter 배포 구조를 전제로 한다” 같은 문맥은 task `description`과 `sourceSpecRefs`로 기록한다.
- `sourceSpecRefs`는 `current-spec.json`의 안정적인 spec 항목 id 또는 반복 spec 항목을 가리킨다.
- 반복 간 dependency를 `dependencies`에 직접 넣지 않는다. 그래야 기존 task graph schema와 validator를 유지할 수 있다.

반복 개발 흐름:

```text
현재 유효 spec(current-spec.json)
  + 변경 아이디어
      |
      v
baseline-aware Gate A/B 재실행
      |
      v
다음 반복 생성
  - delta spec
  - 새 task graph
  - 과거 done 보존
      |
      v
status.md/current-spec.json 갱신
      |
      v
p2a_handoff --overwrite
      |
      v
대상 프로젝트 .plan2agent 동기화
      |
      v
p2a_tasks로 이어서 개발
```

구현 조각 순서:

| 순서 | 조각 | 상태 | 이유 |
| --- | --- | --- | --- |
| 1 | 레이아웃/인덱스 규약 + greenfield migration | 완료 | `p2a_iteration.mjs init`으로 Gate B-D까지 있는 greenfield bundle을 반복 구조로 변환한다. |
| 2 | `status.md` 반복 인덱스 | 부분 완료 | init/open/close 전이는 기록한다. 전체 반복 history 누적 렌더링은 후속이다. |
| 3 | `current-spec.json` 조합 규칙 | 완료 | `p2a_iteration.mjs compose`가 approved + close-ready 반복들을 current-effective view로 조합한다. |
| 4 | `p2a_tasks` 활성 반복 인식 | 완료 | `--artifacts`가 active 반복 graph를 찾아 task 조회와 상태 변경에 사용한다. |
| 4-1 | 반복 구조 validator | 완료 | `p2a_iteration.mjs validate`가 ready 반복, planning stage, close-ready, archive audit를 검증한다. |
| 4-2 | 반복 open skeleton | 완료 | `p2a_iteration.mjs open`이 archived + composed baseline 위에 새 반복 디렉터리와 metadata를 만든다. |
| 5 | baseline-aware Gate A/B draft | 부분 완료 | `draft`가 Gate A-only 초기 Gate B 초안과 baseline 기반 delta 초안을 만든다. 질문 재생성 고도화는 후속이다. |
| 5-1 | Gate B 승인/current-spec 반영 | 완료 | `promote-spec`가 approved active spec을 current-spec에 기록하고 후속 반복의 composition pointer를 보존한다. |
| 5-2 | diff 기반 task graph 초안 | 부분 완료 | `diff-tasks`가 field-level task graph 초안을 만든다. semantic diff는 후속이다. |
| 6 | handoff 적응 | 완료 | `p2a_handoff.mjs`가 active 반복 산출물과 current-effective view를 대상 프로젝트로 복사한다. |
| 7 | 반복 open/close 명령 | 완료 | 반복 생성, close-ready 마감, archived metadata 표시, composed baseline 기준 다음 반복 open을 자동화한다. |

초기 migration 명령:

```bash
node scripts/p2a_iteration.mjs init \
  --artifacts artifacts/<project_id> \
  --iteration-id v1-mvp
```

migration 규칙:

1. 기존 `gate-a-intake/`, `gate-b-spec/`, `gate-c-task-graph/`, `gate-d-review/`를 `iterations/v1-mvp/` 아래로 이동한다.
2. 루트 `status.md`는 standing 진행상태 문서에서 반복 인덱스로 확장한다.
3. 루트 `current-spec.json`은 `iterations/v1-mvp/gate-b-spec/spec.json`을 기준으로 생성한다.
4. `v1-mvp` 반복은 active로 시작하고, `p2a_iteration close`로 close-ready 검증 후 archived metadata를 기록한다.
5. 다음 기능 추가는 새 반복을 열고, 작은 fix는 `p2a_iteration.mjs maintenance add`로 `iterations/maintenance/gate-c-task-graph/task-graph.json`에 append한다.
6. 후속 도구는 루트 `status.md`의 활성 반복 graph 경로를 읽어 `p2a_tasks`와 handoff 입력을 결정한다.

## 8-3. agent 실행 결과 추적 후속 설계

agent 실행 결과 추적은 handoff와 반복 구조가 안정된 뒤 붙인다. 이 항목은 아직 별도 구현이 없으며, 아래 계약을 설계해야 한다.

후속 범위:

- task별 branch 또는 worktree 생성
- agent 실행 세션 생성
- Plan2Agent task를 Codex, Claude Code, Gemini CLI별 kickoff prompt로 자동 변환
- 실행 로그 저장
- 변경 파일과 task 연결
- test, lint, typecheck 결과 수집
- 실패 task의 재시도 기록
- PR 생성 또는 변경 요약 생성

task가 실제 agent 실행 결과와 연결되는 시점에는 task 또는 run log에 다음 필드를 추가한다.

- `runId`
- `resultSummary`
- `changedFiles`
- `verification`
- `startedAt`
- `completedAt`
- `agentTool`
- `workspaceRef`

이 기능은 agent 자동 실행보다 먼저 구현한 handoff, 그리고 반복별 task graph 기준이 안정되어야 일관되게 추적할 수 있다.

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
docs/
  harness-spec.md
  iteration-spec.md
artifacts/
  <project_id>/
    status.md                      # 모든 게이트에서 갱신되는 standing 진행상태/결정 인덱스, top-level
    gate-a-intake/
      intake.json
      intake.md
    gate-b-spec/
      product-spec.md
      implementation-plan.md
      spec.json
    gate-c-task-graph/
      task-graph.json
    gate-d-review/
      review-report.md
```

결정된 내용과 고도화 시 결정할 내용:

- 결정됨: v1은 `artifacts/<project_id>/gate-*` 구조를 사용한다.
- `runs/` 실행 로그 디렉터리는 v2 agent 실행 로그 관리 항목으로 둔다.
- 프로젝트 단위를 어떻게 식별할지 정한다.
- PostgreSQL 도입 시점을 정한다.

권장 기본값:

- v1 프로토타입은 파일 기반으로 시작한다.
- PostgreSQL은 다중 사용자, 검색, 실행 이력 관리가 필요해질 때 도입한다.
- pgvector와 Neo4j는 v1 범위에서 제외한다.

## 11. 프론트엔드 선택

현재 기준:

- v1에는 웹 UI가 없으며 Node.js CLI로 제공한다.
- 한 문장 입력, 대화형 보강, 명세 검토, task graph 검증과 task 상태 관리는 CLI와 파일 산출물로 처리한다.
- UI(task board)는 v2 백로그로 둔다.

v2·v3 후보:

- v2 일반 task board: task 상태와 진행 상황을 화면에서 관리한다.
- v2 React Flow: task graph, 흐름도, 의존성 표현이 필요할 때 붙인다.
- v3 TLDraw: 자유로운 캔버스 기반 기획 입력에 사용한다.

결정된 내용:

- v1 UI를 task board 중심으로 만들지, graph 중심으로 만들지에 대한 판단은 완료됐다. v1은 UI 없이 Node.js CLI로 제공한다.
- React Flow는 v1에 포함하지 않고 v2 후보로 둔다.
- TLDraw는 v1·v2 범위가 아니라 v3 캔버스 기반 시각 기획 입력 후보로 둔다.

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

- v2: 기획 산출물 개발 프로젝트 인계 도구
- v2: AI 개발 도구(skill, subagent, command shim) 복사와 개발 환경 부트스트랩
- v2: `team-bigfive` 기반 Codex/Claude Code/Gemini CLI 팀 실행 하네스 선택 통합
- v2: task별 agent 세션 실행과 로그 관리
- v2: 코드 변경 결과와 task 연결
- v2: 기획 변경 diff 기반 재작업 task 생성
- v2: 반복/고도화 개발 아키텍처
- v2: worktree 또는 branch 기반 task 격리
- v3: 캔버스 기반 시각 기획 입력
- v3: pgvector 또는 Neo4j 기반 plan-code 계보 추적

## 15. 다음 개발 액션

1. 완료: fixture coverage를 cache library 외 API/integration domain으로 확장했다(`fixtures/webhook-api-service`).
2. 완료: e2e artifact-root golden fixture를 추가했다(`fixtures/_e2e/webhook-api-service`).
3. CI 검증 연결은 사용자 관리 항목으로 둔다.
4. 완료: v1 프로토타입은 Node.js CLI로 결정했고, UI(task board)는 v2 백로그로 둔다.
5. 완료: §3의 task 상태와 의존성 관리는 `scripts/p2a_tasks.mjs`로 충족한다.
6. 부분 완료: v2 개발 인계/환경 세팅은 §8-1 기준으로 관리한다. 현재 구현은 산출물/검증 도구 인계까지이며, AI 도구 복사와 Team Big Five adapter 설치가 남아 있다.
7. 부분 완료: 반복/고도화 개발 구조는 §8-2 기준으로 관리한다. 현재 구현은 greenfield -> iteration 초기 migration, planning stage validator, `p2a_tasks` active iteration 인식, open/close, Gate A/B draft 생성, promote-spec, field-level diff-tasks, current-spec composition, archive audit, active iteration handoff까지이며, semantic diff와 handfree 실행 추적이 남아 있다.
8. 미완료: v2 agent 실행 로그, worktree 분리, 결과 diff 연결 방식은 §8-3 기준으로 별도 설계/구현한다.
