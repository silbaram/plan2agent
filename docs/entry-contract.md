# Plan2Agent 진입 계약

이 문서는 한 문장 명령 대신 사용자가 작성했거나 Feature Radar가 전달한 짧은 아이디어 문서를 Plan2Agent 기획 흐름의 주 입력으로 연결하는 계약을 정의한다. 진입 문서는 “무엇을 만들 것인가”를 전달하는 원문이며, Gate A-D 산출물이나 승인 기록을 대신하지 않는다.

문서 홈: [Plan2Agent Docs](README.md) · 게이트 규칙 정본: [`p2a-harness` skill](../.agents/skills/p2a-harness/SKILL.md)

## 1. 원칙

- 사용자가 직접 쓴 한 문단 Markdown 또는 일반 텍스트만으로 시작할 수 있다.
- Feature Radar 사용은 선택 사항이다. Radar 없이도 같은 검증과 확인 흐름을 거친다.
- 원문은 미리 정해진 템플릿, JSON, 요약문, 완성된 요구사항 목록일 필요가 없다.
- 부족하지만 추론 가능한 내용은 확인 대화에서 보완한다. 원문을 자동으로 다시 쓰거나 원문보다 합성 요약을 우선하지 않는다.
- 진입 문서는 Gate A 입력이다. 명시적 범위 확인, Gate B 승인, 승인된 spec의 downstream 차단 규칙을 우회하지 않는다.

## 2. 최소 문서 계약

`p2a validate --entry <path>`는 다음을 오류로 검사한다.

1. 경로가 존재하는 일반 파일이어야 한다.
2. 확장자는 Markdown 또는 텍스트여야 한다: 확장자 없음, `.md`, `.markdown`, `.txt`, `.text`.
3. 공백을 제외한 본문이 있어야 한다.

본문에서 무엇을 만들지 확실히 판정하지 못해도 진입을 차단하지 않는다. 이 판정은 키워드 기반 보조 신호일 뿐이며, 불명확하면 warning을 출력하고 범위 확인 대화에서 되묻는다. `.plan2agent/artifacts/<project_id>/preflight-research/<sequence>/` 아래 Radar 문서의 manifest 출처 정보가 없거나 불완전해도 같은 방식으로 warning을 출력한다.

다음은 필수 조건이 아니다.

- 특정 제목이나 섹션 구조
- 대상 사용자, 구현 기술, acceptance criteria의 사전 확정
- Feature Radar 실행
- URL 또는 추천 항목 포함
- Gate A/B schema를 원문에 직접 표현하는 일
- discovery dimension 처분, `CQ-n`/`ND-n`, `canonical_effect`, `affected_fields`, `spec_updates`, 라운드 또는 진행도 카운터

웹 URL이 12개를 초과하거나 추천 항목이 8개를 초과하면 검증은 성공하고 warning만 출력한다. 이후 evidence 변환에서는 각각 앞의 12개와 8개만 승격하며, 원문 전체는 별도 참조로 보존한다. 문서가 없거나 비어 있거나 지원하지 않는 형식일 때만 진입 검증을 차단한다.

## 3. 발견과 우선순위

진입 문서 선택과 기존 기획 상태 재개는 서로 다른 우선순위 층을 사용한다.

### 3.1 기존 기획 상태 우선

Gate A-D 파일, `current-spec.json`, 또는 iteration 상태가 이미 있으면 그것이 항상 우선한다. `--entry`나 자동 발견 문서가 함께 있어도 `p2a next`는 기존 canonical 기획 상태에서 가장 이른 변경 지점을 재개한다. 기존 인터뷰 snapshot도 유지하며 새 진입 대화로 초기화하지 않는다.

### 3.2 새 진입 문서 선택

canonical 기획 상태가 없을 때 다음 순서로 하나를 선택한다.

