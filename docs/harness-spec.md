# Plan2Agent v1.0 하네스 스펙

Plan2Agent v1.0은 타겟 프로젝트의 `.plan2agent/` 디렉터리에 **최대 2개의 JSON 파일**만 관리합니다.

1. `.plan2agent/config.json` (`schemas/config.schema.json`, `p2a.config.v1`)
2. `.plan2agent/work.json` (`schemas/work.schema.json`, `p2a.work.v1`) — 진행 중인 개발이 있을 때만 존재하며 `p2a done` 시 삭제

---

## 1. `config.json` (`p2a.config.v1`)

```json
{
  "schema_version": "p2a.config.v1",
  "project_id": "my-project",
  "tools": ["codex", "claude", "gemini"],
  "verify": {
    "test": "npm test",
    "lint": null,
    "typecheck": null,
    "timeout_ms": 120000
  },
  "buildlore": {
    "enabled": false,
    "command": "buildlore"
  }
}
```

## 2. `work.json` (`p2a.work.v1`)

```json
{
  "schema_version": "p2a.work.v1",
  "id": "work-20261126-120000",
  "status": "draft | approved | in_progress | done",
  "entry": {
    "kind": "idea | file",
    "text": "...",
    "path": null,
    "sha256": "..."
  },
  "goal": "달성할 결과",
  "scope": ["변경 범위"],
  "non_goals": ["변경하지 않을 범위"],
  "constraints": ["유지할 제약"],
  "approval": {
    "approved": false,
    "at": null,
    "quote": null,
    "plan_sha256": null
  },
  "tasks": [
    {
      "id": "T1",
      "title": "태스크 제목",
      "status": "todo | in_progress | done | blocked",
      "depends_on": [],
      "acceptance": ["관찰 가능한 완료 조건"],
      "verification": {
        "command": "npm test",
        "status": "passed | failed",
        "exit_code": 0,
        "git_head": "abc123...",
        "worktree_fingerprint": "sha256...",
        "at": "2026-11-26T12:00:00.000Z",
        "duration_ms": 120,
        "output_tail": ""
      },
      "changed_files": ["src/app.mjs"],
      "notes": ["재개 시 참고할 메모"]
    }
  ],
  "resume": {
    "active_task_id": "T1",
    "summary": "다음 세션에서 바로 이어할 1~2줄 요약",
    "updated_at": "2026-11-26T12:00:00.000Z"
  }
}
```

---

## 3. 안전 불변식 (Invariants)

### 3.1 계획 해시 격리 (`approval.plan_sha256`)
`computePlanSha256(work)`는 아래 필드만 정규화(canonical JSON)해 SHA-256을 계산합니다.
- `goal`, `scope`, `non_goals`, `constraints`
- `tasks[].{ id, title, depends_on, acceptance }`

따라서 실행 중 `tasks[].status`, `verification`, `changed_files`, `notes`, `resume`을 갱신해도 승인이 깨지지 않지만, 승인된 목표·범위·제약·태스크 조건을 임의로 수정하면 `plan_drifted`로 즉시 차단됩니다.

### 3.2 태스크 DAG 무결성
`validateWork()`는 중복 태스크 ID, 자기 참조, 존재하지 않는 선행 태스크, 순환 의존성(cycle)을 모두 거부합니다.

### 3.3 검증 신선도 격리 (`worktree_fingerprint`)
`inspectGitWorkspace()`는 `git status --porcelain --untracked-files=all -- . :(exclude).plan2agent`와 변경 파일 내용 해시를 결합해 `worktree_fingerprint`를 계산합니다.
- 제품 코드가 변경되면 지문이 바뀌어 `p2a task done`이 재검증을 요구합니다.
- `.plan2agent/work.json`에 메모나 재개 요약을 기록하는 것은 지문에 포함되지 않으므로 통과된 검증을 깨뜨리지 않습니다.

### 3.4 `p2a next` 상태 머신

| 상태 | 의미 | 다음 행동 |
| --- | --- | --- |
| `invalid_config` | `config.json` 손상 | `p2a doctor` |
| `uninitialized` | `.plan2agent/config.json` 없음 | `p2a init` |
| `active_work_exists` | 이미 `work.json`이 있는데 `--idea`/`--entry` 전달 | `p2a next` |
| `invalid_work` | `work.json` 스키마/DAG 오류 | `p2a validate` |
| `no_work` | 진행 중 작업 없음 | `p2a next --idea "..."` |
| `draft_needs_plan` | 초안에 태스크 없음 | `/p2a-work`로 계획·태스크 작성 |
| `draft_needs_approval` | 계획 준비 완료, 승인 대기 | `p2a approve --quote "..."` |
| `plan_drifted` | 승인 후 계획 필드 변경 | `p2a approve --quote "..."` |
| `task_in_progress` | 진행 중 태스크 있음 (세션 재개 지점) | `/p2a-work --task <id>` |
| `ready_task` | 선행 조건 충족된 `todo` 태스크 있음 | `p2a task start <id>` |
| `tasks_blocked` | 남은 태스크가 모두 `blocked` 또는 대기 | `p2a task unblock <id>` |
| `ready_to_finish` | 모든 태스크 `done` | `p2a done` |
