# Plan2Agent — Agent 저작 task 게이트 설계

작성 기준일: 2026-06-15 · 최종 갱신: 2026-06-15

상태: **부분 구현**. backbone(`context` / `validate --stage gate-c-draft` / `promote-tasks`), 저작 스킬(`p2a-task-author`), 정식 context 스키마(`p2a.task_context.v1`)가 구현됐고, 일부 후속(maintenance Phase 1, provenance sidecar)이 남았다.

이 문서는 agent가 task를 저작하고 사람이 게이트에서 확정하는 흐름의 구현 계약을 정의한다. 반복/고도화 개발의 정본 계약은 `docs/iteration-spec.md`이며, 이 문서는 그 위에 붙는 "Agent 저작 task 게이트" 기능의 설계 정본이다. `diff-tasks`의 field 단위 기계적 초안을 의미 기반 agent 저작으로 끌어올리되, Plan2Agent의 추적성과 승인 게이트를 보존하는 것이 목표다.

## 0. 구현 현황

| 조각 | 명령/파일 | 상태 |
| --- | --- | --- |
| 컨텍스트 번들 | `p2a_iteration.mjs context` | ✅ 구현 |
| 초안 검증 | `p2a_iteration.mjs validate --stage gate-c-draft` | ✅ 구현 |
| 승인 게이트 | `p2a_iteration.mjs promote-tasks` + `status.md` Gate C approval audit | ✅ 구현 |
| 저작 스킬 | `.agents/skills/p2a-task-author/SKILL.md` (+ `.claude` mirror, Gemini shim) | ✅ 구현 |
| 회귀 테스트 | `run_fixtures`(context/gate-c-draft/promote) + `check_cli_parity`(skill mirror) | ✅ |
| provenance sidecar | `task-graph.draft.meta.json` | ⛔ 남음 (선택) |
| 정식 context 스키마 | `schemas/task-context.schema.json` + `validateTaskContextData` (context가 출력 전 자기검증) | ✅ 구현 |
| `context --scope maintenance` | — | ⛔ 남음 (현재 `feature`만) |
| Phase 1 (maintenance 파일럿 + fix/기능 분류) | `maintenance add --from-draft` | ⛔ 남음 (우선순위 낮음) |
| `validate`-time audit 강제(승격된 정본) | — | △ 미구현 (선택) |

남은 핵심은 없다. backbone + 저작 스킬로 "AI가 초안 저작 -> 사람 게이트 확정 -> 정본 승격"이 끝에서 끝까지 동작한다. 남은 항목은 선택적 마감(provenance/스키마/maintenance 파일럿)이다.

## 1. 목적과 위치

- 문제: `docs/iteration-spec.md`의 `diff-tasks`는 spec field 차이를 그대로 task로 펼치는 기계적 초안이라 task 병합/분할, 기존 task 재사용 판단을 하지 못한다.
- 해법: 기획층(Gate C)에 **agent 저작 + 사람 승인 게이트**를 추가한다. agent는 현재 기준 맥락을 읽어 task 초안을 쓰고, 사람이 게이트에서 승격을 확정한다.
- 불변: 실행층(`p2a_tasks`)과 `schemas/task-graph.schema.json`은 바꾸지 않는다. agent 출력도 기존 `p2a.task_graph.v1`을 따른다.
- 로드맵 연결: `plans/01-product-roadmap.md` §13의 "task graph 확정 시 사용자 승인"을 명시적 게이트로 구체화하고, §14의 "기획 변경 diff 기반 재작업 task 생성" 구현 계약을 제공한다.

## 2. 핵심 원칙

| 원칙 | 계약 |
| --- | --- |
| 초안 분리 | agent 출력은 `task-graph.draft.json`에만 쓴다. 정본 `task-graph.json`은 직접 쓰지 않는다. `p2a_tasks`는 정본만 읽으므로 미승인 task가 실행 대상(`ready`/`start`)에 노출되지 않는다. |
| 게이트 승인 | 초안 -> 정본 승격은 사람의 명시 승인과 `status.md` Gate C approval audit block으로만 일어난다. 자동 승격은 없다. |
| 추적성 강제 | 승격 전 `validateTaskGraphData`가 schema·중복 id·dependency·cycle을 검사하고, `sourceSpecRefs` 최소 1 제약으로 agent 출력에도 spec 추적을 강제한다. |

## 3. 산출물 계약

