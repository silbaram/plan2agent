/* global React */
/*
  Dot Character — 8x8 pixel sprite that represents an agent's state.
  Drawn with CSS box-shadow on a single pixel — no canvas, no SVG.
  Each character has named states: idle, thinking, typing, tool, skill, sleep, error, done.
*/

const DOT_PX = 3;       // size of each "pixel"
const DOT_GAP = 0;      // pixel gap (0 = solid pixel art)
const DOT_GRID = 8;     // 8x8 sprite

// Glyph dictionary — each frame is a string of 8 rows × 8 chars.
// '.' = off, 'o' = on (fg), '*' = accent, '-' = dim
//
// Cute chibi mascot: large round head (rows 1-5) + tiny body (rows 6-7).
// Big sparkly eyes (2-pixel) + small mouth + accent blush on cheeks.
const GLYPHS = {
  // ─── idle: blinking, gentle breathe ─────────────────────────
  idle: [
    [
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",  // big eyes
      "*oooooo*",  // blush
      ".o.oo.o.",  // tiny smile
      "..oooo..",  // body
      ".o....o.",  // legs
    ],
    [
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",
      "*oooooo*",
      ".oooooo.",  // breathe
      "..oooo..",
      ".o....o.",
    ],
    [
      "..oooo..",
      ".oooooo.",
      "oooooooo",  // blink
      "oo----oo",
      "*oooooo*",
      ".o.oo.o.",
      "..oooo..",
      ".o....o.",
    ],
    [
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",
      "*oooooo*",
      ".o.oo.o.",
      "..oooo..",
      ".o....o.",
    ],
  ],

  // ─── thinking: ? bubble + side glance ───────────────────────
  thinking: [
    [
      "...**...",
      "..oooo..",
      ".oooooo.",
      "ooo.ooo.",  // eyes glance left
      "ooo.ooo.",
      "*oooooo*",
      ".o.oo...",
      "..oooo..",
    ],
    [
      "....*...",
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",
      "*oooooo*",
      "..oo.o..",  // mouth pucker
      "..oooo..",
    ],
    [
      "...**...",
      "..oooo..",
      ".oooooo.",
      ".oo.ooo.",  // eyes glance right
      ".oo.ooo.",
      "*oooooo*",
      "...oo.o.",
      "..oooo..",
    ],
  ],

  // ─── typing: happy bouncing, mouth open singing ─────────────
  typing: [
    [
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",
      "*oooooo*",
      ".oo..oo.",  // open mouth
      "..oooo..",
      "oo....oo",  // arms out (typing)
    ],
    [
      "..oooo..",
      ".oooooo.",
      "oo.oo.oo",
      "oo.oo.oo",
      "*oooooo*",
      ".oooooo.",
      "..oooo..",
      ".oo..oo.",  // arms in
    ],
  ],

  // ─── tool: ★ sparkle + happy eyes (^ ^) ─────────────────────
  tool: [
    [
      "*..**..*",
      "..oooo..",
      ".oooooo.",
      "oo----oo",  // ^ ^ closed-arc happy eyes
      "ooo--ooo",
      "*oooooo*",
      ".o.oo.o.",
      "..oooo..",
    ],
    [
      "...**...",
      "*.oooo.*",
      ".oooooo.",
      "oo----oo",
      "ooo--ooo",
      "*oooooo*",
      ".o.oo.o.",
      "..oooo..",
    ],
  ],

  // ─── skill: glowing aura + heart eyes ───────────────────────
  skill: [
    [
      "*......*",
      "..oooo..",
      ".oooooo.",
      "o*o.o*o.",  // heart eyes (sparkle in pupil)
      "oooooooo",
      "*oo..oo*",  // big smile
      ".oooooo.",
      "..oooo..",
    ],
    [
      ".*....*.",
      "*.oooo.*",
      ".oooooo.",
      "oo*.oo*.",
      "oooooooo",
      "*oo..oo*",
      ".oooooo.",
      "..oooo..",
    ],
  ],

  // ─── sleep: zzz + sleepy closed eyes (- -) ──────────────────
  sleep: [
    [
      "....-z..",
      "...z....",
      "..oooo..",
      ".oooooo.",
      "oo----oo",  // closed eyes
      "*oooooo*",
      "...oo...",  // tiny mouth
      "..oooo..",
    ],
    [
      "...-z...",
      "..z.....",
      "..oooo..",
      ".oooooo.",
      "oo----oo",
      "*oooooo*",
      "...oo...",
      "..oooo..",
    ],
  ],

  // ─── error: dizzy x_x eyes, sweat drop ──────────────────────
  error: [
    [
      ".......*",  // sweat drop
      "......*.",
      "..oooo..",
      ".oooooo.",
      "*o.oo.o*",  // x x eyes (accent)
      ".oooooo.",
      "..oooo..",  // wobbly mouth
      "..o..o..",
    ],
    [
      "......**",
      ".......*",
      "..oooo..",
      ".oooooo.",
      "o*.oo.*o",
      ".oooooo.",
      "..oooo..",
      "..o..o..",
    ],
  ],

  // ─── done: big smile, closed-arc happy eyes + sparkles ──────
  done: [
    [
      "..*..*..",
      "..oooo..",
      ".oooooo.",
      "oo----oo",  // ^ ^ eyes
      "ooo--ooo",
      "*oooooo*",
      ".oo..oo.",  // big smile
      "..oooo..",
    ],
    [
      "...*....",
      ".*oooo*.",
      ".oooooo.",
      "oo----oo",
      "ooo--ooo",
      "*oooooo*",
      ".oo..oo.",
      "..oooo..",
    ],
  ],

  // ─── waiting: looking up, dots ──────────────────────────────
  waiting: [
    [
      "..oooo..",
      ".oooooo.",
      "ooooo.oo",
      "ooooo.oo",  // eyes look up-right
      "*oooooo*",
      "...oo...",
      "..oooo..",
      "*.......",
    ],
    [
      "..oooo..",
      ".oooooo.",
      "ooooo.oo",
      "ooooo.oo",
      "*oooooo*",
      "...oo...",
      "..oooo..",
      "*.*.....",
    ],
    [
      "..oooo..",
      ".oooooo.",
      "ooooo.oo",
      "ooooo.oo",
      "*oooooo*",
      "...oo...",
      "..oooo..",
      "*.*.*...",
    ],
  ],
};

