/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark */

// =====================================================================
// Variation 5 — "Companion"
// Compact assistant panel — like Raycast/Arc command bar but persistent.
// One agent visible, big dot character. Inline diff inspector below.
// Vibe: Premium, calm, focus on a single conversation
// =====================================================================

function VarCompanion() {
  return (
    <div style={{ display: "flex", height: "100%", background: "var(--bg-1)", color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>
      {/* Left: agent picker rail */}
      <div style={{ width: 72, background: "var(--bg-0)", borderRight: "1px solid var(--border-1)", display: "flex", flexDirection: "column", alignItems: "center", padding: "16px 0", gap: 12 }}>
        {MOCK.agents.map((a, i) => (
          <div key={a.id} style={{
            width: 48, height: 48,
            border: `1px solid ${i === 0 ? a.providerColor : "transparent"}`,
            background: i === 0 ? "var(--bg-3)" : "transparent",
            borderRadius: "var(--r-1)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", position: "relative",
          }}>
            <DotChar state={a.state} size={2.5} />
            {i === 0 && <span style={{ position: "absolute", left: -1, top: 8, bottom: 8, width: 2, background: a.providerColor }} />}
          </div>
        ))}
        <div style={{ width: 48, height: 48, border: "1px dashed var(--border-2)", borderRadius: "var(--r-1)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)" }}>
          <Icon name="plus" size={14} />
        </div>
        <div style={{ flex: 1 }} />
        <Icon name="settings" size={14} style={{ color: "var(--fg-3)" }} />
      </div>

      {/* Center: hero + chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Hero */}
        <div style={{ padding: "32px 40px 24px", textAlign: "center", borderBottom: "1px solid var(--border-1)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <DotChar state="tool" size={8} />
          <div>
            <div style={{ fontSize: "var(--t-h1)", fontWeight: 700, letterSpacing: "-0.01em" }}>claude code</div>
            <div className="t-small" style={{ color: "var(--fg-2)", marginTop: 4 }}>
              <span style={{ color: "var(--accent)" }}>● working</span>
              <span style={{ color: "var(--fg-4)", margin: "0 8px" }}>·</span>
              editing src/lib/checkout/session.ts
              <span style={{ color: "var(--fg-4)", margin: "0 8px" }}>·</span>
              00:04:12
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <Pill>sonnet 4.5</Pill>
            <Pill>27.9k tok</Pill>
            <Pill>$0.42</Pill>
            <Pill accent>3 files modified</Pill>
          </div>
        </div>

        {/* Conversation */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 40px" }}>
          <div style={{ marginBottom: 18 }}>
            <div className="t-mono-s" style={{ marginBottom: 6 }}>16:42:08 · 한민</div>
            <div style={{ fontSize: "var(--t-body)", lineHeight: 1.6 }}>checkout 세션이 만료된 후에 재시도하면 가끔 401이 떨어져. 원인 찾고 src/lib/checkout/session.ts에서 고쳐줘.</div>
          </div>
          <div style={{ marginBottom: 18 }}>
            <div className="t-mono-s" style={{ marginBottom: 6, color: "var(--p-claude)" }}>16:42:11 · claude code</div>
            <div style={{ fontSize: "var(--t-body)", lineHeight: 1.6 }}>session.ts와 그 의존성을 먼저 읽어볼게요. <span style={{ color: "var(--accent)" }}>refreshToken()</span>이 새 객체를 리턴하는데 호출부에서 기존 ref를 잡고 있는 게 원인이네요.</div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <ToolPill name="read_file" arg="session.ts" done />
              <ToolPill name="grep" arg="refreshToken" done hits={4} />
              <ToolPill name="edit_file" arg="session.ts" running />
            </div>
          </div>
          {/* Diff card */}
          <div style={{ border: "1px solid var(--border-2)", borderRadius: "var(--r-2)", overflow: "hidden", marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border-1)", background: "var(--bg-2)" }}>
              <Icon name="diff" size={12} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>src/lib/checkout/session.ts</span>
              <span style={{ color: "var(--ok)", fontFamily: "var(--font-mono)", fontSize: 12 }}>+8</span>
              <span style={{ color: "var(--err)", fontFamily: "var(--font-mono)", fontSize: 12 }}>−3</span>
              <span style={{ flex: 1 }} />
              <button style={{ padding: "4px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--fg-2)" }}>view</button>
              <button style={{ padding: "4px 10px", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: "var(--r-1)", fontSize: 11 }}>apply</button>
            </div>
            <pre style={{ margin: 0, padding: "12px 14px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.6, color: "var(--fg-2)", background: "var(--bg-1)", overflow: "auto" }}>
{`@@ -42,9 +42,14 @@ export async function refreshSession(prev: Session) {`}
              <div style={{ color: "var(--err)" }}>{`-   const session = await refreshToken(prev);`}</div>
              <div style={{ color: "var(--err)" }}>{`-   prev.token = session.token;`}</div>
              <div style={{ color: "var(--err)" }}>{`-   return prev;`}</div>
              <div style={{ color: "var(--ok)" }}>{`+   const next = await refreshToken(prev);`}</div>
              <div style={{ color: "var(--ok)" }}>{`+   return {`}</div>
              <div style={{ color: "var(--ok)" }}>{`+     ...prev, ...next,`}</div>
              <div style={{ color: "var(--ok)" }}>{`+     refreshedAt: Date.now(),`}</div>
              <div style={{ color: "var(--ok)" }}>{`+   };`}</div>
            </pre>
          </div>
        </div>

        {/* Composer */}
        <div style={{ borderTop: "1px solid var(--border-1)", padding: "14px 40px 18px", background: "var(--bg-2)" }}>
          <div style={{ display: "flex", gap: 10, padding: "12px 14px", background: "var(--bg-1)", border: "1px solid var(--border-2)", borderRadius: "var(--r-2)", alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 14 }}>›</span>
            <div style={{ flex: 1, fontSize: "var(--t-body)" }}>
              <span>also write a regression test</span>
              <span style={{ display: "inline-block", width: 7, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "harness-blink 900ms steps(2) infinite" }} />
            </div>
            <span className="t-mono-s">⌘↵</span>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10, color: "var(--fg-3)", fontSize: 11, alignItems: "center" }}>
            <span>@agent</span><span style={{ color: "var(--fg-4)" }}>·</span>
            <span>#file</span><span style={{ color: "var(--fg-4)" }}>·</span>
            <span>/skill</span>
            <span style={{ flex: 1 }} />
            <span>switch agent ⌘\</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Pill({ children, accent }) {
  return (
    <span style={{
      padding: "3px 10px",
      fontSize: 11,
      fontFamily: "var(--font-mono)",
      color: accent ? "var(--accent)" : "var(--fg-2)",
      border: `1px solid ${accent ? "var(--accent)" : "var(--border-2)"}`,
      borderRadius: "var(--r-pill)",
    }}>{children}</span>
  );
}

function ToolPill({ name, arg, done, running, hits }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px", border: "1px solid var(--border-2)", background: "var(--bg-2)", borderRadius: "var(--r-pill)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {running ? <DotTiny state="active" size={1.5} /> : <DotTiny state="done" size={1.5} />}
      <span style={{ color: running ? "var(--accent)" : "var(--fg-2)" }}>{name}</span>
      <span style={{ color: "var(--fg-4)" }}>·</span>
      <span style={{ color: "var(--fg-1)" }}>{arg}</span>
      {hits != null && <span style={{ color: "var(--fg-3)" }}>· {hits}</span>}
    </span>
  );
}

window.VarCompanion = VarCompanion;
