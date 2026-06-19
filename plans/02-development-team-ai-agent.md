# 개발팀 AI agent 개발 계획

작성일: 2026-06-16 · 갱신일: 2026-06-19 · 상태: Level 1 완료, Codex 실행 계층 부분 구현, 자가 발전 첫 사이클 적용, Claude 감독형 write 추가, 자동 실행기는 후속

Plan2Agent의 Gate A-D planning harness 다음 단계로, **승인된 task를 실제 코드 변경·검증까지 수행하는 개발 실행 계층**을 구성하는 계획서다. 이 문서는 현재 코드 상태를 기준으로 완료된 범위, 남은 범위, 안전 경계, 다음 개발 순서를 고정한다.

## 0. 현재 결론

현재 저장소는 "기획 산출물 생성 -> task graph 관리 -> 반복 구조 -> handoff/scaffold -> run log 기록 -> 사람 주도 개발 실행 절차"까지 구현되어 있다.

자동 PTY 실행기나 PR 생성기는 아직 없다. 대신 **Codex(sandbox)·Claude(감독형) write-capable implementer**와, **CLI 공통으로 동작하는 독립 monitor·skill curator(둘 다 read-only)·retrospective proposal schema** 계약까지는 들어와 있다. Gemini implementer는 아직 read-only다.

현재 상태 요약:

| 축 | 상태 | 구현 |
| --- | --- | --- |
| Planning harness | 완료 | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Task/runtime tracking | 완료 | `p2a_tasks.mjs`, `p2a_runs.mjs`, `run.schema.json`, `run-index.schema.json` |
| Handoff/scaffold | 완료 | `p2a_handoff.mjs scaffold`, legacy handoff, Team Big Five adapter 설치 |
| Dev execution skill | 완료 | `.agents/skills/p2a-dev-execution/SKILL.md` 및 Claude mirror, Gemini command |
| Codex implementer | 구현됨 | `.agents/agents/p2a-implementer.md`, Codex mirror는 `sandbox_mode = "workspace-write"` |
| Claude implementer | 감독형 write | mirror에 `Edit`/`Write`/`Bash` 부여, foreground 사람 승인으로 동작 (deterministic confinement는 Level 2 step 2 후속) |
| Gemini implementer | read-only | mirror는 생성되나 write tool 미부여(read/search). Level 2 후속 |
| Independent monitor | 계약 구현 | `p2a-performance-monitor` read-only verifier |
| Skill evolution | 계약 구현 | `p2a-skill-curator`, `schemas/skill-proposal.schema.json` |
| Agent 자동 실행 | 미구현 | PTY/session orchestration, scheduler, retry, PR 연동은 후속 |

검증 기준:

- `node scripts/check_cli_parity.mjs` green
- `node scripts/run_fixtures.mjs` green
- `node --check scripts/*.mjs` 계열 문법 검사 green

## 1. 기본 컨셉

개발 실행 계층은 두 외부 레포의 **운영 패턴(코드 아님)** 을 차용한다. 상세·라이선스는 §12.

- **개발팀 컨셉 - Team Big Five**: 복잡한 task를 `team-lead`/`contributor`/`performance-monitor` 역할로 협업·교차검증한다. 현재 P2A에는 Team Big Five adapter 설치와 `p2a-performance-monitor` 계약이 들어와 있지만, P2A-native `p2a-dev-orchestrator`와 PTY 팀 실행기는 아직 없다.
- **자가 발전 컨셉 - Hermes**: 실행 경험에서 agent·skill 개선 후보를 축적한다. P2A는 자동 self-modify를 금지하고, `skill-proposal` JSON을 남긴 뒤 사람 승인 후 별도 turn에서 적용한다.

## 2. 현재 상태

이미 준비된 것:

