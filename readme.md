# Plan2Agent

Plan2Agent(P2A)는 사용자의 한 문장 아이디어를 출발점으로 삼아, 대화로 기획을 보강하고, 개발 가능한 명세와 task graph로 분해하는 planning harness다.

현재 v1 하네스는 코드 변경을 자동 실행하지 않는다. Claude Code, Codex, Gemini CLI가 공통 skill과 subagent를 사용해 `idea -> spec -> task graph -> review` 흐름을 read-only로 수행하도록 구성되어 있다.

## 현재 범위

v1에서 하는 일:

- 한 문장 아이디어를 구조화한다.
- 부족한 정보를 질문 목록으로 만든다.
- 제품 명세와 구현 명세를 생성한다.
- 구현 가능한 task graph로 분해한다.
- task별 agent 실행 prompt 초안을 만든다.
- 명세와 task graph의 누락, 과대 task, 의존성 오류를 검토한다.

v1에서 하지 않는 일:

- 실제 코드 변경 자동 실행
- dependency 설치 또는 shell 기반 구현 작업
- 병렬 worktree 생성
- 코드 diff 자동 분석
- agent 실행 결과 자동 병합
- DB 또는 지식 그래프 저장소 운영

## 기준 문서

- [제품 기준과 고도화 로드맵](plans/01-product-roadmap.md)
- [하네스 구현 기준](plans/02-harness-spec.md)

## 하네스 구조

공통 skill 원본:

```text
.agents/skills/
  p2a-harness/
  p2a-intake/
  p2a-spec/
  p2a-task-breakdown/
  p2a-review/
```

Claude Code용 구성:

```text
.claude/
  agents/
    p2a-requirements.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  skills/
    p2a-harness/
    p2a-intake/
    p2a-spec/
    p2a-task-breakdown/
    p2a-review/
```

Codex용 구성:

```text
.codex/agents/
  p2a-requirements.toml
  p2a-implementation-planner.toml
  p2a-task-graph.toml
  p2a-quality-reviewer.toml
```

Gemini CLI용 구성:

```text
.gemini/
  agents/
    p2a-requirements.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  commands/p2a/
    harness.toml
    intake.toml
    spec.toml
    task-breakdown.toml
    review.toml
```

## 역할

Subagents:

| 이름 | 역할 |
| --- | --- |
| `p2a-requirements` | 아이디어를 known facts, assumptions, clarification questions로 정리 |
| `p2a-implementation-planner` | 승인된 제품 명세를 구현 계획으로 변환 |
| `p2a-task-graph` | 구현 계획을 dependency-aware task graph로 분해 |
| `p2a-quality-reviewer` | 명세, 계획, task graph의 누락과 실행 리스크 검토 |

Skills:

| 이름 | 역할 |
| --- | --- |
| `p2a-harness` | 전체 workflow 실행 |
| `p2a-intake` | 초기 아이디어 분석과 질문 생성 |
| `p2a-spec` | 제품/구현 명세 생성 |
| `p2a-task-breakdown` | task graph 생성 |
| `p2a-review` | 산출물 검토 |

## 구동 방식

이 저장소는 현재 별도 서버를 실행하지 않는다. 각 CLI를 저장소 루트에서 실행하면, 해당 CLI가 repo-scoped skill, subagent, command 파일을 읽어 하네스를 사용한다.

공통 전제:

- 저장소 루트에서 CLI를 시작한다.
- 새 skill, subagent, command가 인식되지 않으면 CLI를 재시작하거나 reload 명령을 실행한다.
- v1 하네스는 read-only planning 용도다. 코드 수정, 패키지 설치, shell 실행을 요청하지 않는다.

## Claude Code 사용

저장소 루트에서 Claude Code를 시작한다.

```bash
claude
```

전체 하네스 실행:

```text
/p2a-harness 사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

단계별 실행:

```text
/p2a-intake <한 문장 아이디어>
/p2a-spec <intake 결과와 사용자 답변>
/p2a-task-breakdown <승인된 구현 명세>
/p2a-review <spec과 task graph>
```

Claude Code의 project skills는 `.claude/skills/`에서 읽히고, project subagents는 `.claude/agents/`에서 읽힌다. 새 디렉터리가 처음 추가된 경우 Claude Code 재시작이 필요할 수 있다.

## Codex 사용

저장소 루트에서 Codex를 시작한 뒤 skill을 명시적으로 호출한다.

```text
Use the $p2a-harness skill on this idea:
사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