// Build CSS box-shadow string for one frame
function frameToShadow(frame, px, color, dimColor, accentColor) {
  const shadows = [];
  for (let y = 0; y < frame.length; y++) {
    const row = frame[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === ".") continue;
      const fill = c === "*" ? accentColor : c === "-" ? dimColor : color;
      const xPx = x * px;
      const yPx = y * px;
      shadows.push(`${xPx}px ${yPx}px 0 0 ${fill}`);
    }
  }
  return shadows.join(", ");
}

function DotChar({
  state = "idle",
  size = DOT_PX,
  color,
  dimColor,
  accentColor,
  fps = 4,
  style = {},
  className = "",
}) {
  const frames = GLYPHS[state] || GLYPHS.idle;
  const [frameIdx, setFrameIdx] = React.useState(0);

  React.useEffect(() => {
    setFrameIdx(0);
    if (frames.length <= 1) return;
    const id = setInterval(() => {
      setFrameIdx((i) => (i + 1) % frames.length);
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [state, fps, frames.length]);

  const c = color || "var(--fg-1)";
  const dim = dimColor || "var(--fg-4)";
  const accent = accentColor || "var(--accent)";

  const shadow = frameToShadow(frames[frameIdx], size, c, dim, accent);

  const totalSize = DOT_GRID * size;

  return (
    <span
      className={`dotchar ${className}`}
      style={{
        display: "inline-block",
        position: "relative",
        width: totalSize,
        height: totalSize,
        verticalAlign: "middle",
        ...style,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size,
          height: size,
          background: "transparent",
          boxShadow: shadow,
        }}
      />
    </span>
  );
}

// Tiny status dot — single pixel-art glyph, 5x5, used inline with text
const TINY = {
  idle:    [".ooo.", "o.o.o", "ooooo", "*ooo*", ".o.o."],
  active:  [".***.", "*ooo*", "ooooo", "*ooo*", ".*.*."],
  done:    [".ooo.", "o---o", "ooooo", "*o.o*", ".ooo."],
  error:   [".ooo.", "*o.o*", "ooooo", ".o.o.", "..*.."],
  sleep:   ["-z...", ".ooo.", "o---o", "*ooo*", "..o.."],
};

function DotTiny({ state = "idle", size = 2, style = {} }) {
  const g = TINY[state] || TINY.idle;
  const c = "var(--fg-1)";
  const dim = "var(--fg-4)";
  const accent = "var(--accent)";
  const shadow = frameToShadow(g, size, c, dim, accent);
  return (
    <span
      style={{
        display: "inline-block",
        position: "relative",
        width: 5 * size,
        height: 5 * size,
        verticalAlign: "middle",
        ...style,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size,
          height: size,
          boxShadow: shadow,
        }}
      />
    </span>
  );
}

Object.assign(window, { DotChar, DotTiny, GLYPHS });
