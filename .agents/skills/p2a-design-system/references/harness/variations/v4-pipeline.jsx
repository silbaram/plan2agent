/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark, TokenPill */

// =====================================================================
// Variation 4 — "Pipeline"
// Horizontal swim-lanes per agent. Each lane shows a timeline of tool
// calls and messages. Like Linear's roadmap or a CI dashboard.
// Vibe: Calm overview, multi-agent orchestration, status-glance
// =====================================================================

function VarPipeline() {
  const lanes = [
    { agent: MOCK.agents[0], events: [
      { kind: "msg", t: 0, label: "한민: checkout 401 fix" },
      { kind: "tool", t: 8, label: "read session.ts", state: "done" },
      { kind: "tool", t: 18, label: "grep refreshToken", state: "done" },
      { kind: "msg", t: 28, label: "원인 분석" },
      { kind: "diff", t: 42, label: "session.ts +8 −3", state: "done" },
      { kind: "tool", t: 60, label: "edit session.ts", state: "active" },
    ]},
    { agent: MOCK.agents[1], events: [
      { kind: "msg", t: 14, label: "test cases" },
      { kind: "tool", t: 22, label: "read session.test.ts", state: "done" },
      { kind: "subagent", t: 38, label: "test-generator", state: "active" },
      { kind: "tool", t: 70, label: "thinking…", state: "active" },
    ]},
    { agent: MOCK.agents[2], events: [
      { kind: "msg", t: 4, label: "stripe research" },
      { kind: "tool", t: 12, label: "web_search", state: "done" },
      { kind: "tool", t: 30, label: "fetch docs", state: "done" },
    ]},
    { agent: MOCK.agents[3], events: [
      { kind: "msg", t: 50, label: "review oauth/" },
      { kind: "tool", t: 58, label: "read 3 files", state: "done" },
      { kind: "msg", t: 72, label: "approved", state: "done" },
    ]},
    { agent: MOCK.agents[4], events: [
      { kind: "msg", t: 0, label: "rename DB cols" },
      { kind: "pause", t: 24, label: "waiting for approval" },
    ]},
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-1)", color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px", display: "flex", alignItems: "center", gap: 18, borderBottom: "1px solid var(--border-1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "var(--t-h2)", fontWeight: 700 }}>pipeline</span>
          <span className="t-mono-s">checkout-v2</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span style={{ color: "var(--fg-3)" }}>last 5min</span>
          <Icon name="chevron-down" size={11} />
        </div>
        <button style={{ padding: "5px 10px", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: "var(--r-1)", fontSize: 12 }}>+ launch agent</button>
      </div>

      {/* Time ruler */}
      <div style={{ display: "flex", paddingLeft: 220, paddingRight: 24, height: 28, alignItems: "center", borderBottom: "1px solid var(--border-1)", background: "var(--bg-2)" }}>
        {["-5m", "-4m", "-3m", "-2m", "-1m", "now"].map((t, i) => (
          <div key={i} style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)", display: "flex", justifyContent: "flex-start" }}>
            {t}
          </div>
        ))}
      </div>

      {/* Lanes */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {lanes.map(({ agent, events }, li) => (
          <div key={agent.id} style={{ display: "flex", borderBottom: "1px solid var(--border-1)", minHeight: 80 }}>
            {/* Lane label */}
            <div style={{ width: 220, flexShrink: 0, padding: "14px 16px", borderRight: "1px solid var(--border-1)", display: "flex", alignItems: "center", gap: 10, background: "var(--bg-2)" }}>
              <DotChar state={agent.state} size={2} />
              <ProviderMark provider={agent.provider} size={12} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t-body)", fontWeight: 500 }}>{agent.name}</div>
                <div className="t-mono-s">{agent.model}</div>
              </div>
            </div>
            {/* Lane track */}
            <div style={{ flex: 1, position: "relative", padding: "14px 24px 14px 0" }}>
              {/* baseline */}
              <div style={{ position: "absolute", left: 0, right: 24, top: "50%", height: 1, background: "var(--border-1)" }} />
              {events.map((e, ei) => (
                <PipeEvent key={ei} event={e} />
              ))}
              {/* now indicator */}
              <div style={{ position: "absolute", right: 24, top: 0, bottom: 0, width: 1, background: "var(--accent)", opacity: 0.4 }} />
            </div>
          </div>
        ))}
      </div>

      {/* Bottom panel — selected event detail */}
      <div style={{ height: 130, borderTop: "1px solid var(--border-1)", background: "var(--bg-2)", padding: "14px 24px", display: "flex", gap: 24 }}>
        <div style={{ flex: 1 }}>
          <div className="t-micro" style={{ marginBottom: 6 }}>selected · claude code</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <DotTiny state="active" size={2} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)" }}>edit_file</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-1)" }}>"src/lib/checkout/session.ts"</span>
          </div>
          <div className="t-small">applying patch · 8 lines added · 3 removed · started 12s ago</div>
        </div>
        <div style={{ width: 1, background: "var(--border-1)" }} />
        <div style={{ width: 200 }}>
          <div className="t-micro" style={{ marginBottom: 6 }}>session totals</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span style={{ color: "var(--fg-3)" }}>tokens</span><span>27.9k</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span style={{ color: "var(--fg-3)" }}>cost</span><span>$0.42</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <span style={{ color: "var(--fg-3)" }}>files</span><span style={{ color: "var(--accent)" }}>3 modified</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PipeEvent({ event }) {
  const left = `${(event.t / 80) * 100}%`;
  const isActive = event.state === "active";
  const isPause = event.kind === "pause";
  const color = isPause ? "var(--fg-4)" : isActive ? "var(--accent)" : event.state === "done" ? "var(--fg-2)" : "var(--fg-2)";

  if (event.kind === "diff") {
    return (
      <div style={{ position: "absolute", left, top: 16, transform: "translateY(0)", display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", border: `1px solid var(--border-2)`, background: "var(--bg-3)", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-1)" }}>
        <Icon name="diff" size={10} />{event.label}
      </div>
    );
  }
  if (event.kind === "msg") {
    return (
      <div style={{ position: "absolute", left, top: 8, fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--fg-2)", whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>
        ◆ {event.label}
      </div>
    );
  }
  // tool / subagent / pause: pip on the line
  return (
    <div style={{ position: "absolute", left, top: "50%", transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span style={{
        width: isActive ? 10 : 6,
        height: isActive ? 10 : 6,
        background: color,
        borderRadius: 1,
        boxShadow: isActive ? "0 0 0 3px rgb(255 91 46 / 0.2)" : "none",
      }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color, whiteSpace: "nowrap", marginTop: 2 }}>{event.label}</span>
    </div>
  );
}

window.VarPipeline = VarPipeline;