1. `p2a next --entry <path>`로 명시한 문서
2. 가장 최신 `preflight-research/<sequence>/collection-report.md`
3. 반복 개발인 가장 최신 sequence의 `next-iteration-recommendations.md`

Sequence 디렉터리는 숫자를 인식해 정렬한다. 최신 sequence에 `collection-report.md`가 있으면 추천 문서보다 먼저 사용한다. 추천 문서는 active iteration이 있거나 Radar manifest/content가 `existing-project`를 선언할 때만 fallback으로 사용한다. 과거의 sequence나 평면형 `preflight-research/` 배치는 호환 입력으로 읽을 수 있지만 새 sequence 선택보다 우선하지 않는다.

## 4. Feature Radar 출처 계약

Radar 산출물은 다음 역할로 구분한다. 진입 시에는 주 입력 하나만 읽고, 나머지는 근거가 필요할 때만 연다.

| Radar 산출물 | p2a 역할 |
| --- | --- |
| `collection-report.md` | 신규 개발 주 입력 |
| `next-iteration-recommendations.md` | 반복 개발 주 입력 fallback |
| `capability-gap-analysis.md` | 반복 개발 보조 근거 |
| `signal-map.md`, `source-candidates.md` | 필요할 때만 여는 참조 |
| `research-bundle.md`, `research-plan.md` | 참조 전용 |
| `local-project-scan.md` | 참조 전용 |
| `handoff-manifest.md` | 출처 기록 |

Radar 진입 문서는 같은 디렉터리의 `handoff-manifest.md`에 다음 출처 정보를 기록하는 것이 권장된다.

- `handoff_mode: p2a-preflight` 또는 같은 의미의 `mode: p2a-preflight`
- 비어 있지 않은 `source_run`
- sequence 디렉터리를 사용할 때 경로와 일치하는 `preflight_sequence`
- `Copied Files` 목록에 선택된 진입 문서 이름 포함

manifest가 없거나 위 정보가 불완전하거나 `source_complete: false`이면 출처 확인 warning을 남기되 진입 자체를 거부하지 않는다. 이는 Radar 산출물 형식을 진입 필드 schema로 고정하지 않기 위한 경계다. Radar 파일은 기존 evidence 모델을 그대로 사용한다. 문서는 `LOCAL-n`, 발견 URL은 `WEB-n`, 추천은 `reference_reconnaissance.candidates`의 `origin: "feature_radar_preflight"`로 들어간다. 추천은 처음에는 context이며, 사용자의 범위 확인 전에는 승인된 scope가 아니다.

두 Radar 모드는 다음 진입 흐름을 사용한다.

| Radar 모드 | p2a 진입 |
| --- | --- |
| idea research | 게이트 ① 범위 확인 → 게이트 ② 명세 승인 → 실행 |
| existing project | 게이트 ① 범위 확인 → 기존 `constitution.json` 재사용 → 실행 |

이 계약은 `constitution.json` 수명주기를 새로 만들거나 기존 반복 상태를 초기화하지 않는다. 반복 프로젝트에 해당 파일이 있으면 재사용한다.

## 5. CLI 상태 계약

### `p2a next`

하네스는 설치되었지만 artifact root가 없고 `--entry`도 전달되지 않으면 기존 한 문장 아이디어 인터뷰를 안내한다.

- `state: initialized_without_artifacts`
- `command.kind: skill`
- 다음 행동: `/p2a-harness "<one-sentence idea>"` 실행. 준비된 문서가 있으면 `p2a next --entry <path>`를 사용할 수 있다.

선택된 진입 문서가 없거나 비어 있거나 지원하지 않는 형식이라 검증에 실패하고 재개할 canonical 상태도 없으면 다음 상태를 반환한다.

- `state: entry_invalid`
- `command.kind: approval`
- 다음 행동: 문서를 수정한 뒤 `p2a validate --entry <path>` 실행

유효한 진입 문서가 선택되면 다음 상태를 반환한다.