- Gate A-D planning harness.
- `p2a_tasks.mjs`: `ready`/`prompt`/`start`/`done`/`block`, `--artifacts` active iteration 자동 인식, `--maintenance` lane 지원.
- `p2a_runs.mjs`: `start`/`record`/`verify`/`finish`/`list`/`show`/`validate`, `changedFiles`, verification, branch/worktree 격리 기록, `--create-isolation` 선택 생성.
- `p2a_handoff.mjs`: co-located `scaffold`, legacy handoff, 선택적 Team Big Five adapter 설치.
- `sync_cli_assets.mjs`: canonical skill/agent에서 Claude/Codex/Gemini mirror 생성. `access: workspace-write`를 허용하며 Codex target에는 `sandbox_mode = "workspace-write"`로 렌더링한다.
- `check_cli_parity.mjs`: 현재 canonical skill/agent와 mirror 상태를 검증한다. `p2a-dev-execution`, `p2a-implementer`, `p2a-performance-monitor`, `p2a-skill-curator`를 포함한다.
- `p2a-dev-execution`: ready task 1건을 구현하고 run log로 기록하는 실행 절차 skill.
- `p2a-implementer`: Codex workspace-write 구현 agent 계약.
- `p2a-performance-monitor`: run log와 acceptance criteria를 read-only로 검토해 `confirm_done` 또는 `block` verdict를 반환하는 계약.
- `p2a-skill-curator`: retrospective proposal을 normalize/dedupe/prioritize하는 read-only 계약.
- `schemas/skill-proposal.schema.json`: retrospective proposal의 구조화 schema.

아직 없는 것:

- Plan2Agent가 Codex/Claude/Gemini CLI를 직접 PTY로 실행하고 감시하는 자동 실행기.
- `p2a-dev-orchestrator` P2A-native team lead agent.
- Claude 무인 자율 write(deterministic confinement) 및 Gemini write-capable implementer.
- monitor/curator를 자동으로 호출하고 결과를 강제하는 scheduler.
- PR 생성, 리뷰 상태 연동, 실패 재시도 정책 자동화.
- code-aware spec 역생성, 결과 diff 자동 병합.

## 3. 완료 기준과 현재 충족도

목표: **"승인된 task 1건을 실제 코드 변경까지 수행하고 결과를 run log로 추적하는 루프"를 안전하게 증명**한다.

| 기준 | 현재 상태 | 비고 |
| --- | --- | --- |
| dev-execution skill 생성 | 완료 | `.agents/skills/p2a-dev-execution/SKILL.md` |
| Codex/Claude/Gemini mirror 생성 | 완료 | `sync_cli_assets.mjs`, `check_cli_parity.mjs` |
| fixture 회귀 green | 완료 | `run_fixtures.mjs` |
| Codex write-capable implementer 계약 | 완료 | `.codex/agents/p2a-implementer.toml`은 `workspace-write` |
| independent monitor 계약 | 완료 | `p2a-performance-monitor` |
| structured retrospective proposal | 완료 | `skill-proposal.schema.json`, `p2a-skill-curator` |
| 별도 target 프로젝트에서 실제 task 1건 smoke | 수동 검증 필요 | 저장소 fixture는 도구 회귀를 검증하지만 실제 앱 구현 smoke를 대체하지 않는다 |
| PTY 자동 실행/감시 | 미구현 | 후속 v2 |

현재 문서상 Level 1은 자동 검증 기준으로 완료됐다. 다만 "외부 target 프로젝트에서 실제 앱 task 1건을 끝까지 구현"하는 smoke는 별도 수동 증빙 항목으로 남긴다.

## 4. 잠긴 결정

| # | 결정 | 현재 확정값 | 근거 |
| --- | --- | --- | --- |
| LD-1 | 구현 주체 | Codex에서는 `p2a-implementer` workspace-write subagent 사용 가능. 불가한 CLI는 main-session flow로 폴백 | Codex sandbox가 workspace-write를 제공하고 mirror가 생성된다 |
| LD-2 | `sync_cli_assets` write 확장 | Codex target에 한해 구현됨 | `ACCESS_VALUES`가 `workspace-write`를 허용하고 Codex TOML에 sandbox를 렌더링한다 |
| LD-3 | 대상 CLI | Codex(sandbox)·Claude(감독형 write). Gemini는 read-only mirror | Claude 무인 자율·Gemini write 권한 모델은 후속 |
| LD-4 | 실행 모드 | solo 기본 + monitor gate. 팀 orchestration은 후속 | `p2a-dev-orchestrator`와 PTY scheduler가 아직 없다 |
| LD-5 | 자가 발전 | JSON proposal + read-only curator + 사람 승인 | `skill-proposal.schema.json`과 `p2a-skill-curator`가 존재한다 |
| LD-6 | smoke test 주제 | 메모리 저장 bookmark REST API 같은 외부 DB 없는 작은 앱 | 빠른 검증과 scaffold 감지가 쉽다 |
| LD-7 | 검증 원칙 | verification은 실제 명령 실행 결과여야 함 | `p2a-dev-execution`과 monitor가 manual/self-report verification을 불충분하게 본다 |