| 산출물 | 역할 |
| --- | --- |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json` | agent 저작 초안. 기존 `p2a.task_graph.v1` schema를 그대로 따른다. `version`은 `"<iter-id>-draft"` 같은 초안 표식을 권장한다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.json` | 승인 후 승격된 정본. 실행/handoff 대상은 이 파일뿐이다. |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.json.promoted` | 승격 후 history로 보존되는 직전 초안. (`promote-tasks`가 rename으로 남긴다.) |
| `iterations/<iter-id>/gate-c-task-graph/task-graph.draft.meta.json` (선택, 미구현) | provenance sidecar. authoring agent, context bundle hash, source idea, base task-graph hash를 기록한다. schema를 건드리지 않으려고 provenance는 정본 밖에 둔다. |
| `status.md`의 Gate C approval audit block | 승인 사실과 근거. §6 형식을 따른다. |

## 4. 컨텍스트 번들 계약

`p2a_iteration.mjs context`는 agent가 task를 저작하는 데 필요한 현재 기준 맥락을 읽기 전용 JSON으로 모은다.

```bash
node scripts/p2a_iteration.mjs context \
  --artifacts artifacts/<project_id> \
  [--idea "<change idea>"]
```

출력 형식:

```json
{
  "schema_version": "p2a.task_context.v1",
  "project_id": "example-project",
  "active_iteration": "iter-002",
  "scope": "feature",
  "idea": "변경 아이디어 또는 버그 설명",
  "baseline_effective_spec_ref": "current-spec.json",
  "effective_spec": { "product": {}, "implementation": {} },
  "existing_tasks": {
    "active": [
      { "id": "task-001", "title": "...", "status": "done", "targetArea": "...", "sourceSpecRefs": ["implementation.architecture"] }
    ],
    "maintenance": []
  },
  "spec_field_changes": [
    { "section": "implementation", "field": "architecture", "specRef": "implementation.architecture" }
  ]
}
```

- `effective_spec`은 `current-spec.json`의 effective view(또는 thin pointer가 가리키는 active spec)에서 읽는다.
- `existing_tasks`는 중복 저작과 재사용 판단을 돕기 위해 active 반복과 maintenance graph의 task 요약을 함께 제공한다.
- `spec_field_changes`는 baseline이 있으면 `diff-tasks`와 같은 field 비교 결과를 재사용한다.
- `context`는 어떤 파일도 쓰지 않는다.
- 현재 `scope`는 `feature` 고정이다. `--scope maintenance`는 후속(§0 구현 현황).
- 출력은 `schemas/task-context.schema.json`(`p2a.task_context.v1`)을 따르며, `context` 명령이 출력 전 `validateTaskContextData`로 자기검증해 무효 context를 내보내지 않는다.

## 5. 명령 계약

| 명령 | 입력 | 동작 | 실패 조건 |
| --- | --- | --- | --- |
| `context` | iterative root, 선택적 idea | §4 번들을 stdout으로 출력 | iterative root 해석 실패 |
| `validate --stage gate-c-draft` | iterative root | active 반복의 `task-graph.draft.json`을 schema/dependency/cycle로 검증(승인 불요) | draft 없음, schema/dependency/cycle 위반 |
| `promote-tasks` | iterative root | active 반복의 `task-graph.draft.json`을 검증(approved spec 포함)하고 Gate C approval audit을 확인한 뒤 `task-graph.json`으로 승격 | draft 없음, draft 검증 실패, audit block 없음 |
| `maintenance add --from-draft <file>` (미구현) | maintenance 초안 파일 | 초안 task들을 검증 후 maintenance graph에 append (§8 Phase 1) | 초안 검증 실패, 사람 confirm 취소 |

`promote-tasks`는 baseline-aware 안전 조건(기존 정본의 `done` task id 보존 등)을 후속에서 강화한다. v1 계약은 schema/추적성/audit 확인까지다. 승격 시 `version`의 `-draft` 접미사를 제거하고, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

## 6. Gate C 승인 게이트

승인 사실은 `status.md`에 Gate B approval audit과 같은 패턴으로 남긴다.

```md
#### Gate C approval audit

