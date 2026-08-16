# P2A 런타임 컨텍스트 라우팅 보완 계획

> 상태: **완료**
>
> 완료 범위: CR-001~007 Codex 구현·검증 및 최종 runtime packet A/B 완료
>
> 최종 검증: `734ca2a` / Codex A/B 30/30 / candidate trace 15/15 / performance gate 12/12
>
> 아키텍처 리뷰 보완(2026-08-16): repository suite 429/429(로컬 listen 1건은 sandbox 밖에서 재검증), Direct/Planned 모드 경계·packet 전용 trace·누락 metric fail-closed·action/run binding을 보강했다.
>
> Coverage 참고: Claude·Gemini는 실행하지 않아 cross-provider 판정만 `provider_limited`이며, 본 계획의 Codex 범위 완료를 막지 않는다.
>
> 작성일: 2026-08-15
>
> 기준선: `main@e7c5adb38312a562f3840588de561b42c64407ae`
>
> 선행 작업: [컨텍스트 엔지니어링 개선 계획](./context-engineering-improvement-plan.md), [CE-009 Codex A/B](./evidence/context-engineering/CE-009/codex/README.md)

## 0. 구현 현황 (2026-08-16)

- CR-001/002: sanitized tool trajectory와 분리 평가 기반을 구현하고, 제품 변경 전 Direct/Gate B/Planned 각 5회 계측 기준선을 `CE-010-runtime-routing-baseline`에 보존했다.
- CR-003: structured next continuation과 `p2a.execution_result.v1`을 구현했다. 별도 승인된 Codex 중간 평가는 재채점 기준 15/15를 통과했고, 총 input 8.75% 및 elapsed 8.6% 감소, Planned median input 2.45% 증가로 중간 gate를 통과했다.
- CR-004/005: 공통 phase resolver, action/run binding, `p2a.context_packet.v1`, `p2a context show`, confinement와 deterministic boundary를 구현했다.
- CR-006: Direct/Planned packet entry와 provider asset 동기화를 반영했다. Orchestrated/batch는 계획대로 기존 reference routing을 유지한다.
- CR-007: 기존 model-routed reference와 host-supplied packet을 byte-identical 현재 source에서 비교하는 최종 30-run feature-toggle Codex A/B를 완료했다. 30/30 behavioral grade와 12/12 performance gate가 통과했고 최종 verdict는 `provider_limited`다.
- 결정적 검증: repository suite 429/429(로컬 listen 1건은 sandbox 밖에서 재검증), package/fixture 검증, CLI asset sync/parity, strict context doctor, `git diff --check`가 통과했다.
- 아키텍처 리뷰 후 continuation 정의를 공통 registry로 통합하고, Orchestrated/batch에는 packet continuation을 발급하지 않으며 기존 reference routing을 유지한다.
- Trace는 명령 문자열의 단순 경로 출현이 아니라 읽기 대상·검색 scope를 구분하고, packet-managed source와 일반 workspace source를 별도 집계한다. 측정 누락과 의미 없는 음수 uncached token은 0으로 대체하지 않는다.

Repository 구현과 우선 Codex 검증은 완료됐다. 최종 동시 실행 matrix의 baseline 대비 candidate는 총 input 32.37%, elapsed 18.39%, uncached input 12.35%, tool operation 42.86%가 감소했다. Candidate trace는 15/15가 완전 수집됐고 미식별 read, packet-managed 반복 source read, unknown operation은 모두 0건이다. Claude/Gemini 호출은 승인·실행되지 않았으므로 cross-provider `go`로 승격하지 않는다.

## 1. 결론

CE-001~008은 상위 skill과 always-loaded context를 크게 줄였고 Codex aggregate A/B에서 baseline/candidate 모두 18/18 hard gate를 통과했다. 그러나 candidate는 uncached input을 4.45% 줄인 반면 총 input 8.54%, output 14.50%, elapsed 11.59%, tool call 28.57%가 증가했다. Direct 시나리오에서는 총 input 66%, elapsed 37%, tool call 5회가 증가했다.

현재 증거만으로 증가 원인을 특정 reference 파일에 귀속할 수는 없다. A/B runner는 tool call 수만 보존하고 어떤 파일을 어떤 순서로 읽었는지 폐기하며, Direct synthetic case는 `p2a-next`와 `p2a-dev-execution`을 한 prompt의 primary skill로 함께 읽도록 강제한다. 따라서 제품을 바로 조정하면 실제 production 병목이 아니라 benchmark 구성에 맞춘 최적화가 될 수 있다.

보완 순서는 다음과 같이 고정한다.

1. Codex event의 안전한 계측 가능성을 preflight한 뒤 민감 본문을 저장하지 않는 tool trajectory를 추가한다.
2. 제품 변경 전 같은 model/fixture로 계측된 현재 candidate 기준선을 새로 만든다.
3. routing, context 선택, 최종 판단, production lifecycle 평가를 분리한다.
4. `p2a next`의 skill 전환과 continuation 활성화·run binding을 문자열이 아닌 구조화 계약으로 만든다.
5. 자연어 reference 조건에 작은 runtime phase enum을 추가한다.
6. 현재 action 또는 명시된 started run을 재검증하고 필요한 canonical reference 본문을 한 번에 반환하는 context packet 명령을 제공한다.
7. 품질 hard gate와 사전 선언한 수치 성능 gate를 모두 만족하는지 단계별 A/B로 확인한다.

초기 제품 rollout 범위는 회귀 신호가 실제로 관찰된 `p2a-dev-execution`의 Direct/Planned 흐름이다. 공통 resolver는 다른 skill도 수용할 수 있게 만들되, 다른 skill의 packet route는 별도 증거가 생긴 뒤 추가한다.

