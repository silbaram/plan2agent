# Plan2Agent 빠른 시작

## 1. 설치 및 초기화

Node.js `>=22.0.0` 환경에서 설치합니다.

```bash
npm install -g plan2agent
cd /path/to/your-project
p2a init --tools all
```

`p2a init`은 다음만 수행합니다.
- `.plan2agent/config.json` 생성 (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, Gradle/Maven에서 테스트 명령 자동 감지)
- 선택한 AI 코딩 CLI(`codex`, `claude`, `gemini`, `all`, `none`)용 최소 스킬 2개(`p2a-next`, `p2a-work`)와 서브에이전트 2개(`p2a-implementer`, `p2a-reviewer`) 설치

자동 생성 마크다운(`PLAN2AGENT.md`, `status.md` 등)은 만들지 않습니다.

## 2. 작업 시작과 1회 통합 확인

```bash
p2a next --idea "사용자 목록 API에 페이지네이션 추가"
```

또는 기존 요청 파일로 시작할 수 있습니다.

```bash
p2a next --entry docs/request.md
```

에이전트(또는 사용자)가 코드를 파악하고 `.plan2agent/work.json`의 `goal`, `scope`, `non_goals`, `constraints`, `tasks`를 정리합니다. CLI로 태스크를 직접 추가할 수도 있습니다.

```bash
p2a task add --title "페이지네이션 파라미터 파싱" --accept "limit/offset 검증 통과"
p2a task add --title "목록 조회 쿼리 및 테스트 추가" --depends T1 --accept "npm test 통과"
```

정리된 계획을 사용자에게 한 번에 확인받은 뒤 승인합니다.

```bash
p2a approve --quote "이 계획대로 진행하자"
```

## 3. 태스크 실행 · 실제 검증 · 완료

```bash
p2a task start T1 --summary "파라미터 파서 구현 시작"
# ... 코드 수정 ...
p2a verify --task T1
p2a task done T1 --summary "T1 완료, T2 준비"
```

- `p2a verify`는 `.plan2agent/config.json`의 검증 명령(또는 `--cmd`)을 실제 실행해 종료 코드와 현재 Git 워킹트리 지문을 `work.json`에 기록합니다.
- 검증 통과 후 제품 코드를 수정하면 `p2a task done`이 재검증을 요구합니다(`.plan2agent/work.json`의 메모·요약 수정은 검증을 무효화하지 않습니다).

## 4. 세션이 꺼졌다 다시 켜졌을 때 (재개)

작업 도중 세션을 닫기 전 메모를 남기면 더 정확하게 이어갈 수 있습니다.

```bash
p2a task note T2 --note "빈 결과일 때 total=0 처리 필요" --summary "T2 빈 페이지 테스트 수정 후 재검증"
```

새 세션이 열리면 다음 한 줄만 실행합니다(또는 에이전트에서 `/p2a-next` 호출).

```bash
p2a next
```

`work.json`에서 진행 중 태스크(`T2`), 마지막 검증 실패 출력, 메모, 재개 요약을 즉시 복원합니다.

## 5. 개발 완료 및 정리

모든 태스크가 `done`이 되면 `p2a next`가 `ready_to_finish`를 안내합니다.

```bash
p2a done
```

모든 태스크의 완료·검증 통과를 확인한 뒤 `.plan2agent/work.json`을 삭제합니다. `.plan2agent/config.json`만 남으므로 다음 개발을 `p2a next --idea "..."`로 즉시 시작할 수 있습니다.

중단·폐기가 필요하면 `p2a done --abort`를 사용합니다.
