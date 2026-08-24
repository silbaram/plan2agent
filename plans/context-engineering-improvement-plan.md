# P2A 컨텍스트 엔지니어링 개선 계획

> 상태: 리뷰 지적사항 수정 및 로컬 회귀 검증 완료 / Codex aggregate A/B 완료(`provider_limited`) / 전체 CE-009 대기
>
> 작성일: 2026-08-15
>
> 기준 버전: v0.3.0 / `main@e7c5adb`
>
> 작업 브랜치: `docs/context-engineering-improvements`
>
> 적용 목표: v0.3.0 이후의 점진적 개선

## 1. 결론

Claude 5 세대에 맞춘 컨텍스트 엔지니어링 원칙은 P2A에도 유용하다. 다만 “지시를 적게 쓰면 항상 더 좋다”거나 “기존 프롬프트의 80%를 일괄 삭제한다”는 식으로 적용하면 안 된다.

P2A v0.3.0은 이미 다음 영역에서 새 원칙과 잘 맞는다.

- Gate B 결과를 바탕으로 Direct, Planned, Orchestrated 실행 방식을 선택한다.
- `p2a next`가 현재 상태에 맞는 다음 행동 하나를 구조화해 반환한다.
- JSON 스키마, 검증기, 테스트, HTML 프로토타입, 스크린샷과 접근성 증거처럼 Markdown보다 풍부한 자료를 활용한다.
- 실행·승인·검증·메모리의 책임을 모델의 일시적인 대화 기억에만 맡기지 않는다.

개선의 핵심은 Gate와 안전 규칙을 없애는 것이 아니다. **사람이 판단해야 하는 경계는 유지하고, 기계가 강제할 수 있는 규칙은 CLI·스키마·검증기로 옮기며, 모델에는 현재 단계에서 필요한 판단 기준만 제공하는 것**이다.

### 1.1 구현 결과 (2026-08-15)

| 항목 | 상태 | 반영 결과 |
| --- | --- | --- |
| CE-001 | 완료 | schema-valid `.agents/context-routes.json`과 `p2a.context_audit.v1`으로 선언 inventory와 mode·condition별 실제 조립 시나리오를 구분하고, source·owner·크기·근사 token·hash·중복·충돌·baseline drift를 계측한다. Baseline delta는 동일 측정·정규화 시나리오·provider 집합에서만 계산하며 source 추가·제거, 같은 크기의 SHA 변경, route metadata 변경과 0이 아닌 크기 변화는 strict warning으로 처리한다. |
| CE-002 | 완료 | 하네스 상태와 독립적인 `p2a doctor --context [--json] [--strict]`를 추가했다. |
| CE-003 | 완료 | canonical route가 reference의 load·필수/선택·stage·mode·provider 제한과 provider별 대체 경로를 소유한다. Canonical skill에는 이 의미의 기계 비교 가능한 compact signature를 두고 audit·생성기·doctor·parity test가 함께 검증하며, Gemini wrapper에는 호출법과 read-only 공급자 제약만 남겼다. |
| CE-004 | 완료 | 주요 skill 5개를 판단·경계·조건부 라우팅 중심의 얇은 상위 문서와 세부 reference로 분리했다. |
| CE-005 | 완료 | 기존 schema·validator·CLI가 강제하는 불변 조건은 그대로 유지하고, 상위 skill에서는 권위 source와 복구 경로를 가리키도록 세부 절차를 옮겼다. validator는 local JSON Pointer `$ref`도 재귀 검증한다. |
| CE-006 | 완료 | 기본 `p2a.next.v1` 응답과 strict schema는 변경하지 않고, enum `state`·`reasonCode`가 필요한 consumer용 `p2a.next.v2`를 `--contract v2`로 분리했다. |
| CE-007 | 완료 | provider 자동 메모리, BuildLore, Gate artifact의 책임과 충돌 우선순위를 skill 및 하네스 문서에 명시했다. |
| CE-008 | 완료 | 선택적 entry bundle과 Gate A snapshot·Gate B usage sidecar를 추가했다. 신규 문서 기반 Gate A 승인은 `p2a decide --entry`가 entry와 bundle을 재검증해 snapshot 누락·불일치를 차단하고, sibling bundle 자체가 symlink나 비정규 파일이면 “bundle 없음”으로 취급하지 않고 거부한다. `p2a reference snapshot`은 프로젝트 내부 reference symlink의 논리 경로를 보존하면서 실경로 confinement를 검사하고, validator·iteration init·handoff가 실제 hash, 승인 binding, REF↔LOCAL 양방향 연결과 실제 spec 결정 경로를 보존·재검증한다. |
| CE-009 | 부분 완료 | repository test, package test, fixture gate와 provider asset parity를 통과했고 §5.4에 비교·증거·rollout 프로토콜을 고정했다. Codex `gpt-5.6-luna/medium` aggregate behavioral A/B는 6개 시나리오를 baseline/candidate 각각 3회 실행해 양쪽 모두 18/18 hard gate를 통과했다. 다만 합산 변경·synthetic 판단 평가이며 Claude/Gemini와 production lifecycle coverage가 없으므로 판정은 `provider_limited`다. |

동일한 정적 audit 방식으로 구현 전후를 비교한 결과는 다음과 같다.

