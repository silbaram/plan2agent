# Harness — Design System

> *AI 코딩 에이전트의 하네스(harness). 한 곳에서 Codex, Claude Code, Gemini CLI를 운용한다.*

Harness는 여러 AI CLI 도구의 보조 UI를 제공하는 Electron 데스크톱 앱이다. 이 디자인 시스템은 그 앱의 비주얼 언어를 정의한다 — VSCode/Zed의 IDE 하이브리드 레이아웃 위에, 도트 캐릭터로 에이전트 상태를 의인화하는 것이 핵심 모티프.

## 세 가지 원칙

1. **워크호스, 장식 아님.** 대시보드가 아니라 작업 공간. 12px 모노 메타데이터, 13px 산세리프 본문, 텍스트 라벨이 아이콘보다 우선. 데이터를 위해 장식하지 않는다.
2. **에이전트는 캐릭터다.** 모든 에이전트 — Claude, Codex, Gemini, Aider, sub-agent — 는 8×8 픽셀 도트 캐릭터로 표현된다. idle/thinking/typing/tool/skill/sleep/error/done 등 9가지 상태가 작은 애니메이션으로 구분된다. 진행 막대 대신 캐릭터의 표정이 상태를 말한다.
3. **다크 우선, 따뜻한 잉크.** 순수 #000은 쓰지 않는다. `#0F0F0D` 잉크 위에 `#FF5B2E` vermilion 액센트 하나. Atelier의 모노톤 + 단일 액센트 철학을 다크 환경으로 옮긴 것.

---

## Sources

이 시스템은 Atelier 디자인 시스템(개인 갤러리용)의 토큰 철학 위에 구축됐다.
- 폰트: NanumSquareNeo (한글) + JetBrains Mono (모노)
- 액센트 컬러: Atelier vermilion `#FF5B2E` 그대로 — 어두운 표면에서 약간 더 hot하게 느껴짐
- 다크 팔레트는 새로 정의 (`#0F0F0D` 잉크-블랙 베이스)

참고한 모던 터미널: Warp, Wave, Ghostty, Zed.

---

## Index

```
.
├── README.md                          ← this file
├── SKILL.md                           ← agent skill manifest
├── design-system/
│   ├── harness.css                    ← 모든 토큰 (color, type, spacing, motion)
│   ├── dot-character.jsx              ← 도트 캐릭터 컴포넌트 + 9 글리프
│   ├── atoms.jsx                      ← Icon, ProviderMark, TokenPill, AgentRow
│   ├── chrome.jsx                     ← HarnessChrome 윈도우 프레임
│   ├── mock-data.jsx                  ← 데모용 데이터
│   └── fonts/NanumSquareNeo-Variable.ttf
├── preview/                           ← Design System 탭 카드
│   ├── color-*.html
│   ├── type-*.html
│   ├── spacing-*.html
│   ├── component-*.html
│   └── brand-dotchar.html
├── variations/
│   ├── v1-operator.jsx                ← IDE 3-pane
│   ├── v2-console.jsx                 ← terminal-forward
│   ├── v3-roster.jsx                  ← agent grid
│   ├── v4-pipeline.jsx                ← swim lanes
│   ├── v5-companion.jsx               ← single-agent panel
│   └── v6-mosaic.jsx                  ← 2×2 split
├── screens/                           ← 추가 애플리케이션 화면
│   ├── settings.html
│   ├── command-palette.html
│   ├── mcp-servers.html
│   └── cost-dashboard.html
└── Harness Design Exploration.html    ← 모든 시안 + Tweaks 패널
```

---

## Voice & Copy

**톤:** 도구다운 톤. 친절하지 않다. 짧다. 한국어 + 영어 자연스럽게 섞임. 에이전트 이름과 명령어는 lowercase 영어, 사용자 입력 본문은 한국어 그대로.

**Casing**
- UI 라벨: lowercase (`new session`, `pause`, `apply`, `세션`)
- 키 단축키: `⌘K`, `⌘↵`, `⌘\` — 모노 폰트에 squircle 보더
- 토큰/cost: 모노, tabular numbers (`27.9k tok · $0.42`)

**없는 것**
- 이모지 ❌
- 느낌표 ❌
- "Welcome" / "Successfully" 같은 마케팅 문구 ❌
- 그라데이션 ❌

**있는 것**
- `done` / `idle` / `thinking` 상태어
- `00:04:12` 듀레이션
- `+8 −3` diff 카운트
- `●` (active) / `○` (idle) 점

---

## Color

### Surfaces — 다크 우선
모두 warm-leaning. 순수 `#000` 금지.