## 2. 근거와 현재 구조의 결손

### 2.1 확인된 성능 신호

| 지표 | Baseline | Candidate | 변화 |
| --- | ---: | ---: | ---: |
| Hard-gate 통과 | 18/18 | 18/18 | 동일 |
| 총 input token | 751,804 | 816,024 | +8.54% |
| uncached input token | 294,332 | 281,240 | -4.45% |
| output token | 16,370 | 18,744 | +14.50% |
| elapsed | 419,834 ms | 468,486 ms | +11.59% |
| tool call | 28 | 36 | +28.57% |

이 결과는 새로운 정보의 양보다 정보를 읽는 왕복 횟수가 누적 input을 키웠을 가능성을 보여 준다. 다만 현재 metadata에는 command별 allowlisted path가 없으므로 이는 검증할 가설이지 확정 원인이 아니다.

### 2.2 A/B 계약의 결합 문제

현재 runner는 모델에 모든 `primary_skills`를 완전히 읽도록 지시한다. Direct case는 다음 두 skill을 동시에 primary로 지정한다.

- `.agents/skills/p2a-next/SKILL.md`
- `.agents/skills/p2a-dev-execution/SKILL.md`

실제 사용 흐름은 `p2a next`가 action을 결정한 뒤 continuation skill로 넘어가는 순차 상태 전이다. Routing 판단과 execution 판단을 한 synthetic prompt에 합치면 skill 분리 전후의 round-trip 특성을 정확히 비교하기 어렵다.

### 2.3 Tool trajectory 부재

현재 runner가 보존하는 실행 정보는 다음 수준이다.

- 전체 event type별 count
- 전체 token usage
- `command_execution` count
- non-zero exit count
- stdout/stderr SHA-256

다음 정보가 없어 병목을 국소화할 수 없다.

- canonical skill과 reference별 read count
- command 순서
- 실패한 command의 안전한 분류
- 같은 reference의 반복 read 여부
- primary skill read와 conditional reference read의 구분

기존 CE-009 36개 run에는 command trajectory 원본이 없으므로 이 정보를 사후 복원할 수 없다. 기존 evidence는 역사적 비교 자료로만 유지하며 신규 trace 필드를 backfill하거나 기존 결과와 혼합 비교하지 않는다.

### 2.4 `p2a.next.v2`의 문자열 skill 전환

`p2a.next.v2`의 CLI command는 `argv`를 제공하지만 `kind: skill`과 `kind: approval`은 `display` 문자열만 제공한다. Agent는 다음 정보를 다시 해석해야 한다.

- 실행할 skill id
- skill argument
- 다음 lifecycle phase
- 현재 phase에서 필요한 context route
- 다음 action에서 승인 여부를 다시 판단하지 않아도 되는 범위

`reasonCode`도 현재 `state`와 같은 값이므로 continuation interface를 대신하지 못한다.

### 2.5 진단용 context 조립과 runtime 상태의 단절

`.agents/context-routes.json`은 provider, skill, stage, mode, reference path와 자연어 condition을 선언한다. `p2a doctor --context`의 assembled mode는 호출자가 `--condition <conditionId>`를 정확히 지정해야 해당 reference를 포함한다.

이 구조는 정적 audit에는 적합하지만 runtime에서 다음 상태를 자동으로 연결하지 않는다.

- Gate C가 없고 mode preparation이 필요한 상태
- writer start/resume 직전
- retry evidence 확인 단계
- verification/checkpoint 및 close-ready 판단 단계
- visual/acceptance/monitor 전용 review 단계

현재 run status enum은 `started`, `finished`, `failed`, `blocked`뿐이고 `p2a next`도 열린 run을 `run_started`로만 본다. 따라서 `context show`가 구현 완료나 verify-ready 시점을 상태에서 자동 추론하는 설계는 현재 artifact 계약으로 구현할 수 없다.

## 3. 목표

### 3.1 제품 목표

- Gate, 승인, scope, authority와 evidence 계약을 유지한다.
- 최신 모델이 구현 세부를 판단할 여지는 유지한다.
- 상태 전이와 context route 선택은 구조화된 인터페이스로 제공한다.
- 필요한 canonical reference를 현재 phase에서 한 번에 읽을 수 있게 한다.
- provider wrapper에 canonical routing 규칙을 다시 복제하지 않는다.
- 기존 `p2a.next.v1` consumer를 깨뜨리지 않는다.

### 3.2 성능 목표

- 제품 변경 전 현재 candidate에 trace만 추가한 계측 기준선을 동일 model/fixture로 시나리오별 최소 5회 생성한다.
- Candidate의 모든 repetition이 품질 hard gate를 개별 통과한다.
- 최종 candidate의 Direct median `toolOperations`는 계측 기준선보다 최소 1회 감소하고 median 총 input은 기준선의 90% 이하다.
- 같은 repetition matrix의 전체 총 input과 elapsed는 계측 기준선을 넘지 않는다.
- Uncached input은 기준선의 105%를 넘지 않는다.
- 명시적 품질 근거와 승인된 예외 없이 어떤 시나리오도 median 총 input이 기준선의 110%를 넘지 않는다.
- Packet이 관리하는 source의 반복 read와 reference read 실패를 0건으로 만든다.

### 3.3 비목표

