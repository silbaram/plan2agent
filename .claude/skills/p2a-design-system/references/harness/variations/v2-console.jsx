/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark, TokenPill */

// =====================================================================
// Variation 2 — "Console"
// Single-pane terminal-forward view. Sidebar collapsed to thin rail.
// Big monospaced transcript dominates; metadata sits in floating chips.
// Vibe: Hacker, fast, keyboard-first
// =====================================================================

function VarConsole() {
  const ag = MOCK.agents[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-1)", color: "var(--fg-1)", fontFamily: "var(--font-mono)" }}>
      {/* Title strip */}
      <div style={{ display: "flex", alignItems: "center", height: 30, padding: "0 16px", background: "var(--bg-0)", borderBottom: "1px solid var(--border-1)", gap: 14, fontFamily: "var(--font-mono)", fontSize: "var(--t-mono-s)" }}>
        <span style={{ color: "var(--accent)" }}>harness</span>
        <span style={{ color: "var(--fg-4)" }}>›</span>
        <span style={{ color: "var(--fg-2)" }}>checkout-v2</span>
        <span style={{ color: "var(--fg-4)" }}>›</span>
        <span style={{ color: "var(--fg-1)" }}>checkout 401 fix</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-3)" }}>{ag.duration}</span>
        <span style={{ color: "var(--fg-4)" }}>·</span>
        <span style={{ color: "var(--fg-3)" }}>27.9k tok</span>
        <span style={{ color: "var(--fg-4)" }}>·</span>
        <span style={{ color: "var(--fg-3)" }}>$0.42</span>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Thin rail with dot characters per session */}
        <div style={{ width: 56, background: "var(--bg-0)", borderRight: "1px solid var(--border-1)", display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0", gap: 10 }}>
          {MOCK.sessions.slice(0, 6).map((s, i) => {
            const provColor = { claude: "var(--p-claude)", codex: "var(--p-codex)", gemini: "var(--p-gemini)", aider: "var(--p-aider)" }[s.agent];
            return (
              <div key={s.id} title={s.title} style={{
                width: 36, height: 36,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: `1px solid ${i === 0 ? provColor : "transparent"}`,
                background: i === 0 ? "var(--bg-3)" : "transparent",
                position: "relative",
              }}>
                <DotChar state={s.state === "tool" ? "tool" : s.state === "thinking" ? "thinking" : s.state} size={2} />
                {s.unread > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 4, height: 4, background: "var(--accent)" }} />}
              </div>
            );
          })}
          <div style={{ flex: 1 }} />
          <div style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--border-2)", color: "var(--fg-3)" }}>
            <Icon name="plus" size={14} />
          </div>
        </div>

        {/* Main terminal */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          {/* Floating agent chip */}
          <div style={{ position: "absolute", top: 14, right: 18, zIndex: 2, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--r-2)", boxShadow: "var(--shadow-2)" }}>
            <DotChar state={ag.state} size={3} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--t-small)", fontWeight: 700, color: "var(--fg-1)" }}>{ag.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)" }}>{ag.state} · {ag.model}</span>
            </div>
          </div>

          {/* Terminal body */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono)", lineHeight: 1.6 }}>
            <ConsoleLine prefix="❯" prefixColor="var(--accent)" sender="한민" senderColor="var(--fg-1)" ts="16:42:08">
              checkout 세션이 만료된 후에 재시도하면 가끔 401이 떨어져. 원인 찾고 src/lib/checkout/session.ts에서 고쳐줘.
            </ConsoleLine>
            <ConsoleLine prefix="◆" prefixColor="var(--p-claude)" sender="claude" senderColor="var(--p-claude)" ts="16:42:11">
              session.ts와 그 의존성을 먼저 읽어볼게요.
            </ConsoleLine>
            <ConsoleTool tool="read_file" arg="src/lib/checkout/session.ts" status="done" duration="0.3s" />
            <ConsoleTool tool="grep" arg="refreshToken" status="done" duration="0.1s" hits={4} />
            <ConsoleLine prefix="◆" prefixColor="var(--p-claude)" sender="claude" senderColor="var(--p-claude)" ts="16:42:18">
              원인을 찾았어요. <span style={{ color: "var(--accent)" }}>refreshToken()</span> 호출 시 세션 객체를 mutate 하지 않고 새 객체를 리턴하는데, 호출부에서 기존 세션 ref를 그대로 들고 있네요.
            </ConsoleLine>
            <ConsoleDiff file="src/lib/checkout/session.ts" added={8} removed={3} />
            <ConsoleTool tool="edit_file" arg="src/lib/checkout/session.ts" status="running" />
            <ConsoleLine prefix="❯" prefixColor="var(--accent)" sender="한민" senderColor="var(--fg-1)" ts="now">
              <span style={{ color: "var(--fg-1)" }}>also write a regression test</span>
              <span style={{ display: "inline-block", width: 7, height: 13, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "harness-blink 900ms steps(2) infinite" }} />
            </ConsoleLine>
          </div>

          {/* Command palette hint */}
          <div style={{ borderTop: "1px solid var(--border-1)", padding: "10px 18px", display: "flex", alignItems: "center", gap: 14, background: "var(--bg-2)", fontFamily: "var(--font-mono)", fontSize: "var(--t-mono-s)" }}>
            <span style={{ color: "var(--fg-3)" }}>⌘K palette</span>
            <span style={{ color: "var(--fg-4)" }}>·</span>
            <span style={{ color: "var(--fg-3)" }}>/skill</span>
            <span style={{ color: "var(--fg-4)" }}>·</span>
            <span style={{ color: "var(--fg-3)" }}>@agent</span>
            <span style={{ color: "var(--fg-4)" }}>·</span>
            <span style={{ color: "var(--fg-3)" }}>#file</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--fg-3)" }}>diff/apply</span>
            <span style={{ color: "var(--fg-1)", padding: "2px 6px", border: "1px solid var(--border-2)", borderRadius: 3 }}>D</span>
            <span style={{ color: "var(--fg-3)" }}>switch agent</span>
            <span style={{ color: "var(--fg-1)", padding: "2px 6px", border: "1px solid var(--border-2)", borderRadius: 3 }}>⌘\</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsoleLine({ prefix, prefixColor, sender, senderColor, ts, children }) {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
      <span style={{ color: prefixColor, width: 12, flexShrink: 0 }}>{prefix}</span>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 2 }}>
          <span style={{ color: senderColor, fontWeight: 600 }}>{sender}</span>
          <span style={{ color: "var(--fg-4)", fontSize: 10 }}>{ts}</span>
        </div>
        <div style={{ color: "var(--fg-1)", fontFamily: "var(--font-sans)", fontSize: "var(--t-body)", lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

function ConsoleTool({ tool, arg, status, duration, hits }) {
  const isRunning = status === "running";
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 4, marginLeft: 24 }}>
      <span style={{ color: "var(--fg-4)", width: 12, flexShrink: 0 }}>{isRunning ? "·" : "└"}</span>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, color: "var(--fg-2)" }}>
        {isRunning ? <DotTiny state="active" size={1.5} /> : <DotTiny state="done" size={1.5} />}
        <span style={{ color: "var(--accent)" }}>{tool}</span>
        <span style={{ color: "var(--fg-4)" }}>(</span>
        <span style={{ color: "var(--fg-1)" }}>"{arg}"</span>
        <span style={{ color: "var(--fg-4)" }}>)</span>
        <span style={{ flex: 1 }} />
        {hits != null && <span style={{ color: "var(--fg-3)" }}>{hits} matches</span>}
        <span style={{ color: isRunning ? "var(--accent)" : "var(--fg-3)" }}>{isRunning ? "running…" : duration}</span>
      </div>
    </div>
  );
}

function ConsoleDiff({ file, added, removed }) {
  return (
    <div style={{ marginLeft: 24, marginBottom: 10, padding: "10px 14px", border: "1px solid var(--border-2)", background: "var(--bg-2)", borderRadius: "var(--r-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Icon name="diff" size={12} />
        <span style={{ color: "var(--fg-1)" }}>{file}</span>
        <span style={{ color: "var(--ok)" }}>+{added}</span>
        <span style={{ color: "var(--err)" }}>−{removed}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-3)" }}>preview · D to apply</span>
      </div>
      <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, color: "var(--fg-2)" }}>
{`-   const session = await refreshToken(prev);
-   prev.token = session.token;
-   return prev;
+   const next = await refreshToken(prev);
+   return { ...prev, ...next, refreshedAt: Date.now() };`}
      </pre>
    </div>
  );
}

window.VarConsole = VarConsole;
