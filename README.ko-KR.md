# Plan2Agent

[![npm version](https://img.shields.io/npm/v/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![npm downloads](https://img.shields.io/npm/dm/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](readme.md) | [한국어](README.ko-KR.md)

한 문장의 제품 아이디어를 사용자가 확인한 제품 이해, 승인된 명세, 의존성 기반 task,
검증된 AI 코딩 실행으로 바꿉니다.

## 30초 만에 설치하기

Plan2Agent를 사용하려면 Node.js 20 이상이 필요합니다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
p2a next
```

`p2a next`는 로컬 프로젝트 상태를 읽고 지금 해야 할 구체적인 행동 하나를 반환합니다.
기획, 승인 또는 개발 단계를 마칠 때마다 다시 실행하세요.

## 5분 안에 첫 계획 만들기

초기화한 뒤 프로젝트 디렉터리에서 Codex, Claude Code 또는 Gemini CLI를 열고 기획
하네스에 제품 아이디어를 전달합니다. 완성된 요구사항 문서를 먼저 작성할 필요는
없습니다.

| Agent | 예시 |
| --- | --- |
| Codex | `Use the $p2a-harness skill to plan a service that receives webhooks, verifies signatures, and shows delivery history.` |
| Claude Code | `/p2a-harness 웹훅을 수신하고 서명을 검증하며 전송 이력을 보여주는 서비스를 계획해 줘.` |
| Gemini CLI | `/p2a:harness 웹훅을 수신하고 서명을 검증하며 전송 이력을 보여주는 서비스를 계획해 줘.` |

하네스는 bounded discovery interview를 시작해 한 번에 1~3개의 중요한 질문을 합니다.
질문 ID를 유지하고 구체적인 답변을 기록하며, 확인된 답변을 채팅에만 남기지 않고 제품·
구현 명세의 canonical field로 반영합니다.

3라운드에서는 soft-limit 요약을 제시하고 계속 인터뷰할지, 현재 이해를 확인할지,
일시 중지할지 묻습니다. 5라운드 또는 무진전 2회에 도달하면 인터뷰를 중단합니다.
해결되지 않은 high-impact blocker는 임의의 가정으로 숨기지 않고 계속 표시합니다.

전체 workflow는 불명확한 요구사항을 곧바로 코드로 바꾸지 않고 명시적인 검토 Gate마다
멈춥니다.

```text
한 문장 아이디어
  -> Discovery interview: 라운드마다 1~3개의 핵심 질문
  -> Gate A: 종합된 이해 확인과 사용자의 명시적 승인
  -> Gate B: 제품 명세와 구현 계획
  -> Gate C: 의존성 기반 task graph
  -> Gate D: blocker와 실행 준비 상태 검토
  -> 감독형 구현과 검증
  -> 평가와 개선 proposal
```

Gate A 이해 확인과 Gate B 승인은 서로 다른 결정입니다. 사용자가 Gate A 이해 요약을
명시적으로 확인하면 하네스는 같은 agent 세션에서 Gate B로 이어갑니다.

각 Gate는 검토 가능한 파일을 `.plan2agent/artifacts/<project_id>/` 아래에 기록합니다.
활성 Gate의 결정을 승인하고 안내된 행동을 완료한 다음 다시 실행합니다.

```bash
p2a next
```

Gate D의 blocker가 모두 해소되면 `next`가 감독형 task 실행과 다음 iteration으로의
전환을 안내합니다.

## Plan2Agent를 사용하는 이유

AI 코딩 도구는 구현에 효과적이지만, 채팅 기록은 요구사항, 승인, 의존성, 검증 증거를
보관하기에 취약합니다. Plan2Agent는 AI 코딩 도구 주위에 지속 가능한 제어 계층을
추가합니다.

| 필요 | Plan2Agent의 접근 방식 |
| --- | --- |
| 구현 전 명확한 결정 | bounded discovery interview와 네 개의 사용자 승인 Gate가 답변, 가정, 미결정 사항, 승인 상태를 보존합니다. |
| 추적 가능한 구현 작업 | 명세를 acceptance criteria와 원본 참조를 가진 의존성 기반 task로 연결합니다. |
| 검토 가능한 agent 실행 | task를 전경 감독 세션에서 실행하고 run log, 변경 파일, 검증 증거를 남깁니다. |
| 이식 가능한 프로젝트 상태 | Codex, Claude Code, Gemini CLI에서 로컬 JSON artifact를 정본으로 유지합니다. |
| 통제된 개선 | 평가와 proposal 흐름이 유지보수 작업을 제안하지만 self-modifying patch를 임의로 적용하지 않습니다. |

Plan2Agent는 workflow를 조정하지만 코딩 agent, source control 또는 project management
system을 대체하지 않습니다.

## 생성되는 파일

기획과 실행 상태는 프로젝트 로컬에 보관됩니다.

```text
.plan2agent/
  project.config.json
  artifacts/<project_id>/
    gate-a-intake/
      intake.json
    gate-b-spec/
      spec.json
    gate-c-task-graph/
      task-graph.json
    gate-d-review/
      review.json
    current-spec.json
    iterations/
    runs/
    eval/
    proposals/
```

JSON 파일은 정본이며 패키지에 포함된 schema로 검증됩니다. 생성된 Markdown은 사람이
읽기 위한 view입니다. 종료된 iteration과 완료된 run evidence는 이후 검토를 위한
감사 가능한 이력으로 남습니다.

## 핵심 workflow

### 1. 승인 Gate를 거쳐 계획하기

기획 하네스는 아이디어를 구조화된 intake, 제품·구현 명세, task graph, 실행 준비 상태
검토로 바꿉니다. Gate A에서 필수 discovery 영역을 인터뷰하고 간결한 이해 요약을
제시한 뒤 사용자의 명시적인 확인을 요구합니다. 확인되면 같은 세션에서 Gate B로
이어집니다. 불확실한 내용을 임의의 요구사항으로 만들지 않고 가정이나 사용자 결정으로
기록합니다.

### 2. ready task 하나 실행하기

Gate D 이후에는 `p2a next`로 다음 안전한 행동을 확인합니다. task 실행은 agent tool,
workspace, 변경 파일, 검증 명령, 결과, 실패 분류를 기록합니다. 필요한 증거가 monitor
gate를 통과하기 전에는 task가 완료되지 않습니다.

ready task를 직접 제어하려면 다음 명령을 사용합니다.

```bash
p2a execute plan \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task <task-id>
```

시작, 재개, 완료, 재시도, batch, milestone review 절차는
[감독형 개발 실행 레퍼런스](docs/supervised-execution.md)를 참고하세요.

### 3. 기준선을 잃지 않고 반복하기

iteration은 승인된 spec을 보존하고 변경분 task와 유지보수 작업을 파생하며 종료된
이력을 archive합니다. 이후 Gate A는 baseline의 관련 확정 답변을 재사용하고 새
아이디어가 변경하거나 충돌하는 영역만 다시 질문합니다. `p2a next`는 close/open
전환을 안내하고, `p2a iteration`은 하위 수준의 제어 기능을 제공합니다.

### 4. 평가하고 개선하기

eval 흐름은 run evidence를 평가하고 결과를 비교하며 반복되는 실패를 묶습니다.
proposal 흐름은 근거가 있는 결과를 사람이 검토하는 maintenance task로 바꿀 수
있습니다. proposal이 존재한다는 이유만으로 patch를 적용하지 않습니다.

### 5. 선택적으로 장기 context 불러오기

[Plan2Agent Memory](https://github.com/silbaram/plan2agent-memory)는 artifact, 이력,
lineage를 위한 선택적 저장·검색 backend입니다. Memory가 없거나 설정되지 않아도 로컬
`.plan2agent/` 파일이 정본으로 유지됩니다.

## CLI 한눈에 보기

Plan2Agent는 하나의 `p2a` entrypoint를 설치합니다.

| 명령 | 용도 |
| --- | --- |
| `p2a init` | 프로젝트 상태와 provider asset을 초기화합니다. |
| `p2a next` | 상태에 맞는 다음 행동 하나와 그 이유를 반환합니다. |
| `p2a info` | 프로젝트, artifact, task, run 상태를 표시합니다. |
| `p2a doctor` | 설정, asset, 로컬 drift를 진단합니다. |
| `p2a update` | 패키지가 관리하는 안전한 asset update를 미리 보거나 적용합니다. |
| `p2a upgrade` | 더 넓은 범위의 toolkit migration을 미리 보거나 적용합니다. |
| `p2a enhance` | Memory와 proposal 같은 선택적 기능을 활성화합니다. |
| `p2a validate` | 기획, task, run, eval, proposal, Memory artifact를 검증합니다. |
| `p2a iteration` | iteration 초기화, close/open, diff, maintenance를 관리합니다. |
| `p2a tasks` | task 상태를 확인하고 전환합니다. |
| `p2a runs` | run evidence를 기록, 검증, 완료, 조회합니다. |
| `p2a execute` | task 계획부터 검증된 완료까지 감독합니다. |
| `p2a eval` | 평가를 grade, compare, analyze, generate, summarize합니다. |
| `p2a proposals` | 개선 proposal을 mine, review, curate, approve, summarize합니다. |
| `p2a memory` | 선택적 Memory data를 확인, 동기화, 검색, 조회합니다. |

최상위 명령은 `p2a --help`로 확인할 수 있습니다. 자세한 option과 예시는
[CLI 레퍼런스](docs/cli-reference.md)를 참고하세요.

## 안전 모델

Plan2Agent는 의도적으로 사용자 감독과 local-first 원칙을 따릅니다.

다음과 같은 경우에 적합합니다.

- 구현 전 명시적인 제품 결정이 필요할 때
- 검토 가능한 spec과 agent-ready task graph가 필요할 때
- Codex, Claude Code 또는 Gemini CLI를 전경에서 감독하며 실행할 때
- 검증 증거와 regression 이력이 필요할 때
- 사람이 승인하는 유지보수와 개선 흐름이 필요할 때

다음 용도로는 설계되지 않았습니다.

- 사용자 감독 없는 background coding
- 비공식 provider API 자동화
- 승인 없는 dependency 설치, merge, push, PR 생성
- remote service를 프로젝트 정본으로 사용
- Git이나 issue tracker 대체

## Provider 지원

정본 skill과 subagent 정의는 `.agents/` 아래에 있습니다. Plan2Agent는 다음 provider를
위한 전용 surface를 생성하고 검증합니다.

- Codex
- Claude Code
- Gemini CLI

parity 검사가 provider mirror와 정본 정의의 일치를 확인합니다. agent는 전경 tool
session에서 실행되며 Plan2Agent는 provider API를 직접 호출하지 않습니다.

## Companion project

핵심 기획, 검증, iteration, 실행, eval, proposal 흐름은 companion service 없이
동작합니다.

| 프로젝트 | 용도 |
| --- | --- |
| [plan2agent-memory](https://github.com/silbaram/plan2agent-memory) | 선택적 artifact 이력, 검색, hash 비교, lineage 서비스 |
| [plan2agent-feature-radar](https://github.com/silbaram/plan2agent-feature-radar) | 요구사항을 자동 선택하지 않고 기획용 근거를 내보내는 선택적 조사 workflow |

## 문서

- [Quickstart](docs/quickstart.md) — 설치부터 첫 Gate artifact까지의 최단 경로
- [CLI 레퍼런스](docs/cli-reference.md) — 명령, option, 예시
- [하네스 사용자 가이드](docs/harness-guide.md) — Gate A-D, schema, evidence, 문제 해결
- [Iteration Spec](docs/iteration-spec.md) — iteration layout, diff, close/open, run tracking
- [감독형 개발 실행 레퍼런스](docs/supervised-execution.md) — task 실행, monitor gate, 재시도, 검토
- [하네스 구현 기준](docs/harness-spec.md) — skill, subagent, mirror, 구현 규칙
- [제품 로드맵](plans/01-product-roadmap.md) — 현재 제품 방향과 남은 작업

## Plan2Agent 개발하기

저장소를 clone하고 Node.js 20 이상에서 다음 명령을 실행합니다.

```bash
npm test
npm run test:package
node scripts/sync_cli_assets.mjs
node scripts/check_cli_parity.mjs
node scripts/run_fixtures.mjs
```

runtime은 Node.js ESM이며 Node.js 표준 라이브러리를 사용합니다. 저장소 구조는 다음과
같습니다.

```text
.agents/       정본 skill과 CLI-neutral subagent
.claude/       생성된 Claude Code mirror
.codex/        생성된 Codex mirror
.gemini/       생성된 Gemini CLI command와 agent
docs/          사용자 가이드와 구현 레퍼런스
fixtures/      golden fixture와 negative fixture
plans/         로드맵과 완료된 기획 기록
schemas/       Plan2Agent artifact용 JSON schema
scripts/       toolkit, validation, runtime, eval, proposal, Memory CLI
```

## 프로젝트 상태

Plan2Agent는 활발히 개발 중입니다. 버전 `0.1.0`은 공개 npm 패키지와 local-first 기획,
감독형 실행, 평가, proposal, 선택적 Memory workflow를 제공합니다. 자율적인 provider
실행과 승인되지 않은 remote side effect는 기본 안전 모델의 범위 밖에 있습니다.

Plan2Agent는 [MIT License](LICENSE)로 제공됩니다.
