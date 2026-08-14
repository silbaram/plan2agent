# `todo-lis` UI baseline 후보 판정

판정일: 2026-08-13
상태: 판정 기록 보존 · raw local workspace는 superseded 및 배포 제외

## 판정 대상

기존 `todo-lis` 프로젝트의 `personal-todo-list` Gate 산출물과 7개 run을 읽기 전용으로 평가했다. 원본 프로젝트와 기존 run은 변경하지 않았다.

| 산출물 | SHA-256 |
| --- | --- |
| `gate-b-spec/spec.json` | `285003c0e02745c40f08cf01fdd77d11f372489756d853e8a22f3de4ab186e24` |
| `gate-c-task-graph/task-graph.json` | `017740abf3d87ec1a63bb06943a704eb3f22e13125c1349ad63cb753a5ab2b57` |
| `runs/run-index.json` | `8377bdfaafc2b453227ed8c9a7ce0668dfdeb2c27f20f4501823a911a04b4563` |

## 재사용할 수 있는 것

- 7개 task와 7개 terminal run을 모두 읽을 수 있다.
- 7/7 run에 실제 `source: command` verification이 있으며 모두 통과했다.
- eval grade는 7건 중 4건 `pass`, 3건 `partial`이고 acceptance evidence coverage는 31/34다.
- 여러 UI 상태와 localStorage 동작을 가진 UI fixture의 요구사항·repository seed로 사용할 수 있다.

## 봉인을 막는 evidence

- Gate B `approval_audit.approved_at`과 current visual experience contract가 없다.
- review 정책이 `monitor: opt_in`, `milestone: off`, `visual: off`다.
- current interruption telemetry가 0/7이고 provider usage/model-profile evidence가 0/7이다.
- bound monitor/rule review가 0/7이다.
- canonical pre-close milestone review와 final visual review가 없다.
- eval grade 3건이 `partial`이다.
- Gate B 승인 시각이 없어 Gate B→close-ready elapsed time을 계산할 수 없다.

따라서 기존 성공 로그를 소급 보정하거나 수동 token 값을 넣어 봉인해서는 안 된다. 이 결과의 `first_pass_acceptance_rate=0`은 구현 실패율이 아니라 current monitor acceptance evidence가 전혀 없는 과거 run이라는 뜻이다.

## 2026-08-14 current-harness 재실행 결과

로컬 `eval/fixtures/todo-list-ui-a` workspace로 비교군 A의 기존 graph 방식을 유지한 새 iteration을 실행했다. 7개 task를 모두 완료하고 pre-close review, 14개 상태 × 3개 viewport의 final visual review, iteration close까지 통과했으며 `p2a eval generate`와 `p2a eval digest` 산출물도 생성했다. 이 raw workspace는 실패 후보이자 대용량 임시 실행 자료이므로 `.gitignore`에서 제외하고, 내구성 있는 판정은 이 문서와 [개선 제안서의 역사적 평가 기록](../../docs/gate-driven-adaptive-execution-proposal.md#13-평가-기록과-운영-계측)에 남긴다.

Baseline seal dry-run은 다음 증거 부족을 차단했다.

- provider usage: 전체 scoped run 9개 중 4개만 기록됨
- strict monitor 및 rule review: implementation run 8개 중 7개
- verification completeness: scoped run 9개 중 8개
- latest task grade: task-001, task-003, task-004의 최신 implementation run이 `pass`가 아님

과거 run의 provider token이나 monitor 판정을 추정해 소급 입력하면 baseline 비교 계약을 훼손한다. 따라서 이 실행은 sealed A baseline으로 사용하지 않았고, 최종 방향 판단은 별도 7-fixture 일회성 비교 결과를 사용했다. 평가 완료 뒤 전용 runner·fixture·schema·테스트와 baseline seal CLI를 저장소 및 제품 runtime에서 제거했다.
