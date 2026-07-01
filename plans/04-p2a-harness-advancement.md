# P2A 하네스 고도화 아이디어

작성일: 2026-07-01 · 상태: 아이디어 정리 · 참고 소스: `/Users/qoo10/projects/agents-cli`, `/Users/qoo10/projects/plan2agent-memory`

이 문서는 `google/agents-cli`의 로컬 클론을 검토한 뒤, Plan2Agent(P2A) 하네스 고도화에 참고할 만한 제품/운영 아이디어를 정리한다. 목적은 `agents-cli`의 ADK 기능을 그대로 가져오는 것이 아니라, coding agent를 잘 움직이게 만드는 라이프사이클형 CLI/skill 운영 패턴을 P2A에 맞게 흡수하는 것이다.

## 1. 핵심 판단

`agents-cli`의 핵심 가치는 개별 기능보다 "coding agent가 따라야 할 단계별 운영 표면"에 있다. `workflow`, `scaffold`, `eval`, `deploy`, `publish`, `observability` 스킬을 분리하고, 각 단계에서 어떤 스킬과 명령을 사용해야 하는지 명확히 고정한다.

P2A는 이미 Gate A-D, iteration, task graph, run log, proposal, handoff 구조가 더 깊게 구현되어 있다. 따라서 P2A가 가져올 부분은 기획 게이트 자체보다 다음 영역이다.

- 설치, 진단, 업그레이드, drift 확인을 하나의 표준 CLI 표면으로 묶는 방식
- agent 실행 결과를 평가하고 비교하는 품질 루프
- run, artifact, task, review, proposal을 관측 가능한 history로 만드는 방식
- Memory 서버를 장기 artifact store와 검색/회고 backend로 연결하는 방식
- agent가 흔히 생략하는 단계를 막는 shortcut guard

즉, P2A 고도화의 다음 축은 "더 많은 문서를 생성하는 하네스"가 아니라 "기획, 실행, 평가, 회고, 저장이 한 바퀴로 닫히는 하네스"다.

## 2. `agents-cli`에서 참고할 패턴

### 2.1 단계별 skill bundle

`agents-cli`는 하나의 거대한 지침 대신 라이프사이클별 skill을 나눈다.

| 영역 | agents-cli 패턴 | P2A 적용 아이디어 |
| --- | --- | --- |
| workflow | 전체 개발 단계와 재진입 규칙 | `p2a-workflow` 또는 `p2a-harness`를 상위 orchestration 문서로 유지 |
| scaffold | create/enhance/upgrade 분리 | `p2a_handoff scaffold`를 setup/enhance/upgrade 명령면으로 정리 |
| develop/code | 코드 보존, 실행 경계, 디버깅 규칙 | `p2a-dev-execution`, implementer/monitor/orchestrator skill과 provider config 고도화 |
| eval | generate/grade/compare/analyze/optimize | `p2a_eval`로 task/run/spec 품질 평가 루프 설계 |
| deploy/publish | 명시 승인 후 실행 | P2A도 코드 변경, PR, Memory push 같은 외부 효과 작업에 승인 audit 유지 |
| observability | trace/log/analytics tier 구분 | P2A Memory를 artifact/run/proposal observability backend로 사용 |

P2A의 기존 skill 구조는 이미 CLI별 mirror와 role 분리가 있다. 다음 개선은 skill을 더 늘리는 것보다, 사용자가 "지금 어떤 명령을 실행해야 하는지"를 찾기 쉽게 하는 top-level command surface가 중요하다.

### 2.2 `setup/info/update/doctor` 계열

`agents-cli`는 설치와 상태 확인을 명령으로 노출한다. P2A도 아래 명령면이 필요하다.

| 후보 명령 | 목적 |
| --- | --- |
| `p2a setup` | 대상 프로젝트에 `.plan2agent`, schemas, scripts, skills, agents를 설치 |
| `p2a info` | active project, active iteration, Gate 상태, task/run 요약, toolkit version 출력 |
| `p2a update` | scaffolded 프로젝트의 scripts/schemas/skills를 최신 toolkit 기준으로 갱신 |
| `p2a doctor` | 누락 파일, schema drift, CLI mirror drift, Memory 연결, Node/Docker/git 상태 진단 |
| `p2a upgrade --dry-run` | 변경될 파일, 충돌, 보존해야 할 local artifact를 미리 보여줌 |

