# Plan2Agent v2 개발 인계와 환경 세팅 목표

이 문서는 Plan2Agent v2에서 추가할 개발 인계 도구의 목표와 산출물 계약을 정의한다. v1 하네스가 아이디어를 개발 가능한 기획 산출물과 task graph로 정리했다면, v2의 첫 단계는 그 산출물을 실제 개발 프로젝트로 옮기고 AI 개발 도구를 함께 세팅하는 것이다.

## 1. 목표

v2 개발 인계 도구는 Gate D를 통과한 기획 산출물을 사용자가 지정한 개발 대상 프로젝트로 옮긴다. 동시에 Codex, Claude Code, Gemini CLI 같은 AI 개발 도구가 같은 task graph를 보고 작업할 수 있도록 필요한 skill, subagent, command shim, task CLI를 대상 프로젝트에 복사한다.

최종 목표는 다음 상태를 만드는 것이다.

- 개발 대상 프로젝트 안에 승인된 기획 산출물이 존재한다.
- 개발 대상 프로젝트 안에 AI agent가 사용할 Plan2Agent 도구가 존재한다.
- task별 prompt와 acceptance criteria를 대상 프로젝트 기준으로 조회할 수 있다.
- 선택한 CLI에서 복잡한 task를 여러 agent가 협업해 처리할 수 있는 Team Big Five 실행 하네스를 선택적으로 사용할 수 있다.
- 사용자는 별도 수동 복사 없이 대상 프로젝트에서 바로 개발 task를 시작할 수 있다.

## 2. 배경

v1의 최종 산출물은 `artifacts/<project_id>/` 아래의 planning 파일이다.

```text
intake.json
intake.md
product-spec.md
implementation-plan.md
spec.json
task-graph.json
review-report.md
```

이 산출물은 개발을 시작하기에 충분한 기준이지만, 현재는 Plan2Agent 저장소 안에 머문다. 실제 구현은 보통 별도의 앱, 라이브러리, 서비스 프로젝트에서 진행되므로 산출물과 AI 개발 도구를 개발 대상 프로젝트로 인계하는 단계가 필요하다.

## 3. v2 범위

포함 범위:

- Gate D 통과 여부 확인
- 원본 `artifacts/<project_id>/` 산출물 검증
- 개발 대상 디렉터리 선택
- 기획 산출물 복사 또는 이동
- 대상 프로젝트용 Plan2Agent 작업 디렉터리 생성
- Codex, Claude Code, Gemini CLI용 skill, subagent, command shim 복사
- Codex, Claude Code, Gemini CLI용 외부 팀 실행 하네스 adapter 선택 설치
- task 상태 관리 CLI 또는 대상 프로젝트용 wrapper 설치
- 대상 프로젝트의 개발 명령을 기록하는 설정 파일 생성
- 인계 결과 manifest 생성

제외 범위:

- AI agent 자동 실행
- 코드 변경 자동 생성
- 테스트 자동 실행과 결과 수집
- PR 생성
- branch 또는 worktree 자동 생성
- 여러 agent의 병렬 실행 조율

제외 범위는 후속 v2 단계에서 다룬다. 개발 인계 도구는 자동 실행의 전제 조건이다.

## 4. 대상 프로젝트 구조

권장 기본 구조는 다음과 같다.

```text
<target-project>/
  .plan2agent/
    artifacts/
      product-spec.md
      implementation-plan.md
      spec.json
      task-graph.json
      review-report.md
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
```

`intake.json`과 `intake.md`는 개발 중 직접 참조 빈도가 낮으므로 기본 복사 대상에서는 선택 항목으로 둔다. 단, traceability를 강화하려면 함께 복사할 수 있어야 한다.

`.plan2agent/team-harnesses/team-bigfive/`는 원본 출처, 변환 기준, CLI별 adapter 정보를 기록하는 위치다. Claude Code는 원본 plugin 구조를 유지하거나 `.claude/skills`와 `.claude/agents`로 배치할 수 있고, Codex와 Gemini CLI는 Plan2Agent의 renderer 규칙에 맞춰 skill/subagent/command shim 형태로 변환한다.

## 5. 인계 명령 초안

초기 CLI는 다음 형태를 목표로 한다.

```bash
node scripts/p2a_handoff.mjs \
  --project-id <project_id> \
  --artifacts artifacts/<project_id> \
  --target /path/to/target-project \
  --mode copy
```

