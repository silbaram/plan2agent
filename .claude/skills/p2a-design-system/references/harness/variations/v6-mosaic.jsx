/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark */

// =====================================================================
// Variation 6 — "Mosaic"
// Quad-pane grid with 4 agents running simultaneously. Watch them all
// at once. Like tmux/zellij split panes but each cell is a real agent UI.
// Vibe: Pro tool, multi-agent power user, dense
// =====================================================================

function VarMosaic() {
  const cells = MOCK.agents.slice(0, 4);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-0)", color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "10px 16px", gap: 14, borderBottom: "1px solid var(--border-1)", background: "var(--bg-1)" }}>
        <span style={{ fontSize: "var(--t-h3)", fontWeight: 700 }}>mosaic</span>
        <span className="t-mono-s">checkout-v2 · 4 agents · split 2×2</span>
        <span style={{ flex: 1 }} />
        <button style={{ padding: "4px 9px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--fg-2)" }}>1×1</button>
        <button style={{ padding: "4px 9px", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: "var(--r-1)", fontSize: 11 }}>2×2</button>
        <button style={{ padding: "4px 9px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--fg-2)" }}>3×2</button>
        <span style={{ width: 1, height: 18, background: "var(--border-2)", margin: "0 4px" }} />
        <button style={{ padding: "4px 9px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontSize: 11, color: "var(--fg-2)" }}>broadcast ⌘B</button>
      </div>

      {/* 2×2 grid */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 1, background: "var(--border-1)" }}>
        {cells.map((a, i) => <MosaicCell key={a.id} agent={a} variant={i} />)}
      </div>

      {/* Shared input bar */}
      <div style={{ padding: "10px 14px", background: "var(--bg-1)", borderTop: "1px solid var(--border-1)", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>broadcast ›</span>
        <span style={{ flex: 1, color: "var(--fg-3)", fontSize: 12 }}>type to send to all 4 agents…</span>
        <span className="t-mono-s">⌘B to toggle target</span>
      </div>
    </div>
  );
}

function MosaicCell({ agent, variant }) {
  // Per-cell content varies by state
  const transcripts = {
    tool: [
      { who: "한민", body: "checkout 401 fix" },
      { tool: "read_file", arg: "session.ts", state: "done" },
      { tool: "grep", arg: "refreshToken", state: "done" },
      { who: "claude", body: "원인 찾음. patch 준비." },
      { tool: "edit_file", arg: "session.ts", state: "active" },
    ],
    thinking: [
      { who: "한민", body: "test cases for paymentIntent" },
      { tool: "read_file", arg: "session.test.ts", state: "done" },
      { who: "codex", body: "엣지 케이스 정리 중…" },
      { thinking: true },
    ],
    idle: [
      { who: "한민", body: "stripe webhook research" },
      { tool: "web_search", arg: "stripe idempotency", state: "done" },
      { tool: "fetch", arg: "stripe.com/docs", state: "done" },
      { who: "gemini", body: "요약 끝. 다음 지시 대기 중." },
    ],
    done: [
      { who: "한민", body: "review feature/oauth" },
      { tool: "read_file", arg: "oauth/handler.ts", state: "done" },
      { tool: "read_file", arg: "oauth/state.ts", state: "done" },
      { who: "reviewer", body: "approved · 1 nit on naming" },
    ],
  };
  const t = transcripts[agent.state] || transcripts.idle;

  return (
    <div style={{ background: "var(--bg-1)", display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      {/* Cell header */}
      <div style={{
        height: 36, flexShrink: 0,
        display: "flex", alignItems: "center", gap: 10, padding: "0 12px",
        borderBottom: "1px solid var(--border-1)",
        background: "var(--bg-2)",
        borderTop: variant === 0 ? `2px solid ${agent.providerColor}` : "2px solid transparent",
      }}>
        <DotChar state={agent.state} size={2} />
        <ProviderMark provider={agent.provider} size={12} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{agent.name}</span>
        <span className="t-mono-s">{agent.model}</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 10, fontFamily: "var(--font-mono)",
          color: agent.state === "tool" || agent.state === "thinking" ? "var(--accent)" : "var(--fg-3)",
        }}>
          {agent.state === "tool" ? "● working" : agent.state === "thinking" ? "● thinking" : agent.state === "done" ? "○ done" : "○ idle"}
        </span>
        <Icon name="maximize" size={11} style={{ color: "var(--fg-3)" }} />
      </div>

      {/* Cell body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.55 }}>
        {t.map((line, i) => {
          if (line.thinking) {
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-3)", marginTop: 4 }}>
                <DotTiny state="active" size={1.5} />
                <span>thinking</span>
                <span style={{ animation: "harness-blink 900ms steps(2) infinite" }}>…</span>
              </div>
            );
          }
          if (line.tool) {
            const isRunning = line.state === "active";
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-2)", marginBottom: 3 }}>
                {isRunning ? <DotTiny state="active" size={1.5} /> : <DotTiny state="done" size={1.5} />}
                <span style={{ color: isRunning ? "var(--accent)" : "var(--fg-3)" }}>{line.tool}</span>
                <span style={{ color: "var(--fg-1)" }}>"{line.arg}"</span>
                {isRunning && <span style={{ color: "var(--fg-3)", marginLeft: "auto" }}>…</span>}
              </div>
            );
          }
          return (
            <div key={i} style={{ marginBottom: 4, fontFamily: "var(--font-sans)", fontSize: 12 }}>
              <span style={{ color: line.who === "한민" ? "var(--fg-1)" : agent.providerColor, fontWeight: 600 }}>{line.who}</span>
              <span style={{ color: "var(--fg-2)" }}> {line.body}</span>
            </div>
          );
        })}
      </div>

      {/* Cell input */}
      <div style={{ padding: "6px 12px", borderTop: "1px solid var(--border-1)", display: "flex", alignItems: "center", gap: 8, background: "var(--bg-2)" }}>
        <span style={{ color: "var(--fg-3)", fontFamily: "var(--font-mono)", fontSize: 11 }}>›</span>
        <span style={{ color: "var(--fg-4)", fontFamily: "var(--font-mono)", fontSize: 11, flex: 1 }}>message {agent.name}…</span>
        <span className="t-mono-s">⌘{variant + 1}</span>
      </div>
    </div>
  );
}

window.VarMosaic = VarMosaic;
