# Plan2Agent CLI 레퍼런스

대부분의 명령은 `--target <dir>`(생략 시 `.git` 경계 안에서 상위로 탐색해 `.plan2agent/`가 있는 루트 사용; 단 `p2a init`은 현재 작업 디렉터리 사용)과 `--json`(기계 판독용 출력)을 지원합니다.

## `p2a init`

프로젝트에 `.plan2agent/config.json`과 최소 프로바이더 자산을 설치합니다.

```bash
p2a init [--target <dir>] [--tools codex,claude,gemini|all|none] [--project-id <id>] [--force] [--json]
```

- `--tools`: 기본값 `all`. `none`이면 `.plan2agent/config.json`만 생성합니다.
- `--force`: 기존 `config.json`을 유지하지 않고 검증 명령을 다시 감지해 덮어씁니다.

## `p2a next`

유일한 상태 라우터입니다. 새 작업 시작과 중단된 세션 재개 모두 이 명령을 사용합니다.

```bash
p2a next [--target <dir>] [--idea "<text>" | --entry <path>] [--json]
```

- `--idea "<text>"`: 진행 중인 `work.json`이 없을 때 초안을 생성합니다.
- `--entry <path>`: 지정 파일의 첫 제목/줄과 SHA-256을 기록해 초안을 생성합니다.
- 이미 `work.json`이 있는데 `--idea`/`--entry`를 넘기면 덮어쓰지 않고 `active_work_exists` 상태를 반환합니다.

## `p2a approve`

`work.json`의 계획을 1회 통합 승인하고 `approval.plan_sha256`을 고정합니다.

```bash
p2a approve --quote "<user utterance>" [--target <dir>] [--json]
```

- 태스크가 1개 이상 있어야 승인할 수 있습니다.
- 승인 후 `goal`, `scope`, `non_goals`, `constraints`, `tasks[].{id,title,depends_on,acceptance}`가 바뀌면 `plan_drifted`로 차단되며 재승인이 필요합니다.

## `p2a task` (`p2a tasks`)

태스크와 재개 메모를 관리합니다.

```bash
p2a task list [--target <dir>] [--json]
p2a task add --title "<text>" --accept "<criterion>" [--accept ...] [--id <id>] [--depends <id> ...] [--target <dir>] [--json]
p2a task start <id> [--summary "<text>"] [--allow-parallel] [--target <dir>] [--json]
p2a task note <id> [--note "<text>"] [--summary "<text>"] [--target <dir>] [--json]
p2a task block <id> --reason "<text>" [--summary "<text>"] [--target <dir>] [--json]
p2a task unblock <id> [--target <dir>] [--json]
p2a task done <id> [--summary "<text>"] [--target <dir>] [--json]
```

- `start`: 승인 완료, 선행 의존성(`depends_on`) 전체 `done` 충족이 필요합니다. 기본적으로 동시에 1개 태스크만 `in_progress`를 허용합니다(`--allow-parallel`로 해제 가능).
- `done`: `verification.status === "passed"`, `exit_code === 0`, 그리고 현재 Git 워킹트리 지문 일치를 요구합니다.

## `p2a verify`

실제 검증 명령을 실행하고 결과를 `work.json`의 해당 태스크에 기록합니다.

```bash
p2a verify [--task <id>] [--cmd "<command>"] [--target <dir>] [--json]
```

- `--task` 생략 시 현재 `active_task_id` 또는 `in_progress` 태스크를 대상으로 합니다.
- `--cmd` 생략 시 `.plan2agent/config.json`의 `verify.test`, `verify.lint`, `verify.typecheck` 중 설정된 명령을 `&&`로 연결해 실행합니다.
- 실패 시 종료 코드 `1`을 반환하며, 이미 `done` 상태이던 태스크가 실패하면 `in_progress`로 되돌리고 `resume.summary`가 비어 있을 때만 기본 실패 요약을 기록합니다.

## `p2a done`

현재 개발을 종료하고 `.plan2agent/work.json`을 삭제합니다.

```bash
p2a done [--abort] [--target <dir>] [--json]
```

- 기본 모드: 승인 유효성, 모든 태스크 `done`, 모든 태스크 통과 검증을 확인한 뒤 `work.json`을 삭제합니다.
- `--abort`: 미완료 초안이나 진행 중 작업을 검증 없이 즉시 폐기하고 `work.json`을 삭제합니다.

## `p2a validate` / `p2a doctor`

```bash
p2a validate [--target <dir>] [--json]
p2a doctor [--target <dir>] [--json]
```

- `validate`: `config.json`과(존재 시) `work.json`의 스키마 및 DAG 무결성을 검증합니다.
- `doctor`: 설정·작업 파일 오류, 검증 명령 미설정, 계획 드리프트, 누락된 프로바이더 자산을 진단합니다.

## `p2a buildlore` *(선택)*

BuildLore CLI가 설치된 환경에서만 사용하는 얇은 어댑터입니다. BuildLore 읽기 실패는 Plan2Agent 개발 흐름을 차단하지 않습니다.

```bash
p2a buildlore status [--target <dir>] [--project <id>] [--json]
p2a buildlore memory --task "<text>" [--progressive] [--target <dir>] [--project <id>] [--json]
p2a buildlore lookup --kind evidence|fact --id <sha256> --expect-generation <sha256> [--target <dir>] [--json]
p2a buildlore search --query "<text>" [--mode lexical|semantic|hybrid] [--target <dir>] [--json]
p2a buildlore sync [--dry-run] [--target <dir>] [--json]
p2a buildlore handoff <import|list|read|verify> [options]
```