Codex subagent까지 명시적으로 쓰려면 다음처럼 요청한다.

```text
Use the $p2a-harness skill.
Spawn p2a-requirements, p2a-implementation-planner, p2a-task-graph, and p2a-quality-reviewer only for read-only planning.
Wait for the agents and return a consolidated spec, task graph, and review report.
```

Codex custom agents는 `.codex/agents/*.toml`에 정의되어 있다. Codex는 subagent를 자동으로 spawn하지 않으므로, 병렬 또는 subagent 작업이 필요하면 prompt에서 명시해야 한다.

## Gemini CLI 사용

저장소 루트에서 Gemini CLI를 시작한다. command 파일을 수정한 직후라면 reload한다.

```text
/commands reload
/commands list
```

전체 하네스 실행:

```text
/p2a:harness 사용자의 식단 기록을 받아 영양 균형을 분석하고 주간 리포트를 보여주는 앱을 만들고 싶다.
```

단계별 실행:

```text
/p2a:intake <한 문장 아이디어>
/p2a:spec <intake 결과와 사용자 답변>
/p2a:task-breakdown <승인된 구현 명세>
/p2a:review <spec과 task graph>
```

Gemini CLI에서 `.gemini/commands/p2a/harness.toml`은 `/p2a:harness` 명령이 된다. 하위 디렉터리의 `/`는 command namespace에서 `:`로 변환된다.

## 표준 워크플로우

1. Idea
   - 사용자가 한 문장으로 만들고 싶은 제품이나 기능을 설명한다.

2. Intake
   - `p2a-intake` 또는 `p2a-requirements`가 known facts, assumptions, clarification questions, `needs_user_decision`을 만든다.

3. Product Spec
   - 사용자의 답변과 명시된 가정을 바탕으로 `p2a-spec`이 제품 명세와 구현 명세를 만든다.

4. Approval Gate
   - 명세가 구현 가능한 수준인지 사용자가 승인한다.
   - 승인 전에는 task graph를 확정하지 않는다.

5. Task Breakdown
   - `p2a-task-breakdown` 또는 `p2a-task-graph`가 구현 명세를 task graph로 분해한다.

6. Review
   - `p2a-review` 또는 `p2a-quality-reviewer`가 누락된 결정, 과대한 task, 불명확한 acceptance criteria, 의존성 오류를 검토한다.

7. Final Planning Output
   - 최종 산출물은 Markdown 명세, 구현 계획, task graph JSON, review report다.

8. Implementation Handoff
   - v1에서는 여기서 멈춘다.
   - 실제 agent 실행, 코드 변경, worktree 분리, 결과 diff 연결은 v2 이후 범위다.

## Task Graph 기준

각 task는 최소한 다음 필드를 가진다.

```json
{
  "id": "task-001",
  "title": "Define product spec schema",
  "description": "Create the first JSON schema for Plan2Agent product specs.",
  "status": "todo",
  "dependencies": [],
  "acceptanceCriteria": [
    "Schema includes problem, target_users, goals, non_goals, core_flows, constraints",
    "Unknown required fields can be marked as needs_user_decision"
  ],
  "targetArea": "spec-schema",
  "suggestedAgentPrompt": "Create a Plan2Agent product spec JSON schema. Do not implement unrelated app code.",
  "sourceSpecRefs": ["spec.product"]
}
```

기준:

- `dependencies`는 task id를 참조한다.
- 기본 상태는 `todo`다.
- 완료 기준이 불명확하면 task를 확정하지 않는다.
- 너무 큰 task는 화면, API, 데이터 모델, 테스트, 문서 단위로 나눈다.

## 안전 정책

- v1 하네스는 read-only planning이다.
- 어떤 skill이나 subagent도 코드 변경을 지시하지 않는다.
- dependency 설치, shell 실행, git 조작은 v1 workflow에 포함하지 않는다.
- 불명확한 요구사항은 임의 구현하지 않고 `needs_user_decision`으로 남긴다.
- 실제 구현은 task graph 승인 이후 별도 단계에서 수행한다.

## 다음 고도화 작업

- `spec_json` schema 작성
- `task_graph_json` schema 작성
- `p2a-harness`가 역할별 subagent 사용 순서를 더 명확히 지시하도록 보강
- intake/spec/task-breakdown/review fixture 작성
- v2에서 agent 실행 로그, worktree 분리, 결과 diff 연결 추가