## 5. 범위

현재 in:

| 항목 | 산출물 |
| --- | --- |
| dev-execution skill | `.agents/skills/p2a-dev-execution/SKILL.md`, `.claude/skills/...`, `.gemini/commands/p2a/dev-execution.toml` |
| Codex implementer | `.agents/agents/p2a-implementer.md`, `.codex/agents/p2a-implementer.toml` |
| monitor gate | `.agents/agents/p2a-performance-monitor.md`와 CLI mirrors |
| retrospective proposal | `schemas/skill-proposal.schema.json`, `.agents/agents/p2a-skill-curator.md` |
| run tracking | `p2a_runs.mjs`, run schemas, validator support |
| isolated execution record | `--isolation branch|worktree`, `--create-isolation`, `workspaceRef`, `changedFiles` |

후속 out:

| 항목 | 미루는 이유 |
| --- | --- |
| `p2a-dev-orchestrator` | 팀 실행 정책과 PTY/session runtime이 먼저 필요하다 |
| Claude 무인 자율 write(deny-rules/hook/sandbox) · Gemini write-capable implementer | CLI별 write permission/sandbox 모델 검증 필요 (Claude 감독형 write는 완료) |
| PTY 기반 자동 실행/감시 | 별도 runtime/scheduler 설계 필요 |
| PR 생성/리뷰 연동 | run log와 task 상태가 안정된 뒤 붙인다 |
| 실패 재시도 정책 자동화 | retry가 요구사항 변경과 충돌할 수 있어 gate 설계 필요 |
| code-aware spec 역생성 | 코드 분석과 plan-code trace store가 필요하다 |

## 6. 에이전트 구성

목표 아키텍처:

| 계층 | 책임 | 권한 | 현재 구현 |
| --- | --- | --- | --- |
| Planning | 아이디어를 승인된 spec/task graph로 변환 | read-only | `p2a-harness`, `p2a-intake`, `p2a-spec`, `p2a-task-breakdown`, `p2a-review` |
| Task authoring | 승인 spec에서 Gate C task 초안 작성 | read/write planning artifact 한정 | `p2a-task-author`, `context`, `promote-tasks` |
| Execution | ready task를 실제 코드 변경으로 수행 | Codex workspace-write, Claude 감독형 write, Gemini read-only mirror | `p2a-dev-execution`, `p2a-implementer` |
| Verification | 실행 결과와 acceptance criteria 독립 검토 | read-only | `p2a-performance-monitor` |
| Skill evolution | 실행 회고를 proposal로 축적 | read-only + proposal review | `p2a-skill-curator`, `skill-proposal` |

Team Big Five 역할 매핑:

| Team Big Five | P2A 현재 상태 |
| --- | --- |
| `team-lead` | 후속 `p2a-dev-orchestrator` 후보 |
| `contributor` | `p2a-implementer` |
| `performance-monitor` | `p2a-performance-monitor` |

실행 모드:

- **현재 기본 = solo + monitor**: `p2a-dev-execution`이 ready 확인, run start, 구현, verify, finish, monitor gate, task done/block 순서를 안내한다.
- **Codex 구현 경로**: 가능하면 `p2a-implementer`를 isolated worktree/workspace에서 사용한다. 단 `p2a-implementer`는 scoped 파일 편집만 하고, `p2a_runs verify`/`finish`와 `p2a_tasks done|block` 같은 run lifecycle은 main owner(이 스킬을 도는 주체)가 전담한다(자가 발전 첫 사이클로 명확화됨).
- **Claude 구현 경로**: `p2a-implementer` mirror가 write-capable(`Edit`/`Write`/`Bash`)이며 **foreground 사람 승인**으로 동작한다. deterministic confinement(deny-rules/hook/sandbox)는 Level 2 step 2 후속.
- **Gemini 구현 경로**: 아직 read-only mirror라 main-session/human-supervised flow로 폴백한다.
- **팀 모드**: 복잡한 task의 team orchestration은 아직 Plan2Agent-native runtime이 없다. Team Big Five adapter 설치는 가능하지만 자동 실행은 하지 않는다.

## 7. 경계와 안전

구현 실행 조건:

- task가 `p2a_tasks ready`에 노출되어야 한다.
- Gate B spec이 approved이고 `open_decisions`가 비어 있어야 한다.
- Gate D review blockers가 없어야 한다.
- task에 acceptance criteria가 있어야 한다.
- 사용자가 구현 실행을 명시해야 한다.

