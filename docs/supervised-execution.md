# 감독형 개발 실행 레퍼런스

작성일: 2026-07-01 · 상태: 완료 기능 레퍼런스

이 문서는 과거 `plans/02-development-team-ai-agent.md`, `plans/02-1-p2a-dev-orchestrator.md`에 있던 개발 실행 계층 계획을 완료 기능 기준으로 정리한 문서다. 세부 작업 이력과 단계별 구현 계획은 더 이상 `plans/`에서 유지하지 않고, 현재 사용자가 알아야 할 운영 계약만 이 문서와 [CLI 사용자 가이드](cli-reference.md)에 남긴다.

## 1. 현재 결론

Plan2Agent는 Gate A-D planning harness 이후, 승인된 ready task 1건을 사람이 감독하는 foreground agent 세션으로 실행하고 결과를 파일 기반 run log로 추적하는 흐름을 제공한다.

완료된 범위:

| 영역 | 구현 |
| --- | --- |
| task/run tracking | `p2a.mjs tasks`, `p2a.mjs runs`, run/run-index schema |
| 감독형 단일 task 실행 | `p2a.mjs execute plan/start/resume/status/finish` |
| 감독형 orchestration | `p2a.mjs execute start --require-monitor/show/validate/handoff/next-role/role-prompt/mark-role/failure-policy` |
| runtime sidecar | `runs/<runId>.orchestration.json`, `runs/<runId>.monitor-gate.json` |
| monitor gate | `p2a-performance-monitor`와 monitor verdict 기반 finish 차단 |
| milestone review | `p2a-milestone-reviewer`가 완료된 task 범위의 통합 결함을 중간·종료 직전에 비차단 검토 |
| Hermes proposal loop | `p2a.mjs proposals mine/review/curate/draft-patch/approve-draft/digest` |
| provider-native guide | Codex, Claude, Gemini용 role prompt, runner guide, runner doctor, capability evidence |

이 실행 계층은 여러 agent를 무인으로 돌리는 scheduler가 아니다. P2A는 ready task, role, prompt, runtime 상태, monitor gate, proposal artifact를 조율하고, 실제 agent CLI/앱 세션은 사용자가 foreground에서 열어 감독한다.

## 2. 감독형 자동화 경계

허용:

- 사용자가 공식 Codex/Claude/Gemini CLI 또는 앱을 foreground로 열고 P2A가 출력한 prompt를 붙여넣는다.
- 해당 foreground 세션 내부에서 provider-native skill, subagent, custom agent, agent team, extension을 사용한다.
- P2A는 role prompt, next role, monitor gate, run state, proposal state를 파일로 기록한다.
- 결과는 사용자가 확인한 뒤 `p2a.mjs execute finish`, `p2a.mjs write monitor verdict`, `p2a.mjs proposals approve-draft` 같은 명령으로 명시 기록한다.

제외:

- P2A가 SDK/API로 provider를 직접 호출하는 방식.
- Codex/Claude/Gemini CLI를 background/headless로 무인 실행하는 방식.
- browser loop, 세션 쿠키/토큰 재사용, 계정 로테이션, rate limit 우회.
- 여러 provider가 같은 파일을 동시에 수정하는 mixed-provider implementation.
- approval 없는 patch 적용, PR 생성, push, merge.

## 3. Provider 전략

기본값은 single-provider supervised team이다.

| Provider | 역할 |
| --- | --- |
| Codex | skills/custom agents/명시 subagent prompt 기반 구현 후보. workspace-write 구현 agent 계약을 제공한다. |
| Claude | write-capable implementer mirror와 deterministic confinement를 제공한다. foreground 사람 승인 기준으로 사용한다. |
| Gemini | read-only planning/review/monitor 보조. write-required role에는 배정하지 않는다. |
| Manual | provider-native 기능이 없거나 위험한 경우 사람이 직접 실행하고 결과만 기록한다. |

P2A는 provider capability matrix와 role profile을 바탕으로 implementer, reviewer, monitor role을 배정한다. 계정 내부 team/subagent/extension 자동 introspection은 비목표이며, `runner-doctor --live`도 provider `--version` probe 수준으로 제한한다.

## 4. 표준 실행 흐름

1. ready task 확인:

```bash
node .plan2agent/scripts/p2a.mjs tasks ready --artifacts .plan2agent/artifacts/<project>
```

2. 단일 task 실행 계획 확인:

```bash
node .plan2agent/scripts/p2a.mjs execute plan \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id>
```

3. 복수 role 또는 monitor gate가 필요한 경우 monitor gate 생성:

```bash
node .plan2agent/scripts/p2a.mjs execute start --require-monitor \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id> \
  --output .plan2agent/orchestration/<task-id>.json
```

4. run 시작:

```bash
node .plan2agent/scripts/p2a.mjs execute start \
  --artifacts .plan2agent/artifacts/<project> \
  --task <task-id> \
  --agent-tool codex \
  --require-monitor
```

5. 사람이 foreground agent 세션에서 prompt를 실행하고 결과를 확인한다.

6. role 상태 기록:

```bash
node .plan2agent/scripts/p2a.mjs write monitor verdict \
  --runtime .plan2agent/artifacts/<project>/runs/<run-id>.monitor-gate.json \
  --role <role-id> \
  --role-status complete
```

7. 검증과 finish:

```bash
node .plan2agent/scripts/p2a.mjs execute finish \
  --run-id <run-id> \
  --artifacts .plan2agent/artifacts/<project> \
  --test \
  --lint \
  --typecheck \
  --collect-git
```

자세한 옵션은 [CLI 사용자 가이드](cli-reference.md)의 `p2a_execute.mjs`, `p2a_monitor_gate.mjs`, `p2a_proposals.mjs` 섹션을 기준으로 삼는다.

## 5. Run과 orchestration artifact

정본 파일:

| 파일 | 역할 |
| --- | --- |
| `.plan2agent/artifacts/<project>/runs/run-index.json` | run 목록과 최신 상태 index |
| `.plan2agent/artifacts/<project>/runs/<runId>.json` | task 실행 기록, changedFiles, verification, failureClass |
| `.plan2agent/artifacts/<project>/runs/<runId>.orchestration.json` | 실행 당시 monitor gate snapshot |
| `.plan2agent/artifacts/<project>/runs/<runId>.monitor-gate.json` | shared mental model, role assignment, communication log, runtime phase |
| `.plan2agent/artifacts/<project>/iterations/<iteration-id>/milestone-reviews/{midpoint,pre_close}.json` | 완료 task의 run evidence를 포함하는 checkpoint별 비차단 통합 리뷰 |
| `.plan2agent/proposals/*.json` | 실행 회고 기반 개선 후보 |
| `.plan2agent/proposals/reviews/*.json` | proposal deterministic review |
| `.plan2agent/proposals/curations/*.json` | proposal grouping/prioritization |
| `.plan2agent/proposals/patch-drafts/*.json` | 적용하지 않는 patch draft |
| `.plan2agent/proposals/approvals/*.json` | 사람이 승인한 proposal draft와 maintenance task 연결 |

`task-graph.schema.json`과 `run.schema.json`을 불필요하게 키우지 않고, 실행 계획과 runtime 상태는 sidecar로 분리한다.

## 6. Monitor gate와 failure policy

monitor gate가 필요한 run은 monitor verdict 없이 `done`으로 닫지 않는다.

표준 verdict shape:

```json
{
  "verdict": "confirm_done",
  "unmet_acceptance": [],
  "verification_concerns": [],
  "scope_concerns": [],
  "needs_user_decision": [],
  "note": ""
}
```

허용되지 않은 verdict, verification 실패, scope drift가 있으면 run은 blocked 또는 failed 상태로 닫고, `p2a.mjs proposals mine` 또는 `p2a.mjs proposals mine`으로 후속 조치를 만든다. 여러 concern 배열이 동시에 채워지면 failure class 매핑 우선순위는 `scope_concerns` → `verification_concerns` → `unmet_acceptance` → `needs_user_decision`이다.

`p2a.mjs execute start/status/finish`와 직접 `p2a.mjs runs start/finish` 출력 footer에는 copy-paste 가능한 `resume`, `status`, `finish`, `review` 명령이 남는다. `resume`은 `p2a.mjs execute resume --run-id <run-id>`로 같은 run의 launcher prompt를 다시 출력하고, `review`는 `p2a.mjs proposals mine --run-id <run-id>`로 실행 회고 후보를 생성한다.

### 6.1 Milestone review

각 task의 `p2a_execute finish`가 task graph를 갱신한 뒤 checkpoint를 계산한다. `midpoint`는 `done >= ceil(total / 2)`이면서 아직 미완료 task가 있을 때 한 번, `pre_close`는 모든 task가 done인 뒤 close-ready 검증 직전에 한 번만 대상이 된다. 경로는 `iterations/<iteration-id>/milestone-reviews/midpoint.json`과 `pre_close.json`으로 고정하며 파일이 이미 있으면 검증만 하고 재실행하거나 덮어쓰지 않는다. midpoint 시점을 놓치고 이미 전부 done이면 midpoint를 소급 생성하지 않고 pre-close만 실행한다.