현재 P2A는 `p2a_handoff.mjs`, `p2a_iteration.mjs`, `p2a_tasks.mjs`, `p2a_runs.mjs`, `validate_artifacts.mjs`, `check_cli_parity.mjs`가 기능별로 존재한다. 고도화 방향은 새 기능 추가보다 이들을 감싸는 "첫 진입 명령"을 만드는 것이다.

### 2.3 Prototype-first / enhance 패턴

`agents-cli`는 처음부터 full deployment를 강제하지 않고 prototype으로 시작한 뒤 enhance로 확장한다. P2A도 같은 사고방식이 맞다.

P2A 적용:

- `scaffold`: 최소 파일 기반 하네스 설치
- `enhance memory`: Plan2Agent Memory 동기화 설정 추가
- `enhance gui`: GUI local config와 project metadata 연결
- `enhance orchestration`: PTY/supervised run 설정 추가
- `enhance proposals`: proposal mining, review, curation queue 활성화
- `enhance dev-skills`: provider별 implementer/monitor/orchestrator skill, role profile, execution policy 갱신

이렇게 나누면 작은 프로젝트는 planning/task/run만 쓰고, 필요한 시점에 Memory, GUI, orchestration을 붙일 수 있다.

### 2.4 `/Users/qoo10/projects/agents-cli` 재검토 적용 매핑

재검토 기준은 `/Users/qoo10/projects/agents-cli`의 `f3a132a release v0.6.1 at 2026-06-28`이다. README, release notes, `workflow/scaffold/eval/observability/adk-code` skill을 다시 확인한 결과, P2A에 그대로 옮길 대상은 Google ADK 기능이 아니라 "agent가 매번 같은 순서로 안전하게 개발, 검증, 업그레이드하도록 만드는 운영 계약"이다.

새로 적용할 후보:

| agents-cli에서 확인한 패턴 | P2A 적용 아이디어 | 우선순위 |
| --- | --- | --- |
| `setup`, `info`, `update`가 설치/상태/재설치를 표준 명령으로 제공 | `p2a setup/info/update/doctor`를 top-level 진입점으로 만들고, 실패 시 non-zero exit와 구체적 실패 사유를 출력 | P1 |
| `scaffold create/enhance/upgrade --dry-run`으로 신규/기존/업그레이드 흐름 분리 | `p2a scaffold`, `p2a enhance <capability>`, `p2a upgrade --dry-run`으로 하네스 설치와 확장을 분리 | P1 |
| strict programmatic mode로 필수 인자를 침묵 보정하지 않음 | P2A 명령도 필수 결정이 빠지면 UsageError 또는 Gate blocker로 멈추고, agent가 임의 기본값을 만들지 않게 함 | P1 |
| release notes에서 `update` 실패를 성공처럼 보이던 문제를 수정 | P2A update/upgrade/memory push도 부분 실패를 성공으로 포장하지 않고 실패 asset 목록과 복구 명령을 남김 | P1 |
| `run` footer가 copy-paste 가능한 resume command를 출력 | `p2a_runs start/finish`와 GUI supervised run footer에 `resume`, `status`, `finish`, `review` 명령을 출력 | P2 |
| `agents-cli-manifest.yaml`로 언어 독립 manifest와 config migration 제공 | `.plan2agent/project.config.json`과 후보 `dev.config.json`에 schemaVersion, toolkitVersion, migration preview를 추가 | P2 |
| scaffold reference project를 `/tmp`에 만들어 필요한 파일만 비교 | `p2a scaffold reference --capability <x>` 또는 `p2a upgrade --dry-run --reference`로 대상 프로젝트를 건드리기 전 diff 확인 | P2 |
| Quality Flywheel이 dataset -> generate -> grade -> analyze -> optimize를 반복 | `p2a_eval generate/grade/compare/analyze/digest`로 spec/task/run/proposal 품질 루프를 구축 | P2 |
| observability를 trace, prompt-response log, analytics, third-party tier로 구분 | P2A Memory에 trace/content/analytics/search tier를 두고 GUI가 같은 계층으로 보여주게 함 | P2 |
| skill phase마다 관련 skill을 다시 읽으라고 명시 | P2A도 Gate/Run/Review 전환 시 필요한 skill과 source artifact를 `p2a info`와 run prompt에 명시 | P2 |