- 주요 skill 5개 상위 본문: 888줄 / 73,654바이트 → 282줄 / 22,237바이트(바이트 69.8% 감소)
- 전체 provider surface의 unique always-loaded source: 165,865바이트 → 59,139바이트(64.3% 감소)
- 현재 inventory audit: provider 3개, skill 7개, context 66개, source 91개, owner 10개, warning 0개, failure 0개
- Orchestrated batch 조립 시나리오의 provider 공통 unique resolved corpus: 24,240바이트 / 근사 6,062 token. 단일 provider 기준은 Codex·Claude 각 11,908바이트 / 근사 2,978 token, Gemini 12,332바이트 / 근사 3,084 token이다.
- 같은 Orchestrated batch 비교 계약은 [machine-readable baseline](./context-engineering-orchestrated-batch-baseline.json)으로 보존했다.
- exact/near duplicate 후보 2개는 정보성 진단으로 남아 있으며 안전·계약 손실 없이 후속 정리할 수 있다.
- [Codex aggregate A/B](./evidence/context-engineering/CE-009/codex/README.md)는 baseline/candidate 모두 18/18을 통과했다. Candidate의 uncached input은 4.45% 줄었지만 총 input은 8.54%, output은 14.50%, elapsed는 11.59%, tool call은 28.57% 늘어 품질 유지와 초기 컨텍스트 축소만 확인했으며 총 비용·시간 개선은 확인하지 못했다.

최신 로컬 검증은 repository suite 429/429(로컬 listen 1건은 sandbox 밖에서 재검증), package/fixture 검증, CLI parity, strict context doctor와 저장된 baseline의 source·route·size zero-delta 비교를 통과했다. 이 결과는 구조·호환성 회귀 증거다. Codex A/B는 제한된 provider 행동 증거를 추가하지만 변경 단위별 production 실행과 전체 provider 비결정성 평가를 대신하지 않는다.

### 1.2 구현 리뷰에서 수정한 내용

초기 구현 리뷰에서 발견한 결함은 다음과 같이 수정했다.

