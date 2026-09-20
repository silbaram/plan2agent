# P2A 문서 이름과 저장 위치 규칙

이 문서는 P2A가 만드는 작업 문서와 보조 자료의 이름, 저장 위치, 보관 원칙과 구현 범위를 정한다. 2026-09-20 코드 검토에 따라 다음 반복의 기본 ID 생성과 배포되는 작성 지침을 수정했다. 별도 번호 등록부와 범용 자동 청소는 추가하지 않았다. 이 변경은 소스와 로컬 패키지 검증에 반영되었으며 기존 설치에 자동 배포되지는 않는다.

문서 홈: [Plan2Agent Docs](README.md) · 현재 CLI 계약: [반복 개발](iteration-spec.md), [실행 기록](supervised-execution.md), [진입 문서](entry-contract.md)

## 1. 적용 상태와 우선순위

- 기존 CLI/schema가 경로와 파일명을 지정한 정본은 그 계약을 유지한다. 이 문서의 일반 명명 규칙으로 바꾸지 않는다.
- 새로 작성하는 보조 보고서·조사 자료·임시 환경은 아래 위치 규칙을 따른다.
- `open`/`replace-scope`에서 ID를 생략하면 다음 `iter-0001` 순번을 자동 할당한다. 첫 `init` 기본값 `v1-mvp`와 명시적으로 지정한 ID는 유지한다.
- 보조 자료 위치는 패키지의 agent 작성 지침으로 적용한다. 모든 파일 쓰기를 감시하거나 위반 시 Gate를 차단하지 않는다. 일반적인 자동 청소와 자료 이전은 제공하지 않는다.
- 사용자 제공 원문, 외부 도구가 생성한 파일, 기존 프로젝트 ID·iteration ID·run ID는 원래 이름을 보존한다.

## 2. 이름의 역할

| 대상 | 규칙 | 예시 |
| --- | --- | --- |
| 프로젝트 ID | 프로젝트 설정의 안정적인 기존 ID를 재사용한다. | `buildlore` |
| 다음 반복의 기본 ID | `open`/`replace-scope`에서 ID 생략 시 `iter-<4자리 이상 숫자>`를 쓴다. 명시적 ID는 기존 계약대로 허용한다. | `iter-0001`, `iter-0042`, `iter-10000` |
| 상시 유지보수 | 기존 예약 이름을 유지한다. | `maintenance` |
| run ID 및 정본 sidecar | P2A가 발급한 ID와 파일명 계약을 그대로 쓴다. | `runs/<iteration-id>/<run-id>.json` |
| run 없는 보조 자료 | 짧은 작업 주제를 이름으로 쓴다. 기존 자료와 충돌하면 `-02`처럼 접미사를 붙이고 덮어쓰지 않는다. 별도 ID 원장은 만들지 않는다. | `notes/install-review.md` |
| 보조 문서 파일 | 영어 소문자 kebab-case와 역할 이름을 쓴다. | `report.md`, `findings.json`, `typecheck.log` |
| 문서 제목 | 사람이 이해할 작업명을 본문 첫 제목에 쓴다. 한글을 허용한다. | `# npm 로컬 설치와 MCP 연결 개선` |
| 시각 | 문서 메타데이터에 UTC ISO 8601로 쓴다. | `2026-09-20T10:00:00Z` |

신규 iteration 번호는 `iterations/`에 남은 이름과 current-spec의 active/pending/closed 기록에 있는 `iter-숫자`의 최대값 + 1로 정한다. 없으면 1부터 시작한다. 기존 `v25-...` 이름은 번호 계산에서 제외하되 그대로 보존한다. 숫자는 안전하게 표현 가능한 범위인지 검사하고, 같은 이름의 파일·디렉터리·심볼릭 링크가 있으면 충돌로 취급한다. 현재 기록에서 확인 가능한 ID는 재사용하지 않는다. 사용자가 파일과 기록을 모두 지운 경우까지 영구적 비재사용을 보장하는 별도 counter는 추가하지 않는다.

`open`/`replace-scope`가 이미 획득하는 artifact·iteration·run-store 잠금 안에서 번호를 계산하고 생성한다. 새 예약 파일이나 잠금 체계를 추가하지 않는다.