옵션 초안:

- `--project-id`: 인계할 Plan2Agent 프로젝트 id
- `--artifacts`: 원본 산출물 디렉터리
- `--target`: 개발 대상 프로젝트 디렉터리
- `--mode copy|move`: 산출물 복사 또는 이동 방식
- `--include-intake`: intake 산출물도 함께 인계
- `--tools codex,claude,gemini`: 복사할 AI 도구 범위
- `--include-team-bigfive`: 선택한 CLI용 `team-bigfive` 기반 팀 실행 adapter를 함께 설치
- `--team-bigfive-source`: `team-bigfive` 원본 경로 또는 Git URL
- `--team-bigfive-targets codex,claude,gemini`: Team Big Five adapter를 설치할 CLI 범위
- `--overwrite`: 기존 `.plan2agent` 파일 덮어쓰기 허용
- `--dry-run`: 실제 파일 쓰기 없이 계획만 출력

기본값은 `copy`, `codex`, `dry-run false`, `include-team-bigfive false`로 둔다. `--team-bigfive-targets`가 없으면 `--tools`와 같은 범위를 사용한다. `team-bigfive` 원본은 Claude Code plugin 구조이지만, v2 목표는 Codex, Claude Code, Gemini CLI에 각각 맞는 adapter를 생성하는 것이다. 따라서 Codex/Gemini에는 원본 파일을 그대로 복사하지 않고 CLI-native skill/subagent 형태로 변환한다.

## 6. 검증 규칙

인계 도구는 파일을 쓰기 전에 다음을 확인한다.

- `spec.json`이 존재한다.
- `task-graph.json`이 존재한다.
- `review-report.md`가 존재한다.
- `spec.json.approval`이 `approved`다.
- `spec.json.open_decisions`가 비어 있다.
- `task-graph.json`은 schema 검증을 통과한다.
- task dependency는 같은 graph 안의 task id만 참조한다.
- task graph에 cycle이 없다.
- review report에 blocking issue가 없어야 한다.
- `--include-team-bigfive`를 사용할 경우 원본에 `agents/`, `skills/`가 있어야 하며, Claude plugin mode를 사용할 때는 `.claude-plugin/plugin.json`도 있어야 한다.

검증은 기존 `scripts/validate_artifacts.mjs`를 재사용한다. review report의 blocking 여부는 Markdown 규칙만으로 불안정할 수 있으므로 v2에서는 review 결과를 JSON으로도 저장하는 방안을 검토한다.

## 6-1. `team-bigfive` 선택 통합

`team-bigfive`는 Team Science의 Team Big Five 모델을 agent 팀 실행에 적용한 외부 하네스다. 원본 구현은 Claude Code plugin 구조지만, Plan2Agent v2에서는 이 실행 패턴을 Codex, Claude Code, Gemini CLI에 각각 맞게 변환해 사용할 수 있는 선택 옵션으로 다룬다. Plan2Agent 관점에서는 기획을 생성하는 도구가 아니라, 확정된 task를 여러 agent가 협업해 구현하고 검증할 때 사용하는 실행 하네스다.

참고 저장소:

- `https://github.com/tobyilee/team-bigfive`

확인된 구조:

```text
agents/
  team-lead.md
  contributor.md
  performance-monitor.md
skills/
  team-bigfive-orchestrator/
  shared-mental-model/
  closed-loop-comms/
  mutual-monitoring/
.claude-plugin/
  plugin.json
  marketplace.json
```

Plan2Agent와의 역할 분리는 다음과 같다.

| 구분 | Plan2Agent | team-bigfive |
| --- | --- | --- |
| 주 역할 | 아이디어를 명세와 task graph로 변환 | 복잡한 task를 agent 팀으로 실행 |
| 기준 산출물 | `.plan2agent/artifacts/task-graph.json` | `_workspace/SMM.md`, monitor report, debrief |
| 적용 시점 | 개발 전 기획/분해 | 개발 실행 중 협업/검증 |
| 대상 CLI | Codex, Claude Code, Gemini CLI | 원본은 Claude Code 중심, v2에서는 CLI별 adapter로 확장 |

CLI별 적용 전략:

| CLI | 적용 방식 | 주의점 |
| --- | --- | --- |
| Codex | `team-bigfive` skill을 `.agents/skills`로 변환하고, agent 역할을 `.codex/agents/*.toml`로 렌더링한다. | 원본의 Claude 팀 도구 시그니처를 그대로 쓰지 않고, Codex에서 가능한 subagent/fanout 및 파일 기반 `_workspace/` 조율로 낮춘다. |
| Claude Code | 원본 plugin 구조를 유지하거나 `.claude/skills`, `.claude/agents`에 직접 배치한다. | TeamCreate/SendMessage 같은 팀 도구가 세션에 없으면 원본의 폴백 절차를 따른다. |
| Gemini CLI | skill을 `.agents/skills`에 두고, agent 역할을 `.gemini/agents/*.md`와 `/p2a` 또는 `/team-bigfive` command shim으로 렌더링한다. | Gemini subagent/command 문법에 맞춰 frontmatter와 도구 이름을 변환한다. |

통합 방식:

1. `p2a_handoff.mjs`가 `--include-team-bigfive`를 받으면 `team-bigfive` 원본을 확인한다.
2. 원본의 `agents/`와 `skills/`를 읽어 CLI-neutral adapter 원본을 `.plan2agent/team-harnesses/team-bigfive/`에 기록한다.
3. 선택한 target별로 Codex, Claude Code, Gemini CLI에 맞는 skill/subagent/command shim을 생성한다.
4. `.plan2agent/project.config.json`에 `teamBigFive.enabled: true`와 target 목록을 기록한다.
5. `p2a_tasks.mjs prompt` 또는 후속 adapter가 task 내용을 target CLI별 kickoff prompt로 변환한다.
6. 실행 결과로 생기는 `_workspace/` 산출물은 Plan2Agent run log와 연결하되, `.plan2agent/artifacts/`와 섞지 않는다.

초기 kickoff prompt 형태:

```text
선택한 CLI의 Team Big Five 실행 adapter를 사용해 다음 Plan2Agent task를 팀으로 구현하고 검증한다.

Project artifacts:
- .plan2agent/artifacts/product-spec.md
- .plan2agent/artifacts/implementation-plan.md
- .plan2agent/artifacts/task-graph.json

Task:
<task id, title, description, acceptanceCriteria, dependencies, sourceSpecRefs>

대상 프로젝트의 test/lint/typecheck 명령은 .plan2agent/project.config.json을 따른다.
완료 후 _workspace/debrief.md와 monitor report를 남기고, 변경 파일과 검증 결과를 요약한다.
```

주의사항:

- `team-bigfive` 원본은 Claude Code plugin 구조이므로 Codex/Gemini에는 직접 복사하지 않고 adapter를 생성한다.
- CLI별 도구 시그니처가 다르므로 TeamCreate, SendMessage 같은 원본 절차는 target CLI에서 가능한 협업 방식으로 낮춰 적용한다.
- `_workspace/`는 실행 감사 추적용이고 `.plan2agent/artifacts/`는 승인된 기획 원본이다. 두 디렉터리의 책임을 분리한다.
- Plan2Agent task 상태 변경은 여전히 `task-graph.json`을 기준으로 한다. `team-bigfive` 실행 성공만으로 자동 `done` 처리하지 않고, 검증 결과 확인 후 상태를 바꾼다.
- 외부 하네스 버전과 출처를 manifest에 기록해 나중에 실행 결과를 재현할 수 있게 한다.

## 7. Manifest 계약

인계가 끝나면 대상 프로젝트의 `.plan2agent/manifest.json`에 다음 정보를 기록한다.

```json
{
  "schema_version": "p2a.handoff.v1",
  "projectId": "example-project",
  "sourceArtifacts": "artifacts/example-project",
  "targetProject": "/path/to/target-project",
  "handoffMode": "copy",
  "createdAt": "2026-06-10T00:00:00.000Z",
  "includedTools": ["codex"],
  "externalHarnesses": [
    {
      "name": "team-bigfive",
      "source": "https://github.com/tobyilee/team-bigfive",
      "version": "2.0.0",
      "targets": ["codex", "claude-code", "gemini-cli"],
      "adapterMode": "cli-native",
      "installed": false
    }
  ],
  "artifactFiles": [
    ".plan2agent/artifacts/product-spec.md",
    ".plan2agent/artifacts/implementation-plan.md",
    ".plan2agent/artifacts/spec.json",
    ".plan2agent/artifacts/task-graph.json",
    ".plan2agent/artifacts/review-report.md"
  ],
  "toolFiles": [
    ".agents/skills/p2a-harness/SKILL.md",
    ".codex/agents/p2a-task-graph.toml",
    "scripts/p2a_tasks.mjs"
  ]
}
```