1. route manifest를 읽기만 하던 동작을 고쳐, audit 시작 전에 `context-routes.schema.json`으로 검증하고 중첩 `$ref` 규칙까지 실제로 적용한다.
2. strict v1 응답에 `reasonCode`를 추가해 consumer를 깨뜨리던 설계를 폐기하고, 기존 기본값은 v1으로 유지한 채 typed 계약을 별도 v2로 제공한다.
3. 정적 파일 목록에 그치던 audit를 inventory/assembled 측정으로 분리하고, stage·mode·condition, instruction owner, baseline 변화, conditional→always 승격과 반대 극성 충돌 후보를 기록한다.
4. reference 사용 기록을 프롬프트 지침에만 맡기지 않고 Gate A snapshot과 Gate B usage sidecar, 승인 hash binding, iteration·handoff 경로 재검증으로 강제한다.
5. repository 검증으로 확인할 수 없는 실제 provider 품질과 비결정성은 CE-009의 미완료 release gate로 명시한다.
6. 승인 audit에 기록된 snapshot/usage sidecar가 삭제되면 optional provenance로 되돌아가지 않고 validation이 실패하도록 승인 경로를 강제한다.
7. hand-authored snapshot hash를 허용하던 구조를 폐기하고 `p2a reference snapshot`이 capture한 bundle·entry·reference 실제 바이트와 metadata를 매번 대조한다. 이 capture는 iteration 이동과 portable handoff dependency closure에도 포함된다.
8. assembled context audit의 중복·충돌 후보를 전체 canonical corpus가 아니라 해당 시나리오에서 실제 로드한 source 집합으로 제한한다.
9. `decisions.jsonl`이 존재하면 artifact-root readiness와 handoff가 현재 Gate A/B 경로의 마지막 활성 결정 및 정확한 파일 SHA-256을 함께 확인한다. 승인 뒤 audit에서 provenance binding을 제거해도 과거 결정 hash와 달라지므로 통과하지 않는다.
10. Gate A capture의 논리 경로뿐 아니라 `reference-sources/`, `files/`, 개별 파일의 실경로를 검사한다. 외부 디렉터리를 가리키는 symlink를 capture처럼 사용하는 우회를 차단한다.
11. assembled 중복·충돌 진단을 provider별 실제 조립 context 안에서 수행한다. 같은 provider prompt에서 공존하는 중복은 유지해 보고하되, 서로 다른 provider mirror만 합쳐 만든 가짜 후보는 제외한다.
12. baseline의 measurement만 맞으면 서로 다른 시나리오나 provider 집합도 증감값을 내던 문제를 수정했다. 세 비교 축이 모두 같지 않으면 delta를 `null`로 두고 원인별 warning을 낸다.
13. reference route에 `providers`와 `provider_paths`를 추가하고 canonical skill·audit·parity checker가 같은 해석을 사용하게 했다. Gemini 생성기는 route의 command identity만 검증하며 command wrapper에서 canonical 실행 규칙의 중복을 제거하고 read-only 전달 경계만 남겼다.
14. Gate B usage가 `REF-n → LOCAL-n`만 검사하던 구조를 양방향 일대일 검증으로 강화했다. `supported_decision`도 허용된 prefix 문자열이 아니라 현재 spec에 실제로 존재하는 필드인지 확인한다.
15. audit의 report-wide `summary.promptBytes`를 단일 provider의 “실제 prompt”처럼 표현하던 오류를 고쳤다. CLI·schema·문서는 이를 unique resolved corpus로 명명하고 provider별 값은 `providers[]`에서 분리한다.
16. route manifest에 빠져 있던 필수/선택 의미를 `required` boolean으로 추가했다. Audit source와 Gemini generator·parity checker가 같은 값을 소비하고, BuildLore retrieval과 선택적 Markdown view는 모델 판단형 보조 자료로 구분한다.
17. 유효한 sibling reference bundle이 있어도 snapshot 없이 `p2a decide`가 Gate A를 승인하던 우회를 막았다. 신규 문서 기반 intake는 원본 `--entry`가 필수이고, snapshot의 entry·bundle hash가 현재 입력과 일치해야 한다. `p2a next --entry`도 승인 명령에 같은 경로를 전달하며 baseline 반복과 legacy 승인 사본 재바인딩은 호환 경로를 유지한다.
18. 프로젝트 내부 디렉터리 symlink를 통한 유효한 reference가 snapshot 재검증에서 사라지던 문제를 수정했다. 실경로는 confinement와 원본 바이트 읽기에 사용하고 bundle의 논리 경로는 portable capture 위치에 보존하며, 외부로 탈출하는 symlink는 계속 차단한다.
19. sibling `p2a-reference-bundle.json` 자체가 symlink나 디렉터리이면 regular file 검사를 통과하지 못하도록 했다. 이를 “선택 bundle 없음”으로 낮춰 snapshot binding 없이 Gate A를 승인하던 경로를 `validate --entry`와 `p2a decide --entry` 양쪽에서 차단한다.
20. canonical skill의 reference routing을 manifest의 load·required·stage·mode·provider·provider path·condition을 모두 포함하는 compact signature로 정규화했다. Context audit가 한 필드라도 다른 경우 error를 내고 CLI parity가 같은 audit를 실행하므로 Gemini만 갱신하고 Codex·Claude 의미를 남겨 두는 drift가 CI를 통과하지 않는다.
21. baseline 비교를 provider·skill·stage·path·condition identity 단위로 확장했다. Source 추가·제거, SHA-256 content 변경, load·required·condition·role·owner 변경과 0이 아닌 size delta는 warning이므로 `--strict`가 실패하며, 같은 바이트 길이의 instruction 변경 음성 fixture를 추가했다.
22. provider 자산 동기화는 기대 bytes와 이미 같은 파일을 다시 쓰지 않는다. 읽기 전용으로 제공된 동일한 generated surface 때문에 다른 변경 대상의 동기화까지 실패하지 않으면서 `--check`의 drift 검사는 유지한다.
23. Gemini command 생성기가 얇아진 wrapper 뒤에 canonical reference 경로·조건을 다시 붙이던 불일치를 제거했다. Wrapper에는 호출법과 read-only 전달 경계만 남기고, provider 제한으로 Gemini에 적용되지 않는 reference까지 포함해 어떤 canonical route 복제도 audit·parity가 거부한다.
24. context audit의 중복·충돌 후보가 실제 instruction 일부를 `preview`·`text`에 복사하던 문제를 수정했다. 현재 producer는 본문 대신 SHA-256 증거만 기록하고 후보별 source path·owner를 JSON과 human output에 표시한다.
25. 새 privacy 출력 때문에 역사적 `p2a.context_audit.v1` reader 호환성을 깨지 않도록 기존 `text` 필드 이름과 과거 문자열 허용은 유지했다. 새 owner 필드도 optional 확장으로 두고 현재 producer와 음성 fixture가 비노출·소유자 계약을 강제한다.
26. Codex A/B의 visual closeout 최초 판정 계약이 closeout 시점의 실행 mode·owner 값을 과도하게 한정해 올바른 core decision도 실패시키던 문제를 수정했다. 최초 계약과 grade를 보존한 채 허용값을 명시하고 양쪽 기존 결과를 동일한 deterministic 계약으로 재채점했다.

## 2. 구현 전 상태 진단

### 2.1 여섯 원칙과 P2A의 적합도

| 원칙 | 현재 강점 | 개선이 필요한 부분 | 판단 |
| --- | --- | --- | --- |
| 규칙보다 판단 | 적응형 실행이 작업 크기와 위험에 따라 실행 모드를 선택한다. | 여러 skill·agent 프롬프트가 세부 금지 규칙과 절차를 반복한다. | 부분 충족 |
| 예시보다 인터페이스 | CLI, JSON Schema, `p2a next`의 명령 객체가 모델에 명확한 조작면을 제공한다. | `next.state`는 아직 임의 문자열이고 일부 복구 조건은 프롬프트 설명에 의존한다. | 대체로 충족 |
| 점진적 공개 | 개발 실행 skill은 visual, acceptance, monitor, batch 참고 문서를 조건부로 읽는다. | canonical harness에는 `existing-documents`와 `buildlore-knowledge`의 명시적 라우팅이 없지만 Gemini wrapper에는 있다. | 부분 충족 |
| 반복 금지 | 일부 공통 규칙은 스키마와 코드로 이미 강제된다. | 동일한 승인·금지·검증 문구가 skill, agent, provider wrapper에 중복된다. | 개선 필요 |
| 자동 메모리 활용 | BuildLore는 재현 가능하고 이식 가능한 장기 지식 계약을 제공한다. | 공급자 자동 메모리와 공식 지식 저장소 사이의 책임 경계를 더 명확히 해야 한다. | 의도적으로 별도 유지 |
| 더 깊은 자료 제공 | 테스트, 스키마, HTML 프로토타입, 시각·접근성 증거, 해시 기반 lineage를 사용한다. | 최초 입력 계약은 읽을 수 있는 Markdown/text 문서에 치우쳐 있다. | 대체로 충족 |

