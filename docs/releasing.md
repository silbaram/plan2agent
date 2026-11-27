# Plan2Agent 릴리스 절차

npm 패키지와 GitHub Release를 동일한 버전 및 커밋으로 게시하기 위한 체크리스트입니다.

## 지원 정책

- Semantic Versioning을 따릅니다.
- 최소 Node.js 버전은 `package.json`의 `engines.node`(`>=22.0.0`)이며 외부 npm 런타임 의존성은 0개입니다.
- 릴리스 태그는 `v<version>` 형식의 annotated tag를 사용합니다.

## 1. 버전 준비

```bash
git switch main
git pull --ff-only
git switch -c release/v<version>
npm version <version> --no-git-tag-version
```

`CHANGELOG.md`에 변경 사항과 호환성(breaking change 여부)을 정리합니다.

## 2. 릴리스 검증

```bash
npm run test:all
npm pack --dry-run
git diff --check
```

확인 항목:
- `npm run test:all` (단위·통합 테스트 + `check_cli_parity.mjs`) 전체 통과
- `npm pack --dry-run` 결과에 `scripts/`, `schemas/`, `.agents/`, `.claude/`, `.codex/`, `.gemini/`만 포함되고 `docs/`, `tests/`가 제외됨
- `npm view plan2agent@<version> version`이 `E404`를 반환함

## 3. 태그 및 배포

`main` 머지 후:

```bash
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
npm publish --access public
```

게시 후 확인:

```bash
npm view plan2agent@<version> version
npm view plan2agent dist-tags --json
```

GitHub Releases에서 `v<version>` 태그로 릴리스 노트를 발행합니다.
