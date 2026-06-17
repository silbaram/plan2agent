# 개발팀 AI agent 개발 계획

작성일: 2026-06-16 · 갱신일: 2026-06-17 · 상태: 1차 실행 대기 (결정 잠금 완료)

Plan2Agent의 Gate A-D planning harness 다음 단계로, **승인된 task를 실제 코드 변경·검증까지 수행하는 개발 실행 계층**을 구성하는 개발 계획서다. 이 문서는 방향 메모가 아니라 codex가 1차를 그대로 실행할 수 있도록 **결정을 잠근** 수준을 지향한다.

## 0. 기본 컨셉

개발 실행 계층은 두 외부 레포의 **운영 패턴(코드 아님)** 을 차용한다. 상세·라이선스는 §12.

- **개발팀 컨셉 — Team Big Five**: 복잡한 task를 `team-lead`/`contributor`/`performance-monitor` 역할로 협업·교차검증. 단, 모든 task에 팀을 붙이지 않고 triage로 단순/독립 task는 **단일 개발자 스킬(solo)** 로 처리한다. 즉 **기본은 개발팀, 폴백은 개발자 스킬 한 개**.
- **자가 발전 컨셉 — Hermes**: 실행 경험에서 **에이전트·스킬을 스스로 발전**시키는 closed learning loop. 단, Hermes의 자율 자기수정과 달리 P2A는 **proposal-only + 사람 승인** 으로 게이트한다(안전 분기).

## 1. 현재 상태 (전제)

이미 준비된 것:

- Gate A-D planning harness (read-only planning 계층).
- `p2a_tasks.mjs`: `ready`/`prompt`/`start`/`done`/`block`, `--artifacts`로 active iteration 자동 인식.
- `p2a_runs.mjs`: `start`/`record`/`verify`/`finish`/`list`/`show`/`validate`, `changedFiles`·verification·branch/worktree 격리 기록.
- `p2a_handoff.mjs`: scaffold/handoff + 선택적 Team Big Five adapter 설치.
- `sync_cli_assets.mjs`/`check_cli_parity.mjs`: canonical skill/agent를 Codex/Claude/Gemini mirror로 생성·검증.

핵심 제약:

- `sync_cli_assets.mjs`는 agent를 `access: read-only`, `capabilities: {read, search, web}` 만 허용한다. **write-capable subagent는 현재 구조적으로 불가** (확장 시 capability·CLI별 tool map·sandbox·3-CLI parity 필요).

아직 없는 것:

- 개발 실행 skill/agent 일체 (현재 0%).

## 2. 목적과 완료 기준 (DoD)

목적: **"승인된 task 1건을 실제 코드 변경까지 수행하고 결과를 run log로 추적하는 루프"를 안전하게 한 번 증명**한다.

1차 DoD — 아래를 **전부** 충족해야 완료:

- `.agents/skills/p2a-dev-execution/SKILL.md` 생성.
- `node scripts/sync_cli_assets.mjs`로 Codex/Claude/Gemini mirror 생성, `node scripts/check_cli_parity.mjs` green.
- `node scripts/run_fixtures.mjs` green (회귀 없음).
- (사람 수동) 별도 프로젝트에서 ready task 1건을 dev-execution으로 구현, run log에 `changedFiles`와 verification 결과 기록, task 상태가 `done` 또는 `blocked`로 갱신.
- 안전 불변식 유지: planning skill read-only, `sync_cli_assets` read-only 모델 미변경, 구현 쓰기가 대상 workspace 밖으로 나가지 않음.

## 3. 잠긴 결정 (Locked Decisions)

> 아래는 1차의 **확정값**이다. 바꾸려면 이 표를 먼저 고치고 하위 절을 재정렬한다. (옛 "열린 결정"을 확정으로 전환)