이미 P2A에 있으나 고도화할 자산:

| P2A 현재 자산 | agents-cli에서 얻은 보강점 | 고도화 방향 |
| --- | --- | --- |
| Gate A-D와 `.plan2agent` 산출물 | `.agents-cli-spec.md`를 primary source로 삼는 단순한 진입 규칙 | JSON 정본은 유지하되 `p2a info`가 active intent/spec/task/run의 source of truth를 한 화면에 표시 |
| `p2a_handoff scaffold` | create/enhance/upgrade의 명확한 사용자 mental model | 현재 scaffold를 capability 단위 enhance/upgrade 명령으로 분해하고 dry-run을 기본 검토 경로로 둠 |
| `validate_artifacts.mjs`, `check_cli_parity.mjs` | 사용자가 먼저 실행할 수 있는 `info/doctor` 표면 | 개별 검증 스크립트를 `p2a doctor` 아래에 묶고 GUI Overview가 결과 JSON을 재사용 |
| canonical `.agents`와 provider mirror | setup/update가 여러 IDE/agent directory에 skill을 설치 | canonical asset version, generated mirror hash, provider별 설치 상태를 doctor가 비교 |
| `p2a-dev-execution`과 run log | eval skill의 반복 실행, 실패 분석, shortcut 차단 | run finish에 reproduction/localization/fix/verification/guard 필드를 추가하고 실패 cluster를 proposal로 연결 |
| `p2a_orchestrate` provider matrix와 runner doctor | manifest가 scaffold/enhance/upgrade metadata를 보존 | provider capability evidence를 `dev.config.json` 후보로 승격하고 migration/diff preview 대상으로 포함 |
| Gate B 기술 조사 | scaffold 전에 sample을 읽고 재사용 패턴을 기록 | `spec_json.evidence.reference_candidates` 또는 `prior_art`를 추가해 공식 문서, 로컬 레퍼런스, Memory 검색 근거를 구조화 |
| Hermes proposal loop | eval analyze가 실패 모드를 분류해 다음 수정으로 연결 | proposal 유형에 `skill_contract_gap`, `provider_config_gap`, `doctor_rule_gap`, `eval_gap`을 명시 |
| Plan2Agent Memory 서버 | observability backend 역할 | 로컬 파일 정본은 유지하고 Memory는 hash, lineage, search, digest, analytics backend로 제한 |

우선 판단은 `doctor/info`와 `upgrade --dry-run`을 먼저 잡는 것이다. 이 둘이 있어야 skill/config/eval/memory 고도화가 여러 프로젝트에 퍼질 때 drift와 실패를 사용자가 즉시 확인할 수 있다.

## 3. 개발 실행 skill/config 고도화

현재 `plans/04`의 기존 아이디어는 `doctor/info`, Memory, eval 쪽에 치우쳐 있다. 하지만 실제 P2A 하네스 품질은 개발 실행용 skill과 provider 구성이 얼마나 잘 유지되는지에 크게 좌우된다. 따라서 다음 고도화 축은 `p2a-dev-execution`, `p2a-implementer`, `p2a-dev-orchestrator`, `p2a-performance-monitor`, `p2a-skill-curator`의 계약과 scaffolded project config를 함께 관리하는 것이다.

### 3.1 개발 skill 계층 정리

| 계층 | 현재 자산 | 고도화 아이디어 |
| --- | --- | --- |
| 실행 workflow | `p2a-dev-execution` | run 시작 전/후 체크, verification 최소 기준, scope drift 처리, 실패 분류를 더 명시적으로 템플릿화 |
| 구현 agent | `p2a-implementer` | provider별 쓰기 경계, 금지 파일, allowed edit surface, task scope 요약을 role prompt에 구조적으로 삽입 |
| orchestration lead | `p2a-dev-orchestrator` | deterministic plan 검토뿐 아니라 provider/role profile 추천 근거를 machine-readable sidecar로 남김 |
| monitor | `p2a-performance-monitor` | acceptance criteria별 충족/미충족 matrix와 verification 신뢰도 점수를 반환 |
| skill curator | `p2a-skill-curator` | proposal을 skill 수정, CLI 수정, schema 수정, docs 수정, provider config 수정으로 분류 |
| task author | `p2a-task-author` | 실행 난이도, 검증 가능성, provider 적합도 힌트를 task graph draft에 반영 |