manifest는 나중에 agent 실행 로그, 변경 파일, 테스트 결과를 task와 연결할 때 기준이 된다.

## 8. 대상 프로젝트 설정

`.plan2agent/project.config.json`은 대상 프로젝트의 개발 명령을 기록한다.

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
    "enabled": false,
    "targets": ["codex"],
    "mode": "cli-native-adapter",
    "workspaceDir": "_workspace"
  }
}
```

이 값은 자동 추론할 수 있으면 제안하되, 확실하지 않으면 사용자가 명시하도록 한다. v2 초기 버전은 잘못된 추론으로 개발 환경을 망가뜨리는 것보다 보수적으로 멈추는 편이 낫다.

## 9. 개발 진행 흐름

인계 후 사용자는 대상 프로젝트에서 다음 흐름으로 개발을 진행한다.

1. `node scripts/p2a_tasks.mjs ready --graph .plan2agent/artifacts/task-graph.json`로 시작 가능한 task를 확인한다.
2. `node scripts/p2a_tasks.mjs prompt --graph .plan2agent/artifacts/task-graph.json <task-id>`로 agent prompt를 만든다.
3. 단일 agent에 적합한 task는 Codex, Claude Code, Gemini CLI 중 설치된 도구로 바로 구현한다.
4. 여러 영역이 맞물리는 task는 선택한 CLI에서 Team Big Five kickoff prompt로 팀 실행을 시작한다.
5. 대상 프로젝트의 test, lint, typecheck 명령으로 검증한다.
6. 통과하면 `done`, 막히면 `block`으로 task 상태를 기록한다.

이 단계에서는 아직 agent 자동 실행을 하지 않는다. v2의 다음 단계에서 `p2a_tasks.mjs`와 agent 실행 로그를 연결한다.

## 10. 보안과 안전 기준

- 기본 동작은 복사다. 이동은 사용자가 명시한 경우에만 허용한다.
- 대상 프로젝트 밖으로 파일을 쓰지 않는다.
- `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다.
- `.env`, credential, local secret 파일은 복사 대상에 포함하지 않는다.
- 도구 복사는 Plan2Agent가 관리하는 skill, subagent, command shim, task CLI로 제한한다.
- 외부 하네스 설치는 사용자가 명시한 경우에만 수행하고, 출처와 버전을 manifest에 기록한다.
- package install이나 shell 기반 개발 명령 실행은 인계 도구의 기본 동작에 포함하지 않는다.

## 11. 완료 기준

v2 개발 인계 도구는 다음 조건을 만족하면 1차 완료로 본다.

- Gate D 통과 산출물만 인계할 수 있다.
- 대상 프로젝트에 `.plan2agent/artifacts/`가 생성된다.
- 대상 프로젝트에 선택한 AI 도구 파일이 복사된다.
- `--include-team-bigfive` 사용 시 선택한 CLI에서 Team Big Five adapter의 skill/agent/command 파일을 인식할 수 있는 구조로 설치된다.
- 대상 프로젝트에서 `p2a_tasks.mjs ready`와 `p2a_tasks.mjs prompt`를 실행할 수 있다.
- `manifest.json`과 `project.config.json`이 생성된다.
- `--dry-run`으로 파일 변경 계획을 먼저 확인할 수 있다.
- 기존 파일 충돌 시 명확한 오류를 내고 중단한다.

## 12. 후속 고도화

개발 인계 도구가 안정되면 다음 기능을 붙인다.

- task별 branch 또는 worktree 생성
- agent 실행 세션 생성
- Plan2Agent task를 Codex, Claude Code, Gemini CLI별 Team Big Five kickoff prompt로 자동 변환
- 실행 로그 저장
- 변경 파일과 task 연결
- test, lint, typecheck 결과 수집
- 실패 task의 재시도 기록
- PR 생성 또는 변경 요약 생성

이 순서가 안정적인 이유는 산출물과 도구의 위치가 먼저 고정되어야 agent 실행 결과를 일관되게 추적할 수 있기 때문이다.
