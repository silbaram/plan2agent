# Plan2Agent Quickstart

Plan2Agent는 짧은 제품 아이디어를 Gate A 범위 확인, Gate B 제품·구현 명세, Gate C 실행 task graph로 바꾸는 파일 기반 planning harness다.

이 문서는 새 프로젝트에서 첫 실행 가능한 산출물을 만드는 최단 경로만 다룬다. 명령 옵션은 [CLI 사용자 가이드](cli-reference.md), 산출물 계약은 [하네스 사용자 가이드](harness-guide.md)를 기준으로 삼는다.

문서 홈: [Plan2Agent Docs](README.md)

## 설치

Plan2Agent를 전역 설치한 뒤 새 프로젝트를 초기화한다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
```

`--codex-profile quality`는 권장 Codex 설정을 설치한다. 부모 세션의 모델·reasoning 설정을 그대로 써야 하면 `inherit`을 선택한다. 초기화는 `.plan2agent/` 상태와 선택한 AI tool 자산만 만들며 실행 코드와 schema는 전역 `p2a` 패키지에 남는다.

## 첫 산출물 만들기

현재 상태에 맞는 한 가지 행동을 확인한다.

```bash
p2a next
```

한 문단 정도의 Markdown 또는 text 진입 문서를 작성한 뒤 경로를 전달한다. Agent 세션에서는 `/p2a-next --entry docs/idea.md`를 사용하고, 결과가 planning skill이면 같은 세션에서 반환된 `p2a-harness --entry` 행동을 이어간다.

```markdown
# Webhook delivery console

서명을 검증해 webhook을 수신하고 전송 이력을 보여주는 서비스를 만든다.
```

```bash
p2a next --entry docs/idea.md
```

하네스는 필요한 범위를 짧게 확인한 뒤 Gate A 요약을 제시한다. 사용자가 요약을 명시적으로 확인하면 `intake.json`에 `status: ready_for_spec`와 `approval_audit`을 기록하고 Gate B 명세를 만든다. Gate B 승인에는 `spec.approval: approved`, `approval_audit`, 빈 `open_decisions`가 필요하다.

승인된 Gate B를 기준으로 Gate C task graph draft를 만들고 validator를 실행한다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --stage gate-c-draft

p2a iteration promote-tasks \
  --artifacts .plan2agent/artifacts/<project_id>
```

Gate C에는 별도 사람 승인 audit이나 `--approved-by`/`--approval-note`가 없다. Draft가 validator를 통과하면 정본 `task-graph.json`으로 승격할 수 있다.

## 검증하고 개발 시작하기

Flat artifact root는 Gate A/B/C 정본만으로 검증과 반복 초기화를 진행한다.

```bash
p2a validate \
  --artifact-root .plan2agent/artifacts/<project_id> \
  --project-id <project_id> \
  --require-handoff-ready

p2a iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

`gate-d-review/review.json`은 필요하지 않다. 레거시 review 파일이 있더라도 promotion, iteration init, handoff, close의 조건으로 사용되지 않는다.

각 행동 뒤에는 다시 `p2a next`를 실행해 ready task 실행, run 종료, 다음 반복 close/open 행동을 확인한다.

반복을 닫기 전에는 같은 조건을 validator로 먼저 확인할 수 있다.

```bash
p2a iteration validate \
  --artifacts .plan2agent/artifacts/<project_id> \
  --require-close-ready

p2a iteration close \
  --artifacts .plan2agent/artifacts/<project_id>
```

Close는 Gate D 파일 대신 승인된 Gate B, 유효한 Gate C, 완료된 task와 해당 실행 증거를 검사한다.

## 어떤 파일을 봐야 하나

| 파일 | 언제 보는가 |
| --- | --- |
| `.plan2agent/artifacts/<project_id>/status.md` | 현재 상태와 다음 행동을 빠르게 확인할 때 |
| `gate-a-intake/intake.json` | 확인된 범위와 Gate A 승인 기록을 확인할 때 |
| `gate-b-spec/spec.json` | 승인된 제품·구현 요구사항을 확인할 때 |
| `gate-c-task-graph/task-graph.json` | 구현 가능한 task와 dependency를 확인할 때 |
| `iterations/<iteration-id>/` | 반복 개발과 실행 증거를 확인할 때 |

## 다음에 볼 문서

- [CLI 사용자 가이드](cli-reference.md) — 명령별 사용법, handoff와 proposal 흐름
- [하네스 사용자 가이드](harness-guide.md) — Gate A-C, 산출물 schema, 검증과 문제 해결
- [반복/고도화 개발 스펙](iteration-spec.md) — 반복 구조, close/open, 변경분 task 계약
- [감독형 개발 실행 레퍼런스](supervised-execution.md) — ready task 실행, monitor gate, milestone review, retry recovery
- [하네스 구현 기준](harness-spec.md) — P2A skill/subagent와 mirror를 수정할 때의 원칙
