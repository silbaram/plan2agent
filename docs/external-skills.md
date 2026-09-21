# 외부 Agent Skills 관리

Plan2Agent는 검토한 `skills@1.7.0` CLI를 source 탐색 전용 adapter로 사용하고, 최종 파일과 소유권은 P2A가 관리한다. 이 기능에는 Node.js 22.20.0 이상이 필요하다. `npx skills@latest`를 실행하지 않으며 source repository의 setup script나 hook도 실행하지 않는다.

## 빠른 흐름

먼저 초기화된 프로젝트에서 source가 제공하는 스킬을 조회한다. 조회와 dry-run은 완료 후 staging을 제거하며 프로젝트 파일을 바꾸지 않는다.

```bash
p2a skills source vercel-labs/agent-skills --list
p2a skills add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  --tools codex,claude,gemini \
  --dry-run
```

계획의 source, resolved commit, file diff, 설치 경로를 검토한 뒤 적용한다. 모든 `--apply`에는 같은 명령의 dry-run에서 받은 `Plan` SHA-256을 `--expect-plan`으로 반드시 전달한다. source나 설치 상태가 바뀌면 갱신된 계획을 출력하고 적용을 중단한다.

```bash
p2a skills add vercel-labs/agent-skills \
  --skill web-design-guidelines \
  --tools codex,claude,gemini \
  --apply \
  --expect-plan <dry-run-plan-sha256>

p2a skills list
p2a doctor --dev --strict
```

프로젝트 안의 local fixture도 사용할 수 있다. 팀 lock에 개인 checkout 경로가 남지 않도록 local source는 target 내부의 상대 경로만 허용한다.

```bash
p2a skills add ./tools/agent-skills --skill project-review --dry-run
p2a skills add ./tools/agent-skills --skill project-review --apply --expect-plan <dry-run-plan-sha256>
```

## 저장 위치와 소유권

| 대상 | 실제 경로 | lock target 의미 |
| --- | --- | --- |
| Codex | `.agents/skills/<name>/` | `agents-shared` |
| Gemini CLI | `.agents/skills/<name>/` | `agents-shared` |
| Claude Code | `.claude/skills/<name>/` | `claude` |

Codex와 Gemini를 함께 선택해도 shared copy는 한 번만 만든다. Claude를 선택하면 같은 검증 바이트를 별도 projection으로 복사한다. symlink는 남기지 않는다.

프로젝트 루트의 `p2a-skills.lock.json`은 팀이 추적하는 선언이다. source 종류와 portable source, skill path, requested ref, resolved Git commit, 전체 content SHA-256, 파일별 SHA-256, provider target을 기록한다. `.plan2agent/manifest.json`은 로컬 설치 상태를 `externalSkills`, `externalSkillFiles`, `external-skill:<name>` managed owner로 기록한다.

P2A core skill·agent·hook·command는 계속 `p2a init/update/upgrade`가 소유한다. 외부 명령은 기존 P2A managed path와 비소유 경로를 덮어쓰지 않는다. `p2a update`와 `p2a upgrade`는 외부 record와 파일을 보존한다. `init`은 manifest가 없는 새 복제 환경에서도 공유 lock의 경로를 보호하며, `enhance dev-skills --overwrite`도 외부 소유권을 덮어쓸 수 없다. `handoff --overwrite` 역시 충돌을 차단하고 기존 외부 스킬 설치 기록을 보존한다. 기존 프로젝트에 handoff할 때는 외부 스킬 적용과 같은 프로젝트 lock을 사용한다.

## 업데이트, 복원, 제거

```bash
p2a skills update web-design-guidelines --dry-run
p2a skills update web-design-guidelines --apply --expect-plan <dry-run-plan-sha256>

p2a skills sync --dry-run
p2a skills sync --apply --expect-plan <dry-run-plan-sha256>

p2a skills remove web-design-guidelines --dry-run
p2a skills remove web-design-guidelines --apply --expect-plan <dry-run-plan-sha256>
```

`update`는 같은 source/ref의 최신 resolved commit을 staging에서 다시 검증한다. 설치 파일이 lock과 다르면 수정본을 자동으로 덮어쓰지 않고 차단한다. `remove`도 소유 파일이 수정됐으면 차단한다.

`sync`는 lock에 고정된 commit과 digest를 재현해 누락된 provider copy만 복원한다. 수정된 파일, 추가 파일, 소유권 없는 기존 copy는 `manual_review`로 차단한다. local source는 현재 source 바이트가 lock digest와 같을 때만 복원할 수 있다. source를 의도적으로 바꿨다면 먼저 설치 copy를 원래 상태로 복구한 뒤 `update --apply`로 새 digest를 기록한다.

