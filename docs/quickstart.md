# Plan2Agent Quickstart

Plan2Agent는 한 문장 아이디어를 bounded discovery interview로 구체화하고, 사용자가 확인한 제품 이해를 승인 가능한 제품·구현 명세와 실행 가능한 task graph로 바꾸는 파일 기반 planning harness다.

이 문서는 새 프로젝트에서 첫 Gate 산출물을 만드는 최단 경로만 다룬다. 명령 옵션과 실행 계약은 [CLI 사용자 가이드](cli-reference.md), Gate와 산출물 계약은 [하네스 사용자 가이드](harness-guide.md)를 기준으로 삼는다.

문서 홈: [Plan2Agent Docs](README.md)

## 설치

Plan2Agent를 전역 설치한 뒤 새 프로젝트를 초기화한다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init \
  --tools all \
  --codex-profile quality
```

`--codex-profile quality`는 권장 Codex 설정을 설치한다. 부모 세션의 모델·reasoning 설정을 그대로 써야 하면 `inherit`을 선택한다. 초기화는 `.plan2agent/`의 상태·설정과 선택한 AI tool 자산만 만들며, 실행 코드와 schema는 전역 `p2a` 패키지에 남는다. `.plan2agent/`는 애플리케이션 소스 git에 커밋하지 않는다.

## 첫 산출물 만들기

작업을 시작하거나 마칠 때는 현재 상태에 맞는 한 가지 행동을 먼저 확인한다.

터미널에서는 다음 명령을 실행한다.

```bash
p2a next
```

Codex, Claude Code 또는 Gemini CLI agent 세션에서는 `/p2a-next`를 사용한다. 결과가 skill이면 같은 세션에서 이어서 진행하고, CLI 또는 승인 행동이면 이유를 확인한 뒤 사용자가 결정한다. `next`가 초기 기획 skill을 반환하면 한 문장 아이디어를 제공한다. 완성된 요구사항 문서를 먼저 만들 필요는 없다.

예를 들어 Codex에서는 다음처럼 시작한다.

```text
Use the $p2a-harness skill to plan a service that receives webhooks,
verifies signatures, and shows delivery history.
```

첫 응답은 산출물 생성 안내나 질문지가 아니라 기획 상담처럼 시작한다.

```text
사용자: 최소 기능의 Markdown 파일 뷰어를 만들고 싶어.
에이전트: 가장 단순하게 시작하려면 로컬 웹앱을 추천해요. 브라우저에서 표와
          코드 블록까지 안정적으로 확인하기 쉽거든요. 파일 하나만 열면 될까요,
          아니면 폴더 안 문서를 오가야 하나요?
사용자: 파일 하나면 돼. 기술은 뭘 쓰는데?
에이전트: 그 범위라면 Node.js와 가벼운 Markdown 렌더러로 충분해요. 별도
          데이터베이스도 필요 없습니다. 미리보기만 하면 될까요, 편집도 필요할까요?