| # | 결정 | 확정값 | 근거 |
| --- | --- | --- | --- |
| LD-1 | 구현 주체 | **main 세션이 implementer** (별도 write-capable subagent 없음) | sync read-only 하드락; 루프 증명에 subagent 불필요 |
| LD-2 | `sync_cli_assets` write 확장 | **1차에서 안 함** | capability·tool map·sandbox·3-CLI parity = 며칠 규모 블로커 |
| LD-3 | 대상 CLI | **Codex 우선**, Claude/Gemini는 확장 | 구현을 codex가 수행; 한 CLI에서 먼저 증명 |
| LD-4 | 실행 모드 | **solo 기본**, 팀 모드는 확장 | Team Big Five triage의 독립-task 경로 |
| LD-5 | 자가 발전 | **dev-execution의 retrospective 섹션 + markdown proposal**, schema·skill-curator 연기 | 최소로 시작, 가치 확인 후 분리 |
| LD-6 | smoke test 주제 | **메모리 저장 bookmark REST API** (외부 DB 없음) | 빠른 test, scaffold 감지 용이 |

## 4. 범위 — 1차 vs 확장

1차 (in):

| 항목 | 산출물 |
| --- | --- |
| dev-execution skill | `.agents/skills/p2a-dev-execution/SKILL.md` (+ CLI mirror) |
| implementer 역할 지침 | dev-execution skill 내 role 섹션 (별도 agent 파일 X — LD-1) |
| retrospective/proposal | dev-execution skill 내 섹션, markdown proposal 출력 (LD-5) |

확장 (out, 1차 이후):

| 항목 | 미루는 이유 |
| --- | --- |
| `p2a-implementer` write-capable subagent | LD-1·LD-2 |
| `p2a-dev-orchestrator` / `p2a-performance-monitor` (팀 모드) | LD-4 |
| `p2a-skill-curator` + `skill-proposal` schema | LD-5 |
| Claude/Gemini 구현 검증, 3-CLI 실증 | LD-3 |
| PTY 기반 자동 실행/감시 | 로드맵 v2 |

이 절이 "모든 skill/agent를 한 번에 만든다"를 대체한다. **1차 작업은 §10만 따른다.**

## 5. 에이전트 구성 (역할·권한·실행 모드)

목표 아키텍처(3계층):

| 계층 | 책임 | 권한 | 파일/도구 |
| --- | --- | --- | --- |
| Planning | 아이디어를 승인된 spec/task graph로 변환 | read-only | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Execution | 승인된 task를 실제 코드 변경·검증으로 수행 | 구현은 workspace-write (1차는 main 세션) | `p2a-dev-execution`, (확장) `p2a-dev-orchestrator`, `p2a-implementer`, `p2a-performance-monitor` |
| Skill evolution | 실행 결과를 agent·skill 개선 proposal로 축적 (자동 적용 금지) | read-only + proposal 작성 | (확장) `p2a-skill-curator`, `skill-proposal` |

역할 매핑(Team Big Five → P2A): `team-lead` → `p2a-dev-orchestrator`, `contributor` → `p2a-implementer`, `performance-monitor` → `p2a-performance-monitor`.

실행 모드(triage):

- **1차 = solo**: main 세션이 `p2a-dev-execution` skill을 따라 직접 구현하고 `p2a_runs`로 검증을 기록한다. orchestrator/monitor 없음.
- **확장 = 팀**: 상호의존이 크거나 여러 영역이 맞물리는 task만 orchestrator가 팀 모드로 올려 `performance-monitor`의 독립 검증을 붙인다.

## 6. 경계와 안전

구현이 코드를 수정할 수 있는 **실행 조건**(전부 충족):

- task가 `p2a_tasks ready`에 노출된 상태.
- Gate B spec이 approved이고 open_decisions가 비어 있음.
- Gate D review blockers 없음.
- task에 acceptance criteria 존재.
- 사용자가 구현 실행을 명시.

**금지 행위**:

- planning artifact를 우회해 새 요구사항을 임의 추가.
- 최신이라는 이유만으로 무근거 dependency 설치.
- `.env`, credential, token, private key 접근 또는 출력.
- 실패한 검증을 숨기고 task를 `done` 처리.
- skill/agent 파일 자동 self-modify (반드시 proposal 경유).