금지 행위:

- planning artifact를 우회해 요구사항을 임의 추가.
- 승인 근거 없이 dependency 설치.
- `.env`, credential, token, private key 접근·출력·복사.
- 실패한 검증을 숨기고 task를 `done` 처리.
- skill/agent/schema를 실행 중 자동 self-modify.
- Plan2Agent harness 파일을 구현 task 대상으로 수정.

쓰기 경계:

- 구현은 별도 target 프로젝트 또는 isolated worktree 안에서만 수행한다.
- `p2a-implementer`는 run의 `workspaceRef` 또는 worktree 범위를 유일한 쓰기 표면으로 본다.
- co-located 프로젝트에서는 `.plan2agent/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/` 같은 harness/install 파일을 앱 구현 변경 대상으로 보지 않는다.
- 중단/실패 시 branch/worktree는 사용자가 확인한 뒤 폐기한다. 자동 destructive cleanup은 하지 않는다.

## 8. 인터페이스 계약

`p2a-dev-execution` 입력:

- artifact root 또는 explicit graph
- ready task id
- `agent-tool` 값, 보통 `codex`
- optional run id

표준 흐름:

```bash
node scripts/p2a_tasks.mjs ready --artifacts <dir>
node scripts/p2a_tasks.mjs prompt --artifacts <dir> <task-id>
node scripts/p2a_runs.mjs start --artifacts <dir> --task <task-id> --agent-tool codex --isolation worktree --worktree <fresh-worktree-path> --create-isolation
node scripts/p2a_runs.mjs verify --run-id <run-id> --artifacts <dir> --test --lint --typecheck
node scripts/p2a_runs.mjs finish --run-id <run-id> --artifacts <dir> --status finished|failed|blocked --collect-git
```

monitor gate:

- 입력은 task acceptance criteria와 latest run log다.
- 출력은 아래 shape를 따른다.

```json
{
  "verdict": "confirm_done",
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "note": ""
}
```

task 상태 반영:

```bash
node scripts/p2a_tasks.mjs done --artifacts <dir> <task-id>
node scripts/p2a_tasks.mjs block --artifacts <dir> <task-id>
```

retrospective proposal:

- 경로: `.plan2agent/proposals/<proposalId>.json`
- schema: `schemas/skill-proposal.schema.json`
- status 초기값: `proposed`
- 적용은 별도 사람 승인 후 별도 turn에서 수행한다.

## 9. 자가 발전 루프

트리거:

- task 완료
- task 실패
- verification 누락
- scope boundary 위반 위험 발견
- 반복되는 실행 실수 발견

현재 구현:

- `p2a-dev-execution`이 retrospective gate를 갖는다.
- 개선 후보는 freeform markdown이 아니라 `p2a.skill_proposal.v1` JSON으로 남긴다.
- `p2a-skill-curator`는 proposal과 run log를 읽어 normalize, dedupe, prioritize, recommended disposition을 반환한다.

불변식:

- 실행 중 skill/agent/schema를 자동 수정하지 않는다.
- curator는 read-only다.
- proposal 적용은 human approval 이후 별도 patch로 한다.

## 10. 검증 전략

자동 검증:

```bash
node --check scripts/check_cli_parity.mjs
node --check scripts/p2a_handoff.mjs
node --check scripts/p2a_iteration.mjs
node --check scripts/p2a_iteration_state.mjs
node --check scripts/p2a_runs.mjs
node --check scripts/p2a_tasks.mjs
node --check scripts/run_fixtures.mjs
node --check scripts/sync_cli_assets.mjs
node --check scripts/validate_artifacts.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

수동 smoke:

1. plan2agent repo 밖에 target 프로젝트를 만든다.
2. `node scripts/p2a_handoff.mjs scaffold --target <project-dir> --tools all`로 co-located harness를 설치한다.
3. 작은 REST API 같은 외부 DB 없는 아이디어로 Gate A-D를 통과시킨다.
4. `p2a_tasks ready`로 ready task를 확인한다.
5. `p2a_runs start`로 run을 시작하고, 가능하면 Codex `p2a-implementer`를 isolated worktree에서 사용한다.
6. `p2a_runs verify`가 실제 test/lint/typecheck 명령을 실행하게 한다.
7. `p2a-performance-monitor` verdict 후 `done` 또는 `block`으로 상태를 반영한다.

수동 smoke 완료 기준:

- 실제 코드 변경이 target workspace 안에서만 발생한다.
- run log에 `changedFiles`, `verification`, `agentTool`, `workspaceRef`, `finishedAt`이 남는다.
- task 상태가 `done` 또는 `blocked`로 갱신된다.
- Plan2Agent harness 파일은 구현 변경에 포함되지 않는다.

## 11. 다음 개발 순서

우선순위 원칙:

- PR 생성/리뷰 연동은 사용자가 명시적으로 요청하기 전까지 자동화하지 않는다.
- 기본 개발 루프는 branch/worktree, changedFiles, verification, run summary까지만 준비한다.
- 자동 실행보다 먼저 실패와 차단 사유를 구조화한다. 그래야 retry, orchestrator, monitor gate가 안전하게 판단할 수 있다.

우선순위 높은 순서:

1. **실패 분류/차단 사유 표준화**
   - 목적: `done`이 아닌 run/task 결과를 사람이 읽는 메모가 아니라 기계가 판단할 수 있는 reason code로 남긴다.
   - 후보 reason code: `verification_failed`, `scope_violation`, `missing_dependency`, `needs_user_decision`, `environment_failure`, `test_flake`, `implementation_incomplete`, `monitor_blocked`.
   - 산출물 후보: run log 또는 별도 sidecar에 `blockReason`, `failureClass`, `retryable`, `needsUserDecision` 같은 구조화 필드 추가.
   - 완료 기준: `p2a_runs finish --status failed|blocked`와 `p2a_tasks block` 흐름에서 차단 사유가 일관되게 기록되고 validator/fixture가 이를 검증한다.

2. **Codex 단일 task 자동 실행기**
   - 목적: 한 번에 ready task 1개만 대상으로 `worktree 생성 -> p2a_runs start -> Codex 실행 -> verify -> monitor -> done/block`을 자동화한다.
   - 범위: Codex 우선. Claude/Gemini 실행은 adapter layer 후속.
   - 선행 조건: 1번의 실패 분류가 있어야 자동 실행 결과를 안전하게 종료/재시도/사용자 질문으로 나눌 수 있다.
   - 비목표: 여러 agent 병렬 실행, PR 생성, 자동 merge.

3. **`p2a-dev-orchestrator` 설계와 구현**
   - 목적: Team Big Five의 team-lead 역할을 P2A-native로 분리한다.
   - 판단 항목: solo로 충분한 task인지, monitor만 붙일지, 여러 contributor로 나눌지, 실패가 retry 가능한지, 사용자 결정을 요구하는지.
   - 선행 조건: 단일 Codex 실행기가 안정적으로 task 1개를 끝낼 수 있어야 한다.

4. **Hermes식 proposal/curator 루프 고도화**
   - 목적: 실제 run에서 쌓인 proposal을 normalize, dedupe, prioritize하고 승인 대기 목록으로 정리한다.
   - 범위: proposal 자동 적용은 계속 금지한다.
   - 산출물 후보: proposal review digest, 승인 후보 diff 초안, 반복적으로 발생한 실패 유형 통계.

5. **UI/DB 기반 task store**
   - 목적: 파일 기반 운용이 불편해지는 시점에 task/run/proposal 검색과 대시보드를 제공한다.
   - 착수 조건: 다중 프로젝트, 여러 명의 동시 사용, run history 증가, task 검색 불편이 실제 문제로 확인될 때.
   - 비목표: 현재 전문 개발자 1인/소규모 dogfooding 단계에서 즉시 구현하지 않는다.

6. **PR 생성/리뷰 연동**
   - 정책: 사용자가 명시적으로 요청한 경우에만 실행한다.
   - 기본 루프에서는 PR을 만들지 않는다. Plan2Agent는 branch, changedFiles, verification, run summary까지만 준비한다.
   - 후속 범위: PR body 자동 작성, CI 상태 읽기, 리뷰 comment/request changes를 run/task 상태와 연결.
   - 비목표: 자동 push, 자동 merge, 사용자 승인 없는 PR 생성.

추가 후속:

- code-aware spec 역생성과 result diff 병합은 execution layer와 run history가 안정된 뒤 설계한다.

## 12. 참조·라이선스

### Team Big Five (`https://github.com/tobyilee/team-bigfive`)

Salas Big Five 팀워크 모델을 agent에 적용한 하네스다. P2A가 차용하는 패턴:

- 역할 분리: `team-lead`, `contributor`, `performance-monitor`
- solo/team triage
- shared mental model 파일 외부화
- closed-loop communication
- phase boundary 검증
- debrief/AAR

주의: Team Big Five는 Claude-native다. P2A는 Codex/Claude/Gemini를 모두 대상으로 하므로 CLI-neutral adapter로 변환한다. 코드는 무조건 복사하지 않고, local source를 설치할 때는 safe filter와 source manifest로 출처와 범위를 기록한다.

### Hermes Agent (`https://github.com/nousresearch/hermes-agent`)

Hermes의 self-improving loop에서 차용하는 패턴:

- 실행 경험에서 skill 개선 후보를 찾는다.
- cross-session 회고를 남긴다.
- 미지 기술은 근거와 함께 기록한다.

안전 분기:

- Hermes식 자동 self-modify는 P2A에서 금지한다.
- P2A는 `proposal -> curator review -> human approval -> separate patch` 흐름만 허용한다.

## 13. 외부 레포 흡수 현황 (Team Big Five / Hermes)

§1·§12의 두 차용 컨셉을 "무엇이 흡수됐는지" 관점으로 정리한다. (✅ 완료 / 🟡 부분 / ⬜ 미착수)

### Team Big Five
| 항목 | 상태 | 비고 |
| --- | --- | --- |
| performance-monitor (독립 검증) | ✅ | `p2a-performance-monitor` |
| contributor (구현자) | ✅ | `p2a-implementer` — Codex `workspace-write` + **Claude 감독형 write(Edit/Write/Bash)** 구현됨. Gemini는 read-only(Level 2 후속) |
| debrief/evolution (회고→개선) | ✅ | dev-execution retrospective + `p2a-skill-curator` |
| mutual monitoring (검증 강도 차등) | 🟡 | 독립 검증은 됨, "중요도별 강도 조절"은 미적용 |
| team-lead / orchestrator | ⬜ | `p2a-dev-orchestrator` 미구현 |
| solo/team triage | ⬜ | 모드 자동 판단 미구현 |
| shared mental model 파일 | ⬜ | 팀 모드용 |
| closed-loop 통신 | ⬜ | 팀 모드용 |

### Hermes
| 항목 | 상태 | 비고 |
| --- | --- | --- |
| skill = 반복 절차 기억 | ✅ | 스킬 시스템 전반 |
| 자가 발전 (proposal→curator→승인→적용) | ✅ | **첫 사이클 완결**: 실제 run 회고 → `skill-proposal` → 사람 승인 → lifecycle-ownership patch 적용 |
| staged proposal→review→approval→apply | ✅ | `skill-proposal.schema.json` + `p2a-skill-curator` |
| 미지 기술 조사 + 근거 | ✅ | Gate B Technology Reconnaissance |
| cross-session recall | 🟡 | run log + curator 횡단 읽기만. 세션 전체 검색·요약은 미적용 → 아래 연기 |

### 남은 확장과 난이도 (현재 기준)
- ✅ **write-capable subagent (Codex)** — 완료. Codex `workspace-write` sandbox로 confine, spike로 실증.
- 🟡 **Level 2: Claude 무인 자율(deny-rules/hook/sandbox) + Gemini write** — Claude 감독형 write는 완료; 무인 자율 confinement와 Gemini write가 남음(Codex와 달리 native sandbox 없음).
- 🟡 **orchestrator / triage / SMM / closed-loop** — Codex write 토대가 생겨 착수 가능하나, 진짜 team mode는 PTY/multi-agent runtime + Level 2가 받쳐줘야 풀가동.
- 🔴 **PTY 자동 실행/감시** — 별개 runtime/scheduler. 실행 루프가 무인-안전해진 뒤의 capstone (v2).
- 🟡 **cross-session recall** — store/DB 단계로 연기(아래).

### cross-session recall — store/DB 단계로 연기 (결정)
파일 기반 단계에서 무리해 만들지 않고, **JIRA식 Task Store/DB(§11-5, v2) 도입 시 함께 얹는다.**
- 이유: recall의 난관(① 관련성 검색 백엔드, ② 무-DB·결정적 제약과 충돌)이 store 도입으로 자연 해소된다(DB full-text/pgvector가 곧 index).
- store는 백엔드만 제공하므로 그때 남는 결정 2개: (a) 검색 대상(run/proposal은 자동, 대화·세션 transcript는 별도 캡처 결정) (b) 무엇을 재사용 "교훈"으로 distill할지.