핵심은 skill 문서를 더 길게 만드는 것이 아니라, 실행 prompt와 run/proposal artifact가 읽을 수 있는 구조화된 config를 늘리는 것이다.

### 3.2 Provider와 role profile config

`p2a_orchestrate`에는 이미 provider capability matrix, role profile, runner guide, runner doctor가 있다. 다음 단계는 이 구성을 scaffolded project의 명시 config로 승격하는 것이다.

후보 필드:

```json
{
  "devExecution": {
    "defaultProvider": "codex",
    "allowedProviders": ["codex", "claude", "gemini", "manual"],
    "writeProviders": ["codex", "claude"],
    "readOnlyProviders": ["gemini"],
    "defaultIsolation": "worktree",
    "scopePolicy": "task_only",
    "verificationPolicy": "required_for_done"
  },
  "roleProfiles": {
    "implementer": {
      "defaultProfile": "fullstack",
      "allowedProfiles": ["frontend", "backend", "fullstack", "test", "docs"]
    },
    "reviewer": {
      "defaultProfile": "qa",
      "allowedProfiles": ["qa", "architecture", "security"]
    },
    "monitor": {
      "defaultProfile": "manual_monitor"
    }
  },
  "providerNativeCapabilities": {
    "codex": {
      "skills": "available",
      "customAgents": "manual_check"
    },
    "claude": {
      "skills": "available",
      "agentTeams": "manual_check"
    },
    "gemini": {
      "commands": "available",
      "writeAllowed": false
    }
  }
}
```

이 config는 `.plan2agent/project.config.json` 또는 별도 `.plan2agent/dev.config.json` 후보가 될 수 있다. 단, 복잡도가 커지면 `project.config.json`을 실행/검증/Provider 설정까지 모두 담는 파일로 키우기보다 `dev.config.json`으로 분리하는 편이 낫다.

### 3.3 Skill/config doctor

`p2a doctor`는 단순 파일 존재 확인을 넘어서 development skill/config drift를 확인해야 한다.

검사 후보:

| 검사 | 이유 |
| --- | --- |
| canonical `.agents`와 CLI mirror drift | skill/agent 계약이 provider별로 어긋나면 실행 prompt가 달라진다 |
| scaffold 대상의 `.agents`, `.codex`, `.claude`, `.gemini` asset 누락 | provider-native 실행 guide가 실제 프로젝트에서 작동하지 않는다 |
| `project.config.json`의 test/lint/typecheck 감지 상태 | verification 없이 done 처리되는 위험을 줄인다 |
| provider capability evidence 최신성 | Claude team, Codex custom agent, Gemini command 가능 여부가 stale해질 수 있다 |
| Gemini write 금지 유지 | read-only provider가 write-required role에 배정되는 회귀를 막는다 |
| Claude confinement 설치 상태 | write-capable foreground 실행의 안전 경계를 확인한다 |
| role profile override 유효성 | frontend/backend/test/docs 같은 profile이 실제 task와 맞지 않는 구성을 잡는다 |

`runner-doctor`가 provider 실행 표면을 보는 도구라면, 상위 `p2a doctor`는 하네스 전체 상태와 development skill/config 상태를 함께 보여주는 진입점이 된다.

### 3.4 Prompt template versioning

개발 실행 prompt는 provider별로 점점 달라질 가능성이 높다. 따라서 role prompt와 runner guide에 version을 붙이는 방향을 검토한다.

후보:

- `promptTemplateVersion`: `p2a.dev_prompt.v1`
- `roleContractVersion`: `p2a.role_contract.v1`
- `providerGuideVersion`: `p2a.provider_guide.v1`
- run log에 사용된 prompt template/version 기록
- proposal이 특정 template version의 결함을 지적할 수 있게 연결

이렇게 하면 “어떤 prompt 계약으로 실행한 run이 실패했는지”를 Memory와 proposal loop에서 추적할 수 있다.

### 3.5 Scaffold/upgrade 범위

개발 skill/config는 scaffold와 upgrade의 주요 대상이어야 한다.

