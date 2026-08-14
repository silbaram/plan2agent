# Plan2Agent Docs

Plan2Agent 문서는 사용자 흐름, CLI 사용법, 산출물 계약, 구현 기준을 분리해서 관리한다. 처음 보는 사용자는 [Quickstart](quickstart.md)에서 첫 Gate 산출물을 만든 뒤, 필요한 세부 계약만 아래 문서로 내려간다.

## 한눈에 보기

| 원하는 일 | 사용하는 것 | 결과 |
| --- | --- | --- |
| 아이디어를 기획 산출물로 만들기 | P2A skills/subagents | `.plan2agent/artifacts/<project_id>/gate-*` |
| 짧은 아이디어 문서로 시작하기 | `p2a next --entry`, `p2a validate --entry` | Gate A 범위 확인 진입 |
| Gate ①과 범위 결정을 기록하기 | `p2a decide` | `decisions.jsonl` append와 `approval_audit` 호환 사본 |
| Gate ② constitution을 확인·승인하기 | `p2a shape`, `p2a shape approve|revoke` | constitution 상태와 Gate ② 결정 이력 |
| 결정 원장과 코드 근거 찾기 | `p2a decisions`, `p2a decisions --why` | 승인·철회·범위 변경 이력과 run 연결 |
| 산출물 검증하기 | `p2a validate`, `p2a iteration` | schema/gate 오류 조기 발견 |
| 다음 반복 열기 | `p2a iteration` | `iterations/<iter-id>/`와 `current-spec.json` |
| 변경분 task 만들기 | `diff-tasks`, `context`, `promote-tasks` | semantic 또는 agent-authored draft task graph |
| 대상 프로젝트로 넘기기 | `p2a handoff`, 이후 `p2a` | `.plan2agent/`와 실행 CLI 설치 |
| 현재 상태 보기 | `p2a info` | active artifact, task/run 요약 |
| 적응형 실행 준비·run lifecycle 진행 | `p2a execute` | Direct/Planned compatibility work item 또는 Orchestrated task 실행·검증 |
| 개발 task 실행 관리 | `p2a tasks` | ready/prompt/start/done 상태 전이 |
| agent 실행 결과 기록 | `p2a runs` | `runs/run-index.json`, `runs/<iterationId>/<runId>.json` |
| 실행 회고 개선 후보 만들기 | `p2a proposals` | `proposals/<proposalId>.json`와 review/curation/approval artifact |

## 추천 읽기 순서

1. [Quickstart](quickstart.md)  
   전역 `p2a init`부터 첫 Gate 산출물 확인까지의 최단 경로.

2. [CLI 사용자 가이드](cli-reference.md)  
   실제 명령과 옵션 예시. `p2a iteration`, `p2a tasks`, `p2a runs`, `p2a handoff`, 검증 명령을 실행할 때 본다.

3. [하네스 사용자 가이드](harness-guide.md)  
   Gate A-C 산출물, 결정 원장 권위, approval audit 호환 사본, evidence, troubleshooting을 자세히 확인할 때 본다.

4. [진입 계약](entry-contract.md)<br>
   사용자 또는 Feature Radar 아이디어 문서의 발견, 검증, 범위 확인 규칙을 확인할 때 본다.

5. [반복/고도화 개발 스펙](iteration-spec.md)<br>
   `current-spec.json`, `iterations/`, close/open, semantic diff, maintenance, run log의 정식 동작 계약을 확인할 때 본다.

6. [감독형 개발 실행 레퍼런스](supervised-execution.md)<br>
   ready task 실행, 리뷰 패스 정책, monitor gate, planned checkpoint, retry recovery, proposal loop의 완료 기능 계약을 확인할 때 본다.

7. [하네스 구현 기준](harness-spec.md)<br>
   skill/subagent mirror, CLI-neutral agent contract, 구현 원칙을 수정할 때 본다.

8. [릴리스 절차](releasing.md)<br>
   npm package, Git tag, GitHub Release를 같은 version과 source commit으로 게시할 때 본다.

9. [실사용 검증 체크리스트](dogfooding-checklist.md)<br>
   adaptive 실행 모드, 절차 비용, 승인 후 자율 완료율과 게이트 가치를 실제 프로젝트에서 측정할 때 본다.