한 번 발급한 ID는 작업 제목이나 범위가 바뀌어도 개명하지 않는다. 작업 내용은 기존 iteration의 `idea`와 spec에서 확인한다. 상태 화면의 현재 작업 설명은 기존 필드를 재사용하고, 과거 제목을 채우기 위해 종료된 전체 spec을 다시 읽거나 schema를 늘리지 않는다.

보조 파일에 의미가 불분명한 `final`, `final2`, `latest`, `new`를 붙이지 않는다. 같은 run 안의 재검증은 `logs/test-02.log`처럼 시도로 구분하며 이름을 바꾸려고 새 run을 만들지 않는다. 동일한 내용을 이름만 바꾸어 복사하지 않는다. `README.md`, `current-spec.json`, `task-graph.draft.json`, 업데이트 보고서의 timestamp 등 기존 계약 이름은 예외다.

## 3. 디렉터리 구조

아래는 역할을 보여 주는 구조다. 선택 사항인 파일과 폴더는 실제로 필요할 때만 만든다.

```text
.plan2agent/
  project.config.json
  manifest.json
  constitution.json
  entries/                           # CLI가 보존하는 진입 원문
    idea-<digest>.md
  update-reports/                     # P2A 설치·업데이트 기록
  proposals/                         # 기존 회고 제안 계약
  artifacts/<project-id>/
    current-spec.json                # active iteration과 기획 상태 포인터
    current-development-contract.json # 현재 실행 계약
    decisions.jsonl                  # 승인·범위 결정 원장
    status.md                        # 현재 작업과 과거 반복의 읽기용 인덱스
    preflight-research/               # 기존 Feature Radar 계약
    iterations/
      iter-0042/
        iteration.json
        baseline/                    # CLI가 만드는 기준 스냅샷
        gate-a-intake/
          intake.json
        gate-b-spec/
          spec.json
          product-spec.md
          implementation-plan.md
        gate-c-task-graph/
          task-graph.json
        notes/                       # run 없는 조사·검토; 필요한 경우만
          install-review.md
          install-review/            # 첨부가 있을 때만
            test.log
        milestone-reviews/           # 기존 milestone review 계약
      maintenance/
        gate-c-task-graph/
          task-graph.json
    runs/
      run-index.json
      <iteration-id>/
        <run-id>.json                 # 정본 run과 계약된 sidecar
    evidence/
      <iteration-id>/
        <run-id>/
          report.md
          findings.json
          logs/
            test.log
            lint.log
          attachments/
    visual-evidence/                  # 기존 시각 검증 계약
  tmp/
    <purpose>-<unique-suffix>/        # mkdtemp 등으로 작업별 생성
      workspace/                     # 임시 소스 복사·설치 환경
      packages/                      # 검증용 tgz
```

기존 flat greenfield 단계의 `gate-*`, visual prototype, reference capture, verification report 및 CLI가 지정한 다른 경로도 각 정본 계약을 유지한다. 위 트리는 기존 경로 전체의 허용 목록이 아니다. `intake.md` 등 선택적 Markdown의 생성 조건도 기존 계약을 따른다.

## 4. 무엇을 어디에 쓰는가

| 작성하려는 자료 | 위치와 원칙 |
| --- | --- |
| 사용자 진입 원문 | CLI 생성 원문은 `entries/`; 사용자가 제공한 파일은 원래 위치를 유지한다. capture는 기존 reference 계약을 따른다. |
| 승인 대상 범위·명세·task | 해당 iteration의 `gate-*`; 현재 schema와 고정 파일명을 사용한다. |
| run 없는 조사·검토 | `iterations/<iteration-id>/notes/<topic>.md`; 첨부가 있으면 같은 이름의 `<topic>/`에 둔다. |
| run에 속한 구현 검토·보안 점검·배포 준비 점검 | `evidence/<iteration-id>/<run-id>/report.md` |
| 검증 결과와 로그 | 같은 evidence 묶음의 `findings.json`, `logs/<검사명>.log`; CLI 정본 verification은 원래 경로를 유지한다. |
| 승인·완료 판정의 근거 첨부 | 같은 evidence 묶음의 `attachments/`; 필요한 파일만 보존하고 보고서에서 연결한다. |
| 의존성 설치·제품 소스 복사·빌드 출력 | `tmp/`의 해당 작업 공간; `artifacts/`에 `node_modules`, checkout, 전체 `dist` 복사본을 만들지 않는다. |
| 재사용할 검증 스크립트 | 제품 또는 P2A 저장소의 적절한 `scripts/`, `tests/`; 일회성 스크립트는 해당 임시 환경에 둔다. |
| 사람이 보는 현재 상태 | 기존 `status.md`를 사용한다. 별도 `latest-*.json`, `current-report.md`를 만들지 않는다. |

