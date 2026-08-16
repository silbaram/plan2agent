# CE-009 Codex aggregate A/B evidence

## 판정

2026-08-15에 `gpt-5.6-luna` / `medium` profile로 실행한 aggregate behavioral A/B의 판정은 **`provider_limited`**다.

- Gate A intake, Gate B spec, Direct 실행, Planned 재시도, Orchestrated batch, visual closeout의 6개 시나리오를 baseline/candidate 각각 3회 실행했다.
- Baseline 18/18, candidate 18/18이 계약의 hard gate를 통과했다. Candidate의 품질 회귀, 승인 우회, 권한 초과, 필수 lineage·verification·visual evidence 누락은 관찰되지 않았다.
- Codex 한 provider의 합산 변경 평가이므로 CE-009 전체 release gate의 `go` 증거는 아니다. Claude/Gemini, 변경 단위별 격리, production Gate/run lifecycle 평가는 남아 있다.

기계 판독 가능한 집계는 [`codex-ab-summary.json`](./codex-ab-summary.json), 판정 계약은 [`contract.json`](./contract.json), 출력 계약은 [`result.schema.json`](./result.schema.json)에 있다.

## 실행 범위와 재현 식별자

| 항목 | 값 |
| --- | --- |
| Provider / model / profile | Codex / `gpt-5.6-luna` / `medium` |
| Codex CLI | `0.147.0` |
| 반복 행렬 | 6 scenarios × 2 variants × 3 repetitions = 36 runs |
| Baseline | `main@e7c5adb38312a562f3840588de561b42c64407ae` |
| Baseline snapshot SHA-256 | `e56550d96c2fccc802827aa9dcc53b4f39c0cc4918823af6478254fd47c135c5` |
| Candidate base | `e7c5adb38312a562f3840588de561b42c64407ae` + 현재 CE-001~008 작업트리 |
| Candidate snapshot SHA-256 | `d27895003e6174faa330b136a36bcfd111dd13b3a5c03638b8de1516c42a97df` |
| Candidate tracked patch SHA-256 | `17dd17c6511997549e145754bbdea2e15b178ac72852398fb5f2e6a5f08d96fd` |
| Candidate untracked manifest SHA-256 | `0ba1ad5639497a0fab5089bca01bd189cbb4a34b4bc63b46b7c75f9938fe3de9` |
| Contract SHA-256 | `650ddbf21d817e475cd7020b68e9a6ddb745a743c2f97b28025902c4ca407f83` |
| Output schema SHA-256 | `b41855783906c4c651027abc8f05aa7ef009625e72ec4cbacaaedf989c091c43` |

양쪽 snapshot은 같은 synthetic fixture, 출력 schema, read-only sandbox, network-disabled 지시와 model profile을 사용했다. Provider JSONL transcript와 credential은 저장하지 않고 결과·grade·실행 metadata와 그 hash만 보존했다.

## 집계 결과

| 지표 | Baseline | Candidate | 변화 |
| --- | ---: | ---: | ---: |
| Hard-gate 통과 | 18/18 | 18/18 | 동일 |
| 총 input token | 751,804 | 816,024 | +64,220 (+8.54%) |
| cached input token | 457,472 | 534,784 | +77,312 |
| uncached input token | 294,332 | 281,240 | -13,092 (-4.45%) |
| output token | 16,370 | 18,744 | +2,374 (+14.50%) |
| elapsed | 419,834 ms | 468,486 ms | +48,652 ms (+11.59%) |
| tool call | 28 | 36 | +8 (+28.57%) |
| tool failure | 0 | 1 | +1 |

Candidate는 정적 always-loaded surface와 실제 uncached input을 줄였지만, 조건부 reference를 도구로 읽는 왕복이 늘어 cumulative cached input, output, elapsed time과 tool call은 증가했다. 따라서 이 실행은 **품질 유지와 초기 컨텍스트 축소**는 뒷받침하지만 **총 token·비용·시간 개선**을 입증하지 않는다. 특히 Direct 시나리오는 총 input이 66%, 시간이 37%, tool call이 5회 늘어 후속 최적화 관찰 대상이다. 한 번의 read-only tool failure는 최종 hard gate와 CLI exit를 깨뜨리지는 않았지만 retry 비용 신호로 유지한다.