모든 apply는 `.plan2agent` lock을 잡고 provider directory, root lock, manifest를 rollback 가능한 transaction으로 갱신한다. 프로세스가 중단돼도 조회와 dry-run은 복구 기록이나 파일을 변경하지 않는다. `p2a skills recover --dry-run`으로 확인한 뒤 `p2a skills recover --apply --expect-plan <dry-run-plan-sha256>`으로 복구한다. 미완료 transaction은 롤백하며, 이미 metadata commit이 끝났으면 남은 임시 파일만 정리한다.

복구 계획에는 대상 파일, 백업, 임시 복사본, manifest와 lock의 현재 상태가 포함된다. 검토 후 파일을 추가·수정·삭제하거나 권한을 바꾸면 같은 계획 해시로 복구할 수 없다. 새 dry-run에서 복구 대상을 다시 확인해야 한다.

manifest에만 남아 있는 외부 스킬 기록은 다른 명령이 자동으로 지우지 않는다. 먼저 해당 설치와 일치하는 lock을 복원하거나 소유권 불일치를 직접 정리한다. lock에만 선언된 스킬은 `sync`로 복원하며, 다른 스킬의 `add`나 `update`가 누락된 소유권을 임의로 인수하지 않는다.

## 신뢰 경계

외부 스킬 설치는 instruction을 신뢰한다는 뜻이 아니다. `SKILL.md`는 이후 coding agent의 행동에 영향을 주며 agent가 가진 권한으로 명령 실행이나 파일 수정을 유도할 수 있다. 적용 전에 본문과 포함 파일을 검토하고 source owner와 commit을 확인한다.

원격 Git source는 checkout하지 않은 고정 commit의 tree mode와 blob을 추가 검사한다. upstream이 링크를 일반 파일로 복사해도 최종 설치 전에 차단한다.

주석이 있는 태그도 실제 커밋으로 해석해 고정한다. Git checkout에는 전용 임시 template과 설정을 사용해 사용자 `core.autocrlf`·`core.eol` 및 저장소의 줄바꿈·checkout filter 변환을 적용하지 않는다. 설치와 검증은 원본 Git blob 바이트를 기준으로 하며, 사용자 Git 설정 파일은 변경하지 않는다.

파일 순서와 해시는 PC의 언어·지역 설정에 영향을 받지 않는다. `git://` source도 태그와 commit 고정을 지원하며, 공유 lock에는 원래 저장소 URL을 기록한다.

P2A는 설치 시 다음을 차단한다.

- symbolic link, device, socket, 중간 symlink와 skill root 밖 경로
- absolute path, traversal, Windows reserved name, 파일·디렉토리 전체의 case-insensitive 충돌
- 파일 수, 개별 파일 크기, 전체 byte 제한 초과
- 잘못된 `name`/`description` frontmatter
- P2A core managed path와 기존 비소유 path 충돌
- credential userinfo가 들어간 URL, 프로젝트 밖 local source, 고정 commit을 해석할 수 없는 Git source

GitHub/GitLab/private Git 인증은 기존 Git 또는 `gh` credential helper를 사용한다. credential이나 개인 home path는 lock과 정상 JSON 결과에 기록하지 않는다.

## 문제 해결

`p2a doctor --dev --strict`는 root lock, manifest inventory/owner, 실제 regular file과 SHA-256을 함께 검사한다. 다른 설치 기록 없이 외부 managed owner만 남아 있거나 한 파일에 소유권이 중복 기록된 경우도 오류로 보고한다.

- `hash_mismatch`: 설치 copy가 수정됐다. 수정본을 보존하고 변경을 검토한 뒤 직접 정리해야 한다. `sync`로 덮어쓸 수 없다.
- `missing`: provider copy가 없다. pinned source가 재현되면 `sync --apply`로 복원한다.
- `manifest_*_mismatch`: lock과 manifest 소유권이 다르다. 먼저 core `p2a update --dry-run`과 external `sync --dry-run`을 확인한다.
- `upstream_version_mismatch`: 다른 P2A release가 lock을 작성했다. P2A package version을 팀과 맞춘 뒤 다시 진단한다.
- update source 조회 실패: 기존 lock, manifest, 설치 파일은 그대로 유지된다. 네트워크와 Git 인증을 고친 뒤 다시 실행한다.

외부 스킬을 직접 복사하거나 `npx skills add`로 같은 provider 경로에 설치하면 P2A 소유권 계약 밖의 파일이 생긴다. 프로젝트에서는 `p2a skills`만 사용한다.