반복에 속하지 않는 설치·업데이트 기록은 기존 project-level 계약을 쓴다. 반복 없는 greenfield 조사에는 기존 Gate/Radar 위치를 쓴다. 폴더를 만들기 위해 가짜 iteration이나 run을 생성하지 않는다. maintenance는 iteration ID 위치에 `maintenance`를 사용한다. CLI가 회고 등 보고서 경로를 반환했다면 그 경로를 우선한다.

임시 환경은 해당 owner의 쓰기 허용 작업 공간 안에서 만든다. 기존 도구가 운영체제 임시 디렉터리와 정리 절차를 사용한다면 그대로 유지한다. 소스 복사 시 대상 임시 폴더가 다시 복사되지 않도록 `.plan2agent`를 제외하고, 불필요한 `.git`, `node_modules`, `dist`도 복제하지 않는다.

프로젝트 artifact 루트에 `m2-review-2026-09-15/`, `release-readiness-20260920/`, `issue51-local-install-design.md`처럼 작업별 이름을 새로 추가하지 않는다. 작업 주제는 notes의 이름이나 보고서 제목에, 소유 관계는 iteration/run 경로에 둔다.

## 5. 문서 작성과 연결

- 정본 JSON은 schema가 지정한 상태의 권위다. Markdown은 설명·검토·조회용이며 별도 승인 상태를 만들어내지 않는다.
- 같은 내용을 JSON과 Markdown으로 각각 손으로 관리하지 않는다. CLI가 제공하는 view는 기존 생성 경로를 쓰고, 추가 Markdown은 사람이 읽을 필요가 있을 때만 작성한다.
- 보조 보고서는 제목, 소유 iteration/run, 작성 시각, 검토 대상 commit·artifact, 결과, 근거 링크, 남은 작업을 필요한 만큼 담는다. 형식을 맞추기 위한 빈 파일이나 metadata JSON을 만들지 않는다.
- 경로는 보고서 기준 상대 링크로 기록한다. 개인 절대 경로와 실행 환경 전체를 문서에 복제하지 않는다.
- run별 보고서는 `report.md` 하나를 진입점으로 둔다. `summary.md`, `result.md`, `completion.md`에 같은 결론을 중복하지 않는다. `findings.json`, `logs/`, `attachments/`는 실제 소비자나 자료가 있을 때만 만든다.
- 미완료 초안은 같은 경로에서 갱신할 수 있다. 승인·완료 판정이 참조한 증거는 덮어쓰지 않는다. 같은 run의 새 검증 파일 또는 후속 run에서 이전 근거와 수정 결과를 연결한다.
- 전체 백업 대신 commit SHA, 비교 대상, 재현 명령을 우선 기록한다. 미커밋 변경 등으로 재현할 수 없다면 필요한 최소 patch·fixture·스크립트를 `attachments/`에 보존한다. 정본 baseline과 reference capture는 기존 계약대로 유지한다.

## 6. 보관과 정리

| 종류 | 보관 규칙 |
| --- | --- |
| 정본 Gate·결정 원장·종료 기록 | 기존 감사 계약에 따라 보존한다. 완료됐다는 이유로 삭제하거나 다른 폴더로 옮기지 않는다. |
| 정본 run·sidecar | 기존 `runTracking.persistence`와 `p2a runs gc` 계약을 따른다. 이 문서가 보존 기간을 덮어쓰지 않는다. |
| 보조 보고서와 판정 근거 | 소유 iteration의 증거로 보존한다. 별도 archive가 필요하면 참조·해시·복원 절차를 검증하는 관리 작업으로 수행한다. |
| `tmp/`의 재생성 가능한 파일 | 작성 주체가 자신이 만든 정확한 임시 디렉터리만 정리한다. 필요한 근거를 notes/evidence에 보존하고 재현 방법을 확인한다. 진행 중·재개 예정 작업은 유지한다. |
| 설치·업데이트 기록 | 기존 업데이트 보고서 계약을 유지한다. 임시 설치 환경과 구분한다. |

