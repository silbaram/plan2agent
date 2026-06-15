# Plan2Agent Docs

Plan2Agent 문서는 사용자 흐름, CLI 사용법, 산출물 계약, 구현 기준을 분리해서 관리한다. 처음 보는 사용자는 [Quickstart](quickstart.md)부터 읽고, 필요한 세부 계약만 아래 문서로 내려간다.

## 추천 읽기 순서

1. [Quickstart](quickstart.md)  
   전체 제품 흐름, Gate A-D, 반복 구조, handoff, run tracking을 한 번에 보는 시작 문서.

2. [CLI 사용자 가이드](cli-reference.md)  
   실제 명령과 옵션 예시. `p2a_iteration`, `p2a_tasks`, `p2a_runs`, `p2a_handoff`, 검증 명령을 실행할 때 본다.

3. [하네스 사용자 가이드](harness-guide.md)  
   Gate A-D 산출물, schema, approval audit, evidence, troubleshooting을 자세히 확인할 때 본다.

4. [반복/고도화 개발 스펙](iteration-spec.md)  
   `current-spec.json`, `iterations/`, close/open, semantic diff, maintenance, run log의 정식 동작 계약을 확인할 때 본다.

5. [하네스 구현 기준](harness-spec.md)  
   skill/subagent mirror, CLI-neutral agent contract, 구현 원칙을 수정할 때 본다.

## 목적별 바로가기

| 목적 | 문서 |
| --- | --- |
| 제품을 처음 이해하고 바로 써보기 | [Quickstart](quickstart.md) |
| 명령어를 찾아 실행하기 | [CLI 사용자 가이드](cli-reference.md) |
| Gate A-D 산출물 구조 이해하기 | [하네스 사용자 가이드](harness-guide.md) |
| 반복 구조와 변경분 task 흐름 이해하기 | [반복/고도화 개발 스펙](iteration-spec.md) |
| skill/subagent 구조를 수정하기 | [하네스 구현 기준](harness-spec.md) |
| 최신 제품 상태와 남은 로드맵 보기 | [제품 로드맵](../plans/01-product-roadmap.md) |

## 문서별 역할

| 파일 | 역할 | 정본으로 삼는 범위 |
| --- | --- | --- |
| `quickstart.md` | 사용자용 랜딩/퀵스타터 | 전체 제품 사용 흐름 |
| `cli-reference.md` | 명령 실행 레퍼런스 | CLI usage와 대표 옵션 |
| `harness-guide.md` | 산출물/게이트 사용자 가이드 | Gate A-D, schema, evidence, 검증 |
| `iteration-spec.md` | 반복 개발 구현 계약 | iteration layout, close/open, semantic diff, run tracking |
| `harness-spec.md` | 하네스 구현 기준 | skills, subagents, mirror, 안전 정책 |

## 유지보수 원칙

- 사용자에게 먼저 보여줄 내용은 `quickstart.md`에 둔다.
- 명령 예시는 `cli-reference.md`에 둔다.
- schema와 gate 의미는 `harness-guide.md`에 둔다.
- 반복 구조의 정확한 동작 계약은 `iteration-spec.md`에 둔다.
- skill/subagent 경로와 mirror 규칙은 `harness-spec.md`에 둔다.
- 현재 구현 상태와 다음 개발 후보는 `plans/01-product-roadmap.md`에 둔다.