**쓰기 경계와 격리**:

- 구현은 **별도 target 프로젝트 안에서만** 수행한다. plan2agent 레포 자신(`.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/`, `plans/`, `docs/`)은 쓰기 대상이 아니다.
- implementer 쓰기는 run의 `workspaceRef`(또는 worktree) 범위로 한정한다. 이 경로 밖 쓰기는 거부한다.
- `p2a_runs.mjs --isolation branch|worktree`로 격리해 실행하고, 중단/실패 시 **abort = 해당 worktree/branch 폐기**로 원복한다.
- 1차(main 세션)에서는 "별도 프로젝트 + isolation"으로 경계를 만들고, write-capable subagent 도입 시 sandbox·경로 화이트리스트로 **기계적으로 강제**한다.

write-capable subagent 도입 시(확장) 별도 주의: planning subagent는 계속 `read-only`, 구현 subagent만 `workspace-write`, shell capability는 검증 명령 중심으로 제한, CLI별 권한 모델 차이를 Codex/Claude/Gemini mirror에서 각각 확인.

## 7. 인터페이스·계약 (추측 금지)

skill frontmatter (1차 대상):

```yaml
---
name: p2a-dev-execution
description: Use when implementing a single ready Plan2Agent task into real code changes and recording the run, without touching planning artifacts.
---
```

agent frontmatter (확장 대상, 참고): `name`, `description`, `capabilities: [read|search|web]`, `access: read-only`, `tier: light|standard|heavy`.

`p2a-dev-execution` skill 계약:

- 입력: artifact root(또는 `--graph`), ready task id, agent-tool, optional run id.
- 절차: ready 확인 → `p2a_runs start` → 구현(쓰기 경계 §6 준수) → `p2a_runs verify` → `p2a_runs finish` → `p2a_tasks done`/`block` → retrospective.
- 출력: 변경 요약, `changedFiles`, verification summary, task status 권고, (선택) markdown skill proposal.
- 금지: Gate 미통과 task 실행 및 §6 금지 일체.

`p2a_runs` 핸드셰이크(정확한 명령):

```bash
node scripts/p2a_runs.mjs start  --artifacts <dir> --task <id> --agent-tool codex
node scripts/p2a_runs.mjs verify --run-id <id> --artifacts <dir> --test --lint --typecheck
node scripts/p2a_runs.mjs finish --run-id <id> --artifacts <dir> --status finished|failed|blocked --collect-git
```

`p2a_tasks` 핸드셰이크: `ready`/`prompt`/`done`/`block` with `--artifacts <dir>`.

`skill-proposal` (확장 schema 필드 후보): `proposalId`, `sourceRunId`, `problem`, `evidence`, `recommendedChange`, `targetFiles`, `risk`, `approval`. **1차는 schema 없이 markdown proposal로 시작(LD-5).**

## 8. 자가 발전 루프 (Hermes 차용, 게이트)

- **트리거**: task 완료/실패 후 dev-execution의 retrospective 섹션.
- **무엇을**: 반복된 실수, 누락된 검증, 재사용 가능한 절차 → 개선 후보(agent role·skill 둘 다 대상).
- **어떻게**: **proposal만** 작성(markdown) → 사람 승인 → **별도 turn에서 patch 적용**.
- **금지**: skill/agent 자동 적용. 한 번의 실행으로 바로 고치지 않는다.

## 9. 검증 전략 (자동 vs 수동·독립성)

- **자동(codex 실행)**: `node --check scripts/*.mjs`, `node scripts/sync_cli_assets.mjs`, `node scripts/check_cli_parity.mjs`, `node scripts/run_fixtures.mjs`, `git diff --check`.
- **수동(사람)**: smoke test(§11).
- **독립성**: solo 모드는 self-check라 독립성이 약하다 → acceptance/test/lint/typecheck 통과로 대체한다. 진짜 독립 monitor는 팀 모드(확장)에서만 보장한다.