| 명령 후보 | 개발 skill/config 관점 동작 |
| --- | --- |
| `p2a enhance dev-skills` | provider별 skill/agent/command shim, dev config, runner guide 기본값 설치 |
| `p2a upgrade --dry-run` | canonical skill/agent와 대상 프로젝트 mirror diff, dev config migration preview |
| `p2a update skills` | generated mirror와 provider prompt template을 최신 버전으로 갱신 |
| `p2a doctor --dev` | development skill/config만 집중 진단 |
| `p2a config providers` | provider capability evidence와 기본 role provider를 수동 기록 |

주의할 점은 자동 overwrite를 피하는 것이다. skill/config는 실행 안전 경계이므로 upgrade는 변경 preview, 충돌 보고, 명시 승인 순서로 가야 한다.

### 3.6 Proposal loop와 연결

개발 skill/config 고도화는 Hermes proposal loop와 잘 맞는다.

실패 run에서 만들 수 있는 proposal 유형:

| proposal 유형 | 예 |
| --- | --- |
| `skill_contract_gap` | `p2a-dev-execution`이 verification skip rationale을 요구하지 않아 run 품질이 낮아짐 |
| `provider_config_gap` | Codex custom agent evidence가 없어 team mode가 manual fallback으로만 생성됨 |
| `role_profile_mismatch` | backend task에 frontend profile이 배정됨 |
| `prompt_template_gap` | implementer prompt가 scope boundary를 충분히 강조하지 않아 unrelated files 변경 |
| `doctor_rule_gap` | scaffold project의 Claude confinement 누락을 doctor가 잡지 못함 |

이 유형을 `p2a_proposals`와 Memory 검색에 넣으면, 하네스 자체가 “어떤 skill/config를 고쳐야 더 나은 실행이 되는지”를 축적할 수 있다.

## 4. P2A 품질 루프 아이디어

`agents-cli eval`의 Quality Flywheel은 P2A에 가장 직접적으로 적용할 수 있는 패턴이다. P2A 버전은 LLM 응답 품질 평가가 아니라 "기획과 실행 산출물의 품질 평가"에 초점을 둔다.

### 4.1 `p2a_eval` 명령 후보

| 명령 | 입력 | 출력 | 목적 |
| --- | --- | --- | --- |
| `p2a_eval generate` | spec, task graph, acceptance criteria | eval cases 또는 review prompts | task가 검증 가능한지 평가 자료 생성 |
| `p2a_eval grade` | run log, verification, changedFiles | grade result JSON/MD | 실행 결과가 acceptance criteria를 만족했는지 판정 |
| `p2a_eval compare` | 이전/현재 iteration 또는 run | regression diff | 고도화가 기존 기준을 깨지 않았는지 비교 |
| `p2a_eval analyze` | 실패한 runs/proposals | failure cluster | 반복되는 실패 원인과 개선 후보 추출 |
| `p2a_eval digest` | 여러 run/eval 결과 | 요약 리포트 | 다음 iteration 또는 maintenance 후보 생성 |

### 4.2 평가 대상

P2A에서 평가해야 할 대상은 세 종류다.

1. Planning quality
   - open decision이 적절히 Gate A/B에서 막혔는가
   - spec 성공 기준이 검증 가능하게 쓰였는가
   - task graph가 과대 task나 누락 task 없이 분해됐는가

2. Execution quality
   - task run이 acceptance criteria를 실제로 검증했는가
   - changedFiles가 task 범위를 벗어나지 않았는가
   - test/lint/typecheck 결과가 충분히 기록됐는가

3. Learning quality
   - 실패가 proposal로 전환됐는가
   - 같은 실패가 반복되는가
   - 다음 iteration에서 이전 run의 evidence가 재사용됐는가

### 4.3 guardrail

`agents-cli`는 eval 생략, threshold 낮추기, 임의 모델 변경 같은 shortcut을 명시적으로 막는다. P2A의 shortcut guard는 다음이 되어야 한다.

- Gate B 승인 없이 task graph를 canonical로 승격하지 않는다.
- Gate D blocker가 있으면 "ready"로 표시하지 않는다.
- verification 실패 run을 `done`으로 닫지 않는다.
- task scope 밖 변경 파일이 있으면 run finish 시 경고 또는 blocker로 남긴다.
- Memory sync 실패를 무시하고 장기 상태가 보존됐다고 말하지 않는다.
- proposal patch draft는 approval 없이 maintenance task로 자동 적용하지 않는다.