reviewer에는 전체 task 상태와 full `task_graph_snapshot`, raw/snapshot hash, 승인 spec, 프로젝트 style contract와 함께 **모든 완료 task**의 최신 성공 run을 전달한다. 각 evidence에는 `task_id`, run id, artifact-root-relative `runs/<runId>.json` ref, raw run hash, full immutable `run_snapshot`과 deterministic snapshot hash, finished timestamp, 전체 `changedFiles`, 전체 verification 요약이 필요하고, task마다 적어도 하나의 실제 실행된 `config|command` 검증이 exit code 0으로 통과해야 한다. draft 검증 시 snapshot은 현재 run과 exact match해야 하며, 승격 뒤 finished run에 합법적인 `record`/`verify` 증거가 추가돼도 canonical checkpoint는 당시 snapshot으로 계속 검증된다. 하나라도 빠지면 부분 리뷰를 만들지 않고 skip 이유만 보고하며, 근거가 복구되면 아직 eligible한 checkpoint를 다시 시도한다.

reviewer는 남은 `todo`/`in_progress`/`blocked` 작업과 대조한 뒤 완료 범위에서 확인된 실제 통합 결함만 stable finding id와 구조화 evidence를 가진 `confirmed_findings`로 반환하고, 계획된 미구현 항목은 담당 task id를 포함한 `planned_todo_not_findings`로 분리한다. main owner는 source envelope와 결과를 합쳐 `<checkpoint>.<unique-id>.draft.json`을 만들고 다음 단일 명령으로 검증과 원자 승격을 수행한다.

```bash
node .plan2agent/scripts/p2a_iteration.mjs promote-milestone \
  --artifacts <artifact-root> \
  --draft <artifact-root>/iterations/<iteration-id>/milestone-reviews/<checkpoint>.<unique-id>.draft.json
```

CLI는 hard link의 create-if-absent 의미로 stable `<checkpoint>.json`을 원자 생성하고 성공한 unique draft만 삭제한다. 다른 프로세스가 먼저 stable 이름을 얻었다면 기존 파일을 덮어쓰지 않는다. maintenance 후보에는 `milestone-review:<artifact-path>#<finding_id>`를 출처로 남긴다. 이 JSON은 안정적인 informational source일 뿐 task 완료, run 상태, Gate D, 반복 close를 직접 차단하지 않는다.

## 7. Proposal loop

Hermes식 자가 개선은 자동 self-modify가 아니라 approval 기반 maintenance flow다.

```bash
node .plan2agent/scripts/p2a.mjs proposals mine --artifacts .plan2agent/artifacts/<project>
node .plan2agent/scripts/p2a.mjs proposals review --proposals .plan2agent/proposals
node .plan2agent/scripts/p2a.mjs proposals curate --review .plan2agent/proposals/reviews/<review>.json
node .plan2agent/scripts/p2a.mjs proposals draft-patch --curation .plan2agent/proposals/curations/<curation>.json --candidate-id <candidate-id>
node .plan2agent/scripts/p2a.mjs proposals approve-draft --draft .plan2agent/proposals/patch-drafts/<draft>.json --artifacts .plan2agent/artifacts/<project> --approved-by user
```

승인된 proposal은 maintenance task로 연결한 뒤 일반 `p2a.mjs execute` 흐름으로 실행한다. proposal artifact 자체는 patch를 자동 적용하지 않는다.

## 8. 안전 정책

- Gate B spec이 approved이고 open decision이 없어야 한다.
- Gate D review blocker가 없어야 한다.
- ready task와 acceptance criteria가 있어야 한다.
- 실패한 verification을 숨기고 task를 `done` 처리하지 않는다.
- task scope 밖 변경 파일은 run note 또는 blocker로 남긴다.
- `.plan2agent/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`, `scripts/`, `schemas/` 같은 harness/install 파일은 일반 application task의 수정 대상이 아니다.
- destructive cleanup, push, merge, PR 생성은 자동으로 하지 않는다.

## 9. 후속 후보

현재 완료 기능 위에 남은 후보는 다음이다.

- agent-generated monitor gate.
- PR 생성과 리뷰 상태 연동.
- code-aware spec 역생성과 결과 diff 병합.
- Memory 서버 기반 cross-session recall, run/proposal 검색, failure trend 분석.
- `p2a doctor/info/update/upgrade` 같은 상위 명령면 정리.

일반 multi-provider 무인 scheduler와 API 기반 완전 자동 개발은 기본 로드맵의 우선순위에서 제외한다.
