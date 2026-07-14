# Plan2Agent 제품 로드맵

작성일: 2026-07-01 · 상태: 제품 방향/로드맵 인덱스

이 문서는 Plan2Agent(P2A)의 제품 방향, 현재 완료 범위, 남은 개발 축을 짧게 고정하는 로드맵 인덱스다. 상세 구현 계약은 `docs/` 하위 문서가 정본이며, 완료된 개발 계획의 장문 기록은 이 문서에 누적하지 않는다.

## 1. 제품 정의

Plan2Agent는 한 문장 아이디어를 출발점으로 삼아, 대화형 기획 보강, 승인된 제품/구현 명세, task graph, 반복 개발 구조, 감독형 실행 기록으로 이어지는 파일 기반 planning harness다.

핵심 가치는 다음이다.

- 기획의 변경 사항을 agent가 실행 가능한 task로 변환한다.
- Gate A-D 승인과 evidence를 통해 중요한 결정을 추적한다.
- task 실행 결과, 검증, proposal, 후속 maintenance를 파일 기반으로 남긴다.
- 여러 CLI/agent 환경에서도 같은 산출물 계약을 사용한다.

## 2. 문서 정본

| 범위 | 정본 문서 |
| --- | --- |
| 사용자 시작 흐름 | `docs/quickstart.md` |
| CLI 사용법 | `docs/cli-reference.md` |
| Gate A-D 산출물과 승인 규칙 | `docs/harness-guide.md` |
| skill/subagent/mirror 구현 기준 | `docs/harness-spec.md` |
| 반복 개발, current-spec, diff task | `docs/iteration-spec.md` |
| 감독형 task 실행, orchestration, proposal loop | `docs/supervised-execution.md` |
| GUI/디자인 시스템 제거 결정 | 2026-07-14 확정: p2a-gui는 webhook-relay 도그푸딩 51개 run 전 구간에서 사용 0회였고, 실제 감독 표면은 메인 agent 대화 세션이며 진행 상태 질의도 대화가 더 정확했다. GUI는 스키마/CLI 계약의 두 번째 소비자로 유지보수 비용만 발생하므로 아카이브 없이 git 이력으로 보존하고 제거한다. 유일 소비자인 디자인 시스템 스킬과 Astryx 파일럿도 함께 보류/제거하며, 비대화형 provider 감독이나 병렬 run 관제가 실수요로 발생할 때 재검토한다. |
| 다음 하네스 고도화 아이디어 | `plans/04-p2a-harness-advancement.md` |

## 3. 현재 완료 범위

| 영역 | 현재 상태 |
| --- | --- |
| 기획 하네스 | 아이디어 -> intake -> spec -> task graph -> review Gate A-D 흐름 완료 |
| 산출물 검증 | schema validation, fixture regression, CLI mirror drift check 완료 |
| 반복 구조 | iteration init/current/validate/open/close/compose, active iteration, maintenance graph 완료 |
| baseline/diff | baseline-aware draft 일부, semantic diff task, rework/reuse 처리 완료 |
| handoff/scaffold | co-located scaffold, legacy handoff, AI 자산 설치 완료 |
| task/run tracking | task ready/start/done/block, run log, changedFiles, verification, branch/worktree hint 완료 |
| 감독형 실행 | `p2a_execute`, `p2a_orchestrate`, monitor gate, runtime sidecar, provider runner guide 완료 |
| proposal loop | proposal mine/review/curate/draft-patch/approve-draft, approval maintenance 연결 완료 |
| GUI | Electron 기반 프로젝트 로딩, task/run/artifact, PTY session, orchestration 표시 MVP 완료 |

## 4. 제품 원칙

- JSON artifact가 정본이고 Markdown은 generated view다.
- Gate A-D는 체크리스트가 아니라 사용자 승인 게이트다.
- 승인되지 않은 spec/task/proposal은 canonical 실행 대상으로 승격하지 않는다.
- 로컬 `.plan2agent/` 파일이 source of truth다.
- 외부 저장소나 서버는 보조 index, 검색, history 역할을 맡는다.
- 실제 agent 세션은 사용자가 foreground에서 감독한다.
- 자동 실행, push, merge, PR 생성, patch 적용은 명시 승인 없이는 하지 않는다.

