# Plan2Agent Quickstart

Plan2Agent는 한 문장 아이디어를 승인 가능한 제품·구현 명세와 실행 가능한 task graph로 바꾸는 파일 기반 planning harness다.

이 문서는 새 프로젝트에서 첫 Gate 산출물을 만드는 최단 경로만 다룬다. 명령 옵션과 실행 계약은 [CLI 사용자 가이드](cli-reference.md), Gate와 산출물 계약은 [하네스 사용자 가이드](harness-guide.md)를 기준으로 삼는다.

문서 홈: [Plan2Agent Docs](README.md)

## 설치

새 프로젝트에 co-located scaffold를 설치한다. 아래 명령은 Plan2Agent 본체 저장소에서 실행한다.

```bash
node /path/to/plan2agent/scripts/p2a_handoff.mjs scaffold \
  --target <project-dir> \
  --tools all \
  --codex-profile quality
```

```bash
cd <project-dir>
```

`--codex-profile quality`는 권장 Codex 설정을 설치한다. 부모 세션의 모델·reasoning 설정을 그대로 써야 하면 `inherit`을 선택한다. 설치가 만드는 `.plan2agent/`는 로컬 하네스 상태이므로 애플리케이션 소스 git에 커밋하지 않는다.

## 첫 산출물 만들기

방금 scaffold한 프로젝트에서 Codex, Claude Code 또는 Gemini CLI를 열고 다음 prompt를 실행한다.

```text
/p2a-harness "만들고 싶은 제품을 한 문장으로 설명"
```

하네스는 Gate A intake, Gate B spec, Gate C task graph, Gate D review 산출물을 `.plan2agent/artifacts/<project_id>/`에 만든다. Gate B를 승인하기 전에는 구현을 시작하지 않는다.

## 결과 확인

프로젝트 상태와 다음 행동을 확인한다.

```bash
node .plan2agent/scripts/p2a.mjs info
```

출력에서 active artifact, Gate 상태, ready task 수를 확인한다. Gate B의 `approval: approved`와 빈 `open_decisions`, Gate D의 blocker 없음이 개발 시작 조건이다.

## 승인 후 개발 계속하기

Gate D까지 통과하면 초기 산출물을 반복 구조로 전환한다.

```bash
node .plan2agent/scripts/p2a.mjs iteration init \
  --artifacts .plan2agent/artifacts/<project_id> \
  --iteration-id v1-mvp
```

이후 `p2a.mjs tasks ready`로 시작 가능한 task를 확인하고, `p2a.mjs execute plan/start/finish`로 감독형 개발을 진행한다. legacy handoff, run log, monitor gate, proposal 회고 같은 상세 흐름은 [감독형 개발 실행 레퍼런스](supervised-execution.md)를 본다.

## 어떤 파일을 봐야 하나

| 파일 | 언제 보는가 |
| --- | --- |
| `.plan2agent/artifacts/<project_id>/status.md` | 현재 Gate와 다음 행동을 빠르게 확인할 때 |
| `gate-b-spec/spec.json` | 승인된 제품·구현 요구사항을 확인할 때 |
| `gate-c-task-graph/task-graph.json` | 구현 가능한 task와 dependency를 확인할 때 |
| `gate-d-review/review.json` | Gate D blocker와 리뷰 결과를 확인할 때 |
| `iterations/<iteration-id>/` | 승인 후 반복 개발을 진행할 때 |

## 다음에 볼 문서

- [CLI 사용자 가이드](cli-reference.md) — scaffold 옵션, 명령별 사용법, legacy handoff와 proposal 흐름
- [하네스 사용자 가이드](harness-guide.md) — Gate A-D, 산출물 schema, 검증과 문제 해결
- [반복/고도화 개발 스펙](iteration-spec.md) — 반복 구조, close/open, 변경분 task 계약
- [감독형 개발 실행 레퍼런스](supervised-execution.md) — ready task 실행, monitor gate, milestone review, retry recovery
- [하네스 구현 기준](harness-spec.md) — P2A skill/subagent와 mirror를 수정할 때의 원칙