| Token | Hex | 용도 |
|---|---|---|
| `--bg-0` | `#0A0A09` | 앱 chrome edge, titlebar |
| `--bg-1` | `#0F0F0D` | 기본 캔버스, 메인 패널 |
| `--bg-2` | `#15140F` | 사이드바, 인스펙터 |
| `--bg-3` | `#1B1A14` | 카드, hover row |
| `--bg-4` | `#232118` | 입력 필드, pressed |
| `--bg-5` | `#2D2A1F` | 선택된 row |

### Foreground — paper-warm grayscale

| Token | Hex | 용도 |
|---|---|---|
| `--fg-1` | `#EFEAD8` | primary text |
| `--fg-2` | `#C4BFAE` | secondary |
| `--fg-3` | `#8A8780` | meta, timestamps |
| `--fg-4` | `#5C5A52` | placeholder, disabled |
| `--fg-5` | `#3A3933` | hairline labels |

### Borders

| Token | Hex |
|---|---|
| `--border-1` | `#25241D` |
| `--border-2` | `#34322A` |
| `--border-3` | `#4A4738` |

### Brand & Status

- `--accent` `#FF5B2E` — Atelier vermilion. *한 화면당 최대 2~3회.* CTA, 진행 중인 도구 호출, 현재 선택된 row의 borderLeft.
- `--ok` `#8FB66B` · `--warn` `#E0A647` · `--err` `#E5654B` · `--info` `#6B9BB8`

### Provider tints
각 AI 도구는 1px 보더 또는 16px monogram에서만 사용. fill로 쓰지 않음.

| Provider | Tint | Mark |
|---|---|---|
| Claude  | `#D97757` | C |
| Codex   | `#A8B1A0` | O |
| Gemini  | `#6B9BB8` | G |
| Aider   | `#B89968` | A |
| Cursor  | `#C4BFAE` | U |

---

## Typography

두 가족, 둘 다 변경 가능.

- **NanumSquareNeo** (variable, 100–900) — 본문, UI 라벨, 한글
- **JetBrains Mono** — 인덱스, 타임스탬프, 키 단축키, 도구 호출, 토큰/비용

### 스케일 (denser than gallery — 작업 도구)

| Token | Size / LH | 용도 |
|---|---|---|
| `--t-display` | 40 / 1.1 | hero 숫자, 비용 표시 |
| `--t-h1` | 24 / 1.3 | 페이지 타이틀 |
| `--t-h2` | 18 / 1.3 | 섹션 타이틀 |
| `--t-h3` | 14 / 1.3 | 카드 타이틀 |
| `--t-body` | 13 / 1.5 | 기본 |
| `--t-small` | 12 / 1.5 | 메타 |
| `--t-mono` | 12 / 1.5 | 코드 |
| `--t-mono-s` | 11 / 1.4 | 인덱스, 타임스탬프 |
| `--t-micro` | 10 / 1.4 | UPPERCASE 라벨, 배지 |

### Weight
300 (light, display only) · 400 (regular) · 500 (medium, UI) · 700 (bold, headings).

---

## Spacing & Layout

4px base. `--s-1` (4) → `--s-8` (64).

**Layout 토큰**
- `--titlebar-h: 36px`
- `--activitybar-w: 48px`
- `--sidebar-w: 260px`
- `--inspector-w: 320px`
- `--statusbar-h: 24px`
- `--tab-h: 32px`

화면 dim은 dense하게: 사이드바 14px padding, 카드 12-16px, 패널 사이는 1px hairline `var(--border-1)`로만 분리. shadow는 모달과 floating chip에만.

---

## Radii

- `--r-0: 0` — IDE-feel default
- `--r-1: 3` — 버튼, 입력 필드, 칩
- `--r-2: 6` — 패널, 카드
- `--r-3: 10` — 모달
- `--r-pill: 999`

각도(angles)는 **0이 기본값.** Roundness는 'tap-friendly'한 컨트롤에만.

---

## Motion