## 5. Memory 서버 연결 방향

`plan2agent-memory`는 로컬 파일을 source of truth로 유지하고, 서버는 canonical ID, lineage, hash, relation, keyword/vector 검색 index를 제공하는 보조 저장소다. 이 경계는 P2A 하네스와 잘 맞는다.

### 5.1 역할 분리

| 책임 | 담당 |
| --- | --- |
| canonical planning/run 파일 | 로컬 `.plan2agent/` |
| 파일 생성/수정/승인 게이트 | P2A CLI와 agent workflow |
| 장기 보존, 검색, lineage 조회 | Plan2Agent Memory |
| status/diff/push/pull/conflict UX | P2A CLI/GUI |
| embedding 생성 | 외부 클라이언트 또는 별도 worker |

Memory 서버가 agent를 실행하거나 하네스 판단을 대신하지 않는 현재 경계는 유지해야 한다. 대신 P2A CLI/GUI가 git client처럼 동기화 client 역할을 한다.

### 5.2 우선 구현 후보

| 후보 | 설명 |
| --- | --- |
| `p2a memory status` | 로컬 artifact와 서버 snapshot의 hash/version 차이를 출력 |
| `p2a memory push` | project, iteration, spec, task graph, tasks, runs, chunks를 서버에 upsert |
| `p2a memory pull --dry-run` | 서버에 있는 snapshot과 로컬 파일의 차이를 preview |
| `p2a memory search` | keyword/vector 검색으로 과거 spec, run, proposal 조회 |
| `p2a memory history` | project/iteration/task/run lineage를 시간순으로 조회 |
| `p2a memory digest` | 최근 실패/반복 proposal/verification gap을 다음 maintenance 후보로 요약 |

### 5.3 Memory 기반 관측성

`agents-cli`의 observability tier를 P2A식으로 바꾸면 다음과 같다.

| Tier | P2A 의미 |
| --- | --- |
| Trace | task run lifecycle, command, verification, changedFiles, workspaceRef |
| Content log | spec/task/review/proposal snapshot과 source evidence |
| Analytics | 반복별 완료율, blocker 빈도, 실패 원인, proposal 전환율 |
| Search/RAG | 과거 결정, 유사 task, 실패 회고, 기술 선택 근거 검색 |

이 구조가 잡히면 P2A GUI는 단순 파일 뷰어에서 "프로젝트 기억을 검색하고 다음 행동을 추천하는 workbench"로 확장될 수 있다.

## 6. 실행/디버깅 루프 표준화

`agents-cli`의 reproduce -> localize -> fix one thing -> verify -> guard 루프는 P2A run 기록에 적용할 가치가 크다.

P2A run schema 또는 run finish 절차에 아래 필드를 추가하는 방안을 검토한다.

| 필드 | 의미 |
| --- | --- |
| `reproduction` | 실패를 재현한 명령과 입력 |
| `localization` | 원인이 code/spec/task/env 중 어디에 있었는지 |
| `fixSummary` | 한 번에 바꾼 핵심 수정 |
| `verification` | 재실행한 검증 명령과 결과 |
| `guard` | 회귀 방지를 위해 추가한 테스트, eval, proposal, 문서 |

이 정보가 쌓이면 `p2a_proposals mine`과 Memory search가 훨씬 강해진다. 단순히 "실패했다"가 아니라 "어떤 종류의 실패였고 어떤 방지책이 생겼는지"를 질의할 수 있기 때문이다.

## 7. Reference reconnaissance 단계

`agents-cli`는 scaffold 전에 관련 sample을 찾고 어떤 패턴을 재사용할지 확인한다. P2A도 Gate B 기술 조사와 brownfield intake에 이 구조를 도입할 수 있다.

P2A 적용 후보:

- `spec_json.evidence`에 `reference_candidates` 또는 `prior_art` 섹션을 추가한다.
- Gate B에서 기술 선택이 있으면 공식 문서뿐 아니라 로컬 레퍼런스 프로젝트, 기존 P2A run, Memory 검색 결과를 비교한다.
- task graph 생성 전 "재사용할 패턴"과 "새로 만들지 않을 것"을 명시한다.
- code-aware intake에서는 현재 코드베이스의 유사 모듈, 테스트 패턴, build command를 reference로 묶는다.

