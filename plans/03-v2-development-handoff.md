# Plan2Agent v2 개발 인계와 환경 세팅 목표

이 문서는 Plan2Agent v2에서 추가할 개발 인계 도구의 목표와 산출물 계약을 정의한다. v1 하네스가 아이디어를 개발 가능한 기획 산출물과 task graph로 정리했다면, v2의 첫 단계는 그 산출물을 실제 개발 프로젝트로 옮기고 AI 개발 도구를 함께 세팅하는 것이다.

## 1. 목표

v2 개발 인계 도구는 Gate D를 통과한 기획 산출물을 사용자가 지정한 개발 대상 프로젝트로 옮긴다. 동시에 Codex, Claude Code, Gemini CLI 같은 AI 개발 도구가 같은 task graph를 보고 작업할 수 있도록 필요한 skill, subagent, command shim, task CLI를 대상 프로젝트에 복사한다.

최종 목표는 다음 상태를 만드는 것이다.

- 개발 대상 프로젝트 안에 승인된 기획 산출물이 존재한다.
- 개발 대상 프로젝트 안에 AI agent가 사용할 Plan2Agent 도구가 존재한다.
- task별 prompt와 acceptance criteria를 대상 프로젝트 기준으로 조회할 수 있다.
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
  .gemini/
    agents/
    commands/
      p2a/
  scripts/
    p2a_tasks.mjs
```

`intake.json`과 `intake.md`는 개발 중 직접 참조 빈도가 낮으므로 기본 복사 대상에서는 선택 항목으로 둔다. 단, traceability를 강화하려면 함께 복사할 수 있어야 한다.

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
- `--overwrite`: 기존 `.plan2agent` 파일 덮어쓰기 허용
- `--dry-run`: 실제 파일 쓰기 없이 계획만 출력

기본값은 `copy`, `codex`, `dry-run false`로 둔다. 여러 CLI를 한 번에 설치하는 기능은 지원하되, 첫 구현 검증은 Codex 기준으로 시작한다.

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

검증은 기존 `scripts/validate_artifacts.mjs`를 재사용한다. review report의 blocking 여부는 Markdown 규칙만으로 불안정할 수 있으므로 v2에서는 review 결과를 JSON으로도 저장하는 방안을 검토한다.

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
  "taskGraph": ".plan2agent/artifacts/task-graph.json"
}
```

이 값은 자동 추론할 수 있으면 제안하되, 확실하지 않으면 사용자가 명시하도록 한다. v2 초기 버전은 잘못된 추론으로 개발 환경을 망가뜨리는 것보다 보수적으로 멈추는 편이 낫다.

## 9. 개발 진행 흐름

인계 후 사용자는 대상 프로젝트에서 다음 흐름으로 개발을 진행한다.

1. `node scripts/p2a_tasks.mjs ready --graph .plan2agent/artifacts/task-graph.json`로 시작 가능한 task를 확인한다.
2. `node scripts/p2a_tasks.mjs prompt --graph .plan2agent/artifacts/task-graph.json <task-id>`로 agent prompt를 만든다.
3. Codex, Claude Code, Gemini CLI 중 설치된 도구로 task를 구현한다.
4. 대상 프로젝트의 test, lint, typecheck 명령으로 검증한다.
5. 통과하면 `done`, 막히면 `block`으로 task 상태를 기록한다.

이 단계에서는 아직 agent 자동 실행을 하지 않는다. v2의 다음 단계에서 `p2a_tasks.mjs`와 agent 실행 로그를 연결한다.

## 10. 보안과 안전 기준

- 기본 동작은 복사다. 이동은 사용자가 명시한 경우에만 허용한다.
- 대상 프로젝트 밖으로 파일을 쓰지 않는다.
- `--overwrite` 없이는 기존 파일을 덮어쓰지 않는다.
- `.env`, credential, local secret 파일은 복사 대상에 포함하지 않는다.
- 도구 복사는 Plan2Agent가 관리하는 skill, subagent, command shim, task CLI로 제한한다.
- package install이나 shell 기반 개발 명령 실행은 인계 도구의 기본 동작에 포함하지 않는다.

## 11. 완료 기준

v2 개발 인계 도구는 다음 조건을 만족하면 1차 완료로 본다.

- Gate D 통과 산출물만 인계할 수 있다.
- 대상 프로젝트에 `.plan2agent/artifacts/`가 생성된다.
- 대상 프로젝트에 선택한 AI 도구 파일이 복사된다.
- 대상 프로젝트에서 `p2a_tasks.mjs ready`와 `p2a_tasks.mjs prompt`를 실행할 수 있다.
- `manifest.json`과 `project.config.json`이 생성된다.
- `--dry-run`으로 파일 변경 계획을 먼저 확인할 수 있다.
- 기존 파일 충돌 시 명확한 오류를 내고 중단한다.

## 12. 후속 고도화

개발 인계 도구가 안정되면 다음 기능을 붙인다.

- task별 branch 또는 worktree 생성
- agent 실행 세션 생성
- 실행 로그 저장
- 변경 파일과 task 연결
- test, lint, typecheck 결과 수집
- 실패 task의 재시도 기록
- PR 생성 또는 변경 요약 생성

이 순서가 안정적인 이유는 산출물과 도구의 위치가 먼저 고정되어야 agent 실행 결과를 일관되게 추적할 수 있기 때문이다.
