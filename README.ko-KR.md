# Plan2Agent

[![npm version](https://img.shields.io/npm/v/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![npm downloads](https://img.shields.io/npm/dm/plan2agent.svg)](https://www.npmjs.com/package/plan2agent)
[![CI](https://github.com/silbaram/plan2agent/actions/workflows/ci.yml/badge.svg)](https://github.com/silbaram/plan2agent/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | [한국어](README.ko-KR.md)

원하는 결과를 자연어로 설명하면 중요한 결정만 확인하고, 기획·개발·복구·검증의 다음
행동을 안내하는 개발 비서로 사용합니다.

## 30초 만에 설치하기

Plan2Agent를 사용하려면 Node.js 22 이상이 필요합니다.

```bash
npm install -g plan2agent
cd <project-dir>
p2a init --tools all --codex-profile quality
p2a next
```

`p2a next`는 로컬 프로젝트 상태를 읽고 지금 해야 할 구체적인 행동 하나를 반환합니다.
기획, 승인 또는 개발 단계를 마칠 때마다 다시 실행하세요.

## 5분 안에 첫 계획 만들기

초기화한 뒤 `p2a next --idea "<무엇을 만들지>"`로 한 문장 아이디어를 전달하거나
`p2a next --entry <path>`로 짧은 Markdown/text 문서를 선택합니다. `--idea`는 요청을 안정적인
로컬 파일로 저장하므로 채팅만 요구사항 정본으로 남지 않습니다.

| Agent | 예시 |
| --- | --- |
| Codex | `p2a next --idea "릴리즈 상태 추가"` 후 `$p2a-harness` 사용 |
| Claude Code | `p2a next --idea "릴리즈 상태 추가"` 후 `/p2a-harness` |
| Gemini CLI | `p2a next --entry docs/idea.md` 후 `/p2a:harness` |

P2A는 먼저 이해한 목표, 최소 변경 범위, 유지할 동작을 짧게 설명합니다. 제품 결과를
실질적으로 바꾸면서 안전하게 추론할 수 없는 내용만 묻고, 범위와 구현 계획을 각각 한 번
확인한 뒤 개발을 이어갑니다.

```text
자연어 요청
  -> 이해 요약과 꼭 필요한 질문
  -> 개발 범위 확인
  -> 구현 계획 확인
  -> 구현, 자동 복구, 변경 위험에 맞는 검증
  -> 종료 권장 또는 선택적 코드 리뷰·회고
```

내부적으로 범위와 구현 계획의 승인은 서로 다른 안전 경계로 유지되며 호환 이름은 Gate A와
Gate B입니다. 기존 constitution은 재사용하고, hard prohibition 또는 되돌리기 어려운
architecture/stack 결정이 있을 때만 조건부 Gate ②를 엽니다. 그 외 repository convention은
advisory로 사용합니다. 기본 안내에는 Gate·상태 ID·hash·artifact 경로를 노출하지 않으며
`p2a next --details` 또는 JSON에서만 확인합니다.

각 Gate는 검토 가능한 파일을 `.plan2agent/artifacts/<project_id>/` 아래에 기록합니다.
활성 Gate의 결정을 승인하고 안내된 행동을 완료한 다음 다시 실행합니다.

```bash
p2a next
```

Gate A-C 준비 검증이 통과하면 `next`가 감독형 실행과 다음 iteration으로의 전환을
안내합니다.

## Plan2Agent를 사용하는 이유

AI 코딩 도구는 구현에 효과적이지만, 채팅 기록은 요구사항, 승인, 의존성, 검증 증거를
보관하기에 취약합니다. Plan2Agent는 AI 코딩 도구 주위에 지속 가능한 제어 계층을
추가합니다.

| 필요 | Plan2Agent의 접근 방식 |
| --- | --- |
| 구현 전 명확한 결정 | Gate A 범위 확인과 Gate B 승인이 답변, 가정, 미결정 사항, 승인 상태를 보존합니다. |
| 추적 가능한 구현 작업 | 명세를 Direct run, Planned checkpoint 또는 의존성 기반 Orchestrated task로 연결합니다. |
| 검토 가능한 agent 실행 | 전경 감독 run이 mode, 선택 근거, 변경 파일, 검증 증거를 보존합니다. |
| 이식 가능한 프로젝트 상태 | Codex, Claude Code, Gemini CLI에서 로컬 JSON artifact를 정본으로 유지합니다. |
| 통제된 개선 | 평가와 proposal 흐름이 유지보수 작업을 제안하지만 self-modifying patch를 임의로 적용하지 않습니다. |

Plan2Agent는 workflow를 조정하지만 코딩 agent, source control 또는 project management
system을 대체하지 않습니다.

## 생성되는 파일

기획과 실행 상태는 프로젝트 로컬에 보관됩니다.

```text
.plan2agent/
  project.config.json
  constitution.json                 # 조건부 프로젝트 원칙 계약
  artifacts/<project_id>/
    decisions.jsonl
    gate-a-intake/
      intake.json
    gate-b-spec/
      spec.json
    gate-c-task-graph/
      task-graph.json
    current-spec.json
    iterations/
    runs/
    eval/
    proposals/
```

승인·철회 상태는 `decisions.jsonl`이 정본이고 기존 JSON `approval_audit`은 호환 사본으로
유지됩니다. 모든 artifact는 패키지에 포함된 schema로 검증됩니다. 생성된 Markdown은 사람이
읽기 위한 view입니다. run evidence는 기본적으로 현재 개발 상태를 위한 임시 자료입니다.
현재 개발 묶음은 검토·인계할 수 있게 유지하고, 다음 iteration을 열면 종료된 iteration의
run을 정리합니다. proposal로 아직 mining하지 않은 실패·차단 run은 그 전까지 보존합니다.
`p2a runs gc --dry-run`으로 index에 있는 run과 orphan 증거를 먼저 확인한 뒤 정리할 수 있고,
`persistent` 프로젝트는 실제 정리에 `--force`가 필요합니다. Git 저장소의 run은 시작·종료
시점 HEAD, branch, dirty 상태도 기록합니다. 장기 이력은 승인 spec, close metadata, Git에
남습니다. 로컬 run evidence를 장기 보존해야 할 때만 `runTracking.persistence`를
`persistent`로 설정합니다.
새 run은 Gate B에서 파생한 execution envelope를 content hash별로 한 번만 저장하고 각 run은
그 참조와 검증용 SHA-256만 가집니다. 기존 인라인 run도 계속 읽을 수 있으며
`p2a runs migrate-schema`로 참조형으로 전환할 수 있습니다.
생성물 파일 목록은 `runTracking.generatedPaths`로 자동 수집에서 제외할 수 있고, 성공한 기본
검증의 출력은 짧게 보존합니다. 실패 이력과 검증 근거는 유지합니다([기록 정책](docs/cli-reference.md)).

네 섹션으로 작성한 짧은 P2A 회고는 `p2a proposals issue-preview`로 공개 이슈 내용을 먼저
검토하고, 명시적인 `--yes` 확인 뒤에만 `publish-issue`로 P2A GitHub 저장소에 등록할 수 있습니다.
preview는 GitHub를 호출하지 않으며 이슈 발행은 구현 승인을 뜻하지 않습니다.

## 핵심 workflow

### 1. 승인 Gate를 거쳐 계획하기

기획 하네스는 아이디어나 진입 문서를 구조화된 intake, 제품·구현 명세, 검증된 실행 준비
상태로 바꿉니다. Gate A에서 범위를 간결하게 요약하고 사용자의 명시적인 확인을
요구합니다. 기존 constitution을 재사용하고 material project-shape 결정이 있을 때만
Gate ②를 연 뒤 Gate B로 이어집니다.

### 2. 승인된 목표 실행하기

Gate B 승인 후 `p2a next`로 승인된 계약이 허용한 다음 행동을 시작합니다. 새 프로젝트는
`adaptive`가 기본이며, execution mode가 없는 기존 config는 호환을 위해 `orchestrated`로 해석합니다.
`adaptive`, `direct`, `planned`, `orchestrated` 정책은 mode 재승인 없이 사용할 수 있습니다. Planned는 2~5개의
순서·명령 검증된 재개 checkpoint를 기록하고, 새 run은 승인된 계획에서 파생한 목표·source hash·범위·
현재 iteration의 architecture/interface/dependency 제약·보존 조건·비목표·acceptance·verification·권한 경계를 execution envelope로 고정합니다.

준비된 work item을 직접 제어하려면 다음 명령을 사용합니다.

```bash
p2a execute start \
  --artifacts .plan2agent/artifacts/<project_id> \
  --task <task-id>
```

플래그 없이 finish하면 문서·메타데이터 작업은 관련 검사만, 코드 작업은 프로젝트에 실제
설정된 test/lint/typecheck를 모두 실행합니다. 실패
attempt는 보존하지만 같은 started run에서 수정·재검증할 수 있습니다. 모든 task가 끝나면
docs/metadata는 프로젝트별 명령 또는 기본 파일 무결성 관련 검사, 단일 isolated code는 현재 product revision의 implementation full
증거를 재사용합니다. 다중 task/worktree 통합, high-risk 경로 또는 검증 후 제품 코드 변경일
때만 canonical `p2a execute verify-final`을 요구합니다. 유효한 제품 검증 뒤 문서만 바뀌면
제품 검증은 유지하고 `p2a execute verify-final --scope relevant`로 문서 관련 검사만 추가합니다.

시작, 재개, 완료, 재시도, 제한된 batch 절차는 [개발 실행 레퍼런스](docs/supervised-execution.md)를 참고하세요.

### 3. 기준선을 잃지 않고 반복하기

iteration은 승인된 spec을 보존하고 변경분 task와 유지보수 작업을 파생하며 종료된
이력을 archive합니다. 이후 Gate A는 baseline의 관련 확정 답변을 재사용하고 새
아이디어가 변경하거나 충돌하는 영역만 다시 질문합니다. `p2a next`는 close/open
전환을 안내하고, `p2a iteration`은 하위 수준의 제어 기능을 제공합니다.

### 4. 평가하고 개선하기

eval 흐름은 run evidence를 평가하고 결과를 비교하며 반복되는 실패를 묶습니다.
proposal 흐름은 근거가 있는 결과를 사람이 검토하는 maintenance task로 바꿀 수
있습니다. proposal이 존재한다는 이유만으로 patch를 적용하지 않습니다. 기본
`active_only`에서는 다음 iteration을 열거나 다음 maintenance task를 시작하기 전에 eval을
실행하고, 장기간 로컬 비교가 필요하면 `persistent`를 사용합니다.

### 5. BuildLore로 선택적 장기 지식 유지하기

[BuildLore](https://github.com/silbaram/buildlore)는 local-first·Git 기반 지식 도구입니다.
Plan2Agent artifact는 계속 로컬 실행 상태의 정본입니다.

BuildLore의 `knowledge/` 저장소를 연결하고 같은 project ID를 등록한 다음 adapter를
활성화하고 `.plan2agent/artifacts/<project-id>/` projection을 미리 확인합니다.

```bash
p2a enhance buildlore
p2a buildlore status
p2a buildlore sync --dry-run
p2a buildlore sync
```

BuildLore는 지원되는 승인 기획·실행 evidence를 선택하고 sanitizer를 거쳐 검토 가능한 지식
source로 기록합니다. 검색은 명시적이며 project 단위로 격리됩니다.

```bash
p2a buildlore search --query "인증 결정" --mode lexical
p2a buildlore context --prompt "다음 구현 계획을 준비해"
```

sync는 지식 저장소를 commit하거나 push하지 않습니다. BuildLore publish는 별도의 검토 가능한
Git workflow입니다.

## CLI 한눈에 보기

Plan2Agent는 하나의 `p2a` entrypoint를 설치합니다.

| 명령 | 용도 |
| --- | --- |
| `p2a init` | 프로젝트 상태와 provider asset을 초기화합니다. |
| `p2a next` | 현재 상황을 쉽게 설명하고 다음 행동 하나를 권장합니다. 내부 명령과 상태는 `--details`로 확인합니다. |
| `p2a decide` | Gate ① 승인·철회와 범위 추가·제거를 결정 원장에 기록합니다. |
| `p2a decisions` | 결정 이력을 조회하고 `--why`로 파일의 근거 결정을 추적합니다. |
| `p2a shape` | Gate ② constitution 상태, migration, 승인·철회를 관리합니다. |
| `p2a info` | 프로젝트, artifact, task, run 상태를 표시합니다. |
| `p2a doctor` | 설정, asset, 로컬 drift를 진단합니다. |
| `p2a update` | manifest package version에 고정된 프로젝트 관리 asset을 갱신합니다. |
| `p2a upgrade` | npm 전역 package 갱신을 미리 보거나 적용한 뒤 현재 프로젝트를 갱신합니다. |
| `p2a enhance` | BuildLore와 proposal 같은 선택적 기능을 활성화합니다. |
| `p2a validate` | 기획, task, run, eval, proposal artifact를 검증합니다. |
| `p2a iteration` | iteration 초기화, close/open, diff, maintenance를 관리합니다. |
| `p2a tasks` | task 상태를 확인하고 전환합니다. |
| `p2a runs` | run evidence를 기록, 검증, 완료, 조회합니다. |
| `p2a execute` | 구현과 canonical 최종 verification·visual·acceptance run을 검증된 완료까지 감독합니다. |
| `p2a eval` | 실행 증거를 grade, compare, analyze, generate, summarize합니다. |
| `p2a proposals` | 개선 proposal을 검토하거나 회고 GitHub 이슈를 preview하고 명시적으로 발행합니다. |
| `p2a buildlore` | 선택적 BuildLore 지식을 projection, 검사, 검색, 조회합니다. |

최상위 명령은 `p2a --help`로 확인할 수 있습니다. 자세한 option과 예시는
[CLI 레퍼런스](docs/cli-reference.md)를 참고하세요.

## 안전 모델

Plan2Agent는 승인 계약 기반·confined·local-first 원칙을 따릅니다. 제품 의미는 명시적 승인이 필요하지만,
승인된 envelope 안의 구현 선택과 검증 재시도는 추가 승인이 필요하지 않습니다.

다음과 같은 경우에 적합합니다.

- 구현 전 명시적인 제품 결정이 필요할 때
- 검토 가능한 spec과, orchestration에 필요할 때만 agent-ready task graph가 필요할 때
- confined Codex 또는 Claude로 실행하고 Gemini는 read-only로 유지할 때
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
| [BuildLore](https://github.com/silbaram/buildlore) | Plan2Agent 지식을 선택적으로 projection·검색하는 local-first·Git 기반 도구 |
| [plan2agent-feature-radar](https://github.com/silbaram/plan2agent-feature-radar) | 요구사항을 자동 선택하지 않고 기획용 근거를 내보내는 선택적 조사 workflow |

## 문서

- [Quickstart](docs/quickstart.md) — 설치부터 첫 Gate artifact까지의 최단 경로
- [Adaptive Harness 사용자 흐름](docs/adaptive-harness-user-flow.md) — Gate 승인부터 adaptive 실행, context routing, 검증·종료까지의 전체 여정
- [CLI 레퍼런스](docs/cli-reference.md) — 명령, option, 예시
- [하네스 사용자 가이드](docs/harness-guide.md) — Gate A-C, 결정 원장, schema, evidence, 문제 해결
- [Iteration Spec](docs/iteration-spec.md) — iteration layout, diff, close/open, run tracking
- [개발 실행 레퍼런스](docs/supervised-execution.md) — adaptive mode, checkpoint, monitor gate, 재시도, 검토
- [하네스 구현 기준](docs/harness-spec.md) — skill, subagent, mirror, 구현 규칙
- [변경 이력](CHANGELOG.md) — version별 사용자 영향 변경
- [릴리스 절차](docs/releasing.md) — npm, Git tag, GitHub Release, 검증 checklist

## Plan2Agent 개발하기

저장소를 clone하고 Node.js 22 이상을 사용합니다. 개발 중에는 핵심 test와 provider parity를
확인합니다.

```bash
npm test
node scripts/check_cli_parity.mjs
```

PR이나 release 전에는 `npm run test:all`을 실행합니다. 이 명령은 핵심 test, 장기 fixture gate,
package/upgrade smoke를 각각 한 번씩 실행합니다. Fixture와 lifecycle 검증은
`npm run test:full`이 담당합니다. `node scripts/run_fixtures.mjs`는 같은 runner를 직접
디버깅할 때만 사용하는 대체 명령이므로 한 검증 과정에서 둘을 함께 실행하지 않습니다.
Canonical provider asset을 변경했을 때만 `node scripts/sync_cli_assets.mjs`를 실행하고 parity로
확인합니다.

runtime은 Node.js ESM이며 Node.js 표준 라이브러리를 사용합니다. 저장소 구조는 다음과
같습니다.

```text
.agents/       정본 skill과 CLI-neutral subagent
.claude/       생성된 Claude Code mirror
.codex/        생성된 Codex mirror
.gemini/       생성된 Gemini CLI command와 agent
docs/          사용자 가이드와 구현 레퍼런스
fixtures/      golden fixture와 negative fixture
schemas/       Plan2Agent artifact용 JSON schema
scripts/       toolkit, validation, runtime, eval, proposal, BuildLore adapter CLI
```

## 프로젝트 상태

Plan2Agent는 활발히 개발 중입니다. 버전 `0.3.0`은 Gate에서 파생한 실행 envelope와 기존
orchestration 호환성을 유지하면서 Direct, Planned, Orchestrated 적응형 실행을 추가합니다.
상세 task graph는 dependency 또는 ownership 경계가 유용한 Orchestrated 작업에만 생성됩니다.
local-first 기획, 감독형 실행, 평가, proposal, 선택적 BuildLore workflow도 함께 유지됩니다.
자율적인 provider 실행과 승인되지 않은 remote side effect는 기본 안전 모델의 범위 밖에
있습니다.

Plan2Agent는 [MIT License](LICENSE)로 제공됩니다.