- 상위 `SKILL.md`에 분리한 세부 절차를 다시 합치지 않는다.
- context 선택을 위한 범용 규칙 언어나 Boolean DSL을 만들지 않는다.
- vector database, embedding retrieval 또는 새로운 Memory 계층을 추가하지 않는다.
- Programmatic Tool Calling이나 multi-agent를 작은 reference read의 기본 경로로 도입하지 않는다.
- 모델의 Direct/Planned/Orchestrated 판단을 고정 휴리스틱으로 대체하지 않는다.
- 사용자 문서, provider transcript, credential 또는 raw command output을 평가 증거에 복사하지 않는다.
- 새로운 사람 승인 Gate를 만들지 않는다.

## 4. 설계 결정

### D1. 계측을 제품 최적화보다 먼저 구현한다

현재 원인 귀속이 불가능하므로 첫 변경은 평가 runner에만 적용한다. 먼저 Codex JSONL의 `command_execution` event가 필요한 안전 필드를 실제로 제공하는지 작은 preflight로 확인한다. 필드가 부족하면 추측하거나 raw command를 보존하지 않고 계측 설계를 조정한다. 계측 결과 없이 reference 병합, skill 재확장 또는 runtime resolver를 먼저 넣지 않는다.

### D2. `p2a.next.v1`은 그대로 유지하고 현재 draft v2를 보강한다

`.agents/context-routes.json`, `schemas/context-routes.schema.json`, `schemas/next-v2.schema.json`은 기준선 `HEAD`에 존재하지 않는 미출시 draft다. 따라서 이번 release 전에는 `context-routes.v1`과 `p2a.next.v2`를 같은 draft version 안에서 보강할 수 있다. 이 계약이 외부에 공개된 뒤 같은 변경을 해야 한다면 기존 version을 바꾸지 않고 다음 schema/contract version으로 분리한다.

### D3. Runtime routing에는 작은 phase enum을 사용한다

Reference의 자연어 `condition`은 사람이 읽는 설명으로 유지한다. Runtime 선택은 다음 안정 enum과 기존 mode/provider 제한을 사용한다.

- `prepare`
- `owner-start`
- `retry`
- `verify-closeout`
- `batch`
- `visual-review`
- `acceptance-review`
- `monitor`

`verify-closeout`은 일반 구현 run의 검증·close-ready 판단에만 사용한다. Visual, acceptance, monitor는 각 전용 phase로만 선택하며 generic closeout에서 세 reference를 한꺼번에 fan-in하지 않는다. CLI가 구현 결과의 준비 시점을 추론하도록 새 run status를 만들지 않고, read-only phase를 요청할 시점은 current confined owner의 판단으로 둔다.

### D4. Context packet은 path 목록이 아니라 본문까지 한 호출에서 제공한다

Resolver가 path 목록만 반환하면 모델이 각 파일을 다시 읽어 tool call이 늘어난다. Model-facing 기본 출력은 선택된 canonical reference의 본문을 안정된 순서로 연결하고, source path와 SHA-256 경계를 함께 표시한다.

### D5. Packet은 activation 종류에 따라 action 또는 run에 결합한다

Continuation은 `immediate`, `after_command_success`, `run_declared` 세 activation을 가진다.

- `immediate`: preparation skill처럼 현재 `p2a next` action에서 바로 이어진다. Packet 생성 시 현재 next state를 다시 계산해 `sourceState`와 같아야 한다.
- `after_command_success`: `start`, `resume`, `review`, `accept` 같은 lifecycle command가 성공한 뒤 이어진다. Human display를 파싱하지 않고 성공한 machine-readable result의 `runId`에 결합한다.
- `run_declared`: current confined owner가 started run의 `verify-closeout`, `visual-review`, `acceptance-review`, `monitor` 같은 read-only phase를 명시적으로 요청한다. Run status와 Gate/task/run 계약은 검증하지만 CLI가 구현 outcome의 준비 여부까지 추론하지 않는다.

이 구분은 routing을 자동화하되 구현 완료·검증 시작 시점에 대한 모델의 판단은 유지한다. 새 run status는 추가하지 않는다.

### D6. Audit와 runtime resolver는 같은 선택 코드를 사용한다

`p2a doctor --context`, provider parity와 `p2a context show`가 route schema를 따로 해석하지 않도록 공통 resolver module을 만든다.

### D7. Context packet은 명시적 schema를 가진다

Metadata-only JSON은 `p2a.context_packet.v1` schema로 검증한다. `generatedAt`은 진단 metadata에만 두고, model-facing source boundary는 불변 metadata에서 결정적으로 생성해 provider wrapper가 자체 형식을 만들지 않게 한다.

### D8. 외부 provider 평가는 별도 권한과 coverage를 요구한다

새 외부 모델 호출은 provider, model, profile, 예상 비용 범위에 대한 명시적 승인을 받은 뒤에만 실행한다. Provider가 사용 불가하거나 승인되지 않은 상태는 성공으로 건너뛰지 않고 coverage blocker로 기록한다.

## 5. 제안 인터페이스

### 5.1 Structured next action

Skill action은 표시 문자열 외에 실행 대상과 activation을 기계 필드로 제공한다.

```json
{
  "schema_version": "p2a.next.v2",
  "state": "gate_b_approved_needs_execution_prepare",
  "reasonCode": "gate_b_approved_needs_execution_prepare",
  "reason": "The approved Gate B specification is ready for adaptive execution-mode preparation.",
  "command": {
    "kind": "skill",
    "skill": "p2a-dev-execution",
    "args": [
      "--artifacts",
      ".plan2agent/artifacts/example",
      "--prepare-mode",
      "adaptive"
    ],
    "display": "/p2a-dev-execution --artifacts ... --prepare-mode adaptive"
  },
  "continuation": {
    "id": "execution.prepare",
    "activation": "immediate",
    "sourceState": "gate_b_approved_needs_execution_prepare",
    "skill": "p2a-dev-execution",
    "phase": "prepare",
    "mode": null
  }
}
```