| 시나리오 | Baseline | Candidate | 총 input 변화 | uncached input 변화 | elapsed 변화 | tool call 변화 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Gate A intake | 3/3 | 3/3 | -32% | +6% | -13% | -2 |
| Gate B spec | 3/3 | 3/3 | +19% | -17% | +27% | +2 |
| Direct execution | 3/3 | 3/3 | +66% | -2% | +37% | +5 |
| Planned retry | 3/3 | 3/3 | +25% | -9% | +22% | +2 |
| Orchestrated batch | 3/3 | 3/3 | -1% | +28% | +4% | +1 |
| Visual closeout | 3/3 | 3/3 | -16% | -23% | -8% | 0 |

## 증거 무결성

- 각 quality run은 `result.json`, deterministic `grade.json`, `metadata.json`을 가진다. Metadata에는 source·fixture·prompt·contract·schema hash, model profile, exit code, usage, duration과 tool count가 있다.
- Visual closeout의 최초 계약에서 closeout 시점에 허용되는 `executionMode`와 `ownerCount` 범위가 모호했다. Core decision은 맞았지만 양쪽에 불필요한 hard failure를 만들었으므로 허용값을 명시한 뒤 모든 기존 결과를 동일 규칙으로 로컬 재채점했다. 최초 계약과 grade는 [`contract.initial-hard-fields.json`](./contract.initial-hard-fields.json)과 각 run의 `grade.initial.json`으로 보존했다.
- Schema/API와 계약을 조정한 smoke 실행은 quality 반복과 섞지 않고 [`../preflight/`](../preflight/)에 보존했다.
- Runner는 기존 evidence가 있으면 provider를 다시 호출하지 않고 summary만 재생성할 수 있다. `--regrade`는 원래 결과를 변경하지 않고 deterministic grade만 다시 계산한다.

## 저장소 검증

| 검증 | 결과 |
| --- | --- |
| `npm test` | 제한 sandbox에서는 400/401. 유일한 실패는 localhost test server의 `listen EPERM`; 같은 테스트를 listen이 허용된 환경에서 재실행해 1/1 통과 |
| `npm run test:package` | 8/8 통과 |
| `npm run test:full` | 통과 |
| `node scripts/sync_cli_assets.mjs --check` | 통과 |
| `node scripts/check_cli_parity.mjs` | 통과 |
| `node scripts/p2a.mjs doctor --context --strict` | warning/failure 0, 통과 |
| Orchestrated assembled context baseline `--strict` | source·route·size zero-delta, 통과 |
| Runner syntax / evidence integrity | syntax 통과; quality result·grade·metadata 각 36개, summary hash reference 36개 일치, transcript file 0개 |
| `git diff --check` | 통과 |

Sandbox의 단일 실패는 assertion 회귀가 아니라 socket bind 권한 제한이다. 실패한 명령과 재실행 결과를 모두 판정에 포함했으며, 전체 suite가 한 번에 성공한 것으로 바꾸어 기록하지 않는다.

## 한계와 후속 조건

이번 결과만으로 계획 전체를 완료 처리하지 않는다.

1. Candidate가 CE-001~008을 합친 dirty snapshot이어서 변경별 인과를 분리하지 못한다.
2. Synthetic 판단 시나리오이며 실제 `p2a eval generate/digest/compare`를 포함한 production lifecycle 실행이 아니다.
3. Claude와 Gemini coverage가 없어 전체 provider rollout은 `provider_limited`다.
4. Candidate commit/tree가 아직 없으므로 release 전에는 검토 가능한 commit 구성으로 고정해야 한다.
5. 성능 후속 평가는 Direct의 reference/tool routing을 우선 관찰하되, 수치를 맞추기 위해 안전 경계나 필요한 reference를 삭제해서는 안 된다.