## 5. 비목표

현재 기본 로드맵에서 제외하는 항목:

- provider SDK/API를 직접 호출하는 완전 자동 개발 실행기
- browser/background loop, 세션 쿠키/토큰 재사용, 계정 로테이션, rate limit 우회
- 여러 provider가 같은 파일을 동시에 수정하는 mixed-provider implementation
- 로컬 `.plan2agent` 정본을 서버 DB 정본으로 대체하는 구조
- approval 없는 proposal patch 자동 적용
- 캔버스 기반 자유 기획 입력

## 6. 남은 개발 축

| 우선순위 | 축 | 현재 상태 | 다음 목표 |
| --- | --- | --- | --- |
| P1 | 상위 명령면 | 기능별 `.mjs` 스크립트가 존재 | `p2a info/doctor/update/upgrade --dry-run` 형태의 진입 명령 정리 |
| P1 | Memory 연동 | Plan2Agent Memory 서버 MVP 별도 구현 완료 | `p2a memory status/push/search/history` 클라이언트 설계 |
| P2 | 평가 루프 | run/proposal 기록은 존재 | `p2a_eval grade/compare/analyze/digest`로 실행 품질과 regression 평가 |
| P2 | baseline-aware UX | draft와 diff task 기반 있음 | 기존 답변 재사용, 질문 재생성, 질문 재처분 UX 개선 |
| P2 | maintenance UX | graph 생성/검증/handoff 가능 | maintenance 전용 draft/승격/GUI 흐름 정리 |
| P3 | PR/리뷰 연동 | changedFiles와 verification 기록 가능 | PR 생성, 리뷰 상태 연동, 변경 요약 자동화 |
| P3 | code-aware intake | 파일 기반 diff와 run log 기반 | 코드베이스 분석 기반 spec 역생성과 결과 diff 병합 |
| P3 | 장기 관측성 | 파일 기반 run/proposal | Memory 기반 cross-session recall, failure trend, proposal 후보 큐 |

## 7. 가까운 실행 순서

1. `plans/04-p2a-harness-advancement.md`의 P1 범위에서 `info/doctor`와 Memory 상태 명령을 먼저 구체화한다.
2. GUI Overview가 `info/doctor` 결과를 읽도록 연결한다.
3. Memory 서버와 동기화하는 `status/push` 클라이언트 계약을 설계한다.
4. run/proposal 기록을 기반으로 `p2a_eval analyze/compare` 초안을 만든다.
5. 여러 프로젝트에 설치된 P2A 하네스를 관리하기 위해 `upgrade --dry-run`과 drift report를 정리한다.

## 8. 보존할 결정

- P2A는 우선 CLI/파일 기반 제품이다.
- GUI는 파일 기반 상태를 읽고 감독하는 workbench다.
- Memory 서버는 하네스를 실행하지 않고 artifact 저장, lineage, 검색만 담당한다.
- Codex/Claude/Gemini provider-native 기능은 사용자가 연 foreground 세션 내부에서만 활용한다.
- Gemini는 write-required role에 배정하지 않고 read-only planning/review/monitor 보조로 둔다.
- 닫힌 iteration은 append-only history로 보존하고, 변경은 다음 iteration 또는 maintenance task로 남긴다.

## 9. 문서 유지 원칙

- 현재 완료 상태와 남은 로드맵은 이 문서에 짧게 둔다.
- 구현 계약은 `docs/` 하위 문서로 이동한다.
- 완료된 개발 계획서는 `plans/`에 계속 쌓지 않는다.
- 새 고도화 아이디어는 별도 `plans/NN-*.md`로 작성하되, 구현 완료 후에는 필요한 운영 계약만 `docs/`로 옮긴다.