Lifecycle command 뒤에 실행되는 continuation은 command 성공 결과에 결합한다.

```json
{
  "schema_version": "p2a.next.v2",
  "state": "ready_task_available",
  "command": {
    "kind": "cli",
    "argv": ["p2a", "execute", "start", "--artifacts", ".plan2agent/artifacts/example", "--json"],
    "requiresApproval": false
  },
  "continuation": {
    "id": "execution.owner-start",
    "activation": "after_command_success",
    "sourceState": "ready_task_available",
    "skill": "p2a-dev-execution",
    "phase": "owner-start",
    "mode": null,
    "binding": {
      "kind": "command_result",
      "schema_version": "p2a.execution_result.v1",
      "field": "runId"
    }
  }
}
```

Continuation을 제공하는 `start`, `resume`, `review`, `accept` command의 `--json` 성공 결과는 최소한 `schema_version`, `command`, `outcome`, `taskId`, `runId`, `runStatus`를 제공하는 `p2a.execution_result.v1`을 따른다. `outcome`이 `succeeded`이고 `runStatus`가 `started`일 때만 continuation을 활성화한다. 실패 결과, closed run 또는 non-zero exit에서는 활성화하지 않는다. Human display에서 run id를 추출하는 경로는 허용하지 않는다.

호환 원칙:

- `p2a.next.v1`의 schema와 field set은 변경하지 않는다.
- `generatedAt`과 환경별 absolute `target` path를 정상화한 뒤 v1 semantic payload가 기존 fixture와 같은지 비교한다.
- v2의 `display`는 사람용으로 유지하되 agent는 `skill`과 `args`를 사용한다.
- 모든 v2 payload는 `continuation`을 `null` 또는 object로 명시해 consumer 분기를 안정화한다.
- `kind: approval`에는 executable skill/CLI 정보를 넣지 않는다.
- `kind: cli`의 기존 `argv`와 `requiresApproval` 의미를 유지한다.

### 5.2 Context route phase

Reference route에 stable id와 phase를 추가한다.

```json
{
  "id": "execution.lifecycle",
  "path": "references/execution-lifecycle.md",
  "load": "on-demand",
  "required": true,
  "phases": ["prepare", "owner-start", "retry"],
  "condition": "Gate C is absent and execution needs preparation, or a single-owner run is about to start or resume.",
  "stages": ["gate-c", "execution"]
}
```

초기 `p2a-dev-execution` mapping:

| Reference | Runtime phase |
| --- | --- |
| `execution-lifecycle.md` | `prepare`, `owner-start`, `retry` |
| `provider-confinement.md` | `owner-start` |
| `verification-closeout.md` | `verify-closeout` |
| `batch-execution.md` | `batch` |
| `visual-evidence.md` | `visual-review` |
| `acceptance-review.md` | `acceptance-review` |
| `monitor-gate.md` | `monitor` |

Visual/acceptance/monitor route는 phase 이름만으로 허용하지 않는다. 기존 canonical fact를 함께 검증한다.

- `verify-closeout`: 일반 구현 run이라 `runKind`가 없는가
- `visual-review`: 승인된 visual contract가 있고 `runKind`가 `final_visual_review`인가
- `acceptance-review`: acceptance review policy/activation이 적용되고 `runKind`가 `final_acceptance_review`인가
- `monitor`: 일반 구현 run이고 `monitorGate.required` 또는 동일한 canonical monitor activation이 참인가

Read-only phase를 요청할 시점은 owner의 판단이지만, 실제 write/finish authority와 evidence 요건은 기존 run command와 validator가 계속 강제한다.

`batch` route는 schema와 audit parity를 위해 선언하되 초기 Direct/Planned rollout에서는 활성화하지 않는다. Orchestrated 확대는 별도 evidence와 승인 뒤 진행한다.

### 5.3 Context packet command

Model-facing command:

```bash
p2a context show \
  --artifacts <dir> \
  --continuation execution.prepare \
  --provider codex
```

Lifecycle command 성공 뒤에는 구조화 결과의 run binding을 명시한다.

```bash
p2a execute start --artifacts <dir> --json
p2a context show \
  --artifacts <dir> \
  --continuation execution.owner-start \
  --run-id <execution-result.runId> \
  --provider codex
```

호출 host는 execution result를 먼저 schema 검증하고 `outcome/runStatus` 조건을 통과한 경우에만 `runId`를 전달한다. `context show`는 그 id의 canonical run evidence와 contract hash를 다시 검증하며 human output은 해석하지 않는다.

Started run의 read-only phase는 owner가 명시한다.

```bash
p2a context show \
  --artifacts <dir> \
  --run-id <run-id> \
  --phase verify-closeout \
  --provider codex
```

Metadata-only 진단:

```bash
p2a context show \
  --artifacts <dir> \
  --continuation execution.prepare \
  --provider codex \
  --json --metadata-only
```

동작 계약:

1. Artifact root와 project-local route manifest를 schema 검증하고 provider asset root를 허용된 confinement 안에서 해석한다.
2. `immediate`는 현재 `p2a next`를 재계산해 continuation id와 `sourceState`가 같은지 확인한다.
3. `after_command_success`는 호출 host가 검증한 `p2a.execution_result.v1`의 `runId`를 받고 실제 started run/task/spec hash를 다시 검증한다.
4. `run_declared`는 명시된 run이 `started`이고 Gate/task/run execution contract가 현재 상태와 일치하는지 확인한다. 구현 outcome의 준비 여부는 추론하지 않는다.
5. Provider, skill, phase, mode와 전용 review eligibility에 맞는 route만 선택한다.
6. Canonical main skill은 host가 이미 로드하므로 packet에는 선택된 reference만 넣는다.
7. Provider-specific path가 있으면 같은 canonical route 의미의 confined 대체 파일을 사용한다.
8. Source를 route id와 path의 안정 순서로 정렬하고 중복 path는 한 번만 출력한다.
9. 각 source 앞에 repository-relative path, route id, SHA-256, byte count를 표시한다.
10. 선언된 canonical/provider source root 밖의 파일, symlink escape, unreadable/non-regular file을 거부한다.
11. Stale action, failed command binding, closed/unknown run, unknown provider/phase/route, mode mismatch는 non-zero로 실패한다.
12. 사용자 entry/spec 본문, raw command/output과 manifest에 선언되지 않은 source는 packet에 넣지 않는다.

핵심 보안 경계는 credential 정규식 탐지가 아니라 schema-validated allowlist와 confined source root다. Credential-pattern 검사는 보조 방어로 둘 수 있지만 이를 통과했다고 임의 파일을 허용하지 않는다.

### 5.4 Context packet schema와 model boundary

`schemas/context-packet.schema.json`은 metadata-only 출력의 다음 필드를 검증한다.

- `schema_version: p2a.context_packet.v1`
- `provider`, `skill`, `phase`, `activation`, `mode`
- nullable `continuation`의 `id`, `sourceState`
- `binding.kind: action|run`
- action binding의 `sourceState`, `artifactContractSha256`
- run binding의 `runId`, `taskId`, 기존 `taskContractSha256`
- `sources[]`의 `routeId`, repository-relative `path`, `sha256`, `bytes`
- `totalBytes`, 진단용 `generatedAt`

Next continuation의 `binding.kind: command_result`는 activation에 필요한 입력을 선언하고, context packet의 `binding.kind: action|run`은 검증 후 해소된 binding을 기록한다.

`artifactContractSha256`은 현재 next action을 결정한 project/iteration/Gate source ref와 기존 source hash의 canonical JSON으로 계산한다. Canonical JSON은 key 정렬과 LF를 고정하고 timestamp와 absolute path를 제외한다.

Source body는 UTF-8 text로 제한하고 line ending만 LF로 정상화한다. `sha256`과 `bytes`는 실제로 emit하는 정상화 body를 기준으로 계산하며 audit와 runtime이 같은 함수를 사용한다.

Model-facing 출력은 불변 metadata를 사용해 source마다 `BEGIN/END`, route id, path, hash, bytes를 포함하는 결정적 boundary를 생성하며 `generatedAt`과 환경별 absolute path를 포함하지 않는다. Source 정렬, newline normalization과 boundary 문구를 fixture로 고정한다. 동일 source/action/run 입력의 model-facing packet은 byte-stable해야 하고 metadata-only JSON은 schema validation을 통과해야 한다.

## 6. 구현 작업

### CR-001 — Sanitized tool trajectory 계측

대상:

- `plans/evidence/context-engineering/CE-009/codex/run-codex-ab.mjs`
- CE-009 metadata/summary schema 또는 runner 내부 version

구현:

- 먼저 작은 Codex JSONL preflight를 실행해 `command_execution`에 순서, 성공/실패, command classification과 allowlisted source 식별에 필요한 필드가 실제로 있는지 확인한다.
- 필요한 field가 없으면 trace를 추정하거나 raw event를 보존하지 않고 이 task를 중단해 설계를 조정한다.
- Event는 메모리에서만 분류하고 저장 시 raw command, raw command SHA-256과 stdout/stderr 본문을 제외한다. 기존 stdout/stderr SHA-256은 evidence 무결성 호환용으로 유지하되 operation identity에는 사용하지 않는다.
- Canonical allowlist와 일치한 path는 repository path 대신 stable source id로 정상화한다.
- `operationFingerprint`는 raw command가 아니라 `commandClass + sorted allowlisted sourceIds`만으로 만든 정규화 문자열이다.
- 한 operation에 같은 source가 여러 번 나타나도 operation-source pair는 한 번만 세어 다중 source read와 다중 operation을 구분한다.
- 다음 지표를 명시적으로 집계한다.
  - `toolOperations`: 전체 `command_execution` 수
  - `uniqueSourcesRead`: 서로 다른 allowlisted source id 수
  - `sourceReadOccurrences`: operation별 source id 수의 합
  - `repeatedSourceReads`: source별 첫 operation 이후 다시 읽힌 횟수의 합
  - `sourcesPerReadOperation`: read operation당 평균 source 수
  - `unknownOperations`: 안전하게 분류할 수 없는 operation 수
- Provider가 item별 usage를 제공하지 않으면 turn별 token을 추정하지 않고 `unavailable`로 둔다.
- 기존 metadata reader와 regrade 경로를 유지하되, 과거 evidence의 trace 지표는 `unavailable`로 둔다.

Acceptance:

- Synthetic command에 포함된 known path만 정상화해 저장한다.
- Workspace 밖 path, shell argument, raw command/hash, command output 본문과 secret-like value가 저장되지 않는다.
- 한 operation이 여러 source를 읽는 fixture와 같은 source를 여러 operation에서 읽는 fixture가 서로 다른 metric을 만든다.
- 기존 36개 evidence는 읽을 수 있고 신규 trace 부재를 오류로 취급하지 않지만, 신규 trace 값과 수치 비교하지 않는다.

### CR-002 — 평가 시나리오 분리

구현:

- Routing fixture는 실제 artifact 상태에서 `p2a next --json --contract v2`를 실행한다.
- Context fixture는 routing 결과의 continuation과 기대 source id를 비교한다.
- Behavioral fixture는 CLI가 반환한 구조화 action과 필요한 skill 하나만 모델에 제공한다.
- Production fixture는 prepare/start/verify/finish를 실제 isolated artifact에서 실행한다.
- 기존 aggregate A/B는 역사적 evidence로 유지하고 덮어쓰지 않는다.
- 제품 변경 전에 현재 candidate와 동일 model/profile/fixture에 CR-001 trace만 적용한 `instrumented current-candidate baseline`을 시나리오별 최소 5회 생성한다.

Acceptance:

- Direct behavioral prompt가 `p2a-next`와 `p2a-dev-execution`을 동시에 primary로 강제하지 않는다.
- Routing 오류, context selection 오류와 최종 판단 오류가 별도 grade로 구분된다.
- Baseline/candidate는 같은 artifact, contract, provider, model profile과 권한을 사용한다.
- 역사적 CE-009 결과와 계측 기준선은 별도 evidence id에 저장되고 missing trace를 0으로 해석하지 않는다.

### CR-003 — Structured next continuation

대상:

- `schemas/next-v2.schema.json`
- 신규 `schemas/execution-result.schema.json`
- `scripts/p2a.mjs`
- `scripts/p2a_execute.mjs`
- `tests/next-decision.test.mjs`
- execution CLI 및 package tests
- package/tool manifest와 CLI asset sync
- `.agents/skills/p2a-next/SKILL.md`
- provider mirror와 문서

구현:

- `kind: skill`에 `skill`과 `args`를 추가한다.
- top-level `continuation`을 `null|object`로 추가한다.
- 각 `NEXT_DECISION_RULES` action이 필요한 continuation id, activation, sourceState, phase와 binding을 명시한다.
- Continuation이 있는 `start`, `resume`, `review`, `accept --json` 성공 결과에 `p2a.execution_result.v1`의 `outcome`, `taskId`, `runId`, `runStatus`를 제공한다.
- `--json` stdout은 단일 schema-valid JSON document만 출력하고 human diagnostics는 stderr 또는 non-JSON mode로 분리한다.
- Non-zero command, schema-invalid result, `outcome != succeeded` 또는 `runStatus != started`는 `after_command_success` continuation을 활성화하지 않는다.
- state-specific 후속 규칙을 가능한 범위에서 `p2a-next` skill 본문에서 CLI payload로 이동한다.
- v1 schema와 field set을 그대로 유지한다.

Acceptance:

- 전체 next state test에서 `generatedAt`과 환경별 absolute `target`을 정상화한 v1 semantic payload가 기존과 동일하다.
- 기존 v1 consumer fixture가 변경 없이 통과한다.
- v2 skill action은 display parsing 없이 실행 대상을 식별할 수 있다.
- v2 CLI action은 성공 결과의 구조화 `runId`로 후속 packet을 결합할 수 있다.
- Invalid skill, activation, phase, binding, continuation/state 조합을 schema 또는 builder가 거부한다.
- 승인 action이 executable continuation을 잘못 제공하지 않는다.

### CR-004 — 공통 route resolver와 phase schema

대상:

- `schemas/context-routes.schema.json`
- `.agents/context-routes.json`
- 신규 또는 추출된 `scripts/p2a_context_routes.mjs`
- `scripts/p2a_context_audit.mjs`
- `scripts/check_cli_parity.mjs`
- `scripts/sync_cli_assets.mjs`
- 관련 tests

구현:

- Reference별 stable `id`와 `phases`를 검증한다.
- Provider path, mode, stage, phase 선택을 공통 pure resolver로 추출한다.
- Audit의 기존 conditionId를 호환 유지하되 runtime은 continuation phase로 선택한다.
- Visual/acceptance/monitor는 각각 canonical eligibility와 `runKind`가 일치할 때만 선택하고 generic closeout fan-in을 만들지 않는다.
- 초기 runtime route는 `p2a-dev-execution` Direct/Planned에 한정하고 다른 skill은 evidence 기반 후속 rollout으로 둔다.
- Provider mirror와 Gemini adapter가 route 본문을 복제하지 않는 현재 계약을 유지한다.

Acceptance:

- 같은 provider/skill/phase/mode 입력은 audit와 runtime에서 같은 source path/hash를 반환한다.
- Duplicate id, unknown phase, provider path 누락, mode mismatch와 ineligible review phase 음성 fixture가 실패한다.
- CLI parity와 strict context doctor가 통과한다.

### CR-005 — Action-bound `p2a context show`

대상:

- 신규 `scripts/p2a_context.mjs`
- 신규 `schemas/context-packet.schema.json`
- `scripts/p2a.mjs` dispatcher/help
- package/tool manifest와 CLI asset sync
- CLI reference와 tests

구현:

- `context show`의 human/model packet과 metadata-only JSON 출력을 추가한다.
- `immediate` action은 현재 next state를 재계산한다. `after_command_success`에서는 host가 schema-valid result에서 전달한 `runId`의 started run/task/spec hash를 독립 검증한다.
- `run_declared`는 명시된 started run과 current execution contract를 검증하되 구현 outcome 준비 시점은 owner 판단으로 남긴다.
- Source path confinement, regular-file, symlink escape와 SHA-256을 검증한다.
- Packet source 순서와 boundary format을 결정적으로 만든다.
- Metadata-only JSON을 `p2a.context_packet.v1`로 검증하고 model-facing 출력은 그중 불변 metadata에서 생성한다.

Acceptance:

- Direct prepare packet이 `execution-lifecycle`만 포함한다.
- Owner start packet이 lifecycle/confinement 중 선언된 source를 중복 없이 한 번에 반환한다.
- `verify-closeout`은 explicit started run에서만 열리고 CLI가 별도 구현완료 상태를 추측하지 않는다.
- Visual/acceptance/monitor source는 실제 contract/policy 조건 없이는 포함되지 않는다.
- Stale action과 외부 경로가 non-zero로 실패한다.
- Metadata source/path/hash/bytes와 model boundary가 반복 실행에서 결정적이다.
- Installed package의 `p2a context show` 양성·음성 fixture가 통과한다.

### CR-006 — Skill 슬림화와 provider parity

구현:

- `p2a-next`에는 next 실행, structured action 준수, 승인 정지만 남긴다.
- `p2a-dev-execution`에는 목적·권한·핵심 판단과 phase packet entry만 남긴다.
- Direct/Planned에서 packet으로 대체된 세부 절차만 main skill에서 제거한다.
- Orchestrated 전용 절차는 동등한 packet route와 behavioral evidence가 생길 때까지 유지한다. 모든 mode에 공통인 문장은 각 mode의 도달 가능한 source가 증명된 경우에만 제거한다.
- Claude mirror와 Gemini thin wrapper를 canonical source에서 동기화한다.
- 초기 slim/packet 전환은 Direct/Planned에 적용하고 Orchestrated 및 다른 skill 확대는 별도 evidence 뒤에 진행한다.

Acceptance:

- Main skill 축소가 hard authority/approval boundary를 제거하지 않는다.
- 기존 Orchestrated routing/behavior fixture가 축소 전과 동일하게 통과한다.
- Generated provider surface가 canonical hash/parity test를 통과한다.
- Gemini는 계속 read-only이며 context packet이 write 권한을 부여하지 않는다.

### CR-007 — 단계별 A/B와 rollout 판정

실험 순서:

1. Event-shape preflight와 현재 candidate + trajectory 계측만 적용한 측정 기준선
2. Structured continuation만 적용
3. Phase route만 적용
4. Action-bound packet 적용
5. Skill 슬림화 적용

각 단계는 Direct, Gate B, Planned를 Codex 동일 profile로 각각 최소 5회 먼저 실행한다. 모든 비교는 계측 기준선과 같은 model, fixture, artifact, 권한, repetition matrix를 사용한다. 선행 단계가 hard gate를 모두 통과하고 어떤 주요 median도 기준선보다 10% 넘게 악화되지 않을 때만 다음 단계로 진행한다. 최종 CR-005/006 candidate는 §7.2의 더 강한 수치 gate를 만족해야 한다.

다른 provider 호출은 provider/model/profile/비용 범위에 대한 별도 승인을 받은 경우에만 같은 순서로 확장한다. 미승인, 인증 실패 또는 model/profile 불일치는 `skipped success`가 아니라 coverage blocker다.

### 작업 의존성과 변경 경계

1. CR-001 preflight/계측을 완료한 뒤 CR-002 계측 기준선을 동결한다.
2. 기준선이 동결되기 전에는 CR-003~006의 제품 변경을 시작하지 않는다.
3. CR-003과 해당 CR-007 단계 평가를 통과한 뒤 CR-004를 적용한다.
4. CR-005는 CR-003의 activation/result 계약과 CR-004의 공통 resolver에 의존한다.
5. CR-006은 CR-005 packet이 package surface까지 검증된 뒤에만 적용한다.
6. 각 단계의 코드·schema·fixture·evidence를 독립 rollback 가능한 변경 단위로 유지한다.

## 7. 검증 전략

### 7.1 결정적 repository 검증

```bash
npm test
npm run test:package
npm run test:full
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/p2a.mjs doctor --context --strict
git diff --check
```

추가 필수 fixture:

- `generatedAt`과 환경별 target path를 정상화한 v1 semantic/field 호환 및 기존 consumer 통과
- v2 structured skill/continuation/activation 양성·음성
- `p2a.execution_result.v1` 성공·실패와 command-result run binding
- continuation/sourceState mismatch 및 failed command activation 거부
- phase/provider/mode별 source 선택
- `p2a.context_packet.v1` metadata schema, source ordering, boundary와 hash 결정성
- symlink/path escape
- stale artifact/action, closed run과 contract hash mismatch
- visual/acceptance/monitor eligibility별 no-load와 load
- packet 본문에 undeclared source, raw 사용자 문서/command output이 없는지 검사
- credential-pattern 검사는 supplemental fixture로 유지하되 allowlist/confinement를 대체하지 않음
- tool trace에 raw command, raw command hash와 output 본문이 없는지 검사
- 한 operation의 multi-source와 여러 operation의 repeated-source metric 분리
- packed/installed CLI의 `p2a context show` 양성·음성

### 7.2 Provider behavioral gate

일차 hard gate:

- Acceptance coverage가 기준선보다 낮아지지 않는다.
- 승인 우회, scope 위반, authority 위반 0건
- 실패·retry·checkpoint lineage 손실 0건
- 필요한 visual/acceptance/monitor evidence 누락 0건
- 모든 candidate repetition 개별 통과

이차 performance gate:

- 비교 기준은 제품 변경 전 동일 조건으로 최소 5회 측정한 `instrumented current-candidate baseline`이다.
- 최종 candidate의 Direct median `toolOperations`는 기준선보다 최소 1회 감소한다.
- 최종 candidate의 Direct median 총 input은 기준선의 90% 이하다.
- 같은 repetition matrix 전체의 총 input 합계와 elapsed 합계는 각각 기준선 이하다.
- 같은 matrix의 uncached input 합계는 기준선의 105% 이하다.
- 명시적 품질 근거와 승인된 예외 없이 scenario별 median 총 input은 기준선의 110%를 넘지 않는다.
- Packet-managed source의 `repeatedSourceReads`는 0이다.
- `unknownOperations`는 기준선보다 증가하지 않으며, 0이 아니면 각 class의 원인과 계측 coverage를 보고한다.