```

에이전트는 사용자의 질문에 먼저 답하거나 추천과 근거를 제시한 뒤, 한 번에 1~3개의
중요한 질문을 자연스럽게 이어간다. 사용자는 옵션 번호를 고르지 않고 자유롭게 답하거나
되물을 수 있다. 내부적으로는 답변을 안정적인 `CQ-n`/`ND-n` ID에 병합하고
`intake.json`을 라운드마다 조용히 갱신하므로 세션이 끊겨도 재개할 수 있다. 인터뷰
중에는 JSON 저장 사실이나 구조화된 산출물을 대화 전면에 내세우지 않는다.

3라운드에서는 현재 이해와 남은 blocker를 요약하고 계속 인터뷰할지, 기존 blocker에
직접 답할지, 표시된 확인 필요 추천 가정을 명시적으로 수락할지, 일시 중지할지 묻는다.
5라운드 또는 무진전 2회에 도달하면 자동 질문을 중단한다. 인터뷰 중에는 `intake.md`를
자동 생성하지 않으며, 사용자가 Markdown 내보내기를 명시적으로 요청할 때만 만든다.
Gate A 이해 요약은 먼저 대화에서 제시한다.

질문과 blocker가 정리되면 에이전트가 “지금까지 정리하면 이렇습니다”라는 Gate A 이해
요약을 처음 제시한다. 사용자가 이를 명시적으로 확인하면 같은 agent 세션에서 Gate B
제품 명세와 구현 계획을 만든다.

Gate A 이해 확인과 Gate B 승인은 서로 다른 결정이다. Gate A 확인 전에는 Gate B를 만들지 않으며, Gate B를 승인하기 전에는 구현을 시작하지 않는다.

하네스는 Gate A intake, Gate B spec, Gate C task graph, Gate D review 산출물을 `.plan2agent/artifacts/<project_id>/`에 만든다.

## 결과 확인

각 행동을 마친 뒤 다시 `next`를 실행한다.

```bash
p2a next
```

출력의 state와 reason을 확인한다. Gate A는 `interview.state: gate_a_confirmed`, `status: ready_for_spec`, `approval_audit`이 모두 있어야 완료된다. Gate B의 `approval: approved`와 빈 `open_decisions`, Gate D의 blocker 없음이 개발 시작 조건이다.

인터뷰가 soft limit에서 멈추면 사용자가 계속 진행, 표시된 blocker에 직접 답변,
확인 필요 추천 가정의 명시적 수락, 일시 중지 중 가능한 행동을 고른다. `p2a next`는
이 결정을 건너뛰고 자동 재개하지 않는다. 재개해도 기존 질문 ID와 조용히 저장된 JSON
snapshot을 사용하며 새 질문지나 `intake.md`를 자동으로 만들지 않는다.

## 승인 후 개발 계속하기

Gate D까지 통과하면 `next`가 초기 산출물을 반복 구조로 전환하는 CLI 행동을 반환한다. 사용자가 실행을 승인한 뒤에도 `next`를 다시 실행해 ready task의 실행 계획, run 시작·종료, 다음 반복 close/open 행동을 순서대로 확인한다.

후속 iteration의 Gate A는 baseline에 저장된 관련 답변과 disposition을 재사용한다. 새 아이디어가 기존 결정과 달라지거나 충돌하는 영역만 다시 질문하고, 확인된 변경만 다음 Gate B에 반영한다.

legacy handoff, run log, monitor gate, proposal 회고 같은 상세 흐름은 [감독형 개발 실행 레퍼런스](supervised-execution.md)를 본다.

## 어떤 파일을 봐야 하나

| 파일 | 언제 보는가 |
| --- | --- |
| `.plan2agent/artifacts/<project_id>/status.md` | 현재 Gate와 다음 행동을 빠르게 확인할 때 |
| `gate-a-intake/intake.json` | 인터뷰 질문·답변, discovery 상태, Gate A 이해 확인 기록을 확인할 때. 활성 인터뷰 중에는 재개용으로 조용히 갱신된다. |
| `gate-b-spec/spec.json` | 승인된 제품·구현 요구사항을 확인할 때 |
| `gate-c-task-graph/task-graph.json` | 구현 가능한 task와 dependency를 확인할 때 |
| `gate-d-review/review.json` | Gate D blocker와 리뷰 결과를 확인할 때 |
| `iterations/<iteration-id>/` | 승인 후 반복 개발을 진행할 때 |

## 다음에 볼 문서

- [CLI 사용자 가이드](cli-reference.md) — `init` 옵션, 명령별 사용법, legacy handoff와 proposal 흐름
- [하네스 사용자 가이드](harness-guide.md) — Gate A-D, 산출물 schema, 검증과 문제 해결
- [반복/고도화 개발 스펙](iteration-spec.md) — 반복 구조, close/open, 변경분 task 계약
- [감독형 개발 실행 레퍼런스](supervised-execution.md) — ready task 실행, monitor gate, milestone review, retry recovery
- [하네스 구현 기준](harness-spec.md) — P2A skill/subagent와 mirror를 수정할 때의 원칙