### 2.2 정적 기준선

2026-08-15의 구현 전 기준점인 `main@e7c5adb`에서 수집한 정적 계측 결과는 다음과 같다.

- `.agents/skills`와 `.agents/agents`의 Markdown corpus: 1,512줄, 17,212단어, 127,656바이트
- 주요 skill 5개의 본문 합계: 888줄, 9,978단어, 73,654바이트
- 같은 corpus의 영어 금지 표현: `do not` 154회, `never` 36회
- 주요 skill 크기:
  - `p2a-harness`: 282줄 / 18,373바이트
  - `p2a-spec`: 187줄 / 14,937바이트
  - `p2a-dev-execution`: 198줄 / 21,561바이트
  - `p2a-task-author`: 122줄 / 8,182바이트
  - `p2a-visual-experience`: 99줄 / 10,601바이트

이 수치는 실제 한 번의 실행에 모두 주입되는 컨텍스트 크기가 아니다. 또한 금지 표현의 개수만으로 품질을 판단할 수 없다. 현재 값은 **실제 조립 컨텍스트와 중복을 계측해야 할 필요성**을 보여 주는 진단 신호로만 사용한다. 이 구현 전 snapshot은 `p2a.context_audit.v1` 도입 이전 값이므로 `--baseline` 입력으로 가장하지 않는다. 이후 비교는 동일한 측정·시나리오·provider 집합으로 저장한 전체 v1 보고서만 사용한다.

### 2.3 확인된 구조적 간극

1. **실제 컨텍스트를 볼 수 없다.** 파일 크기는 알 수 있지만 공급자·단계·실행 모드별로 어떤 문서가 실제 로드되는지 한 번에 확인할 수 없다.
2. **canonical 라우팅과 provider wrapper가 다르다.** [canonical harness skill](../.agents/skills/p2a-harness/SKILL.md)에는 두 참고 문서의 명시적 조건부 경로가 없지만 [Gemini harness wrapper](../.gemini/commands/p2a/harness.toml)에는 `existing-documents.md`와 `buildlore-knowledge.md`가 나열돼 있다.
3. **기계적 불변 조건이 자연어에도 반복된다.** approval, open decision, task graph, visual contract 규칙의 상당 부분은 [artifact validator](../scripts/validate_artifacts.mjs)와 CLI에서 이미 검증한다.
4. **다음 행동 인터페이스의 타입이 덜 엄격하다.** [next schema](../schemas/next.schema.json)는 command kind와 `requiresApproval`을 타입으로 보장하지만 `state`는 비어 있지 않은 문자열이면 된다.
5. **doctor가 컨텍스트 건강도를 진단하지 않는다.** [p2a doctor](../scripts/p2a_doctor.mjs)는 개발 환경을 확인하지만 중복, 충돌, wrapper drift, 항상 로드되는 문서 크기를 보고하지 않는다.
6. **풍부한 참고 자료가 진입 계약의 일급 요소는 아니다.** 구현 단계에서는 테스트·HTML·이미지를 사용하지만 최초 scope 입력은 주로 Markdown/text 문서 하나로 시작한다.

## 3. 반드시 유지할 경계

다음 항목은 프롬프트 다이어트 대상이 아니다. 표현의 중복은 줄일 수 있지만 계약 자체는 유지해야 한다.

- 제품 의미, 범위, 수용 기준에 대한 사람의 Gate 승인
- 외부 쓰기, 배포, 비용 발생, 권한 확대에 대한 명시적 승인
- workspace confinement와 소유권 경계
- canonical JSON, source hash, decision ledger, lineage
- 실행 가능한 검증 명령과 시각·접근성 증거
- 실패 증거의 보존과 재시도 이력
- 이식 가능한 BuildLore의 명시적 sync/retrieval 계약

원칙은 다음과 같다.

> 코드가 강제할 수 있는 불변 조건은 코드가 소유하고, 프롬프트는 목적·판단 기준·권한 경계·실패 시 복구 경로를 설명한다.

## 4. 개선 작업

### CE-001 — 실제 조립 컨텍스트 기준선 만들기 (P0)

Claude, Codex, Gemini별로 다음 정보를 수집하는 context inventory를 만든다.

- 단계: intake, Gate A, Gate B, Direct, Planned, Orchestrated, visual, review
- 실행 모드와 조건에 따라 로드되는 source path
- always-loaded / conditional / on-demand 구분
- 바이트 수와 토큰 추정치
- instruction owner: schema, CLI, hook, skill, agent, provider wrapper
- 동일 의미 중복, 충돌 가능성, stale path