중간 단계는 hard gate를 모두 통과하고 주요 metric median이 기준선보다 10% 넘게 악화되지 않아야 다음 단계로 간다. 최종 판정은 aggregate만 보지 않고 scenario별 median, repetition별 값, operation/source 지표를 함께 남긴다. 승인되지 않았거나 실행 불가능한 provider는 통과로 계산하지 않는다.

## 8. Rollout과 rollback

| 단계 | 변경 단위 | Rollout 조건 | Rollback 단위 |
| --- | --- | --- | --- |
| 1 | CR-001/002 계측·평가 | event preflight 성공, 기존 evidence 호환, 본문 비노출, 5회 계측 기준선 완성 | 평가 tooling만 제거 |
| 2 | CR-003 next/result contract | v1 normalized semantic 동일, 기존 consumer와 v2/result tests 통과 | v2 continuation/result 변경만 되돌림 |
| 3 | CR-004 phase resolver | audit/runtime source parity | route schema/resolver만 되돌림 |
| 4 | CR-005 context packet | packet schema, confinement, activation/run binding과 package test 통과 | context command만 비활성화 |
| 5 | CR-006 skill 슬림화 | provider parity, A/B hard gate와 최종 수치 gate 통과 | 해당 skill 단계만 복원 |
| 6 | CR-007 provider rollout | 승인된 대상 provider/model/profile별 증거 충족 | provider별 rollout 제한 |

다음 경우 rollout을 중단한다.

- hard gate 한 건이라도 실패
- 제품 변경 전 계측 기준선이 최소 repetition을 충족하지 못함
- context packet이 stale action에서 성공
- context packet이 failed command, closed run 또는 contract mismatch에서 성공
- undeclared source 또는 workspace 밖 파일 포함
- v1 consumer contract 변화
- 중간 단계의 주요 median이 기준선보다 10% 넘게 악화됨
- 최종 Direct/aggregate/uncached 수치 gate를 충족하지 못했는데 main skill 안전 계약만 줄어듦
- 실패한 provider coverage를 aggregate 평균으로 숨김

## 9. 위험과 대응

| 위험 | 대응 |
| --- | --- |
| Packet이 필요 이상으로 커짐 | phase/mode/provider 선택과 source count fixture로 제한 |
| Resolver가 새로운 정본이 되어 skill과 drift | route manifest와 공통 pure resolver만 정본으로 사용 |
| Stale next action 재사용 | packet 생성 직전 artifact state와 continuation 재검증 |
| Human output에서 잘못된 run id 추출 | lifecycle command의 schema-validated JSON result에만 binding |
| Owner가 read-only phase를 너무 일찍 요청 | started run과 execution contract는 강제 검증하고 준비 시점은 명시적 owner 책임으로 기록 |
| Path list 반환 뒤 추가 read 발생 | model-facing 출력에서 본문까지 한 호출로 제공 |
| 평가가 raw command나 secret을 저장 | allowlisted source id만 저장하고 raw command/hash와 output 본문 폐기 |
| 과거 trace 부재를 0으로 오해 | 역사적 evidence는 `unavailable`, 신규 계측 기준선과 분리 |
| Benchmark에 맞춘 과최적화 | routing/context/outcome/production 평가 분리 |
| Provider별 동작 차이 | provider path는 허용하되 canonical route id와 의미 parity 강제 |
| 미승인 provider 호출 또는 누락 coverage | provider/model/profile/비용 승인 후 호출하고 미실행은 blocker로 기록 |
| Phase enum이 지나치게 세분화 | 초기 8개 enum 외 확장은 실제 회귀 증거가 있을 때만 허용 |

## 10. 완료 정의

이 계획은 다음을 모두 만족할 때 완료다.

- Event-shape preflight가 통과하고 tool trajectory로 실제 reference read와 반복 read를 국소화할 수 있다.
- 과거 evidence와 분리된 5회 이상 `instrumented current-candidate baseline`이 있다.
- Routing, context selection, behavioral outcome, production lifecycle evidence가 분리된다.
- `p2a.next.v1` schema/field와 normalized semantic 호환성이 유지되고 기존 consumer가 통과한다.
- v2와 execution result가 display parsing 없이 skill, activation, continuation과 run binding을 전달한다.
- Runtime phase와 검증된 action 또는 started run contract가 context packet source를 결정한다.
- `p2a.context_packet.v1` packet이 필요한 canonical reference를 한 호출에서 제공하고 route/path/hash/bytes를 보존한다.
- Audit와 runtime resolver가 같은 source set을 반환한다.
- Packed/installed CLI의 `p2a context show`가 동일 계약으로 동작한다.
- Codex 우선 A/B에서 모든 품질 hard gate와 §7.2의 Direct/aggregate 수치 gate를 충족한다.
- Claude/Gemini 미실행 또는 실패 coverage를 명시적으로 남긴다.
- 전체 provider 증거가 없으면 `provider_limited`를 `go`로 올리지 않는다.

## 11. 참고 자료

- [P2A 컨텍스트 엔지니어링 개선 계획](./context-engineering-improvement-plan.md)
- [CE-009 Codex aggregate A/B 보고서](./evidence/context-engineering/CE-009/codex/README.md)
- [CE-009 machine-readable summary](./evidence/context-engineering/CE-009/codex/codex-ab-summary.json)
- [OpenAI Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
