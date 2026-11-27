# Plan2Agent (`p2a`)

**AI 코딩 에이전트를 위한 최소 태스크 관리 및 세션 재개 하네스**

> English README: [README.md](README.md) · 문서 홈: [docs/README.md](docs/README.md)

Plan2Agent는 저장소에 수많은 문서를 쌓지 않으면서도, 하나의 개발 작업에서 태스크를 관리하고 세션이 꺼졌다 다시 켜져도 중단 지점부터 바로 이어서 개발할 수 있게 돕습니다.

- **프로젝트 상태 파일 최대 2개**: `.plan2agent/config.json`(검증 명령·설정)과 `.plan2agent/work.json`(현재 진행 중인 개발 상태, `p2a done` 시 삭제). **자동 생성 Markdown 파일 0개.**
- **1회 통합 확인**: 개발 시작 전 목표·범위·비범위·제약·태스크 목록을 한 번에 확인(`p2a approve --quote "..."`)하고, 승인된 계획 해시(`plan_sha256`)로 무단 변경을 차단합니다.
- **실제 명령 기반 검증**: `p2a verify`가 실제 테스트/린트/타입체크 명령을 실행해 종료 코드, Git HEAD, 워킹트리 지문(`.plan2agent/` 제외), 변경 파일을 기록합니다. 검증 통과 후 코드를 다시 수정하면 재검증 없이 `done` 처리할 수 없습니다.
- **끊김 없는 세션 재개**: 터미널이나 에이전트 세션이 언제 종료되어도 새 세션에서 `p2a next`만 실행하면 `work.json` 1개를 읽어 진행 중 태스크·마지막 검증 결과·메모·재개 요약을 그대로 복원합니다.
- **외부 의존성 0개**: Node.js `>=22.0.0` 표준 라이브러리만 사용합니다. Codex, Claude Code, Gemini CLI를 지원하며 BuildLore는 선택적으로 연동합니다.

---

## 빠른 시작

```bash
# 1. 설치
npm install -g plan2agent

# 2. 프로젝트 초기화 (.plan2agent/config.json + 최소 스킬/에이전트 설치)
p2a init --tools all

# 3. 개발 작업 시작
p2a next --idea "로그인 API에 요청 횟수 제한 추가"
```

### 기본 개발 흐름

```text
p2a next --idea "..."         # .plan2agent/work.json 초안 생성
  -> 코드 파악 및 태스크 정리 (work.json 또는 p2a task add)
  -> p2a approve --quote "..."  # 목표·범위·제약·태스크 1회 통합 확인
  -> p2a task start T1
  -> 코드 구현
  -> p2a verify --task T1       # 실제 검증 명령 실행 및 결과 기록
  -> p2a task done T1
     (중간에 세션이 종료되어도 새 세션에서 `p2a next`로 즉시 이어서 진행)
  -> p2a done                   # 모든 태스크 완료 확인 후 .plan2agent/work.json 정리
```

---

## 타겟 프로젝트에 생기는 파일

```text
.plan2agent/
  config.json   # project_id, 검증 명령(test/lint/typecheck), 선택적 BuildLore 설정
  work.json     # 현재 개발의 목표·승인·태스크·검증·재개 요약 (`p2a done` 시 삭제)
```

`p2a init --tools <codex,claude,gemini|all|none>`로 설치되는 프로바이더 자산:

- 핵심 스킬 2개: `.agents/skills/p2a-next/SKILL.md`, `.agents/skills/p2a-work/SKILL.md`
- 서브에이전트 2개: `.agents/agents/p2a-implementer.md`, `.agents/agents/p2a-reviewer.md`
- 프로바이더 미러: `.claude/`(스킬·에이전트·워크스페이스 훅), `.codex/agents/`, `.gemini/`(에이전트·`next`/`work` 명령)

`PLAN2AGENT.md`, `status.md`, `entries/*.md` 같은 자동 생성 마크다운이나 로컬 아카이브 폴더는 만들지 않습니다.

---

## 주요 CLI 명령

| 명령 | 역할 |
| --- | --- |
| `p2a init [--tools codex,claude,gemini\|all\|none]` | `.plan2agent/config.json` 생성(검증 명령 자동 감지) 및 최소 프로바이더 자산 설치 |
| `p2a next [--idea "<요청>" \| --entry <경로>] [--json]` | `work.json`을 읽어 현재 상태와 다음 행동 1개를 반환 (시작·세션 재개 공용) |
| `p2a approve --quote "<사용자 발화>"` | 계획을 1회 통합 승인하고 `approval.plan_sha256` 고정 |
| `p2a task <list\|add\|start\|note\|block\|unblock\|done>` | 태스크 추가, 의존성 관리, 진행·차단 전환, 메모 및 재개 요약 기록 |
| `p2a verify [--task <id>] [--cmd "<명령>"]` | 실제 검증 명령 실행 후 exit code, 출력 tail, git HEAD, 변경 파일 기록 |
| `p2a done [--abort]` | 모든 태스크 완료·검증 확인 후 `.plan2agent/work.json` 삭제 (`--abort`는 미완료 작업 폐기) |
| `p2a validate` / `p2a doctor` | `config.json`·`work.json` 스키마, DAG 무결성, 프로바이더 자산 진단 |
| `p2a buildlore <status\|memory\|lookup\|search\|sync\|handoff>` | *(선택)* BuildLore 읽기·단방향 전달 어댑터 (미설정 시 영향 없음) |

---

## 개발 및 테스트

```bash
npm run test:all
npm pack --dry-run
```

## 문서 목록

- [문서 홈](docs/README.md)
- [빠른 시작 가이드](docs/quickstart.md)
- [CLI 레퍼런스](docs/cli-reference.md)
- [하네스 스펙 (`config.json` · `work.json`)](docs/harness-spec.md)
- [릴리스 절차](docs/releasing.md)
- [v1.0 경량화 재설계 기록](docs/harness-slimming-transition-plan.md)
