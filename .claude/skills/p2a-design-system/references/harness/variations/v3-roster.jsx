/* global React, MOCK, DotChar, DotTiny, Icon, ProviderMark, TokenPill */

// =====================================================================
// Variation 3 — "Roster"
// Grid view of all agents as character cards. Like a Pokémon team / roster.
// Click a card → expands to a full chat below. Best for managing many agents.
// Vibe: Playful but pro, agent-as-character metaphor centered
// =====================================================================

function VarRoster() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-1)", color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <div style={{ padding: "20px 28px 14px", borderBottom: "1px solid var(--border-1)", display: "flex", alignItems: "flex-end", gap: 18 }}>
        <div>
          <div className="t-micro" style={{ marginBottom: 4 }}>active project</div>
          <div style={{ fontSize: "var(--t-h1)", fontWeight: 700, lineHeight: 1 }}>checkout-v2</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <Stat label="agents" v={MOCK.agents.length} />
          <Stat label="active" v="3" accent />
          <Stat label="cost · today" v="$1.24" />
          <button style={{ padding: "8px 14px", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: "var(--r-1)", fontSize: "var(--t-small)", fontWeight: 600 }}>+ new agent</button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Roster grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
          <div className="t-micro" style={{ marginBottom: 12 }}>roster · 5</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            {MOCK.agents.map((a, i) => (
              <RosterCard key={a.id} agent={a} selected={i === 0} />
            ))}
            <div style={{
              border: "1px dashed var(--border-2)",
              borderRadius: "var(--r-2)",
              padding: 24,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 10, color: "var(--fg-3)",
              minHeight: 178,
            }}>
              <Icon name="plus" size={20} />
              <span className="t-small">add agent</span>
            </div>
          </div>

          <div className="t-micro" style={{ marginTop: 28, marginBottom: 12 }}>skills in use · 3</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {MOCK.skills.filter(s => s.state === "active").map(s => (
              <div key={s.id} style={{ padding: 12, border: "1px solid var(--border-1)", background: "var(--bg-2)", borderRadius: "var(--r-2)", display: "flex", alignItems: "center", gap: 10 }}>
                <DotTiny state="active" size={2} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "var(--t-body)", fontWeight: 500 }}>{s.name}</div>
                  <div className="t-small">{s.agent}</div>
                </div>
                <Icon name="sparkle" size={12} style={{ color: "var(--accent)" }} />
              </div>
            ))}
          </div>
        </div>

        {/* Selected agent live transcript */}
        <div style={{ width: 480, borderLeft: "1px solid var(--border-1)", background: "var(--bg-2)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border-1)", display: "flex", alignItems: "center", gap: 12 }}>
            <DotChar state="tool" size={3} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "var(--t-h3)", fontWeight: 700 }}>claude code</div>
              <div className="t-small">working · 00:04:12</div>
            </div>
            <button style={{ padding: "5px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", fontSize: "var(--t-small)" }}>pause</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", fontSize: "var(--t-small)", lineHeight: 1.6 }}>
            <div style={{ marginBottom: 12, color: "var(--fg-2)" }}>
              <span style={{ color: "var(--fg-3)" }}>16:42:08 한민 · </span>
              checkout 세션이 만료된 후에 재시도하면 가끔 401이 떨어져.
            </div>
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "var(--bg-3)", borderLeft: "2px solid var(--p-claude)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <DotTiny state="done" size={1.5} style={{ marginRight: 6 }} />
              read_file("session.ts") · 0.3s
            </div>
            <div style={{ marginBottom: 8, padding: "6px 8px", background: "var(--bg-3)", borderLeft: "2px solid var(--p-claude)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <DotTiny state="done" size={1.5} style={{ marginRight: 6 }} />
              grep("refreshToken") · 4 hits
            </div>
            <div style={{ marginBottom: 12, color: "var(--fg-1)" }}>
              <span style={{ color: "var(--p-claude)" }}>● claude · </span>
              원인을 찾았어요. <span style={{ color: "var(--accent)" }}>refreshToken()</span>이 새 객체를 리턴하는데 호출부에서 기존 ref를 잡고 있네요.
            </div>
            <div style={{ marginBottom: 8, padding: "8px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)", display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <Icon name="diff" size={11} />
              <span>session.ts</span>
              <span style={{ color: "var(--ok)" }}>+8</span>
              <span style={{ color: "var(--err)" }}>−3</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--accent)" }}>apply</span>
            </div>
            <div style={{ padding: "6px 8px", background: "var(--bg-3)", borderLeft: "2px solid var(--p-claude)", fontFamily: "var(--font-mono)", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <DotTiny state="active" size={1.5} />
              edit_file("session.ts") · running…
            </div>
          </div>
          <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border-1)", background: "var(--bg-1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid var(--border-2)", borderRadius: "var(--r-1)" }}>
              <span style={{ color: "var(--fg-3)", fontSize: 12 }}>›</span>
              <span style={{ color: "var(--fg-3)", flex: 1, fontSize: 12 }}>also write a regression test</span>
              <span className="t-mono-s">⌘↵</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RosterCard({ agent, selected }) {
  return (
    <div style={{
      padding: 16,
      border: `1px solid ${selected ? agent.providerColor : "var(--border-1)"}`,
      borderTop: `2px solid ${agent.providerColor}`,
      background: selected ? "var(--bg-3)" : "var(--bg-2)",
      borderRadius: "var(--r-2)",
      display: "flex", flexDirection: "column", gap: 10,
      cursor: "pointer",
      position: "relative",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{
          width: 56, height: 56,
          background: "var(--bg-1)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-1)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <DotChar state={agent.state} size={3} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <ProviderMark provider={agent.provider} size={11} />
            <span style={{ fontSize: "var(--t-h3)", fontWeight: 700 }}>{agent.name}</span>
          </div>
          <div className="t-mono-s">{agent.model}</div>
          <div style={{ display: "inline-block", marginTop: 6, padding: "2px 7px", fontSize: 10, fontFamily: "var(--font-mono)", color: agent.state === "tool" || agent.state === "thinking" ? "var(--accent)" : "var(--fg-3)", border: `1px solid ${agent.state === "tool" || agent.state === "thinking" ? "var(--accent)" : "var(--border-2)"}`, borderRadius: 999 }}>
            {agent.state === "tool" ? "● working" : agent.state === "thinking" ? "● thinking" : agent.state === "done" ? "○ done" : agent.state === "sleep" ? "○ paused" : "○ idle"}
          </div>
        </div>
      </div>
      <div className="t-small" style={{ color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {agent.task}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid var(--border-1)" }}>
        <TokenPill inn={agent.tokens.in} out={agent.tokens.out} />
        <span className="t-mono-s">{agent.duration}</span>
      </div>
    </div>
  );
}

function Stat({ label, v, accent }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span className="t-micro">{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", color: accent ? "var(--accent)" : "var(--fg-1)" }}>{v}</span>
    </div>
  );
}

window.VarRoster = VarRoster;