- Approved by: user
- Approved at: YYYY-MM-DD
- Approved source: gate-c-task-graph/task-graph.draft.json (agent-authored)
- Authoring agent: <codex|claude|gemini> / p2a-task-author
- Approval note: <검토 근거 — 무엇을 보고 승격을 승인했는지>
```

`promote-tasks` 동작:

1. active 반복의 `task-graph.draft.json`을 읽고 `validateTaskGraphData(draft, specPath)`로 재검증한다(approved spec + open_decisions 비어있음 + schema/dependency/cycle).
2. (후속) baseline 정본이 있으면 초안이 기존 `done` task를 보존하며 안전하게 대체/확장하는지 확인한다.
3. `status.md`에 Gate C approval audit block이 있는지 확인한다. 없으면 승격을 거부한다.
4. 초안을 `task-graph.json`으로 승격하고, 직전 초안은 `task-graph.draft.json.promoted`로 보존한다.

`validate` 확장:

- 아직 승격되지 않은 초안은 `--stage gate-c-draft`로 schema/dependency/cycle만 검증하고 승인은 요구하지 않는다.
- (후속, 미구현) 승인된 agent-저작 정본을 식별해 `validate`-time에도 audit block을 요구하는 강제는 marker가 필요해 후속으로 둔다. 현재 감사 강제는 `promote-tasks` 시점에서만 일어난다.

## 7. 저작 스킬 `p2a-task-author`

- 입력: §4 context 번들. 출력: `task-graph.draft.json`.
- 책임: 변경 의미를 읽어 task를 병합/분할하고, `existing_tasks`와 중복을 피하며, 각 task의 `sourceSpecRefs`를 effective spec 항목으로 채운다.
- 제약: read-only planning 원칙을 지켜 코드·의존성 변경이나 정본 직접 쓰기를 하지 않는다. 초안만 쓴다.
- mirror: 기존 skill mirror 규약(`.agents/skills` -> `.claude`/`.gemini`, command shim)을 따르고 `check_cli_parity`로 검증한다. 기존 `p2a-task-breakdown`의 sibling이다.
- **구현됨**: `.agents/skills/p2a-task-author/SKILL.md` (canonical) + `.claude/skills/p2a-task-author/SKILL.md` mirror + `.gemini/commands/p2a/task-author.toml` shim. mirror/shim은 `sync_cli_assets.mjs`가 생성하고 `check_cli_parity.mjs`가 검증한다. 스킬은 context를 읽어 초안만 저작하고, 검증·audit·`promote-tasks` 절차를 사람 게이트로 인계한다.

## 8. 단계별 도입

| 단계 | 범위 | 게이트 | 상태 |
| --- | --- | --- | --- |
| Phase 1 (파일럿) | maintenance 레인 | 사람 confirm + `maintenance add`의 validate-before-write | ⛔ 미구현 (우선순위 낮음) |
| Phase 2 | feature task graph | Gate C approval audit + `promote-tasks` | ✅ backbone + 저작 스킬 구현 |

Phase 1 흐름: `context --scope maintenance` -> agent가 maintenance task 초안 작성 -> 사람 확인 -> `maintenance add --from-draft`로 검증 후 append. ungated maintenance 특성상 별도 정본/초안 분리 없이 append 직전 사람 confirm을 게이트로 둔다. 단, maintenance는 본질적으로 코드-side 활동이라 planning-side 저작의 실익이 작아 우선순위를 낮춘다(이관된 fix/기능 경계 분류 포함).

Phase 2 흐름: `context` -> `p2a-task-author`가 `task-graph.draft.json` 저작 -> 사람 검토 + Gate C approval audit 기록 -> `promote-tasks`로 정본 승격 -> Gate D review -> `p2a_tasks` 실행. `diff-tasks`는 기계적 fallback으로 남기되, 후속에서 정본 대신 `task-graph.draft.json`으로 쓰도록 라우팅해 두 경로를 같은 게이트로 모은다.

## 9. 가드레일

- 자동 승격 금지: 승격은 항상 Gate C approval audit이 선행한다.
- 추적성 완화 금지: `sourceSpecRefs` 최소 1 제약을 agent 출력에도 적용한다.
- 실행층 불변: 저작/승격 로직을 `p2a_tasks` 상태 전이 명령에 넣지 않는다.
- 초안 격리: `task-graph.draft.json`은 승격 전까지 `p2a_tasks`/`p2a_handoff` 대상이 아니다.
- 비목표 경계 유지: `docs/iteration-spec.md`의 "비목표와 후속 고도화"가 정의한 "구조적 diff 기반 재작업 task 자동 생성", "task 자동 연결"은 여전히 비목표다. 본 설계는 사람 게이트를 거치는 agent 초안이며, 자동 생성이나 자동 병합이 아니다.

## 10. 검증/회귀 계획

- `run_fixtures.mjs` 추가 케이스: `context` 출력 형식, `--stage gate-c-draft` 초안 검증(양성/cycle 음성), audit 없을 때 `promote-tasks` 거부, audit 있을 때 승격 + 정본 검증. (구현됨.)
- `check_cli_parity.mjs`: `p2a-task-author` skill mirror와 command shim drift 검증. (구현됨.)
- 기존 회귀(`run_fixtures`, `check_cli_parity`)는 그대로 통과해야 한다.

## 11. 정본 문서 반영 가이드

이 설계가 구현되면서 다음 정본 문서를 함께 갱신한다.

- `docs/iteration-spec.md` §0-2/§0-3 상태표: "agent 저작 task 게이트" 항목 상태 갱신.
- `docs/iteration-spec.md` "구현 조각 순서" 표: context / draft+promote-tasks / `p2a-task-author` 스킬 / maintenance `--from-draft` 조각을 반영.
- `plans/01-product-roadmap.md` §8-2 구현 상태와 §14 백로그: agent 저작 task 게이트 진행 상태 반영.
- `docs/iteration-spec.md`에 이 문서로 향하는 한 줄 포인터를 둔다.