권장 출력은 사람이 읽을 수 있는 표와 기계가 비교할 수 있는 JSON이다. 토큰 추정치는 모델별 tokenizer가 없을 때 근사치임을 표시한다.

완료 조건:

- 같은 시나리오에서 공급자별 로드 source 차이를 재현할 수 있다.
- 각 지시가 왜 로드되는지 조건을 추적할 수 있다.
- 비밀이나 실제 사용자 문서 본문을 보고서에 복사하지 않는다.
- 비교 기준선은 전체 schema-valid JSON으로 보존되고, 다른 측정·시나리오·provider 집합과는 수치 delta를 만들지 않는다.

### CE-002 — `p2a doctor`에 컨텍스트 진단 추가 (P0)

`p2a doctor --context` 또는 동등한 인터페이스를 추가한다.

진단 항목:

- 깨진 reference와 사용되지 않는 reference
- canonical skill과 provider wrapper의 drift
- 동일한 기계적 규칙의 반복
- 서로 충돌하는 지시 후보
- always-loaded context의 크기 변화
- conditional reference가 무조건 로드되는 회귀

doctor는 자동 삭제 도구가 아니라 advisory 도구로 둔다. 제안마다 근거 source와 소유자를 표시하고, 수정은 별도 리뷰를 거친다.

### CE-003 — canonical reference routing 통합 (P0)

공급자별 wrapper가 독자적으로 참고 문서를 결정하지 않도록 canonical route manifest를 정의한다.

최소 필드:

- reference 경로
- 로드 조건
- 적용 단계와 실행 모드
- 필수/선택 여부
- 공급자 제한 또는 대체 경로

먼저 `p2a-harness`의 `existing-documents.md`와 `buildlore-knowledge.md` 불일치를 수정한다. 이후 Claude/Codex/Gemini wrapper는 canonical metadata에서 생성하거나 parity test로 동등성을 강제한다. wrapper에는 호출 방법과 실제 공급자 제약만 남긴다.

완료 조건:

- 동일 시나리오의 의미상 reference 집합이 공급자마다 일치한다.
- canonical route 변경 시 wrapper drift가 CI에서 실패한다.
- 조건부 문서는 해당 조건이 참일 때만 로드된다.

### CE-004 — 상위 skill을 얇은 라우터로 재구성 (P1)

한 번에 전체 skill을 재작성하지 않고, 사용량이 큰 skill부터 하나씩 분리한다.

1. `p2a-harness`
2. `p2a-dev-execution`
3. `p2a-spec`
4. `p2a-task-author`
5. `p2a-visual-experience`

상위 `SKILL.md`에는 다음만 남기는 것을 목표로 한다.

- skill의 목적과 trigger
- 입력·출력 계약
- 모델이 판단해야 하는 핵심 기준
- 권한과 안전 경계
- 조건부 reference routing
- 성공·Gate-return·실패 종료 상태

세부 절차, 드문 예외, 공급자별 사용법, 긴 명령 예시는 reference 또는 CLI help로 이동한다. 초기 관측 목표는 주요 라우터 본문을 약 100줄 안팎으로 줄이거나 always-loaded 바이트를 30% 이상 낮추는 것이지만, **최종 통과 기준은 줄 수가 아니라 품질 비저하와 안전성**이다.

### CE-005 — 자연어 규칙의 기계적 소유권 이전 (P1)

반복되는 각 규칙을 다음 다섯 범주로 분류한다.

1. 기계적 불변 조건
2. 안전·권한 경계
3. 제품별 예외 또는 gotcha
4. 모델의 상황 판단 기준
5. 중복되거나 현재 모델에 자명한 안내

처리 원칙:

- 1번은 schema, validator, CLI preflight, hook 중 하나가 강제한 뒤 프롬프트에는 권위 source와 복구 방법만 남긴다.
- 2번은 항상 보존하되 한 canonical 위치에서 참조한다.
- 3번은 해당 상황에서만 점진적으로 공개한다.
- 4번은 금지 목록보다 목표, trade-off, 판단 증거를 설명한다.
- 5번은 A/B 평가 후 제거한다.

코드가 아직 강제하지 못하는 규칙을 문서에서 먼저 제거해서는 안 된다.

### CE-006 — 상태 기반 인터페이스 강화 (P2)

인자 없는 `p2a next --json`은 기존 strict `p2a.next.v1` 계약을 그대로 반환한다. 강화된 상태 인터페이스가 필요한 consumer는 `p2a next --contract v2 --json`을 명시하며, 별도 `p2a.next.v2` schema가 다음을 보장한다.

- enum으로 제한된 안정적인 `state`와 `reasonCode`
- Gate-return과 user approval의 명확한 구분
- 사람이 볼 display와 에이전트가 실행할 argv의 분리 보장
- 명시적인 schema version

v1 schema나 응답에 새 필드를 추가하지 않는다. consumer migration은 opt-in v2에서 진행하며, v1 제거 여부는 별도 deprecation 결정으로 다룬다.

### CE-007 — 메모리 책임 경계 문서화 (P2)

공급자 자동 메모리는 세션 편의 기능으로 활용하되 canonical 사실의 유일한 저장소로 사용하지 않는다.