정본과 보고서에서 `tmp/` 파일을 유일한 판정 근거로 참조하지 않는다. 큰 파일이라도 재현 불가능한 근거이면 먼저 필요한 형태로 보존한다. 날짜나 용량만으로 미완료 작업을 자동 삭제하지 않는다. 완료 실패로 남은 tmp는 소유 작업과 재개 필요성을 확인한 뒤 정리한다.

현재 `active_only` 및 `runs gc`는 임의의 보조 폴더나 위 `tmp/` 전체를 청소하는 기능이 아니다. 전체 tmp 스캔·자동 삭제·용량 기준 삭제는 이번 구현에서 제외한다. run이 정리되어도 보존된 보고서를 이해할 수 있도록 보고서에 대상과 결과를 기록하며, 삭제될 run JSON만을 유일한 설명으로 남기지 않는다.

## 7. 기존 BuildLore 자료에 적용

1. 기존 `v1-*`, `v25-...-next`와 관련 정본 경로는 유지한다. 변경된 CLI 적용 후 다음 `open` 기본값부터 `iter-0001` 계열을 쓴다.
2. 새 보고서는 위 `notes/` 또는 `evidence/` 구조에 작성한다. 기존 보고서는 이름만 바꾸어 재발행하지 않는다.
3. 기존 작업별 폴더는 소유 iteration/run, 참조하는 문서, 필수 증거, 재생성 가능한 환경을 먼저 목록화한다.
4. 참조된 파일을 옮겨야 한다면 경로·해시·승인 결합을 먼저 확인한다. 봉인된 기록과 원장을 단순 경로 치환으로 수정하지 않는다. 검증 가능한 이전 절차가 없으면 기존 경로에 남긴다.
5. 남은 임시 환경만 정리한다. 기존 `.plan2agent` 전체를 새로운 구조로 한 번에 이동하지 않는다.

## 8. 코드 검토에서 수정한 계획

| 검토 결과 | 근거 | 계획 반영 |
| --- | --- | --- |
| 문서만 바꾸면 설치된 agent에 전달되지 않는다. | `package.json.files`에 `docs/`가 없고 `.agents`, provider mirror는 포함된다. | 필수 규칙을 배포되는 기존 skill reference 안에 짧게 포함한다. 저장소 docs 링크만 추가하지 않는다. |
| 순번마다 새 예약 체계를 만들 필요가 없다. | `p2a_iteration.mjs`의 `open`/`replaceScope`가 이미 잠근 뒤 `openLocked`에서 ID를 선택한다. | 기존 잠금 안에서 allocator만 변경한다. 별도 check ID와 counter를 제거한다. |
| 첫 반복까지 바꾸면 불필요한 호환 변경이 생긴다. | `DEFAULT_ITERATION_ID`, next 초기화 안내, 기존 fixture가 `v1-mvp`를 사용한다. | 이번 변경은 다음 반복의 기본 이름에 집중한다. init와 명시적 ID는 유지한다. |
| tmp로 위치만 바꾸면 제품 변경 수집에 섞일 수 있다. | `p2a_runs.mjs`의 기본 untracked 제외는 `.plan2agent/artifacts`다. | `.plan2agent/tmp`도 기본 제외에 포함하고, tracked 파일 변경은 계속 수집한다. |
| artifact root가 workspace root인 레거시 구성은 별도 고려가 필요하다. | `p2a_run_paths.mjs`의 workspace hash 제외 목록에는 `evidence`가 없다. | 그 구성에서 새 evidence가 제품 revision을 바꾸지 않는지 확인하고 해당 관리 경로만 제외한다. |
| 보관 근거를 모르면 자동 삭제 범위를 결정할 수 없다. | run GC는 알려진 run/sidecar를 다루며 임의 검증 폴더의 수명은 모른다. | 기존 5.6GB 자료의 청소는 별도 작업으로 분리한다. 날짜 기반 GC를 추가하지 않는다. |

## 9. 구현 범위와 검증

### 반영: 이름 생성과 파일 작성 위치

이름 생성 코드와 배포 지침을 함께 반영한다. 신규 CLI 명령·정본 schema·보고서 등록부는 추가하지 않는다.

**A. 다음 반복의 기본 이름 수정**