| Token | Value |
|---|---|
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.1, 1)` |
| `--ease-in-out` | `cubic-bezier(0.7, 0, 0.3, 1)` |
| `--ease-step` | `steps(4, end)` ← 도트 캐릭터 |
| `--dur-fast` | 100ms |
| `--dur-base` | 200ms |
| `--dur-slow` | 400ms |
| `--dur-blink` | 900ms ← 캐릭터 idle blink, 커서 깜빡임 |

도트 캐릭터는 `setInterval` 기반 4fps 프레임 시퀀스. CSS animation은 `harness-blink`(커서) 정도만.

---

## Dot Character — 시그니처 모티프

8×8 픽셀 그리드, CSS `box-shadow`로 단일 픽셀에 그려진다. canvas/SVG 아님 — 가볍고, 다크모드에서 또렷하다.

### 9가지 상태

| State | 의미 | 애니메이션 |
|---|---|---|
| `idle` | 대기 중 | 입 깜빡임 (2 frames) |
| `thinking` | LLM 사고 | 점이 머리 위 회전 (4 frames) |
| `typing` | 응답 생성 | 손이 키보드 위 (2 frames) |
| `tool` | 도구 호출 중 | 렌치/스파클 회전 (2 frames) |
| `skill` | 스킬 활성 | 글로우 점멸 (2 frames) |
| `sleep` | 일시 정지 | "z" 부유 (2 frames) |
| `error` | 실패 | × 눈, 정지 |
| `done` | 완료 | 미소, 정지 |
| `waiting` | 입력 대기 | "..." 점멸 |

### 색상 슬롯

- `o` (`--fg-1`) — 주 픽셀
- `-` (`--fg-4`) — dim 픽셀 (눈, 입 안쪽)
- `*` (`--accent`) — 액센트 픽셀 (도구 스파클, 사고 점)

### 사이즈

- 1.5px — sub-agent row (사이드바 nested)
- 2px — sidebar session row, status bar
- 3px — chip 안, 카드 미니 히어로
- 6-8px — 인스펙터/Companion 히어로

```jsx
<DotChar state="tool" size={3} />
```

---

## Iconography

**원칙: 텍스트 라벨이 아이콘을 이긴다.** 아이콘은 보조 시그널.

- **1.5px 스트로크**, square caps, no fill
- 24×24 viewBox, 12-16px 시각 사이즈
- `currentColor` 만 — 액센트 적용 시 인터랙션 상태 표시
- 자체 paths (Lucide 비슷한 어휘): `folder`, `file`, `chevron-right/down`, `plus`, `play/pause`, `search`, `settings`, `terminal`, `diff`, `git/git-branch`, `bell`, `layers`, `sparkle`, `check`, `x`, `eye`, `history`

이모지 없음.

---

## Components

각 컴포넌트는 `design-system/atoms.jsx`에 정의. 6개 베리에이션이 모두 이 atoms 위에서 구성됨.

- **`<DotChar />`** — 도트 캐릭터
- **`<DotTiny />`** — 5×5 inline 미니 도트 (active/idle/done/error/sleep)
- **`<Icon />`** — 1.5px 스트로크 아이콘
- **`<ProviderMark />`** — 14px monogram (C/O/G/A/U)
- **`<TokenPill />`** — `27.9k ↓↑ 3.1k` 모노 카운터
- **`<AgentRow />`** — 사이드바/리스트 row (도트 + 마크 + 라벨 + 토큰)
- **`<HarnessChrome />`** — 윈도우 프레임 (titlebar + traffic lights + project)
- **`<TranscriptRow />`** — user/agent/tool/diff 4종 메시지 row (in v1-operator.jsx)
- **`<ConsoleLine /> / <ConsoleTool /> / <ConsoleDiff />`** — 터미널 뷰 row 3종

## Layout templates

- **3-pane IDE** (Operator) — activitybar(48) + sidebar(260) + main(flex) + inspector(320)
- **Console** — 56 thin rail + main, floating agent chip
- **Roster** — 3-col card grid + 480 right transcript
- **Pipeline** — 220 lane label + flex track, time ruler
- **Companion** — 72 picker + main, hero centered
- **Mosaic** — 2×2 grid with 1px hairline gap

---

## How to use

1. 모든 HTML에서 `design-system/harness.css` 링크
2. semantic 토큰만 사용 (`var(--bg-1)`, `var(--fg-2)` 등) — raw hex 금지
3. `atoms.jsx` + `dot-character.jsx`를 먼저 로드한 뒤 페이지 스크립트
4. 새 화면을 만들 때 `<HarnessChrome>` 으로 감싸 윈도우 프레임 통일

자세한 컴포넌트 사용법은 `preview/` 카드들 참고.