- 자동 메모리: 일시적 선호, 반복 작업의 편의, 비공식 힌트
- BuildLore: 검토된 프로젝트 지식, 출처와 상태가 있는 이식 가능한 기록
- Gate artifact: 승인된 objective, scope, acceptance, authority의 최종 기준

자동 메모리의 내용이 Gate artifact나 repository evidence와 충돌하면 후자를 우선한다. BuildLore sync와 Git publish는 계속 명시적 권한을 요구한다.

### CE-008 — 풍부한 입력 reference bundle과 Gate provenance (P2)

사람이 승인할 수 있는 간결한 scope 문서는 유지하면서 다음 자료를 선택적 reference로 연결할 수 있게 한다.

- HTML 또는 기존 화면
- 실행 가능한 테스트와 fixture
- API schema와 sample payload
- 디자인 토큰과 이미지
- rubric 또는 평가 데이터
- 기존 구현의 특정 코드 경로

대용량 자료를 전부 프롬프트에 삽입하지 않고 다음의 versioned 계약으로 provenance를 보존한다.

- entry의 `p2a-reference-bundle.json`: reference kind, path, hash, `load_when`
- Gate A의 `reference-bundle-snapshot.json`: 승인된 entry와 reference metadata의 exact hash snapshot
- Gate B의 `reference-bundle-usage.json`: 실제 확인한 reference, 지원한 결정, LOCAL evidence의 일대일 연결

승인 기록에는 sidecar 경로와 SHA-256을 함께 묶는다. iteration 초기화와 portable handoff가 경로를 바꿀 때 sidecar 참조와 hash를 함께 재작성하고, 최종 artifact validator가 전체 연결을 다시 검증한다. Gate B가 reference를 사용하지 않았다면 빈 usage를 명시해 비사용 역시 재현 가능하게 남긴다.

Validator는 usage에 적힌 `REF-n → LOCAL-n`뿐 아니라 capture된 선언 reference를 가리키는 모든 `LOCAL-n → REF-n`도 정확히 한 번 연결됐는지 확인한다. 각 `supported_decision`은 현재 Gate B spec에 존재하는 구조화된 필드 경로여야 한다.

### CE-009 — 공급자 교차 평가와 단계적 출시 (P0 release gate)

각 구조 변경은 독립적으로 평가한다. 여러 변경을 한꺼번에 묶어 결과 원인을 알 수 없게 만들지 않는다.

최소 시나리오:

| 시나리오 | 확인할 위험 |
| --- | --- |
| Gate A intake | 질문 누락, 기존 문서 오판, 과도한 질문 |
| Gate B spec | scope·non-goal·acceptance 손실 |
| Direct 실행 | 불필요한 task graph 생성, 권한 초과 |
| Planned 실행과 재시도 | checkpoint 누락, 실패 증거 손실 |
| Orchestrated batch | dependency·ownership·isolation 회귀 |
| 전체 visual flow | 프로토타입 승인, screenshot, accessibility 증거 누락 |

대상 공급자와 대표 모델 profile마다 baseline/candidate를 시나리오당 각각 3회 이상 실행해 비결정성을 분리한다. 공급자나 profile을 실행할 수 없으면 해당 coverage를 완료로 간주하지 않는다.

## 5. 평가 기준

### 5.1 일차 통과 기준

- acceptance 충족률이 기준선보다 낮아지지 않는다.
- 승인 우회, 권한 초과, workspace 이탈이 0건이다.
- Gate-return이 필요한 실패를 임의 구현으로 진행하지 않는다.
- visual 계약이 있는 작업에서 시각·접근성 증거 누락이 0건이다.
- 실패·재시도·중단 증거의 lineage가 유지된다.
- Claude, Codex, Gemini wrapper가 같은 canonical 의미를 제공한다.

### 5.2 이차 개선 지표

- 실제 always-loaded input bytes와 추정 token
- 중복 instruction cluster 수
- provider call 수와 tool retry 수
- validator retry와 user correction 수
- 첫 시도 acceptance 통과율
- 전체 elapsed time
- 잘못된 실행 모드 선택률

초기 목표는 품질을 유지하면서 중복 cluster를 50% 이상, 대표 시나리오의 always-loaded context를 30% 이상 줄이는 것이다. 기준선 측정 결과에 따라 목표치는 조정할 수 있으며, 숫자를 맞추기 위해 안전·권한 지시를 삭제하지 않는다.

### 5.3 기존 평가의 활용 한계

[Gate-driven adaptive execution proposal](../docs/gate-driven-adaptive-execution-proposal.md)의 기존 7개 fixture 비교에서는 상세 task 방식과 objective 중심 방식 모두 acceptance 7/7을 기록했고, objective 중심 방식은 task 수 53.3%, provider call 34.6%, input token 51.2%, output token 42.6%, elapsed time 44.1% 감소를 보였다.

이는 방향성 기준선으로는 유용하지만 다음 이유로 최종 증거로 사용하지 않는다.

- 단일 모델 profile 중심이다.
- fixture당 비교 실행 수가 적다.
- 전체 production lifecycle을 모두 포함하지 않는다.
- raw provider evidence가 repository에 버전 관리되지 않는다.

### 5.4 CE-009 실행·증거 프로토콜

