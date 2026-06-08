# Plan2Agent 하네스 구현 기준

참고 기준일: 2026-06-08

이 문서는 Plan2Agent v1 하네스의 구현 기준이다. Claude Code, Codex, Gemini CLI에서 같은 역할과 절차를 제공하기 위해 skill, subagent, command scaffold의 경로, 역할, 안전 정책, 수락 기준을 정의한다.

Plan2Agent의 핵심 가치는 기획 변경이 개발 가능한 명세와 task로 연결되고, 그 과정이 시맨틱 문서로 남는 순환 시스템을 만드는 것이다. 이 하네스는 그 순환 중 "아이디어를 명세와 task graph로 바꾸는 단계"를 먼저 고정한다.

## 1. MVP 하네스 목표

v1 하네스는 실제 코드 변경을 자동 실행하지 않는다. 대신 세 가지 CLI agent가 공통으로 사용할 수 있는 기획/분해 절차를 제공한다.

v1 책임:

- 사용자의 한 문장 아이디어를 구조화한다.
- 부족한 정보를 질문 목록으로 만든다.
- 제품 명세와 구현 명세를 생성한다.
- 구현 가능한 task graph로 분해한다.
- task별 agent 실행 prompt 초안을 만든다.
- task graph를 검토해 누락, 과대 task, 의존성 오류를 찾는다.

v1 제외:

- Claude Code, Codex, Gemini CLI의 실제 자동 실행
- 병렬 worktree 생성
- 코드 diff 자동 분석
- task 결과 자동 병합
- DB 또는 지식 그래프 저장소

## 2. 공통 하네스 모델

Plan2Agent는 CLI별 구현 차이를 감추기 위해 공통 역할 이름을 먼저 정의한다.

### Subagents

| 이름 | 역할 | v1 권한 |
| --- | --- | --- |
| `p2a-requirements` | 한 문장 아이디어를 질문과 제품 명세 초안으로 변환 | read-only |
| `p2a-implementation-planner` | 확정된 제품 명세를 구현 계획으로 변환 | read-only |
| `p2a-task-graph` | 구현 계획을 agent 실행 가능한 task graph로 분해 | read-only |
| `p2a-quality-reviewer` | 명세, 계획, task graph의 누락과 모순 검토 | read-only |

### Skills

| 이름 | 역할 | 입력 | 출력 |
| --- | --- | --- | --- |
| `p2a-intake` | 아이디어를 받아 질문 목록 생성 | 한 문장 아이디어 | 질문 목록, 가정 |
| `p2a-spec` | 답변을 제품/구현 명세로 정리 | 아이디어, 답변 | Markdown spec, JSON spec |
| `p2a-task-breakdown` | 구현 명세를 task graph로 분해 | JSON spec | task graph JSON |
| `p2a-review` | 산출물을 검토하고 수정 요청 생성 | spec, task graph | review report |
| `p2a-harness` | 전체 흐름을 순서대로 실행하는 상위 workflow | idea 또는 spec | spec, task graph, review |

MVP에서는 `p2a-harness`가 상위 skill이고, 나머지 skill은 단계별 재사용 단위다. subagent는 독립 검토와 전문 역할 분리를 위해 사용한다.

## 3. 기준 저장 구조

현재 scaffold는 아래 구조를 기준으로 유지한다.

```text
.agents/
  skills/
    p2a-harness/
      SKILL.md
    p2a-intake/
      SKILL.md
    p2a-spec/
      SKILL.md
    p2a-task-breakdown/
      SKILL.md
    p2a-review/
      SKILL.md

.codex/
  agents/
    p2a-requirements.toml
    p2a-implementation-planner.toml
    p2a-task-graph.toml
    p2a-quality-reviewer.toml

.claude/
  agents/
    p2a-requirements.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  skills/
    p2a-harness/
      SKILL.md
    p2a-intake/
      SKILL.md
    p2a-spec/
      SKILL.md
    p2a-task-breakdown/
      SKILL.md
    p2a-review/
      SKILL.md

.gemini/
  agents/
    p2a-requirements.md
    p2a-implementation-planner.md
    p2a-task-graph.md
    p2a-quality-reviewer.md
  commands/
    p2a/
      harness.toml
      intake.toml
      spec.toml
      task-breakdown.toml
      review.toml
```

구조 판단:

- Codex와 Gemini CLI는 `.agents/skills`를 공통 skill 위치로 쓸 수 있으므로, v1의 skill 원본은 `.agents/skills`에 둔다.
- Claude Code는 공식 project skill 경로가 `.claude/skills`이므로 같은 skill을 mirror한다.
- subagent 정의는 각 CLI의 공식 경로와 파일 형식이 다르므로 별도 생성한다.
- Gemini CLI의 `.gemini/commands`는 skill 자체가 아니라 invocation shortcut으로만 둔다.

## 4. 공통 Skill 내용 규칙

모든 `SKILL.md`는 다음 원칙을 지킨다.