이 단계는 새로운 gate를 만드는 것이 아니라 Gate B의 근거 품질을 높이는 보조 절차로 두는 것이 좋다.

## 8. 추천 구현 순서

### 8.1 P1: 진입 명령과 dev skill/config doctor

1. `p2a info` 또는 `p2a doctor`로 현재 프로젝트 상태를 한 번에 확인한다.
2. `p2a doctor --dev`로 development skill/config, provider asset, role profile, verification command 상태를 진단한다.
3. `p2a update`와 `p2a upgrade --dry-run`은 부분 실패를 성공처럼 표시하지 않고 non-zero exit, 실패 asset 목록, 복구 명령을 출력한다.
4. GUI Overview가 이 명령 결과를 읽도록 한다.

이 단계는 사용자가 "현재 어디까지 왔는지"를 안정적으로 알게 만든다.

### 8.2 P2: dev-skills enhance/upgrade

1. `p2a enhance dev-skills`로 provider별 skill/agent/command shim, dev config, prompt template version을 설치한다.
2. `p2a enhance memory/gui/orchestration/proposals`를 capability 단위로 분리해 prototype-first 확장 흐름을 만든다.
3. `p2a upgrade --dry-run`으로 scaffolded 프로젝트의 scripts/schemas/skills/dev config drift와 manifest migration을 preview한다.
4. upgrade 충돌은 자동 병합보다 report와 수동 승인 중심으로 처리한다.
5. run footer와 GUI supervised run에 copy-paste 가능한 resume/status/finish/review 명령을 남긴다.

이 단계는 여러 프로젝트에 P2A를 설치했을 때 실행 skill과 provider 구성이 drift되지 않게 만든다.

### 8.3 P3: Memory push와 run/eval digest

1. `p2a memory status`를 추가해 로컬 `.plan2agent`와 Memory 서버의 동기화 상태를 보여준다.
2. `p2a memory push`로 project, iteration, document, task graph, task, run snapshot을 서버에 저장한다.
3. `p2a_eval analyze` 또는 `p2a memory digest`로 실패 run과 proposal 후보를 요약한다.
4. proposal queue와 maintenance task 생성에 digest 결과를 연결한다.

이 단계는 P2A의 "경험이 쌓이는 하네스" 방향을 시작한다.

### 8.4 P4: 평가 루프와 compare

1. `p2a_eval grade`로 run 결과가 task acceptance criteria를 만족했는지 평가한다.
2. `p2a_eval compare`로 iteration 간 regression을 확인한다.
3. 실패 cluster를 Gate A/B delta draft와 maintenance proposal로 연결한다.

이 단계는 task 실행 결과가 다음 기획으로 되먹임되는 구조를 완성한다.

## 9. 비목표

이번 고도화 아이디어의 비목표는 다음과 같다.

- `agents-cli`의 ADK, Google Cloud, Agent Runtime 기능을 P2A에 직접 통합하지 않는다.
- Memory 서버가 하네스 실행, agent 실행, 외부 AI API 호출을 맡지 않는다.
- 로컬 `.plan2agent` 파일 정본을 서버 DB 정본으로 바꾸지 않는다.
- 여러 provider를 한 번에 자동 조합하는 multi-provider scheduler를 우선하지 않는다.
- approval 없이 upgrade, push, patch, deploy 같은 외부 효과 작업을 수행하지 않는다.

## 10. 결론

P2A의 다음 고도화는 Gate A-D 산출물을 더 많이 만드는 쪽보다, 이미 만들어진 산출물과 실행 기록을 안정적으로 진단, 평가, 저장, 검색, 회고하는 쪽이 우선이다.

가장 먼저 할 일은 `doctor/info`와 `doctor --dev`다. 그 다음 `enhance dev-skills`, capability별 `enhance`, `upgrade --dry-run`, manifest migration preview로 개발 skill/config drift를 관리한다. 이후 `memory status/push`와 `p2a_eval analyze/compare`를 통해 run과 proposal을 품질 루프로 묶는다.