CE-009는 repository 회귀 테스트의 별칭이 아니라 **동일한 입력과 판정 계약을 실제 provider 실행에 적용하는 별도 release gate**다. 다음 절차를 모두 충족하기 전에는 전체 provider rollout을 `go`로 기록하지 않는다.

1. CE-001~008의 논리 변경 단위를 한 번에 하나만 candidate로 활성화한다. Candidate source는 기록된 baseline commit에 해당 변경 하나만 적용한 상태여야 하며, fixture, project config, provider, model profile, tool 권한과 review policy는 동일하게 유지한다. 양쪽의 실제 commit SHA와 tree hash를 모두 기록한다.
2. §4의 최소 6개 시나리오를 baseline/candidate 양쪽에서 실행한다. 실행 가능한 각 provider/profile은 시나리오당 최소 3회 반복하며, 반복 번호를 명시한다. Provider/profile 집합이나 반복 수가 다르면 수치 평균과 개선률을 계산하지 않는다.
3. 각 실행은 production Gate·run lifecycle을 사용하고 `agentTool`, `mode`, `selectionRationale`, `executionEnvelope`, verification, retry/close evidence, `telemetryProtocol`, provider-source usage sample과 interruption을 보존한다. `usage.modelProfile`은 `<provider>/<model>/<profile>`처럼 provider까지 구분되는 안정된 라벨을 사용한다.
4. Baseline과 candidate 각각에 `p2a eval generate`와 `p2a eval digest`를 실행하고, `p2a eval compare`로 두 run set의 회귀 신호를 별도 생성한다. 현재 digest는 하나의 source context만 집계하므로 공통 상위 디렉터리에서 한 번만 실행해 양쪽 지표를 합친 것으로 취급하면 안 된다. Pair 비교 보고서는 양쪽 digest, compare 결과와 context audit를 함께 참조해 acceptance coverage, first-pass, rework, integration/visual drift, scope/rule violation, Gate-return precision, elapsed time, verification completeness와 token usage의 실행별 값과 aggregate를 구분한다. Context 입력은 각 source checkout에서 같은 시나리오의 `p2a doctor --context --json`으로 별도 보존한다.
5. Raw evidence는 `plans/evidence/context-engineering/<CE-nnn>/<baseline|candidate>/<scenario>/<provider>/<model-profile>/run-<nn>/` 아래에 둔다. 최소 보존물은 실행한 commit SHA, fixture와 config hash, provider/CLI/model profile, 반복 번호, run/eval/context artifact의 repository-relative path와 SHA-256, 실제 command exit code다. Provider transcript, credential, secret, entry 본문이나 사용자 문서 본문은 복사하지 않는다.
6. Baseline/candidate 비교 보고서는 실행별 결과와 aggregate를 분리한다. 평균만으로 실패를 숨기지 않고 각 반복의 hard-gate 위반을 그대로 표시하며, unavailable provider/profile은 `skipped`가 아니라 명시적 coverage blocker로 기록한다.
7. Rollout 결정은 `go`, `provider_limited`, `no_go` 중 하나다. §5.1 위반이 한 건이라도 있으면 `no_go`다. 이용 가능한 provider만 통과하고 다른 provider 증거가 없으면 `provider_limited`이며 전체 provider 지원을 완료로 표시하지 않는다. 모든 대상 provider/profile에서 §5.1을 통과하고 §5.2의 비교 가능 조건을 만족할 때만 `go`다.

Provider 실행 전후의 최소 명령 형태는 다음과 같다. `<scenario-args>`와 artifact 경로는 같은 pair에서 동일해야 한다.

```bash
node scripts/p2a.mjs doctor --context <scenario-args> --json
node scripts/p2a.mjs eval generate --artifacts <baseline-artifact-root> --output <eval-dir>/baseline --json
node scripts/p2a.mjs eval generate --artifacts <candidate-artifact-root> --output <eval-dir>/candidate --json
node scripts/p2a.mjs eval digest --eval <eval-dir>/baseline --output <eval-dir>/baseline-digest.json --json
node scripts/p2a.mjs eval digest --eval <eval-dir>/candidate --output <eval-dir>/candidate-digest.json --json
node scripts/p2a.mjs eval compare --baseline <baseline-artifact-root> --candidate <candidate-artifact-root> --output <eval-dir>/compare.json --json
node scripts/validate_artifacts.mjs --artifact-root <baseline-artifact-root>
node scripts/validate_artifacts.mjs --artifact-root <candidate-artifact-root>
```

현재 repository의 통과한 tests와 fixture는 이 protocol을 실행하기 위한 구조적 전제 증거이며 provider trial을 대신하지 않는다. 사용자 승인을 받아 실행한 [Codex aggregate behavioral A/B](./evidence/context-engineering/CE-009/codex/README.md)는 6개 시나리오에서 baseline/candidate 각각 18/18을 통과했지만, CE-001~008을 합친 synthetic 평가이고 production Gate/run lifecycle을 사용하지 않았다. Claude와 Gemini 결과도 없으므로 CE-009 rollout 상태는 **`provider_limited`**다. 변경 단위별 production 실행과 나머지 provider 증거를 갖추기 전에는 `go`로 올리지 않는다.

## 6. 실행 순서