- 각 skill은 하나의 일만 한다.
- 입력과 출력 형식을 명시한다.
- 불명확하면 질문 목록을 만들고, 임의 구현을 시작하지 않는다.
- 코드 변경, shell 실행, dependency 설치는 v1 skill에서 금지한다.
- 산출물은 Markdown과 JSON을 모두 고려하되, 내부 원본은 JSON으로 본다.

공통 `p2a-harness/SKILL.md` 기준:

```md
---
name: p2a-harness
description: Use when turning a one-sentence product idea into a development-ready spec and task graph for Plan2Agent.
---

# Plan2Agent Harness

Input:
- A one-sentence product or feature idea.
- Optional answers to previous clarification questions.

Process:
1. Run intake: identify missing product and implementation information.
2. Produce a product spec only after assumptions are explicit.
3. Produce an implementation plan from the approved spec.
4. Break the plan into agent-executable tasks.
5. Review the task graph for missing dependencies, oversized tasks, and unclear acceptance criteria.

Output:
- Clarifying questions, if needed.
- Product spec Markdown.
- Implementation plan Markdown.
- Task graph JSON.
- Review report.

Rules:
- Do not edit source code.
- Do not run external commands.
- Do not claim execution has happened.
- Mark unresolved decisions as `needs_user_decision`.
```

## 5. Claude Code 구성

공식 문서 기준:

- Claude Code skill은 `.claude/skills/<skill-name>/SKILL.md`에 두며, skill 이름은 디렉터리명으로 invoke된다.
- Claude Code의 custom commands는 skills로 통합되어 있고, 기존 `.claude/commands`도 동작하지만 새 구성은 skills를 우선한다.
- project subagent는 `.claude/agents/`에 Markdown + YAML frontmatter로 정의한다.
- 복잡한 skill은 `context: fork`로 subagent context에서 실행할 수 있다.

Claude Code subagent 예시:

```md
---
name: p2a-task-graph
description: Converts an approved implementation plan into a small, dependency-aware task graph for agent execution.
tools:
  - Read
  - Grep
  - Glob
model: sonnet
---

You are the Plan2Agent task graph specialist.

Create tasks that are small enough for one agent or developer to complete independently.
Every task must include acceptance criteria, dependencies, and the expected output.
Do not edit files or run write operations.
Return only the task graph and blocking questions.
```

Claude Code skill 예시:

```md
---
name: p2a-task-breakdown
description: Breaks a Plan2Agent implementation plan into executable tasks. Use after the product and implementation spec are approved.
disable-model-invocation: true
context: fork
agent: p2a-task-graph
---

Break the provided implementation plan into a task graph.

Each task must include:
- id
- title
- description
- dependencies
- acceptanceCriteria
- targetArea
- suggestedAgentPrompt

Do not implement the tasks.
```

## 6. Codex 구성

공식 매뉴얼 기준:

- Codex skill은 `.agents/skills/<skill-name>/SKILL.md`에 둘 수 있다.
- `SKILL.md`는 `name`과 `description` frontmatter를 포함한다.
- Codex custom agent는 `.codex/agents/*.toml` 파일로 정의한다.
- custom agent 필수 필드는 `name`, `description`, `developer_instructions`다.
- Codex subagent workflow는 자동으로 spawn되지 않으며, 명시적으로 subagent 또는 parallel work를 요청해야 한다.

Codex custom agent 예시:

```toml
name = "p2a-task-graph"
description = "Breaks approved implementation plans into small, dependency-aware task graphs."
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
You are the Plan2Agent task graph specialist.

Create tasks that are small enough for one agent or developer to complete independently.
Every task must include acceptance criteria, dependencies, and expected output.
Do not edit files.
Do not run mutating commands.
Return only the task graph and blocking questions.
"""
```

Codex skill 예시:

```md
---
name: p2a-task-breakdown
description: Use when converting an approved Plan2Agent implementation plan into a dependency-aware task graph.
---

Break the provided implementation plan into a task graph.

Each task must include:
- id
- title
- description
- dependencies
- acceptanceCriteria
- targetArea
- suggestedAgentPrompt

If using Codex subagents, explicitly ask to spawn `p2a-task-graph`.
Do not implement the tasks.
```

Codex 호출 방식:

```text
Use the $p2a-harness skill on this idea.
Spawn the p2a-requirements, p2a-implementation-planner, p2a-task-graph, and p2a-quality-reviewer agents only for read-only planning.
```

## 7. Gemini CLI 구성

공식 문서 기준:

- Gemini CLI skill은 `.gemini/skills/`, `~/.gemini/skills/`, 또는 `.agents/skills/` alias에서 발견된다.
- skill은 Agent Skills open standard 기반의 `SKILL.md` 디렉터리다.
- Gemini CLI는 skill metadata를 먼저 보고, 필요 시 `activate_skill`로 skill을 활성화한다.
- custom subagent는 `.gemini/agents/*.md`에 Markdown + YAML frontmatter로 정의한다.
- subagent는 자동 위임되거나 `@subagent-name` 문법으로 명시 호출할 수 있다.
- custom command는 `.gemini/commands/*.toml`로 만들고, skill 호출 shortcut으로 사용할 수 있다.

Gemini CLI subagent 예시:

```md
---
name: p2a-task-graph
description: Breaks approved implementation plans into small, dependency-aware task graphs for Plan2Agent.
kind: local
tools:
  - read_file
  - grep_search
temperature: 0.2
max_turns: 10
---

You are the Plan2Agent task graph specialist.

Create tasks that are small enough for one agent or developer to complete independently.
Every task must include acceptance criteria, dependencies, and expected output.
Do not edit files.
Do not run mutating shell commands.
Return only the task graph and blocking questions.
```

Gemini CLI skill 예시:

```md
---
name: p2a-task-breakdown
description: Use when converting an approved Plan2Agent implementation plan into a dependency-aware task graph.
---

Break the provided implementation plan into a task graph.

Each task must include:
- id
- title
- description
- dependencies
- acceptanceCriteria
- targetArea
- suggestedAgentPrompt

Prefer the @p2a-task-graph subagent for isolated task graph generation.
Do not implement the tasks.
```

Gemini CLI custom command shortcut 예시:

```toml
description = "Run the Plan2Agent MVP harness on an idea or approved spec."
prompt = """
Use the Plan2Agent p2a-harness skill for the following input:

{{args}}

Rules:
- Do not edit files.
- Do not run mutating commands.
- Produce spec, task graph, and review output only.
"""
```

## 8. CLI별 차이와 하네스 정책

| 항목 | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Project skill 경로 | `.claude/skills` | `.agents/skills` | `.gemini/skills` 또는 `.agents/skills` |
| Project subagent 경로 | `.claude/agents` | `.codex/agents` | `.gemini/agents` |
| Subagent 형식 | Markdown + YAML frontmatter | TOML | Markdown + YAML frontmatter |
| Skill 실행 | `/skill-name` 또는 자동 | `$skill-name` 언급 또는 자동 | 자동 activation, `/skills`, command shim |
| 명시 subagent 호출 | agent 이름 지정 | spawn 요청 필요 | `@agent-name` 가능 |
| v1 정책 | read-only planning | read-only planning | read-only planning |

공통 정책:

- Plan2Agent v1은 세 CLI 모두에서 같은 역할 이름을 사용한다.
- 각 CLI의 subagent는 read-only planning 역할로 제한한다.
- 실제 실행은 task graph가 확정된 뒤 v2에서 다룬다.
- skill은 workflow 재사용 단위이고, subagent는 context 격리와 전문 역할 분리를 위한 단위다.

## 9. 구현 및 고도화 순서

1. 공통 skill 원본은 `.agents/skills`에서 먼저 수정한다.
2. Claude Code mirror가 필요한 skill은 `.claude/skills`에 동일하게 반영한다.
3. subagent 역할 변경은 `.codex/agents`, `.claude/agents`, `.gemini/agents`에 같은 역할명으로 반영한다.
4. Gemini CLI shortcut 변경은 `.gemini/commands/p2a/*.toml`에 반영한다.
5. 각 CLI에서 "아이디어 -> spec -> task graph -> review" 흐름을 read-only로 수동 검증한다.
6. 다음 고도화 단계에서는 `p2a-harness`가 역할별 subagent 사용 지시를 명확히 포함하도록 보강한다.

## 10. 산출물 Acceptance Criteria

하네스 scaffold는 다음을 만족해야 한다.

- 세 CLI 모두 같은 Plan2Agent role 이름을 가진다.
- 세 CLI 모두 `p2a-harness`에 해당하는 상위 workflow를 가진다.
- 세 CLI 모두 task graph 생성 전 사용자 결정이 필요한 항목을 `needs_user_decision`으로 남긴다.
- 어떤 skill이나 subagent도 v1에서 코드 변경을 지시하지 않는다.
- task graph는 최소 필드 `id`, `title`, `description`, `dependencies`, `acceptanceCriteria`, `targetArea`, `suggestedAgentPrompt`를 가진다.
- 공식 문서 기준 경로와 파일 형식을 따른다.

## 11. 현재 보완 필요 항목

- `p2a-harness` skill 본문에 `p2a-requirements`, `p2a-implementation-planner`, `p2a-task-graph`, `p2a-quality-reviewer`의 사용 순서를 명시한다.
- Claude Code의 `p2a-task-breakdown` skill에는 필요 시 `context: fork`, `agent: p2a-task-graph` 사용 여부를 반영한다.
- Codex 공통 skill에는 subagent를 쓰려면 명시적으로 spawn해야 한다는 지시를 실제 skill 본문에 반영한다.
- Gemini CLI command에는 필요 시 `@p2a-task-graph` 같은 명시 subagent 호출 힌트를 추가한다.
- `task_graph_json`과 `spec_json`의 fixture를 만들어 skill 출력 품질을 검증한다.

## 12. 공식 레퍼런스

- Claude Code Skills: https://code.claude.com/docs/en/skills
- Claude Code Subagents: https://code.claude.com/docs/en/sub-agents
- Codex Skills: https://developers.openai.com/codex/skills
- Codex Subagents: https://developers.openai.com/codex/subagents
- Gemini CLI Skills: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md
- Gemini CLI Subagents: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md
- Gemini CLI Custom Commands: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md
- Gemini CLI Reference: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/cli-reference.md