10. [승인된 계약 기반 자율 개발 개선안](gate-driven-adaptive-execution-proposal.md)<br>
   사용자가 기획을 승인하고 하네스가 검증한 뒤, AI가 규칙 안에서 구현·검증을 자율 완수하도록 전환하는 제안이다.

## 목적별 바로가기

| 목적 | 문서 |
| --- | --- |
| 제품을 처음 이해하고 바로 써보기 | [Quickstart](quickstart.md) |
| 명령어를 찾아 실행하기 | [CLI 사용자 가이드](cli-reference.md) |
| Gate A-C 산출물 구조 이해하기 | [하네스 사용자 가이드](harness-guide.md) |
| 짧은 아이디어 문서나 Radar handoff로 시작하기 | [진입 계약](entry-contract.md) |
| 반복 구조와 변경분 task 흐름 이해하기 | [반복/고도화 개발 스펙](iteration-spec.md) |
| adaptive 실행과 run lifecycle 이해하기 | [감독형 개발 실행 레퍼런스](supervised-execution.md) |
| skill/subagent 구조를 수정하기 | [하네스 구현 기준](harness-spec.md) |
| 실제 프로젝트에서 절차 비용과 실행 자율성 측정하기 | [실사용 검증 체크리스트](dogfooding-checklist.md) |
| 기획 승인과 AI 자율 개발의 권한 경계 검토하기 | [승인된 계약 기반 자율 개발 개선안](gate-driven-adaptive-execution-proposal.md) |

## 문서별 역할

| 파일 | 역할 | 정본으로 삼는 범위 |
| --- | --- | --- |
| `quickstart.md` | 사용자용 퀵스타터 | 첫 성공까지의 최단 경로 |
| `cli-reference.md` | 명령 실행 레퍼런스 | CLI usage와 대표 옵션 |
| `harness-guide.md` | 산출물/게이트 사용자 가이드 | Gate A-C 요약, 결정 원장, schema, evidence, 검증 (`p2a-harness` skill의 게이트 규칙 정본 링크 포함) |
| `entry-contract.md` | 아이디어 문서 진입 계약 | entry 발견 우선순위, 검증, Radar 출처, 범위 확인 대화 |
| `iteration-spec.md` | 반복 개발 구현 계약 | iteration layout, close/open, semantic diff, run tracking |
| `supervised-execution.md` | 감독형 개발 실행 레퍼런스 | ready task 실행, 리뷰 패스 정책, monitor gate, planned checkpoint, retry recovery, proposal loop |
| `harness-spec.md` | 하네스 구현 기준 | skills, subagents, mirror, 안전 정책 (`p2a-harness` skill을 게이트 규칙 정본으로 지정) |
| `releasing.md` | 릴리스 운영 checklist | Node 지원 정책, CHANGELOG, npm publish, Git tag, GitHub Release, smoke test |
| `dogfooding-checklist.md` | 실사용 검증 체크리스트 | adaptive 모드 선택, 절차 비용, 사용자 개입, 게이트·검증 evidence의 실효성 측정 |
| `gate-driven-adaptive-execution-proposal.md` | 설계 제안 | 사용자 승인·하네스 검증·AI 자율 개발의 권한 경계, 선택형 task, UI 검증과 단계적 migration |

## 유지보수 원칙

- `quickstart.md`에는 첫 성공까지의 최소 경로만 둔다. 계약·옵션 설명은 넣지 않는다.
- 명령 예시는 `cli-reference.md`에 둔다.
- schema, 결정 원장, gate 산출물 설명은 `harness-guide.md`에 두고, Gate A-C 상세 규칙 정본은 `.agents/skills/p2a-harness/SKILL.md`에 둔다.
- 진입 문서의 발견·검증·Radar 출처·확인 대화 계약은 `entry-contract.md`에 둔다.
- 반복 구조의 정확한 동작 계약은 `iteration-spec.md`에 둔다.
- ready task 실행, orchestration, proposal loop와 `devExecution.reviewPasses` 정책의 완료 기능 계약은 `supervised-execution.md`에 둔다.
- skill/subagent 경로와 mirror 규칙은 `harness-spec.md`에 둔다.
- version 변경과 package 게시 절차는 `releasing.md`와 루트 `CHANGELOG.md`에 둔다.
- 실제 프로젝트의 adaptive 실행 계측 기준은 `dogfooding-checklist.md`에 둔다.