| 순서 | 작업 | 선행 조건 | 결과물 |
| --- | --- | --- | --- |
| 1 | CE-001 기준선 | 없음 | context inventory와 비교 가능한 JSON |
| 2 | CE-002 doctor 진단 | CE-001 | `p2a doctor --context` 및 fixture |
| 3 | CE-003 routing 통합 | CE-001 | canonical manifest와 parity test |
| 4 | CE-004/005 skill 슬림화 | CE-002, CE-003 | skill별 작은 변경과 A/B 결과 |
| 5 | CE-006 typed interface | CE-005 | strict v1 유지와 opt-in `p2a.next.v2` 계약 |
| 6 | CE-007/008 knowledge·reference | CE-003 | 책임 경계와 Gate A/B source provenance 계약 |
| 7 | CE-009 release gate | 각 변경마다 반복 | 비교 보고서와 rollout 결정 |

출시용 변경 이력은 이 표의 논리 단위로 분리할 수 있어야 한다. 한 skill에서 회귀가 생기면 전체 개선을 되돌리지 않고 해당 단계만 rollback할 수 있어야 한다.

현재 작업트리의 구현은 아직 이 논리 단위로 commit이 분리되지 않았다. 이는 기능 완료를 뜻하는 CE-001~008과 별개의 릴리스 준비 항목이며, PR/릴리스 전에 변경 이력을 분리하거나 그에 준하는 검토 가능한 commit 구성을 만들어야 한다.

## 7. 검증 명령

구현 단계에서는 최소한 다음 검증을 유지한다.

```bash
npm test
npm run test:package
npm run test:full
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
node scripts/p2a.mjs doctor --context --strict
node scripts/p2a.mjs doctor --context \
  --skill p2a-dev-execution --stage execution --mode orchestrated \
  --condition reference:p2a-dev-execution:references/batch-execution.md \
  --baseline plans/context-engineering-orchestrated-batch-baseline.json --strict
git diff --check
```

검증 coverage:

| 항목 | 현재 coverage |
| --- | --- |
| provider wrapper parity | canonical route 기반 생성·`--check`, Claude mirror 및 Gemini adapter drift 음성 fixture, canonical skill compact signature의 load·필수/선택·stage·mode·condition·provider 제한·대체 경로 검증과 얇은 Gemini read-only wrapper 검증 |
| conditional reference load/no-load | route schema의 명시적 load type/required/condition/provider/provider path 일치와 audit source 보존 검증; Codex aggregate A/B에서 조건부 reference 판단의 hard gate를 통과했으나 변경 단위별 production 평가는 대기 |
| context audit 정렬·schema | `context-audit.test.mjs`의 top-level·nested route schema 음성 fixture, provider/stage 정렬, inventory/assembled 시나리오, provider별 중복·충돌 분리, mode·condition, 후보 본문 비노출과 source·owner 증거, 동일성 검증 후 source set·SHA·route metadata·size baseline 비교, 같은 크기 content drift strict 실패, 선택 provider scaffold fixture |
| versioned `p2a next` 호환성 | 인자 없는 strict v1 응답의 무변경과 opt-in v2의 enum `state`·필수 `reasonCode`를 전체 next state test에서 검증 |
| schema `$ref` 강제 | local JSON Pointer `$ref`를 재귀 해석하고 잘못된 v2 state와 중첩 context mode를 validator 음성 test에서 거부 |
| reference bundle lineage | 신규 Gate A `--entry` preflight와 snapshot 누락 차단, sibling bundle symlink/비정규 파일 거부, entry·bundle hash, Gate B usage와 REF↔LOCAL 양방향 일대일 연결, 실제 spec 결정 경로, 결정 원장의 현재 Gate 파일 hash binding, 내부 reference symlink 논리 경로 보존·외부 실경로 confinement, iteration init과 portable handoff 후 재검증 |
| prompt 축소 전후 scenario | repository 401개 회귀와 package/fixture gate 통과; Codex aggregate A/B는 양쪽 18/18, uncached input -4.45%, 총 input +8.54%, elapsed +11.59%이며 전체 CE-009는 `provider_limited` |
| BuildLore와 provider memory 우선순위 | canonical precedence를 skill·하네스 문서에 고정; Codex synthetic 판단은 통과했지만 provider 자동 메모리를 재현하는 production live 평가는 대기 |

## 8. 비목표

- v0.3.0의 adaptive execution을 다시 설계하지 않는다.
- 사람의 Gate 승인을 모델 판단으로 대체하지 않는다.
- 특정 공급자의 자동 메모리를 P2A의 필수 의존성으로 만들지 않는다.
- 임의의 프롬프트 삭제 비율 자체를 성공 기준으로 삼지 않는다.
- 역사적 schema와 archived evidence reader의 호환성을 불필요하게 깨지 않는다.
- 이 계획의 미구현 항목을 v0.3.0 CHANGELOG에 완료된 기능처럼 기록하지 않는다.

## 9. 참고 자료

- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [검토 대상 YouTube 영상](https://www.youtube.com/watch?v=TWo-lXNbcws)
- [P2A harness specification](../docs/harness-spec.md)
- [P2A supervised execution](../docs/supervised-execution.md)
- [P2A entry contract](../docs/entry-contract.md)
- [P2A CLI reference](../docs/cli-reference.md)
