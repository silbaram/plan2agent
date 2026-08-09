# Plan2Agent 릴리스 절차

이 문서는 npm package, Git tag, GitHub Release를 같은 버전과 source commit으로 게시하기 위한 maintainer checklist다. npm에 게시된 version은 변경할 수 없으므로 각 단계에서 정확한 version과 commit을 확인한다.

## 지원 정책

- version은 [Semantic Versioning](https://semver.org/)을 따른다.
- 사용자에게 보이는 변경은 [CHANGELOG](../CHANGELOG.md)의 `Unreleased`에 먼저 기록한다.
- Node.js는 공식 지원 상태인 major만 지원한다. 현재 최소 version은 Node.js 22이며 CI는 Node.js 22, 24, 26에서 일반 test를 실행한다.
- npm package와 GitHub Release는 동일한 `package.json` version을 사용한다.
- release tag는 `v<package-version>` 형식의 annotated tag다.

## 1. Release PR 준비

현재 `main`을 기준으로 release branch를 만든다.

```bash
git switch main
git pull --ff-only
git switch -c agent/release-<version>
```

package version만 변경하고 자동 commit/tag는 만들지 않는다.

```bash
npm version <version> --no-git-tag-version
```

`CHANGELOG.md`에서 다음을 함께 수행한다.

1. `Unreleased`의 사용자 영향 변경을 `<version> - YYYY-MM-DD` 아래로 이동한다.
2. 빈 `Unreleased` section을 다시 만든다.
3. 문서 하단 compare link를 새 version 기준으로 갱신한다.
4. breaking change, migration, 최소 Node version 변경을 명시한다.

Release PR에는 package version, CHANGELOG, 필요한 README/문서 변경만 포함하고 아래 검증 결과를 기록한다.

## 2. Release 검증

지원 기준의 최소 Node.js version에서 먼저 실행하고 CI matrix 전체가 통과하는지 확인한다.

```bash
npm test
npm run test:full
npm run test:package
npm pack --dry-run
git diff --check
```

추가 확인 사항:

- `npm pack --dry-run`의 package name/version이 예상값과 일치한다.
- 새 runtime script와 schema가 package file list에 포함된다.
- README의 설치 명령과 Node 지원 version이 `package.json`과 일치한다.
- release version이 아직 npm에 존재하지 않는다.

```bash
npm view plan2agent@<version> version
```

마지막 명령이 `E404`를 반환해야 새 version을 게시할 수 있다. 다른 권한·network 오류를 미배포 증거로 해석하지 않는다.

## 3. Merge commit 고정과 tag 게시

Release PR을 `main`에 merge한 뒤 clean checkout에서 merge commit을 확인한다.

```bash
git switch main
git pull --ff-only
git status --short
git log -1 --oneline
```

`package.json`과 CHANGELOG version이 일치하면 annotated tag를 만들고 명시적으로 게시한다.

```bash
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

Tag를 다른 commit으로 이동하거나 이미 게시된 tag를 재사용하지 않는다. 잘못된 tag가 게시됐다면 npm publish 전에 중단하고 원인을 기록한다.

## 4. npm 게시

배포 권한이 있는 npm 계정과 package 상태를 확인한다. 토큰이나 OTP는 issue, PR, log에 기록하지 않는다.

```bash
npm whoami
npm view plan2agent version
npm publish --access public
```

게시 후 registry가 exact version과 `latest` dist-tag를 반환하는지 확인한다.

```bash
npm view plan2agent@<version> version
npm view plan2agent dist-tags --json
```

## 5. GitHub Release 게시

GitHub Releases에서 이미 게시한 `v<version>` tag를 선택하고 다음 정보를 작성한다.

- Title: `Plan2Agent v<version> — <short release theme>`
- Summary: 사용자에게 가장 중요한 결과 한 문단
- Highlights: `CHANGELOG.md`의 사용자 영향 변경
- Upgrade: 기존 version에서 필요한 정확한 명령
- Compatibility and safety: Node version, runtime 제한, breaking change
- Verification: 실행한 test와 package 검증
- Related: issue, PR, npm package, compare link

정식 version은 `Set as the latest release`를 선택하고 pre-release가 아니면 `This is a pre-release`를 선택하지 않는다. GitHub가 자동으로 제공하는 source archive 외에 npm tarball을 별도로 첨부하지 않는다.

## 6. 설치 smoke test와 종료

별도 임시 project 또는 안전한 test project에서 공개 package를 설치해 CLI entrypoint를 확인한다.

```bash
npm install --global plan2agent@<version>
npm list --global plan2agent --depth=0
p2a --help
```

기존 project의 migration이 포함된 release라면 해당 project에서 먼저 preview한다.

```bash
p2a upgrade --dry-run
p2a upgrade --apply
```

마지막으로 관련 release issue를 `completed`로 닫고 npm URL, GitHub Release URL, tag commit, 검증 결과를 종료 comment에 남긴다.

## 실패 처리

- npm version은 같은 번호로 덮어쓸 수 없다. 잘못 게시했다면 해당 version을 `npm deprecate`하고 수정한 patch version을 새로 배포한다.
- npm publish 전 tag 단계에서 실패하면 publish하지 않고 tag/source 상태부터 복구한다.
- npm publish 후 GitHub Release 생성이 실패하면 tag는 유지하고 동일 tag로 Release 작성만 재시도한다.
- package publish는 성공했지만 project migration이 실패하면 package publish와 project 적용 실패를 구분해 공지하고 수정 patch를 준비한다.
- `latest` dist-tag가 잘못됐으면 package를 재게시하지 말고 npm dist-tag를 교정한다.