- `state: gate_what`
- `command.kind: skill`
- 다음 행동: `/p2a-harness --entry "<path>"`로 범위 확인

기존 Gate 상태가 있으면 진입 문서 오류보다 canonical 재개 경로가 우선한다.

### `p2a info`와 `p2a doctor`

자동 선택된 진입 문서가 하나이면 `p2a info --json`은 기존 JSON 필드를 유지하면서 조건부 `entry` 요약과 검증/확인 next action을 추가한다. 진입 문서가 없으면 기존 JSON shape을 바꾸지 않는다.

`p2a doctor`는 Radar-only artifact root도 `planning_in_progress`로 인식한다. 유효한 entry-only 프로젝트에는 `p2a validate --entry <path>`를 안내한다. 문서 누락·빈 문서·지원하지 않는 형식은 artifact diagnostic으로 보고하지만, Radar 출처 정보나 scope 보조 판정, URL/추천 상한 warning은 설치 실패로 승격하지 않는다.

## 6. 범위 확인 대화

`gate_what`은 기존 bounded interview를 제거하는 상태가 아니라, 검증된 원문에서 시작하는 별도 Gate A 진입 방식이다.

1. 하네스는 원문과 Radar manifest가 있으면 출처를 읽는다.
2. 무엇을 만들지, 대상 사용자, 기대 결과, 포함/제외 범위, 하드 제약, 중요한 가정을 짧게 요약한다.
3. 안전하게 추론할 수 없고 범위를 실질적으로 바꾸는 내용만 묻는다. 이 경로에는 고정 질문 수나 라운드 제한이 없으며, 확인 가능한 즉시 질문을 멈춘다.
4. 수정된 범위를 다시 제시하고 사용자의 명시적 확인을 요청한다. 침묵, 원문 존재, “개발해” 같은 포괄 지시는 승인이 아니다.
5. Radar 추천은 승격된 각 후보를 `selected`, `rejected`, `deferred` 중 하나로 처분하고 이유를 기록한다.
6. 확인 후에만 같은 `p2a.intake.v1` schema와 Gate A `approval_audit`로 canonical intake를 만들고 정상 Gate B 흐름을 계속한다.

`--entry`가 없는 한 문장 아이디어는 기존 Discovery Interview Loop를 그대로 사용한다. 두 경로 모두 Gate A 확인 전 Gate B를 만들 수 없고, Gate B 승인과 open decision 해소 전 Gate C로 진행할 수 없다.

## 7. 호환성 경계

이 계약은 다음을 변경하지 않는다.

- 기존 intake/requirements 인터뷰와 재개 snapshot
- `intake.schema.json`, `spec.schema.json` 및 기존 artifact validator
- Feature Radar의 evidence 모델과 원본 copy/변환 규칙
- approved spec이 없을 때 downstream task 생성을 막는 규칙
- Gate A-D 승인 및 audit 계약
- 기존 `p2a validate`, `p2a info`, `p2a doctor` 호출의 의미와 정상 동작

따라서 새 entry 프로젝트는 명시적 확인과 승인을 거쳐 Gate B 이후로 진행할 수 있고, 기존 프로젝트는 진입 문서가 추가되어도 현재 canonical 상태에서 결정론적으로 재개한다.

## 8. 예시

사용자 작성 문서로 시작한다.

```bash
p2a init --target . --tools all
p2a validate --entry docs/idea.md
p2a next --entry docs/idea.md
```

Radar handoff를 자동 발견한다.

```text
.plan2agent/artifacts/release-console/preflight-research/002-followup/
├── collection-report.md
├── next-iteration-recommendations.md
└── handoff-manifest.md
```

```bash
p2a next
p2a info --json
p2a doctor --json
```

저장소 수준 회귀 검증은 다음 명령을 모두 통과해야 한다.

```bash
node scripts/sync_cli_assets.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
node --test tests/
```