## 10. 1차 작업 순서 (codex 실행 단위)

1. `sync_cli_assets.mjs`/`check_cli_parity.mjs`의 skill mirror 경로와 read-only 전제를 확인한다(수정하지 않는다).
2. §7 계약대로 `.agents/skills/p2a-dev-execution/SKILL.md`를 작성한다(implementer role 섹션 + retrospective 섹션 포함).
3. `node scripts/sync_cli_assets.mjs`로 Codex/Claude/Gemini mirror를 생성한다.
4. §9 자동 검증을 전부 green으로 만든다.
5. (사람) §11 smoke test 1건을 수행한다.

**스코프 펜스(수정 금지)**: `sync_cli_assets.mjs`의 ACCESS/CAPABILITY 모델, planning skill/agent, `schemas/`, 기존 `scripts/*.mjs` 로직. 1차에서 새로 만드는 것은 dev-execution skill 한 개와 그 mirror뿐이다.

## 11. smoke test 시나리오 (사람 수동 검증)

1. **plan2agent 레포 바깥에** 별도 target 프로젝트를 만들거나 별도 디렉터리에 co-located scaffold를 설치한다(하네스 자신을 구현 대상으로 삼지 않는다).
2. 한 문장 아이디어(LD-6: 메모리 저장 bookmark REST API)로 Gate A-D planning을 통과시킨다.
3. `node scripts/p2a_iteration.mjs init --artifacts artifacts/<project_id>` 로 반복 구조를 만든다.
4. `p2a_tasks ready` → `p2a_runs start` → `p2a-dev-execution`으로 구현 → `p2a_runs verify`.
5. 통과하면 `p2a_tasks done`, 막히면 `block`.

완료 기준: task 1건이 실제 코드 변경으로 완료, run log에 `changedFiles`·verification 기록, task 상태 `done`/`blocked` 갱신, planning read-only 경계 불변, 구현 쓰기가 workspace 밖(특히 하네스 파일)으로 나가지 않음.

## 12. 참조·라이선스

### Team Big Five (`https://github.com/tobyilee/team-bigfive`)

Salas Big Five 팀워크 모델을 agent에 적용한 하네스. 핵심 가설은 "agent 팀의 성과 병목은 개별 지능이 아니라 조율의 질"이다. 차용 패턴:

- 역할 분리: `team-lead`(오케스트레이션·전략·종합), `contributor`(도메인 구현), `performance-monitor`(phase 경계 교차검증·최종 게이트).
- solo/team triage: 독립 task는 단일 agent, 저상호의존은 monitor 생략 경량, 고상호의존만 풀 팀.
- shared mental model(SMM) 파일 외부화 + kickoff read-back ACK.
- closed-loop communication(`FLAG-UNCERTAIN`/`FLAG-DISSENT`), 검증 강도 = 경계 중요도, debrief/AAR.

주의: Team Big Five는 Claude-native(opus/sonnet)다. P2A는 Codex/Claude/Gemini를 모두 대상으로 하므로 **CLI-neutral adapter로 변환**하고(이미 handoff 경로 존재), 코드는 복사하지 않고 패턴만 차용하며 복사 전 **라이선스와 사용 범위를 다시 확인**한다.

### Hermes Agent (`https://github.com/nousresearch/hermes-agent`)

Nous Research의 self-improving agent. "경험에서 skill을 만들고 사용 중 개선하고 지식을 지속시키며 과거 대화를 검색"하는 closed learning loop가 핵심. 차용 패턴: 에이전트·스킬 자가 발전, cross-session 회고, 미지 기술 조사·근거 기록(P2A Gate B Technology Reconnaissance와 동형).

안전 분기: Hermes는 skill을 **자율적으로** 생성·수정한다. P2A는 같은 개념을 차용하되 **자동 적용 금지 + proposal-only + 사람 승인**으로 게이트한다. 즉 staged `proposal → review → approval → apply`는 Hermes 원본이 아니라 P2A가 안전을 위해 덧붙인 적응이다.