- 대상: `scripts/p2a_iteration.mjs`의 `generatedNextIterationId`와 이를 호출하는 `openLocked`.
- `open`/`replace-scope`의 ID 생략 시에만 순번 규칙을 적용한다. 기존 참조와 archived artifact를 쓰거나 이동하지 않는다.
- 테스트: legacy 긴 이름에서 `iter-0001` 생성, 번호 공백과 closed 기록, 같은 이름의 파일·링크, 9999 이후 번호, 명시적 ID 유지, pending 상태에서 재호출 거부, 동시 open에서 한 개만 성공하고 고아 폴더가 남지 않음.
- 기존 `tests/run-id-strategy.test.mjs`의 lifecycle/동시성 fixture를 재사용한다. 구현을 그대로 복제한 단위 테스트보다 실제 open 결과와 포인터를 확인한다.

**B. 배포되는 작성 지침과 실행 증거 경계 수정**

- 대상 reference: harness의 `artifact-persistence-and-evidence.md`, dev-execution의 `execution-lifecycle.md`, `verification-closeout.md`, `closeout-choices.md`. 필요한 spec 작성 reference도 확인한다.
- 시작 시 보조 자료 위치를 정하고, 종료 시 필요한 근거 보존과 자신이 만든 임시 환경 정리 여부를 확인하도록 최소 규칙을 포함한다. CLI가 반환한 정본 경로는 항상 우선한다.
- `scripts/sync_cli_assets.mjs`로 mirror를 생성한다. provider 파일을 개별 편집하거나 전체 규칙 문서를 매번 context에 넣지 않는다.
- `scripts/p2a_runs.mjs`에서 tmp의 untracked 변경 제외를 보완한다. tracked 변경과 명시적 changed-file은 숨기지 않는다.
- `scripts/p2a_run_paths.mjs`에서는 legacy root 구성의 `evidence/`만 관련 제외 규칙에 포함한다. 모든 폴더 이름 `evidence`를 전역 제외하지 않는다.
- 테스트: tmp가 제품 changedFiles에 섞이지 않음, tracked 변경은 보임, 증거만 추가해도 제품 revision이 바뀌지 않음, 코드 변경은 revision을 바꿈, mirror/context가 일치함.

### 반영: 설치된 형태의 사이클 검증

- `tests/npm-package.test.mjs`에서 로컬 tarball을 임시 디렉터리에 설치하고 실제 코드 수정 → 검증 → 보고서 보존 → 임시 환경 제거 → 최종 검증 → close → ID 없는 open을 수행한다. 운영 중인 BuildLore는 수정하지 않는다.
- run 있는 작업과 없는 검토를 notes/evidence 위치에 작성하고, 실제 검증 출력에서 로그를 보존한다. run 정리 뒤에도 보고서와 로그가 남는지 확인한다.
- 설치된 skill reference가 원본과 일치하는지 확인한다. 이 자동 테스트는 CLI 호환성과 지침 전달을 검증하며, 독립적인 agent 행동 평가나 모든 파일 작성의 강제를 입증하지는 않는다.
- 완료 조건: 새 `-next` 누적이 없고, 검증 세션에서 artifact 루트에 임의 작업 폴더가 추가되지 않으며, 임시 환경을 제거해도 보고서의 필요한 근거가 남는다. 기존 Gate·close·run-retention 검증도 유지한다.

### 후속: BuildLore 기존 자료 정리

- 위 변경과 분리해서 실제 폴더별 소유 작업·참조·재현 가능성을 목록화한다.
- 삭제 대상이 확인된 임시 설치 환경부터 처리한다. 정본 문서 개명과 일괄 migration은 수행하지 않는다.
- 신규 위치를 지켜도 누적이 반복될 때만 owner metadata와 명시적 cleanup 명령을 검토한다. 범용 GC·보존 기간 설정·크기 dashboard는 선행 조건이 아니다.

### 구현 후 검증 명령

변경 중에는 해당 테스트만 실행하고, 통합 후 기존 회귀·패키지 검사를 한 번 완료한다.

```sh
node --test tests/run-id-strategy.test.mjs tests/run-retention.test.mjs tests/next-decision.test.mjs
node scripts/sync_cli_assets.mjs --check
node scripts/check_cli_parity.mjs
npm test
npm run test:full
npm run test:package
```

관련 회귀는 기본 이름, 충돌·동시성·안전 정수 범위, 기존 감사 기록 보존, tmp 변경 수집, 표준/레거시 workspace revision, 설치된 reference와 실행 사이클을 확인한다. 보조 보고서 위치는 운영 지침이므로 실제 사용에서 이탈이 발견되면 해당 작성 경로를 먼저 보완한다.
